import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { HUMAN_TASK_LEDGER_COPY } from "../../src/console/snapshot.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeElement, type FakeDocument } from "./fakeDom.js";

/**
 * step 19 · Capacidad 2 — el libro honesto de la atención humana.
 *
 * Cubre: (a) la corrección de Inicio (el contador, la lista y el vacío
 * derivan del MISMO array filtrado, y ese array es exactamente el que cuenta
 * `metrics.pendingHumanTasks`); (b) la proyección ampliada (`completedAtISO`
 * por lista blanca, nunca de relleno); (c) el panel nuevo del Laboratorio,
 * «Historial de tareas humanas», con sus filtros, sus reglas de enlace y su
 * detalle técnico; (d) que no existe ninguna forma genérica de cerrar una
 * tarea; (e) que el reinicio y el sondeo se comportan como manda el §4.6/§7.5.
 *
 * DESVIACIÓN DECLARADA respecto al diseño normativo (ver el mensaje final del
 * agente que implementó esta fase). El §4.1/§7.6/§8.4 del diseño afirman que
 * HOY sólo se cierra sola la tarea de decidir un hueco liberado
 * (`DECIDE_WAITLIST_MATCH`). Es FALSO contra el árbol real: `commands.ts:593`
 * también completa una `REVIEW_LATE_CANCELLATION` a través de
 * `POST /api/reservations/:id/cancellation-review` (mismo call site único,
 * `server.ts`, vía `applyEngineSideEffects`/`store.completeHumanTask`). El
 * aviso del panel (§8.4) se ha corregido para decir la verdad; esta suite
 * prueba las DOS rutas de cierre reales, no la que el diseño da por única.
 */

const TEST_SALT = "tareas-humanas-test-salt";

type Json = Record<string, unknown>;
type TaskJson = { id: string; callIdHash: string; reason: string; reasonKind: string; reasonLabel: string; createdAtISO: string; open: boolean; completedAtISO?: string };

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

async function convert(app: FastifyInstance, entryId: string, slotKey: string, key?: string) {
  return post(
    app,
    `/api/waitlist/entries/${entryId}/convert`,
    { slotKey, confirmed: true },
    { "idempotency-key": key ?? `convert:${entryId}:${slotKey}` },
  );
}

function tasksOf(snap: Json): TaskJson[] {
  return (snap.humanQueue as { tasks: TaskJson[] }).tasks;
}

function openTasks(snap: Json): TaskJson[] {
  return tasksOf(snap).filter((t) => t.open);
}

/** El recorrido completo hasta 'aceptada' sobre `wl-f01` y el hueco de las 13:00 (step 17). */
async function driveWaitlistDecisionToAccepted(app: FastifyInstance): Promise<string> {
  const res = await cancel(app, "demo-salon-res-2");
  const body = res.json() as Json;
  const slotKey = ((body.releasedSlots as Json[])[0] as Json).key as string;
  // (step 23, R2) Una persona aprueba la propuesta de ESE hueco antes de que
  // se pueda simular ningún aviso.
  expect((await command(app, "wl-f01", "approve_proposal", slotKey)).statusCode).toBe(200);
  expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
  expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
  return slotKey;
}

// =====================================================================
// (a) La proyección: completedAtISO por lista blanca, nunca de relleno
// =====================================================================

describe("step 19 · Capacidad 2 — completedAtISO llega SÓLO cuando el almacén lo tiene", () => {
  it("la tarea de decidir un hueco liberado nace sin completedAtISO y lo gana al convertir (server.ts, único llamante de completeHumanTask)", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveWaitlistDecisionToAccepted(app);

    const antes = await snapshotOf(app);
    const tareaAntes = tasksOf(antes).find((t) => t.reasonKind === "DECIDE_WAITLIST_MATCH");
    expect(tareaAntes?.open).toBe(true);
    expect(tareaAntes?.completedAtISO).toBeUndefined();
    const pendientesAntes = antes.metrics as Json;
    expect(pendientesAntes.pendingHumanTasks).toBe(openTasks(antes).length);

    const conv = await convert(app, "wl-f01", slotKey);
    expect(conv.statusCode).toBe(200);

    const despues = await snapshotOf(app);
    const tareaDespues = tasksOf(despues).find((t) => t.id === tareaAntes?.id);
    expect(tareaDespues?.open).toBe(false);
    expect(typeof tareaDespues?.completedAtISO).toBe("string");
    expect(tareaDespues?.completedAtISO).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // El recuento de abiertas ha bajado en EXACTAMENTE una.
    expect((despues.metrics as Json).pendingHumanTasks).toBe((pendientesAntes.pendingHumanTasks as number) - 1);
    expect((despues.metrics as Json).pendingHumanTasks).toBe(openTasks(despues).length);
    await app.close();
  });

  it("una tarea de revisar una cancelación tardía TAMBIÉN se cierra sola, por su propia acción real (segunda ruta de cierre honesta)", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated");
    expect(res.statusCode).toBe(200);

    const antes = await snapshotOf(app);
    const tarea = tasksOf(antes).find((t) => t.reasonKind === "REVIEW_LATE_CANCELLATION");
    expect(tarea?.open).toBe(true);
    expect(tarea?.completedAtISO).toBeUndefined();

    const revision = await post(app, "/api/reservations/demo-salon-res-1/cancellation-review", { decision: "reviewed_no_action" });
    expect(revision.statusCode).toBe(200);

    const despues = await snapshotOf(app);
    const tareaDespues = tasksOf(despues).find((t) => t.id === tarea?.id);
    expect(tareaDespues?.open).toBe(false);
    expect(typeof tareaDespues?.completedAtISO).toBe("string");
    await app.close();
  });

  it("#contador-cola es SIEMPRE metrics.pendingHumanTasks, con tareas resueltas y abiertas mezcladas", async () => {
    const app = freshApp();
    await reset(app);
    // Se construye un mundo con una tarea RESUELTA y otra ABIERTA.
    const slotKey = await driveWaitlistDecisionToAccepted(app);
    await convert(app, "wl-f01", slotKey); // cierra ésta
    await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated"); // deja ésta abierta

    const snap = await snapshotOf(app);
    const tareas = tasksOf(snap);
    expect(tareas.some((t) => !t.open)).toBe(true);
    expect(tareas.some((t) => t.open)).toBe(true);
    expect((snap.metrics as Json).pendingHumanTasks).toBe(tareas.filter((t) => t.open).length);
    await app.close();
  });
});

// =====================================================================
// (b) Cada motivo cerrado sigue siendo, él mismo, un motivo del catálogo
// =====================================================================

