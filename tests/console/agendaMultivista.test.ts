import { describe, it, expect } from "vitest";

import { CONSOLE_CSS } from "../../src/console/ui.css.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, type FakeElement } from "./fakeDom.js";

/**
 * step 26 · Capacidad A — Agenda multivista (Día · Semana · Mes) y su
 * convivencia con la tabla `Lista`.
 *
 * Misma técnica que el resto de la casa: el JavaScript REAL que sirve
 * `GET /app.js`, ejecutado contra el DOM falso de `fakeDom.ts` (sin
 * navegador — decisión de misión). Ninguna prueba de aquí afirma "esto se ve
 * bien": lo que se comprueba es estructura, atributos, texto y estado —lo
 * único que se puede demostrar sin pintar un píxel.
 *
 * Todas las pruebas de este fichero FALLAN contra `2d2e3e4` (la agenda
 * multivista no existe en ese commit).
 */

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------
// Fixture — un venue con tres profesionales, una semana entera de estados
// distintos: días abiertos con muchas citas, un día vacío, un día con una
// ausencia parcial, un día con una ausencia de jornada completa, un festivo
// y un día de descanso semanal. Todas las duraciones exigidas por §14 (A4)
// y los dos inicios desalineados de §14 (A5) viven el 2026-08-05.
// ---------------------------------------------------------------------

const PROFESIONALES = [
  { employeeId: 3, label: "Álex (sintético)" },
  { employeeId: 6, label: "Bea (sintética)" },
  { employeeId: 9, label: "Cruz (sintético)" },
];

// Lunes a sábado abiertos 09:00–18:00; domingo (dayOfWeek 0) sin fila = cerrado.
const WEEKLY = [1, 2, 3, 4, 5, 6].map((dow) => ({
  ownerKind: "venue",
  dayOfWeek: dow,
  workDayStart: "09:00",
  workDayEnd: "18:00",
}));

const VENUE_RULES = [{ id: "festivo-1", approval: "approved", date: "2026-08-08", closed: true }];

const ABSENCES = [
  // Bea, ausencia PARCIAL el 2026-08-06: 09:00–12:00.
  { id: "aus-parcial", employeeId: 6, approval: "approved", kind: "absence", startDate: "2026-08-06", endDate: "2026-08-06", allDay: false, startMinutes: 540, endMinutes: 720 },
  // Cruz, ausencia de JORNADA COMPLETA el 2026-08-07.
  { id: "aus-completa", employeeId: 9, approval: "approved", kind: "vacation", startDate: "2026-08-07", endDate: "2026-08-07", allDay: true },
];

function res(id: string, employeeId: number, serviceId: number, date: string, startMinutes: number, endMinutes: number, status: "confirmed" | "cancelled" = "confirmed", extra: Json = {}) {
  return { id, employeeId, serviceId, date, startMinutes, endMinutes, status, eligibleForNoShow: false, ...extra };
}

const RESERVATIONS = [
  // Álex 2026-08-05 — 30, 30 (simultánea con Bea), 60, 150; una cancelada.
  res("res-1", 3, 0, "2026-08-05", 540, 570), // 09:00–09:30 (30)
  res("res-2", 3, 1, "2026-08-05", 600, 630), // 10:00–10:30 (30) — simultánea con Bea
  res("res-3", 3, 2, "2026-08-05", 720, 780), // 12:00–13:00 (60)
  res("res-4", 3, 0, "2026-08-05", 900, 1050), // 15:00–17:30 (150)
  res("res-5", 3, 1, "2026-08-05", 1020, 1050, "cancelled"), // 17:00–17:30, CANCELADA
  // Bea 2026-08-05 — 30 (simultánea), 90, 120 con inicio :45.
  res("res-6", 6, 1, "2026-08-05", 600, 630), // 10:00–10:30 (30)
  res("res-7", 6, 0, "2026-08-05", 660, 750), // 11:00–12:30 (90)
  res("res-8", 6, 2, "2026-08-05", 885, 1005), // 14:45–16:45 (120), inicio :45
  // Cruz 2026-08-05 — 45 con inicio :15, 135, 120.
  res("res-9", 9, 1, "2026-08-05", 555, 600), // 09:15–10:00 (45), inicio :15
  res("res-10", 9, 0, "2026-08-05", 660, 795), // 11:00–13:15 (135)
  res("res-11", 9, 2, "2026-08-05", 960, 1080), // 16:00–18:00 (120)
];

const CAL = {
  professionals: PROFESIONALES,
  weeklySchedules: WEEKLY,
  seasonalSchedules: [],
  closures: [],
  venueRules: VENUE_RULES,
  absences: ABSENCES,
  reservations: RESERVATIONS,
};

const SNAP = { engineToday: "2026-08-05", engineNowMinutes: 600, calendar: CAL };

// Todos los ids que la Agenda real usa en producción — el HTML real siempre
// los trae todos; aquí se siembran explícitamente para que un `byId` que
// falte se note con un error claro, nunca en silencio.
const AGENDA_IDS = [
  { id: "agenda-vista-dia", tag: "button" },
  { id: "agenda-vista-semana", tag: "button" },
  { id: "agenda-vista-mes", tag: "button" },
  { id: "agenda-vista-lista", tag: "button" },
  { id: "agenda-anterior", tag: "button" },
  { id: "agenda-hoy", tag: "button" },
  { id: "agenda-siguiente", tag: "button" },
  { id: "agenda-filtro-profesional", tag: "select" },
  { id: "agenda-titulo-rango", tag: "h2" },
  "agenda-aviso-ruta",
  "agenda-fuera-horario",
  "agenda-nota-densidad",
  "agenda-rejilla",
  { id: "agenda-semana-resumen", tag: "ol" },
  "agenda-mes",
  "agenda-dias",
  "agenda-vacio",
  { id: "huecos-profesional", tag: "select" },
  "tx-view-title",
  "tx-freshness",
  "tx-conexion-anuncio",
  "inicio-ruta-desconocida",
] as const;

// Los ids del diálogo de detalle de cita (step 26 §6.6).
const DETALLE_IDS = [
  { id: "dialogo-cita-detalle", tag: "dialog" },
  { id: "dialogo-cita-detalle-titulo", tag: "h2" },
  "cita-detalle-cuando",
  "cita-detalle-servicio",
  "cita-detalle-profesional",
  "cita-detalle-pill",
  "cita-detalle-origen",
  "cita-detalle-grupo",
  { id: "cita-detalle-tecnico", tag: "dl" },
  "cita-detalle-acciones",
  { id: "cita-detalle-cerrar", tag: "button" },
] as const;

function fullDom() {
  return createFakeDocumentWithIds([...AGENDA_IDS, ...DETALLE_IDS]);
}

