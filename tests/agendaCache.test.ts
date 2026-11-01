import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgendaCache,
  AGENDA_CONTRACT_VERSION,
  agendaKey,
  type AgendaCacheOptions,
} from "../src/services/agenda/agendaCache.js";
import type { AgendaDay, AgendaSource } from "../src/services/agenda/agendaSource.js";

/**
 * step LAT — the agenda cache.
 *
 * The single most important test in this file is
 * "readFresh NEVER answers from cache": it is the line between a cache that
 * offers options and a cache that authorizes a double booking.
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** `now` is mutable so freshness can be tested without waiting in real time. */
let clock = Date.parse("2026-09-01T09:00:00Z");
const now = (): number => clock;

/** A controllable stand-in for the real upstream reader. */
class FakeSource {
  calls: Array<{ date: string; serviceId: string; priority: string }> = [];
  /** Slot times returned per `${date}|${service}`; absent = one default slot. */
  slotsByKey = new Map<string, string[]>();
  failNext = 0;
  /** Resolves each fetch only when released, when set. */
  gate: Promise<void> | undefined;

  async fetchDay(date: string, serviceId: string, priority = "interactive"): Promise<AgendaDay> {
    this.calls.push({ date, serviceId, priority });
    if (this.gate) await this.gate;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("upstream unavailable");
    }
    const starts = this.slotsByKey.get(`${date}|${serviceId}`) ?? [`${date} 10:00:00`];
    return {
      date,
      serviceId,
      employees: starts.length === 0 ? [] : [{ id: 1, name: "Bruno", surnames: "Demo" }],
      free:
        starts.length === 0
          ? []
          : [
              {
                id: 1,
                name: "bruno ",
                surnames: "demo-salon",
                date: `${date} 14:00:00`,
                slots: starts.map((s) => ({ start: s, end: s })),
              },
            ],
      fetchedAtMs: now(),
      upstreamCalls: starts.length === 0 ? 1 : 2,
    };
  }

  get callCount(): number {
    return this.calls.length;
  }
}

function makeCache(
  source: FakeSource,
  overrides: Partial<AgendaCacheOptions> = {},
): AgendaCache {
  return new AgendaCache(
    source as unknown as AgendaSource,
    {
      nearTtlMs: 90_000,
      farTtlMs: 300_000,
      nearHorizonDays: 7,
      negativeTtlMs: 45_000,
      jitterRatio: 0,
      staleCeilingMs: 600_000,
      maxEntries: 120,
      maxSnapshotBytes: 8_388_608,
      now,
      random: () => 0.5, // jitter multiplier of exactly 1 when ratio is 0
      ...overrides,
    },
    silentLogger,
  );
}

/** A date `offset` days after the cache's fake "today". */
function dayAt(offset: number): string {
  return new Date(clock + offset * 86_400_000).toISOString().slice(0, 10);
}

const ANY = { kind: "any" } as const;

beforeEach(() => {
  clock = Date.parse("2026-09-01T09:00:00Z");
});

