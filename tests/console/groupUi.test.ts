import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { GROUP_COPY } from "../../src/console/operationsSnapshot.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks, type UiTestHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeElement, type FakeDocument } from "./fakeDom.js";

/**
 * step 18 · fase G — EL DIÁLOGO de reserva para varias personas (§5.4), sus
 * ejemplos de Laboratorio (§4.13) y lo que la Agenda dice de una cita que
 * pertenece a un grupo (§5.2, §4.11).
 *
 * Como en `noShowUi.test.ts`: JavaScript REAL de `/app.js`, DOM falso mínimo,
 * e instantáneas y escrituras contra el servidor REAL por `app.inject()`. Las
 * propuestas que se enseñan son las que devuelve `POST
 * /api/booking/group/proposals` de verdad, y las citas que se crean se crean
 * de verdad.
 *
 * LO QUE ESTAS PRUEBAS NO FIRMAN: el recorrido de teclado por los cuatro
 * pasos a 1440/1280/1024/768/~690 px (criterio 8.25) es del runbook del Mac.
 * `fakeDom.ts` no tiene ni orden de tabulación ni una sola regla de CSS.
 */

const TEST_SALT = "group-ui-test-salt";

type Json = Record<string, unknown>;
type PeticionRegistrada = { method: string; url: string; key: string | null; body: unknown };

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

function fetchContraLaApp(app: FastifyInstance, registro?: PeticionRegistrada[]): typeof fetch {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = init?.headers ?? {};
    const cuerpo: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
    if (registro) registro.push({ method, url, key: headers["Idempotency-Key"] ?? null, body: cuerpo });
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
// Los ids del HTML real
// ---------------------------------------------------------------------

const GRUPO_IDS = [
  { id: "dialogo-grupo", tag: "dialog" },
  { id: "dialogo-grupo-titulo", tag: "h2" },
  { id: "grupo-estado", tag: "p" },
  { id: "grupo-error", tag: "p" },
  { id: "grupo-paso-1", tag: "div" },
  { id: "grupo-paso-1-titulo", tag: "p" },
  { id: "grupo-personas", tag: "div" },
  { id: "grupo-anadir", tag: "button" },
  { id: "grupo-paso1-gate", tag: "p" },
  { id: "grupo-cancelar-1", tag: "button" },
  { id: "grupo-siguiente-1", tag: "button" },
  { id: "grupo-paso-2", tag: "div" },
  { id: "grupo-paso-2-titulo", tag: "p" },
  { id: "grupo-forma-consecutivas", tag: "input" },
  { id: "grupo-forma-simultaneas", tag: "input" },
  { id: "grupo-forma-aviso", tag: "p" },
  { id: "grupo-fecha", tag: "input" },
  { id: "grupo-paso2-gate", tag: "p" },
  { id: "grupo-atras-2", tag: "button" },
  { id: "grupo-cancelar-2", tag: "button" },
  { id: "grupo-siguiente-2", tag: "button" },
  { id: "grupo-paso-3", tag: "div" },
  { id: "grupo-paso-3-titulo", tag: "p" },
  { id: "grupo-buscar", tag: "button" },
  { id: "grupo-propuestas", tag: "div" },
  { id: "grupo-paso3-gate", tag: "p" },
  { id: "grupo-atras-3", tag: "button" },
  { id: "grupo-cancelar-3", tag: "button" },
  { id: "grupo-siguiente-3", tag: "button" },
  { id: "grupo-paso-4", tag: "div" },
  { id: "grupo-paso-4-titulo", tag: "p" },
  { id: "grupo-resumen-tbody", tag: "tbody" },
  { id: "grupo-resumen-cuantas", tag: "p" },
  { id: "grupo-atras-4", tag: "button" },
  { id: "grupo-cancelar-4", tag: "button" },
  { id: "grupo-confirmar", tag: "button" },
  { id: "grupo-cerrar", tag: "button" },
  { id: "tx-view-title", tag: "h1" },
] as const;

const AGENDA_IDS = [
  { id: "agenda-filtro-profesional", tag: "select" },
  "agenda-dias",
  "agenda-vacio",
  // step 19 §3.8, punto 2: renderAgenda() también rellena el desplegable
  // del explorador de huecos, bajo la misma guarda de igualdad.
  { id: "huecos-profesional", tag: "select" },
] as const;

const CANCELAR_IDS = [
  { id: "dialogo-cancelar-cita", tag: "dialog" },
  { id: "dialogo-cancelar-cita-titulo", tag: "h2" },
  { id: "cancelar-cita-paso-1", tag: "div" },
  { id: "cancelar-cita-paso-2", tag: "div" },
  { id: "cancelar-cita-resumen", tag: "p" },
  { id: "cancelar-cita-grupo", tag: "p" },
  { id: "cancelar-cita-plazo", tag: "p" },
  { id: "cancelar-cita-error", tag: "p" },
  { id: "cancelar-cita-resultado", tag: "p" },
  { id: "cancelar-cita-detalle", tag: "ul" },
  { id: "cancelar-cita-motivo", tag: "select" },
  { id: "cancelar-cita-confirmar", tag: "button" },
] as const;

const LAB_GRUPO_IDS = [
  { id: "lab-grupo-consecutivas", tag: "button" },
  { id: "lab-grupo-simultaneas", tag: "button" },
  { id: "lab-grupo-conflicto", tag: "button" },
  { id: "lab-grupo-imposible", tag: "button" },
  { id: "lab-grupo-ocupar", tag: "button" },
  { id: "lab-grupo-estado", tag: "p" },
] as const;

/**
 * step 19 §3.8, punto 10 / §7.1, I8 — `confirmarReinicio()` llama siempre a
 * `limpiarExploradorHuecos()`, sin importar qué ruta esté activa: hace falta
 * este documento aunque la prueba nunca visite Agenda.
 */
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

type Montaje = { document: FakeDocument; nodes: Record<string, FakeElement>; hooks: UiTestHooks };

function montar(ids: readonly (string | { id: string; tag: string })[]): Montaje {
  const { document, nodes } = createFakeDocumentWithIds(ids);
  const hooks = loadUiClientHooks("", document);
  return { document, nodes, hooks };
}

/**
 * Una consola montada, cableada y con la instantánea del servidor ya cargada.
 *
 * Los dos `<input type="radio">` de "cómo quieren las citas" vienen del HTML
 * servido, y su `value` es lo que el cliente lee al marcarlos. El DOM falso no
 * interpreta atributos, así que ese valor se copia AQUÍ del HTML real: si
 * alguien cambiara el `value` de uno de los dos radios, la copia fallaría a la
 * vista en vez de dejar la prueba pasando contra un valor inventado.
 */
async function consola(app: FastifyInstance, ids: readonly (string | { id: string; tag: string })[] = GRUPO_IDS): Promise<Montaje> {
  const m = montar(ids);
  const html = renderConsoleHtml();
  for (const id of ["grupo-forma-consecutivas", "grupo-forma-simultaneas"]) {
    const nodo = m.nodes[id];
    if (!nodo) continue;
    const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    const valor = /value="([^"]+)"/.exec(tag)?.[1] ?? "";
    expect(valor, `el radio ${id} no declara ningún value en el HTML servido`).not.toBe("");
    nodo.value = valor;
  }
  m.hooks.wireGrupoDialog();
  await conFetch(fetchContraLaApp(app), () => m.hooks.refresh());
  return m;
}

