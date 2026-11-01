import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { CONSOLE_CSS } from "../../src/console/ui.css.js";
import { WORKSHOP_COPY } from "../../src/console/demoWorkspace.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks, type UiTestHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeDocument, FakeElement } from "./fakeDom.js";

/**
 * step 20 · C — el panel «Taller de decisiones con Bruno» (diseño §3, §9.3 y
 * §9.6).
 *
 * Cubre: el estado inicial vacío en todos los momentos de la tabla de I20-4
 * (arranque, sondeos, cambio de ruta, reinicio con borrador vacío); que el
 * reinicio con borrador a medias lo deja INTACTO — marcas, notas, filtro y
 * búsqueda (D20-27); la guarda de huella (D20-20: el sondeo no repinta); que
 * el borrador sobrevive a un repintado forzado por cambio de huella; que un
 * repintado no duplica el efecto de una pulsación (D20-51, manejadores por
 * propiedad); el foco a salvo al repintar y al filtrar (§3.11); los cinco
 * filtros y la búsqueda tolerante a acentos (D20-22/D20-23), que NO busca
 * dentro de las opciones; la cobertura con J5/K1 contando por dos y L1
 * aparte (D20-31); el borrado por tarjeta (nunca deshabilitado, D20-29) y el
 * total tras diálogo (D20-30); el estado vacío honesto (§3.13); las entradas
 * huérfanas; una sola locución por acción; el barrido I20-15 de persistencia
 * y canales laterales sobre el bloque del taller; que ninguna petición nace
 * del panel (I20-6/I20-7); y los contratos de DOM y CSS del §9.6 (leyendas
 * distintas, radios sin marcar, trato visual idéntico de las opciones —
 * I20-5 — y cero @media nuevos).
 */

const TEST_SALT = "taller-ui-test-salt";

type Json = Record<string, unknown>;

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
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

/** Un fetch que habla con el servidor REAL por app.inject(), con registro opcional. */
function fetchContraLaApp(app: FastifyInstance, registro?: string[]): typeof fetch {
  return (async (url: string, init?: { method?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (registro) registro.push(`${method} ${url}`);
    const res = await app.inject({ method: method as "GET", url });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      headers: { get: (k: string) => res.headers[k.toLowerCase()] ?? null },
      json: () => Promise.resolve(res.body === "" ? {} : (JSON.parse(res.body) as unknown)),
    };
  }) as unknown as typeof fetch;
}

