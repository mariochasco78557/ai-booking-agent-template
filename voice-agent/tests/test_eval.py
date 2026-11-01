"""Arnés del banco de conversaciones, con un LLM FALSO (sin red ni clave)."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

import pytest

from voice_agent.eval import (
    KNOWN_CHECKS,
    RunResult,
    ScriptedCustomer,
    evaluate,
    load_bank,
    main,
    render_report,
    resolve_date,
    run_bank,
)


class _Block:
    def __init__(self, data: dict[str, Any]):
        self._data = data

    def model_dump(self, exclude_none: bool = True) -> dict[str, Any]:
        return dict(self._data)


class _Usage:
    def __init__(self, n: int):
        self.input_tokens = 300
        self.cache_read_input_tokens = 0 if n == 0 else 7000
        self.cache_creation_input_tokens = 7000 if n == 0 else 200
        self.output_tokens = 40


class _Resp:
    def __init__(self, blocks, n):
        self.content = [_Block(b) for b in blocks]
        self.usage = _Usage(n)


class FakeAnthropic:
    """Devuelve respuestas en orden; cada una es una lista de bloques o una función(request)."""

    def __init__(self, script: list[Any]):
        self.script = list(script)
        self.requests: list[dict[str, Any]] = []
        self.messages = self

    async def create(self, **kwargs):
        self.requests.append(kwargs)
        n = len(self.requests) - 1
        item = self.script.pop(0) if self.script else [{"type": "text", "text": "¿Te puedo ayudar en algo más?"}]
        blocks = item(kwargs) if callable(item) else item
        return _Resp(blocks, n)


def _text(t: str) -> dict[str, Any]:
    return {"type": "text", "text": t}


def _tool(name: str, args: dict[str, Any], i: int) -> dict[str, Any]:
    return {"type": "tool_use", "id": f"toolu_{i}", "name": name, "input": args}


def _read_last_message(request: dict[str, Any]) -> list[dict[str, Any]]:
    last = request["messages"][-1]["content"]
    result = next(b for b in last if b.get("type") == "tool_result")
    return [_text(json.loads(result["content"])["message"])]


C1_GOOD = [
    [_text("¿Para qué día te busco la cita?")],
    [_text("¿Por la mañana o por la tarde?")],
    [_text("Lo miro."), _tool("disponibilidad", {"action": "discover", "service_id": 1, "date": "2026-10-08",
                                                 "time_period": "afternoon"}, 1)],
    _read_last_message,
    [_text("Te aparto esa hora."), _tool("disponibilidad", {"action": "lock", "option_index": 1}, 2)],
    [_text("¿Me dices tu nombre, apellidos y un teléfono de contacto?")],
    [_text("Te resumo: corte de pelo, el jueves ocho de octubre, a nombre de Prueba Uno Simulado, teléfono seis, "
           "cero, cero; uno, dos, tres; cuatro, cinco, seis. ¿Confirmas que quieres reservar esta cita con estos "
           "datos o prefieres que mire otro profesional?")],
    [_text("Creo la cita."), _tool("reserva", {"customer_name": "Prueba", "customer_surnames": "Uno Simulado",
                                               "phone": "600123456", "confirmed_by_customer": True}, 3)],
    [_text("Listo, ya tienes la cita: corte de pelo, el jueves ocho de octubre. ¿Te puedo ayudar en algo más?")],
    [_text("Muchas gracias por llamar a Chimac Peluqueros. ¡Que tengas muy buen día!"), _tool("end_call", {}, 4)],
]


def _quiet(_line: str) -> None:
    pass


async def test_c1_passes_with_correct_behaviour():
    client = FakeAnthropic(C1_GOOD)
    results, budget = await run_bank(client, "claude-haiku-4-5", "nodos", 1.0, ["C1"], 1, progress=_quiet)
    r = results[0]
    failed = [c for c in r.checks if not c[1]]
    assert r.passed, failed
    assert len(r.confirmed) == 1 and r.ended
    assert r.cache_active and r.usage["calls"] == 10
    assert budget.spent_usd > 0
    # cada petición lleva las herramientas, el sistema cacheado y la guía al final
    req = client.requests[0]
    assert {t["name"] for t in req["tools"]} == {"disponibilidad", "reserva", "end_call"}
    assert all("cache_control" in b for b in req["system"])
    assert req["messages"][-1]["content"][-1]["text"].startswith("<guia>")
    report = render_report(results, "claude-haiku-4-5", "nodos", 1.0, budget.spent_usd)
    assert "1 de 1 aprobados" in report and "APROBADO" in report and "| sí |" in report


async def test_bad_behaviour_is_caught():
    bad = [
        [_text("Perfecto, déjame ver."), _tool("disponibilidad", {"action": "discover", "service_id": 1,
                                                                  "date": "2026-10-08", "time_period": "morning"}, 1)],
        [_text("Aquí estoy yo para ayudarte a reservar. ¿Sigues ahí?")],
    ]
    results, _ = await run_bank(FakeAnthropic(bad), "claude-haiku-4-5", "nodos", 1.0, ["C5"], 1, progress=_quiet)
    r = results[0]
    assert not r.passed
    failed = {name for name, ok, _ in r.checks if not ok}
    assert {"no_debe_llamar", "frase", "frase_prohibida", "inicio_prohibido", "cuelga"} <= failed
    report = render_report(results, "m", "nodos", 1.0, 0.0)
    assert "SUSPENSO" in report and "0 de 1 aprobados" in report


async def test_budget_cap_stops_the_bank():
    client = FakeAnthropic([])
    results, budget = await run_bank(client, "claude-haiku-4-5", "nodos", 0.001, ["C1", "C5"], 3, progress=_quiet)
    assert budget.spent_usd >= 0.001
    assert any(r.error and "tope" in r.error for r in results)
    assert len(client.requests) < 10  # se para enseguida


async def test_repetitions_report_variability():
    client = FakeAnthropic([])
    results, budget = await run_bank(client, "claude-haiku-4-5", "nodos", 5.0, ["C10"], 2, progress=_quiet)
    assert [r.repeticion for r in results] == [1, 2]
    assert "## Variabilidad" in render_report(results, "m", "nodos", 5.0, budget.spent_usd)


def test_cli_without_key_exits_clearly(monkeypatch, capsys):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert main([]) == 2
    assert "ANTHROPIC_API_KEY" in capsys.readouterr().err
    assert main(["--listar"]) == 0
    assert "C12" in capsys.readouterr().out
    assert main(["--escenario", "Z9"]) == 2


def test_bank_is_well_formed():
    bank = load_bank()
    ids = [e["id"] for e in bank["escenarios"]]
    assert len(ids) == len(set(ids))
    assert {f"C{i}" for i in range(1, 13)} <= set(ids)
    assert {"E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"} <= set(ids)
    for esc in bank["escenarios"]:
        assert esc["pasos"], esc["id"]
        assert set(esc["comprobaciones"]) <= KNOWN_CHECKS, esc["id"]
    assert set(bank["por_defecto"]["comprobaciones_globales"]) <= KNOWN_CHECKS


def test_resolve_dates_from_tuesday():
    today = date(2026, 10, 6)  # martes
    assert resolve_date("$hoy", today) == "2026-10-06"
    assert resolve_date("$manana", today) == "2026-10-07"
    assert resolve_date("$jueves", today) == "2026-10-08"
    assert resolve_date("$sabado", today) == "2026-10-10"
    assert resolve_date("$lunes", today) == "2026-10-12"
    assert resolve_date("$martes", today) == "2026-10-13"
    assert resolve_date("2026-11-03", today) == "2026-11-03"


def test_scripted_customer_reacts():
    c = ScriptedCustomer(pasos=["paso 1"], datos=["datos 1", "datos 2"], confirmaciones=["¿otro?", "Sí"],
                         algo_mas=["No"], reacciones=[{"si": "con quien prefieres", "di": "$elige_nombrado", "una_vez": True}])
    assert c.next("Hola") == "paso 1"
    assert c.next("¿Me dices tu nombre, apellidos y un teléfono?") == "datos 1"
    assert c.next("¿Me dices el nombre y los apellidos de la persona?") == "datos 2"
    assert c.next("Te resumo... ¿Confirmas que quieres reservar esta cita?") == "¿otro?"
    assert c.next("¿Con quién prefieres: con Olga o con Ramón?") == "Con Olga"
    assert c.next("¿Confirmas que quieres reservar esta cita?") == "Sí"
    assert c.next("¿Te puedo ayudar en algo más?") == "No"
    assert c.next("Gracias") == "No, gracias"
    assert c.next("Gracias") is None


def test_check_types_on_synthetic_run():
    r = RunResult("X", "t", 1)
    r.turns = [{"customer": "otro profesional", "texts": ["¿Con quién prefieres: con Bruno o con Olga?"], "tools": []}]
    r.calls = [
        {"tool": "disponibilidad", "action": "discover", "args": {"date": "2026-10-07", "employee_id": 1}, "outcome": "options_available"},
        {"tool": "disponibilidad", "action": "scan", "args": {"date_from": "2026-10-08"}, "outcome": "options_available"},
        {"tool": "reserva", "action": "reserva", "args": {}, "outcome": "slot_taken"},
        {"tool": "disponibilidad", "action": "discover", "args": {"date": "2026-10-05"}, "outcome": "options_available"},
    ]
    r.confirmed = [{"date": "2026-10-07", "time": "12:00", "phone": "12"}]
    esc = {"comprobaciones": {
        "tras": {"si": {"tool": "disponibilidad", "tiene": ["employee_id"]},
                 "todas": {"tool": "disponibilidad", "actions": ["discover", "scan"], "tiene": ["employee_id"]}},
        "tras_debe": {"si": {"tool": "reserva", "outcome": "slot_taken"}, "debe": {"tool": "disponibilidad", "action": "discover"}},
        "reserva_en": {"date": "$manana", "time": "12:00"},
        "reservas_con_telefono_valido": True,
        "sin_herramienta_tras_cliente": ["otro profesional"],
        "fechas_no_pasadas": True,
        "cuenta": [{"match": {"tool": "disponibilidad"}, "max": 2}],
    }}
    checks = {name: ok for name, ok, _ in evaluate(esc, {}, r, date(2026, 10, 6))}
    assert checks == {"tras": False, "tras_debe": True, "reserva_en": True, "telefono_valido": False,
                      "sin_herramienta_tras_cliente": True, "fechas_no_pasadas": False, "cuenta": False}


@pytest.mark.parametrize("esc_id", ["C2", "C6b", "E6", "E7", "E8"])
async def test_every_hard_scenario_runs_offline(esc_id):
    """El guion y las comprobaciones de cada escenario se ejecutan sin error con un LLM mudo."""
    results, _ = await run_bank(FakeAnthropic([]), "claude-haiku-4-5", "nodos", 5.0, [esc_id], 1, progress=_quiet)
    assert results[0].error is None and results[0].checks


def test_main_se_niega_con_modelo_sin_precio(monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "clave-falsa")
    from voice_agent import eval as ev
    from voice_agent.precios import llm_price_known

    assert llm_price_known("claude-haiku-4-5")
    assert not llm_price_known("modelo-inventado")
    assert ev.main(["--escenario", "C1", "--modelo", "modelo-inventado"]) == 2
    assert "no tiene precio" in capsys.readouterr().err