describe("step 19 · Capacidad 2 — los seis motivos alcanzables por esta suite llegan con su etiqueta correcta", () => {
  it("escalada de llamada: CALLBACK_FROM_CALL", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(app, "/api/scenario/run", {
      scenarioId: "A49-console-ayuda",
      turns: [{ utterance: "quiero hablar con una persona por una duda" }],
      liveTransferAvailable: false,
    });
    expect(res.statusCode).toBe(200);
    const snap = await snapshotOf(app);
    const tarea = tasksOf(snap).find((t) => t.reasonKind === "CALLBACK_FROM_CALL");
    expect(tarea?.reasonLabel).toBe("Devolver la llamada");
    expect(tarea?.callIdHash).not.toBe("sin-llamada-asociada");
    expect(tarea?.open).toBe(true);
    await app.close();
  });

  it("cambio de calendario con contacto pendiente: CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE", async () => {
    const app = freshApp();
    await reset(app);
    const change = { changeKind: "venue_closure", id: "cierre-etiqueta", startDate: BOOKING_DEMO_TODAY, endDate: BOOKING_DEMO_TODAY };
    // El cierre cubre el día de la propia fixture (BOOKING_DEMO_TODAY), así que
    // impacta a TODAS las reservas de ese día — no sólo la primera. La
    // publicación exige una resolución explícita para cada una (regla dura de
    // `applyChange`), así que se piden las citas afectadas de verdad primero.
    const preview = await post(app, "/api/calendar/preview", change);
    expect(preview.statusCode).toBe(200);
    const impacted = ((preview.json() as Json).impacted as Json[]).map((r) => r.reservationId as string);
    expect(impacted.length).toBeGreaterThan(0);
    const resolutions: Record<string, string> = {};
    impacted.forEach((id, i) => { resolutions[id] = i === 0 ? "mark_for_human_contact" : "keep_and_flag"; });
    const res = await post(app, "/api/calendar/publish", { change, resolutions });
    expect(res.statusCode).toBe(200);
    const snap = await snapshotOf(app);
    const tarea = tasksOf(snap).find((t) => t.reasonKind === "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE");
    expect(tarea?.reasonLabel).toBe("Llamar al cliente por un cambio de calendario");
    expect(tarea?.callIdHash).toBe("sin-llamada-asociada");
    expect(tarea?.open).toBe(true);
    await app.close();
  });

  it("cancelación fuera de plazo: REVIEW_LATE_CANCELLATION", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated");
    const snap = await snapshotOf(app);
    const tarea = tasksOf(snap).find((t) => t.reasonKind === "REVIEW_LATE_CANCELLATION");
    expect(tarea?.reasonLabel).toBe("Revisar una cancelación fuera de plazo");
    expect(tarea?.id).toBe("revision-tardia-demo-salon-res-1");
    await app.close();
  });

  it("decidir a quién se ofrece un hueco liberado: DECIDE_WAITLIST_MATCH", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const snap = await snapshotOf(app);
    const tarea = tasksOf(snap).find((t) => t.reasonKind === "DECIDE_WAITLIST_MATCH");
    expect(tarea?.reasonLabel).toBe("Decidir a quién se ofrece un hueco liberado");
    await app.close();
  });

  it("conflicto al convertir: REVIEW_WAITLIST_CONVERSION_CONFLICT", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveWaitlistDecisionToAccepted(app);
    const robo = await post(app, "/api/scenario/run", {
      scenarioId: "A33-consola-ui-roba-el-hueco",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "tuesday",
          time: "13:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    expect(robo.statusCode).toBe(200);
    const conv = await convert(app, "wl-f01", slotKey);
    expect(conv.statusCode).toBe(409);
    const snap = await snapshotOf(app);
    const tarea = tasksOf(snap).find((t) => t.reasonKind === "REVIEW_WAITLIST_CONVERSION_CONFLICT");
    expect(tarea?.reasonLabel).toBe("Revisar un hueco que se ocupó antes de convertir");
    expect(tarea?.open).toBe(true); // No hay ruta de cierre para éste, y sigue abierto.
    await app.close();
  });
});

// =====================================================================
// (c) Ninguna ruta genérica de finalización
// =====================================================================

describe("step 19 · Capacidad 2 — no existe ningún endpoint genérico de cierre de tareas", () => {
  it("el árbol de rutas registradas no contiene 'task' ni ningún método PATCH/PUT/DELETE", () => {
    const app = freshApp();
    // `printRoutes()` devuelve un árbol de prefijos compartidos (los
    // segmentos se parten letra a letra donde dos rutas divergen), así que NO
    // se busca una subcadena de ruta completa: eso rompería con cualquier
    // rutas vecina que comparta prefijo. Lo que de verdad importa —y lo único
    // que se afirma aquí— es que no hay ni un endpoint de "tarea" genérico ni
    // ningún verbo de modificación parcial.
    const arbol = app.printRoutes();
    expect(arbol.toLowerCase()).not.toContain("task");
    expect(arbol).not.toContain("PATCH");
    expect(arbol).not.toContain("PUT");
    expect(arbol).not.toContain("DELETE");
  });
});

// =====================================================================
// (c bis) La excepción declarada de I2 (§7.1, hallazgo m4, ampliada en la
// revisión adversarial de la capacidad 2, hallazgo H6): los DOS prefijos Y
// las TRES frases de negocio del historial viven en HUMAN_TASK_LEDGER_COPY
// (snapshot.ts) y el cliente las escribe BYTE A BYTE — nunca una variación
// silenciosa.
// =====================================================================

describe("step 19 · Capacidad 2 — HUMAN_TASK_LEDGER_COPY: el catálogo y el cliente no discrepan", () => {
  it("los dos prefijos declarados existen, byte a byte, en el JavaScript servido", () => {
    const js = renderConsoleAppJs();
    expect(js).toContain(`'${HUMAN_TASK_LEDGER_COPY.createdPrefix}'`);
    expect(js).toContain(`'${HUMAN_TASK_LEDGER_COPY.completedPrefix}'`);
  });

  it("las tres frases de negocio (hallazgo H6) existen, byte a byte, en el JavaScript servido", () => {
    const js = renderConsoleAppJs();
    expect(js).toContain(`'${HUMAN_TASK_LEDGER_COPY.resolvedNothingToDo}'`);
    expect(js).toContain(`'${HUMAN_TASK_LEDGER_COPY.emptyLedger}'`);
    expect(js).toContain(`'${HUMAN_TASK_LEDGER_COPY.emptyFiltered}'`);
  });

  /**
   * *(Añadido 2026-08-06 tras revisión adversarial de misión completa,
   * hallazgo BAJO 1.)* El aviso permanente del panel («Hoy sólo dos tipos de
   * tarea tienen camino de cierre…») vivía como texto ESTÁTICO repetido a
   * mano en `ui.html.ts`, mientras que (internal doc, not included in the template) (líneas 155
   * y 452) ya lo citaba como `HUMAN_TASK_LEDGER_COPY.aviso` — una clave que
   * hasta ahora no existía. Se mueve de verdad a la constante (mismo
   * criterio Dev-2 que ya cataloga las otras tres frases de negocio) y se
   * comprueba, byte a byte, contra el HTML SERVIDO (no el JavaScript: este
   * aviso es texto ESTÁTICO, nunca lo pinta el cliente — mismo patrón que
   * `GUIDE_COPY.resetWarning`).
   */
  it("(BAJO 1) el aviso permanente vive en HUMAN_TASK_LEDGER_COPY.aviso y el HTML servido lo interpola, byte a byte", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(`<p class="tx-context__note">${HUMAN_TASK_LEDGER_COPY.aviso}</p>`);
    // Y no lo pinta el cliente: es texto estático, no una línea transitoria.
    const js = renderConsoleAppJs();
    expect(js).not.toContain(HUMAN_TASK_LEDGER_COPY.aviso);
  });

  it("el catálogo tiene EXACTAMENTE esas SEIS claves — nada más se cuela por aquí", () => {
    expect(Object.keys(HUMAN_TASK_LEDGER_COPY).sort()).toEqual(
      ["aviso", "completedPrefix", "createdPrefix", "emptyFiltered", "emptyLedger", "resolvedNothingToDo"].sort(),
    );
  });
});

