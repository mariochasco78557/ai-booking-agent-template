/**
 * Phrase keys spoken by the call engine — TEXT-FREE. The engine (engine.ts,
 * stateMachine.ts, humanCascade.ts, ...) only ever returns a `PhraseKey`
 * plus optional `params`; it NEVER returns a literal string of Spanish (or
 * any other language). Only the presentation layer, one file per locale
 * under this same directory (see `es.ts`), turns a `PhraseKey` into actual
 * words. Adding a second language later means adding `phrasing/<locale>.ts`
 * — nothing in the engine changes, and `tsc` forces the new locale file to
 * cover every key here via `Record<PhraseKey, ...>` (see `es.ts`).
 *
 * Two families of keys:
 *  - Ten `REASON_*` keys, one per `ReasonCode` (see `../precedence.ts`).
 *    These are the terminal, honest outcome phrases spoken at
 *    EMITIR_RESUELVE / EMITIR_DERIVA / EMITIR_RECHAZA. Their Spanish
 *    wording is constrained by (internal doc, not included in the template) and by three hard
 *    honesty rules documented on `../../../docs/call_interruption_mvp/
 *    (internal doc, not included in the template)` and enforced in `es.ts`:
 *      1. the human-assistance phrase never claims a transfer was
 *         completed, nor promises a response time;
 *      2. the "no slot" phrase never claims the shop is indefinitely full;
 *      3. the "professional unavailable" phrasing never states *why* a
 *         professional is unavailable (privacy — see
 *         `calendar/model.ts`'s `EmployeeAbsence.privateReason`).
 *      4. (step 14) no phrase ever recites concrete opening days or
 *         hours. This catalogue is static and has no access to the
 *         calendar, so any schedule it named would be a guess about data
 *         it cannot see — and it was demonstrably wrong: the wording
 *         announced "solo abrimos lunes y martes" while the venue profile
 *         the console and the demo run on (`fixtures/demoSalonVenue.ts`)
 *         closes precisely on Mondays. Availability is the resolver's job
 *         (`calendar/resolveAvailability.ts`), which offers real
 *         alternatives; the words must not compete with it. Enforced by
 *         `tests/callEngine/phrasingSchedule.test.ts`.
 *  - Eleven functional keys used along the way: framing the demo, asking
 *    for one missing field at a time, the two separate confirmation gates
 *    (service, then booking), offering alternatives, the single allowed
 *    clarification, and the farewell.
 *  - ONE additional key beyond the ten `REASON_*`/`ReasonCode` pairs:
 *    `REASON_BOOKING_CONFIRMATION_NOT_OBTAINED` (step 13 correction, A3/D2
 *    in the final report). The frozen ten-`ReasonCode` contract has no
 *    dedicated code for "the caller never gave the final booking
 *    confirmation" — see (internal doc, not included in the template) — so this
 *    case still resolves to `reasonCode: "INTENT_NOT_UNDERSTOOD"` (the
 *    least-wrong of the ten, per that document), but engine.ts speaks THIS
 *    key instead of `REASON_INTENT_NOT_UNDERSTOOD` for it, because telling
 *    a caller who was perfectly understood that they weren't understood is
 *    false. `es.ts` covers both keys with distinct, honest wording.
 *
 *    step 14 update: the same case now ALSO carries a distinct INTERNAL
 *    outcome code, `BOOKING_NOT_CONFIRMED` (callEngine/outcomeDimension.ts),
 *    surfaced on `ConversationResult.internalReasonCode`. The frozen
 *    `reasonCode` above is unchanged; this key remains the caller-facing
 *    half of the same fix.
 */
export type PhraseKey =
  // --- functional ---------------------------------------------------
  | "GREETING_DEMO_FRAME"
  | "ASK_SERVICE"
  | "ASK_SERVICE_CONFIRMATION"
  | "ASK_DATE"
  | "ASK_TIME"
  | "ASK_PROFESSIONAL"
  | "ASK_BOOKING_CONFIRMATION"
  | "CLARIFY_ONCE"
  | "OFFER_ALTERNATIVES"
  | "OFFER_ANOTHER_PROFESSIONAL"
  | "FAREWELL"
  // --- one per ReasonCode (terminal outcome phrases) ------------------
  | "REASON_BOOKING_CONFIRMED"
  | "REASON_AVAILABILITY_PROVIDED"
  | "REASON_CUSTOMER_REQUESTS_HUMAN"
  | "REASON_CANCEL_OR_CHANGE_NOT_ENABLED"
  | "REASON_BUSINESS_DATA_NOT_APPROVED"
  | "REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE"
  | "REASON_SERVICE_NOT_CONFIRMED"
  | "REASON_TECHNICAL_FAILURE"
  | "REASON_INTENT_NOT_UNDERSTOOD"
  | "REASON_SECURITY_OR_PRIVACY_BOUNDARY"
  // --- one extra key, NOT a ReasonCode of its own — see the docblock above ---
  | "REASON_BOOKING_CONFIRMATION_NOT_OBTAINED";
