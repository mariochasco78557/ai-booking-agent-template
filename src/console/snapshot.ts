import type { CallEventEmitter } from "../callEngine/events/emitter.js";
import type { AuditStamp } from "../callEngine/calendar/model.js";
import type { CalendarWithCapabilities } from "../callEngine/capabilities.js";
import type { MemoryStore } from "../callEngine/store/memoryStore.js";
import type { Clock } from "../callEngine/domain/types.js";
import { SYNTHETIC_FIXTURE_BANNER } from "../callEngine/fixtures/syntheticVenue.js";

/**
 * THE PRIVACY BOUNDARY of the operator console (step 13 mission brief).
 *
 * HARD RULE: every function below builds its output field-by-field, from an
 * EXPLICIT ALLOW LIST. Nothing here ever does `...someStoreObject` or
 * `...someEvent` into a returned value — a spread would silently let any
 * FUTURE field added to `memoryStore.ts` or `events/schema.ts` leak into the
 * console the moment it exists, without this file having to change at all.
 * That is precisely the failure mode this module exists to prevent.
 *
 * What must NEVER appear anywhere in this file's output:
 *   - `EmployeeAbsence.privateReason` (calendar/model.ts) — see
 *     `sanitizeAbsence` below, which is the ONLY place this module reads an
 *     absence, and which deliberately never reads that field.
 *   - the caller's raw `callId` — only `callIdHash` (already a salted
 *     SHA-256 digest minted by events/emitter.ts) ever appears.
 *   - client names, phone numbers, addresses, transcripts, recordings — none
 *     of `SyntheticReservation`, `MemoryStore`, or the two event streams
 *     carry any such field in the first place (see boundaries.test.ts under
 *     tests/callEngine), so this module has nothing to accidentally forward.
 *
 * ONE DELIBERATE EXCEPTION: a synthetic professional's `displayName` (e.g.
 * "Álex (sintético)") MAY be shown in this console — it is operator-facing,
 * not caller-facing, and every name in fixtures/syntheticVenue.ts is
 * entirely invented for this demo (see that file's own docblock). It is
 * exposed below under the key `label`, deliberately NOT `displayName` or
 * `name`, so it can never be confused with — or accidentally match a test's
 * blacklist scan for — a real personal-data field. It must NEVER be passed
 * into `emitter.emitPilotEvent`/`emitInternalEvent` (see events/schema.ts's
 * own docblock, which names this exact field as the canonical example of
 * what that blacklist blocks).
 */

// ---------------------------------------------------------------------
// Operational snapshot (calls, reservations, human queue, errors) — built
// from the memory store and the two event streams only.
// ---------------------------------------------------------------------

export interface ConsoleCallView {
  callIdHash: string;
  scenarioId: string;
  startedAtISO: string;
  /** Last classified intent (pilot vocabulary), if any turn was classified yet. */
  lastIntent?: string;
  /** Last known conversation state (from the last STATE_TRANSITION seen). */
  currentState?: string;
  /** Whether CALL_ENDED has been observed for this call. */
  ended: boolean;

  // -------------------------------------------------------------------
  // HOW THE CALL ENDED (step 14 decision D5). Every field below is read,
  // one by one, from the single internal `INTERNAL_OUTCOME_RESOLVED` event
  // the engine emits exactly once per finished call. The frozen pilot
  // stream is NOT touched to obtain any of them. All are optional because
  // a call that is still running (or that collapsed before `finalize()`)
  // genuinely has no outcome yet — and inventing a flattering default is
  // the exact failure this console exists to prevent.
  // -------------------------------------------------------------------

  /** `RESUELVE` | `DERIVA` | `RECHAZA`, as resolved by the engine. */
  outcome?: string;
  /** The FROZEN v1 reason code an external pilot consumer sees. Technical detail only. */
  reasonCode?: string;
  /** The INTERNAL (non-frozen) refinement — the one the status vocabulary must read. */
  internalReasonCode?: string;
  /** Whether the caller was told the booking was made. */
  announcesSuccess?: boolean;
  /**
   * TRUE only when the engine genuinely failed to work out what the caller
   * wanted. Straight from the engine's own table; never re-derived here.
   */
  countsAsNotUnderstood?: boolean;
  /**
   * TRUE when this call demonstrates the caller's intent WAS understood.
   *
   * NOT the negation of `countsAsNotUnderstood`, on purpose. A
   * `TECHNICAL_FAILURE` is `false` in BOTH: a technical collapse says
   * nothing about comprehension either way (see outcomeDimension.ts), so
   * claiming "understood" for it would inflate the comprehension figure
   * with calls that never proved anything. The two booleans are therefore
   * deliberately not exhaustive; a call can be neither.
   */
  countsAsUnderstoodIntent?: boolean;
  /** TRUE only for `BOOKING_CONFIRMED` — the only outcome that writes a reservation. */
  countsAsBookingConversion?: boolean;
  /**
   * TRUE only when the automation genuinely absorbed the call. FALSE for
   * `BOOKING_NOT_CONFIRMED`, which is argued at length in
   * outcomeDimension.ts and which this console honours rather than
   * quietly widening.
   */
  countsAsContained?: boolean;
}

/**
 * What an operator needs to know about a cancelled appointment, resolved
 * server-side (step 17, design §6.3.1). `reviewState` is `null` — never
 * absent — so the interface can tell "on time, nothing to review" apart from
 * "late and still pending" without inferring anything.
 */
export interface ConsoleReservationCancellationView {
  timeliness: "on_time" | "late";
  timelinessLabel: string;
  reviewState: "pending_review" | "reviewed_no_action" | null;
  reasonLabel: string;
}