describe("AgendaCache — freshness outcomes", () => {
  it("misses once, then hits without touching upstream again", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const date = dayAt(1);

    const first = await cache.read(date, "1", ANY);
    expect(first.outcome).toBe("miss");
    expect(source.callCount).toBe(1);

    const second = await cache.read(date, "1", ANY);
    expect(second.outcome).toBe("hit");
    expect(second.ageMs).toBe(0);
    // The hot path makes NO upstream call. This is criterion "ninguna ruta
    // caliente debe hacer llamadas upstream".
    expect(source.callCount).toBe(1);
  });

  it("uses the near TTL inside the near horizon and the far TTL beyond it", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const near = dayAt(1);
    const far = dayAt(10);

    await cache.read(near, "1", ANY);
    await cache.read(far, "1", ANY);
    expect(source.callCount).toBe(2);

    // 2 minutes on: the near day is past its 90 s target, the far day is not.
    clock += 120_000;
    expect((await cache.read(near, "1", ANY)).outcome).toBe("stale");
    expect((await cache.read(far, "1", ANY)).outcome).toBe("hit");
  });

  it("gives a day with no slots a SHORTER ttl than a day with slots", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const empty = dayAt(1);
    const full = dayAt(2);
    source.slotsByKey.set(`${empty}|1`, []);

    await cache.read(empty, "1", ANY);
    await cache.read(full, "1", ANY);

    // 60 s: past the 45 s negative TTL, inside the 90 s positive one. A fully
    // booked day is exactly where a cancellation matters most.
    clock += 60_000;
    expect((await cache.read(empty, "1", ANY)).outcome).toBe("stale");
    expect((await cache.read(full, "1", ANY)).outcome).toBe("hit");
  });

  it("applies jitter inside the configured band so entries do not expire in lockstep", async () => {
    const randoms = [0, 0.5, 1];
    const expiries: number[] = [];
    for (const r of randoms) {
      const source = new FakeSource();
      const cache = makeCache(source, { jitterRatio: 0.2, random: () => r });
      const date = dayAt(1);
      await cache.read(date, "1", ANY);
      // Walk the clock forward until the entry stops being a hit.
      let elapsed = 0;
      while ((await cache.read(date, "1", ANY)).outcome === "hit" && elapsed < 200_000) {
        clock += 1_000;
        elapsed += 1_000;
      }
      expiries.push(elapsed);
      clock = Date.parse("2026-09-01T09:00:00Z");
    }
    // ±20% of 90 s => roughly 72 s..108 s, and genuinely different per entry.
    expect(Math.min(...expiries)).toBeGreaterThanOrEqual(70_000);
    expect(Math.max(...expiries)).toBeLessThanOrEqual(110_000);
    expect(new Set(expiries).size).toBeGreaterThan(1);
  });
});

describe("AgendaCache — stale-while-revalidate", () => {
  it("answers a stale entry IMMEDIATELY and refreshes behind the caller", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const date = dayAt(1);
    source.slotsByKey.set(`${date}|1`, [`${date} 10:00:00`]);
    await cache.read(date, "1", ANY);

    clock += 120_000;
    source.slotsByKey.set(`${date}|1`, [`${date} 11:00:00`]);

    const stale = await cache.read(date, "1", ANY);
    expect(stale.outcome).toBe("stale");
    // Served the OLD value without waiting — the caller is on the phone.
    expect(stale.day.free[0]?.slots[0]?.start).toBe(`${date} 10:00:00`);
    expect(stale.ageMs).toBe(120_000);

    await new Promise((r) => setImmediate(r));
    // ...and the refresh happened behind them.
    expect(source.callCount).toBe(2);
    expect((await cache.read(date, "1", ANY)).day.free[0]?.slots[0]?.start).toBe(
      `${date} 11:00:00`,
    );
  });

  it("refuses to serve an entry past the stale ceiling, even with upstream down", async () => {
    const source = new FakeSource();
    const cache = makeCache(source, { staleCeilingMs: 300_000 });
    const date = dayAt(1);
    await cache.read(date, "1", ANY);

    // Upstream goes away, so nothing can refresh the entry and it keeps
    // ageing — the situation the ceiling exists for.
    source.failNext = 99;

    clock += 299_000;
    const withinCeiling = await cache.read(date, "1", ANY);
    // Still inside the bound: answer immediately rather than leave a caller in
    // silence, and try to refresh behind them.
    expect(withinCeiling.outcome).toBe("stale");
    await new Promise((r) => setImmediate(r));

    clock += 2_000; // now 301 s old, beyond the 300 s ceiling
    // Past the bound the cache will NOT speak. It goes upstream, and because
    // upstream is down the read fails loudly instead of offering an hour we no
    // longer stand behind. `/ai/voice/availability` turns that into the
    // scripted "no puedo consultar la agenda" answer (src/routes/ai.ts).
    await expect(cache.read(date, "1", ANY)).rejects.toThrow("upstream unavailable");
  });

  it("keeps answering from cache while upstream is failing, then recovers", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const date = dayAt(1);
    await cache.read(date, "1", ANY);

    clock += 120_000;
    source.failNext = 5;

    const degraded = await cache.read(date, "1", ANY);
    expect(degraded.outcome).toBe("stale");
    await new Promise((r) => setImmediate(r));
    expect(cache.metrics.refreshFailed).toBeGreaterThan(0);
    expect(cache.metrics.consecutiveFailures).toBeGreaterThan(0);

    // Upstream comes back: the very next refresh clears the failure streak
    // with no intervention ("recuperación automática").
    source.failNext = 0;
    clock += 120_000;
    await cache.read(date, "1", ANY);
    await new Promise((r) => setImmediate(r));
    expect(cache.metrics.consecutiveFailures).toBe(0);
  });
});

