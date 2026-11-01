import type { CalendarWithCapabilities } from "../callEngine/capabilities.js";
import { isSlotFree } from "../callEngine/calendar/resolveAvailability.js";
import { formatHHmm } from "../callEngine/domain/time.js";
import { SERVICE_LABELS, type Clock, type EmployeeId, type ServiceId } from "../callEngine/domain/types.js";
import type { HumanTask } from "../callEngine/store/memoryStore.js";
import {
  entryAlreadyAnsweringSlot,
  evaluateReleasedSlot,
  matchEntryAgainstSlot,
  proposalCandidatesFor,
  proposalStanding,
} from "../callEngine/waitlist/matching.js";
import {
  AVAILABLE_COMMANDS_BY_STATE,
  parseSlotKey,
  type CancellationRecord,
  type ProposalInvalidReasonCode,
  type ReleasedSlot,
  type SlotProposal,
  type WaitlistAuditEvent,
  type WaitlistAuditKind,
  type WaitlistEntry,
  WAITLIST_MISMATCH_REASONS,
  type WaitlistEntryState,
  type WaitlistMismatchReason,
} from "../callEngine/waitlist/model.js";
import type { WaitlistStoreSnapshot } from "../callEngine/waitlist/store.js";
import { dayPhraseEs, parseDateTime, timeLabelFromString } from "../utils/dateFormatterEs.js";
import type { ConsoleReservationCancellationView } from "./snapshot.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 17 — THE WAITLIST PROJECTION (design §6.3, §7.1, §11, §14.1).
 *
 * SAME HARD RULE as snapshot.ts, which this module is a sibling of: every
 * value below is built field by field from an EXPLICIT ALLOW LIST. There is
 * not one `...spread` of a domain object into a returned value anywhere
 * here, so a field added to the waitlist model tomorrow cannot leak into the
 * console without this file changing.
 *
 * WHY EVERYTHING ARRIVES RESOLVED. Design risk 14.1: the console's inherited
 * defect was a browser that re-derived business meaning. So the whole
 * `waitlist` block travels ALREADY RESOLVED — state labels, preference
 * summaries in Spanish, `stillValid`, mismatch reasons, available commands,
 * audit texts. The interface only formats minutes into "HH:mm" with the
 * helper it already has. No timetable, precedence, capability or
 * compatibility calculation ever travels raw for the client to work out.
 *
 * WHAT IS NEVER CACHED. `offer.stillValid`, `releasedSlots[].stillFree`,
 * `compatibleEntryIds`, `incompatible[].reasons`, `availableCommands` and
 * `trace` are RE-DERIVED on every single `buildWaitlistSnapshot` call. A call
 * run from Laboratorio can occupy a slot between two 2-second polls, and a
 * cached "compatible" would be a lie the operator could act on (design §14.6).
 *
 * NO PERSONAL DATA. `clientLabel` only ever matches `^Cliente [A-Z]$`; a
 * professional's synthetic `displayName` appears (as it already does in
 * snapshot.ts, under the same reasoning) and nothing else about a person
 * exists in this model to leak.
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Closed label catalogues (design §7.1). Single source of truth, server side.
// ---------------------------------------------------------------------

const STATE_LABELS: Readonly<Record<WaitlistEntryState, string>> = {
  pending: "Pendiente",
  matched: "Compatible con un hueco",
  notice_simulated: "Aviso simulado",
  accepted: "Aceptada",
  declined: "Rechazada",
  expired_manually: "Caducada manualmente",
  converted: "Convertida en reserva sintética",
  withdrawn: "Retirada",
};

/** The console's existing pill vocabulary: ok | attention | derived | incomplete | none. */
const STATE_TONES: Readonly<Record<WaitlistEntryState, string>> = {
  pending: "none",
  matched: "attention",
  notice_simulated: "derived",
  accepted: "ok",
  declined: "incomplete",
  expired_manually: "incomplete",
  converted: "ok",
  withdrawn: "none",
};

const OPT_IN_LABELS: Readonly<Record<string, string>> = {
  phone_simulated: "Alta tomada por teléfono (simulada)",
  counter_simulated: "Alta tomada en el mostrador (simulada)",
  operator_entered: "Alta introducida por el operador",
};

const CANCELLATION_REASON_LABELS: Readonly<Record<string, string>> = {
  client_cancelled_by_phone_simulated: "El cliente canceló por teléfono (simulado)",
  client_cancelled_at_counter_simulated: "El cliente canceló en el mostrador (simulado)",
  venue_cancelled_simulated: "El local canceló la cita (simulado)",
  unspecified: "Sin motivo indicado",
};

/**
 * The mismatch labels. `professional_cannot_perform_service` is a FUNCTION of
 * the slot, because "Nerea (sintética) no hace ese servicio" names the
 * person who cannot do it — a generic "el profesional no puede" would make
 * the operator go and look it up.
 */
function mismatchLabel(code: WaitlistMismatchReason, professionalLabel: string): string {
  switch (code) {
    case "date_outside_preferred_range":
      return "El día no está en el rango de fechas que pidió";
    case "time_outside_preferred_window":
      return "La franja que pidió no incluye esta hora";
    case "different_professional_requested":
      return "Pidió a otra persona del equipo";
    case "professional_cannot_perform_service":
      return `${professionalLabel} no hace ese servicio`;
    case "date_outside_booking_horizon":
      return "Ese día queda fuera del plazo en el que se puede reservar";
    case "slot_in_the_past":
      return "Ese hueco ya ha pasado";
    case "slot_no_longer_free":
      return "Ese hueco ya no está libre";
  }
}

// ---------------------------------------------------------------------
// step 23 §4/§7 — closed catalogues for the proposal and the trail.
// ---------------------------------------------------------------------

/** The eight rungs of the §4 ladder, in their precedence order. */
export type ProposalStatusCode =
  | "converted"
  | "accepted"
  | "notice_simulated"
  | "declined"
  | "invalidated"
  | "substituted"
  | "approved"
  | "pending_approval";

/**
 * Label and tone of each rung. The browser composes NONE of these sentences
 * and decides NO tone: it reads them. And the tone never travels alone —
 * every row carries its label in words, because colour does not inform on its
 * own (A8 of step 21A).
 */
const PROPOSAL_STATUS: Readonly<Record<ProposalStatusCode, { label: string; tone: string }>> = {
  converted: { label: "Convertida en reserva sintética", tone: "ok" },
  accepted: { label: "Aceptada (respuesta registrada por el operador)", tone: "ok" },
  notice_simulated: { label: "Aviso simulado (no se ha enviado nada)", tone: "derived" },
  declined: { label: "Rechazada", tone: "incomplete" },
  invalidated: { label: "Ya no vale", tone: "incomplete" },
  substituted: { label: "Aprobada — elegida por el operador", tone: "ok" },
  approved: { label: "Aprobada — pendiente de avisar", tone: "ok" },
  pending_approval: { label: "Pendiente de aprobación", tone: "attention" },
};

/**
 * (Reparación R2-UX, defecto 2) «Cualquier profesional», nunca «con quien
 * sea» ni «Cualquiera» a secas. Es la tercera de las tres cosas que la frase
 * de preferencia tiene que decir por separado, y se escribe UNA vez.
 */
const ANY_PROFESSIONAL_LABEL = "Cualquier profesional";

/**
 * THE ACTIVITY FILTER (D23-5), a CLOSED list. Only facts of the cancellation
 * and waitlist domain, and decisions a person took, get in.
 *
 * WHAT IS LEFT OUT ON PURPOSE, and why: the internal-bookkeeping events
 * (`WAITLIST_MATCH_EVALUATED`, `WAITLIST_ENTRY_MATCHED`,
 * `WAITLIST_OFFER_RELEASED`), the ones about an entry joining or leaving the
 * list, the reset, the idempotent replay and the injected failure all stay
 * whole in the technical `<details>`, which is not touched. And of navigation,
 * polling, repaints, keystrokes or technical exceptions there is NOTHING to
 * filter: none of that ever reaches the log, because nobody writes it.
 *
 * It is an ALLOW LIST deliberately: a `kind` added tomorrow cannot slip into
 * the trail by accident — somebody has to put it here by hand.
 */
export const ACTIVITY_KINDS: readonly WaitlistAuditKind[] = [
  "RESERVATION_CANCELLED_ON_TIME",
  "RESERVATION_CANCELLED_LATE",
  "LATE_CANCELLATION_REVIEWED",
  "SLOT_RELEASED",
  "SLOT_RELEASE_PRODUCED_NO_SLOTS",
  "WAITLIST_PROPOSAL_CREATED",
  "WAITLIST_PROPOSAL_APPROVED",
  "WAITLIST_PROPOSAL_SUBSTITUTED",
  "WAITLIST_PROPOSAL_INVALIDATED",
  "WAITLIST_PROPOSAL_NONE_AVAILABLE",
  "WAITLIST_NOTICE_SIMULATED",
  "WAITLIST_OFFER_ACCEPTED",
  "WAITLIST_OFFER_DECLINED",
  "WAITLIST_ENTRY_CONVERTED",
  "WAITLIST_CONVERSION_CONFLICT",
] as const;

/** The pill of each trail row: ALWAYS with words, never colour alone. */
const ACTIVITY_STATUS: Readonly<Record<string, { label: string; tone: string }>> = {
  RESERVATION_CANCELLED_ON_TIME: { label: "Dentro de plazo", tone: "ok" },
  RESERVATION_CANCELLED_LATE: { label: "Fuera de plazo", tone: "attention" },
  LATE_CANCELLATION_REVIEWED: { label: "Revisada, sin acción", tone: "ok" },
  SLOT_RELEASED: { label: "Hueco liberado", tone: "derived" },
  SLOT_RELEASE_PRODUCED_NO_SLOTS: { label: "Sin huecos que liberar", tone: "none" },
  WAITLIST_PROPOSAL_CREATED: { label: "Pendiente de aprobación", tone: "attention" },
  WAITLIST_PROPOSAL_APPROVED: { label: "Aprobada — pendiente de avisar", tone: "ok" },
  WAITLIST_PROPOSAL_SUBSTITUTED: { label: "Aprobada — elegida por el operador", tone: "ok" },
  WAITLIST_PROPOSAL_INVALIDATED: { label: "Ya no vale", tone: "incomplete" },
  WAITLIST_PROPOSAL_NONE_AVAILABLE: { label: "Sin propuesta", tone: "incomplete" },
  WAITLIST_NOTICE_SIMULATED: { label: "Aviso simulado", tone: "derived" },
  WAITLIST_OFFER_ACCEPTED: { label: "Aceptada", tone: "ok" },
  WAITLIST_OFFER_DECLINED: { label: "Rechazada", tone: "incomplete" },
  WAITLIST_ENTRY_CONVERTED: { label: "Convertida en reserva sintética", tone: "ok" },
  WAITLIST_CONVERSION_CONFLICT: { label: "No se creó la reserva", tone: "incomplete" },
};