/**
 * What an operator needs to know about a no-show ANNOTATED BY HAND on an
 * appointment (step 18, design §2.10). There is no penalty, no score and no
 * flag here — and there is no field in which a future change could hide one.
 */
export interface ConsoleReservationNoShowView {
  state: "recorded" | "corrected_not_a_no_show";
  stateLabel: string;
  recordedAtISO: string;
  /** Present only once corrected. `recordedAtISO` is NEVER overwritten. */
  correctedAtISO?: string;
}

/**
 * Everything about no-shows for ONE appointment, ALREADY RESOLVED by the
 * server (step 18, design §2.4/§2.10, decision N3). Built by
 * `console/operationsSnapshot.ts` — this module deliberately knows nothing
 * about operations internals, not even the shape of an idempotency key.
 */
export interface ConsoleReservationNoShowAnnotation {
  noShow?: ConsoleReservationNoShowView;
  eligibleForNoShow: boolean;
  noShowRevision: number;
  noShowIneligibleReason?: string;
  noShowKeyToMint: string;
  noShowFixKeyToMint: string;
}

/**
 * The GROUP REFERENCE an appointment of a multi-person booking carries
 * (step 18, design §4.9). A SYNTHETIC reference and nothing else: a closed
 * member label, a position, and the two sentences that say out loud that
 * cancelling one appointment cancels only that one (§4.11). No client, no
 * identity, no personal data — because none of that exists in this product.
 */
export interface ConsoleReservationGroupView {
  groupId: string;
  /** "grupo 1" — order of creation, never a priority. */
  groupLabel: string;
  memberLabel: string;
  /** "1 de 2". */
  positionLabel: string;
  cancelNote: string;
  /** What the cancel dialog must say BEFORE confirming (design §4.11). */
  cancelDialogNote: string;
  /** What the Agenda says next to a cancelled line of a live group (design §4.11). */
  siblingsNote: string;
}

export interface ConsoleReservationView {
  id: string;
  employeeId: number;
  serviceId: number;
  date: string;
  startMinutes: number;
  endMinutes: number;
  status: "confirmed" | "cancelled";
  callIdHash?: string;
  /**
   * Present only for a reservation the operator cancelled from the console
   * (step 17). A `cancelled` reservation WITHOUT this field is one the
   * calendar-change flow cancelled, and the interface must not claim a
   * timeliness verdict for it.
   */
  cancellation?: ConsoleReservationCancellationView;
  /** Present only for a reservation created from the waitlist. DERIVED from the waitlist audit log. */
  originatedFromWaitlistEntryId?: string;
  /** Present only for an appointment with a no-show annotated by an operator (step 18). */
  noShow?: ConsoleReservationNoShowView;
  /**
   * RESOLVED IN THE SERVER (design §2.4). The client never compares an hour
   * against an appointment: repeating that comparison in `/app.js` would be
   * the inherited defect this console exists to remove.
   */
  eligibleForNoShow: boolean;
  /** How many corrections this appointment carries (0 or 1). Feeds the key below. */
  noShowRevision: number;
  /** Why it cannot be marked right now, in Spanish. Absent when it can. */
  noShowIneligibleReason?: string;
  /**
   * The `Idempotency-Key` the interface must send to record / to correct.
   * RESOLVED HERE, never derived in the browser (decision N3, blocker B3):
   * the key carries the revision of the world it was minted in, which is what
   * makes "record again after correcting" reach its honest `409` instead of
   * replaying a memoised `201`.
   */
  noShowKeyToMint?: string;
  noShowFixKeyToMint?: string;
  /**
   * Present only for an appointment that belongs to a multi-person booking
   * (step 18 §4.9). The appointments of a group appear in the Agenda ONE BY
   * ONE, like any other; this is the shared reference between them, not a
   * container.
   */
  group?: ConsoleReservationGroupView;
  /**
   * step 24 §11.1 — presente SÓLO en una cita que creó un operador a mano.
   *
   * Es el CUARTO origen, y se deriva del registro de operaciones exactamente
   * igual que `originatedFromWaitlistEntryId` se deriva del de la lista de
   * espera: no se guarda dos veces y por tanto no puede divergir. Una cita
   * manual NO lleva `callIdHash` —no hubo llamada—, y ponerle uno inventado
   * para «marcarla» contaminaría un flujo diseñado para llamadas.
   */
  manual?: ConsoleReservationManualView;
}

/**
 * step 24 §11.1 — lo que la Agenda necesita para decir «creada manualmente por
 * el operador» sin leer un solo identificador interno en voz alta.
 */
export interface ConsoleReservationManualView {
  /** `man-0001`. Vive aquí para el detalle técnico plegado, nunca para la frase. */
  manualBookingId: string;
  /** La persona sintética del catálogo cerrado. */
  clientLabel: string;
  /** «Creada manualmente por el operador». Redactado por el servidor. */
  originLabel: string;
}

/**
 * The annotations the two reservation projections take (step 17, design
 * §6.3.1). Built by `console/waitlistSnapshot.ts` — this module deliberately
 * knows nothing about waitlist internals, only about the two small,
 * already-resolved facts it is handed. Optional everywhere, so every caller
 * that existed before this mission keeps working byte for byte.
 */
