"""Registro técnico (loguru) sin datos del cliente.

Pipecat 1.12.0 escribe en DEBUG el contexto completo del LLM y el texto del TTS
(``anthropic/llm.py`` «Generating chat from context», ``tts_service.py``), y por
defecto loguru manda DEBUG a stderr. Aquí:

1. ``logger.remove()`` y un único sink en ``LOG_LEVEL`` (INFO por defecto).
2. Un «patcher» que, en TODOS los niveles, tacha el texto de los frames
   (``text: [...]``, que aparece en avisos y errores con el repr del frame), lo que
   el TTS no ha podido decir (``not speaking [...]``) y cualquier tramo de 3 o más
   cifras.

Con ``LOG_LEVEL=DEBUG`` se verían mensajes de Pipecat con la conversación (tachada
solo en parte): úsese solo en pruebas con nombres y teléfonos ficticios.
"""

from __future__ import annotations

import re
import sys
from typing import Any

from loguru import logger

from voice_agent.calllog import redact_phones

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
_FRAME_TEXT = re.compile(r"text: \[.*?\](?=[,)])", re.DOTALL)
_NOT_SPEAKING = re.compile(r"not speaking \[.*\]", re.DOTALL)


def scrub(message: str) -> str:
    message = _FRAME_TEXT.sub("text: [omitido]", message)
    message = _NOT_SPEAKING.sub("not speaking [omitido]", message)
    return redact_phones(message)


def _patch(record: dict[str, Any]) -> None:
    record["message"] = scrub(record["message"])


def configure_logging(level: str = "INFO", sink: Any = None) -> None:
    level = (level or "INFO").upper()
    if level not in LEVELS:
        level = "INFO"
    logger.remove()
    logger.configure(patcher=_patch)
    logger.add(sink if sink is not None else sys.stderr, level=level, backtrace=False, diagnose=False)
    if level == "DEBUG":
        logger.warning("LOG_LEVEL=DEBUG: Pipecat registra la conversación; usar solo con datos ficticios")
