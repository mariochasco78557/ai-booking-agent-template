import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { Clock } from "../../src/callEngine/domain/types.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import { baseSyntheticVenue, ALEX_ID, DANI_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import {
  runConversation,
  type ConversationScript,
  type ConversationResult,
  type ConversationTurn,
  type DayName,
} from "../../src/callEngine/engine.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { canTransition, reachesFinFrom, STATES } from "../../src/callEngine/stateMachine.js";
import { createManualBooking } from "../../src/callEngine/operations/manualBooking.js";
import { isSlotFree } from "../../src/callEngine/calendar/resolveAvailability.js";

// "today" is 2026-08-02 (a Sunday) throughout, so "monday" -> 2026-08-03 and
// "tuesday" -> 2026-08-04, both inside baseSyntheticVenue()'s Mon/Tue
// 09:00-17:00 (break 13:00-14:00) synthetic schedule.
function makeDeps(overrides: { cal?: CalendarWithCapabilities; clock?: Clock; liveTransferAvailable?: boolean } = {}) {
  return {
    cal: overrides.cal ?? baseSyntheticVenue(),
    clock: overrides.clock ?? fixedClock("2026-08-02", 9 * 60),
    emitter: createCallEventEmitter(),
    store: createMemoryStore(),
    salt: "engine-test-salt",
    ...(overrides.liveTransferAvailable !== undefined ? { liveTransferAvailable: overrides.liveTransferAvailable } : {}),
  };
}

function run(script: ConversationScript, overrides?: Parameters<typeof makeDeps>[0]): ConversationResult {
  return runConversation(makeDeps(overrides), script);
}

function expectScenario(
  result: ConversationResult,
  expected: {
    outcome: ConversationResult["outcome"];
    reasonCode: ConversationResult["reasonCode"];
    announcesSuccess: boolean;
    effectiveServiceId?: 0 | 1 | 2;
  },
): void {
  expect(result.outcome).toBe(expected.outcome);
  expect(result.reasonCode).toBe(expected.reasonCode);
  expect(result.announcesSuccess).toBe(expected.announcesSuccess);
  expect(result.externalMutation).toBe(false);
  if (expected.effectiveServiceId !== undefined) {
    expect(result.effectiveServiceId).toBe(expected.effectiveServiceId);
  }
}

// ---------------------------------------------------------------------
// A01..A15 — docs/call_interruption_mvp/acceptance-scenarios.json.
//
// step 13 correction (A7 in the final report): this block used to
// hand-recode all 15 scenarios' `expected` values as separate, independent
// `expectScenario(...)` calls, with nothing actually reading the frozen
// JSON fixture — so a drift between the JSON and this test (either one
// changing without the other) would have been silently undetectable. This
// version READS docs/call_interruption_mvp/acceptance-scenarios.json at
// test time and iterates its `scenarios` array directly, asserting each
// one's own declared `expected.outcome`, `expected.reasonCode`,
// `expected.announcesSuccess`, `expected.externalMutation` (always
// asserted `=== false` on top of matching the JSON, since that is this
// module's own hard invariant) and `expected.syntheticMutation`/
// `expected.effectiveServiceId` when present.
// ---------------------------------------------------------------------

interface RawAcceptanceScenario {
  id: string;
  title: string;
  intent: string;
  given: {
    day?: DayName;
    time?: string;
    professionalId?: number;
    serviceId?: 0 | 1 | 2 | null;
    serviceConfirmed?: boolean;
    bookingConfirmed?: boolean;
    reservationRef?: string;
    explicitlyRequestsHuman?: boolean;
    attemptsThirdPartyAccess?: boolean;
    injectFailure?: boolean;
    // These three JSON fields have NO ConversationTurn equivalent — see the
    // declared, commented adaptation map below.
    clarificationAttempted?: boolean;
    intentResolved?: boolean;
    alsoRequestsCancellation?: boolean;
  };
  expected: {
    outcome: ConversationResult["outcome"];
    reasonCode: ConversationResult["reasonCode"];
    announcesSuccess: boolean;
    externalMutation: false;
    syntheticMutation: boolean;
    effectiveServiceId?: 0 | 1 | 2;
  };
}

