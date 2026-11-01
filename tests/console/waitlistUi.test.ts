import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { WAITLIST_COPY } from "../../src/console/waitlistSnapshot.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeElement, type FakeDocument } from "./fakeDom.js";

/**
 * step 17 · fase D — LA PANTALLA de la lista de espera.
 *
 * Cubre la parte AUTOMATIZABLE de los criterios 20 a 24 del §12 del diseño,
 * con la misma técnica que el resto de las pruebas de interfaz de esta
 * consola: se ejecuta el JavaScript REAL que sirve `GET /app.js`
 * (`uiClientExtract.ts`) contra el DOM falso mínimo de `fakeDom.ts`, y se
 * pinta con INSTANTÁNEAS REALES del servidor, pedidas por `app.inject()`.
 * No hay ni un dato inventado a mano en las instantáneas.
 *
 * LO QUE ESTAS PRUEBAS NO FIRMAN. El escenario 18 del §10 —recorrido
 * responsive y de teclado a 1440/1280/1024/768/~690— sólo lo puede firmar el
 * runbook del Mac en un navegador de verdad, y así consta en el propio
 * diseño. `fakeDom.ts` no emula orden de tabulación, ni activación nativa,
 * ni la trampa de foco del `<dialog>`, ni el Escape que el navegador se come
 * antes de que llegue al documento, ni una sola regla de CSS. Lo de aquí es
 * regresión barata, no la verificación visual.
 */

const TEST_SALT = "waitlist-ui-test-salt";

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

/**
 * Las tres instantáneas con las que se pinta todo lo de abajo, cada una un
 * momento REAL de la demostración:
 *  - `snapCancelada`: dos cancelaciones hechas (una dentro de plazo con dos
 *    huecos y dos compatibles, otra fuera de plazo pendiente de revisar).
 *  - `snapAceptada`: además, aviso simulado a Cliente A y aceptación anotada.
 *  - `snapRobada`: además, una llamada del Laboratorio se ha llevado el hueco,
 *    así que la oferta de Cliente A ya no vale (§14.6).
 */
let snapCancelada: Json;
let snapAceptada: Json;
let snapRobada: Json;

beforeAll(async () => {
  const app = freshApp();
  await post(app, "/api/reset", {});
  expect((await cancel(app, "demo-salon-res-2")).statusCode).toBe(200);
  expect((await cancel(app, "demo-salon-res-1", "client_cancelled_by_phone_simulated")).statusCode).toBe(200);
  snapCancelada = await snapshotOf(app);

  // (step 23, R2) Una persona aprueba la propuesta de ESE hueco antes de que
  // se pueda simular ningún aviso. Se añade el acto que faltaba; no se relaja
  // ninguna aserción de esta suite.
  expect(
    (await post(app, "/api/waitlist/entries/wl-f01/command", {
      command: "approve_proposal",
      slotKey: "slot-2026-08-04-780-3",
    })).statusCode,
  ).toBe(200);
  expect((await post(app, "/api/waitlist/entries/wl-f01/command", { command: "simulate_notice" })).statusCode).toBe(200);
  expect((await post(app, "/api/waitlist/entries/wl-f01/command", { command: "record_acceptance" })).statusCode).toBe(200);
  snapAceptada = await snapshotOf(app);

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
  snapRobada = await snapshotOf(app);
  await app.close();
});

// ---------------------------------------------------------------------
// Utilidades del DOM falso
// ---------------------------------------------------------------------

/** Los contenedores que `renderListaEspera()` busca por id en el HTML real. */
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

/**
 * El documento de la pantalla. El historial estructurado se cuelga de un
 * `<details>` de verdad, igual que en `ui.html.ts`: es lo que permite
 * comprobar el criterio 22 sobre la ANCESTRÍA real de cada texto y no sobre
 * una lista de ids escrita a mano.
 */
function documentoListaEspera(): { document: FakeDocument; nodes: Record<string, FakeElement> } {
  const { document, nodes } = createFakeDocumentWithIds([...LISTA_ESPERA_IDS]);
  const details = document.createElement("details");
  const body = document.createElement("div");
  details.appendChild(body);
  body.appendChild(nodes["le-tecnico-historial-contador"] as FakeElement);
  body.appendChild(nodes["le-tecnico-historial"] as FakeElement);
  return { document, nodes };
}

/**
 * La pantalla ENTERA, cargada por el camino de verdad: se enruta a
 * `#/lista-espera` y se ejecuta el sondeo real (`refresh()`), con `fetch`
 * sustituido por una instantánea que ha producido el servidor de verdad. Es
 * la única forma honesta de que la consola tenga guardada su instantánea,
 * que es de donde leen los diálogos.
 */
async function cargarPantalla(snap: Json, extraIds: readonly (string | { id: string; tag: string })[] = []) {
  const { document, nodes } = createFakeDocumentWithIds([
    ...LISTA_ESPERA_IDS,
    "tx-view-title",
    "tx-freshness",
    "inicio-ruta-desconocida",
    ...extraIds,
  ]);
  const details = document.createElement("details");
  const body = document.createElement("div");
  details.appendChild(body);
  body.appendChild(nodes["le-tecnico-historial-contador"] as FakeElement);
  body.appendChild(nodes["le-tecnico-historial"] as FakeElement);

  const hooks = loadUiClientHooks("#/lista-espera", document);
  hooks.applyRoute();
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve(snap) })) as unknown as typeof fetch;
  try {
    await hooks.refresh();
  } finally {
    globalThis.fetch = original;
  }
  return { document, nodes, hooks };
}

function walk(node: FakeElement, visit: (n: FakeElement, dentroDeDetails: boolean) => void, dentro = false): void {
  const ahora = dentro || node.tagName === "DETAILS";
  visit(node, ahora);
  for (const child of node.children) walk(child, visit, ahora);
}

function dentroDeDetails(nodo: FakeElement): boolean {
  let cursor: FakeElement | null = nodo;
  while (cursor !== null) {
    if (cursor.tagName === "DETAILS") return true;
    cursor = cursor.parentNode;
  }
  return false;
}

/** Todo el texto que se ve FUERA de un `<details>`, hoja por hoja. */
function textosVisibles(raiz: FakeElement): string[] {
  const textos: string[] = [];
  if (dentroDeDetails(raiz)) return textos;
  walk(raiz, (n, plegado) => {
    if (plegado) return;
    if (n.children.length > 0) return;
    const t = n.textContent;
    if (t.length > 0) textos.push(t);
  });
  return textos;
}

function todoElTexto(raiz: FakeElement): string {
  const textos: string[] = [];
  walk(raiz, (n) => {
    if (n.children.length === 0 && n.textContent.length > 0) textos.push(n.textContent);
  });
  return textos.join("\n");
}

function buscar(raiz: FakeElement, predicado: (n: FakeElement) => boolean): FakeElement | null {
  let encontrado: FakeElement | null = null;
  walk(raiz, (n) => {
    if (encontrado === null && predicado(n)) encontrado = n;
  });
  return encontrado;
}

function todos(raiz: FakeElement, predicado: (n: FakeElement) => boolean): FakeElement[] {
  const lista: FakeElement[] = [];
  walk(raiz, (n) => {
    if (predicado(n)) lista.push(n);
  });
  return lista;
}

/**
 * (step 23) Un botón por su TEXTO, no por su posición: la tarjeta de hueco
 * tiene ahora tres botones y el orden lo manda el diseño, no las pruebas.
 * Falla ruidosamente si no está — un `null` silencioso daría verde sobre una
 * tarjeta a la que le falta el control.
 */
function botonPorTexto(raiz: FakeElement, texto: string): FakeElement {
  const boton = buscar(raiz, (n) => n.tagName === "BUTTON" && n.textContent === texto);
  expect(boton, `no hay ningún botón que diga "${texto}"`).not.toBeNull();
  return boton as FakeElement;
}

