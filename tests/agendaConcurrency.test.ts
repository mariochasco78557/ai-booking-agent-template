import { describe, it, expect } from "vitest";
import {
  PriorityLimiter,
  SingleFlight,
  mapWithConcurrency,
} from "../src/utils/concurrency.js";

/**
 * step LAT — the two primitives every upstream fan-out rests on.
 *
 * These are the tests that make "we never hit the salon's API with more than N
 * requests at once" a checked property rather than a claim in a comment.
 */

/** A promise plus the handles to settle it from the test body. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("PriorityLimiter", () => {
  it("never runs more than `capacity` tasks at once, however many are queued", async () => {
    const limiter = new PriorityLimiter(3);
    let active = 0;
    let peak = 0;
    const gate = deferred();

    const tasks = Array.from({ length: 25 }, () =>
      limiter.run("interactive", async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      }),
    );

    await tick();
    // 25 tasks queued, 3 running. This is the mission's "no superes
    // inicialmente tres peticiones simultáneas contra LegacyBackend".
    expect(peak).toBe(3);
    gate.resolve();
    await Promise.all(tasks);
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it("lets a live caller overtake background refresh work already queued", async () => {
    const limiter = new PriorityLimiter(1);
    const order: string[] = [];
    const hold = deferred();

    // Occupy the only slot.
    const blocking = limiter.run("interactive", async () => {
      order.push("blocking");
      await hold.promise;
    });
    await tick();

    // Three refresh tasks queue FIRST...
    const background = [1, 2, 3].map((n) =>
      limiter.run("background", async () => {
        order.push(`bg${n}`);
      }),
    );
    await tick();
    // ...and a phone call arrives LAST.
    const live = limiter.run("interactive", async () => {
      order.push("live");
    });

    hold.resolve();
    await Promise.all([blocking, live, ...background]);

    // The caller on the phone does not wait behind three refreshes that
    // happened to queue a moment earlier.
    expect(order[0]).toBe("blocking");
    expect(order[1]).toBe("live");
    expect(order.slice(2).sort()).toEqual(["bg1", "bg2", "bg3"]);
  });

  it("releases its slot when a task throws, so one failure cannot wedge the limiter", async () => {
    const limiter = new PriorityLimiter(1);
    await expect(
      limiter.run("interactive", async () => {
        throw new Error("upstream exploded");
      }),
    ).rejects.toThrow("upstream exploded");

    // If the slot had leaked, this would hang forever.
    await expect(limiter.run("interactive", async () => "ok")).resolves.toBe("ok");
    expect(limiter.stats()).toEqual({ active: 0, queuedInteractive: 0, queuedBackground: 0 });
  });

  it("rejects a nonsensical capacity rather than silently running unbounded", () => {
    expect(() => new PriorityLimiter(0)).toThrow(/positive integer/);
    expect(() => new PriorityLimiter(-1)).toThrow(/positive integer/);
  });
});

describe("SingleFlight", () => {
  it("collapses concurrent calls for the same key onto ONE execution", async () => {
    const flight = new SingleFlight<number>();
    let executions = 0;
    const gate = deferred();

    const calls = Array.from({ length: 10 }, () =>
      flight.run("same-key", async () => {
        executions += 1;
        await gate.promise;
        return 42;
      }),
    );
    await tick();
    expect(flight.size).toBe(1);

    gate.resolve();
    expect(await Promise.all(calls)).toEqual(Array(10).fill(42));
    // This is the anti-stampede property: one expiry, one upstream fan-out,
    // however many callers were waiting on it.
    expect(executions).toBe(1);
  });

  it("keeps different keys independent", async () => {
    const flight = new SingleFlight<string>();
    const seen: string[] = [];
    await Promise.all([
      flight.run("a", async () => {
        seen.push("a");
        return "a";
      }),
      flight.run("b", async () => {
        seen.push("b");
        return "b";
      }),
    ]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("shares a rejection with every waiter and then clears the key", async () => {
    const flight = new SingleFlight<number>();
    let executions = 0;
    const gate = deferred();

    const calls = [1, 2, 3].map(() =>
      flight.run("k", async () => {
        executions += 1;
        await gate.promise;
        throw new Error("upstream down");
      }),
    );
    await tick();
    gate.resolve();

    for (const call of calls) await expect(call).rejects.toThrow("upstream down");
    // One failure, shared — NOT three retries, which is the stampede this
    // exists to prevent.
    expect(executions).toBe(1);
    expect(flight.size).toBe(0);

    // The key is free again, so a later caller genuinely retries.
    await expect(flight.run("k", async () => 7)).resolves.toBe(7);
    expect(executions).toBe(1);
  });

  it("cleans up after a function that throws synchronously", async () => {
    const flight = new SingleFlight<number>();
    await expect(
      flight.run("sync", () => {
        throw new Error("thrown before any await");
      }),
    ).rejects.toThrow("thrown before any await");
    expect(flight.size).toBe(0);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const delays = [30, 5, 20, 1, 15];
    const out = await mapWithConcurrency(delays, 3, async (ms, index) => {
      await new Promise((r) => setTimeout(r, ms));
      return index;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("bounds how many run at once", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty list without spawning a worker", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});
