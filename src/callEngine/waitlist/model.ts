import type { EmployeeId, ProfessionalPreference, ServiceId } from "../domain/types.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 17 — WAITLIST DOMAIN MODEL (design §1.2/§1.3, normative document
 * (internal doc, not included in the template)).
 *
 * Pure types only: no clock read, no I/O, no state. Everything here is
 * synthetic demo data and never reaches a real system or a real person.
 *
 * HARD DEPENDENCY RULE (design §1.1, pinned by tests/callEngine/boundaries.test.ts):
 * `src/callEngine/waitlist/**` MAY import from `src/callEngine/**`; NO file
 * of `src/callEngine/**` outside `waitlist/` may import from `waitlist/`.
 * The waitlist is a CONSUMER of the engine, never a participant in the call.
 *
 * WHY THE CANCELLATION POLICY DOES NOT LIVE IN `OperationalCalendar`:
 * `minimumLeadMinutes` already means "minimum BOOKING lead time" and
 * `engine.ts` reads it. A second "lead time" in the same type would
 * guarantee that somebody one day reads the wrong one. The policy lives in
 * the `WaitlistStore`, under a deliberately different name
 * (`cancellationNoticeMinutes`), and `OperationalCalendar` is not touched at
 * all.
 *
 * WHY CANCELLING ADDS NO FIELD TO `SyntheticReservation`: that type is
 * consumed by `resolveAvailability` (level 7), `impact.ts`, `snapshot.ts`,
 * `memoryStore.ts` and twenty-odd tests. A cancellation is expressed as (a)
 * `status: "cancelled"` — a state that already exists — plus (b) a separate
 * `CancellationRecord` joined by `reservationId`.
 * ────────────────────────────────────────────────────────────────────────
 */

export type { ProfessionalPreference };

/**
 * The eight states of a waitlist entry (design §2.1).
 *
 * TERMINAL: only `converted` and `withdrawn`.
 * DORMANT (`declined`, `expired_manually`): inactive, but they leave that
 * state ONLY through an explicit operator command. Making `declined`
 * terminal would be deciding that a "no" erases the person from the list;
 * sending it back to `pending` on its own would be deciding that a "no"
 * keeps them waiting. Neither decision is approved: the system does not
 * decide, the operator does.
 *
 * The `_manually` suffix of `expired_manually` is part of the identifier ON
 * PURPOSE, so that nobody can reintroduce an automatic expiry without
 * renaming the state (design §2.3.5).
 */
export type WaitlistEntryState =
  | "pending"
  | "matched"
  | "notice_simulated"
  | "accepted"
  | "declined"
  | "expired_manually"
  | "converted"
  | "withdrawn";

/** Where the OPERATOR says the sign-up came from. NEVER claims the engine took it (design §14.2/§14.3). */
export type OptInSource = "phone_simulated" | "counter_simulated" | "operator_entered";

export interface WaitlistEntry {
  /** `"wl-0001"` for operator-created entries, `"wl-f01"` for the fixture seeds. */
  id: string;
  /** Synthetic label with no personal data: "Cliente A". Validated against the closed `^Cliente [A-Z]$` pattern (§8.4). */
  clientLabel: string;
  serviceId: ServiceId;
  /** "YYYY-MM-DD", inclusive. */
  dateFrom: string;
  /** "YYYY-MM-DD", inclusive. */
  dateTo: string;
  /** Multiple of `cal.slotMinutes`. */
  earliestStartMinutes: number;
  /** Multiple of `cal.slotMinutes`, strictly greater than `earliestStartMinutes`. */
  latestStartMinutes: number;
  professional: ProfessionalPreference;
  optInSource: OptInSource;
  /** Literal `true`: the type makes an entry without opt-in structurally impossible. */
  optInConfirmed: true;
  state: WaitlistEntryState;
  /** CREATION order. Reading order, never business priority (design §5.1). */
  createdSeq: number;
  createdAtISO: string;
  /**
   * The LIVE offer, when there is one. `offerStillValid` is deliberately NOT
   * stored: it is re-derived on every `buildSnapshot` (design §14.6), so a
   * cached "compatible" can never go stale behind the operator's back.
   */
  currentOffer?: { slotKey: string; cancellationId: string; offeredSeq: number };
  synthetic: true;
}

