"""Retoques del bloque 3: sha256 antes de renombrar, env de despliegue, latencia con Flux, trozos de 80 ms."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from voice_agent.config import load_settings

ROOT = Path(__file__).resolve().parents[1]


# ── 1. bench_cpu --descargar verifica el .part antes de renombrarlo ────────

def _patch_variant(monkeypatch, sha: str):
    from voice_agent import bench_cpu

    spec = {"fichero": "modelo-prueba.onnx", "url": "https://example.invalid/m.onnx", "sha256": sha}
    monkeypatch.setitem(bench_cpu.VARIANTS, "fp32", spec)
    monkeypatch.setattr(bench_cpu, "download_file", lambda url, dest: dest.write_bytes(b"contenido descargado"))
    return bench_cpu


def test_download_with_wrong_sha_is_deleted_and_never_renamed(monkeypatch, tmp_path):
    bench_cpu = _patch_variant(monkeypatch, "0" * 64)
    with pytest.raises(SystemExit, match="sha256"):
        bench_cpu.resolve_model("fp32", None, True, tmp_path)
    assert list(tmp_path.iterdir()) == []  # ni .part ni fichero definitivo


def test_download_with_right_sha_is_renamed(monkeypatch, tmp_path):
    bench_cpu = _patch_variant(monkeypatch, hashlib.sha256(b"contenido descargado").hexdigest())
    path = bench_cpu.resolve_model("fp32", None, True, tmp_path)
    assert path == tmp_path / "modelo-prueba.onnx" and path.exists()
    assert not list(tmp_path.glob("*.part"))


# ── 2. deploy/env.voice.example documenta el fin de turno ─────────────────

TURN_VARS = {
    "TURN_DETECTION": "deepgram_flux",
    "DEEPGRAM_FLUX_MODEL": "flux-general-multi",
    "DEEPGRAM_FLUX_URL": "wss://api.eu.deepgram.com/v2/listen",
    "FLUX_EOT_THRESHOLD": "",
    "FLUX_EOT_TIMEOUT_MS": "",
    "FLUX_CHUNK_MS": "80",
    "VAD_STOP_SECS": "0.8",
    "SMART_TURN_MODEL": "",
    "SMART_TURN_THREADS": "1",
    "SMART_TURN_SHARED_SESSION": "true",
}


@pytest.mark.parametrize("path", ["deploy/env.voice.example", ".env.example"])
def test_env_examples_document_turn_detection(path):
    file = ROOT / path
    if not file.exists():
        pytest.skip(f"{path} no existe")
    lines = file.read_text(encoding="utf-8").splitlines()
    values = {}
    for i, line in enumerate(lines):
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = (value.strip(), i)
    for key, default in TURN_VARS.items():
        assert key in values, f"{path}: falta {key}"
        value, i = values[key]
        assert value == default, f"{path}: {key}={value} (por defecto {default})"
        assert lines[i - 1].lstrip().startswith("#"), f"{path}: {key} sin línea de explicación"
    # y los valores por defecto del ejemplo coinciden con los de config.py
    s = load_settings({k: v for k, (v, _) in values.items() if k in TURN_VARS})
    assert (s.turn_detection, s.vad_stop_secs, s.flux_chunk_ms) == ("deepgram_flux", 0.8, 80)


# ── 3. latencia comparable con Flux ────────────────────────────────────────

TURN_INFO = {
    "event": "EndOfTurn",
    "audio_window_start": 0.0,
    "audio_window_end": 2.45,
    "words": [{"word": "corte", "start": 1.2, "end": 1.5}, {"word": "pelo", "start": 1.6, "end": 2.05}],
    "end_of_turn_confidence": 0.82,
}


def test_flux_decision_from_turn_info():
    from voice_agent.turn_detection import flux_decision_ms

    assert flux_decision_ms(TURN_INFO) == pytest.approx(400)

    class Model:
        def model_dump(self):
            return TURN_INFO

    assert flux_decision_ms(Model()) == pytest.approx(400)
    assert flux_decision_ms({"audio_window_end": 1.0, "words": []}) is None
    assert flux_decision_ms(None) is None
    assert flux_decision_ms({"audio_window_end": 1.0, "words": [{"end": 2.0}]}) == 0.0


def test_latency_record_modes():
    from voice_agent.pipeline import TurnClock, latency_record

    clock = TurnClock()
    clock.turn_stop, clock.stt_decision_ms = 10.0, 400.0
    flux = latency_record(10.5, clock)
    assert flux == {"ms_desde_fin_turno": 500, "ms_desde_vad": None, "ms_decision_stt": 400,
                    "ms_desde_fin_voz": 900, "metodo_fin_voz": "flux"}
    clock = TurnClock()
    clock.turn_stop, clock.vad_stop = 10.1, 10.0
    vad = latency_record(10.6, clock)
    assert vad["ms_desde_vad"] == 600 and vad["ms_desde_fin_voz"] == 800 and vad["metodo_fin_voz"] == "vad"


async def test_taps_record_flux_latency(tmp_path):
    """Con frames reales de Pipecat: transcripción final de Flux → ... → el agente suena."""
    from pipecat.frames.frames import BotStartedSpeakingFrame, TranscriptionFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.tests.utils import SleepFrame, run_test

    from voice_agent.calllog import CallLog
    from voice_agent.pipeline import LatencyTap, SttTurnTap, TurnClock

    log = CallLog(str(tmp_path), "tw_CAflux0001")
    clock = TurnClock()

    class MarkTurn(SttTurnTap):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, TranscriptionFrame):
                import asyncio

                clock.turn_stop = asyncio.get_running_loop().time()

    await run_test(
        Pipeline([MarkTurn(clock), LatencyTap(log, clock)]),
        frames_to_send=[
            TranscriptionFrame("corte de pelo", "u", "t", None, result=TURN_INFO, finalized=True),
            SleepFrame(sleep=0.05),
            BotStartedSpeakingFrame(),
        ],
    )
    record = next(json.loads(l) for l in log.path.read_text().splitlines() if '"turn_latency"' in l)
    assert record["ms_decision_stt"] == 400 and record["metodo_fin_voz"] == "flux"
    assert record["ms_desde_fin_voz"] >= 440


def test_daily_report_flux_note_and_comparable_latency(tmp_path):
    from datetime import date

    from voice_agent.informe import load_day, render, summarize

    at = "2026-10-06T08:00:00+00:00"
    records = [
        {"t": 0, "at": at, "kind": "start", "tts": "azure", "llm": "claude-haiku-4-5", "stt": "flux-general-multi",
         "turn_detection": "deepgram_flux"},
        {"t": 5, "at": at, "kind": "turn_latency", "ms_desde_fin_turno": 500, "ms_desde_vad": None,
         "ms_decision_stt": 400, "ms_desde_fin_voz": 900, "metodo_fin_voz": "flux"},
        {"t": 60, "at": at, "kind": "end", "reason": "completed", "duration_s": 60},
    ]
    (tmp_path / "2026-10-06_tw_CA1.jsonl").write_text("\n".join(json.dumps(r) for r in records) + "\n")
    s = summarize(*load_day(tmp_path, date(2026, 10, 6)))
    assert s["latencia_fin_voz_ms"]["p50"] == 900 and s["decision_flux_ms"]["p50"] == 400
    assert s["modos_fin_turno"] == {"deepgram_flux": 1}
    text = render(date(2026, 10, 6), s)
    assert "Nota (deepgram_flux)" in text and "subestima" in text and "grabación voz a voz" in text
    assert s["coste_usd"]["stt"] == pytest.approx(0.0078)  # precio de Flux Multilingual


def test_no_flux_note_without_flux_calls(tmp_path):
    from datetime import date

    from voice_agent.informe import render, summarize

    assert "Nota (deepgram_flux)" not in render(date(2026, 10, 6), summarize([], []))


# ── 4. audio a Flux en trozos de 80 ms ─────────────────────────────────────

async def test_flux_audio_is_grouped_in_80ms_chunks(real_env):
    from voice_agent.turn_detection import build_turn_setup, chunk_bytes

    stt = build_turn_setup(load_settings(real_env)).stt
    sent: list[bytes] = []

    async def fake_send(audio, _report):
        sent.append(audio)

    stt._websocket = object()
    stt._sample_rate = 8000
    stt.send_with_retry = fake_send
    frame_20ms = b"\x01\x00" * 160  # 20 ms a 8 kHz, linear16
    for _ in range(10):
        async for _frame in stt.run_stt(frame_20ms):
            pass
    assert chunk_bytes(8000, 80) == 1280
    assert [len(x) for x in sent] == [1280, 1280]  # 8 × 20 ms enviados en 2 trozos de 80 ms
    assert len(stt._pending) == 640  # los 40 ms restantes esperan al siguiente trozo
    assert stt._last_audio_chunk_duration == pytest.approx(0.08)


async def test_flux_chunk_20ms_keeps_pipecat_behaviour(real_env):
    from voice_agent.turn_detection import build_turn_setup

    real_env["FLUX_CHUNK_MS"] = "20"
    stt = build_turn_setup(load_settings(real_env)).stt
    sent: list[bytes] = []

    async def fake_send(audio, _report):
        sent.append(audio)

    stt._websocket, stt._sample_rate, stt.send_with_retry = object(), 8000, fake_send
    async for _frame in stt.run_stt(b"\x00\x00" * 160):
        pass
    assert [len(x) for x in sent] == [320]


def test_flux_chunk_ms_validated():
    from voice_agent.config import ConfigError

    with pytest.raises(ConfigError, match="FLUX_CHUNK_MS"):
        load_settings({"FLUX_CHUNK_MS": "500"})
    assert re.match(r"^\d+$", str(load_settings({}).flux_chunk_ms))


# ── retoque final: mediciones robustas y búfer de Flux al colgar ───────────

@pytest.mark.parametrize(
    "info",
    [
        {**TURN_INFO, "words": [{"word": "a", "end": "x"}]},
        {**TURN_INFO, "words": [{"end": 1.0}, {"end": "2"}]},
        {**TURN_INFO, "words": [{"end": 1.0}, "palabra", None]},
        {**TURN_INFO, "audio_window_end": float("inf")},
        {**TURN_INFO, "words": [{"end": float("nan")}]},
        {**TURN_INFO, "audio_window_end": True},
        {**TURN_INFO, "words": "no es una lista"},
    ],
)
def test_flux_decision_rejects_odd_data(info):
    from voice_agent.turn_detection import flux_decision_ms

    assert flux_decision_ms(info) is None


@pytest.mark.parametrize("result", [
    {**TURN_INFO, "words": [{"end": "x"}]},
    {**TURN_INFO, "audio_window_end": float("inf")},
    {"audio_window_end": 1.0, "words": [{"end": 0.5}, 3, {"end": None}]},
    "texto",
])
async def test_transcription_always_flows_through_tap(result):
    from pipecat.frames.frames import TranscriptionFrame
    from pipecat.tests.utils import run_test

    from voice_agent.pipeline import SttTurnTap, TurnClock

    clock = TurnClock()
    clock.stt_decision_ms = 123.0  # valor viejo: debe quedar anulado, no reutilizado
    down, _ = await run_test(
        SttTurnTap(clock),
        frames_to_send=[TranscriptionFrame("hola", "u", "t", None, result=result, finalized=True)],
        expected_down_frames=[TranscriptionFrame],
    )
    assert clock.stt_decision_ms is None


async def test_tap_survives_exception_and_logs_without_text(monkeypatch):
    from loguru import logger
    from pipecat.frames.frames import TranscriptionFrame
    from pipecat.tests.utils import run_test

    from voice_agent import pipeline

    def boom(_result):
        raise RuntimeError("Ana Pérez 600123456")

    monkeypatch.setattr(pipeline, "flux_decision_ms", boom)
    messages: list[str] = []
    sink = logger.add(lambda m: messages.append(str(m)), level="WARNING")
    try:
        await run_test(
            pipeline.SttTurnTap(pipeline.TurnClock()),
            frames_to_send=[TranscriptionFrame("Ana Pérez", "u", "t", None, result=TURN_INFO, finalized=True)],
            expected_down_frames=[TranscriptionFrame],
        )
    finally:
        logger.remove(sink)
    warning = "".join(messages)
    assert "SttTurnTap" in warning and "RuntimeError" in warning
    assert "Ana" not in warning and "600123456" not in warning


async def test_latency_tap_survives_bad_clock(tmp_path):
    from pipecat.frames.frames import BotStartedSpeakingFrame
    from pipecat.tests.utils import run_test

    from voice_agent.calllog import CallLog
    from voice_agent.pipeline import LatencyTap, TurnClock

    clock = TurnClock()
    clock.turn_stop = "no es un número"  # fuerza un fallo dentro de latency_record
    await run_test(LatencyTap(CallLog(str(tmp_path), "tw_CAbad0001"), clock),
                   frames_to_send=[BotStartedSpeakingFrame()], expected_down_frames=[BotStartedSpeakingFrame])
    assert clock.turn_stop is None


@pytest.mark.parametrize("method", ["stop", "cancel"])
async def test_flux_pending_audio_discarded_on_stop_and_cancel(real_env, monkeypatch, method):
    from pipecat.frames.frames import CancelFrame, EndFrame
    from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService

    from voice_agent.turn_detection import build_turn_setup

    stt = build_turn_setup(load_settings(real_env)).stt
    sent: list[bytes] = []

    async def fake_send(audio, _report):
        sent.append(audio)

    called = []

    async def parent(self, frame):
        called.append(type(frame).__name__)

    monkeypatch.setattr(DeepgramFluxSTTService, method, parent)
    stt._websocket, stt._sample_rate, stt.send_with_retry = object(), 8000, fake_send
    async for _ in stt.run_stt(b"\x00\x00" * 160):  # 20 ms: se queda pendiente
        pass
    assert len(stt._pending) == 320 and sent == []
    await getattr(stt, method)(EndFrame() if method == "stop" else CancelFrame())
    assert len(stt._pending) == 0 and sent == []  # descartado, no enviado
    assert called == ["EndFrame" if method == "stop" else "CancelFrame"]  # y sigue el cierre normal
