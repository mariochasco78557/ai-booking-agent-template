import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../authTokenService.js";
import type { AgendaDay } from "../agenda/agendaSource.js";
import type { AgendaReader } from "../agenda/agendaReader.js";
import type { DashboardRange, DashboardReservation } from "../waSelfService/dashboardMapping.js";
import { parseDateTime } from "../../utils/dateFormatterEs.js";
import { madridDate, madridMinutes, madridWallToEpochMs } from "../../utils/madridDate.js";

/**
 * *** IS THE SALON OPEN? — derived from Bruno's agenda, never typed by hand. ***
 *
 * (internal doc, not included in the template) §A.6. The agenda has no «opening hours»
 * endpoint: it says WHO works a day (`employees-day`, holidays applied; empty =
 * closed) and WHEN each is free (`/user/free`, bookings and breaks already
 * subtracted). So the window of a day is: min/max of {starts and ends of the
 * free slots} ∪ {start and start+N min of every standing booking}. The lunch
 * break stays inside the window, so it counts as open.
 *
 * A fixed safety clamp 07:00–22:00 (Madrid) is NOT a schedule, it is a limit:
 * nothing is ever sent at night, even with strange agenda data.
 *
 * `horario.json` (0600) holds only the day windows: no personal data.
 */

export const SAFETY_FROM_MIN = 7 * 60; // 07:00
export const SAFETY_TO_MIN = 22 * 60; // 22:00
export const REFRESH_INTERVAL_MS = 60 * 60_000;
export const REFRESH_DAYS = 9; // hoy .. hoy+8 (sábado → martes con festivo y un margen)
export const WEEKDAY_TEMPLATE_MAX_AGE_DAYS = 35;
const DAY_MS = 86_400_000;
const KEEP_DAYS = 60;

export interface DayWindow {
  date: string;
  open: boolean;
  startMin: number;
  endMin: number;
  source: "agenda" | "cache_date" | "cache_weekday" | "unknown";
}

export interface OpeningGatePort {
  /** Síncrono, desde memoria. */
  isOpenAt(nowMs: number): boolean;
  windowFor(date: string): DayWindow;
  openMinutesBetween(fromMs: number, toMs: number): number;
}

function minutesOfWall(wall: string): number | undefined {
  const p = parseDateTime(wall);
  return p !== null && p.hasTime ? p.hour * 60 + p.minute : undefined;
}

export function deriveDayWindow(
  day: Pick<AgendaDay, "employees" | "free">,
  rows: ReadonlyArray<Pick<DashboardReservation, "startsAt">> | undefined,
  appointmentMinutes: number,
): { open: false } | { open: true; startMin: number; endMin: number } | { unknown: true } {
  if (day.employees.length === 0) return { open: false };
  const points: number[] = [];
  for (const employee of day.free) {
    for (const slot of employee.slots) {
      const a = minutesOfWall(slot.start);
      const b = minutesOfWall(slot.end);
      if (a !== undefined) points.push(a);
      if (b !== undefined) points.push(b);
    }
  }
  for (const row of rows ?? []) {
    const a = minutesOfWall(row.startsAt);
    if (a === undefined) continue;
    points.push(a, a + appointmentMinutes);
  }
  if (points.length === 0) return { unknown: true };
  const startMin = Math.max(Math.min(...points), SAFETY_FROM_MIN);
  const endMin = Math.min(Math.max(...points), SAFETY_TO_MIN);
  if (startMin >= endMin) return { open: false };
  return { open: true, startMin, endMin };
}

interface StoredDay {
  open: boolean;
  startMin: number;
  endMin: number;
  source: "agenda" | "cache_date";
  fetchedAtMs: number;
}
interface StoredWeekday {
  startMin: number;
  endMin: number;
  fromDate: string;
}
interface HorarioFile {
  v: 1;
  days: Record<string, StoredDay>;
  weekdays: Record<string, StoredWeekday>;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
function dowOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}
function wallToEpoch(date: string, minutes: number): number {
  const [y, m, d] = date.split("-").map(Number);
  return madridWallToEpochMs({
    year: y!,
    month: m!,
    day: d!,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  });
}
function errorLabel(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return error instanceof Error ? error.name : "unknown_error";
}

