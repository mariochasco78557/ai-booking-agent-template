import type { AdvanceableClock } from "../callEngine/domain/advanceableClock.js";
import { formatHHmm } from "../callEngine/domain/time.js";
import { SERVICE_LABELS, type EmployeeId } from "../callEngine/domain/types.js";
import type { CalendarWithCapabilities } from "../callEngine/capabilities.js";
import type {
  GroupArrangement,
  GroupProposal,
  ManualBooking,
  NoShowRecord,
  NoShowState,
  OperationsAuditEvent,
  ReservationGroup,
} from "../callEngine/operations/model.js";
import {
  countGroupsWithIntent,
  countManualBookingsWithIntent,
  groupIntentKey,
  groupIntentKeyToMint,
  manualIntentKeyToMint,
} from "../callEngine/operations/model.js";
import type { ManualProposal } from "../callEngine/operations/manualBooking.js";
import {
  isEligibleForNoShow,
  minutesAfterEnd,
  noShowIneligibleReasonCode,
  noShowRevisionOf,
  type NoShowIneligibleReasonCode,
} from "../callEngine/operations/noShow.js";
import type { OperationsStoreSnapshot } from "../callEngine/operations/store.js";
import { dayPhraseEs, parseDateTime } from "../utils/dateFormatterEs.js";
import type {
  ConsoleReservationGroupView,
  ConsoleReservationManualView,
  ConsoleReservationNoShowAnnotation,
  ConsoleReservationNoShowView,
} from "./snapshot.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — THE OPERATIONS PROJECTION (design §2.10, §2.11, §2.12, §3.6).
 *
 * Sibling of `waitlistSnapshot.ts`, under the SAME HARD RULE as `snapshot.ts`:
 * every value below is built field by field from an EXPLICIT ALLOW LIST.
 * There is not one `...spread` of a domain object into a returned value, so a
 * field added to the operations model tomorrow cannot leak into the console
 * without this file changing.
 *
 * EVERYTHING ARRIVES RESOLVED. Eligibility (§2.4), state labels, Spanish
 * sentences, the clock label and even THE IDEMPOTENCY KEYS THE INTERFACE
 * WILL MINT (§2.7, decision N3) travel already resolved. The browser never
 * compares an hour against an appointment and never derives a key: repeating
 * either of those in `/app.js` would be exactly the inherited defect this
 * console exists to remove.
 *
 * ZERO INCREMENTAL COUNTERS (§2.12). Every figure is DERIVED from the audit
 * log and the set of records with `countKind`, the same technique
 * `waitlistSnapshot.ts` uses: a counter kept by hand is a counter that can
 * lie.
 *
 * NO PERSONAL DATA (§2.11). There is no client identity in this product and
 * no note field in this feature: a no-show is attached to the synthetic
 * APPOINTMENT, never to a person. The only human-readable name that appears
 * is a synthetic professional's label, exactly as in `snapshot.ts` and under
 * the same reasoning.
 *
 * THE `groups` KEY (design §4.9) arrives with the multi-person booking phase.
 * Same rules, one by one: `groupState` is DERIVED from the appointments
 * themselves (never stored, so it cannot drift), every label is Spanish
 * resolved here, and `intentKeyToMint` is the transport key the interface must
 * send — resolved server-side, exactly like the two no-show keys, so the
 * browser never derives an identity or a canonical order (decision N3).
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Closed copy catalogue (design §2.11). Single source of truth, server side.
// ---------------------------------------------------------------------

/**
 * THE SENTENCES OF §2.11, written here and nowhere else. The interface never
 * composes its own copy about what this system refuses to decide.
 *
 * FORBIDDEN VOCABULARY (criterion 8.11): "sanción", "bloquear", "riesgo",
 * "fiable", "reincidente", "tasa", "%", "coste", "pérdida", "€". The word
 * "penalización" appears ONLY inside the sentence that denies one, which is
 * the whole point of this feature.
 */
export const OPERATIONS_COPY = {
  noPenalty:
    "No se ha aplicado ninguna penalización. La política de inasistencias está pendiente de decidir con Demo Salon.",
  manualOnly:
    "Esto lo anotas tú. El sistema no deduce nunca que alguien no ha venido: no sabe si alguien entró por la puerta.",
  onlyAfterEnd: "Sólo se puede anotar cuando la cita ya ha terminado.",
  noGracePeriod:
    "No hay ningún margen de cortesía configurado: en cuanto la cita termina, se puede anotar. Cuántos minutos de retraso cuentan como inasistencia está pendiente de decidir con Demo Salon.",
  correctionKeepsHistory: "El registro no se borra: queda anotado que se registró y que se corrigió.",
  correctionIsFinal:
    "En esta demostración, corregir es definitivo: esta cita ya no se podrá volver a marcar como inasistencia. Si te hace falta empezar de nuevo, reinicia la demostración.",
  noClientIdentity:
    "Esta anotación va pegada a la cita sintética, no a ninguna persona: en esta demostración no hay identidad de cliente ni historial por persona.",
  noVoiceAgent: "El asistente de voz no participa en esto: no acusa a nadie de no presentarse.",
  notFinishedYet: "Esa cita todavía no ha terminado. No se puede anotar una inasistencia por adelantado.",
  cancelledCannotBeNoShow:
    "Esa cita está cancelada. Cancelar es avisar; no presentarse es no avisar: son dos cosas distintas y no se mezclan.",
  recordedResult: "Inasistencia registrada. No se ha aplicado ninguna penalización.",
  correctedResult: "Registro corregido. Queda en el historial que se anotó y que se corrigió.",
  repeatedResult: "Esa acción ya estaba hecha. No se ha hecho nada nuevo.",
  homeLine: "Inasistencias anotadas hoy: {n} (registro manual, sin penalización).",
  clockNotice:
    "Este reloj es de la demostración y sólo avanza cuando lo mueves tú. No es la hora de tu ordenador y no puede retroceder: para volver al principio, reinicia la demostración.",
  clockOnlyForwards:
    "Si mueves el reloj más allá de un hueco liberado, ese hueco deja de poder ofrecerse y la tarea de decidirlo se queda abierta. Es lo que pasaría de verdad.",
  clockEndpointIsWider:
    "El control de esta pantalla llega hasta 4 horas. La ruta acepta hasta 7 días, y eso sólo lo usan las pruebas.",
} as const;

/** The two state labels of §2.3. Closed table, server side. */
const NO_SHOW_STATE_LABELS: Readonly<Record<NoShowState, string>> = {
  recorded: "Inasistencia registrada",
  corrected_not_a_no_show: "Registro corregido: no fue una inasistencia",
};

/** The console's existing pill vocabulary: ok | attention | derived | incomplete | none. */
const NO_SHOW_STATE_TONES: Readonly<Record<NoShowState, string>> = {
  recorded: "attention",
  corrected_not_a_no_show: "derived",
};

/** Why an appointment cannot be marked right now, in plain Spanish. Closed table. */
const INELIGIBLE_REASON_LABELS: Readonly<Record<NoShowIneligibleReasonCode, string>> = {
  reservation_is_cancelled: OPERATIONS_COPY.cancelledCannotBeNoShow,
  reservation_not_finished_yet: OPERATIONS_COPY.notFinishedYet,
};

