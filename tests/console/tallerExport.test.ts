import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { ACTA_COPY, MISION_COPY, SUMMARY_COPY, WORKSHOP_COPY } from "../../src/console/demoWorkspace.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks, type UiTestHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeDocument, FakeElement } from "./fakeDom.js";

/**
 * step 20 · D y E — la gramática de exportación del taller (diseño §4, §5 y
 * §9.4) y el mecanismo de copia con su respaldo (D20-39, I20-10).
 *
 * Los dos generadores son funciones PURAS de (vista, borrador), así que la
 * mayor parte de estas pruebas no monta ningún DOM: piden la vista servida a
 * la ruta real y componen. Cubre: determinismo byte a byte (mismo borrador ⇒
 * mismo texto, en dos órdenes de marcado distintos); el acta vacía y el acta
 * completa; J5/K1 contando por dos; el texto de cada opción VERBATIM y en
 * UNA sola línea (D20-46: nada se pliega); las prohibiciones de vocabulario
 * y la ausencia de fecha e identidad (D20-36); la regla de procedencia
 * E20-1/§9.4.8 —toda línea de estructura se descompone en constantes
 * servidas, texto del catálogo, identificadores, dígitos y puntuación, sin
 * una sola palabra escrita en el cliente— y su propiedad de prefijo (8b:
 * «> » queda RESERVADO a texto del operador, I20-9); el borrador de misión
 * (sólo lo elegido, agrupación por componentes conexas del grafo NO
 * dirigido, [BLOQUEADO] sin propuesta de trabajo, el caso D20-44 con su
 * frase obligatoria, las notas sólo en la sección 4, I20-11: ninguna
 * anotación huérfana entra); la aserción de los 280 (D20-49.3: la
 * exportación FALLA antes que recortar); y la integración con el
 * portapapeles: éxito, fallo y ausencia de API con el respaldo enfocado y
 * seleccionado, cero peticiones en los dos caminos, el reinicio que barre
 * las dos líneas y los dos respaldos sin rozar el borrador (D20-27/D20-28).
 */

const TEST_SALT = "taller-export-test-salt";

type Json = Record<string, unknown>;
type Borrador = Record<string, { opcion: string | null; nota: string }>;

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

async function workshopOf(app: FastifyInstance): Promise<Json> {
  return ((await snapshotOf(app)).demo as Json).decisionWorkshop as Json;
}

/** La vista servida y unos hooks puros (sin DOM), para las pruebas de gramática. */
async function vistaYHooks(): Promise<{ vista: Json; hooks: UiTestHooks; app: FastifyInstance }> {
  const app = freshApp();
  const vista = await workshopOf(app);
  const hooks = loadUiClientHooks();
  return { vista, hooks, app };
}

function entriesDe(vista: Json): Json[] {
  return vista.entries as Json[];
}

/** Un borrador con la opción dada marcada en TODAS las entradas del catálogo. */
function borradorCompleto(vista: Json, letra = "A"): Borrador {
  const b: Borrador = {};
  for (const e of entriesDe(vista)) b[String(e.entryId)] = { opcion: letra, nota: "" };
  return b;
}

function opcionDe(entry: Json, letra: string): string {
  const opcion = (entry.options as Json[]).find((o) => o.letter === letra);
  expect(opcion, `la entrada ${String(entry.entryId)} no tiene opción ${letra}`).toBeDefined();
  return String((opcion as Json).text);
}

// ---------------------------------------------------------------------
// La regla de procedencia (§9.4.8, E20-1): los átomos de los que puede
// estar hecha una línea de estructura. Cualquier palabra escrita en el
// cliente NO está aquí y hace fallar la descomposición.
// ---------------------------------------------------------------------

function cadenasDe(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === "string") {
    if (obj !== "") out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) cadenasDe(v, out);
    return out;
  }
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) cadenasDe(v, out);
    return out;
  }
  return out;
}

function atomosDe(vista: Json): string[] {
  const atomos: string[] = [];
  // Todas las frases fijas SERVIDAS (viajan en la instantánea): el acta, el
  // borrador de misión y la copia del panel (el rótulo de huérfanas).
  cadenasDe(vista.acta, atomos);
  cadenasDe(vista.mision, atomos);
  cadenasDe(vista.copy, atomos);
  atomos.push(String(vista.catalogVersion), String(vista.sourceDocument));
  for (const b of vista.blocks as Json[]) atomos.push(String(b.blockLabel));
  for (const e of entriesDe(vista)) {
    atomos.push(String(e.entryId));
    for (const id of e.identifiers as string[]) atomos.push(id);
    atomos.push(String(e.question), String(e.currentBehaviour));
    if (e.questionAside) atomos.push(String(e.questionAside));
    if (e.notImplementedNote) atomos.push(String(e.notImplementedNote));
    atomos.push(String((e.urgency as Json).label));
    for (const o of e.options as Json[]) atomos.push(String(o.letter), String(o.text));
    for (const dep of e.dependsOn as string[]) atomos.push(dep);
    for (const ext of e.externalDependencies as string[]) atomos.push(ext);
  }
  // La puntuación de unión y los dígitos: unir constantes, insertar texto
  // verbatim y convertir un número a cadena son las únicas operaciones que
  // E20-1 autoriza. No hay NI UNA palabra aquí.
  atomos.push("[", "]", "(", ")", ",", ":", ".", " ");
  for (let d = 0; d <= 9; d += 1) atomos.push(String(d));
  return [...new Set(atomos)];
}

/** ¿La línea se puede componer SÓLO concatenando átomos? (programación dinámica con índice por primer carácter) */
function componibleConAtomos(linea: string, atomos: string[]): boolean {
  const porPrimerCaracter = new Map<string, string[]>();
  for (const a of atomos) {
    const c = a.charAt(0);
    const lista = porPrimerCaracter.get(c) ?? [];
    lista.push(a);
    porPrimerCaracter.set(c, lista);
  }
  const alcanzable = new Array<boolean>(linea.length + 1).fill(false);
  alcanzable[0] = true;
  for (let i = 0; i < linea.length; i += 1) {
    if (!alcanzable[i]) continue;
    for (const a of porPrimerCaracter.get(linea.charAt(i)) ?? []) {
      if (linea.startsWith(a, i)) alcanzable[i + a.length] = true;
    }
  }
  return alcanzable[linea.length];
}

