"""Middleware FALSO para el simulador y los tests.

Imita las respuestas de ``/ai/voice/v2/availability`` y ``/ai/voice/v2/book`` con la
misma forma (``outcome``, ``message``, ``options``, ``slot``, ``booked``…). La agenda es
inventada y determinista; nada sale de esta máquina. No pretende reproducir toda la
lógica del middleware real (búsqueda de dos semanas, reparto, etc.), solo lo
necesario para recorrer los pasos de la conversación.

Se pueden forzar fallos con ``fail_next``: {"availability": "agenda_unavailable"} o
{"book": ["slot_taken"]} (una lista se consume en orden, un resultado por petición).
``now`` quita las horas de hoy ya empezadas; ``force_free``/``force_taken`` fijan horas
concretas («2026-10-07 12:30») para que un escenario sea reproducible.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from voice_agent.middleware_client import (
    AGENDA_UNAVAILABLE_MESSAGE,
    BOOKING_UNCERTAIN_MESSAGE,
    CallMeta,
    MiddlewareResult,
)
from voice_agent.state import EMPLOYEE_NAMES

CLOSED_WEEKDAYS = {0, 6}  # lunes, domingo
MORNING = [f"{h:02d}:{m:02d}" for h in range(9, 14) for m in (0, 30)]
AFTERNOON = [f"{h:02d}:{m:02d}" for h in range(14, 20) for m in (0, 30)] + ["20:00"]
EMPLOYEES = (1, 2, 3)
PHONE_RE = re.compile(r"^(\+34)?[6789]\d{8}$")
HOURS_ES = {1: "la una", 2: "las dos", 3: "las tres", 4: "las cuatro", 5: "las cinco", 6: "las seis",
            7: "las siete", 8: "las ocho", 9: "las nueve", 10: "las diez", 11: "las once", 12: "las doce"}
DAYS_ES = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")


def spoken_time(hhmm: str) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    h12 = h - 12 if h > 12 else h
    base = HOURS_ES[h12]
    return base + (" y media" if m == 30 else "")


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " y " + items[-1]


def _taken(day: date, hhmm: str) -> bool:
    # Agenda inventada: aproximadamente un tercio de las horas ocupadas.
    return (day.toordinal() * 7 + int(hhmm[:2]) * 3 + int(hhmm[3:])) % 3 == 0


def _employee_for(day: date, hhmm: str) -> int:
    return EMPLOYEES[(day.toordinal() + int(hhmm[:2])) % 3]


@dataclass
class _Conversation:
    page: list[dict[str, Any]] = field(default_factory=list)
    remaining: list[dict[str, Any]] = field(default_factory=list)
    last_lock_token: str | None = None
    tokens: dict[str, dict[str, Any]] = field(default_factory=dict)
    bookings: int = 0
    booked_tokens: set[str] = field(default_factory=set)
    service_id: Any = None


class FakeMiddleware:
    max_bookings_per_call = 3

    def __init__(
        self,
        today: date | None = None,
        fail_next: dict[str, Any] | None = None,
        now: datetime | None = None,
        force_free: set[str] | None = None,
        force_taken: set[str] | None = None,
    ):
        self.now = now
        self.today = today or (now.date() if now else datetime.now().date())
        self.fail_next: dict[str, Any] = dict(fail_next or {})
        self.force_free = set(force_free or ())
        self.force_taken = set(force_taken or ())
        self.confirmed: list[dict[str, Any]] = []
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self._conv: dict[str, _Conversation] = {}
        self.taken: set[tuple[date, str]] = set()

    def _pop_fail(self, kind: str) -> str | None:
        value = self.fail_next.get(kind)
        if isinstance(value, list):
            outcome = value.pop(0) if value else None
            if not value:
                self.fail_next.pop(kind, None)
            return outcome
        return self.fail_next.pop(kind, None)

    def _is_taken(self, day: date, hhmm: str) -> bool:
        key = f"{day.isoformat()} {hhmm}"
        if key in self.force_free and (day, hhmm) not in self.taken:
            return False
        if key in self.force_taken or (day, hhmm) in self.taken:
            return True
        if self.now is not None and day == self.now.date() and hhmm <= self.now.strftime("%H:%M"):
            return True
        return _taken(day, hhmm)

    def _c(self, conversation_id: str) -> _Conversation:
        return self._conv.setdefault(conversation_id, _Conversation())

    # ── agenda ──────────────────────────────────────────────────────────────
    def free(self, day: date, period: str | None, employee_id: int | None = None) -> list[dict[str, Any]]:
        if day.weekday() in CLOSED_WEEKDAYS or day < self.today:
            return []
        hours = MORNING if period == "morning" else AFTERNOON if period == "afternoon" else MORNING + AFTERNOON
        out = []
        for hhmm in hours:
            if self._is_taken(day, hhmm):
                continue
            emp = employee_id or _employee_for(day, hhmm)
            out.append({"date": day.isoformat(), "time": hhmm, "employee_id": emp})
        return out

    def _offer(self, conv: _Conversation, slots: list[dict[str, Any]], with_day: bool, named: int | None) -> dict[str, Any]:
        page, conv.remaining = slots[:3], slots[3:]
        conv.page = page
        options = [{"option_index": i + 1, "date": s["date"], "time": s["time"]} for i, s in enumerate(page)]

        def label(s):
            t = spoken_time(s["time"])
            if with_day:
                d = date.fromisoformat(s["date"])
                return f"el {DAYS_ES[d.weekday()]} {d.day} a {t}"
            return t

        who = f" con {EMPLOYEE_NAMES[named]}" if named else ""
        message = f"Tengo{who} {_join([label(s) for s in page])}. ¿Cuál prefieres?"
        return {"outcome": "options_available", "available": True, "message": message, "options": options,
                "has_more": bool(conv.remaining), "external_mutation": False}

    def _no_availability(self, day: date) -> dict[str, Any]:
        nxt = day + timedelta(days=1)
        while nxt.weekday() in CLOSED_WEEKDAYS:
            nxt += timedelta(days=1)
        closed = day.weekday() in CLOSED_WEEKDAYS
        why = "Ese día la peluquería está cerrada" if closed else "Ese día no me queda hueco"
        return {"outcome": "no_availability", "available": False,
                "message": f"{why}. ¿Te miro el {DAYS_ES[nxt.weekday()]} {nxt.day}?",
                "next_search_from": nxt.isoformat(), "external_mutation": False}

    # ── API ─────────────────────────────────────────────────────────────────
    async def availability(self, conversation_id: str, args: dict[str, Any]) -> MiddlewareResult:
        self.requests.append(("availability", {"conversation_id": conversation_id, **args}))
        action = args.get("action")
        meta = CallMeta(path="/ai/voice/v2/availability", action=str(action), http_status=200)
        forced = self._pop_fail("availability")
        if forced:
            body = {"outcome": forced, "available": False, "message": AGENDA_UNAVAILABLE_MESSAGE}
        else:
            body = self._availability(self._c(conversation_id), args)
        meta.outcome = body["outcome"]
        return MiddlewareResult(body, meta)

    def _availability(self, conv: _Conversation, args: dict[str, Any]) -> dict[str, Any]:
        action = args.get("action")
        if action in ("discover", "scan") and args.get("service_id") is not None:
            conv.service_id = args.get("service_id")
        try:
            if action == "discover":
                day = date.fromisoformat(str(args["date"]))
                emp = args.get("employee_id")
                slots = self.free(day, args.get("time_period"), emp)
                pref = args.get("preferred_time")
                if pref:
                    exact = [s for s in slots if s["time"] == pref]
                    if exact:
                        conv.page, conv.remaining = exact, []
                        return {"outcome": "options_available", "available": True,
                                "message": f"A {spoken_time(pref)} tengo hueco. ¿Te la aparto?",
                                "options": [{"option_index": 1, "date": exact[0]["date"], "time": pref}],
                                "has_more": False, "external_mutation": False}
                    slots = sorted(slots, key=lambda s: abs(int(s["time"][:2]) * 60 + int(s["time"][3:])
                                                            - int(pref[:2]) * 60 - int(pref[3:])))[:2]
                    if slots:
                        result = self._offer(conv, slots, False, emp)
                        result["message"] = f"A {spoken_time(pref)} no puedo. " + result["message"]
                        return result
                if not slots:
                    return self._no_availability(day)
                return self._offer(conv, slots, False, emp)
            if action == "scan":
                start = date.fromisoformat(str(args.get("date_from") or (self.today + timedelta(days=1)).isoformat()))
                days = int(args.get("days") or 7)
                after, before = args.get("after_time"), args.get("before_time")
                found: list[dict[str, Any]] = []
                for i in range(days):
                    day_slots = [s for s in self.free(start + timedelta(days=i), args.get("time_period"), args.get("employee_id"))
                                 if (not after or s["time"] >= after) and (not before or s["time"] < before)]
                    found.extend(day_slots[:2])
                if not found:
                    return {"outcome": "no_availability", "available": False,
                            "message": "En esos días no me queda nada con esa condición. ¿Te miro la semana siguiente?",
                            "next_search_from": (start + timedelta(days=days)).isoformat(), "external_mutation": False}
                return self._offer(conv, found, True, args.get("employee_id"))
            if action == "more":
                if not conv.page:
                    return {"outcome": "continuation_lost", "available": False, "message": ""}
                if not conv.remaining:
                    return {"outcome": "no_more_options", "available": False,
                            "message": "No me quedan más horas en esa franja. ¿Te miro la otra franja u otro día?"}
                return self._offer(conv, conv.remaining, False, None)
            if action == "lock":
                idx = int(args.get("option_index") or 0)
                if not 1 <= idx <= len(conv.page):
                    return {"outcome": "option_not_found", "locked": False, "message": "Esa opción ya no está."}
                s = conv.page[idx - 1]
                emp = int(args.get("preferred_employee_id") or s["employee_id"])
                token = "tk1.fake-" + uuid.uuid4().hex[:16]
                slot = {"date": s["date"], "time": s["time"], "reservation_date": f"{s['date']} {s['time']}:00",
                        "employee_id": emp, "employee_name": EMPLOYEE_NAMES[emp], "slot_token": token}
                conv.tokens[token] = slot
                conv.last_lock_token = token
                return {"outcome": "locked", "locked": True,
                        "message": f"Te lo dejo a {spoken_time(s['time'])} con {EMPLOYEE_NAMES[emp]}.",
                        "slot": slot, "external_mutation": False}
        except (KeyError, ValueError, TypeError):
            pass
        return {"outcome": "invalid_request", "available": False,
                "message": "No he entendido bien el día o la franja. ¿Me lo repites?"}

    async def book(self, conversation_id: str, args: dict[str, Any]) -> MiddlewareResult:
        self.requests.append(("book", {"conversation_id": conversation_id, **args}))
        meta = CallMeta(path="/ai/voice/v2/book", action="book", http_status=200)
        conv = self._c(conversation_id)
        forced = self._pop_fail("book")
        token = args.get("slot_token")
        if forced == "uncertain":
            body = {"booked": False, "outcome": "uncertain", "message": BOOKING_UNCERTAIN_MESSAGE,
                    "external_mutation": None, "mutation_status": "unknown"}
        elif forced == "slot_taken" and token in conv.tokens:
            slot = conv.tokens[token]
            self.taken.add((date.fromisoformat(slot["date"]), slot["time"]))
            body = {"booked": False, "outcome": "slot_taken", "message": "Esa hora se acaba de ocupar."}
        elif forced:
            body = {"booked": False, "outcome": forced, "message": "No he podido hacer la cita."}
        elif token not in conv.tokens or token != conv.last_lock_token:
            body = {"booked": False, "outcome": "slot_not_authorized" if token in conv.tokens else "invalid_slot_token",
                    "message": "Esa hora no está apartada."}
        elif args.get("confirmed_by_customer") is not True:
            body = {"booked": False, "outcome": "not_confirmed", "message": "Falta la confirmación."}
        elif not str(args.get("customer_name") or "").strip() or not str(args.get("customer_surnames") or "").strip() \
                or not PHONE_RE.match(str(args.get("phone") or "")):
            body = {"booked": False, "outcome": "invalid_customer_data", "message": "Me falta algún dato."}
        elif token in conv.booked_tokens or conv.bookings >= self.max_bookings_per_call:
            body = {"booked": False, "outcome": "already_booked_in_call", "booking_limit_reached": True,
                    "max_bookings_per_call": self.max_bookings_per_call,
                    "message": "En esta llamada ya hay el máximo de citas."}
        else:
            slot = conv.tokens[token]
            conv.bookings += 1
            conv.booked_tokens.add(token)
            self.confirmed.append({**slot, "phone": args.get("phone"), "service_id": conv.service_id})
            self.taken.add((date.fromisoformat(slot["date"]), slot["time"]))
            d = date.fromisoformat(slot["date"])
            body = {"booked": True, "outcome": "confirmed", "external_mutation": True, "mutation_status": "confirmed",
                    "message": f"Listo, la reserva queda confirmada para el {DAYS_ES[d.weekday()]} {d.day} a las {slot['time']}.",
                    "booking_number": conv.bookings, "max_bookings_per_call": self.max_bookings_per_call,
                    "whatsapp_confirmation": "queued"}
        meta.outcome = body["outcome"]
        return MiddlewareResult(body, meta)

    async def aclose(self) -> None:
        return None
