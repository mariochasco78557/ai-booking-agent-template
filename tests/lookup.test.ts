import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  LOOKUP_AMBIGUOUS_MESSAGE,
  LOOKUP_CALLER_ID_REJECTED_MESSAGE,
  LOOKUP_IDENTITY_MISSING_MESSAGE,
  LOOKUP_IDENTITY_UNVERIFIED_MESSAGE,
  LOOKUP_NOT_SUPPORTED_MESSAGE,
  LOOKUP_NO_MATCH_MESSAGE,
  LOOKUP_RATE_LIMITED_MESSAGE,
  LOOKUP_UPSTREAM_UNAVAILABLE_MESSAGE,
} from "../src/utils/phrasing.js";

/**
 * step 10C ((internal doc, not included in the template) §5,
 * §5.1, §5.2, §5.3, §9). `LookupService`'s subject changed entirely this
 * wave (a permanently-"unsupported" stub -> a real, verified-caller-only
 * lookup), so this whole file is rewritten rather than patched.
 */

let app: FastifyInstance;
const authHeader = { "x-ai-webhook-secret": WEBHOOK_SECRET };

/** Design §9 layer 3: the banned "a transfer occurred/is occurring" phrasing. */
const BANNED_TRANSFER_RE =
  /te paso con|le paso con|te transfiero|paso la llamada|te comunico con/i;

const VERIFIED_PHONE = "+34600000001";
const OTHER_PHONE = "+34600000002";

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/**
 * `synthetic_test` trust-mode headers (src/callerIdentity/resolver.ts):
 * yields a `verified`, `signed_envelope`-grade identity with no HMAC secret
 * required. Refuses to construct outside NODE_ENV=test — already true here
 * (testEnv() sets it), so this is exactly the fixture the resolver intends
 * for exercises like this file's.
 */
function verifiedHeaders(
  phone: string,
  sessionId = "sess-AAAAAAAA",
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
  sessionId = "sess-BBBBBBBB",
): Record<string, string> {
  return {
    "x-ai-verified-caller-id": phone,
    "x-ai-call-session-id": sessionId,
  };
}

describe("POST /ai/my-reservations", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("outcome: unsupported (BOOKING_UPSTREAM_MODE !== 'ai')", () => {
    it("legacy mode (the default) answers unsupported before any identity or upstream work, honestly (no transfer claim)", async () => {
      testEnv();
      // No nock interceptors registered at all -- if this ever called
      // upstream, the disabled net connect would fail the test outright.
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
      expect(body.message).toBe(LOOKUP_NOT_SUPPORTED_MESSAGE);
      expect(body.message).not.toMatch(BANNED_TRANSFER_RE);
      expect(body.reservations).toBeUndefined();
    });

    it("stays unsupported in legacy mode even with a perfectly verified identity presented", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "legacy" });
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: { ...authHeader, ...verifiedHeaders(VERIFIED_PHONE) },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe("unsupported");
    });
  });

  describe("outcome: identity_missing", () => {
    it("with no caller-identity trust configured (AI_CALLER_ID_TRUST_MODE default 'none'), never calls upstream", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai" });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: { ...authHeader, ...verifiedHeaders(VERIFIED_PHONE) },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("identity_missing");
      expect(body.message).toBe(LOOKUP_IDENTITY_MISSING_MESSAGE);
      expect(body.action).toBe("human_assistance_required");
      expect(body.reservations).toBeUndefined();
    });
  });

  describe("outcome: identity_unverified", () => {
    it("an unattested provider_header identity ('asserted', not 'verified') never calls upstream", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        AI_CALLER_ID_TRUST_MODE: "provider_header",
        AI_CALLER_ID_PROVIDER_ATTESTED: "false",
      });
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: { ...authHeader, ...assertedHeaders(VERIFIED_PHONE) },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("identity_unverified");
      expect(body.message).toBe(LOOKUP_IDENTITY_UNVERIFIED_MESSAGE);
      expect(body.reservations).toBeUndefined();
    });

    it("a session-pin conflict (same call session, different phone) fails closed instead of resolving", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", AI_CALLER_ID_TRUST_MODE: "synthetic_test" });
      app = await buildTestApp();

      const sessionId = "sess-PINCHECK1";
      const first = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: { ...authHeader, ...verifiedHeaders(VERIFIED_PHONE, sessionId) },
        payload: {},
      });
      // First touch has no upstream mock registered -- it will hit
      // identity_missing/identity_unverified's sibling paths only if
      // resolution itself fails, which it must not: assert it got past
      // identity resolution (any outcome OTHER than identity_missing/
      // identity_unverified proves the pin was set, not merely checked).
      expect(["identity_missing", "identity_unverified"]).not.toContain(
        first.json().outcome,
      );

      const second = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: {
          ...authHeader,
          ...verifiedHeaders(OTHER_PHONE, sessionId),
        },
        payload: {},
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().outcome).toBe("identity_unverified");
    });
  });

  describe("request body: unknown fields are rejected (customerPhone/customerName removed, design §5)", () => {
    it("rejects an unknown field with 400", async () => {
      testEnv();
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: authHeader,
        payload: { verified: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects the removed customerPhone field with 400 (never silently ignored)", async () => {
      testEnv();
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: authHeader,
        payload: { customerPhone: "612345678" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects the removed customerName field with 400", async () => {
      testEnv();
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: authHeader,
        payload: { customerName: "Adrián" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts an empty body and an optional fromDate", async () => {
      testEnv();
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: authHeader,
        payload: { fromDate: "2026-08-01" },
      });
      expect(res.statusCode).toBe(200);
    });
  });







  describe("phrasing.ts: no exported string or builder ever claims a transfer (design §9 layer 3)", () => {
    it("sweeps every exported string constant of src/utils/phrasing.ts", () => {
      const strings = Object.entries(phrasing).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      // A bounded, enumerable surface (design §9): fails loudly if it ever
      // shrinks to nothing, which would mean this sweep silently stopped
      // checking anything.
      expect(strings.length).toBeGreaterThan(5);
      for (const [name, value] of strings) {
        expect(value, `${name} must not claim a transfer occurred/is occurring/will occur`).not.toMatch(
          BANNED_TRANSFER_RE,
        );
      }
    });

    it("sweeps every message-producing builder too", () => {
      const samples = [
        phrasing.availabilityMessage(["2026-07-29 09:30:00"]),
        phrasing.availabilityMessage([]),
        phrasing.checkSlotMessage(true, "2026-07-29 09:30:00"),
        phrasing.checkSlotMessage(false, "2026-07-29 09:30:00"),
        phrasing.bookingConfirmedMessage("2026-07-29 09:30:00"),
        phrasing.lookupOneMatchMessage({ dateLabel: "2026-09-08 14:30", employeeName: "Bruno" }),
        phrasing.joinTimesEs(["09:30", "10:00"]),
      ];
      for (const value of samples) {
        expect(value).not.toMatch(BANNED_TRANSFER_RE);
      }
    });
  });

  describe("source guard", () => {
    it("the service file never reintroduces owner.phone, a hardcoded no-booking message, or a transfer claim", () => {
      const path = fileURLToPath(
        new URL("../src/services/lookupService.ts", import.meta.url),
      );
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("owner.phone");
      expect(source).not.toContain("No encuentro ninguna reserva");
      expect(source).not.toMatch(BANNED_TRANSFER_RE);
    });
  });
});
