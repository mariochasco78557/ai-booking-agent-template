import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { BASE_PATH, UPSTREAM, buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { RAMON, conv, mockAgendaDay, v2, v2Book } from "./helpers/balancedV2.js";
import { balancedBookTimeMismatchMessage } from "../src/utils/balancedPhrasing.js";
import { readExpectedOption, readOptionTime } from "../src/utils/expectedOption.js";

/**
 * 2026-10-09 — (internal doc, not included in the template), hallazgo 1:
 * the create says which hour it confirms (`option_time` / `option_date`) and
 * the server refuses to book a slot token holding another hour.
 *
 * The incident shape: 09:30 is locked; a second lock (11:00) fails, so the
 * server keeps 09:30 bookable and the platform keeps the 09:30 token; the model
 * misses the failure, reads «11:00» in the summary and creates with the old
 * token. Fictitious customer data only.
 */

const V5 = { agent_profile: "v5" } as const;
const DATE = "2026-10-10"; // Saturday
const FAKE = {
  customer_name: "Ane",
  customer_surnames: "Prueba Ficticia",
  phone: "600000123",
  confirmed_by_customer: true,
};
const WHATSAPP = { "x-ai-channel": "whatsapp" };

function fakeSalon() {
  let creates = 0;
  const rows: Array<Record<string, unknown>> = [];
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply((_uri, body) => {
      creates += 1;
      const b = body as Record<string, unknown>;
      rows.push({
        id: 9000 + creates,
        reservationDate: String(b["reservationDate"]),
        ownerName: String(b["ownerName"]),
        ownerSurnames: String(b["ownerSurnames"]),
        ownerPhone: String(b["ownerPhone"]),
        typeReservation: Number(b["typeReservation"]),
        employee: b["employee"],
      });
      return [201, ""];
    });
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/reservation/dashboard`)
    .query(true)
    .reply(() => [200, rows]);
  return { creates: () => creates, rows };
}

function writeEnv(): void {
  testEnv({
    ENABLE_MULTI_BARBER: "true",
    ENABLE_WRITE_OPERATIONS: "true",
    ENABLE_CREATE_BOOKING: "true",
    ENABLE_BALANCED_V2_CREATE: "true",
    BOOKING_BOOKING_OWNER_MODE: "guest",
  });
}

describe("hallazgo 1 · readers and sentence", () => {
  it("reads the same hour shapes the lock reads", () => {
    expect(readOptionTime("9:30")).toBe("09:30");
    expect(readOptionTime("19.00")).toBe("19:00");
    expect(readOptionTime("19h00")).toBe("19:00");
    expect(readOptionTime("19:00:00")).toBe("19:00");
    expect(readOptionTime("7 de la tarde")).toBeUndefined();
    expect(readExpectedOption({ optionTime: "x", optionDate: "2026-02-30" })).toBeUndefined();
    expect(readExpectedOption({ optionDate: "2026-10-10" })).toEqual({ date: "2026-10-10" });
  });

  it("says both hours with their half of the day (07:00 is never confused with 19:00)", () => {
    expect(balancedBookTimeMismatchMessage({ time: "19:00", date: DATE }, { time: "07:00" })).toBe(
      "La hora que tengo apartada es la de las siete de la tarde, no la de las siete de la mañana. Confírmame cuál quieres.",
    );
    expect(balancedBookTimeMismatchMessage({ time: "13:00", date: DATE }, { time: "12:30" })).toBe(
      "La hora que tengo apartada es la de la una del mediodía, no la de las doce y media del mediodía. Confírmame cuál quieres.",
    );
  });

  it("names both days when the date differs", () => {
    expect(
      balancedBookTimeMismatchMessage({ time: "09:30", date: "2026-10-10" }, { time: "09:30", date: "2026-10-13" }),
    ).toBe(
      "La cita que tengo apartada es la del sábado diez a las nueve y media de la mañana, no la del martes trece a las nueve y media de la mañana. Confírmame cuál quieres.",
    );
  });
});

