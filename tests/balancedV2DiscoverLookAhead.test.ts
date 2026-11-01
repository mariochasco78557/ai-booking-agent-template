import { describe, it, expect } from "vitest";

import { SLOT_TOKEN_SECRET } from "./helpers/testApp.js";
import { withDay, BRUNO, OLGA } from "./helpers/balancedV2.js";
import { SlotAuthorizationService } from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaRead } from "../src/services/agenda/agendaCache.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";
import {
  BALANCED_CLOSED_DAY_MESSAGE,
  BALANCED_NO_AVAILABILITY_MESSAGE,
  balancedLookAheadMessage,
  balancedLookAheadNothingMessage,
} from "../src/utils/balancedPhrasing.js";
import { spokenWeekdayAndDayEs } from "../src/utils/spokenTimeEs.js";

/**
 * BALANCED V2 — the discover LOOK-AHEAD (owner request 2026-09-15).
 *
 * «El agente nunca puede terminar en un "no tengo" a secas»: when the day the
 * caller named has nothing (fully booked, or a closed weekday), `discover`
 * itself reads the following seven days and offers the NEAREST day with hours
 * in the same band, as a normal, lockable page — or, when there is nothing,
 * an open offer of the following week. When the look-ahead cannot be read it
 * falls back to the old sentence, never to an error or an invented hour.
 *
 * Service-level on a stubbed agenda so every date, failure and timing is
 * deterministic. The calendar used (2026):
 *
 *   Sun 20 · Mon 21 · Tue 22 · Wed 23 · Thu 24 · Fri 25 · Sat 26 · Sun 27 ·
 *   Mon 28 · Tue 29 · Wed 30
 */

const NOW = Date.parse("2026-09-15T10:00:00Z");
const RAMON = { id: 3, name: "ramon ", surnames: "demo-salon" };
const ROSTER = [BRUNO, OLGA, RAMON];

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

interface Harness {
  service: BalancedAvailabilityService;
  offers: MemoryVoiceOfferStore;
  /** Every date `agenda.read` was asked for, in call order. */
  reads: string[];
  warnings: Array<Record<string, unknown>>;
}

function harness(
  fixture: Fixture,
  opts: {
    read?: (date: string) => Promise<AgendaRead>;
    scanDeadlineMs?: number;
    closedWeekdays?: ReadonlySet<number>;
  } = {},
): Harness {
  const reads: string[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const plain = async (date: string): Promise<AgendaRead> => ({
    day: dayOf(date, fixture[date]),
    outcome: "miss",
    ageMs: 0,
  });
  const agenda: AgendaReader = {
    read: (date) => {
      reads.push(date);
      return (opts.read ?? plain)(date);
    },
    readFresh: async (date) => ({ day: dayOf(date, fixture[date]), outcome: "bypass", ageMs: 0 }),
    invalidate: () => 0,
  };
  const offers = new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 16 });
  const service = new BalancedAvailabilityService({
    agenda,
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
    offerStore: offers,
    scanDeadlineMs: opts.scanDeadlineMs ?? 500,
    ...(opts.closedWeekdays !== undefined ? { closedWeekdays: opts.closedWeekdays } : {}),
    logger: { warn: (detail) => warnings.push(detail), info: () => undefined },
  });
  return { service, offers, reads, warnings };
}

const CONV = "conv_test_lookahead";

function discoverBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: CONV,
    service_id: 1,
    date: "2026-09-22",
    time_period: "afternoon",
    ...overrides,
  };
}

function simulateLock(store: MemoryVoiceOfferStore, token: string): void {
  const generation = store.beginRefresh(CONV, NOW);
  store.publishOffered(CONV, generation, [token], NOW);
}

