import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  createCallerIdentityResolver,
  type CallerIdentityConfig,
  type IncomingHeaders,
} from "../src/callerIdentity/resolver.js";
import { createSessionPinStore } from "../src/callerIdentity/sessionPin.js";
import {
  asCancellationGrade,
  CALLER_ID_MAX_LIFETIME_MS,
  CALLER_ID_MAX_SKEW_MS,
  type CallerIdentity,
} from "../src/types/callerIdentity.js";
import { maskPhoneStrict } from "../src/utils/mask.js";

const NOW = 1_700_000_000_000;
const HMAC_SECRET = "s".repeat(32);

const VALID_PHONE_RAW = "612345678";
const VALID_PHONE_E164 = "+34612345678";
const SESSION_A = "sess-AAAAAAAA";
const SESSION_B = "sess-BBBBBBBB";

interface WireEnvelopeFixture {
  callSessionId: string;
  phone: string;
  method: string;
  establishedAtEpochMs: number;
  expiresAtEpochMs: number;
  [extra: string]: unknown;
}

function baseEnvelope(overrides: Partial<WireEnvelopeFixture> = {}): WireEnvelopeFixture {
  return {
    callSessionId: SESSION_A,
    phone: VALID_PHONE_RAW,
    method: "elevenlabs_relay",
    establishedAtEpochMs: NOW,
    expiresAtEpochMs: NOW + 5 * 60_000,
    ...overrides,
  };
}

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function sign(raw: string, secret: string = HMAC_SECRET): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("hex");
}

function signedEnvelopeHeaders(
  envelope: WireEnvelopeFixture,
  opts: { sessionHeader?: string; secret?: string; signatureOverride?: string } = {},
): IncomingHeaders {
  const raw = toBase64(envelope);
  const signature = opts.signatureOverride ?? sign(raw, opts.secret);
  return {
    "x-ai-caller-identity": raw,
    "x-ai-caller-identity-signature": signature,
    "x-ai-call-session-id": opts.sessionHeader ?? envelope.callSessionId,
  };
}

function providerHeaderHeaders(
  phone = VALID_PHONE_RAW,
  sessionId = SESSION_A,
): IncomingHeaders {
  return {
    "x-ai-verified-caller-id": phone,
    "x-ai-call-session-id": sessionId,
  };
}

function syntheticHeaders(envelope: WireEnvelopeFixture): IncomingHeaders {
  return {
    "x-ai-synthetic-caller-identity": toBase64(envelope),
  };
}

function makeResolver(config: CallerIdentityConfig) {
  return createCallerIdentityResolver(config);
}

describe("callerIdentity resolver — trust_mode none", () => {
  it("returns trust_mode_none even with perfect provider_header headers present", () => {
    const resolver = makeResolver({ trustMode: "none", providerAttested: true });
    const result = resolver.resolve(providerHeaderHeaders(), NOW);
    expect(result).toEqual({ ok: false, reason: "trust_mode_none" });
  });

  it("returns trust_mode_none even with a perfectly signed envelope present", () => {
    const resolver = makeResolver({ trustMode: "none", providerAttested: false });
    const headers = signedEnvelopeHeaders(baseEnvelope());
    const result = resolver.resolve(headers, NOW);
    expect(result).toEqual({ ok: false, reason: "trust_mode_none" });
  });
});

