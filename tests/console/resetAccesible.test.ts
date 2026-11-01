import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { CONSOLE_CSS } from "../../src/console/ui.css.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks, type UiTestHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, type FakeDocument, type FakeElement } from "./fakeDom.js";

/**
 * step 18 · fase D — EL REINICIO ACCESIBLE.
 *
 * Reproduce el defecto del §1.0 del diseño (internal doc, not included in the template)
 * y fija su reparación: tras «Reiniciar la demostración», los mensajes de un
 * mundo que ya no existe («Guardando…», «Cita cancelada.», «Aviso simulado a
 * Cliente A…», «Creando la reserva…») sobrevivían en las regiones
 * `role="status"`/`role="alert"`, y el anuncio nuevo convivía con ellos dentro
 * de un `<dialog>` que un temporizador cerraba a los 900 ms.
 *
 * Técnica, la misma que el resto de las pruebas de interfaz de esta consola:
 * se ejecuta el JavaScript REAL que sirve `GET /app.js` (`uiClientExtract.ts`)
 * contra el DOM falso mínimo de `fakeDom.ts`, y se habla con el servidor de
 * verdad por `app.inject()` — el `fetch` global se sustituye por un puente que
 * inyecta en la aplicación real, así que `POST /api/reset` reinicia de verdad
 * y `GET /api/snapshot` devuelve el mundo nuevo.
 *
 * LO QUE ESTAS PRUEBAS NO FIRMAN (§1.7 del diseño). `fakeDom.ts` no emula el
 * árbol de accesibilidad: aquí se comprueba el ESTADO DEL DOM —qué texto hay,
 * qué está oculto, con qué clases, en qué orden se mutó—, nunca lo que
 * pronuncia un lector de pantalla. Que se anuncie UNA frase y ninguna rancia,
 * que el foco visible acabe en «Reiniciar la demostración» y que `Escape`
 * cierre el diálogo lo firma el runbook del Mac (criterio 8.8, V-M).
 */

const TEST_SALT = "reset-accesible-test-salt";

const TEXTO_REINICIO = "Demostración reiniciada. Todo vuelve a estar a cero.";
const TEXTO_SIN_CONEXION = "No se ha podido reiniciar: no hay conexión con el motor. No se ha borrado nada.";
const TEXTO_RECHAZADO = "No se ha podido reiniciar. El motor ha rechazado la petición. No se ha borrado nada.";

/**
 * Las 27 regiones transitorias, escritas AQUÍ a mano. La prueba comprueba
 * después que esta lista y `REGIONES_TRANSITORIAS` del cliente coinciden: si
 * alguien añade una región al cliente sin decidir qué hace un reinicio con
 * ella, esta prueba lo dice.
 *
 * ENMIENDA DELIBERADA (fase G de step 18). Eran 19 y son 25. La aserción NO
 * se debilita —sigue comparando el conjunto EXACTO, elemento a elemento— y el
 * cambio es justo lo que el §1.2.2 del diseño dejó pendiente por escrito: las
 * regiones nuevas se apuntan a esta lista EN SU FASE, que es ésta. Las seis
 * que entran son las cinco de la tabla del §1.1 (filas 24-28) más
 * `lab-grupo-estado`, la línea del panel de ejemplos de grupo del §4.13.
 *
 * SEGUNDA ENMIENDA DELIBERADA (step 19 §3.8, punto 10; §7.1, I8). Eran 25 y
 * son 27: `huecos-gate` y `huecos-error`, del explorador de huecos
 * sintéticos. `huecos-gate` se recalcula de inmediato tras el barrido, en
 * `limpiarExploradorHuecos()` (vía `actualizarPuertaHuecos()`), a partir de
 * los campos del formulario — que el reinicio NO toca — así que nunca queda
 * vacía "de verdad" para quien mira la pantalla ya repintada.
 *
 * TERCERA ENMIENDA DELIBERADA (step 19 §4.6). Eran 27 y son 28:
 * `lab-tareas-estado`, la línea de estado vacío del historial de tareas
 * humanas del Laboratorio. A diferencia de `huecos-gate`, NADIE la recalcula
 * dentro de la propia secuencia de reinicio: se vacía con el resto del
 * barrido y se comprueba aquí como una región transitoria normal, ya que este
 * panel sólo se repinta cuando Laboratorio es la sección activa — que no es
 * el caso en `montarConsola()` (arranca en `#/lista-espera`).
 *
 * CUARTA ENMIENDA DELIBERADA (step 19 §5.2.6, §7.1 punto I8, hallazgo M2).
 * Eran 28 y son 29: `lab-resumen-copiar-estado`, el mensaje de «Resumen
 * copiado…»/el respaldo del resumen para Bruno (Capacidad 3A). Es ESTADO DE
 * CLIENTE — no sale de la instantánea — así que el repintado del Laboratorio
 * no lo borraría solo; el `<textarea>` de respaldo, que no es una línea de
 * estado, se vacía y se vuelve a ocultar aparte, explícitamente, en la propia
 * secuencia de reinicio (`limpiarRespaldoDeCopiaDelResumen()`).
 *
 * QUINTA ENMIENDA DELIBERADA (re-verificación de la fase 12, hallazgo n1).
 * Eran 29 y son 28: `lab-tareas-estado` SALE de la lista — es un
 * ENDURECIMIENTO, no un aflojamiento. Con Laboratorio activo, estar en la
 * lista producía DOS locuciones en el mismo turno de reinicio
 * (`lab-tareas-estado`, reescrita por el repintado justo después de que el
 * barrido la vaciara, y `#estado-global`), rompiendo la regla de una sola
 * del §1.3. Mismo motivo que ya excluye a `lista-espera-cargando`: el propio
 * repintado (`renderHistorialDeTareas`, que corre en cada sondeo) la deja
 * correcta sin que el barrido tenga que tocarla primero, y la guarda de M4
 * (`ponerEstadoTareas`) no la reescribe si el texto tras reiniciar ya era el
 * mismo que tenía. Ver la prueba «un turno de reinicio con Laboratorio
 * activo…», más abajo, que fija el recuento de locuciones.
 *
 * SEXTA ENMIENDA DELIBERADA (step 20 §6.4, D20-28, fecha 2026-08-06). Eran
 * 28 y son 30: `tx-taller-acta-estado` y `tx-taller-mision-estado`, las dos
 * líneas de estado de copiado del taller de decisiones con Bruno. Son estado
 * de CLIENTE —no salen de la instantánea, así que el repintado no las
 * borraría solo— y son el resultado de una acción, no el estado permanente
 * del panel. El BORRADOR del taller no se toca (D20-27), y `tx-taller-estado`
 * y `tx-taller-cobertura` quedan FUERA a propósito: siguen siendo ciertos
 * tras el reinicio, mismo motivo que sacó a `lab-tareas-estado`. Los dos
 * `<textarea>` de respaldo, que no son líneas de estado, se vacían y se
 * ocultan aparte, en `limpiarRespaldosDelTaller()`.
 */
