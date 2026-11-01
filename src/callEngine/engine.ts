import type { Clock, EmployeeId, ServiceId } from "./domain/types.js";
import { SLOT_MINUTES } from "./domain/types.js";
import { addDays, dayOfWeek, parseHHmm, formatHHmm } from "./domain/time.js";
import type { CalendarWithCapabilities } from "./capabilities.js";
import { canPerform } from "./capabilities.js";
import { freeSlotStarts, isSlotFree, isWithinHorizon } from "./calendar/resolveAvailability.js";
import { chooseProfessional } from "./allocation/anyProfessional.js";
import type { SyntheticReservation } from "./calendar/model.js";
import type { Intent } from "./intent.js";
import { classifyIntent } from "./intent.js";
import type { Finding, Outcome, ReasonCode } from "./precedence.js";
import { resolveOutcome } from "./precedence.js";
import type { InternalReasonCode } from "./outcomeDimension.js";
import { OUTCOME_DIMENSIONS } from "./outcomeDimension.js";
import type { EngineState } from "./stateMachine.js";
import { MAX_TURNS, canTransition } from "./stateMachine.js";
import type { PhraseKey } from "./phrasing/keys.js";
import type { CallEventEmitter } from "./events/emitter.js";
import { hashCallId } from "./events/emitter.js";
import type { HumanTask, InternalNotice, MemoryStore } from "./store/memoryStore.js";
import { escalate } from "./humanCascade.js";

/**
 * The orchestrator. `runConversation` is the ONLY function in this module
 * tree that ties together intent classification, the state machine, the
 * calendar/allocation logic from the previous phase, event emission, the
 * in-memory store and the human-escalation cascade into one synthetic call.
 *
 * Deliberately SYNCHRONOUS and deterministic end-to-end: given the same
 * `EngineDeps` (in particular the same injected `Clock`) and the same
 * `ConversationScript`, three separate calls to `runConversation` produce
 * byte-for-byte identical `ConversationResult`s (see the determinism test in
 * tests/callEngine/engine.test.ts). No `Date.now()`, no bare `new Date()`,
 * no `Math.random()`, no `randomUUID()` anywhere below — every timestamp
 * comes from the injected `Clock`, and every identifier is derived from a
 * deterministic hash of scripted input plus this call's own counters.
 *
 * ---------------------------------------------------------------------
 * step 13 CORRECTION REPORT — summary of what changed and why (full
 * detail is in each fix's own comment, below):
 *
 *   B1: the security/human-escalation short circuit used to run ONLY at
 *       turn 0 (and its single retry). A caller could reveal a third-party
 *       access attempt, an explicit human request, or a CANCEL/RESCHEDULE/
 *       PRICE_OR_POLICY/SPECIAL_SERVICE utterance on ANY later turn and
 *       sail straight through to a booking. Fixed by `checkMidCallShortCircuit`,
 *       called after every `nextScriptTurn()` inside data collection and
 *       both confirmation gates — see stateMachine.ts for the new edges
 *       this required.
 *   B2: nothing ever compared the requested slot's start time against
 *       "right now" — only the whole-DAY horizon was checked. Fixed by an
 *       explicit past/lead-time check right after `dateISO`/`startMinutes`
 *       are computed.
 *   B3: the exact-slot-unavailable branch used one reasonCode
 *       (SLOT_OUTSIDE_SYNTHETIC_SCHEDULE, deliberately kept — see the
 *       final report for why not inventing an 11th code) for occupied
 *       slots, incapable professionals AND genuinely out-of-schedule
 *       slots alike, and the client-facing phrase asserted the LAST of
 *       those as if it were always the cause. Fixed: the phrase no longer
 *       asserts a cause at all (phrasing/es.ts); the REAL cause is now
 *       recorded in `Finding.detail` and a `SLOT_REJECTED` internal event
 *       (events/schema.ts) for a future console; and a reliable
 *       alternative is now offered for BOOK, not just AVAILABILITY.
 *   B4: `finalize()` used to be called from inside the `try` AND from the
 *       `catch`, using the non-validating `applyTransition`. If the first
 *       call's own event emission failed partway, the `catch` called
 *       `finalize()` a second time, producing two contradictory spoken
 *       phrases and an undeclared state transition. Fixed: `finalize()` is
 *       now called exactly once (structurally, plus an idempotency guard),
 *       uses the VALIDATING `transition()`, and a single outermost
 *       fail-closed fallback covers the case where `finalize()` itself
 *       cannot complete.
 *   A1: `CALL_STARTED`/`recordCallStarted` used to run outside every
 *       try/catch; an invalid `scenarioId` threw an uncaught ZodError
 *       instead of failing closed. Now covered by the same outer
 *       fail-closed fallback as B4.
 *   A2: the pilot stream's optional `latencyMs` used to be populated with
 *       a synthetic event-counter multiple, and a comment falsely claimed
 *       the frozen schema required it. Removed entirely — see
 *       events/emitter.ts.
 *   A3: a caller who was fully understood but never gave the final
 *       booking confirmation used to hear the same phrase as a caller who
 *       was never understood at all. A distinct `PhraseKey` (never a new
 *       `ReasonCode` — see (internal doc, not included in the template)) is now
 *       spoken for that case, and a distinct internal event is recorded.
 *   A4: `injectFailure` used to be honoured only on the BOOK write path;
 *       an AVAILABILITY scenario with `injectFailure: true` silently
 *       ignored it. Now checked uniformly, right when availability is
 *       first consulted, for either intent.
 *   A5: `urgent: true` alone used to never escalate (it only affected the
 *       escalation trigger label once CUSTOMER_REQUESTS_HUMAN was already
 *       otherwise triggered). Now `urgent` alone activates the human
 *       cascade.
 *   A6: a caught error's free-text `message` used to be forwarded verbatim
 *       into an internal event's `detail` — `assertNoPersonalData` only
 *       scans object KEYS, never values, so this could leak. Replaced with
 *       a small, closed set of stable error labels.
 * ---------------------------------------------------------------------
 */

// ---------------------------------------------------------------------
// Conversation script — a small DSL for expressing scenarios A01..A15 (and
// arbitrary others) declaratively, turn by turn.
// ---------------------------------------------------------------------

export type DayName = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

export type ProfessionalSelection = EmployeeId | "any";

export interface ConversationTurn {
  /** What the (synthetic) caller says this turn, classified via classifyIntent (intent.ts) — never via any AI/LLM. */
  utterance?: string;
  day?: DayName;
  time?: string; // "HH:mm"
  professionalId?: ProfessionalSelection;
  serviceId?: ServiceId | null;
  serviceConfirmed?: boolean;
  bookingConfirmed?: boolean;
  reservationRef?: string;
  /** Accepted, but never upgrades CANCEL/RESCHEDULE past derivation in this mission — see the docblock on the CANCEL/RESCHEDULE branch below. */
  identityProof?: "verified";
  explicitlyRequestsHuman?: boolean;
  attemptsThirdPartyAccess?: boolean;
  injectFailure?: boolean;
  urgent?: boolean;
}

export interface ConversationScript {
  scenarioId: string;
  /** The caller's raw call id. NEVER appears in any emitted event — only its salted hash does (events/emitter.ts's `hashCallId`). */
  callId: string;
  turns: readonly ConversationTurn[];
}

