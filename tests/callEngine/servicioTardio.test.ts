import { describe, it, expect } from "vitest";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import { isSlotFree } from "../../src/callEngine/calendar/resolveAvailability.js";
import {
  demoSalonVenue,
  BOOKING_DEMO_TODAY,
  BOOKING_DEMO_NOW_MINUTES,
} from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { runConversation, type ConversationScript, type ConversationResult } from "../../src/callEngine/engine.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";

/**
 * step 22 · fase 6 — regresión del hallazgo BLOQUEANTE B1 de la revisión
 * adversarial de la fase 5: una llamada en la que el servicio sólo aparece
 * en la puerta de confirmación reservaba SIN profesional asignado, no
 * ocupaba el hueco y permitía reservar dos veces la misma media hora.
 *
 * El guion de llamada es exactamente el del script `r2.mts` con el que el
 * revisor lo demostró. Las tres pruebas fallan contra el código anterior a
 * la reparación (HEAD c1d5e35).
 */

/** Miércoles 5 de agosto de 2026, 11:00 — libre en el fixture para los tres. */
const MIERCOLES = "2026-08-05";
const ONCE_EN_PUNTO = 11 * 60;

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

/** El guion de `r2.mts`: el servicio sólo aparece en la puerta de confirmación. */
function guionServicioTardio(callId: string): ConversationScript {
  return {
    scenarioId: "A90-rc1-b1-servicio-tardio",
    callId,
    turns: [
      { utterance: "quiero reservar una cita" },
      { serviceId: null },
      { day: "wednesday" },
      { time: "11:00" },
      { professionalId: "any" },
      { serviceId: 1, serviceConfirmed: true, bookingConfirmed: true },
    ],
  };
}

describe("step 22 · B1 — un servicio que llega tarde no puede reservar sin profesional", () => {
  it("la reserva escrita lleva SIEMPRE un profesional real, y su identificador no acaba en 'undefined'", () => {
    const res = correr(guionServicioTardio("rc1-b1-a"));

    // O se asigna profesional, o se falla en cerrado. Lo que no puede pasar
    // es anunciar una reserva confirmada sin nadie detrás.
    if (res.reservation !== undefined) {
      expect(res.reservation.employeeId).toBeDefined();
      expect(typeof res.reservation.employeeId).toBe("number");
      expect(res.reservation.id.endsWith("-undefined")).toBe(false);
    } else {
      expect(res.announcesSuccess).toBe(false);
      expect(res.internalReasonCode).not.toBe("BOOKING_CONFIRMED");
      expect(res.syntheticMutation).toBe(false);
    }
  });

  it("y esa reserva OCUPA el hueco de un profesional de verdad: esa media hora deja de estar libre", () => {
    const cal = demoSalonVenue();
    const res = correr(guionServicioTardio("rc1-b1-b"), cal);
    const reserva = res.reservation;
    if (reserva === undefined) throw new Error("sin reserva que comprobar");
    // Sin esta comprobación la siguiente mentiría: un `employeeId` indefinido
    // sólo «ocupa» el hueco de otro indefinido, que no existe en la plantilla.
    expect(cal.professionals.map((p) => p.employeeId)).toContain(reserva.employeeId);

    const calDespues: CalendarWithCapabilities = { ...cal, reservations: [...cal.reservations, reserva] };
    expect(isSlotFree(calDespues, reserva.employeeId, MIERCOLES, ONCE_EN_PUNTO)).toBe(false);
  });

  it("una segunda llamada idéntica no puede quedarse con el mismo profesional a la misma hora", () => {
    const cal = demoSalonVenue();
    const primera = correr(guionServicioTardio("rc1-b1-c1"), cal);
    const reserva1 = primera.reservation;
    if (reserva1 === undefined) throw new Error("la primera llamada no ha reservado");
    expect(cal.professionals.map((p) => p.employeeId)).toContain(reserva1.employeeId);

    const calDespues: CalendarWithCapabilities = { ...cal, reservations: [...cal.reservations, reserva1] };
    const segunda = correr(guionServicioTardio("rc1-b1-c2"), calDespues);
    const reserva2 = segunda.reservation;
    if (reserva2 !== undefined) {
      expect(cal.professionals.map((p) => p.employeeId)).toContain(reserva2.employeeId);
      const mismaMediaHora =
        reserva2.date === reserva1.date &&
        reserva2.startMinutes === reserva1.startMinutes &&
        reserva2.employeeId === reserva1.employeeId;
      expect(mismaMediaHora).toBe(false);
    }
  });
});
