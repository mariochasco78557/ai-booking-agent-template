import type { CalendarProvider } from "../core/calendar/CalendarProvider.js";
import { UpstreamError } from "../core/calendar/errors.js";
import type { Logger } from "./authTokenService.js";
import type {
  CallerIdentityResolver,
  IncomingHeaders,
} from "../callerIdentity/resolver.js";
import type { SessionPinStore } from "../callerIdentity/sessionPin.js";
import type { CancelInput } from "../schemas/aiSchemas.js";
import { asCancellationGrade } from "../types/callerIdentity.js";
import { CALLER_ID_MAX_LIFETIME_MS } from "../types/callerIdentity.js";
import type { AiCancellationData, AiCancellationProofData, AiEnvelope } from "../clients/aiTypes.js";
import type { HumanAssistanceAction, CancelOutcome } from "../types/voiceOutcomes.js";
import { maskPhoneStrict } from "../utils/mask.js";
import {
  CANCEL_ALREADY_CANCELLED_MESSAGE,
  CANCEL_CONFIRMATION_MISMATCH_MESSAGE,
  CANCEL_CONFIRMED_MESSAGE,
  CANCEL_IDENTITY_MISSING_MESSAGE,
  CANCEL_IDENTITY_UNVERIFIED_MESSAGE,
  CANCEL_INSUFFICIENT_TRUST_MESSAGE,
  CANCEL_NOT_SUPPORTED_MESSAGE,
  CANCEL_PROOF_INVALID_MESSAGE,
  CANCEL_RATE_LIMITED_MESSAGE,
  CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE,
  NEEDS_CONFIRMATION_MESSAGE,
  WRITE_DISABLED_CANCEL_MESSAGE,
} from "../utils/phrasing.js";

/**
 * `POST /ai/cancel` business logic. See
 * (internal doc, not included in the template) §4.1.1, §6,
 * §6.1, §6.2, §6.3, §6.4, §7 and §10.1.
 *
 * step 10C replaces the previous permanent integration-gap stub (the
 * `deleteReservation()`/legacy-id path documented in git history as an
 * unbridgeable gap while `reservationId` was the only addressing scheme):
 * `reservationRef` (this wave's schema, `src/schemas/aiSchemas.ts`) is now
 * the ONLY way to address a reservation for cancellation, and it is only
 * ever obtainable from a `one_match` lookup performed under a verified
 * identity (`src/services/lookupService.ts`). The legacy numeric-id
 * `deleteReservation()` call is DELETED from this service — not merely
 * unused — because a raw integer reservation id must be useless for
 * cancellation (design §6, invariant 12). `LegacyRestClient.deleteReservation`
 * itself was removed on 2026-10-08 (ADR-032 addendum): the service account
 * it would run as now holds ROLE_EMPLOYEE, which can delete ANY reservation.
 */

export interface CancellationConfig {
  writeEnabled: boolean;
  /**
   * Mirrors `src/config/env.ts`'s `BOOKING_UPSTREAM_MODE`. Checked BEFORE
   * any identity resolution or upstream call (design §5.3, applied here
   * identically): in `legacy` mode (the default) `/v1/ai/cancellation*`
   * does not exist upstream at all.
   */
  upstreamMode: "legacy" | "ai";
}

export interface CancelResult {
  outcome: CancelOutcome;
  /** Speakable Spanish. NEVER the proof, a reservationRef, or any candidate detail. */
  message: string;
  /** Present only for outcomes that are genuine dead ends for THIS call — see the per-outcome comments below. */
  action?: HumanAssistanceAction;
}

/**
 * Bound on the repeat-cancellation short-circuit set (design §6.4). Reuses
 * the same bounded, oldest-first-eviction Map shape as
 * `src/callerIdentity/sessionPin.ts`'s session-pin store — duplicated
 * locally (rather than imported) because that module's store answers a
 * different question ("is this (phone,source) pair consistent with what
 * this session first showed?") and stores a different key shape; sharing
 * code here would couple two independently-reasoned-about invariants.
 */
