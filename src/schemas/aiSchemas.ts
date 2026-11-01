import { z } from "zod";

import { SPANISH_PHONE_RE } from "../utils/personalData.js";

/**
 * Zod contracts for the /ai/* request bodies. Validation is strict: unknown
 * fields are rejected so the voice agent's tool schema stays honest.
 */

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const dateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    "reservationDate must be 'YYYY-MM-DD HH:mm:ss'",
  );

// Spanish mobile/landline: 9 digits starting 6,7,8,9 (optionally +34). The
// pattern itself lives in `src/utils/personalData.ts`, which is also what the
// VOICE path enforces, so the two cannot drift apart.
const spanishPhone = z.string().trim().regex(SPANISH_PHONE_RE, "teléfono no válido");

export const availabilitySchema = z
  .object({
    date: dateOnly,
    employeeId: z.number().int().positive().optional(),
    typeReservation: z.string().min(1).optional(),
    preferredTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "preferredTime must be HH:mm")
      .optional(),
    maxSlots: z.number().int().positive().max(20).optional(),
  })
  .strict();
export type AvailabilityInput = z.infer<typeof availabilitySchema>;

export const checkSlotSchema = z
  .object({
    reservationDate: dateTime,
    employeeId: z.number().int().positive().optional(),
  })
  .strict();
export type CheckSlotInput = z.infer<typeof checkSlotSchema>;

export const bookSchema = z
  .object({
    customer: z
      .object({
        name: z.string().trim().min(1),
        surnames: z.string().trim().min(1),
        phone: spanishPhone,
      })
      .strict(),
    reservationDate: dateTime,
    employeeId: z.number().int().positive().optional(),
    typeReservation: z.string().min(1).optional(),
    confirmedByCustomer: z.boolean(),
  })
  .strict();
export type BookInput = z.infer<typeof bookSchema>;

/**
 * The `conversation_id` contract, exported so `VoiceBookingService` can apply
 * the SAME rule without a second copy of it. `/ai/voice/availability` still
 * enforces it in Zod (a malformed id there is a configuration fault with no
 * write at stake); `/ai/voice/book` enforces it in the service, so the answer
 * is a deterministic HTTP 200 rather than a tool error.
 */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]+$/;
export const CONVERSATION_ID_MIN_LENGTH = 8;
export const CONVERSATION_ID_MAX_LENGTH = 200;

const conversationId = z
  .string()
  .min(CONVERSATION_ID_MIN_LENGTH)
  .max(CONVERSATION_ID_MAX_LENGTH)
  .regex(CONVERSATION_ID_RE, "conversation_id no válido");

const serviceId = z.union([z.literal(0), z.literal(1), z.literal(2)]);

function dateOnlyEpoch(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return undefined;
  }
  return epoch;
}

/**
 * Voice-friendly availability contract for ElevenLabs. Unlike the legacy
 * one-day `/ai/availability` body, this accepts a bounded date window so a
 * caller can naturally ask for "esta semana" without the LLM making one
 * webhook call per day.
 */
export const voiceAvailabilitySchema = z
  .object({
    conversation_id: conversationId,
    date_from: dateOnly,
    date_to: dateOnly,
    service_id: serviceId,
    employee_id: z.number().int().positive().optional(),
    preferred_time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "preferred_time must be HH:mm")
      .optional(),
    time_period: z.enum(["any", "morning", "afternoon"]).default("any"),
    max_slots: z.number().int().min(1).max(3).default(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    const from = dateOnlyEpoch(value.date_from);
    const to = dateOnlyEpoch(value.date_to);
    if (from === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date_from"], message: "date_from no es una fecha válida" });
      return;
    }
    if (to === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date_to"], message: "date_to no es una fecha válida" });
      return;
    }
    const spanDays = Math.round((to - from) / 86_400_000);
    if (spanDays < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date_to"], message: "date_to debe ser igual o posterior a date_from" });
    } else if (spanDays > 6) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date_to"], message: "el intervalo máximo es de 7 días" });
    }
  });
export type VoiceAvailabilityInput = z.infer<typeof voiceAvailabilitySchema>;

