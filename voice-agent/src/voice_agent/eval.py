"""Banco de conversaciones con el LLM REAL: ``python -m voice_agent.eval``.

- Escenarios en ``eval_escenarios.json`` (C1–C12 del plan del piloto y casos difíciles de la V6).
- Cliente simulado por GUION (sin LLM) y middleware FALSO: nunca toca la agenda real.
- Comprueba herramientas y argumentos, reservas, frases clave y frases prohibidas.
- Informe markdown con aprobado/suspenso, tokens, coste estimado y si se activó la caché.
- Tope de gasto por ejecución (``--tope-usd``, 0,25 USD por defecto).

Sin ANTHROPIC_API_KEY sale con un mensaje claro (código 2).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from importlib import resources
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from voice_agent.config import DEFAULT_GREETING
from voice_agent.fake_middleware import PHONE_RE, FakeMiddleware
from voice_agent.sim import Budget, BudgetExceeded, SimSession, agent_turn
from voice_agent.state import EMPLOYEE_NAMES, normalize_text

TZ = ZoneInfo("Europe/Madrid")
DEFAULT_CAP_USD = 0.25
WEEKDAYS = {"lunes": 0, "martes": 1, "miercoles": 2, "jueves": 3, "viernes": 4, "sabado": 5, "domingo": 6}

# Comprobaciones que entiende evaluate() (las que se pueden poner en eval_escenarios.json).
KNOWN_CHECKS = frozenset({
    "reservas", "reservas_max", "cuelga", "debe_llamar", "no_debe_llamar", "cuenta", "frases",
    "frases_prohibidas", "inicios_prohibidos", "sin_herramienta_en_primer_turno", "sin_herramienta_tras_cliente",
    "tras", "tras_debe", "reserva_en", "reservas_con_telefono_valido", "segunda_cita_misma_hora", "fechas_no_pasadas",
})

SUMMARY_MARK = "confirmas que quieres reservar"
DATA_MARKS = ("tu nombre", "nombre y los apellidos", "apellidos")
MORE_MARKS = ("algo mas",)


def norm(text: str) -> str:
    """Minúsculas, sin tildes ni signos, espacios simples: para comparar frases."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", normalize_text(text))).strip()


def load_bank() -> dict[str, Any]:
    raw = resources.files("voice_agent").joinpath("eval_escenarios.json").read_text(encoding="utf-8")
    return json.loads(raw)


