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
  balancedExtendedLookAheadMessage,
  balancedLookAheadTwoWeeksNothingMessage,
  balancedScanExtendedMessage,
  balancedScanTwoWeeksNothingMessage,
} from "../src/utils/balancedPhrasing.js";

/**
 * V5 — the EXTENDED look-ahead ((internal doc, not included in the template) ADR-024). «Nunca perder un
 * cliente porque esta semana esté llena»: when the seven days searched have
 * nothing, the server reads the following days (up to fourteen in total) and
 * offers the nearest day's REAL hours; only when fourteen days are empty does
 * it ask an open question.
 *
 * It is a PER-REQUEST option (`extendedLookAhead`), set by the route only for
 * V5 requests (ADR-025). Without it — every V4 request — every answer is the
 * V4 one. "extended" below is that option; the route-level wiring is covered in
 * `tests/balancedV5AgentProfile.test.ts`.
 *
 * Calendar (2026): Sun 20 · Mon 21 · Tue 22 · … · Sat 26 · Sun 27 · Mon 28 ·
 * Tue 29 · Wed 30 · Thu 1 Oct · Fri 2 · Sat 3 · Sun 4 · Mon 5 · Tue 6 · Wed 7.
 */

const NOW = Date.parse("2026-09-15T10:00:00Z");
const RAMON = { id: 3, name: "ramon ", surnames: "demo-salon" };
const ROSTER = [BRUNO, OLGA, RAMON];
const CONV = "conv_test_extended_lookahead";

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
          date: `${date} 10:00:00`,
          slots: times.map((time) => ({ start: `${date} ${time}:00`, end: `${date} ${time}:00` })),
        },
      ];
    }),
    fetchedAtMs: NOW,
    upstreamCalls: 2,
  };
}

function harness(
  fixture: Fixture,
  opts: {
    extended?: boolean;
    read?: (date: string) => Promise<AgendaRead>;
    scanDeadlineMs?: number;
  } = {},
) {
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
  const real = new BalancedAvailabilityService({
    agenda,
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
    offerStore: offers,
    scanDeadlineMs: opts.scanDeadlineMs ?? 500,
    logger: { warn: (detail) => warnings.push(detail), info: () => undefined },
  });
  // The option travels with every read request, as the route sends it. When
  // the test leaves it undefined the service is called WITHOUT the argument,
  // so the default itself is what is being proven.
  const readOptions: [] | [{ extendedLookAhead: boolean }] = opts.extended !== undefined ? [{ extendedLookAhead: opts.extended }] : [];
  const service = {
    discover: (body: unknown, nowMs: number) => real.discover(body, nowMs, ...readOptions),
    scan: (body: unknown, nowMs: number) => real.scan(body, nowMs, ...readOptions),
    lock: (body: unknown, nowMs: number) => real.lock(body, nowMs),
    more: (body: unknown, nowMs: number) => real.more(body, nowMs),
  };
  return { service, offers, reads, warnings };
}

function discoverBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { conversation_id: CONV, service_id: 1, date: "2026-09-22", time_period: "afternoon", ...overrides };
}

function scanBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { conversation_id: CONV, service_id: 1, date_from: "2026-09-22", days: 7, after_time: "17:00", ...overrides };
}

function simulateLock(store: MemoryVoiceOfferStore, token: string): void {
  const generation = store.beginRefresh(CONV, NOW);
  store.publishOffered(CONV, generation, [token], NOW);
}

const hangs = (): Promise<AgendaRead> => new Promise<AgendaRead>(() => undefined);

/** Week one empty in the afternoon (a morning hour on Fri 25), week two with hours. */
const WEEK_TWO: Fixture = {
  "2026-09-25": { [BRUNO.id]: ["10:00"] },
  "2026-10-01": { [BRUNO.id]: ["17:00"], [OLGA.id]: ["17:30"] },
};

// ─── option off (V4 request): V4, byte for byte ─────────────────────────────

