import { canPerform, type CalendarWithCapabilities } from "../capabilities.js";
import type { SyntheticReservation } from "../calendar/model.js";
import { freeSlotStarts, isSlotFree, isWithinHorizon } from "../calendar/resolveAvailability.js";
import { isStartInThePast } from "../domain/slotTime.js";
import type { Clock } from "../domain/types.js";
import {
  MATCHABLE_ENTRY_STATES,
  slotKeyFor,
  type ProposalInvalidReasonCode,
  type ReleasedSlot,
  type WaitlistEntry,
  type WaitlistMismatchReason,
} from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 17 — COMPATIBILITY entry ↔ released slot (design §4).
 *
 * 100% PURE: every function here is a pure function of its arguments. No
 * clock is read (one is always injected), no state is kept, nothing is
 * cached. Design criterion 1 pins that: running `evaluateReleasedSlot`
 * three times with the same inputs must produce byte-identical output.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (design §4.2, said out loud on screen):
 *   1. It does NOT search the whole agenda. It only evaluates the slot that
 *      was just released.
 *   2. It checks NOTHING about the client: no history, no no-shows, no
 *      deposits, no "deserves it". None of that exists in this model.
 *   3. It does not check the client's real availability: the declared time
 *      window is the only signal there is.
 *   4. It does not look at special services (colouring and the like): they
 *      are outside the 0/1/2 catalogue, as everywhere else in the engine.
 *   5. It does not chain. Converting one entry re-evaluates nothing else.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * PHASE A (design §4.1) — the slots a cancellation actually releases.
 *
 * `calAfter` MUST already carry the reservation as `cancelled`: the whole
 * point is to ask the engine, on the updated calendar, which starts are now
 * free. `freeSlotStarts` is reused verbatim, so the waitlist can never
 * announce a slot the engine itself does not recognise.
 *
 * A2 is what honestly resolves the fixture's 60-minute appointments: they
 * release TWO 30-minute slots. A1 is what resolves scenario 17: if the venue
 * does not open that day, `freeSlotStarts` returns `[]` and no slot is
 * released at all — the screen then says "that day the venue does not open"
 * instead of inventing an opening.
 */
export function releasedSlotsFrom(
  calAfter: CalendarWithCapabilities,
  reservation: SyntheticReservation,
  cancellationId: string,
): ReleasedSlot[] {
  const free = freeSlotStarts(calAfter, reservation.employeeId, reservation.date);
  const released = free.filter((s) => s >= reservation.startMinutes && s < reservation.endMinutes);
  return released
    .slice()
    .sort((a, b) => a - b)
    .map((startMinutes) => ({
      key: slotKeyFor(reservation.date, startMinutes, reservation.employeeId),
      cancellationId,
      employeeId: reservation.employeeId,
      date: reservation.date,
      startMinutes,
      endMinutes: startMinutes + calAfter.slotMinutes,
    }));
}

/**
 * PHASE B (design §4.1) — every reason why `entry` does not fit `slot`.
 *
 * There is NO short-circuit: all seven checks always run and every failure
 * is collected, because the operator has the right to see all the reasons,
 * not the first one the code happened to hit.
 *
 * B6 IS NOT OPTIONAL. `freeSlotStarts` does not filter the past — that check
 * only exists in `engine.ts` (the past-or-too-soon check inside `runConversation`).
 * Without B6 the waitlist would offer slots the voice engine itself would
 * have rejected. THE SAME EXPRESSION is copied here, `minimumLeadMinutes`
 * included, so the two gates cannot drift apart; design criterion 6 pins
 * that equivalence with a test that runs both paths on the same calendar and
 * clock.
 *
 * B7 is recomputed on every snapshot and NEVER cached: a call run from
 * Laboratorio (`POST /api/scenario/run`) may have taken the slot between two
 * polls.
 */
