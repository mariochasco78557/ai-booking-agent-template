"""Ninguna regla de la V6 se pierde al repartir el prompt por pasos."""

from __future__ import annotations

import re
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from voice_agent.prompts import (
    NUCLEO,
    ORDEN_V6,
    PASOS,
    core_text,
    full_text,
    guidance,
    load_sections,
    step_section_ids,
    system_blocks,
)
from voice_agent.state import CallState, Phase

# Líneas de la V6 que cambian, y SOLO por la plataforma nueva (clave = inicio de la línea).
ADAPTED_V6_LINES = {
    "- DISPONIBILIDAD: la herramienta cuyo nombre": "la herramienta se llama `disponibilidad`",
    "- RESERVA: la herramienta cuyo nombre": "la herramienta se llama `reserva`; el token lo pone el sistema",
    "Con los tres datos, discover con: conversation_id": "conversation_id lo pone el sistema",
    "Si pide otras horas después de oír las tuyas": "more sin conversation_id (lo pone el sistema)",
    "Cuando elija, lock con conversation_id": "conversation_id lo pone el sistema",
    "**El lock va SIEMPRE justo después": "«sin su slot_token» → «sin esa hora bloqueada»",
    "Si es `locked`: guarda slot.slot_token": "el token lo guarda el sistema",
    "El slot_token vigente es el del último lock": "token → hora bloqueada (lo pone el sistema)",
    "- Si prefiere la hora que ya tenía bloqueada": "crear con esa hora (token del sistema)",
    "Si sale `locked`, sustituye profesional y slot_token": "token → hora",
    "Solo tras un «sí» claro al resumen completo, RESERVA con conversation_id": "campos que manda el modelo",
    "- `invalid_slot_token`, `slot_token_expired`": "«create con el token nuevo» → «RESERVA otra vez»",
    "- Una cita cada vez y completa": "token → hora bloqueada",
    "- Resumen con el `slot` de su lock y create": "create → RESERVA",
    "- Si tras oír horas duda o calla": "el aviso de silencio llega como «[silencio]»",
    "Fecha y hora actuales: {{system__time}}": "la fecha la da el código en <guia>, en hora de Madrid",
}

EXACT_PHRASES = [
    "Ahora mismo no puedo pasarte con nadie. Escríbenos por WhatsApp a este mismo número y la peluquería te responderá en cuanto pueda.",
    "Lo siento, ahora mismo no he podido resolverlo. Escríbenos por WhatsApp a este mismo número y la peluquería te responderá en cuanto pueda.",
    "Los cambios y las cancelaciones los gestiona directamente la peluquería por WhatsApp, en este mismo número al que has llamado.",
    "¿Me dices tu nombre, apellidos y un teléfono de contacto?",
    "¿Me dices el nombre y los apellidos de la persona de esta cita? ¿Uso el mismo teléfono?",
    "¿Confirmas que quieres reservar esta cita con estos datos o prefieres que mire otro profesional?",
    "¿Qué día u hora te vendría mejor? Te lo miro ahora.",
    "Un momento, compruebo otra vez esa hora.",
    "Lo siento, la cita no ha quedado confirmada.",
    "Por llamada puedo dejar como máximo tres citas.",
    "Las hacemos una a una.",
    "En esta llamada ya hay una cita hecha. No puedo hacer otra desde aquí.",
    "Si quieres, piénsalo con calma y cuando lo tengas nos llamas o nos escribes por WhatsApp a este mismo número. ¡Que vaya bien!",
    "Si quieres te lo miro ahora y te lo dejo apañado, ¿te parece?",
    "Te llega ahora mismo la confirmación por WhatsApp al número que me has dado",
    "¿Con Bruno, con Olga o con Ramón?",
]


def _v6_rule_lines(v6: str) -> list[str]:
    return [l.strip() for l in v6.splitlines() if l.strip() and not l.strip().startswith("#")]


def test_every_v6_line_is_kept_verbatim_or_documented(v6_prompt):
    full = full_text()
    not_kept = []
    for line in _v6_rule_lines(v6_prompt):
        if line in full:
            continue
        if any(line.startswith(prefix) for prefix in ADAPTED_V6_LINES):
            continue
        not_kept.append(line[:120])
    assert not_kept == [], "Reglas de la V6 perdidas o cambiadas sin documentar"


def test_adapted_lines_are_really_adapted(v6_prompt):
    """Si una línea adaptada vuelve a estar literal, se quita de la lista (lista honesta)."""
    full = full_text()
    for prefix in ADAPTED_V6_LINES:
        matches = [l for l in _v6_rule_lines(v6_prompt) if l.startswith(prefix)]
        assert len(matches) == 1, prefix
        assert matches[0] not in full, prefix


