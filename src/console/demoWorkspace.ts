import { formatHHmm } from "../callEngine/domain/time.js";
import { dayPhraseEs, parseDateTime } from "../utils/dateFormatterEs.js";
import { HUMAN_TASK_LEDGER_COPY, type ConsoleMetricsView, type ConsoleReservationView, type ConsoleTaskView } from "./snapshot.js";
import type { ConsoleWaitlistView } from "./waitlistSnapshot.js";
import type { ConsoleOperationsView } from "./operationsSnapshot.js";
import {
  DECISION_CATALOG,
  congelarEnProfundidad,
  type DecisionCatalogTotals,
  type DecisionOption,
  type DecisionUrgency,
} from "./decisionCatalog.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 19 · Capacidad 3 — EL ESPACIO DE EVALUACIÓN PARA BRUNO (design §5, §6.4).
 *
 * Dos piezas, un solo módulo porque comparten fuente (las mismas cuatro
 * proyecciones ya resueltas) y un solo invariante (I2): NINGUNA frase de
 * negocio nueva se compone en el navegador. Todo — rótulos, las dos frases de
 * cada definición desplegable, las frases de evidencia de cada paso del
 * guion, el texto entero que se copia — viaja resuelto desde aquí.
 *
 * 3A «Resumen para revisar con Bruno»: un espejo de solo lectura de 27 cifras
 * ya existentes, DERIVADAS del registro de auditoría en el mismo instante en
 * que se piden (§5.2.1). Ni una aritmética de negocio nueva: cada valor es
 * una lectura directa de `metrics`/`waitlist.metrics`/`operations.metrics`, o
 * — para B3/B7/C3-C7 — una cuenta ya hecha aquí sobre datos ya derivados por
 * `waitlistSnapshot.ts`/`operationsSnapshot.ts` (nunca un contador llevado a
 * mano).
 *
 * REGLA DURA (§5.2.2, §7.4 punto 2): A4 (`bookingsCreated`), B9
 * (`conversions`) y C4 (`groupReservationsCreated`) son tres cosas distintas
 * — lo que consiguió el asistente al teléfono, lo que se recuperó de un
 * hueco liberado y lo que tecleó un operador para una familia — y NUNCA se
 * suman. No existe, en ningún punto de este fichero, una cifra que sea la
 * suma de dos de ellas.
 *
 * 3B «Guion en pantalla»: los dos guiones del runbook en pasos cortos, cada
 * uno con una evidencia CANÓNICA (§5.3.3): un paso se da por hecho SÓLO
 * cuando el estado en memoria lo demuestra, nunca por visitar una ruta. Los
 * pasos que una ausencia no puede demostrar («no se ha creado nada», «no se
 * ha anotado nada») se marcan `no_comprobable` y NUNCA cuentan en el
 * progreso (§5.3.6).
 *
 * DOS EXTENSIONES DECLARADAS sobre el contrato literal del §6.4 del diseño
 * (documentadas en el mensaje final de esta fase, no una improvisación
 * silenciosa):
 *
 *   1. `DemoWorkspaceView.startingPoint` — la "luz de precondición" que la
 *      enmienda B3 (§5.3.4) exige FUERA de la lista de pasos, con su propio
 *      vocabulario, y que NO entra en `checkableCount`/`doneCount`. El
 *      fragmento de interfaz del §6.4 es anterior a esa enmienda y no le da
 *      sitio a ningún dato: se añade aquí, calculado exactamente igual que
 *      antes (`hayPuntoDePartida`), sobre datos que la instantánea ya trae.
 *   2. `DemoSummaryView.copyStampPrefix`/`copyStampSuffix`/`reservationsNote`
 *      — el §5.2.6 dice literalmente que el prefijo y la coletilla del sello
 *      de copia "viajan resueltos en `demo.summary` como cualquier otra
 *      copia", y el §8.5 exige la nota de las tres cifras de reservas "junto
 *      a sus medidas". Ninguno de los dos aparece en la lista de campos del
 *      §6.4, que también es anterior a esas dos secciones. Se añaden aquí.
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Copy catalogues (§8.5, §8.6) — EL ÚNICO sitio donde vive cada frase.
// ---------------------------------------------------------------------

export const SUMMARY_COPY = {
  heading: "Resumen para revisar con Bruno",
  permanentLabel: "Demo local · Datos sintéticos · No es evidencia de un piloto real",
  note: "Todas estas cifras salen de los registros de esta demostración. No hay ningún contador aparte que pueda mentir, y no hay ni una cifra calculada en esta pantalla.",
  blockTitles: {
    llamadas: "Llamadas",
    espera: "Cancelaciones y lista de espera",
    operaciones: "Inasistencias y reservas para varias personas",
  },
  definitionSummary: "Qué cuenta y qué no",
  copyButtonLabel: "Copiar resumen",
  copiedStatus: "Resumen copiado al portapapeles.",
  fallbackStatus: "Tu navegador no ha dejado copiar. El texto está aquí abajo, entero y ya seleccionado: cópialo con Cmd+C.",
  copyStampPrefix: "Sello de copia: ",
  copyStampSuffix: " (hora local de este ordenador). Sólo dice cuándo se copió; no mide nada.",
  reservationsNote: "Estas tres cifras no se suman: dicen cosas distintas y sumarlas daría un número que no significa nada.",
  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo B1.)* La versión EXPLÍCITA de `reservationsNote`, para el texto
   * copiado — donde, a diferencia de la pantalla, no hay una fila de al lado
   * que diga de qué medida se habla. Nombra las tres cifras por su letra y
   * su rótulo, para que la frase sea cierta ahí donde aparezca, sin depender
   * de qué bloque la precede.
   */
  reservationsSumWarning:
    "Las tres cifras de reservas de este resumen —creadas por una llamada (A4), nacidas de la lista de espera (B9) y citas dentro de reservas para varias personas (C4)— no se suman: dicen cosas distintas y sumarlas daría un número que no significa nada.",
  reportTitle: "Resumen de la demostración de Demo Salon",
  reportPermanentLine: "Demo local · Datos sintéticos · No es evidencia de un piloto real.",
  syntheticBlock:
    "TODO LO DE ABAJO ES SINTÉTICO. No hay ningún cliente real, ninguna cita real,\nningún cobro y ningún sistema de reservas de verdad detrás. Estas cifras\ndescriben esta demostración local, no un piloto.",
  disclaimersHeading: "LO QUE ESTE RESUMEN NO DICE",
} as const;

/**
 * §8.5 — bloque «Lo que este resumen no dice», íntegro. Catálogo cerrado,
 * seis frases.
 *
 * DESVIACIÓN DECLARADA en la tercera frase. El §8.5 la escribe «Ningún dato
 * de dinero: no hay pagos, ni depósitos, ni penalizaciones.» — y esa
 * redacción exacta rompe `tests/console/noShowApi.test.ts` (criterio 8.11,
 * anterior a esta misión): esa prueba barre TODA la instantánea y exige que
 * «penaliz…» sólo aparezca precedida, en sus últimos 40 caracteres, de
 * «ninguna » o «sin » — una redacción con «ni» delante no basta. Se
 * reformula, MISMA información, para que «ninguna» quede inmediatamente
 * delante de «penalización»: no es un aflojamiento de esa prueba (que sigue
 * intacta), es la única redacción de esta frase que la respeta.
 */
export const SUMMARY_DISCLAIMERS = [
  "Ninguna medida de tiempo. El reloj de esta demostración es sintético y sólo avanza cuando lo mueve una persona.",
  "Ningún porcentaje, ninguna tasa y ningún objetivo: sobre datos sintéticos no significarían nada.",
  "Ningún dato de dinero: no hay pagos, no hay depósitos y no hay ninguna penalización.",
  "Nada por persona: una inasistencia va pegada a la cita, no a nadie, así que aquí es imposible decir que alguien ha faltado tres veces.",
  "Ninguna medida de latencia: el motor no emite ninguna y no se inventa.",
  "Los historiales van por separado a propósito: comparten hora sintética, así que un orden común entre ellos sería inventado.",
] as const;

const COPY_SECTION_HEADINGS = {
  llamadas: "LLAMADAS",
  espera: "CANCELACIONES Y LISTA DE ESPERA",
  operaciones: "INASISTENCIAS Y RESERVAS PARA VARIAS PERSONAS",
} as const;

/** El fixture de demostración no cambia por sondeo: temporada, horario y número de profesionales son constantes de este proceso (§5.2.8). */
const FIXTURE_LINE =
  "Fixture de demostración: Demo Salon, temporada de agosto de 2026 (09:00–17:30), tres profesionales sintéticos.";

/**
 * *(Corregido 2026-08-05 tras revisión adversarial de la capacidad 3,
 * hallazgo M3.)* `pillDone`/`pillNotYet`/`pillNotCheckable` se han
 * eliminado: no los leía nadie — el cliente pinta cada píldora con DOS
 * elementos separados (glifo + rótulo, `buildPillEl`, el mismo patrón que ya
 * usa el libro de tareas), nunca una cadena única — y su formato («✓
 * Hecho», con un espacio) ni siquiera coincidía con lo que el DOM produce
 * («✓Hecho», sin él, porque son dos nodos adyacentes). Eran dos constantes
 * muertas Y equivocadas: no una excepción declarada a I2, un resto. Las
 * demás cadenas de este catálogo que sólo viven como HTML estático
 * (`goToResetLabel`, `chooseGuideLegend`, `noneChosen`, `hardNote`) se
 * conservan como fuente de referencia — la misma función que ya cumple
 * `SUMMARY_COPY.permanentLabel` — y una prueba las compara, byte a byte,
 * contra `ui.html.ts`. `linkPrefix` ya no es una de ellas: ahora viaja de
 * verdad, dentro de `DemoGuideStepView.linkLabel` (ver más abajo).
 */
