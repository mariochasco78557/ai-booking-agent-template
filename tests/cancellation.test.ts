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
import * as phrasing from "../src/utils/phrasing.js";
import {
  CANCEL_ALREADY_CANCELLED_MESSAGE,
  CANCEL_CONFIRMATION_MISMATCH_MESSAGE,
  CANCEL_CONFIRMED_MESSAGE,
  CANCEL_IDENTITY_MISSING_MESSAGE,
  CANCEL_INSUFFICIENT_TRUST_MESSAGE,
  CANCEL_NOT_SUPPORTED_MESSAGE,
  CANCEL_PROOF_INVALID_MESSAGE,
  CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE,
  NEEDS_CONFIRMATION_MESSAGE,
  WRITE_DISABLED_CANCEL_MESSAGE,
} from "../src/utils/phrasing.js";

/**
 * step 10C ((internal doc, not included in the template) §4.1.1,
 * §6, §6.1, §6.2, §6.3, §6.4, §9). `CancellationService`'s subject changed
 * entirely this wave (a legacy-numeric-id delete stub -> a real,
 * cancellation-grade-identity-only, proof-based cancel), so this whole file
 * is rewritten rather than patched.
 */

let app: FastifyInstance;
const authHeader = { "x-ai-webhook-secret": WEBHOOK_SECRET };

/** Design §9 layer 3: the banned "a transfer occurred/is occurring" phrasing. */
const BANNED_TRANSFER_RE =
  /te paso con|le paso con|te transfiero|paso la llamada|te comunico con/i;

const VERIFIED_PHONE = "+34600000001";
const VALID_REF = "a".repeat(32);

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/**
 * `synthetic_test` trust-mode headers (src/callerIdentity/resolver.ts):
 * yields a `verified`, `signed_envelope`-GRADE identity (source
 * `synthetic_test`, which `asCancellationGrade()` accepts) with no HMAC
 * secret required. Refuses to construct outside `NODE_ENV=test` — already
 * true here (`testEnv()` sets it).
 */
