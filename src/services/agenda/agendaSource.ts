import type { CalendarProvider, CalendarResource, ResourceFreeSlots } from "../../core/calendar/CalendarProvider.js";
import type { PriorityLimiter, TaskPriority } from "../../utils/concurrency.js";

/**
 * step LAT — the ONE place a day of agenda is read from the salon's API.
 *
 * Everything that needs availability goes through here: the live voice path,
 * the background refresher, and the pre-write revalidation. That is
 * deliberate. The cache in `agendaCache.ts` sits IN FRONT of this class, never
 * inside it, so "read the agenda, bypassing every cache" is a call to this
 * object and needs no flag, no parameter and no trust in a caller remembering
 * to pass one.
 *
 * The two upstream endpoints carry different halves of the truth, and neither
 * is derivable from the other or from a static schedule:
 *
 * - `/user/employees-day` — WHO works that day. Holidays, vacations and
 *   absences are already applied upstream: a barber on holiday is simply not
 *   in the list.
 * - `/user/free` — WHEN each of them is free. Existing reservations and
 *   breaks are already applied upstream: a booked hour is simply not a slot.
 *
 * We never infer opening hours, never assume a weekly pattern, and never
 * synthesise a slot. If upstream did not return it, it does not exist.
 */

/** One (date, service) pair's complete agenda, for every barber on duty. */
export interface AgendaDay {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** Upstream `type` / `typeReservation`, as a string (e.g. `"1"`). */
  readonly serviceId: string;
  /** The day's roster from `/user/employees-day`, in upstream order. */
  readonly employees: readonly CalendarResource[];
  /**
   * Free slots from `/user/free`.
   *
   * A barber with no free slot is ABSENT from this array — verified live
   * 2026-08-30, and identical to the per-employee shape. Read it with
   * {@link freeFor}, never by index.
   */
  readonly free: readonly ResourceFreeSlots[];
  /** Epoch ms at which this snapshot was read from upstream. */
  readonly fetchedAtMs: number;
  /** Upstream calls this snapshot cost (login excluded). */
  readonly upstreamCalls: number;
}

/** That barber's free record, or undefined when they have no free slot. */
export function freeFor(
  day: Pick<AgendaDay, "free">,
  employeeId: number,
): ResourceFreeSlots | undefined {
  // Strict id match, never `free[0]`: in a batched response a positional
  // fallback would attribute one barber's slots to another.
  return day.free.find((record) => record.id === employeeId);
}

/** True when nobody works that day, or nobody has a single free slot. */
export function isEmptyDay(day: Pick<AgendaDay, "employees" | "free">): boolean {
  return day.employees.length === 0 || day.free.every((record) => record.slots.length === 0);
}

export class AgendaSource {
  constructor(
    private readonly calendar: CalendarProvider,
    private readonly limiter: PriorityLimiter,
  ) {}

  /**
   * Reads one (date, service) day directly from upstream. Always uncached.
   *
   * Two upstream calls, whatever the roster size: one `/user/employees-day`,
   * then ONE `/user/free` carrying every barber of that day as repeated
   * `employees[]` params. Before this, the same day cost `1 + N` calls issued
   * sequentially — for a three-barber Friday, four round trips instead of two,
   * and the three `/user/free` calls waited on each other for no reason.
   *
   * The JWT is reused from the calendar adapter's token cache (already single-flighted
   * and cached to ~90% of the token's real lifetime), so a warm process pays
   * no login cost here at all.
   */
  async fetchDay(
    date: string,
    serviceId: string,
    priority: TaskPriority = "interactive",
  ): Promise<AgendaDay> {
    // Session warmed OUTSIDE the limiter, as before: a login never holds an
    // upstream concurrency slot.
    await this.calendar.ensureSession();

    const employees = await this.limiter.run(priority, () =>
      this.calendar.listResourcesForDay(date),
    );

    // Nobody on duty: a closed day, a bank holiday, or everyone away. There is
    // no second call to make — asking `/user/free` for an empty employee list
    // would be a round trip whose answer we already know.
    if (employees.length === 0) {
      return {
        date,
        serviceId,
        employees: [],
        free: [],
        fetchedAtMs: Date.now(),
        upstreamCalls: 1,
      };
    }

    const free = await this.limiter.run(priority, () =>
      this.calendar.listFreeSlots({
        date,
        resourceIds: employees.map((employee) => employee.id),
        serviceId,
      }),
    );

    return {
      date,
      serviceId,
      employees,
      // Defensive: keep only barbers actually on duty today. Upstream has
      // never returned a stray id, but a `/user/free` record for someone
      // absent from `/user/employees-day` would mean offering a slot with a
      // barber on holiday — the one mistake this whole path exists to avoid.
      free: free.filter((record) => employees.some((employee) => employee.id === record.id)),
      fetchedAtMs: Date.now(),
      upstreamCalls: 2,
    };
  }
}
