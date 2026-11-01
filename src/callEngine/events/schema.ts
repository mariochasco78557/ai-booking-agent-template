import { z } from "zod";

/**
 * Two separate, independently-validated event flows. This split is
 * deliberate, not an oversight:
 *
 *   (a) THE PILOT EVENT — `PilotEventSchema` below is a byte-for-byte
 *       mirror of docs/call_interruption_mvp/pilot-event.schema.json. That
 *       JSON Schema's shape (`schemaVersion: "1.0.0"`, its exact field set,
 *       its exact `reasonCode`/`outcome`/`intent` enums, its
 *       `outcomeReasonPairs` invariant) is the FROZEN v1 contract this
 *       mission's parent (step 12) will show Bruno. Widening it — adding a
 *       field, loosening an enum, changing `schemaVersion` — would be an
 *       unauthorised amendment to that contract, not an implementation
 *       detail this mission is free to change. So `schemaVersion` here is
 *       hard-coded to `"1.0.0"`, matching the frozen file, and every field
 *       below is copied from it 1:1 (see the JSON file itself for the
 *       authoritative source; this module MUST be kept identical to it).
 *
 *   (b) THE INTERNAL OPERATIONAL EVENT — `InternalEventSchema` below is a
 *       SEPARATE stream, with its own `schemaVersion` namespace
 *       (`"internal-1.0.0"`, never `"1.0.0"`, so the two streams can never
 *       be confused with one another), for everything the future pilot
 *       console needs that the frozen pilot contract does not cover:
 *       availability lookups, which calendar exception applied, that an
 *       internal operator task was created, that an internal notice was
 *       (synthetically) simulated, that a synthetic booking was written, and
 *       raw internal errors. It carries the SAME rigour as the pilot
 *       stream — its own closed Zod schema, the same personal-data
 *       blacklist (`assertNoPersonalData`, applied by events/emitter.ts to
 *       every emission on both streams) — but it is not, and must never
 *       become, part of the frozen v1 pilot contract.
 *
 * Neither schema is ever satisfied by an object carrying the caller's raw
 * `callId` — only `callIdHash` (a salted SHA-256 digest — see
 * events/emitter.ts) ever appears on either stream.
 */

// ---------------------------------------------------------------------
// (a) Pilot event — mirrors pilot-event.schema.json exactly.
// ---------------------------------------------------------------------

export const PILOT_REASON_CODES = [
  "BOOKING_CONFIRMED",
  "AVAILABILITY_PROVIDED",
  "CUSTOMER_REQUESTS_HUMAN",
  "CANCEL_OR_CHANGE_NOT_ENABLED",
  "BUSINESS_DATA_NOT_APPROVED",
  "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
  "SERVICE_NOT_CONFIRMED",
  "TECHNICAL_FAILURE",
  "INTENT_NOT_UNDERSTOOD",
  "SECURITY_OR_PRIVACY_BOUNDARY",
] as const;

export const PILOT_OUTCOMES = ["RESUELVE", "DERIVA", "RECHAZA"] as const;

export const PILOT_INTENTS = [
  "BOOK",
  "CHECK_AVAILABILITY",
  "HUMAN_HELP",
  "CANCEL",
  "RESCHEDULE",
  "ASK_PRICE",
  "OTHER",
] as const;

export const PILOT_EVENT_NAMES = [
  "CALL_STARTED",
  "INTENT_CLASSIFIED",
  "STATE_TRANSITION",
  "OUTCOME_EMITTED",
  "CALLBACK_REQUESTED",
  "STAFF_INTERRUPTION_RECORDED",
  "TECHNICAL_FAILURE",
  "CALL_ENDED",
] as const;

const eventIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
const callIdHashPattern = /^[a-f0-9]{64}$/;
const scenarioIdPattern = /^A[0-9]{2}[-a-z0-9]+$/;

