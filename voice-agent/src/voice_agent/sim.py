"""Simulador por texto: ``python -m voice_agent.sim``.

Recorre los MISMOS pasos, protecciones, prompts y guía del turno que una llamada
real, sin audio y sin red:

- Middleware: siempre el FALSO (``fake_middleware.py``); nunca toca la agenda real.
- Modelo: falso por defecto (guion fijo o comandos a mano); real solo con
  ``--llm real`` y si existe ``ANTHROPIC_API_KEY`` (hoy no existe).

Modos:
  --demo         guion C1 (reserva completa) con LLM falso. Por defecto.
  --guardas      demuestra G3, G4 y G5 (reserva sin lock, sin resumen, repetida).
  --interactivo  tú haces de cliente; con LLM falso escribes también lo que hace el agente
                 (/discover, /lock, /reserva, /bot…); con --llm real contesta Haiku.
  --tamanos      tamaño del prompt por paso (caracteres y tokens estimados).
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import shlex
import sys
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from voice_agent.config import DEFAULT_GREETING
from voice_agent.fake_middleware import DAYS_ES, FakeMiddleware, spoken_time
from voice_agent.request_shape import shape_request
from voice_agent.prompts import core_text, full_text, guidance, step_text, system_blocks
from voice_agent.state import CallState, Phase
from voice_agent.tools import TOOL_AVAILABILITY, TOOL_BOOK, TOOL_END_CALL, TOOL_SCHEMAS, ToolExecutor

TZ = ZoneInfo("Europe/Madrid")
SERVICES = {0: "barba", 1: "corte de pelo", 2: "corte y barba"}
MONTHS = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
          "septiembre", "octubre", "noviembre", "diciembre")


def mark_last_user_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Lo mismo que hace Pipecat: punto de caché en los dos últimos mensajes del cliente."""
    marked = copy.deepcopy(messages)
    found = 0
    for msg in reversed(marked):
        if msg["role"] == "user":
            if isinstance(msg["content"], str):
                msg["content"] = [{"type": "text", "text": msg["content"]}]
            msg["content"][-1]["cache_control"] = {"type": "ephemeral"}
            found += 1
            if found == 2:
                break
    return marked


class SimSession:
    """Una llamada simulada: estado, herramientas e historial con forma de la API."""

    def __init__(self, strategy: str = "nodos", verbose: bool = False, out=print, fake: FakeMiddleware | None = None,
                 now: datetime | None = None, greeting: str = DEFAULT_GREETING):
        self.strategy = strategy
        self.verbose = verbose
        self.out = out
        self._now = now
        self.fake = fake or FakeMiddleware(today=self.now().date())
        self.state = CallState(conversation_id="sim_" + self.now().strftime("%Y%m%d%H%M%S"))
        self.ended = False
        self.executor = ToolExecutor(self.state, self.fake, on_tool_event=self._event, on_end_call=self._on_end)
        self.history: list[dict[str, Any]] = [{"role": "assistant", "content": greeting}]
        self.phases: list[str] = [self.state.phase.value]
        self.tool_log: list[dict[str, Any]] = []
        self._n = 0
        self.out(f"agente> {greeting}")

    async def _on_end(self) -> None:
        self.ended = True

    def _event(self, event: dict[str, Any]) -> None:
        self.tool_log.append(event)

    def _track_phase(self) -> None:
        phase = self.state.phase.value
        if self.phases[-1] != phase:
            self.phases.append(phase)
            self.out(f"   [paso → {phase}]")

    def now(self) -> datetime:
        return self._now or datetime.now(TZ)

    def request_params(self) -> dict[str, Any]:
        blocks = system_blocks(self.strategy, self.state.phase, multi_booking=bool(self.state.bookings))
        params = {"messages": mark_last_user_messages(self.history)}
        return shape_request(params, blocks, guidance(self.state, self.now(), self.strategy))

    def show_guidance(self) -> None:
        params = self.request_params()
        size = sum(len(b["text"]) for b in params["system"])
        self.out(f"   [paso {self.state.phase.value}; system {size} car.]")
        if self.verbose:
            self.out("   " + params["messages"][-1]["content"][-1]["text"].replace("\n", "\n   "))

    def user_says(self, text: str) -> None:
        self.out(f"cliente> {text}")
        self.state.on_user_text(text)
        self.history.append({"role": "user", "content": text})
        self.show_guidance()

    def bot_says(self, text: str) -> None:
        self.out(f"agente> {text}")
        self.state.on_assistant_text(text)
        self.history.append({"role": "assistant", "content": text})
        self._track_phase()

    async def tool(self, name: str, args: dict[str, Any], before: str | None = None) -> dict[str, Any]:
        """Turno del agente con frase de espera (opcional) y una herramienta."""
        self._n += 1
        tool_id = f"toolu_sim_{self._n}"
        content: list[dict[str, Any]] = []
        if before:
            self.out(f"agente> {before}")
            self.state.on_assistant_text(before)
            content.append({"type": "text", "text": before})
        content.append({"type": "tool_use", "id": tool_id, "name": name, "input": args})
        self.history.append({"role": "assistant", "content": content})
        result = await self.executor.execute(name, args)
        shown = {k: v for k, v in result.items() if k in ("outcome", "message", "booked", "instruction", "replayed")}
        self.out(f"   [{name} {json.dumps(args, ensure_ascii=False)} → {json.dumps(shown, ensure_ascii=False)}]")
        self.history.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps(result, ensure_ascii=False)}]})
        self._track_phase()
        return result

    def summary_sentence(self, service_id: int, name: str, phone: str) -> str:
        slot = self.state.live_lock or {}
        d = date.fromisoformat(slot["date"])
        h = int(slot["time"][:2])
        franja = "de la mañana" if h < 14 else "de la tarde"
        words = ("cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve")
        spoken = [words[int(c)] for c in phone[-9:]]
        phone_spoken = "; ".join(", ".join(spoken[i:i + 3]) for i in (0, 3, 6))
        return (f"Te resumo: {SERVICES[service_id]}, el {DAYS_ES[d.weekday()]} {d.day} de {MONTHS[d.month - 1]} "
                f"a {spoken_time(slot['time'])} {franja}, con {slot['employee_name']}, a nombre de {name}, "
                f"teléfono {phone_spoken}. ¿Confirmas que quieres reservar esta cita con estos datos o "
                f"prefieres que mire otro profesional?")


