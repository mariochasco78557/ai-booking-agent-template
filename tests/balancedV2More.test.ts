import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { withDay, BRUNO, RAMON, OLGA, conv, mockAgendaDay, v2, v2Book } from "./helpers/balancedV2.js";
import {
  BALANCED_DISCOVER_OUTCOMES,
  BALANCED_LOCK_OUTCOMES,
} from "../src/schemas/balancedV2Schemas.js";
import {
  BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
  BALANCED_OPTION_UNKNOWN_MESSAGE,
} from "../src/utils/balancedPhrasing.js";
import {
  SLOT_TOKEN_PREFIX,
  SlotAuthorizationService,
} from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";

/**
 * BALANCED V2 — `action: "more"`, the continuation of the hours.
 *
 * The bug this suite exists for is the one a real call produced: the agent was
 * offered three hours, was told out loud that «también tengo otros horarios»,
 * the caller said "otros horarios", and there was no tool that could answer.
 * `has_more` promised an inventory the contract had no way to reach.
 *
 * The continuation is SERVER-SIDE and bound to `conversation_id`. The model is
 * never given a cursor, an offset or a list of hours to exclude — there is no
 * input field for one — so there is nothing for it to reconstruct, mis-copy or
 * invent. Every assertion below is about one of the invariants that makes that
 * safe:
 *
 * - a new page REPLACES the numbered table, so an index from the old page can
 *   never select the old hour;
 * - asking for more leaves the live lock alone, exactly as `discover` does
 *   (ADR-022: only a new lock replaces a lock);
 * - exhaustion is deterministic and never silently restarts at page one;
 * - a lost continuation asks the caller to look again, and never rebuilds an
 *   hour from memory;
 * - discovery and continuation name no professional, mint no token and always
 *   declare `external_mutation: false`.
 */

const DATE = "2026-09-19";

/** Six unique morning hours across three barbers. */
const SIX: Record<number, string[]> = {
  1: ["09:00", "10:00", "11:00"],
  2: ["10:30", "12:00"],
  3: ["09:30"],
};

/** Four unique morning hours: one page of three plus a tail of one. */
const FOUR: Record<number, string[]> = {
  1: ["09:00", "10:00"],
  2: ["11:00", "12:00"],
};

/** Nine unique morning hours: exactly three full pages. */
const NINE: Record<number, string[]> = {
  1: ["09:00", "09:30", "10:00"],
  2: ["10:30", "11:00", "11:30"],
  3: ["12:00", "12:30", "13:00"],
};

/** A second day, used to put a REPLACEMENT discovery in flight. */
// A past Saturday, like `DATE`: a literal future date would lose its hours on
// that very day under the minimum lead time (2026-09-18).
const DATE_SLOW = "2026-09-12";

/**
 * *** THE FOUR PROMISES A V2 ANSWER MAY NEVER MAKE. ***
 *
 * Each alternative is a whole promise rather than a keyword, so the lock is
 * about MEANING and not about the letters "llam": «En esta llamada ya hay una
 * cita hecha» is a fact about the conversation in progress and is allowed,
 * while «que te llamen desde la peluquería» commits a person to an action this
 * middleware neither performs nor observes.
 */
const NO_CONTACT_PROMISE_RE =
  /te llamen|se pondr[áa] en contacto|llamar (?:directamente )?a la peluquer[ií]a|confirmarla directamente|la peluquer[ií]a te (?:responder|llamar)/i;

