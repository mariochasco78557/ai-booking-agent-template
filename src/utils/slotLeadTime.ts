import type { AgendaDay } from "../services/agenda/agendaSource.js";
import { parseDateTime } from "./dateFormatterEs.js";
import { madridDate, madridWallClock } from "./madridDate.js";

/**
 * *** AN HOUR THAT HAS ALREADY STARTED — OR IS ABOUT TO — IS NOT A HUECO. ***
 *
 * Incident 2026-09-18 (conv_6101…): a caller at 14:37 asked for «hoy» and was
 * offered «por la mañana… a las diez y media» of that same day. `/user/free`
 * happily lists hours that are already over, and nothing between it and the
 * caller knew what time it was.
 *
 * The rule, in one place for every path that offers, locks or writes a slot:
 * a slot of TODAY (the salon's Europe/Madrid calendar day) is too soon unless
 * its start is STRICTLY later than now + `BALANCED_MIN_LEAD_MINUTES`.
 *
 * How it is computed: the cutoff is the Madrid wall clock of the instant
 * `now + lead`, cut to the minute, and a slot is too soon when its own wall
 * clock (`YYYY-MM-DD HH:MM`) is `<=` that cutoff. Cutting the cutoff DOWN to
 * the minute is exact for minute-resolution starts: at 14:37:40 + 30 min the
 * cutoff is `15:07`, and 15:07:00 is indeed not later than 15:07:40. Going
 * through the instant rather than adding minutes to a wall clock is what makes
 * the rule DST-correct, and it also carries a late-evening lead across
 * midnight (23:50 + 30 → tomorrow 00:20).
 *
 * *** WHAT IT DELIBERATELY DOES NOT JUDGE. ***
 *
 * - Dates BEFORE the salon's today. Out of scope of this fix: which day to
 *   ask about is the agent's decision, and the existing fixtures and flows
 *   for explicit dates are left exactly as they were.
 * - A start that does not parse as a date-time. Left as it was, so this
 *   filter can only ever REMOVE a real, too-soon hour and never reinterpret
 *   anything else upstream sent.
 */
export const DEFAULT_MIN_LEAD_MINUTES = 30;

/** True when `slotStart` (`YYYY-MM-DD HH:MM[:SS]`) must not be offered, locked or booked at `nowMs`. */
export function isSlotTooSoon(slotStart: string, nowMs: number, leadMinutes: number): boolean {
  const parsed = parseDateTime(slotStart);
  if (parsed === null || !parsed.hasTime) return false;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const slotDate = `${parsed.year}-${pad(parsed.month)}-${pad(parsed.day)}`;
  if (slotDate < madridDate(nowMs)) return false;
  const slotWall = `${slotDate} ${pad(parsed.hour)}:${pad(parsed.minute)}`;
  return slotWall <= madridWallClock(nowMs + leadMinutes * 60_000);
}

/**
 * The same day with every too-soon slot removed.
 *
 * Returns the SAME object when nothing was removed — the overwhelmingly common
 * case (any day that is not today) — so every consumer downstream sees exactly
 * what it saw before. When something was removed, a barber left with no slot
 * at all is dropped from `free`, preserving the upstream invariant that «no
 * free hour» means ABSENT, never present-and-empty (see `AgendaDay.free`).
 *
 * Never mutates its input: the day may be a cached snapshot shared with other
 * conversations.
 */
export function withoutTooSoonSlots(
  day: AgendaDay,
  nowMs: number,
  leadMinutes: number,
): AgendaDay {
  let removed = false;
  const free = [];
  for (const record of day.free) {
    const slots = record.slots.filter((slot) => !isSlotTooSoon(slot.start, nowMs, leadMinutes));
    if (slots.length === record.slots.length) {
      free.push(record);
      continue;
    }
    removed = true;
    if (slots.length > 0) free.push({ ...record, slots });
  }
  return removed ? { ...day, free } : day;
}

/** Weekday (`getUTCDay()` convention) to the minute of day from which the salon is closed. */
export type EarlyCloseMap = ReadonlyMap<number, number>;

/**
 * True when `slotStart` (`YYYY-MM-DD HH:MM[:SS]`) falls on a weekday with an
 * early close and starts at or after that minute (env `BALANCED_EARLY_CLOSE`,
 * e.g. Saturday from 14:00). A start that does not parse is never judged.
 */
export function isSlotAfterEarlyClose(slotStart: string, earlyClose: EarlyCloseMap): boolean {
  if (earlyClose.size === 0) return false;
  const parsed = parseDateTime(slotStart);
  if (parsed === null || !parsed.hasTime) return false;
  const weekday = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  const closeAt = earlyClose.get(weekday);
  if (closeAt === undefined) return false;
  return parsed.hour * 60 + parsed.minute >= closeAt;
}

/**
 * The same day with every slot at/after the weekday's early close removed.
 * Same contract as {@link withoutTooSoonSlots}: the same object when nothing
 * was removed, a barber left with no slot is dropped from `free`, no mutation.
 */
export function withoutAfterCloseSlots(day: AgendaDay, earlyClose: EarlyCloseMap): AgendaDay {
  if (earlyClose.size === 0) return day;
  let removed = false;
  const free = [];
  for (const record of day.free) {
    const slots = record.slots.filter((slot) => !isSlotAfterEarlyClose(slot.start, earlyClose));
    if (slots.length === record.slots.length) {
      free.push(record);
      continue;
    }
    removed = true;
    if (slots.length > 0) free.push({ ...record, slots });
  }
  return removed ? { ...day, free } : day;
}
