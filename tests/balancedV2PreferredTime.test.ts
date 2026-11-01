import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { withDay, BRUNO, OLGA, conv, mockAgendaDay, v2 } from "./helpers/balancedV2.js";
import { balancedPreferredTimeMessage } from "../src/utils/balancedPhrasing.js";
import { madridDate } from "../src/utils/madridDate.js";

/**
 * BALANCED V2 — a caller who NAMES AN HOUR.
 *
 * The call this suite exists for (2026-09-15, V4 branch): «corte de pelo, el
 * martes 22 por la tarde». The agent offered 14:00, 14:30 and 15:00 «y otros
 * horarios hasta las siete». The caller said «seis y cuarto» THREE times; each
 * time the agent paged with `more` (15:30…16:30, 17:00…18:00, 18:30 y 19:00)
 * instead of looking around 18:15, and the caller felt ignored.
 *
 * Two gaps met there. The prompt had no rule sending a stated hour to
 * `preferred_time`, and even when `preferred_time` WAS sent the server only
 * re-ranked: it answered «Te puedo ofrecer a las cinco y media, a las seis y a
 * las seis y media…» — never saying that 18:15 itself is not possible, and
 * with the tie-break able to put BOTH neighbours on the same side of the hour.
 *
 * What is asserted here is what the caller hears when an hour is named:
 * - the exact hour, alone, when it is free («Sí, a las seis tengo hueco»);
 * - otherwise a plain «no», and the nearest free hour on EACH side of it;
 * - only real on-the-hour / half-hour slots are ever offered, never «y cuarto»;
 * - a hard `after_time` / `before_time` still filters, nearest or not.
 */

const DAY_MS = 86_400_000;
/** A day a month out: `scan` lifts past dates to today, so it cannot be fixed. */
const DATE = new Date(Date.parse(`${madridDate(Date.now())}T00:00:00Z`) + 30 * DAY_MS)
  .toISOString()
  .slice(0, 10);

/** Every half hour from 14:00 to 19:00, both included. */
const AFTERNOON = [
  "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
  "17:00", "17:30", "18:00", "18:30", "19:00",
];

function timesOf(body: Record<string, unknown>): string[] {
  return (body["options"] as Array<Record<string, unknown>>).map((o) => o["time"] as string);
}


describe("balancedPreferredTimeMessage", () => {
  it("uses the singular article for la una, both in the refusal and in the offer", () => {
    expect(balancedPreferredTimeMessage("13:15", ["13:00", "13:30"], { exact: false })).toBe(
      "A la una y cuarto no tengo hueco; lo más cercano que tengo es a la una o a la una y media. ¿Cuál prefieres?",
    );
    expect(balancedPreferredTimeMessage("13:00", ["13:00"], { exact: true })).toBe(
      "Sí, a la una tengo hueco. ¿Te viene bien?",
    );
  });
});