describe("extended look-ahead · option off (V4 request) answers exactly as V4", () => {
  for (const extended of [undefined, false] as const) {
    it(`discover: seven empty days still end on «¿Te busco la semana siguiente…?» (option ${String(extended)})`, async () => {
      const { service, reads } = harness(WEEK_TWO, { extended });
      const result = await service.discover(discoverBody(), NOW);
      expect(result).toEqual({
        outcome: "no_availability",
        available: false,
        message: withDay(
          "En los próximos días no me queda hueco por la tarde. ¿Te busco la semana siguiente, o te va bien por la mañana?",
          "2026-09-22",
          NOW,
        ),
        options: [],
        total_unique_slots: 0,
        has_more: false,
        requested_period: "afternoon",
        offered_period: null,
        period_fallback: false,
        requested_date: "2026-09-22",
        next_search_from: "2026-09-30",
        external_mutation: false,
      });
      expect(reads.some((date) => date >= "2026-09-30")).toBe(false);
    });

    it(`scan: an empty week still ends on the V4 sentence (option ${String(extended)})`, async () => {
      const { service, reads } = harness({ "2026-09-29": { [BRUNO.id]: ["17:00"] } }, { extended });
      const result = await service.scan(scanBody(), NOW);
      expect(result.outcome).toBe("no_availability");
      expect(result.message).toBe(
        "No tengo nada a partir de las cinco en los próximos siete días. ¿Te busco la semana siguiente, o te va bien a otra hora?",
      );
      expect(result.next_search_from).toBe("2026-09-29");
      expect(reads.some((date) => date >= "2026-09-29")).toBe(false);
    });
  }
});

// ─── discover ────────────────────────────────────────────────────────────────

