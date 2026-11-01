import { renderConsoleAppJs } from "../../src/console/ui.js.js";

/**
 * step 14 · cierre de huecos de cobertura — técnica de extracción para
 * probar la lógica PURA del cliente (`ui.js.ts`) sin un navegador de verdad.
 *
 * Esta misión prohíbe instalar puppeteer/playwright/chromium y desaconseja
 * jsdom/happy-dom sin una justificación fuerte. No hay una: la mayoría de la
 * lógica que hace falta comprobar (enrutado por hash, `resolveVenueDay`,
 * `collectDistinctDays`, el vocabulario de estado, la rejilla del mes) es
 * JAVASCRIPT PURO — no toca el DOM salvo para leer `window.location.hash` en
 * un caso. Instalar un DOM completo para ejecutar cuatro funciones puras
 * sería una dependencia nueva para probar código que no la necesita.
 *
 * La técnica: se toma el TEXTO EXACTO que `renderConsoleAppJs()` sirve por
 * `GET /app.js` (el mismo que un navegador real ejecutaría) y se le añade,
 * justo ANTES del cierre de su propia IIFE, una línea que copia las
 * referencias de las funciones internas que hacen falta a un objeto que
 * cuelga de `window`. No se modifica ni una sola línea de la lógica
 * original: sólo se EXPONE lo que ya existe, exactamente como está escrito,
 * para poder invocarlo desde una prueba. Si `ui.js.ts` cambiara el nombre de
 * una de estas funciones o dejara de declararla en el ámbito superior de la
 * IIFE, esta extracción fallaría con un error claro (variable no definida),
 * nunca en silencio.
 */

