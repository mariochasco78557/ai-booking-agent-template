import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { BASE_PATH, UPSTREAM, WEBHOOK_SECRET, buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { RAMON, conv, mockAgendaDay, v2, v2Book, type AgendaFixture } from "./helpers/balancedV2.js";
import {
  MSG_MANAGE_BY_WHATSAPP,
  MSG_NOT_LISTED,
  VoiceManageService,
  msgBookingsFound,
  msgCancelledVoice,
  msgConfirmCancel,
  resolveManageCaller,
} from "../src/services/voiceManage/voiceManageService.js";
import {
  balancedChangeOldNotCancelledMessage,
  balancedPossibleDuplicateMessage,
  spokenAppointmentEs,
} from "../src/utils/balancedPhrasing.js";

/**
 * 2026-10-10 — the voice agent consults, cancels and changes EXISTING
 * bookings, only those of the number that is calling
 * (internal doc, not included in the template), plus the in-call change of the
 * real call conv_5401m4dvaaayeksa3bbz77pp3x4v (booking 89307).
 *
 * Everything runs against a fake salon (nock); nothing touches production.
 */

const V5 = { agent_profile: "v5" } as const;
const DATE = "2026-10-10"; // Saturday
const CALLER = "+34600000123";
const OTHER = "+34600000999";
const WA_SECRET = "wa-self-service-secret-0123456789abcdef";
const REF_SECRET = "wa-ref-secret-0123456789abcdefghijklmn";
const BOOKING_SECRET = "booking-secret-0123456789abcdefghij";
const CARLOS = {
  customer_name: "Carlos",
  customer_surnames: "García",
  phone: "600000123",
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

function row(id: number, reservationDate: string, ownerPhone = "600000123"): DiaryRow {
  return {
    id,
    reservationDate,
    ownerName: "Carlos",
    ownerSurnames: "García",
    ownerPhone,
    typeReservation: 1,
    employee: RAMON,
  };
}

/** Create answers an empty 201 (as in production), the dashboard lists the diary, delete removes. */
function fakeSalon(initial: DiaryRow[] = [], opts: { deleteFails?: boolean } = {}) {
  const rows: DiaryRow[] = [...initial];
  const deletes: number[] = [];
  let nextId = 9000;
  let creates = 0;
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply((_uri, body) => {
      const b = body as Record<string, unknown>;
      creates += 1;
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
    .reply(() => [200, rows]);
  nock(UPSTREAM)
    .persist()
    .get(/\/v1\/reservation\/delete\/\d+$/)
    .reply((uri) => {
      const id = Number(uri.split("/").at(-1));
      deletes.push(id);
      if (opts.deleteFails) return [500, { message: "boom" }];
      const index = rows.findIndex((r) => r.id === id);
      if (index === -1) return [404, {}];
      rows.splice(index, 1);
      return [200, {}];
    });
  return { rows, deletes, creates: () => creates };
}

function manageEnv(overrides: Record<string, string> = {}): void {
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
    VOICE_MANAGE_BOOKINGS_ENABLED: "true",
    ...overrides,
  });
}


describe("voz · gestionar citas (unidad)", () => {
  const silent = { info: vi.fn(), warn: vi.fn() };
  const NOW = Date.parse("2026-10-08T08:00:00Z");

  it("solo un número español sirve como caller id", () => {
    expect(resolveManageCaller("+34600000123")).toBe("+34600000123");
    expect(resolveManageCaller("600000123")).toBe("+34600000123");
    expect(resolveManageCaller("+34910000000")).toBe("+34910000000");
    for (const raw of [undefined, null, "", "anonymous", "private", "+447700900123", 600000123]) {
      expect(resolveManageCaller(raw), String(raw)).toBeUndefined();
    }
  });

  it("idempotencia en paralelo: dos «sí» a la vez anulan una sola vez", async () => {
    let deletes = 0;
    const self = {
      listForVoice: vi.fn(async () => ({
        ok: true as const,
        rows: [
          {
            id: 1,
            startsAt: "2026-10-10 09:30",
            ownerPhoneE164: "+34600000123",
            ownerName: "",
            ownerSurnames: "",
            employeeId: 3,
            employeeName: "Ramón",
            typeReservation: 1,
            state: "active" as const,
          },
        ],
      })),
      cancelForVoice: vi.fn(async () => {
        deletes += 1;
        return { outcome: "cancelled", idempotency_status: "original" };
      }),
    };
    const svc = new VoiceManageService({ enabled: true }, self, silent);
    const body = { conversation_id: "conv_unit_parallel", caller_phone: "+34600000123" };
    await svc.myBookings(body, NOW);
    const req = { ...body, booking_index: 1, confirmed_by_customer: true };
    expect((await svc.cancel(req, NOW)).outcome).toBe("confirm_required");
    const [a, b] = await Promise.all([svc.cancel(req, NOW + 5_000), svc.cancel(req, NOW + 5_000)]);
    expect(a.outcome).toBe("cancelled");
    expect(b.outcome).toBe("cancelled");
    expect([a.idempotency_status, b.idempotency_status].sort()).toEqual(["original", "replayed"]);
    expect(deletes).toBe(1);
  });

  it("el log no lleva teléfono, nombre ni id de reserva", async () => {
    const info = vi.fn();
    const self = {
      listForVoice: vi.fn(async () => ({
        ok: true as const,
        rows: [
          {
            id: 89307,
            startsAt: "2026-10-10 09:30",
            ownerPhoneE164: "+34600000123",
            ownerName: "Héctor",
            ownerSurnames: "X",
            employeeId: 3,
            employeeName: "Ramón",
            typeReservation: 1,
            state: "active" as const,
          },
        ],
      })),
      cancelForVoice: vi.fn(async () => ({ outcome: "cancelled" })),
    };
    const svc = new VoiceManageService({ enabled: true }, self, { info, warn: vi.fn() });
    const body = { conversation_id: "conv_unit_logs_abcdef", caller_phone: "+34600000123" };
    await svc.myBookings(body, NOW);
    await svc.cancel({ ...body, booking_index: 1, confirmed_by_customer: true }, NOW);
    await svc.cancel({ ...body, booking_index: 1, confirmed_by_customer: true }, NOW + 5_000);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toMatch(/600000123|89307|Héctor/);
    expect(logged).toContain("cancelled");
  });

  it("frase del día completo", () => {
    expect(spokenAppointmentEs("2026-10-13 16:30")).toBe("el martes trece de octubre a las cuatro y media de la tarde");
  });
});
