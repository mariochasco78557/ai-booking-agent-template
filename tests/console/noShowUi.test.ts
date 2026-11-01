import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { OPERATIONS_COPY } from "../../src/console/operationsSnapshot.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks, type UiTestHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeElement, type FakeDocument } from "./fakeDom.js";

/**
 * step 18 · fase G — LA PANTALLA de las inasistencias manuales (§5.2, §5.3,
 * §5.5, §5.6 y §3.6).
 *
 * Misma técnica que `waitlistUi.test.ts`: se ejecuta el JavaScript REAL que
 * sirve `GET /app.js` contra el DOM falso mínimo de `fakeDom.ts`, y se pinta
 * con INSTANTÁNEAS REALES del servidor, pedidas por `app.inject()`. Cuando
 * una prueba escribe, escribe contra el servidor de verdad: el `fetch` global
 * se sustituye por uno que habla con `app.inject()`, así que las claves de
 * idempotencia, las cabeceras y los códigos de estado son los auténticos.
 *
 * LO QUE ESTAS PRUEBAS NO FIRMAN. `fakeDom.ts` no emula el top layer del
 * `<dialog>`, ni el backdrop, ni la trampa de foco, ni el `Escape` nativo, ni
 * el orden de tabulación, ni una sola regla de CSS — y no hay ningún árbol de
 * accesibilidad que emular, así que nada de aquí demuestra qué anuncia un
 * lector de pantalla. Eso lo firma el runbook del Mac (criterios 8.8, 8.18 y
 * 8.25, V-M). Lo de aquí es regresión barata sobre el estado del DOM.
 */

const TEST_SALT = "no-show-ui-test-salt";

type Json = Record<string, unknown>;

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

/** Lo que el cliente pide de una petición POST, y nada más. */
type PeticionRegistrada = { method: string; url: string; key: string | null; body: unknown };

/**
 * Un `fetch` que habla con el servidor REAL por `app.inject()`, propagando
 * cuerpo y cabeceras (que es donde viaja `Idempotency-Key`), y que apunta
 * cada petición para poder comprobar QUÉ clave acuñó la pantalla.
 */
function fetchContraLaApp(app: FastifyInstance, registro?: PeticionRegistrada[]): typeof fetch {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = init?.headers ?? {};
    const cuerpo: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
    if (registro) {
      registro.push({
        method,
        url,
        key: headers["Idempotency-Key"] ?? null,
        body: cuerpo,
      });
    }
    const res = await app.inject({
      method: method as "GET",
      url,
      ...(cuerpo !== undefined ? { payload: cuerpo as never } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      headers: { get: (k: string) => res.headers[k.toLowerCase()] ?? null },
      json: () => Promise.resolve(res.body === "" ? {} : (JSON.parse(res.body) as unknown)),
    };
  }) as unknown as typeof fetch;
}

async function conFetch<T>(f: typeof fetch, fn: () => Promise<T> | T): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function snapshotOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}

// ---------------------------------------------------------------------
// Los ids del HTML real que cada función busca
// ---------------------------------------------------------------------

const AGENDA_IDS = [
  { id: "agenda-filtro-profesional", tag: "select" },
  "agenda-dias",
  "agenda-vacio",
  // step 19 §3.8, punto 2: renderAgenda() también rellena el desplegable
  // del explorador de huecos, bajo la misma guarda de igualdad.
  { id: "huecos-profesional", tag: "select" },
] as const;

const INASISTENCIA_IDS = [
  { id: "dialogo-inasistencia", tag: "dialog" },
  { id: "dialogo-inasistencia-titulo", tag: "h2" },
  { id: "inasistencia-resumen", tag: "p" },
  { id: "inasistencia-manual", tag: "p" },
  { id: "inasistencia-sin-penalizacion", tag: "p" },
  { id: "inasistencia-sin-identidad", tag: "p" },
  { id: "inasistencia-historial", tag: "span" },
  { id: "inasistencia-estado", tag: "p" },
  { id: "inasistencia-cancelar", tag: "button" },
  { id: "inasistencia-confirmar", tag: "button" },
  { id: "inasistencia-cerrar", tag: "button" },
  { id: "dialogo-corregir-inasistencia", tag: "dialog" },
  { id: "dialogo-corregir-inasistencia-titulo", tag: "h2" },
  { id: "corregir-inasistencia-resumen", tag: "p" },
  { id: "corregir-inasistencia-cuando", tag: "p" },
  { id: "corregir-inasistencia-historial", tag: "p" },
  { id: "corregir-inasistencia-definitivo", tag: "p" },
  { id: "corregir-inasistencia-estado", tag: "p" },
  { id: "corregir-inasistencia-cancelar", tag: "button" },
  { id: "corregir-inasistencia-confirmar", tag: "button" },
  { id: "corregir-inasistencia-cerrar", tag: "button" },
  { id: "tx-view-title", tag: "h1" },
] as const;

const LAB_RELOJ_IDS = [
  { id: "lab-reloj-ahora", tag: "p" },
  { id: "lab-reloj-aviso", tag: "p" },
  { id: "lab-tecnico-endpoint", tag: "p" },
  { id: "lab-reloj-salto", tag: "select" },
  { id: "lab-reloj-cita", tag: "select" },
  { id: "lab-reloj-avanzar", tag: "button" },
  { id: "lab-reloj-gate", tag: "p" },
  { id: "lab-reloj-estado", tag: "p" },
  { id: "lab-operaciones-lista", tag: "ul" },
  "lab-operaciones-vacio",
] as const;

const INICIO_IDS = [
  "inicio-fecha",
  "tx-freshness",
  "inicio-estado-texto",
  "inicio-estado-dot",
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
  { id: "inicio-inasistencias", tag: "p" },
  { id: "inicio-inasistencias-texto", tag: "span" },
] as const;

type Montaje = { document: FakeDocument; nodes: Record<string, FakeElement>; hooks: UiTestHooks };

function montar(ids: readonly (string | { id: string; tag: string })[]): Montaje {
  const { document, nodes } = createFakeDocumentWithIds(ids);
  const hooks = loadUiClientHooks("", document);
  return { document, nodes, hooks };
}

