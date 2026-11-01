import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bookingDisplayPrefix, loadEnv, resetEnvCache } from "../src/config/env.js";
import { applyBookingDisplayPrefix } from "../src/utils/displayName.js";

const FAKE_SECRET = "x".repeat(32);

/** Minimal set of required env vars, using obviously-fake placeholder values. */
const REQUIRED_ENV: Record<string, string> = {
  BOOKING_USERNAME: "test-user",
  BOOKING_PASSWORD: "test-pass",
  AI_WEBHOOK_SECRET: FAKE_SECRET,
};

const MANAGED_KEYS = [
  "NODE_ENV",
  "PORT",
  "HOST",
  "LOG_LEVEL",
  "BOOKING_API_BASE_URL",
  "BOOKING_USERNAME",
  "BOOKING_PASSWORD",
  "BOOKING_REMEMBER_ME",
  "BOOKING_DEFAULT_EMPLOYEE_ID",
  "BOOKING_DEFAULT_TYPE_RESERVATION",
  "BOOKING_DEFAULT_OWNER_ID",
  "BOOKING_DEFAULT_OWNER_NAME",
  "BOOKING_DEFAULT_OWNER_SURNAMES",
  "AI_WEBHOOK_SECRET",
  "UPSTREAM_TIMEOUT_MS",
  "BALANCED_BOOK_DEADLINE_MS",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_WINDOW",
  "DEFAULT_MAX_SLOTS",
  "ENABLE_WRITE_OPERATIONS",
  "ENABLE_MULTI_BARBER",
  "ELEVENLABS_AGENT_ID",
  "RETELL_AGENT_ID",
  "ENABLE_CREATE_BOOKING",
  "ENABLE_CANCEL_BOOKING",
  "ENABLE_UPDATE_BOOKING",
  "BOOKING_IDEMPOTENCY_PATH",
  "AI_BOOKING_WEBHOOK_SECRET",
  "BOOKING_UPSTREAM_MODE",
  "VOICE_BOOKING_DISPLAY_PREFIX",
  "VOICE_BOOKING_DISPLAY_SEPARATOR",
  // step SLOT: cleared between cases like every other managed key, so a
  // posture that must be refused for LACKING it cannot pass because an
  // earlier test left one behind.
  "VOICE_SLOT_TOKEN_SECRET",
  "VOICE_SLOT_TOKEN_TTL_SECONDS",
  // step OFFER: same reason — a bound left behind changes what the next
  // posture under test actually builds.
  "VOICE_OFFER_TTL_SECONDS",
  "VOICE_OFFER_MAX_ENTRIES",
  "BALANCED_CLOSED_WEEKDAYS",
];

let savedEnv: Record<string, string | undefined>;

describe("env schema — blank values", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of MANAGED_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvCache();
  });

  afterEach(() => {
    for (const k of MANAGED_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetEnvCache();
  });

  it("a blank BOOKING_DEFAULT_OWNER_ID boots successfully and yields undefined", () => {
    process.env.BOOKING_DEFAULT_OWNER_ID = "";
    const env = loadEnv();
    expect(env.BOOKING_DEFAULT_OWNER_ID).toBeUndefined();
  });

  it("a valid BOOKING_DEFAULT_OWNER_ID still yields the number", () => {
    process.env.BOOKING_DEFAULT_OWNER_ID = "123";
    const env = loadEnv();
    expect(env.BOOKING_DEFAULT_OWNER_ID).toBe(123);
  });

  it("a blank ENABLE_WRITE_OPERATIONS yields false (safety-critical default)", () => {
    process.env.ENABLE_WRITE_OPERATIONS = "";
    const env = loadEnv();
    expect(env.ENABLE_WRITE_OPERATIONS).toBe(false);
  });

  it("a blank ENABLE_MULTI_BARBER yields false", () => {
    process.env.ENABLE_MULTI_BARBER = "";
    const env = loadEnv();
    expect(env.ENABLE_MULTI_BARBER).toBe(false);
  });

  it("the default BALANCED_CLOSED_WEEKDAYS is domingo y lunes (0, 1)", () => {
    delete process.env.BALANCED_CLOSED_WEEKDAYS;
    const env = loadEnv();
    expect(env.BALANCED_CLOSED_WEEKDAYS).toEqual(new Set([0, 1]));
  });

  it("BALANCED_CLOSED_WEEKDAYS='0' yields only Sunday", () => {
    process.env.BALANCED_CLOSED_WEEKDAYS = "0";
    const env = loadEnv();
    expect(env.BALANCED_CLOSED_WEEKDAYS).toEqual(new Set([0]));
  });

  it("a blank BALANCED_CLOSED_WEEKDAYS falls back to the default", () => {
    process.env.BALANCED_CLOSED_WEEKDAYS = "";
    const env = loadEnv();
    expect(env.BALANCED_CLOSED_WEEKDAYS).toEqual(new Set([0, 1]));
  });

  // These three assert the field's OWN validation message, not merely "it
  // threw". Wrapping a required secret in blankAsUnset would turn a blank
  // value into `undefined` and produce zod's generic "Required" instead, so
  // matching the specific message is what actually pins the fail-closed
  // property. A bare .toThrow() would pass either way.
  it("a blank AI_WEBHOOK_SECRET still throws (fails closed)", () => {
    process.env.AI_WEBHOOK_SECRET = "";
    expect(() => loadEnv()).toThrow(/at least 16 characters/);
  });



  it("a blank PORT falls back to the documented default (3000)", () => {
    process.env.PORT = "";
    const env = loadEnv();
    expect(env.PORT).toBe(3000);
  });

  it("the default BALANCED_BOOK_DEADLINE_MS is 6000", () => {
    delete process.env.BALANCED_BOOK_DEADLINE_MS;
    const env = loadEnv();
    expect(env.BALANCED_BOOK_DEADLINE_MS).toBe(6000);
  });

  it("BALANCED_BOOK_DEADLINE_MS can be overridden", () => {
    process.env.BALANCED_BOOK_DEADLINE_MS = "1500";
    const env = loadEnv();
    expect(env.BALANCED_BOOK_DEADLINE_MS).toBe(1500);
  });

  it("a blank BALANCED_BOOK_DEADLINE_MS falls back to the default", () => {
    process.env.BALANCED_BOOK_DEADLINE_MS = "";
    const env = loadEnv();
    expect(env.BALANCED_BOOK_DEADLINE_MS).toBe(6000);
  });

  it("the thrown error message never contains the secret value", () => {
    process.env.AI_WEBHOOK_SECRET = "";
    let message = "";
    try {
      loadEnv();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(FAKE_SECRET);
  });
});

