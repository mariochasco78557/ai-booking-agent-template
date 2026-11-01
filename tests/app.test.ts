import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nock,
  testEnv,
  buildTestApp,
  WEBHOOK_SECRET,
} from "./helpers/testApp.js";

const PKG_VERSION = (
  JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  }
).version;

let app: FastifyInstance;

describe("app: health and webhook auth", () => {
  beforeEach(() => {
    nock.disableNetConnect();
    testEnv();
  });
  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("GET /health is public and returns ok, with the -dev version when APP_VERSION is unset", async () => {
    delete process.env.APP_VERSION;
    app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      service: "ai-booking-agent",
      version: `${PKG_VERSION}-dev`,
    });
  });

  it("GET /health reports APP_VERSION verbatim when it is set", async () => {
    process.env.APP_VERSION = "abc1234";
    try {
      app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe("abc1234");
    } finally {
      delete process.env.APP_VERSION;
    }
  });

  it("rejects /ai/* without the webhook secret (401, Spanish)", async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/ai/availability",
      payload: { date: "2026-07-29" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().success).toBe(false);
    expect(typeof res.json().message).toBe("string");
  });

  it("rejects /ai/* with a wrong secret", async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/ai/availability",
      headers: { "x-ai-webhook-secret": "wrong" },
      payload: { date: "2026-07-29" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 Spanish message on invalid body", async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/ai/availability",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET },
      payload: { date: "not-a-date" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/válid/i);
  });
});
