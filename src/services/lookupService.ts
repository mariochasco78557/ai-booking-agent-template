import type { CalendarProvider } from "../core/calendar/CalendarProvider.js";
import { UpstreamError } from "../core/calendar/errors.js";
import type { Logger } from "./authTokenService.js";
import type {
  CallerIdentityResolver,
  IncomingHeaders,
} from "../callerIdentity/resolver.js";
import type { SessionPinStore } from "../callerIdentity/sessionPin.js";
import type { MyReservationsInput } from "../schemas/aiSchemas.js";
import type { AiEnvelope, AiLookupData, AiLookupMatch } from "../clients/aiTypes.js";
import type { HumanAssistanceAction, LookupOutcome } from "../types/voiceOutcomes.js";
import { maskPhoneStrict } from "../utils/mask.js";
import {
  LOOKUP_AMBIGUOUS_MESSAGE,
  LOOKUP_CALLER_ID_REJECTED_MESSAGE,
  LOOKUP_IDENTITY_MISSING_MESSAGE,
  LOOKUP_IDENTITY_UNVERIFIED_MESSAGE,
  LOOKUP_NOT_SUPPORTED_MESSAGE,
  LOOKUP_NO_MATCH_MESSAGE,
  LOOKUP_RATE_LIMITED_MESSAGE,
  LOOKUP_UPSTREAM_UNAVAILABLE_MESSAGE,
  lookupOneMatchMessage,
} from "../utils/phrasing.js";

/**
 * `POST /ai/my-reservations` business logic. See
 * (internal doc, not included in the template) §5, §5.1, §5.2,
 * §5.3, §7 and §10.1.
 *
 * step 10C replaces the previous permanently-"unsupported" stub (git
 * history 65320f5 / step 10 Phase 9): the missing piece back then was that
 * `/ai/my-reservations` had no field carrying a genuinely telephony-verified
 * caller id, only LLM-extracted `customerPhone`/`customerName`. That gap is
 * closed by `src/callerIdentity/resolver.ts` (wave 1) and
 * `src/schemas/aiSchemas.ts`'s new `myReservationsSchema` (this wave), which
 * removed both fields. `phone` sent upstream — and the
 * `X-Ai-Verified-Caller-Id` header — are now ALWAYS `identity.phoneE164`,
 * never a spoken value.
 */

/** A single bounded lookup candidate. Only these three fields — never a phone, name, email or numeric id (design §5.3). */
export interface LookupCandidate {
  reservationRef: string;
  dateLabel: string;
  employeeName: string;
}

export interface MyReservationsResult {
  outcome: LookupOutcome;
  /** Speakable Spanish. Never a technical code or upstream message verbatim. */
  message: string;
  /**
   * ONLY ever `"human_assistance_required"` — enforced by the field's own
   * type (design §9, `src/types/voiceOutcomes.ts`). Present only for
   * outcomes that are genuine dead ends for this call (see the per-outcome
   * comments in `myReservations` below for which ones and why); absent
   * otherwise, exactly like `reservations`.
   */
  action?: HumanAssistanceAction;
  /** Present ONLY when `outcome === "one_match"`. Absent — never an empty array — in every other outcome (design §5.2). */
  reservations?: LookupCandidate[];
}

export interface LookupServiceConfig {
  /**
   * Mirrors `src/config/env.ts`'s `BOOKING_UPSTREAM_MODE`. Checked BEFORE any
   * identity resolution or upstream call: in `legacy` mode (the default)
   * `/v1/ai/lookup` does not exist upstream at all — a call would get a 404,
   * an HTML page, or an unrelated 200, never an envelope with a `code`
   * (design §5.3).
   */
  upstreamMode: "legacy" | "ai";
}

/** Maps an upstream candidate row to exactly the three permitted fields — never a spread, so an upstream field this middleware does not expect can never leak through. */
function toLookupCandidate(match: AiLookupMatch): LookupCandidate {
  return {
    reservationRef: match.reservationRef,
    dateLabel: match.dateLabel,
    employeeName: match.employeeName,
  };
}

export class LookupService {
  constructor(
    private readonly calendar: CalendarProvider,
    private readonly identityResolver: CallerIdentityResolver,
    private readonly sessionPins: SessionPinStore,
    private readonly config: LookupServiceConfig,
    private readonly logger: Logger,
  ) {}

