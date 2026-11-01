"""Muestras de voz: peticiones correctas, conversión a teléfono y sin clave → mensaje claro."""

from __future__ import annotations

import json
import struct

import httpx
import numpy as np

from voice_agent.muestras import (
    PHONE_RATE,
    SOURCE_RATE,
    azure_ssml,
    generate,
    load_voices,
    main,
    synth_azure,
    synth_deepgram,
    to_phone_ulaw,
    ulaw_wav,
)


def _tone(seconds: float = 1.0) -> bytes:
    t = np.arange(int(seconds * SOURCE_RATE)) / SOURCE_RATE
    return (0.3 * np.sin(2 * np.pi * 440 * t) * 32767).astype(np.int16).tobytes()


def test_voice_list_has_4_to_6_azure_candidates_and_three_phrases():
    v = load_voices()
    assert 4 <= len(v["azure"]) <= 6
    assert all(x["voz"].startswith("es-ES-") for x in v["azure"])
    assert v["deepgram"] and all(x["voz"].endswith("-es") for x in v["deepgram"])
    assert len(v["frases"]) == 3


def test_azure_request_shape():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = request.content.decode()
        return httpx.Response(200, content=_tone(0.1))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    pcm = synth_azure(client, "clave-falsa", "westeurope", "es-ES-ElviraNeural", "Hola & <adiós>")
    assert len(pcm) == int(0.1 * SOURCE_RATE) * 2
    assert seen["url"] == "https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1"
    assert seen["headers"]["x-microsoft-outputformat"] == "raw-24khz-16bit-mono-pcm"
    assert seen["headers"]["ocp-apim-subscription-key"] == "clave-falsa"
    assert "Hola &amp; &lt;adiós&gt;" in seen["body"] and 'name="es-ES-ElviraNeural"' in seen["body"]


def test_deepgram_request_shape():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = request.url
        seen["auth"] = request.headers["authorization"]
        seen["json"] = json.loads(request.content)
        return httpx.Response(200, content=_tone(0.1))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    synth_deepgram(client, "dg-falsa", "aura-2-carina-es", "Hola")
    assert seen["url"].path == "/v1/speak"
    assert seen["url"].params["model"] == "aura-2-carina-es"
    assert seen["url"].params["sample_rate"] == str(SOURCE_RATE)
    assert seen["auth"] == "Token dg-falsa" and seen["json"] == {"text": "Hola"}


def test_phone_version_is_8khz_ulaw():
    ulaw = to_phone_ulaw(_tone(1.0))
    assert abs(len(ulaw) - PHONE_RATE) <= 2  # 1 byte por muestra a 8 kHz
    wav = ulaw_wav(ulaw)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    fmt_code, channels, rate = struct.unpack("<HHI", wav[20:28])
    assert (fmt_code, channels, rate) == (7, 1, PHONE_RATE)


def test_generate_writes_both_versions_and_index(tmp_path):
    jobs = [("azure", "es-ES-ElviraNeural", lambda text: _tone(0.2))]
    written = generate(tmp_path, jobs, "Hola, has llamado a Chimac Peluqueros.", log=lambda _m: None)
    assert len(written) == 8  # saludo + 3 frases, normal y teléfono
    assert (tmp_path / "azure_es-ES-ElviraNeural_saludo_normal.wav").exists()
    assert (tmp_path / "azure_es-ES-ElviraNeural_frase3_telefono.wav").exists()
    assert "(internal doc, not included in the template)" in {p.name for p in tmp_path.iterdir()}


def test_generate_skips_provider_errors(tmp_path):
    def boom(_text):
        raise httpx.HTTPStatusError("401", request=httpx.Request("POST", "https://x"),
                                    response=httpx.Response(401))

    assert generate(tmp_path, [("azure", "es-ES-X", boom)], "Hola", log=lambda _m: None) == []


def test_cli_without_keys(monkeypatch, capsys, tmp_path):
    for var in ("AZURE_SPEECH_KEY", "DEEPGRAM_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    assert main(["--salida", str(tmp_path / "m")]) == 2
    assert "AZURE_SPEECH_KEY" in capsys.readouterr().err
    assert not (tmp_path / "m").exists()


def test_ssml_is_valid_xml():
    import xml.etree.ElementTree as ET

    ET.fromstring(azure_ssml("«Chimac» & co", "es-ES-AlvaroNeural"))