describe("callerIdentity resolver — missing identity", () => {
  it("provider_header mode with no headers at all yields missing", () => {
    const resolver = makeResolver({ trustMode: "provider_header", providerAttested: false });
    const result = resolver.resolve({}, NOW);
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("signed_envelope mode with no headers at all yields missing", () => {
    const resolver = makeResolver({
      trustMode: "signed_envelope",
      providerAttested: false,
      hmacSecret: HMAC_SECRET,
    });
    const result = resolver.resolve({}, NOW);
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("synthetic_test mode with no headers at all yields missing", () => {
    const resolver = makeResolver({ trustMode: "synthetic_test", providerAttested: false });
    const result = resolver.resolve({}, NOW);
    expect(result).toEqual({ ok: false, reason: "missing" });
  });
});

describe("callerIdentity resolver — synthetic_test construction guard", () => {
  it("throws at construction when NODE_ENV is not 'test'", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        createCallerIdentityResolver({ trustMode: "synthetic_test", providerAttested: false }),
      ).toThrow();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("is accepted in NODE_ENV=test and yields a verified, synthetic_test identity", () => {
    expect(process.env.NODE_ENV).toBe("test");
    const resolver = makeResolver({ trustMode: "synthetic_test", providerAttested: false });
    const result = resolver.resolve(syntheticHeaders(baseEnvelope()), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.trustLevel).toBe("verified");
      expect(result.identity.verification.source).toBe("synthetic_test");
      expect(result.identity.phoneE164).toBe(VALID_PHONE_E164);
    }
  });
});

describe("callerIdentity resolver — provider_header trust derivation", () => {
  it("without attestation yields 'asserted', never 'verified'", () => {
    const resolver = makeResolver({ trustMode: "provider_header", providerAttested: false });
    const result = resolver.resolve(providerHeaderHeaders(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.trustLevel).toBe("asserted");
      expect(result.identity.verification.source).toBe("provider_header");
    }
  });

  it("with attestation yields 'verified'", () => {
    const resolver = makeResolver({ trustMode: "provider_header", providerAttested: true });
    const result = resolver.resolve(providerHeaderHeaders(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.trustLevel).toBe("verified");
    }
  });

  it("rejects a callSessionId header that fails its regex", () => {
    const resolver = makeResolver({ trustMode: "provider_header", providerAttested: true });
    const result = resolver.resolve(providerHeaderHeaders(VALID_PHONE_RAW, "short"), NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_field" });
  });

  it("rejects an unnormalizable phone", () => {
    const resolver = makeResolver({ trustMode: "provider_header", providerAttested: true });
    const result = resolver.resolve(providerHeaderHeaders("abc", SESSION_A), NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_phone" });
  });
});

describe("callerIdentity resolver — asCancellationGrade (B6 control)", () => {
  it("returns null for an ATTESTED provider_header identity (verified but wrong source)", () => {
    const resolver = makeResolver({ trustMode: "provider_header", providerAttested: true });
    const result = resolver.resolve(providerHeaderHeaders(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.trustLevel).toBe("verified");
      expect(asCancellationGrade(result.identity)).toBeNull();
    }
  });

  it("returns non-null for a verified signed_envelope identity", () => {
    const resolver = makeResolver({
      trustMode: "signed_envelope",
      providerAttested: false,
      hmacSecret: HMAC_SECRET,
    });
    const result = resolver.resolve(signedEnvelopeHeaders(baseEnvelope()), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(asCancellationGrade(result.identity)).not.toBeNull();
    }
  });

  it("returns null for an unverified/asserted identity regardless of source", () => {
    const unverified: CallerIdentity = {
      callSessionId: SESSION_A,
      phoneE164: VALID_PHONE_E164,
      verification: {
        source: "signed_envelope",
        method: "x",
        establishedAtEpochMs: NOW,
        expiresAtEpochMs: NOW + 1000,
      },
      trustLevel: "asserted",
    };
    expect(asCancellationGrade(unverified)).toBeNull();
  });
});

describe("callerIdentity resolver — signed_envelope signature verification", () => {
  function resolverWithSecret(secret = HMAC_SECRET) {
    return makeResolver({ trustMode: "signed_envelope", providerAttested: false, hmacSecret: secret });
  }

  it("accepts a validly signed envelope", () => {
    const resolver = resolverWithSecret();
    const result = resolver.resolve(signedEnvelopeHeaders(baseEnvelope()), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.trustLevel).toBe("verified");
      expect(result.identity.verification.source).toBe("signed_envelope");
      expect(result.identity.phoneE164).toBe(VALID_PHONE_E164);
      expect(result.identity.callSessionId).toBe(SESSION_A);
    }
  });

  it("rejects a tampered payload (single byte flipped after signing)", () => {
    const resolver = resolverWithSecret();
    const envelope = baseEnvelope();
    const raw = toBase64(envelope);
    const signature = sign(raw);
    // Flip the last character of the base64 payload — the signature was
    // computed over the ORIGINAL bytes, so this must fail verification.
    const tampered = raw.slice(0, -1) + (raw.at(-1) === "A" ? "B" : "A");
    const headers: IncomingHeaders = {
      "x-ai-caller-identity": tampered,
      "x-ai-caller-identity-signature": signature,
      "x-ai-call-session-id": envelope.callSessionId,
    };
    const result = resolver.resolve(headers, NOW);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature computed over different bytes than the presented payload", () => {
    const resolver = resolverWithSecret();
    const envelopeA = baseEnvelope({ callSessionId: SESSION_A });
    const envelopeB = baseEnvelope({ callSessionId: SESSION_B });
    const signatureForB = sign(toBase64(envelopeB));
    // Present envelope A's bytes, but a signature that was computed over
    // envelope B's (different) bytes.
    const headers: IncomingHeaders = {
      "x-ai-caller-identity": toBase64(envelopeA),
      "x-ai-caller-identity-signature": signatureForB,
      "x-ai-call-session-id": envelopeA.callSessionId,
    };
    const result = resolver.resolve(headers, NOW);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an oversized (>1024 byte) identity header before ever parsing it", () => {
    const resolver = resolverWithSecret();
    // Not valid base64-encoded JSON at all — if the implementation ever
    // attempted to decode/parse this before the length check, it would be
    // testing the wrong failure path (or throwing). It must be rejected on
    // size alone, without throwing.
    const oversized = "a".repeat(2000);
    const headers: IncomingHeaders = {
      "x-ai-caller-identity": oversized,
      "x-ai-caller-identity-signature": sign(oversized),
      "x-ai-call-session-id": SESSION_A,
    };
    let result;
    expect(() => {
      result = resolver.resolve(headers, NOW);
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false });
  });
});

describe("callerIdentity resolver — freshness", () => {
  function resolverWithSecret() {
    return makeResolver({ trustMode: "signed_envelope", providerAttested: false, hmacSecret: HMAC_SECRET });
  }

  it("rejects an expired identity", () => {
    const resolver = resolverWithSecret();
    const envelope = baseEnvelope({
      establishedAtEpochMs: NOW - 10 * 60_000,
      expiresAtEpochMs: NOW - 1_000,
    });
    const result = resolver.resolve(signedEnvelopeHeaders(envelope), NOW);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an identity established too far in the future (beyond skew)", () => {
    const resolver = resolverWithSecret();
    const establishedAtEpochMs = NOW + CALLER_ID_MAX_SKEW_MS + 1_000;
    const envelope = baseEnvelope({
      establishedAtEpochMs,
      expiresAtEpochMs: establishedAtEpochMs + 60_000,
    });
    const result = resolver.resolve(signedEnvelopeHeaders(envelope), NOW);
    expect(result).toEqual({ ok: false, reason: "future_dated" });
  });

  it("rejects an identity whose lifetime exceeds the maximum (treated as expired)", () => {
    const resolver = resolverWithSecret();
    const envelope = baseEnvelope({
      establishedAtEpochMs: NOW,
      expiresAtEpochMs: NOW + CALLER_ID_MAX_LIFETIME_MS + 1_000,
    });
    const result = resolver.resolve(signedEnvelopeHeaders(envelope), NOW);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});

describe("callerIdentity resolver — session binding", () => {
  it("rejects when the envelope's callSessionId does not match the X-Ai-Call-Session-Id header", () => {
    const resolver = makeResolver({
      trustMode: "signed_envelope",
      providerAttested: false,
      hmacSecret: HMAC_SECRET,
    });
    const envelope = baseEnvelope({ callSessionId: SESSION_A });
    const headers = signedEnvelopeHeaders(envelope, { sessionHeader: SESSION_B });
    const result = resolver.resolve(headers, NOW);
    expect(result).toEqual({ ok: false, reason: "session_mismatch" });
  });
});

describe("callerIdentity resolver — trustLevel/verified/verification fields in the envelope are ignored", () => {
  it("an envelope claiming trustLevel/verified is never adopted; trust stays mode-derived", () => {
    const resolver = makeResolver({ trustMode: "synthetic_test", providerAttested: false });
    const envelope = baseEnvelope({
      trustLevel: "untrusted",
      verified: false,
      verification: { source: "none", method: "x", establishedAtEpochMs: 0, expiresAtEpochMs: 0 },
    });
    const result = resolver.resolve(syntheticHeaders(envelope), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Still "verified" (the synthetic_test rule), NOT downgraded to the
      // envelope's claimed "untrusted"/false — proving the field was never
      // read at all, in either direction.
      expect(result.identity.trustLevel).toBe("verified");
      expect(Object.keys(result.identity)).not.toContain("verified");
    }
  });
});

describe("callerIdentity resolver — phone validation", () => {
  it("rejects an invalid phone in the envelope", () => {
    const resolver = makeResolver({
      trustMode: "signed_envelope",
      providerAttested: false,
      hmacSecret: HMAC_SECRET,
    });
    const envelope = baseEnvelope({ phone: "not-a-phone" });
    const result = resolver.resolve(signedEnvelopeHeaders(envelope), NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_phone" });
  });

  it("normalizes a valid raw phone to E.164", () => {
    const resolver = makeResolver({
      trustMode: "signed_envelope",
      providerAttested: false,
      hmacSecret: HMAC_SECRET,
    });
    const envelope = baseEnvelope({ phone: "612 345 678" });
    const result = resolver.resolve(signedEnvelopeHeaders(envelope), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.phoneE164).toBe("+34612345678");
    }
  });
});

describe("callerIdentity resolver — method and callSessionId field validation", () => {
  function resolverWithSecret() {
    return makeResolver({ trustMode: "signed_envelope", providerAttested: false, hmacSecret: HMAC_SECRET });
  }

  it("rejects a method that fails /^[a-z0-9_]{1,32}$/", () => {
    const resolver = resolverWithSecret();
    const envelope = baseEnvelope({ method: "Bad-Method!" });
    const result = resolver.resolve(signedEnvelopeHeaders(envelope), NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_field" });
  });

  it("rejects a method longer than 32 characters", () => {
    const resolver = resolverWithSecret();
    const envelope = baseEnvelope({ method: "a".repeat(33) });
    const result = resolver.resolve(signedEnvelopeHeaders(envelope), NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_field" });
  });

  it("rejects a callSessionId that fails /^[A-Za-z0-9_-]{8,64}$/ (too short)", () => {
    const resolver = resolverWithSecret();
    const envelope = baseEnvelope({ callSessionId: "short" });
    const headers = signedEnvelopeHeaders(envelope, { sessionHeader: "short" });
    const result = resolver.resolve(headers, NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_field" });
  });

  it("rejects a callSessionId containing disallowed characters", () => {
    const resolver = resolverWithSecret();
    const envelope = baseEnvelope({ callSessionId: "not valid!!" });
    const headers = signedEnvelopeHeaders(envelope, { sessionHeader: "not valid!!" });
    const result = resolver.resolve(headers, NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_field" });
  });
});

describe("createSessionPinStore — first-touch pinning", () => {
  it("pins the first (phone, source) seen for a session; a later different phone conflicts", () => {
    const store = createSessionPinStore({ maxEntries: 10, ttlMs: 60_000 });
    const now = NOW;
    expect(store.check("call-1", "+34600000001", "signed_envelope", now)).toBe("ok");
    expect(store.check("call-1", "+34600000002", "signed_envelope", now)).toBe("conflict");
  });

  it("a poisoned session stays conflicted even for a check matching the original pin", () => {
    const store = createSessionPinStore({ maxEntries: 10, ttlMs: 60_000 });
    const now = NOW;
    expect(store.check("call-2", "+34600000001", "signed_envelope", now)).toBe("ok");
    expect(store.check("call-2", "+34600000002", "signed_envelope", now)).toBe("conflict");
    // Back to the ORIGINAL, correct phone — still a conflict, permanently
    // for the remaining TTL.
    expect(store.check("call-2", "+34600000001", "signed_envelope", now)).toBe("conflict");
  });

  it("a different source under the same session also conflicts", () => {
    const store = createSessionPinStore({ maxEntries: 10, ttlMs: 60_000 });
    const now = NOW;
    expect(store.check("call-3", "+34600000003", "signed_envelope", now)).toBe("ok");
    expect(store.check("call-3", "+34600000003", "provider_header", now)).toBe("conflict");
  });

  it("is bounded: oldest entry is evicted once maxEntries is exceeded", () => {
    const store = createSessionPinStore({ maxEntries: 2, ttlMs: 60_000 });
    const now = NOW;
    expect(store.check("a", "+34600000001", "signed_envelope", now)).toBe("ok");
    expect(store.check("b", "+34600000002", "signed_envelope", now)).toBe("ok");
    // Third distinct session should evict the oldest ("a").
    expect(store.check("c", "+34600000003", "signed_envelope", now)).toBe("ok");
    // "a" was evicted, so touching it with a DIFFERENT phone now looks like
    // a fresh first touch ("ok"), not a conflict — proving it was actually
    // forgotten rather than remembered forever.
    expect(store.check("a", "+34600099999", "signed_envelope", now)).toBe("ok");
  });
});

describe("maskPhoneStrict", () => {
  it("reveals only the last two digits of an E.164 Spanish number", () => {
    const masked = maskPhoneStrict(VALID_PHONE_E164);
    expect(masked).toBe("+34•••••••78");
    expect(masked).not.toContain("6123456");
    expect(masked.endsWith("78")).toBe(true);
  });

  it("does not change the existing maskPhone() behaviour (separate function)", () => {
    // maskPhoneStrict must be a NEW export, not a replacement — this test
    // only asserts maskPhoneStrict's own contract stays narrow.
    const masked = maskPhoneStrict("+34600000001");
    expect(masked).toBe("+34•••••••01");
  });

  it("returns empty string for null/undefined", () => {
    expect(maskPhoneStrict(null)).toBe("");
    expect(maskPhoneStrict(undefined)).toBe("");
  });
});
