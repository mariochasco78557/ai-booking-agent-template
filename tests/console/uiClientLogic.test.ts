import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadUiClientHooks } from "./uiClientExtract.js";
import { createEquipoFakeDocument, createFakeDocumentWithIds } from "./fakeDom.js";
import { INTERNAL_REASON_CODES } from "../../src/callEngine/outcomeDimension.js";
import { demoSalonVenue } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { buildCalendarSnapshot } from "../../src/console/snapshot.js";

/**
 * step 14 · T1 — huecos de cobertura cerrados con la técnica de extracción
 * de `tests/console/uiClientExtract.ts` (ver su docblock: NO se usa ningún
 * navegador ni jsdom/happy-dom; se ejecuta el JavaScript real de /app.js con
 * un `window`/`document` mínimos, y sólo para funciones que no tocan el DOM
 * salvo `window.location.hash`).
 *
 * Lo que YA estaba cubierto (tests/console/console.test.ts) y que aquí NO se
 * repite: cabeceras de seguridad, whitelist del snapshot, privacidad,
 * ausencia de innerHTML, reset, invariantes de calendario (preview puro /
 * publish exige resolución / no cancela nada solo), ejecución de escenarios
 * reales, desenlace BOOKING_NOT_CONFIRMED, servido del logotipo/favicon,
 * vinculación a loopback, ausencia de tema oscuro, ausencia de latencia/€,
 * "precio" traduciendo literalmente ASK_PRICE, y la presencia de las seis
 * secciones + tres diálogos en el HTML servido.
 */