function afirmarProcedencia(texto: string, vista: Json): void {
  const atomos = atomosDe(vista);
  for (const linea of texto.split("\n")) {
    if (linea === "" || linea.startsWith("> ") || linea === ">") continue;
    expect(
      componibleConAtomos(linea, atomos),
      `línea sin procedencia servida (E20-1): «${linea}»`,
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------
// El arnés con DOM, sólo para las pruebas del mecanismo de copia y del
// reinicio — el mismo montaje que tallerUi.test.ts.
// ---------------------------------------------------------------------

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

/** Lo que renderLaboratorio toca SIN guarda de nulo (mismo patrón que tallerUi.test.ts). */
const LABORATORIO_MINIMOS = [
  { id: "lab-eventos-pilot", tag: "dl" },
  { id: "lab-eventos-internal", tag: "dl" },
  "lab-auditoria-vacio",
  { id: "lab-auditoria-lista", tag: "ul" },
  { id: "lab-json", tag: "pre" },
] as const;

/** Lo que renderListaEspera busca por id (para el sondeo del arranque). */
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

async function montarTaller(app: FastifyInstance, navegador?: unknown): Promise<Consola> {
  const hash = "#/laboratorio";
  const { document, nodes } = createFakeDocumentWithIds([
    ...TALLER_IDS,
    ...LABORATORIO_MINIMOS,
    ...LISTA_ESPERA_IDS,
    ...HUECOS_IDS,
    ...RESET_IDS,
  ]);
  for (let i = 0; i < 3; i += 1) nodes["tx-taller-cobertura"].appendChild(document.createElement("p"));
  const panel = document.createElement("section");
  panel.appendChild(nodes["tx-taller-borrar-todo"]);
  nodes["tx-taller-filtro-todas"].setAttribute("aria-pressed", "true");
  for (const clave of ["bloquean", "esperan", "sin-respuesta", "anotadas"]) {
    nodes[`tx-taller-filtro-${clave}`].setAttribute("aria-pressed", "false");
  }
  const win = { location: { hash }, scrollTo: () => undefined };
  const hooks = loadUiClientHooks(hash, document, win, navegador);
  hooks.wireTallerControls();
  hooks.applyRoute();
  await conFetch(fetchContraLaApp(app), () => hooks.refresh());
  return { document, nodes, win, hooks };
}

function cardOf(c: Consola, entryId: string): FakeElement {
  const card = c.nodes["tx-taller-lista"].querySelector(`[data-key="${entryId}"]`);
  expect(card, `no existe la tarjeta de ${entryId}`).not.toBeNull();
  return card as FakeElement;
}

function marcar(c: Consola, entryId: string, letra: string): void {
  const card = cardOf(c, entryId);
  const fila = card.children[3].children[2].children.find((f) => f.getAttribute("data-key") === letra);
  expect(fila, `no existe la opción ${letra} de ${entryId}`).toBeDefined();
  const radio = (fila as FakeElement).children[0];
  radio.checked = true;
  (radio.onchange as () => void)();
}

function escribirNota(c: Consola, entryId: string, texto: string): void {
  const campo = cardOf(c, entryId).children[4].children[0].children[1];
  campo.value = texto;
  (campo.oninput as () => void)();
}

// =====================================================================
// (1) Determinismo — §9.4.1
// =====================================================================

describe("step 20 · exportación — determinismo: mismos datos ⇒ mismo texto, byte a byte", () => {
  it("el mismo borrador produce el mismo acta y el mismo borrador de misión dos veces seguidas, y en dos órdenes de marcado distintos", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    // Dos objetos con el MISMO contenido y distinto orden de inserción: el
    // generador recorre el catálogo, nunca Object.keys del borrador.
    const enUnOrden: Borrador = {};
    enUnOrden["K17"] = { opcion: "B", nota: "" };
    enUnOrden["J1"] = { opcion: "C", nota: "primera nota" };
    const enOtroOrden: Borrador = {};
    enOtroOrden["J1"] = { opcion: "C", nota: "primera nota" };
    enOtroOrden["K17"] = { opcion: "B", nota: "" };

    const acta1 = hooks.componerActaDelTaller(vista, enUnOrden);
    const acta2 = hooks.componerActaDelTaller(vista, enUnOrden);
    const acta3 = hooks.componerActaDelTaller(vista, enOtroOrden);
    expect(acta1).toBe(acta2);
    expect(acta1).toBe(acta3);

    const mision1 = hooks.componerBorradorDeMisionDelTaller(vista, enUnOrden);
    const mision2 = hooks.componerBorradorDeMisionDelTaller(vista, enOtroOrden);
    expect(mision1).toBe(mision2);
    await app.close();
  });

  it("copiar no muta el borrador (I20-10): el objeto queda idéntico y una segunda composición da el mismo texto", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const borrador: Borrador = { "J5/K1": { opcion: "B", nota: "lo consulta antes de cerrarlo" } };
    const antes = JSON.stringify(borrador);
    const acta = hooks.componerActaDelTaller(vista, borrador);
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, borrador);
    expect(JSON.stringify(borrador)).toBe(antes);
    expect(hooks.componerActaDelTaller(vista, borrador)).toBe(acta);
    expect(hooks.componerBorradorDeMisionDelTaller(vista, borrador)).toBe(mision);
    await app.close();
  });
});

// =====================================================================
// (2-4) El acta vacía, el acta completa y J5/K1 — §9.4.2-4
// =====================================================================