const HOOK_NAMES = [
  "parseHash",
  "resolveVenueDay",
  "collectDistinctDays",
  "statusFor",
  "STATUS_VOCAB",
  "monthMatrix",
  "absencesOn",
  "dateInRange",
  "laboratorioSummaryLines",
  "activeSeasonalOverride",
  "callAttentionEntry",
  "renderEquipo",
  "renderLlamadas",
  "renderCallDetail",
  "renderHorariosYAusencias",
  // (revisión step 15)
  "venueWeekdayHours",
  "renderInicio",
  "renderAgenda",
  "applyRoute",
  // (V3-7) El manejador REAL de `hashchange` —el que primero recoge la mesa y
  // luego pinta— y la recogida en sí. Sin ellos no se puede afirmar, sin
  // navegador, que un diálogo abierto no sobrevive a un cambio de ruta.
  "alCambiarElHash",
  "cerrarDialogosAbiertos",
  "closeCallDetail",
  "updateImpactCounter",
  "renderLaboratorio",
  // (revisión step 15, punto 2)
  "renderFreshness",
  // (step 16, O3) La reconciliación por clave y su guarda de foco, hasta
  // ahora sólo probadas indirectamente a través de las pantallas que las
  // llaman.
  "reconcileList",
  "holdsFocus",
  // (step 17, fase D) La pantalla de lista de espera y las piezas que sus
  // criterios de aceptación (20-24 del §12) exigen comprobar sin navegador.
  "renderListaEspera",
  "refresh",
  "ESTADOS_POR_GRUPO",
  "COMANDO_ETIQUETAS",
  "textoDeFallo",
  "abrirDialogo",
  "wireFocoDialogo",
  "abrirDialogoSimularAviso",
  "abrirDialogoConvertir",
  "abrirDialogoCancelarCita",
  "fraseDePlazoPrevisto",
  "mostrarResultadoCancelacion",
  "enlaceDeTarea",
  // (step 18, fase D) El ciclo de vida de las líneas de estado y la
  // secuencia de reinicio accesible del §1.3, que no se puede alcanzar de
  // otro modo: el manejador del botón vive dentro de `wireLaboratorioControls`
  // y sólo se engancha en `DOMContentLoaded`.
  "setEstadoLinea",
  "limpiarLinea",
  "limpiarEstadosTransitorios",
  "REGIONES_TRANSITORIAS",
  "TONO_BASE",
  "abrirDialogoReset",
  "confirmarReinicio",
  // (step 18, fase G) La interfaz de operador de las dos funciones nuevas.
  // Todo lo de aquí abajo se engancha en `DOMContentLoaded` dentro de una
  // función de cableado, así que no hay otra forma de alcanzarlo sin
  // navegador.
  "renderRelojSintetico",
  "abrirDialogoInasistencia",
  "confirmarInasistencia",
  "abrirDialogoCorregirInasistencia",
  "confirmarCorregirInasistencia",
  "textoDeFalloInasistencia",
  "abrirDialogoGrupo",
  "irAPasoGrupo",
  "actualizarPuertaGrupo",
  "buscarPropuestasDeGrupo",
  "renderPropuestasDeGrupo",
  "confirmarGrupo",
  "textoDeConflictoDeGrupo",
  "ETIQUETAS_GRUPO",
  "renderPanelDelReloj",
  "avanzarElReloj",
  "renderHistorialDeOperaciones",
  "lanzarEjemploDeGrupo",
  "prepararConflictoDeGrupo",
  "ocuparElHuecoDeLaPropuesta",
  "wireInasistenciaDialog",
  "wireCorregirInasistenciaDialog",
  "wireGrupoDialog",
  "wireRelojLabControls",
  // (step 19 Capacidad 1) El explorador de huecos sintéticos, en Agenda. El
  // botón vive dentro de `wireHuecosControls`, que sólo se engancha en
  // `DOMContentLoaded`, así que no hay otra forma de alcanzarlo sin
  // navegador.
  "wireHuecosControls",
  "comprobarHuecos",
  "limpiarExploradorHuecos",
  "actualizarPuertaHuecos",
  // (step 23, rebanada C) El bloque de propuestas de Inicio y el panel de
  // actividad operativa, con su guarda de anuncio: viven dentro de
  // `renderInicio`, así que sin esto no hay forma de probarlos por separado.
  "renderPropuestasAtencion",
  "renderActividadOperativa",
  "razonParaNoAvisar",
  // (Reparación R2-UX, defecto 1) El filtro que CIERRA el vocabulario de la
  // columna «Qué puedes hacer». Se expone porque su contrato —un comando sin
  // nombre en castellano no se pinta, jamás con su identificador crudo— hay
  // que poder comprobarlo directamente y no sólo a través de las entradas que
  // el fixture de hoy produzca.
  "accionesHumanasDe",
  "COMANDOS_DE_HUECO",
  // (M19-MAC-D1) La tarjeta de una propuesta de hueco, con su detalle
  // técnico plegable. Sólo se alcanza desde `comprobarHuecos`, así que no
  // hay otra forma de comprobar en aislamiento a qué nodo va cada línea.
  "buildHuecoResultCard",
  // (step 19 Capacidad 2) El historial de tareas humanas del Laboratorio.
  // \`wireTareasHumanasControls\` sólo se engancha en \`DOMContentLoaded\`, así
  // que no hay otra forma de alcanzarlo sin navegador.
  "renderHistorialDeTareas",
  "filtrarHistorialDeTareas",
  "motivosDeHistorialDeTareas",
  "textoEnlaceTareaPendiente",
  "wireTareasHumanasControls",
  // (step 19 Capacidad 3) El resumen para Bruno (3A) y el guion en pantalla
  // (3B). Los dos botones de control se enganchan en `DOMContentLoaded`
  // dentro de sus propias funciones de cableado, así que no hay otra forma
  // de alcanzarlos sin navegador.
  "renderResumenOwner",
  "wireResumenOwnerControls",
  "limpiarRespaldoDeCopiaDelResumen",
  "esMedidaDeReservas",
  "renderGuionEnPantalla",
  "wireGuionEnPantallaControls",
  "buildFilaGuionPaso",
  // (step 20 §3) El taller de decisiones con Bruno. Los controles estáticos
  // se enganchan en `DOMContentLoaded` dentro de `wireTallerControls`, así
  // que no hay otra forma de alcanzarlos sin navegador; el pintado y el
  // normalizador se exponen para las pruebas de §9.3.
  "renderTallerDecisiones",
  "wireTallerControls",
  "normalizarBusqueda",
  "aplicarFiltroDelTaller",
  // (step 20 fase 7, §4/§5) Los dos generadores de exportación y el saneado
  // de notas son funciones PURAS de (vista, borrador) — se exponen para las
  // pruebas de gramática del §9.4 y de inyección del §9.5, que no necesitan
  // DOM. La limpieza de respaldos se alcanza también desde la secuencia de
  // reinicio, pero se expone para probarla en aislamiento.
  "sanearNotaDelTaller",
  "componerActaDelTaller",
  "componerBorradorDeMisionDelTaller",
  "limpiarRespaldosDelTaller",
  // (Revisión adversarial de step 22, N5) El poblador del desplegable de
  // profesionales: se expone para poder comprobar en aislamiento su guarda de
  // foco, que es justo lo que le faltaba respecto de su hermana
  // `ensureMotivoOptions`.
  "ensureProfessionalOptions",
  // (Revisión adversarial A9-5) La referencia VIVA al borrador en memoria:
  // la única forma de inyectar por código una nota de más de 280 caracteres
  // (el oninput real recorta a 280, D20-49.2) y comprobar que el manejador
  // de click sobrevive a la aserción de exportación con su línea de estado.
  // Es la referencia inicial del módulo: sólo el borrado total la reasigna.
  "tallerBorrador",

  // (step 26) Agenda multivista (Día · Semana · Mes · Lista). El
  // despachador (`renderAgenda`) ya estaba expuesto; el resto son las
  // piezas que las pruebas discriminantes de la Capacidad A necesitan
  // comprobar en aislamiento, sin tener que montar el hash completo cada
  // vez.
  "renderAgendaDia",
  "renderAgendaSemanaProfesional",
  "renderAgendaSemanaResumen",
  "renderAgendaMes",
  "renderAgendaLista",
  "agendaTituloRango",
  "agendaFiltroEfectivo",
  "agendaFechaEfectiva",
  "agendaFechaTrasPaso",
  "agendaHrefPara",
  "navegarAgenda",
  "mondayOfWeek",
  "capitalizarInicial",
  "resolveAgendaDayAxis",
  "agendaEjeSemana",
  "agendaHuecosDeColumna",
  // (V1-4/V1-5) La ventana REAL del local ese día y las zonas del eje que no
  // son horas de atender: sin ellas no se puede afirmar, sin navegador, que la
  // Agenda no ofrece «Crear cita manual» en horas cerradas.
  "agendaVentanaDelDia",
  "agendaZonasCerradasDeColumna",
  "agendaAusenciasDeColumna",
  "agendaItemsParaColumna",
  "agendaIdentidadClase",
  // (V2-4) La clase de rejilla por número de columnas: la que escribía
  // `--cols-5`/`--cols-6` sin que esas reglas existieran.
  "agendaClaseColumnas",
  "agendaLineasBloque",
  "agendaPersonaLabel",
  "agendaNombreAccesibleBloque",
  "agendaNombreAccesibleHueco",
  "abrirDialogoCitaDetalle",
  "pintarAccionesCitaDetalle",
  "wireCitaDetalleDialog",
  "abrirCitaManualDesdeHueco",
  "abrirDialogoCitaManual",
  // Referencia VIVA de \`manualState\`: \`manualReset\` REASIGNA la variable
  // (nunca la muta), así que sólo un accesor leído en el momento de
  // comprobar refleja la precarga de un hueco (step 26 §6.6, A8).
  "manualStateActual",
  // (Reparación adversarial step 26, hallazgo 5 — a petición de B-UI) El
  // cableado del diálogo "Crear cita manual" (los cinco pasos, el control
  // Duración y sus radios/select incluidos) sólo se engancha una vez en
  // DOMContentLoaded; sin este gancho no hay forma de probarlo sin
  // navegador. A no escribe las pruebas dinámicas del control Duración
  // (son de citaManualUi.test.ts, de B-UI): esto sólo deja el gancho listo.
  "wireCitaManualDialog",

  // (step 26 REAPERTURA, Oleada B4) Los tres diálogos de calendario —
  // cierres/días especiales (R9), ausencias (R10) y detalle/retirada/cambio
  // (R13)— se cablean en `DOMContentLoaded`, así que sin estos ganchos no hay
  // forma de recorrer sus cuatro pasos sin navegador. `pintarSemanaDelLocal`
  // es la función compartida de R12/§4 (una implementación, dos pantallas).
  "pintarSemanaDelLocal",
  "wireHorariosYAusenciasControls",
  "openDiaEspecialDialog",
  "wireDiaEspecialDialog",
  "diaEspecialGoToImpact",
  "diaEspecialPublish",
  "openAusenciaDialog",
  "wireAusenciaDialog",
  "ausenciaGoToImpact",
  "ausenciaPublish",
  "openExcepcionDialog",
  "wireExcepcionDialog",
  "excepcionPreview",
  "excepcionPublish",
  "fraseDeCambio",
] as const;

