import { describe, it, expect, afterEach, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";

import {
  BASE_PATH,
  UPSTREAM,
  WEBHOOK_SECRET,
  buildTestApp,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import { BRUNO, OLGA, conv, mockAgendaDay } from "./helpers/balancedV2.js";
import { BALANCED_V2_PREFIX } from "../src/routes/balancedV2.js";

/**
 * PRODUCTION FORENSICS 2026-09-11 — F5 and F6, as tests.
 *
 * `src/routes/balancedV2.ts` opens by declaring that EVERY answer on the V2
 * surface is HTTP 200, because ElevenLabs renders a non-2xx as a tool error and
 * re-invokes the tool — and a re-invoked write is the 2026-08-30 duplicate
 * appointment. Two paths contradicted that declaration, both of them outside
 * the route handler and therefore invisible to every existing V2 test:
 *
 * - a body the Zod schema could not parse at all reached the GLOBAL error
 *   handler, which answers 400;
 * - the global rate limiter answers 429, and its budget is 30 requests per
 *   minute shared across every caller with no attributable identity — which,
 *   for a webhook whose only caller is ElevenLabs, is one busy salon afternoon.
 *
 * A 429 to a booking tool is the worst possible one: the platform's reaction to
 * a tool error is to call the tool again, which is exactly what the limiter was
 * trying to stop.
 */

const DATE = "2026-09-18";
const JSON_HEADERS = {
  "x-ai-webhook-secret": WEBHOOK_SECRET,
  "content-type": "application/json",
};

/**
 * The closed catalogue of `outcome` values `VoiceBookingService.book()` can
 * produce, read out of the source exactly as `tests/balancedV2Contract.test.ts`
 * reads it — so a malformed request cannot be answered with an outcome the
 * prompt has never been told about.
 */
const BOOK_OUTCOMES = new Set(
  [
    "confirmed",
    "not_confirmed",
    "write_disabled",
    "slot_taken",
    "misconfigured_owner",
    "upstream_error",
    "uncertain",
    "already_booked_in_call",
    "invalid_slot_token",
    "slot_token_expired",
    "slot_not_authorized",
    "invalid_customer_data",
  ],
);

function bodyOf(response: LightMyRequestResponse): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

describe("balanced v2 · every answer is 200", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
  });

  function agenda(): void {
    mockAgendaDay({
      date: DATE,
      roster: [BRUNO, OLGA],
      free: { 1: ["10:00"], 2: ["10:00", "11:00"] },
    });
  }

  describe("malformed requests", () => {
    it("answers a non-object body to v2/book with 200 and an outcome from the catalogue", async () => {
      testEnv();
      app = await buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/ai/voice/v2/book",
        headers: JSON_HEADERS,
        payload: JSON.stringify(["not", "an", "object"]),
      });

      expect(response.statusCode).toBe(200);
      const body = bodyOf(response);
      expect(BOOK_OUTCOMES.has(body["outcome"] as string)).toBe(true);
      expect(body["booked"]).toBe(false);
      // Nothing was written, and the answer must SAY so rather than leave it
      // to be inferred: a malformed request never reached the journal.
      expect(body["external_mutation"]).toBe(false);
      expect(body["mutation_status"]).toBe("none");
      expect(typeof body["message"]).toBe("string");
    });

    it("answers syntactically invalid JSON to v2/book with 200, not 400", async () => {
      testEnv();
      app = await buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/ai/voice/v2/book",
        headers: JSON_HEADERS,
        payload: "{ this is not json",
      });

      expect(response.statusCode).toBe(200);
      const body = bodyOf(response);
      expect(BOOK_OUTCOMES.has(body["outcome"] as string)).toBe(true);
      expect(body["mutation_status"]).toBe("none");
    });

    it("answers a non-object body to v2/availability with 200 and `invalid_request`", async () => {
      testEnv();
      app = await buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/ai/voice/v2/availability",
        headers: JSON_HEADERS,
        payload: JSON.stringify("discover, please"),
      });

      expect(response.statusCode).toBe(200);
      const body = bodyOf(response);
      expect(body["outcome"]).toBe("invalid_request");
      expect(body["external_mutation"]).toBe(false);
      expect(body["options"]).toEqual([]);
    });

    it("answers syntactically invalid JSON to v2/availability with 200, not 400", async () => {
      testEnv();
      app = await buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/ai/voice/v2/availability",
        headers: JSON_HEADERS,
        payload: "{{{",
      });

      expect(response.statusCode).toBe(200);
      expect(bodyOf(response)["outcome"]).toBe("invalid_request");
    });

    it("still refuses an unauthenticated request — 200 is a contract, not an open door", async () => {
      testEnv();
      app = await buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/ai/voice/v2/book",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({}),
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("rate limiting", () => {

    it("never answers 429 on the V2 booking route either", async () => {
      testEnv({ RATE_LIMIT_MAX: "30", RATE_LIMIT_WINDOW: "1 minute" });
      app = await buildTestApp();
      const conversation = conv("rl-v2-book");

      const statuses: number[] = [];
      for (let i = 0; i < 31; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/ai/voice/v2/book",
          headers: JSON_HEADERS,
          payload: JSON.stringify({
            conversation_id: conversation,
            slot_token: "never-authorized",
            customer_name: "Carlos",
            customer_surnames: "García",
            phone: "600000123",
            confirmed_by_customer: true,
          }),
        });
        statuses.push(response.statusCode);
      }

      expect(statuses.filter((status) => status === 429)).toHaveLength(0);
    });

    /** *** THE EXEMPTION IS FOR THE V2 SURFACE, NOT FOR EVERYTHING. *** */
    it("keeps the 429 on a route outside the V2 surface", async () => {
      testEnv({ RATE_LIMIT_MAX: "30", RATE_LIMIT_WINDOW: "1 minute" });
      app = await buildTestApp();

      const statuses: number[] = [];
      for (let i = 0; i < 31; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/ai/voice/availability",
          headers: JSON_HEADERS,
          payload: JSON.stringify({}),
        });
        statuses.push(response.statusCode);
      }

      expect(statuses[30]).toBe(429);
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    });

    it("exempts the V2 prefix by PATH, not by a query string a caller controls", async () => {
      testEnv({ RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW: "1 minute" });
      app = await buildTestApp();

      // A non-V2 route carrying the V2 prefix in its query must NOT be exempt.
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: `/ai/voice/availability?next=${encodeURIComponent(BALANCED_V2_PREFIX)}`,
          headers: JSON_HEADERS,
          payload: JSON.stringify({}),
        });
        statuses.push(response.statusCode);
      }

      expect(statuses[2]).toBe(429);
    });
  });
});
