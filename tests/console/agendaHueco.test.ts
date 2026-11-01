import { describe, it, expect } from "vitest";

import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, type FakeElement } from "./fakeDom.js";

/**
 * step 26 · Capacidad A — activación de un HUECO (A8) y de una CITA (A9) en
 * la rejilla de la Agenda.
 *
 * A8 (decisión 6.6): activar un hueco abre el asistente `Crear cita manual`
 * con fecha, hora de inicio y profesional PROPUESTOS, deja al operador en el
 * paso 1, y JAMÁS confirma, reserva, salta pasos o preselecciona servicio,
 * duración o persona.
 *
 * A9 (decisión 6.6/10): activar una cita abre el detalle con las MISMAS
 * acciones que ya ofrece la vista Lista (`abrirDialogoCancelarCita`,
 * `abrirDialogoInasistencia`, `abrirDialogoCorregirInasistencia`), sin que
 * ningún identificador de la reserva sea el mensaje principal.
 *
 * Todas las pruebas de este fichero FALLAN contra `2d2e3e4`.
 */

type Json = Record<string, unknown>;

const PROFESIONALES = [
  { employeeId: 3, label: "Álex (sintético)" },
  { employeeId: 6, label: "Bea (sintética)" },
];

const WEEKLY = [1, 2, 3, 4, 5, 6].map((dow) => ({
  ownerKind: "venue",
  dayOfWeek: dow,
  workDayStart: "09:00",
  workDayEnd: "18:00",
}));

function res(id: string, employeeId: number, serviceId: number, date: string, startMinutes: number, endMinutes: number, extra: Json = {}) {
  return { id, employeeId, serviceId, date, startMinutes, endMinutes, status: "confirmed", eligibleForNoShow: false, ...extra };
}

const CAL = {
  professionals: PROFESIONALES,
  weeklySchedules: WEEKLY,
  seasonalSchedules: [],
  closures: [],
  venueRules: [],
  absences: [],
  reservations: [
    // Álex: una cita de 10:00 a 11:00, dejando huecos 09:00–10:00 y 11:00–18:00.
    res("res-cita-1", 3, 1, "2026-08-05", 600, 660),
    // Bea: una cita ELEGIBLE para inasistencia, creada A MANO.
    res("res-manual-1", 6, 0, "2026-08-05", 600, 630, {
      eligibleForNoShow: true,
      manual: { manualBookingId: "man-0007", clientLabel: "Cliente C", originLabel: "Creada manualmente por el operador" },
    }),
  ],
};

const SNAP = { engineToday: "2026-08-05", engineNowMinutes: 480, calendar: CAL };

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

const INASISTENCIA_IDS = [
  { id: "dialogo-inasistencia", tag: "dialog" },
  { id: "dialogo-inasistencia-titulo", tag: "h2" },
  "inasistencia-resumen",
  "inasistencia-manual",
  "inasistencia-sin-penalizacion",
  "inasistencia-sin-identidad",
  "inasistencia-historial",
  "inasistencia-estado",
  { id: "inasistencia-confirmar", tag: "button" },
  { id: "inasistencia-cancelar", tag: "button" },
  { id: "inasistencia-cerrar", tag: "button" },
] as const;