export interface EngineTurn {
  phraseKey: PhraseKey;
  params?: Record<string, unknown>;
}

export interface ConversationResult {
  scenarioId: string;
  outcome: Outcome;
  /**
   * The FROZEN v1 reason code (precedence.ts, ten values) — exactly what
   * travels on the pilot event stream. Unchanged and backward compatible.
   */
  reasonCode: ReasonCode;
  /**
   * The INTERNAL, non-frozen refinement of `reasonCode` (outcomeDimension.ts).
   * Equal to `reasonCode` for every outcome except the one case the frozen
   * ten cannot name honestly: `BOOKING_NOT_CONFIRMED`, which still reports
   * `reasonCode: "INTENT_NOT_UNDERSTOOD"` externally.
   *
   * ANY metric computed from this engine must read THIS field, not
   * `reasonCode` — see outcomeDimension.ts's `OUTCOME_DIMENSIONS` table and
   * (internal doc, not included in the template).
   */
  internalReasonCode: InternalReasonCode;
  announcesSuccess: boolean;
  /** Always `false` — this module tree never touches a real system. */
  externalMutation: false;
  syntheticMutation: boolean;
  /**
   * Set only on the absolute last-resort failure path, when a synthetic
   * reservation was written and then the call collapsed before the customer
   * could be told. The booking is deliberately left in place and flagged for
   * a human rather than silently removed.
   */
  requiresOperatorReview?: boolean;
  finalState: EngineState;
  stateTrace: readonly EngineState[];
  turns: readonly EngineTurn[];
  reservation?: SyntheticReservation;
  effectiveServiceId?: ServiceId;
}

export interface EngineDeps {
  cal: CalendarWithCapabilities;
  clock: Clock;
  emitter: CallEventEmitter;
  store: MemoryStore;
  salt: string;
  /**
   * Whether a live human transfer is available right now, within this
   * synthetic profile's configured hours (humanCascade.ts). Injected by the
   * caller — this engine never infers it from the real wall clock. Defaults
   * to `true` (transfer configured as available) when omitted.
   */
  liveTransferAvailable?: boolean;
}

// ---------------------------------------------------------------------
// Small internal control-flow signals. Both are genuinely thrown/caught —
// see this module's outer try/catch — so that "fail closed on any caught
// exception" is a real property of this code, not just of the two cases
// these two classes name.
// ---------------------------------------------------------------------

class MaxTurnsExceededError extends Error {
  constructor() {
    super("MAX_TURNS exceeded without resolving the call");
  }
}

class SyntheticInjectedFailureError extends Error {
  constructor() {
    super("synthetic injected failure (ConversationTurn.injectFailure)");
  }
}

/**
 * step 13 correction (B1 in the final report): thrown by
 * `checkMidCallShortCircuit` the instant a mid-call security/human/
 * cancel-or-change/business-data finding is pushed, so control unwinds
 * immediately to `finalize()` rather than continuing to collect data or ask
 * for a booking confirmation that must never be honoured. The relevant
 * `Finding` has ALREADY been pushed by the time this is thrown — the outer
 * catch (below) recognises this class and does not push anything further.
 */
class MidCallShortCircuitError extends Error {
  constructor() {
    super("mid-call short circuit — a Finding was already recorded before this was thrown");
  }
}

const DAY_NAME_TO_NUMBER: Readonly<Record<DayName, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** The next date (today inclusive) whose day-of-week matches `day`, relative to `clock`'s injected "today". Pure date arithmetic — see domain/time.ts. */
function nextDateForDay(clock: Clock, day: DayName): string {
  const target = DAY_NAME_TO_NUMBER[day];
  let candidate = clock.nowISODate();
  for (let i = 0; i < 7; i += 1) {
    if (dayOfWeek(candidate) === target) return candidate;
    candidate = addDays(candidate, 1);
  }
  // Unreachable: every weekday-of-week value appears within 7 days of any date.
  return candidate;
}

/**
 * Whether `startMinutes` on `dateISO` is inside *anyone's* structural
 * working hours — closures/rules/absences/weekly-schedule/breaks — WITHOUT
 * regard to whether that exact slot happens to already be reserved. Used to
 * tell "genuinely outside the synthetic schedule" (SLOT_OUTSIDE_SYNTHETIC_
 * SCHEDULE) apart from "structurally fine, just occupied right now" (which
 * this engine instead tries to resolve via an alternative — see
 * `findAlternative`). Achieved by re-running the existing, unmodified
 * `freeSlotStarts` against a copy of the calendar with `reservations`
 * stripped — level 6 of `resolveDayWindows`'s precedence is the only level
 * that is booking-specific, so removing it in this COPY (never mutating the
 * real `cal`) isolates exactly the "day/pause/closure" structural question.
 */
function structurallyFree(
  cal: CalendarWithCapabilities,
  professionalSelection: ProfessionalSelection,
  dateISO: string,
  startMinutes: number,
): boolean {
  const calNoReservations: CalendarWithCapabilities = { ...cal, reservations: [] };
  if (professionalSelection === "any") {
    return cal.professionals.some((p) =>
      freeSlotStarts(calNoReservations, p.employeeId, dateISO).includes(startMinutes),
    );
  }
  return freeSlotStarts(calNoReservations, professionalSelection, dateISO).includes(startMinutes);
}

/**
 * step 13 correction (B3(c) in the final report): the real, specific
 * cause an exact slot was rejected for — INTERNAL diagnostics only (see
 * `Finding.detail` and the `SLOT_REJECTED` internal event below). Never
 * client-facing: phrasing/es.ts's REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE
 * deliberately asserts none of these.
 */
type SlotRejectionCause =
  | "outside_horizon"
  | "past_or_lead_time"
  | "outside_schedule_or_break"
  | "occupied"
  | "not_capable"
  /**
   * step 22 correction (B1): the write gate reached with no professional
   * allocated. Unreachable while allocation runs for every confirmed
   * service — which is precisely why it is worth naming: if it ever shows
   * up on the internal stream, it says so instead of writing a reservation
   * that assigns nobody and occupies nothing.
   */
  | "no_professional_allocated";

interface ResolvedSlot {
  employeeId: EmployeeId;
  free: boolean;
  /** Present only when `!free` — see `SlotRejectionCause`. */
  reason?: "occupied" | "not_capable";
}

/** Resolves (without alternatives) whether `professionalSelection` is capable of `serviceId` AND free at the exact requested slot. */
function resolveExactSlot(
  cal: CalendarWithCapabilities,
  professionalSelection: ProfessionalSelection,
  serviceId: ServiceId,
  dateISO: string,
  startMinutes: number,
): ResolvedSlot {
  if (professionalSelection === "any") {
    const choice = chooseProfessional(cal, dateISO, startMinutes, serviceId);
    if (choice.employeeId !== null) {
      return { employeeId: choice.employeeId, free: true };
    }
    // step 13 correction (B3(c)): distinguish "nobody at all is capable of
    // this service" from "someone is capable but everyone capable is
    // occupied" — internal diagnostics only, never asserted to the caller.
    const anyoneCapable = cal.professionals.some((p) => canPerform(cal, p.employeeId, serviceId));
    return { employeeId: -1, free: false, reason: anyoneCapable ? "occupied" : "not_capable" };
  }
  const capable = canPerform(cal, professionalSelection, serviceId);
  if (!capable) {
    return { employeeId: professionalSelection, free: false, reason: "not_capable" };
  }
  const free = isSlotFree(cal, professionalSelection, dateISO, startMinutes);
  return { employeeId: professionalSelection, free, ...(free ? {} : { reason: "occupied" as const }) };
}

