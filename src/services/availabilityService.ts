import type { CalendarProvider, CalendarResource, ResourceFreeSlots } from "../core/calendar/CalendarProvider.js";
import type { AvailabilityInput, CheckSlotInput } from "../schemas/aiSchemas.js";
import type { AgendaReader } from "./agenda/agendaReader.js";
import { freeFor, type AgendaDay } from "./agenda/agendaSource.js";
import {
  parseDateTime,
  timeLabelFromString,
} from "../utils/dateFormatterEs.js";
import { availabilityMessage, checkSlotMessage } from "../utils/phrasing.js";

export interface AvailabilityDefaults {
  employeeId: number;
  typeReservation: string;
  maxSlots: number;
  /**
   * When true, availability/check-slot with no explicit `employeeId` fan out
   * across all barbers from `/user/employees-day` (per-employee `/user/free` +
   * merge). When false (default), the original single-employee behaviour is
   * preserved byte-for-byte. See (internal doc, not included in the template) ADR-007.
   */
  multiBarber: boolean;
  /**
   * step 10 lab upstream mode (src/config/env.ts's `BOOKING_UPSTREAM_MODE`).
   * 'legacy' (default) preserves every existing code path byte-for-byte.
   * 'ai' calls the disposable lab's `/v1/ai/availability` and
   * `/v1/ai/availability/slot` endpoints instead — see getAvailabilityAi()/
   * checkSlotAi() below.
   */
  upstreamMode: "legacy" | "ai";
}

export interface SlotOut {
  start: string;
  label: string;
  /** Additive (multi-barber only): the barber offering this slot. */
  employeeId?: number;
  /** Additive (multi-barber only): the barber's display name (trailing space preserved). */
  employeeName?: string;
}

export interface AvailabilityResult {
  available: boolean;
  message: string;
  slots: SlotOut[];
}

export interface CheckSlotResult {
  available: boolean;
  message: string;
  /** Additive (multi-barber only): the barber found free at that exact time. */
  employeeId?: number;
  employeeName?: string;
}

/** Resolution used by the booking service to pick a concrete barber. */
export interface ResolvedEmployee {
  available: boolean;
  employee?: CalendarResource;
}

/** A candidate slot, optionally tagged with the barber offering it. */
interface SlotWithEmployee {
  start: string;
  employee?: CalendarResource;
}

/** Minutes-from-midnight for a "HH:mm" string. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when a slot start string matches the target date-time components. */
function sameDateTime(
  slotStart: string,
  target: ReturnType<typeof parseDateTime>,
): boolean {
  const sp = parseDateTime(slotStart);
  return Boolean(
    target &&
      sp &&
      sp.year === target.year &&
      sp.month === target.month &&
      sp.day === target.day &&
      sp.hour === target.hour &&
      sp.minute === target.minute,
  );
}

/**
 * Turns an {@link AgendaDay} into the `{ employees, freeByEmployee }` shape the
 * rest of this service was already written against, optionally narrowed to one
 * barber.
 *
 * The lookup is a STRICT id match. The old per-employee code could fall back
 * to `free[0]` because a per-employee response could only ever describe the
 * barber it was asked about; in a batched response that same fallback would
 * hand one barber's free hours to another. Verified live 2026-08-30: a barber
 * with no free slot is simply absent from `/user/free`, so "not found" means
 * "not free", and there is nothing to fall back to.
 */
function projectDay(
  day: AgendaDay,
  onlyEmployeeId?: number,
): { employees: CalendarResource[]; freeByEmployee: Map<number, ResourceFreeSlots> } {
  const employees =
    onlyEmployeeId != null
      ? day.employees.filter((e) => e.id === onlyEmployeeId)
      : [...day.employees];

  const freeByEmployee = new Map<number, ResourceFreeSlots>();
  for (const employee of employees) {
    const record = freeFor(day, employee.id);
    if (record) freeByEmployee.set(employee.id, record);
  }
  return { employees, freeByEmployee };
}

export class AvailabilityService {
  constructor(
    private readonly calendar: CalendarProvider,
    private readonly defaults: AvailabilityDefaults,
    private readonly agenda: AgendaReader,
  ) {}

  async getAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
    const type = input.typeReservation ?? this.defaults.typeReservation;
    const maxSlots = input.maxSlots ?? this.defaults.maxSlots;

    if (this.defaults.upstreamMode === "ai") {
      return this.getAvailabilityAi(input, type, maxSlots);
    }

