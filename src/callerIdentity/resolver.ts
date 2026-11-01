import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeSpanishPhone } from "../utils/phone.js";
import {
  CALLER_ID_MAX_LIFETIME_MS,
  CALLER_ID_MAX_SKEW_MS,
  type CallerIdentity,
  type CallerIdentityFailure,
  type ResolvedCallerIdentity,
} from "../types/callerIdentity.js";

/**
 * Caller-identity resolver. See
 * (internal doc, not included in the template) §4, §4.1, §4.3.
 *
 * The single most important property of this module is stated by its own
 * type signature, not by a comment a future editor can skim past: `resolve`
 * takes a HEADERS MAP ONLY. There is no parameter through which a request
 * body could reach trust derivation. §2 of the design is explicit about why:
 * "whoever can call the middleware can set any header on that call" — so a
 * header is an INPUT, never a VERDICT, and trust is computed by the
 * middleware from its own configuration, never accepted as a claim.
 */

/** How much the middleware is configured to believe, and from where. */
export interface CallerIdentityConfig {
  trustMode: "none" | "provider_header" | "signed_envelope" | "synthetic_test";
  /**
   * A human has attested, out of band, that the configured provider
   * genuinely performs telephony caller-ID verification and populates
   * `X-Ai-Verified-Caller-Id` from a value the model cannot influence
   * (design §4.1). Only meaningful when `trustMode === "provider_header"`.
   */
  providerAttested: boolean;
  /** Required when `trustMode === "signed_envelope"`. Never logged. */
  hmacSecret?: string;
}

/**
 * Reserved for future injectable dependencies. Empty today, deliberately: a
 * distinct second parameter (rather than folding everything into `config`)
 * means a later wave can inject something like the bounded session-pin
 * store (`src/callerIdentity/sessionPin.ts`) without changing this factory's
 * call sites again.
 */
export type CallerIdentityResolverDeps = Record<string, never>;

/** Fastify's own header map shape — repeated locally so this file has zero framework import. */
export type IncomingHeaders = Record<string, string | string[] | undefined>;

export interface CallerIdentityResolver {
  resolve(headers: IncomingHeaders, nowMs: number): ResolvedCallerIdentity;
}

const HEADER_VERIFIED_CALLER_ID = "x-ai-verified-caller-id";
const HEADER_CALL_SESSION_ID = "x-ai-call-session-id";
const HEADER_SIGNED_IDENTITY = "x-ai-caller-identity";
const HEADER_SIGNED_IDENTITY_SIGNATURE = "x-ai-caller-identity-signature";
const HEADER_SYNTHETIC_IDENTITY = "x-ai-synthetic-caller-identity";

/** Design §4.3 step 1: reject an oversized envelope before touching it. */
const MAX_SIGNED_ENVELOPE_BYTES = 1024;

/** Design §4.3 step 4 and §3: attacker-influenced fields, validated before use or logging. */
const METHOD_RE = /^[a-z0-9_]{1,32}$/;
const CALL_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** `provider_header` never carries its own method string; the resolver assigns this constant. */
const PROVIDER_HEADER_METHOD = "provider_header";

function fail(reason: CallerIdentityFailure): ResolvedCallerIdentity {
  return { ok: false, reason };
}

function firstHeaderValue(
  headers: IncomingHeaders,
  name: string,
): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Constant-time compare, safe for differing lengths — the exact pattern
 * already established by `src/plugins/webhookAuth.ts`'s `safeEqual`.
 * Duplicated rather than imported: that function is private to the webhook
 * plugin, and this module must not depend on the webhook plugin (or on
 * Fastify) at all.
 */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Still burn a comparison to avoid a trivial length timing leak.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Fields the wire envelope (`x-ai-caller-identity` / synthetic-test header)
 * is expected to carry, decoded but not yet validated. Any OTHER field —
 * notably `trustLevel`, `verified`, `verification` — is simply never read
 * below. Ignoring a field is the enforcement; there is nothing to
 * "reject" because nothing downstream ever looks it up.
 */
interface WireEnvelope {
  callSessionId?: unknown;
  phone?: unknown;
  method?: unknown;
  establishedAtEpochMs?: unknown;
  expiresAtEpochMs?: unknown;
}

/** Result of decoding + field-validating a wire envelope, before freshness/session checks. */
type ParsedEnvelope =
  | {
      ok: true;
      callSessionId: string;
      phoneE164: string;
      method: string;
      establishedAtEpochMs: number;
      expiresAtEpochMs: number;
    }
  | { ok: false; reason: CallerIdentityFailure };

/**
 * Base64-decodes + JSON.parses a wire envelope and validates every field
 * per design §4.3 step 4 / §3 rule 1 — before any value is returned or
 * logged. Callers of this function are responsible for having already done
 * any signature verification (§4.3 steps 1–2): this function only ever
 * touches bytes the caller has decided are safe to parse.
 */