export class OpeningHoursGate implements OpeningGatePort {
  private days = new Map<string, StoredDay>();
  private weekdays = new Map<number, StoredWeekday>();
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly deps: {
      reader: Pick<AgendaReader, "read">;
      /** waSelfService.readStandingRows */
      standingRows?: (range: DashboardRange) => Promise<DashboardReservation[]>;
      serviceId: string;
      appointmentMinutes: number;
      statePath: string;
      logger: Logger;
    },
  ) {}

  // ── persistence ──────────────────────────────────────────────────────────

  /** Reads `horario.json` (missing or broken: empty, with a warning). */
  load(nowMs: number): void {
    this.days = new Map();
    this.weekdays = new Map();
    let raw: string;
    try {
      raw = readFileSync(this.deps.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.deps.logger.warn({ reason: errorLabel(error) }, "opening hours: horario.json could not be read; starting empty");
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<HorarioFile>;
      if (parsed?.v !== 1 || typeof parsed.days !== "object" || parsed.days === null) throw new Error("shape");
      const today = madridDate(nowMs);
      for (const [date, d] of Object.entries(parsed.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || daysBetween(date, today) > KEEP_DAYS) continue;
        if (typeof d?.open !== "boolean" || typeof d.startMin !== "number" || typeof d.endMin !== "number") continue;
        this.days.set(date, {
          open: d.open,
          startMin: d.startMin,
          endMin: d.endMin,
          source: "cache_date",
          fetchedAtMs: typeof d.fetchedAtMs === "number" ? d.fetchedAtMs : 0,
        });
      }
      for (const [k, w] of Object.entries(parsed.weekdays ?? {})) {
        const dow = Number(k);
        if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
        if (typeof w?.startMin !== "number" || typeof w.endMin !== "number" || typeof w.fromDate !== "string") continue;
        this.weekdays.set(dow, { startMin: w.startMin, endMin: w.endMin, fromDate: w.fromDate });
      }
    } catch {
      this.days = new Map();
      this.weekdays = new Map();
      this.deps.logger.warn({}, "opening hours: horario.json is not valid; starting empty");
    }
  }

  private save(nowMs: number): void {
    try {
      const today = madridDate(nowMs);
      const file: HorarioFile = { v: 1, days: {}, weekdays: {} };
      for (const [date, d] of [...this.days].sort(([a], [b]) => a.localeCompare(b))) {
        if (daysBetween(date, today) > KEEP_DAYS) continue;
        file.days[date] = d;
      }
      for (const [dow, w] of this.weekdays) file.weekdays[String(dow)] = w;
      mkdirSync(dirname(this.deps.statePath), { recursive: true, mode: 0o700 });
      const temp = `${this.deps.statePath}.tmp`;
      writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.deps.statePath);
    } catch (error) {
      this.deps.logger.error({ reason: errorLabel(error) }, "opening hours: horario.json could not be written");
    }
  }

  // ── the port ─────────────────────────────────────────────────────────────

  windowFor(date: string): DayWindow {
    const d = this.days.get(date);
    if (d !== undefined) {
      return { date, open: d.open, startMin: d.startMin, endMin: d.endMin, source: d.source };
    }
    const t = this.weekdays.get(dowOf(date));
    if (t !== undefined && daysBetween(t.fromDate, date) < WEEKDAY_TEMPLATE_MAX_AGE_DAYS) {
      return { date, open: true, startMin: t.startMin, endMin: t.endMin, source: "cache_weekday" };
    }
    return { date, open: false, startMin: 0, endMin: 0, source: "unknown" };
  }

  isOpenAt(nowMs: number): boolean {
    const w = this.windowFor(madridDate(nowMs));
    const m = madridMinutes(nowMs);
    return (
      w.open &&
      w.startMin <= m &&
      m < w.endMin &&
      m >= SAFETY_FROM_MIN &&
      m < SAFETY_TO_MIN
    );
  }

  openMinutesBetween(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0;
    const last = madridDate(toMs);
    let totalMs = 0;
    let date = madridDate(fromMs);
    for (let guard = 0; guard < 400 && date <= last; guard += 1) {
      const w = this.windowFor(date);
      if (w.open) {
        const startMin = Math.max(w.startMin, SAFETY_FROM_MIN);
        const endMin = Math.min(w.endMin, SAFETY_TO_MIN);
        if (startMin < endMin) {
          const a = Math.max(fromMs, wallToEpoch(date, startMin));
          const b = Math.min(toMs, wallToEpoch(date, endMin));
          if (b > a) totalMs += b - a;
        }
      }
      date = addDays(date, 1);
    }
    return Math.floor(totalMs / 60_000);
  }

  // ── refresh ──────────────────────────────────────────────────────────────

  async refresh(nowMs: number): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.doRefresh(nowMs);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private weekdayTemplate(date: string): StoredWeekday | undefined {
    const t = this.weekdays.get(dowOf(date));
    return t !== undefined && daysBetween(t.fromDate, date) < WEEKDAY_TEMPLATE_MAX_AGE_DAYS ? t : undefined;
  }

  private async doRefresh(nowMs: number): Promise<void> {
    const today = madridDate(nowMs);
    const dates = Array.from({ length: REFRESH_DAYS }, (_, i) => addDays(today, i));

    // Bookings: ONE call for the whole range, grouped by date.
    let rowsByDate: Map<string, DashboardReservation[]> | undefined;
    if (this.deps.standingRows !== undefined) {
      try {
        const rows = await this.deps.standingRows({ fromDate: dates[0]!, toDate: dates[dates.length - 1]! });
        rowsByDate = new Map();
        for (const row of rows) {
          const key = row.startsAt.slice(0, 10);
          const list = rowsByDate.get(key);
          if (list === undefined) rowsByDate.set(key, [row]);
          else list.push(row);
        }
      } catch (error) {
        this.deps.logger.warn({ reason: errorLabel(error) }, "opening hours: standing bookings unavailable; using the weekday template");
      }
    }

    let ok = 0;
    let failed = 0;
    for (const date of dates) {
      if (this.stopped) return;
      let day: AgendaDay;
      try {
        day = (await this.deps.reader.read(date, this.deps.serviceId, { kind: "any" }, "background")).day;
      } catch {
        failed += 1; // rule 4: the date keeps what is stored
        continue;
      }
      const rows = rowsByDate === undefined ? undefined : (rowsByDate.get(date) ?? []);
      const derived = deriveDayWindow(day, rows, this.deps.appointmentMinutes);
      if ("unknown" in derived) {
        failed += 1;
        continue;
      }
      ok += 1;
      const stored = this.days.get(date);
      if (!derived.open) {
        if (day.employees.length === 0) {
          // The agenda says nobody works: closed always wins (also today).
          this.days.set(date, { open: false, startMin: 0, endMin: 0, source: "agenda", fetchedAtMs: nowMs });
        } else if (date === today && stored?.open === true) {
          // Today only widens: keep what was stored.
        } else {
          this.days.set(date, { open: false, startMin: 0, endMin: 0, source: "agenda", fetchedAtMs: nowMs });
        }
        continue;
      }
      let { startMin, endMin } = derived;
      if (rows === undefined) {
        // Without the bookings the close could be cut short: widen with the template.
        const t = this.weekdayTemplate(date);
        if (t !== undefined) {
          startMin = Math.min(startMin, t.startMin);
          endMin = Math.max(endMin, t.endMin);
        }
      }
      if (date === today && stored?.open === true) {
        startMin = Math.min(startMin, stored.startMin);
        endMin = Math.max(endMin, stored.endMin);
      }
      startMin = Math.max(startMin, SAFETY_FROM_MIN);
      endMin = Math.min(endMin, SAFETY_TO_MIN);
      this.days.set(date, { open: true, startMin, endMin, source: "agenda", fetchedAtMs: nowMs });
      if (rows !== undefined) this.weekdays.set(dowOf(date), { startMin, endMin, fromDate: date });
    }

    this.save(nowMs);
    const w = this.windowFor(today);
    this.deps.logger.info(
      {
        dates_ok: ok,
        dates_failed: failed,
        today_open: w.open,
        today_start: w.startMin,
        today_end: w.endMin,
        source: w.source,
      },
      "opening hours refreshed",
    );
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const run = (): void => {
      void this.refresh(Date.now()).catch((error: unknown) => {
        this.deps.logger.error({ reason: errorLabel(error) }, "opening hours: refresh failed; the stored windows are unchanged");
      });
    };
    run();
    this.timer = setInterval(run, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }
}
