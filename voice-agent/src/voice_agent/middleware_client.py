"""Cliente HTTP del middleware de Demo Salon.

Habla EXACTAMENTE el contrato que hoy usa ElevenLabs
(``docs/elevenlabs/TOOL_SCHEMAS_BALANCED_V5.json``):

- ``POST /ai/voice/v2/availability`` con ``X-AI-Webhook-Secret``.
- ``POST /ai/voice/v2/book`` con ``X-AI-Webhook-Secret`` y, si está configurado,
  ``X-AI-Booking-Secret``.
- Cuerpos JSON con ``conversation_id`` y ``agent_profile: "v5"`` (constante, la pone
  este código; el modelo nunca la ve) más los campos de cada acción.

El middleware contesta SIEMPRE 200 con un ``outcome``. Cuando no hay respuesta
legible (red caída, tiempo agotado, 401, cuerpo que no es JSON), este cliente
devuelve un ``outcome`` del mismo catálogo para que el modelo siga la V6:

- consulta o bloqueo → ``agenda_unavailable`` («Ahora mismo no puedo consultar la
  agenda.», la misma frase que usa el middleware);
- reserva → ``uncertain`` (no se sabe si se ha creado: nunca se afirma ni se repite).

Nunca se reintenta una petición: la V6 prohíbe repetir llamadas que ya han
contestado y el incidente del 30/08 vino justo de reintentos en la reserva.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

AVAILABILITY_PATH = "/ai/voice/v2/availability"
BOOK_PATH = "/ai/voice/v2/book"
WEBHOOK_SECRET_HEADER = "X-AI-Webhook-Secret"
BOOKING_SECRET_HEADER = "X-AI-Booking-Secret"

ACTIONS = ("discover", "lock", "more", "scan")

# Campos que cada acción puede llevar además de conversation_id, agent_profile y action.
# `more` no lleva nada más (V6, OTROS HORARIOS: «more con solo conversation_id y action»).
ACTION_FIELDS: dict[str, tuple[str, ...]] = {
    "discover": ("service_id", "date", "time_period", "preferred_time", "employee_id"),
    "scan": (
        "service_id",
        "date_from",
        "days",
        "time_period",
        "after_time",
        "before_time",
        "preferred_time",
        "employee_id",
    ),
    "more": (),
    "lock": ("option_index", "preferred_employee_id"),
}

BOOK_FIELDS = (
    "customer_name",
    "customer_surnames",
    "phone",
    "slot_token",
    "confirmed_by_customer",
)

# Frases exactas del middleware (src/utils/balancedPhrasing.ts), para los casos en
# que no hay respuesta del middleware y el modelo necesita un `message` igual.
AGENDA_UNAVAILABLE_MESSAGE = "Ahora mismo no puedo consultar la agenda."
BOOKING_UNCERTAIN_MESSAGE = (
    "No he podido confirmar si la cita ha quedado hecha. Por mi parte no está confirmada."
)

_PHONE_SEPARATORS = re.compile(r"[\s.\-()]")


def normalize_phone(raw: Any) -> Any:
    """Quita espacios, puntos, guiones y paréntesis. No inventa ni añade cifras."""
    if not isinstance(raw, str):
        return raw
    return _PHONE_SEPARATORS.sub("", raw)


@dataclass
class CallMeta:
    """Lo que se registra de cada petición (sin datos personales)."""

    path: str
    action: str
    http_status: int | None = None
    latency_ms: int = 0
    transport_error: str | None = None
    outcome: str | None = None


@dataclass
class MiddlewareResult:
    body: dict[str, Any]
    meta: CallMeta = field(default_factory=lambda: CallMeta(path="", action=""))


class MiddlewareAPI(Protocol):
    """Lo que el agente necesita del middleware (real o falso)."""

    async def availability(self, conversation_id: str, args: dict[str, Any]) -> MiddlewareResult: ...

    async def book(self, conversation_id: str, args: dict[str, Any]) -> MiddlewareResult: ...

    async def aclose(self) -> None: ...


def build_availability_body(
    conversation_id: str, agent_profile: str, args: dict[str, Any]
) -> dict[str, Any]:
    """Cuerpo de /availability: solo los campos que admite la acción pedida."""
    action = args.get("action")
    body: dict[str, Any] = {
        "conversation_id": conversation_id,
        "agent_profile": agent_profile,
        "action": action,
    }
    allowed = ACTION_FIELDS.get(action if isinstance(action, str) else "", ())
    for key in allowed:
        value = args.get(key)
        if value is not None and value != "":
            body[key] = value
    return body


def build_book_body(conversation_id: str, agent_profile: str, args: dict[str, Any]) -> dict[str, Any]:
    """Cuerpo de /book: los siete campos del contrato, nada más."""
    body: dict[str, Any] = {"conversation_id": conversation_id, "agent_profile": agent_profile}
    for key in BOOK_FIELDS:
        if key in args:
            body[key] = normalize_phone(args[key]) if key == "phone" else args[key]
    return body


def availability_failure(kind: str) -> dict[str, Any]:
    return {
        "outcome": "agenda_unavailable",
        "available": False,
        "message": AGENDA_UNAVAILABLE_MESSAGE,
        "external_mutation": False,
        "transport_error": kind,
    }


def book_failure(kind: str) -> dict[str, Any]:
    return {
        "booked": False,
        "outcome": "uncertain",
        "message": BOOKING_UNCERTAIN_MESSAGE,
        "external_mutation": None,
        "mutation_status": "unknown",
        "transport_error": kind,
    }


class MiddlewareClient:
    """Cliente real (httpx). Una instancia por proceso; conexiones reutilizadas."""

    def __init__(
        self,
        base_url: str,
        webhook_secret: str,
        booking_secret: str = "",
        agent_profile: str = "v5",
        availability_timeout_s: float = 10.0,
        book_timeout_s: float = 8.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._webhook_secret = webhook_secret
        self._booking_secret = booking_secret
        self._agent_profile = agent_profile
        self._availability_timeout = availability_timeout_s
        self._book_timeout = book_timeout_s
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            transport=transport,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            follow_redirects=False,
        )

    def _headers(self, booking: bool) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            WEBHOOK_SECRET_HEADER: self._webhook_secret,
        }
        if booking and self._booking_secret:
            headers[BOOKING_SECRET_HEADER] = self._booking_secret
        return headers

    async def _post(
        self, path: str, body: dict[str, Any], timeout: float, booking: bool, action: str
    ) -> tuple[dict[str, Any] | None, CallMeta]:
        meta = CallMeta(path=path, action=action)
        started = time.monotonic()
        try:
            response = await self._client.post(
                path, json=body, headers=self._headers(booking), timeout=timeout
            )
            meta.http_status = response.status_code
            if response.status_code != 200:
                meta.transport_error = f"http_{response.status_code}"
                return None, meta
            data = response.json()
            if not isinstance(data, dict):
                meta.transport_error = "invalid_body"
                return None, meta
            return data, meta
        except httpx.TimeoutException:
            meta.transport_error = "timeout"
            return None, meta
        except httpx.HTTPError:
            meta.transport_error = "network"
            return None, meta
        except ValueError:
            meta.transport_error = "invalid_json"
            return None, meta
        finally:
            meta.latency_ms = int((time.monotonic() - started) * 1000)

    async def availability(self, conversation_id: str, args: dict[str, Any]) -> MiddlewareResult:
        body = build_availability_body(conversation_id, self._agent_profile, args)
        data, meta = await self._post(
            AVAILABILITY_PATH, body, self._availability_timeout, False, str(body.get("action"))
        )
        if data is None:
            data = availability_failure(meta.transport_error or "unknown")
        meta.outcome = str(data.get("outcome"))
        return MiddlewareResult(body=data, meta=meta)

    async def book(self, conversation_id: str, args: dict[str, Any]) -> MiddlewareResult:
        body = build_book_body(conversation_id, self._agent_profile, args)
        data, meta = await self._post(BOOK_PATH, body, self._book_timeout, True, "book")
        if data is None:
            data = book_failure(meta.transport_error or "unknown")
        meta.outcome = str(data.get("outcome"))
        return MiddlewareResult(body=data, meta=meta)

    async def aclose(self) -> None:
        await self._client.aclose()
