import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  leastLoadedEmployee,
  loadScore,
  resolveBalanceSignal,
  tieBreakKey,
} from "../src/services/balanced/employeeBalance.js";
import { buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import {
  BRUNO,
  RAMON,
  OLGA,
  conv,
  discoverThenLock,
  mockAgendaDay,
  v2,
} from "./helpers/balancedV2.js";

/**
 * BALANCED V2 — the balancing rule.
 *
 * Split in two on purpose. The first half exercises the pure function with no
 * agenda, no clock and no HTTP, because that is where the RULE lives and where
 * a counterexample is unambiguous. The second half exercises the same rule
 * through the real endpoints, because a rule that is correct in isolation and
 * never reached is not a feature.
 *
 * The assignment is invisible during discovery by design, so the end-to-end
 * assertions read it where it is first revealed: the `lock` answer.
 */

const DATE = "2026-09-16";

describe("balanced v2 · the balancing rule (pure)", () => {
  it("uses free hours as the load proxy while upstream exposes no capacity", () => {
    const candidates = [
      { employeeId: 1, freeCompatibleSlots: 1 },
      { employeeId: 2, freeCompatibleSlots: 6 },
    ];
    expect(resolveBalanceSignal(candidates)).toBe("free_slots_proxy");
    // More free hours must sort as LESS loaded.
    expect(loadScore("free_slots_proxy", candidates[1]!)).toBeLessThan(
      loadScore("free_slots_proxy", candidates[0]!),
    );
  });

  it("prefers a real occupancy ratio once every barber carries capacity data", () => {
    const candidates = [
      { employeeId: 1, freeCompatibleSlots: 2, totalCapacity: 10, occupied: 8 },
      { employeeId: 2, freeCompatibleSlots: 2, totalCapacity: 10, occupied: 3 },
    ];
    expect(resolveBalanceSignal(candidates)).toBe("occupancy_ratio");
    expect(leastLoadedEmployee(candidates, { conversationId: "c", date: DATE, time: "10:00" })).toBe(
      2,
    );
  });

  it("falls back to the proxy when capacity data is partial", () => {
    // Half-measured is not measured: comparing a ratio with a count would be
    // comparing two different scales.
    expect(
      resolveBalanceSignal([
        { employeeId: 1, freeCompatibleSlots: 2, totalCapacity: 10, occupied: 8 },
        { employeeId: 2, freeCompatibleSlots: 5 },
      ]),
    ).toBe("free_slots_proxy");
  });

  it("never lets the tie-break override a real difference in load", () => {
    // Whatever the hash ordering is, the emptier diary wins — asserted over
    // many conversation ids so a lucky one cannot hide a bug.
    for (let index = 0; index < 200; index++) {
      const winner = leastLoadedEmployee(
        [
          { employeeId: 1, freeCompatibleSlots: 1 },
          { employeeId: 2, freeCompatibleSlots: 9 },
        ],
        { conversationId: `conv_${index}`, date: DATE, time: "10:00" },
      );
      expect(winner).toBe(2);
    }
  });

  it("spreads a genuine tie across conversations instead of always picking the lowest id", () => {
    const tied = [
      { employeeId: 1, freeCompatibleSlots: 4 },
      { employeeId: 2, freeCompatibleSlots: 4 },
      { employeeId: 3, freeCompatibleSlots: 4 },
    ];
    const winners = new Map<number, number>();
    for (let index = 0; index < 300; index++) {
      const winner = leastLoadedEmployee(tied, {
        conversationId: `conv_${index}`,
        date: DATE,
        time: "10:00",
      })!;
      winners.set(winner, (winners.get(winner) ?? 0) + 1);
    }
    // All three appear, and none of them takes the whole thing. The bar is
    // deliberately loose: this asserts "the lowest id does not always win",
    // which is the requirement, not a distributional claim about SHA-256.
    expect([...winners.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    for (const count of winners.values()) {
      expect(count).toBeGreaterThan(30);
      expect(count).toBeLessThan(240);
    }
  });

  it("gives one conversation the same answer every time it asks", () => {
    const tied = [
      { employeeId: 1, freeCompatibleSlots: 4 },
      { employeeId: 2, freeCompatibleSlots: 4 },
      { employeeId: 3, freeCompatibleSlots: 4 },
    ];
    const context = { conversationId: conv("stable"), date: DATE, time: "10:00" };
    const first = leastLoadedEmployee(tied, context);
    for (let index = 0; index < 50; index++) {
      // Re-shuffled input, identical answer: the order upstream happens to
      // return the roster in must not change who is assigned.
      expect(leastLoadedEmployee([...tied].reverse(), context)).toBe(first);
    }
  });

  it("varies the tie-break by hour, so one call does not send every hour to one barber", () => {
    const context = { conversationId: conv("hours"), date: DATE };
    const ten = tieBreakKey({ ...context, time: "10:00" }, 1);
    const eleven = tieBreakKey({ ...context, time: "11:00" }, 1);
    expect(ten).not.toBe(eleven);
  });

  it("returns nothing when there is nobody to assign", () => {
    expect(leastLoadedEmployee([], { conversationId: "c", date: DATE, time: "10:00" })).toBeUndefined();
  });
});

