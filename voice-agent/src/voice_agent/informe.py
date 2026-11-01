"""Informe diario a partir del registro JSONL: ``python -m voice_agent.informe``.

Solo cifras agregadas: nunca copia textos de la conversación, nombres ni teléfonos.

- Llamadas, duración (media, p50, p95, minutos totales), reservas y cómo terminaron.
- Resultados de las herramientas, fallos de transporte y protecciones locales.
- Latencia por turno (desde el fin de turno detectado y desde el fin de voz del VAD) y
  TTFB por servicio (Deepgram, Haiku, TTS), p50 y p95.
- Tokens y coste estimado por proveedor (precios.json, a confirmar).
- Llamadas desviadas por desbordamiento o con el agente apagado (servidor-*.jsonl).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from voice_agent.precios import llm_cost, stt_cost, tts_cost

TZ = ZoneInfo("Europe/Madrid")


def percentile(values: list[float], p: float) -> float | None:
    """Percentil por rango más cercano (None si no hay datos)."""
    if not values:
        return None
    ordered = sorted(values)
    k = max(0, math.ceil(p / 100 * len(ordered)) - 1)
    return ordered[k]


def _read(path: Path) -> list[dict[str, Any]]:
    records = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict):
                records.append(record)
    return records


def _local_day(at: str | None) -> date | None:
    if not at:
        return None
    try:
        return datetime.fromisoformat(at).astimezone(TZ).date()
    except ValueError:
        return None


def load_day(directory: Path, day: date) -> tuple[list[list[dict[str, Any]]], list[dict[str, Any]]]:
    """Llamadas (lista de registros por llamada) y eventos del servidor del día (hora de Madrid)."""
    calls: list[list[dict[str, Any]]] = []
    events: list[dict[str, Any]] = []
    if not directory.is_dir():
        return calls, events
    # Los ficheros llevan la fecha UTC: se miran el día, el anterior y el siguiente.
    names = {(day + timedelta(days=d)).isoformat() for d in (-1, 0, 1)}
    for path in sorted(directory.glob("*.jsonl")):
        if path.name.startswith("servidor-"):
            if path.name[9:19] in names:
                events += [e for e in _read(path) if _local_day(e.get("at")) == day]
            continue
        if path.name[:10] not in names:
            continue
        records = _read(path)
        start = next((r for r in records if r.get("kind") == "start"), records[0] if records else None)
        if start and _local_day(start.get("at")) == day:
            calls.append(records)
    return calls, events


def summarize(calls: list[list[dict[str, Any]]], events: list[dict[str, Any]]) -> dict[str, Any]:
    durations, latencies_turn, latencies_vad, latencies_voice, flux_decisions = [], [], [], [], []
    turn_modes: Counter[str] = Counter()
    ttfb: dict[str, list[float]] = defaultdict(list)
    end_reasons: Counter[str] = Counter()
    finishes: Counter[str] = Counter()
    tool_outcomes: Counter[str] = Counter()
    transport_errors: Counter[str] = Counter()
    guards = 0
    bookings = 0
    tokens = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "turns": 0}
    cost = {"llm": 0.0, "stt": 0.0, "tts": 0.0}
    tts_chars: Counter[str] = Counter()
    cached_calls = 0

    for records in calls:
        start = next((r for r in records if r.get("kind") == "start"), {})
        end = next((r for r in records if r.get("kind") == "end"), None)
        duration = float(end.get("duration_s", 0)) if end else float(max((r.get("t", 0) for r in records), default=0))
        durations.append(duration)
        end_reasons[str(end.get("reason")) if end else "sin_cierre"] += 1
        model = start.get("llm", "claude-haiku-4-5")
        stt_model = f"deepgram:{start.get('stt', 'nova-3')}"
        tts = start.get("tts", "azure")
        turn_modes[str(start.get("turn_detection", "desconocido"))] += 1
        call_cache_read = 0
        for r in records:
            kind = r.get("kind")
            if kind == "finish":
                finishes[str(r.get("reason"))] += 1
            elif kind == "tool":
                label = f"{r.get('tool')}:{r.get('action')}→{r.get('outcome')}"
                if not r.get("replayed"):
                    tool_outcomes[label] += 1
                if r.get("tool") == "reserva" and r.get("outcome") == "confirmed" and not r.get("replayed"):
                    bookings += 1
                if r.get("transport_error"):
                    transport_errors[str(r.get("transport_error"))] += 1
                if r.get("local_guard"):
                    guards += 1
            elif kind == "turn_latency":
                if r.get("ms_desde_fin_turno") is not None:
                    latencies_turn.append(float(r["ms_desde_fin_turno"]))
                if r.get("ms_desde_vad") is not None:
                    latencies_vad.append(float(r["ms_desde_vad"]))
                if r.get("ms_desde_fin_voz") is not None:
                    latencies_voice.append(float(r["ms_desde_fin_voz"]))
                if r.get("ms_decision_stt") is not None:
                    flux_decisions.append(float(r["ms_decision_stt"]))
            elif kind == "ttfb":
                ttfb[str(r.get("service"))].append(float(r.get("ms", 0)))
            elif kind == "llm_usage":
                # Con Anthropic, prompt_tokens es NETO (sin la caché): Pipecat lo pasa tal cual
                # (services/anthropic/llm.py, _report_usage_metrics). Es la entrada sin caché.
                read = int(r.get("cache_read_input_tokens") or 0)
                write = int(r.get("cache_creation_input_tokens") or 0)
                uncached = int(r.get("prompt_tokens") or 0)
                out = int(r.get("completion_tokens") or 0)
                tokens["input"] += uncached
                tokens["cache_read"] += read
                tokens["cache_write"] += write
                tokens["output"] += out
                tokens["turns"] += 1
                call_cache_read += read
                cost["llm"] += llm_cost(model, uncached, read, write, out)
            elif kind == "bot":
                tts_chars[tts] += int(r.get("chars") or 0)
        cost["stt"] += stt_cost(stt_model, duration / 60)
        if call_cache_read > 0:
            cached_calls += 1
    for provider, chars in tts_chars.items():
        cost["tts"] += tts_cost(provider, chars)
    minutes = sum(durations) / 60
    event_counts = Counter(str(e.get("kind")) for e in events)
    total_cost = sum(cost.values())
    return {
        "llamadas": len(calls),
        "duracion_media_s": round(sum(durations) / len(durations), 1) if durations else None,
        "duracion_p50_s": percentile(durations, 50),
        "duracion_p95_s": percentile(durations, 95),
        "minutos": round(minutes, 2),
        "reservas": bookings,
        "fin": dict(end_reasons),
        "cierre_por_el_agente": dict(finishes),
        "herramientas": dict(tool_outcomes),
        "errores_transporte": dict(transport_errors),
        "protecciones_locales": guards,
        "latencia_turno_ms": {"p50": percentile(latencies_turn, 50), "p95": percentile(latencies_turn, 95),
                              "n": len(latencies_turn)},
        "latencia_desde_vad_ms": {"p50": percentile(latencies_vad, 50), "p95": percentile(latencies_vad, 95),
                                  "n": len(latencies_vad)},
        "latencia_fin_voz_ms": {"p50": percentile(latencies_voice, 50), "p95": percentile(latencies_voice, 95),
                                "n": len(latencies_voice)},
        "decision_flux_ms": {"p50": percentile(flux_decisions, 50), "p95": percentile(flux_decisions, 95),
                             "n": len(flux_decisions)},
        "modos_fin_turno": dict(turn_modes),
        "ttfb_ms": {k: {"p50": percentile(v, 50), "p95": percentile(v, 95), "n": len(v)} for k, v in sorted(ttfb.items())},
        "tokens": tokens,
        "llamadas_con_cache": cached_calls,
        "caracteres_tts": dict(tts_chars),
        "coste_usd": {k: round(v, 4) for k, v in cost.items()} | {"total": round(total_cost, 4)},
        "coste_por_minuto_usd": round(total_cost / minutes, 4) if minutes else None,
        "servidor": dict(event_counts),
        "desviadas": sum(v for k, v in event_counts.items() if k.startswith("desviada_")),
    }


def _fmt(v: Any) -> str:
    return "—" if v is None else (f"{v:.0f}" if isinstance(v, float) else str(v))


def render(day: date, s: dict[str, Any]) -> str:
    lines = [
        f"# Informe del agente de voz — {day.isoformat()} (hora de Madrid)",
        "",
        "Solo cifras agregadas; sin textos ni datos personales. Costes estimados con `precios.json` (a confirmar). "
        "Twilio no está incluido.",
        "",
        "| Dato | Valor |",
        "|---|---|",
        f"| Llamadas atendidas | {s['llamadas']} |",
        f"| Desviadas (desborde o agente apagado) | {s['desviadas']} |",
        f"| Duración media / p50 / p95 (s) | {_fmt(s['duracion_media_s'])} / {_fmt(s['duracion_p50_s'])} / {_fmt(s['duracion_p95_s'])} |",
        f"| Minutos totales | {s['minutos']} |",
        f"| Reservas confirmadas | {s['reservas']} |",
        f"| **Latencia por turno p50 / p95 (ms, desde fin de voz, estimada y comparable entre modos)** | {_fmt(s['latencia_fin_voz_ms']['p50'])} / {_fmt(s['latencia_fin_voz_ms']['p95'])} (n={s['latencia_fin_voz_ms']['n']}) |",
        f"| Latencia por turno p50 / p95 (ms, desde fin de turno) | {_fmt(s['latencia_turno_ms']['p50'])} / {_fmt(s['latencia_turno_ms']['p95'])} (n={s['latencia_turno_ms']['n']}) |",
        f"| Latencia por turno p50 / p95 (ms, desde fin de voz VAD) | {_fmt(s['latencia_desde_vad_ms']['p50'])} / {_fmt(s['latencia_desde_vad_ms']['p95'])} (n={s['latencia_desde_vad_ms']['n']}) |",
        f"| Llamadas con caché de prompt activa | {s['llamadas_con_cache']} de {s['llamadas']} |",
        f"| Coste estimado (USD) | LLM {s['coste_usd']['llm']} · STT {s['coste_usd']['stt']} · TTS {s['coste_usd']['tts']} · total {s['coste_usd']['total']} |",
        f"| Coste por minuto (USD) | {_fmt(s['coste_por_minuto_usd']) if s['coste_por_minuto_usd'] is None else s['coste_por_minuto_usd']} |",
        f"| Modo de fin de turno (llamadas) | {', '.join(f'{k} {v}' for k, v in sorted(s['modos_fin_turno'].items())) or '—'} |",
        "",
        "Objetivo de latencia: p50 ≤ 900 ms y p95 ≤ 1.500 ms de voz a voz. «Desde fin de voz» suma a la "
        "latencia medida el silencio que espera el VAD (0,2 s) o lo que tardó Flux en cerrar el turno; no "
        "incluye la red ni el búfer de Twilio, así que la cifra real es algo mayor.",
        "",
    ]
    if s["modos_fin_turno"].get("deepgram_flux"):
        d = s["decision_flux_ms"]
        lines += [
            f"> **Nota (deepgram_flux):** con Flux, «desde fin de turno» NO incluye lo que tarda Flux en "
            f"decidir que el cliente ha terminado, así que subestima la latencia. La fila «desde fin de voz» "
            f"lo suma, estimado con las marcas de tiempo de las palabras (`audio_window_end` − fin de la "
            f"última palabra; p50 {_fmt(d['p50'])} / p95 {_fmt(d['p95'])} ms, n={d['n']}). Para comparar Flux con "
            f"otro modo, la referencia es la grabación voz a voz en el teléfono ((internal doc, not included in the template) §3 bis).",
            "",
        ]
    lines += [
        "## TTFB por servicio (ms)",
        "",
        "| Servicio | p50 | p95 | n |",
        "|---|---:|---:|---:|",
    ]
    lines += [f"| {k} | {_fmt(v['p50'])} | {_fmt(v['p95'])} | {v['n']} |" for k, v in s["ttfb_ms"].items()] or ["| — | | | |"]
    t = s["tokens"]
    lines += [
        "",
        "## Tokens de Haiku",
        "",
        f"Entrada sin caché {t['input']} · caché leída {t['cache_read']} · caché escrita {t['cache_write']} · salida {t['output']} · turnos {t['turns']}",
        "",
        "## Cómo terminaron",
        "",
    ]
    lines += [f"- {k}: {v}" for k, v in sorted(s["fin"].items())] or ["- —"]
    lines += [f"- cierre del agente «{k}»: {v}" for k, v in sorted(s["cierre_por_el_agente"].items())]
    lines += ["", "## Resultados de herramientas", ""]
    lines += [f"- {k}: {v}" for k, v in sorted(s["herramientas"].items())] or ["- —"]
    if s["errores_transporte"]:
        lines += ["", "Errores de transporte con el middleware: " + ", ".join(f"{k} {v}" for k, v in s["errores_transporte"].items())]
    lines += ["", f"Protecciones locales activadas (G3/G5): {s['protecciones_locales']}"]
    if s["servidor"]:
        lines += ["", "## Servidor", ""] + [f"- {k}: {v}" for k, v in sorted(s["servidor"].items())]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m voice_agent.informe", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", default=os.environ.get("CALL_LOG_DIR", "/var/lib/demo-salon-voice/calls"))
    parser.add_argument("--fecha", default=None, help="AAAA-MM-DD (por defecto, hoy en Madrid)")
    parser.add_argument("--ayer", action="store_true", help="informe de ayer")
    parser.add_argument("--json", action="store_true", help="salida en JSON")
    parser.add_argument("--salida", default=None, help="fichero donde escribirlo (por defecto, pantalla)")
    args = parser.parse_args(argv)
    today = datetime.now(TZ).date()
    try:
        day = date.fromisoformat(args.fecha) if args.fecha else today - timedelta(days=1 if args.ayer else 0)
    except ValueError:
        print("--fecha debe ser AAAA-MM-DD", file=sys.stderr)
        return 2
    directory = Path(args.dir)
    if not directory.is_dir():
        print(f"No existe el directorio de registros: {directory}", file=sys.stderr)
        return 2
    calls, events = load_day(directory, day)
    summary = summarize(calls, events)
    text = json.dumps(summary, ensure_ascii=False, indent=2) if args.json else render(day, summary)
    if args.salida:
        Path(args.salida).write_text(text, encoding="utf-8")
        print(f"Informe escrito en {args.salida}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
