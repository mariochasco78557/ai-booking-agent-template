import { expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";

/**
 * step 18 · fase H — el andamio COMPARTIDO de las pruebas de integración y
 * aceptación.
 *
 * Aquí no se prueba nada: se monta el servidor REAL con
 * `buildConsoleServer()` y se habla con él por `app.inject()`, exactamente
 * como hacen `tests/console/*.test.ts`. Lo que estas pruebas añaden sobre las
 * de fase C, E, F y G es el CRUCE: una función de step 18 contra una de
 * step 17, el reinicio contra los seis dominios a la vez, y la misma
 * secuencia contra tres arranques limpios.
 *
 * NADA de aquí toca `src/**`. Si una de estas pruebas falla, el defecto está
 * en producción y se informa; no se ablanda la aserción.
 */

export const TEST_SALT = "integracion-test-salt";

/** Los tres profesionales sintéticos del fixture de Demo Salon. */
export const ALEX = 3;
export const DANI = 6;
export const NEREA = 9;

/** Las citas del fixture que estas pruebas usan por su nombre. */
export const RES_ALEX_0930 = "demo-salon-res-1"; // Álex, 09:30–10:00
export const RES_ALEX_1300 = "demo-salon-res-2"; // Álex, 13:00–14:00 — la que libera el hueco de la lista de espera
export const RES_DANI_1000 = "demo-salon-res-3"; // Dani, 10:00–10:30
export const RES_DANI_1130 = "demo-salon-res-4"; // Dani, 11:30–12:00
export const RES_NEREA_1230 = "demo-salon-res-5"; // Nerea, 12:30–13:00

/** El hueco que libera cancelar `demo-salon-res-2`, y que wl-f01 recibe en oferta. */
export const HUECO_1300_ALEX = "slot-2026-08-04-780-3";
export const HUECO_1330_ALEX = "slot-2026-08-04-810-3";

export type Json = Record<string, unknown>;

export function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

export async function post(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  headers?: Record<string, string>,
) {
  return app.inject({
    method: "POST",
    url,
    payload: payload as never,
    ...(headers !== undefined ? { headers } : {}),
  });
}

export async function snapshotOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}

export async function operationsOf(app: FastifyInstance): Promise<Json> {
  return (await snapshotOf(app)).operations as Json;
}

export async function waitlistOf(app: FastifyInstance): Promise<Json> {
  return (await snapshotOf(app)).waitlist as Json;
}

/**
 * Quita `generatedAt` — la ÚNICA lectura de reloj de pared del entregable,
 * declarada como sello de presentación en `server.ts` — antes de cualquier
 * comparación estructural. Es exactamente lo que hace `stable()` en
 * `tests/console/console.test.ts`.
 */
export function sinSelloDePared(snapshot: Json): Json {
  const { generatedAt: _generatedAt, ...resto } = snapshot;
  return resto;
}

/** La instantánea completa, ya estable, serializada: la comparación BYTE A BYTE. */
export async function huellaCompleta(app: FastifyInstance): Promise<string> {
  return JSON.stringify(sinSelloDePared(await snapshotOf(app)));
}

/** La demo empieza siempre por un reinicio explícito, como el §10 de step 17. */
export async function reset(app: FastifyInstance): Promise<void> {
  const res = await post(app, "/api/reset", {});
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
}

// ---------------------------------------------------------------------
// Atajos por dominio
// ---------------------------------------------------------------------

export async function cancelar(app: FastifyInstance, reservationId: string, reasonCode = "unspecified") {
  return post(
    app,
    `/api/reservations/${reservationId}/cancel`,
    { reasonCode, confirmed: true },
    { "idempotency-key": `cancel:${reservationId}` },
  );
}

export async function comando(app: FastifyInstance, entryId: string, command: string, slotKey?: string) {
  return post(app, `/api/waitlist/entries/${entryId}/command`, {
    command,
    ...(slotKey !== undefined ? { slotKey } : {}),
  });
}

/**
 * (step 23, R2) El paso humano que faltaba: antes de simular ningún aviso,
 * una persona tiene que APROBAR la propuesta de ese hueco. No relaja nada —
 * añade el acto que el bucle humano exige— y falla ruidosamente si el servidor
 * no lo acepta, para que ningún guion se salte la aprobación sin enterarse.
 */
export async function aprobarPropuesta(app: FastifyInstance, entryId: string, slotKey: string) {
  const res = await comando(app, entryId, "approve_proposal", slotKey);
  expect(res.statusCode, `no se pudo aprobar la propuesta de ${entryId}: ${res.body}`).toBe(200);
  return res;
}

export async function convertir(app: FastifyInstance, entryId: string, slotKey: string, key?: string) {
  return post(
    app,
    `/api/waitlist/entries/${entryId}/convert`,
    { slotKey, confirmed: true },
    { "idempotency-key": key ?? `convert:${entryId}:${slotKey}` },
  );
}

export interface LineaDeGrupo {
  memberLabel: string;
  serviceId: 0 | 1 | 2;
  employeeId: number;
  startMinutes: number;
}

export async function proponerGrupo(
  app: FastifyInstance,
  arrangement: "consecutive" | "simultaneous",
  lines: readonly { memberLabel: string; serviceId: 0 | 1 | 2; professional: Json }[],
  date = BOOKING_DEMO_TODAY,
) {
  return post(app, "/api/booking/group/proposals", { date, arrangement, lines });
}

