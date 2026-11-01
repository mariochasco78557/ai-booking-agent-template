"""TURN_DETECTION=deepgram_flux|smart_turn|vad: configuración y construcción sin red."""

from __future__ import annotations

from pathlib import Path

import pytest

from voice_agent.config import DEFAULT_FLUX_URL, ConfigError, load_settings


def test_defaults():
    s = load_settings({})
    assert s.turn_detection == "deepgram_flux"
    assert s.deepgram_flux_model == "flux-general-multi"
    assert s.deepgram_flux_url == DEFAULT_FLUX_URL and "api.eu.deepgram.com" in DEFAULT_FLUX_URL
    assert s.vad_stop_secs == 0.8
    assert s.smart_turn_threads == 1 and s.smart_turn_shared is True and s.smart_turn_model == ""
    assert s.flux_eot_threshold is None and s.flux_eot_timeout_ms is None


@pytest.mark.parametrize(
    "env,match",
    [
        ({"TURN_DETECTION": "silero"}, "TURN_DETECTION"),
        ({"VAD_STOP_SECS": "0.1"}, "VAD_STOP_SECS"),
        ({"VAD_STOP_SECS": "3"}, "VAD_STOP_SECS"),
        ({"SMART_TURN_THREADS": "0"}, "SMART_TURN_THREADS"),
        ({"DEEPGRAM_FLUX_MODEL": "nova-3"}, "DEEPGRAM_FLUX_MODEL"),
        ({"DEEPGRAM_FLUX_MODEL": "flux-general-en"}, "solo entiende inglés"),
        ({"DEEPGRAM_FLUX_URL": "https://api.deepgram.com/v2/listen"}, "wss://"),
        ({"FLUX_EOT_THRESHOLD": "0.95"}, "FLUX_EOT_THRESHOLD"),
        ({"FLUX_EOT_TIMEOUT_MS": "100"}, "FLUX_EOT_TIMEOUT_MS"),
        ({"TURN_DETECTION": "smart_turn", "SMART_TURN_MODEL": "/no/existe.onnx"}, "SMART_TURN_MODEL"),
    ],
)
def test_invalid_values(env, match):
    with pytest.raises(ConfigError, match=match):
        load_settings(env)


def test_flux_en_allowed_for_english():
    s = load_settings({"DEEPGRAM_FLUX_MODEL": "flux-general-en", "DEEPGRAM_LANGUAGE": "en"})
    assert s.deepgram_flux_model == "flux-general-en"


def test_flux_setup_has_no_local_vad_or_smart_turn(real_env):
    from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
    from pipecat.transcriptions.language import Language

    from voice_agent.pipeline import user_aggregator_params
    from voice_agent.turn_detection import build_turn_setup

    real_env.update(FLUX_EOT_THRESHOLD="0.75", FLUX_EOT_TIMEOUT_MS="3000")
    turn = build_turn_setup(load_settings(real_env))
    assert turn.mode == "deepgram_flux"
    assert isinstance(turn.stt, DeepgramFluxSTTService)
    assert turn.vad_analyzer is None and turn.user_turn_strategies is None
    st = turn.stt._settings
    assert st.model == "flux-general-multi" and st.language_hints == [Language.ES]
    assert "Chimac" in st.keyterm and st.eot_threshold == 0.75 and st.eot_timeout_ms == 3000
    assert turn.stt._url == DEFAULT_FLUX_URL
    params = user_aggregator_params(load_settings(real_env), turn)
    assert params.vad_analyzer is None and params.user_turn_strategies is None
    assert params.user_mute_strategies  # G7 se mantiene


def test_flux_query_string_carries_spanish_hint_and_keyterms(real_env):
    from voice_agent.turn_detection import build_turn_setup

    stt = build_turn_setup(load_settings(real_env)).stt
    stt._sample_rate = 8000
    query = stt._build_query_string()
    assert "model=flux-general-multi" in query and "language_hint=es" in query
    assert "keyterm=Chimac" in query and "sample_rate=8000" in query