describe("consola · enrutado por hash (§10) — parseHash() es la función real de /app.js", () => {
  // (step 26 §9/C7) parseHash() gana `params` — el array COMPLETO tras la
  // sección, que la Agenda necesita para sus tres segmentos — de forma
  // RETROCOMPATIBLE: `param` (parts[1]) sigue siendo EXACTAMENTE lo que
  // era, y lo siguen leyendo Llamadas y Calendario sin cambiar una línea.
  it("una ruta vacía cae en Inicio", () => {
    expect(loadUiClientHooks("").parseHash()).toEqual({ section: "inicio", param: undefined, params: [] });
  });

  it("'#/agenda' resuelve a la sección agenda, sin parámetro", () => {
    expect(loadUiClientHooks("#/agenda").parseHash()).toEqual({ section: "agenda", param: undefined, params: [] });
  });

  it("'#/llamadas/<hash>' lleva el hash de la llamada como parámetro de ruta", () => {
    expect(loadUiClientHooks("#/llamadas/abc123hash").parseHash()).toEqual({
      section: "llamadas",
      param: "abc123hash",
      params: ["abc123hash"],
    });
  });

  it("'#/horarios-y-ausencias/2026-08' lleva el mes como parámetro de ruta", () => {
    expect(loadUiClientHooks("#/horarios-y-ausencias/2026-08").parseHash()).toEqual({
      section: "horarios-y-ausencias",
      param: "2026-08",
      params: ["2026-08"],
    });
  });

  it("'#/agenda/semana/2026-08-05/p3' lleva los tres segmentos de la Agenda en 'params'", () => {
    expect(loadUiClientHooks("#/agenda/semana/2026-08-05/p3").parseHash()).toEqual({
      section: "agenda",
      param: "semana",
      params: ["semana", "2026-08-05", "p3"],
    });
  });

  it("una sección que no existe cae en Inicio marcada como 'unknown' (el aviso 'Esa página no existe')", () => {
    expect(loadUiClientHooks("#/esta-seccion-no-existe").parseHash()).toEqual({
      section: "inicio",
      param: undefined,
      params: [],
      unknown: true,
    });
  });

  it("un intento de inyección en el hash (script/comillas/plantilla) nunca resuelve a una sección válida — cae en Inicio, marcado como desconocido, como cualquier otra ruta inventada", () => {
    const hostileHashes = [
      "#/<script>alert(1)</script>",
      "#/inicio\"; alert(1); \"",
      "#/${7*7}",
      "#/`backtick`",
      "#/../../etc/passwd",
    ];
    for (const hash of hostileHashes) {
      const route = loadUiClientHooks(hash).parseHash();
      expect(["inicio", "agenda", "llamadas", "horarios-y-ausencias", "equipo", "laboratorio"]).toContain(route.section);
      expect(route.unknown).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------
// step 26 REAPERTURA §R2 / P15 — la ruta retirada `#/calendario`.
//
// `#/calendario` deja de existir como sección: se REESCRIBE UNA SOLA VEZ
// hacia `#/horarios-y-ausencias`, con `location.replace` (SUSTITUYE la
// entrada del historial, para que «Atrás» no vuelva a la ruta muerta) y con
// guarda de reentrada. Las cinco pruebas de este bloque son DISCRIMINANTES
// contra `7ad0c6d`, donde `calendario` sigue siendo una sección viva.
// ---------------------------------------------------------------------

describe("consola · R2 — la ruta retirada '#/calendario' se reescribe una sola vez", () => {
  /**
   * Un `window` que distingue las DOS formas de cambiar el hash, que es
   * justo lo que R2 decide: `location.replace(...)` SUSTITUYE la entrada del
   * historial; asignar `location.hash` APILA una. Aquí se cuentan por
   * separado para poder afirmar cuál se ha usado.
   */
  function ventana(hashInicial: string) {
    const reemplazos: string[] = [];
    const apilados: string[] = [];
    let hash = hashInicial;
    const location = {
      pathname: "/",
      search: "",
      get hash() {
        return hash;
      },
      set hash(v: string) {
        apilados.push(v);
        hash = v;
      },
      replace(url: string) {
        reemplazos.push(url);
        const i = url.indexOf("#");
        hash = i === -1 ? "" : url.slice(i);
      },
    };
    return { location, scrollTo: () => undefined, reemplazos, apilados };
  }

  function montar(hashInicial: string) {
    const { document, nodes } = createFakeDocumentWithIds([
      "tx-view-title",
      "inicio-ruta-desconocida",
      "estado-global",
      "horarios-aviso-ruta",
      "vista-inicio",
      "vista-agenda",
      "vista-lista-espera",
      "vista-llamadas",
      "vista-horarios-y-ausencias",
      "vista-equipo",
      "vista-laboratorio",
    ]);
    const win = ventana(hashInicial);
    const hooks = loadUiClientHooks(hashInicial, document, win as unknown as { location: { hash: string } });
    return { document, nodes, win, hooks };
  }

  /** Un `hashchange` de verdad: el navegador vuelve a entrar en `applyRoute()`. */
  function navegar(m: ReturnType<typeof montar>, veces = 2) {
    for (let i = 0; i < veces; i += 1) m.hooks.applyRoute();
  }

  it("'#/calendario' a secas aterriza en '#/horarios-y-ausencias', con UNA sola reescritura", () => {
    const m = montar("#/calendario");
    navegar(m);
    expect(m.win.reemplazos.length).toBe(1);
    expect(m.win.reemplazos[0]).toBe("/#/horarios-y-ausencias");
    expect(m.win.location.hash).toBe("#/horarios-y-ausencias");
    // Historial: se SUSTITUYE la entrada, nunca se apila una nueva. Por eso
    // «Atrás» devuelve a la página anterior a la redirección y no a la ruta
    // muerta, que redirigiría otra vez.
    expect(m.win.apilados).toEqual([]);
    expect(m.nodes["tx-view-title"]!.textContent).toBe("Horarios y ausencias");
    expect(m.document.title).toBe("Horarios y ausencias · Demo Salon");
    expect(m.nodes["vista-horarios-y-ausencias"]!.hidden).toBe(false);
    // Sin aviso: la intención se ha entendido entera.
    expect(m.nodes["horarios-aviso-ruta"]!.hidden).toBe(true);
  });

  it("'#/calendario/2026-09' conserva el mes al reescribirse", () => {
    const m = montar("#/calendario/2026-09");
    navegar(m);
    expect(m.win.reemplazos).toEqual(["/#/horarios-y-ausencias/2026-09"]);
    expect(m.win.location.hash).toBe("#/horarios-y-ausencias/2026-09");
    expect(m.hooks.parseHash()).toEqual({
      section: "horarios-y-ausencias",
      param: "2026-09",
      params: ["2026-09"],
    });
    expect(m.nodes["horarios-aviso-ruta"]!.hidden).toBe(true);
  });

  it("un sufijo que no se entiende manda al mes de hoy, y lo dice: nada en silencio", () => {
    for (const malo of ["#/calendario/loquesea", "#/calendario/2026-08/loquesea", "#/calendario/2026"]) {
      const m = montar(malo);
      navegar(m);
      expect(m.win.reemplazos, malo).toEqual(["/#/horarios-y-ausencias"]);
      expect(m.win.location.hash, malo).toBe("#/horarios-y-ausencias");
      expect(m.nodes["horarios-aviso-ruta"]!.hidden, malo).toBe(false);
    }
  });

  /**
   * (Corregido tras la verificación de la reapertura) Esta prueba fijaba lo
   * contrario: que un mes fuera de rango con la forma correcta se conservara,
   * «igual que antes de la reapertura». Y conservarlo no era conservar nada:
   * `#/calendario/2026-99` aterrizaba en `#/horarios-y-ausencias/2026-99` sin
   * un solo aviso, con el título «undefined de 2026», las celdas fechadas
   * `2026-99-01` y un «mes siguiente» que apuntaba a `2026-100`. La FORMA no
   * es el RANGO. Un mes que no existe se trata como cualquier otro sufijo que
   * no se entiende: mes de hoy y aviso visible.
   */
  it("un mes con la FORMA correcta pero fuera de rango va al mes de hoy, y se dice", () => {
    for (const malo of ["#/calendario/2026-13", "#/calendario/2026-00", "#/calendario/2026-99"]) {
      const m = montar(malo);
      navegar(m);
      expect(m.win.reemplazos, malo).toEqual(["/#/horarios-y-ausencias"]);
      expect(m.win.location.hash, malo).toBe("#/horarios-y-ausencias");
      expect(m.nodes["horarios-aviso-ruta"]!.hidden, malo).toBe(false);
    }
  });

  it("y por la ruta VIVA tampoco cuela: se normaliza AL PINTAR, sin reescribir la dirección", () => {
    for (const malo of ["#/horarios-y-ausencias/2026-13", "#/horarios-y-ausencias/2026-00", "#/horarios-y-ausencias/2026-99"]) {
      const m = montar(malo);
      navegar(m, 1);
      expect(m.win.reemplazos, malo).toEqual([]);
      expect(m.win.location.hash, malo).toBe(malo);
      expect(m.nodes["horarios-aviso-ruta"]!.hidden, malo).toBe(false);
    }
  });

  it("no hay bucle: reentrar en la ruta retirada desde la nueva reescribe una vez y para", () => {
    const m = montar("#/horarios-y-ausencias/2026-09");
    navegar(m, 1);
    expect(m.win.reemplazos).toEqual([]);
    // El operador escribe a mano la ruta vieja estando ya en la nueva.
    m.win.location.hash = "#/calendario";
    m.win.apilados.length = 0;
    for (let i = 0; i < 6; i += 1) m.hooks.applyRoute();
    expect(m.win.reemplazos).toEqual(["/#/horarios-y-ausencias"]);
    expect(m.win.location.hash).toBe("#/horarios-y-ausencias");
    expect(m.nodes["tx-view-title"]!.textContent).toBe("Horarios y ausencias");
  });

  it("'#/horarios-y-ausencias/<basura>' NO se reescribe: es una ruta viva y se normaliza AL PINTAR", () => {
    const m = montar("#/horarios-y-ausencias/loquesea");
    navegar(m, 1);
    expect(m.win.reemplazos).toEqual([]);
    expect(m.win.location.hash).toBe("#/horarios-y-ausencias/loquesea");
    expect(m.nodes["horarios-aviso-ruta"]!.hidden).toBe(false);
    // Y el aviso se apaga en cuanto se navega a una dirección bien formada.
    m.win.location.hash = "#/horarios-y-ausencias/2026-09";
    m.hooks.applyRoute();
    expect(m.nodes["horarios-aviso-ruta"]!.hidden).toBe(true);
  });

  it("ninguna otra ruta del sistema cambia de comportamiento: sólo 'calendario' se reescribe", () => {
    for (const ruta of ["#/inicio", "#/agenda", "#/lista-espera", "#/llamadas", "#/equipo", "#/laboratorio", "#/loquesea"]) {
      const m = montar(ruta);
      navegar(m, 1);
      expect(m.win.reemplazos, ruta).toEqual([]);
      expect(m.win.location.hash, ruta).toBe(ruta);
    }
  });
});

describe("consola · vocabulario de estado (§7.2) — STATUS_VOCAB coincide EXACTAMENTE con la tabla del diseño", () => {
  // Tabla transcrita literalmente de DESIGN_SPEC.md §7.2. Si alguien cambia
  // una etiqueta, un glifo o un modificador en ui.js.ts sin actualizar el
  // diseño (o al revés), esta prueba lo detecta.
  const EXPECTED_TABLE: Record<string, { label: string; modifier: string; glyph: string }> = {
    BOOKING_CONFIRMED: { label: "Reserva confirmada", modifier: "ok", glyph: "✓" },
    AVAILABILITY_PROVIDED: { label: "Sin incidencias", modifier: "none", glyph: "—" },
    TECHNICAL_FAILURE: { label: "Error técnico", modifier: "error", glyph: "✕" },
    SECURITY_OR_PRIVACY_BOUNDARY: { label: "Necesita revisión", modifier: "attention", glyph: "!" },
    BOOKING_NOT_CONFIRMED: { label: "No completada", modifier: "incomplete", glyph: "○" },
    CUSTOMER_REQUESTS_HUMAN: { label: "Derivada a una persona", modifier: "derived", glyph: "→" },
    CANCEL_OR_CHANGE_NOT_ENABLED: { label: "Derivada a una persona", modifier: "derived", glyph: "→" },
    BUSINESS_DATA_NOT_APPROVED: { label: "Derivada a una persona", modifier: "derived", glyph: "→" },
    SLOT_OUTSIDE_SYNTHETIC_SCHEDULE: { label: "Derivada a una persona", modifier: "derived", glyph: "→" },
    SERVICE_NOT_CONFIRMED: { label: "Derivada a una persona", modifier: "derived", glyph: "→" },
    INTENT_NOT_UNDERSTOOD: { label: "Derivada a una persona", modifier: "derived", glyph: "→" },
  };

  it("todo internalReasonCode que el motor puede emitir (outcomeDimension.ts) tiene una entrada en STATUS_VOCAB, sin más y sin menos", () => {
    const { STATUS_VOCAB } = loadUiClientHooks();
    // Exhaustividad en las dos direcciones: si el motor añade un código nuevo
    // sin tocar ui.js.ts, statusFor() caería a un valor de repuesto sin que
    // ninguna prueba existente lo notase — esto sí lo nota.
    expect(Object.keys(STATUS_VOCAB).sort()).toEqual([...INTERNAL_REASON_CODES].sort());
    for (const code of INTERNAL_REASON_CODES) {
      expect(STATUS_VOCAB[code], `falta ${code} en STATUS_VOCAB`).toEqual(EXPECTED_TABLE[code]);
    }
  });

  it("statusFor() lee internalReasonCode ANTES que outcome/countsAsBookingConversion (§7.1, regla de derivación)", () => {
    const { statusFor } = loadUiClientHooks();
    // Un outcome RESUELVE con countsAsBookingConversion=true normalmente
    // sería "Reserva confirmada", pero un internalReasonCode explícito manda.
    const call = { outcome: "RESUELVE", countsAsBookingConversion: true, internalReasonCode: "AVAILABILITY_PROVIDED" };
    expect(statusFor(call)).toEqual({ label: "Sin incidencias", modifier: "none", glyph: "—" });
  });

  it("statusFor() nunca inventa un estado bonito por defecto: sin outcome ni internalReasonCode, devuelve null", () => {
    const { statusFor } = loadUiClientHooks();
    expect(statusFor({})).toBeNull();
  });
});

describe("consola · horario del local (§5.2/§5.4) — resolveVenueDay() con datos reales del calendario de Demo Salon", () => {
  const snap = buildCalendarSnapshot(demoSalonVenue(), []);

  it("el martes 2026-08-04 (dentro de la temporada de agosto) usa el horario de temporada, no el habitual", () => {
    const { resolveVenueDay } = loadUiClientHooks();
    const day = resolveVenueDay("2026-08-04", snap);
    expect(day).toEqual({ open: true, start: "09:00", end: "17:30", isSeasonal: true });
  });

  it("el lunes 2026-08-03 (dentro de la temporada de agosto) sigue cerrado: la temporada no reabre el lunes", () => {
    const { resolveVenueDay } = loadUiClientHooks();
    const day = resolveVenueDay("2026-08-03", snap);
    expect(day).toEqual({ open: false, reasonLabel: "Día de descanso" });
  });

  it("fuera de agosto (1 de septiembre de 2026, martes) se usa el horario semanal habitual del local, no el de temporada", () => {
    const { resolveVenueDay } = loadUiClientHooks();
    const day = resolveVenueDay("2026-09-01", snap);
    expect(day).toEqual({ open: true, start: "09:30", end: "19:30" });
  });

  it("un cierre de local aprobado gana a cualquier horario declarado", () => {
    const { resolveVenueDay } = loadUiClientHooks();
    const calWithClosure = {
      ...snap,
      closures: [{ id: "cierre-x", approval: "approved", startDate: "2026-08-04", endDate: "2026-08-04" }],
    };
    expect(resolveVenueDay("2026-08-04", calWithClosure)).toEqual({ open: false, reasonLabel: "Cierre del local" });
  });

  it("un festivo aprobado (regla cerrada) se distingue de un cierre ordinario: isHoliday true", () => {
    const { resolveVenueDay } = loadUiClientHooks();
    const calWithHoliday = { ...snap, venueRules: [{ id: "festivo-x", approval: "approved", date: "2026-08-04", closed: true }] };
    expect(resolveVenueDay("2026-08-04", calWithHoliday)).toEqual({ open: false, reasonLabel: "Festivo aprobado", isHoliday: true });
  });

  it("una apertura especial aprobada abre el local con SUS propias horas, marcada isSpecial", () => {
    const { resolveVenueDay } = loadUiClientHooks();
    const calWithSpecial = {
      ...snap,
      venueRules: [{ id: "especial-x", approval: "approved", date: "2026-08-04", closed: false, specialOpen: "11:00", specialClose: "13:00" }],
    };
    expect(resolveVenueDay("2026-08-04", calWithSpecial)).toEqual({ open: true, start: "11:00", end: "13:00", isSpecial: true });
  });

  it("una regla o cierre NO aprobado (pending_review) se ignora por completo — sólo lo aprobado cambia el horario mostrado", () => {
    const { resolveVenueDay } = loadUiClientHooks();
    const calPending = {
      ...snap,
      closures: [{ id: "cierre-pendiente", approval: "pending_review", startDate: "2026-08-04", endDate: "2026-08-04" }],
    };
    expect(resolveVenueDay("2026-08-04", calPending)).toEqual({ open: true, start: "09:00", end: "17:30", isSeasonal: true });
  });
});

describe("consola · Equipo (D4) — activeSeasonalOverride() detecta la temporada de agosto con datos reales, sin fechas ni 'agosto' escritos a mano", () => {
  const snap = buildCalendarSnapshot(demoSalonVenue(), []);

  it("el 4 de agosto de 2026 (dentro de la temporada) hay una temporada activa, con label y fechas leídas de los datos", () => {
    const { activeSeasonalOverride } = loadUiClientHooks();
    const season = activeSeasonalOverride(snap, "2026-08-04");
    expect(season).not.toBeNull();
    expect(typeof (season as Record<string, unknown>).label).toBe("string");
    expect((season as Record<string, unknown>).startDate).toBeDefined();
    expect((season as Record<string, unknown>).endDate).toBeDefined();
  });

  it("el 1 de septiembre de 2026 (fuera de la temporada) no hay ninguna temporada activa", () => {
    const { activeSeasonalOverride } = loadUiClientHooks();
    expect(activeSeasonalOverride(snap, "2026-09-01")).toBeNull();
  });

  it("una temporada NO aprobada (pending_review) se ignora por completo, igual que en Calendario", () => {
    const { activeSeasonalOverride } = loadUiClientHooks();
    const calPending = {
      ...snap,
      seasonalSchedules: (snap.seasonalSchedules as Array<Record<string, unknown>>).map((s) => ({ ...s, approval: "pending_review" })),
    };
    expect(activeSeasonalOverride(calPending, "2026-08-04")).toBeNull();
  });
});

// ---------------------------------------------------------------------
// step 16 (fase 3B) — el bloque "D4" (step 14) y el bloque "step 15" que
// vivían aquí probaban un `<h4>Horario habitual</h4>`, una
// `<ul class="tx-schedule-list">` y un `[data-role="season-notice"]` DENTRO
// de cada ficha de profesional: exactamente el bloque que esta fase ELIMINA
// de la ficha (criterio B2) porque se repetía tres veces (una por
// profesional) y el horario es del local, no de la persona. El mismo hecho
// se prueba ahora en el bloque de arriba de Equipo — ver el describe
// "step 16, O5/B1/B2" más abajo — y aquí se añade la aserción negativa: la
// ficha ya no lo trae.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// step 15 — la vista Calendario es una pantalla de operador: no puede
// enseñar lenguaje interno. Antes decía "No se repite solo
// (does_not_repeat)" y "Confirmado por fixture:synthetic-demo el
// 2026-01-01T00:00:00". Ese detalle no se pierde: se sigue sirviendo entero
// en Laboratorio › instantánea en crudo.
// ---------------------------------------------------------------------

describe("consola · Calendario (step 15) — el aviso de temporada no enseña vocabulario interno", () => {
  const CALENDARIO_IDS = [
    "calendario-mes-titulo",
    { id: "calendario-mes-anterior", tag: "a" },
    { id: "calendario-mes-siguiente", tag: "a" },
    "calendario-temporada",
    "calendario-temporada-titulo",
    "calendario-temporada-detalle",
    "calendario-temporada-aviso-fecha",
    { id: "calendario-grid-body", tag: "tbody" },
    "calendario-dias-distintos-vacio",
    { id: "calendario-dias-distintos", tag: "ul" },
    // (V3-2) El plegable de lo ya pasado, hermano del bloque 4: toda
    // excepción aprobada tiene que poder verse y retirarse desde algún sitio.
    { id: "calendario-excepciones-anteriores", tag: "ul" },
    "calendario-excepciones-anteriores-vacio",
    // (step 26 REAPERTURA §R7) Los cuatro bloques de «Horarios y ausencias»:
    // la misma función pinta ahora el horario habitual (bloque 1), la lista de
    // cierres del mes (bloque 2) y las ausencias del equipo (bloque 3).
    "horarios-regimen",
    { id: "horarios-semana", tag: "ul" },
    { id: "horarios-excepciones-mes", tag: "ul" },
    "horarios-excepciones-mes-vacio",
    { id: "horarios-filtro-profesional", tag: "select" },
    { id: "horarios-ausencias", tag: "ul" },
    "horarios-ausencias-vacio",
  ] as const;

  function pintarCalendario(): { texto: string; nodes: Record<string, { textContent: string; hidden: boolean }> } {
    const { document, nodes } = createFakeDocumentWithIds([...CALENDARIO_IDS]);
    const { renderHorariosYAusencias } = loadUiClientHooks("", document);
    renderHorariosYAusencias({
      engineToday: "2026-08-04",
      engineNowMinutes: 9 * 60,
      calendar: buildCalendarSnapshot(demoSalonVenue(), []),
    });
    const texto = Object.values(nodes)
      .map((n) => n.textContent)
      .join(" \n ");
    return { texto, nodes };
  }

  it("no aparece 'does_not_repeat', ni 'fixture:synthetic-demo', ni una fecha ISO en crudo", () => {
    const { texto } = pintarCalendario();
    expect(texto).not.toContain("does_not_repeat");
    expect(texto).not.toContain("fixture:synthetic-demo");
    expect(texto).not.toContain("synthetic_fixture");
    // Un timestamp ISO en crudo: "2026-01-01T00:00:00".
    expect(texto).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // Y tampoco una fecha "YYYY-MM-DD" suelta, que tampoco es castellano.
    expect(texto).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("lo que SÍ se dice es que este horario solo está confirmado para su año, en castellano llano", () => {
    const { texto, nodes } = pintarCalendario();
    expect(nodes["calendario-temporada-aviso-fecha"]?.textContent).toContain("solo está confirmado para 2026");
    expect(nodes["calendario-temporada-aviso-fecha"]?.textContent).toContain("habrá que revisarlo y confirmarlo");
    // (step 15, segunda revisión, punto 6) El nodo muerto
    // "#calendario-temporada-autoria" se ha borrado del HTML y del JS: nacía
    // `hidden`, el JS le escribía '' y lo volvía a ocultar en cada render —
    // ninguna rama lo mostraba jamás. Las dos aserciones que antes vivían
    // aquí ("su textContent es ''", "sigue hidden") sólo fijaban ese estado
    // muerto, no vigilaban lo que de verdad importaba. La garantía real — que
    // la autoría de auditoría (fixture:synthetic-demo / synthetic_fixture) y
    // cualquier marca de tiempo NUNCA se pintan en Calendario — ya la cubre,
    // más fuerte, la prueba de arriba ("no aparece 'does_not_repeat'..."):
    // barre el textContent de TODOS los nodos de esta vista, no sólo de uno
    // que ya no existe. No se repite aquí.
    // Y el aviso sigue diciendo de qué temporada habla y qué horas trae, con
    // las fechas dichas como se dicen en castellano ("del 1 ago al 31 ago" no
    // se dice).
    expect(texto).toContain("Horario de agosto de 2026");
    expect(texto).toContain("del 1 al 31 de agosto");
    expect(texto).toContain("09:00-17:30");
  });
});

// ---------------------------------------------------------------------
// step 15 — el foco. Dos garantías distintas: (1) al esconder el detalle
// de una llamada, el botón "Cerrar" desaparece con él y el foco no puede
// quedarse en el vacío; (2) el sondeo cada dos segundos no puede arrancar
// el foco de donde lo tenga quien está usando el teclado (decisión D7).
// ---------------------------------------------------------------------

describe("consola · foco (step 15) — cerrar el detalle de una llamada no deja el foco en el <body>", () => {
  it("con el foco dentro del panel, ocultarlo lo lleva al título de la vista", () => {
    const { document, nodes } = createFakeDocumentWithIds([
      { id: "llamada-detalle", tag: "article" },
      { id: "tx-view-title", tag: "h1" },
    ]);
    const { renderCallDetail } = loadUiClientHooks("", document);
    const botonCerrar = document.createElement("button");
    nodes["llamada-detalle"]?.appendChild(botonCerrar);
    document.activeElement = botonCerrar;

    // Sin ninguna llamada abierta en la ruta, renderCallDetail esconde el panel.
    renderCallDetail({ calls: [] });

    expect(nodes["llamada-detalle"]?.hidden).toBe(true);
    expect(document.activeElement).toBe(nodes["tx-view-title"]);
  });

  it("si el foco NO estaba dentro del panel, no se le toca: nadie se lo lleva de donde estaba", () => {
    const { document, nodes } = createFakeDocumentWithIds([
      { id: "llamada-detalle", tag: "article" },
      { id: "tx-view-title", tag: "h1" },
    ]);
    const { renderCallDetail } = loadUiClientHooks("", document);
    const otroControl = document.createElement("button");
    document.activeElement = otroControl;

    renderCallDetail({ calls: [] });

    expect(nodes["llamada-detalle"]?.hidden).toBe(true);
    expect(document.activeElement).toBe(otroControl);
  });
});

describe("consola · foco (D7) — un segundo sondeo no roba el foco de la tabla de Llamadas", () => {
  const snap = {
    calls: [
      {
        callIdHash: "hash-uno",
        scenarioId: "A01-demo",
        startedAtISO: "2026-08-04T09:10:00.000Z",
        outcome: "RESUELVE",
        internalReasonCode: "BOOKING_CONFIRMED",
        countsAsBookingConversion: true,
        lastIntent: "BOOK",
      },
      {
        callIdHash: "hash-dos",
        scenarioId: "A02-demo",
        startedAtISO: "2026-08-04T09:40:00.000Z",
        outcome: "DERIVA",
        internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
        lastIntent: "HUMAN_HELP",
      },
    ],
    humanQueue: { tasks: [] },
  };

  it("el enlace 'Ver' que tenía el foco sigue siendo el mismo nodo, sigue en la tabla y sigue enfocado", () => {
    const { document, nodes } = createFakeDocumentWithIds([
      "filtro-todas-n",
      "filtro-atencion-n",
      "filtro-reserva-n",
      "filtro-derivadas-n",
      "filtro-error-n",
      "llamadas-vacio",
      "llamadas-vacio-filtro",
      { id: "llamadas-tbody", tag: "tbody" },
      { id: "llamada-detalle", tag: "article" },
      { id: "tx-view-title", tag: "h1" },
    ]);
    const { renderLlamadas } = loadUiClientHooks("", document);

    renderLlamadas(snap);
    const tbody = nodes["llamadas-tbody"];
    expect(tbody?.children.length).toBe(2);
    const enlace = tbody?.children[0]?.querySelector("a");
    expect(enlace).not.toBeNull();
    document.activeElement = enlace ?? null;

    // Segundo sondeo con exactamente los mismos datos.
    renderLlamadas(snap);

    expect(tbody?.children.length).toBe(2);
    expect(tbody?.children[0]?.querySelector("a")).toBe(enlace);
    expect(document.activeElement).toBe(enlace);
    expect(tbody?.contains(document.activeElement)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// step 16, O3 — el DOM falso ahora emula la pérdida de foco al mover un
// nodo (§4.1(a) del plan), y reconcileList() deja de mover el nodo que
// contiene el foco (§4.3). Sin la primera pieza, la segunda no se podría
// poner en rojo: sería una aserción que nunca puede fallar.
// ---------------------------------------------------------------------

describe("consola · DOM falso (step 16, C1) — mover un nodo enfocado lo desconecta y pierde el foco, como en un navegador", () => {
  it("insertBefore de un nodo ya conectado (= moverlo) hace caer document.activeElement a null si el foco vivía dentro", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "contenedor", tag: "div" }]);
    const contenedor = nodes["contenedor"];
    const primero = document.createElement("button");
    const segundo = document.createElement("button");
    contenedor?.appendChild(primero);
    contenedor?.appendChild(segundo);
    document.activeElement = primero;

    // "Moverlo a otra posición" = exactamente lo que reconcileList hace con
    // insertBefore cuando reordena.
    contenedor?.insertBefore(primero, null);

    expect(document.activeElement).toBeNull();
  });

  it("mover un nodo SIN el foco dentro no toca document.activeElement, viva donde viva", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "contenedor", tag: "div" }]);
    const contenedor = nodes["contenedor"];
    const primero = document.createElement("button");
    const segundo = document.createElement("button");
    contenedor?.appendChild(primero);
    contenedor?.appendChild(segundo);
    const otroControlAjeno = document.createElement("button");
    document.activeElement = otroControlAjeno;

    contenedor?.insertBefore(primero, null);

    expect(document.activeElement).toBe(otroControlAjeno);
  });
});

describe("consola · foco (step 16, O3, C2/C3) — una llamada deja de estar entre las visibles y otra llega, sin robar el foco ni desordenar la tabla", () => {
  // NOTA para el informe: una simple llamada nueva PREPENDIDA sin ninguna
  // baja (p.ej. dos filas → tres, la nueva delante) NO llega a mover ningún
  // nodo existente con este algoritmo, arreglado o no — es una inserción
  // pura, y la reconciliación por clave ya la resolvía bien sin tocar a
  // nadie. El caso que de verdad ejercita el defecto O3 es el que aquí
  // abajo: una fila que estaba ENTRE otras dos deja de estar (cambia de
  // filtro, o la reemplaza otra) mientras llega una más reciente. Entonces
  // la fila que queda MÁS ABAJO tiene que "saltar" el hueco de la que se
  // va, y ese salto es un insertBefore real sobre un nodo YA en el árbol.
  const TRES_LLAMADAS = {
    calls: [
      {
        callIdHash: "hash-c",
        scenarioId: "A03-demo",
        startedAtISO: "2026-08-04T10:00:00.000Z",
        outcome: "RESUELVE",
        internalReasonCode: "BOOKING_CONFIRMED",
        countsAsBookingConversion: true,
        lastIntent: "BOOK",
      },
      {
        callIdHash: "hash-b",
        scenarioId: "A02-demo",
        startedAtISO: "2026-08-04T09:40:00.000Z",
        outcome: "DERIVA",
        internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
        lastIntent: "HUMAN_HELP",
      },
      {
        callIdHash: "hash-a",
        scenarioId: "A01-demo",
        startedAtISO: "2026-08-04T09:10:00.000Z",
        outcome: "RESUELVE",
        internalReasonCode: "BOOKING_CONFIRMED",
        countsAsBookingConversion: true,
        lastIntent: "BOOK",
      },
    ],
    humanQueue: { tasks: [] },
  };

  it("(C2) el foco en el 'Ver' de la última fila sobrevive cuando la fila de en medio desaparece y llega una más reciente Y (C3) el orden final queda correcto", () => {
    const { document, nodes } = createFakeDocumentWithIds([
      "filtro-todas-n",
      "filtro-atencion-n",
      "filtro-reserva-n",
      "filtro-derivadas-n",
      "filtro-error-n",
      "llamadas-vacio",
      "llamadas-vacio-filtro",
      { id: "llamadas-tbody", tag: "tbody" },
      { id: "llamada-detalle", tag: "article" },
      { id: "tx-view-title", tag: "h1" },
    ]);
    const { renderLlamadas } = loadUiClientHooks("", document);

    renderLlamadas(TRES_LLAMADAS);
    const tbody = nodes["llamadas-tbody"];
    expect(tbody?.children.length).toBe(3);
    expect(tbody?.children[2]?.querySelector("a")?.getAttribute("data-call-hash")).toBe("hash-a");
    const enlaceFocado = tbody?.children[2]?.querySelector("a") ?? null;
    document.activeElement = enlaceFocado;

    // hash-b deja de estar entre las visibles (p.ej. cambia de filtro) y
    // llega hash-x, más reciente que todas. hash-a, que tenía el foco,
    // queda inmediatamente detrás de hash-c: para llegar ahí, el algoritmo
    // SIN arreglar mueve la fila de hash-a con insertBefore.
    const conCambio = {
      ...TRES_LLAMADAS,
      calls: [
        {
          callIdHash: "hash-x",
          scenarioId: "A04-demo",
          startedAtISO: "2026-08-04T10:30:00.000Z",
          outcome: "RESUELVE",
          internalReasonCode: "BOOKING_CONFIRMED",
          countsAsBookingConversion: true,
          lastIntent: "BOOK",
        },
        TRES_LLAMADAS.calls[0],
        TRES_LLAMADAS.calls[2],
      ],
    };
    renderLlamadas(conCambio);

    expect(tbody?.children.length).toBe(3);
    // C3: el orden final es el correcto — hash-b ya no está, y las otras
    // tres quedan en el orden esperado.
    expect(tbody?.children[0]?.querySelector("a")?.getAttribute("data-call-hash")).toBe("hash-x");
    expect(tbody?.children[1]?.querySelector("a")?.getAttribute("data-call-hash")).toBe("hash-c");
    expect(tbody?.children[2]?.querySelector("a")?.getAttribute("data-call-hash")).toBe("hash-a");
    // C2: el foco no se ha caído — sigue siendo EXACTAMENTE el mismo nodo.
    expect(document.activeElement).toBe(enlaceFocado);
    expect(tbody?.contains(document.activeElement)).toBe(true);
  });
});

describe("consola · reconcileList() en aislamiento (step 16, O3, C4) — las cinco permutaciones documentadas en el plan", () => {
  /**
   * Construye un contenedor sintético con una fila por clave, cada una con
   * un `<a>` interior — `holdsFocus` exige que el foco esté DENTRO de la
   * fila, no en la fila misma (ver su docblock en ui.js.ts).
   */
  function montarFilas(keys: readonly string[]) {
    const { document } = createFakeDocumentWithIds([]);
    const contenedor = document.createElement("div");
    const filaPorClave: Record<string, ReturnType<typeof document.createElement>> = {};
    for (const key of keys) {
      const fila = document.createElement("div");
      fila.setAttribute("data-key", key);
      const enlace = document.createElement("a");
      fila.appendChild(enlace);
      contenedor.appendChild(fila);
      filaPorClave[key] = fila;
    }
    return { document, contenedor, filaPorClave };
  }

  const casos: Array<{ nombre: string; domAntes: readonly string[]; items: readonly string[]; foco: string; esperado: readonly string[] }> = [
    { nombre: "el caso de Llamadas: [A,B] + X nuevo delante, foco en A", domAntes: ["A", "B"], items: ["X", "A", "B"], foco: "A", esperado: ["X", "A", "B"] },
    { nombre: "[B,A,C] reordenado a [A,B,C], foco en A", domAntes: ["B", "A", "C"], items: ["A", "B", "C"], foco: "A", esperado: ["A", "B", "C"] },
    { nombre: "[A,B,C] reordenado a [B,C,A], foco en A", domAntes: ["A", "B", "C"], items: ["B", "C", "A"], foco: "A", esperado: ["B", "C", "A"] },
    { nombre: "[P,A,B,C] reordenado a [A,B,C,P], foco en P (el ancla va al final)", domAntes: ["P", "A", "B", "C"], items: ["A", "B", "C", "P"], foco: "P", esperado: ["A", "B", "C", "P"] },
    { nombre: "[A,B,C] reordenado a [A,C,B], foco en C", domAntes: ["A", "B", "C"], items: ["A", "C", "B"], foco: "C", esperado: ["A", "C", "B"] },
  ];

  it("en las cinco permutaciones de la tabla del plan, el orden final es el pedido y el nodo enfocado nunca cambia", () => {
    for (const caso of casos) {
      const { document, contenedor, filaPorClave } = montarFilas(caso.domAntes);
      const { reconcileList, holdsFocus } = loadUiClientHooks("", document);
      const enlaceFocado = filaPorClave[caso.foco]?.querySelector("a") ?? null;
      document.activeElement = enlaceFocado;
      expect(holdsFocus(filaPorClave[caso.foco]), `${caso.nombre}: holdsFocus debería ver el foco dentro de la fila ancla`).toBe(true);

      const buildRow = (_item: unknown, existing: unknown) => {
        if (existing) return existing;
        const fila = document.createElement("div");
        fila.appendChild(document.createElement("a"));
        return fila;
      };
      reconcileList(contenedor, caso.items, (k) => k as string, buildRow);

      const ordenFinal = contenedor.children.map((c) => c.getAttribute("data-key"));
      expect(ordenFinal, caso.nombre).toEqual(caso.esperado);
      expect(document.activeElement, `${caso.nombre}: el foco no debería haberse movido`).toBe(enlaceFocado);
    }
  });
});

// ---------------------------------------------------------------------
// step 16, O4 (C8) — comportamiento #10 del encargo: "Detalle técnico"
// sigue plegado por defecto y separado de la explicación para el operador.
// ---------------------------------------------------------------------

describe("consola · Llamadas (step 16, C8) — 'Detalle técnico' sigue plegado y separado de la explicación de operador", () => {
  const htmlCompleto = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
  // ui.html.ts tiene DOS `<details class="tx-details">` (Llamadas y
  // Laboratorio) — acotamos a la sección de Llamadas antes de buscar, igual
  // que hace extractSection() más abajo en este mismo fichero, para que un
  // `indexOf` sin acotar no caiga silenciosamente en la sección equivocada.
  const llamadasStart = htmlCompleto.indexOf('id="vista-llamadas"');
  const llamadasEnd = htmlCompleto.indexOf("</section>", llamadasStart);
  const html = htmlCompleto.slice(llamadasStart, llamadasEnd);
  const detailsIdx = html.indexOf("<details");
  const detailsTagEnd = html.indexOf(">", detailsIdx);
  const detailsTag = html.slice(detailsIdx, detailsTagEnd + 1);

  it("el <details> de Llamadas NO lleva el atributo 'open': plegado por defecto", () => {
    expect(detailsIdx, "no se ha encontrado <details dentro de la sección de Llamadas").toBeGreaterThan(-1);
    expect(detailsTag).not.toMatch(/\sopen(\s|>)/);
  });

  it("su <summary> dice literalmente 'Detalle técnico'", () => {
    const summaryIdx = html.indexOf("<summary>", detailsIdx);
    const summaryClose = html.indexOf("</summary>", summaryIdx);
    expect(html.slice(summaryIdx + "<summary>".length, summaryClose)).toBe("Detalle técnico");
  });

  it("los tres <h3> de operador ('Qué pasó', 'Lo que pidió el cliente', '¿Se dijo...?') están ANTES del <details>, no dentro", () => {
    for (const titulo of ["Qué pasó", "Lo que pidió el cliente", "¿Se dijo al cliente que estaba confirmada?"]) {
      const idx = html.indexOf(`<h3>${titulo}</h3>`);
      expect(idx, `no se ha encontrado <h3>${titulo}</h3>`).toBeGreaterThan(-1);
      expect(idx, `<h3>${titulo}</h3> debería ir antes del <details>`).toBeLessThan(detailsIdx);
    }
  });
});

describe("consola · 'días distintos' (festivos, cierres y ausencias) — collectDistinctDays()", () => {
  it("une cierres, festivos/horario especial y ausencias en una sola lista, ordenada por fecha de inicio", () => {
    const { collectDistinctDays } = loadUiClientHooks();
    const cal = {
      closures: [{ id: "c1", approval: "approved", startDate: "2026-08-20", endDate: "2026-08-21" }],
      venueRules: [{ id: "r1", approval: "approved", date: "2026-08-05", closed: true }],
      absences: [{ id: "a1", approval: "approved", employeeId: 3, kind: "vacation", startDate: "2026-08-10", endDate: "2026-08-12" }],
    };
    const items = collectDistinctDays(cal, "2026-08-01", null);
    expect(items.map((i) => i.key)).toEqual(["rule-r1", "absence-a1", "closure-c1"]);
    expect(items[0].title).toContain("Local cerrado");
    expect(items[1].detail).toBe("Vacaciones");
  });

  it("nunca deja pasar el motivo PRIVADO de una ausencia: sólo aparece 'Vacaciones'/'Ausencia'/'Formación', nunca un texto libre", () => {
    const { collectDistinctDays } = loadUiClientHooks();
    // Ni siquiera se le PASA `privateReason` — la extracción del snapshot ya
    // lo prohíbe (buildCalendarSnapshot), pero esta prueba comprueba además
    // que la función de la interfaz no lo leería aunque estuviera presente.
    const cal = {
      absences: [
        {
          id: "a2",
          approval: "approved",
          employeeId: 3,
          kind: "absence",
          startDate: "2026-08-10",
          endDate: "2026-08-10",
          privateReason: "SECRETO-MEDICO-QUE-NUNCA-DEBE-VERSE",
        },
      ],
    };
    const items = collectDistinctDays(cal, "2026-08-01", null);
    expect(items[0].detail).toBe("Ausencia");
    expect(JSON.stringify(items)).not.toContain("SECRETO-MEDICO");
  });

  it("un elemento NO aprobado (pending_review) nunca aparece en la lista", () => {
    const { collectDistinctDays } = loadUiClientHooks();
    const cal = { closures: [{ id: "c-pend", approval: "pending_review", startDate: "2026-08-05", endDate: "2026-08-05" }] };
    expect(collectDistinctDays(cal, "2026-08-01", null)).toEqual([]);
  });

  it("filtrado por mes visible: sólo entran los elementos que solapan ese mes concreto", () => {
    const { collectDistinctDays } = loadUiClientHooks();
    const cal = {
      closures: [
        { id: "en-agosto", approval: "approved", startDate: "2026-08-15", endDate: "2026-08-16" },
        { id: "en-septiembre", approval: "approved", startDate: "2026-09-02", endDate: "2026-09-03" },
      ],
    };
    const augustItems = collectDistinctDays(cal, "2026-08-01", { year: 2026, month: 8 });
    expect(augustItems.map((i) => i.key)).toEqual(["closure-en-agosto"]);
  });
});

describe("consola · rejilla del mes — monthMatrix()", () => {
  it("agosto de 2026 (empieza en sábado) tiene 6 semanas, con 5 huecos antes del día 1", () => {
    const { monthMatrix } = loadUiClientHooks();
    const weeks = monthMatrix(2026, 8);
    expect(weeks.length).toBe(6);
    expect(weeks[0]).toEqual([null, null, null, null, null, "2026-08-01", "2026-08-02"]);
    expect(weeks[weeks.length - 1]).toContain("2026-08-31");
  });

  it("cada semana tiene exactamente 7 columnas (lunes primero)", () => {
    const { monthMatrix } = loadUiClientHooks();
    const weeks = monthMatrix(2026, 8);
    for (const week of weeks) expect(week.length).toBe(7);
  });
});

// ---------------------------------------------------------------------
// D1 (step 14 repair) — el panel de resultado de Laboratorio NUNCA debe
// imprimir el valor de `reasonCode` bajo la etiqueta del código interno.
// ---------------------------------------------------------------------

describe("consola · Laboratorio (D1) — laboratorioSummaryLines() no confunde el código congelado con el interno", () => {
  it("una llamada BOOKING_NOT_CONFIRMED muestra su propio código interno, no el reasonCode congelado (INTENT_NOT_UNDERSTOOD)", () => {
    const { laboratorioSummaryLines } = loadUiClientHooks();
    const json = {
      outcome: "DERIVA",
      // El flujo congelado del piloto sigue viendo INTENT_NOT_UNDERSTOOD —
      // eso es correcto y no debe cambiar (ver outcomeDimension.ts).
      reasonCode: "INTENT_NOT_UNDERSTOOD",
      internalReasonCode: "BOOKING_NOT_CONFIRMED",
      announcesSuccess: false,
      finalState: "FIN",
    };
    const lines = laboratorioSummaryLines(json);
    const reasonCodeLine = lines.find((l) => l.includes("Código congelado (reasonCode)"));
    const internalLine = lines.find((l) => l.includes("Código interno (internalReasonCode)"));
    expect(reasonCodeLine).toContain("INTENT_NOT_UNDERSTOOD");
    // LA REGRESIÓN EXACTA QUE ESTA PRUEBA CIERRA: la etiqueta del código
    // interno mostraba el valor del reasonCode congelado por un
    // copia-y-pega, así que esta llamada (entendida, sólo sin confirmar)
    // aparecía en Laboratorio como si no se hubiese entendido nada.
    expect(internalLine).toContain("BOOKING_NOT_CONFIRMED");
    expect(internalLine).not.toContain("INTENT_NOT_UNDERSTOOD");
  });

  it("cuando internalReasonCode falta, la línea muestra un guion, nunca un reasonCode heredado por error", () => {
    const { laboratorioSummaryLines } = loadUiClientHooks();
    const lines = laboratorioSummaryLines({
      outcome: "RESUELVE",
      reasonCode: "BOOKING_CONFIRMED",
      announcesSuccess: true,
      finalState: "FIN",
    });
    const internalLine = lines.find((l) => l.includes("Código interno (internalReasonCode)"));
    expect(internalLine).toContain("—");
  });
});

// ---------------------------------------------------------------------
// Laboratorio isolation (P3/§8.9): technical vocabulary must stay inside
// the Laboratorio section and the "Detalle técnico" panels — never in the
// five operative sections' visible copy.
// ---------------------------------------------------------------------

describe("consola · Laboratorio guarda lo técnico en su cuarto (P3, §8.9)", () => {
  // §8.9 también veta la palabra "sistema" fuera de Laboratorio. Se deja
  // deliberadamente FUERA de esta lista automática: el texto actual la usa
  // dos veces (vista-inicio y el diálogo de reinicio) en el sentido de
  // "ningún sistema REAL de Demo Salon", que es una garantía de seguridad para
  // el operador, no jerga de implementación — y cambiar esa frase es una
  // decisión de redacción, no un defecto que esta misión deba corregir por
  // su cuenta. Ver el informe de esta misión para el detalle.
  const BANNED_WORDS = ["backend", "endpoint", "payload", " log ", "logs", "json", "/api/"];

  function extractSection(html: string, id: string): string {
    const startMarker = `id="${id}"`;
    const start = html.indexOf(startMarker);
    expect(start, `sección ${id} no encontrada`).toBeGreaterThan(-1);
    // Cada <section id="vista-..."> se cierra con el próximo comentario de
    // sección o el cierre de </main> — usamos el siguiente
    // "<!-- ====" como límite, que es el propio convenio de ui.html.ts.
    const sectionOpenIdx = html.lastIndexOf("<section", start);
    const nextCommentIdx = html.indexOf("<!-- =====", start);
    const mainCloseIdx = html.indexOf("</main>", start);
    const end = nextCommentIdx === -1 ? mainCloseIdx : Math.min(nextCommentIdx, mainCloseIdx === -1 ? Infinity : mainCloseIdx);
    return html.slice(sectionOpenIdx, end);
  }

  it("ninguna de las cinco secciones operativas (todas menos Laboratorio) contiene vocabulario técnico prohibido", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    for (const id of ["vista-inicio", "vista-agenda", "vista-llamadas", "vista-horarios-y-ausencias", "vista-equipo"]) {
      const section = extractSection(html, id).toLowerCase();
      for (const word of BANNED_WORDS) {
        expect(section.includes(word), `'${word}' aparece en ${id}`).toBe(false);
      }
    }
  });

  it("el panel 'Detalle técnico' de Llamadas está SIEMPRE dentro de un <details>, nunca a la vista por defecto", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const llamadas = extractSection(html, "vista-llamadas");
    const detailsIdx = llamadas.indexOf("<details");
    const summaryIdx = llamadas.indexOf("Detalle técnico");
    expect(detailsIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(detailsIdx);
    // Cierra antes del final de la sección.
    expect(llamadas.indexOf("</details>")).toBeGreaterThan(summaryIdx);
  });

  it("Laboratorio SÍ puede usar ese vocabulario — la regla es de ubicación, no de prohibición absoluta", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const laboratorio = extractSection(html, "vista-laboratorio").toLowerCase();
    // Al menos una de las palabras que están vetadas fuera SÍ aparece aquí
    // dentro — si esto empezara a fallar, sería señal de que Laboratorio se
    // ha quedado sin ningún detalle técnico real, no una victoria.
    expect(BANNED_WORDS.some((w) => laboratorio.includes(w.trim()))).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Responsive structural behaviour (§4.5) — feasible without a browser: the
// CSS breakpoints and their declared behaviour actually exist in the served
// stylesheet, at the exact widths the design specifies.
// ---------------------------------------------------------------------

describe("consola · comportamiento responsivo estructural (§4.5) — sin navegador, sobre el CSS servido", () => {
  const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");

  it("existen los cuatro puntos de ruptura exactos del diseño: 1439px, 1279px, 1023px y 720px", () => {
    for (const width of [1439, 1279, 1023, 720]) {
      expect(css).toContain(`@media (max-width: ${String(width)}px)`);
    }
  });

  it("a 1279px la barra lateral colapsa a un raíl y oculta las etiquetas de texto (glifo TX visible)", () => {
    const block = css.slice(css.indexOf("@media (max-width: 1279px)"), css.indexOf("@media (max-width: 1023px)"));
    expect(block).toContain(".tx-nav__label { display: none; }");
    expect(block).toContain(".tx-brand__glyph { display: flex; }");
  });

  it("a 720px las tablas se convierten en fichas apiladas con el rótulo por attr(data-label), nunca con contenido inyectado", () => {
    const block = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(block).toContain("display: block");
    expect(block).toContain("content: attr(data-label)");
  });

  it("el ancho mínimo soportado (320px) no depende de ninguna regla adicional: no hay un quinto punto de ruptura por debajo de 720px que lo contradiga", () => {
    const breakpoints = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(Math.min(...breakpoints)).toBe(720);
  });
});

// =====================================================================
// REVISIÓN step 15 — los defectos que encontró la revisión independiente
// de UX y accesibilidad. Cada bloque de aquí abajo falla ANTES del arreglo
// que documenta.
// =====================================================================

const CAL_DEMO_SALON = buildCalendarSnapshot(demoSalonVenue(), []);

const INICIO_IDS = [
  "inicio-fecha",
  "tx-freshness",
  "inicio-estado-texto",
  "inicio-estado-dot",
  "kpi-llamadas-valor",
  "kpi-resueltas-valor",
  "kpi-reservas-valor",
  "kpi-errores",
  "kpi-errores-valor",
  "kpi-errores-hint",
  "contador-atencion",
  "vacio-atencion",
  // (step 21A, corte 2) La sección de atención tiene ahora id propio: es el
  // nodo al que renderInicio le pone y le quita el filete de acento (§4.5).
  { id: "panel-atencion", tag: "section" },
  { id: "lista-atencion", tag: "ul" },
  "contador-cola",
  "vacio-tareas",
  { id: "lista-tareas", tag: "ul" },
  "vacio-actividad",
  { id: "lista-actividad", tag: "ul" },
  "vacio-citas-hoy",
  { id: "lista-citas-hoy", tag: "ul" },
  "inicio-calendario-resumen",
  { id: "lista-dias-distintos", tag: "ul" },
] as const;

const DETALLE_IDS = [
  { id: "llamada-detalle", tag: "article" },
  { id: "llamada-detalle-titulo", tag: "h2" },
  "llamada-detalle-pill",
  "llamada-detalle-orfana",
  "llamada-detalle-que-paso",
  "llamada-detalle-intencion",
  "llamada-detalle-anuncia",
  { id: "llamada-detalle-tecnico", tag: "dl" },
  { id: "llamada-copiar-hash", tag: "button" },
  "llamada-copiar-estado",
  { id: "tx-view-title", tag: "h1" },
] as const;

const LLAMADAS_IDS = [
  "filtro-todas-n",
  "filtro-atencion-n",
  "filtro-reserva-n",
  "filtro-derivadas-n",
  "filtro-error-n",
  "llamadas-vacio",
  "llamadas-vacio-filtro",
  { id: "llamadas-tbody", tag: "tbody" },
] as const;

const CALENDARIO_IDS_M16 = [
  "calendario-mes-titulo",
  { id: "calendario-mes-anterior", tag: "a" },
  { id: "calendario-mes-siguiente", tag: "a" },
  "calendario-temporada",
  "calendario-temporada-titulo",
  "calendario-temporada-detalle",
  "calendario-temporada-aviso-fecha",
  { id: "calendario-grid-body", tag: "tbody" },
  "calendario-dias-distintos-vacio",
  { id: "calendario-dias-distintos", tag: "ul" },
  { id: "calendario-excepciones-anteriores", tag: "ul" },
  "calendario-excepciones-anteriores-vacio",
  // (step 26 REAPERTURA §R7) Ídem: los cuatro bloques de la pantalla nueva.
  "horarios-regimen",
  { id: "horarios-semana", tag: "ul" },
  { id: "horarios-excepciones-mes", tag: "ul" },
  "horarios-excepciones-mes-vacio",
  { id: "horarios-filtro-profesional", tag: "select" },
  { id: "horarios-ausencias", tag: "ul" },
  "horarios-ausencias-vacio",
] as const;

const AGENDA_IDS = [
  { id: "agenda-filtro-profesional", tag: "select" },
  "agenda-dias",
  "agenda-vacio",
  // step 19 §3.8, punto 2: renderAgenda() también rellena el desplegable
  // del explorador de huecos, bajo la misma guarda de igualdad.
  { id: "huecos-profesional", tag: "select" },
] as const;

/**
 * step 16 (fase 3B) — los ids que `renderEquipo()` busca en el HTML real
 * desde que el horario del local se pinta una sola vez arriba de Equipo
 * (`equipo-horario-regimen`, `equipo-horario-dias`) en vez de dentro de cada
 * ficha.
 */
const EQUIPO_IDS_M16 = [
  { id: "equipo-fichas", tag: "div" },
  "equipo-vacio",
  "equipo-horario-regimen",
  { id: "equipo-horario-dias", tag: "ul" },
] as const;

/** Un par de horas "HH:mm – HH:mm" leído de un texto de interfaz, sea cual sea el espaciado del guion. */
function parHoras(texto: string): string | null {
  const m = /(\d{2}:\d{2})\s*–\s*(\d{2}:\d{2})/.exec(texto);
  return m ? `${m[1]}-${m[2]}` : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

// ---------------------------------------------------------------------
// step 16 (fase 3B) — B1/B2/B3/B4: el horario del local se pinta una sola
// vez arriba de Equipo (no repetido en cada ficha) y la ficha conserva sólo
// lo que es propio de cada profesional.
// ---------------------------------------------------------------------

describe("consola · Equipo — el horario del local se pinta una vez arriba de Equipo, no en cada ficha (step 16, B1/B2/B3/B4)", () => {
  it("B1: el bloque de horario del local trae exactamente siete filas, una por fecha real a partir de hoy", () => {
    const { document, nodes } = createFakeDocumentWithIds([...EQUIPO_IDS_M16]);
    const { renderEquipo } = loadUiClientHooks("", document);
    renderEquipo({ engineToday: "2026-08-04", calendar: CAL_DEMO_SALON });
    expect(nodes["equipo-horario-dias"]?.children.length).toBe(7);
  });

  it("B2: ninguna ficha trae ya ni 'Horario habitual', ni 'Horario del local', ni la explicación de temporada, ni horas escritas", () => {
    const { document, fichas } = createEquipoFakeDocument();
    const { renderEquipo } = loadUiClientHooks("", document);
    renderEquipo({ engineToday: "2026-08-04", calendar: CAL_DEMO_SALON });
    expect(fichas.children.length).toBe(3);
    for (const card of fichas.children) {
      const texto = card.textContent;
      expect(texto).not.toContain("Horario habitual");
      expect(texto).not.toContain("Horario del local");
      expect(texto).not.toContain("rige el horario de temporada");
      expect(texto).not.toContain("09:00 – 17:30");
    }
  });

  it("B2: 'season-notice' y 'tx-schedule-list', el bloque que se repetía tres veces, han desaparecido del código fuente de la consola", () => {
    const jsSource = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const htmlSource = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(jsSource).not.toContain("season-notice");
    expect(jsSource).not.toContain("tx-schedule-list");
    expect(htmlSource).not.toContain("season-notice");
    expect(htmlSource).not.toContain("tx-schedule-list");
  });

  it("B3: cada ficha conserva el nombre sintético y 'Puede hacer'; el botón de escritura se ha mudado (REAPERTURA §R8)", () => {
    const { document, fichas } = createEquipoFakeDocument();
    const { renderEquipo } = loadUiClientHooks("", document);
    renderEquipo({ engineToday: "2026-08-04", calendar: CAL_DEMO_SALON });
    expect(fichas.children.length).toBe(3);
    for (const card of fichas.children) {
      const nombre = card.children[0]?.children[0]?.textContent ?? "";
      expect(nombre).toMatch(/\(sintétic[oa]\)/);
      expect(card.textContent).toContain("Puede hacer");
      // §R8 — la creación, la edición y la retirada de ausencias viven SÓLO en
      // «Horarios y ausencias». La ficha ya no lleva ningún control que
      // ESCRIBA: conserva la lectura y gana UN enlace, no un botón por
      // ausencia. (Lo que sí sigue habiendo aquí se afirma entero en
      // `tests/console/horariosYAusencias.test.ts`, bloque R8.)
      expect(card.children[0]?.children[1]).toBeUndefined();
      expect(card.textContent).not.toContain("Añadir ausencia");
      expect(card.textContent).toContain("Gestionar ausencias");
    }
  });

  it("B4: las capacidades siguen siendo distintas por persona — Nerea no puede el servicio 'Barba'; Álex y Dani sí", () => {
    const { document, fichas } = createEquipoFakeDocument();
    const { renderEquipo } = loadUiClientHooks("", document);
    renderEquipo({ engineToday: "2026-08-04", calendar: CAL_DEMO_SALON });
    const porNombre = new Map(fichas.children.map((card) => [card.children[0]?.children[0]?.textContent ?? "", card]));
    const capsDe = (nombre: string): string => porNombre.get(nombre)?.children[1]?.children[1]?.textContent ?? "";
    expect(capsDe("Nerea (sintética)")).not.toContain("Barba");
    expect(capsDe("Álex (sintético)")).toContain("Barba");
    expect(capsDe("Dani (sintético)")).toContain("Barba");
  });
});

// ---------------------------------------------------------------------
// step 16 (fase 3B) — O5/B5/B6/B7/B8: el bloque de horario deriva las
// horas efectivas POR FECHA REAL (resolveVenueDay), no aplicando la
// temporada de "hoy" a los siete días. Antes esto se resolvía dentro de
// cada ficha con venueWeekdayHours(cal, dow, engineToday) — SIEMPRE con la
// fecha de hoy — así que una ventana que cruzaba una frontera estacional
// describía TODOS los días con el régimen de un único extremo.
// ---------------------------------------------------------------------

describe("consola · Equipo (O5) — las horas de cada fila son las de SU fecha, no las de 'hoy' aplicadas a las siete", () => {
  function pintarEquipo(engineToday: string): { filas: string[]; regimen: string } {
    const { document, nodes } = createFakeDocumentWithIds([...EQUIPO_IDS_M16]);
    const { renderEquipo } = loadUiClientHooks("", document);
    renderEquipo({ engineToday, calendar: CAL_DEMO_SALON });
    const ul = nodes["equipo-horario-dias"];
    expect(ul?.children.length).toBe(7);
    return {
      filas: (ul?.children ?? []).map((li) => li.textContent),
      regimen: nodes["equipo-horario-regimen"]?.textContent ?? "",
    };
  }

  it("B5, frontera julio→agosto: con engineToday = 2026-07-31, la fila del martes 4 de agosto da 09:00-17:30, no 09:30-19:30", () => {
    const { filas } = pintarEquipo("2026-07-31");
    // Fila 0 = 31 jul (viernes, ancla: sigue siendo horario ordinario);
    // fila 4 = 4 ago (martes, ya en temporada de agosto).
    expect(parHoras(filas[0] ?? "")).toBe("09:30-19:30");
    expect(parHoras(filas[4] ?? "")).toBe("09:00-17:30");
  });

  it("B6, frontera agosto→septiembre: con engineToday = 2026-08-31, la fila del martes 1 de septiembre da 09:30-19:30, no 09:00-17:30", () => {
    const { filas } = pintarEquipo("2026-08-31");
    // Fila 0 = 31 ago (lunes, cerrado); fila 1 = 1 sep (martes, ya fuera de
    // la temporada de agosto).
    expect(filas[0]).toContain("Cerrado");
    expect(parHoras(filas[1] ?? "")).toBe("09:30-19:30");
  });

  it("B7: el régimen avisa cuando la ventana de siete días cruza una frontera, y no avisa cuando no la cruza", () => {
    const cruzaJulioAgosto = pintarEquipo("2026-07-31").regimen;
    const cruzaAgostoSeptiembre = pintarEquipo("2026-08-31").regimen;
    const dentroDeAgosto = pintarEquipo("2026-08-04").regimen;
    expect(cruzaJulioAgosto).toContain("cambian de horario por el camino");
    expect(cruzaAgostoSeptiembre).toContain("cambian de horario por el camino");
    expect(dentroDeAgosto).not.toContain("cambian de horario por el camino");
    expect(dentroDeAgosto).toContain("Horario de agosto de 2026");
    expect(dentroDeAgosto).toContain("del 1 al 31 de agosto");
    // El régimen dice DE QUÉ temporada habla, no repite las horas de cada día.
    expect(parHoras(dentroDeAgosto)).toBeNull();
  });

  it("B8: Equipo y Calendario no discrepan — para las siete fechas de engineToday = 2026-07-31, la tira de Equipo coincide con resolveVenueDay()", () => {
    const { resolveVenueDay } = loadUiClientHooks();
    const { filas } = pintarEquipo("2026-07-31");
    let diasAbiertosComprobados = 0;
    for (let i = 0; i < 7; i += 1) {
      const dateISO = addDays("2026-07-31", i);
      const esperado = resolveVenueDay(dateISO, CAL_DEMO_SALON);
      const horas = parHoras(filas[i] ?? "");
      if (esperado.open) {
        expect(horas, `día ${dateISO}`).toBe(`${esperado.start}-${esperado.end}`);
        diasAbiertosComprobados += 1;
      } else {
        expect(horas, `día ${dateISO}`).toBeNull();
        expect(filas[i]).toContain("Cerrado");
      }
    }
    // Cinco días abiertos por semana en Demo Salon: si esto bajara a cero, la
    // comprobación de arriba sería vacua.
    expect(diasAbiertosComprobados).toBe(5);
  });

  it("F3 (reparación adversarial, 2ª ronda): la frase de régimen afirma de verdad que el horario es del LOCAL y es el MISMO para todo el equipo, con y sin temporada activa — la mutación 'MENTIRA: cada empleado tiene su propio horario personal.' no debe poder colarse sin que esta prueba caiga", () => {
    const sinTemporada = pintarEquipo("2026-10-06").regimen;
    const conTemporada = pintarEquipo("2026-08-04").regimen;
    expect(sinTemporada).toContain("horario de siempre del local");
    expect(sinTemporada).toContain("Es el mismo para todo el equipo.");
    expect(conTemporada).toContain("horario de temporada del local");
    expect(conTemporada).toContain("Es el mismo para todo el equipo.");
  });

  it("venueWeekdayHours() y resolveVenueDay() siguen dando lo mismo cuando no hay cierre ni festivo — es la MISMA fuente de verdad", () => {
    const { venueWeekdayHours, resolveVenueDay } = loadUiClientHooks();
    for (const dateISO of ["2026-08-04", "2026-08-08", "2026-08-10", "2026-09-01", "2026-09-05"]) {
      expect(venueWeekdayHours(CAL_DEMO_SALON, weekdayOf(dateISO), dateISO)).toEqual(resolveVenueDay(dateISO, CAL_DEMO_SALON));
    }
  });
});

// ---------------------------------------------------------------------
// step 16 — reparación del defecto B1 de la revisión adversarial. La
// FASE 3B, al mover el horario del local de las fichas de Equipo a
// `#equipo-horario-dias`, se llevó por delante la única prueba que
// renderizaba EQUIPO, AGENDA y CALENDARIO de verdad y comparaba, día por
// día, lo que las tres pantallas escriben. La prueba "B8" que quedó en su
// lugar solo compara Equipo contra `resolveVenueDay()` — nunca contra lo
// que Agenda y Calendario pintan — así que si Agenda o Calendario dejaran
// de usar `resolveVenueDay(dateISO, …)` con la fecha real, nada lo nota.
// Esta prueba cierra ese agujero volviendo a renderizar las tres.
//
// Cobertura real (ampliada en step 16, 3ª ronda de reparación adversarial,
// A3 — la cabecera anterior no lo decía con precisión):
// - Dos ventanas de siete días SIN cruzar la frontera estacional
//   (2026-08-04, dentro de agosto; 2026-09-01, fuera) comparan Equipo,
//   Agenda y Calendario los siete días, con `CAL_DEMO_SALON` tal cual (sin
//   cierres ni `venueRules`).
// - Una ventana que SÍ cruza la frontera estacional (2026-07-31 a
//   2026-08-06) compara Equipo contra Agenda los siete días completos, pero
//   Equipo contra Calendario SOLO el día que cae dentro del mes visible de
//   julio (el propio 31 de julio): `monthMatrix()` rellena con `null` los
//   huecos que sobran de la cuadrícula de julio en vez de traer los días de
//   agosto del mes siguiente, así que los otros seis días de la ventana
//   (1 al 6 de agosto) no tienen celda de Calendario con la que comparar
//   en esa misma llamada a `renderCalendario()`.
// - Dos ventanas con una excepción aprobada dentro de `CAL_DEMO_SALON` — un
//   cierre completo (`closures`) y un festivo (`venueRules`, `kind:
//   "holiday"`) — comprueban que el día cerrado por la excepción, y no solo
//   por el día de la semana, coincide en las tres pantallas.
// ---------------------------------------------------------------------

describe("consola · Equipo, Agenda y Calendario dicen exactamente las mismas horas, día por día (reparación B1)", () => {
  /** Lo que pinta el bloque "Horario del local" de Equipo, por fecha real. */
  function horasDeEquipo(engineToday: string, calendar: typeof CAL_DEMO_SALON = CAL_DEMO_SALON): Record<string, string | null> {
    const { document, nodes } = createFakeDocumentWithIds([...EQUIPO_IDS_M16]);
    const { renderEquipo } = loadUiClientHooks("", document);
    renderEquipo({ engineToday, calendar });
    const filas = nodes["equipo-horario-dias"]?.children ?? [];
    expect(filas.length).toBe(7);
    const porFecha: Record<string, string | null> = {};
    filas.forEach((li, i) => {
      porFecha[addDays(engineToday, i)] = parHoras(li.textContent ?? "");
    });
    return porFecha;
  }

  /** Lo que escribe Agenda como "Horario del local: …" para una fecha concreta. */
  function horasDeAgenda(dateISO: string, calendar: typeof CAL_DEMO_SALON = CAL_DEMO_SALON): string | null {
    const { document, nodes } = createFakeDocumentWithIds([...AGENDA_IDS]);
    const { renderAgenda } = loadUiClientHooks("", document);
    renderAgenda({ engineToday: dateISO, engineNowMinutes: 0, calendar });
    const panel = nodes["agenda-dias"]?.children[0];
    const nota = panel?.children[1]?.textContent ?? "";
    return parHoras(nota);
  }

  /**
   * Lo que pinta la celda del Calendario para cada día del mes visible. La
   * posición de cada celda se saca de `monthMatrix()`, la MISMA función que
   * usa el propio renderizador, en vez de leer el número escrito en la
   * celda.
   */
  function horasDeCalendario(engineToday: string, calendar: typeof CAL_DEMO_SALON = CAL_DEMO_SALON): Record<string, string | null> {
    const { document, nodes } = createFakeDocumentWithIds([...CALENDARIO_IDS_M16]);
    const { renderHorariosYAusencias, monthMatrix } = loadUiClientHooks("", document);
    renderHorariosYAusencias({ engineToday, engineNowMinutes: 9 * 60, calendar });
    const weeks = monthMatrix(Number(engineToday.slice(0, 4)), Number(engineToday.slice(5, 7)));
    const filas = nodes["calendario-grid-body"]?.children ?? [];
    expect(filas.length).toBe(weeks.length);
    const porFecha: Record<string, string | null> = {};
    weeks.forEach((week, i) => {
      week.forEach((dateISO, j) => {
        if (!dateISO) return;
        porFecha[dateISO] = parHoras(filas[i]?.children[j]?.children[1]?.textContent ?? "");
      });
    });
    return porFecha;
  }

  for (const engineToday of ["2026-08-04", "2026-09-01"]) {
    it(`con engineToday = ${engineToday}, Equipo, Agenda y Calendario dicen exactamente las mismas horas, día por día`, () => {
      const equipo = horasDeEquipo(engineToday);
      const calendario = horasDeCalendario(engineToday);
      let diasComprobados = 0;
      for (let i = 0; i < 7; i += 1) {
        const dateISO = addDays(engineToday, i);
        const agenda = horasDeAgenda(dateISO);
        const eq = equipo[dateISO] ?? null;
        const cal = calendario[dateISO] ?? null;
        expect(eq, `Equipo vs Agenda el ${dateISO}`).toBe(agenda);
        expect(eq, `Equipo vs Calendario el ${dateISO}`).toBe(cal);
        if (agenda) diasComprobados += 1;
      }
      // Una semana de Demo Salon tiene cinco días abiertos: si esto bajara a
      // cero, las dos comprobaciones de arriba serían "null === null" siete
      // veces y la prueba pasaría sin haber comprobado nada.
      expect(diasComprobados).toBe(5);
    });
  }

  it("con engineToday = 2026-07-31 (la ventana cruza la frontera estacional de agosto), Equipo y Agenda coinciden los siete días; Equipo y Calendario solo se comparan el día que cae dentro del mes visible de julio", () => {
    const engineToday = "2026-07-31";
    const equipo = horasDeEquipo(engineToday);
    const calendario = horasDeCalendario(engineToday);
    let diasComprobadosAgenda = 0;
    let diasComprobadosCalendario = 0;
    for (let i = 0; i < 7; i += 1) {
      const dateISO = addDays(engineToday, i);
      const agenda = horasDeAgenda(dateISO);
      const eq = equipo[dateISO] ?? null;
      expect(eq, `Equipo vs Agenda el ${dateISO}`).toBe(agenda);
      if (agenda) diasComprobadosAgenda += 1;
      // Solo el 31 de julio cae dentro del mes que `renderCalendario()`
      // visualiza cuando engineToday = 2026-07-31; el resto de la ventana
      // (1 al 6 de agosto) queda fuera de esa cuadrícula porque
      // `monthMatrix()` rellena los huecos sobrantes de julio con `null` en
      // vez de traer los días del mes siguiente. Comparar contra esos `null`
      // sería comparar "abierto" contra "sin celda", no una comprobación
      // real, así que esos seis días se excluyen a propósito.
      if (dateISO.startsWith("2026-07")) {
        const cal = calendario[dateISO] ?? null;
        expect(eq, `Equipo vs Calendario el ${dateISO}`).toBe(cal);
        if (cal) diasComprobadosCalendario += 1;
      }
    }
    // Los siete días de la ventana (31 jul, 1, 4, 5 y 6 ago abiertos; 2 y 3
    // ago cerrados por ser domingo y lunes): cinco abiertos.
    expect(diasComprobadosAgenda).toBe(5);
    // El único día comparable contra Calendario es el 31 de julio, y está
    // abierto (viernes, horario ordinario): si esto bajara a cero la
    // comprobación de Equipo vs Calendario de arriba nunca se ejecutaría.
    expect(diasComprobadosCalendario).toBe(1);
  });

  it("con un cierre completo aprobado dentro de la ventana (2026-08-05), el día cerrado por el cierre —y no solo por el día de la semana— coincide en Equipo, Agenda y Calendario", () => {
    const engineToday = "2026-08-04";
    const calendarConCierre: typeof CAL_DEMO_SALON = {
      ...CAL_DEMO_SALON,
      closures: [
        { id: "cierre-1", kind: "full_closure", startDate: "2026-08-05", endDate: "2026-08-05", source: "manual", approval: "approved", audit: { createdAt: "2026-08-01T00:00:00.000Z", createdBy: "console-test" } },
      ],
    };
    const equipo = horasDeEquipo(engineToday, calendarConCierre);
    const calendario = horasDeCalendario(engineToday, calendarConCierre);
    let diasComprobados = 0;
    for (let i = 0; i < 7; i += 1) {
      const dateISO = addDays(engineToday, i);
      const agenda = horasDeAgenda(dateISO, calendarConCierre);
      const eq = equipo[dateISO] ?? null;
      const cal = calendario[dateISO] ?? null;
      expect(eq, `Equipo vs Agenda el ${dateISO}`).toBe(agenda);
      expect(eq, `Equipo vs Calendario el ${dateISO}`).toBe(cal);
      if (agenda) diasComprobados += 1;
    }
    // El 5 de agosto sería miércoles de temporada (abierto) sin el cierre:
    // con él, de los cinco días normalmente abiertos de la semana queda
    // solo cuatro. Si el cierre no se aplicara en alguna pantalla, esta
    // cifra seguiría en 5 y las comprobaciones de arriba fallarían en el 5
    // de agosto (horas reales contra `null`, o viceversa).
    expect(diasComprobados).toBe(4);
    expect(equipo["2026-08-05"]).toBe(null);
  });

  it("con un festivo aprobado dentro de la ventana (2026-08-06, venueRules), el día cerrado por el festivo —y no solo por el día de la semana— coincide en Equipo, Agenda y Calendario", () => {
    const engineToday = "2026-08-04";
    const calendarConFestivo: typeof CAL_DEMO_SALON = {
      ...CAL_DEMO_SALON,
      venueRules: [
        { id: "festivo-1", kind: "holiday", scope: "venue", date: "2026-08-06", closed: true, source: "manual", approval: "approved", audit: { createdAt: "2026-08-01T00:00:00.000Z", createdBy: "console-test" } },
      ],
    };
    const equipo = horasDeEquipo(engineToday, calendarConFestivo);
    const calendario = horasDeCalendario(engineToday, calendarConFestivo);
    let diasComprobados = 0;
    for (let i = 0; i < 7; i += 1) {
      const dateISO = addDays(engineToday, i);
      const agenda = horasDeAgenda(dateISO, calendarConFestivo);
      const eq = equipo[dateISO] ?? null;
      const cal = calendario[dateISO] ?? null;
      expect(eq, `Equipo vs Agenda el ${dateISO}`).toBe(agenda);
      expect(eq, `Equipo vs Calendario el ${dateISO}`).toBe(cal);
      if (agenda) diasComprobados += 1;
    }
    // El 6 de agosto sería jueves de temporada (abierto) sin el festivo: con
    // él, de los cinco días normalmente abiertos de la semana queda solo
    // cuatro, igual que en el cierre de arriba pero por la otra vía
    // (`venueRules`, no `closures`).
    expect(diasComprobados).toBe(4);
    expect(equipo["2026-08-06"]).toBe(null);
  });
});

// ---------------------------------------------------------------------
// B2 — el sondeo de 2 s arrancaba el foco por dos caminos que esquivaban
// la salvaguarda de reconcileList.
// ---------------------------------------------------------------------

describe("consola · foco (B2) — el sondeo no destruye un nodo que contenga el foco", () => {
  const SNAP_ATENCION = {
    engineToday: "2026-08-04",
    engineNowMinutes: 9 * 60,
    metrics: { callsHandled: 1, resolvedWithoutHumanInterruption: 0, callsWithOutcome: 1, bookingsCreated: 0, technicalErrors: 0 },
    calls: [
      {
        callIdHash: "hash-deriva",
        scenarioId: "A22-demo",
        startedAtISO: "2026-08-04T09:10:00.000Z",
        outcome: "DERIVA",
        internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
        lastIntent: "HUMAN_HELP",
      },
    ],
    humanQueue: { tasks: [] },
    calendar: CAL_DEMO_SALON,
  };

  it("'Necesita tu atención': el enlace 'Ver la llamada' que tiene el foco sigue siendo el MISMO nodo tras un segundo render", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);

    renderInicio(SNAP_ATENCION);
    const lista = nodes["lista-atencion"];
    expect(lista?.children.length).toBe(1);
    const enlace = lista?.children[0]?.querySelector("a");
    expect(enlace?.textContent).toBe("Ver la llamada");
    document.activeElement = enlace ?? null;

    renderInicio(SNAP_ATENCION);

    expect(lista?.children[0]?.querySelector("a")).toBe(enlace);
    expect(document.activeElement).toBe(enlace);
    expect(lista?.contains(document.activeElement)).toBe(true);
  });

  it("sin foco dentro, la tarjeta SÍ se reconstruye: la guarda protege el foco, no congela la pantalla", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_ATENCION);
    const enlace = nodes["lista-atencion"]?.children[0]?.querySelector("a");
    document.activeElement = null;
    renderInicio(SNAP_ATENCION);
    expect(nodes["lista-atencion"]?.children[0]?.querySelector("a")).not.toBe(enlace);
  });

  const SNAP_ORFANA = {
    calls: [
      {
        callIdHash: "hash-fallo",
        scenarioId: "A23-demo",
        startedAtISO: "2026-08-04T09:10:00.000Z",
        outcome: "DERIVA",
        internalReasonCode: "TECHNICAL_FAILURE",
        currentState: "FIN",
      },
    ],
    humanQueue: {
      tasks: [
        {
          id: "tarea-1",
          callIdHash: "hash-fallo",
          reasonKind: "REVIEW_ORPHANED_SYNTHETIC_RESERVATION",
          reasonLabel: "Revisar una reserva huérfana",
          createdAtISO: "2026-08-04T09:11:00.000Z",
          // `open` es obligatorio en `ConsoleTaskView` (snapshot.ts) — todo
          // servidor real lo manda. Este motivo no tiene hoy ninguna ruta de
          // cierre (findTask, ui.js.ts, ahora exige `.open` tras la revisión
          // adversarial de la capacidad 2, hallazgo H8), así que sigue
          // siendo `true` siempre; el fixture sólo se completa con el campo
          // que ya faltaba.
          open: true,
        },
      ],
    },
    calendar: {
      professionals: [],
      reservations: [
        { id: "res-1", callIdHash: "hash-fallo", date: "2026-08-04", startMinutes: 600, serviceId: 1, employeeId: 3, status: "confirmed" },
      ],
    },
  };

  it("aviso de reserva huérfana: el enlace 'Ver la cita en la agenda' que tiene el foco sobrevive al siguiente sondeo", () => {
    const { document, nodes } = createFakeDocumentWithIds([...DETALLE_IDS, ...LLAMADAS_IDS, "inicio-ruta-desconocida"]);
    const { applyRoute, renderCallDetail } = loadUiClientHooks("#/llamadas/hash-fallo", document);
    applyRoute();

    renderCallDetail(SNAP_ORFANA);
    const aviso = nodes["llamada-detalle-orfana"];
    const enlace = aviso?.querySelector("a");
    expect(enlace?.textContent).toBe("Ver la cita en la agenda");
    document.activeElement = enlace ?? null;

    renderCallDetail(SNAP_ORFANA);

    expect(aviso?.querySelector("a")).toBe(enlace);
    expect(document.activeElement).toBe(enlace);
  });
});

// ---------------------------------------------------------------------
// D1 — el Calendario se contradecía sobre agosto.
// ---------------------------------------------------------------------

describe("consola · días distintos (D1) — el texto de 'no hay nada distinto' no puede desmentir al aviso de temporada", () => {
  function textoVacioCalendario(engineToday: string): string {
    const { document, nodes } = createFakeDocumentWithIds([...CALENDARIO_IDS_M16]);
    const { renderHorariosYAusencias } = loadUiClientHooks("", document);
    renderHorariosYAusencias({ engineToday, engineNowMinutes: 9 * 60, calendar: CAL_DEMO_SALON });
    return nodes["calendario-dias-distintos-vacio"]?.textContent ?? "";
  }

  it("en agosto, con el banner de temporada puesto, el bloque vacío ya no dice 'todos los días siguen el horario habitual'", () => {
    const texto = textoVacioCalendario("2026-08-04");
    expect(texto).not.toContain("Todos los días siguen el horario habitual");
    expect(texto).toContain("horario de temporada");
    expect(texto).toContain("Horario de agosto de 2026");
    expect(texto).toContain("del 1 al 31 de agosto");
  });

  it("fuera de temporada, el texto habla de lo que VIENE, no del mes visible (REAPERTURA §R7)", () => {
    // El bloque 4 se llama ahora «Próximas excepciones» y su ventana es
    // «desde hoy», no «el mes visible»: por eso su texto de vacío es el de
    // ámbito «próximos», no el de ámbito «mes». La frase de temporada, que es
    // lo que D1 vino a arreglar, sigue mandando cuando la hay (caso de arriba).
    const texto = textoVacioCalendario("2026-10-06");
    expect(texto).toContain("Nada distinto por delante.");
    expect(texto).toContain("Los próximos días siguen el horario de siempre.");
    expect(texto).not.toContain("Todos los días siguen el horario habitual.");
  });

  it("Inicio hace lo mismo: en agosto no afirma que los próximos días sigan el horario de siempre", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio({
      engineToday: "2026-08-04",
      engineNowMinutes: 9 * 60,
      metrics: { callsHandled: 0, resolvedWithoutHumanInterruption: 0, callsWithOutcome: 0, bookingsCreated: 0, technicalErrors: 0 },
      calls: [],
      humanQueue: { tasks: [] },
      calendar: CAL_DEMO_SALON,
    });
    const texto = nodes["inicio-calendario-resumen"]?.textContent ?? "";
    expect(texto).not.toContain("Los próximos días siguen el horario de siempre");
    expect(texto).toContain("horario de temporada");
    // (step 16) migración a #inicio-calendario-resumen, con MÁS aserciones
    // que antes, no menos: el resumen compacto que sustituye a la tarjeta
    // vacía de dos párrafos debe seguir siendo el texto EXACTO del criterio
    // de aceptación A6, con el fixture de hoy (sin closures/venueRules/
    // absences aprobados: no hay ninguna excepción por delante).
    expect(texto).toContain("Horario de agosto de 2026");
    expect(texto).toContain("del 1 al 31 de agosto");
    expect(texto).toContain("No hay ningún día distinto por delante");
  });
});

// =====================================================================
// step 16, FASE 3A — layout compartido, barra lateral e Inicio.
// Criterios de aceptación A1-A9 del plan de FASE 2.
// =====================================================================

function snapInicioBase(overrides: Record<string, unknown>) {
  return {
    engineToday: "2026-08-04",
    engineNowMinutes: 9 * 60,
    metrics: { callsHandled: 0, resolvedWithoutHumanInterruption: 0, callsWithOutcome: 0, bookingsCreated: 0, technicalErrors: 0 },
    calls: [],
    humanQueue: { tasks: [] },
    calendar: CAL_DEMO_SALON,
    ...overrides,
  };
}

describe("consola · Inicio (A7) — el resumen del calendario es veraz SIN temporada activa", () => {
  it("con engineToday fuera de agosto, el resumen dice 'horario de siempre' y no menciona ninguna temporada", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snapInicioBase({ engineToday: "2026-10-06" }));
    const texto = nodes["inicio-calendario-resumen"]?.textContent ?? "";
    expect(texto).toContain("El local va con su horario de siempre.");
    expect(texto).toContain("No hay ningún día distinto por delante.");
    expect(texto.toLowerCase()).not.toContain("temporada");
  });
});