async function conFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Los ids que el cliente busca en el HTML real (D20-45, lista cerrada del
// panel) más lo que la secuencia de reinicio toca sin mirar la ruta — las
// mismas listas que ya usa resetAccesible.test.ts.
// ---------------------------------------------------------------------

const TALLER_IDS = [
  { id: "tx-taller-filtro-todas", tag: "button" },
  { id: "tx-taller-filtro-bloquean", tag: "button" },
  { id: "tx-taller-filtro-esperan", tag: "button" },
  { id: "tx-taller-filtro-sin-respuesta", tag: "button" },
  { id: "tx-taller-filtro-anotadas", tag: "button" },
  { id: "tx-taller-buscar", tag: "input" },
  { id: "tx-taller-estado", tag: "p" },
  { id: "tx-taller-cobertura", tag: "div" },
  { id: "tx-taller-vacio", tag: "div" },
  { id: "tx-taller-lista", tag: "div" },
  { id: "tx-taller-borrar-todo", tag: "button" },
  // (Fase 7, §4/§5) Las dos acciones de copia: botón, línea de estado y
  // respaldo de cada una — los seis ids restantes de la lista cerrada de
  // D20-45.
  { id: "tx-taller-copiar-acta", tag: "button" },
  { id: "tx-taller-acta-estado", tag: "p" },
  { id: "tx-taller-acta-respaldo", tag: "textarea" },
  { id: "tx-taller-copiar-mision", tag: "button" },
  { id: "tx-taller-mision-estado", tag: "p" },
  { id: "tx-taller-mision-respaldo", tag: "textarea" },
  { id: "dialogo-taller-borrar", tag: "dialog" },
  { id: "dialogo-taller-borrar-titulo", tag: "h2" },
  { id: "tx-taller-borrar-resumen", tag: "p" },
  { id: "tx-taller-borrar-cancelar", tag: "button" },
  { id: "tx-taller-borrar-confirmar", tag: "button" },
] as const;

/** Lo que renderLaboratorio toca SIN guarda de nulo (mismo patrón que resetAccesible). */
const LABORATORIO_MINIMOS = [
  { id: "lab-eventos-pilot", tag: "dl" },
  { id: "lab-eventos-internal", tag: "dl" },
  "lab-auditoria-vacio",
  { id: "lab-auditoria-lista", tag: "ul" },
  { id: "lab-json", tag: "pre" },
] as const;

/** Lo que renderListaEspera busca por id (para el viaje de ida y vuelta de ruta). */
const LISTA_ESPERA_IDS = [
  "lista-espera-cargando",
  "lista-espera-integridad",
  "lista-espera-integridad-detalle",
  "le-huecos-contador",
  { id: "le-huecos-lista", tag: "div" },
  "le-huecos-orden",
  "le-huecos-vacio",
  "le-bloque-tardias",
  "le-tardias-contador",
  { id: "le-tardias-lista", tag: "div" },
  "le-personas-contador",
  "le-personas-vacio",
  "le-personas-vacio-filtro",
  { id: "le-personas-tbody", tag: "tbody" },
  { id: "le-plazo-select", tag: "select" },
  "le-plazo-frase",
  "le-plazo-demo",
  { id: "le-cifras", tag: "dl" },
  "le-tecnico-historial-contador",
  { id: "le-tecnico-historial", tag: "ul" },
] as const;

/** Lo que limpiarExploradorHuecos() (dentro de confirmarReinicio) toca sin mirar la ruta. */
const HUECOS_IDS = [
  { id: "huecos-servicio", tag: "select" },
  { id: "huecos-profesional", tag: "select" },
  "huecos-profesional-campo",
  { id: "huecos-fecha", tag: "input" },
  { id: "huecos-desde", tag: "input" },
  { id: "huecos-hasta", tag: "input" },
  "huecos-dia-campo",
  "huecos-desde-campo",
  "huecos-hasta-campo",
  { id: "huecos-a-quien-una", tag: "input" },
  { id: "huecos-a-quien-cualquiera", tag: "input" },
  { id: "huecos-cuando-dia", tag: "input" },
  { id: "huecos-cuando-rango", tag: "input" },
  "huecos-gate",
  { id: "huecos-comprobar", tag: "button" },
  "huecos-error",
  "huecos-resultados-bloque",
  "huecos-resultados-titulo",
  "huecos-recuento",
  "huecos-orden",
  "huecos-sintetico",
  "huecos-desfase",
  "huecos-vacio",
  "huecos-nota-incapacidad",
  { id: "huecos-motivos-dias", tag: "ul" },
  { id: "huecos-resultados", tag: "div" },
] as const;

const RESET_IDS = [
  { id: "estado-global", tag: "p" },
  { id: "dialogo-reset", tag: "dialog" },
  { id: "dialogo-reset-titulo", tag: "h2" },
  { id: "btn-abrir-reset", tag: "button" },
  { id: "reset-confirmar", tag: "button" },
  { id: "reset-cancelar", tag: "button" },
  { id: "tx-view-title", tag: "h1" },
  "tx-freshness",
  "tx-conexion-anuncio",
  "inicio-ruta-desconocida",
  "lab-resumen-copiar-estado",
] as const;

type Consola = {
  document: FakeDocument;
  nodes: Record<string, FakeElement>;
  win: { location: { hash: string }; scrollTo: () => void };
  hooks: UiTestHooks;
};

/** La consola montada en #/laboratorio por el camino real: enrutado + sondeo contra el servidor. */
async function montarTaller(app: FastifyInstance): Promise<Consola> {
  const hash = "#/laboratorio";
  const { document, nodes } = createFakeDocumentWithIds([
    ...TALLER_IDS,
    ...LABORATORIO_MINIMOS,
    ...LISTA_ESPERA_IDS,
    ...HUECOS_IDS,
    ...RESET_IDS,
  ]);
  // La línea de cobertura tiene tres <p> hijos en el HTML servido (§3.10).
  for (let i = 0; i < 3; i += 1) nodes["tx-taller-cobertura"].appendChild(document.createElement("p"));
  // El botón de borrado total vive dentro del panel: wireFocoDialogo sólo
  // devuelve el foco a un disparador que sigue conectado (parentNode).
  const panel = document.createElement("section");
  panel.appendChild(nodes["tx-taller-borrar-todo"]);
  // aria-pressed inicial, como en el HTML servido.
  nodes["tx-taller-filtro-todas"].setAttribute("aria-pressed", "true");
  for (const clave of ["bloquean", "esperan", "sin-respuesta", "anotadas"]) {
    nodes[`tx-taller-filtro-${clave}`].setAttribute("aria-pressed", "false");
  }
  const win = { location: { hash }, scrollTo: () => undefined };
  const hooks = loadUiClientHooks(hash, document, win);
  hooks.wireTallerControls();
  hooks.applyRoute();
  await conFetch(fetchContraLaApp(app), () => hooks.refresh());
  return { document, nodes, win, hooks };
}

// ---- ayudantes de recorrido (children/childByClass, nunca querySelectorAll) ----

function cardOf(c: Consola, entryId: string): FakeElement {
  const card = c.nodes["tx-taller-lista"].querySelector(`[data-key="${entryId}"]`);
  expect(card, `no existe la tarjeta de ${entryId}`).not.toBeNull();
  return card as FakeElement;
}

function filasDeOpciones(card: FakeElement): FakeElement[] {
  return card.children[3].children[2].children;
}

function radioDe(card: FakeElement, letra: string): FakeElement {
  const fila = filasDeOpciones(card).find((f) => f.getAttribute("data-key") === letra);
  expect(fila, `no existe la opción ${letra}`).toBeDefined();
  return (fila as FakeElement).children[0];
}

function marcar(card: FakeElement, letra: string): void {
  const radio = radioDe(card, letra);
  radio.checked = true;
  (radio.onchange as () => void)();
}

function notaDe(card: FakeElement): FakeElement {
  return card.children[4].children[0].children[1];
}

function contadorDe(card: FakeElement): FakeElement {
  return card.children[4].children[1];
}

function escribirNota(card: FakeElement, texto: string): void {
  const campo = notaDe(card);
  campo.value = texto;
  (campo.oninput as () => void)();
}

function botonBorrarDe(card: FakeElement): FakeElement {
  return card.children[6];
}

function gruposDeBloques(c: Consola): FakeElement[] {
  return c.nodes["tx-taller-lista"].children.filter((g) => g.getAttribute("data-key") !== "huerfanas");
}

function todasLasTarjetas(c: Consola): FakeElement[] {
  const out: FakeElement[] = [];
  for (const grupo of gruposDeBloques(c)) {
    for (const tarjeta of grupo.children[1].children) out.push(tarjeta);
  }
  return out;
}

function tarjetasVisibles(c: Consola): FakeElement[] {
  const out: FakeElement[] = [];
  for (const grupo of gruposDeBloques(c)) {
    if (grupo.hidden) continue;
    for (const tarjeta of grupo.children[1].children) {
      if (!tarjeta.hidden) out.push(tarjeta);
    }
  }
  return out;
}

function todosLosRadios(c: Consola): FakeElement[] {
  const out: FakeElement[] = [];
  for (const card of todasLasTarjetas(c)) {
    for (const fila of filasDeOpciones(card)) out.push(fila.children[0]);
  }
  return out;
}

function clickFiltro(c: Consola, clave: string): void {
  c.nodes[`tx-taller-filtro-${clave}`].dispatchClick();
}

function buscar(c: Consola, texto: string): void {
  const campo = c.nodes["tx-taller-buscar"];
  campo.value = texto;
  (campo.oninput as () => void)();
}

/** Cuenta las escrituras de textContent sobre un nodo (patrón de resetAccesible). */
function instrumentarTextContent(nodo: FakeElement): { escrituras: string[] } {
  const registro: string[] = [];
  const prototipo = Object.getPrototypeOf(nodo) as { textContent: string };
  const descriptor = Object.getOwnPropertyDescriptor(prototipo, "textContent") as PropertyDescriptor;
  Object.defineProperty(nodo, "textContent", {
    configurable: true,
    get(this: FakeElement) {
      return (descriptor.get as (this: FakeElement) => string).call(this);
    },
    set(this: FakeElement, value: string) {
      registro.push(value);
      (descriptor.set as (this: FakeElement, v: string) => void).call(this, value);
    },
  });
  return { escrituras: registro };
}

/** El texto que el cliente considera buscable (§3.5): identificadores, pregunta y comportamiento hoy. (U11-4: el aparte, en su variante de pantalla.) */
function textoBuscableDe(e: Json): string {
  return [
    String(e.entryId),
    (e.identifiers as string[]).join(" "),
    String(e.identifiersLabel),
    String(e.question),
    String(e.questionAsideDisplay ?? ""),
    String(e.currentBehaviour),
  ].join(" ");
}

async function workshopOf(app: FastifyInstance): Promise<Json> {
  return ((await snapshotOf(app)).demo as Json).decisionWorkshop as Json;
}

// =====================================================================
// (a) Posición y contrato del HTML estático (D20-18, §3.2, §9.6)
// =====================================================================

describe("step 20 · taller — el panel estático: tercer panel del Laboratorio, con su aviso permanente", () => {
  it("vive entre «Resumen para revisar con Bruno» y «Reloj de la demostración», sin mover ningún panel existente", () => {
    const html = renderConsoleHtml();
    const guion = html.indexOf('id="tit-lab-guion"');
    const resumen = html.indexOf('id="tit-lab-resumen"');
    const taller = html.indexOf('id="tit-lab-taller"');
    const reloj = html.indexOf('id="tit-lab-reloj"');
    for (const idx of [guion, resumen, taller, reloj]) expect(idx).toBeGreaterThan(-1);
    expect(guion).toBeLessThan(resumen);
    expect(resumen).toBeLessThan(taller);
    expect(taller).toBeLessThan(reloj);
  });

  it("el encabezado, el rótulo permanente y las frases del §8.1 son estáticos e idénticos byte a byte a WORKSHOP_COPY", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(`<h2 id="tit-lab-taller">${WORKSHOP_COPY.heading}</h2>`);
    expect(html).toContain(`<p class="tx-permanent-label">${WORKSHOP_COPY.permanentLabel}</p>`);
    for (const frase of [
      WORKSHOP_COPY.introNote,
      WORKSHOP_COPY.draftNote,
      WORKSHOP_COPY.resetNote,
      WORKSHOP_COPY.conservativeNote,
      WORKSHOP_COPY.orderNote,
      WORKSHOP_COPY.searchScopeNote,
      WORKSHOP_COPY.overlappingFiltersNote,
      WORKSHOP_COPY.emptyStateNote,
      WORKSHOP_COPY.coverage.meaningNote,
    ]) {
      expect(html).toContain(frase);
    }
  });

  it("las regiones vivas del panel son EXACTAMENTE tres (§3.11): tx-taller-estado y las dos líneas de copiado; la cobertura NO lleva role ni aria-live", () => {
    const html = renderConsoleHtml();
    expect(html).toContain('<p class="tx-status-line" id="tx-taller-estado" role="status" aria-live="polite" tabindex="-1"></p>');
    expect(html).toContain('<div id="tx-taller-cobertura">');
    // ENMIENDA DELIBERADA (fase 7, 2026-08-06). Era una y son TRES: llegan
    // las dos líneas de estado de copiado (§3.11, punto 5; «recuento
    // declarado de regiones vivas: +3»), que son el resultado directo de una
    // acción del operador, igual que #lab-resumen-copiar-estado. La aserción
    // sigue fijando el número EXACTO.
    expect(html).toContain('<p class="tx-status-line" id="tx-taller-acta-estado" role="status" aria-live="polite"></p>');
    expect(html).toContain('<p class="tx-status-line" id="tx-taller-mision-estado" role="status" aria-live="polite"></p>');
    const inicio = html.indexOf('aria-labelledby="tit-lab-taller"');
    const fin = html.indexOf('id="tit-lab-reloj"');
    const seccion = html.slice(inicio, fin);
    expect([...seccion.matchAll(/aria-live=/g)].length).toBe(3);
  });

  it("los cinco filtros existen con aria-pressed y sólo «Todas» activo; la búsqueda es un input type=search con autocomplete=off", () => {
    const html = renderConsoleHtml();
    expect(html).toContain('id="tx-taller-filtro-todas" aria-pressed="true">Todas<');
    expect(html).toContain('id="tx-taller-filtro-bloquean" aria-pressed="false">Bloquean un piloto<');
    expect(html).toContain('id="tx-taller-filtro-esperan" aria-pressed="false">Pueden esperar<');
    expect(html).toContain('id="tx-taller-filtro-sin-respuesta" aria-pressed="false">Sin respuesta<');
    expect(html).toContain('id="tx-taller-filtro-anotadas" aria-pressed="false">Con borrador anotado<');
    expect(html).toContain('<input type="search" id="tx-taller-buscar" autocomplete="off">');
  });

  it("el diálogo de borrado total existe con el patrón de la casa y las frases del §8.4", () => {
    const html = renderConsoleHtml();
    expect(html).toContain('id="dialogo-taller-borrar" aria-labelledby="dialogo-taller-borrar-titulo"');
    expect(html).toContain(`id="dialogo-taller-borrar-titulo" tabindex="-1">${WORKSHOP_COPY.dialog.title}</h2>`);
    expect(html).toContain(WORKSHOP_COPY.dialog.scopeNote);
    expect(html).toContain(`id="tx-taller-borrar-confirmar">${WORKSHOP_COPY.dialog.confirmTag}</button>`);
    expect(html).toContain(`id="tx-taller-borrar-cancelar" value="cancel">${WORKSHOP_COPY.dialog.cancelTag}</button>`);
  });
});