// =====================================================================
// (d) Inicio: el contador, la lista y el vacío son EL MISMO array filtrado
// =====================================================================

const INICIO_IDS = [
  "inicio-fecha",
  "tx-freshness",
  "inicio-estado-texto",
  "inicio-estado-dot",
  "inicio-inasistencias",
  "inicio-inasistencias-texto",
  "kpi-llamadas-valor",
  "kpi-resueltas-valor",
  "kpi-reservas-valor",
  "kpi-errores",
  "kpi-errores-valor",
  "kpi-errores-hint",
  "contador-atencion",
  "vacio-atencion",
  { id: "lista-atencion", tag: "ul" },
  "contador-cola",
  "vacio-tareas",
  { id: "lista-tareas", tag: "ul" },
  "vacio-actividad",
  { id: "lista-actividad", tag: "ul" },
  "vacio-citas-hoy",
  { id: "lista-citas-hoy", tag: "ul" },
  "inicio-calendario-resumen",
  { id: "lista-dias-distintos", tag: "ul" },
] as const;

async function mundoConTareaAbiertaYResuelta(): Promise<{ app: FastifyInstance; snap: Json }> {
  const app = freshApp();
  await reset(app);
  const slotKey = await driveWaitlistDecisionToAccepted(app);
  await convert(app, "wl-f01", slotKey); // resuelta
  await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated"); // abierta
  const snap = await snapshotOf(app);
  return { app, snap };
}

describe("step 19 · Capacidad 2 — Inicio deja de contar como pendientes las tareas ya resueltas", () => {
  it("el contador, la lista y el estado vacío derivan del mismo array: sólo las ABIERTAS", async () => {
    const { app, snap } = await mundoConTareaAbiertaYResuelta();
    const tareas = tasksOf(snap);
    expect(tareas.some((t) => !t.open)).toBe(true); // hay al menos una resuelta de verdad

    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snap);

    const abiertas = tareas.filter((t) => t.open);
    expect((snap.metrics as Json).pendingHumanTasks).toBe(abiertas.length);
    expect(nodes["contador-cola"]?.textContent).toBe(`(${String(abiertas.length)})`);
    expect((nodes["lista-tareas"] as FakeElement).children.length).toBe(abiertas.length);
    expect((nodes["vacio-tareas"] as FakeElement).hidden).toBe(abiertas.length > 0);
    // Ninguna resuelta aparece en la lista de Inicio.
    const idsPintados = (nodes["lista-tareas"] as FakeElement).children.map((li) => li.getAttribute("data-key"));
    for (const t of tareas.filter((t2) => !t2.open)) {
      expect(idsPintados).not.toContain(t.id);
    }
    await app.close();
  });

  it("con todas las tareas resueltas, Inicio enseña su vacío honesto (no discrepa con metrics)", async () => {
    const app = freshApp();
    await reset(app);
    // Cancelar `demo-salon-res-1` fuera de plazo crea DOS tareas, no una: la
    // revisión de la cancelación tardía Y la decisión sobre el hueco que esa
    // misma cancelación libera (compatible con `wl-f05`). Para que "todas
    // resueltas" sea literal, se cierran las DOS por su propia acción real.
    const cancelacion = await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated");
    const slotKey = ((cancelacion.json() as Json).releasedSlots as Json[])[0]?.key as string;
    expect((await post(app, "/api/reservations/demo-salon-res-1/cancellation-review", { decision: "reviewed_no_action" })).statusCode).toBe(200);
    expect((await command(app, "wl-f05", "approve_proposal", slotKey)).statusCode).toBe(200); // (step 23, R2)
    expect((await command(app, "wl-f05", "simulate_notice")).statusCode).toBe(200);
    expect((await command(app, "wl-f05", "record_acceptance")).statusCode).toBe(200);
    expect((await convert(app, "wl-f05", slotKey)).statusCode).toBe(200);
    const snap = await snapshotOf(app);
    expect(tasksOf(snap).length).toBeGreaterThan(0);
    expect(tasksOf(snap).every((t) => !t.open)).toBe(true);
    expect((snap.metrics as Json).pendingHumanTasks).toBe(0);

    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snap);
    expect(nodes["contador-cola"]?.textContent).toBe("");
    expect((nodes["lista-tareas"] as FakeElement).children.length).toBe(0);
    expect((nodes["vacio-tareas"] as FakeElement).hidden).toBe(false);
    await app.close();
  });
});

// =====================================================================
// (e) Laboratorio: las funciones puras del historial
// =====================================================================

const TAREA_ABIERTA_A: TaskJson = {
  id: "t-a",
  callIdHash: "sin-llamada-asociada",
  reason: "DECIDE_WAITLIST_MATCH",
  reasonKind: "DECIDE_WAITLIST_MATCH",
  reasonLabel: "Decidir a quién se ofrece un hueco liberado",
  createdAtISO: "2026-08-04T09:00:00.000Z",
  open: true,
};
const TAREA_ABIERTA_B: TaskJson = {
  id: "t-b",
  callIdHash: "sin-llamada-asociada",
  reason: "REVIEW_LATE_CANCELLATION",
  reasonKind: "REVIEW_LATE_CANCELLATION",
  reasonLabel: "Revisar una cancelación fuera de plazo",
  createdAtISO: "2026-08-04T09:05:00.000Z",
  open: true,
};
const TAREA_RESUELTA: TaskJson = {
  id: "t-c",
  callIdHash: "sin-llamada-asociada",
  reason: "DECIDE_WAITLIST_MATCH",
  reasonKind: "DECIDE_WAITLIST_MATCH",
  reasonLabel: "Decidir a quién se ofrece un hueco liberado",
  createdAtISO: "2026-08-04T08:00:00.000Z",
  open: false,
  completedAtISO: "2026-08-04T08:04:00.000Z",
};

describe("step 19 · Capacidad 2 — filtrarHistorialDeTareas/motivosDeHistorialDeTareas (puro)", () => {
  const { filtrarHistorialDeTareas, motivosDeHistorialDeTareas } = loadUiClientHooks();
  const todas = [TAREA_ABIERTA_A, TAREA_ABIERTA_B, TAREA_RESUELTA];

  it("'pendientes' trae sólo las abiertas, ordenadas por fecha de creación", () => {
    const r = filtrarHistorialDeTareas(todas, "pendientes", "") as TaskJson[];
    expect(r.map((t) => t.id)).toEqual(["t-a", "t-b"]);
  });

  it("'resueltas' trae sólo las cerradas", () => {
    const r = filtrarHistorialDeTareas(todas, "resueltas", "") as TaskJson[];
    expect(r.map((t) => t.id)).toEqual(["t-c"]);
  });

  it("'todas' trae las tres, sin duplicar ni perder ninguna", () => {
    const r = filtrarHistorialDeTareas(todas, "todas", "") as TaskJson[];
    expect(r.map((t) => t.id).sort()).toEqual(["t-a", "t-b", "t-c"]);
  });

  it("el motivo filtra por reasonLabel EXACTO, nunca por un código técnico", () => {
    const r = filtrarHistorialDeTareas(todas, "todas", "Revisar una cancelación fuera de plazo") as TaskJson[];
    expect(r.map((t) => t.id)).toEqual(["t-b"]);
  });

  it("estado + motivo se combinan (Y lógico)", () => {
    const r = filtrarHistorialDeTareas(todas, "pendientes", "Decidir a quién se ofrece un hueco liberado") as TaskJson[];
    expect(r.map((t) => t.id)).toEqual(["t-a"]);
  });

  it("los motivos salen de los DATOS, ordenados alfabéticamente, sin lista fija", () => {
    const motivos = motivosDeHistorialDeTareas(todas);
    expect(motivos).toEqual(["Decidir a quién se ofrece un hueco liberado", "Revisar una cancelación fuera de plazo"].sort());
    expect(motivosDeHistorialDeTareas([])).toEqual([]);
  });
});

