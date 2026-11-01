import { describe, it, expect } from "vitest";

import { SLOT_TOKEN_SECRET } from "./helpers/testApp.js";
import { BRUNO } from "./helpers/balancedV2.js";
import { SlotAuthorizationService } from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";
import { BALANCED_CLOSED_AFTERNOON_MESSAGE } from "../src/utils/balancedPhrasing.js";
import { isSlotAfterEarlyClose, withoutAfterCloseSlots } from "../src/utils/slotLeadTime.js";
import { resetEnvCache, loadEnv } from "../src/config/env.js";
import { testEnv } from "./helpers/testApp.js";

/**
 * BALANCED_EARLY_CLOSE (2026-10-08): the salon is open Saturday only until
 * 14:00. Slots at/after the close are never offered, locked or booked, and an
 * afternoon question on that Saturday is answered closed-style with no read.
 * Calendar: Sat 2026-09-26 · Sun 27 · Mon 28 · Tue 29.
 */
const NOW = Date.parse("2026-09-15T10:00:00Z");
const SATURDAY_CLOSE = new Map([[6, 14 * 60]]);
const CONV = "conv_early_close";

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

function build(
  fixture: Record<string, string[]>,
  earlyClose: ReadonlyMap<number, number> | undefined,
  stores = {
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    offers: new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 16 }),
  },
) {
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
    options: stores.options,
    slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
    offerStore: stores.offers,
    scanDeadlineMs: 500,
    ...(earlyClose !== undefined ? { earlyClose } : {}),
    logger: { warn: () => undefined, info: () => undefined },
  });
  return { service, reads, stores };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  conversation_id: CONV,
  service_id: 1,
  date: "2026-09-26",
  time_period: "afternoon",
  ...overrides,
});

describe("early close · helpers", () => {
  it("judges only the configured weekday, at or after the minute", () => {
    expect(isSlotAfterEarlyClose("2026-09-26 14:00:00", SATURDAY_CLOSE)).toBe(true);
    expect(isSlotAfterEarlyClose("2026-09-26 13:30:00", SATURDAY_CLOSE)).toBe(false);
    expect(isSlotAfterEarlyClose("2026-09-29 17:00:00", SATURDAY_CLOSE)).toBe(false);
    expect(isSlotAfterEarlyClose("2026-09-26 17:00:00", new Map())).toBe(false);
  });

  it("returns the same day object when nothing is removed", () => {
    const day = dayOf("2026-09-26", ["10:00"]);
    expect(withoutAfterCloseSlots(day, SATURDAY_CLOSE)).toBe(day);
    expect(withoutAfterCloseSlots(dayOf("2026-09-26", ["15:00"]), SATURDAY_CLOSE).free).toEqual([]);
  });
});

describe("early close · env", () => {
  it("defaults to Saturday 14:00, an empty string disables, garbage is dropped", () => {
    testEnv();
    delete process.env["BALANCED_EARLY_CLOSE"];
    resetEnvCache();
    expect(loadEnv().BALANCED_EARLY_CLOSE).toEqual(new Map([[6, 840]]));
    process.env["BALANCED_EARLY_CLOSE"] = "";
    resetEnvCache();
    expect(loadEnv().BALANCED_EARLY_CLOSE.size).toBe(0);
    process.env["BALANCED_EARLY_CLOSE"] = "6=13:30, 2=18:00, 9=10:00, x, 5=25:00";
    resetEnvCache();
    expect(loadEnv().BALANCED_EARLY_CLOSE).toEqual(
      new Map([
        [6, 810],
        [2, 1080],
      ]),
    );
  });
});