export type UiTestHooks = {
  parseHash: () => { section: string; param?: string; params: string[]; unknown?: boolean };
  resolveVenueDay: (
    iso: string,
    cal: unknown,
  ) => { open: boolean; start?: string; end?: string; reasonLabel?: string; isHoliday?: boolean; isSpecial?: boolean; isSeasonal?: boolean };
  collectDistinctDays: (
    cal: unknown,
    fromDateISO: string,
    untilMonth: { year: number; month: number } | null,
  ) => Array<{ key: string; start: string; end: string; title: string; detail: string }>;
  statusFor: (call: unknown) => { label: string; modifier: string; glyph: string } | null;
  STATUS_VOCAB: Record<string, { label: string; modifier: string; glyph: string }>;
  monthMatrix: (year: number, month1based: number) => Array<Array<string | null>>;
  absencesOn: (cal: unknown, iso: string) => Array<Record<string, unknown>>;
  dateInRange: (iso: string, start: string, end: string) => boolean;
  laboratorioSummaryLines: (json: {
    outcome: string;
    reasonCode: string;
    internalReasonCode?: string;
    announcesSuccess: boolean;
    finalState: string;
  }) => string[];
  activeSeasonalOverride: (cal: unknown, todayISO: string) => Record<string, unknown> | null;
  /**
   * (step 14 repair, defecto A) La MISMA regla de "necesita atención" que
   * pinta las tarjetas de Inicio — ver el docblock junto a su definición en
   * `ui.js.ts`. `snap` sólo hace falta para el caso `TECHNICAL_FAILURE`
   * (busca una tarea `REVIEW_ORPHANED_SYNTHETIC_RESERVATION`).
   */
  callAttentionEntry: (call: unknown, snap: unknown) => { tier: number; modifier: string; title: string; orphanTask?: unknown } | null;
  /** (step 14 repair, defecto C) Pinta la sección Equipo completa contra el `document` que se le pase — ver `fakeDom.ts`. */
  renderEquipo: (snap: unknown) => void;
  /** (step 15) Pinta la tabla de Llamadas — se usa para comprobar que un segundo sondeo no roba el foco. */
  renderLlamadas: (snap: unknown) => void;
  /** (step 15) Pinta (o esconde) el panel de detalle de una llamada, con su traspaso de foco al ocultarse. */
  renderCallDetail: (snap: unknown) => void;
  /**
   * (step 15) Pinta la vista que hoy se llama «Horarios y ausencias» — se
   * usa para comprobar que no asoma vocabulario interno. Se llamaba
   * `renderCalendario` hasta step 26 REAPERTURA §R7; NO se deja alias
   * porque no queda ninguna prueba que llame al nombre viejo (la deuda D-4
   * del normativo se evita en vez de heredarse).
   */
  renderHorariosYAusencias: (snap: unknown) => void;
  /**
   * (revisión step 15, B1) El ÚNICO sitio del cliente que decide qué horas
   * rigen un día de la semana. `resolveVenueDay()` cuelga de ella, y la ficha
   * de Equipo la usa directamente: por eso las tres pantallas ya no pueden
   * discrepar.
   */
  venueWeekdayHours: (
    cal: unknown,
    dow: number,
    onDateISO: string,
  ) => { open: boolean; start?: string; end?: string; reasonLabel?: string; isSeasonal?: boolean };
  /** (revisión step 15, B2/D1) Pinta la vista Inicio completa. */
  renderInicio: (snap: unknown) => void;
  /** (revisión step 15, B1/D7) Pinta la vista Agenda completa. */
  renderAgenda: (snap: unknown) => void;
  /** (revisión step 15, D3) El enrutador. Lee `window.location.hash` y mueve el foco. */
  applyRoute: () => void;
  /** El manejador de `hashchange`: cierra los diálogos abiertos y después pinta la ruta. */
  alCambiarElHash: () => void;
  /** Cierra todo `<dialog open>` sin devolver el foco a su disparador. */
  cerrarDialogosAbiertos: () => void;
  /** (revisión step 15, D4) Cierra el detalle de una llamada sin tocar el historial. */
  closeCallDetail: () => void;
  /** (revisión step 15, D6) Habilita o deshabilita DE VERDAD el botón de publicar. */
  updateImpactCounter: (
    counterEl: unknown,
    saveBtn: unknown,
    impacted: ReadonlyArray<{ reservationId: string }>,
    resolutions: Record<string, string>,
  ) => void;
  /** (revisión step 15) Pinta Laboratorio — se usa para comprobar que el <pre> no se reescribe sin motivo. */
  renderLaboratorio: (snap: unknown) => void;
  /**
   * (revisión step 15, punto 2) Escribe el estado de "#tx-freshness". Se usa
   * para comprobar que un primer sondeo fallido (sin ningún éxito previo) lo
   * dice de inmediato, sin esperar el margen de gracia de DOWN_AFTER_MS.
   */
  renderFreshness: (ok: boolean) => void;
  /** (step 16, O3) La reconciliación por clave. Se prueba en aislamiento por primera vez. */
  reconcileList: (
    container: unknown,
    items: readonly unknown[],
    keyOf: (item: unknown, i: number) => string | number,
    buildRow: (item: unknown, existing: unknown, i: number) => unknown,
  ) => void;
  /** (step 16, O3) La guarda de foco compartida por reconcileList y los repintados. */
  holdsFocus: (node: unknown) => boolean;
  /** (step 17) Pinta la pantalla de lista de espera entera desde `snap.waitlist`. */
  renderListaEspera: (snap: unknown) => void;
  /**
   * (step 17) El sondeo REAL: pide `/api/snapshot`, guarda la instantánea y
   * repinta la sección activa. Se expone para poder probar contra el mismo
   * camino que recorre el navegador —y no contra un atajo— lo que depende de
   * que la consola tenga una instantánea guardada.
   */
  refresh: () => Promise<void>;
  /**
   * (Revisión adversarial de step 22, N5) Rellena un `<select>` de
   * profesionales sólo cuando el conjunto ha cambiado, y NUNCA mientras
   * alguien lo tiene enfocado.
   */
  ensureProfessionalOptions: (
    selectEl: unknown,
    professionals: readonly { employeeId: number; label: string }[],
    includeAllLabel: string,
  ) => void;
  /** (step 17) Los tres grupos del filtro de estados — la tabla de §2.1 del diseño. */
  ESTADOS_POR_GRUPO: Record<string, readonly string[]>;
  /** (step 17) El nombre en castellano de cada comando que el servidor autoriza. */
  COMANDO_ETIQUETAS: Record<string, string>;
  /** (step 17) Traduce una respuesta fallida a una frase de operador; el 409 tiene la suya. */
  textoDeFallo: (r: { status: number; json: Record<string, unknown> }) => string;
  /** (step 17) Abre un `<dialog>`, recuerda quién lo abrió y lleva el foco a su título. */
  abrirDialogo: (dialogId: string, tituloId: string, disparador: unknown) => void;
  /** (step 17) Engancha la devolución de foco al evento `close` del propio `<dialog>`. */
  wireFocoDialogo: (dialogId: string) => void;
  abrirDialogoSimularAviso: (entry: unknown, slotLabel: string, destinoId: string, disparador: unknown) => void;
  abrirDialogoConvertir: (entry: unknown, disparador: unknown) => void;
  abrirDialogoCancelarCita: (reserva: unknown, disparador: unknown) => void;
  /** (step 17) La frase de plazo PREVISTO del paso 1 de cancelar una cita (§9.4.1). */
  fraseDePlazoPrevisto: (snap: unknown, reserva: unknown) => string;
  /** (step 17) Pinta el paso 2 de cancelar una cita: plazo, huecos liberados, compatibles y tareas. */
  mostrarResultadoCancelacion: (reserva: unknown, r: { repetida: boolean; json: Record<string, unknown> }) => void;
  /** (step 17) A dónde lleva el "Ver" de una tarea de la cola humana. */
  enlaceDeTarea: (task: unknown) => string;
  /** (step 18 §1.2.2) El ÚNICO sitio que escribe una línea de estado: texto, tono y `hidden`. */
  setEstadoLinea: (node: unknown, texto: string, tono: string) => void;
  /** (step 18 §1.2.2) Limpieza silenciosa: oculta, vacía y restituye el tono estático. */
  limpiarLinea: (node: unknown) => void;
  /** (step 18 §1.2.2) Pasa `limpiarLinea` por las 19 regiones transitorias. */
  limpiarEstadosTransitorios: () => void;
  /** (step 18 §1.1) La lista LITERAL de regiones que borra un reinicio. */
  REGIONES_TRANSITORIAS: readonly string[];
  /** (step 18 §1.2.2) El tono que cada región trae ESTÁTICO desde el HTML. */
  TONO_BASE: Record<string, string>;
  /** (step 18 §1.4) Abre el diálogo de reinicio limpiando su línea de estado. */
  abrirDialogoReset: () => void;
  /** (step 18 §1.3) La secuencia entera del reinicio. Devuelve una promesa que se puede esperar. */
  confirmarReinicio: () => Promise<void>;
  /** (step 18 §3.6) El reloj SINTÉTICO de la barra superior, rotulado y sin aria-live. */
  renderRelojSintetico: (snap: unknown) => void;
  /** (step 18 §5.3) Abre el diálogo de anotar una inasistencia sobre una cita de la instantánea. */
  abrirDialogoInasistencia: (reserva: unknown, disparador: unknown) => void;
  /** (step 18 §5.3) Confirma la anotación. Devuelve la promesa de la secuencia entera. */
  confirmarInasistencia: () => Promise<void> | undefined;
  /** (step 18 §5.3) Abre el diálogo de corregir un registro. */
  abrirDialogoCorregirInasistencia: (reserva: unknown, disparador: unknown) => void;
  /** (step 18 §5.3) Confirma la corrección. */
  confirmarCorregirInasistencia: () => Promise<void> | undefined;
  /** (step 18 §2.11) El texto que ve el operador cuando una acción de inasistencia NO se ha hecho. */
  textoDeFalloInasistencia: (r: { status: number; json: Record<string, unknown> }) => string;
  /** (step 18 §5.4) Abre el diálogo de grupo, opcionalmente con un ejemplo cargado y en un paso concreto. */
  abrirDialogoGrupo: (
    disparador: unknown,
    semilla: {
      forma?: string | null;
      fecha?: string;
      filas?: Array<{ etiqueta: string; servicio: string; profesional: string }>;
      paso?: number;
    } | null,
  ) => void;
  /** (step 18 §5.4) Cambia de paso, construye el resumen si toca y mueve el foco al encabezado nuevo. */
  irAPasoGrupo: (n: number) => void;
  /** (step 18 §5.4) Recalcula qué botones pueden estar habilitados y por qué. */
  actualizarPuertaGrupo: () => void;
  /** (step 18 §5.4) Pide las propuestas a la ruta REAL. Es una consulta: no escribe nada. */
  buscarPropuestasDeGrupo: () => Promise<void>;
  /** (step 18 §5.4) Pinta las hasta tres propuestas, sin preselección. */
  renderPropuestasDeGrupo: () => void;
  /** (step 18 §5.4) La ÚNICA confirmación explícita del conjunto, y la única escritura. */
  confirmarGrupo: () => Promise<void> | undefined;
  /** (step 18 §5.4) La frase de un conflicto de creación, con la línea señalada. */
  textoDeConflictoDeGrupo: (json: Record<string, unknown>) => string;
  /** (step 18 §4.3, K13) La lista CERRADA de etiquetas sintéticas del diálogo de grupo. */
  ETIQUETAS_GRUPO: readonly string[];
  /** (step 18 §5.6) Pinta el panel del reloj del Laboratorio. */
  renderPanelDelReloj: (snap: unknown) => void;
  /** (step 18 §3.5) Manda el avance del reloj por la ruta real. */
  avanzarElReloj: () => Promise<void> | undefined;
  /** (step 18 §5.6) Pinta el tercer historial, el de operaciones de consola. */
  renderHistorialDeOperaciones: (snap: unknown) => void;
  /** (step 18 §4.13) Los dos ejemplos que rellenan el diálogo y lo abren en el paso 3. */
  lanzarEjemploDeGrupo: (nombre: string, disparador: unknown) => void;
  /** (step 18 §4.13) Primera mitad del escenario del conflicto: prepara la propuesta. */
  prepararConflictoDeGrupo: () => Promise<void>;
  /** (step 18 §4.13) Segunda mitad: ocupa el hueco por `/api/scenario/run` y reabre el diálogo. */
  ocuparElHuecoDeLaPropuesta: () => Promise<void> | undefined;
  /** (step 18 §5.3) Engancha el foco y los botones del diálogo de anotar. */
  wireInasistenciaDialog: () => void;
  /** (step 18 §5.3) Ídem, el de corregir. */
  wireCorregirInasistenciaDialog: () => void;
  /** (step 18 §5.4) Ídem, el de grupo (cuatro pasos, radios y fecha). */
  wireGrupoDialog: () => void;
  /** (step 18 §5.6) Ídem, los dos `<select>` del reloj y su botón. */
  wireRelojLabControls: () => void;
  /** (step 19 Capacidad 1) Engancha el formulario del explorador y el botón "Comprobar huecos sintéticos". */
  wireHuecosControls: () => void;
  /** (step 19 Capacidad 1) Pide `GET /api/availability/explore` con lo elegido, y pinta el resultado o el error. */
  comprobarHuecos: () => Promise<void> | undefined;
  /** (step 19 Capacidad 1, §3.8 punto 10) El reinicio vacía resultados, encabezado y nota de desfase; los campos del formulario no se tocan. */
  limpiarExploradorHuecos: () => void;
  /** (step 19 Capacidad 1, §3.3) Recalcula la línea de puerta y si el botón puede activarse. */
  actualizarPuertaHuecos: () => void;
  /** (M19-MAC-D1) Construye o reconcilia la tarjeta de una propuesta de hueco, incluido su `<details>` de detalle técnico. */
  buildHuecoResultCard: (slot: unknown, existing: unknown) => unknown;
  /** (step 19 Capacidad 2) Pinta el historial de tareas humanas del Laboratorio entero, con sus filtros. */
  renderHistorialDeTareas: (snap: unknown) => void;
  /** (step 19 Capacidad 2) La única definición de qué tareas enseña el historial, dado un estado y un motivo. */
  filtrarHistorialDeTareas: (
    tasks: readonly { open: boolean; reasonLabel: string; createdAtISO: string }[],
    estado: "pendientes" | "resueltas" | "todas",
    motivo: string,
  ) => unknown[];
  /** (step 19 Capacidad 2) Los motivos que HAY en los datos, ordenados alfabéticamente — nunca una lista fija. */
  motivosDeHistorialDeTareas: (tasks: readonly { reasonLabel: string }[]) => string[];
  /** (step 19 Capacidad 2, §4.5) El texto del enlace de una tarea PENDIENTE del historial. */
  textoEnlaceTareaPendiente: (task: unknown) => string;
  /** (step 19 Capacidad 2) Engancha los tres botones de estado y el `<select>` de motivo. */
  wireTareasHumanasControls: () => void;
  /** (step 19 Capacidad 3A) Pinta el panel «Resumen para revisar con Bruno» entero desde `snap.demo.summary`. */
  renderResumenOwner: (snap: unknown) => void;
  /** (step 19 Capacidad 3A) Engancha «Copiar resumen»: `writeText` síncrono dentro del gesto, con respaldo de `<textarea>`. */
  wireResumenOwnerControls: () => void;
  /** (step 19 Capacidad 3A, §5.2.6 hallazgo M2) Vacía y vuelve a ocultar el `<textarea>` de respaldo de copia. */
  limpiarRespaldoDeCopiaDelResumen: () => void;
  /** (step 19 Capacidad 3A) A4/B9/C4: las tres medidas de reservas que llevan la nota de "no se suman". */
  esMedidaDeReservas: (id: string) => boolean;
  /** (step 19 Capacidad 3B) Pinta el panel del guion entero desde `snap.demo`. */
  renderGuionEnPantalla: (snap: unknown) => void;
  /** (step 19 Capacidad 3B) Engancha el selector de guion y el control que sólo mueve el foco a `#btn-abrir-reset`. */
  wireGuionEnPantallaControls: () => void;
  /** (step 19 Capacidad 3B) Una fila de paso del guion, con su píldora, su pista y su frase de evidencia. */
  buildFilaGuionPaso: (step: unknown, existing: unknown) => unknown;
  /** (step 20 §3) Pinta el panel del taller desde `snap.demo.decisionWorkshop`, con la guarda de huella (D20-20). */
  renderTallerDecisiones: (snap: unknown) => void;
  /** (step 20 §3) Engancha los cinco filtros, la búsqueda, el borrado total y su `<dialog>` — una sola vez, sobre nodos estáticos (D20-51). */
  wireTallerControls: () => void;
  /** (step 20 §3.5, D20-23) El normalizador tolerante a acentos de la búsqueda local. */
  normalizarBusqueda: (texto: string) => string;
  /** (step 20 §3.5/§3.11) Aplica filtro+búsqueda con `hidden`; devuelve si ha anunciado. */
  aplicarFiltroDelTaller: (anunciar: boolean) => boolean;
  /** (step 20 §4.3, D20-38) El saneado de una nota: devuelve las líneas ya prefijadas con «> » a ras de margen (I20-9). */
  sanearNotaDelTaller: (nota: string) => string[];
  /** (step 20 §4.2) El acta provisional, función PURA de (vista, borrador). Lanza si una nota supera 280 (D20-49.3). */
  componerActaDelTaller: (vista: unknown, borrador: Record<string, { opcion: string | null; nota: string }>) => string;
  /** (step 20 §5) El borrador de misión no ejecutable, función PURA de (vista, borrador). */
  componerBorradorDeMisionDelTaller: (vista: unknown, borrador: Record<string, { opcion: string | null; nota: string }>) => string;
  /** (step 20 §6.4, D20-28) Vacía y vuelve a ocultar los DOS respaldos de copia del taller. */
  limpiarRespaldosDelTaller: () => void;
  /** (Revisión adversarial A9-5) El borrador en memoria del taller, para inyectar por código lo que el oninput real no deja pasar. */
  tallerBorrador: Record<string, { opcion: string | null; nota: string }>;

  // ---------------------------------------------------------------------
  // step 26 — Agenda multivista (Día · Semana · Mes · Lista)
  // ---------------------------------------------------------------------
  /** Vista Día: eje real, una columna por profesional visible (o lista cronológica con más de cuatro). */
  renderAgendaDia: (snap: unknown, fechaISO: string, filtro: { modo: "todos" | "uno"; employeeId: number | null }) => void;
  /** Vista Semana con un profesional elegido: 7 columnas = 7 días. */
  renderAgendaSemanaProfesional: (snap: unknown, fechaISO: string, employeeId: number) => void;
  /** Vista Semana en "Todos": resumen compacto por día, sin rejilla. */
  renderAgendaSemanaResumen: (snap: unknown, fechaISO: string) => void;
  /** Vista Mes: rejilla de resumen (reutiliza .tx-month-grid/.tx-day-cell). */
  renderAgendaMes: (snap: unknown, fechaISO: string, filtro: { modo: "todos" | "uno"; employeeId: number | null }) => void;
  /** Vista Lista: la tabla de siempre, sobre la ventana de 7 días que empieza en la fecha ancla. */
  renderAgendaLista: (snap: unknown, fechaAncla: string, filtro: { modo: "todos" | "uno"; employeeId: number | null }) => void;
  /** El título en castellano del intervalo que muestra cada vista. */
  agendaTituloRango: (vista: string, fechaISO: string, snap: unknown) => string;
  /** Lee el filtro de profesional del hash contra el snapshot actual; un employeeId inexistente se trata como "todos". */
  agendaFiltroEfectivo: (snap: unknown) => { modo: "todos" | "uno"; employeeId: number | null; invalido: boolean };
  /** La fecha ancla efectiva: la del hash, o engineToday cuando está ausente. */
  agendaFechaEfectiva: (fechaRuta: string | null, snap: unknown) => string;
  /** Cuánto mueven anterior/siguiente la fecha ancla, según la vista. */
  agendaFechaTrasPaso: (vista: string, fechaISO: string, signo: 1 | -1) => string;
  /** Construye el hash `#/agenda/<vista>/<fecha>/<filtro>`. */
  agendaHrefPara: (vista: string, fechaISO: string, filtro: string) => string;
  /** Escribe el hash de Agenda — la ÚNICA forma en que un control cambia de estado (decisión 9). */
  navegarAgenda: (vista: string, fechaISO: string, filtro: string) => void;
  /** Lunes (ISO) de la semana que contiene la fecha. */
  mondayOfWeek: (iso: string) => string;
  capitalizarInicial: (s: string) => string;
  /** El eje temporal de un día: apertura→cierre reales, extendido si alguna cita cae fuera. */
  resolveAgendaDayAxis: (
    dateISO: string,
    snap: unknown,
    employeeIds: readonly number[] | null,
  ) => { open: boolean; reasonLabel?: string; startMinutes: number; endMinutes: number; ticks: number; extendida: boolean };
  /** El eje común de varios días (vista Semana): la unión de sus ventanas. */
  agendaEjeSemana: (
    dias: readonly string[],
    snap: unknown,
    employeeIds: readonly number[],
  ) => { open: boolean; startMinutes: number; endMinutes: number; ticks: number; extendida: boolean };
  /** Los tramos SIN cita confirmada dentro de la VENTANA REAL del local, restando ausencias y pausa. */
  agendaHuecosDeColumna: (
    axis: { open: boolean; startMinutes: number; endMinutes: number },
    reservacionesConfirmadas: readonly { startMinutes: number; endMinutes: number }[],
    bandas: readonly { startMinutes: number; endMinutes: number }[],
    ventana: { startMinutes: number; endMinutes: number; pausa: { startMinutes: number; endMinutes: number } | null } | null,
  ) => Array<{ startMinutes: number; endMinutes: number }>;
  /** La ventana real del local ese día, recortada al eje, con su pausa si la declara. `null` si no abre. */
  agendaVentanaDelDia: (
    dateISO: string,
    snap: unknown,
    axis: { open: boolean; startMinutes: number; endMinutes: number },
  ) => { startMinutes: number; endMinutes: number; pausa: { startMinutes: number; endMinutes: number } | null } | null;
  /** Las zonas del eje que no son horas de atender: extensión y pausa. Nunca llevan control. */
  agendaZonasCerradasDeColumna: (
    axis: { open: boolean; startMinutes: number; endMinutes: number },
    ventana: { startMinutes: number; endMinutes: number; pausa: { startMinutes: number; endMinutes: number } | null } | null,
  ) => Array<{ startMinutes: number; endMinutes: number; motivo: string }>;
  /** Las bandas de ausencia aprobada de un profesional ese día, recortadas al eje. */
  agendaAusenciasDeColumna: (cal: unknown, employeeId: number, dateISO: string, axis: { open: boolean; startMinutes: number; endMinutes: number }) => Array<{ startMinutes: number; endMinutes: number }>;
  /** Los ítems (bloques/huecos/ausencias) de una columna, ya ordenados y con su fila/tic resueltos. */
  agendaItemsParaColumna: (
    snap: unknown,
    dateISO: string,
    employeeId: number,
    axis: { open: boolean; startMinutes: number; endMinutes: number },
    contextoLabel: string,
    contextoAccesible: string,
    identidadClase: string,
  ) => { items: unknown[]; canceladas: unknown[]; tieneAusencia: boolean };
  /** La clase de rejilla que le toca a N columnas de profesional (V2-4). */
  agendaClaseColumnas: (n: number) => string;
  /** La clase de identidad (step 26 §8) por posición del profesional, módulo 3. */
  agendaIdentidadClase: (employeeId: number, professionals: readonly { employeeId: number }[]) => string;
  /** Las líneas visibles del bloque, exactas por duración (§6.4). */
  agendaLineasBloque: (r: unknown, contextoLabel: string) => string[];
  /** La persona sintética de una cita, cuando la hay. */
  agendaPersonaLabel: (r: unknown) => string;
  /** El nombre accesible completo de un bloque de cita. */
  agendaNombreAccesibleBloque: (r: unknown, contextoAccesible: string) => string;
  /** El nombre accesible completo de un hueco. */
  agendaNombreAccesibleHueco: (dateISO: string, startMinutes: number, endMinutes: number, employeeId: number) => string;
  /** Abre el detalle de una cita (step 26 §6.6): las mismas acciones que la vista Lista, nunca un identificador como mensaje principal. */
  abrirDialogoCitaDetalle: (reserva: unknown, disparador: unknown) => void;
  pintarAccionesCitaDetalle: (container: unknown, r: unknown, confirmada: boolean) => void;
  wireCitaDetalleDialog: () => void;
  /** Activar un hueco: precarga fecha/inicio/profesional y abre el asistente en el paso 1. Nunca confirma ni reserva. */
  abrirCitaManualDesdeHueco: (fechaISO: string, startMinutes: number, employeeId: number, disparador: unknown) => void;
  abrirDialogoCitaManual: (disparador: unknown, precarga?: { fechaISO: string; startMinutes: number; employeeId: number }) => void;
  /** La referencia VIVA de manualState (manualReset la reasigna, nunca la muta). */
  manualStateActual: () => {
    paso: number;
    servicio: string;
    fecha: string;
    modo: string;
    profesional: string;
    huecos: unknown[];
    elegido: unknown;
    persona: string;
    propuesta: unknown;
    disparador: unknown;
  };
  /** Engancha los cinco pasos del diálogo "Crear cita manual", incluido el control Duración (step 26 §13). Sólo se engancha una vez, en DOMContentLoaded. */
  wireCitaManualDialog: () => void;

  // ---------------------------------------------------------------------
  // step 26 REAPERTURA — Horarios y ausencias (R7-R13)
  // ---------------------------------------------------------------------
  /** (R12/§4) Los siete días del local y su régimen, pintados en los contenedores que se le pasen. Una implementación, dos pantallas. */
  pintarSemanaDelLocal: (contenedorDias: unknown, contenedorRegimen: unknown, snap: unknown) => void;
  /** (R7/R8) Engancha «Añadir cierre o día especial», «Añadir ausencia» y el filtro de profesional del bloque 3. */
  wireHorariosYAusenciasControls: () => void;
  /** (R9) Abre el diálogo de cierres/días especiales en el paso 1, sin nada preseleccionado. `precarga` sólo la usa el «Cambiar» de R13. */
  openDiaEspecialDialog: (disparador: unknown, precarga?: Record<string, unknown> | null) => void;
  wireDiaEspecialDialog: () => void;
  /** (R9) Paso 2 → 3: construye el cambio, pide `/api/calendar/preview` y pinta el repaso. */
  diaEspecialGoToImpact: () => Promise<void> | undefined;
  /** (R9) Paso 3 → 4: publica. Traduce el 409 de identificador repetido y el de resoluciones. */
  diaEspecialPublish: () => Promise<void> | undefined;
  /** (R10) Abre el diálogo de ausencias. `snapOverride` sólo hace falta sin sondeo previo (pruebas). */
  openAusenciaDialog: (disparador: unknown, precarga?: Record<string, unknown> | null, snapOverride?: unknown) => void;
  wireAusenciaDialog: () => void;
  ausenciaGoToImpact: () => Promise<void> | undefined;
  ausenciaPublish: () => Promise<void> | undefined;
  /** (R13) Abre el detalle de una excepción, desde donde se cambia o se retira. */
  openExcepcionDialog: (item: unknown, disparador: unknown) => void;
  wireExcepcionDialog: () => void;
  /** (R13) Pide `/api/calendar/withdrawal/preview` y pinta el repaso de la retirada. */
  excepcionPreview: () => Promise<void> | undefined;
  /** (R13) Publica la retirada por `/api/calendar/withdrawal/publish`. */
  excepcionPublish: () => Promise<void> | undefined;
  /** (R9/R10) La frase en prosa de un cambio, sin un solo identificador técnico. */
  fraseDeCambio: (change: Record<string, unknown>) => string;
};