/** Todo el texto de un subárbol, nodo a nodo, para buscar dentro. */
function todoElTexto(node: FakeElement): string {
  const partes: string[] = [node.textContent];
  for (const hijo of node.children) partes.push(todoElTexto(hijo));
  return partes.join(" | ");
}

/** Cada texto visible del subárbol, uno por nodo hoja, para señalar el culpable. */
function textosVisibles(node: FakeElement): string[] {
  if (node.hidden) return [];
  if (node.children.length === 0) return node.textContent === "" ? [] : [node.textContent];
  const out: string[] = [];
  for (const hijo of node.children) out.push(...textosVisibles(hijo));
  return out;
}

/** Las filas `<tr>` que `renderAgenda` ha pintado para el primer día. */
function filasDeAgenda(nodes: Record<string, FakeElement>): FakeElement[] {
  const panel = nodes["agenda-dias"].children[0];
  const tbody = panel.children[2].children[0].children[2];
  return tbody.children;
}

function filaDe(nodes: Record<string, FakeElement>, reservationId: string): FakeElement {
  const fila = filasDeAgenda(nodes).find((tr) => tr.getAttribute("data-key") === reservationId);
  expect(fila, `no hay ninguna fila de agenda para ${reservationId}`).toBeDefined();
  return fila as FakeElement;
}

function botonesDe(fila: FakeElement): string[] {
  return fila.children[4].children.filter((b) => !b.hidden).map((b) => b.textContent);
}

// ---------------------------------------------------------------------
// Las cuatro instantáneas, cada una un momento REAL de la demostración
// ---------------------------------------------------------------------

/** 09:00, recién reiniciada: ninguna cita ha terminado (§9.1, paso 1). */
let snapInicial: Json;
/** 10:00, después de mover el reloj: `demo-salon-res-1` es la ÚNICA elegible. */
let snapReloj: Json;
/** Con la inasistencia de `demo-salon-res-1` anotada. */
let snapAnotada: Json;
/** Con ese mismo registro ya corregido. */
let snapCorregida: Json;

beforeAll(async () => {
  const app = freshApp();
  await app.inject({ method: "POST", url: "/api/reset", payload: {} });
  snapInicial = await snapshotOf(app);

  const avance = await app.inject({
    method: "POST",
    url: "/api/lab/clock/advance",
    payload: { command: "advance_to_reservation_end", reservationId: "demo-salon-res-1" },
  });
  expect(avance.statusCode).toBe(200);
  snapReloj = await snapshotOf(app);

  const anotar = await app.inject({
    method: "POST",
    url: "/api/reservations/demo-salon-res-1/no-show",
    payload: { confirmed: true },
    headers: { "idempotency-key": "noshow:demo-salon-res-1:v0" },
  });
  expect(anotar.statusCode).toBe(201);
  snapAnotada = await snapshotOf(app);

  const corregir = await app.inject({
    method: "POST",
    url: "/api/reservations/demo-salon-res-1/no-show/correction",
    payload: { confirmed: true },
    headers: { "idempotency-key": "noshow-fix:demo-salon-res-1:v0" },
  });
  expect(corregir.statusCode).toBe(200);
  snapCorregida = await snapshotOf(app);
  await app.close();
});

// =====================================================================
// §5.2 — La Agenda
// =====================================================================

describe("step 18 §5.2 — la Agenda ofrece la inasistencia sólo cuando el servidor dice que se puede", () => {
  it("a las 09:00, recién reiniciada, NINGUNA fila tiene botón de inasistencia (§9.1, paso 1)", () => {
    const { nodes, hooks } = montar([...AGENDA_IDS]);
    hooks.renderAgenda(snapInicial);
    for (const fila of filasDeAgenda(nodes)) {
      expect(botonesDe(fila)).not.toContain("Registrar inasistencia");
      expect(botonesDe(fila)).not.toContain("Corregir registro");
    }
  });

  it("con el reloj en 10:00 hay EXACTAMENTE una fila con «Registrar inasistencia», y es la que ya terminó", () => {
    const { nodes, hooks } = montar([...AGENDA_IDS]);
    hooks.renderAgenda(snapReloj);
    const conBoton = filasDeAgenda(nodes)
      .filter((tr) => botonesDe(tr).includes("Registrar inasistencia"))
      .map((tr) => tr.getAttribute("data-key"));
    expect(conBoton).toEqual(["demo-salon-res-1"]);
    // `demo-salon-res-3` (10:00-10:30) todavía no ha terminado: ni botón, ni
    // botón deshabilitado, ni insinuación.
    expect(botonesDe(filaDe(nodes, "demo-salon-res-3"))).toEqual(["Cancelar cita"]);
    // Y la elegibilidad la trae RESUELTA el servidor, no la deduce la pantalla.
    const reservas = (snapReloj.calendar as Json).reservations as Json[];
    const elegibles = reservas.filter((r) => r.eligibleForNoShow === true).map((r) => r.id);
    expect(elegibles).toEqual(["demo-salon-res-1"]);
  });

  it("con la inasistencia anotada aparece la píldora y «Corregir registro», y ya no se ofrece anotar otra vez", () => {
    const { nodes, hooks } = montar([...AGENDA_IDS]);
    hooks.renderAgenda(snapAnotada);
    const fila = filaDe(nodes, "demo-salon-res-1");
    expect(todoElTexto(fila.children[3])).toContain("Inasistencia registrada");
    expect(botonesDe(fila)).toEqual(["Cancelar cita", "Corregir registro"]);
  });

  it("una cita CANCELADA no ofrece anotar inasistencia, aunque la hora haya pasado (transición prohibida 3, K17)", () => {
    const { nodes, hooks } = montar([...AGENDA_IDS]);
    hooks.renderAgenda(snapReloj);
    const fila = filaDe(nodes, "demo-salon-res-7-cancelada");
    expect(botonesDe(fila)).toEqual([]);
    expect(todoElTexto(fila.children[3])).toContain("Cancelada");
  });

  it("criterio 8.40 — al reconciliar, la fila NO conserva la píldora ni el botón anteriores", () => {
    const m = montar([...AGENDA_IDS]);
    // Misma pantalla, tres instantáneas seguidas: el <tr> se REUTILIZA.
    m.hooks.renderAgenda(snapReloj);
    const antes = filaDe(m.nodes, "demo-salon-res-1");
    expect(botonesDe(antes)).toContain("Registrar inasistencia");

    m.hooks.renderAgenda(snapAnotada);
    const conRegistro = filaDe(m.nodes, "demo-salon-res-1");
    expect(conRegistro).toBe(antes);
    expect(botonesDe(conRegistro)).not.toContain("Registrar inasistencia");
    expect(todoElTexto(conRegistro.children[3])).toContain("Inasistencia registrada");

    m.hooks.renderAgenda(snapCorregida);
    const corregida = filaDe(m.nodes, "demo-salon-res-1");
    expect(corregida).toBe(antes);
    // Ni la píldora vieja, ni el botón de corregir, ni el de anotar.
    expect(todoElTexto(corregida.children[3])).not.toContain("Inasistencia registrada.");
    expect(todoElTexto(corregida.children[3])).toContain("Registro corregido: no fue una inasistencia");
    expect(botonesDe(corregida)).toEqual(["Cancelar cita"]);
  });

  it("el estado nunca lo lleva sólo el color: la píldora trae glifo Y texto, y nunca es la roja de alarma", () => {
    const { nodes, hooks } = montar([...AGENDA_IDS]);
    hooks.renderAgenda(snapAnotada);
    const pildoras = filaDe(nodes, "demo-salon-res-1").children[3].children;
    const pildora = pildoras[pildoras.length - 1];
    expect(pildora.className).toContain("tx-pill--attention");
    expect(pildora.className).not.toContain("tx-pill--error");
    expect(pildora.children.length).toBe(2);
    expect(pildora.children[0].getAttribute("aria-hidden")).toBe("true");
    expect(pildora.children[1].textContent).toBe("Inasistencia registrada");
  });
});