/** The `/user/free` records upstream really returns for one day. */
function freeRecords(date: string, table: Record<number, string[]>, uri: string): unknown[] {
  const roster = [BRUNO, OLGA, RAMON];
  const ids = [...uri.matchAll(/employees(?:\[\]|%5B%5D)=(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  return ids
    .map((id) => {
      const times = table[id] ?? [];
      const employee = roster.find((entry) => entry.id === id);
      if (times.length === 0 || employee === undefined) return undefined;
      return {
        id,
        name: employee.name,
        surnames: employee.surnames,
        date: `${date} 14:00:00`,
        slots: times.map((time) => ({
          start: `${date} ${time}:00`,
          end: `${date} ${time}:00`,
        })),
      };
    })
    .filter((record) => record !== undefined);
}

/**
 * Two days from one interceptor, with the SECOND day held open.
 *
 * `mockAgendaDay` answers instantly, which is exactly the shape that cannot
 * express the race this fixture exists for: a `discover` that is still waiting
 * for the salon while a `more` arrives on the same conversation. The gate is a
 * promise the test resolves by hand, so "in flight" is a state the test
 * controls rather than a sleep it hopes is long enough.
 */
function mockGatedSecondDay(
  gate: Promise<void>,
  days: Record<string, Record<number, string[]>>,
): void {
  nock(UPSTREAM).persist().post(`${BASE_PATH}/login`).reply(200, { token: fakeJwt() });
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/employees-day`)
    .query(true)
    .reply(200, [BRUNO, OLGA, RAMON]);
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/free`)
    .query(true)
    .reply(async (uri) => {
      const date = /[?&]date=([0-9-]+)/.exec(uri)?.[1] ?? "";
      if (date === DATE_SLOW) await gate;
      return [200, freeRecords(date, days[date] ?? {}, uri)];
    });
}

/** Lets every already-queued continuation run before the test looks again. */
async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function times(body: Record<string, unknown>): string[] {
  return (body["options"] as Array<{ time: string }>).map((option) => option.time);
}

function indices(body: Record<string, unknown>): number[] {
  return (body["options"] as Array<{ option_index: number }>).map(
    (option) => option.option_index,
  );
}

describe("balanced v2 · more", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    nock.cleanAll();
    testEnv({ ENABLE_MULTI_BARBER: "true" });
  });

  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
  });

  function discoverBody(
    conversation: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      action: "discover",
      conversation_id: conversation,
      service_id: 1,
      date: DATE,
      time_period: "morning",
      ...overrides,
    };
  }

  function moreBody(
    conversation: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { action: "more", conversation_id: conversation, ...overrides };
  }

  // ── 1. six hours: two full pages, no repetition ──────────────────────────



  // ── 2. four hours: three then one ────────────────────────────────────────


  // ── 3. exhaustion is deterministic and never restarts ────────────────────



  // ── 4. a new page replaces the table ─────────────────────────────────────


  /** ADR-022: asking for other hours never retires a lock; only a new lock does. */

  // ── 5. the current page locks the exact hour, and only then mints ────────


  // ── 6. an hour taken between the continuation and the lock ───────────────


  // ── 7. two conversations share nothing ───────────────────────────────────


  // ── 8. a lost or contradicted continuation ───────────────────────────────


  /**
   * *** THE LOSS IS CAUSED BY THE STORE, NOT BY THE TEST. ***
   *
   * This assertion used to model "the continuation is gone" by having the TEST
   * call `publish(conversation, [], now)` — which is the very statement the
   * production code makes on the `continuation_lost` branch. It therefore
   * proved only that `publish([])` empties a record, and would have stayed
   * green with the whole `more` refusal path deleted.
   *
   * Here the record disappears because the STORE evicted it: `maxEntries` is 1,
   * and a second live call is enough to push the first out (least recently
   * touched first, `MemoryBalancedOptionStore.evictOverflow`). That is a real
   * reason a continuation is lost in production — the other being the TTL,
   * exercised by the two assertions below — and nothing in the test touches the
   * evicted conversation's record.
   *
   * The `publish([])` the service itself performs on this branch is DEFENCE IN
   * DEPTH, not the mechanism: the record is already gone, so the call is a
   * no-op here. It exists for the narrower case where a record survives with
   * options but WITHOUT a continuation, and it is what guarantees that no
   * surviving index stays choosable once the page behind it cannot be
   * continued.
   */

  /**
   * The same property, lost the OTHER real way: the record aged out.
   *
   * `MemoryBalancedOptionStore` expires lazily, so reading it at a clock past
   * the TTL is what deletes the record — the deletion is the store's, and the
   * test only moves the clock it is asked about, exactly as
   * "lets a continuation age out" does below.
   */




  // ── 9. no professional, no token, never a mutation ───────────────────────


  // ── 10. every answer is an HTTP 200 the contract knows ───────────────────


  // ── 11. a contradicted continuation also retires the numbered table ──────

  /**
   * *** A REFUSAL MUST NOT LEAVE THE OLD PAGE CHOOSABLE. ***
   *
   * `continuation_mismatch` is the agent saying, in the same breath, "continue"
   * and "…a different question". Refusing to paginate was already right; what
   * was missing is that the THREE NUMBERS the caller is holding belonged to the
   * question the agent has just abandoned. Leaving them live means `lock(2)`
   * still books an hour on a day nobody is talking about any more.
   *
   * The continuation itself is deliberately KEPT — only the options go — so an
   * agent that immediately re-asks correctly still gets the page it was owed
   * instead of being sent back to `discover` for its own bad field.
   */

  // ── 12. a discover in flight is never paginated ──────────────────────────

  /**
   * *** THE WINDOW BETWEEN A REPLACEMENT DISCOVERY AND ITS ANSWER. ***
   *
   * `discover` suspends at the agenda read. Everything it is about to replace —
   * the page, the cursor, the whole frozen ranking — is still readable for the
   * whole of that suspension, and `more` is synchronous, so a "otros horarios"
   * that lands in the window used to be answered from the ranking of a question
   * that was ALREADY being thrown away. The caller would then hear hours for
   * the previous day, numbered 1, 2, 3, moments before the new day's hours
   * arrived with the same three numbers.
   *
   * So the continuation is retired at the TOP of `discover`, before the await,
   * not after the answer comes back.
   */

  // ── 13. two continuations at once ────────────────────────────────────────

  /**
   * *** `more` IS ATOMIC, AND THAT IS WHY TWO OF THEM CANNOT COLLIDE. ***
   *
   * It reads the cursor, cuts the page and publishes the new cursor with no
   * suspension point anywhere in between, so two overlapping continuations are
   * serialized by the runtime itself: one gets page two, the other page three,
   * and no hour is spoken twice. The moment `more` gained an `await` this would
   * stop being true — which is what the last assertion pins.
   */

  /**
   * *** `more` MUST STAY SYNCHRONOUS. ***
   *
   * Not a style preference: the atomicity asserted above is a property of the
   * FUNCTION, not of the store, and an `async` keyword on it would insert a
   * suspension point between reading the cursor and publishing the next page.
   * A signature check is the only assertion that catches that before it becomes
   * a race nobody can reproduce.
   */
  it("is a synchronous function that makes no upstream call", () => {
    const agenda = {
      read: async () => {
        throw new Error("more must not read the agenda");
      },
      readFresh: async () => {
        throw new Error("more must not read the agenda");
      },
      invalidate: () => 0,
    } as unknown as AgendaReader;
    const service = new BalancedAvailabilityService({
      agenda,
      options: new MemoryBalancedOptionStore({ ttlSeconds: 3600, maxEntries: 8 }),
      slotAuthorization: new SlotAuthorizationService({
        secret: SLOT_TOKEN_SECRET,
        ttlSeconds: 600,
      }),
      offerStore: new MemoryVoiceOfferStore({
        ttlSeconds: 3600,
        maxEntries: 8,
        digestKey: SLOT_TOKEN_SECRET,
      }),
    });

    const answer = service.more(
      { action: "more", conversation_id: conv("more-sync") },
      Date.now(),
    );
    expect(answer).not.toBeInstanceOf(Promise);
    expect(answer.outcome).toBe("continuation_lost");
    expect(answer.external_mutation).toBe(false);
  });

  /**
   * *** THE DEFENCE IN DEPTH ON THE LOST BRANCH, TESTED WHERE IT BITES. ***
   *
   * `MemoryBalancedOptionStore` loses a page and its cursor together, so
   * against the real store the empty publish on `continuation_lost` is a no-op
   * and no end-to-end assertion can distinguish it from its absence. That is
   * exactly why it is worth pinning HERE: the invariant it defends is "no index
   * stays choosable once the page behind it cannot be continued", and the state
   * it defends against — options alive, continuation gone — is one a different
   * store (a shared one, a replica, a future TTL split) could present.
   *
   * A store stub is the only place that state exists, so this is the only place
   * the guarantee can be asserted rather than assumed.
   */
  it("retires the options when a store hands back a page it cannot continue", () => {
    const published: Array<{ options: unknown[]; continuation: unknown }> = [];
    const stubbornStore = {
      // A record that still holds THREE options and no way to continue them.
      publish: (_id: string, options: readonly unknown[], _now: number, continuation?: unknown) => {
        published.push({ options: [...options], continuation });
        return 1;
      },
      get: () => ({ ok: false as const, refusal: "unknown_option" as const }),
      continuation: () => undefined,
      peek: () => undefined,
      size: 1,
    };
    const service = new BalancedAvailabilityService({
      agenda: {
        read: async () => {
          throw new Error("more must not read the agenda");
        },
        readFresh: async () => {
          throw new Error("more must not read the agenda");
        },
        invalidate: () => 0,
      } as unknown as AgendaReader,
      options: stubbornStore as unknown as MemoryBalancedOptionStore,
      slotAuthorization: new SlotAuthorizationService({
        secret: SLOT_TOKEN_SECRET,
        ttlSeconds: 600,
      }),
      offerStore: new MemoryVoiceOfferStore({
        ttlSeconds: 3600,
        maxEntries: 8,
        digestKey: SLOT_TOKEN_SECRET,
      }),
    });

    const answer = service.more(
      { action: "more", conversation_id: conv("more-stubborn") },
      Date.now(),
    );

    expect(answer.outcome).toBe("continuation_lost");
    // It published, and it published EMPTY: the numbered table is retired even
    // though the refusal itself had nothing to continue.
    expect(published.length).toBe(1);
    expect(published[0]?.options).toEqual([]);
    // …and without a continuation, so "no options" and "nowhere to continue
    // from" stay one atomic fact rather than two that could disagree.
    expect(published[0]?.continuation).toBeUndefined();
  });

  // ── 14. the last page stays choosable after exhaustion ───────────────────

  /**
   * *** RUNNING OUT OF HOURS DOES NOT WITHDRAW THE ONES ALREADY OFFERED. ***
   *
   * The caller hears three hours, asks for more, hears one, asks for more,
   * hears "ya no me quedan más" — and then picks the one they liked. That is
   * the ordinary shape of the conversation, so `no_more_options` deliberately
   * publishes nothing: the LAST page stays on the table and its numbers still
   * resolve. A refusal that also wiped the page would make the exhaustion
   * sentence a dead end, which is the exact fault this whole action exists to
   * remove.
   */

  // ── 15. the token dies on the refusing paths too ─────────────────────────

  /**
   * *** A `more` THAT OFFERS NOTHING KEEPS THE LOCKED HUECO. ***
   *
   * Changed 2026-09-15 (incident 2026-09-14, (internal doc, not included in the template)). These
   * two tests used to assert that a REFUSING `more` retired the lock. The rule
   * is now uniform for discover/more/scan (ADR-022): no answer retires it, only
   * a new successful lock does (see "keeps a live authorization when the caller
   * asks for other hours" above). A refusal offers the
   * caller nothing, so the hour they locked is still the one on the table —
   * and every other gate (seal, conversation, expiry, agenda re-check,
   * journal) still decides the booking.
   */


  // ── 16. after a fallback, EITHER band is a legitimate thing to resend ────

  /**
   * *** THE BAND THE CALLER ASKED FOR IS NOT A CONTRADICTION. ***
   *
   * After a fallback the conversation contains two bands at once: the caller
   * asked for the morning, the salon answered with the afternoon, and both
   * sentences were spoken out loud. An agent that resends EITHER is repeating
   * something true, so `contradicts` accepts both stored bands — and a `more`
   * that carried the requested one must not be refused with «necesito volver a
   * mirar la agenda», which would strand the caller at the exact moment the
   * flow was finally working.
   *
   * There are only two bands, so a third is not expressible: `time_period` is
   * an optional field and an unreadable one is DROPPED rather than refused
   * (`readMore`), exactly as in `readDiscover`.
   */

  // ── 17. the V2 degraded sentence promises no call back ───────────────────

});