// =====================================================================
// (b) Estado inicial vacío — I20-4, §9.3.1 y §9.3.13
// =====================================================================

describe("step 20 · taller — vacío por ausencia de acción humana, no por barrido (I20-4)", () => {
  it("(1) tras el primer pintado, cinco sondeos y un viaje de ida y vuelta de ruta, ningún radio está marcado y nada está escrito", async () => {
    const app = freshApp();
    const c = await montarTaller(app);

    expect(todasLasTarjetas(c).length).toBe(32);
    expect(gruposDeBloques(c).length).toBe(10);
    expect(todosLosRadios(c).every((r) => r.checked === false)).toBe(true);

    for (let i = 0; i < 5; i += 1) await conFetch(fetchContraLaApp(app), () => c.hooks.refresh());
    expect(todosLosRadios(c).every((r) => r.checked === false)).toBe(true);

    c.win.location.hash = "#/lista-espera";
    c.hooks.applyRoute();
    c.win.location.hash = "#/laboratorio";
    c.hooks.applyRoute();
    expect(todosLosRadios(c).every((r) => r.checked === false)).toBe(true);
    expect(todasLasTarjetas(c).every((card) => notaDe(card).value === "")).toBe(true);
    expect(c.nodes["tx-taller-filtro-todas"].getAttribute("aria-pressed")).toBe("true");
    expect(c.nodes["tx-taller-buscar"].value).toBe("");

    // La cobertura de arranque: 0 de 32, L1 sin anotar, 7 de las 7 bloqueantes.
    const cobertura = c.nodes["tx-taller-cobertura"];
    expect(cobertura.children[0].textContent).toBe("Con respuesta anotada: 0 de 32 preguntas J/K.");
    expect(cobertura.children[1].textContent).toBe("L1: sin anotar.");
    expect(cobertura.children[2].textContent).toBe(
      "Siguen sin respuesta 7 de las 7 preguntas que bloquean un piloto: J5, K1, J8, K4, K13, K15, J6.",
    );
    await app.close();
  });

  it("(13) sin decisionWorkshop en la instantánea: estado vacío honesto, el panel no se pinta a medias y el borrador en memoria queda intacto", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    marcar(cardOf(c, "K17"), "B");

    const snap = await snapshotOf(app);
    const roto = JSON.parse(JSON.stringify(snap)) as Json;
    delete (roto.demo as Json).decisionWorkshop;
    c.hooks.renderTallerDecisiones(roto);
    expect(c.nodes["tx-taller-vacio"].hidden).toBe(false);
    expect(c.nodes["tx-taller-lista"].hidden).toBe(true);

    // Vuelve el catálogo: la marca sigue puesta, sin repintar (misma huella).
    c.hooks.renderTallerDecisiones(snap);
    expect(c.nodes["tx-taller-vacio"].hidden).toBe(true);
    expect(c.nodes["tx-taller-lista"].hidden).toBe(false);
    expect(radioDe(cardOf(c, "K17"), "B").checked).toBe(true);
    await app.close();
  });
});

// =====================================================================
// (c) El borrador sobrevive al sondeo; la huella evita el repintado (D20-20)
// =====================================================================

describe("step 20 · taller — sondeo, huella y repintado forzado", () => {
  it("(4) marcar B en K17 sobrevive a tres sondeos", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    marcar(cardOf(c, "K17"), "B");
    for (let i = 0; i < 3; i += 1) await conFetch(fetchContraLaApp(app), () => c.hooks.refresh());
    expect(radioDe(cardOf(c, "K17"), "B").checked).toBe(true);
    await app.close();
  });

  it("(5) con la misma huella, una segunda llamada a renderTallerDecisiones no crea ni destruye ningún nodo", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const snap = await snapshotOf(app);
    const tarjetasAntes = todasLasTarjetas(c).length;

    const original = c.document.createElement.bind(c.document);
    let creados = 0;
    (c.document as unknown as { createElement: (t: string) => unknown }).createElement = (t: string) => {
      creados += 1;
      return original(t);
    };
    c.hooks.renderTallerDecisiones(snap);
    expect(creados).toBe(0);
    expect(todasLasTarjetas(c).length).toBe(tarjetasAntes);
    await app.close();
  });

  it("(6) un repintado forzado por cambio de huella reaplica el borrador, y una sola pulsación de «Borrar este borrador» surte efecto UNA sola vez (D20-51)", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    marcar(cardOf(c, "K17"), "B");

    const snap2 = JSON.parse(JSON.stringify(await snapshotOf(app))) as Json;
    ((snap2.demo as Json).decisionWorkshop as Json).fingerprint = "ffffffff";
    c.hooks.renderTallerDecisiones(snap2);

    const card = cardOf(c, "K17");
    expect(radioDe(card, "B").checked).toBe(true);

    // Si buildTarjetaTaller hubiera acumulado manejadores (addEventListener),
    // la "segunda" ejecución no encontraría nada que borrar y PISARÍA el
    // estado con «No había nada anotado…». Con propiedad, queda el de borrado.
    (botonBorrarDe(card).onclick as () => void)();
    expect(c.nodes["tx-taller-estado"].textContent).toBe("Borrado el borrador de K17. No ha cambiado nada en la demostración.");
    expect(radioDe(card, "B").checked).toBe(false);
    await app.close();
  });

  it("(6 bis, estructural) dentro de buildTarjetaTaller no hay ningún addEventListener: todos los manejadores de tarjeta van por propiedad", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("function buildTarjetaTaller");
    expect(inicio).toBeGreaterThan(-1);
    const fin = js.indexOf("\n  function ", inicio + 10);
    const cuerpo = js.slice(inicio, fin);
    expect(cuerpo).not.toContain("addEventListener");
    expect(cuerpo).toContain(".onchange = ");
    expect(cuerpo).toContain(".oninput = ");
    expect(cuerpo).toContain(".onclick = ");
  });

  it("(7) con el foco en un radio, un repintado forzado por cambio de huella no lo mueve", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const radio = radioDe(cardOf(c, "J8"), "A");
    radio.focus();
    expect(c.document.activeElement).toBe(radio);

    const snap2 = JSON.parse(JSON.stringify(await snapshotOf(app))) as Json;
    ((snap2.demo as Json).decisionWorkshop as Json).fingerprint = "00000001";
    c.hooks.renderTallerDecisiones(snap2);
    expect(c.document.activeElement).toBe(radio);
    await app.close();
  });
});