const CANCELLED_REF_MAX_ENTRIES = 1000;
/**
 * TTL for a "cancelled in this session" entry. Reuses
 * `CALLER_ID_MAX_LIFETIME_MS` for the same reason
 * `src/services/container.ts` reuses it for the session-pin TTL: a single
 * call cannot plausibly outlive its own identity's maximum lifetime, so the
 * same ceiling already bounds both.
 */
const CANCELLED_REF_TTL_MS = CALLER_ID_MAX_LIFETIME_MS;

interface CancelledRefStore {
  wasCancelled(key: string, nowMs: number): boolean;
  markCancelled(key: string, nowMs: number): void;
}

/**
 * Design §6.4: after a successful cancel the row is gone, so a repeat
 * `/ai/cancel` for the SAME `reservationRef` within the SAME call session
 * would otherwise reach upstream and get `CONFIRMATION_MISMATCH` — telling
 * the caller who just cancelled that their own details do not match their
 * own reservation. This store lets `cancel()` answer `already_cancelled`
 * for that repeat WITHOUT going upstream at all. It stores ONLY a boolean
 * "this (session, ref) pair was cancelled" fact — never the proof, never
 * any reservation detail.
 */
function createCancelledRefStore(): CancelledRefStore {
  const entries = new Map<string, number>(); // key -> expiresAtMs

  function evictExpired(nowMs: number): void {
    for (const [key, expiresAtMs] of entries) {
      if (expiresAtMs <= nowMs) entries.delete(key);
    }
  }

  function evictOldestIfFull(): void {
    if (entries.size < CANCELLED_REF_MAX_ENTRIES) return;
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) entries.delete(oldestKey);
  }

  return {
    wasCancelled(key: string, nowMs: number): boolean {
      evictExpired(nowMs);
      const expiresAtMs = entries.get(key);
      return expiresAtMs !== undefined && expiresAtMs > nowMs;
    },
    markCancelled(key: string, nowMs: number): void {
      evictExpired(nowMs);
      if (!entries.has(key)) evictOldestIfFull();
      entries.set(key, nowMs + CANCELLED_REF_TTL_MS);
    },
  };
}

/** Never logged, never returned across a session boundary — see `createCancelledRefStore`'s docblock. */
function cancelledRefKey(callSessionId: string, reservationRef: string): string {
  return `${callSessionId}:${reservationRef}`;
}

export class CancellationService {
  private readonly cancelledRefs: CancelledRefStore = createCancelledRefStore();

  constructor(
    private readonly calendar: CalendarProvider,
    private readonly identityResolver: CallerIdentityResolver,
    private readonly sessionPins: SessionPinStore,
    private readonly config: CancellationConfig,
    private readonly logger: Logger,
  ) {}

