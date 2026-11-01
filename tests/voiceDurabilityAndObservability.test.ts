import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { categoryFromStatus } from "../src/plugins/observability.js";
import { AGENDA_UNAVAILABLE_MESSAGE } from "../src/utils/phrasing.js";

const auth = { "x-ai-webhook-secret": WEBHOOK_SECRET };

/** step SLOT: flat shape; `voiceBookBody()` seals the hueco into a token. */
const voiceBooking = {
  conversation_id: "conv_durable_001",
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: "600000101",
  reservation_date: "2026-08-28 17:00:00",
  employee_id: 1,
  service_id: 1,
  confirmed_by_customer: true,
};

const availabilityQuery = {
  conversation_id: "conv_obs_001",
  date_from: "2026-08-28",
  date_to: "2026-08-28",
  service_id: 1,
};

let apps: FastifyInstance[] = [];
let dirs: string[] = [];

async function newApp(): Promise<FastifyInstance> {
  const app = await buildTestApp();
  apps.push(app);
  return app;
}

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "demo-salon-durable-"));
  dirs.push(dir);
  return join(dir, "booking-idempotency.jsonl");
}

beforeEach(() => {
  nock.disableNetConnect();
  testEnv();
});

afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("step PROD Hito 6 — idempotency that survives a restart", () => {


  it("refuses to boot a production process that arms creation without a durable store", async () => {
    testEnv({
      NODE_ENV: "production",
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "true",
    });

    await expect(buildTestApp()).rejects.toThrow(/BOOKING_IDEMPOTENCY_PATH/);
  });

  /**
   * step LAT (objective 3) added a SECOND production precondition alongside
   * the durable store: creation must not be reachable with the same secret
   * that merely reads the agenda. This test now covers both, because both are
   * things an operator arming creation has to have done first.
   */
  it("still refuses to boot in production when creation is armed with no dedicated booking secret", async () => {
    testEnv({
      NODE_ENV: "production",
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "true",
      BOOKING_IDEMPOTENCY_PATH: tempStorePath(),
    });

    await expect(buildTestApp()).rejects.toThrow(/AI_BOOKING_WEBHOOK_SECRET/);
  });

  it("boots that same production config once a durable store AND a dedicated booking secret are configured", async () => {
    testEnv({
      NODE_ENV: "production",
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "true",
      BOOKING_IDEMPOTENCY_PATH: tempStorePath(),
      AI_BOOKING_WEBHOOK_SECRET: "booking-only-secret-at-least-32-characters",
    });

    await expect(newApp()).resolves.toBeDefined();
  });
});

/**
 * step LAT (objective 3) — the booking route's second credential.
 *
 * The property being defended: the secret the voice agent carries on EVERY
 * availability call cannot, on its own, reach the one route that writes.
 */
describe("step LAT — booking requires its own secret as well as the shared one", () => {
  const bookingPayload = voiceBookBody({
    conversation_id: "conv_booking_secret_test",
    customer_name: "Ana",
    customer_surnames: "Pérez",
    phone: "612345678",
    reservation_date: "2026-12-01 10:00:00",
    service_id: 1,
    confirmed_by_customer: true,
  });

  it("rejects a booking that presents ONLY the shared /ai/* secret", async () => {
    testEnv({ AI_BOOKING_WEBHOOK_SECRET: "booking-only-secret-at-least-32-characters" });
    const app = await newApp();

    const res = await app.inject({
      method: "POST",
      url: "/ai/voice/book",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET },
      payload: bookingPayload,
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a booking that presents ONLY the booking secret", async () => {
    testEnv({ AI_BOOKING_WEBHOOK_SECRET: "booking-only-secret-at-least-32-characters" });
    const app = await newApp();

    const res = await app.inject({
      method: "POST",
      url: "/ai/voice/book",
      headers: { "x-ai-booking-secret": "booking-only-secret-at-least-32-characters" },
      payload: bookingPayload,
    });

    expect(res.statusCode).toBe(401);
  });

  it("leaves the availability route reachable with the shared secret alone", async () => {
    testEnv({ AI_BOOKING_WEBHOOK_SECRET: "booking-only-secret-at-least-32-characters" });
    const app = await newApp();

    const res = await app.inject({
      method: "POST",
      url: "/ai/voice/availability",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET },
      payload: {
        conversation_id: "conv_booking_secret_test",
        date_from: "2026-12-01",
        date_to: "2026-12-01",
        service_id: 1,
      },
    });

    // Not 401: adding a booking credential must not break the read path the
    // agent uses on every single call.
    expect(res.statusCode).not.toBe(401);
  });

  it("keeps today's behaviour when no dedicated booking secret is configured", async () => {
    testEnv();
    const app = await newApp();

    const res = await app.inject({
      method: "POST",
      url: "/ai/voice/book",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET },
      payload: bookingPayload,
    });

    expect(res.statusCode).not.toBe(401);
  });
});

describe("step PROD Hito 7 — correlation id and degraded agenda", () => {
  it("returns a request id on every response", async () => {
    const app = await newApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a well-formed caller-supplied request id so a call can be traced end to end", async () => {
    const app = await newApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "elevenlabs-conv_01jt4k9" },
    });

    expect(response.headers["x-request-id"]).toBe("elevenlabs-conv_01jt4k9");
  });

  it("replaces a caller-supplied request id that could forge a log line", async () => {
    const app = await newApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      // Whoever can call this middleware can set this header. Spaces and
      // punctuation are the shape of an attempt to inject structure into a
      // log line, so the value is discarded rather than echoed.
      headers: { "x-request-id": "id ok, status=admin" },
    });

    expect(response.headers["x-request-id"]).not.toBe("id ok, status=admin");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });



  it("maps every status class to a countable category", () => {
    expect(categoryFromStatus(200)).toBe("ok");
    expect(categoryFromStatus(400)).toBe("invalid_request");
    expect(categoryFromStatus(401)).toBe("unauthorized");
    expect(categoryFromStatus(404)).toBe("not_found");
    expect(categoryFromStatus(429)).toBe("rate_limited");
    expect(categoryFromStatus(502)).toBe("upstream_error");
    expect(categoryFromStatus(504)).toBe("upstream_timeout");
    expect(categoryFromStatus(500)).toBe("internal_error");
  });
});