describe("balanced v2 · discover look-ahead — a full day", () => {
  it("offers the nearest next day's hours as a normal page, and lock works on it", async () => {
    const { service } = harness({
      "2026-09-22": {},
      "2026-09-23": { [BRUNO.id]: ["17:00", "18:00"], [OLGA.id]: ["17:30", "19:00"] },
    });
    const result = await service.discover(discoverBody(), NOW);

    expect(result.outcome).toBe("options_available");
    expect(result.available).toBe(true);
    expect(result.date_fallback).toBe(true);
    expect(result.requested_date).toBe("2026-09-22");
    expect(result.options).toEqual([
      { option_index: 1, date: "2026-09-23", time: "17:00" },
      { option_index: 2, date: "2026-09-23", time: "17:30" },
      { option_index: 3, date: "2026-09-23", time: "18:00" },
    ]);
    expect(result.message).toBe(
      "El martes veintidós no me queda hueco; lo más cercano es el miércoles veintitrés a las cinco, a las cinco y media o a las seis. ¿Te va bien alguna, o te busco otro día?",
    );
    expect(result.has_more).toBe(true);
    expect(result.total_unique_slots).toBe(4);
    expect(result.requested_period).toBe("afternoon");
    expect(result.offered_period).toBe("afternoon");
    expect(result.period_fallback).toBe(false);
    expect(JSON.stringify(result)).not.toContain("employee");

    const locked = await service.lock({ conversation_id: CONV, option_index: 2 }, NOW);
    expect(locked.outcome).toBe("locked");
    expect(locked.slot?.date).toBe("2026-09-23");
    expect(locked.slot?.time).toBe("17:30");
    expect(locked.slot?.employee_id).toBe(OLGA.id);
    expect(locked.slot?.slot_token).toBeTruthy();
  });

  it("continues that same day with `more`, even if the agent resends the day it asked for", async () => {
    const { service } = harness({
      "2026-09-23": { [BRUNO.id]: ["17:00", "17:30", "18:00", "19:00"] },
    });
    await service.discover(discoverBody(), NOW);

    const more = service.more(
      { conversation_id: CONV, date: "2026-09-22", service_id: 1, time_period: "afternoon" },
      NOW,
    );
    expect(more.outcome).toBe("options_available");
    expect(more.options).toEqual([{ option_index: 1, date: "2026-09-23", time: "19:00" }]);
  });

  it("keeps a previously locked hueco even though this page offers slots (ADR-022)", async () => {
    const { service, offers } = harness({ "2026-09-23": { [BRUNO.id]: ["17:00"] } });
    simulateLock(offers, "tk.locked");
    const result = await service.discover(discoverBody(), NOW);
    expect(result.options.length).toBe(1);
    expect(offers.authorizes(CONV, "tk.locked", NOW).ok).toBe(true);
  });

  it("does not look ahead at all when the requested day has hours in the other band", async () => {
    const { service, reads } = harness({
      "2026-09-22": { [BRUNO.id]: ["10:00"] },
      "2026-09-23": { [BRUNO.id]: ["17:00"] },
    });
    const result = await service.discover(discoverBody(), NOW);
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-22", time: "10:00" }]);
    expect(result.period_fallback).toBe(true);
    expect(result.date_fallback).toBeUndefined();
    expect(reads).toEqual(["2026-09-22"]);
  });
});

