"""Precios para estimar costes (``precios.json``). Solo estimaciones: ver la nota del fichero."""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources
from typing import Any


@lru_cache(maxsize=1)
def precios() -> dict[str, Any]:
    return json.loads(resources.files("voice_agent").joinpath("precios.json").read_text(encoding="utf-8"))


def llm_price_known(model: str) -> bool:
    """True si ``precios.json`` tiene precio para ese modelo (sin recurrir a otro)."""
    return model in precios()["llm"]


def llm_cost(model: str, input_tokens: int, cache_read: int, cache_write: int, output_tokens: int) -> float:
    """Coste en USD de una o varias llamadas a Anthropic (``input_tokens`` ya va sin caché)."""
    p = precios()["llm"].get(model) or precios()["llm"]["claude-haiku-4-5"]
    return (
        input_tokens * p["entrada_por_millon"]
        + cache_read * p["cache_lectura_por_millon"]
        + cache_write * p["cache_escritura_5m_por_millon"]
        + output_tokens * p["salida_por_millon"]
    ) / 1_000_000


def stt_cost(provider_model: str, minutes: float) -> float:
    p = precios()["stt"].get(provider_model) or precios()["stt"]["deepgram:nova-3"]
    return minutes * p["por_minuto"]


def tts_cost(provider: str, characters: int) -> float:
    p = precios()["tts"].get(provider) or precios()["tts"]["azure"]
    return characters * p["por_millon_caracteres"] / 1_000_000