describe("extended look-ahead · discover", () => {
  it("a first-week match is answered exactly as without the option", async () => {
    const fixture: Fixture = { "2026-09-23": { [BRUNO.id]: ["17:00"] }, "2026-10-01": { [BRUNO.id]: ["17:00"] } };
    const on = await harness(fixture, { extended: true }).service.discover(discoverBody(), NOW);
    const off = await harness(fixture).service.discover(discoverBody(), NOW);
    expect(on).toEqual(off);
    expect(on.options).toEqual([{ option_index: 1, date: "2026-09-23", time: "17:00" }]);
  });

  it("seven empty days → the nearest day of the second week, as a lockable page", async () => {
    const { service } = harness(WEEK_TWO, { extended: true });
    const result = await service.discover(discoverBody(), NOW);

    expect(result.outcome).toBe("options_available");
    expect(result.available).toBe(true);
    expect(result.options).toEqual([
      { option_index: 1, date: "2026-10-01", time: "17:00" },
      { option_index: 2, date: "2026-10-01", time: "17:30" },
    ]);
    expect(result.message).toBe(withDay("En los próximos días no me queda hueco por la tarde; lo más cercano es el jueves uno a las cinco o a las cinco y media. ¿Te va bien alguna, o te miro otro día?", "2026-09-22", NOW));
    expect(result.date_fallback).toBe(true);
    expect(result.requested_date).toBe("2026-09-22");
    expect(result.offered_period).toBe("afternoon");
    expect(result.next_search_from).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/employee|bruno|olga/i);

    const locked = await service.lock({ conversation_id: CONV, option_index: 2 }, NOW);
    expect(locked.outcome).toBe("locked");
    expect(locked.slot?.date).toBe("2026-10-01");
    expect(locked.slot?.time).toBe("17:30");
    expect(locked.slot?.employee_id).toBe(OLGA.id);
  });

  it("`more` continues that second-week day", async () => {
    const { service } = harness(
      { "2026-10-01": { [BRUNO.id]: ["16:00", "17:00", "18:00", "19:00"] } },
      { extended: true },
    );
    await service.discover(discoverBody(), NOW);
    const more = service.more({ conversation_id: CONV }, NOW);
    expect(more.outcome).toBe("options_available");
    expect(more.options).toEqual([{ option_index: 1, date: "2026-10-01", time: "19:00" }]);
  });

  it("keeps preferred_time and the professional in the second week", async () => {
    const { service } = harness(
      {
        "2026-09-30": { [BRUNO.id]: ["18:00"] },
        "2026-10-01": { [OLGA.id]: ["16:00", "17:30", "18:30", "20:00"] },
      },
      { extended: true },
    );
    const result = await service.discover(discoverBody({ employee_id: OLGA.id, preferred_time: "18:00" }), NOW);
    expect(result.options).toEqual([
      { option_index: 1, date: "2026-10-01", time: "17:30" },
      { option_index: 2, date: "2026-10-01", time: "18:30" },
    ]);
    const locked = await service.lock({ conversation_id: CONV, option_index: 1 }, NOW);
    expect(locked.slot?.employee_id).toBe(OLGA.id);
  });

  it("a closed day names the closure, then the nearest second-week day", async () => {
    const { service, reads } = harness({ "2026-09-29": { [BRUNO.id]: ["17:00"] } }, { extended: true });
    const result = await service.discover(discoverBody({ date: "2026-09-21" }), NOW);
    expect(result.message).toBe(withDay("Los lunes cerramos, y en los próximos días no me queda hueco; lo más cercano es el martes veintinueve a las cinco. ¿Te va bien, o te miro otro día?", "2026-09-21", NOW));
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-29", time: "17:00" }]);
    for (const closed of ["2026-09-21", "2026-09-27", "2026-09-28"]) {
      expect(reads).not.toContain(closed);
    }
  });

  it("never reads a closed weekday of the second week", async () => {
    const { service, reads } = harness({}, { extended: true });
    await service.discover(discoverBody(), NOW);
    for (const closed of ["2026-09-27", "2026-09-28", "2026-10-04", "2026-10-05"]) {
      expect(reads).not.toContain(closed);
    }
    expect(reads).toContain("2026-10-06");
  });

  it("fourteen empty days → open question, zero options, prior lock kept (ADR-022)", async () => {
    const { service, offers } = harness({ "2026-10-02": { [BRUNO.id]: ["11:00"] } }, { extended: true });
    simulateLock(offers, "tk.locked");
    const result = await service.discover(discoverBody(), NOW);

    expect(result.outcome).toBe("no_availability");
    expect(result.options).toEqual([]);
    expect(result.message).toBe(withDay("En las próximas dos semanas no me queda hueco por la tarde. ¿Te va bien por la mañana, o prefieres que mire otras fechas?", "2026-09-22", NOW));
    expect(result.next_search_from).toBe("2026-10-07");
    expect(offers.authorizes(CONV, "tk.locked", NOW).ok).toBe(true);
  });

  it("fourteen days with nothing in either band → «¿Qué otras fechas quieres que mire?»", async () => {
    const { service } = harness({}, { extended: true });
    const result = await service.discover(discoverBody(), NOW);
    expect(result.message).toBe(withDay("En las próximas dos semanas no me queda hueco. ¿Qué otras fechas quieres que mire?", "2026-09-22", NOW));
    expect(result.options).toEqual([]);
  });

  it("a second-week read failure falls back to the seven-day sentence, lock kept", async () => {
    const { service, offers, warnings } = harness(
      {},
      {
        extended: true,
        read: async (date) => {
          if (date >= "2026-09-30") throw new Error("agenda down");
          return { day: dayOf(date, WEEK_TWO[date]), outcome: "miss", ageMs: 0 };
        },
      },
    );
    simulateLock(offers, "tk.locked");
    const result = await service.discover(discoverBody(), NOW);
    expect(result.outcome).toBe("no_availability");
    expect(result.message).toBe(withDay("En los próximos días no me queda hueco por la tarde. ¿Te busco la semana siguiente, o te va bien por la mañana?", "2026-09-22", NOW));
    expect(result.next_search_from).toBe("2026-09-30");
    expect(result.options).toEqual([]);
    expect(offers.authorizes(CONV, "tk.locked", NOW).ok).toBe(true);
    expect(warnings.some((entry) => entry["extended_lookahead_fallback"] === "partial_window")).toBe(true);
  });

  it("a second week that misses the shared deadline falls back to the seven-day sentence", async () => {
    const { service, warnings } = harness(
      {},
      {
        extended: true,
        scanDeadlineMs: 40,
        read: (date) =>
          date >= "2026-09-30"
            ? hangs()
            : Promise.resolve({ day: dayOf(date, {}), outcome: "miss" as const, ageMs: 0 }),
      },
    );
    const started = Date.now();
    const result = await service.discover(discoverBody(), NOW);
    expect(result.message).toBe(withDay("En los próximos días no me queda hueco. ¿Te busco la semana siguiente?", "2026-09-22", NOW));
    expect(result.options).toEqual([]);
    expect(warnings.some((entry) => entry["extended_lookahead_fallback"] !== undefined)).toBe(true);
    // One budget for both weeks, not one each.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("never calls a second-week day «lo más cercano» when a nearer one was not read", async () => {
    const { service } = harness(WEEK_TWO, {
      extended: true,
      scanDeadlineMs: 40,
      read: (date) =>
        date === "2026-09-30"
          ? hangs()
          : Promise.resolve({ day: dayOf(date, WEEK_TWO[date]), outcome: "miss" as const, ageMs: 0 }),
    });
    const result = await service.discover(discoverBody(), NOW);
    expect(result.options).toEqual([]);
    expect(result.message).toBe(withDay("En los próximos días no me queda hueco por la tarde. ¿Te busco la semana siguiente, o te va bien por la mañana?", "2026-09-22", NOW));
  });

  it("stops starting second-week reads once the nearest day is found", async () => {
    const { service, reads } = harness({ "2026-09-30": { [BRUNO.id]: ["17:00"] } }, { extended: true });
    const result = await service.discover(discoverBody(), NOW);
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-30", time: "17:00" }]);
    const secondWeekReads = reads.filter((date) => date >= "2026-09-30");
    // The scan fan-out's two lanes at most — not the five open days.
    expect(secondWeekReads.length).toBeLessThanOrEqual(2);
    expect(secondWeekReads).toContain("2026-09-30");
  });
});