/**
 * `dependentRequired`/`allOf` from the JSON Schema are re-expressed as a
 * Zod `superRefine`: `outcome` and `reasonCode` are either both present and
 * mutually consistent, or both absent; and an `OUTCOME_EMITTED` event must
 * carry `outcome`, `reasonCode`, `announcesSuccess` and `synthetic`.
 */
const OUTCOME_REASON_PAIRS: Readonly<Record<(typeof PILOT_OUTCOMES)[number], readonly string[]>> = {
  RESUELVE: ["BOOKING_CONFIRMED", "AVAILABILITY_PROVIDED"],
  DERIVA: [
    "CUSTOMER_REQUESTS_HUMAN",
    "CANCEL_OR_CHANGE_NOT_ENABLED",
    "BUSINESS_DATA_NOT_APPROVED",
    "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
    "SERVICE_NOT_CONFIRMED",
    "TECHNICAL_FAILURE",
    "INTENT_NOT_UNDERSTOOD",
  ],
  RECHAZA: ["SECURITY_OR_PRIVACY_BOUNDARY"],
};

const PilotEventBaseSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  eventId: z.string().regex(eventIdPattern),
  occurredAt: z.string().datetime(),
  callIdHash: z.string().regex(callIdHashPattern),
  scenarioId: z.string().regex(scenarioIdPattern),
  eventName: z.enum(PILOT_EVENT_NAMES),
  fromState: z.string().optional(),
  toState: z.string().optional(),
  intent: z.enum(PILOT_INTENTS).optional(),
  outcome: z.enum(PILOT_OUTCOMES).optional(),
  reasonCode: z.enum(PILOT_REASON_CODES).optional(),
  announcesSuccess: z.boolean().optional(),
  /**
   * NOT COLLECTED by this demo — kept here ONLY because this schema is a
   * byte-for-byte mirror of the frozen pilot-event.schema.json, where the
   * field is (and stays) OPTIONAL. events/emitter.ts deliberately never
   * populates it: this module tree has no transport and no real clock, so
   * any value it could invent would be read as measured latency and would
   * not be one (see the A2 correction in engine.ts's docblock).
   *
   * Removing it here would be the real breaking change: a future real
   * transport that DOES measure latency must be able to emit a v1 event
   * carrying it and have it validate. Because the field is optional, today's
   * events (which omit it) and tomorrow's (which will carry it) both
   * validate against the same frozen schema. Measurement boundary:
   * docs/call_interruption_mvp/PILOT_METRICS.md, section "Latencia".
   */
  latencyMs: z.number().int().min(0).optional(),
  synthetic: z.literal(true).optional(),
}).strict();

