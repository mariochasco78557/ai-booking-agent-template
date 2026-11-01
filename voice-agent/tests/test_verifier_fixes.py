"""Arreglos pedidos por la verificación del 2026-10-04 (un bloque por punto)."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voice_agent.calllog import NUMBER_MASK, PERSONAL_OMITTED, SUMMARY_OMITTED, CallLog, redact_numbers
from voice_agent.config import ConfigError, load_settings
from voice_agent.prompts import BUSQUEDA, PASOS, guidance
from voice_agent.state import CallState, Phase
from voice_agent.tools import TOOL_AVAILABILITY, TOOL_BOOK, ToolExecutor

from .test_state_and_tools import CONV, SLOT, SUMMARY, FakeAPI

ROOT = Path(__file__).resolve().parents[1]
CUSTOMER = {"customer_name": "Prueba", "customer_surnames": "Uno", "confirmed_by_customer": True}


# ── 1. invalid_customer_data no gasta la hora ──────────────────────────────

async def test_invalid_customer_data_allows_correct_and_rebook():
    api = FakeAPI(
        availability=[{"outcome": "locked", "slot": SLOT}],
        book=[
            {"booked": False, "outcome": "invalid_customer_data", "message": "Me falta algún dato."},
            {"booked": True, "outcome": "confirmed", "booking_number": 1, "max_bookings_per_call": 3},
        ],
    )
    ex = ToolExecutor(CallState(conversation_id=CONV), api)
    s = ex.state
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    s.on_assistant_text("¿Me dices tu nombre, apellidos y un teléfono de contacto?")
    s.on_user_text("Prueba Uno, el doce")
    s.on_assistant_text(SUMMARY)
    s.on_user_text("Sí")
    first = await ex.execute(TOOL_BOOK, {**CUSTOMER, "phone": "12"})
    assert first["outcome"] == "invalid_customer_data"
    # vuelve a pedir datos: paso DATOS, sin el aviso de «ya tienes los datos»
    assert s.phase == Phase.DATOS
    text = guidance(s, datetime(2026, 10, 6, 10, tzinfo=ZoneInfo("Europe/Madrid")))
    assert "rechazado los datos" in text and "Ya tienes nombre" not in text
    # sin resumen nuevo no se vuelve a crear
    early = await ex.execute(TOOL_BOOK, {**CUSTOMER, "phone": "600000123"})
    assert early["outcome"] == "not_confirmed" and early["local_guard"]
    s.on_assistant_text("¿Me dices tu nombre, apellidos y un teléfono de contacto?")
    s.on_user_text("seis cero cero, cero cero cero, uno dos tres")
    s.on_assistant_text(SUMMARY)
    s.on_user_text("Sí")
    second = await ex.execute(TOOL_BOOK, {**CUSTOMER, "phone": "600000123"})
    assert second["outcome"] == "confirmed" and "replayed" not in second
    books = [c for c in api.calls if c[0] == "book"]
    assert len(books) == 2  # la segunda SÍ llega al middleware
    assert books[0][2]["phone"] == "12" and books[1][2]["phone"] == "600000123"
    assert books[0][2]["slot_token"] == books[1][2]["slot_token"] == "tk1.A"


@pytest.mark.parametrize("outcome", ["upstream_error", "write_disabled", "misconfigured_owner"])
async def test_non_terminal_outcomes_are_not_replayed(outcome):
    api = FakeAPI(availability=[{"outcome": "locked", "slot": SLOT}],
                  book=[{"booked": False, "outcome": outcome}, {"booked": False, "outcome": outcome}])
    ex = ToolExecutor(CallState(conversation_id=CONV), api)
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    ex.state.on_assistant_text(SUMMARY)
    ex.state.on_user_text("Sí")
    await ex.execute(TOOL_BOOK, {**CUSTOMER, "phone": "600000123"})
    again = await ex.execute(TOOL_BOOK, {**CUSTOMER, "phone": "600000123"})
    assert "replayed" not in again
    assert sum(1 for c in api.calls if c[0] == "book") == 2


# ── 2. registro técnico sin texto del cliente ──────────────────────────────

@pytest.fixture
def captured_logs():
    from loguru import logger

    from voice_agent.logging_setup import configure_logging

    lines: list[str] = []
    configure_logging("INFO", sink=lambda message: lines.append(str(message)))
    yield logger, lines
    configure_logging("WARNING")


def test_debug_context_is_not_emitted_at_info(captured_logs):
    logger, lines = captured_logs
    logger.debug("Generating chat from context [{'role': 'user', 'content': 'Me llamo Ana Pérez'}]")
    logger.info("servicio arrancado")
    assert lines == [lines[0]] and "servicio arrancado" in lines[0]
    assert not any("Ana" in line for line in lines)


def test_frame_text_in_warnings_and_errors_is_scrubbed(captured_logs):
    from pipecat.frames.frames import TranscriptionFrame

    logger, lines = captured_logs
    frame = TranscriptionFrame(text="Me llamo Ana Pérez, 600 123 456", user_id="u", timestamp="t")
    logger.error(f"AzureTTSService#0: exception processing {frame}: boom")
    logger.warning("AzureTTSService#0: service is no longer usable, not speaking [teléfono seis, cero]")
    logger.warning("mi número es 600-123-456")
    joined = "\n".join(lines)
    assert "Ana" not in joined and "600" not in joined and "seis" not in joined
    assert "text: [omitido]" in joined and "not speaking [omitido]" in joined


def test_logging_defaults_and_level_from_env():
    assert load_settings({}).log_level == "info"
    assert load_settings({"LOG_LEVEL": "warning"}).log_level == "warning"
    with pytest.raises(ConfigError):
        load_settings({"LOG_LEVEL": "trace"})


PIPECAT = Path(__import__("pipecat").__file__).parent
USED_MODULES = [
    "services/anthropic", "services/deepgram", "services/azure", "services/elevenlabs", "services/cartesia",
    "services/tts_service.py", "services/stt_service.py", "services/llm_service.py", "services/ai_service.py",
    "processors/aggregators", "transports/websocket", "transports/base_input.py", "transports/base_output.py",
    "serializers/twilio.py", "turns", "audio/turn", "audio/vad", "pipeline", "workers", "adapters",
]
_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")
_TEXT_NAMES = {"text", "transcript", "transcription", "context", "message", "messages", "content",
               "arguments", "argument", "prepared_text", "sentence", "utterance", "frame"}


class _Suspicious:
    """¿Formatea el log un valor que puede llevar texto de la conversación?

    No cuentan len(...), type(...) ni atributos de identificador (message.job_id).
    """

    @staticmethod
    def search(call: str) -> bool:
        for raw in _PLACEHOLDER.findall(call):
            expr = raw.split("!")[0].split(":")[0].strip()
            if expr.startswith(("len(", "type(")):
                continue
            last = re.split(r"[.\[]", expr.rstrip("]'\""))[-1].strip("'\" ")
            if last in _TEXT_NAMES or expr in _TEXT_NAMES:
                return True
        return False


SUSPICIOUS = _Suspicious()
# Avisos/errores de Pipecat que SÍ pueden llevar texto, revisados uno a uno:
KNOWN_SCRUBBED = {
    # Texto del agente que el TTS no pudo decir: el filtro lo tacha («not speaking [omitido]»).
    "not speaking [{prepared_text}]",
    # Mensaje del PROVEEDOR que no es JSON (no es la conversación); solo con TTS Deepgram.
    # El filtro tacha además cualquier teléfono.
    "Invalid JSON message: {message}",
    # STT de ElevenLabs/Cartesia (no se usan: el STT es Deepgram).
    "Received non-JSON message: {message}",
    # Adaptador de AWS Nova Sonic (no se usa).
    "Unhandled content type in context message",
    # repr de un frame (errores del servicio, del transporte o del worker): el texto solo
    # aparece como «text: [...]», que el filtro sustituye por «text: [omitido]».
    "{frame}",
}


def _calls(source: str, levels: str):
    for match in re.finditer(rf"logger\.({levels})\(", source):
        depth, i = 1, match.end()
        while depth and i < len(source):
            depth += {"(": 1, ")": -1}.get(source[i], 0)
            i += 1
        yield source[match.start():i]


def test_pipecat_info_logs_carry_no_customer_text():
    """Auditoría del Pipecat instalado: ningún logger.info formatea texto o contexto."""
    offenders = []
    for rel in USED_MODULES:
        base = PIPECAT / rel
        for path in [base] if base.is_file() else base.rglob("*.py"):
            for call in _calls(path.read_text(encoding="utf-8"), "info|success"):
                if SUSPICIOUS.search(call):
                    offenders.append(f"{path.relative_to(PIPECAT)}: {call[:100]}")
    assert offenders == []


def test_pipecat_warning_logs_with_text_are_known_and_scrubbed():
    found = []
    for rel in USED_MODULES:
        base = PIPECAT / rel
        for path in [base] if base.is_file() else base.rglob("*.py"):
            for call in _calls(path.read_text(encoding="utf-8"), "warning|error|exception|critical"):
                if SUSPICIOUS.search(call):
                    found.append(call)
    assert all(any(k in c for k in KNOWN_SCRUBBED) for c in found), found


def test_our_code_never_logs_conversation_text():
    for path in (ROOT / "src" / "voice_agent").glob("*.py"):
        for call in _calls(path.read_text(encoding="utf-8"), "debug|info|success|warning|error|exception|critical"):
            assert not SUSPICIOUS.search(call), f"{path.name}: {call}"


# ── 3. datos personales en el registro de llamadas ─────────────────────────

@pytest.mark.parametrize(
    "text",
    ["600-123-456", "600, 123 456", "600.123.456", "+34 600 123 456", "el código 123",
     "seis cero cero uno dos tres", "seis, cero, cero; uno, dos, tres"],
)
def test_any_three_or_more_digits_are_masked(text):
    out = redact_numbers(f"mi dato es {text} gracias")
    assert NUMBER_MASK in out
    assert not re.search(r"\d", out.replace(NUMBER_MASK, ""))
    assert not re.search(r"\b(seis|cero|uno|dos|tres)\b", out)


def test_short_numbers_and_times_stay():
    assert redact_numbers("a las 10:30, opción 2, las tres y media") == "a las 10:30, opción 2, las tres y media"


def test_personal_turns_are_omitted(tmp_path):
    state = CallState(conversation_id=CONV)
    state.on_assistant_text("¿Me dices tu nombre, apellidos y un teléfono de contacto?")
    assert state.user_turn_is_personal()
    state.on_user_text("Ana Pérez García, seis cero cero...")
    assert not state.user_turn_is_personal()
    state.on_availability_result({"action": "lock", "option_index": 1}, {"outcome": "locked", "slot": SLOT})
    assert state.phase == Phase.DATOS and state.user_turn_is_personal()
    state.on_assistant_text(SUMMARY)  # el resumen no pide datos: el «sí» se registra
    assert not state.user_turn_is_personal()

    log = CallLog(str(tmp_path), CONV)
    log.user("Ana Pérez García, 600 123 456", personal=True)
    log.bot(SUMMARY)
    log.user("sí, el 600-123-456")
    log.tool({"tool": "reserva", "args": {"customer_name": "Ana", "phone": "600123456", "slot_token": "tk1.A",
                                          "customer_surnames": "Pérez"}, "outcome": "confirmed"})
    content = log.path.read_text(encoding="utf-8")
    records = [json.loads(line) for line in content.splitlines()]
    assert records[0]["text"] == PERSONAL_OMITTED
    assert records[1]["text"] == SUMMARY_OMITTED
    assert "600" not in records[2]["text"]
    for needle in ("Ana", "Pérez", "600", "tk1.A", "customer_name", "phone"):
        assert needle not in content


# ── 4. Dockerfile ──────────────────────────────────────────────────────────

def test_dockerfile_uses_system_python_and_pinned_images():
    text = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "UV_PYTHON_PREFERENCE=only-system" in text
    assert "UV_PYTHON_DOWNLOADS=never" in text
    assert "ghcr.io/astral-sh/uv:0.12.13" in text and ":latest" not in text
    assert "python:3.12-slim-bookworm" in text
    assert re.search(r"^USER voice$", text, re.M)
    assert "uv sync --frozen --no-dev" in text


# ── 5. reglas de búsqueda en DATOS, CONFIRMAR y HECHA ───────────────────────

@pytest.mark.parametrize("phase", [Phase.DATOS, Phase.CONFIRMAR, Phase.HECHA])
def test_later_steps_can_search_again(phase):
    for section in BUSQUEDA:
        assert section in PASOS[phase], (phase, section)
    assert "hora_dicha" in PASOS[phase]


def test_done_step_can_start_another_booking():
    assert {"inicio", "seleccion", "varias_citas"} <= set(PASOS[Phase.HECHA])


# ── 6. G5 exige un turno del cliente tras el resumen ────────────────────────

async def test_g5_requires_customer_turn_after_summary():
    api = FakeAPI(availability=[{"outcome": "locked", "slot": SLOT}],
                  book=[{"booked": True, "outcome": "confirmed"}])
    ex = ToolExecutor(CallState(conversation_id=CONV), api)
    await ex.execute(TOOL_AVAILABILITY, {"action": "lock", "option_index": 1})
    ex.state.on_user_text("Ana, 600000123")
    ex.state.on_assistant_text(SUMMARY)
    blocked = await ex.execute(TOOL_BOOK, {**CUSTOMER, "phone": "600000123"})
    assert blocked["outcome"] == "not_confirmed"
    assert not any(c[0] == "book" for c in api.calls)
    ex.state.on_user_text("Sí")
    ok = await ex.execute(TOOL_BOOK, {**CUSTOMER, "phone": "600000123"})
    assert ok["outcome"] == "confirmed"


# ── 7. secreto de reserva obligatorio en modo real ─────────────────────────

def test_booking_secret_required_and_long_enough(real_env):
    real_env.pop("MIDDLEWARE_BOOKING_SECRET")
    with pytest.raises(ConfigError, match="MIDDLEWARE_BOOKING_SECRET"):
        load_settings(real_env)
    real_env["MIDDLEWARE_BOOKING_SECRET"] = "corto"
    with pytest.raises(ConfigError, match="32"):
        load_settings(real_env)
    assert load_settings({}).middleware_booking_secret == ""  # offline no lo exige


# ── 8. Caddy publica solo /voice/twilio/* ───────────────────────────────────

def test_design_publishes_only_twilio_routes():
    design = (ROOT / "(internal doc, not included in the template)").read_text(encoding="utf-8")
    block = design.split("@voice_twilio path", 1)[1].split("```", 1)[0]
    assert "/voice/twilio/incoming" in block and "/voice/twilio/ws" in block
    assert "/voice/health" not in block and "/voice/*" not in design


# ── 9. read_stream_start con JSON que no es un objeto ──────────────────────

class _Runner:
    def __init__(self):
        self.calls = 0

    async def __call__(self, websocket, **kwargs):
        self.calls += 1


@pytest.mark.parametrize(
    "payload",
    ["[1, 2, 3]", '"start"', "42", "null", '{"event": "start", "start": "x"}',
     '{"event": "start", "start": {"callSid": "CA1", "customParameters": ["t"]}}', "no es json"],
)
def test_non_object_json_closes_1008(real_env, payload):
    from voice_agent.server import create_app

    runner = _Runner()
    app = create_app(load_settings(real_env), middleware=object(), call_runner=runner)
    with TestClient(app) as client:
        with client.websocket_connect("/voice/twilio/ws") as ws:
            ws.send_text(payload)
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_text()
    assert closed.value.code == 1008 and runner.calls == 0
