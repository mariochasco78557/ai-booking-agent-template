import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { fixedClock } from "../../src/callEngine/domain/types.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import {
  BOOKING_DEMO_NOW_MINUTES,
  BOOKING_DEMO_TODAY,
  demoSalonVenue,
} from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { buildElevenLabsSyntheticBridge } from "../../src/voice/elevenlabs/server.js";

/**
 * ElevenLabs cannot declare "integer OR the literal any" in a tool property,
 * so `professional_id` travels as a string and the LLM sends `"3"`. These
 * tests pin the exact width of the coercion the bridge accepts: digits only.
 */

const WEBHOOK_SECRET = "test-webhook-secret-32-characters-minimum";
const HASH_SALT = "test-call-hash-salt-32-characters-minimum";
const HEADERS = { "x-booking-voice-secret": WEBHOOK_SECRET };

const BASE_SLOT = {
  conversation_id: "conv_test_booking_0001",
  date_iso: "2026-08-04",
  time: "10:00",
  service_id: 1,
  professional_id: ALEX_ID,
  service_confirmed: true,
} as const;

/** Strings the LLM must never talk the bridge into treating as a number. */
const NON_NUMERIC_STRINGS = ["", "abc", "3.5", " 3", "-1", "3 ", "+3", "３", "0x3", "1e3"] as const;

interface Harness {
  app: FastifyInstance;
  store: ReturnType<typeof createMemoryStore>;
}

const openApps: FastifyInstance[] = [];

function harness(): Harness {
  const store = createMemoryStore();
  const app = buildElevenLabsSyntheticBridge({
    webhookSecret: WEBHOOK_SECRET,
    salt: HASH_SALT,
    store,
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    initialCalendar: demoSalonVenue(),
  });
  openApps.push(app);
  return { app, store };
}

async function post(app: FastifyInstance, path: string, body: unknown) {
  return app.inject({ method: "POST", url: path, headers: HEADERS, payload: body as never });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => await app.close()));
});

describe("ElevenLabs synthetic bridge: professional_id arrives as text", () => {
  it('answers availability for "3" exactly as it answers for 3', async () => {
    const asNumber = await post(harness().app, "/v1/elevenlabs/availability", BASE_SLOT);
    const asString = await post(harness().app, "/v1/elevenlabs/availability", {
      ...BASE_SLOT,
      professional_id: String(ALEX_ID),
    });

    expect(asNumber.statusCode).toBe(200);
    expect(asString.statusCode).toBe(200);
    expect(asString.json()).toEqual(asNumber.json());
    expect(asString.json()).toMatchObject({
      requested_slot_available: true,
      requires_customer_confirmation: true,
      offered_slots: [{ date_iso: "2026-08-04", time: "10:00" }],
      external_mutation: false,
    });
  });

  it('books with "3" and treats a numeric retry of the same slot as the same command', async () => {
    const { app, store } = harness();
    const first = await post(app, "/v1/elevenlabs/book", {
      ...BASE_SLOT,
      professional_id: String(ALEX_ID),
      booking_confirmed: true,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["idempotency-status"]).toBe("original");
    expect(first.json()).toMatchObject({
      booked: true,
      reason_code: "BOOKING_CONFIRMED",
      external_mutation: false,
      synthetic_mutation: true,
      reservation: { employee_id: ALEX_ID, service_id: 1, date_iso: "2026-08-04", synthetic: true },
    });
    expect(store.snapshot().reservations).toHaveLength(1);

    const retryAsNumber = await post(app, "/v1/elevenlabs/book", { ...BASE_SLOT, booking_confirmed: true });
    expect(retryAsNumber.headers["idempotency-status"]).toBe("replayed");
    expect(retryAsNumber.body).toBe(first.body);
    expect(store.snapshot().reservations).toHaveLength(1);
  });

  it('still accepts the literal "any"', async () => {
    const { app } = harness();
    const response = await post(app, "/v1/elevenlabs/availability", { ...BASE_SLOT, professional_id: "any" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "synthetic", external_mutation: false });
  });

  it("refuses any string that is not digits or the exact word any", async () => {
    const { app, store } = harness();
    for (const professional_id of NON_NUMERIC_STRINGS) {
      const availability = await post(app, "/v1/elevenlabs/availability", { ...BASE_SLOT, professional_id });
      expect(availability.statusCode, `availability ${JSON.stringify(professional_id)}`).toBe(400);
      expect(availability.json()).toMatchObject({ error: "invalid_tool_request", external_mutation: false });

      const book = await post(app, "/v1/elevenlabs/book", {
        ...BASE_SLOT,
        professional_id,
        booking_confirmed: true,
      });
      expect(book.statusCode, `book ${JSON.stringify(professional_id)}`).toBe(400);
      expect(book.json()).toMatchObject({ error: "invalid_tool_request", external_mutation: false });
    }
    expect(store.snapshot().reservations).toHaveLength(0);
  });

  it("keeps rejecting an unknown professional, whether it arrives as a number or as digits", async () => {
    const { app, store } = harness();
    for (const professional_id of [4, "4", 1_000_000, "1000000"]) {
      const response = await post(app, "/v1/elevenlabs/availability", { ...BASE_SLOT, professional_id });
      expect(response.statusCode, `availability ${JSON.stringify(professional_id)}`).toBe(400);
      expect(response.json()).toEqual({ error: "unknown_professional", external_mutation: false });
    }

    // Out of the accepted integer range on both spellings: rejected by the
    // schema itself, before the calendar is ever consulted.
    for (const professional_id of [0, "0", 1_000_001, "1000001"]) {
      const response = await post(app, "/v1/elevenlabs/availability", { ...BASE_SLOT, professional_id });
      expect(response.statusCode, `availability ${JSON.stringify(professional_id)}`).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_tool_request" });
    }
    expect(store.snapshot().reservations).toHaveLength(0);
  });
});
