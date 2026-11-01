/**
 * Voice-facing outcome/action types shared by the middleware's `/ai/*`
 * response contracts. See
 * (internal doc, not included in the template) §5, §5.1, §5.2
 * and §9 (transfer contract, closing defect T-1).
 */

/**
 * Design §9 (closes T-1) / senior finding B10. A SINGLE-MEMBER literal type,
 * deliberately: no transfer tool exists anywhere in this system today, so
 * the middleware must never be able to CLAIM one occurred or is occurring —
 * only that a human is needed.
 *
 * Every middleware response type (this wave: `MyReservationsResult`) uses
 * ONLY this type for its `action` field — never the 3-member
 * `TransferAction` union in `src/types/transferAction.ts`, which nothing in
 * `src/services` or `src/routes` may import. This is layer 1 of the design's
 * 3-layer enforcement: an earlier draft argued "the adapter doesn't exist,
 * so this is enforced by construction" — senior review rejected that
 * ("absence is not a constraint, it is a vacancy": `return { action:
 * "transfer_completed" }` would compile today if this field's type allowed
 * it). Keeping the field's type to this single member turns emitting
 * `transfer_requested`/`transfer_completed` from `src/services`/`src/routes`
 * into a `tsc` error, not a test someone has to remember to keep passing.
 */
export type HumanAssistanceAction = "human_assistance_required";

/**
 * Design §9 layer 2: a runtime assertion, defence in depth against a future
 * `as any` bypassing the compile-time guarantee above. Called at the route
 * layer, right before a lookup response leaves the process. Throws rather
 * than silently coercing — a bypass here is exactly the class of lie this
 * design exists to prevent, so failing loudly (a 500) is strictly safer than
 * failing quietly.
 */
export function assertHumanAssistanceAction(
  action: HumanAssistanceAction | undefined,
): void {
  if (action !== undefined && action !== "human_assistance_required") {
    throw new Error(
      `invalid outgoing action ${JSON.stringify(action)}: only "human_assistance_required" ` +
        "may ever be emitted by this middleware (design §9) — no transfer adapter exists",
    );
  }
}

/**
 * Every way `POST /ai/my-reservations` can resolve (design §5.2's outcome
 * table). A closed string union, not free-form strings, so callers (the
 * route, tests, a future `/ai/cancel` outcome table) can `switch`/narrow
 * exhaustively — matching the house style the upstream `/v1/ai/*` `code`
 * switches already use (design §5.1).
 */
/**
 * Runtime companion to `LookupOutcome`, added in step 10C wave 4 (docs/
 * (internal doc, not included in the template) §5.2, §11
 * "Prompt/schema agreement") SOLELY so `tests/voiceContract.test.ts` can
 * iterate the outcome catalog at runtime and assert every value is
 * enumerated in `docs/elevenlabs/TOOL_SCHEMAS.json`, rather than
 * hand-duplicating the list in the test (which could silently drift from
 * this file). `LookupOutcome` stays derived from this array (`typeof
 * LOOKUP_OUTCOMES[number]`), so the two can never disagree.
 */
export const LOOKUP_OUTCOMES = [
  "unsupported",
  "identity_missing",
  "identity_unverified",
  "caller_id_rejected",
  "no_match",
  "one_match",
  "ambiguous",
  "rate_limited",
  "upstream_unavailable",
] as const;

export type LookupOutcome = (typeof LOOKUP_OUTCOMES)[number];

/**
 * Every way `POST /ai/cancel` can resolve (design §6.2's outcome catalog).
 * `no_candidate` and `ambiguous` are part of that catalog's FULL conceptual
 * chain ("verified identity → lookup returning exactly one candidate →
 * confirmation → proof → cancel") but are not reachable from
 * `src/services/cancellationService.ts` as implemented in this wave: this
 * service is handed an already-resolved `reservationRef` (obtained by the
 * caller from a prior `one_match` lookup) rather than performing its own
 * lookup, so it never has occasion to observe zero or multiple candidates.
 * Kept in the union — rather than narrowed — because design §6.2 defines
 * the catalog at the CONTRACT level, not at this one service's current
 * internal shape, and a future wave that folds lookup-then-cancel into one
 * call must not have to widen this type again.
 */
/**
 * Runtime companion to `CancelOutcome`, added for the same reason and by the
 * same wave as `LOOKUP_OUTCOMES` above — see that constant's docblock.
 */
export const CANCEL_OUTCOMES = [
  "identity_missing",
  "identity_unverified",
  "insufficient_trust_for_write",
  "not_confirmed",
  "no_candidate",
  "ambiguous",
  "unsupported",
  "write_disabled",
  "cancelled",
  "already_cancelled",
  "confirmation_mismatch",
  "rate_limited",
  "proof_invalid",
  "upstream_unavailable",
  "human_assistance_required",
] as const;

export type CancelOutcome = (typeof CANCEL_OUTCOMES)[number];
