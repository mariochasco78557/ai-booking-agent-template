"""Herramientas que ve el modelo y su ejecución.

El modelo ve tres herramientas, SIEMPRE las mismas (para no romper la caché de
prompt, ver (internal doc, not included in the template) §1.1): ``disponibilidad``, ``reserva`` y ``end_call``.

Lo que el modelo NO ve y pone el código:
- ``conversation_id`` y ``agent_profile`` (G1);
- ``slot_token``: siempre el del último ``locked`` (G2).

Protecciones de la reserva:
- G3: sin ``locked`` vigente no se llama al middleware;
- G4: una sola creación por ``slot_token`` (si se repite, se devuelve la respuesta anterior);
- G5: sin la pregunta final del resumen dicha tras el último lock, no se crea;
- G6: una petición ya enviada termina y se registra aunque el cliente interrumpa.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from voice_agent.middleware_client import MiddlewareAPI, MiddlewareResult
from voice_agent.state import CallState

TOOL_AVAILABILITY = "disponibilidad"
TOOL_BOOK = "reserva"
TOOL_END_CALL = "end_call"

_HHMM = {"type": "string", "pattern": r"^\d{2}:\d{2}$"}
_DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": TOOL_AVAILABILITY,
        "description": (
            "Agenda del salón. action=discover: horas libres de UN día y una franja. "
            "action=more: las siguientes horas de la misma pregunta (no lleva más campos). "
            "action=scan: varios días a la vez (hasta 7) o con condición horaria; el servidor filtra. "
            "action=lock: aparta una opción (1, 2 o 3) de la página más reciente y devuelve el slot. "
            "Responde siempre con outcome y message. Solo lectura: nunca crea citas."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["discover", "lock", "more", "scan"]},
                "service_id": {
                    "type": "integer",
                    "enum": [0, 1, 2],
                    "description": "discover y scan. 0 barba, 1 corte de pelo, 2 corte y barba.",
                },
                "date": {**_DATE, "description": "discover. Día pedido, YYYY-MM-DD."},
                "time_period": {
                    "type": "string",
                    "enum": ["morning", "afternoon"],
                    "description": "discover (y scan si ha dicho mañana o tarde).",
                },
                "preferred_time": {
                    **_HHMM,
                    "description": "discover, o scan con days 1. Hora que ha dicho el cliente, HH:mm de 24 h.",
                },
                "employee_id": {
                    "type": "integer",
                    "description": "discover y scan, solo si el cliente ha pedido un profesional. Bruno 1, Olga 2, Ramón 3.",
                },
                "date_from": {**_DATE, "description": "scan. Primer día de la ventana."},
                "days": {"type": "integer", "minimum": 1, "maximum": 7, "description": "scan. Días de la ventana."},
                "after_time": {**_HHMM, "description": "scan. Solo horas iguales o posteriores."},
                "before_time": {**_HHMM, "description": "scan. Solo horas anteriores."},
                "option_index": {
                    "type": "integer",
                    "enum": [1, 2, 3],
                    "description": "lock. Número de la opción en la página más reciente.",
                },
                "preferred_employee_id": {
                    "type": "integer",
                    "description": "lock, solo en la recomprobación de CREACIÓN. Nunca en un lock normal.",
                },
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
    {
        "name": TOOL_BOOK,
        "description": (
            "Crea la cita de la hora del ÚLTIMO lock locked. El código pone el token de esa hora. "
            "Una sola vez y solo tras un sí claro al resumen completo. "
            "La cita existe solo si booked es true y outcome es confirmed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "customer_name": {"type": "string", "description": "Nombre tal como lo ha dicho."},
                "customer_surnames": {"type": "string", "description": "Apellidos tal como los ha dicho."},
                "phone": {
                    "type": "string",
                    "description": "Teléfono español de 9 cifras que empieza por 6, 7, 8 o 9.",
                },
                "confirmed_by_customer": {
                    "type": "boolean",
                    "description": "true solo tras un sí claro al resumen completo.",
                },
            },
            "required": ["customer_name", "customer_surnames", "phone", "confirmed_by_customer"],
            "additionalProperties": False,
        },
    },
    {
        "name": TOOL_END_CALL,
        "description": "Cuelga la llamada. Solo justo después de tu frase de despedida. No consulta ni reserva nada.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]

# Respuestas locales (no salen del agente). Llevan local_guard para distinguirlas en el registro.
LOCK_REQUIRED = {
    "booked": False,
    "outcome": "lock_required",
    "local_guard": True,
    "instruction": (
        "No hay ninguna hora bloqueada: la cita NO está hecha. Haz lock de la hora que ha "
        "elegido el cliente antes de crear."
    ),
}
SUMMARY_REQUIRED = {
    "booked": False,
    "outcome": "not_confirmed",
    "local_guard": True,
    "instruction": (
        "La cita NO está hecha: todavía no has dicho el resumen completo, terminado con la "
        "pregunta final, después del último lock, o el cliente aún no ha contestado. Dilo y "
        "espera un sí claro."
    ),
}


def tool_result_text(result: dict[str, Any]) -> str:
    """JSON compacto que recibe el modelo."""
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


class ToolExecutor:
    """Ejecuta las herramientas de UNA llamada."""

    def __init__(
        self,
        state: CallState,
        middleware: MiddlewareAPI,
        on_tool_event: Callable[[dict[str, Any]], None] | None = None,
        on_end_call: Callable[[], Awaitable[None]] | None = None,
    ):
        self.state = state
        self.middleware = middleware
        self._on_tool_event = on_tool_event or (lambda _event: None)
        self._on_end_call = on_end_call
        self._pending_books: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self._background: set[asyncio.Task[Any]] = set()

    def _record(self, tool: str, args: dict[str, Any], result: MiddlewareResult | None, body: dict[str, Any]) -> None:
        event: dict[str, Any] = {
            "tool": tool,
            "action": args.get("action", tool),
            "outcome": body.get("outcome"),
            "phase_after": self.state.phase.value,
        }
        if result is not None:
            event.update(
                http_status=result.meta.http_status,
                latency_ms=result.meta.latency_ms,
                transport_error=result.meta.transport_error,
            )
        if body.get("local_guard"):
            event["local_guard"] = True
        if body.get("replayed"):
            event["replayed"] = True
        # Solo campos no personales de la petición (nunca nombre ni teléfono).
        event["args"] = {
            k: v
            for k, v in args.items()
            if k not in ("customer_name", "customer_surnames", "phone")
        }
        self._on_tool_event(event)

    async def execute(self, name: str, args: dict[str, Any] | None) -> dict[str, Any]:
        args = dict(args or {})
        if name == TOOL_AVAILABILITY:
            return await self._availability(args)
        if name == TOOL_BOOK:
            return await self._book(args)
        if name == TOOL_END_CALL:
            self.state.ended = True
            self._record(name, args, None, {"outcome": "ending"})
            if self._on_end_call is not None:
                await self._on_end_call()
            return {"outcome": "ending"}
        return {"outcome": "invalid_request", "message": "", "instruction": "Herramienta desconocida."}

    async def _availability(self, args: dict[str, Any]) -> dict[str, Any]:
        async def run() -> tuple[MiddlewareResult, dict[str, Any]]:
            result = await self.middleware.availability(self.state.conversation_id, args)
            self.state.on_availability_result(args, result.body)
            self._record(TOOL_AVAILABILITY, args, result, result.body)
            return result, result.body

        task = asyncio.ensure_future(run())
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        _, body = await asyncio.shield(task)  # G6: termina aunque cancelen al modelo
        return body

    async def _book(self, args: dict[str, Any]) -> dict[str, Any]:
        lock = self.state.live_lock
        last_token = (self.state.lock or {}).get("slot_token")
        # G4: misma hora ya enviada → misma respuesta, sin volver a llamar.
        if isinstance(last_token, str) and last_token in self.state.book_results:
            body = {**self.state.book_results[last_token], "replayed": True}
            self._record(TOOL_BOOK, args, None, body)
            return body
        if isinstance(last_token, str) and last_token in self._pending_books:
            return {**(await asyncio.shield(self._pending_books[last_token])), "replayed": True}
        # G3
        if lock is None or not isinstance(lock.get("slot_token"), str):
            self._record(TOOL_BOOK, args, None, LOCK_REQUIRED)
            return dict(LOCK_REQUIRED)
        # G5
        if args.get("confirmed_by_customer") is not True or not self.state.customer_answered_summary():
            self._record(TOOL_BOOK, args, None, SUMMARY_REQUIRED)
            return dict(SUMMARY_REQUIRED)

        token: str = lock["slot_token"]
        payload = {
            "customer_name": args.get("customer_name"),
            "customer_surnames": args.get("customer_surnames"),
            "phone": args.get("phone"),
            "slot_token": token,  # G2
            "confirmed_by_customer": True,
        }

        async def run() -> dict[str, Any]:
            result = await self.middleware.book(self.state.conversation_id, payload)
            self.state.on_book_result(token, result.body)
            self._record(TOOL_BOOK, args, result, result.body)
            return result.body

        task = asyncio.ensure_future(run())
        self._pending_books[token] = task
        task.add_done_callback(lambda _t: self._pending_books.pop(token, None))
        return await asyncio.shield(task)  # G6

    async def wait_background(self) -> None:
        """Espera a las peticiones en vuelo (al colgar), para no perder su registro."""
        pending = list(self._background) + list(self._pending_books.values())
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