/** Levanta los ganchos, sondea con `SNAP` (o el que se le pase) y devuelve document/nodes/hooks. */
async function montado(hash: string, snapshot: Json = SNAP) {
  const { document, nodes } = fullDom();
  const hooks = loadUiClientHooks(hash, document, { location: { hash }, scrollTo: () => {} });
  const fetchSnap = () => Promise.resolve({ json: () => Promise.resolve(snapshot) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchSnap as typeof fetch;
  try {
    hooks.applyRoute();
    await hooks.refresh();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { document, nodes, hooks };
}

/**
 * (step 26 REAPERTURA §R6) Como `montado()`, pero deja el `fetch` simulado
 * ACTIVO tras montar en vez de restaurarlo: hace falta cuando una prueba
 * necesita varias llamadas propias a `hooks.refresh()` después del montaje
 * (varias «pasadas» de sondeo, varios cambios de vista/fecha/filtro). Quien
 * la usa es responsable de llamar a `cerrar()` — típicamente en un
 * `try/finally` — para no dejar el `fetch` real sustituido entre pruebas.
 */
function montadoPersistente(hash: string, snapshot: Json = SNAP) {
  const { document, nodes } = fullDom();
  const hooks = loadUiClientHooks(hash, document, { location: { hash }, scrollTo: () => {} });
  const fetchSnap = () => Promise.resolve({ json: () => Promise.resolve(snapshot) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchSnap as typeof fetch;
  hooks.applyRoute();
  return { document, nodes, hooks, cerrar: () => { globalThis.fetch = originalFetch; } };
}

function aria(node: FakeElement, attr: string): string | null {
  return node.getAttribute(attr);
}

// =====================================================================
// A1 — vistas y navegación: anterior/Hoy/siguiente, filtro, deep link.
// =====================================================================

describe("step 26 · A1 — vistas y navegación de la Agenda", () => {
  it("'#/agenda' a secas es Día · hoy · todos, y el botón Día queda marcado", async () => {
    const { nodes } = await montado("#/agenda");
    expect(aria(nodes["agenda-vista-dia"]!, "aria-pressed")).toBe("true");
    expect(aria(nodes["agenda-vista-semana"]!, "aria-pressed")).toBe("false");
    expect(nodes["agenda-titulo-rango"]!.textContent).toContain("5 de agosto de 2026");
    expect(nodes["agenda-rejilla"]!.hidden).toBe(false);
    expect(nodes["agenda-mes"]!.hidden).toBe(true);
    expect(nodes["agenda-dias"]!.hidden).toBe(true);
  });

  it("un deep link directo a semana/fecha/profesional pinta esa vista exacta, sin pasos intermedios", async () => {
    const { nodes } = await montado("#/agenda/semana/2026-08-05/p3");
    expect(aria(nodes["agenda-vista-semana"]!, "aria-pressed")).toBe("true");
    expect(nodes["agenda-titulo-rango"]!.textContent).toBe("Semana del 3 al 9 de agosto de 2026");
    expect((nodes["agenda-filtro-profesional"] as FakeElement).value).toBe("3");
    expect(nodes["agenda-rejilla"]!.hidden).toBe(false);
    expect(nodes["agenda-semana-resumen"]!.hidden).toBe(true);
  });

  it("'siguiente' en Día mueve la fecha ancla +1 día; 'anterior', -1", () => {
    const { hooks } = loadHooksOnly();
    expect(hooks.agendaFechaTrasPaso("dia", "2026-08-05", 1)).toBe("2026-08-06");
    expect(hooks.agendaFechaTrasPaso("dia", "2026-08-05", -1)).toBe("2026-08-04");
  });

  it("pulsar 'siguiente' escribe el hash de verdad y applyRoute() lo recoge", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-08-05/todos" }, scrollTo: () => {} };
    const { document, nodes } = fullDom();
    const hooks = loadUiClientHooks("", document, win);
    hooks.applyRoute();
    hooks.navegarAgenda("dia", hooks.agendaFechaTrasPaso("dia", "2026-08-05", 1), "todos");
    expect(win.location.hash).toBe("#/agenda/dia/2026-08-06/todos");
    hooks.applyRoute();
    expect(hooks.parseHash().params).toEqual(["dia", "2026-08-06", "todos"]);
    void nodes;
  });

  it("'siguiente'/'anterior' en Semana mueven la fecha ancla ±7 días (decisión 5)", () => {
    const { hooks } = loadHooksOnly();
    expect(hooks.agendaFechaTrasPaso("semana", "2026-08-05", 1)).toBe("2026-08-12");
    expect(hooks.agendaFechaTrasPaso("semana", "2026-08-05", -1)).toBe("2026-07-29");
  });

  it("'siguiente'/'anterior' en Mes mueven al mes natural siguiente/anterior", () => {
    const { hooks } = loadHooksOnly();
    expect(hooks.agendaFechaTrasPaso("mes", "2026-08-05", 1)).toBe("2026-09-05");
    expect(hooks.agendaFechaTrasPaso("mes", "2026-08-05", -1)).toBe("2026-07-05");
  });

  it("el filtro de profesional construye el hash 'p<employeeId>' y 'todos' para la opción vacía", () => {
    const { hooks } = loadHooksOnly();
    expect(hooks.agendaHrefPara("dia", "2026-08-05", "todos")).toBe("#/agenda/dia/2026-08-05/todos");
    expect(hooks.agendaHrefPara("semana", "2026-08-05", "p6")).toBe("#/agenda/semana/2026-08-05/p6");
  });

  it("un employeeId que no existe en el snapshot se trata como 'todos' y enciende el aviso de ruta", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p999");
    expect((nodes["agenda-filtro-profesional"] as FakeElement).value).toBe("");
    expect(nodes["agenda-aviso-ruta"]!.hidden).toBe(false);
  });

  it("Lista es la cuarta vista y muestra la ventana de 7 días desde la fecha ancla", async () => {
    const { nodes } = await montado("#/agenda/lista/2026-08-05/todos");
    expect(aria(nodes["agenda-vista-lista"]!, "aria-pressed")).toBe("true");
    expect(nodes["agenda-dias"]!.hidden).toBe(false);
    expect(nodes["agenda-dias"]!.children.length).toBe(7);
  });
});

function loadHooksOnly() {
  const { document } = fullDom();
  const hooks = loadUiClientHooks("", document);
  return { hooks };
}

// =====================================================================
// A2 — recarga, Atrás/Adelante (dos hashchange seguidos), ruta desconocida.
// =====================================================================

describe("step 26 · A2 — recarga, Atrás/Adelante y rutas desconocidas", () => {
  it("recargar es sólo volver a leer el mismo hash: aplicarlo dos veces seguidas da el mismo estado", async () => {
    const { document } = fullDom();
    const hash = "#/agenda/mes/2026-08-05/todos";
    const hooks = loadUiClientHooks(hash, document, { location: { hash }, scrollTo: () => {} });
    hooks.applyRoute();
    const primero = hooks.parseHash();
    hooks.applyRoute(); // "recarga"
    const segundo = hooks.parseHash();
    expect(segundo).toEqual(primero);
  });

  it("Atrás/Adelante son dos hashchange sucesivos: el segundo aplica limpiamente sobre el primero", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-08-05/todos" }, scrollTo: () => {} };
    const { document } = fullDom();
    const hooks = loadUiClientHooks("", document, win);
    hooks.applyRoute();
    win.location.hash = "#/agenda/semana/2026-08-05/todos"; // "Adelante"
    hooks.applyRoute();
    expect(hooks.parseHash().params).toEqual(["semana", "2026-08-05", "todos"]);
    win.location.hash = "#/agenda/dia/2026-08-05/todos"; // "Atrás"
    hooks.applyRoute();
    expect(hooks.parseHash().params).toEqual(["dia", "2026-08-05", "todos"]);
  });

  it("'#/agenda/quincena' no se entiende: se normaliza a Día al PINTAR, sin reescribir la URL, con el aviso visible", async () => {
    const win = { location: { hash: "#/agenda/quincena/2026-08-05/todos" }, scrollTo: () => {} };
    const { nodes } = await montadoConWindow(win);
    expect(win.location.hash).toBe("#/agenda/quincena/2026-08-05/todos"); // la URL NO se toca
    // El texto en sí es ESTÁTICO en el HTML servido (decisión 9: "un texto
    // estático oculto/visible"), así que el JS sólo alterna `hidden`; el DOM
    // falso de esta prueba no reproduce el HTML servido letra a letra, y se
    // comprueba el texto exacto aparte, contra el HTML real.
    expect(nodes["agenda-aviso-ruta"]!.hidden).toBe(false);
    expect(aria(nodes["agenda-vista-dia"]!, "aria-pressed")).toBe("true");
  });

  it("el texto del aviso de ruta es el literal exacto de la decisión 9, servido como HTML estático", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(
      '<p class="tx-status-line tx-col-12" id="agenda-aviso-ruta" hidden>No se ha entendido parte de la dirección. Se muestra el día de hoy.</p>',
    );
  });

  it("'#/zzz' (sección desconocida) sigue cayendo en Inicio marcada 'unknown' — la Agenda nunca secuestra ese caso", () => {
    const { document } = fullDom();
    const hooks = loadUiClientHooks("#/zzz", document);
    const route = hooks.parseHash();
    expect(route.section).toBe("inicio");
    expect(route.unknown).toBe(true);
  });

  // Reparación adversarial (hallazgo 3) — una fecha con la FORMA correcta
  // pero un calendario imposible no puede reinterpretarse en silencio por
  // el "rollover" de `new Date()`.
  it.each(["2026-13-40", "2026-02-30", "2026-00-01", "2026-04-31"])(
    "'%s' tiene forma de fecha pero no es un día real: se trata como ruta corrupta, con el aviso visible",
    async (fechaImposible) => {
      const win = { location: { hash: `#/agenda/dia/${fechaImposible}/todos` }, scrollTo: () => {} };
      const { nodes, hooks } = await montadoConWindow(win);
      expect(nodes["agenda-aviso-ruta"]!.hidden).toBe(false);
      // Nunca se reescribe la URL, y la fecha ancla cae a hoy (engineToday).
      expect(win.location.hash).toBe(`#/agenda/dia/${fechaImposible}/todos`);
      expect(nodes["agenda-titulo-rango"]!.textContent).toContain("5 de agosto de 2026");
      void hooks;
    },
  );

  it("una fecha real de calendario NO enciende el aviso de ruta", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-02-28/todos" }, scrollTo: () => {} };
    const { nodes } = await montadoConWindow(win);
    expect(nodes["agenda-aviso-ruta"]!.hidden).toBe(true);
  });

  // Reparación adversarial (hallazgo 6) — un cuarto segmento (o más) no
  // tiene ningún significado en la gramática de la decisión 9 y antes se
  // ignoraba en silencio.
  it("un cuarto segmento extra en el hash enciende el aviso de ruta, igual que un segmento inválido", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-08-05/todos/extra" }, scrollTo: () => {} };
    const { nodes } = await montadoConWindow(win);
    expect(nodes["agenda-aviso-ruta"]!.hidden).toBe(false);
    // La URL no se toca, y los tres primeros segmentos SÍ se respetan.
    expect(win.location.hash).toBe("#/agenda/dia/2026-08-05/todos/extra");
    expect(aria(nodes["agenda-vista-dia"]!, "aria-pressed")).toBe("true");
    expect(nodes["agenda-titulo-rango"]!.textContent).toContain("5 de agosto de 2026");
  });
});

async function montadoConWindow(win: { location: { hash: string }; scrollTo?: () => void }) {
  const { document, nodes } = fullDom();
  const hooks = loadUiClientHooks(win.location.hash, document, win);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve(SNAP) })) as typeof fetch;
  try {
    hooks.applyRoute();
    await hooks.refresh();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { document, nodes, hooks };
}

// =====================================================================
// A3 — cero, una, varias y muchas citas; simultáneas de profesionales
// distintos.
// =====================================================================

describe("step 26 · A3 — cero/una/varias/muchas citas, y simultáneas", () => {
  it("un día sin ninguna cita produce UN hueco por columna, no treinta", async () => {
    const { nodes, hooks } = await montado("#/agenda/dia/2026-08-04/p3");
    void hooks;
    const rejilla = nodes["agenda-rejilla"]!;
    // eje + 1 columna
    const columna = rejilla.children.find((c) => c.tagName === "SECTION")!;
    const items = columna.children.find((c) => c.className === "tx-agenda-col__items")!;
    const huecos = items.children.filter((li) => li.className.includes("tx-agenda-gap"));
    expect(huecos.length).toBe(1);
    expect(huecos[0]!.textContent).toBe("09:00 – 18:00 · Sin cita");
  });

  it("Álex el 2026-08-05 tiene varias citas (cuatro) más una cancelada aparte", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p3");
    const columna = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!;
    const items = columna.children.find((c) => c.className === "tx-agenda-col__items")!;
    const bloques = items.children.filter((li) => li.className.includes("tx-agenda-block"));
    expect(bloques.length).toBe(4);
    const detalle = columna.children.find((c) => c.tagName === "DETAILS");
    expect(detalle).toBeDefined();
    expect(detalle!.children[0]!.textContent).toBe("Canceladas (1)");
  });

  it("Bea y Cruz juntos ese día suman 'muchas' citas visibles a la vez (rejilla de 3 columnas)", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/todos");
    const rejilla = nodes["agenda-rejilla"]!;
    expect(rejilla.className).toContain("tx-agenda-grid--cols-3");
    const columnas = rejilla.children.filter((c) => c.tagName === "SECTION");
    expect(columnas.length).toBe(3);
  });

  it("Álex y Bea tienen una cita SIMULTÁNEA (10:00–10:30) — cada una en su propia columna, sin fundirse", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/todos");
    const rejilla = nodes["agenda-rejilla"]!;
    const columnas = rejilla.children.filter((c) => c.tagName === "SECTION");
    const porProfesional = (id: number) => columnas.find((c) => c.children[0]!.id === "agenda-col-" + String(id))!;
    const bloqueDe = (col: FakeElement, key: string) =>
      col.children.find((c) => c.className === "tx-agenda-col__items")!.children.find((li) => li.getAttribute("data-key") === key);
    expect(bloqueDe(porProfesional(3), "res-2")).toBeDefined();
    expect(bloqueDe(porProfesional(6), "res-6")).toBeDefined();
  });
});