export interface ConsoleReservationAnnotations {
  cancellations: ReadonlyMap<string, ConsoleReservationCancellationView>;
  originatedFromWaitlistEntryId: ReadonlyMap<string, string>;
  /**
   * step 18: the no-show facts of every appointment, keyed by reservation id
   * and already resolved. Optional, so every caller that existed before this
   * mission keeps working — those callers get the neutral default below,
   * which claims nothing.
   */
  noShows?: ReadonlyMap<string, ConsoleReservationNoShowAnnotation>;
  /**
   * step 18 §4.9: the group reference of every appointment that has one,
   * keyed by reservation id and already resolved. Optional for the same reason
   * as `noShows`: a caller from before this mission gets no reference at all,
   * which is the truth for an appointment that belongs to no group.
   */
  groups?: ReadonlyMap<string, ConsoleReservationGroupView>;
  /**
   * step 24 §11.1: qué citas creó un operador a mano, ya resuelto. Opcional
   * por la misma razón que las dos de arriba — un llamador anterior a esta
   * misión no recibe ninguna, que es la verdad para una cita que no es manual.
   */
  manualBookings?: ReadonlyMap<string, ConsoleReservationManualView>;
}

/**
 * THE single place a `SyntheticReservation` becomes a console view. Field by
 * field, from the explicit allow list — never a spread of the store's or the
 * calendar's own object, exactly as this module's docblock demands. Both
 * projections (`snap.reservations` and `snap.calendar.reservations`) call
 * THIS function, which is why criterion 9 ("the two projections agree") can
 * never drift by a formatting accident.
 */
function reservationView(
  r: {
    id: string;
    employeeId: number;
    serviceId: number;
    date: string;
    startMinutes: number;
    endMinutes: number;
    status: "confirmed" | "cancelled";
    callIdHash?: string;
  },
  annotations: ConsoleReservationAnnotations | undefined,
): ConsoleReservationView {
  const cancellation = annotations?.cancellations.get(r.id);
  const origin = annotations?.originatedFromWaitlistEntryId.get(r.id);
  // step 18: field by field, exactly like everything else here. A caller
  // that hands over no annotation gets the neutral answer ("not eligible, no
  // corrections, no key"), which claims nothing about a feature it did not
  // ask about.
  const noShow = annotations?.noShows?.get(r.id);
  const group = annotations?.groups?.get(r.id);
  const manual = annotations?.manualBookings?.get(r.id);
  return {
    id: r.id,
    employeeId: r.employeeId,
    serviceId: r.serviceId,
    date: r.date,
    startMinutes: r.startMinutes,
    endMinutes: r.endMinutes,
    status: r.status,
    ...(r.callIdHash !== undefined ? { callIdHash: r.callIdHash } : {}),
    ...(cancellation !== undefined ? { cancellation } : {}),
    ...(origin !== undefined ? { originatedFromWaitlistEntryId: origin } : {}),
    ...(noShow?.noShow !== undefined ? { noShow: noShow.noShow } : {}),
    eligibleForNoShow: noShow?.eligibleForNoShow ?? false,
    noShowRevision: noShow?.noShowRevision ?? 0,
    ...(noShow?.noShowIneligibleReason !== undefined
      ? { noShowIneligibleReason: noShow.noShowIneligibleReason }
      : {}),
    ...(noShow !== undefined
      ? { noShowKeyToMint: noShow.noShowKeyToMint, noShowFixKeyToMint: noShow.noShowFixKeyToMint }
      : {}),
    ...(group !== undefined ? { group } : {}),
    ...(manual !== undefined ? { manual } : {}),
  };
}

export interface ConsoleAvailabilityQueryView {
  callIdHash: string;
  scenarioId: string;
  occurredAtISO: string;
  dateISO?: string;
  startMinutes?: number;
}

export interface ConsoleTransferView {
  callIdHash: string;
  scenarioId: string;
  occurredAtISO: string;
}

/**
 * The CLOSED set of reasons a human task can have (step 14 decision D6).
 * Classified HERE, in the server, never guessed in the browser with a
 * regular expression over `A\d\d-`: which task is which is business
 * meaning, and business meaning does not belong in a view layer.
 */
export type ConsoleTaskReasonKind =
  | "CALLBACK_FROM_CALL"
  | "REVIEW_ORPHANED_SYNTHETIC_RESERVATION"
  | "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE"
  // step 17 (design §7.3) — the three errands the waitlist genuinely
  // creates for a person. They are the ONLY new members; the closed set
  // stays closed and `UNKNOWN` still catches anything unrecognised rather
  // than dressing a guess up as a fact.
  | "REVIEW_LATE_CANCELLATION"
  | "DECIDE_WAITLIST_MATCH"
  | "REVIEW_WAITLIST_CONVERSION_CONFLICT"
  | "UNKNOWN";

export interface ConsoleTaskView {
  id: string;
  callIdHash: string;
  /**
   * The RAW technical value the engine stored (for a call escalation this is
   * the `scenarioId`, e.g. "A22-console-urgencia"). Kept because Laboratorio
   * and the technical-detail panel need it — but it is NOT what the queue
   * shows as the label of a task. See `reasonKind`/`reasonLabel`.
   */
  reason: string;
  /** The classified, closed-set reason. */
  reasonKind: ConsoleTaskReasonKind;
  /** Plain Spanish label for `reasonKind`. Single source of truth, server-side. */
  reasonLabel: string;
  createdAtISO: string;
  /**
   * FALSE once a person actually dealt with it (step 17, design §7.3).
   * Before this mission no task was ever closed, so every task the engine
   * and the calendar flow create is still `true` for ever — the value has
   * not changed for any of them, only become visible.
   */
  open: boolean;
  /**
   * step 19 §4.4 — WHEN a person actually closed it. SOLO se publica cuando
   * el almacén la tiene: una tarea abierta no lleva la clave, en vez de
   * llevarla con un valor de relleno. `open` sigue siendo la ÚNICA fuente de
   * "¿está abierta?"; esto es únicamente el CUÁNDO de las que ya no lo están.
   */
  completedAtISO?: string;
}