interface Alternative {
  employeeId: EmployeeId;
  dateISO: string;
  startMinutes: number;
  /**
   * step 22 correction (B2 in the phase-5 adversarial review): WHICH
   * dimension this alternative moved. The two branches below change
   * different things — the first keeps the professional and moves the day,
   * the second keeps the day and hour and changes the professional — and
   * the caller has to be told the truth about which one happened. Before
   * this field both were announced with the same phrase, which asserts
   * "ese horario exacto no está libre": false in the second case, where the
   * hour is free and it is the requested professional who cannot take it.
   */
  changed: "day" | "professional";
}

/**
 * step 22 correction (B2): the synthetic display label of a professional,
 * for the two phrases that have to name who will attend. Reads the fixture's
 * own `displayName` (always synthetic, always marked as such) and never
 * invents one; the fallback exists so an unknown id degrades to a number
 * instead of to `undefined`. This label travels ONLY in a phrase's params —
 * never into an emitted event, whose key blacklist forbids exactly this
 * (events/schema.ts's `assertNoPersonalData`).
 */
function professionalLabel(cal: CalendarWithCapabilities, employeeId: EmployeeId): string {
  return cal.professionals.find((p) => p.employeeId === employeeId)?.displayName ?? `profesional ${String(employeeId)}`;
}

/**
 * Looks for ONE reliable alternative when the exact requested slot is
 * structurally fine but not free right now: first the SAME professional
 * selection on the next few days (same time of day, within the booking
 * horizon), then — if a specific professional was requested — another
 * capable-and-free professional at the ORIGINAL exact date/time. Returns
 * `null` when nothing reliable is found; this engine never claims the shop
 * is indefinitely full (see phrasing/es.ts) but also never invents a slot
 * that isn't genuinely free.
 */
function findAlternative(
  cal: CalendarWithCapabilities,
  clock: Clock,
  professionalSelection: ProfessionalSelection,
  serviceId: ServiceId,
  dateISO: string,
  startMinutes: number,
): Alternative | null {
  for (let offset = 1; offset <= 6; offset += 1) {
    const candidateDate = addDays(dateISO, offset);
    if (!isWithinHorizon(cal, clock, candidateDate)) break;
    const resolved = resolveExactSlot(cal, professionalSelection, serviceId, candidateDate, startMinutes);
    if (resolved.free) {
      return { employeeId: resolved.employeeId, dateISO: candidateDate, startMinutes, changed: "day" };
    }
  }
  if (professionalSelection !== "any") {
    for (const p of cal.professionals) {
      if (p.employeeId === professionalSelection) continue;
      if (canPerform(cal, p.employeeId, serviceId) && isSlotFree(cal, p.employeeId, dateISO, startMinutes)) {
        return { employeeId: p.employeeId, dateISO, startMinutes, changed: "professional" };
      }
    }
  }
  return null;
}

const REASON_PHRASE_KEY: Readonly<Record<ReasonCode, PhraseKey>> = {
  SECURITY_OR_PRIVACY_BOUNDARY: "REASON_SECURITY_OR_PRIVACY_BOUNDARY",
  TECHNICAL_FAILURE: "REASON_TECHNICAL_FAILURE",
  CUSTOMER_REQUESTS_HUMAN: "REASON_CUSTOMER_REQUESTS_HUMAN",
  CANCEL_OR_CHANGE_NOT_ENABLED: "REASON_CANCEL_OR_CHANGE_NOT_ENABLED",
  BUSINESS_DATA_NOT_APPROVED: "REASON_BUSINESS_DATA_NOT_APPROVED",
  SLOT_OUTSIDE_SYNTHETIC_SCHEDULE: "REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
  SERVICE_NOT_CONFIRMED: "REASON_SERVICE_NOT_CONFIRMED",
  INTENT_NOT_UNDERSTOOD: "REASON_INTENT_NOT_UNDERSTOOD",
  BOOKING_CONFIRMED: "REASON_BOOKING_CONFIRMED",
  AVAILABILITY_PROVIDED: "REASON_AVAILABILITY_PROVIDED",
};

/**
 * step 13 correction (A6 in the final report): a small, CLOSED set of
 * stable error labels. `assertNoPersonalData` (events/schema.ts) only scans
 * object KEYS, never values — forwarding a caught error's free-text
 * `message` into an internal event's `detail` value could leak whatever
 * happened to be inside that message. Every internal `ERROR_RAISED` event
 * below carries one of these labels instead, never the raw `Error#message`.
 */
type EngineErrorLabel = "SYNTHETIC_INJECTED_FAILURE" | "UNEXPECTED_ENGINE_ERROR";

function errorLabel(err: unknown): EngineErrorLabel {
  return err instanceof SyntheticInjectedFailureError ? "SYNTHETIC_INJECTED_FAILURE" : "UNEXPECTED_ENGINE_ERROR";
}