const TRANSITORIAS = [
  "le-huecos-estado",
  "le-tardias-estado",
  "le-personas-estado",
  "le-plazo-estado",
  "llamada-copiar-estado",
  "lab-escenario-estado",
  "dia-especial-paso1-error",
  "dia-especial-contador",
  "dia-especial-exito",
  "ausencia-paso1-error",
  "ausencia-contador",
  "ausencia-exito",
  "reset-estado",
  "cancelar-cita-error",
  "cancelar-cita-resultado",
  "alta-lista-error",
  "alta-lista-resultado",
  "simular-aviso-estado",
  "convertir-estado",
  "inasistencia-estado",
  "corregir-inasistencia-estado",
  "grupo-estado",
  "grupo-error",
  // (step 24 §13) Y son 32: las dos líneas del diálogo de la cita manual.
  // Mismo par y mismo motivo que las del grupo — estado de CLIENTE, resultado
  // de una acción del operador, y sin ellas un mensaje del mundo anterior
  // sobreviviría a un reinicio.
  "manual-estado",
  "manual-error",
  "lab-reloj-estado",
  "lab-grupo-estado",
  "huecos-gate",
  "huecos-error",
  "lab-resumen-copiar-estado",
  "tx-taller-acta-estado",
  "tx-taller-mision-estado",
] as const;

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

const AGENDA_IDS = [
  { id: "agenda-filtro-profesional", tag: "select" },
  "agenda-dias",
  "agenda-vacio",
] as const;

/**
 * step 19 §3.8, punto 10 / §7.1, I8 — todo lo que
 * `limpiarExploradorHuecos()` (llamada desde `confirmarReinicio()`) y su
 * `actualizarPuertaHuecos()` tocan, sin importar qué ruta esté activa: el
 * reinicio vacía este panel pase lo que pase, así que su documento de
 * prueba necesita existir siempre, no sólo cuando la ruta es Agenda.
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
] as const;

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

/**
 * Un `fetch` que habla con el servidor REAL por `app.inject()`. Devuelve lo
 * poco que el cliente usa —`ok`, `status`, `headers.get` y `json()`— y nada
 * más: si el cliente empezara a leer otra cosa, fallaría aquí, a la vista.
 */
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

type Consola = {
  document: FakeDocument;
  nodes: Record<string, FakeElement>;
  win: { location: { hash: string }; scrollTo: () => void };
  hooks: UiTestHooks;
};

/**
 * La consola entera, montada por el camino de verdad: se enruta, se ejecuta
 * el sondeo REAL (`refresh()`) contra el servidor REAL y se queda con la
 * instantánea guardada, que es de donde leen todas las pantallas.
 */
async function montarConsola(app: FastifyInstance, hash = "#/lista-espera"): Promise<Consola> {
  const { document, nodes } = createFakeDocumentWithIds([
    ...LISTA_ESPERA_IDS,
    ...AGENDA_IDS,
    ...HUECOS_IDS,
    ...RESET_IDS,
    ...TRANSITORIAS,
  ]);
  const win = { location: { hash }, scrollTo: () => undefined };
  const hooks = loadUiClientHooks(hash, document, win);
  hooks.applyRoute();
  await conFetch(fetchContraLaApp(app), () => hooks.refresh());
  return { document, nodes, win, hooks };
}

/**
 * (re-verificación de la fase 12, hallazgo n1) Todo lo que `renderLaboratorio`
 * toca sin guarda de nulo — a diferencia de `renderGuionEnPantalla`,
 * `renderResumenOwner`, `renderPanelDelReloj`, `renderHistorialDeOperaciones`
 * y `renderHistorialDeTareas`, que salen en silencio si su contenedor
 * principal no existe, la cola de eventos, la auditoría, el JSON y los
 * controles del historial de tareas SÍ hacen falta en el documento de
 * prueba para que `renderLaboratorio` no reviente. Mismo patrón que
 * `LABORATORIO_IDS` en `tareasHumanas.test.ts`.
 */
const LABORATORIO_IDS = [
  { id: "lab-eventos-pilot", tag: "dl" },
  { id: "lab-eventos-internal", tag: "dl" },
  "lab-auditoria-vacio",
  { id: "lab-auditoria-lista", tag: "ul" },
  { id: "lab-json", tag: "pre" },
  { id: "lab-tareas-filtro-pendientes", tag: "button" },
  { id: "lab-tareas-filtro-resueltas", tag: "button" },
  { id: "lab-tareas-filtro-todas", tag: "button" },
  { id: "lab-tareas-motivo", tag: "select" },
  { id: "lab-tareas-lista", tag: "ul" },
  "lab-tareas-estado",
] as const;

/**
 * La consola montada en `#/laboratorio`, con todo lo que hace falta para que
 * un reinicio de verdad ejercite el repintado del historial de tareas
 * humanas (hallazgo n1) — `montarConsola()` arranca siempre en
 * `#/lista-espera` a propósito (§1.1) y por eso nunca alcanza esta ruta.
 */