// ---------------------------------------------------------------------
// step 21A, corte 2 — Inicio honesto. Lo que se comprueba aquí no es
// "que se vea bien" (no hay navegador): es que la jerarquía nueva no haya
// inventado ni un dato, que las claves y las guardas de foco de
// reconcileList sigan intactas, y que la separación entre atención y
// tareas siga siendo de dos cuentas distintas que nadie suma.
// ---------------------------------------------------------------------

/**
 * Los contratos de texto miran CÓDIGO, no comentarios: un comentario que
 * nombra la palabra prohibida justamente para prohibirla no puede disparar
 * el barrido. Misma técnica que `tallerUi.test.ts`.
 */
function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
}
const JS_FUENTE = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");

describe("consola · Inicio (step 21A §4.5) — el filete de acento del panel de atención", () => {
  const SNAP_CON_ATENCION = snapInicioBase({
    calls: [
      {
        callIdHash: "hash-atencion",
        scenarioId: "A22-demo",
        startedAtISO: "2026-08-04T09:10:00.000Z",
        outcome: "DERIVA",
        internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
        lastIntent: "HUMAN_HELP",
      },
    ],
  });

  it("con el contador a cero, la sección de atención NO lleva el filete", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snapInicioBase({}));
    expect(nodes["contador-atencion"]?.textContent).toBe("");
    expect(nodes["panel-atencion"]?.classList.contains("tx-panel--focus")).toBe(false);
  });

  it("en cuanto el contador pasa de cero, lo lleva — y se lo quita cuando vuelve a cero", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_CON_ATENCION);
    expect(nodes["contador-atencion"]?.textContent).toBe("(1)");
    expect(nodes["panel-atencion"]?.classList.contains("tx-panel--focus")).toBe(true);
    renderInicio(snapInicioBase({}));
    expect(nodes["panel-atencion"]?.classList.contains("tx-panel--focus")).toBe(false);
  });

  it("el filete es SÓLO del panel de atención: el JavaScript servido no se lo pone a ningún otro, y el HTML no lo trae puesto de fábrica", () => {
    const js = sinComentarios(JS_FUENTE);
    const html = sinComentarios(readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8"));
    const apariciones = js.match(/tx-panel--focus/g) ?? [];
    expect(apariciones.length).toBe(1);
    expect(js).toContain("byId('panel-atencion')");
    expect(html).not.toContain("tx-panel--focus");
    // Y las dos cuentas siguen siendo dos: nadie las suma en ningún sitio.
    expect(js).not.toMatch(/attentionEntries\.length\s*\+\s*tasks\.length/);
  });
});