  async cancel(
    input: CancelInput,
    headers: IncomingHeaders,
    nowMs: number,
  ): Promise<CancelResult> {
    // -----------------------------------------------------------------
    // MANDATORY ORDER, fail closed, cheapest first (design §6). Every
    // link below is a hard gate: none may be skipped, reordered, or made
    // conditional on anything other than what its own comment says.
    // -----------------------------------------------------------------

    // (a) Legacy mode is not an upstream (design §5.3, applied to
    // cancellation identically to lookup). Checked FIRST, before resolving
    // any identity or touching the network.
    if (this.config.upstreamMode !== "ai") {
      return {
        outcome: "unsupported",
        message: CANCEL_NOT_SUPPORTED_MESSAGE,
        action: "human_assistance_required",
      };
    }

    // (b) No caller identity resolved at all.
    const resolved = this.identityResolver.resolve(headers, nowMs);
    if (!resolved.ok) {
      return {
        outcome: "identity_missing",
        message: CANCEL_IDENTITY_MISSING_MESSAGE,
        action: "human_assistance_required",
      };
    }
    const identity = resolved.identity;

    // (c) Resolved, but not even trusted enough for a READ.
    if (identity.trustLevel !== "verified") {
      return {
        outcome: "identity_unverified",
        message: CANCEL_IDENTITY_UNVERIFIED_MESSAGE,
        action: "human_assistance_required",
      };
    }

    // (d) First-touch session pinning (design §4.2/§4.1.1: "for lookup and
    // cancel alike"). `src/services/container.ts` wires the SAME
    // `SessionPinStore` instance into both `LookupService` and this
    // service, so a conflict observed by one is visible to the other
    // within the same call session.
    const pin = this.sessionPins.check(
      identity.callSessionId,
      identity.phoneE164,
      identity.verification.source,
      nowMs,
    );
    if (pin === "conflict") {
      this.logger.error(
        {
          callSessionId: identity.callSessionId.slice(0, 12),
          phone: maskPhoneStrict(identity.phoneE164),
          source: identity.verification.source,
        },
        "cancel blocked: caller identity session-pin conflict (design §4.2) — same call session presented a different phone/source",
      );
      return {
        outcome: "identity_unverified",
        message: CANCEL_IDENTITY_UNVERIFIED_MESSAGE,
        action: "human_assistance_required",
      };
    }

    // -----------------------------------------------------------------
    // (e) *** THE B6 GATE — THE SINGLE MOST IMPORTANT CHECK IN THIS FILE ***
    //
    // `identity.trustLevel === "verified"` above is enough to authorize a
    // READ (design §4.1.1's table). It is NOT enough to authorize a WRITE.
    // An ATTESTED `provider_header` identity — the mode this system will
    // plausibly run in day-one, once `AI_CALLER_ID_PROVIDER_ATTESTED=true`
    // is flipped — is `verified`, full stop, by the resolver. Nothing about
    // `trustLevel` alone distinguishes "a human attested this provider's
    // guarantee" from "this envelope survives a hostile party holding the
    // webhook secret". `asCancellationGrade()` (src/types/callerIdentity.ts)
    // is the ONLY narrowing that encodes that distinction, and it is a type
    // narrowing, not merely a runtime `if`: only `signed_envelope` and
    // `synthetic_test` can ever produce a `CancellationGrade`.
    //
    // Get this gate wrong and a spoofed (or merely mis-attested) header
    // does not just leak a date label — it destroys a stranger's
    // appointment, irreversibly. This is exactly senior finding B6.
    // -----------------------------------------------------------------
    const grade = asCancellationGrade(identity);
    if (grade === null) {
      this.logger.warn(
        {
          callSessionId: identity.callSessionId.slice(0, 12),
          phone: maskPhoneStrict(identity.phoneE164),
          source: identity.verification.source,
        },
        "cancel blocked: identity is verified (sufficient to READ) but NOT sufficient to authorize a WRITE (design §4.1.1, senior finding B6) — provider_header alone must never cancel a reservation",
      );
      return {
        outcome: "insufficient_trust_for_write",
        message: CANCEL_INSUFFICIENT_TRUST_MESSAGE,
        action: "human_assistance_required",
      };
    }

    // (f) Hard safety gate — never cancel without explicit confirmation.
    // Not a dead end: the agent can simply ask again and retry this same
    // call, so no `action` is set here.
    if (input.confirmedByCustomer !== true) {
      return { outcome: "not_confirmed", message: NEEDS_CONFIRMATION_MESSAGE };
    }

    // (g) Independent kill-switch. Nothing above or below may enable a
    // write on its own — `ENABLE_WRITE_OPERATIONS` still defaults to false.
    if (!this.config.writeEnabled) {
      this.logger.warn(
        { callSessionId: grade.callSessionId.slice(0, 12) },
        "cancel blocked: ENABLE_WRITE_OPERATIONS=false",
      );
      return {
        outcome: "write_disabled",
        message: WRITE_DISABLED_CANCEL_MESSAGE,
        action: "human_assistance_required",
      };
    }

    // (h) Repeat cancellation (design §6.4) — checked BEFORE any upstream
    // call. Deliberately placed here, after every gate above has already
    // passed, so a repeat of an already-cancelled ref within this session
    // still requires a verified, cancellation-grade identity and an
    // explicit confirmation; it merely skips the (now pointless, and
    // actively misleading) trip to upstream.
    const refKey = cancelledRefKey(grade.callSessionId, input.reservationRef);
    if (this.cancelledRefs.wasCancelled(refKey, nowMs)) {
      return { outcome: "already_cancelled", message: CANCEL_ALREADY_CANCELLED_MESSAGE };
    }

    // (h, continued) Only now, with every gate above satisfied, call
    // upstream. Two calls, `aiCancellationProof` THEN `aiCancellation`, in
    // strict sequence — never a loop, never a retry (design §6.3: upstream's
    // `recordConfirmationAttempt()` is per-`reservationRef`, has NO window
    // and NEVER resets; three mismatches permanently brick cancellation of
    // that reservation for the legitimate owner too). This method calls
    // `aiCancellationProof` EXACTLY ONCE per request; a caller-visible retry
    // can only ever happen as a brand-new `/ai/cancel` HTTP request, never
    // from code in this file.
    try {
      // Session first, before any cancellation call (unchanged call order).
      await this.calendar.ensureSession();

      // `confirm.phone` is PINNED to the verified identity (`grade`) — NEVER
      // taken from `input`, and `input` has no phone field to take it from
      // in the first place (design §6.1). `confirm.name` is
      // `callerStatedName`: caller-stated, LLM-transcribed, and explicitly
      // weaker — never sufficient on its own, which is exactly why gates
      // (b)–(g) above ran first.
      const proofEnvelope = await this.calendar.requestCancellationProof({
        reservationRef: input.reservationRef,
        confirm: { name: input.callerStatedName, phone: grade.phoneE164 },
      });

      // B1/B2-style discipline (design §5.1, mirrored here per §6.2):
      // Symfony's `cancellationProof` action only ever returns `OK` on
      // success; an unrecognised 2xx code is a contract anomaly, not a
      // reason to guess — fail closed rather than trust an unfamiliar
      // shape.
      if (proofEnvelope.code !== "OK") {
        this.logger.error(
          { code: proofEnvelope.code },
          "aiCancellationProof returned an unrecognised 2xx code",
        );
        return { outcome: "upstream_unavailable", message: CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE };
      }

      // ---------------------------------------------------------------
      // THE PROOF IS A TIME-ONLY BEARER CREDENTIAL (design §4.2/§6.3).
      // Held ONLY in this local `const`, for the remainder of THIS
      // function call. Never assigned to a field, never passed to the
      // logger, never included in any returned object, never persisted
      // across requests. It goes out of scope the moment `cancel()`
      // returns.
      // ---------------------------------------------------------------
      const proof: string = proofEnvelope.data.cancellationProof;

      const cancelEnvelope = await this.calendar.cancelBooking({
        reservationRef: input.reservationRef,
        cancellationProof: proof,
      });

      return this.mapCancelSuccessEnvelope(cancelEnvelope, refKey, nowMs);
    } catch (err) {
      if (err instanceof UpstreamError) {
        return this.mapFailureCode(err.code);
      }
      this.logger.error({}, "cancellation upstream call failed with a non-UpstreamError (unexpected)");
      return { outcome: "upstream_unavailable", message: CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE };
    }
  }