function loadAcceptanceScenarios(): RawAcceptanceScenario[] {
  const path = join(process.cwd(), "docs", "call_interruption_mvp", "acceptance-scenarios.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { scenarios: RawAcceptanceScenario[] };
  return parsed.scenarios;
}

/**
 * DECLARED, AUDITABLE ADAPTATION MAP (A7): the frozen JSON fixture
 * intentionally carries no literal caller utterance — utterance wording is
 * this engine's own internal vocabulary (intent.ts), not part of the
 * frozen v1 contract. This is the SINGLE place that supplies one, for each
 * scenario id, chosen so `classifyIntent` reaches the scenario's own
 * declared `intent` field. The test below fails loudly (via
 * `describedScenarioIds`, and via the per-scenario lookup itself) if the
 * JSON ever gains a scenario id this map does not cover.
 *
 * The three JSON `given` fields with no `ConversationTurn` field
 * (`clarificationAttempted`, `intentResolved`, `alsoRequestsCancellation`)
 * are narrative flags describing WHAT HAPPENED in the scenario, not inputs
 * this engine consumes directly — they are satisfied structurally instead:
 *   - A11 (`clarificationAttempted: true, intentResolved: false`): a
 *     single unrecognisable utterance is enough — this engine always
 *     attempts exactly one clarification regardless of whether a second
 *     scripted turn exists (see engine.ts: `nextScriptTurn()` returning
 *     `undefined` after the CLARIFY_ONCE prompt is itself "clarification
 *     attempted, intent still unresolved").
 *   - A14 (`alsoRequestsCancellation: true`): a single utterance names
 *     both operations, exactly as intent.ts's own docblock prescribes
 *     (HUMAN_HELP is checked before CANCEL specifically so this ordering
 *     is exercised for real).
 */
const UTTERANCE_BY_SCENARIO_ID: Readonly<Record<string, string>> = {
  "A01-explicit-service-booking": "quiero reservar una cita",
  "A02-service-not-confirmed": "quiero reservar una cita",
  "A03-availability-information": "quiero consultar disponibilidad",
  "A04-human-request": "quiero hablar con una persona",
  "A05-cancel-never-mutates": "quiero cancelar mi cita",
  "A06-reschedule-never-mutates": "quiero cambiar la cita de hora",
  "A07-unknown-price": "cuanto cuesta el corte de pelo",
  "A08-technical-failure": "quiero reservar una cita",
  "A09-break-is-unavailable": "quiero consultar disponibilidad",
  "A10-third-party-privacy-boundary": "esto es una prueba",
  "A11-intent-unresolved-after-clarification": "asdkjh qwerty zzz",
  "A12-security-precedence-over-technical-failure": "esto es una prueba",
  "A13-technical-failure-overrides-imminent-booking": "quiero reservar una cita",
  "A14-human-request-overrides-cancel-block": "quiero cancelar mi cita pero prefiero hablar con una persona",
  "A15-cancel-intent-yielding-to-explicit-human-request": "quiero cancelar mi cita",
};

function buildTurnFromScenario(scenario: RawAcceptanceScenario): ConversationTurn {
  const { clarificationAttempted, intentResolved, alsoRequestsCancellation, ...engineGiven } = scenario.given;
  // Acknowledged, deliberately unused here — see the adaptation map
  // docblock above for how each is satisfied structurally instead.
  void clarificationAttempted;
  void intentResolved;
  void alsoRequestsCancellation;

  const utterance = UTTERANCE_BY_SCENARIO_ID[scenario.id];
  if (utterance === undefined) {
    throw new Error(
      `acceptance-scenarios.json has a scenario ("${scenario.id}") with no entry in this test's ` +
        "UTTERANCE_BY_SCENARIO_ID adaptation map — see the A7 correction note above.",
    );
  }
  return { ...engineGiven, utterance };
}

describe("acceptance scenarios A01..A15 (read directly from acceptance-scenarios.json)", () => {
  const scenarios = loadAcceptanceScenarios();

  it("every JSON scenario has a declared engine adaptation (utterance mapping)", () => {
    for (const scenario of scenarios) {
      expect(UTTERANCE_BY_SCENARIO_ID[scenario.id], `missing adaptation for "${scenario.id}"`).toBeDefined();
    }
  });

  it("loaded at least the 15 frozen scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
  });

  for (const scenario of loadAcceptanceScenarios()) {
    it(`${scenario.id}: ${scenario.title}`, () => {
      const turn = buildTurnFromScenario(scenario);
      const result = run({
        scenarioId: scenario.id,
        callId: `call-${scenario.id}`,
        turns: [turn],
      });
      expect(result.outcome).toBe(scenario.expected.outcome);
      expect(result.reasonCode).toBe(scenario.expected.reasonCode);
      expect(result.announcesSuccess).toBe(scenario.expected.announcesSuccess);
      expect(result.externalMutation).toBe(false);
      expect(result.externalMutation).toBe(scenario.expected.externalMutation);
      expect(result.syntheticMutation).toBe(scenario.expected.syntheticMutation);
      if (scenario.expected.effectiveServiceId !== undefined) {
        expect(result.effectiveServiceId).toBe(scenario.expected.effectiveServiceId);
      }
    });
  }

  it("A01's reservation, specifically, lands on the requested professional (Álex)", () => {
    const a01 = scenarios.find((s) => s.id === "A01-explicit-service-booking");
    expect(a01).toBeDefined();
    const turn = buildTurnFromScenario(a01 as RawAcceptanceScenario);
    const result = run({ scenarioId: "A01-explicit-service-booking", callId: "call-a01-employee-check", turns: [turn] });
    expect(result.reservation?.employeeId).toBe(ALEX_ID);
  });
});

