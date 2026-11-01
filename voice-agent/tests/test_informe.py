"""Informe diario a partir del JSONL: cifras correctas y sin datos personales."""

from __future__ import annotations

import json
from datetime import date

from fastapi.testclient import TestClient

from voice_agent.calllog import CallLog, server_event
from voice_agent.config import load_settings
from voice_agent.informe import load_day, main, percentile, render, summarize

DAY = date(2026, 10, 6)


def _write_call(directory, conv: str, at: str, *, booked: bool, duration: float, latencies: list[int],
                cache_read: int, tts: str = "azure") -> None:
    path = directory / f"{at[:10]}_{conv}.jsonl"
    records = [
        {"t": 0, "at": at, "kind": "start", "tts": tts, "llm": "claude-haiku-4-5", "stt": "nova-3",
         "prompt_strategy": "nodos"},
        {"t": 1, "at": at, "kind": "user", "text": "[datos personales omitidos]"},
        {"t": 2, "at": at, "kind": "bot", "text": "Lo miro.", "interrupted": False, "chars": 600},
        {"t": 3, "at": at, "kind": "llm_usage", "prompt_tokens": 400, "completion_tokens": 50,
         "cache_read_input_tokens": cache_read, "cache_creation_input_tokens": 100},
        {"t": 3, "at": at, "kind": "ttfb", "service": "AnthropicLLMService", "ms": 420},
        {"t": 3, "at": at, "kind": "ttfb", "service": "AzureTTSService", "ms": 130},
        {"t": 4, "at": at, "kind": "tool", "tool": "disponibilidad", "action": "discover", "outcome": "options_available"},
        {"t": 4, "at": at, "kind": "tool", "tool": "disponibilidad", "action": "discover", "outcome": "agenda_unavailable",
         "transport_error": "timeout"},
    ]
    records += [{"t": 5, "at": at, "kind": "turn_latency", "ms_desde_fin_turno": ms, "ms_desde_vad": ms + 200}
                for ms in latencies]
    if booked:
        records.append({"t": 6, "at": at, "kind": "tool", "tool": "reserva", "action": "reserva", "outcome": "confirmed"})
        records.append({"t": 6, "at": at, "kind": "tool", "tool": "reserva", "action": "reserva", "outcome": "confirmed",
                        "replayed": True})
    records.append({"t": 7, "at": at, "kind": "finish", "reason": "end_call"})
    records.append({"t": duration, "at": at, "kind": "end", "reason": "completed", "duration_s": duration})
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n", encoding="utf-8")


def _setup(tmp_path):
    _write_call(tmp_path, "tw_CA1", "2026-10-06T08:00:00+00:00", booked=True, duration=60, latencies=[700, 900, 1500],
                cache_read=7000)
    _write_call(tmp_path, "tw_CA2", "2026-10-06T21:30:00+00:00", booked=False, duration=120, latencies=[800],
                cache_read=0)  # 23:30 en Madrid: sigue siendo el día 6
    _write_call(tmp_path, "tw_CA3", "2026-10-06T22:30:00+00:00", booked=True, duration=30, latencies=[600],
                cache_read=7000)  # 00:30 del día 7 en Madrid: NO entra
    (tmp_path / "servidor-2026-10-06.jsonl").write_text(
        "\n".join(json.dumps({"at": "2026-10-06T10:00:00+00:00", "kind": k})
                  for k in ("aceptada", "aceptada", "desviada_desborde_dial", "desviada_apagado_reject")) + "\n")


def test_percentile_nearest_rank():
    assert percentile([], 50) is None
    assert percentile([700, 900, 1500, 800], 50) == 800
    assert percentile([700, 900, 1500, 800], 95) == 1500


def test_summary_figures(tmp_path):
    _setup(tmp_path)
    calls, events = load_day(tmp_path, DAY)
    s = summarize(calls, events)
    assert s["llamadas"] == 2
    assert s["reservas"] == 1  # la repetida (replayed) no cuenta
    assert s["minutos"] == 3.0
    assert s["duracion_p95_s"] == 120
    assert s["latencia_turno_ms"] == {"p50": 800, "p95": 1500, "n": 4}
    assert s["latencia_desde_vad_ms"]["p50"] == 1000
    assert s["ttfb_ms"]["AnthropicLLMService"]["p50"] == 420
    assert s["tokens"]["input"] == 800 and s["tokens"]["cache_read"] == 7000
    assert s["llamadas_con_cache"] == 1
    assert s["errores_transporte"] == {"timeout": 2}
    assert s["desviadas"] == 2
    assert s["coste_usd"]["stt"] > 0 and s["coste_usd"]["tts"] > 0 and s["coste_usd"]["llm"] > 0
    assert s["coste_por_minuto_usd"] > 0


def test_report_has_no_personal_data(tmp_path):
    _setup(tmp_path)
    log = CallLog(str(tmp_path), "tw_CA9")  # registro real con datos (ficticios) escrito por CallLog
    log.write("start", tts="azure", llm="claude-haiku-4-5", stt="nova-3")
    log.user("Ana Pérez, 600 123 456", personal=True)
    log.user("sí, el 600-123-456")
    log.bot("Te resumo: corte, a nombre de Ana Pérez, teléfono seis, cero, cero. ¿Confirmas que quieres reservar?")
    log.end("completed")
    stored = log.path.read_text(encoding="utf-8")
    day = date.fromisoformat(log.path.name[:10])
    text = render(day, summarize(*load_day(tmp_path, day)))
    for secret in ("Ana", "Pérez", "600", "seis"):
        assert secret not in stored
        assert secret not in text


def test_cli(tmp_path, capsys):
    _setup(tmp_path)
    assert main(["--dir", str(tmp_path), "--fecha", "2026-10-06"]) == 0
    out = capsys.readouterr().out
    assert "Llamadas atendidas | 2" in out and "Desviadas (desborde o agente apagado) | 2" in out
    assert main(["--dir", str(tmp_path), "--fecha", "2026-10-06", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["reservas"] == 1
    assert main(["--dir", str(tmp_path / "no-existe")]) == 2
    assert main(["--dir", str(tmp_path), "--fecha", "ayer"]) == 2


def test_empty_day(tmp_path):
    s = summarize(*load_day(tmp_path, DAY))
    assert s["llamadas"] == 0 and s["coste_por_minuto_usd"] is None
    assert "Llamadas atendidas | 0" in render(DAY, s)


def test_server_events_written_without_identifiers(tmp_path, real_env):
    real_env.update(CALL_LOG_DIR=str(tmp_path), MAX_CONCURRENT_CALLS="1", FALLBACK_DIAL_NUMBER="+34900000000")
    from .test_server_twilio import call_params, post_call

    with TestClient(__import__("voice_agent.server", fromlist=["create_app"]).create_app(
            load_settings(real_env), middleware=object())) as client:
        post_call(client, call_params("CA1"))
        post_call(client, call_params("CA2"))
        post_call(client, call_params("CA3"), signature="mala")
    content = "".join(p.read_text() for p in tmp_path.glob("servidor-*.jsonl"))
    kinds = [json.loads(l)["kind"] for l in content.splitlines()]
    assert kinds == ["aceptada", "desviada_desborde_dial", "firma_rechazada"]
    assert "CA1" not in content and "+34" not in content
    server_event(None, "nada")  # sin directorio no escribe ni falla