/** Ídem para cada `<details>`, por el texto de su `<summary>`. */
function detallePorTitulo(raiz: FakeElement, titulo: string): FakeElement {
  const det = buscar(
    raiz,
    (n) => n.tagName === "DETAILS" && (n.children[0] as FakeElement | undefined)?.textContent === titulo,
  );
  expect(det, `no hay ningún <details> titulado "${titulo}"`).not.toBeNull();
  return det as FakeElement;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// =====================================================================
// Navegación (§9.1)
// =====================================================================

describe("step 17 · §9.1 — la ruta #/lista-espera existe y está entre Agenda y Llamadas", () => {
  const html = renderConsoleHtml();

  it("'#/lista-espera' resuelve a su propia sección, no a Inicio marcada como desconocida", () => {
    // (step 26 §9/C7) parseHash() gana `params` de forma retrocompatible;
    // `param` no cambia. Ajuste mecánico de forma, no de comportamiento.
    expect(loadUiClientHooks("#/lista-espera").parseHash()).toEqual({ section: "lista-espera", param: undefined, params: [] });
  });

  it("el ítem de navegación va DESPUÉS de Agenda y ANTES de Llamadas: es operativo, no una herramienta", () => {
    const agenda = html.indexOf('data-route="agenda"');
    const lista = html.indexOf('data-route="lista-espera"');
    const llamadas = html.indexOf('data-route="llamadas"');
    const laboratorio = html.indexOf('data-route="laboratorio"');
    expect(agenda).toBeGreaterThan(-1);
    expect(lista).toBeGreaterThan(agenda);
    expect(llamadas).toBeGreaterThan(lista);
    // Y sigue estando fuera del bloque de "Herramientas de demostración".
    expect(laboratorio).toBeGreaterThan(html.indexOf("Herramientas de demostración"));
    expect(lista).toBeLessThan(html.indexOf("Herramientas de demostración"));
  });

  it("la sección y los cuatro diálogos nuevos llegan en el HTML servido, ocultos", () => {
    expect(html).toContain('id="vista-lista-espera"');
    for (const id of ["dialogo-cancelar-cita", "dialogo-alta-lista", "dialogo-simular-aviso", "dialogo-convertir"]) {
      expect(html).toContain(`id="${id}"`);
    }
    const seccion = /<section[^>]*id="vista-lista-espera"[^>]*>/.exec(html);
    expect(seccion?.[0]).toMatch(/\shidden(\s|>)/);
  });
});

// =====================================================================
// Criterio 20 — la pantalla no deriva nada
// =====================================================================

describe("step 17 · criterio 20 — el bloque de lista de espera no recalcula horarios ni fechas", () => {
  const js = renderConsoleAppJs();

  function bloqueListaEspera(): string {
    const inicio = js.indexOf("// LISTA DE ESPERA (step 17 §9) — INICIO DEL BLOQUE");
    const fin = js.indexOf("// LISTA DE ESPERA — FIN DEL BLOQUE");
    expect(inicio, "no se ha encontrado la marca de inicio del bloque de lista de espera").toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(inicio);
    // Sin comentarios: los docblocks de ese bloque NOMBRAN a propósito las
    // funciones que prometen no llamar, y esa promesa escrita no puede
    // hacer fallar (ni pasar) a esta prueba.
    return stripComments(js.slice(inicio, fin));
  }

  it("no llama a resolveVenueDay, venueWeekdayHours, activeSeasonalOverride ni collectDistinctDays", () => {
    const bloque = bloqueListaEspera();
    for (const nombre of ["resolveVenueDay", "venueWeekdayHours", "activeSeasonalOverride", "collectDistinctDays"]) {
      expect(bloque.includes(nombre), `${nombre} aparece en el bloque de lista de espera`).toBe(false);
    }
  });

  it("no contiene aritmética de fechas: ni new Date, ni dateFromISO, ni addDaysISO, ni getTime/getDay/setDate", () => {
    const bloque = bloqueListaEspera();
    for (const token of ["new Date", "dateFromISO", "addDaysISO", "toISODate", "parseISODateParts", "getTime()", "getDay()", "setDate("]) {
      expect(bloque.includes(token), `${token} aparece en el bloque de lista de espera`).toBe(false);
    }
  });

  it("lo único con lo que da forma a un dato es el formateo de presentación que ya compartía la consola", () => {
    const bloque = bloqueListaEspera();
    // `formatDateTimeLong` es el MISMO ayudante que usa el detalle técnico de
    // Llamadas: convierte una marca de tiempo en castellano y no decide nada.
    // Se declara aquí como la única concesión, para que añadir otra obligue a
    // tocar esta prueba.
    const usados = ["formatDateTimeLong", "formatMinutes", "formatDateLong", "formatTimeFromISO", "formatDateShort", "formatDateRangeLong"].filter(
      (n) => bloque.includes(n),
    );
    expect(usados).toEqual(["formatDateTimeLong"]);
  });

  it("lee la clave `waitlist` ya resuelta del servidor, que es de donde sale todo lo que pinta", () => {
    expect(bloqueListaEspera()).toContain("snap.waitlist");
  });

  it("la frase de plazo del diálogo de cancelar es SOLO la resta de minutos del §3.1, y vive fuera de ese bloque", () => {
    const { document, nodes } = createFakeDocumentWithIds([
      { id: "dialogo-cancelar-cita", tag: "dialog" },
      "dialogo-cancelar-cita-titulo",
      "cancelar-cita-paso-1",
      "cancelar-cita-paso-2",
      "cancelar-cita-error",
      "cancelar-cita-resultado",
      { id: "cancelar-cita-detalle", tag: "ul" },
      "cancelar-cita-confirmar",
      { id: "cancelar-cita-motivo", tag: "select" },
      "cancelar-cita-resumen",
      "cancelar-cita-plazo",
      "tx-view-title",
    ]);
    const { fraseDePlazoPrevisto } = loadUiClientHooks("", document);
    void nodes;
    // 09:30 con "ahora" a las 09:00 → 30 minutos, plazo 120 → fuera de plazo.
    // Es exactamente la aritmética del §3.1 y la frontera del §3.2.
    const tarde = fraseDePlazoPrevisto(snapCancelada, { date: "2026-08-04", startMinutes: 570 });
    expect(tarde).toContain("Faltan 30 minutos para esta cita.");
    expect(tarde).toContain("El plazo configurado son 120 minutos.");
    expect(tarde).toContain("quedará marcada como fuera de plazo");

    // 11:00 → 120 minutos exactos. La frontera es INCLUSIVA en "dentro de plazo".
    const justo = fraseDePlazoPrevisto(snapCancelada, { date: "2026-08-04", startMinutes: 660 });
    expect(justo).toContain("quedará marcada como dentro de plazo");

    // Un día por delante: 1440 + 600 - 540 = 1500 minutos.
    const otroDia = fraseDePlazoPrevisto(snapCancelada, { date: "2026-08-05", startMinutes: 600 });
    expect(otroDia).toContain("Faltan 1500 minutos para esta cita.");

    // Y una cita ya empezada se dice sin números negativos.
    const empezada = fraseDePlazoPrevisto(snapCancelada, { date: "2026-08-04", startMinutes: 480 });
    expect(empezada).toContain("Esta cita empezó hace 60 minutos.");
    expect(empezada).toContain("quedará marcada como fuera de plazo");
  });
});

// =====================================================================
// Criterio 21 — las frases de las no-reglas, literales
// =====================================================================

describe("step 17 · criterio 21 — las frases del §5 aparecen literalmente, y salen de una sola fuente", () => {
  const html = renderConsoleHtml();

  /** Las que valen para todo un bloque viven como texto ESTÁTICO en el HTML servido. */
  const EN_EL_HTML: readonly (keyof typeof WAITLIST_COPY)[] = [
    "onlyThisSlot",
    "noAcceptanceDeadline",
    "readingOrderExplained",
    "noPenalty",
    "nothingExpires",
    "simulatedNoticeOnly",
    "changingPolicyDoesNotRewrite",
    "frozenClock",
    "futureDesign",
    "syntheticReservationWarning",
    "emptyPendingSlots",
    "emptyEntries",
  ];

  it("cada frase de bloque está en el HTML servido, carácter a carácter igual que en WAITLIST_COPY", () => {
    for (const clave of EN_EL_HTML) {
      const frase = WAITLIST_COPY[clave];
      expect(html.includes(frase), `falta (o está reescrita) la frase '${clave}' en el HTML servido`).toBe(true);
    }
  });

  it("las cinco no-reglas del §5 se leen enteras en la pantalla: cuatro en el HTML y la del hueco, al pintarlo", () => {
    // 5.1 orden de lectura · 5.2 nada caduca · 5.4 sin penalización ·
    // 5.5 aviso simulado, en el HTML estático. La quinta se escribe por hueco,
    // leyéndola de la instantánea: era «el sistema no ha elegido a nadie» y
    // desde step 23 (§9) es la que sigue siendo verdad — que la sugerencia no
    // es una decisión y que nadie recibe el hueco sin que una persona lo
    // apruebe y avise.
    for (const clave of ["readingOrderExplained", "nothingExpires", "noPenalty", "simulatedNoticeOnly"] as const) {
      expect(html).toContain(WAITLIST_COPY[clave]);
    }
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    const texto = todoElTexto(nodes["le-huecos-lista"] as FakeElement);
    expect(texto).toContain(WAITLIST_COPY.proposalIsSuggestion);
    expect(texto).toContain(WAITLIST_COPY.severalFit);
    expect(texto).toContain(WAITLIST_COPY.readingOrderNote);
  });

  it("la pantalla no reescribe ninguna: lo que pinta es EXACTAMENTE lo que trae waitlist.copy de la instantánea", () => {
    const copy = (snapCancelada.waitlist as Json).copy as Record<string, string>;
    // La proyección y el HTML dicen lo mismo. Si alguien retocara una coma en
    // cualquiera de los dos lados, esto cae.
    for (const clave of EN_EL_HTML) {
      expect(copy[clave]).toBe(WAITLIST_COPY[clave]);
    }
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    expect(todoElTexto(nodes["le-huecos-lista"] as FakeElement)).toContain(copy.proposalIsSuggestion);
  });

  it("el verbo 'enviar' no aparece nunca junto al aviso simulado (§5.5), ni hay ningún icono de mensajería", () => {
    const seccion = html.slice(html.indexOf('id="vista-lista-espera"'), html.indexOf('id="vista-llamadas"'));
    // La única forma en que aparece "envia/enviado" es negándolo.
    const fuera = seccion.replace(/<details[\s\S]*?<\/details>/g, "");
    for (const trozo of fuera.split("\n")) {
      if (/enviad|enviar|env[ií]a/i.test(trozo)) {
        expect(trozo, "aparece 'enviar' sin negarlo").toMatch(/No se ha enviado/);
      }
    }
    for (const icono of ["✉", "📩", "📧", "📱", "💬", "☎"]) {
      expect(seccion.includes(icono), `aparece un icono de mensajería (${icono})`).toBe(false);
    }
  });

  it("§9.6: ni cuenta atrás, ni 'recomendado', ni 'avisar a todos', ni ninguna cifra nueva en Inicio", () => {
    const seccion = html.slice(html.indexOf('id="vista-lista-espera"'), html.indexOf('id="vista-llamadas"'));
    const js = stripComments(renderConsoleAppJs());
    for (const prohibido of ["recomendad", "prioritari", "cuenta atrás", "avisar a todos", "el primero de la cola", "automátic"]) {
      expect(seccion.toLowerCase().includes(prohibido), `'${prohibido}' aparece en la pantalla`).toBe(false);
      expect(js.toLowerCase().includes(prohibido), `'${prohibido}' aparece en el JavaScript servido`).toBe(false);
    }
    // Inicio sigue teniendo exactamente sus cuatro tarjetas de cifra.
    const inicio = html.slice(html.indexOf('id="vista-inicio"'), html.indexOf('id="vista-agenda"'));
    expect((inicio.match(/class="tx-stat"/g) ?? []).length).toBe(4);
  });
});

// =====================================================================
// Criterio 22 — ningún enum técnico fuera de un <details>
// =====================================================================

describe("step 17 · criterio 22 — el vocabulario interno vive sólo dentro del <details> técnico", () => {
  const PROHIBIDO: readonly string[] = [
    // Estados internos
    "pending",
    "matched",
    "notice_simulated",
    "accepted",
    "declined",
    "expired_manually",
    "converted",
    "withdrawn",
    // Motivos de incompatibilidad
    "slot_no_longer_free",
    "time_outside_preferred_window",
    "date_outside_preferred_range",
    "different_professional_requested",
    "professional_cannot_perform_service",
    "date_outside_booking_horizon",
    "slot_in_the_past",
    // Comandos
    "simulate_notice",
    "record_acceptance",
    "record_decline",
    "release_match",
    "expire_manually",
    // Identificadores y claves
    "slotKey",
    "slot-2026",
    "cxl-",
    "wl-f0",
    "demo-salon-res-",
    "Idempotency",
    "convert:",
    "WAITLIST_",
    "SLOT_RELEASED",
    "RESERVATION_CANCELLED",
    "DEMO_RESET",
  ];

  it("con una instantánea real, ni un solo texto pintado fuera de un <details> contiene vocabulario interno", () => {
    for (const snap of [snapCancelada, snapAceptada, snapRobada]) {
      const { document, nodes } = documentoListaEspera();
      loadUiClientHooks("", document).renderListaEspera(snap);
      for (const id of Object.keys(nodes)) {
        for (const texto of textosVisibles(nodes[id] as FakeElement)) {
          for (const token of PROHIBIDO) {
            expect(texto.includes(token), `'${token}' se ve en #${id}: "${texto}"`).toBe(false);
          }
        }
      }
    }
  });

  it("el historial estructurado —que SÍ lleva ese vocabulario— está dentro del <details>, no suelto", () => {
    const html = renderConsoleHtml();
    const seccion = html.slice(html.indexOf('id="vista-lista-espera"'), html.indexOf('id="vista-llamadas"'));
    const details = seccion.indexOf("<details");
    const cierre = seccion.indexOf("</details>");
    const historial = seccion.indexOf('id="le-tecnico-historial"');
    expect(details).toBeGreaterThan(-1);
    expect(historial).toBeGreaterThan(details);
    expect(historial).toBeLessThan(cierre);
    expect(seccion.indexOf("Detalle técnico")).toBeGreaterThan(details);
  });

  it("y en el HTML servido, quitando lo que va dentro de <details>, tampoco queda ningún enum a la vista", () => {
    const html = renderConsoleHtml();
    const seccion = html.slice(html.indexOf('id="vista-lista-espera"'), html.indexOf('id="vista-llamadas"'));
    const fuera = seccion.replace(/<details[\s\S]*?<\/details>/g, "");
    for (const token of PROHIBIDO) {
      expect(fuera.includes(token), `'${token}' aparece fuera del <details> en el HTML de la pantalla`).toBe(false);
    }
  });
});

// =====================================================================
// La pantalla, bloque por bloque (§9.2)
// =====================================================================

describe("step 17 · §9.2 bloque 1 — huecos liberados que esperan una decisión", () => {
  it("sólo salen los huecos con decisión pendiente, y cada uno enseña sus compatibles en orden de creación", () => {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    const lista = nodes["le-huecos-lista"] as FakeElement;
    const pendientes = ((snapCancelada.waitlist as Json).releasedSlots as Json[]).filter((s) => s.decisionPending === true);
    expect(pendientes.length).toBeGreaterThan(0);
    expect(lista.children.length).toBe(pendientes.length);
    expect((nodes["le-huecos-contador"] as FakeElement).textContent).toBe(`(${String(pendientes.length)})`);
    expect((nodes["le-huecos-vacio"] as FakeElement).hidden).toBe(true);

    // (step 23 §8.3, punto 4) La lista de radios ya no es «todos los
    // compatibles»: es «las DEMÁS personas compatibles», restringida a
    // `substitutableEntryIds`. Quien está propuesto vive arriba, en su propio
    // bloque, y quien el servidor rechazaría como sustituto no se ofrece —
    // sería un radio que sólo puede llevar a un 409.
    const primera = lista.children[0] as FakeElement;
    const radios = todos(primera, (n) => n.type === "radio");
    const primerHueco = pendientes[0] as Json;
    expect(radios.map((r) => r.value)).toEqual(primerHueco.substitutableEntryIds);
    expect(primerHueco.compatibleEntryIds).toContain((primerHueco.proposal as Json).entryId);
    expect(primerHueco.substitutableEntryIds).not.toContain((primerHueco.proposal as Json).entryId);
  });

  it("§5.1: NINGÚN radio nace marcado, ni siquiera cuando sólo hay un compatible", () => {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    const radios = todos(nodes["le-huecos-lista"] as FakeElement, (n) => n.type === "radio");
    expect(radios.length).toBeGreaterThan(0);
    expect(radios.every((r) => r.checked === false)).toBe(true);
  });

  it("el botón de SUSTITUIR nace deshabilitado y sólo se enciende cuando alguien elige a otra persona", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera } = loadUiClientHooks("", document);
    renderListaEspera(snapCancelada);
    const tarjeta = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
    // (step 23 §8.3) El botón que depende de la elección de radio ya no es
    // el de avisar —ése depende de la PROPUESTA, no de un radio— sino el de
    // sustituir. Se busca por su texto, no por ser el primer <button> de la
    // tarjeta: el orden de la tarjeta es cosa del diseño y una prueba no
    // debería quedar atada a él.
    //
    // (Reparación R2-UX, defecto 6) Y ese texto cambió a propósito: el
    // comando SUSTITUYE Y APRUEBA en el mismo acto, así que la etiqueta
    // «Proponer a esta persona en su lugar» sólo contaba la mitad.
    const boton = botonPorTexto(tarjeta, "Sustituir y aprobar esta propuesta");
    expect(boton.disabled).toBe(true);

    const radio = todos(tarjeta, (n) => n.type === "radio")[0] as FakeElement & { onchange?: () => void };
    radio.onchange?.();
    expect(boton.disabled).toBe(false);

    // Y la elección sobrevive al siguiente sondeo: la marca no se pierde ni
    // el botón se vuelve a apagar.
    renderListaEspera(snapCancelada);
    expect(radio.checked).toBe(true);
    expect(boton.disabled).toBe(false);
  });

  it("los incompatibles y su motivo en castellano cuelgan de un <details>, con el texto que da el servidor", () => {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    const tarjeta = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
    // Se busca POR SU TÍTULO: la tarjeta tiene ahora tres <details> (las demás
    // compatibles, por qué el resto no encaja, y lo que ha pasado con este
    // hueco), y coger «el primero» sería atarse al orden del diseño.
    const details = detallePorTitulo(tarjeta, "Por qué el resto no encaja");
    expect(details).not.toBeNull();
    const primerHueco = ((snapCancelada.waitlist as Json).releasedSlots as Json[]).find((s) => s.decisionPending === true) as Json;
    const incompatibles = primerHueco.incompatible as Json[];
    expect(incompatibles.length).toBeGreaterThan(0);
    const texto = todoElTexto(details);
    for (const item of incompatibles) {
      expect(texto).toContain(item.clientLabel as string);
      for (const motivo of item.reasons as Json[]) {
        expect(texto).toContain(motivo.label as string);
      }
    }
  });

  it("cuando no hay ningún hueco esperando decisión, se dice con la frase del diseño y se esconde la nota de orden", () => {
    const { document, nodes } = documentoListaEspera();
    const snapVacio = JSON.parse(JSON.stringify(snapCancelada)) as Json;
    ((snapVacio.waitlist as Json).releasedSlots as Json[]).forEach((s) => {
      s.decisionPending = false;
    });
    loadUiClientHooks("", document).renderListaEspera(snapVacio);
    expect((nodes["le-huecos-vacio"] as FakeElement).hidden).toBe(false);
    expect((nodes["le-huecos-orden"] as FakeElement).hidden).toBe(true);
    expect((nodes["le-huecos-lista"] as FakeElement).children.length).toBe(0);
  });
});