export type CancellationTimeliness = "on_time" | "late";
export type CancellationLatenessKind = "within_notice_window" | "already_started";

export type CancellationReasonCode =
  | "client_cancelled_by_phone_simulated"
  | "client_cancelled_at_counter_simulated"
  | "venue_cancelled_simulated"
  | "unspecified";

export const CANCELLATION_REASON_CODES: readonly CancellationReasonCode[] = [
  "client_cancelled_by_phone_simulated",
  "client_cancelled_at_counter_simulated",
  "venue_cancelled_simulated",
  "unspecified",
] as const;

export interface CancellationRecord {
  /** `"cxl-<reservationId>"` — natural key, exactly one per reservation. */
  id: string;
  reservationId: string;
  employeeId: EmployeeId;
  serviceId: ServiceId;
  date: string;
  startMinutes: number;
  endMinutes: number;
  reasonCode: CancellationReasonCode;
  /** Minutes between synthetic "now" and the start of the appointment. May be negative. */
  leadMinutes: number;
  /** The policy value AT THE MOMENT OF CANCELLING — frozen here, never re-read later (design §3.4). */
  policyMinutesAtCancellation: number;
  timeliness: CancellationTimeliness;
  latenessKind?: CancellationLatenessKind;
  /** `late` only. There is NEVER an automatic consequence (design §5.4). */
  reviewState?: "pending_review" | "reviewed_no_action";
  releasedSlotKeys: readonly string[];
  cancelledAtISO: string;
  cancelledBy: "console-operator";
  synthetic: true;
}

/**
 * step 23 §2 — WHERE A PROPOSAL COMES FROM.
 *
 * `system_first_compatible` is the ONLY automatic origin, and it is the rule
 * of §3 spelled out: first compatible entry by `createdSeq`. There is no
 * second automatic origin because there is no second rule — no score, no
 * seniority, no affinity, no heuristic (decision D23-2).
 */
export type ProposalOrigin = "system_first_compatible" | "operator_substitution";

/**
 * step 23 §2 — THE PROPOSAL, which belongs to the SLOT and not to the person.
 *
 * WHY IT CANNOT LIVE IN `WaitlistEntry.currentOffer`: offers are NOT exclusive.
 * `cancelReservation` gives a live offer to EVERY compatible entry that does
 * not already hold one, so two entries routinely carry an offer over the same
 * half hour (`tests/integration/competenciaPorElHueco.test.ts`). Storing the
 * approval on the offer would therefore allow two approved proposals for one
 * slot — exactly the thing the human loop exists to prevent. One slot, zero or
 * one proposal: the cardinality IS the guard.
 *
 * `status` is the ONLY stored state. Everything the operator reads (approved,
 * substituted, invalidated, declined, converted…) is DERIVED on each snapshot
 * from the entry's state and a fresh B1..B7 revalidation (design §4), exactly
 * like `offer.stillValid` has been derived since step 17 §14.6. A cached
 * "still valid" is a lie the operator could act on.
 *
 * The proposal LIVES AND DIES WITH THE SLOT: `releasedSlots` is the registry of
 * what is released NOW, it is de-duplicated by `key`, it is replaced in place
 * when the same half hour is freed again, and `reset()` empties it. So a
 * re-release discards the old proposal (which is correct: it belonged to a
 * different cancellation) and no new lifecycle, no new store field and no new
 * reset path exist anywhere.
 */
export interface SlotProposal {
  /** Who is proposed RIGHT NOW. */
  entryId: string;
  /**
   * Who the AUTOMATIC rule proposed, FIRST TIME, for this slot. A fact about
   * the automatic rule, and nothing else.
   *
   * (Reparación R-SUB) IT IS NOT "who was displaced", and it must never be used
   * again to work that out. The screen used to derive the substitution sentence
   * from `entryId !== automaticEntryId`, which is only true while nobody goes
   * back: A→B→A makes the two equal again (the card claimed "substituted" with
   * nobody substituted) and A→B→C names A, who lost nothing, instead of B. Who
   * just lost the proposal is the LAST `WAITLIST_PROPOSAL_SUBSTITUTED` event of
   * the slot and its `replacedEntryId` — written once, read by the projection,
   * never stored twice.
   */
  automaticEntryId: string;
  origin: ProposalOrigin;
  /** The ONLY stored state; the rest is derived (design §4). */
  status: "pending_approval" | "approved";
  proposedAtISO: string;
  /** Sealed the first time a person approves. Never re-stamped by a repeat. */
  decidedAtISO?: string;
}

