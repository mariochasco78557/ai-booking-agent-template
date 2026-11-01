import { CALENDAR_PROVIDER_IDS } from "../core/calendar/CalendarProvider.js";
import { z } from "zod";
import {
  closedWeekdaysCsv,
  defaultEmployeeResourceId,
  earlyCloseCsv,
  getClientConfig,
} from "../core/config/clientConfig.js";
import dotenv from "dotenv";

import {
  SLOT_TOKEN_SECRET_MIN_LENGTH,
  SLOT_TOKEN_TTL_MAX_SECONDS,
  SLOT_TOKEN_TTL_MIN_SECONDS,
} from "../services/slotAuthorization.js";
import {
  VOICE_OFFER_MAX_ENTRIES_MAX,
  VOICE_OFFER_MAX_ENTRIES_MIN,
  VOICE_OFFER_TTL_MAX_SECONDS,
  VOICE_OFFER_TTL_MIN_SECONDS,
} from "../services/voiceOfferStore.js";

import { normalizeSpanishPhone } from "../utils/phone.js";
import {
  BALANCED_WA_MAX_OPTIONS_DEFAULT,
  clampBalancedWaMaxOptions,
} from "../schemas/balancedV2Schemas.js";

dotenv.config();

/**
 * dotenv turns a bare `KEY=` line into the empty string `""`, not an absent
 * key. `.optional()`/`.default()` only treat `undefined` as "not set", so a
 * blank line in `.env` would otherwise be parsed as an invalid value (e.g.
 * `Number("") === 0`, which fails `.positive()`) instead of falling back to
 * the default/absent behaviour a human editing the file expects. This
 * normalizes a blank or whitespace-only string to `undefined` before the
 * field schema runs. Do NOT apply this to required secrets (BOOKING_USERNAME,
 * BOOKING_PASSWORD, AI_WEBHOOK_SECRET) — those must keep failing closed on a
 * blank value.
 */
const blankAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema,
  );

/**
 * `WA_SELF_SERVICE_ALLOWLIST` (comma-separated). Returns the zero-based
 * position of the first entry that is not a Spanish phone, or undefined.
 * Empty entries (trailing comma) are ignored. Never returns the value.
 */
function findInvalidWaAllowlistEntry(raw: string): number | undefined {
  const entries = raw.split(",").map((e) => e.trim());
  let position = 0;
  for (const entry of entries) {
    if (entry === "") continue;
    if (!normalizeSpanishPhone(entry).ok) return position;
    position += 1;
  }
  return undefined;
}

/** Parses the (already validated) allowlist into a set of E.164 phones. */
export function parseWaAllowlist(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (raw === undefined) return out;
  for (const entry of raw.split(",").map((e) => e.trim())) {
    if (entry === "") continue;
    const phone = normalizeSpanishPhone(entry);
    if (phone.ok) out.add(phone.e164);
  }
  return out;
}

/**
 * Environment schema. The service fails closed: if any required variable is
 * missing or malformed, boot aborts with a readable (non-secret) error.
 */
