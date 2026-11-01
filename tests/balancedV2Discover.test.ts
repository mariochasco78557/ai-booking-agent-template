import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp, nock, testEnv, UPSTREAM, BASE_PATH } from "./helpers/testApp.js";
import { withDay, BRUNO, RAMON, OLGA, conv, mockAgendaDay, v2 } from "./helpers/balancedV2.js";
import {
  BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
  BALANCED_CLOSED_DAY_MESSAGE,
} from "../src/utils/balancedPhrasing.js";
import { madridDate } from "../src/utils/madridDate.js";

/**
 * BALANCED V2 — `action: "discover"`.
 *
 * The step that speaks. Everything asserted here is about what the CALLER
 * hears and what the model is allowed to know:
 *
 * - the count is the salon's, not a barber's;
 * - the sentence's claim ("solo me quedan dos", "también tengo otros") matches
 *   the real inventory;
 * - no professional is named, and no token is issued.
 */

const DATE = "2026-09-15";

/** The four promises a V2 answer may never make. See balancedV2Phrasing. */
const NO_CONTACT_PROMISE_RE =
  /te llamen|se pondr[\u00e1a] en contacto|llamar (?:directamente )?a la peluquer[\u00ed\u00efi]a|confirmarla directamente|la peluquer[\u00ed\u00efi]a te (?:responder|llamar)/i;

describe("balanced v2 · discover", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    nock.cleanAll();
    testEnv({ ENABLE_MULTI_BARBER: "true" });
  });

  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
  });

  async function open(): Promise<FastifyInstance> {
    app = await buildTestApp();
    return app;
  }

  function ask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      action: "discover",
      conversation_id: conv("discover"),
      service_id: 1,
      date: DATE,
      time_period: "morning",
      ...overrides,
    };
  }





  /**
   * The property that makes "solo me quedan dos" honest.
   *
   * Three barbers, all free at ten and eleven. That is TWO hours for the salon,
   * not six pairs — and the V1 path, which speaks about a barber's diary, never
   * had to get this right.
   */



  // 2026-09-15 (look-ahead): a full day is no longer a bare «¿quieres que mire
  // otro día?». The fixture answers every date with the same full roster, so
  // the look-ahead reads the next week, finds nothing in either band, and says
  // so with a concrete open offer. The old sentence is now only the fallback
  // (see balancedV2DiscoverLookAhead.test.ts).





  /** *** THE DEFINING PROPERTY OF THE DISCOVERY STEP. *** */


  // 2026-10-10: `time_period` is no longer required (a call was refused for
  // the missing band). A malformed band is dropped like any optional field
  // and the default band is searched, instead of sending the caller back.


  /**
   * *** THE SALON'S WEEKLY CLOSURE — THE CLOSED DAY ITSELF IS NEVER READ. ***
   *
   * No `mockAgendaDay(...)` is installed for either case: `tests/setup.ts`
   * keeps `nock.disableNetConnect()` on for the whole suite. Before the
   * 2026-09-15 look-ahead, a read of the closed day would have degraded to
   * `agenda_unavailable`. Now `discover` reads the FOLLOWING days to propose
   * the nearest open one; with the network blocked every such read fails, and
   * the answer falls back to the closed-day sentence — never an error. The
   * look-ahead success path lives in balancedV2DiscoverLookAhead.test.ts.
   */



  /**
   * *** SATURDAY IS AN OPEN DAY (real calls 2026-09-19). ***
   *
   * On Saturday 2026-09-19 the agent told callers «los sábados la peluquería
   * cierra» without calling any tool — a model error, not the server's. This
   * pins the server side so it can never become the cause: a Saturday reads
   * the agenda like any open day and its answer never says «cerr…».
   */

  it("the salon's «hoy» is Europe/Madrid around midnight UTC: Saturday in Madrid while UTC is still Friday, and the reverse", () => {
    // 22:30 UTC on Friday 18 = 00:30 on Saturday 19 in Madrid (CEST, UTC+2).
    expect(madridDate(Date.UTC(2026, 8, 18, 22, 30))).toBe("2026-09-19");
    // 21:59 UTC on Saturday 19 = 23:59 on Saturday 19 in Madrid.
    expect(madridDate(Date.UTC(2026, 8, 19, 21, 59))).toBe("2026-09-19");
    // 22:30 UTC on Saturday 19 = 00:30 on Sunday 20 in Madrid — closed day.
    expect(madridDate(Date.UTC(2026, 8, 19, 22, 30))).toBe("2026-09-20");
    // The weekday of a date is pure calendar: 2026-09-19 is a Saturday (6).
    expect(new Date(Date.UTC(2026, 8, 19)).getUTCDay()).toBe(6);
  });

});
