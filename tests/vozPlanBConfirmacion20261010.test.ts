import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { BASE_PATH, UPSTREAM, buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { RAMON, conv, mockAgendaDay, v2, v2Book, type AgendaFixture } from "./helpers/balancedV2.js";
import {
  DICTATED_MAX_PER_NUMBER,
  MSG_DICTATED_LIMIT,
  MSG_DICTATED_NOT_FOUND_FINAL,
  MSG_DICTATED_NOT_FOUND_RETRY,
  MSG_MANAGE_BY_WHATSAPP,
  MSG_NO_BOOKINGS_ASK_OTHER,
  MSG_PHONE_NEEDED,
  VoiceManageService,
  firstNameKey,
  msgConfirmCancel,
} from "../src/services/voiceManage/voiceManageService.js";
import { formatCancellationMessage } from "../src/services/ownerNotify/ownerMessages.js";
import { CALLER_PHONE_UNAVAILABLE_MESSAGE } from "../src/utils/phrasing.js";

/**
 * 2026-10-10 (internal doc, not included in the template):
 * - A/B: what the customer says «sí» to is written by the server (real calls
 *   conv_…1rg: invented hour + cancel in the same turn; conv_…pk7: «¿Te la
 *   anulo?» without the date).
 * - C: plan B with a dictated phone + the booking's first name.
 * Fake salon (nock); test numbers only; nothing touches production.
 */

const V5 = { agent_profile: "v5" } as const;
const DATE = "2026-10-10"; // Saturday
const CALLER = "+34600000123";
const OTHER_NATIONAL = "600000999";

interface DiaryRow {
  id: number;
  reservationDate: string;
  ownerName: string;
  ownerSurnames: string;
  ownerPhone: string;
  typeReservation: number;
  employee: { id: number; name: string; surnames: string };
}

function row(id: number, reservationDate: string, ownerPhone = "600000123", ownerName = "Carlos"): DiaryRow {
  return { id, reservationDate, ownerName, ownerSurnames: "García", ownerPhone, typeReservation: 1, employee: RAMON };
}

function fakeSalon(initial: DiaryRow[] = []) {
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
  nock(UPSTREAM).persist().get(`${BASE_PATH}/reservation/dashboard`).query(true).reply(() => [200, rows]);
  nock(UPSTREAM)
    .persist()
    .get(/\/v1\/reservation\/delete\/\d+$/)
    .reply((uri) => {
      const id = Number(uri.split("/").at(-1));
      deletes.push(id);
      const index = rows.findIndex((r) => r.id === id);
      if (index === -1) return [404, {}];
      rows.splice(index, 1);
      return [200, {}];
    });
  return { rows, deletes, creates: () => creates };
}

function planBEnv(overrides: Record<string, string> = {}): void {
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
    VOICE_CALLER_ID_PHONE_ENABLED: "true",
    VOICE_MANAGE_BOOKINGS_ENABLED: "true",
    VOICE_MANAGE_DICTATED_PHONE_ENABLED: "true",
    ...overrides,
  });
}


describe("voz · plan B (unidad)", () => {
  const silent = { info: vi.fn(), warn: vi.fn() };
  const NOW = Date.parse("2026-10-08T08:00:00Z");
  const rowOf = (ownerName: string) => ({
    id: 77,
    startsAt: "2026-10-10 09:30",
    ownerPhoneE164: "+34600000999",
    ownerName,
    ownerSurnames: "",
    employeeId: 3,
    employeeName: "Ramón",
    typeReservation: 1,
    state: "active" as const,
  });

  it("límite global por número dictado entre llamadas", async () => {
    const self = {
      listForVoice: vi.fn(async () => ({ ok: true as const, rows: [rowOf("Carlos")] })),
      cancelForVoice: vi.fn(async () => ({ outcome: "cancelled" })),
    };
    const svc = new VoiceManageService({ enabled: true, dictatedEnabled: true }, self, silent);
    const ask = (i: number, at: number) =>
      svc.myBookings({ conversation_id: `conv_unit_rate_${i}`, dictated_phone: "600000999", customer_name: "Carlos" }, at);
    for (let i = 0; i < DICTATED_MAX_PER_NUMBER; i += 1) expect((await ask(i, NOW + i)).outcome).toBe("bookings_found");
    expect((await ask(99, NOW + 100)).outcome).toBe("dictated_limit");
    expect(self.listForVoice).toHaveBeenCalledTimes(DICTATED_MAX_PER_NUMBER);
    // A day later the number may be looked up again.
    expect((await ask(100, NOW + 24 * 3_600_000 + 1)).outcome).toBe("bookings_found");
  });

  it("la anulación con número dictado va marcada para el aviso a Bruno", async () => {
    const self = {
      listForVoice: vi.fn(async () => ({ ok: true as const, rows: [rowOf("María")] })),
      cancelForVoice: vi.fn(async () => ({ outcome: "cancelled" })),
    };
    const svc = new VoiceManageService({ enabled: true, dictatedEnabled: true }, self, silent);
    const body = { conversation_id: "conv_unit_via_dictated", dictated_phone: "600000999", customer_name: "maria" };
    expect((await svc.myBookings(body, NOW)).outcome).toBe("bookings_found");
    const req = { conversation_id: body.conversation_id, booking_index: 1, confirmed_by_customer: true };
    expect((await svc.cancel(req, NOW)).outcome).toBe("confirm_required");
    expect((await svc.cancel(req, NOW + 4_000)).outcome).toBe("cancelled");
    expect(self.cancelForVoice).toHaveBeenCalledWith(expect.objectContaining({ via: "dictated" }), NOW + 4_000);
  });

  it("aviso de Telegram: «número dictado» solo cuando lo es", () => {
    const base = {
      kind: "cancellation_done" as const,
      startsAt: "2026-10-10 09:30",
      professional: "Ramón",
      service: null,
      ownerName: "X",
      ownerSurnames: "Y",
      callerPhoneE164: "+34600000999",
    };
    expect(formatCancellationMessage(base).split("\n")[0]).toBe("ANULADA por WhatsApp");
    expect(formatCancellationMessage({ ...base, via: "dictated" }).split("\n")[0]).toBe("ANULADA por llamada (número dictado)");
    expect(formatCancellationMessage({ ...base, via: "dictated_change" }).split("\n")[0]).toContain("número dictado");
    expect(
      formatCancellationMessage({ ...base, kind: "cancellation_request", motive: "mode", via: "dictated" }).split("\n")[0],
    ).toContain("número dictado");
  });

  it("nombre normalizado: sin tildes, sin mayúsculas, primer nombre", () => {
    expect(firstNameKey("  JOSÉ Luis ")).toBe("jose");
    expect(firstNameKey("María")).toBe(firstNameKey("maria"));
    expect(firstNameKey("Íñigo")).toBe("inigo");
    for (const raw of [undefined, "", "a", 42, "  "]) expect(firstNameKey(raw), String(raw)).toBeUndefined();
  });
});