describe("step 20 · exportación — el acta provisional (§4.2)", () => {
  it("(§9.4.2) el acta vacía dice «No se anotó ninguna respuesta.», lista los 33 identificadores pendientes y su primera línea es el título servido", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const acta = hooks.componerActaDelTaller(vista, {});
    const lineas = acta.split("\n");
    expect(lineas[0]).toBe(ACTA_COPY.title);
    expect(lineas[1]).toBe(ACTA_COPY.subtitle);
    expect(lineas[3]).toBe(ACTA_COPY.permanentLine);
    expect(acta).toContain(ACTA_COPY.noneAnnotated);
    expect(acta).toContain(`${ACTA_COPY.pendingPrefix}32${ACTA_COPY.pendingSuffix}${ACTA_COPY.pendingLTail}`);
    // La lista explícita: los 32 J/K más L1, en orden de catálogo.
    const todos: string[] = [];
    for (const e of entriesDe(vista)) for (const id of e.identifiers as string[]) todos.push(id);
    expect(lineas).toContain(todos.join(", "));
    expect(todos).toHaveLength(33);
    // Y las cuatro secciones serven tal cual, una vez cada una.
    for (const seccion of [ACTA_COPY.sectionAnnotated, ACTA_COPY.sectionBlockingPending, ACTA_COPY.sectionAllPending, ACTA_COPY.sectionClosing]) {
      expect(lineas.filter((l) => l === seccion)).toHaveLength(1);
    }
    // La instrucción de repaso con Bruno y la declaración de nada
    // implementado/aprobado cierran el texto.
    for (const l of ACTA_COPY.closingLines) expect(lineas).toContain(l);
    await app.close();
  });

  it("(§9.4.3) el acta completa: 32 respuestas ⇒ ninguna bloqueante sin anotar y cero pendientes, sin lista de identificadores", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const acta = hooks.componerActaDelTaller(vista, borradorCompleto(vista));
    expect(acta).toContain(ACTA_COPY.blockingNonePending);
    expect(acta).toContain(`${ACTA_COPY.pendingPrefix}0${ACTA_COPY.pendingSuffix}${ACTA_COPY.pendingTail}`);
    expect(acta).not.toContain(ACTA_COPY.pendingLTail);
    expect(acta).not.toContain(ACTA_COPY.noneAnnotated);
    await app.close();
  });

  it("(§9.4.4) J5/K1 lleva sus dos identificadores («identificadores: J5, K1») y cuenta por DOS en el recuento de pendientes", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const vacia = hooks.componerActaDelTaller(vista, {});
    // Sin respuesta, la entrada combinada sale en la sección 2 (es bloqueante)
    // con sus dos identificadores explícitos.
    expect(vacia).toContain(`[J5/K1]  ${ACTA_COPY.identifiersPrefix}J5, K1${ACTA_COPY.identifiersSuffix}`);
    // Responderla mueve el recuento de 32 a 30: dos identificadores de golpe.
    const conRespuesta = hooks.componerActaDelTaller(vista, { "J5/K1": { opcion: "A", nota: "" } });
    expect(conRespuesta).toContain(`${ACTA_COPY.pendingPrefix}30${ACTA_COPY.pendingSuffix}`);
    await app.close();
  });

  it("(§9.4.5/§9.4.9) el texto de cada opción anotada es VERBATIM, entero y en UNA sola línea; el comportamiento de hoy no aparece nunca", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const acta = hooks.componerActaDelTaller(vista, borradorCompleto(vista));
    const lineas = acta.split("\n");
    for (const e of entriesDe(vista)) {
      const texto = opcionDe(e, "A");
      const linea = `${ACTA_COPY.optionPrefix}(A) ${texto}`;
      expect(lineas, `la opción de ${String(e.entryId)} no está entera en una línea`).toContain(linea);
      // D20-37.3: el comportamiento de hoy no es una respuesta y no se cita.
      expect(acta).not.toContain(String(e.currentBehaviour));
    }
    // D20-46: ninguna línea es un PREFIJO PROPIO de un dato del catálogo — un
    // dato plegado dejaría su primera mitad como línea suelta.
    const datos = entriesDe(vista).flatMap((e) => [String(e.question), ...(e.options as Json[]).map((o) => String(o.text))]);
    for (const linea of lineas) {
      if (linea.length < 20) continue;
      for (const dato of datos) {
        expect(dato !== linea && dato.startsWith(linea), `línea plegada de un dato del catálogo: «${linea}»`).toBe(false);
      }
    }
    await app.close();
  });

  it("(§9.4.6) prohibiciones de vocabulario: «aprobado», «decidido», «acordado» y «listo» sólo aparecen negados (ventana de 40 caracteres)", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    for (const borrador of [{}, borradorCompleto(vista)]) {
      const acta = hooks.componerActaDelTaller(vista, borrador).toLowerCase();
      for (const palabra of ["aprobado", "aprobada", "decidido", "decidida", "acordado", "acordada", "listo"]) {
        let desde = 0;
        for (;;) {
          const idx = acta.indexOf(palabra, desde);
          if (idx === -1) break;
          const ventana = acta.slice(Math.max(0, idx - 40), idx);
          const negada = ["no ", "ni ", "ninguna ", "ningún ", "nada ", "sin ", "nunca "].some((m) => ventana.includes(m));
          expect(negada, `«${palabra}» sin negar en: «…${ventana}${palabra}…»`).toBe(true);
          desde = idx + palabra.length;
        }
      }
    }
    await app.close();
  });

  it("(§9.4.7) sin fecha y sin identidad (D20-36): ningún patrón de fecha ni de hora en el acta", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    for (const borrador of [{}, borradorCompleto(vista)]) {
      const acta = hooks.componerActaDelTaller(vista, borrador);
      expect(acta).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(acta).not.toMatch(/\d{1,2}:\d{2}/);
      expect(acta).toContain(ACTA_COPY.noStampNote);
    }
    await app.close();
  });

  it("las bloqueantes sin responder salen con su pregunta, y desaparecen cuando se responden todas", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const bloqueantes = entriesDe(vista).filter((e) => (e.urgency as Json).kind === "bloquea");
    expect(bloqueantes).toHaveLength(6);
    const vacia = hooks.componerActaDelTaller(vista, {});
    for (const e of bloqueantes) {
      const pregunta = `${ACTA_COPY.questionPrefix}${String(e.question)}${e.questionAside ? ` ${String(e.questionAside)}` : ""}`;
      expect(vacia.split("\n")).toContain(pregunta);
    }
    const soloBloqueantes: Borrador = {};
    for (const e of bloqueantes) soloBloqueantes[String(e.entryId)] = { opcion: "A", nota: "" };
    const acta = hooks.componerActaDelTaller(vista, soloBloqueantes);
    expect(acta).toContain(ACTA_COPY.blockingNonePending);
    await app.close();
  });
});

