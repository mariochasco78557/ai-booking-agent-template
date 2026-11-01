import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp, nock, testEnv, WEBHOOK_SECRET } from "./helpers/testApp.js";
import { withDay, BRUNO, RAMON, OLGA, conv, mockAgendaDay } from "./helpers/balancedV2.js";
import { loadEnv, resetEnvCache } from "../src/config/env.js";
import {
  BALANCED_MAX_OPTIONS,
  BALANCED_WA_MAX_OPTIONS_MAX,
  BALANCED_WA_MAX_OPTIONS_MIN,
  clampBalancedWaMaxOptions,
} from "../src/schemas/balancedV2Schemas.js";
import {
  BALANCED_OPTION_PAGE_CEILING,
  MemoryBalancedOptionStore,
  type BalancedOption,
} from "../src/services/balanced/balancedOptionStore.js";
import { BALANCED_INVALID_REQUEST_MESSAGE } from "../src/utils/balancedPhrasing.js";

/**
 * BALANCED V2 — WhatsApp-sized pages (owner request, Bruno, 2026-10-08).
 *
 * A request with `x-ai-channel: whatsapp` gets pages of up to
 * `BALANCED_WA_MAX_OPTIONS` (default 10) options for discover, scan and more,
 * because the WhatsApp brain shows them as a list. Every request WITHOUT the
 * header — every voice call — must be exactly what it was: pages of three,
 * the same sentence, and `lock` refusing any index above three.
 *
 * `lock` never reads the header: it checks the page size stored with the page.
 *
 * A WhatsApp list holds at most ten rows and the brain adds «Más horas» when
 * hours remain, so a page of 10 with MORE than ten hours left offers nine
 * (nine rows + «Más horas»); ten hours or fewer are offered whole.
 */

const DATE = "2026-09-19";
/** Twelve unique morning hours (08:00 … 13:30) and two afternoon ones. */
const FREE: Record<number, string[]> = {
  1: ["08:00", "08:30", "09:00", "09:30", "10:00", "15:00"],
  2: ["10:30", "11:00", "11:30", "12:00"],
  3: ["12:30", "13:00", "13:30", "16:00"],
};
const MORNING = [
  "08:00", "08:30", "09:00", "09:30", "10:00", "10:30",
  "11:00", "11:30", "12:00", "12:30", "13:00", "13:30",
];

const WA = { "x-ai-channel": "whatsapp" };

/** `YYYY-MM-DD` of the first Tuesday–Friday at least two days from now. */
function nextOpenWeekday(): string {
  for (let offset = 2; ; offset += 1) {
    const day = new Date(Date.now() + offset * 86_400_000);
    const weekday = day.getUTCDay();
    if (weekday >= 2 && weekday <= 5) return day.toISOString().slice(0, 10);
  }
}

async function post(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ body: Record<string, unknown>; raw: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/ai/voice/v2/availability",
    headers: { ...headers, "x-ai-webhook-secret": WEBHOOK_SECRET },
    payload,
  });
  expect(response.statusCode).toBe(200);
  return { body: response.json() as Record<string, unknown>, raw: response.payload };
}

function times(body: Record<string, unknown>): string[] {
  return (body["options"] as Array<{ time: string }>).map((option) => option.time);
}

function indices(body: Record<string, unknown>): number[] {
  return (body["options"] as Array<{ option_index: number }>).map((o) => o.option_index);
}

function discover(conversation: string, extra: Record<string, unknown> = {}) {
  return {
    action: "discover",
    conversation_id: conversation,
    service_id: 1,
    date: DATE,
    time_period: "morning",
    ...extra,
  };
}


describe("BALANCED_WA_MAX_OPTIONS", () => {
  afterEach(() => {
    resetEnvCache();
  });

  it("defaults to 10 and is clamped to 3..10", () => {
    expect(BALANCED_WA_MAX_OPTIONS_MIN).toBe(BALANCED_MAX_OPTIONS);
    expect(BALANCED_WA_MAX_OPTIONS_MAX).toBe(10);
    expect(BALANCED_OPTION_PAGE_CEILING).toBe(BALANCED_WA_MAX_OPTIONS_MAX);
    testEnv();
    expect(loadEnv().BALANCED_WA_MAX_OPTIONS).toBe(10);
    for (const [raw, expected] of [["25", 10], ["1", 3], ["0", 3], ["-4", 3], ["5", 5], ["", 10]] as const) {
      resetEnvCache();
      testEnv({ BALANCED_WA_MAX_OPTIONS: raw });
      expect(loadEnv().BALANCED_WA_MAX_OPTIONS).toBe(expected);
    }
    expect(clampBalancedWaMaxOptions(Number.NaN)).toBe(10);
  });

  it("a value that is not a number refuses to boot", () => {
    resetEnvCache();
    testEnv({ BALANCED_WA_MAX_OPTIONS: "lots" });
    expect(() => loadEnv()).toThrow();
  });

});

describe("MemoryBalancedOptionStore · page size", () => {
  const option = (index: number): BalancedOption => ({
    optionIndex: index,
    date: DATE,
    time: `${String(8 + index).padStart(2, "0")}:00`,
    reservationDate: `${DATE} ${String(8 + index).padStart(2, "0")}:00:00`,
    serviceId: 1,
    period: "morning",
    assignedEmployeeId: 40,
    eligibleEmployeeIds: [1],
  });
  const twelve = Array.from({ length: 12 }, (_, i) => option(i + 1));

  it("keeps three by default and up to the ceiling when asked", () => {
    const store = new MemoryBalancedOptionStore({ ttlSeconds: 60, maxEntries: 10 });
    store.publish("voice", twelve, 0);
    expect(store.peek("voice", 0)?.options).toHaveLength(3);
    expect(store.pageSize("voice", 0)).toBe(3);
    store.publish("wa", twelve, 0, undefined, 10);
    expect(store.peek("wa", 0)?.options).toHaveLength(10);
    expect(store.pageSize("wa", 0)).toBe(10);
    store.publish("huge", twelve, 0, undefined, 50);
    expect(store.pageSize("huge", 0)).toBe(BALANCED_OPTION_PAGE_CEILING);
    store.publish("bad", twelve, 0, undefined, 0);
    expect(store.pageSize("bad", 0)).toBe(3);
    expect(store.get("wa", 7, 0)).toMatchObject({ ok: true, option: { optionIndex: 7 } });
    expect(store.get("voice", 7, 0)).toEqual({ ok: false, refusal: "unknown_option" });
  });

  it("pageSize is a pure read: no touch, no reclaim, undefined when expired", () => {
    const store = new MemoryBalancedOptionStore({ ttlSeconds: 60, maxEntries: 10 });
    store.publish("c", twelve, 0, undefined, 10);
    const before = store.peek("c", 0)?.expiresAtMs;
    expect(store.pageSize("c", 30_000)).toBe(10);
    expect(store.peek("c", 30_000)?.expiresAtMs).toBe(before);
    expect(store.pageSize("c", 61_000)).toBeUndefined();
    // Still there for `get`, which reports the expiry itself.
    expect(store.get("c", 1, 61_000)).toEqual({ ok: false, refusal: "expired" });
  });
});
