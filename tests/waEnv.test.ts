import { describe, it, expect, afterEach } from "vitest";
import { loadEnv, parseWaAllowlist, resetEnvCache, resolveWaEmployeeCredentials } from "../src/config/env.js";
import { testEnv } from "./helpers/testApp.js";

const S1 = "wa-self-service-secret-0123456789abcdef";
const S2 = "wa-ref-secret-0123456789abcdefghijklmn";
const TG_TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const WA_ON = {
  WA_SELF_SERVICE_MODE: "lookup_only",
  WA_SELF_SERVICE_SECRET: S1,
  WA_REF_SECRET: S2,
  BOOKING_EMPLOYEE_USERNAME: "asistente-ia",
  BOOKING_EMPLOYEE_PASSWORD: "not-a-real-password",
};

function load(overrides: Record<string, string> = {}) {
  testEnv(overrides);
  return loadEnv();
}

function failure(overrides: Record<string, string>): string {
  testEnv(overrides);
  try {
    loadEnv();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected loadEnv to throw");
}

afterEach(() => resetEnvCache());

describe("WA/Telegram env (ADR-032)", () => {
  it("defaults: everything off and boots without any new variable", () => {
    const env = load();
    expect(env.WA_SELF_SERVICE_MODE).toBe("off");
    expect(env.TELEGRAM_NOTIFY_MODE).toBe("off");
    expect(env.WA_SELF_SERVICE_SECRET).toBeUndefined();
    expect(env.WA_REF_TTL_MINUTES).toBe(30);
    expect(env.WA_CANCEL_MIN_LEAD_MINUTES).toBe(0);
    expect(env.WA_LATE_CANCEL_THRESHOLD_MINUTES).toBe(60);
    expect(env.WA_LOOKUP_HORIZON_DAYS).toBe(60);
    expect(env.WA_DASHBOARD_TIMEOUT_MS).toBe(8000);
    expect(env.WA_BOOKING_PIN_CALLER_PHONE).toBe(true);
    expect(env.TELEGRAM_SEND_TIMEOUT_MS).toBe(8000);
    expect(env.TELEGRAM_NOTIFY_WA_BOOKINGS).toBe(false);
    expect(env.TELEGRAM_NOTIFY_AGENDA_LINES).toBe(false);
  });

  it("lookup_only without each required key names every missing one", () => {
    const msg = failure({ WA_SELF_SERVICE_MODE: "lookup_only" });
    for (const key of [
      "WA_REF_SECRET",
      "BOOKING_EMPLOYEE_USERNAME",
      "BOOKING_EMPLOYEE_PASSWORD",
      "WA_SELF_SERVICE_SECRET",
    ]) {
      expect(msg).toContain(key);
    }
  });

  it("a complete lookup_only posture boots", () => {
    expect(load(WA_ON).WA_SELF_SERVICE_MODE).toBe("lookup_only");
  });

  it("live requires ENABLE_WRITE_OPERATIONS only; ENABLE_CANCEL_BOOKING is irrelevant", () => {
    expect(failure({ ...WA_ON, WA_SELF_SERVICE_MODE: "live" })).toContain("ENABLE_WRITE_OPERATIONS");
    expect(
      load({ ...WA_ON, WA_SELF_SERVICE_MODE: "live", ENABLE_WRITE_OPERATIONS: "true" }).WA_SELF_SERVICE_MODE,
    ).toBe("live");
  });

  it("production + armed creation + WA live + ENABLE_CANCEL_BOOKING=false boots; voice cancel stays blocked", () => {
    const prod = {
      ...WA_ON,
      NODE_ENV: "production",
      WA_SELF_SERVICE_MODE: "live",
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "true",
      BOOKING_IDEMPOTENCY_PATH: "/tmp/idem.jsonl",
      BOOKING_DEFAULT_OWNER_ID: "644",
      BOOKING_BOOKING_OWNER_MODE: "guest",
      AI_BOOKING_WEBHOOK_SECRET: "booking-only-secret-0123456789abcdef",
    };
    expect(load({ ...prod, ENABLE_CANCEL_BOOKING: "false" }).WA_SELF_SERVICE_MODE).toBe("live");
    expect(failure({ ...prod, ENABLE_CANCEL_BOOKING: "true" })).toContain("ENABLE_CANCEL_BOOKING must stay false");
  });

  it("allowlist: invalid entry names its position, never the value; mixed formats are fine", () => {
    const msg = failure({ ...WA_ON, WA_SELF_SERVICE_ALLOWLIST: "600000001, hola-mundo" });
    expect(msg).toContain("WA_SELF_SERVICE_ALLOWLIST");
    expect(msg).toContain("#2");
    expect(msg).not.toContain("hola-mundo");
    const env = load({ ...WA_ON, WA_SELF_SERVICE_ALLOWLIST: "600000001, +34 600000002,0034600000003" });
    expect([...parseWaAllowlist(env.WA_SELF_SERVICE_ALLOWLIST)]).toEqual([
      "+34600000001",
      "+34600000002",
      "+34600000003",
    ]);
  });

  it("secrets cannot be reused, nor the employee account equal the booking one", () => {
    expect(failure({ ...WA_ON, WA_REF_SECRET: S1 })).toContain("WA_REF_SECRET");
    expect(failure({ ...WA_ON, WA_SELF_SERVICE_SECRET: "test-slot-token-secret-0123456789abcdef" })).toContain(
      "VOICE_SLOT_TOKEN_SECRET",
    );
    expect(failure({ ...WA_ON, BOOKING_EMPLOYEE_USERNAME: "service-account" })).toContain(
      "BOOKING_EMPLOYEE_USERNAME must differ",
    );
  });

  it("telegram: live needs token, chat and queue; dry_run needs the queue", () => {
    const live = failure({ TELEGRAM_NOTIFY_MODE: "live", WA_SELF_SERVICE_SECRET: S1 });
    for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_QUEUE_PATH"]) {
      expect(live).toContain(key);
    }
    expect(failure({ TELEGRAM_NOTIFY_MODE: "dry_run", WA_SELF_SERVICE_SECRET: S1 })).toContain(
      "TELEGRAM_QUEUE_PATH",
    );
    expect(failure({ TELEGRAM_NOTIFY_MODE: "dry_run", TELEGRAM_QUEUE_PATH: "/tmp/q.jsonl" })).toContain(
      "WA_SELF_SERVICE_SECRET",
    );
    expect(
      load({
        TELEGRAM_NOTIFY_MODE: "live",
        TELEGRAM_QUEUE_PATH: "/tmp/q.jsonl",
        TELEGRAM_BOT_TOKEN: TG_TOKEN,
        TELEGRAM_CHAT_ID: "-100123",
        WA_SELF_SERVICE_SECRET: S1,
      }).TELEGRAM_NOTIFY_MODE,
    ).toBe("live");
  });

  it("telegram bot token and chat id shapes are validated, without echoing values", () => {
    const msg = failure({ TELEGRAM_BOT_TOKEN: "nope", TELEGRAM_CHAT_ID: "abc" });
    expect(msg).toContain("TELEGRAM_BOT_TOKEN");
    expect(msg).toContain("TELEGRAM_CHAT_ID");
    expect(msg).not.toContain("nope");
  });

  it("integer ranges are enforced", () => {
    for (const [key, bad] of [
      ["WA_REF_TTL_MINUTES", "4"],
      ["WA_REF_TTL_MINUTES", "181"],
      ["WA_CANCEL_MIN_LEAD_MINUTES", "2881"],
      ["WA_LOOKUP_HORIZON_DAYS", "6"],
      ["WA_LOOKUP_HORIZON_DAYS", "121"],
      ["WA_DASHBOARD_TIMEOUT_MS", "999"],
      ["WA_DASHBOARD_TIMEOUT_MS", "20001"],
      ["TELEGRAM_SEND_TIMEOUT_MS", "999"],
      ["TELEGRAM_SEND_TIMEOUT_MS", "60001"],
    ] as const) {
      expect(failure({ [key]: bad }), `${key}=${bad}`).toContain(key);
    }
    expect(load({ WA_CANCEL_MIN_LEAD_MINUTES: "0" }).WA_CANCEL_MIN_LEAD_MINUTES).toBe(0);
  });

  it("blank values fall back to the defaults", () => {
    const env = load({ WA_SELF_SERVICE_MODE: "", WA_SELF_SERVICE_SECRET: "", WA_BOOKING_PIN_CALLER_PHONE: "" });
    expect(env.WA_SELF_SERVICE_MODE).toBe("off");
    expect(env.WA_BOOKING_PIN_CALLER_PHONE).toBe(true);
  });
});

