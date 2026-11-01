import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, createEquipoFakeDocument, type FakeElement } from "./fakeDom.js";

/**
 * step 26 REAPERTURA · «Horarios y ausencias».
 *
 * MOVIMIENTO DE FICHERO (§7.1 del normativo de reapertura,
 * (internal doc, not included in the template)): el bloque A15
 * (antes en `tests/console/agendaMultivista.test.ts:734-768`) se traslada
 * ÍNTEGRO aquí, byte a byte en su lógica, porque `agendaMultivista.test.ts`
 * es propiedad exclusiva de la Oleada A1 y A1 no tiene permiso para tocar
 * rutas ni renombrar `renderCalendario`/`vista-calendario` (eso es de la
 * Oleada B). El fixture que necesitaba (`CAL`) se duplica aquí, reducido a lo
 * que este bloque usa, para que el fichero quede autosuficiente.
 *
 * A propósito, este bloque sigue funcional CONTRA `c21118b` (usa
 * `renderCalendario`, `id="vista-calendario"`, `id="btn-abrir-dia-especial"`
 * y el texto «Añadir día especial», todos vigentes hoy); la Oleada B lo
 * actualizará cuando migre la navegación (R1/R2) y la pantalla (R7).
 */

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

const CAL = {
  professionals: PROFESIONALES,
  weeklySchedules: WEEKLY,
  seasonalSchedules: [],
  closures: [],
  venueRules: VENUE_RULES,
  absences: ABSENCES,
  reservations: [],
};

/**
 * Los identificadores que `renderHorariosYAusencias` toca de verdad, los
 * cuatro bloques de R7 incluidos. Se pasa la lista COMPLETA a propósito: si
 * la función empezara a leer uno que no está aquí, `byId()` devolvería `null`
 * y la prueba fallaría con un error claro, nunca en silencio.
 */
const HORARIOS_IDS_R7 = [
  // Bloque 1 — Horario habitual (consulta, R12)
  "horarios-regimen",
  { id: "horarios-semana", tag: "ul" },
  // Bloque 2 — Días especiales y cierres
  "calendario-temporada",
  "calendario-temporada-titulo",
  "calendario-temporada-detalle",
  "calendario-temporada-aviso-fecha",
  { id: "calendario-mes-titulo", tag: "span" },
  { id: "calendario-mes-anterior", tag: "a" },
  { id: "calendario-mes-siguiente", tag: "a" },
  { id: "calendario-grid-body", tag: "tbody" },
  { id: "horarios-excepciones-mes", tag: "ul" },
  "horarios-excepciones-mes-vacio",
  // Bloque 3 — Ausencias del equipo
  { id: "horarios-filtro-profesional", tag: "select" },
  { id: "horarios-ausencias", tag: "ul" },
  "horarios-ausencias-vacio",
  // Bloque 4 — Próximas excepciones, y el plegable de lo que ya ha pasado
  { id: "calendario-dias-distintos", tag: "ul" },
  "calendario-dias-distintos-vacio",
  { id: "calendario-excepciones-anteriores", tag: "ul" },
  "calendario-excepciones-anteriores-vacio",
] as const;

/** Los identificadores del diálogo de cierres y días especiales (R9, 4 pasos). */
const IDS_DIALOGO_DIA_ESPECIAL = [
  { id: "dialogo-dia-especial", tag: "dialog" },
  "dialogo-dia-especial-titulo",
  "dia-especial-paso-1",
  "dia-especial-paso-2",
  "dia-especial-paso-3",
  "dia-especial-paso-4",
  // V2-2/V3-9 — el encabezado de cada paso, que es donde aterriza el foco
  // al cambiar de paso (y por eso lleva `tabindex="-1"` en el HTML servido).
  "dia-especial-paso-1-titulo",
  "dia-especial-paso-2-titulo",
  "dia-especial-paso-3-titulo",
  "dia-especial-paso-4-titulo",
  { id: "dia-especial-tipo-cierre", tag: "input" },
  { id: "dia-especial-tipo-especial", tag: "input" },
  "dia-especial-gate",
  { id: "dia-especial-siguiente-1", tag: "button" },
  "dia-especial-campos-cierre",
  "dia-especial-campos-especial",
  { id: "dia-especial-desde", tag: "input" },
  { id: "dia-especial-hasta", tag: "input" },
  { id: "dia-especial-dia", tag: "input" },
  { id: "dia-especial-abre", tag: "input" },
  { id: "dia-especial-cierra", tag: "input" },
  { id: "dia-especial-nombre", tag: "input" },
  { id: "dia-especial-nota", tag: "input" },
  "dia-especial-nota-contador",
  "dia-especial-paso1-error",
  "dia-especial-aviso-retirada",
  { id: "dia-especial-atras-1", tag: "button" },
  { id: "dia-especial-siguiente", tag: "button" },
  "dia-especial-resumen",
  "dia-especial-impacto",
  "dia-especial-contador",
  { id: "dia-especial-atras", tag: "button" },
  { id: "dia-especial-guardar", tag: "button" },
  "dia-especial-exito",
  { id: "dia-especial-cancelar-1", tag: "button" },
  { id: "dia-especial-cancelar-2", tag: "button" },
  { id: "dia-especial-cancelar-3", tag: "button" },
  { id: "dia-especial-cerrar", tag: "button" },
] as const;

/** Los identificadores del diálogo de ausencias (R10, 4 pasos). */
const IDS_DIALOGO_AUSENCIA = [
  { id: "dialogo-ausencia", tag: "dialog" },
  "dialogo-ausencia-titulo",
  "ausencia-paso-1",
  "ausencia-paso-2",
  "ausencia-paso-3",
  "ausencia-paso-4",
  "ausencia-paso-1-titulo",
  "ausencia-paso-2-titulo",
  "ausencia-paso-3-titulo",
  "ausencia-paso-4-titulo",
  { id: "ausencia-profesional", tag: "select" },
  { id: "ausencia-motivo-vacation", tag: "input" },
  { id: "ausencia-motivo-absence", tag: "input" },
  { id: "ausencia-motivo-training", tag: "input" },
  { id: "ausencia-desde", tag: "input" },
  { id: "ausencia-hasta", tag: "input" },
  { id: "ausencia-nombre", tag: "input" },
  { id: "ausencia-nota", tag: "input" },
  "ausencia-nota-contador",
  "ausencia-paso1-error",
  "ausencia-aviso-retirada",
  { id: "ausencia-todo-el-dia", tag: "input" },
  "ausencia-campos-horas",
  { id: "ausencia-desde-hora", tag: "input" },
  { id: "ausencia-hasta-hora", tag: "input" },
  "ausencia-resumen",
  "ausencia-impacto",
  "ausencia-contador",
  { id: "ausencia-siguiente-1", tag: "button" },
  { id: "ausencia-atras-1", tag: "button" },
  { id: "ausencia-siguiente", tag: "button" },
  { id: "ausencia-atras", tag: "button" },
  { id: "ausencia-guardar", tag: "button" },
  "ausencia-exito",
  { id: "ausencia-cancelar-1", tag: "button" },
  { id: "ausencia-cancelar-2", tag: "button" },
  { id: "ausencia-cancelar-3", tag: "button" },
  { id: "ausencia-cerrar", tag: "button" },
] as const;

/** Los identificadores del diálogo de detalle / retirada / cambio (R13). */
const IDS_DIALOGO_EXCEPCION = [
  { id: "dialogo-excepcion", tag: "dialog" },
  "dialogo-excepcion-titulo",
  "excepcion-paso-1",
  "excepcion-paso-2",
  "excepcion-paso-3",
  "excepcion-paso-1-titulo",
  "excepcion-paso-2-titulo",
  "excepcion-paso-3-titulo",
  "excepcion-detalle",
  { id: "excepcion-cambiar", tag: "button" },
  { id: "excepcion-retirar", tag: "button" },
  { id: "excepcion-cerrar-1", tag: "button" },
  "excepcion-resumen",
  "excepcion-impacto",
  "excepcion-contador",
  // (V1-9) La nota operativa de la retirada y su contador (V3-12).
  { id: "excepcion-nota", tag: "input" },
  "excepcion-nota-contador",
  { id: "excepcion-atras", tag: "button" },
  { id: "excepcion-cancelar", tag: "button" },
  { id: "excepcion-confirmar", tag: "button" },
  "excepcion-exito",
  { id: "excepcion-crear-nuevo", tag: "button" },
  { id: "excepcion-cerrar-3", tag: "button" },
  "excepcion-error",
] as const;

/** Lo que hace falta para que el foco de un diálogo tenga a dónde volver. */
const IDS_FOCO = ["tx-view-title", "tit-dias-especiales", "tit-ausencias-equipo", "tit-proximas-excepciones"] as const;

/** Todo el texto de un subárbol, en plano, para afirmar sobre lo que se lee. */
function textoPlano(n: FakeElement): string {
  const trozos: string[] = [];
  const recorrer = (x: FakeElement) => {
    if (x.children.length === 0) trozos.push(x.textContent);
    for (const h of x.children) recorrer(h);
  };
  recorrer(n);
  return trozos.join(" · ");
}

// =====================================================================
// R3 / P13 — Agenda › Mes es la ÚNICA cuadrícula mensual de CITAS.
// La rejilla de Horarios y ausencias deja de hablar de citas: fuera el «• N»,
// fuera el cálculo que lo alimentaba y fuera su línea de leyenda. Lo que sí
// muestra —apertura/cierre, ▲ especial o festivo, ◆ ausencias— se conserva,
// con el tope de saturación que el normativo fija.
// Todo el bloque es DISCRIMINANTE contra `7ad0c6d`.
// =====================================================================

describe("step 26 REAPERTURA · R3 — la rejilla de Horarios y ausencias no habla de citas", () => {
  /** Todo el texto y todas las clases que la rejilla ha pintado, en plano. */
  function rejilla(calendar: unknown, engineToday = "2026-08-05") {
    const { document, nodes } = createFakeDocumentWithIds([...HORARIOS_IDS_R7]);
    const hooks = loadUiClientHooks("", document);
    hooks.renderHorariosYAusencias({ engineToday, calendar });
    const cuerpo = nodes["calendario-grid-body"] as FakeElement;
    const marcas: FakeElement[] = [];
    const textos: string[] = [];
    const clases: string[] = [];
    const recorrer = (n: FakeElement) => {
      clases.push(n.className);
      if (n.children.length === 0) textos.push(n.textContent);
      if (n.className === "tx-day-cell__marks") marcas.push(n);
      for (const h of n.children) recorrer(h);
    };
    for (const fila of cuerpo.children) recorrer(fila);
    return { cuerpo, marcas, texto: textos.join(" · "), clases };
  }

  const CON_CITAS = {
    ...CAL,
    reservations: [
      { id: "r1", employeeId: 3, serviceId: 0, date: "2026-08-05", startMinutes: 540, endMinutes: 570, status: "confirmed" },
      { id: "r2", employeeId: 6, serviceId: 1, date: "2026-08-05", startMinutes: 600, endMinutes: 630, status: "confirmed" },
      { id: "r3", employeeId: 9, serviceId: 2, date: "2026-08-06", startMinutes: 660, endMinutes: 720, status: "confirmed" },
    ],
  };

  it("con citas confirmadas en el mes, la rejilla no pinta ni un '•' ni una marca de citas", () => {
    const { texto, clases } = rejilla(CON_CITAS);
    expect(texto).not.toContain("•");
    expect(clases).not.toContain("tx-mark--bookings");
    expect(texto).not.toMatch(/\bcitas?\b/);
    // Y lo que SÍ dice sigue estando: horas, festivo y ausencias.
    expect(texto).toContain("09:00–18:00");
    expect(texto).toContain("Cerrado");
    expect(texto).toContain("▲ Festivo");
    // El rombo de ausencia lleva la inicial del profesional; sin `latestSnapshot`
    // (aquí se pinta llamando a la función directamente) esa inicial la da el
    // nombre de repuesto, así que lo que se afirma es la MARCA, no la letra.
    expect(texto).toMatch(/◆ \S/);
    expect(clases).toContain("tx-mark--absence");
  });

  it("el cliente ya no calcula 'dayBookings' para esta pantalla, y la leyenda no promete un contador", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    expect(js).not.toContain("dayBookings");
    expect(js).not.toContain("tx-mark--bookings");
    const html = renderConsoleHtml();
    const seccion = html.slice(html.indexOf('id="vista-horarios-y-ausencias"'), html.indexOf('id="vista-equipo"'));
    expect(seccion).not.toContain("Número de citas");
    expect(seccion).not.toContain("• =");
    // Las otras tres líneas de la leyenda se conservan enteras.
    expect(seccion).toContain("Cerrado = ese día el local no abre");
    expect(seccion).toContain("▲ = Festivo o día especial");
    expect(seccion).toContain("◆ = Alguien del equipo no está");
  });

  it("un día con cinco ausencias pinta tres marcas, y la tercera dice '◆ +3 más'", () => {
    const cincoAusencias = [1, 2, 3, 4, 5].map((n) => ({
      id: "aus-" + String(n),
      employeeId: [3, 6, 9, 12, 15][n - 1],
      approval: "approved",
      kind: "absence",
      startDate: "2026-08-05",
      endDate: "2026-08-05",
      allDay: true,
    }));
    const cal = {
      ...CAL,
      professionals: [
        ...PROFESIONALES,
        { employeeId: 12, label: "Dani (sintético)" },
        { employeeId: 15, label: "Eva (sintética)" },
      ],
      absences: cincoAusencias,
    };
    const { cuerpo } = rejilla(cal);
    const celda = cuerpo.children
      .flatMap((fila) => fila.children)
      .find((td) => td.children.some((h) => h.className === "tx-day-cell__number" || h.className === "tx-day-cell__link")
        && td.children.some((h) => h.className === "tx-day-cell__marks" && h.children.length > 0))!;
    const marcas = celda.children.find((h) => h.className === "tx-day-cell__marks")!;
    const ausencias = marcas.children.filter((m) => m.className === "tx-mark--absence");
    expect(ausencias.length).toBe(3);
    expect(ausencias[2]!.textContent).toBe("◆ +3 más");
    // Nada sólo-color: las tres llevan texto.
    for (const marca of ausencias) expect(marca.textContent.length).toBeGreaterThan(1);
  });

  it("no hay dos rejillas mensuales con contador de citas: sólo Agenda › Mes cuenta citas", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const mes = js.slice(js.indexOf("function renderAgendaMes("), js.indexOf("function agendaTituloRango("));
    const horarios = js.slice(js.indexOf("function renderHorariosYAusencias("), js.indexOf("function renderEquipo("));
    // Agenda › Mes conserva su contador, con plural correcto.
    expect(mes).toContain("tx-day-cell__citas");
    expect(mes).toContain("' cita' : ' citas'");
    // Horarios y ausencias no proyecta reservas para pintar NADA.
    expect(horarios).not.toContain("reservations");
    expect(horarios).not.toContain("tx-day-cell__citas");
  });

  it("Agenda › Mes conserva el contador y el enlace al día (candado de no regresión)", () => {
    const AGENDA_MES_IDS = [
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
      "inicio-ruta-desconocida",
      "estado-global",
    ] as const;
    const { document, nodes } = createFakeDocumentWithIds([...AGENDA_MES_IDS]);
    const hooks = loadUiClientHooks("#/agenda/mes/2026-08-05/todos", document, {
      location: { hash: "#/agenda/mes/2026-08-05/todos" },
      scrollTo: () => {},
    } as unknown as { location: { hash: string } });
    hooks.applyRoute();
    hooks.renderAgenda({ engineToday: "2026-08-05", engineNowMinutes: 600, calendar: CON_CITAS });
    const textos: string[] = [];
    const enlaces: string[] = [];
    const recorrer = (n: FakeElement) => {
      if (n.tagName === "A") enlaces.push((n as unknown as { href: string }).href);
      if (n.children.length === 0) textos.push(n.textContent);
      for (const h of n.children) recorrer(h);
    };
    recorrer(nodes["agenda-mes"] as FakeElement);
    expect(textos).toContain("2 citas");
    expect(textos).toContain("1 cita");
    expect(enlaces.some((h) => /^#\/agenda\/dia\/2026-08-\d{2}\/todos$/.test(h))).toBe(true);
  });
});