// =====================================================================
// (d) El reinicio de la demostración y el borrador (D20-27, I20-4)
// =====================================================================

describe("step 20 · taller — el reinicio no marca nada y no borra nada", () => {
  it("(2) reinicio con el borrador VACÍO: sigue vacío — nada marcado, ninguna nota, filtro en «Todas», búsqueda vacía", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());
    expect(todosLosRadios(c).every((r) => r.checked === false)).toBe(true);
    expect(todasLasTarjetas(c).every((card) => notaDe(card).value === "")).toBe(true);
    expect(c.nodes["tx-taller-filtro-todas"].getAttribute("aria-pressed")).toBe("true");
    expect(c.nodes["tx-taller-buscar"].value).toBe("");
    await app.close();
  });

  it("(3/12) reinicio con el borrador A MEDIAS: marcas, nota, filtro y búsqueda quedan intactos, y tx-taller-estado no se barre", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    marcar(cardOf(c, "K17"), "B");
    marcar(cardOf(c, "J1"), "C");
    escribirNota(cardOf(c, "J8"), "lo consulta antes de cerrarlo");
    clickFiltro(c, "bloquean");
    buscar(c, "plazo");
    await dormir(300); // deja disparar el rebote de la búsqueda (§3.11.4)
    const estadoAntes = c.nodes["tx-taller-estado"].textContent;
    expect(estadoAntes).not.toBe("");

    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());

    expect(radioDe(cardOf(c, "K17"), "B").checked).toBe(true);
    expect(radioDe(cardOf(c, "J1"), "C").checked).toBe(true);
    expect(notaDe(cardOf(c, "J8")).value).toBe("lo consulta antes de cerrarlo");
    expect(c.nodes["tx-taller-filtro-bloquean"].getAttribute("aria-pressed")).toBe("true");
    expect(c.nodes["tx-taller-filtro-todas"].getAttribute("aria-pressed")).toBe("false");
    expect(c.nodes["tx-taller-buscar"].value).toBe("plazo");
    expect(c.nodes["tx-taller-estado"].textContent).toBe(estadoAntes);
    await app.close();
  });

  it("los ids del panel NO están en REGIONES_TRANSITORIAS (§6.4), y las DOS líneas de copiado SÍ (fase 7, D20-28)", () => {
    const hooks = loadUiClientHooks();
    expect(hooks.REGIONES_TRANSITORIAS).not.toContain("tx-taller-estado");
    expect(hooks.REGIONES_TRANSITORIAS).not.toContain("tx-taller-cobertura");
    // Las dos líneas de estado de copiado son el resultado de una acción y
    // el reinicio las barre — exactamente los dos ids que el §6.4 añade.
    expect(hooks.REGIONES_TRANSITORIAS).toContain("tx-taller-acta-estado");
    expect(hooks.REGIONES_TRANSITORIAS).toContain("tx-taller-mision-estado");
  });
});

// =====================================================================
// (e) Filtros y búsqueda (D20-22, D20-23, §9.3.8/§9.3.9)
// =====================================================================

describe("step 20 · taller — los cinco filtros y la búsqueda local", () => {
  it("(8) «Bloquean un piloto» enseña 6; «Pueden esperar», 26; «Todas», 32 — y lo anuncia una vez por clic", async () => {
    const app = freshApp();
    const c = await montarTaller(app);

    clickFiltro(c, "bloquean");
    expect(tarjetasVisibles(c).length).toBe(6);
    expect(c.nodes["tx-taller-estado"].textContent).toBe("Se enseñan 6 de las 32 tarjetas del taller.");
    clickFiltro(c, "esperan");
    expect(tarjetasVisibles(c).length).toBe(26);
    clickFiltro(c, "todas");
    expect(tarjetasVisibles(c).length).toBe(32);
    await app.close();
  });

  it("(8 bis) «Sin respuesta» y «Con borrador anotado» no son contrarios: una entrada con nota y sin opción sale en los dos", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    escribirNota(cardOf(c, "J3"), "hablarlo con calma");
    marcar(cardOf(c, "K17"), "A");

    clickFiltro(c, "sin-respuesta");
    const sinRespuesta = tarjetasVisibles(c).map((t) => t.getAttribute("data-key"));
    expect(sinRespuesta.length).toBe(31); // todas menos K17 (que tiene opción)
    expect(sinRespuesta).toContain("J3");
    expect(sinRespuesta).not.toContain("K17");

    clickFiltro(c, "anotadas");
    const anotadas = tarjetasVisibles(c).map((t) => t.getAttribute("data-key"));
    expect(anotadas.sort()).toEqual(["J3", "K17"]);
    await app.close();
  });

  it("(8 ter) la búsqueda tolera acentos: «depósito», «deposito» y «DEPÓSITO» dan el mismo resultado — y en singular la locución concuerda", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const resultados: string[][] = [];
    for (const q of ["depósito", "deposito", "DEPÓSITO"]) {
      buscar(c, q);
      resultados.push(tarjetasVisibles(c).map((t) => String(t.getAttribute("data-key"))));
    }
    expect(resultados[1]).toEqual(resultados[0]);
    expect(resultados[2]).toEqual(resultados[0]);
    expect(resultados[0]).toEqual(["J9"]);
    await dormir(300);
    expect(c.nodes["tx-taller-estado"].textContent).toBe("Se enseña 1 de las 32 tarjetas del taller.");
    await app.close();
  });

  it("(8 quater) las opciones NO se buscan: un texto que sólo existe dentro de una opción no encuentra nada", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const view = await workshopOf(app);
    const entries = view.entries as Json[];
    const norm = c.hooks.normalizarBusqueda;
    const token = "proveedor de pago";
    // Precondición contra el catálogo servido: el texto existe en alguna
    // opción y en NINGÚN campo buscable — si el pack cambiara, esto avisa.
    expect(entries.some((e) => (e.options as Json[]).some((o) => norm(String(o.text)).includes(norm(token))))).toBe(true);
    expect(entries.some((e) => norm(textoBuscableDe(e)).includes(norm(token)))).toBe(false);

    buscar(c, token);
    expect(tarjetasVisibles(c).length).toBe(0);
    await app.close();
  });

  it("(8 quinquies) búsqueda y filtro se combinan por conjunción, y el resultado coincide con el derivado del catálogo servido", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const view = await workshopOf(app);
    const norm = c.hooks.normalizarBusqueda;
    const esperadas = (view.entries as Json[])
      .filter((e) => (e.urgency as Json).kind === "bloquea" && norm(textoBuscableDe(e)).includes(norm("plazo")))
      .map((e) => String(e.entryId));
    expect(esperadas.length).toBeGreaterThan(0);

    clickFiltro(c, "bloquean");
    buscar(c, "plazo");
    expect(tarjetasVisibles(c).map((t) => t.getAttribute("data-key"))).toEqual(esperadas);
    await app.close();
  });

  it("(9) foco al filtrar: si la tarjeta enfocada desaparece, el foco va a la línea de resultados; si sigue visible, no se mueve", async () => {
    const app = freshApp();
    const c = await montarTaller(app);

    // K3 puede esperar: «Bloquean un piloto» la oculta y el foco se rescata.
    const radioK3 = radioDe(cardOf(c, "K3"), "A");
    radioK3.focus();
    clickFiltro(c, "bloquean");
    expect(c.document.activeElement).toBe(c.nodes["tx-taller-estado"]);
    expect(c.nodes["tx-taller-estado"].textContent).toBe("Se enseñan 6 de las 32 tarjetas del taller.");

    // J8 bloquea: sigue visible con ese filtro y el foco NO se mueve.
    const radioJ8 = radioDe(cardOf(c, "J8"), "A");
    radioJ8.focus();
    clickFiltro(c, "bloquean");
    expect(c.document.activeElement).toBe(radioJ8);
    await app.close();
  });
});

