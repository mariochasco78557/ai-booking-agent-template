import { cleanEmployeeName } from "../employeeNameDirectory.js";
import { normalizeSpanishPhone } from "../../utils/phone.js";

/**
 * Dashboard mapping (DESIGN §3.2). EVERYTHING that is not verified against
 * the real upstream ("a confirmar en fase 0") lives in this file, so the
 * adjustment after phase 0 touches one place.
 */
export interface DashboardRange {
  /** "YYYY-MM-DD", Europe/Madrid, inclusive. */
  fromDate: string;
  /** "YYYY-MM-DD", Europe/Madrid, inclusive. */
  toDate: string;
}

/**
 * Whether a dashboard row is a booking that still stands (2026-10-09, «mis
 * citas» listed appointments the customer said were cancelled).
 *
 * VERIFIED against Bruno's code (copy of 2026-07-16, `src/` unchanged since
 * 2020): the `reservation` table has NO status, cancellation or soft-delete
 * column, and `GET /reservation/delete/{id}` is a hard `$em->remove()`. A
 * cancelled booking is therefore simply ABSENT from `/reservation/dashboard`,
 * and every row the real upstream sends today is `"active"`.
 *
 * This is the one place that would change if upstream ever marked rows
 * instead of deleting them:
 * - `"cancelled"`: a recognised cancellation marker (see {@link reservationStateOf}).
 * - `"unknown"`: a status-like field with a value this code does not know.
 *   FAIL-CLOSED: never listed as standing and never offered to cancel.
 */
export type ReservationState = "active" | "cancelled" | "unknown";

