import type { Clock } from "./types.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — THE PAST-OR-TOO-SOON CHECK, WRITTEN ONCE (design §4.2, §4.7,
 * criterion 8.30).
 *
 * `freeSlotStarts` (calendar/resolveAvailability.ts:471) deliberately does
 * NOT filter the past: it answers "which starts does the timetable leave
 * free", not "which of them may still be booked". That second question is
 * answered today in TWO places on purpose — `engine.ts` (frozen) and the
 * waitlist's rule B6 — tied together by the equivalence test of step 17
 * (criterion 6, tests/callEngine/waitlistMatching.test.ts).
 *
 * Multi-person booking needs the same question answered a third time. Writing
 * a third copy is FORBIDDEN, so the expression moves here, `waitlist/matching.ts`
 * B6 calls it, and `operations/groupProposal.ts` calls it too. There are still
 * exactly TWO bodies of this rule — `engine.ts` and this one — and the
 * existing equivalence test still ties them, now with a single body on this
 * side instead of one per consumer.
 *
 * `minimumLeadMinutes` arrives as a NUMBER, not as a calendar: that is what
 * keeps this file in `domain/`, the leaf of the dependency graph, with its
 * only import being `Clock` from its own folder. It reads no clock of its own,
 * keeps no state and has no side effect.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * `true` when a slot start is in the past, or so close that the calendar's
 * minimum lead time no longer fits before it.
 *
 * TODAY's part of the comparison is EXACTLY the one `engine.ts` makes, boundary
 * included: it is strict, so a slot starting exactly at
 * `now + minimumLeadMinutes` is still bookable. A FUTURE date is never "too
 * soon" here — the whole-day gate for those is `isWithinHorizon`.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ENMIENDA DE FASE K (H2). A date BEFORE today is now in the past too, which
 * it plainly is and this function used to deny.
 *
 * The reproduction: with the demo clock advanced past midnight (four presses
 * of "+4 h"), yesterday's released slot was labelled
 * `date_outside_booking_horizon` — "Ese día queda fuera del plazo en el que se
 * puede reservar" — and never `slot_in_the_past`. The horizon reason is true
 * (a past day is outside the horizon) but it is not the reason an operator
 * needs; "ese hueco ya ha pasado" is. The whole-day gate could not repair it:
 * `isWithinHorizon` (`calendar/resolveAvailability.ts`) is FROZEN for this
 * mission, and it answers a different question anyway.
 *
 * Why extending this expression does NOT break the equivalence with
 * `engine.ts` (step 17 criterion 6, `tests/callEngine/waitlistMatching.test.ts`):
 * the engine resolves the date it asks about from the requested weekday
 * FORWARD from today, so it never asks this question about a day already gone,
 * and the equivalence test samples only today's starts. For every date the two
 * bodies can both be asked about — today's and future ones — they still answer
 * identically, which is exactly what that test ties together.
 *
 * The comparison is lexical on `YYYY-MM-DD`, which is the same ordering as the
 * calendar one and needs no import: this file stays the leaf of the dependency
 * graph, with `Clock` as its only import.
 * ────────────────────────────────────────────────────────────────────────
 */
export function isStartInThePast(
  minimumLeadMinutes: number,
  clock: Clock,
  dateISO: string,
  startMinutes: number,
): boolean {
  if (dateISO < clock.nowISODate()) return true;
  return dateISO === clock.nowISODate() && startMinutes < clock.nowMinutes() + minimumLeadMinutes;
}
