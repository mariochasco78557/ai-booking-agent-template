import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  SLOT_TOKEN_SECRET,
  UPSTREAM,
  buildTestApp,
  fakeJwt,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import { withDay, BRUNO, RAMON, OLGA, conv, v2, v2Book } from "./helpers/balancedV2.js";
import { loadEnv } from "../src/config/env.js";
import { createServices } from "../src/services/container.js";
import {
  BALANCED_DISCOVER_OUTCOMES,
  BALANCED_SCAN_MAX_DAYS,
  BALANCED_SCAN_MAX_PER_DAY,
  BALANCED_SCAN_UPSTREAM_CAPACITY_DEFAULT,
} from "../src/schemas/balancedV2Schemas.js";
import {
  BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
  BALANCED_SCAN_ALL_CLOSED_MESSAGE,
  balancedScanNoAvailabilityMessage,
  balancedScanNoMoreMessage,
} from "../src/utils/balancedPhrasing.js";
import {
  SLOT_TOKEN_PREFIX,
  SlotAuthorizationService,
} from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";
import { madridDate } from "../src/utils/madridDate.js";

/**
 * BALANCED V2 — `action: "scan"`, the same question asked of a WINDOW.
 *
 * The call this suite exists for is a real one. The caller wanted an
 * appointment «a partir de las cinco», and the only tool the agent had answered
 * about ONE day and treated the hour as a mere preference — so it offered
 * 14:00, then 14:30, then went hunting day by day, one round trip per guess,
 * until the caller gave up. Every property asserted below is one of the four
 * that make the window version a better answer rather than merely a broader
 * one:
 *
 * - the time constraint is HARD: an hour outside it is never offered, however
 *   few hours remain;
 * - the first page names DAYS, because the per-day cap stops one busy
 *   afternoon from filling it;
 * - the days are read TOGETHER and the answer is bounded in time, with a day
 *   that did not arrive REPORTED rather than counted as empty;
 * - it authorizes nothing: no professional, no token, and any token this
 *   conversation was holding dies on the way in.
 */

const DAY_MS = 86_400_000;

/**
 * The window under test, relative to the salon's today.
 *
 * Relative rather than hard-coded, and that is not decoration: `scan` LIFTS a
 * `date_from` in the past to today (see `readScan`), so a suite with fixed
 * dates would silently start scanning a different week the day those dates went
 * by — and its nock fixtures, keyed by date, would stop matching for a reason
 * no failure message would explain.
 */
