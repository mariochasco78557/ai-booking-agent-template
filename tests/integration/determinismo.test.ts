import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  ALEX,
  DANI,
  type Json,
  type LineaDeGrupo,
  RES_ALEX_0930,
  RES_ALEX_1300,
  anotarInasistencia,
  avanzarHastaElFinalDe,
  HUECO_1300_ALEX,
  aprobarPropuesta,
  cancelar,
  claveDeAnotacion,
  comando,
  crearGrupo,
  ejecutarEscenario,
  freshApp,
  huellaCompleta,
  snapshotOf,
} from "./harness.js";

/**
 * step 18 · fase H — criterio 8.33: DETERMINISMO ENTRE EJECUCIONES.
 *
 * Tres arranques limpios, la MISMA secuencia guiada, y las tres instantáneas
 * comparadas byte a byte quitando sólo `generatedAt` (el único sello de reloj
 * de pared del entregable, declarado como tal en `server.ts`).
 *
 * La secuencia toca a propósito las cuatro fuentes de no-determinismo que
 * podría haber: el contador de escenarios (`console-call-N` y el hash de
 * llamada que de él se deriva), el reloj avanzable, la numeración de
 * inasistencias y la de grupos. Si alguna leyera `Date.now()`, `Math.random()`
 * o un contador que no se reinicia, estas tres huellas no coincidirían.
 *
 * `tests/console/groupApi.test.ts` y `noShowApi.test.ts` ya comparan DOS
 * arranques limitados a un bloque; esto compara TRES y la instantánea entera.
 */

// Las 11:00 del martes: Álex y Dani están libres los dos (Dani tiene la
// 10:00–10:30 y la 11:30–12:00, pero no las 11:00).
const LINEAS: LineaDeGrupo[] = [
  { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 660 },
  { memberLabel: "Menor B", serviceId: 0, employeeId: DANI, startMinutes: 660 },
];