/**
 * Why a live proposal stopped standing. The seven B1..B7 codes plus TWO of its
 * own, because neither of them is a compatibility failure and dressing them up
 * as one would be a lie on screen:
 *   · `entry_no_longer_active` — the entry left `{pending, matched}`. It is not
 *     "incompatible" with the slot, it is simply out of the running.
 *   · `offer_no_longer_on_this_slot` — the operator released the match. The
 *     person is still on the list and still fits; she is just no longer paired
 *     with this half hour, and §3.1 makes the pairing part of the proposal.
 */
export type ProposalInvalidReasonCode =
  | WaitlistMismatchReason
  | "entry_no_longer_active"
  | "offer_no_longer_on_this_slot";

export interface ReleasedSlot {
  /** `"slot-<date>-<startMinutes>-<employeeId>"`. */
  key: string;
  cancellationId: string;
  employeeId: EmployeeId;
  date: string;
  startMinutes: number;
  /** `startMinutes + cal.slotMinutes`. */
  endMinutes: number;
  /** step 23 §2. Zero or one, never two. Absent means "nobody is proposed". */
  proposal?: SlotProposal;
}

export interface CancellationPolicy {
  /** 0..1440. */
  cancellationNoticeMinutes: number;
  source: "demo_default" | "operator_set";
  changedAtISO?: string;
}

/** The demo default (design §3.3). NOT a policy approved by Demo Salon. */
export const DEFAULT_CANCELLATION_NOTICE_MINUTES = 120;

// ---------------------------------------------------------------------
// Compatibility mismatch reasons (design §4.1, steps B1..B7)
// ---------------------------------------------------------------------

/**
 * Why one entry does NOT fit one released slot. ALL applicable reasons are
 * collected — there is deliberately no short-circuit, because the operator
 * has the right to see every reason, not just the first one.
 */
export type WaitlistMismatchReason =
  | "date_outside_preferred_range"
  | "time_outside_preferred_window"
  | "different_professional_requested"
  | "professional_cannot_perform_service"
  | "date_outside_booking_horizon"
  | "slot_in_the_past"
  | "slot_no_longer_free";

export const WAITLIST_MISMATCH_REASONS: readonly WaitlistMismatchReason[] = [
  "date_outside_preferred_range",
  "time_outside_preferred_window",
  "different_professional_requested",
  "professional_cannot_perform_service",
  "date_outside_booking_horizon",
  "slot_in_the_past",
  "slot_no_longer_free",
] as const;

// ---------------------------------------------------------------------
// Audit log (design §1.3)
// ---------------------------------------------------------------------

