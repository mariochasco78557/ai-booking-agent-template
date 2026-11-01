"""Forma de cada petición a Anthropic (sin Pipecat, para poder usarla en el simulador).

Ver llm.py y (internal doc, not included in the template) §1.2.
"""

from __future__ import annotations

import copy
from typing import Any

CONNECTED_MARK = "[llamada conectada]"
CACHE = {"type": "ephemeral"}


def shape_request(
    params: dict[str, Any],
    system_blocks: list[str],
    guidance: str,
) -> dict[str, Any]:
    """Aplica los tres cambios a los parámetros que Pipecat iba a mandar.

    Función pura (sin red) para poder probarla.
    """
    shaped = dict(params)
    shaped["system"] = [{"type": "text", "text": text, "cache_control": dict(CACHE)} for text in system_blocks]

    messages = list(shaped.get("messages") or [])
    if not messages or messages[0].get("role") != "user":
        messages.insert(0, {"role": "user", "content": [{"type": "text", "text": CONNECTED_MARK}]})

    guide_block = {"type": "text", "text": guidance}
    last = messages[-1]
    if last.get("role") == "user":
        last = copy.deepcopy(last)  # nunca tocar el objeto del contexto
        content = last.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        last["content"] = list(content or []) + [guide_block]
        messages[-1] = last
    else:
        messages.append({"role": "user", "content": [guide_block]})
    shaped["messages"] = messages
    return shaped


def count_cache_breakpoints(params: dict[str, Any]) -> int:
    count = sum(1 for b in params.get("system") or [] if isinstance(b, dict) and "cache_control" in b)
    for message in params.get("messages") or []:
        content = message.get("content")
        if isinstance(content, list):
            count += sum(1 for b in content if isinstance(b, dict) and "cache_control" in b)
    for tool in params.get("tools") or []:
        if isinstance(tool, dict) and "cache_control" in tool:
            count += 1
    return count
