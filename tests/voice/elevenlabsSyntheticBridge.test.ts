import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { fixedClock } from "../../src/callEngine/domain/types.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import {
  BOOKING_DEMO_NOW_MINUTES,
  BOOKING_DEMO_TODAY,
  demoSalonVenue,
} from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import {
  DEFAULT_ELEVENLABS_BRIDGE_PORT,
  ELEVENLABS_BRIDGE_HOST,
  loadElevenLabsBridgeConfig,
  requireElevenLabsBridgeEnabled,
} from "../../src/voice/elevenlabs/config.js";
import {
  buildElevenLabsSyntheticBridge,
  startElevenLabsSyntheticBridge,
} from "../../src/voice/elevenlabs/server.js";

const WEBHOOK_SECRET = "test-webhook-secret-32-characters-minimum";
const HASH_SALT = "test-call-hash-salt-32-characters-minimum";
const HEADERS = { "x-booking-voice-secret": WEBHOOK_SECRET };

const BASE_SLOT = {
  conversation_id: "conv_test_booking_0001",
  date_iso: "2026-08-04",
  time: "10:00",
  service_id: 1,
  professional_id: 3,
  service_confirmed: true,
} as const;

interface Harness {
  app: FastifyInstance;
  store: ReturnType<typeof createMemoryStore>;
  emitter: ReturnType<typeof createCallEventEmitter>;
}

const openApps: FastifyInstance[] = [];

function harness(): Harness {
  const store = createMemoryStore();
  const emitter = createCallEventEmitter();
  const app = buildElevenLabsSyntheticBridge({
    webhookSecret: WEBHOOK_SECRET,
    salt: HASH_SALT,
    store,
    emitter,
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    initialCalendar: demoSalonVenue(),
  });
  openApps.push(app);
  return { app, store, emitter };
}

async function post(app: FastifyInstance, path: string, body: unknown, headers = HEADERS) {
  return app.inject({ method: "POST", url: path, headers, payload: body as never });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, ELEVENLABS_BRIDGE_HOST, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no se pudo obtener un puerto efímero")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => await app.close()));
});

describe("ElevenLabs synthetic bridge: process boundary", () => {
  it("keeps the three declarative ElevenLabs contracts pinned to the implemented routes and gates", () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), "docs", "elevenlabs-call-engine", "TOOL_CONTRACTS.json"), "utf8"),
    ) as {
      status: string;
      baseUrl: string;
      authentication: { header: string };
      tools: Array<{
        name: string;
        method: string;
        path: string;
        conversationIdSource: string;
        bodySchema: {
          additionalProperties: boolean;
          required: string[];
          properties: Record<string, { type?: unknown; const?: unknown; dynamic_variable?: string }>;
        };
      }>;
    };
    expect(contract.status).toBe("local_synthetic_not_uploaded");
    expect(contract.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(contract.authentication.header).toBe("X-Booking-Voice-Secret");
    expect(contract.tools.map((tool) => [tool.name, tool.method, tool.path])).toEqual([
      ["booking_availability", "POST", "/v1/elevenlabs/availability"],
      ["booking_book", "POST", "/v1/elevenlabs/book"],
      ["booking_human_help", "POST", "/v1/elevenlabs/human-help"],
    ]);
    for (const tool of contract.tools) {
      expect(tool.conversationIdSource).toBe("system__conversation_id");
      expect(tool.bodySchema.additionalProperties).toBe(false);
      expect(tool.bodySchema.required).toContain("conversation_id");
      // `dynamic_variable` is the key the provider actually accepts; there is
      // no `x-elevenlabs-*` extension, and that property cannot carry a
      // `description` alongside it.
      expect(tool.bodySchema.properties.conversation_id?.dynamic_variable).toBe("system__conversation_id");
      expect(tool.bodySchema.properties.conversation_id).not.toHaveProperty("description");
    }
    // ElevenLabs admits a single literal in `type`, so the only declaration
    // that can also carry "any" is a string. The doc must not promise a union.
    for (const tool of contract.tools.slice(0, 2)) {
      expect(tool.bodySchema.properties.professional_id?.type).toBe("string");
    }
    expect(contract.tools[0]?.bodySchema.properties.service_confirmed?.const).toBe(true);
    expect(contract.tools[1]?.bodySchema.properties.service_confirmed?.const).toBe(true);
    expect(contract.tools[1]?.bodySchema.properties.booking_confirmed?.const).toBe(true);
  });

  it("does not import the historical middleware, production clients or an ElevenLabs SDK", () => {
    const source = readFileSync(join(process.cwd(), "src", "voice", "elevenlabs", "server.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:routes\/ai|clients\/|services\/)/);
    expect(source).not.toContain("axios");
    expect(source).not.toContain("ELEVENLABS_API_KEY");
    expect(source).not.toContain("xi-api-key");
  });

  it("is disabled by default and resolves a loopback-only, non-3000 default", () => {
    const config = loadElevenLabsBridgeConfig({});
    expect(config).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: DEFAULT_ELEVENLABS_BRIDGE_PORT,
    });
    expect(config.port).not.toBe(3000);
    expect(() => requireElevenLabsBridgeEnabled(config)).toThrow(/desactivado/i);
  });

  it("fails closed when enabled without two independent secrets", () => {
    const missing = loadElevenLabsBridgeConfig({ ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED: "1" });
    expect(() => requireElevenLabsBridgeEnabled(missing)).toThrow(/Faltan ELEVENLABS_WEBHOOK_SECRET/i);

    expect(() =>
      loadElevenLabsBridgeConfig({
        ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED: "1",
        ELEVENLABS_WEBHOOK_SECRET: "short",
        ELEVENLABS_CALL_HASH_SALT: HASH_SALT,
      }),
    ).toThrow(/Configuración del puente ElevenLabs inválida/i);
  });

  it("starts the real entry point only on 127.0.0.1 when explicitly enabled", async () => {
    const port = await freePort();
    expect(port).not.toBe(3000);
    const started = await startElevenLabsSyntheticBridge({
      ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED: "1",
      ELEVENLABS_SYNTHETIC_BRIDGE_PORT: String(port),
      ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ELEVENLABS_CALL_HASH_SALT: HASH_SALT,
    });
    openApps.push(started.app);
    expect(started.host).toBe("127.0.0.1");
    expect(started.port).toBe(port);
    const health = await started.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, mode: "synthetic", external_mutation: false });
  });
});

