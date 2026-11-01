/**
 * Spanish (Spain) date/time phrasing for voice-agent output.
 *
 * Upstream returns naive Europe/Madrid wall-clock strings like
 * "2026-07-29 17:00:00". We treat those components literally (no timezone
 * conversion) and build phrases such as "miércoles 29 de julio a las 17:00".
 */

const WEEKDAYS_ES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export interface ParsedDateTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  hasTime: boolean;
}

const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parse "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss" (also accepts 'T'). */
export function parseDateTime(value: string): ParsedDateTime | null {
  const m = DATETIME_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hasTime = m[4] !== undefined;
  const hour = hasTime ? Number(m[4]) : 0;
  const minute = hasTime ? Number(m[5]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute, hasTime };
}

/** 0 (Sunday)..6 -> «domingo»…«sábado»; anything else -> "". (2026-10-10.) */
export function weekdayNameEs(dow: number): string {
  return WEEKDAYS_ES[dow] ?? "";
}

/** 1..12 -> «enero»…«diciembre»; anything else -> "". (2026-10-10, fechas del servidor.) */
export function monthNameEs(month: number): string {
  return MONTHS_ES[month - 1] ?? "";
}

/** Weekday name in Spanish for a parsed date (uses UTC to avoid TZ drift). */
export function weekdayEs(p: ParsedDateTime): string {
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return WEEKDAYS_ES[dow]!;
}

/** "17:00" style label. */
export function timeLabel(p: ParsedDateTime): string {
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "miércoles 29 de julio" (no time). */
export function dayPhraseEs(p: ParsedDateTime): string {
  return `${weekdayEs(p)} ${p.day} de ${MONTHS_ES[p.month - 1]}`;
}

/** "miércoles 29 de julio a las 17:00". Falls back gracefully on bad input. */
export function fullPhraseEs(value: string): string {
  const p = parseDateTime(value);
  if (!p) return value;
  if (!p.hasTime) return dayPhraseEs(p);
  return `${dayPhraseEs(p)} a las ${timeLabel(p)}`;
}

/** Just the time label ("17:00") from a full datetime string. */
export function timeLabelFromString(value: string): string {
  const p = parseDateTime(value);
  return p ? timeLabel(p) : value;
}