  async myReservations(
    input: MyReservationsInput,
    headers: IncomingHeaders,
    nowMs: number,
  ): Promise<MyReservationsResult> {
    // (a) Legacy mode is not an upstream (design §5.3). Checked FIRST,
    // before resolving any identity or touching the network — a legacy
    // deployment must behave identically whether or not caller-identity
    // trust is configured.
    if (this.config.upstreamMode !== "ai") {
      return {
        outcome: "unsupported",
        message: LOOKUP_NOT_SUPPORTED_MESSAGE,
        action: "human_assistance_required",
      };
    }

    // (b) No caller identity resolved at all (design §4 table: e.g.
    // AI_CALLER_ID_TRUST_MODE=none, the default, or headers absent/invalid).
    const resolved = this.identityResolver.resolve(headers, nowMs);
    if (!resolved.ok) {
      return {
        outcome: "identity_missing",
        message: LOOKUP_IDENTITY_MISSING_MESSAGE,
        action: "human_assistance_required",
      };
    }
    const identity = resolved.identity;

    // (c) Resolved, but not trusted enough for a READ (design §4.1.1: lookup
    // requires trustLevel === "verified"; an unattested provider_header
    // identity is "asserted" and stops here).
    if (identity.trustLevel !== "verified") {
      return {
        outcome: "identity_unverified",
        message: LOOKUP_IDENTITY_UNVERIFIED_MESSAGE,
        action: "human_assistance_required",
      };
    }

    // (d) First-touch session pinning (design §4.2, finding B5): the same
    // call session presenting a different phone/source than it first did is
    // the realistic failure this whole design is built around (a header
    // templated from a conversation variable) — fail closed and log loudly,
    // never silently fall back to "identity_missing" (that would hide a live
    // spoofing attempt behind a boring, expected-looking outcome).
    const pin = this.sessionPins.check(
      identity.callSessionId,
      identity.phoneE164,
      identity.verification.source,
      nowMs,
    );
    if (pin === "conflict") {
      this.logger.error(
        {
          // Truncated call-session id + last-two-digits phone only — design
          // §10: no headers object ever reaches a logger, and a phone used
          // as a credential is masked with maskPhoneStrict(), never
          // maskPhone().
          callSessionId: identity.callSessionId.slice(0, 12),
          phone: maskPhoneStrict(identity.phoneE164),
          source: identity.verification.source,
        },
        "lookup blocked: caller identity session-pin conflict (design §4.2) — same call session presented a different phone/source",
      );
      return {
        outcome: "identity_unverified",
        message: LOOKUP_IDENTITY_UNVERIFIED_MESSAGE,
        action: "human_assistance_required",
      };
    }

    // (e) Only now, with a verified, session-consistent identity, call
    // upstream. `phone` in the body and the `X-Ai-Verified-Caller-Id` header
    // sent by `client.aiLookup()` are BOTH `identity.phoneE164` — the SAME
    // variable, read once here, never reassembled — matching upstream's own
    // `CALLER_ID_MISMATCH` guard (design §6.1's rule, which applies here
    // identically).
    try {
      const envelope = await this.calendar.findBookingsByPhone(
        {
          phone: identity.phoneE164,
          ...(input.fromDate !== undefined ? { fromDate: input.fromDate } : {}),
        },
        identity.phoneE164,
      );
      return this.mapSuccessEnvelope(envelope);
    } catch (err) {
      if (err instanceof UpstreamError) {
        return this.mapFailureCode(err.code);
      }
      this.logger.error({}, "aiLookup failed with a non-UpstreamError (unexpected)");
      return { outcome: "upstream_unavailable", message: LOOKUP_UPSTREAM_UNAVAILABLE_MESSAGE };
    }
  }

  // -------------------------------------------------------------------
  // ***  THE MOST IMPORTANT RULE IN THIS FILE — design §5.1, senior   ***
  // ***  findings B1 and B2. Read this before touching either switch  ***
  // ***  below.                                                       ***
  // -------------------------------------------------------------------
  //
  // The outcome is decided by `code` ALONE — NEVER by whether `data` (or
  // `data.matches`) is present, empty, or shaped a particular way. Symfony
  // returns TWO different envelopes that both "look empty" to code that
  // isn't careful:
  //
  //   ApiResponse::error('AMBIGUOUS', ..., 200, [])          // data is []
  //   ApiResponse::ok('NO_MATCH', ..., ['matches' => []])    // data.matches is []
  //
  // `data.matches ?? []` is `[]` for BOTH. Writing
  // `if (code === "NO_MATCH" || matches.length === 0)` — the single most
  // natural-looking implementation of this mapping — would tell a caller
  // with four upcoming bookings that they have none, because the fourth
  // candidate tips AMBIGUOUS and AMBIGUOUS's `data` is empty too. This is
  // exactly the defect senior review caught (finding B1) before a line of
  // this file existed. `data.matches` is read in EXACTLY one place below
  // (inside the `"OK"` case), and only to choose between one_match /
  // ambiguous — never to decide whether anything was found at all.
  //
  // These are TWO switches, not one, purely because of how
  // `LegacyRestClient.aiRequest()` actually behaves (`validateStatus: 2xx`):
  // `OK`/`NO_MATCH`/`AMBIGUOUS` are 2xx and arrive as a RETURNED envelope
  // (`mapSuccessEnvelope`); `MISSING_CALLER_ID`/`CALLER_ID_MISMATCH`/
  // `INVALID_CALLER_ID`/`TOO_MANY_ATTEMPTS`/`LOOKUP_BY_PHONE_UNSUPPORTED`
  // are non-2xx and arrive as a THROWN `UpstreamError`'s `.code` (see the
  // `catch` block above, `mapFailureCode`). Both are EXHAUSTIVE switches
  // with an explicit `default:` mapping to `upstream_unavailable`, so an
  // invented/unmapped code from either path fails closed instead of falling
  // through to a state that speaks.