export const GUIDE_COPY = {
  heading: "Guion en pantalla para enseñar la demostración",
  resetWarning:
    "Los dos guiones describen mundos distintos: el guion 1 mueve el reloj sintético, y con el reloj movido las cuentas del guion 2 hablan de otra cosa. Reinicia antes de empezar cualquiera de los dos, y reinicia otra vez antes de pasar del uno al otro.",
  goToResetLabel: "Ir a «Reiniciar la demostración»",
  startingPointReadyLabel: "Estás en el punto de partida: puedes empezar.",
  startingPointNotReadyLabel: "Esta demostración ya se ha tocado. Reinicia antes de empezar.",
  chooseGuideLegend: "Qué guion vas a enseñar",
  noneChosen: "Elige el guion que vas a enseñar.",
  hardNote: "Ningún paso se marca por visitar una pantalla ni por pulsar nada aquí. Se marca cuando el estado de la demostración lo demuestra, y sólo entonces.",
  linkPrefix: "Ir a ",
} as const;

/** §8.6 — catálogo CERRADO de las cinco frases de evidencia no comprobable. Ningún paso escribe una sexta. */
export const GUIDE_NOT_CHECKABLE_PHRASES = {
  watchingAPanel: "Aún no comprobado: mirar un panel no deja rastro, y esta pantalla no cuenta una visita como un hecho.",
  creatingNothingOnPurpose:
    "Aún no comprobado: aquí no se crea nada a propósito, y no crear nada no deja rastro. Que no lo deje es justo lo que se está enseñando.",
  conflictWritesNothing: "Aún no comprobado: un conflicto no escribe ni una línea, que es exactamente lo que demuestra este paso.",
  absenceOfAnAction: "Aún no comprobado: es la ausencia de una acción, y las ausencias no dejan huella.",
  countedNotDone: "Aún no comprobado: esto se cuenta, no se hace.",
} as const;

// ---------------------------------------------------------------------
// View types (§6.4, con las dos extensiones declaradas en el docblock)
// ---------------------------------------------------------------------

export interface DemoSummaryMeasureView {
  id: string;
  label: string;
  /** `null` sólo para C1, que es una FRASE ya compuesta, no un número. */
  value: number | null;
  valueLabel: string;
  increasesWhen: string;
  doesNotIncreaseWhen: string;
}

export interface DemoSummaryBlockView {
  id: "llamadas" | "espera" | "operaciones";
  title: string;
  measures: readonly DemoSummaryMeasureView[];
}

export interface DemoSummaryView {
  permanentLabel: string;
  clockLine: string;
  fixtureLine: string;
  blocks: readonly DemoSummaryBlockView[];
  /** Las líneas del bloque final "LO QUE ESTE RESUMEN NO DICE" (§8.5). */
  disclaimers: readonly string[];
  /** La nota obligatoria de A4/B9/C4 (§8.5): "estas tres cifras no se suman". */
  reservationsNote: string;
  /** El texto copiable ENTERO, ya compuesto salvo el sello de copia (§5.2.6/§5.2.7). */
  copyText: string;
  /**
   * EXTENSIÓN DECLARADA (ver docblock del módulo, punto 2). El navegador
   * concatena EXACTAMENTE `copyStampPrefix + <hora local formateada a mano> +
   * copyStampSuffix` y la inserta en `copyText` justo detrás de `fixtureLine`
   * — la única composición de cadena que hace, y la única excepción a I2
   * declarada para esta pantalla (§7.1).
   */
  copyStampPrefix: string;
  copyStampSuffix: string;
}

export type DemoStepEvidenceState = "hecho" | "todavia_no" | "no_comprobable";

export interface DemoGuideStepView {
  id: string;
  order: number;
  title: string;
  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo M2.)* "1.2", "1.A"… la numeración del RUNBOOK, no un correlativo
   * de 1 en adelante. `stepTitleLine` se compone a partir de ÉSTE, no de
   * `order` (ver docblock de `stepTitleLine`, mismo hallazgo).
   */
  numberLabel: string;
  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo M3; corregido 2026-08-05, hallazgo M2.)* "N. Título", ya
   * compuesto. Antes lo concatenaba el cliente (`ui.js.ts`,
   * `String(step.order) + '. ' + step.title`) — una composición de cadena de
   * negocio en el navegador, justo lo que I2 prohíbe. Al moverlo al
   * servidor, el defecto de M3 se llevó también un segundo, distinto: `N`
   * era `spec.order`, un correlativo que empezaba en 2 para el guion 1 (el
   * paso 1 es la luz de precondición, fuera de la lista, §5.3.4) y perdía la
   * numeración 1.A/1.B/1.C de las variantes — «paso 1.B» dejaba de existir
   * en pantalla, rompiendo la referencia cruzada con el runbook que el §5.3.4
   * promete por escrito. Ahora se compone a partir de `numberLabel`, que SÍ
   * es la numeración del runbook. El cliente sigue pintando esto verbatim.
   */
  stepTitleLine: string;
  cue: string;
  whereLabel: string;
  whereHref: string;
  /**
   * *(Añadido 2026-08-05, mismo hallazgo M3.)* "Ir a {whereLabel}", ya
   * compuesto a partir de `GUIDE_COPY.linkPrefix` — la misma razón que
   * `stepTitleLine`.
   */
  linkLabel: string;
  evidenceState: DemoStepEvidenceState;
  evidenceLabel: string;
}

export interface DemoGuideView {
  id: "guion-1" | "guion-2";
  title: string;
  steps: readonly DemoGuideStepView[];
  checkableCount: number;
  doneCount: number;
  progressLine: string;
}

export interface DemoWorkspaceView {
  /**
   * EXTENSIÓN DECLARADA (ver docblock del módulo, punto 1). La "luz de
   * precondición" de la enmienda B3 (§5.3.4): NO es un paso, no cuenta en
   * ningún guion, y vive una sola vez porque `hayPuntoDePartida` no depende
   * de qué guion se haya elegido.
   */
  startingPoint: { ready: boolean; label: string };
  summary: DemoSummaryView;
  guides: readonly DemoGuideView[];
  taskLedger: { copy: typeof HUMAN_TASK_LEDGER_COPY };
  /**
   * step 20 (D20-6) — el QUINTO campo de `demo`: el catálogo del taller de
   * decisiones, un *slice* dentro de la clave ya autorizada, no una ruta ni
   * una clave de primer nivel nueva (I20-14). Es SIEMPRE la misma referencia
   * congelada (D20-50): no depende del mundo, no cambia con el reloj y no se
   * reconstruye por sondeo.
   */
  decisionWorkshop: DecisionWorkshopView;
}

export interface DemoWorkspaceInput {
  metrics: ConsoleMetricsView;
  availabilityQueryCount: number;
  tasks: readonly ConsoleTaskView[];
  reservations: readonly ConsoleReservationView[];
  waitlist: ConsoleWaitlistView;
  operations: ConsoleOperationsView;
  engineToday: string;
  engineNowMinutes: number;
}

// ---------------------------------------------------------------------
// 3A — las 27 medidas, con sus dos frases cada una (§5.2.2, §5.2.4)
// ---------------------------------------------------------------------

function measure(
  id: string,
  label: string,
  value: number,
  increasesWhen: string,
  doesNotIncreaseWhen: string,
): DemoSummaryMeasureView {
  return { id, label, value, valueLabel: String(value), increasesWhen, doesNotIncreaseWhen };
}

function buildLlamadasBlock(metrics: ConsoleMetricsView, availabilityQueryCount: number): DemoSummaryBlockView {
  return {
    id: "llamadas",
    title: SUMMARY_COPY.blockTitles.llamadas,
    measures: [
      measure(
        "A1",
        "Llamadas atendidas",
        metrics.callsHandled,
        "Sube cuando el asistente sintético gestiona una llamada de principio a fin, la entienda o no.",
        "No sube por nada que pase fuera de una llamada: ni un aviso simulado, ni una acción de un operador en la consola.",
      ),
      measure(
        "A2",
        "Llamadas que llegaron a un desenlace",
        metrics.callsWithOutcome,
        "Sube cuando la llamada termina con un resultado que el contrato congelado sabe nombrar (RESUELVE, DERIVA o RECHAZA).",
        "No sube si la llamada se queda sin terminar de verdad, ni cuenta dos veces la misma llamada.",
      ),
      measure(
        "A3",
        "Resueltas sin interrumpir a nadie",
        metrics.resolvedWithoutHumanInterruption,
        "Sube cuando una llamada termina con un desenlace que el contrato congelado marca como contenida: el asistente la resolvió sin que nadie del equipo tuviera que intervenir.",
        "No sube cuando la llamada se pasa a una persona, cuando queda un recado pendiente, ni cuando hay un fallo técnico —un fallo técnico no prueba nada sobre si se entendió al cliente.",
      ),
      measure(
        "A4",
        "Reservas creadas por una llamada",
        metrics.bookingsCreated,
        "Sube sólo cuando una llamada termina en una reserva confirmada por el propio asistente, durante esa misma llamada.",
        "No sube por una reserva recuperada de la lista de espera ni por una creada a mano por un operador: esas tienen sus propias cifras, más abajo, y nunca se suman con ésta.",
      ),
      measure(
        "A5",
        "Fallos técnicos",
        metrics.technicalErrors,
        "Sube cuando el motor no ha podido resolver la llamada por un fallo técnico, nunca por una petición que el cliente no supo formular.",
        "No sube por una llamada derivada a una persona ni por una reserva que el cliente no llegó a confirmar: ninguna de las dos es un fallo del motor.",
      ),
      measure(
        "A6",
        "Tareas pendientes para una persona",
        metrics.pendingHumanTasks,
        "Sube con cada recado que sigue abierto en la cola humana: una llamada escalada, un cambio de calendario por avisar, una decisión de lista de espera o una cancelación fuera de plazo por revisar.",
        "No sube por un recado ya cerrado, y baja en cuanto se cierra de verdad (hoy sólo dos de los siete motivos tienen camino de cierre, y lo cierra una acción real de un operador, nunca solos).",
      ),
      measure(
        "A7",
        "Llamadas que pidieron hablar con una persona",
        metrics.staffInterruptions,
        "Sube cada vez que el motor registra que alguien pidió hablar con una persona durante la llamada.",
        "No sube por un recado que nace de otro sitio (un cambio de calendario, una lista de espera): sólo cuenta la petición explícita dentro de la llamada.",
      ),
      measure(
        "A8",
        "Consultas de disponibilidad hechas por el motor durante una llamada",
        availabilityQueryCount,
        "Sube cada vez que el motor pregunta al calendario si una hora está libre, dentro de una llamada real.",
        "No sube por una consulta hecha desde el explorador de huecos de Agenda: es una herramienta aparte, de sólo lectura, y no toca ninguna llamada.",
      ),
    ],
  };
}

