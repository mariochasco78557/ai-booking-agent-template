"""Medición de CPU: corre en pequeño y devuelve las cifras esperadas."""

from __future__ import annotations

from voice_agent.bench_cpu import SAMPLE_RATE, run_smart_turn, run_vad, synthetic_speech


def test_synthetic_speech_is_8khz_int16():
    audio = synthetic_speech(1.0)
    assert audio.dtype.name == "int16" and len(audio) == SAMPLE_RATE


def test_small_runs_report_figures():
    vad = run_vad(1, 1.0)
    assert vad["inferencias"] == SAMPLE_RATE // 256 and vad["ms_inferencia_p50"] > 0
    st = run_smart_turn(1, 2, turn_seconds=1.0)
    assert st["inferencias"] == 2 and st["cpu_ms_por_inferencia"] > 0