/**
 * "Sistema" or "Operador", and nothing else. It is the only distinction the
 * trail makes about who acted: there is no user model and no staff auditing in
 * this demo, and pretending otherwise would be inventing a fact.
 */
function originLabelOf(actor: string): string {
  return actor === "operator" ? "Operador" : "Sistema";
}

/** Every row of the trail links to the same place: there is no eighth route. */
export const ACTIVITY_HREF = "#/lista-espera";

/**
 * step 23 §4 — why a proposal stopped standing, in Spanish. It reuses
 * `mismatchLabel` for the seven B1..B7 codes, so there is exactly ONE wording
 * of "ese hueco ya no está libre" in the whole deliverable, and adds the one
 * code of its own: an entry that left `{pendiente, compatible}` is not
 * incompatible with the slot, it is simply no longer in the running.
 */
function proposalInvalidLabel(code: string, professionalLabel: string): string {
  if (code === "entry_no_longer_active") return "Esa persona ya no está activa en la lista";
  if (code === "offer_no_longer_on_this_slot") return "Esa persona ya no está emparejada con este hueco";
  return WAITLIST_MISMATCH_REASONS.includes(code as WaitlistMismatchReason)
    ? mismatchLabel(code as WaitlistMismatchReason, professionalLabel)
    : "La situación ha cambiado";
}

/**
 * THE SENTENCES OF §5 AND §9, generated here and nowhere else. The interface
 * never composes its own copy about what this system refuses to decide: one
 * source of truth means the promise on screen cannot drift from the promise
 * in the design.
 */
export const WAITLIST_COPY = {
  readingOrderNote: "Orden de lectura, no de prioridad.",
  readingOrderExplained:
    "Están ordenadas por cuándo se apuntaron. Es orden de lectura, no de prioridad: nadie tiene preferencia sobre nadie.",
  severalFit: "Varias personas encajan en este hueco. Elige tú a quién se le ofrece.",
  noneFit: "Nadie de la lista encaja en este hueco.",
  /** step 19 D3. El caso de UNA persona, que hasta ahora el navegador
      componía a mano y en plural. No nombra a nadie, exactamente como sus dos
      hermanas: quién encaja, en qué orden y con qué pidió cada una vive en la
      pantalla de Lista de espera, donde además nada viene preseleccionado. */
  oneFits: "Una persona de la lista encaja en este hueco. Decides tú si se le ofrece.",
  decideInWaitlistScreen:
    "Quién encaja, con qué pidió cada persona y en qué orden se lee está en la pantalla de Lista de espera.",
  /**
   * step 23 §9. `systemChoseNobody` («El sistema no ha elegido a nadie. No lo
   * hará.») VIVÍA AQUÍ y se ha RETIRADO, no ocultado. Desde esta misión el
   * sistema sí sugiere a alguien —por una regla determinista, y a la espera de
   * que una persona lo apruebe—, así que esa frase habría pasado a ser falsa
   * justo en la tarjeta donde se leía. Su único consumidor era esa tarjeta;
   * dejar la clave en el contrato sin usarla sería guardar una promesa que ya
   * no cumplimos. Las tres frases de debajo la sustituyen, y ninguna de ellas
   * afloja lo que sí seguimos prometiendo: nadie recibe un hueco hasta que una
   * persona lo aprueba y avisa.
   */
  nothingExpires: "Nada caduca solo. Si esta persona ya no espera, márcala tú como caducada.",
  noAcceptanceDeadline: "No hay plazo de aceptación. No prometemos ninguno.",
  simulatedNoticeOnly: "Aviso simulado. No se ha enviado ningún mensaje ni se ha llamado a nadie.",
  noPenalty:
    "No se ha aplicado ninguna penalización. Qué hacer con estas cancelaciones está pendiente de decidir con Demo Salon.",
  onlyThisSlot: "Esto sólo mira el hueco que se acaba de liberar. No busca alternativas en el resto de la agenda.",
  venueClosedThatDay: "Esta cancelación no libera ningún hueco: ese día el local no abre.",
  /**
   * step 18 §0.5, AMENDMENT E3. The clock is no longer frozen: since step 18
   * it moves — forwards only, and only when an operator moves it from the
   * Laboratorio (§3). "Está congelado" would therefore be a literal lie on
   * screen the moment somebody pressed "Avanzar". What does NOT change is the
   * consequence: no time passes on its own here, so no duration is measured
   * and none is shown. The key keeps its name because the sentence still owns
   * the same promise; the projection key that DID lie was renamed (E9).
   */
  frozenClock:
    "El reloj de esta demostración es sintético y sólo avanza cuando tú lo mueves en el Laboratorio. Aquí no pasa el tiempo solo, así que no se puede medir cuánto tarda en cubrirse un hueco y no se muestra ninguna cifra de tiempo.",
  policyIsDemoValue: "Valor de demostración, configurable por local. No es una política aprobada por Demo Salon.",
  changingPolicyDoesNotRewrite: "Cambiar esto no reescribe las cancelaciones ya registradas.",
  /**
   * step 18 §0.5, AMENDMENT E1. Of the three things this sentence called
   * future, two exist since step 18 and one still does not. Saying "no
   * implementado" about all three had stopped being true, and a false denial
   * is exactly as bad as a false promise. The deposit half is unchanged
   * because it is still true (§6.14, K15).
   */
  futureDesign:
    "Los depósitos siguen siendo diseño futuro, no implementado. Las inasistencias y las reservas para varias personas ya existen en esta demostración, en su forma más conservadora: se anotan a mano, no aplican ninguna penalización y no cambian a quién encaja en un hueco liberado.",
  emptyPendingSlots: "Ahora mismo no hay ningún hueco liberado esperando decisión.",
  emptyEntries: "Nadie está apuntado a la lista de espera. Cuando alguien acepte apuntarse, aparecerá aquí.",
  syntheticReservationWarning: "Se creará una reserva sintética. Esta demostración no toca ningún sistema real.",
  /**
   * step 23 §9. The three sentences of the human loop, and the whole point of
   * the mission in one line: the system SUGGESTS, a person DECIDES, and nobody
   * is contacted in between. `proposalReasonFifo` is the literal, canonical
   * reason of R1 — there is no other, because there is no other rule.
   */
  proposalIsSuggestion:
    "Es una sugerencia del sistema, no una decisión. Nadie recibe este hueco hasta que una persona lo apruebe y avise.",
  proposalReasonFifo: "Primera persona compatible por orden de alta en lista.",
  proposalOperatorChoice:
    "Elegida por el operador. La persona que proponía el sistema sigue en la lista y puede quedarse con otro hueco.",
  /**
   * (Reparación R2-UX, defectos 5 y 6) LO QUE VA A PASAR, ANTES DE PULSAR.
   *
   * `take_over_proposal` sustituye Y APRUEBA en el mismo acto (§5.1). La
   * etiqueta que la auditoría manual encontró —«Proponer a esta persona en su
   * lugar»— sólo contaba la mitad, así que el operador aprobaba sin saberlo.
   * La máquina de estados NO se toca: lo que se arregla es que la pantalla lo
   * diga antes, y lo confirme después, con las mismas cuatro consecuencias.
   */
  substitutionEffectsBefore:
    "Al confirmarlo cambia el destinatario y la propuesta queda aprobada. No se envía ningún aviso y no se crea ninguna reserva: siguen siendo dos pasos aparte, cada uno con una persona delante.",
  substitutionEffectsAfter:
    "La propuesta queda aprobada con esa persona. Todavía no se ha avisado a nadie y no se ha creado ninguna reserva.",
  /** (Reparación R2-UX, defecto 4) Lo que queda tras aprobar, dicho al aprobar. */
  approvalEffectsAfter:
    "Quedan tres pasos, cada uno con una persona delante: simular el aviso, anotar lo que conteste y confirmar la reserva. Todavía no se ha avisado a nadie.",
  /** (Reparación R2-UX, defecto 5) Quién tiene el hueco AHORA MISMO, rotulado. */
  currentRecipientHeading: "Destinatario actual de este hueco",
  /** (Reparación R2-UX, defecto 5) Y qué son las de abajo: alternativas, no el estado actual. */
  alternativesAreNotCurrent:
    "Estas personas NO tienen el hueco. Son alternativas: elige una y confirma para sustituir al destinatario actual.",
} as const;

/**
 * (Reparación R2-UX, defecto 4) LO QUE FALTA, PELDAÑO A PELDAÑO.
 *
 * La auditoría manual de step 23 encontró la píldora «Aprobada — elegida por
 * el operador» con una frase debajo diciendo que nadie recibiría el hueco
 * «hasta que una persona lo apruebe». Las dos cosas no podían ser verdad a la
 * vez: la aprobación YA había ocurrido. La causa era que la tarjeta pintaba
 * SIEMPRE la misma frase constante (`proposalIsSuggestion`), que sólo es
 * cierta en el PRIMER peldaño — y ahí sigue, literal y sin retocar una coma,
 * porque ahí sí es verdad.
 *
 * Esta tabla es la misma escalera de §4 leída como «qué queda por hacer», con
 * una entrada por código y ninguna más. Ninguna vuelve a pedir una aprobación
 * que ya ocurrió, y ninguna afloja lo que seguimos prometiendo: el aviso, la
 * respuesta y la reserva son TRES actos separados, cada uno con una persona
 * delante.
 */
