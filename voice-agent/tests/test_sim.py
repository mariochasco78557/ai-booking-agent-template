"""El simulador recorre los mismos pasos sin red, y el middleware falso responde con la forma real."""

from __future__ import annotations

import sys
from datetime import date

from voice_agent.fake_middleware import FakeMiddleware
from voice_agent.request_shape import count_cache_breakpoints
from voice_agent.sim import first_open_day, main, run_demo, run_guards

TODAY = date(2026, 10, 5)  # lunes


def _quiet(_line: str) -> None:
    pass


async def test_demo_walks_every_step_and_books_once():
    s = await run_demo(out=_quiet)
    assert s.phases == ["INICIO", "HORAS", "DATOS", "CONFIRMAR", "HECHA"]
    assert len(s.state.bookings) == 1 and s.ended
    books = [r for kind, r in s.fake.requests if kind == "book"]
    assert len(books) == 1
    assert books[0]["conversation_id"].startswith("sim_")


async def test_demo_full_strategy_same_steps():
    s = await run_demo(strategy="completo", out=_quiet)
    assert s.phases[-1] == "HECHA"


async def test_guards_let_only_one_booking_through():
    lines: list[str] = []
    s = await run_guards(out=lines.append)
    outcomes = [e["outcome"] for e in s.tool_log if e["tool"] == "reserva"]
    assert outcomes == ["lock_required", "not_confirmed", "confirmed", "confirmed"]
    assert s.tool_log[-1].get("replayed") is True
    assert sum(1 for kind, _ in s.fake.requests if kind == "book") == 1


async def test_request_params_stay_within_cache_limits():
    s = await run_demo(out=_quiet)
    params = s.request_params()
    assert count_cache_breakpoints(params) <= 4
    assert params["messages"][0]["role"] == "user"


def test_sim_does_not_import_pipecat():
    import importlib

    for name in [m for m in sys.modules if m.startswith("voice_agent.sim")]:
        del sys.modules[name]
    before = {m for m in sys.modules if m.startswith("pipecat")}
    importlib.import_module("voice_agent.sim")
    after = {m for m in sys.modules if m.startswith("pipecat")}
    assert after == before


def test_cli_modes_run(capsys):
    assert main(["--tamanos"]) == 0
    assert "Mínimo cacheable" in capsys.readouterr().out
    assert main(["--guardas"]) == 0
    assert "esperado: 1" in capsys.readouterr().out


def test_interactive_real_refuses_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert main(["--interactivo", "--llm", "real"]) == 2


# ── middleware falso ────────────────────────────────────────────────────────

async def test_fake_closed_days_and_flow():
    fake = FakeMiddleware(today=TODAY)
    monday = await fake.availability("sim_x0000001", {"action": "discover", "service_id": 1, "date": "2026-10-12",
                                                      "time_period": "morning"})
    assert monday.body["outcome"] == "no_availability" and "cerrada" in monday.body["message"]
    day = first_open_day(fake)
    page = await fake.availability("sim_x0000001", {"action": "discover", "service_id": 1,
                                                    "date": day.isoformat(), "time_period": "morning"})
    assert page.body["outcome"] == "options_available" and len(page.body["options"]) <= 3
    lock = await fake.availability("sim_x0000001", {"action": "lock", "option_index": 1})
    assert lock.body["outcome"] == "locked" and lock.body["slot"]["slot_token"].startswith("tk1.")
    bad = await fake.book("sim_x0000001", {"slot_token": "otro", "confirmed_by_customer": True})
    assert bad.body["outcome"] == "invalid_slot_token"
    ok = await fake.book("sim_x0000001", {"slot_token": lock.body["slot"]["slot_token"], "customer_name": "A",
                                          "customer_surnames": "B", "phone": "600000123", "confirmed_by_customer": True})
    assert ok.body["outcome"] == "confirmed" and ok.body["booking_number"] == 1


async def test_fake_more_and_forced_failures():
    fake = FakeMiddleware(today=TODAY, fail_next={"availability": "agenda_unavailable"})
    lost = await fake.availability("sim_x0000002", {"action": "more"})
    assert lost.body["outcome"] == "agenda_unavailable"
    assert (await fake.availability("sim_x0000002", {"action": "more"})).body["outcome"] == "continuation_lost"
    fake.fail_next["book"] = "uncertain"
    unc = await fake.book("sim_x0000002", {})
    assert unc.body["outcome"] == "uncertain" and unc.body["booked"] is False
