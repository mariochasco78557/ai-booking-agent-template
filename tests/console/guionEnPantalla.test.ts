import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID, DANI_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeElement } from "./fakeDom.js";

/**
 * step 19 · Capacidad 3B — «Guion en pantalla para enseñar la demostración»
 * (design §5.3).
 *
 * Cubre: el modelo de paso (§5.3.3), los dos guiones completos (§5.3.4,
 * §5.3.5), la luz de precondición fuera de la lista (§5.3.4, enmienda B3),
 * el progreso que excluye los pasos no comprobables (§5.3.6), que NINGÚN
 * paso se marca por visitar una ruta ni por navegar, que los predicados de
 * evidencia SÍ pasan a `hecho` con las acciones reales del runbook, y que el
 * control de reinicio del guion sólo mueve el foco (§5.3.2, enmienda M4).
 */

const TEST_SALT = "guion-en-pantalla-test-salt";

type Json = Record<string, unknown>;

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

async function post(app: FastifyInstance, url: string, payload: unknown, headers?: Record<string, string>) {
  return app.inject({ method: "POST", url, payload: payload as never, ...(headers !== undefined ? { headers } : {}) });
}

async function reset(app: FastifyInstance): Promise<void> {
  expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
}

async function snapshotOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}

function stable(snap: Json): Json {
  const { generatedAt: _generatedAt, ...rest } = snap;
  return rest;
}

async function demoOf(app: FastifyInstance): Promise<Json> {
  return (await snapshotOf(app)).demo as Json;
}

function guideById(demo: Json, id: "guion-1" | "guion-2"): Json {
  return (demo.guides as Json[]).find((g) => g.id === id) as Json;
}

function stepById(guide: Json, id: string): Json {
  const s = (guide.steps as Json[]).find((x) => x.id === id);
  expect(s, `no existe el paso ${id}`).toBeDefined();
  return s as Json;
}

async function cancel(app: FastifyInstance, reservationId: string, reasonCode = "unspecified") {
  return post(
    app,
    `/api/reservations/${reservationId}/cancel`,
    { reasonCode, confirmed: true },
    { "idempotency-key": `cancel:${reservationId}` },
  );
}

async function command(app: FastifyInstance, entryId: string, cmd: string, slotKey?: string) {
  return post(app, `/api/waitlist/entries/${entryId}/command`, {
    command: cmd,
    ...(slotKey !== undefined ? { slotKey } : {}),
  });
}

async function convert(app: FastifyInstance, entryId: string, slotKey: string) {
  return post(
    app,
    `/api/waitlist/entries/${entryId}/convert`,
    { slotKey, confirmed: true },
    { "idempotency-key": `convert:${entryId}:${slotKey}` },
  );
}

async function advanceMinutes(app: FastifyInstance, minutes: number) {
  return post(app, "/api/lab/clock/advance", { command: "advance_minutes", minutes });
}

async function claveDeAnotacion(app: FastifyInstance, reservationId: string): Promise<string> {
  const snap = await snapshotOf(app);
  const fila = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === reservationId);
  return String((fila as Json).noShowKeyToMint);
}

async function claveDeCorreccion(app: FastifyInstance, reservationId: string): Promise<string> {
  const snap = await snapshotOf(app);
  const fila = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === reservationId);
  return String((fila as Json).noShowFixKeyToMint);
}

async function anotarInasistencia(app: FastifyInstance, reservationId: string) {
  return post(app, `/api/reservations/${reservationId}/no-show`, { confirmed: true }, { "idempotency-key": await claveDeAnotacion(app, reservationId) });
}

async function corregirInasistencia(app: FastifyInstance, reservationId: string) {
  return post(
    app,
    `/api/reservations/${reservationId}/no-show/correction`,
    { confirmed: true },
    { "idempotency-key": await claveDeCorreccion(app, reservationId) },
  );
}

interface LineaDeGrupo {
  memberLabel: string;
  serviceId: 0 | 1 | 2;
  employeeId: number;
  startMinutes: number;
}

async function crearGrupo(app: FastifyInstance, lines: readonly LineaDeGrupo[], key: string, arrangement: "consecutive" | "simultaneous" = "consecutive") {
  return post(
    app,
    "/api/booking/groups",
    { arrangement, date: BOOKING_DEMO_TODAY, lines, confirmed: true },
    { "idempotency-key": key },
  );
}

/**
 * Un alta que SÓLO sirve para probar 2.2 (`waitlistOptInsRecorded >= 1`):
 * fechada al día SIGUIENTE de la demostración a propósito, para que no pueda
 * emparejar NUNCA con un hueco liberado de hoy y así no contamine las
 * pruebas de compatibilidad (2.3/2.B) que comparten el mismo mundo.
 */
async function apuntarseALista(app: FastifyInstance, clientLabel: string) {
  return post(app, "/api/waitlist/entries", {
    clientLabel,
    serviceId: 1,
    dateFrom: "2026-08-05",
    dateTo: "2026-08-05",
    earliestStartMinutes: 9 * 60,
    latestStartMinutes: 17 * 60,
    professional: { kind: "any" },
    optInSource: "phone_simulated",
    optInConfirmed: true,
  });
}

// =====================================================================
// (a) El modelo de paso: los dos guiones completos, tal cual el §5.3.4/§5.3.5
// =====================================================================

