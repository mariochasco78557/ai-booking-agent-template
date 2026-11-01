import type { ReasonCode } from "./precedence.js";

/**
 * THE INTERNAL (NON-FROZEN) OUTCOME DIMENSION.
 *
 * `ReasonCode` (precedence.ts) is the FROZEN v1 vocabulary: exactly ten
 * codes, mirrored byte-for-byte in docs/call_interruption_mvp/
 * pilot-event.schema.json and in events/schema.ts's `PILOT_REASON_CODES`.
 * That set is the external contract step 12 froze; widening it is a
 * business amendment for the contract's custodian (and ultimately for
 * Bruno), not an implementation detail — see docs/call_engine_demo/
 * (internal doc, not included in the template).
 *
 * This module adds a SEPARATE, INTERNAL, deliberately-versionable dimension
 * ON TOP of that frozen set. It never replaces `ReasonCode`, never widens
 * it, and never travels on the pilot event stream. It exists because one
 * real outcome — "we understood the caller perfectly, but they never gave
 * the final booking confirmation" — has no honest home among the ten, and
 * folding it into `INTENT_NOT_UNDERSTOOD` (which is what the frozen stream
 * still does, and must keep doing) contaminates the one metric that reason
 * code was created to feed.
 *
 * Every consumer that computes metrics from this engine should read
 * `InternalReasonCode` (and the table below), NOT the frozen `reasonCode`.
 * The frozen `reasonCode` remains authoritative for anything that must
 * speak v1 to an external consumer.
 */

/**
 * The ten frozen codes plus exactly one internal refinement.
 *
 * Naming: `BOOKING_NOT_CONFIRMED` deliberately follows the reason-code
 * family's own convention — it is the exact sibling of the frozen
 * `SERVICE_NOT_CONFIRMED` (the other confirmation gate) and the negation of
 * the frozen `BOOKING_CONFIRMED`. The pre-existing internal EVENT name
 * `BOOKING_CONFIRMATION_NOT_OBTAINED` (events/schema.ts) is left untouched:
 * it names an *event* ("this happened during the call"), which follows the
 * internal stream's own past-tense convention alongside `SLOT_REJECTED` and
 * `BOOKING_WRITTEN_SYNTHETIC`. The two are the same fact seen from two
 * layers; `OUTCOME_DIMENSIONS` below is the single place that binds them.
 */
export type InternalReasonCode = ReasonCode | "BOOKING_NOT_CONFIRMED";

export const INTERNAL_REASON_CODES = [
  "SECURITY_OR_PRIVACY_BOUNDARY",
  "TECHNICAL_FAILURE",
  "CUSTOMER_REQUESTS_HUMAN",
  "CANCEL_OR_CHANGE_NOT_ENABLED",
  "BUSINESS_DATA_NOT_APPROVED",
  "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
  "SERVICE_NOT_CONFIRMED",
  "INTENT_NOT_UNDERSTOOD",
  "BOOKING_CONFIRMED",
  "AVAILABILITY_PROVIDED",
  "BOOKING_NOT_CONFIRMED",
] as const satisfies readonly InternalReasonCode[];

// Compile-time exhaustiveness, same technique as precedence.ts: adding a
// member to `InternalReasonCode` without listing it here fails `tsc` on this
// line rather than surfacing later as a silently-missing metric bucket.
type _AssertAllInternalCodesListed = InternalReasonCode extends (typeof INTERNAL_REASON_CODES)[number]
  ? true
  : ["missing InternalReasonCode(s) in INTERNAL_REASON_CODES", Exclude<InternalReasonCode, (typeof INTERNAL_REASON_CODES)[number]>];
const _exhaustive: _AssertAllInternalCodesListed = true;
void _exhaustive;

/**
 * The three metric questions PILOT_METRICS.md actually asks, answered once
 * per outcome instead of being re-derived (differently, and wrongly) by each
 * consumer.
 */
export interface OutcomeDimensions {
  /**
   * EXTERNAL v1 COMPATIBILITY MAPPING. What a consumer reading the frozen
   * pilot-event.schema.json stream sees for this outcome. For the ten frozen
   * codes this is the identity; only `BOOKING_NOT_CONFIRMED` maps to a
   * different code. Guarantees the frozen stream stays byte-compatible.
   */
  pilotV1ReasonCode: ReasonCode;
  /**
   * Numerator of PILOT_METRICS.md's "el alcance se entiende" hypothesis
   * (signal `INTENT_NOT_UNDERSTOOD`). TRUE ONLY when the engine genuinely
   * failed to work out what the caller wanted.
   *
   * `TECHNICAL_FAILURE` is deliberately `false` here: a technical collapse
   * says nothing about comprehension, and it already has its own separate
   * formula ("tasa de fallo técnico"). Counting it in both would
   * double-charge the same call and make the comprehension figure look worse
   * than the evidence supports — the mirror image of flattering it, but
   * still a distortion.
   */
  countsAsNotUnderstood: boolean;
  /**
   * Whether a (synthetic) booking was actually created. TRUE ONLY for
   * `BOOKING_CONFIRMED` — the only outcome on which this engine ever writes
   * a reservation and the only one on which it ever announces success.
   */
  countsAsBookingConversion: boolean;
  /**
   * Numerator of PILOT_METRICS.md's "contención elegible" (llamadas
   * `RESUELVE` / llamadas entrantes dentro de alcance).
   *
   * See this module's `BOOKING_NOT_CONFIRMED` entry for the one case where
   * this decision is genuinely arguable, and the reasoning for the answer
   * given.
   */
  countsAsContained: boolean;
}