// ---------------------------------------------------------------------
// (revisión adversarial F4, H2) El candado de arriba es TEXTUAL y mira una
// sola grafía: `attentionEntries.length + tasks.length`. Escribir el mismo
// doble recuento de otra manera —por ejemplo sumando
// `snap.humanQueue.tasks.filter(...).length` en el sitio— es idéntico en
// significado y la expresión regular no lo ve. Y ninguna prueba de Inicio
// ejercitaba a la vez las DOS colas, así que la suma nunca se notaba.
//
// Lo de aquí abajo es la comprobación de COMPORTAMIENTO que faltaba: dos
// cuentas, con datos en las dos a la vez, y cada número exactamente igual a
// su propia verdad. Las llamadas de atención son DERIVA/CUSTOMER_REQUESTS_HUMAN
// a propósito: esa rama de `callAttentionEntry` no consulta la cola humana
// (`findTask` sólo entra por TECHNICAL_FAILURE), así que la independencia
// que se afirma no depende de ningún azar del fixture.
// ---------------------------------------------------------------------

describe("consola · Inicio (revisión adversarial F4, H2) — atención y tareas son dos cuentas independientes: ninguna incluye a la otra", () => {
  const LLAMADAS_ATENCION = [
    {
      callIdHash: "hash-deriva-1",
      scenarioId: "A22-demo",
      startedAtISO: "2026-08-04T09:10:00.000Z",
      outcome: "DERIVA",
      internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
      lastIntent: "HUMAN_HELP",
    },
    {
      callIdHash: "hash-deriva-2",
      scenarioId: "A22-demo",
      startedAtISO: "2026-08-04T09:40:00.000Z",
      outcome: "DERIVA",
      internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
      lastIntent: "HUMAN_HELP",
    },
  ];
  function tarea(id: string, open: boolean) {
    return {
      id,
      reasonKind: "REVIEW_LATE_CANCELLATION",
      reasonLabel: "Revisar una anulación tardía",
      createdAtISO: "2026-08-04T08:0" + id.slice(-1) + ":00.000Z",
      callIdHash: "sin-llamada-asociada",
      open,
    };
  }
  const TRES_ABIERTAS = [tarea("tarea-1", true), tarea("tarea-2", true), tarea("tarea-3", true), tarea("tarea-4", false)];

  it("con 2 llamadas que piden mirada y 3 tareas humanas abiertas, cada contador dice EXACTAMENTE lo suyo — 2 y 3, nunca 5", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snapInicioBase({ calls: LLAMADAS_ATENCION, humanQueue: { tasks: TRES_ABIERTAS } }));
    expect(nodes["contador-atencion"]?.textContent).toBe("(2)");
    expect(nodes["contador-cola"]?.textContent).toBe("(3)");
    // Y las dos listas dicen lo mismo que sus dos contadores.
    expect(nodes["lista-atencion"]?.children.length).toBe(2);
    expect(nodes["lista-tareas"]?.children.length).toBe(3);
  });

  it("las tareas abiertas pasan de 0 a 3 y el contador de atención NO se mueve: sigue diciendo (2)", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snapInicioBase({ calls: LLAMADAS_ATENCION, humanQueue: { tasks: [] } }));
    expect(nodes["contador-atencion"]?.textContent).toBe("(2)");
    expect(nodes["contador-cola"]?.textContent).toBe("");
    renderInicio(snapInicioBase({ calls: LLAMADAS_ATENCION, humanQueue: { tasks: TRES_ABIERTAS } }));
    expect(nodes["contador-atencion"]?.textContent).toBe("(2)");
    expect(nodes["contador-cola"]?.textContent).toBe("(3)");
  });

  it("sin ninguna llamada que pida mirada, el contador de atención se queda VACÍO aunque haya 3 tareas humanas abiertas", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snapInicioBase({ calls: [], humanQueue: { tasks: TRES_ABIERTAS } }));
    expect(nodes["contador-atencion"]?.textContent).toBe("");
    expect(nodes["panel-atencion"]?.classList.contains("tx-panel--focus")).toBe(false);
    expect(nodes["contador-cola"]?.textContent).toBe("(3)");
  });

  it("sin ninguna tarea abierta, el contador de la cola se queda VACÍO aunque haya 2 llamadas que piden mirada", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snapInicioBase({ calls: LLAMADAS_ATENCION, humanQueue: { tasks: [tarea("tarea-9", false)] } }));
    expect(nodes["contador-cola"]?.textContent).toBe("");
    expect(nodes["contador-atencion"]?.textContent).toBe("(2)");
    expect(nodes["panel-atencion"]?.classList.contains("tx-panel--focus")).toBe(true);
  });
});