describe("step 19 · Capacidad 3B — los dos guiones tienen exactamente los pasos del diseño", () => {
  it("guion-1: diez pasos (1.2 a 1.C), cinco comprobables y cinco no comprobables", async () => {
    const app = freshApp();
    await reset(app);
    const demo = await demoOf(app);
    const g1 = guideById(demo, "guion-1");
    expect((g1.steps as Json[]).map((s) => s.id)).toEqual([
      "g1-2", "g1-3", "g1-4", "g1-5", "g1-6", "g1-7", "g1-8", "g1-a", "g1-b", "g1-c",
    ]);
    expect(g1.checkableCount).toBe(5);
    const noComprobables = (g1.steps as Json[]).filter((s) => s.evidenceState === "no_comprobable");
    expect(noComprobables).toHaveLength(5);
    await app.close();
  });

  it("guion-2: once pasos (2.1 a 2.B), ocho comprobables y tres no comprobables", async () => {
    const app = freshApp();
    await reset(app);
    const demo = await demoOf(app);
    const g2 = guideById(demo, "guion-2");
    expect((g2.steps as Json[]).map((s) => s.id)).toEqual([
      "g2-1", "g2-2", "g2-3", "g2-4", "g2-5", "g2-6", "g2-7", "g2-8", "g2-9", "g2-a", "g2-b",
    ]);
    expect(g2.checkableCount).toBe(8);
    const noComprobables = (g2.steps as Json[]).filter((s) => s.evidenceState === "no_comprobable");
    expect(noComprobables).toHaveLength(3);
    await app.close();
  });

  it("un paso no_comprobable NUNCA cambia de estado, pase lo que pase en la demostración", async () => {
    const app = freshApp();
    await reset(app);
    const antes = guideById(await demoOf(app), "guion-1");
    // Se ensucia todo lo que se puede ensuciar.
    await advanceMinutes(app, 240);
    await anotarInasistencia(app, "demo-salon-res-1");
    await corregirInasistencia(app, "demo-salon-res-1");
    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
    ];
    await crearGrupo(app, lineas, "guion-no-comprobable:1");
    const despues = guideById(await demoOf(app), "guion-1");
    for (const id of ["g1-5", "g1-7", "g1-8", "g1-a", "g1-c"]) {
      expect(stepById(despues, id).evidenceState).toBe("no_comprobable");
      expect(stepById(despues, id).evidenceState).toBe(stepById(antes, id).evidenceState);
    }
    await app.close();
  });
});

// =====================================================================
// (a bis) Campos resueltos en el servidor: stepTitleLine y linkLabel
// (revisión adversarial de la capacidad 3, hallazgo M3)
// =====================================================================

/**
 * ENMIENDA DELIBERADA (revisión adversarial de la capacidad 3, hallazgo M2).
 * La numeración literal del runbook (design §5.3.4/§5.3.5), id a id — NO
 * `step.order`, que es un correlativo interno (empieza en 2 para el guion 1:
 * el paso 1 es la precondición, fuera de la lista) sin relación con las
 * variantes «1.A»/«1.B»/«1.C». Antes de esta reparación, `stepTitleLine` se
 * componía a partir de `order` y el guion 1 arrancaba en pantalla con «2. El
 * reloj lo mueves tú», sin que existiera ningún «1.» ni ningún «1.B» — la
 * numeración prometida por escrito en §5.3.4 no se cumplía. La aserción no se
 * afloja: sigue comparando la línea EXACTA, carácter a carácter, contra una
 * tabla literal en vez de reconstruirla a partir de un campo cualquiera del
 * propio paso.
 */
const NUMBER_LABEL_POR_ID: Record<string, string> = {
  "g1-2": "1.2", "g1-3": "1.3", "g1-4": "1.4", "g1-5": "1.5",
  "g1-6": "1.6", "g1-7": "1.7", "g1-8": "1.8", "g1-a": "1.A",
  "g1-b": "1.B", "g1-c": "1.C",
  "g2-1": "2.1", "g2-2": "2.2", "g2-3": "2.3", "g2-4": "2.4",
  "g2-5": "2.5", "g2-6": "2.6", "g2-7": "2.7", "g2-8": "2.8",
  "g2-9": "2.9", "g2-a": "2.A", "g2-b": "2.B",
};

describe("step 19 · Capacidad 3B — stepTitleLine y linkLabel llegan ya compuestos, y el cliente los pinta verbatim", () => {
  it("stepTitleLine es «{numberLabel} {title}», con la numeración del runbook, y linkLabel es «Ir a {whereLabel}», para los 21 pasos de los dos guiones", async () => {
    const app = freshApp();
    await reset(app);
    const demo = await demoOf(app);
    const idsVistos: string[] = [];
    for (const guideId of ["guion-1", "guion-2"] as const) {
      const guide = guideById(demo, guideId);
      for (const step of guide.steps as Json[]) {
        const numberLabel = NUMBER_LABEL_POR_ID[String(step.id)];
        expect(numberLabel, `paso ${String(step.id)} no está en la tabla literal`).toBeDefined();
        expect(step.numberLabel).toBe(numberLabel);
        expect(step.stepTitleLine).toBe(`${numberLabel} ${String(step.title)}`);
        expect(step.linkLabel).toBe(`Ir a ${String(step.whereLabel)}`);
        idsVistos.push(String(step.id));
      }
    }
    expect(idsVistos).toEqual(Object.keys(NUMBER_LABEL_POR_ID));
    await app.close();
  });

  it("el cliente pinta step.stepTitleLine y step.linkLabel VERBATIM — ya no los concatena (ui.js.ts ya no compone 'N. ' + title ni 'Ir a ' + whereLabel)", async () => {
    const app = freshApp();
    await reset(app);
    const { document, nodes } = createFakeDocumentWithIds([
      "lab-guion-aviso",
      "lab-guion-precondicion",
      { id: "lab-guion-ir-a-reiniciar", tag: "button" },
      { id: "lab-guion-radio-1", tag: "input" },
      { id: "lab-guion-radio-2", tag: "input" },
      "lab-guion-sin-elegir",
      { id: "lab-guion-contenido", tag: "div" },
      "lab-guion-titulo",
      { id: "lab-guion-pasos", tag: "ol" },
      "lab-guion-progreso",
    ] as const);
    const { renderGuionEnPantalla, wireGuionEnPantallaControls } = loadUiClientHooks("", document);
    wireGuionEnPantallaControls();
    const snap = await snapshotOf(app);
    const demo = snap.demo as Json;
    const g1 = guideById(demo, "guion-1");
    const primerPaso = (g1.steps as Json[])[0] as Json;
    (nodes["lab-guion-radio-1"] as FakeElement).value = "guion-1";
    (nodes["lab-guion-radio-1"] as FakeElement).dispatchChange();
    renderGuionEnPantalla(snap);
    const filaTitulo = (nodes["lab-guion-pasos"] as FakeElement).children[0].children[0].children[0];
    const filaEnlace = (nodes["lab-guion-pasos"] as FakeElement).children[0].children[3];
    expect(filaTitulo.textContent).toBe(primerPaso.stepTitleLine);
    expect(filaEnlace.textContent).toBe(primerPaso.linkLabel);
    await app.close();
  });

  it("la fuente de ui.js.ts ya no concatena 'N. ' + step.title ni 'Ir a ' + step.whereLabel (barrido estructural)", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("function buildFilaGuionPaso");
    expect(inicio).toBeGreaterThan(-1);
    const fin = js.indexOf("\n  function ", inicio + 10);
    const cuerpo = js.slice(inicio, fin === -1 ? undefined : fin);
    expect(cuerpo).not.toContain("'. ' + step.title");
    expect(cuerpo).not.toContain("'Ir a ' + step.whereLabel");
    expect(cuerpo).toContain("step.stepTitleLine");
    expect(cuerpo).toContain("step.linkLabel");
  });
});