/**
 * The closed table. Exhaustive over `InternalReasonCode` by construction —
 * `Record<InternalReasonCode, ...>` makes `tsc` reject any new code that
 * does not declare all four answers, so a future outcome cannot silently
 * default into (or out of) any metric.
 */
export const OUTCOME_DIMENSIONS: Readonly<Record<InternalReasonCode, OutcomeDimensions>> = {
  SECURITY_OR_PRIVACY_BOUNDARY: {
    pilotV1ReasonCode: "SECURITY_OR_PRIVACY_BOUNDARY",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
  TECHNICAL_FAILURE: {
    pilotV1ReasonCode: "TECHNICAL_FAILURE",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
  CUSTOMER_REQUESTS_HUMAN: {
    pilotV1ReasonCode: "CUSTOMER_REQUESTS_HUMAN",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
  CANCEL_OR_CHANGE_NOT_ENABLED: {
    pilotV1ReasonCode: "CANCEL_OR_CHANGE_NOT_ENABLED",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
  BUSINESS_DATA_NOT_APPROVED: {
    pilotV1ReasonCode: "BUSINESS_DATA_NOT_APPROVED",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
  SLOT_OUTSIDE_SYNTHETIC_SCHEDULE: {
    pilotV1ReasonCode: "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
  SERVICE_NOT_CONFIRMED: {
    pilotV1ReasonCode: "SERVICE_NOT_CONFIRMED",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
  INTENT_NOT_UNDERSTOOD: {
    pilotV1ReasonCode: "INTENT_NOT_UNDERSTOOD",
    countsAsNotUnderstood: true,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
  BOOKING_CONFIRMED: {
    pilotV1ReasonCode: "BOOKING_CONFIRMED",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: true,
    countsAsContained: true,
  },
  AVAILABILITY_PROVIDED: {
    pilotV1ReasonCode: "AVAILABILITY_PROVIDED",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: true,
  },

  /**
   * THE ONE INTERNAL REFINEMENT. The caller's intent was classified `BOOK`,
   * the service was explicitly confirmed, the exact slot was valid and free
   * — and then the caller never gave the final yes at
   * `ASK_BOOKING_CONFIRMATION` (nor after the single allowed clarification).
   *
   * `pilotV1ReasonCode: "INTENT_NOT_UNDERSTOOD"` — NOT because that is
   * accurate (it is false in the cause; see (internal doc, not included in the template)) but because it
   * is the only one of the ten frozen codes whose `outcome` (`DERIVA`) and
   * whose guarantees (no booking, no mutation, no announced success) are
   * correct here. The alternatives are strictly worse:
   * `AVAILABILITY_PROVIDED` is `RESUELVE` and would inflate the success
   * rate with calls that booked nothing; `SERVICE_NOT_CONFIRMED` describes a
   * gate this call actually passed. Preserving the frozen v1 stream
   * byte-for-byte is the whole point of this table existing.
   *
   * `countsAsNotUnderstood: false` — this is the entire reason this code
   * exists. The engine understood the intent, the service and the slot. Only
   * the final confirmation was missing. Folding it into the comprehension
   * signal mixes two different product facts (the system cannot understand
   * people vs. the conversation loses people at the close) and corrupts any
   * decision taken on that rate.
   *
   * `countsAsBookingConversion: false` — nothing was booked. Obvious, and
   * asserted by test.
   *
   * `countsAsContained: false` — THE ARGUABLE ONE, decided deliberately
   * against the flattering reading:
   *
   *   The tempting argument for `true` is that the call ended without a
   *   booking AND without interrupting a human, so the automation "held"
   *   the call. That argument is wrong, for three reasons.
   *
   *   1. Containment is meant to measure work the automation ABSORBED. Here
   *      nothing was absorbed: the caller's actual need — an appointment —
   *      is still unmet. If they still want it they will call back, and
   *      that callback will consume a human or another automated call. The
   *      work was DEFERRED, not resolved. Latent demand is not containment.
   *   2. Counting it as contained creates a perverse incentive that this
   *      engine exists to refuse: an agent that never closes a single
   *      booking but always hangs up politely would score 100% containment.
   *      That is the same family of false success as announcing a booking
   *      that was never written, which PILOT_METRICS.md's "falsa
   *      confirmación" formula already forbids outright.
   *   3. The engine itself resolves this case to `DERIVA` — it has declared
   *      the call needs a person. Calling `DERIVA` "contained" contradicts
   *      the engine's own decision, and PILOT_METRICS.md's existing formula
   *      ("contención elegible = llamadas RESUELVE / ...") already excludes
   *      it. This table does not quietly widen that definition.
   *
   *   What IS genuinely true — that this call interrupted no staff — is
   *   already captured, truthfully and separately, by PILOT_METRICS.md's
   *   "interrupciones por llamada" (this call emits no
   *   `STAFF_INTERRUPTION_RECORDED`). Credit is given where it is due
   *   without inventing a "soft containment" bucket that would inflate the
   *   headline number.
   */
  BOOKING_NOT_CONFIRMED: {
    pilotV1ReasonCode: "INTENT_NOT_UNDERSTOOD",
    countsAsNotUnderstood: false,
    countsAsBookingConversion: false,
    countsAsContained: false,
  },
};

/** The frozen-v1 code an external consumer sees for `code`. */
export function toPilotV1ReasonCode(code: InternalReasonCode): ReasonCode {
  return OUTCOME_DIMENSIONS[code].pilotV1ReasonCode;
}
