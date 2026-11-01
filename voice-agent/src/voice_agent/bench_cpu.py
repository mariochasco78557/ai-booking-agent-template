"""Coste de CPU local de Silero VAD y smart-turn v3: ``python -m voice_agent.bench_cpu``.

Audio sintético a 8 kHz (como el de Twilio), 1 y 3 flujos a la vez (hilos: onnxruntime
suelta el GIL). Mide:
- Silero: ms por inferencia (cada 256 muestras = 32 ms de audio) y % de CPU necesario
  para seguir el ritmo real (tiempo de CPU / segundos de audio);
- smart-turn v3: ms por inferencia (una por pausa del cliente; el modelo siempre ve 8 s,
  así que el coste no depende de lo largo de la frase), con variantes:
  ``--variante int8`` (el que trae Pipecat, cuantizado QDQ) o ``fp32`` (``smart-turn-v3.2-gpu.onnx``
  del repositorio oficial, se descarga con ``--descargar`` y se verifica su sha256),
  ``--modelo RUTA``, ``--hilos 1,2`` (intra-op), ``--sesion propia,compartida`` y
  ``--desglose`` (separa el cálculo de los mel en numpy de la inferencia ONNX);
- RSS del proceso.

Ejecutar SIEMPRE dentro de un cgroup con tope (ver README). Los números dependen mucho de
la CPU (AVX-512/VNNI acelera los kernels int8): repetirlos en la máquina de destino.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import resource
import statistics
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

SAMPLE_RATE = 8000
VAD_CHUNK = 256  # muestras a 8 kHz que pide Silero (32 ms)

VARIANTS: dict[str, dict[str, str]] = {
    "int8": {"fichero": "(incluido en Pipecat) smart-turn-v3.2-cpu.onnx",
             "sha256": "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"},
    "fp32": {"fichero": "smart-turn-v3.2-gpu.onnx",
             "url": "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-gpu.onnx",
             "sha256": "ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be"},
}
DEFAULT_CACHE = Path.home() / ".cache" / "demo-salon-voice" / "models"


def rss_mb() -> float:
    with open("/proc/self/status") as fh:
        for line in fh:
            if line.startswith("VmRSS"):
                return int(line.split()[1]) / 1024
    return 0.0


def cpu_info() -> dict[str, Any]:
    info: dict[str, Any] = {"python": platform.python_version(), "nucleos_visibles": os.cpu_count()}
    try:
        text = Path("/proc/cpuinfo").read_text()
        model = next((line.split(":", 1)[1].strip() for line in text.splitlines() if line.startswith("model name")), "")
        flags_line = next((line for line in text.splitlines() if line.startswith("flags")), "")
        flags = set(flags_line.split(":", 1)[1].split()) if flags_line else set()
        info["cpu"] = model
        info["flags"] = sorted(f for f in ("avx2", "fma", "avx512f", "avx512_vnni", "avx_vnni", "amx_int8") if f in flags)
    except OSError:
        pass
    try:
        info["cgroup_cpu_max"] = Path("/sys/fs/cgroup/cpu.max").read_text().strip()
    except OSError:
        pass
    try:
        import onnxruntime as ort

        info["onnxruntime"] = ort.__version__
    except ImportError:
        pass
    return info


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def quantized_ops(path: Path) -> int:
    """Nº aproximado de nodos DequantizeLinear (0 = modelo sin cuantizar)."""
    return path.read_bytes().count(b"DequantizeLinear")


def resolve_model(variant: str, model: str | None, download: bool, cache_dir: Path) -> Path:
    """Ruta del modelo. fp32 solo se descarga con --descargar, y se verifica su sha256."""
    if model:
        return Path(model)
    if variant == "int8":
        from voice_agent.turn_detection import bundled_smart_turn_path

        return Path(bundled_smart_turn_path())
    spec = VARIANTS[variant]
    target = cache_dir / spec["fichero"]
    if not target.exists():
        if not download:
            raise SystemExit(f"Falta {target}. Añade --descargar (descarga ~32 MB de Hugging Face) o usa --modelo RUTA.")
        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".part")
        download_file(spec["url"], tmp)
        got = sha256_of(tmp)
        if got != spec["sha256"]:  # se comprueba ANTES de darle el nombre definitivo
            tmp.unlink(missing_ok=True)
            raise SystemExit(f"La descarga de {spec['url']} no coincide con el sha256 esperado "
                             f"({got[:16]}… en vez de {spec['sha256'][:16]}…). Se ha borrado; no se usa.")
        tmp.rename(target)
    elif sha256_of(target) != spec["sha256"]:
        raise SystemExit(f"sha256 inesperado en {target}: bórralo y descárgalo otra vez")
    return target


def download_file(url: str, dest: Path) -> None:
    import httpx

    with httpx.stream("GET", url, follow_redirects=True, timeout=120.0) as resp:
        resp.raise_for_status()
        with dest.open("wb") as fh:
            for chunk in resp.iter_bytes():
                fh.write(chunk)


def synthetic_speech(seconds: float, seed: int = 0) -> np.ndarray:
    """Habla sintética: tonos con modulación de sílabas y ruido de línea, int16 a 8 kHz."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    f0 = 140 + 30 * np.sin(2 * np.pi * 0.7 * t)
    voiced = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 6))
    syllables = (np.sin(2 * np.pi * 4 * t) > -0.2).astype(np.float32)
    pauses = (np.sin(2 * np.pi * 0.25 * t) > -0.6).astype(np.float32)
    signal = 0.3 * voiced * syllables * pauses + 0.01 * rng.standard_normal(len(t))
    return np.clip(signal * 32767, -32768, 32767).astype(np.int16)