describe("consola · Inicio (step 21A §4.7, D10/D11) — actividad reciente SÓLO de llamadas, con enlace real por fila", () => {
  const SNAP_ACTIVIDAD = snapInicioBase({
    calls: [
      {
        callIdHash: "hash-reserva",
        scenarioId: "A01-demo",
        startedAtISO: "2026-08-04T09:22:00.000Z",
        outcome: "RESUELVE",
        internalReasonCode: "BOOKING_CONFIRMED",
        countsAsBookingConversion: true,
        lastIntent: "BOOK",
      },
    ],
  });

  it("el título de la sección dice que la lista es de llamadas, y ya no promete una cronología entre dominios", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const inicio = html.slice(html.indexOf('id="vista-inicio"'), html.indexOf('id="vista-agenda"'));
    expect(inicio).toContain('<h2 id="tit-actividad">Actividad reciente de llamadas</h2>');
    // A9 sigue en pie: la actividad va la última del DOM de Inicio.
    expect(html.indexOf('id="tit-actividad"')).toBeGreaterThan(html.indexOf('id="tit-dias-distintos"'));
  });

  it("cada fila lleva un enlace con texto real a SU llamada — nunca un cheurón sin destino", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_ACTIVIDAD);
    const fila = nodes["lista-actividad"]?.children[0];
    const enlace = fila?.querySelector("a");
    expect(enlace?.textContent).toBe("Ver la llamada");
    expect(enlace?.href).toBe("#/llamadas/hash-reserva");
  });

  it("ni el hash, ni el reasonCode, ni el scenarioId salen como texto de la fila: eso vive en el detalle técnico de Llamadas", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_ACTIVIDAD);
    const cuerpo = nodes["lista-actividad"]?.children[0]?.children[1];
    const textos = (cuerpo?.children ?? []).map((p) => p.textContent ?? "").join(" | ");
    expect(textos).not.toContain("hash-reserva");
    expect(textos).not.toContain("BOOKING_CONFIRMED");
    expect(textos).not.toContain("A01-demo");
    expect(textos).toContain("09:22");
  });

  it("el enlace 'Ver la llamada' que tiene el foco sigue siendo el MISMO nodo tras dos renders más (guarda de foco del sondeo)", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_ACTIVIDAD);
    const enlace = nodes["lista-actividad"]?.children[0]?.querySelector("a");
    document.activeElement = enlace ?? null;

    renderInicio(SNAP_ACTIVIDAD);
    renderInicio(SNAP_ACTIVIDAD);

    expect(nodes["lista-actividad"]?.children[0]?.querySelector("a")).toBe(enlace);
    expect(document.activeElement).toBe(enlace);
    expect(enlace?.href).toBe("#/llamadas/hash-reserva");
  });
});

// ---------------------------------------------------------------------
// (revisión adversarial F4, H1) Las tres pruebas de arriba miran SÓLO
// `children[0]`: una fila fabricada que no salga de `snap.calls` —empujada
// a la lista después del filtro, con una fecha vieja para que no caiga la
// primera— pasaba entera sin que nada protestara, bajo un título que promete
// justo lo contrario y con un enlace `#/llamadas/<algo>` que no lleva a
// ninguna llamada.
//
// El candado que faltaba mira TODAS las filas y las mide contra la única
// fuente canónica: las llamadas CON desenlace del propio snapshot. Se
// comprueban las dos cosas que una fila inventada rompe —cuántas filas hay
// y de dónde sale cada una—, y se siembra el snapshot con reservas y tareas
// para que, si alguna vez alguien mezclara dominios aquí, se note.
// ---------------------------------------------------------------------