const PROPOSAL_STAGE_NOTES: Readonly<Record<ProposalStatusCode, string>> = {
  pending_approval: WAITLIST_COPY.proposalIsSuggestion,
  approved: `Aprobada. ${WAITLIST_COPY.approvalEffectsAfter}`,
  substituted: `Aprobada por decisión del operador. ${WAITLIST_COPY.approvalEffectsAfter}`,
  notice_simulated:
    "Aviso simulado: no se ha enviado ningún mensaje ni se ha llamado a nadie. Ahora toca esperar la respuesta y anotarla tú. No hay plazo de aceptación y nada caduca solo.",
  accepted:
    "Ha aceptado, y esa respuesta la ha anotado una persona. Todavía no existe ninguna reserva: la crea una persona al confirmarla.",
  converted: "Reserva sintética creada. El ciclo de este hueco está cerrado.",
  declined: "Ha dicho que no. Este hueco se queda sin destinatario hasta que alguien decida otra cosa.",
  invalidated: "Esta propuesta ya no vale, así que no queda ningún paso que dar sobre ella.",
};

/** The six labelled values of the operator's `<select>` (design §3.3). Business values, so they live in the server. */
export const POLICY_OPTIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "Sin plazo: toda cancelación cuenta como dentro de plazo." },
  { minutes: 30, label: "30 minutos" },
  { minutes: 60, label: "60 minutos" },
  { minutes: 120, label: "120 minutos (valor por defecto de la demostración)" },
  { minutes: 240, label: "240 minutos" },
  { minutes: 1440, label: "1440 minutos (un día)" },
];

// ---------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------

export interface ConsoleWaitlistPolicyView {
  cancellationNoticeMinutes: number;
  label: string;
  sentence: string;
  isDemoValue: true;
  demoNotice: string;
  source: "demo_default" | "operator_set";
  options: readonly { minutes: number; label: string }[];
}

export interface ConsoleWaitlistReasonView {
  code: WaitlistMismatchReason;
  label: string;
}

export interface ConsoleWaitlistOfferView {
  slotKey: string;
  slotLabel: string;
  /** RE-DERIVED on every snapshot, never stored. */
  stillValid: boolean;
  invalidReasons: readonly ConsoleWaitlistReasonView[];
}

/** DERIVED from the audit log and the live offer — never a second stored copy. */
export interface ConsoleWaitlistTraceView {
  cancellationId: string | null;
  releasedSlotKey: string | null;
  noticeId: string | null;
  createdReservationId: string | null;
}

export interface ConsoleWaitlistEntryView {
  id: string;
  clientLabel: string;
  state: WaitlistEntryState;
  stateLabel: string;
  stateTone: string;
  serviceLabel: string;
  /**
   * (Reparación R2-UX, defecto 2) Los tres hechos que `preferenceSummary`
   * fundía, ahora también por separado: la pantalla puede enseñarlos en
   * líneas distintas sin volver a trocear una frase ya compuesta.
   */
  serviceDurationLabel: string;
  availabilityWindowLabel: string;
  preferenceSummary: string;
  professionalLabel: string;
  optInLabel: string;
  createdAtISO: string;
  /** Position by CREATION order. Never a priority (design §5.1). */
  readingOrder: number;
  offer: ConsoleWaitlistOfferView | null;
  trace: ConsoleWaitlistTraceView;
  /** What the operator may do. The interface never decides this for itself. */
  availableCommands: readonly string[];
  technical: { stateEnum: WaitlistEntryState; serviceId: ServiceId; professional: { kind: string; employeeId?: EmployeeId } };
}

export interface ConsoleWaitlistIncompatibleView {
  entryId: string;
  clientLabel: string;
  reasons: readonly ConsoleWaitlistReasonView[];
}

/**
 * step 23 §7 — LA PROPUESTA, ya resuelta, dentro de su hueco.
 *
 * Todo llega en castellano y decidido: la escalera de §4, la razón humana, el
 * origen y —lo más importante— `canApprove` y `canSimulateNotice`. Que el
 * navegador dedujese cuándo se puede aprobar o avisar sería re-derivar
 * significado de negocio en el cliente, que es el defecto heredado que esta
 * consola existe para no repetir (§14.1 de step 17). El servidor manda R2.
 */
export interface ConsoleWaitlistProposalReasonView {
  code: ProposalInvalidReasonCode;
  label: string;
}

export interface ConsoleWaitlistProposalView {
  entryId: string;
  clientLabel: string;
  /** La escalera de §4, re-derivada en cada instantánea. Nunca almacenada. */
  statusCode: ProposalStatusCode;
  statusLabel: string;
  statusTone: string;
  /** "Sistema" | "Operador". */
  originLabel: string;
  /** La razón humana, literal y cerrada. Nunca un identificador. */
  reasonLabel: string;
  /**
   * (Reparación R2-UX, defecto 4) QUÉ FALTA desde este peldaño, en una frase
   * y por `statusCode`. Sustituye a la frase constante que la tarjeta pintaba
   * pasara lo que pasara y que, tras aprobar, volvía a pedir una aprobación
   * que ya había ocurrido.
   */
  stageNote: string;
  /**
   * (Reparación R2-UX, defectos 3 y 7) La confirmación PERSISTENTE de una
   * sustitución, ya redactada y con las dos personas nombradas. `null` cuando
   * nadie fue desplazado, que es el caso normal. Es DERIVADA, así que el
   * sondeo la vuelve a pintar idéntica y no anuncia nada: el anuncio de una
   * sola vez vive en la línea de estado, no aquí.
   */
  substitutionNote: string | null;
  proposedAtISO: string;
  decidedAtISO: string | null;
  /** A quién desplazó el operador, cuando desplazó a alguien. */
  substitutedFromClientLabel: string | null;
  /**
   * Códigos PROPIOS de la propuesta: los siete de B1..B7 más los dos que no
   * son incompatibilidad (§4). Por eso no reutiliza `ConsoleWaitlistReasonView`
   * —cuyo `code` es un `WaitlistMismatchReason`—: forzar el tipo sería mentir
   * sobre lo que de verdad puede llegar aquí.
   */
  invalidReasons: readonly ConsoleWaitlistProposalReasonView[];
  canApprove: boolean;
  canSimulateNotice: boolean;
}

export interface ConsoleWaitlistReleasedSlotView {
  key: string;
  label: string;
  cancellationId: string;
  stillFree: boolean;
  /** CREATION order. See `readingOrderNote`. */
  compatibleEntryIds: readonly string[];
  readingOrderNote: string;
  incompatible: readonly ConsoleWaitlistIncompatibleView[];
  decisionPending: boolean;
  /**
   * step 19 D3. The whole sentence, ready to paint. Composed HERE from
   * `compatibleEntryIds.length` (0 / 1 / N≥2) and nowhere else: the browser
   * does not compose it and does not pluralise it (that was the one
   * exception to this module's own hard rule — §2.3 of the step 19 design).
   */
  announcementLine: string;
  /** step 23 §7. Cero o una, nunca dos. `null` = nadie propuesto. */
  proposal: ConsoleWaitlistProposalView | null;
  /**
   * Quiénes puede el operador poner EN LUGAR de la propuesta, en orden de
   * alta. Es exactamente lo que `take_over_proposal` aceptaría (§3.1): quien
   * no esté aquí recibiría un 409, así que la pantalla no lo ofrece.
   */
  substitutableEntryIds: readonly string[];
  /** Las filas de `activity.items` que cuentan la historia de ESTE hueco. */
  activityItemIds: readonly string[];
}

export interface ConsoleWaitlistCancellationView {
  id: string;
  reservationId: string;
  when: string;
  leadMinutes: number;
  policyMinutesAtCancellation: number;
  timeliness: "on_time" | "late";
  timelinessLabel: string;
  reviewState: "pending_review" | "reviewed_no_action" | null;
  reasonLabel: string;
  releasedSlotKeys: readonly string[];
}

export interface ConsoleWaitlistAuditItemView {
  id: string;
  seq: number;
  kind: string;
  /** Generated HERE, from the closed catalogue of §7.1. The interface never composes its own sentence. */
  text: string;
  actor: string;
  atISO: string;
  entryId: string | null;
  reservationId: string | null;
  cancellationId: string | null;
  slotKey: string | null;
  noticeId: string | null;
  newReservationId: string | null;
  /**
   * The state transition the event records, when it records one. Present so
   * that replaying the log reproduces every entry's state exactly (design
   * criterion 4) — without it the log would tell the story in Spanish but
   * could not be checked against reality by machine. Technical vocabulary,
   * so the interface shows it only inside the technical `<details>`.
   */
  fromState: WaitlistEntryState | null;
  toState: WaitlistEntryState | null;
}

/** Every figure is DERIVED (design §11). There is not one incremental counter: a counter kept by hand is a counter that can lie. */
export interface ConsoleWaitlistMetricsView {
  waitlistOptInsRecorded: number;
  waitlistOptInsDeclined: number;
  /**
   * step 19 §6.2/§5.2.2 (B3) — DERIVADO de `waitlist.cancellations`, nunca un
   * contador aparte. `lateCancellationsUnderReview` ya cuenta las tardías
   * pendientes; ésta es su hermana a tiempo, para el resumen de Bruno.
   */
  cancellationsOnTime: number;
  slotsReleasedTotal: number;
  slotsReleasedWithCompatibles: number;
  /**
   * step 19 §6.2/§5.2.2 (B7) — `slotsReleasedTotal - slotsReleasedWithCompatibles`,
   * calculado aquí y sólo aquí. Ningún contador aparte que pueda divergir.
   */
  slotsReleasedWithoutCompatibles: number;
  noticesSimulated: number;
  conversions: number;
  lateCancellationsUnderReview: number;
  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo m1.)* `lateCancellationsUnderReview` es un AFORO — sube con
   * cada cancelación tardía y baja en cuanto un operador la revisa — así que
   * NO sirve para saber si «una cancelación tardía ha ocurrido alguna vez»:
   * revisarla la haría desaparecer de esa cuenta. Ésta es su hermana
   * MONÓTONA: `timeliness` no cambia nunca una vez fijado en la cancelación
   * (`commands.ts` sólo actualiza `reviewState`), y `waitlist.cancellations`
   * es un registro que sólo crece — así que este número nunca baja. Existe
   * únicamente para que un paso de guion pueda comprobar «ha pasado» sin
   * poder desmarcarse por la propia acción que enseña a continuación
   * (revisarla).
   */
  lateCancellationsTotal: number;
  actionsRequiringAPerson: number;
  conversionConflictsPrevented: number;
  idempotentReplays: number;
  injectedFailuresHandled: number;
  /**
   * Minutes of AGENDA, never minutes of clock — no time passes on its own in
   * this demo (design §11; step 18 §3 made the clock movable BY HAND, which
   * changes nothing about this figure).
   */
  unfilledReleasedSlotMinutes: number;
  /**
   * step 18 §0.5, AMENDMENT E9. This key used to be `frozenClockNotice`.
   * With a clock that moves, that name lied — and a misleading name is the
   * exact kind of thing this project exists to remove, so it was renamed
   * rather than documented as "historical". The cost was measured before
   * doing it: the key is not read by the interface, so the rename touched two
   * lines here and one assertion in a test.
   */
  syntheticClockNotice: string;
}