describe("step 17 · §9.2 bloque 2 — cancelaciones fuera del plazo configurado", () => {
  it("sale sólo lo que está pendiente de revisar, con el veredicto y las cifras que da el servidor", () => {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    expect((nodes["le-bloque-tardias"] as FakeElement).hidden).toBe(false);
    const tarjetas = (nodes["le-tardias-lista"] as FakeElement).children;
    expect(tarjetas.length).toBe(1);
    const texto = todoElTexto(tarjetas[0] as FakeElement);
    expect(texto).toContain("Cancelación fuera del plazo configurado");
    expect(texto).toContain("Se avisó con 30 minutos de antelación");
    expect(texto).toContain("plazo aplicado en ese momento eran 120 minutos");
    expect(texto).toContain("Marcar como revisada (sin acción)");
  });

  it("el bloque entero desaparece cuando no hay ninguna cancelación tardía pendiente", () => {
    const { document, nodes } = documentoListaEspera();
    const snapSinTardias = JSON.parse(JSON.stringify(snapCancelada)) as Json;
    ((snapSinTardias.waitlist as Json).cancellations as Json[]).forEach((c) => {
      c.reviewState = "reviewed_no_action";
    });
    loadUiClientHooks("", document).renderListaEspera(snapSinTardias);
    expect((nodes["le-bloque-tardias"] as FakeElement).hidden).toBe(true);
  });
});

describe("step 17 · §9.2 bloque 3 — personas apuntadas", () => {
  it("los tres grupos del filtro son EXACTAMENTE la tabla de estados del §2.1 del diseño", () => {
    const { ESTADOS_POR_GRUPO } = loadUiClientHooks();
    expect(ESTADOS_POR_GRUPO.activas).toEqual(["pending", "matched", "notice_simulated", "accepted"]);
    expect(ESTADOS_POR_GRUPO.latentes).toEqual(["declined", "expired_manually"]);
    expect(ESTADOS_POR_GRUPO.cerradas).toEqual(["converted", "withdrawn"]);
    // Los ocho estados del modelo, sin solapes y sin dejarse ninguno.
    const todosLosEstados = [...ESTADOS_POR_GRUPO.activas, ...ESTADOS_POR_GRUPO.latentes, ...ESTADOS_POR_GRUPO.cerradas];
    expect(new Set(todosLosEstados).size).toBe(8);
  });

  it("cada fila enseña la etiqueta, el estado, la preferencia y el origen que ya vienen resueltos del servidor", () => {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    const filas = (nodes["le-personas-tbody"] as FakeElement).children;
    const entradas = ((snapCancelada.waitlist as Json).entries as Json[]).filter((e) =>
      ["pending", "matched", "notice_simulated", "accepted"].includes(e.state as string),
    );
    expect(filas.length).toBe(entradas.length);
    const primera = entradas[0] as Json;
    const texto = todoElTexto(filas[0] as FakeElement);
    expect(texto).toContain(primera.clientLabel as string);
    expect(texto).toContain(primera.stateLabel as string);
    expect(texto).toContain(primera.preferenceSummary as string);
    expect(texto).toContain(primera.optInLabel as string);
  });

  it("los botones de una fila son EXACTAMENTE los availableCommands del servidor, con su nombre en castellano", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera, COMANDO_ETIQUETAS } = loadUiClientHooks("", document);
    renderListaEspera(snapAceptada);
    const entrada = ((snapAceptada.waitlist as Json).entries as Json[]).find((e) => e.id === "wl-f01") as Json;
    expect(entrada.state).toBe("accepted");
    const fila = ((nodes["le-personas-tbody"] as FakeElement).children as FakeElement[]).find(
      (tr) => tr.getAttribute("data-key") === "wl-f01",
    ) as FakeElement;
    const celda = fila.children[4] as FakeElement;
    const esperados = (entrada.availableCommands as string[]).map((c) => COMANDO_ETIQUETAS[c]);
    expect(celda.children.map((b) => b.textContent)).toEqual(esperados);
    // Y ninguna etiqueta se queda sin traducir: nunca se enseña el comando crudo.
    expect(esperados.every((e) => typeof e === "string" && e.length > 0)).toBe(true);
  });

  it("§14.6: cuando una llamada se lleva el hueco, 'Crear la reserva' se apaga y el motivo queda escrito", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera, COMANDO_ETIQUETAS } = loadUiClientHooks("", document);
    renderListaEspera(snapRobada);
    const entrada = ((snapRobada.waitlist as Json).entries as Json[]).find((e) => e.id === "wl-f01") as Json;
    const oferta = entrada.offer as Json;
    expect(oferta.stillValid).toBe(false);
    const fila = ((nodes["le-personas-tbody"] as FakeElement).children as FakeElement[]).find(
      (tr) => tr.getAttribute("data-key") === "wl-f01",
    ) as FakeElement;
    const boton = todos(fila, (n) => n.textContent === COMANDO_ETIQUETAS.convert)[0] as FakeElement;
    expect(boton.disabled).toBe(true);
    // El motivo lo escribe el servidor y se enseña tal cual, junto al botón.
    const motivos = (oferta.invalidReasons as Json[]).map((r) => r.label as string);
    expect(motivos.length).toBeGreaterThan(0);
    const texto = todoElTexto(fila);
    for (const motivo of motivos) expect(texto).toContain(motivo);
    expect(boton.getAttribute("aria-describedby")).toBe("le-motivo-wl-f01");
  });

  it("§14.6 extendido (revisión adversarial de step 22, N1): con la oferta muerta también se apaga 'Simular aviso'", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera, COMANDO_ETIQUETAS } = loadUiClientHooks("", document);
    renderListaEspera(snapRobada);
    // Cliente B compite por el mismo hueco de las 13:00 que la llamada acaba
    // de llevarse: sigue `matched`, con una oferta que ya no vale. Su
    // `simulate_notice` sólo puede devolver 409, así que se apaga igual que
    // 'Crear la reserva', con el motivo escrito al lado.
    const entrada = ((snapRobada.waitlist as Json).entries as Json[]).find((e) => e.id === "wl-f02") as Json;
    expect(entrada.state).toBe("matched");
    expect((entrada.offer as Json).stillValid).toBe(false);
    const fila = ((nodes["le-personas-tbody"] as FakeElement).children as FakeElement[]).find(
      (tr) => tr.getAttribute("data-key") === "wl-f02",
    ) as FakeElement;
    const boton = todos(fila, (n) => n.textContent === COMANDO_ETIQUETAS.simulate_notice)[0] as FakeElement;
    expect(boton.disabled).toBe(true);
    expect(boton.getAttribute("aria-describedby")).toBe("le-motivo-wl-f02");
    const texto = todoElTexto(fila);
    for (const motivo of (entrada.offer as Json).invalidReasons as Json[]) {
      expect(texto).toContain(motivo.label as string);
    }
    // Y lo que NO depende de la oferta sigue encendido: se puede soltar la
    // oferta muerta, retirarse o caducar a mano.
    for (const cmd of ["release_match", "withdraw", "expire_manually"]) {
      const otro = todos(fila, (n) => n.textContent === COMANDO_ETIQUETAS[cmd])[0] as FakeElement;
      expect(otro.disabled, cmd).toBe(false);
    }
  });

  it("§5.5: donde se dice 'Aviso simulado' se dice también que no se ha enviado ni llamado nada", () => {
    const app = null;
    void app;
    const { document, nodes } = documentoListaEspera();
    const snapAviso = JSON.parse(JSON.stringify(snapCancelada)) as Json;
    const entradas = (snapAviso.waitlist as Json).entries as Json[];
    const entrada = entradas.find((e) => e.id === "wl-f01") as Json;
    entrada.state = "notice_simulated";
    entrada.stateLabel = "Aviso simulado";
    entrada.stateTone = "derived";
    loadUiClientHooks("", document).renderListaEspera(snapAviso);
    const fila = ((nodes["le-personas-tbody"] as FakeElement).children as FakeElement[]).find(
      (tr) => tr.getAttribute("data-key") === "wl-f01",
    ) as FakeElement;
    const texto = todoElTexto(fila);
    expect(texto).toContain("Aviso simulado");
    expect(texto).toContain(WAITLIST_COPY.simulatedNoticeOnly);
  });

  it("el estado nunca lo lleva sólo el color: cada píldora trae glifo y texto", () => {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapAceptada);
    const pildoras = todos(nodes["le-personas-tbody"] as FakeElement, (n) => n.className.split(/\s+/)[0] === "tx-pill");
    expect(pildoras.length).toBeGreaterThan(0);
    for (const pildora of pildoras) {
      expect(pildora.children.length).toBe(2);
      expect((pildora.children[0] as FakeElement).getAttribute("aria-hidden")).toBe("true");
      expect((pildora.children[1] as FakeElement).textContent.length).toBeGreaterThan(0);
    }
  });
});

