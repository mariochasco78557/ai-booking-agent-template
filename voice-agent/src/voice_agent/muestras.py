"""Muestras de voz para elegir la del agente: ``python -m voice_agent.muestras``.

Genera el saludo de producción (``GREETING_TEXT``) y las 3 frases típicas de ``voces.json``
con cada voz candidata de Azure (``AZURE_SPEECH_KEY``) y de Deepgram Aura (si hay
``DEEPGRAM_API_KEY``). Por cada frase y voz deja dos ficheros:

- ``*_normal.wav``: PCM 16 bits a 24 kHz, como sale del proveedor;
- ``*_telefono.wav``: remuestreado a 8 kHz y pasado a μ-law, como lo oye el cliente por Twilio.

Sin ninguna clave sale con un mensaje claro (código 2). Coste: unos 1.000 caracteres por
voz (céntimos).
"""

from __future__ import annotations

import argparse
import audioop
import io
import json
import os
import struct
import sys
import wave
from collections.abc import Callable
from importlib import resources
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import httpx
import numpy as np
import soxr

from voice_agent.config import DEFAULT_GREETING

SOURCE_RATE = 24000
PHONE_RATE = 8000


def load_voices() -> dict[str, Any]:
    return json.loads(resources.files("voice_agent").joinpath("voces.json").read_text(encoding="utf-8"))


def azure_ssml(text: str, voice: str) -> str:
    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-ES">'
        f'<voice name="{escape(voice)}">{escape(text)}</voice></speak>'
    )


def synth_azure(client: httpx.Client, key: str, region: str, voice: str, text: str) -> bytes:
    """PCM 16 bits mono 24 kHz (sin cabecera)."""
    resp = client.post(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
            "User-Agent": "demo-salon-voice-agent-muestras",
        },
        content=azure_ssml(text, voice).encode("utf-8"),
        timeout=30.0,
    )
    resp.raise_for_status()
    return resp.content


def synth_deepgram(client: httpx.Client, key: str, voice: str, text: str) -> bytes:
    """PCM 16 bits mono 24 kHz (sin cabecera)."""
    resp = client.post(
        "https://api.deepgram.com/v1/speak",
        params={"model": voice, "encoding": "linear16", "sample_rate": SOURCE_RATE, "container": "none"},
        headers={"Authorization": f"Token {key}", "Content-Type": "application/json"},
        json={"text": text},
        timeout=30.0,
    )
    resp.raise_for_status()
    return resp.content


def pcm_wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def to_phone_ulaw(pcm: bytes, rate: int = SOURCE_RATE) -> bytes:
    """Remuestrea a 8 kHz (soxr, como Pipecat) y codifica en μ-law (G.711, como Twilio)."""
    samples = np.frombuffer(pcm, dtype=np.int16)
    resampled = soxr.resample(samples, rate, PHONE_RATE, quality="HQ")
    resampled = np.clip(np.round(resampled), -32768, 32767).astype(np.int16).tobytes()
    return audioop.lin2ulaw(resampled, 2)


def ulaw_wav(ulaw: bytes) -> bytes:
    """WAV con formato 7 (μ-law), 8 kHz, 8 bits: se oye en cualquier reproductor."""
    fmt = struct.pack("<HHIIHHH", 7, 1, PHONE_RATE, PHONE_RATE, 1, 8, 0)
    fact = struct.pack("<I", len(ulaw))
    data = ulaw + (b"\x00" if len(ulaw) % 2 else b"")
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"fact" + struct.pack("<I", 4) + fact
    chunks += b"data" + struct.pack("<I", len(ulaw)) + data
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


def phrases(greeting: str) -> list[tuple[str, str]]:
    items = [("saludo", greeting)]
    items += [(f"frase{i}", text) for i, text in enumerate(load_voices()["frases"], start=1)]
    return items


def generate(out_dir: Path, jobs: list[tuple[str, str, Callable[[str], bytes]]], greeting: str,
             log=print) -> list[Path]:
    """jobs: (proveedor, voz, función texto→PCM 24 kHz). Escribe los WAV y un índice."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    index = ["# Muestras de voz", "", "| Proveedor | Voz | Frase | Normal | Teléfono (8 kHz μ-law) |", "|---|---|---|---|---|"]
    for provider, voice, synth in jobs:
        for name, text in phrases(greeting):
            base = f"{provider}_{voice}_{name}".replace("/", "-")
            try:
                pcm = synth(text)
            except httpx.HTTPError as exc:
                status = getattr(getattr(exc, "response", None), "status_code", "red")
                log(f"  {provider} {voice} {name}: error ({status}); se salta")
                continue
            normal = out_dir / f"{base}_normal.wav"
            phone = out_dir / f"{base}_telefono.wav"
            normal.write_bytes(pcm_wav(pcm, SOURCE_RATE))
            phone.write_bytes(ulaw_wav(to_phone_ulaw(pcm)))
            written += [normal, phone]
            index.append(f"| {provider} | {voice} | {name} | {normal.name} | {phone.name} |")
            log(f"  {provider} {voice} {name}: ok")
    (out_dir / "(internal doc, not included in the template)").write_text("\n".join(index) + "\n", encoding="utf-8")
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m voice_agent.muestras", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--salida", default="muestras-voz", help="carpeta de salida (fuera de Git)")
    parser.add_argument("--proveedor", choices=("azure", "deepgram", "todos"), default="todos")
    parser.add_argument("--voz", action="append", help="solo esta voz (se puede repetir)")
    args = parser.parse_args(argv)

    azure_key = os.environ.get("AZURE_SPEECH_KEY", "")
    azure_region = os.environ.get("AZURE_SPEECH_REGION", "westeurope")
    deepgram_key = os.environ.get("DEEPGRAM_API_KEY", "")
    want_azure = args.proveedor in ("azure", "todos") and bool(azure_key)
    want_deepgram = args.proveedor in ("deepgram", "todos") and bool(deepgram_key)
    if not (want_azure or want_deepgram):
        print("Faltan claves: pon AZURE_SPEECH_KEY (y AZURE_SPEECH_REGION) y/o DEEPGRAM_API_KEY en el entorno.\n"
              "No se ha generado nada.", file=sys.stderr)
        return 2
    greeting = os.environ.get("GREETING_TEXT") or DEFAULT_GREETING
    voices = load_voices()
    client = httpx.Client()
    jobs: list[tuple[str, str, Callable[[str], bytes]]] = []
    if want_azure:
        for v in voices["azure"]:
            if args.voz and v["voz"] not in args.voz:
                continue
            jobs.append(("azure", v["voz"], lambda t, voice=v["voz"]: synth_azure(client, azure_key, azure_region, voice, t)))
    if want_deepgram:
        for v in voices["deepgram"]:
            if args.voz and v["voz"] not in args.voz:
                continue
            jobs.append(("deepgram", v["voz"], lambda t, voice=v["voz"]: synth_deepgram(client, deepgram_key, voice, t)))
    print(f"Generando {len(jobs)} voces × {len(phrases(greeting))} frases en {args.salida}/ …")
    written = generate(Path(args.salida), jobs, greeting)
    client.close()
    print(f"{len(written)} ficheros. Índice: {Path(args.salida) / '(internal doc, not included in the template)'}")
    return 0 if written else 1


if __name__ == "__main__":
    raise SystemExit(main())