describe("consola · Inicio (revisión adversarial F4, H1) — en «Actividad reciente de llamadas» no cabe NI UNA fila que no sea una llamada canónica", () => {
  function llamada(n: number, minuto: number) {
    return {
      callIdHash: "hash-real-" + String(n),
      scenarioId: "A01-demo",
      startedAtISO: "2026-08-04T09:" + String(minuto).padStart(2, "0") + ":00.000Z",
      outcome: "RESUELVE",
      internalReasonCode: "BOOKING_CONFIRMED",
      countsAsBookingConversion: true,
      lastIntent: "BOOK",
    };
  }
  /** Una llamada EN CURSO: sin desenlace, no es actividad todavía. */
  const SIN_DESENLACE = {
    callIdHash: "hash-en-curso",
    scenarioId: "A01-demo",
    startedAtISO: "2026-08-04T09:59:00.000Z",
    internalReasonCode: "BOOKING_CONFIRMED",
    lastIntent: "BOOK",
  };
  /** Reservas y tareas: existen en el snapshot y NUNCA son actividad de llamadas. */
  const CALENDARIO_CON_RESERVAS = {
    ...CAL_DEMO_SALON,
    reservations: [
      { id: "reserva-inventada", date: "2026-08-04", serviceId: 0, employeeId: 1, startMinutes: 10 * 60, status: "confirmed" },
      { id: "reserva-inventada-2", date: "2026-08-04", serviceId: 1, employeeId: 2, startMinutes: 11 * 60, status: "confirmed" },
    ],
  };
  const TAREAS = {
    tasks: [
      {
        id: "tarea-inventada",
        reasonKind: "REVIEW_LATE_CANCELLATION",
        reasonLabel: "Revisar una anulación tardía",
        createdAtISO: "2026-08-04T08:00:00.000Z",
        callIdHash: "sin-llamada-asociada",
        open: true,
      },
    ],
  };

  type Nodos = ReturnType<typeof createFakeDocumentWithIds>["nodes"];

  /**
   * La verdad contra la que se mide la lista: los hashes de las llamadas del
   * snapshot que TIENEN desenlace. Cualquier fila cuya clave no esté aquí es
   * una fila que la sección no puede justificar.
   */
  function afirmarFilasCanonicas(nodes: Nodos, llamadas: ReadonlyArray<{ callIdHash: string; outcome?: string }>) {
    const canonicos = llamadas.filter((c) => c.outcome !== undefined).map((c) => c.callIdHash);
    const filas = nodes["lista-actividad"]?.children ?? [];
    // Cuántas: el tope de 5 sobre las llamadas con desenlace, ni una más.
    expect(filas.length).toBe(Math.min(5, canonicos.length));
    for (const fila of filas) {
      const clave = fila.getAttribute("data-key");
      // De dónde sale: de una llamada del snapshot, no de otro sitio.
      expect(canonicos, `la fila '${String(clave)}' no sale de ninguna llamada del snapshot`).toContain(clave);
      const enlace = fila.querySelector("a");
      expect(enlace?.textContent).toBe("Ver la llamada");
      expect(enlace?.href).toBe("#/llamadas/" + String(clave));
    }
  }

  it("con 6 llamadas con desenlace, hay 5 filas y las 5 salen de una llamada del snapshot", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    const llamadas = [llamada(1, 10), llamada(2, 15), llamada(3, 20), llamada(4, 25), llamada(5, 30), llamada(6, 35), SIN_DESENLACE];
    renderInicio(snapInicioBase({ calls: llamadas, calendar: CALENDARIO_CON_RESERVAS, humanQueue: TAREAS }));
    afirmarFilasCanonicas(nodes, llamadas);
  });

  it("con 2 llamadas con desenlace, hay 2 filas: ni la llamada en curso, ni una reserva, ni una tarea se cuelan por debajo", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    const llamadas = [llamada(1, 10), llamada(2, 15), SIN_DESENLACE];
    renderInicio(snapInicioBase({ calls: llamadas, calendar: CALENDARIO_CON_RESERVAS, humanQueue: TAREAS }));
    afirmarFilasCanonicas(nodes, llamadas);
    const claves = (nodes["lista-actividad"]?.children ?? []).map((li) => li.getAttribute("data-key"));
    expect(claves).toEqual(["hash-real-2", "hash-real-1"]);
    for (const ajena of ["reserva-inventada", "reserva-inventada-2", "tarea-inventada", "hash-en-curso"]) {
      expect(claves).not.toContain(ajena);
    }
  });

  it("sin ninguna llamada con desenlace, la lista se queda a cero aunque el snapshot tenga reservas y tareas", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(snapInicioBase({ calls: [SIN_DESENLACE], calendar: CALENDARIO_CON_RESERVAS, humanQueue: TAREAS }));
    expect(nodes["lista-actividad"]?.children.length).toBe(0);
    expect(nodes["vacio-actividad"]?.hidden).toBe(false);
  });
});

describe("consola · Inicio (step 21A §4.6, D8) — vista previa de citas: hora en su columna, y jamás un nombre de cliente", () => {
  const CAL_CON_CITAS = {
    ...CAL_DEMO_SALON,
    reservations: [
      { id: "res-2", date: "2026-08-04", serviceId: 0, employeeId: 1, startMinutes: 10 * 60, status: "confirmed" },
      { id: "res-1", date: "2026-08-04", serviceId: 1, employeeId: 2, startMinutes: 9 * 60 + 30, status: "confirmed" },
      { id: "res-pasada", date: "2026-08-04", serviceId: 0, employeeId: 1, startMinutes: 8 * 60, status: "confirmed" },
      { id: "res-cancelada", date: "2026-08-04", serviceId: 0, employeeId: 1, startMinutes: 11 * 60, status: "cancelled" },
    ],
  };
  const SNAP_CITAS = snapInicioBase({ calendar: CAL_CON_CITAS });

  it("sólo entran las confirmadas de hoy que no han pasado todavía, en orden cronológico", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_CITAS);
    const filas = nodes["lista-citas-hoy"]?.children ?? [];
    expect(filas.map((li) => li.getAttribute("data-key"))).toEqual(["res-1", "res-2"]);
  });

  it("la hora vive en su propia celda (no pegada al servicio) y el resto de la fila es servicio, profesional y píldora", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_CITAS);
    const fila = nodes["lista-citas-hoy"]?.children[0];
    expect(fila?.children[0]?.textContent).toBe("09:30");
    expect(fila?.children[0]?.className).toContain("tx-appointment-list__hour");
    const cuerpo = fila?.children[1];
    expect(cuerpo?.children[0]?.textContent).not.toContain("09:30");
    expect((cuerpo?.children[0]?.textContent ?? "").length).toBeGreaterThan(0);
    expect((cuerpo?.children[1]?.textContent ?? "").length).toBeGreaterThan(0);
    expect(fila?.children[2]?.children.length).toBe(1);
  });

  it("ningún texto de la fila sale del identificador de la reserva: no se inventa un nombre de cliente", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_CITAS);
    const fila = nodes["lista-citas-hoy"]?.children[0];
    const textos = [
      fila?.children[0]?.textContent ?? "",
      ...(fila?.children[1]?.children ?? []).map((p) => p.textContent ?? ""),
    ].join(" | ");
    expect(textos).not.toContain("res-1");
  });

  it("el carril temporal no añade NI UN NODO: la fila tiene exactamente tres hijos, y el punto y la línea son pseudoelementos del CSS", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_CITAS);
    expect(nodes["lista-citas-hoy"]?.children[0]?.children.length).toBe(3);
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    expect(css).toMatch(/\.tx-appointment-list > li::before\s*\{[^}]*border-radius:\s*50%/);
    expect(css).toMatch(/\.tx-appointment-list > li::after\s*\{[^}]*width:\s*1px/);
    expect(css).toContain(".tx-appointment-list > li:last-child::after { content: none; }");
  });

  it("(revisión adversarial F4, H3) la fila es la rejilla de DOS columnas de §4.6, y la píldora baja a su propia fila con el ancho entero", () => {
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    const regla = /\.tx-appointment-list > li \{[^}]*grid-template-columns:\s*([^;]+);/.exec(css);
    expect(regla, "la fila de la vista previa ya no declara sus columnas").not.toBeNull();
    // Dos pistas, las de §4.6. Una tercera pista para la píldora estrangulaba
    // la del servicio a 6 px (1440) y la dejaba en negativo (1280).
    expect(regla?.[1].trim()).toBe("4.5rem minmax(0, 1fr)");
    // Y la píldora ocupa las dos pistas de la fila de abajo, alineada a la
    // derecha: no compite por el ancho con el nombre del servicio.
    expect(css).toContain(".tx-appointment-list > li > div:last-child { grid-column: 1 / -1; grid-row: 2; justify-self: end; }");
    // Red de seguridad de §6.4: antes que desbordar, la píldora envuelve.
    expect(css).toMatch(/\.tx-appointment-list > li > div:last-child \.tx-pill \{[^}]*white-space:\s*normal/);
  });

  it("la clave de reconcileList sigue siendo r.id: una segunda pasada REUTILIZA la misma fila, no la reconstruye", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    renderInicio(SNAP_CITAS);
    const fila = nodes["lista-citas-hoy"]?.children[0];
    renderInicio(SNAP_CITAS);
    expect(nodes["lista-citas-hoy"]?.children[0]).toBe(fila);
  });
});

describe("consola · Inicio (step 21A §2.5) — las cuatro tarjetas de cifra estrenan disco e icono sin ganar un solo dato", () => {
  const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
  const inicio = html.slice(html.indexOf('id="vista-inicio"'), html.indexOf('id="vista-agenda"'));

  it("cada tarjeta lleva su disco con un SVG estático y aria-hidden: son cuatro, ni uno más", () => {
    expect((inicio.match(/class="tx-stat__icon" aria-hidden="true"/g) ?? []).length).toBe(4);
    expect((inicio.match(/<svg /g) ?? []).length).toBe(4);
  });

  it("los iconos NO nacen del cliente: fakeDom no tiene createElementNS y ui.js.ts no crea ni un SVG", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    expect(js).not.toContain("createElementNS");
    expect(js).not.toContain("<svg");
  });

  it("ninguna tarjeta afirma una tendencia, un objetivo ni una comparación: no hay serie histórica que lo respalde", () => {
    const js = sinComentarios(JS_FUENTE);
    const inicioSinComentarios = sinComentarios(inicio);
    for (const prohibido of ["vs ayer", "vs. ayer", "respecto a ayer", "objetivo", "tendencia"]) {
      expect(inicioSinComentarios.toLowerCase().includes(prohibido), `'${prohibido}' aparece en Inicio`).toBe(false);
      expect(js.toLowerCase().includes(prohibido), `'${prohibido}' aparece en el JavaScript servido`).toBe(false);
    }
  });

  it("la cifra usa el escalón grande de la escala y la pista vacía no reserva su fila", () => {
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    const regla = css.slice(css.indexOf(".tx-stat__value {"), css.indexOf("}", css.indexOf(".tx-stat__value {")));
    expect(regla).toContain("font-size: var(--tx-size-800)");
    expect(css).toContain(".tx-stat__hint:empty { display: none; }");
  });
});

describe("consola · Inicio (A8, corregido en F2 de la reparación step 16) — el resumen cuenta DÍAS NATURALES reales, no entradas del calendario", () => {
  it("con un cierre de dos días (10-11 ago) y una ausencia de un día (20 ago) por delante, el resumen dice 'Hay 3 días distintos por delante.' (tres fechas naturales, no dos entradas)", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    const calendarConExcepciones = {
      ...CAL_DEMO_SALON,
      seasonalSchedules: [],
      closures: [
        { id: "cierre-1", kind: "full_closure", startDate: "2026-08-10", endDate: "2026-08-11", source: "manual", approval: "approved", audit: {} },
      ],
      absences: [
        { id: "ausencia-1", employeeId: 1, kind: "vacation", startDate: "2026-08-20", endDate: "2026-08-20", allDay: true, source: "manual", approval: "approved", audit: {} },
      ],
    };
    renderInicio(snapInicioBase({ calendar: calendarConExcepciones }));
    const texto = nodes["inicio-calendario-resumen"]?.textContent ?? "";
    expect(texto).toContain("El local va con su horario de siempre.");
    expect(texto).toContain("Hay 3 días distintos por delante.");
  });

  it("un único día suelto se cuenta en singular: 'Hay 1 día distinto por delante.'", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    const calendarConUnDia = {
      ...CAL_DEMO_SALON,
      seasonalSchedules: [],
      closures: [
        { id: "cierre-1", kind: "full_closure", startDate: "2026-08-10", endDate: "2026-08-10", source: "manual", approval: "approved", audit: {} },
      ],
      absences: [],
    };
    renderInicio(snapInicioBase({ calendar: calendarConUnDia }));
    const texto = nodes["inicio-calendario-resumen"]?.textContent ?? "";
    expect(texto).toContain("Hay 1 día distinto por delante.");
  });

  it("un cierre de VARIOS días es UNA entrada del calendario pero VARIOS días: con un cierre del 10 al 12 de agosto (sin ninguna otra excepción), el resumen dice 'Hay 3 días distintos por delante.', no 'Hay 1'", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    const calendarConCierreLargo = {
      ...CAL_DEMO_SALON,
      seasonalSchedules: [],
      closures: [
        { id: "cierre-1", kind: "full_closure", startDate: "2026-08-10", endDate: "2026-08-12", source: "manual", approval: "approved", audit: {} },
      ],
      absences: [],
    };
    renderInicio(snapInicioBase({ calendar: calendarConCierreLargo }));
    const texto = nodes["inicio-calendario-resumen"]?.textContent ?? "";
    expect(texto).toContain("Hay 3 días distintos por delante.");
    expect(texto).not.toContain("Hay 1 día distinto por delante.");
  });

  it("recorte de días pasados: un cierre que empieza ANTES de hoy (1-6 ago, hoy 4 ago) solo cuenta los días de hoy en adelante — 'Hay 3 días distintos por delante.'", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    const calendarConCierrePasado = {
      ...CAL_DEMO_SALON,
      seasonalSchedules: [],
      closures: [
        { id: "cierre-1", kind: "full_closure", startDate: "2026-08-01", endDate: "2026-08-06", source: "manual", approval: "approved", audit: {} },
      ],
      absences: [],
    };
    renderInicio(snapInicioBase({ calendar: calendarConCierrePasado, engineToday: "2026-08-04" }));
    const texto = nodes["inicio-calendario-resumen"]?.textContent ?? "";
    // Sin recorte contaría los 6 días completos (1 al 6); con recorte, solo
    // 4, 5 y 6 de agosto (los que están hoy o por delante): 3 días.
    expect(texto).toContain("Hay 3 días distintos por delante.");
    expect(texto).not.toContain("Hay 6 días distintos por delante.");
  });

  it("deduplicación: un cierre (10-11 ago) y una ausencia el mismo día (10 ago) cuentan ese día UNA sola vez — 'Hay 2 días distintos por delante.'", () => {
    const { document, nodes } = createFakeDocumentWithIds([...INICIO_IDS]);
    const { renderInicio } = loadUiClientHooks("", document);
    const calendarConSolape = {
      ...CAL_DEMO_SALON,
      seasonalSchedules: [],
      closures: [
        { id: "cierre-1", kind: "full_closure", startDate: "2026-08-10", endDate: "2026-08-11", source: "manual", approval: "approved", audit: {} },
      ],
      absences: [
        { id: "ausencia-1", employeeId: 1, kind: "vacation", startDate: "2026-08-10", endDate: "2026-08-10", allDay: true, source: "manual", approval: "approved", audit: {} },
      ],
    };
    renderInicio(snapInicioBase({ calendar: calendarConSolape }));
    const texto = nodes["inicio-calendario-resumen"]?.textContent ?? "";
    // Sin deduplicar contaría 3 fechas (10, 10, 11); con deduplicación, el 10
    // de agosto cuenta una sola vez: 2 días (10 y 11).
    expect(texto).toContain("Hay 2 días distintos por delante.");
    expect(texto).not.toContain("Hay 3 días distintos por delante.");
  });
});

describe("consola · hoja de estilos (A1, A5) — barra lateral más estrecha y KPI a una sola fila a 1279px", () => {
  const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");

  it("A1: la barra lateral mide 216px de ancho, y 200px en el bloque de 1439px", () => {
    expect(css).toContain("flex: 0 0 216px");
    expect(css).toContain("width: 216px");
    const bloque1439 = css.slice(css.indexOf("@media (max-width: 1439px)"), css.indexOf("@media (max-width: 1279px)"));
    expect(bloque1439).toContain("flex-basis: 200px");
    expect(bloque1439).toContain("width: 200px");
  });

  it("A2: la placa del logo está limitada a 132px de ancho", () => {
    expect(css).toContain("max-width: 132px");
  });

  it("A5: a 1279px los cuatro KPI de Inicio ocupan una sola fila, no dos", () => {
    const bloque1279 = css.slice(css.indexOf("@media (max-width: 1279px)"), css.indexOf("@media (max-width: 1023px)"));
    expect(bloque1279).toContain(".tx-stat-grid { grid-template-columns: repeat(4, 1fr); }");
  });
});

describe("consola · barra lateral (A3) — 'Laboratorio' está separado en las cuatro anchuras y su rótulo sigue siendo accesible", () => {
  const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");

  it("el separador vive fuera de toda media query (≥1280px) como borde superior de .tx-nav__list--tools", () => {
    const antesDeMedia = css.slice(0, css.indexOf("@media (max-width: 1439px)"));
    expect(antesDeMedia).toMatch(/\.tx-nav__list--tools\s*\{[^}]*border-top:/);
  });

  it("a ≤1023px (barra horizontal) el separador es una línea VERTICAL a la izquierda de Laboratorio", () => {
    const bloque1023 = css.slice(css.indexOf("@media (max-width: 1023px)"), css.indexOf("@media (max-width: 720px)"));
    expect(bloque1023).toMatch(/\.tx-nav__list--tools\s*\{[^}]*border-left:/);
  });

  it("'.tx-sidebar__tools-label' no lleva 'display: none' en ningún bloque: nunca sale del árbol de accesibilidad", () => {
    expect(css).not.toMatch(/\.tx-sidebar__tools-label[^}]*display:\s*none/);
  });
});