// =====================================================================
// §5.3 — Los dos diálogos
// =====================================================================

describe("step 18 §5.3 — el diálogo de anotar dice la verdad entera antes de confirmar", () => {
  function reservaDe(snap: Json, id: string): Json {
    const reservas = (snap.calendar as Json).reservations as Json[];
    const r = reservas.find((x) => x.id === id);
    expect(r, `no existe ${id} en la instantánea`).toBeDefined();
    return r as Json;
  }

  async function abierto(snap: Json, id = "demo-salon-res-1"): Promise<Montaje> {
    const app = freshApp();
    const m = montar([...INASISTENCIA_IDS, ...AGENDA_IDS]);
    m.hooks.wireInasistenciaDialog();
    m.hooks.wireCorregirInasistenciaDialog();
    // `refresh()` deja la instantánea guardada: de ahí lee el diálogo su copia.
    await conFetch(fetchContraLaApp(app), () => m.hooks.refresh());
    await app.close();
    m.hooks.abrirDialogoInasistencia(reservaDe(snap, id), m.nodes["tx-view-title"]);
    return m;
  }

  it("las cuatro frases del §2.11 se leen enteras, y salen de operations.noShows.copy, no de la pantalla", async () => {
    const app = freshApp();
    const m = montar([...INASISTENCIA_IDS]);
    m.hooks.wireInasistenciaDialog();
    await conFetch(fetchContraLaApp(app), () => m.hooks.refresh());
    const snap = await snapshotOf(app);
    await app.close();
    m.hooks.abrirDialogoInasistencia(reservaDe(snapReloj, "demo-salon-res-1"), m.nodes["tx-view-title"]);

    const copy = ((snap.operations as Json).noShows as Json).copy as Record<string, string>;
    expect(m.nodes["inasistencia-manual"].textContent).toBe(copy.manualOnly);
    expect(m.nodes["inasistencia-sin-penalizacion"].textContent).toBe(copy.noPenalty);
    expect(m.nodes["inasistencia-sin-identidad"].textContent).toBe(copy.noClientIdentity);
    expect(m.nodes["inasistencia-historial"].textContent).toBe(copy.correctionKeepsHistory);
    // Y la del servidor es, carácter a carácter, la del catálogo cerrado.
    expect(copy.noPenalty).toBe(OPERATIONS_COPY.noPenalty);
    expect(copy.noPenalty).toBe(
      "No se ha aplicado ninguna penalización. La política de inasistencias está pendiente de decidir con Demo Salon.",
    );
  });

  it("dice QUÉ cita es, con su día, sus horas, su profesional y su servicio, y la llama sintética", async () => {
    const m = await abierto(snapReloj);
    expect(m.nodes["inasistencia-resumen"].textContent).toBe(
      "Cita sintética: martes, 4 de agosto de 2026, 09:30–10:00, con Álex (sintético). Servicio: Corte de pelo.",
    );
  });

  it("abrir el diálogo NO escribe nada: hasta la confirmación explícita, el historial no se mueve", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/lab/clock/advance",
      payload: { command: "advance_to_reservation_end", reservationId: "demo-salon-res-1" },
    });
    const antes = await snapshotOf(app);
    const m = montar([...INASISTENCIA_IDS]);
    m.hooks.wireInasistenciaDialog();
    await conFetch(fetchContraLaApp(app), () => m.hooks.refresh());
    m.hooks.abrirDialogoInasistencia(reservaDe(antes, "demo-salon-res-1"), m.nodes["tx-view-title"]);
    expect(m.nodes["dialogo-inasistencia"].open).toBe(true);

    const despues = await snapshotOf(app);
    expect(((despues.operations as Json).audit as Json).total).toBe(((antes.operations as Json).audit as Json).total);
    expect(((despues.operations as Json).noShows as Json).records).toEqual([]);
    await app.close();
  });

  it("confirmar acuña LA CLAVE DEL SERVIDOR (noShowKeyToMint) y canta el resultado del catálogo", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/lab/clock/advance",
      payload: { command: "advance_to_reservation_end", reservationId: "demo-salon-res-1" },
    });
    const m = montar([...INASISTENCIA_IDS]);
    m.hooks.wireInasistenciaDialog();
    const registro: PeticionRegistrada[] = [];
    const f = fetchContraLaApp(app, registro);
    await conFetch(f, () => m.hooks.refresh());
    const snap = await snapshotOf(app);
    const reserva = reservaDe(snap, "demo-salon-res-1");
    expect(reserva.noShowKeyToMint).toBe("noshow:demo-salon-res-1:v0");

    m.hooks.abrirDialogoInasistencia(reserva, m.nodes["tx-view-title"]);
    await conFetch(f, () => m.hooks.confirmarInasistencia() ?? Promise.resolve());

    const escritura = registro.find((p) => p.url === "/api/reservations/demo-salon-res-1/no-show");
    expect(escritura?.key).toBe("noshow:demo-salon-res-1:v0");
    expect(escritura?.body).toEqual({ confirmed: true });
    expect(m.nodes["inasistencia-estado"].textContent).toBe(OPERATIONS_COPY.recordedResult);
    expect(m.nodes["inasistencia-estado"].className).toContain("tx-status-line--ok");
    // El diálogo no se cierra solo, pero la acción ya no se puede repetir
    // desde aquí: el botón de confirmar desaparece y aparece el de cerrar.
    expect(m.nodes["inasistencia-confirmar"].hidden).toBe(true);
    expect(m.nodes["inasistencia-cerrar"].hidden).toBe(false);
    expect(m.document.activeElement).toBe(m.nodes["inasistencia-cerrar"]);
    await app.close();
  });

  it("N5 — un doble envío se canta como repetición, NUNCA como si acabara de pasar", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/lab/clock/advance",
      payload: { command: "advance_to_reservation_end", reservationId: "demo-salon-res-1" },
    });
    const m = montar([...INASISTENCIA_IDS]);
    m.hooks.wireInasistenciaDialog();
    const f = fetchContraLaApp(app);
    await conFetch(f, () => m.hooks.refresh());
    const reserva = reservaDe(await snapshotOf(app), "demo-salon-res-1");

    m.hooks.abrirDialogoInasistencia(reserva, m.nodes["tx-view-title"]);
    await conFetch(f, () => m.hooks.confirmarInasistencia() ?? Promise.resolve());
    expect(m.nodes["inasistencia-estado"].textContent).toBe(OPERATIONS_COPY.recordedResult);

    // Segunda vez, con la MISMA clave (la pantalla vuelve a leerla de la
    // reserva que tiene delante): el transporte contesta `replayed`.
    m.hooks.abrirDialogoInasistencia(reserva, m.nodes["tx-view-title"]);
    await conFetch(f, () => m.hooks.confirmarInasistencia() ?? Promise.resolve());
    expect(m.nodes["inasistencia-estado"].textContent).toBe(OPERATIONS_COPY.repeatedResult);
    expect(m.nodes["inasistencia-estado"].textContent).not.toContain("Inasistencia registrada.");

    // Y en el mundo hay UN registro y UN evento de anotación.
    const snap = await snapshotOf(app);
    expect((((snap.operations as Json).noShows as Json).records as Json[]).length).toBe(1);
    expect(((snap.operations as Json).metrics as Json).noShowRecordCommands).toBe(1);
    await app.close();
  });

  it("el segundo clic seguido NO manda una segunda petición: el botón se deshabilita mientras va la primera", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/lab/clock/advance",
      payload: { command: "advance_to_reservation_end", reservationId: "demo-salon-res-1" },
    });
    const m = montar([...INASISTENCIA_IDS]);
    m.hooks.wireInasistenciaDialog();
    const registro: PeticionRegistrada[] = [];
    const f = fetchContraLaApp(app, registro);
    await conFetch(f, () => m.hooks.refresh());
    m.hooks.abrirDialogoInasistencia(reservaDe(await snapshotOf(app), "demo-salon-res-1"), m.nodes["tx-view-title"]);

    await conFetch(f, async () => {
      const primera = m.hooks.confirmarInasistencia();
      // El segundo clic entra ANTES de que la primera resuelva.
      const segunda = m.hooks.confirmarInasistencia();
      expect(segunda).toBeUndefined();
      await (primera ?? Promise.resolve());
    });
    const escrituras = registro.filter((p) => p.url === "/api/reservations/demo-salon-res-1/no-show");
    expect(escrituras.length).toBe(1);
    await app.close();
  });

  it("el diálogo de corregir avisa de que es DEFINITIVO antes de confirmar (K3), y dice cuándo se anotó", async () => {
    const app = freshApp();
    const m = montar([...INASISTENCIA_IDS]);
    m.hooks.wireCorregirInasistenciaDialog();
    const f = fetchContraLaApp(app);
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/lab/clock/advance",
      payload: { command: "advance_to_reservation_end", reservationId: "demo-salon-res-1" },
    });
    await app.inject({
      method: "POST",
      url: "/api/reservations/demo-salon-res-1/no-show",
      payload: { confirmed: true },
      headers: { "idempotency-key": "noshow:demo-salon-res-1:v0" },
    });
    await conFetch(f, () => m.hooks.refresh());
    const snap = await snapshotOf(app);
    const reserva = reservaDe(snap, "demo-salon-res-1");
    m.hooks.abrirDialogoCorregirInasistencia(reserva, m.nodes["tx-view-title"]);

    expect(m.nodes["corregir-inasistencia-definitivo"].textContent).toBe(OPERATIONS_COPY.correctionIsFinal);
    expect(m.nodes["corregir-inasistencia-definitivo"].textContent).toContain("reinicia la demostración");
    expect(m.nodes["corregir-inasistencia-historial"].textContent).toBe(OPERATIONS_COPY.correctionKeepsHistory);
    expect(m.nodes["corregir-inasistencia-cuando"].textContent).toBe(
      "Se anotó como inasistencia el martes, 4 de agosto de 2026 a las 10:00.",
    );

    // Y corregir de verdad, con la clave del servidor.
    expect(reserva.noShowFixKeyToMint).toBe("noshow-fix:demo-salon-res-1:v0");
    await conFetch(f, () => m.hooks.confirmarCorregirInasistencia() ?? Promise.resolve());
    expect(m.nodes["corregir-inasistencia-estado"].textContent).toBe(OPERATIONS_COPY.correctedResult);

    const despues = await snapshotOf(app);
    const registros = ((despues.operations as Json).noShows as Json).records as Json[];
    expect(registros.length).toBe(1);
    expect(registros[0].state).toBe("corrected_not_a_no_show");
    await app.close();
  });

  it("cerrar el diálogo devuelve el foco a quien lo abrió, venga de un botón o del Escape nativo", async () => {
    const app = freshApp();
    const m = montar([...INASISTENCIA_IDS, ...AGENDA_IDS]);
    m.hooks.wireInasistenciaDialog();
    await conFetch(fetchContraLaApp(app), () => m.hooks.refresh());
    await app.close();
    // El disparador vive dentro de la página, como el botón de una fila: un
    // nodo suelto NO recibe el foco, y el cliente lo comprueba a propósito.
    const disparador = m.document.createElement("button");
    m.nodes["tx-view-title"].appendChild(disparador);
    m.hooks.abrirDialogoInasistencia(reservaDe(snapReloj, "demo-salon-res-1"), disparador);
    expect(m.document.activeElement).toBe(m.nodes["dialogo-inasistencia-titulo"]);
    // `close()` emite el evento `close`, que es donde el cliente engancha la
    // restauración: exactamente el mismo camino que recorre el Escape nativo.
    m.nodes["dialogo-inasistencia"].close();
    expect(m.document.activeElement).toBe(disparador);
  });

  it("los tres conflictos se dicen con las palabras del servidor, y ninguno afirma que se haya escrito algo", () => {
    const app = freshApp();
    const m = montar([...INASISTENCIA_IDS]);
    void app.close();
    // Sin instantánea cargada, la función cae al texto genérico y NO inventa
    // una frase de política: es el camino honesto.
    const sinSnap = m.hooks.textoDeFalloInasistencia({ status: 409, json: { conflict: "reservation_not_finished_yet" } });
    expect(sinSnap).toContain("No se ha guardado nada.");

    expect(
      m.hooks.textoDeFalloInasistencia({ status: 409, json: { conflict: "no_show_already_corrected" } }),
    ).toBe(
      "Esa cita ya tiene un registro corregido. Corregir es definitivo en esta demostración: no se puede volver a anotar. No se ha escrito nada.",
    );
  });

  it("con la instantánea cargada, los dos conflictos que el servidor sabe explicar salen con SU texto", async () => {
    const app = freshApp();
    const m = montar([...INASISTENCIA_IDS]);
    await conFetch(fetchContraLaApp(app), () => m.hooks.refresh());
    await app.close();
    expect(
      m.hooks.textoDeFalloInasistencia({ status: 409, json: { conflict: "reservation_not_finished_yet" } }),
    ).toBe(OPERATIONS_COPY.notFinishedYet);
    expect(
      m.hooks.textoDeFalloInasistencia({ status: 409, json: { conflict: "reservation_is_cancelled" } }),
    ).toBe(OPERATIONS_COPY.cancelledCannotBeNoShow);
  });
});