/** The audit list is trimmed to the 200 most recent, exactly like the waitlist's. */
export const OPERATIONS_AUDIT_ITEMS_SHOWN = 200;

/** The upper bound of `POST /api/lab/clock/advance`, documented in §3.5: seven days. */
export const CLOCK_ADVANCE_MAX_MINUTES = 10_080;

// ---------------------------------------------------------------------
// The idempotency keys the interface mints (design §2.7, decision N3)
// ---------------------------------------------------------------------

/**
 * THE ONLY PLACE THAT KNOWS THE SHAPE OF THESE KEYS. They travel resolved in
 * the projection so the browser never derives one: with the plain
 * `noshow:<id>` of the first draft, the sequence record → correct → record
 * replayed the memoised `201` and the honest `409 no_show_already_corrected`
 * never arrived (blocker B3). The `v<revision>` discriminant is what makes
 * the key describe THE WORLD IT WAS MINTED IN.
 */
export function noShowRecordKey(reservationId: string, revision: number): string {
  return `noshow:${reservationId}:v${String(revision)}`;
}

export function noShowCorrectionKey(reservationId: string, revision: number): string {
  return `noshow-fix:${reservationId}:v${String(revision)}`;
}

// ---------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------

export interface ConsoleClockView {
  dateISO: string;
  minutes: number;
  /** "martes 4 de agosto, 10:00" — the client never formats a date. */
  label: string;
  advancedByMinutes: number;
  /** "movido +1 h por ti", or `null` while the clock has not been moved. */
  advancedLabel: string | null;
  isSynthetic: true;
  notice: string;
}

export interface ConsoleNoShowRecordView {
  id: string;
  reservationId: string;
  state: NoShowState;
  stateLabel: string;
  stateTone: string;
  /** "martes 4 de agosto, 09:30–10:00". */
  when: string;
  professionalLabel: string;
  serviceLabel: string;
  recordedAtISO: string;
  correctedAtISO: string | null;
  /**
   * The domain field is `minutesAfterEndAtRecording` (design §2.5); the
   * PROJECTION deliberately spells it `…WhenRecorded`. The reason is not
   * cosmetic: the console's personal-data key blacklist
   * (tests/console/console.test.ts) bans any key containing "recording" —
   * as in an audio recording — and a field that trips a privacy scan for a
   * false reason is a field that teaches people to relax the scan. The
   * meaning is identical and the domain name stays exactly as designed.
   */
  minutesAfterEndWhenRecorded: number;
  /** 0 while nobody has corrected, 1 afterwards (design §2.7). */
  noShowRevision: number;
  /** The key the interface must send to correct this record. Never derived in the browser. */
  idempotencyKeyToMint: string;
  noPenaltyNotice: string;
  availableCommands: readonly string[];
}

export interface ConsoleOperationsAuditItemView {
  id: string;
  seq: number;
  kind: string;
  /** Generated HERE, from the closed catalogue of §2.6. The interface never composes its own sentence. */
  text: string;
  actor: string;
  atISO: string;
  reservationId: string | null;
  noShowId: string | null;
  groupId: string | null;
  fromState: NoShowState | null;
  toState: NoShowState | null;
}

/** Every figure is DERIVED from the log (design §2.12). Not one incremental counter. */
export interface ConsoleOperationsMetricsView {
  noShowsRecordedNow: number;
  noShowsCorrected: number;
  noShowRecordCommands: number;
  repeatedCommandsIgnored: number;
  clockAdvances: number;
  /**
   * The two first figures ALWAYS TOGETHER, in one sentence (design §2.12): a
   * panel that showed "inasistencias: 7" without saying that two were
   * corrected lies by omission.
   */
  recordedAndCorrectedLine: string;
  /** The neutral Inicio line (K14). `null` when there is nothing to say. */
  homeLine: string | null;
  /**
   * step 19 §6.3/§5.2.2 (C3-C7) — SIETE campos más, todos DERIVADOS de
   * `operations.groups` (nunca un contador aparte). `groupsCreated` es
   * `ops.groups.length`; `groupReservationsCreated` es la suma de líneas de
   * todos los grupos; los tres siguientes cuentan grupos por su
   * `groupState` (§4.9, `groupStateOf`, ya derivado de las citas mismas); los
   * dos últimos cuentan grupos por su `arrangement`.
   */
  groupsCreated: number;
  groupReservationsCreated: number;
  groupsFullyActive: number;
  groupsPartiallyCancelled: number;
  groupsFullyCancelled: number;
  groupsConsecutiveCreated: number;
  groupsSimultaneousCreated: number;
}

export interface ConsoleOperationsIntegrityView {
  ok: boolean;
  problems: readonly string[];
}

export interface ConsoleNoShowsView {
  records: readonly ConsoleNoShowRecordView[];
  /** Appointments that COULD be marked right now (§2.4). Resolved server-side. */
  eligibleReservationIds: readonly string[];
  copy: typeof OPERATIONS_COPY;
}

export interface ConsoleOperationsView {
  clock: ConsoleClockView;
  noShows: ConsoleNoShowsView;
  /** step 18 §4.9 — multi-person bookings, fully resolved. */
  groups: ConsoleGroupsView;
  metrics: ConsoleOperationsMetricsView;
  integrity: ConsoleOperationsIntegrityView;
  audit: { total: number; shown: number; items: readonly ConsoleOperationsAuditItemView[] };
}

// ---------------------------------------------------------------------
// Multi-person booking projection (design §4.9, §4.11)
// ---------------------------------------------------------------------

/**
 * THE SENTENCES OF §4.9 AND §4.11, written here and nowhere else. Two of them
 * exist for one reason only: to say out loud, before and after, that
 * cancelling one appointment of a group cancels ONLY that one. The demo does
 * not cancel in cascade, and it says so instead of leaving it to be assumed.
 */
export const GROUP_COPY = {
  cancelNoteForGroup: "Cancelar una de estas citas no cancela las demás.",
  cancelNoteForLine: "Cancelar esta cita no cancela las demás.",
  ownServicePerPerson:
    "Cada persona elige su servicio. Nada se copia de una fila a otra: en esta demostración no hay ningún botón que lo haga.",
  arrangementIsExplicit:
    "Elige tú si van una detrás de otra o a la vez. No hay ninguna opción marcada de antemano.",
  everyLineIsItsOwnAppointment:
    "Cada persona tiene su propia cita de 30 minutos, con su servicio y su profesional. El grupo es sólo la referencia que las une.",
  allOrNothing:
    "O se crean todas las citas o no se crea ninguna. Si un hueco deja de estar libre, no se escribe nada.",
} as const;

/** The two arrangements, in the operator's words. Closed table, server side. */
const ARRANGEMENT_LABELS: Readonly<Record<GroupArrangement, string>> = {
  consecutive: "Una detrás de otra",
  simultaneous: "A la vez",
};

/**
 * DERIVED, never stored (design §4.3). The life of a line is the life of its
 * reservation, so this cannot disagree with the Agenda.
 */