// ─── scan ────────────────────────────────────────────────────────────────────

describe("extended look-ahead · multi-day scan", () => {
  it("an empty week → the nearest following day, after_time preserved, lock works", async () => {
    const { service } = harness(
      {
        "2026-09-23": { [BRUNO.id]: ["10:00", "16:30"] },
        "2026-09-29": { [BRUNO.id]: ["16:00", "17:00"], [OLGA.id]: ["17:30"] },
      },
      { extended: true },
    );
    const result = await service.scan(scanBody(), NOW);

    expect(result.outcome).toBe("options_available");
    expect(result.options).toEqual([
      { option_index: 1, date: "2026-09-29", time: "17:00" },
      { option_index: 2, date: "2026-09-29", time: "17:30" },
    ]);
    expect(result.message).toBe(
      "No tengo nada a partir de las cinco en los próximos siete días; lo más cercano es el martes veintinueve a las cinco o a las cinco y media. ¿Te va bien alguna, o te miro otro día?",
    );
    expect(result.partial).toBe(false);
    expect(result.days_checked).toEqual([
      "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-29",
    ]);
    expect(result.days_summary).toEqual([
      { date: "2026-09-29", weekday_es: "martes", count: 3, first_time: "17:00", last_time: "17:30", matching_count: 2 },
    ]);
    expect(result.next_search_from).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/employee|bruno|olga/i);

    const locked = await service.lock({ conversation_id: CONV, option_index: 2 }, NOW);
    expect(locked.outcome).toBe("locked");
    expect(locked.slot?.date).toBe("2026-09-29");
    expect(locked.slot?.time).toBe("17:30");

    // Both hours were on the page: the continuation is exhausted, not lost.
    const more = service.more({ conversation_id: CONV, date: "2026-09-29" }, NOW);
    expect(more.outcome).toBe("no_more_options");
  });

  it("`more` pages the offered day, and a day inside the extended window is not a contradiction", async () => {
    const { service } = harness(
      { "2026-10-01": { [BRUNO.id]: ["17:00", "17:30", "18:00", "18:30"] } },
      { extended: true },
    );
    const first = await service.scan(scanBody(), NOW);
    expect(first.options.map((option) => option.time)).toEqual(["17:00", "17:30", "18:00"]);
    const more = service.more({ conversation_id: CONV, date: "2026-10-01" }, NOW);
    expect(more.outcome).toBe("options_available");
    expect(more.options).toEqual([{ option_index: 1, date: "2026-10-01", time: "18:30" }]);
  });

  it("a shorter window reads on up to fourteen days in total, same band", async () => {
    const { service, reads } = harness(
      { "2026-10-02": { [BRUNO.id]: ["10:00", "18:00"] } },
      { extended: true },
    );
    const result = await service.scan(
      scanBody({ days: 3, after_time: undefined, time_period: "afternoon" }),
      NOW,
    );
    expect(result.options).toEqual([{ option_index: 1, date: "2026-10-02", time: "18:00" }]);
    expect(result.message).toBe(
      "No tengo nada por la tarde en los próximos tres días; lo más cercano es el viernes dos a las seis. ¿Te va bien, o te miro otro día?",
    );
    expect(reads).not.toContain("2026-09-27");
    expect(reads).not.toContain("2026-09-28");
  });

  it("fourteen empty days → open question, zero options, prior lock kept (ADR-022)", async () => {
    const { service, offers } = harness({ "2026-10-01": { [BRUNO.id]: ["12:00"] } }, { extended: true });
    simulateLock(offers, "tk.locked");
    const result = await service.scan(scanBody(), NOW);
    expect(result.outcome).toBe("no_availability");
    expect(result.options).toEqual([]);
    expect(result.message).toBe(
      "No tengo nada a partir de las cinco en las próximas dos semanas. ¿Te va bien a otra hora, o prefieres que mire otras fechas?",
    );
    expect(result.next_search_from).toBe("2026-10-06");
    expect(result.partial).toBe(false);
    expect(offers.authorizes(CONV, "tk.locked", NOW).ok).toBe(true);
  });

  it("fourteen days with no hour at all → no door onto nothing", async () => {
    const { service } = harness({}, { extended: true });
    const result = await service.scan(scanBody(), NOW);
    expect(result.message).toBe(
      "No tengo nada a partir de las cinco en las próximas dos semanas. ¿Qué otras fechas quieres que mire?",
    );
  });

  it("a partially read first window is not extended", async () => {
    const { service, reads } = harness(
      { "2026-09-29": { [BRUNO.id]: ["17:00"] } },
      {
        extended: true,
        read: async (date) => {
          if (date === "2026-09-24") throw new Error("one day down");
          return { day: dayOf(date, date === "2026-09-29" ? { [BRUNO.id]: ["17:00"] } : {}), outcome: "miss", ageMs: 0 };
        },
      },
    );
    const result = await service.scan(scanBody(), NOW);
    expect(result.message).toBe(
      "No tengo nada a partir de las cinco en los días que he podido mirar. ¿Te busco la semana siguiente, o te va bien a otra hora?",
    );
    expect(reads).not.toContain("2026-09-29");
  });

  it("a following-days failure or deadline falls back to the window sentence", async () => {
    for (const read of [
      async (date: string): Promise<AgendaRead> => {
        if (date >= "2026-09-29") throw new Error("agenda down");
        return { day: dayOf(date, {}), outcome: "miss", ageMs: 0 };
      },
      (date: string): Promise<AgendaRead> =>
        date >= "2026-09-29" ? hangs() : Promise.resolve({ day: dayOf(date, {}), outcome: "miss", ageMs: 0 }),
    ]) {
      const { service, offers, warnings } = harness({}, { extended: true, scanDeadlineMs: 40, read });
      simulateLock(offers, "tk.locked");
      const result = await service.scan(scanBody(), NOW);
      expect(result.outcome).toBe("no_availability");
      expect(result.message).toBe(
        "No tengo nada a partir de las cinco en los próximos siete días. ¿Te busco la semana siguiente, o te va bien a otra hora?",
      );
      expect(result.next_search_from).toBe("2026-09-29");
      expect(result.options).toEqual([]);
      expect(offers.authorizes(CONV, "tk.locked", NOW).ok).toBe(true);
      expect(warnings.some((entry) => entry["extended_lookahead_fallback"] !== undefined)).toBe(true);
    }
  });

  it("stops starting following-day reads once the nearest day is found", async () => {
    const { service, reads } = harness({ "2026-09-29": { [BRUNO.id]: ["17:00"] } }, { extended: true });
    await service.scan(scanBody(), NOW);
    expect(reads.filter((date) => date >= "2026-09-29").length).toBeLessThanOrEqual(2);
  });

  it("a one-day scan is never extended", async () => {
    const { service, reads } = harness({ "2026-09-23": { [BRUNO.id]: ["17:00"] } }, { extended: true });
    const result = await service.scan(scanBody({ days: 1 }), NOW);
    expect(result.message).toBe(withDay("No tengo nada a partir de las cinco ese día. ¿Miro a partir de las cinco otro día?", "2026-09-22", NOW));
    expect(reads).toEqual(["2026-09-22"]);
  });
});