def first_open_day(fake: FakeMiddleware, period: str = "morning") -> date:
    day = fake.today + timedelta(days=1)
    while not fake.free(day, period):
        day += timedelta(days=1)
    return day


async def run_demo(strategy: str = "nodos", verbose: bool = False, out=print) -> SimSession:
    """Guion C1 con LLM falso: servicio, día, franja, hora, datos, «sí», «no, gracias»."""
    s = SimSession(strategy, verbose, out)
    day = first_open_day(s.fake)
    s.user_says(f"Corte de pelo, para el {DAYS_ES[day.weekday()]} por la mañana")
    page = await s.tool(TOOL_AVAILABILITY, {"action": "discover", "service_id": 1, "date": day.isoformat(),
                                            "time_period": "morning"}, before="Lo miro.")
    s.bot_says(page["message"])
    s.user_says("La primera")
    await s.tool(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1}, before="Te aparto esa hora.")
    s.bot_says("¿Me dices tu nombre, apellidos y un teléfono de contacto?")
    s.user_says("Prueba Simulada, seis cero cero, cero cero cero, uno dos tres")
    s.bot_says(s.summary_sentence(1, "Prueba Simulada", "600000123"))
    s.user_says("Sí")
    result = await s.tool(TOOL_BOOK, {"customer_name": "Prueba", "customer_surnames": "Simulada",
                                      "phone": "600000123", "confirmed_by_customer": True}, before="Creo la cita.")
    if result.get("outcome") == "confirmed":
        slot = s.state.lock or {}
        d = date.fromisoformat(slot["date"])
        s.bot_says(f"Listo, ya tienes la cita: corte de pelo, el {DAYS_ES[d.weekday()]} {d.day} de "
                   f"{MONTHS[d.month - 1]} a {spoken_time(slot['time'])}. ¿Te puedo ayudar en algo más?")
    s.user_says("No, gracias")
    s.bot_says("Te llega ahora mismo la confirmación por WhatsApp al número que me has dado. "
               "Muchas gracias por llamar a Chimac Peluqueros. ¡Que tengas muy buen día!")
    await s.tool(TOOL_END_CALL, {})
    out(f"\nPasos recorridos: {' → '.join(s.phases)}. Citas: {len(s.state.bookings)}. Colgado: {s.ended}.")
    return s