function plusDays(offset: number): string {
  return new Date(Date.parse(`${madridDate(Date.now())}T00:00:00Z`) + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The offset of the first TUESDAY at or after `minOffset` days from the salon's
 * today (same helper as `tests/balancedV2ScanCrossDay.test.ts`).
 *
 * *** WHY THE WINDOW IS ANCHORED TO A WEEKDAY. *** A bare `today + 30` lands on
 * a different weekday every day the suite runs, and the default closed days
 * (Sunday, Monday — `BALANCED_CLOSED_WEEKDAYS`) are never read. On 2026-09-16
 * `D[2]` was Sunday 2026-10-18, so tests that expect D[0]..D[2] to be read
 * failed for a reason that had nothing to do with the code under test.
 */
function nextTuesdayOffset(minOffset: number): number {
  const anchor = Date.parse(`${madridDate(Date.now())}T00:00:00Z`);
  for (let offset = minOffset; offset < minOffset + 7; offset += 1) {
    if (new Date(anchor + offset * DAY_MS).getUTCDay() === 2) return offset;
  }
  throw new Error("unreachable");
}

/**
 * D[0]..D[7] — a window starting a month out, well clear of "today", always
 * Tuesday first: D[0]..D[4] are Tuesday..Saturday (open), D[5] and D[6] are
 * Sunday and Monday (closed by default), D[7] is the next Tuesday.
 */
const D = Array.from({ length: 8 }, (_unused, index) => plusDays(nextTuesdayOffset(30) + index));

interface DayFixture {
  /** Who is ON DUTY. An empty roster is a closed day. */
  roster: Array<{ id: number; name: string; surnames: string }>;
  /** Free `HH:mm` per barber id. A barber with none is OMITTED upstream. */
  free: Record<number, string[]>;
}

/** Counts every upstream call this window costs, and remembers its dates. */
interface UpstreamCounter {
  employeesDay: number;
  free: number;
  /** The `date` of every `/user/free` call, in order. */
  freeDates: string[];
  reset(): void;
  readonly total: number;
}

/**
 * Persistent, COUNTING intercepts for a whole window, keyed by date.
 *
 * `mockAgendaDay` describes exactly one day, which is the shape that cannot
 * express any property a window question has. Every fixture here is a map from
 * date to that day's roster and free hours, so "the salon is shut on Sunday",
 * "Monday is fully booked" and "Thursday has five hours" are all sayable — and
 * a date the test never described answers an empty day rather than a 500.
 */
function mockWindow(
  days: Record<string, DayFixture>,
  opts: { delayMs?: number } = {},
): UpstreamCounter {
  const counter: UpstreamCounter = {
    employeesDay: 0,
    free: 0,
    freeDates: [],
    reset() {
      this.employeesDay = 0;
      this.free = 0;
      this.freeDates = [];
    },
    get total() {
      return this.employeesDay + this.free;
    },
  };

  nock(UPSTREAM).persist().post(`${BASE_PATH}/login`).reply(200, { token: fakeJwt() });

  const dateOf = (uri: string): string => /date=([0-9-]+)/.exec(uri)?.[1] ?? "";

  const employees = nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/employees-day`)
    .query(true);
  (opts.delayMs !== undefined ? employees.delay(opts.delayMs) : employees).reply((uri) => {
    counter.employeesDay += 1;
    return [200, days[dateOf(uri)]?.roster ?? []];
  });

  const free = nock(UPSTREAM).persist().get(`${BASE_PATH}/user/free`).query(true);
  (opts.delayMs !== undefined ? free.delay(opts.delayMs) : free).reply((uri) => {
    const date = dateOf(uri);
    counter.free += 1;
    counter.freeDates.push(date);
    const fixture = days[date];
    const ids = [...uri.matchAll(/employees(?:\[\]|%5B%5D)=(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    const records = ids
      .map((id) => {
        const times = fixture?.free[id] ?? [];
        const employee = fixture?.roster.find((entry) => entry.id === id);
        if (times.length === 0 || employee === undefined) return undefined;
        return {
          id,
          name: employee.name,
          surnames: employee.surnames,
          date: `${date} 14:00:00`,
          // A barber with NO free hour is absent from the array entirely —
          // upstream's real way of saying it (verified live 2026-08-30).
          slots: times.map((time) => ({
            start: `${date} ${time}:00`,
            end: `${date} ${time}:00`,
          })),
        };
      })
      .filter((record) => record !== undefined);
    return [200, records];
  });

  return counter;
}

/** A day where everybody works and nobody is free: fully booked, not shut. */
function fullyBooked(): DayFixture {
  return { roster: [BRUNO, OLGA, RAMON], free: {} };
}

/** One barber and the given hours, in the shape an `AgendaReader` hands back. */
function soloDay(date: string, times: string[]): AgendaDay {
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
        slots: times.map((time) => ({
          start: `${date} ${time}:00`,
          end: `${date} ${time}:00`,
        })),
      },
    ],
    fetchedAtMs: Date.now(),
    upstreamCalls: 2,
  };
}

/**
 * The service alone, on a STUBBED agenda.
 *
 * The properties below are about what `scan` asks for and when — the fan-out it
 * opens, and what it answers when a day never lands — and none of them needs a
 * real HTTP round trip to be true. The deadline defaults to 60 ms so a partial
 * window is proven in milliseconds rather than by sleeping 2.5 s; the upstream
 * capacity defaults to the env var's own default, which is what production runs.
 */
function scanService(
  reader: Pick<AgendaReader, "read">,
  overrides: {
    scanDeadlineMs?: number;
    upstreamMaxConcurrency?: number;
    closedWeekdays?: ReadonlySet<number>;
  } = {},
): BalancedAvailabilityService {
  const agenda: AgendaReader = {
    read: reader.read,
    readFresh: async (date) => ({
      day: soloDay(date, ["10:00"]),
      outcome: "bypass" as const,
      ageMs: 0,
    }),
    invalidate: () => 0,
  };
  return new BalancedAvailabilityService({
    agenda,
    options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 8 }),
    slotAuthorization: new SlotAuthorizationService({
      secret: SLOT_TOKEN_SECRET,
      ttlSeconds: 600,
    }),
    offerStore: new MemoryVoiceOfferStore({
      ttlSeconds: 3_600,
      maxEntries: 8,
      digestKey: SLOT_TOKEN_SECRET,
    }),
    scanDeadlineMs: overrides.scanDeadlineMs ?? 60,
    ...(overrides.upstreamMaxConcurrency !== undefined
      ? { upstreamMaxConcurrency: overrides.upstreamMaxConcurrency }
      : {}),
    ...(overrides.closedWeekdays !== undefined
      ? { closedWeekdays: overrides.closedWeekdays }
      : {}),
  });
}

/** The (date, time) pairs of an answer's page, in the order it numbered them. */
function pageOf(body: Record<string, unknown>): Array<[string, string]> {
  return (body["options"] as Array<Record<string, unknown>>).map((option) => [
    String(option["date"]),
    String(option["time"]),
  ]);
}

function scanBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "scan",
    conversation_id: conv("scan"),
    service_id: 1,
    date_from: D[0],
    days: 7,
    ...overrides,
  };
}

describe("balanced v2 · scan", () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    nock.cleanAll();
    // `D[]` is relative to whatever day `npm test` actually runs on (see the
    // comment above it), so it drifts across the real week — including
    // Sundays and Mondays. None of the tests in THIS describe are about the
    // closed-weekday feature (that is `balanced v2 · scan · closed
    // weekdays`, below), so it is disabled here with an out-of-range value
    // that `BALANCED_CLOSED_WEEKDAYS` documents as silently dropped, leaving
    // the closed set empty — otherwise every assertion counting exactly
    // `days_checked.length` would be a coin flip on the calendar.
    testEnv({ ENABLE_MULTI_BARBER: "true", BALANCED_CLOSED_WEEKDAYS: "none" });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    nock.cleanAll();
  });

  // ── D2. the constraint is a FILTER, not a preference ─────────────────────

  /**
   * *** THE LITERAL CASE FROM THE PRODUCTION CALL. ***
   *
   * The salon has 14:00, 14:30 and 19:00. The caller said «a partir de las
   * cinco». `discover` with `preferred_time: "17:00"` ranks 14:30 first — it is
   * the nearest hour — and offers it, which is a wrong answer politely sorted.
   * `after_time` is a floor: the two afternoon hours are not offered at all,
   * and the day's summary still says the salon HAS three hours, so the agent
   * can say «ese día tengo hueco, pero no a partir de las cinco» rather than
   * «no tengo nada».
   */


  /**
   * An impossible pair is not a refusal, and the FLOOR is what survives.
   *
   * Keeping the ceiling instead would offer mornings to a caller who just said
   * "a partir de las cinco" — the exact wrong answer this action exists to
   * stop.
   */

  // ── the per-day cap: a page names days, not one busy afternoon ───────────

  /**
   * *** A WINDOW WHERE ONLY ONE DAY MATCHES HAS NOTHING TO SPREAD ACROSS. ***
   *
   * `days: 2`, the second day is closed, so every matching hour in the window
   * belongs to the one day that has any. Applying the per-day cap here would
   * truncate the RANKING itself before `has_more` and the continuation ever
   * see the other three hours — the production bug this test now guards
   * against. The wide cap (`BALANCED_CONTINUATION_MAX_SLOTS`) applies
   * instead, exactly as it would if the caller had asked about that one day
   * alone.
   */

  /**
   * *** AND THE SAME DAY, ASKED AS A ONE-DAY QUESTION, IS NOT CAPPED AT TWO. ***
   *
   * The discriminant for the per-day cap being a BREADTH rule. The prompt sends
   * «el martes a partir de las cinco» to `scan` with `days: 1`, and the two-per-
   * day cap then truncated the RANKING itself: the caller was read two of the
   * three hours the salon had, `has_more` said false, and «¿no tienes nada más
   * ese día?» answered `no_more_options` about an hour that was free. The number
   * spoken was a property of the cap rather than of the salon.
   */

  /**
   * The same property when the day is fuller than one spoken page: `more` can
   * reach the rest instead of `no_more_options` lying about a full afternoon.
   */


  // ── D6. the page is numbered in (date, time) order ───────────────────────

  /**
   * *** THE DISCRIMINANT FOR `numberPage`. ***
   *
   * It sorted on `time` alone, which is invisible while every page comes from
   * one day and wrong the moment a page spans several: this fixture would have
   * been numbered 09:00, 12:00, 18:00 — Tuesday first, Monday last — while the
   * sentence around it lists the days in calendar order. The caller who says
   * «la primera» means the first thing they heard.
   */

  // ── D3. the window is read in parallel, and a warm one costs nothing ─────



  // ── R1. the fan-out leaves a permit free, so the scan cannot starve itself ─

  /**
   * *** THE DISCRIMINANT FOR THE STARVATION. ***
   *
   * `AgendaSource.fetchDay` takes the ONE global limiter twice per day — roster,
   * then free hours — and lets go in between. Fanning out to `days` therefore
   * made a seven-day scan compete with itself for three permits: three slow days
   * held all three, the fast days could not get their SECOND call, and the
   * deadline expired on a window whose fast days had been ready for two seconds.
   * The measured answer was `days_checked: []` — «no tengo nada» about a week
   * with four days of hours in it.
   *
   * The fix is a property of this service and is asserted as one: however many
   * days the window has, the scan never has more than `capacity − 1` of them in
   * flight, so there is always a permit left for a day already in progress — and
   * for the other conversations sharing the process.
   */
  it("never reads more than the upstream capacity minus one day at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const service = scanService(
      {
        read: async (date: string) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return { day: soloDay(date, ["10:00"]), outcome: "miss" as const, ageMs: 0 };
        },
      },
      { scanDeadlineMs: 5_000, closedWeekdays: new Set() },
    );

    const result = await service.scan(
      {
        conversation_id: conv("scan-fanout"),
        service_id: 1,
        date_from: D[0],
        days: BALANCED_SCAN_MAX_DAYS,
      },
      Date.now(),
    );

    // The whole window still arrives — the narrower fan-out costs breadth of
    // PARALLELISM, never breadth of answer.
    expect(result.days_checked).toHaveLength(BALANCED_SCAN_MAX_DAYS);
    expect(result.partial).toBe(false);
    expect(maxInFlight).toBe(BALANCED_SCAN_UPSTREAM_CAPACITY_DEFAULT - 1);
  });

  it("widens the fan-out when the process is running a bigger limiter, and never fills it", async () => {
    const seen: number[] = [];
    for (const capacity of [1, 2, 8]) {
      let inFlight = 0;
      let maxInFlight = 0;
      const service = scanService(
        {
          read: async (date: string) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight -= 1;
            return { day: soloDay(date, ["10:00"]), outcome: "miss" as const, ageMs: 0 };
          },
        },
        { scanDeadlineMs: 5_000, upstreamMaxConcurrency: capacity, closedWeekdays: new Set() },
      );
      const result = await service.scan(
        {
          conversation_id: conv(`scan-fanout-${capacity}`),
          service_id: 1,
          date_from: D[0],
          days: BALANCED_SCAN_MAX_DAYS,
        },
        Date.now(),
      );
      expect(result.days_checked).toHaveLength(BALANCED_SCAN_MAX_DAYS);
      seen.push(maxInFlight);
    }
    // A capacity of 1 still reads its window, one day at a time, rather than
    // fanning out to zero and reading nothing.
    expect(seen).toEqual([1, 1, 7]);
  });

  /**
   * *** THE CONTAINER, NOT JUST THE SERVICE, HAS TO PASS THE CAPACITY ON. ***
   *
   * The two tests above prove the service fans out correctly WHEN it is told
   * the process's real capacity — but they build `BalancedAvailabilityService`
   * directly with `scanService()`, which hands it `upstreamMaxConcurrency`
   * itself. Production never does that: `src/services/container.ts` builds
   * the same service from `env.UPSTREAM_MAX_CONCURRENCY`, and until that wire
   * exists the constructor argument is simply never supplied — the service
   * falls back to its own default (`BALANCED_SCAN_UPSTREAM_CAPACITY_DEFAULT`,
   * 3) regardless of what the deployment's env says.
   *
   * So this one goes through `createServices` — the real container — and
   * through the real (nock-mocked) HTTP layer, and reuses the same
   * inFlight/maxInFlight counter as the two tests above, adapted to count
   * upstream HTTP calls rather than in-process reads. `UPSTREAM_MAX_CONCURRENCY
   * = 5` gives `balancedScanFanOut(7, 5) = min(7, 5 − 1) = 4`; the service's
   * own hardcoded default would have produced `min(7, 3 − 1) = 2` instead, so
   * the two are distinguishable.
   */

  /**
   * *** AND THE SPARE PERMIT IS FOR EVERYBODY ELSE, NOT ONLY FOR THIS SCAN. ***
   *
   * The second caller is the one the starvation hurt invisibly: a cold seven-day
   * window used to hold every permit the process had, so an unrelated
   * conversation's `discover` — a caller who named a day and is waiting on the
   * phone — queued behind fourteen upstream calls. With a permit always free it
   * waits for at most one call in progress.
   *
   * Measured in injected round trips rather than in milliseconds: `discover`
   * costs two sequential upstream calls of its own, and the assertion allows one
   * more on top of them.
   */

  // ── D4. the deadline: a day that did not arrive is REPORTED ──────────────

  /**
   * At the service, with the deadline shrunk to milliseconds.
   *
   * The behaviour under test is "a day that has not arrived is absent from
   * `days_checked` and sets `partial`", which is a property of the mechanism
   * rather than of the number — so the test asserts it in 60 ms instead of
   * sleeping for the real 2.5 s. The HTTP test below pays the real deadline
   * once, to prove the whole route still answers 200.
   */
  it("answers with the days it has, and never counts a missing day as empty", async () => {
    const day = (date: string, times: string[]): AgendaDay => ({
      date,
      serviceId: "1",
      employees: [BRUNO],
      free: [
        {
          id: BRUNO.id,
          name: BRUNO.name,
          surnames: BRUNO.surnames,
          date: `${date} 14:00:00`,
          slots: times.map((time) => ({
            start: `${date} ${time}:00`,
            end: `${date} ${time}:00`,
          })),
        },
      ],
      fetchedAtMs: Date.now(),
      upstreamCalls: 2,
    });

    const stuck = new Promise<never>(() => {
      /* never settles: the salon simply does not answer for this day */
    });
    const agenda: AgendaReader = {
      read: async (date) =>
        date === D[1]
          ? stuck
          : { day: day(date, ["10:00"]), outcome: "miss" as const, ageMs: 0 },
      readFresh: async (date) => ({
        day: day(date, ["10:00"]),
        outcome: "bypass" as const,
        ageMs: 0,
      }),
      invalidate: () => 0,
    };

    const service = new BalancedAvailabilityService({
      agenda,
      options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 8 }),
      slotAuthorization: new SlotAuthorizationService({
        secret: SLOT_TOKEN_SECRET,
        ttlSeconds: 600,
      }),
      offerStore: new MemoryVoiceOfferStore({
        ttlSeconds: 3_600,
        maxEntries: 8,
        digestKey: SLOT_TOKEN_SECRET,
      }),
      scanDeadlineMs: 60,
    });

    const result = await service.scan(
      {
        conversation_id: conv("scan-deadline"),
        service_id: 1,
        date_from: D[0],
        days: 3,
      },
      Date.now(),
    );

    expect(result.outcome).toBe("options_available");
    expect(result.partial).toBe(true);
    expect(result.days_checked).toEqual([D[0], D[2]]);
    // The day that did not arrive contributes NOTHING — not an empty day, not
    // a zero count, not a summary line saying the salon has nothing.
    expect((result.days_summary ?? []).map((entry) => entry.date)).toEqual([D[0], D[2]]);
    expect(result.options.map((option) => option.date)).toEqual([D[0], D[2]]);
  });


  /**
   * The same property at the service, in milliseconds instead of 2.5 s, and
   * with the DISCRIMINANT the HTTP test cannot state: one day arriving is
   * enough to make the answer an answer again.
   */
  it("says the agenda is unavailable when not one day of the window arrived", async () => {
    const stuck = new Promise<never>(() => {
      /* the salon never answers, for any day of the window */
    });
    const service = scanService({ read: async () => stuck });

    const result = await service.scan(
      {
        conversation_id: conv("scan-nothing-read"),
        service_id: 1,
        date_from: D[0],
        days: 3,
      },
      Date.now(),
    );

    expect(result.outcome).toBe("agenda_unavailable");
    expect(result.message).toBe(BALANCED_AGENDA_UNAVAILABLE_MESSAGE);
    expect(result.days_checked).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(result.available).toBe(false);
    expect(result.options).toEqual([]);
    expect(result.total_unique_slots).toBe(0);
    expect(result.external_mutation).toBe(false);
  });

  it("is a PARTIAL answer, not an outage, the moment one day of the window lands", async () => {
    const stuck = new Promise<never>(() => {
      /* two of the three days never answer */
    });
    const service = scanService({
      read: async (date: string) =>
        date === D[0]
          ? { day: soloDay(D[0]!, ["10:00"]), outcome: "miss" as const, ageMs: 0 }
          : stuck,
    });

    const result = await service.scan(
      {
        conversation_id: conv("scan-one-arrived"),
        service_id: 1,
        date_from: D[0],
        days: 3,
      },
      Date.now(),
    );

    expect(result.outcome).toBe("options_available");
    expect(result.partial).toBe(true);
    expect(result.days_checked).toEqual([D[0]]);
  });

  // ── R5. page two of a window is as honest as page one ────────────────────

  /**
   * *** `partial` AND `days_checked` BELONG TO THE READ, NOT TO THE PAGE. ***
   *
   * The window is read ONCE, at the scan, and every page after that is a slice
   * of the same frozen ranking — so the two honesty fields are exactly as true
   * of page two as of page one. Dropping them was not a cosmetic omission: the
   * agent saw `partial: undefined`, concluded the window had been read in full,
   * and the prompt's rule «si `partial` es verdadero no digas siete días» could
   * not fire. The caller then heard «ya te he dicho todas las que tengo en los
   * siete días» about a week of which four days had been read.
   */
  it("carries the window's partial and days_checked into every page of it", async () => {
    const stuck = new Promise<never>(() => {
      /* the middle day of the window never answers */
    });
    const service = scanService({
      read: async (date: string) =>
        date === D[1]
          ? stuck
          : {
              day: soloDay(date, ["09:00", "10:00", "11:00"]),
              outcome: "miss" as const,
              ageMs: 0,
            },
    });
    const conversation = conv("scan-more-honest");
    const now = Date.now();

    const first = await service.scan(
      { conversation_id: conversation, service_id: 1, date_from: D[0], days: 3 },
      now,
    );
    expect(first.partial).toBe(true);
    expect(first.days_checked).toEqual([D[0], D[2]]);
    // Two days read × two offered hours each: page one takes three of the four.
    expect(first.total_unique_slots).toBe(2 * BALANCED_SCAN_MAX_PER_DAY);
    expect(first.has_more).toBe(true);

    const second = service.more({ conversation_id: conversation }, now);
    expect(second.outcome).toBe("options_available");
    expect(second.partial).toBe(true);
    expect(second.days_checked).toEqual([D[0], D[2]]);

    // …and the exhaustion sentence too, which is the page where the claim
    // «todas las que tengo en esos días» is actually made.
    const exhausted = service.more({ conversation_id: conversation }, now);
    expect(exhausted.outcome).toBe("no_more_options");
    expect(exhausted.partial).toBe(true);
    expect(exhausted.days_checked).toEqual([D[0], D[2]]);
  });


  /** A day question has no window, so it invents neither field. */

  // ── D7. an empty window is honest about what it looked at ────────────────


  /**
   * *** THE PRODUCTION INCIDENT, END TO END. ***
   *
   * A single day, read in full, with an hour floor and nothing past it: the
   * answer must name the real nearest hour it DID find (16:30, the latest
   * before the 18:00 floor) rather than gesturing at the morning — and it must
   * keep offering the same floor on another day.
   */


  // ── D8. one day of a scan is the day `discover` already answered ─────────

  /**
   * The two actions must not have two notions of what the salon has free.
   *
   * They share the intersection and the ranking (`freeTimesByEmployee` /
   * `rankOptions`); what differs is the FILTER and the per-day cap. So with a
   * day whose matching hours fit inside the cap, the two answers are the same
   * set of (date, time) — and with a fuller day, the scan's `matching_count`
   * still equals the number `discover` counts.
   */


  // ── the projection: no professional, no token, no mutation ───────────────


  /**
   * ADR-022: browsing a whole week does not retire the locked hueco — only a
   * new lock does — and the old token still books ONLY the slot it sealed.
   */

  // ── one professional, across the whole window ────────────────────────────


  // ── the request reader: required, defaulted, and dropped ─────────────────




  // ── continuing a window ──────────────────────────────────────────────────

});

