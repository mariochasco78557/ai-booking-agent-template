import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { baseSyntheticVenue, ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { runConversation, type ConversationScript } from "../../src/callEngine/engine.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { PilotEventSchema } from "../../src/callEngine/events/schema.js";

/**
 * step 14, tarea C — coherencia de la métrica de latencia.
 *
 * El motor dejó de emitir `latencyMs` (corrección A2 de step 13) porque el
 * valor que emitía era un contador sintético, no una medición. Pero
 * `PILOT_METRICS.md` seguía definiendo una latencia p95 sobre ese campo. Este
 * fichero fija las tres cosas que deben mantenerse a la vez:
 *
 *   1. el motor NUNCA emite `latencyMs` (nada de latencia fabricada);
 *   2. el esquema congelado lo mantiene OPCIONAL, para que un transporte real
 *      futuro pueda poblarlo sin romper el contrato v1;
 *   3. la documentación del piloto dice que no se recoge y no propone ningún
 *      umbral sobre algo que nadie ha medido.
 */

const SCHEMA_PATH = join(process.cwd(), "docs/call_interruption_mvp/pilot-event.schema.json");
const METRICS_PATH = join(process.cwd(), "docs/call_interruption_mvp/PILOT_METRICS.md");

const frozenSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
  required: string[];
  properties: Record<string, { type?: string; minimum?: number; description?: string }>;
};
const metricsDoc = readFileSync(METRICS_PATH, "utf8");

const SCRIPTS: readonly ConversationScript[] = [
  {
    scenarioId: "A25-timing-booking",
    callId: "call-timing-booking",
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
  {
    scenarioId: "A26-timing-availability",
    callId: "call-timing-availability",
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
  {
    scenarioId: "A27-timing-human",
    callId: "call-timing-human",
    turns: [{ utterance: "prefiero hablar con una persona" }],
  },
  {
    scenarioId: "A28-timing-failure",
    callId: "call-timing-failure",
    turns: [
      {
        utterance: "quiero reservar una cita",
        serviceId: 1,
        day: "monday",
        time: "10:00",
        professionalId: ALEX_ID,
        serviceConfirmed: true,
        injectFailure: true,
      },
    ],
  },
];

function runAll() {
  const emitter = createCallEventEmitter();
  for (const script of SCRIPTS) {
    runConversation(
      {
        cal: baseSyntheticVenue(),
        clock: fixedClock("2026-08-02", 9 * 60),
        emitter,
        store: createMemoryStore(),
        salt: "timing-test-salt",
      },
      script,
    );
  }
  return emitter.all();
}

describe("latencia: nunca se fabrica", () => {
  it("ningún evento piloto emitido lleva latencyMs, en ningún escenario", () => {
    const { pilot } = runAll();
    expect(pilot.length).toBeGreaterThan(0);
    for (const ev of pilot) {
      expect(ev.latencyMs).toBeUndefined();
      expect(Object.keys(ev)).not.toContain("latencyMs");
    }
  });

  it("tampoco aparece en el flujo interno, ni con otro nombre disfrazado", () => {
    const { pilot, internal } = runAll();
    // Los scenarioId de este fichero evitan a propósito la palabra "latency",
    // para que esta comprobación de subcadena signifique algo.
    const serialized = JSON.stringify({ pilot, internal });
    expect(serialized.toLowerCase()).not.toContain("latency");
    expect(serialized.toLowerCase()).not.toContain("elapsedms");
    expect(serialized.toLowerCase()).not.toContain("durationms");
  });

  it("los OUTCOME_EMITTED existen y validan pese a no llevar latencyMs (el campo es opcional de verdad)", () => {
    const { pilot } = runAll();
    const outcomes = pilot.filter((e) => e.eventName === "OUTCOME_EMITTED");
    expect(outcomes.length).toBe(SCRIPTS.length);
    for (const ev of outcomes) {
      expect(() => PilotEventSchema.parse(ev)).not.toThrow();
    }
  });
});

describe("esquema congelado: latencyMs sigue siendo opcional y sigue siendo poblable", () => {
  it("no está en `required`, así que omitirlo hoy es válido", () => {
    expect(frozenSchema.required).not.toContain("latencyMs");
  });

  it("sigue declarado, así que un transporte real futuro puede poblarlo sin romper v1", () => {
    expect(frozenSchema.properties.latencyMs).toBeDefined();
    expect(frozenSchema.properties.latencyMs?.type).toBe("integer");
    expect(frozenSchema.properties.latencyMs?.minimum).toBe(0);
  });

  it("el esquema declara explícitamente que hoy NO se recoge", () => {
    const description = frozenSchema.properties.latencyMs?.description ?? "";
    expect(description).toContain("NO SE RECOGE");
    expect(description).toContain("PILOT_METRICS.md");
  });

  it("un evento con una latencia genuina VALIDA: la vía futura queda abierta", () => {
    const { pilot } = runAll();
    const base = pilot.find((e) => e.eventName === "OUTCOME_EMITTED");
    expect(base).toBeDefined();
    // Esto NO fabrica una métrica: comprueba que el contrato admite el campo
    // el día que exista un reloj real detrás. Nada de esto se emite ni se
    // reporta como rendimiento medido.
    expect(() => PilotEventSchema.parse({ ...base, latencyMs: 1234 })).not.toThrow();
    expect(() => PilotEventSchema.parse({ ...base, latencyMs: -1 })).toThrow();
    expect(() => PilotEventSchema.parse({ ...base, latencyMs: 12.5 })).toThrow();
  });
});

describe("PILOT_METRICS.md es coherente con lo que el motor hace de verdad", () => {
  it("marca la latencia p95 como no recogida en lugar de definirla sobre un campo vacío", () => {
    expect(metricsDoc).toContain("NO SE RECOGE");
    // La fórmula antigua, aplicada tal cual a esta demo, daba un número falso.
    expect(metricsDoc).not.toContain("latencia p95 de resultado = percentil 95");
  });

  it("define la frontera de medición futura, no un número inventado", () => {
    expect(metricsDoc).toContain("Dónde se medirá cuando exista un transporte real");
    expect(metricsDoc).toContain("primer byte");
    expect(metricsDoc).toContain("t1 − t0");
  });

  it("no propone ningún umbral de latencia y no presenta ningún umbral como acordado", () => {
    // El umbral de 2500 ms era una propuesta sobre algo que nadie ha medido.
    expect(metricsDoc).not.toContain("2500");
    expect(metricsDoc).toContain("Sin umbral");
    expect(metricsDoc).toContain("Ninguno de estos umbrales está acordado");
    expect(metricsDoc).toContain("Umbral PROPUESTO, pendiente de aprobación");
  });

  it("dirige el cálculo de métricas a la dimensión interna, no al reasonCode congelado", () => {
    expect(metricsDoc).toContain("INTERNAL_OUTCOME_RESOLVED");
    expect(metricsDoc).toContain("countsAsNotUnderstood");
    expect(metricsDoc).toContain("countsAsContained");
    expect(metricsDoc).toContain("BOOKING_NOT_CONFIRMED");
  });

  it("sigue advirtiendo de que una demo no establece línea base", () => {
    expect(metricsDoc).toContain("no establece línea base");
  });
});
