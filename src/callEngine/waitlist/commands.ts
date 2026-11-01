import type { CalendarWithCapabilities } from "../capabilities.js";
import type { SyntheticReservation } from "../calendar/model.js";
import { daysBetween } from "../domain/time.js";
import type { Clock, ServiceId } from "../domain/types.js";
import { assertNoPersonalData } from "../events/schema.js";
import type {
  CommandOutcome as EngineCommandOutcome,
  ConsoleTaskRequest,
  EngineSideEffects,
} from "../shared/commandOutcome.js";
import { isSlotFree } from "../calendar/resolveAvailability.js";
import {
  entryAlreadyAnsweringSlot,
  evaluateReleasedSlot,
  matchEntryAgainstSlot,
  proposalCandidatesFor,
  proposalStanding,
  releasedSlotsFrom,
} from "./matching.js";
import {
  AVAILABLE_COMMANDS_BY_STATE,
  cancellationIdFor,
  isCommandAllowed,
  noticeIdFor,
  waitlistReservationIdFor,
  type CancellationPolicy,
  type CancellationReasonCode,
  type CancellationRecord,
  type OptInSource,
  type ProfessionalPreference,
  type ProposalInvalidReasonCode,
  type ReleasedSlot,
  type SlotProposal,
  type WaitlistAuditDraft,
  type WaitlistEntry,
  type WaitlistEntryCommandInput,
  type WaitlistEntryState,
} from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 17 — PURE COMMAND HANDLERS (design §6.1, §14.5).
 *
 * Every handler in this file is a PURE function: it reads a context and
 * returns the COMPLETE description of what should be written, without
 * writing anything and without awaiting anything. The caller (src/console/
 * server.ts) applies the whole description in ONE synchronous tick.
 *
 * THAT IS THE ANTI-HALF-WRITE RULE (design §14.5): `nextCal`, `nextEntries`,
 * `events` and `tasks` are built as local values and committed at the end,
 * synchronously, with NO `await` in between. Node serves one request per
 * tick, so there is no window between revalidating and writing. The only way
 * to write half a change would be an `await` in the middle — which is
 * exactly why this layer cannot contain one: it is not async at all.
 *
 * There is no `setTimeout`, no `setInterval`, no `Date.now()`, no
 * `Math.random()` anywhere: the clock is always injected.
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Context and result shapes
// ---------------------------------------------------------------------

export interface WaitlistCommandContext {
  cal: CalendarWithCapabilities;
  clock: Clock;
  entries: readonly WaitlistEntry[];
  cancellations: readonly CancellationRecord[];
  releasedSlots: readonly ReleasedSlot[];
  policy: CancellationPolicy;
  /** Sequence the store owns; a pure handler cannot mint it for itself. */
  nextEntryNumber: number;
  /** Ditto: the running count of offers ever made, so notice ids stay unique. */
  nextOfferSeq: number;
}

/**
 * A human task to enqueue. Ids are DETERMINISTIC so a double command cannot
 * duplicate a task (design §7.3).
 *
 * step 18 §4.7: the shape MOVED to `shared/commandOutcome.ts` as
 * `ConsoleTaskRequest`, because the operations side hands the console exactly
 * the same thing. The old name survives as an alias so nothing that already
 * spelled it this way has to change; it is the same type, not a copy.
 */
export type WaitlistTaskRequest = ConsoleTaskRequest;

/**
 * The complete, atomic description of a write. `null` fields mean "leave
 * this alone". Nothing else in this module ever mutates anything.
 *
 * step 18 §4.7: the neutral half (`nextCal`, the reservations to mirror in
 * the `MemoryStore`, the human queue) now comes from `EngineSideEffects`,
 * shared with `operations/`, and its two reservation fields are ARRAYS. It is
 * a pure widening: every step 17 path fills an array of exactly one element,
 * `[x]` means what `x` meant, and no inherited behaviour changes.
 */
export interface WaitlistWrite extends EngineSideEffects {
  entries?: readonly WaitlistEntry[];
  cancellations?: readonly CancellationRecord[];
  releasedSlots?: readonly ReleasedSlot[];
  policy?: CancellationPolicy;
  events: readonly WaitlistAuditDraft[];
  /** How many entry ids this command consumed (0 or 1). */
  entriesMinted?: number;
  /** How many offers this command minted. */
  offersMinted?: number;
}

/**
 * step 18 §4.7: the envelope is the SHARED generic one, instantiated with
 * this feature's write. The name and the shape stay exactly as step 17 left
 * them — keeping a byte-identical private copy here would have been the "two
 * ways of saying the same thing" the design rejects.
 */
export type CommandOutcome = EngineCommandOutcome<WaitlistWrite>;

// ---------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------

function findEntry(entries: readonly WaitlistEntry[], entryId: string): WaitlistEntry | undefined {
  return entries.find((e) => e.id === entryId);
}

function replaceEntry(entries: readonly WaitlistEntry[], updated: WaitlistEntry): WaitlistEntry[] {
  return entries.map((e) => (e.id === updated.id ? updated : e));
}

/** Drops `currentOffer` — the offer is no longer live. Never mutates the input. */
function withoutOffer(entry: WaitlistEntry, state: WaitlistEntryState): WaitlistEntry {
  const { currentOffer: _dropped, ...rest } = entry;
  return { ...rest, state };
}

function entryNotFound(entryId: string): CommandOutcome {
  return {
    status: 404,
    body: { error: "No existe ninguna entrada de lista de espera con ese identificador.", code: "entry_not_found", entryId },
    write: null,
  };
}

function stateNotAllowed(entry: WaitlistEntry, command: string): CommandOutcome {
  return {
    status: 409,
    body: {
      conflict: "entry_state_not_allowed",
      fromState: entry.state,
      command,
      allowedCommands: AVAILABLE_COMMANDS_BY_STATE[entry.state],
    },
    write: null,
  };
}

/** The deterministic id of the "decide who gets this slot" task (design §7.3). */
export function decideSlotTaskId(slotKey: string): string {
  return `decidir-hueco-${slotKey}`;
}

/** The deterministic id of the "review a late cancellation" task (design §7.3). */
export function lateReviewTaskId(reservationId: string): string {
  return `revision-tardia-${reservationId}`;
}

/** The deterministic id of the "a slot was taken before converting" task (design §7.3). */
export function conversionConflictTaskId(entryId: string): string {
  return `conflicto-conversion-${entryId}`;
}

// ---------------------------------------------------------------------
// createWaitlistEntry (design §6.1)
// ---------------------------------------------------------------------

export interface CreateEntryInput {
  clientLabel: string;
  serviceId: ServiceId;
  dateFrom: string;
  dateTo: string;
  earliestStartMinutes: number;
  latestStartMinutes: number;
  professional: ProfessionalPreference;
  optInSource: OptInSource;
  optInConfirmed: true;
}

function badRequest(message: string): CommandOutcome {
  return { status: 400, body: { error: message }, write: null };
}

/**
 * Records a sign-up the OPERATOR took. The interface never claims the voice
 * agent did it (design §14.2/§14.3): `optInSource` says where it came from,
 * and that is all this system asserts.
 *
 * WHAT IS DELIBERATELY NOT VALIDATED: whether the preference can ever be
 * satisfied. An impossible entry is legitimate operator data, and telling
 * somebody "that is never going to happen" would be a prediction this system
 * does not make (design §6.1, decision J15).
 */
