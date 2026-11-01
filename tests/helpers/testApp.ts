import nock from "nock";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { resetMemoryEmulator } from "../../src/adapters/calendar/memory/index.js";

export const WEBHOOK_SECRET = "test-secret-abcdef123456";

/**
 * step SLOT — the slot-token key every test runs with.
 *
 * Set in the baseline env rather than per-test, because the ARMED posture is
 * the one production will have and the one nearly every existing assertion
 * implicitly depends on: without it `/ai/voice/book` refuses before it can
 * reach `write_disabled`, `slot_taken` or anything else worth asserting. The
 * disabled posture is exercised deliberately, by the tests that clear it.
 *
 * Longer than 32 characters (the schema minimum) and obviously synthetic.
 */
export const SLOT_TOKEN_SECRET =
  "test-slot-token-secret-0123456789abcdef";

/** Base env used by tests; override per test as needed. */
export function testEnv(overrides: Record<string, string> = {}): void {
  const base: Record<string, string> = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    CALENDAR_PROVIDER: "memory",
    BOOKING_USERNAME: "service-account",
    BOOKING_PASSWORD: "not-a-real-password",
    BOOKING_DEFAULT_EMPLOYEE_ID: "1",
    BOOKING_DEFAULT_TYPE_RESERVATION: "1",
    AI_WEBHOOK_SECRET: WEBHOOK_SECRET,
    // step SLOT: armed by default, matching the production posture. A test
    // that wants the disabled behaviour passes
    // `{ VOICE_SLOT_TOKEN_SECRET: "" }` — `blankAsUnset` turns the empty
    // string back into "not configured".
    VOICE_SLOT_TOKEN_SECRET: SLOT_TOKEN_SECRET,
    ENABLE_WRITE_OPERATIONS: "false",
    // step PROD (Hito 5): stated explicitly, not left to the schema default,
    // so this helper's baseline visibly MATCHES the production posture — a
    // test that wants a write must ask for the master switch AND the specific
    // per-operation permission, exactly as production would have to.
    ENABLE_CREATE_BOOKING: "false",
    ENABLE_CANCEL_BOOKING: "false",
    ENABLE_UPDATE_BOOKING: "false",
    ENABLE_MULTI_BARBER: "false",
    // 2026-10-08 early close (Saturday from 14:00) is OFF for the generic
    // fixtures, which use arbitrary weekdays; tests of the feature override it.
    BALANCED_EARLY_CLOSE: "",
  };
  // Clear any previously set optional keys to avoid cross-test leakage.
  for (const k of [
    "BOOKING_DEFAULT_OWNER_ID",
    "BOOKING_DEFAULT_OWNER_NAME",
    "BOOKING_DEFAULT_OWNER_SURNAMES",
    // step CTL-3: decides whether an `owner` is sent upstream at all. Left
    // over from one test it would silently change the NEXT test's payload —
    // including the tests that assert the service account IS or IS NOT
    // attached.
    "BOOKING_BOOKING_OWNER_MODE",
    // step PROD (Hito 6): a durable idempotency file left over from one test
    // would silently make the NEXT test's bookings replay from disk.
    "BOOKING_IDEMPOTENCY_PATH",
    // step PROD (Hito 10): left over from one test, these would keep the
    // ElevenLabs compat route REGISTERED in the next one — so a test asserting
    // that the route does not exist when the flag is off would pass or fail
    // depending on which tests ran before it.
    "ENABLE_ELEVENLABS_COMPAT",
    "ELEVENLABS_COMPAT_SECRET",
    "ELEVENLABS_COMPAT_HORIZON_DAYS",
    // step LAT: left over from one test, a cache setting would silently
    // change the NEXT test's upstream call count — which is exactly what the
    // latency tests assert on. Worse, a stale HORIZON/NEAR pair fails the
    // schema's own consistency check and the failure reads as "the cache is
    // broken" rather than "the previous test leaked".
    "AI_BOOKING_WEBHOOK_SECRET",
    // step SLOT: a TTL left over from the expiry tests would silently change
    // how long the NEXT test's tokens live. The secret itself is re-set from
    // `base` below on every call, so only the TTL needs clearing.
    "VOICE_SLOT_TOKEN_TTL_SECONDS",
    // step OFFER: the offer store's own bounds. A tiny TTL or a one-entry
    // ceiling left over from the eviction tests would silently make the NEXT
    // test's offers disappear between availability and booking.
    "VOICE_OFFER_TTL_SECONDS",
    "VOICE_OFFER_MAX_ENTRIES",
    // step CTL: this one has a NON-EMPTY default ("IA -"), so a value left
    // over from a test that set it would silently change what the NEXT test
    // sees written as `ownerName` — including tests that assert the marker is
    // absent for /ai/book.
    "VOICE_BOOKING_DISPLAY_PREFIX",
    // step CTL-4: same reasoning, and the same non-empty default ("space").
    // The separator is half of the composed marker, so leaking it flips
    // `IA - Jorge` to `IA -Jorge` in whatever test runs next.
    "VOICE_BOOKING_DISPLAY_SEPARATOR",
    "ENABLE_AGENDA_CACHE",
    "AGENDA_CACHE_HORIZON_DAYS",
    "AGENDA_CACHE_SERVICE_IDS",
    "AGENDA_CACHE_NEAR_DAYS",
    "AGENDA_CACHE_NEAR_TTL_MS",
    "AGENDA_CACHE_FAR_TTL_MS",
    "AGENDA_CACHE_NEGATIVE_TTL_MS",
    "AGENDA_CACHE_STALE_CEILING_MS",
    "AGENDA_CACHE_JITTER_RATIO",
    "AGENDA_CACHE_MAX_ENTRIES",
    "AGENDA_CACHE_SNAPSHOT_PATH",
    "AGENDA_CACHE_TICK_MS",
    "AGENDA_CACHE_MAX_KEYS_PER_TICK",
    "AGENDA_CACHE_QUIET_FROM_HOUR",
    "AGENDA_CACHE_QUIET_TO_HOUR",
    "AGENDA_CACHE_QUIET_FACTOR",
    "UPSTREAM_MAX_CONCURRENCY",
    // step CTL-3: the uncertain-write tests shorten it deliberately; leaked
    // into the next test it would turn a normal upstream call into a timeout.
    "UPSTREAM_TIMEOUT_MS",
    // The salon's static weekly closure also has a NON-EMPTY default ("0,1").
    // Left over from one test, it would silently make the NEXT test's window
    // skip Sunday/Monday even though that test never asked for the feature —
    // exactly the failure mode `days_checked` assertions in unrelated scan
    // tests are written to catch.
    "BALANCED_CLOSED_WEEKDAYS",
    "BALANCED_EARLY_CLOSE",
    "WA_LATE_CANCEL_THRESHOLD_MINUTES",
    // V5 (ADR-025): left over from one test, a kill switch or a lower limit
    // would silently change what the NEXT test's V5 requests are allowed.
    "BALANCED_V5_ENABLED",
    "BALANCED_V5_MAX_BOOKINGS_PER_CALL",
    // WhatsApp confirmations: the feature is OFF by default and every test
    // that wants it says so. Left over from one test, the mode would open a
    // queue file (and a worker) in the NEXT one, and the live mode would add
    // `whatsapp_confirmation` to booking answers whose exact shape other
    // tests assert.
    "WHATSAPP_NOTIFICATIONS_MODE",
    "WHATSAPP_QUEUE_PATH",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_TEMPLATE_NAME",
    "WHATSAPP_TEMPLATE_LANGUAGE",
    "WHATSAPP_GRAPH_API_VERSION",
    "WHATSAPP_SEND_TIMEOUT_MS",
    "WHATSAPP_ALLOWED_RECIPIENTS",
    // Left over from one test, the secret would keep `/cal/*` REGISTERED in
    // the next one.
    "WHATSAPP_CALENDAR_LINK_SECRET",
    "WHATSAPP_CALENDAR_BASE_URL",
    "WHATSAPP_CALENDAR_LOCATION",
    // ADR-032: WhatsApp self-service + Telegram notices. Left over from one
    // test, a secret would keep `/ai/wa/*` registered (and a mode would open
    // a queue file / second login) in the next one.
    "WA_SELF_SERVICE_MODE",
    "WA_SELF_SERVICE_SECRET",
    "WA_SELF_SERVICE_ALLOWLIST",
    "WA_REF_SECRET",
    "WA_REF_TTL_MINUTES",
    "WA_CANCEL_MIN_LEAD_MINUTES",
    "WA_LOOKUP_HORIZON_DAYS",
    "WA_DASHBOARD_TIMEOUT_MS",
    "WA_BOOKING_PIN_CALLER_PHONE",
    "BOOKING_EMPLOYEE_USERNAME",
    "BOOKING_EMPLOYEE_PASSWORD",
    "WA_EMPLOYEE_USES_SERVICE_ACCOUNT",
    "TELEGRAM_NOTIFY_MODE",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_QUEUE_PATH",
    "TELEGRAM_SEND_TIMEOUT_MS",
    "TELEGRAM_NOTIFY_WA_BOOKINGS",
    "VOICE_MANAGE_BOOKINGS_ENABLED",
    // Recados para Bruno: left over, the mode would register the three routes
    // and open a store in the NEXT test.
    "RECADOS_MODE",
    "RECADOS_BOT_TOKEN",
    "RECADOS_CHAT_ID",
    "RECADOS_WEBHOOK_SECRET",
    "RECADOS_STATE_DIR",
    "RECADOS_VOCERO_URL_TEMPLATE",
    "RECADOS_REMINDER_OPEN_MINUTES",
    "RECADOS_SUMMARY_BEFORE_CLOSE_MINUTES",
    "RECADOS_MAX_PER_PHONE_PER_HOUR",
    "RECADOS_MAX_PER_HOUR_GLOBAL",
    "RECADOS_HOURS_SERVICE_ID",
    "RECADOS_APPOINTMENT_MINUTES",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, base, overrides);
  resetEnvCache();
  resetMemoryEmulator();
}

/** Build an app instance from current process.env. */
export async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp(loadEnv());
}

export { nock };