/**
 * step 23 §7/§8.2 — UNA FILA DEL RASTRO OPERATIVO.
 *
 * `title` es la línea corta que se lee de un vistazo; `reason` es la frase
 * entera del catálogo de auditoría, para la divulgación progresiva. Las dos
 * se componen aquí: el navegador no escribe ni pluraliza ni una palabra.
 *
 * `id` y `seq` son la clave estable y el orden canónico. El orden es `seq`
 * DESCENDENTE y nunca `atISO`: dos actos en el mismo minuto sintético, o un
 * avance del reloj, no pueden reordenar el rastro.
 */
export interface ConsoleWaitlistActivityItemView {
  /** `"wla-00000123"` — clave estable para reconciliar sin reconstruir. */
  id: string;
  seq: number;
  /** "Sistema" | "Operador". */
  originLabel: string;
  title: string;
  reason: string;
  /** "HH:mm" del RELOJ SINTÉTICO, el mismo instante que el evento registró. */
  timeLabel: string;
  statusLabel: string;
  statusTone: string;
  slotKey: string | null;
  cancellationId: string | null;
  entryId: string | null;
  /** Siempre `#/lista-espera`: no hay octava ruta de navegación. */
  href: string;
}

export interface ConsoleWaitlistActivityView {
  /** Recuento TRAS el filtro, para que «6 de 14» no mienta. */
  total: number;
  shown: number;
  items: readonly ConsoleWaitlistActivityItemView[];
}

/** step 23 §7/§8.1 — una tarjeta por hueco con propuesta PENDIENTE. */
export interface ConsoleWaitlistAttentionCardView {
  slotKey: string;
  cancellationId: string;
  headline: string;
  detail: string;
  statusLabel: string;
  statusTone: string;
  href: string;
}

export interface ConsoleWaitlistAttentionView {
  /**
   * SUMANDO DISJUNTO (§8.1, hallazgo 5). La cabecera de Inicio suma esto con
   * `metrics.needsAttention`, que cuenta LLAMADAS: una llamada nunca es una
   * propuesta, así que no hay doble conteo posible. Y `pendingHumanTasks` no
   * se toca: la tarea `DECIDE_WAITLIST_MATCH` es EL RECADO; la propuesta es la
   * sugerencia PARA ese recado, no un recado más.
   */
  pendingProposalCount: number;
  cards: readonly ConsoleWaitlistAttentionCardView[];
}

export interface ConsoleWaitlistIntegrityView {
  falseSuccesses: number;
  doubleBookedSlotKeys: readonly string[];
  ok: boolean;
}

export interface ConsoleWaitlistView {
  policy: ConsoleWaitlistPolicyView;
  entries: readonly ConsoleWaitlistEntryView[];
  releasedSlots: readonly ConsoleWaitlistReleasedSlotView[];
  cancellations: readonly ConsoleWaitlistCancellationView[];
  audit: { total: number; shown: number; items: readonly ConsoleWaitlistAuditItemView[] };
  metrics: ConsoleWaitlistMetricsView;
  integrity: ConsoleWaitlistIntegrityView;
  /** step 23 §7 — las DOS únicas claves nuevas de primer nivel del bloque. */
  attention: ConsoleWaitlistAttentionView;
  activity: ConsoleWaitlistActivityView;
  copy: typeof WAITLIST_COPY;
}

/** The audit list is trimmed to the 200 most recent so a long session cannot bloat a 2-second poll (design §14.7). */
export const AUDIT_ITEMS_SHOWN = 200;

/**
 * step 23 §7. El rastro operativo es MUCHO más corto que el técnico porque
 * es para leerlo, no para auditarlo: sesenta filas caben en el `<details>` de
 * Inicio sin convertir un sondeo de 2 s en una descarga.
 */
export const ACTIVITY_ITEMS_SHOWN = 60;

/** The three task reasons this feature adds to the human queue (design §7.3). */
export const WAITLIST_TASK_REASONS = [
  "REVIEW_LATE_CANCELLATION",
  "DECIDE_WAITLIST_MATCH",
  "REVIEW_WAITLIST_CONVERSION_CONFLICT",
] as const;

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

function slotLabelOf(cal: CalendarWithCapabilities, date: string, startMinutes: number, employeeId: EmployeeId): string {
  const end = startMinutes + cal.slotMinutes;
  return `${dayLabel(date)}, ${formatHHmm(startMinutes)}–${formatHHmm(end)}, con ${professionalLabelOf(cal, employeeId)}`;
}

/** The label of a slot known only by its key (an audit event carries no more than that). */
function slotLabelFromKey(cal: CalendarWithCapabilities, slotKey: string | undefined): string {
  if (slotKey === undefined) return "un hueco";
  const parsed = parseSlotKey(slotKey);
  if (parsed === null) return "un hueco";
  return slotLabelOf(cal, parsed.date, parsed.startMinutes, parsed.employeeId);
}

function slotTimeFromKey(slotKey: string | undefined): string {
  if (slotKey === undefined) return "";
  const parsed = parseSlotKey(slotKey);
  return parsed === null ? "" : formatHHmm(parsed.startMinutes);
}

function slotProfessionalFromKey(cal: CalendarWithCapabilities, slotKey: string | undefined): string {
  if (slotKey === undefined) return "el equipo";
  const parsed = parseSlotKey(slotKey);
  return parsed === null ? "el equipo" : professionalLabelOf(cal, parsed.employeeId);
}

/**
 * (Reparación R2-UX, defecto 2) TRES HECHOS DISTINTOS, TRES CAMPOS DISTINTOS.
 *
 * La frase que la auditoría manual encontró en pantalla era:
 *
 *   «Corte de pelo · el martes 4 de agosto · de 13:00 a 14:00 · con quien sea»
 *
 * y se lee como una cita de una hora. No lo es: «Corte de pelo» dura
 * `cal.slotMinutes` —media hora—, y 13:00–14:00 es la VENTANA que la persona
 * acepta, dentro de la cual caben dos medias horas independientes. La regla
 * de compatibilidad siempre dijo eso mismo (`matching.ts` exige que el hueco
 * ENTERO quepa dentro de la ventana: `start + slotMinutes <= latest`); lo que
 * fallaba era la redacción, que fundía duración y ventana en un solo string y
 * dejaba al operador deducir cuál era cuál.
 *
 * La duración NO se inventa aquí: sale del calendario, que es quien la sabe.
 * Y la ventana se dice con el verbo que la describe —«Disponible entre…»—, no
 * con la preposición de un intervalo de cita.
 */
interface PreferenceParts {
  serviceLabel: string;
  /** La duración REAL del servicio, tal y como la fija el calendario. */
  serviceDurationLabel: string;
  serviceWithDurationLabel: string;
  dayLabel: string;
  /** La ventana ACEPTADA por la persona. Nunca la duración de nada. */
  availabilityWindowLabel: string;
  professionalLabel: string;
  summary: string;
}

function preferenceParts(cal: CalendarWithCapabilities, entry: WaitlistEntry): PreferenceParts {
  const serviceLabel = SERVICE_LABELS[entry.serviceId];
  const serviceDurationLabel = `${String(cal.slotMinutes)} min`;
  const serviceWithDurationLabel = `${serviceLabel} (${serviceDurationLabel})`;
  const day =
    entry.dateFrom === entry.dateTo
      ? `el ${dayLabel(entry.dateFrom)}`
      : `del ${dayLabel(entry.dateFrom)} al ${dayLabel(entry.dateTo)}`;
  const availabilityWindowLabel = `Disponible entre las ${formatHHmm(entry.earliestStartMinutes)} y las ${formatHHmm(entry.latestStartMinutes)}`;
  const professional =
    entry.professional.kind === "any" ? ANY_PROFESSIONAL_LABEL : professionalLabelOf(cal, entry.professional.employeeId);
  return {
    serviceLabel,
    serviceDurationLabel,
    serviceWithDurationLabel,
    dayLabel: day,
    availabilityWindowLabel,
    professionalLabel: professional,
    summary: `${serviceWithDurationLabel} · ${day} · ${availabilityWindowLabel} · ${professional}`,
  };
}

function timelinessLabelOf(c: CancellationRecord): string {
  if (c.timeliness === "on_time") return "Cancelación dentro del plazo configurado";
  if (c.latenessKind === "already_started") return "Cancelación fuera del plazo configurado (la cita ya había empezado)";
  return "Cancelación fuera del plazo configurado";
}

function detailNumber(ev: WaitlistAuditEvent, key: string): number | undefined {
  const v = ev.detail?.[key];
  return typeof v === "number" ? v : undefined;
}