/**
 * step 19 §4.4/§7.1 (excepción declarada de I2, hallazgo m4) — los DOS
 * prefijos que el Laboratorio antepone a una marca de tiempo ya formateada
 * por el cliente (`formatDateTimeLong`, ui.js.ts). No es un dato que viaje en
 * la instantánea: es el catálogo de referencia que las pruebas usan para
 * comprobar, byte a byte, que el cliente escribe exactamente esto y no otra
 * cosa.
 *
 * *(Enmendado 2026-08-05 tras revisión adversarial de la capacidad 2,
 * hallazgo H6.)* Esta nota decía que «el resto del vocabulario de ese panel
 * (encabezado, filtros, píldoras, enlaces, **estados vacíos**) es vocabulario
 * de interfaz sin significado de negocio». Es cierto para el encabezado, los
 * filtros, las píldoras y los enlaces — pero no para las tres frases de abajo,
 * que SÍ afirman un hecho de negocio: que una tarea concreta ya no tiene nada
 * pendiente («Ya está resuelta…»), o que el almacén entero no tiene ninguna
 * tarea («Todavía no hay ninguna…»), o que el filtro elegido no encuentra
 * ninguna («Con este filtro…»). Son honestidad operativa, de la misma familia
 * que `mismatchLabel`/`WAITLIST_COPY`: se protegen aquí, con el mismo
 * mecanismo de comprobación byte a byte que ya protegía los dos prefijos,
 * para que ninguna variación silenciosa del cliente pueda decir algo distinto
 * de lo que este catálogo declara. El resto del vocabulario de ese panel
 * (encabezado, filtros, píldoras, enlaces) sigue siendo vocabulario de
 * interfaz sin significado de negocio — igual que
 * `STATUS_VOCAB`/`COMANDO_ETIQUETAS` en ui.js.ts — y sigue viviendo allí, no
 * aquí.
 */
export const HUMAN_TASK_LEDGER_COPY = {
  createdPrefix: "Creada el ",
  completedPrefix: "Resuelta el ",
  /** Tarea resuelta, sin llamada real asociada: ningún enlace, sólo esta frase (§4.5). */
  resolvedNothingToDo: "Ya está resuelta. No hay nada que hacer aquí.",
  /** El almacén entero de tareas está vacío (§4.3). */
  emptyLedger: "Todavía no hay ninguna tarea para una persona.",
  /** Hay tareas, pero el filtro elegido (estado y/o motivo) no encuentra ninguna (§4.3). */
  emptyFiltered: "Con este filtro no queda ninguna tarea. Prueba con “Todas”.",
  /**
   * *(Añadida 2026-08-06 tras revisión adversarial de misión completa,
   * hallazgo BAJO 1.)* El aviso permanente del panel («qué tipos de tarea
   * tienen camino de cierre», corregido tres veces — H3, M5 de la capacidad
   * 3, M5 de la fase de UI/UX — antes de que esta clave existiera). Vivía
   * como texto ESTÁTICO, repetido a mano, directamente en `ui.html.ts`:
   * (internal doc, not included in the template) (líneas 155 y 452) ya lo citaba como
   * `HUMAN_TASK_LEDGER_COPY.aviso`, un sitio que hasta ahora no existía —
   * las dos citas eran falsas por delante de tiempo. Se cumple el criterio
   * del propio documento (Dev-2, §4): «las tres frases que afirman un hecho
   * de negocio entran en `HUMAN_TASK_LEDGER_COPY`» — ésta es la cuarta, y la
   * más visible de las cuatro. `ui.html.ts` la interpola; ya no hay una
   * segunda copia de esta frase en ningún sitio del código servido.
   */
  aviso:
    "Hoy sólo dos tipos de tarea tienen camino de cierre: decidir a quién se ofrece un hueco liberado, cuando ese hueco se convierte de verdad en una reserva (rechazar la oferta no la cierra), y revisar una cancelación fuera de plazo, cuando se marca como revisada. Las demás se quedan abiertas hasta que reinicies la demostración, y no hay forma de darlas por hechas a mano: es a propósito.",
} as const;

export interface ConsoleNoticeView {
  id: string;
  callIdHash: string;
  channel: "whatsapp" | "internal";
  createdAtISO: string;
}

export interface ConsoleErrorView {
  id: string;
  callIdHash: string;
  message: string;
  atISO: string;
}

/**
 * D2 (step 14 repair) — THE SINGLE DEFINITION of "needs attention".
 *
 * Before this fix, `metrics.needsAttention` counted every call with
 * `outcome !== "RESUELVE"` (including `BOOKING_NOT_CONFIRMED`), while the
 * Inicio view's own attention cards (ui.js.ts's `callAttentionEntry`)
 * deliberately excluded `BOOKING_NOT_CONFIRMED` — the same call the rest of
 * this console already treats as "nothing to do" (`actionFor`,
 * ui.js.ts:251): the caller was understood, the slot was valid, only the
 * final yes never came, and outcomeDimension.ts's own reasoning (see its
 * `BOOKING_NOT_CONFIRMED` entry) is exactly why no card is shown for it.
 * That left two silently disagreeing definitions live on a demo of six
 * calls: server said 4 needed attention, the screen showed 3 cards.
 *
 * RESOLUTION CHOSEN: (a), not (b) — align the server's `needsAttention`
 * with the UI's actual rule, rather than deleting the field. `pinning
 * test` below shows why (b) was not viable: `needsAttention` and
 * `staffInterruptions` are BOTH already pinned by existing tests
 * (tests/console/console.test.ts), and this mission's rules forbid
 * weakening or deleting an existing test to make a defect disappear.
 * Deriving the count HERE (server-side) and having the UI consume it
 * outright — rather than re-deriving its own copy — was considered and
 * rejected for THIS repair: `callAttentionEntry` also decides card TIER and
 * TITLE, which needsAttention does not need, so collapsing them into one
 * function would pull unrelated rendering concerns into snapshot.ts. What
 * matters for "exactly one definition survives" is that the two rules
 * agree on WHICH calls count — this predicate is that one definition, and
 * `tests/console/console.test.ts`'s pinning test calls the REAL
 * `callAttentionEntry` from `ui.js.ts` (via `tests/console/uiClientExtract.ts`'s
 * extraction of the exact bytes `/app.js` serves — not a hand-written copy
 * of its rule) and asserts server count === that count on live data, so the
 * two can never again silently diverge without a test going red.
 */