function textosVisibles(node: FakeElement): string[] {
  if (node.hidden) return [];
  if (node.children.length === 0) return node.textContent === "" ? [] : [node.textContent];
  const out: string[] = [];
  for (const hijo of node.children) out.push(...textosVisibles(hijo));
  return out;
}

/**
 * Los `<select>` de una fila de personas: etiqueta, servicio y profesional.
 *
 * step 19 D2 (declarado, §10.1.1): la fila ya no es un `<div>` con los tres
 * `.tx-field` como hijos directos. Es un `<fieldset class="tx-group-row">`
 * con `<legend>Persona N` primero y, detrás, un `<div
 * class="tx-group-row__fields">` que es quien cuelga los tres campos.
 */
function selectsDeFila(m: Montaje, indice: number): { etiqueta: FakeElement; servicio: FakeElement; profesional: FakeElement } {
  const fila = m.nodes["grupo-personas"].children[indice];
  const campos = fila.children[1];
  return {
    etiqueta: campos.children[0].children[1],
    servicio: campos.children[1].children[1],
    profesional: campos.children[2].children[1],
  };
}

/** Elige un valor en un `<select>` como lo haría una persona: escribe y dispara el cambio. */
function elegir(select: FakeElement, valor: string): void {
  select.value = valor;
  const manejador = select.onchange;
  expect(manejador, "ese <select> no tiene manejador de cambio").not.toBeNull();
  (manejador as () => void)();
}

/**
 * Marca un radio y dispara su cambio, como haría el teclado. Los radios de la
 * propuesta los construye el JS (y llevan `onchange`); los de "cómo quieren
 * las citas" vienen del HTML servido y se cablean con `addEventListener`, así
 * que hay que emitir el evento.
 */
function marcar(radio: FakeElement): void {
  radio.checked = true;
  if (radio.onchange) {
    radio.onchange();
    return;
  }
  radio.dispatchChange();
}

/** Rellena el paso 1 con dos personas y servicios distintos, y elige la forma y el día. */
function rellenarDosPersonas(m: Montaje, forma: "consecutive" | "simultaneous", fecha: string): void {
  elegir(selectsDeFila(m, 0).etiqueta, "Adulto A");
  elegir(selectsDeFila(m, 0).servicio, "1");
  elegir(selectsDeFila(m, 1).etiqueta, "Menor B");
  elegir(selectsDeFila(m, 1).servicio, forma === "consecutive" ? "0" : "1");
  m.hooks.irAPasoGrupo(2);
  marcar(m.nodes[forma === "consecutive" ? "grupo-forma-consecutivas" : "grupo-forma-simultaneas"]);
  m.nodes["grupo-fecha"].value = fecha;
  const cambio = m.nodes["grupo-fecha"];
  // El manejador de la fecha se engancha con addEventListener, no con
  // onchange: se replica lo que hace el navegador escribiendo el valor y
  // volviendo a pasar por la puerta.
  expect(cambio.value).toBe(fecha);
  m.hooks.actualizarPuertaGrupo();
}

// =====================================================================
// §5.4, paso 1 — quién viene y qué quiere cada persona
// =====================================================================

