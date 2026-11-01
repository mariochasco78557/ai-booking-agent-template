import { describe, it, expect } from "vitest";

import {
  BALANCED_CLOSING_REMINDER_ES,
  balancedConfirmedClosingEs,
  balancedConfirmedSpokenEs,
} from "../src/utils/balancedPhrasing.js";
import { bookingConfirmedMessage } from "../src/utils/phrasing.js";

/**
 * 2026-10-10 — saludo y cierre de Bruno (internal doc, not included in the template).
 * The voice closing of a booking: day, hour and barber from the server, and
 * the cancellation reminder once per call, in the same turn.
 */
describe("cierre de voz en la línea de Bruno", () => {
  it("día completo, hora, profesional y recordatorio en una sola intervención", () => {
    expect(
      balancedConfirmedClosingEs(bookingConfirmedMessage("2026-10-16 18:00:00"), {
        employeeName: "Olga",
        reminder: true,
      }),
    ).toBe(
      "Listo, cita confirmada: el viernes dieciséis de octubre a las seis de la tarde con Olga. " +
        "Si necesitas cambiarla o anularla, llámanos o escríbenos por WhatsApp, con al menos una hora de antelación.",
    );
  });

  it("el recordatorio dice teléfono y WhatsApp, una hora, y nada de cobros ni precios", () => {
    expect(BALANCED_CLOSING_REMINDER_ES).toContain("llámanos o escríbenos por WhatsApp");
    expect(BALANCED_CLOSING_REMINDER_ES).toContain("al menos una hora de antelación");
    expect(BALANCED_CLOSING_REMINDER_ES).not.toMatch(/cobr|precio|pag|€|euro/iu);
  });

  it("sin nombre conocido no nombra a nadie (nunca lo inventa)", () => {
    const sentence = balancedConfirmedClosingEs(bookingConfirmedMessage("2026-10-13 10:00:00"), {
      reminder: true,
    });
    expect(sentence.startsWith("Listo, cita confirmada: el martes trece de octubre a las diez de la mañana. ")).toBe(
      true,
    );
    expect(sentence).not.toMatch(/mañana con /u);
    expect(
      balancedConfirmedClosingEs(bookingConfirmedMessage("2026-10-13 10:00:00"), { employeeName: "  ", reminder: false }),
    ).toBe("Listo, cita confirmada: el martes trece de octubre a las diez de la mañana.");
  });

  it("segunda cita de la misma llamada: sin repetir el recordatorio", () => {
    expect(
      balancedConfirmedClosingEs(bookingConfirmedMessage("2026-10-16 12:30:00"), {
        employeeName: "Ramón",
        reminder: false,
      }),
    ).toBe("Listo, cita confirmada: el viernes dieciséis de octubre a las doce y media del mediodía con Ramón.");
  });

  it("cualquier otra frase (un cambio, un error) pasa como antes, sin recordatorio", () => {
    const change = "Hecho: te he cambiado la cita del sábado diez a las nueve y media al martes trece a las doce.";
    expect(balancedConfirmedClosingEs(change, { employeeName: "Bruno", reminder: true })).toBe(
      balancedConfirmedSpokenEs(change),
    );
    expect(balancedConfirmedClosingEs(change, { employeeName: "Bruno", reminder: true })).toBe(change);
  });
});
