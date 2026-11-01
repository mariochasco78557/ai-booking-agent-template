/**
 * *** V5 IS ACTIVATED PER REQUEST, BY THE AGENT THAT SENDS IT (ADR-025). ***
 *
 * The V4 agent (in production) and the V5 agent (multi-booking, extended
 * look-ahead) call the SAME two endpoints on the SAME server. What tells them
 * apart is one body field, `agent_profile`, that the V5 ElevenLabs branch
 * sends as a CONSTANT configured in its tool definition — the LLM never fills
 * it. So:
 *
 * - a request without the field is a V4 request, and is served exactly as it
 *   was before V5 existed (one booking per call, seven-day look-ahead, no new
 *   response field);
 * - a request with `agent_profile: "v5"` gets the V5 capabilities;
 * - any other value is a misconfiguration and is served as V4, with a warning
 *   — never an error, because an error to the caller is a tool error, and a
 *   tool error is what makes ElevenLabs retry a write;
 * - `BALANCED_V5_ENABLED=false` is the server's emergency brake: every V5
 *   request is served as V4 (said once in the log).
 *
 * Rollback is therefore a traffic decision (point the Twilio number back at
 * the V4 branch), not a deploy. There is deliberately no global flag that turns
 * V5 behaviour on for everyone: that is the one switch that could change what
 * the V4 agent's callers hear.
 *
 * *** WHY THE FIELD IS READ FROM THE RAW BODY, NOT FROM THE ZOD SCHEMAS. ***
 *
 * `balancedAvailabilitySchema` and `voiceBookSchema` are the canonical V4 (and
 * V1) tool contracts: `tests/balancedV2Contract.test.ts` and
 * `tests/voiceContract.test.ts` assert their keys equal the published tool
 * documents, which must not change for V5. Both schemas strip unknown keys
 * (no `.strict()`), so the field never reaches the services through them and a
 * V4 request is parsed exactly as before. The profile is read here, beside the
 * parse, and handed to the services as an explicit per-request option.
 */

/** The body field the V5 tools send. */
export const AGENT_PROFILE_FIELD = "agent_profile";

/** The only non-empty value that means anything. */
export const AGENT_PROFILE_V5 = "v5";

/** The hard ceiling on confirmed appointments per call, whatever is configured. */
export const MAX_BOOKINGS_PER_CALL_LIMIT = 3;

export type AgentProfile = "v4" | "v5";

/** What one request is allowed to do, decided once, before any service runs. */
export interface AgentCapabilities {
  readonly profile: AgentProfile;
  /** Confirmed appointments this CREATE request's conversation may hold. */
  readonly maxBookingsPerCall: number;
  /** ADR-024: an empty look-ahead / multi-day scan keeps reading up to 14 days. */
  readonly extendedLookAhead: boolean;
  /**
   * ADR-026: when the requested band (or the requested professional) has
   * nothing that day, the page also carries the nearest day that DOES have it.
   */
  readonly nearestAlternatives: boolean;
}

/** The V4 behaviour — the answer for every request that is not a valid, enabled V5 one. */
export const V4_CAPABILITIES: AgentCapabilities = Object.freeze({
  profile: "v4",
  maxBookingsPerCall: 1,
  extendedLookAhead: false,
  nearestAlternatives: false,
});

/** Throws unless `value` is an integer in 1..{@link MAX_BOOKINGS_PER_CALL_LIMIT}. */
export function assertBookingsPerCall(value: number, source: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BOOKINGS_PER_CALL_LIMIT) {
    throw new Error(
      `${source}: maxBookingsPerCall must be an integer between 1 and ` +
        `${MAX_BOOKINGS_PER_CALL_LIMIT} (got ${value})`,
    );
  }
}

export interface AgentProfileResolverOptions {
  /** `BALANCED_V5_ENABLED`. False = every V5 request is served as V4. */
  v5Enabled: boolean;
  /** `BALANCED_V5_MAX_BOOKINGS_PER_CALL`, 1..3. */
  v5MaxBookingsPerCall: number;
  logger?: {
    warn: (detail: Record<string, unknown>, message: string) => void;
  };
}

/** Longest slice of an unrecognised value that may enter a log line. */
const LOGGED_VALUE_MAX = 16;

export class AgentProfileResolver {
  private readonly v5: AgentCapabilities;
  private readonly v5Enabled: boolean;
  private readonly logger?: AgentProfileResolverOptions["logger"];
  private killSwitchLogged = false;

  constructor(options: AgentProfileResolverOptions) {
    assertBookingsPerCall(options.v5MaxBookingsPerCall, "AgentProfileResolver");
    this.v5Enabled = options.v5Enabled;
    this.logger = options.logger;
    this.v5 = Object.freeze({
      profile: "v5",
      maxBookingsPerCall: options.v5MaxBookingsPerCall,
      extendedLookAhead: true,
      nearestAlternatives: true,
    });
  }

  /**
   * The capabilities of one request, from its RAW body. Never throws.
   *
   * Absent, `null` and `""` are "no profile" and are silent: that is every V4
   * request. Anything else that is not exactly `"v5"` is warned about and
   * served as V4.
   */
  resolve(body: unknown, route: string): AgentCapabilities {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return V4_CAPABILITIES;
    }
    const value = (body as Record<string, unknown>)[AGENT_PROFILE_FIELD];
    if (value === undefined || value === null || value === "") return V4_CAPABILITIES;

    if (value !== AGENT_PROFILE_V5) {
      this.logger?.warn(
        {
          route,
          agent_profile_type: typeof value,
          ...(typeof value === "string"
            ? { agent_profile: value.slice(0, LOGGED_VALUE_MAX).replace(/[^\w.-]/g, "?") }
            : {}),
        },
        `balanced v2: unknown ${AGENT_PROFILE_FIELD}; request served as V4`,
      );
      return V4_CAPABILITIES;
    }

    if (!this.v5Enabled) {
      if (!this.killSwitchLogged) {
        this.killSwitchLogged = true;
        this.logger?.warn(
          { route },
          `BALANCED_V5_ENABLED=false: requests with ${AGENT_PROFILE_FIELD}="v5" are served as V4 (logged once)`,
        );
      }
      return V4_CAPABILITIES;
    }
    return this.v5;
  }
}
