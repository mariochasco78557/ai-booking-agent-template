"""Estado de una llamada y paso de la conversación.

El paso (INICIO, HORAS, DATOS, CONFIRMAR, HECHA) lo decide ESTE código a partir
de lo que contesta el middleware, nunca el modelo. Ver (internal doc, not included in the template) §1.1 y §2.

Aquí no hay red ni Pipecat: todo es determinista y se prueba con tests.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Phase(str, Enum):
    INICIO = "INICIO"
    HORAS = "HORAS"
    DATOS = "DATOS"
    CONFIRMAR = "CONFIRMAR"
    HECHA = "HECHA"


EMPLOYEE_NAMES = {1: "Bruno", 2: "Olga", 3: "Ramón"}

# Resultados de la reserva que abren la recomprobación de la V6 (CREACIÓN DE LA CITA).
RECHECK_OUTCOMES = {"invalid_slot_token", "slot_token_expired", "slot_not_authorized"}

# Resultados TERMINALES para una hora bloqueada: tras ellos esa hora no se vuelve a
# enviar (G4) y se devuelve la misma respuesta. Los demás (invalid_customer_data,
# not_confirmed, write_disabled, upstream_error…) no gastan la hora en el middleware
# (voiceBookingService.ts) y permiten corregir y volver a crear.
TERMINAL_BOOK_OUTCOMES = {"confirmed", "uncertain", "already_booked_in_call", "slot_taken"} | RECHECK_OUTCOMES


def normalize_text(text: str) -> str:
    """Minúsculas y sin tildes, para detectar frases exactas del agente."""
    decomposed = unicodedata.normalize("NFD", text.lower())
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn")


# Frases del agente que el código reconoce (normalizadas).
SUMMARY_QUESTION_MARKERS = ("confirmas que quieres reservar",)
KEEP_OPEN_MARKERS = ("te lo miro ahora y te lo dejo apanado", "te lo reservo ya y asi te aseguras")
WHATSAPP_MARKERS = ("escribenos por whatsapp",)
# El agente pide datos personales: el siguiente turno del cliente no se registra.
PERSONAL_DATA_REQUEST_MARKERS = ("tu nombre", "apellidos", "telefono", "como te llamas", "a nombre de quien")


@dataclass
class Booking:
    booking_number: int | None
    max_bookings_per_call: int | None
    date: str | None
    time: str | None
    employee_name: str | None
    whatsapp_queued: bool


@dataclass
class CallState:
    conversation_id: str
    seq: int = 0

    # Disponibilidad
    last_availability_seq: int | None = None
    last_availability_outcome: str | None = None
    last_scan_restriction: dict[str, str] = field(default_factory=dict)
    requested_employee_id: int | None = None
    failures: dict[str, int] = field(default_factory=dict)

    # Bloqueo
    lock: dict[str, Any] | None = None
    lock_seq: int | None = None
    lock_consumed: bool = False

    # Resumen y creación
    summary_seq: int | None = None
    book_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_create_outcome: str | None = None
    last_create_seq: int | None = None
    recheck_used_in_cita: bool = False
    recheck_pending: str | None = None
    bookings: list[Booking] = field(default_factory=list)
    confirmed_seq: int | None = None

    # Conversación
    last_user_seq: int | None = None
    asked_personal_data: bool = False
    bot_spoke_since_user: bool = False
    keep_open_offered: bool = False
    whatsapp_said: bool = False
    silence_prompts: int = 0
    ended: bool = False

    # ── utilidades ─────────────────────────────────────────────────────────
    def _next(self) -> int:
        self.seq += 1
        return self.seq

    @property
    def live_lock(self) -> dict[str, Any] | None:
        if self.lock is not None and not self.lock_consumed:
            return self.lock
        return None

    @property
    def cita_number(self) -> int:
        """Número de la cita en curso (1, 2 o 3)."""
        return len(self.bookings) + 1

    # ── fase ───────────────────────────────────────────────────────────────
    @property
    def phase(self) -> Phase:
        avail = self.last_availability_seq or 0
        if self.confirmed_seq is not None and avail < self.confirmed_seq and (
            self.last_create_seq == self.confirmed_seq
        ):
            return Phase.HECHA
        lock = self.live_lock
        if lock is not None and (self.lock_seq or 0) > avail:
            if self.summary_seq is not None and self.summary_seq > (self.lock_seq or 0):
                return Phase.CONFIRMAR
            return Phase.DATOS
        if (
            self.last_create_seq is not None
            and self.last_create_seq > avail
            and self.last_create_outcome != "confirmed"
        ):
            # La creación ha fallado: sus reglas viven en CONFIRMAR hasta la siguiente consulta.
            return Phase.CONFIRMAR
        cita_start = self.confirmed_seq or 0
        if self.last_availability_seq is not None and self.last_availability_seq > cita_start:
            return Phase.HORAS
        return Phase.INICIO

    # ── eventos de herramientas ────────────────────────────────────────────
    def on_availability_result(self, args: dict[str, Any], body: dict[str, Any]) -> None:
        seq = self._next()
        action = args.get("action")
        outcome = str(body.get("outcome"))
        if action == "lock" and outcome == "locked" and isinstance(body.get("slot"), dict):
            self.lock = dict(body["slot"])
            self.lock_seq = seq
            self.lock_consumed = False
            self.recheck_pending = None
            self.failures.pop("lock", None)
            return
        self.last_availability_seq = seq
        self.last_availability_outcome = outcome
        if action == "scan":
            self.last_scan_restriction = {
                k: str(args[k]) for k in ("after_time", "before_time") if args.get(k)
            }
        elif action == "discover":
            self.last_scan_restriction = {}
        if action in ("discover", "scan") and args.get("employee_id"):
            try:
                self.requested_employee_id = int(args["employee_id"])
            except (TypeError, ValueError):
                pass
        path = "lock" if action == "lock" else "consulta"
        if outcome in ("agenda_unavailable", "authorization_unavailable", "invalid_request"):
            self.failures[path] = self.failures.get(path, 0) + 1
        elif outcome not in ("continuation_lost", "continuation_mismatch"):
            self.failures.pop(path, None)

    def on_book_result(self, slot_token: str, body: dict[str, Any]) -> None:
        seq = self._next()
        outcome = str(body.get("outcome"))
        if outcome in TERMINAL_BOOK_OUTCOMES:
            self.book_results[slot_token] = body
        self.last_create_outcome = outcome
        self.last_create_seq = seq
        if body.get("booked") is True and outcome == "confirmed":
            slot = self.lock or {}
            self.bookings.append(
                Booking(
                    booking_number=body.get("booking_number"),
                    max_bookings_per_call=body.get("max_bookings_per_call"),
                    date=slot.get("date"),
                    time=slot.get("time"),
                    employee_name=slot.get("employee_name"),
                    whatsapp_queued=body.get("whatsapp_confirmation") == "queued",
                )
            )
            self.lock_consumed = True
            self.confirmed_seq = seq
            self.summary_seq = None
            self.recheck_used_in_cita = False
            self.recheck_pending = None
            self.requested_employee_id = None
            self.last_scan_restriction = {}
            return
        if outcome in RECHECK_OUTCOMES or (
            outcome == "already_booked_in_call" and body.get("booking_limit_reached") is False
        ):
            self.lock_consumed = True
            if not self.recheck_used_in_cita:
                self.recheck_used_in_cita = True
                self.recheck_pending = outcome
            else:
                self.recheck_pending = None
        elif outcome == "slot_taken":
            self.lock_consumed = True
        elif outcome in ("invalid_customer_data", "not_confirmed"):
            # Hay que volver a pedir los datos (o el «sí») y repetir el resumen completo.
            self.summary_seq = None

    # ── eventos de conversación ────────────────────────────────────────────
    def on_user_text(self, text: str) -> None:
        if text.strip():
            self.last_user_seq = self._next()
            self.bot_spoke_since_user = False
            self.silence_prompts = 0
            self.asked_personal_data = False

    def user_turn_is_personal(self) -> bool:
        """El turno del cliente que llega ahora puede llevar nombre o teléfono (no se registra)."""
        return self.phase == Phase.DATOS or self.asked_personal_data

    def on_assistant_text(self, text: str) -> None:
        if not text.strip():
            return
        self.bot_spoke_since_user = True
        norm = normalize_text(text)
        is_summary = any(m in norm for m in SUMMARY_QUESTION_MARKERS)
        if is_summary and self.live_lock is not None:
            self.summary_seq = self._next()
        if any(m in norm for m in KEEP_OPEN_MARKERS):
            self.keep_open_offered = True
        if any(m in norm for m in WHATSAPP_MARKERS):
            self.whatsapp_said = True
        # El resumen nombra datos, pero no los pide: la respuesta («sí») sí se registra.
        self.asked_personal_data = not is_summary and any(m in norm for m in PERSONAL_DATA_REQUEST_MARKERS)

    # ── comprobaciones de la reserva (G3, G5) ──────────────────────────────
    def summary_said_after_lock(self) -> bool:
        return (
            self.live_lock is not None
            and self.summary_seq is not None
            and self.summary_seq > (self.lock_seq or 0)
        )

    def customer_answered_summary(self) -> bool:
        """G5: resumen dicho tras el último lock Y al menos un turno del cliente después."""
        return (
            self.summary_said_after_lock()
            and self.last_user_seq is not None
            and self.last_user_seq > (self.summary_seq or 0)
        )

    def data_already_given_in_cita(self) -> bool:
        """Hubo un resumen en esta cita: nombre, apellidos y teléfono ya están dichos."""
        if self.last_create_outcome == "invalid_customer_data" and self.summary_seq is None:
            return False
        return self.summary_seq is not None or self.recheck_pending is not None or (
            self.last_create_seq is not None
            and (self.confirmed_seq is None or self.last_create_seq > self.confirmed_seq)
        )