describe("step 18 §5.4 paso 1 — el servicio se elige persona por persona, y nada se copia solo", () => {
  it("abre con DOS personas, con el servicio sin elegir, y no deja seguir hasta que estén los dos", async () => {
    const app = freshApp();
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], null);

    expect(m.nodes["dialogo-grupo"].open).toBe(true);
    expect(m.nodes["grupo-paso-1"].hidden).toBe(false);
    expect(m.nodes["grupo-personas"].children.length).toBe(2);

    // El <select> de servicio NACE vacío, con su opción de "elige".
    const s0 = selectsDeFila(m, 0).servicio;
    expect(s0.value).toBe("");
    expect(s0.children[0].textContent).toBe("Elige un servicio");
    expect(m.nodes["grupo-siguiente-1"].disabled).toBe(true);
    expect(m.nodes["grupo-paso1-gate"].textContent).toContain("Falta el servicio de");

    elegir(s0, "1");
    // Elegir el de la primera NO rellena el de la segunda: no existe ninguna
    // propagación, ni ningún botón de "copiar a todos".
    expect(selectsDeFila(m, 1).servicio.value).toBe("");
    expect(m.nodes["grupo-siguiente-1"].disabled).toBe(true);

    elegir(selectsDeFila(m, 1).servicio, "0");
    expect(m.nodes["grupo-siguiente-1"].disabled).toBe(false);
    expect(m.nodes["grupo-paso1-gate"].textContent).toBe("Ya puedes seguir al paso 2.");
    await app.close();
  });

  it("las etiquetas son la lista CERRADA de K13, sin ningún campo de texto libre", async () => {
    const app = freshApp();
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], null);
    const etiquetas = selectsDeFila(m, 0).etiqueta.children.map((o) => o.textContent);
    expect(etiquetas).toEqual([...m.hooks.ETIQUETAS_GRUPO]);
    for (const etiqueta of etiquetas) {
      expect(etiqueta).toMatch(/^(Persona [1-4]|Adulto [A-D]|Menor [A-D])$/);
    }
    // Ni un solo <input type="text"> en el diálogo servido: no hay dónde
    // escribir el nombre de nadie.
    const html = renderConsoleHtml();
    const dialogo = html.slice(html.indexOf('id="dialogo-grupo"'), html.indexOf("</dialog>", html.indexOf('id="dialogo-grupo"')));
    expect(dialogo).not.toContain('type="text"');
    await app.close();
  });

  it("dos etiquetas repetidas cierran la puerta y dicen cuál está repetida", async () => {
    const app = freshApp();
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], null);
    elegir(selectsDeFila(m, 0).servicio, "1");
    elegir(selectsDeFila(m, 1).servicio, "1");
    expect(m.nodes["grupo-siguiente-1"].disabled).toBe(false);
    elegir(selectsDeFila(m, 1).etiqueta, selectsDeFila(m, 0).etiqueta.value);
    expect(m.nodes["grupo-siguiente-1"].disabled).toBe(true);
    expect(m.nodes["grupo-paso1-gate"].textContent).toContain("etiqueta distinta");
    await app.close();
  });

  it("con dos personas no hay botón de quitar; con cuatro no se puede añadir más, y quitar baja a tres", async () => {
    const app = freshApp();
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], null);
    // Con dos, NINGUNA ficha ofrece "Quitar esta persona": por debajo de dos
    // esto deja de ser una reserva para varias personas. Cada <fieldset>
    // sólo tiene <legend> + campos (step 19 D2, declarado en §10.1.1: antes
    // eran 3 hijos del <div>, ahora son 2 del <fieldset>).
    for (const fila of m.nodes["grupo-personas"].children) {
      expect(fila.children.length).toBe(2);
    }
    expect(m.nodes["grupo-anadir"].disabled).toBe(false);

    // Con cuatro (el máximo de K8), añadir se cierra y cada ficha SÍ ofrece
    // quitarse: <legend> + campos + acciones = 3 hijos.
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
      filas: [
        { etiqueta: "Persona 1", servicio: "1", profesional: "" },
        { etiqueta: "Persona 2", servicio: "1", profesional: "" },
        { etiqueta: "Persona 3", servicio: "1", profesional: "" },
        { etiqueta: "Persona 4", servicio: "1", profesional: "" },
      ],
    });
    expect(m.nodes["grupo-personas"].children.length).toBe(4);
    expect(m.nodes["grupo-anadir"].disabled).toBe(true);
    for (const fila of m.nodes["grupo-personas"].children) {
      expect(fila.children.length).toBe(3);
    }
    const quitar = m.nodes["grupo-personas"].children[1].children[2].children[0];
    expect(quitar.textContent).toBe("Quitar esta persona");
    expect(quitar.getAttribute("aria-label")).toBe("Quitar a la persona 2 de esta reserva");

    (quitar.onclick as () => void)();
    expect(m.nodes["grupo-personas"].children.length).toBe(3);
    expect(m.nodes["grupo-anadir"].disabled).toBe(false);
    await app.close();
  });

  it("cada ficha lleva su <legend>, cada control su rótulo corto, y el aria-label largo se conserva idéntico al de siempre (step 19 D2, M1)", async () => {
    const app = freshApp();
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], null);
    const fila = m.nodes["grupo-personas"].children[0];
    // El <fieldset> no es el contenedor de disposición: el <legend> es su
    // primer hijo, y los campos cuelgan del envoltorio siguiente.
    expect(fila.tagName).toBe("FIELDSET");
    expect(fila.children[0].tagName).toBe("LEGEND");
    expect(fila.children[0].textContent).toBe("Persona 1");
    const campos = fila.children[1];
    const esperado = [
      ["Etiqueta", "Etiqueta de la persona 1", "grupo-etiqueta-1"],
      ["Servicio", "Servicio de la persona 1", "grupo-servicio-1"],
      ["Profesional", "Profesional de la persona 1", "grupo-profesional-1"],
    ];
    esperado.forEach(([corto, largo, id], i) => {
      const campo = campos.children[i];
      // Crece de una comprobación a dos (declarado, §10.1.1): el <label>
      // visible dice el texto corto, y el <select> lleva, además, el
      // aria-label con el texto largo IDÉNTICO al que antes tenía el
      // <label>. Ninguna aserción de antes desaparece.
      expect(campo.children[0].textContent).toBe(corto);
      expect(campo.children[0].getAttribute("for")).toBe(id);
      expect(campo.children[1].getAttribute("id")).toBe(id);
      expect(campo.children[1].getAttribute("aria-label")).toBe(largo);
    });
    await app.close();
  });
});

// =====================================================================
// §5.4, paso 2 — la forma, sin preselección
// =====================================================================

describe("step 18 §5.4 paso 2 — el radiogroup no viene marcado: elige el operador", () => {
  it("ningún radio nace marcado, y hasta que se marca uno no se puede seguir", async () => {
    const app = freshApp();
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], null);
    elegir(selectsDeFila(m, 0).servicio, "1");
    elegir(selectsDeFila(m, 1).servicio, "0");
    m.hooks.irAPasoGrupo(2);

    expect(m.nodes["grupo-forma-consecutivas"].checked).toBe(false);
    expect(m.nodes["grupo-forma-simultaneas"].checked).toBe(false);
    expect(m.nodes["grupo-siguiente-2"].disabled).toBe(true);

    marcar(m.nodes["grupo-forma-consecutivas"]);
    expect(m.nodes["grupo-siguiente-2"].disabled).toBe(false);
    await app.close();
  });

  it("el HTML servido tampoco los trae marcados, ni siquiera por defecto", () => {
    const html = renderConsoleHtml();
    for (const id of ["grupo-forma-consecutivas", "grupo-forma-simultaneas"]) {
      const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
      expect(tag, `no se ha encontrado el radio ${id}`).not.toBe("");
      expect(tag).not.toContain("checked");
    }
  });

  it("cuando hay más personas que profesionales, se dice la verdad ANTES de elegir «a la vez»", async () => {
    const app = freshApp();
    const m = await consola(app);
    const snap = await snapshotOf(app);
    const cuantos = ((snap.calendar as Json).professionals as Json[]).length;
    expect(cuantos).toBe(3);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
      filas: [
        { etiqueta: "Persona 1", servicio: "1", profesional: "" },
        { etiqueta: "Persona 2", servicio: "1", profesional: "" },
        { etiqueta: "Persona 3", servicio: "1", profesional: "" },
        { etiqueta: "Persona 4", servicio: "1", profesional: "" },
      ],
    });
    expect(m.nodes["grupo-forma-aviso"].hidden).toBe(false);
    expect(m.nodes["grupo-forma-aviso"].textContent).toContain("en esta demostración son 3");
    expect(m.nodes["grupo-forma-aviso"].textContent).toContain("una detrás de otra");
    await app.close();
  });

  it("cuando se pide a la misma persona del equipo dos veces, también se dice antes", async () => {
    const app = freshApp();
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
      filas: [
        { etiqueta: "Persona 1", servicio: "1", profesional: "3" },
        { etiqueta: "Persona 2", servicio: "1", profesional: "3" },
      ],
    });
    expect(m.nodes["grupo-forma-aviso"].hidden).toBe(false);
    expect(m.nodes["grupo-forma-aviso"].textContent).toContain("nadie atiende dos citas en la misma media hora");
    await app.close();
  });
});