export function matchEntryAgainstSlot(
  cal: CalendarWithCapabilities,
  clock: Clock,
  entry: WaitlistEntry,
  slot: ReleasedSlot,
): WaitlistMismatchReason[] {
  const reasons: WaitlistMismatchReason[] = [];

  // B1 — the released day is inside the range the person asked for.
  if (!(entry.dateFrom <= slot.date && slot.date <= entry.dateTo)) {
    reasons.push("date_outside_preferred_range");
  }

  // B2 — the WHOLE service fits inside the declared window. Both bounds are
  // validated to be aligned to `slotMinutes` at creation time, so this rule
  // is neither ambiguous nor an invented policy.
  if (!(slot.startMinutes >= entry.earliestStartMinutes && slot.startMinutes + cal.slotMinutes <= entry.latestStartMinutes)) {
    reasons.push("time_outside_preferred_window");
  }

  // B3 — a specific professional was requested and this is not them. An
  // "any" preference always accepts the professional of the cancelled
  // appointment, which is the ONLY candidate (design §4.3).
  if (entry.professional.kind === "specific" && entry.professional.employeeId !== slot.employeeId) {
    reasons.push("different_professional_requested");
  }

  // B4 — that professional can actually perform that service.
  if (!canPerform(cal, slot.employeeId, entry.serviceId)) {
    reasons.push("professional_cannot_perform_service");
  }

  // B5 — the day is inside the booking horizon the calendar declares.
  if (!isWithinHorizon(cal, clock, slot.date)) {
    reasons.push("date_outside_booking_horizon");
  }

  // B6 — THE SAME EXPRESSION as the past-or-too-soon check in engine.ts. See
  // the docblock above. step 18 §4.2: the expression itself moved to
  // `domain/slotTime.ts` so multi-person booking could ask the same question
  // without writing a THIRD copy of it. There are still exactly two bodies of
  // this rule — `engine.ts` and that helper — and the equivalence test of
  // criterion 6 still ties them; this line is now a call, not a copy.
  //
  // (Enmienda de fase K, H2) Since the helper also answers `true` for a day
  // already gone, a slot from yesterday now collects B5 AND B6 — both true,
  // and the operator reads both. The ORDER of the two is deliberately left
  // alone: it is the canonical one of `WAITLIST_MISMATCH_REASONS`, this rule
  // set never short-circuits (see the type's docblock: every reason is shown,
  // not the first one), and nothing here picks a single reason to display.
  // The place where the order DOES decide what is read is the group creation
  // conflict (`operations/groupCommands.ts`), and it is repaired there.
  if (isStartInThePast(cal.minimumLeadMinutes, clock, slot.date, slot.startMinutes)) {
    reasons.push("slot_in_the_past");
  }

  // B7 — recomputed from scratch, never cached.
  if (!isSlotFree(cal, slot.employeeId, slot.date, slot.startMinutes)) {
    reasons.push("slot_no_longer_free");
  }

  return reasons;
}

export interface WaitlistEntryEvaluation {
  entryId: string;
  match: boolean;
  reasons: readonly WaitlistMismatchReason[];
}

export interface ReleasedSlotEvaluation {
  slotKey: string;
  /**
   * PHASE C (design §4.1) — CREATION order. In the JSON this is called
   * `readingOrder`, never `priority`/`rank`/`position`, and it always
   * travels with `readingOrderNote: "Orden de lectura, no de prioridad."`
   */
  compatibleEntryIds: readonly string[];
  incompatible: readonly WaitlistEntryEvaluation[];
  /** How many entries were evaluated at all (only `pending`/`matched` ones are). */
  evaluated: number;
}

/**
 * Evaluates every ACTIVE-FOR-MATCHING entry (`pending`/`matched`) against
 * one released slot. Entries in any other state are not candidates and are
 * not evaluated at all — an entry that already declined, was withdrawn or
 * has a live notice is not "incompatible", it is simply not in the running.
 */