// =====================================================================
// §5.5 — Inicio
// =====================================================================

describe("step 18 §5.5 — Inicio dice UNA línea neutra, y sólo cuando hay algo que decir (K14)", () => {
  it("con cero inasistencias la línea está oculta y vacía: no se enseña un cero con forma de alarma", () => {
    const { nodes, hooks } = montar([...INICIO_IDS]);
    hooks.renderInicio(snapReloj);
    expect(((snapReloj.operations as Json).metrics as Json).homeLine).toBeNull();
    expect(nodes["inicio-inasistencias"].hidden).toBe(true);
    expect(nodes["inicio-inasistencias-texto"].textContent).toBe("");
  });

  it("con una anotada aparece la frase EXACTA del servidor, sin cifra de porcentaje ni color de alarma", () => {
    const { nodes, hooks } = montar([...INICIO_IDS]);
    hooks.renderInicio(snapAnotada);
    expect(nodes["inicio-inasistencias"].hidden).toBe(false);
    expect(nodes["inicio-inasistencias-texto"].textContent).toBe(
      "Inasistencias anotadas hoy: 1 (registro manual, sin penalización).",
    );
    expect(nodes["inicio-inasistencias"].className).not.toContain("alarm");
    expect(nodes["inicio-inasistencias"].textContent).not.toContain("%");
  });

  it("tras corregir, la línea vuelve a esconderse: no queda ningún resto del registro anterior", () => {
    const m = montar([...INICIO_IDS]);
    m.hooks.renderInicio(snapAnotada);
    expect(m.nodes["inicio-inasistencias"].hidden).toBe(false);
    m.hooks.renderInicio(snapCorregida);
    expect(m.nodes["inicio-inasistencias"].hidden).toBe(true);
    expect(m.nodes["inicio-inasistencias-texto"].textContent).toBe("");
  });

  it("Inicio sigue teniendo exactamente sus cuatro tarjetas de cifra: no se ha añadido ninguna", () => {
    const html = renderConsoleHtml();
    const inicio = html.slice(html.indexOf('id="vista-inicio"'), html.indexOf('id="vista-agenda"'));
    expect((inicio.match(/class="tx-stat"/g) ?? []).length).toBe(4);
  });
});

