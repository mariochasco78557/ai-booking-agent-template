import { describe, it, expect } from "vitest";

import { SLOT_TOKEN_SECRET } from "./helpers/testApp.js";
import { BRUNO } from "./helpers/balancedV2.js";
import {
  BalancedAvailabilityService,
  type OwnBookingPort,
} from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import { SlotAuthorizationService } from "../src/services/slotAuthorization.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";

/**
 * Bloque 0 of (internal doc, not included in the template) §3: `own_booking_at_time`.
 * The hour asked for is the caller's OWN standing appointment: nothing is
 * offered or locked. Fails open.
 */

const NOW = Date.parse("2026-10-06T08:00:00Z");
const DATE = "2026-10-10"; // a Saturday
const PHONE = "+34600000123";

function day(date: string): AgendaDay {
  return {
    date,
    serviceId: "1",
    employees: [BRUNO],
    free: [
      {
        id: BRUNO.id,
        name: BRUNO.name,
        surnames: BRUNO.surnames,
        date: `${date} 14:00:00`,
        slots: ["09:30", "10:00", "13:30"].map((t) => ({ start: `${date} ${t}:00`, end: `${date} ${t}:00` })),
      },
    ],
    fetchedAtMs: NOW,
    upstreamCalls: 2,
  };
}

function build(port?: OwnBookingPort): BalancedAvailabilityService {
  const agenda: AgendaReader = {
    read: async (date) => ({ day: day(date), outcome: "hit" as const, ageMs: 0 }),
    readFresh: async (date) => ({ day: day(date), outcome: "bypass" as const, ageMs: 0 }),
    invalidate: () => 0,
  };
  return new BalancedAvailabilityService({
    agenda,
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 8 }),
    slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
    offerStore: new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 8, digestKey: SLOT_TOKEN_SECRET }),
    closedWeekdays: new Set([0, 1]),
    minLeadMinutes: 0,
    ...(port ? { ownBookingAt: port } : {}),
  });
}

const OWN_EMPLOYEE = 1;
const own: OwnBookingPort = async (phone, date, time, employeeId) =>
  phone === PHONE && date === DATE && time === "13:30" && employeeId === OWN_EMPLOYEE
    ? { employeeName: "ramón" }
    : undefined;

const discoverBody = (extra: Record<string, unknown> = {}) => ({
  conversation_id: "conv_own",
  service_id: 1,
  date: DATE,
  time_period: "afternoon",
  preferred_time: "13:30",
  employee_id: OWN_EMPLOYEE,
  ...extra,
});

describe("own_booking_at_time", () => {
  it("WhatsApp discover: the literal sentence, nothing offered", async () => {
    const result = await build(own).discover(discoverBody(), NOW, { whatsApp: true, callerPhoneE164: PHONE });
    expect(result.outcome).toBe("own_booking_at_time");
    expect(result.options).toEqual([]);
    expect(result.message).toBe(
      "A esa hora ya tienes tu cita del sábado 10 de octubre a las 13:30 con Ramón. ¿Quieres cambiarle el servicio o prefieres otra hora?",
    );
  });

  it("voice discover: the voice sentence, no date or digits", async () => {
    const result = await build(own).discover(discoverBody(), NOW, { callerPhoneE164: PHONE });
    expect(result.outcome).toBe("own_booking_at_time");
    expect(result.message).toBe(
      "A esa hora ya tienes tu cita con Ramón. ¿Quieres cambiarle el servicio o prefieres otra hora?",
    );
  });

  it("one-day scan with preferred_time is guarded too", async () => {
    const result = await build(own).scan(
      { conversation_id: "conv_own", service_id: 1, date_from: DATE, days: 1, preferred_time: "13:30", employee_id: OWN_EMPLOYEE },
      NOW,
      { whatsApp: true, callerPhoneE164: PHONE },
    );
    expect(result.outcome).toBe("own_booking_at_time");
  });

  it("lock of that hour is refused and nothing is locked", async () => {
    const service = build(own);
    await service.discover(discoverBody({ preferred_time: undefined, time_period: "afternoon" }), NOW, { whatsApp: true });
    const hours = await service.discover(
      { conversation_id: "conv_own", service_id: 1, date: DATE, time_period: "afternoon" },
      NOW,
    );
    const index = (hours.options as Array<{ time: string }>).findIndex((o) => o.time === "13:30");
    expect(index).toBeGreaterThanOrEqual(0);
    const locked = await service.lock({ conversation_id: "conv_own", option_index: index + 1, preferred_employee_id: OWN_EMPLOYEE }, NOW, {
      whatsApp: true,
      callerPhoneE164: PHONE,
    });
    expect(locked.outcome).toBe("own_booking_at_time");
    expect(locked.locked).toBe(false);
    expect(locked.slot).toBeUndefined();
  });

  it("another hour, another number, or no verified phone: the answer of always", async () => {
    const service = build(own);
    expect((await service.discover(discoverBody({ preferred_time: "10:00", time_period: "morning" }), NOW, { callerPhoneE164: PHONE })).outcome).toBe("options_available");
    expect((await service.discover(discoverBody(), NOW, { callerPhoneE164: "+34611111111" })).outcome).toBe("options_available");
    expect((await service.discover(discoverBody(), NOW, {})).outcome).toBe("options_available");
  });

  it("without employee_id nothing is blocked; with another professional neither", async () => {
    const service = build(own);
    const options = { whatsApp: true, callerPhoneE164: PHONE };
    expect((await service.discover(discoverBody({ employee_id: undefined }), NOW, options)).outcome).toBe("options_available");
    expect((await service.discover(discoverBody({ employee_id: 3 }), NOW, options)).outcome).not.toBe("own_booking_at_time");
    const hours = await service.discover({ conversation_id: "conv_own2", service_id: 1, date: DATE, time_period: "afternoon" }, NOW);
    const index = (hours.options as Array<{ time: string }>).findIndex((o) => o.time === "13:30");
    const locked = await service.lock({ conversation_id: "conv_own2", option_index: index + 1 }, NOW, options);
    expect(locked.outcome).toBe("locked");
  });

  it("fails open when the lookup throws", async () => {
    const failing: OwnBookingPort = async () => {
      throw new Error("dashboard down");
    };
    const result = await build(failing).discover(discoverBody(), NOW, { callerPhoneE164: PHONE });
    expect(result.outcome).toBe("options_available");
  });
});