// =====================================================================
// (f) Laboratorio: enlaces de una tarea pendiente
// =====================================================================

describe("step 19 · Capacidad 2 — textoEnlaceTareaPendiente (§4.5)", () => {
  const { textoEnlaceTareaPendiente } = loadUiClientHooks();

  it("un motivo de lista de espera dice 'Ir a resolverla', hacia #/lista-espera", () => {
    expect(textoEnlaceTareaPendiente({ reasonKind: "DECIDE_WAITLIST_MATCH", callIdHash: "sin-llamada-asociada" })).toBe(
      "Ir a resolverla",
    );
  });

  it("una llamada real dice 'Ir a resolverla' también, hacia el detalle de la llamada", () => {
    expect(textoEnlaceTareaPendiente({ reasonKind: "CALLBACK_FROM_CALL", callIdHash: "hash-real" })).toBe("Ir a resolverla");
  });

  it("sin ruta de lista de espera y sin llamada real dice 'Ver horarios y ausencias' — nunca promete resolver algo que esa pantalla no cumple", () => {
    expect(
      textoEnlaceTareaPendiente({ reasonKind: "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE", callIdHash: "sin-llamada-asociada" }),
    ).toBe("Ver horarios y ausencias");
  });
});

// =====================================================================
// (g) Laboratorio: el panel entero — renderHistorialDeTareas
// =====================================================================

const LAB_TAREAS_IDS = [
  { id: "lab-tareas-filtro-pendientes", tag: "button" },
  { id: "lab-tareas-filtro-resueltas", tag: "button" },
  { id: "lab-tareas-filtro-todas", tag: "button" },
  { id: "lab-tareas-motivo", tag: "select" },
  { id: "lab-tareas-lista", tag: "ul" },
  "lab-tareas-estado",
] as const;

/**
 * La clave de reconciliación ya no es `task.id` a secas (revisión adversarial
 * de la capacidad 2, hallazgo H1b): es `task.id + '|' + (completedAtISO ||
 * '')`, con un ordinal `#n` de más para un empate exacto. Cada escenario de
 * este bloque usa un `id` único, así que localizar por PREFIJO
 * (`id + '|'`) sigue identificando una única fila sin ambigüedad.
 */
function filaDe(nodes: Record<string, FakeElement>, id: string): FakeElement | undefined {
  return (nodes["lab-tareas-lista"] as FakeElement).children.find((li) => (li.getAttribute("data-key") ?? "").indexOf(`${id}|`) === 0);
}

