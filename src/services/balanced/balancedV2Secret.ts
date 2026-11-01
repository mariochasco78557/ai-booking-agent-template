import { createHmac } from "node:crypto";

/**
 * *** DOMAIN SEPARATION FOR THE BALANCED V2 SLOT TOKEN. ***
 *
 * The V2 write path has one non-negotiable property: a token minted by the
 * stable `/ai/voice/availability` must NOT be spendable on `/ai/voice/v2/book`,
 * and a token minted by a V2 `lock` must NOT be spendable on `/ai/voice/book`.
 *
 * Both directions matter, and the second is the one that is easy to miss. If
 * the two flows shared a key, an agent holding a V2 token could simply call the
 * stable booking route — where `ENABLE_BALANCED_V2_CREATE` does not apply — and
 * the V2 write flag would be a suggestion rather than a control. Separating the
 * keys makes the flag structural: the token is the only way in, and each token
 * only opens one door.
 *
 * ── WHY A DERIVED KEY AND NOT A SECOND CONFIGURED ONE ────────────────────
 *
 * A second `VOICE_SLOT_TOKEN_SECRET_V2` variable would work, and it would also
 * be a second thing to generate, store, rotate, and forget — and forgetting it
 * fails in the most confusing possible way: V2 availability answers normally and
 * every V2 booking is refused, which reads as "V2 is broken" rather than as "a
 * variable is missing". Deriving means the operator manages ONE secret and the
 * two domains cannot come apart.
 *
 * HMAC-SHA256 with a fixed, versioned label is the standard construction for
 * this, and it is the same reasoning `SlotAuthorizationService` already applies
 * internally when it HKDFs one configured secret into a sealing key and a
 * conversation-tag key. The output is 64 hex characters, comfortably past that
 * class's own 32-character minimum, so a valid V1 secret always derives a valid
 * V2 one.
 *
 * ── FAIL-CLOSED ──────────────────────────────────────────────────────────
 *
 * No configured secret derives to `undefined`, not to some constant fallback.
 * `SlotAuthorizationService` then builds DISABLED: V2 discovery and locking keep
 * reading the agenda (a read must not go dark for a missing secret), `lock`
 * answers `authorization_unavailable` because it can mint nothing, and
 * `/ai/voice/v2/book` refuses everything. That is the same posture the stable
 * path already takes, and `src/config/env.ts` is what refuses to boot a
 * production process with creation armed and no secret at all.
 */

/** Versioned so a future V3 domain cannot collide with this one. */
const BALANCED_V2_LABEL = "demo-salon/balanced-v2/slot-token/v1";

/**
 * The V2 sealing secret, or `undefined` when there is no V1 secret to derive
 * from.
 *
 * An empty or whitespace-only string means "not configured", exactly as
 * `blankAsUnset` in `src/config/env.ts` and the `secret === ""` branch of
 * `SlotAuthorizationService` already treat it. Returning a derived key for `""`
 * would silently arm V2 on a deployment that deliberately disarmed V1.
 */
export function deriveBalancedV2SlotSecret(
  v1Secret: string | undefined,
): string | undefined {
  if (v1Secret === undefined || v1Secret.trim() === "") return undefined;
  return createHmac("sha256", v1Secret).update(BALANCED_V2_LABEL, "utf8").digest("hex");
}