// =====================================================================
// §5.4, paso 3 — propuestas reales del servidor
// =====================================================================

describe("step 18 §5.4 paso 3 — las propuestas las resuelve el servidor, y ninguna viene elegida", () => {
  it("§9.2: dos consecutivas con servicios distintos dan la propuesta determinista del diseño", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
      forma: "consecutive",
      fecha: BOOKING_DEMO_TODAY,
      filas: [
        { etiqueta: "Adulto A", servicio: "1", profesional: "" },
        { etiqueta: "Menor B", servicio: "0", profesional: "" },
      ],
      paso: 3,
    });
    await conFetch(fetchContraLaApp(app), () => m.hooks.buscarPropuestasDeGrupo());

    const tarjetas = m.nodes["grupo-propuestas"].children;
    expect(tarjetas.length).toBeGreaterThan(0);
    const primera = textosVisibles(tarjetas[0]).join(" ");
    expect(primera).toContain("Propuesta 1");
    expect(primera).toContain("Una detrás de otra");
    expect(primera).toContain("Adulto A · Corte de pelo · martes 4 de agosto · 09:00–09:30 · Álex (sintético)");
    expect(primera).toContain("Menor B · Barba · martes 4 de agosto · 09:30–10:00 · Dani (sintético)");

    // Ninguna marcada, y por tanto no se puede seguir todavía.
    for (const tarjeta of tarjetas) {
      expect(tarjeta.children[0].children[0].checked).toBe(false);
    }
    expect(m.nodes["grupo-siguiente-3"].disabled).toBe(true);
    // El cartel de la puerta es texto ESTÁTICO del HTML servido, y el botón lo
    // referencia: la puerta cerrada dice por qué lo está.
    const html = renderConsoleHtml();
    expect(html).toContain(
      "El botón no se activa hasta que elijas una propuesta. Ninguna viene marcada y ninguna está recomendada: eliges tú.",
    );
    const tag = /<button[^>]*id="grupo-siguiente-3"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toMatch(/\sdisabled(\s|>)/);
    expect(tag).toContain('aria-describedby="grupo-paso3-gate"');
    await app.close();
  });

  it("§9.3: dos a la vez salen con profesionales DISTINTOS, y ninguna tarjeta dice «recomendada»", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
      forma: "simultaneous",
      fecha: BOOKING_DEMO_TODAY,
      filas: [
        { etiqueta: "Persona 1", servicio: "1", profesional: "" },
        { etiqueta: "Persona 2", servicio: "1", profesional: "" },
      ],
      paso: 3,
    });
    await conFetch(fetchContraLaApp(app), () => m.hooks.buscarPropuestasDeGrupo());
    const primera = textosVisibles(m.nodes["grupo-propuestas"].children[0]).join(" ");
    expect(primera).toContain("Persona 1 · Corte de pelo · martes 4 de agosto · 09:00–09:30 · Álex (sintético)");
    expect(primera).toContain("Persona 2 · Corte de pelo · martes 4 de agosto · 09:00–09:30 · Nerea (sintética)");
    for (const tarjeta of m.nodes["grupo-propuestas"].children) {
      expect(textosVisibles(tarjeta).join(" ").toLowerCase()).not.toContain("recomend");
    }
    await app.close();
  });

  it("§9.4: pedir a la misma persona del equipo para dos a la vez se rechaza con las palabras del servidor, sin proponer nada", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
      forma: "simultaneous",
      fecha: BOOKING_DEMO_TODAY,
      filas: [
        { etiqueta: "Persona 1", servicio: "1", profesional: "3" },
        { etiqueta: "Persona 2", servicio: "1", profesional: "3" },
      ],
      paso: 3,
    });
    await conFetch(fetchContraLaApp(app), () => m.hooks.buscarPropuestasDeGrupo());

    expect(m.nodes["grupo-propuestas"].children.length).toBe(0);
    expect(m.nodes["grupo-error"].hidden).toBe(false);
    expect(m.nodes["grupo-error"].textContent).toBe(
      "Has pedido a Álex (sintético) para dos personas a la vez. Una misma persona del equipo no puede atender dos citas en la misma media hora.",
    );
    expect(m.nodes["grupo-siguiente-3"].disabled).toBe(true);
    await app.close();
  });

  it("la consulta de propuestas NO escribe nada: ni una reserva, ni un evento (criterio 8.19)", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const antes = await snapshotOf(app);
    const m = await consola(app);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
      forma: "consecutive",
      fecha: BOOKING_DEMO_TODAY,
      filas: [
        { etiqueta: "Adulto A", servicio: "1", profesional: "" },
        { etiqueta: "Menor B", servicio: "0", profesional: "" },
      ],
      paso: 3,
    });
    const registro: PeticionRegistrada[] = [];
    await conFetch(fetchContraLaApp(app, registro), () => m.hooks.buscarPropuestasDeGrupo());

    const consulta = registro.find((p) => p.url === "/api/booking/group/proposals");
    // Sin clave de idempotencia: no hay nada que hacer idempotente.
    expect(consulta?.key).toBeNull();
    const despues = await snapshotOf(app);
    expect(((despues.operations as Json).audit as Json).total).toBe(((antes.operations as Json).audit as Json).total);
    expect((despues.calendar as Json).reservations).toEqual((antes.calendar as Json).reservations);
    expect(((despues.operations as Json).groups as Json).items).toEqual([]);
    await app.close();
  });
});

// =====================================================================
// §5.4, paso 4 — resumen y UNA confirmación
// =====================================================================

