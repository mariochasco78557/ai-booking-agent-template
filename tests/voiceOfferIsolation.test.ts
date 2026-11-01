import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  UPSTREAM,
  WEBHOOK_SECRET,
  buildTestApp,
  fakeJwt,
  freeEmployeeFixture,
  nock,
  testEnv,
} from "./helpers/testApp.js";

import { mintSlotToken } from "./helpers/slotToken.js";
import {
  MemoryVoiceOfferStore,
  VOICE_OFFER_TTL_MIN_SECONDS,
} from "../src/services/voiceOfferStore.js";
import { SLOT_NOT_AUTHORIZED_MESSAGE } from "../src/utils/phrasing.js";

/**
 * *** step OFFER — THE HUECO ON THE TABLE, PER CONVERSATION. ***
 *
 * `tests/voiceSlotAuthorization.test.ts` proves a booking must echo a token
 * this middleware minted. This file proves the half that a token cannot
 * carry: that it must be the token this CALL is being offered RIGHT NOW.
 *
 * The gap is not theoretical and it is not a forgery. Every token used below
 * is genuine, unexpired, and sealed for the exact conversation presenting it —
 * so every one of them passes the cryptographic gate. What they fail is
 * memory: the conversation has moved on, or never asked, or asked and got
 * nothing, or is another call entirely.
 *
 * As in the slot-token suite, nearly every assertion is a COUNT OF UPSTREAM
 * CALLS rather than a response body. A refusal that still reached the salon's
 * API is not a refusal.
 *
 * NOTHING in this file talks to a real service. `nock.disableNetConnect()` is
 * on for every case, so a request that escaped the fixtures would fail the
 * test rather than leave the machine.
 */

const DATE = "2026-09-11";
const EARLY = `${DATE} 10:00:00`;
const LATE = `${DATE} 18:00:00`;
const auth = { "x-ai-webhook-secret": WEBHOOK_SECRET };

let app: FastifyInstance | undefined;

interface Counters {
  logins: () => number;
  frees: () => number;
  /**
   * `/user/free` reads for THE DAY UNDER TEST only.
   *
   * The background refresher warms its own horizon and would otherwise inflate
   * every count here — the tests that assert "not one further read" are about
   * this day, not about whatever the refresher is doing behind them.
   */
  freesForDay: () => number;
  employeesDay: () => number;
  reservations: () => number;
  /** Which hours the agenda currently reports as free. Mutable mid-test. */
  setSlots: (starts: string[]) => void;
  /** How the next `POST /reservation` answers. */
  setReservationReply: (reply: { status: number; body: unknown }) => void;
}