/**
 * Flat on purpose: webhook LLMs fill this more reliably than nested objects.
 *
 * *** step SLOT — `reservation_date`, `employee_id` and `service_id` are
 * GONE, and their absence is the entire point of this contract. ***
 *
 * On 2026-08-30 the agent never called `/ai/voice/availability`. It
 * reconstructed a `reservation_date` from the conversation, sent
 * `employee_id: "Bruno"`, and the request died in this schema — because the
 * invented phone was not shaped like a Spanish number and the invented
 * employee id was a string. That was luck, not a control: `612345678` and
 * `40` would have passed.
 *
 * The three fields a model was reconstructing no longer exist as free input.
 * The hour, the barber and the service are read out of `slot_token`
 * (`src/services/slotAuthorization.ts`), which only
 * `/ai/voice/availability` can mint and which is sealed against the
 * conversation it was issued for. There is nothing left here to fabricate: a
 * booking either echoes a token this middleware produced, or it does not
 * happen.
 *
 * This is the option the design brief called the preferred one — remove the
 * fields rather than keep them and cross-check — and it is preferred for a
 * reason beyond tidiness. Keeping them would mean every mismatch became a
 * NEW failure mode mid-call ("the token says 17:00, the body says 18:00"),
 * and the model's natural response to a rejection is to adjust a field and
 * try again. A contract with nothing to adjust cannot be negotiated with.
 *
 * *** THIS SCHEMA VALIDATES ALMOST NOTHING, AND THAT IS THE SECOND HALF OF
 * THE FIX (audit finding, 2026-08-30). ***
 *
 * It used to be `.strict()` with `z.literal(true)`, a Spanish-phone regex and
 * `min(1)` on every string. Every one of those turned an ORDINARY, EXPECTED
 * failure of a voice agent — a mistranscribed phone, a forgotten confirmation
 * flag, a name it never collected, a tool still sending the pre-migration body
 * — into an HTTP 400. ElevenLabs renders a non-2xx as a TOOL ERROR and
 * re-invokes the tool. That is precisely the mechanism that turned one booking
 * into four on 2026-08-30, and answering 400 for the failures the model is
 * MOST likely to produce put it back.
 *
 * So the split is now:
 *
 * - **Here**: is this a JSON object at all? Nothing else. Each field is
 *   `unknown`, because a `phone` that arrived as a number must reach the same
 *   deterministic refusal as one that arrived misspelled, not a different one.
 * - **`VoiceBookingService.book()`**: presence, type, size, format, fillers,
 *   the token seal and the confirmation gate — every one answering HTTP 200
 *   with a deterministic `outcome`, before the idempotency journal and before
 *   any upstream call.
 *
 * `.strict()` is gone too, so the six keys below are STRIPPED of anything
 * else Zod does not know (Zod's default). A pre-migration tool still sending
 * `reservation_date`, `employee_id` and `service_id` gets those fields
 * silently discarded at this boundary — they reach no code — and then fails
 * on the missing `slot_token` like any other unauthorized booking. Dropping
 * them does NOT reopen the old contract: `EffectiveBooking` is built field by
 * field from the GRANT, so there is no path by which a legacy field could be
 * read even if one survived.
 *
 * The `shape` below is still the CANONICAL declaration of the contract — it
 * is what `tests/voiceContract.test.ts` compares against
 * `docs/elevenlabs/TOOL_SCHEMAS.json`, where the tool remains strict and
 * requires all six. Liberal in what it accepts, strict in what it declares.
 */
export const voiceBookSchema = z.object({
  /**
   * The idempotency scope, and half of what a slot token is sealed against.
   * `unknown` like the rest: ElevenLabs binds this from the
   * `system__conversation_id` dynamic variable, and the incident report is
   * explicit that the platform cannot bind every webhook field reliably — so
   * a missing one is a configuration failure to answer deterministically, not
   * to 400 into a retry loop.
   */
  conversation_id: z.unknown(),
  customer_name: z.unknown(),
  customer_surnames: z.unknown(),
  phone: z.unknown(),
  /**
   * The opaque authorization for ONE hueco, copied verbatim from the
   * `slots[].slot_token` of a real `/ai/voice/availability` answer. Its size,
   * shape and contents are checked by `SlotAuthorizationService`; nothing
   * oversized ever reaches the crypto path.
   */
  slot_token: z.unknown(),
  /** Must be exactly `true`. Anything else — including absent — is
   * `not_confirmed`, decided in the service. */
  confirmed_by_customer: z.unknown(),
});
export type VoiceBookInput = z.infer<typeof voiceBookSchema>;

/**
 * step 10C ((internal doc, not included in the template) §5):
 * `customerPhone` is REMOVED — the phone used for lookup must be the
 * verified caller identity resolved by `src/callerIdentity/resolver.ts`
 * from headers, never a value the model transcribed from speech.
 * `customerName` is ALSO removed: upstream's own
 * `RequestValidation::assertAllowedKeys($payload, ['phone','fromDate'])`
 * rejects a name outright, so keeping it here would either 400 or be
 * silently ignored — exactly the "an ignored field invites confusion"
 * mistake this same design section condemns about `customerPhone`. Do not
 * reintroduce either field without re-reading design §5.
 */
export const myReservationsSchema = z
  .object({
    fromDate: dateOnly.optional(),
  })
  .strict();
export type MyReservationsInput = z.infer<typeof myReservationsSchema>;

/**
 * step 10C ((internal doc, not included in the template) §6):
 * `reservationId` (a raw numeric legacy id) is REMOVED. Invariant 12: a raw
 * numeric id is never sufficient to authorize a cancellation — it addresses
 * the wrong table entirely (the legacy `/v1/reservation` rows, not the
 * ai-mode ones `reservationRef` addresses) and carries no proof it was ever
 * legitimately handed to this caller. `reservationRef` is opaque
 * (`base64url(HMAC-SHA256(runSalt, "res:"||id))[0:32]`, non-enumerable — see
 * `ReservationRef::REF_LENGTH` in the Symfony overlay), obtainable ONLY from
 * a `one_match` lookup performed under a verified identity
 * (`src/services/lookupService.ts`), and meaningless without one. Its shape
 * is validated here, in Zod, BEFORE any upstream call — so a path-shaped or
 * oversized string never reaches upstream, and never reaches the
 * per-`reservationRef` attempt-counter filename space
 * (`CancellationProofStore`) either.
 */
export const cancelSchema = z
  .object({
    reservationRef: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    confirmedByCustomer: z.boolean(),
    /**
     * LLM-transcribed. A SECONDARY, caller-stated factor — explicitly weaker
     * than the caller identity — never an authenticator on its own (design
     * §6.1). Upstream compares it with exact string equality, so this is
     * NOT normalized or reshaped here; whatever the model heard is sent
     * verbatim.
     */
    callerStatedName: z.string().trim().min(1),
  })
  .strict();
export type CancelInput = z.infer<typeof cancelSchema>;