export function createWaitlistEntry(ctx: WaitlistCommandContext, input: CreateEntryInput): CommandOutcome {
  const { cal, clock } = ctx;
  if (input.dateTo < input.dateFrom) {
    return badRequest("La fecha final no puede ser anterior a la inicial.");
  }
  if (input.latestStartMinutes <= input.earliestStartMinutes) {
    return badRequest("La hora final de la franja tiene que ser posterior a la inicial.");
  }
  if (input.earliestStartMinutes % cal.slotMinutes !== 0 || input.latestStartMinutes % cal.slotMinutes !== 0) {
    return badRequest(`Las horas de la franja tienen que ir en tramos de ${String(cal.slotMinutes)} minutos.`);
  }
  const preference = input.professional;
  if (preference.kind === "specific" && !cal.professionals.some((p) => p.employeeId === preference.employeeId)) {
    return badRequest("Ese profesional no existe en el calendario sintético.");
  }

  const id = `wl-${String(ctx.nextEntryNumber).padStart(4, "0")}`;
  const createdSeq = ctx.entries.length === 0 ? 1 : Math.max(...ctx.entries.map((e) => e.createdSeq)) + 1;
  const entry: WaitlistEntry = {
    id,
    clientLabel: input.clientLabel,
    serviceId: input.serviceId,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    earliestStartMinutes: input.earliestStartMinutes,
    latestStartMinutes: input.latestStartMinutes,
    professional: input.professional,
    optInSource: input.optInSource,
    optInConfirmed: true,
    state: "pending",
    createdSeq,
    createdAtISO: clock.nowInstantISO(),
    synthetic: true,
  };

  const event: WaitlistAuditDraft = {
    kind: "WAITLIST_ENTRY_CREATED",
    actor: "operator",
    atISO: clock.nowInstantISO(),
    entryId: id,
    detail: {
      serviceId: input.serviceId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      earliest: input.earliestStartMinutes,
      latest: input.latestStartMinutes,
      professionalKind: input.professional.kind,
      optInSource: input.optInSource,
    },
    synthetic: true,
  };

  return {
    status: 201,
    body: { entry },
    viewEntryId: id,
    write: { entries: [...ctx.entries, entry], events: [event], entriesMinted: 1 },
  };
}

// ---------------------------------------------------------------------
// declineOptIn (design §6.1)
// ---------------------------------------------------------------------

/**
 * A Spanish national phone number written without an international prefix:
 * nine digits starting with 6, 7, 8 or 9, optionally broken up by spaces,
 * dots or hyphens. `assertNoPersonalData` (events/schema.ts, a FROZEN file)
 * only rejects numbers written with a leading `+`, on the deliberate ground
 * that a general "long run of digits" rule would trip over a SHA-256 hash —
 * a correct decision for the event streams, where hashes abound. Here there
 * are no hashes: `note` is 200 characters of operator prose, so this narrow,
 * anchored shape can be refused as well.
 *
 * IT DOES NOT LOOK FOR NAMES, and nothing here or on screen claims it does.
 * Detecting a real name in free text is not a thing this or any regular
 * expression can do; promising it would be the exact kind of unearned
 * guarantee this project refuses to make (post-review repair, defect 3).
 */
const SPANISH_NATIONAL_PHONE_RE = /(?<![\d])[6-9](?:[ .\-]?\d){8}(?![\d])/;

/**
 * Records that somebody was ASKED and said no. It creates NO entry, on
 * purpose: keeping a "shadow" entry for a person who declined is exactly the
 * implicit opt-in this mission forbids.
 *
 * The only free-text field of the whole feature (`note`, 200 chars) is passed
 * through `assertNoPersonalData` — the SAME scanner the pilot event emitter
 * uses — and then through `SPANISH_NATIONAL_PHONE_RE`, before it is stored:
 * an email, an international phone number or a nine-digit Spanish mobile
 * typed in by mistake is rejected loudly instead of being kept quietly.
 */
export function declineOptIn(
  ctx: WaitlistCommandContext,
  input: { clientLabel: string; note?: string },
): CommandOutcome {
  try {
    assertNoPersonalData({ detail: { clientLabel: input.clientLabel, ...(input.note !== undefined ? { note: input.note } : {}) } });
  } catch {
    return badRequest("La nota no puede contener datos personales (teléfonos ni correos electrónicos).");
  }
  if (input.note !== undefined && SPANISH_NATIONAL_PHONE_RE.test(input.note)) {
    return badRequest("La nota no puede contener datos personales (teléfonos ni correos electrónicos).");
  }

  const event: WaitlistAuditDraft = {
    kind: "WAITLIST_OPT_IN_DECLINED",
    actor: "operator",
    atISO: ctx.clock.nowInstantISO(),
    detail: { clientLabel: input.clientLabel, ...(input.note !== undefined ? { note: input.note } : {}) },
    synthetic: true,
  };
  return { status: 200, body: { recorded: true }, singleAuditEventIdField: "auditEventId", write: { events: [event] } };
}

// ---------------------------------------------------------------------
// cancelReservation (design §3, §4, §6.1)
// ---------------------------------------------------------------------

export interface CancelReservationInput {
  reservationId: string;
  reasonCode: CancellationReasonCode;
}

export interface TimelinessVerdict {
  leadMinutes: number;
  timeliness: "on_time" | "late";
  latenessKind?: "within_notice_window" | "already_started";
}

/**
 * THE POLICY BOUNDARY (design §3.1/§3.2). Deterministic, on the injected
 * synthetic clock, with `daysBetween` taken from `domain/time.ts` — no new
 * date arithmetic is written anywhere in this feature.
 *
 * THE BOUNDARY IS INCLUSIVE ON `on_time`: exactly 120 minutes of notice IS
 * within the deadline. That is the natural Spanish reading of "avisar con al
 * menos dos horas", and the screen says it literally: "Dentro de plazo =
 * avisar con 120 minutos o más de antelación."
 */
export function evaluateTimeliness(
  clock: Clock,
  reservation: { date: string; startMinutes: number },
  policyMinutes: number,
): TimelinessVerdict {
  const leadMinutes = daysBetween(clock.nowISODate(), reservation.date) * 1440 + reservation.startMinutes - clock.nowMinutes();
  if (leadMinutes < 0) {
    return { leadMinutes, timeliness: "late", latenessKind: "already_started" };
  }
  if (leadMinutes >= policyMinutes) {
    return { leadMinutes, timeliness: "on_time" };
  }
  return { leadMinutes, timeliness: "late", latenessKind: "within_notice_window" };
}

// ---------------------------------------------------------------------
// step 23 §3 — (RE)EVALUATION OF PROPOSALS. Pure, conservative, closed.
// ---------------------------------------------------------------------

/**
 * The three triggers of design §3.2, and there are no others. The value also
 * travels in `detail.trigger` of `WAITLIST_PROPOSAL_CREATED`, so "the proposal
 * was re-evaluated" (D23-5) is readable in the trail without inventing a sixth
 * `kind`.
 */
export type ProposalTrigger = "cancellation" | "conversion_sibling" | "proposal_ended";

interface ProposalPass {
  entries: readonly WaitlistEntry[];
  releasedSlots: readonly ReleasedSlot[];
  events: readonly WaitlistAuditDraft[];
  /** How many offers this pass minted, so the store's counter stays honest. */
  offersMinted: number;
}

