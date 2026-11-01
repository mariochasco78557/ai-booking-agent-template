import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { IDEMPOTENCY_KEY_PATTERN } from "../../src/console/idempotency.js";
import {
  type Json,
  RES_ALEX_0930,
  RES_DANI_1000,
  RES_DANI_1130,
  RES_NEREA_1230,
  anotarInasistencia,
  avanzarMinutos,
  claveDeAnotacion,
  claveDeCorreccion,
  corregirInasistencia,
  filaDeAgenda,
  freshApp,
  historialDeOperaciones,
  huellaDelMundo,
  operationsOf,
  reset,
} from "./harness.js";

/**
 * step 18 · fase H — LAS INASISTENCIAS POR EL CAMINO REAL DEL CLIENTE.
 *
 * La diferencia con `tests/console/noShowApi.test.ts` está en de dónde salen
 * las claves de idempotencia: aquí NUNCA se escriben a mano. Se leen de la
 * fila de la Agenda (`noShowKeyToMint` / `noShowFixKeyToMint`), que es
 * exactamente lo que hace `ui.js.ts` (`confirmarInasistencia`,
 * `confirmarCorregirInasistencia`) — decisión N3 del diseño: la clave la
 * acuña el servidor, el navegador no deriva ninguna.
 *
 * Con eso, lo que se demuestra es que el mecanismo de la revisión (`:v0` /
 * `:v1`, §2.7) SIRVE PARA ALGO en la secuencia completa, y que las cifras
 * derivadas y el registro cuentan la misma historia.
 */

/** El reloj a las 17:00: toda la agenda del martes ha terminado salvo la de las 16:00. */
async function alFinalDeLaTarde(app: FastifyInstance): Promise<void> {
  const res = await avanzarMinutos(app, 8 * 60);
  expect(res.statusCode).toBe(200);
}

function cuentaDe(historial: readonly Json[], kind: string): number {
  return historial.filter((e) => e.kind === kind).length;
}

describe("step 18 · integración §2.7 — registrar y corregir con las claves que proyecta el servidor", () => {
  it("las dos claves de la fila son válidas como cabecera y llevan dentro la revisión del mundo", async () => {
    const app = freshApp();
    await reset(app);
    await alFinalDeLaTarde(app);
    const fila = await filaDeAgenda(app, RES_ALEX_0930);
    expect(fila.noShowRevision).toBe(0);
    expect(fila.noShowKeyToMint).toBe(`noshow:${RES_ALEX_0930}:v0`);
    expect(fila.noShowFixKeyToMint).toBe(`noshow-fix:${RES_ALEX_0930}:v0`);
    expect(IDEMPOTENCY_KEY_PATTERN.test(String(fila.noShowKeyToMint))).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test(String(fila.noShowFixKeyToMint))).toBe(true);
    await app.close();
  });

  it("registrar dos veces leyendo la clave de la pantalla cada vez: la segunda es un replay y no cambia ni un registro", async () => {
    const app = freshApp();
    await reset(app);
    await alFinalDeLaTarde(app);

    const primera = await anotarInasistencia(app, RES_ALEX_0930, await claveDeAnotacion(app, RES_ALEX_0930));
    expect(primera.statusCode).toBe(201);
    expect(primera.headers["idempotency-status"]).toBe("original");

    // El operador vuelve a pulsar. La pantalla ha repintado y ha vuelto a
    // acuñar la MISMA clave, porque la revisión no ha cambiado.
    const clave = await claveDeAnotacion(app, RES_ALEX_0930);
    expect(clave).toBe(`noshow:${RES_ALEX_0930}:v0`);
    const segunda = await anotarInasistencia(app, RES_ALEX_0930, clave);
    expect(segunda.statusCode).toBe(201);
    expect(segunda.headers["idempotency-status"]).toBe("replayed");
    expect(segunda.body).toBe(primera.body);

    const operations = await operationsOf(app);
    expect(((operations.noShows as Json).records as Json[]).length).toBe(1);
    expect((operations.metrics as Json).noShowsRecordedNow).toBe(1);
    expect((operations.metrics as Json).noShowRecordCommands).toBe(1);
    expect((operations.metrics as Json).repeatedCommandsIgnored).toBe(1);
    await app.close();
  });

  it("corregir avanza la revisión a v1; registrar con ESA clave es 409 no_show_already_corrected y no escribe nada", async () => {
    const app = freshApp();
    await reset(app);
    await alFinalDeLaTarde(app);
    expect((await anotarInasistencia(app, RES_ALEX_0930, await claveDeAnotacion(app, RES_ALEX_0930))).statusCode).toBe(201);

    const correccion = await corregirInasistencia(app, RES_ALEX_0930, await claveDeCorreccion(app, RES_ALEX_0930));
    expect(correccion.statusCode).toBe(200);

    // La pantalla acuña ahora la revisión 1: la clave vieja ya no describe
    // este mundo, y por eso el 409 SE PUEDE alcanzar en vez de quedar
    // congelado detrás de un 201 memorizado (§2.7, criterio 8.38).
    const fila = await filaDeAgenda(app, RES_ALEX_0930);
    expect(fila.noShowRevision).toBe(1);
    expect(fila.noShowKeyToMint).toBe(`noshow:${RES_ALEX_0930}:v1`);

    const huellaAntes = await huellaDelMundo(app);
    const reintento = await anotarInasistencia(app, RES_ALEX_0930, String(fila.noShowKeyToMint));
    expect(reintento.statusCode).toBe(409);
    expect(reintento.json()).toEqual({ conflict: "no_show_already_corrected", reservationId: RES_ALEX_0930 });
    expect(await huellaDelMundo(app)).toBe(huellaAntes);
    await app.close();
  });

  it("corregir dos veces con la clave de la pantalla es un replay: una sola corrección en el registro", async () => {
    const app = freshApp();
    await reset(app);
    await alFinalDeLaTarde(app);
    await anotarInasistencia(app, RES_ALEX_0930, await claveDeAnotacion(app, RES_ALEX_0930));
    const clave = await claveDeCorreccion(app, RES_ALEX_0930);
    expect((await corregirInasistencia(app, RES_ALEX_0930, clave)).statusCode).toBe(200);
    const repetida = await corregirInasistencia(app, RES_ALEX_0930, clave);
    expect(repetida.statusCode).toBe(200);
    expect(repetida.headers["idempotency-status"]).toBe("replayed");

    const historial = await historialDeOperaciones(app);
    expect(cuentaDe(historial, "NO_SHOW_CORRECTED")).toBe(1);
    await app.close();
  });
});