export type ConsoleGroupState = "fully_active" | "partially_cancelled" | "fully_cancelled";

export interface ConsoleGroupLineView {
  reservationId: string;
  memberLabel: string;
  serviceLabel: string;
  professionalLabel: string;
  /** "09:00–09:30". */
  whenLabel: string;
  status: "confirmed" | "cancelled";
  statusLabel: string;
}

export interface ConsoleGroupView {
  id: string;
  /** "Reserva para varias personas · grupo 1". */
  label: string;
  arrangement: GroupArrangement;
  arrangementLabel: string;
  date: string;
  /** "martes 4 de agosto". */
  dateLabel: string;
  groupState: ConsoleGroupState;
  groupStateLabel: string;
  /**
   * The `Idempotency-Key` the interface must send to create THIS SAME
   * intention again (design §4.8). Resolved here — the browser never derives a
   * key and never computes the canonical order the key is built from.
   *
   * (Enmienda de fase K, H1) The `:r<n>` discriminant no longer carries the
   * weight of AVOIDING A LIE. It used to be the only thing standing between a
   * repeated key and a memoised `201` describing appointments that had since
   * been cancelled; the group creation route now works in `collision-only`
   * mode, so no key of this route can be answered with a memoised body and
   * SENDING THIS KEY CAN NO LONGER CAUSE A LIE. What the discriminant still
   * does is describe the world revision the intention was minted in, which
   * keeps two successive creations of the same intention distinguishable in a
   * log and in a runbook.
   */
  intentKeyToMint: string;
  lines: readonly ConsoleGroupLineView[];
  cancelNote: string;
}

export interface ConsoleGroupsView {
  items: readonly ConsoleGroupView[];
  copy: typeof GROUP_COPY;
}

/** One resolved line of a proposal, ready to show and to send back untouched. */
export interface ConsoleGroupProposalLineView {
  memberLabel: string;
  serviceId: number;
  serviceLabel: string;
  employeeId: number;
  professionalLabel: string;
  professionalWasRequested: boolean;
  date: string;
  startMinutes: number;
  endMinutes: number;
  /** "09:00–09:30". */
  whenLabel: string;
}

/**
 * A whole proposal, resolved.
 *
 * IT CARRIES NO `slotKey` ON PURPOSE. The domain line has one (design §4.3),
 * but a `slot-2026-…` string in a paintable projection is exactly what
 * criterion 22 of step 17 forbids on screen, and nothing in the interface
 * needs it: what the client sends back to create is
 * `memberLabel`/`serviceId`/`employeeId`/`startMinutes`.
 */
export interface ConsoleGroupProposalView {
  /** "Propuesta 1". No preselection, no "recommended", no highlight (design §4.5). */
  label: string;
  arrangement: GroupArrangement;
  arrangementLabel: string;
  date: string;
  dateLabel: string;
  /** The `Idempotency-Key` to send when confirming THIS proposal (design §4.8, decision N3). */
  intentKeyToMint: string;
  lines: readonly ConsoleGroupProposalLineView[];
}

// ---------------------------------------------------------------------
// Formatting helpers (Spanish, server-side)
// ---------------------------------------------------------------------

function professionalLabelOf(cal: CalendarWithCapabilities, employeeId: EmployeeId): string {
  return cal.professionals.find((p) => p.employeeId === employeeId)?.displayName ?? `Profesional ${String(employeeId)}`;
}

function dayLabel(dateISO: string): string {
  const parsed = parseDateTime(dateISO);
  return parsed === null ? dateISO : dayPhraseEs(parsed);
}

/** "martes 4 de agosto, 10:00". The single place a synthetic instant becomes Spanish. */
export function demoInstantLabel(dateISO: string, minutes: number): string {
  return `${dayLabel(dateISO)}, ${formatHHmm(minutes)}`;
}

/**
 * "movido +1 h por ti". Composed from whole days, hours and minutes so the
 * seven-day ceiling of the endpoint (§3.5) reads as "+7 d" and not as "+10080
 * min". `null` while nothing has moved: the screen has nothing to say then.
 */
