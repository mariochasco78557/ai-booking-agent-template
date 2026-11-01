import type { TaskPriority } from "../../utils/concurrency.js";
import type { AgendaRead, EmployeeScope } from "./agendaCache.js";
import type { AgendaSource } from "./agendaSource.js";

/**
 * What `AvailabilityService` needs from the agenda layer, and nothing more.
 *
 * The interface exists so the read path is identical whether or not a cache is
 * configured. `AgendaCache` implements it; {@link DirectAgendaReader} below
 * implements it by always going upstream. Turning the cache off is therefore a
 * change of ONE wiring line in the container, and the optimized direct path —
 * batched `employees[]`, bounded concurrency, reused JWT — keeps working
 * unchanged, which is exactly the "aunque la caché quede vacía" requirement.
 */
export interface AgendaReader {
  read(
    date: string,
    serviceId: string,
    scope: EmployeeScope,
    priority?: TaskPriority,
  ): Promise<AgendaRead>;

  /** Reads upstream with the cache out of the path. Used before every write. */
  readFresh(date: string, serviceId: string): Promise<AgendaRead>;

  /** Drops cached days for a date (optionally one service). Returns entries dropped. */
  invalidate(date: string, serviceId?: string): number;
}

/**
 * An `AgendaReader` with no cache at all: every read is an upstream read.
 *
 * Not a stub — this is the fallback the service runs on when
 * `ENABLE_AGENDA_CACHE=false`, and it still gets the batched `employees[]`
 * fan-out and the shared concurrency limiter. Disabling the cache costs
 * latency, never correctness.
 */
export class DirectAgendaReader implements AgendaReader {
  constructor(private readonly source: AgendaSource) {}

  async read(
    date: string,
    serviceId: string,
    _scope: EmployeeScope,
    priority: TaskPriority = "interactive",
  ): Promise<AgendaRead> {
    const day = await this.source.fetchDay(date, serviceId, priority);
    return { day, outcome: "miss", ageMs: 0 };
  }

  async readFresh(date: string, serviceId: string): Promise<AgendaRead> {
    const day = await this.source.fetchDay(date, serviceId, "interactive");
    return { day, outcome: "bypass", ageMs: 0 };
  }

  invalidate(): number {
    return 0;
  }
}
