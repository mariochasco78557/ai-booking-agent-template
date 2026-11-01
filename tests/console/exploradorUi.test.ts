import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { AVAILABILITY_EXPLORER_COPY } from "../../src/console/availabilityExplorer.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks, type UiTestHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeElement, type FakeDocument } from "./fakeDom.js";

/**
 * step 19 · Capacidad 1 — la INTERFAZ del explorador de huecos sintéticos
 * ("Comprobar huecos sintéticos", panel en línea en Agenda, §3).
 *
 * Misma técnica que el resto de la consola: JavaScript REAL de `/app.js`
 * (`uiClientExtract.ts`), DOM falso mínimo (`fakeDom.ts`), servidor REAL por
 * `app.inject()`.
 *
 * LO QUE ESTAS PRUEBAS NO FIRMAN: el recorrido responsive/de teclado a
 * 1440/1280/1024/768/~690 px y el anillo de foco visible son del runbook del
 * Mac — `fakeDom.ts` no tiene ni una regla de CSS.
 */

const TEST_SALT = "explorador-ui-test-salt";
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

const HUECOS_IDS = [
  { id: "huecos-servicio", tag: "select" },
  { id: "huecos-a-quien-una", tag: "input" },
  { id: "huecos-a-quien-cualquiera", tag: "input" },
  "huecos-profesional-campo",
  { id: "huecos-profesional", tag: "select" },
  { id: "huecos-cuando-dia", tag: "input" },
  { id: "huecos-cuando-rango", tag: "input" },
  "huecos-dia-campo",
  { id: "huecos-fecha", tag: "input" },
  "huecos-desde-campo",
  { id: "huecos-desde", tag: "input" },
  "huecos-hasta-campo",
  { id: "huecos-hasta", tag: "input" },
  "huecos-gate",
  { id: "huecos-comprobar", tag: "button" },
  "huecos-error",
  "huecos-resultados-bloque",
  { id: "huecos-resultados-titulo", tag: "h3" },
  "huecos-recuento",
  "huecos-orden",
  "huecos-sintetico",
  "huecos-desfase",
  "huecos-vacio",
  "huecos-nota-incapacidad",
  { id: "huecos-motivos-dias", tag: "ul" },
  { id: "huecos-resultados", tag: "div" },
] as const;

const AGENDA_IDS = [
  { id: "agenda-filtro-profesional", tag: "select" },
  "agenda-dias",
  "agenda-vacio",
] as const;

type Montaje = { document: FakeDocument; nodes: Record<string, FakeElement>; hooks: UiTestHooks };

/**
 * Monta el documento y copia el `value` REAL de los cuatro radios desde el
 * HTML servido — el DOM falso no interpreta atributos, así que ese valor se
 * copia del HTML real: si alguien lo cambiara, esto fallaría a la vista.
 */
/**
 * Los contenedores que el HTML servido marca `hidden` de partida — el DOM
 * falso no interpreta atributos, así que aquí se copia ese estado a mano,
 * como ya hace `createEquipoFakeDocument()` con `#equipo-vacio`. Cada uno se
 * comprueba contra el HTML real antes de forzarlo, para que un cambio de
 * partida en `ui.html.ts` falle aquí a la vista.
 */
const OCULTOS_DE_PARTIDA = [
  "huecos-profesional-campo",
  "huecos-dia-campo",
  "huecos-desde-campo",
  "huecos-hasta-campo",
  "huecos-error",
  "huecos-resultados-bloque",
  "huecos-desfase",
  "huecos-vacio",
  "huecos-nota-incapacidad",
  "huecos-motivos-dias",
] as const;

