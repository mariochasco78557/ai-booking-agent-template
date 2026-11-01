"""Detección de fin de turno configurable: ``TURN_DETECTION=smart_turn|vad|deepgram_flux``.

Ver (internal doc, not included in the template) §3 bis. Resumen:

- ``deepgram_flux`` (por defecto): Deepgram Flux Multilingual (``flux-general-multi`` con
  ``language_hint=es``) transcribe Y decide el fin de turno en la nube. Sin VAD ni
  smart-turn locales: cero CPU local para esto. Pipecat 1.12.0 lo integra de serie
  (``DeepgramFluxSTTService``, que propone sus propias estrategias de turno).
- ``smart_turn``: Deepgram Nova-3 + Silero VAD (0,2 s) + smart-turn v3 local (ONNX).
  En la VPS de Bruno (Haswell, sin AVX-512) cuesta ~261 ms de CPU por decisión con el
  modelo int8 que trae Pipecat; se puede probar el fp32 (``SMART_TURN_MODEL``), más
  hilos (``SMART_TURN_THREADS``) y una sola sesión ONNX para todas las llamadas.
- ``vad``: Deepgram Nova-3 + solo Silero: el turno acaba tras ``VAD_STOP_SECS`` de
  silencio (0,2 s del VAD + el resto como espera de Pipecat).
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from typing import Any

from voice_agent.config import Settings

# Silencio que confirma el VAD; Pipecat calcula sus latencias con este valor (VAD_STOP_SECS).
PIPECAT_VAD_STOP_SECS = 0.2

_SESSIONS: dict[tuple[str, int], Any] = {}
_SESSIONS_LOCK = threading.Lock()


def bundled_smart_turn_path() -> str:
    from importlib import resources

    return str(resources.files("pipecat.audio.turn.smart_turn.data").joinpath("smart-turn-v3.2-cpu.onnx"))


def shared_session(model_path: str, threads: int):
    """Una sola InferenceSession por (modelo, hilos) en todo el proceso.

    onnxruntime permite ``run`` concurrente sobre la misma sesión; compartirla ahorra
    ~25 MB y la carga del modelo por llamada (no ahorra CPU por inferencia).
    """
    import onnxruntime as ort

    key = (model_path, threads)
    with _SESSIONS_LOCK:
        session = _SESSIONS.get(key)
        if session is None:
            so = ort.SessionOptions()
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            so.inter_op_num_threads = 1
            so.intra_op_num_threads = threads
            so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            session = ort.InferenceSession(model_path, sess_options=so)
            _SESSIONS[key] = session
        return session


def make_smart_turn(model_path: str = "", threads: int = 1, shared: bool = True):
    """smart-turn v3 con el modelo, los hilos y la sesión elegidos."""
    from pipecat.audio.turn.smart_turn.base_smart_turn import BaseSmartTurn
    from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3

    path = model_path or bundled_smart_turn_path()
    if not shared:
        return LocalSmartTurnAnalyzerV3(smart_turn_model_path=path, cpu_count=threads)

    class SharedSessionSmartTurn(LocalSmartTurnAnalyzerV3):
        """Igual que LocalSmartTurnAnalyzerV3, pero sin cargar una sesión por llamada."""

        def __init__(self):
            BaseSmartTurn.__init__(self)
            self._log_data = False
            self._session = shared_session(path, threads)

    return SharedSessionSmartTurn()


@dataclass
class TurnSetup:
    """Lo que cambia en el pipeline según el modo de fin de turno."""

    mode: str
    stt: Any
    vad_analyzer: Any | None
    user_turn_strategies: Any | None
    description: str


def build_turn_setup(settings: Settings) -> TurnSetup:
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams
    from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy, TurnAnalyzerUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies

    mode = settings.turn_detection
    if mode == "deepgram_flux":
        return TurnSetup(
            mode=mode,
            stt=build_flux_stt(settings),
            vad_analyzer=None,  # Flux decide inicio y fin de turno (y las interrupciones)
            user_turn_strategies=None,  # Pipecat aplica las que recomienda Flux
            description=f"Deepgram {settings.deepgram_flux_model} (es), fin de turno en la nube",
        )

    from voice_agent.pipeline import build_stt

    vad = SileroVADAnalyzer(params=VADParams(stop_secs=PIPECAT_VAD_STOP_SECS))
    if mode == "vad":
        wait = max(0.0, settings.vad_stop_secs - PIPECAT_VAD_STOP_SECS)
        return TurnSetup(
            mode=mode,
            stt=build_stt(settings),
            vad_analyzer=vad,
            user_turn_strategies=UserTurnStrategies(
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=wait)]
            ),
            description=f"Nova-3 + Silero, fin de turno tras {settings.vad_stop_secs:.2f} s de silencio",
        )
    analyzer = make_smart_turn(settings.smart_turn_model, settings.smart_turn_threads, settings.smart_turn_shared)
    return TurnSetup(
        mode=mode,
        stt=build_stt(settings),
        vad_analyzer=vad,
        user_turn_strategies=UserTurnStrategies(stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=analyzer)]),
        description="Nova-3 + Silero + smart-turn v3 local",
    )


def flux_decision_ms(result: Any) -> float | None:
    """Lo que tardó Flux en cerrar el turno: ``audio_window_end`` − fin de la última palabra.

    Ambos en segundos del flujo de audio (TurnInfo de Deepgram). None si faltan datos.
    """
    if hasattr(result, "model_dump"):
        result = result.model_dump()
    if not isinstance(result, dict):
        return None
    window_end = result.get("audio_window_end")
    words = result.get("words")
    if not _finite(window_end) or not isinstance(words, list) or not words:
        return None
    ends = []
    for word in words:
        end = word.get("end") if isinstance(word, dict) else None
        if not _finite(end):
            return None  # un dato raro invalida la estimación entera: mejor sin cifra que con una falsa
        ends.append(float(end))
    return max(0.0, (float(window_end) - max(ends)) * 1000)


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def chunk_bytes(sample_rate: int, chunk_ms: int) -> int:
    return int(sample_rate * 2 * chunk_ms / 1000)  # linear16 mono


def make_chunked_flux_class():
    """DeepgramFluxSTTService que agrupa el audio en trozos de ``chunk_ms`` (80 ms recomendados).

    Twilio entrega 20 ms por mensaje y Pipecat 1.12.0 los manda a Flux tal cual; Deepgram
    recomienda 80 ms («strongly recommended») para su modelo. Se acumula y se llama al
    ``run_stt`` original, que sigue haciendo el envío, el vigilante de silencio y los errores.
    """
    from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService

    class ChunkedFluxSTTService(DeepgramFluxSTTService):
        def __init__(self, *, chunk_ms: int = 80, **kwargs: Any):
            super().__init__(**kwargs)
            self._chunk_ms = chunk_ms
            self._pending = bytearray()

        async def stop(self, frame):
            # Al colgar se descarta lo pendiente (< chunk_ms de audio de una llamada que termina):
            # enviarlo no aporta nada y el socket puede estar ya cerrándose.
            self._pending.clear()
            await super().stop(frame)

        async def cancel(self, frame):
            self._pending.clear()
            await super().cancel(frame)

        async def run_stt(self, audio: bytes):
            self._pending += audio
            if len(self._pending) < chunk_bytes(self.sample_rate or 8000, self._chunk_ms):
                yield None
                return
            chunk = bytes(self._pending)
            self._pending.clear()
            async for frame in super().run_stt(chunk):
                yield frame

    return ChunkedFluxSTTService


def build_flux_stt(settings: Settings):
    from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
    from pipecat.transcriptions.language import Language

    try:
        hints = [Language(settings.deepgram_language)]
    except ValueError:
        hints = [Language.ES]
    flux_settings: dict[str, Any] = {
        "model": settings.deepgram_flux_model,
        "language_hints": hints,
        "keyterm": list(settings.deepgram_keyterms),
    }
    if settings.flux_eot_threshold is not None:
        flux_settings["eot_threshold"] = settings.flux_eot_threshold
    if settings.flux_eot_timeout_ms is not None:
        flux_settings["eot_timeout_ms"] = settings.flux_eot_timeout_ms
    return make_chunked_flux_class()(
        chunk_ms=settings.flux_chunk_ms,
        api_key=settings.deepgram_api_key,
        url=settings.deepgram_flux_url,
        sample_rate=8000,
        settings=DeepgramFluxSTTService.Settings(**flux_settings),
    )