export function evaluateReleasedSlot(
  cal: CalendarWithCapabilities,
  clock: Clock,
  entries: readonly WaitlistEntry[],
  slot: ReleasedSlot,
): ReleasedSlotEvaluation {
  const candidates = entries
    .filter((e) => MATCHABLE_ENTRY_STATES.includes(e.state))
    .slice()
    .sort((a, b) => a.createdSeq - b.createdSeq);

  const compatibleEntryIds: string[] = [];
  const incompatible: WaitlistEntryEvaluation[] = [];
  for (const entry of candidates) {
    const reasons = matchEntryAgainstSlot(cal, clock, entry, slot);
    if (reasons.length === 0) {
      compatibleEntryIds.push(entry.id);
    } else {
      incompatible.push({ entryId: entry.id, match: false, reasons });
    }
  }

  return { slotKey: slot.key, compatibleEntryIds, incompatible, evaluated: candidates.length };
}

// ---------------------------------------------------------------------
// step 23 §3 — THE ONE DETERMINISTIC PROPOSAL RULE (R1), still 100% pure.
// ---------------------------------------------------------------------

/**
 * Does the proposal of `slot` STILL STAND? Re-derived from zero, never cached,
 * for exactly the reason `offer.stillValid` is (step 17 §14.6).
 *
 * The precedence of design §4 read in one line: an entry that already
 * converted, accepted or been notified keeps its proposal standing — those
 * three are FURTHER ALONG the loop, not failures. An entry that declined, was
 * withdrawn or was manually expired has ENDED its proposal, and so has one that
 * no longer fits the slot on a fresh B1..B7 pass (which includes the slot
 * having been taken by somebody else, B7).
 *
 * A trigger may only fill an empty slot or repair an ENDED proposal; a standing
 * one is never reordered, re-pointed at another person or un-approved (§3.2).
 */
export function proposalStanding(
  cal: CalendarWithCapabilities,
  clock: Clock,
  entries: readonly WaitlistEntry[],
  slot: ReleasedSlot,
): { stands: boolean; reasons: readonly ProposalInvalidReasonCode[] } {
  const proposal = slot.proposal;
  if (proposal === undefined) return { stands: false, reasons: [] };
  const entry = entries.find((e) => e.id === proposal.entryId);
  if (entry === undefined) return { stands: false, reasons: ["entry_no_longer_active"] };
  if (entry.state === "converted" || entry.state === "accepted" || entry.state === "notice_simulated") {
    return { stands: true, reasons: [] };
  }
  if (!MATCHABLE_ENTRY_STATES.includes(entry.state)) {
    return { stands: false, reasons: ["entry_no_longer_active"] };
  }
  // §3.1 makes the pairing part of the proposal: proposing somebody points
  // their offer at this slot. If the operator has since released that match,
  // the proposal no longer describes anything true — the person is on the list
  // and still fits, but she is not paired with this half hour any more, and
  // leaving an APPROVED proposal standing over her would let the screen show a
  // backing that nobody would recognise as still given.
  if (entry.currentOffer?.slotKey !== slot.key) {
    return { stands: false, reasons: ["offer_no_longer_on_this_slot"] };
  }
  const reasons = matchEntryAgainstSlot(cal, clock, entry, slot);
  return reasons.length === 0 ? { stands: true, reasons: [] } : { stands: false, reasons };
}