  /** 2xx path for `POST /v1/ai/cancellation` (the SECOND call), as a RETURNED envelope. */
  private mapCancelSuccessEnvelope(
    envelope: AiEnvelope<AiCancellationData>,
    refKey: string,
    nowMs: number,
  ): CancelResult {
    switch (envelope.code) {
      case "OK": {
        if (envelope.data.cancelled === true && envelope.data.alreadyCancelled === false) {
          this.cancelledRefs.markCancelled(refKey, nowMs);
          return { outcome: "cancelled", message: CANCEL_CONFIRMED_MESSAGE };
        }
        if (envelope.data.cancelled === true && envelope.data.alreadyCancelled === true) {
          // Upstream's OWN idempotency branch (design §7.4's table) — a
          // proof reused after the row was already gone through some other
          // path. Also mark the session-local store, so a THIRD identical
          // request in this session short-circuits without a third upstream
          // round trip.
          this.cancelledRefs.markCancelled(refKey, nowMs);
          return { outcome: "already_cancelled", message: CANCEL_ALREADY_CANCELLED_MESSAGE };
        }
        this.logger.error(
          { code: envelope.code },
          "aiCancellation returned OK with an unrecognised {cancelled,alreadyCancelled} shape — contract anomaly, failing closed rather than guessing",
        );
        return { outcome: "upstream_unavailable", message: CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE };
      }
      default:
        this.logger.error(
          { code: envelope.code },
          "aiCancellation returned an unrecognised 2xx code",
        );
        return { outcome: "upstream_unavailable", message: CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE };
    }
  }