describe("step 17 · §9.2 bloque 4 y cifras — el plazo y los números", () => {
  it("el desplegable trae las seis opciones del servidor y marca la vigente, sin inventar ninguna", () => {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    const sel = nodes["le-plazo-select"] as FakeElement;
    const opciones = ((snapCancelada.waitlist as Json).policy as Json).options as Json[];
    expect(opciones.length).toBe(6);
    expect(sel.options.map((o) => o.textContent)).toEqual(opciones.map((o) => o.label));
    expect(sel.value).toBe("120");
    expect((nodes["le-plazo-frase"] as FakeElement).textContent).toBe(
      "Dentro de plazo = avisar con 120 minutos o más de antelación.",
    );
    expect((nodes["le-plazo-demo"] as FakeElement).textContent).toContain(WAITLIST_COPY.policyIsDemoValue);
  });

  it("las cifras son las del §11, ninguna es de tiempo, y todas salen de metrics", () => {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    const dl = nodes["le-cifras"] as FakeElement;
    const metrics = (snapCancelada.waitlist as Json).metrics as Record<string, unknown>;
    expect(dl.children.length).toBe(12);
    const leidas: Record<string, string> = {};
    for (const wrap of dl.children) {
      leidas[(wrap.children[0] as FakeElement).textContent] = (wrap.children[1] as FakeElement).textContent;
    }
    expect(leidas["Huecos liberados"]).toBe(String(metrics.slotsReleasedTotal));
    expect(leidas["Cancelaciones fuera de plazo pendientes de revisar"]).toBe(String(metrics.lateCancellationsUnderReview));
    expect(leidas["Minutos de agenda liberados que siguen sin cubrir"]).toBe(String(metrics.unfilledReleasedSlotMinutes));
    // Ninguna cifra de duración: el reloj está congelado y se dice, no se disimula.
    for (const etiqueta of Object.keys(leidas)) {
      expect(/tiempo|duración|segundos|tarda/i.test(etiqueta), `la cifra '${etiqueta}' habla de tiempo`).toBe(false);
    }
  });

  it("el banner de integridad sólo aparece cuando la propia demostración detecta que ha mentido", () => {
    const { document, nodes } = documentoListaEspera();
    const hooks = loadUiClientHooks("", document);
    hooks.renderListaEspera(snapCancelada);
    expect((nodes["lista-espera-integridad"] as FakeElement).hidden).toBe(true);

    const roto = JSON.parse(JSON.stringify(snapCancelada)) as Json;
    (roto.waitlist as Json).integrity = { falseSuccesses: 1, doubleBookedSlotKeys: [], ok: false };
    hooks.renderListaEspera(roto);
    expect((nodes["lista-espera-integridad"] as FakeElement).hidden).toBe(false);
    expect((nodes["lista-espera-integridad-detalle"] as FakeElement).textContent).toContain("1");
  });

  it("el estado 'Cargando…' vive en el HTML y se apaga con la primera instantánea", () => {
    const html = renderConsoleHtml();
    const seccion = html.slice(html.indexOf('id="vista-lista-espera"'), html.indexOf('id="vista-llamadas"'));
    expect(seccion).toContain("Cargando…");
    const { document, nodes } = documentoListaEspera();
    (nodes["lista-espera-cargando"] as FakeElement).hidden = false;
    loadUiClientHooks("", document).renderListaEspera(snapCancelada);
    expect((nodes["lista-espera-cargando"] as FakeElement).hidden).toBe(true);
  });
});

// =====================================================================
// §9.5 — los cinco estados, y el conflicto que no es un error
// =====================================================================

describe("step 17 · §9.5 — conflicto y fallo se dicen distinto, y ninguno afirma que se haya escrito algo", () => {
  const { textoDeFallo } = loadUiClientHooks();

  it("el 409 de conversión dice, palabra por palabra, lo que manda el §9.4.3", () => {
    expect(textoDeFallo({ status: 409, json: { conflict: "slot_no_longer_free" } })).toBe(
      "No se ha creado la reserva: el hueco ya estaba ocupado. No se ha escrito nada. La entrada vuelve a estar pendiente.",
    );
  });

  it("todos los conflictos que el servidor puede devolver tienen frase propia, y ninguna enseña su código", () => {
    const codigos = [
      "slot_no_longer_free",
      "offer_no_longer_valid",
      "slot_already_accepted_by_another_entry",
      "entry_state_not_allowed",
      "entry_not_matched_to_this_slot",
      "slot_not_found",
      "reservation_already_cancelled",
      "cancellation_not_late",
      "already_reviewed",
      "idempotency_key_reused_with_different_body",
    ];
    for (const codigo of codigos) {
      const frase = textoDeFallo({ status: 409, json: { conflict: codigo } });
      expect(frase.includes(codigo), `la frase de ${codigo} enseña su propio código`).toBe(false);
      expect(frase.length).toBeGreaterThan(20);
      expect(/no se ha (escrito|hecho|guardado|creado)|no hay nada que revisar|ya estaba revisada|vuelve a mirar/i.test(frase)).toBe(true);
    }
  });

  it("un conflicto desconocido no se inventa un final feliz", () => {
    expect(textoDeFallo({ status: 409, json: { conflict: "algo_que_no_existe" } })).toContain("No se ha guardado nada.");
  });

  it("el fallo inyectado enseña el texto del SERVIDOR, no una traducción de la consola", () => {
    expect(
      textoDeFallo({ status: 500, json: { applied: false, code: "synthetic_injected_failure", error: "Fallo sintético inyectado. No se ha escrito nada." } }),
    ).toBe("Fallo sintético inyectado. No se ha escrito nada.");
  });

  it("la frase de caída de red está escrita una sola vez y es la del diseño", () => {
    const js = stripComments(renderConsoleAppJs());
    expect(js).toContain("var SIN_CONEXION = 'No hay conexión con el motor. No se ha guardado nada.';");
  });

  it("el CSS distingue un conflicto de un error: ámbar con borde propio, no rojo", () => {
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    const bloque = css.slice(css.indexOf(".tx-status-line--conflict"), css.indexOf(".tx-status-line--conflict") + 400);
    // (step 21A, corte 1) Mismo ámbar, mismo valor: `--tx-status-warn` es el
    // alias semántico que apunta a `--tx-amber-800`, y `--tx-status-error` el
    // que apunta a `--tx-red-700` (§2.1 del diseño). La aserción negativa
    // sigue siendo igual de fuerte: un conflicto NO puede pintarse con el
    // color de error, se le llame como se le llame.
    expect(bloque).toContain("--tx-status-warn");
    expect(bloque).toContain("border-left");
    expect(bloque).not.toContain("--tx-red-700");
    expect(bloque).not.toContain("--tx-status-error");
    expect(css).toContain("--tx-status-warn:         var(--tx-amber-800);");
  });
});

// =====================================================================
// Criterio 23 — foco y Escape en los cuatro diálogos
// =====================================================================

const DIALOGOS = {
  "dialogo-simular-aviso": [
    { id: "dialogo-simular-aviso", tag: "dialog" },
    "dialogo-simular-aviso-titulo",
    "simular-aviso-resumen",
    "simular-aviso-estado",
    "simular-aviso-confirmar",
  ],
  "dialogo-convertir": [
    { id: "dialogo-convertir", tag: "dialog" },
    "dialogo-convertir-titulo",
    "convertir-resumen",
    "convertir-inyeccion",
    "convertir-estado",
    "convertir-confirmar",
  ],
  "dialogo-cancelar-cita": [
    { id: "dialogo-cancelar-cita", tag: "dialog" },
    "dialogo-cancelar-cita-titulo",
    "cancelar-cita-paso-1",
    "cancelar-cita-paso-2",
    "cancelar-cita-error",
    "cancelar-cita-resultado",
    { id: "cancelar-cita-detalle", tag: "ul" },
    "cancelar-cita-confirmar",
    { id: "cancelar-cita-motivo", tag: "select" },
    "cancelar-cita-resumen",
    "cancelar-cita-plazo",
  ],
} as const;