// =====================================================================
// (f) Cobertura (D20-31, §9.3.10)
// =====================================================================

describe("step 20 · taller — la cobertura cuenta identificadores anotados, nunca aprobaciones", () => {
  it("(10) 0 → «0 de 32»; J5/K1 cuenta por DOS; L1 va aparte y nunca entra en el 32; las bloqueantes bajan y concuerdan en singular", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const cobertura = c.nodes["tx-taller-cobertura"];

    marcar(cardOf(c, "J5/K1"), "A");
    expect(cobertura.children[0].textContent).toBe(
      "Con respuesta anotada: 2 de 32 preguntas J/K. (J5 y K1 comparten una sola respuesta y cuentan por dos.)",
    );
    expect(cobertura.children[2].textContent).toBe(
      "Siguen sin respuesta 5 de las 7 preguntas que bloquean un piloto: J8, K4, K13, K15, J6.",
    );

    marcar(cardOf(c, "L1"), "A");
    expect(cobertura.children[1].textContent).toBe("L1: anotada.");
    expect(cobertura.children[0].textContent).toContain("2 de 32"); // L1 no suma en el denominador J/K

    for (const id of ["J8", "K4", "K13", "K15"]) marcar(cardOf(c, id), "A");
    expect(cobertura.children[2].textContent).toBe("Sigue sin respuesta 1 de las 7 preguntas que bloquean un piloto: J6.");

    marcar(cardOf(c, "J6"), "A");
    expect(cobertura.children[2].textContent).toBe("Ninguna de las 7 preguntas que bloquean un piloto se ha quedado sin anotar.");
    expect(cobertura.children[0].textContent).toContain("7 de 32");
    await app.close();
  });
});

// =====================================================================
// (g) La nota corta (§3.7, D20-49, D20-52)
// =====================================================================

describe("step 20 · taller — la nota corta opcional", () => {
  it("el contador dice «N de 280»; un pegado de 300 caracteres se recorta A LA VISTA y la línea de estado lo dice", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const card = cardOf(c, "J8");

    escribirNota(card, "cinco");
    expect(contadorDe(card).textContent).toBe("5 de 280");

    escribirNota(card, "x".repeat(300));
    expect(notaDe(card).value.length).toBe(280);
    expect(contadorDe(card).textContent).toBe("280 de 280");
    expect(c.nodes["tx-taller-estado"].textContent).toBe("La nota se ha cortado a 280 caracteres.");
    await app.close();
  });

  it("el campo lleva maxlength=280 y autocomplete=off — y TODOS los radios llevan autocomplete=off (D20-52)", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    for (const card of todasLasTarjetas(c)) {
      const campo = notaDe(card);
      expect(campo.getAttribute("maxlength")).toBe("280");
      expect(campo.getAttribute("autocomplete")).toBe("off");
      for (const fila of filasDeOpciones(card)) {
        expect(fila.children[0].getAttribute("autocomplete")).toBe("off");
      }
    }
    await app.close();
  });
});

// =====================================================================
// (h) Borrado por tarjeta y borrado total (D20-29, D20-30, I20-7)
// =====================================================================

describe("step 20 · taller — borrar es local, explícito y no toca la demostración", () => {
  it("(11) «Borrar este borrador» nunca está deshabilitado; con algo, limpia y anuncia; sin nada, es una operación nula que también se dice; el foco no se cae", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const card = cardOf(c, "K17");
    const boton = botonBorrarDe(card);
    expect(boton.disabled).toBe(false);

    boton.focus();
    (boton.onclick as () => void)();
    expect(c.nodes["tx-taller-estado"].textContent).toBe("No había nada anotado en K17.");
    expect(boton.disabled).toBe(false);
    expect(c.document.activeElement).toBe(boton);

    marcar(card, "B");
    escribirNota(card, "una nota");
    (boton.onclick as () => void)();
    expect(radioDe(card, "B").checked).toBe(false);
    expect(notaDe(card).value).toBe("");
    expect(contadorDe(card).textContent).toBe("0 de 280");
    expect(c.nodes["tx-taller-estado"].textContent).toBe("Borrado el borrador de K17. No ha cambiado nada en la demostración.");
    expect(boton.disabled).toBe(false);
    expect(c.document.activeElement).toBe(boton);
    await app.close();
  });

  it("(11 bis) «Borrar todos los borradores»: el diálogo dice cuánto se va a perder, vacía todo al confirmar y devuelve el foco al disparador", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    marcar(cardOf(c, "K17"), "B");
    marcar(cardOf(c, "J1"), "C");
    escribirNota(cardOf(c, "J8"), "nota de reunión");

    c.nodes["tx-taller-borrar-todo"].dispatchClick();
    expect(c.nodes["dialogo-taller-borrar"].open).toBe(true);
    expect(c.nodes["tx-taller-borrar-resumen"].textContent).toBe("Vas a borrar 2 respuestas anotadas y 1 nota. No se puede deshacer.");

    c.nodes["tx-taller-borrar-confirmar"].dispatchClick();
    expect(c.nodes["dialogo-taller-borrar"].open).toBe(false);
    expect(todosLosRadios(c).every((r) => r.checked === false)).toBe(true);
    expect(todasLasTarjetas(c).every((card) => notaDe(card).value === "")).toBe(true);
    expect(c.nodes["tx-taller-estado"].textContent).toBe("Borrador vaciado. No ha cambiado nada en la demostración.");
    expect(c.document.activeElement).toBe(c.nodes["tx-taller-borrar-todo"]);

    // Cancelar también devuelve el foco y no borra nada.
    marcar(cardOf(c, "K17"), "A");
    c.nodes["tx-taller-borrar-todo"].dispatchClick();
    c.nodes["tx-taller-borrar-cancelar"].dispatchClick();
    expect(radioDe(cardOf(c, "K17"), "A").checked).toBe(true);
    await app.close();
  });

  it("(I20-6/I20-7) marcar, escribir, filtrar, buscar y borrar no lanzan NINGUNA petición, y la instantánea del servidor queda idéntica", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const antes = stable(await snapshotOf(app));

    const peticiones: string[] = [];
    const espia = (() => {
      peticiones.push("fetch");
      return Promise.reject(new Error("el taller no puede pedir nada"));
    }) as unknown as typeof fetch;
    await conFetch(espia, async () => {
      marcar(cardOf(c, "K17"), "B");
      escribirNota(cardOf(c, "J8"), "# APROBADO POR BRUNO");
      clickFiltro(c, "bloquean");
      buscar(c, "plazo");
      (botonBorrarDe(cardOf(c, "K17")).onclick as () => void)();
      c.nodes["tx-taller-borrar-todo"].dispatchClick();
      c.nodes["tx-taller-borrar-confirmar"].dispatchClick();
      await dormir(300); // también el rebote de la búsqueda: cero peticiones
    });
    expect(peticiones).toEqual([]);

    const despues = stable(await snapshotOf(app));
    expect(JSON.stringify(despues)).toBe(JSON.stringify(antes));
    await app.close();
  });
});

// =====================================================================
// (i) Entradas huérfanas (§3.13, §9.3.14)
// =====================================================================

