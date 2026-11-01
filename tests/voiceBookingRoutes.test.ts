import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  UPSTREAM,
  WEBHOOK_SECRET,
  buildTestApp,
  freeEmployeeFixture,
  mockFree,
  mockLogin,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import { offered, voiceBookBody } from "./helpers/slotToken.js";

let app: FastifyInstance;
const auth = { "x-ai-webhook-secret": WEBHOOK_SECRET };

/**
 * step SLOT: the FLAT shape. `voiceBookBody()` seals `reservation_date`,
 * `employee_id` and `service_id` into a real `slot_token` — those three are
 * no longer fields of the request at all (see `voiceBookSchema`).
 */
const voiceBooking = {
  conversation_id: "conv_voice_001",
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: "600000101",
  reservation_date: "2026-08-28 17:00:00",
  employee_id: 1,
  service_id: 1,
  confirmed_by_customer: true,
};

describe("ElevenLabs voice façade", () => {
  beforeEach(() => {
    nock.disableNetConnect();
    testEnv();
  });

  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("protects the voice routes with the existing webhook secret", async () => {
    app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/ai/voice/availability",
      payload: {
        conversation_id: "conv_voice_001",
        date_from: "2026-08-28",
        date_to: "2026-08-28",
        service_id: 1,
      },
    });

    expect(response.statusCode).toBe(401);
  });


  it("rejects intervals longer than seven days before any upstream request", async () => {
    app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/ai/voice/availability",
      headers: auth,
      payload: {
        conversation_id: "conv_voice_001",
        date_from: "2026-08-28",
        date_to: "2026-09-04",
        service_id: 1,
      },
    });

    expect(response.statusCode).toBe(400);
  });


  it("requires the literal confirmation gate and makes no upstream request when absent", async () => {
    // step SLOT (audit, 2026-08-30): this used to assert 400, because
    // `confirmed_by_customer` was `z.literal(true)`. A 400 is a TOOL ERROR to
    // ElevenLabs and it retries — and "the model forgot the confirmation
    // flag" is one of the most ordinary failures a voice agent has. It is now
    // a deterministic 200 the agent's prompt knows how to route.
    app = await buildTestApp();

    for (const confirmation of [false, undefined, "true", 1]) {
      const payload = voiceBookBody({ ...voiceBooking, confirmed_by_customer: confirmation });
      if (confirmation === undefined) delete payload["confirmed_by_customer"];
      const response = await app.inject({
        method: "POST",
        url: "/ai/voice/book",
        headers: auth,
        payload,
      });

      expect(response.statusCode, JSON.stringify(confirmation ?? null)).toBe(200);
      expect(response.json()).toMatchObject({
        booked: false,
        outcome: "not_confirmed",
        external_mutation: false,
        mutation_status: "none",
        idempotency_status: "original",
      });
    }
  });



});