// ---------------------------------------------------------------------
// Additional required coverage beyond A01..A15.
// ---------------------------------------------------------------------

describe("one missing field collected per turn", () => {
  it("asks for service, then date, then time, then professional — one at a time — before confirming", () => {
    const result = run({
      scenarioId: "A16-one-field-per-turn",
      callId: "call-field-by-field",
      turns: [
        { utterance: "quiero reservar una cita" },
        { serviceId: 1 },
        { day: "monday" },
        { time: "10:00" },
        { professionalId: ALEX_ID },
        { serviceConfirmed: true },
        { bookingConfirmed: true },
      ],
    });
    const askKeys = result.turns.map((t) => t.phraseKey).filter((k) => k.startsWith("ASK_"));
    expect(askKeys).toEqual([
      "ASK_SERVICE",
      "ASK_DATE",
      "ASK_TIME",
      "ASK_PROFESSIONAL",
      "ASK_SERVICE_CONFIRMATION",
      "ASK_BOOKING_CONFIRMATION",
    ]);
    expectScenario(result, { outcome: "RESUELVE", reasonCode: "BOOKING_CONFIRMED", announcesSuccess: true });
  });
});

describe("single-clarification rule", () => {
  it("clarifies intent exactly once before giving up", () => {
    const result = run({
      scenarioId: "A17-single-clarification",
      callId: "call-single-clarification",
      turns: [{ utterance: "mmm no se" }, { utterance: "tampoco se explicar esto" }],
    });
    const clarifyTurns = result.turns.filter((t) => t.phraseKey === "CLARIFY_ONCE");
    expect(clarifyTurns.length).toBe(1);
    expect(result.reasonCode).toBe("INTENT_NOT_UNDERSTOOD");
  });

  it("a clarified intent that resolves on the retry proceeds normally", () => {
    const result = run({
      scenarioId: "A18-clarification-resolves",
      callId: "call-clarification-resolves",
      turns: [
        { utterance: "mmm no se" },
        { utterance: "quiero consultar disponibilidad", day: "monday", time: "10:00", professionalId: ALEX_ID, serviceId: 1, serviceConfirmed: true },
      ],
    });
    expect(result.reasonCode).toBe("AVAILABILITY_PROVIDED");
    const clarifyTurns = result.turns.filter((t) => t.phraseKey === "CLARIFY_ONCE");
    expect(clarifyTurns.length).toBe(1);
  });
});