// =====================================================================
// Reparación adversarial (hallazgo 7) — decisión 6.3: con MÁS de cuatro
// profesionales visibles, la vista Día cae a lista cronológica en vez de
// estrechar columnas hasta lo ilegible o añadir un desplazamiento
// horizontal nuevo.
// =====================================================================

describe("step 26 · decisión 6.3 — más de cuatro profesionales cae a lista cronológica", () => {
  const CINCO_PROFESIONALES = [
    { employeeId: 1, label: "Profesional 1 (sintético)" },
    { employeeId: 2, label: "Profesional 2 (sintético)" },
    { employeeId: 3, label: "Profesional 3 (sintético)" },
    { employeeId: 4, label: "Profesional 4 (sintético)" },
    { employeeId: 5, label: "Profesional 5 (sintético)" },
  ];
  const SNAP_CINCO = {
    engineToday: "2026-08-05",
    engineNowMinutes: 600,
    calendar: { ...CAL, professionals: CINCO_PROFESIONALES, reservations: [res("res-p1", 1, 0, "2026-08-05", 540, 570)] },
  };

  it("con cinco profesionales visibles (Todos) NO se pinta la rejilla: se pinta como lista, con el aviso encendido", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/todos", SNAP_CINCO);
    // El texto en sí es ESTÁTICO en el HTML servido (mismo patrón que
    // #agenda-aviso-ruta); el JS sólo alterna `hidden` — se comprueba
    // aparte, contra el HTML real, en la siguiente prueba.
    expect(nodes["agenda-nota-densidad"]!.hidden).toBe(false);
    // Nada de rejilla: ni clase de columnas, ni el eje de horas.
    expect(nodes["agenda-rejilla"]!.className).not.toContain("tx-agenda-grid--cols");
    expect(nodes["agenda-rejilla"]!.children.some((c) => c.className === "tx-agenda-grid__axis")).toBe(false);
    // Se pinta como LISTA (decisión 6.3): un <ol> con una sección por profesional.
    const lista = nodes["agenda-rejilla"]!.children.find((c) => c.className === "tx-agenda-semana-resumen")!;
    expect(lista).toBeDefined();
    expect(lista.tagName).toBe("OL");
    // Las cinco personas siguen presentes, cada una en su propia sección — nada se esconde.
    const columnas = lista.children.filter((c) => c.tagName === "SECTION");
    expect(columnas.length).toBe(5);
  });

  it("filtrar a un único profesional (≤4 visibles) vuelve a mostrar la rejilla, y el aviso se apaga", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p1", SNAP_CINCO);
    expect(nodes["agenda-nota-densidad"]!.hidden).toBe(true);
    expect(nodes["agenda-rejilla"]!.className).toContain("tx-agenda-grid--cols-1");
  });

  it("el texto de la nota de densidad es el literal exacto de la decisión 6.3, servido como HTML estático", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(
      '<p class="tx-context__note tx-col-12" id="agenda-nota-densidad" hidden>Con más de cuatro profesionales la agenda se muestra como lista. Filtra por profesional para ver la rejilla.</p>',
    );
  });
});

// =====================================================================
// A4/A5 — bloques de 30..150 min con altura proporcional (tics), e
// inicios/fines en :15 y :45 en el tic correcto.
// =====================================================================

describe("step 26 · A4/A5 — bloques proporcionales y alineación de :15/:45", () => {
  it("una cita de 30 min ocupa 2 tics, y una de 150 min ocupa 10 — proporcional siempre", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!.children.find((c) => c.className === "tx-agenda-col__items")!;
    const porClave = (k: string) => items.children.find((li) => li.getAttribute("data-key") === k)!;
    expect(porClave("res-1").className).toContain("tx-agenda-s-2"); // 30 min
    expect(porClave("res-3").className).toContain("tx-agenda-s-4"); // 60 min
    expect(porClave("res-4").className).toContain("tx-agenda-s-10"); // 150 min
  });

  it("90, 120 y 135 min dan 6, 8 y 9 tics respectivamente", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/todos");
    const columnas = nodes["agenda-rejilla"]!.children.filter((c) => c.tagName === "SECTION");
    const items = (id: number) => columnas.find((c) => c.children[0]!.id === "agenda-col-" + String(id))!.children.find((c) => c.className === "tx-agenda-col__items")!;
    expect(items(6).children.find((li) => li.getAttribute("data-key") === "res-7")!.className).toContain("tx-agenda-s-6"); // 90
    expect(items(6).children.find((li) => li.getAttribute("data-key") === "res-8")!.className).toContain("tx-agenda-s-8"); // 120
    expect(items(9).children.find((li) => li.getAttribute("data-key") === "res-10")!.className).toContain("tx-agenda-s-9"); // 135
  });

  it("un inicio a :15 y otro a :45 caen en el tic correcto (fila = minutos desde la apertura / 15 + 1)", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/todos");
    const columnas = nodes["agenda-rejilla"]!.children.filter((c) => c.tagName === "SECTION");
    const items = (id: number) => columnas.find((c) => c.children[0]!.id === "agenda-col-" + String(id))!.children.find((c) => c.className === "tx-agenda-col__items")!;
    // Cruz, 09:15, apertura 09:00 → (555-540)/15 + 1 = 2
    expect(items(9).children.find((li) => li.getAttribute("data-key") === "res-9")!.className).toContain("tx-agenda-r-2");
    // Bea, 14:45, apertura 09:00 → (885-540)/15 + 1 = 24
    expect(items(6).children.find((li) => li.getAttribute("data-key") === "res-8")!.className).toContain("tx-agenda-r-24");
  });

  it("la duración real se lee de endMinutes-startMinutes del snapshot, nunca se asume 30 min", async () => {
    const { hooks } = loadHooksOnly();
    const lineas135 = hooks.agendaLineasBloque(res("x", 9, 0, "2026-08-05", 660, 795), "con Cruz");
    expect(lineas135[0]).toBe("11:00 – 13:15");
    const lineas15 = hooks.agendaLineasBloque(res("y", 9, 0, "2026-08-05", 660, 675), "con Cruz");
    expect(lineas15).toHaveLength(1);
    expect(lineas15[0]).toContain("11:00 – 11:15");
  });
});

// =====================================================================
// A6 — pausa/cierre/festivo/ausencia: eje, bandas y estados vacíos.
// =====================================================================

