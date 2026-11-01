/**
 * The FULL transfer-action contract (design §9, senior finding B10). This
 * module is deliberately ISOLATED: nothing in `src/services` or
 * `src/routes` may import it, and adding such an import is a design
 * decision, not a refactor — do not "fix" a missing import here without
 * re-reading design §9 first.
 *
 * That isolation is not a convention to remember, it IS the enforcement
 * mechanism (layer 1 of 3 — see `src/types/voiceOutcomes.ts`'s
 * `HumanAssistanceAction`, which every middleware response type actually
 * uses). An earlier draft of the design argued the split was "enforced by
 * construction, because the adapter is absent". Senior review rejected
 * that: absence is not a constraint, it is a vacancy —
 * `return { action: "transfer_completed" }` would compile today if this
 * 3-member union were reachable from a middleware response type. Keeping
 * this union confined to its own module, never imported by anything that
 * builds a caller-facing response, means emitting `transfer_requested` or
 * `transfer_completed` from `src/services`/`src/routes` is a COMPILE ERROR
 * — not a grep-based test that has to be remembered and that rots the
 * moment someone adds a real adapter (the person adding the adapter is
 * exactly the person who would "fix" a failing grep test without noticing
 * what it was protecting).
 *
 * Because no transfer tooling exists today, the middleware can only ever
 * construct `"human_assistance_required"` (via `HumanAssistanceAction`).
 * When a real provider transfer adapter is eventually built:
 *   - it is the ONLY code permitted to import this module;
 *   - it is the ONLY code permitted to construct `"transfer_requested"`
 *     (on actually invoking a transfer tool) or `"transfer_completed"`
 *     (on the provider's OWN confirmation that the call was transferred —
 *     never merely on having asked for a transfer).
 */
export type TransferAction =
  | "human_assistance_required"
  | "transfer_requested"
  | "transfer_completed";