describe("step 19 · Capacidad 2 — renderHistorialDeTareas: cada fila con su rótulo, píldora, fechas y detalle", () => {
  it("por defecto (filtro de cliente en su valor inicial 'pendientes') sólo pinta las tareas abiertas", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A, TAREA_RESUELTA] } });
    expect((nodes["lab-tareas-lista"] as FakeElement).children.length).toBe(1);
    expect(filaDe(nodes, "t-a")).toBeDefined();
    expect(filaDe(nodes, "t-c")).toBeUndefined();
  });

  it("el rótulo visible es SIEMPRE reasonLabel, nunca el código técnico crudo — que sólo aparece dentro de <details>", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    const tareaConCodigoFeo: TaskJson = { ...TAREA_ABIERTA_A, id: "t-x", reason: "CODIGO_TECNICO_FEO_123" };
    renderHistorialDeTareas({ humanQueue: { tasks: [tareaConCodigoFeo] } });
    const fila = filaDe(nodes, "t-x") as FakeElement;
    const cabecera = fila.children[0];
    expect(cabecera.children[0].textContent).toBe(tareaConCodigoFeo.reasonLabel);
    expect(cabecera.textContent).not.toContain("CODIGO_TECNICO_FEO_123");
    // El código crudo SÍ vive dentro del <details> de detalle técnico.
    const detalle = fila.children[4];
    expect(detalle.tagName).toBe("DETAILS");
    expect(detalle.textContent).toContain("CODIGO_TECNICO_FEO_123");
  });

  /**
   * *(Enmendado 2026-08-05 tras revisión adversarial de la capacidad 2,
   * hallazgo H7.)* La redacción anterior de esta prueba forzaba
   * `(nodes["lab-tareas-motivo"] as FakeElement).value = ""` — que NO es un
   * clic real sobre el filtro de estado, así que el panel se quedaba en
   * 'pendientes' (su valor de cliente por defecto) y la única aserción real
   * era `children.length).toBe(0)`: una fila fuera de la vista, nunca
   * comprobada. El nombre prometía tres cosas (píldora, fecha de cierre,
   * nunca un enlace de acción) y no comprobaba ninguna. Ahora se pulsa
   * 'Todas' de verdad (mismo patrón que las dos pruebas siguientes) y se
   * comprueban las tres, sobre una fila que SÍ está a la vista.
   */
  it("una tarea resuelta muestra su píldora, su fecha de cierre y NUNCA un enlace de acción", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", document);
    wireTareasHumanasControls();
    (nodes["lab-tareas-filtro-todas"] as FakeElement).dispatchClick();
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_RESUELTA] } });
    const fila = filaDe(nodes, "t-c") as FakeElement;
    expect(fila).toBeDefined();

    // 1) Su píldora dice "Resuelta", no "Pendiente".
    expect(fila.children[0].children[1]?.getAttribute("data-estado")).toBe("Resuelta");

    // 2) Su fecha de cierre está visible, con el prefijo de la casa.
    expect(fila.children[2].hidden).toBe(false);
    expect(fila.children[2].textContent).toBe("Resuelta el martes, 4 de agosto de 2026 a las 08:04");

    // 3) NUNCA un enlace de acción — TAREA_RESUELTA no lleva llamada real, así
    // que la celda de acción es sólo la frase honesta, jamás una `<a>`.
    const accion = fila.children[3];
    expect(accion.children.length).toBe(1);
    expect(accion.children[0].tagName).not.toBe("A");
    expect(accion.textContent).toBe(HUMAN_TASK_LEDGER_COPY.resolvedNothingToDo);
  });

  it("resuelta CON llamada real: 'Ver la llamada' hacia el detalle, de sólo lectura", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", document);
    wireTareasHumanasControls();
    (nodes["lab-tareas-filtro-todas"] as FakeElement).dispatchClick();
    const resueltaConLlamada: TaskJson = { ...TAREA_RESUELTA, id: "t-r-llamada", callIdHash: "hash-real-123" };
    renderHistorialDeTareas({ humanQueue: { tasks: [resueltaConLlamada] } });
    const fila = filaDe(nodes, "t-r-llamada") as FakeElement;
    const accion = fila.children[3];
    const enlace = accion.children[0];
    expect(enlace.tagName).toBe("A");
    expect(enlace.textContent).toBe("Ver la llamada");
    expect(enlace.href).toBe("#/llamadas/hash-real-123");
  });

  it("resuelta SIN llamada real: ningún enlace, sólo la frase honesta de que no hay nada que hacer", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", document);
    wireTareasHumanasControls();
    (nodes["lab-tareas-filtro-todas"] as FakeElement).dispatchClick();
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_RESUELTA] } });
    const fila = filaDe(nodes, "t-c") as FakeElement;
    const accion = fila.children[3];
    expect(accion.children.length).toBe(1);
    expect(accion.children[0].tagName).not.toBe("A");
    expect(accion.textContent).toBe("Ya está resuelta. No hay nada que hacer aquí.");
    // Jamás un enlace a la lista de espera para una tarea ya resuelta.
    expect(fila.textContent).not.toContain("#/lista-espera");
  });

  it("completedAtISO sólo se pinta cuando el almacén lo tiene: la línea 'Resuelta el…' está oculta en una tarea abierta", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    const fila = filaDe(nodes, "t-a") as FakeElement;
    expect(fila.children[1].hidden).toBe(false);
    expect(fila.children[1].textContent).toContain("Creada el");
    expect(fila.children[2].hidden).toBe(true);
  });

  it("y se muestra, con el prefijo 'Resuelta el ', cuando el almacén sí la tiene", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", document);
    wireTareasHumanasControls();
    (nodes["lab-tareas-filtro-todas"] as FakeElement).dispatchClick();
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_RESUELTA] } });
    const fila = filaDe(nodes, "t-c") as FakeElement;
    expect(fila.children[2].hidden).toBe(false);
    expect(fila.children[2].textContent).toBe("Resuelta el martes, 4 de agosto de 2026 a las 08:04");
  });

  it("UNKNOWN se enseña neutro: su rótulo de siempre, sin adornos, y un enlace genérico", () => {
    const tareaDesconocida: TaskJson = {
      id: "t-u",
      callIdHash: "sin-llamada-asociada",
      reason: "ALGO_QUE_NADIE_HA_VISTO",
      reasonKind: "UNKNOWN",
      reasonLabel: "Revisar esta llamada",
      createdAtISO: "2026-08-04T09:00:00.000Z",
      open: true,
    };
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [tareaDesconocida] } });
    const fila = filaDe(nodes, "t-u") as FakeElement;
    expect(fila.children[0].children[0].textContent).toBe("Revisar esta llamada");
    const enlace = fila.children[3].children[0];
    expect(enlace.href).toBe("#/horarios-y-ausencias");
    expect(enlace.textContent).toBe("Ver horarios y ausencias");
  });

  it("estado vacío honesto: sin ninguna tarea, y con el filtro sin resultados", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [] } });
    expect(nodes["lab-tareas-estado"]?.textContent).toBe("Todavía no hay ninguna tarea para una persona.");
    expect(nodes["lab-tareas-estado"]?.hidden).toBe(false);

    wireTareasHumanasControls();
    (nodes["lab-tareas-filtro-resueltas"] as FakeElement).dispatchClick();
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    expect(nodes["lab-tareas-estado"]?.textContent).toBe("Con este filtro no queda ninguna tarea. Prueba con “Todas”.");
  });

  /**
   * (revisión adversarial de la capacidad 3, hallazgo M4) A diferencia de los
   * otros 28 escritores de `setEstadoLinea`, éste corre en CADA sondeo de 2
   * s. Con el libro vacío (o un filtro sin resultados) sin cambios entre
   * sondeos, la MISMA frase no debe reescribirse sobre esta región
   * `role="status"` visible — un lector de pantalla la repetiría sin que
   * nada hubiera cambiado. Se cuentan las escrituras REALES sobre
   * `textContent` (no basta con comprobar el valor final, que sería igual
   * con o sin guarda).
   */
  it("con el mismo estado vacío en dos sondeos seguidos, la línea de estado NO se reescribe una segunda vez (hallazgo M4)", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    const estadoEl = nodes["lab-tareas-estado"] as FakeElement;
    let escrituras = 0;
    const prototipo = Object.getPrototypeOf(estadoEl) as { textContent: string };
    const descriptor = Object.getOwnPropertyDescriptor(prototipo, "textContent") as PropertyDescriptor;
    Object.defineProperty(estadoEl, "textContent", {
      configurable: true,
      get(this: FakeElement) {
        return (descriptor.get as (this: FakeElement) => string).call(this);
      },
      set(this: FakeElement, value: string) {
        escrituras += 1;
        (descriptor.set as (this: FakeElement, v: string) => void).call(this, value);
      },
    });

    renderHistorialDeTareas({ humanQueue: { tasks: [] } });
    expect(estadoEl.textContent).toBe("Todavía no hay ninguna tarea para una persona.");
    expect(escrituras).toBe(1);

    // Segundo sondeo, mundo idéntico: ninguna escritura nueva.
    renderHistorialDeTareas({ humanQueue: { tasks: [] } });
    expect(estadoEl.textContent).toBe("Todavía no hay ninguna tarea para una persona.");
    expect(escrituras).toBe(1);

    // El mundo SÍ cambia (una tarea llega): ahora sí se reescribe.
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    expect(estadoEl.hidden).toBe(true);
    expect(escrituras).toBe(2);

    // (revisión adversarial de misión completa, hallazgo BAJO 2) Con filas
    // que enseñar, la línea ya está vacía y oculta — un sondeo repetido, en
    // reposo, no debe volver a escribir '' sobre ella una tercera vez.
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    expect(estadoEl.hidden).toBe(true);
    expect(escrituras).toBe(2);
  });

  it("el <select> de motivo se construye desde los datos, con 'Todos los motivos' primero, y nunca ofrece un motivo inexistente", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A, TAREA_ABIERTA_B] } });
    const select = nodes["lab-tareas-motivo"] as FakeElement;
    const opciones = select.options.map((o) => o.textContent);
    expect(opciones[0]).toBe("Todos los motivos");
    expect(opciones.slice(1)).toEqual(["Decidir a quién se ofrece un hueco liberado", "Revisar una cancelación fuera de plazo"].sort());
  });

  /**
   * (revisión adversarial de la capacidad 3, hallazgo m8) A diferencia del
   * <select> de profesional, el CONJUNTO de motivos de éste sí cambia
   * durante una demostración. Sin guarda, reconstruirlo en mitad del sondeo
   * le cerraría el desplegable a quien lo tuviera abierto con el teclado.
   */
  it("con el <select> de motivo enfocado, un sondeo que añade un motivo nuevo NO reconstruye sus <option> (hallazgo m8)", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    const select = nodes["lab-tareas-motivo"] as FakeElement;
    const opcionesAntes = select.options.map((o) => o.textContent);
    expect(opcionesAntes).toEqual(["Todos los motivos", TAREA_ABIERTA_A.reasonLabel]);

    select.focus();
    expect(document.activeElement).toBe(select);
    // El mundo cambia: aparece un motivo nuevo (p. ej. una cancelación fuera
    // de plazo) mientras el operador tiene el desplegable abierto.
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A, TAREA_ABIERTA_B] } });
    expect(select.options.map((o) => o.textContent)).toEqual(opcionesAntes);

    // En cuanto el foco se va, el siguiente sondeo sí reconstruye.
    document.activeElement = null;
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A, TAREA_ABIERTA_B] } });
    expect(select.options.map((o) => o.textContent)).toEqual([
      "Todos los motivos",
      ...[TAREA_ABIERTA_A.reasonLabel, TAREA_ABIERTA_B.reasonLabel].sort(),
    ]);
  });

  it("si el motivo elegido desaparece de los datos, el filtro vuelve a 'Todos los motivos' — nunca se queda pegado a un motivo fantasma para siempre (revisión adversarial de la capacidad 2, hallazgo H2)", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", document);
    wireTareasHumanasControls();
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A, TAREA_ABIERTA_B] } });
    const select = nodes["lab-tareas-motivo"] as FakeElement;
    select.value = TAREA_ABIERTA_B.reasonLabel;
    select.dispatchChange();
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A, TAREA_ABIERTA_B] } });
    expect((nodes["lab-tareas-lista"] as FakeElement).children.length).toBe(1);
    expect(filaDe(nodes, "t-b")).toBeDefined();

    // El mundo cambia: la tarea B (y su motivo, "Revisar una cancelación
    // fuera de plazo") deja de existir. Antes de esta reparación, el filtro
    // seguía aplicando ese motivo para siempre, y el panel enseñaba "sin
    // resultados" incluso con la tarea A (de otro motivo) todavía viva.
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    // El <select> ha vuelto a "Todos los motivos"...
    expect(select.value).toBe("");
    // ...y el filtro de VERDAD también: la tarea que sigue existiendo se
    // pinta, nunca un estado vacío eterno.
    expect((nodes["lab-tareas-lista"] as FakeElement).children.length).toBe(1);
    expect(filaDe(nodes, "t-a")).toBeDefined();
    expect(nodes["lab-tareas-estado"]?.hidden).toBe(true);
  });
});