describe("ElevenLabs synthetic bridge: authentication and schemas", () => {
  it("keeps health harmless and public but authenticates every tool with no secret reflection", async () => {
    const { app, store } = harness();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      service: "demo-salon-elevenlabs-synthetic-bridge",
      mode: "synthetic",
      external_mutation: false,
      synthetic_today: BOOKING_DEMO_TODAY,
    });

    for (const headers of [{}, { "x-booking-voice-secret": `${WEBHOOK_SECRET}-wrong` }]) {
      const response = await post(app, "/v1/elevenlabs/availability", BASE_SLOT, headers);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized_tool_request", external_mutation: false });
      expect(response.body).not.toContain(WEBHOOK_SECRET);
    }
    expect(store.snapshot().calls).toHaveLength(0);
  });

  it("rejects personal data, transcripts and unknown fields at the boundary", async () => {
    const { app, store } = harness();
    for (const extra of [
      { phone: "+34600000000" },
      { customer_name: "Persona real" },
      { transcript: "texto de la llamada" },
      { audio: "base64" },
      { caller_id: "+34600000000" },
    ]) {
      const response = await post(app, "/v1/elevenlabs/availability", { ...BASE_SLOT, ...extra });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_tool_request" });
    }
    expect(store.snapshot().calls).toHaveLength(0);
  });

  it("requires both explicit confirmation gates for booking", async () => {
    const { app, store } = harness();
    for (const body of [
      { ...BASE_SLOT, booking_confirmed: true, service_confirmed: false },
      { ...BASE_SLOT, booking_confirmed: false },
      BASE_SLOT,
    ]) {
      const response = await post(app, "/v1/elevenlabs/book", body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_tool_request" });
    }
    expect(store.snapshot().reservations).toHaveLength(0);
  });

  it("rejects dates the current deterministic DSL cannot represent instead of silently changing the date", async () => {
    const { app, store } = harness();
    const response = await post(app, "/v1/elevenlabs/availability", {
      ...BASE_SLOT,
      date_iso: "2026-08-20",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "date_outside_synthetic_window",
      external_mutation: false,
    });
    expect(store.snapshot().calls).toHaveLength(0);
  });
});