// =====================================================================
// (8/8b) Procedencia E20-1 y el prefijo reservado — §9.4.8, I20-9
// =====================================================================

describe("step 20 · exportación — procedencia (E20-1): toda línea de estructura existe en lo servido", () => {
  it("(§9.4.8) acta vacía, acta completa y borrador de misión: cada línea que no empieza por «> » se descompone en constantes servidas, texto del catálogo, identificadores, dígitos y puntuación", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const rico: Borrador = {
      "J5/K1": { opcion: "B", nota: "lo consulta con su hermana antes de cerrarlo" },
      K3: { opcion: "A", nota: "" },
      K5: { opcion: "A", nota: "línea uno\nlínea dos" },
      J8: { opcion: "C", nota: "" },
    };
    afirmarProcedencia(hooks.componerActaDelTaller(vista, {}), vista);
    afirmarProcedencia(hooks.componerActaDelTaller(vista, borradorCompleto(vista)), vista);
    afirmarProcedencia(hooks.componerActaDelTaller(vista, rico), vista);
    afirmarProcedencia(hooks.componerBorradorDeMisionDelTaller(vista, {}), vista);
    afirmarProcedencia(hooks.componerBorradorDeMisionDelTaller(vista, rico), vista);
    await app.close();
  });

  it("(§9.4.8b, I20-9) el prefijo «> » queda RESERVADO: las líneas de nota lo llevan todas (startsWith literal, sin recorte) y ninguna línea de estructura lo lleva", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const nota = "primera línea\nsegunda línea\n\ntercera tras hueco";
    const borrador: Borrador = { K3: { opcion: "A", nota } };
    const esperadas = hooks.sanearNotaDelTaller(nota);
    expect(esperadas).toEqual(["> primera línea", "> segunda línea", ">", "> tercera tras hueco"]);
    for (const texto of [hooks.componerActaDelTaller(vista, borrador), hooks.componerBorradorDeMisionDelTaller(vista, borrador)]) {
      const lineas = texto.split("\n");
      const citadas = lineas.filter((l) => l.startsWith("> ") || l === ">");
      expect(citadas).toEqual(esperadas);
      // Ninguna constante servida empieza por «> »: el barrido es literal.
      for (const l of lineas) {
        if (!citadas.includes(l)) expect(l.startsWith("> ")).toBe(false);
      }
    }
    await app.close();
  });
});

// =====================================================================
// (10) El borrador de misión — §9.4.10, §5, D20-42/43/44, I20-11
// =====================================================================