export function runConversation(deps: EngineDeps, script: ConversationScript): ConversationResult {
  const { clock, emitter, store, salt } = deps;
  let cal = deps.cal;
  const liveTransferAvailable = deps.liveTransferAvailable ?? true;
  const callIdHash = hashCallId(script.callId, salt);

  const stateTrace: EngineState[] = [];
  const turns: EngineTurn[] = [];
  const findings: Finding[] = [];
  let currentState: EngineState = "INICIO";
  let turnCount = 0;
  let turnIndex = 0;
  let reservationOut: SyntheticReservation | undefined;
  let outcomePhraseParams: Record<string, unknown> = {};
  let lastKnownIntent: Intent | undefined;
  /** step 13 correction (A3/D2): see the docblock on `REASON_PHRASE_KEY` usage inside `finalize()`. */
  let bookingConfirmationNotObtained = false;
  /** step 13 correction (B4): guards `finalize()` against ever running twice — see that function's docblock. */
  let finalized = false;

  const collected: {
    serviceId?: ServiceId | null;
    serviceConfirmed?: boolean;
    day?: DayName;
    time?: string;
    professionalId?: ProfessionalSelection;
    bookingConfirmed?: boolean;
  } = {};
  const flags = {
    explicitlyRequestsHuman: false,
    attemptsThirdPartyAccess: false,
    injectFailure: false,
    urgent: false,
  };

  function nowISO(): string {
    return `${clock.nowInstantISO()}Z`;
  }

  /** Validated transition: throws (caught by the outer try/catch, below) on any undeclared move. */
  function transition(to: EngineState): void {
    if (!canTransition(currentState, to)) {
      throw new Error(`illegal transition ${currentState} -> ${to}`);
    }
    applyTransition(to);
  }

  /**
   * Unconditional transition — used only by `transition()` above (after it
   * has already validated the move) and, historically, by `finalize()`.
   * step 13 correction (B4): `finalize()` no longer calls this directly —
   * it now goes through the VALIDATING `transition()` for every move it
   * makes, so an undeclared jump is refused loudly instead of forced
   * silently. This function itself stays deliberately dumb (no validation
   * of its own) — `transition()` is the single place that validates.
   */
  function applyTransition(to: EngineState): void {
    const from = currentState;
    currentState = to;
    stateTrace.push(to);
    emitter.emitPilotEvent({
      scenarioId: script.scenarioId,
      callId: script.callId,
      salt,
      clock,
      eventName: "STATE_TRANSITION",
      fromState: from,
      toState: to,
    });
  }

  /** Appends a turn without consuming the MAX_TURNS budget — used only for the greeting, the terminal reason phrase and the farewell. */
  function pushTurn(phraseKey: PhraseKey, params?: Record<string, unknown>): void {
    turns.push(params !== undefined ? { phraseKey, params } : { phraseKey });
  }

  /** Appends an interactive turn AND consumes one unit of the MAX_TURNS budget. Throws once the budget is exhausted. */
  function ask(phraseKey: PhraseKey, params?: Record<string, unknown>): void {
    turnCount += 1;
    if (turnCount > MAX_TURNS) {
      throw new MaxTurnsExceededError();
    }
    pushTurn(phraseKey, params);
  }

  /** Pulls and merges the next scripted turn, if any is left. Returns it (or `undefined` once the script is exhausted). */
  function nextScriptTurn(): ConversationTurn | undefined {
    if (turnIndex >= script.turns.length) return undefined;
    // Bounds already checked above; noUncheckedIndexedAccess still types this as possibly undefined.
    const t = script.turns[turnIndex] as ConversationTurn;
    turnIndex += 1;
    mergeTurn(t);
    return t;
  }

  function mergeTurn(turn: ConversationTurn | undefined): void {
    if (!turn) return;
    if (turn.day !== undefined) collected.day = turn.day;
    if (turn.time !== undefined) collected.time = turn.time;
    if (turn.professionalId !== undefined) collected.professionalId = turn.professionalId;
    if (turn.serviceId !== undefined) collected.serviceId = turn.serviceId;
    if (turn.serviceConfirmed !== undefined) collected.serviceConfirmed = turn.serviceConfirmed;
    if (turn.bookingConfirmed !== undefined) collected.bookingConfirmed = turn.bookingConfirmed;
    if (turn.explicitlyRequestsHuman) flags.explicitlyRequestsHuman = true;
    if (turn.attemptsThirdPartyAccess) flags.attemptsThirdPartyAccess = true;
    if (turn.injectFailure) flags.injectFailure = true;
    if (turn.urgent) flags.urgent = true;
  }

  /**
   * A single, reusable check for the intent-level short circuits that must
   * win BEFORE any data collection starts (docs/call_interruption_mvp/
   * (internal doc, not included in the template): HUMAN_HELP/CANCEL/RESCHEDULE/ASK_PRICE/special-service/
   * third-party-data never reach RECOGER_DATOS). Pushes at most one
   * `Finding` and returns whether it did. Called both right after the
   * first classification and again after the single allowed retry, so the
   * logic is written once — AND (step 13 correction, B1) by
   * `checkMidCallShortCircuit` below, on every later turn too.
   */
  function shortCircuitForIntent(intent: Intent | undefined): boolean {
    // The structured `attemptsThirdPartyAccess` flag (set directly by a
    // ConversationScript turn) is checked ALONGSIDE the lexical
    // THIRD_PARTY_DATA classification, not instead of it: acceptance
    // scenario A10/A12 deliberately declare `intent: "OTHER"` in the JSON
    // fixture and rely on the flag alone, precisely to prove this boundary
    // does not depend on the caller's utterance being lexically
    // recognisable.
    if (intent === "THIRD_PARTY_DATA" || flags.attemptsThirdPartyAccess) {
      findings.push({ reasonCode: "SECURITY_OR_PRIVACY_BOUNDARY" });
      return true;
    }
    // step 13 correction (A5 in the final report): `urgent` alone —
    // without an explicit human request and without a HUMAN_HELP
    // utterance — used to never activate the human cascade; it only
    // affected the escalation TRIGGER LABEL once one of the other two
    // conditions had already fired. Urgency alone is now sufficient on its
    // own.
    if (flags.explicitlyRequestsHuman || flags.urgent || intent === "HUMAN_HELP") {
      findings.push({ reasonCode: "CUSTOMER_REQUESTS_HUMAN" });
      recordEscalation(escalate({ trigger: flags.urgent ? "urgent" : "explicit_human_request", liveTransferAvailable }));
      return true;
    }
    if (intent === "CANCEL" || intent === "RESCHEDULE") {
      // `identityProof` (ConversationTurn) is accepted structurally but
      // deliberately never inspected here: even a verified identity does
      // not upgrade this outcome to a mutation in this mission's scope —
      // see the module docblock and the dedicated
      // "identityProof does not enable a mutation" test in engine.test.ts.
      findings.push({ reasonCode: "CANCEL_OR_CHANGE_NOT_ENABLED" });
      return true;
    }
    if (intent === "PRICE_OR_POLICY" || intent === "SPECIAL_SERVICE") {
      findings.push({ reasonCode: "BUSINESS_DATA_NOT_APPROVED" });
      return true;
    }
    return false;
  }

  /**
   * step 13 correction (B1 in the final report): the mid-call counterpart
   * of the turn-0-only check above. Called after EVERY `nextScriptTurn()`
   * inside the RECOGER_DATOS loop and after the retry turn in both
   * confirmation gates (CONFIRMACION_DE_SERVICIO, CONFIRMACION_EXPLICITA_
   * DE_RESERVA). Re-evaluates the accumulated `flags` (which `mergeTurn`
   * already updates on every turn, but which nothing used to re-consult)
   * AND, when this turn carries a fresh `utterance`, reclassifies it —
   * exactly what let a caller reveal "en realidad es la cita de mi
   * hermano" or "prefiero hablar con una persona" mid-flow and still have
   * it ignored. `currentState` at every call site below already has a
   * declared edge to whichever `EMITIR_*` state `finalize()` will need
   * (see stateMachine.ts's `TRANSITIONS` table) — this function itself
   * never transitions.
   */
  function checkMidCallShortCircuit(turn: ConversationTurn | undefined): void {
    let midIntent: Intent | undefined;
    if (turn?.utterance !== undefined) {
      const classification = classifyIntent(turn.utterance);
      midIntent = classification.intent;
      // `lastKnownIntent` is deliberately NOT updated here. It feeds the
      // `intent` field of the pilot stream's OUTCOME_EMITTED, which is how
      // PILOT_METRICS.md segments calls by what the customer wanted. A
      // filler reply like "pues el número uno por favor" classifies as
      // OTHER, and overwriting the call's intent with it made successful
      // bookings report `intent: "OTHER"` — corrupting the very
      // segmentation Bruno would read. The reclassification exists to catch
      // a *new* intent that must short-circuit (asking for a person, or for
      // someone else's appointment); only then does it become the call's
      // intent, which happens below.
      emitter.emitPilotEvent({
        scenarioId: script.scenarioId,
        callId: script.callId,
        salt,
        clock,
        eventName: "INTENT_CLASSIFIED",
        intent: midIntent,
      });
    }
    if (shortCircuitForIntent(midIntent)) {
      // Only a short-circuiting reclassification becomes the call's intent:
      // at this point the customer really did change what they are asking
      // for, so the pilot stream should say so.
      if (midIntent !== undefined) lastKnownIntent = midIntent;
      throw new MidCallShortCircuitError();
    }
  }

  function recordEscalation(result: ReturnType<typeof escalate>): void {
    outcomePhraseParams = result.phraseParams;
    if (result.liveTransferRequested) {
      emitter.emitPilotEvent({
        scenarioId: script.scenarioId,
        callId: script.callId,
        salt,
        clock,
        eventName: "STAFF_INTERRUPTION_RECORDED",
      });
    }
    if (result.internalTaskCreated) {
      const task: HumanTask = {
        id: `task-${callIdHash.slice(0, 12)}-${stateTrace.length}`,
        callIdHash,
        reason: script.scenarioId,
        createdAtISO: nowISO(),
      };
      store.addHumanTask(task);
      emitter.emitInternalEvent({
        scenarioId: script.scenarioId,
        callId: script.callId,
        salt,
        clock,
        eventName: "HUMAN_TASK_CREATED",
        detail: { taskId: task.id },
      });
      emitter.emitPilotEvent({
        scenarioId: script.scenarioId,
        callId: script.callId,
        salt,
        clock,
        eventName: "CALLBACK_REQUESTED",
      });
    }
    if (result.internalNoticeRequested) {
      const notice: InternalNotice = {
        id: `notice-${callIdHash.slice(0, 12)}-${stateTrace.length}`,
        callIdHash,
        channel: "whatsapp",
        createdAtISO: nowISO(),
      };
      store.addInternalNotice(notice);
      emitter.emitInternalEvent({
        scenarioId: script.scenarioId,
        callId: script.callId,
        salt,
        clock,
        eventName: "INTERNAL_NOTICE_SIMULATED",
        detail: { channel: notice.channel },
      });
    }
  }

  /**
   * step 13 correction (B3(c) in the final report): records the REAL
   * cause of an exact-slot rejection to the internal (non-frozen) event
   * stream only — never client-facing. `cause` is one of
   * `SlotRejectionCause`; see phrasing/es.ts's REASON_SLOT_OUTSIDE_
   * SYNTHETIC_SCHEDULE, which deliberately asserts none of these to the
   * caller.
   */
  function recordSlotRejection(cause: SlotRejectionCause, dateISO: string, startMinutes: number): void {
    findings.push({ reasonCode: "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE", detail: cause });
    emitter.emitInternalEvent({
      scenarioId: script.scenarioId,
      callId: script.callId,
      salt,
      clock,
      eventName: "SLOT_REJECTED",
      detail: { cause, dateISO, startMinutes },
    });
  }

  /**
   * The single terminal exit point.
   *
   * step 13 correction (B4 in the final report): `finalize()` used to be
   * called from BOTH the normal end of the business-logic `try` block AND
   * from its `catch` — using the non-validating `applyTransition` — so if
   * the FIRST call's own `emitPilotEvent(OUTCOME_EMITTED)` threw partway
   * through (after it had already pushed a terminal reason phrase and
   * transitioned state), the `catch` ran a SECOND, contradictory
   * `finalize()`, forcing an undeclared state transition and speaking a
   * second, contradictory phrase. Fixed two ways, deliberately redundant:
   *   1. Structurally: this function is now called from exactly ONE call
   *      site in `runConversation`, positioned AFTER the business-logic
   *      try/catch (not inside either branch of it) — see the bottom of
   *      this file.
   *   2. Defensively: the `finalized` guard below makes a second call
   *      throw immediately rather than silently re-run, in case a future
   *      edit ever reintroduces a second call site.
   * `finalize()` now also VALIDATES its own transition via `transition()`
   * (which throws on an undeclared move) instead of forcing it via the
   * unconditional `applyTransition` — an illegal jump is a genuine
   * programming error and must surface loudly, not be forced through
   * silently. Because `finalize()` can therefore itself throw, the single
   * call site is wrapped by `runConversation`'s own OUTERMOST fail-closed
   * fallback (see the bottom of this file) — never by calling `finalize()`
   * again.
   */
  function finalize(): ConversationResult {
    if (finalized) {
      throw new Error("finalize() invoked more than once for the same call — see this function's docblock (B4)");
    }
    finalized = true;

    const { outcome, reasonCode } = resolveOutcome(findings);
    // `announcesSuccess` is NOT simply "outcome === RESUELVE": informing
    // availability (AVAILABILITY_PROVIDED) is also a RESUELVE outcome, but
    // it never announces that an OPERATION succeeded — only a completed,
    // synthetic BOOKING_CONFIRMED does (see docs/call_interruption_mvp/
    // acceptance-scenarios.json's A01 vs A03, and PILOT_METRICS.md's
    // "falsa confirmación" formula, which depends on this being exact).
    const announcesSuccess = reasonCode === "BOOKING_CONFIRMED";
    const target: EngineState =
      outcome === "RESUELVE" ? "EMITIR_RESUELVE" : outcome === "RECHAZA" ? "EMITIR_RECHAZA" : "EMITIR_DERIVA";
    if (currentState !== target) {
      transition(target);
    }
    // step 13 correction (A3/D2 in the final report): a caller who was
    // fully understood, confirmed the service, but never gave the final
    // booking confirmation used to hear REASON_INTENT_NOT_UNDERSTOOD's
    // "no he conseguido entender qué necesitas" — false, since they WERE
    // understood. That narrow case still resolves to `reasonCode:
    // "INTENT_NOT_UNDERSTOOD"` (see (internal doc, not included in the template)
    // for why no dedicated ReasonCode exists), but a DISTINCT PhraseKey is
    // spoken for it instead.
    const phraseKey: PhraseKey =
      bookingConfirmationNotObtained && reasonCode === "INTENT_NOT_UNDERSTOOD"
        ? "REASON_BOOKING_CONFIRMATION_NOT_OBTAINED"
        : REASON_PHRASE_KEY[reasonCode];
    pushTurn(phraseKey, outcomePhraseParams);

    // step 14: the internal, non-frozen refinement of the frozen
    // `reasonCode`. `BOOKING_NOT_CONFIRMED` is the ONLY case where the two
    // differ; `OUTCOME_DIMENSIONS[...].pilotV1ReasonCode` maps it back to
    // exactly the `INTENT_NOT_UNDERSTOOD` the frozen stream already carried,
    // so the pilot event below is byte-identical to what it emitted before.
    const internalReasonCode: InternalReasonCode =
      bookingConfirmationNotObtained && reasonCode === "INTENT_NOT_UNDERSTOOD"
        ? "BOOKING_NOT_CONFIRMED"
        : reasonCode;
    const dimensions = OUTCOME_DIMENSIONS[internalReasonCode];

    // Emitted BEFORE OUTCOME_EMITTED on purpose. Both emissions are
    // in-memory pushes of fixed-shape objects and cannot realistically
    // throw, but a wrapping emitter can (see (internal doc, not included in the template)'s
    // "divergencia entre el motor y el flujo de piloto"). If one of the two
    // is going to fail, the frozen pilot stream is the one that must not be
    // left holding a result the internal stream never recorded: the internal
    // stream is the source of truth for metrics, so an internal record
    // without a pilot record is recoverable, while the reverse reintroduces
    // exactly the divergence already documented.
    emitter.emitInternalEvent({
      scenarioId: script.scenarioId,
      callId: script.callId,
      salt,
      clock,
      eventName: "INTERNAL_OUTCOME_RESOLVED",
      detail: {
        internalReasonCode,
        pilotV1ReasonCode: dimensions.pilotV1ReasonCode,
        outcome,
        announcesSuccess,
        countsAsNotUnderstood: dimensions.countsAsNotUnderstood,
        countsAsBookingConversion: dimensions.countsAsBookingConversion,
        countsAsContained: dimensions.countsAsContained,
      },
    });

    emitter.emitPilotEvent({
      scenarioId: script.scenarioId,
      callId: script.callId,
      salt,
      clock,
      eventName: "OUTCOME_EMITTED",
      intent: lastKnownIntent ?? "OTHER",
      outcome,
      reasonCode,
      announcesSuccess,
    });
    transition("FIN");
    pushTurn("FAREWELL");
    emitter.emitPilotEvent({
      scenarioId: script.scenarioId,
      callId: script.callId,
      salt,
      clock,
      eventName: "CALL_ENDED",
    });

    const effectiveServiceId =
      collected.serviceId !== null && collected.serviceId !== undefined ? collected.serviceId : undefined;

    return {
      scenarioId: script.scenarioId,
      outcome,
      reasonCode,
      internalReasonCode,
      announcesSuccess,
      externalMutation: false,
      syntheticMutation: reservationOut !== undefined,
      finalState: currentState,
      stateTrace,
      turns,
      ...(reservationOut !== undefined ? { reservation: reservationOut } : {}),
      ...(effectiveServiceId !== undefined ? { effectiveServiceId } : {}),
    };
  }

  /**
   * step 13 correction (A1/B4 in the final report): EVERYTHING below —
   * including `CALL_STARTED`/`recordCallStarted`, which used to run
   * OUTSIDE every try/catch and could throw an uncaught ZodError on an
   * invalid `scenarioId` — is now wrapped by this single outermost
   * try/catch. Its `catch` is the absolute last resort: it is reached only
   * if (a) `CALL_STARTED`'s own emission failed, or (b) the inner
   * try/catch below re-threw something unrecognised, or (c) `finalize()`
   * itself failed (an illegal transition it refused, or a broken
   * emitter). In every case, this fallback NEVER calls `finalize()` again
   * (that is precisely the B4 bug) and never calls the emitter again
   * (which may be the very thing that just failed): it returns a minimal,
   * honest, hard-coded DERIVA/TECHNICAL_FAILURE result built only from
   * local state already known to be safe. `turns`/`stateTrace` are reset
   * first so no partially-pushed, possibly-contradictory phrase or
   * undeclared transition from a failed `finalize()` attempt survives into
   * the returned result.
   */
  try {
    emitter.emitPilotEvent({
      scenarioId: script.scenarioId,
      callId: script.callId,
      salt,
      clock,
      eventName: "CALL_STARTED",
    });
    store.recordCallStarted({ callIdHash, scenarioId: script.scenarioId, startedAtISO: nowISO() });

    try {
      transition("ENMARCAR_DEMO");
      pushTurn("GREETING_DEMO_FRAME");

      transition("ENTENDER_INTENCION");
      const turn0 = nextScriptTurn();
      let intent: Intent | undefined;
      let confident = false;
      if (turn0?.utterance !== undefined) {
        const classification = classifyIntent(turn0.utterance);
        intent = classification.intent;
        confident = classification.confident;
      }
      lastKnownIntent = intent;
      emitter.emitPilotEvent({
        scenarioId: script.scenarioId,
        callId: script.callId,
        salt,
        clock,
        eventName: "INTENT_CLASSIFIED",
        intent: intent ?? "OTHER",
      });

      if (!shortCircuitForIntent(intent)) {
        if (!confident || intent === undefined || intent === "OTHER") {
          transition("ACLARAR_UNA_VEZ");
          ask("CLARIFY_ONCE", { topic: "intent" });
          const retry = nextScriptTurn();
          if (retry?.utterance !== undefined) {
            const reclassified = classifyIntent(retry.utterance);
            intent = reclassified.intent;
            confident = reclassified.confident;
            lastKnownIntent = intent;
          }
          transition("ENTENDER_INTENCION");

          if (!shortCircuitForIntent(intent)) {
            if (!confident || intent === undefined || intent === "OTHER") {
              findings.push({ reasonCode: "INTENT_NOT_UNDERSTOOD" });
            }
          }
        }
      }

      // Only BOOK/AVAILABILITY reach data collection; every other branch
      // above already pushed a Finding and falls through to `finalize()`.
      if (findings.length === 0 && (intent === "BOOK" || intent === "AVAILABILITY")) {
        transition("RECOGER_DATOS");
        // One missing field per turn, in order: servicio, fecha, hora, profesional.
        // step 13 correction (B1): each branch below now calls
        // `checkMidCallShortCircuit` right after collecting the turn, so a
        // security/human/cancel-or-change/business-data signal revealed
        // while still gathering data is caught immediately instead of
        // being silently carried forward toward a booking.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (collected.serviceId === undefined) {
            ask("ASK_SERVICE");
            const t = nextScriptTurn();
            transition("RECOGER_DATOS");
            checkMidCallShortCircuit(t);
            continue;
          }
          if (collected.day === undefined) {
            ask("ASK_DATE");
            const t = nextScriptTurn();
            transition("RECOGER_DATOS");
            checkMidCallShortCircuit(t);
            continue;
          }
          if (collected.time === undefined) {
            ask("ASK_TIME");
            const t = nextScriptTurn();
            transition("RECOGER_DATOS");
            checkMidCallShortCircuit(t);
            continue;
          }
          if (collected.professionalId === undefined) {
            ask("ASK_PROFESSIONAL");
            const t = nextScriptTurn();
            transition("RECOGER_DATOS");
            checkMidCallShortCircuit(t);
            continue;
          }
          break;
        }

        transition("VALIDAR_DATOS");
        const dateISO = nextDateForDay(clock, collected.day as DayName);
        const startMinutes = parseHHmm(collected.time as string);
        const professionalSelection = collected.professionalId as ProfessionalSelection;

        // step 13 correction (B2 in the final report): `isWithinHorizon`
        // is a whole-DAY gate only (calendar/resolveAvailability.ts) — it
        // never compares the exact requested `startMinutes` against "right
        // now". A slot on TODAY, earlier than "now + minimumLeadMinutes",
        // used to sail straight through and get booked as if it were in
        // the future. This check is deliberately done HERE, in engine.ts,
        // rather than by modifying resolveAvailability.ts (out of this
        // mission's scope).
        const isPastOrTooSoon =
          dateISO === clock.nowISODate() && startMinutes < clock.nowMinutes() + cal.minimumLeadMinutes;

        if (!isWithinHorizon(cal, clock, dateISO)) {
          recordSlotRejection("outside_horizon", dateISO, startMinutes);
        } else if (isPastOrTooSoon) {
          recordSlotRejection("past_or_lead_time", dateISO, startMinutes);
        } else if (!structurallyFree(cal, professionalSelection, dateISO, startMinutes)) {
          recordSlotRejection("outside_schedule_or_break", dateISO, startMinutes);
        } else {
          transition("CONSULTAR_DISPONIBILIDAD");
          emitter.emitInternalEvent({
            scenarioId: script.scenarioId,
            callId: script.callId,
            salt,
            clock,
            eventName: "AVAILABILITY_QUERIED",
            detail: { dateISO, startMinutes },
          });

          // step 13 correction (A4 in the final report): `injectFailure`
          // used to be honoured ONLY on the BOOK write path, right before
          // ESCRITURA_SINTETICA — an AVAILABILITY scenario with
          // `injectFailure: true` silently ignored it and could still
          // resolve. Checked here instead, uniformly, for either intent,
          // right when availability is first consulted.
          if (flags.injectFailure) {
            throw new SyntheticInjectedFailureError();
          }

          let chosenEmployeeId: EmployeeId | undefined;
          let effectiveDateISO = dateISO;
          let effectiveStartMinutes = startMinutes;
          let slotUnresolvable = false;
          /**
           * step 22 correction (B2): true only when the caller asked for a
           * SPECIFIC professional and the booking ended up with a different
           * one. It is what makes the confirmation recap name who will
           * actually attend, so that nobody confirms believing they booked
           * somebody else. Every other booking keeps its recap word for
           * word — this repair adds a sentence where one was missing, it
           * does not rewrite the ones that were already true.
           */
          let professionalSubstituted = false;

          /**
           * step 22 correction (B1 in the phase-5 adversarial review):
           * allocation used to live INLINE here, guarded by "do we already
           * know the service?". A caller who did not name a service until
           * the service-confirmation gate below (`serviceId: null` on the
           * way in, a real service when asked) therefore never ran it at
           * all: `chosenEmployeeId` stayed `undefined`, the `as EmployeeId`
           * casts at the write laundered it past the type system, and the
           * booking was announced as confirmed with NO professional. Such a
           * reservation also occupied nothing (`isSlotFree` filters
           * reservations by `r.employeeId === employeeId`, which matches
           * nothing for `undefined`), so the same half hour could be booked
           * twice.
           *
           * Extracted verbatim into this function so the SAME allocation can
           * be run a second time when — and only when — the service arrives
           * late. It is idempotent by construction: it is only ever called
           * while `chosenEmployeeId === undefined`.
           */
          function allocate(serviceId: ServiceId): void {
            const resolved = resolveExactSlot(cal, professionalSelection, serviceId, dateISO, startMinutes);
            if (resolved.free) {
              chosenEmployeeId = resolved.employeeId;
            } else {
              const alternative = findAlternative(
                cal,
                clock,
                professionalSelection,
                serviceId,
                dateISO,
                startMinutes,
              );
              // step 13 correction (B3(d) in the final report): a reliable
              // alternative is now offered/used regardless of intent — it
              // used to be discarded outright for BOOK (`intent ===
              // "AVAILABILITY"` was required), so a capable, genuinely free
              // professional went unoffered on a plain booking request.
              if (alternative) {
                chosenEmployeeId = alternative.employeeId;
                effectiveDateISO = alternative.dateISO;
                effectiveStartMinutes = alternative.startMinutes;
                if (alternative.changed === "professional") {
                  // step 22 correction (B2): this branch keeps the day and
                  // the hour and changes WHO attends. Announcing it with
                  // OFFER_ALTERNATIVES told the caller three untruths at
                  // once: that the requested hour was not free (it is),
                  // that the "alternative" was the very same day and hour
                  // just declared unavailable, and — by saying nothing at
                  // all about it — that the professional had not changed.
                  // The phrase for exactly this case was already written
                  // and had never been emitted; this is its first and only
                  // call site.
                  professionalSubstituted = true;
                  ask("OFFER_ANOTHER_PROFESSIONAL", {
                    employeeId: alternative.employeeId,
                    professional: professionalLabel(cal, alternative.employeeId),
                  });
                } else {
                  ask("OFFER_ALTERNATIVES", {
                    alternatives: [{ day: alternative.dateISO, time: formatHHmm(alternative.startMinutes) }],
                  });
                }
                outcomePhraseParams = {
                  slots: [{ day: alternative.dateISO, time: formatHHmm(alternative.startMinutes) }],
                };
              } else {
                // Nothing reliable to offer for the exact request — see
                // this module's docblock on `findAlternative` and the
                // design decision recorded in the final report about
                // reusing SLOT_OUTSIDE_SYNTHETIC_SCHEDULE here rather than
                // inventing an 11th reasonCode outside the frozen
                // contract. The REAL cause (occupied vs. not capable) is
                // still recorded internally — see `recordSlotRejection`.
                slotUnresolvable = true;
                recordSlotRejection(resolved.reason ?? "occupied", dateISO, startMinutes);
              }
            }
          }

          if (collected.serviceId !== null && collected.serviceId !== undefined) {
            allocate(collected.serviceId);
          }

          if (!slotUnresolvable) {
            transition("CONFIRMACION_DE_SERVICIO");
            if (collected.serviceId === null || collected.serviceId === undefined || collected.serviceConfirmed !== true) {
              transition("ACLARAR_UNA_VEZ");
              ask("ASK_SERVICE_CONFIRMATION", { serviceId: collected.serviceId ?? null });
              const t = nextScriptTurn();
              transition("CONFIRMACION_DE_SERVICIO");
              checkMidCallShortCircuit(t);
            }

            // step 22 correction (B1): the gate just above is the FIRST
            // moment at which a caller who did not know their service can
            // have supplied one. If allocation never ran, run it now —
            // exactly the same allocation, with the same `slotUnresolvable`
            // / `recordSlotRejection` exit — before anything downstream can
            // announce, or write, a booking with nobody assigned.
            if (
              collected.serviceId !== null &&
              collected.serviceId !== undefined &&
              collected.serviceConfirmed === true &&
              chosenEmployeeId === undefined
            ) {
              allocate(collected.serviceId);
            }

            if (collected.serviceId === null || collected.serviceId === undefined || collected.serviceConfirmed !== true) {
              findings.push({ reasonCode: "SERVICE_NOT_CONFIRMED" });
            } else if (slotUnresolvable) {
              // Nothing left to offer for this request: the `allocate` call
              // right above already recorded the rejection and its cause.
            } else if (intent === "AVAILABILITY") {
              findings.push({ reasonCode: "AVAILABILITY_PROVIDED" });
              if (Object.keys(outcomePhraseParams).length === 0) {
                outcomePhraseParams = { slots: [{ day: effectiveDateISO, time: formatHHmm(effectiveStartMinutes) }] };
              }
            } else {
              // BOOK from here on.
              transition("CONFIRMACION_EXPLICITA_DE_RESERVA");
              if (collected.bookingConfirmed !== true) {
                transition("ACLARAR_UNA_VEZ");
                ask("ASK_BOOKING_CONFIRMATION", {
                  serviceId: collected.serviceId,
                  day: effectiveDateISO,
                  time: formatHHmm(effectiveStartMinutes),
                  // step 22 correction (B2): only when the professional is
                  // NOT the one the caller asked for — see
                  // `professionalSubstituted`.
                  ...(professionalSubstituted && chosenEmployeeId !== undefined
                    ? { employeeId: chosenEmployeeId, professional: professionalLabel(cal, chosenEmployeeId) }
                    : {}),
                });
                const t = nextScriptTurn();
                transition("CONFIRMACION_EXPLICITA_DE_RESERVA");
                checkMidCallShortCircuit(t);
              }

              if (collected.bookingConfirmed !== true) {
                // No dedicated reasonCode exists for "never gave the final
                // booking confirmation" in the frozen 10-code contract —
                // see (internal doc, not included in the template) and the A3/D2
                // fix in the final report. `bookingConfirmationNotObtained`
                // makes `finalize()` speak a DISTINCT, honest phrase for
                // this case instead of REASON_INTENT_NOT_UNDERSTOOD's "no
                // he conseguido entender qué necesitas", and a distinct
                // internal event marks it for a future console.
                bookingConfirmationNotObtained = true;
                findings.push({ reasonCode: "INTENT_NOT_UNDERSTOOD" });
                emitter.emitInternalEvent({
                  scenarioId: script.scenarioId,
                  callId: script.callId,
                  salt,
                  clock,
                  eventName: "BOOKING_CONFIRMATION_NOT_OBTAINED",
                });
              } else {
                transition("ESCRITURA_SINTETICA");
                // step 22 correction (B1), structural half: the two
                // `chosenEmployeeId as EmployeeId` casts that used to sit on
                // the next lines laundered `undefined` past the type system,
                // so the only thing standing between a missed allocation and
                // a reservation with no professional was the allocation
                // itself. The cast is gone and the check is explicit: no
                // professional, no write, and the real cause travels on the
                // internal stream like every other rejection.
                if (chosenEmployeeId === undefined) {
                  recordSlotRejection("no_professional_allocated", effectiveDateISO, effectiveStartMinutes);
                } else if (!isSlotFree(cal, chosenEmployeeId, effectiveDateISO, effectiveStartMinutes)) {
                  // Final, no-cache revalidation immediately before writing —
                  // never trust a previously computed/cached result (see
                  // calendar/resolveAvailability.ts's `isSlotFree` docblock).
                  recordSlotRejection("occupied", effectiveDateISO, effectiveStartMinutes);
                } else {
                  const endMinutes = effectiveStartMinutes + SLOT_MINUTES;
                  const newReservation: SyntheticReservation = {
                    id: `res-${callIdHash.slice(0, 16)}-${effectiveDateISO}-${effectiveStartMinutes}-${chosenEmployeeId}`,
                    employeeId: chosenEmployeeId,
                    serviceId: collected.serviceId,
                    date: effectiveDateISO,
                    startMinutes: effectiveStartMinutes,
                    endMinutes,
                    status: "confirmed",
                    callIdHash,
                    synthetic: true,
                  };
                  cal = store.addReservation(cal, newReservation);
                  reservationOut = newReservation;
                  emitter.emitInternalEvent({
                    scenarioId: script.scenarioId,
                    callId: script.callId,
                    salt,
                    clock,
                    eventName: "BOOKING_WRITTEN_SYNTHETIC",
                    detail: {
                      employeeId: newReservation.employeeId,
                      dateISO: newReservation.date,
                      startMinutes: newReservation.startMinutes,
                    },
                  });
                  findings.push({ reasonCode: "BOOKING_CONFIRMED" });
                }
              }
            }
          }
        }
      }
      // No `return finalize()` here — see the B4 correction note above and
      // the single call site after this try/catch.
    } catch (err) {
      if (err instanceof MaxTurnsExceededError) {
        findings.push({ reasonCode: "INTENT_NOT_UNDERSTOOD" });
      } else if (err instanceof SyntheticInjectedFailureError) {
        emitter.emitPilotEvent({
          scenarioId: script.scenarioId,
          callId: script.callId,
          salt,
          clock,
          eventName: "TECHNICAL_FAILURE",
        });
        emitter.emitInternalEvent({
          scenarioId: script.scenarioId,
          callId: script.callId,
          salt,
          clock,
          eventName: "ERROR_RAISED",
          detail: { errorLabel: errorLabel(err) },
        });
        findings.push({ reasonCode: "TECHNICAL_FAILURE" });
      } else if (err instanceof MidCallShortCircuitError) {
        // The relevant Finding was already pushed by
        // `checkMidCallShortCircuit` (via `shortCircuitForIntent`) before
        // this was thrown — nothing more to record here.
      } else {
        store.addError({
          id: `err-${callIdHash.slice(0, 12)}-${stateTrace.length}`,
          callIdHash,
          message: errorLabel(err),
          atISO: nowISO(),
        });
        emitter.emitPilotEvent({
          scenarioId: script.scenarioId,
          callId: script.callId,
          salt,
          clock,
          eventName: "TECHNICAL_FAILURE",
        });
        emitter.emitInternalEvent({
          scenarioId: script.scenarioId,
          callId: script.callId,
          salt,
          clock,
          eventName: "ERROR_RAISED",
          detail: { errorLabel: errorLabel(err) },
        });
        findings.push({ reasonCode: "TECHNICAL_FAILURE" });
      }
    }

    // Single call site — see the B4 correction note on `finalize()`.
    return finalize();
  } catch (outerErr) {
    void outerErr;
    // Absolute last resort — see the docblock immediately above this
    // try/catch. The emitter or the store itself is the suspect here, so
    // this path assumes nothing about them working.
    turns.length = 0;
    stateTrace.length = 0;
    currentState = "INICIO";

    // A TECHNICAL_FAILURE that leaves no trace is worse than the failure
    // itself: an operator cannot tell a fabricated one from a real one, and
    // has nothing to investigate. The security audit found exactly that —
    // every console-launched call collapsed here silently. Recording is
    // best-effort and never uses the raw error text (see the A6 correction),
    // because the store is one of the suspects on this path.
    try {
      store.addError({
        id: `err-${script.scenarioId}`,
        callIdHash: hashCallId(script.callId, salt),
        message: "UNEXPECTED_ENGINE_ERROR",
        atISO: clock.nowInstantISO(),
      });
    } catch {
      // Swallowed on purpose: see above.
    }

    // An orphaned synthetic reservation is possible here: the write
    // succeeded and then the emission collapsed, so a booking exists that
    // the customer was never told about. We do NOT delete it — a booking
    // that can vanish without trace is a worse affordance than one that
    // needs review, and the operator console exists precisely to surface
    // pending human actions. Instead we try, best-effort, to raise a human
    // task, and we report the mutation truthfully rather than hiding it.
    // The attempt is itself wrapped: if the store is the broken component,
    // failing to compensate must not replace one collapse with another.
    const orphanedReservation = reservationOut !== undefined;
    if (orphanedReservation) {
      try {
        store.addHumanTask({
          id: `orphan-${script.scenarioId}`,
          callIdHash: hashCallId(script.callId, salt),
          reason: "REVIEW_ORPHANED_SYNTHETIC_RESERVATION",
          createdAtISO: clock.nowInstantISO(),
        });
      } catch {
        // Swallowed on purpose: see above.
      }
    }

    return {
      scenarioId: script.scenarioId,
      outcome: "DERIVA",
      reasonCode: "TECHNICAL_FAILURE",
      // The last-resort path never reaches the confirmation gate's own
      // resolution, so the refinement is simply the frozen code itself.
      internalReasonCode: "TECHNICAL_FAILURE",
      announcesSuccess: false,
      externalMutation: false,
      syntheticMutation: orphanedReservation,
      requiresOperatorReview: orphanedReservation,
      finalState: currentState,
      stateTrace,
      turns,
      ...(reservationOut !== undefined ? { reservation: reservationOut } : {}),
    };
  }
}
