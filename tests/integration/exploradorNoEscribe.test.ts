import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { ALEX, DANI, NEREA, freshApp, huellaCompleta, reset } from "./harness.js";

/**
 * step 19 · Capacidad 1 — PUREZA DE ESTADO (§3.7, §7.1 I4).
 *
 * Patrón de `tests/integration/determinismo.test.ts`: instantánea → N
 * consultas al explorador (incluidos los seis casos de error) → instantánea
 * de nuevo. Las dos tienen que ser IDÉNTICAS salvo `generatedAt`. Una
 * consulta del explorador es lectura pura: no reserva, no cancela, no anota
 * ninguna cita, no escribe ningún evento, y — importante — no aparece en
 * `availabilityQueries` (esa lista es del MOTOR durante una llamada, no de
 * este panel).
 */

async function explore(app: FastifyInstance, qs: string) {
  return app.inject({ method: "GET", url: `/api/availability/explore?${qs}` });
}

const CONSULTAS: readonly string[] = [
  // Diez consultas legítimas, con las dos formas y varios servicios/fechas.
  `serviceId=1&mode=any&from=2026-08-04&to=2026-08-04`,
  `serviceId=1&mode=one&employeeId=${String(ALEX)}&from=2026-08-04&to=2026-08-04`,
  `serviceId=0&mode=one&employeeId=${String(DANI)}&from=2026-08-04&to=2026-08-06`,
  `serviceId=2&mode=any&from=2026-08-04&to=2026-08-10`,
  `serviceId=1&mode=one&employeeId=${String(NEREA)}&from=2026-08-05&to=2026-08-05`,
  `serviceId=0&mode=one&employeeId=${String(NEREA)}&from=2026-08-04&to=2026-08-04`, // incapacidad, 200
  `serviceId=2&mode=one&employeeId=${String(ALEX)}&from=2026-08-04&to=2026-08-17`, // 14 días exactos
  `serviceId=1&mode=any&from=2026-11-01&to=2026-11-01`, // fuera de horizonte
  `serviceId=1&mode=one&employeeId=${String(ALEX)}&from=2026-08-01&to=2026-08-04`, // incluye días ya pasados
  `serviceId=1&mode=any&from=2026-08-04&to=2026-08-04`, // repetida
  // Seis errores 400, deliberadamente incluidos: una petición mal formada
  // tampoco escribe nada.
  `serviceId=9&mode=any&from=2026-08-04&to=2026-08-04`,
  `serviceId=1&mode=one&from=2026-08-04&to=2026-08-04`,
  `serviceId=1&mode=one&employeeId=999999&from=2026-08-04&to=2026-08-04`,
  `serviceId=1&mode=any&from=2026-08-05&to=2026-08-04`,
  `serviceId=1&mode=any&from=2026-08-04&to=2026-08-20`,
  `serviceId=1&mode=any&from=2026-02-31&to=2026-02-31`,
  // Cuatro más, para llegar a veinte en total (§3.7).
  `serviceId=2&mode=any&from=2026-08-04&to=2026-08-04`,
  `serviceId=0&mode=any&from=2026-08-04&to=2026-08-04`,
  `serviceId=1&mode=one&employeeId=${String(DANI)}&from=2026-08-04&to=2026-08-04`,
  `serviceId=1&mode=any&from=2026-08-04&to=2026-08-05`,
];

describe("step 19 · Capacidad 1 — el explorador de huecos no escribe nada, ni con éxito ni con error", () => {
  it("veinte consultas (incluidos los seis casos de error) dejan la instantánea IDÉNTICA salvo generatedAt", async () => {
    expect(CONSULTAS.length).toBeGreaterThanOrEqual(20);
    const app = freshApp();
    await reset(app);

    const antes = await huellaCompleta(app);

    for (const qs of CONSULTAS) {
      const res = await explore(app, qs);
      expect([200, 400]).toContain(res.statusCode);
    }

    const despues = await huellaCompleta(app);
    expect(despues).toBe(antes);

    await app.close();
  });

  it("una consulta repetida dos veces produce la misma respuesta, letra por letra (es una consulta, no una acción con efecto)", async () => {
    const app = freshApp();
    await reset(app);
    const qs = `serviceId=1&mode=any&from=2026-08-04&to=2026-08-06`;
    const r1 = await explore(app, qs);
    const r2 = await explore(app, qs);
    expect(r1.statusCode).toBe(200);
    expect(r2.body).toBe(r1.body);
    await app.close();
  });

  it("una consulta del explorador no aparece en 'availabilityQueries' del motor: esa lista es de las llamadas, no de este panel", async () => {
    const app = freshApp();
    await reset(app);
    const antes = ((await (await app.inject({ method: "GET", url: "/api/snapshot" })).json()) as { availabilityQueries?: unknown[] })
      .availabilityQueries;
    await explore(app, "serviceId=1&mode=any&from=2026-08-04&to=2026-08-04");
    const despues = ((await (await app.inject({ method: "GET", url: "/api/snapshot" })).json()) as { availabilityQueries?: unknown[] })
      .availabilityQueries;
    expect(despues).toEqual(antes);
    await app.close();
  });
});