def _pct(values: list[float], p: float) -> float:
    ordered = sorted(values)
    return ordered[int(p / 100 * (len(ordered) - 1))]


def run_vad(streams: int, seconds: float) -> dict[str, Any]:
    from pipecat.audio.vad.silero import SileroVADAnalyzer

    analyzers = []
    for _ in range(streams):
        vad = SileroVADAnalyzer()
        vad.set_sample_rate(SAMPLE_RATE)
        analyzers.append(vad)
    audio = [synthetic_speech(seconds, seed=i).tobytes() for i in range(streams)]
    per_inference: list[list[float]] = [[] for _ in range(streams)]

    def worker(i: int) -> None:
        data = audio[i]
        step = VAD_CHUNK * 2
        for off in range(0, len(data) - step + 1, step):
            t0 = time.perf_counter()
            analyzers[i].voice_confidence(data[off:off + step])
            per_inference[i].append((time.perf_counter() - t0) * 1000)

    wall0, proc0 = time.perf_counter(), time.process_time()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(streams)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    wall, proc = time.perf_counter() - wall0, time.process_time() - proc0
    flat = [x for lst in per_inference for x in lst]
    return {
        "flujos": streams,
        "segundos_audio_por_flujo": seconds,
        "inferencias": len(flat),
        "ms_inferencia_p50": round(statistics.median(flat), 3),
        "ms_inferencia_p95": round(_pct(flat, 95), 3),
        "cpu_s_proceso": round(proc, 3),
        "pared_s": round(wall, 3),
        # % de UN núcleo necesario para seguir el ritmo real con N llamadas a la vez.
        "cpu_pct_tiempo_real": round(100 * proc / seconds, 2),
        "rss_mb": round(rss_mb(), 1),
    }