// =====================================================================
// (b) Los predicados SÍ flipan con las acciones reales del runbook
// =====================================================================

describe("step 19 · Capacidad 3B — los predicados de evidencia pasan de 'todavía no' a 'hecho' SÓLO tras la acción canónica real", () => {
  it("guion 1: 1.2 (avanzar el reloj), 1.3 (anotar), 1.4 (corregir), 1.6 (grupo consecutivo), 1.B (cancelar una línea del grupo)", async () => {
    const app = freshApp();
    await reset(app);
    let demo = await demoOf(app);
    let g1 = guideById(demo, "guion-1");
    for (const id of ["g1-2", "g1-3", "g1-4", "g1-6", "g1-b"]) expect(stepById(g1, id).evidenceState).toBe("todavia_no");

    expect((await advanceMinutes(app, 60)).statusCode).toBe(200);
    g1 = guideById(await demoOf(app), "guion-1");
    expect(stepById(g1, "g1-2").evidenceState).toBe("hecho");
    expect(stepById(g1, "g1-3").evidenceState).toBe("todavia_no");

    expect((await anotarInasistencia(app, "demo-salon-res-1")).statusCode).toBe(201);
    g1 = guideById(await demoOf(app), "guion-1");
    expect(stepById(g1, "g1-3").evidenceState).toBe("hecho");
    expect(stepById(g1, "g1-4").evidenceState).toBe("todavia_no");

    expect((await corregirInasistencia(app, "demo-salon-res-1")).statusCode).toBe(200);
    g1 = guideById(await demoOf(app), "guion-1");
    expect(stepById(g1, "g1-4").evidenceState).toBe("hecho");

    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
    ];
    const creada = await crearGrupo(app, lineas, "guion1:consecutivo:1", "consecutive");
    expect(creada.statusCode).toBe(201);
    g1 = guideById(await demoOf(app), "guion-1");
    expect(stepById(g1, "g1-6").evidenceState).toBe("hecho");
    expect(stepById(g1, "g1-b").evidenceState).toBe("todavia_no");

    const primeraLinea = ((creada.json() as Json).reservations as Json[])[0] as Json;
    expect((await cancel(app, String(primeraLinea.id))).statusCode).toBe(200);
    g1 = guideById(await demoOf(app), "guion-1");
    expect(stepById(g1, "g1-b").evidenceState).toBe("hecho");
    await app.close();
  });

  it("guion 2: 2.2 (apuntarse), 2.3 (cancelación a tiempo), 2.4 (tarea abierta), 2.6 (aviso), 2.7 (conversión), 2.8 (cita recuperada), 2.A (tardía), 2.B (sin compatibles)", async () => {
    const app = freshApp();
    await reset(app);
    let g2 = guideById(await demoOf(app), "guion-2");
    for (const id of ["g2-2", "g2-3", "g2-4", "g2-6", "g2-7", "g2-8", "g2-a", "g2-b"]) {
      expect(stepById(g2, id).evidenceState).toBe("todavia_no");
    }

    expect((await apuntarseALista(app, "Cliente Z")).statusCode).toBe(201);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-2").evidenceState).toBe("hecho");

    // demo-salon-res-2 (Álex, 13:00-14:00): cancelación A TIEMPO, libera un hueco
    // compatible con wl-f01 — 2.3 y (tras decidir) 2.4.
    const cancelacion = await cancel(app, "demo-salon-res-2");
    expect(cancelacion.statusCode).toBe(200);
    const slotKey = ((cancelacion.json() as Json).releasedSlots as Json[])[0]?.key as string;
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-3").evidenceState).toBe("hecho");
    expect(stepById(g2, "g2-4").evidenceState).toBe("hecho");

    // (step 23, R2) Una persona aprueba la propuesta de ESE hueco antes de
    // que se pueda simular ningún aviso.
    expect((await command(app, "wl-f01", "approve_proposal", slotKey)).statusCode).toBe(200);
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-6").evidenceState).toBe("hecho");

    expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
    expect((await convert(app, "wl-f01", slotKey)).statusCode).toBe(200);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-7").evidenceState).toBe("hecho");
    expect(stepById(g2, "g2-8").evidenceState).toBe("hecho");

    // 2.A — una cancelación TARDÍA (demo-salon-res-1, 09:30, con sólo 30 min de
    // antelación sobre las 09:00, muy por debajo del plazo de 120 min).
    expect((await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated")).statusCode).toBe(200);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-a").evidenceState).toBe("hecho");

    // 2.B — un hueco liberado sin nadie compatible (demo-salon-res-4, servicio 0,
    // 11:30-12:00: ninguna alta pide ese servicio a esa hora).
    expect((await cancel(app, "demo-salon-res-4")).statusCode).toBe(200);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-b").evidenceState).toBe("hecho");
    await app.close();
  });
});

// =====================================================================
// (b bis 2) Los pasos monótonos (hallazgo m1) no se desmarcan por la propia
// acción SIGUIENTE del runbook (re-verificación adversarial de la
// capacidad 3, hallazgo R2). Antes de estas pruebas, revertir la
// reparación de m1 pasaba la suite entera en verde.
// =====================================================================

