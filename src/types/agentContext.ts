/**
 * Design-time contracts only. Not consumed by any live code path in this
 * mission. No routes/writes are enabled by these types.
 *
 * These interfaces sketch the shape of caller-identity context that a future
 * legacy integration (step 5) may need once multi-customer / delegated
 * booking flows are authorized. They intentionally do not wire into any
 * route, service, or handler here.
 *
 * See `src/utils/phone.ts` for the `NormalizedPhone` type used to validate
 * and normalize the phone numbers referenced below.
 */

/**
 * How the voice agent arrived at a caller's identity for a given call.
 * - `recognized_caller_id`: caller ID matched a known customer phone.
 * - `assisted_alternate_phone`: caller identified via a phone number other
 *   than the one they are calling from (assisted by agent/human).
 * - `shared_phone_selection`: the phone maps to multiple customers and one
 *   was selected (e.g. household phone).
 * - `first_time_caller`: no existing customer record matched.
 * - `explicit_other`: any other explicit identification path not covered
 *   above.
 */
export type IdentityMethod =
  | "recognized_caller_id"
  | "assisted_alternate_phone"
  | "shared_phone_selection"
  | "first_time_caller"
  | "explicit_other";

/**
 * Context describing a customer identity that has been delegated to (or
 * derived for) a single voice call session. Design contract only — not
 * wired into any live flow in this mission.
 */
export interface DelegatedCustomerContext {
  /** Opaque identifier for the current call/voice session. */
  callSessionId: string;
  /** Resolved upstream customer id, or null if not yet resolved. */
  delegatedCustomerId: number | null;
  /** E.164-normalized phone associated with this context (see NormalizedPhone). */
  normalizedPhoneE164: string;
  /** How the identity above was established. */
  identityMethod: IdentityMethod;
  /** Confidence level in the identity resolution. */
  identityConfidence: "high" | "medium" | "low";
  /** Epoch ms when this context was issued. */
  issuedAtEpochMs: number;
  /** Epoch ms after which this context must no longer be trusted/used. */
  expiresAtEpochMs: number;
}

/**
 * Audit metadata to attach to actions taken on behalf of a caller through
 * the voice channel. Design contract only — not wired into any live flow
 * in this mission.
 */
export interface ActorChannelAuditMetadata {
  /** Always "voice-agent": actions here originate from the AI voice agent. */
  actor: "voice-agent";
  /** Always "voice": the channel through which the action was requested. */
  channel: "voice";
  /** How the caller's identity was established for this action. */
  identityMethod: IdentityMethod;
  /** Correlation id linking this action to logs/traces for the call. */
  correlationId: string;
  /** Human-readable name of the operation being audited (e.g. "createReservation"). */
  operation: string;
}