/**
 * step CTL — the agenda-visible AI marker ((internal doc, not included in the template) ADR-012).
 *
 * These tests pin the two schema decisions that make the marker a SAFETY
 * property rather than a formatting preference: it is on unless someone turns
 * it off, and a posture in which it could not be applied does not boot.
 */
describe("env schema — the AI marker", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of MANAGED_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  });

  it("defaults to 'IA -' when the variable is absent entirely", () => {
    // Deliberately the opposite default to every other switch in the schema.
    // Absence of the marker is a false statement to whoever reads the diary,
    // so absence of the VARIABLE must not produce it.
    expect(loadEnv().VOICE_BOOKING_DISPLAY_PREFIX).toBe("IA -");
  });

  it("composes the EXACT observable marker 'IA - ' from its defaults alone", () => {
    // step CTL-4. The requirement is one string — `IA - Nombre Apellidos` —
    // and it must survive an operator who sets nothing at all.
    expect(bookingDisplayPrefix(loadEnv())).toBe("IA - ");
    expect(applyBookingDisplayPrefix("Jorge", bookingDisplayPrefix(loadEnv()))).toBe("IA - Jorge");
  });

  it("does not depend on a trailing space surviving the .env file", () => {
    // The defect this field exists to remove: `VOICE_BOOKING_DISPLAY_PREFIX`
    // was "IA - " on paper and "IA-" in the deployed process, because a
    // trailing space is stripped by dotenv, by editors and by copy-paste,
    // and the symptom ("IA -Jorge") reads as cosmetic. Here the token is
    // written WITHOUT any trailing space and the correct marker still comes
    // out, because the separator is a choice rather than a character.
    process.env.VOICE_BOOKING_DISPLAY_PREFIX = "IA -";
    resetEnvCache();
    expect(bookingDisplayPrefix(loadEnv())).toBe("IA - ");
  });

  it("composes the same marker even if a stray trailing space DID survive", () => {
    // Robust in both directions: a value that kept its space must not
    // compose to a double space.
    process.env.VOICE_BOOKING_DISPLAY_PREFIX = "IA - ";
    resetEnvCache();
    expect(applyBookingDisplayPrefix("Jorge", bookingDisplayPrefix(loadEnv()))).toBe("IA - Jorge");
  });

  it("joins with nothing when the separator says 'none'", () => {
    process.env.VOICE_BOOKING_DISPLAY_PREFIX = "BOT/";
    process.env.VOICE_BOOKING_DISPLAY_SEPARATOR = "none";
    resetEnvCache();
    expect(bookingDisplayPrefix(loadEnv())).toBe("BOT/");
    expect(applyBookingDisplayPrefix("Jorge", bookingDisplayPrefix(loadEnv()))).toBe("BOT/Jorge");
  });

  it("defaults the separator to 'space', so losing the variable cannot mangle the diary", () => {
    expect(loadEnv().VOICE_BOOKING_DISPLAY_SEPARATOR).toBe("space");
  });

  it("keeps an explicitly blank marker OFF — the separator alone never marks anything", () => {
    process.env.VOICE_BOOKING_DISPLAY_PREFIX = "";
    resetEnvCache();
    expect(bookingDisplayPrefix(loadEnv())).toBe("");
    expect(applyBookingDisplayPrefix("Jorge", bookingDisplayPrefix(loadEnv()))).toBe("Jorge");
  });

  it("treats an explicitly blank value as 'no marker', not as 'use the default'", () => {
    // This field is deliberately NOT wrapped in blankAsUnset(): disabling the
    // marker has to be expressible, and `VOICE_BOOKING_DISPLAY_PREFIX=` is how.
    process.env.VOICE_BOOKING_DISPLAY_PREFIX = "";
    resetEnvCache();
    expect(loadEnv().VOICE_BOOKING_DISPLAY_PREFIX).toBe("");
  });

  it("accepts a custom marker", () => {
    process.env.VOICE_BOOKING_DISPLAY_PREFIX = "BOT/";
    resetEnvCache();
    expect(loadEnv().VOICE_BOOKING_DISPLAY_PREFIX).toBe("BOT/");
  });

  it("refuses a marker long enough to swallow the name it prefixes", () => {
    process.env.VOICE_BOOKING_DISPLAY_PREFIX = "x".repeat(17);
    resetEnvCache();
    expect(() => loadEnv()).toThrow(/VOICE_BOOKING_DISPLAY_PREFIX/);
  });

  it("refuses to boot production with creation armed in ai upstream mode, where the marker cannot be applied", () => {
    // The `ai` contract has a single `customer.name` that is both canonical
    // and displayed, so there is nowhere to put the marker without corrupting
    // the canonical value. Rather than write UNMARKED voice bookings into a
    // real diary, that posture is refused at boot.
    Object.assign(process.env, {
      NODE_ENV: "production",
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "true",
      BOOKING_UPSTREAM_MODE: "ai",
      BOOKING_IDEMPOTENCY_PATH: "/tmp/idem.jsonl",
      AI_BOOKING_WEBHOOK_SECRET: "y".repeat(32),
    });
    resetEnvCache();
    expect(() => loadEnv()).toThrow(/BOOKING_UPSTREAM_MODE/);
  });

  it("allows that same posture once the operator has explicitly disabled the marker", () => {
    // An operator who set an empty prefix has already said they do not want a
    // marker; the guard exists to stop it going missing by accident, not to
    // forbid a deliberate choice.
    Object.assign(process.env, {
      NODE_ENV: "production",
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "true",
      BOOKING_UPSTREAM_MODE: "ai",
      VOICE_BOOKING_DISPLAY_PREFIX: "",
      BOOKING_IDEMPOTENCY_PATH: "/tmp/idem.jsonl",
      AI_BOOKING_WEBHOOK_SECRET: "y".repeat(32),
      // step SLOT: armed creation in production also requires the key that
      // seals slot tokens — see the dedicated block below.
      VOICE_SLOT_TOKEN_SECRET: "z".repeat(32),
    });
    resetEnvCache();
    expect(() => loadEnv()).not.toThrow();
  });

  it("leaves the legacy production posture — the one being deployed — bootable", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "true",
      ENABLE_CANCEL_BOOKING: "false",
      ENABLE_UPDATE_BOOKING: "false",
      BOOKING_IDEMPOTENCY_PATH: "/tmp/idem.jsonl",
      AI_BOOKING_WEBHOOK_SECRET: "y".repeat(32),
      VOICE_SLOT_TOKEN_SECRET: "z".repeat(32),
    });
    resetEnvCache();
    const env = loadEnv();
    expect(env.VOICE_BOOKING_DISPLAY_PREFIX).toBe("IA -");
    expect(bookingDisplayPrefix(env)).toBe("IA - ");
    expect(env.BOOKING_UPSTREAM_MODE).toBe("legacy");
  });
});

