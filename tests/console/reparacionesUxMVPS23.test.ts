import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { WAITLIST_COPY } from "../../src/console/waitlistSnapshot.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeElement, type FakeDocument } from "./fakeDom.js";

/**
 * REPARACIONES DE UX POSTERIORES A step 23 — las regresiones de los siete
 * defectos que la auditoría manual encontró sobre el bucle humano ya
 * terminado.
 *
 * QUÉ NO CAMBIA, y por eso no se prueba aquí de nuevo: la máquina de estados.
 * `take_over_proposal` sigue sustituyendo Y aprobando en el mismo acto, la
 * aprobación sigue siendo idempotente, el aviso sigue siendo un acto humano
 * aparte y los dos huecos hermanos siguen siendo independientes. Todo eso lo
 * firman `waitlistStateMachine.test.ts`, `waitlistApi.test.ts` y
 * `competenciaPorElHueco.test.ts`, y ni una de sus aserciones se ha tocado.
 * Lo que se repara —y lo que se prueba aquí— es lo que la pantalla DICE.
 *
 * LO QUE ESTAS PRUEBAS NO FIRMAN, igual que el resto de la suite de consola:
 * teclado real, foco nativo del `<dialog>`, Escape, anchuras, zoom, Reduce
 * Motion, VoiceOver y WebKit. Eso sólo lo puede firmar el runbook del Mac en
 * un navegador de verdad, y en el runbook queda anotado lo que se ejecutó y
 * lo que se dejó PENDIENTE.
 */

const TEST_SALT = "reparaciones-ux-mvps23-salt";

type Json = Record<string, unknown>;

/** Los dos identificadores internos que la auditoría vio en pantalla. */
const IDENTIFICADORES_PROHIBIDOS = ["approve_proposal", "take_over_proposal"] as const;

const HUECO_1300 = "slot-2026-08-04-780-3";
const HUECO_1330 = "slot-2026-08-04-810-3";

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

async function comando(app: FastifyInstance, entryId: string, command: string, slotKey?: string) {
  const cuerpo = slotKey === undefined ? { command } : { command, slotKey };
  const res = await post(app, `/api/waitlist/entries/${entryId}/command`, cuerpo);
  expect(res.statusCode, `${command} sobre ${entryId}`).toBe(200);
  return res;
}

function waitlistDe(snap: Json): Json {
  return snap.waitlist as Json;
}

function huecoDe(snap: Json, key: string): Json {
  const slot = (waitlistDe(snap).releasedSlots as Json[]).find((s) => s.key === key);
  expect(slot, `no existe el hueco ${key}`).toBeDefined();
  return slot as Json;
}

function propuestaDe(snap: Json, key: string): Json {
  const p = huecoDe(snap, key).proposal;
  expect(p, `el hueco ${key} no tiene propuesta`).not.toBeNull();
  return p as Json;
}

// ---------------------------------------------------------------------
// DOM falso: los mismos contenedores que `renderListaEspera()` busca
// ---------------------------------------------------------------------

const LISTA_ESPERA_IDS = [
  "lista-espera-cargando",
  "lista-espera-integridad",
  "lista-espera-integridad-detalle",
  "le-huecos-contador",
  { id: "le-huecos-lista", tag: "div" },
  "le-huecos-orden",
  "le-huecos-vacio",
  "le-huecos-estado",
  "le-bloque-tardias",
  "le-tardias-contador",
  { id: "le-tardias-lista", tag: "div" },
  "le-personas-contador",
  "le-personas-vacio",
  "le-personas-vacio-filtro",
  "le-personas-estado",
  { id: "le-personas-tbody", tag: "tbody" },
  { id: "le-plazo-select", tag: "select" },
  "le-plazo-frase",
  "le-plazo-demo",
  { id: "le-cifras", tag: "dl" },
  "le-tecnico-historial-contador",
  { id: "le-tecnico-historial", tag: "ul" },
] as const;

function documentoListaEspera(): { document: FakeDocument; nodes: Record<string, FakeElement> } {
  const { document, nodes } = createFakeDocumentWithIds([...LISTA_ESPERA_IDS]);
  const details = document.createElement("details");
  const body = document.createElement("div");
  details.appendChild(body);
  body.appendChild(nodes["le-tecnico-historial-contador"] as FakeElement);
  body.appendChild(nodes["le-tecnico-historial"] as FakeElement);
  return { document, nodes };
}