def scenario_now(esc: dict[str, Any], defaults: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(esc.get("hoy", defaults["hoy"])).replace(tzinfo=TZ)


def resolve_date(value: Any, today: date) -> Any:
    """$hoy, $manana, $pasado, $lunes…$domingo (el próximo con ese nombre, nunca hoy)."""
    if not isinstance(value, str) or not value.startswith("$"):
        return value
    key = normalize_text(value[1:])
    if key == "hoy":
        return today.isoformat()
    if key == "manana":
        return (today + timedelta(days=1)).isoformat()
    if key == "pasado":
        return (today + timedelta(days=2)).isoformat()
    if key in WEEKDAYS:
        ahead = (WEEKDAYS[key] - today.weekday()) % 7 or 7
        return (today + timedelta(days=ahead)).isoformat()
    return value


# ── cliente por guion ──────────────────────────────────────────────────────

@dataclass
class ScriptedCustomer:
    pasos: list[str]
    datos: list[str]
    confirmaciones: list[str]
    algo_mas: list[str]
    reacciones: list[dict[str, Any]]
    _used: set[int] = field(default_factory=set)
    _goodbyes: int = 0

    @classmethod
    def from_scenario(cls, esc: dict[str, Any], defaults: dict[str, Any]) -> ScriptedCustomer:
        return cls(
            pasos=list(esc.get("pasos", [])),
            datos=list(esc.get("datos", defaults["datos"])),
            confirmaciones=list(esc.get("confirmaciones", defaults["confirmaciones"])),
            algo_mas=list(esc.get("algo_mas", defaults["algo_mas"])),
            reacciones=list(esc.get("reacciones", [])),
        )

    @staticmethod
    def _pop(items: list[str]) -> str:
        return items.pop(0) if len(items) > 1 else items[0]

    def next(self, agent_text: str) -> str | None:
        """Lo siguiente que dice el cliente, según lo último que ha dicho el agente."""
        t = norm(agent_text)
        for i, r in enumerate(self.reacciones):
            if (i in self._used and r.get("una_vez")) or not re.search(norm(r["si"]), t):
                continue
            self._used.add(i)
            say = r["di"]
            if say == "$elige_nombrado":
                named = [n for n in EMPLOYEE_NAMES.values() if norm(n) in t]
                say = f"Con {named[0]}" if named else "Con Bruno"
            return say
        if SUMMARY_MARK in t:
            return self._pop(self.confirmaciones)
        if any(m in t for m in DATA_MARKS):
            return self._pop(self.datos)
        if any(m in t for m in MORE_MARKS):
            return self._pop(self.algo_mas)
        if self.pasos:
            return self.pasos.pop(0)
        self._goodbyes += 1
        return "No, gracias" if self._goodbyes <= 1 else None


# ── ejecución de un escenario ──────────────────────────────────────────────

@dataclass
class RunResult:
    escenario: str
    titulo: str
    repeticion: int
    turns: list[dict[str, Any]] = field(default_factory=list)
    transcript: list[str] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=lambda: {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "calls": 0})
    cost_usd: float = 0.0
    ended: bool = False
    confirmed: list[dict[str, Any]] = field(default_factory=list)
    checks: list[tuple[str, bool, str]] = field(default_factory=list)
    error: str | None = None

    @property
    def passed(self) -> bool:
        return self.error is None and all(ok for _, ok, _ in self.checks)

    @property
    def cache_active(self) -> bool:
        return self.usage["cache_read"] > 0


async def run_scenario(esc: dict[str, Any], defaults: dict[str, Any], client: Any, model: str, strategy: str,
                       budget: Budget, repetition: int = 1, greeting: str = DEFAULT_GREETING) -> RunResult:
    now = scenario_now(esc, defaults)
    agenda = esc.get("agenda", {})
    fake = FakeMiddleware(today=now.date(), now=now, force_free=set(agenda.get("libres", [])),
                          force_taken=set(agenda.get("ocupadas", [])),
                          fail_next=json.loads(json.dumps(agenda.get("fallos", {}))))
    result = RunResult(esc["id"], esc.get("titulo", ""), repetition)
    session = SimSession(strategy, out=result.transcript.append, fake=fake, now=now, greeting=greeting)
    customer = ScriptedCustomer.from_scenario(esc, defaults)
    spent_before = budget.spent_usd
    usage_before = dict(budget.usage)
    last_agent = greeting
    try:
        for _ in range(int(esc.get("max_turnos", defaults["max_turnos"]))):
            say = customer.next(last_agent)
            if say is None:
                break
            session.state.on_user_text(say)
            session.history.append({"role": "user", "content": say})
            result.transcript.append(f"cliente> {say}")
            turn = await agent_turn(session, client, model, budget)
            turn["customer"] = say
            result.turns.append(turn)
            result.calls.extend(turn["tools"])
            last_agent = " ".join(turn["texts"]) or last_agent
            if session.ended:
                break
    except BudgetExceeded as exc:
        result.error = str(exc)
    except Exception as exc:  # un fallo de la API no debe parar el banco entero
        result.error = f"{type(exc).__name__}: {exc}"
    result.ended = session.ended
    result.confirmed = list(fake.confirmed)
    result.cost_usd = budget.spent_usd - spent_before
    result.usage = {k: budget.usage[k] - usage_before.get(k, 0) for k in budget.usage}
    result.checks = evaluate(esc, defaults, result, now.date())
    return result


# ── comprobaciones ─────────────────────────────────────────────────────────