describe("ElevenLabs synthetic bridge: tool behavior", () => {
  it("returns engine-approved availability copy without any mutation", async () => {
    const { app, store, emitter } = harness();
    const response = await post(app, "/v1/elevenlabs/availability", BASE_SLOT);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      mode: "synthetic",
      phrase_key: "REASON_AVAILABILITY_PROVIDED",
      outcome: "RESUELVE",
      reason_code: "AVAILABILITY_PROVIDED",
      announces_success: false,
      external_mutation: false,
      synthetic_mutation: false,
      requested_slot_available: true,
      requires_customer_confirmation: true,
      offered_slots: [{ date_iso: "2026-08-04", time: "10:00" }],
    });
    expect(store.snapshot().reservations).toHaveLength(0);

    const serializedEvents = JSON.stringify(emitter.all());
    expect(serializedEvents).not.toContain(BASE_SLOT.conversation_id);
    expect(serializedEvents).not.toContain("transcript");
    expect(serializedEvents).not.toContain("audio");
  });

  it("creates exactly one synthetic booking and replays an identical provider retry", async () => {
    const { app, store, emitter } = harness();
    const request = { ...BASE_SLOT, booking_confirmed: true };

    const first = await post(app, "/v1/elevenlabs/book", request);
    expect(first.statusCode).toBe(200);
    expect(first.headers["idempotency-status"]).toBe("original");
    expect(first.json()).toMatchObject({
      ok: true,
      booked: true,
      phrase_key: "REASON_BOOKING_CONFIRMED",
      reason_code: "BOOKING_CONFIRMED",
      announces_success: true,
      external_mutation: false,
      synthetic_mutation: true,
      requires_customer_confirmation: false,
      reservation: {
        employee_id: 3,
        service_id: 1,
        date_iso: "2026-08-04",
        synthetic: true,
      },
    });
    expect(store.snapshot().reservations).toHaveLength(1);
    const eventsAfterFirst = JSON.stringify(emitter.all());

    const retry = await post(app, "/v1/elevenlabs/book", request);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotency-status"]).toBe("replayed");
    expect(retry.body).toBe(first.body);
    expect(store.snapshot().reservations).toHaveLength(1);
    expect(JSON.stringify(emitter.all())).toBe(eventsAfterFirst);
  });

  it("does not book a proposed professional before the caller accepts that substitution", async () => {
    const { app, store } = harness();
    const response = await post(app, "/v1/elevenlabs/book", {
      ...BASE_SLOT,
      conversation_id: "conv_alt_professional_01",
      time: "10:30",
      service_id: 0,
      professional_id: 9,
      booking_confirmed: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      booked: false,
      external_mutation: false,
      synthetic_mutation: false,
      requires_customer_confirmation: true,
      offered_professional: { employee_id: 3 },
    });
    expect(store.snapshot().reservations).toHaveLength(0);
  });

  it("serializes the shared calendar so a second conversation cannot double-book the same exact professional", async () => {
    const { app, store } = harness();
    const first = await post(app, "/v1/elevenlabs/book", { ...BASE_SLOT, booking_confirmed: true });
    expect(first.json()).toMatchObject({ booked: true });

    const second = await post(app, "/v1/elevenlabs/book", {
      ...BASE_SLOT,
      conversation_id: "conv_test_booking_0002",
      booking_confirmed: true,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ booked: false, external_mutation: false });
    expect(store.snapshot().reservations).toHaveLength(1);
  });

  it("records human help once, never claims a completed transfer, and replays retries", async () => {
    const { app, store } = harness();
    const body = { conversation_id: "conv_human_help_0001", reason: "cancel" };
    const first = await post(app, "/v1/elevenlabs/human-help", body);
    expect(first.statusCode).toBe(200);
    expect(first.headers["idempotency-status"]).toBe("original");
    expect(first.json()).toMatchObject({
      ok: false,
      reason_code: "CUSTOMER_REQUESTS_HUMAN",
      help_requested: true,
      transfer_completed: false,
      external_mutation: false,
      reason: "cancel",
    });
    expect(store.snapshot().humanTasks).toHaveLength(1);

    const retry = await post(app, "/v1/elevenlabs/human-help", body);
    expect(retry.headers["idempotency-status"]).toBe("replayed");
    expect(retry.body).toBe(first.body);
    expect(store.snapshot().humanTasks).toHaveLength(1);
  });
});
