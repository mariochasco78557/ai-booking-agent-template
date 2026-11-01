import type { HumanAssistanceAction } from "../types/voiceOutcomes.js";
import type { PhraseKey } from "./phrasing/keys.js";

/**
 * The human-escalation cascade ((internal doc, not included in the template) /
 * (internal doc, not included in the template)'s `CUSTOMER_REQUESTS_HUMAN` and `TECHNICAL_FAILURE`
 * rows), as a pure decision function:
 *
 *   1. Urgency, an explicit request to speak to a person, or a technical
 *      failure -> a live transfer is REQUESTED, if one is configured as
 *      available right now (`liveTransferAvailable`, injected by the
 *      caller — this module never reads a real clock or a real telephony
 *      provider's live status). The result never claims the transfer
 *      happened: `transferAction` is only ever `HumanAssistanceAction`'s
 *      single member, `"human_assistance_required"`
 *      (src/types/voiceOutcomes.ts) — the SAME type the rest of this
 *      middleware already uses for the same reason (see that file's
 *      docblock, and src/types/transferAction.ts's 3-member union, which
 *      this module never imports and never could construct
 *      `"transfer_completed"` from even by mistake).
 *   2. If a live transfer was not requested (unavailable, or the trigger
 *      doesn't call for one), an internal operator task is created instead
 *      (`internalTaskCreated`).
 *   3. An internal WhatsApp notice MAY additionally be requested — always
 *      simulated only, nothing is actually sent — but only alongside an
 *      actual escalation (urgency, or a pending internal task). A normal,
 *      successful booking or availability answer never reaches this
 *      function at all, so it can never trigger a WhatsApp notice; see
 *      the dedicated test in tests/callEngine/engine.test.ts.
 *   4. The caller (engine.ts) tells the customer exactly what happened —
 *      via `phraseKey`/`phraseParams` below, resolved to Spanish text only
 *      by phrasing/es.ts — never promising a completed transfer or a
 *      response time (see that file's `REASON_CUSTOMER_REQUESTS_HUMAN` and
 *      `REASON_TECHNICAL_FAILURE` entries).
 *
 * Deliberately synchronous and side-effect free: it does not itself call
 * any `ports/index.ts` port (no adapter exists for any of them in this
 * mission — see that module's docblock). It only decides WHAT should
 * happen; `engine.ts` is responsible for recording the resulting task/
 * notice into `store/memoryStore.ts` and for emitting the corresponding
 * internal event.
 */
export type EscalationTrigger = "urgent" | "explicit_human_request" | "technical_failure";

export interface EscalateInput {
  trigger: EscalationTrigger;
  /**
   * Whether a live transfer is available right now, within this synthetic
   * profile's configured hours. Injected by the caller — this module never
   * infers it from the real wall clock or from any live provider status.
   */
  liveTransferAvailable: boolean;
}

export interface HumanEscalationResult {
  /** Step 1: a live transfer was REQUESTED — never "completed". */
  liveTransferRequested: boolean;
  /** Present only when `liveTransferRequested`; always `"human_assistance_required"`. */
  transferAction?: HumanAssistanceAction;
  /** Step 2: created only when a live transfer was not requested. */
  internalTaskCreated: boolean;
  /** Step 3: optional, simulated-only internal WhatsApp notice. */
  internalNoticeRequested: boolean;
  /** Step 4: what to tell the customer — resolved to text only by the phrasing layer. */
  phraseKey: Extract<PhraseKey, "REASON_CUSTOMER_REQUESTS_HUMAN" | "REASON_TECHNICAL_FAILURE">;
  phraseParams: { liveTransferRequested: boolean };
}

export function escalate(input: EscalateInput): HumanEscalationResult {
  const liveTransferRequested = input.liveTransferAvailable;
  const internalTaskCreated = !liveTransferRequested;
  // A WhatsApp notice is optional: requested whenever an internal task is
  // left pending (nobody picked up live), or whenever the trigger itself is
  // urgent — never for the two success reasonCodes, which never call this
  // function in the first place (see engine.ts).
  const internalNoticeRequested = internalTaskCreated || input.trigger === "urgent";

  return {
    liveTransferRequested,
    ...(liveTransferRequested ? { transferAction: "human_assistance_required" as const } : {}),
    internalTaskCreated,
    internalNoticeRequested,
    phraseKey: input.trigger === "technical_failure" ? "REASON_TECHNICAL_FAILURE" : "REASON_CUSTOMER_REQUESTS_HUMAN",
    phraseParams: { liveTransferRequested },
  };
}