describe("AgendaCache — stampede protection", () => {
  it("collapses a cold burst for the same day into ONE upstream fan-out", async () => {
    const source = new FakeSource();
    let release!: () => void;
    source.gate = new Promise<void>((r) => {
      release = r;
    });
    const cache = makeCache(source);
    const date = dayAt(1);

    const burst = Array.from({ length: 12 }, () => cache.read(date, "1", ANY));
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all(burst);

    // Twelve simultaneous callers, one fetch. Without single-flight this is
    // twelve fan-outs against the salon's API at the same instant.
    expect(source.callCount).toBe(1);
  });

  it("does not collapse DIFFERENT days into one another", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    await Promise.all([
      cache.read(dayAt(1), "1", ANY),
      cache.read(dayAt(2), "1", ANY),
      cache.read(dayAt(1), "2", ANY),
    ]);
    expect(source.callCount).toBe(3);
  });
});

describe("AgendaCache — the write boundary ((internal doc, not included in the template) ADR-010)", () => {
  it("*** readFresh NEVER answers from cache, however warm it is ***", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const date = dayAt(1);
    source.slotsByKey.set(`${date}|1`, [`${date} 10:00:00`]);

    // Warm, and provably hitting.
    await cache.read(date, "1", ANY);
    expect((await cache.read(date, "1", ANY)).outcome).toBe("hit");
    expect(source.callCount).toBe(1);

    // Someone books that hour elsewhere; the cache still says it is free.
    source.slotsByKey.set(`${date}|1`, []);

    const fresh = await cache.readFresh(date, "1");
    expect(fresh.outcome).toBe("bypass");
    expect(source.callCount).toBe(2);
    // The revalidation sees the TRUTH, not the cached picture. This is what
    // turns a would-be double booking into `slot_taken`.
    expect(fresh.day.free).toEqual([]);
  });

  it("readFresh is not deduplicated against an in-flight background refresh", async () => {
    const source = new FakeSource();
    let release!: () => void;
    source.gate = new Promise<void>((r) => {
      release = r;
    });
    const cache = makeCache(source);
    const date = dayAt(1);

    const backgroundRefresh = cache.refresh(date, "1", "background");
    await new Promise((r) => setImmediate(r));
    const revalidation = cache.readFresh(date, "1");
    await new Promise((r) => setImmediate(r));

    release();
    await Promise.all([backgroundRefresh, revalidation]);

    // TWO calls, not one. A booking must never be authorized by a read that
    // started before the customer said "sí".
    expect(source.callCount).toBe(2);
  });

  it("readFresh stores what it read, so the next offer is the fresh picture", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const date = dayAt(1);
    source.slotsByKey.set(`${date}|1`, [`${date} 12:00:00`]);

    await cache.readFresh(date, "1");
    const next = await cache.read(date, "1", ANY);
    expect(next.outcome).toBe("hit");
    expect(next.day.free[0]?.slots[0]?.start).toBe(`${date} 12:00:00`);
    expect(source.callCount).toBe(1);
  });

  it("invalidate() drops a day so the very next read cannot be served stale", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const date = dayAt(1);
    await cache.read(date, "1", ANY);
    await cache.read(date, "2", ANY);

    expect(cache.invalidate(date, "1")).toBe(1);
    expect((await cache.read(date, "1", ANY)).outcome).toBe("miss");
    expect((await cache.read(date, "2", ANY)).outcome).toBe("hit");

    // Without a service id, every service for that date goes.
    expect(cache.invalidate(date)).toBe(2);
    expect(cache.size).toBe(0);
  });

  it("invalidate() leaves other dates alone", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    await cache.read(dayAt(1), "1", ANY);
    await cache.read(dayAt(2), "1", ANY);
    cache.invalidate(dayAt(1));
    expect((await cache.read(dayAt(2), "1", ANY)).outcome).toBe("hit");
  });
});

