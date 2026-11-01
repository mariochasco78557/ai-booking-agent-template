/**
 * *** SPOKEN Spanish clock times, for the balanced V2 voice flow. ***
 *
 * `src/utils/dateFormatterEs.ts` renders a time as a LABEL — `"17:30"` — and
 * that is the right thing for a transcript, a log line and the JSON a tool
 * returns. It is the wrong thing for a sentence the agent reads out loud: a
 * text-to-speech engine handed `"17:30"` will say something, but which
 * something depends on the voice, the locale and the day, and the V2 script
 * has EXACT wording requirements ("a las cinco y media", not "a las diecisiete
 * treinta").
 *
 * So this module exists to produce the words, and it lives beside the label
 * builder rather than inside it: the label is a contract with machines and
 * must not change, while these strings are a contract with a listener.
 *
 * It is deliberately total and pure — no configuration, no clock, no throw.
 * An input it cannot render falls back to the digits, which is worse prose but
 * never a crash mid-call.
 */

import { parseDateTime, weekdayEs } from "./dateFormatterEs.js";

/** 1..12, indexed by the 12-hour value. Index 0 is unused. */
const HOUR_WORDS_ES = [
  "",
  "una",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
] as const;

const HHMM_RE = /^(\d{2}):(\d{2})$/;

/** `"17:30"` -> `17`, `30`. Undefined for anything that is not a valid HH:mm. */
function parts(hhmm: string): { hour: number; minute: number } | undefined {
  const match = HHMM_RE.exec(hhmm);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return { hour, minute };
}

/** 0 -> 12, 13 -> 1, 17 -> 5. The salon speaks in twelves. */
function twelve(hour24: number): number {
  const value = hour24 % 12;
  return value === 0 ? 12 : value;
}

/**
 * `"10:00"` -> `"diez"`, `"17:30"` -> `"cinco y media"`, `"16:45"` ->
 * `"cinco menos cuarto"`.
 *
 * No "de la mañana" / "de la tarde" suffix: the surrounding sentence has
 * already established the half of the day (see `src/utils/balancedPhrasing.ts`),
 * and repeating it in every item of a three-item list reads as a machine.
 *
 * Minutes that are not a quarter of an hour fall back to `"diez y veinte"`.
 * The salon's grid is half-hourly, so that branch is a safety net rather than
 * a normal path — but a safety net that produces Spanish beats one that
 * produces `"10:20"` in the middle of a spoken list.
 */
export function spokenTimeEs(hhmm: string): string {
  const value = parts(hhmm);
  if (value === undefined) return hhmm;
  const { hour, minute } = value;

  if (minute === 45) {
    // "menos cuarto" belongs to the NEXT hour: 16:45 is "cinco menos cuarto".
    return `${HOUR_WORDS_ES[twelve(hour + 1)]} menos cuarto`;
  }
  const word = HOUR_WORDS_ES[twelve(hour)];
  if (minute === 0) return `${word}`;
  if (minute === 15) return `${word} y cuarto`;
  if (minute === 30) return `${word} y media`;
  return `${word} y ${minute}`;
}

/**
 * Joins already-spoken items with Spanish list punctuation:
 * `["diez","once","doce"]` -> `"diez, once y doce"`.
 *
 * `prefix` is repeated in front of every item AFTER the first, which is how
 * the required V2 sentences are worded: "a las diez, a las once y a las doce"
 * carries the preposition on each item, while "las diez, las once y las doce"
 * carries the article. The first item never takes it, because the surrounding
 * template has already said it once.
 */
export function joinSpokenEs(items: readonly string[], prefix = ""): string {
  if (items.length === 0) return "";
  const decorated = items.map((item, index) => (index === 0 ? item : `${prefix}${item}`));
  if (decorated.length === 1) return decorated[0]!;
  return `${decorated.slice(0, -1).join(", ")} y ${decorated.at(-1)}`;
}

/** 1..31 as spoken Spanish words. Index 0 is unused. */
const DAY_OF_MONTH_WORDS_ES = [
  "",
  "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho",
  "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro",
  "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve", "treinta",
  "treinta y uno",
] as const;