describe("step 20 · exportación — el borrador de misión no ejecutable (§5)", () => {
  it("empieza con «BORRADOR NO EJECUTABLE — REVISIÓN HUMANA OBLIGATORIA» y con el borrador vacío no propone ningún trabajo", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, {});
    const lineas = mision.split("\n");
    expect(lineas[0]).toBe("BORRADOR NO EJECUTABLE — REVISIÓN HUMANA OBLIGATORIA");
    expect(lineas[0]).toBe(MISION_COPY.title);
    expect(mision).toContain(MISION_COPY.noneChosen);
    for (const l of MISION_COPY.limitLines) expect(lineas).toContain(l);
    // Con nada elegido, ninguna opción del catálogo puede aparecer.
    for (const e of entriesDe(vista)) {
      for (const o of e.options as Json[]) expect(mision).not.toContain(String(o.text));
    }
    await app.close();
  });

  it("sólo lo elegido explícitamente: elegir K17 mete a K17 (con su identificador y su opción exacta) y a nadie más en la sección 1", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, { K17: { opcion: "A", nota: "" } });
    expect(mision).toContain(`[K17]  ${ACTA_COPY.identifiersPrefix}K17${ACTA_COPY.identifiersSuffix}`);
    const k17 = entriesDe(vista).find((e) => e.entryId === "K17") as Json;
    expect(mision).toContain(`${ACTA_COPY.optionPrefix}(A) ${opcionDe(k17, "A")}`);
    for (const e of entriesDe(vista)) {
      if (e.entryId === "K17") continue;
      expect(mision).not.toContain(`[${String(e.entryId)}]`);
    }
    await app.close();
  });

  it("(D20-42) la agrupación es por componentes CONEXAS del grafo no dirigido restringido a lo elegido, ordenadas por el índice mínimo en el catálogo", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    // La componente entera de la consecuencia (CFC 1 del diseño) más K3, que
    // J5/K1 arrastra por dependencia: con TODO elegido no queda nada sin
    // responder dentro del grupo, así que hay trabajo propuesto.
    const ids = ["J5/K1", "K3", "K6", "K17", "K5", "K2", "J9"];
    const borrador: Borrador = {};
    for (const id of ids) borrador[id] = { opcion: "A", nota: "" };
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, borrador);
    const lineas = mision.split("\n");
    // Un solo grupo, con los miembros en orden de catálogo.
    const indice = new Map(entriesDe(vista).map((e, i) => [String(e.entryId), i]));
    const esperado = [...ids].sort((a, b) => (indice.get(a) as number) - (indice.get(b) as number)).join(", ");
    expect(lineas).toContain(`${MISION_COPY.groupPrefix}1${MISION_COPY.groupJoiner}${esperado}`);
    expect(mision).not.toContain(MISION_COPY.groupPrefix + "2");
    expect(mision).not.toContain(MISION_COPY.blockedTag);
    expect(lineas).toContain(MISION_COPY.togetherNote);
    // Cada miembro con su opción exacta, en su línea.
    for (const id of ids) {
      const e = entriesDe(vista).find((x) => x.entryId === id) as Json;
      expect(lineas).toContain(`${id}: (A) ${opcionDe(e, "A")}`);
    }
    await app.close();
  });

  it("(D20-43) una opción elegida cuya dependencia sigue sin respuesta ⇒ [BLOQUEADO], con la dependencia NOMBRADA y sin una sola línea de trabajo", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    // K5 depende de J5/K1, que se deja sin responder.
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, { K5: { opcion: "A", nota: "" } });
    const lineas = mision.split("\n");
    expect(lineas).toContain(`${MISION_COPY.groupPrefix}1${MISION_COPY.groupJoiner}K5  ${MISION_COPY.blockedTag}`);
    expect(lineas).toContain(`${MISION_COPY.blockedIntro}${MISION_COPY.depPart1}K5${MISION_COPY.depPart2}J5/K1${MISION_COPY.depPart3}`);
    expect(lineas).toContain(`${MISION_COPY.contraPart1}K5${MISION_COPY.contraPart2}J5/K1${MISION_COPY.contraPart3}`);
    // Sin propuesta de trabajo: la opción de K5 sale en la sección 1 (lo
    // elegido) pero NO en la sección 3 (trabajo agrupado).
    const k5 = entriesDe(vista).find((e) => e.entryId === "K5") as Json;
    const texto = opcionDe(k5, "A");
    const idxSeccion3 = mision.indexOf(MISION_COPY.sectionGrouped);
    const seccion3 = mision.slice(idxSeccion3, mision.indexOf(MISION_COPY.sectionContext));
    expect(seccion3).not.toContain(texto);
    expect(mision.slice(0, idxSeccion3)).toContain(texto);
    await app.close();
  });

  it("(D20-44) con TODAS las bloqueantes sin responder, la sección 3 abre con la frase obligatoria y aun así resume los refinamientos no bloqueantes elegidos", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    // K3 no bloquea y no depende de nadie: es el refinamiento legítimo.
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, { K3: { opcion: "A", nota: "" } });
    const lineas = mision.split("\n");
    const idxSeccion = lineas.indexOf(MISION_COPY.sectionGrouped);
    expect(idxSeccion).toBeGreaterThan(-1);
    // Inmediatamente bajo el encabezado, con su propia línea (D20-44).
    expect(lineas[idxSeccion + 2]).toBe(MISION_COPY.noBlockingChosenNote);
    const k3 = entriesDe(vista).find((e) => e.entryId === "K3") as Json;
    expect(lineas).toContain(`K3: (A) ${opcionDe(k3, "A")}`);
    // Y las siete bloqueantes siguen listadas en la sección 2, con su pregunta.
    for (const e of entriesDe(vista).filter((x) => (x.urgency as Json).kind === "bloquea")) {
      expect(lineas).toContain(`${String(e.entryId)}${MISION_COPY.groupJoiner}${String(e.question)}${e.questionAside ? ` ${String(e.questionAside)}` : ""}`);
    }
    await app.close();
  });

  it("las notas van SÓLO en la sección 4, citadas con «> » y bajo el rótulo de texto sin verificar; nunca producen una línea de alcance", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const nota = "esto lo consulta con su hermana antes de cerrarlo";
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, { J8: { opcion: null, nota } });
    // Aparece UNA vez, citada, después del encabezado de contexto.
    const primera = mision.indexOf(`> ${nota}`);
    expect(primera).toBeGreaterThan(mision.indexOf(MISION_COPY.sectionContext));
    expect(mision.indexOf(nota)).toBe(primera + 2);
    expect(mision.indexOf(nota, primera + 2 + nota.length)).toBe(-1);
    expect(mision).toContain(MISION_COPY.contextIntro);
    // Una nota SIN opción no elige nada: la sección 1 sigue vacía.
    expect(mision).toContain(MISION_COPY.noneChosen);
    await app.close();
  });

  it("(I20-11) una anotación huérfana (entryId fuera del catálogo) sale en el ACTA bajo su rótulo, pero JAMÁS en el borrador de misión", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const borrador: Borrador = { "Z9/INVENTADA": { opcion: "A", nota: "resto de otra versión" } };
    const acta = hooks.componerActaDelTaller(vista, borrador);
    expect(acta).toContain(WORKSHOP_COPY.orphanHeading);
    expect(acta).toContain("[Z9/INVENTADA]");
    expect(acta).toContain("> resto de otra versión");
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, borrador);
    expect(mision).not.toContain("Z9/INVENTADA");
    expect(mision).not.toContain("resto de otra versión");
    await app.close();
  });
});

// =====================================================================
// (D20-49.3) La aserción de los 280: la exportación falla antes que recortar
// =====================================================================

describe("step 20 · exportación — el tope de 280 se defiende en la exportación (D20-49, punto 3)", () => {
  it("una nota de 281 caracteres inyectada por código hace FALLAR la exportación — en los dos generadores — y una de 280 sale entera", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const de281: Borrador = { K3: { opcion: "A", nota: "x".repeat(281) } };
    expect(() => hooks.componerActaDelTaller(vista, de281)).toThrowError(/280/);
    expect(() => hooks.componerBorradorDeMisionDelTaller(vista, de281)).toThrowError(/280/);
    const de280: Borrador = { K3: { opcion: "A", nota: "y".repeat(280) } };
    expect(hooks.componerActaDelTaller(vista, de280)).toContain(`> ${"y".repeat(280)}`);
    await app.close();
  });
});

// =====================================================================
// El mecanismo de copia: éxito, respaldo y reinicio — §4.4, D20-39, D20-28
// =====================================================================

