"""Twilio: firma, TwiML y límite de llamadas a la vez.

- La firma ``X-Twilio-Signature`` se comprueba con el ``RequestValidator`` oficial
  de Twilio contra la URL PÚBLICA configurada (``PUBLIC_BASE_URL``), nunca contra
  cabeceras que pueda inventar quien llama.
- El WebSocket no lleva firma propia que podamos exigir, así que cada llamada
  aceptada recibe una ficha aleatoria de un solo uso dentro del TwiML
  (``<Parameter name="token">``). Twilio la devuelve en el mensaje ``start``; sin
  ella el WebSocket se cierra antes de abrir ningún servicio de pago.
- ``CallSlots`` cuenta llamadas en curso + reservas recientes. Un solo proceso.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass

from twilio.request_validator import RequestValidator
from twilio.twiml.voice_response import Connect, VoiceResponse

STREAM_TOKEN_PARAM = "token"


def valid_twilio_signature(auth_token: str, url: str, params: dict[str, str], signature: str | None) -> bool:
    if not auth_token or not signature:
        return False
    return bool(RequestValidator(auth_token).validate(url, params, signature))


def connect_twiml(ws_url: str, token: str) -> str:
    response = VoiceResponse()
    connect = Connect()
    stream = connect.stream(url=ws_url)
    stream.parameter(name=STREAM_TOKEN_PARAM, value=token)
    response.append(connect)
    return str(response)


def overflow_twiml(action: str, dial_number: str) -> str:
    """Desbordamiento o agente apagado: desviar al número de respaldo o dar ocupado."""
    response = VoiceResponse()
    if action == "dial" and dial_number:
        response.dial(dial_number)
    else:
        response.reject(reason="busy")
    return str(response)


@dataclass
class _Slot:
    token: str
    active: bool
    expires_at: float


class CallSlots:
    """Llamadas a la vez. Las reservas sin WebSocket caducan a los ``pending_ttl_s``."""

    def __init__(self, max_calls: int, pending_ttl_s: float = 20.0, clock: Callable[[], float] = time.monotonic):
        self.max_calls = max_calls
        self.pending_ttl_s = pending_ttl_s
        self._clock = clock
        self._slots: dict[str, _Slot] = {}

    def _expire(self) -> None:
        now = self._clock()
        for sid in [s for s, slot in self._slots.items() if not slot.active and slot.expires_at <= now]:
            del self._slots[sid]

    @property
    def in_use(self) -> int:
        self._expire()
        return len(self._slots)

    @property
    def active(self) -> int:
        self._expire()
        return sum(1 for s in self._slots.values() if s.active)

    def reserve(self, call_sid: str) -> str | None:
        """Reserva sitio para una llamada. Devuelve la ficha, o None si no cabe."""
        self._expire()
        existing = self._slots.get(call_sid)
        if existing is not None and not existing.active:
            # Twilio puede repetir el POST de la misma llamada: misma ficha.
            existing.expires_at = self._clock() + self.pending_ttl_s
            return existing.token
        if existing is not None or len(self._slots) >= self.max_calls:
            return None
        token = secrets.token_urlsafe(24)
        self._slots[call_sid] = _Slot(token=token, active=False, expires_at=self._clock() + self.pending_ttl_s)
        return token

    def activate(self, call_sid: str, token: str | None) -> bool:
        """El WebSocket de esa llamada ha llegado con su ficha: pasa a activa (un solo uso)."""
        self._expire()
        slot = self._slots.get(call_sid)
        if slot is None or slot.active or not token:
            return False
        if not secrets.compare_digest(slot.token, token):
            return False
        slot.active = True
        return True

    def release(self, call_sid: str) -> None:
        self._slots.pop(call_sid, None)
