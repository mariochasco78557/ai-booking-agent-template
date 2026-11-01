import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nock from "nock";

import { buildTestApp, testEnv, WEBHOOK_SECRET } from "./helpers/testApp.js";
import { loadEnv, resetEnvCache } from "../src/config/env.js";
import {
  CALENDAR_DEFAULT_DURATION_MINUTES,
  madridWallClockToEpochMs,
  mintCalendarToken,
  verifyCalendarToken,
  type CalendarEvent,
} from "../src/services/whatsapp/calendarLink.js";
import {
  APPLE_BUTTON_LABEL,
  buildIcs,
  detectPlatform,
  escapeIcsText,
  foldIcsLine,
  GOOGLE_BUTTON_LABEL,
  googleCalendarUrl,
  renderCalendarPage,
} from "../src/services/whatsapp/calendarEvent.js";
import { GRAPH_API_BASE_URL, MetaWhatsAppClient } from "../src/services/whatsapp/metaWhatsappClient.js";
import { buildConfirmationParameters } from "../src/services/whatsapp/whatsappTemplate.js";
import { createWhatsAppNotifier } from "../src/services/whatsapp/whatsappNotifier.js";

/**
 * The «Añadir al calendario» link of the WhatsApp confirmation: the signed
 * token, the ICS, the Google URL, the page, the public routes, the env rules
 * and the Meta button.
 */

const SECRET = "calendar-link-secret-for-tests-0123456789";
const OTHER_SECRET = "a-different-calendar-secret-9876543210xyz";
const BASE_URL = "https://api.booking.example.com";
/** 2026-09-25 10:30 Madrid (CEST, +02:00) = 08:30Z. */
const START_WALL = "2026-09-25T10:30:00";
const START_UTC = Date.parse("2026-09-25T08:30:00Z");
const BEFORE = Date.parse("2026-09-24T12:00:00Z");

function token(overrides: Partial<Parameters<typeof mintCalendarToken>[1]> = {}): string {
  const minted = mintCalendarToken(SECRET, {
    startsAtIso: START_WALL,
    professionalName: "Bruno",
    serviceLabel: "Corte de pelo",
    ...overrides,
  });
  expect(minted).toBeDefined();
  return minted!;
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    startMs: START_UTC,
    durationMinutes: CALENDAR_DEFAULT_DURATION_MINUTES,
    professionalName: "Bruno",
    serviceLabel: "Corte de pelo",
    expiresAtMs: START_UTC + 25 * 3_600_000,
    ...overrides,
  };
}