// =====================================================================
// R1 — la sección nueva: clave de ruta, título visible y barra lateral.
// Todo el bloque es DISCRIMINANTE contra `7ad0c6d`, donde la sección se
// llama `calendario` y la barra dice «Calendario».
// =====================================================================

describe("step 26 REAPERTURA · R1 — la sección se llama «Horarios y ausencias»", () => {
  const HTML = renderConsoleHtml();
  const JS = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");

  it("ROUTE_TITLES tiene exactamente las siete rutas, con 'horarios-y-ausencias' donde estaba 'calendario'", () => {
    const idx = JS.indexOf("var ROUTE_TITLES = {");
    expect(idx).toBeGreaterThan(-1);
    const cuerpo = JS.slice(idx, JS.indexOf("};", idx));
    const claves = [...cuerpo.matchAll(/^\s{4}'?([a-z-]+)'?:/gm)].map((m) => m[1]);
    expect(claves).toEqual(["inicio", "agenda", "lista-espera", "llamadas", "horarios-y-ausencias", "equipo", "laboratorio"]);
    expect(claves).not.toContain("calendario");
    expect(cuerpo).toContain("'Horarios y ausencias'");
  });

  it("la barra lateral ofrece las siete entradas de siempre, con «Horarios y ausencias» en el sitio de «Calendario»", () => {
    const rutas = [...HTML.matchAll(/data-route="([a-z-]+)"/g)].map((m) => m[1]);
    expect(rutas).toEqual(["inicio", "agenda", "lista-espera", "llamadas", "horarios-y-ausencias", "equipo", "laboratorio"]);
    const enlace = /<a href="#\/horarios-y-ausencias" data-route="horarios-y-ausencias"[^>]*>/.exec(HTML)?.[0] ?? "";
    expect(enlace).toContain('title="Horarios y ausencias"');
    expect(enlace).toContain('aria-label="Horarios y ausencias"');
    expect(HTML).toContain('<span class="tx-nav__label">Horarios y ausencias</span>');
  });

  it("«Calendario» desaparece como etiqueta visible de navegación, y con ella «Ver el calendario»", () => {
    expect(HTML).not.toContain('data-route="calendario"');
    expect(HTML).not.toContain('href="#/calendario"');
    expect(HTML).not.toContain(">Calendario<");
    expect(HTML).not.toContain("Ver el calendario");
    expect(HTML).toContain("Ver horarios y ausencias");
  });

  it("la <section> es #vista-horarios-y-ausencias y NO nace con un <h1> propio: el H1 sigue siendo el compartido", () => {
    expect(HTML).toContain('<section id="vista-horarios-y-ausencias"');
    expect(HTML).not.toContain('id="vista-calendario"');
    expect((HTML.match(/<h1[ >]/g) ?? []).length).toBe(1);
    expect(HTML).toContain('<h1 class="tx-topbar__title" id="tx-view-title"');
  });

  it("los identificadores internos 'calendario-*' se CONSERVAN (F7 del normativo: deuda cosmética, no ruptura)", () => {
    for (const id of [
      "calendario-temporada",
      "calendario-temporada-titulo",
      "calendario-temporada-detalle",
      "calendario-temporada-aviso-fecha",
      "calendario-mes-anterior",
      "calendario-mes-titulo",
      "calendario-mes-siguiente",
      "calendario-grid",
      "calendario-grid-body",
      "calendario-dias-distintos",
      "calendario-dias-distintos-vacio",
      "inicio-calendario-resumen",
    ]) {
      expect(HTML, `el id #${id} se conserva`).toContain(`id="${id}"`);
    }
  });

  it("el glifo de la entrada es el MISMO SVG que tenía Calendario, byte a byte: no se dibuja ningún icono nuevo", () => {
    const enlace = HTML.slice(HTML.indexOf('data-route="horarios-y-ausencias"'), HTML.indexOf("</a>", HTML.indexOf('data-route="horarios-y-ausencias"')));
    expect(enlace).toContain('<rect x="3.4" y="5" width="17.2" height="15.6" rx="2.2"/><path d="M3.4 9.8h17.2M8.2 2.9v4M15.8 2.9v4"/>');
  });

  it("el aviso de ruta de la sección existe, nace oculto y dice exactamente lo que el normativo fija", () => {
    const seccion = HTML.slice(HTML.indexOf('id="vista-horarios-y-ausencias"'), HTML.indexOf('id="vista-equipo"'));
    expect(seccion).toContain('id="horarios-aviso-ruta"');
    const p = /<p[^>]*id="horarios-aviso-ruta"[^>]*>[^<]*/.exec(seccion)?.[0] ?? "";
    expect(p).toContain('class="tx-status-line tx-col-12"');
    expect(p).toMatch(/\shidden(\s|>)/);
    expect(p).toContain("No se ha entendido parte de la dirección. Se muestra el mes de hoy.");
    // Es HERMANO del de Agenda, no su sustituto: el de Agenda sigue intacto.
    expect(HTML).toContain('id="agenda-aviso-ruta"');
    expect(HTML).toContain("No se ha entendido parte de la dirección. Se muestra el día de hoy.");
  });
});

// =====================================================================
// R2 — el mes visible sobrevive a la reescritura de la ruta retirada.
// =====================================================================

describe("step 26 REAPERTURA · R2 — un enlace profundo guardado aterriza con su mes", () => {
  it("'#/calendario/2026-09' termina pintando septiembre de 2026 en la rejilla nueva", () => {
    const CAL_IDS = [
      ...HORARIOS_IDS_R7,
      "horarios-aviso-ruta",
      "tx-view-title",
      "inicio-ruta-desconocida",
      "estado-global",
      "vista-horarios-y-ausencias",
    ] as const;
    const { document, nodes } = createFakeDocumentWithIds([...CAL_IDS]);
    let hash = "#/calendario/2026-09";
    const win = {
      location: {
        pathname: "/",
        search: "",
        get hash() {
          return hash;
        },
        set hash(v: string) {
          hash = v;
        },
        replace(url: string) {
          hash = url.slice(url.indexOf("#"));
        },
      },
      scrollTo: () => {},
    };
    const hooks = loadUiClientHooks(hash, document, win as unknown as { location: { hash: string } });
    hooks.applyRoute();
    hooks.applyRoute(); // el hashchange que provoca la reescritura
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    expect((nodes["calendario-mes-titulo"] as FakeElement).textContent).toBe("septiembre de 2026");
    // Y los dos enlaces de mes apuntan ya a la ruta nueva, nunca a la retirada.
    expect((nodes["calendario-mes-anterior"] as unknown as { href: string }).href).toBe("#/horarios-y-ausencias/2026-08");
    expect((nodes["calendario-mes-siguiente"] as unknown as { href: string }).href).toBe("#/horarios-y-ausencias/2026-10");
  });
});

// =====================================================================
// R1/R2 — UN MES CON FORMA VÁLIDA PERO QUE NO EXISTE.
//
// `/^\d{4}-\d{2}$/` acepta `2026-99`, `2026-00` y `2026-13`: tienen la
// forma de un mes y no son un mes. El verificador de la reapertura entró
// por `#/calendario/2026-99` y aterrizó, sin un solo aviso, en un mes
// titulado «undefined de 2026», con las celdas fechadas `2026-99-01` y un
// «mes siguiente» que apuntaba a `2026-100`. La forma no es el rango: se
// valida el rango, en la ruta VIVA y en la REDIRECCIÓN, con el mismo
// criterio que `esFechaCalendarioValida` aplica a los días.
// =====================================================================

describe("step 26 REAPERTURA · R1/R2 — un mes con forma válida pero fuera de rango se normaliza y se dice", () => {
  const CAL_IDS = [
    ...HORARIOS_IDS_R7,
    "horarios-aviso-ruta",
    "tx-view-title",
    "inicio-ruta-desconocida",
    "estado-global",
    "vista-horarios-y-ausencias",
  ] as const;

  function navegar(hashInicial: string) {
    const { document, nodes } = createFakeDocumentWithIds([...CAL_IDS]);
    let hash = hashInicial;
    let reescrituras = 0;
    const win = {
      location: {
        pathname: "/",
        search: "",
        get hash() {
          return hash;
        },
        set hash(v: string) {
          hash = v;
          reescrituras += 1;
        },
        replace(url: string) {
          hash = url.slice(url.indexOf("#"));
          reescrituras += 1;
        },
      },
      scrollTo: () => {},
    };
    const hooks = loadUiClientHooks(hash, document, win as unknown as { location: { hash: string } });
    hooks.applyRoute();
    hooks.applyRoute(); // el hashchange que provocaría una reescritura, si la hubo
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    return { nodes, hash: () => hash, reescrituras: () => reescrituras };
  }

  for (const mes of ["2026-99", "2026-00", "2026-13"]) {
    it(`'#/horarios-y-ausencias/${mes}' enseña el mes de HOY, con su aviso, y sin tocar la dirección`, () => {
      const { nodes, hash, reescrituras } = navegar(`#/horarios-y-ausencias/${mes}`);
      expect((nodes["calendario-mes-titulo"] as FakeElement).textContent).toBe("agosto de 2026");
      expect((nodes["horarios-aviso-ruta"] as FakeElement).hidden).toBe(false);
      // Una ruta VIVA se normaliza AL PINTAR, nunca reescribiendo la URL.
      expect(hash()).toBe(`#/horarios-y-ausencias/${mes}`);
      expect(reescrituras()).toBe(0);
      // Y el mes siguiente es septiembre, no `2026-100`.
      expect((nodes["calendario-mes-siguiente"] as unknown as { href: string }).href).toBe("#/horarios-y-ausencias/2026-09");
    });

    it(`'#/calendario/${mes}' redirige UNA vez al mes de hoy, con su aviso`, () => {
      const { nodes, hash, reescrituras } = navegar(`#/calendario/${mes}`);
      // Una sola reescritura, y sin arrastrar el mes que no existe.
      expect(hash()).toBe("#/horarios-y-ausencias");
      expect(reescrituras()).toBe(1);
      expect((nodes["calendario-mes-titulo"] as FakeElement).textContent).toBe("agosto de 2026");
      expect((nodes["horarios-aviso-ruta"] as FakeElement).hidden).toBe(false);
      expect((nodes["calendario-mes-siguiente"] as unknown as { href: string }).href).toBe("#/horarios-y-ausencias/2026-09");
    });
  }

  it("candado — un mes que SÍ existe sigue mandando, por las dos vías, y sin aviso", () => {
    const directo = navegar("#/horarios-y-ausencias/2026-12");
    expect((directo.nodes["calendario-mes-titulo"] as FakeElement).textContent).toBe("diciembre de 2026");
    expect((directo.nodes["horarios-aviso-ruta"] as FakeElement).hidden).toBe(true);
    expect(directo.reescrituras()).toBe(0);

    const redirigido = navegar("#/calendario/2026-01");
    expect(redirigido.hash()).toBe("#/horarios-y-ausencias/2026-01");
    expect((redirigido.nodes["calendario-mes-titulo"] as FakeElement).textContent).toBe("enero de 2026");
    expect((redirigido.nodes["horarios-aviso-ruta"] as FakeElement).hidden).toBe(true);
    expect(redirigido.reescrituras()).toBe(1);
  });
});

// =====================================================================
// R4 / P30 — el <details> del panel de huecos sobrevive al sondeo.
//
// Esta prueba vive aquí, y no en `agendaMultivista.test.ts`, por el ajuste de
// propiedad del §6 del normativo de reapertura (ese fichero es de la Oleada
// A1): necesita `hooks.refresh()`, así que no cabía en `sistemaVisual.test.ts`.
// =====================================================================