describe("step 17 · criterio 23 — los diálogos llevan el foco al título y lo devuelven a su disparador", () => {
  function preparar(dialogId: keyof typeof DIALOGOS) {
    const { document, nodes } = createFakeDocumentWithIds([...DIALOGOS[dialogId], "tx-view-title", "contenedor-de-la-vista"]);
    const hooks = loadUiClientHooks("", document);
    hooks.wireFocoDialogo(dialogId);
    // El disparador tiene que estar DENTRO del documento, que es donde está en
    // la página real. Antes colgaba de un `<div>` suelto que no se enganchaba a
    // nada: el guardián preguntaba por `parentNode` —que un subárbol
    // desprendido conserva— y la prueba pasaba describiendo un botón que, para
    // el navegador, no estaba en ninguna parte. Con `isConnected` la diferencia
    // se nota, y la prueba dice ahora lo que su título promete.
    const contenedor = nodes["contenedor-de-la-vista"] as FakeElement;
    const disparador = document.createElement("button");
    contenedor.appendChild(disparador);
    return { document, nodes, hooks, disparador };
  }

  const ENTRADA = {
    id: "wl-f01",
    clientLabel: "Cliente A",
    offer: { slotKey: "slot-2026-08-04-780-3", slotLabel: "martes 4 de agosto, 13:00–13:30, con Álex (sintético)", stillValid: true, invalidReasons: [] },
  };

  it("simular aviso: se abre, el foco va al <h2>, y al cerrarse (lo que hace Escape) vuelve al botón de origen", () => {
    const { document, nodes, hooks, disparador } = preparar("dialogo-simular-aviso");
    hooks.abrirDialogoSimularAviso(ENTRADA, "martes 4 de agosto, 13:00–13:30", "simular-aviso-estado", disparador);
    expect((nodes["dialogo-simular-aviso"] as FakeElement).open).toBe(true);
    expect(document.activeElement).toBe(nodes["dialogo-simular-aviso-titulo"]);
    (nodes["dialogo-simular-aviso"] as FakeElement).close();
    expect((nodes["dialogo-simular-aviso"] as FakeElement).open).toBe(false);
    expect(document.activeElement).toBe(disparador);
  });

  it("convertir: mismo recorrido, y el resumen dice a quién y qué hueco", () => {
    const { document, nodes, hooks, disparador } = preparar("dialogo-convertir");
    hooks.abrirDialogoConvertir(ENTRADA, disparador);
    expect((nodes["dialogo-convertir"] as FakeElement).open).toBe(true);
    expect(document.activeElement).toBe(nodes["dialogo-convertir-titulo"]);
    expect((nodes["convertir-resumen"] as FakeElement).textContent).toContain("Cliente A");
    expect((nodes["convertir-resumen"] as FakeElement).textContent).toContain("13:00");
    (nodes["dialogo-convertir"] as FakeElement).close();
    expect(document.activeElement).toBe(disparador);
  });

  it("cancelar cita: mismo recorrido, y el paso 1 es el que se ve al abrir", () => {
    const { document, nodes, hooks, disparador } = preparar("dialogo-cancelar-cita");
    hooks.abrirDialogoCancelarCita(
      { id: "demo-salon-res-2", date: "2026-08-04", startMinutes: 780, serviceId: 1, employeeId: 3, status: "confirmed" },
      disparador,
    );
    expect((nodes["dialogo-cancelar-cita"] as FakeElement).open).toBe(true);
    expect(document.activeElement).toBe(nodes["dialogo-cancelar-cita-titulo"]);
    expect((nodes["cancelar-cita-paso-1"] as FakeElement).hidden).toBe(false);
    expect((nodes["cancelar-cita-paso-2"] as FakeElement).hidden).toBe(true);
    (nodes["dialogo-cancelar-cita"] as FakeElement).close();
    expect(document.activeElement).toBe(disparador);
  });

  it("el paso 2 cuenta lo que ha pasado con los textos del servidor, y una cancelación que no libera nada lo dice", async () => {
    // Escenario 17 del §10, por su lado de interfaz: el local no abre ese día,
    // así que la cancelación no libera ningún hueco y la pantalla lo dice con
    // la frase del diseño, sin anunciar un hueco que el motor no reconoce.
    const app = freshApp();
    await post(app, "/api/reset", {});
    const publicacion = await post(app, "/api/calendar/publish", {
      change: { changeKind: "venue_closure", id: "cierre-6-agosto", startDate: "2026-08-06", endDate: "2026-08-06" },
      resolutions: { "demo-salon-res-8": "keep_and_flag", "demo-salon-res-9": "keep_and_flag" },
    });
    expect(publicacion.statusCode).toBe(200);
    const respuesta = await cancel(app, "demo-salon-res-8");
    expect(respuesta.statusCode).toBe(200);
    const cuerpo = respuesta.json() as Json;
    expect(cuerpo.releasedSlots).toEqual([]);
    const snapCerrado = await snapshotOf(app);
    await app.close();

    // La consola ha sondeado y tiene ya la instantánea de después de cancelar,
    // que es de donde salen los textos del paso 2.
    const { document, nodes, hooks } = await cargarPantalla(snapCerrado, [...DIALOGOS["dialogo-cancelar-cita"]]);
    hooks.wireFocoDialogo("dialogo-cancelar-cita");
    const disparador = document.createElement("button");
    hooks.abrirDialogoCancelarCita({ id: "demo-salon-res-8", date: "2026-08-06", startMinutes: 600, serviceId: 1, employeeId: 9 }, disparador);
    hooks.mostrarResultadoCancelacion({ id: "demo-salon-res-8" }, { repetida: false, json: cuerpo });

    expect((nodes["cancelar-cita-paso-2"] as FakeElement).hidden).toBe(false);
    expect((nodes["cancelar-cita-resultado"] as FakeElement).textContent).toBe("Cita cancelada.");
    const detalle = todoElTexto(nodes["cancelar-cita-detalle"] as FakeElement);
    expect(detalle).toContain("Cancelación dentro del plazo configurado");
    expect(detalle).toContain(WAITLIST_COPY.venueClosedThatDay);
  });

  it("si el disparador ya no está en la página, el foco cae en el título de la vista, nunca en el vacío", () => {
    const { document, nodes, hooks } = preparar("dialogo-simular-aviso");
    const huerfano = document.createElement("button"); // sin padre: ya no está en el documento
    hooks.abrirDialogoSimularAviso(ENTRADA, "un hueco", "simular-aviso-estado", huerfano);
    (nodes["dialogo-simular-aviso"] as FakeElement).close();
    expect(document.activeElement).toBe(nodes["tx-view-title"]);
  });

  it("un disparador quitado JUNTO CON SU SUBÁRBOL tampoco recibe el foco, aunque conserve su padre", () => {
    // LA DIFERENCIA ENTRE `parentNode` E `isConnected`, fijada aquí.
    // Quitar un bloque entero del documento deja a sus hijos con el
    // `parentNode` intacto —el padre desprendido—, así que el guardián viejo
    // los daba por vivos, le pedía el foco a un nodo huérfano, `focus()` no
    // hacía nada y el foco se perdía. La comprobación correcta es si el nodo
    // sigue DENTRO del documento.
    const { document, nodes, hooks } = preparar("dialogo-simular-aviso");
    const bloque = document.createElement("div");
    const disparador = document.createElement("button");
    bloque.appendChild(disparador);
    (nodes["contenedor-de-la-vista"] as FakeElement).appendChild(bloque);
    expect(disparador.isConnected).toBe(true);

    hooks.abrirDialogoSimularAviso(ENTRADA, "un hueco", "simular-aviso-estado", disparador);
    // El bloque entero se va mientras el diálogo está abierto.
    (nodes["contenedor-de-la-vista"] as FakeElement).removeChild(bloque);
    expect(disparador.parentNode, "el padre desprendido sigue ahí: por eso `parentNode` engañaba").toBe(bloque);
    expect(disparador.isConnected, "pero ya no está en el documento").toBe(false);

    (nodes["dialogo-simular-aviso"] as FakeElement).close();
    expect(document.activeElement).toBe(nodes["tx-view-title"]);
  });

  it("los cuatro diálogos llevan aria-labelledby y su título con tabindex=-1, como el resto de la consola", () => {
    const html = renderConsoleHtml();
    for (const id of ["dialogo-cancelar-cita", "dialogo-alta-lista", "dialogo-simular-aviso", "dialogo-convertir"]) {
      const etiqueta = new RegExp(`<dialog[^>]*id="${id}"[^>]*aria-labelledby="${id}-titulo"`);
      expect(etiqueta.test(html), `${id} no está etiquetado por su título`).toBe(true);
      const titulo = new RegExp(`id="${id}-titulo"[^>]*tabindex="-1"`);
      expect(titulo.test(html), `el título de ${id} no es enfocable`).toBe(true);
    }
  });

  it("el diálogo de alta no habilita el botón de guardar hasta que se confirma el opt-in", () => {
    const html = renderConsoleHtml();
    expect(html).toContain("Confirmo que esta persona ha dicho expresamente que quiere estar en la lista de espera.");
    const boton = /<button[^>]*id="alta-lista-guardar"[^>]*>/.exec(html);
    expect(boton?.[0]).toContain("disabled");
    // Y el segundo botón, al mismo nivel, para quien dice que no.
    expect(html).toContain("No ha querido apuntarse");
  });
});

// =====================================================================
// step 19 · D3 — el cliente PINTA announcementLine, y no la compone
// =====================================================================

describe("step 19 · D3 — el paso 2 del diálogo de cancelar pinta announcementLine tal cual, sin juntar nombres", () => {
  it("con 1 compatible, el detalle dice la frase SINGULAR del servidor, letra por letra — nunca «Encajan Ana.»", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    const cuerpo = (await cancel(app, "demo-salon-res-5")).json() as Json;
    const snap = await snapshotOf(app);
    await app.close();

    const { document, nodes, hooks } = await cargarPantalla(snap, [...DIALOGOS["dialogo-cancelar-cita"]]);
    hooks.wireFocoDialogo("dialogo-cancelar-cita");
    const disparador = document.createElement("button");
    hooks.abrirDialogoCancelarCita({ id: "demo-salon-res-5", date: "2026-08-04", startMinutes: 750, serviceId: 1, employeeId: 9 }, disparador);
    hooks.mostrarResultadoCancelacion({ id: "demo-salon-res-5" }, { repetida: false, json: cuerpo });

    const wl = snap.waitlist as Json;
    const slot = (wl.releasedSlots as Json[]).find((s) => s.key === "slot-2026-08-04-750-9") as Json;
    const detalle = todoElTexto(nodes["cancelar-cita-detalle"] as FakeElement);
    expect(String(slot.announcementLine)).toContain(WAITLIST_COPY.oneFits);
    expect(detalle).toContain(slot.announcementLine as string);
    expect(detalle).not.toContain("Encajan");
  });

  it("con N compatibles, el detalle dice la frase PLURAL del servidor, y tampoco nombra a nadie aquí", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    const cuerpo = (await cancel(app, "demo-salon-res-2")).json() as Json;
    const snap = await snapshotOf(app);
    await app.close();

    const { document, nodes, hooks } = await cargarPantalla(snap, [...DIALOGOS["dialogo-cancelar-cita"]]);
    hooks.wireFocoDialogo("dialogo-cancelar-cita");
    const disparador = document.createElement("button");
    hooks.abrirDialogoCancelarCita({ id: "demo-salon-res-2", date: "2026-08-04", startMinutes: 780, serviceId: 1, employeeId: 3 }, disparador);
    hooks.mostrarResultadoCancelacion({ id: "demo-salon-res-2" }, { repetida: false, json: cuerpo });

    const wl = snap.waitlist as Json;
    const slots = (wl.releasedSlots as Json[]).filter((s) => s.cancellationId === (cuerpo.releasedSlots as Json[])[0]?.cancellationId);
    const detalle = todoElTexto(nodes["cancelar-cita-detalle"] as FakeElement);
    for (const slot of slots) {
      expect(String(slot.announcementLine)).toContain(WAITLIST_COPY.severalFit);
      expect(detalle).toContain(slot.announcementLine as string);
    }
    // Ni Cliente A ni Cliente B se nombran en este paso: la frase remite a
    // la pantalla de Lista de espera en vez de sugerir un orden.
    expect(detalle).not.toContain("Cliente A");
    expect(detalle).not.toContain("Cliente B");
  });

  it("la cadena 'Encajan ' no existe en ningún sitio del JavaScript servido (§2.3.3)", () => {
    const js = renderConsoleAppJs();
    expect(js).not.toContain("Encajan ");
  });
});

// =====================================================================
// step 19 · hallazgo menor de la puerta de reparación — buildTarjetaHueco
// lee la frase singular del servidor, no la compone a mano
// =====================================================================

describe("step 19 · la tarjeta del hueco (bloque 1) lee oneFits del servidor, nunca un literal fijo", () => {
  it("buildTarjetaHueco no contiene el literal fijo: la fuente sólo lee w.copy.oneFits", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("function buildTarjetaHueco");
    expect(inicio).toBeGreaterThan(-1);
    const fin = js.indexOf("\n  function ", inicio + 1);
    const cuerpo = js.slice(inicio, fin > -1 ? fin : undefined);
    expect(cuerpo).not.toContain("Una persona de la lista encaja en este hueco");
    expect(cuerpo).toContain("w.copy.oneFits");
  });

  it("con exactamente un compatible, la tarjeta del bloque 1 pinta WAITLIST_COPY.oneFits, letra por letra", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    expect((await cancel(app, "demo-salon-res-5")).statusCode).toBe(200);
    const snap = await snapshotOf(app);
    await app.close();

    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snap);
    const wl = snap.waitlist as Json;
    const slot = (wl.releasedSlots as Json[]).find((s) => s.key === "slot-2026-08-04-750-9") as Json;
    expect((slot.compatibleEntryIds as unknown[]).length).toBe(1);

    const tarjeta = (nodes["le-huecos-lista"] as FakeElement).children.find(
      (c) => (c as FakeElement).children[0]?.textContent === slot.label,
    ) as FakeElement;
    expect(tarjeta).toBeDefined();
    expect(todoElTexto(tarjeta)).toContain(WAITLIST_COPY.oneFits);
  });
});