describe("MAX_TURNS", () => {
  it("a call that never answers eventually gives up at MAX_TURNS with INTENT_NOT_UNDERSTOOD", () => {
    const result = run({
      scenarioId: "A19-max-turns",
      callId: "call-max-turns",
      turns: [{ utterance: "quiero reservar una cita" }], // BOOK confident, but nothing else ever revealed
    });
    expect(result.reasonCode).toBe("INTENT_NOT_UNDERSTOOD");
    expect(result.outcome).toBe("DERIVA");
    const askTurns = result.turns.filter((t) => t.phraseKey.startsWith("ASK_"));
    expect(askTurns.length).toBeLessThanOrEqual(12);
  });
});

describe("structural state-machine guarantees", () => {
  it("FIN is reachable from every declared state (no dead ends)", () => {
    for (const state of STATES) {
      expect(reachesFinFrom(state)).toBe(true);
    }
  });

  it("an undeclared transition is rejected", () => {
    expect(canTransition("FIN", "INICIO")).toBe(false);
    expect(canTransition("EMITIR_RESUELVE", "RECOGER_DATOS")).toBe(false);
    expect(canTransition("INICIO", "EMITIR_RESUELVE")).toBe(false);
  });
});

describe("service confirmation is a separate gate from data collection", () => {
  it("a technical default for serviceId never substitutes for serviceConfirmed=true", () => {
    const result = run({
      scenarioId: "A20-service-default-not-consent",
      callId: "call-service-default",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "monday",
          time: "10:00",
          professionalId: ALEX_ID,
          serviceId: 1, // a value is known...
          serviceConfirmed: false, // ...but never explicitly confirmed
          bookingConfirmed: true,
        },
      ],
    });
    expect(result.reasonCode).toBe("SERVICE_NOT_CONFIRMED");
    expect(result.syntheticMutation).toBe(false);
    expect(result.reservation).toBeUndefined();
  });
});

/**
 * step 13 correction (A8 in the final report): this describe block used
 * to be named "final revalidation before writing" and claimed to prove
 * that engine.ts's final, no-cache `isSlotFree` check (immediately before
 * ESCRITURA_SINTETICA) catches a slot that became occupied in between. It
 * did not: the second call in the ORIGINAL version of this test actually
 * failed earlier, at `resolveExactSlot` (during CONSULTAR_DISPONIBILIDAD),
 * because Álex specifically was already occupied at the exact requested
 * slot — the line this test claimed to exercise was never reached in a
 * synchronous run.
 *
 * That "final, no-cache revalidation immediately before writing" cannot
 * actually be forced to disagree with the earlier check inside ONE
 * synchronous `runConversation` call: `cal` never mutates between the two
 * checks (no concurrency, no I/O, nothing that could change the answer in
 * the few lines between them) — so a black-box test cannot make them
 * disagree without inventing a test-only seam this mission was not asked
 * to add to engine.ts. That inner check remains valuable defense-in-depth
 * (never trust a possibly-stale boolean) — it is a code-review guarantee
 * here, not something a black-box test can independently demonstrate.
 *
 * What CAN be, and is, genuinely demonstrated here is the externally
 * observable property that actually protects the synthetic calendar: the
 * exact same slot can never be double-booked across two independent
 * `runConversation` calls, and — now that step 13's B3(d) fix makes a
 * reliable alternative get offered/used for BOOK too, not just
 * AVAILABILITY — this test deliberately exhausts EVERY capable
 * professional at the exact slot on BOTH working days first, so no
 * alternative silently substitutes for the refused exact slot either.
 */