function patchedSource(): string {
  const jsSource = renderConsoleAppJs();
  const marker = "})();\n";
  const lastIdx = jsSource.lastIndexOf(marker);
  if (lastIdx === -1) {
    throw new Error(
      "No se ha encontrado el cierre esperado de la IIFE de app.js ('})();\\n'). " +
        "La extracción de pruebas depende de esta forma exacta del fichero fuente.",
    );
  }
  const hookCode = `window.__txTestHooks = { ${HOOK_NAMES.map((n) => `${n}: ${n}`).join(", ")} };\n`;
  return jsSource.slice(0, lastIdx) + hookCode + jsSource.slice(lastIdx);
}

/**
 * Ejecuta el JavaScript REAL servido por `/app.js` en un entorno mínimo
 * (sin DOM) y devuelve las funciones internas expuestas por el hook.
 *
 * `hash`, cuando se da, se usa como `window.location.hash` ANTES de
 * ejecutar el fichero — necesario porque `parseHash()` no toma parámetros:
 * lee `window.location.hash` directamente, igual que en un navegador real.
 *
 * `documentOverride`, cuando se da, sustituye el `document` mínimo (sólo
 * `addEventListener`) por uno que además sabe crear y localizar elementos de
 * verdad — necesario para probar funciones que SÍ tocan el DOM, como
 * `renderEquipo` (defecto C). Ver `tests/console/fakeDom.ts`.
 */