async function montarConsolaEnLaboratorio(app: FastifyInstance): Promise<Consola> {
  const hash = "#/laboratorio";
  const { document, nodes } = createFakeDocumentWithIds([
    ...HUECOS_IDS,
    ...RESET_IDS,
    ...TRANSITORIAS,
    ...LABORATORIO_IDS,
  ]);
  const win = { location: { hash }, scrollTo: () => undefined };
  const hooks = loadUiClientHooks(hash, document, win);
  hooks.applyRoute();
  await conFetch(fetchContraLaApp(app), () => hooks.refresh());
  return { document, nodes, win, hooks };
}

/**
 * (re-verificación de la fase 12, hallazgo n1) Engancha el escritor de
 * `textContent` de cada nodo indicado y apunta cada escritura, con su id y
 * el texto nuevo — para poder contar, no sólo el valor final, cuántas veces
 * y con qué contenido se ha tocado una región viva durante un turno.
 */
function instrumentarEscrituras(
  nodes: Record<string, FakeElement>,
  ids: readonly string[],
): Array<{ id: string; texto: string }> {
  const escrituras: Array<{ id: string; texto: string }> = [];
  for (const id of ids) {
    const nodo = nodes[id];
    if (!nodo) continue;
    const prototipo = Object.getPrototypeOf(nodo) as { textContent: string };
    const descriptor = Object.getOwnPropertyDescriptor(prototipo, "textContent") as PropertyDescriptor;
    Object.defineProperty(nodo, "textContent", {
      configurable: true,
      get(this: FakeElement) {
        return (descriptor.get as (this: FakeElement) => string).call(this);
      },
      set(this: FakeElement, value: string) {
        escrituras.push({ id, texto: value });
        (descriptor.set as (this: FakeElement, v: string) => void).call(this, value);
      },
    });
  }
  return escrituras;
}

/** Los textos rancios del §1.0, puestos en las regiones que de verdad los escriben. */
const RANCIOS: ReadonlyArray<readonly [string, string, string]> = [
  ["le-personas-estado", "Guardando…", ""],
  ["cancelar-cita-resultado", "Cita cancelada.", "ok"],
  ["simular-aviso-estado", "Aviso simulado a Cliente A. No se ha enviado ningún mensaje ni se ha llamado a nadie.", "ok"],
  ["convertir-estado", "Creando la reserva…", ""],
  ["le-huecos-estado", "Reserva sintética creada para Cliente B.", "ok"],
  ["llamada-copiar-estado", "Copiado", "ok"],
  ["lab-escenario-estado", "Los turnos no son JSON válido.", "error"],
  ["dia-especial-contador", "Guardando…", ""],
  ["dia-especial-exito", "Cambio guardado.", "ok"],
  ["dia-especial-paso1-error", "Rellena las fechas y el nombre antes de continuar.", "error"],
  ["ausencia-contador", "Guardando…", ""],
  ["ausencia-exito", "Cambio guardado.", "ok"],
  ["ausencia-paso1-error", "La fecha de fin no puede ser anterior a la de inicio.", "error"],
  ["cancelar-cita-error", "No hay conexión con el motor. No se ha guardado nada.", "error"],
  ["alta-lista-error", "Rellena los dos días antes de continuar.", "error"],
  ["alta-lista-resultado", "Cliente C está en la lista de espera. Cómo está: pendiente.", "ok"],
  ["le-tardias-estado", "Anotado: revisada, sin acción.", "ok"],
  ["le-plazo-estado", "Plazo guardado.", "ok"],
  ["convertir-estado", "Creando la reserva…", ""],
];

function sembrarRancios(c: Consola): void {
  for (const [id, texto, tono] of RANCIOS) {
    c.hooks.setEstadoLinea(c.nodes[id], texto, tono);
  }
  // Una escritura PELADA, como la que alguien podría reintroducir mañana: el
  // barrido tiene que llevársela igual.
  c.nodes["le-huecos-estado"].textContent = "Hueco liberado: martes a las 10:00.";
  for (const id of TRANSITORIAS) {
    if (c.nodes[id].textContent === "") c.hooks.setEstadoLinea(c.nodes[id], `Rancio de ${id}`, "");
  }
}

// =====================================================================
// (a) La reproducción del defecto original
// =====================================================================