export async function crearGrupo(
  app: FastifyInstance,
  lines: readonly LineaDeGrupo[],
  key: string,
  options: { arrangement?: "consecutive" | "simultaneous"; injectFailure?: boolean; date?: string } = {},
) {
  return post(
    app,
    "/api/booking/groups",
    {
      arrangement: options.arrangement ?? "consecutive",
      date: options.date ?? BOOKING_DEMO_TODAY,
      lines,
      confirmed: true,
      ...(options.injectFailure !== undefined ? { injectFailure: options.injectFailure } : {}),
    },
    { "idempotency-key": key },
  );
}

export async function avanzarMinutos(app: FastifyInstance, minutes: number) {
  return post(app, "/api/lab/clock/advance", { command: "advance_minutes", minutes });
}

export async function avanzarHastaElFinalDe(app: FastifyInstance, reservationId: string) {
  return post(app, "/api/lab/clock/advance", { command: "advance_to_reservation_end", reservationId });
}

export async function anotarInasistencia(app: FastifyInstance, reservationId: string, key: string) {
  return post(app, `/api/reservations/${reservationId}/no-show`, { confirmed: true }, { "idempotency-key": key });
}

export async function corregirInasistencia(app: FastifyInstance, reservationId: string, key: string) {
  return post(
    app,
    `/api/reservations/${reservationId}/no-show/correction`,
    { confirmed: true },
    { "idempotency-key": key },
  );
}

export async function ejecutarEscenario(
  app: FastifyInstance,
  scenarioId: string,
  turn: Json,
) {
  return post(app, "/api/scenario/run", { scenarioId, turns: [turn] });
}

/**
 * La fila de la Agenda tal y como la pinta la consola. Trae, ya resueltas por
 * el servidor, las DOS claves de idempotencia que la interfaz acuñará
 * (`noShowKeyToMint`, `noShowFixKeyToMint`): leerlas de aquí es EL flujo real
 * del cliente, no una clave inventada por la prueba (diseño §2.7, decisión N3).
 */
export async function filaDeAgenda(app: FastifyInstance, reservationId: string): Promise<Json> {
  const snap = await snapshotOf(app);
  const fila = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === reservationId);
  expect(fila, `la agenda ya no trae ${reservationId}`).toBeDefined();
  return fila as Json;
}

export async function claveDeAnotacion(app: FastifyInstance, reservationId: string): Promise<string> {
  return String((await filaDeAgenda(app, reservationId)).noShowKeyToMint);
}

export async function claveDeCorreccion(app: FastifyInstance, reservationId: string): Promise<string> {
  return String((await filaDeAgenda(app, reservationId)).noShowFixKeyToMint);
}

export async function citasDe(app: FastifyInstance): Promise<{ agenda: Json[]; almacen: Json[] }> {
  const snap = await snapshotOf(app);
  return {
    agenda: (snap.calendar as Json).reservations as Json[],
    almacen: snap.reservations as Json[],
  };
}

export async function gruposDe(app: FastifyInstance): Promise<Json[]> {
  return ((await operationsOf(app)).groups as Json).items as Json[];
}

export async function historialDeOperaciones(app: FastifyInstance): Promise<Json[]> {
  return ((await operationsOf(app)).audit as Json).items as Json[];
}

export async function totalDeOperaciones(app: FastifyInstance): Promise<number> {
  return ((await operationsOf(app)).audit as Json).total as number;
}

export async function historialDeListaDeEspera(app: FastifyInstance): Promise<Json[]> {
  return ((await waitlistOf(app)).audit as Json).items as Json[];
}

export async function entradaDeListaDeEspera(app: FastifyInstance, entryId: string): Promise<Json> {
  const entrada = ((await waitlistOf(app)).entries as Json[]).find((e) => e.id === entryId);
  expect(entrada, `no existe la entrada ${entryId}`).toBeDefined();
  return entrada as Json;
}

export async function tareasHumanas(app: FastifyInstance): Promise<Json[]> {
  return ((await snapshotOf(app)).humanQueue as Json).tasks as Json[];
}

/**
 * TODO lo que un rechazo no puede haber tocado, en los DOS dominios a la vez:
 * las dos copias de las citas, los dos registros de auditoría, los grupos, las
 * inasistencias, las entradas de la lista de espera y la cola humana. Es la
 * huella que las pruebas de cruce comparan antes y después de un `409`.
 */
export async function huellaDelMundo(app: FastifyInstance): Promise<string> {
  const snap = await snapshotOf(app);
  const operations = snap.operations as Json;
  const waitlist = snap.waitlist as Json;
  return JSON.stringify({
    citasAgenda: (snap.calendar as Json).reservations,
    citasAlmacen: snap.reservations,
    operacionesAudit: operations.audit,
    grupos: operations.groups,
    inasistencias: operations.noShows,
    metricasOperaciones: operations.metrics,
    entradas: waitlist.entries,
    huecosLiberados: waitlist.releasedSlots,
    listaEsperaAudit: waitlist.audit,
    metricasListaEspera: waitlist.metrics,
    tareas: (snap.humanQueue as Json).tasks,
  });
}