    let rawSlots: SlotWithEmployee[];

    if (this.defaults.multiBarber && input.employeeId == null) {
      // Multi-barber, no preference: fan out across all barbers of the day and
      // merge slots time-first, deduplicating identical start times. The barber
      // attributed to a shared time is chosen deterministically (lowest id).
      const { employees, freeByEmployee } = await this.fetchDay(input.date, type);
      const byTime = new Map<string, SlotWithEmployee>();
      for (const emp of [...employees].sort((a, b) => a.id - b.id)) {
        const rec = freeByEmployee.get(emp.id);
        if (!rec) continue;
        for (const slot of rec.slots) {
          if (!byTime.has(slot.start)) {
            byTime.set(slot.start, { start: slot.start, employee: emp });
          }
        }
      }
      rawSlots = [...byTime.values()];
    } else if (this.defaults.multiBarber) {
      // Multi-barber ON with an explicit employeeId (specific-barber flow).
      // step LAT routes this through the agenda layer too, so asking for
      // "Bruno" is served from the SAME cached day as asking for "cualquiera" —
      // two views of one snapshot, which cannot contradict each other.
      const employeeId = input.employeeId ?? this.defaults.employeeId;
      const { employees, freeByEmployee } = await this.fetchDay(input.date, type, employeeId);
      const emp = employees.find((e) => e.id === employeeId);
      const rec = freeByEmployee.get(employeeId);
      rawSlots = (rec?.slots ?? []).map((s) => ({
        start: s.start,
        employee: emp ? { id: emp.id, name: emp.name, surnames: emp.surnames } : undefined,
      }));
    } else {
      // Multi-barber OFF: the original single-employee behaviour, preserved
      // byte-for-byte (this flag's documented contract — see
      // AvailabilityDefaults.multiBarber). No `/user/employees-day` call, and
      // the historical `?? free[0]` fallback is kept exactly as it was.
      const employeeId = input.employeeId ?? this.defaults.employeeId;
      const free = await this.calendar.listFreeSlots({
        date: input.date,
        resourceIds: [employeeId],
        serviceId: type,
      });
      const rec = free.find((e) => e.id === employeeId) ?? free[0];
      rawSlots = (rec?.slots ?? []).map((s) => ({
        start: s.start,
        employee: undefined,
      }));
    }

    // Sort: near preferredTime first if given, otherwise chronological.
    const sorted = [...rawSlots].sort((a, b) => {
      if (input.preferredTime) {
        const target = toMinutes(input.preferredTime);
        const da = Math.abs(toMinutes(timeLabelFromString(a.start)) - target);
        const db = Math.abs(toMinutes(timeLabelFromString(b.start)) - target);
        if (da !== db) return da - db;
      }
      return a.start.localeCompare(b.start);
    });

    const limited = sorted.slice(0, maxSlots);
    // When we prefer a time, present the chosen few in chronological order.
    const display = [...limited].sort((a, b) => a.start.localeCompare(b.start));

    const slots: SlotOut[] = display.map((s) => ({
      start: s.start,
      label: timeLabelFromString(s.start),
      ...(s.employee
        ? { employeeId: s.employee.id, employeeName: s.employee.name }
        : {}),
    }));