// =====================================================================
// (g bis) El foco y la celda de acción, cuando el mundo cambia debajo
// (revisión adversarial de la capacidad 2, hallazgos H4 y H5).
// =====================================================================

describe("step 19 · Capacidad 2 — una celda de acción con el foco dentro nunca sigue ofreciendo una acción que ya no es cierta (hallazgo H4)", () => {
  it("con el filtro 'Todas', el operador tabula hasta el enlace y la tarea se resuelve: la celda se reconstruye igualmente — perder el foco es el mal menor frente a una acción falsa", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", document);
    wireTareasHumanasControls();
    (nodes["lab-tareas-filtro-todas"] as FakeElement).dispatchClick();
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });

    const filaAntes = filaDe(nodes, "t-a") as FakeElement;
    const enlace = filaAntes.children[3].children[0];
    expect(enlace.tagName).toBe("A");
    expect(enlace.textContent).toBe("Ir a resolverla");
    (document as FakeDocument).activeElement = enlace; // el operador tabula hasta el enlace

    const resuelta: TaskJson = { ...TAREA_ABIERTA_A, open: false, completedAtISO: "2026-08-04T09:04:00.000Z" };
    renderHistorialDeTareas({ humanQueue: { tasks: [resuelta] } }); // llega el sondeo: ya está resuelta

    const filaDespues = filaDe(nodes, "t-a") as FakeElement;
    // La píldora y la fecha de cierre se han puesto al día.
    expect(filaDespues.children[0].children[1]?.getAttribute("data-estado")).toBe("Resuelta");
    expect(filaDespues.children[2].hidden).toBe(false);
    // Y la celda de acción YA NO ofrece "Ir a resolverla": antes de esta
    // reparación, la guarda de foco (`holdsFocus`) impedía tocar la celda
    // para siempre, y el enlace hacia una tarea ya resuelta se quedaba ahí.
    const accionDespues = filaDespues.children[3];
    expect(accionDespues.children.length).toBe(1);
    expect(accionDespues.children[0].tagName).not.toBe("A");
    expect(accionDespues.textContent).toBe(HUMAN_TASK_LEDGER_COPY.resolvedNothingToDo);
  });

  it("mientras la forma de la acción NO cambia (sigue abierta, mismo enlace), el foco sigue mandando — la reparación no ha tocado ese caso", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", document);
    wireTareasHumanasControls();
    (nodes["lab-tareas-filtro-todas"] as FakeElement).dispatchClick();
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    const fila = filaDe(nodes, "t-a") as FakeElement;
    const enlace = fila.children[3].children[0];
    (document as FakeDocument).activeElement = enlace;
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } }); // mismo sondeo, misma tarea abierta
    expect((document as FakeDocument).activeElement).toBe(enlace);
    expect(fila.children[3].children[0]).toBe(enlace);
  });
});

describe("step 19 · Capacidad 2 — una fila que el foco protege se OCULTA en cuanto deja de estar entre las filtradas, y no queda ninguna visible bajo la línea de estado vacío (hallazgo H5)", () => {
  it("filtro 'Pendientes': la fila resuelta, protegida por el foco, se oculta — el estado vacío deja de mentir", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } }); // filtro por defecto: 'pendientes'
    const fila = filaDe(nodes, "t-a") as FakeElement;
    (document as FakeDocument).activeElement = fila.children[3].children[0];

    const resuelta: TaskJson = { ...TAREA_ABIERTA_A, open: false, completedAtISO: "2026-08-04T09:04:00.000Z" };
    renderHistorialDeTareas({ humanQueue: { tasks: [resuelta] } });

    // reconcileList no puede quitar la fila (el foco vive dentro), pero ya no
    // está entre las filtradas de 'pendientes': se oculta.
    const lista = nodes["lab-tareas-lista"] as FakeElement;
    expect(lista.children.length).toBe(1); // sigue en el DOM, el foco no se pierde
    expect(lista.children[0].hidden).toBe(true); // pero NINGUNA fila visible
    expect((document as FakeDocument).activeElement).toBe(fila.children[3].children[0]); // el foco no se toca
  });

  it("caso del reinicio (sonda p2-C): tras vaciar el almacén con el foco dentro de una fila, no queda NINGUNA fila VISIBLE bajo la línea de estado vacío", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    const fila = filaDe(nodes, "t-a") as FakeElement;
    (document as FakeDocument).activeElement = fila.children[3].children[0];

    renderHistorialDeTareas({ humanQueue: { tasks: [] } }); // store.reset()

    const lista = nodes["lab-tareas-lista"] as FakeElement;
    // La fila sigue en el DOM (el foco no se pierde), pero NINGUNA es visible.
    const visibles = lista.children.filter((li) => !li.hidden);
    expect(visibles.length).toBe(0);
    // Y la línea de estado vacío, honesta, dice que no hay ninguna tarea.
    expect(nodes["lab-tareas-estado"]?.hidden).toBe(false);
    expect(nodes["lab-tareas-estado"]?.textContent).toBe(HUMAN_TASK_LEDGER_COPY.emptyLedger);
  });

  it("una fila oculta por el foco vuelve a mostrarse en cuanto su clave regresa a las filtradas", () => {
    const { document, nodes } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas } = loadUiClientHooks("", document);
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    const fila = filaDe(nodes, "t-a") as FakeElement;
    (document as FakeDocument).activeElement = fila.children[3].children[0];
    const resuelta: TaskJson = { ...TAREA_ABIERTA_A, open: false, completedAtISO: "2026-08-04T09:04:00.000Z" };
    renderHistorialDeTareas({ humanQueue: { tasks: [resuelta] } }); // filtro 'pendientes': se oculta
    expect((nodes["lab-tareas-lista"] as FakeElement).children[0]?.hidden).toBe(true);

    // La misma tarea vuelve a estar abierta (por ejemplo, un reinicio del
    // mundo con datos nuevos que casualmente coinciden).
    renderHistorialDeTareas({ humanQueue: { tasks: [TAREA_ABIERTA_A] } });
    expect((nodes["lab-tareas-lista"] as FakeElement).children[0]?.hidden).toBe(false);
  });
});