function montar(extraIds: readonly (string | { id: string; tag: string })[] = []): Montaje {
  const { document, nodes } = createFakeDocumentWithIds([...HUECOS_IDS, ...AGENDA_IDS, ...extraIds]);
  const html = renderConsoleHtml();
  for (const id of ["huecos-a-quien-una", "huecos-a-quien-cualquiera", "huecos-cuando-dia", "huecos-cuando-rango"]) {
    const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    const valor = /value="([^"]+)"/.exec(tag)?.[1] ?? "";
    expect(valor, `el radio ${id} no declara ningún value en el HTML servido`).not.toBe("");
    nodes[id]!.value = valor;
  }
  for (const id of OCULTOS_DE_PARTIDA) {
    const abre = new RegExp(`id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(abre, `${id} no aparece en el HTML servido`).not.toBe("");
    expect(abre, `${id} debería nacer 'hidden' en el HTML servido`).toMatch(/\shidden(\s|>)/);
    nodes[id]!.hidden = true;
  }
  // '#huecos-desfase' lleva su frase COMO TEXTO ESTÁTICO en el HTML servido
  // (el cliente sólo alterna 'hidden', nunca reescribe el texto — §3.8.5): se
  // copia aquí, del HTML real, por la misma razón que los cuatro `value` de
  // arriba.
  const bloqueDesfase = new RegExp(`<p[^>]*id="huecos-desfase"[^>]*>([^<]*)</p>`).exec(html);
  expect(bloqueDesfase, "huecos-desfase no aparece con su frase estática en el HTML servido").not.toBeNull();
  nodes["huecos-desfase"]!.textContent = bloqueDesfase![1] ?? "";
  const hooks = loadUiClientHooks("", document);
  hooks.wireHuecosControls();
  return { document, nodes, hooks };
}

function marcar(radio: FakeElement): void {
  radio.checked = true;
  radio.dispatchChange();
}

// =====================================================================
// I3 — nada preseleccionado.
// =====================================================================

describe("El formulario nace sin nada elegido (I3), y el botón sigue apagado", () => {
  it("el servicio, los dos grupos de radio y las fechas nacen vacíos/sin marcar", () => {
    const m = montar();
    expect(m.nodes["huecos-servicio"]!.value).toBe("");
    expect(m.nodes["huecos-a-quien-una"]!.checked).toBe(false);
    expect(m.nodes["huecos-a-quien-cualquiera"]!.checked).toBe(false);
    expect(m.nodes["huecos-cuando-dia"]!.checked).toBe(false);
    expect(m.nodes["huecos-cuando-rango"]!.checked).toBe(false);
    expect(m.nodes["huecos-fecha"]!.value).toBe("");
    expect(m.nodes["huecos-comprobar"]!.disabled).toBe(true);
  });

  it("la línea de puerta dice, por defecto, qué hace falta elegir en general", () => {
    const m = montar();
    expect(m.nodes["huecos-gate"]!.textContent).toBe(
      "El botón no se activa hasta que elijas el servicio, a quién quieres y las fechas. No se rellena nada solo.",
    );
  });

  it("con una sola cosa elegida, la puerta enumera exactamente lo que falta, y nunca activa el botón 'por si acaso'", () => {
    const m = montar();
    m.nodes["huecos-servicio"]!.value = "1";
    m.nodes["huecos-servicio"]!.dispatchChange();
    expect(m.nodes["huecos-comprobar"]!.disabled).toBe(true);
    expect(m.nodes["huecos-gate"]!.textContent).toBe("Falta decir a quién y la fecha.");

    marcar(m.nodes["huecos-a-quien-cualquiera"]!);
    expect(m.nodes["huecos-comprobar"]!.disabled).toBe(true);
    expect(m.nodes["huecos-gate"]!.textContent).toBe("Falta la fecha.");

    marcar(m.nodes["huecos-cuando-dia"]!);
    expect(m.nodes["huecos-comprobar"]!.disabled).toBe(true); // falta la fecha en sí
    expect(m.nodes["huecos-gate"]!.textContent).toBe("Falta la fecha.");

    m.nodes["huecos-fecha"]!.value = "2026-08-04";
    m.nodes["huecos-fecha"]!.dispatchChange();
    expect(m.nodes["huecos-comprobar"]!.disabled).toBe(false);
    expect(m.nodes["huecos-gate"]!.textContent).toBe("");
  });

  it("eligiendo 'Una persona concreta' aparece el desplegable de quién, oculto hasta entonces, y sigue sin nada marcado", () => {
    const m = montar();
    expect(m.nodes["huecos-profesional-campo"]!.hidden).toBe(true);
    marcar(m.nodes["huecos-a-quien-una"]!);
    expect(m.nodes["huecos-profesional-campo"]!.hidden).toBe(false);
    expect(m.nodes["huecos-profesional"]!.value).toBe("");

    // Con el servicio y la fecha ya elegidos, lo único que falta es la
    // persona: la puerta lo dice y el botón sigue apagado hasta que se elija.
    m.nodes["huecos-servicio"]!.value = "1";
    m.nodes["huecos-servicio"]!.dispatchChange();
    marcar(m.nodes["huecos-cuando-dia"]!);
    m.nodes["huecos-fecha"]!.value = "2026-08-04";
    m.nodes["huecos-fecha"]!.dispatchChange();
    expect(m.nodes["huecos-gate"]!.textContent).toBe("Falta decir a quién.");
    expect(m.nodes["huecos-comprobar"]!.disabled).toBe(true);

    m.nodes["huecos-profesional"]!.value = "3";
    m.nodes["huecos-profesional"]!.dispatchChange();
    expect(m.nodes["huecos-gate"]!.textContent).toBe("");
    expect(m.nodes["huecos-comprobar"]!.disabled).toBe(false);
  });

  it("eligiendo 'Un rango de días' aparecen Desde/Hasta, y 'Un día concreto' sigue oculto", () => {
    const m = montar();
    marcar(m.nodes["huecos-cuando-rango"]!);
    expect(m.nodes["huecos-desde-campo"]!.hidden).toBe(false);
    expect(m.nodes["huecos-hasta-campo"]!.hidden).toBe(false);
    expect(m.nodes["huecos-dia-campo"]!.hidden).toBe(true);
  });
});

// =====================================================================
// El sondeo (renderAgenda) no toca este panel salvo ensureProfessionalOptions.
// =====================================================================

describe("El sondeo de 2 s no toca campos, resultados ni mensajes — su única escritura es el desplegable de quién", () => {
  it("ensureProfessionalOptions llena '#huecos-profesional' con 'Elige a quién' como opción vacía, y nunca preselecciona a nadie", async () => {
    const app = freshApp();
    const snap = await snapshotOf(app);
    const m = montar();
    m.hooks.renderAgenda(snap);
    const opciones = m.nodes["huecos-profesional"]!.options.map((o) => ({ value: o.value, texto: o.textContent }));
    expect(opciones[0]).toEqual({ value: "", texto: "Elige a quién" });
    expect(m.nodes["huecos-profesional"]!.value).toBe("");
    await app.close();
  });

  it("nada preseleccionado TAMBIÉN tras un repintado del sondeo (criterio 11 reforzado, hallazgo A1): un segundo renderAgenda() no cambia la selección vacía", async () => {
    const app = freshApp();
    const snap = await snapshotOf(app);
    const m = montar();
    m.hooks.renderAgenda(snap);
    m.hooks.renderAgenda(snap);
    expect(m.nodes["huecos-profesional"]!.value).toBe("");
    const opciones = m.nodes["huecos-profesional"]!.options;
    expect(opciones[0]!.value).toBe("");
    expect(opciones.some((o) => o.value === String(ALEX_ID))).toBe(true);
    await app.close();
  });

  it("el sondeo no toca ningún campo elegido, ningún mensaje de error y ningún resultado pintado", async () => {
    const app = freshApp();
    const snap = await snapshotOf(app);
    const m = montar();
    m.nodes["huecos-servicio"]!.value = "1";
    marcar(m.nodes["huecos-a-quien-cualquiera"]!);
    marcar(m.nodes["huecos-cuando-dia"]!);
    m.nodes["huecos-fecha"]!.value = "2026-08-04";
    m.hooks.setEstadoLinea(m.nodes["huecos-error"]!, "Un error de mentira, para probar que sobrevive.", "error");
    m.nodes["huecos-resultados"]!.appendChild(new FakeElement("article"));

    m.hooks.renderAgenda(snap);

    expect(m.nodes["huecos-servicio"]!.value).toBe("1");
    expect(m.nodes["huecos-a-quien-cualquiera"]!.checked).toBe(true);
    expect(m.nodes["huecos-fecha"]!.value).toBe("2026-08-04");
    expect(m.nodes["huecos-error"]!.textContent).toBe("Un error de mentira, para probar que sobrevive.");
    expect(m.nodes["huecos-resultados"]!.children.length).toBe(1);
    await app.close();
  });

});

/** Un `fetch` que habla con el servidor REAL por `app.inject()`. */
function fetchContraLaApp(app: FastifyInstance): typeof fetch {
  return (async (url: string, init?: { method?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const res = await app.inject({ method: method as "GET", url: url as string });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
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

/** Elige un servicio+persona+día concreto de una sola vez, dejando el botón activo. */
function rellenarUnDiaConcreto(m: Montaje, servicio: string, dia: string): void {
  m.nodes["huecos-servicio"]!.value = servicio;
  m.nodes["huecos-servicio"]!.dispatchChange();
  marcar(m.nodes["huecos-a-quien-cualquiera"]!);
  marcar(m.nodes["huecos-cuando-dia"]!);
  m.nodes["huecos-fecha"]!.value = dia;
  m.nodes["huecos-fecha"]!.dispatchChange();
}

// =====================================================================
// La consulta real: éxito, error, vacío, incapacidad — contra el servidor.
// =====================================================================

describe("comprobarHuecos() pinta el resultado que de verdad devuelve el servidor", () => {
  it("con éxito, pinta el recuento, la nota de orden, la nota sintética y una tarjeta por hueco — y mueve el foco al encabezado", async () => {
    const app = freshApp();
    const m = montar();
    rellenarUnDiaConcreto(m, "1", "2026-08-04");
    await conFetch(fetchContraLaApp(app), () => m.hooks.comprobarHuecos());

    expect(m.nodes["huecos-resultados-bloque"]!.hidden).toBe(false);
    expect(m.nodes["huecos-recuento"]!.textContent).toMatch(/hueco/);
    expect(m.nodes["huecos-orden"]!.textContent).toContain("Orden de lectura");
    expect(m.nodes["huecos-sintetico"]!.textContent).toContain("agenda sintética");
    expect(m.nodes["huecos-resultados"]!.children.length).toBeGreaterThan(0);
    expect(m.document.activeElement).toBe(m.nodes["huecos-resultados-titulo"]);
    await app.close();
  });

  it("no hay ningún botón de reservar, ni en el panel ni en ninguna tarjeta de resultado", async () => {
    const app = freshApp();
    const m = montar();
    rellenarUnDiaConcreto(m, "1", "2026-08-04");
    await conFetch(fetchContraLaApp(app), () => m.hooks.comprobarHuecos());
    const html = renderConsoleHtml();
    // (step 26 REAPERTURA §R4) El panel BAJA por debajo de `#agenda-dias` y
    // pasa a `<details>`: su tramo se delimita por sus propias etiquetas, no
    // por el id que antes venía después. Con el corte anterior este tramo
    // habría quedado VACÍO y la prueba habría pasado sin comprobar nada.
    const inicio = html.indexOf('id="huecos-panel"');
    expect(inicio).toBeGreaterThan(-1);
    const seccion = html.slice(inicio, html.indexOf("</details>", inicio));
    expect(seccion).toContain('id="huecos-resultados"');
    expect(seccion.toLowerCase()).not.toContain("reservar");
    await app.close();
  });

  it("cuando el servidor contesta 400, el campo se conserva y el mensaje exacto del servidor aparece en huecos-error", async () => {
    const app = freshApp();
    const m = montar();
    m.nodes["huecos-servicio"]!.value = "9"; // fuerza unknown_service — pero el gate de cliente no lo sabe
    marcar(m.nodes["huecos-a-quien-cualquiera"]!);
    marcar(m.nodes["huecos-cuando-dia"]!);
    m.nodes["huecos-fecha"]!.value = "2026-08-04";
    m.nodes["huecos-fecha"]!.dispatchChange();
    expect(m.nodes["huecos-comprobar"]!.disabled).toBe(false);
    await conFetch(fetchContraLaApp(app), () => m.hooks.comprobarHuecos());
    expect(m.nodes["huecos-error"]!.textContent).toBe("Ese servicio no existe en esta demostración.");
    expect(m.nodes["huecos-error"]!.className).toContain("tx-status-line--error");
    expect(m.nodes["huecos-servicio"]!.value).toBe("9"); // el formulario no se vacía
    expect(m.nodes["huecos-resultados-bloque"]!.hidden).toBe(true); // ni se pinta un resultado viejo
    await app.close();
  });

  it("Nerea con Barba: 200, estado vacío con la nota de incapacidad exacta, no un resultado inventado", async () => {
    const app = freshApp();
    const m = montar();
    m.nodes["huecos-servicio"]!.value = "0";
    m.nodes["huecos-servicio"]!.dispatchChange();
    marcar(m.nodes["huecos-a-quien-una"]!);
    m.nodes["huecos-profesional"]!.value = "9";
    m.nodes["huecos-profesional"]!.dispatchChange();
    marcar(m.nodes["huecos-cuando-dia"]!);
    m.nodes["huecos-fecha"]!.value = "2026-08-04";
    m.nodes["huecos-fecha"]!.dispatchChange();

    await conFetch(fetchContraLaApp(app), () => m.hooks.comprobarHuecos());

    expect(m.nodes["huecos-resultados"]!.children.length).toBe(0);
    expect(m.nodes["huecos-nota-incapacidad"]!.hidden).toBe(false);
    expect(m.nodes["huecos-nota-incapacidad"]!.textContent).toBe(
      "Nerea (sintética) no hace Barba, así que no hay ninguna media hora suya para ese servicio. Prueba con “Cualquiera del equipo”.",
    );
    await app.close();
  });

  it("sin conexión, el mensaje es exactamente 'No hay conexión con el motor.'", async () => {
    const m = montar();
    rellenarUnDiaConcreto(m, "1", "2026-08-04");
    const fetchRoto: typeof fetch = () => Promise.reject(new Error("network down"));
    await conFetch(fetchRoto, () => m.hooks.comprobarHuecos());
    expect(m.nodes["huecos-error"]!.textContent).toBe("No hay conexión con el motor.");
  });
});