/**
 * ¿Hay ya alguien A QUIEN SE HA AVISADO —o que ya ha aceptado, o ya ha
 * convertido— sobre ESTE medio hora? (Revisión adversarial de step 23, H1.)
 *
 * Es el mismo predicado que `alreadyBeingDecided` usa en la proyección para
 * apagar `decisionPending`, y ahora vive UNA sola vez, aquí, porque el mando y
 * la pantalla tienen que contestar exactamente lo mismo: si el servidor publica
 * a alguien como sustituible, el comando debe aceptarlo; y si el comando lo
 * rechaza, la pantalla no puede ofrecerlo. Tenerlo escrito dos veces fue justo
 * lo que dejó a `take_over_proposal` reasignando un hueco por el que ya se
 * había avisado a una persona, contra §5.2 («R2 es también, gratis, la guarda
 * que impide avisar a dos personas por el mismo hueco»).
 *
 * Se mira la OFERTA VIVA de la entrada, no el puntero de la propuesta: quien
 * fue avisada lo fue por su oferta sobre este hueco, y mover el puntero de la
 * propuesta a otra persona no deshace ese aviso.
 *
 * `converted` NO entra, y es deliberado: si la conversión sigue en pie, el
 * hueco está ocupado y B7 tumba cualquier sustitución sin necesidad de esta
 * guarda; y si esa reserva se canceló después, el medio hora ha vuelto a estar
 * libre de verdad y dárselo a otra persona es exactamente lo que hay que poder
 * hacer. Bloquearlo ahí sería congelar un hueco vivo por un hecho pasado.
 */
export function entryAlreadyAnsweringSlot(
  entries: readonly WaitlistEntry[],
  slot: ReleasedSlot,
): WaitlistEntry | undefined {
  return entries.find(
    (e) => e.currentOffer?.slotKey === slot.key && (e.state === "notice_simulated" || e.state === "accepted"),
  );
}

/**
 * Does `entry` retain a LIVE AND PROVABLY VALID offer over a slot that is NOT
 * `slot`? (Design §3.1, condition (c) of R1.)
 *
 * Re-pointing such an offer would take a live offer away from somebody in
 * silence, which §3.1 forbids outright: the person would stop being matched to
 * a half hour that genuinely still fits them, and nothing on screen would ever
 * have said so. An offer whose slot is no longer in the registry, or that fails
 * a fresh B1..B7 pass, is PROVABLY dead and does not block anything.
 */
function holdsValidOfferElsewhere(
  cal: CalendarWithCapabilities,
  clock: Clock,
  entry: WaitlistEntry,
  releasedSlots: readonly ReleasedSlot[],
  slot: ReleasedSlot,
): boolean {
  const offer = entry.currentOffer;
  if (offer === undefined || offer.slotKey === slot.key) return false;
  const other = releasedSlots.find((s) => s.key === offer.slotKey);
  if (other === undefined) return false;
  return matchEntryAgainstSlot(cal, clock, entry, other).length === 0;
}

/**
 * R1 IN FULL, and the only rule there is (design §3, decision D23-2).
 *
 * The candidates for a slot are the entries that: (a) are still in the running
 * (`pending`/`matched`); (b) fit the slot with ZERO mismatch reasons; (c) do
 * not retain a valid offer over another slot (§3.1); and (d) are not already
 * the subject of a standing proposal of another slot — one person is not
 * proposed for two half hours at once, or approving one would silently commit
 * the other.
 *
 * The result is ordered by `createdSeq`, and the proposal is the FIRST of them.
 * There is no score, no seniority bonus, no affinity and no heuristic here, and
 * the sentence the operator reads says exactly that: «Primera persona
 * compatible por orden de alta en lista.»
 */
export function proposalCandidatesFor(
  cal: CalendarWithCapabilities,
  clock: Clock,
  entries: readonly WaitlistEntry[],
  releasedSlots: readonly ReleasedSlot[],
  slot: ReleasedSlot,
): readonly WaitlistEntry[] {
  return entries
    .filter((e) => MATCHABLE_ENTRY_STATES.includes(e.state))
    .filter((e) => matchEntryAgainstSlot(cal, clock, e, slot).length === 0)
    .filter((e) => !holdsValidOfferElsewhere(cal, clock, e, releasedSlots, slot))
    .filter(
      (e) =>
        !releasedSlots.some(
          (other) =>
            other.key !== slot.key &&
            other.proposal?.entryId === e.id &&
            proposalStanding(cal, clock, entries, other).stands,
        ),
    )
    .slice()
    .sort((a, b) => a.createdSeq - b.createdSeq);
}