describe("consola · step 18 §1.0 — un reinicio con éxito no deja ni un mensaje del mundo anterior", () => {
  it("las 25 regiones transitorias se vacían, y el anuncio sale UNA vez y fuera del diálogo", async () => {
    const app = freshApp();
    const c = await montarConsola(app);

    // Un mundo con historia: se cancela una cita de verdad antes de reiniciar.
    await app.inject({
      method: "POST",
      url: "/api/reservations/demo-salon-res-1/cancel",
      payload: { reasonCode: "unspecified", confirmed: true },
      headers: { "Idempotency-Key": "cancel-para-el-reinicio" },
    });
    sembrarRancios(c);
    for (const id of TRANSITORIAS) {
      expect(c.nodes[id].textContent, `${id} debería tener texto rancio antes de reiniciar`).not.toBe("");
    }

    c.hooks.abrirDialogoReset();
    expect(c.nodes["dialogo-reset"].open).toBe(true);

    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());

    // ENMIENDA DELIBERADA (step 19 §3.8, punto 10). `huecos-gate` es la
    // ÚNICA de las 27 regiones que el barrido vacía y que, en el MISMO
    // reinicio, `limpiarExploradorHuecos()` vuelve a escribir — con la frase
    // por defecto, recalculada a partir de un formulario que el reinicio no
    // toca y que sigue sin nada elegido. No es texto rancio del mundo
    // anterior: es la puerta, correcta y de nuevo al día. Se excluye del
    // barrido genérico de abajo y se comprueba aparte.
    for (const id of TRANSITORIAS) {
      if (id === "huecos-gate") continue;
      expect(c.nodes[id].textContent, `${id} conserva texto de un mundo que ya no existe`).toBe("");
      // (enmienda de fase D, N1) una línea vacía TERMINA oculta: es lo que la
      // saca del árbol de accesibilidad. La no-mudez la garantiza que todo
      // escritor pasa por `setEstadoLinea` — se comprueba más abajo.
      expect(c.nodes[id].hidden, `${id} vacía tendría que quedar oculta`).toBe(true);
    }
    expect(c.nodes["huecos-gate"].textContent).toBe(
      "El botón no se activa hasta que elijas el servicio, a quién quieres y las fechas. No se rellena nada solo.",
    );
    expect(c.nodes["huecos-gate"].hidden).toBe(false);

    // El anuncio: exactamente una vez, con tono de éxito, y en la región que
    // vive en <main> y no dentro del <dialog>.
    expect(c.nodes["estado-global"].textContent).toBe(TEXTO_REINICIO);
    expect(c.nodes["estado-global"].hidden).toBe(false);
    expect(c.nodes["estado-global"].className).toContain("tx-status-line--ok");
    const apariciones = TRANSITORIAS.filter((id) => c.nodes[id].textContent.includes(TEXTO_REINICIO));
    expect(apariciones).toEqual([]);

    // El diálogo se cierra sin temporizador, y el foco vuelve al disparador.
    expect(c.nodes["dialogo-reset"].open).toBe(false);
    expect(c.document.activeElement).toBe(c.nodes["btn-abrir-reset"]);

    await app.close();
  });

  it("la lista literal del cliente es exactamente la del diseño: ni `tx-freshness` ni las dos líneas estructurales entran en el barrido", async () => {
    const app = freshApp();
    const c = await montarConsola(app);

    expect([...c.hooks.REGIONES_TRANSITORIAS]).toEqual([...TRANSITORIAS]);
    expect(c.hooks.REGIONES_TRANSITORIAS).not.toContain("tx-freshness");
    expect(c.hooks.REGIONES_TRANSITORIAS).not.toContain("tx-conexion-anuncio");
    expect(c.hooks.REGIONES_TRANSITORIAS).not.toContain("inicio-ruta-desconocida");
    expect(c.hooks.REGIONES_TRANSITORIAS).not.toContain("lista-espera-cargando");

    // Y las tres siguen siendo regiones vivas en el HTML servido: la
    // reparación no se ha hecho quitando avisos.
    const html = renderConsoleHtml();
    for (const id of ["tx-freshness", "tx-conexion-anuncio", "inicio-ruta-desconocida", "lista-espera-cargando", ...TRANSITORIAS]) {
      expect(html, `${id} ha desaparecido del HTML servido`).toContain(`id="${id}"`);
    }
    // ENMIENDA DELIBERADA (fase G de step 18). Eran 23 regiones vivas y son
    // 29: las seis nuevas de esta fase. La aserción no se debilita —sigue
    // fijando el número EXACTO, que es lo que impide que alguien siembre
    // regiones vivas sin decidir su ciclo de vida— y el reloj sintético nuevo
    // de la barra superior NO suma, porque a propósito no es aria-live (§3.6).
    //
    // SEGUNDA ENMIENDA DELIBERADA (step 19, capacidad 1). Eran 29 y son 31:
    // `#huecos-error` (`role="alert"`) y `#huecos-recuento` (`role="status"`,
    // §3.8, punto 6) del explorador de huecos sintéticos.
    //
    // TERCERA ENMIENDA DELIBERADA (step 19, capacidad 2). Eran 31 y son 32:
    // `#lab-tareas-estado` (`role="status"`), el estado vacío del historial de
    // tareas humanas del Laboratorio (§4.3).
    //
    // CUARTA ENMIENDA DELIBERADA (step 19, capacidad 3). Eran 32 y son 36:
    // `#lab-guion-aviso`, `#lab-guion-precondicion` y `#lab-guion-progreso`
    // (`role="status"`, guion en pantalla, §5.3) y
    // `#lab-resumen-copiar-estado` (`role="status"`, resumen para Bruno, §5.2.6).
    //
    // QUINTA ENMIENDA DELIBERADA (revisión adversarial de la capacidad 3,
    // hallazgos B1 y M3/m7). Eran 36 y son 33 — una TIGHTENING, no un
    // aflojamiento: dos movimientos que se compensan y uno que resta.
    // (1) B1: "#tx-freshness" pierde `role`/`aria-live` (se repintaba con
    // CADA sondeo de 2 s — un anuncio perpetuo, justo lo que §9.4/§9.5
    // prohíben) y nace "#tx-conexion-anuncio", la ÚNICA región de conexión
    // que exige §9.5 de verdad: escribe SÓLO en la transición ok→caído y
    // caído→ok. Neto: 0 (−1 +1). (2) M3/m7: "#lab-guion-aviso" (texto
    // ESTÁTICO que nunca cambia), "#lab-guion-precondicion" y
    // "#lab-guion-progreso" (ambas repintadas en cada sondeo a partir de lo
    // que el mundo YA demuestra, nunca resultado de una acción que inicia el
    // operador) pierden su `role`/`aria-live`: ninguna de las tres cumplía
    // la regla del §9.5 ("resultado de una acción que inicia el operador").
    // Neto: −3. 36 − 3 = 33.
    //
    // SEXTA ENMIENDA DELIBERADA (step 20 §3.11, fecha 2026-08-06). Eran 33
    // y son 34: `#tx-taller-estado` (`role="status"`), la ÚNICA región viva
    // nueva del taller de decisiones con Bruno — sólo la escribe
    // `setEstadoLinea`, por suceso (filtrar, buscar con rebote de 250 ms,
    // borrar), nunca por sondeo. La línea de cobertura del mismo panel NO
    // suma, a propósito: se repinta con cada marca de radio y una región
    // viva ahí sería una segunda locución encima de la del propio radio
    // (D20-31). Las otras dos regiones que el diseño declara (+3 en total)
    // llegan con los entregables D/E (acta y borrador de misión), no con el
    // panel. La aserción sigue fijando el número EXACTO.
    //
    // SÉPTIMA ENMIENDA DELIBERADA (step 20 fase 7, §3.11 punto 5, fecha
    // 2026-08-06). Eran 34 y son 36: llegan las dos regiones anunciadas por
    // la sexta enmienda — `#tx-taller-acta-estado` y
    // `#tx-taller-mision-estado` (`role="status"`), las líneas de resultado
    // de «Copiar acta provisional» y «Preparar borrador de siguiente
    // misión», el resultado directo de una acción del operador, igual que
    // `#lab-resumen-copiar-estado`. Con esto el «+3» declarado por D20-32
    // queda completo. La aserción sigue fijando el número EXACTO.
    // (step 23 §8.2) Y son 37: llega `#actividad-operativa-estado`, la ÚNICA
    // región viva nueva de toda la misión. Anuncia una sola vez lo que acaba
    // de pasar en el ciclo de cancelaciones y nunca re-narra el histórico
    // (guarda de §10). En Lista de espera NO se añade ninguna: los resultados
    // de aprobar y de sustituir van a `#le-huecos-estado`, que ya existía.
    //
    // OCTAVA ENMIENDA DELIBERADA (step 24 §14, fecha 2026-08-10). Eran 37 y
    // son 39: las DOS del diálogo de la cita manual, `#manual-estado`
    // (`role="status"`) y `#manual-error` (`role="alert"`), exactamente el
    // mismo par que ya tiene el diálogo de la reserva para varias personas y
    // por la misma razón: un éxito se anuncia UNA vez y un conflicto se anuncia
    // como alerta, y las dos son resultado de una acción que inicia el
    // operador, nunca del sondeo. En la Agenda NO se añade ninguna: el botón
    // «Crear cita manual» no anuncia nada por sí mismo. La aserción sigue
    // fijando el número EXACTO.
    //
    // ENMIENDA (step 26 REAPERTURA §R13). Eran 39 y son 42: las TRES del
    // diálogo de detalle de una excepción — `#excepcion-error`
    // (`role="alert"`), `#excepcion-contador` y `#excepcion-exito`
    // (`role="status"`)—, el mismo trío de siempre y por la misma razón: son
    // el RESULTADO de una acción que inicia el operador (previsualizar o
    // publicar una retirada), nunca estado periódico del sondeo (§R15 A8).
    //
    // DEUDA ANOTADA, y deliberada: esas tres NO entran en
    // `REGIONES_TRANSITORIAS` en esta oleada, porque esa lista se compara
    // aquí carácter a carácter contra `TRANSITORIAS` y este fichero es
    // propiedad de otra oleada. No queda ningún mensaje rancio a la vista: el
    // diálogo limpia sus tres líneas CADA VEZ que se abre
    // (`openExcepcionDialog`), así que un texto del mundo anterior no puede
    // llegar a leerse. Añadirlas al barrido, con su prueba, queda para la
    // misión de limpieza.
    const vivas = [...html.matchAll(/role="(status|alert)"/g)];
    expect(vivas.length).toBe(42);

    await app.close();
  });

  it("el mensaje de «Cargando…» de la lista de espera NO se borra: no es transitorio, lo gobierna quien pinta la pantalla", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    expect(c.nodes["lista-espera-cargando"].hidden).toBe(true); // lo esconde renderListaEspera

    c.nodes["lista-espera-cargando"].textContent = "Cargando…";
    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());

    expect(c.nodes["lista-espera-cargando"].textContent).toBe("Cargando…");
    await app.close();
  });

  it("el orden es limpiar → cerrar → foco → repintar → anunciar: el anuncio es la ÚLTIMA mutación del turno", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    sembrarRancios(c);

    const orden: string[] = [];
    const peticiones: string[] = [];
    // El diálogo apunta cuándo se cierra; la instantánea, cuándo se repinta.
    const cerrarOriginal = c.nodes["dialogo-reset"].close.bind(c.nodes["dialogo-reset"]);
    c.nodes["dialogo-reset"].close = () => {
      orden.push("cerrar");
      cerrarOriginal();
    };
    const puente = fetchContraLaApp(app, peticiones);
    const espia = (async (url: string, init?: { method?: string }) => {
      const res = await (puente as unknown as (u: string, i?: unknown) => Promise<{ json: () => Promise<unknown> }>)(url, init);
      if (String(url).includes("/api/snapshot")) orden.push("repintar");
      return res;
    }) as unknown as typeof fetch;

    await conFetch(espia, async () => {
      await c.hooks.confirmarReinicio();
    });
    orden.push("fin");

    expect(peticiones[0]).toBe("POST /api/reset");
    expect(peticiones).toContain("GET /api/snapshot");
    expect(orden.indexOf("cerrar")).toBeLessThan(orden.indexOf("repintar"));
    // El anuncio no existe hasta después de repintar: si se hubiera escrito
    // antes, el barrido (que ocurre antes de cerrar) se lo habría llevado.
    expect(c.nodes["estado-global"].textContent).toBe(TEXTO_REINICIO);
    await app.close();
  });

  /**
   * (re-verificación de la fase 12, hallazgo n1; extendida 2026-08-06 tras
   * revisión adversarial de misión completa, hallazgo MEDIO 1). Antes de la
   * reparación de n1, `lab-tareas-estado` estaba en `REGIONES_TRANSITORIAS`:
   * el barrido la vaciaba (silencio, hidden) y, con Laboratorio activo, el
   * repintado que sigue dentro del MISMO turno (`refresh(true)`) la volvía a
   * escribir de inmediato con `renderHistorialDeTareas` — una SEGUNDA
   * locución, además de `#estado-global`, rompiendo la regla de una sola del
   * §1.3. Esa reparación (sacarla de la lista) sólo cubría el MUNDO VACÍO:
   * con el mundo POBLADO (tareas abiertas antes de reiniciar, el camino por
   * DEFECTO de una demostración con historia), la línea llega al turno
   * OCULTA —no vacía— y el mismo repintado la reescribía con contenido
   * NUEVO igualmente, el defecto MEDIO 1 que aquí se repara: la preparación
   * directa (`prepararHistorialDeTareasParaReinicio`, ver su docblock en
   * ui.js.ts) escribe el texto correcto DURANTE el barrido, por la vía
   * directa (sin `setEstadoLinea`), así que esa escritura —igual que la de
   * `huecos-gate`, ya excluida más arriba— ocurre ANTES de que el diálogo se
   * cierre, no «después» del reinicio: se comprueban las escrituras que
   * cuentan como locución **después** de que el diálogo se cierra, el mismo
   * punto de corte que ya usa la prueba «el orden es limpiar → cerrar →
   * foco → repintar → anunciar», más arriba.
   */
  describe.each([
    ["con el mundo VACÍO (n1)", false],
    ["con el mundo POBLADO — tareas abiertas antes de reiniciar (MEDIO 1)", true],
  ] as const)("un turno de reinicio con Laboratorio activo escribe UNA sola región viva %s", (_titulo, poblado) => {
    it("lab-tareas-estado no repite el anuncio del reinicio", async () => {
      const app = freshApp();
      if (poblado) {
        // Cancelar una cita sintética abre DOS tareas de verdad (revisión
        // tardía + decidir a quién se ofrece el hueco): el mundo POBLADO que
        // este caso necesita, con el mismo camino ya usado más arriba
        // (`sembrarRancios`) para dejar el mundo con historia.
        const cancelacion = await app.inject({
          method: "POST",
          url: "/api/reservations/demo-salon-res-1/cancel",
          payload: { reasonCode: "unspecified", confirmed: true },
          headers: { "Idempotency-Key": "cancel-mundo-poblado-medio-1" },
        });
        expect(cancelacion.statusCode).toBe(200);
      }
      const c = await montarConsolaEnLaboratorio(app);

      if (poblado) {
        // Con tareas abiertas y el filtro por defecto ("Pendientes") que sí
        // las enseña, la línea de estado nace OCULTA — no hace falta decir
        // nada — que es justo el punto de partida distinto de n1.
        expect(c.nodes["lab-tareas-estado"]!.hidden).toBe(true);
      } else {
        // Sin tareas, el montaje inicial ya deja el estado vacío honesto.
        expect(c.nodes["lab-tareas-estado"]!.textContent).toBe("Todavía no hay ninguna tarea para una persona.");
        expect(c.nodes["lab-tareas-estado"]!.hidden).toBe(false);
      }

      const idsVivos = [
        ...TRANSITORIAS.filter((id) => id !== "huecos-gate" && id !== "reset-estado"),
        "estado-global",
        "lab-tareas-estado",
      ];
      const escrituras = instrumentarEscrituras(c.nodes, idsVivos);
      let indiceTrasCerrar = -1;
      const dialogo = c.nodes["dialogo-reset"];
      const cerrarOriginal = dialogo.close.bind(dialogo);
      dialogo.close = () => {
        indiceTrasCerrar = escrituras.length;
        cerrarOriginal();
      };

      await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());
      expect(indiceTrasCerrar).toBeGreaterThanOrEqual(0);

      // Vaciar una línea (el barrido silencioso) no narra nada; una
      // escritura ANTES de que el diálogo se cierre tampoco (mismo criterio
      // que ya exime a huecos-gate y reset-estado): sólo cuenta como
      // locución del turno una escritura DESPUÉS de cerrar que deja
      // contenido visible.
      const narradas = escrituras.slice(indiceTrasCerrar).filter((e) => e.texto !== "");
      const idsNarrados = [...new Set(narradas.map((e) => e.id))];
      expect(idsNarrados).toEqual(["estado-global"]);
      expect(c.nodes["estado-global"]!.textContent).toBe(TEXTO_REINICIO);
      // La línea del historial de tareas queda correcta, y visible, en los
      // dos casos: el reinicio vacía el libro siempre.
      expect(c.nodes["lab-tareas-estado"]!.textContent).toBe("Todavía no hay ninguna tarea para una persona.");
      expect(c.nodes["lab-tareas-estado"]!.hidden).toBe(false);

      await app.close();
    });
  });
});