// =====================================================================
// El reinicio (§3.8 punto 10, §7.1 I8).
// =====================================================================

describe("El reinicio vacía resultados, encabezado y nota de desfase — los campos del formulario NO se tocan", () => {
  it("tras comprobar con éxito, limpiarExploradorHuecos() vacía todo lo pintado y deja el formulario intacto", async () => {
    const app = freshApp();
    const m = montar();
    rellenarUnDiaConcreto(m, "1", "2026-08-04");
    await conFetch(fetchContraLaApp(app), () => m.hooks.comprobarHuecos());
    expect(m.nodes["huecos-resultados"]!.children.length).toBeGreaterThan(0);

    m.hooks.limpiarExploradorHuecos();

    expect(m.nodes["huecos-resultados"]!.children.length).toBe(0);
    expect(m.nodes["huecos-resultados-bloque"]!.hidden).toBe(true);
    expect(m.nodes["huecos-desfase"]!.hidden).toBe(true);
    expect(m.nodes["huecos-vacio"]!.hidden).toBe(true);
    expect(m.nodes["huecos-nota-incapacidad"]!.hidden).toBe(true);
    // El formulario NO se toca: lo que el operador eligió sigue siendo lo que quiere consultar.
    expect(m.nodes["huecos-servicio"]!.value).toBe("1");
    expect(m.nodes["huecos-a-quien-cualquiera"]!.checked).toBe(true);
    expect(m.nodes["huecos-fecha"]!.value).toBe("2026-08-04");
    await app.close();
  });
});