function decodeAndValidateEnvelope(rawBase64: string): ParsedEnvelope {
  let parsed: unknown;
  try {
    const json = Buffer.from(rawBase64, "base64").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed" };
  }
  const env = parsed as WireEnvelope;

  if (typeof env.callSessionId !== "string" || !CALL_SESSION_ID_RE.test(env.callSessionId)) {
    return { ok: false, reason: "invalid_field" };
  }
  if (typeof env.method !== "string" || !METHOD_RE.test(env.method)) {
    return { ok: false, reason: "invalid_field" };
  }
  if (
    typeof env.establishedAtEpochMs !== "number" ||
    !Number.isFinite(env.establishedAtEpochMs) ||
    typeof env.expiresAtEpochMs !== "number" ||
    !Number.isFinite(env.expiresAtEpochMs)
  ) {
    return { ok: false, reason: "invalid_field" };
  }
  if (typeof env.phone !== "string") {
    return { ok: false, reason: "invalid_phone" };
  }
  const normalized = normalizeSpanishPhone(env.phone);
  if (!normalized.ok) {
    return { ok: false, reason: "invalid_phone" };
  }

  return {
    ok: true,
    callSessionId: env.callSessionId,
    phoneE164: normalized.e164,
    method: env.method,
    establishedAtEpochMs: env.establishedAtEpochMs,
    expiresAtEpochMs: env.expiresAtEpochMs,
  };
}

/**
 * Design §3 rule 5 / §4.2: freshness is mandatory and pinned to concrete
 * constants, not an unquantified ceiling. Order matters only in that all
 * three are checked; the constants make each check independent.
 */
function checkFreshness(
  establishedAtEpochMs: number,
  expiresAtEpochMs: number,
  nowMs: number,
): CallerIdentityFailure | null {
  if (nowMs >= expiresAtEpochMs) return "expired";
  if (establishedAtEpochMs > nowMs + CALLER_ID_MAX_SKEW_MS) return "future_dated";
  if (expiresAtEpochMs - establishedAtEpochMs > CALLER_ID_MAX_LIFETIME_MS) {
    return "expired";
  }
  return null;
}

/**
 * Builds a resolver for the configured trust mode. Construction can throw
 * — deliberately, for `synthetic_test` — because a resolver that could
 * silently exist in a running production process, waiting for someone to
 * send the test header, is exactly the failure mode this design refuses to
 * allow (design §4 table).
 */