  /**
   * Non-2xx path — a thrown `UpstreamError`'s `.code` — shared by BOTH
   * `aiCancellationProof` and `aiCancellation`, because the outcome mapping
   * is identical regardless of which of the two calls produced the code
   * (design §6.2). Exhaustive by construction: every `case` maps to a
   * distinct caller-facing outcome, and the `default:` fails closed to
   * `upstream_unavailable` for anything this middleware does not
   * recognise, matching the B2 discipline `src/services/lookupService.ts`
   * established for lookup.
   */
  private mapFailureCode(code: string | undefined): CancelResult {
    switch (code) {
      case "PROOF_INVALID":
      case "PROOF_EXPIRED":
      case "PROOF_ALREADY_USED":
      case "PROOF_SCOPE_MISMATCH":
        // Deliberately collapsed (design §6.2): distinguishing these makes
        // this middleware a proof oracle, and no caller-facing action
        // differs between them. Treated as a dead end for THIS call — never
        // retried automatically (design §6.3), and a caller-initiated retry
        // (a brand-new `/ai/cancel` request) would mint a fresh proof
        // anyway, so there is nothing this call itself can usefully do.
        return {
          outcome: "proof_invalid",
          message: CANCEL_PROOF_INVALID_MESSAGE,
          action: "human_assistance_required",
        };
      case "CONFIRMATION_MISMATCH":
        // NOT collapsed into proof_invalid (design §6.2): not a proof
        // error, and under a verified identity the ref was obtained with
        // the caller's OWN phone, so this discloses nothing about a
        // stranger. No `action` — genuinely worth inviting the agent to ask
        // the caller to repeat their name and retry.
        return { outcome: "confirmation_mismatch", message: CANCEL_CONFIRMATION_MISMATCH_MESSAGE };
      case "TOO_MANY_ATTEMPTS":
        // NOT collapsed either (design §6.2). Transient by framing — no
        // `action`, matching `rate_limited`'s treatment in
        // `src/services/lookupService.ts`.
        return { outcome: "rate_limited", message: CANCEL_RATE_LIMITED_MESSAGE };
      case "WRITE_OPERATIONS_DISABLED":
        // Independent confirmation of gate (g) above — reachable in
        // principle if the flag flips between this service's own check and
        // the upstream call landing, so it must map identically.
        return {
          outcome: "write_disabled",
          message: WRITE_DISABLED_CANCEL_MESSAGE,
          action: "human_assistance_required",
        };
      case "OWNER_PHONE_UNSUPPORTED":
        // U-1: AI_OWNER_PHONE_SUPPORTED is false upstream even though
        // BOOKING_UPSTREAM_MODE === "ai" here — a second, independent
        // fail-closed layer (design §7), matching lookup's own
        // LOOKUP_BY_PHONE_UNSUPPORTED handling.
        return {
          outcome: "unsupported",
          message: CANCEL_NOT_SUPPORTED_MESSAGE,
          action: "human_assistance_required",
        };
      case "MISSING_CALLER_ID":
      case "CALLER_ID_MISMATCH":
        // Design §5.2's rule, applied here identically: this ALWAYS means
        // the middleware itself sent a caller id upstream refused, despite
        // this service having already required a CancellationGrade above.
        // Logged loudly; never spoken as a specific caller-facing state —
        // collapsed into the same transient-sounding `upstream_unavailable`
        // rather than a security-flavoured one, so as not to teach a caller
        // anything about WHY the middleware failed.
        this.logger.error(
          { code },
          "upstream rejected the caller id THIS MIDDLEWARE sent — this means the middleware has a bug, not that the caller did anything wrong",
        );
        return { outcome: "upstream_unavailable", message: CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE };
      default:
        // B2's other half: transport failure, 5xx, a non-envelope response,
        // or any code this middleware does not recognise — all fail closed
        // to the same non-speaking-as-a-result outcome.
        return { outcome: "upstream_unavailable", message: CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE };
    }
  }
}
