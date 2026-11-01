import type { Clock } from "../../../callEngine/domain/types.js";
import { formatHHmm, parseHHmm } from "../../../callEngine/domain/time.js";
import type { InternalReasonCode } from "../../../callEngine/outcomeDimension.js";
import type { Outcome, ReasonCode } from "../../../callEngine/precedence.js";
import { ES } from "../../../callEngine/phrasing/es.js";
import type { PhraseKey } from "../../../callEngine/phrasing/keys.js";
import type { ReadOnlyAgendaDay, ReadOnlyAgendaFailureKind } from "./port.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * DECIDIR Y HABLAR EN MODO real_readonly, SIN MOTOR Y SIN RED.
 *
 * En modo sintético quien decide es `callEngine/engine.ts` sobre el fixture.
 * Ese motor no sirve aquí: resuelve contra un `OperationalCalendar`
 * (horarios, temporadas, ausencias, matriz de capacidades) que el upstream
 * Symfony NO expone. Fabricar uno a partir de los huecos libres sería
 * inventarse el horario del negocio a partir de sus huecos —dos cosas
 * distintas— así que este módulo decide directamente sobre la foto del día
 * que devuelve el puerto de solo lectura.
 *
 * Lo que NO cambia es el contrato hablado: se reutiliza el catálogo de
 * frases aprobado (`phrasing/es.ts`), el vocabulario congelado de diez
 * `ReasonCode` y la misma forma de respuesta que el modo sintético. El
 * agente de voz no tiene que aprender un segundo contrato: cambia la fuente
 * de la agenda, no lo que se dice ni cómo se responde.
 *
 * Todo aquí es PURO: sin reloj real, sin red, sin estado. El «ahora» llega
 * inyectado y la foto del día llega ya leída.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Duración sintética del hueco, la misma rejilla de 30' del resto del demo. */
export const REAL_READONLY_SLOT_MINUTES = 30;

export type ProfessionalSelection = number | "any";

export interface RealAgendaRequest {
  dateISO: string;
  /** "HH:mm" pedido por quien llama. */
  time: string;
  professional: ProfessionalSelection;
}

/** Un hueco ya retenido por el overlay en memoria de este proceso. */
export interface HeldSlot {
  dateISO: string;
  employeeId: number;
  startMinutes: number;
}

export type RealAgendaDecision =
  | { kind: "exact"; employeeId: number; label: string; dateISO: string; startMinutes: number }
  | {
      kind: "alternative";
      /** Qué dimensión se movió: la hora (mismo profesional) o el profesional (misma hora). */
      changed: "time" | "professional";
      employeeId: number;
      label: string;
      dateISO: string;
      startMinutes: number;
    }
  | { kind: "none" };

interface FreeSlot {
  employeeId: number;
  startMinutes: number;
}

function labelFor(day: ReadOnlyAgendaDay, employeeId: number): string {
  const found = day.professionals.find((person) => person.employeeId === employeeId);
  return found === undefined || found.label === "" ? `profesional ${String(employeeId)}` : found.label;
}

/**
 * Los huecos que este puente puede ofrecer de verdad: los que el upstream da
 * por libres, MENOS los que ya retuvo este proceso, MENOS los que ya han
 * empezado. El último filtro no es redundante aunque el upstream ya filtre
 * el pasado: si algún día dejara de hacerlo, ofrecer una hora ya pasada
 * sería una respuesta falsa dicha con total seguridad.
 */
function freeSlots(day: ReadOnlyAgendaDay, clock: Clock, held: readonly HeldSlot[]): FreeSlot[] {
  const isToday = day.dateISO === clock.nowISODate();
  const nowMinutes = clock.nowMinutes();
  const heldKeys = new Set(
    held
      .filter((slot) => slot.dateISO === day.dateISO)
      .map((slot) => `${String(slot.employeeId)}|${String(slot.startMinutes)}`),
  );

  const out: FreeSlot[] = [];
  for (const slot of day.slots) {
    const startMinutes = parseHHmm(slot.time);
    if (isToday && startMinutes < nowMinutes) continue;
    if (heldKeys.has(`${String(slot.employeeId)}|${String(startMinutes)}`)) continue;
    out.push({ employeeId: slot.employeeId, startMinutes });
  }
  return out.sort((a, b) =>
    a.startMinutes !== b.startMinutes ? a.startMinutes - b.startMinutes : a.employeeId - b.employeeId,
  );
}

