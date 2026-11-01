/**
 * Total order between `ReasonCode`s — mirrors
 * (internal doc, not included in the template) exactly (10 codes,
 * positions 1..10). See that document for the *why* of each position and
 * the resolved-conflict table; this module only encodes the *what*.
 *
 * `resolveOutcome` never compares rules against each other at runtime: it
 * takes the finding whose `reasonCode` has the smallest index in
 * `PRECEDENCE_ORDER`. Because every `ReasonCode` appears in that array
 * exactly once (enforced by the exhaustiveness check below, and re-asserted
 * at runtime in tests/callEngine/precedence.test.ts), a tie is structurally
 * impossible: it would require one `reasonCode` to occupy two different
 * indices, which the array's type cannot express.
 */

export type Outcome = "RESUELVE" | "DERIVA" | "RECHAZA";

export type ReasonCode =
  | "SECURITY_OR_PRIVACY_BOUNDARY"
  | "TECHNICAL_FAILURE"
  | "CUSTOMER_REQUESTS_HUMAN"
  | "CANCEL_OR_CHANGE_NOT_ENABLED"
  | "BUSINESS_DATA_NOT_APPROVED"
  | "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE"
  | "SERVICE_NOT_CONFIRMED"
  | "INTENT_NOT_UNDERSTOOD"
  | "BOOKING_CONFIRMED"
  | "AVAILABILITY_PROVIDED";

/**
 * The order itself: position 0 (index) is (internal doc, not included in the template)'s #1
 * (highest precedence, wins over everything below it), down to index 9
 * (#10, the weakest resolution).
 */
export const PRECEDENCE_ORDER = [
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
] as const satisfies readonly ReasonCode[];

// Compile-time exhaustiveness: this line only type-checks if every member of
// the `ReasonCode` union appears (at least once) in `PRECEDENCE_ORDER`. If a
// future edit to `ReasonCode` forgets to add its position here, `tsc` fails
// on this line rather than the omission surfacing later as a silent
// fall-through to TECHNICAL_FAILURE.
type _AssertAllReasonCodesPlaced = ReasonCode extends (typeof PRECEDENCE_ORDER)[number]
  ? true
  : ["missing ReasonCode(s) in PRECEDENCE_ORDER", Exclude<ReasonCode, (typeof PRECEDENCE_ORDER)[number]>];
const _exhaustive: _AssertAllReasonCodesPlaced = true;
void _exhaustive;

/** Exhaustive, closed map from `ReasonCode` to its `Outcome` — see (internal doc, not included in the template). */
const REASON_TO_OUTCOME: Readonly<Record<ReasonCode, Outcome>> = {
  SECURITY_OR_PRIVACY_BOUNDARY: "RECHAZA",
  TECHNICAL_FAILURE: "DERIVA",
  CUSTOMER_REQUESTS_HUMAN: "DERIVA",
  CANCEL_OR_CHANGE_NOT_ENABLED: "DERIVA",
  BUSINESS_DATA_NOT_APPROVED: "DERIVA",
  SLOT_OUTSIDE_SYNTHETIC_SCHEDULE: "DERIVA",
  SERVICE_NOT_CONFIRMED: "DERIVA",
  INTENT_NOT_UNDERSTOOD: "DERIVA",
  BOOKING_CONFIRMED: "RESUELVE",
  AVAILABILITY_PROVIDED: "RESUELVE",
};

/** Index of each `ReasonCode` within `PRECEDENCE_ORDER`, for O(1) lookup. */
const PRECEDENCE_INDEX: ReadonlyMap<ReasonCode, number> = new Map(
  PRECEDENCE_ORDER.map((code, index) => [code, index] as const),
);

export interface Finding {
  reasonCode: ReasonCode;
  /** Optional internal diagnostic note — never client-facing, never personal data. */
  detail?: string;
}

/**
 * Resolves the single winning `{ outcome, reasonCode }` from a set of
 * concurrently-true findings, by taking the one with the smallest
 * `PRECEDENCE_ORDER` index (see module docblock).
 *
 * Fails closed: an empty `findings` array — the engine reaching a decision
 * point with no evidence at all, which should never happen but must never
 * silently resolve to a false success either — resolves to
 * `TECHNICAL_FAILURE`/`DERIVA`, exactly like an empty `findings` array
 * caused by a genuine internal error would.
 */
export function resolveOutcome(findings: readonly Finding[]): { outcome: Outcome; reasonCode: ReasonCode } {
  let bestReasonCode: ReasonCode | null = null;
  let bestIndex = Number.POSITIVE_INFINITY;

  for (const finding of findings) {
    const index = PRECEDENCE_INDEX.get(finding.reasonCode);
    if (index === undefined) continue; // unreachable given ReasonCode is a closed union; defensive only.
    if (index < bestIndex) {
      bestIndex = index;
      bestReasonCode = finding.reasonCode;
    }
  }

  if (bestReasonCode === null) {
    return { outcome: REASON_TO_OUTCOME.TECHNICAL_FAILURE, reasonCode: "TECHNICAL_FAILURE" };
  }
  return { outcome: REASON_TO_OUTCOME[bestReasonCode], reasonCode: bestReasonCode };
}