export type WaitlistAuditKind =
  | "WAITLIST_ENTRY_CREATED"
  | "WAITLIST_OPT_IN_DECLINED"
  | "RESERVATION_CANCELLED_ON_TIME"
  | "RESERVATION_CANCELLED_LATE"
  | "LATE_CANCELLATION_REVIEWED"
  | "SLOT_RELEASED"
  | "SLOT_RELEASE_PRODUCED_NO_SLOTS"
  | "WAITLIST_MATCH_EVALUATED"
  /**
   * ONE ROW PER ENTRY MATCHED. `WAITLIST_MATCH_EVALUATED` records the
   * COUNTERS of an evaluation ("6 checked, 2 fit"), which is a fact about the
   * slot, not about anybody. Without this event the automatic `pending →
   * matched` step and the offer that comes with it left NO trace carrying an
   * `entryId`, so replaying the log could not reproduce the state of an entry
   * that had been matched (design criterion 4) — the log told the story in
   * Spanish but could not be checked against reality by machine. Added as a
   * post-review repair.
   */
  | "WAITLIST_ENTRY_MATCHED"
  | "WAITLIST_NOTICE_SIMULATED"
  | "WAITLIST_OFFER_ACCEPTED"
  | "WAITLIST_OFFER_DECLINED"
  | "WAITLIST_OFFER_RELEASED"
  | "WAITLIST_ENTRY_CONVERTED"
  | "WAITLIST_CONVERSION_CONFLICT"
  | "WAITLIST_CONVERSION_FAILED_INJECTED"
  | "WAITLIST_ENTRY_WITHDRAWN"
  | "WAITLIST_ENTRY_EXPIRED_MANUALLY"
  | "WAITLIST_ENTRY_REOPENED"
  | "CANCELLATION_POLICY_CHANGED"
  | "IDEMPOTENT_REPLAY"
  | "DEMO_RESET"
  /**
   * step 23 §6 — THE FIVE PROPOSAL EVENTS, appended AFTER the twenty-two of
   * step 17 on purpose: the inherited catalogue keeps its exact order, so the
   * frozen-contract test can still compare it literally, item by item.
   *
   * They travel in the SAME envelope (`WaitlistAuditEvent`, with the monotonic
   * `seq` this domain already owns). The canonical `EventoOperador` of the
   * step 21B note is deliberately NOT opened: this is a single-domain trail,
   * there is no cross-family merge, and none of the four conditions of that
   * note's §6 is met.
   *
   * None of the five carries `fromState`/`toState`: approving a proposal moves
   * no entry from one state to another (design §5.2). When a proposal repoints
   * an offer (§3.1), the event that carries the transition is the existing
   * `WAITLIST_ENTRY_MATCHED`.
   */
  | "WAITLIST_PROPOSAL_CREATED"
  | "WAITLIST_PROPOSAL_APPROVED"
  | "WAITLIST_PROPOSAL_SUBSTITUTED"
  | "WAITLIST_PROPOSAL_INVALIDATED"
  | "WAITLIST_PROPOSAL_NONE_AVAILABLE";

/**
 * THE relationship registry (cancellation → entry → notice → reservation) is
 * not a separate table: it IS this log. Every event carries the identifiers
 * it owns, and the chain is rebuilt by following
 * `cancellationId → slotKey → entryId → noticeId → newReservationId`. The
 * snapshot DERIVES a `trace` object per entry; it is never stored twice, so
 * the two cannot diverge.
 *
 * WHY NOT `emitInternalEvent`: `events/schema.ts` requires a `callId` (which
 * is hashed) and a `scenarioId` matching `^A[0-9]{2}[-a-z0-9]+$`. An operator
 * action has no call; inventing one would contaminate a stream designed for
 * calls and would falsify `eventCounts.internal`.
 */
export interface WaitlistAuditEvent {
  /** `"wla-00000001"`. */
  id: string;
  /** Monotonic and unique; this is what orders the story. */
  seq: number;
  kind: WaitlistAuditKind;
  actor: "operator" | "system" | "reset";
  /** Injected synthetic clock. */
  atISO: string;
  entryId?: string;
  reservationId?: string;
  cancellationId?: string;
  slotKey?: string;
  noticeId?: string;
  newReservationId?: string;
  fromState?: WaitlistEntryState;
  toState?: WaitlistEntryState;
  detail?: Record<string, string | number | boolean>;
  synthetic: true;
}

/**
 * An audit event before the store stamps it with `id`/`seq`. Command
 * handlers are pure and therefore cannot mint a monotonic sequence; the
 * store does that, in one synchronous commit.
 */
export type WaitlistAuditDraft = Omit<WaitlistAuditEvent, "id" | "seq">;

// ---------------------------------------------------------------------
// Small pure helpers over the slot key — the ONE place that knows its shape.
// ---------------------------------------------------------------------

export function slotKeyFor(dateISO: string, startMinutes: number, employeeId: EmployeeId): string {
  return `slot-${dateISO}-${String(startMinutes)}-${String(employeeId)}`;
}

export interface ParsedSlotKey {
  date: string;
  startMinutes: number;
  employeeId: EmployeeId;
}

const SLOT_KEY_RE = /^slot-(\d{4}-\d{2}-\d{2})-(\d+)-(-?\d+)$/;

export function parseSlotKey(key: string): ParsedSlotKey | null {
  const m = SLOT_KEY_RE.exec(key);
  if (!m) return null;
  const date = m[1];
  const start = m[2];
  const employee = m[3];
  if (date === undefined || start === undefined || employee === undefined) return null;
  return { date, startMinutes: Number(start), employeeId: Number(employee) };
}

/** `"cxl-<reservationId>"` — the natural key of a cancellation. */
export function cancellationIdFor(reservationId: string): string {
  return `cxl-${reservationId}`;
}