// =====================================================================
// La nota de desfase (§3.8, punto 5): tres escalares, nunca una regla.
// =====================================================================

describe("La nota de desfase aparece cuando el mundo se mueve, y no antes", () => {
  it("con el mundo sin cambiar, un repintado del sondeo no muestra la nota de desfase", async () => {
    const app = freshApp();
    const m = montar();
    rellenarUnDiaConcreto(m, "1", "2026-08-04");
    await conFetch(fetchContraLaApp(app), () => m.hooks.comprobarHuecos());
    expect(m.nodes["huecos-desfase"]!.hidden).toBe(true);

    const snap = await snapshotOf(app);
    m.hooks.renderAgenda(snap);
    expect(m.nodes["huecos-desfase"]!.hidden).toBe(true);
    await app.close();
  });

  it("si el número de reservas confirmadas cambia (se cancela una cita) tras la consulta, la nota de desfase aparece — y los resultados no se recalculan solos", async () => {
    const app = freshApp();
    const m = montar();
    rellenarUnDiaConcreto(m, "1", "2026-08-04");
    await conFetch(fetchContraLaApp(app), () => m.hooks.comprobarHuecos());
    expect(m.nodes["huecos-desfase"]!.hidden).toBe(true);
    const huecosAntes = m.nodes["huecos-resultados"]!.children.length;

    const cancelacion = await post(
      app,
      "/api/reservations/demo-salon-res-1/cancel",
      { reasonCode: "unspecified", confirmed: true },
      { "Idempotency-Key": "cancelar-para-desfase" },
    );
    expect(cancelacion.statusCode).toBe(200);

    const snap = await snapshotOf(app);
    m.hooks.renderAgenda(snap);

    expect(m.nodes["huecos-desfase"]!.hidden).toBe(false);
    // La frase estática del HTML servido y `AVAILABILITY_EXPLORER_COPY.desfase`
    // son la MISMA constante desde el repaso adversarial (hallazgo H6): antes
    // vivían sueltas por duplicado, y esta prueba comprobaba un literal
    // repetido en vez de la fuente única.
    expect(m.nodes["huecos-desfase"]!.textContent).toBe(AVAILABILITY_EXPLORER_COPY.desfase);
    // I1: no se recalcula solo. Los resultados pintados siguen siendo los mismos.
    expect(m.nodes["huecos-resultados"]!.children.length).toBe(huecosAntes);
    await app.close();
  });
});