// =====================================================================
// (b) Reinicio → navegación
// =====================================================================

describe("consola · step 18 §1.4 — el anuncio no se queda pegado a la pantalla siguiente", () => {
  it("tras reiniciar, navegar a Agenda deja `#estado-global` vacía y oculta", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());
    expect(c.nodes["estado-global"].textContent).toBe(TEXTO_REINICIO);

    c.win.location.hash = "#/agenda";
    c.hooks.applyRoute();

    expect(c.nodes["estado-global"].textContent).toBe("");
    expect(c.nodes["estado-global"].hidden).toBe(true);
    await app.close();
  });

  it("abrir el diálogo de reinicio limpia su propia línea de estado en vez de escribir un vacío", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    c.hooks.setEstadoLinea(c.nodes["reset-estado"], TEXTO_RECHAZADO, "error");

    c.hooks.abrirDialogoReset();

    expect(c.nodes["reset-estado"].textContent).toBe("");
    expect(c.nodes["reset-estado"].hidden).toBe(true);
    expect(c.nodes["reset-estado"].className).not.toContain("tx-status-line--error");
    expect(c.nodes["dialogo-reset"].open).toBe(true);
    await app.close();
  });
});

// =====================================================================
// (c) Reinicio → instantánea fresca
// =====================================================================