describe("step 20 · copia — éxito, respaldo y cero peticiones (D20-39, I20-10)", () => {
  it("camino de ÉXITO: el texto compuesto llega ENTERO al portapapeles, la línea de estado dice lo servido y el respaldo queda oculto — sin ninguna petición", async () => {
    const app = freshApp();
    const escrituras: string[] = [];
    const navegador = {
      clipboard: { writeText: (t: string) => { escrituras.push(t); return Promise.resolve(); } },
    };
    const c = await montarTaller(app, navegador);
    marcar(c, "K17", "B");
    escribirNota(c, "J8", "nota de la reunión");

    const registro: string[] = [];
    await conFetch(fetchContraLaApp(app, registro), async () => {
      c.nodes["tx-taller-copiar-acta"].dispatchClick();
      c.nodes["tx-taller-copiar-mision"].dispatchClick();
      await dormir(0);
    });
    expect(registro).toHaveLength(0);
    expect(escrituras).toHaveLength(2);

    // El texto copiado es byte a byte el que componen las funciones puras
    // con la MISMA vista servida y el MISMO borrador.
    const vista = await workshopOf(app);
    const borrador: Borrador = { K17: { opcion: "B", nota: "" }, J8: { opcion: null, nota: "nota de la reunión" } };
    expect(escrituras[0]).toBe(c.hooks.componerActaDelTaller(vista, borrador));
    expect(escrituras[1]).toBe(c.hooks.componerBorradorDeMisionDelTaller(vista, borrador));

    expect(c.nodes["tx-taller-acta-estado"].textContent).toBe(ACTA_COPY.copiedStatus);
    expect(c.nodes["tx-taller-mision-estado"].textContent).toBe(MISION_COPY.copiedStatus);
    expect(c.nodes["tx-taller-acta-respaldo"].hidden).toBe(true);
    expect(c.nodes["tx-taller-acta-respaldo"].value).toBe("");

    // I20-10: el borrador sigue como estaba y una segunda copia da lo mismo.
    c.nodes["tx-taller-copiar-acta"].dispatchClick();
    await dormir(0);
    expect(escrituras[2]).toBe(escrituras[0]);
    await app.close();
  });

  it("SIN API de portapapeles: el respaldo aparece, con el texto entero, enfocado y con la frase EXACTA del resumen (R4-19: SUMMARY_COPY.fallbackStatus)", async () => {
    const app = freshApp();
    const c = await montarTaller(app); // navigator {} — no hay clipboard
    marcar(c, "K3", "A");
    const registro: string[] = [];
    await conFetch(fetchContraLaApp(app, registro), async () => {
      c.nodes["tx-taller-copiar-acta"].dispatchClick();
      await dormir(0);
    });
    expect(registro).toHaveLength(0);
    const respaldo = c.nodes["tx-taller-acta-respaldo"];
    expect(respaldo.hidden).toBe(false);
    const vista = await workshopOf(app);
    expect(respaldo.value).toBe(c.hooks.componerActaDelTaller(vista, { K3: { opcion: "A", nota: "" } }));
    expect(c.document.activeElement).toBe(respaldo);
    expect(c.nodes["tx-taller-acta-estado"].textContent).toBe(SUMMARY_COPY.fallbackStatus);
    await app.close();
  });

  it("con el portapapeles RECHAZANDO la escritura, cada acción cae a SU respaldo con SU texto", async () => {
    const app = freshApp();
    const navegador = { clipboard: { writeText: () => Promise.reject(new Error("denegado")) } };
    const c = await montarTaller(app, navegador);
    c.nodes["tx-taller-copiar-acta"].dispatchClick();
    c.nodes["tx-taller-copiar-mision"].dispatchClick();
    await dormir(0);
    const actaRespaldo = c.nodes["tx-taller-acta-respaldo"];
    const misionRespaldo = c.nodes["tx-taller-mision-respaldo"];
    expect(actaRespaldo.hidden).toBe(false);
    expect(misionRespaldo.hidden).toBe(false);
    expect(actaRespaldo.value.startsWith(ACTA_COPY.title)).toBe(true);
    expect(misionRespaldo.value.startsWith(MISION_COPY.title)).toBe(true);
    expect(actaRespaldo.value).not.toBe(misionRespaldo.value);
    expect(c.nodes["tx-taller-mision-estado"].textContent).toBe(SUMMARY_COPY.fallbackStatus);
    await app.close();
  });

  it("(D20-28/§6.4) el reinicio barre las DOS líneas de copiado y vacía y oculta los DOS respaldos — y el borrador queda intacto (D20-27)", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    marcar(c, "K17", "B");
    escribirNota(c, "K17", "sobrevive al reinicio");
    // El camino del respaldo deja los dos campos llenos y las dos líneas escritas.
    c.nodes["tx-taller-copiar-acta"].dispatchClick();
    c.nodes["tx-taller-copiar-mision"].dispatchClick();
    await dormir(0);
    expect(c.nodes["tx-taller-acta-respaldo"].hidden).toBe(false);
    expect(c.nodes["tx-taller-mision-respaldo"].hidden).toBe(false);

    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());

    for (const id of ["tx-taller-acta-estado", "tx-taller-mision-estado"]) {
      expect(c.nodes[id].textContent).toBe("");
      expect(c.nodes[id].hidden).toBe(true);
    }
    for (const id of ["tx-taller-acta-respaldo", "tx-taller-mision-respaldo"]) {
      expect(c.nodes[id].value).toBe("");
      expect(c.nodes[id].hidden).toBe(true);
    }
    // El borrador NO se toca: la marca y la nota siguen, y el acta lo demuestra.
    const card = cardOf(c, "K17");
    const filaB = card.children[3].children[2].children.find((f) => f.getAttribute("data-key") === "B") as FakeElement;
    expect(filaB.children[0].checked).toBe(true);
    expect(card.children[4].children[0].children[1].value).toBe("sobrevive al reinicio");
    const vista = await workshopOf(app);
    expect(c.hooks.componerActaDelTaller(vista, { K17: { opcion: "B", nota: "sobrevive al reinicio" } })).toContain("> sobrevive al reinicio");
    await app.close();
  });

  it("limpiarRespaldosDelTaller() en aislamiento: vacía y oculta los dos campos y no toca las líneas de estado ni el borrador", async () => {
    const app = freshApp();
    const c = await montarTaller(app);
    c.nodes["tx-taller-acta-respaldo"].value = "resto";
    c.nodes["tx-taller-acta-respaldo"].hidden = false;
    c.nodes["tx-taller-mision-respaldo"].value = "resto";
    c.nodes["tx-taller-mision-respaldo"].hidden = false;
    c.hooks.limpiarRespaldosDelTaller();
    for (const id of ["tx-taller-acta-respaldo", "tx-taller-mision-respaldo"]) {
      expect(c.nodes[id].value).toBe("");
      expect(c.nodes[id].hidden).toBe(true);
    }
    await app.close();
  });
});

