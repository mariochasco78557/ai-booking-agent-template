import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  UPSTREAM,
  WEBHOOK_SECRET,
  buildTestApp,
  fakeJwt,
  nock,
  testEnv,
} from "./helpers/testApp.js";

/**
 * ADR-032 — `/ai/wa/*` through the real app (`buildApp` + `inject`).
 * Time is faked (Date only) to Monday 2026-10-05 10:00 Madrid, so the
 * synthetic fixtures are in the future.
 */

const WA_SECRET = "wa-self-service-secret-0123456789abcdef";
const REF_SECRET = "wa-ref-secret-0123456789abcdefghijklmn";
const EMPLOYEE_USER = "asistente-ia";
const CALLER = "34600000001";

const fixtureText = readFileSync(new URL("./fixtures/wa/dashboard_array.json", import.meta.url), "utf8");
const FIXTURE = JSON.parse(fixtureText) as Array<Record<string, unknown>>;

function waEnv(overrides: Record<string, string> = {}): void {
  testEnv({
    WA_SELF_SERVICE_MODE: "lookup_only",
    WA_SELF_SERVICE_SECRET: WA_SECRET,
    WA_REF_SECRET: REF_SECRET,
    BOOKING_EMPLOYEE_USERNAME: EMPLOYEE_USER,
    BOOKING_EMPLOYEE_PASSWORD: "not-a-real-employee-password",
    ...overrides,
  });
}

const FULL_HEADERS = {
  "x-ai-webhook-secret": WEBHOOK_SECRET,
  "x-ai-wa-secret": WA_SECRET,
  "x-ai-wa-caller-id": CALLER,
};

const PATHS = ["/ai/wa/my-reservations", "/ai/wa/cancel", "/ai/wa/notify-owner"] as const;

describe("wa routes (ADR-032)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    nock.cleanAll();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T08:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
    nock.cleanAll();
  });

  function post(url: string, payload: unknown, headers: Record<string, string> = FULL_HEADERS) {
    return app.inject({ method: "POST", url, headers, payload: payload as never });
  }

  /** Persistent login (records which username asked) + dashboard answering `rows`. */
  function mockUpstream(rows: unknown[] = FIXTURE): { logins: string[]; dashboardCalls: () => number } {
    const logins: string[] = [];
    let dashboardCalls = 0;
    nock(UPSTREAM)
      .persist()
      .post(`${BASE_PATH}/login`)
      .reply((_uri, body) => {
        logins.push(String((body as { username?: unknown }).username));
        return [200, { token: fakeJwt() }];
      });
    nock(UPSTREAM)
      .persist()
      .get(`${BASE_PATH}/reservation/dashboard`)
      .query(true)
      .reply(() => {
        dashboardCalls += 1;
        return [200, rows];
      });
    return { logins, dashboardCalls: () => dashboardCalls };
  }

  it("without WA_SELF_SERVICE_SECRET the three routes do not exist (404)", async () => {
    testEnv();
    app = await buildTestApp();
    for (const url of PATHS) {
      const response = await post(url, {});
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("needs BOTH secrets: the voice secret alone, or the wa secret alone, is a 401", async () => {
    waEnv();
    app = await buildTestApp();
    for (const url of PATHS) {
      expect((await post(url, {}, { "x-ai-webhook-secret": WEBHOOK_SECRET })).statusCode, url).toBe(401);
      expect((await post(url, {}, { "x-ai-wa-secret": WA_SECRET })).statusCode, url).toBe(401);
      expect((await post(url, {}, {})).statusCode, url).toBe(401);
      expect(
        (await post(url, {}, { "x-ai-webhook-secret": WEBHOOK_SECRET, "x-ai-wa-secret": "wrong" })).statusCode,
        url,
      ).toBe(401);
    }
  });

  it("unreadable bodies are a structured 200 invalid_request, never a 4xx", async () => {
    waEnv();
    app = await buildTestApp();
    const broken = await app.inject({
      method: "POST",
      url: "/ai/wa/cancel",
      headers: { ...FULL_HEADERS, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(broken.statusCode).toBe(200);
    expect(broken.json()).toMatchObject({ outcome: "invalid_request", external_mutation: false });

    for (const body of [[], "text", 42]) {
      for (const url of PATHS) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { ...FULL_HEADERS, "content-type": "application/json" },
          payload: JSON.stringify(body),
        });
        expect(response.statusCode, `${url} ${JSON.stringify(body)}`).toBe(200);
        expect(response.json().outcome, `${url} ${JSON.stringify(body)}`).toBe("invalid_request");
      }
    }
  });





  it("/ai/wa/* does not consume the global rate limit (no plugin 429)", async () => {
    waEnv({ WA_SELF_SERVICE_MODE: "off", RATE_LIMIT_MAX: "3" });
    app = await buildTestApp();
    for (let i = 0; i < 12; i += 1) {
      const response = await post("/ai/wa/my-reservations", {});
      expect(response.statusCode, `request ${i}`).toBe(200);
    }
  });



});