// =====================================================================
// §3.6 — Los dos relojes, cada uno con su rótulo
// =====================================================================

describe("step 18 §3.6 — la barra superior distingue el reloj de la demostración del de tu ordenador", () => {
  it("el reloj sintético dice la hora RESUELTA por el servidor y se rotula como de la demostración", () => {
    const { nodes, hooks } = montar([{ id: "tx-reloj-sintetico", tag: "p" }]);
    hooks.renderRelojSintetico(snapInicial);
    expect(nodes["tx-reloj-sintetico"].textContent).toBe("Reloj de la demostración: martes 4 de agosto, 09:00");

    hooks.renderRelojSintetico(snapReloj);
    expect(nodes["tx-reloj-sintetico"].textContent).toBe(
      "Reloj de la demostración: martes 4 de agosto, 10:00 (movido +1 h por ti)",
    );
  });

  it("el otro reloj se rotula como de tu ordenador, y NO es el mismo nodo", () => {
    const { nodes, hooks } = montar([{ id: "tx-freshness", tag: "p" }]);
    hooks.renderFreshness(true);
    expect(nodes["tx-freshness"].textContent).toMatch(
      /^Pantalla actualizada a las \d{2}:\d{2}:\d{2} \(hora de tu ordenador\)$/,
    );
  });

  it("el reloj sintético NO es una región viva: repintarlo cada dos segundos no puede anunciar nada", () => {
    const html = renderConsoleHtml();
    const tag = /<p[^>]*id="tx-reloj-sintetico"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toContain("aria-live");
    expect(tag).not.toContain("role=");
  });
});

