"""Transiciones de pasos y protecciones de la reserva (G1–G6)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from voice_agent.middleware_client import CallMeta, MiddlewareResult
from voice_agent.state import CallState, Phase
from voice_agent.tools import TOOL_AVAILABILITY, TOOL_BOOK, TOOL_END_CALL, TOOL_SCHEMAS, ToolExecutor

CONV = "tw_CAtest000000000000000000000000001"
SLOT = {
    "date": "2026-10-07",
    "time": "10:00",
    "reservation_date": "2026-10-07 10:00:00",
    "employee_id": 2,
    "employee_name": "Olga",
    "slot_token": "tk1.A",
}
PAGE = {
    "outcome": "options_available",
    "message": "Ese día me quedan las diez, las once y las doce. ¿Cuál prefieres?",
    "options": [{"option_index": 1, "date": "2026-10-07", "time": "10:00"}],
}
SUMMARY = (
    "Te resumo: corte de pelo, el miércoles a las diez de la mañana, con Olga, a nombre de "
    "Prueba Uno, teléfono seis, cero, cero; cero, cero, cero; uno, dos, tres. ¿Confirmas que "
    "quieres reservar esta cita con estos datos o prefieres que mire otro profesional?"
)
CUSTOMER = {"customer_name": "Prueba", "customer_surnames": "Uno", "phone": "600000123", "confirmed_by_customer": True}


class FakeAPI:
    def __init__(self, availability: list[dict[str, Any]] | None = None, book: list[dict[str, Any]] | None = None,
                 delay: float = 0.0):
        self.availability_answers = list(availability or [])
        self.book_answers = list(book or [])
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.delay = delay

    async def availability(self, conversation_id, args):
        self.calls.append(("availability", conversation_id, dict(args)))
        await asyncio.sleep(self.delay)
        return MiddlewareResult(self.availability_answers.pop(0), CallMeta(path="a", action=str(args.get("action")), http_status=200))

    async def book(self, conversation_id, args):
        self.calls.append(("book", conversation_id, dict(args)))
        await asyncio.sleep(self.delay)
        return MiddlewareResult(self.book_answers.pop(0), CallMeta(path="b", action="book", http_status=200))

    async def aclose(self):
        pass


def _executor(api: FakeAPI, events: list | None = None) -> ToolExecutor:
    state = CallState(conversation_id=CONV)
    return ToolExecutor(state, api, on_tool_event=(events.append if events is not None else None))


# ── esquemas ────────────────────────────────────────────────────────────────

def test_model_never_sees_conversation_id_agent_profile_or_token():
    names = [t["name"] for t in TOOL_SCHEMAS]
    assert names == [TOOL_AVAILABILITY, TOOL_BOOK, TOOL_END_CALL]
    for tool in TOOL_SCHEMAS:
        props = tool["input_schema"]["properties"]
        assert not {"conversation_id", "agent_profile", "slot_token"} & set(props)


# ── pasos ───────────────────────────────────────────────────────────────────

async def test_happy_path_phases():
    api = FakeAPI(
        availability=[PAGE, {"outcome": "locked", "locked": True, "slot": SLOT}],
        book=[{"booked": True, "outcome": "confirmed", "booking_number": 1, "max_bookings_per_call": 3,
               "whatsapp_confirmation": "queued"}],
    )
    ex = _executor(api)
    s = ex.state
    assert s.phase == Phase.INICIO
    await ex.execute(TOOL_AVAILABILITY, {"action": "discover", "service_id": 1, "date": "2026-10-07", "time_period": "morning"})
    assert s.phase == Phase.HORAS
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    assert s.phase == Phase.DATOS
    s.on_user_text("Prueba Uno, seis cero cero...")
    s.on_assistant_text(SUMMARY)
    s.on_user_text("Sí")
    assert s.phase == Phase.CONFIRMAR
    result = await ex.execute(TOOL_BOOK, CUSTOMER)
    assert result["outcome"] == "confirmed"
    assert s.phase == Phase.HECHA
    assert len(s.bookings) == 1 and s.bookings[0].whatsapp_queued
    # G1 + G2: el código pone conversation_id y el token del último lock
    kind, conv, args = api.calls[-1]
    assert kind == "book" and conv == CONV and args["slot_token"] == "tk1.A"


async def test_second_booking_starts_new_cita():
    s = CallState(conversation_id=CONV)
    s.on_availability_result({"action": "discover"}, PAGE)
    s.on_availability_result({"action": "lock", "option_index": 1}, {"outcome": "locked", "slot": SLOT})
    s.on_assistant_text(SUMMARY)
    s.on_user_text("Sí")
    s.on_book_result("tk1.A", {"booked": True, "outcome": "confirmed", "booking_number": 1, "max_bookings_per_call": 3})
    assert s.phase == Phase.HECHA and s.cita_number == 2
    s.on_availability_result({"action": "discover", "preferred_time": "10:00"}, PAGE)
    assert s.phase == Phase.HORAS
    s.on_availability_result({"action": "lock", "option_index": 2}, {"outcome": "locked", "slot": {**SLOT, "slot_token": "tk1.B"}})
    assert s.phase == Phase.DATOS
    assert not s.data_already_given_in_cita()  # cita nueva: hay que pedir los datos


async def test_looking_at_other_hours_after_lock_goes_back_to_hours_but_keeps_lock():
    s = CallState(conversation_id=CONV)
    s.on_availability_result({"action": "discover"}, PAGE)
    s.on_availability_result({"action": "lock", "option_index": 1}, {"outcome": "locked", "slot": SLOT})
    s.on_availability_result({"action": "more"}, PAGE)
    assert s.phase == Phase.HORAS
    assert s.live_lock is not None and s.live_lock["slot_token"] == "tk1.A"


async def test_professional_change_after_summary_does_not_ask_data_again():
    s = CallState(conversation_id=CONV)
    s.on_availability_result({"action": "discover"}, PAGE)
    s.on_availability_result({"action": "lock", "option_index": 1}, {"outcome": "locked", "slot": SLOT})
    s.on_assistant_text(SUMMARY)
    s.on_user_text("Sí")
    s.on_availability_result({"action": "discover", "employee_id": 1, "preferred_time": "10:00"}, PAGE)
    assert s.requested_employee_id == 1
    s.on_availability_result({"action": "lock", "option_index": 1},
                             {"outcome": "locked", "slot": {**SLOT, "employee_id": 1, "employee_name": "Bruno", "slot_token": "tk1.B"}})
    assert s.phase == Phase.DATOS
    assert s.data_already_given_in_cita()


async def test_failed_create_stays_in_confirm_and_recheck_is_offered_once():
    s = CallState(conversation_id=CONV)
    s.on_availability_result({"action": "discover"}, PAGE)
    s.on_availability_result({"action": "lock", "option_index": 1}, {"outcome": "locked", "slot": SLOT})
    s.on_assistant_text(SUMMARY)
    s.on_user_text("Sí")
    s.on_book_result("tk1.A", {"booked": False, "outcome": "slot_token_expired"})
    assert s.phase == Phase.CONFIRMAR
    assert s.recheck_pending == "slot_token_expired"
    s.on_availability_result({"action": "discover", "preferred_time": "10:00"}, PAGE)
    s.on_availability_result({"action": "lock", "option_index": 1, "preferred_employee_id": 2},
                             {"outcome": "locked", "slot": {**SLOT, "slot_token": "tk1.C"}})
    assert s.recheck_pending is None
    s.on_assistant_text(SUMMARY)
    s.on_user_text("Sí")
    s.on_book_result("tk1.C", {"booked": False, "outcome": "slot_not_authorized"})
    assert s.recheck_pending is None and s.recheck_used_in_cita  # segunda vez: WhatsApp


def test_restriction_and_failures_tracking():
    s = CallState(conversation_id=CONV)
    s.on_availability_result({"action": "scan", "after_time": "18:00"}, {"outcome": "no_availability"})
    assert s.last_scan_restriction == {"after_time": "18:00"}
    s.on_availability_result({"action": "discover"}, {"outcome": "agenda_unavailable"})
    s.on_availability_result({"action": "discover"}, {"outcome": "agenda_unavailable"})
    assert s.failures["consulta"] == 2
    s.on_availability_result({"action": "discover"}, PAGE)
    assert "consulta" not in s.failures


def test_assistant_markers():
    s = CallState(conversation_id=CONV)
    s.on_assistant_text("Si quieres te lo miro ahora y te lo dejo apañado, ¿te parece?")
    assert s.keep_open_offered
    s.on_assistant_text("Lo siento, ahora mismo no he podido resolverlo. Escríbenos por WhatsApp a este mismo número…")
    assert s.whatsapp_said
    # sin lock, la pregunta del resumen no cuenta como resumen
    s.on_assistant_text(SUMMARY)
    s.on_user_text("Sí")
    assert s.summary_seq is None


# ── protecciones de la reserva ─────────────────────────────────────────────

async def test_g3_no_lock_no_call():
    api = FakeAPI()
    ex = _executor(api)
    result = await ex.execute(TOOL_BOOK, CUSTOMER)
    assert result["outcome"] == "lock_required" and result["local_guard"]
    assert api.calls == []


async def test_g5_no_summary_no_call():
    api = FakeAPI(availability=[{"outcome": "locked", "slot": SLOT}])
    ex = _executor(api)
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    result = await ex.execute(TOOL_BOOK, CUSTOMER)
    assert result["outcome"] == "not_confirmed" and result["local_guard"]
    assert [c[0] for c in api.calls] == ["availability"]


async def test_g5_confirmed_flag_must_be_true():
    api = FakeAPI(availability=[{"outcome": "locked", "slot": SLOT}])
    ex = _executor(api)
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    ex.state.on_assistant_text(SUMMARY)
    ex.state.on_user_text("Sí")
    result = await ex.execute(TOOL_BOOK, {**CUSTOMER, "confirmed_by_customer": "true"})
    assert result["outcome"] == "not_confirmed"


@pytest.mark.parametrize(
    "first_outcome",
    ["uncertain", "confirmed", "slot_taken", "already_booked_in_call", "invalid_slot_token", "slot_token_expired",
     "slot_not_authorized"],
)
async def test_g4_one_create_per_token(first_outcome):
    api = FakeAPI(
        availability=[{"outcome": "locked", "slot": SLOT}],
        book=[{"booked": first_outcome == "confirmed", "outcome": first_outcome}],
    )
    ex = _executor(api)
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    ex.state.on_assistant_text(SUMMARY)
    ex.state.on_user_text("Sí")
    first = await ex.execute(TOOL_BOOK, CUSTOMER)
    second = await ex.execute(TOOL_BOOK, CUSTOMER)
    assert [c[0] for c in api.calls].count("book") == 1
    assert second["outcome"] == first["outcome"] and second["replayed"] is True


async def test_g6_create_survives_cancellation_and_is_not_repeated():
    api = FakeAPI(
        availability=[{"outcome": "locked", "slot": SLOT}],
        book=[{"booked": True, "outcome": "confirmed"}],
        delay=0.05,
    )
    ex = _executor(api)
    api.delay = 0
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    ex.state.on_assistant_text(SUMMARY)
    ex.state.on_user_text("Sí")
    api.delay = 0.05
    task = asyncio.ensure_future(ex.execute(TOOL_BOOK, CUSTOMER))
    await asyncio.sleep(0.01)
    task.cancel()  # el cliente interrumpe: Pipecat cancela la llamada de función
    with pytest.raises(asyncio.CancelledError):
        await task
    await ex.wait_background()
    assert ex.state.bookings, "la reserva enviada debe registrarse aunque se cancele"
    again = await ex.execute(TOOL_BOOK, CUSTOMER)
    assert again["outcome"] == "confirmed" and again["replayed"]
    assert [c[0] for c in api.calls].count("book") == 1


async def test_new_lock_after_confirmed_allows_next_booking():
    api = FakeAPI(
        availability=[{"outcome": "locked", "slot": SLOT}, {"outcome": "locked", "slot": {**SLOT, "slot_token": "tk1.B"}}],
        book=[{"booked": True, "outcome": "confirmed", "booking_number": 1, "max_bookings_per_call": 3},
              {"booked": True, "outcome": "confirmed", "booking_number": 2, "max_bookings_per_call": 3}],
    )
    ex = _executor(api)
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    ex.state.on_assistant_text(SUMMARY)
    ex.state.on_user_text("Sí")
    await ex.execute(TOOL_BOOK, CUSTOMER)
    # sin nuevo lock, otra creación devuelve la anterior (misma hora)
    replay = await ex.execute(TOOL_BOOK, CUSTOMER)
    assert replay["replayed"]
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    ex.state.on_assistant_text(SUMMARY)
    ex.state.on_user_text("Sí")
    second = await ex.execute(TOOL_BOOK, {**CUSTOMER, "customer_name": "Otra"})
    assert second["booking_number"] == 2
    tokens = [c[2]["slot_token"] for c in api.calls if c[0] == "book"]
    assert tokens == ["tk1.A", "tk1.B"]


async def test_events_never_log_personal_data():
    events: list = []
    api = FakeAPI(availability=[{"outcome": "locked", "slot": SLOT}], book=[{"booked": True, "outcome": "confirmed"}])
    ex = _executor(api, events)
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    ex.state.on_assistant_text(SUMMARY)
    ex.state.on_user_text("Sí")
    await ex.execute(TOOL_BOOK, CUSTOMER)
    text = repr(events)
    assert "600000123" not in text and "Prueba" not in text and "tk1.A" not in text


async def test_end_call_marks_state_and_calls_hook():
    called = []

    async def on_end():
        called.append(True)

    ex = ToolExecutor(CallState(conversation_id=CONV), FakeAPI(), on_end_call=on_end)
    result = await ex.execute(TOOL_END_CALL, {})
    assert result["outcome"] == "ending" and ex.state.ended and called