export function createCallerIdentityResolver(
  config: CallerIdentityConfig,
  _deps: CallerIdentityResolverDeps = {},
): CallerIdentityResolver {
  if (config.trustMode === "synthetic_test" && process.env.NODE_ENV !== "test") {
    throw new Error(
      "AI_CALLER_ID_TRUST_MODE=synthetic_test may only be constructed when NODE_ENV=test. " +
        "This is a fail-closed guard, not a bug: this mode must never be reachable in a running service.",
    );
  }
  // Defensive, in addition to (not instead of) src/config/env.ts's own
  // superRefine: a resolver constructed by anything other than the normal
  // env-loading path (e.g. a future caller, a test) must still fail closed
  // rather than silently verify HMAC against `undefined`.
  if (config.trustMode === "signed_envelope" && !config.hmacSecret) {
    throw new Error(
      "AI_CALLER_ID_TRUST_MODE=signed_envelope requires a non-empty AI_CALLER_ID_HMAC_SECRET.",
    );
  }

  function resolveProviderHeader(
    headers: IncomingHeaders,
    nowMs: number,
  ): ResolvedCallerIdentity {
    const rawPhone = firstHeaderValue(headers, HEADER_VERIFIED_CALLER_ID);
    const sessionId = firstHeaderValue(headers, HEADER_CALL_SESSION_ID);
    if (!rawPhone || !sessionId) {
      return fail("missing");
    }
    if (!CALL_SESSION_ID_RE.test(sessionId)) {
      return fail("invalid_field");
    }
    const normalized = normalizeSpanishPhone(rawPhone);
    if (!normalized.ok) {
      return fail("invalid_phone");
    }

    const establishedAtEpochMs = nowMs;
    const expiresAtEpochMs = nowMs + CALLER_ID_MAX_LIFETIME_MS;

    const identity: CallerIdentity = {
      callSessionId: sessionId,
      phoneE164: normalized.e164,
      verification: {
        source: "provider_header",
        method: PROVIDER_HEADER_METHOD,
        establishedAtEpochMs,
        expiresAtEpochMs,
      },
      // Design §4.1: verified ONLY if a human has attested the provider
      // guarantee out of band. Never inferred from the header itself.
      trustLevel: config.providerAttested ? "verified" : "asserted",
    };
    return { ok: true, identity };
  }

  function resolveSignedEnvelope(
    headers: IncomingHeaders,
    nowMs: number,
  ): ResolvedCallerIdentity {
    const rawIdentity = firstHeaderValue(headers, HEADER_SIGNED_IDENTITY);
    const rawSignature = firstHeaderValue(headers, HEADER_SIGNED_IDENTITY_SIGNATURE);
    if (!rawIdentity || !rawSignature) {
      return fail("missing");
    }

    // §4.3 step 1 — length-bound BEFORE touching the bytes at all.
    if (Buffer.byteLength(rawIdentity, "utf8") > MAX_SIGNED_ENVELOPE_BYTES) {
      return fail("malformed");
    }

    // §4.3 step 2 — constant-time HMAC over the RAW RECEIVED bytes, never
    // over the decoded/parsed value. This is load-bearing ordering: verify
    // first, decode second, so an attacker-controlled string is never fed
    // to JSON.parse before it is authenticated.
    const expectedSignature = createHmac("sha256", config.hmacSecret as string)
      .update(rawIdentity, "utf8")
      .digest("hex");
    const providedBuf = Buffer.from(rawSignature, "utf8");
    const expectedBuf = Buffer.from(expectedSignature, "utf8");
    if (!safeEqual(providedBuf, expectedBuf)) {
      return fail("bad_signature");
    }

    // §4.3 step 3 — ONLY NOW decode + parse, and step 4 — validate every
    // field before it can reach a log line.
    const parsed = decodeAndValidateEnvelope(rawIdentity);
    if (!parsed.ok) {
      return fail(parsed.reason);
    }

    const freshnessFailure = checkFreshness(
      parsed.establishedAtEpochMs,
      parsed.expiresAtEpochMs,
      nowMs,
    );
    if (freshnessFailure) {
      return fail(freshnessFailure);
    }

    // §4.2 — a signed envelope replayed under a different call session is
    // rejected. A missing session header compares unequal to a present
    // envelope session id, so it is caught by the same branch.
    const sessionHeader = firstHeaderValue(headers, HEADER_CALL_SESSION_ID);
    if (parsed.callSessionId !== sessionHeader) {
      return fail("session_mismatch");
    }

    const identity: CallerIdentity = {
      callSessionId: parsed.callSessionId,
      phoneE164: parsed.phoneE164,
      verification: {
        source: "signed_envelope",
        method: parsed.method,
        establishedAtEpochMs: parsed.establishedAtEpochMs,
        expiresAtEpochMs: parsed.expiresAtEpochMs,
      },
      trustLevel: "verified",
    };
    return { ok: true, identity };
  }

  function resolveSyntheticTest(
    headers: IncomingHeaders,
    nowMs: number,
  ): ResolvedCallerIdentity {
    const raw = firstHeaderValue(headers, HEADER_SYNTHETIC_IDENTITY);
    if (!raw) {
      return fail("missing");
    }
    // No signature required in this mode — it exists only to let local
    // synthetic tests exercise the "verified, signed_envelope-grade" path
    // without an HMAC secret. Construction above already refuses to exist
    // outside NODE_ENV=test, which is the actual safety boundary here.
    const parsed = decodeAndValidateEnvelope(raw);
    if (!parsed.ok) {
      return fail(parsed.reason);
    }

    const freshnessFailure = checkFreshness(
      parsed.establishedAtEpochMs,
      parsed.expiresAtEpochMs,
      nowMs,
    );
    if (freshnessFailure) {
      return fail(freshnessFailure);
    }

    const identity: CallerIdentity = {
      callSessionId: parsed.callSessionId,
      phoneE164: parsed.phoneE164,
      verification: {
        source: "synthetic_test",
        method: parsed.method,
        establishedAtEpochMs: parsed.establishedAtEpochMs,
        expiresAtEpochMs: parsed.expiresAtEpochMs,
      },
      trustLevel: "verified",
    };
    return { ok: true, identity };
  }

  return {
    resolve(headers: IncomingHeaders, nowMs: number): ResolvedCallerIdentity {
      switch (config.trustMode) {
        case "none":
          // Design §4 table: no identity is EVER resolved in this mode,
          // whatever headers arrive. Checked first and unconditionally.
          return fail("trust_mode_none");
        case "provider_header":
          return resolveProviderHeader(headers, nowMs);
        case "signed_envelope":
          return resolveSignedEnvelope(headers, nowMs);
        case "synthetic_test":
          return resolveSyntheticTest(headers, nowMs);
        default: {
          // Exhaustiveness guard, matching the house style of the upstream
          // `code` switches required elsewhere in this design (§5.1).
          const _exhaustive: never = config.trustMode;
          return fail("trust_mode_none");
        }
      }
    },
  };
}