/** La pantalla entera por el camino de verdad, con `refresh()` real. */
async function cargarPantalla(snap: Json) {
  const { document, nodes } = createFakeDocumentWithIds([
    ...LISTA_ESPERA_IDS,
    "tx-view-title",
    "tx-freshness",
    "inicio-ruta-desconocida",
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

/**
 * Un `fetch` que habla con el servidor REAL: los POST llevan el cuerpo que
 * compone la pantalla (así lo valida el esquema de verdad, no uno inventado)
 * y los GET devuelven la instantánea de verdad, para que el repintado que
 * sigue a un comando sea el que un navegador haría.
 */
function conectarFetchReal(app: FastifyInstance): { enviados: { url: string; body: Json }[]; restore: () => void } {
  const enviados: { url: string; body: Json }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    if (init === undefined || init.method === undefined || init.method === "GET") {
      const res = await app.inject({ method: "GET", url });
      return { ok: res.statusCode < 400, status: res.statusCode, json: () => Promise.resolve(res.json()) };
    }
    const cuerpo = init.body === undefined ? {} : (JSON.parse(init.body) as Json);
    enviados.push({ url, body: cuerpo });
    const res = await post(app, url, cuerpo);
    return { ok: res.statusCode < 400, status: res.statusCode, json: () => Promise.resolve(res.json()) };
  }) as unknown as typeof fetch;
  return { enviados, restore: () => { globalThis.fetch = original; } };
}

function walk(node: FakeElement, visit: (n: FakeElement) => void): void {
  visit(node);
  for (const child of node.children) walk(child as FakeElement, visit);
}

function todoElTexto(raiz: FakeElement): string {
  const textos: string[] = [];
  walk(raiz, (n) => {
    if (n.children.length === 0 && n.textContent.length > 0) textos.push(n.textContent);
  });
  return textos.join("\n");
}

function todos(raiz: FakeElement, predicado: (n: FakeElement) => boolean): FakeElement[] {
  const lista: FakeElement[] = [];
  walk(raiz, (n) => {
    if (predicado(n)) lista.push(n);
  });
  return lista;
}

function buscar(raiz: FakeElement, predicado: (n: FakeElement) => boolean): FakeElement | null {
  const encontrados = todos(raiz, predicado);
  return encontrados.length === 0 ? null : (encontrados[0] as FakeElement);
}

function botonPorTexto(raiz: FakeElement, texto: string): FakeElement {
  const boton = buscar(raiz, (n) => n.tagName === "BUTTON" && n.textContent === texto);
  expect(boton, `no hay ningún botón que diga "${texto}"`).not.toBeNull();
  return boton as FakeElement;
}

function tarjetaDe(snap: Json, indice = 0): FakeElement {
  const { document, nodes } = documentoListaEspera();
  loadUiClientHooks("", document).renderListaEspera(snap);
  return (nodes["le-huecos-lista"] as FakeElement).children[indice] as FakeElement;
}

// ---------------------------------------------------------------------
// Las instantáneas de los seis peldaños, todas del servidor de verdad
// ---------------------------------------------------------------------

let snapPendiente: Json;
let snapAprobada: Json;
let snapSustituida: Json;
let snapAvisada: Json;
let snapAceptada: Json;
let snapConvertida: Json;

beforeAll(async () => {
  const apps: FastifyInstance[] = [];

  const paso = async (hasta: "pendiente" | "aprobada" | "sustituida" | "avisada" | "aceptada" | "convertida") => {
    const app = freshApp();
    apps.push(app);
    await post(app, "/api/reset", {});
    expect((await cancel(app, "demo-salon-res-2")).statusCode).toBe(200);
    if (hasta === "pendiente") return snapshotOf(app);
    if (hasta === "sustituida") {
      await comando(app, "wl-f02", "take_over_proposal", HUECO_1300);
      return snapshotOf(app);
    }
    await comando(app, "wl-f01", "approve_proposal", HUECO_1300);
    if (hasta === "aprobada") return snapshotOf(app);
    await comando(app, "wl-f01", "simulate_notice");
    if (hasta === "avisada") return snapshotOf(app);
    await comando(app, "wl-f01", "record_acceptance");
    if (hasta === "aceptada") return snapshotOf(app);
    const conv = await post(
      app,
      "/api/waitlist/entries/wl-f01/convert",
      { slotKey: HUECO_1300, confirmed: true },
      { "idempotency-key": "reparaciones-ux-convert-f01" },
    );
    expect(conv.statusCode).toBe(200);
    return snapshotOf(app);
  };

  snapPendiente = await paso("pendiente");
  snapAprobada = await paso("aprobada");
  snapSustituida = await paso("sustituida");
  snapAvisada = await paso("avisada");
  snapAceptada = await paso("aceptada");
  snapConvertida = await paso("convertida");
  for (const a of apps) await a.close();
});

// =====================================================================
// DEFECTO 1 — ni un identificador interno en una superficie humana
// =====================================================================

describe("Reparación R2-UX · defecto 1 — el vocabulario humano es CERRADO y en castellano", () => {
  it("la prueba no es vacía: el servidor SÍ publica los dos comandos, y por eso hacía falta cerrar la pantalla", () => {
    const entradas = waitlistDe(snapPendiente).entries as Json[];
    const expuestas = entradas.filter((e) =>
      (e.availableCommands as string[]).some((c) => (IDENTIFICADORES_PROHIBIDOS as readonly string[]).includes(c)),
    );
    expect(expuestas.length).toBeGreaterThan(0);
  });

  it("ninguna instantánea del ciclo los pinta en la pantalla de Lista de espera", () => {
    for (const [nombre, snap] of Object.entries({
      snapPendiente,
      snapAprobada,
      snapSustituida,
      snapAvisada,
      snapAceptada,
      snapConvertida,
    })) {
      const { document, nodes } = documentoListaEspera();
      loadUiClientHooks("", document).renderListaEspera(snap);
      for (const id of ["le-huecos-lista", "le-personas-tbody", "le-tecnico-historial"]) {
        const texto = todoElTexto(nodes[id] as FakeElement);
        for (const prohibido of IDENTIFICADORES_PROHIBIDOS) {
          expect(texto, `${prohibido} visible en ${id} con ${nombre}`).not.toContain(prohibido);
        }
      }
    }
  });

  it("la columna «Qué puedes hacer» sólo pinta acciones con nombre en castellano — y pinta alguna", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera, COMANDO_ETIQUETAS } = loadUiClientHooks("", document);
    renderListaEspera(snapPendiente);
    const conocidos = new Set<string>(Object.values(COMANDO_ETIQUETAS as Record<string, string>));
    let botones = 0;
    for (const fila of (nodes["le-personas-tbody"] as FakeElement).children as FakeElement[]) {
      for (const boton of (fila.children[4] as FakeElement).children as FakeElement[]) {
        botones += 1;
        expect(conocidos.has(boton.textContent), boton.textContent).toBe(true);
        // Y nada con forma de identificador: minúsculas unidas por guion bajo.
        expect(boton.textContent).not.toMatch(/^[a-z]+(_[a-z]+)+$/);
      }
    }
    expect(botones).toBeGreaterThan(0);
  });

  it("un comando que esta pantalla no conoce se RETIRA, nunca se pinta con su nombre crudo", () => {
    const { document } = documentoListaEspera();
    const { accionesHumanasDe, COMANDOS_DE_HUECO } = loadUiClientHooks("", document);
    expect([...(COMANDOS_DE_HUECO as string[])].sort()).toEqual([...IDENTIFICADORES_PROHIBIDOS].sort());
    expect(
      accionesHumanasDe(["withdraw", "approve_proposal", "take_over_proposal", "un_comando_del_futuro", "convert"]),
    ).toEqual(["withdraw", "convert"]);
    // Y sin lista, no revienta ni inventa nada.
    expect(accionesHumanasDe(undefined)).toEqual([]);
  });

  it("el HTML servido tampoco los lleva", () => {
    const html = renderConsoleHtml();
    for (const prohibido of IDENTIFICADORES_PROHIBIDOS) expect(html).not.toContain(prohibido);
  });

  it("y ninguna frase que el servidor manda a una superficie humana los lleva dentro", () => {
    for (const frase of Object.values(WAITLIST_COPY)) {
      for (const prohibido of IDENTIFICADORES_PROHIBIDOS) expect(frase).not.toContain(prohibido);
    }
    for (const snap of [snapPendiente, snapAprobada, snapSustituida, snapAvisada, snapAceptada, snapConvertida]) {
      const p = propuestaDe(snap, HUECO_1300);
      for (const campo of ["statusLabel", "reasonLabel", "stageNote", "substitutionNote"]) {
        for (const prohibido of IDENTIFICADORES_PROHIBIDOS) {
          expect(String(p[campo] ?? ""), campo).not.toContain(prohibido);
        }
      }
    }
    // Y tampoco el rastro operativo, que es lo que Bruno lee en Inicio.
    for (const item of (waitlistDe(snapSustituida).activity as { items: Json[] }).items) {
      for (const prohibido of IDENTIFICADORES_PROHIBIDOS) {
        expect(String(item.title)).not.toContain(prohibido);
        expect(String(item.reason)).not.toContain(prohibido);
        expect(String(item.statusLabel)).not.toContain(prohibido);
      }
    }
  });
});