describe("balanced v2 · discover look-ahead — a closed day", () => {
  it("answers a Monday with the nearest open day's hours, never reading a closed day", async () => {
    const { service, reads } = harness({
      "2026-09-22": { [BRUNO.id]: ["17:00", "17:30", "18:00"] },
    });
    const result = await service.discover(discoverBody({ date: "2026-09-21" }), NOW);

    expect(result.outcome).toBe("options_available");
    expect(result.message).toBe(withDay("Los lunes cerramos; lo más cercano es el martes veintidós a las cinco, a las cinco y media o a las seis. ¿Te va bien alguna, o te busco otro día?", "2026-09-21", NOW));
    expect(result.options.every((option) => option.date === "2026-09-22")).toBe(true);
    expect(reads).not.toContain("2026-09-21");
  });

  it("answers a Sunday skipping Monday too (BALANCED_CLOSED_WEEKDAYS)", async () => {
    const { service, reads } = harness({ "2026-09-22": { [BRUNO.id]: ["16:00"] } });
    const result = await service.discover(discoverBody({ date: "2026-09-20" }), NOW);

    expect(result.message).toBe(withDay("Los domingos cerramos; lo más cercano es el martes veintidós a las cuatro. ¿Te va bien, o te busco otro día?", "2026-09-20", NOW));
    expect(reads).not.toContain("2026-09-20");
    expect(reads).not.toContain("2026-09-21");
  });

  it("skips closed weekdays inside the look-ahead window of a full Saturday", async () => {
    const { service, reads } = harness({ "2026-09-29": { [BRUNO.id]: ["17:00"] } });
    const result = await service.discover(discoverBody({ date: "2026-09-26" }), NOW);

    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-29", time: "17:00" }]);
    expect(reads).not.toContain("2026-09-27");
    expect(reads).not.toContain("2026-09-28");
  });

  it("respects a custom closed-weekday set", async () => {
    const { service } = harness(
      { "2026-09-21": { [BRUNO.id]: ["17:00"] } },
      { closedWeekdays: new Set([0]) },
    );
    const result = await service.discover(discoverBody({ date: "2026-09-20" }), NOW);
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-21", time: "17:00" }]);
  });
});

describe("balanced v2 · discover look-ahead — the question is kept", () => {
  it("keeps preferred_time: the nearest hours around it on the next day", async () => {
    const { service } = harness({
      "2026-09-23": { [BRUNO.id]: ["16:00", "17:30", "18:30", "20:00"] },
    });
    const result = await service.discover(discoverBody({ preferred_time: "18:00" }), NOW);

    expect(result.options).toEqual([
      { option_index: 1, date: "2026-09-23", time: "17:30" },
      { option_index: 2, date: "2026-09-23", time: "18:30" },
    ]);
    expect(result.message).toBe(
      "El martes veintidós no me queda hueco; lo más cercano es el miércoles veintitrés a las cinco y media o a las seis y media. ¿Te va bien alguna, o te busco otro día?",
    );
  });

  it("offers the named hour alone when it is free on the next day", async () => {
    const { service } = harness({ "2026-09-23": { [BRUNO.id]: ["17:30", "18:00", "18:30"] } });
    const result = await service.discover(discoverBody({ preferred_time: "18:00" }), NOW);
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-23", time: "18:00" }]);
    expect(result.message).toBe(
      "El martes veintidós no me queda hueco; lo más cercano es el miércoles veintitrés a las seis. ¿Te va bien, o te busco otro día?",
    );
  });

  it("keeps the band: a next-day morning never answers an afternoon question", async () => {
    const { service } = harness({
      "2026-09-23": { [BRUNO.id]: ["10:00", "11:00"] },
      "2026-09-24": { [BRUNO.id]: ["17:00"] },
    });
    const result = await service.discover(discoverBody(), NOW);
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-24", time: "17:00" }]);
    expect(result.offered_period).toBe("afternoon");
  });

  it("keeps the professional preference, and the lock gives that professional", async () => {
    const { service } = harness({
      "2026-09-23": { [BRUNO.id]: ["17:00"] },
      "2026-09-24": { [OLGA.id]: ["18:00"] },
    });
    const result = await service.discover(discoverBody({ employee_id: OLGA.id }), NOW);
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-24", time: "18:00" }]);

    const locked = await service.lock({ conversation_id: CONV, option_index: 1 }, NOW);
    expect(locked.outcome).toBe("locked");
    expect(locked.slot?.employee_id).toBe(OLGA.id);
  });
});