/** Canonical slot order (design §11): `(date, startMinutes, employeeId)`. */
function bySlotOrder(a: ReleasedSlot, b: ReleasedSlot): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
  return a.employeeId - b.employeeId;
}

function withoutProposal(slot: ReleasedSlot): ReleasedSlot {
  const { proposal: _dropped, ...rest } = slot;
  return rest;
}

/**
 * THE ONE PLACE a proposal is created, retired or replaced (design §3.2).
 *
 * IT IS DELIBERATELY CONSERVATIVE. A slot whose proposal still STANDS is left
 * completely alone: not reordered, not re-pointed at somebody else, and never
 * un-approved. The function only fills a slot that has no proposal, or repairs
 * one that has provably ended. That is what makes T1, T2 and T3 idempotent by
 * construction — running the same trigger twice over the same world changes
 * nothing the second time — and it is what makes "substituting a candidate in
 * silence" (D23-3) structurally impossible rather than merely discouraged.
 *
 * NOTHING ELSE RE-EVALUATES. Polling does not (a projection does not mutate),
 * there is no timer and no background work. Between two triggers an ended
 * proposal is SHOWN as invalidated, with its reason, and stays that way.
 *
 * `excludeEntryId` is how T3 keeps its promise. The four commands that fire it
 * (`record_decline`, `release_match`, `withdraw`, `expire_manually`) are the
 * operator saying "not this person on this slot, not now". Three of them take
 * the entry out of `{pending, matched}` and R1 drops it by itself; the fourth,
 * `release_match`, leaves it `pending` and compatible, so without this
 * exclusion the very same tick would propose the same person again and quietly
 * undo the command the operator had just issued.
 */
function reevaluateProposals(input: {
  cal: CalendarWithCapabilities;
  clock: Clock;
  entries: readonly WaitlistEntry[];
  releasedSlots: readonly ReleasedSlot[];
  slotKeys: readonly string[];
  trigger: ProposalTrigger;
  atISO: string;
  nextOfferSeq: number;
  excludeEntryId?: string;
}): ProposalPass {
  const { cal, clock, trigger, atISO } = input;
  let entries: readonly WaitlistEntry[] = input.entries;
  let releasedSlots: readonly ReleasedSlot[] = input.releasedSlots;
  const events: WaitlistAuditDraft[] = [];
  let offerSeq = input.nextOfferSeq;

  const targets = releasedSlots.filter((s) => input.slotKeys.includes(s.key)).slice().sort(bySlotOrder);

  for (const target of targets) {
    // Always re-read the slot: an earlier iteration of this same pass may have
    // written a proposal on it, and the registry is what the rule reads.
    const found = releasedSlots.find((s) => s.key === target.key);
    if (found === undefined) continue;
    let slot: ReleasedSlot = found;

    const previous = slot.proposal;
    if (previous !== undefined) {
      const standing = proposalStanding(cal, clock, entries, slot);
      if (standing.stands) continue;
      events.push({
        kind: "WAITLIST_PROPOSAL_INVALIDATED",
        actor: "system",
        atISO,
        entryId: previous.entryId,
        slotKey: slot.key,
        cancellationId: slot.cancellationId,
        detail: { trigger, reasons: standing.reasons.join(",") },
        synthetic: true,
      });
      slot = withoutProposal(slot);
      releasedSlots = releasedSlots.map((s) => (s.key === slot.key ? slot : s));
    }

    const candidates = proposalCandidatesFor(cal, clock, entries, releasedSlots, slot).filter(
      (e) => e.id !== input.excludeEntryId,
    );
    const chosen = candidates[0];

    if (chosen === undefined) {
      // In T1 this silence is already reported by `WAITLIST_MATCH_EVALUATED`
      // ("6 comprobadas, 0 encajan"); a second row saying the same thing would
      // be noise. In T2/T3 there is no such row, and a slot that quietly stops
      // having anybody proposed would otherwise be a hole in the story.
      if (trigger !== "cancellation" && isSlotFree(cal, slot.employeeId, slot.date, slot.startMinutes)) {
        events.push({
          kind: "WAITLIST_PROPOSAL_NONE_AVAILABLE",
          actor: "system",
          atISO,
          slotKey: slot.key,
          cancellationId: slot.cancellationId,
          detail: { trigger },
          synthetic: true,
        });
      }
      continue;
    }

    // §3.1 — re-point the offer, and ONLY when it is legitimate. R1 (c) has
    // already refused any candidate holding a valid offer elsewhere, so at this
    // point the entry has no offer, has this one, or has a provably dead one.
    if (chosen.currentOffer?.slotKey !== slot.key) {
      const repointed: WaitlistEntry = {
        ...chosen,
        state: chosen.state === "pending" ? "matched" : chosen.state,
        currentOffer: { slotKey: slot.key, cancellationId: slot.cancellationId, offeredSeq: offerSeq },
      };
      entries = replaceEntry(entries, repointed);
      events.push({
        kind: "WAITLIST_ENTRY_MATCHED",
        actor: "system",
        atISO,
        entryId: chosen.id,
        cancellationId: slot.cancellationId,
        slotKey: slot.key,
        fromState: chosen.state,
        toState: repointed.state,
        detail: { offeredSeq: offerSeq },
        synthetic: true,
      });
      offerSeq += 1;
    }

    const proposal: SlotProposal = {
      entryId: chosen.id,
      automaticEntryId: chosen.id,
      origin: "system_first_compatible",
      status: "pending_approval",
      proposedAtISO: atISO,
    };
    slot = { ...slot, proposal };
    releasedSlots = releasedSlots.map((s) => (s.key === slot.key ? slot : s));
    events.push({
      kind: "WAITLIST_PROPOSAL_CREATED",
      actor: "system",
      atISO,
      entryId: chosen.id,
      slotKey: slot.key,
      cancellationId: slot.cancellationId,
      detail: {
        trigger,
        ...(previous !== undefined && previous.entryId !== chosen.id ? { replacedEntryId: previous.entryId } : {}),
      },
      synthetic: true,
    });
  }

  return { entries, releasedSlots, events, offersMinted: offerSeq - input.nextOfferSeq };
}

