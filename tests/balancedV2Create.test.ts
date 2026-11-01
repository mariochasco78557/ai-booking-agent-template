import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  UPSTREAM,
  WEBHOOK_SECRET,
  buildTestApp,
  mockCreateDelayed,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import { BRUNO, OLGA, conv, mockAgendaDay, v2, v2Book } from "./helpers/balancedV2.js";
import { mintSlotToken } from "./helpers/slotToken.js";
import {
  BALANCED_ALREADY_BOOKED_MESSAGE,
  BALANCED_BOOKING_FAILED_MESSAGE,
  BALANCED_BOOKING_UNCERTAIN_MESSAGE,
  BALANCED_WRITE_DISABLED_MESSAGE,
} from "../src/utils/balancedPhrasing.js";

/**
 * BALANCED V2 — `/ai/voice/v2/book`.
 *
 * The write. Everything here is about what CANNOT create an appointment:
 *
 * - a discovery, however well-formed, because it mints nothing;
 * - a token from the stable `/ai/voice/availability`, because the two flows
 *   have separate key domains;
 * - a locked token whose lock has since been superseded;
 * - anything at all while `ENABLE_BALANCED_V2_CREATE=false`, EVEN on a
 *   deployment where creation is otherwise fully armed.
 *
 * And one thing that can: a token from a V2 lock, on an armed deployment, with
 * a real customer identity and an explicit confirmation — once.
 */

const DATE = "2026-09-18";
const CUSTOMER = {
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: "600000123",
  confirmed_by_customer: true,
};

/** Intercepts the upstream create and counts how many times it is called. */
function mockCreate(): { calls: () => number } {
  let calls = 0;
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply(() => {
      calls += 1;
      return [200, { id: 90_000 + calls }];
    });
  return { calls: () => calls };
}


describe("balanced v2 · AVISOS_AGENDA noteBooking hook (32, 33)", () => {
  let hookApp: FastifyInstance;
  afterEach(async () => {
    await hookApp?.close();
  });

  async function build(result: Record<string, unknown>, noteBooking: (b: unknown, n: number) => void) {
    const { default: Fastify } = await import("fastify");
    const { registerBalancedV2Routes } = await import("../src/routes/balancedV2.js");
    const app = Fastify();
    await registerBalancedV2Routes(app, {
      balanced: {} as never,
      voiceBookingV2: { book: async () => result } as never,
      agentProfiles: { resolve: () => ({ maxBookingsPerCall: 1, profile: "v4" }) } as never,
      voiceManage: {} as never,
      webhookSecret: WEBHOOK_SECRET,
      agendaBookings: { noteBooking } as never,
    });
    hookApp = app;
    return app;
  }

  const confirmed = { outcome: "confirmed", booked: true, idempotency_status: "original", message: "ok", employee_name: "Ramón" };
  const body = { conversation_id: "wa_c1_1", slot_token: "tok", ...CUSTOMER };

  it("32. WhatsApp confirmed -> once; replayed, other outcome, voice replace -> never", async () => {
    const calls: unknown[] = [];
    const wa = { "x-ai-channel": "whatsapp" };
    let app = await build(confirmed, (b) => calls.push(b));
    await v2Book(app, body, wa);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ channel: "whatsapp", conversationId: "wa_c1_1", slotToken: "tok", employeeName: "Ramón" });
    await app.close();

    calls.length = 0;
    app = await build({ ...confirmed, idempotency_status: "replayed" }, (b) => calls.push(b));
    await v2Book(app, body, wa);
    await app.close();
    app = await build({ ...confirmed, outcome: "write_disabled" }, (b) => calls.push(b));
    await v2Book(app, body, wa);
    await app.close();
    app = await build(confirmed, (b) => calls.push(b));
    await v2Book(app, { ...body, replaces_booking_number: 1 });
    expect(calls).toHaveLength(0);
    await v2Book(app, body);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ channel: "voice" });
  });

  it("33. a throwing noteBooking changes nothing: same answer, status 200", async () => {
    const ok = await build(confirmed, () => {});
    const a = await v2Book(ok, body);
    await ok.close();
    const bad = await build(confirmed, () => {
      throw new Error("boom");
    });
    const b = await v2Book(bad, body);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });
});