// =====================================================================
// DEFECTO 2 — la ventana de disponibilidad NO es la duración del servicio
// =====================================================================

describe("Reparación R2-UX · defecto 2 — duración y ventana son dos hechos distintos", () => {
  it("un servicio de 30 min dentro de una ventana de 60 se lee como tal, y no como una cita de una hora", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    const res = await post(app, "/api/waitlist/entries", {
      clientLabel: "Cliente Z",
      serviceId: 1,
      dateFrom: "2026-08-04",
      dateTo: "2026-08-04",
      earliestStartMinutes: 780, // 13:00
      latestStartMinutes: 840, //  14:00
      professional: { kind: "any" },
      optInSource: "phone_simulated",
      optInConfirmed: true,
    });
    expect(res.statusCode).toBe(201);
    const entry = (res.json() as Json).entry as Json;

    expect(entry.serviceLabel).toBe("Corte de pelo");
    expect(entry.serviceDurationLabel).toBe("30 min");
    expect(entry.availabilityWindowLabel).toBe("Disponible entre las 13:00 y las 14:00");
    expect(entry.professionalLabel).toBe("Cualquier profesional");
    expect(entry.preferenceSummary).toBe(
      "Corte de pelo (30 min) · el martes 4 de agosto · Disponible entre las 13:00 y las 14:00 · Cualquier profesional",
    );
    // Las tres formas exactas que la auditoría manual leyó como una hora de cita.
    expect(entry.preferenceSummary).not.toContain("de 13:00 a 14:00");
    expect(entry.preferenceSummary).not.toContain("con quien sea");
    expect(entry.preferenceSummary).not.toContain("13:00-14:00");
    await app.close();
  });

  it("y la ventana de verdad sigue admitiendo DOS medias horas independientes: la redacción no cambió la regla", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    const snap = await snapshotOf(app);
    // Cliente A pidió 13:00-14:00 para un corte de 30 min: encaja en las dos
    // mitades, que es exactamente lo que la frase antigua escondía.
    for (const clave of [HUECO_1300, HUECO_1330]) {
      expect(huecoDe(snap, clave).compatibleEntryIds, clave).toContain("wl-f01");
    }
    await app.close();
  });

  it("la tarjeta del hueco enseña la ventana con el verbo de disponibilidad, no con el de un intervalo de cita", () => {
    const texto = todoElTexto(tarjetaDe(snapPendiente));
    expect(texto).toContain("Disponible entre las 13:00 y las 14:00");
    expect(texto).toContain("Corte de pelo (30 min)");
    expect(texto).toContain("Cualquier profesional");
    expect(texto).not.toContain("de 13:00 a 14:00");
    expect(texto).not.toContain("con quien sea");
  });
});