const envSchema = z.object({
  NODE_ENV: blankAsUnset(
    z.enum(["development", "test", "production"]).default("development"),
  ),
  PORT: blankAsUnset(z.coerce.number().int().positive().default(3000)),
  HOST: blankAsUnset(z.string().default("0.0.0.0")),
  LOG_LEVEL: blankAsUnset(
    z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  ),

  // Upstream Demo Salon Symfony API
  BOOKING_API_BASE_URL: blankAsUnset(
    z.string().url().default("https://booking.example.com/v1"),
  ),
  BOOKING_USERNAME: z.string().min(1, "BOOKING_USERNAME is required"),
  BOOKING_PASSWORD: z.string().min(1, "BOOKING_PASSWORD is required"),

  /**
   * Whether login requests a "remember me" persistent session. The upstream
   * Lexik/Symfony remember-me mechanism is known to issue very long-lived
   * (365-day) tokens for the service-account credential, which is a
   * significant standing-access risk if leaked. Defaults to "false" so the
   * normal, much shorter, token lifetime is used. Setting this to "true"
   * must be an explicit, documented, opt-in decision — never a silent
   * default.
   */
  BOOKING_REMEMBER_ME: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  // Business defaults
  BOOKING_DEFAULT_EMPLOYEE_ID: blankAsUnset(
    // Por defecto: `calendario.empleado_por_defecto` de cliente.yaml (Demo Salon: 1). D-007.
    z.coerce.number().int().positive().default(() => defaultEmployeeResourceId(getClientConfig())),
  ),
  BOOKING_DEFAULT_TYPE_RESERVATION: blankAsUnset(
    // Por defecto: `calendario.servicio_por_defecto` de cliente.yaml (Demo Salon: "1"). D-007.
    z.string().default(() => getClientConfig().calendario.servicio_por_defecto as string),
  ),

  /**
   * Owner strategy (see (internal doc, not included in the template)). The observed POST
   * /v1/reservation payload attaches an `owner.id` of a real Demo Salon user.
   * On a single service account this ID is the configurable point. Behaviour
   * on a real account is UNVERIFIED until a live test is explicitly approved.
   */
  BOOKING_DEFAULT_OWNER_ID: blankAsUnset(
    z.coerce.number().int().positive().optional(),
  ),
  BOOKING_DEFAULT_OWNER_NAME: blankAsUnset(z.string().optional()),
  BOOKING_DEFAULT_OWNER_SURNAMES: blankAsUnset(z.string().optional()),

  /**
   * step CTL-3 — who the reservation belongs to upstream. See the long note
   * on `BookingConfig.ownerMode` in `src/services/bookingService.ts` for the
   * evidence; the short version:
   *
   * - `service_account` (default here) sends `owner.id`. Upstream then
   *   force-attributes the row to our authenticated account, which (a) trips
   *   its own one-reservation-per-user cap so the SECOND booking ever
   *   attempted fails with HTTP 400 regardless of the customer, and (b) makes
   *   the panel's card render the service account's name.
   * - `guest` omits `owner` entirely, leaving `user_id` NULL — the same shape
   *   the salon's own booking form produces for every manual and web booking.
   *   No cap, no wrong name, no account created for anyone who phones.
   *
   * The default stays `service_account` so this variable's absence changes
   * nothing anywhere. The deployment opts in, which makes the rollback a
   * one-line edit and a container restart.
   */
  BOOKING_BOOKING_OWNER_MODE: blankAsUnset(
    z.enum(["service_account", "guest"]).default("service_account"),
  ),

  // Security
  AI_WEBHOOK_SECRET: z
    .string()
    .min(16, "AI_WEBHOOK_SECRET must be at least 16 characters"),

  /**
   * step LAT (objective 3) — a SECOND credential, required by
   * `/ai/voice/book` and by nothing else, carried in its own
   * `x-ai-booking-secret` header (`src/plugins/webhookAuth.ts`).
   *
   * Optional, and unset by default, so nothing about today's deployment
   * changes. When set, creating an appointment requires BOTH this secret and
   * `AI_WEBHOOK_SECRET`, so the credential the voice agent carries on every
   * single availability call can no longer, on its own, reach a write path.
   *
   * Configure it BEFORE arming creation, not with it: that keeps activation a
   * single flag flip rather than a flag plus a credential rollout.
   */
  AI_BOOKING_WEBHOOK_SECRET: blankAsUnset(
    z.string().min(32, "AI_BOOKING_WEBHOOK_SECRET must be at least 32 characters").optional(),
  ),

  /**
   * step SLOT — the key that seals the per-hueco `slot_token`
   * (`src/services/slotAuthorization.ts`).
   *
   * *** A THIRD, INDEPENDENT SECRET, and deliberately not a reuse of either
   * webhook secret. ***
   *
   * The two webhook secrets are BEARER credentials: they travel on the wire,
   * in a header, on every call the agent makes, and they live in the
   * ElevenLabs dashboard where several people can read them. This one never
   * leaves the process — it is HKDF input, and nothing derived from it is
   * ever sent to ElevenLabs except the sealed tokens themselves. Reusing
   * `AI_WEBHOOK_SECRET` would mean that anyone who obtained the header value
   * (a proxy log, a screenshot of the dashboard, a support ticket) could mint
   * their own slot tokens — turning the one control that proves a hueco was
   * offered into a control that anyone with a copy of the request could
   * forge. It also means rotating the transport credential would silently
   * invalidate every token issued in every call in flight.
   *
   * Optional in the schema, and unset by default, so existing deployments
   * keep booting. Absent, the feature is DISABLED and fails closed:
   * `/ai/voice/availability` still answers (a read must not go dark for a
   * missing secret) but returns slots with no `slot_token`, and
   * `/ai/voice/book` refuses every request with `invalid_slot_token` without
   * touching the idempotency journal or the salon's API. The superRefine
   * below refuses to boot a production process that has creation ARMED
   * without it, so "bookings can happen" and "bookings must be authorized"
   * cannot come apart.
   *
   * Minimum 32 characters, matching `AI_BOOKING_WEBHOOK_SECRET`. Generate
   * with `openssl rand -base64 48`; never commit a value.
   */
  VOICE_SLOT_TOKEN_SECRET: blankAsUnset(
    z
      .string()
      .min(
        SLOT_TOKEN_SECRET_MIN_LENGTH,
        `VOICE_SLOT_TOKEN_SECRET must be at least ${SLOT_TOKEN_SECRET_MIN_LENGTH} characters`,
      )
      .optional(),
  ),

  /**
   * step SLOT — how long an offered hueco stays bookable, in seconds.
   *
   * Bounded on both sides on purpose. Too short and a normal conversation
   * outlives its own token, so a caller who takes three minutes to decide is
   * sent back to re-check the agenda for no reason. Too long and a token
   * becomes a standing authorization: the point of the expiry is that
   * permission to book an hour should not outlive the call that was offered
   * it.
   *
   * The default of 900 (15 minutes) is the same ceiling
   * `CALLER_ID_MAX_LIFETIME_MS` puts on a caller identity, and for the same
   * reason — a single phone call cannot plausibly run longer.
   *
   * Note this is NOT the freshness guarantee. A token that is still valid
   * says only "this middleware offered this hour in this call"; whether the
   * hour is still FREE is decided by the cache-bypassing re-check immediately
   * before the write ((internal doc, not included in the template) ADR-010), every single time.
   */
  VOICE_SLOT_TOKEN_TTL_SECONDS: blankAsUnset(
    z.coerce
      .number()
      .int()
      .min(SLOT_TOKEN_TTL_MIN_SECONDS)
      .max(SLOT_TOKEN_TTL_MAX_SECONDS)
      .default(900),
  ),

  /**
   * step OFFER — how long an INACTIVE conversation's offer memory is kept,
   * in seconds (`src/services/voiceOfferStore.ts`).
   *
   * *** THIS IS A MEMORY BOUND, NOT THE ISOLATION MECHANISM. ***
   *
   * Two conversations are isolated because their `conversation_id` keys
   * differ, and for no other reason: every lookup is an exact match, with no
   * "most recent" fallback of any kind. Shortening this value does not make
   * the isolation stronger; it only makes a caller who was put on hold lose
   * an offer they were still entitled to.
   *
   * Refreshed by every valid operation, so it bounds how long an ABANDONED
   * conversation is remembered — not how long a live call may run. The
   * default of an hour is deliberately generous for that reason.
   */
  VOICE_OFFER_TTL_SECONDS: blankAsUnset(
    z.coerce
      .number()
      .int()
      .min(VOICE_OFFER_TTL_MIN_SECONDS)
      .max(VOICE_OFFER_TTL_MAX_SECONDS)
      .default(3600),
  ),

  /**
   * step OFFER — the hard ceiling on remembered conversations.
   *
   * The store holds one small record per conversation and evicts the least
   * recently touched once this is exceeded, so the memory it can occupy is a
   * constant rather than a function of how long the process has been up.
   * Eviction is not a security event: an evicted conversation simply has to
   * ask for availability again before it can book.
   */
  VOICE_OFFER_MAX_ENTRIES: blankAsUnset(
    z.coerce
      .number()
      .int()
      .min(VOICE_OFFER_MAX_ENTRIES_MIN)
      .max(VOICE_OFFER_MAX_ENTRIES_MAX)
      .default(5000),
  ),

  // Networking / limits
  UPSTREAM_TIMEOUT_MS: blankAsUnset(
    z.coerce.number().int().positive().default(5000),
  ),
  /**
   * The total time budget for one `/ai/voice/v2/book` attempt, from the
   * `started` journal write to the answer this process gives ElevenLabs.
   *
   * ElevenLabs' own tool timeout is 8 s and an upstream write takes up to
   * ~2.5 s; 6 s leaves headroom on both sides. When the upstream write is
   * still running at the deadline, the caller gets `uncertain` immediately
   * and the write keeps going in the background — the journal (still
   * `started`) is what stops a second attempt from racing it. V1
   * (`/ai/voice/book`) does not receive this value and is unaffected.
   */
  BALANCED_BOOK_DEADLINE_MS: blankAsUnset(
    z.coerce.number().int().positive().default(6000),
  ),
  /**
   * V5 ((internal doc, not included in the template) ADR-025) — the SERVER-SIDE EMERGENCY BRAKE for the
   * V5 agent. V5 is not switched on here: it is activated PER REQUEST by the
   * V5 ElevenLabs branch, which sends `agent_profile: "v5"` as a constant in
   * its tool configuration (`src/services/balanced/agentProfile.ts`). A request
   * without that field is a V4 request and is never affected by this variable.
   *
   * Default `true`: a V5 request gets the V5 capabilities (several bookings
   * per call, ADR-023; the 14-day look-ahead, ADR-024). `false`: every V5
   * request is served exactly as V4 (logged once). The normal rollback is to
   * point the Twilio number back at the V4 branch; this is for when that
   * cannot happen fast enough. Only `"true"` / `"false"` are accepted —
   * anything else refuses to boot.
   */
  BALANCED_V5_ENABLED: blankAsUnset(
    z
      .enum(["true", "false"], {
        errorMap: () => ({ message: 'BALANCED_V5_ENABLED must be "true" or "false"' }),
      })
      .default("true")
      .transform((v) => v === "true"),
  ),
  /**
   * V5 ((internal doc, not included in the template) ADR-023/ADR-025) — how many CONFIRMED appointments a
   * call may create through `/ai/voice/v2/book` when the create request is a
   * V5 one. Integer 1..3, default 3. V4 requests are always limited to one.
   *
   * The idempotency journal keeps one sub-record per booking
   * (`conversation_id`, then `conversation_id#2`, `#3`), so an identical retry
   * of ANY booking is replayed and never written twice, and a booking beyond
   * the limit is refused. `1` makes V5 create requests behave exactly like V4
   * ones. Out of range, or not an integer, refuses to boot.
   */
  BALANCED_V5_MAX_BOOKINGS_PER_CALL: blankAsUnset(
    z.coerce
      .number()
      .int("BALANCED_V5_MAX_BOOKINGS_PER_CALL must be an integer between 1 and 3")
      .min(1, "BALANCED_V5_MAX_BOOKINGS_PER_CALL must be an integer between 1 and 3")
      .max(3, "BALANCED_V5_MAX_BOOKINGS_PER_CALL must be an integer between 1 and 3")
      .default(3),
  ),
  /**
   * 2026-10-09 (internal doc, not included in the template) — at most this many
   * PENDING (future) appointments per phone, voice and WhatsApp together,
   * counted in the salon's agenda before each new booking (a change does not
   * count). `0` = no limit. Needs the agenda reader of
   * `WA_SELF_SERVICE_MODE` ≠ off; without it there is no limit (said at boot).
   * Fail-open: an agenda that cannot be read in time never blocks a booking.
   */
  MAX_FUTURE_BOOKINGS_PER_PHONE: blankAsUnset(
    z.coerce
      .number()
      .int("MAX_FUTURE_BOOKINGS_PER_PHONE must be an integer between 0 and 50")
      .min(0, "MAX_FUTURE_BOOKINGS_PER_PHONE must be an integer between 0 and 50")
      .max(50, "MAX_FUTURE_BOOKINGS_PER_PHONE must be an integer between 0 and 50")
      .default(3),
  ),
  /** 2026-10-09 — the longest a create waits for that agenda read (ms). */
  MAX_FUTURE_BOOKINGS_READ_BUDGET_MS: blankAsUnset(
    z.coerce.number().int().min(200).max(3_000).default(1_500),
  ),
  RATE_LIMIT_MAX: blankAsUnset(z.coerce.number().int().positive().default(30)),
  RATE_LIMIT_WINDOW: blankAsUnset(z.string().default("1 minute")),

  // Availability behaviour
  DEFAULT_MAX_SLOTS: blankAsUnset(
    z.coerce.number().int().positive().max(20).default(6),
  ),

  /**
   * Global kill-switch for write operations (book/cancel). When false, the
   * middleware performs every validation and safety check but never calls the
   * upstream write endpoints, returning a Spanish "not enabled" message.
   * Defaults to false so no real booking can happen without opt-in.
   */
  ENABLE_WRITE_OPERATIONS: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * step PROD (Hito 5): per-operation write permission for CREATING a
   * booking. Deliberately NOT sufficient on its own — a create requires
   * `ENABLE_WRITE_OPERATIONS=true` AND this flag `=true` simultaneously (see
   * `src/config/writePermissions.ts`, which is the single place that AND is
   * computed). Before this flag existed, `ENABLE_WRITE_OPERATIONS` alone
   * armed BOTH creation and cancellation, so turning on creation silently
   * turned on cancellation too. That coupling is the defect this flag exists
   * to remove: enabling creation must never enable cancellation.
   */
  ENABLE_CREATE_BOOKING: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * step PROD (Hito 5): per-operation write permission for CANCELLING a
   * booking. Same AND rule as `ENABLE_CREATE_BOOKING` above, and equally
   * insufficient on its own. Independent of creation in both directions.
   */
  ENABLE_CANCEL_BOOKING: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * step PROD (Hito 5): per-operation write permission for MODIFYING an
   * existing booking. There is no update code path in this middleware at all,
   * and modifications are permanently out of scope for the voice agent
   * (changes are always routed to a human). This flag therefore exists only
   * to be `false`: setting it to `true` is rejected at boot by the
   * superRefine below rather than silently accepted, so a copy-pasted
   * production env cannot ever imply an update capability that does not
   * exist.
   */
  ENABLE_UPDATE_BOOKING: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * *** BALANCED V2 ((internal doc, not included in the template) ADR-020) — the V2 flow's OWN write
   * permission, independent of every other one. ***
   *
   * The balanced two-step flow (`/ai/voice/v2/availability` +
   * `/ai/voice/v2/book`) exists so a DUPLICATED ElevenLabs agent can be tested
   * against the real salon without touching the agent that is currently taking
   * calls. Testing it means calling it, and calling it must not be able to
   * create an appointment until somebody decides it may.
   *
   * So the rule is a THREE-way AND, not a two-way one:
   *
   *   balanced v2 create  ⇔  ENABLE_WRITE_OPERATIONS
   *                       &&  ENABLE_CREATE_BOOKING
   *                       &&  ENABLE_BALANCED_V2_CREATE
   *
   * The consequence that matters, and the one asserted in
   * `tests/balancedV2Create.test.ts`: with this flag false, `/ai/voice/v2/book`
   * answers `write_disabled` with `external_mutation: false` **even on a
   * deployment where creation is fully armed and `/ai/voice/book` is writing
   * real appointments**. Arming the salon's production flow does not arm the
   * experiment, and that is the whole reason this flag is separate rather than
   * a reuse of `ENABLE_CREATE_BOOKING`.
   *
   * It never enables anything on its own: with the master switch or
   * `ENABLE_CREATE_BOOKING` off, `true` here writes nothing.
   */
  ENABLE_BALANCED_V2_CREATE: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * 2026-10-08 — REAL change of a booking made earlier in the SAME voice call
   * (`replaces_booking_number` on `/ai/voice/v2/book`, V5 only): the new
   * booking is created first and, only if confirmed, the old one is cancelled
   * through the WhatsApp self-service cancel path (ADR-032, service account).
   *
   * Default `false` — deploy dark, arm deliberately. Effective only when ALL of
   * these hold: this flag, V2 creation armed (`ENABLE_WRITE_OPERATIONS` &&
   * `ENABLE_CREATE_BOOKING` && `ENABLE_BALANCED_V2_CREATE`) and
   * `WA_SELF_SERVICE_MODE=live` (itself gated on `ENABLE_WRITE_OPERATIONS`;
   * its allow list and cancel rate limits apply too). Otherwise every change is
   * answered `change_not_available` with NOTHING written, and the old booking
   * stands. See (internal doc, not included in the template).
   */
  VOICE_CHANGE_BOOKING_ENABLED: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * 2026-10-09 — the phone the customer is CALLING FROM as the booking phone
   * (`caller_phone` on `/ai/voice/v2/book`, bound by ElevenLabs to
   * `system__caller_id`, never filled by the LLM). Voice only.
   *
   * Default `false` — deploy dark. Off: `caller_phone` is ignored and a create
   * without a dictated phone is refused exactly as before. On: when `phone` is
   * absent, empty or the marker `"caller"`, the caller id is used if it is a
   * Spanish MOBILE (6xx/7xx); otherwise the agent is told to ask for a mobile.
   * A dictated phone always wins. See (internal doc, not included in the template).
   */
  /**
   * 2026-10-10 — the voice agent CONSULTS, CANCELS and CHANGES existing
   * bookings of the number that is calling (`my_bookings` / `cancel` on
   * `/ai/voice/v2/availability`, `replaces_existing_booking` on
   * `/ai/voice/v2/book`). See (internal doc, not included in the template).
   *
   * Default `false` — deploy dark. Off: those actions answer the WhatsApp
   * sentence and a `replaces_existing_booking` is `change_not_available` with
   * nothing written. Reading needs `WA_SELF_SERVICE_MODE` != off; a real
   * cancel needs `WA_SELF_SERVICE_MODE=live` (otherwise the booking stands
   * and the agent says so); a change also needs VOICE_CHANGE_BOOKING_ENABLED
   * and V2 creation.
   */
  VOICE_MANAGE_BOOKINGS_ENABLED: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * 2026-10-10 (internal doc, not included in the template) — plan B when the
   * call carries no usable number, or the booking is under another one.
   * Default `false`. On (and VOICE_MANAGE_BOOKINGS_ENABLED armed): `my_bookings`
   * accepts a DICTATED phone together with the first name of the booking in
   * the agenda (both must match; at most 2 attempts per call, 4 per number and
   * day, 30 per hour overall), its cancels and changes notify the owner marked
   * «número dictado», a hidden caller id is answered `phone_needed`, and a
   * voice `locked` answer carries `ask_phone: true` when the call has no
   * Spanish mobile. Off: dictated phones are ignored, exactly as before.
   */
  VOICE_MANAGE_DICTATED_PHONE_ENABLED: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  VOICE_CALLER_ID_PHONE_ENABLED: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * *** THE SALON'S WEEKLY CLOSURE — A STATIC SET, NOT A CALENDAR. ***
   *
   * CSV of weekday numbers using the SAME convention `Date#getUTCDay()` gives
   * and `weekdayEsOf` in `balancedAvailabilityService.ts` already relies on
   * (0 = Sunday … 6 = Saturday), so this schema and that function agree on
   * what "day 1" means without a second lookup table anywhere.
   *
   * Default `"0,1"` — Sunday and Monday, the salon's real weekly closure —
   * so `discover` and `scan` can answer «cerrado» WITHOUT reading the
   * upstream agenda at all: a closed day is a fact about the calendar, not
   * about the diary, and answering it should cost nothing upstream.
   *
   * An entry outside 0..6, or one that is not a number, is silently
   * DROPPED rather than rejected: a typo in this CSV should degrade to "one
   * fewer closed day recognised", never to a boot failure over a scheduling
   * detail that carries no security weight.
   *
   * *** NOT A HOLIDAY CALENDAR. *** See (internal doc, not included in the template) — a
   * one-off closure (a festivo) is still answered the way it always has
   * been, by the agenda simply having no free slots that day.
   */
  BALANCED_CLOSED_WEEKDAYS: blankAsUnset(
    z
      .string()
      // Por defecto: `dias_cerrados` de cliente.yaml (Demo Salon: "0,1"). D-007.
      .default(() => closedWeekdaysCsv(getClientConfig()))
      .transform((value): ReadonlySet<number> => {
        const days = new Set<number>();
        for (const part of value.split(",")) {
          const trimmed = part.trim();
          if (trimmed === "") continue;
          const day = Number(trimmed);
          if (Number.isInteger(day) && day >= 0 && day <= 6) days.add(day);
        }
        return days;
      }),
  ),

  /**
   * *** THE SALON'S EARLY CLOSE PER WEEKDAY (2026-10-08). ***
   *
   * CSV of `weekday=HH:MM` (same weekday convention as
   * `BALANCED_CLOSED_WEEKDAYS`: 0 = Sunday … 6 = Saturday). From that minute
   * the salon is closed that weekday: slots at/after it are never offered,
   * locked or booked, and an afternoon question on that day is answered
   * closed-style without reading upstream. Default `"6=14:00"` (Saturday only
   * until 14:00). Empty string disables. Only a filter on top of the live
   * agenda: holidays and breaks still come from Bruno's agenda.
   *
   * A malformed entry is silently DROPPED (same posture as the closed weekdays).
   */
  BALANCED_EARLY_CLOSE: z
    .string()
    // Por defecto: `cierre_temprano` de cliente.yaml (Demo Salon: "6=14:00"). D-007.
    .default(() => earlyCloseCsv(getClientConfig()))
    .transform((value): ReadonlyMap<number, number> => {
      const map = new Map<number, number>();
      for (const part of value.split(",")) {
        const match = /^\s*([0-6])\s*=\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
        if (match === null) continue;
        const hour = Number(match[2]);
        const minute = Number(match[3]);
        if (hour > 23 || minute > 59) continue;
        map.set(Number(match[1]), hour * 60 + minute);
      }
      return map;
    }),

  /**
   * *** HOW SOON «HOY» CAN STILL BE BOOKED (incident 2026-09-18). ***
   *
   * A slot of TODAY (Europe/Madrid) whose start is not strictly later than
   * now + this many minutes is never offered, locked or booked — by the
   * balanced V2 path (V4 and V5 alike) nor by any write, V1 included. See
   * `src/utils/slotLeadTime.ts`. Integer minutes, 0..240, default 30. `0`
   * still removes hours that have already started; it only drops the margin.
   * Anything else refuses to boot: this is a correctness rule, not a hint.
   */
  BALANCED_MIN_LEAD_MINUTES: blankAsUnset(
    z.coerce.number().int().min(0).max(240).default(30),
  ),

  /**
   * *** HOW MANY HOURS ONE WHATSAPP PAGE MAY SHOW (owner request 2026-10-08). ***
   *
   * Only for `/ai/voice/v2/availability` requests that carry
   * `x-ai-channel: whatsapp` (the WhatsApp brain): `discover`, `scan` and
   * `more` pages hold up to this many options, which the brain shows as a
   * WhatsApp list. Voice requests never send the header and keep pages of
   * exactly 3 (`BALANCED_MAX_OPTIONS`). Integer, default 10, CLAMPED to 3..10
   * (a WhatsApp list holds at most ten rows); a non-number refuses to boot.
   * See (internal doc, not included in the template) (Balanced V2 addendum 2026-10-08).
   */
  BALANCED_WA_MAX_OPTIONS: blankAsUnset(
    z.coerce
      .number()
      .int("BALANCED_WA_MAX_OPTIONS must be an integer (clamped to 3..10)")
      .default(BALANCED_WA_MAX_OPTIONS_DEFAULT)
      .transform(clampBalancedWaMaxOptions),
  ),

  /**
   * Feature flag for multi-barber availability + booking. When false (default),
   * the middleware keeps the original single-employee behaviour
   * (`BOOKING_DEFAULT_EMPLOYEE_ID`, employee display constants) so existing
   * behaviour stays backward-compatible and safe. When true, availability with
   * no `employeeId` fans out across all barbers returned by
   * `/user/employees-day` (per-employee `/user/free` + merge, Decision B), and
   * booking without an `employeeId` picks a free barber for the exact slot.
   * This flag never enables writes on its own — `ENABLE_WRITE_OPERATIONS` is a
   * separate, independent kill-switch.
   */
  ENABLE_MULTI_BARBER: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * step PROD (Hito 6): file backing the durable booking-idempotency store
   * (`src/services/bookingIdempotencyStore.ts`). When unset, idempotency is
   * held in memory only and does NOT survive a container restart.
   *
   * That is acceptable — and is what this deployment ships with — only while
   * creation is disabled, because a `/ai/voice/book` call cannot create
   * anything. It stops being acceptable the instant creation is armed: a
   * restart between a successful write and ElevenLabs' retry of the same
   * tool call would let the same customer be booked twice. The superRefine
   * below therefore refuses to boot a production process that has creation
   * armed without one.
   *
   * On the VPS this points inside the container's one writable mount (the
   * rest of the root filesystem is read-only); see `compose.yaml`.
   */
  BOOKING_IDEMPOTENCY_PATH: blankAsUnset(z.string().min(1).optional()),

  /**
   * step CTL ((internal doc, not included in the template) ADR-012) — the agenda-visible marker put in
   * front of the customer's first name for appointments the VOICE endpoint
   * (`POST /ai/voice/book`) creates. `IA-Pedro García` in Bruno's panel, for a
   * caller the agent addresses out loud as "Pedro".
   *
   * DEFAULTS TO `"IA -"`, ON PURPOSE. Every other switch in this file defaults
   * to the safe-but-inert value, because the risk they guard is "something
   * happens that should not have". This one guards the opposite risk: an
   * appointment appearing in a real diary with NOTHING to say a machine put
   * it there, indistinguishable from one Bruno took by hand. Absence of the
   * marker is a false statement to a human, so absence of the VARIABLE must
   * not produce it. An operator who genuinely wants unmarked voice bookings
   * has to say so, by setting this to an explicit empty string.
   *
   * Note it is NOT wrapped in `blankAsUnset()`, unlike almost everything
   * around it: `VOICE_BOOKING_DISPLAY_PREFIX=` must mean "no marker", not
   * "fall back to the default", or disabling it would be impossible to
   * express.
   *
   * Scope: applied by `src/services/bookingService.ts` to the upstream
   * `ownerName` field alone. Never to `ownerSurnames`, `owner.*`, the phone,
   * the idempotency fingerprint, any log line, or anything the agent speaks.
   *
   * *** THIS IS THE TOKEN ONLY. *** What separates it from the name lives in
   * `VOICE_BOOKING_DISPLAY_SEPARATOR` below — see that field for why the
   * separator is emphatically not a trailing space here.
   */
  VOICE_BOOKING_DISPLAY_PREFIX: z
    .string()
    .max(16, "VOICE_BOOKING_DISPLAY_PREFIX must be at most 16 characters")
    // Por defecto: `marca_ia.prefijo` de cliente.yaml (Demo Salon y valor del código: "IA -"). D-007.
    .default(() => getClientConfig().marca_ia.prefijo),

  /**
   * step CTL-4 — what goes between the marker token and the customer's name.
   *
   * The requirement Bruno's diary has to satisfy is one exact string:
   * `IA - Nombre Apellidos`. Before this field existed, the only way to
   * express it was a TRAILING SPACE inside
   * `VOICE_BOOKING_DISPLAY_PREFIX="IA - "` — and a trailing space is the
   * single most fragile thing you can put in a `.env` file. `dotenv` strips
   * it from any unquoted value, an editor strips it on save, a copy-paste
   * drops it, and `git diff` will not show you that it went. The failure is
   * silent and the symptom is cosmetic-looking (`IA -Jorge`), so it survives
   * review. The deployed VPS had exactly that value — `IA-` — while the
   * documentation claimed `IA - `.
   *
   * So the separator is now a CHOICE, not a character:
   *
   * - `space` (default) — exactly one space: `IA -` + `Jorge` => `IA - Jorge`.
   * - `none`            — nothing at all:   `IA-`  + `Jorge` => `IA-Jorge`.
   *
   * Neither value can be damaged by whitespace handling anywhere in the
   * chain, and the composed marker is normalized again downstream
   * (`applyBookingDisplayPrefix` collapses runs of whitespace), so even a
   * prefix that DID keep a stray trailing space composes to the same result
   * rather than to `IA -  Jorge`.
   *
   * Defaults to `space` for the same reason the prefix defaults to non-empty:
   * losing the variable must not silently produce the wrong diary entry.
   */
  VOICE_BOOKING_DISPLAY_SEPARATOR: blankAsUnset(
    z.enum(["space", "none"]).default(() => getClientConfig().marca_ia.separador),
  ),

  // Optional voice provider identifiers (unused by logic, kept for reference)
  ELEVENLABS_AGENT_ID: blankAsUnset(z.string().optional()),
  RETELL_AGENT_ID: blankAsUnset(z.string().optional()),

  /**
   * step PROD (Hito 10): expone `POST /v1/elevenlabs/availability`, la ruta
   * de compatibilidad que habla el contrato que el agente de voz ya usa
   * contra el puente local (`src/routes/elevenlabsCompat.ts`). Existe para
   * que migrar ElevenLabs sea cambiar una URL y nada más.
   *
   * Por defecto `false`: mientras el agente siga apuntando al túnel, esta
   * ruta no tiene ningún cliente legítimo, y una ruta pública sin cliente es
   * superficie regalada. Ponerla a `false` y reiniciar es también el
   * rollback completo de esta función, sin reconstruir imagen.
   *
   * NUNCA habilita escrituras: la ruta que enciende es de solo lectura y no
   * hay compatibilidad para `book` ni para `human-help`.
   */
  ENABLE_ELEVENLABS_COMPAT: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * El secreto que ElevenLabs envía en `X-Booking-Voice-Secret`. Variable
   * propia y no `AI_WEBHOOK_SECRET` reutilizado: el valor que el agente
   * tiene hoy vive en el dashboard de ElevenLabs y no en este repositorio,
   * así que tenerlos separados permite migrar sin rotar el secreto y rotarlo
   * sin volver a migrar — dos pasos reversibles por separado en vez de uno
   * acoplado. Mínimo 32 caracteres, el mismo suelo que exige el puente.
   * Requerido (abajo) sólo cuando la compatibilidad está encendida.
   */
  ELEVENLABS_COMPAT_SECRET: blankAsUnset(
    z.string().min(32, "ELEVENLABS_COMPAT_SECRET must be at least 32 characters").optional(),
  ),

  /**
   * Cuántos días por delante de hoy admite consultar la ruta de
   * compatibilidad. El puente usa 6 y ese es el valor por defecto aquí, para
   * que la migración no mueva también la ventana de fechas.
   */
  ELEVENLABS_COMPAT_HORIZON_DAYS: blankAsUnset(
    z.coerce.number().int().min(0).max(30).default(6),
  ),

  /**
   * step 10 (internal doc, not included in the template) lab upstream
   * mode. 'legacy' (default) preserves EVERY existing upstream call exactly
   * as today — nothing changes unless this is explicitly set to 'ai'. 'ai'
   * additionally makes availability/check-slot/booking call the disposable
   * lab's `/v1/ai/*` contract instead of the legacy `/v1/user/free`,
   * `/v1/user/employees-day-time` and `/v1/reservation` endpoints (see
   * src/clients/legacyRestClient.ts's `ai*` methods and
   * (internal doc, not included in the template) §6's mapping table).
   * This flag never enables writes on its own — ENABLE_WRITE_OPERATIONS
   * stays the separate, independent kill-switch with its current meaning.
   * Lookup and cancellation are NOT wired to 'ai' mode (a documented,
   * deliberate integration gap — see src/services/lookupService.ts and
   * src/services/cancellationService.ts) because today's caller-facing
   * `/ai/my-reservations` and `/ai/cancel` request schemas cannot honestly
   * carry what the Symfony contract requires (a telephony-verified caller ID
   * distinct from LLM-extracted `customerPhone`, and an opaque
   * reservationRef + single-use proof instead of a raw legacy `reservationId`)
   * without changing those schemas, which ElevenLabs' tool definitions
   * depend on and which this flag must not touch.
   */
  BOOKING_UPSTREAM_MODE: blankAsUnset(z.enum(["legacy", "ai"]).default("legacy")),

  /**
   * Phase 1 of (internal doc, not included in the template): which `CalendarProvider` adapter the
   * container wires (src/adapters/calendar/index.ts). `memory` is the
   * default, so an unset variable changes nothing; `google-calendar` (D-014)
   * needs one of the two GOOGLE_SERVICE_ACCOUNT_* variables below.
   */
  CALENDAR_PROVIDER: blankAsUnset(z.enum(CALENDAR_PROVIDER_IDS).default("memory")),

  /**
   * `google-calendar` only (D-014): the service-account key, either as a path
   * to its JSON file or as that JSON in base64. Never logged. Exactly one is
   * required with CALENDAR_PROVIDER=google-calendar (superRefine below).
   */
  GOOGLE_SERVICE_ACCOUNT_JSON: blankAsUnset(z.string().min(1).optional()),
  GOOGLE_SERVICE_ACCOUNT_JSON_B64: blankAsUnset(z.string().min(1).optional()),

  // ---------------------------------------------------------------------
  // step LAT — agenda cache and upstream fan-out.
  //
  // Every knob below only ever affects HOW FAST an answer is produced and HOW
  // MUCH LOAD that puts on the salon's API. None of them can change WHAT is
  // answered: the cache is filled exclusively from `/user/employees-day` and
  // `/user/free`, never from a static schedule, and the pre-write revalidation
  // bypasses it unconditionally ((internal doc, not included in the template) ADR-010).
  // ---------------------------------------------------------------------

  /**
   * Master switch for the agenda cache. `false` keeps the OPTIMIZED direct
   * path — batched `employees[]`, parallel dates, bounded concurrency — and
   * simply reads upstream every time. This is the one-step rollback for
   * everything the cache does, and it needs no image rebuild.
   */
  ENABLE_AGENDA_CACHE: blankAsUnset(
    z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  ),

  /** Days kept materialized, starting today. 14 = the mission's window. */
  AGENDA_CACHE_HORIZON_DAYS: blankAsUnset(
    z.coerce.number().int().min(1).max(30).default(14),
  ),

  /**
   * Upstream `type` values warmed, comma separated. Each one MULTIPLIES the
   * refresher's cost (one extra `/user/free` per date per service), so this is
   * the first knob to trim if upstream load ever needs to come down: the
   * agenda genuinely differs per service (verified live 2026-08-30 — type 2
   * returned a different slot count from types 0/1 for the same barber and
   * day), so they cannot simply share one entry.
   */
  AGENDA_CACHE_SERVICE_IDS: blankAsUnset(z.string().default("0,1,2")),

  /** Day offset at which the slower far-tier interval takes over. */
  AGENDA_CACHE_NEAR_DAYS: blankAsUnset(
    z.coerce.number().int().min(1).max(30).default(7),
  ),

  /** Freshness target for days 0..NEAR_DAYS-1. Mission target: 1–2 minutes. */
  AGENDA_CACHE_NEAR_TTL_MS: blankAsUnset(
    z.coerce.number().int().min(5_000).default(90_000),
  ),

  /** Freshness target for the rest of the window. Mission target: 5 minutes. */
  AGENDA_CACHE_FAR_TTL_MS: blankAsUnset(
    z.coerce.number().int().min(5_000).default(300_000),
  ),

  /**
   * TTL for a day upstream reported as having NO slots. Shorter than the
   * positive TTL on purpose: a full day is exactly where a cancellation
   * matters most, and re-asking is cheap.
   */
  AGENDA_CACHE_NEGATIVE_TTL_MS: blankAsUnset(
    z.coerce.number().int().min(5_000).default(45_000),
  ),

  /**
   * How far past its TTL an entry may still be SPOKEN while a refresh runs
   * behind the caller. This is the honest ceiling on "how stale can an offered
   * slot be" when upstream is unreachable — past it, callers wait for real
   * data instead of being told something we no longer stand behind.
   */
  AGENDA_CACHE_STALE_CEILING_MS: blankAsUnset(
    z.coerce.number().int().min(10_000).default(600_000),
  ),

  /** Per-entry TTL jitter, so entries warmed together do not expire together. */
  AGENDA_CACHE_JITTER_RATIO: blankAsUnset(
    z.coerce.number().min(0).max(0.5).default(0.2),
  ),

  /** Hard entry ceiling. 14 days × 3 services = 42; the default leaves slack. */
  AGENDA_CACHE_MAX_ENTRIES: blankAsUnset(
    z.coerce.number().int().min(1).max(5_000).default(120),
  ),

  /**
   * Where the warm-start snapshot lives. Unset = no persistence at all (the
   * cache still works; a restart simply begins cold). On the VPS this points
   * inside the container's one writable mount, next to the idempotency
   * journal.
   */
  AGENDA_CACHE_SNAPSHOT_PATH: blankAsUnset(z.string().min(1).optional()),

  /** Refuse to read or write a snapshot bigger than this. Default 8 MB. */
  AGENDA_CACHE_MAX_SNAPSHOT_BYTES: blankAsUnset(
    z.coerce.number().int().min(1_024).default(8_388_608),
  ),

  /** How often the refresher wakes up to look for due keys. */
  AGENDA_CACHE_TICK_MS: blankAsUnset(
    z.coerce.number().int().min(1_000).default(15_000),
  ),

  /** Most keys refreshed per tick, so a sweep is spread rather than bursty. */
  AGENDA_CACHE_MAX_KEYS_PER_TICK: blankAsUnset(
    z.coerce.number().int().min(1).max(200).default(8),
  ),

  /**
   * Hard ceiling on SIMULTANEOUS upstream requests across the whole process,
   * background refresher included. The mission's stated starting point is 3;
   * raising it is a decision about the salon's shared host, not a tuning knob.
   */
  UPSTREAM_MAX_CONCURRENCY: blankAsUnset(
    z.coerce.number().int().min(1).max(16).default(3),
  ),

  /** Local hour (Europe/Madrid) the quiet-hours damper starts. */
  AGENDA_CACHE_QUIET_FROM_HOUR: blankAsUnset(
    z.coerce.number().int().min(0).max(23).default(22),
  ),

  /** Local hour the quiet-hours damper ends. */
  AGENDA_CACHE_QUIET_TO_HOUR: blankAsUnset(
    z.coerce.number().int().min(0).max(23).default(8),
  ),

  /**
   * Interval multiplier while the salon is shut. `1` disables the damper and
   * roughly +55% the daily upstream call count — see
   * `estimateDailyUpstreamCalls()`, which prints the resulting number at boot.
   */
  AGENDA_CACHE_QUIET_FACTOR: blankAsUnset(
    z.coerce.number().min(1).max(60).default(6),
  ),

  /**
   * step 10C ((internal doc, not included in the template) §4)
   * caller-identity trust mode. Mirrors the house style already used for
   * ENABLE_WRITE_OPERATIONS, BOOKING_UPSTREAM_MODE and BOOKING_REMEMBER_ME:
   * the dangerous setting is always an explicit, documented opt-in, never a
   * silent default. Defaults to 'none', under which no caller identity is
   * EVER resolved, whatever headers arrive — lookup and cancellation stay
   * fail-closed. 'synthetic_test' additionally refuses to construct outside
   * NODE_ENV=test (enforced in src/callerIdentity/resolver.ts, not here).
   */
  AI_CALLER_ID_TRUST_MODE: blankAsUnset(
    z.enum(["none", "provider_header", "signed_envelope", "synthetic_test"]).default("none"),
  ),

  /**
   * A human being's out-of-band attestation that the configured voice
   * provider genuinely performs telephony caller-ID verification and
   * populates X-Ai-Verified-Caller-Id from a value the model cannot
   * influence (design §4.1). That statement cannot be verified in code, so
   * it defaults to false and setting it true additionally REQUIRES
   * AI_CALLER_ID_ATTESTATION_REF below — enforced by the superRefine at the
   * bottom of this schema. Even when true, per-operation trust (design
   * §4.1.1) still withholds this from ever being sufficient for
   * cancellation.
   */
  AI_CALLER_ID_PROVIDER_ATTESTED: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /**
   * A document, commit or dated decision naming who signed the
   * AI_CALLER_ID_PROVIDER_ATTESTED=true attestation above and when. Optional
   * on its own; required together with AI_CALLER_ID_PROVIDER_ATTESTED=true
   * by the superRefine below, so a flag representing a human signature
   * always leaves a trace of who signed.
   */
  AI_CALLER_ID_ATTESTATION_REF: blankAsUnset(z.string().optional()),

  /**
   * HMAC-SHA256 key used to verify the X-Ai-Caller-Identity-Signature
   * header in AI_CALLER_ID_TRUST_MODE=signed_envelope (design §4.3).
   * Required (and required to be at least 32 characters) only when that
   * mode is selected — enforced by the superRefine below, not by making
   * this field itself required, so every other trust mode can leave it
   * unset. Never logged.
   */
  AI_CALLER_ID_HMAC_SECRET: blankAsUnset(
    z.string().min(32, "AI_CALLER_ID_HMAC_SECRET must be at least 32 characters").optional(),
  ),

  // ══ WhatsApp confirmations (src/services/whatsapp/) ════════════════════
  //
  // Every variable below is OPTIONAL and the feature defaults to OFF. With
  // none of them set, no queue file is opened, no worker runs, and every
  // response of this middleware is byte for byte what it was before the
  // feature existed — which is the only acceptable default for something
  // bolted onto a write path that is already taking real calls.

  /**
   * - `off`     — nothing at all happens (the default).
   * - `dry_run` — the job is queued and the worker LOGS what it would send,
   *               with the phone masked, and never opens a socket. The
   *               booking answer carries no WhatsApp field, so the agent
   *               promises nothing.
   * - `live`    — the worker sends through Meta's Cloud API, and a confirmed
   *               booking answers `whatsapp_confirmation: "queued"`.
   */
  WHATSAPP_NOTIFICATIONS_MODE: blankAsUnset(
    z.enum(["off", "dry_run", "live"]).default("off"),
  ),

  /**
   * The durable queue (`src/services/whatsapp/whatsappQueueStore.ts`).
   * Required as soon as the mode is not `off` — a queue held in memory would
   * lose a customer's confirmation on any restart, silently, after the agent
   * had already promised it out loud.
   *
   * On the VPS it belongs on the same writable volume as
   * `BOOKING_IDEMPOTENCY_PATH` (`/var/lib/demo-salon/whatsapp-queue.jsonl`); the
   * rest of the container's filesystem is read-only.
   */
  WHATSAPP_QUEUE_PATH: blankAsUnset(z.string().min(1).optional()),

  /**
   * The permanent access token of the Meta system user. Required in `live`.
   * Never logged, never persisted in the queue, never included in an error
   * string — see `metaWhatsappClient.ts`.
   */
  WHATSAPP_ACCESS_TOKEN: blankAsUnset(z.string().min(1).optional()),

  /** The WhatsApp Business phone number id that sends. Required in `live`. */
  WHATSAPP_PHONE_NUMBER_ID: blankAsUnset(z.string().min(1).optional()),

  /**
   * The approved utility template. Its four named parameters are fixed.
   * Default: `plantilla_whatsapp` of `cliente.yaml` (D-012); the variable wins.
   * `""` when neither says it, which is only accepted with
   * `WHATSAPP_NOTIFICATIONS_MODE=off` (see the refinement below).
   */
  WHATSAPP_TEMPLATE_NAME: blankAsUnset(
    z
      .string()
      .min(1)
      .optional()
      .transform((value) => value ?? getClientConfig().plantilla_whatsapp ?? ""),
  ),

  /** Language code of the approved template, as Meta spells it. */
  WHATSAPP_TEMPLATE_LANGUAGE: blankAsUnset(z.string().min(1).default("es")),

  /**
   * Graph API version, pinned rather than derived: Meta deprecates versions
   * on a schedule, and discovering that through a live call is the wrong way.
   */
  WHATSAPP_GRAPH_API_VERSION: blankAsUnset(
    z
      .string()
      .regex(/^v\d+\.\d+$/, "WHATSAPP_GRAPH_API_VERSION must look like v25.0")
      .default("v25.0"),
  ),

  /**
   * Per-attempt HTTP timeout. It is NOT on any customer's critical path — the
   * send happens in a background worker — so it only bounds how long one
   * attempt occupies the worker before the backoff takes over.
   */
  WHATSAPP_SEND_TIMEOUT_MS: blankAsUnset(
    z.coerce.number().int().min(1_000).max(60_000).default(8_000),
  ),

  /**
   * *** THE TEST-NUMBER GUARD RAIL. ***
   *
   * While Meta's number is still in its test phase it may only message up to
   * five verified recipients. With this set, ANY other recipient is recorded
   * as `skipped_not_allowed` and never dialled, and the booking answer omits
   * the WhatsApp field — so the agent never promises a message that the
   * platform would refuse. Comma-separated `34XXXXXXXXX` entries; unset means
   * no restriction, which is what production posture looks like once the
   * number is approved.
   */
  WHATSAPP_ALLOWED_RECIPIENTS: blankAsUnset(z.string().optional()),

  /**
   * *** THE «AÑADIR AL CALENDARIO» LINK (src/services/whatsapp/calendarLink.ts). ***
   *
   * The approved template carries a URL button whose dynamic suffix is a
   * signed token; Graph API REFUSES a send that omits the button parameter. So
   * as soon as the mode is `dry_run` or `live` this secret and the base URL
   * are REQUIRED at boot (superRefine below) — never discovered at send time,
   * as a `failed` job the customer never hears about.
   *
   * The HMAC key of that token. Its own secret, distinct from every other one
   * here: its MACs are published inside customer-facing URLs. With it set,
   * `GET /cal/:token` and `GET /cal/:token/cita.ics` are served (public, no
   * API auth); without it those paths are a plain 404. Rotating it invalidates
   * every link already sent.
   */
  WHATSAPP_CALENDAR_LINK_SECRET: blankAsUnset(
    z
      .string()
      .min(32, "WHATSAPP_CALENDAR_LINK_SECRET must be at least 32 characters")
      .optional(),
  ),

  /**
   * Public HTTPS origin the template's button points at, e.g.
   * `https://api.booking.example.com`. The Meta button itself is registered as
   * `<this>/cal/{{1}}`; this value is what the boot log and the dry-run log
   * print, so an operator can compare the two.
   */
  WHATSAPP_CALENDAR_BASE_URL: blankAsUnset(
    z
      .string()
      .url("WHATSAPP_CALENDAR_BASE_URL must be an absolute URL, e.g. https://api.booking.example.com")
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.username === "" &&
            url.password === "" &&
            url.search === "" &&
            url.hash === ""
          );
        } catch {
          return false;
        }
      }, "WHATSAPP_CALENDAR_BASE_URL must be an https:// origin (optionally with a path), without credentials, query or fragment")
      .transform((value) => value.replace(/\/+$/, ""))
      .optional(),
  ),

  /**
   * Optional salon address shown on the page and written as the event's
   * `LOCATION`. Free text, one line. Omitted everywhere when unset.
   */
  WHATSAPP_CALENDAR_LOCATION: blankAsUnset(
    z
      .string()
      .max(200, "WHATSAPP_CALENDAR_LOCATION must be at most 200 characters")
      // eslint-disable-next-line no-control-regex
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "WHATSAPP_CALENDAR_LOCATION must be a single line of text")
      .optional(),
  ),

  // ══ WhatsApp self-service + Telegram owner notices (ADR-032) ═══════════
  //
  // Every variable below is OPTIONAL and every feature defaults to OFF. With
  // none of them set no route is registered, no client exists, no queue file
  // is opened and every voice response is byte for byte what it was before.
  // See (internal doc, not included in the template) §5.

  /** `off` | `lookup_only` | `cancel_dry_run` | `live` (DESIGN §6.3). */
  WA_SELF_SERVICE_MODE: blankAsUnset(
    z.enum(["off", "lookup_only", "cancel_dry_run", "live"]).default("off"),
  ),

  /**
   * Second secret of the `/ai/wa/*` routes (header `X-AI-WA-Secret`), on top
   * of `AI_WEBHOOK_SECRET`. Required when either feature is on. Without it the
   * routes are not registered at all (404).
   */
  WA_SELF_SERVICE_SECRET: blankAsUnset(
    z.string().min(32, "WA_SELF_SERVICE_SECRET must be at least 32 characters").optional(),
  ),

  /** Comma-separated phones allowed to really cancel in `live`. Empty = all. */
  WA_SELF_SERVICE_ALLOWLIST: blankAsUnset(z.string().optional()),

  /** AES-GCM key material of `reservation_ref`. Required when mode != off. */
  WA_REF_SECRET: blankAsUnset(
    z.string().min(32, "WA_REF_SECRET must be at least 32 characters").optional(),
  ),

  WA_REF_TTL_MINUTES: blankAsUnset(z.coerce.number().int().min(5).max(180).default(30)),

  /**
   * Inside this margin before the start a cancellation is handed to the owner
   * instead. Default 0 since 2026-10-08 (Bruno's rule): the customer can cancel
   * any future appointment up to its start time; only a started one is refused.
   */
  WA_CANCEL_MIN_LEAD_MINUTES: blankAsUnset(z.coerce.number().int().min(0).max(2880).default(0)),

  /**
   * A cancellation with fewer minutes of notice than this is flagged
   * `late_notice: true` in its result. For the owner's record only; it never
   * blocks a cancellation.
   */
  WA_LATE_CANCEL_THRESHOLD_MINUTES: blankAsUnset(
    z.coerce.number().int().min(0).max(2880).default(60),
  ),

  /**
   * 2026-10-11 (internal doc, not included in the template) — «cambiar servicio»
   * atómico: DELETE + POST of the same slot with another service, verified in
   * the agenda, rolled back on failure. `off` (default): nothing changes, the
   * routes answer `service_change_unavailable`. `dry_run`: same answer, and
   * the log says «would swap». `live` additionally needs
   * `WA_SELF_SERVICE_MODE=live` and `ENABLE_WRITE_OPERATIONS=true`. The urgent
   * notice to Bruno uses the recados bot (RECADOS_MODE), not TELEGRAM_NOTIFY_MODE.
   */
  SERVICE_CHANGE_MODE: blankAsUnset(z.enum(["off", "dry_run", "live"]).default("off")),

  /** A service change needs at least this many minutes before the start. Default 60 (project decision). */
  SERVICE_CHANGE_MIN_LEAD_MINUTES: blankAsUnset(z.coerce.number().int().min(0).max(1440).default(60)),

  /**
   * 2026-10-11 — the VOICE action `change_service` (Bloque 3 of the same doc).
   * Default `false`: the action answers `service_change_unavailable`.
   */
  VOICE_CHANGE_SERVICE_ENABLED: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  WA_LOOKUP_HORIZON_DAYS: blankAsUnset(z.coerce.number().int().min(7).max(120).default(60)),

  WA_DASHBOARD_TIMEOUT_MS: blankAsUnset(z.coerce.number().int().min(1_000).max(20_000).default(8_000)),

  /** Pin the written `ownerPhone` to the WhatsApp sender (DESIGN §7). */
  WA_BOOKING_PIN_CALLER_PHONE: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
  ),

  /**
   * A dedicated employee account. Required when mode != off, UNLESS
   * `WA_EMPLOYEE_USES_SERVICE_ACCOUNT=true`, in which case both must be unset.
   */
  BOOKING_EMPLOYEE_USERNAME: blankAsUnset(z.string().min(1).optional()),
  BOOKING_EMPLOYEE_PASSWORD: blankAsUnset(z.string().min(1).optional()),

  /**
   * ADR-032, addendum 2026-10-08 (owner decision): the employee identity of
   * `/ai/wa/*` is the booking service account itself (`BOOKING_USERNAME` /
   * `BOOKING_PASSWORD`), promoted to ROLE_EMPLOYEE in Bruno's database, instead
   * of a separate account. Explicit opt-in so the password is never copied
   * into a second variable; with it on, `BOOKING_EMPLOYEE_*` must be unset.
   * Default false = the original dedicated-account mode, unchanged.
   */
  WA_EMPLOYEE_USES_SERVICE_ACCOUNT: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /** `off` | `dry_run` | `live` (DESIGN §8). */
  TELEGRAM_NOTIFY_MODE: blankAsUnset(z.enum(["off", "dry_run", "live"]).default("off")),

  TELEGRAM_BOT_TOKEN: blankAsUnset(
    z
      .string()
      .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,}$/, "TELEGRAM_BOT_TOKEN does not look like a Telegram bot token")
      .optional(),
  ),

  TELEGRAM_CHAT_ID: blankAsUnset(
    z.string().regex(/^-?\d{1,20}$/, "TELEGRAM_CHAT_ID must be a numeric chat id").optional(),
  ),

  TELEGRAM_QUEUE_PATH: blankAsUnset(z.string().min(1).optional()),

  TELEGRAM_SEND_TIMEOUT_MS: blankAsUnset(z.coerce.number().int().min(1_000).max(60_000).default(8_000)),

  /** (internal doc, not included in the template). One-line agenda notices + morning digest. */
  TELEGRAM_NOTIFY_AGENDA_LINES: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  /** Block D only (not wired by block C). */
  TELEGRAM_NOTIFY_WA_BOOKINGS: blankAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),

  // ── Recados para Bruno ((internal doc, not included in the template) §A.3) ──────────────
  /** `off` | `dry_run` | `live`. Default off: nothing below is read, nothing changes. */
  RECADOS_MODE: blankAsUnset(z.enum(["off", "dry_run", "live"]).default("off")),

  /** The recados bot (@citas_demo_salon_bot). Required for `live`. Never logged. */
  RECADOS_BOT_TOKEN: blankAsUnset(
    z
      .string()
      .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,}$/, "RECADOS_BOT_TOKEN does not look like a Telegram bot token")
      .optional(),
  ),

  RECADOS_CHAT_ID: blankAsUnset(
    z.string().regex(/^-?\d{1,20}$/, "RECADOS_CHAT_ID must be a numeric chat id").optional(),
  ),

  /** Telegram's `secret_token` alphabet and length limit. */
  RECADOS_WEBHOOK_SECRET: blankAsUnset(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{32,256}$/, "RECADOS_WEBHOOK_SECRET must be 32-256 characters of A-Z a-z 0-9 _ -")
      .optional(),
  ),

  /** Absolute directory (0700) holding `recados.jsonl` and `horario.json`. */
  RECADOS_STATE_DIR: blankAsUnset(
    z.string().min(1).startsWith("/", "RECADOS_STATE_DIR must be an absolute path").optional(),
  ),

  /** May contain `{conversationId}`; without it the template is used as is. */
  RECADOS_VOCERO_URL_TEMPLATE: blankAsUnset(
    z.string().min(1).default("https://whatsapp.booking.example.com"),
  ),

  RECADOS_REMINDER_OPEN_MINUTES: blankAsUnset(z.coerce.number().int().min(5).max(240).default(45)),
  RECADOS_SUMMARY_BEFORE_CLOSE_MINUTES: blankAsUnset(z.coerce.number().int().min(0).max(60).default(10)),
  RECADOS_MAX_PER_PHONE_PER_HOUR: blankAsUnset(z.coerce.number().int().min(1).max(10).default(2)),
  RECADOS_MAX_PER_HOUR_GLOBAL: blankAsUnset(z.coerce.number().int().min(5).max(200).default(30)),
  RECADOS_HOURS_SERVICE_ID: blankAsUnset(
    z.string().regex(/^\d+$/, "RECADOS_HOURS_SERVICE_ID must be a numeric service id")
      // Por defecto: `calendario.servicio_por_defecto` de cliente.yaml (Demo Salon: "1"). D-007.
      .default(() => getClientConfig().calendario.servicio_por_defecto as string),
  ),
  /** Estimated length of a booking, to close the day's window on its last booking. */
  RECADOS_APPOINTMENT_MINUTES: blankAsUnset(
    // Por defecto: `duracion_cita_min` de cliente.yaml (Demo Salon: 30). D-007.
    z.coerce.number().int().min(10).max(120).default(() => getClientConfig().duracion_cita_min),
  ),
}).superRefine((env, ctx) => {
  // Fail closed at boot with a readable, NON-SECRET message: never echo the
  // value of a variable, only name which one is wrong and why.
  if (env.CALENDAR_PROVIDER === "google-calendar") {
    const given = [env.GOOGLE_SERVICE_ACCOUNT_JSON, env.GOOGLE_SERVICE_ACCOUNT_JSON_B64].filter((v) => v !== undefined);
    if (given.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
        message:
          "CALENDAR_PROVIDER=google-calendar needs exactly one of GOOGLE_SERVICE_ACCOUNT_JSON (path) or GOOGLE_SERVICE_ACCOUNT_JSON_B64",
      });
    }
  }
  if (env.AI_CALLER_ID_TRUST_MODE === "signed_envelope" && !env.AI_CALLER_ID_HMAC_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AI_CALLER_ID_HMAC_SECRET"],
      message:
        "AI_CALLER_ID_HMAC_SECRET is required (min 32 chars) when AI_CALLER_ID_TRUST_MODE=signed_envelope",
    });
  }
  // step PROD (Hito 5): modifications are permanently disabled. There is no
  // update path in this service, so a `true` here can only ever be a
  // misconfiguration or a wrong assumption about what this deployment can do.
  // Fail closed and loudly at boot rather than booting with a flag that
  // promises a capability nothing implements.
  if (env.ENABLE_UPDATE_BOOKING) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ENABLE_UPDATE_BOOKING"],
      message:
        "ENABLE_UPDATE_BOOKING must be false: modifying an existing booking is not implemented and is permanently out of scope",
    });
  }
  // step PROD (Hito 6): arming creation without durable idempotency is the
  // one configuration that can double-book a real customer, so it is refused
  // rather than warned about. Scoped to production deliberately: the risk is
  // a restart landing between a write and its retry, which only exists in a
  // long-lived deployment — a test process is created and destroyed around
  // the assertion it is making.
  if (
    env.NODE_ENV === "production" &&
    env.ENABLE_WRITE_OPERATIONS &&
    env.ENABLE_CREATE_BOOKING &&
    !env.BOOKING_IDEMPOTENCY_PATH
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["BOOKING_IDEMPOTENCY_PATH"],
      message:
        "BOOKING_IDEMPOTENCY_PATH is required in production when booking creation is armed: without it, a restart between a booking and its retry would create the same appointment twice",
    });
  }
  // step PROD (Hito 10): una ruta pública autenticada por secreto compartido
  // no puede arrancar sin el secreto. Se rechaza al arrancar en vez de
  // levantar la ruta y negar todas las peticiones, que se diagnostica como
  // "ElevenLabs dejó de funcionar" en vez de como "falta una variable".
  if (env.ENABLE_ELEVENLABS_COMPAT && !env.ELEVENLABS_COMPAT_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ELEVENLABS_COMPAT_SECRET"],
      message:
        "ELEVENLABS_COMPAT_SECRET is required (min 32 chars) when ENABLE_ELEVENLABS_COMPAT=true",
    });
  }
  // step LAT: a malformed service list would silently warm the wrong agenda
  // (or none), which shows up as "the cache never hits" long after the typo.
  if (!/^\s*\d+\s*(,\s*\d+\s*)*$/.test(env.AGENDA_CACHE_SERVICE_IDS)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AGENDA_CACHE_SERVICE_IDS"],
      message:
        "AGENDA_CACHE_SERVICE_IDS must be a comma-separated list of integer service ids, e.g. \"0,1,2\"",
    });
  }
  if (env.AGENDA_CACHE_NEAR_DAYS > env.AGENDA_CACHE_HORIZON_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AGENDA_CACHE_NEAR_DAYS"],
      message: "AGENDA_CACHE_NEAR_DAYS cannot exceed AGENDA_CACHE_HORIZON_DAYS",
    });
  }
  // The stale ceiling is what bounds how wrong a spoken slot can be. A ceiling
  // BELOW the freshness target would mean entries are unusable the moment they
  // go stale, turning every expiry into a blocking upstream call on a live
  // phone call — the opposite of what stale-while-revalidate is for.
  if (env.AGENDA_CACHE_STALE_CEILING_MS < env.AGENDA_CACHE_FAR_TTL_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AGENDA_CACHE_STALE_CEILING_MS"],
      message:
        "AGENDA_CACHE_STALE_CEILING_MS must be at least AGENDA_CACHE_FAR_TTL_MS: a ceiling below the freshness target makes every expiry a blocking upstream call",
    });
  }
  // step LAT (objective 3, separation of permissions).
  //
  // Scoped to PRODUCTION deliberately. The invariant that matters — "arming
  // creation cannot arm cancellation" — is structural, and lives in
  // `src/config/writePermissions.ts`, where create and cancel are two
  // independent ANDs sharing no boolean; `assertWritePermissionsIndependent()`
  // re-checks it against the real flags at boot. What THIS rule adds is a
  // guard on the deployed posture: on the VPS, "the voice agent may create an
  // appointment" and "the voice agent may destroy one" must never be true
  // together, because only creation is in scope for the agent at all.
  //
  // It is not applied outside production because the cancellation test suite
  // legitimately arms both to exercise the cancel path, and a schema that
  // refused that would be asserting a deployment policy as if it were a law
  // of the code.
  if (
    env.NODE_ENV === "production" &&
    env.ENABLE_WRITE_OPERATIONS &&
    env.ENABLE_CREATE_BOOKING &&
    env.ENABLE_CANCEL_BOOKING
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ENABLE_CANCEL_BOOKING"],
      message:
        "ENABLE_CANCEL_BOOKING must stay false in production while creation is armed: cancellation is out of scope for the voice agent, and arming both at once is never an intended production posture",
    });
  }
  // step LAT (objective 3): creation writes into a real customer's diary. In
  // production it must not be reachable with the same credential that merely
  // reads the agenda — a secret that travels on every call the agent makes.
  // Refused at boot rather than warned about, because the whole point of the
  // separation is that it cannot be half-applied.
  if (
    env.NODE_ENV === "production" &&
    env.ENABLE_WRITE_OPERATIONS &&
    env.ENABLE_CREATE_BOOKING &&
    !env.AI_BOOKING_WEBHOOK_SECRET
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AI_BOOKING_WEBHOOK_SECRET"],
      message:
        "AI_BOOKING_WEBHOOK_SECRET is required in production when booking creation is armed: creating an appointment must not be reachable with the same secret that only reads the agenda",
    });
  }
  // step SLOT: creation armed without the slot-token key would boot a
  // process in which `/ai/voice/book` refuses EVERY request — technically
  // fail-closed, and operationally a trap. The symptom is "the agent can
  // never book", which reads as a broken deployment rather than as a missing
  // variable, and it would be discovered by a customer on a live call.
  //
  // Refused at boot instead, and scoped to production-with-creation-armed
  // exactly like the two rules above: a lab or a test process that never
  // writes is free to run without the key and get the disabled behaviour,
  // which is what most of the suite deliberately exercises.
  if (
    env.NODE_ENV === "production" &&
    env.ENABLE_WRITE_OPERATIONS &&
    env.ENABLE_CREATE_BOOKING &&
    !env.VOICE_SLOT_TOKEN_SECRET
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["VOICE_SLOT_TOKEN_SECRET"],
      message:
        "VOICE_SLOT_TOKEN_SECRET is required in production when booking creation is armed: without it no slot token can be issued or verified, so every voice booking would be refused",
    });
  }
  // step CTL ((internal doc, not included in the template) ADR-012): the AI marker can only be carried
  // by the legacy contract's `ownerName`, a field that exists purely for
  // display. The `ai` lab contract has a single `customer.name` that is both
  // the canonical and the displayed value, so there is nowhere to put the
  // marker without corrupting the canonical name.
  //
  // Rather than let that combination quietly write UNMARKED voice bookings
  // into a real diary, it is refused at boot. Only in production, only with
  // creation actually armed, and only while a marker is configured — an
  // operator who has deliberately set an empty prefix has already said they
  // do not want one, and the lab itself is free to run in any other posture.
  if (
    env.NODE_ENV === "production" &&
    env.ENABLE_WRITE_OPERATIONS &&
    env.ENABLE_CREATE_BOOKING &&
    env.BOOKING_UPSTREAM_MODE === "ai" &&
    env.VOICE_BOOKING_DISPLAY_PREFIX.trim() !== ""
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["BOOKING_UPSTREAM_MODE"],
      message:
        "BOOKING_UPSTREAM_MODE=ai cannot be combined with armed booking creation while VOICE_BOOKING_DISPLAY_PREFIX is set: the ai contract has no display-only name field, so voice bookings would reach the agenda without the AI marker",
    });
  }
  // WhatsApp confirmations. Three rules, all of the same kind: a posture that
  // would look armed and send nothing is refused at boot, because its symptom
  // — "the customer never got the WhatsApp" — is discovered by the customer,
  // hours later, and reads as a broken integration rather than as a missing
  // variable.
  if (env.WHATSAPP_NOTIFICATIONS_MODE !== "off" && env.WHATSAPP_TEMPLATE_NAME === "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WHATSAPP_TEMPLATE_NAME"],
      message:
        "WHATSAPP_TEMPLATE_NAME (or plantilla_whatsapp in cliente.yaml) is required when WHATSAPP_NOTIFICATIONS_MODE is not \"off\": there is no default template",
    });
  }
  if (env.WHATSAPP_NOTIFICATIONS_MODE !== "off" && !env.WHATSAPP_QUEUE_PATH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WHATSAPP_QUEUE_PATH"],
      message:
        "WHATSAPP_QUEUE_PATH is required when WHATSAPP_NOTIFICATIONS_MODE is not \"off\": without a durable queue a restart would silently lose a confirmation the agent already promised out loud",
    });
  }
  if (env.WHATSAPP_NOTIFICATIONS_MODE === "live") {
    if (!env.WHATSAPP_ACCESS_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_ACCESS_TOKEN"],
        message:
          "WHATSAPP_ACCESS_TOKEN is required when WHATSAPP_NOTIFICATIONS_MODE=live: without it every confirmation would be queued and none could ever be sent",
      });
    }
    if (!env.WHATSAPP_PHONE_NUMBER_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_PHONE_NUMBER_ID"],
        message:
          "WHATSAPP_PHONE_NUMBER_ID is required when WHATSAPP_NOTIFICATIONS_MODE=live: there is no default sender",
      });
    }
  }
  // The calendar link. The approved template has a URL button with a dynamic
  // suffix, and Graph API rejects a send that omits it — so a mode that would
  // queue a message is refused at boot unless the link can be minted. In
  // `dry_run` as well: the point of that mode is to rehearse EXACTLY what
  // `live` would send.
  if (env.WHATSAPP_NOTIFICATIONS_MODE !== "off") {
    if (!env.WHATSAPP_CALENDAR_LINK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_CALENDAR_LINK_SECRET"],
        message:
          "WHATSAPP_CALENDAR_LINK_SECRET is required when WHATSAPP_NOTIFICATIONS_MODE is not \"off\": the template's «Añadir al calendario» button needs a signed link, and Meta refuses a send without it",
      });
    }
    if (!env.WHATSAPP_CALENDAR_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_CALENDAR_BASE_URL"],
        message:
          "WHATSAPP_CALENDAR_BASE_URL is required when WHATSAPP_NOTIFICATIONS_MODE is not \"off\" (e.g. https://api.booking.example.com)",
      });
    }
  }
  // Its MACs are published inside customer-facing URLs, so it must not double
  // as any other key or shared secret of this process.
  if (env.WHATSAPP_CALENDAR_LINK_SECRET !== undefined) {
    const reused = (
      [
        ["AI_WEBHOOK_SECRET", env.AI_WEBHOOK_SECRET],
        ["AI_BOOKING_WEBHOOK_SECRET", env.AI_BOOKING_WEBHOOK_SECRET],
        ["VOICE_SLOT_TOKEN_SECRET", env.VOICE_SLOT_TOKEN_SECRET],
        ["WHATSAPP_ACCESS_TOKEN", env.WHATSAPP_ACCESS_TOKEN],
      ] as const
    ).find(([, value]) => value !== undefined && value === env.WHATSAPP_CALENDAR_LINK_SECRET);
    if (reused !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_CALENDAR_LINK_SECRET"],
        message: `WHATSAPP_CALENDAR_LINK_SECRET must not reuse the value of ${reused[0]}: generate a separate secret`,
      });
    }
  }
  // A typo in the allow list is not a cosmetic problem: an entry that does not
  // parse means the recipient it was meant to authorize is silently refused,
  // which looks exactly like "WhatsApp does not work".
  if (
    env.WHATSAPP_ALLOWED_RECIPIENTS !== undefined &&
    !/^\s*\d{10,15}\s*(,\s*\d{10,15}\s*)*$/.test(env.WHATSAPP_ALLOWED_RECIPIENTS)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WHATSAPP_ALLOWED_RECIPIENTS"],
      message:
        "WHATSAPP_ALLOWED_RECIPIENTS must be a comma-separated list of recipients in Meta's shape (country code + national digits, no \"+\"), e.g. \"34600000123,34600000124\"",
    });
  }
  // ── WhatsApp self-service + Telegram owner notices (ADR-032) ──────────────
  // Same philosophy as the WHATSAPP_* rules: a posture that looks armed and
  // cannot work is refused at boot. Messages name variables, never values.
  const waOn = env.WA_SELF_SERVICE_MODE !== "off";
  const tgOn = env.TELEGRAM_NOTIFY_MODE !== "off";
  const need = (path: string, why: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${path} is required ${why}` });
  };
  const employeeIsServiceAccount = env.WA_EMPLOYEE_USES_SERVICE_ACCOUNT;
  if (waOn) {
    if (!env.WA_REF_SECRET) need("WA_REF_SECRET", "when WA_SELF_SERVICE_MODE is not \"off\"");
    if (!employeeIsServiceAccount) {
      const why = "when WA_SELF_SERVICE_MODE is not \"off\" (or set WA_EMPLOYEE_USES_SERVICE_ACCOUNT=true)";
      if (!env.BOOKING_EMPLOYEE_USERNAME) need("BOOKING_EMPLOYEE_USERNAME", why);
      if (!env.BOOKING_EMPLOYEE_PASSWORD) need("BOOKING_EMPLOYEE_PASSWORD", why);
    }
  }
  if (employeeIsServiceAccount) {
    // One identity, one place to read it from: a second copy of the
    // credentials would be ambiguous (which one wins?) and would drift.
    for (const name of ["BOOKING_EMPLOYEE_USERNAME", "BOOKING_EMPLOYEE_PASSWORD"] as const) {
      if (env[name] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} must be unset when WA_EMPLOYEE_USES_SERVICE_ACCOUNT=true: the employee identity is then BOOKING_USERNAME/BOOKING_PASSWORD`,
        });
      }
    }
    // The service account now carries ROLE_EMPLOYEE (read every customer,
    // delete any reservation). A 365-day remember-me token would carry that
    // for a year if it ever leaked.
    if (env.BOOKING_REMEMBER_ME) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BOOKING_REMEMBER_ME"],
        message:
          "BOOKING_REMEMBER_ME must be false when WA_EMPLOYEE_USES_SERVICE_ACCOUNT=true: the service account then has employee rights and must not hold a 365-day token",
      });
    }
  }
  if ((waOn || tgOn) && !env.WA_SELF_SERVICE_SECRET) {
    need("WA_SELF_SERVICE_SECRET", "when WA_SELF_SERVICE_MODE or TELEGRAM_NOTIFY_MODE is not \"off\"");
  }
  if (env.WA_SELF_SERVICE_MODE === "live" && !env.ENABLE_WRITE_OPERATIONS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WA_SELF_SERVICE_MODE"],
      message:
        "WA_SELF_SERVICE_MODE=live requires ENABLE_WRITE_OPERATIONS=true (ENABLE_CANCEL_BOOKING belongs to the voice /ai/cancel and has no effect on /ai/wa/*)",
    });
  }
  if (
    env.SERVICE_CHANGE_MODE === "live" &&
    (env.WA_SELF_SERVICE_MODE !== "live" || !env.ENABLE_WRITE_OPERATIONS || env.RECADOS_MODE !== "live")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SERVICE_CHANGE_MODE"],
      message:
        "SERVICE_CHANGE_MODE=live requires WA_SELF_SERVICE_MODE=live, ENABLE_WRITE_OPERATIONS=true and RECADOS_MODE=live (the urgent notice to the owner goes through the recados bot)",
    });
  }
  if (
    !employeeIsServiceAccount &&
    env.BOOKING_EMPLOYEE_USERNAME !== undefined &&
    env.BOOKING_EMPLOYEE_USERNAME === env.BOOKING_USERNAME
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["BOOKING_EMPLOYEE_USERNAME"],
      message:
        "BOOKING_EMPLOYEE_USERNAME must differ from BOOKING_USERNAME: to use the service account as the employee, unset BOOKING_EMPLOYEE_* and set WA_EMPLOYEE_USES_SERVICE_ACCOUNT=true",
    });
  }
  if (env.WA_SELF_SERVICE_ALLOWLIST !== undefined) {
    const badAt = findInvalidWaAllowlistEntry(env.WA_SELF_SERVICE_ALLOWLIST);
    if (badAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WA_SELF_SERVICE_ALLOWLIST"],
        message: `WA_SELF_SERVICE_ALLOWLIST entry #${badAt + 1} is not a valid Spanish phone number`,
      });
    }
  }
  const waSecretCandidates = [
    ["AI_WEBHOOK_SECRET", env.AI_WEBHOOK_SECRET],
    ["AI_BOOKING_WEBHOOK_SECRET", env.AI_BOOKING_WEBHOOK_SECRET],
    ["VOICE_SLOT_TOKEN_SECRET", env.VOICE_SLOT_TOKEN_SECRET],
    ["WHATSAPP_CALENDAR_LINK_SECRET", env.WHATSAPP_CALENDAR_LINK_SECRET],
    ["WHATSAPP_ACCESS_TOKEN", env.WHATSAPP_ACCESS_TOKEN],
    ["TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN],
    ["RECADOS_BOT_TOKEN", env.RECADOS_BOT_TOKEN],
    ["RECADOS_WEBHOOK_SECRET", env.RECADOS_WEBHOOK_SECRET],
  ] as const;
  for (const name of ["WA_REF_SECRET", "WA_SELF_SERVICE_SECRET"] as const) {
    const value = env[name];
    if (value === undefined) continue;
    const reused = waSecretCandidates.find(([, other]) => other !== undefined && other === value);
    if (reused !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: `${name} must not reuse the value of ${reused[0]}: generate a separate secret`,
      });
    }
  }
  if (
    env.WA_REF_SECRET !== undefined &&
    env.WA_SELF_SERVICE_SECRET !== undefined &&
    env.WA_REF_SECRET === env.WA_SELF_SERVICE_SECRET
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WA_REF_SECRET"],
      message: "WA_REF_SECRET must not reuse the value of WA_SELF_SERVICE_SECRET: generate a separate secret",
    });
  }
  // ── Recados para Bruno ────────────────────────────────────────────────────
  const recadosOn = env.RECADOS_MODE !== "off";
  if (recadosOn && !env.RECADOS_STATE_DIR) {
    need("RECADOS_STATE_DIR", "when RECADOS_MODE is not \"off\": a recado held in memory would be lost on restart");
  }
  if (env.RECADOS_MODE === "live") {
    if (!env.RECADOS_BOT_TOKEN) need("RECADOS_BOT_TOKEN", "when RECADOS_MODE=live");
    if (!env.RECADOS_CHAT_ID) need("RECADOS_CHAT_ID", "when RECADOS_MODE=live");
    if (!env.RECADOS_WEBHOOK_SECRET) need("RECADOS_WEBHOOK_SECRET", "when RECADOS_MODE=live");
  }
  if (recadosOn && (env.TELEGRAM_BOT_TOKEN !== undefined || env.TELEGRAM_CHAT_ID !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["TELEGRAM_BOT_TOKEN"],
      message:
        "with RECADOS_MODE on, owner notices use the recados bot: unset TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID",
    });
  }
  if (env.RECADOS_WEBHOOK_SECRET !== undefined) {
    const others = [
      ...waSecretCandidates.filter(([name]) => name !== "RECADOS_WEBHOOK_SECRET"),
      ["WA_REF_SECRET", env.WA_REF_SECRET],
      ["WA_SELF_SERVICE_SECRET", env.WA_SELF_SERVICE_SECRET],
    ] as const;
    const reused = others.find(([, other]) => other !== undefined && other === env.RECADOS_WEBHOOK_SECRET);
    if (reused !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RECADOS_WEBHOOK_SECRET"],
        message: `RECADOS_WEBHOOK_SECRET must not reuse the value of ${reused[0]}: generate a separate secret`,
      });
    }
  }
  {
    const template = env.RECADOS_VOCERO_URL_TEMPLATE;
    const hasBraces = /[{}]/.test(template);
    const placeholderOk = template.split("{conversationId}").length === 2 && !/[{}]/.test(template.replace("{conversationId}", ""));
    if (!template.startsWith("https://") || (hasBraces && !placeholderOk)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RECADOS_VOCERO_URL_TEMPLATE"],
        message:
          "RECADOS_VOCERO_URL_TEMPLATE must start with https:// and, if it has a placeholder, contain exactly one {conversationId}",
      });
    }
  }
  if (tgOn && !env.TELEGRAM_QUEUE_PATH) {
    need("TELEGRAM_QUEUE_PATH", "when TELEGRAM_NOTIFY_MODE is not \"off\": a notice held in memory would be lost on restart");
  }
  if (env.TELEGRAM_NOTIFY_MODE === "live" && env.RECADOS_MODE !== "live") {
    // With recados on, the notices use the recados bot (RECADOS_BOT_TOKEN / RECADOS_CHAT_ID).
    if (!env.TELEGRAM_BOT_TOKEN) need("TELEGRAM_BOT_TOKEN", "when TELEGRAM_NOTIFY_MODE=live");
    if (!env.TELEGRAM_CHAT_ID) need("TELEGRAM_CHAT_ID", "when TELEGRAM_NOTIFY_MODE=live");
  }
  if (env.AI_CALLER_ID_PROVIDER_ATTESTED && !env.AI_CALLER_ID_ATTESTATION_REF) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AI_CALLER_ID_ATTESTATION_REF"],
      message:
        "AI_CALLER_ID_ATTESTATION_REF is required when AI_CALLER_ID_PROVIDER_ATTESTED=true (name who attested it and when)",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/** Who `/ai/wa/*` reads the dashboard and deletes as (ADR-032). */