// El asistente "Crear cita manual" — los ids que abrirDialogoCitaManual y
// mostrarPasoManual/actualizarPuertaManual tocan de verdad.
const MANUAL_IDS = [
  { id: "dialogo-cita-manual", tag: "dialog" },
  { id: "dialogo-cita-manual-titulo", tag: "h2" },
  "manual-estado",
  "manual-error",
  "manual-huecos",
  "manual-resumen",
  "manual-resumen-profesional",
  "manual-resumen-origen",
  "manual-resumen-sintetico",
  { id: "manual-confirmar", tag: "button" },
  { id: "manual-cerrar", tag: "button" },
  "manual-profesional-campo",
  { id: "manual-fecha", tag: "input" },
  { id: "manual-servicio-0", tag: "input" },
  { id: "manual-servicio-1", tag: "input" },
  { id: "manual-servicio-2", tag: "input" },
  { id: "manual-quien-cualquiera", tag: "input" },
  { id: "manual-quien-una", tag: "input" },
  { id: "manual-persona-a", tag: "input" },
  { id: "manual-persona-b", tag: "input" },
  { id: "manual-persona-c", tag: "input" },
  { id: "manual-persona-d", tag: "input" },
  { id: "manual-persona-e", tag: "input" },
  { id: "manual-persona-f", tag: "input" },
  { id: "manual-profesional", tag: "select" },
  // (Reparación adversarial step 26, hallazgo 5 — a petición de B-UI) El
  // control Duración del paso 1 (step 26 §13): el fieldset, sus seis
  // radios (30/60/90/120/150/otra), la nota, el select de "otra duración"
  // y su aviso. A sólo deja el fixture listo — las pruebas dinámicas del
  // control son de tests/console/citaManualUi.test.ts, de B-UI.
  "manual-duracion-campo",
  { id: "manual-duracion-30", tag: "input" },
  { id: "manual-duracion-60", tag: "input" },
  { id: "manual-duracion-90", tag: "input" },
  { id: "manual-duracion-120", tag: "input" },
  { id: "manual-duracion-150", tag: "input" },
  { id: "manual-duracion-otra", tag: "input" },
  "manual-duracion-nota",
  "manual-duracion-otra-campo",
  { id: "manual-duracion-otra-valor", tag: "select" },
  "manual-duracion-aviso",
  "manual-paso-1",
  "manual-paso-2",
  "manual-paso-3",
  "manual-paso-4",
  "manual-paso-5",
  "manual-paso1-gate",
  "manual-paso2-gate",
  "manual-paso3-gate",
  "manual-paso4-gate",
  { id: "manual-siguiente-1", tag: "button" },
  { id: "manual-siguiente-2", tag: "button" },
  { id: "manual-siguiente-3", tag: "button" },
  { id: "manual-siguiente-4", tag: "button" },
] as const;

function fullDom() {
  return createFakeDocumentWithIds([...AGENDA_IDS, ...DETALLE_IDS, ...CANCELAR_IDS, ...INASISTENCIA_IDS, ...MANUAL_IDS]);
}