describe("step 26 REAPERTURA · R4/P30 — el panel de huecos plegable sobrevive al sondeo", () => {
  const AGENDA_MINIMA = [
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
    { id: "huecos-panel", tag: "details" },
    "tx-view-title",
    "tx-freshness",
    "tx-conexion-anuncio",
    "inicio-ruta-desconocida",
  ] as const;

  const SNAP = { engineToday: "2026-08-05", engineNowMinutes: 600, calendar: CAL };

  it("el HTML lo sirve como <details> plegado, y ni el sondeo ni el enrutador tocan su estado", async () => {
    // (a) En el HTML servido es de verdad un <details> sin `open`.
    const html = renderConsoleHtml();
    const etiqueta = /<[a-z]+[^>]*id="huecos-panel"[^>]*>/.exec(html)?.[0] ?? "";
    expect(etiqueta.startsWith("<details")).toBe(true);
    expect(etiqueta).not.toMatch(/\sopen(\s|>|=)/);

    // (b) Abierto por el operador, sigue abierto tras dos pasadas de sondeo.
    const { document, nodes } = createFakeDocumentWithIds([...AGENDA_MINIMA]);
    const hooks = loadUiClientHooks("#/agenda/dia/2026-08-05/todos", document, {
      location: { hash: "#/agenda/dia/2026-08-05/todos" },
      scrollTo: () => {},
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve(SNAP) })) as typeof fetch;
    try {
      hooks.applyRoute();
      await hooks.refresh();
      const panel = nodes["huecos-panel"] as FakeElement;
      panel.open = true;
      await hooks.refresh();
      await hooks.refresh();
      hooks.applyRoute();
      expect(panel.open).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("el cliente no conoce #huecos-panel: nada puede cerrarlo por su cuenta", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    expect(js).not.toContain("huecos-panel");
  });
});

// =====================================================================
// A15 — el Calendario conserva su acción de día especial y gana SÓLO el
// enlace al día. (Movido desde agendaMultivista.test.ts — ver docblock.)
// =====================================================================

describe("step 26 · A15 — el Calendario operativo gana el enlace de un día", () => {
  it("el número de día es un enlace a '#/agenda/dia/<fecha>/todos' con nombre accesible", () => {
    const { document, nodes } = createFakeDocumentWithIds([...HORARIOS_IDS_R7]);
    const hooks = loadUiClientHooks("", document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    const fila = (nodes["calendario-grid-body"] as FakeElement).children[0]!; // primera semana
    const celda = fila.children.find((td) => !td.className.includes("outside"))!;
    const enlace = celda.children[0]!;
    expect(enlace.tagName).toBe("A");
    expect((enlace as unknown as { href: string }).href).toMatch(/^#\/agenda\/dia\/2026-08-\d{2}\/todos$/);
    expect(enlace.getAttribute("aria-label")).toMatch(/^Ver agenda de este día: /);
  });

  it("el botón de cierre o día especial y el resto de la pantalla siguen intactos", () => {
    const html = renderConsoleHtml();
    const calendario = html.slice(html.indexOf('id="vista-horarios-y-ausencias"'), html.indexOf('id="vista-equipo"'));
    expect(calendario).toContain('id="btn-abrir-dia-especial"');
    // R9 — el botón deja de hablar sólo de "día especial": ahora nombra las dos cosas.
    expect(calendario).toContain("Añadir cierre o día especial");
  });
});

// =====================================================================
// R7 — los CUATRO bloques de la pantalla, cada uno con su encabezado, y
// ninguna cita de cliente mezclada. Todo el bloque es DISCRIMINANTE contra
// `277a0d5`, donde la sección sólo tiene rejilla, leyenda y «Días distintos».
// =====================================================================

describe("step 26 REAPERTURA · R7 — la pantalla se organiza en cuatro bloques", () => {
  const HTML = renderConsoleHtml();
  const SECCION = HTML.slice(HTML.indexOf('id="vista-horarios-y-ausencias"'), HTML.indexOf('id="vista-equipo"'));

  it("los cuatro encabezados existen, son <h2> y van en el orden del normativo", () => {
    const titulos = ["tit-horario-habitual", "tit-dias-especiales", "tit-ausencias-equipo", "tit-proximas-excepciones"];
    const posiciones = titulos.map((id) => SECCION.indexOf(`id="${id}"`));
    for (const [i, p] of posiciones.entries()) expect(p, `falta #${titulos[i]}`).toBeGreaterThan(-1);
    expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
    for (const id of titulos) expect(SECCION).toMatch(new RegExp(`<h2 id="${id}"[ >]`));
    expect(SECCION).toContain(">Horario habitual<");
    expect(SECCION).toContain(">Días especiales y cierres<");
    expect(SECCION).toContain(">Ausencias del equipo<");
    expect(SECCION).toContain(">Próximas excepciones<");
  });

  it("cada bloque es una <section> rotulada por su propio encabezado, y no nace ningún <h1> nuevo", () => {
    for (const id of ["tit-horario-habitual", "tit-dias-especiales", "tit-ausencias-equipo", "tit-proximas-excepciones"]) {
      expect(SECCION).toContain(`aria-labelledby="${id}"`);
    }
    expect((HTML.match(/<h1[ >]/g) ?? []).length).toBe(1);
    // A1 de R15: sin saltos de nivel — las sublistas de los bloques abren con <h3>.
    expect(SECCION).not.toMatch(/<h4[ >]/);
  });

  it("el bloque 1 es CONSULTA (R12): dice que el horario no se cambia desde aquí y no trae ningún control", () => {
    const bloque1 = SECCION.slice(SECCION.indexOf('id="tit-horario-habitual"'), SECCION.indexOf('id="tit-dias-especiales"'));
    expect(bloque1).toContain('id="horarios-regimen"');
    expect(bloque1).toContain('id="horarios-semana"');
    expect(bloque1).toContain('id="horarios-semana-nota"');
    expect(bloque1).toContain("no se cambia desde aquí");
    expect(bloque1).toContain("Añadir cierre o día especial");
    expect(bloque1).toContain("un horario sin fechas se quedaría puesto para siempre");
    // «no es un formulario apagado»: ni un control, ni deshabilitado ni vivo.
    expect(bloque1).not.toContain("<button");
    expect(bloque1).not.toContain("<input");
    expect(bloque1).not.toContain("<select");
  });

  it("el bloque 3 trae el filtro de profesional y el botón «Añadir ausencia», que ahora vive AQUÍ (R8)", () => {
    const bloque3 = SECCION.slice(SECCION.indexOf('id="tit-ausencias-equipo"'), SECCION.indexOf('id="tit-proximas-excepciones"'));
    expect(bloque3).toContain('id="horarios-filtro-profesional"');
    expect(bloque3).toContain('id="btn-abrir-ausencia"');
    expect(bloque3).toContain("Añadir ausencia");
    expect(bloque3).toContain('id="horarios-ausencias"');
    expect(bloque3).toContain('id="horarios-ausencias-vacio"');
  });

  it("el bloque 1 se pinta con la MISMA función que el «Horario del local» de Equipo: una implementación, dos sitios", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    expect(js).toContain("function pintarSemanaDelLocal(");
    const equipo = js.slice(js.indexOf("function renderEquipo("), js.indexOf("function renderEquipo(") + 4000);
    expect(equipo).toContain("pintarSemanaDelLocal(");
    const horarios = js.slice(js.indexOf("function renderHorariosYAusencias("), js.indexOf("function renderEquipo("));
    expect(horarios).toContain("pintarSemanaDelLocal(");
  });

  it("bloque 1: los siete días y el régimen se pintan de verdad, con las mismas horas que Equipo", () => {
    const { document, nodes } = createFakeDocumentWithIds([...HORARIOS_IDS_R7]);
    const hooks = loadUiClientHooks("", document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    const semana = nodes["horarios-semana"] as FakeElement;
    expect(semana.children.length).toBe(7);
    expect(textoPlano(semana)).toContain("09:00 – 18:00");
    expect((nodes["horarios-regimen"] as FakeElement).textContent).toContain("horario de siempre");
  });

  it("bloque 2: la lista «Cierres y días especiales de este mes» sale de los arrays tipados, con su nota", () => {
    const cal = {
      ...CAL,
      closures: [
        { id: "cierre-reforma", approval: "approved", startDate: "2026-08-10", endDate: "2026-08-14", audit: { createdAt: "x", createdBy: "y", note: "obras en la fachada" } },
      ],
    };
    const { document, nodes } = createFakeDocumentWithIds([...HORARIOS_IDS_R7]);
    const hooks = loadUiClientHooks("", document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: cal });
    const lista = nodes["horarios-excepciones-mes"] as FakeElement;
    expect(lista.children.length).toBe(2); // el cierre de rango y el festivo del 8
    const texto = textoPlano(lista);
    expect(texto).toContain("obras en la fachada");
    expect(texto).toContain("Cambiar");
    expect(texto).toContain("Retirar");
    expect((nodes["horarios-excepciones-mes-vacio"] as FakeElement).hidden).toBe(true);
    // La nota se pinta SIEMPRE dentro de .tx-nota-operativa (R11).
    const clases: string[] = [];
    const recorrer = (n: FakeElement) => { clases.push(n.className); for (const h of n.children) recorrer(h); };
    recorrer(lista);
    expect(clases).toContain("tx-nota-operativa");
  });

  it("bloque 3: cada ausencia se lee «quién · tipo · fechas · todo el día u horas» y lleva Cambiar y Retirar", () => {
    const { document, nodes } = createFakeDocumentWithIds([...HORARIOS_IDS_R7]);
    const hooks = loadUiClientHooks("", document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    const lista = nodes["horarios-ausencias"] as FakeElement;
    expect(lista.children.length).toBe(2);
    const texto = textoPlano(lista);
    expect(texto).toContain("Ausencia");
    expect(texto).toContain("Vacaciones");
    expect(texto).toContain("09:00–12:00");
    expect(texto).toContain("Todo el día");
    expect(texto).toContain("Cambiar");
    expect(texto).toContain("Retirar");
  });

  it("bloque 3: el filtro de profesional recorta la lista, y usa el MISMO poblador que Agenda", () => {
    const { document, nodes } = createFakeDocumentWithIds([...HORARIOS_IDS_R7]);
    const hooks = loadUiClientHooks("", document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    const filtro = nodes["horarios-filtro-profesional"] as FakeElement;
    // ensureProfessionalOptions ha puesto «Todos» + una opción por profesional.
    expect(filtro.options.map((o) => o.value)).toEqual(["", "3", "6", "9"]);
    filtro.value = "9"; // sólo Cruz
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    const lista = nodes["horarios-ausencias"] as FakeElement;
    expect(lista.children.length).toBe(1);
    expect(textoPlano(lista)).toContain("Vacaciones");
  });

  it("bloque 4: «Próximas excepciones» sale de los arrays tipados y va DESDE HOY, nunca del historial de texto", () => {
    const cal = {
      ...CAL,
      closures: [{ id: "cierre-sept", approval: "approved", startDate: "2026-09-01", endDate: "2026-09-02", audit: { createdAt: "x", createdBy: "y" } }],
      auditLog: ["ESTO-ES-PROSA-DEL-HISTORIAL-QUE-NO-DEBE-VERSE"],
    };
    const { document, nodes } = createFakeDocumentWithIds([...HORARIOS_IDS_R7]);
    const hooks = loadUiClientHooks("", document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: cal });
    const lista = nodes["calendario-dias-distintos"] as FakeElement;
    const texto = textoPlano(lista);
    expect(texto).not.toContain("ESTO-ES-PROSA-DEL-HISTORIAL");
    // El cierre de SEPTIEMBRE entra aunque el mes visible sea agosto: la
    // ventana de este bloque es «desde hoy», no «el mes visible» (R7).
    expect(texto).toContain("Local cerrado");
    const claves = lista.children.map((li) => li.getAttribute("data-key"));
    expect(claves).toContain("closure-cierre-sept");
    // Y están ORDENADAS por fecha de inicio.
    // V3-14 — con `?? ""` una fila SIN `data-inicio` se comparaba como cadena
    // vacía, y una lista entera de cadenas vacías sale ordenada: la
    // comparación era trivialmente cierta y no habría detectado que el
    // atributo dejara de escribirse. Se exige primero que TODAS lo traigan, y
    // con forma de fecha.
    const inicios = lista.children.map((li) => li.getAttribute("data-inicio"));
    expect(inicios.length).toBeGreaterThan(0);
    for (const iso of inicios) expect(iso, "una fila del bloque 4 no trae data-inicio").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(inicios).toEqual([...inicios].sort());
  });

  it("bloque 4: al pulsar una excepción se abre su DETALLE, no la agenda", () => {
    const { document, nodes } = createFakeDocumentWithIds([...HORARIOS_IDS_R7, ...IDS_DIALOGO_EXCEPCION]);
    const hooks = loadUiClientHooks("", document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    const lista = nodes["calendario-dias-distintos"] as FakeElement;
    const primera = lista.children[0]!;
    // Ni un enlace a la agenda en toda la fila.
    const enlaces: string[] = [];
    const recorrer = (n: FakeElement) => { if (n.tagName === "A") enlaces.push((n as unknown as { href: string }).href ?? ""); for (const h of n.children) recorrer(h); };
    recorrer(primera);
    expect(enlaces.filter((h) => h.startsWith("#/agenda"))).toEqual([]);
    // V3-2 — la fila del bloque 4 es la MISMA fila que la de los bloques 2 y
    // 3: cuerpo con título, detalle y nota, más «Cambiar» y «Retirar». Antes
    // era un botón suelto que sólo abría el detalle, sin ninguna vía de
    // retirada en la propia fila.
    const botones: FakeElement[] = [];
    const recorrerBotones = (n: FakeElement) => { if (n.tagName === "BUTTON") botones.push(n); for (const h of n.children) recorrerBotones(h); };
    recorrerBotones(primera);
    expect(botones.map((b) => b.textContent)).toEqual(["Cambiar", "Retirar"]);
    botones[1]!.onclick?.();
    expect((nodes["dialogo-excepcion"] as FakeElement).open).toBe(true);
  });

  // ===================================================================
  // V3-2 — EL CALLEJÓN SIN SALIDA. Una excepción aprobada fuera del alcance
  // de los bloques 2 y 3 (una ausencia terminada, un cierre de un año futuro
  // que no sea el mes visible) no aparecía en NINGUNA lista con «Retirar», y
  // sin embargo su identificador seguía ocupado: el operador chocaba con un
  // 409 provocado por algo que no podía ni ver ni deshacer.
  //
  // DISCRIMINANTE contra `c1b593a`: allí el bloque 4 salía de
  // `collectDistinctDays` (sin botones, y sólo hacia delante) y no existía
  // ningún plegable de lo ya pasado.
  // ===================================================================

  const CAL_FUERA_DE_ALCANCE = {
    ...CAL,
    closures: [
      // Un cierre de 2027: fuera del mes visible (agosto de 2026) y por tanto
      // invisible en el bloque 2, pero aprobado y ocupando su nombre.
      { id: "cierre-verano-2027-07-01", approval: "approved", startDate: "2027-07-01", endDate: "2027-07-15", audit: { createdAt: "x", createdBy: "y" } },
    ],
    absences: [
      ...ABSENCES,
      // Una ausencia YA TERMINADA: fuera del bloque 3, que es de hoy en
      // adelante, y aprobada igualmente.
      { id: "vacaciones-alex-2025-05-01", employeeId: 3, approval: "approved", kind: "vacation", startDate: "2025-05-01", endDate: "2025-05-10", allDay: true, audit: { createdAt: "x", createdBy: "y" } },
    ],
  };

  function filasDe(lista: FakeElement): { clave: string; texto: string; botones: string[] }[] {
    return lista.children.map((li) => {
      const botones: string[] = [];
      const recorrer = (n: FakeElement) => { if (n.tagName === "BUTTON") botones.push(n.textContent); for (const h of n.children) recorrer(h); };
      recorrer(li);
      return { clave: li.getAttribute("data-key") ?? "", texto: textoPlano(li), botones };
    });
  }

  it("bloque 4: TODO lo aprobado que no ha terminado, aunque caiga fuera del mes visible, y con su «Retirar»", () => {
    const doc = createFakeDocumentWithIds([...HORARIOS_IDS_R7, ...IDS_DIALOGO_EXCEPCION]);
    const hooks = loadUiClientHooks("", doc.document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_FUERA_DE_ALCANCE });
    const proximas = filasDe(doc.nodes["calendario-dias-distintos"] as FakeElement);
    const claves = proximas.map((f) => f.clave);
    // El cierre de 2027 está aquí, y el bloque 2 (mes visible = agosto 2026)
    // no lo enseña: ésa es exactamente la fila que antes no tenía salida.
    expect(claves).toContain("closure-cierre-verano-2027-07-01");
    expect((doc.nodes["horarios-excepciones-mes"] as FakeElement).children.map((li) => li.getAttribute("data-key")))
      .not.toContain("closure-cierre-verano-2027-07-01");
    // Y trae su botón de retirar, como todas.
    for (const fila of proximas) expect(fila.botones, fila.clave).toContain("Retirar");
    // Lo ya terminado NO está aquí: está abajo.
    expect(claves).not.toContain("absence-vacaciones-alex-2025-05-01");
  });

  it("bloque 4: el AÑO aparece en el rótulo cuando no es el año en curso, y no cuando sí lo es", () => {
    const doc = createFakeDocumentWithIds([...HORARIOS_IDS_R7, ...IDS_DIALOGO_EXCEPCION]);
    const hooks = loadUiClientHooks("", doc.document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_FUERA_DE_ALCANCE });
    const proximas = filasDe(doc.nodes["calendario-dias-distintos"] as FakeElement);
    const de2027 = proximas.find((f) => f.clave === "closure-cierre-verano-2027-07-01")!;
    expect(de2027.texto).toContain("2027");
    // Una del año en curso no lleva año: sería ruido en casi todas las filas.
    const festivo = proximas.find((f) => f.clave === "rule-festivo-1")!;
    expect(festivo.texto).not.toContain("2026");
  });

  it("lo que YA HA PASADO vive en un plegable, sigue apuntado y se puede retirar desde ahí", () => {
    const doc = createFakeDocumentWithIds([...HORARIOS_IDS_R7, ...IDS_DIALOGO_EXCEPCION]);
    const hooks = loadUiClientHooks("", doc.document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_FUERA_DE_ALCANCE });
    const anteriores = filasDe(doc.nodes["calendario-excepciones-anteriores"] as FakeElement);
    const terminada = anteriores.find((f) => f.clave === "absence-vacaciones-alex-2025-05-01");
    expect(terminada, "la ausencia terminada no aparece en ninguna lista con Retirar").toBeDefined();
    expect(terminada!.botones).toContain("Retirar");
    expect(terminada!.texto).toContain("2025");
    expect((doc.nodes["calendario-excepciones-anteriores-vacio"] as FakeElement).hidden).toBe(true);
    // Y al pulsar Retirar se abre el detalle con el destino correcto.
    const li = (doc.nodes["calendario-excepciones-anteriores"] as FakeElement).children
      .find((n) => n.getAttribute("data-key") === "absence-vacaciones-alex-2025-05-01")!;
    const botones: FakeElement[] = [];
    const recorrer = (n: FakeElement) => { if (n.tagName === "BUTTON") botones.push(n); for (const h of n.children) recorrer(h); };
    recorrer(li);
    botones.find((b) => b.textContent === "Retirar")!.onclick?.();
    expect((doc.nodes["dialogo-excepcion"] as FakeElement).open).toBe(true);
  });

  it("entre los dos bloques del final no se queda fuera NI UNA excepción aprobada", () => {
    // El invariante de verdad, y el que cierra el callejón: la unión de
    // «Próximas» y el plegable es EXACTAMENTE el conjunto de filas aprobadas
    // de los tres tipos que §R13 autoriza retirar.
    const doc = createFakeDocumentWithIds([...HORARIOS_IDS_R7, ...IDS_DIALOGO_EXCEPCION]);
    const hooks = loadUiClientHooks("", doc.document);
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_FUERA_DE_ALCANCE });
    const vistas = [
      ...filasDe(doc.nodes["calendario-dias-distintos"] as FakeElement),
      ...filasDe(doc.nodes["calendario-excepciones-anteriores"] as FakeElement),
    ];
    const esperadas = [
      ...CAL_FUERA_DE_ALCANCE.closures.filter((c) => c.approval === "approved").map((c) => `closure-${c.id}`),
      ...CAL_FUERA_DE_ALCANCE.venueRules.filter((r) => r.approval === "approved").map((r) => `rule-${r.id}`),
      ...CAL_FUERA_DE_ALCANCE.absences.filter((a) => a.approval === "approved").map((a) => `absence-${a.id}`),
    ];
    expect(esperadas.length).toBeGreaterThan(3);
    expect(vistas.map((f) => f.clave).sort()).toEqual(esperadas.sort());
    for (const fila of vistas) expect(fila.botones, fila.clave).toContain("Retirar");
  });

  it("el vacío de ausencias ya no contradice a la rejilla: dice su ventana y dónde están las demás", () => {
    expect(SECCION).not.toContain("No hay ninguna ausencia apuntada.<");
    expect(SECCION).toContain("No hay ninguna ausencia apuntada de hoy en adelante.");
    expect(SECCION).toContain("Las que ya han terminado siguen apuntadas");
    expect(SECCION).toContain("Lo que ya ha pasado");
  });

  it("esta pantalla no tiene ningún botón de crear cita", () => {
    expect(SECCION).not.toContain("btn-abrir-cita-manual");
    expect(SECCION).not.toContain("btn-abrir-grupo");
    expect(SECCION).not.toContain("Crear cita");
  });
});