export function cancelReservation(ctx: WaitlistCommandContext, input: CancelReservationInput): CommandOutcome {
  const { cal, clock } = ctx;
  const reservation = cal.reservations.find((r) => r.id === input.reservationId);
  if (reservation === undefined) {
    return {
      status: 404,
      body: { error: "No existe ninguna cita con ese identificador.", code: "reservation_not_found" },
      write: null,
    };
  }
  if (reservation.status === "cancelled") {
    return { status: 409, body: { conflict: "reservation_already_cancelled", reservationId: reservation.id }, write: null };
  }

  const policyMinutes = ctx.policy.cancellationNoticeMinutes;
  const verdict = evaluateTimeliness(clock, reservation, policyMinutes);
  const cancellationId = cancellationIdFor(reservation.id);
  const atISO = clock.nowInstantISO();

  // The calendar AFTER the cancellation — the ONLY calendar the released
  // slots are computed from (design §4.1, phase A).
  const nextCal: CalendarWithCapabilities = {
    ...cal,
    reservations: cal.reservations.map((r) => (r.id === reservation.id ? { ...r, status: "cancelled" as const } : r)),
  };

  const released = releasedSlotsFrom(nextCal, reservation, cancellationId);

  const events: WaitlistAuditDraft[] = [];
  const tasksToAdd: WaitlistTaskRequest[] = [];

  const cancellation: CancellationRecord = {
    id: cancellationId,
    reservationId: reservation.id,
    employeeId: reservation.employeeId,
    serviceId: reservation.serviceId,
    date: reservation.date,
    startMinutes: reservation.startMinutes,
    endMinutes: reservation.endMinutes,
    reasonCode: input.reasonCode,
    leadMinutes: verdict.leadMinutes,
    policyMinutesAtCancellation: policyMinutes,
    timeliness: verdict.timeliness,
    ...(verdict.latenessKind !== undefined ? { latenessKind: verdict.latenessKind } : {}),
    ...(verdict.timeliness === "late" ? { reviewState: "pending_review" as const } : {}),
    releasedSlotKeys: released.map((s) => s.key),
    cancelledAtISO: atISO,
    cancelledBy: "console-operator",
    synthetic: true,
  };

  events.push({
    kind: verdict.timeliness === "on_time" ? "RESERVATION_CANCELLED_ON_TIME" : "RESERVATION_CANCELLED_LATE",
    actor: "operator",
    atISO,
    reservationId: reservation.id,
    cancellationId,
    detail: {
      leadMinutes: verdict.leadMinutes,
      policyMinutes,
      ...(verdict.latenessKind !== undefined ? { latenessKind: verdict.latenessKind } : {}),
    },
    synthetic: true,
  });

  // A late cancellation produces a review task and NOTHING else. No
  // penalty, no block, no refusal — design §5.4 and decision J5.
  if (verdict.timeliness === "late") {
    tasksToAdd.push({ id: lateReviewTaskId(reservation.id), reason: "REVIEW_LATE_CANCELLATION", createdAtISO: atISO });
  }

  if (released.length === 0) {
    events.push({
      kind: "SLOT_RELEASE_PRODUCED_NO_SLOTS",
      actor: "system",
      atISO,
      reservationId: reservation.id,
      cancellationId,
      detail: { reason: "venue_closed_or_no_free_slot" },
      synthetic: true,
    });
  }

  // THE REGISTRY OF WHAT IS RELEASED NOW, built BEFORE the per-slot loop
  // because the proposal rule of §3 reads it whole: condition (c) asks whether
  // a candidate holds a valid offer over ANOTHER slot, and condition (d)
  // whether they are already the subject of another slot's standing proposal.
  //
  // ONE RECORD PER PHYSICAL SLOT (post-review repair, defect 4). The same
  // `slotKey` can be released more than once in a session: a slot is freed,
  // converted into a synthetic reservation, and that reservation is then
  // cancelled from the Agenda, which frees the very same half hour again.
  // `releasedSlots` is the registry of WHAT IS RELEASED NOW, not a history —
  // the history is the audit log, and it keeps every `SLOT_RELEASED` event
  // untouched. Appending blindly made one physical slot appear as two
  // records, and everything downstream believed it: the screen painted two
  // identical actionable cards for the same half hour, `traceOf` resolved the
  // key with `find` and could therefore attribute an entry to the OLD
  // cancellation (a false provenance), and `unfilledReleasedSlotMinutes`
  // counted 60 minutes of unfilled agenda where there were 30 — a metric that
  // lies, which this mission forbids.
  //
  // The newest release WINS, in the old record's place: the most recent
  // cancellation is the true provenance of the slot that is free right now,
  // and substituting in place keeps the block's order stable so a card does
  // not jump between two 2-second polls. Deduplicating here rather than in
  // the projection is deliberate: with one registry, the cards, `trace` and
  // the metrics CANNOT disagree with each other. step 23: because the new
  // record replaces the old one whole, a re-release also DISCARDS the old
  // proposal — which is right, it belonged to a different cancellation.
  const releasedByKey = new Map(released.map((s) => [s.key, s]));
  const alreadyKnown = new Set(ctx.releasedSlots.map((s) => s.key));
  let nextReleasedSlots: readonly ReleasedSlot[] = [
    ...ctx.releasedSlots.map((s) => releasedByKey.get(s.key) ?? s),
    ...released.filter((s) => !alreadyKnown.has(s.key)),
  ];

  let nextEntries: readonly WaitlistEntry[] = [...ctx.entries];
  let offerSeq = ctx.nextOfferSeq;
  const matches: Array<{
    slotKey: string;
    compatibleEntryIds: readonly string[];
    incompatible: readonly { entryId: string; reasons: readonly string[] }[];
  }> = [];

  for (const slot of released) {
    events.push({
      kind: "SLOT_RELEASED",
      actor: "system",
      atISO,
      cancellationId,
      slotKey: slot.key,
      reservationId: reservation.id,
      synthetic: true,
    });

    const evaluation = evaluateReleasedSlot(nextCal, clock, nextEntries, slot);
    events.push({
      kind: "WAITLIST_MATCH_EVALUATED",
      actor: "system",
      atISO,
      cancellationId,
      slotKey: slot.key,
      detail: { evaluated: evaluation.evaluated, compatible: evaluation.compatibleEntryIds.length },
      synthetic: true,
    });

    matches.push({
      slotKey: slot.key,
      compatibleEntryIds: evaluation.compatibleEntryIds,
      incompatible: evaluation.incompatible.map((i) => ({ entryId: i.entryId, reasons: i.reasons })),
    });

    // The offer is attached to the FIRST slot an entry fits (slots are in
    // ascending start order). An entry holds at most one live offer; the
    // other slots still list it as compatible, because it genuinely is.
    //
    // EVERY ONE OF THESE STEPS WRITES ITS OWN EVENT (`WAITLIST_ENTRY_MATCHED`),
    // in this same tick. `WAITLIST_MATCH_EVALUATED` above only counts; without
    // a per-entry row carrying `entryId`, `fromState` and `toState`, replaying
    // the log could not reproduce that this person ended up `matched` (design
    // criterion 4). Post-review repair.
    for (const entryId of evaluation.compatibleEntryIds) {
      const current = findEntry(nextEntries, entryId);
      if (current === undefined || current.currentOffer !== undefined) continue;
      nextEntries = replaceEntry(nextEntries, {
        ...current,
        state: "matched",
        currentOffer: { slotKey: slot.key, cancellationId, offeredSeq: offerSeq },
      });
      events.push({
        kind: "WAITLIST_ENTRY_MATCHED",
        actor: "system",
        atISO,
        entryId,
        cancellationId,
        slotKey: slot.key,
        fromState: current.state,
        toState: "matched",
        detail: { offeredSeq: offerSeq },
        synthetic: true,
      });
      offerSeq += 1;
    }

    // NO task when nobody fits: a "decide who gets this slot" task with an
    // empty list would be an errand with nothing to do (design §10, #5).
    if (evaluation.compatibleEntryIds.length > 0) {
      tasksToAdd.push({ id: decideSlotTaskId(slot.key), reason: "DECIDE_WAITLIST_MATCH", createdAtISO: atISO });
    }

    // T1 (step 23 §3.2) — the proposal of THIS slot, decided right after the
    // slot has been evaluated and its offers written, so the rule reads the
    // world as it actually is at that instant. Running it here, inside the
    // loop and in ascending slot order, is what makes the demo's sibling case
    // come out right: 13:00 and 13:30 are both free, both `f01` and `f02` hold
    // a live offer over 13:00, so 13:30 has no candidate and gets NO proposal
    // — and nobody is quietly moved off a slot that still fits them.
    const pass = reevaluateProposals({
      cal: nextCal,
      clock,
      entries: nextEntries,
      releasedSlots: nextReleasedSlots,
      slotKeys: [slot.key],
      trigger: "cancellation",
      atISO,
      nextOfferSeq: offerSeq,
    });
    nextEntries = pass.entries;
    nextReleasedSlots = pass.releasedSlots;
    events.push(...pass.events);
    offerSeq += pass.offersMinted;
  }

  return {
    status: 200,
    body: {
      cancellation,
      releasedSlots: released,
      matches,
      humanTaskIds: tasksToAdd.map((t) => t.id),
    },
    write: {
      entries: nextEntries,
      cancellations: [...ctx.cancellations, cancellation],
      releasedSlots: nextReleasedSlots,
      events,
      offersMinted: offerSeq - ctx.nextOfferSeq,
      nextCal,
      reservationsToCancel: [reservation.id],
      tasksToAdd,
    },
  };
}