describe("balanced v2 · discover look-ahead — nothing in seven days", () => {
  it("offers the following week or the other band, with no options, and keeps a prior lock", async () => {
    const { service, offers } = harness({ "2026-09-25": { [BRUNO.id]: ["10:00"] } });
    simulateLock(offers, "tk.locked");
    const result = await service.discover(discoverBody(), NOW);

    expect(result.outcome).toBe("no_availability");
    expect(result.options).toEqual([]);
    expect(result.message).toBe(withDay("En los próximos días no me queda hueco por la tarde. ¿Te busco la semana siguiente, o te va bien por la mañana?", "2026-09-22", NOW));
    expect(result.next_search_from).toBe("2026-09-30");
    expect(result.requested_date).toBe("2026-09-22");
    // Nothing was offered, so the locked hueco is still the one on the table.
    expect(offers.authorizes(CONV, "tk.locked", NOW).ok).toBe(true);
  });

  it("does not offer the other band when it is empty too", async () => {
    const { service } = harness({});
    const result = await service.discover(discoverBody(), NOW);
    expect(result.message).toBe(withDay("En los próximos días no me queda hueco. ¿Te busco la semana siguiente?", "2026-09-22", NOW));
  });

  it("names the closure first for a closed day with nothing after it", async () => {
    const { service } = harness({ "2026-09-24": { [BRUNO.id]: ["10:00"] } });
    const result = await service.discover(discoverBody({ date: "2026-09-21" }), NOW);
    expect(result.message).toBe(withDay("Los lunes cerramos, y en los próximos días no me queda hueco por la tarde. ¿Te busco la semana siguiente, o te va bien por la mañana?", "2026-09-21", NOW));
    expect(result.options).toEqual([]);
  });
});

describe("balanced v2 · discover look-ahead — failure and budget", () => {
  it("falls back to the old full-day sentence when the look-ahead reads fail", async () => {
    const { service, offers, warnings } = harness(
      {},
      {
        read: async (date) => {
          if (date === "2026-09-22") return { day: dayOf(date, {}), outcome: "miss", ageMs: 0 };
          throw new Error("agenda down");
        },
      },
    );
    simulateLock(offers, "tk.locked");
    const result = await service.discover(discoverBody(), NOW);

    expect(result.outcome).toBe("no_availability");
    expect(result.message).toBe(withDay(BALANCED_NO_AVAILABILITY_MESSAGE, "2026-09-22", NOW));
    expect(result.options).toEqual([]);
    expect(result.next_search_from).toBeUndefined();
    expect(offers.authorizes(CONV, "tk.locked", NOW).ok).toBe(true);
    expect(warnings.some((entry) => entry["lookahead_fallback"] !== undefined)).toBe(true);
  });

  it("falls back to the closed-day sentence when the look-ahead reads fail", async () => {
    const { service } = harness(
      {},
      {
        read: async () => {
          throw new Error("agenda down");
        },
      },
    );
    const result = await service.discover(discoverBody({ date: "2026-09-21" }), NOW);
    expect(result.message).toBe(withDay(BALANCED_CLOSED_DAY_MESSAGE, "2026-09-21", NOW));
    expect(result.options).toEqual([]);
  });

  it("falls back when the look-ahead misses its deadline", async () => {
    const { service } = harness(
      {},
      {
        scanDeadlineMs: 20,
        read: (date) =>
          date === "2026-09-22"
            ? Promise.resolve({ day: dayOf(date, {}), outcome: "miss" as const, ageMs: 0 })
            : new Promise<AgendaRead>(() => undefined),
      },
    );
    const result = await service.discover(discoverBody(), NOW);
    expect(result.message).toBe(withDay(BALANCED_NO_AVAILABILITY_MESSAGE, "2026-09-22", NOW));
    expect(result.options).toEqual([]);
  });

  it("never calls a later day «lo más cercano» when a nearer open day was not read", async () => {
    const fixture: Fixture = { "2026-09-24": { [BRUNO.id]: ["17:00"] } };
    const { service } = harness(fixture, {
      scanDeadlineMs: 20,
      read: (date) =>
        date === "2026-09-23"
          ? new Promise<AgendaRead>(() => undefined)
          : Promise.resolve({ day: dayOf(date, fixture[date]), outcome: "miss" as const, ageMs: 0 }),
    });
    const result = await service.discover(discoverBody(), NOW);
    expect(result.message).toBe(withDay(BALANCED_NO_AVAILABILITY_MESSAGE, "2026-09-22", NOW));
    expect(result.options).toEqual([]);
  });

  it("never claims «nada en los próximos días» when part of the week was not read", async () => {
    const { service } = harness(
      {},
      {
        read: async (date) => {
          if (date === "2026-09-26") throw new Error("one day down");
          return { day: dayOf(date, {}), outcome: "miss", ageMs: 0 };
        },
      },
    );
    const result = await service.discover(discoverBody(), NOW);
    expect(result.message).toBe(withDay(BALANCED_NO_AVAILABILITY_MESSAGE, "2026-09-22", NOW));
  });

  it("stops starting reads once the nearest day with hours is known", async () => {
    const { service, reads } = harness({ "2026-09-23": { [BRUNO.id]: ["17:00"] } });
    await service.discover(discoverBody(), NOW);
    // The requested day, then at most the scan fan-out's two lanes — not the
    // whole week.
    expect(reads[0]).toBe("2026-09-22");
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(reads).toContain("2026-09-23");
  });
});