/** Deja el diálogo en el paso 4 con la primera propuesta elegida, sobre un servidor recién reiniciado. */
async function hastaElResumen(app: FastifyInstance, registro?: PeticionRegistrada[]): Promise<Montaje> {
  const m = await consola(app);
  m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
    forma: "consecutive",
    fecha: BOOKING_DEMO_TODAY,
    filas: [
      { etiqueta: "Adulto A", servicio: "1", profesional: "" },
      { etiqueta: "Menor B", servicio: "0", profesional: "" },
    ],
    paso: 3,
  });
  await conFetch(fetchContraLaApp(app, registro), () => m.hooks.buscarPropuestasDeGrupo());
  marcar(m.nodes["grupo-propuestas"].children[0].children[0].children[0]);
  m.hooks.irAPasoGrupo(4);
  return m;
}

describe("step 18 §5.4 paso 4 — el resumen lo dice todo, y hay UNA sola confirmación", () => {
  it("la tabla trae etiqueta, servicio, día, hora y profesional de cada persona, sin abreviaturas", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await hastaElResumen(app);

    expect(m.nodes["grupo-paso-4"].hidden).toBe(false);
    const filas = m.nodes["grupo-resumen-tbody"].children;
    expect(filas.length).toBe(2);
    expect(filas[0].children.map((td) => td.textContent)).toEqual([
      "Adulto A",
      "Corte de pelo",
      "martes 4 de agosto",
      "09:00–09:30",
      "Álex (sintético)",
    ]);
    expect(filas[0].children.map((td) => td.getAttribute("data-label"))).toEqual([
      "Persona",
      "Servicio",
      "Día",
      "Hora",
      "Profesional",
    ]);
    expect(m.nodes["grupo-resumen-cuantas"].textContent).toBe(
      "Se crearán 2 reservas sintéticas. Esta demostración no toca ningún sistema real.",
    );
    expect(m.nodes["grupo-confirmar"].textContent).toBe("Sí, crear estas 2 citas");
    // Y el foco ha ido al encabezado del paso nuevo.
    expect(m.document.activeElement).toBe(m.nodes["grupo-paso-4-titulo"]);
    await app.close();
  });

  it("las tres promesas del paso 4 están en el HTML servido, como texto estático", () => {
    const html = renderConsoleHtml();
    for (const frase of [
      "Si alguno de estos huecos ya no está libre, no se creará ninguna cita.",
      "Cancelar una de estas citas después no cancelará las demás.",
      "Esto mira la agenda tal y como está ahora mismo. Se volverá a comprobar justo antes de crear las citas.",
      "El servicio se elige persona por persona. No se copia solo: cada una puede querer algo distinto.",
      "Las dos formas ocurren el mismo día. Para citas en días distintos, créalas de una en una.",
    ]) {
      expect(html.includes(frase), `falta la frase del §5.4: ${frase}`).toBe(true);
    }
  });

  it("confirmar crea las N citas de verdad, con la clave de intención que resolvió el servidor", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const registro: PeticionRegistrada[] = [];
    const m = await hastaElResumen(app, registro);
    await conFetch(fetchContraLaApp(app, registro), () => m.hooks.confirmarGrupo() ?? Promise.resolve());

    const escritura = registro.find((p) => p.url === "/api/booking/groups");
    expect(escritura?.key).toBe("group:2026-08-04:consecutive:540-3-1.570-6-0:r0");
    const cuerpo = escritura?.body as Json;
    expect(cuerpo.confirmed).toBe(true);
    // El cliente devuelve las líneas TAL CUAL las resolvió la propuesta: no
    // acuña identidades, no elige profesional y no manda ningún groupId.
    expect(cuerpo).not.toHaveProperty("groupId");
    expect(cuerpo.lines).toEqual([
      { memberLabel: "Adulto A", serviceId: 1, employeeId: 3, startMinutes: 540 },
      { memberLabel: "Menor B", serviceId: 0, employeeId: 6, startMinutes: 570 },
    ]);

    expect(m.nodes["grupo-estado"].textContent).toBe("Creadas 2 citas sintéticas. Puedes verlas en la Agenda.");
    expect(m.nodes["grupo-confirmar"].hidden).toBe(true);
    expect(m.nodes["grupo-cerrar"].hidden).toBe(false);
    expect(m.document.activeElement).toBe(m.nodes["grupo-cerrar"]);

    const snap = await snapshotOf(app);
    const grupos = ((snap.operations as Json).groups as Json).items as Json[];
    expect(grupos.length).toBe(1);
    expect((grupos[0].lines as Json[]).length).toBe(2);
    await app.close();
  });

  it("un doble clic seguido no manda una segunda petición: la segunda llamada no hace nada", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const registro: PeticionRegistrada[] = [];
    const m = await hastaElResumen(app, registro);
    await conFetch(fetchContraLaApp(app, registro), async () => {
      const primera = m.hooks.confirmarGrupo();
      expect(m.hooks.confirmarGrupo()).toBeUndefined();
      await (primera ?? Promise.resolve());
    });
    expect(registro.filter((p) => p.url === "/api/booking/groups").length).toBe(1);
    await app.close();
  });

  it("N5 — una segunda pestaña con la misma propuesta canta REPETICIÓN, nunca «Creadas N citas»", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    // Dos consolas, las dos con la MISMA propuesta delante: es exactamente el
    // caso de las dos pestañas que el diseño declara.
    const primera = await hastaElResumen(app);
    const segunda = await hastaElResumen(app);

    await conFetch(fetchContraLaApp(app), () => primera.hooks.confirmarGrupo() ?? Promise.resolve());
    expect(primera.nodes["grupo-estado"].textContent).toBe("Creadas 2 citas sintéticas. Puedes verlas en la Agenda.");

    await conFetch(fetchContraLaApp(app), () => segunda.hooks.confirmarGrupo() ?? Promise.resolve());
    expect(segunda.nodes["grupo-estado"].textContent).toBe(
      "Esa reserva ya estaba creada. No se ha creado ninguna cita nueva.",
    );
    expect(segunda.nodes["grupo-estado"].textContent).not.toContain("Creadas");

    // Y en el mundo hay UN grupo y dos citas, no dos grupos y cuatro citas.
    const snap = await snapshotOf(app);
    expect((((snap.operations as Json).groups as Json).items as Json[]).length).toBe(1);
    await app.close();
  });

  it("§9.5 — si alguien ocupa el hueco antes de confirmar, se dice con la línea señalada y se vuelve al paso 3", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await hastaElResumen(app);

    // Una llamada del Laboratorio se lleva el primer hueco de la propuesta,
    // por la ruta que ya existe y sin tocarla.
    const robo = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A41-consola-roba-el-hueco-del-grupo",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "tuesday",
            time: "09:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    expect(robo.statusCode).toBe(200);
    const antes = await snapshotOf(app);

    await conFetch(fetchContraLaApp(app), () => m.hooks.confirmarGrupo() ?? Promise.resolve());

    expect(m.nodes["grupo-error"].textContent).toBe(
      "No se ha creado ninguna cita: el hueco de las 09:00 con Álex (sintético), para Adulto A, ya no está libre. No se ha escrito nada.",
    );
    expect(m.nodes["grupo-error"].className).toContain("tx-status-line--conflict");
    // Vuelta al paso de propuestas, y las de antes ya no están: describían un
    // mundo que ha cambiado.
    expect(m.nodes["grupo-paso-3"].hidden).toBe(false);
    expect(m.nodes["grupo-paso-4"].hidden).toBe(true);
    expect(m.nodes["grupo-propuestas"].children.length).toBe(0);
    expect(m.nodes["grupo-siguiente-3"].disabled).toBe(true);

    // Y NO se ha creado ninguna cita: ni la de Dani, que sí estaba libre.
    const despues = await snapshotOf(app);
    expect(((despues.operations as Json).groups as Json).items).toEqual([]);
    expect(((despues.operations as Json).audit as Json).total).toBe(((antes.operations as Json).audit as Json).total);
    await app.close();
  });

  it("la frase de cada conflicto señala la línea y ninguna afirma que se haya escrito algo", async () => {
    const app = freshApp();
    const m = await consola(app);
    await app.close();
    const linea = { memberLabel: "Adulto A", when: "09:00", professionalLabel: "Álex (sintético)" };
    for (const conflict of [
      "slot_no_longer_free",
      "slot_in_the_past",
      "professional_cannot_perform_service",
      "date_outside_booking_horizon",
    ]) {
      const texto = m.hooks.textoDeConflictoDeGrupo({ conflict, line: linea });
      expect(texto.startsWith("No se ha creado ninguna cita:"), texto).toBe(true);
      expect(texto.endsWith("No se ha escrito nada."), texto).toBe(true);
    }
  });
});

