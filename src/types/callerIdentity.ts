/**
 * The caller-identity envelope (provider-agnostic).
 *
 * See (internal doc, not included in the template) §3, §4, §4.1,
 * §4.1.1 and §4.3. This module is types only — no I/O, no header parsing, no
 * env access — so every consumer (resolver, session pin store, routes,
 * tests) shares one definition of what "trust" is allowed to mean.
 *
 * The load-bearing rule, stated once so every reader of this file sees it:
 *
 *   `trustLevel` is NEVER read from the wire. It is DERIVED by the resolver
 *   (src/callerIdentity/resolver.ts) from configuration the middleware
 *   controls, never accepted as a claim in a header or a request body. Any
 *   inbound field named `trustLevel`, `verified`, or `verification` is
 *   ignored on the header path and rejected on the body path (the latter by
 *   Zod `.strict()` schemas added in a later wave).
 */

/**
 * How a `CallerIdentity` was produced.
 * - `provider_header`: an UNSIGNED header from the (webhook-authenticated)
 *   provider. Spoofable by anyone who can set headers on the call, so it
 *   yields `verified` only when a human has attested the provider's
 *   guarantee out of band (§4.1) — never by default.
 * - `signed_envelope`: an HMAC-signed envelope, resistant even to a party
 *   holding the webhook secret, provided the HMAC key never reaches the
 *   prompt. This is the mode cancellation requires (§4.1.1).
 * - `synthetic_test`: a test-only fixture. Refuses to exist outside
 *   `NODE_ENV=test` — enforced at resolver construction, not merely by
 *   convention (§4).
 */
export type CallerVerificationSource =
  | "provider_header"
  | "signed_envelope"
  | "synthetic_test";

/**
 * How much the middleware is willing to believe a resolved identity.
 * - `untrusted`: never actually returned as part of a successful
 *   `CallerIdentity` today (an untrusted resolution is instead a
 *   `ResolvedCallerIdentity` failure) but kept in the union because it is
 *   the semantic floor every other level is measured against.
 * - `asserted`: the provider claims this is the caller, but the middleware
 *   cannot independently confirm it. Sufficient for nothing that matters.
 * - `verified`: the middleware has a basis, established by its own
 *   configuration, to believe this identity. Required for lookup; required
 *   together with `source ∈ {signed_envelope, synthetic_test}` for
 *   cancellation (§4.1.1) — see `CancellationGrade` below.
 */
export type CallerTrustLevel = "untrusted" | "asserted" | "verified";

/**
 * A caller identity resolved by the middleware for the lifetime of one call.
 * Exactly the shape in design §3 — do not add fields here without updating
 * §7 (what is allowed to reach Symfony) and §10 (what is allowed to reach a
 * log line).
 */
export interface CallerIdentity {
  /** Opaque, per-call session identifier. Never forwarded upstream (§7). */
  callSessionId: string;
  /** E.164-normalized phone. Never raw caller/model input. */
  phoneE164: string;
  verification: {
    source: CallerVerificationSource;
    /** Provider's own descriptor, bounded length and character set. */
    method: string;
    establishedAtEpochMs: number;
    expiresAtEpochMs: number;
  };
  /** DERIVED by the resolver. Never parsed from input. See module docblock. */
  trustLevel: CallerTrustLevel;
}

/**
 * Every way a caller identity can fail to resolve. Kept as a closed string
 * union (not an Error subtype) so callers can `switch` over it exhaustively,
 * matching the house style of the upstream `code` switches this design
 * requires elsewhere (§5.1).
 */
export type CallerIdentityFailure =
  | "trust_mode_none"
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "future_dated"
  | "session_mismatch"
  | "session_pinned_conflict"
  | "invalid_phone"
  | "invalid_field";

/**
 * The resolver's result. A discriminated union rather than `CallerIdentity |
 * null` so a caller cannot accidentally treat "resolution failed" as "no
 * identity, proceed anyway" without an explicit `ok` check, and so the
 * failure reason is always available for logging/outcome-mapping without a
 * second lookup.
 */
export type ResolvedCallerIdentity =
  | { ok: true; identity: CallerIdentity }
  | { ok: false; reason: CallerIdentityFailure };

/**
 * Clock-skew tolerance for `establishedAtEpochMs` being in the future
 * (design §4.2: "clock skew tolerance ≤ 60 s"). A concrete constant, not an
 * unquantified ceiling, so tests can pin it exactly.
 */
export const CALLER_ID_MAX_SKEW_MS = 60_000;

/**
 * Maximum allowed identity lifetime (design §4.2: "maximum identity lifetime
 * ≤ 15 min"). Applies both to `provider_header` (where the resolver assigns
 * the expiry itself) and to `signed_envelope`/`synthetic_test` (where the
 * envelope's own `expiresAtEpochMs - establishedAtEpochMs` is capped by this
 * constant; exceeding it is treated as expired, never silently clamped).
 */
export const CALLER_ID_MAX_LIFETIME_MS = 15 * 60_000;

/**
 * A `CallerIdentity` that is additionally permitted to authorize a
 * cancellation (a write). Design §4.1.1: a single binary `verified` would
 * let an attested-but-unproven `provider_header` header destroy a
 * stranger's appointment, so cancellation consumes a distinct, narrower
 * grade that `provider_header` cannot produce — enforced in the type
 * system, not merely by a runtime `if`, so the distinction survives the
 * day-one flip of `AI_CALLER_ID_PROVIDER_ATTESTED=true`.
 *
 * The brand field is never assigned directly; it only exists so the two
 * types are not structurally interchangeable. The ONLY way to obtain a
 * `CancellationGrade` is `asCancellationGrade()` below.
 */
export type CancellationGrade = CallerIdentity & {
  readonly __cancellationGrade: unique symbol;
};

/**
 * Narrows a `CallerIdentity` to a `CancellationGrade`, or returns `null` if
 * the identity is not sufficient to authorize a write. Per §4.1.1, that
 * requires BOTH `trustLevel === "verified"` AND
 * `source ∈ {signed_envelope, synthetic_test}` — an attested
 * `provider_header` identity is `verified` but must still be rejected here.
 */
export function asCancellationGrade(
  id: CallerIdentity,
): CancellationGrade | null {
  if (id.trustLevel !== "verified") return null;
  const { source } = id.verification;
  if (source !== "signed_envelope" && source !== "synthetic_test") {
    return null;
  }
  return id as CancellationGrade;
}
