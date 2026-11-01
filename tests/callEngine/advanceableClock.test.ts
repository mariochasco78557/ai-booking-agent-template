import { describe, expect, it } from "vitest";

import { advanceableClock } from "../../src/callEngine/domain/advanceableClock.js";
import { addDays, daysBetween } from "../../src/callEngine/domain/time.js";
import { fixedClock, type Clock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";

/**
 * step 18 · fase E — EL RELOJ AVANZABLE DE DEMOSTRACIÓN (diseño §3.2).
 *
 * Cierra el criterio 8.39 (con desplazamiento 0 DELEGA literalmente) y los
 * invariantes I1 (monótono), I3 (determinista) e I5 (`resetToBaseline`).
 * Nada aquí lee el reloj de pared: es la propiedad que hace demostrable todo
 * lo demás.
 */

function baseline(): ReturnType<typeof advanceableClock> {
  return advanceableClock(fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES));
}

describe("step 18 · §3.2 — con desplazamiento 0 el envoltorio es indistinguible del reloj que envuelve", () => {
  it("(8.39) delega los tres lectores, incluido un nowInstantISO de formato ajeno", () => {
    // Un reloj inyectado cuyo instante NO tiene el formato de `fixedClock`.
    // Recomponerlo habría reescrito el `atISO` de eventos ya verificados por
    // otras misiones — por eso el desplazamiento 0 delega en vez de derivar.
    const raro: Clock = {
      nowISODate: () => "2026-08-04",
      nowMinutes: () => 540,
      nowInstantISO: () => "un-formato-completamente-ajeno",
    };
    const clock = advanceableClock(raro);
    expect(clock.nowISODate()).toBe("2026-08-04");
    expect(clock.nowMinutes()).toBe(540);
    expect(clock.nowInstantISO()).toBe("un-formato-completamente-ajeno");
    expect(clock.advancedByMinutes()).toBe(0);
  });

  it("en cuanto se mueve, el instante lo produce este módulo con el formato de fixedClock", () => {
    const raro: Clock = {
      nowISODate: () => "2026-08-04",
      nowMinutes: () => 540,
      nowInstantISO: () => "un-formato-completamente-ajeno",
    };
    const clock = advanceableClock(raro);
    clock.advanceMinutes(60);
    expect(clock.nowInstantISO()).toBe("2026-08-04T10:00:00");
  });

  it("el envoltorio arranca exactamente donde arranca el fixture: martes 2026-08-04, 09:00", () => {
    const clock = baseline();
    expect(clock.nowISODate()).toBe(BOOKING_DEMO_TODAY);
    expect(clock.nowMinutes()).toBe(BOOKING_DEMO_NOW_MINUTES);
    expect(clock.nowInstantISO()).toBe(fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES).nowInstantISO());
  });
});

describe("step 18 · §3.2 — I1: sólo avanza, jamás retrocede", () => {
  it("advanceMinutes suma y devuelve el instante nuevo", () => {
    const clock = baseline();
    expect(clock.advanceMinutes(60)).toEqual({ dateISO: "2026-08-04", minutes: 600 });
    expect(clock.advanceMinutes(30)).toEqual({ dateISO: "2026-08-04", minutes: 630 });
    expect(clock.advancedByMinutes()).toBe(90);
  });

  it("advanceMinutes rechaza cero, negativos y no enteros, y no mueve nada", () => {
    const clock = baseline();
    for (const invalido of [0, -1, -600, 1.5]) {
      expect(() => clock.advanceMinutes(invalido)).toThrow(RangeError);
    }
    expect(clock.nowMinutes()).toBe(540);
    expect(clock.advancedByMinutes()).toBe(0);
  });

  it("advanceTo devuelve null y NO cambia nada ante un destino anterior o igual", () => {
    const clock = baseline();
    clock.advanceMinutes(60); // 10:00
    expect(clock.advanceTo("2026-08-04", 600)).toBeNull(); // igual
    expect(clock.advanceTo("2026-08-04", 540)).toBeNull(); // anterior, mismo día
    expect(clock.advanceTo("2026-08-03", 1400)).toBeNull(); // día anterior
    expect(clock.nowMinutes()).toBe(600);
    expect(clock.nowISODate()).toBe("2026-08-04");
    expect(clock.advancedByMinutes()).toBe(60);
  });

  it("advanceTo salta a un instante absoluto estrictamente posterior", () => {
    const clock = baseline();
    expect(clock.advanceTo("2026-08-04", 600)).toEqual({ dateISO: "2026-08-04", minutes: 600 });
    expect(clock.advancedByMinutes()).toBe(60);
    expect(clock.advanceTo("2026-08-06", 630)).toEqual({ dateISO: "2026-08-06", minutes: 630 });
    // Dos días completos menos media hora: 2*1440 + 630 - 600.
    expect(clock.advancedByMinutes()).toBe(60 + 2 * 1440 + 30);
  });
});