export const PilotEventSchema = PilotEventBaseSchema.superRefine((event, ctx) => {
  const hasOutcome = event.outcome !== undefined;
  const hasReasonCode = event.reasonCode !== undefined;
  if (hasOutcome !== hasReasonCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "outcome and reasonCode must both be present or both absent (dependentRequired)",
    });
  } else if (hasOutcome && hasReasonCode) {
    const allowed = OUTCOME_REASON_PAIRS[event.outcome as (typeof PILOT_OUTCOMES)[number]];
    if (!allowed.includes(event.reasonCode as string)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reasonCode "${event.reasonCode}" is not valid for outcome "${event.outcome}"`,
      });
    }
  }

  if (event.eventName === "OUTCOME_EMITTED") {
    if (event.outcome === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OUTCOME_EMITTED requires outcome" });
    if (event.reasonCode === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OUTCOME_EMITTED requires reasonCode" });
    if (event.announcesSuccess === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OUTCOME_EMITTED requires announcesSuccess" });
    if (event.synthetic !== true)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OUTCOME_EMITTED requires synthetic: true" });
  }
});

export type PilotEvent = z.infer<typeof PilotEventBaseSchema>;
export type PilotEventName = (typeof PILOT_EVENT_NAMES)[number];
export type PilotIntent = (typeof PILOT_INTENTS)[number];

// ---------------------------------------------------------------------
// (b) Internal operational event — separate stream, own schema, same rigour.
// ---------------------------------------------------------------------

export const INTERNAL_EVENT_NAMES = [
  "AVAILABILITY_QUERIED",
  "CALENDAR_EXCEPTION_APPLIED",
  "HUMAN_TASK_CREATED",
  "INTERNAL_NOTICE_SIMULATED",
  "BOOKING_WRITTEN_SYNTHETIC",
  "ERROR_RAISED",
  /**
   * step 13 correction (B2/B3 in the final report): recorded whenever an
   * exact requested slot is rejected, carrying the REAL, specific cause in
   * `detail.cause` (e.g. "occupied", "not_capable", "outside_schedule_or_
   * break", "outside_horizon", "past_or_lead_time") — never client-facing
   * (see phrasing/es.ts's REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE, which
   * deliberately does NOT assert any of these causes to the caller). This
   * is how the future pilot console can distinguish "genuinely outside the
   * synthetic schedule" from "occupied" from "professional not capable"
   * without the frozen pilot contract needing an 11th reasonCode.
   */
  "SLOT_REJECTED",
  /**
   * step 13 correction (A3/D2 in the final report): recorded whenever the
   * call ends because the caller never gave the final, explicit booking
   * confirmation (docs/call_interruption_mvp's separate-confirmation-gate
   * invariant) — the narrower cause folded, for lack of a dedicated frozen
   * reasonCode, into INTENT_NOT_UNDERSTOOD/DERIVA. See
   * (internal doc, not included in the template): this internal event is exactly
   * what lets a future pilot console (and PILOT_METRICS.md's "tasa de no
   * entendimiento") separate this case out from a genuinely unrecognised
   * utterance.
   */
  "BOOKING_CONFIRMATION_NOT_OBTAINED",
  /**
   * step 14: emitted EXACTLY ONCE per call that reaches `finalize()`,
   * immediately before the frozen stream's `OUTCOME_EMITTED`. Carries the
   * INTERNAL outcome dimension (callEngine/outcomeDimension.ts) in
   * `detail`: `internalReasonCode`, the `pilotV1ReasonCode` an external v1
   * consumer will see for it, and the three metric booleans
   * (`countsAsNotUnderstood`, `countsAsBookingConversion`,
   * `countsAsContained`).
   *
   * This is what removes the manual cross-join (internal doc, not included in the template) used to
   * require: a metrics consumer no longer has to subtract
   * `BOOKING_CONFIRMATION_NOT_OBTAINED` calls from the
   * `INTENT_NOT_UNDERSTOOD` numerator by `callIdHash` — every call now
   * carries its own already-resolved answer on this single internal event.
   * `BOOKING_CONFIRMATION_NOT_OBTAINED` is kept alongside it: it marks the
   * MOMENT the gate failed, this one marks the RESOLVED outcome.
   *
   * Not part of, and never to become part of, the frozen v1 pilot contract.
   */
  "INTERNAL_OUTCOME_RESOLVED",
] as const;

export type InternalEventName = (typeof INTERNAL_EVENT_NAMES)[number];

export const InternalEventSchema = z.object({
  schemaVersion: z.literal("internal-1.0.0"),
  eventId: z.string().regex(eventIdPattern),
  occurredAt: z.string().datetime(),
  callIdHash: z.string().regex(callIdHashPattern),
  scenarioId: z.string().regex(scenarioIdPattern),
  eventName: z.enum(INTERNAL_EVENT_NAMES),
  /**
   * Free-form structured detail, e.g. `{ employeeId, dateISO, startMinutes }`
   * for `AVAILABILITY_QUERIED`. Every key here is scanned by
   * `assertNoPersonalData` (events/emitter.ts) before the event is
   * accepted — the same blacklist that applies to the pilot stream.
   */
  detail: z.record(z.string(), z.unknown()).optional(),
  synthetic: z.literal(true),
}).strict();

export type InternalEvent = z.infer<typeof InternalEventSchema>;

// ---------------------------------------------------------------------
// Personal-data blacklist — shared by both streams.
// ---------------------------------------------------------------------

/**
 * Case-/accent-insensitive substrings that must never appear as an object
 * KEY anywhere in an emitted event (pilot or internal). Matched against a
 * normalised (NFD-stripped, lower-cased) copy of each key.
 *
 * `displayName` (see fixtures/syntheticVenue.ts's `SyntheticProfessional.
 * displayName`) is a concrete, deliberate example of what this blocks: its
 * normalised key "displayname" contains "name", so passing a professional's
 * `displayName` into any event's `detail`/`params` throws here. Use
 * `employeeId` instead — every port and calendar function in this module
 * tree already identifies professionals by id, never by display name.
 */
const PERSONAL_DATA_KEY_SUBSTRINGS = [
  "phone",
  "telefono",
  "telephone",
  "msisdn",
  "name",
  "nombre",
  "apellido",
  "email",
  "transcript",
  "transcripcion",
  "audio",
  "recording",
  "grabacion",
  "address",
  "direccion",
  "dni",
  "nif",
] as const;

function normalizeKey(key: string): string {
  return key
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Exact (not substring) top-level field names of the two frozen/closed
 * envelopes above. These are skipped by the blacklist scan below ONLY when
 * matched exactly — e.g. the literal field "eventName" (part of BOTH
 * schemas' required shape, mirroring pilot-event.schema.json 1:1) would
 * otherwise false-positive against the "name" substring rule, even though
 * "eventName" means "name of the event", not a person's name. This allow
 * list does NOT skip nested values: `detail`/`params` objects are always
 * fully, recursively scanned, so a rogue nested `customerName` key is still
 * caught. Nothing here weakens the check against actual personal data —
 * it only prevents the check from tripping over the contract's own,
 * entirely-our-own-controlled field names.
 */
const ENVELOPE_KEY_EXACT_ALLOWLIST = new Set([
  "schemaversion",
  "eventid",
  "occurredat",
  "callidhash",
  "scenarioid",
  "eventname",
  "fromstate",
  "tostate",
  "intent",
  "outcome",
  "reasoncode",
  "announcessuccess",
  "latencyms",
  "synthetic",
  "detail",
  "params",
]);

/**
 * Recursively walks `value`, throwing on the first object key that contains
 * (post-normalisation) any blacklisted substring — unless the key is an
 * EXACT match for one of this module's own frozen envelope field names (see
 * `ENVELOPE_KEY_EXACT_ALLOWLIST`). Called on every emission by
 * events/emitter.ts, for both the pilot and the internal stream.
 */
export function assertNoPersonalData(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPersonalData(item, `${path}[${index}]`));
    return;
  }
  // Values, not just keys. The phase-9 security audit pointed out that a key
  // blacklist alone lets `detail: { note: "+34600123456" }` straight through:
  // nothing today does that, but nothing stopped it either. Only two shapes
  // are matched, both chosen because they are almost impossible to hit by
  // accident: an international phone number, and an email address. A general
  // "long run of digits" rule was deliberately NOT used — a 64-character
  // SHA-256 hash contains one often enough to make it useless.
  if (typeof value === "string") {
    if (/\+\d[\d\s().-]{6,}/.test(value)) {
      throw new Error(`assertNoPersonalData: value at ${path} looks like a phone number`);
    }
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) {
      throw new Error(`assertNoPersonalData: value at ${path} looks like an email address`);
    }
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    if (!ENVELOPE_KEY_EXACT_ALLOWLIST.has(normalized)) {
      for (const banned of PERSONAL_DATA_KEY_SUBSTRINGS) {
        if (normalized.includes(banned)) {
          throw new Error(
            `assertNoPersonalData: forbidden key "${key}" at ${path} (matches blacklisted substring "${banned}")`,
          );
        }
      }
    }
    assertNoPersonalData(child, `${path}.${key}`);
  }
}