describe("balanced v2 · multi-day scan with nothing — a concrete next step", () => {
  it("offers the following week and says where it starts", async () => {
    const { service } = harness({});
    const result = await service.scan(
      { conversation_id: CONV, service_id: 1, date_from: "2026-09-22", days: 7, after_time: "17:00" },
      NOW,
    );
    expect(result.outcome).toBe("no_availability");
    expect(result.options).toEqual([]);
    expect(result.message).toBe(
      "No tengo nada a partir de las cinco en los próximos siete días. ¿Te busco la semana siguiente, o te va bien a otra hora?",
    );
    expect(result.next_search_from).toBe("2026-09-29");
  });

  it("keeps the one-day answer without a next-window field", async () => {
    const { service } = harness({});
    const result = await service.scan(
      { conversation_id: CONV, service_id: 1, date_from: "2026-09-22", days: 1, after_time: "17:00" },
      NOW,
    );
    expect(result.message).toBe(withDay("No tengo nada a partir de las cinco ese día. ¿Miro a partir de las cinco otro día?", "2026-09-22", NOW));
    expect(result.next_search_from).toBeUndefined();
  });
});

describe("balanced v2 · look-ahead phrasing", () => {
  it("speaks the day of the month in words", () => {
    expect(spokenWeekdayAndDayEs("2026-10-01")).toBe("el jueves uno");
    expect(spokenWeekdayAndDayEs("2026-10-31")).toBe("el sábado treinta y uno");
    expect(spokenWeekdayAndDayEs("no-date")).toBe("no-date");
  });

  it("uses «a la una», never «a las una», and pluralises sábado", () => {
    expect(
      balancedLookAheadMessage({
        reason: "closed",
        requestedDate: "2026-09-26",
        offeredDate: "2026-09-29",
        times: ["13:00", "13:30"],
      }),
    ).toBe(withDay("Los sábados cerramos; lo más cercano es el martes veintinueve a la una o a la una y media. ¿Te va bien alguna, o te busco otro día?", "2026-09-26", NOW));
  });

  it("never ends on a bare negative: every rendering is an open question", () => {
    const sentences = [
      balancedLookAheadMessage({ reason: "full", requestedDate: "2026-09-22", offeredDate: "2026-09-23", times: ["17:00"] }),
      balancedLookAheadNothingMessage({ reason: "full", requestedDate: "2026-09-22", period: "morning", otherPeriodHasHours: true }),
      balancedLookAheadNothingMessage({ reason: "closed", requestedDate: "2026-09-20", period: "morning", otherPeriodHasHours: false }),
    ];
    for (const sentence of sentences) {
      expect(sentence.endsWith("?"), sentence).toBe(true);
      expect(sentence.toLowerCase()).not.toContain("whatsapp");
      expect(sentence).not.toMatch(/bruno|olga|jes[uú]s/i);
    }
  });
});
