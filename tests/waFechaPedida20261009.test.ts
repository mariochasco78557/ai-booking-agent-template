/**
 * 2026-10-09 — WhatsApp, «el próximo jueves» (owner's rule):
 *  1. A weekday the customer wrote is ALWAYS the nearest such day from the
 *     date of the message (`day_name`, WhatsApp channel), whatever `date` said.
 *  2. If that day has no hueco, the answer SAYS SO AND ASKS — no other day is
 *     read, offered or made lockable until the customer says yes.
 * Voice keeps its look-ahead, unchanged. Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import { SLOT_TOKEN_SECRET } from "./helpers/testApp.js";
import { withDay, BRUNO, OLGA } from "./helpers/balancedV2.js";
import { SlotAuthorizationService } from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaRead } from "../src/services/agenda/agendaCache.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";
import { parseDayName, resolveDayName } from "../src/utils/dayName.js";
import { balancedAskOtherDayMessage } from "../src/utils/balancedPhrasing.js";

// Friday 2026-10-09, 12:00 Madrid.
const NOW = Date.parse("2026-10-09T10:00:00Z");
const TODAY = "2026-10-09";
const ROSTER = [BRUNO, OLGA];
type Fixture = Record<string, Record<number, string[]>>;

function dayOf(date: string, free: Record<number, string[]> | undefined): AgendaDay {
  return {
    date,
    serviceId: "1",
    employees: ROSTER,
    free: ROSTER.flatMap((employee) => {
      const times = free?.[employee.id] ?? [];
      if (times.length === 0) return [];
      return [
        {
          id: employee.id,
          name: employee.name,
          surnames: employee.surnames,
          date: `${date} 14:00:00`,
          slots: times.map((time) => ({ start: `${date} ${time}:00`, end: `${date} ${time}:00` })),
        },
      ];
    }),
    fetchedAtMs: NOW,
    upstreamCalls: 2,
  };
}

function harness(fixture: Fixture) {
  const reads: string[] = [];
  const agenda: AgendaReader = {
    read: async (date): Promise<AgendaRead> => {
      reads.push(date);
      return { day: dayOf(date, fixture[date]), outcome: "miss", ageMs: 0 };
    },
    readFresh: async (date) => ({ day: dayOf(date, fixture[date]), outcome: "bypass", ageMs: 0 }),
    invalidate: () => 0,
  };
  const service = new BalancedAvailabilityService({
    agenda,
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
    offerStore: new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    scanDeadlineMs: 500,
    logger: { warn: () => undefined, info: () => undefined },
  });
  return { service, reads };
}

const CONV = "conv_test_wa_fecha";
const WA = { whatsApp: true } as const;

function discoverBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { conversation_id: CONV, service_id: 1, date: "2026-10-15", time_period: "morning", ...extra };
}

// The 15th (the nearest Thursday) is full; the 16th and the 29th have hours.
const FULL_15: Fixture = {
  "2026-10-15": {},
  "2026-10-16": { [BRUNO.id]: ["10:00", "10:30"] },
  "2026-10-22": { [BRUNO.id]: ["11:00"] },
  "2026-10-29": { [BRUNO.id]: ["11:00"] },
};

describe("1 · a weekday is the nearest one from the message date (WhatsApp)", () => {
  it("pure: on Friday 9, «jueves» / «el próximo jueves» is the 15th, whatever date was sent", () => {
    for (const word of ["jueves", "el jueves", "el próximo jueves", "Próximo jueves", "este jueves"]) {
      const d = parseDayName(word);
      expect(d, word).toBeDefined();
      for (const sent of ["2026-10-15", "2026-10-22", "2026-10-29", undefined]) {
        expect(resolveDayName(d!, sent, TODAY, { nearestFromToday: true }), `${word} ${sent}`).toBe("2026-10-15");
      }
    }
    // Today counts: «viernes» written on a Friday is today.
    expect(resolveDayName(parseDayName("viernes")!, "2026-10-16", TODAY, { nearestFromToday: true })).toBe(TODAY);
    // hoy / mañana unchanged.
    expect(resolveDayName(parseDayName("mañana")!, "2026-10-29", TODAY, { nearestFromToday: true })).toBe("2026-10-10");
  });

  it("voice keeps its rule (a weekday that agrees with the date keeps that week)", () => {
    expect(resolveDayName(parseDayName("jueves")!, "2026-10-29", TODAY)).toBe("2026-10-29");
  });

  it("discover on WhatsApp: date 29 + day_name «el próximo jueves» searches the 15th, and says so", async () => {
    const { service, reads } = harness({ "2026-10-15": { [BRUNO.id]: ["10:00"] }, "2026-10-29": { [BRUNO.id]: ["11:00"] } });
    const r = await service.discover(discoverBody({ date: "2026-10-29" }), NOW, { ...WA, dayName: "el próximo jueves" });
    expect(r.outcome).toBe("options_available");
    expect(r.date_corrected_from).toBe("2026-10-29");
    expect(r.options.map((o) => o.date)).toEqual(["2026-10-15"]);
    expect(r.message).toMatch(/jueves quince/);
    expect(reads).toEqual(["2026-10-15"]);
  });

  it("scan on WhatsApp: date_from follows day_name to the nearest day", async () => {
    const { service } = harness({ "2026-10-15": { [BRUNO.id]: ["10:00"] } });
    const r = await service.scan(
      { conversation_id: CONV, service_id: 1, date_from: "2026-10-29", days: 1, after_time: "09:30" },
      NOW,
      { ...WA, dayName: "jueves" },
    );
    expect(r.date_corrected_from).toBe("2026-10-29");
    expect(r.options.map((o) => o.date)).toEqual(["2026-10-15"]);
  });
});

describe("2 · no hueco that day: say so and ASK, never another day (WhatsApp)", () => {
  it("full day -> no_availability, the question, no other day read, nothing lockable", async () => {
    const { service, reads } = harness(FULL_15);
    const r = await service.discover(discoverBody(), NOW, { ...WA, dayName: "jueves" });
    expect(r.outcome).toBe("no_availability");
    expect(r.available).toBe(false);
    expect(r.options).toEqual([]);
    expect(r.date_fallback).toBeUndefined();
    expect(r.message).toBe("El jueves quince no me queda hueco. ¿Quieres que te mire otro día?");
    expect(r.requested_date).toBe("2026-10-15");
    expect(r.next_search_from).toBe("2026-10-16");
    expect(reads).toEqual(["2026-10-15"]);
    const lock = await service.lock({ conversation_id: CONV, option_index: 1 }, NOW);
    expect(lock.locked).toBe(false);
  });

  it("with a professional named and full: same question, never the 29th with him", async () => {
    const { service, reads } = harness(FULL_15);
    const r = await service.discover(discoverBody({ employee_id: BRUNO.id, preferred_time: "11:00" }), NOW, WA);
    expect(r.outcome).toBe("no_availability");
    expect(JSON.stringify(r)).not.toContain("2026-10-29");
    expect(reads).toEqual(["2026-10-15"]);
  });

  it("the other half of the SAME day is still offered (it is the day asked for)", async () => {
    const { service } = harness({ "2026-10-15": { [BRUNO.id]: ["17:00"] } });
    const r = await service.discover(discoverBody(), NOW, WA);
    expect(r.outcome).toBe("options_available");
    expect(r.options.map((o) => o.date)).toEqual(["2026-10-15"]);
  });

  it("a closed weekday reached on WhatsApp is said and asked, not jumped", async () => {
    const { service, reads } = harness({ "2026-10-13": { [BRUNO.id]: ["10:00"] } });
    const r = await service.discover(discoverBody({ date: "2026-10-12" }), NOW, WA); // Monday
    expect(r.outcome).toBe("no_availability");
    expect(r.message).toBe(withDay("Los lunes cerramos. ¿Quieres que te mire otro día?", "2026-10-12", NOW));
    expect(reads).toEqual([]);
  });

  it("a one-day scan of a closed day on WhatsApp asks too", async () => {
    const { service, reads } = harness({ "2026-10-13": { [BRUNO.id]: ["10:00"] } });
    const r = await service.scan(
      { conversation_id: CONV, service_id: 1, date_from: "2026-10-12", days: 1, time_period: "morning" },
      NOW,
      WA,
    );
    expect(r.outcome).toBe("no_availability");
    expect(r.options).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("after the customer's «sí», a scan from next_search_from finds the nearest day", async () => {
    const { service } = harness(FULL_15);
    const r = await service.scan(
      { conversation_id: CONV, service_id: 1, date_from: "2026-10-16", days: 7, time_period: "morning" },
      NOW,
      WA,
    );
    expect(r.outcome).toBe("options_available");
    expect(r.options[0]!.date).toBe("2026-10-16");
  });

  it("voice (no WhatsApp flag) keeps the look-ahead exactly as before", async () => {
    const { service } = harness(FULL_15);
    const r = await service.discover(discoverBody(), NOW, {});
    expect(r.outcome).toBe("options_available");
    expect(r.date_fallback).toBe(true);
    expect(r.options[0]!.date).toBe("2026-10-16");
  });

  it("message builder", () => {
    expect(balancedAskOtherDayMessage({ reason: "full", requestedDate: "2026-10-15" })).toBe(
      "El jueves quince no me queda hueco. ¿Quieres que te mire otro día?",
    );
    expect(balancedAskOtherDayMessage({ reason: "closed", requestedDate: "2026-10-17", afternoonOnly: true })).toBe(
      "El sábado diecisiete por la tarde cerramos. ¿Quieres que te mire otro día?",
    );
  });
});