// =====================================================================
// §5.6 / §3.5 — El Laboratorio
// =====================================================================

describe("step 18 §5.6 — el panel del reloj dice lo que va a pasar ANTES de mover nada", () => {
  it("enseña la hora sintética actual y el aviso de los huecos que quedan atrás, antes de avanzar", () => {
    const { nodes, hooks } = montar([...LAB_RELOJ_IDS]);
    hooks.renderPanelDelReloj(snapInicial);
    expect(nodes["lab-reloj-ahora"].textContent).toBe(
      "Ahora mismo, en esta demostración, son las martes 4 de agosto, 09:00.",
    );
    expect(nodes["lab-reloj-aviso"].textContent).toBe(OPERATIONS_COPY.clockOnlyForwards);
    expect(nodes["lab-tecnico-endpoint"].textContent).toBe(OPERATIONS_COPY.clockEndpointIsWider);
    // El aviso está a la vista, no escondido tras el botón.
    expect(nodes["lab-reloj-aviso"].hidden).toBe(false);
  });

  it("las notas fijas del §5.6 están en el HTML servido, como texto estático", () => {
    const html = renderConsoleHtml();
    for (const frase of [
      "Solo afecta a esta demostración local.",
      "Sólo avanza cuando lo mueves tú.",
      "No puede retroceder. Para volver al principio, reinicia la demostración.",
      "Esto es sólo de la demostración local: no cambia la hora de tu ordenador ni la de ningún sistema.",
      "Mover el reloj no anota ninguna inasistencia: sólo hace que se pueda anotar.",
    ]) {
      expect(html.includes(frase), `falta la nota fija: ${frase}`).toBe(true);
    }
  });

  it("el selector de citas lista las CONFIRMADAS de hoy, con su hora y su profesional, nunca con su identificador", async () => {
    const app = freshApp();
    const { nodes, hooks } = montar([...LAB_RELOJ_IDS]);
    // Los nombres del equipo salen de la instantánea guardada, no de una copia.
    await conFetch(fetchContraLaApp(app), () => hooks.refresh());
    await app.close();
    hooks.renderPanelDelReloj(snapInicial);
    const opciones = nodes["lab-reloj-cita"].children;
    expect(opciones[0].textContent).toBe("(elige una cita de hoy)");
    const textos = opciones.slice(1).map((o) => o.textContent);
    expect(textos[0]).toBe("09:30–10:00 · Álex (sintético) · Corte de pelo");
    for (const t of textos) expect(t).not.toContain("demo-salon-res-");
    // La cancelada no está: no tiene final que alcanzar.
    expect(textos.some((t) => t.includes("15:00"))).toBe(false);
  });

  it("el botón no se activa hasta que hay una orden, y el HTML dice por qué", () => {
    const { nodes, hooks } = montar([...LAB_RELOJ_IDS]);
    hooks.wireRelojLabControls();
    hooks.renderPanelDelReloj(snapInicial);
    expect(nodes["lab-reloj-avanzar"].disabled).toBe(true);

    // El motivo es texto ESTÁTICO del HTML servido, y el botón lo referencia
    // con aria-describedby: un botón gris sin cartel es una puerta cerrada sin
    // explicación.
    const html = renderConsoleHtml();
    const tag = /<button[^>]*id="lab-reloj-avanzar"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toMatch(/\sdisabled(\s|>)/);
    expect(tag).toContain('aria-describedby="lab-reloj-gate"');
    expect(html).toContain("El botón no se activa hasta que elijas un salto o una cita.");
  });

  it("avanzar el reloj usa la ruta REAL, dice la hora nueva del servidor y recuerda que no ha anotado nada", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = montar([...LAB_RELOJ_IDS, ...AGENDA_IDS]);
    m.hooks.wireRelojLabControls();
    const registro: PeticionRegistrada[] = [];
    const f = fetchContraLaApp(app, registro);
    await conFetch(f, () => m.hooks.refresh());
    m.hooks.renderPanelDelReloj(await snapshotOf(app));

    // (Enmienda de fase K, H3) Elegir un salto es elegirlo DE VERDAD: se pone
    // el valor y se emite el `change`, que es lo que enciende el botón. Antes
    // bastaba con el valor porque `avanzarElReloj` no miraba el botón; ahora
    // lleva la guarda de reentrada de las otras tres acciones, así que la
    // prueba recorre el camino que recorre una persona.
    m.nodes["lab-reloj-salto"].value = "60";
    m.nodes["lab-reloj-salto"].dispatchChange();
    expect(m.nodes["lab-reloj-avanzar"].disabled).toBe(false);
    await conFetch(f, () => m.hooks.avanzarElReloj() ?? Promise.resolve());

    const peticion = registro.find((p) => p.url === "/api/lab/clock/advance");
    expect(peticion?.body).toEqual({ command: "advance_minutes", minutes: 60 });
    // Sin clave de idempotencia, y a propósito: un delta repetido debe volver
    // a avanzar (§3.5).
    expect(peticion?.key).toBeNull();
    expect(m.nodes["lab-reloj-estado"].textContent).toBe(
      "El reloj de la demostración marca ahora martes 4 de agosto, 10:00. No se ha anotado ninguna inasistencia: mover el reloj sólo hace que se pueda anotar.",
    );
    // Y no ha anotado nada de verdad, no sólo lo dice.
    const snap = await snapshotOf(app);
    expect(((snap.operations as Json).noShows as Json).records).toEqual([]);
    await app.close();
  });

  it("un reloj que no puede retroceder lo dice con las dos horas y manda a reiniciar, sin moverse", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/lab/clock/advance",
      payload: { command: "advance_minutes", minutes: 240 },
    });
    const m = montar([...LAB_RELOJ_IDS]);
    m.hooks.wireRelojLabControls();
    const f = fetchContraLaApp(app);
    await conFetch(f, () => m.hooks.refresh());
    m.hooks.renderPanelDelReloj(await snapshotOf(app));

    // (Enmienda de fase K, H3) Igual que arriba: elegir la cita emite su
    // `change`, que es lo que enciende el botón que ahora se comprueba.
    m.nodes["lab-reloj-cita"].value = "demo-salon-res-1";
    m.nodes["lab-reloj-cita"].dispatchChange();
    await conFetch(f, () => m.hooks.avanzarElReloj() ?? Promise.resolve());
    const texto = m.nodes["lab-reloj-estado"].textContent;
    expect(texto).toContain("no puede retroceder");
    expect(texto).toContain("martes 4 de agosto, 13:00");
    expect(texto).toContain("reinicia la demostración");
    expect(m.nodes["lab-reloj-estado"].className).toContain("tx-status-line--conflict");

    const snap = await snapshotOf(app);
    expect(((snap.operations as Json).clock as Json).minutes).toBe(780);
    await app.close();
  });

  it("el TERCER historial se pinta aparte, con el texto castellano que compone el servidor", () => {
    const { nodes, hooks } = montar([...LAB_RELOJ_IDS]);
    hooks.renderHistorialDeOperaciones(snapAnotada);
    const lineas = nodes["lab-operaciones-lista"].children.map((li) => li.textContent);
    expect(nodes["lab-operaciones-vacio"].hidden).toBe(true);
    expect(lineas.some((l) => l.includes("ha anotado una inasistencia"))).toBe(true);
    expect(lineas.some((l) => l.includes("El reloj de la demostración ha pasado de las 09:00 a las 10:00"))).toBe(true);
    // El vocabulario técnico vive aquí, en Laboratorio, y eso es correcto (P3).
    expect(lineas.some((l) => l.includes("NO_SHOW_RECORDED"))).toBe(true);
  });

  it("un historial vacío enseña su estado vacío en vez de una lista muda", () => {
    const { nodes, hooks } = montar([...LAB_RELOJ_IDS]);
    hooks.renderHistorialDeOperaciones({ operations: { audit: { items: [] } } });
    expect(nodes["lab-operaciones-vacio"].hidden).toBe(false);
    expect(nodes["lab-operaciones-lista"].children.length).toBe(0);
  });
});