def test_vad_setup_uses_speech_timeout(real_env):
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy

    from voice_agent.pipeline import user_aggregator_params
    from voice_agent.turn_detection import PIPECAT_VAD_STOP_SECS, build_turn_setup

    real_env.update(TURN_DETECTION="vad", VAD_STOP_SECS="0.9")
    settings = load_settings(real_env)
    turn = build_turn_setup(settings)
    assert isinstance(turn.vad_analyzer, SileroVADAnalyzer)
    assert turn.vad_analyzer.params.stop_secs == PIPECAT_VAD_STOP_SECS == 0.2
    (stop,) = turn.user_turn_strategies.stop
    assert isinstance(stop, SpeechTimeoutUserTurnStopStrategy)
    assert stop._user_speech_timeout == pytest.approx(0.7)  # 0,9 s de silencio en total
    params = user_aggregator_params(settings, turn)
    assert params.vad_analyzer is turn.vad_analyzer and params.user_turn_strategies is turn.user_turn_strategies


def test_smart_turn_setup_and_shared_session(real_env):
    from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy

    from voice_agent.turn_detection import build_turn_setup, bundled_smart_turn_path, make_smart_turn

    real_env.update(TURN_DETECTION="smart_turn")
    turn = build_turn_setup(load_settings(real_env))
    (stop,) = turn.user_turn_strategies.stop
    assert isinstance(stop, TurnAnalyzerUserTurnStopStrategy)
    a, b = make_smart_turn(shared=True), make_smart_turn(shared=True)
    assert a._session is b._session  # una sesión ONNX para todas las llamadas
    c = make_smart_turn(shared=False)
    assert c._session is not a._session
    assert Path(bundled_smart_turn_path()).name == "smart-turn-v3.2-cpu.onnx"


def test_smart_turn_custom_model_and_threads(real_env, tmp_path):
    import shutil

    from voice_agent.turn_detection import bundled_smart_turn_path, make_smart_turn

    model = tmp_path / "modelo.onnx"
    shutil.copy(bundled_smart_turn_path(), model)
    real_env.update(TURN_DETECTION="smart_turn", SMART_TURN_MODEL=str(model), SMART_TURN_THREADS="2")
    s = load_settings(real_env)
    st = make_smart_turn(s.smart_turn_model, s.smart_turn_threads, s.smart_turn_shared)
    assert st._session.get_session_options().intra_op_num_threads == 2


def test_call_log_records_turn_detection(real_env, monkeypatch):
    """El JSONL de cada llamada dice qué modo de fin de turno y qué STT se usó."""
    import inspect

    from voice_agent import pipeline

    source = inspect.getsource(pipeline.run_call)
    assert "turn_detection=settings.turn_detection" in source


def test_flux_price_is_known():
    from voice_agent.precios import precios, stt_cost

    assert "deepgram:flux-general-multi" in precios()["stt"]
    assert stt_cost("deepgram:flux-general-multi", 10) == pytest.approx(0.078)


def test_bench_variants_are_pinned():
    from voice_agent.bench_cpu import VARIANTS, sha256_of
    from voice_agent.turn_detection import bundled_smart_turn_path

    assert sha256_of(Path(bundled_smart_turn_path())) == VARIANTS["int8"]["sha256"]
    assert VARIANTS["fp32"]["url"].startswith("https://huggingface.co/pipecat-ai/smart-turn-v3/")
    assert len(VARIANTS["fp32"]["sha256"]) == 64


def test_bench_without_download_explains(tmp_path):
    from voice_agent.bench_cpu import resolve_model

    with pytest.raises(SystemExit, match="--descargar"):
        resolve_model("fp32", None, False, tmp_path)


def test_bench_breakdown_small():
    from voice_agent.bench_cpu import run_smart_turn

    row = run_smart_turn(1, 2, turn_seconds=1.0, shared=True, breakdown=True)
    assert row["sesion"] == "compartida" and row["ms_onnx_p50"] > 0 and row["ms_mel_numpy_p50"] > 0