describe("consola · Inicio (A4, A9) — el aviso sintético nunca se esconde, y 'Lo último que ha pasado' va el último", () => {
  const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
  const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");

  it("A4: ninguna regla CSS oculta '.tx-badge-demo', y aparece exactamente una vez en el HTML servido", () => {
    expect(css).not.toMatch(/\.tx-badge-demo[^{]*\{[^}]*display:\s*none/);
    const apariciones = (html.match(/<span class="tx-badge-demo">/g) ?? []).length;
    expect(apariciones).toBe(1);
  });

  it("A9: 'Lo último que ha pasado' (tit-actividad) va DESPUÉS de 'Próximos días distintos' (tit-dias-distintos) en el DOM de Inicio", () => {
    expect(html.indexOf('id="tit-actividad"')).toBeGreaterThan(html.indexOf('id="tit-dias-distintos"'));
  });
});

// ---------------------------------------------------------------------
// D3 / D4 — el foco al abrir y cerrar un detalle, y cerrar sin historial.
// ---------------------------------------------------------------------

describe("consola · foco del enrutador (D3) y cierre del detalle (D4)", () => {
  const SNAP_LLAMADAS = {
    calls: [
      {
        callIdHash: "hash-uno",
        scenarioId: "A01-demo",
        startedAtISO: "2026-08-04T09:10:00.000Z",
        outcome: "RESUELVE",
        internalReasonCode: "BOOKING_CONFIRMED",
        countsAsBookingConversion: true,
        lastIntent: "BOOK",
      },
    ],
    humanQueue: { tasks: [] },
  };

  function montar(hash: string) {
    const { document, nodes } = createFakeDocumentWithIds([
      ...DETALLE_IDS,
      ...LLAMADAS_IDS,
      "inicio-ruta-desconocida",
      "vista-inicio",
      "vista-agenda",
      "vista-llamadas",
      "vista-horarios-y-ausencias",
      "vista-equipo",
      "vista-laboratorio",
    ]);
    const win = { location: { hash }, scrollTo: () => undefined };
    const hooks = loadUiClientHooks(hash, document, win);
    return { document, nodes, win, hooks };
  }

  it("cambiar de SECCIÓN sigue enfocando el <h1> de la vista, como antes", () => {
    const { document, nodes, hooks } = montar("#/agenda");
    hooks.applyRoute();
    expect(document.activeElement).toBe(nodes["tx-view-title"]);
  });

  it("abrir el detalle de una llamada enfoca el título del DETALLE, no el <h1> de la vista", () => {
    const { document, nodes, win, hooks } = montar("#/llamadas");
    hooks.applyRoute();
    expect(document.activeElement).toBe(nodes["tx-view-title"]);

    win.location.hash = "#/llamadas/hash-uno";
    hooks.applyRoute();

    expect(document.activeElement).toBe(nodes["llamada-detalle-titulo"]);
  });

  it("cerrar el detalle devuelve el foco al enlace 'Ver' de la fila de origen", () => {
    const { document, nodes, win, hooks } = montar("#/llamadas/hash-uno");
    hooks.applyRoute();
    hooks.renderLlamadas(SNAP_LLAMADAS);
    const enlaceVer = nodes["llamadas-tbody"]?.children[0]?.querySelector("a");
    expect(enlaceVer).not.toBeNull();

    win.location.hash = "#/llamadas";
    hooks.applyRoute();

    expect(document.activeElement).toBe(enlaceVer);
  });

  it("salir del detalle hacia OTRA sección enfoca el <h1> de esa sección, no la fila de origen que ya no se ve", () => {
    const { document, nodes, win, hooks } = montar("#/llamadas/hash-uno");
    hooks.applyRoute();
    hooks.renderLlamadas(SNAP_LLAMADAS);

    win.location.hash = "#/agenda";
    hooks.applyRoute();

    expect(document.activeElement).toBe(nodes["tx-view-title"]);
  });

  it("si esa fila ya no está (filtro, llamada desaparecida), el foco cae en el <h1>, nunca en el <body>", () => {
    const { document, nodes, win, hooks } = montar("#/llamadas/hash-que-ya-no-existe");
    hooks.applyRoute();
    hooks.renderLlamadas(SNAP_LLAMADAS);

    win.location.hash = "#/llamadas";
    hooks.applyRoute();

    expect(document.activeElement).toBe(nodes["tx-view-title"]);
  });

  it("D4: cerrar el detalle navega a '#/llamadas' en vez de tirar del historial", () => {
    const { win, hooks } = montar("#/llamadas/hash-uno");
    hooks.applyRoute();
    hooks.closeCallDetail();
    expect(win.location.hash).toBe("#/llamadas");
  });

  it("D4: el JavaScript servido ya no llama a history.back() en ningún sitio", () => {
    const source = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    expect(source).not.toContain("history.back");
  });
});

// ---------------------------------------------------------------------
// step 16, O4 (C5/C6/C7) — Escape cierra el detalle de una llamada, salvo
// que un <dialog> nativo esté abierto, y devuelve el foco al enlace "Ver"
// EXACTO de origen. Antes de extender fakeDom.ts (§4.1) estas pruebas no se
// podían ni escribir: `document.dispatchKeydown` y `nodo.showModal` no
// existían — ver el informe de esta fase para el mensaje de error literal.
// ---------------------------------------------------------------------

describe("consola · Escape y el <dialog> nativo (step 16, O4, C5/C6/C7)", () => {
  const SNAP_DOS_LLAMADAS = {
    calls: [
      {
        callIdHash: "hash-a",
        scenarioId: "A01-demo",
        startedAtISO: "2026-08-04T09:10:00.000Z",
        outcome: "RESUELVE",
        internalReasonCode: "BOOKING_CONFIRMED",
        countsAsBookingConversion: true,
        lastIntent: "BOOK",
      },
      {
        callIdHash: "hash-b",
        scenarioId: "A02-demo",
        startedAtISO: "2026-08-04T09:40:00.000Z",
        outcome: "DERIVA",
        internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
        lastIntent: "HUMAN_HELP",
      },
    ],
    humanQueue: { tasks: [] },
  };

  function montarEscape(hash: string, extraIds: readonly (string | { id: string; tag: string })[] = []) {
    const { document, nodes } = createFakeDocumentWithIds([...DETALLE_IDS, ...LLAMADAS_IDS, "inicio-ruta-desconocida", ...extraIds]);
    const win = { location: { hash }, scrollTo: () => undefined };
    const hooks = loadUiClientHooks(hash, document, win);
    return { document, nodes, win, hooks };
  }

  it("C5: Escape cierra el detalle de una llamada cuando no hay ningún <dialog> nativo abierto", () => {
    const { document, win, hooks } = montarEscape("#/llamadas/hash-a");
    hooks.applyRoute();
    expect(win.location.hash).toBe("#/llamadas/hash-a");

    document.dispatchKeydown("Escape");

    expect(win.location.hash).toBe("#/llamadas");
  });

  it("C6: con un <dialog> nativo abierto, Escape NO toca el detalle de llamada — el diálogo manda primero", () => {
    const { document, win, hooks, nodes } = montarEscape("#/llamadas/hash-a", [{ id: "dialogo-dia-especial", tag: "dialog" }]);
    hooks.applyRoute();
    nodes["dialogo-dia-especial"]?.showModal();

    document.dispatchKeydown("Escape");

    // El hash no ha cambiado: el manejador de Escape del documento se ha
    // apartado en cuanto ha visto `document.querySelector('dialog[open]')`.
    expect(win.location.hash).toBe("#/llamadas/hash-a");
  });

  it("C7: con dos llamadas, cerrar el detalle de la SEGUNDA con Escape devuelve el foco a SU enlace 'Ver' exacto, no al de la otra", () => {
    const { document, nodes, win, hooks } = montarEscape("#/llamadas/hash-b");
    hooks.applyRoute();
    hooks.renderLlamadas(SNAP_DOS_LLAMADAS);
    expect(nodes["llamadas-tbody"]?.children.length).toBe(2);

    document.dispatchKeydown("Escape");
    expect(win.location.hash).toBe("#/llamadas");
    // En un navegador real, el cambio de hash dispara 'hashchange', que ya
    // está enganchado a applyRoute (ui.js.ts, cierre del fichero). Este
    // entorno de prueba no dispara eventos del navegador — se simula aquí
    // la MISMA llamada que ese listener haría.
    hooks.applyRoute();

    expect(document.activeElement?.getAttribute("data-call-hash")).toBe("hash-b");
  });
});

// ---------------------------------------------------------------------
// D5 — jerga y marca de tiempo cruda en el "Detalle técnico" de Llamadas.
// ---------------------------------------------------------------------

describe("consola · Llamadas (D5) — la fecha del detalle técnico se lee en castellano", () => {
  it("'Inicio' ya no imprime un ISO en crudo, sino la fecha y la hora dichas como se dicen", () => {
    const { document, nodes } = createFakeDocumentWithIds([...DETALLE_IDS, ...LLAMADAS_IDS, "inicio-ruta-desconocida"]);
    const { applyRoute, renderCallDetail } = loadUiClientHooks("#/llamadas/hash-uno", document);
    applyRoute();
    renderCallDetail({
      calls: [
        {
          callIdHash: "hash-uno",
          scenarioId: "A01-demo",
          startedAtISO: "2026-08-04T09:10:00.000Z",
          outcome: "RESUELVE",
          internalReasonCode: "BOOKING_CONFIRMED",
          currentState: "FIN",
        },
      ],
      humanQueue: { tasks: [] },
      calendar: { professionals: [], reservations: [] },
    });

    const dl = nodes["llamada-detalle-tecnico"];
    const etiquetas = dl?.children.map((c) => c.textContent) ?? [];
    const idx = etiquetas.indexOf("Inicio");
    expect(idx).toBeGreaterThan(-1);
    expect(dl?.children[idx + 1]?.textContent).toBe("martes, 4 de agosto de 2026 a las 09:10");
    expect(dl?.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // Los cuatro enums de al lado se quedan: la sección está rotulada
    // "Detalle técnico" y va plegada.
    expect(etiquetas).toContain("Resultado (outcome)");
    expect(etiquetas).toContain("Código congelado (reasonCode)");
    expect(etiquetas).toContain("Código interno");
    expect(etiquetas).toContain("Estado final");
  });
});

// ---------------------------------------------------------------------
// D6 — dos botones con aria-disabled pero sin disabled real.
// ---------------------------------------------------------------------

describe("consola · publicar un cambio de calendario (D6) — el botón está deshabilitado DE VERDAD", () => {
  it("mientras falte alguna cita por decidir, el botón queda disabled; cuando todas están decididas, se habilita", () => {
    const { document } = createFakeDocumentWithIds([]);
    const { updateImpactCounter } = loadUiClientHooks("", document);
    const contador = document.createElement("p");
    const boton = document.createElement("button");
    const impacted = [{ reservationId: "res-1" }, { reservationId: "res-2" }];

    updateImpactCounter(contador, boton, impacted, {});
    expect(boton.disabled).toBe(true);
    expect(contador.textContent).toBe("Falta decidir 2 citas.");

    updateImpactCounter(contador, boton, impacted, { "res-1": "keep_and_flag" });
    expect(boton.disabled).toBe(true);
    expect(contador.textContent).toBe("Falta decidir 1 cita.");

    updateImpactCounter(contador, boton, impacted, { "res-1": "keep_and_flag", "res-2": "mark_for_human_contact" });
    expect(boton.disabled).toBe(false);
    expect(contador.textContent).toBe("Todas las citas están decididas.");

    updateImpactCounter(contador, boton, [], {});
    expect(boton.disabled).toBe(false);
  });

  it("los dos botones llegan del servidor con el atributo disabled, y conservan su aria-describedby", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    for (const [id, describedBy] of [
      ["dia-especial-guardar", "dia-especial-contador"],
      ["ausencia-guardar", "ausencia-contador"],
    ]) {
      const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
      expect(tag, `no se ha encontrado el botón ${id}`).not.toBe("");
      expect(tag).toMatch(/\sdisabled(\s|>)/);
      expect(tag).toContain(`aria-describedby="${describedBy}"`);
      expect(tag).not.toContain("aria-disabled");
    }
  });
});

// ---------------------------------------------------------------------
// D7 — región de scroll sin nombre accesible.
// ---------------------------------------------------------------------

describe("consola · Agenda (D7) — la región de scroll que crea el JS tiene nombre accesible", () => {
  it("cada día lleva su propio role=region con aria-label, coherente con las dos regiones estáticas", () => {
    const { document, nodes } = createFakeDocumentWithIds([...AGENDA_IDS]);
    const { renderAgenda } = loadUiClientHooks("", document);
    renderAgenda({ engineToday: "2026-08-04", engineNowMinutes: 9 * 60, calendar: CAL_DEMO_SALON });
    const scroll = nodes["agenda-dias"]?.children[0]?.children[2];
    expect(scroll?.getAttribute("role")).toBe("region");
    expect(scroll?.getAttribute("aria-label")).toBe("Tabla de citas del martes, 4 de agosto de 2026");
  });
});

// ---------------------------------------------------------------------
// D2 / D8 — hoja de estilos.
// ---------------------------------------------------------------------

describe("consola · hoja de estilos (D2, D8)", () => {
  const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
  const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
  const bloque720 = css.slice(css.indexOf("@media (max-width: 720px)"));

  it("D2: por debajo de 720px la rejilla del mes SIGUE ahí — nunca se esconde", () => {
    expect(bloque720).not.toMatch(/\.tx-month-grid[^{]*\{[^}]*display:\s*none/);
    // Y pide más ancho que la pantalla, para que el overflow-x del contenedor
    // sirva de algo en vez de comprimir la rejilla hasta lo ilegible.
    expect(bloque720).toContain(".tx-month-grid { min-width:");
    // (step 16, C10) Tampoco se esconden la leyenda ni las celdas del mes:
    // el calendario no "desaparece por partes" para que la prueba pase.
    expect(bloque720).not.toMatch(/\.tx-legend[^{]*\{[^}]*display:\s*none/);
    expect(bloque720).not.toMatch(/\.tx-day-cell[^{]*\{[^}]*display:\s*none/);
  });

  it("D2: la lista de repuesto que nadie rellenaba nunca ya no existe, ni en el HTML ni en el CSS", () => {
    expect(html).not.toContain("calendario-dias-fallback");
    expect(css).not.toContain("tx-day-list--fallback");
  });

  it("D8: el halo de foco es un token: la regla base :focus-visible lo ORIGINA y las dos reglas con sombra propia (.tx-skip-link, a.tx-stat) lo vuelven a poner", () => {
    expect(css).toContain("--tx-focus-halo:");
    for (const selector of [":focus-visible {", ".tx-skip-link:focus-visible {", "a.tx-stat:focus-visible {"]) {
      const idx = css.indexOf(selector);
      expect(idx, `no existe la regla ${selector}`).toBeGreaterThan(-1);
      const cuerpo = css.slice(idx, css.indexOf("}", idx));
      expect(cuerpo, `${selector} no incluye el halo`).toContain("var(--tx-focus-halo)");
    }
  });

  it("D8: ninguna regla de :focus-visible declara un box-shadow que se coma el halo", () => {
    const reglas = [...css.matchAll(/([^\n{}]*:focus-visible[^\n{}]*)\{([^}]*)\}/g)];
    expect(reglas.length).toBeGreaterThan(0);
    for (const [, selector, cuerpo] of reglas) {
      if (!cuerpo.includes("box-shadow")) continue;
      expect(cuerpo, `${selector.trim()} pisa el halo`).toContain("var(--tx-focus-halo)");
    }
  });
});

describe("consola · responsive del Calendario y cobertura de 1440/1024px (step 16, C11/C12)", () => {
  const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
  const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
  const bloque720 = css.slice(css.indexOf("@media (max-width: 720px)"));
  const bloque1439 = css.slice(css.indexOf("@media (max-width: 1439px)"), css.indexOf("@media (max-width: 1279px)"));
  const bloque1023 = css.slice(css.indexOf("@media (max-width: 1023px)"), css.indexOf("@media (max-width: 720px)"));

  it("C11: 'Añadir día especial' es alcanzable a ≤720px — ocupa el ancho completo y sigue en el HTML", () => {
    expect(bloque720).toContain(".tx-controls > .tx-btn { width: 100%; }");
    expect(html).toContain('id="btn-abrir-dia-especial"');
  });

  it("C12: a ≤1439px se reduce .tx-sidebar Y .tx-workspace, no sólo uno de los dos", () => {
    expect(bloque1439).toMatch(/\.tx-sidebar\s*\{[^}]*(flex-basis|width):\s*200px/);
    expect(bloque1439).toMatch(/\.tx-workspace\s*\{[^}]*max-width:\s*1000px/);
  });

  it("C12: a ≤1023px la barra pasa a horizontal (.tx-shell en columna) y la placa del logo se reduce a 40px", () => {
    expect(bloque1023).toContain(".tx-shell { flex-direction: column; }");
    expect(bloque1023).toMatch(/\.tx-brand__plate\s*\{[^}]*display:\s*block;\s*width:\s*40px/);
  });
});

// ---------------------------------------------------------------------
// Limpieza — leyenda del calendario, concordancia y selección de texto.
// ---------------------------------------------------------------------

describe("consola · limpieza (revisión step 15)", () => {
  it("ningún control se deshabilita sólo de cara a la galería: no queda un aria-disabled sin disabled real", () => {
    // El defecto D6 no era de un botón, era de un patrón: `aria-disabled` se lo
    // cuenta al lector de pantalla pero deja el botón pulsable, así que el clic
    // llega y no pasa nada. Se cerró en los dos botones de publicar y en el de
    // reiniciar, donde además un doble clic disparaba dos POST /api/reset.
    //
    // Se comprueba sobre el FUENTE de los dos módulos que se sirven al
    // navegador, para que un `aria-disabled` nuevo tenga que justificarse aquí.
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    // (segunda revisión, punto 5) Se añade `ui.css.ts` a este barrido: la
    // regla `.tx-btn[aria-disabled="true"]` era CSS muerto (nunca hay un
    // `aria-disabled` real en el HTML/JS servidos, como estas dos líneas ya
    // comprobaban) que sólo servía para confundir a quien leyera la hoja de
    // estilos pensando que el patrón seguía en uso.
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    expect(js).not.toContain("'aria-disabled'");
    expect(js).not.toContain('"aria-disabled"');
    expect(html).not.toContain("aria-disabled");
    expect(css).not.toContain("aria-disabled");
  });

  it("la leyenda del calendario dice la misma palabra que escriben las celdas: 'Cerrado', no 'Cerr.'", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(html).not.toContain("Cerr. =");
    expect(html).toContain("Cerrado = ese día el local no abre");
  });

  it("el detalle de la temporada no mezcla singular y plural: todos los días van en plural", () => {
    const { document, nodes } = createFakeDocumentWithIds([...CALENDARIO_IDS_M16]);
    const { renderHorariosYAusencias } = loadUiClientHooks("", document);
    renderHorariosYAusencias({ engineToday: "2026-08-04", engineNowMinutes: 9 * 60, calendar: CAL_DEMO_SALON });
    const detalle = nodes["calendario-temporada-detalle"]?.textContent ?? "";
    expect(detalle).toContain("Sábados 09:00-14:00");
    expect(detalle).toContain("Martes 09:00-17:30");
    expect(detalle).toContain("Cerrado: domingos, lunes.");
    expect(detalle).not.toContain("sábado ");
  });

  it("un segundo sondeo con los mismos datos no reescribe el <pre> del JSON: la selección de texto sobrevive", () => {
    const { document, nodes } = createFakeDocumentWithIds([
      { id: "lab-eventos-pilot", tag: "dl" },
      { id: "lab-eventos-internal", tag: "dl" },
      "lab-auditoria-vacio",
      { id: "lab-auditoria-lista", tag: "ul" },
      { id: "lab-json", tag: "pre" },
    ]);
    const { renderLaboratorio } = loadUiClientHooks("", document);
    const snap = { eventCounts: { pilot: { a: 1 }, internal: { b: 2 } }, calendar: { auditLog: [] } };
    renderLaboratorio(snap);

    // A partir de aquí se cuenta cada ESCRITURA sobre el nodo, que es lo que
    // destruye la selección del navegador; leerlo no destruye nada.
    const pre = nodes["lab-json"];
    let valor = pre?.textContent ?? "";
    let escrituras = 0;
    Object.defineProperty(pre as object, "textContent", {
      get: () => valor,
      set: (v: string) => {
        valor = v;
        escrituras += 1;
      },
      configurable: true,
    });

    renderLaboratorio(snap);
    expect(escrituras, "el sondeo ha reescrito el <pre> sin que el JSON cambiara").toBe(0);

    // Y cuando el contenido SÍ cambia, se escribe: la guarda ahorra trabajo, no lo salta.
    renderLaboratorio({ eventCounts: { pilot: { a: 2 }, internal: { b: 2 } }, calendar: { auditLog: [] } });
    expect(escrituras).toBe(1);
  });
});

// =====================================================================
// SEGUNDA REVISIÓN INDEPENDIENTE (step 15, "PASA CON AVISOS") — siete
// puntos acotados. Cada bloque falla ANTES del arreglo que documenta.
// =====================================================================

function montarLlamadas(hash: string) {
  const { document, nodes } = createFakeDocumentWithIds([...DETALLE_IDS, ...LLAMADAS_IDS, "inicio-ruta-desconocida"]);
  const win = { location: { hash }, scrollTo: () => undefined };
  const hooks = loadUiClientHooks(hash, document, win);
  return { document, nodes, win, hooks };
}

const SNAP_COPIAR = {
  calls: [
    {
      callIdHash: "hash-uno",
      scenarioId: "A01-demo",
      startedAtISO: "2026-08-04T09:10:00.000Z",
      outcome: "RESUELVE",
      internalReasonCode: "BOOKING_CONFIRMED",
      currentState: "FIN",
    },
    {
      callIdHash: "hash-dos",
      scenarioId: "A02-demo",
      startedAtISO: "2026-08-04T09:40:00.000Z",
      outcome: "DERIVA",
      internalReasonCode: "CUSTOMER_REQUESTS_HUMAN",
      currentState: "FIN",
    },
  ],
  humanQueue: { tasks: [] },
  calendar: { professionals: [], reservations: [] },
};

describe("consola · punto 1 — el sondeo no borra la confirmación de 'Copiado'", () => {
  it("un segundo sondeo con la MISMA llamada abierta no borra 'Copiado'", () => {
    const { nodes, hooks } = montarLlamadas("#/llamadas/hash-uno");
    hooks.applyRoute();
    hooks.renderCallDetail(SNAP_COPIAR);
    nodes["llamada-copiar-estado"].textContent = "Copiado";

    // El sondeo de 2s vuelve a llamar a renderCallDetail con los mismos datos.
    hooks.renderCallDetail(SNAP_COPIAR);

    expect(nodes["llamada-copiar-estado"].textContent).toBe("Copiado");
  });

  it("abrir OTRA llamada sí limpia el mensaje: no es un dato de la llamada nueva", () => {
    const { nodes, win, hooks } = montarLlamadas("#/llamadas/hash-uno");
    hooks.applyRoute();
    hooks.renderCallDetail(SNAP_COPIAR);
    nodes["llamada-copiar-estado"].textContent = "Copiado";

    win.location.hash = "#/llamadas/hash-dos";
    hooks.applyRoute();
    hooks.renderCallDetail(SNAP_COPIAR);

    expect(nodes["llamada-copiar-estado"].textContent).toBe("");
  });

  it("cerrar el detalle y volver a abrir LA MISMA llamada también limpia el mensaje (es una vista nueva)", () => {
    const { nodes, win, hooks } = montarLlamadas("#/llamadas/hash-uno");
    hooks.applyRoute();
    hooks.renderCallDetail(SNAP_COPIAR);
    nodes["llamada-copiar-estado"].textContent = "Copiado";

    win.location.hash = "#/llamadas";
    hooks.applyRoute();
    hooks.renderCallDetail(SNAP_COPIAR);
    win.location.hash = "#/llamadas/hash-uno";
    hooks.applyRoute();
    hooks.renderCallDetail(SNAP_COPIAR);

    expect(nodes["llamada-copiar-estado"].textContent).toBe("");
  });
});

describe("consola · punto 2 — arranque en frío: ninguna afirmación sobre el asistente sin datos detrás", () => {
  it("el HTML servido no afirma 'Respondiendo' de entrada: el estado inicial es neutro", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    // "Respondiendo" sólo debe aparecer como valor CALCULADO en ui.js.ts (tras
    // un sondeo con éxito), nunca como texto estático de arranque en el HTML.
    expect(html).not.toContain("Respondiendo");
    expect(html).toContain("Comprobando");
  });

  it("un primer sondeo fallido (sin ningún éxito previo) dice 'Sin conexión con el motor' de inmediato, sin esperar el margen de gracia", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "tx-freshness", tag: "p" }]);
    const { renderFreshness } = loadUiClientHooks("", document);

    renderFreshness(false);

    expect(nodes["tx-freshness"]?.textContent).toBe("Sin conexión con el motor");
    expect(nodes["tx-freshness"]?.classList.contains("tx-freshness--down")).toBe(true);
  });

  it("tras un sondeo con éxito, un fallo posterior SÍ respeta el margen de gracia (no cambia nada de golpe)", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "tx-freshness", tag: "p" }]);
    const { renderFreshness } = loadUiClientHooks("", document);

    renderFreshness(true);
    const textoTrasExito = nodes["tx-freshness"]?.textContent;
    renderFreshness(false);

    // El comportamiento previo a este defecto (con éxito ya registrado) no
    // cambia: un solo fallo dentro del margen de gracia no dice "sin conexión".
    expect(nodes["tx-freshness"]?.textContent).toBe(textoTrasExito);
    expect(nodes["tx-freshness"]?.classList.contains("tx-freshness--down")).toBe(false);
  });
});