describe("step 18 · integración §2.8 — las cifras derivadas dicen lo mismo que el registro", () => {
  it("secuencia mezclada con repeticiones: count(RECORDED) − count(CORRECTED) = número de registros en «recorded»", async () => {
    const app = freshApp();
    await reset(app);
    await alFinalDeLaTarde(app);

    const citas = [RES_ALEX_0930, RES_DANI_1000, RES_DANI_1130, RES_NEREA_1230];
    for (const id of citas) {
      expect((await anotarInasistencia(app, id, await claveDeAnotacion(app, id))).statusCode, id).toBe(201);
    }
    // Dos repeticiones (el operador duda y vuelve a pulsar).
    for (const id of [RES_ALEX_0930, RES_DANI_1000]) {
      expect((await anotarInasistencia(app, id, await claveDeAnotacion(app, id))).statusCode, id).toBe(201);
    }
    // Dos correcciones (dos de las cuatro no eran inasistencias).
    for (const id of [RES_DANI_1000, RES_NEREA_1230]) {
      expect((await corregirInasistencia(app, id, await claveDeCorreccion(app, id))).statusCode, id).toBe(200);
    }
    // Y un intento de volver a anotar una ya corregida, con su clave `:v1`.
    expect((await anotarInasistencia(app, RES_DANI_1000, await claveDeAnotacion(app, RES_DANI_1000))).statusCode).toBe(409);

    const operations = await operationsOf(app);
    const historial = ((operations.audit as Json).items as Json[]);
    const registrados = cuentaDe(historial, "NO_SHOW_RECORDED");
    const corregidos = cuentaDe(historial, "NO_SHOW_CORRECTED");
    const enPie = ((operations.noShows as Json).records as Json[]).filter((r) => r.state === "recorded");

    expect(registrados).toBe(4);
    expect(corregidos).toBe(2);
    // LA IDENTIDAD: lo que el registro cuenta y lo que el mundo enseña.
    expect(registrados - corregidos).toBe(enPie.length);

    const metrics = operations.metrics as Json;
    expect(metrics.noShowsRecordedNow).toBe(enPie.length);
    expect(metrics.noShowsCorrected).toBe(corregidos);
    expect(metrics.noShowRecordCommands).toBe(registrados);
    expect(metrics.repeatedCommandsIgnored).toBe(2);
    // La línea que lee el operador NUNCA enseña una cifra sin la otra.
    expect(metrics.recordedAndCorrectedLine).toBe(
      `Inasistencias anotadas ahora mismo (sintéticas): ${String(enPie.length)} · Registros corregidos: ${String(corregidos)}`,
    );
    expect(metrics.homeLine).toBe(
      `Inasistencias anotadas hoy: ${String(enPie.length)} (registro manual, sin penalización).`,
    );

    // Y los invariantes calculados —no esperados— siguen en verde: el estado
    // vivo se reproduce desde el registro solo.
    expect(operations.integrity).toEqual({ ok: true, problems: [] });
    await app.close();
  });

  it("sin ninguna inasistencia en pie la línea de Inicio desaparece, pero la de las dos cifras sigue estando", async () => {
    const app = freshApp();
    await reset(app);
    await alFinalDeLaTarde(app);
    await anotarInasistencia(app, RES_ALEX_0930, await claveDeAnotacion(app, RES_ALEX_0930));
    await corregirInasistencia(app, RES_ALEX_0930, await claveDeCorreccion(app, RES_ALEX_0930));

    const metrics = (await operationsOf(app)).metrics as Json;
    expect(metrics.noShowsRecordedNow).toBe(0);
    expect(metrics.noShowsCorrected).toBe(1);
    expect(metrics.homeLine).toBeNull();
    expect(metrics.recordedAndCorrectedLine).toBe(
      "Inasistencias anotadas ahora mismo (sintéticas): 0 · Registros corregidos: 1",
    );
    await app.close();
  });
});
