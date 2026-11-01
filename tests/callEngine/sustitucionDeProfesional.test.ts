import { describe, it, expect } from "vitest";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import {
  demoSalonVenue,
  BOOKING_DEMO_TODAY,
  BOOKING_DEMO_NOW_MINUTES,
} from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { runConversation, type ConversationScript, type ConversationResult } from "../../src/callEngine/engine.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";

/**
 * step 22 · fase 6 — regresión del hallazgo BLOQUEANTE B2 de la revisión
 * adversarial de la fase 5: cuando la única alternativa posible era OTRO
 * profesional, el motor decía «ese horario exacto no está libre» (falso),
 * ofrecía como alternativa el mismísimo día y hora, y reservaba con otro
 * profesional sin nombrarlo jamás.
 *
 * El guion de llamada es el del script `r13.mts` (casos A y B). Las pruebas
 * fallan contra el código anterior a la reparación (HEAD c1d5e35).
 */

const ALEX = 3;
const NEREA = 9;

function correr(script: ConversationScript, cal: CalendarWithCapabilities = demoSalonVenue()): ConversationResult {
  return runConversation(
    {
      cal,
      clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
      emitter: createCallEventEmitter(),
      store: createMemoryStore(),
      salt: "regresion-rc1-salt",
    },
    script,
  );
}

describe("step 22 · B2 — cambiar de profesional se dice, y no se disfraza de horario ocupado", () => {
  /** El guion de `r13.mts`, caso A: Nerea no hace Barba (servicio 0). */
  const guionNereaNoPuede: ConversationScript = {
    scenarioId: "A91-rc1-b2-nerea-no-puede",
    callId: "rc1-b2-a",
    turns: [
      { utterance: "quiero reservar", serviceId: 0, serviceConfirmed: true },
      { day: "wednesday" },
      { time: "11:00" },
      { professionalId: NEREA },
      { bookingConfirmed: true },
    ],
  };

  it("cuando la alternativa cambia de PROFESIONAL, se emite OFFER_ANOTHER_PROFESSIONAL y nunca OFFER_ALTERNATIVES", () => {
    const res = correr(guionNereaNoPuede);
    const claves = res.turns.map((t) => t.phraseKey);
    expect(claves).toContain("OFFER_ANOTHER_PROFESSIONAL");
    // La frase de OFFER_ALTERNATIVES afirma «ese horario exacto no está
    // libre», que aquí es falso: el hueco está libre, quien no puede es la
    // profesional pedida.
    expect(claves).not.toContain("OFFER_ALTERNATIVES");
  });

  it("la oferta nombra al profesional sustituto, y la reserva se escribe con ese mismo profesional", () => {
    const res = correr(guionNereaNoPuede);
    const oferta = res.turns.find((t) => t.phraseKey === "OFFER_ANOTHER_PROFESSIONAL");
    expect(oferta).toBeDefined();
    const reserva = res.reservation;
    if (reserva === undefined) throw new Error("la llamada no ha reservado");
    expect(reserva.employeeId).not.toBe(NEREA);
    expect(oferta?.params?.employeeId).toBe(reserva.employeeId);
    expect(typeof oferta?.params?.professional).toBe("string");
    expect(String(oferta?.params?.professional).length).toBeGreaterThan(0);
  });

  it("y el recordatorio previo a confirmar también nombra a quien va a atender", () => {
    const res = correr(guionNereaNoPuede);
    const recap = res.turns.find((t) => t.phraseKey === "ASK_BOOKING_CONFIRMATION");
    expect(recap).toBeDefined();
    expect(recap?.params?.employeeId).toBe(res.reservation?.employeeId);
  });

  it("cuando la alternativa cambia sólo de DÍA, el profesional no cambia y se sigue usando OFFER_ALTERNATIVES", () => {
    // Caso B de `r13.mts`: Álex está ocupado hoy a las 09:30; la alternativa
    // honesta es el mismo Álex otro día, y esa frase sí es verdad.
    const res = correr({
      scenarioId: "A92-rc1-b2-alex-ocupado",
      callId: "rc1-b2-b",
      turns: [
        { utterance: "quiero reservar", serviceId: 1, serviceConfirmed: true },
        { day: "tuesday" },
        { time: "09:30" },
        { professionalId: ALEX },
        { bookingConfirmed: true },
      ],
    });
    const claves = res.turns.map((t) => t.phraseKey);
    expect(claves).toContain("OFFER_ALTERNATIVES");
    expect(claves).not.toContain("OFFER_ANOTHER_PROFESSIONAL");
    expect(res.reservation?.employeeId).toBe(ALEX);
  });
});