// =====================================================================
// DEFECTO 4 — la copia depende del estado real, y no repite una aprobación
// =====================================================================

describe("Reparación R2-UX · defecto 4 — después de aprobar, nadie vuelve a pedir que se apruebe", () => {
  const PELDAÑOS: readonly [string, () => Json, string][] = [
    ["pending_approval", () => snapPendiente, HUECO_1300],
    ["approved", () => snapAprobada, HUECO_1300],
    ["substituted", () => snapSustituida, HUECO_1300],
    ["notice_simulated", () => snapAvisada, HUECO_1300],
    ["accepted", () => snapAceptada, HUECO_1300],
    ["converted", () => snapConvertida, HUECO_1300],
  ];

  it("cada peldaño llega con su propia frase de «qué falta», y no hay dos iguales", () => {
    const vistas = new Map<string, string>();
    for (const [codigo, snap, hueco] of PELDAÑOS) {
      const p = propuestaDe(snap(), hueco);
      expect(p.statusCode, `${codigo}`).toBe(codigo);
      expect(typeof p.stageNote, codigo).toBe("string");
      expect(String(p.stageNote).length, codigo).toBeGreaterThan(0);
      vistas.set(codigo, String(p.stageNote));
    }
    // `approved` y `substituted` comparten el resto de la frase pero no la
    // cabecera: la segunda dice que la eligió el operador.
    expect(new Set(vistas.values()).size).toBe(vistas.size);
  });

  it("sólo el PRIMER peldaño dice que falta aprobar; ninguno de los siguientes lo repite", () => {
    expect(String(propuestaDe(snapPendiente, HUECO_1300).stageNote)).toBe(WAITLIST_COPY.proposalIsSuggestion);
    for (const [codigo, snap, hueco] of PELDAÑOS.slice(1)) {
      const nota = String(propuestaDe(snap(), hueco).stageNote);
      expect(nota.toLowerCase(), codigo).not.toContain("hasta que una persona lo apruebe");
      expect(nota.toLowerCase(), codigo).not.toContain("falta que una persona apruebe");
    }
  });

  it("en pantalla, la píldora «Aprobada» y el texto de al lado ya no se contradicen", () => {
    const texto = todoElTexto(tarjetaDe(snapAprobada));
    expect(texto).toContain("Aprobada — pendiente de avisar");
    expect(texto).toContain(WAITLIST_COPY.approvalEffectsAfter);
    // La contradicción exacta que encontró la auditoría manual.
    expect(texto).not.toContain(WAITLIST_COPY.proposalIsSuggestion);
    expect(texto).not.toContain("hasta que una persona lo apruebe y avise");
  });

  it("lo mismo tras sustituir: la píldora dice que la eligió el operador y el texto no vuelve a pedir aprobación", () => {
    const texto = todoElTexto(tarjetaDe(snapSustituida));
    expect(texto).toContain("Aprobada — elegida por el operador");
    expect(texto).toContain(WAITLIST_COPY.approvalEffectsAfter);
    expect(texto).not.toContain(WAITLIST_COPY.proposalIsSuggestion);
  });

  it("tras avisar, tras aceptar y tras reservar, la frase la lleva el contrato — la tarjeta ya no está para decirla", () => {
    // POR QUÉ NO SE COMPRUEBA EN PANTALLA: la tarjeta del bloque 1 sólo
    // existe mientras el hueco espera una decisión, y desde que alguien es
    // avisado deja de esperarla (`decisionPending` pasa a false, §8.3). A
    // partir de ahí la historia la cuenta la fila de «Personas apuntadas» y
    // el rastro. Comprobarlo aquí sobre una tarjeta que no se pinta sería
    // firmar una pantalla que nadie ve; se comprueba lo que SÍ es verdad: que
    // la tarjeta desaparece, y que el contrato sigue diciendo qué falta.
    for (const [snap, codigo] of [
      [snapAvisada, "notice_simulated"],
      [snapAceptada, "accepted"],
      [snapConvertida, "converted"],
    ] as const) {
      expect(huecoDe(snap, HUECO_1300).decisionPending, codigo).toBe(false);
      const { document, nodes } = documentoListaEspera();
      loadUiClientHooks("", document).renderListaEspera(snap);
      const claves = ((nodes["le-huecos-lista"] as FakeElement).children as FakeElement[]).map((c) =>
        c.getAttribute("data-key"),
      );
      expect(claves, codigo).not.toContain(HUECO_1300);
    }

    expect(String(propuestaDe(snapAvisada, HUECO_1300).stageNote)).toContain(
      "no se ha enviado ningún mensaje ni se ha llamado a nadie",
    );
    expect(String(propuestaDe(snapAceptada, HUECO_1300).stageNote)).toContain("Todavía no existe ninguna reserva");
    expect(String(propuestaDe(snapConvertida, HUECO_1300).stageNote)).toContain("El ciclo de este hueco está cerrado");
  });
});

