import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { BASE_PATH, UPSTREAM, buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { withDay, RAMON, conv, mockAgendaDay, v2, v2Book, type AgendaFixture } from "./helpers/balancedV2.js";
import { readCustomerIdentity } from "../src/utils/personalData.js";
import { INVALID_CUSTOMER_DATA_MESSAGE, INVALID_PHONE_LENGTH_MESSAGE } from "../src/utils/phrasing.js";
import { parseDayName, resolveDayName } from "../src/utils/dayName.js";
import {
  balancedChangeDoneMessage,
  balancedChangeOldNotCancelledMessage,
  balancedPossibleDuplicateMessage,
  withSpokenDayEs,
} from "../src/utils/balancedPhrasing.js";
import { WaSelfService } from "../src/services/waSelfService/waSelfService.js";
import type { DashboardReservation } from "../src/services/waSelfService/dashboardMapping.js";

/**
 * 2026-10-08 — the three voice fixes (internal doc, not included in the template):
 *
 * 1. a phone of the wrong length is asked again, alone, and the lock survives;
 * 2. `day_name` beats a miscomputed `date` (the exact Thursday 2026-10-08 call);
 * 3. a REAL change of a booking made in the same call (create, then cancel the
 *    old one through the WhatsApp self-service path), plus the duplicate net.
 */

const V5 = { agent_profile: "v5" } as const;
const CARLOS = {
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: "600000123",
  confirmed_by_customer: true,
};

// ── FIX 1 ────────────────────────────────────────────────────────────────────

describe("fix 1 · phone normalisation and the wrong-length rejection", () => {
  const identity = (phone: unknown) =>
    readCustomerIdentity({ name: "Carlos", surnames: "García", phone });

  it.each([
    ["600000123", "600000123"],
    ["+34600000123", "600000123"],
    ["+34 600 000 123", "600000123"],
    ["0034600000123", "600000123"],
    ["34600000123", "600000123"],
    ["600.000.123", "600000123"],
    ["600-00-01-23", "600000123"],
    ["(600) 000 123", "600000123"],
  ])("%s is the nine digits %s", (raw, expected) => {
    const result = identity(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.phone).toBe(expected);
  });

  it.each(["6000000021", "60000012", "+34 6000000021", "12", "+34"])(
    "%s is phone_wrong_length",
    (raw) => {
      expect(identity(raw)).toEqual({ ok: false, rejection: "phone_wrong_length" });
    },
  );

  it.each(["+44 7700 900123", "512345678", "seis cero cero", "000000000"])(
    "%s is still invalid_phone",
    (raw) => {
      expect(identity(raw)).toEqual({ ok: false, rejection: "invalid_phone" });
    },
  );

  it("a sentinel is still a placeholder, whatever the prefix", () => {
    expect(identity("+34 666 666 666")).toEqual({ ok: false, rejection: "placeholder_phone" });
  });

  it("the message asks the caller, states nine digits, and never says how many arrived", () => {
    expect(INVALID_PHONE_LENGTH_MESSAGE).toContain("nueve cifras");
    expect(INVALID_PHONE_LENGTH_MESSAGE).toMatch(/otra vez, despacio/);
    expect(INVALID_PHONE_LENGTH_MESSAGE).not.toMatch(/diez|ocho|\d/);
  });
});

// ── FIX 2 ────────────────────────────────────────────────────────────────────

describe("fix 2 · day_name resolution (pure)", () => {
  const TODAY = "2026-10-08"; // Thursday

  it("the exact call of 2026-10-08: «jueves» sent as Friday 9, «viernes» sent as Saturday 10", () => {
    expect(resolveDayName(parseDayName("jueves")!, "2026-10-09", TODAY)).toBe("2026-10-08");
    expect(resolveDayName(parseDayName("viernes")!, "2026-10-10", TODAY)).toBe("2026-10-09");
  });

  it("a weekday that agrees with the date keeps it, even weeks ahead", () => {
    expect(resolveDayName(parseDayName("jueves")!, "2026-10-15", TODAY)).toBe("2026-10-15");
    expect(resolveDayName(parseDayName("Sábado")!, "2026-10-10", TODAY)).toBe("2026-10-10");
  });

  it("a disagreeing weekday moves to the nearest such day, never before today", () => {
    // Sent a week ahead with the wrong weekday: stays in that week.
    expect(resolveDayName(parseDayName("jueves")!, "2026-10-16", TODAY)).toBe("2026-10-15");
    // Nearest backwards would be before today: forwards instead.
    expect(resolveDayName(parseDayName("martes")!, "2026-10-08", TODAY)).toBe("2026-10-13");
    // A date in the past, or none at all: from today, today included.
    expect(resolveDayName(parseDayName("jueves")!, "2026-10-01", TODAY)).toBe("2026-10-08");
    expect(resolveDayName(parseDayName("el viernes")!, undefined, TODAY)).toBe("2026-10-09");
  });

  it("hoy, mañana and pasado mañana are fixed offsets, whatever date said", () => {
    expect(resolveDayName(parseDayName("hoy")!, "2026-10-09", TODAY)).toBe("2026-10-08");
    expect(resolveDayName(parseDayName("mañana")!, "2026-10-08", TODAY)).toBe("2026-10-09");
    expect(resolveDayName(parseDayName("Pasado mañana")!, undefined, TODAY)).toBe("2026-10-10");
  });

  it("anything else is not a day name", () => {
    for (const raw of ["", "el finde", "15", 4, null, "x".repeat(50)]) {
      expect(parseDayName(raw), String(raw)).toBeUndefined();
    }
  });

  it("names the day searched, with its number", () => {
    expect(withSpokenDayEs("Ese día me quedan las cinco, las seis y las siete. ¿Cuál prefieres?", "2026-10-08", TODAY))
      .toBe("Hoy, jueves ocho, me quedan las cinco, las seis y las siete. ¿Cuál prefieres?");
    expect(withSpokenDayEs("Te puedo ofrecer a las diez. ¿Te viene bien?", "2026-10-13", TODAY))
      .toBe("El martes trece te puedo ofrecer a las diez. ¿Te viene bien?");
    expect(withSpokenDayEs("Sí, a las seis tengo hueco. ¿Te viene bien?", "2026-10-09", TODAY))
      .toBe("Sí, mañana, viernes nueve, a las seis tengo hueco. ¿Te viene bien?");
    // Already names its day: untouched.
    const lookAhead = "El jueves ocho no me queda hueco; lo más cercano es el viernes nueve a las diez.";
    expect(withSpokenDayEs(lookAhead, "2026-10-08", TODAY)).toBe(lookAhead);
  });
});


// ── FIX 1 + FIX 3 through the real routes, against a fake salon diary ───────

const DATE = "2026-10-10"; // Saturday
const WA_SECRET = "wa-self-service-secret-0123456789abcdef";
const REF_SECRET = "wa-ref-secret-0123456789abcdefghijklmn";

interface DiaryRow {
  id: number;
  reservationDate: string;
  ownerName: string;
  ownerSurnames: string;
  ownerPhone: string;
  typeReservation: number;
  employee: { id: number; name: string; surnames: string };
}

/** The salon: create answers an empty 201 (as in production), the dashboard
 * lists what was written, delete removes it — or fails, when told to. */
function fakeSalon(opts: { deleteFails?: boolean; slowCreatesFrom?: number; slowMs?: number } = {}) {
  const rows: DiaryRow[] = [];
  const deletes: number[] = [];
  let nextId = 7000;
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply((_uri, body, callback) => {
      const b = body as Record<string, unknown>;
      const employee = b["employee"] as { id: number; name: string; surnames: string };
      nextId += 1;
      rows.push({
        id: nextId,
        reservationDate: String(b["reservationDate"]),
        ownerName: String(b["ownerName"]),
        ownerSurnames: String(b["ownerSurnames"]),
        ownerPhone: String(b["ownerPhone"]),
        typeReservation: Number(b["typeReservation"]),
        employee,
      });
      const slow = opts.slowCreatesFrom !== undefined && nextId - 7000 >= opts.slowCreatesFrom;
      setTimeout(() => callback(null, [201, ""]), slow ? (opts.slowMs ?? 0) : 0);
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
      if (opts.deleteFails) return [500, { message: "boom" }];
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return [404, {}];
      rows.splice(index, 1);
      return [200, {}];
    });
  return { rows, deletes, creates: () => nextId - 7000 };
}

function changeEnv(overrides: Record<string, string> = {}): void {
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


// ── the shared cancel path, directly ─────────────────────────────────────────

describe("fix 3 · WaSelfService.cancelForVoiceChange", () => {
  const NOW = Date.parse("2026-10-08T08:00:00Z");
  const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const row = (id: number, startsAt: string, extra: Partial<DashboardReservation> = {}): DashboardReservation => ({
    id,
    startsAt,
    ownerPhoneE164: "+34600000123",
    ownerName: "IA - Carlos",
    ownerSurnames: "García",
    employeeId: 3,
    employeeName: "Ramón",
    typeReservation: 1,
    state: "active",
    ...extra,
  });

  function setup(rows: DashboardReservation[], mode: "live" | "lookup_only" = "live") {
    const fetchDashboard = vi.fn(async () => ({ rows, stats: { total: rows.length, unparseable: 0 } }));
    const deleteReservation = vi.fn(async () => "deleted" as const);
    const enqueueOwnerAlert = vi.fn(() => true);
    const enqueueCancellation = vi.fn(() => true);
    const svc = new WaSelfService(
      {
        mode,
        allowlist: new Set(),
        refSecret: REF_SECRET,
        refTtlMinutes: 30,
        cancelMinLeadMinutes: 0,
        lookupHorizonDays: 60,
        telegramLive: true,
      },
      { listBookings: fetchDashboard, cancelBookingById: deleteReservation },
      { mode: "live", enqueueOwnerAlert, enqueueCancellation },
      silent,
    );
    return { svc, fetchDashboard, deleteReservation, enqueueOwnerAlert, enqueueCancellation };
  }
  const req = { conversationId: "conv_x", phoneE164: "+34600000123", startsAt: `${DATE} 09:30`, employeeId: 3 };

  it("deletes exactly the row matching phone, start and barber, and notifies the owner", async () => {
    const t = setup([row(1, `${DATE} 09:30`), row(2, `${DATE} 12:00`), row(3, `${DATE} 09:30`, { employeeId: 1 })]);
    expect(t.svc.canCancelForVoiceChange(req.phoneE164, NOW)).toBe(true);
    expect(await t.svc.cancelForVoiceChange(req, NOW)).toBe("cancelled");
    expect(t.deleteReservation).toHaveBeenCalledWith(1);
    expect(t.enqueueCancellation).toHaveBeenCalledTimes(1);
  });

  it("28. cancelForVoice with plan B passes channel voice and via dictated", async () => {
    const t = setup([row(1, `${DATE} 09:30`)]);
    const r = await t.svc.cancelForVoice(
      { phoneE164: req.phoneE164, reservationId: 1, startsAt: req.startsAt, via: "dictated" },
      NOW,
    );
    expect(r.outcome).toBe("cancelled");
    expect(t.enqueueCancellation.mock.calls[0]![0]).toMatchObject({
      kind: "cancellation_done",
      channel: "voice",
      via: "dictated",
    });
  });

  it("31. the answer to the agent is the same with or without changeTo", async () => {
    const plain = setup([row(1, `${DATE} 09:30`)]);
    const withChange = setup([row(1, `${DATE} 09:30`)]);
    const a = await plain.svc.cancelForVoice({ phoneE164: req.phoneE164, reservationId: 1, startsAt: req.startsAt }, NOW);
    const b = await withChange.svc.cancelForVoice(
      {
        phoneE164: req.phoneE164,
        reservationId: 1,
        startsAt: req.startsAt,
        changeTo: { startsAt: `${DATE} 11:00`, professional: "Olga" },
      },
      NOW,
    );
    expect(b).toEqual(a);
    expect(a["owner_notified"]).toBe(true);
  });

  it("29. changeTo reaches the owner notifier with channel voice, in a single cancellation notice", async () => {
    const t = setup([row(1, `${DATE} 09:30`)]);
    const changeTo = { startsAt: `${DATE} 11:00`, professional: "Olga" };
    expect(await t.svc.cancelForVoiceChange({ ...req, changeTo }, NOW)).toBe("cancelled");
    expect(t.enqueueCancellation).toHaveBeenCalledTimes(1);
    expect(t.enqueueCancellation.mock.calls[0]![0]).toMatchObject({
      kind: "cancellation_done",
      channel: "voice",
      changeTo,
    });
  });

  it("zero or several matches cancel nothing and leave the owner a notice", async () => {
    for (const rows of [[row(2, `${DATE} 12:00`)], [row(1, `${DATE} 09:30`), row(4, `${DATE} 09:30`)]]) {
      const t = setup(rows);
      expect(await t.svc.cancelForVoiceChange(req, NOW)).toBe("not_cancelled");
      expect(t.deleteReservation).not.toHaveBeenCalled();
      expect(t.enqueueOwnerAlert).toHaveBeenCalledTimes(1);
    }
  });

  it("not live: refused by the pre-check and by the cancel itself", async () => {
    const t = setup([row(1, `${DATE} 09:30`)], "lookup_only");
    expect(t.svc.canCancelForVoiceChange(req.phoneE164, NOW)).toBe(false);
    expect(await t.svc.cancelForVoiceChange(req, NOW)).toBe("not_cancelled");
    expect(t.deleteReservation).not.toHaveBeenCalled();
  });
});

describe("fix 3 · change sentences", () => {
  it("same day, other day, same hour", () => {
    expect(balancedChangeDoneMessage("2026-10-10 09:30:00", "2026-10-10 12:00:00")).toBe(
      "Hecho: te he cambiado la cita de las nueve y media a las doce.",
    );
    expect(balancedChangeDoneMessage("2026-10-10 09:30:00", "2026-10-13 13:00:00")).toBe(
      "Hecho: te he cambiado la cita del sábado diez a las nueve y media al martes trece a la una.",
    );
    expect(balancedChangeDoneMessage("2026-10-10 09:30:00", "2026-10-10 09:30:00")).toBe(
      "Hecho: te he cambiado de profesional la cita de las nueve y media.",
    );
  });
});

describe("fix 3 · the durable journal keeps the change facts across a restart", () => {
  it("meta round-trips through the file, and the file holds no phone", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FileBookingIdempotencyStore } = await import("../src/services/bookingIdempotencyStore.js");
    const dir = mkdtempSync(join(tmpdir(), "journal-meta-"));
    try {
      const path = join(dir, "j.jsonl");
      const now = Date.parse("2026-10-08T08:00:00Z");
      const meta = { at: "2026-10-10 09:30:00", emp: 3, ph: "a".repeat(64), who: "b".repeat(64), by: 2, cx: "cancelled" as const };
      new FileBookingIdempotencyStore<{ outcome: string }>(path, now).remember("conv_x#1", {
        fingerprint: "f",
        result: { outcome: "confirmed" },
        storedAtMs: now,
        state: "confirmed",
        upstreamAttempted: true,
        meta,
      });
      const reloaded = new FileBookingIdempotencyStore<{ outcome: string }>(path, now + 1000);
      expect(reloaded.get("conv_x#1", now + 1000)?.meta).toEqual(meta);
      expect(readFileSync(path, "utf8")).not.toMatch(/600000123|\+34/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