describe("WA employee identity = the service account (ADR-032 addendum 2026-10-08)", () => {
  const SHARED = {
    WA_SELF_SERVICE_MODE: "lookup_only",
    WA_SELF_SERVICE_SECRET: S1,
    WA_REF_SECRET: S2,
    WA_EMPLOYEE_USES_SERVICE_ACCOUNT: "true",
  };

  it("defaults to false: the dedicated-account mode is unchanged", () => {
    const env = load(WA_ON);
    expect(env.WA_EMPLOYEE_USES_SERVICE_ACCOUNT).toBe(false);
    expect(resolveWaEmployeeCredentials(env)).toEqual({
      username: "asistente-ia",
      password: "not-a-real-password",
      source: "dedicated_account",
    });
  });

  it("opt-in boots without BOOKING_EMPLOYEE_* and reuses BOOKING_USERNAME/PASSWORD", () => {
    const env = load(SHARED);
    expect(env.WA_EMPLOYEE_USES_SERVICE_ACCOUNT).toBe(true);
    expect(resolveWaEmployeeCredentials(env)).toEqual({
      username: "service-account",
      password: "not-a-real-password",
      source: "service_account",
    });
  });

  it("opt-in also boots in live (with the usual ENABLE_WRITE_OPERATIONS)", () => {
    expect(
      load({ ...SHARED, WA_SELF_SERVICE_MODE: "live", ENABLE_WRITE_OPERATIONS: "true" }).WA_SELF_SERVICE_MODE,
    ).toBe("live");
  });

  it("opt-in with either BOOKING_EMPLOYEE_* set is refused (ambiguous), without echoing values", () => {
    for (const extra of [
      { BOOKING_EMPLOYEE_USERNAME: "asistente-ia" },
      { BOOKING_EMPLOYEE_PASSWORD: "some-other-secret-value" },
      { BOOKING_EMPLOYEE_USERNAME: "service-account", BOOKING_EMPLOYEE_PASSWORD: "not-a-real-password" },
    ]) {
      const msg = failure({ ...SHARED, ...extra });
      for (const key of Object.keys(extra)) {
        expect(msg).toContain(`${key} must be unset when WA_EMPLOYEE_USES_SERVICE_ACCOUNT=true`);
      }
      expect(msg).not.toContain("some-other-secret-value");
      expect(msg).not.toContain("asistente-ia");
    }
    // Ambiguity is refused even with the feature off.
    expect(failure({ WA_EMPLOYEE_USES_SERVICE_ACCOUNT: "true", BOOKING_EMPLOYEE_USERNAME: "x" })).toContain(
      "BOOKING_EMPLOYEE_USERNAME must be unset",
    );
  });

  it("opt-in refuses BOOKING_REMEMBER_ME=true (an employee-capable 365-day token)", () => {
    expect(failure({ ...SHARED, BOOKING_REMEMBER_ME: "true" })).toContain(
      "BOOKING_REMEMBER_ME must be false when WA_EMPLOYEE_USES_SERVICE_ACCOUNT=true",
    );
    // Without the opt-in, remember-me keeps its old (independent) semantics.
    expect(load({ ...WA_ON, BOOKING_REMEMBER_ME: "true" }).BOOKING_REMEMBER_ME).toBe(true);
  });

  it("without the opt-in the 'must differ' rule still applies and points to the opt-in", () => {
    const msg = failure({ ...WA_ON, BOOKING_EMPLOYEE_USERNAME: "service-account" });
    expect(msg).toContain("BOOKING_EMPLOYEE_USERNAME must differ");
    expect(msg).toContain("WA_EMPLOYEE_USES_SERVICE_ACCOUNT=true");
  });

  it("only true/false are accepted; blank means false", () => {
    expect(failure({ WA_EMPLOYEE_USES_SERVICE_ACCOUNT: "yes" })).toContain("WA_EMPLOYEE_USES_SERVICE_ACCOUNT");
    expect(load({ WA_EMPLOYEE_USES_SERVICE_ACCOUNT: "" }).WA_EMPLOYEE_USES_SERVICE_ACCOUNT).toBe(false);
  });

  it("with neither mode configured no credentials resolve", () => {
    expect(resolveWaEmployeeCredentials(load())).toBeUndefined();
  });
});

describe("TELEGRAM_NOTIFY_AGENDA_LINES (AVISOS_AGENDA)", () => {
  it("34. true -> true, blank -> false, anything else is a validation error", () => {
    expect(load({ TELEGRAM_NOTIFY_AGENDA_LINES: "true" }).TELEGRAM_NOTIFY_AGENDA_LINES).toBe(true);
    expect(load({ TELEGRAM_NOTIFY_AGENDA_LINES: "" }).TELEGRAM_NOTIFY_AGENDA_LINES).toBe(false);
    expect(failure({ TELEGRAM_NOTIFY_AGENDA_LINES: "si" })).toContain("TELEGRAM_NOTIFY_AGENDA_LINES");
  });
});
