/**
 * The salon's weekly opening hours, from config (`BRAIN_OPENING_HOURS`).
 *
 * Format: comma-separated `days=spec`, where `days` is one weekday or a range
 * (`lun mar mie jue vie sab dom`; `mar-vie`) and `spec` is `abierto` (open all
 * day), `cerrado`, or `HH:MM` (open until that time). Weekdays not listed count
 * as closed. Example (the default):
 *
 *   mar-vie=abierto,sab=14:00,dom=cerrado,lun=cerrado
 *
 * This only decides what the model is told and which obviously useless
 * availability calls are answered locally. Holidays and breaks still come from
 * Bruno's live agenda, through the middleware.
 */

export interface DayHours {
  /** Minutes from midnight at which the salon closes; null = closed all day. */
  closeAtMinutes: number | null;
}

/** Index = `getUTCDay()`: 0 = Sunday … 6 = Saturday. */
export type OpeningHours = ReadonlyArray<DayHours>;

export const DEFAULT_OPENING_HOURS = "mar-vie=abierto,sab=14:00,dom=cerrado,lun=cerrado";

const DAY_KEYS = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"] as const;
const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;
const ALL_DAY = 24 * 60;
/** Same cut as the middleware: from 14:00 on it is «tarde». */
const AFTERNOON_FROM_MINUTES = 14 * 60;

export class OpeningHoursError extends Error {}

function dayIndex(key: string): number {
  const normalized = key.trim().toLowerCase().replace("é", "e");
  const i = DAY_KEYS.indexOf(normalized as (typeof DAY_KEYS)[number]);
  if (i < 0) throw new OpeningHoursError(`unknown weekday "${key}"`);
  return i;
}

export function parseOpeningHours(raw: string): OpeningHours {
  const week: DayHours[] = DAY_KEYS.map(() => ({ closeAtMinutes: null }));
  for (const part of raw.split(",")) {
    if (part.trim() === "") continue;
    const [daysRaw, specRaw, ...extra] = part.split("=");
    if (daysRaw === undefined || specRaw === undefined || extra.length > 0) {
      throw new OpeningHoursError(`invalid entry "${part.trim()}"`);
    }
    const [fromKey, toKey, ...rest] = daysRaw.split("-");
    if (fromKey === undefined || rest.length > 0) throw new OpeningHoursError(`invalid days "${daysRaw.trim()}"`);
    const from = dayIndex(fromKey);
    const to = toKey === undefined ? from : dayIndex(toKey);
    if (to < from) throw new OpeningHoursError(`days range "${daysRaw.trim()}" must not wrap around Sunday`);

    const spec = specRaw.trim().toLowerCase();
    let closeAtMinutes: number | null;
    if (spec === "cerrado") closeAtMinutes = null;
    else if (spec === "abierto") closeAtMinutes = ALL_DAY;
    else {
      const m = /^(\d{1,2}):(\d{2})$/.exec(spec);
      const h = m ? Number(m[1]) : NaN;
      const min = m ? Number(m[2]) : NaN;
      if (!m || h > 23 || min > 59) throw new OpeningHoursError(`invalid hours "${specRaw.trim()}"`);
      closeAtMinutes = h * 60 + min;
    }
    for (let d = from; d <= to; d++) week[d] = { closeAtMinutes };
  }
  return week;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Spanish prose for the system prompt, Monday first. */
export function renderOpeningHours(week: OpeningHours): string {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const open: string[] = [];
  const closed: string[] = [];
  for (const d of order) {
    const close = week[d]?.closeAtMinutes ?? null;
    if (close === null) closed.push(DAY_NAMES[d] as string);
    else if (close >= ALL_DAY) open.push(`${DAY_NAMES[d]}: abierto todo el día`);
    else open.push(`${DAY_NAMES[d]}: solo hasta las ${clock(close)}`);
  }
  const lines = open.map((l) => `- ${l}`);
  if (closed.length > 0) lines.push(`- Cerrado: ${closed.join(", ")}`);
  return lines.join("\n");
}

function weekdayOf(isoDate: unknown): number | null {
  if (typeof isoDate !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

export type ClosedKind = "day" | "afternoon";

/**
 * Is this date (and, optionally, half of the day or earliest wanted time)
 * certainly closed? `"day"`: closed all day. `"afternoon"`: open in the morning
 * only and the afternoon (or a time at/after the close) was asked for.
 */
export function closedKind(
  week: OpeningHours,
  isoDate: unknown,
  opts: { period?: unknown; afterTime?: unknown } = {}
): ClosedKind | null {
  const weekday = weekdayOf(isoDate);
  if (weekday === null) return null;
  const close = week[weekday]?.closeAtMinutes ?? null;
  if (close === null) return "day";
  if (close >= ALL_DAY) return null;
  if (opts.period === "afternoon" && close <= AFTERNOON_FROM_MINUTES) return "afternoon";
  if (typeof opts.afterTime === "string") {
    const m = /^(\d{2}):(\d{2})$/.exec(opts.afterTime);
    if (m && Number(m[1]) * 60 + Number(m[2]) >= close) return "afternoon";
  }
  return null;
}

export function weekdayNamePlural(isoDate: string): string {
  const d = weekdayOf(isoDate);
  const name = d === null ? "días" : (DAY_NAMES[d] as string);
  return name.endsWith("s") ? name : `${name}s`;
}
