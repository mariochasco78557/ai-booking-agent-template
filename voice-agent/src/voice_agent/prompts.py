"""Montaje del prompt: núcleo (siempre), reglas del paso y guía del turno.

Ver (internal doc, not included in the template) §1.2. El texto vive en ``prompts/secciones.md``.

- ``nodos``: sistema = [núcleo] + [secciones del paso]; dos bloques cacheables.
- ``completo``: sistema = [núcleo + todas las secciones], un bloque; lo más parecido a la V6.
- La guía del turno (paso, estado y fecha de Madrid) va al final del último mensaje,
  fuera de la caché, porque cambia en cada turno.
"""

from __future__ import annotations

import re
from datetime import datetime
from functools import lru_cache
from importlib import resources

from voice_agent.state import EMPLOYEE_NAMES, CallState, Phase

SECTION_RE = re.compile(r"^<!-- seccion: ([a-z_]+) -->\s*$", re.MULTILINE)

NUCLEO: tuple[str, ...] = (
    "identidad",
    "regla_salida",
    "herramientas",
    "frase_espera",
    "servicios_profesionales",
    "dias",
    "dudas",
    "puerta_abierta",
    "varias_citas_disparador",
    "citas_existentes",
    "fallos",
    "whatsapp",
    "cierre",
    "iniciativa",
    "conversacion",
    "fecha",
)

# Reglas para buscar horas (consultas, varios días, más tarde/pronto, otros horarios).
BUSQUEDA: tuple[str, ...] = ("gestion", "varios_dias", "mas_tarde", "otros_horarios")

PASOS: dict[Phase, tuple[str, ...]] = {
    Phase.INICIO: ("inicio", "varios_dias"),
    Phase.HORAS: (
        "hora_dicha",
        "gestion",
        "varios_dias",
        "mas_tarde",
        "otros_horarios",
        "seleccion",
        "cambio_profesional",
    ),
    # Desde DATOS, CONFIRMAR y HECHA el cliente puede volver a buscar («mejor otro día»,
    # «¿no tienes más tarde?», «quiero otra cita»): esos pasos llevan también las reglas
    # de búsqueda, porque el paso solo cambia cuando contesta el middleware.
    Phase.DATOS: (
        "datos",
        "resumen",
        "hora_dicha",
        "seleccion",
        "cambio_profesional",
        *BUSQUEDA,
    ),
    Phase.CONFIRMAR: (
        "resumen",
        "creacion",
        "cambio_profesional",
        "hora_dicha",
        "seleccion",
        "datos",
        *BUSQUEDA,
    ),
    Phase.HECHA: ("creacion", "varias_citas", "inicio", "hora_dicha", "seleccion", *BUSQUEDA),
}

# Orden de la V6, para el modo «completo».
ORDEN_V6: tuple[str, ...] = (
    "identidad",
    "regla_salida",
    "herramientas",
    "frase_espera",
    "servicios_profesionales",
    "dias",
    "dudas",
    "inicio",
    "hora_dicha",
    "gestion",
    "varios_dias",
    "mas_tarde",
    "puerta_abierta",
    "otros_horarios",
    "seleccion",
    "datos",
    "resumen",
    "cambio_profesional",
    "creacion",
    "varias_citas_disparador",
    "varias_citas",
    "cierre",
    "citas_existentes",
    "fallos",
    "whatsapp",
    "iniciativa",
    "conversacion",
    "fecha",
)

DIAS_SEMANA = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")
MESES = (
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
)


@lru_cache(maxsize=1)
def load_sections() -> dict[str, str]:
    text = resources.files("voice_agent").joinpath("prompts/secciones.md").read_text(encoding="utf-8")
    parts = SECTION_RE.split(text)
    # parts = [cabecera, id1, texto1, id2, texto2, ...]
    sections: dict[str, str] = {}
    for i in range(1, len(parts), 2):
        sections[parts[i]] = parts[i + 1].strip()
    return sections


def _join(ids: tuple[str, ...] | list[str]) -> str:
    sections = load_sections()
    return "\n\n".join(sections[i] for i in ids)


def core_text() -> str:
    return _join(NUCLEO)


def step_section_ids(phase: Phase, multi_booking: bool = False) -> tuple[str, ...]:
    ids = list(PASOS[phase])
    if multi_booking and "varias_citas" not in ids:
        ids.append("varias_citas")
    return tuple(ids)


def step_text(phase: Phase, multi_booking: bool = False) -> str:
    return f"# PASO ACTUAL: {phase.value}\n\n" + _join(step_section_ids(phase, multi_booking))


def full_text() -> str:
    return _join(ORDEN_V6)


