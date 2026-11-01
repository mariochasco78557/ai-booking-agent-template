import nock from "nock";
import type { FastifyInstance } from "fastify";

import { BASE_PATH, UPSTREAM, WEBHOOK_SECRET, fakeJwt } from "./testApp.js";
import { withSpokenDayEs } from "../../src/utils/balancedPhrasing.js";
import { madridDate } from "../../src/utils/madridDate.js";
import { spokenWeekdayAndDayEs } from "../../src/utils/spokenTimeEs.js";

/**
 * Fixtures for the balanced V2 flow.
 *
 * The agenda is described the way the salon actually is — a roster for the day
 * and, for each barber, the hours THEY are free — rather than as a flat list of
 * slots. That shape is not incidental: every property V2 has to hold (unique
 * hours counted once, an absent barber never chosen, a barber with no free hour
 * never chosen, load compared between barbers) is a statement about the
 * relationship between those two lists, and a fixture that flattened them could
 * not express any of it.
 *
 * The interceptors are PERSISTENT because one V2 conversation reads the agenda
 * repeatedly: once per `discover`, and once more per `lock` — that second one
 * with the cache bypassed, which is the point of ADR-010 and must not be
 * mocked away.
 */

export const BRUNO = { id: 1, name: "Bruno", surnames: "Demo" };
export const OLGA = { id: 2, name: "olga ", surnames: "demo-salon" };
export const RAMON = { id: 3, name: "ramon ", surnames: "demo-salon" };

/** `HH:mm` -> the upstream `"YYYY-MM-DD HH:mm:ss"` shape. */
export function at(date: string, time: string): string {
  return `${date} ${time}:00`;
}

export interface AgendaFixture {
  date: string;
  /** Who is ON DUTY that day. A barber absent from here is on holiday. */
  roster: Array<{ id: number; name: string; surnames: string }>;
  /**
   * Free `HH:mm` per barber id.
   *
   * A barber with an EMPTY list is omitted from `/user/free` entirely, which is
   * upstream's real way of saying "no free hour" (verified live 2026-08-30).
   * The helper reproduces that rather than returning `slots: []`, because a
   * fixture that invented an empty record would hide a whole bug class.
   */
  free: Record<number, string[]>;
}

/** Installs persistent login + agenda interceptors for ONE day. */
export function mockAgendaDay(fixture: AgendaFixture): void {
  nock(UPSTREAM).persist().post(`${BASE_PATH}/login`).reply(200, { token: fakeJwt() });

  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/employees-day`)
    .query(true)
    .reply(200, fixture.roster);

  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/free`)
    .query(true)
    .reply((uri) => {
      const ids = [...uri.matchAll(/employees(?:\[\]|%5B%5D)=(\d+)/g)].map((m) =>
        Number(m[1]),
      );
      const records = ids
        .map((id) => {
          const times = fixture.free[id] ?? [];
          if (times.length === 0) return undefined;
          const employee = fixture.roster.find((entry) => entry.id === id);
          if (employee === undefined) return undefined;
          return {
            id,
            name: employee.name,
            surnames: employee.surnames,
            date: `${fixture.date} 14:00:00`,
            slots: times.map((time) => ({
              start: at(fixture.date, time),
              end: at(fixture.date, time),
            })),
          };
        })
        .filter((record) => record !== undefined);
      return [200, records];
    });
}

/** POST to the V2 availability tool with the shared webhook secret. */
export async function v2(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url: "/ai/voice/v2/availability",
    headers: { "x-ai-webhook-secret": WEBHOOK_SECRET },
    payload,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** POST to the V2 booking tool. */
export async function v2Book(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/ai/voice/v2/book",
    headers: { ...extraHeaders, "x-ai-webhook-secret": WEBHOOK_SECRET },
    payload,
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
    raw: response.payload,
  };
}

/** A conversation id of the shape ElevenLabs actually produces. */
export function conv(suffix: string): string {
  return `conv_test_${suffix}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `discover` then `lock` of one option, returning the lock answer. */
export async function discoverThenLock(
  app: FastifyInstance,
  discover: Record<string, unknown>,
  optionIndex: number,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  await v2(app, { action: "discover", ...discover });
  const locked = await v2(app, {
    action: "lock",
    conversation_id: discover["conversation_id"],
    option_index: optionIndex,
    ...extra,
  });
  return locked.body;
}

export { nock };

/**
 * 2026-10-10 (fechas del servidor) — an answer written before every dated
 * sentence named its day, with that day named the way the server now says
 * it: `withSpokenDayEs` plus the look-ahead leads that used to be generic
 * («En los próximos días…», «Los lunes cerramos…»). `nowMs` is the clock the
 * answer was produced with (the test's fake `NOW`, or the real one).
 */
export function withDay(message: string, date: string, nowMs: number = Date.now()): string {
  const named = withSpokenDayEs(message, date, madridDate(nowMs));
  if (named !== message) return named;
  const day = spokenWeekdayAndDayEs(date);
  const Day = day[0]!.toUpperCase() + day.slice(1);
  return message
    .replace(/^En los próximos días no me queda hueco/, `${Day} y los días siguientes no me queda hueco`)
    .replace(/^En las próximas dos semanas no me queda hueco/, `${Day} y en las dos semanas siguientes no me queda hueco`)
    .replace(/^Los \S+ por la tarde cerramos/, `${Day} por la tarde cerramos`)
    .replace(/^Los \S+ cerramos/, `${Day} cerramos`);
}