def run_smart_turn(streams: int, inferences: int, turn_seconds: float = 4.0, model_path: str = "",
                   threads: int = 1, shared: bool = False, breakdown: bool = False) -> dict[str, Any]:
    from pipecat.audio.turn.smart_turn._whisper_features import compute_whisper_log_mel_features

    from voice_agent.turn_detection import make_smart_turn

    rss0 = rss_mb()
    analyzers = []
    for _ in range(streams):
        st = make_smart_turn(model_path, threads, shared)
        st.set_sample_rate(SAMPLE_RATE)
        analyzers.append(st)
    rss_models = rss_mb()
    segments = [synthetic_speech(turn_seconds, seed=10 + i).astype(np.float32) / 32768.0 for i in range(streams)]
    times: list[list[float]] = [[] for _ in range(streams)]
    feat_ms: list[float] = []
    onnx_ms: list[float] = []
    lock = threading.Lock()

    def predict_split(st, audio: np.ndarray) -> None:
        t0 = time.perf_counter()
        x = st._resample_to_model_rate(audio)
        x = x[-128000:] if len(x) > 128000 else np.pad(x, (128000 - len(x), 0))
        mel = np.expand_dims(compute_whisper_log_mel_features(x, do_normalize=True), axis=0)
        t1 = time.perf_counter()
        st._session.run(None, {"input_features": mel})
        t2 = time.perf_counter()
        with lock:
            feat_ms.append((t1 - t0) * 1000)
            onnx_ms.append((t2 - t1) * 1000)

    def worker(i: int) -> None:
        for _ in range(inferences):
            t0 = time.perf_counter()
            if breakdown:
                predict_split(analyzers[i], segments[i])
            else:
                analyzers[i]._predict_endpoint(segments[i])
            times[i].append((time.perf_counter() - t0) * 1000)

    for i, st in enumerate(analyzers):  # calentamiento: una inferencia por analizador, no se cuenta
        st._predict_endpoint(segments[i])
    proc0 = time.process_time()
    pool = [threading.Thread(target=worker, args=(i,)) for i in range(streams)]
    for th in pool:
        th.start()
    for th in pool:
        th.join()
    proc = time.process_time() - proc0
    flat = [x for lst in times for x in lst]
    path = Path(model_path) if model_path else None
    result = {
        "flujos": streams,
        "modelo": path.name if path else "smart-turn-v3.2-cpu.onnx (int8, Pipecat)",
        "hilos": threads,
        "sesion": "compartida" if shared else "propia",
        "inferencias": len(flat),
        "ms_inferencia_p50": round(statistics.median(flat), 1),
        "ms_inferencia_p95": round(_pct(flat, 95), 1),
        "cpu_ms_por_inferencia": round(1000 * proc / len(flat), 1),
        "rss_modelos_mb": round(rss_models - rss0, 1),
        "rss_mb": round(rss_mb(), 1),
    }
    if breakdown and feat_ms:
        result["ms_mel_numpy_p50"] = round(statistics.median(feat_ms), 1)
        result["ms_onnx_p50"] = round(statistics.median(onnx_ms), 1)
    return result


def _csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m voice_agent.bench_cpu", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--segundos", type=float, default=30.0, help="audio por flujo para Silero")
    parser.add_argument("--inferencias", type=int, default=20, help="inferencias de smart-turn por flujo")
    parser.add_argument("--flujos", default="1,3")
    parser.add_argument("--solo", choices=("silero", "smart_turn"), default=None)
    parser.add_argument("--variante", default="int8", help="int8 y/o fp32, separadas por comas")
    parser.add_argument("--modelo", default=None, help="ruta a un .onnx de smart-turn (anula --variante)")
    parser.add_argument("--descargar", action="store_true", help="permite descargar el modelo fp32 (~32 MB)")
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
    parser.add_argument("--hilos", default="1", help="hilos intra-op de onnxruntime, p. ej. 1,2")
    parser.add_argument("--sesion", default="propia", help="propia y/o compartida")
    parser.add_argument("--desglose", action="store_true", help="separa mel (numpy) e inferencia ONNX")
    parser.add_argument("--salida-json", default=None)
    args = parser.parse_args(argv)
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    from voice_agent.logging_setup import configure_logging

    configure_logging(os.environ.get("LOG_LEVEL", "WARNING"))
    flows = [int(x) for x in _csv(args.flujos)]
    results: dict[str, Any] = {"maquina": cpu_info(), "rss_inicial_mb": round(rss_mb(), 1),
                               "silero": [], "smart_turn": []}
    if args.solo != "smart_turn":
        for n in flows:
            results["silero"].append(run_vad(n, args.segundos))
    if args.solo != "silero":
        variants = ["ruta"] if args.modelo else _csv(args.variante)
        for variant in variants:
            if variant not in VARIANTS and variant != "ruta":
                raise SystemExit(f"--variante desconocida: {variant} (int8 o fp32)")
            path = resolve_model(variant, args.modelo, args.descargar, Path(args.cache_dir))
            model_info = {"variante": variant, "fichero": path.name, "sha256": sha256_of(path)[:16],
                          "nodos_dequantize": quantized_ops(path), "mb": round(path.stat().st_size / 1e6, 1)}
            for threads in (int(x) for x in _csv(args.hilos)):
                for session in _csv(args.sesion):
                    for n in flows:
                        row = run_smart_turn(n, args.inferencias, model_path=str(path), threads=threads,
                                             shared=session == "compartida", breakdown=args.desglose)
                        results["smart_turn"].append({**model_info, **row})
    results["rss_max_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    text = json.dumps(results, ensure_ascii=False, indent=2)
    if args.salida_json:
        Path(args.salida_json).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