describe("step 26 · A6 — cierre, festivo y ausencias", () => {
  it("un día de descanso semanal (domingo) no pinta rejilla: estado vacío honesto con el motivo", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-09/todos"); // domingo
    expect(nodes["agenda-rejilla"]!.className).toBe("tx-col-12");
    const vacio = nodes["agenda-rejilla"]!.children[0]!;
    expect(vacio.children[0]!.textContent).toContain("Local cerrado");
    expect(vacio.children[0]!.textContent).toContain("Día de descanso");
  });

  it("un festivo aprobado también es un estado vacío honesto, con SU motivo distinto", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-08/todos"); // festivo
    const vacio = nodes["agenda-rejilla"]!.children[0]!;
    expect(vacio.children[0]!.textContent).toContain("Festivo aprobado");
  });

  it("una ausencia PARCIAL se pinta como banda inerte dentro del eje, nunca como hueco reservable", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-06/p6"); // Bea, ausencia 09:00–12:00
    const items = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!.children.find((c) => c.className === "tx-agenda-col__items")!;
    const banda = items.children.find((li) => li.className.includes("tx-agenda-banda-ausencia"))!;
    expect(banda).toBeDefined();
    expect(banda.textContent).toBe("No está · Ausencia aprobada");
    const huecos = items.children.filter((li) => li.className.includes("tx-agenda-gap"));
    expect(huecos.length).toBe(1);
    expect(huecos[0]!.textContent).toBe("12:00 – 18:00 · Sin cita");
  });

  it("una ausencia de JORNADA COMPLETA cubre el eje entero: cero huecos ese día", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-07/p9"); // Cruz, ausencia allDay
    const columna = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!;
    const pill = columna.children.find((c) => c.className === "tx-agenda-col__ausencia");
    expect(pill).toBeDefined();
    const items = columna.children.find((c) => c.className === "tx-agenda-col__items")!;
    expect(items.children.filter((li) => li.className.includes("tx-agenda-gap")).length).toBe(0);
  });

  it("una cita fuera del horario del local extiende el eje y lo dice explícitamente", () => {
    const { hooks } = loadHooksOnly();
    const calExtendido = {
      ...CAL,
      reservations: [res("fuera", 3, 0, "2026-08-04", 480, 540, "confirmed")], // 08:00–09:00, antes de abrir
    };
    const axis = hooks.resolveAgendaDayAxis("2026-08-04", { calendar: calExtendido }, [3]);
    expect(axis.extendida).toBe(true);
    expect(axis.startMinutes).toBe(480);
  });

  // ===================================================================
  // V1-4 / V1-5 — LA AGENDA NO OFRECE «CREAR CITA MANUAL» EN HORAS
  // CERRADAS. Los huecos se calculaban sobre el EJE, y el eje se extiende
  // para que quepa una cita fuera de hora: la rejilla invitaba a crear una
  // cita a las 08:00 de un día que abre a las 09:00, y el asistente —que sí
  // pregunta al servidor— lo desmentía en el paso siguiente.
  //
  // DISCRIMINANTES contra `f4c1db1`: allí `agendaHuecosDeColumna` recorre el
  // eje entero y no conoce ni la ventana del local ni la pausa.
  // ===================================================================

  it("V1-4 — el hueco NO invade la extensión del eje: empieza cuando abre el local, no cuando empieza el eje", () => {
    const { hooks } = loadHooksOnly();
    const calExtendido = {
      ...CAL,
      // 08:00–09:00, ANTES de abrir (el local abre a las 09:00). El eje se
      // estira hasta las 08:00 para que la cita se vea.
      reservations: [res("fuera", 3, 0, "2026-08-04", 480, 540, "confirmed")],
    };
    const snap = { calendar: calExtendido };
    const axis = hooks.resolveAgendaDayAxis("2026-08-04", snap, [3]);
    expect(axis.startMinutes).toBe(480); // el eje SÍ se extiende: eso no cambia

    const ventana = hooks.agendaVentanaDelDia("2026-08-04", snap, axis);
    expect(ventana).not.toBeNull();
    expect(ventana!.startMinutes).toBe(540); // 09:00 — la apertura real
    expect(ventana!.endMinutes).toBe(1080); // 18:00

    const huecos = hooks.agendaHuecosDeColumna(axis, [{ startMinutes: 480, endMinutes: 540 }], [], ventana);
    // Un solo hueco, y empieza a las 09:00: nada entre 08:00 y 09:00.
    expect(huecos).toEqual([{ startMinutes: 540, endMinutes: 1080 }]);
    for (const h of huecos) expect(h.startMinutes).toBeGreaterThanOrEqual(ventana!.startMinutes);
  });

  it("V1-4 — la extensión del eje se pinta como zona SIN BOTÓN, y dice por qué", async () => {
    const calExtendido = {
      ...CAL,
      reservations: [res("fuera", 3, 0, "2026-08-04", 480, 540, "confirmed")],
    };
    const snapExtendido = { ...SNAP, calendar: calExtendido } as Json;
    const { nodes } = await montado("#/agenda/dia/2026-08-04/p3", snapExtendido);
    const columna = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!;
    const items = columna.children.find((c) => c.className === "tx-agenda-col__items")!;

    const zonas = items.children.filter((li) => li.className.includes("tx-agenda-fuera"));
    expect(zonas.length, "la extensión del eje no se pinta").toBeGreaterThan(0);
    expect(zonas[0]!.textContent).toBe("08:00 – 09:00 · Fuera del horario del local");
    // Y NO lleva ningún control: no hay nada que se pueda crear ahí.
    const recorrer = (n: FakeElement): string[] => [n.tagName, ...n.children.flatMap(recorrer)];
    for (const z of zonas) expect(recorrer(z)).not.toContain("BUTTON");

    // Ni un solo hueco reservable empieza antes de que abra el local.
    const huecos = items.children.filter((li) => li.className.includes("tx-agenda-gap"));
    expect(huecos.length).toBeGreaterThan(0);
    for (const h of huecos) {
      expect(h.textContent, "hay un hueco ofrecido en horas cerradas").not.toMatch(/^08:/);
    }
  });

  it("V1-5 — la PAUSA declarada del local se resta de los huecos y se pinta como zona sin botón", () => {
    // El calendario de la demostración no trae hoy ninguna pausa de local
    // (demoSalonVenue no declara `breakStart`), así que este caso se demuestra
    // con un horario que sí la declara. El dato NO se inventa: `breakStart`
    // y `breakEnd` viajan ya en la instantánea (ConsoleWeeklyScheduleView) y
    // son los mismos que `resolveDayWindows` usa para partir el día en dos.
    const { hooks } = loadHooksOnly();
    const conPausa = {
      ...CAL,
      weeklySchedules: [1, 2, 3, 4, 5, 6].map((dow) => ({
        ownerKind: "venue", dayOfWeek: dow, workDayStart: "09:00", workDayEnd: "18:00",
        breakStart: "13:00", breakEnd: "14:00",
      })),
      reservations: [],
    };
    const snap = { calendar: conPausa };
    const axis = hooks.resolveAgendaDayAxis("2026-08-04", snap, [3]);
    const ventana = hooks.agendaVentanaDelDia("2026-08-04", snap, axis);
    expect(ventana!.pausa).toEqual({ startMinutes: 780, endMinutes: 840 });

    const huecos = hooks.agendaHuecosDeColumna(axis, [], [], ventana);
    // Dos huecos, uno a cada lado de la pausa: nunca uno solo de 09:00 a 18:00.
    expect(huecos).toEqual([
      { startMinutes: 540, endMinutes: 780 },
      { startMinutes: 840, endMinutes: 1080 },
    ]);
    const zonas = hooks.agendaZonasCerradasDeColumna(axis, ventana);
    expect(zonas).toEqual([{ startMinutes: 780, endMinutes: 840, motivo: "Pausa del local" }]);
  });

  it("V1-4 — en la Semana, un día que no abre no ofrece ni un hueco aunque el eje común esté abierto", () => {
    // El eje de la Semana es la UNIÓN de las ventanas de los siete días: un
    // domingo (sin fila = cerrado) comparte un eje abierto con sus vecinos.
    const { hooks } = loadHooksOnly();
    const snap = { calendar: CAL };
    const eje = hooks.agendaEjeSemana(
      ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"],
      snap,
      [3],
    );
    expect(eje.open).toBe(true);
    // 2026-08-09 es domingo: el local no abre.
    expect(hooks.agendaVentanaDelDia("2026-08-09", snap, eje)).toBeNull();
    expect(hooks.agendaHuecosDeColumna(eje, [], [], hooks.agendaVentanaDelDia("2026-08-09", snap, eje))).toEqual([]);
    // Y toda la columna se pinta como cerrada, con su motivo.
    expect(hooks.agendaZonasCerradasDeColumna(eje, null)).toEqual([
      { startMinutes: eje.startMinutes, endMinutes: eje.endMinutes, motivo: "El local no abre este día" },
    ]);
  });
});

// =====================================================================
// V2-5 — el nombre accesible de una cita dice también CUÁNTO DURA.
// La misión lo exige (inicio, fin, duración, cliente, profesional) y el §A7
// del normativo lo daba por hecho: era una errata, la duración no estaba.
// DISCRIMINANTE contra `cc93155`.
// =====================================================================

describe("step 26 · V2-5 — el nombre accesible de una cita dice la duración", () => {
  it("el aria-label del bloque trae inicio, fin, DURACIÓN, cliente y profesional, en ese orden", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p3");
    const columna = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!;
    const items = columna.children.find((c) => c.className === "tx-agenda-col__items")!;
    const bloques = items.children.filter((li) => li.className.includes("tx-agenda-block"));
    const etiquetas = bloques.map((li) => li.children[0]!.getAttribute("aria-label") ?? "");
    expect(etiquetas.length).toBeGreaterThan(2);
    // res-1: 09:00–09:30 (30 min) · res-3: 12:00–13:00 (1 hora) ·
    // res-4: 15:00–17:30 (2 horas y 30 minutos).
    expect(etiquetas).toContain("Cita de 09:00 a 09:30 · 30 minutos · Cliente por teléfono · Barba · con Álex (sintético). Ver acciones.");
    expect(etiquetas.some((e) => e.includes("· 1 hora ·"))).toBe(true);
    expect(etiquetas.some((e) => e.includes("· 2 horas y 30 minutos ·"))).toBe(true);
    // Y NINGUNA se queda sin decirlo.
    for (const e of etiquetas) {
      expect(e, e).toMatch(/^Cita de \d{2}:\d{2} a \d{2}:\d{2} · (\d+ minutos|1 hora|\d+ horas)( y \d+ minutos)? · /);
    }
  });

  it("la duración se dice como se habla: minutos sueltos, «1 hora», «2 horas y 30 minutos»", () => {
    const { hooks } = loadHooksOnly();
    const nombre = (ini: number, fin: number) =>
      hooks.agendaNombreAccesibleBloque({ startMinutes: ini, endMinutes: fin, serviceId: 0 }, "Álex (sintético)");
    expect(nombre(540, 555)).toContain("· 15 minutos ·");
    expect(nombre(540, 600)).toContain("· 1 hora ·");
    expect(nombre(540, 660)).toContain("· 2 horas ·");
    expect(nombre(540, 645)).toContain("· 1 hora y 45 minutos ·");
  });
});

// =====================================================================
// V3-7 — UN DIÁLOGO ABIERTO NO SOBREVIVE AL CAMBIO DE RUTA.
// El enrutador sólo conmuta `hidden` en las siete <section>, y un
// `<dialog open>` vive fuera de ellas: quedaba flotando sobre una pantalla
// que no tiene nada que ver con él. DISCRIMINANTE contra `cc93155`, donde
// `hashchange` llamaba directamente a `applyRoute`.
// =====================================================================

