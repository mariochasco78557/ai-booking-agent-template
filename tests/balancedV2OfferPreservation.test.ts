import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  SLOT_TOKEN_SECRET,
  UPSTREAM,
  buildTestApp,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import { BRUNO, RAMON, OLGA, conv, mockAgendaDay, v2, v2Book } from "./helpers/balancedV2.js";
import { SlotAuthorizationService } from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";

/**
 * BALANCED V2 — a browsing question that offers NOTHING keeps the locked hueco.
 *
 * Production incident 2026-09-14 (conversation id withheld here on purpose):
 *
 * 1. discover → lock Saturday 09:00 with Ramón → `slot_token`.
 * 2. The caller asks for Olga → discover with `employee_id: 2` →
 *    `no_availability`. Nothing was offered.
 * 3. The caller keeps 09:00 with Ramón → create with the step-1 token →
 *    `slot_not_authorized`, because step 2 had retired the lock.
 *
 * The rule proven here (ADR-022, which replaced the 2026-09-15 "restore only
 * when zero slots were offered" fix): a discover/more/scan NEVER retires the
 * locked offer, whether it offers zero slots or many — only a new successful
 * lock does. The old token still books only the slot its lock sealed. Every
 * other gate — seal, conversation binding, expiry, agenda re-check, journal,
 * one write per call — is untouched.
 */

const DAY_MS = 86_400_000;

/** A future date (UTC) with the requested weekday, at least three days ahead. */
function futureWeekday(weekday: number): string {
  for (let offset = 3; offset < 11; offset += 1) {
    const candidate = new Date(Date.now() + offset * DAY_MS);
    if (candidate.getUTCDay() === weekday) return candidate.toISOString().slice(0, 10);
  }
  throw new Error("unreachable");
}