describe("consola · revisión adversarial de la capacidad 3, hallazgo B1 — #tx-freshness ya no es una región viva, y la única región de conexión anuncia SÓLO en la transición", () => {
  it("el HTML servido no lleva `role`/`aria-live` en #tx-freshness — se repinta con cada sondeo de 2 s a propósito", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const etiqueta = html.match(/<p class="tx-freshness"[^>]*>/)?.[0] ?? "";
    expect(etiqueta).not.toBe("");
    expect(etiqueta).not.toContain("role=");
    expect(etiqueta).not.toContain("aria-live");
  });

  it("#tx-conexion-anuncio existe en el HTML servido, oculta visualmente, con role=\"status\" y aria-live=\"polite\"", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const etiqueta = html.match(/<p class="tx-visually-hidden" id="tx-conexion-anuncio"[^>]*>/)?.[0] ?? "";
    expect(etiqueta).not.toBe("");
    expect(etiqueta).toContain('role="status"');
    expect(etiqueta).toContain('aria-live="polite"');
  });

  it("varios sondeos con éxito seguidos NO tocan #tx-conexion-anuncio: cero anuncios en reposo", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "tx-freshness", tag: "p" }, { id: "tx-conexion-anuncio", tag: "p" }]);
    const { renderFreshness } = loadUiClientHooks("", document);

    renderFreshness(true);
    renderFreshness(true);
    renderFreshness(true);

    expect(nodes["tx-conexion-anuncio"]?.textContent).toBe("");
  });

  it("la transición ok→caído escribe UNA vez en #tx-conexion-anuncio, y un fallo repetido no la reescribe", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "tx-freshness", tag: "p" }, { id: "tx-conexion-anuncio", tag: "p" }]);
    const { renderFreshness } = loadUiClientHooks("", document);

    renderFreshness(false); // primer sondeo, sin éxito previo: cae de inmediato
    expect(nodes["tx-conexion-anuncio"]?.textContent).toBe("Sin conexión con el motor. Lo que ves puede estar desactualizado.");

    nodes["tx-conexion-anuncio"]!.textContent = "";
    renderFreshness(false); // sigue caído: no es una transición nueva
    expect(nodes["tx-conexion-anuncio"]?.textContent).toBe("");
  });

  it("la transición caído→ok escribe 'Conexión recuperada.' en #tx-conexion-anuncio", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "tx-freshness", tag: "p" }, { id: "tx-conexion-anuncio", tag: "p" }]);
    const { renderFreshness } = loadUiClientHooks("", document);

    renderFreshness(false);
    nodes["tx-conexion-anuncio"]!.textContent = "";
    renderFreshness(true);

    expect(nodes["tx-conexion-anuncio"]?.textContent).toBe("Conexión recuperada.");
  });
});

describe("consola · punto 3 — Llamadas › Detalle técnico no desborda con una cadena irrompible", () => {
  it("el <dd> del detalle técnico puede partirse: no fija un ancho mínimo por el hash de 64 caracteres", () => {
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    const idx = css.indexOf(".tx-details__body dd");
    expect(idx, "no existe una regla específica para .tx-details__body dd").toBeGreaterThan(-1);
    const regla = css.slice(idx, css.indexOf("}", idx) + 1);
    // min-width: 0 permite que el elemento de la rejilla se encoja por debajo
    // de su contenido; overflow-wrap: anywhere permite partir el hash aunque
    // no tenga ningún espacio ni guion donde hacerlo.
    expect(regla).toContain("min-width: 0");
    expect(regla).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("(step 16, C9) el <pre> del detalle técnico también puede partirse: word-break, no un ancho fijo que desborde", () => {
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    const idx = css.indexOf(".tx-details__body pre");
    expect(idx, "no existe una regla específica para .tx-details__body pre").toBeGreaterThan(-1);
    const regla = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(regla).toMatch(/word-break:\s*break-word/);
  });
});

describe("consola · punto 4 — salir de Llamadas con el detalle abierto deja el panel coherente", () => {
  it("navegar a otra sección esconde '#llamada-detalle' de verdad (hidden=true), no sólo visualmente por la sección", () => {
    const { nodes, win, hooks } = montarLlamadas("#/llamadas/hash-uno");
    hooks.applyRoute();
    hooks.renderCallDetail(SNAP_COPIAR);
    expect(nodes["llamada-detalle"]?.hidden).toBe(false);

    win.location.hash = "#/agenda";
    hooks.applyRoute();

    expect(nodes["llamada-detalle"]?.hidden).toBe(true);
  });
});

describe("consola · punto 5 — restos muertos", () => {
  it("'#contenido', el destino del enlace de salto, lleva tabindex=\"-1\": saltar al contenido mueve el foco de verdad", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const tag = /<main[^>]*id="contenido"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag, "no se ha encontrado <main id=\"contenido\">").not.toBe("");
    expect(tag).toMatch(/\stabindex="-1"/);
  });
});

describe("consola · punto 7 — el glifo de marca expone su aria-label de forma fiable", () => {
  it("el <span> del glifo TX lleva role=\"img\" junto a su aria-label", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const tag = /<span class="tx-brand__glyph"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag, "no se ha encontrado el <span> del glifo de marca").not.toBe("");
    expect(tag).toContain('role="img"');
    expect(tag).toContain('aria-label="Demo Salon"');
  });
});

describe("consola · DESIGN_SPEC.md (step 16, D1) — el control eliminado no ha vuelto a la especificación", () => {
  const spec = readFileSync(join(process.cwd(), "docs/operator_console/DESIGN_SPEC.md"), "utf8");

  it("no menciona 'Duplicar para 2027' en ninguna de sus formas", () => {
    expect(spec).not.toContain("Duplicar para 2027");
  });

  it("deja constancia de cada corrección con su nota de procedencia", () => {
    const apariciones = spec.match(/Corregido en step 16/g) ?? [];
    expect(apariciones.length).toBeGreaterThanOrEqual(3);
  });
});

describe("consola · DESIGN_SPEC.md (reparación adversarial step 16, 2ª ronda, F1) — la especificación no puede volver a desviarse del CSS/HTML real sin que una prueba caiga", () => {
  const spec = readFileSync(join(process.cwd(), "docs/operator_console/DESIGN_SPEC.md"), "utf8");
  const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");

  it("el max-width que la spec documenta para '.tx-brand__plate' coincide con el que declara ui.css.ts (comprobación mecánica, no de memoria)", () => {
    const cssBlock = /\.tx-brand__plate\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(cssBlock, "no se ha encontrado la regla .tx-brand__plate en ui.css.ts").not.toBe("");
    const cssMaxWidth = /max-width:\s*(\d+px)/.exec(cssBlock)?.[1];
    expect(cssMaxWidth, "la regla .tx-brand__plate no declara max-width").toBeDefined();
    expect(spec).toContain(`max-width: ${cssMaxWidth}`);
  });

  it("no contiene la línea de identidad del panel de contexto de Inicio que la FASE 3A borró del HTML", () => {
    expect(spec).not.toContain("Demo Salon Barbershop · Consola de operación");
  });

  it("no contiene el texto de la tarjeta vacía de 'días distintos' que la FASE 3A eliminó de Inicio", () => {
    expect(spec).not.toContain("Nada distinto por delante.");
  });

  it("no contiene la etiqueta larga de capacidades que la FASE 3B renombró a 'Puede hacer' en la ficha de Equipo", () => {
    expect(spec).not.toContain("Servicios que puede hacer");
  });
});

/**
 * step 26 REAPERTURA §R9 — ESTE BLOQUE SE INVIERTE, A PROPÓSITO.
 *
 * Hasta el 12 de agosto de 2026 aquí se comprobaba lo contrario: que la
 * apertura especial NO se ofrecía, y que el diálogo lo decía en pantalla. La
 * decisión O1 de step 16 era correcta con lo que se sabía entonces (el
 * modelo no podía decir quién trabaja una apertura, y darla por hecha para
 * todo el equipo habría sido inventar disponibilidad). Lo que ha cambiado no
 * es el modelo: es que ahora la interfaz lo DICE en vez de esconderlo — «el
 * horario especial vale para todo el equipo; esta pantalla no puede decir
 * quién trabaja esa apertura y quién no; para eso están las ausencias» — y
 * que la capacidad se puede DESHACER (§R13). Con esas dos cosas, ocultarla
 * dejó de ser lo honesto y pasó a ser una laguna.
 *
 * Se conserva el caso como CANDADO invertido, no se borra: si alguien
 * volviera a esconder la apertura especial, esto lo diría.
 */
describe("consola · REAPERTURA §R9 — la apertura especial SÍ se ofrece, y con sus dos avisos", () => {
  it("el diálogo vuelve a tener el radio de tipo, y esta vez con las dos opciones", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(html).toContain('name="dia-especial-tipo"');
    expect(html).toContain('id="dia-especial-tipo-cierre"');
    expect(html).toContain('id="dia-especial-tipo-especial"');
    expect(html).toContain("Cerrado todo el día");
    expect(html).toContain("Horario especial");
  });

  it("el texto que decía que la apertura especial no se hacía desde aquí ha desaparecido", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(html).not.toContain("Abrir el local con un horario distinto todavía no se hace");
    expect(html).not.toContain("inventar disponibilidad que nadie ha confirmado");
  });

  it("lo que SÍ sigue siendo verdad se dice con palabras, no con un campo apagado", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const idx = html.indexOf('id="dialogo-dia-especial"');
    const cuerpo = html.slice(idx, html.indexOf("</dialog>", idx));
    expect(cuerpo).toContain("El horario especial vale para todo el equipo.");
    expect(cuerpo).toContain("Un horario especial vale para un solo día.");
    // Y el cierre del local sigue ofreciéndose, con su frase de siempre.
    expect(cuerpo).toContain("deja el local sin abrir esos días");
  });

  it("el cliente sí lee ahora el radio de tipo, porque hay dos caminos que distinguir", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    expect(js).toContain("dia-especial-tipo-cierre");
    expect(js).toContain("dia-especial-tipo-especial");
    expect(js).toContain("special_opening");
  });
});

// ---------------------------------------------------------------------
// step 18 §5.1 / §5.7 — lo estructural de la interfaz nueva, comprobable
// sin navegador: la navegación NO crece, las regiones nuevas heredan el
// ciclo de vida de las líneas de estado, y las filas de personas se apilan
// por debajo de 720px en vez de desbordar a lo ancho.
// ---------------------------------------------------------------------

describe("consola · step 18 §5.1 — ninguna ruta nueva: todo vive en Agenda, Inicio y Laboratorio", () => {
  const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
  const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");

  it("la barra lateral sigue teniendo exactamente siete destinos, los mismos de step 17", () => {
    const rutas = [...html.matchAll(/data-route="([a-z-]+)"/g)].map((m) => m[1]);
    expect(rutas).toEqual(["inicio", "agenda", "lista-espera", "llamadas", "horarios-y-ausencias", "equipo", "laboratorio"]);
  });

  it("ROUTE_TITLES tampoco crece: el enrutador conoce esas siete y ninguna más", () => {
    const idx = js.indexOf("var ROUTE_TITLES = {");
    expect(idx).toBeGreaterThan(-1);
    const cuerpo = js.slice(idx, js.indexOf("};", idx));
    const claves = [...cuerpo.matchAll(/^\s{4}'?([a-z-]+)'?:/gm)].map((m) => m[1]);
    expect(claves.length).toBe(7);
    for (const nueva of ["inasistencias", "grupos", "reservas-varias"]) {
      expect(cuerpo.includes(nueva), `'${nueva}' se ha colado como ruta nueva`).toBe(false);
    }
  });

  it("las dos funciones nuevas entran por donde dice el diseño: un botón en Agenda y dos paneles en Laboratorio", () => {
    const agenda = html.slice(html.indexOf('id="vista-agenda"'), html.indexOf('id="vista-lista-espera"'));
    expect(agenda).toContain('id="btn-abrir-grupo"');
    expect(agenda).toContain("Nueva reserva para varias personas");
    const laboratorio = html.slice(html.indexOf('id="vista-laboratorio"'), html.indexOf("</main>"));
    expect(laboratorio).toContain('id="lab-reloj-avanzar"');
    expect(laboratorio).toContain('id="lab-grupo-consecutivas"');
    expect(laboratorio).toContain('id="lab-operaciones-lista"');
  });
});

describe("consola · step 18 §5.7 — las regiones nuevas heredan el ciclo de vida, y el paso 1 se apila a 690px", () => {
  const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
  const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");

  it("las seis líneas de estado nuevas llevan la clase .tx-status-line, así que las alcanza la regla de [hidden]", () => {
    for (const id of [
      "inasistencia-estado",
      "corregir-inasistencia-estado",
      "grupo-estado",
      "grupo-error",
      "lab-reloj-estado",
      "lab-grupo-estado",
    ]) {
      const tag = new RegExp(`<p[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
      expect(tag, `no existe la línea de estado ${id}`).not.toBe("");
      expect(tag, `${id} no es una .tx-status-line`).toContain("tx-status-line");
      expect(tag, `${id} no es una región viva`).toMatch(/role="(status|alert)"/);
    }
  });

  it("y NINGUNA de las seis necesita la excepción de display:none: su caja se puede reservar sin dejar hueco en blanco", () => {
    const idx = css.indexOf(".tx-status-line[hidden]");
    expect(idx).toBeGreaterThan(-1);
    const excepcion = css.slice(idx, css.indexOf("}", css.indexOf("display: none !important", idx)));
    for (const id of ["inasistencia-estado", "grupo-estado", "grupo-error", "lab-reloj-estado", "lab-grupo-estado"]) {
      expect(excepcion.includes(`#${id}[hidden]`), `${id} se ha añadido a la excepción sin justificarlo`).toBe(false);
    }
    // Las tres excepciones siguen siendo las tres de la fase D, ni una más.
    expect(excepcion).toContain("#inicio-ruta-desconocida[hidden]");
    expect(excepcion).toContain("#lista-espera-cargando[hidden]");
    expect(excepcion).toContain("#estado-global[hidden]");
  });

  it("por debajo de 720px cada persona pasa a ser una ficha con rótulo, con sus campos en dos columnas (step 19 D2, declarado)", () => {
    // (Enmendado step 19 D2, declarado en §10.1.1.) La regla
    // `.tx-group-row { flex-direction: column; align-items: stretch; }`
    // DESAPARECE: la fila ya no es un contenedor flex, y su apilado lo hace
    // `.tx-group-row__fields` en dos columnas — la técnica de fichas con
    // rótulo que step 18 §5.7 prometió y nunca implementó.
    const bloque720 = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(bloque720).not.toContain(".tx-group-row { flex-direction: column; align-items: stretch; }");
    expect(bloque720).toMatch(/\.tx-group-row\s*\{[^}]*border:\s*var\(--tx-border-hairline\)[^}]*border-radius:\s*var\(--tx-radius-md\)[^}]*padding:\s*var\(--tx-space-3\)[^}]*\}/);
    expect(bloque720).toMatch(/\.tx-group-row__fields\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*\}/);
    // Y no se esconde nada para que "quepa": el paso 1 sigue completo.
    expect(bloque720).not.toMatch(/\.tx-group-row[^{]*\{[^}]*display:\s*none/);
    expect(bloque720).not.toMatch(/\.tx-proposal__lines[^{]*\{[^}]*display:\s*none/);
  });

  it("el diálogo de cuatro pasos sigue acotado por la ventana: no puede desbordar a lo ancho", () => {
    const idx = css.indexOf(".tx-dialog {");
    const cuerpo = css.slice(idx, css.indexOf("}", idx));
    expect(cuerpo).toContain("width: calc(100vw");
    // El más ancho de los diálogos sólo sube el máximo, nunca el mínimo.
    expect(css).toContain(".tx-dialog--wide { max-width: 880px; }");
  });

  it("el reloj sintético de la barra superior tiene estilo propio y usa tokens del sistema, no un color suelto", () => {
    const idx = css.indexOf(".tx-synthetic-clock {");
    expect(idx).toBeGreaterThan(-1);
    const cuerpo = css.slice(idx, css.indexOf("}", idx));
    // (step 21A, corte 1) El token sigue siendo el mismo COLOR y el mismo
    // valor: `--tx-action` es el alias semántico que apunta a
    // `--tx-copper-700` (§2.1 del diseño). Lo que esta prueba defiende no es
    // el nombre crudo, es que el reloj no se pinte con un hex suelto — y esa
    // aserción, la de abajo, no se toca.
    expect(cuerpo).toContain("var(--tx-action)");
    expect(cuerpo).not.toMatch(/#[0-9A-Fa-f]{3,6}/);
    // Y el alias existe de verdad y apunta al cobre de siempre: si alguien lo
    // repunta a otro color, esto cae aquí y no en una revisión visual.
    expect(css).toContain("--tx-action:              var(--tx-copper-700);");
  });
});