async def run_guards(out=print) -> SimSession:
    """G3, G5 y G4: lo que el código impide aunque el modelo se equivoque."""
    s = SimSession(out=out)
    day = first_open_day(s.fake)
    customer = {"customer_name": "Prueba", "customer_surnames": "Simulada", "phone": "600000123",
                "confirmed_by_customer": True}
    s.user_says("Barba el día que sea por la mañana, a las doce")
    out("-- G3: el modelo intenta reservar sin haber bloqueado ninguna hora")
    await s.tool(TOOL_BOOK, customer)
    await s.tool(TOOL_AVAILABILITY, {"action": "discover", "service_id": 0, "date": day.isoformat(),
                                     "time_period": "morning", "preferred_time": "12:00"}, before="Un momento.")
    await s.tool(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1}, before="Te aparto esa hora.")
    out("-- G5: el modelo intenta reservar sin decir el resumen")
    await s.tool(TOOL_BOOK, customer)
    s.bot_says(s.summary_sentence(0, "Prueba Simulada", "600000123"))
    s.user_says("Sí")
    await s.tool(TOOL_BOOK, customer, before="Creo la cita.")
    out("-- G4: el modelo repite la reserva")
    await s.tool(TOOL_BOOK, customer)
    books = sum(1 for kind, _ in s.fake.requests if kind == "book")
    out(f"\nPeticiones de reserva que llegaron al middleware: {books} (esperado: 1).")
    return s


def print_sizes(out=print) -> None:
    tools = len(json.dumps(TOOL_SCHEMAS, ensure_ascii=False))
    core = len(core_text())
    out(f"Herramientas: {tools} car.; núcleo: {core} car. (≈{round((core + tools) / 3.4)}–{round((core + tools) / 2.9)} tokens con herramientas)")
    for phase in Phase:
        total = core + len(step_text(phase)) + tools
        out(f"  {phase.value:<9} núcleo+paso+herramientas: {total:>6} car. ≈ {round(total / 3.4)}–{round(total / 2.9)} tokens")
    full = len(full_text()) + tools
    out(f"  completo  {full:>6} car. ≈ {round(full / 3.4)}–{round(full / 2.9)} tokens")
    out("Mínimo cacheable de Haiku 4.5: 4.096 tokens (el núcleo con herramientas debe superarlo).")


# ── modo interactivo ───────────────────────────────────────────────────────

def _parse_kv(parts: list[str]) -> dict[str, Any]:
    args: dict[str, Any] = {}
    for p in parts:
        k, _, v = p.partition("=")
        args[k] = int(v) if v.isdigit() and k not in ("date", "date_from") else v
    return args


async def interactive_fake(s: SimSession) -> None:
    s.out("Escribe lo que dice el cliente. Para el agente: /bot texto, /discover k=v…, /scan k=v…, "
          "/more, /lock N, /reserva nombre apellidos telefono, /colgar, /guia, /salir")
    while not s.ended:
        try:
            line = input("> ").strip()
        except EOFError:
            break
        if not line:
            continue
        if not line.startswith("/"):
            s.user_says(line)
            continue
        cmd, *rest = shlex.split(line)
        if cmd == "/salir":
            break
        if cmd == "/bot":
            s.bot_says(" ".join(rest))
        elif cmd in ("/discover", "/scan"):
            await s.tool(TOOL_AVAILABILITY, {"action": cmd[1:], **_parse_kv(rest)})
        elif cmd == "/more":
            await s.tool(TOOL_AVAILABILITY, {"action": "more"})
        elif cmd == "/lock" and rest:
            await s.tool(TOOL_AVAILABILITY, {"action": "lock", "option_index": int(rest[0])})
        elif cmd == "/reserva" and len(rest) >= 3:
            await s.tool(TOOL_BOOK, {"customer_name": rest[0], "customer_surnames": " ".join(rest[1:-1]),
                                     "phone": rest[-1], "confirmed_by_customer": True})
        elif cmd == "/colgar":
            await s.tool(TOOL_END_CALL, {})
        elif cmd == "/guia":
            s.verbose = True
            s.show_guidance()
        else:
            s.out("comando no reconocido")


class BudgetExceeded(RuntimeError):
    """Se ha alcanzado el tope de gasto de la ejecución."""


class Budget:
    """Tope de gasto en USD (estimado con precios.json) y uso acumulado."""

    def __init__(self, cap_usd: float, model: str):
        self.cap_usd = cap_usd
        self.model = model
        self.spent_usd = 0.0
        self.usage = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "calls": 0}

    def check(self) -> None:
        if self.spent_usd >= self.cap_usd:
            raise BudgetExceeded(f"tope de gasto alcanzado ({self.spent_usd:.4f} de {self.cap_usd:.2f} USD)")

    def add(self, usage: Any) -> dict[str, int]:
        from voice_agent.precios import llm_cost

        u = {
            "input": int(getattr(usage, "input_tokens", 0) or 0),
            "cache_read": int(getattr(usage, "cache_read_input_tokens", 0) or 0),
            "cache_write": int(getattr(usage, "cache_creation_input_tokens", 0) or 0),
            "output": int(getattr(usage, "output_tokens", 0) or 0),
        }
        for k, v in u.items():
            self.usage[k] += v
        self.usage["calls"] += 1
        self.spent_usd += llm_cost(self.model, u["input"], u["cache_read"], u["cache_write"], u["output"])
        return u