// =====================================================================
// (h) Reinicio y sondeo: el filtro y el foco sobreviven
// =====================================================================

const LABORATORIO_IDS = [
  { id: "lab-eventos-pilot", tag: "dl" },
  { id: "lab-eventos-internal", tag: "dl" },
  "lab-auditoria-vacio",
  { id: "lab-auditoria-lista", tag: "ul" },
  { id: "lab-json", tag: "pre" },
  ...LAB_TAREAS_IDS,
  { id: "tx-view-title", tag: "h1" },
  "tx-freshness",
  "inicio-ruta-desconocida",
] as const;

async function montarLaboratorio(app: FastifyInstance) {
  const { document, nodes } = createFakeDocumentWithIds([...LABORATORIO_IDS]);
  const win = { location: { hash: "#/laboratorio" }, scrollTo: () => undefined };
  const hooks = loadUiClientHooks("#/laboratorio", document, win);
  hooks.applyRoute();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const snap = await snapshotOf(app);
    return { json: () => Promise.resolve(snap) };
  }) as unknown as typeof fetch;
  try {
    await hooks.refresh();
  } finally {
    globalThis.fetch = original;
  }
  return { document, nodes, hooks };
}

describe("step 19 · Capacidad 2 — reinicio y sondeo repetido", () => {
  it("tras POST /api/reset el historial queda vacío, sin código nuevo: este panel deriva del repintado", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2"); // deja una tarea abierta antes de reiniciar
    const { nodes, hooks } = await montarLaboratorio(app);
    expect((nodes["lab-tareas-lista"] as FakeElement).children.length).toBeGreaterThan(0);

    await reset(app);
    const snap = await snapshotOf(app);
    expect(tasksOf(snap).length).toBe(0);
    hooks.renderHistorialDeTareas(snap);
    expect((nodes["lab-tareas-lista"] as FakeElement).children.length).toBe(0);
    expect(nodes["lab-tareas-estado"]?.textContent).toBe("Todavía no hay ninguna tarea para una persona.");
    await app.close();
  });

  it("un filtro elegido por clic sobrevive a un sondeo posterior (§7.5): ni el botón ni la lista se resetean a 'Pendientes'", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveWaitlistDecisionToAccepted(app);
    await convert(app, "wl-f01", slotKey); // una tarea resuelta, para poblar 'Resueltas'
    await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated"); // una abierta

    const { nodes, hooks } = await montarLaboratorio(app);
    // Estado inicial: 'Pendientes' (el valor por defecto del cliente). El DOM
    // falso no parte del HTML servido de verdad (createFakeDocumentWithIds
    // crea nodos en blanco), así que el estado inicial se comprueba contra el
    // HTML REAL y no contra un atributo que este documento nunca ha tenido.
    const htmlServido = renderConsoleHtml();
    expect(htmlServido).toContain('id="lab-tareas-filtro-pendientes" aria-pressed="true"');
    expect(htmlServido).toContain('id="lab-tareas-filtro-resueltas" aria-pressed="false"');
    expect(htmlServido).toContain('id="lab-tareas-filtro-todas" aria-pressed="false"');

    hooks.wireTareasHumanasControls();
    (nodes["lab-tareas-filtro-resueltas"] as FakeElement).dispatchClick();
    expect(nodes["lab-tareas-filtro-resueltas"]?.getAttribute("aria-pressed")).toBe("true");
    expect(nodes["lab-tareas-filtro-pendientes"]?.getAttribute("aria-pressed")).toBe("false");
    const resueltasTrasClic = (nodes["lab-tareas-lista"] as FakeElement).children.length;
    expect(resueltasTrasClic).toBeGreaterThan(0);

    // El siguiente sondeo (mismo servidor, misma instantánea) NO debe tocar
    // la selección de filtro ni volver a 'Pendientes'.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      const snap = await snapshotOf(app);
      return { json: () => Promise.resolve(snap) };
    }) as unknown as typeof fetch;
    try {
      await hooks.refresh();
    } finally {
      globalThis.fetch = original;
    }
    expect(nodes["lab-tareas-filtro-resueltas"]?.getAttribute("aria-pressed")).toBe("true");
    expect((nodes["lab-tareas-lista"] as FakeElement).children.length).toBe(resueltasTrasClic);
    await app.close();
  });

  it("el foco dentro de una fila sobrevive a un sondeo con la misma tarea (reconcileList por clave)", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const { document, nodes, hooks } = await montarLaboratorio(app);
    const fila = (nodes["lab-tareas-lista"] as FakeElement).children[0];
    const enlace = fila.querySelector("a");
    (document as FakeDocument).activeElement = enlace;

    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      const snap = await snapshotOf(app);
      return { json: () => Promise.resolve(snap) };
    }) as unknown as typeof fetch;
    try {
      await hooks.refresh();
    } finally {
      globalThis.fetch = original;
    }
    expect((document as FakeDocument).activeElement).toBe(enlace);
    expect((nodes["lab-tareas-lista"] as FakeElement).children[0]).toBe(fila);
    await app.close();
  });
});

// =====================================================================
// (i) Revisión adversarial de la capacidad 2 — H1 (servidor y cliente),
// H7 (la prueba mandatada por H1) y H9 (el recuento de la lista de espera
// no duplica). Recorrido real, exactamente el de la sonda p3: cancelar ->
// convertir -> cancelar la reserva nacida de la conversión.
// =====================================================================