export interface WaEmployeeCredentials {
  username: string;
  password: string;
  /** For the boot log only; never a value. */
  source: "service_account" | "dedicated_account";
}

/**
 * The ONLY place that decides which credentials the WhatsApp employee client
 * logs in with. `undefined` when none are configured (the WA service then
 * answers `self_service_off`). The schema above already guarantees the two
 * modes cannot be mixed.
 */
export function resolveWaEmployeeCredentials(env: Env): WaEmployeeCredentials | undefined {
  if (env.WA_EMPLOYEE_USES_SERVICE_ACCOUNT) {
    return { username: env.BOOKING_USERNAME, password: env.BOOKING_PASSWORD, source: "service_account" };
  }
  if (env.BOOKING_EMPLOYEE_USERNAME !== undefined && env.BOOKING_EMPLOYEE_PASSWORD !== undefined) {
    return {
      username: env.BOOKING_EMPLOYEE_USERNAME,
      password: env.BOOKING_EMPLOYEE_PASSWORD,
      source: "dedicated_account",
    };
  }
  return undefined;
}

let cached: Env | null = null;

/**
 * BOOKING_USERNAME/BOOKING_PASSWORD are the service credentials of a
 * credential-based backend adapter. Neither bundled adapter (`memory`,
 * `google-calendar`) logs in with them, so a blank/unset pair gets a
 * placeholder that is never sent anywhere (D-014). Applied to a copy;
 * `process.env` is not touched. A custom REST adapter should make them
 * required again.
 */