function buildEsperaBlock(waitlist: ConsoleWaitlistView): DemoSummaryBlockView {
  const m = waitlist.metrics;
  return {
    id: "espera",
    title: SUMMARY_COPY.blockTitles.espera,
    measures: [
      measure(
        "B1",
        "Personas apuntadas a la lista",
        m.waitlistOptInsRecorded,
        "Sube cada vez que alguien acepta explícitamente apuntarse a la lista de espera.",
        "No sube cuando a alguien se le pregunta y dice que no: eso tiene su propia cifra, la siguiente.",
      ),
      measure(
        "B2",
        "Personas a las que se preguntó y dijeron que no",
        m.waitlistOptInsDeclined,
        "Sube cada vez que se pregunta si alguien quiere apuntarse y la respuesta es que no.",
        "No sube por un alta que sí se produce, y no deja ninguna entrada guardada.",
      ),
      measure(
        "B3",
        "Cancelaciones dentro de plazo",
        m.cancellationsOnTime,
        "Sube cuando se cancela una cita avisando con la antelación mínima configurada, o más.",
        "No sube por una cancelación fuera de plazo —ésa tiene su propia cifra— ni por anotar una inasistencia, que es una cosa distinta de cancelar.",
      ),
      measure(
        "B4",
        "Cancelaciones fuera de plazo, en revisión",
        m.lateCancellationsUnderReview,
        "Sube cuando se cancela una cita avisando con menos antelación de la configurada, y sigue sumando mientras nadie la ha revisado.",
        "No sube por una cancelación a tiempo, y baja en cuanto un operador la marca como revisada, sin aplicar ninguna penalización.",
      ),
      measure(
        "B5",
        "Huecos liberados",
        m.slotsReleasedTotal,
        "Sube cada vez que una cancelación libera de verdad una media hora del calendario.",
        "No sube si el día entero está cerrado y la cancelación no llega a liberar ningún hueco real.",
      ),
      measure(
        "B6",
        "Huecos liberados en los que encajaba alguien",
        m.slotsReleasedWithCompatibles,
        "Sube cuando, al evaluarlo, al menos una persona de la lista de espera encaja con el hueco liberado.",
        "No sube cuando nadie de la lista encaja: esa situación tiene su propia cifra, la de al lado.",
      ),
      measure(
        "B7",
        "Huecos liberados en los que no encajaba nadie",
        m.slotsReleasedWithoutCompatibles,
        "Sube cuando, al evaluar un hueco liberado, ninguna persona de la lista de espera encaja con él.",
        "No sube cuando al menos una persona sí encaja: esa cifra es la de al lado, y las dos juntas son siempre el total de huecos liberados.",
      ),
      measure(
        "B8",
        "Avisos simulados",
        m.noticesSimulated,
        "Sube cada vez que un operador marca que se ha avisado (de forma simulada) a alguien de la lista de un hueco liberado.",
        "No sube nunca por un envío real: esta demostración no manda ningún mensaje ni hace ninguna llamada.",
      ),
      measure(
        "B9",
        "Reservas creadas desde la lista de espera",
        m.conversions,
        "Sube sólo cuando se confirma la reserva de una persona que estaba apuntada a la lista de espera, para el hueco que se le ofreció.",
        "No sube por una reserva de una llamada ni por una creada a mano para varias personas: esas tienen sus propias cifras, y las tres nunca se suman.",
      ),
      measure(
        "B10",
        "Conflictos de conversión evitados",
        m.conversionConflictsPrevented,
        "Sube cuando se intenta convertir una entrada de la lista de espera y el hueco ya se ha ocupado por otro camino: la conversión se rechaza y no escribe nada.",
        "No sube por una conversión que sí se completa.",
      ),
      measure(
        "B11",
        // *(Corregido 2026-08-05 tras revisión adversarial de la capacidad
        // 3, hallazgo M4.)* El rótulo y las dos frases decían, sin apellido,
        // «repeticiones que no volvieron a escribir» — dando a entender que
        // cubrían CUALQUIER repetición idempotente de la demostración.
        // Falso: `m.idempotentReplays` sólo cuenta las de la LISTA DE
        // ESPERA (`IDEMPOTENT_REPLAY` del registro de auditoría de
        // `waitlistSnapshot.ts`). Una repetición de anotar una inasistencia,
        // o de crear una reserva para varias personas con la misma clave,
        // NO mueve esta cifra — tienen su propio registro, aparte, en
        // `operations`.
        "Repeticiones de la lista de espera que no volvieron a escribir",
        m.idempotentReplays,
        "Sube cada vez que se repite, con la misma clave, una petición DE LA LISTA DE ESPERA que ya se había hecho antes: se devuelve el mismo resultado, sin escribir nada nuevo.",
        "No sube la primera vez que se hace algo, sólo por sus repeticiones exactas — y no cuenta una repetición idempotente de anotar una inasistencia ni de crear una reserva para varias personas: esas llevan su propio registro, en el bloque de operaciones.",
      ),
      measure(
        "B12",
        "Fallos inyectados que se gestionaron",
        m.injectedFailuresHandled,
        "Sube cada vez que el interruptor de fallo del Laboratorio hace fallar a propósito una conversión, y esa demostración se enseña sin que se escriba nada.",
        "No sube por un fallo real: este fallo lo enciende un operador a propósito, para enseñar que no se escribe nada cuando algo sale mal.",
      ),
    ],
  };
}

function buildOperacionesBlock(operations: ConsoleOperationsView): DemoSummaryBlockView {
  const m = operations.metrics;
  return {
    id: "operaciones",
    title: SUMMARY_COPY.blockTitles.operaciones,
    measures: [
      // C1 — la única FRASE (value: null). El servidor ya la compone
      // a propósito (recordedAndCorrectedLine); el navegador no le añade ni
      // le quita nada.
      {
        id: "C1",
        label: "Inasistencias",
        value: null,
        valueLabel: m.recordedAndCorrectedLine,
        increasesWhen:
          "Sube (las dos partes de la frase) cuando se anota una inasistencia sobre una cita ya terminada, o cuando se corrige un registro anotado antes.",
        doesNotIncreaseWhen: "No sube por cancelar una cita, por avanzar el reloj sin anotar nada, ni por repetir una acción ya hecha.",
      },
      measure(
        "C2",
        "Avances del reloj sintético",
        m.clockAdvances,
        "Sube cada vez que un operador mueve hacia delante el reloj de la demostración, por el minuto que sea.",
        "No sube solo, nunca retrocede, y un reinicio lo pone a cero junto con el propio reloj.",
      ),
      measure(
        "C3",
        "Reservas para varias personas creadas",
        m.groupsCreated,
        "Sube cada vez que se confirma una reserva para varias personas, sea consecutiva o simultánea.",
        "No sube por una propuesta que se enseña y se cierra con Cancelar, ni por un conflicto que impide crearla: ninguna de las dos escribe nada.",
      ),
      measure(
        "C4",
        "Citas creadas dentro de reservas para varias personas",
        m.groupReservationsCreated,
        "Sube por cada cita individual que compone una reserva para varias personas —dos personas son dos citas, y así con cualquier número.",
        "No sube por una reserva de una llamada ni por una recuperada de la lista de espera: esas tienen sus propias cifras, y las tres nunca se suman.",
      ),
      measure(
        "C5",
        "De ellas, con todas sus citas en pie",
        m.groupsFullyActive,
        "Sube cuando una reserva para varias personas tiene, en este instante, todas sus citas confirmadas.",
        "No sube en cuanto se cancela una sola cita de ese grupo: pasa a contar en la cifra de al lado.",
      ),
      measure(
        "C6",
        "De ellas, con alguna cita cancelada",
        m.groupsPartiallyCancelled,
        "Sube cuando una reserva para varias personas tiene alguna cita cancelada, pero no todas.",
        "No sube si todas las citas siguen en pie, ni si ya se han cancelado todas: esas dos situaciones tienen sus propias cifras.",
      ),
      measure(
        "C7",
        "De ellas, con todas sus citas canceladas",
        m.groupsFullyCancelled,
        "Sube cuando una reserva para varias personas tiene, en este instante, todas sus citas canceladas, una a una.",
        "No sube por cancelar una sola cita de un grupo con más de una: eso cuenta en la cifra de al lado, mientras quede alguna en pie.",
      ),
    ],
  };
}