import { testEnv } from "./helpers/testApp.js";

describe("RECADOS_* env", () => {
  const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const SECRET = "t".repeat(40);
  const LIVE = { RECADOS_MODE: "live", RECADOS_BOT_TOKEN: TOKEN, RECADOS_CHAT_ID: "123", RECADOS_WEBHOOK_SECRET: SECRET, RECADOS_STATE_DIR: "/var/lib/demo-salon/recados" };
  const fail = (o: Record<string, string>): string => {
    testEnv(o);
    try {
      loadEnv();
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected throw");
  };
  afterEach(() => resetEnvCache());

  it("defaults: off, and nothing else needed", () => {
    testEnv();
    const env = loadEnv();
    expect(env.RECADOS_MODE).toBe("off");
    expect(env.RECADOS_REMINDER_OPEN_MINUTES).toBe(45);
    expect(env.RECADOS_MAX_PER_PHONE_PER_HOUR).toBe(2);
    expect(env.RECADOS_VOCERO_URL_TEMPLATE).toBe("https://whatsapp.booking.example.com");
  });

  it("dry_run needs the state dir; live needs token, chat and secret", () => {
    expect(fail({ RECADOS_MODE: "dry_run" })).toContain("RECADOS_STATE_DIR is required");
    const m = fail({ RECADOS_MODE: "live", RECADOS_STATE_DIR: "/x" });
    for (const k of ["RECADOS_BOT_TOKEN", "RECADOS_CHAT_ID", "RECADOS_WEBHOOK_SECRET"]) expect(m).toContain(`${k} is required`);
    testEnv(LIVE);
    expect(loadEnv().RECADOS_MODE).toBe("live");
  });

  it("validations: secret alphabet, relative dir, ranges, URL template", () => {
    expect(fail({ ...LIVE, RECADOS_WEBHOOK_SECRET: "short" })).toContain("RECADOS_WEBHOOK_SECRET");
    expect(fail({ ...LIVE, RECADOS_STATE_DIR: "rel/dir" })).toContain("absolute");
    expect(fail({ ...LIVE, RECADOS_REMINDER_OPEN_MINUTES: "4" })).toContain("RECADOS_REMINDER_OPEN_MINUTES");
    expect(fail({ ...LIVE, RECADOS_MAX_PER_PHONE_PER_HOUR: "11" })).toContain("RECADOS_MAX_PER_PHONE_PER_HOUR");
    expect(fail({ ...LIVE, RECADOS_VOCERO_URL_TEMPLATE: "http://x" })).toContain("RECADOS_VOCERO_URL_TEMPLATE");
    expect(fail({ ...LIVE, RECADOS_VOCERO_URL_TEMPLATE: "https://x/{other}" })).toContain("RECADOS_VOCERO_URL_TEMPLATE");
    testEnv({ ...LIVE, RECADOS_VOCERO_URL_TEMPLATE: "https://x/c/{conversationId}" });
    expect(loadEnv().RECADOS_VOCERO_URL_TEMPLATE).toContain("{conversationId}");
  });

  it("RECADOS on + TELEGRAM_BOT_TOKEN defined → error; with it unset, TELEGRAM_NOTIFY_MODE=live needs no own token", () => {
    expect(fail({ ...LIVE, TELEGRAM_BOT_TOKEN: TOKEN })).toContain("unset TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
    expect(fail({ ...LIVE, TELEGRAM_CHAT_ID: "5" })).toContain("unset TELEGRAM_BOT_TOKEN");
    testEnv({ ...LIVE, TELEGRAM_NOTIFY_MODE: "live", TELEGRAM_QUEUE_PATH: "/q", WA_SELF_SERVICE_SECRET: "w".repeat(40) });
    expect(loadEnv().TELEGRAM_NOTIFY_MODE).toBe("live");
    expect(fail({ TELEGRAM_NOTIFY_MODE: "live", TELEGRAM_QUEUE_PATH: "/q", WA_SELF_SERVICE_SECRET: "w".repeat(40) })).toContain("TELEGRAM_BOT_TOKEN is required");
  });

  it("with RECADOS_MODE=dry_run the TELEGRAM_NOTIFY_MODE=live rule is NOT relaxed", () => {
    const dry = { RECADOS_MODE: "dry_run", RECADOS_STATE_DIR: "/x", TELEGRAM_NOTIFY_MODE: "live", TELEGRAM_QUEUE_PATH: "/q", WA_SELF_SERVICE_SECRET: "w".repeat(40) };
    expect(fail(dry)).toContain("TELEGRAM_BOT_TOKEN is required");
  });

  it("secret reuse: the webhook secret cannot equal another secret, nor can WA secrets equal it", () => {
    expect(fail({ ...LIVE, RECADOS_WEBHOOK_SECRET: "x".repeat(32), AI_WEBHOOK_SECRET: "x".repeat(32) })).toContain("must not reuse");
    expect(fail({ ...LIVE, WA_SELF_SERVICE_SECRET: SECRET })).toContain("must not reuse the value of RECADOS_WEBHOOK_SECRET");
    expect(fail({ ...LIVE, WA_SELF_SERVICE_SECRET: "w".repeat(40), WA_REF_SECRET: SECRET })).toContain("must not reuse");
  });
});