describe("consola · step 18 §1.5 — después del reinicio, la pantalla enseña el mundo de partida", () => {
  it("seis entradas pendientes, plazo de 120 minutos, ni una cancelación, y el reloj sintético en 09:00", async () => {
    const app = freshApp();
    const c = await montarConsola(app);

    // Se ensucia el mundo de verdad: una cancelación y una entrada nueva.
    await app.inject({
      method: "POST",
      url: "/api/reservations/demo-salon-res-1/cancel",
      payload: { reasonCode: "unspecified", confirmed: true },
      headers: { "Idempotency-Key": "cancel-antes-del-reinicio" },
    });
    const sucia = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      waitlist: { cancellations: unknown[]; entries: unknown[] };
    };
    expect(sucia.waitlist.cancellations.length).toBe(1);

    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());

    const limpia = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      engineToday: string;
      engineNowMinutes: number;
      waitlist: {
        cancellations: unknown[];
        releasedSlots: unknown[];
        entries: ReadonlyArray<{ state: string }>;
        policy: { cancellationNoticeMinutes: number };
      };
    };
    expect(limpia.engineToday).toBe(BOOKING_DEMO_TODAY);
    expect(limpia.engineNowMinutes).toBe(BOOKING_DEMO_NOW_MINUTES);
    expect(limpia.waitlist.entries.length).toBe(6);
    expect(limpia.waitlist.entries.every((e) => e.state === "pending")).toBe(true);
    expect(limpia.waitlist.cancellations.length).toBe(0);
    expect(limpia.waitlist.releasedSlots.length).toBe(0);
    expect(limpia.waitlist.policy.cancellationNoticeMinutes).toBe(120);

    // Y la PANTALLA, repintada por la propia secuencia de reinicio, dice lo
    // mismo: seis filas de personas y ningún hueco liberado.
    expect(c.nodes["le-personas-tbody"].children.length).toBe(6);
    expect(c.nodes["le-huecos-lista"].children.length).toBe(0);
    await app.close();
  });
});