describe("step 20 · taller — una anotación sin fila en el catálogo no se descarta en silencio", () => {
  it("(14) si la fila desaparece entre versiones, la anotación se pinta aparte bajo su rótulo y no cuenta en la cobertura", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    marcar(cardOf(c, "K17"), "B");
    escribirNota(cardOf(c, "K17"), "quedó a medias");

    const snap2 = JSON.parse(JSON.stringify(await snapshotOf(app))) as Json;
    const taller2 = (snap2.demo as Json).decisionWorkshop as Json;
    taller2.entries = (taller2.entries as Json[]).filter((e) => e.entryId !== "K17");
    taller2.fingerprint = "0badc0de";
    c.hooks.renderTallerDecisiones(snap2);

    const grupos = c.nodes["tx-taller-lista"].children;
    const huerfanas = grupos[grupos.length - 1];
    expect(huerfanas.getAttribute("data-key")).toBe("huerfanas");
    expect(huerfanas.children[0].textContent).toBe(WORKSHOP_COPY.orphanHeading);
    // (Revisión U11-16) La nota servida que declara que este grupo ignora
    // filtros y búsqueda, entre el rótulo y la lista.
    expect(huerfanas.children[1].textContent).toBe(WORKSHOP_COPY.orphanUnfilteredNote);
    expect(huerfanas.children[2].children.length).toBe(1);
    expect(huerfanas.children[2].children[0].textContent).toContain("K17");
    expect(huerfanas.children[2].children[0].textContent).toContain("(B)");
    expect(huerfanas.children[2].children[0].textContent).toContain("quedó a medias");

    // No cuenta en la cobertura: el catálogo pintado ya no tiene esa fila.
    expect(c.nodes["tx-taller-cobertura"].children[0].textContent).toBe("Con respuesta anotada: 0 de 32 preguntas J/K.");
    expect(todasLasTarjetas(c).length).toBe(31);
    await app.close();
  });
});

// =====================================================================
// (j) Anuncios: una sola locución por acción, y la búsqueda con rebote
// =====================================================================

describe("step 20 · taller — anuncios sólo por suceso (§3.11, §9.3.15)", () => {
  it("(15) un clic de filtro escribe la línea de estado UNA vez; tres pulsaciones de búsqueda producen UNA locución tras el rebote; marcar un radio no escribe ninguna", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const { escrituras } = instrumentarTextContent(c.nodes["tx-taller-estado"]);

    marcar(cardOf(c, "K17"), "B");
    expect(escrituras.length).toBe(0); // el propio radio ya locuta; la cobertura calla

    clickFiltro(c, "bloquean");
    expect(escrituras.length).toBe(1);

    buscar(c, "p");
    buscar(c, "pl");
    buscar(c, "plazo");
    expect(escrituras.length).toBe(1); // todavía nada: el rebote está en vuelo
    await dormir(320);
    expect(escrituras.length).toBe(2); // una sola locución para las tres pulsaciones
    await app.close();
  });

  it("el sondeo no reescribe la línea de estado ni la cobertura", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const estado = instrumentarTextContent(c.nodes["tx-taller-estado"]);
    const cobertura0 = instrumentarTextContent(c.nodes["tx-taller-cobertura"].children[0]);
    for (let i = 0; i < 3; i += 1) await conFetch(fetchContraLaApp(app), () => c.hooks.refresh());
    expect(estado.escrituras.length).toBe(0);
    expect(cobertura0.escrituras.length).toBe(0);
    await app.close();
  });
});

// =====================================================================
// (k) Barridos I20-15: ninguna persistencia ni canal lateral en el bloque
// =====================================================================

describe("step 20 · taller — I20-15: cero superficies de persistencia o canal lateral en el código del taller", () => {
  it("el bloque del taller (entre sus dos marcadores) no contiene ninguna de las superficies prohibidas", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("TALLER DE DECISIONES CON BRUNO (diseño §3) — INICIO DEL BLOQUE");
    const fin = js.indexOf("TALLER DE DECISIONES CON BRUNO — FIN DEL BLOQUE");
    expect(inicio).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(inicio);
    const bloque = js.slice(inicio, fin);
    for (const prohibido of [
      "localStorage",
      "sessionStorage",
      "document.cookie",
      "indexedDB",
      "IndexedDB",
      "window.name",
      "history.",
      "location.hash",
      "location.search",
      "BroadcastChannel",
      "postMessage",
      "caches",
      "sendBeacon",
      "fetch(",
      "XMLHttpRequest",
      "innerHTML",
      ".style.",
    ]) {
      expect(bloque, `el bloque del taller contiene «${prohibido}»`).not.toContain(prohibido);
    }
  });

  it("el DOM del panel se pinta sólo con textContent/createElement/setAttribute: las notas hostiles quedan como texto", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const card = cardOf(c, "J8");
    escribirNota(card, "<script>alert(1)</script>");
    // El valor queda como DATO en el campo; nada lo interpreta.
    expect(notaDe(card).value).toBe("<script>alert(1)</script>");
    // Y el repintado forzado lo reaplica como valor, nunca como marcado.
    const snap2 = JSON.parse(JSON.stringify(await snapshotOf(app))) as Json;
    ((snap2.demo as Json).decisionWorkshop as Json).fingerprint = "0000feed";
    c.hooks.renderTallerDecisiones(snap2);
    expect(notaDe(cardOf(c, "J8")).value).toBe("<script>alert(1)</script>");
    await app.close();
  });
});

// =====================================================================
// (l) Contratos de accesibilidad del DOM generado (§9.6.1-3)
// =====================================================================

describe("step 20 · taller — contratos de accesibilidad del DOM generado", () => {
  it("(§9.6.1) cada tarjeta tiene <fieldset> con <legend>; las 32 leyendas son DISTINTAS y empiezan por su identificador; cada <label> de opción contiene SÓLO el input y el span", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const leyendas = new Set<string>();
    for (const card of todasLasTarjetas(c)) {
      const fieldset = card.children[3];
      expect(fieldset.tagName).toBe("FIELDSET");
      const legend = fieldset.children[0];
      expect(legend.tagName).toBe("LEGEND");
      const entryId = String(card.getAttribute("data-key"));
      expect(legend.textContent.startsWith(`${entryId} — `)).toBe(true);
      leyendas.add(legend.textContent);
      for (const fila of filasDeOpciones(card)) {
        expect(fila.tagName).toBe("LABEL");
        expect(fila.children.length).toBe(2);
        expect(fila.children[0].tagName).toBe("INPUT");
        expect(fila.children[1].tagName).toBe("SPAN");
      }
      // El comportamiento de hoy vive FUERA del fieldset, en su propio bloque.
      expect(card.children[2].children[0].textContent).toBe(WORKSHOP_COPY.todayHeading);
    }
    expect(leyendas.size).toBe(32);
    await app.close();
  });

  it("(§9.6.3) los cinco filtros gobiernan aria-pressed y sólo uno está a true", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    clickFiltro(c, "anotadas");
    const claves = ["todas", "bloquean", "esperan", "sin-respuesta", "anotadas"];
    const activos = claves.filter((k) => c.nodes[`tx-taller-filtro-${k}`].getAttribute("aria-pressed") === "true");
    expect(activos).toEqual(["anotadas"]);
    await app.close();
  });

  it("el normalizador de búsqueda es simétrico y tolerante a acentos (D20-23)", () => {
    const hooks = loadUiClientHooks();
    expect(hooks.normalizarBusqueda("DEPÓSITO")).toBe("deposito");
    expect(hooks.normalizarBusqueda("año")).toBe("ano");
    expect(hooks.normalizarBusqueda("Señal única")).toBe("senal unica");
  });
});

// =====================================================================
// (m) Contratos CSS (§9.6.5, I20-5, D20-33)
// =====================================================================