/** "movido +1 h por una persona" — gemela de `advancedLabelFor` (operationsSnapshot.ts) pero en tercera persona: este texto lo lee Bruno, no quien mueve el reloj. */
function advancedForSummary(minutes: number): string | null {
  if (minutes <= 0) return null;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes - days * 1440) / 60);
  const rest = minutes - days * 1440 - hours * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)} d`);
  if (hours > 0) parts.push(`${String(hours)} h`);
  if (rest > 0) parts.push(`${String(rest)} min`);
  return `movido +${parts.join(" ")} por una persona`;
}

/** "martes 4 de agosto de 2026, 10:00 (movido +1 h por una persona)." — CON año, a diferencia del explorador (§6.1): este texto viaja solo, fuera de contexto, en un correo. */
function buildClockLine(engineToday: string, engineNowMinutes: number, advancedByMinutes: number): string {
  const parsed = parseDateTime(engineToday);
  const dayWithYear = parsed === null ? engineToday : `${dayPhraseEs(parsed)} de ${String(parsed.year)}`;
  const advanced = advancedForSummary(advancedByMinutes);
  const suffix = advanced === null ? "" : ` (${advanced})`;
  return `Reloj de la demostración: ${dayWithYear}, ${formatHHmm(engineNowMinutes)}${suffix}.`;
}

function measureBullet(m: DemoSummaryMeasureView): string {
  return m.value === null ? `- ${m.valueLabel}` : `- ${m.label}: ${m.valueLabel}`;
}

function sectionText(heading: string, block: DemoSummaryBlockView): string {
  return [heading, ...block.measures.map(measureBullet)].join("\n");
}

function buildSummary(input: DemoWorkspaceInput): DemoSummaryView {
  const llamadas = buildLlamadasBlock(input.metrics, input.availabilityQueryCount);
  const espera = buildEsperaBlock(input.waitlist);
  const operaciones = buildOperacionesBlock(input.operations);
  const clockLine = buildClockLine(input.engineToday, input.engineNowMinutes, input.operations.clock.advancedByMinutes);

  // *(Corregido 2026-08-05 tras revisión adversarial de la capacidad 3,
  // hallazgo B1.)* `reservationsNote` vivía pegada al bloque de OPERACIONES,
  // justo detrás de C5/C6/C7 — un trío para el que "no se suman" es FALSO
  // (C5+C6+C7 = C3): un lector del texto copiado la leería como si hablara de
  // ESAS tres cifras. La nota EXPLÍCITA (`reservationsSumWarning`, que nombra
  // A4/B9/C4 por su letra) vive ahora en el bloque de avisos, donde no tiene
  // ningún trío distinto justo delante que pueda confundirla.
  const operacionesSectionText = sectionText(COPY_SECTION_HEADINGS.operaciones, operaciones);

  const copyText = [
    SUMMARY_COPY.reportTitle,
    SUMMARY_COPY.reportPermanentLine,
    "",
    clockLine,
    FIXTURE_LINE,
    "",
    SUMMARY_COPY.syntheticBlock,
    "",
    sectionText(COPY_SECTION_HEADINGS.llamadas, llamadas),
    "",
    sectionText(COPY_SECTION_HEADINGS.espera, espera),
    "",
    operacionesSectionText,
    "",
    [
      SUMMARY_COPY.disclaimersHeading,
      ...SUMMARY_DISCLAIMERS.map((d) => `- ${d}`),
      `- ${SUMMARY_COPY.reservationsSumWarning}`,
    ].join("\n"),
  ].join("\n");

  return {
    permanentLabel: SUMMARY_COPY.permanentLabel,
    clockLine,
    fixtureLine: FIXTURE_LINE,
    blocks: [llamadas, espera, operaciones],
    disclaimers: SUMMARY_DISCLAIMERS,
    reservationsNote: SUMMARY_COPY.reservationsNote,
    copyText,
    copyStampPrefix: SUMMARY_COPY.copyStampPrefix,
    copyStampSuffix: SUMMARY_COPY.copyStampSuffix,
  };
}

// ---------------------------------------------------------------------
// 3B — el guion en pantalla (§5.3)
// ---------------------------------------------------------------------

interface StepSpec {
  id: string;
  order: number;
  /** (hallazgo M2) La numeración del runbook — "1.2", "1.A"… — ver `DemoGuideStepView.numberLabel`. */
  numberLabel: string;
  title: string;
  cue: string;
  whereLabel: string;
  whereHref: string;
  /** `null` ⇒ paso `no_comprobable`, con la frase cerrada indicada por `notCheckablePhrase`. */
  predicate: ((input: DemoWorkspaceInput) => boolean) | null;
  notCheckablePhrase?: string;
}

function stepView(spec: StepSpec, input: DemoWorkspaceInput): DemoGuideStepView {
  const evidenceState: DemoStepEvidenceState =
    spec.predicate === null ? "no_comprobable" : spec.predicate(input) ? "hecho" : "todavia_no";
  const evidenceLabel =
    evidenceState === "no_comprobable"
      ? (spec.notCheckablePhrase as string)
      : evidenceState === "hecho"
        ? "Hecho."
        : "Todavía no.";
  return {
    id: spec.id,
    order: spec.order,
    numberLabel: spec.numberLabel,
    title: spec.title,
    stepTitleLine: `${spec.numberLabel} ${spec.title}`,
    cue: spec.cue,
    whereLabel: spec.whereLabel,
    whereHref: spec.whereHref,
    linkLabel: `${GUIDE_COPY.linkPrefix}${spec.whereLabel}`,
    evidenceState,
    evidenceLabel,
  };
}

const GUIDE_1_STEPS: readonly StepSpec[] = [
  {
    id: "g1-2",
    numberLabel: "1.2",
    order: 2,
    title: "El reloj lo mueves tú",
    cue: "Avanza hasta el final de la cita de 09:30 con Álex.",
    whereLabel: "Laboratorio",
    whereHref: "#/laboratorio",
    predicate: (i) => i.operations.metrics.clockAdvances >= 1,
  },
  {
    id: "g1-3",
    numberLabel: "1.3",
    order: 3,
    title: "Anotar una inasistencia",
    cue: "Sólo la cita terminada ofrece el botón; lee las cuatro frases antes de confirmar.",
    whereLabel: "Agenda",
    whereHref: "#/agenda",
    predicate: (i) => i.operations.metrics.noShowRecordCommands >= 1,
  },
  {
    id: "g1-4",
    numberLabel: "1.4",
    order: 4,
    title: "Corregirla",
    cue: "Corregir es definitivo; el registro no se borra.",
    whereLabel: "Agenda",
    whereHref: "#/agenda",
    predicate: (i) => i.operations.metrics.noShowsCorrected >= 1,
  },
  {
    id: "g1-5",
    numberLabel: "1.5",
    order: 5,
    title: "Enseñar el historial de operaciones",
    cue: "Ahí están, en orden y en castellano, el reinicio, el avance, el registro y la corrección.",
    whereLabel: "Laboratorio",
    whereHref: "#/laboratorio",
    predicate: null,
    notCheckablePhrase: GUIDE_NOT_CHECKABLE_PHRASES.watchingAPanel,
  },
  {
    id: "g1-6",
    numberLabel: "1.6",
    order: 6,
    title: "Dos personas seguidas, con servicios distintos",
    cue: "Reinicia antes. Servicio persona a persona, sin «copiar a todas».",
    whereLabel: "Agenda",
    whereHref: "#/agenda",
    predicate: (i) => i.operations.metrics.groupsConsecutiveCreated >= 1,
  },
  {
    id: "g1-7",
    numberLabel: "1.7",
    order: 7,
    title: "Las mismas dos, pero a la vez",
    cue: "Se enseña la propuesta y se cierra con Cancelar.",
    whereLabel: "Agenda",
    whereHref: "#/agenda",
    predicate: null,
    notCheckablePhrase: GUIDE_NOT_CHECKABLE_PHRASES.creatingNothingOnPurpose,
  },
  {
    id: "g1-8",
    numberLabel: "1.8",
    order: 8,
    title: "Un conflicto que no escribe nada",
    cue: "Prepara la propuesta, ocupa el hueco, confirma como si nada.",
    whereLabel: "Laboratorio",
    whereHref: "#/laboratorio",
    predicate: null,
    notCheckablePhrase: GUIDE_NOT_CHECKABLE_PHRASES.conflictWritesNothing,
  },
  {
    id: "g1-a",
    numberLabel: "1.A",
    order: 9,
    title: "Variante: «no puedo anotar eso»",
    cue: "Con el reloj a las 09:00 no hay ningún botón que pulsar.",
    whereLabel: "Agenda",
    whereHref: "#/agenda",
    predicate: null,
    notCheckablePhrase: GUIDE_NOT_CHECKABLE_PHRASES.absenceOfAnAction,
  },
  {
    id: "g1-b",
    numberLabel: "1.B",
    order: 10,
    title: "Variante: cancelar una cita del grupo",
    cue: "La otra sigue en pie y el hueco se ofrece a la lista igual que cualquier otro.",
    whereLabel: "Agenda",
    whereHref: "#/agenda",
    // *(Corregido 2026-08-05 tras revisión adversarial de la capacidad 3,
    // hallazgo m1.)* `groupsPartiallyCancelled` es un AFORO del estado
    // ACTUAL: cuenta grupos con ALGUNA cita cancelada pero no TODAS. Si el
    // runbook enseña la acción siguiente de verdad («cancela también la
    // segunda»), ese mismo grupo pasa a `groupsFullyCancelled` y
    // `groupsPartiallyCancelled` BAJA a cero — este paso, ya dado por hecho,
    // se desmarcaba solo (2/8 → 1/8) por la propia acción que el guion
    // enseña a continuación. La sustituye una comprobación MONÓTONA:
    // «¿ha habido ALGUNA VEZ una línea cancelada en algún grupo?». Una línea
    // cancelada no se vuelve a confirmar nunca (no existe ninguna operación
    // de "descancelar" en esta consola), así que este booleano sólo puede
    // pasar de falso a verdadero, nunca al revés — con independencia de que
    // el grupo acabe parcial o totalmente cancelado (lo segundo absorbe a lo
    // primero, y ambos cumplen esta condición).
    predicate: (i) => i.operations.groups.items.some((g) => g.lines.some((l) => l.status === "cancelled")),
  },
  {
    id: "g1-c",
    numberLabel: "1.C",
    order: 11,
    title: "Variante: dos a la vez con la misma persona",
    cue: "Ni llega a buscar huecos: contesta con la verdad.",
    whereLabel: "Laboratorio",
    whereHref: "#/laboratorio",
    predicate: null,
    notCheckablePhrase: GUIDE_NOT_CHECKABLE_PHRASES.creatingNothingOnPurpose,
  },
];

const GUIDE_2_STEPS: readonly StepSpec[] = [
  {
    id: "g2-1",
    numberLabel: "2.1",
    order: 1,
    title: "Un cliente no encuentra hueco",
    cue: "«Esto es lo que hoy no se recupera».",
    whereLabel: "Inicio",
    whereHref: "#/inicio",
    predicate: null,
    notCheckablePhrase: GUIDE_NOT_CHECKABLE_PHRASES.countedNotDone,
  },
  {
    id: "g2-2",
    numberLabel: "2.2",
    order: 2,
    title: "Se apunta explícitamente",
    cue: "El botón no se enciende hasta marcar la casilla; «No ha querido apuntarse» no crea nada.",
    whereLabel: "Lista de espera",
    whereHref: "#/lista-espera",
    predicate: (i) => i.waitlist.metrics.waitlistOptInsRecorded >= 1,
  },
  {
    id: "g2-3",
    numberLabel: "2.3",
    order: 3,
    title: "Una cancelación a tiempo libera un hueco",
    cue: "Lee en voz alta la frase del plazo antes de confirmar.",
    whereLabel: "Agenda",
    whereHref: "#/agenda",
    predicate: (i) => i.waitlist.metrics.cancellationsOnTime >= 1 && i.waitlist.metrics.slotsReleasedTotal >= 1,
  },
  {
    id: "g2-4",
    numberLabel: "2.4",
    order: 4,
    title: "El panel dice qué necesita atención",
    cue: "Dos tareas nuevas, una por cada media hora liberada.",
    whereLabel: "Inicio",
    whereHref: "#/inicio",
    predicate: (i) => i.tasks.some((t) => t.open && t.reasonKind === "DECIDE_WAITLIST_MATCH"),
  },
  {
    id: "g2-5",
    numberLabel: "2.5",
    order: 5,
    title: "Nadie es contactado ni reservado solo",
    cue: "Lee las cinco frases de la tarjeta; ningún radio viene marcado.",
    whereLabel: "Lista de espera",
    whereHref: "#/lista-espera",
    predicate: null,
    notCheckablePhrase: GUIDE_NOT_CHECKABLE_PHRASES.absenceOfAnAction,
  },
  {
    id: "g2-6",
    numberLabel: "2.6",
    order: 6,
    title: "Aviso simulado",
    cue: "«Aviso simulado. No se ha enviado ningún mensaje ni se ha llamado a nadie».",
    whereLabel: "Lista de espera",
    whereHref: "#/lista-espera",
    predicate: (i) => i.waitlist.metrics.noticesSimulated >= 1,
  },
  {
    id: "g2-7",
    numberLabel: "2.7",
    order: 7,
    title: "Anotar la aceptación y crear la reserva",
    cue: "Tres confirmaciones humanas, ninguna se puede saltar.",
    whereLabel: "Lista de espera",
    whereHref: "#/lista-espera",
    predicate: (i) => i.waitlist.metrics.conversions >= 1,
  },
  {
    id: "g2-8",
    numberLabel: "2.8",
    order: 8,
    title: "El hueco queda recuperado",
    cue: "La cita nueva está a las 13:00, con su rótulo.",
    whereLabel: "Agenda",
    whereHref: "#/agenda",
    predicate: (i) => i.reservations.some((r) => r.originatedFromWaitlistEntryId !== undefined),
  },
  {
    id: "g2-9",
    numberLabel: "2.9",
    order: 9,
    title: "El panel registra lo ocurrido",
    cue: "Cifras y los historiales separados.",
    whereLabel: "Laboratorio",
    whereHref: "#/laboratorio",
    predicate: null,
    notCheckablePhrase: GUIDE_NOT_CHECKABLE_PHRASES.watchingAPanel,
  },
  {
    id: "g2-a",
    numberLabel: "2.A",
    order: 10,
    title: "Variante: cancelación tardía",
    cue: "Etiqueta, no castigo; el hueco se libera igual.",
    whereLabel: "Lista de espera",
    whereHref: "#/lista-espera",
    // *(Corregido 2026-08-05 tras revisión adversarial de la capacidad 3,
    // hallazgo m1.)* `lateCancellationsUnderReview` es un AFORO PENDIENTE:
    // sube con la cancelación tardía y BAJA en cuanto un operador la revisa
    // — el paso siguiente que el propio runbook enseña. Este paso, ya dado
    // por hecho, se desmarcaba solo (2/5 → 1/5) en cuanto se revisaba la
    // cancelación. La sustituye `lateCancellationsTotal`
    // (`waitlistSnapshot.ts`), monótona: cuenta cancelaciones tardías que
    // HAN OCURRIDO, sin importar si ya se revisaron.
    predicate: (i) => i.waitlist.metrics.lateCancellationsTotal >= 1,
  },
  {
    id: "g2-b",
    numberLabel: "2.B",
    order: 11,
    title: "Variante: cancelación que no libera nada útil",
    cue: "Se libera un hueco y nadie encaja; no se crea ninguna tarea.",
    whereLabel: "Lista de espera",
    whereHref: "#/lista-espera",
    predicate: (i) => i.waitlist.metrics.slotsReleasedWithoutCompatibles >= 1,
  },
];

function progressLine(doneCount: number, checkableCount: number, notCheckableCount: number): string {
  return (
    `Comprobados ${String(doneCount)} de ${String(checkableCount)} pasos con evidencia. ` +
    `Otros ${String(notCheckableCount)} pasos de este guion no se pueden comprobar desde los datos ` +
    `—una ausencia no deja rastro— y se marcan como “Aún no comprobado”: no cuentan ni a favor ni en contra.`
  );
}

function buildGuide(id: "guion-1" | "guion-2", title: string, specs: readonly StepSpec[], input: DemoWorkspaceInput): DemoGuideView {
  const steps = specs.map((spec) => stepView(spec, input));
  const checkable = steps.filter((s) => s.evidenceState !== "no_comprobable");
  const done = checkable.filter((s) => s.evidenceState === "hecho").length;
  const notCheckableCount = steps.length - checkable.length;
  return {
    id,
    title,
    steps,
    checkableCount: checkable.length,
    doneCount: done,
    progressLine: progressLine(done, checkable.length, notCheckableCount),
  };
}

/**
 * `hayPuntoDePartida` (§5.3.4): reloj sin desplazamiento Y cero llamadas Y
 * cero registros de inasistencia Y cero grupos. Es una LUZ, no un paso: no
 * entra en ningún numerador ni denominador de progreso (enmienda B3).
 *
 * *(Corregido 2026-08-05 tras revisión adversarial de la capacidad 3,
 * hallazgo B2.)* Las cuatro condiciones originales ignoraban POR COMPLETO el
 * mundo de la lista de espera: tras un recorrido entero del guion 2 (alta,
 * cancelación, aviso, aceptación, conversión…) el reloj sigue sin moverse, no
 * hay ninguna llamada, ningún registro de inasistencia y ningún grupo — así
 * que esta luz seguía diciendo, en verde, «Estás en el punto de partida:
 * puedes empezar» con «Comprobados 7 de 8 pasos» delante, una contradicción
 * a la vista. Ahora también exige que las cinco cifras de la lista de espera
 * que el guion 2 mueve estén a cero, y — para que un futuro guion que mueva
 * otra cosa no pueda repetir el mismo defecto — que los dos guiones tengan
 * `doneCount === 0`: si algún paso de cualquiera de los dos se ha dado por
 * hecho, el mundo ya no es el de un reinicio recién hecho.
 */
function hayPuntoDePartida(input: DemoWorkspaceInput, guides: readonly DemoGuideView[]): boolean {
  const w = input.waitlist.metrics;
  return (
    input.operations.clock.advancedByMinutes === 0 &&
    input.metrics.callsHandled === 0 &&
    input.operations.noShows.records.length === 0 &&
    input.operations.groups.items.length === 0 &&
    w.waitlistOptInsRecorded === 0 &&
    w.waitlistOptInsDeclined === 0 &&
    w.slotsReleasedTotal === 0 &&
    w.conversions === 0 &&
    w.noticesSimulated === 0 &&
    guides.every((g) => g.doneCount === 0)
  );
}

// ---------------------------------------------------------------------
// step 20 — TALLER DE DECISIONES CON BRUNO (design §2.3, §8).
//
// La vista del catálogo de decisiones: espejo de solo lectura de
// `decisionCatalog.ts`, compuesto UNA VEZ al cargar el módulo y congelado
// (D20-50) — `buildDemoWorkspace()` devuelve siempre la misma referencia, lo
// que hace de I20-13 (dos GET seguidos dan lo mismo) una propiedad de
// construcción, no de disciplina. Ningún campo de esta vista se deriva en el
// cliente (I20-3); `order` NO viaja (D20-56): el orden es la posición del
// array `entries`, que aquí se emite ya ordenado.
//
// AVISO para quien toque estas constantes (I20-16, §9.2.2): toda CLAVE de
// estos tres catálogos viaja en la instantánea y la lista negra de datos
// personales (tests/console/console.test.ts) prohíbe, por SUBCADENA, claves
// con «name», «nombre», «telefono», «email»… Están prohibidas claves tan
// naturales como `nombreDelBloque` o `sinNombre`.
// ---------------------------------------------------------------------

/** §8.1–§8.5 — copy del panel del taller. La ÚNICA fuente de cada frase. */
export const WORKSHOP_COPY = {
  heading: "Taller de decisiones con Bruno",
  permanentLabel: "Borrador local · No aprueba nada · No cambia nada en la demostración",
  introNote:
    "Esto es una ayuda para hablar con Bruno, no un formulario de decisiones. Marcar una opción anota lo que se ha dicho en la conversación: no la aprueba, no la aplica y no cambia ni una coma de lo que hace la demostración.",
  draftNote:
    "El borrador vive sólo en esta pestaña, mientras esté abierta. No se guarda en ningún sitio, no se envía a ninguna parte y recargar la página entera lo borra. Si quieres conservarlo, copia el acta antes de recargar.",
  resetNote:
    "Reiniciar la demostración no borra este borrador, ni cambia el filtro ni lo que hayas buscado: son cosas distintas. El reinicio borra el mundo de la demostración; esto es lo que habéis hablado sobre él.",
  conservativeNote:
    "Lo que la demostración hace hoy es lo más conservador que puede hacer mientras nadie decide. Es la prueba de lo que existe, nunca la respuesta de Bruno.",
  orderNote:
    "El orden de los bloques es el orden recomendado para hablarlos, no una prioridad de respuesta y no una recomendación de ninguna opción.",
  searchScopeNote:
    "La búsqueda mira los identificadores, la pregunta y lo que hace hoy la demostración. No busca dentro de las opciones, a propósito: resaltar unas opciones y otras no sería empujar la conversación.",
  overlappingFiltersNote:
    "«Sin respuesta» y «Con borrador anotado» no son contrarios: una pregunta con nota pero sin opción marcada sale en los dos.",
  /**
   * (Revisión U11-12, 2026-08-06) La decisión deliberada del §3.11 punto 1
   * —marcar no re-filtra, para no esconder la tarjeta bajo la mano de quien
   * la marca— era invisible y parecía un fallo del filtro. Se dice, en
   * permanente, junto a las otras notas de filtro.
   */
  noRefilterNote:
    "La lista no se recoloca sola mientras anotas: pulsa otra vez el filtro para volver a aplicarlo.",
  /**
   * Fase 6 (2026-08-06) — tres piezas del panel que el §8 del diseño no
   * llegó a enumerar y que E20-1/I2 obligan a servir desde aquí, nunca a
   * escribir en el cliente: el rótulo del desplegable de cada bloque
   * (§3.4), el sufijo de minutos del encabezado de bloque, y la plantilla
   * —prefijo singular/plural + sufijo— de la línea de resultados del
   * filtro y la búsqueda (§3.11, punto 4). El navegador sólo concatena.
   */
  blockDetailsSummary: "Por qué se habla en este orden",
  blockMinutesSuffix: " min",
  resultsSingularPrefix: "Se enseña ",
  resultsPluralPrefix: "Se enseñan ",
  // (Revisión U11-5, 2026-08-06) «tarjetas del taller», no «filas del
  // catálogo»: la cobertura ya dice «de 32 preguntas J/K» cinco líneas más
  // abajo y dos «32» con dos nombres distintos obligaban a preguntarse si
  // eran la misma cosa. Lo que se enseña o se oculta son tarjetas.
  resultsSuffix: " de las 32 tarjetas del taller.",
  /**
   * (Revisión U11-6, 2026-08-06) El caso CERO con su frase propia: «Se
   * enseñan 0 de las 32…» leía mal y no decía qué hacer. No se reutiliza el
   * nodo de «el catálogo no ha llegado» (§3.13): son dos hechos distintos.
   */
  resultsNone: "No se enseña ninguna de las 32 tarjetas: prueba a borrar la búsqueda o a pulsar «Todas».",
  // §8.2 — tarjeta.
  todayHeading: "Lo que hace hoy la demostración",
  /** Cola de la leyenda; la leyenda entera viaja YA resuelta en `entry.legendLabel` (D20-47). */
  legendTail: " — Qué se anota como respuesta provisional",
  nothingMarkedNote: "Nada está marcado hasta que lo marques tú.",
  pillBlocking: "Bloquea un piloto",
  pillCanWait: "Puede esperar",
  detailsSummary: "Dependencias, urgencia y lo que hoy no existe",
  dependenciesNote: "Conviene mirarlas a la vez: decidir una sin la otra puede contradecirla.",
  notImplementedHeading: "Lo que hoy no existe en ningún sitio",
  noteFieldTag: "Nota corta (opcional)",
  notePrivacyNote: "No escribas nombres, teléfonos ni otros datos personales.",
  noteCounterSuffix: " de 280",
  noteTruncatedStatus: "La nota se ha cortado a 280 caracteres.",
  clearOneButton: "Borrar este borrador",
  clearedStatusPrefix: "Borrado el borrador de ",
  clearedStatusSuffix: ". No ha cambiado nada en la demostración.",
  nothingToClearPrefix: "No había nada anotado en ",
  nothingToClearSuffix: ".",
  // §3.13 — estados de error del panel.
  emptyStateNote:
    "El catálogo todavía no ha llegado. Si esto no cambia en unos segundos, mira si la demostración está en marcha.",
  orphanHeading: "Anotaciones sin fila en el catálogo actual",
  /**
   * (Revisión U11-16, 2026-08-06) El grupo de huérfanas ignora filtros y
   * búsqueda a propósito (no son entradas del catálogo y esconderlas sería
   * perderlas otra vez): esta frase servida lo dice en el propio grupo.
   * Sólo se pinta en el panel; el acta no la usa.
   */
  orphanUnfilteredNote: "Estas anotaciones no se filtran ni se buscan: se enseñan siempre.",
  /**
   * (Revisión adversarial 2026-08-06, A9-5) Si la composición del texto
   * falla (la aserción de los 280 de D20-49.3, defensa en profundidad
   * inalcanzable en uso normal porque el manejador oninput recorta), el
   * operador no puede quedarse mirando un botón que no hace nada: la línea
   * de estado dice, con esta frase servida, que no se ha copiado nada y que
   * su borrador sigue como estaba.
   */
  composeFailedStatus: "No se ha podido componer el texto, así que no se ha copiado nada. El borrador sigue intacto.",
  // §8.3 — cobertura. Plantillas de N partes (E20-1): el navegador sólo
  // concatena, nunca conjuga ni escribe una frase propia.
  coverage: {
    answeredPrefix: "Con respuesta anotada: ",
    answeredSuffix: " de 32 preguntas J/K.",
    sharedAnswerNote: "(J5 y K1 comparten una sola respuesta y cuentan por dos.)",
    lDone: "L1: anotada.",
    lPending: "L1: sin anotar.",
    blockingPendingPluralPrefix: "Siguen sin respuesta ",
    blockingPendingSingularPrefix: "Sigue sin respuesta ",
    blockingPendingSuffix: " de las 7 preguntas que bloquean un piloto: ",
    blockingNonePending: "Ninguna de las 7 preguntas que bloquean un piloto se ha quedado sin anotar.",
    meaningNote: "Esto mide cuánto se ha anotado, no cuánto se ha aprobado.",
  },
  // §8.4 — diálogo de borrado total.
  dialog: {
    title: "Borrar todos los borradores",
    /**
     * (Revisión U11-11, 2026-08-06) Con el borrador vacío, la plantilla de
     * N partes componía «Vas a borrar 0 respuestas anotadas y 0 notas. No
     * se puede deshacer.» — una amenaza sobre nada. Variante servida entera
     * para el caso de los dos ceros.
     */
    bodyNothing: "No hay nada anotado: no se va a borrar nada.",
    bodyPrefix: "Vas a borrar ",
    bodyAnswersPlural: " respuestas anotadas",
    bodyAnswersSingular: " respuesta anotada",
    bodyJoiner: " y ",
    bodyDraftNotesPlural: " notas",
    bodyDraftNotesSingular: " nota",
    bodySuffix: ". No se puede deshacer.",
    scopeNote: "Esto no cambia nada en la demostración: sólo borra lo que has anotado en esta pantalla.",
    confirmTag: "Borrar todo",
    cancelTag: "Cancelar",
    clearedStatus: "Borrador vaciado. No ha cambiado nada en la demostración.",
  },
} as const;

/**
 * §4 — frases fijas del acta provisional. El navegador las CONCATENA, nunca
 * las escribe (E20-1); toda línea de estructura del acta existe carácter a
 * carácter aquí, y ninguna empieza por «> », que queda reservado a texto del
 * operador (I20-9).
 */
export const ACTA_COPY = {
  buttonTag: "Copiar acta provisional",
  copiedStatus: "Acta copiada al portapapeles.",
  backupAria: "Texto del acta, para copiarlo a mano",
  title: "ACTA PROVISIONAL — CONVERSACIÓN DE DECISIONES CON BRUNO",
  subtitle: "Demo Salon · Consola de operador · Demostración local",
  permanentLine: "Demo local · Datos sintéticos · No es evidencia de un piloto real.",
  notADecisionNote:
    "ESTO NO ES UNA DECISIÓN APROBADA. Es un borrador de trabajo escrito a mano por un operador durante una conversación. Nada de lo que hay aquí se ha implementado, nada se ha aplicado a ningún sistema, nada ha cambiado el comportamiento de la demostración y nada compromete a nadie. Mientras una pregunta no tenga respuesta aprobada, sigue vigente el comportamiento conservador que la demostración ya enseña.",
  catalogPrefix: "Catálogo: ",
  sourcePrefix: "Fuente humana: ",
  noStampNote:
    "Este texto no lleva fecha, ni firma, ni identidad de quien lo escribió: no es un acta aprobada, es una copia de trabajo.",
  separator: "____________________________________________________________",
  sectionAnnotated: "1. LO QUE SE ANOTÓ",
  sectionBlockingPending: "2. SIGUEN SIN RESPUESTA Y BLOQUEAN UN PILOTO",
  sectionAllPending: "3. TODO LO QUE SIGUE SIN RESPUESTA",
  sectionClosing: "4. QUÉ HACER CON ESTE TEXTO",
  identifiersPrefix: "(identificadores: ",
  identifiersSuffix: ")",
  questionPrefix: "Pregunta: ",
  optionPrefix: "Opción anotada: ",
  dependsPrefix: "Depende de: ",
  urgencyPrefix: "Urgencia: ",
  noteHeading: "Nota del operador (texto sin verificar, escrito a mano durante la reunión):",
  noneAnnotated: "No se anotó ninguna respuesta.",
  /**
   * (Revisión adversarial 2026-08-06, A9-1) Sección propia para las notas
   * escritas SIN opción marcada: antes se perdían del acta en silencio
   * aunque el panel las contaba en «Con borrador anotado». No cuentan como
   * respuesta en ningún denominador: la entrada sigue saliendo entre las
   * pendientes. Misma etiqueta de desconfianza que el resto de notas.
   */
  notesWithoutAnswerHeading: "NOTAS SIN RESPUESTA ANOTADA (texto sin verificar)",
  blockingNonePending:
    "Ninguna de las preguntas que bloquean un piloto se quedó sin anotar. Eso no significa que estén aprobadas: significa que se anotó algo sobre cada una.",
  pendingPrefix: "Sin respuesta anotada: ",
  pendingSuffix: " de las 32 preguntas J/K",
  /** Constante condicional (E20-1): se añade entera o se omite, nunca se construye. */
  pendingLTail: ", y L1.",
  pendingTail: ".",
  closingLines: [
    "Nada de esto está implementado ni aprobado. Antes de crear ninguna misión de implementación, hay que repasar este texto con Bruno y confirmar, pregunta por pregunta, que dice lo que él dijo.",
    "Para la captura definitiva de cada decisión, usar la plantilla de docs/operator_console/DECISION_PACK_TEMPLATE.md, que pide también el porqué en palabras del propietario.",
    "Las preguntas que sigan pendientes se citan por su identificador en el encargo de la misión futura, como manda el §9 del pack, para que la siguiente implementación no las responda por su cuenta.",
  ],
} as const;

/** §5 — frases fijas del borrador de misión no ejecutable. Mismas reglas que ACTA_COPY. */
export const MISION_COPY = {
  buttonTag: "Preparar borrador de siguiente misión",
  copiedStatus: "Borrador copiado al portapapeles.",
  backupAria: "Texto del borrador de misión, para copiarlo a mano",
  title: "BORRADOR NO EJECUTABLE — REVISIÓN HUMANA OBLIGATORIA",
  sectionZero: "0. QUÉ ES ESTO, Y QUÉ NO ES",
  zeroNote:
    "Este texto se ha generado a partir de las opciones que una persona marcó a mano en el taller de decisiones, y de nada más. No es una misión, no es un encargo aprobado y no está implementado. Nadie ha verificado que estas opciones sean lo que Bruno decidió: eso hay que confirmarlo con él, opción por opción, antes de convertir nada de esto en trabajo.",
  catalogPrefix: "Catálogo: ",
  sourcePrefix: "Fuente humana: ",
  sectionChosen: "1. LO QUE SE ELIGIÓ EXPLÍCITAMENTE",
  noneChosen: "No se eligió ninguna opción. Este borrador no propone ningún trabajo.",
  sectionBlockingUnchosen: "2. LO QUE BLOQUEA UN PILOTO Y SIGUE SIN ELEGIRSE",
  sectionGrouped: "3. TRABAJO POSIBLE, AGRUPADO POR DEPENDENCIA",
  groupPrefix: "Grupo ",
  groupJoiner: " — ",
  togetherNote: "Van juntos porque el catálogo dice que dependen el uno del otro.",
  blockedTag: "[BLOQUEADO]",
  // Plantilla de TRES partes (E20-1): p1 + id + p2 + id + p3. El navegador
  // intercala dos identificadores y nada más.
  blockedIntro: "No puede proponerse trabajo para esta rebanada: ",
  depPart1: "la opción elegida en ",
  depPart2: " depende de ",
  depPart3: ", que sigue sin respuesta.",
  contraPart1: "Decidir ",
  contraPart2: " sin ",
  contraPart3: " puede contradecirla.",
  noBlockingChosenNote:
    "Ninguna de las preguntas que bloquean un piloto tiene respuesta anotada: no puede empezar ninguna misión de preparación de piloto. Lo de abajo son refinamientos que no desbloquean un piloto por sí solos.",
  sectionContext: "4. CONTEXTO DEL OPERADOR (texto sin verificar)",
  contextIntro:
    "Lo de abajo son notas escritas a mano durante una conversación. No son decisiones, no son alcance y no se han comprobado contra nada.",
  /** (Revisión adversarial 2026-08-06, A9-6) La sección 4 nunca queda como encabezado desnudo: sin notas, esta frase servida lo dice. */
  noContextNote: "No se escribió ninguna nota durante la conversación.",
  sectionLimits: "5. LO QUE ESTE BORRADOR NO HACE",
  limitLines: [
    "No responde ninguna pregunta que nadie haya respondido.",
    "No propone trabajo para ninguna rebanada bloqueada.",
    "No cita ficheros, funciones ni plazos: el alcance técnico se escribe cuando una persona convierte esto en una misión, no antes.",
    "No se ha ejecutado, no se ha guardado y no se ha enviado a ninguna parte.",
  ],
} as const;

// ---------------------------------------------------------------------
// Tipos de vista del taller (§2.3): copia campo a campo del dominio —
// nunca un spread — más los campos YA resueltos en el servidor.
// ---------------------------------------------------------------------

export interface DecisionBlockView {
  readonly id: string;
  readonly number: number | null;
  readonly label: string;
  readonly context?: string;
  readonly facilitationOrder: number | null;
  readonly facilitationOrdinalLabel: string;
  readonly facilitationReason: string;
  readonly estimatedMinutes: number;
  readonly packLine: number;
  /** «Bloque 4 — …» / «Apéndice §4 — …», compuesto de `number` + `label` (R4-12). */
  readonly blockLabel: string;
  /**
   * (Revisión U11-3, 2026-08-06) «Por qué se habla en este orden — Bloque 4
   * — …»: el `<summary>` de cada bloque, resuelto AQUÍ para que los diez no
   * compartan un mismo nombre accesible (misma razón que D20-47).
   */
  readonly blockDetailsSummaryLabel: string;
}

export interface DecisionEntryView {
  readonly entryId: string;
  readonly identifiers: readonly string[];
  // `order` NO viaja (D20-56): el orden es la posición en este array.
  readonly blockId: string;
  readonly question: string;
  readonly questionAside?: string;
  /**
   * (Revisión U11-4, 2026-08-06) La variante DE PANTALLA del aparte, sin
   * las marcas de énfasis de Markdown que el verbatim conserva: el panel
   * pinta con textContent y los asteriscos salían literales. El campo
   * `questionAside` de arriba sigue VERBATIM del pack — el acta y la puerta
   * de deriva (§2.11) usan ése, nunca éste. La cursiva la pone el CSS.
   */
  readonly questionAsideDisplay?: string;
  readonly currentBehaviour: string;
  readonly notImplementedNote?: string;
  readonly options: readonly DecisionOption[];
  readonly dependsOn: readonly string[];
  readonly externalDependencies: readonly string[];
  readonly urgency: DecisionUrgency;
  readonly packLine: number;
  /** «J5 y K1» / «J1» — el título de la tarjeta no se compone en el cliente. */
  readonly identifiersLabel: string;
  /** «Bloquea un piloto» / «Puede esperar». */
  readonly urgencyPillLabel: string;
  /**
   * «J5/K1 — Qué se anota como respuesta provisional» (D20-47): cada
   * `<legend>` lleva su identificador, resuelta AQUÍ para que el navegador
   * nunca concatene. Las 32 son distintas entre sí (§9.6.1).
   */
  readonly legendLabel: string;
  /**
   * (Revisión U11-3, 2026-08-06) «Dependencias, urgencia y lo que hoy no
   * existe — K13»: el `<summary>` del detalle de cada tarjeta, resuelto
   * AQUÍ (misma razón que D20-47: 32 nombres accesibles idénticos dejan al
   * lector de pantalla sin ancla).
   */
  readonly detailsSummaryLabel: string;
  /**
   * (Revisión U11-1, 2026-08-06) «Borrar este borrador — J5/K1»: el nombre
   * accesible del botón de borrado de cada tarjeta, resuelto AQUÍ (misma
   * razón que D20-47: 32 botones con el mismo nombre son indistinguibles
   * en la lista de controles de un lector de pantalla).
   */
  readonly clearButtonLabel: string;
}

export interface DecisionWorkshopView {
  /** «step 20 · catálogo v1». Va en el acta y en el borrador de misión. */
  readonly catalogVersion: string;
  readonly sourceDocument: string;
  /**
   * Huella determinista del catálogo servido, para que el cliente decida en
   * O(1) si tiene que repintar (D20-20). FNV-1a de 32 bits (D20-50) sobre la
   * concatenación de todos los textos: cambia cuando cambia el contenido.
   */
  readonly fingerprint: string;
  readonly copy: typeof WORKSHOP_COPY;
  readonly acta: typeof ACTA_COPY;
  readonly mision: typeof MISION_COPY;
  readonly blocks: readonly DecisionBlockView[];
  readonly entries: readonly DecisionEntryView[];
  readonly totals: DecisionCatalogTotals;
}

/**
 * FNV-1a de 32 bits, en hexadecimal. Ocho líneas de aritmética entera, sin
 * dependencia nueva, sin pretensión criptográfica: sólo tiene que cambiar
 * cuando cambia el contenido (R4-16).
 */
function fnv1a32(texto: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < texto.length; i += 1) {
    hash ^= texto.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * (Revisión adversarial 2026-08-06, A9-4) Serialización determinista para la
 * huella: claves ordenadas en cada nivel, para que el resultado dependa del
 * CONTENIDO servido y nunca del orden de inserción. Los valores `undefined`
 * se omiten, igual que los omite la serialización de la instantánea.
 */
function serializacionEstable(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(serializacionEstable).join(",")}]`;
  const objeto = valor as Record<string, unknown>;
  const trozos = Object.keys(objeto)
    .sort()
    .filter((k) => objeto[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${serializacionEstable(objeto[k])}`);
  return `{${trozos.join(",")}}`;
}

/**
 * (Revisión adversarial 2026-08-06, A9-4) La huella, función PURA del
 * contenido servido ENTERO. D20-50 promete «todos los textos» y la primera
 * implementación sólo cubría versión, pregunta, comportamiento, opciones,
 * etiqueta de urgencia y dependencias internas: un redespliegue que sólo
 * cambiara una frase de copia, un campo de bloque, una `notImplementedNote`,
 * una dependencia externa, un identificador o una leyenda no repintaba
 * jamás una pestaña abierta. Ahora la entrada es TODO lo que viaja en la
 * vista salvo la propia huella — los tres catálogos de copia incluidos, en
 * orden determinista de claves (la serialización de arriba). Se calcula una
 * vez por carga de módulo (D20-50): el coste sigue siendo nulo.
 */
export function decisionWorkshopFingerprint(contenido: unknown): string {
  return fnv1a32(serializacionEstable(contenido));
}

/** La huella que alimenta la vista (§2.3, D20-50): la del contenido servido entero, derivado del catálogo dado (A9-4). */
export function decisionCatalogFingerprint(catalog: typeof DECISION_CATALOG): string {
  return decisionWorkshopFingerprint(contenidoServidoDelTaller(catalog));
}

/**
 * (Revisión adversarial 2026-08-06, A9-4) Todo lo que la vista sirve MENOS
 * la huella: la entrada exacta de `decisionWorkshopFingerprint`, para que la
 * huella no pueda quedarse por detrás de lo servido por construcción.
 */
type ContenidoServidoDelTaller = Omit<DecisionWorkshopView, "fingerprint">;

function contenidoServidoDelTaller(catalog: typeof DECISION_CATALOG): ContenidoServidoDelTaller {
  const blocks: DecisionBlockView[] = catalog.blocks.map((b) => {
    const blockLabel = b.number === null ? `Apéndice §4 — ${b.label}` : `Bloque ${String(b.number)} — ${b.label}`;
    return {
      id: b.id,
      number: b.number,
      label: b.label,
      ...(b.context !== undefined ? { context: b.context } : {}),
      facilitationOrder: b.facilitationOrder,
      facilitationOrdinalLabel: b.facilitationOrdinalLabel,
      facilitationReason: b.facilitationReason,
      estimatedMinutes: b.estimatedMinutes,
      packLine: b.packLine,
      blockLabel,
      // (U11-3) Diez <summary> distintos, resueltos aquí — nunca en el cliente.
      blockDetailsSummaryLabel: `${WORKSHOP_COPY.blockDetailsSummary} — ${blockLabel}`,
    };
  });

  // El array viaja YA ordenado por el `order` del dominio (D20-56): el orden
  // es la posición, y el cliente no lee ningún número de orden porque no se
  // le publica ninguno.
  const entries: DecisionEntryView[] = [...catalog.entries]
    .sort((a, b) => a.order - b.order)
    .map((e) => {
      const identifiersLabel = e.identifiers.join(" y ");
      return {
        entryId: e.entryId,
        identifiers: e.identifiers,
        blockId: e.blockId,
        question: e.question,
        ...(e.questionAside !== undefined ? { questionAside: e.questionAside } : {}),
        // (U11-4) La variante de pantalla del aparte: sin los asteriscos de
        // énfasis de Markdown, que con textContent salían literales. El
        // verbatim de arriba no se toca: es el que comparan el acta y la
        // puerta de deriva (§2.11).
        ...(e.questionAside !== undefined ? { questionAsideDisplay: e.questionAside.replace(/\*/g, "") } : {}),
        currentBehaviour: e.currentBehaviour,
        ...(e.notImplementedNote !== undefined ? { notImplementedNote: e.notImplementedNote } : {}),
        options: e.options,
        dependsOn: e.dependsOn,
        externalDependencies: e.externalDependencies,
        urgency: e.urgency,
        packLine: e.packLine,
        identifiersLabel,
        urgencyPillLabel: e.urgency.kind === "bloquea" ? WORKSHOP_COPY.pillBlocking : WORKSHOP_COPY.pillCanWait,
        // D20-47: la leyenda «debe ser» `J5/K1 — Qué se anota como respuesta
        // provisional` — el ancla del lector de pantalla es el entryId, la
        // clave de la tarjeta, no la variante «J5 y K1» del título.
        legendLabel: `${e.entryId}${WORKSHOP_COPY.legendTail}`,
        // (U11-3 / U11-1) Treinta y dos <summary> y treinta y dos botones de
        // borrado con nombre accesible PROPIO, resueltos aquí como la leyenda.
        detailsSummaryLabel: `${WORKSHOP_COPY.detailsSummary} — ${e.entryId}`,
        clearButtonLabel: `${WORKSHOP_COPY.clearOneButton} — ${e.entryId}`,
      };
    });

  return {
    catalogVersion: catalog.version,
    sourceDocument: catalog.sourceDocument,
    copy: WORKSHOP_COPY,
    acta: ACTA_COPY,
    mision: MISION_COPY,
    blocks,
    entries,
    totals: catalog.totals,
  };
}

