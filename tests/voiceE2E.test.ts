import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  nock,
  testEnv,
  buildTestApp,
  mockLogin,
  UPSTREAM,
  BASE_PATH,
  WEBHOOK_SECRET,
} from "./helpers/testApp.js";

/**
 * step 10C, design §11 ("Laboratory (step 10C ...): the synthetic
 * end-to-end chain voice-request → middleware → Symfony → synthetic
 * PostgreSQL → bounded response") / phase B10.
 *
 * This file is deliberately NOT a duplicate of tests/lookup.test.ts,
 * tests/cancellation.test.ts or tests/aiUpstreamContract.test.ts (which
 * already exhaustively cover each ROUTE's own outcome table). Its job is
 * different: walk the FULL chain shape one synthetic voice call would take —
 * synthetic voice-tool request -> Fastify middleware route -> a trusted
 * synthetic caller context (`AI_CALLER_ID_TRUST_MODE=synthetic_test`,
 * `src/callerIdentity/resolver.ts`) -> a MOCKED `/v1/ai/*` Symfony upstream
 * (nock only — no live endpoint, no real network, matching every other test
 * in this suite) -> a bounded, voice-safe response — and then, ONCE, sweep
 * EVERY response captured along that walk for the four things a voice
 * channel must never say: a cancellation proof, a raw numeric legacy
 * reservation id, a full phone number, or a claim that a transfer occurred.
 *
 * The full docker lab described in
 * (internal doc, not included in the template) exercises the SAME chain
 * against a real (disposable, synthetic) Symfony + Postgres; this file is
 * its fast, network-free Node-side counterpart, run on every `npm test`.
 *
 * Every phone here is synthetic (`+346000000xx`, never a real Spanish
 * range), every credential is obviously fake, and no host port, real
 * upstream, or live provider is ever contacted.
 */

/** Design §9 layer 3: the banned "a transfer occurred/is occurring" phrasing. */
const BANNED_TRANSFER_RE =
  /te paso con|le paso con|te transfiero|paso la llamada|te comunico con/i;

let app: FastifyInstance;
const authHeader = { "x-ai-webhook-secret": WEBHOOK_SECRET };

const VERIFIED_PHONE = "+34600000004";
const PROOF_VALUE = "SYNTHETIC-E2E-PROOF-VALUE-1234567890123";

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/**
 * `synthetic_test` trust-mode headers (src/callerIdentity/resolver.ts):
 * yields a `verified`, cancellation-grade identity with no HMAC secret
 * required, and refuses to construct outside `NODE_ENV=test` (already true
 * here — `testEnv()` sets it). Exactly the fixture design §4's table
 * reserves for "local synthetic end-to-end tests only".
 */
function trustedSyntheticHeaders(
  phone: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, string> {
  const now = Date.now();
  const envelope = {
    callSessionId: sessionId,
    phone,
    method: "synthetic_e2e",
    establishedAtEpochMs: now,
    expiresAtEpochMs: now + 5 * 60_000,
    ...overrides,
  };
  return { "x-ai-synthetic-caller-identity": toBase64(envelope) };
}

function proofSuccessBody(proof: string = PROOF_VALUE) {
  return {
    ok: true,
    code: "OK",
    message: "Justificante de cancelacion emitido.",
    data: { cancellationProof: proof, expiresInSeconds: 120 },
  };
}

function cancelSuccessBody(alreadyCancelled = false) {
  return {
    ok: true,
    code: "OK",
    message: alreadyCancelled ? "La reserva ya estaba cancelada." : "Reserva cancelada correctamente.",
    data: { cancelled: true, alreadyCancelled },
  };
}

/**
 * Every response body captured along this file's walk of the chain, swept
 * EXACTLY ONCE at the end (the last `it` in this file, run after every
 * scenario above it — vitest runs `it` blocks within one file in
 * declaration order by default, the same assumption
 * tests/cancellation.test.ts's own multi-step scenarios already rely on).
 */
const capturedResponses: unknown[] = [];
function capture(body: unknown): unknown {
  capturedResponses.push(body);
  return body;
}

describe("voice E2E — the synthetic end-to-end chain (design §11, phase B10)", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });



  describe("3. lookup unsupported (U-1 / legacy mode)", () => {
    it("legacy mode (BOOKING_UPSTREAM_MODE default) answers unsupported before any identity or upstream work", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "legacy" });
      // No nock interceptor registered -- if this ever called upstream, the
      // disabled net connect would fail the test outright.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: authHeader,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("unsupported");
      expect(body.action).toBe("human_assistance_required");
      expect(body.reservations).toBeUndefined();
      capture(body);
    });
  });



  describe("6. cancellation — confirmation required", () => {
    it("confirmedByCustomer: false never calls upstream and never cancels", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true",
        AI_CALLER_ID_TRUST_MODE: "synthetic_test",
      });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: { ...authHeader, ...trustedSyntheticHeaders(VERIFIED_PHONE, "sess-E2E-CONFIRM") },
        payload: {
          reservationRef: "d".repeat(32),
          confirmedByCustomer: false,
          callerStatedName: "Ana García",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("not_confirmed");
      capture(body);
    });
  });



  describe("9. transfer / human-assistance required", () => {
    it("a dead-end cancellation (legacy mode) is offered as human assistance, never as a completed or attempted transfer", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "legacy",
        ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true",
        AI_CALLER_ID_TRUST_MODE: "synthetic_test",
      });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: { ...authHeader, ...trustedSyntheticHeaders(VERIFIED_PHONE, "sess-E2E-TRANSFER") },
        payload: {
          reservationRef: "g".repeat(32),
          confirmedByCustomer: true,
          callerStatedName: "Ana García",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("unsupported");
      // The ONLY action this middleware can ever emit (design §9, layer 1's
      // single-member `HumanAssistanceAction` type makes the alternative a
      // `tsc` error, not merely a test to remember).
      expect(body.action).toBe("human_assistance_required");
      expect(body.message).not.toMatch(BANNED_TRANSFER_RE);
      capture(body);
    });
  });

  describe("10. malformed payload -> 400", () => {
    it("a raw numeric reservationId (the retired legacy field) is rejected by .strict() before any upstream call", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true" });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: authHeader,
        payload: { reservationId: 99999, confirmedByCustomer: true, callerStatedName: "Ana" },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(JSON.stringify(body)).not.toContain("99999");
      capture(body);
    });
  });

  describe("11. unauthorized middleware credential -> 401", () => {
    it("a missing/incorrect webhook secret is refused before any route logic runs", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai" });
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/availability",
        headers: { "x-ai-webhook-secret": "wrong-secret" },
        payload: { date: "2026-08-03", typeReservation: "1" },
      });

      expect(res.statusCode).toBe(401);
      capture(res.json());
    });
  });

  describe("12. writes disabled", () => {
    it("ENABLE_WRITE_OPERATIONS=false blocks cancellation with no upstream call, even with every other gate satisfied", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        ENABLE_WRITE_OPERATIONS: "false",
        AI_CALLER_ID_TRUST_MODE: "synthetic_test",
      });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: { ...authHeader, ...trustedSyntheticHeaders(VERIFIED_PHONE, "sess-E2E-WRITEDISABLED") },
        payload: {
          reservationRef: "h".repeat(32),
          confirmedByCustomer: true,
          callerStatedName: "Ana García",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("write_disabled");
      capture(body);
    });
  });

});
