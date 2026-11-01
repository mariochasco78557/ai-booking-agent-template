/**
 * Pure calendar utilities for the call-engine domain. No state, no implicit
 * clock — every function here is a pure function of its arguments.
 *
 * WHY WALL-CLOCK ARITHMETIC, NOT UTC INSTANTS:
 * The domain timezone is Europe/Madrid, which observes DST. Converting a
 * local wall-clock time (e.g. "2026-03-29 09:00") to a UTC instant depends
 * on which side of the DST transition that date falls on, AND on what
 * timezone the machine executing the code happens to be in — neither of
 * which this module should ever have to reason about. Worse, on the two
 * DST turnover days themselves, a naive local-time-to-instant conversion
 * either skips an hour that never happened or is ambiguous about which of
 * two occurrences of the same wall-clock hour is meant. Comparing slot
 * ranges as instants would therefore be silently wrong twice a year.
 *
 * To avoid all of this, every slot/availability calculation in
 * src/callEngine/** operates purely on local wall-clock values: a
 * "YYYY-MM-DD" date paired with minutes-since-midnight (0..1439). Dates are
 * never converted to UTC instants for slot math, and no function in this
 * module reads the real timezone of the host machine.
 *
 * The one narrow, deliberate exception is day-of-week and date-adding
 * below, which pivot through midday UTC (`T12:00:00Z`). Midday UTC is a
 * safe, DST-proof anchor because a Europe/Madrid DST transition always
 * happens in the small hours (local 02:00-03:00), which is never anywhere
 * near UTC noon on any date, in any year. So `new Date(`${dateISO}T12:00:00Z`)`
 * always lands on the intended calendar date, and `getUTCDay()` /
 * `getUTCDate()` on that instant is stable regardless of DST or of the host
 * machine's own local timezone. This never reads the *current* time — the
 * date string is always supplied by the caller.
 */

/** 0=domingo .. 6=sábado, for the given "YYYY-MM-DD" date. */
export function dayOfWeek(dateISO: string): number {
  return new Date(`${dateISO}T12:00:00Z`).getUTCDay();
}

/** Adds `n` (possibly negative) days to a "YYYY-MM-DD" date, DST-proof. */
export function addDays(dateISO: string, n: number): string {
  const pivot = new Date(`${dateISO}T12:00:00Z`);
  pivot.setUTCDate(pivot.getUTCDate() + n);
  const y = pivot.getUTCFullYear();
  const m = String(pivot.getUTCMonth() + 1).padStart(2, "0");
  const d = String(pivot.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Lexicographic date comparison: -1 (a<b), 0 (a===b), 1 (a>b). Works because "YYYY-MM-DD" sorts chronologically as a string. */
export function compareDate(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Parses "HH:mm" into minutes-since-midnight. */
export function parseHHmm(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Formats minutes-since-midnight as "HH:mm". */
export function formatHHmm(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Number of days from `a` to `b` (positive when `b` is later), DST-proof. */
export function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T12:00:00Z`).getTime();
  const tb = new Date(`${b}T12:00:00Z`).getTime();
  return Math.round((tb - ta) / 86_400_000);
}

/** True when `s` is a syntactically and calendrically valid "YYYY-MM-DD" date. */
export function isValidDateISO(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y === undefined || m === undefined || d === undefined) return false;
  const parsed = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() + 1 === m &&
    parsed.getUTCDate() === d
  );
}