async function montado(hash: string, snapshot: Json = SNAP) {
  const { document, nodes } = fullDom();
  const win = { location: { hash }, scrollTo: () => {} };
  const hooks = loadUiClientHooks(hash, document, win);
  // Normalmente se engancha una sola vez en DOMContentLoaded; aquí no hay
  // navegador que lo dispare, así que se engancha a mano sobre el documento
  // falso recién sembrado.
  hooks.wireCitaDetalleDialog();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((..._args: unknown[]) => {
    fetchCalls += 1;
    return Promise.resolve({ json: () => Promise.resolve(snapshot) });
  }) as typeof fetch;
  try {
    hooks.applyRoute();
    await hooks.refresh();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { document, nodes, hooks, win, contarLlamadasAFetch: () => fetchCalls, reiniciarContadorFetch: () => (fetchCalls = 0) };
}

function itemsDeLaColumna(nodes: Record<string, FakeElement>, employeeId: number): FakeElement {
  const columnas = nodes["agenda-rejilla"]!.children.filter((c) => c.tagName === "SECTION");
  const columna = columnas.find((c) => c.children[0]!.id === "agenda-col-" + String(employeeId))!;
  return columna.children.find((c) => c.className === "tx-agenda-col__items")!;
}

// =====================================================================
// A8 — activar un hueco precarga fecha/inicio/profesional y NO confirma.
// =====================================================================

describe("step 26 · A8 — activar un hueco precarga el asistente, nunca confirma", () => {
  it("clicar un hueco abre 'Crear cita manual' con fecha y profesional precargados, y deja al operador en el paso 1", async () => {
    const { nodes, hooks, contarLlamadasAFetch, reiniciarContadorFetch } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = itemsDeLaColumna(nodes, 3);
    const hueco = items.children.find((li) => li.className.includes("tx-agenda-gap"))!;
    expect(hueco.textContent).toBe("09:00 – 10:00 · Sin cita");
    const boton = hueco.children[0]! as FakeElement & { onclick: () => void };

    reiniciarContadorFetch(); // el montaje inicial ya hizo su propio sondeo
    boton.onclick();

    expect((nodes["dialogo-cita-manual"] as FakeElement).open).toBe(true);
    const estado = hooks.manualStateActual();
    expect(estado.fecha).toBe("2026-08-05");
    expect(estado.modo).toBe("one");
    expect(estado.profesional).toBe("3");
    expect(estado.paso).toBe(1); // NUNCA salta pasos
    expect(estado.servicio).toBe(""); // NUNCA preselecciona servicio
    expect(estado.persona).toBe(""); // NUNCA preselecciona persona
    expect(estado.propuesta).toBeNull(); // NUNCA hay una propuesta pedida
    expect(estado.elegido).toBeNull(); // NUNCA hay un hueco elegido por el sistema

    // Los CONTROLES DE SIEMPRE del paso 2 —nunca campos nuevos— llevan la precarga.
    expect((nodes["manual-fecha"] as FakeElement).value).toBe("2026-08-05");
    expect((nodes["manual-quien-una"] as FakeElement).checked).toBe(true);
    expect((nodes["manual-profesional"] as FakeElement).value).toBe("3");
    expect((nodes["manual-profesional-campo"] as FakeElement).hidden).toBe(false);

    // Ningún radio de servicio ni de persona viene marcado.
    for (const id of ["manual-servicio-0", "manual-servicio-1", "manual-servicio-2", "manual-persona-a", "manual-persona-b", "manual-persona-c", "manual-persona-d", "manual-persona-e", "manual-persona-f"]) {
      expect((nodes[id] as FakeElement).checked, `#${id} viene marcado`).toBe(false);
    }

    // Sigue en el paso 1: el paso 1 es el único visible.
    expect((nodes["manual-paso-1"] as FakeElement).hidden).toBe(false);
    expect((nodes["manual-paso-2"] as FakeElement).hidden).toBe(true);
    // La puerta del paso 1 sigue cerrada — falta el servicio, que nadie ha elegido.
    expect((nodes["manual-siguiente-1"] as FakeElement).disabled).toBe(true);

    // Y no ha confirmado ni reservado nada: ni una sola llamada de red.
    expect(contarLlamadasAFetch()).toBe(0);
  });

  it("la hora de inicio propuesta se dice en el título del diálogo — el único sitio honesto, porque no hay campo de hora antes del paso 3", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = itemsDeLaColumna(nodes, 3);
    const hueco = items.children.find((li) => li.className.includes("tx-agenda-gap"))!;
    (hueco.children[0]! as FakeElement & { onclick: () => void }).onclick();
    const titulo = (nodes["dialogo-cita-manual-titulo"] as FakeElement).textContent;
    expect(titulo).toContain("Crear cita manual");
    expect(titulo).toContain("09:00");
    expect(titulo).toContain("Álex");
    expect(titulo).toContain("5 de agosto de 2026");
  });

  it("abrir el asistente por el botón normal (sin precarga) sigue sin marcar nada, y el título vuelve a ser el de siempre", async () => {
    const { nodes, hooks } = await montado("#/agenda/dia/2026-08-05/p3");
    hooks.abrirDialogoCitaManual(nodes["agenda-hoy"] as FakeElement);
    expect((nodes["dialogo-cita-manual-titulo"] as FakeElement).textContent).toBe("Crear cita manual");
    const estado = hooks.manualStateActual();
    expect(estado.modo).toBe("");
    expect(estado.profesional).toBe("");
    expect((nodes["manual-profesional-campo"] as FakeElement).hidden).toBe(true);
    expect((nodes["manual-quien-una"] as FakeElement).checked).toBe(false);
  });

  it("dos huecos distintos precargan dos profesionales distintos, sin arrastrar el anterior", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/todos");
    const huecoAlex = itemsDeLaColumna(nodes, 3).children.find((li) => li.className.includes("tx-agenda-gap"))!;
    (huecoAlex.children[0]! as FakeElement & { onclick: () => void }).onclick();
    expect((nodes["manual-profesional"] as FakeElement).value).toBe("3");

    const huecoBea = itemsDeLaColumna(nodes, 6).children.find((li) => li.className.includes("tx-agenda-gap"))!;
    (huecoBea.children[0]! as FakeElement & { onclick: () => void }).onclick();
    expect((nodes["manual-profesional"] as FakeElement).value).toBe("6");
  });
});

// =====================================================================
// A9 — activar una cita abre el detalle con las acciones existentes, sin
// identificadores.
// =====================================================================