function needsAttentionCall(c: ConsoleCallView): boolean {
  return c.outcome !== undefined && c.outcome !== "RESUELVE" && c.internalReasonCode !== "BOOKING_NOT_CONFIRMED";
}

/**
 * The Inicio dashboard's figures, computed HERE from the engine's own
 * resolved outcomes. The browser must not re-derive any of them: every one
 * of these numbers encodes a business decision (what "resolved" means, what
 * "needs attention" means) that already has a reasoned answer in
 * outcomeDimension.ts, and a second implementation in a view layer is a
 * second answer waiting to diverge.
 */
export interface ConsoleMetricsView {
  /** Calls the synthetic assistant handled. Every call runs on the engine's fixed clock, so all of them are "today". */
  callsHandled: number;
  /** Of those, how many reached a resolved outcome at all — the honest denominator for the ratio below. */
  callsWithOutcome: number;
  /** Calls the automation actually absorbed (`countsAsContained`). BOOKING_NOT_CONFIRMED does NOT count; see ConsoleCallView. */
  resolvedWithoutHumanInterruption: number;
  /** Synthetic bookings created by calls (`countsAsBookingConversion`). */
  bookingsCreated: number;
  /**
   * Calls that did not end in `RESUELVE` AND are not `BOOKING_NOT_CONFIRMED`
   * (D2, step 14 repair): every one of them produces an attention card on
   * Inicio, and every attention card counted here corresponds to exactly
   * one such call — see `needsAttentionCall` above, the single definition
   * both this field and ui.js.ts's `callAttentionEntry` are built from.
   */
  needsAttention: number;
  /** Calls whose resolved outcome is `TECHNICAL_FAILURE`. Not the same as `errors.technicalFailureCount`, which counts emitted TECHNICAL_FAILURE events. */
  technicalErrors: number;
  /**
   * OPEN items in the human-action queue. Until step 17 nothing ever closed
   * a task, so this counted all of them — and it still counts all of them for
   * every task type that existed before, because none of those is ever
   * completed by anything.
   */
  pendingHumanTasks: number;
  /** Times a member of staff was actually interrupted (pilot `STAFF_INTERRUPTION_RECORDED`). */
  staffInterruptions: number;
}

export interface ConsoleSnapshot {
  banner: string;
  /**
   * The ENGINE's date, "YYYY-MM-DD" — never the browser's. The engine runs
   * on a fixed synthetic clock; a browser computing "hoy" from the laptop's
   * real date would show an empty agenda while the data sat one day away.
   */
  engineToday: string;
  /** The engine's minutes-since-midnight, for "past vs upcoming" and the "SIGUIENTE" marker. */
  engineNowMinutes: number;
  metrics: ConsoleMetricsView;
  calls: readonly ConsoleCallView[];
  reservations: readonly ConsoleReservationView[];
  availabilityQueries: readonly ConsoleAvailabilityQueryView[];
  humanQueue: {
    transfersRequested: readonly ConsoleTransferView[];
    tasks: readonly ConsoleTaskView[];
    notices: readonly ConsoleNoticeView[];
  };
  errors: {
    items: readonly ConsoleErrorView[];
    technicalFailureCount: number;
  };
  eventCounts: {
    pilot: Record<string, number>;
    internal: Record<string, number>;
  };
}

function asRecordedString(detail: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = detail?.[key];
  return typeof v === "string" ? v : undefined;
}

function asRecordedNumber(detail: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = detail?.[key];
  return typeof v === "number" ? v : undefined;
}

function asRecordedBoolean(detail: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const v = detail?.[key];
  return typeof v === "boolean" ? v : undefined;
}

const TASK_REASON_LABELS: Readonly<Record<ConsoleTaskReasonKind, string>> = {
  CALLBACK_FROM_CALL: "Devolver la llamada",
  REVIEW_ORPHANED_SYNTHETIC_RESERVATION: "Comprobar una reserva que quedó sin avisar",
  CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE: "Llamar al cliente por un cambio de calendario",
  REVIEW_LATE_CANCELLATION: "Revisar una cancelación fuera de plazo",
  DECIDE_WAITLIST_MATCH: "Decidir a quién se ofrece un hueco liberado",
  REVIEW_WAITLIST_CONVERSION_CONFLICT: "Revisar un hueco que se ocupó antes de convertir",
  UNKNOWN: "Revisar esta llamada",
};

/**
 * Classifies one `HumanTask` into the closed set (decision D6).
 *
 * The two literal reasons are matched EXACTLY, because the two places that
 * write them (engine.ts's orphaned-reservation compensation and server.ts's
 * calendar-change flagging) write exactly those strings. A call escalation
 * is recognised by its id prefix, which engine.ts mints as
 * `task-<hash>-<n>` — deliberately not by pattern-matching the scenario id,
 * which is free-form operator input and must never decide business meaning.
 * Anything else is `UNKNOWN`, which the interface shows as a neutral
 * "Revisar esta llamada": never as a guess dressed up as a fact.
 */