export interface DashboardReservation {
  id: number;
  /** "YYYY-MM-DD HH:mm" — Europe/Madrid wall clock. */
  startsAt: string;
  ownerPhoneE164: string | null;
  /** Only for the notice to the owner; never to logs nor to the LLM. */
  ownerName: string;
  ownerSurnames: string;
  employeeId: number | null;
  employeeName: string | null;
  typeReservation: number | null;
  state: ReservationState;
}

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** ASSUMPTION (phase 0): `start`/`end` params, `end` possibly exclusive -> ask one day more. */
export function buildDashboardQuery(range: DashboardRange): Record<string, string> {
  return { start: range.fromDate, end: addDays(range.toDate, 1) };
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

function validWall(y: number, mo: number, d: number, h: number, mi: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function wallFromString(s: string): string | null {
  const m = WALL_RE.exec(s.trim());
  if (!m) return null;
  if (!validWall(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

function madridWallFromInstant(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const p = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((e) => e.type === type)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}`;
}

/** Accepts (a) naive wall clock, (b) ISO 8601 with Z/offset, (c) PHP DateTime object. */
export function parseUpstreamDateTime(raw: unknown): string | null {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (ZONED_RE.test(s)) {
      return madridWallFromInstant(Date.parse(s.replace(" ", "T")));
    }
    return wallFromString(s);
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.date !== "string") return null;
    const tz = typeof obj.timezone === "string" ? obj.timezone.trim() : "";
    if (tz === "Europe/Madrid") return wallFromString(obj.date);
    if (OFFSET_RE.test(tz)) {
      const wall = wallFromString(obj.date);
      if (wall === null) return null;
      return madridWallFromInstant(Date.parse(`${wall.replace(" ", "T")}:00${tz}`));
    }
    return null;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function posInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** A timestamp-like field that, when filled, means the row was cancelled/deleted. */
const CANCELLED_AT_FIELDS = [
  "deletedAt",
  "deleted_at",
  "canceledAt",
  "canceled_at",
  "cancelledAt",
  "cancelled_at",
] as const;
/** A boolean that, when true, means the row was cancelled/deleted. */
const CANCELLED_FLAG_FIELDS = [
  "deleted",
  "isDeleted",
  "canceled",
  "cancelled",
  "isCanceled",
  "isCancelled",
  "anulada",
] as const;
/** A boolean that, when false, means the row no longer stands. */
const ACTIVE_FLAG_FIELDS = ["active", "isActive"] as const;
/** A free status field. */
const STATUS_FIELDS = ["status", "state", "estado", "reservationStatus"] as const;

const ACTIVE_STATUS = new Set(["active", "activa", "activo", "confirmed", "confirmada", "booked", "reservada"]);
const CANCELLED_STATUS = new Set([
  "cancelled",
  "canceled",
  "cancelada",
  "anulada",
  "deleted",
  "borrada",
  "eliminada",
]);

/**
 * The state of one dashboard row (see {@link ReservationState}). A row with
 * none of the fields below — the only shape the real upstream sends — is
 * `"active"`. Any cancellation marker wins; otherwise any value that cannot be
 * read as "still standing" makes the row `"unknown"` (fail-closed).
 */
export function reservationStateOf(rec: Record<string, unknown>): ReservationState {
  let unknown = false;
  for (const f of CANCELLED_AT_FIELDS) {
    const v = rec[f];
    if (v === undefined || v === null || v === "" || v === false) continue;
    return "cancelled";
  }
  for (const f of CANCELLED_FLAG_FIELDS) {
    const v = rec[f];
    if (v === undefined || v === null || v === false || v === 0 || v === "0") continue;
    if (v === true || v === 1 || v === "1") return "cancelled";
    unknown = true;
  }
  for (const f of ACTIVE_FLAG_FIELDS) {
    const v = rec[f];
    if (v === undefined || v === null || v === true || v === 1 || v === "1") continue;
    if (v === false || v === 0 || v === "0") return "cancelled";
    unknown = true;
  }
  for (const f of STATUS_FIELDS) {
    const v = rec[f];
    if (v === undefined || v === null) continue;
    const s = typeof v === "string" ? v.trim().toLowerCase() : null;
    if (s !== null && CANCELLED_STATUS.has(s)) return "cancelled";
    if (s === null || !ACTIVE_STATUS.has(s)) unknown = true;
  }
  return unknown ? "unknown" : "active";
}

/**
 * THE one filter every WhatsApp self-service read goes through (lookup,
 * cancel re-read, post-delete check, voice-change lookup).
 *
 * - `live`: rows that still stand — the only ones listed or cancellable.
 * - `notCancelled`: rows NOT known to be cancelled (live + unknown). The
 *   post-delete check uses it: an unknown row still counts as "there", so a
 *   failed delete is never reported as done on a guess.
 */
export function splitByState(rows: readonly DashboardReservation[]): {
  live: DashboardReservation[];
  notCancelled: DashboardReservation[];
  cancelled: number;
  unknown: number;
} {
  const live = rows.filter((r) => r.state === "active");
  const notCancelled = rows.filter((r) => r.state !== "cancelled");
  return {
    live,
    notCancelled,
    cancelled: rows.length - notCancelled.length,
    unknown: notCancelled.length - live.length,
  };
}

/** ASSUMPTION (phase 0): array at the root or `{ data: [...] }`. */
export function mapDashboardResponse(data: unknown): {
  rows: DashboardReservation[];
  unparseable: number;
} {
  let list: unknown[] | null = null;
  if (Array.isArray(data)) list = data;
  else {
    const rec = asRecord(data);
    if (rec && Array.isArray(rec.data)) list = rec.data;
  }
  if (list === null) return { rows: [], unparseable: 0 };

  const rows: DashboardReservation[] = [];
  let unparseable = 0;
  for (const item of list) {
    const rec = asRecord(item);
    const id = rec ? posInt(rec.id) : null;
    const startsAt = rec ? parseUpstreamDateTime(rec.reservationDate) : null;
    if (rec === null || id === null || startsAt === null) {
      unparseable += 1;
      continue;
    }
    const phone = typeof rec.ownerPhone === "string" ? normalizeSpanishPhone(rec.ownerPhone) : null;
    const emp = asRecord(rec.employee);
    const empName = emp && typeof emp.name === "string" ? cleanEmployeeName(emp.name) : undefined;
    rows.push({
      id,
      startsAt,
      ownerPhoneE164: phone && phone.ok ? phone.e164 : null,
      ownerName: typeof rec.ownerName === "string" ? rec.ownerName : "",
      ownerSurnames: typeof rec.ownerSurnames === "string" ? rec.ownerSurnames : "",
      employeeId: emp ? posInt(emp.id) : null,
      employeeName: empName ?? null,
      typeReservation:
        typeof rec.typeReservation === "number" && Number.isInteger(rec.typeReservation)
          ? rec.typeReservation
          : null,
      state: reservationStateOf(rec),
    });
  }
  return { rows, unparseable };
}
