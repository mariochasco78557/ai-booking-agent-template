import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { BASE_PATH, UPSTREAM, buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { RAMON, conv, mockAgendaDay, v2, v2Book, type AgendaFixture } from "./helpers/balancedV2.js";
import {
  PhoneBookingLimit,
  phoneBookingLimitVoiceMessage,
  phoneBookingLimitWhatsAppMessage,
  type StandingRow,
} from "../src/services/bookingLimit/phoneBookingLimit.js";
import { loadEnv } from "../src/config/env.js";

/**
 * 2026-10-09 — at most N pending (future) appointments per phone, voice and
 * WhatsApp together (internal doc, not included in the template). Fail-open.
 * Every phone and name here is fictitious.
 */

const PHONE = "600000123";
const PHONE_E164 = "+34600000123";
const OTHER_PHONE = "600000456";

// ── The limiter alone ───────────────────────────────────────────────────────

describe("PhoneBookingLimit (unit)", () => {
  // Thursday 2026-10-08 10:00 Madrid.
  const NOW = Date.parse("2026-10-08T08:00:00Z");
  let now = NOW;
  const clock = () => now;

  beforeEach(() => {
    now = NOW;
  });

  function reader(rows: StandingRow[], opts: { delayMs?: number; fail?: boolean } = {}) {
    const calls: Array<{ fromDate: string; toDate: string }> = [];
    return {
      calls,
      readStandingRows: (range: { fromDate: string; toDate: string }) => {
        calls.push(range);
        return new Promise<StandingRow[]>((resolve, reject) => {
          setTimeout(() => (opts.fail ? reject(new Error("down")) : resolve(rows)), opts.delayMs ?? 0);
        });
      },
    };
  }

  const future = (n: number, phone = PHONE_E164): StandingRow[] =>
    Array.from({ length: n }, (_, i) => ({ ownerPhoneE164: phone, startsAt: `2026-10-1${i} 10:00` }));

  it("counts only this phone's FUTURE rows; refuses at the limit", async () => {
    const rows = [
      ...future(2),
      { ownerPhoneE164: PHONE_E164, startsAt: "2026-10-08 09:30" }, // already started
      { ownerPhoneE164: "+34600000456", startsAt: "2026-10-12 10:00" },
      { ownerPhoneE164: null, startsAt: "2026-10-12 11:00" },
    ];
    const limit = new PhoneBookingLimit({ max: 3, horizonDays: 60, readBudgetMs: 500 }, reader(rows), undefined, clock);
    const check = await limit.check(PHONE_E164);
    expect(check).toMatchObject({ decision: "allow", count: 2, source: "read" });

    const full = new PhoneBookingLimit({ max: 3, horizonDays: 60, readBudgetMs: 500 }, reader(future(3)), undefined, clock);
    expect(await full.check(PHONE_E164)).toMatchObject({ decision: "refuse", count: 3 });
  });

  it("reads from today to today + horizon (Madrid)", async () => {
    const r = reader([]);
    const limit = new PhoneBookingLimit({ max: 3, horizonDays: 60, readBudgetMs: 500 }, r, undefined, clock);
    await limit.check(PHONE_E164);
    expect(r.calls).toEqual([{ fromDate: "2026-10-08", toDate: "2026-12-07" }]);
  });

  it("FAIL-OPEN: an agenda that fails or is slower than the budget allows the booking", async () => {
    const failing = new PhoneBookingLimit(
      { max: 3, horizonDays: 60, readBudgetMs: 500 },
      reader(future(5), { fail: true }),
      undefined,
      clock,
    );
    expect(await failing.check(PHONE_E164)).toMatchObject({ decision: "allow", count: null, why: "error" });

    const slow = new PhoneBookingLimit(
      { max: 3, horizonDays: 60, readBudgetMs: 100 },
      reader(future(5), { delayMs: 400 }),
    );
    const started = Date.now();
    const check = await slow.check(PHONE_E164);
    const waited = Date.now() - started;
    expect(check).toMatchObject({ decision: "allow", count: null, why: "timeout" });
    expect(waited).toBeLessThan(350);
  });

  it("a prefetched snapshot answers the create with no wait", async () => {
    const r = reader(future(1), { delayMs: 50 });
    const limit = new PhoneBookingLimit({ max: 3, horizonDays: 60, readBudgetMs: 1000 }, r, undefined, clock);
    limit.prefetch();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const started = Date.now();
    const check = await limit.check(PHONE_E164);
    expect(check).toMatchObject({ decision: "allow", count: 1, source: "snapshot" });
    expect(Date.now() - started).toBeLessThan(20);
    expect(r.calls).toHaveLength(1);
    // A second lock right after does not read again.
    limit.prefetch();
    expect(r.calls).toHaveLength(1);
  });

  it("a booking or cancellation for the phone makes an older snapshot untrusted for it", async () => {
    const rows = future(2);
    const r = reader(rows);
    const limit = new PhoneBookingLimit({ max: 3, horizonDays: 60, readBudgetMs: 1000 }, r, undefined, clock);
    limit.prefetch();
    await new Promise((resolve) => setTimeout(resolve, 10));
    now += 1_000;
    // A third appointment is written for this phone after the snapshot.
    limit.markChanged(PHONE_E164);
    rows.push({ ownerPhoneE164: PHONE_E164, startsAt: "2026-10-20 10:00" });
    now += 1_000;
    expect(await limit.check(PHONE_E164)).toMatchObject({ decision: "refuse", count: 3, source: "read" });
    expect(r.calls).toHaveLength(2);
    // Another phone keeps using the (newer) snapshot.
    expect(await limit.check("+34600000456")).toMatchObject({ decision: "allow", source: "snapshot" });
  });

  it("a snapshot older than its maximum age is not used", async () => {
    const r = reader(future(1));
    const limit = new PhoneBookingLimit(
      { max: 3, horizonDays: 60, readBudgetMs: 1000, snapshotMaxAgeMs: 60_000 },
      r,
      undefined,
      clock,
    );
    await limit.check(PHONE_E164);
    now += 61_000;
    expect(await limit.check(PHONE_E164)).toMatchObject({ source: "read" });
    expect(r.calls).toHaveLength(2);
  });

  it("refuses to be built with a limit below 1", () => {
    expect(() => new PhoneBookingLimit({ max: 0, horizonDays: 60, readBudgetMs: 100 }, reader([]))).toThrow();
  });

  it("the sentences: the limit in words, the channel's way out, no digits", () => {
    expect(phoneBookingLimitVoiceMessage(3)).toBe(
      "Con este número ya tienes tres citas pendientes, así que esta no la he podido reservar. " +
        "Si necesitas otra, escríbenos por WhatsApp a este mismo número y te lo gestiona Bruno.",
    );
    expect(phoneBookingLimitWhatsAppMessage(3)).toContain("se lo dejo apuntado a Bruno");
    expect(phoneBookingLimitVoiceMessage(1)).toContain("una cita pendiente,");
    expect(phoneBookingLimitWhatsAppMessage(2)).not.toMatch(/\d/);
  });
});

// ── The env ─────────────────────────────────────────────────────────────────

describe("MAX_FUTURE_BOOKINGS_PER_PHONE (env)", () => {
  afterEach(() => {
    delete process.env["MAX_FUTURE_BOOKINGS_PER_PHONE"];
    delete process.env["MAX_FUTURE_BOOKINGS_READ_BUDGET_MS"];
  });

  it("defaults to 3 with a 1500 ms budget; 0 is accepted; out of range refuses to boot", () => {
    // `testEnv` resets the cached env as well as the variables.
    testEnv();
    expect(loadEnv().MAX_FUTURE_BOOKINGS_PER_PHONE).toBe(3);
    expect(loadEnv().MAX_FUTURE_BOOKINGS_READ_BUDGET_MS).toBe(1500);
    testEnv({ MAX_FUTURE_BOOKINGS_PER_PHONE: "0" });
    expect(loadEnv().MAX_FUTURE_BOOKINGS_PER_PHONE).toBe(0);
    testEnv({ MAX_FUTURE_BOOKINGS_PER_PHONE: "-1" });
    expect(() => loadEnv()).toThrow();
    testEnv({ MAX_FUTURE_BOOKINGS_PER_PHONE: "2.5" });
    expect(() => loadEnv()).toThrow();
    testEnv({ MAX_FUTURE_BOOKINGS_READ_BUDGET_MS: "10000" });
    expect(() => loadEnv()).toThrow();
  });
});

// ── Through the real routes, against a fake salon diary ─────────────────────

const DATE = "2026-10-10"; // Saturday
const WA_SECRET = "wa-self-service-secret-0123456789abcdef";
const REF_SECRET = "wa-ref-secret-0123456789abcdefghijklmn";
const V5 = { agent_profile: "v5" } as const;
const CUSTOMER = {
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: PHONE,
  confirmed_by_customer: true,
};

interface DiaryRow {
  id: number;
  reservationDate: string;
  ownerName: string;
  ownerSurnames: string;
  ownerPhone: string;
  typeReservation: number;
  employee: { id: number; name: string; surnames: string };
}

/** Create answers an empty 201; the dashboard lists the diary (or fails / is slow). */
function fakeSalon(opts: { dashboardFails?: boolean; dashboardDelayMs?: number } = {}) {
  const rows: DiaryRow[] = [];
  let nextId = 7000;
  let dashboardReads = 0;
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply((_uri, body) => {
      const b = body as Record<string, unknown>;
      nextId += 1;
      rows.push({
        id: nextId,
        reservationDate: String(b["reservationDate"]),
        ownerName: String(b["ownerName"]),
        ownerSurnames: String(b["ownerSurnames"]),
        ownerPhone: String(b["ownerPhone"]),
        typeReservation: Number(b["typeReservation"]),
        employee: b["employee"] as DiaryRow["employee"],
      });
      return [201, ""];
    });
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/reservation/dashboard`)
    .query(true)
    .delay(opts.dashboardDelayMs ?? 0)
    .reply(() => {
      dashboardReads += 1;
      return opts.dashboardFails ? [500, { message: "boom" }] : [200, rows];
    });
  nock(UPSTREAM)
    .persist()
    .get(/\/v1\/reservation\/delete\/\d+$/)
    .reply((uri) => {
      const id = Number(uri.split("/").at(-1));
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return [404, {}];
      rows.splice(index, 1);
      return [200, {}];
    });
  const seed = (startsAt: string, phone = PHONE) => {
    nextId += 1;
    rows.push({
      id: nextId,
      reservationDate: startsAt,
      ownerName: "Persona",
      ownerSurnames: "De Prueba",
      ownerPhone: phone,
      typeReservation: 1,
      employee: { id: 3, name: "Ramón", surnames: "" },
    });
  };
  return {
    rows,
    seed,
    creates: () => rows.filter((r) => r.ownerName !== "Persona").length,
    dashboardReads: () => dashboardReads,
  };
}

function limitEnv(overrides: Record<string, string> = {}): void {
  testEnv({
    ENABLE_MULTI_BARBER: "true",
    ENABLE_WRITE_OPERATIONS: "true",
    ENABLE_CREATE_BOOKING: "true",
    ENABLE_BALANCED_V2_CREATE: "true",
    BOOKING_BOOKING_OWNER_MODE: "guest",
    WA_SELF_SERVICE_MODE: "live",
    WA_SELF_SERVICE_SECRET: WA_SECRET,
    WA_REF_SECRET: REF_SECRET,
    BOOKING_EMPLOYEE_USERNAME: "asistente-ia",
    BOOKING_EMPLOYEE_PASSWORD: "not-a-real-employee-password",
    VOICE_CHANGE_BOOKING_ENABLED: "true",
    ...overrides,
  });
}