// =====================================================================
// Enmienda de fase K (H3) — el panel del reloj, endurecido
// =====================================================================

describe("step 18 · enmienda de fase K (H3) — el selector de citas no se reconstruye cada dos segundos", () => {
  it("repintar con las MISMAS citas no toca ni un <option>, y la elección sobrevive", () => {
    const { nodes, hooks } = montar([...LAB_RELOJ_IDS]);
    hooks.renderPanelDelReloj(snapInicial);
    const primeras = [...nodes["lab-reloj-cita"].children];
    expect(primeras.length).toBeGreaterThan(1);
    nodes["lab-reloj-cita"].value = "demo-salon-res-1";

    // El sondeo repinta: mismas citas, misma lista. La guarda de igualdad
    // —la de `ensureProfessionalOptions`— sale sin tocar nada.
    hooks.renderPanelDelReloj(snapInicial);
    const segundas = nodes["lab-reloj-cita"].children;
    expect(segundas.length).toBe(primeras.length);
    segundas.forEach((opcion, i) => {
      expect(opcion === primeras[i], `la opción ${String(i)} se ha reconstruido`).toBe(true);
    });
    expect(nodes["lab-reloj-cita"].value).toBe("demo-salon-res-1");
  });

  it("cuando las citas de hoy CAMBIAN sí se reconstruye: la guarda protege el foco, no congela la pantalla", () => {
    const { nodes, hooks } = montar([...LAB_RELOJ_IDS]);
    hooks.renderPanelDelReloj(snapInicial);
    const primeras = [...nodes["lab-reloj-cita"].children];
    nodes["lab-reloj-cita"].value = "demo-salon-res-1";

    // La misma instantánea con una cita menos: la lista tiene que cambiar.
    const conUnaMenos = JSON.parse(JSON.stringify(snapInicial)) as Json;
    (conUnaMenos.calendar as Json).reservations = ((conUnaMenos.calendar as Json).reservations as Json[]).filter(
      (r) => r.id !== "demo-salon-res-1",
    );
    hooks.renderPanelDelReloj(conUnaMenos);

    const segundas = nodes["lab-reloj-cita"].children;
    expect(segundas.length).toBe(primeras.length - 1);
    expect(segundas.map((o) => o.value)).not.toContain("demo-salon-res-1");
    // Y la elección que ya no existe no se finge: se vacía.
    expect(nodes["lab-reloj-cita"].value).toBe("");
  });
});