describe("step 26 REAPERTURA · V3-7 — el cambio de ruta recoge los diálogos abiertos", () => {
  it("cambiar de ruta con un diálogo abierto lo cierra, y NO le roba el foco a la ruta nueva", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-08-05/p3" }, scrollTo: () => {} };
    const { document, nodes, hooks } = await montadoConWindow(win);
    // El mismo cableado que hace DOMContentLoaded: sin él no habría manejador
    // de `close` y la mitad «no le roba el foco» no estaría comprobando nada.
    hooks.wireCitaDetalleDialog();
    const disparador = nodes["agenda-titulo-rango"]!;
    hooks.abrirDialogoCitaDetalle(
      { id: "res-1", employeeId: 3, serviceId: 0, date: "2026-08-05", startMinutes: 540, endMinutes: 570, status: "confirmed", eligibleForNoShow: false },
      disparador,
    );
    expect((nodes["dialogo-cita-detalle"] as FakeElement).open).toBe(true);

    // Cambio de ruta: el mismo manejador que el navegador registra en
    // `hashchange`, no una función de conveniencia de la prueba.
    win.location.hash = "#/agenda/semana/2026-08-05/p3";
    hooks.alCambiarElHash();

    expect((nodes["dialogo-cita-detalle"] as FakeElement).open, "el diálogo sigue abierto sobre otra pantalla").toBe(false);
    // El foco lo ha colocado la ruta nueva (§R15 A3, cambio de vista), no el
    // cierre del diálogo devolviéndolo a quien lo abrió.
    expect(document.activeElement).toBe(nodes["agenda-titulo-rango"]);
  });

  it("el manejador de hashchange es el que recoge la mesa, no `applyRoute` a secas", () => {
    const js = renderConsoleAppJs();
    expect(js).toContain("window.addEventListener('hashchange', alCambiarElHash)");
    expect(js).not.toContain("window.addEventListener('hashchange', applyRoute)");
  });

  it("cerrar por cambio de ruta no devuelve el foco al disparador; cerrar a mano, sí", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-08-05/p3" }, scrollTo: () => {} };
    const { document, nodes, hooks } = await montadoConWindow(win);
    hooks.wireCitaDetalleDialog(); // el mismo cableado que DOMContentLoaded
    const disparador = nodes["agenda-titulo-rango"]!;
    // (a) A mano: el foco vuelve a quien lo abrió, como siempre.
    hooks.abrirDialogoCitaDetalle(
      { id: "res-1", employeeId: 3, serviceId: 0, date: "2026-08-05", startMinutes: 540, endMinutes: 570, status: "confirmed", eligibleForNoShow: false },
      disparador,
    );
    (nodes["dialogo-cita-detalle"] as FakeElement).close();
    expect(document.activeElement).toBe(disparador);
    // (b) Por cambio de ruta: el foco NO se toca aquí.
    hooks.abrirDialogoCitaDetalle(
      { id: "res-1", employeeId: 3, serviceId: 0, date: "2026-08-05", startMinutes: 540, endMinutes: 570, status: "confirmed", eligibleForNoShow: false },
      disparador,
    );
    (nodes["tx-freshness"] as FakeElement).focus();
    hooks.cerrarDialogosAbiertos();
    expect((nodes["dialogo-cita-detalle"] as FakeElement).open).toBe(false);
    expect(document.activeElement, "el cierre por ruta ha movido el foco").toBe(nodes["tx-freshness"]);
  });
});

// =====================================================================
// A7 — cambio Día→Semana→Día sin estado rancio (mismo ancla, mismos datos).
// =====================================================================

describe("step 26 · A7 — cambiar de vista no deja estado rancio", () => {
  it("Día→Semana→Día, mismo ancla: el resultado es idéntico a haber entrado directamente en Día", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-08-05/p3" }, scrollTo: () => {} };
    const { document, nodes } = fullDom();
    const hooks = loadUiClientHooks("", document, win);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve(SNAP) })) as typeof fetch;
    try {
      hooks.applyRoute();
      await hooks.refresh();
      const items0 = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!.children.find((c) => c.className === "tx-agenda-col__items")!;
      const clavesDia1 = items0.children.map((c) => c.getAttribute("data-key")).sort();

      win.location.hash = "#/agenda/semana/2026-08-05/p3";
      hooks.applyRoute();
      await hooks.refresh();
      win.location.hash = "#/agenda/dia/2026-08-05/p3";
      hooks.applyRoute();
      await hooks.refresh();

      const itemsFinal = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!.children.find((c) => c.className === "tx-agenda-col__items")!;
      const clavesFinal = itemsFinal.children.map((c) => c.getAttribute("data-key")).sort();
      expect(clavesFinal).toEqual(clavesDia1);
      expect(nodes["agenda-rejilla"]!.className).not.toContain("cols-7");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// =====================================================================
// A10 — foco al cambiar de vista/fecha; el sondeo no lo mueve ni reconstruye
// bajo foco.
// =====================================================================

describe("step 26 · A10 — foco y sondeo", () => {
  it("cambiar de VISTA mueve el foco a #agenda-titulo-rango", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-08-05/todos" }, scrollTo: () => {} };
    const { document, nodes } = fullDom();
    const hooks = loadUiClientHooks("", document, win);
    hooks.applyRoute();
    win.location.hash = "#/agenda/semana/2026-08-05/todos";
    hooks.applyRoute();
    expect(document.activeElement).toBe(nodes["agenda-titulo-rango"]);
  });

  it("cambiar SÓLO el filtro de profesional NO mueve el foco", async () => {
    const win = { location: { hash: "#/agenda/dia/2026-08-05/todos" }, scrollTo: () => {} };
    const { document, nodes } = fullDom();
    const hooks = loadUiClientHooks("", document, win);
    hooks.applyRoute();
    (nodes["agenda-filtro-profesional"] as FakeElement).focus();
    win.location.hash = "#/agenda/dia/2026-08-05/p3";
    hooks.applyRoute();
    expect(document.activeElement).toBe(nodes["agenda-filtro-profesional"]);
  });

  it("el sondeo (refresh) nunca llama a applyRoute y por tanto nunca mueve el foco", async () => {
    const { document, nodes, hooks } = await montado("#/agenda/dia/2026-08-05/p3");
    (nodes["agenda-filtro-profesional"] as FakeElement).focus();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve(SNAP) })) as typeof fetch;
    try {
      await hooks.refresh();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(document.activeElement).toBe(nodes["agenda-filtro-profesional"]);
  });

  it("un bloque con el foco puesto no se reconstruye bajo el sondeo de 2s (misma clave, mismos datos)", async () => {
    const { nodes, hooks } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!.children.find((c) => c.className === "tx-agenda-col__items")!;
    const bloque = items.children.find((li) => li.getAttribute("data-key") === "res-1")!;
    const boton = bloque.children[0]! as FakeElement;
    boton.focus();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve(SNAP) })) as typeof fetch;
    try {
      await hooks.refresh();
    } finally {
      globalThis.fetch = originalFetch;
    }
    const itemsDespues = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!.children.find((c) => c.className === "tx-agenda-col__items")!;
    const bloqueDespues = itemsDespues.children.find((li) => li.getAttribute("data-key") === "res-1")!;
    expect(bloqueDespues.children[0]).toBe(boton); // el botón sigue siendo EL MISMO nodo
  });
});

// =====================================================================
// A11 — cero aria-live nuevo en Agenda; un solo <h1>; sin role=grid; sin
// tabindex positivo.
// =====================================================================