function classifyTaskReason(task: { id: string; reason: string }): ConsoleTaskReasonKind {
  if (task.reason === "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE") return "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE";
  if (task.reason === "REVIEW_ORPHANED_SYNTHETIC_RESERVATION") return "REVIEW_ORPHANED_SYNTHETIC_RESERVATION";
  // step 17: three more EXACT comparisons, exactly like the two above.
  // Never a pattern match over a free-form field.
  if (task.reason === "REVIEW_LATE_CANCELLATION") return "REVIEW_LATE_CANCELLATION";
  if (task.reason === "DECIDE_WAITLIST_MATCH") return "DECIDE_WAITLIST_MATCH";
  if (task.reason === "REVIEW_WAITLIST_CONVERSION_CONFLICT") return "REVIEW_WAITLIST_CONVERSION_CONFLICT";
  if (task.id.startsWith("task-")) return "CALLBACK_FROM_CALL";
  return "UNKNOWN";
}

/**
 * Builds the console's operational snapshot from `store` and `emitter`
 * only. Pure and read-only — never mutates either. See this module's
 * docblock for the hard "explicit allow list, never spread" rule that every
 * branch below follows.
 */
export function buildSnapshot(
  store: MemoryStore,
  emitter: CallEventEmitter,
  clock: Clock,
  /** step 17: optional, so every pre-existing caller behaves byte for byte as before. */
  annotations?: ConsoleReservationAnnotations,
): ConsoleSnapshot {
  const storeSnapshot = store.snapshot();
  const { pilot, internal } = emitter.all();

  const callsByHash = new Map<string, ConsoleCallView>();
  for (const c of storeSnapshot.calls) {
    callsByHash.set(c.callIdHash, {
      callIdHash: c.callIdHash,
      scenarioId: c.scenarioId,
      startedAtISO: c.startedAtISO,
      ended: false,
    });
  }

  const transfersRequested: ConsoleTransferView[] = [];
  let technicalFailureCount = 0;
  const pilotCounts: Record<string, number> = {};

  for (const ev of pilot) {
    pilotCounts[ev.eventName] = (pilotCounts[ev.eventName] ?? 0) + 1;
    const existing = callsByHash.get(ev.callIdHash);
    if (existing) {
      if (ev.eventName === "INTENT_CLASSIFIED" && ev.intent !== undefined) {
        existing.lastIntent = ev.intent;
      }
      if (ev.eventName === "STATE_TRANSITION" && ev.toState !== undefined) {
        existing.currentState = ev.toState;
      }
      if (ev.eventName === "CALL_ENDED") {
        existing.ended = true;
      }
    }
    if (ev.eventName === "STAFF_INTERRUPTION_RECORDED") {
      transfersRequested.push({
        callIdHash: ev.callIdHash,
        scenarioId: ev.scenarioId,
        occurredAtISO: ev.occurredAt,
      });
    }
    if (ev.eventName === "TECHNICAL_FAILURE") {
      technicalFailureCount += 1;
    }
  }

  const availabilityQueries: ConsoleAvailabilityQueryView[] = [];
  const internalCounts: Record<string, number> = {};
  for (const ev of internal) {
    internalCounts[ev.eventName] = (internalCounts[ev.eventName] ?? 0) + 1;
    if (ev.eventName === "AVAILABILITY_QUERIED") {
      availabilityQueries.push({
        callIdHash: ev.callIdHash,
        scenarioId: ev.scenarioId,
        occurredAtISO: ev.occurredAt,
        dateISO: asRecordedString(ev.detail, "dateISO"),
        startMinutes: asRecordedNumber(ev.detail, "startMinutes"),
      });
    }
    // How the call ended (decision D5). Field by field, from the allow list
    // below — never `...ev.detail`, which would forward any future key the
    // engine adds to this event straight into the console.
    if (ev.eventName === "INTERNAL_OUTCOME_RESOLVED") {
      const call = callsByHash.get(ev.callIdHash);
      if (call) {
        const outcome = asRecordedString(ev.detail, "outcome");
        const reasonCode = asRecordedString(ev.detail, "pilotV1ReasonCode");
        const internalReasonCode = asRecordedString(ev.detail, "internalReasonCode");
        const announcesSuccess = asRecordedBoolean(ev.detail, "announcesSuccess");
        const notUnderstood = asRecordedBoolean(ev.detail, "countsAsNotUnderstood");
        const bookingConversion = asRecordedBoolean(ev.detail, "countsAsBookingConversion");
        const contained = asRecordedBoolean(ev.detail, "countsAsContained");
        if (outcome !== undefined) call.outcome = outcome;
        if (reasonCode !== undefined) call.reasonCode = reasonCode;
        if (internalReasonCode !== undefined) call.internalReasonCode = internalReasonCode;
        if (announcesSuccess !== undefined) call.announcesSuccess = announcesSuccess;
        if (notUnderstood !== undefined) call.countsAsNotUnderstood = notUnderstood;
        if (bookingConversion !== undefined) call.countsAsBookingConversion = bookingConversion;
        if (contained !== undefined) call.countsAsContained = contained;
        // See the field's docblock: NOT the negation of `countsAsNotUnderstood`.
        // A technical collapse proves nothing about comprehension, so it is
        // false here as well.
        if (notUnderstood !== undefined) {
          call.countsAsUnderstoodIntent = !notUnderstood && internalReasonCode !== "TECHNICAL_FAILURE";
        }
      }
    }
  }

  const calls = [...callsByHash.values()];
  const tasks = storeSnapshot.humanTasks.map((t) => {
    const reasonKind = classifyTaskReason(t);
    return {
      id: t.id,
      callIdHash: t.callIdHash,
      reason: t.reason,
      reasonKind,
      reasonLabel: TASK_REASON_LABELS[reasonKind],
      createdAtISO: t.createdAtISO,
      open: t.completedAtISO === undefined,
      // step 19 §4.4 — lista blanca explícita, NUNCA spread: la clave sólo
      // aparece cuando el almacén de verdad tiene la marca de cierre.
      ...(t.completedAtISO !== undefined ? { completedAtISO: t.completedAtISO } : {}),
    };
  });

  const metrics: ConsoleMetricsView = {
    callsHandled: calls.length,
    callsWithOutcome: calls.filter((c) => c.outcome !== undefined).length,
    resolvedWithoutHumanInterruption: calls.filter((c) => c.countsAsContained === true).length,
    bookingsCreated: calls.filter((c) => c.countsAsBookingConversion === true).length,
    needsAttention: calls.filter(needsAttentionCall).length,
    technicalErrors: calls.filter((c) => c.internalReasonCode === "TECHNICAL_FAILURE").length,
    pendingHumanTasks: tasks.filter((t) => t.open).length,
    staffInterruptions: transfersRequested.length,
  };

  return {
    banner: SYNTHETIC_FIXTURE_BANNER,
    engineToday: clock.nowISODate(),
    engineNowMinutes: clock.nowMinutes(),
    metrics,
    calls,
    reservations: storeSnapshot.reservations.map((r) => reservationView(r, annotations)),
    availabilityQueries,
    humanQueue: {
      transfersRequested,
      tasks,
      notices: storeSnapshot.internalNotices.map((n) => ({
        id: n.id,
        callIdHash: n.callIdHash,
        channel: n.channel,
        createdAtISO: n.createdAtISO,
      })),
    },
    errors: {
      items: storeSnapshot.errors.map((e) => ({
        id: e.id,
        callIdHash: e.callIdHash,
        message: e.message,
        atISO: e.atISO,
      })),
      technicalFailureCount,
    },
    eventCounts: { pilot: pilotCounts, internal: internalCounts },
  };
}