def system_blocks(strategy: str, phase: Phase, multi_booking: bool = False) -> list[str]:
    """Bloques del system prompt. Cada uno lleva su punto de caché."""
    if strategy == "completo":
        return [full_text()]
    return [core_text(), step_text(phase, multi_booking)]


def _spoken_now(now: datetime) -> str:
    return (
        f"{DIAS_SEMANA[now.weekday()]} {now.day} de {MESES[now.month - 1]} de {now.year}, "
        f"{now:%H:%M} (hora de Madrid; hoy es {now:%Y-%m-%d})"
    )


def guidance(state: CallState, now: datetime, strategy: str = "nodos") -> str:
    """Bloque <guia> del turno: paso, estado y fecha. No se cachea."""
    phase = state.phase
    lines = [f"Paso: {phase.value}. Cita en curso: {state.cita_number}."]
    if strategy == "completo":
        lines.append("Aplica sobre todo las secciones de ese paso.")

    lock = state.live_lock
    if lock is not None:
        lines.append(
            f"Hora bloqueada vigente (último lock locked): {lock.get('date')} {lock.get('time')}, "
            f"con {lock.get('employee_name')} (employee_id {lock.get('employee_id')})."
        )
    if state.last_create_outcome == "invalid_customer_data" and state.summary_seq is None:
        lines.append(
            "El middleware ha rechazado los datos del cliente: vuelve a pedir nombre, apellidos y "
            "teléfono con la frase de DATOS DEL CLIENTE y haz después un resumen completo nuevo."
        )
    if phase == Phase.DATOS and state.data_already_given_in_cita():
        lines.append(
            "Ya tienes nombre, apellidos y teléfono de esta cita: no los pidas otra vez; "
            "haz directamente el resumen completo con el slot del último lock."
        )
    if phase == Phase.DATOS and state.bookings and not state.data_already_given_in_cita():
        lines.append("Es una cita siguiente: pide los datos con la frase de VARIAS CITAS.")
    if state.recheck_pending:
        lines.append(
            f"Recomprobación en curso tras «{state.recheck_pending}»: discover del día del hueco con "
            "employee_id de su profesional, preferred_time su hora y su time_period; si tiene hueco, "
            "lock de la opción 1 con preferred_employee_id de ese profesional; luego resumen completo y "
            "otro «sí». No pidas otra vez los datos. Es la única recomprobación de esta cita."
        )
    elif state.recheck_used_in_cita and phase in (Phase.CONFIRMAR, Phase.HORAS):
        lines.append("La recomprobación de esta cita ya se ha usado: si vuelve a fallar, frase de WhatsApp.")
    if state.requested_employee_id is not None:
        name = EMPLOYEE_NAMES.get(state.requested_employee_id, "?")
        lines.append(
            f"La última consulta llevaba profesional: {name} (employee_id {state.requested_employee_id}). "
            "Si el cliente lo pidió o lo eligió al cambiar de profesional, las consultas siguientes de esta cita lo llevan."
        )
    if state.last_scan_restriction:
        cond = ", ".join(f"{k} {v}" for k, v in state.last_scan_restriction.items())
        lines.append(
            f"Condición horaria de la última búsqueda: {cond}. Se mantiene salvo que la haya soltado o haya "
            "dicho una hora concreta nueva; mientras siga, nunca discover."
        )
    for path, count in sorted(state.failures.items()):
        label = "la consulta" if path == "consulta" else "el bloqueo"
        if count == 1:
            lines.append(f"Ha fallado {label} una vez: puedes ofrecer un solo reintento.")
        elif count >= 2:
            lines.append(
                f"Ha fallado {label} {count} veces: no reintentes; frase de WhatsApp y pregunta abierta."
            )
    if state.keep_open_offered:
        lines.append("Ya ofreciste «Si quieres te lo miro ahora…»: no lo vuelvas a ofrecer.")
    if state.bookings:
        hechas = "; ".join(
            f"{i}) {b.date} {b.time} con {b.employee_name}"
            + (f" (booking_number {b.booking_number} de {b.max_bookings_per_call})" if b.booking_number else "")
            for i, b in enumerate(state.bookings, start=1)
        )
        lines.append(f"Citas confirmadas en esta llamada: {hechas}.")
        if any(b.whatsapp_queued for b in state.bookings):
            lines.append(
                "Hay whatsapp_confirmation queued: en la despedida, una vez, la frase de la confirmación por WhatsApp."
            )
    if state.silence_prompts:
        lines.append(f"Avisos de silencio seguidos: {state.silence_prompts} de 2.")
    lines.append(f"Fecha y hora actuales: {_spoken_now(now)}.")
    return "<guia>\n" + "\n".join(lines) + "\n</guia>"