// =====================================================================
// Criterio 24 — el sondeo no roba el foco ni cierra un diálogo
// =====================================================================

describe("step 17 · criterio 24 — el sondeo de dos segundos no roba el foco ni cierra un <dialog>", () => {
  it("con el foco en un radio de un hueco, un segundo repintado no lo mueve ni cambia el nodo", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera } = loadUiClientHooks("", document);
    renderListaEspera(snapCancelada);
    const radio = todos(nodes["le-huecos-lista"] as FakeElement, (n) => n.type === "radio")[0] as FakeElement;
    radio.focus();
    expect(document.activeElement).toBe(radio);

    renderListaEspera(snapCancelada);
    expect(document.activeElement).toBe(radio);
    expect(todos(nodes["le-huecos-lista"] as FakeElement, (n) => n.type === "radio")[0]).toBe(radio);
  });

  it("con el foco en un botón de acción de una persona, otro repintado tampoco se lo lleva", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera } = loadUiClientHooks("", document);
    renderListaEspera(snapAceptada);
    const boton = todos(nodes["le-personas-tbody"] as FakeElement, (n) => n.tagName === "BUTTON")[0] as FakeElement;
    boton.focus();
    renderListaEspera(snapAceptada);
    expect(document.activeElement).toBe(boton);
  });

  it("un sondeo COMPLETO con un <dialog> abierto no lo cierra, no le toca el contenido y no mueve el foco", async () => {
    const { document, nodes, hooks } = await cargarPantalla(snapAceptada, [...DIALOGOS["dialogo-convertir"]]);
    const dialogo = nodes["dialogo-convertir"] as FakeElement;
    const resumen = nodes["convertir-resumen"] as FakeElement;
    hooks.abrirDialogoConvertir(
      {
        id: "wl-f01",
        clientLabel: "Cliente A",
        offer: { slotKey: "slot-2026-08-04-780-3", slotLabel: "martes 4 de agosto, 13:00–13:30", stillValid: true, invalidReasons: [] },
      },
      null,
    );
    expect(dialogo.open).toBe(true);
    const textoAntes = resumen.textContent;
    (nodes["convertir-confirmar"] as FakeElement).focus();

    // Otro sondeo, con la MISMA instantánea, como haría el temporizador de 2 s.
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve(snapAceptada) })) as unknown as typeof fetch;
    try {
      await hooks.refresh();
    } finally {
      globalThis.fetch = original;
    }

    expect(dialogo.open).toBe(true);
    expect(resumen.textContent).toBe(textoAntes);
    expect(document.activeElement).toBe(nodes["convertir-confirmar"]);
  });

  it("el desplegable del plazo no se le mueve de las manos a quien lo tiene enfocado", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera } = loadUiClientHooks("", document);
    renderListaEspera(snapCancelada);
    const sel = nodes["le-plazo-select"] as FakeElement;
    sel.focus();
    sel.value = "60";
    renderListaEspera(snapCancelada);
    expect(sel.value).toBe("60");
    // En cuanto suelta el foco, la pantalla vuelve a decir la verdad del motor.
    document.activeElement = null;
    renderListaEspera(snapCancelada);
    expect(sel.value).toBe("120");
  });
});

// =====================================================================
// §9.3 — los toques en Agenda, Inicio y Laboratorio
// =====================================================================

// step 19 §3.8, punto 2: renderAgenda() también rellena el desplegable del
// explorador de huecos ('huecos-profesional'), bajo la misma guarda de
// igualdad que ya usa 'agenda-filtro-profesional'.
const AGENDA_IDS_M17 = [
  { id: "agenda-filtro-profesional", tag: "select" },
  "agenda-dias",
  "agenda-vacio",
  { id: "huecos-profesional", tag: "select" },
] as const;

describe("step 17 · §9.3 Agenda — cancelar una cita, y las citas canceladas a la vista", () => {
  function pintarAgenda(snap: Json) {
    const { document, nodes } = createFakeDocumentWithIds([...AGENDA_IDS_M17]);
    const { renderAgenda } = loadUiClientHooks("", document);
    renderAgenda(snap);
    const panel = (nodes["agenda-dias"] as FakeElement).children[0] as FakeElement;
    const tbody = (panel.children[2] as FakeElement).querySelector("tbody") as FakeElement;
    return { document, tbody };
  }

  it("cada cita confirmada gana un botón 'Cancelar cita' con su hora en el nombre accesible", () => {
    const { tbody } = pintarAgenda(snapCancelada);
    const filas = tbody.children as FakeElement[];
    expect(filas.length).toBeGreaterThan(0);
    const confirmadas = (((snapCancelada.calendar as Json).reservations as Json[]) ?? []).filter(
      (r) => r.date === snapCancelada.engineToday && r.status === "confirmed",
    );
    const botones = filas
      .map((tr) => (tr.children[4] as FakeElement).children[0] as FakeElement)
      .filter((b) => b.hidden === false);
    expect(botones.length).toBe(confirmadas.length);
    expect(botones[0].textContent).toBe("Cancelar cita");
    expect(botones[0].getAttribute("aria-label")).toMatch(/^Cancelar la cita de las \d{2}:\d{2} con /);
  });

  it("una cita cancelada se sigue viendo, con su píldora 'Cancelada' y el veredicto de plazo del servidor", () => {
    const { tbody } = pintarAgenda(snapCancelada);
    const canceladas = (tbody.children as FakeElement[]).filter((tr) => tr.className.includes("tx-table__row--cancelled"));
    expect(canceladas.length).toBeGreaterThan(0);
    const conRegistro = canceladas.find((tr) => tr.getAttribute("data-key") === "demo-salon-res-1") as FakeElement;
    const texto = todoElTexto(conRegistro);
    expect(texto).toContain("Cancelada");
    expect(texto).toContain("Cancelación fuera del plazo configurado");
    // Y su botón de cancelar no se ofrece: ya está cancelada.
    expect(((conRegistro.children[4] as FakeElement).children[0] as FakeElement).hidden).toBe(true);
  });

  it("una reserva creada desde la lista de espera lo dice en su fila", () => {
    const snap = JSON.parse(JSON.stringify(snapCancelada)) as Json;
    const reservas = (snap.calendar as Json).reservations as Json[];
    reservas[0].originatedFromWaitlistEntryId = "wl-f01";
    const { tbody } = pintarAgenda(snap);
    const fila = (tbody.children as FakeElement[]).find((tr) => tr.getAttribute("data-key") === reservas[0].id) as FakeElement;
    expect(todoElTexto(fila)).toContain("Creada desde la lista de espera");
  });
});