  /** 2xx path: OK / NO_MATCH / AMBIGUOUS, as a RETURNED envelope. */
  private mapSuccessEnvelope(envelope: AiEnvelope<AiLookupData>): MyReservationsResult {
    switch (envelope.code) {
      case "OK": {
        const matches = envelope.data.matches ?? [];
        if (matches.length === 1) {
          const candidate = toLookupCandidate(matches[0]!);
          return {
            outcome: "one_match",
            message: lookupOneMatchMessage(candidate),
            reservations: [candidate],
          };
        }
        if (matches.length > 1) {
          // Design §5.2's table reserves "one_match" for "OK with EXACTLY
          // one candidate". More than one under `OK` (upstream's own
          // candidate-fetch cap allows up to 3 before its own AMBIGUOUS
          // trips at a 4th) is treated identically to an explicit
          // AMBIGUOUS: no candidate details ever leak for more than one
          // match, regardless of which code carried them.
          return { outcome: "ambiguous", message: LOOKUP_AMBIGUOUS_MESSAGE };
        }
        // Contract anomaly: `OK` with zero matches should never happen
        // (Symfony's own controller returns `NO_MATCH` for that case) — but
        // per the rule above, an empty `data.matches` under a DIFFERENT
        // code must never be read as "no booking". Fail closed and log.
        this.logger.error(
          { code: envelope.code },
          "aiLookup returned OK with zero matches — contract anomaly, treating as upstream_unavailable rather than guessing",
        );
        return { outcome: "upstream_unavailable", message: LOOKUP_UPSTREAM_UNAVAILABLE_MESSAGE };
      }
      case "NO_MATCH":
        // `ok === true && code === "NO_MATCH"` per the captured fixture —
        // the query genuinely ran and genuinely found nothing UPCOMING.
        return { outcome: "no_match", message: LOOKUP_NO_MATCH_MESSAGE };
      case "AMBIGUOUS":
        // `data` is `[]` here (an array, not `{matches:[]}}`) — deliberately
        // never inspected. The `code` alone is authoritative.
        return { outcome: "ambiguous", message: LOOKUP_AMBIGUOUS_MESSAGE };
      default:
        // B2: an invented/unmapped 2xx code fails closed, never falls
        // through to a state that speaks.
        this.logger.error(
          { code: envelope.code },
          "aiLookup returned an unrecognised 2xx code",
        );
        return { outcome: "upstream_unavailable", message: LOOKUP_UPSTREAM_UNAVAILABLE_MESSAGE };
    }
  }

  /** Non-2xx path: a thrown UpstreamError's `.code` (undefined for a transport failure / 5xx / non-envelope body). */
  private mapFailureCode(code: string | undefined): MyReservationsResult {
    switch (code) {
      case "TOO_MANY_ATTEMPTS":
        return { outcome: "rate_limited", message: LOOKUP_RATE_LIMITED_MESSAGE };
      case "LOOKUP_BY_PHONE_UNSUPPORTED":
        // U-1: AI_OWNER_PHONE_SUPPORTED is false upstream even though
        // BOOKING_UPSTREAM_MODE === "ai" here — a second, independent
        // fail-closed layer (design §7), not merely this middleware's own
        // upstreamMode check in (a) above.
        return {
          outcome: "unsupported",
          message: LOOKUP_NOT_SUPPORTED_MESSAGE,
          action: "human_assistance_required",
        };
      case "MISSING_CALLER_ID":
      case "CALLER_ID_MISMATCH":
      case "INVALID_CALLER_ID":
        // Design §5.2: this ALWAYS means the middleware itself has a bug —
        // it just sent a caller id that upstream refused, despite this
        // service having already required trustLevel === "verified" above.
        // Logged loudly; never spoken as "no tienes ninguna reserva".
        this.logger.error(
          { code },
          "upstream rejected the caller id THIS MIDDLEWARE sent — this means the middleware has a bug (design §5.2), not that the caller did anything wrong",
        );
        return {
          outcome: "caller_id_rejected",
          message: LOOKUP_CALLER_ID_REJECTED_MESSAGE,
          action: "human_assistance_required",
        };
      default:
        // B2's other half: transport failure, 5xx, a non-envelope response,
        // or any code this middleware does not recognise — all fail closed
        // to the same non-speaking-as-a-result outcome.
        return { outcome: "upstream_unavailable", message: LOOKUP_UPSTREAM_UNAVAILABLE_MESSAGE };
    }
  }
}