/**
 * BALANCED V2 · scan · the salon's static weekly closure.
 *
 * Built with `scanService()` rather than the HTTP layer, precisely because
 * these properties need a NOWMS the test controls: which weekday `date_from`
 * falls on has to be pinned, not left to whatever day `npm test` happens to
 * run on.
 */
describe("balanced v2 · scan · closed weekdays", () => {
  // A Tuesday well clear of "today", so `readScan` never lifts `date_from`.
  const NOW_MS = Date.parse("2026-09-01T12:00:00Z");
  const SAT = "2026-09-12";
  const SUN = "2026-09-13";
  const MON = "2026-09-14";
  const TUE = "2026-09-15";

  it("a window Sat→Tue reads only the open days; Sun and Mon never reach the agenda", async () => {
    const readDates: string[] = [];
    const service = scanService({
      read: async (date: string) => {
        readDates.push(date);
        return { day: soloDay(date, ["10:00"]), outcome: "miss" as const, ageMs: 0 };
      },
    });

    const result = await service.scan(
      { conversation_id: conv("scan-closed-window"), service_id: 1, date_from: SAT, days: 4 },
      NOW_MS,
    );

    expect(readDates.sort()).toEqual([SAT, TUE]);
    expect(result.days_checked).toEqual([SAT, TUE]);
    expect(result.days_summary?.map((d) => d.date)).toEqual([SAT, TUE]);
    expect(result.partial).toBe(false);
    expect(result.outcome).toBe("options_available");
  });

  it("a window entirely inside Sun/Mon answers all-closed with zero agenda reads", async () => {
    let reads = 0;
    const service = scanService({
      read: async (date: string) => {
        reads += 1;
        return { day: soloDay(date, ["10:00"]), outcome: "miss" as const, ageMs: 0 };
      },
    });

    const result = await service.scan(
      { conversation_id: conv("scan-all-closed"), service_id: 1, date_from: SUN, days: 2 },
      NOW_MS,
    );

    expect(reads).toBe(0);
    expect(result.outcome).toBe("no_availability");
    expect(result.message).toBe(BALANCED_SCAN_ALL_CLOSED_MESSAGE);
    expect(result.days_checked).toEqual([]);
    expect(result.days_summary).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.options).toEqual([]);
    expect(result.external_mutation).toBe(false);
  });

  it("a custom closedWeekdays of {0} (Sunday only) treats Monday as open", async () => {
    const readDates: string[] = [];
    const service = scanService(
      {
        read: async (date: string) => {
          readDates.push(date);
          return { day: soloDay(date, ["10:00"]), outcome: "miss" as const, ageMs: 0 };
        },
      },
      { closedWeekdays: new Set([0]) },
    );

    const result = await service.scan(
      { conversation_id: conv("scan-custom-closed"), service_id: 1, date_from: SUN, days: 2 },
      NOW_MS,
    );

    // Sunday is still skipped; Monday, no longer in the closed set, is read.
    expect(readDates).toEqual([MON]);
    expect(result.days_checked).toEqual([MON]);
  });
});