// ---------------------------------------------------------------------
// reviewCancellation (design §6.1)
// ---------------------------------------------------------------------

/**
 * The ONLY decision available is "reviewed, no action". Deliberately: no
 * other consequence of a late cancellation is approved (design §5.4, J5).
 */
export function reviewCancellation(ctx: WaitlistCommandContext, reservationId: string): CommandOutcome {
  const cancellation = ctx.cancellations.find((c) => c.reservationId === reservationId);
  if (cancellation === undefined) {
    return {
      status: 404,
      body: { error: "No hay ninguna cancelación registrada para esa cita.", code: "cancellation_not_found" },
      write: null,
    };
  }
  if (cancellation.timeliness !== "late") {
    return { status: 409, body: { conflict: "cancellation_not_late" }, write: null };
  }
  if (cancellation.reviewState === "reviewed_no_action") {
    return { status: 409, body: { conflict: "already_reviewed" }, write: null };
  }

  const updated: CancellationRecord = { ...cancellation, reviewState: "reviewed_no_action" };
  const event: WaitlistAuditDraft = {
    kind: "LATE_CANCELLATION_REVIEWED",
    actor: "operator",
    atISO: ctx.clock.nowInstantISO(),
    reservationId,
    cancellationId: cancellation.id,
    synthetic: true,
  };
  return {
    status: 200,
    body: { cancellation: updated },
    write: {
      cancellations: ctx.cancellations.map((c) => (c.id === cancellation.id ? updated : c)),
      events: [event],
      tasksToComplete: [lateReviewTaskId(reservationId)],
    },
  };
}

// ---------------------------------------------------------------------
// applyEntryCommand (design §2.2, §6.1)
// ---------------------------------------------------------------------

function offerSlot(ctx: WaitlistCommandContext, entry: WaitlistEntry): ReleasedSlot | undefined {
  if (entry.currentOffer === undefined) return undefined;
  return ctx.releasedSlots.find((s) => s.key === entry.currentOffer?.slotKey);
}

/**
 * Re-derives the validity of a live offer FROM SCRATCH (B1..B7). Never
 * cached, never trusted from a previous poll — see design §14.6.
 */
export function revalidateOffer(ctx: WaitlistCommandContext, entry: WaitlistEntry): { slot: ReleasedSlot; reasons: string[] } | null {
  const slot = offerSlot(ctx, entry);
  if (slot === undefined) return null;
  return { slot, reasons: matchEntryAgainstSlot(ctx.cal, ctx.clock, entry, slot) };
}

/**
 * step 23 §3.2, T3 — the four commands that END a proposal, and the write
 * that follows from re-evaluating the ONE slot that proposal was on.
 *
 * The entry has already been moved to its new state by the caller; this reads
 * the world AFTER that, which is why an entry that has just declined or been
 * withdrawn is no longer a candidate for itself.
 */
function proposalEndedWrite(
  ctx: WaitlistCommandContext,
  entryId: string,
  entriesAfter: readonly WaitlistEntry[],
  atISO: string,
): { entries: readonly WaitlistEntry[]; releasedSlots?: readonly ReleasedSlot[]; events: readonly WaitlistAuditDraft[]; offersMinted: number } {
  // (Revisión adversarial de step 23, H2) TODOS los huecos que la proponían,
  // no el primero. §3.2 dice «ese único hueco» porque R1(d) promete que nadie
  // es sujeto de dos propuestas a la vez; pero una propuesta ya invalidada
  // sigue en su hueco hasta que un disparador la repare, y R1(d) sólo mira las
  // vivas, así que la misma persona sí puede figurar en dos huecos —uno con la
  // propuesta viva y otro con una muerta—. Reparar sólo el primero dejaba al
  // otro con una propuesta hacia alguien que ya no está y sin ningún
  // disparador que fuera a tocarla nunca. `reevaluateProposals` ordena y es
  // idempotente, así que pasarle la lista entera no cambia nada más.
  const slots = ctx.releasedSlots.filter((s) => s.proposal?.entryId === entryId);
  if (slots.length === 0) return { entries: entriesAfter, events: [], offersMinted: 0 };
  const pass = reevaluateProposals({
    cal: ctx.cal,
    clock: ctx.clock,
    entries: entriesAfter,
    releasedSlots: ctx.releasedSlots,
    slotKeys: slots.map((s) => s.key),
    trigger: "proposal_ended",
    atISO,
    nextOfferSeq: ctx.nextOfferSeq,
    excludeEntryId: entryId,
  });
  return {
    entries: pass.entries,
    releasedSlots: pass.releasedSlots,
    events: pass.events,
    offersMinted: pass.offersMinted,
  };
}

/**
 * step 23 §5.4 — the DOMAIN idempotency of the two new commands, which is the
 * one that matters: repeating an approval that is already exactly this, for
 * exactly this slot, returns 200 with an identical body and writes NOTHING —
 * not a second event, not a second `decidedAtISO`. Transport idempotency
 * (`Idempotency-Key`) sits on top of it and is not a substitute for it: a
 * second click from a second tab carries no key at all.
 */
function proposalUnchanged(entry: WaitlistEntry, slot: ReleasedSlot): CommandOutcome {
  return { status: 200, body: { entry, slotKey: slot.key, proposal: slot.proposal }, viewEntryId: entry.id, write: null };
}