describe("step 26 · A11 — accesibilidad estructural", () => {
  const html = renderConsoleHtml();
  const agenda = html.slice(html.indexOf('id="vista-agenda"'), html.indexOf('id="vista-lista-espera"'));
  // El explorador "Comprobar huecos sintéticos" (step 19 Capacidad 1) YA
  // vivía dentro de Agenda antes de esta misión y ya llevaba SU aria-live
  // propia (#huecos-recuento) — decisión ajena a step 26. Lo que la
  // decisión 9 prohíbe es que la AGENDA MULTIVISTA añada una nueva; se
  // comprueban por separado los controles/contenedores nuevos, excluyendo
  // ese panel heredado.
  // (step 26 REAPERTURA §R4) La exclusión de ese panel se hace RECORTÁNDOLO
  // por sus propias etiquetas, no por su posición relativa a
  // `#agenda-rejilla`: R4 lo baja al final de la Agenda y lo convierte en un
  // `<details>`, así que la composición anterior («todo lo de antes del panel»
  // + «todo lo que va de la rejilla en adelante») volvería a INCLUIRLO. Misma
  // intención, escrita de forma independiente del orden.
  const inicioPanel = agenda.lastIndexOf("<", agenda.indexOf('id="huecos-panel"'));
  const finPanel = agenda.indexOf("</details>", inicioPanel) + "</details>".length;
  const nuevo = agenda.slice(0, inicioPanel) + agenda.slice(finPanel);

  it("los controles y contenedores NUEVOS de la Agenda no añaden ninguna región viva", () => {
    expect(nuevo).not.toContain("aria-live");
  });

  it("nada de role=\"grid\" ni de su familia en toda la Agenda", () => {
    expect(agenda).not.toContain('role="grid"');
    expect(agenda).not.toContain('role="row"');
    expect(agenda).not.toContain('role="gridcell"');
  });

  it("el selector de vista es el patrón de botones con aria-pressed que ya existe, no un tablist", () => {
    expect(agenda).not.toContain("tablist");
    expect(agenda).not.toContain('role="tab"');
    expect(agenda).toContain('role="group" aria-label="Vista de la agenda"');
  });

  it("hay exactamente un <h1> en todo el documento servido, y sigue siendo #tx-view-title", () => {
    expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
    expect(html).toContain('<h1 class="tx-topbar__title" id="tx-view-title"');
  });

  it("ningún tabindex positivo en la Agenda", () => {
    expect(agenda).not.toMatch(/tabindex="[1-9]/);
  });

  it("el título de rango nace con tabindex=\"-1\" para poder recibir el foco por programa", () => {
    expect(agenda).toContain('id="agenda-titulo-rango" tabindex="-1"');
  });
});

// =====================================================================
// A13 — contraste de los tres tintes de identidad y del borde del bloque.
// =====================================================================

function luminancia(hex: string): number {
  const canales = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * canales[0]! + 0.7152 * canales[1]! + 0.0722 * canales[2]!;
}
function contraste(a: string, b: string): number {
  const la = luminancia(a);
  const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("step 26 · A13 — contraste de la paleta de identidad", () => {
  const TEXT_STRONG = "#171615";
  const TEXT_BODY = "#3D3833";
  const DIVIDER_STRONG = "#7E766A";
  const IDENTITY = { 1: "#EBE4D6", 2: "#E6ECF2", 3: "#F0E7EF" };

  it("--tx-text-strong y --tx-text-body llegan a 4,5:1 sobre los tres tintes de identidad", () => {
    for (const tinte of Object.values(IDENTITY)) {
      expect(contraste(TEXT_STRONG, tinte)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(TEXT_BODY, tinte)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--tx-divider-strong llega a 3:1 sobre el panel y sobre los tres tintes (el borde del bloque siempre se ve)", () => {
    expect(contraste(DIVIDER_STRONG, "#FFFFFF")).toBeGreaterThanOrEqual(3);
    for (const tinte of Object.values(IDENTITY)) {
      expect(contraste(DIVIDER_STRONG, tinte)).toBeGreaterThanOrEqual(3);
    }
  });

  it("el CSS servido declara exactamente los tokens de identidad de la decisión 8, ni uno más", () => {
    expect(CONSOLE_CSS).toContain("--tx-slate-50:     #E6ECF2;");
    expect(CONSOLE_CSS).toContain("--tx-plum-50:      #F0E7EF;");
    expect(CONSOLE_CSS).toContain("--tx-identity-1-bg: var(--tx-sand-100);");
    expect(CONSOLE_CSS).toContain("--tx-identity-2-bg: var(--tx-slate-50);");
    expect(CONSOLE_CSS).toContain("--tx-identity-3-bg: var(--tx-plum-50);");
  });

  it("la asignación de identidad es por POSICIÓN (employeeId ascendente) módulo 3, determinista", () => {
    const { hooks } = loadHooksOnly();
    expect(hooks.agendaIdentidadClase(3, PROFESIONALES)).toBe("tx-agenda-block--identity-1");
    expect(hooks.agendaIdentidadClase(6, PROFESIONALES)).toBe("tx-agenda-block--identity-2");
    expect(hooks.agendaIdentidadClase(9, PROFESIONALES)).toBe("tx-agenda-block--identity-3");
  });

  it("una cita cancelada pierde su tinte de identidad: nunca vive en la rejilla", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = nodes["agenda-rejilla"]!.children.find((c) => c.tagName === "SECTION")!.children.find((c) => c.className === "tx-agenda-col__items")!;
    expect(items.children.some((li) => li.getAttribute("data-key") === "res-5")).toBe(false);
  });
});

// =====================================================================
// A15 se ha MOVIDO a tests/console/horariosYAusencias.test.ts (step 26
// REAPERTURA §7.1 del normativo: este fichero es propiedad exclusiva de la
// Oleada A1, que no tiene permiso para tocar rutas ni renombrar
// renderCalendario/vista-calendario — eso es de la Oleada B).
// =====================================================================

// =====================================================================
// step 26 REAPERTURA · Decisión R6 — Defecto 2: los rótulos de hora del eje
// de la Agenda (vista Día) se acumulaban en vez de reutilizarse.
//
// `agendaPintarEje` (`ui.js.ts:3565-3585`) es el único de los ~60 puntos de
// llamada de `reconcileList` que ignora `existing` y crea un nodo nuevo
// SIEMPRE: cada ciclo de sondeo (POLL_MS=2000) añadía `axis.ticks` nodos más
// al eje sin borrar los anteriores (la pasada de borrado de reconcileList no
// los toca: su data-key sigue en usedKeys). Con el eje de 34 tics del local
// (09:30–18:00 en producción; 09:00–18:00 en este fixture), a las dos pasadas
// hay 68 nodos, y a los ~66s (33 pasadas) hay 1156.
//
// EL INVARIANTE QUE SE PRUEBA (contrato de R6.a): para todo K>=1 pasadas
// sobre el mismo eje, el nº de hijos de .tx-agenda-grid__axis es EXACTAMENTE
// axis.ticks. Se escribe contra axis.ticks, no contra 34, para que la prueba
// siga valiendo si cambia el horario del fixture (igual que hace el
// normativo, (internal doc, not included in the template) §R6).
//
// A16/A17 fallan contra `c21118b`, que no tiene NI R6.a NI R6.b: dan 68 y 170
// respectivamente (34 × nº de pasadas totales, contando la pintura inicial de
// `montado()` como la primera pasada).
//
// PERO NO SON SUFICIENTES, y el docblock que había aquí afirmaba que sí.
// HALLAZGO V3-3 de la revisión adversarial: A16/A17 sólo cuentan hijos, y
// R6.b —el endurecimiento de `reconcileList`, que borra el huérfano de una
// clave reclamada— hace que ese recuento vuelva a ser correcto AUNQUE R6.a
// esté revertido. Con las dos reparaciones en el árbol, revertir R6.a dejaba
// la suite en verde: la prueba del defecto del eje era VACUA.
//
// A16b es la que falta: afirma la IDENTIDAD DE NODO. Se marca cada tic con
// una propiedad de objeto (no un atributo: un atributo podría copiarse) y se
// comprueba que los MISMOS elementos siguen ahí tras el sondeo siguiente. Con
// R6.a revertido, `agendaPintarEje` construye un nodo nuevo por tic, R6.b
// borra los viejos, el recuento cuadra... y la marca ha desaparecido. Es la
// diferencia entre «hay 34 tics» y «son los 34 tics de antes», que es lo que
// R6.a promete de verdad.
// =====================================================================

describe("step 26 REAPERTURA · R6.a — el eje de la Agenda reutiliza sus tics, no los duplica", () => {
  function ejeDe(nodes: Record<string, FakeElement>): FakeElement {
    const eje = nodes["agenda-rejilla"]!.children.find((c) => c.className === "tx-agenda-grid__axis");
    expect(eje, "no se encuentra .tx-agenda-grid__axis dentro de #agenda-rejilla").toBeDefined();
    return eje!;
  }

  /**
   * `pasadasExtra` llamadas adicionales a `hooks.refresh()` tras la pintura
   * inicial, con el `fetch` simulado activo durante TODAS ellas (ver
   * `montadoPersistente`: `montado()` restaura el `fetch` real nada más
   * montar, así que un `refresh()` posterior a secas no repintaría nada).
   */
  async function montadoConPasadas(hash: string, pasadasExtra: number, snapshot: Json = SNAP) {
    const { document, nodes, hooks, cerrar } = montadoPersistente(hash, snapshot);
    try {
      await hooks.refresh(); // pasada 1 (pintura inicial)
      for (let i = 0; i < pasadasExtra; i += 1) await hooks.refresh();
    } finally {
      cerrar();
    }
    return { document, nodes, hooks };
  }

  it("A16 — dos pasadas sobre el mismo eje: sigue teniendo axis.ticks hijos, sin data-key repetida ni hora duplicada en un mismo tic", async () => {
    const { nodes, hooks } = await montadoConPasadas("#/agenda/dia/2026-08-05/todos", 1); // pasada 2 = 1er sondeo — c21118b duplica aquí: 34 -> 68
    const axis = hooks.resolveAgendaDayAxis("2026-08-05", SNAP, [3, 6, 9]);

    const eje = ejeDe(nodes);
    expect(eje.children.length, `tras 2 pasadas, hijos del eje != axis.ticks (${String(axis.ticks)})`).toBe(axis.ticks);

    const claves = eje.children.map((c) => c.getAttribute("data-key"));
    expect(new Set(claves).size, "hay data-key repetidas en el eje").toBe(claves.length);

    for (const tic of eje.children) {
      expect(tic.textContent ?? "", `el tic ${String(tic.getAttribute("data-key"))} repite la hora dentro de su propio textContent`).not.toMatch(/^(\d{2}:\d{2})\1/);
    }
  });

  it("A16b — IDENTIDAD: los tics del eje son los MISMOS nodos entre dos pasadas, no nodos nuevos que cuadran el recuento", async () => {
    // La prueba que falta (V3-3). Cae con R6.a revertido aunque R6.b siga en
    // pie; A16/A17, que sólo cuentan, no caen.
    const { nodes, hooks, cerrar } = montadoPersistente("#/agenda/dia/2026-08-05/todos", SNAP);
    try {
      await hooks.refresh();
      const antes = ejeDe(nodes).children.slice();
      expect(antes.length, "el eje no ha pintado ni un tic: la prueba no estaría comprobando nada").toBeGreaterThan(4);
      // La marca va en el OBJETO, no en un atributo: un atributo se podría
      // copiar a un nodo nuevo; una propiedad propia, no.
      antes.forEach((tic, i) => { (tic as unknown as Record<string, unknown>).__marcaDeIdentidad = `tic-${String(i)}`; });

      await hooks.refresh();

      const despues = ejeDe(nodes).children;
      expect(despues.length, "el recuento de tics ha cambiado entre pasadas").toBe(antes.length);
      // (1) Los mismos objetos, en el mismo orden.
      for (let i = 0; i < antes.length; i += 1) {
        expect(despues[i], `el tic ${String(i)} es un nodo DISTINTO: el eje se ha reconstruido`).toBe(antes[i]);
      }
      // (2) Y la marca sobrevive — dicho de la otra forma, por si algún día
      // `toBe` sobre nodos falsos dejara de discriminar.
      expect(despues.map((t) => (t as unknown as Record<string, unknown>).__marcaDeIdentidad))
        .toEqual(antes.map((_t, i) => `tic-${String(i)}`));
      // (3) El contenido sigue siendo el correcto: reutilizar no es congelar.
      const axis = hooks.resolveAgendaDayAxis("2026-08-05", SNAP, [3, 6, 9]);
      expect(despues.length).toBe(axis.ticks);
      const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      expect(despues[0]!.textContent).toBe(hhmm(axis.startMinutes));
    } finally {
      cerrar();
    }
  });

  it("A17 — cinco pasadas seguidas (refresh() ×5, contando la pintura inicial): sigue dando exactamente axis.ticks", async () => {
    const { nodes, hooks } = await montadoConPasadas("#/agenda/dia/2026-08-05/todos", 4); // 1 inicial + 4 = 5 — c21118b: 34*5 = 170
    const axis = hooks.resolveAgendaDayAxis("2026-08-05", SNAP, [3, 6, 9]);

    const eje = ejeDe(nodes);
    expect(eje.children.length, `tras 5 pasadas, hijos del eje != axis.ticks (${String(axis.ticks)})`).toBe(axis.ticks);
  });
});

// =====================================================================
// step 26 REAPERTURA · Decisión R6.b — endurecimiento defensivo de
// reconcileList: un hijo cuya data-key haya sido RECLAMADA por otro nodo se
// borra, aunque la clave siga en usedKeys. R6.a arregla el defecto conocido
// (agendaPintarEje); R6.b impide la CLASE entera de defecto para cualquiera
// de los ~60 puntos de llamada presentes o futuros que cometan el mismo
// error (construir un nodo nuevo en vez de reutilizar `existing`).
//
// A18/A19 FALLAN contra el commit de R6.a (y contra c21118b): sin el
// endurecimiento, un huérfano con una data-key viva sobrevive para siempre
// —es exactamente el defecto 2, generalizado a cualquier llamante—.
// =====================================================================

describe("step 26 REAPERTURA · R6.b — reconcileList borra los huérfanos de una clave reclamada", () => {
  it("A18 — un hijo huérfano con una data-key viva se borra: el contenedor queda con exactamente items.length hijos", () => {
    const { document } = createFakeDocumentWithIds([]);
    const contenedor = document.createElement("div");
    const huerfano = document.createElement("div");
    huerfano.setAttribute("data-key", "A");
    contenedor.appendChild(huerfano);

    const hooks = loadUiClientHooks("", document);
    // Un buildRow deliberadamente MALO — como era agendaPintarEje antes de
    // R6.a —, que ignora `existing` y siempre construye un nodo nuevo. Es el
    // peor caso que R6.b tiene que seguir cubriendo aunque R6.a ya haya
    // corregido el único punto de llamada conocido.
    const buildRow = () => document.createElement("div");
    hooks.reconcileList(contenedor, ["A", "B"], (k) => k as string, buildRow);

    expect(contenedor.children.length, "el huérfano de clave 'A' no se ha borrado").toBe(2);
    expect(contenedor.children.includes(huerfano), "el huérfano original sigue en el contenedor").toBe(false);
    const claves = contenedor.children.map((c) => c.getAttribute("data-key"));
    expect(claves).toEqual(["A", "B"]);
  });

  it("A19 — candado de la guarda de foco: el huérfano que contiene document.activeElement NO se borra", () => {
    const { document } = createFakeDocumentWithIds([]);
    const contenedor = document.createElement("div");
    const huerfano = document.createElement("div");
    huerfano.setAttribute("data-key", "A");
    const enlace = document.createElement("a");
    huerfano.appendChild(enlace);
    contenedor.appendChild(huerfano);
    document.activeElement = enlace;

    const hooks = loadUiClientHooks("", document);
    const buildRow = () => document.createElement("div");
    hooks.reconcileList(contenedor, ["A", "B"], (k) => k as string, buildRow);

    // El huérfano sobrevive PORQUE tiene el foco — igual que hoy sobrevive un
    // nodo cuya clave ha desaparecido de items (step 16, O3). El nodo nuevo
    // de la clave 'A' se construye e inserta igualmente: la reconciliación no
    // se detiene por el foco, sólo el BORRADO se aplaza.
    expect(contenedor.children.includes(huerfano), "el huérfano con foco se ha borrado").toBe(true);
    expect(contenedor.children.length).toBe(3);
    expect(document.activeElement).toBe(enlace);
  });
});

// =====================================================================
// step 26 REAPERTURA · candado de «no hay una segunda fuga» (P11): un
// ciclo completo de vistas, fechas y filtros no hace crecer el recuento de
// nodos bajo #vista-agenda. Discriminante SÓLO para el eje (que R6 ya
// cubre arriba); para el resto de contenedores es un candado de no
// regresión, tal y como pide el normativo (A20).
// =====================================================================

describe("step 26 REAPERTURA · A20 — diez ciclos de vistas/fechas/filtros no hacen crecer los nodos de Agenda", () => {
  it("el recuento de nodos bajo #vista-agenda no crece entre la iteración 2 y la 10 (la 1 se descarta: construye)", async () => {
    const { nodes, hooks, cerrar } = montadoPersistente("#/agenda/dia/2026-08-05/todos");
    try {
      await hooks.refresh(); // pintura inicial

      function contarNodos(raiz: FakeElement): number {
        let total = 1;
        for (const hijo of raiz.children) total += contarNodos(hijo);
        return total;
      }

      // El DOM falso de este fichero (`fakeDom.ts`) siembra los `id` de
      // Agenda como hermanos sueltos, no como el árbol real de
      // `ui.html.ts` — no existe un `#vista-agenda` del que colgar todo. Se
      // suma el recuento de los CUATRO contenedores donde Agenda pinta
      // contenido dinámico (los demás `id` de AGENDA_IDS son controles
      // estáticos que no crecen), que es el equivalente funcional de «los
      // nodos bajo #vista-agenda» para lo que esta prueba quiere demostrar:
      // que ningún ciclo de vistas/fechas/filtros deja nodos huérfanos.
      const CONTENEDORES_DINAMICOS = ["agenda-rejilla", "agenda-semana-resumen", "agenda-mes", "agenda-dias"] as const;
      function totalNodos(): number {
        return CONTENEDORES_DINAMICOS.reduce((acc, id) => acc + contarNodos(nodes[id]!), 0);
      }

      const vistas = ["semana", "mes", "lista", "dia"] as const;
      const fechas = ["2026-08-05", "2026-08-06", "2026-08-05"] as const;
      const filtros = ["p3", "todos"] as const;

      const recuentos: number[] = [];
      for (let ciclo = 0; ciclo < 10; ciclo += 1) {
        for (const vista of vistas) {
          hooks.navegarAgenda(vista, hooks.agendaFechaTrasPaso(vista, "2026-08-05", 0), "todos");
          hooks.applyRoute();
          await hooks.refresh();
        }
        for (const fecha of fechas) {
          hooks.navegarAgenda("dia", fecha, "todos");
          hooks.applyRoute();
          await hooks.refresh();
        }
        for (const filtro of filtros) {
          hooks.navegarAgenda("dia", "2026-08-05", filtro);
          hooks.applyRoute();
          await hooks.refresh();
        }
        recuentos.push(totalNodos());
      }

      // La 1ª iteración construye contenido que las siguientes reutilizan
      // (secciones de Semana/Mes/Lista que antes no existían) — se descarta,
      // tal y como pide el normativo.
      const desdeSegunda = recuentos.slice(1);
      const maximo = Math.max(...desdeSegunda);
      const minimo = Math.min(...desdeSegunda);
      expect(maximo, `el recuento de nodos crece entre iteraciones: ${JSON.stringify(recuentos)}`).toBe(minimo);
    } finally {
      cerrar();
    }
  });
});

// =====================================================================
// Reparación adversarial (hallazgos 1/2) — la rejilla de Agenda NUNCA
// desborda en horizontal, ni en Semana (7 columnas) ni en Día (4 columnas).
//
// El ANCHO DISPONIBLE no es el más ancho de la pantalla: es el PEOR CASO
// real, en vw=1120px — justo ANTES de que la barra lateral se repliegue a
// raíl en 1119px (§4.5 de ui.css.ts) — donde la barra sigue a 200px, la
// reserva de scrollbar de `overflow-y: scroll` cuesta ~17px, y
// `.tx-workspace` está acotado a 1000px con 24px de relleno por lado
// (@media max-width:1439px):
//   ancho principal   = 1120 − 200 (barra) − 17 (reserva) = 903
//   ancho de workspace = min(903, 1000) = 903
//   ANCHO DE CONTENIDO = 903 − 24×2 = 855px
// Con el hueco entre columnas ya comprimido a 8px en esa misma anchura
// (@media max-width:1279px): eje (48px) + N×suelo + N×hueco ≤ 855.
// =====================================================================

describe("step 26 · reparación adversarial — la rejilla nunca desborda en horizontal", () => {
  const ANCHO_DISPONIBLE_PEOR_CASO = 855; // vw=1120px — ver la aritmética arriba
  const EJE_PX = 48; // 3rem
  const HUECO_COMPRIMIDO_PX = 8; // var(--tx-space-2), activo en ese mismo vw (@media max-width:1279px)

  /** Lee el suelo real (en rem) de `.tx-agenda-grid--cols-N` tal y como lo sirve el CSS de verdad. */
  function sueloDeColumnas(n: number): number {
    const regla = new RegExp(`\\.tx-agenda-grid--cols-${String(n)} \\{ grid-template-columns: 3rem repeat\\(${String(n)}, minmax\\(([\\d.]+)rem, 1fr\\)\\); \\}`).exec(CONSOLE_CSS);
    if (!regla) throw new Error(`No se encuentra la regla de .tx-agenda-grid--cols-${String(n)} en el CSS servido`);
    return Number(regla[1]);
  }

  function anchoMinimoRequerido(sueloRem: number, columnas: number): number {
    return EJE_PX + columnas * (sueloRem * 16) + columnas * HUECO_COMPRIMIDO_PX;
  }

  it("Semana (7 columnas) — el suelo real cabe en el peor caso, con margen", () => {
    const suelo = sueloDeColumnas(7);
    const requerido = anchoMinimoRequerido(suelo, 7);
    expect(requerido).toBeLessThanOrEqual(ANCHO_DISPONIBLE_PEOR_CASO);
    // (V3-13) Aquí había un `expect(anchoMinimoRequerido(12, 7)).toBeGreaterThan(…)`:
    // aritmética de la prueba sobre dos literales, que no observa el producto
    // ni puede fallar por un cambio en él. El candado de verdad —que NINGUNA
    // regla --cols-N de la hoja servida desborde— vive más abajo, en su propio
    // caso, y barre todas las reglas que el CSS sirve de verdad.
  });

  it("Día (hasta 4 columnas) — el suelo real cabe con margen cómodo, no 'al filo'", () => {
    const suelo = sueloDeColumnas(4);
    const requerido = anchoMinimoRequerido(suelo, 4);
    expect(requerido).toBeLessThanOrEqual(ANCHO_DISPONIBLE_PEOR_CASO);
    // Margen de verdad, no unos pocos píxeles: al menos medio tic (14px) de sobra.
    expect(ANCHO_DISPONIBLE_PEOR_CASO - requerido).toBeGreaterThanOrEqual(14);
  });

  it("cols-1/2/3 comparten el mismo suelo que cols-4 (misma anchura de columna con cualquier filtro)", () => {
    expect(sueloDeColumnas(1)).toBe(sueloDeColumnas(4));
    expect(sueloDeColumnas(2)).toBe(sueloDeColumnas(4));
    expect(sueloDeColumnas(3)).toBe(sueloDeColumnas(4));
  });

  // =================================================================
  // V2-4 — CINCO Y SEIS PROFESIONALES. `agendaClaseColumnas` escribía
  // `--cols-5`/`--cols-6` y esas reglas no existían: la rejilla se quedaba
  // con el `repeat(1, …)` del bloque base y las columnas 2..6 caían a pista
  // implícita, de anchura automática y desigual. DISCRIMINANTE contra
  // `09cd97b`.
  // =================================================================

  it("existe una regla por cada número de columnas que el cliente puede pedir — ninguna cae a pista implícita", () => {
    const { hooks } = loadHooksOnly();
    for (let n = 1; n <= 7; n += 1) {
      const clase = hooks.agendaClaseColumnas(n);
      expect(clase, `${String(n)} columnas`).toBe(`tx-agenda-grid--cols-${String(n)}`);
      // Y la regla EXISTE en la hoja servida, con su suelo declarado.
      expect(() => sueloDeColumnas(n), `no hay regla CSS para ${String(n)} columnas`).not.toThrow();
    }
  });

  it("los suelos de 5 y 6 caben en el peor caso real y son monótonos con los ya fijados", () => {
    const suelo5 = sueloDeColumnas(5);
    const suelo6 = sueloDeColumnas(6);
    expect(anchoMinimoRequerido(suelo5, 5)).toBeLessThanOrEqual(ANCHO_DISPONIBLE_PEOR_CASO);
    expect(anchoMinimoRequerido(suelo6, 6)).toBeLessThanOrEqual(ANCHO_DISPONIBLE_PEOR_CASO);
    // Más columnas nunca dan una columna MÁS ancha: 11,5 ≥ 9 ≥ 7,5 ≥ 6,5.
    expect(sueloDeColumnas(4)).toBeGreaterThanOrEqual(suelo5);
    expect(suelo5).toBeGreaterThanOrEqual(suelo6);
    expect(suelo6).toBeGreaterThanOrEqual(sueloDeColumnas(7));
  });

  it("NINGUNA regla --cols-N de la hoja desborda el peor caso real (barrido, no una comprobación aritmética sobre literales)", () => {
    // V3-13: aquí había un `expect(anchoMinimoRequerido(12, 7)).toBeGreaterThan(…)`,
    // que es aritmética de la propia prueba sobre dos literales — no dice nada
    // del producto. Esto sí: recorre TODAS las reglas `--cols-N` que la hoja
    // sirve de verdad y comprueba cada una contra el mismo peor caso.
    const reglas = [...CONSOLE_CSS.matchAll(/\.tx-agenda-grid--cols-(\d+) \{ grid-template-columns: 3rem repeat\((\d+), minmax\(([\d.]+)rem, 1fr\)\); \}/g)];
    expect(reglas.length, "no se encuentran las reglas --cols-N en el CSS servido").toBe(7);
    for (const [, n, repeticiones, suelo] of reglas) {
      expect(repeticiones, `--cols-${n} repite ${repeticiones} veces`).toBe(n);
      expect(
        anchoMinimoRequerido(Number(suelo), Number(n)),
        `--cols-${n} (suelo ${suelo}rem) no cabe en el peor caso real de ${String(ANCHO_DISPONIBLE_PEOR_CASO)}px`,
      ).toBeLessThanOrEqual(ANCHO_DISPONIBLE_PEOR_CASO);
    }
  });

  it("de OCHO en adelante hay una decisión explícita: columnas iguales y desplazamiento DENTRO de la rejilla", () => {
    const { hooks } = loadHooksOnly();
    for (const n of [8, 9, 12, 40]) {
      expect(hooks.agendaClaseColumnas(n)).toBe("tx-agenda-grid--cols-muchas tx-table-scroll");
    }
    const regla = /\.tx-agenda-grid--cols-muchas \{([^}]*)\}/.exec(CONSOLE_CSS)?.[1] ?? "";
    expect(regla, "falta la regla de ocho o más columnas").not.toBe("");
    // Columnas iguales entre sí, creadas conforme se piden.
    expect(regla).toMatch(/grid-auto-columns:\s*minmax\(11\.5rem,\s*1fr\)/);
    // Y en COLUMNA: sin esto las implícitas se apilarían en filas, que es
    // justo el defecto que esta reparación cierra.
    expect(regla).toMatch(/grid-auto-flow:\s*column/);
    // El desplazamiento lo aporta `.tx-table-scroll`, una de las dos únicas
    // clases con overflow-x permitido (M25): no se estrena ninguna.
    const conScrollX = [...CONSOLE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{[^}]*overflow-x:\s*auto[^}]*\}/g)].map((m) => m[1].trim());
    expect(conScrollX.sort()).toEqual([".tx-sidebar", ".tx-table-scroll"]);
  });

  it("hoy la rejilla del Día no pasa de CUATRO columnas: por encima manda §6.3 y se cae a lista cronológica", async () => {
    // ALCANCE HONESTO de esta reparación. `renderAgendaDia` corta en cuatro
    // (§6.3): con cinco o más profesionales visibles la vista Día no pinta una
    // rejilla de cinco columnas, pinta una lista cronológica. Por eso el
    // defecto V2-4 no se puede ver hoy navegando: la revisión lo demostró
    // escribiendo la clase a mano. Lo que se repara es la GRIETA —el cliente
    // sabe escribir `--cols-5`/`--cols-6` y esas reglas no existían—, y este
    // caso deja escrito por qué la grieta no se ve, para que nadie lea las
    // reglas nuevas como una promesa de que la rejilla ya crece.
    const cinco = Array.from({ length: 5 }, (_v, i) => ({ employeeId: i + 1, label: `Pro ${String(i + 1)}` }));
    const snapCinco = { ...SNAP, calendar: { ...CAL, professionals: cinco, reservations: [] } } as Json;
    const { nodes } = await montado("#/agenda/dia/2026-08-04/todos", snapCinco);
    expect(nodes["agenda-rejilla"]!.className).not.toContain("tx-agenda-grid--cols-5");
    expect(nodes["agenda-nota-densidad"]!.hidden).toBe(false);
    // Y con tres, la rejilla de siempre, fuera del orden de tabulación.
    const { nodes: pocos } = await montado("#/agenda/dia/2026-08-04/todos");
    expect(pocos["agenda-rejilla"]!.className).toContain("tx-agenda-grid--cols-3");
    expect(pocos["agenda-rejilla"]!.className).not.toContain("tx-table-scroll");
    expect(pocos["agenda-rejilla"]!.getAttribute("tabindex")).toBe("-1");
    expect(pocos["agenda-rejilla"]!.getAttribute("role")).toBe("presentation");
  });

  // =================================================================
  // V2-3 — LAS CITAS CORTAS NO SE RECORTAN. Medido en WebKit real sobre la
  // demostración: a 1150/1120/1024 px la segunda línea de un bloque de 30
  // min se partía en dos y desbordaba su caja 5 px (scrollHeight 60 sobre
  // clientHeight 55). DISCRIMINANTE contra `09cd97b`.
  // =================================================================

  it("las líneas del bloque van con interlineado compacto, y en los bloques cortos cada línea es UNA línea", () => {
    const css = CONSOLE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.tx-agenda-block__l1,\s*\.tx-agenda-block__l2,\s*\.tx-agenda-block__l3 \{[^}]*line-height:\s*var\(--tx-leading-tight\)/);
    // Los bloques de uno y dos tics (15 y 30 min) no parten sus líneas.
    const corta = /\.tx-agenda-block\.tx-agenda-s-1 > button > span,\s*\.tx-agenda-block\.tx-agenda-s-2 > button > span \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(corta, "no hay regla para los bloques cortos").not.toBe("");
    expect(corta).toMatch(/white-space:\s*nowrap/);
    expect(corta).toMatch(/text-overflow:\s*ellipsis/);
    // Y NO se aplica a los bloques largos, que sí tienen sitio para envolver.
    expect(corta).not.toContain("tx-agenda-s-3");
  });

  it("la caja de un bloque de 30 min sólo tiene sitio para DOS líneas compactas — la aritmética que obliga a lo de arriba", () => {
    // Alto disponible = 2 tics de 1,75rem menos el filete de 1px del hueco.
    const tic = Number(/--tx-agenda-tick:\s*([\d.]+)rem/.exec(CONSOLE_CSS)![1]) * 16;
    const alto = 2 * tic - 1;
    const size200 = Number(/--tx-size-200:\s*([\d.]+)rem/.exec(CONSOLE_CSS)![1]) * 16;
    const tight = Number(/--tx-leading-tight:\s*([\d.]+)/.exec(CONSOLE_CSS)![1]);
    const normal = Number(/--tx-leading-normal:\s*([\d.]+)/.exec(CONSOLE_CSS)![1]);
    const relleno = 2 * (0.25 * 16); // padding vertical de var(--tx-space-1)
    // Con TRES líneas visuales (la segunda partida) e interlineado normal, no
    // cabe: ése era el recorte de 5px que midió la revisión.
    expect(3 * size200 * normal + relleno).toBeGreaterThan(alto);
    // Con DOS líneas compactas, cabe con holgura.
    expect(2 * size200 * tight + relleno).toBeLessThan(alto);
  });

  it("deuda D-B2-2 — la fila de acciones de un diálogo envuelve en vez de desbordar", () => {
    const css = CONSOLE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const regla = /\.tx-dialog__actions \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(regla).toMatch(/display:\s*flex/);
    expect(regla).toMatch(/flex-wrap:\s*wrap/);
    // Sin perder el anclaje a la derecha ni el orden del DOM.
    expect(regla).toMatch(/justify-content:\s*flex-end/);
  });
  // La lista blanca de overflow-x (M25) ya la vigila sistemaVisual.test.ts;
  // esta reparación no la toca (no se ha añadido overflow-x en ningún sitio).
});