describe("step 18 · §3.2 — cruces de medianoche coherentes con domain/time.ts", () => {
  it("pasar de las 23:00 a la 01:00 cambia de día una sola vez", () => {
    const clock = advanceableClock(fixedClock("2026-08-04", 23 * 60));
    expect(clock.advanceMinutes(120)).toEqual({ dateISO: "2026-08-05", minutes: 60 });
    expect(clock.nowInstantISO()).toBe("2026-08-05T01:00:00");
    expect(daysBetween("2026-08-04", clock.nowISODate())).toBe(1);
  });

  it("siete días exactos (el tope de la ruta) caen donde dice addDays, y a la misma hora", () => {
    const clock = baseline();
    clock.advanceMinutes(7 * 1440);
    expect(clock.nowISODate()).toBe(addDays(BOOKING_DEMO_TODAY, 7));
    expect(clock.nowMinutes()).toBe(BOOKING_DEMO_NOW_MINUTES);
    expect(daysBetween(BOOKING_DEMO_TODAY, clock.nowISODate())).toBe(7);
  });

  it("cruzar el cambio de mes es exactamente lo que dice addDays", () => {
    const clock = advanceableClock(fixedClock("2026-08-31", 23 * 60 + 30));
    expect(clock.advanceMinutes(60)).toEqual({ dateISO: "2026-09-01", minutes: 30 });
  });
});

describe("step 18 · §3.2 — I5: resetToBaseline devuelve el reloj al arranque", () => {
  it("después de mover el reloj a lo bruto, el reinicio lo deja como estaba", () => {
    const clock = baseline();
    clock.advanceMinutes(5 * 1440 + 300);
    expect(clock.nowISODate()).not.toBe(BOOKING_DEMO_TODAY);
    clock.resetToBaseline();
    expect(clock.nowISODate()).toBe(BOOKING_DEMO_TODAY);
    expect(clock.nowMinutes()).toBe(BOOKING_DEMO_NOW_MINUTES);
    expect(clock.advancedByMinutes()).toBe(0);
    // Y vuelve a DELEGAR: el instante es otra vez el del reloj envuelto.
    expect(clock.nowInstantISO()).toBe("2026-08-04T09:00:00");
  });
});

describe("step 18 · §3.2 — I3: determinista", () => {
  it("la misma secuencia desde dos arranques limpios da el mismo instante", () => {
    const uno = baseline();
    const dos = baseline();
    for (const clock of [uno, dos]) {
      clock.advanceMinutes(45);
      clock.advanceTo("2026-08-05", 90);
      clock.advanceMinutes(1440);
    }
    expect(uno.nowISODate()).toBe(dos.nowISODate());
    expect(uno.nowMinutes()).toBe(dos.nowMinutes());
    expect(uno.nowInstantISO()).toBe(dos.nowInstantISO());
    expect(uno.advancedByMinutes()).toBe(dos.advancedByMinutes());
  });

  it("el módulo no contiene ninguna lectura de reloj de pared ni temporizador", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/callEngine/domain/advanceableClock.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const prohibido of ["Date.now(", "Math.random(", "setTimeout", "setInterval", "new Date("]) {
      expect(source.includes(prohibido), prohibido).toBe(false);
    }
  });
});