describe("step 18 · enmienda de fase K (H3) — un avance en vuelo no se puede repetir", () => {
  it("el botón apagado no manda nada, y el sondeo no lo reactiva mientras la petición está en vuelo", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = montar([...LAB_RELOJ_IDS]);
    m.hooks.wireRelojLabControls();

    const registro: PeticionRegistrada[] = [];
    const real = fetchContraLaApp(app, registro) as unknown as (u: string, i?: unknown) => Promise<unknown>;
    const avances = () => registro.filter((p) => p.url === "/api/lab/clock/advance").length;
    // Un `fetch` que RETIENE la petición de avanzar hasta que la prueba la
    // suelta: es la ventana entre el clic y su respuesta, que es donde vivía
    // el defecto.
    let soltar: () => void = () => {
      throw new Error("la petición de avanzar el reloj no llegó a salir");
    };
    /** Cuántas peticiones de avanzar SALEN del cliente, aunque aún no hayan llegado. */
    let salidas = 0;
    const retenido = ((url: string, init?: unknown) => {
      if (url === "/api/lab/clock/advance") {
        salidas += 1;
        return new Promise((resolve) => {
          soltar = () => resolve(real(url, init));
        });
      }
      return real(url, init);
    }) as unknown as typeof fetch;

    await conFetch(real as unknown as typeof fetch, () => m.hooks.refresh());
    m.hooks.renderPanelDelReloj(await snapshotOf(app));
    // Con el botón apagado (nada elegido), un clic no manda absolutamente nada.
    expect(m.nodes["lab-reloj-avanzar"].disabled).toBe(true);
    expect(m.hooks.avanzarElReloj()).toBeUndefined();
    expect(avances()).toBe(0);

    m.nodes["lab-reloj-salto"].value = "60";
    m.nodes["lab-reloj-salto"].dispatchChange();
    expect(m.nodes["lab-reloj-avanzar"].disabled).toBe(false);

    // El `fetch` se cambia a mano (y no con `conFetch`) porque esta prueba
    // necesita quedarse DENTRO de la petición en vuelo, sin esperarla.
    const original = globalThis.fetch;
    globalThis.fetch = retenido;
    let enVuelo: Promise<void> | undefined;
    try {
      enVuelo = m.hooks.avanzarElReloj();
      // Mientras la petición está en vuelo: el botón está apagado, un segundo
      // clic no manda una segunda petición, y el sondeo —que repinta el panel
      // entero cada dos segundos— tampoco lo vuelve a encender.
      expect(m.nodes["lab-reloj-avanzar"].disabled).toBe(true);
      expect(m.hooks.avanzarElReloj()).toBeUndefined();
      m.hooks.renderPanelDelReloj(snapInicial);
      expect(m.nodes["lab-reloj-avanzar"].disabled).toBe(true);
      // UNA sola petición ha salido del cliente, y sigue sin respuesta.
      expect(salidas).toBe(1);
      expect(avances()).toBe(0);
      expect(m.nodes["lab-reloj-estado"].textContent).toBe("Moviendo el reloj…");

      // Se suelta la respuesta: el repintado posterior habla con el servidor
      // de verdad, y el reloj se ha movido UNA vez.
      globalThis.fetch = real as unknown as typeof fetch;
      soltar();
      await enVuelo;
    } finally {
      globalThis.fetch = original;
    }
    expect(salidas).toBe(1);
    expect(avances()).toBe(1);
    expect(m.nodes["lab-reloj-avanzar"].disabled).toBe(true);
    expect(((await snapshotOf(app)).operations as Json).clock).toMatchObject({ minutes: 600 });
    await app.close();
  });
});

// =====================================================================
// Vocabulario y disciplina de origen
// =====================================================================

describe("step 18 §2.11 / criterio 8.11 — el vocabulario prohibido no llega a la pantalla", () => {
  /**
   * La lista del §2.11. «penaliz» NO está: la única forma en que aparece es
   * dentro de la frase que NIEGA que exista una, que es el sentido entero de
   * esta función y tiene que estar a la vista.
   */
  const PROHIBIDAS = ["sanción", "bloquear", "reincid", "fiable", "tasa", "coste", "pérdida", "€"];

  it("ni en las superficies pintadas de la Agenda, ni en los diálogos, ni en Inicio", () => {
    for (const snap of [snapReloj, snapAnotada, snapCorregida]) {
      const { nodes, hooks } = montar([...AGENDA_IDS, ...INICIO_IDS]);
      hooks.renderAgenda(snap);
      hooks.renderInicio(snap);
      for (const id of Object.keys(nodes)) {
        for (const texto of textosVisibles(nodes[id])) {
          for (const palabra of PROHIBIDAS) {
            expect(texto.toLowerCase().includes(palabra), `'${palabra}' se ve en #${id}: "${texto}"`).toBe(false);
          }
        }
      }
    }
  });

  it("ni en el catálogo de textos del servidor, salvo la negación de la penalización", () => {
    const todos = Object.values(OPERATIONS_COPY).join(" ").toLowerCase();
    for (const palabra of PROHIBIDAS) {
      expect(todos.includes(palabra), `'${palabra}' está en OPERATIONS_COPY`).toBe(false);
    }
    expect(OPERATIONS_COPY.noPenalty).toContain("No se ha aplicado ninguna penalización");
  });

  it("criterio 8.41 — ningún identificador interno se pinta en la Agenda", () => {
    for (const snap of [snapReloj, snapAnotada, snapCorregida]) {
      const { nodes, hooks } = montar([...AGENDA_IDS]);
      hooks.renderAgenda(snap);
      for (const id of Object.keys(nodes)) {
        for (const texto of textosVisibles(nodes[id])) {
          for (const token of ["nsh-", "slot-2026", "grp-", "res-g-", "corrected_not_a_no_show", "recorded", "noshow:"]) {
            expect(texto.includes(token), `'${token}' se ve en #${id}: "${texto}"`).toBe(false);
          }
        }
      }
    }
  });

  it("criterio 8.20 — la Agenda no calcula la elegibilidad: la lee, y no toca aritmética de inasistencias", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("function pintarCeldaAccionAgenda");
    const fin = js.indexOf("function renderAgenda", inicio);
    expect(inicio).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(inicio);
    const cuerpo = js.slice(inicio, fin);
    // Lee la respuesta del servidor…
    expect(cuerpo).toContain("r.eligibleForNoShow");
    // …y no la recalcula: ni resta de minutos, ni comparación con el reloj,
    // ni ninguna de las dos funciones de horario del local.
    for (const prohibido of ["engineNowMinutes", "endMinutes", "daysBetween", "resolveVenueDay", "venueWeekdayHours"]) {
      expect(cuerpo.includes(prohibido), `pintarCeldaAccionAgenda usa '${prohibido}'`).toBe(false);
    }
  });

  it("las claves de idempotencia NUNCA se derivan en el navegador: se leen de la proyección", () => {
    const js = renderConsoleAppJs();
    // No hay ni un literal que empiece por 'noshow' en el JavaScript servido:
    // las dos claves llegan resueltas (decisión N3, bloqueador B3).
    expect(js).not.toContain("'noshow:'");
    expect(js).not.toContain("'noshow-fix:'");
    expect(js).toContain("reserva.noShowKeyToMint");
    expect(js).toContain("reserva.noShowFixKeyToMint");
  });
});
