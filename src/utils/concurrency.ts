/**
 * step LAT — the two primitives every upstream fan-out in this service is
 * built on: a bounded, two-lane concurrency limiter and a single-flight map.
 *
 * Both exist for the same reason: the salon's Symfony API is a small shared
 * host, and the failure mode we are engineering against is not "slow", it is
 * "we made it slow ourselves". A 7-day availability question fans out into
 * more than a dozen upstream calls; a background cache refresh fans out into
 * dozens more. Left unbounded they would arrive together.
 */

/**
 * Which lane a task queues in when the limiter is full.
 *
 * `interactive` is a caller waiting on the phone right now. `background` is
 * the agenda refresher, which has no one waiting and can always afford to go
 * last. The distinction is the whole point of this class: a single FIFO
 * semaphore would let a refresh cycle that started 50 ms earlier put a live
 * call behind dozens of its own requests.
 */
export type TaskPriority = "interactive" | "background";

interface Waiter {
  resolve: () => void;
}

export interface LimiterStats {
  active: number;
  queuedInteractive: number;
  queuedBackground: number;
}

/**
 * A semaphore with a strict capacity and two priority lanes. `interactive`
 * waiters are always served before `background` ones, whatever order they
 * queued in.
 *
 * Capacity is a hard ceiling on simultaneous upstream requests across the
 * WHOLE process, refresher included — that is what makes "never more than N
 * requests against LegacyBackend at once" a property of the system rather than a
 * hope about how the callers happen to interleave.
 */
export class PriorityLimiter {
  private active = 0;
  private readonly interactive: Waiter[] = [];
  private readonly background: Waiter[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("PriorityLimiter capacity must be a positive integer");
    }
  }

  /** Runs `fn` once a slot is free, always releasing the slot afterwards. */
  async run<T>(priority: TaskPriority, fn: () => Promise<T>): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats(): LimiterStats {
    return {
      active: this.active,
      queuedInteractive: this.interactive.length,
      queuedBackground: this.background.length,
    };
  }

  private acquire(priority: TaskPriority): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const lane = priority === "interactive" ? this.interactive : this.background;
      lane.push({ resolve });
    });
  }

  private release(): void {
    // The slot is HANDED OVER to the next waiter rather than freed and
    // re-acquired: decrementing `active` here and letting the waiter race for
    // it again would briefly let a newly arriving task overtake the queue.
    const next = this.interactive.shift() ?? this.background.shift();
    if (next !== undefined) {
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}

/**
 * Collapses concurrent calls for the same key onto ONE in-flight promise.
 *
 * This is the anti-stampede primitive. Without it, a cache entry expiring
 * while three calls are mid-flight produces three identical upstream fan-outs
 * — and an expiry during a busy minute produces as many as there are callers.
 * With it, the first caller does the work and the rest await the same promise.
 *
 * Rejections are shared too, deliberately: if the upstream call failed, it
 * failed for every waiter, and re-running it per waiter would be exactly the
 * stampede this exists to prevent.
 */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;

    // Wrapped in an async IIFE so a `fn` that throws SYNCHRONOUSLY still
    // produces a rejected promise we can clean up, instead of throwing past
    // the map insertion and leaving nothing to delete.
    const started = (async () => fn())().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, started);
    return started;
  }

  /** True when a call for this key is currently in flight. */
  has(key: string): boolean {
    return this.inflight.has(key);
  }

  get size(): number {
    return this.inflight.size;
  }
}

/**
 * Maps `items` through `fn` with at most `concurrency` running at once,
 * preserving input order in the result.
 *
 * Used for the per-date fan-out. Note it does NOT itself bound upstream
 * concurrency — {@link PriorityLimiter} does, globally. This only bounds how
 * many dates are in flight, so a 7-day question does not build a 7-deep
 * queue inside the limiter and delay a second caller behind all of it.
 */
export async function mapWithConcurrency<I, O>(
  items: readonly I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as I, index);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