describe("AgendaCache — bounds", () => {
  it("evicts the FURTHEST-out day first when over the entry ceiling", async () => {
    const source = new FakeSource();
    const cache = makeCache(source, { maxEntries: 3 });
    await cache.read(dayAt(1), "1", ANY);
    await cache.read(dayAt(9), "1", ANY);
    await cache.read(dayAt(2), "1", ANY);
    await cache.read(dayAt(3), "1", ANY); // pushes over the ceiling

    expect(cache.size).toBe(3);
    expect(cache.metrics.evictions).toBe(1);
    // Tomorrow survives; next fortnight is what gets dropped, because near
    // days are both the most asked about and the most volatile.
    expect(cache.peek(dayAt(1), "1")).toBeDefined();
    expect(cache.peek(dayAt(9), "1")).toBeUndefined();
  });

  it("keeps its footprint tiny for a realistic 14-day, 3-service window", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    for (let offset = 0; offset < 14; offset += 1) {
      const date = dayAt(offset);
      source.slotsByKey.set(
        `${date}|1`,
        Array.from({ length: 20 }, (_, i) => `${date} ${String(9 + (i % 10)).padStart(2, "0")}:00:00`),
      );
      for (const service of ["0", "1", "2"]) await cache.read(date, service, ANY);
    }
    expect(cache.size).toBe(42);
    const bytes = cache.health().approx_bytes as number;
    // The mission's ceiling is "muy inferior a 256 MB". This is kilobytes.
    expect(bytes).toBeLessThan(1_000_000);
  });
});