/** El más cercano a `target`; a igual distancia gana el más temprano, y a igual hora el id más bajo. */
function nearest(slots: readonly FreeSlot[], target: number): FreeSlot | undefined {
  let best: FreeSlot | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const distance = Math.abs(slot.startMinutes - target);
    if (distance < bestDistance) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * QUÉ SE OFRECE Y EN QUÉ ORDEN.
 *
 * 1. El hueco exacto pedido, si está libre (con el profesional pedido, o con
 *    el de id más bajo entre los libres cuando da igual quién atienda).
 * 2. Si no: el MISMO profesional, ese mismo día, a la hora libre más cercana.
 *    Quien pide a una persona concreta la ha elegido; mover la hora conserva
 *    esa elección, cambiar de persona no.
 * 3. Si ese profesional no tiene ningún hueco: OTRO profesional a la hora
 *    exacta pedida, que es la sustitución que el catálogo de frases ya sabe
 *    anunciar diciendo con quién sería.
 * 4. Si no hay nada: no se ofrece nada. Este puente nunca inventa un hueco.
 *
 * Divergencia deliberada respecto al motor sintético, que busca la
 * alternativa en los días SIGUIENTES antes de cambiar de profesional: cada
 * día extra aquí es una ronda de llamadas al upstream dentro del turno de
 * una conversación telefónica. La alternativa se busca dentro del día ya
 * leído; el resto de días se piden con otra llamada a la herramienta.
 */
export function decideRealAgenda(
  day: ReadOnlyAgendaDay,
  request: RealAgendaRequest,
  options: { clock: Clock; held?: readonly HeldSlot[] },
): RealAgendaDecision {
  const available = freeSlots(day, options.clock, options.held ?? []);
  const target = parseHHmm(request.time);
  const atRequestedTime = available.filter((slot) => slot.startMinutes === target);

  if (request.professional === "any") {
    const exact = atRequestedTime[0];
    if (exact !== undefined) {
      return {
        kind: "exact",
        employeeId: exact.employeeId,
        label: labelFor(day, exact.employeeId),
        dateISO: day.dateISO,
        startMinutes: exact.startMinutes,
      };
    }
    const alternative = nearest(available, target);
    if (alternative === undefined) return { kind: "none" };
    return {
      kind: "alternative",
      changed: "time",
      employeeId: alternative.employeeId,
      label: labelFor(day, alternative.employeeId),
      dateISO: day.dateISO,
      startMinutes: alternative.startMinutes,
    };
  }

  const requestedId = request.professional;
  if (atRequestedTime.some((slot) => slot.employeeId === requestedId)) {
    return {
      kind: "exact",
      employeeId: requestedId,
      label: labelFor(day, requestedId),
      dateISO: day.dateISO,
      startMinutes: target,
    };
  }

  const sameProfessional = nearest(
    available.filter((slot) => slot.employeeId === requestedId),
    target,
  );
  if (sameProfessional !== undefined) {
    return {
      kind: "alternative",
      changed: "time",
      employeeId: requestedId,
      label: labelFor(day, requestedId),
      dateISO: day.dateISO,
      startMinutes: sameProfessional.startMinutes,
    };
  }

  const substitute = atRequestedTime[0];
  if (substitute !== undefined) {
    return {
      kind: "alternative",
      changed: "professional",
      employeeId: substitute.employeeId,
      label: labelFor(day, substitute.employeeId),
      dateISO: day.dateISO,
      startMinutes: target,
    };
  }

  return { kind: "none" };
}

/** La parte de la respuesta común a las dos herramientas, con la misma forma que el modo sintético. */
export interface RealAgendaEnvelope {
  ok: boolean;
  mode: "real_readonly";
  message: string;
  phrase_key: PhraseKey;
  messages: readonly string[];
  outcome: Outcome;
  reason_code: ReasonCode;
  internal_reason_code: InternalReasonCode;
  announces_success: boolean;
  /** Invariante del puente, también aquí: este modo JAMÁS escribe fuera. */
  external_mutation: false;
  synthetic_mutation: boolean;
}

export interface OfferedSlot {
  date_iso: string;
  time: string;
}

export interface RealAgendaOffer {
  requested_slot_available: boolean;
  requires_customer_confirmation: boolean;
  offered_slots: readonly OfferedSlot[];
  offered_professional?: { employee_id: number; label: string };
}

function envelope(
  reasonCode: ReasonCode,
  outcome: Outcome,
  phraseKey: PhraseKey,
  messages: readonly string[],
  options: { announcesSuccess: boolean; syntheticMutation: boolean },
): RealAgendaEnvelope {
  return {
    ok: outcome === "RESUELVE",
    mode: "real_readonly",
    message: messages.at(-1) ?? ES.REASON_TECHNICAL_FAILURE(),
    phrase_key: phraseKey,
    messages,
    outcome,
    reason_code: reasonCode,
    internal_reason_code: reasonCode,
    announces_success: options.announcesSuccess,
    external_mutation: false,
    synthetic_mutation: options.syntheticMutation,
  };
}

/**
 * La respuesta hablada de una consulta de disponibilidad sobre agenda real.
 * Reutiliza literalmente las frases aprobadas: la que ofrece huecos, la que
 * ofrece otra hora y la que ofrece otra persona diciendo su nombre.
 */
export function availabilityAnswer(decision: RealAgendaDecision): RealAgendaEnvelope & RealAgendaOffer {
  if (decision.kind === "none") {
    const messages = [ES.REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE()];
    return {
      ...envelope("SLOT_OUTSIDE_SYNTHETIC_SCHEDULE", "DERIVA", "REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE", messages, {
        announcesSuccess: false,
        syntheticMutation: false,
      }),
      requested_slot_available: false,
      requires_customer_confirmation: false,
      offered_slots: [],
    };
  }

  const offered: OfferedSlot = { date_iso: decision.dateISO, time: formatHHmm(decision.startMinutes) };
  const closing = ES.REASON_AVAILABILITY_PROVIDED({ slots: [{ day: offered.date_iso, time: offered.time }] });

  if (decision.kind === "exact") {
    return {
      ...envelope("AVAILABILITY_PROVIDED", "RESUELVE", "REASON_AVAILABILITY_PROVIDED", [closing], {
        announcesSuccess: false,
        syntheticMutation: false,
      }),
      requested_slot_available: true,
      requires_customer_confirmation: true,
      offered_slots: [offered],
    };
  }

  const opener =
    decision.changed === "professional"
      ? ES.OFFER_ANOTHER_PROFESSIONAL({ employeeId: decision.employeeId, professional: decision.label })
      : ES.OFFER_ALTERNATIVES({ alternatives: [{ day: offered.date_iso, time: offered.time }] });

  return {
    ...envelope("AVAILABILITY_PROVIDED", "RESUELVE", "REASON_AVAILABILITY_PROVIDED", [opener, closing], {
      announcesSuccess: false,
      syntheticMutation: false,
    }),
    requested_slot_available: false,
    requires_customer_confirmation: true,
    offered_slots: [offered],
    ...(decision.changed === "professional"
      ? { offered_professional: { employee_id: decision.employeeId, label: decision.label } }
      : {}),
  };
}

/**
 * La confirmación de una reserva que SÓLO existe en memoria. La frase
 * aprobada dice, palabra por palabra, «La reserva ficticia queda confirmada
 * en esta demostración local»: sigue siendo cierta aquí, y es justo lo que
 * hace que este modo pueda leer la agenda real sin que nadie cuelgue el
 * teléfono creyendo que tiene cita.
 */
export function bookingAnswer(): RealAgendaEnvelope {
  return envelope("BOOKING_CONFIRMED", "RESUELVE", "REASON_BOOKING_CONFIRMED", [ES.REASON_BOOKING_CONFIRMED()], {
    announcesSuccess: true,
    syntheticMutation: true,
  });
}

/**
 * La agenda real no contesta (caída, error o se agotó el tiempo). Fallo
 * técnico honesto: ni se inventa disponibilidad, ni se cae al fixture
 * sintético para tapar el hueco —eso sería responder con datos de otro sitio
 * sin decirlo—, ni se filtra un detalle interno del upstream. La etiqueta
 * `agenda_error` es nuestra y cerrada; el status HTTP, el cuerpo y el
 * mensaje del upstream se quedan donde se produjeron.
 */
export function agendaUnavailableAnswer(
  kind: ReadOnlyAgendaFailureKind,
): RealAgendaEnvelope & { agenda_error: ReadOnlyAgendaFailureKind } {
  return {
    ...envelope("TECHNICAL_FAILURE", "DERIVA", "REASON_TECHNICAL_FAILURE", [ES.REASON_TECHNICAL_FAILURE()], {
      announcesSuccess: false,
      syntheticMutation: false,
    }),
    agenda_error: kind,
  };
}