/**
 * The id of the synthetic reservation a conversion creates. Deterministic
 * and derived from the intention, so a repeated conversion of the same entry
 * into the same slot could never mint two different ids.
 */
export function waitlistReservationIdFor(entryId: string, slot: ReleasedSlot): string {
  return `res-wl-${entryId}-${slot.date}-${String(slot.startMinutes)}-${String(slot.employeeId)}`;
}

/** The id of the simulated notice. Simulated: nothing is ever sent to anybody (design §5.5). */
export function noticeIdFor(entryId: string, offeredSeq: number): string {
  return `aviso-${entryId}-${String(offeredSeq)}`;
}

// ---------------------------------------------------------------------
// State machine (design §2.2/§2.3)
// ---------------------------------------------------------------------

/** Commands the operator can issue against ONE entry (`convert` has its own endpoint). */
export type WaitlistEntryCommand =
  | "simulate_notice"
  | "record_acceptance"
  | "record_decline"
  | "release_match"
  | "withdraw"
  | "expire_manually"
  | "reopen"
  /** step 23 §5. Neither of the two moves an entry from one state to another. */
  | "approve_proposal"
  | "take_over_proposal";

/** The seven commands of step 17: the ones that carry no slot in the body. */
export type WaitlistEntryCommandWithoutSlot = Exclude<
  WaitlistEntryCommand,
  "approve_proposal" | "take_over_proposal"
>;

/**
 * step 23 §5 — WHAT `applyEntryCommand` RECEIVES.
 *
 * The two new commands carry a MANDATORY `slotKey`, and the type is what makes
 * that structurally true rather than merely validated: a proposal is approved
 * BY ITS SLOT, never "whichever proposal this person happens to have". A stale
 * screen therefore cannot approve a proposal that has already moved to the
 * sibling slot — it can only fail with `slot_not_found` or
 * `proposal_targets_another_entry`, both of them truthful.
 */
export type WaitlistEntryCommandInput =
  | { command: WaitlistEntryCommandWithoutSlot }
  | { command: "approve_proposal"; slotKey: string }
  | { command: "take_over_proposal"; slotKey: string };

/** Terminal states: only `reset` gets an entry out of one. */
export const TERMINAL_ENTRY_STATES: readonly WaitlistEntryState[] = ["converted", "withdrawn"] as const;

/** States that are still evaluated against a newly released slot. */
export const MATCHABLE_ENTRY_STATES: readonly WaitlistEntryState[] = ["pending", "matched"] as const;

/**
 * THE closed command × state table (design §2.2). `convert` is included for
 * `accepted` because the operator interface has to know that converting is
 * the available action there — the interface NEVER decides what can be done,
 * it reads it from here, through the snapshot's `availableCommands`.
 *
 * Every transition forbidden by §2.3 is unreachable simply because it is
 * absent from this table, and `applyEntryCommand` refuses anything not
 * listed. `pending → accepted`, `pending → notice_simulated`,
 * `matched → converted` and any transition out of a terminal state have no
 * row here and no other code path.
 */
/**
 * step 23 §5 adds exactly TWO cells to this table and NOT ONE new transition.
 * `approve_proposal` is offered from `matched` (the state an entry is in when a
 * proposal points at it) and `take_over_proposal` also from `pending`, because
 * substituting somebody who has no offer yet is precisely the case the
 * substitution exists for — and §3.1 gives them the offer in the same act.
 */
export const AVAILABLE_COMMANDS_BY_STATE: Readonly<Record<WaitlistEntryState, readonly string[]>> = {
  pending: ["withdraw", "expire_manually", "take_over_proposal"],
  matched: ["simulate_notice", "release_match", "withdraw", "expire_manually", "approve_proposal", "take_over_proposal"],
  notice_simulated: ["record_acceptance", "record_decline", "release_match", "withdraw", "expire_manually"],
  accepted: ["convert", "withdraw", "expire_manually"],
  declined: ["reopen", "withdraw"],
  expired_manually: ["reopen"],
  converted: [],
  withdrawn: [],
};

export function isCommandAllowed(state: WaitlistEntryState, command: WaitlistEntryCommand): boolean {
  return AVAILABLE_COMMANDS_BY_STATE[state].includes(command);
}