// ---------------------------------------------------------------------
// Calendar snapshot — the operational calendar's exceptions, WITHOUT
// `EmployeeAbsence.privateReason`, plus the console's own (non-personal)
// audit log of published calendar changes.
// ---------------------------------------------------------------------

export interface ConsoleProfessionalView {
  employeeId: number;
  /** Synthetic display label — see this module's docblock for why this is deliberately not called "name"/"displayName". */
  label: string;
}

export interface ConsoleAuditStampView {
  createdAt: string;
  createdBy: string;
  approvedAt?: string;
  approvedBy?: string;
  /**
   * step 26 REAPERTURA §R11 — la NOTA OPERATIVA que escribe el operador al
   * apuntar (o al retirar) un cierre, un día especial o una ausencia. Es el
   * ÚNICO campo de texto libre que esta frontera deja salir, y sale a
   * propósito: es la forma que tiene la pantalla de Horarios y ausencias de
   * decir de qué va cada excepción sin que nadie tenga que acordarse.
   *
   * NO ES —Y NO PUEDE CONVERTIRSE EN— `EmployeeAbsence.privateReason`, que
   * sigue sin leerse nunca por ninguna vía (ver el docblock de este módulo y
   * `calendar/model.ts`). La nota no pide, ni sugiere, ni admite como
   * obligatorio ningún dato médico o personal; el servidor la recorta y la
   * limita a 280 caracteres, y quien la pinta usa `textContent`.
   */
  note?: string;
}

export interface ConsoleClosureView {
  id: string;
  kind: "full_closure";
  startDate: string;
  endDate: string;
  source: string;
  approval: string;
  audit: ConsoleAuditStampView;
}

export interface ConsoleVenueRuleView {
  id: string;
  kind: "holiday" | "special_opening";
  scope: string;
  date: string;
  closed: boolean;
  specialOpen?: string;
  specialClose?: string;
  source: string;
  approval: string;
  audit: ConsoleAuditStampView;
}

/** Deliberately has no `privateReason` field at all — see `sanitizeAbsence`. */
export interface ConsoleAbsenceView {
  id: string;
  employeeId: number;
  kind: "vacation" | "absence" | "training";
  startDate: string;
  endDate: string;
  allDay: boolean;
  startMinutes?: number;
  endMinutes?: number;
  source: string;
  approval: string;
  audit: ConsoleAuditStampView;
}

export interface ConsoleOverrideView {
  id: string;
  employeeId: number;
  date: string;
  workDayStart: string;
  workDayEnd: string;
  breakStart?: string;
  breakEnd?: string;
  source: string;
  approval: string;
  audit: ConsoleAuditStampView;
}

export interface ConsoleWeeklyScheduleView {
  ownerKind: "venue" | "employee";
  employeeId?: number;
  dayOfWeek: number;
  workDayStart: string;
  workDayEnd: string;
  breakStart?: string;
  breakEnd?: string;
}

/**
 * One row of the DATED seasonal schedule (decision D3). `startDate`,
 * `endDate` and `recurrence` are exposed on purpose: the interface has to be
 * able to say, from the data, that this timetable ends on a given day and
 * does not come back on its own.
 */
export interface ConsoleSeasonalScheduleView {
  id: string;
  periodId: string;
  label: string;
  startDate: string;
  endDate: string;
  dayOfWeek: number;
  workDayStart: string;
  workDayEnd: string;
  breakStart?: string;
  breakEnd?: string;
  recurrence: string;
  duplicatedFromPeriodId?: string;
  source: string;
  approval: string;
  audit: ConsoleAuditStampView;
}

/** Which services a synthetic professional can perform. Ids only — the labels live in domain/types.ts. */
export interface ConsoleCapabilityView {
  employeeId: number;
  serviceIds: readonly number[];
}