// =====================================================================
// DEFECTOS 3, 5, 6 y 7 — sustituir es deliberado, previsualizado y confirmado
// =====================================================================

describe("Reparación R2-UX · defectos 5 y 6 — sustituir se anuncia antes de hacerse", () => {
  it("el destinatario actual va ROTULADO, y las alternativas dicen que NO lo son", () => {
    const card = tarjetaDe(snapPendiente);
    const texto = todoElTexto(card);
    expect(texto).toContain(WAITLIST_COPY.currentRecipientHeading);
    expect(texto).toContain(WAITLIST_COPY.alternativesAreNotCurrent);
    // Y el nombre de quien lo tiene se pinta con su propia clase, no como una
    // línea suelta indistinguible de las de abajo.
    const destinatario = buscar(card, (n) => n.className === "tx-slot-card__recipient") as FakeElement;
    expect(destinatario).not.toBeNull();
    expect(destinatario.textContent).toContain("Cliente A");
  });

  it("la etiqueta del botón cuenta el efecto ENTERO: sustituye y aprueba", () => {
    const card = tarjetaDe(snapPendiente);
    const boton = botonPorTexto(card, "Sustituir y aprobar esta propuesta");
    expect(boton.disabled).toBe(true);
    // Y la etiqueta que sólo contaba la mitad ya no existe en ningún control.
    expect(todos(card, (n) => n.tagName === "BUTTON").map((b) => b.textContent)).not.toContain(
      "Proponer a esta persona en su lugar",
    );
  });

  it("marcar a alguien previsualiza el cambio EXACTO y lo engancha al botón por aria-describedby", () => {
    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera } = loadUiClientHooks("", document);
    renderListaEspera(snapPendiente);
    const card = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
    const boton = botonPorTexto(card, "Sustituir y aprobar esta propuesta");
    const previa = buscar(card, (n) => n.className === "tx-slot-card__preview") as FakeElement;
    expect(previa).not.toBeNull();

    // SIN nadie marcado: el botón está apagado y la razón se lee en texto.
    expect(boton.disabled).toBe(true);
    expect(previa.textContent).toContain("Marca a una persona de esta lista");

    const radio = todos(card, (n) => n.type === "radio")[0] as FakeElement & { onchange?: () => void };
    radio.onchange?.();

    expect(boton.disabled).toBe(false);
    // Las dos personas, el hueco y las cuatro consecuencias, antes de pulsar.
    expect(previa.textContent).toContain("Cliente A");
    expect(previa.textContent).toContain("Cliente B");
    expect(previa.textContent).toContain(huecoDe(snapPendiente, HUECO_1300).label as string);
    expect(previa.textContent).toContain(WAITLIST_COPY.substitutionEffectsBefore);
    // Y quien navegue con teclado la oye AL LLEGAR al botón, no después.
    expect(boton.getAttribute("aria-describedby")).toBe(previa.getAttribute("id"));
    // No es una región viva: el sondeo no puede re-locutarla cada dos segundos.
    expect(previa.getAttribute("aria-live")).toBeNull();
    expect(previa.getAttribute("role")).toBeNull();
  });
});