/** 1..31 -> «uno»…«treinta y uno»; anything else -> the digits. (2026-10-10.) */
export function spokenDayOfMonthEs(day: number): string {
  return DAY_OF_MONTH_WORDS_ES[day] ?? String(day);
}

/**
 * `"2026-09-22"` -> `"el martes veintidós"`.
 *
 * The form a receptionist uses when proposing a day the CALLER did not name
 * (the discover look-ahead): weekday plus the day of the month in words, at
 * any distance, so «el martes» can never be mistaken for a different Tuesday.
 * Total: an unreadable date comes back unchanged.
 */
export function spokenWeekdayAndDayEs(dateIso: string): string {
  const date = parseDateTime(dateIso);
  if (date === null) return dateIso;
  const words = DAY_OF_MONTH_WORDS_ES[date.day] ?? String(date.day);
  return `el ${weekdayEs(date)} ${words}`;
}

/**
 * *** SPOKEN Spanish CALENDAR DAYS — what "hoy", "mañana" and "el jueves" cost. ***
 *
 * `action: "scan"` answers about a WINDOW, so a single sentence names several
 * days out loud, and each day has to be said the way the caller would say it.
 * A date read as digits ("el dos mil veintiséis guión nueve guión catorce") is
 * unlistenable; a bare weekday ("el jueves") is perfect inside the next week
 * and DANGEROUSLY ambiguous outside it — «el jueves» spoken on a Wednesday for
 * a date thirteen days out means a different Thursday to the caller than to the
 * agenda, and the caller only finds out when they turn up.
 *
 * So the rendering is a function of the DISTANCE, not of the date:
 *
 * | offset      | spoken            | why                                     |
 * |-------------|-------------------|-----------------------------------------|
 * | `0`         | `hoy`             | a weekday here would be pedantic        |
 * | `1`         | `mañana`          | ditto                                   |
 * | `2` … `6`   | `el jueves`       | unambiguous: one such Thursday is near  |
 * | `7` or more | `el jueves 14`    | the day number removes the ambiguity    |
 *
 * Anything BEFORE today also takes the qualified form. A scan should never
 * produce a past date, and if a bug ever does, "el jueves 14" is merely odd
 * while "mañana" would be a false statement about a slot in the past.
 *
 * *** PURE, AND IT NEVER READS A CLOCK. ***
 *
 * `todayIso` is a parameter because the salon's "today" is a Europe/Madrid
 * question (see `src/utils/madridDate.ts`), because a call that starts at
 * 23:58 must keep ONE today for its whole duration, and because a function
 * that reads `Date.now()` cannot be tested at a boundary.
 *
 * Total, like every builder in this file: an unreadable `dateIso` comes back
 * unchanged rather than throwing mid-call, and an unreadable `todayIso` falls
 * back to the qualified form — the only rendering that is still TRUE when the
 * distance is unknown.
 *
 * @param dateIso  The day being spoken, `YYYY-MM-DD` (a trailing time is
 *                 tolerated and ignored).
 * @param todayIso Today, `YYYY-MM-DD`, in the salon's timezone.
 */
export function spokenDateEs(dateIso: string, todayIso: string): string {
  const date = parseDateTime(dateIso);
  if (date === null) return dateIso;

  const weekday = weekdayEs(date);
  /** Unambiguous on any date, at any distance. The fallback for everything. */
  // 2026-10-10: ALWAYS the weekday and the number, in words («el jueves
  // dieciséis»), at any distance — a bare «el jueves» is what let a model
  // carry the wrong weekday into the summary. «hoy» / «mañana» keep the name
  // too: «hoy, sábado diez».
  const qualified = `el ${weekday} ${spokenDayOfMonthEs(date.day)}`;

  const today = parseDateTime(todayIso);
  if (today === null) return qualified;

  // Both are midnight UTC, so the difference is an exact number of days and
  // no DST transition can shift it. `Math.round` is belt and braces.
  const offsetDays = Math.round(
    (Date.UTC(date.year, date.month - 1, date.day) -
      Date.UTC(today.year, today.month - 1, today.day)) /
      86_400_000,
  );

  if (offsetDays === 0) return `hoy, ${qualified.slice(3)},`;
  if (offsetDays === 1) return `mañana, ${qualified.slice(3)},`;
  return qualified;
}