describe("revisión adversarial de la capacidad 3, hallazgo m1 — #huecos-panel nunca es una región anónima", () => {
  /**
   * (step 26 REAPERTURA §R4) El hallazgo m1 pedía que este panel tuviera
   * NOMBRE ACCESIBLE, y lo resolvió con `aria-labelledby="tit-huecos"` sobre
   * un `<h2>`. R4 lo convierte en un `<details>` plegado: ahora quien lo
   * nombra es su propio `<summary>`, con el MISMO `id` y el MISMO texto, y el
   * `aria-labelledby` sobra por construcción (§R4, «el `<summary>` ya nombra
   * la región»). La exigencia de fondo —que la región tenga nombre— no se
   * relaja: cambia el mecanismo, del atributo al elemento nativo.
   */
  it("el panel se nombra a sí mismo con su <summary>, sin aria-labelledby que mantener sincronizado", () => {
    const html = renderConsoleHtml();
    const inicio = html.indexOf('id="huecos-panel"');
    expect(inicio).toBeGreaterThan(-1);
    const apertura = html.slice(html.lastIndexOf("<", inicio), html.indexOf(">", inicio) + 1);
    expect(apertura.startsWith("<details")).toBe(true);
    expect(apertura).not.toContain("aria-labelledby");
    const panel = html.slice(inicio, html.indexOf("</details>", inicio));
    expect(panel).toContain('<summary id="tit-huecos">Comprobar huecos sintéticos</summary>');
    // Y nadie apunta ya a ese id con aria-labelledby: no queda una referencia huérfana.
    expect(html).not.toContain('aria-labelledby="tit-huecos"');
  });
});