const SATURDAY = futureWeekday(6);
// The Sunday RIGHT AFTER that Saturday (2026-09-15 look-ahead). A closed-day
// discover now reads the following week to propose the nearest open day; a
// Sunday BEFORE `SATURDAY` would find Ramón's 09:00 in that week, offer it, and
// correctly retire the lock — which is not the case this test is about. After
// it, the fixture's hours (dated `SATURDAY`) are never in the look-ahead.
const SUNDAY = new Date(Date.parse(`${SATURDAY}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

const CUSTOMER = {
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: "600000123",
  confirmed_by_customer: true,
};

function mockCreate(): { calls: () => number } {
  let calls = 0;
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply(() => {
      calls += 1;
      return [200, { id: 95_000 + calls }];
    });
  return { calls: () => calls };
}

function armedEnv(overrides: Record<string, string> = {}): void {
  testEnv({
    ENABLE_MULTI_BARBER: "true",
    ENABLE_WRITE_OPERATIONS: "true",
    ENABLE_CREATE_BOOKING: "true",
    ENABLE_BALANCED_V2_CREATE: "true",
    BOOKING_BOOKING_OWNER_MODE: "guest",
    ...overrides,
  });
}

/** Ramón free at 09:00 and 17:00; Olga on duty with nothing free. */
function incidentAgenda(): void {
  mockAgendaDay({
    date: SATURDAY,
    roster: [RAMON, OLGA],
    free: { [RAMON.id]: ["09:00", "17:00"] },
  });
}


// ── (5) the store and the service under concurrency ────────────────────────

function emptyDay(date: string): AgendaDay {
  return { date, serviceId: "1", employees: [BRUNO], free: [], fetchedAtMs: Date.now(), upstreamCalls: 2 };
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

function serviceWith(
  read: AgendaReader["read"],
  store: MemoryVoiceOfferStore,
  logs: Array<Record<string, unknown>> = [],
): BalancedAvailabilityService {
  const agenda: AgendaReader = {
    read,
    readFresh: async (date) => ({ day: emptyDay(date), outcome: "bypass" as const, ageMs: 0 }),
    invalidate: () => 0,
  };
  return new BalancedAvailabilityService({
    agenda,
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 8 }),
    slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
    offerStore: store,
    closedWeekdays: new Set(),
    logger: {
      warn: (detail) => logs.push({ level: "warn", ...detail }),
      info: (detail) => logs.push({ level: "info", ...detail }),
    },
  });
}

function simulateLock(store: MemoryVoiceOfferStore, conversation: string, token: string, nowMs: number): void {
  const generation = store.beginRefresh(conversation, nowMs);
  store.publishOffered(conversation, generation, [token], nowMs);
}

describe("balanced v2 · offer preservation under concurrency", () => {
  const CONV = "conv_test_preserve_concurrency";
  const discoverBody = { conversation_id: CONV, service_id: 1, date: SATURDAY, time_period: "morning" };

  it("leaves the lock bookable while a discover is in flight and after it (ADR-022)", async () => {
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 8 });
    const pending = deferred<Awaited<ReturnType<AgendaReader["read"]>>>();
    const service = serviceWith(() => pending.promise, store);
    const now = Date.now();
    simulateLock(store, CONV, "tk.locked", now);
    const generation = store.peek(CONV, now)?.generation;

    const inFlight = service.discover(discoverBody, now);
    expect(store.authorizes(CONV, "tk.locked", now).ok).toBe(true);

    pending.resolve({ day: emptyDay(SATURDAY), outcome: "miss", ageMs: 0 });
    const result = await inFlight;
    expect(result.outcome).toBe("no_availability");
    expect(store.authorizes(CONV, "tk.locked", now).ok).toBe(true);
    // The query did not even open a generation.
    expect(store.peek(CONV, now)?.generation).toBe(generation);
  });

  it("does not clobber a lock that completed while the empty query was in flight", async () => {
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 8 });
    const pending = deferred<Awaited<ReturnType<AgendaReader["read"]>>>();
    const service = serviceWith(() => pending.promise, store);
    const now = Date.now();
    simulateLock(store, CONV, "tk.first", now);

    const inFlight = service.discover(discoverBody, now);
    simulateLock(store, CONV, "tk.second", now + 1);

    pending.resolve({ day: emptyDay(SATURDAY), outcome: "miss", ageMs: 0 });
    await inFlight;

    expect(store.authorizes(CONV, "tk.first", now + 2)).toEqual({ ok: false, refusal: "stale_token" });
    expect(store.authorizes(CONV, "tk.second", now + 2).ok).toBe(true);
  });

  it("restores the lock when the agenda read throws (nothing was offered)", async () => {
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 8 });
    const service = serviceWith(async () => {
      throw new Error("agenda down");
    }, store);
    const now = Date.now();
    simulateLock(store, CONV, "tk.locked", now);

    await expect(service.discover(discoverBody, now)).rejects.toThrow("agenda down");
    expect(store.authorizes(CONV, "tk.locked", now).ok).toBe(true);
  });

  it("restores nothing when the conversation was not holding a live offer", async () => {
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 8 });
    const service = serviceWith(async (date) => ({ day: emptyDay(date), outcome: "miss" as const, ageMs: 0 }), store);
    const now = Date.now();

    // No record at all → still nothing bookable, and no record is created.
    await service.discover(discoverBody, now);
    expect(store.authorizes(CONV, "tk.never", now)).toEqual({ ok: false, refusal: "no_record" });
    expect(store.peek(CONV, now)).toBeUndefined();

    // A prior `empty` stays `empty`.
    const generation = store.beginRefresh(CONV, now);
    store.publishEmpty(CONV, generation, now);
    await service.discover(discoverBody, now);
    expect(store.peek(CONV, now)?.state).toBe("empty");
  });

  it("does not carry a suspended lock through an overlapping refresh (fail closed)", () => {
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 8 });
    simulateLock(store, CONV, "tk.locked", 0);
    const first = store.beginRefresh(CONV, 1);
    const second = store.beginRefresh(CONV, 2);

    expect(store.publishEmptyPreservingPrior(CONV, first, 3)).toBe("superseded");
    expect(store.authorizes(CONV, "tk.locked", 3)).toEqual({ ok: false, refusal: "refreshing" });
    expect(store.publishEmptyPreservingPrior(CONV, second, 4)).toBe("empty");
    expect(store.authorizes(CONV, "tk.locked", 4)).toEqual({ ok: false, refusal: "empty" });
  });

  it("does not resurrect an offer whose record expired", () => {
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 60, maxEntries: 8 });
    simulateLock(store, CONV, "tk.locked", 0);
    const generation = store.beginRefresh(CONV, 1);
    expect(store.publishEmptyPreservingPrior(CONV, generation, 61_002)).toBe("superseded");
    expect(store.authorizes(CONV, "tk.locked", 61_003)).toEqual({ ok: false, refusal: "no_record" });
  });

  it("an offer-publishing answer drops the suspension for good", () => {
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 8 });
    simulateLock(store, CONV, "tk.locked", 0);
    const generation = store.beginRefresh(CONV, 1);
    expect(store.publishEmpty(CONV, generation, 2)).toBe(true);
    const next = store.beginRefresh(CONV, 3);
    expect(store.publishEmptyPreservingPrior(CONV, next, 4)).toBe("empty");
    expect(store.authorizes(CONV, "tk.locked", 5)).toEqual({ ok: false, refusal: "empty" });
  });
});