def _matches(call: dict[str, Any], m: dict[str, Any], today: date) -> bool:
    if "tool" in m and call["tool"] != m["tool"]:
        return False
    if "action" in m and call.get("action") != m["action"]:
        return False
    if "actions" in m and call.get("action") not in m["actions"]:
        return False
    if "outcome" in m and call.get("outcome") != m["outcome"]:
        return False
    for k in m.get("tiene", []):
        if call["args"].get(k) in (None, ""):
            return False
    for k, v in m.get("args", {}).items():
        if str(call["args"].get(k)) != str(resolve_date(v, today)):
            return False
    return True


def evaluate(esc: dict[str, Any], defaults: dict[str, Any], r: RunResult, today: date) -> list[tuple[str, bool, str]]:
    c = {**defaults.get("comprobaciones_globales", {}), **esc.get("comprobaciones", {})}
    texts = [t for turn in r.turns for t in turn["texts"]]
    all_text = norm(" ".join(texts))
    out: list[tuple[str, bool, str]] = []
    real_calls = [x for x in r.calls if not x.get("local_guard")]

    if "reservas" in c:
        out.append(("reservas", len(r.confirmed) == c["reservas"], f"{len(r.confirmed)} de {c['reservas']}"))
    if "reservas_max" in c:
        out.append(("reservas_max", len(r.confirmed) <= c["reservas_max"], f"{len(r.confirmed)} ≤ {c['reservas_max']}"))
    if c.get("cuelga"):
        out.append(("cuelga", r.ended, "end_call" if r.ended else "no colgó"))
    for m in c.get("debe_llamar", []):
        ok = any(_matches(x, m, today) for x in real_calls)
        out.append(("debe_llamar", ok, json.dumps(m, ensure_ascii=False)))
    for m in c.get("no_debe_llamar", []):
        bad = [x for x in real_calls if _matches(x, m, today)]
        out.append(("no_debe_llamar", not bad, json.dumps(m, ensure_ascii=False)))
    for spec in c.get("cuenta", []):
        n = sum(1 for x in real_calls if _matches(x, spec["match"], today))
        ok = n >= spec.get("min", 0) and n <= spec.get("max", 10**6)
        out.append(("cuenta", ok, f"{n} llamadas de {json.dumps(spec['match'], ensure_ascii=False)}"))
    for phrase in c.get("frases", []):
        out.append(("frase", norm(phrase) in all_text, phrase))
    for phrase in c.get("frases_prohibidas", []):
        out.append(("frase_prohibida", norm(phrase) not in all_text, phrase))
    starts = [norm(t).split(" ")[0:2] for t in texts]
    for word in c.get("inicios_prohibidos", []):
        w = norm(word).split(" ")
        bad = [s for s in starts if s[: len(w)] == w]
        out.append(("inicio_prohibido", not bad, word))
    if c.get("sin_herramienta_en_primer_turno") and r.turns:
        out.append(("sin_herramienta_en_primer_turno", not r.turns[0]["tools"], "primer turno del agente"))
    for trigger in c.get("sin_herramienta_tras_cliente", []):
        turns = [t for t in r.turns if norm(trigger) in norm(t["customer"])]
        ok = bool(turns) and not turns[0]["tools"]
        out.append(("sin_herramienta_tras_cliente", ok, trigger))
    if "tras" in c:
        idx = next((i for i, x in enumerate(real_calls) if _matches(x, c["tras"]["si"], today)), None)
        rest = real_calls[idx:] if idx is not None else []
        relevant = [x for x in rest if x["tool"] == c["tras"]["todas"].get("tool") and
                    x.get("action") in c["tras"]["todas"].get("actions", [x.get("action")])]
        ok = idx is not None and all(_matches(x, c["tras"]["todas"], today) for x in relevant)
        out.append(("tras", ok, "todas las consultas siguientes con profesional"))
    if "tras_debe" in c:
        idx = next((i for i, x in enumerate(r.calls) if _matches(x, c["tras_debe"]["si"], today)), None)
        ok = idx is not None and any(_matches(x, c["tras_debe"]["debe"], today) for x in r.calls[idx + 1:])
        out.append(("tras_debe", ok, json.dumps(c["tras_debe"], ensure_ascii=False)))
    if "reserva_en" in c:
        want = {k: resolve_date(v, today) for k, v in c["reserva_en"].items()}
        ok = any(all(str(b.get(k)) == str(v) for k, v in want.items()) for b in r.confirmed)
        out.append(("reserva_en", ok, json.dumps(want, ensure_ascii=False)))
    if c.get("reservas_con_telefono_valido"):
        ok = all(PHONE_RE.match(str(b.get("phone") or "")) for b in r.confirmed)
        out.append(("telefono_valido", ok, f"{len(r.confirmed)} reservas"))
    if c.get("segunda_cita_misma_hora"):
        ok = False
        if r.confirmed:
            first = r.confirmed[0]
            discovers = [x for x in real_calls if x.get("action") == "discover"]
            ok = any(x["args"].get("date") == first["date"] and x["args"].get("preferred_time") == first["time"]
                     for x in discovers)
        out.append(("segunda_cita_misma_hora", ok, "discover con fecha y hora de la primera"))
    if c.get("fechas_no_pasadas"):
        dates = [x["args"].get(k) for x in real_calls for k in ("date", "date_from") if x["args"].get(k)]
        ok = all(str(d) >= today.isoformat() for d in dates)
        out.append(("fechas_no_pasadas", ok, ", ".join(map(str, dates)) or "sin fechas"))
    return out


