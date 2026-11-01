import { describe, it, expect, beforeEach } from "vitest";

import { AgendaCache, type AgendaCacheOptions } from "../src/services/agenda/agendaCache.js";
import {
  AgendaRefresher,
  callsPerSweep,
  estimateDailyUpstreamCalls,
  madridDate,
  madridHour,
  type AgendaRefresherOptions,
} from "../src/services/agenda/agendaRefresher.js";
import type { AgendaDay, AgendaSource } from "../src/services/agenda/agendaSource.js";

/**
 * step LAT — the background scheduler.
 *
 * The mission's instruction was explicit: "No consultes toda la agenda cada
 * cinco minutos sin medir el coste." These tests are that measurement, pinned
 * so a later tuning change cannot quietly multiply the load on the salon's API.
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

let clock = Date.parse("2026-09-01T09:00:00Z"); // 11:00 Europe/Madrid, active hours
const now = (): number => clock;

class FakeSource {
  calls: Array<{ date: string; serviceId: string }> = [];
  failAll = false;

  async fetchDay(date: string, serviceId: string): Promise<AgendaDay> {
    this.calls.push({ date, serviceId });
    if (this.failAll) throw new Error("upstream unavailable");
    return {
      date,
      serviceId,
      employees: [{ id: 1, name: "Bruno", surnames: "Demo" }],
      free: [
        {
          id: 1,
          name: "bruno ",
          surnames: "demo-salon",
          date: `${date} 14:00:00`,
          slots: [{ start: `${date} 10:00:00`, end: `${date} 10:30:00` }],
        },
      ],
      fetchedAtMs: now(),
      upstreamCalls: 2,
    };
  }
}

function makeCache(source: FakeSource, overrides: Partial<AgendaCacheOptions> = {}): AgendaCache {
  return new AgendaCache(
    source as unknown as AgendaSource,
    {
      nearTtlMs: 90_000,
      farTtlMs: 300_000,
      nearHorizonDays: 7,
      negativeTtlMs: 45_000,
      jitterRatio: 0,
      staleCeilingMs: 600_000,
      maxEntries: 200,
      maxSnapshotBytes: 8_388_608,
      now,
      random: () => 0.5,
      ...overrides,
    },
    silentLogger,
  );
}

const BASE_OPTIONS: AgendaRefresherOptions = {
  horizonDays: 14,
  serviceIds: ["0", "1", "2"],
  nearIntervalMs: 90_000,
  farIntervalMs: 300_000,
  nearHorizonDays: 7,
  tickMs: 15_000,
  maxKeysPerTick: 8,
  refreshConcurrency: 3,
  quietFromHour: 22,
  quietToHour: 8,
  quietFactor: 6,
  maxBackoffFactor: 32,
  snapshotIntervalMs: 60_000,
  now,
};

function makeRefresher(
  cache: AgendaCache,
  overrides: Partial<AgendaRefresherOptions> = {},
): AgendaRefresher {
  return new AgendaRefresher(cache, { ...BASE_OPTIONS, ...overrides }, silentLogger);
}

beforeEach(() => {
  clock = Date.parse("2026-09-01T09:00:00Z");
});

describe("upstream cost — measured, not assumed", () => {
  it("costs 1 employees-day per date plus 1 free per service", () => {
    // 14 dates × (1 + 3) = 56 calls for one full sweep of the shipped window.
    expect(callsPerSweep(14, 3)).toBe(56);
    expect(callsPerSweep(7, 1)).toBe(14);
  });

  it("reports the daily call count the shipped defaults actually imply", () => {
    const daily = estimateDailyUpstreamCalls(BASE_OPTIONS);
    // The number that goes in the boot log and in (internal doc, not included in the template).
    // Pinned so a tuning change that multiplies upstream load has to change
    // this line and be seen doing it.
    expect(daily).toBeGreaterThan(20_000);
    expect(daily).toBeLessThan(25_000);
  });

  it("shows the quiet-hours damper is worth roughly a third of the load", () => {
    const damped = estimateDailyUpstreamCalls(BASE_OPTIONS);
    const undamped = estimateDailyUpstreamCalls({ ...BASE_OPTIONS, quietFactor: 1 });
    expect(undamped).toBeGreaterThan(damped * 1.4);
    // ~35 000/day undamped is the figure the design rejected as an
    // irresponsible default against one small shared Symfony host.
    expect(undamped).toBeGreaterThan(30_000);
  });

  it("scales down proportionally when the service list is trimmed", () => {
    const three = estimateDailyUpstreamCalls(BASE_OPTIONS);
    const one = estimateDailyUpstreamCalls({ ...BASE_OPTIONS, serviceIds: ["1"] });
    // 1 + 1 vs 1 + 3 calls per date: the first knob to reach for if the salon's
    // host ever needs relief.
    expect(one).toBeLessThan(three * 0.6);
  });

  it("scales down proportionally when the window is shortened", () => {
    const fourteen = estimateDailyUpstreamCalls(BASE_OPTIONS);
    const seven = estimateDailyUpstreamCalls({ ...BASE_OPTIONS, horizonDays: 7 });
    expect(seven).toBeLessThan(fourteen);
  });
});

describe("Europe/Madrid clock helpers", () => {
  it("reads the salon's local hour, not UTC, across DST", () => {
    // Summer: CEST is UTC+2.
    expect(madridHour(Date.parse("2026-07-01T09:00:00Z"))).toBe(11);
    // Winter: CET is UTC+1.
    expect(madridHour(Date.parse("2026-01-15T09:00:00Z"))).toBe(10);
  });

  it("reads the salon's local DATE, so 'today' rolls over at Madrid midnight", () => {
    // 23:30 in Madrid on 1 September is still 21:30 UTC on 1 September.
    expect(madridDate(Date.parse("2026-09-01T21:30:00Z"))).toBe("2026-09-01");
    // 00:30 Madrid on 2 September is 22:30 UTC on 1 September — and the window
    // must already have rolled to the 2nd, or the refresher spends the small
    // hours warming yesterday.
    expect(madridDate(Date.parse("2026-09-01T22:30:00Z"))).toBe("2026-09-02");
  });
});

describe("quiet hours", () => {
  it("treats the salon's closed hours as quiet, across midnight", () => {
    const refresher = makeRefresher(makeCache(new FakeSource()));
    // 02:00 Madrid — shut.
    expect(refresher.isQuietHour(Date.parse("2026-09-01T00:00:00Z"))).toBe(true);
    // 23:00 Madrid — shut.
    expect(refresher.isQuietHour(Date.parse("2026-09-01T21:00:00Z"))).toBe(true);
    // 11:00 Madrid — open.
    expect(refresher.isQuietHour(Date.parse("2026-09-01T09:00:00Z"))).toBe(false);
    // 09:00 Madrid, right after the window closes — open.
    expect(refresher.isQuietHour(Date.parse("2026-09-01T07:00:00Z"))).toBe(false);
  });

  it("can be disabled by setting both bounds equal", () => {
    const refresher = makeRefresher(makeCache(new FakeSource()), {
      quietFromHour: 0,
      quietToHour: 0,
    });
    expect(refresher.isQuietHour(Date.parse("2026-09-01T00:00:00Z"))).toBe(false);
  });
});

describe("warmup", () => {
  it("materializes the whole rolling window and marks the cache warm", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const refresher = makeRefresher(cache, { horizonDays: 3, serviceIds: ["0", "1", "2"] });

    refresher.start();
    await new Promise((r) => setTimeout(r, 50));
    await refresher.stop();

    expect(cache.size).toBe(9); // 3 days × 3 services
    expect(cache.health().warmup).toBe("warm");
    expect(cache.metrics.lastFullRefreshOkMs).not.toBeNull();
  });

  it("NEVER blocks or throws when upstream is unreachable at boot", async () => {
    const source = new FakeSource();
    source.failAll = true;
    const cache = makeCache(source);
    const refresher = makeRefresher(cache, { horizonDays: 2, serviceIds: ["1"] });

    // start() must return synchronously whatever upstream is doing: a
    // middleware that cannot boot because the salon's API is down cannot even
    // answer "I am up, the agenda is unavailable".
    expect(() => refresher.start()).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));

    expect(cache.size).toBe(0);
    expect(cache.health().warmup).toBe("cold");
    await refresher.stop();
  });

  it("reports 'degraded' when only part of the window could be warmed", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const refresher = makeRefresher(cache, { horizonDays: 4, serviceIds: ["1"] });

    // Fail after the first two days have been fetched.
    let fetched = 0;
    const original = source.fetchDay.bind(source);
    source.fetchDay = async (date: string, serviceId: string) => {
      fetched += 1;
      if (fetched > 2) throw new Error("upstream unavailable");
      return original(date, serviceId);
    };

    refresher.start();
    await new Promise((r) => setTimeout(r, 50));
    await refresher.stop();

    expect(cache.size).toBeGreaterThan(0);
    expect(cache.health().warmup).toBe("degraded");
  });
});

describe("scheduling and shutdown", () => {
  it("refreshes only the keys that are actually due", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const refresher = makeRefresher(cache, {
      horizonDays: 2,
      serviceIds: ["1"],
      tickMs: 10,
      maxKeysPerTick: 8,
    });

    refresher.start();
    await new Promise((r) => setTimeout(r, 40));
    const afterWarmup = source.calls.length;
    expect(afterWarmup).toBe(2);

    // Ticks keep firing, but nothing is due yet, so nothing is fetched.
    await new Promise((r) => setTimeout(r, 60));
    expect(source.calls.length).toBe(afterWarmup);

    // Push past the near interval: now both keys are due.
    clock += 120_000;
    await new Promise((r) => setTimeout(r, 60));
    expect(source.calls.length).toBeGreaterThan(afterWarmup);

    await refresher.stop();
  });

  it("spreads a sweep across ticks instead of bursting it", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const refresher = makeRefresher(cache, {
      horizonDays: 10,
      serviceIds: ["1"],
      tickMs: 10,
      maxKeysPerTick: 2,
    });
    refresher.start();
    await new Promise((r) => setTimeout(r, 50));
    const afterWarmup = source.calls.length;

    clock += 400_000; // everything is overdue at once
    await new Promise((r) => setTimeout(r, 25));
    const refreshed = source.calls.length - afterWarmup;
    // At most 2 per tick: a stampede against upstream is impossible even when
    // the entire window expires together.
    expect(refreshed).toBeGreaterThan(0);
    expect(refreshed).toBeLessThanOrEqual(8);

    await refresher.stop();
  });

  it("stops cleanly: the timer is cleared and no further work happens", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const refresher = makeRefresher(cache, {
      horizonDays: 1,
      serviceIds: ["1"],
      tickMs: 5,
    });
    refresher.start();
    await new Promise((r) => setTimeout(r, 30));
    await refresher.stop();

    const afterStop = source.calls.length;
    clock += 600_000; // everything is now wildly overdue
    await new Promise((r) => setTimeout(r, 50));
    // A stopped refresher makes no calls, whatever the clock says. Otherwise
    // the test suite itself would never exit.
    expect(source.calls.length).toBe(afterStop);
  });

  it("stop() is idempotent and safe before start()", async () => {
    const refresher = makeRefresher(makeCache(new FakeSource()));
    await expect(refresher.stop()).resolves.toBeUndefined();
    await expect(refresher.stop()).resolves.toBeUndefined();
  });

  it("backs off while upstream keeps failing", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const refresher = makeRefresher(cache, {
      horizonDays: 1,
      serviceIds: ["1"],
      tickMs: 5,
    });

    refresher.start();
    await new Promise((r) => setTimeout(r, 30));
    source.failAll = true;
    clock += 200_000;
    await new Promise((r) => setTimeout(r, 40));

    const duringOutage = source.calls.length;
    expect(cache.metrics.consecutiveFailures).toBeGreaterThan(0);

    // The backoff multiplier now holds the interval well above the elapsed
    // age, so retries slow down instead of hammering a struggling upstream.
    await new Promise((r) => setTimeout(r, 40));
    expect(source.calls.length - duringOutage).toBeLessThan(duringOutage);

    await refresher.stop();
  });
});