def model_tools() -> list[dict[str, Any]]:
    return [{"name": t["name"], "description": t["description"], "input_schema": t["input_schema"]} for t in TOOL_SCHEMAS]


async def agent_turn(s: SimSession, client: Any, model: str, budget: Budget, max_calls: int = 6) -> dict[str, Any]:
    """Un turno del agente con el modelo REAL (o uno falso con la misma interfaz).

    Llama al modelo, ejecuta sus herramientas contra el middleware de la sesión y repite
    hasta que contesta sin herramientas. Devuelve textos, herramientas y uso de tokens.
    """
    turn: dict[str, Any] = {"texts": [], "tools": [], "usage": []}
    for _ in range(max_calls):
        budget.check()
        params = s.request_params()
        resp = await client.messages.create(model=model, max_tokens=300, temperature=0, tools=model_tools(), **params)
        u = budget.add(resp.usage)
        turn["usage"].append(u)
        s.out(f"   [tokens: entrada {u['input']}, caché leída {u['cache_read']}, caché escrita {u['cache_write']}, "
              f"salida {u['output']}]")
        content = [b.model_dump(exclude_none=True) for b in resp.content]
        s.history.append({"role": "assistant", "content": content})
        text = " ".join(b["text"] for b in content if b["type"] == "text").strip()
        if text:
            s.out(f"agente> {text}")
            s.state.on_assistant_text(text)
            turn["texts"].append(text)
        uses = [b for b in content if b["type"] == "tool_use"]
        if not uses:
            break
        results = []
        for use in uses:
            result = await s.executor.execute(use["name"], use["input"])
            turn["tools"].append({"tool": use["name"], "action": use["input"].get("action", use["name"]),
                                  "args": dict(use["input"]), "outcome": result.get("outcome"),
                                  "local_guard": bool(result.get("local_guard"))})
            s.out(f"   [{use['name']} {json.dumps(use['input'], ensure_ascii=False)} → {result.get('outcome')}]")
            results.append({"type": "tool_result", "tool_use_id": use["id"],
                            "content": json.dumps(result, ensure_ascii=False)})
        s.history.append({"role": "user", "content": results})
        s._track_phase()
        if s.ended:
            break
    return turn


async def interactive_real(s: SimSession, model: str, cap_usd: float = 0.25) -> None:
    """Haiku de verdad contra el middleware FALSO. Solo con ANTHROPIC_API_KEY."""
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"], timeout=15.0, max_retries=1)
    budget = Budget(cap_usd, model)
    s.out(f"Habla como el cliente (escribe /salir para terminar). Tope de gasto: {cap_usd:.2f} USD.")
    while not s.ended:
        try:
            line = input("cliente> ").strip()
        except EOFError:
            break
        if line == "/salir":
            break
        s.state.on_user_text(line or "...")
        s.history.append({"role": "user", "content": line or "..."})
        try:
            await agent_turn(s, client, model, budget)
        except BudgetExceeded as exc:
            s.out(str(exc))
            break


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m voice_agent.sim", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--demo", action="store_true")
    mode.add_argument("--guardas", action="store_true")
    mode.add_argument("--interactivo", action="store_true")
    mode.add_argument("--tamanos", action="store_true")
    parser.add_argument("--llm", choices=("fake", "real"), default="fake")
    parser.add_argument("--estrategia", choices=("nodos", "completo"), default="nodos")
    parser.add_argument("--modelo", default="claude-haiku-4-5")
    parser.add_argument("--verbose", action="store_true", help="muestra el bloque <guia> de cada turno")
    args = parser.parse_args(argv)
    from voice_agent.logging_setup import configure_logging

    configure_logging(os.environ.get("LOG_LEVEL", "INFO"))

    if args.tamanos:
        print_sizes()
        return 0
    if args.guardas:
        asyncio.run(run_guards())
        return 0
    if args.interactivo:
        s = SimSession(args.estrategia, args.verbose)
        if args.llm == "real":
            if not os.environ.get("ANTHROPIC_API_KEY"):
                print("No hay ANTHROPIC_API_KEY: usa --llm fake.", file=sys.stderr)
                return 2
            asyncio.run(interactive_real(s, args.modelo))
        else:
            asyncio.run(interactive_fake(s))
        return 0
    if args.llm == "real":
        print("El guion --demo usa siempre el LLM falso; para Haiku usa --interactivo --llm real.", file=sys.stderr)
    asyncio.run(run_demo(args.estrategia, args.verbose))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
