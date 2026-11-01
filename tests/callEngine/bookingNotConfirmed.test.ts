import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { baseSyntheticVenue, ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { runConversation, type ConversationScript, type ConversationResult } from "../../src/callEngine/engine.js";
import { createCallEventEmitter, type CallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore, type MemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { PILOT_REASON_CODES, PilotEventSchema } from "../../src/callEngine/events/schema.js";
import { PRECEDENCE_ORDER } from "../../src/callEngine/precedence.js";
import {
  INTERNAL_REASON_CODES,
  OUTCOME_DIMENSIONS,
  toPilotV1ReasonCode,
  type InternalReasonCode,
} from "../../src/callEngine/outcomeDimension.js";

/**
 * step 14, tarea B — "la reserva no se confirmó del todo".
 *
 * El hueco: una llamada en la que la intención SÍ se entendió (BOOK), el
 * servicio SÍ se confirmó y el hueco SÍ era válido y estaba libre, pero el
 * cliente nunca dio el "sí" final. Caía en `INTENT_NOT_UNDERSTOOD` y
 * contaminaba la métrica de comprensión.
 *
 * La corrección: una dimensión de resultado INTERNA y versionable
 * (`InternalReasonCode`) sobre el contrato congelado de diez códigos, que NO
 * se toca. Este fichero fija por prueba (a) las cuatro semánticas exigidas,
 * (b) la compatibilidad externa v1 y (c) las regresiones que impiden que la
 * dimensión interna se filtre al flujo congelado.
 */

function makeDeps(): { cal: ReturnType<typeof baseSyntheticVenue>; clock: ReturnType<typeof fixedClock>; emitter: CallEventEmitter; store: MemoryStore; salt: string } {
  return {
    cal: baseSyntheticVenue(),
    clock: fixedClock("2026-08-02", 9 * 60),
    emitter: createCallEventEmitter(),
    store: createMemoryStore(),
    salt: "booking-not-confirmed-salt",
  };
}

function run(script: ConversationScript): {
  result: ConversationResult;
  emitter: CallEventEmitter;
  store: MemoryStore;
} {
  const deps = makeDeps();
  const result = runConversation(deps, script);
  return { result, emitter: deps.emitter, store: deps.store };
}

/**
 * El guion canónico del hueco: todo entendido y confirmado salvo el sí final.
 * El guion se agota justo después de `ASK_BOOKING_CONFIRMATION`, que es
 * exactamente "el cliente no llegó a confirmar".
 */
const UNDERSTOOD_BUT_NEVER_CONFIRMED: ConversationScript = {
  scenarioId: "A20-booking-not-confirmed",
  callId: "call-booking-not-confirmed",
  turns: [
    {
      utterance: "quiero reservar una cita",
      serviceId: 1,
      day: "monday",
      time: "10:00",
      professionalId: ALEX_ID,
      serviceConfirmed: true,
    },
  ],
};

// ---------------------------------------------------------------------
// (1) La tabla de dimensiones — cerrada, exhaustiva y sin sorpresas.
// ---------------------------------------------------------------------

describe("OUTCOME_DIMENSIONS: la dimensión interna de resultado", () => {
  it("cubre los diez códigos congelados más exactamente una refinación interna", () => {
    expect(INTERNAL_REASON_CODES.length).toBe(PRECEDENCE_ORDER.length + 1);
    for (const frozen of PRECEDENCE_ORDER) {
      expect(INTERNAL_REASON_CODES).toContain(frozen);
    }
    const extra = INTERNAL_REASON_CODES.filter((c) => !(PRECEDENCE_ORDER as readonly string[]).includes(c));
    expect(extra).toEqual(["BOOKING_NOT_CONFIRMED"]);
  });

  it("tiene una entrada por cada código, sin huecos", () => {
    for (const code of INTERNAL_REASON_CODES) {
      expect(OUTCOME_DIMENSIONS[code]).toBeDefined();
    }
    expect(Object.keys(OUTCOME_DIMENSIONS).sort()).toEqual([...INTERNAL_REASON_CODES].sort());
  });

  it("mapea todo código interno a un reasonCode que el contrato congelado v1 admite", () => {
    for (const code of INTERNAL_REASON_CODES) {
      expect(PILOT_REASON_CODES).toContain(toPilotV1ReasonCode(code));
    }
  });

  it("los diez códigos congelados se mapean a sí mismos (identidad): nada externo cambia", () => {
    for (const frozen of PRECEDENCE_ORDER) {
      expect(toPilotV1ReasonCode(frozen)).toBe(frozen);
    }
  });

  it("solo INTENT_NOT_UNDERSTOOD alimenta la métrica de no-comprensión", () => {
    const feeding = INTERNAL_REASON_CODES.filter((c) => OUTCOME_DIMENSIONS[c].countsAsNotUnderstood);
    expect(feeding).toEqual(["INTENT_NOT_UNDERSTOOD"]);
  });

  it("solo BOOKING_CONFIRMED cuenta como conversión de reserva", () => {
    const converting = INTERNAL_REASON_CODES.filter((c) => OUTCOME_DIMENSIONS[c].countsAsBookingConversion);
    expect(converting).toEqual(["BOOKING_CONFIRMED"]);
  });

  it("solo los dos resultados RESUELVE cuentan como contención", () => {
    const contained = INTERNAL_REASON_CODES.filter((c) => OUTCOME_DIMENSIONS[c].countsAsContained);
    expect([...contained].sort()).toEqual(["AVAILABILITY_PROVIDED", "BOOKING_CONFIRMED"]);
  });

  it("BOOKING_NOT_CONFIRMED: entendido, sin conversión y NO contenido", () => {
    const d = OUTCOME_DIMENSIONS.BOOKING_NOT_CONFIRMED;
    // Es el motivo entero de que este código exista.
    expect(d.countsAsNotUnderstood).toBe(false);
    // No se reservó nada.
    expect(d.countsAsBookingConversion).toBe(false);
    // Decisión deliberada y NO complaciente: la llamada acabó sin reserva y
    // sin persona, pero la necesidad del cliente sigue sin resolver, así que
    // el trabajo se aplazó, no se absorbió. Ver el razonamiento completo en
    // outcomeDimension.ts y en (internal doc, not included in the template).
    expect(d.countsAsContained).toBe(false);
    // Lo que el consumidor externo v1 ve.
    expect(d.pilotV1ReasonCode).toBe("INTENT_NOT_UNDERSTOOD");
  });

  it("ningún código interno es a la vez no-entendido y contenido, ni contado como conversión sin contención", () => {
    for (const code of INTERNAL_REASON_CODES) {
      const d = OUTCOME_DIMENSIONS[code];
      expect(d.countsAsNotUnderstood && d.countsAsContained).toBe(false);
      if (d.countsAsBookingConversion) expect(d.countsAsContained).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------
// (2) Aceptación del motor sobre el caso real.
// ---------------------------------------------------------------------

describe("aceptación: entendido pero sin confirmación final de reserva", () => {
  it("resuelve internamente como BOOKING_NOT_CONFIRMED y externamente como INTENT_NOT_UNDERSTOOD/DERIVA", () => {
    const { result } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    expect(result.internalReasonCode).toBe("BOOKING_NOT_CONFIRMED");
    expect(result.reasonCode).toBe("INTENT_NOT_UNDERSTOOD");
    expect(result.outcome).toBe("DERIVA");
  });

  it("llegó de verdad a la puerta de confirmación: todo lo anterior SÍ se entendió", () => {
    const { result } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    const keys = result.turns.map((t) => t.phraseKey);
    expect(keys).toContain("ASK_BOOKING_CONFIRMATION");
    // La puerta de servicio quedó atrás superada: no se resolvió como
    // SERVICE_NOT_CONFIRMED, que describe un caso distinto.
    expect(result.reasonCode).not.toBe("SERVICE_NOT_CONFIRMED");
    expect(result.effectiveServiceId).toBe(1);
  });

  it("NUNCA muta una reserva: ni externa, ni sintética, ni en el store", () => {
    const { result, store } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    expect(result.externalMutation).toBe(false);
    expect(result.syntheticMutation).toBe(false);
    expect(result.reservation).toBeUndefined();
    const before = baseSyntheticVenue().reservations.length;
    expect(store.snapshot().reservations.length).toBe(before);
    expect(store.snapshot().reservations.some((r) => r.callIdHash !== undefined && r.status === "confirmed" && r.serviceId === 1 && r.date === "2026-08-03")).toBe(false);
  });

  it("NUNCA anuncia éxito, ni en el resultado, ni en el evento, ni en lo que se dice", () => {
    const { result, emitter } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    expect(result.announcesSuccess).toBe(false);
    const keys = result.turns.map((t) => t.phraseKey);
    expect(keys).not.toContain("REASON_BOOKING_CONFIRMED");
    // Y dice la frase honesta, no la falsa "no te he entendido".
    expect(keys).toContain("REASON_BOOKING_CONFIRMATION_NOT_OBTAINED");
    expect(keys).not.toContain("REASON_INTENT_NOT_UNDERSTOOD");
    const outcomeEvents = emitter.all().pilot.filter((e) => e.eventName === "OUTCOME_EMITTED");
    expect(outcomeEvents.length).toBe(1);
    expect(outcomeEvents[0]?.announcesSuccess).toBe(false);
  });

  it("NO alimenta la métrica de no-comprensión y NO cuenta como conversión ni como contención", () => {
    const { result } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    const d = OUTCOME_DIMENSIONS[result.internalReasonCode];
    expect(d.countsAsNotUnderstood).toBe(false);
    expect(d.countsAsBookingConversion).toBe(false);
    expect(d.countsAsContained).toBe(false);
  });

  it("no pide ayuda humana ni crea cola: la llamada no interrumpió a nadie", () => {
    const { emitter, store } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    const pilot = emitter.all().pilot;
    // Este hecho SÍ es cierto y se registra donde corresponde (métrica de
    // interrupciones), no inflando la contención.
    expect(pilot.filter((e) => e.eventName === "STAFF_INTERRUPTION_RECORDED").length).toBe(0);
    expect(pilot.filter((e) => e.eventName === "CALLBACK_REQUESTED").length).toBe(0);
    expect(store.snapshot().humanTasks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------
// (3) Compatibilidad con el contrato externo v1 CONGELADO.
// ---------------------------------------------------------------------

describe("compatibilidad externa v1: el contrato congelado no se toca", () => {
  const frozenSchema = JSON.parse(
    readFileSync(join(process.cwd(), "docs/call_interruption_mvp/pilot-event.schema.json"), "utf8"),
  ) as { properties: { reasonCode: { enum: string[] } } };

  it("BOOKING_NOT_CONFIRMED no existe en el esquema congelado y nunca debe existir en él", () => {
    expect(frozenSchema.properties.reasonCode.enum).not.toContain("BOOKING_NOT_CONFIRMED");
    expect(PILOT_REASON_CODES as readonly string[]).not.toContain("BOOKING_NOT_CONFIRMED");
    expect(frozenSchema.properties.reasonCode.enum.length).toBe(10);
  });

  it("un consumidor v1 ve INTENT_NOT_UNDERSTOOD/DERIVA, exactamente lo que veía antes", () => {
    const { emitter } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    const outcome = emitter.all().pilot.find((e) => e.eventName === "OUTCOME_EMITTED");
    expect(outcome).toBeDefined();
    expect(outcome?.reasonCode).toBe("INTENT_NOT_UNDERSTOOD");
    expect(outcome?.outcome).toBe("DERIVA");
    expect(outcome?.synthetic).toBe(true);
    expect(outcome?.schemaVersion).toBe("1.0.0");
  });

  it("todo evento piloto sigue validando contra el esquema congelado y su reasonCode está en el enum congelado", () => {
    const { emitter } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    for (const ev of emitter.all().pilot) {
      expect(() => PilotEventSchema.parse(ev)).not.toThrow();
      if (ev.reasonCode !== undefined) {
        expect(frozenSchema.properties.reasonCode.enum).toContain(ev.reasonCode);
      }
    }
  });

  it("la dimensión interna nunca se filtra al flujo piloto", () => {
    const { emitter } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    const serialized = JSON.stringify(emitter.all().pilot);
    expect(serialized).not.toContain("BOOKING_NOT_CONFIRMED");
    expect(serialized).not.toContain("internalReasonCode");
    expect(serialized).not.toContain("countsAsContained");
  });
});

// ---------------------------------------------------------------------
// (4) El flujo interno: un único registro por llamada, sin cruce manual.
// ---------------------------------------------------------------------

describe("flujo interno: INTERNAL_OUTCOME_RESOLVED", () => {
  it("emite exactamente uno por llamada, con la dimensión ya resuelta", () => {
    const { emitter } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    const resolved = emitter.all().internal.filter((e) => e.eventName === "INTERNAL_OUTCOME_RESOLVED");
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.detail).toEqual({
      internalReasonCode: "BOOKING_NOT_CONFIRMED",
      pilotV1ReasonCode: "INTENT_NOT_UNDERSTOOD",
      outcome: "DERIVA",
      announcesSuccess: false,
      countsAsNotUnderstood: false,
      countsAsBookingConversion: false,
      countsAsContained: false,
    });
  });

  it("convive con BOOKING_CONFIRMATION_NOT_OBTAINED, que marca el momento en que falló la puerta", () => {
    const { emitter } = run(UNDERSTOOD_BUT_NEVER_CONFIRMED);
    const names = emitter.all().internal.map((e) => e.eventName);
    expect(names).toContain("BOOKING_CONFIRMATION_NOT_OBTAINED");
    expect(names).toContain("INTERNAL_OUTCOME_RESOLVED");
  });

  it("se emite antes que OUTCOME_EMITTED, para que el flujo congelado nunca quede por delante del interno", () => {
    const deps = makeDeps();
    const order: string[] = [];
    const wrapped: CallEventEmitter = {
      emitPilotEvent(i) {
        order.push(`pilot:${i.eventName}`);
        return deps.emitter.emitPilotEvent(i);
      },
      emitInternalEvent(i) {
        order.push(`internal:${i.eventName}`);
        return deps.emitter.emitInternalEvent(i);
      },
      all: () => deps.emitter.all(),
      reset: () => deps.emitter.reset(),
    };
    runConversation({ ...deps, emitter: wrapped }, UNDERSTOOD_BUT_NEVER_CONFIRMED);
    expect(order.indexOf("internal:INTERNAL_OUTCOME_RESOLVED")).toBeGreaterThan(-1);
    expect(order.indexOf("internal:INTERNAL_OUTCOME_RESOLVED")).toBeLessThan(order.indexOf("pilot:OUTCOME_EMITTED"));
  });
});

// ---------------------------------------------------------------------
// (5) Regresión: los demás resultados no se mueven.
// ---------------------------------------------------------------------

describe("regresión: el resto de resultados conserva su semántica", () => {
  const cases: ReadonlyArray<{
    title: string;
    script: ConversationScript;
    internalReasonCode: InternalReasonCode;
    reasonCode: string;
    notUnderstood: boolean;
    conversion: boolean;
    contained: boolean;
  }> = [
    {
      title: "una reserva completada sigue siendo BOOKING_CONFIRMED, conversión y contención",
      script: {
        scenarioId: "A21-booking-ok",
        callId: "call-regression-booking-ok",
        turns: [
          {
            utterance: "quiero reservar una cita",
            serviceId: 1,
            day: "monday",
            time: "10:00",
            professionalId: ALEX_ID,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
      internalReasonCode: "BOOKING_CONFIRMED",
      reasonCode: "BOOKING_CONFIRMED",
      notUnderstood: false,
      conversion: true,
      contained: true,
    },
    {
      title: "una consulta de disponibilidad sigue siendo contención sin conversión",
      script: {
        scenarioId: "A22-availability-ok",
        callId: "call-regression-availability",
        turns: [
          {
            utterance: "quiero consultar disponibilidad",
            serviceId: 1,
            day: "monday",
            time: "10:00",
            professionalId: ALEX_ID,
            serviceConfirmed: true,
          },
        ],
      },
      internalReasonCode: "AVAILABILITY_PROVIDED",
      reasonCode: "AVAILABILITY_PROVIDED",
      notUnderstood: false,
      conversion: false,
      contained: true,
    },
    {
      title: "una intención de verdad incomprendida SIGUE alimentando la métrica de no-comprensión",
      script: {
        scenarioId: "A23-really-not-understood",
        callId: "call-regression-not-understood",
        turns: [{ utterance: "mmm no se" }, { utterance: "tampoco se explicar esto" }],
      },
      internalReasonCode: "INTENT_NOT_UNDERSTOOD",
      reasonCode: "INTENT_NOT_UNDERSTOOD",
      notUnderstood: true,
      conversion: false,
      contained: false,
    },
    {
      title: "pedir una persona sigue derivando, sin contención",
      script: {
        scenarioId: "A24-human",
        callId: "call-regression-human",
        turns: [{ utterance: "prefiero hablar con una persona" }],
      },
      internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
      reasonCode: "CUSTOMER_REQUESTS_HUMAN",
      notUnderstood: false,
      conversion: false,
      contained: false,
    },
  ];

  for (const c of cases) {
    it(c.title, () => {
      const { result } = run(c.script);
      expect(result.internalReasonCode).toBe(c.internalReasonCode);
      expect(result.reasonCode).toBe(c.reasonCode);
      const d = OUTCOME_DIMENSIONS[result.internalReasonCode];
      expect(d.countsAsNotUnderstood).toBe(c.notUnderstood);
      expect(d.countsAsBookingConversion).toBe(c.conversion);
      expect(d.countsAsContained).toBe(c.contained);
    });
  }

  it("INVARIANTE: para toda llamada, el código interno se mapea al reasonCode congelado que se emitió", () => {
    const scripts = [UNDERSTOOD_BUT_NEVER_CONFIRMED, ...cases.map((c) => c.script)];
    for (const script of scripts) {
      const { result, emitter } = run(script);
      expect(toPilotV1ReasonCode(result.internalReasonCode)).toBe(result.reasonCode);
      const outcome = emitter.all().pilot.find((e) => e.eventName === "OUTCOME_EMITTED");
      expect(outcome?.reasonCode).toBe(result.reasonCode);
    }
  });

  it("solo BOOKING_NOT_CONFIRMED distingue el código interno del congelado; el resto es identidad", () => {
    const scripts = [UNDERSTOOD_BUT_NEVER_CONFIRMED, ...cases.map((c) => c.script)];
    for (const script of scripts) {
      const { result } = run(script);
      if (result.internalReasonCode !== result.reasonCode) {
        expect(result.internalReasonCode).toBe("BOOKING_NOT_CONFIRMED");
      }
    }
  });

  it("una llamada BOOK que sí confirma nunca produce BOOKING_NOT_CONFIRMED", () => {
    const { result, emitter } = run(cases[0]!.script);
    expect(result.internalReasonCode).not.toBe("BOOKING_NOT_CONFIRMED");
    expect(result.announcesSuccess).toBe(true);
    expect(result.syntheticMutation).toBe(true);
    const names = emitter.all().internal.map((e) => e.eventName);
    expect(names).not.toContain("BOOKING_CONFIRMATION_NOT_OBTAINED");
  });
});