describe("early close · discover", () => {
  it("a Saturday afternoon question is answered closed-style without reading Saturday", async () => {
    const { service, reads } = build(
      { "2026-09-26": ["15:00", "16:00"], "2026-09-29": ["17:00"] },
      SATURDAY_CLOSE,
    );
    const result = await service.discover(body(), NOW);
    expect(reads).not.toContain("2026-09-26");
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-29", time: "17:00" }]);
    expect(result.message).toContain("El sábado veintiséis por la tarde cerramos");
  });

  it("falls back to the afternoon-closed sentence when the look-ahead cannot be read", async () => {
    const { service } = build({}, new Map([[6, 14 * 60]]));
    const result = await service.discover(body({ date: "2026-09-26" }), NOW);
    // nothing anywhere: the sentence still never claims the whole day is closed
    expect(result.message).toContain("El sábado veintiséis por la tarde cerramos");
    expect(result.message).not.toBe("Los sábados cerramos");
    expect(BALANCED_CLOSED_AFTERNOON_MESSAGE).toContain("por la tarde");
  });

  it("a Saturday morning question still reads the day and never offers 14:00 or later", async () => {
    const { service, reads } = build(
      { "2026-09-26": ["10:00", "13:30", "14:00", "15:00"] },
      SATURDAY_CLOSE,
    );
    const result = await service.discover(body({ time_period: "morning" }), NOW);
    expect(reads).toContain("2026-09-26");
    const times = result.options.map((o) => o.time);
    expect(times).toEqual(["10:00", "13:30"]);
  });

  it("an open weekday keeps its afternoon", async () => {
    const { service } = build({ "2026-09-29": ["17:00"] }, SATURDAY_CLOSE);
    const result = await service.discover(body({ date: "2026-09-29" }), NOW);
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-29", time: "17:00" }]);
  });

  it("with the feature off (no map) Saturday afternoon is offered as before", async () => {
    const { service } = build({ "2026-09-26": ["15:00"] }, undefined);
    const result = await service.discover(body(), NOW);
    expect(result.options).toEqual([{ option_index: 1, date: "2026-09-26", time: "15:00" }]);
  });

  it("a Saturday-only afternoon day with only afternoon hours falls back to the morning without 14:00+", async () => {
    const { service } = build({ "2026-09-26": ["15:00"] }, SATURDAY_CLOSE);
    const result = await service.discover(body({ time_period: "morning" }), NOW);
    expect(result.options.some((o) => o.date === "2026-09-26")).toBe(false);
  });
});

describe("early close · scan", () => {
  it("drops a Saturday from an afternoon window before the fan-out", async () => {
    const { service, reads } = build({ "2026-09-29": ["17:00"] }, SATURDAY_CLOSE);
    await service.scan(
      { conversation_id: CONV, service_id: 1, date_from: "2026-09-26", days: 1, time_period: "afternoon" },
      NOW,
    );
    // 2026-10-09 (call 8dx8gn): Saturday is still never read, but the scan now
    // answers like discover — it reads the following days to name the nearest.
    expect(reads).not.toContain("2026-09-26");
    expect(reads).toContain("2026-09-29");
    // Control: the same window on an open Tuesday reads exactly that day.
    reads.length = 0;
    await service.scan(
      { conversation_id: CONV, service_id: 1, date_from: "2026-09-29", days: 1, time_period: "afternoon" },
      NOW,
    );
    expect(reads).toEqual(["2026-09-29"]);
  });

  it("an after_time floor past the close also skips the day", async () => {
    const { service, reads } = build({ "2026-09-26": ["10:00"] }, SATURDAY_CLOSE);
    await service.scan(
      { conversation_id: CONV, service_id: 1, date_from: "2026-09-26", days: 1, after_time: "15:00" },
      NOW,
    );
    // 2026-10-09: never Saturday itself (the look-ahead may read later days).
    expect(reads).not.toContain("2026-09-26");
  });
});

describe("early close · lock", () => {
  it("refuses a slot at/after the close like a taken one, even if it was offered earlier", async () => {
    const stores = {
      options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 16 }),
      offers: new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 16 }),
    };
    // Offered by an instance WITHOUT the early close (an old offer)...
    const old = build({ "2026-09-26": ["15:00"] }, undefined, stores);
    const offered = await old.service.discover(body(), NOW);
    expect(offered.options).toHaveLength(1);
    // ...and locked by one that has it.
    const current = build({ "2026-09-26": ["15:00"] }, SATURDAY_CLOSE, stores);
    const locked = await current.service.lock({ conversation_id: CONV, option_index: 1 }, NOW);
    expect(locked.outcome).toBe("slot_taken");
  });
});