describe("AgendaCache — persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "demo-salon-agenda-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through a snapshot, and every loaded entry starts STALE", async () => {
    const snapshotPath = join(dir, "agenda.json");
    const source = new FakeSource();
    const cache = makeCache(source, { snapshotPath });
    const date = dayAt(1);
    await cache.read(date, "1", ANY);
    expect(cache.saveSnapshot()).toBe(true);

    const source2 = new FakeSource();
    const restored = makeCache(source2, { snapshotPath });
    expect(restored.loadSnapshot()).toBe(1);
    expect(restored.size).toBe(1);

    // Immediately usable — that is the whole point, a restart must not begin
    // with a cold miss on a live call...
    const read = await restored.read(date, "1", ANY);
    expect(read.outcome).toBe("stale");
    expect(read.day.free[0]?.slots[0]?.start).toBe(`${date} 10:00:00`);
    // ...but never trusted without revalidation.
    await new Promise((r) => setImmediate(r));
    expect(source2.callCount).toBe(1);
  });

  it("discards a snapshot written under a different contract version", () => {
    const snapshotPath = join(dir, "agenda.json");
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        version: 1,
        contract: AGENDA_CONTRACT_VERSION + 1,
        savedAtMs: clock,
        entries: [{ key: "whatever", day: { employees: [], free: [] } }],
      }),
    );
    const cache = makeCache(new FakeSource(), { snapshotPath });
    // A cold start, never a migration: a stale cache is cheap, a misread
    // agenda is not.
    expect(cache.loadSnapshot()).toBe(0);
    expect(cache.size).toBe(0);
  });

  it("starts cold rather than throwing when the snapshot is missing or corrupt", () => {
    const missing = makeCache(new FakeSource(), { snapshotPath: join(dir, "nope.json") });
    expect(missing.loadSnapshot()).toBe(0);

    const corruptPath = join(dir, "corrupt.json");
    writeFileSync(corruptPath, "{ this is not json");
    const corrupt = makeCache(new FakeSource(), { snapshotPath: corruptPath });
    expect(corrupt.loadSnapshot()).toBe(0);
  });

  it("refuses to write a snapshot over the size ceiling", async () => {
    const snapshotPath = join(dir, "agenda.json");
    const source = new FakeSource();
    const cache = makeCache(source, { snapshotPath, maxSnapshotBytes: 200 });
    await cache.read(dayAt(1), "1", ANY);
    expect(cache.saveSnapshot()).toBe(false);
  });

  it("leaves no temp file behind after a successful write", async () => {
    const snapshotPath = join(dir, "agenda.json");
    const cache = makeCache(new FakeSource(), { snapshotPath });
    await cache.read(dayAt(1), "1", ANY);
    cache.saveSnapshot();
    expect(() => readFileSync(snapshotPath, "utf8")).not.toThrow();
    expect(() => readFileSync(`${snapshotPath}.tmp`, "utf8")).toThrow();
  });

  it("is a no-op when no snapshot path is configured", async () => {
    const cache = makeCache(new FakeSource());
    await cache.read(dayAt(1), "1", ANY);
    expect(cache.saveSnapshot()).toBe(false);
    expect(cache.loadSnapshot()).toBe(0);
  });
});

describe("AgendaCache — observability", () => {
  it("reports counts, ages and timings and NEVER a date, barber or slot", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const date = dayAt(1);
    await cache.read(date, "1", ANY);
    await cache.read(date, "1", ANY);
    cache.setWarmupState("warm");

    const health = cache.health();
    expect(health.entries).toBe(1);
    expect(health.hits).toBe(1);
    expect(health.misses).toBe(1);
    expect(health.warmup).toBe("warm");
    expect(health.hit_ratio).toBe(0.5);
    expect(health.cache_lookup_ms_avg).not.toBeNull();
    expect(health.upstream_calls).toBeGreaterThan(0);

    // /health is unauthenticated. The salon's free hours are its commercial
    // information and must not leak through a liveness endpoint.
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(date);
    expect(serialized).not.toContain("bruno");
    expect(serialized).not.toContain("10:00");
    expect(serialized).not.toContain("employee");
  });

  it("counts every outcome separately", async () => {
    const source = new FakeSource();
    const cache = makeCache(source);
    const date = dayAt(1);
    await cache.read(date, "1", ANY); // miss
    await cache.read(date, "1", ANY); // hit
    clock += 120_000;
    await cache.read(date, "1", ANY); // stale
    await cache.readFresh(date, "1"); // bypass

    expect(cache.metrics.misses).toBe(1);
    expect(cache.metrics.hits).toBe(1);
    expect(cache.metrics.stale).toBe(1);
    expect(cache.metrics.bypasses).toBe(1);
  });
});

describe("agendaKey", () => {
  it("separates date, service and employee scope, and carries the contract version", () => {
    expect(agendaKey("2026-09-01", "1", { kind: "any" })).toBe(
      `v${AGENDA_CONTRACT_VERSION}|2026-09-01|s1|any`,
    );
    expect(agendaKey("2026-09-01", "1", { kind: "one", employeeId: 1 })).toBe(
      `v${AGENDA_CONTRACT_VERSION}|2026-09-01|s1|emp1`,
    );
    // Different services are different keys: verified live 2026-08-30 that
    // service type genuinely changes the slots returned for the same day.
    expect(agendaKey("2026-09-01", "2", { kind: "any" })).not.toBe(
      agendaKey("2026-09-01", "1", { kind: "any" }),
    );
  });
});