// =====================================================================
// (d) El camino de fallo
// =====================================================================

describe("consola · step 18 §1.3 — un reinicio que falla no borra nada y lo dice", () => {
  it("un 500 con cuerpo JSON válido NO cuenta como éxito: el diálogo sigue abierto y las regiones intactas", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    sembrarRancios(c);
    const antes = TRANSITORIAS.map((id) => c.nodes[id].textContent);
    c.hooks.abrirDialogoReset();

    const quinientos = (() =>
      Promise.resolve({
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: () => Promise.resolve({ error: "el motor ha dicho que no" }),
      })) as unknown as typeof fetch;
    await conFetch(quinientos, () => c.hooks.confirmarReinicio());

    expect(c.nodes["reset-estado"].textContent).toBe(TEXTO_RECHAZADO);
    expect(c.nodes["reset-estado"].className).toContain("tx-status-line--error");
    expect(c.nodes["dialogo-reset"].open).toBe(true);
    expect(c.nodes["estado-global"].textContent).toBe("");
    expect(c.nodes["estado-global"].hidden).toBe(true);
    expect(c.nodes["reset-confirmar"].disabled).toBe(false);
    expect(c.document.activeElement).toBe(c.nodes["reset-confirmar"]);
    expect(TRANSITORIAS.filter((id) => id !== "reset-estado").map((id) => c.nodes[id].textContent)).toEqual(
      antes.filter((_, i) => TRANSITORIAS[i] !== "reset-estado"),
    );
    await app.close();
  });

  it("sin conexión con el motor: el texto dice que no se ha borrado nada, y es verdad", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    sembrarRancios(c);
    c.hooks.abrirDialogoReset();

    const caido = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    await conFetch(caido, () => c.hooks.confirmarReinicio());

    expect(c.nodes["reset-estado"].textContent).toBe(TEXTO_SIN_CONEXION);
    expect(c.nodes["dialogo-reset"].open).toBe(true);
    expect(c.nodes["estado-global"].textContent).toBe("");
    expect(c.nodes["convertir-estado"].textContent).toBe("Creando la reserva…");

    // Y el servidor, efectivamente, no ha reiniciado nada: se comprueba
    // contra el mundo REAL, no contra la pantalla.
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      waitlist: { entries: ReadonlyArray<{ state: string }> };
    };
    expect(snap.waitlist.entries.length).toBe(6);
    await app.close();
  });

  it("tras un fallo, el botón vuelve a estar disponible y un reintento con éxito sí reinicia", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    sembrarRancios(c);
    c.hooks.abrirDialogoReset();

    const caido = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    await conFetch(caido, () => c.hooks.confirmarReinicio());
    expect(c.nodes["reset-confirmar"].disabled).toBe(false);

    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());
    expect(c.nodes["estado-global"].textContent).toBe(TEXTO_REINICIO);
    expect(c.nodes["convertir-estado"].textContent).toBe("");
    await app.close();
  });
});

// =====================================================================
// (e) No-mudez (criterios 8.36 y 8.37)
// =====================================================================

