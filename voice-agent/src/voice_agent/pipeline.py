"""Pipeline de una llamada: Twilio ↔ VAD/turnos ↔ Deepgram ↔ Haiku ↔ TTS.

    transport.input → Deepgram → agregador del cliente (Silero + smart-turn v3)
      → Haiku (herramientas) → TTS → métricas → transport.output → agregador del agente

Las piezas que no dependen de Pipecat (estado, herramientas, prompts) están en sus
módulos y tienen tests propios. Aquí solo se conectan.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from anthropic import AsyncAnthropic
from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    EndFrame,
    EndWorkerFrame,
    Frame,
    FunctionCallResultProperties,
    LLMMessagesAppendFrame,
    MetricsFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import LLMUsageMetricsData, TTFBMetricsData
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.anthropic.llm import AnthropicLLMSettings
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transcriptions.language import Language
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.turns.user_mute import FunctionCallUserMuteStrategy
from pipecat.workers.runner import WorkerRunner

from voice_agent.calllog import CallLog
from voice_agent.config import Settings
from voice_agent.llm import DemoSalonAnthropicLLMService
from voice_agent.middleware_client import MiddlewareAPI
from voice_agent.prompts import guidance, system_blocks
from voice_agent.state import CallState
from voice_agent.tools import TOOL_END_CALL, TOOL_SCHEMAS, ToolExecutor
from voice_agent.turn_detection import PIPECAT_VAD_STOP_SECS, build_turn_setup, flux_decision_ms

TWILIO_SAMPLE_RATE = 8000

# Frases fijas que dice el código (no el modelo). Salen de la V6.
DEFAULT_GOODBYE = "Muchas gracias por llamar a Chimac Peluqueros. ¡Que tengas muy buen día!"
FAILURE_SENTENCE = (
    "Lo siento, ahora mismo no he podido resolverlo. Escríbenos por WhatsApp a este mismo "
    "número y la peluquería te responderá en cuanto pueda."
)
SILENCE_GOODBYE = (
    "Si quieres, piénsalo con calma y cuando lo tengas nos llamas o nos escribes por "
    "WhatsApp a este mismo número. ¡Que vaya bien!"
)
SILENCE_MARK = "[silencio]"


def tools_schema() -> ToolsSchema:
    functions = [
        FunctionSchema(
            name=t["name"],
            description=t["description"],
            properties=t["input_schema"]["properties"],
            required=list(t["input_schema"].get("required", [])),
        )
        for t in TOOL_SCHEMAS
    ]
    return ToolsSchema(standard_tools=functions)


def _language(code: str) -> Language | str:
    try:
        return Language(code)
    except ValueError:
        return code


def build_stt(settings: Settings):
    from pipecat.services.deepgram.stt import DeepgramSTTService, DeepgramSTTSettings

    return DeepgramSTTService(
        api_key=settings.deepgram_api_key,
        sample_rate=TWILIO_SAMPLE_RATE,
        settings=DeepgramSTTSettings(
            model=settings.deepgram_model,
            language=_language(settings.deepgram_language),
            keyterm=list(settings.deepgram_keyterms),
            interim_results=True,
            punctuate=True,
        ),
    )


def build_tts(settings: Settings):
    """TTS conmutable por TTS_PROVIDER. Importa solo el proveedor elegido."""
    provider = settings.tts_provider
    if provider == "azure":
        from pipecat.services.azure.tts import AzureTTSService

        return AzureTTSService(
            api_key=settings.azure_speech_key,
            region=settings.azure_speech_region,
            sample_rate=TWILIO_SAMPLE_RATE,
            settings=AzureTTSService.Settings(voice=settings.azure_tts_voice, language="es-ES"),
        )
    if provider == "elevenlabs":
        from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

        return ElevenLabsTTSService(
            api_key=settings.elevenlabs_api_key,
            sample_rate=TWILIO_SAMPLE_RATE,
            settings=ElevenLabsTTSService.Settings(
                voice=settings.elevenlabs_voice_id, model=settings.elevenlabs_model, language="es"
            ),
        )
    if provider == "cartesia":
        from pipecat.services.cartesia.tts import CartesiaTTSService

        return CartesiaTTSService(
            api_key=settings.cartesia_api_key,
            sample_rate=TWILIO_SAMPLE_RATE,
            settings=CartesiaTTSService.Settings(voice=settings.cartesia_voice_id, language="es"),
        )
    if provider == "deepgram":
        from pipecat.services.deepgram.tts import DeepgramTTSService

        return DeepgramTTSService(
            api_key=settings.deepgram_api_key,
            sample_rate=TWILIO_SAMPLE_RATE,
            settings=DeepgramTTSService.Settings(voice=settings.deepgram_tts_voice),
        )
    raise ValueError(f"TTS_PROVIDER desconocido: {provider}")


class TurnClock:
    """Marcas de tiempo del turno para medir la latencia de voz a voz."""

    def __init__(self):
        self.vad_stop: float | None = None
        self.turn_stop: float | None = None
        self.stt_decision_ms: float | None = None


class SttTurnTap(FrameProcessor):
    """Tras el STT: con Flux, apunta cuánto tardó Flux en cerrar el turno (marcas de las palabras)."""

    def __init__(self, clock: TurnClock):
        super().__init__()
        self._clock = clock

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and getattr(frame, "finalized", False):
            try:
                decision = flux_decision_ms(getattr(frame, "result", None))
            except Exception as exc:  # una medición nunca puede parar la conversación
                logger.warning(f"SttTurnTap: no se pudo calcular la decisión de Flux ({type(exc).__name__})")
                decision = None
            self._clock.stt_decision_ms = decision
        await self.push_frame(frame, direction)


class MetricsTap(FrameProcessor):
    """Copia tokens y TTFB de cada servicio al registro, y marca el fin de voz del cliente."""

    def __init__(self, log: CallLog, clock: TurnClock):
        super().__init__()
        self._log = log
        self._clock = clock

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            self._clock.vad_stop = asyncio.get_running_loop().time()
        elif isinstance(frame, MetricsFrame):
            for item in frame.data:
                if isinstance(item, LLMUsageMetricsData):
                    u = item.value
                    self._log.llm_usage(
                        u.prompt_tokens, u.completion_tokens,
                        u.cache_read_input_tokens, u.cache_creation_input_tokens,
                    )
                elif isinstance(item, TTFBMetricsData) and item.value:
                    self._log.write("ttfb", service=item.processor.split("#")[0], ms=round(item.value * 1000))
        await self.push_frame(frame, direction)


def latency_record(now: float, clock: TurnClock) -> dict[str, Any]:
    """Latencias del turno en ms. ``ms_desde_fin_voz`` es la comparable entre modos (estimada):

    - con VAD (smart_turn o vad): desde el fin de voz del VAD + los 0,2 s de silencio que espera;
    - con Flux: desde el fin de turno + lo que tardó Flux en decidir (audio_window_end − última palabra).
    No incluye el tránsito del audio por la red ni el búfer de Twilio: la referencia real es
    la grabación voz a voz en el teléfono ((internal doc, not included in the template) §3 bis).
    """
    turn = round((now - clock.turn_stop) * 1000) if clock.turn_stop is not None else None
    vad = round((now - clock.vad_stop) * 1000) if clock.vad_stop is not None else None
    record: dict[str, Any] = {"ms_desde_fin_turno": turn, "ms_desde_vad": vad}
    if clock.stt_decision_ms is not None and turn is not None:
        record["ms_decision_stt"] = round(clock.stt_decision_ms)
        record["ms_desde_fin_voz"] = round(turn + clock.stt_decision_ms)
        record["metodo_fin_voz"] = "flux"
    elif vad is not None:
        record["ms_desde_fin_voz"] = round(vad + PIPECAT_VAD_STOP_SECS * 1000)
        record["metodo_fin_voz"] = "vad"
    return record


class LatencyTap(FrameProcessor):
    """Tras transport.output: cuando el agente empieza a sonar, registra la latencia del turno."""

    def __init__(self, log: CallLog, clock: TurnClock):
        super().__init__()
        self._log = log
        self._clock = clock

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame) and direction == FrameDirection.DOWNSTREAM:
            now = asyncio.get_running_loop().time()
            if self._clock.turn_stop is not None:
                try:
                    self._log.write("turn_latency", **latency_record(now, self._clock))
                except Exception as exc:  # nunca bloquear el audio por una medición
                    logger.warning(f"LatencyTap: no se pudo registrar la latencia ({type(exc).__name__})")
            self._clock.turn_stop = None
            self._clock.vad_stop = None
            self._clock.stt_decision_ms = None
        await self.push_frame(frame, direction)


@dataclass
class CallServices:
    """Servicios externos de una llamada (inyectables en tests)."""

    stt: Any
    tts: Any


def user_aggregator_params(settings: Settings, turn) -> LLMUserAggregatorParams:
    """Parámetros del agregador del cliente según TURN_DETECTION (ver turn_detection.py)."""
    kwargs: dict[str, Any] = {
        "user_mute_strategies": [FunctionCallUserMuteStrategy()],  # G7
        "user_idle_timeout": settings.silence_prompt_s,
    }
    if turn is None:  # servicios inyectados (tests): VAD por defecto
        kwargs["vad_analyzer"] = SileroVADAnalyzer(params=VADParams(stop_secs=0.2))
        return LLMUserAggregatorParams(**kwargs)
    if turn.vad_analyzer is not None:
        kwargs["vad_analyzer"] = turn.vad_analyzer
    if turn.user_turn_strategies is not None:
        kwargs["user_turn_strategies"] = turn.user_turn_strategies
    return LLMUserAggregatorParams(**kwargs)


def build_llm(settings: Settings, state: CallState, on_failure) -> DemoSalonAnthropicLLMService:
    tz = ZoneInfo(settings.salon_timezone)
    client = AsyncAnthropic(
        api_key=settings.anthropic_api_key,
        timeout=settings.llm_timeout_s,
        max_retries=1,
    )
    return DemoSalonAnthropicLLMService(
        api_key=settings.anthropic_api_key,
        client=client,
        settings=AnthropicLLMSettings(
            model=settings.llm_model,
            max_tokens=settings.llm_max_tokens,
            temperature=settings.llm_temperature,
            enable_prompt_caching=True,
        ),
        system_provider=lambda: system_blocks(
            settings.prompt_strategy, state.phase, multi_booking=bool(state.bookings)
        ),
        guidance_provider=lambda: guidance(state, datetime.now(tz), settings.prompt_strategy),
        on_llm_failure=on_failure,
    )


async def run_call(
    websocket,
    *,
    call_sid: str,
    stream_sid: str,
    settings: Settings,
    middleware: MiddlewareAPI,
    services: CallServices | None = None,
) -> None:
    """Atiende UNA llamada hasta que termina. No lanza excepciones hacia fuera."""
    conversation_id = f"tw_{call_sid}"
    state = CallState(conversation_id=conversation_id)
    log = CallLog(settings.call_log_dir, conversation_id)
    turn = build_turn_setup(settings) if services is None else None
    stt_model = settings.deepgram_flux_model if settings.turn_detection == "deepgram_flux" else settings.deepgram_model
    log.write("start", prompt_strategy=settings.prompt_strategy, tts=settings.tts_provider,
              llm=settings.llm_model, stt=stt_model, turn_detection=settings.turn_detection)
    ending = {"done": False}
    clock = TurnClock()

    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=settings.twilio_account_sid,
        auth_token=settings.twilio_auth_token,
        region=settings.twilio_region or None,
        edge=settings.twilio_edge or None,
        params=TwilioFrameSerializer.InputParams(auto_hang_up=True),
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
            session_timeout=settings.max_call_s,
        ),
    )
    services = services or CallServices(stt=turn.stt, tts=build_tts(settings))

    llm: DemoSalonAnthropicLLMService
    worker: PipelineWorker

    async def finish(sentence: str | None, reason: str) -> None:
        """Dice una frase fija (si hay) y cuelga cuando termine de sonar."""
        if ending["done"]:
            return
        ending["done"] = True
        state.ended = True
        log.write("finish", reason=reason)
        if sentence:
            await llm.push_frame(TTSSpeakFrame(sentence))
        await llm.push_frame(EndWorkerFrame(reason=reason))

    async def on_end_call() -> None:
        await asyncio.sleep(0.05)  # deja pasar el texto ya generado en este turno
        # G8: si el modelo cuelga sin despedirse, se despide el código.
        await finish(None if llm.current_response_text.strip() else DEFAULT_GOODBYE, "end_call")

    async def on_llm_failure(kind: str) -> None:
        log.write("llm_failure", error=kind)
        await finish(FAILURE_SENTENCE, "llm_failure")

    executor = ToolExecutor(state, middleware, on_tool_event=log.tool, on_end_call=on_end_call)
    llm = build_llm(settings, state, on_llm_failure)

    async def handle_tool(params: FunctionCallParams) -> None:
        result = await executor.execute(params.function_name, dict(params.arguments or {}))
        properties = (
            FunctionCallResultProperties(run_llm=False) if params.function_name == TOOL_END_CALL else None
        )
        await params.result_callback(result, properties=properties)

    for tool in TOOL_SCHEMAS:
        # Tope de la herramienta algo mayor que el del cliente HTTP: el cliente siempre contesta antes.
        timeout = settings.middleware_book_timeout_s if tool["name"] == "reserva" else settings.middleware_availability_timeout_s
        llm.register_function(tool["name"], handle_tool, timeout_secs=timeout + 2)

    @llm.event_handler("on_completion_timeout")
    async def _on_timeout(_service):
        await on_llm_failure("timeout")

    context = LLMContext(messages=[], tools=tools_schema())
    aggregators = LLMContextAggregatorPair(context, user_params=user_aggregator_params(settings, turn))

    @aggregators.user().event_handler("on_user_turn_stopped")
    async def _on_user(_agg, _strategy, message):
        text = getattr(message, "content", None) or ""
        clock.turn_stop = asyncio.get_running_loop().time()
        personal = state.user_turn_is_personal()  # antes de actualizar el estado
        state.on_user_text(text)
        log.user(text, personal=personal)

    @aggregators.assistant().event_handler("on_assistant_turn_stopped")
    async def _on_bot(_agg, message):
        text = getattr(message, "content", None) or ""
        state.on_assistant_text(text)
        log.bot(text, interrupted=bool(getattr(message, "interrupted", False)))

    @aggregators.user().event_handler("on_user_turn_idle")
    async def _on_idle(_agg):
        if state.ended:
            return
        state.silence_prompts += 1
        log.write("silence", count=state.silence_prompts)
        if state.silence_prompts <= 2:
            await worker.queue_frame(
                LLMMessagesAppendFrame(messages=[{"role": "user", "content": SILENCE_MARK}], run_llm=True)
            )
        else:
            # Red de seguridad si el modelo no ha colgado tras dos avisos (V6, TOMA LA INICIATIVA).
            await finish(SILENCE_GOODBYE, "silence")

    pipeline = Pipeline(
        [
            transport.input(),
            services.stt,
            SttTurnTap(clock),
            aggregators.user(),
            llm,
            services.tts,
            MetricsTap(log, clock),
            transport.output(),
            LatencyTap(log, clock),
            aggregators.assistant(),
        ]
    )
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=TWILIO_SAMPLE_RATE,
            audio_out_sample_rate=TWILIO_SAMPLE_RATE,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        idle_timeout_secs=settings.silence_hangup_s,  # G9: silencio total
        cancel_on_idle_timeout=True,
        conversation_id=conversation_id,
    )

    @transport.event_handler("on_client_connected")
    async def _on_connected(_transport, _ws):
        # Saludo inmediato: tapa el arranque lento de los servicios (#5868).
        await worker.queue_frame(TTSSpeakFrame(settings.greeting_text))

    @transport.event_handler("on_client_disconnected")
    async def _on_disconnected(_transport, _ws):
        await worker.cancel(reason="client_disconnected")

    @transport.event_handler("on_session_timeout")
    async def _on_session_timeout(_transport, _ws):
        log.write("max_call_duration")
        await worker.queue_frame(EndFrame())

    runner = WorkerRunner(handle_sigint=False)
    reason = "completed"
    try:
        await runner.add_workers(worker)
        await runner.run()
    except Exception as exc:  # nunca tumbar el servidor por una llamada
        reason = f"error:{type(exc).__name__}"
        logger.exception("voice-agent: la llamada terminó con error")
    finally:
        await executor.wait_background()
        log.end(reason, phase=state.phase.value, bookings=len(state.bookings), ended_by_agent=state.ended)
