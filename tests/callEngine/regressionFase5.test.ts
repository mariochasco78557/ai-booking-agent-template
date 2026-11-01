import { describe, it, expect } from "vitest";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import { baseSyntheticVenue, ALEX_ID, DANI_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { runConversation, type ConversationScript, type ConversationResult } from "../../src/callEngine/engine.js";
import { createCallEventEmitter, type CallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore, type MemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { canTransition, type EngineState } from "../../src/callEngine/stateMachine.js";
import { ES } from "../../src/callEngine/phrasing/es.js";

/**
 * step 13 correction report — regression tests, one `describe` block per
 * demonstrated finding (B1, B2, B3, B4) and per actionable "aviso" the
 * independent Opus reviewer also required fixed (A1, A4, A5, A6). Every
 * test below reproduces the reviewer's own repro input where one was given
 * verbatim in the mission brief, and asserts the CORRECTED behaviour. Each
 * of these tests FAILS against the pre-correction code (commit 271ea8e on
 * mission/demo-salon-call-engine-demo).
 */

function makeDeps(overrides: {
  cal?: CalendarWithCapabilities;
  emitter?: CallEventEmitter;
  store?: MemoryStore;
  liveTransferAvailable?: boolean;
} = {}) {
  return {
    cal: overrides.cal ?? baseSyntheticVenue(),
    clock: fixedClock("2026-08-02", 9 * 60), // Sunday; "monday" -> 2026-08-03, "tuesday" -> 2026-08-04
    emitter: overrides.emitter ?? createCallEventEmitter(),
    store: overrides.store ?? createMemoryStore(),
    salt: "regression-fase5-salt",
    ...(overrides.liveTransferAvailable !== undefined ? { liveTransferAvailable: overrides.liveTransferAvailable } : {}),
  };
}

function run(script: ConversationScript, overrides?: Parameters<typeof makeDeps>[0]): ConversationResult {
  return runConversation(makeDeps(overrides), script);
}

// ---------------------------------------------------------------------
// B1 — the security/human short circuit used to be evaluated only at
// turn 0; flags accumulated by `mergeTurn` on later turns were never
// re-read, and later utterances were never reclassified.
// ---------------------------------------------------------------------
describe("B1: security/privacy and human-request boundaries must be re-checked on every turn, not just turn 0", () => {
  it("attemptsThirdPartyAccess revealed only on turn 2 (after day/time/professional are already known) still yields RECHAZA/SECURITY_OR_PRIVACY_BOUNDARY, and never books", () => {
    const result = run({
      scenarioId: "A28-b1-third-party-mid-call",
      callId: "call-b1-third-party",
      turns: [
        { utterance: "quiero reservar una cita", day: "monday", time: "10:00", professionalId: ALEX_ID },
        { serviceId: 1, serviceConfirmed: true, attemptsThirdPartyAccess: true },
        { bookingConfirmed: true },
      ],
    });
    expect(result.outcome).toBe("RECHAZA");
    expect(result.reasonCode).toBe("SECURITY_OR_PRIVACY_BOUNDARY");
    expect(result.announcesSuccess).toBe(false);
    expect(result.syntheticMutation).toBe(false);
    expect(result.reservation).toBeUndefined();
  });

  it("explicitlyRequestsHuman revealed only on turn 2 still yields DERIVA/CUSTOMER_REQUESTS_HUMAN, and never books", () => {
    const result = run({
      scenarioId: "A29-b1-human-mid-call",
      callId: "call-b1-human",
      turns: [
        { utterance: "quiero reservar una cita", day: "monday", time: "10:00", professionalId: ALEX_ID },
        { serviceId: 1, serviceConfirmed: true, explicitlyRequestsHuman: true },
        { bookingConfirmed: true },
      ],
    });
    expect(result.outcome).toBe("DERIVA");
    expect(result.reasonCode).toBe("CUSTOMER_REQUESTS_HUMAN");
    expect(result.announcesSuccess).toBe(false);
    expect(result.syntheticMutation).toBe(false);
    expect(result.reservation).toBeUndefined();
  });

  it('an utterance revealing third-party access mid-call ("en realidad es la cita de mi hermano") is reclassified and still yields RECHAZA, never books', () => {
    const result = run({
      scenarioId: "A30-b1-utterance-mid-call",
      callId: "call-b1-utterance",
      turns: [
        { utterance: "quiero reservar una cita", day: "monday", time: "10:00", professionalId: ALEX_ID, serviceId: 1 },
        // serviceConfirmed is left unset, so this becomes the retry turn at
        // the CONFIRMACION_DE_SERVICIO gate — where the boundary is only
        // revealed once the caller actually answers.
        { utterance: "en realidad es la cita de mi hermano" },
      ],
    });
    expect(result.outcome).toBe("RECHAZA");
    expect(result.reasonCode).toBe("SECURITY_OR_PRIVACY_BOUNDARY");
    expect(result.syntheticMutation).toBe(false);
    expect(result.reservation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// B2 — nothing compared the requested slot's start time against "now";
// only the whole-day horizon was checked.
// ---------------------------------------------------------------------
describe("B2: a slot on today, earlier than now (+ minimum lead time), must never be booked", () => {
  it("requesting 09:00 today at 16:00 (the reviewer's exact repro) is refused, not booked", () => {
    const clock = fixedClock("2026-08-03", 16 * 60); // Monday, 16:00
    const result = runConversation(
      { cal: baseSyntheticVenue(), clock, emitter: createCallEventEmitter(), store: createMemoryStore(), salt: "b2-salt" },
      {
        scenarioId: "A31-b2-past-slot-today",
        callId: "call-b2-past",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "monday",
            time: "09:00",
            professionalId: ALEX_ID,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    );
    expect(result.reasonCode).not.toBe("BOOKING_CONFIRMED");
    expect(result.reasonCode).toBe("SLOT_OUTSIDE_SYNTHETIC_SCHEDULE");
    expect(result.outcome).toBe("DERIVA");
    expect(result.announcesSuccess).toBe(false);
    expect(result.syntheticMutation).toBe(false);
    expect(result.reservation).toBeUndefined();
  });

  it("the same repro with minimumLeadMinutes:120 is refused identically", () => {
    const clock = fixedClock("2026-08-03", 16 * 60);
    const cal: CalendarWithCapabilities = { ...baseSyntheticVenue(), minimumLeadMinutes: 120 };
    const result = runConversation(
      { cal, clock, emitter: createCallEventEmitter(), store: createMemoryStore(), salt: "b2-lead-salt" },
      {
        scenarioId: "A32-b2-past-slot-lead-time",
        callId: "call-b2-lead",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "monday",
            time: "09:00",
            professionalId: ALEX_ID,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    );
    expect(result.reasonCode).not.toBe("BOOKING_CONFIRMED");
    expect(result.reasonCode).toBe("SLOT_OUTSIDE_SYNTHETIC_SCHEDULE");
    expect(result.syntheticMutation).toBe(false);
  });
});

// ---------------------------------------------------------------------
// B3 — one reasonCode covered "occupied", "not capable" and "genuinely
// outside the schedule" alike, and the client-facing phrase asserted a
// cause it could not actually know was true; a valid alternative was
// discarded outright for BOOK.
// ---------------------------------------------------------------------
describe("B3: the exact-slot-unavailable phrase must never assert a false cause, the real cause must be recorded internally, and a valid alternative must be offered for BOOK too", () => {
  it("(b) the client-facing phrase for SLOT_OUTSIDE_SYNTHETIC_SCHEDULE never claims it is because of the schedule or the break", () => {
    const phrase = ES.REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE();
    expect(phrase).not.toMatch(/por estar fuera de/i);
    expect(phrase).not.toMatch(/por caer en la pausa/i);
    // Honesty rule 2 (phrasing/keys.ts): never claims the shop is
    // indefinitely full, either.
    expect(phrase.toLowerCase()).not.toContain("lleno");
  });

  it("(c) an occupied-but-otherwise-valid slot with NO reliable alternative anywhere records the REAL cause ('occupied') internally, without asserting it to the caller", () => {
    const clock = fixedClock("2026-08-02", 9 * 60);
    const store = createMemoryStore();
    const emitter = createCallEventEmitter();
    let cal = baseSyntheticVenue();

    function book(scenarioId: string, callId: string, professionalId: number, day: "monday" | "tuesday") {
      const result = runConversation(
        { cal, clock, emitter, store, salt: "b3-occupied-salt" },
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
      cal = { ...baseSyntheticVenue(), reservations: store.snapshot().reservations };
    }

    book("A33-b3-occupy-alex-monday", "call-b3-occupy-1", ALEX_ID, "monday");
    book("A34-b3-occupy-alex-tuesday", "call-b3-occupy-2", ALEX_ID, "tuesday");
    book("A35-b3-occupy-dani-monday", "call-b3-occupy-3", DANI_ID, "monday");

    const result = runConversation(
      { cal, clock, emitter, store, salt: "b3-occupied-salt" },
      {
        scenarioId: "A36-b3-repeat-occupied-slot",
        callId: "call-b3-repeat",
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
    expect(result.reasonCode).toBe("SLOT_OUTSIDE_SYNTHETIC_SCHEDULE");
    expect(result.syntheticMutation).toBe(false);

    const rejection = emitter
      .all()
      .internal.find((e) => e.eventName === "SLOT_REJECTED" && (e.detail as { cause?: string } | undefined)?.cause === "occupied");
    expect(rejection).toBeDefined();

    // The client-facing pilot stream (frozen schema) never carries `cause`
    // at all — it isn't one of pilot-event.schema.json's declared fields.
    const outcomeEvent = emitter.all().pilot.find((e) => e.eventName === "OUTCOME_EMITTED");
    expect(outcomeEvent).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(outcomeEvent as object, "cause")).toBe(false);
  });

  it("(c) a professional incapable of the requested service (nobody capable at all) records 'not_capable', distinct from 'occupied'", () => {
    const employeeId = 101;
    const soloBarberCal: CalendarWithCapabilities = {
      professionals: [{ employeeId, displayName: "Solo Corte (sintético)", synthetic: true }],
      weeklySchedules: [{ ownerKind: "employee", employeeId, dayOfWeek: 1, workDayStart: "09:00", workDayEnd: "17:00" }],
      closures: [],
      venueRules: [],
      absences: [],
      overrides: [],
      reservations: [],
      slotMinutes: 30,
      bookingHorizonDays: 90,
      minimumLeadMinutes: 0,
      capabilities: new Map([[employeeId, new Set([1])]]), // capable of service 1 only, NOT service 0
    };
    const emitter = createCallEventEmitter();
    const result = runConversation(
      { cal: soloBarberCal, clock: fixedClock("2026-08-02", 9 * 60), emitter, store: createMemoryStore(), salt: "b3-not-capable-salt" },
      {
        scenarioId: "A37-b3-not-capable",
        callId: "call-b3-not-capable",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "monday",
            time: "10:00",
            professionalId: "any",
            serviceId: 0,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    );
    expect(result.reasonCode).toBe("SLOT_OUTSIDE_SYNTHETIC_SCHEDULE");
    const rejection = emitter
      .all()
      .internal.find((e) => e.eventName === "SLOT_REJECTED" && (e.detail as { cause?: string } | undefined)?.cause === "not_capable");
    expect(rejection).toBeDefined();
  });

  it("(d) a BOOK request for an occupied exact slot, with a reliable alternative available, now books the alternative instead of being discarded", () => {
    const clock = fixedClock("2026-08-02", 9 * 60);
    const store = createMemoryStore();
    const emitter = createCallEventEmitter();
    const occupy = runConversation(
      { cal: baseSyntheticVenue(), clock, emitter, store, salt: "b3-alt-salt" },
      {
        scenarioId: "A38-b3-occupy-for-alternative",
        callId: "call-b3-occupy-alt",
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
    expect(occupy.reasonCode).toBe("BOOKING_CONFIRMED");
    const calAfterOccupy = { ...baseSyntheticVenue(), reservations: store.snapshot().reservations };

    const result = runConversation(
      { cal: calAfterOccupy, clock, emitter, store, salt: "b3-alt-salt" },
      {
        scenarioId: "A39-b3-book-with-alternative",
        callId: "call-b3-book-alt",
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
    // Under the pre-correction code this discarded the alternative
    // (`intent === "AVAILABILITY"` was required) and resolved to
    // SLOT_OUTSIDE_SYNTHETIC_SCHEDULE instead.
    expect(result.reasonCode).toBe("BOOKING_CONFIRMED");
    expect(result.outcome).toBe("RESUELVE");
    expect(result.announcesSuccess).toBe(true);
    expect(result.reservation).toBeDefined();
    expect(result.reservation?.date).not.toBe("2026-08-03"); // not the occupied Monday
    expect(result.reservation?.employeeId).toBe(ALEX_ID);
    const offered = result.turns.some((t) => t.phraseKey === "OFFER_ALTERNATIVES");
    expect(offered).toBe(true);
  });
});

// ---------------------------------------------------------------------
// B4 — `finalize()` used to run from both the `try` and the `catch`,
// using the non-validating `applyTransition`.
// ---------------------------------------------------------------------
function makeThrowsOnceOnOutcomeEmitter(): CallEventEmitter {
  const real = createCallEventEmitter();
  let thrown = false;
  return {
    emitPilotEvent(input) {
      if (input.eventName === "OUTCOME_EMITTED" && !thrown) {
        thrown = true;
        throw new Error("B4 regression fixture: synthetic emitter failure on first OUTCOME_EMITTED");
      }
      return real.emitPilotEvent(input);
    },
    emitInternalEvent(input) {
      return real.emitInternalEvent(input);
    },
    all() {
      return real.all();
    },
    reset() {
      real.reset();
    },
  };
}

describe("B4: finalize() must never run twice, and must validate its own transitions", () => {
  it("an emitter that throws once on OUTCOME_EMITTED never produces two contradictory terminal phrases, never forces an undeclared transition, and never reports TECHNICAL_FAILURE with announcesSuccess:true", () => {
    const emitter = makeThrowsOnceOnOutcomeEmitter();
    const store = createMemoryStore();
    const result = runConversation(
      { cal: baseSyntheticVenue(), clock: fixedClock("2026-08-02", 9 * 60), emitter, store, salt: "b4-salt" },
      {
        scenarioId: "A40-b4-double-finalize",
        callId: "call-b4",
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

    // Never two (or more) contradictory terminal reason phrases.
    const reasonPhrases = result.turns.filter((t) => t.phraseKey.startsWith("REASON_"));
    expect(reasonPhrases.length).toBeLessThanOrEqual(1);

    // Never the dangerous combination the reviewer's repro produced.
    expect(result.reasonCode === "TECHNICAL_FAILURE" && result.announcesSuccess === true).toBe(false);

    // Every recorded state-to-state move (if any survived) must be a
    // declared, legal transition — no `EMITIR_RESUELVE -> EMITIR_DERIVA`.
    const trace = result.stateTrace as readonly EngineState[];
    for (let i = 1; i < trace.length; i += 1) {
      expect(canTransition(trace[i - 1] as EngineState, trace[i] as EngineState)).toBe(true);
    }

    // `finalize()` (and therefore its single OUTCOME_EMITTED attempt) must
    // have run AT MOST once: with the pre-correction double-finalize bug,
    // the SECOND finalize() call's OUTCOME_EMITTED succeeds (the fixture
    // only throws once), so this would be 1 under the bug and 0 once fixed
    // (the single attempt is the one that throws, and is never retried).
    const outcomeEmittedCount = emitter.all().pilot.filter((e) => e.eventName === "OUTCOME_EMITTED").length;
    expect(outcomeEmittedCount).toBe(0);

    expect(result.outcome).toBe("DERIVA");
    expect(result.reasonCode).toBe("TECHNICAL_FAILURE");
    expect(result.announcesSuccess).toBe(false);
  });
});

// ---------------------------------------------------------------------
// A1 — CALL_STARTED/recordCallStarted used to run outside every
// try/catch; an invalid scenarioId threw an uncaught ZodError.
// ---------------------------------------------------------------------
describe('A1: an invalid scenarioId ("demo-1") fails closed instead of throwing an uncaught error', () => {
  it("never throws, and returns a safe DERIVA/TECHNICAL_FAILURE result", () => {
    let result: ConversationResult | undefined;
    expect(() => {
      result = runConversation(
        { cal: baseSyntheticVenue(), clock: fixedClock("2026-08-02", 9 * 60), emitter: createCallEventEmitter(), store: createMemoryStore(), salt: "a1-salt" },
        { scenarioId: "demo-1", callId: "call-a1", turns: [{ utterance: "quiero reservar una cita" }] },
      );
    }).not.toThrow();
    expect(result?.outcome).toBe("DERIVA");
    expect(result?.reasonCode).toBe("TECHNICAL_FAILURE");
    expect(result?.announcesSuccess).toBe(false);
    expect(result?.externalMutation).toBe(false);
  });
});

// ---------------------------------------------------------------------
// A4 — injectFailure was only honoured on the BOOK write path.
// ---------------------------------------------------------------------
describe("A4: injectFailure must be honoured for AVAILABILITY too, not only for BOOK's write path", () => {
  it("an AVAILABILITY scenario with injectFailure:true yields DERIVA/TECHNICAL_FAILURE, never RESUELVE/AVAILABILITY_PROVIDED", () => {
    const result = run({
      scenarioId: "A41-a4-availability-injected-failure",
      callId: "call-a4",
      turns: [
        {
          utterance: "quiero consultar disponibilidad",
          day: "monday",
          time: "10:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          injectFailure: true,
        },
      ],
    });
    expect(result.reasonCode).toBe("TECHNICAL_FAILURE");
    expect(result.outcome).toBe("DERIVA");
    expect(result.announcesSuccess).toBe(false);
  });
});

// ---------------------------------------------------------------------
// A5 — `urgent: true` alone never escalated.
// ---------------------------------------------------------------------
describe("A5: urgent alone must activate the human cascade", () => {
  it("urgent:true on a BOOK-intent turn, with no explicit human request and no HUMAN_HELP utterance, still yields DERIVA/CUSTOMER_REQUESTS_HUMAN with a live transfer requested", () => {
    const emitter = createCallEventEmitter();
    const result = runConversation(
      { cal: baseSyntheticVenue(), clock: fixedClock("2026-08-02", 9 * 60), emitter, store: createMemoryStore(), salt: "a5-salt", liveTransferAvailable: true },
      { scenarioId: "A42-a5-urgent-alone", callId: "call-a5", turns: [{ utterance: "quiero reservar una cita", urgent: true }] },
    );
    expect(result.reasonCode).toBe("CUSTOMER_REQUESTS_HUMAN");
    expect(result.outcome).toBe("DERIVA");
    expect(result.syntheticMutation).toBe(false);
    const { pilot } = emitter.all();
    expect(pilot.some((e) => e.eventName === "STAFF_INTERRUPTION_RECORDED")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// A6 — a caught error's free-text message was forwarded verbatim into an
// internal event's `detail`; assertNoPersonalData only scans keys.
// ---------------------------------------------------------------------
describe("A6: a caught error's message must never be forwarded verbatim into an internal event", () => {
  it("an error whose message contains phone/name-like content never appears in any emitted event; a stable error label is used instead", () => {
    const leak = "boom telefono 612345678 nombre Juan Perez";
    const realStore = createMemoryStore();
    const store: MemoryStore = {
      ...realStore,
      addReservation() {
        throw new Error(leak);
      },
    };
    const emitter = createCallEventEmitter();
    const result = runConversation(
      { cal: baseSyntheticVenue(), clock: fixedClock("2026-08-02", 9 * 60), emitter, store, salt: "a6-salt" },
      {
        scenarioId: "A43-a6-error-message-redaction",
        callId: "call-a6",
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
    expect(result.reasonCode).toBe("TECHNICAL_FAILURE");
    expect(result.syntheticMutation).toBe(false);

    const { pilot, internal } = emitter.all();
    const allEventsJSON = [...pilot, ...internal].map((e) => JSON.stringify(e));
    expect(allEventsJSON.some((json) => json.includes("612345678"))).toBe(false);
    expect(allEventsJSON.some((json) => json.includes("Juan"))).toBe(false);
    expect(allEventsJSON.some((json) => json.includes("telefono"))).toBe(false);

    const errorRaised = internal.find((e) => e.eventName === "ERROR_RAISED");
    expect(errorRaised).toBeDefined();
    expect((errorRaised?.detail as { errorLabel?: string } | undefined)?.errorLabel).toBe("UNEXPECTED_ENGINE_ERROR");

    // The store's own error log must not carry the raw message either.
    expect(store.snapshot().errors.some((e) => e.message.includes("612345678"))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Reverificación de la fase 5: tres pegas que el revisor dejó como avisos
// tras confirmar que los cuatro bloqueantes estaban corregidos.
// ---------------------------------------------------------------------

describe("Deriva de intención: una respuesta de relleno no puede reescribir la intención de la llamada", () => {
  it("una reserva correcta sigue reportando intent BOOK aunque el cliente conteste con frases sueltas", () => {
    const emitter = createCallEventEmitter();
    const store = createMemoryStore();
    const result = runConversation(
      {
        cal: baseSyntheticVenue(),
        clock: fixedClock("2026-08-02", 9 * 60),
        emitter,
        store,
        salt: "intent-drift-salt",
      },
      {
        scenarioId: "A41-intent-drift",
        callId: "call-intent-drift",
        turns: [
          { utterance: "quiero reservar una cita", day: "monday", time: "10:00", professionalId: ALEX_ID },
          { utterance: "pues el número uno por favor", serviceId: 1, serviceConfirmed: true },
          { utterance: "sí, adelante", bookingConfirmed: true },
        ],
      },
    );

    expect(result.reasonCode).toBe("BOOKING_CONFIRMED");
    // PILOT_METRICS.md segments calls by this field. Before the fix it read
    // "OTHER", so successful bookings were attributed to an intent the
    // customer never had.
    const outcomeEvent = emitter.all().pilot.find((e) => e.eventName === "OUTCOME_EMITTED");
    expect(outcomeEvent?.intent).toBe("BOOK");
  });

  it("pero una reclasificación que SÍ cortocircuita sí pasa a ser la intención de la llamada", () => {
    const emitter = createCallEventEmitter();
    const store = createMemoryStore();
    const result = runConversation(
      {
        cal: baseSyntheticVenue(),
        clock: fixedClock("2026-08-02", 9 * 60),
        emitter,
        store,
        salt: "intent-shift-salt",
      },
      {
        scenarioId: "A42-intent-shift",
        callId: "call-intent-shift",
        turns: [
          { utterance: "quiero reservar una cita", day: "monday", time: "10:00", professionalId: ALEX_ID },
          { utterance: "mejor prefiero hablar con una persona" },
        ],
      },
    );

    expect(result.reasonCode).toBe("CUSTOMER_REQUESTS_HUMAN");
    const outcomeEvent = emitter.all().pilot.find((e) => e.eventName === "OUTCOME_EMITTED");
    expect(outcomeEvent?.intent).toBe("HUMAN_HELP");
  });
});

describe("Reserva sintética huérfana en la ruta de último recurso", () => {
  it("no se borra en silencio: se deja en su sitio, se declara la mutación y se marca para revisión humana", () => {
    const emitter = makeThrowsOnceOnOutcomeEmitter();
    const store = createMemoryStore();
    const result = runConversation(
      { cal: baseSyntheticVenue(), clock: fixedClock("2026-08-02", 9 * 60), emitter, store, salt: "orphan-salt" },
      {
        scenarioId: "A43-orphan-reservation",
        callId: "call-orphan",
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

    const snapshot = store.snapshot();
    expect(snapshot.reservations.length).toBe(1);
    // Reported truthfully rather than hidden: a booking that can vanish
    // without trace is worse than one that needs review.
    expect(result.syntheticMutation).toBe(true);
    expect(result.requiresOperatorReview).toBe(true);
    expect(result.announcesSuccess).toBe(false);
    // And an operator can actually find it.
    expect(
      snapshot.humanTasks.some((t) => t.reason === "REVIEW_ORPHANED_SYNTHETIC_RESERVATION"),
    ).toBe(true);
  });

  it("una llamada que colapsa SIN haber escrito nada no inventa una revisión pendiente", () => {
    const emitter = makeThrowsOnceOnOutcomeEmitter();
    const store = createMemoryStore();
    const result = runConversation(
      { cal: baseSyntheticVenue(), clock: fixedClock("2026-08-02", 9 * 60), emitter, store, salt: "no-orphan-salt" },
      {
        scenarioId: "A44-no-orphan",
        callId: "call-no-orphan",
        turns: [{ utterance: "quiero saber qué huecos hay el lunes", day: "monday" }],
      },
    );

    expect(store.snapshot().reservations.length).toBe(0);
    expect(result.syntheticMutation).toBe(false);
    expect(result.requiresOperatorReview).toBeFalsy();
    expect(store.snapshot().humanTasks.some((t) => t.reason === "REVIEW_ORPHANED_SYNTHETIC_RESERVATION")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Hallazgos de la auditoría de seguridad de la fase 9.
// ---------------------------------------------------------------------
describe("Auditoría fase 9: un fallo técnico nunca puede quedar sin rastro", () => {
  it("el catch de último recurso registra el error, para que un operador pueda distinguirlo de uno real", () => {
    const emitter = makeThrowsOnceOnOutcomeEmitter();
    const store = createMemoryStore();
    const result = runConversation(
      { cal: baseSyntheticVenue(), clock: fixedClock("2026-08-02", 9 * 60), emitter, store, salt: "audit-salt" },
      {
        scenarioId: "A45-sin-rastro",
        callId: "call-sin-rastro",
        turns: [{ utterance: "quiero saber qué huecos hay el lunes", day: "monday" }],
      },
    );

    expect(result.reasonCode).toBe("TECHNICAL_FAILURE");
    // Antes de la corrección esto era una lista vacía: el fallo se devolvía
    // pero no quedaba constancia de él en ninguna parte.
    const errors = store.snapshot().errors;
    expect(errors.length).toBeGreaterThan(0);
    // Y sigue sin reenviar el texto libre de la excepción.
    expect(errors.every((e) => e.message === "UNEXPECTED_ENGINE_ERROR")).toBe(true);
  });
});

describe("Auditoría fase 9: la lista negra de datos personales también mira los valores", () => {
  it("un teléfono internacional escondido en un valor libre hace fallar la emisión", () => {
    const emitter = createCallEventEmitter();
    expect(() =>
      emitter.emitInternalEvent({
        scenarioId: "A46-valor-telefono",
        callId: "call-valor",
        salt: "s",
        clock: fixedClock("2026-08-02", 9 * 60),
        eventName: "ERROR_RAISED",
        detail: { note: "+34 600 123 456" },
      }),
    ).toThrow(/phone number/);
  });

  it("una dirección de correo escondida en un valor libre hace fallar la emisión", () => {
    const emitter = createCallEventEmitter();
    expect(() =>
      emitter.emitInternalEvent({
        scenarioId: "A47-valor-correo",
        callId: "call-valor",
        salt: "s",
        clock: fixedClock("2026-08-02", 9 * 60),
        eventName: "ERROR_RAISED",
        detail: { note: "alguien@ejemplo.es" },
      }),
    ).toThrow(/email address/);
  });

  it("pero un hash de sha256 de 64 caracteres sigue pasando sin problema", () => {
    const emitter = createCallEventEmitter();
    expect(() =>
      emitter.emitInternalEvent({
        scenarioId: "A48-hash-valido",
        callId: "call-valor",
        salt: "s",
        clock: fixedClock("2026-08-02", 9 * 60),
        eventName: "ERROR_RAISED",
        detail: { note: "a".repeat(8) + "1234567890123456789012345678901234567890123456789012345678" },
      }),
    ).not.toThrow();
  });
});