// ─── phrasing ────────────────────────────────────────────────────────────────

describe("extended look-ahead · phrasing", () => {
  it("every sentence ends on a question and names nobody", () => {
    const sentences = [
      balancedExtendedLookAheadMessage({ reason: "full", requestedDate: "2026-09-22", period: "afternoon", otherPeriodHasHours: true, offeredDate: "2026-09-29", times: ["17:00", "17:30"] }),
      balancedExtendedLookAheadMessage({ reason: "closed", requestedDate: "2026-09-20", period: "morning", otherPeriodHasHours: false, offeredDate: "2026-09-29", times: ["13:00"] }),
      balancedLookAheadTwoWeeksNothingMessage({ reason: "full", requestedDate: "2026-09-22", period: "afternoon", otherPeriodHasHours: true }),
      balancedLookAheadTwoWeeksNothingMessage({ reason: "closed", requestedDate: "2026-09-21", period: "afternoon", otherPeriodHasHours: false }),
      balancedScanExtendedMessage({ beforeTime: "12:00", days: 7, offeredDate: "2026-09-29", times: ["11:00"] }),
      balancedScanTwoWeeksNothingMessage({ afterTime: "17:00", beforeTime: "19:00", otherHoursSeen: true }),
      balancedScanTwoWeeksNothingMessage({ period: "morning", otherHoursSeen: true }),
      balancedScanTwoWeeksNothingMessage({ otherHoursSeen: false }),
    ];
    for (const sentence of sentences) {
      expect(sentence.endsWith("?"), sentence).toBe(true);
      expect(sentence.toLowerCase()).not.toContain("whatsapp");
      expect(sentence).not.toMatch(/bruno|olga|jes[uú]s/i);
    }
    expect(sentences[0]).toBe(withDay("En los próximos días no me queda hueco por la tarde; lo más cercano es el martes veintinueve a las cinco o a las cinco y media. ¿Te va bien alguna, o te miro otro día?", "2026-09-22", NOW));
    expect(sentences[1]).toBe(
      withDay("Los domingos cerramos, y en los próximos días no me queda hueco; lo más cercano es el martes veintinueve a la una. ¿Te va bien, o te miro otro día?", "2026-09-20", NOW),
    );
    expect(sentences[3]).toBe(
      withDay("Los lunes cerramos, y en las próximas dos semanas no me queda hueco. ¿Qué otras fechas quieres que mire?", "2026-09-21", NOW),
    );
    expect(sentences[5]).toBe(
      "No tengo nada entre las cinco y las siete en las próximas dos semanas. ¿Te va bien en otra franja, o prefieres que mire otras fechas?",
    );
    expect(sentences[6]).toBe(
      "No tengo nada por la mañana en las próximas dos semanas. ¿Te va bien por la tarde, o prefieres que mire otras fechas?",
    );
    expect(sentences[7]).toBe("No tengo nada en las próximas dos semanas. ¿Qué otras fechas quieres que mire?");
  });
});
