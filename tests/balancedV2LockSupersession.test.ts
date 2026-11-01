import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  SLOT_TOKEN_SECRET,
  UPSTREAM,
  buildTestApp,
  fakeJwt,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import { BRUNO, RAMON, OLGA, conv, v2, v2Book } from "./helpers/balancedV2.js";
import { SlotAuthorizationService } from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaRead } from "../src/services/agenda/agendaCache.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";

/**
 * BALANCED V2 — ONLY A LOCK REPLACES A LOCK ((internal doc, not included in the template) ADR-022).
 *
 * The property: whatever the agent does, `/ai/voice/v2/book` can only write
 * the slot sealed by the conversation's MOST RECENT SUCCESSFUL lock — the one
 * whose `slot` (date, time, professional) the summary is read from.
 *
 * Why this suite exists (2026-09-15):
 *
 * 1. With the discover look-ahead, «¿y con Olga?» on a day Olga is full now
 *    OFFERS hours of another day. Under the old rule (a query with ≥1 slot
 *    retires the lock) that re-opened the 2026-09-14 incident: lock Ramón
 *    09:00 → ask for Olga → keep Ramón → create refused.
 * 2. The prompt's recovery for that refusal was a SILENT re-lock by
 *    `option_index` of «the same slot» plus a create without re-confirmation.
 *    `option_index` resolves against the CURRENT page, so after the Olga page
 *    it would lock (and book) Olga on another day — a slot nobody confirmed.
 *    Proven below, then made unnecessary.
 */

const DAY_MS = 86_400_000;

function futureWeekday(weekday: number): string {
  for (let offset = 3; offset < 11; offset += 1) {
    const candidate = new Date(Date.now() + offset * DAY_MS);
    if (candidate.getUTCDay() === weekday) return candidate.toISOString().slice(0, 10);
  }
  throw new Error("unreachable");
}

function plusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A Saturday; Sunday and Monday are closed, so its next open day is Tuesday. */
const SATURDAY = futureWeekday(6);
const TUESDAY = plusDays(SATURDAY, 3);

type Roster = Array<{ id: number; name: string; surnames: string }>;
type DayFixture = { roster: Roster; free: Record<number, string[]> };

/**
 * Saturday: Ramón free at 09:00 and 17:00, Olga on duty with nothing.
 * Tuesday: Olga free in the morning, Ramón on duty with nothing — so
 * «¿y con Olga?» on Saturday is answered by the look-ahead with Tuesday.
 */
const WEEK: Record<string, DayFixture> = {
  [SATURDAY]: { roster: [RAMON, OLGA], free: { [RAMON.id]: ["09:00", "17:00"] } },
  [TUESDAY]: { roster: [RAMON, OLGA], free: { [OLGA.id]: ["09:30", "10:00"] } },
};

/** Date-aware upstream: every date not in `WEEK` has nobody on duty. */
function mockWeek(): void {
  nock(UPSTREAM).persist().post(`${BASE_PATH}/login`).reply(200, { token: fakeJwt() });
  const dateOf = (uri: string): string => /date=([0-9-]+)/.exec(uri)?.[1] ?? "";
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/employees-day`)
    .query(true)
    .reply((uri) => [200, WEEK[dateOf(uri)]?.roster ?? []]);
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/free`)
    .query(true)
    .reply((uri) => {
      const date = dateOf(uri);
      const fixture = WEEK[date];
      const ids = [...uri.matchAll(/employees(?:\[\]|%5B%5D)=(\d+)/g)].map((m) => Number(m[1]));
      const records = ids
        .map((id) => {
          const times = fixture?.free[id] ?? [];
          const employee = fixture?.roster.find((entry) => entry.id === id);
          if (times.length === 0 || employee === undefined) return undefined;
          return {
            id,
            name: employee.name,
            surnames: employee.surnames,
            date: `${date} 14:00:00`,
            slots: times.map((time) => ({ start: `${date} ${time}:00`, end: `${date} ${time}:00` })),
          };
        })
        .filter((record) => record !== undefined);
      return [200, records];
    });
}

interface Written {
  employeeId: number;
  reservationDate: string;
}

/** Captures every upstream create: WHAT was written, not just how many. */
function mockCreate(): { writes: Written[] } {
  const writes: Written[] = [];
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply((_uri, body) => {
      const parsed = (typeof body === "string" ? JSON.parse(body) : body) as {
        employee: { id: number };
        reservationDate: string;
      };
      writes.push({ employeeId: parsed.employee.id, reservationDate: parsed.reservationDate });
      return [200, { id: 97_000 + writes.length }];
    });
  return { writes };
}

const CUSTOMER = {
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: "600000123",
  confirmed_by_customer: true,
};

interface LockedSlot {
  date: string;
  time: string;
  employee_id: number;
  slot_token: string;
}


// ── the lock itself, under concurrency (service level) ─────────────────────

const NOW = Date.parse("2026-09-15T10:00:00Z");
const CONV = "conv_test_adr022_concurrency";
const DATE = "2026-09-22";