// =====================================================================
// §5.2 y §4.11 — la Agenda y la cancelación individual
// =====================================================================

describe("step 18 §5.2/§4.11 — las citas de un grupo se ven una a una, con su referencia compartida", () => {
  async function conGrupoCreado(): Promise<{ app: FastifyInstance; snap: Json }> {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await hastaElResumen(app);
    await conFetch(fetchContraLaApp(app), () => m.hooks.confirmarGrupo() ?? Promise.resolve());
    return { app, snap: await snapshotOf(app) };
  }

  it("cada cita lleva su referencia en castellano, y NUNCA el identificador del grupo ni el de la reserva", async () => {
    const { app, snap } = await conGrupoCreado();
    const m = montar([...AGENDA_IDS]);
    m.hooks.renderAgenda(snap);
    const filas = m.nodes["agenda-dias"].children[0].children[2].children[0].children[2].children;
    const delGrupo = filas.filter((tr) => (tr.getAttribute("data-key") ?? "").startsWith("res-g-"));
    expect(delGrupo.length).toBe(2);
    expect(textosVisibles(delGrupo[0]).join(" ")).toContain(
      "Parte de una reserva para varias personas · grupo 1 · Adulto A · cita 1 de 2",
    );
    expect(textosVisibles(delGrupo[1]).join(" ")).toContain("cita 2 de 2");

    // Criterio 8.41: ni un identificador interno en ningún texto pintado.
    for (const id of Object.keys(m.nodes)) {
      for (const texto of textosVisibles(m.nodes[id])) {
        for (const token of ["grp-", "res-g-", "slot-2026", "consecutive", "simultaneous", "group:"]) {
          expect(texto.includes(token), `'${token}' se ve en #${id}: "${texto}"`).toBe(false);
        }
      }
    }
    await app.close();
  });

  it("el diálogo de cancelar dice ANTES de confirmar que se cancela sólo ésta, con el texto del servidor", async () => {
    const { app, snap } = await conGrupoCreado();
    const m = montar([...CANCELAR_IDS, ...AGENDA_IDS, { id: "tx-view-title", tag: "h1" }]);
    await conFetch(fetchContraLaApp(app), () => m.hooks.refresh());

    const reservas = (snap.calendar as Json).reservations as Json[];
    const delGrupo = reservas.find((r) => String(r.id).startsWith("res-g-")) as Json;
    const suelta = reservas.find((r) => r.id === "demo-salon-res-1") as Json;

    m.hooks.abrirDialogoCancelarCita(delGrupo, m.nodes["tx-view-title"]);
    expect(m.nodes["cancelar-cita-grupo"].hidden).toBe(false);
    expect(m.nodes["cancelar-cita-grupo"].textContent).toBe((delGrupo.group as Json).cancelDialogNote);
    expect(m.nodes["cancelar-cita-grupo"].textContent).toContain("Se cancela sólo ésta");

    // Y en una cita que no es de ningún grupo, la nota no aparece ni deja resto.
    m.hooks.abrirDialogoCancelarCita(suelta, m.nodes["tx-view-title"]);
    expect(m.nodes["cancelar-cita-grupo"].hidden).toBe(true);
    expect(m.nodes["cancelar-cita-grupo"].textContent).toBe("");
    await app.close();
  });

  it("§9.6 — cancelar una línea deja la hermana en pie, y la Agenda lo dice", async () => {
    const { app } = await conGrupoCreado();
    const cancelacion = await app.inject({
      method: "POST",
      url: "/api/reservations/res-g-grp-0001-1/cancel",
      payload: { reasonCode: "client_cancelled_by_phone_simulated", confirmed: true },
      headers: { "idempotency-key": "cancel:res-g-grp-0001-1" },
    });
    expect(cancelacion.statusCode).toBe(200);
    const snap = await snapshotOf(app);

    const grupo = (((snap.operations as Json).groups as Json).items as Json[])[0];
    expect(grupo.groupState).toBe("partially_cancelled");

    const m = montar([...AGENDA_IDS]);
    m.hooks.renderAgenda(snap);
    const filas = m.nodes["agenda-dias"].children[0].children[2].children[0].children[2].children;
    const cancelada = filas.find((tr) => tr.getAttribute("data-key") === "res-g-grp-0001-1") as FakeElement;
    const viva = filas.find((tr) => tr.getAttribute("data-key") === "res-g-grp-0001-2") as FakeElement;
    // (Enmienda de fase K, prescrita en DECISIONES §10) Con UNA hermana viva
    // la frase va en singular, y se comprueba entera en vez de por un trozo.
    expect(textosVisibles(cancelada).join(" ")).toContain("La otra cita de este grupo sigue en pie.");
    // La hermana NO dice nada de hermanas canceladas: sigue siendo una cita normal.
    expect(textosVisibles(viva).join(" ")).not.toContain("de este grupo sigue en pie");
    await app.close();
  });
});