export interface ConsoleCalendarSnapshot {
  professionals: readonly ConsoleProfessionalView[];
  /** Declared opening hours, so Agenda and Equipo read them from the data instead of from hand-written prose. */
  weeklySchedules: readonly ConsoleWeeklyScheduleView[];
  /** Dated seasonal overrides (August). Empty when the venue declares none. */
  seasonalSchedules: readonly ConsoleSeasonalScheduleView[];
  capabilities: readonly ConsoleCapabilityView[];
  slotMinutes: number;
  /** The whole synthetic agenda (fixture appointments plus anything the calls booked). */
  reservations: readonly ConsoleReservationView[];
  closures: readonly ConsoleClosureView[];
  venueRules: readonly ConsoleVenueRuleView[];
  /** Never carries `privateReason` — see this module's docblock. */
  absences: readonly ConsoleAbsenceView[];
  overrides: readonly ConsoleOverrideView[];
  /** The console's own, human-readable (Spanish) log of published changes. Never personal data — built entirely by server.ts from operational facts. */
  auditLog: readonly string[];
}

function sanitizeAudit(audit: AuditStamp): ConsoleAuditStampView {
  return {
    createdAt: audit.createdAt,
    createdBy: audit.createdBy,
    ...(audit.approvedAt !== undefined ? { approvedAt: audit.approvedAt } : {}),
    ...(audit.approvedBy !== undefined ? { approvedBy: audit.approvedBy } : {}),
    // REAPERTURA §R11 — la nota operativa SÍ sale, con el mismo patrón de
    // omisión-si-indefinido que los dos campos de arriba. `privateReason` no
    // se lee aquí ni en ningún otro sitio de este fichero: son dos campos
    // distintos con dos contratos opuestos, y ésta es la línea donde se ve.
    ...(audit.note !== undefined ? { note: audit.note } : {}),
  };
}

export function buildCalendarSnapshot(
  cal: CalendarWithCapabilities,
  auditLog: readonly string[],
  /** step 17: optional, so every pre-existing caller behaves byte for byte as before. */
  annotations?: ConsoleReservationAnnotations,
): ConsoleCalendarSnapshot {
  return {
    professionals: cal.professionals.map((p) => ({ employeeId: p.employeeId, label: p.displayName })),
    weeklySchedules: cal.weeklySchedules.map((w) => ({
      ownerKind: w.ownerKind,
      ...(w.employeeId !== undefined ? { employeeId: w.employeeId } : {}),
      dayOfWeek: w.dayOfWeek,
      workDayStart: w.workDayStart,
      workDayEnd: w.workDayEnd,
      ...(w.breakStart !== undefined ? { breakStart: w.breakStart } : {}),
      ...(w.breakEnd !== undefined ? { breakEnd: w.breakEnd } : {}),
    })),
    seasonalSchedules: (cal.seasonalSchedules ?? []).map((sch) => ({
      id: sch.id,
      periodId: sch.periodId,
      label: sch.label,
      startDate: sch.startDate,
      endDate: sch.endDate,
      dayOfWeek: sch.dayOfWeek,
      workDayStart: sch.workDayStart,
      workDayEnd: sch.workDayEnd,
      ...(sch.breakStart !== undefined ? { breakStart: sch.breakStart } : {}),
      ...(sch.breakEnd !== undefined ? { breakEnd: sch.breakEnd } : {}),
      recurrence: sch.recurrence,
      ...(sch.duplicatedFromPeriodId !== undefined ? { duplicatedFromPeriodId: sch.duplicatedFromPeriodId } : {}),
      source: sch.source,
      approval: sch.approval,
      audit: sanitizeAudit(sch.audit),
    })),
    capabilities: [...cal.capabilities.entries()].map(([employeeId, serviceIds]) => ({
      employeeId,
      serviceIds: [...serviceIds].sort((a, b) => a - b),
    })),
    slotMinutes: cal.slotMinutes,
    reservations: cal.reservations.map((r) => reservationView(r, annotations)),
    closures: cal.closures.map((c) => ({
      id: c.id,
      kind: c.kind,
      startDate: c.startDate,
      endDate: c.endDate,
      source: c.source,
      approval: c.approval,
      audit: sanitizeAudit(c.audit),
    })),
    venueRules: cal.venueRules.map((r) => ({
      id: r.id,
      kind: r.kind,
      scope: r.scope,
      date: r.date,
      closed: r.closed,
      ...(r.specialOpen !== undefined ? { specialOpen: r.specialOpen } : {}),
      ...(r.specialClose !== undefined ? { specialClose: r.specialClose } : {}),
      source: r.source,
      approval: r.approval,
      audit: sanitizeAudit(r.audit),
    })),
    // Deliberately NEVER reads `absence.privateReason` — see this module's docblock.
    absences: cal.absences.map((a) => ({
      id: a.id,
      employeeId: a.employeeId,
      kind: a.kind,
      startDate: a.startDate,
      endDate: a.endDate,
      allDay: a.allDay,
      ...(a.startMinutes !== undefined ? { startMinutes: a.startMinutes } : {}),
      ...(a.endMinutes !== undefined ? { endMinutes: a.endMinutes } : {}),
      source: a.source,
      approval: a.approval,
      audit: sanitizeAudit(a.audit),
    })),
    overrides: cal.overrides.map((o) => ({
      id: o.id,
      employeeId: o.employeeId,
      date: o.date,
      workDayStart: o.workDayStart,
      workDayEnd: o.workDayEnd,
      ...(o.breakStart !== undefined ? { breakStart: o.breakStart } : {}),
      ...(o.breakEnd !== undefined ? { breakEnd: o.breakEnd } : {}),
      source: o.source,
      approval: o.approval,
      audit: sanitizeAudit(o.audit),
    })),
    auditLog: [...auditLog],
  };
}