// =====================================================================
// Revisión adversarial 2026-08-06 (A9) — regresiones de las reparaciones
// =====================================================================

describe("step 20 · revisión adversarial (A9) — el acta no pierde testimonio y ningún encabezado queda desnudo", () => {
  it("(A9-1) una nota SIN opción marcada sale en el acta bajo su sección servida, citada — y la entrada sigue entre las pendientes, sin contar como respuesta", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const nota = "lo consulta con su hermana antes de cerrarlo";
    const borrador: Borrador = { J8: { opcion: null, nota } };
    const acta = hooks.componerActaDelTaller(vista, borrador);
    const lineas = acta.split("\n");
    // La sección servida existe UNA vez, con la línea de identificadores y la nota citada debajo.
    expect(lineas.filter((l) => l === ACTA_COPY.notesWithoutAnswerHeading)).toHaveLength(1);
    const idx = lineas.indexOf(ACTA_COPY.notesWithoutAnswerHeading);
    const j8 = entriesDe(vista).find((e) => e.entryId === "J8") as Json;
    expect(lineas[idx - 1]).toBe(ACTA_COPY.separator);
    expect(lineas[idx + 2]).toBe(`[J8]  ${ACTA_COPY.identifiersPrefix}${(j8.identifiers as string[]).join(", ")}${ACTA_COPY.identifiersSuffix}`);
    expect(lineas[idx + 3]).toBe(`> ${nota}`);
    // NO cuenta como respuesta en ningún denominador: la sección 1 sigue
    // vacía y los 33 identificadores siguen pendientes, J8 incluido.
    expect(acta).toContain(ACTA_COPY.noneAnnotated);
    expect(acta).toContain(`${ACTA_COPY.pendingPrefix}32${ACTA_COPY.pendingSuffix}${ACTA_COPY.pendingLTail}`);
    // La regla de procedencia (E20-1) y el determinismo sobreviven a la sección nueva.
    afirmarProcedencia(acta, vista);
    expect(hooks.componerActaDelTaller(vista, borrador)).toBe(acta);
    // Y sin ninguna nota-sin-opción, la sección no existe: el acta vacía no cambia.
    expect(hooks.componerActaDelTaller(vista, {})).not.toContain(ACTA_COPY.notesWithoutAnswerHeading);
    await app.close();
  });

  it("(A9-1) coherencia panel/acta: todo borrador que el panel cuenta en «Con borrador anotado» aparece en el acta — con opción, sólo con nota, o huérfano", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const borrador: Borrador = {
      K17: { opcion: "B", nota: "" },
      J8: { opcion: null, nota: "sólo una nota, sin opción" },
      "Z9/INVENTADA": { opcion: null, nota: "resto de otra versión" },
    };
    const acta = hooks.componerActaDelTaller(vista, borrador);
    // El mismo criterio que el filtro del panel (borradorConAlgo): ninguna
    // clave con algo anotado puede faltar del acta.
    for (const clave of Object.keys(borrador)) {
      expect(acta, `el acta pierde el borrador de ${clave}`).toContain(`[${clave}]`);
    }
    await app.close();
  });

  it("(A9-2, D20-44) con CERO opciones elegidas, la sección 3 lleva la frase obligatoria inmediatamente bajo su encabezado, y no propone nada", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, {});
    const lineas = mision.split("\n");
    const idx = lineas.indexOf(MISION_COPY.sectionGrouped);
    expect(idx).toBeGreaterThan(-1);
    expect(lineas[idx + 1]).toBe("");
    expect(lineas[idx + 2]).toBe(MISION_COPY.noBlockingChosenNote);
    // Después de la frase no viene ningún grupo: la línea siguiente ya es el separador.
    expect(lineas[idx + 3]).toBe(ACTA_COPY.separator);
    expect(mision).not.toContain(MISION_COPY.groupPrefix + "1");
    await app.close();
  });

  it("(A9-6) con el borrador vacío NINGUNA sección del borrador de misión queda como encabezado desnudo, y la sección 4 dice su frase servida", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const mision = hooks.componerBorradorDeMisionDelTaller(vista, {});
    const lineas = mision.split("\n");
    expect(lineas).toContain(MISION_COPY.noContextNote);
    const encabezados = [
      MISION_COPY.sectionZero,
      MISION_COPY.sectionChosen,
      MISION_COPY.sectionBlockingUnchosen,
      MISION_COPY.sectionGrouped,
      MISION_COPY.sectionContext,
      MISION_COPY.sectionLimits,
    ];
    for (const encabezado of encabezados) {
      const idx = lineas.indexOf(encabezado);
      expect(idx, `falta el encabezado «${encabezado}»`).toBeGreaterThan(-1);
      // El cuerpo (hasta el siguiente separador o el final) tiene al menos una línea con texto.
      const cuerpo: string[] = [];
      for (let i = idx + 1; i < lineas.length && lineas[i] !== ACTA_COPY.separator; i += 1) cuerpo.push(lineas[i]);
      expect(cuerpo.some((l) => l !== ""), `sección desnuda: «${encabezado}»`).toBe(true);
    }
    // Con una nota, la frase de vacío desaparece y no convive con el testimonio.
    const conNota = hooks.componerBorradorDeMisionDelTaller(vista, { J8: { opcion: null, nota: "una nota" } });
    expect(conNota).not.toContain(MISION_COPY.noContextNote);
    // La regla de procedencia (E20-1) sobrevive a las frases nuevas.
    afirmarProcedencia(mision, vista);
    await app.close();
  });

  it("(A9-5) una nota de 281 caracteres inyectada por código: el click enseña la línea de estado servida con tono de error, y ni el portapapeles ni el respaldo se disparan", async () => {
    const app = freshApp();
    const escrituras: string[] = [];
    const navegador = {
      clipboard: { writeText: (t: string) => { escrituras.push(t); return Promise.resolve(); } },
    };
    const c = await montarTaller(app, navegador);
    // Los dos respaldos nacen con `hidden` en el HTML servido; el arnés no
    // lee atributos del HTML real, así que se repone aquí el estado inicial.
    c.nodes["tx-taller-acta-respaldo"].hidden = true;
    c.nodes["tx-taller-mision-respaldo"].hidden = true;
    // El oninput real recorta a 280 (D20-49.2): la única vía hacia la
    // aserción de exportación es una escritura programática directa.
    c.hooks.tallerBorrador.K3 = { opcion: "A", nota: "x".repeat(281) };
    c.nodes["tx-taller-copiar-acta"].dispatchClick();
    c.nodes["tx-taller-copiar-mision"].dispatchClick();
    await dormir(0);
    // Ni portapapeles ni respaldo: la exportación falló ANTES de componer nada.
    expect(escrituras).toHaveLength(0);
    for (const id of ["tx-taller-acta-respaldo", "tx-taller-mision-respaldo"]) {
      expect(c.nodes[id].hidden).toBe(true);
      expect(c.nodes[id].value).toBe("");
    }
    // El operador ve la frase servida, con el tono de error de la casa.
    for (const id of ["tx-taller-acta-estado", "tx-taller-mision-estado"]) {
      expect(c.nodes[id].textContent).toBe(WORKSHOP_COPY.composeFailedStatus);
      expect(c.nodes[id].hidden).toBe(false);
      expect(c.nodes[id].classList.contains("tx-status-line--error")).toBe(true);
    }
    // Y el borrador no se toca: la nota larga sigue entera (nada recorta a escondidas).
    expect(c.hooks.tallerBorrador.K3.nota).toHaveLength(281);
    await app.close();
  });
});