    return {
      available: slots.length > 0,
      message: availabilityMessage(
        slots.map((s) => s.start),
        { hasMore: sorted.length > limited.length },
      ),
      slots,
    };
  }

  async checkSlot(input: CheckSlotInput): Promise<CheckSlotResult> {
    if (this.defaults.upstreamMode === "ai") {
      return this.checkSlotAi(input);
    }

    const datePart = input.reservationDate.slice(0, 10);
    const target = parseDateTime(input.reservationDate);

    if (this.defaults.multiBarber && input.employeeId == null) {
      // Multi-barber, no preference: any barber free at that exact time makes
      // the slot available. Pick the barber deterministically (lowest id).
      const { employees, freeByEmployee } = await this.fetchDay(
        datePart,
        this.defaults.typeReservation,
      );
      let chosen: CalendarResource | undefined;
      for (const emp of [...employees].sort((a, b) => a.id - b.id)) {
        const rec = freeByEmployee.get(emp.id);
        if (!rec) continue;
        if (rec.slots.some((s) => sameDateTime(s.start, target))) {
          chosen = emp;
          break;
        }
      }
      const available = chosen != null;
      return {
        available,
        message: checkSlotMessage(available, input.reservationDate),
        ...(chosen ? { employeeId: chosen.id, employeeName: chosen.name } : {}),
      };
    }

    if (this.defaults.multiBarber) {
      // Explicit barber, multi-barber ON: same cached day as the "any" view.
      const employeeId = input.employeeId ?? this.defaults.employeeId;
      const { employees, freeByEmployee } = await this.fetchDay(
        datePart,
        this.defaults.typeReservation,
        employeeId,
      );
      const record = freeByEmployee.get(employeeId);
      const available = (record?.slots ?? []).some((s) => sameDateTime(s.start, target));
      const employee = employees.find((e) => e.id === employeeId);
      const out: CheckSlotResult = {
        available,
        message: checkSlotMessage(available, input.reservationDate),
      };
      if (employee) {
        out.employeeId = employee.id;
        out.employeeName = employee.name;
      }
      return out;
    }

    // Multi-barber OFF: original behaviour, preserved byte-for-byte.
    const employeeId = input.employeeId ?? this.defaults.employeeId;
    const free = await this.calendar.listFreeSlots({
      date: datePart,
      resourceIds: [employeeId],
      serviceId: this.defaults.typeReservation,
    });
    const employee = free.find((e) => e.id === employeeId) ?? free[0];
    const slots = employee?.slots ?? [];
    const available = slots.some((s) => sameDateTime(s.start, target));

    return {
      available,
      message: checkSlotMessage(available, input.reservationDate),
    };
  }

  /**
   * Resolve a concrete barber for an exact booking slot (multi-barber mode).
   * If `employeeId` is given, only that barber is considered; otherwise the
   * first available barber (lowest id, deterministic) is chosen. Returns the
   * barber's real `{ id, name, surnames }` from `/user/employees-day` so the
   * booking payload carries the correct display fields (trailing spaces kept).
   *
   * *** THIS READ BYPASSES THE CACHE, ALWAYS. ***
   *
   * It is the last check before a real appointment is written into a real
   * salon's diary, and it is the ONLY thing standing between a slot that was
   * offered up to a couple of minutes ago and a double booking. `fetchDayFresh`
   * goes to `/user/employees-day` + `/user/free` every single time, with no
   * cache in the path and no single-flight sharing with a background refresh
   * that may have started before the caller said "sí".
   *
   * If you are about to make this cheaper by reading the cache here, read
   * (internal doc, not included in the template) ADR-010 first. The cache exists to OFFER options; it
   * is never allowed to AUTHORIZE a write.
   */
  async resolveEmployeeForBooking(input: {
    reservationDate: string;
    employeeId?: number;
    type: string;
  }): Promise<ResolvedEmployee> {
    const datePart = input.reservationDate.slice(0, 10);
    const target = parseDateTime(input.reservationDate);
    const { employees, freeByEmployee } = await this.fetchDayFresh(
      datePart,
      input.type,
      input.employeeId,
    );
    const ordered =
      input.employeeId != null
        ? employees
        : [...employees].sort((a, b) => a.id - b.id);
    for (const emp of ordered) {
      const rec = freeByEmployee.get(emp.id);
      if (!rec) continue;
      if (rec.slots.some((s) => sameDateTime(s.start, target))) {
        return {
          available: true,
          employee: { id: emp.id, name: emp.name, surnames: emp.surnames },
        };
      }
    }
    return { available: false };
  }

  /**
   * Drops every cached view of a day, then warms it again in the background.
   *
   * Called right after a booking attempt CHANGES anything upstream — both on
   * success and on a slot-taken conflict, because both mean the cached picture
   * of that day is now wrong. Invalidation is synchronous (so the very next
   * read cannot be served the stale day), the re-warm is detached (so the
   * caller who just booked is not made to wait for it).
   */
  invalidateAndWarm(date: string, serviceId: string): number {
    const dropped = this.agenda.invalidate(date, serviceId);
    void this.agenda
      .read(date, serviceId, { kind: "any" }, "background")
      .catch(() => undefined);
    return dropped;
  }

  /**
   * The day's barbers and their free slots, through the agenda layer.
   *
   * step LAT replaced what used to live here: a sequential `for` loop issuing
   * one `/user/free` per barber, each waiting on the last. It now goes through
   * {@link AgendaReader}, which reads the whole day in TWO upstream calls
   * (`/user/employees-day` + one batched `/user/free` carrying every barber as
   * repeated `employees[]`) and serves it from cache when it can.
   *
   * `onlyEmployeeId` narrows the RESULT, not the request. The upstream cost of
   * one barber and of the whole roster is now identical — one batched call —
   * so fetching the day and filtering keeps a single cache entry serving both
   * the "cualquier profesional" and the specific-barber views, instead of two
   * entries that could disagree about the same hour.
   */
  private async fetchDay(
    date: string,
    type: string,
    onlyEmployeeId?: number,
  ): Promise<{
    employees: CalendarResource[];
    freeByEmployee: Map<number, ResourceFreeSlots>;
  }> {
    const read = await this.agenda.read(
      date,
      type,
      onlyEmployeeId != null ? { kind: "one", employeeId: onlyEmployeeId } : { kind: "any" },
    );
    return projectDay(read.day, onlyEmployeeId);
  }

  /**
   * Same shape as {@link fetchDay}, but read straight from upstream with the
   * cache bypassed entirely.
   *
   * Used by exactly one caller: {@link resolveEmployeeForBooking}, immediately
   * before a write. See (internal doc, not included in the template) ADR-010 — a cached slot may be
   * OFFERED, never BOOKED.
   */
  private async fetchDayFresh(
    date: string,
    type: string,
    onlyEmployeeId?: number,
  ): Promise<{
    employees: CalendarResource[];
    freeByEmployee: Map<number, ResourceFreeSlots>;
  }> {
    const read = await this.agenda.readFresh(date, type);
    return projectDay(read.day, onlyEmployeeId);
  }

  // ---------------------------------------------------------------------
  // step 10 lab upstream mode (`upstreamMode === "ai"`). Calls the
  // disposable-lab Symfony `/v1/ai/availability(/slot)` contract instead of
  // legacy `/user/free`. Only reached when BOOKING_UPSTREAM_MODE=ai; the
  // 'legacy' branches above are entirely untouched by this code.
  // ---------------------------------------------------------------------

  private async getAvailabilityAi(
    input: AvailabilityInput,
    type: string,
    maxSlots: number,
  ): Promise<AvailabilityResult> {
    const envelope = await this.calendar.checkAvailability({
      date: input.date,
      typeReservation: Number(type),
      ...(input.employeeId != null ? { employeeIds: [input.employeeId] } : {}),
      maxSlots,
    });

    // In-band failures (e.g. CLOSED_HOLIDAY) are still HTTP 200 with
    // `ok:false` and an empty `employees` list (design §7.1) -- treated the
    // same as "no slots today", never surfaced as a technical error.
    const employees = envelope.ok ? envelope.data.employees ?? [] : [];

    const raw: Array<{ start: string; employee?: CalendarResource }> = [];
    for (const emp of employees) {
      for (const hhmm of emp.slots) {
        raw.push({
          start: `${input.date} ${hhmm}:00`,
          employee: { id: emp.employeeId, name: emp.name, surnames: "" },
        });
      }
    }

    const sorted = [...raw].sort((a, b) => {
      if (input.preferredTime) {
        const target = toMinutes(input.preferredTime);
        const da = Math.abs(toMinutes(timeLabelFromString(a.start)) - target);
        const db = Math.abs(toMinutes(timeLabelFromString(b.start)) - target);
        if (da !== db) return da - db;
      }
      return a.start.localeCompare(b.start);
    });
    const limited = sorted.slice(0, maxSlots);
    const display = [...limited].sort((a, b) => a.start.localeCompare(b.start));

    const slots: SlotOut[] = display.map((s) => ({
      start: s.start,
      label: timeLabelFromString(s.start),
      ...(s.employee ? { employeeId: s.employee.id, employeeName: s.employee.name } : {}),
    }));

    return {
      available: slots.length > 0,
      message: availabilityMessage(
        slots.map((s) => s.start),
        { hasMore: sorted.length > limited.length },
      ),
      slots,
    };
  }

  private async checkSlotAi(input: CheckSlotInput): Promise<CheckSlotResult> {
    const employeeId = input.employeeId ?? this.defaults.employeeId;
    const envelope = await this.calendar.checkSlot({
      reservationDate: input.reservationDate,
      employeeId,
      typeReservation: Number(this.defaults.typeReservation),
    });

    // CLOSED_HOLIDAY (or any other in-band failure) -> simply not available,
    // never a technical error surfaced to the caller (design §7.1).
    const available = envelope.ok ? Boolean(envelope.data.available) : false;

    return {
      available,
      message: checkSlotMessage(available, input.reservationDate),
      employeeId,
    };
  }
}