/** Every upstream endpoint the voice path can touch, counted. */
function upstream(initial: string[] = [EARLY, LATE]): Counters {
  let starts = [...initial];
  let logins = 0;
  let frees = 0;
  let freesForDay = 0;
  let employeesDay = 0;
  let reservations = 0;
  let reservationReply: { status: number; body: unknown } = {
    status: 201,
    body: { id: 99700 },
  };

  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/login`)
    .reply(() => {
      logins += 1;
      return [200, { token: fakeJwt() }];
    });
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/free`)
    .query(true)
    .reply((uri) => {
      frees += 1;
      if (uri.includes(DATE)) freesForDay += 1;
      return [200, [freeEmployeeFixture(DATE, starts)]];
    });
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/employees-day`)
    .query(true)
    .reply(() => {
      employeesDay += 1;
      return [200, [{ id: 1, name: "Bruno", surnames: "Demo" }]];
    });
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply(() => {
      reservations += 1;
      return [reservationReply.status, reservationReply.body];
    });

  return {
    logins: () => logins,
    frees: () => frees,
    freesForDay: () => freesForDay,
    employeesDay: () => employeesDay,
    reservations: () => reservations,
    setSlots: (next) => {
      starts = [...next];
    },
    setReservationReply: (reply) => {
      reservationReply = reply;
    },
  };
}

/** Creation genuinely armed. A control proven only while writes are off is
 * not a control that has been proven. */
function armed(overrides: Record<string, string> = {}): void {
  testEnv({
    ENABLE_WRITE_OPERATIONS: "true",
    ENABLE_CREATE_BOOKING: "true",
    BOOKING_BOOKING_OWNER_MODE: "guest",
    ...overrides,
  });
}

interface VoiceBody {
  booked: boolean;
  outcome: string;
  message: string;
  external_mutation: boolean | null;
  mutation_status: string;
  idempotency_status: string;
}

interface AvailabilityBody {
  available: boolean;
  message: string;
  slots: Array<Record<string, unknown>>;
}

async function availability(
  conversationId: string,
  overrides: Record<string, unknown> = {},
  instance: FastifyInstance = app!,
): Promise<AvailabilityBody> {
  const res = await instance.inject({
    method: "POST",
    url: "/ai/voice/availability",
    headers: auth,
    payload: {
      conversation_id: conversationId,
      date_from: DATE,
      date_to: DATE,
      service_id: 1,
      ...overrides,
    },
  });
  return res.json() as AvailabilityBody;
}

async function book(
  payload: Record<string, unknown>,
  instance: FastifyInstance = app!,
): Promise<{ status: number; body: VoiceBody }> {
  const res = await instance.inject({
    method: "POST",
    url: "/ai/voice/book",
    headers: auth,
    payload,
  });
  return { status: res.statusCode, body: res.json() as VoiceBody };
}

/** The customer half of a booking — the only part still taken from the body. */
function customer(conversationId: string, overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: conversationId,
    customer_name: "Jorge",
    customer_surnames: "Pérez",
    phone: "612345678",
    confirmed_by_customer: true,
    ...overrides,
  };
}

/** The first token of an availability answer. */
function tokenOf(answer: AvailabilityBody, index = 0): string {
  const token = answer.slots[index]?.["slot_token"];
  if (typeof token !== "string") {
    throw new Error("availability answered without a slot_token");
  }
  return token;
}

beforeEach(() => nock.disableNetConnect());
afterEach(async () => {
  await app?.close();
  app = undefined;
  nock.cleanAll();
  nock.enableNetConnect();
});

// ───────────────────────────────────────────────────────────────────────────
// ISOLATION
// ───────────────────────────────────────────────────────────────────────────

describe("two conversations never share an offer", () => {


  it("never resolves a conversation by recency, only by exact id", async () => {
    // The failure mode this forbids is the tempting one: "there is only one
    // call in flight, so this token must be for it". A store that fell back to
    // the most recent conversation would pass every other test in this file
    // and be wrong in exactly the case that matters.
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3600, maxEntries: 100 });
    const generation = store.beginRefresh("conv_only_one_alive", 1_000);
    store.publishOffered("conv_only_one_alive", generation, ["tk1.aaa"], 1_000);

    // The ONLY live conversation holds this exact token, and it is still
    // refused for a different id. No prefix, no "closest", no fallback.
    expect(store.authorizes("conv_only_one_alive", "tk1.aaa", 1_100).ok).toBe(true);
    expect(store.authorizes("conv_only_one_alivE", "tk1.aaa", 1_100)).toEqual({
      ok: false,
      refusal: "no_record",
    });
    expect(store.authorizes("conv_only_one_aliv", "tk1.aaa", 1_100)).toEqual({
      ok: false,
      refusal: "no_record",
    });
    expect(store.authorizes("", "tk1.aaa", 1_100)).toEqual({
      ok: false,
      refusal: "no_record",
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AVAILABILITY — GENERATIONS
// ───────────────────────────────────────────────────────────────────────────

describe("each availability question replaces the last, inside one conversation", () => {



  it("refuses everything while an availability question is still in flight", async () => {
    // The window is narrow — one upstream round trip — and entirely
    // reachable: ElevenLabs fires tool calls roughly two seconds apart and the
    // agenda answers in about one. Asserted at the store, where the state is
    // observable without racing a real request.
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3600, maxEntries: 100 });
    const first = store.beginRefresh("conv_in_flight", 0);
    store.publishOffered("conv_in_flight", first, ["tk1.old"], 0);
    expect(store.authorizes("conv_in_flight", "tk1.old", 10).ok).toBe(true);

    // A new question starts. The old offer is gone BEFORE the agenda is read.
    store.beginRefresh("conv_in_flight", 20);
    expect(store.peek("conv_in_flight", 20)?.state).toBe("refreshing");
    expect(store.authorizes("conv_in_flight", "tk1.old", 20)).toEqual({
      ok: false,
      refusal: "refreshing",
    });
  });

  it("does not let a slow answer resurrect the hueco a newer question replaced", async () => {
    // Compare-and-set by generation. Two questions overlap; the FIRST one's
    // upstream call is the slower of the two and finishes last. It must not be
    // able to publish, because what it knows is already out of date — and the
    // token it would publish is the one the caller has just declined.
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3600, maxEntries: 100 });

    const slow = store.beginRefresh("conv_out_of_order", 0);
    const fast = store.beginRefresh("conv_out_of_order", 5);
    expect(fast).toBeGreaterThan(slow);

    // The newer question lands first.
    expect(store.publishOffered("conv_out_of_order", fast, ["tk1.new"], 10)).toBe(true);
    // Then the older one finally answers.
    expect(store.publishOffered("conv_out_of_order", slow, ["tk1.stale"], 15)).toBe(false);

    const record = store.peek("conv_out_of_order", 15);
    expect(record?.generation).toBe(fast);
    expect(record?.state).toBe("offered");
    expect(store.authorizes("conv_out_of_order", "tk1.new", 15).ok).toBe(true);
    expect(store.authorizes("conv_out_of_order", "tk1.stale", 15)).toEqual({
      ok: false,
      refusal: "stale_token",
    });
  });

});

// ───────────────────────────────────────────────────────────────────────────
// BOOKING
// ───────────────────────────────────────────────────────────────────────────




// ───────────────────────────────────────────────────────────────────────────
// THE AGENDA IS STILL THE AUTHORITY
// ───────────────────────────────────────────────────────────────────────────


// ───────────────────────────────────────────────────────────────────────────
// BOUNDS
// ───────────────────────────────────────────────────────────────────────────

describe("the store stays bounded without timers", () => {
  it("expires an abandoned conversation, and every valid operation postpones it", async () => {
    const ttlSeconds = 600;
    const ttlMs = ttlSeconds * 1000;
    const store = new MemoryVoiceOfferStore({ ttlSeconds, maxEntries: 100 });

    const generation = store.beginRefresh("conv_ttl", 0);
    store.publishOffered("conv_ttl", generation, ["tk1.aaa"], 0);

    // Still inside the window, and the read itself pushes the deadline out —
    // a live call must not lose its hueco for being long.
    expect(store.authorizes("conv_ttl", "tk1.aaa", ttlMs - 1).ok).toBe(true);
    expect(store.authorizes("conv_ttl", "tk1.aaa", ttlMs * 2 - 2).ok).toBe(true);

    // Abandoned: nothing touches it for a full TTL.
    expect(store.authorizes("conv_ttl", "tk1.aaa", ttlMs * 4)).toEqual({
      ok: false,
      refusal: "expired",
    });
    expect(store.peek("conv_ttl", ttlMs * 4)).toBeUndefined();
  });

  it("never grows past its ceiling, evicting the least recently touched first", async () => {
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3600, maxEntries: 3 });

    for (const [index, id] of ["a", "b", "c"].entries()) {
      const generation = store.beginRefresh(id, index);
      store.publishOffered(id, generation, [`tk1.${id}`], index);
    }
    expect(store.size).toBe(3);

    // `a` is used again, so `b` becomes the oldest by ACTIVITY rather than by
    // creation — the distinction that keeps a long call alive under pressure.
    expect(store.authorizes("a", "tk1.a", 10).ok).toBe(true);

    const generation = store.beginRefresh("d", 20);
    store.publishOffered("d", generation, ["tk1.d"], 20);

    expect(store.size).toBe(3);
    expect(store.peek("b", 20)).toBeUndefined();
    expect(store.peek("a", 20)).toBeDefined();
    expect(store.peek("c", 20)).toBeDefined();
    expect(store.peek("d", 20)).toBeDefined();
  });

  it("reclaims expired entries as it goes, without a timer", async () => {
    const store = new MemoryVoiceOfferStore({
      ttlSeconds: VOICE_OFFER_TTL_MIN_SECONDS,
      maxEntries: 1000,
    });
    const ttlMs = VOICE_OFFER_TTL_MIN_SECONDS * 1000;

    for (let index = 0; index < 40; index += 1) {
      const id = `conv_sweep_${index}`;
      const generation = store.beginRefresh(id, index);
      store.publishOffered(id, generation, [`tk1.${index}`], index);
    }
    expect(store.size).toBe(40);

    // One later operation, long after they all aged out. The sweep is bounded
    // per call, so this reclaims a slice rather than the lot — which is the
    // point: no single request pays for an hour of idle conversations.
    store.beginRefresh("conv_sweep_new", ttlMs * 2);
    expect(store.size).toBeLessThan(41);
    expect(store.size).toBeGreaterThan(1);

    // A few more operations and the backlog is gone, still without a timer.
    for (let index = 0; index < 3; index += 1) {
      store.beginRefresh(`conv_sweep_more_${index}`, ttlMs * 2 + index);
    }
    expect(store.size).toBeLessThanOrEqual(5);
  });

  it("refuses to build with bounds that would only look like a policy", async () => {
    // Same reasoning as `SlotAuthorizationService`: this class is exported, so
    // a call site that never passes through the env schema must still get a
    // sane store or none at all.
    expect(() => new MemoryVoiceOfferStore({ ttlSeconds: 1, maxEntries: 10 })).toThrow(
      /ttlSeconds/,
    );
    expect(() => new MemoryVoiceOfferStore({ ttlSeconds: 999_999, maxEntries: 10 })).toThrow(
      /ttlSeconds/,
    );
    expect(() => new MemoryVoiceOfferStore({ ttlSeconds: 600, maxEntries: 0 })).toThrow(
      /maxEntries/,
    );
    expect(() =>
      new MemoryVoiceOfferStore({ ttlSeconds: 600, maxEntries: 1_000_000 }),
    ).toThrow(/maxEntries/);
  });

  it("stores no token, name or phone in anything it holds", async () => {
    // The record is a digest set and four numbers. A store that kept the
    // tokens themselves would be a pile of bearer credentials for other
    // people's appointments.
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3600, maxEntries: 10 });
    const token = mintSlotToken({
      conversationId: "conv_no_secrets_kept",
      reservationDate: EARLY,
      serviceId: 1,
    });
    const generation = store.beginRefresh("conv_no_secrets_kept", 0);
    store.publishOffered("conv_no_secrets_kept", generation, [token], 0);

    const serialized = JSON.stringify(store.peek("conv_no_secrets_kept", 0));
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(token.slice(-24));
    expect(serialized).not.toContain(EARLY);
    // The digest is present, and it is the only trace of the token there is.
    expect(store.peek("conv_no_secrets_kept", 0)?.tokenDigests).toHaveLength(1);
  });

  it("adds no measurable latency to the path a live call takes", async () => {
    // The store sits on the latency path of a phone call, so the check has to
    // be a local map lookup and nothing else — no I/O, and no scan whose cost
    // grows with how many conversations the process has seen.
    const store = new MemoryVoiceOfferStore({ ttlSeconds: 3600, maxEntries: 20_000 });
    for (let index = 0; index < 10_000; index += 1) {
      const id = `conv_bulk_${index}`;
      const generation = store.beginRefresh(id, index);
      store.publishOffered(id, generation, [`tk1.token_${index}`], index);
    }

    const started = process.hrtime.bigint();
    for (let index = 0; index < 10_000; index += 1) {
      expect(store.authorizes(`conv_bulk_${index}`, `tk1.token_${index}`, 20_000).ok).toBe(
        true,
      );
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    // Deliberately generous: this is a guard against an accidental O(n) scan
    // or a synchronous write, not a benchmark. Ten thousand authorizations
    // through a real map cost single-digit milliseconds; a linear scan over a
    // ten-thousand-entry store would not finish anywhere near this.
    expect(elapsedMs).toBeLessThan(500);
  });

});