describe("step 17 · §9.3 Inicio — las tres tareas nuevas se ven, y ni una cifra más", () => {
  it("una tarea de lista de espera lleva a la pantalla de lista de espera, no a Horarios y ausencias", () => {
    const { enlaceDeTarea } = loadUiClientHooks();
    for (const reasonKind of ["REVIEW_LATE_CANCELLATION", "DECIDE_WAITLIST_MATCH", "REVIEW_WAITLIST_CONVERSION_CONFLICT"]) {
      expect(enlaceDeTarea({ reasonKind, callIdHash: "sin-llamada-asociada" })).toBe("#/lista-espera");
    }
    // Y las de siempre siguen yendo donde iban.
    expect(enlaceDeTarea({ reasonKind: "CALLBACK_FROM_CALL", callIdHash: "abc123" })).toBe("#/llamadas/abc123");
    expect(enlaceDeTarea({ reasonKind: "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE", callIdHash: "sin-llamada-asociada" })).toBe("#/horarios-y-ausencias");
  });

  it("las tres tareas llegan al snapshot con su etiqueta en castellano ya resuelta", () => {
    const tareas = ((snapCancelada.humanQueue as Json).tasks as Json[]).filter(
      (t) => t.reasonKind === "DECIDE_WAITLIST_MATCH" || t.reasonKind === "REVIEW_LATE_CANCELLATION",
    );
    expect(tareas.length).toBeGreaterThan(0);
    expect(tareas.map((t) => t.reasonLabel)).toContain("Decidir a quién se ofrece un hueco liberado");
    expect(tareas.map((t) => t.reasonLabel)).toContain("Revisar una cancelación fuera de plazo");
  });

  it("Inicio no gana ninguna tarjeta de cifra: sigue teniendo exactamente cuatro", () => {
    const html = renderConsoleHtml();
    const inicio = html.slice(html.indexOf('id="vista-inicio"'), html.indexOf('id="vista-agenda"'));
    expect((inicio.match(/tx-stat"/g) ?? []).length).toBe(4);
    // Y ninguna de las cifras del §11 se ha colado aquí.
    for (const etiqueta of ["Huecos liberados", "Avisos simulados", "Altas en la lista"]) {
      expect(inicio.includes(etiqueta), `'${etiqueta}' se ha colado en Inicio`).toBe(false);
    }
  });
});

describe("step 17 · §9.3 y §14.2 Laboratorio — historial propio, tabla de mapeo honesto e inyección de fallo", () => {
  it("el historial de la lista de espera se pinta aparte del de calendario, con su número y su tipo de evento", () => {
    const { document, nodes } = createFakeDocumentWithIds([
      { id: "lab-eventos-pilot", tag: "dl" },
      { id: "lab-eventos-internal", tag: "dl" },
      "lab-auditoria-vacio",
      { id: "lab-auditoria-lista", tag: "ul" },
      { id: "lab-json", tag: "pre" },
      "lab-waitlist-vacio",
      { id: "lab-waitlist-lista", tag: "ul" },
    ]);
    const { renderLaboratorio } = loadUiClientHooks("", document);
    renderLaboratorio(snapCancelada);
    const lista = nodes["lab-waitlist-lista"] as FakeElement;
    const eventos = ((snapCancelada.waitlist as Json).audit as Json).items as Json[];
    expect(lista.children.length).toBe(eventos.length);
    expect((nodes["lab-waitlist-vacio"] as FakeElement).hidden).toBe(true);
    // El más reciente arriba, y con el texto de operador que escribe el servidor.
    const ultimo = eventos[eventos.length - 1] as Json;
    expect((lista.children[0] as FakeElement).textContent).toBe(
      `${String(ultimo.seq)} · ${String(ultimo.kind)} · ${String(ultimo.text)}`,
    );
  });

  it("una instantánea sin lista de espera no rompe Laboratorio (la comprobación de siempre sigue pasando)", () => {
    const { document } = createFakeDocumentWithIds([
      { id: "lab-eventos-pilot", tag: "dl" },
      { id: "lab-eventos-internal", tag: "dl" },
      "lab-auditoria-vacio",
      { id: "lab-auditoria-lista", tag: "ul" },
      { id: "lab-json", tag: "pre" },
    ]);
    const { renderLaboratorio } = loadUiClientHooks("", document);
    expect(() =>
      renderLaboratorio({ eventCounts: { pilot: {}, internal: {} }, calendar: { auditLog: [] } }),
    ).not.toThrow();
  });

  it("la tabla de mapeo honesto del §14.2 está en Laboratorio, con sus tres filas y su verdad incómoda", () => {
    const html = renderConsoleHtml();
    const lab = html.slice(html.indexOf('id="vista-laboratorio"'));
    expect(lab).toContain("CANCEL_OR_CHANGE_NOT_ENABLED");
    expect(lab).toContain("el agente no cancela nada");
    expect(lab).toContain("La lista de espera no participa en la llamada");
    expect(lab).toContain("No existe en el contrato v1");
    expect(lab).toContain("No se simula en el motor");
  });

  it("el conmutador de fallo inyectado vive en Laboratorio y en ninguna pantalla operativa", () => {
    const html = renderConsoleHtml();
    const lab = html.slice(html.indexOf('id="vista-laboratorio"'));
    expect(lab).toContain('id="lab-inyectar-fallo-conversion"');
    const operativas = html.slice(html.indexOf('id="vista-inicio"'), html.indexOf('id="vista-laboratorio"'));
    expect(operativas.includes("inyectar-fallo")).toBe(false);
  });
});

// =====================================================================
// step 23 · rebanada C — Inicio (atención + actividad) y la superficie
// de revisión de Lista de espera.
//
// LO QUE ESTAS PRUEBAS NO FIRMAN, igual que el resto de este fichero: los
// anchos 690/768/1024/1280/1440, el zoom al 200 %, `prefers-reduced-motion`,
// el orden real de tabulación, la trampa de foco del `<dialog>` nativo y
// VoiceOver. `fakeDom.ts` no emula ni una regla de CSS. Eso lo firma el
// runbook del Mac, y así consta en el §10 del diseño.
// =====================================================================

const INICIO_IDS_M23 = [
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
  "panel-atencion",
  "contador-atencion",
  "vacio-atencion",
  "tit-atencion-propuestas",
  { id: "atencion-propuestas", tag: "ul" },
  { id: "lista-atencion", tag: "ul" },
  "contador-cola",
  "vacio-tareas",
  { id: "lista-tareas", tag: "ul" },
  "vacio-actividad",
  { id: "lista-actividad", tag: "ul" },
  "panel-actividad-operativa",
  { id: "lista-actividad-operativa", tag: "ul" },
  "vacio-actividad-operativa",
  "actividad-operativa-detalles",
  "actividad-operativa-resumen",
  { id: "lista-actividad-operativa-todo", tag: "ul" },
  "actividad-operativa-estado",
  "vacio-citas-hoy",
  { id: "lista-citas-hoy", tag: "ul" },
  "inicio-calendario-resumen",
  { id: "lista-dias-distintos", tag: "ul" },
] as const;

/** Las cuatro instantáneas del bucle humano, todas producidas por el servidor real. */
let snapPropuesta: Json;
let snapAprobada: Json;
let snapSustituida: Json;
let snapReiniciada: Json;

const HUECO_13 = "slot-2026-08-04-780-3";

beforeAll(async () => {
  const app = freshApp();
  await post(app, "/api/reset", {});
  expect((await cancel(app, "demo-salon-res-2")).statusCode).toBe(200);
  snapPropuesta = await snapshotOf(app);

  // Dos cancelaciones y una aprobación: suficiente actividad para que la
  // portada de seis se quede corta y el `<details>` tenga algo que enseñar.
  const otro = freshApp();
  await post(otro, "/api/reset", {});
  await cancel(otro, "demo-salon-res-2");
  await cancel(otro, "demo-salon-res-1", "client_cancelled_by_phone_simulated");
  expect(
    (await post(otro, "/api/waitlist/entries/wl-f01/command", { command: "approve_proposal", slotKey: HUECO_13 }))
      .statusCode,
  ).toBe(200);
  snapAprobada = await snapshotOf(otro);

  const tercero = freshApp();
  await post(tercero, "/api/reset", {});
  await cancel(tercero, "demo-salon-res-2");
  expect(
    (await post(tercero, "/api/waitlist/entries/wl-f02/command", { command: "take_over_proposal", slotKey: HUECO_13 }))
      .statusCode,
  ).toBe(200);
  snapSustituida = await snapshotOf(tercero);

  const cuarto = freshApp();
  await post(cuarto, "/api/reset", {});
  snapReiniciada = await snapshotOf(cuarto);
  for (const a of [app, otro, tercero, cuarto]) await a.close();
});

function inicio(): { document: FakeDocument; nodes: Record<string, FakeElement>; hooks: ReturnType<typeof loadUiClientHooks> } {
  const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS_M23]);
  return { document, nodes, hooks: loadUiClientHooks("", document) };
}

function claves(lista: FakeElement): string[] {
  return lista.children.map((c) => (c as FakeElement).getAttribute("data-key") ?? "");
}

describe("step 23 · §8.1 — Inicio: las propuestas pendientes, dentro del panel de atención", () => {
  it("una tarjeta por propuesta, con píldora de TEXTO, titular, detalle y enlace con destino real", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapPropuesta);

    const attention = ((snapPropuesta.waitlist as Json).attention as Json).cards as Json[];
    expect(attention.length).toBe(1);
    const lista = nodes["atencion-propuestas"] as FakeElement;
    expect(lista.hidden).toBe(false);
    expect((nodes["tit-atencion-propuestas"] as FakeElement).hidden).toBe(false);
    expect(lista.children.length).toBe(1);
    expect(claves(lista)).toEqual([HUECO_13]);

    const fila = lista.children[0] as FakeElement;
    const texto = todoElTexto(fila);
    expect(texto).toContain("Pendiente de aprobación");
    expect(texto).toContain(attention[0]?.headline as string);
    expect(texto).toContain(attention[0]?.detail as string);
    // Enlace con TEXTO real y destino real: ni campana, ni insignia muda.
    const enlace = buscar(fila, (n) => n.tagName === "A") as FakeElement;
    expect(enlace.textContent).toBe("Revisar en Lista de espera");
    expect(enlace.href).toBe("#/lista-espera");
    // Y ni un identificador crudo a la vista.
    expect(texto).not.toMatch(/wl-f\d|slot-2026|cxl-|wla-/);
  });

  it("el color nunca informa solo: toda píldora del bloque lleva su etiqueta en palabras", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapPropuesta);
    const pildoras = todos(nodes["atencion-propuestas"] as FakeElement, (n) => n.className.indexOf("tx-pill ") === 0);
    expect(pildoras.length).toBeGreaterThan(0);
    for (const p of pildoras) {
      expect(todoElTexto(p).trim().length).toBeGreaterThan(0);
      // Sin glifo decorativo que esconder: esta píldora es sólo texto.
      expect(p.children.length).toBe(1);
      expect((p.children[0] as FakeElement).className).toBe("tx-pill__label");
    }
  });

  it("el contador es la SUMA de dos sumandos disjuntos, y el vacío deja de mentir", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapPropuesta);

    const llamadas = (nodes["lista-atencion"] as FakeElement).children.length;
    const propuestas = (nodes["atencion-propuestas"] as FakeElement).children.length;
    expect(propuestas).toBe(
      ((snapPropuesta.waitlist as Json).attention as Json).pendingProposalCount as number,
    );
    expect((nodes["contador-atencion"] as FakeElement).textContent).toBe(`(${String(llamadas + propuestas)})`);
    // Antes, con cero llamadas, aquí se leía «no hay nada que necesite tu
    // atención» JUSTO AL LADO de una tarjeta que sí la necesitaba.
    expect(llamadas).toBe(0);
    expect((nodes["vacio-atencion"] as FakeElement).hidden).toBe(true);
    expect((nodes["panel-atencion"] as FakeElement).className).toContain("tx-panel--focus");
    // Y el panel hermano de tareas no se contamina: sigue contando recados.
    expect((nodes["contador-cola"] as FakeElement).textContent).toBe(
      `(${String(((snapPropuesta.metrics as Json).pendingHumanTasks as number))})`,
    );
  });

  it("sin ninguna propuesta pendiente, el bloque entero desaparece: título incluido", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapReiniciada);
    expect((nodes["atencion-propuestas"] as FakeElement).hidden).toBe(true);
    expect((nodes["tit-atencion-propuestas"] as FakeElement).hidden).toBe(true);
    expect((nodes["atencion-propuestas"] as FakeElement).children.length).toBe(0);
    expect((nodes["contador-atencion"] as FakeElement).textContent).toBe("");
    expect((nodes["vacio-atencion"] as FakeElement).hidden).toBe(false);
    expect((nodes["panel-atencion"] as FakeElement).className).not.toContain("tx-panel--focus");
  });
});

describe("step 23 · §8.2 — Inicio: el panel de actividad operativa", () => {
  it("las seis más recientes en portada, en el orden del servidor y con claves estables", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapAprobada);
    const items = ((snapAprobada.waitlist as Json).activity as Json).items as Json[];
    expect(items.length).toBeGreaterThan(6);

    const lista = nodes["lista-actividad-operativa"] as FakeElement;
    expect(lista.children.length).toBe(6);
    expect(claves(lista)).toEqual(items.slice(0, 6).map((i) => i.id as string));
    for (const k of claves(lista)) expect(k).toMatch(/^wla-\d{8}$/);
    expect(new Set(claves(lista)).size).toBe(6);
    expect((nodes["vacio-actividad-operativa"] as FakeElement).hidden).toBe(true);
  });

  it("cada fila dice de quién fue, a qué hora sintética, qué pasó y por qué — todo en texto", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapAprobada);
    const items = ((snapAprobada.waitlist as Json).activity as Json).items as Json[];
    const lista = nodes["lista-actividad-operativa"] as FakeElement;

    for (let i = 0; i < lista.children.length; i += 1) {
      const fila = lista.children[i] as FakeElement;
      const dato = items[i] as Json;
      const texto = todoElTexto(fila);
      expect(texto).toContain(dato.originLabel as string);
      expect(texto).toContain(dato.statusLabel as string);
      expect(texto).toContain(dato.timeLabel as string);
      expect(texto).toContain(dato.title as string);
      // Divulgación progresiva: la razón está, en una segunda línea de texto.
      expect(texto).toContain(dato.reason as string);
      expect(texto).not.toMatch(/wl-f\d|slot-2026|cxl-|wla-/);
      const enlace = buscar(fila, (n) => n.tagName === "A") as FakeElement;
      expect(enlace.href).toBe("#/lista-espera");
      expect(enlace.textContent.length).toBeGreaterThan(0);
    }
    // El origen es siempre uno de los dos, y nunca un nombre de persona.
    for (const item of items) expect(["Sistema", "Operador"]).toContain(item.originLabel);
  });

  it("el <details> dice cuántas enseña de cuántas hay, y no miente en ninguno de los dos números", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapAprobada);
    const actividad = (snapAprobada.waitlist as Json).activity as Json;
    expect((nodes["actividad-operativa-detalles"] as FakeElement).hidden).toBe(false);
    expect((nodes["actividad-operativa-resumen"] as FakeElement).textContent).toBe(
      `Ver toda la actividad de esta sesión (${String(actividad.shown)} de ${String(actividad.total)})`,
    );
    const todas = nodes["lista-actividad-operativa-todo"] as FakeElement;
    expect(todas.children.length).toBe(actividad.shown);
    expect(new Set(claves(todas)).size).toBe(todas.children.length);
  });

  it("dos sondeos seguidos no duplican, no reordenan y no reconstruyen: los MISMOS nodos", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapAprobada);
    const lista = nodes["lista-actividad-operativa"] as FakeElement;
    const antes = lista.children.slice();
    const clavesAntes = claves(lista);

    hooks.renderInicio(snapAprobada);
    expect(lista.children.length).toBe(antes.length);
    expect(claves(lista)).toEqual(clavesAntes);
    // Identidad de nodo, no sólo igualdad de texto: reconstruir una fila es
    // exactamente lo que le quita el foco a quien esté encima de ella.
    for (let i = 0; i < antes.length; i += 1) expect(lista.children[i]).toBe(antes[i]);
  });

  it("una fila con el foco dentro NO se borra ni se mueve cuando deja de estar en portada", () => {
    const { document, nodes, hooks } = inicio();
    hooks.renderInicio(snapPropuesta);
    const lista = nodes["lista-actividad-operativa"] as FakeElement;
    const ultima = lista.children[lista.children.length - 1] as FakeElement;
    const claveConFoco = ultima.getAttribute("data-key");
    const enlace = buscar(ultima, (n) => n.tagName === "A") as FakeElement;
    document.activeElement = enlace;

    // Llega más actividad: esa fila ya no cabe en las seis de portada.
    hooks.renderInicio(snapAprobada);
    expect(claves(lista)).toContain(claveConFoco);
    expect(lista.contains(enlace)).toBe(true);
  });

  it("tras reiniciar, el panel dice la verdad: vacío honesto y ningún resto del mundo anterior", () => {
    const { nodes, hooks } = inicio();
    hooks.renderInicio(snapAprobada);
    expect((nodes["lista-actividad-operativa"] as FakeElement).children.length).toBeGreaterThan(0);

    hooks.renderInicio(snapReiniciada);
    expect((nodes["lista-actividad-operativa"] as FakeElement).children.length).toBe(0);
    expect((nodes["vacio-actividad-operativa"] as FakeElement).hidden).toBe(false);
    expect((nodes["actividad-operativa-detalles"] as FakeElement).hidden).toBe(true);
    expect((nodes["lista-actividad-operativa-todo"] as FakeElement).children.length).toBe(0);
  });
});

