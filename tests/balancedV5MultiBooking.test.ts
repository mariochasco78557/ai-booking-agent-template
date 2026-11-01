import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_PATH,
  UPSTREAM,
  buildTestApp,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import {
  BRUNO,
  OLGA,
  conv,
  mockAgendaDay,
  v2,
  v2Book,
  type AgendaFixture,
} from "./helpers/balancedV2.js";
import {
  BALANCED_SLOT_ALREADY_BOOKED_IN_CALL_MESSAGE,
  balancedBookingLimitMessage,
} from "../src/utils/balancedPhrasing.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import { bookingJournalId } from "../src/services/voiceBookingService.js";

/**
 * V5 — up to three bookings in one call ((internal doc, not included in the template) ADR-023).
 *
 * Every request here is a V5 request: it carries `agent_profile: "v5"`, the
 * constant the V5 ElevenLabs branch sends (ADR-025). V4 requests (no profile),
 * the kill switch, unknown profiles and mixed conversations are covered in
 * `tests/balancedV5AgentProfile.test.ts`.
 *
 * Everything here runs through the real `/ai/voice/v2/*` routes, against the
 * real journal, offer store and slot tokens. The agenda fixture is MUTABLE:
 * after an appointment is written its hour is removed, the way the salon's
 * diary really changes, so a later lock cannot pretend the hour is still free.
 */

const DATE = "2026-09-18";
const FATHER = {
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: "600000123",
  confirmed_by_customer: true,
};
const SON = { ...FATHER, customer_name: "Pablo" };
const DAUGHTER = { ...FATHER, customer_name: "Lucía" };
const FOURTH = { ...FATHER, customer_name: "Marta" };

/** The constant the V5 branch's tools send. */
const V5 = { agent_profile: "v5" } as const;

/** POST to the V2 booking tool as the V5 agent. */
function v5Book(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): ReturnType<typeof v2Book> {
  return v2Book(app, { ...payload, ...V5 });
}

/** Upstream create, counted. */
function mockCreate(): { calls: () => number } {
  let calls = 0;
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply(() => {
      calls += 1;
      return [200, { id: 90_000 + calls }];
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

/** A mutable one-day agenda; returns the fixture so a test can take hours out. */
function agenda(free: Record<number, string[]>, roster = [BRUNO, OLGA]): AgendaFixture {
  const fixture: AgendaFixture = { date: DATE, roster, free };
  mockAgendaDay(fixture);
  return fixture;
}

/** Takes an hour out of every barber's list — the diary after a booking. */
function occupy(fixture: AgendaFixture, time: string, employeeId?: number): void {
  for (const id of Object.keys(fixture.free).map(Number)) {
    if (employeeId !== undefined && id !== employeeId) continue;
    fixture.free[id] = (fixture.free[id] ?? []).filter((entry) => entry !== time);
  }
}


// ── journal keys ─────────────────────────────────────────────────────────

describe("balanced v5 · journal keys", () => {
  it("booking 1 keeps the bare conversation id as its journal key", () => {
    expect(bookingJournalId("conv_abc12345", 1)).toBe("conv_abc12345");
    expect(bookingJournalId("conv_abc12345", 2)).toBe("conv_abc12345#2");
    expect(bookingJournalId("conv_abc12345", 3)).toBe("conv_abc12345#3");
  });
});

describe("balanced v5 · offer store consumption", () => {
  const NOW = 1_000_000;
  const store = () => new MemoryVoiceOfferStore({ ttlSeconds: 600, maxEntries: 10 });

  it("a consumed token is refused as consumed, in every later state", () => {
    const offers = store();
    const generation = offers.beginRefresh("c1", NOW);
    offers.publishOffered("c1", generation, ["token-a"], NOW);
    offers.markConsumed("c1", "token-a", NOW);

    expect(offers.authorizes("c1", "token-a", NOW)).toEqual({ ok: false, refusal: "consumed" });
    expect(offers.peek("c1", NOW)?.state).toBe("empty");

    const next = offers.beginRefresh("c1", NOW + 1);
    offers.publishOffered("c1", next, ["token-b"], NOW + 1);
    expect(offers.authorizes("c1", "token-a", NOW + 1)).toEqual({ ok: false, refusal: "consumed" });
    expect(offers.authorizes("c1", "token-b", NOW + 1).ok).toBe(true);
  });

  it("consuming the booked token never un-locks a newer lock published meanwhile", () => {
    const offers = store();
    const g1 = offers.beginRefresh("c1", NOW);
    offers.publishOffered("c1", g1, ["token-a"], NOW);
    // Booking A's write is still running when the agent locks B.
    const g2 = offers.beginRefresh("c1", NOW + 1);
    offers.publishOffered("c1", g2, ["token-b"], NOW + 1);
    offers.markConsumed("c1", "token-a", NOW + 2);

    expect(offers.authorizes("c1", "token-b", NOW + 2).ok).toBe(true);
    expect(offers.peek("c1", NOW + 2)?.state).toBe("offered");
  });

  it("a failed lock after a consumption restores nothing bookable", () => {
    const offers = store();
    const g1 = offers.beginRefresh("c1", NOW);
    offers.publishOffered("c1", g1, ["token-a"], NOW);
    offers.markConsumed("c1", "token-a", NOW);
    const g2 = offers.beginRefresh("c1", NOW + 1);
    expect(offers.publishEmptyPreservingPrior("c1", g2, NOW + 1)).toBe("empty");
    expect(offers.authorizes("c1", "token-a", NOW + 1)).toEqual({ ok: false, refusal: "consumed" });
  });
});