describe("consola · step 18 §8 bis — ninguna región queda muda ni pierde su tono tras un reinicio", () => {
  it("las OCHO regiones migradas vuelven a verse en cuanto tienen algo que decir (8.36)", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    sembrarRancios(c);
    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());

    const ochoDeLaMigracion = [
      "llamada-copiar-estado",
      "lab-escenario-estado",
      "dia-especial-paso1-error",
      "dia-especial-contador",
      "dia-especial-exito",
      "ausencia-paso1-error",
      "ausencia-contador",
      "ausencia-exito",
    ];
    for (const id of ochoDeLaMigracion) {
      expect(c.nodes[id].hidden, `${id} tendría que estar oculta tras el barrido`).toBe(true);
      c.hooks.setEstadoLinea(c.nodes[id], "Algo que decir.", "");
      expect(c.nodes[id].textContent).toBe("Algo que decir.");
      expect(c.nodes[id].hidden, `${id} se ha quedado MUDA después del reinicio`).toBe(false);
    }
    await app.close();
  });

  // ENMIENDA DELIBERADA (fase G de step 18). Eran seis y son siete: el
  // `role="alert"` del diálogo de grupo (`grupo-error`) también nace con su
  // clase de tono ESTÁTICA en el HTML servido, así que entra en esta tabla
  // por el mismo motivo que las otras seis. La aserción no se debilita: sigue
  // comparando el conjunto EXACTO de `TONO_BASE`, y sigue exigiendo que el
  // HTML servido declare cada tono con la cadena literal completa.
  it("el tono estático de las siete regiones que nacen con clase sobrevive al barrido (8.37)", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    const conTonoEstatico: ReadonlyArray<readonly [string, string]> = [
      ["dia-especial-paso1-error", "error"],
      ["dia-especial-exito", "ok"],
      ["ausencia-paso1-error", "error"],
      ["ausencia-exito", "ok"],
      ["cancelar-cita-error", "error"],
      ["alta-lista-error", "error"],
      ["grupo-error", "error"],
    ];
    // El HTML servido es quien lo declara: la tabla del cliente no se lo
    // inventa.
    const html = renderConsoleHtml();
    for (const [id, tono] of conTonoEstatico) {
      expect(html).toContain(`class="tx-status-line tx-status-line--${tono}" id="${id}"`);
      expect(c.hooks.TONO_BASE[id]).toBe(tono);
    }
    expect(Object.keys(c.hooks.TONO_BASE).sort()).toEqual(conTonoEstatico.map(([id]) => id).sort());

    sembrarRancios(c);
    await conFetch(fetchContraLaApp(app), () => c.hooks.confirmarReinicio());

    for (const [id, tono] of conTonoEstatico) {
      expect(c.nodes[id].className, `${id} ha perdido su tono de base`).toContain(`tx-status-line--${tono}`);
      // Y el texto que se escriba después sale con ese tono, sin pedirlo.
      c.hooks.setEstadoLinea(c.nodes[id], "Texto nuevo.", "");
      expect(c.nodes[id].className).toContain(`tx-status-line--${tono}`);
      expect(c.nodes[id].hidden).toBe(false);
    }
    await app.close();
  });

  it("`setEstadoLinea` usa classList y no `className`: `tx-col-12` sobrevive (8.7, causa 4 del §1.0)", async () => {
    const app = freshApp();
    const c = await montarConsola(app);
    const linea = c.nodes["inicio-ruta-desconocida"];
    linea.className = "tx-status-line tx-col-12";

    c.hooks.setEstadoLinea(linea, "Esa página no existe.", "error");
    expect(linea.className).toContain("tx-col-12");
    c.hooks.limpiarLinea(linea);
    expect(linea.className).toContain("tx-col-12");
    expect(linea.className).toContain("tx-status-line");
    expect(linea.className).not.toContain("tx-status-line--error");
    await app.close();
  });

  it("ni el cliente ni la hoja de estilo dejan una línea oculta sin caja donde hoy la hay", () => {
    // (enmienda de fase D, N2) `[hidden] { display: none !important }` haría
    // saltar los botones de los diálogos: una línea de estado vacía conserva
    // su caja y pierde sólo la visibilidad. Las tres excepciones son líneas
    // cuyo `hidden` significa "no va en esta pantalla".
    expect(CONSOLE_CSS).toContain(".tx-status-line[hidden] { display: block !important; visibility: hidden; }");
    expect(CONSOLE_CSS).toContain("#estado-global[hidden] { display: none !important; }");
    expect(CONSOLE_CSS).not.toContain(".tx-status-line:empty");
  });

  it("no queda ni una escritura pelada de `textContent` ni una asignación de `className` sobre una región transitoria", async () => {
    const { readFileSync } = await import("node:fs");
    const fuente = readFileSync(new URL("../../src/console/ui.js.ts", import.meta.url), "utf8");
    for (const id of TRANSITORIAS) {
      const pelada = new RegExp(`byId\\('${id}'\\)\\.textContent\\s*=`);
      expect(fuente, `queda un escritor pelado sobre #${id}`).not.toMatch(pelada);
    }
    // La única asignación de `className` que queda en el fichero es la del
    // ayudante genérico `el()` y las de filas/celdas de tablas: ninguna sobre
    // una línea de estado.
    expect(fuente).not.toMatch(/className\s*=\s*'tx-status-line/);
  });
});

// =====================================================================
// (f) `scenarioCounter` (§1.6)
// =====================================================================

describe("consola · step 18 §1.6 — el contador de escenarios vuelve a cero", () => {
  async function correrEscenario(app: FastifyInstance, scenarioId: string): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: { scenarioId, turns: [{ utterance: "quiero cita el miércoles a las diez", day: "wednesday", time: "10:00" }] },
    });
    expect(res.statusCode).toBe(200);
  }

  async function hashesDeLlamadas(app: FastifyInstance): Promise<string[]> {
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      calls: ReadonlyArray<{ callIdHash: string }>;
    };
    return snap.calls.map((c) => c.callIdHash);
  }

  it("dos escenarios, un reinicio y otro escenario: el tercero vuelve a ser `console-call-1`", async () => {
    const app = freshApp();
    await correrEscenario(app, "A80-primero");
    await correrEscenario(app, "A80-segundo");
    const antes = await hashesDeLlamadas(app);
    expect(antes.length).toBe(2);
    // `callId` no viaja nunca en claro (sólo su hash salado), así que la
    // identidad se comprueba por el hash: mismo `callId`, mismo hash.
    const [hashUno, hashDos] = antes;
    expect(hashUno).not.toBe(hashDos);

    const reset = await app.inject({ method: "POST", url: "/api/reset" });
    expect(reset.statusCode).toBe(200);
    expect(await hashesDeLlamadas(app)).toEqual([]);

    await correrEscenario(app, "A80-tercero");
    const despues = await hashesDeLlamadas(app);
    expect(despues.length).toBe(1);
    expect(despues[0], "el primer escenario tras un reinicio ya no se llama console-call-1").toBe(hashUno);
    expect(despues[0]).not.toBe(hashDos);
    await app.close();
  });

  it("dos reinicios seguidos dejan el mismo estado: `POST /api/reset` sigue siendo idempotente", async () => {
    const app = freshApp();
    await correrEscenario(app, "A80-uno");
    await app.inject({ method: "POST", url: "/api/reset" });
    const unaVez = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as Record<string, unknown>;
    await app.inject({ method: "POST", url: "/api/reset" });
    const dosVeces = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as Record<string, unknown>;
    delete unaVez["generatedAt"];
    delete dosVeces["generatedAt"];
    expect(JSON.stringify(dosVeces)).toBe(JSON.stringify(unaVez));
    await app.close();
  });
});