describe("Reparación R2-UX · defectos 3 y 7 — sustituir confirma, y confirma una sola vez", () => {
  it("tras sustituir: se nombra a las dos personas, el hueco y el destinatario nuevo — y no se inventa nada", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    const { nodes } = await cargarPantalla(await snapshotOf(app));
    const { enviados, restore } = conectarFetchReal(app);

    let card = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
    const detalle = buscar(card, (n) => n.tagName === "DETAILS") as FakeElement;
    detalle.open = true;
    const radio = todos(card, (n) => n.type === "radio")[0] as FakeElement & { onchange?: () => void };
    radio.onchange?.();
    const boton = botonPorTexto(card, "Sustituir y aprobar esta propuesta") as FakeElement & { onclick?: () => void };

    try {
      boton.onclick?.();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      restore();
    }

    // Se mandó el comando de siempre, con SU hueco.
    const sustituciones = enviados.filter((e) => e.body.command === "take_over_proposal");
    expect(sustituciones.length).toBe(1);
    expect(sustituciones[0]?.url).toBe("/api/waitlist/entries/wl-f02/command");
    expect(sustituciones[0]?.body.slotKey).toBe(HUECO_1300);

    // (Defecto 3) LA CONFIRMACIÓN, en la región de estado accesible.
    const estado = nodes["le-huecos-estado"] as FakeElement;
    expect(estado.hidden).toBe(false);
    expect(estado.textContent).toContain("Cliente B ha sustituido a Cliente A para esta propuesta.");
    expect(estado.textContent).toContain(huecoDe(await snapshotOf(app), HUECO_1300).label as string);
    expect(estado.textContent).toContain("Destinatario actual: Cliente B");
    expect(estado.textContent).toContain(WAITLIST_COPY.substitutionEffectsAfter);
    // Y NO inventa un aviso, una aceptación ni una reserva.
    expect(estado.textContent.toLowerCase()).not.toContain("se ha avisado a cliente b");
    expect(estado.textContent).toContain("Todavía no se ha avisado a nadie y no se ha creado ninguna reserva");

    // El mundo real coincide con lo que dice la pantalla: aprobada, sin aviso
    // y sin reserva.
    const despues = await snapshotOf(app);
    const p = propuestaDe(despues, HUECO_1300);
    expect(p.statusCode).toBe("substituted");
    expect(p.clientLabel).toBe("Cliente B");
    expect((waitlistDe(despues).metrics as Json).noticesSimulated).toBe(0);
    expect((waitlistDe(despues).metrics as Json).conversions).toBe(0);

    // (Defecto 7) Y la tarjeta lo confirma por sí sola, sin depender de que
    // nadie haya visto pasar la línea de estado.
    card = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
    const hecho = buscar(card, (n) => n.className === "tx-slot-card__done") as FakeElement;
    expect(hecho).not.toBeNull();
    expect(hecho.hidden).toBe(false);
    expect(hecho.textContent).toBe("Cliente B ha sustituido a Cliente A para esta propuesta.");
    await app.close();
  });

  it("(defecto 5) el control se limpia al terminar: sin marca y cerrado, para que el siguiente clic no lo deshaga", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    const { nodes } = await cargarPantalla(await snapshotOf(app));
    const { restore } = conectarFetchReal(app);

    const card = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
    const detalle = buscar(card, (n) => n.tagName === "DETAILS") as FakeElement;
    detalle.open = true;
    const radio = todos(card, (n) => n.type === "radio")[0] as FakeElement & { onchange?: () => void };
    radio.onchange?.();
    const boton = botonPorTexto(card, "Sustituir y aprobar esta propuesta") as FakeElement & { onclick?: () => void };

    try {
      boton.onclick?.();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      restore();
    }

    expect(detalle.open).toBe(false);
    for (const r of todos(card, (n) => n.type === "radio")) expect(r.checked).toBe(false);
    // Y el botón vuelve a estar apagado: sustituir otra vez exige volver a
    // abrir, volver a marcar y volver a confirmar.
    expect(botonPorTexto(card, "Sustituir y aprobar esta propuesta").disabled).toBe(true);
    const previa = buscar(card, (n) => n.className === "tx-slot-card__preview") as FakeElement;
    expect(previa.textContent).toContain("Marca a una persona de esta lista");
    await app.close();
  });

  it("(defecto 7) el sondeo repinta la confirmación IDÉNTICA y no vuelve a anunciar nada", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    await comando(app, "wl-f02", "take_over_proposal", HUECO_1300);
    const snap = await snapshotOf(app);

    const { document, nodes } = documentoListaEspera();
    const { renderListaEspera } = loadUiClientHooks("", document);
    const estado = nodes["le-huecos-estado"] as FakeElement;

    renderListaEspera(snap);
    const card = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
    const hecho = buscar(card, (n) => n.className === "tx-slot-card__done") as FakeElement;
    const primero = hecho.textContent;

    renderListaEspera(snap);
    renderListaEspera(snap);
    // Mismo nodo, mismo texto: nada que un lector de pantalla tenga que
    // volver a locutar, y ni un duplicado en la tarjeta.
    expect((nodes["le-huecos-lista"] as FakeElement).children[0]).toBe(card);
    expect(buscar(card, (n) => n.className === "tx-slot-card__done")).toBe(hecho);
    expect(hecho.textContent).toBe(primero);
    // La región de estado es del comando, no del sondeo: el repintado no
    // escribe en ella ni una vez.
    expect(estado.textContent).toBe("");
    await app.close();
  });

  it("aprobar también confirma con el hueco y con lo que queda por hacer", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    const { nodes } = await cargarPantalla(await snapshotOf(app));
    const { restore } = conectarFetchReal(app);
    const card = (nodes["le-huecos-lista"] as FakeElement).children[0] as FakeElement;
    const aprobar = botonPorTexto(card, "Aprobar la propuesta") as FakeElement & { onclick?: () => void };
    try {
      aprobar.onclick?.();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      restore();
    }
    const estado = nodes["le-huecos-estado"] as FakeElement;
    expect(estado.textContent).toContain("Propuesta aprobada para Cliente A");
    expect(estado.textContent).toContain(huecoDe(await snapshotOf(app), HUECO_1300).label as string);
    expect(estado.textContent).toContain(WAITLIST_COPY.approvalEffectsAfter);
    await app.close();
  });
});

