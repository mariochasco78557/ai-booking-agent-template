"""El pipeline se construye con las APIs reales de Pipecat 1.12.0, sin red."""

from __future__ import annotations

import pytest

from voice_agent.config import load_settings
from voice_agent.llm import CONNECTED_MARK, count_cache_breakpoints, shape_request
from voice_agent.prompts import system_blocks
from voice_agent.state import CallState, Phase


def test_shape_request_puts_cache_on_system_and_guidance_last():
    original_last = {"role": "user", "content": [{"type": "text", "text": "el jueves", "cache_control": {"type": "ephemeral"}}]}
    params = {
        "system": "ignorado",
        "messages": [
            {"role": "assistant", "content": "Hola, ¿qué necesitas?"},
            original_last,
        ],
        "tools": [],
    }
    shaped = shape_request(params, ["NUCLEO", "PASO"], "<guia>x</guia>")
    assert [b["text"] for b in shaped["system"]] == ["NUCLEO", "PASO"]
    assert all(b["cache_control"] == {"type": "ephemeral"} for b in shaped["system"])
    assert shaped["messages"][0] == {"role": "user", "content": [{"type": "text", "text": CONNECTED_MARK}]}
    last = shaped["messages"][-1]["content"]
    assert last[-1] == {"type": "text", "text": "<guia>x</guia>"}
    assert "cache_control" not in last[-1]  # la guía nunca entra en la caché
    assert len(original_last["content"]) == 1  # el contexto no se toca
    assert count_cache_breakpoints(shaped) <= 4


def test_shape_request_after_assistant_message_appends_user_guidance():
    params = {"messages": [{"role": "user", "content": "hola"}, {"role": "assistant", "content": "x"}]}
    shaped = shape_request(params, ["N"], "<guia>g</guia>")
    assert shaped["messages"][-1] == {"role": "user", "content": [{"type": "text", "text": "<guia>g</guia>"}]}


@pytest.mark.parametrize("provider", ["azure", "elevenlabs", "cartesia", "deepgram"])
def test_services_build_offline_for_every_tts(real_env, provider):
    from voice_agent.pipeline import build_stt, build_tts

    real_env.update(TTS_PROVIDER=provider, ELEVENLABS_API_KEY="x", ELEVENLABS_VOICE_ID="v",
                    CARTESIA_API_KEY="x", CARTESIA_VOICE_ID="v")
    settings = load_settings(real_env)
    assert build_stt(settings) is not None
    assert build_tts(settings) is not None


async def test_llm_service_builds_request_with_steps(real_env):
    from pipecat.processors.aggregators.llm_context import LLMContext

    from voice_agent.pipeline import build_llm, tools_schema

    settings = load_settings(real_env)
    state = CallState(conversation_id="tw_CAtest00000001")

    async def on_failure(kind):
        pass

    llm = build_llm(settings, state, on_failure)
    context = LLMContext(
        messages=[
            {"role": "assistant", "content": settings.greeting_text},
            {"role": "user", "content": "Corte de pelo el jueves por la tarde"},
        ],
        tools=tools_schema(),
    )
    params = llm._get_llm_invocation_params(context)
    assert len(params["system"]) == 2
    assert params["system"][0]["text"] == system_blocks("nodos", Phase.INICIO)[0]
    assert "# PASO ACTUAL: INICIO" in params["system"][1]["text"]
    assert {t["name"] for t in params["tools"]} == {"disponibilidad", "reserva", "end_call"}
    last_block = params["messages"][-1]["content"][-1]["text"]
    assert last_block.startswith("<guia>") and "Paso: INICIO" in last_block
    assert count_cache_breakpoints(params) <= 4
    # el contexto de Pipecat no guarda la guía
    assert all("<guia>" not in str(m) for m in context.get_messages())


def test_full_strategy_single_block(real_env):
    from pipecat.processors.aggregators.llm_context import LLMContext

    from voice_agent.pipeline import build_llm, tools_schema

    real_env["PROMPT_STRATEGY"] = "completo"
    settings = load_settings(real_env)

    async def on_failure(kind):
        pass

    llm = build_llm(settings, CallState(conversation_id="tw_CAtest00000002"), on_failure)
    context = LLMContext(messages=[{"role": "user", "content": "hola"}], tools=tools_schema())
    params = llm._get_llm_invocation_params(context)
    assert len(params["system"]) == 1


def test_tools_schema_converts_for_anthropic():
    from pipecat.adapters.services.anthropic_adapter import AnthropicLLMAdapter

    from voice_agent.pipeline import tools_schema

    tools = AnthropicLLMAdapter().to_provider_tools_format(tools_schema())
    by_name = {t["name"]: t for t in tools}
    assert set(by_name["reserva"]["input_schema"]["required"]) == {
        "customer_name", "customer_surnames", "phone", "confirmed_by_customer"
    }
    assert "slot_token" not in by_name["reserva"]["input_schema"]["properties"]


async def test_metrics_and_latency_taps_write_log(tmp_path):
    """Los medidores del pipeline registran TTFB y latencia por turno (con frames reales de Pipecat)."""
    import asyncio
    import json

    from pipecat.frames.frames import BotStartedSpeakingFrame, MetricsFrame, VADUserStoppedSpeakingFrame
    from pipecat.metrics.metrics import LLMTokenUsage, LLMUsageMetricsData, TTFBMetricsData
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.tests.utils import SleepFrame, run_test

    from voice_agent.calllog import CallLog
    from voice_agent.pipeline import LatencyTap, MetricsTap, TurnClock

    log = CallLog(str(tmp_path), "tw_CAtap0001")
    clock = TurnClock()

    class _MarkTurn(MetricsTap):
        async def process_frame(self, frame, direction):
            if isinstance(frame, VADUserStoppedSpeakingFrame):
                clock.turn_stop = asyncio.get_running_loop().time()
            await super().process_frame(frame, direction)

    pipeline = Pipeline([_MarkTurn(log, clock), LatencyTap(log, clock)])
    usage = LLMTokenUsage(prompt_tokens=300, completion_tokens=40, total_tokens=7340,
                          cache_read_input_tokens=7000, cache_creation_input_tokens=0)
    await run_test(
        pipeline,
        frames_to_send=[
            VADUserStoppedSpeakingFrame(stop_secs=0.2),
            MetricsFrame(data=[TTFBMetricsData(processor="AnthropicLLMService#0", value=0.42),
                               LLMUsageMetricsData(processor="AnthropicLLMService#0", value=usage)]),
            SleepFrame(sleep=0.05),
            BotStartedSpeakingFrame(),
        ],
    )
    records = [json.loads(line) for line in log.path.read_text(encoding="utf-8").splitlines()]
    kinds = {r["kind"]: r for r in records}
    assert kinds["ttfb"] == {**kinds["ttfb"], "service": "AnthropicLLMService", "ms": 420}
    assert kinds["llm_usage"]["cache_read_input_tokens"] == 7000
    assert kinds["turn_latency"]["ms_desde_fin_turno"] >= 40
    assert kinds["turn_latency"]["ms_desde_vad"] >= 40