describe("step 26 · A9 — activar una cita abre su detalle con las acciones de siempre", () => {
  it("el detalle dice intervalo, servicio, profesional y estado — nunca el identificador de la reserva", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = itemsDeLaColumna(nodes, 3);
    const bloque = items.children.find((li) => li.getAttribute("data-key") === "res-cita-1")!;
    (bloque.children[0]! as FakeElement & { onclick: () => void }).onclick();

    expect((nodes["dialogo-cita-detalle"] as FakeElement).open).toBe(true);
    expect((nodes["cita-detalle-cuando"] as FakeElement).textContent).toContain("10:00");
    expect((nodes["cita-detalle-cuando"] as FakeElement).textContent).toContain("11:00");
    expect((nodes["cita-detalle-profesional"] as FakeElement).textContent).toContain("Álex");
    expect((nodes["cita-detalle-pill"] as FakeElement).textContent).toContain("Reserva confirmada");

    for (const id of ["cita-detalle-cuando", "cita-detalle-servicio", "cita-detalle-profesional", "cita-detalle-pill"]) {
      expect((nodes[id] as FakeElement).textContent, `#${id} expone un identificador`).not.toContain("res-cita-1");
    }
    // El identificador SÍ vive en el detalle técnico, plegado.
    expect((nodes["cita-detalle-tecnico"] as FakeElement).textContent).toContain("res-cita-1");
  });

  it("una cita manual dice su origen y la persona sintética en el detalle", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p6");
    const items = itemsDeLaColumna(nodes, 6);
    const bloque = items.children.find((li) => li.getAttribute("data-key") === "res-manual-1")!;
    (bloque.children[0]! as FakeElement & { onclick: () => void }).onclick();

    expect((nodes["cita-detalle-origen"] as FakeElement).hidden).toBe(false);
    expect((nodes["cita-detalle-origen"] as FakeElement).textContent).toBe("Creada manualmente por el operador · Cliente C");
    // Nunca el identificador técnico de la cita manual fuera del plegado.
    expect((nodes["cita-detalle-origen"] as FakeElement).textContent).not.toContain("man-0007");
    expect((nodes["cita-detalle-acciones"] as FakeElement).children.some((b) => b.textContent === "Registrar inasistencia")).toBe(true);
  });

  it("'Cancelar cita' cierra el detalle y abre EXACTAMENTE el mismo diálogo que usa la vista Lista", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = itemsDeLaColumna(nodes, 3);
    const bloque = items.children.find((li) => li.getAttribute("data-key") === "res-cita-1")!;
    (bloque.children[0]! as FakeElement & { onclick: () => void }).onclick();

    const acciones = nodes["cita-detalle-acciones"] as FakeElement;
    const cancelar = acciones.children.find((b) => b.textContent === "Cancelar cita")! as FakeElement & { onclick: () => void };
    cancelar.onclick();

    expect((nodes["dialogo-cita-detalle"] as FakeElement).open).toBe(false);
    expect((nodes["dialogo-cancelar-cita"] as FakeElement).open).toBe(true);
    expect((nodes["cancelar-cita-resumen"] as FakeElement).textContent).toContain("10:00");
  });

  it("'Registrar inasistencia' sólo aparece cuando el servidor la dice elegible, y nunca sobre una ya anotada", async () => {
    const { nodes } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = itemsDeLaColumna(nodes, 3);
    const bloque = items.children.find((li) => li.getAttribute("data-key") === "res-cita-1")!; // eligibleForNoShow: false
    (bloque.children[0]! as FakeElement & { onclick: () => void }).onclick();
    const acciones = nodes["cita-detalle-acciones"] as FakeElement;
    expect(acciones.children.some((b) => b.textContent === "Registrar inasistencia")).toBe(false);
  });

  it("cerrar el detalle con 'Cerrar' no dispara ninguna acción ni ninguna llamada de red", async () => {
    const { nodes, contarLlamadasAFetch, reiniciarContadorFetch } = await montado("#/agenda/dia/2026-08-05/p3");
    const items = itemsDeLaColumna(nodes, 3);
    const bloque = items.children.find((li) => li.getAttribute("data-key") === "res-cita-1")!;
    (bloque.children[0]! as FakeElement & { onclick: () => void }).onclick();
    reiniciarContadorFetch();
    (nodes["cita-detalle-cerrar"] as FakeElement).dispatchClick();
    expect((nodes["dialogo-cita-detalle"] as FakeElement).open).toBe(false);
    expect(contarLlamadasAFetch()).toBe(0);
  });
});
