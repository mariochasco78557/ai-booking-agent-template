import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { WEBHOOK_SECRET, buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { BRUNO, conv, mockAgendaDay, v2 } from "./helpers/balancedV2.js";

/**
 * `POST /ai/wa/calendar-link` ((internal doc, not included in the template) §5.3):
 * the calendar link of a booking from its slot token. Read-only.
 */

const DATE = "2026-09-25";
const WA_SECRET = "wa-self-service-secret-0123456789abcdef";
const CAL_SECRET = "calendar-link-secret-for-tests-0123456789";
const BASE_URL = "https://api.booking.example.com";
const HOUR = 3_600_000;

describe("POST /ai/wa/calendar-link", () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T08:00:00Z"));
    nock.cleanAll();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    nock.cleanAll();
    vi.useRealTimers();
  });

  function env(calendar = true): void {
    testEnv({
      ENABLE_MULTI_BARBER: "true",
      WA_SELF_SERVICE_MODE: "off",
      WA_SELF_SERVICE_SECRET: WA_SECRET,
      ...(calendar ? { WHATSAPP_CALENDAR_LINK_SECRET: CAL_SECRET, WHATSAPP_CALENDAR_BASE_URL: BASE_URL } : {}),
    });
  }

  async function lockToken(conversation: string): Promise<string> {
    mockAgendaDay({ date: DATE, roster: [BRUNO], free: { 1: ["10:30", "11:00"] } });
    await v2(app!, { action: "discover", conversation_id: conversation, service_id: 1, date: DATE, time_period: "morning" });
    const { body } = await v2(app!, { action: "lock", conversation_id: conversation, option_index: 1 });
    expect(body["outcome"]).toBe("locked");
    return (body["slot"] as Record<string, unknown>)["slot_token"] as string;
  }

  async function link(payload: unknown, headers: Record<string, string> = {}) {
    const response = await app!.inject({
      method: "POST",
      url: "/ai/wa/calendar-link",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET, "x-ai-wa-secret": WA_SECRET, ...headers },
      payload: payload as Record<string, unknown>,
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  }





  it("without the wa secret it is 401", async () => {
    env();
    app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/ai/wa/calendar-link",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET },
      payload: { conversation_id: "x", slot_token: "y" },
    });
    expect(response.statusCode).toBe(401);
  });
});