export function advancedLabelFor(minutes: number): string | null {
  if (minutes <= 0) return null;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes - days * 1440) / 60);
  const rest = minutes - days * 1440 - hours * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)} d`);
  if (hours > 0) parts.push(`${String(hours)} h`);
  if (rest > 0) parts.push(`${String(rest)} min`);
  return `movido +${parts.join(" ")} por ti`;
}

export function buildClockView(clock: AdvanceableClock): ConsoleClockView {
  const dateISO = clock.nowISODate();
  const minutes = clock.nowMinutes();
  return {
    dateISO,
    minutes,
    label: demoInstantLabel(dateISO, minutes),
    advancedByMinutes: clock.advancedByMinutes(),
    advancedLabel: advancedLabelFor(clock.advancedByMinutes()),
    isSynthetic: true,
    notice: OPERATIONS_COPY.clockNotice,
  };
}

// ---------------------------------------------------------------------
// The audit text catalogue (design §2.6)
// ---------------------------------------------------------------------

interface TextContext {
  cal: CalendarWithCapabilities;
  noShows: readonly NoShowRecord[];
}

/** "las 09:30 con Álex (sintético)" — from the record first, from the calendar as a fallback. */
function appointmentRef(ctx: TextContext, reservationId: string | undefined): { time: string; who: string } {
  const record = ctx.noShows.find((r) => r.reservationId === reservationId);
  if (record !== undefined) {
    return { time: formatHHmm(record.startMinutes), who: professionalLabelOf(ctx.cal, record.employeeId) };
  }
  const reservation = ctx.cal.reservations.find((r) => r.id === reservationId);
  if (reservation !== undefined) {
    return { time: formatHHmm(reservation.startMinutes), who: professionalLabelOf(ctx.cal, reservation.employeeId) };
  }
  return { time: "", who: "el equipo" };
}

function detailNumber(ev: OperationsAuditEvent, key: string): number | undefined {
  const v = ev.detail?.[key];
  return typeof v === "number" ? v : undefined;
}

function detailString(ev: OperationsAuditEvent, key: string): string | undefined {
  const v = ev.detail?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * ONE closed map by `kind`. Every sentence an operator reads about a no-show
 * or about the clock is written here and nowhere else — the browser never
 * builds one, and none of them names a consequence this system has not been
 * authorised to apply.
 */
export function operationsAuditText(ev: OperationsAuditEvent, ctx: TextContext): string {
  switch (ev.kind) {
    case "NO_SHOW_RECORDED": {
      const { time, who } = appointmentRef(ctx, ev.reservationId);
      return `Un operador ha anotado una inasistencia en la cita de las ${time} con ${who}. No se ha aplicado ninguna penalización.`;
    }
    case "NO_SHOW_CORRECTED": {
      const { time, who } = appointmentRef(ctx, ev.reservationId);
      return `Un operador ha corregido el registro: la cita de las ${time} con ${who} no fue una inasistencia. El registro anterior no se ha borrado.`;
    }
    case "NO_SHOW_COMMAND_REPEATED": {
      const { time } = appointmentRef(ctx, ev.reservationId);
      return `Se ha repetido una acción sobre la inasistencia de las ${time}. No se ha hecho nada nuevo.`;
    }
    case "RESERVATION_GROUP_CREATED": {
      const lineCount = detailNumber(ev, "lineCount") ?? 0;
      const date = detailString(ev, "date") ?? "";
      const first = detailNumber(ev, "firstStartMinutes") ?? 0;
      return `Se han creado ${String(lineCount)} citas sintéticas para una reserva de varias personas, el ${dayLabel(date)} a partir de las ${formatHHmm(first)}.`;
    }
    case "RESERVATION_GROUP_LINE_CREATED": {
      const serviceId = detailNumber(ev, "serviceId");
      const employeeId = detailNumber(ev, "employeeId");
      const start = detailNumber(ev, "startMinutes") ?? 0;
      const date = detailString(ev, "date") ?? "";
      const service = serviceId === 0 || serviceId === 1 || serviceId === 2 ? SERVICE_LABELS[serviceId] : "un servicio";
      const who = employeeId === undefined ? "el equipo" : professionalLabelOf(ctx.cal, employeeId);
      return `${ev.memberLabel ?? "Una persona"}: ${dayLabel(date)}, ${formatHHmm(start)}, ${service}, con ${who}.`;
    }
    case "RESERVATION_GROUP_REPEATED":
      return "Se ha repetido la creación de esta reserva de varias personas. No se ha creado ninguna cita nueva.";
    // step 24 — las dos frases de la cita manual. Compuestas AQUÍ, en el
    // servidor, como todas las demás, y sin nombrar un solo identificador
    // interno: ni `res-m-…`, ni `man-…`, ni la clave del hueco.
    case "RESERVATION_MANUAL_CREATED": {
      const serviceId = detailNumber(ev, "serviceId");
      const employeeId = detailNumber(ev, "employeeId");
      const start = detailNumber(ev, "startMinutes") ?? 0;
      const date = detailString(ev, "date") ?? "";
      const quien = detailString(ev, "clientLabel") ?? "Una persona";
      const service = serviceId === 0 || serviceId === 1 || serviceId === 2 ? SERVICE_LABELS[serviceId] : "un servicio";
      const who = employeeId === undefined ? "el equipo" : professionalLabelOf(ctx.cal, employeeId);
      // step 26 (revisión adversarial, hallazgo 3). La frase sólo habla de
      // duración cuando la duración es NOTICIA: con los 30 minutos del catálogo
      // —o con un evento antiguo que no la registró— dice exactamente lo que
      // decía antes, y con cualquier otra lo dice en voz alta, porque «creó una
      // cita de dos horas y cuarto» es el acto que de verdad ocurrió.
      const durationMinutes = detailNumber(ev, "durationMinutes");
      const end = detailNumber(ev, "endMinutes");
      const especial =
        durationMinutes !== undefined && durationMinutes !== ctx.cal.slotMinutes
          ? ` Duración especial: ${formatDurationEs(durationMinutes)}${end !== undefined ? `, hasta las ${formatHHmm(end)}` : ""}.`
          : "";
      return `Un operador ha creado a mano una cita sintética para ${quien}: ${dayLabel(date)}, ${formatHHmm(start)}, ${service}, con ${who}.${especial} No ha intervenido ninguna llamada.`;
    }
    case "RESERVATION_MANUAL_REPEATED":
      return "Se ha repetido la creación de esta cita manual. No se ha creado ninguna cita nueva.";
    case "DEMO_CLOCK_ADVANCED": {
      const fromDate = detailString(ev, "fromDate") ?? "";
      const toDate = detailString(ev, "toDate") ?? "";
      const fromMinutes = detailNumber(ev, "fromMinutes") ?? 0;
      const toMinutes = detailNumber(ev, "toMinutes") ?? 0;
      if (fromDate === toDate) {
        return `El reloj de la demostración ha pasado de las ${formatHHmm(fromMinutes)} a las ${formatHHmm(toMinutes)} del ${dayLabel(toDate)}. Lo ha movido un operador.`;
      }
      return `El reloj de la demostración ha pasado de las ${formatHHmm(fromMinutes)} del ${dayLabel(fromDate)} a las ${formatHHmm(toMinutes)} del ${dayLabel(toDate)}. Lo ha movido un operador.`;
    }
    case "DEMO_RESET":
      return "Se ha reiniciado la demostración. No queda ninguna inasistencia anotada ni ninguna reserva de varias personas, y el reloj vuelve a las 09:00.";
  }
}

// ---------------------------------------------------------------------
// Record projection
// ---------------------------------------------------------------------

/** What an operator may still do with a record. Corrected is TERMINAL (§2.3, K3). */
function availableCommandsFor(state: NoShowState): readonly string[] {
  return state === "recorded" ? ["correct_no_show"] : [];
}

/** Projects ONE record. Exported because the two command endpoints answer with exactly this shape. */
export function projectNoShowRecord(
  cal: CalendarWithCapabilities,
  noShows: readonly NoShowRecord[],
  record: NoShowRecord,
): ConsoleNoShowRecordView {
  const revision = noShowRevisionOf(noShows, record.reservationId);
  return {
    id: record.id,
    reservationId: record.reservationId,
    state: record.state,
    stateLabel: NO_SHOW_STATE_LABELS[record.state],
    stateTone: NO_SHOW_STATE_TONES[record.state],
    when: `${dayLabel(record.date)}, ${formatHHmm(record.startMinutes)}–${formatHHmm(record.endMinutes)}`,
    professionalLabel: professionalLabelOf(cal, record.employeeId),
    serviceLabel: SERVICE_LABELS[record.serviceId],
    recordedAtISO: record.recordedAtISO,
    correctedAtISO: record.correctedAtISO ?? null,
    minutesAfterEndWhenRecorded: record.minutesAfterEndAtRecording,
    noShowRevision: revision,
    idempotencyKeyToMint: noShowCorrectionKey(record.reservationId, revision),
    noPenaltyNotice: OPERATIONS_COPY.noPenalty,
    availableCommands: availableCommandsFor(record.state),
  };
}

// ---------------------------------------------------------------------
// Group projection (design §4.9)
// ---------------------------------------------------------------------

/** "grupo 1" — from the store's own sequence, so it is the order of creation. */
function groupNumberLabel(groupId: string): string {
  const digits = groupId.replace(/^grp-/, "").replace(/^0+/, "");
  return `grupo ${digits === "" ? groupId : digits}`;
}

/** "09:00–09:30". */
function whenRangeLabel(startMinutes: number, endMinutes: number): string {
  return `${formatHHmm(startMinutes)}–${formatHHmm(endMinutes)}`;
}

function statusOf(cal: CalendarWithCapabilities, reservationId: string): "confirmed" | "cancelled" {
  // An appointment that is not in the calendar at all cannot be claimed to be
  // standing: the honest reading of "it is not there" is "it is not live".
  return cal.reservations.find((r) => r.id === reservationId)?.status === "confirmed" ? "confirmed" : "cancelled";
}

function groupStateOf(cal: CalendarWithCapabilities, group: ReservationGroup): ConsoleGroupState {
  const alive = group.lines.filter((l) => statusOf(cal, l.reservationId) === "confirmed").length;
  if (alive === group.lines.length) return "fully_active";
  return alive === 0 ? "fully_cancelled" : "partially_cancelled";
}

function groupStateLabelOf(state: ConsoleGroupState, alive: number, total: number): string {
  switch (state) {
    case "fully_active":
      return `Las ${String(total)} citas siguen en pie`;
    case "partially_cancelled":
      return alive === 1
        ? `Queda 1 cita en pie de ${String(total)}`
        : `Quedan ${String(alive)} citas en pie de ${String(total)}`;
    case "fully_cancelled":
      return `Ninguna de las ${String(total)} citas sigue en pie`;
  }
}

/**
 * Projects ONE group. Exported because the creation endpoint answers with
 * exactly this shape — the raw `ReservationGroup` never leaves the process.
 */
export function projectReservationGroup(
  cal: CalendarWithCapabilities,
  groups: readonly ReservationGroup[],
  group: ReservationGroup,
): ConsoleGroupView {
  const lines = group.lines.map((line): ConsoleGroupLineView => {
    const status = statusOf(cal, line.reservationId);
    return {
      reservationId: line.reservationId,
      memberLabel: line.memberLabel,
      serviceLabel: SERVICE_LABELS[line.serviceId],
      professionalLabel: professionalLabelOf(cal, line.employeeId),
      whenLabel: whenRangeLabel(line.startMinutes, line.endMinutes),
      status,
      statusLabel: status === "confirmed" ? "Confirmada" : "Cancelada",
    };
  });
  const alive = lines.filter((l) => l.status === "confirmed").length;
  const state = groupStateOf(cal, group);
  return {
    id: group.id,
    label: `Reserva para varias personas · ${groupNumberLabel(group.id)}`,
    arrangement: group.arrangement,
    arrangementLabel: ARRANGEMENT_LABELS[group.arrangement],
    date: group.date,
    dateLabel: dayLabel(group.date),
    groupState: state,
    groupStateLabel: groupStateLabelOf(state, alive, lines.length),
    // How many groups with this intention ALREADY exist is the discriminant
    // (§4.8): creating raises it, cancelling does not. Since the fase-K
    // amendment (H1) nothing depends on it for truthfulness — this route
    // memoises no body to replay — and it stays as what it always described:
    // which revision of the world this intention was minted in.
    intentKeyToMint: groupIntentKeyToMint(group.intentKey, countGroupsWithIntent(groups, group.intentKey)),
    lines,
    cancelNote: GROUP_COPY.cancelNoteForGroup,
  };
}

/**
 * The group reference every appointment of a group carries (design §4.9,
 * §4.11). The appointments show up ONE BY ONE in the Agenda; this is what
 * makes them recognisable as siblings without turning them into a container.
 */
export function buildGroupAnnotations(
  cal: CalendarWithCapabilities,
  ops: OperationsStoreSnapshot,
): ReadonlyMap<string, ConsoleReservationGroupView> {
  const byReservation = new Map<string, ConsoleReservationGroupView>();
  for (const group of ops.groups) {
    const total = group.lines.length;
    group.lines.forEach((line, index) => {
      const position = `${String(index + 1)} de ${String(total)}`;
      const groupLabel = groupNumberLabel(group.id);
      const siblingsAlive = group.lines.filter(
        (other) => other.reservationId !== line.reservationId && statusOf(cal, other.reservationId) === "confirmed",
      ).length;
      byReservation.set(line.reservationId, {
        groupId: group.id,
        groupLabel,
        memberLabel: line.memberLabel,
        positionLabel: position,
        cancelNote: GROUP_COPY.cancelNoteForLine,
        cancelDialogNote:
          `Esta cita es parte de una reserva para varias personas (${groupLabel}, cita ${position}). ` +
          "Se cancela sólo ésta; las demás se quedan como están.",
        // (Enmienda de fase K, prescrita en DECISIONES §10) Tres ramas, no
        // dos: con UNA hermana viva, «Las otras 1 cita … siguen en pie» era
        // agramatical — el sustantivo se pluralizaba y el artículo, el ordinal
        // y el verbo no—. El plural queda exactamente como estaba.
        siblingsNote:
          siblingsAlive === 0
            ? "Ninguna otra cita de este grupo sigue en pie."
            : siblingsAlive === 1
              ? "La otra cita de este grupo sigue en pie."
              : `Las otras ${String(siblingsAlive)} citas de este grupo siguen en pie.`,
      });
    });
  }
  return byReservation;
}

/**
 * Projects the proposals of `POST /api/booking/group/proposals`. Everything
 * the operator reads is resolved here, and everything the client must send
 * back to create is here too, so the browser neither chooses a professional
 * nor derives a key nor computes a canonical order.
 */
export function projectGroupProposals(
  cal: CalendarWithCapabilities,
  groups: readonly ReservationGroup[],
  proposals: readonly GroupProposal[],
): ConsoleGroupProposalView[] {
  return proposals.map((proposal, index) => {
    const intentKey = groupIntentKey(proposal.date, proposal.arrangement, proposal.lines);
    return {
      label: `Propuesta ${String(index + 1)}`,
      arrangement: proposal.arrangement,
      arrangementLabel: ARRANGEMENT_LABELS[proposal.arrangement],
      date: proposal.date,
      dateLabel: dayLabel(proposal.date),
      intentKeyToMint: groupIntentKeyToMint(intentKey, countGroupsWithIntent(groups, intentKey)),
      lines: proposal.lines.map((line): ConsoleGroupProposalLineView => ({
        memberLabel: line.memberLabel,
        serviceId: line.serviceId,
        serviceLabel: SERVICE_LABELS[line.serviceId],
        employeeId: line.employeeId,
        professionalLabel: professionalLabelOf(cal, line.employeeId),
        professionalWasRequested: line.professionalWasRequested,
        date: line.date,
        startMinutes: line.startMinutes,
        endMinutes: line.endMinutes,
        whenLabel: whenRangeLabel(line.startMinutes, line.endMinutes),
      })),
    };
  });
}

// ---------------------------------------------------------------------
// Integrity (design §2.8) — calculated, never expected
// ---------------------------------------------------------------------

/**
 * Rebuilds the set of records and their states FROM THE LOG ALONE (invariant
 * 5, criterion 8.17). If this and the live set ever disagree, the demo said it
 * did something it did not do.
 */
export function replayNoShowStates(log: readonly OperationsAuditEvent[]): Map<string, NoShowState> {
  const states = new Map<string, NoShowState>();
  for (const ev of [...log].sort((a, b) => a.seq - b.seq)) {
    if (ev.reservationId === undefined) continue;
    if (ev.kind === "NO_SHOW_RECORDED") states.set(ev.reservationId, "recorded");
    if (ev.kind === "NO_SHOW_CORRECTED") states.set(ev.reservationId, "corrected_not_a_no_show");
  }
  return states;
}

function integrityOf(
  cal: CalendarWithCapabilities,
  clock: AdvanceableClock,
  ops: OperationsStoreSnapshot,
): ConsoleOperationsIntegrityView {
  const problems: string[] = [];
  const countKind = (kind: string): number => ops.auditLog.filter((e) => e.kind === kind).length;

  // 1 — recorded minus corrected is exactly the set still in `recorded`.
  const recordedNow = ops.noShows.filter((r) => r.state === "recorded").length;
  const balance = countKind("NO_SHOW_RECORDED") - countKind("NO_SHOW_CORRECTED");
  if (balance !== recordedNow) {
    problems.push(
      `El historial dice que hay ${String(balance)} inasistencias vivas y la lista tiene ${String(recordedNow)}.`,
    );
  }

  for (const record of ops.noShows) {
    // 2 — every record points at an appointment that exists.
    const reservation = cal.reservations.find((r) => r.id === record.reservationId);
    if (reservation === undefined) {
      problems.push(`Hay una inasistencia anotada sobre una cita que ya no existe (${record.reservationId}).`);
      continue;
    }
    // 3 — every appointment with a record HAS finished on the current clock.
    // Structurally true because the clock only moves forward (§3.2). The
    // appointment's CURRENT status is deliberately not looked at here: a
    // recorded no-show that was cancelled afterwards is legitimate (K6).
    if (minutesAfterEnd(clock, reservation) < 0) {
      problems.push(`Hay una inasistencia anotada sobre una cita que aún no ha terminado (${record.reservationId}).`);
    }
  }

  // 4 — no record was written over an appointment that was cancelled at the
  // time. The command refuses it; the log has to be able to say so too.
  for (const record of ops.noShows) {
    const recordedEvents = ops.auditLog.filter((e) => e.kind === "NO_SHOW_RECORDED" && e.noShowId === record.id);
    if (recordedEvents.length !== 1) {
      problems.push(`La inasistencia ${record.id} no tiene exactamente un registro en el historial.`);
      continue;
    }
    const first = recordedEvents[0];
    if (first !== undefined && detailString(first, "statusAtRecording") !== "confirmed") {
      problems.push(`La inasistencia ${record.id} se anotó sobre una cita que no estaba confirmada.`);
    }
  }

  // 4 bis (design §4.6.2, blocker B2) — a group is only ever COMPLETE, and no
  // two lines anywhere share a reservation id. `memoryStore.addReservation`
  // pushes without checking ids, so "the ids cannot repeat" has to be a
  // CALCULATED fact and not a promise: with the identity minted from the
  // store's sequence it holds, and if it ever stopped holding, the banner
  // would say so instead of two rows quietly answering to one id.
  const seenLineIds = new Set<string>();
  for (const group of ops.groups) {
    for (const line of group.lines) {
      if (seenLineIds.has(line.reservationId)) {
        problems.push(`Hay dos citas del ${groupNumberLabel(group.id)} que comparten identificador.`);
      }
      seenLineIds.add(line.reservationId);
      if (!cal.reservations.some((r) => r.id === line.reservationId)) {
        problems.push(
          `El ${groupNumberLabel(group.id)} dice tener una cita (${line.memberLabel}) que no existe en la agenda.`,
        );
      }
    }
  }

  // 5 — replaying the log reproduces exactly the live set and its states.
  const replayed = replayNoShowStates(ops.auditLog);
  if (replayed.size !== ops.noShows.length) {
    problems.push("Reproducir el historial no devuelve el mismo número de inasistencias que hay anotadas.");
  }
  for (const record of ops.noShows) {
    if (replayed.get(record.reservationId) !== record.state) {
      problems.push(`Reproducir el historial no devuelve el mismo estado para ${record.id}.`);
    }
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------
// The whole `operations` key
// ---------------------------------------------------------------------

export function buildOperationsSnapshot(
  cal: CalendarWithCapabilities,
  clock: AdvanceableClock,
  ops: OperationsStoreSnapshot,
): ConsoleOperationsView {
  const records = ops.noShows.map((record) => projectNoShowRecord(cal, ops.noShows, record));

  const eligibleReservationIds = cal.reservations
    .filter((r) => isEligibleForNoShow(clock, r))
    .map((r) => r.id);

  const textContext: TextContext = { cal, noShows: ops.noShows };
  const shown = ops.auditLog.slice(-OPERATIONS_AUDIT_ITEMS_SHOWN);
  const audit = {
    total: ops.auditLog.length,
    shown: shown.length,
    items: shown.map((ev): ConsoleOperationsAuditItemView => ({
      id: ev.id,
      seq: ev.seq,
      kind: ev.kind,
      text: operationsAuditText(ev, textContext),
      actor: ev.actor,
      atISO: ev.atISO,
      reservationId: ev.reservationId ?? null,
      noShowId: ev.noShowId ?? null,
      groupId: ev.groupId ?? null,
      fromState: ev.fromState ?? null,
      toState: ev.toState ?? null,
    })),
  };

  const countKind = (kind: string): number => ops.auditLog.filter((e) => e.kind === kind).length;
  const noShowsRecordedNow = ops.noShows.filter((r) => r.state === "recorded").length;
  const noShowsCorrected = countKind("NO_SHOW_CORRECTED");

  // step 19 (C3-C7) — DERIVADO de `ops.groups`, nunca un contador aparte.
  // `groupStateOf` es EXACTAMENTE la misma función que ya clasifica cada
  // grupo para `projectReservationGroup`: no hay una segunda regla que
  // pudiera divergir de ella.
  const groupStates = ops.groups.map((g) => groupStateOf(cal, g));
  const groupsCreated = ops.groups.length;
  const groupReservationsCreated = ops.groups.reduce((sum, g) => sum + g.lines.length, 0);
  const groupsFullyActive = groupStates.filter((s) => s === "fully_active").length;
  const groupsPartiallyCancelled = groupStates.filter((s) => s === "partially_cancelled").length;
  const groupsFullyCancelled = groupStates.filter((s) => s === "fully_cancelled").length;
  const groupsConsecutiveCreated = ops.groups.filter((g) => g.arrangement === "consecutive").length;
  const groupsSimultaneousCreated = ops.groups.filter((g) => g.arrangement === "simultaneous").length;

  const metrics: ConsoleOperationsMetricsView = {
    noShowsRecordedNow,
    noShowsCorrected,
    noShowRecordCommands: countKind("NO_SHOW_RECORDED"),
    repeatedCommandsIgnored: countKind("NO_SHOW_COMMAND_REPEATED"),
    clockAdvances: countKind("DEMO_CLOCK_ADVANCED"),
    recordedAndCorrectedLine: `Inasistencias anotadas ahora mismo (sintéticas): ${String(noShowsRecordedNow)} · Registros corregidos: ${String(noShowsCorrected)}`,
    homeLine:
      noShowsRecordedNow === 0
        ? null
        : OPERATIONS_COPY.homeLine.replace("{n}", String(noShowsRecordedNow)),
    groupsCreated,
    groupReservationsCreated,
    groupsFullyActive,
    groupsPartiallyCancelled,
    groupsFullyCancelled,
    groupsConsecutiveCreated,
    groupsSimultaneousCreated,
  };

  return {
    clock: buildClockView(clock),
    noShows: { records, eligibleReservationIds, copy: OPERATIONS_COPY },
    groups: {
      items: ops.groups.map((group) => projectReservationGroup(cal, ops.groups, group)),
      copy: GROUP_COPY,
    },
    metrics,
    integrity: integrityOf(cal, clock, ops),
    audit,
  };
}

// ---------------------------------------------------------------------
// The annotations the EXISTING reservation projections gain (design §2.10)
// ---------------------------------------------------------------------

function noShowViewOf(record: NoShowRecord): ConsoleReservationNoShowView {
  return {
    state: record.state,
    stateLabel: NO_SHOW_STATE_LABELS[record.state],
    recordedAtISO: record.recordedAtISO,
    ...(record.correctedAtISO !== undefined ? { correctedAtISO: record.correctedAtISO } : {}),
  };
}

/**
 * What `snapshot.ts` needs to annotate BOTH reservation projections with the
 * no-show facts (design §2.10). Built here so that `snapshot.ts` keeps
 * knowing nothing about operations internals — and so that the two keys the
 * interface mints are resolved in exactly one place (decision N3).
 */
export function buildNoShowAnnotations(
  cal: CalendarWithCapabilities,
  clock: AdvanceableClock,
  ops: OperationsStoreSnapshot,
): ReadonlyMap<string, ConsoleReservationNoShowAnnotation> {
  const byReservation = new Map<string, ConsoleReservationNoShowAnnotation>();
  for (const reservation of cal.reservations) {
    const record = ops.noShows.find((r) => r.reservationId === reservation.id);
    const revision = noShowRevisionOf(ops.noShows, reservation.id);
    const ineligible = noShowIneligibleReasonCode(clock, reservation);
    byReservation.set(reservation.id, {
      ...(record !== undefined ? { noShow: noShowViewOf(record) } : {}),
      eligibleForNoShow: ineligible === null,
      noShowRevision: revision,
      ...(ineligible !== null ? { noShowIneligibleReason: INELIGIBLE_REASON_LABELS[ineligible] } : {}),
      noShowKeyToMint: noShowRecordKey(reservation.id, revision),
      noShowFixKeyToMint: noShowCorrectionKey(reservation.id, revision),
    });
  }
  return byReservation;
}

// ---------------------------------------------------------------------
// step 24 — LA CITA MANUAL (diseño §4, §7, §11)
// ---------------------------------------------------------------------

/**
 * EL VOCABULARIO CERRADO de esta funcionalidad. Cada frase que un operador lee
 * sobre una cita manual está escrita AQUÍ y en ningún otro sitio; el navegador
 * no compone ni una. Es la misma regla que rige `GROUP_COPY` y `WAITLIST_COPY`.
 */
export const MANUAL_BOOKING_COPY = {
  origin: "Creada manualmente por el operador",
  syntheticNotice:
    "Entorno sintético: esta cita no existe para nadie fuera de esta demostración y no llega a ningún sistema real.",
  confirmButton: "Confirmar y crear la cita sintética",
  openButton: "Crear cita manual",
  anyResolvedPrefix: "Con «cualquier profesional», a esta hora le toca",
  requestedPrefix: "Se ha pedido expresamente a",
  noSlotChosen: "Elige uno de los huecos disponibles. No se puede escribir una hora a mano.",
} as const;

/**
 * LAS FRASES DE CONFLICTO (diseño §8). Un operador NUNCA lee el código
 * técnico como mensaje principal: el código viaja aparte, para el detalle
 * plegado, y esta tabla es lo que se le enseña.
 */
export const MANUAL_CONFLICT_LABELS: Record<string, string> = {
  slot_no_longer_free: "Ese hueco acaba de ocuparse. No se ha creado ninguna cita.",
  /**
   * step 26 (revisión adversarial, hallazgo 2). La frase NO nombra el cierre
   * del local a propósito: el tramo libre puede acabar por el cierre, por una
   * pausa, por una ausencia aprobada o porque justo después hay otra cita, y
   * afirmar una de las cuatro sería inventar. Lo único cierto en las cuatro es
   * que el tramo se acaba antes de que quepa lo que se ha pedido. El fin y los
   * minutos exactos viajan aparte, en `attempted`.
   */
  interval_does_not_fit: "Esa duración no cabe entera desde esa hora: el tramo libre acaba antes.",
  professional_no_longer_available: "Esa persona del equipo ya no está disponible a esa hora.",
  venue_closed: "El local está cerrado ese día.",
  date_outside_booking_horizon: "Esa fecha queda fuera del plazo en el que se puede reservar.",
  slot_in_the_past: "Esa hora ya ha pasado.",
  professional_cannot_perform_service: "Esa persona del equipo no hace ese servicio.",
  no_capable_and_free: "A esa hora no queda nadie del equipo que pueda hacer ese servicio.",
  client_label_not_in_closed_catalogue: "La persona tiene que ser una del catálogo sintético cerrado.",
  duration_not_allowed: "Esa duración no es válida: sólo se puede elegir en pasos de 15 minutos.",
  idempotency_key_reused_with_different_body:
    "Esa petición se repite con un contenido distinto. No se ha creado nada.",
};

/**
 * LA DURACIÓN, DICHA EN CASTELLANO Y EN UN SOLO SITIO (step 26 §13).
 *
 * `30 min`, `1 h`, `1 h 30 min`, `2 h 15 min`, `4 h`: sin decimales, sin
 * «minutos» escrito entero y sin ninguna variante regional. Vive en el
 * servidor porque el navegador no compone frases de negocio, y es la MISMA
 * función que rotula el control de duración del asistente — una prueba compara
 * carácter a carácter los rótulos estáticos con su salida, precisamente para
 * que las dos no puedan separarse.
 *
 * No sabe nada de servicios, de precios ni de políticas: convierte un número de
 * minutos en su nombre, y nada más.
 */
export function formatDurationEs(minutes: number): string {
  const horas = Math.floor(minutes / 60);
  const restoMinutos = minutes % 60;
  if (horas === 0) return `${String(restoMinutos)} min`;
  if (restoMinutos === 0) return `${String(horas)} h`;
  return `${String(horas)} h ${String(restoMinutos)} min`;
}

/** Traduce un código de conflicto a su frase, sin dejar nunca al operador sin explicación. */
export function manualConflictLabel(code: string): string {
  return (
    MANUAL_CONFLICT_LABELS[code] ??
    "La demostración ha parado la acción para no escribir algo incorrecto. No se ha creado ninguna cita."
  );
}

export interface ConsoleManualProposalView {
  clientLabel: string;
  serviceLabel: string;
  /**
   * «30 min», «2 h 15 min» — la duración REAL de esta cita, derivada de
   * `endMinutes - startMinutes` y redactada por `formatDurationEs`. Nunca
   * `cal.slotMinutes`: desde step 26 una cita manual no dura necesariamente un
   * hueco de la rejilla.
   */
  durationLabel: string;
  dateLabel: string;
  whenLabel: string;
  professionalLabel: string;
  /** Dice EXPLÍCITAMENTE qué profesional quedó asignado, y si se pidió por su nombre. */
  professionalNote: string;
  originLabel: string;
  syntheticNotice: string;
  confirmLabel: string;
  /**
   * Lo que hay que reenviar para confirmar: ya resuelto, y revalidado
   * igualmente al confirmar.
   *
   * LLEVA LA DURACIÓN (step 26, revisión adversarial, hallazgo 1). Sin ella,
   * quien reenviase este objeto tal cual tras una vista previa de 135 minutos
   * creaba una cita de 30 con un 201 silencioso —el servidor rellenaba el
   * hueco con `cal.slotMinutes`— y la clave acuñada (`…d135…`) dejaba de
   * describir la cita guardada (`…d30…`). Este objeto tiene que ser, él solo,
   * la petición completa: si hay que añadirle algo a mano, es que miente.
   */
  confirm: {
    clientLabel: string;
    serviceId: number;
    date: string;
    startMinutes: number;
    durationMinutes: number;
    employeeId: number;
  };
  /**
   * La clave de idempotencia que la interfaz debe mandar. SE ACUÑA AQUÍ
   * (decisión N3 de step 18): el navegador nunca deriva una clave, porque
   * derivarla exige saber cuántas citas con esta intención se han creado ya.
   */
  keyToMint: string;
}

/** Proyecta UNA propuesta de cita manual. El objeto de dominio nunca sale del proceso. */
export function projectManualProposal(
  cal: CalendarWithCapabilities,
  ops: OperationsStoreSnapshot,
  proposal: ManualProposal,
): ConsoleManualProposalView {
  const who = professionalLabelOf(cal, proposal.employeeId);
  return {
    clientLabel: proposal.clientLabel,
    serviceLabel: SERVICE_LABELS[proposal.serviceId],
    durationLabel: formatDurationEs(proposal.endMinutes - proposal.startMinutes),
    dateLabel: dayLabel(proposal.date),
    whenLabel: whenRangeLabel(proposal.startMinutes, proposal.endMinutes),
    professionalLabel: who,
    // El paso 5 del flujo EXIGE decir qué profesional quedó asignado, y sobre
    // todo cuando se pidió «cualquiera»: es la única forma de que el operador
    // sepa a quién le está dando la cita antes de confirmarla.
    professionalNote: proposal.professionalWasRequested
      ? `${MANUAL_BOOKING_COPY.requestedPrefix} ${who}.`
      : `${MANUAL_BOOKING_COPY.anyResolvedPrefix} ${who}.`,
    originLabel: MANUAL_BOOKING_COPY.origin,
    syntheticNotice: MANUAL_BOOKING_COPY.syntheticNotice,
    confirmLabel: MANUAL_BOOKING_COPY.confirmButton,
    confirm: {
      clientLabel: proposal.clientLabel,
      serviceId: proposal.serviceId,
      date: proposal.date,
      startMinutes: proposal.startMinutes,
      // La MISMA duración que se acaba de revalidar y que viaja dentro de
      // `intentKey`: reenviar esto es reenviar exactamente lo que se propuso.
      durationMinutes: proposal.endMinutes - proposal.startMinutes,
      employeeId: proposal.employeeId,
    },
    keyToMint: manualIntentKeyToMint(
      proposal.intentKey,
      countManualBookingsWithIntent(ops.manualBookings, proposal.intentKey),
    ),
  };
}

export interface ConsoleManualBookingView {
  id: string;
  reservationId: string;
  clientLabel: string;
  serviceLabel: string;
  dateLabel: string;
  whenLabel: string;
  professionalLabel: string;
  originLabel: string;
  status: "confirmed" | "cancelled";
  statusLabel: string;
  /** La frase de éxito, ya redactada: nombra fecha, hora y profesional. */
  successLabel: string;
}

/** Proyecta UNA cita manual ya escrita. La respuesta de la ruta es exactamente esto. */
export function projectManualBooking(
  cal: CalendarWithCapabilities,
  booking: ManualBooking,
): ConsoleManualBookingView {
  const status = statusOf(cal, booking.reservationId);
  const who = professionalLabelOf(cal, booking.employeeId);
  return {
    id: booking.id,
    reservationId: booking.reservationId,
    clientLabel: booking.clientLabel,
    serviceLabel: SERVICE_LABELS[booking.serviceId],
    dateLabel: dayLabel(booking.date),
    whenLabel: whenRangeLabel(booking.startMinutes, booking.endMinutes),
    professionalLabel: who,
    originLabel: MANUAL_BOOKING_COPY.origin,
    status,
    statusLabel: status === "confirmed" ? "Confirmada" : "Cancelada",
    successLabel:
      `Cita sintética creada para ${booking.clientLabel}: ${dayLabel(booking.date)}, ` +
      `${whenRangeLabel(booking.startMinutes, booking.endMinutes)}, con ${who}.`,
  };
}

/**
 * EL ORIGEN «creada manualmente», DERIVADO y nunca guardado dos veces (diseño
 * §11.1). Se lee del registro de operaciones, exactamente igual que el origen
 * «desde lista de espera» se lee del suyo (`buildReservationAnnotations` en
 * `waitlistSnapshot.ts`), así que las dos versiones de la verdad no pueden
 * divergir porque sólo hay una.
 *
 * QUIÉN MANDA AQUÍ: el evento `RESERVATION_MANUAL_CREATED`, y sólo él. Es la
 * puerta: si no está en el registro, no hay origen que enseñar. `manualBookings`
 * NO abre esa puerta — se le pregunta después, y únicamente por los datos de la
 * cita (su identificador y a nombre de quién está). Recorrer `manualBookings`
 * para decidir *si* anotar convertiría el registro en decorado y volvería a
 * poner esta verdad en dos sitios: exactamente lo que §11.1 prohíbe.
 *
 * Y las dos referencias tienen que contarse la misma historia. Si el evento
 * apunta a una cita que no está, o a una que dice pertenecer a OTRA reserva, no
 * se anota nada: colocar el origen sobre la reserva equivocada es peor que no
 * mostrarlo, porque una etiqueta falsa sí se cree.
 *
 * NO SE ABUSA de `callIdHash`: una cita manual no tiene llamada, y ponerle un
 * hash inventado contaminaría un flujo diseñado para llamadas y falsearía
 * `eventCounts.internal`.
 */
export function buildManualBookingAnnotations(
  ops: OperationsStoreSnapshot,
): ReadonlyMap<string, ConsoleReservationManualView> {
  const datosPorCita = new Map<string, ManualBooking>();
  for (const booking of ops.manualBookings) datosPorCita.set(booking.id, booking);

  const byReservation = new Map<string, ConsoleReservationManualView>();
  for (const ev of ops.auditLog) {
    if (ev.kind !== "RESERVATION_MANUAL_CREATED") continue;
    if (ev.reservationId === undefined || ev.manualBookingId === undefined) continue;
    const booking = datosPorCita.get(ev.manualBookingId);
    if (booking === undefined || booking.reservationId !== ev.reservationId) continue;
    byReservation.set(ev.reservationId, {
      manualBookingId: booking.id,
      clientLabel: booking.clientLabel,
      originLabel: MANUAL_BOOKING_COPY.origin,
    });
  }
  return byReservation;
}