/** La secuencia guiada: escenario → reloj → inasistencia → grupo → cancelación → oferta. */
async function secuenciaGuiada(app: FastifyInstance): Promise<void> {
  const llamada = await ejecutarEscenario(app, "A01-determinismo", {
    utterance: "quiero reservar una cita",
    day: "wednesday",
    time: "10:00",
    professionalId: ALEX,
    serviceId: 1,
    serviceConfirmed: true,
    bookingConfirmed: true,
  });
  expect(llamada.statusCode).toBe(200);

  expect((await avanzarHastaElFinalDe(app, RES_ALEX_0930)).statusCode).toBe(200);
  expect((await anotarInasistencia(app, RES_ALEX_0930, await claveDeAnotacion(app, RES_ALEX_0930))).statusCode).toBe(201);
  expect((await crearGrupo(app, LINEAS, "determinismo:grupo:1", { arrangement: "simultaneous" })).statusCode).toBe(201);
  expect((await cancelar(app, RES_ALEX_1300)).statusCode).toBe(200);
  // (step 23, R2) El paso humano que faltaba: una persona aprueba la
  // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
  await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
  expect((await comando(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
}

async function ejecutarDesdeCero(): Promise<{ huella: string; snapshot: Json }> {
  const app = freshApp();
  await secuenciaGuiada(app);
  const huella = await huellaCompleta(app);
  const snapshot = await snapshotOf(app);
  await app.close();
  return { huella, snapshot };
}

describe("step 18 · integración criterio 8.33 — tres arranques limpios, la misma secuencia, la misma instantánea", () => {
  it("las tres huellas completas coinciden byte a byte", async () => {
    const uno = await ejecutarDesdeCero();
    const dos = await ejecutarDesdeCero();
    const tres = await ejecutarDesdeCero();

    expect(dos.huella.length).toBe(uno.huella.length);
    expect(dos.huella).toBe(uno.huella);
    expect(tres.huella).toBe(uno.huella);
  });

  it("bloque a bloque, para que un fallo diga dónde se coló el no-determinismo", async () => {
    const uno = await ejecutarDesdeCero();
    const dos = await ejecutarDesdeCero();
    // step 19 §6.4: "demo" es la tercera y última clave nueva de primer
    // nivel. Se compara aquí igual que las demás — es enteramente derivada
    // de los cuatro bloques ya comparados, así que un no-determinismo suyo
    // sería, de hecho, un no-determinismo de uno de ellos que este bloque no
    // había cazado.
    for (const clave of ["calls", "reservations", "eventCounts", "humanQueue", "calendar", "waitlist", "operations", "demo"]) {
      expect(JSON.stringify(dos.snapshot[clave]), clave).toBe(JSON.stringify(uno.snapshot[clave]));
    }
  });

  /**
   * step 19 §10.2 (determinismo.test.ts, ampliado) — la clave `demo` entera
   * (resumen 3A + guion 3B) y la respuesta del explorador de huecos
   * sintéticos (Capacidad 1) son igual de deterministas: tres arranques
   * limpios con la MISMA secuencia producen la MISMA respuesta, byte a byte.
   */
  it("`demo` (resumen 3A + guion 3B) es idéntico en las tres ejecuciones, byte a byte", async () => {
    const uno = await ejecutarDesdeCero();
    const dos = await ejecutarDesdeCero();
    const tres = await ejecutarDesdeCero();
    expect(JSON.stringify(dos.snapshot.demo)).toBe(JSON.stringify(uno.snapshot.demo));
    expect(JSON.stringify(tres.snapshot.demo)).toBe(JSON.stringify(uno.snapshot.demo));
    // Y no es un objeto vacío que coincidiera por casualidad.
    const demo = uno.snapshot.demo as Json;
    expect((demo.guides as Json[]).length).toBe(2);
    expect(((demo.summary as Json).blocks as Json[]).flatMap((b) => b.measures as Json[]).length).toBe(27);
  });

  it("el explorador de huecos sintéticos (Capacidad 1) responde IGUAL en las tres ejecuciones, para la misma consulta", async () => {
    const consulta = async (): Promise<Json> => {
      const app = freshApp();
      await secuenciaGuiada(app);
      const res = await app.inject({ method: "GET", url: "/api/availability/explore?serviceId=1&mode=any&from=2026-08-04&to=2026-08-04" });
      expect(res.statusCode).toBe(200);
      await app.close();
      return res.json() as Json;
    };
    const a = await consulta();
    const b = await consulta();
    const c = await consulta();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it("los identificadores que la secuencia acuña son los mismos en las tres ejecuciones", async () => {
    const ids = async (): Promise<string[]> => {
      const { snapshot } = await ejecutarDesdeCero();
      const operations = snapshot.operations as Json;
      return [
        ...((operations.groups as Json).items as Json[]).map((g) => String(g.id)),
        ...((operations.noShows as Json).records as Json[]).map((r) => String(r.id)),
        ...((operations.audit as Json).items as Json[]).map((e) => String(e.id)),
        ...((snapshot.calendar as Json).reservations as Json[]).map((r) => String(r.id)),
        ...((snapshot.calls as Json[]).map((c) => String(c.callIdHash))),
      ];
    };
    const a = await ids();
    const b = await ids();
    const c = await ids();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // Y no es una lista vacía que coincide por casualidad.
    expect(a.length).toBeGreaterThan(10);
  });

  it("`generatedAt` es LO ÚNICO que cambia entre dos instantáneas del mismo servidor", async () => {
    const app = freshApp();
    await secuenciaGuiada(app);
    const primera = await snapshotOf(app);
    const segunda = await snapshotOf(app);
    const { generatedAt: unoAt, ...restoUno } = primera;
    const { generatedAt: dosAt, ...restoDos } = segunda;
    expect(typeof unoAt).toBe("string");
    expect(typeof dosAt).toBe("string");
    expect(JSON.stringify(restoDos)).toBe(JSON.stringify(restoUno));
    await app.close();
  });
});