# ── informe ────────────────────────────────────────────────────────────────

def render_report(results: list[RunResult], model: str, strategy: str, cap: float, spent: float) -> str:
    when = datetime.now(TZ).strftime("%Y-%m-%d %H:%M")
    ok = sum(1 for r in results if r.passed)
    total = {k: sum(r.usage.get(k, 0) for r in results) for k in ("input", "cache_read", "cache_write", "output", "calls")}
    lines = [
        f"# Banco de conversaciones ({when}, hora de Madrid)",
        "",
        f"- Modelo: `{model}` · estrategia de prompt: `{strategy}` · middleware: FALSO · cliente: guion",
        f"- Resultado: **{ok} de {len(results)} aprobados**",
        f"- Gasto estimado: {spent:.4f} USD (tope {cap:.2f} USD; precios de `precios.json`, a confirmar)",
        f"- Tokens: entrada {total['input']}, caché leída {total['cache_read']}, caché escrita {total['cache_write']}, "
        f"salida {total['output']} en {total['calls']} llamadas",
        f"- Caché activa en {sum(1 for r in results if r.cache_active)} de {len(results)} ejecuciones",
        "",
        "| Escenario | Rep. | Resultado | Fallos | Turnos | Llamadas | Entrada | Caché leída | Caché escrita | Salida | Coste USD | Caché |",
        "|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for r in results:
        fails = [name for name, passed, _ in r.checks if not passed]
        if r.error:
            fails.insert(0, "error")
        lines.append(
            f"| {r.escenario} | {r.repeticion} | {'APROBADO' if r.passed else 'SUSPENSO'} | {', '.join(fails) or '—'} | "
            f"{len(r.turns)} | {r.usage['calls']} | {r.usage['input']} | {r.usage['cache_read']} | {r.usage['cache_write']} | "
            f"{r.usage['output']} | {r.cost_usd:.4f} | {'sí' if r.cache_active else 'no'} |"
        )
    by_scenario: dict[str, list[RunResult]] = {}
    for r in results:
        by_scenario.setdefault(r.escenario, []).append(r)
    if any(len(v) > 1 for v in by_scenario.values()):
        lines += ["", "## Variabilidad", "", "| Escenario | Aprobados |", "|---|---|"]
        for k, v in by_scenario.items():
            lines.append(f"| {k} | {sum(1 for r in v if r.passed)} de {len(v)} |")
    lines += ["", "## Detalle", ""]
    for r in results:
        lines += [f"### {r.escenario} (rep. {r.repeticion}): {r.titulo} — {'APROBADO' if r.passed else 'SUSPENSO'}", ""]
        if r.error:
            lines.append(f"- ERROR: {r.error}")
        for name, passed, detail in r.checks:
            lines.append(f"- {'OK' if passed else 'FALLO'} · {name}: {detail}")
        lines += ["", "<details><summary>Conversación (datos ficticios)</summary>", "", "```"]
        lines += [t for t in r.transcript if not t.startswith("   [paso")]
        lines += ["```", "", "</details>", ""]
    return "\n".join(lines)


# ── CLI ────────────────────────────────────────────────────────────────────

async def run_bank(client: Any, model: str, strategy: str, cap_usd: float, ids: list[str] | None,
                   repetitions: int, greeting: str = DEFAULT_GREETING, progress=print) -> tuple[list[RunResult], Budget]:
    bank = load_bank()
    defaults = bank["por_defecto"]
    selected = [e for e in bank["escenarios"] if not ids or e["id"] in ids]
    budget = Budget(cap_usd, model)
    results: list[RunResult] = []
    for rep in range(1, repetitions + 1):
        for esc in selected:
            if budget.spent_usd >= cap_usd:
                progress(f"Tope de gasto alcanzado ({budget.spent_usd:.4f} USD): se para el banco.")
                return results, budget
            r = await run_scenario(esc, defaults, client, model, strategy, budget, rep, greeting)
            progress(f"{esc['id']} rep. {rep}: {'APROBADO' if r.passed else 'SUSPENSO'} ({r.cost_usd:.4f} USD)")
            results.append(r)
    return results, budget


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m voice_agent.eval", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--escenario", action="append", help="id del escenario (se puede repetir); por defecto, todos")
    parser.add_argument("--repeticiones", type=int, default=1)
    parser.add_argument("--tope-usd", type=float, default=DEFAULT_CAP_USD, help="tope de gasto estimado por ejecución")
    parser.add_argument("--estrategia", choices=("nodos", "completo"), default=os.environ.get("PROMPT_STRATEGY", "nodos"))
    parser.add_argument("--modelo", default=os.environ.get("LLM_MODEL", "claude-haiku-4-5"))
    parser.add_argument("--salida", default=None, help="fichero markdown del informe")
    parser.add_argument("--listar", action="store_true", help="lista los escenarios y sale")
    args = parser.parse_args(argv)

    from voice_agent.logging_setup import configure_logging

    configure_logging(os.environ.get("LOG_LEVEL", "WARNING"))
    bank = load_bank()
    if args.listar:
        for e in bank["escenarios"]:
            print(f"{e['id']:<4} {e['titulo']}")
        return 0
    known = {e["id"] for e in bank["escenarios"]}
    unknown = [i for i in (args.escenario or []) if i not in known]
    if unknown:
        print(f"Escenarios desconocidos: {', '.join(unknown)}. Usa --listar.", file=sys.stderr)
        return 2
    from voice_agent.precios import llm_price_known

    if not llm_price_known(args.modelo):
        # Sin precio no se puede aplicar el tope de gasto: no se estima con los de otro modelo.
        print(f"El modelo {args.modelo!r} no tiene precio en precios.json: el banco se niega a ejecutarse "
              "(el tope de gasto no sería fiable). Añade su precio al fichero.", file=sys.stderr)
        return 2
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Falta ANTHROPIC_API_KEY: el banco usa el modelo real y no puede ejecutarse sin la clave.\n"
              "Para probar sin clave: python -m voice_agent.sim --demo", file=sys.stderr)
        return 2
    if args.repeticiones < 1 or args.tope_usd <= 0:
        print("--repeticiones debe ser ≥ 1 y --tope-usd > 0", file=sys.stderr)
        return 2

    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"], timeout=20.0, max_retries=2)
    greeting = os.environ.get("GREETING_TEXT") or DEFAULT_GREETING
    results, budget = asyncio.run(run_bank(client, args.modelo, args.estrategia, args.tope_usd, args.escenario,
                                           args.repeticiones, greeting))
    report = render_report(results, args.modelo, args.estrategia, args.tope_usd, budget.spent_usd)
    path = Path(args.salida or f"eval-{datetime.now(TZ):%Y%m%d-%H%M}.md")
    path.write_text(report, encoding="utf-8")
    passed = sum(1 for r in results if r.passed)
    print(f"{passed} de {len(results)} aprobados · {budget.spent_usd:.4f} USD · informe: {path}")
    return 0 if results and passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