def test_every_quoted_v6_phrase_is_present(v6_prompt):
    full = full_text()
    quotes = re.findall(r"«([^»]+)»", v6_prompt)
    assert quotes
    assert [q for q in quotes if q not in full] == []


@pytest.mark.parametrize("phrase", EXACT_PHRASES)
def test_exact_phrases_present(phrase):
    assert phrase in full_text()


def test_all_sections_are_used_exactly_once_in_full_mode():
    sections = load_sections()
    assert sorted(sections) == sorted(ORDEN_V6)
    assert len(ORDEN_V6) == len(set(ORDEN_V6))


def test_every_section_reachable_in_node_mode():
    reachable = set(NUCLEO)
    for ids in PASOS.values():
        reachable |= set(ids)
    assert reachable == set(ORDEN_V6)


def test_core_holds_rules_valid_at_any_moment():
    core = core_text()
    for heading in (
        "# REGLA DE SALIDA",
        "# CONSULTAS NO RESUELTAS POR WHATSAPP",
        "# CITAS QUE YA EXISTEN",
        "# CIERRE DE LA LLAMADA",
        "# TOMA LA INICIATIVA",
        "# REPARTO ENTRE PROFESIONALES",
        "# DÍAS",
        "# FRASE DE ESPERA",
        "# SIEMPRE UNA PUERTA ABIERTA",
        "# CONVERSACIÓN Y PRONUNCIACIÓN",
    ):
        assert heading in core, heading


@pytest.mark.parametrize(
    "phase,must_have",
    [
        (Phase.INICIO, ["# FLUJO PARA UNA CITA NUEVA", "# BÚSQUEDA DE VARIOS DÍAS"]),
        (
            Phase.HORAS,
            [
                "# GESTIÓN DE LA DISPONIBILIDAD",
                "# EL CLIENTE DICE UNA HORA",
                "# OTROS HORARIOS",
                "# SELECCIÓN Y BLOQUEO DE LA HORA",
                "LA RESTRICCIÓN HORARIA SE MANTIENE",
                "# MÁS TARDE, MÁS PRONTO, OTRA HORA",
                "# CAMBIO DE PROFESIONAL",
            ],
        ),
        (Phase.DATOS, ["# DATOS DEL CLIENTE", "# RESUMEN Y CONFIRMACIÓN", "# CAMBIO DE PROFESIONAL"]),
        (Phase.CONFIRMAR, ["# RESUMEN Y CONFIRMACIÓN", "# CREACIÓN DE LA CITA", "# CAMBIO DE PROFESIONAL"]),
        (Phase.HECHA, ["# CREACIÓN DE LA CITA", "# VARIAS CITAS: CÓMO SE HACEN"]),
    ],
)
def test_each_step_has_its_rules(phase, must_have):
    blocks = system_blocks("nodos", phase)
    assert len(blocks) == 2
    for text in must_have:
        assert text in blocks[1], text


def test_multi_booking_adds_rules_everywhere():
    for phase in Phase:
        assert "varias_citas" in step_section_ids(phase, multi_booking=True)


def test_full_strategy_is_one_constant_block():
    a = system_blocks("completo", Phase.INICIO)
    b = system_blocks("completo", Phase.CONFIRMAR, multi_booking=True)
    assert a == b and len(a) == 1


def test_core_is_identical_across_steps():
    """El núcleo es el prefijo cacheado: no puede depender del paso."""
    cores = {system_blocks("nodos", p)[0] for p in Phase}
    assert len(cores) == 1


def test_core_is_long_enough_for_haiku_cache():
    # Haiku 4.5 solo cachea prefijos de >= 4.096 tokens. Con ~3,4 caracteres por token
    # (estimación pesimista) el núcleo debe superar ~14.000 caracteres.
    assert len(core_text()) >= 14_000


def test_guidance_has_madrid_date_and_step():
    state = CallState(conversation_id="tw_test0001")
    now = datetime(2026, 10, 6, 17, 32, tzinfo=ZoneInfo("Europe/Madrid"))
    text = guidance(state, now)
    assert text.startswith("<guia>") and text.endswith("</guia>")
    assert "Paso: INICIO" in text
    assert "martes 6 de octubre de 2026, 17:32" in text
    assert "hoy es 2026-10-06" in text


def test_guidance_never_contains_personal_data():
    state = CallState(conversation_id="tw_test0001")
    state.on_availability_result(
        {"action": "lock", "option_index": 1},
        {"outcome": "locked", "slot": {"date": "2026-10-07", "time": "10:00", "employee_id": 1,
                                         "employee_name": "Bruno", "slot_token": "tk1.secret"}},
    )
    text = guidance(state, datetime(2026, 10, 6, 10, 0, tzinfo=ZoneInfo("Europe/Madrid")))
    assert "tk1.secret" not in text
