import { describe, expect, it } from "vitest";

import { madridClock } from "../../src/voice/elevenlabs/agenda/madridClock.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * BLOQUE C · EL «HOY» DEL MODO real_readonly ES EL DE Europe/Madrid.
 *
 * El modo sintético corre sobre un reloj fijo y no lee la hora real. El modo
 * real no puede: la agenda del otro lado está fechada en tiempo real y el
 * upstream habla wall-clock de Madrid sin zona horaria. Si este reloj usara
 * la zona del SERVIDOR —un VPS en UTC, por ejemplo—, a las 00:30 de Madrid
 * en verano el puente contestaría sobre el día ANTERIOR: ofrecería huecos de
 * ayer y rechazaría por «pasada» una cita de esta misma mañana.
 *
 * Todas las comprobaciones parten de un instante UTC explícito, así que
 * valen igual en un portátil en Madrid que en un contenedor en UTC.
 * ────────────────────────────────────────────────────────────────────────
 */

function clockAt(utcInstant: string): ReturnType<typeof madridClock> {
  return madridClock(() => new Date(utcInstant));
}

describe("reloj de Europe/Madrid del modo real_readonly", () => {
  it("en verano (CEST, UTC+2) ya es el día siguiente a las 22:00 UTC", () => {
    const antes = clockAt("2026-08-24T21:59:00Z");
    expect(antes.nowISODate()).toBe("2026-08-24");
    expect(antes.nowMinutes()).toBe(23 * 60 + 59);

    const despues = clockAt("2026-08-24T22:00:00Z");
    expect(despues.nowISODate()).toBe("2026-08-25");
    expect(despues.nowMinutes()).toBe(0);
  });

  it("en invierno (CET, UTC+1) el corte de día está a las 23:00 UTC", () => {
    expect(clockAt("2026-01-15T22:59:00Z").nowISODate()).toBe("2026-01-15");
    expect(clockAt("2026-01-15T23:00:00Z").nowISODate()).toBe("2026-01-16");
  });

  it("suma una hora en invierno y dos en verano sobre el mismo UTC", () => {
    expect(clockAt("2026-01-15T10:00:00Z").nowMinutes()).toBe(11 * 60);
    expect(clockAt("2026-08-15T10:00:00Z").nowMinutes()).toBe(12 * 60);
  });

  it("cruza el cambio de hora de primavera sin saltarse el día", () => {
    // 01:30 UTC del 29-03-2026: en Madrid ya son las 03:30, la hora que el
    // reloj local se salta esa madrugada.
    const clock = clockAt("2026-03-29T01:30:00Z");
    expect(clock.nowISODate()).toBe("2026-03-29");
    expect(clock.nowMinutes()).toBe(3 * 60 + 30);
  });

  it("cruza el cambio de hora de otoño sin repetir el día", () => {
    const clock = clockAt("2026-10-25T00:30:00Z");
    expect(clock.nowISODate()).toBe("2026-10-25");
    expect(clock.nowMinutes()).toBe(2 * 60 + 30);
  });

  it("publica el instante en el mismo wall-clock que habla el upstream", () => {
    expect(clockAt("2026-08-24T22:05:00Z").nowInstantISO()).toBe("2026-08-25T00:05:00");
  });

  it("por defecto lee el reloj del sistema y devuelve una fecha bien formada", () => {
    const clock = madridClock();
    expect(clock.nowISODate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(clock.nowMinutes()).toBeGreaterThanOrEqual(0);
    expect(clock.nowMinutes()).toBeLessThan(24 * 60);
  });
});