// =====================================================================
// Auditoría de misión 2026-08-06 (D13-1) — el candado del verbatim POR LETRA
// =====================================================================

describe("step 20 · auditoría de misión (D13-1) — la letra marcada arrastra SU texto, nunca el de otra opción", () => {
  /**
   * El hueco que encontró la auditoría: todas las pruebas marcaban la letra
   * A, así que un opcionElegidaDelTaller() mutado para devolver SIEMPRE
   * options[0] pasaba la suite entera — y el acta habría atribuido a la
   * letra marcada el texto de OTRA opción, exactamente la falsificación que
   * esta misión prohíbe (D20-37.2). Estos dos candados matan esa mutación:
   * el positivo por las letras B y C, y el negativo por el texto ajeno.
   */
  function borradorConLetra(vista: Json, letra: string): { borrador: Borrador; entradas: Json[] } {
    const entradas = entriesDe(vista).filter((e) => (e.options as Json[]).some((o) => o.letter === letra));
    const borrador: Borrador = {};
    for (const e of entradas) borrador[String(e.entryId)] = { opcion: letra, nota: "" };
    return { borrador, entradas };
  }

  it("(D13-1.1) verbatim parametrizado por letra: marcado B (o C) en toda entrada que la tenga, la línea de opción lleva ESA letra y ESE texto — en el acta y en el borrador de misión", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    for (const letra of ["B", "C"]) {
      const { borrador, entradas } = borradorConLetra(vista, letra);
      // Material real: todas las entradas tienen B; C existe en un subconjunto.
      expect(entradas.length).toBeGreaterThan(0);
      const lineasActa = hooks.componerActaDelTaller(vista, borrador).split("\n");
      const lineasMision = hooks.componerBorradorDeMisionDelTaller(vista, borrador).split("\n");
      for (const e of entradas) {
        const linea = `${ACTA_COPY.optionPrefix}(${letra}) ${opcionDe(e, letra)}`;
        expect(lineasActa, `acta: la opción ${letra} de ${String(e.entryId)}`).toContain(linea);
        // La sección 1 del borrador de misión usa la misma plantilla servida.
        expect(lineasMision, `misión: la opción ${letra} de ${String(e.entryId)}`).toContain(linea);
      }
    }
    await app.close();
  });

  it("(D13-1.2) candado negativo: el texto de una opción NO marcada jamás sale tras «Opción anotada:» ni en la línea de grupo — ninguna letra hereda texto ajeno", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    // Ningún texto de opción se repite en el catálogo (comprobado aquí mismo):
    // la aserción de línea exacta no puede dar un falso positivo por colisión.
    const todosLosTextos = entriesDe(vista).flatMap((e) => (e.options as Json[]).map((o) => String(o.text)));
    expect(new Set(todosLosTextos).size).toBe(todosLosTextos.length);
    for (const letra of ["B", "C"]) {
      const { borrador, entradas } = borradorConLetra(vista, letra);
      const acta = hooks.componerActaDelTaller(vista, borrador);
      const mision = hooks.componerBorradorDeMisionDelTaller(vista, borrador);
      for (const e of entradas) {
        for (const o of e.options as Json[]) {
          if (o.letter === letra) continue;
          // Ni la letra marcada con texto ajeno…
          const falsificada = `${ACTA_COPY.optionPrefix}(${letra}) ${String(o.text)}`;
          expect(acta, `acta: ${String(e.entryId)} hereda el texto de (${String(o.letter)})`).not.toContain(falsificada);
          expect(mision, `misión: ${String(e.entryId)} hereda el texto de (${String(o.letter)})`).not.toContain(falsificada);
          // …ni la opción no marcada colada como anotada con su propia letra…
          expect(acta).not.toContain(`${ACTA_COPY.optionPrefix}(${String(o.letter)}) ${String(o.text)}`);
          // …ni la línea de grupo de la sección 3 de la misión con texto ajeno.
          expect(mision).not.toContain(`${String(e.entryId)}: (${letra}) ${String(o.text)}`);
        }
      }
    }
    await app.close();
  });
});
