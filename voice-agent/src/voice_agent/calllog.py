"""Registro de cada llamada en JSONL local.

- Un fichero por llamada: ``<CALL_LOG_DIR>/<AAAA-MM-DD>_<conversation_id>.jsonl``.
- Fuera del repositorio (por defecto ``/var/lib/demo-salon-voice/calls``, un volumen Docker).
- Retención: se borran los ficheros con más de ``CALL_LOG_RETENTION_DAYS`` días.
- Minimizar en vez de perseguir formatos:
  * el turno del cliente que responde a una petición de nombre o teléfono, o que
    llega en el paso DATOS, se guarda como «[datos personales omitidos]»;
  * el resumen del agente (lleva nombre y teléfono) se guarda como «[resumen omitido]»;
  * en el resto se tacha cualquier tramo de 3 o más cifras (aunque vaya separado por
    espacios, guiones, puntos o comas) y de 3 o más números dichos con palabras;
  * de las herramientas nunca se guardan customer_name, customer_surnames, phone ni el token.
- El número llamante nunca se guarda.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_SEP = r"[\s.,;\-]{0,3}"
_PHONE_RUN = re.compile(rf"\+?\d(?:{_SEP}\d){{5,}}")  # teléfonos (registro técnico)
_DIGITS_3 = re.compile(rf"\+?\d(?:{_SEP}\d){{2,}}")  # 3 o más cifras (registro de llamadas)
_NUMBER_WORDS = r"(?:cero|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)"
_WORDS_6 = re.compile(rf"\b{_NUMBER_WORDS}(?:[\s,;.\-]+(?:y\s+)?{_NUMBER_WORDS}\b){{5,}}", re.IGNORECASE)
_WORDS_3 = re.compile(rf"\b{_NUMBER_WORDS}(?:[\s,;.\-]+{_NUMBER_WORDS}\b){{2,}}", re.IGNORECASE)
PHONE_MASK = "[teléfono]"
NUMBER_MASK = "[número]"
PERSONAL_OMITTED = "[datos personales omitidos]"
SUMMARY_OMITTED = "[resumen omitido]"
PERSONAL_KEYS = frozenset({"customer_name", "customer_surnames", "phone", "slot_token"})


def redact_phones(text: str) -> str:
    """Para el registro técnico: tacha lo que parece un teléfono (6 o más cifras)."""
    text = _WORDS_6.sub(PHONE_MASK, text)
    return _PHONE_RUN.sub(PHONE_MASK, text)


def redact_numbers(text: str) -> str:
    """Para el registro de llamadas: tacha cualquier tramo de 3 o más cifras o números dichos."""
    text = _WORDS_3.sub(NUMBER_MASK, text)
    return _DIGITS_3.sub(NUMBER_MASK, text)


def _is_summary(text: str) -> bool:
    from voice_agent.state import SUMMARY_QUESTION_MARKERS, normalize_text

    norm = normalize_text(text)
    return "te resumo" in norm or any(m in norm for m in SUMMARY_QUESTION_MARKERS)


def _strip_personal(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_personal(v) for k, v in value.items() if k not in PERSONAL_KEYS}
    if isinstance(value, list):
        return [_strip_personal(v) for v in value]
    return value


def purge_old_logs(directory: str | Path, retention_days: int, now: float | None = None) -> int:
    """Borra los .jsonl más antiguos que la retención. Devuelve cuántos ha borrado."""
    path = Path(directory)
    if not path.is_dir():
        return 0
    limit = (now if now is not None else time.time()) - retention_days * 86400
    removed = 0
    with os.scandir(path) as entries:
        for entry in entries:
            if entry.is_file() and entry.name.endswith(".jsonl") and entry.stat().st_mtime < limit:
                try:
                    os.remove(entry.path)
                    removed += 1
                except OSError:
                    pass
    return removed


class CallLog:
    """Escribe eventos de UNA llamada. Si no hay directorio, no escribe nada."""

    def __init__(self, directory: str | None, conversation_id: str):
        self.conversation_id = conversation_id
        self.path: Path | None = None
        self._started = time.monotonic()
        self.usage = {"llm_turns": 0, "input_tokens": 0, "cache_read_input_tokens": 0,
                      "cache_creation_input_tokens": 0, "output_tokens": 0}
        if directory:
            folder = Path(directory)
            folder.mkdir(parents=True, exist_ok=True)
            day = datetime.now(UTC).strftime("%Y-%m-%d")
            self.path = folder / f"{day}_{conversation_id}.jsonl"

    def write(self, kind: str, **data: Any) -> None:
        record = {
            "t": round(time.monotonic() - self._started, 3),
            "at": datetime.now(UTC).isoformat(timespec="seconds"),
            "kind": kind,
            **data,
        }
        if self.path is None:
            return
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def user(self, text: str, personal: bool = False) -> None:
        self.write("user", text=PERSONAL_OMITTED if personal else redact_numbers(text))

    def bot(self, text: str, interrupted: bool = False) -> None:
        shown = SUMMARY_OMITTED if _is_summary(text) else redact_numbers(text)
        # chars: caracteres dichos (para estimar el coste del TTS), aunque el texto se omita.
        self.write("bot", text=shown, interrupted=interrupted, chars=len(text))

    def tool(self, event: dict[str, Any]) -> None:
        self.write("tool", **_strip_personal(event))

    def llm_usage(self, prompt: int, completion: int, cache_read: int | None, cache_creation: int | None) -> None:
        self.usage["llm_turns"] += 1
        self.usage["input_tokens"] += prompt or 0
        self.usage["output_tokens"] += completion or 0
        self.usage["cache_read_input_tokens"] += cache_read or 0
        self.usage["cache_creation_input_tokens"] += cache_creation or 0
        self.write("llm_usage", prompt_tokens=prompt, completion_tokens=completion,
                   cache_read_input_tokens=cache_read, cache_creation_input_tokens=cache_creation)

    def end(self, reason: str, **data: Any) -> None:
        self.write("end", reason=reason, duration_s=round(time.monotonic() - self._started, 1),
                   usage=self.usage, **data)


def server_event(directory: str | None, kind: str) -> None:
    """Eventos del servidor sin llamada asociada (desvíos, rechazos): sin CallSid ni números."""
    if not directory:
        return
    folder = Path(directory)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        now = datetime.now(UTC)
        with (folder / f"servidor-{now:%Y-%m-%d}.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"at": now.isoformat(timespec="seconds"), "kind": kind}) + "\n")
    except OSError:
        pass