function dayWith(free: Record<number, string[]>): AgendaDay {
  return {
    date: DATE,
    serviceId: "1",
    employees: [BRUNO, OLGA],
    free: [BRUNO, OLGA].flatMap((employee) => {
      const times = free[employee.id] ?? [];
      if (times.length === 0) return [];
      return [{
        id: employee.id,
        name: employee.name,
        surnames: employee.surnames,
        date: `${DATE} 14:00:00`,
        slots: times.map((time) => ({ start: `${DATE} ${time}:00`, end: `${DATE} ${time}:00` })),
      }];
    }),
    fetchedAtMs: NOW,
    upstreamCalls: 2,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OPEN = dayWith({ [BRUNO.id]: ["10:00", "11:00", "12:00"] });

function harness() {
  const freshQueue: Array<() => Promise<AgendaRead>> = [];
  const day = { current: OPEN };
  const agenda: AgendaReader = {
    read: async () => ({ day: day.current, outcome: "miss", ageMs: 0 }),
    readFresh: () => (freshQueue.shift() ?? (async () => ({ day: OPEN, outcome: "bypass" as const, ageMs: 0 })))(),
    invalidate: () => 0,
  };
  const offers = new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 16 });
  const logs: Array<Record<string, unknown>> = [];
  const service = new BalancedAvailabilityService({
    agenda,
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
    offerStore: offers,
    closedWeekdays: new Set(),
    logger: { warn: (detail) => logs.push(detail), info: (detail) => logs.push(detail) },
  });
  return { service, offers, freshQueue, logs, day };
}

const discoverBody = { conversation_id: CONV, service_id: 1, date: DATE, time_period: "morning" };

describe("balanced v2 · lock under concurrency (ADR-022)", () => {
  it("nothing is bookable while a new lock is in flight; then only the new token is", async () => {
    const { service, offers, freshQueue } = harness();
    await service.discover(discoverBody, NOW);
    const first = await service.lock({ conversation_id: CONV, option_index: 1 }, NOW);
    const tokenA = first.slot!.slot_token;

    const pending = deferred<AgendaRead>();
    freshQueue.push(() => pending.promise);
    const inFlight = service.lock({ conversation_id: CONV, option_index: 2 }, NOW);
    expect(offers.authorizes(CONV, tokenA, NOW)).toEqual({ ok: false, refusal: "refreshing" });

    pending.resolve({ day: OPEN, outcome: "bypass", ageMs: 0 });
    const second = await inFlight;
    expect(second.outcome).toBe("locked");
    expect(offers.authorizes(CONV, tokenA, NOW)).toEqual({ ok: false, refusal: "stale_token" });
    expect(offers.authorizes(CONV, second.slot!.slot_token, NOW).ok).toBe(true);
  });

  it("a lock whose hour was taken puts the previous lock back, logged without secrets", async () => {
    const { service, offers, freshQueue, logs } = harness();
    await service.discover(discoverBody, NOW);
    const tokenA = (await service.lock({ conversation_id: CONV, option_index: 1 }, NOW)).slot!.slot_token;

    freshQueue.push(async () => ({ day: dayWith({ [BRUNO.id]: ["10:00"] }), outcome: "bypass", ageMs: 0 }));
    const taken = await service.lock({ conversation_id: CONV, option_index: 2 }, NOW);
    expect(taken.outcome).toBe("slot_taken");
    expect(offers.authorizes(CONV, tokenA, NOW).ok).toBe(true);

    const kept = logs.filter((entry) => entry["previous_lock_kept"] === true);
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0])).not.toContain(tokenA);
  });

  it("a lock whose agenda read throws puts the previous lock back", async () => {
    const { service, offers, freshQueue } = harness();
    await service.discover(discoverBody, NOW);
    const tokenA = (await service.lock({ conversation_id: CONV, option_index: 1 }, NOW)).slot!.slot_token;

    freshQueue.push(async () => {
      throw new Error("agenda down");
    });
    await expect(service.lock({ conversation_id: CONV, option_index: 2 }, NOW)).rejects.toThrow("agenda down");
    expect(offers.authorizes(CONV, tokenA, NOW).ok).toBe(true);
  });

  it("an option this conversation is not holding touches nothing", async () => {
    const { service, offers, day } = harness();
    await service.discover(discoverBody, NOW);
    const tokenA = (await service.lock({ conversation_id: CONV, option_index: 1 }, NOW)).slot!.slot_token;
    const generation = offers.peek(CONV, NOW)?.generation;

    // The caller asks about a day with nothing: the page is now empty.
    day.current = dayWith({});
    await service.discover(discoverBody, NOW);
    const missing = await service.lock({ conversation_id: CONV, option_index: 1 }, NOW);
    expect(missing.outcome).toBe("option_not_found");

    expect(offers.authorizes(CONV, tokenA, NOW).ok).toBe(true);
    expect(offers.peek(CONV, NOW)?.generation).toBe(generation);
  });

  it("of two overlapping locks, the later one wins and the earlier is not announced as locked", async () => {
    const { service, offers, freshQueue } = harness();
    await service.discover(discoverBody, NOW);

    const slow = deferred<AgendaRead>();
    const fast = deferred<AgendaRead>();
    freshQueue.push(() => slow.promise, () => fast.promise);
    const earlier = service.lock({ conversation_id: CONV, option_index: 1 }, NOW);
    const later = service.lock({ conversation_id: CONV, option_index: 2 }, NOW);

    fast.resolve({ day: OPEN, outcome: "bypass", ageMs: 0 });
    const laterResult = await later;
    slow.resolve({ day: OPEN, outcome: "bypass", ageMs: 0 });
    const earlierResult = await earlier;

    expect(laterResult.outcome).toBe("locked");
    expect(earlierResult.outcome).toBe("option_not_found");
    expect(earlierResult.slot).toBeUndefined();
    expect(offers.authorizes(CONV, laterResult.slot!.slot_token, NOW).ok).toBe(true);
  });
});