// =====================================================================
// R8 — el CRUD de ausencias se muda: Equipo conserva LECTURA y un enlace.
// DISCRIMINANTE contra `277a0d5`, donde cada ficha lleva su propio botón.
// =====================================================================

describe("step 26 REAPERTURA · R8 — Equipo pierde la escritura de ausencias", () => {
  it("ninguna ficha de Equipo trae ya un botón «Añadir ausencia»; en su lugar hay UN enlace por ficha", () => {
    const { document, fichas } = createEquipoFakeDocument();
    const hooks = loadUiClientHooks("", document);
    hooks.renderEquipo({ engineToday: "2026-08-05", calendar: CAL });
    expect(fichas.children.length).toBe(3);
    for (const card of fichas.children) {
      const texto = textoPlano(card);
      expect(texto).not.toContain("Añadir ausencia");
      expect(texto).toContain("Gestionar ausencias");
      const enlaces: FakeElement[] = [];
      const recorrer = (n: FakeElement) => { if (n.tagName === "A") enlaces.push(n); for (const h of n.children) recorrer(h); };
      recorrer(card);
      expect(enlaces.length).toBe(1);
      expect((enlaces[0] as unknown as { href: string }).href).toBe("#/horarios-y-ausencias");
      // Sigue conservando la LECTURA de las ausencias próximas.
      expect(texto).toContain("Ausencias próximas");
    }
  });

  it("Equipo conserva las capacidades y el horario del local, que es lo que R8 le deja", () => {
    const { document, fichas } = createEquipoFakeDocument();
    const hooks = loadUiClientHooks("", document);
    hooks.renderEquipo({ engineToday: "2026-08-05", calendar: CAL });
    // V3-13 — sin esta línea, un `renderEquipo` que no pintara NI UNA ficha
    // dejaba el bucle sin iteraciones y la prueba en verde: afirmaba «todas
    // las fichas dicen X» sobre el conjunto vacío. Son tres profesionales.
    expect(fichas.children.length, "renderEquipo no ha pintado ninguna ficha").toBe(CAL.professionals.length);
    for (const card of fichas.children) expect(textoPlano(card)).toContain("Puede hacer");
  });

  it("el cliente ya no abre el diálogo de ausencia desde una ficha de Equipo", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const equipo = js.slice(js.indexOf("function renderEquipo("), js.indexOf("function renderEquipo(") + 6000);
    expect(equipo).not.toContain("openAusenciaDialog");
  });
});

// =====================================================================
// Fontanería común de los diálogos: un `fetch` de mentira que contesta lo
// que cada prueba necesite y GUARDA lo que el cliente ha enviado, para poder
// afirmar sobre el cuerpo exacto (P24: nunca `privateReason`).
// =====================================================================

type Peticion = { url: string; body: Record<string, unknown> };

function conFetchFalso(
  respuestas: Record<string, { ok: boolean; status: number; json: Record<string, unknown> }>,
): { peticiones: Peticion[]; restaurar: () => void } {
  const peticiones: Peticion[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: { body?: string }) => {
    peticiones.push({ url, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    // V3-14 — `/api/snapshot` es la petición que `refresh()` dispara tras
    // publicar, y hasta ahora caía en este `??` y se contestaba con `{}`: el
    // repintado moría dentro del `catch` de `refresh()` y ninguna de las
    // pruebas que decían «tras retirar, la fila ya no está» llegaba a
    // establecerlo. Se contesta con el mismo `{}` de antes —esta suite no
    // monta la pantalla entera, así que un repintado real no cabe aquí— pero
    // el hecho de PEDIRLA queda registrado en `peticiones`, y las pruebas
    // afirman sobre eso y sobre un repintado EXPLÍCITO con el calendario tal y
    // como el servidor lo deja, en vez de sobre un repintado que no ocurre.
    const r = respuestas[url] ?? { ok: true, status: 200, json: {} };
    return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.json) });
  }) as unknown as typeof fetch;
  return { peticiones, restaurar: () => { globalThis.fetch = original; } };
}

const IMPACTO_UNA_CITA = {
  impacted: [{ reservationId: "res-1", employeeId: 6, date: "2026-08-11", startMinutes: 600, endMinutes: 630, serviceId: 1 }],
};

const NO_DESTRUCCION =
  "Publicar esto no cancela, no mueve y no avisa a nadie. Las citas siguen exactamente donde están. Tú decides qué hacer con cada una.";

// =====================================================================
// R9 — el diálogo de cierres y días especiales, a CUATRO pasos.
// DISCRIMINANTE contra `277a0d5`: hoy son tres pasos, no hay tipo que elegir
// y el HTML afirma que la apertura especial «todavía no se hace».
// =====================================================================