describe("step 23 · §10 — el anuncio: una sola vez, y nunca el histórico", () => {
  it("la ÚNICA región viva nueva llega oculta, vacía y educada", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(
      '<p class="tx-status-line" id="actividad-operativa-estado" role="status" aria-live="polite" hidden></p>',
    );
    // Y en Lista de espera NO se añade ninguna región viva: aprobar y
    // sustituir escriben en `#le-huecos-estado`, que ya existía y ya es
    // `role="status"`. Se fija el número exacto de las que había Y que la
    // región nueva no se ha colado en esta vista.
    const vista = html.slice(html.indexOf('id="vista-lista-espera"'), html.indexOf('id="vista-laboratorio"'));
    expect((vista.match(/aria-live=/g) ?? []).length).toBe(6);
    expect(vista).not.toContain("actividad-operativa-estado");
    expect(vista).toContain('id="le-huecos-estado" role="status" aria-live="polite"');
  });

  it("el primer render FIJA sin locutar; sólo lo nuevo se anuncia; y repetir el sondeo no re-anuncia", () => {
    const { nodes, hooks } = inicio();
    const region = nodes["actividad-operativa-estado"] as FakeElement;

    // 1. Primer render tras cargar la página, con histórico ya hecho: la
    // región se queda MUDA. Un refresco no puede re-narrar lo que ya pasó.
    hooks.renderInicio(snapPropuesta);
    expect(region.textContent).toBe("");
    // El DOM falso nace con todos los nodos visibles; que la región LLEGUE
    // oculta y vacía se comprueba sobre el HTML servido, unas líneas abajo.

    // 2. Llega actividad nueva: se locuta UNA frase, con los títulos nuevos.
    hooks.renderInicio(snapAprobada);
    const anuncio = region.textContent;
    expect(anuncio.length).toBeGreaterThan(0);
    expect(region.hidden).toBe(false);
    const nuevos = ((snapAprobada.waitlist as Json).activity as Json).items as Json[];
    const maxViejo = Math.max(
      ...(((snapPropuesta.waitlist as Json).activity as Json).items as Json[]).map((i) => i.seq as number),
    );
    for (const item of nuevos.filter((i) => (i.seq as number) > maxViejo)) {
      expect(anuncio).toContain(item.title as string);
    }
    // Y NO arrastra el histórico: lo viejo no vuelve a nombrarse.
    for (const item of nuevos.filter((i) => (i.seq as number) <= maxViejo)) {
      expect(anuncio).not.toContain(item.title as string);
    }

    // 3. Dos sondeos más sin novedad: la región no se toca ni una vez. Que el
    // texto siga siendo el mismo es lo que evita que un lector de pantalla lo
    // vuelva a locutar cada dos segundos.
    hooks.renderInicio(snapAprobada);
    hooks.renderInicio(snapAprobada);
    expect(region.textContent).toBe(anuncio);

    // 4. Un reinicio hace BAJAR el máximo: se vuelve a fijar EN SILENCIO, sin
    // anunciar el vacío y sin borrar lo último que se dijo.
    hooks.renderInicio(snapReiniciada);
    expect(region.textContent).toBe(anuncio);
    // Y a partir de ahí, la primera novedad vuelve a anunciarse una sola vez.
    hooks.renderInicio(snapPropuesta);
    expect(region.textContent).not.toBe(anuncio);
  });
});

describe("step 23 · §8.3 — Lista de espera: la superficie de revisión de la propuesta", () => {
  function tarjeta(snap: Json): { nodes: Record<string, FakeElement>; card: FakeElement } {
    const { document, nodes } = documentoListaEspera();
    loadUiClientHooks("", document).renderListaEspera(snap);
    return { nodes, card: (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement };
  }

  it("el bloque de propuesta dice quién, por qué y que es una sugerencia — y ofrece aprobarla", () => {
    const { card } = tarjeta(snapPropuesta);
    const texto = todoElTexto(card);
    expect(texto).toContain("Pendiente de aprobación");
    expect(texto).toContain("Cliente A");
    expect(texto).toContain(WAITLIST_COPY.proposalReasonFifo);
    // El recordatorio de §9: sugerencia, no decisión.
    expect(texto).toContain(WAITLIST_COPY.proposalIsSuggestion);
    const aprobar = botonPorTexto(card, "Aprobar la propuesta");
    expect(aprobar.disabled).toBe(false);
  });

  it("«Simular aviso» está apagado ANTES de aprobar, y su razón se lee EN TEXTO, no en un color", () => {
    const { card } = tarjeta(snapPropuesta);
    const avisar = botonPorTexto(card, "Simular aviso a esta persona");
    expect(avisar.disabled).toBe(true);
    expect(todoElTexto(card)).toContain(
      "Primero una persona tiene que aprobar la propuesta. Hasta entonces no se avisa a nadie.",
    );
  });

  it("tras aprobar, se invierten: aprobar deja de ofrecerse y avisar se enciende sin excusas", () => {
    const { card } = tarjeta(snapAprobada);
    expect(botonPorTexto(card, "Aprobar la propuesta").disabled).toBe(true);
    const avisar = botonPorTexto(card, "Simular aviso a esta persona");
    expect(avisar.disabled).toBe(false);
    expect(todoElTexto(card)).toContain("Aprobada — pendiente de avisar");
    expect(todoElTexto(card)).not.toContain("Primero una persona tiene que aprobar");
  });

  it("la sustitución se ETIQUETA como decisión del operador, y nombra a quién desplazó", () => {
    const { card } = tarjeta(snapSustituida);
    const texto = todoElTexto(card);
    expect(texto).toContain("Aprobada — elegida por el operador");
    expect(texto).toContain("Cliente B");
    expect(texto).toContain(WAITLIST_COPY.proposalOperatorChoice);
    // Y la desplazada sigue estando, ahora como sustituta posible.
    const radios = todos(card, (n) => n.type === "radio");
    expect(radios.map((r) => r.value)).toEqual(
      ((snapSustituida.waitlist as Json).releasedSlots as Json[]).find((s) => s.key === HUECO_13)
        ?.substitutableEntryIds,
    );
    expect(radios.map((r) => r.value)).toContain("wl-f01");
  });

  it("«dejarla pendiente» NO es un botón: los únicos controles son aprobar, sustituir y avisar", () => {
    const { card } = tarjeta(snapPropuesta);
    const botones = todos(card, (n) => n.tagName === "BUTTON").map((b) => b.textContent);
    expect(botones).toEqual([
      "Aprobar la propuesta",
      "Sustituir y aprobar esta propuesta",
      "Simular aviso a esta persona",
    ]);
    expect(todoElTexto(card).toLowerCase()).not.toContain("dejar pendiente");
  });

  it("el historial contextual del hueco reusa las filas del rastro, con la misma clave estable", () => {
    const { card } = tarjeta(snapAprobada);
    const detalle = detallePorTitulo(card, "Lo que ha pasado con este hueco");
    const lista = buscar(detalle, (n) => n.tagName === "UL") as FakeElement;
    const slot = ((snapAprobada.waitlist as Json).releasedSlots as Json[]).find((s) => s.key === HUECO_13) as Json;
    expect((slot.activityItemIds as string[]).length).toBeGreaterThan(0);
    expect(claves(lista)).toEqual(slot.activityItemIds);
    for (const k of claves(lista)) expect(k).toMatch(/^wla-\d{8}$/);
    // Y sólo las de ESTE hueco: el hermano cuenta su propia historia.
    const hermano = ((snapAprobada.waitlist as Json).releasedSlots as Json[]).find((s) => s.key !== HUECO_13) as Json;
    const propias = new Set(slot.activityItemIds as string[]);
    const suyas = (hermano.activityItemIds as string[]).filter((id) => !propias.has(id));
    expect(suyas.length).toBeGreaterThan(0);
  });

  it("dos sondeos seguidos no reconstruyen la tarjeta ni pierden la elección de sustituto", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera } = loadUiClientHooks("", document);
    renderListaEspera(snapPropuesta);
    const lista = nodes["le-huecos-lista"] as FakeElement;
    const card = lista.children[0] as FakeElement;
    const radio = todos(card, (n) => n.type === "radio")[0] as FakeElement & { onchange?: () => void };
    radio.onchange?.();

    renderListaEspera(snapPropuesta);
    expect(lista.children[0]).toBe(card);
    expect(radio.checked).toBe(true);
    expect(botonPorTexto(card, "Sustituir y aprobar esta propuesta").disabled).toBe(false);
    // Ni una fila duplicada en el historial contextual tras el segundo pase.
    const detalle = detallePorTitulo(card, "Lo que ha pasado con este hueco");
    const hist = buscar(detalle, (n) => n.tagName === "UL") as FakeElement;
    expect(new Set(claves(hist)).size).toBe(hist.children.length);
  });
});

describe("step 23 · §5 — aprobar desde la pantalla: un solo hueco, y repetirlo no duplica nada", () => {
  it("el botón manda `approve_proposal` con el slotKey de SU hueco, y un segundo clic no rompe nada", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    const snap = await snapshotOf(app);

    // La pantalla ENTERA por el camino de verdad, para que el sondeo que
    // dispara el comando tenga una vista activa que repintar.
    const { nodes } = await cargarPantalla(snap);

    // El `fetch` REAL contra el servidor REAL: el cuerpo que compone la
    // pantalla es el que valida el esquema, no uno inventado por la prueba.
    const enviados: { url: string; body: Json }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      const cuerpo = init?.body === undefined ? {} : (JSON.parse(init.body) as Json);
      enviados.push({ url, body: cuerpo });
      const res = await post(app, url, cuerpo);
      return { ok: res.statusCode < 400, status: res.statusCode, json: () => Promise.resolve(res.json()) };
    }) as unknown as typeof fetch;

    try {
      const card = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
      const aprobar = botonPorTexto(card, "Aprobar la propuesta") as FakeElement & { onclick?: () => void };
      aprobar.onclick?.();
      await new Promise((r) => setTimeout(r, 0));
      aprobar.onclick?.();
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      globalThis.fetch = original;
    }

    const aprobaciones = enviados.filter((e) => e.body.command === "approve_proposal");
    expect(aprobaciones.length).toBe(2);
    // El hueco viaja SIEMPRE, y es el de esta tarjeta: nunca «la propuesta que
    // tenga esta persona».
    for (const envio of aprobaciones) {
      expect(envio.url).toBe("/api/waitlist/entries/wl-f01/command");
      expect(envio.body.slotKey).toBe(HUECO_13);
    }
    // Y el mundo quedó aprobado UNA vez: la repetición no duplicó ni el
    // estado ni el rastro.
    const despues = await snapshotOf(app);
    const kinds = ((despues.waitlist as Json).audit as { items: Json[] }).items.map((e) => e.kind);
    expect(kinds.filter((k) => k === "WAITLIST_PROPOSAL_APPROVED").length).toBe(1);
    expect(
      (((despues.waitlist as Json).releasedSlots as Json[]).find((s) => s.key === HUECO_13)?.proposal as Json).statusCode,
    ).toBe("approved");
    await app.close();
  });
});
