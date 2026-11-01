import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { BASE_PATH, SLOT_TOKEN_SECRET, UPSTREAM, buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { BRUNO, RAMON, OLGA, conv, mockAgendaDay, v2, v2Book } from "./helpers/balancedV2.js";
import { SlotAuthorizationService } from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";
import {
  BALANCED_SCAN_ALL_CLOSED_MESSAGE,
  balancedLockMismatchMessage,
} from "../src/utils/balancedPhrasing.js";
import { CALLER_PHONE_UNAVAILABLE_MESSAGE, INVALID_CUSTOMER_DATA_MESSAGE } from "../src/utils/phrasing.js";
import { resolveCallerPhone } from "../src/services/voiceBookingService.js";
import { resetEnvCache, loadEnv } from "../src/config/env.js";

/**
 * 2026-10-09 — voice fixes, phase 1-2 (internal doc, not included in the template):
 *
 * 1. a `lock` by `option_index` against a list that a later `discover` replaced
 *    (call r3557a: 19:00 with Olga asked, 10:00 with Olga locked);
 * 2. a one-day `scan` of a Saturday afternoon said «Esos días la peluquería
 *    está cerrada» (call 8dx8gn);
 * 3. the phone the customer is calling from (`system__caller_id`), behind
 *    `VOICE_CALLER_ID_PHONE_ENABLED`.
 */

const V5 = { agent_profile: "v5" } as const;
const WED = "2026-10-14"; // Wednesday

// ── a service on a stubbed, multi-day agenda (fixes 1 and 2) ─────────────────

const NOW = Date.parse("2026-09-15T10:00:00Z"); // Tuesday
const SAT = "2026-09-26";
const TUE = "2026-09-29";
const WED_2 = "2026-09-30";
const SATURDAY_CLOSE = new Map([[6, 14 * 60]]);

function dayOf(date: string, times: string[]): AgendaDay {
  return {
    date,
    serviceId: "1",
    employees: [BRUNO],
    free:
      times.length === 0
        ? []
        : [
            {
              id: BRUNO.id,
              name: BRUNO.name,
              surnames: BRUNO.surnames,
              date: `${date} 10:00:00`,
              slots: times.map((t) => ({ start: `${date} ${t}:00`, end: `${date} ${t}:00` })),
            },
          ],
    fetchedAtMs: NOW,
    upstreamCalls: 1,
  };
}

function build(fixture: Record<string, string[]>) {
  const reads: string[] = [];
  const agenda: AgendaReader = {
    read: async (date) => {
      reads.push(date);
      return { day: dayOf(date, fixture[date] ?? []), outcome: "miss", ageMs: 0 };
    },
    readFresh: async (date) => ({ day: dayOf(date, fixture[date] ?? []), outcome: "bypass", ageMs: 0 }),
    invalidate: () => 0,
  };
  const service = new BalancedAvailabilityService({
    agenda,
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
    offerStore: new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    scanDeadlineMs: 500,
    earlyClose: SATURDAY_CLOSE,
    logger: { warn: () => undefined, info: () => undefined },
  });
  return { service, reads };
}

// ── FIX 1 · the stale lock ────────────────────────────────────────────────────


describe("fix 1 · same hour on two days of a scan page", () => {
  it("without option_date it is ambiguous and refused; with it the right day is locked", async () => {
    const { service } = build({ [TUE]: ["18:00"], [WED_2]: ["18:00"] });
    const conversation = conv("scan-twice-18");
    const page = await service.scan(
      { conversation_id: conversation, service_id: 1, date_from: TUE, days: 2, after_time: "17:00" },
      NOW,
    );
    expect(page.options.map((o) => `${o.date} ${o.time}`)).toEqual([`${TUE} 18:00`, `${WED_2} 18:00`]);

    const ambiguous = await service.lock({ conversation_id: conversation, option_index: 3 }, NOW, {
      optionTime: "18:00",
    });
    expect(ambiguous.outcome).toBe("option_not_found");
    expect(ambiguous.option_mismatch).toBe(true);

    const dated = await service.lock({ conversation_id: conversation, option_index: 1 }, NOW, {
      optionTime: "18:00",
      optionDate: WED_2,
    });
    expect(dated.outcome).toBe("locked");
    expect(dated.slot?.date).toBe(WED_2);
    expect(dated.option_index_corrected_from).toBe(1);
  });
});

// ── FIX 2 · scan of a Saturday afternoon ──────────────────────────────────────

describe("fix 2 · a one-day scan of a closed Saturday afternoon (8dx8gn)", () => {
  it("answers exactly what discover answers, without reading Saturday", async () => {
    const fixture = { [TUE]: ["17:00", "17:30"] };
    const viaScan = build(fixture);
    const scan = await viaScan.service.scan(
      { conversation_id: conv("8dx8gn-scan"), service_id: 1, date_from: SAT, days: 1, time_period: "afternoon" },
      NOW,
    );
    const viaDiscover = build(fixture);
    const discover = await viaDiscover.service.discover(
      { conversation_id: conv("8dx8gn-discover"), service_id: 1, date: SAT, time_period: "afternoon" },
      NOW,
    );

    expect(scan.message).not.toBe(BALANCED_SCAN_ALL_CLOSED_MESSAGE);
    expect(scan.message).toMatch(/^El sábado veintiséis por la tarde cerramos; lo más cercano es el martes/);
    expect(scan.message).toBe(discover.message);
    expect(scan.options).toEqual(discover.options);
    expect(scan.outcome).toBe("options_available");
    expect(viaScan.reads).not.toContain(SAT);

    // The page is an ordinary page: lock 1 is Tuesday 17:00.
    const locked = await viaScan.service.lock({ conversation_id: conv("8dx8gn-scan"), option_index: 1 }, NOW);
    expect(locked.outcome).toBe("locked");
    expect(locked.slot?.date).toBe(TUE);
    expect(locked.slot?.time).toBe("17:00");
  });

  it("an after_time floor stays a hard filter in the look-ahead", async () => {
    const { service, reads } = build({ [TUE]: ["16:00", "17:00", "18:30"] });
    const result = await service.scan(
      { conversation_id: conv("8dx8gn-after"), service_id: 1, date_from: SAT, days: 1, after_time: "18:00" },
      NOW,
    );
    expect(reads).not.toContain(SAT);
    expect(result.message).toMatch(/^El sábado veintiséis por la tarde cerramos;/);
    expect(result.options.map((o) => o.time)).toEqual(["18:30"]);
  });

  it("a closed window with no band at all keeps the old sentence and reads nothing", async () => {
    const { service, reads } = build({ [TUE]: ["17:00"] });
    const result = await service.scan(
      { conversation_id: conv("closed-no-band"), service_id: 1, date_from: "2026-09-27", days: 2 },
      NOW,
    );
    expect(reads).toEqual([]);
    expect(result.message).toBe(BALANCED_SCAN_ALL_CLOSED_MESSAGE);
  });
});

// ── FIX 3 · the caller's own number ───────────────────────────────────────────

describe("fix 3 · resolveCallerPhone (pure)", () => {
  it("a dictated phone always wins, whatever the caller id", () => {
    expect(resolveCallerPhone("600000123", "+34612345678")).toEqual({ kind: "dictated" });
    expect(resolveCallerPhone("6000000021", "+34612345678")).toEqual({ kind: "dictated" });
  });

  it("absent, empty or a marker uses a Spanish mobile caller id, normalised", () => {
    expect(resolveCallerPhone(undefined, "+34612345678")).toEqual({ kind: "caller", phone: "612345678" });
    expect(resolveCallerPhone("", "0034 712 345 678")).toEqual({ kind: "caller", phone: "712345678" });
    expect(resolveCallerPhone("caller", "34612345678")).toEqual({ kind: "caller", phone: "612345678" });
    expect(resolveCallerPhone("  El mismo número ", "612345678")).toEqual({ kind: "caller", phone: "612345678" });
  });

  it("no usable caller id asks for a mobile", () => {
    expect(resolveCallerPhone("caller", undefined)).toEqual({ kind: "unavailable", reason: "missing" });
    expect(resolveCallerPhone("caller", "")).toEqual({ kind: "unavailable", reason: "missing" });
    expect(resolveCallerPhone("caller", "anonymous")).toEqual({ kind: "unavailable", reason: "not_spanish" });
    expect(resolveCallerPhone("caller", "+447700900123")).toEqual({ kind: "unavailable", reason: "not_spanish" });
    expect(resolveCallerPhone("caller", "+34910123456")).toEqual({ kind: "unavailable", reason: "not_mobile" });
  });

  it("a digitless value that is not a marker is left to the old refusal", () => {
    expect(resolveCallerPhone("Desconocido", "+34612345678")).toEqual({ kind: "dictated" });
  });

  it("the flag defaults to false", () => {
    testEnv();
    delete process.env["VOICE_CALLER_ID_PHONE_ENABLED"];
    resetEnvCache();
    expect(loadEnv().VOICE_CALLER_ID_PHONE_ENABLED).toBe(false);
    process.env["VOICE_CALLER_ID_PHONE_ENABLED"] = "true";
    resetEnvCache();
    expect(loadEnv().VOICE_CALLER_ID_PHONE_ENABLED).toBe(true);
    delete process.env["VOICE_CALLER_ID_PHONE_ENABLED"];
    resetEnvCache();
  });
});

const DATE = "2026-10-10"; // Saturday
const CALLER = "+34612345678";
const CARLOS = { customer_name: "Carlos", customer_surnames: "García", confirmed_by_customer: true };

interface DiaryRow {
  id: number;
  reservationDate: string;
  ownerName: string;
  ownerSurnames: string;
  ownerPhone: string;
  typeReservation: number;
  employee: { id: number; name: string; surnames: string };
}

/** The salon (same shape as tests/vozArreglos20261008.test.ts). */
function fakeSalon() {
  const rows: DiaryRow[] = [];
  const deletes: number[] = [];
  let nextId = 7000;
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
        employee: b["employee"] as { id: number; name: string; surnames: string },
      });
      return [201, ""];
    });
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/reservation/dashboard`)
    .query(true)
    .reply(() => [200, rows]);
  nock(UPSTREAM)
    .persist()
    .get(/\/v1\/reservation\/delete\/\d+$/)
    .reply((uri) => {
      const id = Number(uri.split("/").at(-1));
      deletes.push(id);
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return [404, {}];
      rows.splice(index, 1);
      return [200, {}];
    });
  return { rows, deletes, creates: () => nextId - 7000 };
}

function callerEnv(enabled: boolean): void {
  testEnv({
    ENABLE_MULTI_BARBER: "true",
    ENABLE_WRITE_OPERATIONS: "true",
    ENABLE_CREATE_BOOKING: "true",
    ENABLE_BALANCED_V2_CREATE: "true",
    BOOKING_BOOKING_OWNER_MODE: "guest",
    WA_SELF_SERVICE_MODE: "live",
    WA_SELF_SERVICE_SECRET: "wa-self-service-secret-0123456789abcdef",
    WA_REF_SECRET: "wa-ref-secret-0123456789abcdefghijklmn",
    BOOKING_EMPLOYEE_USERNAME: "asistente-ia",
    BOOKING_EMPLOYEE_PASSWORD: "not-a-real-employee-password",
    VOICE_CHANGE_BOOKING_ENABLED: "true",
    VOICE_CALLER_ID_PHONE_ENABLED: enabled ? "true" : "false",
  });
}