describe("no double booking across separate calls, and no alternative silently substituted when genuinely none exists", () => {
  it("once every capable professional is booked at the exact slot on both working days, a repeat request for that slot is refused — not double-booked, and not silently rebooked into a false alternative", () => {
    const clock = fixedClock("2026-08-02", 9 * 60);
    const store = createMemoryStore();
    const emitter = createCallEventEmitter();
    let cal = baseSyntheticVenue();

    function book(scenarioId: string, callId: string, professionalId: number, day: DayName): ConversationResult {
      const result = runConversation(
        { cal, clock, emitter, store, salt: "double-booking-salt" },
        {
          scenarioId,
          callId,
          turns: [
            {
              utterance: "quiero reservar una cita",
              day,
              time: "10:00",
              professionalId,
              serviceId: 1,
              serviceConfirmed: true,
              bookingConfirmed: true,
            },
          ],
        },
      );
      expect(result.reasonCode).toBe("BOOKING_CONFIRMED");
      // Re-derive the calendar from the store's own snapshot (the same
      // pattern store/memoryStore.ts's `addReservation` produces
      // internally), exactly as a fresh revalidation would see it.
      cal = { ...baseSyntheticVenue(), reservations: store.snapshot().reservations };
      return result;
    }

    // Occupy Álex at 10:00 on BOTH working days, and Dani at 10:00 on
    // Monday, so `findAlternative`'s two strategies (same professional on a
    // later day; a different professional at the exact original day/time)
    // both come up empty for the request below.
    book("A21-occupy-alex-monday", "call-occupy-1", ALEX_ID, "monday");
    book("A22-occupy-alex-tuesday", "call-occupy-2", ALEX_ID, "tuesday");
    book("A23-occupy-dani-monday", "call-occupy-3", DANI_ID, "monday");

    const repeat = runConversation(
      { cal, clock, emitter, store, salt: "double-booking-salt" },
      {
        scenarioId: "A24-repeat-same-slot",
        callId: "call-repeat",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "monday",
            time: "10:00",
            professionalId: ALEX_ID,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    );
    expect(repeat.reasonCode).toBe("SLOT_OUTSIDE_SYNTHETIC_SCHEDULE");
    expect(repeat.outcome).toBe("DERIVA");
    expect(repeat.announcesSuccess).toBe(false);
    expect(repeat.syntheticMutation).toBe(false);
    expect(repeat.reservation).toBeUndefined();
  });
});

describe('"any" professional selection is deterministic', () => {
  it("picks the same professional across repeated identical runs", () => {
    const script: ConversationScript = {
      scenarioId: "A23-any-professional",
      callId: "call-any-professional",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "monday",
          time: "09:00",
          professionalId: "any",
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    };
    const results = Array.from({ length: 5 }, () => run(script));
    for (const r of results) {
      expect(r.reservation?.employeeId).toBe(results[0]?.reservation?.employeeId);
    }
    // Fully tied candidates (identical schedules, no reservations yet):
    // lowest employeeId wins, per allocation/anyProfessional.ts.
    expect(results[0]?.reservation?.employeeId).toBe(ALEX_ID);
  });
});

describe("no available exact slot: alternatives are offered instead of a false success", () => {
  it("an occupied exact slot yields AVAILABILITY_PROVIDED for a nearby free alternative, never an indefinite 'full' claim", () => {
    const clock = fixedClock("2026-08-02", 9 * 60);
    const store = createMemoryStore();
    const emitter = createCallEventEmitter();
    // Occupy Monday 10:00 for Álex first.
    const occupied = runConversation(
      { cal: baseSyntheticVenue(), clock, emitter, store, salt: "alternatives-salt" },
      {
        scenarioId: "A24-occupy-slot",
        callId: "call-occupy",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "monday",
            time: "10:00",
            professionalId: ALEX_ID,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    );
    expect(occupied.reasonCode).toBe("BOOKING_CONFIRMED");

    // Re-derive the calendar from the store, exactly as a fresh
    // `isSlotFree` revalidation would see it (see the previous describe
    // block's comment for why `deps.cal` is never mutated in place).
    const calAfterOccupied = { ...baseSyntheticVenue(), reservations: store.snapshot().reservations };
    const availability = runConversation(
      { cal: calAfterOccupied, clock, emitter, store, salt: "alternatives-salt" },
      {
        scenarioId: "A25-alternative-offered",
        callId: "call-alternative",
        turns: [
          {
            utterance: "quiero consultar disponibilidad",
            day: "monday",
            time: "10:00",
            professionalId: ALEX_ID,
            serviceId: 1,
            serviceConfirmed: true,
          },
        ],
      },
    );
    expect(availability.reasonCode).toBe("AVAILABILITY_PROVIDED");
    expect(availability.outcome).toBe("RESUELVE");
    const offered = availability.turns.some((t) => t.phraseKey === "OFFER_ALTERNATIVES");
    expect(offered).toBe(true);
  });
});

describe("determinism", () => {
  it("three identical runs of the same script produce byte-identical serialised results", () => {
    const script: ConversationScript = {
      scenarioId: "A26-determinism",
      callId: "call-determinism",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "monday",
          time: "10:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    };
    const serialised = Array.from({ length: 3 }, () => JSON.stringify(run(script)));
    expect(serialised[0]).toBe(serialised[1]);
    expect(serialised[1]).toBe(serialised[2]);
  });
});

describe("human cascade side effects are scoped correctly", () => {
  it("a normal successful booking never triggers a WhatsApp notice", () => {
    const store = createMemoryStore();
    const emitter = createCallEventEmitter();
    const result = runConversation(
      { cal: baseSyntheticVenue(), clock: fixedClock("2026-08-02", 9 * 60), emitter, store, salt: "salt" },
      {
        scenarioId: "A27-no-whatsapp-on-success",
        callId: "call-no-whatsapp",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "monday",
            time: "10:00",
            professionalId: ALEX_ID,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    );
    expect(result.reasonCode).toBe("BOOKING_CONFIRMED");
    expect(store.snapshot().internalNotices).toEqual([]);
    const { internal } = emitter.all();
    expect(internal.some((e) => e.eventName === "INTERNAL_NOTICE_SIMULATED")).toBe(false);
  });

  it("an urgent human request DOES request a live transfer, without ever claiming it completed", () => {
    const store = createMemoryStore();
    const emitter = createCallEventEmitter();
    const result = runConversation(
      {
        cal: baseSyntheticVenue(),
        clock: fixedClock("2026-08-02", 9 * 60),
        emitter,
        store,
        salt: "salt",
        liveTransferAvailable: true,
      },
      {
        scenarioId: "A28-urgent-human-request",
        callId: "call-urgent",
        turns: [{ utterance: "quiero hablar con una persona", urgent: true }],
      },
    );
    expect(result.reasonCode).toBe("CUSTOMER_REQUESTS_HUMAN");
    expect(result.announcesSuccess).toBe(false);
    const { pilot } = emitter.all();
    expect(pilot.some((e) => e.eventName === "STAFF_INTERRUPTION_RECORDED")).toBe(true);
    const reasonTurn = result.turns.find((t) => t.phraseKey === "REASON_CUSTOMER_REQUESTS_HUMAN");
    expect(reasonTurn?.params?.liveTransferRequested).toBe(true);
    // The phrase itself never claims completion — see phrasing/es.ts.
  });
});

describe("identityProof never upgrades a cancellation to a mutation", () => {
  it("even with identityProof: 'verified', CANCEL still only derives, never mutates", () => {
    const result = run({
      scenarioId: "A29-identity-proof-does-not-enable-mutation",
      callId: "call-identity-proof",
      turns: [
        {
          utterance: "quiero cancelar mi cita",
          reservationRef: "synthetic-reference",
          identityProof: "verified",
        },
      ],
    });
    expect(result.reasonCode).toBe("CANCEL_OR_CHANGE_NOT_ENABLED");
    expect(result.syntheticMutation).toBe(false);
    expect(result.externalMutation).toBe(false);
  });
});

describe("special services and business data never invent unapproved facts", () => {
  it("a special (out-of-catalogue) service request derives without inventing a duration or slot", () => {
    const result = run({
      scenarioId: "A30-special-service",
      callId: "call-special-service",
      turns: [{ utterance: "quiero hacerme mechas" }],
    });
    expect(result.reasonCode).toBe("BUSINESS_DATA_NOT_APPROVED");
    expect(result.syntheticMutation).toBe(false);
  });
});


// =====================================================================
// step 26 · B7 — UNA LLAMADA NUNCA ESCRIBE SOBRE UNA CITA LARGA
//
// Ésta es la razón por la que `engine.ts` no se ha tocado ni una línea para la
// duración flexible: `toSlots` sólo emite un inicio cuando el bloque de 30
// minutos cabe ENTERO dentro de un tramo libre, así que una cita manual de
// 10:15 a 12:30 borra de la rejilla de la voz los inicios 10:00, 10:30, 11:00,
// 11:30 y 12:00 sin que nadie le cuente nada al motor.
//
// OJO AL DETALLE QUE HACE QUE ESTA PRUEBA PUEDA FALLAR: `scenarioId` tiene que
// cumplir el patrón del contrato de eventos congelado (`A<nn>-…`). Con
// cualquier otro, `runConversation` colapsa en DERIVA/TECHNICAL_FAILURE sin
// escribir nada, y una prueba de «no escribe encima» pasaría siempre sin
// comprobar nada. Por eso cada caso afirma primero que el motor llegó a un
// veredicto de verdad.
//
// Lo que NO firma: nada de HTTP, nada de navegador y ninguna frase concreta
// que oiga quien llama.
// =====================================================================

describe("step 26 · B7 — la voz frente a una cita manual desalineada de 135 minutos", () => {
  const LUNES = "2026-08-03";
  const INICIO_LARGO = 10 * 60 + 15; // 10:15
  const FIN_LARGO = INICIO_LARGO + 135; // 12:30

  /** El calendario de la voz, con UNA cita manual larga ya escrita por el operador. */
  function calConCitaLarga(): CalendarWithCapabilities {
    const cal = baseSyntheticVenue();
    const resultado = createManualBooking(
      { cal, clock: fixedClock("2026-08-02", 9 * 60), manualBookings: [], nextManualNumber: 1 },
      {
        clientLabel: "Cliente A",
        serviceId: 1,
        date: LUNES,
        startMinutes: INICIO_LARGO,
        durationMinutes: 135,
        employeeId: ALEX_ID,
      },
    );
    expect(resultado.status, JSON.stringify(resultado.body)).toBe(201);
    return resultado.write?.nextCal as CalendarWithCapabilities;
  }

  it("los cinco inicios de la rejilla de 30 que la cita solapa desaparecen para la voz", () => {
    const cal = calConCitaLarga();
    for (const inicio of [10 * 60, 10 * 60 + 30, 11 * 60, 11 * 60 + 30, 12 * 60]) {
      expect(isSlotFree(cal, ALEX_ID, LUNES, inicio), String(inicio)).toBe(false);
    }
    // Y los de fuera siguen ahí: se ocupa un intervalo, no la mañana entera.
    expect(isSlotFree(cal, ALEX_ID, LUNES, 9 * 60 + 30)).toBe(true);
    expect(isSlotFree(cal, ALEX_ID, LUNES, 12 * 60 + 30)).toBe(true);
    // Para el resto del equipo no cambia nada.
    expect(isSlotFree(cal, DANI_ID, LUNES, 11 * 60)).toBe(true);
  });

  it("pedir por teléfono cualquiera de esos cinco tramos NO escribe dentro del intervalo", () => {
    const casos = [
      ["A80-tramo-1000", "10:00"],
      ["A81-tramo-1030", "10:30"],
      ["A82-tramo-1100", "11:00"],
      ["A83-tramo-1130", "11:30"],
      ["A84-tramo-1200", "12:00"],
    ] as const;
    for (const [scenarioId, time] of casos) {
      const resultado = run(
        {
          scenarioId,
          callId: `call-${scenarioId}`,
          turns: [
            {
              utterance: "quiero reservar una cita",
              day: "monday",
              time,
              professionalId: ALEX_ID,
              serviceId: 1,
              serviceConfirmed: true,
              bookingConfirmed: true,
            },
          ],
        },
        { cal: calConCitaLarga() },
      );
      // El motor llegó a un veredicto de verdad: sin esto, lo de abajo sería
      // una aserción que no puede fallar.
      expect(resultado.reasonCode, time).not.toBe("TECHNICAL_FAILURE");
      const escrita = resultado.reservation;
      if (escrita !== undefined) {
        const pisa =
          escrita.employeeId === ALEX_ID &&
          escrita.date === LUNES &&
          escrita.startMinutes < FIN_LARGO &&
          INICIO_LARGO < escrita.endMinutes;
        expect(pisa, `${time} escribió ${JSON.stringify(escrita)}`).toBe(false);
      }
      expect(resultado.externalMutation, time).toBe(false);
    }
  });

  it("el hueco de las 12:30, que empieza justo al acabar la cita larga, SÍ se reserva por teléfono", () => {
    const resultado = run(
      {
        scenarioId: "A85-borde-derecho",
        callId: "call-A85",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "monday",
            time: "12:30",
            professionalId: ALEX_ID,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
      { cal: calConCitaLarga() },
    );
    expect(resultado.reasonCode).toBe("BOOKING_CONFIRMED");
    expect(resultado.reservation?.startMinutes).toBe(12 * 60 + 30);
    expect(resultado.reservation?.employeeId).toBe(ALEX_ID);
    expect(resultado.reservation?.date).toBe(LUNES);
  });

  it("y las 10:00 con la cita larga puesta ya NO se pueden reservar, aunque sin ella sí", () => {
    // El contraste que hace honesta a la prueba anterior: mismo guion, mismo
    // motor, misma hora; lo único que cambia es que exista la cita de 135
    // minutos, y el resultado se da la vuelta.
    const guion = {
      scenarioId: "A86-contraste-1000",
      callId: "call-A86",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "monday",
          time: "10:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    } as const;
    const sinLaCita = run({ ...guion, scenarioId: "A87-contraste-1000-libre", callId: "call-A87" });
    expect(sinLaCita.reasonCode).toBe("BOOKING_CONFIRMED");
    expect(sinLaCita.reservation?.startMinutes).toBe(10 * 60);

    const conLaCita = run(guion, { cal: calConCitaLarga() });
    // El motor sigue ayudando a quien llama —ofrece y usa una alternativa—,
    // pero YA NO puede ser ese lunes a las 10:00: ese tramo es de la cita
    // manual. La alternativa que elige es otro día, no un trozo de la cita.
    expect(conLaCita.reservation).toBeDefined();
    const enElTramoDisputado =
      conLaCita.reservation?.date === LUNES && conLaCita.reservation?.startMinutes === 10 * 60;
    expect(enElTramoDisputado).toBe(false);
    expect(conLaCita.reservation?.date).not.toBe(sinLaCita.reservation?.date);
  });
});