export function loadUiClientHooks(
  hash = "",
  // (step 16, O4) `FakeDocument.addEventListener` ahora recibe de verdad el
  // tipo de evento y el manejador (necesario para poder emitir un `keydown`
  // sintético más tarde con `dispatchKeydown`); este tipo admite tanto el
  // stub por defecto de abajo como ese `FakeDocument` real.
  documentOverride?: { addEventListener: (...args: never[]) => void },
  windowOverride?: { location: { hash: string } },
  // (revisión adversarial de la capacidad 3, hallazgo m5) `navigator` es un
  // PARÁMETRO de la función envolvente (ver `new Function` más abajo), así
  // que `globalThis.navigator` nunca lo alcanza: para probar el camino de
  // ÉXITO de `navigator.clipboard.writeText` (no sólo su ausencia, que ya
  // cubre el `{}` por defecto) hace falta poder inyectar un stub propio.
  navigatorOverride?: unknown,
): UiTestHooks {
  const patched = patchedSource();
  const stubDocument =
    documentOverride ??
    {
      addEventListener: () => {
        /* el único listener de nivel superior (keydown) no hace falta para estas pruebas */
      },
    };
  // `scrollTo` lo llama el enrutador al cambiar de sección, y `setInterval` no
  // se usa nunca aquí (el sondeo sólo arranca en DOMContentLoaded, que este
  // documento no dispara): ambos existen para que el código real corra sin
  // ramas de prueba dentro.
  const stubWindow = (windowOverride ?? {
    location: { hash },
    scrollTo: () => {
      /* el desplazamiento no se puede observar sin navegador; lo que sí se observa es el foco */
    },
  }) as { location: { hash: string }; scrollTo?: () => void; __txTestHooks?: UiTestHooks };
  const stubNavigator = navigatorOverride ?? {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- ver el docblock: es la MISMA fuente que /app.js sirve, sólo con un hook de exportación añadido para la prueba.
  const fn = new Function("document", "window", "navigator", patched);
  fn(stubDocument, stubWindow, stubNavigator);
  if (!stubWindow.__txTestHooks) {
    throw new Error("El hook de pruebas no se instaló: revisa HOOK_NAMES en uiClientExtract.ts.");
  }
  return stubWindow.__txTestHooks;
}