describe("step 19 · Capacidad 2 — un mismo id de tarea, cerrado y luego reabierto, nunca se duplica como dos ABIERTAS (hallazgos H1, H7, H9)", () => {
  it("cancelar -> convertir -> cancelar la reserva nacida: el almacén guarda las DOS filas (una cerrada, una abierta), nunca dos abiertas; Inicio, el historial y sus filtros dicen la verdad; y una conversión posterior cierra sólo UNA tarea", async () => {
    const app = freshApp();
    await reset(app);

    const c1 = await cancel(app, "demo-salon-res-2");
    const slotKey = ((c1.json() as Json).releasedSlots as Json[])[0]?.key as string;
    const tareaId = `decidir-hueco-${slotKey}`;

    expect((await command(app, "wl-f01", "approve_proposal", slotKey)).statusCode).toBe(200); // (step 23, R2)
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
    const conv1 = await convert(app, "wl-f01", slotKey);
    expect(conv1.statusCode).toBe(200);
    const nuevaId = ((conv1.json() as Json).reservation as Json).id as string;

    const snapTrasConvertir = await snapshotOf(app);
    const cerradaSola = tasksOf(snapTrasConvertir).filter((t) => t.id === tareaId);
    expect(cerradaSola).toHaveLength(1);
    expect(cerradaSola[0]?.open).toBe(false);
    const pendientesTrasConvertir = (snapTrasConvertir.metrics as Json).pendingHumanTasks as number;

    // La reserva nacida de la conversión se cancela: el MISMO hueco se libera
    // otra vez — el mismo recado, una segunda vez en la historia.
    const c2 = await cancel(app, nuevaId, "unspecified");
    expect(c2.statusCode).toBe(200);

    const snap = await snapshotOf(app);
    const dosFilas = tasksOf(snap).filter((t) => t.id === tareaId);
    // El almacén guarda las DOS: la histórica cerrada y la nueva abierta.
    expect(dosFilas).toHaveLength(2);
    expect(dosFilas.filter((t) => t.open)).toHaveLength(1); // H1a: nunca dos abiertas a la vez
    expect(dosFilas.filter((t) => !t.open)).toHaveLength(1);
    expect((snap.metrics as Json).pendingHumanTasks).toBe(pendientesTrasConvertir + 1);
    expect((snap.metrics as Json).pendingHumanTasks).toBe(openTasks(snap).length);

    // H9 — el recuento de "acciones que requieren una persona" de la lista de
    // espera (waitlistSnapshot.ts) tampoco duplica: cuenta tareas ABIERTAS,
    // nunca filas por id.
    const waitlistReasons = new Set(["DECIDE_WAITLIST_MATCH", "REVIEW_LATE_CANCELLATION", "REVIEW_WAITLIST_CONVERSION_CONFLICT"]);
    const esperadoWaitlist = openTasks(snap).filter((t) => waitlistReasons.has(t.reasonKind)).length;
    expect(((snap as Json).waitlist as Json).metrics).toMatchObject({ actionsRequiringAPerson: esperadoWaitlist });

    // Inicio cuenta SÓLO la abierta de este id (mezclada con las demás
    // tareas abiertas del mundo): el contador, la lista y metrics coinciden.
    const { document: docInicio, nodes: nodesInicio } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", docInicio);
    renderInicio(snap);
    const abiertasDelMundo = tasksOf(snap).filter((t) => t.open);
    expect(nodesInicio["contador-cola"]?.textContent).toBe(`(${String(abiertasDelMundo.length)})`);
    expect((nodesInicio["lista-tareas"] as FakeElement).children.length).toBe(abiertasDelMundo.length);

    // El historial del Laboratorio, en 'Todas', enseña las DOS filas de este
    // id, cada una con su verdad — nunca el contenido de una pisando el de
    // la otra (H1b).
    const { document: docLab, nodes: nodesLab } = createFakeDocumentWithIds([...LAB_TAREAS_IDS]);
    const { renderHistorialDeTareas, wireTareasHumanasControls } = loadUiClientHooks("", docLab);
    wireTareasHumanasControls();
    (nodesLab["lab-tareas-filtro-todas"] as FakeElement).dispatchClick();
    renderHistorialDeTareas(snap);
    const filasMismoId = (nodesLab["lab-tareas-lista"] as FakeElement).children.filter(
      (li) => (li.getAttribute("data-key") ?? "").indexOf(tareaId) === 0,
    );
    expect(filasMismoId).toHaveLength(2);
    const estados = filasMismoId.map((li) => li.children[0].children[1]?.getAttribute("data-estado")).sort();
    expect(estados).toEqual(["Pendiente", "Resuelta"]);
    const filaResuelta = filasMismoId.find((li) => li.children[0].children[1]?.getAttribute("data-estado") === "Resuelta")!;
    const filaAbierta = filasMismoId.find((li) => li.children[0].children[1]?.getAttribute("data-estado") === "Pendiente")!;
    expect(filaResuelta.children[2].hidden).toBe(false); // "Resuelta el…" visible en la cerrada
    expect(filaAbierta.children[2].hidden).toBe(true); // y oculta en la abierta

    // Los filtros no mienten: 'Pendientes' sólo enseña la abierta de este id,
    // 'Resueltas' sólo la cerrada.
    (nodesLab["lab-tareas-filtro-pendientes"] as FakeElement).dispatchClick();
    renderHistorialDeTareas(snap);
    const soloPendiente = (nodesLab["lab-tareas-lista"] as FakeElement).children.filter(
      (li) => (li.getAttribute("data-key") ?? "").indexOf(tareaId) === 0,
    );
    expect(soloPendiente).toHaveLength(1);
    expect(soloPendiente[0]?.children[0].children[1]?.getAttribute("data-estado")).toBe("Pendiente");

    (nodesLab["lab-tareas-filtro-resueltas"] as FakeElement).dispatchClick();
    renderHistorialDeTareas(snap);
    const soloResuelta = (nodesLab["lab-tareas-lista"] as FakeElement).children.filter(
      (li) => (li.getAttribute("data-key") ?? "").indexOf(tareaId) === 0,
    );
    expect(soloResuelta).toHaveLength(1);
    expect(soloResuelta[0]?.children[0].children[1]?.getAttribute("data-estado")).toBe("Resuelta");

    // Una conversión POSTERIOR, que cierra la tarea reabierta (con una
    // SEGUNDA persona de la lista de espera, wl-f02, compatible con el
    // mismo hueco 13:00-14:00), cierra EXACTAMENTE una tarea — nunca un
    // cierre en cadena que resuelva de más (hallazgo H1, "chain-close").
    // (step 23) Al convertir la primera vez, T2 reofertó a wl-f02 el hueco
    // hermano de las 13:30. Para que compita por ESTE hueco, que se ha vuelto a
    // liberar, hay que soltar aquel y que una persona la proponga aquí: dos
    // actos humanos explícitos, ninguno tácito.
    expect((await command(app, "wl-f02", "release_match")).statusCode).toBe(200);
    expect((await command(app, "wl-f02", "take_over_proposal", slotKey)).statusCode).toBe(200);
    expect((await command(app, "wl-f02", "simulate_notice")).statusCode).toBe(200);
    expect((await command(app, "wl-f02", "record_acceptance")).statusCode).toBe(200);
    const conv2 = await convert(app, "wl-f02", slotKey);
    expect(conv2.statusCode).toBe(200);
    const snapFinal = await snapshotOf(app);
    expect((snapFinal.metrics as Json).pendingHumanTasks).toBe((snap.metrics as Json).pendingHumanTasks as number - 1);
    const tresFilas = tasksOf(snapFinal).filter((t) => t.id === tareaId);
    expect(tresFilas).toHaveLength(2); // sigue habiendo sólo dos filas para este id: no nace una tercera
    expect(tresFilas.every((t) => !t.open)).toBe(true); // y ahora las DOS están cerradas
    await app.close();
  });
});