// =====================================================================
// LO QUE NO PODÍA CAMBIAR — las garantías de dominio, otra vez, desde fuera
// =====================================================================

describe("Reparación R2-UX · las garantías de step 23 siguen en pie", () => {
  it("los dos huecos hermanos siguen corriendo ciclos independientes, y sustituir en uno no toca al otro", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");

    // La cancelación de 60 minutos libera DOS medias horas independientes.
    const inicial = await snapshotOf(app);
    expect((waitlistDe(inicial).releasedSlots as Json[]).map((s) => s.key).sort()).toEqual(
      [HUECO_1300, HUECO_1330].sort(),
    );
    // R1(d): nadie es sujeto de dos propuestas a la vez, así que el hermano
    // espera su turno sin propuesta. No es un fallo: es la garantía.
    expect(huecoDe(inicial, HUECO_1330).proposal).toBeNull();

    await comando(app, "wl-f02", "take_over_proposal", HUECO_1300);
    const tras = await snapshotOf(app);
    expect(propuestaDe(tras, HUECO_1300).statusCode).toBe("substituted");
    // Sustituir en el primero NO aprueba, avisa ni reserva nada en el segundo.
    expect(huecoDe(tras, HUECO_1330).proposal).toBeNull();
    expect(huecoDe(tras, HUECO_1330).stillFree).toBe(true);
    await app.close();
  });

  it("y cuando el primer hueco cierra su ciclo, el segundo abre el SUYO, entero y desde el principio", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    await comando(app, "wl-f01", "approve_proposal", HUECO_1300);
    await comando(app, "wl-f01", "simulate_notice");
    await comando(app, "wl-f01", "record_acceptance");
    expect(
      (await post(
        app,
        "/api/waitlist/entries/wl-f01/convert",
        { slotKey: HUECO_1300, confirmed: true },
        { "idempotency-key": "reparaciones-ux-hermanos" },
      )).statusCode,
    ).toBe(200);

    const snap = await snapshotOf(app);
    expect(propuestaDe(snap, HUECO_1300).statusCode).toBe("converted");
    // El hermano arranca su propio ciclo: propuesta nueva, SIN aprobar, para
    // otra persona, y con su propia tarjeta esperando una decisión humana.
    const hermana = propuestaDe(snap, HUECO_1330);
    expect(hermana.statusCode).toBe("pending_approval");
    expect(hermana.entryId).toBe("wl-f02");
    expect(huecoDe(snap, HUECO_1330).decisionPending).toBe(true);
    expect(String(hermana.stageNote)).toBe(WAITLIST_COPY.proposalIsSuggestion);
    await app.close();
  });

  it("sustituir NO avisa, NO acepta y NO reserva: sigue haciendo falta la cadena humana entera", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    await comando(app, "wl-f02", "take_over_proposal", HUECO_1300);
    const snap = await snapshotOf(app);
    const metrics = waitlistDe(snap).metrics as Json;
    expect(metrics.noticesSimulated).toBe(0);
    expect(metrics.conversions).toBe(0);
    const entrada = (waitlistDe(snap).entries as Json[]).find((e) => e.id === "wl-f02") as Json;
    expect(entrada.state).toBe("matched");
    await app.close();
  });

  it("un reinicio devuelve el estado honesto: sin huecos, sin propuestas y sin actividad", async () => {
    const app = freshApp();
    await post(app, "/api/reset", {});
    await cancel(app, "demo-salon-res-2");
    await comando(app, "wl-f02", "take_over_proposal", HUECO_1300);
    await post(app, "/api/reset", {});
    const snap = await snapshotOf(app);
    expect((waitlistDe(snap).releasedSlots as Json[]).length).toBe(0);
    expect((waitlistDe(snap).activity as Json).total).toBe(0);
    expect((waitlistDe(snap).attention as Json).pendingProposalCount).toBe(0);

    const { nodes } = await cargarPantalla(snap);
    expect((nodes["le-huecos-lista"] as FakeElement).children.length).toBe(0);
    expect((nodes["le-huecos-vacio"] as FakeElement).hidden).toBe(false);
    await app.close();
  });
});