// =====================================================================
// §4.13 — los ejemplos del Laboratorio
// =====================================================================

describe("step 18 §4.13 — los ejemplos del Laboratorio usan las rutas reales y no confirman por nadie", () => {
  it("«2 consecutivas con servicios distintos» rellena el diálogo, lo abre en el paso 3 y busca de verdad", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await consola(app, [...GRUPO_IDS, ...LAB_GRUPO_IDS]);
    const registro: PeticionRegistrada[] = [];
    await conFetch(fetchContraLaApp(app, registro), async () => {
      m.hooks.lanzarEjemploDeGrupo("consecutivas", m.nodes["lab-grupo-consecutivas"]);
      await m.hooks.buscarPropuestasDeGrupo();
    });

    expect(m.nodes["dialogo-grupo"].open).toBe(true);
    expect(m.nodes["grupo-paso-3"].hidden).toBe(false);
    expect(registro.some((p) => p.url === "/api/booking/group/proposals")).toBe(true);
    expect(m.nodes["grupo-propuestas"].children.length).toBeGreaterThan(0);
    // NADA se ha creado: el botón sólo prepara, confirmar sigue siendo del operador.
    const snap = await snapshotOf(app);
    expect(((snap.operations as Json).groups as Json).items).toEqual([]);
    await app.close();
  });

  it("«Conflicto» prepara la propuesta, habilita el botón auxiliar y NO abre el diálogo todavía", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await consola(app, [...GRUPO_IDS, ...LAB_GRUPO_IDS]);
    // Nace deshabilitado en el HTML servido: no hay ningún hueco que ocupar
    // hasta que haya una propuesta preparada.
    const tag = /<button[^>]*id="lab-grupo-ocupar"[^>]*>/.exec(renderConsoleHtml())?.[0] ?? "";
    expect(tag).toMatch(/\sdisabled(\s|>)/);

    await conFetch(fetchContraLaApp(app), () => m.hooks.prepararConflictoDeGrupo());
    expect(m.nodes["lab-grupo-ocupar"].disabled).toBe(false);
    expect(m.nodes["lab-grupo-estado"].textContent).toContain("Propuesta preparada");
    expect(m.nodes["lab-grupo-estado"].textContent).toContain("09:00–09:30 con Álex (sintético) para Adulto A");
    expect(m.nodes["dialogo-grupo"].open).toBe(false);
    // Y no ha escrito nada.
    const snap = await snapshotOf(app);
    expect(((snap.operations as Json).groups as Json).items).toEqual([]);
    await app.close();
  });

  it("el botón auxiliar ocupa el hueco por /api/scenario/run y deja el diálogo listo para confirmar y fallar", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await consola(app, [...GRUPO_IDS, ...LAB_GRUPO_IDS]);
    const registro: PeticionRegistrada[] = [];
    const f = fetchContraLaApp(app, registro);
    await conFetch(f, () => m.hooks.prepararConflictoDeGrupo());
    await conFetch(f, () => m.hooks.ocuparElHuecoDeLaPropuesta() ?? Promise.resolve());

    expect(registro.some((p) => p.url === "/api/scenario/run")).toBe(true);
    expect(m.nodes["dialogo-grupo"].open).toBe(true);
    expect(m.nodes["grupo-paso-4"].hidden).toBe(false);

    // Al confirmar, el servidor revalida y no crea nada.
    await conFetch(f, () => m.hooks.confirmarGrupo() ?? Promise.resolve());
    expect(m.nodes["grupo-error"].textContent).toContain("ya no está libre. No se ha escrito nada.");
    const snap = await snapshotOf(app);
    expect(((snap.operations as Json).groups as Json).items).toEqual([]);
    await app.close();
  });
});

// =====================================================================
// Reinicio con el diálogo a medias (§1.3) y disciplina de origen
// =====================================================================

describe("step 18 §1.3 — un reinicio con el diálogo de grupo a medias no deja ni un mensaje rancio", () => {
  it("las dos regiones del diálogo entran en el barrido, se vacían y quedan ocultas", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await consola(app, [
      ...GRUPO_IDS,
      ...LAB_GRUPO_IDS,
      ...HUECOS_IDS,
      { id: "estado-global", tag: "p" },
      { id: "dialogo-reset", tag: "dialog" },
      { id: "dialogo-reset-titulo", tag: "h2" },
      { id: "btn-abrir-reset", tag: "button" },
      { id: "reset-confirmar", tag: "button" },
      { id: "reset-estado", tag: "p" },
      { id: "lab-reloj-estado", tag: "p" },
      { id: "inasistencia-estado", tag: "p" },
      { id: "corregir-inasistencia-estado", tag: "p" },
    ]);
    // Un diálogo a medias, con un conflicto a la vista y una línea de estado.
    m.hooks.setEstadoLinea(m.nodes["grupo-estado"], "Creando las citas…", "");
    m.hooks.setEstadoLinea(m.nodes["grupo-error"], "No se ha creado ninguna cita: el hueco ya no está libre.", "conflict");
    m.hooks.setEstadoLinea(m.nodes["lab-grupo-estado"], "Propuesta preparada.", "ok");

    await conFetch(fetchContraLaApp(app), () => m.hooks.confirmarReinicio());

    for (const id of ["grupo-estado", "grupo-error", "lab-grupo-estado", "lab-reloj-estado", "inasistencia-estado", "corregir-inasistencia-estado"]) {
      expect(m.nodes[id].textContent, `${id} conserva texto rancio`).toBe("");
      expect(m.nodes[id].hidden, `${id} debería quedar oculta`).toBe(true);
    }
    // El tono ESTÁTICO del alert sobrevive al barrido (8.37).
    expect(m.nodes["grupo-error"].className).toContain("tx-status-line--error");
    expect(m.nodes["estado-global"].textContent).toBe("Demostración reiniciada. Todo vuelve a estar a cero.");
    await app.close();
  });
});

