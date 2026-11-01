/**
 * Conversión hora de pared <-> instante en una zona del tz database cualquiera
 * (la de `cliente.yaml`), solo con `Intl.DateTimeFormat`. Sin `Temporal` y
 * sin suponer Europe/Madrid.
 *
 * Una "hora de pared" se maneja como fecha `YYYY-MM-DD` + minutos desde la
 * medianoche local (0..1440). Los instantes son milisegundos epoch (UTC).
 */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Hora de pared en `timeZone` del instante `epochMs`. */
export function wallPartsAt(epochMs: number, timeZone: string): WallParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Desfase (ms) de `timeZone` respecto a UTC en el instante `epochMs`. */
export function offsetMsAt(epochMs: number, timeZone: string): number {
  const w = wallPartsAt(epochMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `true` si `date` es una fecha `YYYY-MM-DD` real. */
export function isIsoDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
}

function dateUtcMs(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`fecha inválida: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Día de la semana de una fecha de calendario (0 = domingo). */
export function weekdayOf(date: string): number {
  return new Date(dateUtcMs(date)).getUTCDay();
}

/** `date` + `days` días de calendario. */
export function addDays(date: string, days: number): string {
  return new Date(dateUtcMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Instante de la hora de pared `date` + `minutes` en `timeZone`. En la hora
 * repetida de un cambio de hora, la primera aparición; en el hueco (hora
 * inexistente), la hora leída con el desfase anterior al cambio.
 */
export function wallToEpochMs(date: string, minutes: number, timeZone: string): number {
  const wall = dateUtcMs(date) + minutes * 60_000;
  const before = wall - offsetMsAt(wall - 12 * 3_600_000, timeZone);
  const after = wall - offsetMsAt(wall + 12 * 3_600_000, timeZone);
  const valid = [before, after].filter((t) => {
    const back = wallToMinutes(t, timeZone);
    return back.date === date && back.minutes === minutes;
  });
  return valid.length > 0 ? Math.min(...valid) : before;
}

/** Hora de pared (`date`, minutos desde medianoche) del instante `epochMs`. */
export function wallToMinutes(epochMs: number, timeZone: string): { date: string; minutes: number } {
  const w = wallPartsAt(epochMs, timeZone);
  const date = `${String(w.year).padStart(4, "0")}-${pad2(w.month)}-${pad2(w.day)}`;
  return { date, minutes: w.hour * 60 + w.minute };
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `"HH:mm"` de unos minutos desde medianoche. */
export function hhmm(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** `"HH:mm"` -> minutos. */
export function parseHhmm(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

const WALL_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** `"YYYY-MM-DD HH:mm[:ss]"` -> `{ date, minutes }`; `null` si no encaja. */
export function parseWall(value: string): { date: string; minutes: number } | null {
  const m = WALL_RE.exec(value.trim());
  if (!m || !isIsoDate(m[1]!)) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 23 || mi > 59) return null;
  return { date: m[1]!, minutes: h * 60 + mi };
}

/** `"YYYY-MM-DDTHH:mm:00"` sin desfase (Google lo interpreta con `timeZone`). */
export function localDateTime(date: string, minutes: number): string {
  return `${date}T${hhmm(minutes)}:00`;
}