export function applyEntryCommand(
  ctx: WaitlistCommandContext,
  entryId: string,
  input: WaitlistEntryCommandInput,
): CommandOutcome {
  const command = input.command;
  const entry = findEntry(ctx.entries, entryId);
  if (entry === undefined) return entryNotFound(entryId);
  if (!isCommandAllowed(entry.state, command)) return stateNotAllowed(entry, command);

  const atISO = ctx.clock.nowInstantISO();

  switch (command) {
    case "simulate_notice": {
      const revalidated = revalidateOffer(ctx, entry);
      if (revalidated === null || revalidated.reasons.length > 0) {
        return {
          status: 409,
          body: { conflict: "offer_no_longer_valid", reasons: revalidated?.reasons ?? ["slot_no_longer_free"] },
          write: null,
        };
      }
      // R2 (step 23 §5.2). Simulating a notice is the first act of this loop
      // that PRETENDS TO REACH A PERSON, and it now demands that a human has
      // backed this exact candidate for this exact slot. Approving is NOT
      // modelled as `matched → notice_simulated` on purpose: if approving
      // triggered the notice, the system would be simulating a contact as the
      // consequence of an approval click — the very thing D23-3 forbids — and
      // two different human facts ("I back this candidate" and "I have already
      // warned them") would be fused into one. The trail would lie.
      //
      // For free, this is also the guard that stops two people being warned
      // about the same half hour: the proposal is unique per slot.
      const proposal = revalidated.slot.proposal;
      if (proposal === undefined || proposal.entryId !== entryId || proposal.status !== "approved") {
        return { status: 409, body: { conflict: "proposal_not_approved", slotKey: revalidated.slot.key }, write: null };
      }
      const offeredSeq = entry.currentOffer?.offeredSeq ?? 0;
      const next: WaitlistEntry = { ...entry, state: "notice_simulated" };
      return {
        status: 200,
        body: { entry: next },
        viewEntryId: entryId,
        write: {
          entries: replaceEntry(ctx.entries, next),
          events: [
            {
              kind: "WAITLIST_NOTICE_SIMULATED",
              actor: "operator",
              atISO,
              entryId,
              slotKey: revalidated.slot.key,
              noticeId: noticeIdFor(entryId, offeredSeq),
              fromState: entry.state,
              toState: "notice_simulated",
              synthetic: true,
            },
          ],
        },
      };
    }

    case "record_acceptance": {
      const revalidated = revalidateOffer(ctx, entry);
      if (revalidated === null || revalidated.reasons.length > 0) {
        return {
          status: 409,
          body: { conflict: "offer_no_longer_valid", reasons: revalidated?.reasons ?? ["slot_no_longer_free"] },
          write: null,
        };
      }
      // Decision J4: the SECOND acceptance of the same slot is refused. No
      // queue, no "reservation on hold", no automatic ranking.
      const alreadyAccepted = ctx.entries.some(
        (e) => e.id !== entry.id && e.state === "accepted" && e.currentOffer?.slotKey === revalidated.slot.key,
      );
      if (alreadyAccepted) {
        return { status: 409, body: { conflict: "slot_already_accepted_by_another_entry", slotKey: revalidated.slot.key }, write: null };
      }
      const next: WaitlistEntry = { ...entry, state: "accepted" };
      return {
        status: 200,
        body: { entry: next },
        viewEntryId: entryId,
        write: {
          entries: replaceEntry(ctx.entries, next),
          events: [
            {
              kind: "WAITLIST_OFFER_ACCEPTED",
              actor: "operator",
              atISO,
              entryId,
              slotKey: revalidated.slot.key,
              fromState: entry.state,
              toState: "accepted",
              synthetic: true,
            },
          ],
        },
      };
    }

    case "record_decline": {
      const slotKey = entry.currentOffer?.slotKey;
      const next = withoutOffer(entry, "declined");
      const ended = proposalEndedWrite(ctx, entryId, replaceEntry(ctx.entries, next), atISO);
      return {
        status: 200,
        body: { entry: next },
        viewEntryId: entryId,
        write: {
          entries: ended.entries,
          ...(ended.releasedSlots !== undefined ? { releasedSlots: ended.releasedSlots } : {}),
          events: [
            {
              kind: "WAITLIST_OFFER_DECLINED",
              actor: "operator",
              atISO,
              entryId,
              ...(slotKey !== undefined ? { slotKey } : {}),
              fromState: entry.state,
              toState: "declined",
              synthetic: true,
            },
            ...ended.events,
          ],
          offersMinted: ended.offersMinted,
        },
      };
    }

    case "release_match": {
      const slotKey = entry.currentOffer?.slotKey;
      const next = withoutOffer(entry, "pending");
      const ended = proposalEndedWrite(ctx, entryId, replaceEntry(ctx.entries, next), atISO);
      return {
        status: 200,
        body: { entry: next },
        viewEntryId: entryId,
        write: {
          entries: ended.entries,
          ...(ended.releasedSlots !== undefined ? { releasedSlots: ended.releasedSlots } : {}),
          events: [
            {
              kind: "WAITLIST_OFFER_RELEASED",
              actor: "operator",
              atISO,
              entryId,
              ...(slotKey !== undefined ? { slotKey } : {}),
              fromState: entry.state,
              toState: "pending",
              synthetic: true,
            },
            ...ended.events,
          ],
          offersMinted: ended.offersMinted,
        },
      };
    }

    case "withdraw":
    case "expire_manually": {
      const toState: WaitlistEntryState = command === "withdraw" ? "withdrawn" : "expired_manually";
      const next = withoutOffer(entry, toState);
      const ended = proposalEndedWrite(ctx, entryId, replaceEntry(ctx.entries, next), atISO);
      return {
        status: 200,
        body: { entry: next },
        viewEntryId: entryId,
        write: {
          entries: ended.entries,
          ...(ended.releasedSlots !== undefined ? { releasedSlots: ended.releasedSlots } : {}),
          events: [
            {
              kind: command === "withdraw" ? "WAITLIST_ENTRY_WITHDRAWN" : "WAITLIST_ENTRY_EXPIRED_MANUALLY",
              actor: "operator",
              atISO,
              entryId,
              fromState: entry.state,
              toState,
              synthetic: true,
            },
            ...ended.events,
          ],
          offersMinted: ended.offersMinted,
        },
      };
    }

    case "reopen": {
      const next = withoutOffer(entry, "pending");
      return {
        status: 200,
        body: { entry: next },
        viewEntryId: entryId,
        write: {
          entries: replaceEntry(ctx.entries, next),
          events: [
            {
              kind: "WAITLIST_ENTRY_REOPENED",
              actor: "operator",
              atISO,
              entryId,
              fromState: entry.state,
              toState: "pending",
              synthetic: true,
            },
          ],
        },
      };
    }

    // -----------------------------------------------------------------
    // step 23 §5 — the two commands of the human loop. NEITHER of them
    // moves an entry from one state to another by itself.
    // -----------------------------------------------------------------

    case "approve_proposal": {
      const slot = ctx.releasedSlots.find((s) => s.key === input.slotKey);
      if (slot === undefined) {
        return { status: 409, body: { conflict: "slot_not_found", slotKey: input.slotKey }, write: null };
      }
      const proposal = slot.proposal;
      if (proposal === undefined) {
        return { status: 409, body: { conflict: "no_proposal_for_slot", slotKey: slot.key }, write: null };
      }
      if (proposal.entryId !== entryId) {
        return {
          status: 409,
          body: { conflict: "proposal_targets_another_entry", slotKey: slot.key },
          write: null,
        };
      }
      const standing = proposalStanding(ctx.cal, ctx.clock, ctx.entries, slot);
      if (!standing.stands) {
        return {
          status: 409,
          body: { conflict: "proposal_no_longer_valid", slotKey: slot.key, reasons: standing.reasons },
          write: null,
        };
      }
      // §5.4 — the SECOND identical approval is a no-op with a 200, not a
      // second approval: no second event, and `decidedAtISO` keeps the instant
      // the first person actually decided.
      if (proposal.status === "approved") return proposalUnchanged(entry, slot);

      const approved: SlotProposal = { ...proposal, status: "approved", decidedAtISO: atISO };
      const nextSlot: ReleasedSlot = { ...slot, proposal: approved };
      return {
        status: 200,
        body: { entry, slotKey: slot.key, proposal: approved },
        viewEntryId: entryId,
        write: {
          releasedSlots: ctx.releasedSlots.map((s) => (s.key === slot.key ? nextSlot : s)),
          events: [
            {
              kind: "WAITLIST_PROPOSAL_APPROVED",
              actor: "operator",
              atISO,
              entryId,
              slotKey: slot.key,
              cancellationId: slot.cancellationId,
              synthetic: true,
            },
          ],
        },
      };
    }

    case "take_over_proposal": {
      const slot = ctx.releasedSlots.find((s) => s.key === input.slotKey);
      if (slot === undefined) {
        return { status: 409, body: { conflict: "slot_not_found", slotKey: input.slotKey }, write: null };
      }
      // (Revisión adversarial de step 23, H1) EL HUECO POR EL QUE YA SE HA
      // AVISADO A ALGUIEN NO SE REASIGNA. La sustitución de §5.1 sólo mueve un
      // puntero mientras la propuesta no haya salido de la pantalla; en cuanto
      // una persona ha sido avisada —o ha aceptado, o ha convertido— sobre este
      // medio hora, mover el puntero dejaría a DOS personas `notice_simulated`
      // por el mismo hueco, que es exactamente lo que §5.2 dice que R2 impide,
      // y el rastro escribiría «{Cliente X} sigue en la lista» de alguien que
      // está a un clic de convertir ese mismo hueco: una frase falsa.
      //
      // Es un rechazo, no una reparación silenciosa: deshacer un aviso ya dado
      // es una decisión humana, y para eso están `record_decline`,
      // `release_match` o `withdraw` sobre la persona avisada, que además
      // disparan T3 y reofertan el hueco con su razón escrita (§3.2).
      const answering = entryAlreadyAnsweringSlot(ctx.entries, slot);
      if (answering !== undefined && answering.id !== entryId) {
        return {
          status: 409,
          body: {
            conflict: "proposal_already_notified_or_accepted",
            slotKey: slot.key,
            notifiedEntryId: answering.id,
            entryState: answering.state,
          },
          write: null,
        };
      }
      const reasons = matchEntryAgainstSlot(ctx.cal, ctx.clock, entry, slot);
      if (reasons.length > 0) {
        return {
          status: 409,
          body: { conflict: "entry_not_compatible_with_slot", slotKey: slot.key, reasons },
          write: null,
        };
      }
      // §3.1 — a substitution may not STEAL a live offer. If this person is
      // genuinely matched to another half hour that still fits them, moving
      // their offer here would take that away without anybody being told.
      const held = entry.currentOffer;
      if (held !== undefined && held.slotKey !== slot.key) {
        const other = ctx.releasedSlots.find((s) => s.key === held.slotKey);
        if (other !== undefined && matchEntryAgainstSlot(ctx.cal, ctx.clock, entry, other).length === 0) {
          return {
            status: 409,
            body: { conflict: "entry_holds_valid_offer_on_another_slot", slotKey: slot.key, heldSlotKey: other.key },
            write: null,
          };
        }
      }

      const previous = slot.proposal;
      // §5.4 — taking over in favour of whoever is ALREADY the approved
      // proposal changes nothing and writes nothing.
      if (previous !== undefined && previous.entryId === entryId && previous.status === "approved") {
        return proposalUnchanged(entry, slot);
      }

      const events: WaitlistAuditDraft[] = [];
      let nextEntries: readonly WaitlistEntry[] = ctx.entries;
      let offersMinted = 0;

      // (Revisión adversarial de step 23, H2) R1(d) TAMBIÉN AQUÍ: nadie es
      // sujeto de dos propuestas a la vez. La condición (d) de R1 sólo se
      // evaluaba en el camino automático, así que el operador podía darle a la
      // misma persona el hueco de las 13:00 y el de las 13:30, y al retirarse
      // ella T3 reparaba uno y el otro se quedaba con una propuesta muerta que
      // ningún disparador iba a tocar.
      //
      // Cualquier otra propuesta que apunte a esta persona está PROBADAMENTE
      // muerta en este punto: una viva exige que su oferta viva esté sobre ese
      // otro hueco (§3.1 de `proposalStanding`), y ese caso ya ha salido por
      // `entry_holds_valid_offer_on_another_slot` unas líneas más arriba. Así
      // que se retira y SE ESCRIBE por qué —con la razón real, la de antes de
      // mover nada—, en vez de dejar el hueco en el rastro. No se reevalúa ese
      // hueco: los disparadores son los tres de §3.2 y no se añade un cuarto.
      const abandonadas = ctx.releasedSlots.filter((s) => s.key !== slot.key && s.proposal?.entryId === entryId);
      for (const otra of abandonadas) {
        const standing = proposalStanding(ctx.cal, ctx.clock, ctx.entries, otra);
        events.push({
          kind: "WAITLIST_PROPOSAL_INVALIDATED",
          actor: "system",
          atISO,
          entryId,
          slotKey: otra.key,
          cancellationId: otra.cancellationId,
          detail: { trigger: "operator_substitution", reasons: standing.reasons.join(",") },
          synthetic: true,
        });
      }

      // §5.1 — the substitution APPROVES in the same act. Asking the operator
      // to approve their own choice would be theatre, and the screen labels it
      // «Aprobada — elegida por el operador» so nobody reads it as the system's
      // suggestion. The displaced person loses NOTHING: their offer stays live
      // (offers are not exclusive), they stay on the list and they stay a
      // candidate for the sibling slot. Only the proposal pointer moves.
      if (entry.currentOffer?.slotKey !== slot.key) {
        const repointed: WaitlistEntry = {
          ...entry,
          state: entry.state === "pending" ? "matched" : entry.state,
          currentOffer: { slotKey: slot.key, cancellationId: slot.cancellationId, offeredSeq: ctx.nextOfferSeq },
        };
        nextEntries = replaceEntry(ctx.entries, repointed);
        events.push({
          kind: "WAITLIST_ENTRY_MATCHED",
          actor: "operator",
          atISO,
          entryId,
          cancellationId: slot.cancellationId,
          slotKey: slot.key,
          fromState: entry.state,
          toState: repointed.state,
          detail: { offeredSeq: ctx.nextOfferSeq },
          synthetic: true,
        });
        offersMinted = 1;
      }

      const proposal: SlotProposal = {
        entryId,
        automaticEntryId: previous?.automaticEntryId ?? entryId,
        origin: "operator_substitution",
        status: "approved",
        proposedAtISO: previous?.proposedAtISO ?? atISO,
        decidedAtISO: atISO,
      };
      // Only say "in place of" when somebody was actually displaced. With no
      // previous proposal — or with the same person already proposed — the
      // honest sentence is the approval one.
      const displaced = previous !== undefined && previous.entryId !== entryId ? previous.entryId : undefined;
      events.push({
        kind: displaced !== undefined ? "WAITLIST_PROPOSAL_SUBSTITUTED" : "WAITLIST_PROPOSAL_APPROVED",
        actor: "operator",
        atISO,
        entryId,
        slotKey: slot.key,
        cancellationId: slot.cancellationId,
        ...(displaced !== undefined ? { detail: { replacedEntryId: displaced } } : {}),
        synthetic: true,
      });

      const nextSlot: ReleasedSlot = { ...slot, proposal };
      const abandonadasKeys = abandonadas.map((s) => s.key);
      return {
        status: 200,
        body: { entry: findEntry(nextEntries, entryId) ?? entry, slotKey: slot.key, proposal },
        viewEntryId: entryId,
        write: {
          entries: nextEntries,
          releasedSlots: ctx.releasedSlots.map((s) =>
            s.key === slot.key ? nextSlot : abandonadasKeys.includes(s.key) ? withoutProposal(s) : s,
          ),
          events,
          offersMinted,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------
// convertToReservation (design §6.1, §14.5)
// ---------------------------------------------------------------------

export interface ConvertInput {
  entryId: string;
  slotKey: string;
  injectFailure?: boolean;
}

/**
 * The one command that writes a synthetic reservation. The sequence is
 * SYNCHRONOUS AND UNINTERRUPTED: read entry → state must be `accepted` →
 * the live offer must be this exact slot → REVALIDATE B1..B7 FROM ZERO →
 * injected failure → build the reservation → hand the whole write back to
 * the caller, which commits it in one tick.
 *
 * A conflict (409) writes NO reservation and NO success event. It does write
 * the conflict event and it does move the entry back to `pending` clearing
 * its dead offer — that is the one documented state change of the conflict
 * path (design criterion 11), and it exists so the screen cannot keep
 * showing an offer that is provably gone.
 */
export function convertToReservation(ctx: WaitlistCommandContext, input: ConvertInput): CommandOutcome {
  const entry = findEntry(ctx.entries, input.entryId);
  if (entry === undefined) return entryNotFound(input.entryId);

  const slot = ctx.releasedSlots.find((s) => s.key === input.slotKey);
  if (slot === undefined) {
    return { status: 409, body: { conflict: "slot_not_found", slotKey: input.slotKey }, write: null };
  }
  if (entry.state !== "accepted") return stateNotAllowed(entry, "convert");
  if (entry.currentOffer?.slotKey !== input.slotKey) {
    return { status: 409, body: { conflict: "entry_not_matched_to_this_slot", slotKey: input.slotKey }, write: null };
  }

  const atISO = ctx.clock.nowInstantISO();
  const reasons = matchEntryAgainstSlot(ctx.cal, ctx.clock, entry, slot);
  if (reasons.length > 0) {
    const next = withoutOffer(entry, "pending");
    return {
      status: 409,
      body: {
        applied: false,
        conflict: "slot_no_longer_free",
        revalidation: { reasons },
        entryState: "pending",
      },
      write: {
        entries: replaceEntry(ctx.entries, next),
        events: [
          {
            kind: "WAITLIST_CONVERSION_CONFLICT",
            actor: "system",
            atISO,
            entryId: entry.id,
            slotKey: slot.key,
            cancellationId: slot.cancellationId,
            fromState: entry.state,
            toState: "pending",
            detail: { reasons: reasons.join(",") },
            synthetic: true,
          },
        ],
        tasksToAdd: [
          {
            id: conversionConflictTaskId(entry.id),
            reason: "REVIEW_WAITLIST_CONVERSION_CONFLICT",
            createdAtISO: atISO,
          },
        ],
      },
    };
  }

  // The injected failure happens AFTER revalidation and BEFORE any write, so
  // the demo can prove that a failure writes nothing at all: no reservation
  // in `cal`, none in the MemoryStore, and not one entry changed.
  if (input.injectFailure === true) {
    return {
      status: 500,
      body: {
        applied: false,
        code: "synthetic_injected_failure",
        error: "Fallo sintético inyectado. No se ha escrito nada.",
      },
      write: {
        events: [
          {
            kind: "WAITLIST_CONVERSION_FAILED_INJECTED",
            actor: "system",
            atISO,
            entryId: entry.id,
            slotKey: slot.key,
            synthetic: true,
          },
        ],
      },
    };
  }

  const reservation: SyntheticReservation = {
    id: waitlistReservationIdFor(entry.id, slot),
    employeeId: slot.employeeId,
    serviceId: entry.serviceId,
    date: slot.date,
    startMinutes: slot.startMinutes,
    endMinutes: slot.startMinutes + ctx.cal.slotMinutes,
    status: "confirmed",
    synthetic: true,
  };
  const next: WaitlistEntry = { ...entry, state: "converted" };
  const nextCal: CalendarWithCapabilities = { ...ctx.cal, reservations: [...ctx.cal.reservations, reservation] };

  // T2 (step 23 §3.2) — the SIBLING slots: those of the same cancellation
  // that are still free. This is what makes the demo's 13:30 stop being a mute
  // card. While `f01` held a live offer over 13:00, `f02` did too, so 13:30 had
  // no candidate at all (§3.1). The moment `f01` genuinely converts, `f02`'s
  // offer over 13:00 is provably dead, `f02` becomes the first compatible
  // candidate for 13:30 — and gets ITS OWN proposal, pending ITS OWN approval.
  // Nothing is auto-approved and nobody is warned by this.
  const siblings = ctx.releasedSlots
    .filter((s) => s.cancellationId === slot.cancellationId && s.key !== slot.key)
    .filter((s) => isSlotFree(nextCal, s.employeeId, s.date, s.startMinutes))
    .map((s) => s.key);
  const sibling = reevaluateProposals({
    cal: nextCal,
    clock: ctx.clock,
    entries: replaceEntry(ctx.entries, next),
    releasedSlots: ctx.releasedSlots,
    slotKeys: siblings,
    trigger: "conversion_sibling",
    atISO,
    nextOfferSeq: ctx.nextOfferSeq,
  });

  return {
    status: 200,
    body: { applied: true, entry: next, reservation },
    viewEntryId: entry.id,
    write: {
      entries: sibling.entries,
      releasedSlots: sibling.releasedSlots,
      offersMinted: sibling.offersMinted,
      events: [
        {
          kind: "WAITLIST_ENTRY_CONVERTED",
          actor: "operator",
          atISO,
          entryId: entry.id,
          slotKey: slot.key,
          cancellationId: slot.cancellationId,
          newReservationId: reservation.id,
          fromState: entry.state,
          toState: "converted",
          synthetic: true,
        },
        ...sibling.events,
      ],
      nextCal,
      reservationsToAdd: [reservation],
      // A "decide who gets this slot" task left open after converting would
      // be a lie: the decision has been taken (design §7.3).
      tasksToComplete: [decideSlotTaskId(slot.key)],
    },
  };
}

// ---------------------------------------------------------------------
// setCancellationPolicy (design §3.3, §6.1)
// ---------------------------------------------------------------------

/**
 * Changes the demo value. It NEVER re-evaluates past cancellations: every
 * `CancellationRecord` froze `policyMinutesAtCancellation`, so changing the
 * policy cannot rewrite the past (design §3.4).
 */
export function setCancellationPolicy(ctx: WaitlistCommandContext, minutes: number): CommandOutcome {
  const from = ctx.policy.cancellationNoticeMinutes;
  const atISO = ctx.clock.nowInstantISO();
  const policy: CancellationPolicy = {
    cancellationNoticeMinutes: minutes,
    source: "operator_set",
    changedAtISO: atISO,
  };
  return {
    status: 200,
    body: { policy },
    write: {
      policy,
      events: [
        {
          kind: "CANCELLATION_POLICY_CHANGED",
          actor: "operator",
          atISO,
          detail: { from, to: minutes },
          synthetic: true,
        },
      ],
    },
  };
}

/** The audit event a replayed idempotent request writes (design §6.2). */
export function idempotentReplayEvent(clock: Clock, route: string, key: string): WaitlistAuditDraft {
  return {
    kind: "IDEMPOTENT_REPLAY",
    actor: "system",
    atISO: clock.nowInstantISO(),
    detail: { route, key },
    synthetic: true,
  };
}