describe("step 20 · taller — contratos CSS: contrato de texto (no evidencia de renderizado, NUNCA prueba de renderizador real)", () => {
  const inicioTaller = CONSOLE_CSS.indexOf("step 20 §6.3 — Taller de decisiones con Bruno");
  const finTaller = CONSOLE_CSS.indexOf("4.5 Breakpoints", inicioTaller);
  const seccionTallerConComentarios = CONSOLE_CSS.slice(inicioTaller, finTaller);
  // Los contratos miran REGLAS, no comentarios: un comentario que nombra el
  // selector prohibido para prohibirlo no puede disparar el barrido.
  const sinComentarios = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const seccionTaller = sinComentarios(seccionTallerConComentarios);
  const cssSinComentarios = sinComentarios(CONSOLE_CSS);

  it("existen las clases nuevas del §6.3, todas con prefijo tx-taller-", () => {
    expect(inicioTaller).toBeGreaterThan(-1);
    for (const clase of [
      ".tx-taller-bloque",
      ".tx-taller-bloque__cabecera",
      ".tx-taller-bloque__tarjetas",
      ".tx-taller-card",
      ".tx-taller-card__titulo",
      ".tx-taller-card__pregunta",
      ".tx-taller-card__hoy",
      ".tx-taller-card__rotulo",
      ".tx-taller-card__choice",
      ".tx-taller-card__opciones",
      ".tx-taller-nota",
      ".tx-taller-nota__campo",
      ".tx-taller-nota__contador",
      ".tx-taller-urgencia",
      ".tx-taller-urgencia--bloquea",
      ".tx-taller-urgencia--espera",
      // (Revisión U11-4) La cursiva del aparte de la pregunta.
      ".tx-taller-card__aparte",
    ]) {
      expect(seccionTaller).toContain(clase);
    }
  });

  it("(U11-8) el campo de nota viste la ropa de la casa: etiqueta con letra y color de .tx-field, y textarea con borde, radio, relleno y monoespaciada", () => {
    expect(seccionTaller).toMatch(/\.tx-taller-nota label > span\s*\{[^}]*font-size: var\(--tx-size-200\)/);
    // (step 21A, corte 3) Mismo color y mismo valor: `--tx-text-body` es el
    // alias semántico que apunta a `--tx-ink-700` (§2.1 del diseño), y es el
    // que lee ahora `.tx-field`, la regla con la que este campo tiene que
    // seguir vistiendo igual. Se comprueba también la resolución del alias
    // para que repuntarlo caiga aquí y no en una revisión visual.
    expect(seccionTaller).toMatch(/\.tx-taller-nota label > span\s*\{[^}]*color: var\(--tx-text-body\)/);
    expect(CONSOLE_CSS).toContain("--tx-text-body:           var(--tx-ink-700);");
    expect(CONSOLE_CSS).toMatch(/\.tx-field\s*\{[^}]*color: var\(--tx-text-body\)/);
    const campo = /\.tx-taller-nota__campo\s*\{[^}]*\}/.exec(seccionTaller);
    expect(campo).not.toBeNull();
    for (const regla of [
      "border: var(--tx-border-control)",
      "border-radius: var(--tx-radius-sm)",
      "padding: var(--tx-space-2) var(--tx-space-3)",
      "font-family: var(--tx-font-mono)",
      "width: 100%",
    ]) {
      expect((campo as RegExpExecArray)[0]).toContain(regla);
    }
  });

  it("(U11-4) el aparte de la pregunta lleva la cursiva por CSS — la que en el pack ponían los asteriscos de Markdown", () => {
    expect(seccionTaller).toMatch(/\.tx-taller-card__aparte\s*\{[^}]*font-style: italic/);
  });

  it("(I20-5) ningún selector distingue una opción de otra: ni :first-child, ni :nth-child, ni [value=...], ni [data-key=...] en TODO el CSS servido", () => {
    // No sólo en la sección del taller: en el fichero entero no existe ningún
    // selector que apunte a una opción concreta dentro de las opciones.
    expect(cssSinComentarios).not.toMatch(/tx-taller[^{]*:first-child/);
    expect(cssSinComentarios).not.toMatch(/tx-taller[^{]*:nth-child/);
    expect(cssSinComentarios).not.toMatch(/tx-taller[^{]*\[value=/);
    expect(cssSinComentarios).not.toMatch(/tx-taller[^{]*\[data-key=/);
  });

  it("(D20-33) los textos largos parten dentro de la tarjeta (overflow-wrap) y NO se añade ningún @media nuevo", () => {
    expect(seccionTaller).toMatch(/\.tx-taller-card__titulo\s*\{[^}]*overflow-wrap: anywhere/);
    expect(seccionTaller).toMatch(/\.tx-taller-card__opciones \.tx-radio-field span\s*\{[^}]*overflow-wrap: anywhere/);
    expect(seccionTaller).toMatch(/\.tx-taller-card__hoy p\s*\{[^}]*overflow-wrap: anywhere/);
    expect(seccionTaller).toMatch(/\.tx-taller-nota__campo\s*\{[^}]*width: 100%/);
    expect(seccionTaller).not.toContain("@media");
    // Lo que este contrato defiende es que el TALLER no estrena @media
    // propios: eso lo afirma la línea de arriba y sigue intacto.
    // (M25) El recuento TOTAL del fichero pasa de 5 a 6: reduced-motion + los
    // cinco breakpoints. El añadido es de la barra lateral, no del taller —
    // separa el modo de navegación (≤1119) de la densidad de contenido
    // (≤1279); ver la nota de §4.5 en ui.css.ts y (internal doc, not included in the template).
    expect([...cssSinComentarios.matchAll(/@media/g)].length).toBe(6);
    // Y ninguna rejilla nueva: el panel es de una sola columna.
    expect(seccionTaller).not.toContain("grid-template-columns");
  });

  it("la píldora de las bloqueantes usa el tono de CONFLICTO de la casa (ámbar), nunca el rojo de error", () => {
    const regla = seccionTaller.slice(seccionTaller.indexOf(".tx-taller-urgencia--bloquea"));
    const cuerpo = regla.slice(0, regla.indexOf("}") + 1);
    // (step 21A, corte 3) `--tx-status-warn` es el alias del ámbar y
    // `--tx-status-error` el del rojo (§2.1). La aserción negativa sigue
    // siendo igual de fuerte y ahora cierra las dos puertas: ni el nombre
    // crudo del rojo ni su alias pueden aparecer aquí.
    expect(cuerpo).toContain("--tx-status-warn");
    expect(cuerpo).not.toContain("--tx-red-");
    expect(cuerpo).not.toContain("--tx-status-error");
    expect(CONSOLE_CSS).toContain("--tx-status-warn:         var(--tx-amber-800);");
    expect(CONSOLE_CSS).toContain("--tx-status-error:        var(--tx-red-700);");
  });
});

// =====================================================================
// Revisión de UI/UX y accesibilidad 2026-08-06 (U11) — regresiones
// =====================================================================

describe("step 20 · revisión U11 — nombres accesibles propios, asociaciones y frases servidas", () => {
  it("(U11-1) los 32 botones «Borrar este borrador» llevan nombre accesible PROPIO, servido y distinto dos a dos", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const vista = await workshopOf(app);
    const porId = new Map((vista.entries as Json[]).map((e) => [String(e.entryId), e]));
    const nombres: string[] = [];
    for (const card of todasLasTarjetas(c)) {
      const entryId = String(card.getAttribute("data-key"));
      const boton = botonBorrarDe(card);
      const servido = String((porId.get(entryId) as Json).clearButtonLabel);
      expect(boton.textContent, `botón de ${entryId}`).toBe(servido);
      expect(servido.startsWith(`${WORKSHOP_COPY.clearOneButton} — `)).toBe(true);
      expect(servido.endsWith(entryId)).toBe(true);
      nombres.push(boton.textContent);
    }
    expect(nombres.length).toBe(32);
    expect(new Set(nombres).size).toBe(32);
    await app.close();
  });

  it("(U11-2) el campo de nota queda ASOCIADO por aria-describedby al aviso de datos personales y al contador, con ids únicos", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const ids: string[] = [];
    for (const card of todasLasTarjetas(c)) {
      const entryId = String(card.getAttribute("data-key"));
      const campo = notaDe(card);
      const contador = contadorDe(card);
      const aviso = card.children[4].children[2];
      expect(aviso.textContent).toBe(WORKSHOP_COPY.notePrivacyNote);
      expect(aviso.getAttribute("id")).toBe(`tx-taller-aviso-${entryId}`);
      expect(contador.getAttribute("id")).toBe(`tx-taller-contador-${entryId}`);
      expect(campo.getAttribute("aria-describedby")).toBe(`tx-taller-aviso-${entryId} tx-taller-contador-${entryId}`);
      ids.push(String(aviso.getAttribute("id")), String(contador.getAttribute("id")));
    }
    // 64 ids generados, todos distintos: nada colisiona ni con la barra de J5/K1.
    expect(ids.length).toBe(64);
    expect(new Set(ids).size).toBe(64);
    await app.close();
  });

  it("(U11-3) los 32 <summary> de tarjeta y los 10 de bloque llevan nombre propio: 42 nombres, todos distintos entre sí", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const nombres: string[] = [];
    for (const card of todasLasTarjetas(c)) {
      const summary = card.children[5].children[0];
      expect(summary.textContent.startsWith(`${WORKSHOP_COPY.detailsSummary} — `)).toBe(true);
      nombres.push(summary.textContent);
    }
    for (const grupo of gruposDeBloques(c)) {
      const summary = grupo.children[0].children[1].children[0];
      expect(summary.textContent.startsWith(`${WORKSHOP_COPY.blockDetailsSummary} — `)).toBe(true);
      nombres.push(summary.textContent);
    }
    expect(nombres.length).toBe(42);
    expect(new Set(nombres).size).toBe(42);
    await app.close();
  });

  it("(U11-4) el aparte de J5/K1 se pinta SIN asteriscos y con su clase de cursiva; el acta sigue citando el VERBATIM con ellos", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const vista = await workshopOf(app);
    const combinada = (vista.entries as Json[]).find((e) => e.entryId === "J5/K1") as Json;
    // El servidor sirve las dos variantes: verbatim con marcas, pantalla sin ellas.
    expect(String(combinada.questionAside)).toContain("*");
    expect(String(combinada.questionAsideDisplay)).not.toContain("*");
    expect(String(combinada.questionAsideDisplay)).toBe(String(combinada.questionAside).replace(/\*/g, ""));
    // La tarjeta pinta la variante de pantalla en el span con clase propia.
    const aparte = cardOf(c, "J5/K1").children[1].children[1];
    expect(aparte.className).toContain("tx-taller-card__aparte");
    expect(aparte.textContent).toBe(` ${String(combinada.questionAsideDisplay)}`);
    expect(aparte.textContent).not.toContain("*");
    // Y el acta usa el verbatim, asteriscos incluidos (D20-37.2 intacto).
    const acta = c.hooks.componerActaDelTaller(vista, { "J5/K1": { opcion: "A", nota: "" } });
    expect(acta).toContain(`${String(combinada.question)} ${String(combinada.questionAside)}`);
    await app.close();
  });

  it("(U11-6) filtrar o buscar hasta CERO tarjetas enseña la frase servida del caso vacío, no «Se enseñan 0…» ni el nodo de catálogo ausente", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    // Por búsqueda (tras el rebote de 250 ms).
    buscar(c, "zzzz-nada-de-esto-existe");
    expect(tarjetasVisibles(c).length).toBe(0);
    await dormir(300);
    expect(c.nodes["tx-taller-estado"].textContent).toBe(WORKSHOP_COPY.resultsNone);
    // El estado vacío de §3.13 NO se toca: sigue siendo cosa del catálogo ausente.
    expect(c.nodes["tx-taller-vacio"].hidden).toBe(true);
    expect(c.nodes["tx-taller-lista"].hidden).toBe(false);
    // Por filtro (anuncio inmediato): sin nada anotado, «Con borrador anotado» da cero.
    buscar(c, "");
    clickFiltro(c, "anotadas");
    expect(tarjetasVisibles(c).length).toBe(0);
    expect(c.nodes["tx-taller-estado"].textContent).toBe(WORKSHOP_COPY.resultsNone);
    // Y al volver a «Todas», la frase normal con su recuento.
    clickFiltro(c, "todas");
    expect(c.nodes["tx-taller-estado"].textContent).toBe("Se enseñan 32 de las 32 tarjetas del taller.");
    await app.close();
  });

  it("(U11-7) la coletilla de J5/K1 sólo aparece cuando una entrada RESPONDIDA comparte identificadores, en los dos sentidos", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    const cobertura = c.nodes["tx-taller-cobertura"];
    // K17 es una entrada de UN identificador: 1 de 32, SIN coletilla.
    marcar(cardOf(c, "K17"), "A");
    expect(cobertura.children[0].textContent).toBe("Con respuesta anotada: 1 de 32 preguntas J/K.");
    // J5/K1 comparte respuesta: la coletilla aparece.
    marcar(cardOf(c, "J5/K1"), "A");
    expect(cobertura.children[0].textContent).toBe(
      `Con respuesta anotada: 3 de 32 preguntas J/K. ${WORKSHOP_COPY.coverage.sharedAnswerNote}`,
    );
    // Y desaparece al borrar el borrador de J5/K1.
    (botonBorrarDe(cardOf(c, "J5/K1")).onclick as () => void)();
    expect(cobertura.children[0].textContent).toBe("Con respuesta anotada: 1 de 32 preguntas J/K.");
    await app.close();
  });

  it("(U11-9) el rescate de foco decide sobre lo capturado ANTES de ocultar: también con la búsqueda, y también hasta cero tarjetas", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    // El foco en un radio de K3; una búsqueda que deja CERO tarjetas lo rescata.
    const radioK3 = radioDe(cardOf(c, "K3"), "A");
    radioK3.focus();
    buscar(c, "zzzz-nada-de-esto-existe");
    expect(c.document.activeElement).toBe(c.nodes["tx-taller-estado"]);
    expect(c.nodes["tx-taller-estado"].textContent).toBe(WORKSHOP_COPY.resultsNone);
    // Con la tarjeta enfocada aún visible, el foco NO se mueve: J6 contiene
    // «plazo» en su pregunta, así que la búsqueda la deja a la vista.
    buscar(c, "");
    clickFiltro(c, "todas");
    const radioJ6 = radioDe(cardOf(c, "J6"), "A");
    radioJ6.focus();
    buscar(c, "plazo");
    expect(tarjetasVisibles(c).map((t) => t.getAttribute("data-key"))).toContain("J6");
    expect(c.document.activeElement).toBe(radioJ6);
    // Se agota el rebote de la búsqueda antes de cerrar: ninguna locución queda pendiente.
    await dormir(300);
    await app.close();
  });

  it("(U11-11) el diálogo de borrado total con el borrador VACÍO dice la variante servida de «nada que borrar», y con contenido, la de siempre", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    c.nodes["tx-taller-borrar-todo"].dispatchClick();
    expect(c.nodes["tx-taller-borrar-resumen"].textContent).toBe(WORKSHOP_COPY.dialog.bodyNothing);
    c.nodes["tx-taller-borrar-cancelar"].dispatchClick();
    marcar(cardOf(c, "K17"), "B");
    c.nodes["tx-taller-borrar-todo"].dispatchClick();
    expect(c.nodes["tx-taller-borrar-resumen"].textContent).toBe("Vas a borrar 1 respuesta anotada y 0 notas. No se puede deshacer.");
    await app.close();
  });

  it("(U11-12) la frase permanente de «marcar no re-filtra» está servida y pintada junto a las otras notas de filtro", () => {
    const html = renderConsoleHtml();
    expect(WORKSHOP_COPY.noRefilterNote).toContain("no se recoloca sola");
    expect(html).toContain(`<p class="tx-context__note">${WORKSHOP_COPY.noRefilterNote}</p>`);
    // Junto a la nota de filtros solapados, no en otra punta del panel.
    const idxSolapados = html.indexOf(WORKSHOP_COPY.overlappingFiltersNote);
    const idxNoRefiltra = html.indexOf(WORKSHOP_COPY.noRefilterNote);
    expect(idxSolapados).toBeGreaterThan(-1);
    expect(idxNoRefiltra).toBeGreaterThan(idxSolapados);
    expect(idxNoRefiltra - idxSolapados).toBeLessThan(400);
  });

  it("(U11-14) los dos nombres de filtro citados en la nota de filtros solapados existen como texto de dos botones de filtro reales", () => {
    const html = renderConsoleHtml();
    const citados = [...WORKSHOP_COPY.overlappingFiltersNote.matchAll(/«([^»]+)»/g)].map((m) => m[1]);
    expect(citados).toEqual(["Sin respuesta", "Con borrador anotado"]);
    for (const nombre of citados) {
      // Si alguien renombra el botón, la frase servida quedaría huérfana: esta
      // aserción acopla las dos cosas a propósito.
      expect(html).toMatch(new RegExp(`<button[^>]*id="tx-taller-filtro-[^"]+"[^>]*>${nombre}</button>`));
    }
  });
});
