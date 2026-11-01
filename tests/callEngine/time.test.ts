import { describe, it, expect } from "vitest";
import { parseHHmm, formatHHmm } from "../../src/callEngine/domain/time.js";

/**
 * Cobertura directa de aviso O2 (step 16): `parseHHmm` no tenía ninguna
 * prueba unitaria propia, solo se ejercitaba de rebote dentro de pruebas de
 * más alto nivel. La función NO se modifica aquí: ver
 * `src/callEngine/domain/time.ts` L56-59.
 */
describe("parseHHmm — minutos desde medianoche (aviso O2 de step 16)", () => {
  it("convierte las horas reales del local de Demo Salon", () => {
    expect(parseHHmm("09:00")).toBe(540);
    expect(parseHHmm("09:30")).toBe(570);
    expect(parseHHmm("14:00")).toBe(840);
    expect(parseHHmm("17:30")).toBe(1050);
    expect(parseHHmm("19:30")).toBe(1170);
  });

  it("los dos extremos del día", () => {
    expect(parseHHmm("00:00")).toBe(0);
    expect(parseHHmm("23:59")).toBe(1439);
  });

  it("es la inversa exacta de formatHHmm en todos los minutos del día", () => {
    for (let m = 0; m < 1440; m += 1) {
      expect(parseHHmm(formatHHmm(m))).toBe(m);
    }
  });

  it("una cadena sin minutos NO revienta: los trata como cero (comportamiento actual, documentado aquí para que un cambio se note)", () => {
    expect(parseHHmm("09")).toBe(540);
  });
});