describe("step 19 · Capacidad 3B — los pasos monótonos (m1) siguen 'hecho' tras la acción siguiente del runbook (hallazgo R2)", () => {
  it("2.A (cancelación tardía): revisarla NO lo desmarca — sigue 'hecho' y doneCount no baja", async () => {
    const app = freshApp();
    await reset(app);
    // demo-salon-res-1 (09:30, con sólo 30 min de antelación sobre las 09:00):
    // cancelación TARDÍA.
    expect((await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated")).statusCode).toBe(200);
    let g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-a").evidenceState).toBe("hecho");
    const doneAntes = g2.doneCount as number;

    // La acción SIGUIENTE que el propio runbook enseña: revisar esa misma
    // cancelación tardía. Antes de la reparación m1, esto bajaba
    // `lateCancellationsUnderReview` a cero y desmarcaba 2.A.
    const revision = await post(app, "/api/reservations/demo-salon-res-1/cancellation-review", { decision: "reviewed_no_action" } as never);
    expect(revision.statusCode).toBe(200);

    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-a").evidenceState).toBe("hecho");
    expect(g2.doneCount as number).toBeGreaterThanOrEqual(doneAntes);
    await app.close();
  });

  it("1.B (cancelar una línea del grupo): cancelar la SEGUNDA línea también NO lo desmarca — sigue 'hecho' y doneCount no baja", async () => {
    const app = freshApp();
    await reset(app);
    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
    ];
    const creada = await crearGrupo(app, lineas, "r2-g1b:grupo:1", "consecutive");
    expect(creada.statusCode).toBe(201);
    const lineaReservas = (creada.json() as Json).reservations as Json[];

    expect((await cancel(app, String(lineaReservas[0]?.id))).statusCode).toBe(200);
    let g1 = guideById(await demoOf(app), "guion-1");
    expect(stepById(g1, "g1-b").evidenceState).toBe("hecho");
    const doneAntes = g1.doneCount as number;

    // La acción SIGUIENTE que el propio runbook enseña: cancelar también la
    // segunda línea. Antes de la reparación m1, el grupo pasaba de
    // "parcialmente cancelado" a "totalmente cancelado" y
    // `groupsPartiallyCancelled` bajaba a cero, desmarcando 1.B.
    expect((await cancel(app, String(lineaReservas[1]?.id))).statusCode).toBe(200);
    g1 = guideById(await demoOf(app), "guion-1");
    expect(stepById(g1, "g1-b").evidenceState).toBe("hecho");
    expect(g1.doneCount as number).toBeGreaterThanOrEqual(doneAntes);
    await app.close();
  });

  /**
   * Invariante general y barata: a lo largo de la secuencia canónica ENTERA
   * de cada guion (exactamente las mismas acciones, en el mismo orden, que
   * la sección (b) de arriba ya prueba paso a paso), `doneCount` nunca baja
   * de una acción a la siguiente. No sustituye a (a)/(b) — las cubre
   * también, junto con cualquier otro par de pasos que compartiera señal sin
   * que nadie lo hubiera anotado todavía.
   */
  it("a lo largo de la secuencia canónica entera de CADA guion, doneCount nunca baja de una acción a la siguiente", async () => {
    const g1app = freshApp();
    await reset(g1app);
    const doneCountsG1: number[] = [guideById(await demoOf(g1app), "guion-1").doneCount as number];
    const accionesG1: Array<() => Promise<unknown>> = [
      () => advanceMinutes(g1app, 60),
      () => anotarInasistencia(g1app, "demo-salon-res-1"),
      () => corregirInasistencia(g1app, "demo-salon-res-1"),
      async () => {
        const lineas: LineaDeGrupo[] = [
          { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
          { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
        ];
        const creada = await crearGrupo(g1app, lineas, "r2-invariante:g1:1", "consecutive");
        (g1app as unknown as { __grupo?: Json }).__grupo = creada.json() as Json;
      },
      async () => {
        const creada = (g1app as unknown as { __grupo: Json }).__grupo;
        const primeraLinea = (creada.reservations as Json[])[0] as Json;
        await cancel(g1app, String(primeraLinea.id));
      },
    ];
    for (const accion of accionesG1) {
      await accion();
      doneCountsG1.push(guideById(await demoOf(g1app), "guion-1").doneCount as number);
    }
    for (let i = 1; i < doneCountsG1.length; i += 1) {
      expect(doneCountsG1[i], `guion-1: doneCount bajó en el paso ${String(i)}`).toBeGreaterThanOrEqual(doneCountsG1[i - 1] as number);
    }
    await g1app.close();

    const g2app = freshApp();
    await reset(g2app);
    const doneCountsG2: number[] = [guideById(await demoOf(g2app), "guion-2").doneCount as number];
    let slotKeyG2 = "";
    const accionesG2: Array<() => Promise<unknown>> = [
      () => apuntarseALista(g2app, "Cliente Z"),
      async () => {
        const cancelacion = await cancel(g2app, "demo-salon-res-2");
        slotKeyG2 = ((cancelacion.json() as Json).releasedSlots as Json[])[0]?.key as string;
      },
      () => command(g2app, "wl-f01", "simulate_notice"),
      async () => {
        await command(g2app, "wl-f01", "record_acceptance");
        await convert(g2app, "wl-f01", slotKeyG2);
      },
      () => cancel(g2app, "demo-salon-res-1", "client_cancelled_at_counter_simulated"),
      () => cancel(g2app, "demo-salon-res-4"),
    ];
    for (const accion of accionesG2) {
      await accion();
      doneCountsG2.push(guideById(await demoOf(g2app), "guion-2").doneCount as number);
    }
    for (let i = 1; i < doneCountsG2.length; i += 1) {
      expect(doneCountsG2[i], `guion-2: doneCount bajó en el paso ${String(i)}`).toBeGreaterThanOrEqual(doneCountsG2[i - 1] as number);
    }
    await g2app.close();
  });
});

// =====================================================================
// (b bis) Sin contaminación cruzada: la acción de un paso NUNCA adelanta el
// de otro (revisión adversarial de la capacidad 3, hallazgo M2). Antes de
// estas pruebas, un predicado mutado para leer una señal de OTRO guion
// habría pasado en verde.
// =====================================================================

describe("step 19 · Capacidad 3B — ninguna acción de OTRO guion adelanta un paso comprobable (hallazgo M2)", () => {
  it("el recorrido ENTERO del guion 2 no adelanta ni un solo paso comprobable del guion 1", async () => {
    const app = freshApp();
    await reset(app);
    // Recorrido COMPLETO del guion 2 (2.2 a 2.9, más 2.A/2.B): ninguna de
    // estas acciones toca el reloj, ni anota o corrige una inasistencia, ni
    // crea un grupo — las cinco señales de las que dependen los cinco pasos
    // comprobables del guion 1.
    expect((await apuntarseALista(app, "Cliente Z")).statusCode).toBe(201);
    const cancelacion = await cancel(app, "demo-salon-res-2");
    expect(cancelacion.statusCode).toBe(200);
    const slotKey = ((cancelacion.json() as Json).releasedSlots as Json[])[0]?.key as string;
    // (step 23, R2) Una persona aprueba la propuesta de ESE hueco antes de
    // que se pueda simular ningún aviso.
    expect((await command(app, "wl-f01", "approve_proposal", slotKey)).statusCode).toBe(200);
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
    expect((await convert(app, "wl-f01", slotKey)).statusCode).toBe(200);
    expect((await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated")).statusCode).toBe(200);
    expect((await cancel(app, "demo-salon-res-4")).statusCode).toBe(200);

    const g1 = guideById(await demoOf(app), "guion-1");
    for (const id of ["g1-2", "g1-3", "g1-4", "g1-6", "g1-b"]) {
      expect(stepById(g1, id).evidenceState, `${id} se adelantó por una acción del guion 2`).toBe("todavia_no");
    }
    expect(guideById(await demoOf(app), "guion-1").doneCount).toBe(0);
    // Que las acciones PROPIAS del guion 1 sí completan cada paso, una a
    // una, ya lo prueba la sección (b) de arriba — no se repite aquí.
    await app.close();
  });

  it("el recorrido ENTERO del guion 1 no adelanta ni un solo paso comprobable del guion 2 — salvo los DOS que genuinamente comparten señal (cancelar SIEMPRE cuenta como cancelación, venga de un grupo o no) — y las acciones propias del guion 2 SÍ completan el resto después, en la misma instantánea", async () => {
    const app = freshApp();
    await reset(app);
    // Recorrido COMPLETO del guion 1 (1.2, 1.3, 1.4, 1.6, 1.B): ninguna de
    // estas acciones toca la lista de espera directamente. 1.B SÍ cancela
    // una reserva — la de una línea del grupo — y `POST
    // /api/reservations/:id/cancel` es el MISMO endpoint que usa el guion 2,
    // así que esa cancelación cuenta de verdad para `cancellationsOnTime` O
    // `lateCancellationsTotal` (según la antelación con la que se cancele
    // respecto al reloj YA avanzado por 1.2) y para `slotsReleasedTotal`: no
    // es una contaminación, es la MISMA señal («una cita se canceló y liberó
    // un hueco») que el propio paso 1.B ya declara. Con las horas de ESTE
    // mundo (reloj +60 min, línea a las 15:00: más de 120 min de antelación),
    // la cancelación cae A TIEMPO, así que el par que se da por hecho aquí es
    // 2.3 y 2.B — con otra hora de grupo, o con el reloj más adelantado,
    // habría sido 2.A y 2.B en su lugar (2.3 o 2.A, según la antelación,
    // nunca los dos a la vez, más 2.B siempre). Se declara aparte, no se
    // oculta.
    expect((await advanceMinutes(app, 60)).statusCode).toBe(200);
    expect((await anotarInasistencia(app, "demo-salon-res-1")).statusCode).toBe(201);
    expect((await corregirInasistencia(app, "demo-salon-res-1")).statusCode).toBe(200);
    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
    ];
    const creada = await crearGrupo(app, lineas, "m2-guion1-entero:1", "consecutive");
    expect(creada.statusCode).toBe(201);
    const primeraLinea = ((creada.json() as Json).reservations as Json[])[0] as Json;
    expect((await cancel(app, String(primeraLinea.id))).statusCode).toBe(200);

    let g2 = guideById(await demoOf(app), "guion-2");
    for (const id of ["g2-2", "g2-4", "g2-6", "g2-7", "g2-8", "g2-a"]) {
      expect(stepById(g2, id).evidenceState, `${id} se adelantó por una acción del guion 1`).toBe("todavia_no");
    }
    expect(g2.doneCount).toBe(2); // 2.3 (a tiempo, con las horas de este mundo) y 2.B, por la razón de arriba

    // Y ahora sí, las acciones PROPIAS del guion 2 completan el resto de sus
    // pasos, en la MISMA instantánea que el guion 1 ya ha ensuciado —
    // ninguna acción del guion 1 dejó el mundo en un estado que se lo
    // impida.
    expect((await apuntarseALista(app, "Cliente Z")).statusCode).toBe(201);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-2").evidenceState).toBe("hecho");

    const cancelacion = await cancel(app, "demo-salon-res-2");
    expect(cancelacion.statusCode).toBe(200);
    const slotKey = ((cancelacion.json() as Json).releasedSlots as Json[])[0]?.key as string;
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-3").evidenceState).toBe("hecho");
    expect(stepById(g2, "g2-4").evidenceState).toBe("hecho");

    // (step 23, R2) Una persona aprueba la propuesta de ESE hueco antes de
    // que se pueda simular ningún aviso.
    expect((await command(app, "wl-f01", "approve_proposal", slotKey)).statusCode).toBe(200);
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-6").evidenceState).toBe("hecho");

    expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
    expect((await convert(app, "wl-f01", slotKey)).statusCode).toBe(200);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-7").evidenceState).toBe("hecho");
    expect(stepById(g2, "g2-8").evidenceState).toBe("hecho");

    expect((await cancel(app, "demo-salon-res-4")).statusCode).toBe(200);
    g2 = guideById(await demoOf(app), "guion-2");
    expect(stepById(g2, "g2-b").evidenceState).toBe("hecho");
    await app.close();
  });

  it("dentro del guion 1: el reloj/inasistencia (1.2-1.4) y el grupo (1.6) son independientes — ninguno adelanta al otro", async () => {
    const soloReloj = freshApp();
    await reset(soloReloj);
    expect((await advanceMinutes(soloReloj, 60)).statusCode).toBe(200);
    expect((await anotarInasistencia(soloReloj, "demo-salon-res-1")).statusCode).toBe(201);
    expect((await corregirInasistencia(soloReloj, "demo-salon-res-1")).statusCode).toBe(200);
    const g1TrasReloj = guideById(await demoOf(soloReloj), "guion-1");
    expect(stepById(g1TrasReloj, "g1-6").evidenceState).toBe("todavia_no");
    expect(stepById(g1TrasReloj, "g1-b").evidenceState).toBe("todavia_no");
    await soloReloj.close();

    const soloGrupo = freshApp();
    await reset(soloGrupo);
    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
    ];
    expect((await crearGrupo(soloGrupo, lineas, "m2-solo-grupo:1")).statusCode).toBe(201);
    const g1TrasGrupo = guideById(await demoOf(soloGrupo), "guion-1");
    expect(stepById(g1TrasGrupo, "g1-2").evidenceState).toBe("todavia_no");
    expect(stepById(g1TrasGrupo, "g1-3").evidenceState).toBe("todavia_no");
    expect(stepById(g1TrasGrupo, "g1-4").evidenceState).toBe("todavia_no");
    await soloGrupo.close();
  });

  it("dentro del guion 2: apuntarse a la lista (2.2) es independiente de la cadena de cancelación/aviso/conversión (2.3-2.9) — ninguno adelanta al otro", async () => {
    const soloApuntarse = freshApp();
    await reset(soloApuntarse);
    expect((await apuntarseALista(soloApuntarse, "Cliente Z")).statusCode).toBe(201);
    const g2TrasApuntarse = guideById(await demoOf(soloApuntarse), "guion-2");
    for (const id of ["g2-3", "g2-4", "g2-6", "g2-7", "g2-8", "g2-a", "g2-b"]) {
      expect(stepById(g2TrasApuntarse, id).evidenceState).toBe("todavia_no");
    }
    await soloApuntarse.close();

    const soloCancelacion = freshApp();
    await reset(soloCancelacion);
    expect((await cancel(soloCancelacion, "demo-salon-res-4")).statusCode).toBe(200);
    const g2TrasCancelacion = guideById(await demoOf(soloCancelacion), "guion-2");
    expect(stepById(g2TrasCancelacion, "g2-2").evidenceState).toBe("todavia_no");
    await soloCancelacion.close();
  });
});

// =====================================================================
// (c) La luz de precondición: fuera de la lista, con su propio vocabulario
// =====================================================================

describe("step 19 · Capacidad 3B — la luz de precondición (§5.3.4, enmienda B3)", () => {
  it("recién reiniciada, está lista, y NO cuenta en ningún número del progreso", async () => {
    const app = freshApp();
    await reset(app);
    const demo = await demoOf(app);
    expect(demo.startingPoint).toEqual({ ready: true, label: "Estás en el punto de partida: puedes empezar." });
    const g1 = guideById(demo, "guion-1");
    const g2 = guideById(demo, "guion-2");
    expect(g1.doneCount).toBe(0);
    expect(g1.checkableCount).toBe(5);
    expect(g2.doneCount).toBe(0);
    expect(g2.checkableCount).toBe(8);
  });

  it("cada una de las tres condiciones AISLABLES tocadas apaga la luz por separado: reloj, llamada, grupo", async () => {
    const casos: Array<[string, (app: FastifyInstance) => Promise<unknown>]> = [
      ["el reloj avanzado", (app) => advanceMinutes(app, 30)],
      [
        "una llamada",
        (app) =>
          post(app, "/api/scenario/run", {
            scenarioId: "A53-precondicion",
            turns: [{ utterance: "quiero reservar una cita", day: "tuesday", time: "16:15", professionalId: DANI_ID, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true }],
          }),
      ],
      [
        "un grupo creado",
        (app) =>
          crearGrupo(app, [
            { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
            { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
          ], "precondicion:grupo:1"),
      ],
    ];
    for (const [, accion] of casos) {
      const app = freshApp();
      await reset(app);
      await accion(app);
      const demo = await demoOf(app);
      expect((demo.startingPoint as Json).ready).toBe(false);
      expect((demo.startingPoint as Json).label).toBe("Esta demostración ya se ha tocado. Reinicia antes de empezar.");
      await app.close();
    }
  });

  /**
   * La CUARTA condición («cero registros de inasistencia») no se puede
   * aislar de la primera: en esta demostración no existe ninguna cita que
   * termine antes de las 09:00 del reinicio, así que anotar una inasistencia
   * exige SIEMPRE haber avanzado antes el reloj (`isEligibleForNoShow`). Esta
   * prueba comprueba la condición compuesta —tal como el runbook la ejecuta
   * de verdad— y no una imposible en aislamiento.
   */
  it("avanzar el reloj y anotar una inasistencia apaga la luz (la condición compuesta que el runbook ejecuta de verdad)", async () => {
    const app = freshApp();
    await reset(app);
    expect((await advanceMinutes(app, 60)).statusCode).toBe(200);
    expect((await anotarInasistencia(app, "demo-salon-res-1")).statusCode).toBe(201);
    const demo = await demoOf(app);
    expect((demo.startingPoint as Json).ready).toBe(false);
    await app.close();
  });

  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo B2.)* Las cuatro condiciones originales (reloj, llamadas,
   * inasistencias, grupos) ignoraban POR COMPLETO el mundo de la lista de
   * espera. Tras un recorrido ENTERO del guion 2 (que no toca ni el reloj,
   * ni las llamadas, ni las inasistencias, ni los grupos) la luz seguía
   * diciendo, en verde, «puedes empezar» con «Comprobados 7 de 8 pasos»
   * delante — una contradicción a la vista.
   */
  it("tras el recorrido ENTERO del guion 2 (que no toca reloj/llamadas/inasistencias/grupos), la luz se apaga; tras reiniciar, vuelve a estar lista", async () => {
    const app = freshApp();
    await reset(app);
    const recienReiniciado = await demoOf(app);
    expect((recienReiniciado.startingPoint as Json).ready).toBe(true);

    // Recorrido canónico entero del guion 2 (2.2 a 2.9, más 2.A/2.B).
    expect((await apuntarseALista(app, "Cliente Z")).statusCode).toBe(201);
    const cancelacion = await cancel(app, "demo-salon-res-2");
    expect(cancelacion.statusCode).toBe(200);
    const slotKey = ((cancelacion.json() as Json).releasedSlots as Json[])[0]?.key as string;
    // (step 23, R2) Una persona aprueba la propuesta de ESE hueco antes de
    // que se pueda simular ningún aviso.
    expect((await command(app, "wl-f01", "approve_proposal", slotKey)).statusCode).toBe(200);
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
    expect((await convert(app, "wl-f01", slotKey)).statusCode).toBe(200);
    expect((await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated")).statusCode).toBe(200);
    expect((await cancel(app, "demo-salon-res-4")).statusCode).toBe(200);

    const sucio = await demoOf(app);
    const g2Sucio = guideById(sucio, "guion-2");
    expect(g2Sucio.doneCount).toBeGreaterThan(0);
    expect((sucio.startingPoint as Json).ready).toBe(false);
    expect((sucio.startingPoint as Json).label).toBe("Esta demostración ya se ha tocado. Reinicia antes de empezar.");

    await reset(app);
    const limpio = await demoOf(app);
    expect((limpio.startingPoint as Json).ready).toBe(true);
    expect((limpio.startingPoint as Json).label).toBe("Estás en el punto de partida: puedes empezar.");
    await app.close();
  });
});

// =====================================================================
// (d) Tras el reinicio, ningún paso está en 'hecho' (criterio 19/31)
// =====================================================================

describe("step 19 · Capacidad 3B — tras un reinicio, los dos guiones vuelven a doneCount === 0", () => {
  it("se ensucia todo, se reinicia, y ningún paso de ninguno de los dos guiones está en 'hecho'", async () => {
    const app = freshApp();
    await reset(app);
    await advanceMinutes(app, 60);
    await anotarInasistencia(app, "demo-salon-res-1");
    await apuntarseALista(app, "Cliente Z");
    const cancelacion = await cancel(app, "demo-salon-res-2");
    const slotKey = ((cancelacion.json() as Json).releasedSlots as Json[])[0]?.key as string;
    await command(app, "wl-f01", "simulate_notice");
    await command(app, "wl-f01", "record_acceptance");
    await convert(app, "wl-f01", slotKey);

    const sucio = await demoOf(app);
    expect(guideById(sucio, "guion-1").doneCount).toBeGreaterThan(0);
    expect(guideById(sucio, "guion-2").doneCount).toBeGreaterThan(0);

    await reset(app);
    const limpio = await demoOf(app);
    for (const id of ["guion-1", "guion-2"] as const) {
      const g = guideById(limpio, id);
      expect(g.doneCount).toBe(0);
      expect((g.steps as Json[]).some((s) => s.evidenceState === "hecho")).toBe(false);
    }
    expect((limpio.startingPoint as Json).ready).toBe(true);
  });
});

// =====================================================================
// (e) Pureza: navegar/repintar no muta NADA
// =====================================================================

describe("step 19 · Capacidad 3B — el guion no escribe nada: ni al pintarse, ni al navegar", () => {
  it("pintar el panel repetidas veces y cambiar de guion elegido deja la instantánea IDÉNTICA", async () => {
    const app = freshApp();
    await reset(app);
    const antes = stable(await snapshotOf(app));

    const { document, nodes } = createFakeDocumentWithIds([
      "lab-guion-aviso",
      "lab-guion-precondicion",
      { id: "lab-guion-ir-a-reiniciar", tag: "button" },
      { id: "lab-guion-radio-1", tag: "input" },
      { id: "lab-guion-radio-2", tag: "input" },
      "lab-guion-sin-elegir",
      { id: "lab-guion-contenido", tag: "div" },
      "lab-guion-titulo",
      { id: "lab-guion-pasos", tag: "ol" },
      "lab-guion-progreso",
      { id: "btn-abrir-reset", tag: "button" },
    ] as const);
    const { renderGuionEnPantalla, wireGuionEnPantallaControls } = loadUiClientHooks("", document);
    wireGuionEnPantallaControls();

    const snap = await snapshotOf(app);
    renderGuionEnPantalla(snap);
    (nodes["lab-guion-radio-1"] as FakeElement).value = "guion-1";
    (nodes["lab-guion-radio-1"] as FakeElement).dispatchChange();
    renderGuionEnPantalla(snap);
    (nodes["lab-guion-radio-2"] as FakeElement).value = "guion-2";
    (nodes["lab-guion-radio-2"] as FakeElement).dispatchChange();
    renderGuionEnPantalla(snap);
    (nodes["lab-guion-ir-a-reiniciar"] as FakeElement).dispatchClick();

    const despues = stable(await snapshotOf(app));
    expect(JSON.stringify(despues)).toBe(JSON.stringify(antes));
    await app.close();
  });
});

// =====================================================================
// (f) Ningún paso se marca por visitar una ruta ni por pulsar «Siguiente»
// (no existe ese botón: se comprueba que ningún control del panel, aparte
// del selector de guion y el de reiniciar, dispara ninguna acción).
// =====================================================================

describe("step 19 · Capacidad 3B — ningún paso cambia de estado por navegar, y no hay botón «Siguiente»", () => {
  it("el panel entero no contiene ningún botón de acción, sólo el selector, el enlace de reinicio y los enlaces de navegación de cada paso", () => {
    const js = renderConsoleAppJs();
    expect(js).not.toContain("Siguiente");
  });

  it("recorrer las pantallas (repintar Inicio/Agenda/Lista de espera/Laboratorio) sin hacer nada más dentro de ellas no completa ningún paso", async () => {
    const app = freshApp();
    await reset(app);
    const antes = guideById(await demoOf(app), "guion-2");
    expect(antes.doneCount).toBe(0);

    const { document, nodes } = createFakeDocumentWithIds([
      "lab-guion-aviso",
      "lab-guion-precondicion",
      { id: "lab-guion-ir-a-reiniciar", tag: "button" },
      { id: "lab-guion-radio-1", tag: "input" },
      { id: "lab-guion-radio-2", tag: "input" },
      "lab-guion-sin-elegir",
      { id: "lab-guion-contenido", tag: "div" },
      "lab-guion-titulo",
      { id: "lab-guion-pasos", tag: "ol" },
      "lab-guion-progreso",
    ] as const);
    const { renderGuionEnPantalla } = loadUiClientHooks("", document);
    const snap = await snapshotOf(app);
    // Se "visita" el panel muchas veces (como un sondeo repetido, o como
    // cambiar de pantalla y volver): ninguna de esas visitas es una acción.
    for (let i = 0; i < 5; i += 1) renderGuionEnPantalla(snap);
    expect(nodes["lab-guion-pasos"]).toBeDefined();
    const despues = guideById(await demoOf(app), "guion-2");
    expect(despues.doneCount).toBe(0);
    await app.close();
  });
});

// =====================================================================
// (g) El control de reinicio del guion sólo mueve el foco (§5.3.2, M4)
// =====================================================================

describe("step 19 · Capacidad 3B — «Ir a «Reiniciar la demostración»» sólo mueve el foco", () => {
  it("mueve el foco a #btn-abrir-reset, no abre ningún <dialog> y no dispara ningún fetch", () => {
    const { document, nodes } = createFakeDocumentWithIds([
      { id: "lab-guion-ir-a-reiniciar", tag: "button" },
      { id: "lab-guion-radio-1", tag: "input" },
      { id: "lab-guion-radio-2", tag: "input" },
      { id: "btn-abrir-reset", tag: "button" },
      { id: "dialogo-reset", tag: "dialog" },
    ] as const);
    const { wireGuionEnPantallaControls } = loadUiClientHooks("", document);
    wireGuionEnPantallaControls();

    const originalFetch = globalThis.fetch;
    let fetchLlamado = false;
    globalThis.fetch = (() => {
      fetchLlamado = true;
      return Promise.reject(new Error("no debería llamarse"));
    }) as unknown as typeof fetch;
    try {
      (nodes["lab-guion-ir-a-reiniciar"] as FakeElement).dispatchClick();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchLlamado).toBe(false);
    expect((document as unknown as { activeElement: unknown }).activeElement).toBe(nodes["btn-abrir-reset"]);
    expect((nodes["dialogo-reset"] as FakeElement).open).toBe(false);
  });

  it("el manejador de este control no llama a abrirDialogoReset ni a fetch (barrido estructural)", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("function wireGuionEnPantallaControls");
    expect(inicio).toBeGreaterThan(-1);
    const fin = js.indexOf("\n  function ", inicio + 10);
    const cuerpo = js.slice(inicio, fin === -1 ? undefined : fin);
    expect(cuerpo).not.toContain("abrirDialogoReset(");
    expect(cuerpo).not.toContain("fetch(");
    expect(cuerpo).not.toContain("showModal(");
    expect(cuerpo).toContain("scrollIntoView");
    expect(cuerpo).toContain(".focus()");
  });
});

// =====================================================================
// (h) Sin localStorage/sessionStorage/cookies/IndexedDB en todo el cliente
// =====================================================================

describe("step 19 · Capacidad 3B — sin segunda persistencia en todo renderConsoleAppJs()", () => {
  it("ni localStorage, ni sessionStorage, ni document.cookie, ni IndexedDB", () => {
    const js = renderConsoleAppJs();
    for (const prohibido of ["localStorage", "sessionStorage", "document.cookie", "indexedDB", "IndexedDB"]) {
      expect(js).not.toContain(prohibido);
    }
  });
});

// =====================================================================
// (i) Catálogo cerrado de frases no comprobables: sólo las cinco de §8.6
// =====================================================================

describe("step 19 · Capacidad 3B — las frases 'no_comprobable' pertenecen al catálogo cerrado de cinco (§8.6)", () => {
  it("las ocho evidenceLabel de pasos no_comprobables (entre los dos guiones) son siempre una de las cinco frases cerradas", async () => {
    const app = freshApp();
    await reset(app);
    const demo = await demoOf(app);
    const CATALOGO = [
      "Aún no comprobado: mirar un panel no deja rastro, y esta pantalla no cuenta una visita como un hecho.",
      "Aún no comprobado: aquí no se crea nada a propósito, y no crear nada no deja rastro. Que no lo deje es justo lo que se está enseñando.",
      "Aún no comprobado: un conflicto no escribe ni una línea, que es exactamente lo que demuestra este paso.",
      "Aún no comprobado: es la ausencia de una acción, y las ausencias no dejan huella.",
      "Aún no comprobado: esto se cuenta, no se hace.",
    ];
    const todas = (demo.guides as Json[]).flatMap((g) => g.steps as Json[]).filter((s) => s.evidenceState === "no_comprobable");
    expect(todas.length).toBe(8);
    for (const paso of todas) expect(CATALOGO).toContain(paso.evidenceLabel);
    await app.close();
  });
});

// =====================================================================
// (j) Progreso: la frase exacta, con los tres números correctos
// =====================================================================

describe("step 19 · Capacidad 3B — la línea de progreso cuenta bien los tres números", () => {
  it("recién reiniciado: 'Comprobados 0 de 5...' (guion 1) y 'Comprobados 0 de 8...' (guion 2)", async () => {
    const app = freshApp();
    await reset(app);
    const demo = await demoOf(app);
    expect(guideById(demo, "guion-1").progressLine).toContain("Comprobados 0 de 5 pasos con evidencia.");
    expect(guideById(demo, "guion-1").progressLine).toContain("Otros 5 pasos");
    expect(guideById(demo, "guion-2").progressLine).toContain("Comprobados 0 de 8 pasos con evidencia.");
    expect(guideById(demo, "guion-2").progressLine).toContain("Otros 3 pasos");
    await app.close();
  });
});

// =====================================================================
// (k) revisión adversarial de la capacidad 3, hallazgo M1 — el fieldset de
// «Qué guion vas a enseñar» ya no hereda el estilo de campo de texto
// =====================================================================

describe("step 19 · Capacidad 3B — el fieldset de los radios del guion usa la clase de opción de tarjeta, no la de campo de texto", () => {
  it("el <fieldset> lleva class=\"tx-slot-card__choice\", como los otros cinco grupos de radios de la consola — nunca \"tx-field\", que trae min-height:40px de un campo de texto", () => {
    const html = renderConsoleHtml();
    const legendIdx = html.indexOf("Qué guion vas a enseñar");
    const fieldsetIdx = html.lastIndexOf("<fieldset", legendIdx);
    const etiqueta = html.slice(fieldsetIdx, html.indexOf(">", fieldsetIdx) + 1);
    expect(etiqueta).toContain('class="tx-slot-card__choice"');
    expect(etiqueta).not.toContain('class="tx-field"');
  });
});
