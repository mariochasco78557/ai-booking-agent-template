import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
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
import { createCallerIdentityResolver } from "../src/callerIdentity/resolver.js";
import { loadEnv, resetEnvCache } from "../src/config/env.js";
import { createServices } from "../src/services/container.js";
import type { Logger } from "../src/services/authTokenService.js";

/**
 * step 10C, design §11 / phase B11: the adversarial sweep. Every test in
 * this file mounts an attack against the caller-identity/voice contract
 * (internal doc, not included in the template) and asserts
 * the attack FAILS CLOSED — never that it merely "does something safe". No
 * live endpoint, no real network (nock only, same discipline as every other
 * test in this suite), no real phone number, no real credential.
 *
 * This file deliberately overlaps in places with tests/lookup.test.ts,
 * tests/cancellation.test.ts and tests/callerIdentity.test.ts, which already
 * hard-assert most of these properties as part of each unit's own outcome
 * table. Repeating the security-critical ones HERE, gathered under one
 * "adversarial" banner and re-checked at the HTTP/route boundary wherever
 * that is the layer an attacker would actually touch, is deliberate: this
 * file is the one a reviewer can read top-to-bottom to see every attack this
 * mission considered, in one place, independent of whichever unit happens to
 * own the underlying fix.
 */

/** Design §9 layer 3: the banned "a transfer occurred/is occurring" phrasing. */
const BANNED_TRANSFER_RE =
  /te paso con|le paso con|te transfiero|paso la llamada|te comunico con/i;

let app: FastifyInstance;
const authHeader = { "x-ai-webhook-secret": WEBHOOK_SECRET };

const VERIFIED_PHONE = "+34600000005";
const VERIFIED_PHONE_NATIONAL = "600000005"; // the 9 raw digits — must NEVER appear unmasked in a log
const HMAC_SECRET = "adversarial-suite-not-a-real-secret-32b!";

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/** `synthetic_test` trust-mode headers — see tests/lookup.test.ts's identical helper for the full rationale. */
function syntheticHeaders(
  phone: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, string> {
  const now = Date.now();
  const envelope = {
    callSessionId: sessionId,
    phone,
    method: "adversarial",
    establishedAtEpochMs: now,
    expiresAtEpochMs: now + 5 * 60_000,
    ...overrides,
  };
  return { "x-ai-synthetic-caller-identity": toBase64(envelope) };
}

/** Signs a JSON envelope for `signed_envelope` trust mode, exactly like tests/callerIdentity.test.ts. */
function sign(raw: string, secret: string = HMAC_SECRET): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("hex");
}

function signedEnvelopeHeaders(
  envelope: Record<string, unknown>,
  opts: { sessionHeader?: string; secret?: string } = {},
): Record<string, string> {
  const raw = toBase64(envelope);
  const signature = sign(raw, opts.secret);
  return {
    "x-ai-caller-identity": raw,
    "x-ai-caller-identity-signature": signature,
    "x-ai-call-session-id": opts.sessionHeader ?? (envelope.callSessionId as string),
  };
}

function cancelPayload(overrides: Record<string, unknown> = {}) {
  return {
    reservationRef: "a".repeat(32),
    confirmedByCustomer: true,
    callerStatedName: "Ana García",
    ...overrides,
  };
}

/**
 * Every HTTP response body captured across this file's attacks, swept
 * EXACTLY ONCE at the end (item 16 of this mission's list: "no response
 * body in ANY of the above matches the banned transfer regex"). vitest runs
 * `it` blocks within one file in declaration order by default — the same
 * assumption tests/voiceE2E.test.ts's own end-of-file sweep relies on.
 */
const capturedResponses: unknown[] = [];
function capture(body: unknown): unknown {
  capturedResponses.push(body);
  return body;
}