export function buildDecisionWorkshopView(): DecisionWorkshopView {
  const contenido = contenidoServidoDelTaller(DECISION_CATALOG);
  return {
    catalogVersion: contenido.catalogVersion,
    sourceDocument: contenido.sourceDocument,
    // (A9-4) La huella se calcula sobre el MISMO objeto que se sirve: no hay
    // ninguna enumeración a mano que pueda quedarse corta otra vez.
    fingerprint: decisionWorkshopFingerprint(contenido),
    copy: contenido.copy,
    acta: contenido.acta,
    mision: contenido.mision,
    blocks: contenido.blocks,
    entries: contenido.entries,
    totals: contenido.totals,
  };
}

/**
 * D20-50 — la vista se compone UNA VEZ, al cargar el módulo, y se congela en
 * profundidad. `buildDemoWorkspace()` devuelve SIEMPRE esta misma
 * referencia: no se reconstruye por instantánea, así que el coste por sondeo
 * es exclusivamente el de serializar, y dos GET seguidos dan lo mismo por
 * construcción (I20-13).
 */
const DECISION_WORKSHOP_VIEW: DecisionWorkshopView = congelarEnProfundidad(buildDecisionWorkshopView());

// ---------------------------------------------------------------------
// El conjunto entero
// ---------------------------------------------------------------------

export function buildDemoWorkspace(input: DemoWorkspaceInput): DemoWorkspaceView {
  const guides = [
    buildGuide("guion-1", "Guion 1 · Inasistencias y reserva para varias personas", GUIDE_1_STEPS, input),
    buildGuide("guion-2", "Guion 2 · Lista de espera y cancelaciones", GUIDE_2_STEPS, input),
  ];
  const ready = hayPuntoDePartida(input, guides);
  return {
    startingPoint: {
      ready,
      label: ready ? GUIDE_COPY.startingPointReadyLabel : GUIDE_COPY.startingPointNotReadyLabel,
    },
    summary: buildSummary(input),
    guides,
    taskLedger: { copy: HUMAN_TASK_LEDGER_COPY },
    decisionWorkshop: DECISION_WORKSHOP_VIEW,
  };
}