const UNUSED_WITH_GOOGLE = "(sin uso con este proveedor)";
function providerAwareInput(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...raw };
  for (const key of ["BOOKING_USERNAME", "BOOKING_PASSWORD"] as const) {
    if (out[key] === undefined || out[key]!.trim() === "") out[key] = UNUSED_WITH_GOOGLE;
  }
  return out;
}

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(providerAwareInput(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Never print values — only which keys are wrong.
    throw new Error(
      `Invalid environment configuration. Fix these variables:\n${issues}`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: reset the memoized env so tests can re-load with new values. */
/**
 * The marker string actually handed to the write path: the configured token
 * plus the configured separator, composed in ONE place so no caller can
 * assemble it differently.
 *
 * An empty token still means "no marker" — the separator alone never marks
 * anything, and `applyBookingDisplayPrefix` discards a whitespace-only
 * marker, so `VOICE_BOOKING_DISPLAY_PREFIX=` remains the way to turn the
 * feature off.
 */
export function bookingDisplayPrefix(env: Env): string {
  if (env.VOICE_BOOKING_DISPLAY_PREFIX.trim() === "") return "";
  return env.VOICE_BOOKING_DISPLAY_SEPARATOR === "space"
    ? `${env.VOICE_BOOKING_DISPLAY_PREFIX} `
    : env.VOICE_BOOKING_DISPLAY_PREFIX;
}

export function resetEnvCache(): void {
  cached = null;
}