function detailString(ev: WaitlistAuditEvent, key: string): string | undefined {
  const v = ev.detail?.[key];
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------
// The audit text catalogue (design §7.1)
// ---------------------------------------------------------------------

export interface TextContext {
  cal: CalendarWithCapabilities;
  entries: readonly WaitlistEntry[];
  cancellations: readonly CancellationRecord[];
}

function clientLabelOf(ctx: TextContext, entryId: string | undefined): string {
  if (entryId === undefined) return "Una persona de la lista";
  return ctx.entries.find((e) => e.id === entryId)?.clientLabel ?? "Una persona de la lista";
}

/**
 * ONE closed map by `kind`. Every sentence an operator reads about the
 * waitlist is written here and nowhere else — the browser never builds one.
 */
export function auditText(ev: WaitlistAuditEvent, ctx: TextContext): string {
  const cancellation = ev.cancellationId !== undefined ? ctx.cancellations.find((c) => c.id === ev.cancellationId) : undefined;
  const slotTime = slotTimeFromKey(ev.slotKey);
  const slotWho = slotProfessionalFromKey(ctx.cal, ev.slotKey);

  switch (ev.kind) {
    case "WAITLIST_ENTRY_CREATED": {
      const entry = ctx.entries.find((e) => e.id === ev.entryId);
      const service = entry !== undefined ? SERVICE_LABELS[entry.serviceId] : "un servicio";
      return `${clientLabelOf(ctx, ev.entryId)} se ha apuntado a la lista de espera para ${service}.`;
    }
    case "WAITLIST_OPT_IN_DECLINED": {
      const label = detailString(ev, "clientLabel") ?? "Una persona";
      return `${label} no ha querido apuntarse a la lista de espera. No se ha guardado ninguna entrada.`;
    }
    case "RESERVATION_CANCELLED_ON_TIME": {
      const hora = cancellation !== undefined ? formatHHmm(cancellation.startMinutes) : "";
      const quien = cancellation !== undefined ? professionalLabelOf(ctx.cal, cancellation.employeeId) : "el equipo";
      const plazo = detailNumber(ev, "policyMinutes") ?? 0;
      return `Se ha cancelado la cita de las ${hora} con ${quien}. Dentro del plazo configurado (${String(plazo)} min).`;
    }
    case "RESERVATION_CANCELLED_LATE": {
      const hora = cancellation !== undefined ? formatHHmm(cancellation.startMinutes) : "";
      const quien = cancellation !== undefined ? professionalLabelOf(ctx.cal, cancellation.employeeId) : "el equipo";
      const plazo = detailNumber(ev, "policyMinutes") ?? 0;
      return `Se ha cancelado la cita de las ${hora} con ${quien}. Fuera del plazo configurado (${String(plazo)} min). No se ha aplicado ninguna penalización.`;
    }
    case "LATE_CANCELLATION_REVIEWED": {
      const hora = cancellation !== undefined ? formatHHmm(cancellation.startMinutes) : "";
      return `Un operador ha revisado la cancelación fuera de plazo de las ${hora}. Sin acción.`;
    }
    case "SLOT_RELEASED":
      return `Se ha liberado el hueco de las ${slotTime} con ${slotWho}.`;
    case "SLOT_RELEASE_PRODUCED_NO_SLOTS":
      return WAITLIST_COPY.venueClosedThatDay;
    case "WAITLIST_MATCH_EVALUATED": {
      const evaluated = detailNumber(ev, "evaluated") ?? 0;
      const compatible = detailNumber(ev, "compatible") ?? 0;
      // step 19 D3b. Singular for exactly 1 in each half of the sentence;
      // the plural halves stay byte-for-byte as they were.
      const evaluatedPhrase =
        evaluated === 1 ? "Se ha comprobado 1 entrada" : `Se han comprobado ${String(evaluated)} entradas`;
      const compatiblePhrase = compatible === 1 ? "1 encaja" : `${String(compatible)} encajan`;
      return `${evaluatedPhrase} contra el hueco de las ${slotTime}: ${compatiblePhrase}.`;
    }
    case "WAITLIST_ENTRY_MATCHED":
      // Deliberately passive: the slot FITS somebody. It does not say the
      // system chose, offered or notified anybody — none of those happened
      // (design §5, non-rules J1/J3).
      return `El hueco de las ${slotTime} encaja con ${clientLabelOf(ctx, ev.entryId)}.`;
    case "WAITLIST_NOTICE_SIMULATED":
      return `Aviso simulado a ${clientLabelOf(ctx, ev.entryId)} por el hueco de las ${slotTime}. No se ha enviado ningún mensaje.`;
    case "WAITLIST_OFFER_ACCEPTED":
      return `${clientLabelOf(ctx, ev.entryId)} ha aceptado el hueco de las ${slotTime} (respuesta registrada por el operador).`;
    case "WAITLIST_OFFER_DECLINED":
      return `${clientLabelOf(ctx, ev.entryId)} ha rechazado el hueco de las ${slotTime}.`;
    case "WAITLIST_OFFER_RELEASED":
      return `Se ha retirado la oferta del hueco de las ${slotTime} a ${clientLabelOf(ctx, ev.entryId)}.`;
    case "WAITLIST_ENTRY_CONVERTED":
      return `Se ha creado una reserva sintética para ${clientLabelOf(ctx, ev.entryId)}: ${slotLabelFromKey(ctx.cal, ev.slotKey)}.`;
    case "WAITLIST_CONVERSION_CONFLICT":
      return `No se ha creado la reserva: el hueco de las ${slotTime} ya estaba ocupado. Nada se ha escrito.`;
    case "WAITLIST_CONVERSION_FAILED_INJECTED":
      return "Fallo sintético inyectado al convertir. No se ha escrito nada.";
    case "WAITLIST_ENTRY_WITHDRAWN":
      return `Se ha retirado la entrada de ${clientLabelOf(ctx, ev.entryId)}.`;
    case "WAITLIST_ENTRY_EXPIRED_MANUALLY":
      return `Se ha marcado como caducada la entrada de ${clientLabelOf(ctx, ev.entryId)}.`;
    case "WAITLIST_ENTRY_REOPENED":
      return `Se ha vuelto a activar la entrada de ${clientLabelOf(ctx, ev.entryId)}.`;
    case "CANCELLATION_POLICY_CHANGED": {
      const from = detailNumber(ev, "from") ?? 0;
      const to = detailNumber(ev, "to") ?? 0;
      return `El plazo de cancelación pasa de ${String(from)} a ${String(to)} minutos (valor de demostración).`;
    }
    case "IDEMPOTENT_REPLAY":
      return "Petición repetida con la misma clave: se ha devuelto el resultado anterior. No se ha hecho nada nuevo.";
    case "DEMO_RESET":
      return "Se ha reiniciado la demostración. Vuelven las entradas de ejemplo y el plazo de 120 minutos.";

    // -----------------------------------------------------------------
    // step 23 §6 — the five proposal sentences. Composed HERE, in the
    // server, like every other sentence of this catalogue. None of them
    // names a raw identifier (`wl-f02`, `slot-…`, `cxl-…`) as the
    // explanation: those live only in the technical `<details>`.
    // -----------------------------------------------------------------

    case "WAITLIST_PROPOSAL_CREATED":
      return `Propuesta automática para el hueco de las ${slotTime} con ${slotWho}: ${clientLabelOf(ctx, ev.entryId)}. ${WAITLIST_COPY.proposalReasonFifo} Pendiente de aprobación.`;
    case "WAITLIST_PROPOSAL_APPROVED":
      return `Un operador ha aprobado la propuesta del hueco de las ${slotTime}: ${clientLabelOf(ctx, ev.entryId)}. Todavía no se ha avisado a nadie.`;
    case "WAITLIST_PROPOSAL_SUBSTITUTED": {
      const desplazada = clientLabelOf(ctx, detailString(ev, "replacedEntryId"));
      return `Un operador ha propuesto a ${clientLabelOf(ctx, ev.entryId)} en lugar de ${desplazada} para el hueco de las ${slotTime}. Decisión del operador. ${desplazada} sigue en la lista.`;
    }
    case "WAITLIST_PROPOSAL_INVALIDATED": {
      const razones = (detailString(ev, "reasons") ?? "")
        .split(",")
        .filter((code) => code !== "")
        .map((code) => proposalInvalidLabel(code, slotWho))
        .join("; ");
      const explicacion = razones === "" ? "la situación ha cambiado" : razones;
      return `La propuesta del hueco de las ${slotTime} para ${clientLabelOf(ctx, ev.entryId)} ya no vale: ${explicacion}.`;
    }
    case "WAITLIST_PROPOSAL_NONE_AVAILABLE":
      return `Nadie de la lista encaja ahora mismo con el hueco de las ${slotTime}. No hay propuesta.`;
  }
}

/**
 * step 23 §8.2 — THE SHORT LINE of a trail row.
 *
 * Progressive disclosure needs TWO texts, not one: `title` is what is read at
 * a glance, and `reason` — the full `auditText` sentence — is what explains
 * it underneath. Both are composed HERE. Deriving the short one from the long
 * one in the browser (truncating, splitting on a full stop) would put the
 * composition of business copy back in the client, which is exactly the
 * inherited defect this console exists to remove.
 *
 * Only the fifteen `kind` of `ACTIVITY_KINDS` ever reach this function. The
 * default arm is not dead code being tolerated: it is what guarantees that a
 * `kind` added to the allow list without a title here still shows a TRUE
 * sentence instead of an empty row.
 */
export function activityTitle(ev: WaitlistAuditEvent, ctx: TextContext): string {
  const cancellation = ev.cancellationId !== undefined ? ctx.cancellations.find((c) => c.id === ev.cancellationId) : undefined;
  const cancelledAt = cancellation !== undefined ? formatHHmm(cancellation.startMinutes) : "";
  const cancelledWho = cancellation !== undefined ? professionalLabelOf(ctx.cal, cancellation.employeeId) : "el equipo";
  const slotTime = slotTimeFromKey(ev.slotKey);
  const slotWho = slotProfessionalFromKey(ctx.cal, ev.slotKey);
  const quien = clientLabelOf(ctx, ev.entryId);

  switch (ev.kind) {
    case "RESERVATION_CANCELLED_ON_TIME":
      return `Cancelación dentro de plazo: la cita de las ${cancelledAt} con ${cancelledWho}`;
    case "RESERVATION_CANCELLED_LATE":
      return `Cancelación fuera de plazo: la cita de las ${cancelledAt} con ${cancelledWho}`;
    case "LATE_CANCELLATION_REVIEWED":
      return `Un operador revisa la cancelación fuera de plazo de las ${cancelledAt}`;
    case "SLOT_RELEASED":
      return `Hueco liberado: las ${slotTime} con ${slotWho}`;
    case "SLOT_RELEASE_PRODUCED_NO_SLOTS":
      return "La cancelación no libera ningún hueco";
    case "WAITLIST_PROPOSAL_CREATED":
      return `Propuesta para el hueco de las ${slotTime}: ${quien}`;
    case "WAITLIST_PROPOSAL_APPROVED":
      return `Un operador aprueba la propuesta de las ${slotTime}: ${quien}`;
    case "WAITLIST_PROPOSAL_SUBSTITUTED":
      return `Un operador cambia la propuesta de las ${slotTime}: ${quien}`;
    case "WAITLIST_PROPOSAL_INVALIDATED":
      return `La propuesta del hueco de las ${slotTime} ya no vale`;
    case "WAITLIST_PROPOSAL_NONE_AVAILABLE":
      return `El hueco de las ${slotTime} se queda sin propuesta`;
    case "WAITLIST_NOTICE_SIMULATED":
      return `Aviso simulado a ${quien} por el hueco de las ${slotTime}`;
    case "WAITLIST_OFFER_ACCEPTED":
      return `${quien} acepta el hueco de las ${slotTime}`;
    case "WAITLIST_OFFER_DECLINED":
      return `${quien} rechaza el hueco de las ${slotTime}`;
    case "WAITLIST_ENTRY_CONVERTED":
      return `Reserva sintética creada para ${quien}: las ${slotTime}`;
    case "WAITLIST_CONVERSION_CONFLICT":
      return `No se ha creado la reserva del hueco de las ${slotTime}`;
    default:
      return auditText(ev, ctx);
  }
}

// ---------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------

function policyView(policy: WaitlistStoreSnapshot["policy"]): ConsoleWaitlistPolicyView {
  const minutes = policy.cancellationNoticeMinutes;
  const sentence =
    minutes === 0
      ? "Sin plazo: toda cancelación cuenta como dentro de plazo."
      : `Dentro de plazo = avisar con ${String(minutes)} minutos o más de antelación.`;
  return {
    cancellationNoticeMinutes: minutes,
    label: `${String(minutes)} minutos`,
    sentence,
    isDemoValue: true,
    demoNotice: `${String(minutes)} minutos · ${WAITLIST_COPY.policyIsDemoValue}`,
    source: policy.source,
    options: POLICY_OPTIONS,
  };
}

/**
 * The `trace` of one entry, DERIVED. `releasedSlotKey`/`cancellationId` come
 * from the live offer when there is one and from the entry's own audit
 * events otherwise; `noticeId` and `createdReservationId` come only from the
 * log. Nothing is stored twice, so nothing can diverge (design §1.3).
 */
function traceOf(entry: WaitlistEntry, log: readonly WaitlistAuditEvent[], releasedSlots: readonly ReleasedSlot[]): ConsoleWaitlistTraceView {
  const own = log.filter((e) => e.entryId === entry.id);
  const lastWithSlot = [...own].reverse().find((e) => e.slotKey !== undefined);
  const lastNotice = [...own].reverse().find((e) => e.kind === "WAITLIST_NOTICE_SIMULATED");
  const lastConverted = [...own].reverse().find((e) => e.kind === "WAITLIST_ENTRY_CONVERTED");

  const releasedSlotKey = entry.currentOffer?.slotKey ?? lastWithSlot?.slotKey ?? null;
  const fromRegistry = releasedSlotKey === null ? undefined : releasedSlots.find((s) => s.key === releasedSlotKey)?.cancellationId;
  const cancellationId =
    entry.currentOffer?.cancellationId ??
    fromRegistry ??
    [...own].reverse().find((e) => e.cancellationId !== undefined)?.cancellationId ??
    null;

  return {
    cancellationId,
    releasedSlotKey,
    noticeId: lastNotice?.noticeId ?? null,
    createdReservationId: lastConverted?.newReservationId ?? null,
  };
}

/**
 * step 23 §4 — THE LADDER, read top to bottom, once, here.
 *
 * `status` is the ONLY thing stored; everything the operator reads is derived
 * on every single snapshot, exactly like `offer.stillValid` (§14.6 of
 * step 17). The order is not decoration: `converted`, `accepted` and
 * `notice_simulated` sit ABOVE `invalidated` because an entry that already
 * moved on is not a broken proposal — reversing those two would make a
 * finished conversion read as "ya no vale", which is the opposite of true.
 */
/**
 * Los tres actos que ESTABLECEN quién está propuesto en un hueco. Sirven de
 * barrera al leer hacia atrás: si el último de los tres no es una sustitución,
 * es que la propuesta que hay ahora no viene de sustituir a nadie, por muchas
 * sustituciones que hubiera antes en la vida de ese mismo hueco.
 *
 * `SLOT_RELEASED` entra por lo mismo: una media hora que se vuelve a liberar
 * estrena propuesta (§2 de `model.ts`, `releasedSlots` se reemplaza en su
 * sitio), así que ningún acto anterior a esa liberación puede describirla.
 */
const PROPOSAL_ESTABLISHING_KINDS: readonly WaitlistAuditKind[] = [
  "SLOT_RELEASED",
  "WAITLIST_PROPOSAL_CREATED",
  "WAITLIST_PROPOSAL_APPROVED",
  "WAITLIST_PROPOSAL_SUBSTITUTED",
] as const;

/**
 * (Reparación R-SUB) QUIÉN acaba de perder ESTA propuesta, leído del ÚLTIMO
 * acto autoritativo del hueco y de ningún sitio más.
 *
 * EL DEFECTO QUE CIERRA: la versión anterior comparaba `proposal.entryId` con
 * `proposal.automaticEntryId` —quién eligió la regla automática la PRIMERA
 * vez—. Eso acierta mientras nadie vuelva atrás y miente en cuanto alguien lo
 * hace: en A→B→A los dos identificadores vuelven a coincidir, así que la
 * tarjeta se quedaba `substituted` sin desplazado, y en A→B→C nombraba a A
 * —que ya no había perdido nada— en lugar de a B. La sustitución NO es una
 * comparación contra el origen: es el último acto del operador, y ese acto ya
 * está escrito, con su `replacedEntryId`, en el registro que la propia pantalla
 * publica. Se lee de ahí, así que no hay un segundo estado que pueda divergir.
 *
 * Devuelve `undefined` cuando la propuesta actual no nace de una sustitución:
 * porque nunca hubo ninguna, porque la última la desplazó otra persona (rastro
 * viejo de una propuesta ya reemplazada) o porque después llegó un acto que
 * estableció la propuesta de nuevo.
 */
function displacedEntryIdOf(
  auditLog: readonly WaitlistAuditEvent[],
  slotKey: string,
  currentEntryId: string,
): string | undefined {
  const último = auditLog
    .filter((ev) => ev.slotKey === slotKey && PROPOSAL_ESTABLISHING_KINDS.includes(ev.kind))
    .reduce<WaitlistAuditEvent | undefined>((mayor, ev) => (mayor === undefined || ev.seq > mayor.seq ? ev : mayor), undefined);
  if (último?.kind !== "WAITLIST_PROPOSAL_SUBSTITUTED") return undefined;
  // La sustitución tiene que describir a QUIEN ESTÁ PROPUESTO AHORA. Si no,
  // es el rastro de otra propuesta y contarlo sería narrar un acto ajeno.
  if (último.entryId !== currentEntryId) return undefined;
  const desplazado = detailString(último, "replacedEntryId");
  // Nadie se desplaza a sí mismo: el comando no lo emite y, si lo emitiera,
  // «X ha sustituido a X» sería una frase falsa en pantalla.
  return desplazado === currentEntryId ? undefined : desplazado;
}

function proposalViewOf(
  cal: CalendarWithCapabilities,
  clock: Clock,
  entries: readonly WaitlistEntry[],
  slot: ReleasedSlot,
  auditLog: readonly WaitlistAuditEvent[],
): ConsoleWaitlistProposalView | null {
  const proposal: SlotProposal | undefined = slot.proposal;
  if (proposal === undefined) return null;
  const entry = entries.find((e) => e.id === proposal.entryId);
  const who = professionalLabelOf(cal, slot.employeeId);
  const standing = proposalStanding(cal, clock, entries, slot);

  let statusCode: ProposalStatusCode;
  if (entry?.state === "converted") statusCode = "converted";
  else if (entry?.state === "accepted") statusCode = "accepted";
  else if (entry?.state === "notice_simulated") statusCode = "notice_simulated";
  // `declined` es DEFENSIVO hoy y se deja a propósito. Con los disparadores
  // de §3.2 tal y como están, `record_decline` sobre el sujeto de una
  // propuesta hace saltar T3 en ese mismo tic y la propuesta se retira, así
  // que este peldaño no se alcanza por ninguna ruta HTTP. Está aquí porque la
  // ESCALERA es un contrato de precedencia: si mañana T3 dejara de retirarla,
  // la tarjeta diría «Rechazada» —que es la verdad— en vez de «Ya no vale»,
  // que sería una explicación falsa. Se prueba llamando a la proyección
  // directamente, que es la única forma honesta de probar una defensa.
  else if (entry?.state === "declined") statusCode = "declined";
  else if (!standing.stands) statusCode = "invalidated";
  else if (proposal.status === "approved" && proposal.origin === "operator_substitution") statusCode = "substituted";
  else if (proposal.status === "approved") statusCode = "approved";
  else statusCode = "pending_approval";

  // (Reparación R-SUB) El último acto manda. `automaticEntryId` sigue siendo un
  // hecho del dominio —a quién eligió la regla automática— y NO se vuelve a
  // usar para esto: no es lo mismo «quien propuso el sistema» que «quien acaba
  // de perder la propuesta», y confundirlos es exactamente lo que hacía que
  // A→B→A terminara diciendo «sustituida» sin nadie sustituido.
  const displacedId =
    proposal.origin === "operator_substitution"
      ? displacedEntryIdOf(auditLog, slot.key, proposal.entryId)
      : undefined;
  const displaced = displacedId === undefined ? null : entries.find((e) => e.id === displacedId)?.clientLabel ?? null;
  const recipient = entry?.clientLabel ?? "Una persona de la lista";

  // R2 AND THE APPROVAL BUTTON, RESOLVED HERE AND NOWHERE ELSE (§7). The
  // browser must never work out for itself when a proposal can be approved or
  // a notice simulated: the state machine is the server's, and a screen that
  // guessed would offer buttons that can only return 409. Both flags are
  // cross-checked against the closed command table, so a state that stops
  // offering the command stops offering the button in the same breath.
  const commands: readonly string[] = entry === undefined ? [] : AVAILABLE_COMMANDS_BY_STATE[entry.state];
  const canApprove = statusCode === "pending_approval" && commands.includes("approve_proposal");
  const canSimulateNotice =
    (statusCode === "approved" || statusCode === "substituted") && commands.includes("simulate_notice");

  return {
    entryId: proposal.entryId,
    clientLabel: recipient,
    statusCode,
    statusLabel: PROPOSAL_STATUS[statusCode].label,
    statusTone: PROPOSAL_STATUS[statusCode].tone,
    originLabel: proposal.origin === "operator_substitution" ? "Operador" : "Sistema",
    reasonLabel:
      proposal.origin === "operator_substitution"
        ? WAITLIST_COPY.proposalOperatorChoice
        : WAITLIST_COPY.proposalReasonFifo,
    stageNote: PROPOSAL_STAGE_NOTES[statusCode],
    substitutionNote: displaced === null ? null : `${recipient} ha sustituido a ${displaced} para esta propuesta.`,
    proposedAtISO: proposal.proposedAtISO,
    decidedAtISO: proposal.decidedAtISO ?? null,
    substitutedFromClientLabel: displaced,
    // Sólo cuando de verdad está invalidada: enseñar razones junto a una
    // propuesta que sigue en pie sería contradecirse en la misma tarjeta.
    invalidReasons:
      statusCode === "invalidated"
        ? standing.reasons.map((code) => ({ code, label: proposalInvalidLabel(code, who) }))
        : [],
    canApprove,
    canSimulateNotice,
  };
}

/** Projects ONE entry. Exported because the command endpoints answer with exactly this shape (design §6.1). */
export function projectWaitlistEntry(
  cal: CalendarWithCapabilities,
  clock: Clock,
  waitlist: WaitlistStoreSnapshot,
  entry: WaitlistEntry,
): ConsoleWaitlistEntryView {
  const ordered = [...waitlist.entries].sort((a, b) => a.createdSeq - b.createdSeq);
  const readingOrder = ordered.findIndex((e) => e.id === entry.id) + 1;

  let offer: ConsoleWaitlistOfferView | null = null;
  if (entry.currentOffer !== undefined) {
    const slot = waitlist.releasedSlots.find((s) => s.key === entry.currentOffer?.slotKey);
    if (slot !== undefined) {
      // RE-DERIVED here, every time. Never read from a stored flag.
      const reasons = matchEntryAgainstSlot(cal, clock, entry, slot);
      const who = professionalLabelOf(cal, slot.employeeId);
      offer = {
        slotKey: slot.key,
        slotLabel: slotLabelOf(cal, slot.date, slot.startMinutes, slot.employeeId),
        stillValid: reasons.length === 0,
        invalidReasons: reasons.map((code) => ({ code, label: mismatchLabel(code, who) })),
      };
    }
  }

  const partes = preferenceParts(cal, entry);

  return {
    id: entry.id,
    clientLabel: entry.clientLabel,
    state: entry.state,
    stateLabel: STATE_LABELS[entry.state],
    stateTone: STATE_TONES[entry.state],
    serviceLabel: SERVICE_LABELS[entry.serviceId],
    serviceDurationLabel: partes.serviceDurationLabel,
    availabilityWindowLabel: partes.availabilityWindowLabel,
    preferenceSummary: partes.summary,
    professionalLabel: partes.professionalLabel,
    optInLabel: OPT_IN_LABELS[entry.optInSource] ?? "Alta introducida por el operador",
    createdAtISO: entry.createdAtISO,
    readingOrder,
    offer,
    trace: traceOf(entry, waitlist.auditLog, waitlist.releasedSlots),
    availableCommands: AVAILABLE_COMMANDS_BY_STATE[entry.state],
    technical: {
      stateEnum: entry.state,
      serviceId: entry.serviceId,
      professional:
        entry.professional.kind === "any"
          ? { kind: "any" }
          : { kind: "specific", employeeId: entry.professional.employeeId },
    },
  };
}

/**
 * THE WHOLE `waitlist` KEY of the snapshot. Called on every poll; everything
 * derived, nothing cached.
 */
export function buildWaitlistSnapshot(
  cal: CalendarWithCapabilities,
  clock: Clock,
  waitlist: WaitlistStoreSnapshot,
  humanTasks: readonly HumanTask[],
): ConsoleWaitlistView {
  const orderedEntries = [...waitlist.entries].sort((a, b) => a.createdSeq - b.createdSeq);
  const entries = orderedEntries.map((entry) => projectWaitlistEntry(cal, clock, waitlist, entry));
  const trailContext: TextContext = { cal, entries: waitlist.entries, cancellations: waitlist.cancellations };

  // step 23 §7 — EL RASTRO OPERATIVO, antes que los huecos porque cada hueco
  // referencia por `id` las filas que cuentan SU historia.
  //
  // ORDEN: `seq` DESCENDENTE, nunca `atISO` ni reloj de pared. El `seq` lo
  // acuña el almacén en un único commit síncrono, así que es monótono y único
  // por construcción; dos actos en el mismo minuto sintético —o un avance del
  // reloj— no pueden reordenar nada. Recortar DESPUÉS de ordenar es lo que
  // hace que «las 60 más recientes» sea literalmente cierto.
  const activityAll = waitlist.auditLog
    .filter((ev) => (ACTIVITY_KINDS as readonly string[]).includes(ev.kind))
    .slice()
    .sort((a, b) => b.seq - a.seq);
  const activityItems = activityAll.slice(0, ACTIVITY_ITEMS_SHOWN).map((ev): ConsoleWaitlistActivityItemView => {
    const status = ACTIVITY_STATUS[ev.kind] ?? { label: "Registrado", tone: "none" };
    return {
      id: ev.id,
      seq: ev.seq,
      originLabel: originLabelOf(ev.actor),
      title: activityTitle(ev, trailContext),
      reason: auditText(ev, trailContext),
      // La hora del RELOJ SINTÉTICO que selló el evento, no la de pared: es el
      // momento en que el hecho ocurrió dentro de la demostración.
      timeLabel: timeLabelFromString(ev.atISO),
      statusLabel: status.label,
      statusTone: status.tone,
      slotKey: ev.slotKey ?? null,
      cancellationId: ev.cancellationId ?? null,
      entryId: ev.entryId ?? null,
      href: ACTIVITY_HREF,
    };
  });
  const activity: ConsoleWaitlistActivityView = {
    total: activityAll.length,
    shown: activityItems.length,
    items: activityItems,
  };

  const releasedSlots = waitlist.releasedSlots.map((slot): ConsoleWaitlistReleasedSlotView => {
    const stillFree = isSlotFree(cal, slot.employeeId, slot.date, slot.startMinutes);
    const evaluation = evaluateReleasedSlot(cal, clock, orderedEntries, slot);
    const who = professionalLabelOf(cal, slot.employeeId);
    // A decision is pending only while the slot is genuinely free, somebody
    // genuinely fits, and nobody has been notified or has accepted yet. El
    // predicado vive en `waitlist/matching.ts` desde la revisión adversarial de
    // step 23 (H1): el comando y la pantalla tienen que contestar lo mismo.
    const answering = entryAlreadyAnsweringSlot(orderedEntries, slot);
    const alreadyBeingDecided = answering !== undefined;
    // (Revisión adversarial de step 22, N1) …y alguien puede recibir la
    // decisión. La tarjeta de un hueco pendiente sirve para UNA cosa: elegir a
    // quién se le avisa. Ese aviso revalida la oferta viva de la persona
    // elegida, así que sin ninguna oferta viva sobre ESTE hueco, la tarjeta
    // sería un botón que sólo puede dar 409 — que es justo lo que le pasaba a
    // la segunda media hora liberada en cuanto alguien convertía la primera.
    // Que encajan, encaja gente: eso se sigue diciendo en
    // `compatibleEntryIds` y en la frase del anuncio, porque es verdad. Lo que
    // no se dice ya es que haya una decisión que la pantalla pueda recoger.
    const someoneCanBeOffered = orderedEntries.some(
      (e) => e.currentOffer?.slotKey === slot.key && matchEntryAgainstSlot(cal, clock, e, slot).length === 0,
    );
    const label = slotLabelOf(cal, slot.date, slot.startMinutes, slot.employeeId);
    const compatibleCount = evaluation.compatibleEntryIds.length;
    // step 19 D3(b). Composed here, in the server, and nowhere else — the
    // exact rule of §2.3.2: 0 compatible → noneFit; 1 → oneFits, singular;
    // ≥2 → severalFit, plural. Never names a candidate (§2.3.2(d)).
    const announcementLine =
      compatibleCount === 0
        ? `Hueco liberado: ${label}. ${WAITLIST_COPY.noneFit}`
        : compatibleCount === 1
          ? `Hueco liberado: ${label}. ${WAITLIST_COPY.oneFits} ${WAITLIST_COPY.decideInWaitlistScreen}`
          : `Hueco liberado: ${label}. ${WAITLIST_COPY.severalFit} ${WAITLIST_COPY.decideInWaitlistScreen}`;
    return {
      key: slot.key,
      label,
      cancellationId: slot.cancellationId,
      stillFree,
      compatibleEntryIds: evaluation.compatibleEntryIds,
      readingOrderNote: WAITLIST_COPY.readingOrderNote,
      incompatible: evaluation.incompatible.map((i) => ({
        entryId: i.entryId,
        clientLabel: orderedEntries.find((e) => e.id === i.entryId)?.clientLabel ?? i.entryId,
        reasons: i.reasons.map((code) => ({ code, label: mismatchLabel(code, who) })),
      })),
      decisionPending:
        stillFree && evaluation.compatibleEntryIds.length > 0 && !alreadyBeingDecided && someoneCanBeOffered,
      announcementLine,
      proposal: proposalViewOf(cal, clock, orderedEntries, slot, waitlist.auditLog),
      // Exactamente lo que `take_over_proposal` aceptaría (§3.1), menos quien
      // ya está propuesto —«elegir a OTRA»—. Publicar aquí a alguien a quien
      // el servidor rechazaría sería ofrecer un botón que sólo puede dar 409.
      // Y por eso, desde la revisión adversarial (H1), un hueco por el que ya
      // se ha avisado a alguien —o que alguien ya ha aceptado— no publica NI UN
      // sustituto: ese hueco ya no se reasigna, y decir lo contrario sería
      // invitar al operador a un 409 y, peor, insinuar que la persona avisada
      // se puede apartar sin más.
      substitutableEntryIds: alreadyBeingDecided
        ? []
        : proposalCandidatesFor(cal, clock, orderedEntries, waitlist.releasedSlots, slot)
            .filter((e) => e.id !== slot.proposal?.entryId)
            .map((e) => e.id),
      // La historia de ESTE hueco: sus propias filas y las de la cancelación
      // que lo liberó (que no llevan `slotKey` porque son de la cita entera).
      activityItemIds: activityItems
        .filter((i) => i.slotKey === slot.key || (i.slotKey === null && i.cancellationId === slot.cancellationId))
        .map((i) => i.id),
    };
  });

  const cancellations = waitlist.cancellations.map((c): ConsoleWaitlistCancellationView => ({
    id: c.id,
    reservationId: c.reservationId,
    when: `${dayLabel(c.date)}, ${formatHHmm(c.startMinutes)}`,
    leadMinutes: c.leadMinutes,
    policyMinutesAtCancellation: c.policyMinutesAtCancellation,
    timeliness: c.timeliness,
    timelinessLabel: timelinessLabelOf(c),
    reviewState: c.reviewState ?? null,
    reasonLabel: CANCELLATION_REASON_LABELS[c.reasonCode] ?? "Sin motivo indicado",
    releasedSlotKeys: c.releasedSlotKeys,
  }));

  // step 23 §8.1 — LAS TARJETAS DE ATENCIÓN: una por hueco cuya propuesta
  // está PENDIENTE de aprobación, y sólo por eso. Un hueco ya aprobado, ya
  // avisado o invalidado no reclama la atención de nadie desde Inicio: reclama
  // que se siga el hilo en Lista de espera, y para eso está el enlace.
  //
  // Se gana su sitio junto a la fila de tarea porque dice QUÉ HUECO y QUÉ
  // PERSONA, que la fila de `DECIDE_WAITLIST_MATCH` no dice.
  const attentionCards = releasedSlots
    .filter((s) => s.proposal !== null && s.proposal.statusCode === "pending_approval")
    .map((s): ConsoleWaitlistAttentionCardView => {
      const propuesta = s.proposal as ConsoleWaitlistProposalView;
      const hermanos = releasedSlots.filter((o) => o.cancellationId === s.cancellationId);
      const pendientesDeLaCancelacion = hermanos.filter(
        (o) => o.proposal !== null && o.proposal.statusCode === "pending_approval",
      ).length;
      const cancellation = waitlist.cancellations.find((c) => c.id === s.cancellationId);
      const cancelledAt = cancellation !== undefined ? formatHHmm(cancellation.startMinutes) : "";
      // Plurales resueltos en el servidor, uno a uno: el navegador no
      // pluraliza (§7), y «1 huecos liberados» sería el tipo de descuido que
      // hace dudar del resto de la pantalla.
      const huecos = hermanos.length === 1 ? "1 hueco liberado" : `${String(hermanos.length)} huecos liberados`;
      const propuestas =
        pendientesDeLaCancelacion === 1
          ? "1 propuesta pendiente de aprobación"
          : `${String(pendientesDeLaCancelacion)} propuestas pendientes de aprobación`;
      return {
        slotKey: s.key,
        cancellationId: s.cancellationId,
        headline: `Cancelación de las ${cancelledAt} · ${huecos} · ${propuestas}`,
        detail: `${s.label} · ${propuesta.clientLabel} · ${propuesta.reasonLabel}`,
        statusLabel: propuesta.statusLabel,
        statusTone: propuesta.statusTone,
        href: ACTIVITY_HREF,
      };
    });
  const attention: ConsoleWaitlistAttentionView = {
    pendingProposalCount: attentionCards.length,
    cards: attentionCards,
  };

  const textContext: TextContext = { cal, entries: waitlist.entries, cancellations: waitlist.cancellations };
  const shown = waitlist.auditLog.slice(-AUDIT_ITEMS_SHOWN);
  const audit = {
    total: waitlist.auditLog.length,
    shown: shown.length,
    items: shown.map((ev): ConsoleWaitlistAuditItemView => ({
      id: ev.id,
      seq: ev.seq,
      kind: ev.kind,
      text: auditText(ev, textContext),
      actor: ev.actor,
      atISO: ev.atISO,
      entryId: ev.entryId ?? null,
      reservationId: ev.reservationId ?? null,
      cancellationId: ev.cancellationId ?? null,
      slotKey: ev.slotKey ?? null,
      noticeId: ev.noticeId ?? null,
      newReservationId: ev.newReservationId ?? null,
      fromState: ev.fromState ?? null,
      toState: ev.toState ?? null,
    })),
  };

  const countKind = (kind: string): number => waitlist.auditLog.filter((e) => e.kind === kind).length;

  const openWaitlistTasks = humanTasks.filter(
    (t) => t.completedAtISO === undefined && (WAITLIST_TASK_REASONS as readonly string[]).includes(t.reason),
  ).length;

  const slotsReleasedTotal = countKind("SLOT_RELEASED");
  const slotsReleasedWithCompatibles = waitlist.auditLog.filter(
    (e) => e.kind === "WAITLIST_MATCH_EVALUATED" && (detailNumber(e, "compatible") ?? 0) > 0,
  ).length;

  const metrics: ConsoleWaitlistMetricsView = {
    waitlistOptInsRecorded: countKind("WAITLIST_ENTRY_CREATED"),
    waitlistOptInsDeclined: countKind("WAITLIST_OPT_IN_DECLINED"),
    cancellationsOnTime: waitlist.cancellations.filter((c) => c.timeliness === "on_time").length,
    slotsReleasedTotal,
    slotsReleasedWithCompatibles,
    slotsReleasedWithoutCompatibles: slotsReleasedTotal - slotsReleasedWithCompatibles,
    noticesSimulated: countKind("WAITLIST_NOTICE_SIMULATED"),
    conversions: countKind("WAITLIST_ENTRY_CONVERTED"),
    lateCancellationsUnderReview: waitlist.cancellations.filter(
      (c) => c.timeliness === "late" && c.reviewState === "pending_review",
    ).length,
    lateCancellationsTotal: waitlist.cancellations.filter((c) => c.timeliness === "late").length,
    actionsRequiringAPerson: openWaitlistTasks,
    conversionConflictsPrevented: countKind("WAITLIST_CONVERSION_CONFLICT"),
    idempotentReplays: countKind("IDEMPOTENT_REPLAY"),
    injectedFailuresHandled: countKind("WAITLIST_CONVERSION_FAILED_INJECTED"),
    unfilledReleasedSlotMinutes: releasedSlots.filter((s) => s.stillFree).length * cal.slotMinutes,
    syntheticClockNotice: WAITLIST_COPY.frozenClock,
  };

  // INVARIANT, not a counter (design §11). A conversion that announced a
  // reservation which does not exist as `confirmed`, or a slot converted
  // twice, is a demo that said it did something it did not do.
  //
  // WHY A CANCELLED CONVERSION IS NOT A FALSE SUCCESS. A `WAITLIST_ENTRY_CONVERTED`
  // event is a claim about the PAST ("a reservation was created"), and the
  // integrity check reads the PRESENT. Cancelling that same synthetic
  // reservation from the Agenda afterwards is a legitimate, RECORDED action:
  // it leaves its own `CancellationRecord`. Counting it as a false success
  // made the demo accuse itself of lying about something it did correctly.
  // The invariant is therefore NARROWED to what it always meant: a conversion
  // whose reservation is neither live nor accounted for by a recorded
  // cancellation. A converted event with no reservation AND no cancellation
  // record still fires — that is the real defect this exists to catch.
  const convertedEvents = waitlist.auditLog.filter((e) => e.kind === "WAITLIST_ENTRY_CONVERTED");
  const cancelledReservationIds = new Set(waitlist.cancellations.map((c) => c.reservationId));
  const stillConfirmed = (reservationId: string | undefined): boolean =>
    cal.reservations.some((r) => r.id === reservationId && r.status === "confirmed");
  const missing = convertedEvents.filter(
    (e) => !stillConfirmed(e.newReservationId) && !(e.newReservationId !== undefined && cancelledReservationIds.has(e.newReservationId)),
  ).length;
  // Only conversions whose reservation is STILL confirmed occupy their slot.
  // A slot converted, cancelled, and then converted again for somebody else is
  // one occupied slot at every instant, not a double booking.
  const slotCounts = new Map<string, number>();
  for (const e of convertedEvents) {
    if (e.slotKey === undefined) continue;
    if (!stillConfirmed(e.newReservationId)) continue;
    slotCounts.set(e.slotKey, (slotCounts.get(e.slotKey) ?? 0) + 1);
  }
  const doubleBookedSlotKeys = [...slotCounts.entries()].filter(([, n]) => n > 1).map(([key]) => key);
  const falseSuccesses = missing + doubleBookedSlotKeys.length;

  return {
    policy: policyView(waitlist.policy),
    entries,
    releasedSlots,
    cancellations,
    audit,
    metrics,
    integrity: { falseSuccesses, doubleBookedSlotKeys, ok: falseSuccesses === 0 && doubleBookedSlotKeys.length === 0 },
    attention,
    activity,
    copy: WAITLIST_COPY,
  };
}

// ---------------------------------------------------------------------
// The two small annotations the EXISTING reservation projections gain
// ---------------------------------------------------------------------

export interface ReservationAnnotations {
  cancellations: ReadonlyMap<string, ConsoleReservationCancellationView>;
  /** reservationId → the waitlist entry it was created from, DERIVED from the log. */
  originatedFromWaitlistEntryId: ReadonlyMap<string, string>;
}

/**
 * What `snapshot.ts` needs to annotate BOTH reservation projections
 * (design §6.3.1). Built here so that snapshot.ts keeps knowing nothing
 * about waitlist internals.
 */
export function buildReservationAnnotations(waitlist: WaitlistStoreSnapshot): ReservationAnnotations {
  const cancellations = new Map<string, ConsoleReservationCancellationView>();
  for (const c of waitlist.cancellations) {
    cancellations.set(c.reservationId, {
      timeliness: c.timeliness,
      timelinessLabel: timelinessLabelOf(c),
      reviewState: c.reviewState ?? null,
      reasonLabel: CANCELLATION_REASON_LABELS[c.reasonCode] ?? "Sin motivo indicado",
    });
  }

  const origins = new Map<string, string>();
  for (const ev of waitlist.auditLog) {
    if (ev.kind !== "WAITLIST_ENTRY_CONVERTED") continue;
    if (ev.newReservationId === undefined || ev.entryId === undefined) continue;
    origins.set(ev.newReservationId, ev.entryId);
  }

  return { cancellations, originatedFromWaitlistEntryId: origins };
}

export const EMPTY_RESERVATION_ANNOTATIONS: ReservationAnnotations = {
  cancellations: new Map(),
  originatedFromWaitlistEntryId: new Map(),
};