function cancellationGradeHeaders(
  phone: string,
  sessionId = "sess-CANCEL-AAAA",
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

/** `provider_header` trust-mode headers WITHOUT attestation -> "asserted", never "verified" (design §4.1). */
function assertedHeaders(
  phone: string,
  sessionId = "sess-CANCEL-BBBB",
): Record<string, string> {
  return {
    "x-ai-verified-caller-id": phone,
    "x-ai-call-session-id": sessionId,
  };
}

function cancelPayload(overrides: Record<string, unknown> = {}) {
  return {
    reservationRef: VALID_REF,
    confirmedByCustomer: true,
    callerStatedName: "Ana García",
    ...overrides,
  };
}

function proofSuccessBody(proof = "P".repeat(43)) {
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

describe("POST /ai/cancel", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("outcome: insufficient_trust_for_write — THE B6 CONTROL, THE MOST IMPORTANT TEST IN THIS FILE", () => {
    /**
     * ***********************************************************************
     * Senior finding B6 (design §4.1.1): an ATTESTED `provider_header`
     * identity IS `trustLevel === "verified"` — sufficient to READ. It must
     * NEVER be sufficient to CANCEL. This test asserts BOTH halves: the
     * outcome is `insufficient_trust_for_write`, AND the upstream proof
     * endpoint (`/v1/ai/cancellation/proof`) is NEVER called — proven here
     * by registering NO nock interceptor at all while `nock.disableNetConnect()`
     * is active (any real attempt to reach it would throw, failing this test
     * outright, not merely fail an assertion).
     * ***********************************************************************
     */
    it("an ATTESTED provider_header identity (verified) is refused, and the proof endpoint is NEVER called", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true",
        AI_CALLER_ID_TRUST_MODE: "provider_header",
        AI_CALLER_ID_PROVIDER_ATTESTED: "true",
        AI_CALLER_ID_ATTESTATION_REF: "test-attestation-2026-07-28",
      });
      // NO nock interceptor for /ai/cancellation/proof or /ai/cancellation
      // registered anywhere in this test.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: { ...authHeader, ...assertedHeaders(VERIFIED_PHONE) },
        payload: cancelPayload(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("insufficient_trust_for_write");
      expect(body.message).toBe(CANCEL_INSUFFICIENT_TRUST_MESSAGE);
      expect(body.action).toBe("human_assistance_required");
      // Second, independent proof the upstream was never touched: no nock
      // scope was ever registered, so any attempted call would have thrown
      // inside the service and surfaced as upstream_unavailable/502 instead
      // of the 200/insufficient_trust_for_write asserted above.
      expect(res.statusCode).not.toBe(502);
    });
  });


  describe("outcome: identity_missing", () => {
    it("with no caller-identity trust configured (AI_CALLER_ID_TRUST_MODE default 'none'), never calls upstream", async () => {
      // AI_CALLER_ID_TRUST_MODE is set explicitly here (rather than relying
      // on testEnv()'s own default) because testEnv() only resets the base
      // keys it always sets — it does not clear a trust mode a PRECEDING
      // test in this file may have set, so this test must not depend on
      // running before those.
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true", AI_CALLER_ID_TRUST_MODE: "none" });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: { ...authHeader, ...cancellationGradeHeaders(VERIFIED_PHONE) },
        payload: cancelPayload(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("identity_missing");
      expect(body.message).toBe(CANCEL_IDENTITY_MISSING_MESSAGE);
      expect(body.action).toBe("human_assistance_required");
    });
  });

  describe("outcome: not_confirmed", () => {
    it("confirmedByCustomer: false never calls upstream", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true",
        AI_CALLER_ID_TRUST_MODE: "synthetic_test",
      });
      // No nock interceptors -- proves the upstream is never touched, even
      // though identity + write-enabled would otherwise allow it through.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: { ...authHeader, ...cancellationGradeHeaders(VERIFIED_PHONE) },
        payload: cancelPayload({ confirmedByCustomer: false }),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("not_confirmed");
      expect(body.message).toBe(NEEDS_CONFIRMATION_MESSAGE);
    });
  });

  describe("outcome: write_disabled", () => {
    it("ENABLE_WRITE_OPERATIONS=false never calls upstream", async () => {
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
        headers: { ...authHeader, ...cancellationGradeHeaders(VERIFIED_PHONE) },
        payload: cancelPayload(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("write_disabled");
      expect(body.message).toBe(WRITE_DISABLED_CANCEL_MESSAGE);
    });
  });

  describe("outcome: unsupported (BOOKING_UPSTREAM_MODE !== 'ai')", () => {
    it("legacy mode answers unsupported before any identity or upstream work, even with a perfectly verified cancellation-grade identity presented", async () => {
      // BOOKING_UPSTREAM_MODE and AI_CALLER_ID_TRUST_MODE are both set
      // explicitly (see the identity_missing test above for why testEnv()
      // alone cannot be trusted to reset a PRECEDING test's overrides).
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
        headers: { ...authHeader, ...cancellationGradeHeaders(VERIFIED_PHONE) },
        payload: cancelPayload(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("unsupported");
      expect(body.message).toBe(CANCEL_NOT_SUPPORTED_MESSAGE);
      expect(body.action).toBe("human_assistance_required");
    });
  });

  describe("request body: schema (design §6, invariant 12)", () => {
    it("a raw numeric reservationId in the body is rejected with 400 (the field no longer exists)", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true" });
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: authHeader,
        payload: { reservationId: 86292, confirmedByCustomer: true, callerStatedName: "Ana" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("an oversized reservationRef is rejected with 400 BEFORE any upstream call", async () => {
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
        headers: { ...authHeader, ...cancellationGradeHeaders(VERIFIED_PHONE) },
        payload: cancelPayload({ reservationRef: "a".repeat(200) }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("a path-shaped, wrong-alphabet reservationRef is rejected with 400 BEFORE any upstream call", async () => {
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
        headers: { ...authHeader, ...cancellationGradeHeaders(VERIFIED_PHONE) },
        payload: cancelPayload({ reservationRef: "../../etc/passwd" + "a".repeat(15) }),
      });

      expect(res.statusCode).toBe(400);
    });
  });






  describe("phrasing.ts: no exported string or builder ever claims a transfer (design §9 layer 3)", () => {
    it("sweeps every exported string constant of src/utils/phrasing.ts", () => {
      const strings = Object.entries(phrasing).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      expect(strings.length).toBeGreaterThan(5);
      for (const [name, value] of strings) {
        expect(value, `${name} must not claim a transfer occurred/is occurring/will occur`).not.toMatch(
          BANNED_TRANSFER_RE,
        );
      }
    });
  });

  describe("no response message across every outcome exercised above ever claims a transfer", () => {
    it("collects every response.message seen in this file's earlier assertions and re-checks them", () => {
      const seenMessages = [
        CANCEL_IDENTITY_MISSING_MESSAGE,
        CANCEL_INSUFFICIENT_TRUST_MESSAGE,
        CANCEL_NOT_SUPPORTED_MESSAGE,
        WRITE_DISABLED_CANCEL_MESSAGE,
        NEEDS_CONFIRMATION_MESSAGE,
        CANCEL_CONFIRMED_MESSAGE,
        CANCEL_ALREADY_CANCELLED_MESSAGE,
        CANCEL_CONFIRMATION_MISMATCH_MESSAGE,
        CANCEL_PROOF_INVALID_MESSAGE,
        CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE,
      ];
      for (const message of seenMessages) {
        expect(message).not.toMatch(BANNED_TRANSFER_RE);
      }
    });
  });
});