describe("step 26 REAPERTURA · R9 — cierres y días especiales en cuatro pasos", () => {
  const HTML = renderConsoleHtml();
  const DIALOGO = HTML.slice(HTML.indexOf('id="dialogo-dia-especial"'), HTML.indexOf("</dialog>", HTML.indexOf('id="dialogo-dia-especial"')));

  function montar() {
    const { document, nodes } = createFakeDocumentWithIds([
      ...HORARIOS_IDS_R7,
      ...IDS_DIALOGO_DIA_ESPECIAL,
      ...IDS_DIALOGO_AUSENCIA,
      ...IDS_DIALOGO_EXCEPCION,
      ...IDS_FOCO,
      { id: "btn-abrir-dia-especial", tag: "button" },
      { id: "btn-abrir-ausencia", tag: "button" },
    ]);
    const hooks = loadUiClientHooks("", document);
    hooks.wireDiaEspecialDialog();
    hooks.wireAusenciaDialog();
    hooks.wireExcepcionDialog();
    return { document, nodes, hooks };
  }

  it("el texto obsoleto sobre la apertura especial ha desaparecido del HTML", () => {
    // La frase entera de `ui.html.ts` que decía que abrir el local con otro
    // horario «todavía no se hace desde esta pantalla». Ha dejado de ser
    // verdad, así que se borra. (La de duplicar una temporada sigue en pie:
    // ésa SÍ sigue siendo verdad, y no es la que este caso vigila.)
    expect(HTML).not.toContain("Abrir el local con un horario distinto todavía no se hace");
    expect(HTML).not.toContain("inventar disponibilidad que nadie ha confirmado");
    expect(DIALOGO).toContain("Un horario especial vale para un solo día.");
    expect(DIALOGO).toContain("El horario especial vale para todo el equipo.");
    // Y en ningún sitio VISIBLE se le llama «cierre parcial». (Los
    // comentarios del HTML servido sí lo nombran, para PROHIBIRLO; se quitan
    // antes de mirar, porque el operador no los lee.)
    const visible = HTML.replace(/<!--[\s\S]*?-->/g, "");
    expect(visible.toLowerCase()).not.toContain("cierre parcial");
  });

  it("el paso 1 ofrece los dos tipos SIN preselección, con su línea de puerta y el botón deshabilitado", () => {
    const paso1 = DIALOGO.slice(DIALOGO.indexOf('id="dia-especial-paso-1"'), DIALOGO.indexOf('id="dia-especial-paso-2"'));
    expect(paso1).toContain("Paso 1 de 4");
    expect(paso1).toContain('id="dia-especial-tipo-cierre"');
    expect(paso1).toContain('id="dia-especial-tipo-especial"');
    expect(paso1).toContain("Cerrado todo el día");
    expect(paso1).toContain("Horario especial");
    expect(paso1).not.toContain("checked");
    expect(paso1).toContain("Elige qué quieres hacer para continuar. No se rellena nada solo.");
    expect(paso1).toMatch(/id="dia-especial-siguiente-1"[^>]*disabled/);
    expect(paso1).toContain('aria-describedby="dia-especial-gate"');
  });

  it("los cuatro pasos están rotulados «Paso N de 4»", () => {
    for (const n of [1, 2, 3, 4]) expect(DIALOGO).toContain(`Paso ${n} de 4`);
    expect(DIALOGO).not.toContain("de 3 ·");
  });

  it("elegir «Cerrado todo el día» abre el rango; elegir «Horario especial» abre un solo día con horas", () => {
    const { nodes, hooks } = montar();
    hooks.openDiaEspecialDialog(null);
    expect((nodes["dia-especial-siguiente-1"] as FakeElement).disabled).toBe(true);
    expect((nodes["dia-especial-tipo-cierre"] as FakeElement).checked).toBe(false);
    expect((nodes["dia-especial-tipo-especial"] as FakeElement).checked).toBe(false);

    (nodes["dia-especial-tipo-especial"] as FakeElement).checked = true;
    (nodes["dia-especial-tipo-especial"] as FakeElement).dispatchChange();
    expect((nodes["dia-especial-siguiente-1"] as FakeElement).disabled).toBe(false);
    (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
    expect((nodes["dia-especial-paso-2"] as FakeElement).hidden).toBe(false);
    expect((nodes["dia-especial-campos-especial"] as FakeElement).hidden).toBe(false);
    expect((nodes["dia-especial-campos-cierre"] as FakeElement).hidden).toBe(true);

    // Deshacer: «Atrás» vuelve al paso 1 y el tipo se puede cambiar.
    (nodes["dia-especial-atras-1"] as FakeElement).dispatchClick();
    expect((nodes["dia-especial-paso-1"] as FakeElement).hidden).toBe(false);
    (nodes["dia-especial-tipo-cierre"] as FakeElement).checked = true;
    (nodes["dia-especial-tipo-cierre"] as FakeElement).dispatchChange();
    (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
    expect((nodes["dia-especial-campos-cierre"] as FakeElement).hidden).toBe(false);
    expect((nodes["dia-especial-campos-especial"] as FakeElement).hidden).toBe(true);
  });

  it("un cierre de RANGO con nota llega al servidor como venue_closure con startDate/endDate y note", async () => {
    const { nodes, hooks } = montar();
    const f = conFetchFalso({ "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } } });
    try {
      hooks.openDiaEspecialDialog(null);
      (nodes["dia-especial-tipo-cierre"] as FakeElement).checked = true;
      (nodes["dia-especial-tipo-cierre"] as FakeElement).dispatchChange();
      (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
      (nodes["dia-especial-desde"] as FakeElement).value = "2026-08-10";
      (nodes["dia-especial-hasta"] as FakeElement).value = "2026-08-14";
      (nodes["dia-especial-nombre"] as FakeElement).value = "cierre-reforma";
      (nodes["dia-especial-nota"] as FakeElement).value = "obras en la fachada";
      await hooks.diaEspecialGoToImpact();
      expect(f.peticiones[0]!.body).toEqual({
        changeKind: "venue_closure",
        id: "cierre-reforma-2026-08-10",
        startDate: "2026-08-10",
        endDate: "2026-08-14",
        note: "obras en la fachada",
      });
      // Paso 3 · Repaso: prosa, impacto vacío y la frase de no destrucción.
      expect((nodes["dia-especial-paso-3"] as FakeElement).hidden).toBe(false);
      const resumen = textoPlano(nodes["dia-especial-resumen"] as FakeElement);
      expect(resumen).toContain("Del lunes 10 al viernes 14 de agosto de 2026 el local no abre.");
      expect(resumen).toContain("Ningún cliente tiene cita en ese hueco.");
      expect(resumen).toContain(NO_DESTRUCCION);
      expect(resumen).toContain("obras en la fachada");
    } finally {
      f.restaurar();
    }
  });

  it("un HORARIO ESPECIAL llega como special_opening de UN día, y se dice en prosa qué pasa", async () => {
    const { nodes, hooks } = montar();
    const f = conFetchFalso({ "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } } });
    try {
      hooks.openDiaEspecialDialog(null);
      (nodes["dia-especial-tipo-especial"] as FakeElement).checked = true;
      (nodes["dia-especial-tipo-especial"] as FakeElement).dispatchChange();
      (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
      (nodes["dia-especial-dia"] as FakeElement).value = "2026-08-13";
      (nodes["dia-especial-abre"] as FakeElement).value = "10:00";
      (nodes["dia-especial-cierra"] as FakeElement).value = "14:00";
      (nodes["dia-especial-nombre"] as FakeElement).value = "apertura-corta";
      await hooks.diaEspecialGoToImpact();
      expect(f.peticiones[0]!.body).toEqual({
        changeKind: "special_opening",
        id: "apertura-corta-2026-08-13",
        date: "2026-08-13",
        specialOpen: "10:00",
        specialClose: "14:00",
      });
      const resumen = textoPlano(nodes["dia-especial-resumen"] as FakeElement);
      expect(resumen).toContain("El jueves 13 de agosto de 2026 el local abre de 10:00 a 14:00, en vez de su horario de siempre.");
      expect(resumen).not.toContain("cierre parcial");
    } finally {
      f.restaurar();
    }
  });

  it("con citas afectadas, «Publicar» no se habilita hasta que TODAS tienen resolución, y el impacto se lee entero", async () => {
    const { nodes, hooks } = montar();
    const f = conFetchFalso({ "/api/calendar/preview": { ok: true, status: 200, json: IMPACTO_UNA_CITA } });
    try {
      hooks.openDiaEspecialDialog(null);
      (nodes["dia-especial-tipo-cierre"] as FakeElement).checked = true;
      (nodes["dia-especial-tipo-cierre"] as FakeElement).dispatchChange();
      (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
      (nodes["dia-especial-desde"] as FakeElement).value = "2026-08-11";
      (nodes["dia-especial-hasta"] as FakeElement).value = "2026-08-11";
      (nodes["dia-especial-nombre"] as FakeElement).value = "cierre-suelto";
      await hooks.diaEspecialGoToImpact();
      const resumen = textoPlano(nodes["dia-especial-resumen"] as FakeElement);
      expect(resumen).toContain("1 cita de cliente cae en ese hueco.");
      expect(resumen).toContain("10:00");
      expect(resumen).toContain("10:30");
      expect(resumen).toContain("Revisarlas en la agenda");
      expect(resumen).toContain(NO_DESTRUCCION);
      // Nada que prometa una cancelación, una reasignación o un aviso automático.
      expect(resumen).not.toMatch(/se cancelar|se avisar|se reasign|se mover/);
      // El enlace de revisión lleva al día de la primera cita afectada.
      const enlaces: string[] = [];
      const recorrer = (n: FakeElement) => { if (n.tagName === "A") enlaces.push((n as unknown as { href: string }).href); for (const h of n.children) recorrer(h); };
      recorrer(nodes["dia-especial-resumen"] as FakeElement);
      expect(enlaces).toContain("#/agenda/dia/2026-08-11/todos");
      // La puerta de publicación.
      expect((nodes["dia-especial-guardar"] as FakeElement).disabled).toBe(true);
      const impacto = nodes["dia-especial-impacto"] as FakeElement;
      const radios: FakeElement[] = [];
      const buscarRadios = (n: FakeElement) => { if (n.tagName === "INPUT") radios.push(n); for (const h of n.children) buscarRadios(h); };
      buscarRadios(impacto);
      expect(radios.length).toBe(2);
      expect(radios.some((r) => r.checked)).toBe(false); // sin preselección
      radios[0]!.dispatchChange();
      expect((nodes["dia-especial-guardar"] as FakeElement).disabled).toBe(false);
    } finally {
      f.restaurar();
    }
  });

  it("un 409 por identificador repetido se cuenta en castellano, con el mensaje del servidor", async () => {
    const { nodes, hooks } = montar();
    const f = conFetchFalso({
      "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/publish": {
        ok: false,
        status: 409,
        json: { error: "Ya hay un cambio apuntado con ese nombre. Ponle otro, o retira el que hay." },
      },
    });
    try {
      hooks.openDiaEspecialDialog(null);
      (nodes["dia-especial-tipo-cierre"] as FakeElement).checked = true;
      (nodes["dia-especial-tipo-cierre"] as FakeElement).dispatchChange();
      (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
      (nodes["dia-especial-desde"] as FakeElement).value = "2026-08-11";
      (nodes["dia-especial-hasta"] as FakeElement).value = "2026-08-11";
      (nodes["dia-especial-nombre"] as FakeElement).value = "repetido";
      await hooks.diaEspecialGoToImpact();
      await hooks.diaEspecialPublish();
      expect((nodes["dia-especial-contador"] as FakeElement).textContent).toBe(
        "Ya hay un cambio apuntado con ese nombre. Ponle otro, o retira el que hay.",
      );
      // Y NO se ha cantado ningún éxito.
      expect((nodes["dia-especial-paso-4"] as FakeElement).hidden).toBe(true);
    } finally {
      f.restaurar();
    }
  });
});

// =====================================================================
// R10 + R11 (cliente) — el diálogo de ausencias, a CUATRO pasos, con nota.
// =====================================================================

describe("step 26 REAPERTURA · R10/R11 — ausencias en cuatro pasos, con nota operativa", () => {
  const HTML = renderConsoleHtml();
  const DIALOGO = HTML.slice(HTML.indexOf('id="dialogo-ausencia"'), HTML.indexOf("</dialog>", HTML.indexOf('id="dialogo-ausencia"')));

  function montar() {
    const { document, nodes } = createFakeDocumentWithIds([
      ...HORARIOS_IDS_R7,
      ...IDS_DIALOGO_DIA_ESPECIAL,
      ...IDS_DIALOGO_AUSENCIA,
      ...IDS_DIALOGO_EXCEPCION,
      ...IDS_FOCO,
      { id: "btn-abrir-dia-especial", tag: "button" },
      { id: "btn-abrir-ausencia", tag: "button" },
    ]);
    const hooks = loadUiClientHooks("", document);
    hooks.wireDiaEspecialDialog();
    hooks.wireAusenciaDialog();
    hooks.wireExcepcionDialog();
    return { document, nodes, hooks };
  }

  it("V3-10 — la nota de privacidad dice la verdad: la nota SÍ se guarda y SÍ se ve", () => {
    // La frase servida decía «Sólo se guarda el tipo de ausencia», y es falsa:
    // la nota operativa viaja en `change.note`, el servidor la conserva en el
    // sello de auditoría y esta misma pantalla la PINTA en la fila de la
    // excepción (`.tx-nota-operativa`) y en el repaso de los diálogos. Decirle
    // al operador que sólo se guarda el tipo, en el párrafo que está justo
    // debajo del campo de nota, es enseñarle mal dónde acaba lo que escribe.
    expect(DIALOGO).not.toContain("Sólo se guarda el tipo de ausencia");
    expect(DIALOGO).toContain("De esta ausencia se guardan el tipo y, si la escribes, la nota");
    // Lo que sí sigue siendo verdad, y sigue dicho: el cliente nunca lo ve.
    expect(DIALOGO).toContain("Ningún cliente verá nunca por qué falta alguien.");
    // Y la frase falsa no queda escondida en ninguna otra pantalla.
    expect(HTML).not.toContain("Sólo se guarda el tipo de ausencia");
  });

  it("el campo de nota es opcional, tiene tope de 280 y su ayuda NO pide ningún dato médico", () => {
    expect(DIALOGO).toContain('id="ausencia-nota"');
    // V3-12 — el tope ya NO lo pone `maxlength`: la barrera del navegador
    // cortaba un pegado largo en silencio y además cuenta unidades UTF-16,
    // mientras el servidor cuenta puntos de código. Lo pone el cliente,
    // contando como el servidor, y lo enseña en su contador.
    expect(DIALOGO).not.toMatch(/id="ausencia-nota"[^>]*maxlength/);
    expect(DIALOGO).toContain('id="ausencia-nota-contador"');
    expect(DIALOGO).toMatch(/id="ausencia-nota"[^>]*aria-describedby="ausencia-nota-ayuda ausencia-nota-contador"/);
    expect(DIALOGO).toContain("Nota para el equipo (opcional)");
    expect(DIALOGO).toContain("No hace falta poner ningún motivo médico ni personal, y no se pide.");
    for (const prohibido of ["diagnóstico", "enfermedad", "baja médica", "parte médico", "motivo médico:"]) {
      expect(DIALOGO.toLowerCase()).not.toContain(prohibido);
    }
    // Los TRES diálogos llevan el MISMO campo, con el mismo contador — el de
    // la retirada incluido (V1-9): la única capacidad que quita una excepción
    // del calendario era la única que no podía explicar por qué.
    for (const [dialogo, campo] of [
      ["dialogo-dia-especial", "dia-especial-nota"],
      ["dialogo-ausencia", "ausencia-nota"],
      ["dialogo-excepcion", "excepcion-nota"],
    ]) {
      const trozo = HTML.slice(HTML.indexOf(`id="${dialogo}"`), HTML.indexOf("</dialog>", HTML.indexOf(`id="${dialogo}"`)));
      expect(trozo, dialogo).toContain(`id="${campo}"`);
      expect(trozo, dialogo).toContain(`id="${campo}-contador"`);
      expect(trozo, dialogo).toMatch(new RegExp(`id="${campo}"[^>]*aria-describedby="${campo}-ayuda ${campo}-contador"`));
      expect(trozo, dialogo).not.toMatch(new RegExp(`id="${campo}"[^>]*maxlength`));
      expect(trozo, dialogo).toContain("No hace falta poner ningún motivo médico ni personal, y no se pide.");
    }
  });

  it("«Todo el día» es la única preselección autorizada, y desmarcarla saca las horas", () => {
    expect(DIALOGO).toMatch(/id="ausencia-todo-el-dia"[^>]*checked/);
    // Ningún otro control del diálogo nace elegido: ni el motivo ni las fechas.
    const paso1 = DIALOGO.slice(DIALOGO.indexOf('id="ausencia-paso-1"'), DIALOGO.indexOf('id="ausencia-paso-2"'));
    expect(paso1).not.toContain("checked");
    const { nodes, hooks } = montar();
    hooks.openAusenciaDialog(null);
    expect((nodes["ausencia-todo-el-dia"] as FakeElement).checked).toBe(true);
    (nodes["ausencia-todo-el-dia"] as FakeElement).checked = false;
    (nodes["ausencia-todo-el-dia"] as FakeElement).dispatchChange();
    expect((nodes["ausencia-campos-horas"] as FakeElement).hidden).toBe(false);
  });

  it("una ausencia de días COMPLETOS se publica con su prosa, su impacto y sin `privateReason`", async () => {
    const { nodes, hooks } = montar();
    const f = conFetchFalso({ "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } } });
    try {
      hooks.openAusenciaDialog(null, null, { engineToday: "2026-08-05", calendar: CAL });
      (nodes["ausencia-profesional"] as FakeElement).value = "6";
      (nodes["ausencia-motivo-vacation"] as FakeElement).checked = true;
      (nodes["ausencia-desde"] as FakeElement).value = "2026-08-10";
      (nodes["ausencia-hasta"] as FakeElement).value = "2026-08-12";
      (nodes["ausencia-nombre"] as FakeElement).value = "vacaciones-bea";
      (nodes["ausencia-nota"] as FakeElement).value = "vuelve el jueves";
      (nodes["ausencia-siguiente-1"] as FakeElement).dispatchClick();
      expect((nodes["ausencia-paso-2"] as FakeElement).hidden).toBe(false);
      await hooks.ausenciaGoToImpact();
      const cuerpo = f.peticiones[0]!.body;
      expect(cuerpo).toEqual({
        changeKind: "employee_absence",
        id: "vacaciones-bea-2026-08-10",
        employeeId: 6,
        absenceKind: "vacation",
        startDate: "2026-08-10",
        endDate: "2026-08-12",
        allDay: true,
        note: "vuelve el jueves",
      });
      expect(JSON.stringify(cuerpo)).not.toContain("privateReason");
      const resumen = textoPlano(nodes["ausencia-resumen"] as FakeElement);
      expect(resumen).toContain("no está del lunes 10 al miércoles 12 de agosto de 2026, los días enteros.");
      expect(resumen).toContain("vuelve el jueves");
      expect(resumen).toContain(NO_DESTRUCCION);
    } finally {
      f.restaurar();
    }
  });

  it("una ausencia PARCIAL manda startMinutes/endMinutes y lo dice en prosa con sus horas", async () => {
    const { nodes, hooks } = montar();
    const f = conFetchFalso({ "/api/calendar/preview": { ok: true, status: 200, json: IMPACTO_UNA_CITA } });
    try {
      hooks.openAusenciaDialog(null, null, { engineToday: "2026-08-05", calendar: CAL });
      (nodes["ausencia-profesional"] as FakeElement).value = "6";
      (nodes["ausencia-motivo-absence"] as FakeElement).checked = true;
      (nodes["ausencia-desde"] as FakeElement).value = "2026-08-10";
      (nodes["ausencia-hasta"] as FakeElement).value = "2026-08-10";
      (nodes["ausencia-nombre"] as FakeElement).value = "medio-dia";
      (nodes["ausencia-siguiente-1"] as FakeElement).dispatchClick();
      (nodes["ausencia-todo-el-dia"] as FakeElement).checked = false;
      (nodes["ausencia-todo-el-dia"] as FakeElement).dispatchChange();
      (nodes["ausencia-desde-hora"] as FakeElement).value = "09:00";
      (nodes["ausencia-hasta-hora"] as FakeElement).value = "12:00";
      await hooks.ausenciaGoToImpact();
      expect(f.peticiones[0]!.body).toMatchObject({ allDay: false, startMinutes: 540, endMinutes: 720 });
      const resumen = textoPlano(nodes["ausencia-resumen"] as FakeElement);
      expect(resumen).toContain("no está el lunes 10 de agosto de 2026, de 09:00 a 12:00.");
      expect(resumen).toContain("1 cita de cliente cae en ese hueco.");
      expect(resumen).toContain(NO_DESTRUCCION);
    } finally {
      f.restaurar();
    }
  });

  it("la nota se pinta SIEMPRE con textContent: 280 caracteres hostiles se leen como texto y no crean ningún nodo", async () => {
    const HOSTIL = '<img src=x onerror="alert(1)"><script>alert(2)</script>' + "A".repeat(280 - 54);
    const { nodes, hooks } = montar();
    const f = conFetchFalso({ "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } } });
    try {
      hooks.openAusenciaDialog(null, null, { engineToday: "2026-08-05", calendar: CAL });
      (nodes["ausencia-profesional"] as FakeElement).value = "6";
      (nodes["ausencia-motivo-training"] as FakeElement).checked = true;
      (nodes["ausencia-desde"] as FakeElement).value = "2026-08-10";
      (nodes["ausencia-hasta"] as FakeElement).value = "2026-08-10";
      (nodes["ausencia-nombre"] as FakeElement).value = "formacion";
      (nodes["ausencia-nota"] as FakeElement).value = HOSTIL;
      (nodes["ausencia-siguiente-1"] as FakeElement).dispatchClick();
      await hooks.ausenciaGoToImpact();
      const resumen = nodes["ausencia-resumen"] as FakeElement;
      const notas: FakeElement[] = [];
      const recorrer = (n: FakeElement) => { if (n.className === "tx-nota-operativa") notas.push(n); for (const h of n.children) recorrer(h); };
      recorrer(resumen);
      expect(notas.length).toBe(1);
      expect(notas[0]!.textContent).toBe(HOSTIL);
      expect(notas[0]!.children.length).toBe(0); // texto, no marcado
      expect(notas[0]!.tagName).toBe("SPAN");
      // El cliente no construye NINGÚN href con la nota.
      const enlaces: string[] = [];
      const buscar = (n: FakeElement) => { if (n.tagName === "A") enlaces.push((n as unknown as { href: string }).href ?? ""); for (const h of n.children) buscar(h); };
      buscar(resumen);
      expect(enlaces.join(" ")).not.toContain("onerror");
    } finally {
      f.restaurar();
    }
  });

  it("el cliente no escribe, no lee y NO NOMBRA `privateReason`: ni una vez, ni en un comentario", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    // Ni una asignación, ni una lectura de propiedad, ni una clave de objeto.
    expect(js).not.toMatch(/privateReason\s*[:=]/);
    expect(js).not.toMatch(/\.privateReason/);
    // V3-8 — esta línea era `/\['"]privateReason['"]\]/`, que dentro de una
    // clase de caracteres NO es «comilla simple o doble»: es un ESCAPE de `[`
    // seguido de `'"'` literal, así que exigía la cadena imposible
    // `["'privateReason'"]`. No podía fallar nunca. Escrita bien —clase de
    // caracteres de verdad, y espacios opcionales— sí vigila el acceso por
    // corchetes, que es la vía que las otras dos no cubren.
    expect(js).not.toMatch(/\[\s*['"]privateReason['"]\s*\]/);
    // Y el candado se endurece a IGUALDAD EXACTA: `toBeLessThanOrEqual(1)`
    // dejaba pasar una aparición que hoy no existe. El nombre exacto no se
    // escribe en este fichero ni siquiera para decir que no se envía — el
    // comentario del código lo explica sin nombrarlo, a propósito, para que
    // este candado pueda ser cero.
    const apariciones = js.split("privateReason").length - 1;
    expect(apariciones, "ui.js.ts ha empezado a nombrar el motivo privado").toBe(0);
    // Y tampoco aparece en lo que se SIRVE, que es lo que un navegador ve.
    expect(renderConsoleAppJs()).not.toContain("privateReason");
  });

  it("la clase de la nota trae en el CSS servido las dos declaraciones que impiden el desbordamiento", () => {
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    const regla = /\.tx-nota-operativa\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(regla).toContain("overflow-wrap: anywhere");
    expect(regla).toContain("min-width: 0");
    expect(css).toContain(".tx-dialog__summary");
  });

  // -------------------------------------------------------------------
  // R10 · NADIE VIENE ELEGIDO — el desplegable de profesional.
  //
  // El verificador de la reapertura publicó una ausencia aprobada CONTRA EL
  // EMPLEADO 3 sin tocar nunca el desplegable: `ensureProfessionalOptions`
  // se llamaba sin opción vacía, así que el navegador autoseleccionaba la
  // opción 0 —un profesional de verdad— y la guarda `if (!quien)` no podía
  // dispararse jamás. La única preselección autorizada de toda la reapertura
  // es «Todo el día» (§R10); ésta no lo estaba, y además decidía por el
  // operador a quién dejaba sin trabajar.
  // -------------------------------------------------------------------

  it("el desplegable de profesional nace con una opción VACÍA, y es la que el navegador autoselecciona", () => {
    // (a) En el HTML servido, igual que `#huecos-profesional`.
    expect(DIALOGO).toContain('<select id="ausencia-profesional"><option value="">Elige a quién</option></select>');
    // (b) Y tras poblarlo con la instantánea, la opción 0 —la que un navegador
    //     elige solo— sigue siendo la vacía, no un profesional de verdad.
    const { nodes, hooks } = montar();
    hooks.openAusenciaDialog(null, null, { engineToday: "2026-08-05", calendar: CAL });
    const select = nodes["ausencia-profesional"] as FakeElement;
    expect(select.options.length).toBe(CAL.professionals.length + 1);
    expect(select.options[0]!.value).toBe("");
    expect(select.value).toBe("");
  });

  it("la explotación del verificador: relleno todo MENOS el desplegable y no se puede publicar", async () => {
    const { nodes, hooks } = montar();
    const f = conFetchFalso({ "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } } });
    try {
      hooks.openAusenciaDialog(null, null, { engineToday: "2026-08-05", calendar: CAL });
      const select = nodes["ausencia-profesional"] as FakeElement;
      // Lo que hace un navegador de verdad con un `<select>` que nadie ha
      // tocado: se queda con la opción 0. Aquí se escribe a mano porque el DOM
      // falso no autoselecciona; ésa es exactamente la línea que reproduce la
      // explotación.
      select.value = select.options[0]!.value;
      (nodes["ausencia-motivo-vacation"] as FakeElement).checked = true;
      (nodes["ausencia-desde"] as FakeElement).value = "2026-08-10";
      (nodes["ausencia-hasta"] as FakeElement).value = "2026-08-12";
      (nodes["ausencia-nombre"] as FakeElement).value = "vacaciones-de-nadie";
      (nodes["ausencia-siguiente-1"] as FakeElement).dispatchClick();
      // El paso 2 NO se abre, y se dice por qué en castellano.
      expect((nodes["ausencia-paso-2"] as FakeElement).hidden).toBe(true);
      expect((nodes["ausencia-paso-1"] as FakeElement).hidden).toBe(false);
      expect(textoPlano(nodes["ausencia-paso1-error"] as FakeElement)).toContain("Elige a quién");
      // Y aunque se salte el paso 1 llamando directamente al repaso, no sale
      // ni una petición: nada llega al servidor sin un profesional elegido.
      await hooks.ausenciaGoToImpact();
      expect(f.peticiones).toHaveLength(0);
      expect(textoPlano(nodes["ausencia-paso1-error"] as FakeElement)).toContain("Elige a quién");
      // En cuanto se elige a alguien, el mismo formulario avanza.
      select.value = "6";
      (nodes["ausencia-siguiente-1"] as FakeElement).dispatchClick();
      expect((nodes["ausencia-paso-2"] as FakeElement).hidden).toBe(false);
    } finally {
      f.restaurar();
    }
  });

  it("el desplegable se reinicia entre aperturas: lo elegido en un «Cambiar» no se hereda en el alta siguiente", () => {
    const { nodes, hooks } = montar();
    const snap = { engineToday: "2026-08-05", calendar: CAL };
    // Primera apertura: la segunda mitad de un «Cambiar», que SÍ precarga.
    hooks.openAusenciaDialog(null, { employeeId: 6, absenceKind: "vacation", startDate: "2026-08-10", endDate: "2026-08-12", allDay: true, id: "vacaciones-bea-2026-08-10" }, snap);
    expect((nodes["ausencia-profesional"] as FakeElement).value).toBe("6");
    // Segunda apertura, sin precarga: nadie viene elegido.
    hooks.openAusenciaDialog(null, null, snap);
    expect((nodes["ausencia-profesional"] as FakeElement).value).toBe("");
  });

  it("candado de §R13 — la precarga de «Cambiar» sigue trayendo al profesional del registro retirado", () => {
    const { nodes, hooks } = montar();
    hooks.openAusenciaDialog(
      null,
      { employeeId: 9, absenceKind: "training", startDate: "2026-09-01", endDate: "2026-09-02", allDay: false, startMinutes: 540, endMinutes: 720, id: "curso-2026-09-01", note: "curso de color" },
      { engineToday: "2026-08-05", calendar: CAL },
    );
    expect((nodes["ausencia-profesional"] as FakeElement).value).toBe("9");
    expect((nodes["ausencia-motivo-training"] as FakeElement).checked).toBe(true);
    expect((nodes["ausencia-desde"] as FakeElement).value).toBe("2026-09-01");
    expect((nodes["ausencia-desde-hora"] as FakeElement).value).toBe("09:00");
  });
});

// =====================================================================
// R13 (cliente) — Cambiar y Retirar desde el detalle de cada excepción.
// =====================================================================

describe("step 26 REAPERTURA · R13 — retirar y cambiar una excepción", () => {
  const CAL_CON_TODO = {
    ...CAL,
    closures: [
      { id: "cierre-reforma", approval: "approved", startDate: "2026-08-10", endDate: "2026-08-14", audit: { createdAt: "x", createdBy: "y", note: "obras" } },
    ],
    venueRules: [
      ...VENUE_RULES,
      { id: "apertura-larga", approval: "approved", date: "2026-08-20", closed: false, specialOpen: "10:00", specialClose: "22:00", audit: { createdAt: "x", createdBy: "y" } },
    ],
  };

  function montar(respuestas: Record<string, { ok: boolean; status: number; json: Record<string, unknown> }>) {
    const { document, nodes } = createFakeDocumentWithIds([
      ...HORARIOS_IDS_R7,
      ...IDS_DIALOGO_DIA_ESPECIAL,
      ...IDS_DIALOGO_AUSENCIA,
      ...IDS_DIALOGO_EXCEPCION,
      ...IDS_FOCO,
      { id: "btn-abrir-dia-especial", tag: "button" },
      { id: "btn-abrir-ausencia", tag: "button" },
    ]);
    const hooks = loadUiClientHooks("", document);
    hooks.wireDiaEspecialDialog();
    hooks.wireAusenciaDialog();
    hooks.wireExcepcionDialog();
    const f = conFetchFalso(respuestas);
    return { document, nodes, hooks, f };
  }

  /**
   * El botón que se pida, de la fila que se pida. Se busca por `data-key` y
   * no por posición: el orden de la lista es cronológico y una prueba que
   * dependiera de él se rompería al añadir un fixture.
   */
  function botonDeFila(nodes: Record<string, FakeElement>, listaId: string, clave: string, rotulo: string): FakeElement {
    const fila = nodes[listaId]!.children.find((li) => li.getAttribute("data-key") === clave)!;
    const botones: FakeElement[] = [];
    const recorrer = (n: FakeElement) => { if (n.tagName === "BUTTON" && n.textContent === rotulo) botones.push(n); for (const h of n.children) recorrer(h); };
    recorrer(fila);
    return botones[0]!;
  }

  it("«Retirar» sin impacto: se previsualiza, se dice que no afecta a nadie, y se publica la retirada", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Retirar").onclick?.();
      await hooks.excepcionPreview();
      expect(f.peticiones[0]).toEqual({
        url: "/api/calendar/withdrawal/preview",
        body: { targetKind: "venue_closure", id: "cierre-reforma" },
      });
      const resumen = textoPlano(nodes["excepcion-resumen"] as FakeElement);
      expect(resumen).toContain("Ningún cliente tiene cita en ese hueco.");
      expect(resumen).toContain(NO_DESTRUCCION);
      expect((nodes["excepcion-confirmar"] as FakeElement).disabled).toBe(false);
      await hooks.excepcionPublish();
      expect(f.peticiones[1]!.url).toBe("/api/calendar/withdrawal/publish");
      expect(f.peticiones[1]!.body).toEqual({ target: { targetKind: "venue_closure", id: "cierre-reforma" }, resolutions: {} });
      expect((nodes["excepcion-paso-3"] as FakeElement).hidden).toBe(false);
      // V3-14 — y se PIDE la instantánea nueva: publicar sin volver a mirar
      // dejaría la pantalla contando un mundo que ya no existe.
      expect(f.peticiones.map((p) => p.url)).toContain("/api/snapshot");
      // Lo que el servidor deja tras una retirada es la fila marcada
      // `rejected`, conservada (§R13). Repintando con ESO, la fila desaparece
      // de la lista — que es lo que la pantalla promete y lo que antes no se
      // llegaba a comprobar.
      const trasRetirar = {
        ...CAL_CON_TODO,
        closures: CAL_CON_TODO.closures.map((c) => (c.id === "cierre-reforma" ? { ...c, approval: "rejected" } : c)),
      };
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: trasRetirar });
      expect((nodes["horarios-excepciones-mes"] as FakeElement).children.map((li) => li.getAttribute("data-key")))
        .not.toContain("closure-cierre-reforma");
    } finally {
      f.restaurar();
    }
  });

  it("retirar un HORARIO ESPECIAL puede romper citas: se exige resolución por cada una antes de confirmar", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: IMPACTO_UNA_CITA },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      const lista = nodes["horarios-excepciones-mes"] as FakeElement;
      const fila = lista.children.find((li) => li.getAttribute("data-key") === "rule-apertura-larga")!;
      const botones: FakeElement[] = [];
      const recorrer = (n: FakeElement) => { if (n.tagName === "BUTTON") botones.push(n); for (const h of n.children) recorrer(h); };
      recorrer(fila);
      botones.find((b) => b.textContent === "Retirar")!.onclick?.();
      await hooks.excepcionPreview();
      expect(f.peticiones[0]!.body).toEqual({ targetKind: "venue_rule", id: "apertura-larga" });
      const resumen = textoPlano(nodes["excepcion-resumen"] as FakeElement);
      expect(resumen).toContain("1 cita de cliente cae en ese hueco.");
      expect(resumen).toContain("Revisarlas en la agenda");
      expect((nodes["excepcion-confirmar"] as FakeElement).disabled).toBe(true);
      const radios: FakeElement[] = [];
      const buscar = (n: FakeElement) => { if (n.tagName === "INPUT") radios.push(n); for (const h of n.children) buscar(h); };
      buscar(nodes["excepcion-impacto"] as FakeElement);
      expect(radios.some((r) => r.checked)).toBe(false);
      radios[1]!.dispatchChange();
      expect((nodes["excepcion-confirmar"] as FakeElement).disabled).toBe(false);
    } finally {
      f.restaurar();
    }
  });

  it("un 404 del servidor se cuenta en castellano, sin prometer nada", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: false, status: 404, json: { error: "No hay ningún cambio con ese identificador." } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Retirar").onclick?.();
      await hooks.excepcionPreview();
      expect((nodes["excepcion-error"] as FakeElement).textContent).toContain("No hay ningún cambio con ese identificador.");
      expect((nodes["excepcion-paso-2"] as FakeElement).hidden).toBe(true);
    } finally {
      f.restaurar();
    }
  });

  it("un 409 al publicar la retirada vuelve a pedir el repaso, y no canta ningún éxito", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: false, status: 409, json: { applied: false, unresolved: IMPACTO_UNA_CITA.impacted } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Retirar").onclick?.();
      await hooks.excepcionPreview();
      await hooks.excepcionPublish();
      expect((nodes["excepcion-contador"] as FakeElement).textContent).toContain("Vuelve a revisarlas");
      expect((nodes["excepcion-paso-3"] as FakeElement).hidden).toBe(true);
    } finally {
      f.restaurar();
    }
  });

  it("«Cambiar» es retirar + alta nueva, y el repaso lo dice con la frase literal del normativo", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Cambiar").onclick?.();
      await hooks.excepcionPreview();
      expect(textoPlano(nodes["excepcion-resumen"] as FakeElement)).toContain(
        "Esto se apunta como dos cambios: primero se retira el que hay y después se crea el nuevo.",
      );
      await hooks.excepcionPublish();
      expect(f.peticiones.map((p) => p.url)).toContain("/api/snapshot");
      // Tras retirar, la segunda mitad del cambio: el alta, ya precargada.
      expect((nodes["excepcion-crear-nuevo"] as FakeElement).hidden).toBe(false);
      (nodes["excepcion-crear-nuevo"] as FakeElement).dispatchClick();
      expect((nodes["dialogo-dia-especial"] as FakeElement).open).toBe(true);
      expect((nodes["dia-especial-desde"] as FakeElement).value).toBe("2026-08-10");
      expect((nodes["dia-especial-hasta"] as FakeElement).value).toBe("2026-08-14");
      expect((nodes["dia-especial-nombre"] as FakeElement).value).toBe("cierre-reforma");
      expect((nodes["dia-especial-tipo-cierre"] as FakeElement).checked).toBe(true);
    } finally {
      f.restaurar();
    }
  });

  // ===================================================================
  // V3-6 refuerzo — EL AVISO TIENE QUE LEERSE ANTES DE QUE HAYA UN
  // «CANCELAR» ALCANZABLE, no sólo en el repaso final.
  //
  // El defecto: `FRASE_SEGUNDA_MITAD` sólo se pintaba dentro del repaso
  // (paso 3), pero el alta precargada de un «Cambiar» abre directamente en
  // el paso 2 (día especial) o en el paso 1 (ausencia) — los dos con su
  // propio botón «Cancelar» ya alcanzable. Quien cancelara antes de llegar
  // al paso 3 nunca leía que la retirada ya estaba hecha.
  // ===================================================================

  it("V3-6 refuerzo — día especial: el aviso ya está en el paso 2 (el inicial del precargado), antes del repaso", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Cambiar").onclick?.();
      await hooks.excepcionPreview();
      await hooks.excepcionPublish();
      // La segunda mitad: el alta se abre YA PRECARGADA. Ni una llamada ni un
      // clic más: esto es lo primero que ve el operador.
      (nodes["excepcion-crear-nuevo"] as FakeElement).dispatchClick();
      // El paso inicial de un precargado es el 2, y su «Cancelar» ya está ahí.
      expect((nodes["dia-especial-paso-2"] as FakeElement).hidden).toBe(false);
      const aviso = nodes["dia-especial-aviso-retirada"] as FakeElement;
      expect(aviso.hidden, "el aviso tiene que estar visible ANTES del repaso").toBe(false);
      expect(aviso.textContent).toContain(
        "El anterior ya está retirado. Si cancelas ahora, esas fechas se quedan sin excepción.",
      );
    } finally {
      f.restaurar();
    }
  });

  it("V3-6 refuerzo — ausencia: el aviso ya está en el paso 1 (el inicial del precargado), antes del repaso", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
      // El precargado de una ausencia lee `latestSnapshot` para poblar el
      // desplegable de profesionales (`ensureProfessionalOptions`); se
      // fija aquí para que ese repintado no dependa de una instantánea que
      // esta prueba no monta.
      "/api/snapshot": { ok: true, status: 200, json: { engineToday: "2026-08-05", calendar: CAL_CON_TODO } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-ausencias", "absence-aus-parcial", "Cambiar").onclick?.();
      await hooks.excepcionPreview();
      await hooks.excepcionPublish();
      (nodes["excepcion-crear-nuevo"] as FakeElement).dispatchClick();
      expect((nodes["ausencia-paso-1"] as FakeElement).hidden).toBe(false);
      const aviso = nodes["ausencia-aviso-retirada"] as FakeElement;
      expect(aviso.hidden, "el aviso tiene que estar visible ANTES del repaso").toBe(false);
      expect(aviso.textContent).toContain(
        "El anterior ya está retirado. Si cancelas ahora, esas fechas se quedan sin excepción.",
      );
    } finally {
      f.restaurar();
    }
  });

  it("V3-6 refuerzo — un alta NORMAL (sin retirada previa) nunca enseña el aviso, en ningún paso", async () => {
    const { nodes, hooks, f } = montar({ "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } } });
    try {
      hooks.openDiaEspecialDialog(null);
      expect((nodes["dia-especial-aviso-retirada"] as FakeElement).hidden).toBe(true);
      (nodes["dia-especial-tipo-cierre"] as FakeElement).checked = true;
      (nodes["dia-especial-tipo-cierre"] as FakeElement).dispatchChange();
      (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
      expect((nodes["dia-especial-paso-2"] as FakeElement).hidden).toBe(false);
      expect((nodes["dia-especial-aviso-retirada"] as FakeElement).hidden).toBe(true);
      (nodes["dia-especial-desde"] as FakeElement).value = "2026-09-01";
      (nodes["dia-especial-hasta"] as FakeElement).value = "2026-09-02";
      (nodes["dia-especial-nombre"] as FakeElement).value = "alta normal";
      await hooks.diaEspecialGoToImpact();
      expect((nodes["dia-especial-paso-3"] as FakeElement).hidden).toBe(false);
      expect(textoPlano(nodes["dia-especial-resumen"] as FakeElement)).not.toContain("El anterior ya está retirado.");

      hooks.openAusenciaDialog(null, null, { engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      expect((nodes["ausencia-aviso-retirada"] as FakeElement).hidden).toBe(true);
    } finally {
      f.restaurar();
    }
  });

  it("V3-6 — la SEGUNDA mitad del cambio habla en pasado, y dice qué pasa si se cancela ahora", async () => {
    // Lo que la revisión demostró contra `f6ab8e7`: el alta precargada repetía
    // «primero se retira el que hay y después se crea el nuevo» cuando la
    // retirada YA ESTABA PUBLICADA, junto a un botón «Cancelar» que no deshace
    // nada. Aquí se afirman las dos mitades por separado: la primera habla en
    // futuro (y hace bien), la segunda en pasado.
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
      "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Cambiar").onclick?.();
      await hooks.excepcionPreview();
      // Primera mitad: futuro, porque todavía no se ha retirado nada.
      const primera = textoPlano(nodes["excepcion-resumen"] as FakeElement);
      expect(primera).toContain("Esto se apunta como dos cambios: primero se retira el que hay y después se crea el nuevo.");
      expect(primera).not.toContain("El anterior ya está retirado.");
      await hooks.excepcionPublish();
      (nodes["excepcion-crear-nuevo"] as FakeElement).dispatchClick();
      // Segunda mitad: la retirada ya está hecha. Se previsualiza el alta.
      await hooks.diaEspecialGoToImpact();
      const segunda = textoPlano(nodes["dia-especial-resumen"] as FakeElement);
      expect(segunda).toContain("El anterior ya está retirado. Si cancelas ahora, esas fechas se quedan sin excepción.");
      expect(segunda).not.toContain("primero se retira el que hay y después se crea el nuevo");
      // El repaso ya lo dice dentro de `dia-especial-resumen`: el aviso
      // suelto de fuera de los pasos se oculta aquí para no duplicarlo.
      expect((nodes["dia-especial-aviso-retirada"] as FakeElement).hidden).toBe(true);
    } finally {
      f.restaurar();
    }
  });

  // ===================================================================
  // V3-2 / §R13-3 (deuda D-B2-4) — EL IDENTIFICADOR LO CONSTRUYE LA CONSOLA.
  // Antes viajaba tal cual lo que el operador escribía: «Cierre por reforma»
  // se estrellaba contra el patrón del servidor, y el mismo nombre repetido
  // en dos años chocaba con un 409 sin culpa de nadie.
  // ===================================================================

  /** El patrón EXACTO que valida el servidor (contrato compartido, server.ts). */
  const PATRON_ID_SERVIDOR = /^[a-z0-9][a-z0-9._-]{0,199}$/;

  async function idPublicadoDeCierre(nombre: string, desde: string, hasta: string): Promise<string> {
    const { nodes, hooks, f } = montar({ "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } } });
    try {
      hooks.openDiaEspecialDialog(null);
      (nodes["dia-especial-tipo-cierre"] as FakeElement).checked = true;
      (nodes["dia-especial-tipo-cierre"] as FakeElement).dispatchChange();
      (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
      (nodes["dia-especial-desde"] as FakeElement).value = desde;
      (nodes["dia-especial-hasta"] as FakeElement).value = hasta;
      (nodes["dia-especial-nombre"] as FakeElement).value = nombre;
      await hooks.diaEspecialGoToImpact();
      return String((f.peticiones[0]!.body as { id?: unknown }).id ?? "");
    } finally {
      f.restaurar();
    }
  }

  it("un nombre escrito como se habla produce un identificador que el servidor acepta", async () => {
    // Con acentos, mayúsculas, espacios y signos: lo que un operador escribe.
    const id = await idPublicadoDeCierre("Cierre por REFORMA (fachada) ñ", "2026-08-10", "2026-08-14");
    expect(id).toMatch(PATRON_ID_SERVIDOR);
    expect(id).toBe("cierre-por-reforma-fachada-n-2026-08-10");
  });

  it("el mismo nombre en fechas distintas produce identificadores distintos: el 409 deja de saltar por nada", async () => {
    const a = await idPublicadoDeCierre("Cierre de verano", "2026-07-01", "2026-07-15");
    const b = await idPublicadoDeCierre("Cierre de verano", "2027-07-01", "2027-07-15");
    expect(a).not.toBe(b);
    expect(a).toBe("cierre-de-verano-2026-07-01");
    expect(b).toBe("cierre-de-verano-2027-07-01");
    // Y el mismo nombre en la MISMA fecha sí produce el mismo: el sufijo es
    // estable, así que un 409 de nombre repetido sigue queriendo decir «eso ya
    // está apuntado», que es la única cosa útil que puede querer decir.
    const c = await idPublicadoDeCierre("Cierre de verano", "2026-07-01", "2026-07-20");
    expect(c).toBe(a);
  });

  it("un nombre sin ni una letra ni un número se rechaza AQUÍ, en castellano, y no llega al servidor", async () => {
    const { nodes, hooks, f } = montar({ "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } } });
    try {
      hooks.openDiaEspecialDialog(null);
      (nodes["dia-especial-tipo-cierre"] as FakeElement).checked = true;
      (nodes["dia-especial-tipo-cierre"] as FakeElement).dispatchChange();
      (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
      (nodes["dia-especial-desde"] as FakeElement).value = "2026-08-10";
      (nodes["dia-especial-hasta"] as FakeElement).value = "2026-08-14";
      (nodes["dia-especial-nombre"] as FakeElement).value = "¿¿ ?? — ···";
      await hooks.diaEspecialGoToImpact();
      expect(f.peticiones).toEqual([]);
      expect((nodes["dia-especial-paso1-error"] as FakeElement).textContent)
        .toBe("Ponle un nombre con letras o números. Sirve para reconocerlo luego en la lista.");
    } finally {
      f.restaurar();
    }
  });

  it("«Cambiar» precarga el NOMBRE, no el identificador: cambiar la fecha da un identificador nuevo", async () => {
    const CAL_CON_ID_FECHADO = {
      ...CAL_CON_TODO,
      closures: [
        { id: "cierre-de-verano-2026-07-01", approval: "approved", startDate: "2026-07-01", endDate: "2026-07-15", audit: { createdAt: "x", createdBy: "y" } },
      ],
    };
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
      "/api/calendar/preview": { ok: true, status: 200, json: { impacted: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_ID_FECHADO });
      botonDeFila(nodes, "calendario-excepciones-anteriores", "closure-cierre-de-verano-2026-07-01", "Cambiar").onclick?.();
      await hooks.excepcionPreview();
      await hooks.excepcionPublish();
      (nodes["excepcion-crear-nuevo"] as FakeElement).dispatchClick();
      // El campo trae el NOMBRE, sin el sufijo de fecha.
      expect((nodes["dia-especial-nombre"] as FakeElement).value).toBe("cierre-de-verano");
      // Y al mover la fecha, el alta nueva reclama un identificador nuevo, no
      // el del registro que se acaba de retirar.
      (nodes["dia-especial-desde"] as FakeElement).value = "2027-07-01";
      (nodes["dia-especial-hasta"] as FakeElement).value = "2027-07-15";
      await hooks.diaEspecialGoToImpact();
      const alta = f.peticiones.find((p) => p.url === "/api/calendar/preview")!;
      expect((alta.body as { id?: unknown }).id).toBe("cierre-de-verano-2027-07-01");
    } finally {
      f.restaurar();
    }
  });

  it("V1-9 — la retirada lleva su propia nota operativa, y viaja al servidor", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Retirar").onclick?.();
      await hooks.excepcionPreview();
      (nodes["excepcion-nota"] as FakeElement).value = "  se anuló la reforma  ";
      await hooks.excepcionPublish();
      expect(f.peticiones[1]!.url).toBe("/api/calendar/withdrawal/publish");
      expect(f.peticiones[1]!.body).toEqual({
        target: { targetKind: "venue_closure", id: "cierre-reforma" },
        resolutions: {},
        note: "se anuló la reforma",
      });
    } finally {
      f.restaurar();
    }
  });

  it("V1-9 — sin nota, la clave `note` NO viaja: el esquema del servidor es estricto y una cadena vacía es ruido", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Retirar").onclick?.();
      await hooks.excepcionPreview();
      (nodes["excepcion-nota"] as FakeElement).value = "   ";
      await hooks.excepcionPublish();
      expect(Object.keys(f.peticiones[1]!.body).sort()).toEqual(["resolutions", "target"]);
    } finally {
      f.restaurar();
    }
  });

  it("V3-12 — el contador cuenta PUNTOS DE CÓDIGO, como el servidor, y recorta diciéndolo", async () => {
    // El servidor mide `[...s].length` tras recortar. `maxlength` medía
    // unidades UTF-16: con emoji (dos unidades por punto de código) las dos
    // cuentas discrepan, y además el navegador cortaba un pegado en silencio.
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Retirar").onclick?.();
      await hooks.excepcionPreview();
      const campo = nodes["excepcion-nota"] as FakeElement;
      const contador = nodes["excepcion-nota-contador"] as FakeElement;
      expect(contador.textContent).toBe("0 de 280");

      // 100 emoji = 200 unidades UTF-16 pero 100 PUNTOS DE CÓDIGO.
      const emoji = "🙂".repeat(100);
      expect(emoji.length).toBe(200);
      campo.value = emoji;
      campo.oninput?.();
      expect(contador.textContent, "el contador cuenta unidades UTF-16, no puntos de código").toBe("100 de 280");
      expect(campo.value).toBe(emoji); // no se ha recortado nada: caben

      // Un pegado largo SÍ se recorta, y se dice.
      campo.value = "a".repeat(400);
      campo.oninput?.();
      expect(Array.from(String(campo.value)).length).toBe(280);
      expect(contador.textContent).toBe("280 de 280");
      expect((nodes["excepcion-error"] as FakeElement).textContent).toBe("La nota se ha cortado a 280 caracteres.");

      // Y el recorte no parte ningún carácter por la mitad.
      campo.value = "🙂".repeat(400);
      campo.oninput?.();
      expect(Array.from(String(campo.value)).length).toBe(280);
      expect(String(campo.value)).toBe("🙂".repeat(280));
    } finally {
      f.restaurar();
    }
  });

  it("V3-1 — la resolución que no apunta nada NO promete una marca que no existe", async () => {
    // `keep_and_flag` deja la reserva EXACTAMENTE como está
    // (`impact.ts:257-266`): no escribe nada, no encola nada, no deja rastro.
    // El rótulo decía «Mantener la cita y marcarla para revisar»: una marca
    // inventada. La otra opción sí deja rastro, y por eso son dos.
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: IMPACTO_UNA_CITA },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-excepciones-mes", "closure-cierre-reforma", "Retirar").onclick?.();
      await hooks.excepcionPreview();
      const impacto = textoPlano(nodes["excepcion-impacto"] as FakeElement);
      expect(impacto).toContain("Dejarla como está. No se apunta nada.");
      expect(impacto).toContain("Avisar: que alguien llame al cliente");
      expect(impacto).not.toContain("marcarla para revisar");
      // Y el rótulo mentiroso no queda en ninguna parte del cliente servido.
      expect(renderConsoleAppJs()).not.toContain("marcarla para revisar");
    } finally {
      f.restaurar();
    }
  });

  it("una AUSENCIA también se retira desde su fila, con su propio tipo de destino", async () => {
    const { nodes, hooks, f } = montar({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL_CON_TODO });
      botonDeFila(nodes, "horarios-ausencias", "absence-aus-parcial", "Retirar").onclick?.();
      await hooks.excepcionPreview();
      expect(f.peticiones[0]!.body).toEqual({ targetKind: "employee_absence", id: "aus-parcial" });
    } finally {
      f.restaurar();
    }
  });
});

// =====================================================================
// R15 — foco, Escape y teclado en los diálogos nuevos y ampliados.
// =====================================================================

describe("step 26 REAPERTURA · R15 — foco y teclado de los tres diálogos", () => {
  function montar() {
    const { document, nodes } = createFakeDocumentWithIds([
      ...HORARIOS_IDS_R7,
      ...IDS_DIALOGO_DIA_ESPECIAL,
      ...IDS_DIALOGO_AUSENCIA,
      ...IDS_DIALOGO_EXCEPCION,
      ...IDS_FOCO,
      { id: "btn-abrir-dia-especial", tag: "button" },
      { id: "btn-abrir-ausencia", tag: "button" },
    ]);
    const hooks = loadUiClientHooks("", document);
    hooks.wireDiaEspecialDialog();
    hooks.wireAusenciaDialog();
    hooks.wireExcepcionDialog();
    return { document, nodes, hooks };
  }

  it("al abrir, el foco va al título del diálogo; al cerrar (botón o Escape), vuelve a quien lo abrió", () => {
    const { document, nodes, hooks } = montar();
    const disparador = nodes["btn-abrir-dia-especial"] as FakeElement;
    hooks.openDiaEspecialDialog(disparador);
    expect(document.activeElement).toBe(nodes["dialogo-dia-especial-titulo"]);
    // `close()` es lo que dispara el <dialog> nativo TAMBIÉN con Escape.
    (nodes["dialogo-dia-especial"] as FakeElement).close();
    expect(document.activeElement).toBe(disparador);
  });

  it("el diálogo de ausencia hace lo mismo, y el de la excepción también", () => {
    const { document, nodes, hooks } = montar();
    const dispAusencia = nodes["btn-abrir-ausencia"] as FakeElement;
    hooks.openAusenciaDialog(dispAusencia, null, { engineToday: "2026-08-05", calendar: CAL });
    expect(document.activeElement).toBe(nodes["dialogo-ausencia-titulo"]);
    (nodes["dialogo-ausencia"] as FakeElement).close();
    expect(document.activeElement).toBe(dispAusencia);
  });

  it("tras retirar, el foco vuelve al encabezado del bloque: la fila que lo disparó ya no está", async () => {
    const { document, nodes, hooks } = montar();
    const f = conFetchFalso({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
      "/api/calendar/withdrawal/publish": { ok: true, status: 200, json: { applied: true, unresolved: [], flaggedForHumanContact: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
      const lista = nodes["horarios-ausencias"] as FakeElement;
      const botones: FakeElement[] = [];
      const recorrer = (n: FakeElement) => { if (n.tagName === "BUTTON" && n.textContent === "Retirar") botones.push(n); for (const h of n.children) recorrer(h); };
      recorrer(lista);
      const claveRetirada = botones[0]!.getAttribute("aria-label") ?? "";
      expect(claveRetirada).toMatch(/^Retirar: /);
      botones[0]!.onclick?.();
      await hooks.excepcionPreview();
      await hooks.excepcionPublish();
      (nodes["excepcion-cerrar-3"] as FakeElement).dispatchClick();
      expect(document.activeElement).toBe(nodes["tit-ausencias-equipo"]);
      // V3-14 — el motivo por el que el foco NO puede volver al disparador se
      // demuestra, en vez de darse por supuesto: repintado con lo que el
      // servidor deja (la fila marcada `rejected`), esa fila ya no está.
      const trasRetirar = {
        ...CAL,
        absences: CAL.absences.map((a, i) => (i === 0 ? { ...a, approval: "rejected" } : a)),
      };
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: trasRetirar });
      const quedan: string[] = [];
      const recorrer2 = (n: FakeElement) => { if (n.tagName === "BUTTON") quedan.push(n.getAttribute("aria-label") ?? ""); for (const h of n.children) recorrer2(h); };
      recorrer2(nodes["horarios-ausencias"] as FakeElement);
      expect(quedan, "la fila que disparó la retirada sigue en la lista").not.toContain(claveRetirada);
    } finally {
      f.restaurar();
    }
  });

  it("los tres diálogos declaran su título como nombre accesible y lo hacen enfocable", () => {
    const html = renderConsoleHtml();
    for (const [dialogo, titulo] of [
      ["dialogo-dia-especial", "dialogo-dia-especial-titulo"],
      ["dialogo-ausencia", "dialogo-ausencia-titulo"],
      ["dialogo-excepcion", "dialogo-excepcion-titulo"],
    ]) {
      expect(html).toContain(`id="${dialogo}" aria-labelledby="${titulo}"`);
      expect(html).toMatch(new RegExp(`id="${titulo}" tabindex="-1"`));
    }
    // Los encabezados de bloque son enfocables por programa: ahí vuelve el
    // foco cuando la fila que disparó la retirada deja de existir.
    for (const id of ["tit-dias-especiales", "tit-ausencias-equipo"]) {
      expect(html).toMatch(new RegExp(`id="${id}" tabindex="-1"`));
    }
  });

  // ===================================================================
  // V2-2 / V3-9 — CAMBIAR DE PASO MUEVE EL FOCO, y el repaso se locuta.
  //
  // Lo que la revisión adversarial demostró contra `f6ab8e7`: los tres
  // diálogos nuevos cambiaban de paso sin tocar el foco. Con el teclado, el
  // foco se quedaba en un botón que acaba de ocultarse (`hidden`), y el paso
  // de repaso —el único sitio donde se dice a cuántas citas afecta el
  // cambio— no producía ni una locución. `dialogo-cita-manual` ya resolvía
  // esto con `irAPasoManual`; los tres diálogos de la reapertura no.
  // ===================================================================

  it("cada paso de los tres diálogos trae su encabezado con id y tabindex=-1 en el HTML servido", () => {
    const html = renderConsoleHtml();
    const esperados = [
      ["dia-especial", 4],
      ["ausencia", 4],
      ["excepcion", 3],
    ] as const;
    for (const [prefijo, pasos] of esperados) {
      for (let n = 1; n <= pasos; n += 1) {
        expect(html, `${prefijo}-paso-${String(n)}-titulo`).toMatch(
          new RegExp(`<p class="tx-dialog__step" id="${prefijo}-paso-${String(n)}-titulo" tabindex="-1">`),
        );
      }
    }
    // Y no queda ni un `tx-dialog__step` SIN id dentro de los tres diálogos:
    // si mañana se añade un paso, esta prueba lo pilla.
    for (const dialogo of ["dialogo-dia-especial", "dialogo-ausencia", "dialogo-excepcion"]) {
      const trozo = html.slice(html.indexOf(`id="${dialogo}"`), html.indexOf("</dialog>", html.indexOf(`id="${dialogo}"`)));
      expect(trozo, `${dialogo} tiene un paso sin encabezado enfocable`).not.toContain('<p class="tx-dialog__step">');
    }
  });

  it("día especial: adelante y atrás mueven el foco al encabezado del paso nuevo", () => {
    const { document, nodes, hooks } = montar();
    hooks.openDiaEspecialDialog(nodes["btn-abrir-dia-especial"] as FakeElement);
    // Abrir NO mueve el foco a un paso: lo pone en el título del diálogo.
    expect(document.activeElement).toBe(nodes["dialogo-dia-especial-titulo"]);
    (nodes["dia-especial-tipo-cierre"] as FakeElement).checked = true;
    (nodes["dia-especial-tipo-cierre"] as FakeElement).dispatchChange();
    (nodes["dia-especial-siguiente-1"] as FakeElement).dispatchClick();
    expect(document.activeElement).toBe(nodes["dia-especial-paso-2-titulo"]);
    (nodes["dia-especial-atras-1"] as FakeElement).dispatchClick();
    expect(document.activeElement).toBe(nodes["dia-especial-paso-1-titulo"]);
  });

  it("ausencia: pasar al paso 2 mueve el foco a su encabezado, y volver también", () => {
    const { document, nodes, hooks } = montar();
    hooks.openAusenciaDialog(nodes["btn-abrir-ausencia"] as FakeElement, null, { engineToday: "2026-08-05", calendar: CAL });
    (nodes["ausencia-motivo-vacation"] as FakeElement).checked = true;
    (nodes["ausencia-profesional"] as FakeElement).value = "6";
    (nodes["ausencia-desde"] as FakeElement).value = "2026-08-20";
    (nodes["ausencia-hasta"] as FakeElement).value = "2026-08-22";
    (nodes["ausencia-nombre"] as FakeElement).value = "vacaciones-alex";
    (nodes["ausencia-siguiente-1"] as FakeElement).dispatchClick();
    expect(document.activeElement).toBe(nodes["ausencia-paso-2-titulo"]);
    (nodes["ausencia-atras-1"] as FakeElement).dispatchClick();
    expect(document.activeElement).toBe(nodes["ausencia-paso-1-titulo"]);
  });

  it("excepción: el REPASO se locuta — el foco aterriza en su encabezado tras la previsualización", async () => {
    const { document, nodes, hooks } = montar();
    const f = conFetchFalso({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
      const lista = nodes["horarios-ausencias"] as FakeElement;
      const botones: FakeElement[] = [];
      const recorrer = (n: FakeElement) => { if (n.tagName === "BUTTON" && n.textContent === "Retirar") botones.push(n); for (const h of n.children) recorrer(h); };
      recorrer(lista);
      botones[0]!.onclick?.();
      await hooks.excepcionPreview();
      expect((nodes["excepcion-paso-2"] as FakeElement).hidden).toBe(false);
      expect(document.activeElement).toBe(nodes["excepcion-paso-2-titulo"]);
      // Y volver atrás devuelve el foco al encabezado del paso 1.
      (nodes["excepcion-atras"] as FakeElement).dispatchClick();
      expect(document.activeElement).toBe(nodes["excepcion-paso-1-titulo"]);
    } finally {
      f.restaurar();
    }
  });

  it("con impacto CERO la línea contadora DICE que se ha comprobado, y no se queda vacía y oculta", async () => {
    // V3-9: el botón primario declara esta línea como su `aria-describedby`.
    // Vaciarla la dejaba además `hidden` (contrato de `setEstadoLinea`), así
    // que la descripción del botón apuntaba a un elemento vacío: quien navega
    // a ciegas oía «Publicar» a secas, sin la única frase que dice que se ha
    // mirado y que no se lleva por delante a nadie.
    const { nodes, hooks } = montar();
    const f = conFetchFalso({
      "/api/calendar/withdrawal/preview": { ok: true, status: 200, json: { impacted: [] } },
    });
    try {
      hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
      const lista = nodes["horarios-ausencias"] as FakeElement;
      const botones: FakeElement[] = [];
      const recorrer = (n: FakeElement) => { if (n.tagName === "BUTTON" && n.textContent === "Retirar") botones.push(n); for (const h of n.children) recorrer(h); };
      recorrer(lista);
      botones[0]!.onclick?.();
      await hooks.excepcionPreview();
      const contador = nodes["excepcion-contador"] as FakeElement;
      expect(contador.textContent).toBe("Comprobado: ninguna cita se queda fuera.");
      expect(contador.hidden).toBe(false);
      expect((nodes["excepcion-confirmar"] as FakeElement).disabled).toBe(false);
    } finally {
      f.restaurar();
    }
  });

  it("la misma frase vale para los cuatro flujos: es `updateImpactCounter` quien la dice", () => {
    const { nodes, hooks } = montar();
    for (const [linea, boton] of [
      ["dia-especial-contador", "dia-especial-guardar"],
      ["ausencia-contador", "ausencia-guardar"],
      ["excepcion-contador", "excepcion-confirmar"],
    ]) {
      const contador = nodes[linea] as FakeElement;
      hooks.updateImpactCounter(contador, nodes[boton] as unknown as FakeElement, [], {});
      expect(contador.textContent, linea).toBe("Comprobado: ninguna cita se queda fuera.");
      expect(contador.hidden, linea).toBe(false);
    }
    // Y con citas afectadas sigue diciendo lo que decía: la frase de cero no
    // sustituye al recuento, lo completa.
    const contador = nodes["excepcion-contador"] as FakeElement;
    hooks.updateImpactCounter(contador, nodes["excepcion-confirmar"] as unknown as FakeElement, IMPACTO_UNA_CITA.impacted, {});
    expect(contador.textContent).toBe("Falta decidir 1 cita.");
  });

  it("un sondeo con un diálogo abierto no cierra el diálogo ni le roba el foco al formulario", () => {
    const { document, nodes, hooks } = montar();
    hooks.openAusenciaDialog(nodes["btn-abrir-ausencia"] as FakeElement, null, { engineToday: "2026-08-05", calendar: CAL });
    (nodes["ausencia-nombre"] as FakeElement).focus();
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    hooks.renderHorariosYAusencias({ engineToday: "2026-08-05", calendar: CAL });
    expect((nodes["dialogo-ausencia"] as FakeElement).open).toBe(true);
    expect(document.activeElement).toBe(nodes["ausencia-nombre"]);
  });
});