describe("adversarial sweep (design §11, phase B11) — every attack below MUST fail closed", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("1. forged trust claims in the request BODY are rejected by .strict(), and the resolver never sees them", () => {
    it("the resolver's own signature has no parameter a request body could ever reach (design §3 rule 2, enforced by construction)", () => {
      const resolver = createCallerIdentityResolver({ trustMode: "none", providerAttested: false });
      // (headers, nowMs) — exactly two parameters. There is no third
      // parameter through which a request body could be smuggled in, so
      // "the resolver never sees the body" is not a promise this test takes
      // on faith; it is a fact about the function's own arity.
      expect(resolver.resolve.length).toBe(2);
    });

    it.each([
      ["verified", { verified: true }],
      ["verification", { verification: { source: "signed_envelope", trustLevel: "verified" } }],
      ["verifiedCallerId", { verifiedCallerId: VERIFIED_PHONE }],
    ])("a forged `%s` field in /ai/my-reservations' body is rejected with 400", async (_name, extra) => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai" });
      app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: authHeader,
        payload: extra,
      });
      expect(res.statusCode).toBe(400);
      capture(res.json());
    });

    it.each([
      ["verified", { verified: true }],
      ["verification", { verification: { source: "signed_envelope", trustLevel: "verified" } }],
      ["verifiedCallerId", { verifiedCallerId: VERIFIED_PHONE }],
    ])("a forged `%s` field in /ai/cancel's body is rejected with 400", async (_name, extra) => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true" });
      app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: authHeader,
        payload: { ...cancelPayload(), ...extra },
      });
      expect(res.statusCode).toBe(400);
      capture(res.json());
    });
  });

  describe("2. a forged provider source cannot elevate trust", () => {
    it("headers belonging to the STRONGER signed_envelope channel, injected alongside weaker provider_header headers, are simply never read", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        AI_CALLER_ID_TRUST_MODE: "provider_header",
        AI_CALLER_ID_PROVIDER_ATTESTED: "false",
      });
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: {
          ...authHeader,
          "x-ai-verified-caller-id": VERIFIED_PHONE,
          "x-ai-call-session-id": "sess-ADV-FORGE1",
          // Forged: headers belonging to a channel this trust mode's
          // resolveProviderHeader() never reads at all (design §4's table —
          // each mode reads its own fixed header set, never another mode's).
          "x-ai-caller-identity": "irrelevant-forged-envelope",
          "x-ai-caller-identity-signature": "irrelevant-forged-signature",
        },
        payload: {},
      });
      const body = res.json();
      // Unattested provider_header is "asserted", never "verified" —
      // injecting stronger-channel headers does not change that.
      expect(body.outcome).toBe("identity_unverified");
      capture(body);
    });
  });

  describe("3. a header literally claiming trustLevel: verified is ignored", () => {
    it("no header named trustLevel (or similar) is ever consulted by the resolver", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai" }); // AI_CALLER_ID_TRUST_MODE defaults to "none"
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: {
          ...authHeader,
          "x-ai-trust-level": "verified",
          trustlevel: "verified",
          "x-trust-level": "verified",
        },
        payload: {},
      });
      const body = res.json();
      expect(body.outcome).toBe("identity_missing");
      capture(body);
    });
  });

  describe("4. caller phone changed mid-session — pinned, fails closed, and STAYS failed (poisoned)", () => {
    it("a third request presenting the ORIGINAL phone again is still refused once the session is poisoned", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", AI_CALLER_ID_TRUST_MODE: "synthetic_test" });
      app = await buildTestApp();
      const sessionId = "sess-ADV-POISON1";
      const phoneA = VERIFIED_PHONE;
      const phoneB = "+34600000006";

      const first = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: { ...authHeader, ...syntheticHeaders(phoneA, sessionId) },
        payload: {},
      });
      // First touch pins (phoneA, synthetic_test) for this session — proven
      // by NOT being identity_missing/identity_unverified.
      expect(["identity_missing", "identity_unverified"]).not.toContain(first.json().outcome);

      const second = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: { ...authHeader, ...syntheticHeaders(phoneB, sessionId) },
        payload: {},
      });
      expect(second.json().outcome).toBe("identity_unverified");

      // THIRD request, back to the ORIGINAL correct phone. Design §4.2: a
      // poisoned session stays poisoned for the REMAINING TTL, even for a
      // check that would otherwise match the original pin exactly.
      const third = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: { ...authHeader, ...syntheticHeaders(phoneA, sessionId) },
        payload: {},
      });
      expect(third.statusCode).toBe(200);
      expect(third.json().outcome).toBe("identity_unverified");
      capture(first.json());
      capture(second.json());
      capture(third.json());
    });
  });

  describe("5. call session id changed — signed envelope rejected (session_mismatch)", () => {
    it("the resolver rejects a signed envelope whose callSessionId disagrees with X-Ai-Call-Session-Id, with reason session_mismatch", () => {
      // Asserted directly against the resolver (not merely via the route):
      // /ai/my-reservations and /ai/cancel deliberately collapse EVERY
      // resolver failure to the same generic identity_missing outcome
      // (design §5.2/§6.2) — telling a caller-facing response APART would
      // turn this middleware into a fingerprinting oracle for exactly the
      // kind of attack this test mounts. The specific reason is only ever
      // visible to the resolver's own caller, which is what this asserts.
      const resolver = createCallerIdentityResolver({
        trustMode: "signed_envelope",
        providerAttested: false,
        hmacSecret: HMAC_SECRET,
      });
      const now = Date.now();
      const envelope = {
        callSessionId: "sess-ADV-SESSIONA",
        phone: "612345678",
        method: "adversarial",
        establishedAtEpochMs: now,
        expiresAtEpochMs: now + 60_000,
      };
      const headers = signedEnvelopeHeaders(envelope, { sessionHeader: "sess-ADV-SESSIONB-DIFFERENT" });
      const result = resolver.resolve(headers, now);
      expect(result).toEqual({ ok: false, reason: "session_mismatch" });
    });

    it("at the route, the same attack is indistinguishable from any other identity failure — identity_missing, never a partial success", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        AI_CALLER_ID_TRUST_MODE: "signed_envelope",
        AI_CALLER_ID_HMAC_SECRET: HMAC_SECRET,
      });
      app = await buildTestApp();
      const now = Date.now();
      const envelope = {
        callSessionId: "sess-ADV-SESSIONC",
        phone: "612345678",
        method: "adversarial",
        establishedAtEpochMs: now,
        expiresAtEpochMs: now + 60_000,
      };
      const headers = signedEnvelopeHeaders(envelope, { sessionHeader: "sess-ADV-SESSIOND-DIFFERENT" });

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: { ...authHeader, ...headers },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe("identity_missing");
      capture(res.json());
    });
  });

  describe("6. replayed caller context after expiry is rejected", () => {
    it("the resolver rejects an envelope past expiresAtEpochMs, with reason expired", () => {
      const resolver = createCallerIdentityResolver({
        trustMode: "signed_envelope",
        providerAttested: false,
        hmacSecret: HMAC_SECRET,
      });
      const now = Date.now();
      const envelope = {
        callSessionId: "sess-ADV-EXPIRED1",
        phone: "612345678",
        method: "adversarial",
        establishedAtEpochMs: now - 10 * 60_000,
        expiresAtEpochMs: now - 1_000, // already expired
      };
      const headers = signedEnvelopeHeaders(envelope);
      const result = resolver.resolve(headers, now);
      expect(result).toEqual({ ok: false, reason: "expired" });
    });

    it("at the route, a replayed expired context never calls upstream and never resolves an identity", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", AI_CALLER_ID_TRUST_MODE: "synthetic_test" });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();
      const now = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: {
          ...authHeader,
          ...syntheticHeaders(VERIFIED_PHONE, "sess-ADV-EXPIRED2", {
            establishedAtEpochMs: now - 20 * 60_000,
            expiresAtEpochMs: now - 5_000,
          }),
        },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe("identity_missing");
      capture(res.json());
    });
  });

  describe("7. reservation-reference injection is rejected BEFORE any upstream call", () => {
    it.each([
      ["path-shaped", `../../etc/passwd${"a".repeat(15)}`],
      ["oversized", "a".repeat(500)],
      ["non-32-char (too short)", "a".repeat(10)],
      ["wrong alphabet (contains '/')", "/".repeat(32)],
    ])("a %s reservationRef is rejected with 400", async (_label, ref) => {
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
        headers: { ...authHeader, ...syntheticHeaders(VERIFIED_PHONE, "sess-ADV-REF") },
        payload: cancelPayload({ reservationRef: ref }),
      });
      expect(res.statusCode).toBe(400);
      capture(res.json());
    });
  });


  describe("9. a raw numeric id cancellation attempt is rejected with 400", () => {
    it("the retired legacy reservationId field never authorizes a cancel", async () => {
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
        headers: { ...authHeader, ...syntheticHeaders(VERIFIED_PHONE, "sess-ADV-RAWID") },
        payload: { reservationId: 86292, confirmedByCustomer: true, callerStatedName: "Ana" },
      });
      expect(res.statusCode).toBe(400);
      capture(res.json());
    });
  });

  describe("10. unexpected extra fields on EVERY /ai/* route are rejected with 400", () => {
    const cases: Array<{ route: string; payload: Record<string, unknown> }> = [
      { route: "/ai/availability", payload: { date: "2026-08-03", typeReservation: "1" } },
      { route: "/ai/check-slot", payload: { reservationDate: "2026-08-03 09:30:00" } },
      {
        route: "/ai/book",
        payload: {
          customer: { name: "Ana", surnames: "García", phone: VERIFIED_PHONE },
          reservationDate: "2026-08-03 09:30:00",
          confirmedByCustomer: true,
        },
      },
      { route: "/ai/my-reservations", payload: {} },
      { route: "/ai/cancel", payload: cancelPayload() },
    ];

    it.each(cases)("$route rejects an unexpected extra field with 400", async ({ route, payload }) => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true" });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: route,
        headers: authHeader,
        payload: { ...payload, unexpectedExtraField: "attacker-controlled" },
      });
      expect(res.statusCode).toBe(400);
      capture(res.json());
    });
  });

  describe("11. nested verification object injection is rejected with 400", () => {
    it.each(["/ai/my-reservations", "/ai/cancel"])(
      "%s rejects a nested verification object claiming trustLevel/source",
      async (route) => {
        testEnv({ BOOKING_UPSTREAM_MODE: "ai", ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true" });
        app = await buildTestApp();

        const basePayload = route === "/ai/cancel" ? cancelPayload() : {};
        const res = await app.inject({
          method: "POST",
          url: route,
          headers: authHeader,
          payload: {
            ...basePayload,
            verification: {
              source: "signed_envelope",
              trustLevel: "verified",
              method: "forged",
              establishedAtEpochMs: Date.now(),
              expiresAtEpochMs: Date.now() + 60_000,
            },
          },
        });
        expect(res.statusCode).toBe(400);
        capture(res.json());
      },
    );
  });

  describe("12. oversized field values are rejected", () => {
    it("a callerStatedName large enough to blow the request bodyLimit is rejected before any upstream call, and closes as an ordinary client error", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true",
        AI_CALLER_ID_TRUST_MODE: "synthetic_test",
      });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      // src/app.ts sets `bodyLimit: 32 * 1024` (32 KiB) globally. A single
      // ~40 KiB field blows that ceiling long before Zod's own (unbounded)
      // `callerStatedName: z.string().trim().min(1)` would ever see it —
      // this is the ACTUAL bound protecting this field today, not a
      // per-field max length, so this test exercises that real control
      // rather than asserting a limit the schema does not itself enforce.
      const oversizedName = "A".repeat(40_000);
      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: { ...authHeader, ...syntheticHeaders(VERIFIED_PHONE, "sess-ADV-OVERSIZED") },
        payload: cancelPayload({ callerStatedName: oversizedName }),
      });
      // Observed/pinned exactly (not merely "some 4xx"): Fastify's own
      // bodyLimit rejection surfaces as 413, handled by
      // src/plugins/errorHandler.ts's generic branch (never a 500, never an
      // echo of the oversized value).
      expect(res.statusCode).toBe(413);
      expect(JSON.stringify(res.json())).not.toContain(oversizedName);
      capture(res.json());
    });

    it("an oversized reservationRef (well beyond 32 chars) is rejected with 400 by the same regex bound as the path-injection case", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true",
        AI_CALLER_ID_TRUST_MODE: "synthetic_test",
      });
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: { ...authHeader, ...syntheticHeaders(VERIFIED_PHONE, "sess-ADV-OVERSIZED2") },
        payload: cancelPayload({ reservationRef: "z".repeat(1000) }),
      });
      expect(res.statusCode).toBe(400);
      capture(res.json());
    });
  });

  describe("13. a malformed telephone in the identity envelope never verifies", () => {
    it("the resolver rejects an unnormalizable phone in a signed envelope, with reason invalid_phone", () => {
      const resolver = createCallerIdentityResolver({
        trustMode: "signed_envelope",
        providerAttested: false,
        hmacSecret: HMAC_SECRET,
      });
      const now = Date.now();
      const envelope = {
        callSessionId: "sess-ADV-BADPHONE1",
        phone: "not-a-phone-number",
        method: "adversarial",
        establishedAtEpochMs: now,
        expiresAtEpochMs: now + 60_000,
      };
      const result = resolver.resolve(signedEnvelopeHeaders(envelope), now);
      expect(result).toEqual({ ok: false, reason: "invalid_phone" });
    });

    it("at the route, a malformed telephone never reaches 'verified' and never calls upstream", async () => {
      testEnv({ BOOKING_UPSTREAM_MODE: "ai", AI_CALLER_ID_TRUST_MODE: "synthetic_test" });
      // No nock interceptors -- proves the upstream is never touched.
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/my-reservations",
        headers: {
          ...authHeader,
          ...syntheticHeaders("+1-not-spanish-999", "sess-ADV-BADPHONE2"),
        },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe("identity_missing");
      capture(res.json());
    });
  });



  describe("16. false-transfer claim: every response captured by THIS file's attacks stays honest", () => {
    it("no captured response body, from any attack above, matches the banned transfer regex", () => {
      // A bounded, enumerable surface (same discipline as
      // tests/voiceE2E.test.ts's own end-of-file sweep): fails loudly if
      // this ever shrinks to nothing, which would mean the sweep silently
      // stopped checking anything.
      expect(capturedResponses.length).toBeGreaterThan(15);
      for (const body of capturedResponses) {
        expect(JSON.stringify(body)).not.toMatch(BANNED_TRANSFER_RE);
      }
    });
  });

  describe("17. an attested provider_header identity cannot cancel — the B6 control, re-asserted at route level", () => {
    it("is refused with insufficient_trust_for_write, and the proof endpoint is NEVER called", async () => {
      testEnv({
        BOOKING_UPSTREAM_MODE: "ai",
        ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true",
        AI_CALLER_ID_TRUST_MODE: "provider_header",
        AI_CALLER_ID_PROVIDER_ATTESTED: "true",
        AI_CALLER_ID_ATTESTATION_REF: "adversarial-suite-attestation-2026-07-28",
      });
      // NO nock interceptor for /ai/cancellation/proof or /ai/cancellation
      // anywhere in this test — the second, independent proof upstream was
      // never touched (disableNetConnect would throw if it were).
      app = await buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ai/cancel",
        headers: {
          ...authHeader,
          "x-ai-verified-caller-id": VERIFIED_PHONE,
          "x-ai-call-session-id": "sess-ADV-B6-1",
        },
        payload: cancelPayload(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outcome).toBe("insufficient_trust_for_write");
      expect(body.action).toBe("human_assistance_required");
      capture(body);
    });
  });

  describe("18. regression: L-1/L-2 are not testable from this middleware; the dangerous defaults still are", () => {
    // The L-1 (self-role-escalation) and L-2 (UserVoter EDIT-pair) fixes
    // live entirely in the step 10B Symfony overlay
    // (tools/legacy-symfony-lab/mvps10b/patches/003-l1-user-field-policy.patch,
    // 004-l2-uservoter-edit-pair.patch) — there is no Node/TypeScript source
    // in THIS repository that could regress them, so no assertion here
    // could ever exercise that code. Their regression suites
    // (t_l1_fixed.php, t_l2_fixed.php, t_mass_assignment.php, and the
    // t_l1_isolation.php override) run inside the disposable Symfony lab via
    // `bash tools/legacy-symfony-lab/mvps10b/run.sh authz-tests` /
    // `validate.sh`, reused unchanged by the step 10C lab
    // (tools/legacy-symfony-lab/mvps10c/apply-overlay.sh) — see that lab's
    // README.md. What IS testable from here, and load-bearing for this
    // mission specifically, is that the two independent kill-switches this
    // whole design layers on top of that Symfony boundary still default to
    // their safe values.
    it("BOOKING_UPSTREAM_MODE still defaults to 'legacy'", () => {
      const saved: Record<string, string | undefined> = {
        BOOKING_USERNAME: process.env.BOOKING_USERNAME,
        BOOKING_PASSWORD: process.env.BOOKING_PASSWORD,
        AI_WEBHOOK_SECRET: process.env.AI_WEBHOOK_SECRET,
        BOOKING_UPSTREAM_MODE: process.env.BOOKING_UPSTREAM_MODE,
        ENABLE_WRITE_OPERATIONS: process.env.ENABLE_WRITE_OPERATIONS,
      };
      delete process.env.BOOKING_UPSTREAM_MODE;
      delete process.env.ENABLE_WRITE_OPERATIONS;
      process.env.BOOKING_USERNAME = "adversarial-test-user";
      process.env.BOOKING_PASSWORD = "adversarial-test-pass";
      process.env.AI_WEBHOOK_SECRET = "x".repeat(32);
      resetEnvCache();
      try {
        const env = loadEnv();
        expect(env.BOOKING_UPSTREAM_MODE).toBe("legacy");
        expect(env.ENABLE_WRITE_OPERATIONS).toBe(false);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        resetEnvCache();
      }
    });
  });
});