describe("calendar token", () => {
  it("defaults to the owner's 30-minute appointment (Bruno, 2026-10-07)", () => {
    expect(CALENDAR_DEFAULT_DURATION_MINUTES).toBe(30);
    const result = verifyCalendarToken(SECRET, token(), BEFORE);
    expect(result.ok && result.event.durationMinutes).toBe(30);
  });

  it("round-trips an appointment, with the start as an unambiguous UTC instant", () => {
    const result = verifyCalendarToken(SECRET, token(), BEFORE);
    expect(result).toEqual({
      ok: true,
      event: {
        startMs: START_UTC,
        durationMinutes: CALENDAR_DEFAULT_DURATION_MINUTES,
        professionalName: "Bruno",
        serviceLabel: "Corte de pelo",
        // appointment end (30 min, the owner's rule) + 24 h
        expiresAtMs: START_UTC + 30 * 60_000 + 24 * 3_600_000,
      },
    });
  });

  it("is deterministic, compact and URL-safe", () => {
    expect(token()).toBe(token());
    expect(token()).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(token().length).toBeLessThan(160);
  });

  it("converts Madrid wall clock in both summer and winter time", () => {
    expect(madridWallClockToEpochMs("2026-09-25T10:30:00")).toBe(Date.parse("2026-09-25T08:30:00Z"));
    expect(madridWallClockToEpochMs("2026-12-15 17:00:00")).toBe(Date.parse("2026-12-15T16:00:00Z"));
    expect(madridWallClockToEpochMs("2026-12-15")).toBeUndefined();
    expect(madridWallClockToEpochMs("nonsense")).toBeUndefined();
    expect(mintCalendarToken(SECRET, { startsAtIso: "nonsense" })).toBeUndefined();
  });

  it("never carries a customer's name or phone — it has nowhere to put them", () => {
    const decoded = JSON.parse(Buffer.from(token().split(".")[0]!, "base64url").toString("utf8"));
    expect(Object.keys(decoded).sort()).toEqual(["d", "p", "s", "sv", "v", "x"]);
  });

  it("omits an unknown professional and service instead of inventing them", () => {
    const result = verifyCalendarToken(SECRET, token({ professionalName: null, serviceLabel: null }), BEFORE);
    expect(result.ok && result.event.professionalName).toBeNull();
    expect(result.ok && result.event.serviceLabel).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const foreign = mintCalendarToken(OTHER_SECRET, { startsAtIso: START_WALL })!;
    expect(verifyCalendarToken(SECRET, foreign, BEFORE)).toEqual({ ok: false, reason: "forged" });
  });

  it("rejects a tampered payload (a later hour) and a tampered signature", () => {
    const [payload, mac] = token().split(".") as [string, string];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.s += 3600;
    const moved = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${mac}`;
    expect(verifyCalendarToken(SECRET, moved, BEFORE)).toEqual({ ok: false, reason: "forged" });

    const flipped = `${payload}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    expect(verifyCalendarToken(SECRET, flipped, BEFORE)).toEqual({ ok: false, reason: "forged" });
  });

  it("rejects an expired token, one day after the appointment ends", () => {
    const t = token();
    const end = START_UTC + 30 * 60_000;
    expect(verifyCalendarToken(SECRET, t, end + 23 * 3_600_000).ok).toBe(true);
    expect(verifyCalendarToken(SECRET, t, end + 24 * 3_600_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed input before any crypto", () => {
    for (const bad of ["", "abc", "no-dot-at-all-here", "a.b", `${"x".repeat(500)}.${"y".repeat(22)}`, "abc+def/.abcdefghijklmnopqrstuv"]) {
      expect(verifyCalendarToken(SECRET, bad, BEFORE)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

describe("ICS", () => {
  const ics = buildIcs(event(), { token: token(), nowMs: BEFORE, location: "Calle Mayor 1, Ciudad Demo" });

  it("is a valid VCALENDAR with CRLF endings and every required property", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(ics).toContain("\r\nDTSTART:20260925T083000Z\r\n");
    expect(ics).toContain("\r\nDTEND:20260925T090000Z\r\n");
    expect(ics).toContain("\r\nDTSTAMP:20260924T120000Z\r\n");
    expect(ics).toContain("\r\nSUMMARY:Cita en Demo Salon\r\n");
    expect(ics).toMatch(/\r\nUID:[0-9a-f]{32}@demo-salon\r\n/);
    expect(ics).toContain("LOCATION:Calle Mayor 1\\, Ciudad Demo");
  });

  it("describes professional, service and the salon phone — and has NO alarm", () => {
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(
      "DESCRIPTION:Profesional: Bruno\\nServicio: Corte de pelo\\nPara cambiar o anular la cita\\, llama al 910 00 00 25.",
    );
    expect(ics).not.toContain("VALARM");
    expect(ics).not.toMatch(/TRIGGER|ACTION:/);
  });

  it("omits LOCATION when none is configured", () => {
    expect(buildIcs(event(), { token: token(), nowMs: BEFORE })).not.toContain("LOCATION");
  });

  it("uses the same UID for the same token", () => {
    const again = buildIcs(event(), { token: token(), nowMs: BEFORE + 1000 });
    expect(again.match(/UID:.*/)![0]).toBe(ics.match(/UID:.*/)![0]);
  });

  it("escapes TEXT and folds at 75 octets without splitting a UTF-8 character", () => {
    expect(escapeIcsText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
    const long = `DESCRIPTION:${"ñ".repeat(100)}`;
    const folded = foldIcsLine(long);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const [index, part] of parts.entries()) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
      if (index > 0) expect(part.startsWith(" ")).toBe(true);
      expect(part).not.toContain("�");
    }
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(long);
    expect(foldIcsLine("SHORT:line")).toBe("SHORT:line");
  });
});

describe("Google Calendar URL", () => {
  it("is Google's TEMPLATE form with UTC dates and Madrid display zone", () => {
    const url = googleCalendarUrl(event(), { location: "Calle Mayor 1" });
    expect(url.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE&")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe("Cita en Demo Salon");
    expect(parsed.searchParams.get("dates")).toBe("20260925T083000Z/20260925T090000Z");
    expect(parsed.searchParams.get("ctz")).toBe("Europe/Madrid");
    expect(parsed.searchParams.get("location")).toBe("Calle Mayor 1");
    expect(parsed.searchParams.get("details")).toContain("Profesional: Bruno\nServicio: Corte de pelo");
    expect(parsed.searchParams.get("details")).toContain("910 00 00 25");
    expect(googleCalendarUrl(event())).not.toContain("location=");
  });
});

describe("calendar page", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 WhatsApp";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile";

  function page(platform: ReturnType<typeof detectPlatform>): string {
    return renderCalendarPage(event(), { icsPath: "/cal/T/cita.ics", googleUrl: googleCalendarUrl(event()), platform });
  }

  it("guesses the platform from the User-Agent", () => {
    expect(detectPlatform(IPHONE)).toBe("apple");
    expect(detectPlatform(ANDROID)).toBe("android");
    expect(detectPlatform("curl/8")).toBe("unknown");
    expect(detectPlatform(undefined)).toBe("unknown");
  });

  it("always shows BOTH buttons and only highlights the likely one", () => {
    for (const platform of ["apple", "android", "unknown"] as const) {
      const html = page(platform);
      expect(html).toContain(APPLE_BUTTON_LABEL);
      expect(html).toContain(GOOGLE_BUTTON_LABEL);
      expect(html).toContain('href="/cal/T/cita.ics"');
      expect(html).toContain('href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;');
    }
    expect(page("apple")).toMatch(/class="btn primary" href="\/cal\/T\/cita.ics"/);
    expect(page("android")).toMatch(/class="btn primary" href="https:\/\/calendar.google.com/);
    expect(page("unknown")).not.toContain("btn primary");
  });

  it("shows the appointment in Spanish, Madrid time, self-contained", () => {
    const html = page("unknown");
    expect(html).toContain("<title>Tu cita en Demo Salon</title>");
    expect(html).toContain("viernes 25 de septiembre");
    expect(html).toContain("<dd>10:30</dd>");
    expect(html).toContain("<dd>Bruno</dd>");
    expect(html).not.toMatch(/<script|<link|<img|src=/i);
  });

  it("escapes HTML in every displayed value", () => {
    const html = renderCalendarPage(event({ professionalName: "<b>x</b>" }), {
      icsPath: "/cal/T/cita.ics",
      googleUrl: "https://calendar.google.com/x",
      platform: "unknown",
    });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("public /cal routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function appWithSecret(extra: Record<string, string> = {}): Promise<FastifyInstance> {
    testEnv({ WHATSAPP_CALENDAR_LINK_SECRET: SECRET, ...extra });
    app = await buildTestApp();
    return app;
  }

  function expectPrivateHeaders(headers: Record<string, unknown>): void {
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  }

  it("serves the page WITHOUT any credential, with the privacy headers", async () => {
    await appWithSecret();
    // A far-future appointment so the real clock never expires it.
    const t = token({ startsAtIso: "2030-06-10T10:00:00" });
    const res = await app.inject({
      method: "GET",
      url: `/cal/${t}`,
      headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14)" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expectPrivateHeaders(res.headers);
    expect(String(res.headers["content-security-policy"])).toMatch(/default-src 'none'; style-src 'sha256-/);
    expect(res.body).toContain(APPLE_BUTTON_LABEL);
    expect(res.body).toContain(GOOGLE_BUTTON_LABEL);
    expect(res.body).toContain(`href="/cal/${t}/cita.ics"`);
    expect(res.body).toMatch(/class="btn primary" href="https:\/\/calendar.google.com/);
  });

  it("serves the ICS without any credential", async () => {
    await appWithSecret({ WHATSAPP_CALENDAR_LOCATION: "Calle Mayor 1, Ciudad Demo" });
    const t = token({ startsAtIso: "2030-06-10T10:00:00" });
    const res = await app.inject({ method: "GET", url: `/cal/${t}/cita.ics` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/calendar; charset=utf-8");
    expectPrivateHeaders(res.headers);
    expect(res.body).toContain("BEGIN:VEVENT\r\n");
    expect(res.body).toContain("DTSTART:20300610T080000Z");
    // Bruno, 2026-10-07: every appointment lasts 30 minutes.
    expect(res.body).toContain("DTEND:20300610T083000Z");
    expect(res.body).toContain("LOCATION:Calle Mayor 1\\, Ciudad Demo");
    expect(res.body).not.toContain("VALARM");
  });

  it("answers a friendly 410 for an expired link and 404 for a forged or malformed one", async () => {
    await appWithSecret();
    const expired = token({ startsAtIso: "2025-01-10T10:00:00" });
    const gone = await app.inject({ method: "GET", url: `/cal/${expired}` });
    expect(gone.statusCode).toBe(410);
    expect(gone.body).toContain("Este enlace ha caducado");
    expectPrivateHeaders(gone.headers);

    const foreign = mintCalendarToken(OTHER_SECRET, { startsAtIso: "2030-06-10T10:00:00" })!;
    for (const url of [`/cal/${foreign}`, `/cal/${foreign}/cita.ics`, "/cal/garbage"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain("Este enlace no es válido");
      expect(res.body).not.toMatch(/forged|malformed|signature|firma|token/i);
      expectPrivateHeaders(res.headers);
    }
    // Past the router's `maxParamLength`: refused before any handler runs.
    const huge = await app.inject({ method: "GET", url: `/cal/${"x".repeat(400)}` });
    expect(huge.statusCode).toBe(414);
  });

  it("does not exist when the secret is unset, and /ai/* keeps its guard when it is set", async () => {
    testEnv();
    app = await buildTestApp();
    const t = token({ startsAtIso: "2030-06-10T10:00:00" });
    expect((await app.inject({ method: "GET", url: `/cal/${t}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/cal/${t}/cita.ics` })).statusCode).toBe(404);
    await app.close();

    await appWithSecret();
    const unauth = await app.inject({ method: "POST", url: "/ai/voice/v2/availability", payload: {} });
    expect(unauth.statusCode).toBe(401);
    // Sanity: the configured secret is not an /ai/* credential.
    expect(WEBHOOK_SECRET).not.toBe(SECRET);
  });
});

describe("env · calendar link", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-salon-wa-cal-env-"));
  const queue = join(dir, "q.jsonl");

  afterEach(() => {
    resetEnvCache();
  });

  function load(overrides: Record<string, string>): () => unknown {
    return () => {
      testEnv(overrides);
      resetEnvCache();
      return loadEnv();
    };
  }

  const sending = {
    WHATSAPP_NOTIFICATIONS_MODE: "dry_run",
    WHATSAPP_QUEUE_PATH: queue,
  };

  it("requires the secret and base URL in dry_run and live", () => {
    expect(load(sending)).toThrow(/WHATSAPP_CALENDAR_LINK_SECRET[\s\S]*WHATSAPP_CALENDAR_BASE_URL/);
    expect(
      load({
        ...sending,
        WHATSAPP_NOTIFICATIONS_MODE: "live",
        WHATSAPP_ACCESS_TOKEN: "not-a-real-token",
        WHATSAPP_PHONE_NUMBER_ID: "1",
        WHATSAPP_CALENDAR_LINK_SECRET: SECRET,
      }),
    ).toThrow(/WHATSAPP_CALENDAR_BASE_URL/);
    expect(load({ ...sending, WHATSAPP_CALENDAR_BASE_URL: BASE_URL })).toThrow(/WHATSAPP_CALENDAR_LINK_SECRET/);
    expect(load({ ...sending, WHATSAPP_CALENDAR_BASE_URL: BASE_URL, WHATSAPP_CALENDAR_LINK_SECRET: SECRET })).not.toThrow();
  });

  it("does not require anything with the mode off", () => {
    expect(load({})).not.toThrow();
    expect(load({ WHATSAPP_NOTIFICATIONS_MODE: "off" })).not.toThrow();
    expect(load({ WHATSAPP_CALENDAR_LINK_SECRET: "  " })).not.toThrow();
  });

  it("validates the secret length, the https base URL, the location and secret reuse", () => {
    const ok = { ...sending, WHATSAPP_CALENDAR_BASE_URL: BASE_URL, WHATSAPP_CALENDAR_LINK_SECRET: SECRET };
    expect(load({ ...ok, WHATSAPP_CALENDAR_LINK_SECRET: "short" })).toThrow(/at least 32/);
    expect(load({ ...ok, WHATSAPP_CALENDAR_BASE_URL: "http://api.booking.example.com" })).toThrow(/https/);
    expect(load({ ...ok, WHATSAPP_CALENDAR_BASE_URL: "https://x.com/?a=1" })).toThrow(/https/);
    expect(load({ ...ok, WHATSAPP_CALENDAR_BASE_URL: "not a url" })).toThrow(/WHATSAPP_CALENDAR_BASE_URL/);
    expect(load({ ...ok, WHATSAPP_CALENDAR_LOCATION: "a\nb" })).toThrow(/single line/);
    expect(load({ ...ok, WHATSAPP_CALENDAR_LINK_SECRET: WEBHOOK_SECRET.padEnd(32, "x"), AI_WEBHOOK_SECRET: WEBHOOK_SECRET.padEnd(32, "x") })).toThrow(/must not reuse the value of AI_WEBHOOK_SECRET/);
    testEnv({ ...ok, WHATSAPP_CALENDAR_BASE_URL: `${BASE_URL}/` });
    resetEnvCache();
    expect(loadEnv().WHATSAPP_CALENDAR_BASE_URL).toBe(BASE_URL);
  });
});

describe("Meta payload and the notifier", () => {
  let dir: string;

  beforeEach(() => {
    nock.cleanAll();
    dir = mkdtempSync(join(tmpdir(), "demo-salon-wa-cal-"));
  });

  afterEach(() => {
    nock.cleanAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the Graph request carries the URL button component with the token", async () => {
    let sent: Record<string, unknown> | undefined;
    nock(GRAPH_API_BASE_URL)
      .post("/v25.0/1234567890/messages", (body: Record<string, unknown>) => {
        sent = body;
        return true;
      })
      .reply(200, { messages: [{ id: "wamid.X" }] });
    const client = new MetaWhatsAppClient({
      accessToken: "not-a-real-token",
      phoneNumberId: "1234567890",
      graphApiVersion: "v25.0",
      templateName: "cita_confirmada_demo_salon",
      templateLanguage: "es",
      sendTimeoutMs: 500,
    });
    const params = buildConfirmationParameters({
      customerName: "Carlos",
      professionalName: "Bruno",
      startsAtIso: START_WALL,
    });
    const result = await client.send("34600000123", params, "TOKEN.abc");
    expect(result).toEqual({ ok: true, messageId: "wamid.X" });
    const components = (sent!["template"] as { components: unknown[] }).components;
    expect(components).toEqual([
      { type: "body", parameters: params },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "TOKEN.abc" }] },
    ]);
  });

  it("the factory refuses a sending mode without the calendar config", () => {
    const errors: string[] = [];
    const logger = { info() {}, warn() {}, debug() {}, error: (_: unknown, m: string) => errors.push(m) };
    const notifier = createWhatsAppNotifier({
      mode: "dry_run",
      queuePath: join(dir, "q.jsonl"),
      templateName: "cita_confirmada_demo_salon",
      templateLanguage: "es",
      graphApiVersion: "v25.0",
      sendTimeoutMs: 500,
      logger,
    });
    expect(notifier).toBeUndefined();
    expect(errors.join(" ")).toMatch(/calendar/);
  });

  it("dry run logs a MASKED link, never the full token, and labels the service", async () => {
    const lines: Array<{ detail: Record<string, unknown>; message: string }> = [];
    const logger = {
      info: (detail: Record<string, unknown>, message: string) => lines.push({ detail, message }),
      warn() {},
      error() {},
      debug() {},
    };
    const notifier = createWhatsAppNotifier({
      mode: "dry_run",
      queuePath: join(dir, "q.jsonl"),
      templateName: "cita_confirmada_demo_salon",
      templateLanguage: "es",
      graphApiVersion: "v25.0",
      sendTimeoutMs: 500,
      calendarLinkSecret: SECRET,
      calendarBaseUrl: `${BASE_URL}/`,
      logger,
    })!;
    notifier.enqueueConfirmation(
      {
        reservationId: 91_000,
        conversationId: "conv_test_cal",
        phone: "600000123",
        customerName: "Carlos",
        reservationDate: "2026-09-25 10:30:00",
        serviceId: 2,
      },
      Date.now(),
    );
    await notifier.drain();
    expect(notifier.queue.all()[0]).toMatchObject({ status: "sent_dry_run", serviceLabel: "Corte y barba" });

    const full = mintCalendarToken(SECRET, {
      startsAtIso: START_WALL,
      professionalName: null,
      serviceLabel: "Corte y barba",
    })!;
    const dry = lines.find((line) => line.message.startsWith("whatsapp dry run"))!;
    expect(dry.detail["calendar_link"]).toBe(`${BASE_URL}/cal/${full.slice(0, 6)}…(len=${full.length})`);
    expect(JSON.stringify(lines)).not.toContain(full);
    await notifier.stop();
  });
});