describe("step 18 §5.4 — la pantalla no acuña identidades ni compone frases de negocio del grupo", () => {
  it("el JavaScript servido no construye ninguna clave de intención ni ningún identificador de grupo", () => {
    const js = renderConsoleAppJs();
    expect(js).toContain("propuesta.intentKeyToMint");
    // Ni el prefijo de la clave, ni el del grupo, ni el de sus reservas.
    expect(js).not.toContain("'group:'");
    expect(js).not.toContain("'grp-'");
    expect(js).not.toContain("'res-g-'");
  });

  it("el diálogo de grupo no llama a resolveVenueDay ni a venueWeekdayHours: la agenda la resuelve el servidor (8.20)", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("// ---- Diálogo: reserva para varias personas");
    // (step 24) El corte de arriba termina donde EMPIEZA el bloque de la cita
    // manual, no donde empieza el del reloj: entre los dos hay ahora un tercer
    // bloque, y meterlo en este recorte haría que esta prueba juzgara al
    // diálogo de grupo por código que no es suyo. El bloque nuevo tiene su
    // propia guarda, justo debajo y con el mismo listón.
    const fin = js.indexOf("// step 24 — CREAR CITA MANUAL");
    expect(inicio).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(inicio);
    const bloque = js.slice(inicio, fin);
    for (const prohibido of ["resolveVenueDay", "venueWeekdayHours", "freeSlotStarts", "chooseProfessional", "slotKey"]) {
      expect(bloque.includes(prohibido), `el diálogo de grupo usa '${prohibido}'`).toBe(false);
    }
  });

  it("el diálogo de la CITA MANUAL tampoco resuelve nada de negocio (step 24 §1.1)", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("// step 24 — CREAR CITA MANUAL");
    const fin = js.indexOf("// ---- Laboratorio: el reloj de la demostración");
    expect(inicio).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(inicio);
    // Se juzga el CÓDIGO, no los comentarios: un comentario puede —y debe—
    // explicar que quien resuelve «cualquiera» es `chooseProfessional` en el
    // servidor, y eso no es que lo llame el navegador.
    const bloque = js.slice(inicio, fin).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const prohibido of ["resolveVenueDay", "venueWeekdayHours", "freeSlotStarts", "chooseProfessional", "isSlotFree", "canPerform"]) {
      expect(bloque.includes(prohibido), `el diálogo de la cita manual usa '${prohibido}'`).toBe(false);
    }
    // Y no acuña ninguna clave de idempotencia: la manda resuelta el servidor.
    expect(bloque.includes("'manual:'"), "el navegador compone la clave de intención").toBe(false);
    expect(bloque).toContain("p.keyToMint");
  });

  it("el texto del fallo inyectado NO promete nada sobre el reintento: manda volver desde la propuesta", () => {
    const js = renderConsoleAppJs();
    expect(js).toContain("Si quieres, vuelve a intentarlo desde la propuesta.");
    // Nunca se afirma que reintentar no vaya a crear nada: un 500 no se
    // memoriza, así que el reintento SE EJECUTA de verdad (nota N4 del §4.8).
    for (const mentira of [
      "reintentar no crea",
      "volver a intentarlo no crea",
      "el reintento no escribe",
      "puedes reintentar sin riesgo",
    ]) {
      expect(js.toLowerCase().includes(mentira), `la pantalla promete '${mentira}'`).toBe(false);
    }
  });

  it("el sondeo de 2 s no reescribe el paso 3: la propuesta que se está mirando no cambia bajo los pies", async () => {
    const app = freshApp();
    await app.inject({ method: "POST", url: "/api/reset", payload: {} });
    const m = await consola(app, [...GRUPO_IDS, ...AGENDA_IDS]);
    m.hooks.abrirDialogoGrupo(m.nodes["tx-view-title"], {
      forma: "consecutive",
      fecha: BOOKING_DEMO_TODAY,
      filas: [
        { etiqueta: "Adulto A", servicio: "1", profesional: "" },
        { etiqueta: "Menor B", servicio: "0", profesional: "" },
      ],
      paso: 3,
    });
    await conFetch(fetchContraLaApp(app), () => m.hooks.buscarPropuestasDeGrupo());
    marcar(m.nodes["grupo-propuestas"].children[0].children[0].children[0]);
    const antes = textosVisibles(m.nodes["grupo-propuestas"]).join(" ");
    expect(m.nodes["grupo-siguiente-3"].disabled).toBe(false);

    // El mundo cambia por debajo: alguien reserva ese hueco. Y llega el sondeo.
    await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A42-consola-sondeo-durante-el-dialogo",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "tuesday",
            time: "09:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    await conFetch(fetchContraLaApp(app), () => m.hooks.refresh());

    // La propuesta sigue exactamente donde estaba, y sigue elegida: el
    // operador no pierde su sitio. Quien detecta el cambio es la revalidación
    // del servidor al confirmar, y lo dice entonces.
    expect(m.nodes["dialogo-grupo"].open).toBe(true);
    expect(m.nodes["grupo-paso-3"].hidden).toBe(false);
    expect(textosVisibles(m.nodes["grupo-propuestas"]).join(" ")).toBe(antes);
    expect(m.nodes["grupo-siguiente-3"].disabled).toBe(false);
    await app.close();
  });

  it("las frases del servidor sobre la cancelación de un grupo siguen siendo las del catálogo", () => {
    expect(GROUP_COPY.cancelNoteForGroup).toBe("Cancelar una de estas citas no cancela las demás.");
    expect(GROUP_COPY.cancelNoteForLine).toBe("Cancelar esta cita no cancela las demás.");
  });

  it("los tres diálogos nuevos están DESPUÉS de vista-llamadas en el HTML servido (criterio 8.41)", () => {
    const html = renderConsoleHtml();
    const llamadas = html.indexOf('id="vista-llamadas"');
    expect(llamadas).toBeGreaterThan(-1);
    for (const id of ["dialogo-inasistencia", "dialogo-corregir-inasistencia", "dialogo-grupo"]) {
      expect(html.indexOf(`id="${id}"`), `${id} debe ir después de vista-llamadas`).toBeGreaterThan(llamadas);
    }
    // Y el corte que examina el criterio 22 de step 17 sigue sin ellos.
    const corte = html.slice(html.indexOf('id="vista-lista-espera"'), llamadas);
    for (const token of ["dialogo-grupo", "grp-", "res-g-", "slot-2026"]) {
      expect(corte.includes(token), `'${token}' se ha colado en el corte de la lista de espera`).toBe(false);
    }
  });
});
