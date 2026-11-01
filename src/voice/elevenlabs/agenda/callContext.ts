import { addDays, isValidDateISO } from "../../../callEngine/domain/time.js";
import type { Clock } from "../../../callEngine/domain/types.js";
import { dayPhraseEs, parseDateTime } from "../../../utils/dateFormatterEs.js";
import { MADRID_TIME_ZONE } from "./madridClock.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LA FECHA QUE EL AGENTE DE VOZ RECIBE, CALCULADA DONDE VIVE LA VERDAD.
 *
 * El prompt del agente de ElevenLabs deja de llevar la fecha escrita a mano:
 * cada llamada saliente inyecta variables dinámicas. Una fecha escrita a mano
 * caduca al día siguiente y nadie se entera hasta que el agente ofrece «el
 * martes» de la semana pasada; una fecha calculada por el lanzador de
 * llamadas caduca en cuanto ese lanzador y el puente discrepan sobre qué es
 * «hoy» o hasta dónde llega la ventana.
 *
 * Por eso el contexto se calcula AQUÍ, a partir del MISMO `Clock` y del MISMO
 * `horizonDays` que usa el rechazo 422 de `server.ts`. Un lanzador externo
 * hace `GET /health` y copia los valores tal cual: no recalcula nada, así que
 * no puede equivocarse por su cuenta. Si el puente y el prompt se desviaran,
 * el agente prometería por teléfono un día que el puente rechaza con un 422 —
 * que es exactamente el fallo que este módulo existe para hacer imposible.
 *
 * TRES DECISIONES QUE SOSTIENEN LA CORRECCIÓN:
 *
 *  1. EL RELOJ SE LEE UNA SOLA VEZ. `today_iso` y `today_spoken_es` salen de
 *     la misma cadena `YYYY-MM-DD`, no de dos lecturas del reloj. A las
 *     23:59:59.9 de Madrid, dos lecturas separadas pueden caer en días
 *     distintos y el agente diría en voz alta «lunes 24» mientras el puente
 *     ya está en el 25. Aquí eso no puede pasar: la fecha hablada es una
 *     FUNCIÓN de la fecha ISO.
 *
 *  2. LA FECHA HABLADA SALE DEL MISMO CASTELLANO QUE HABLA EL AGENTE.
 *     `utils/dateFormatterEs.ts` es la tabla de días y meses con la que el
 *     motor construye TODAS sus frases (`callEngine/phrasing/es.ts`), así que
 *     el «miércoles» del prompt y el «miércoles» de la respuesta de una
 *     herramienta salen de la misma línea de código y no pueden desviarse.
 *     Se descartó `Intl.DateTimeFormat("es-ES")` a propósito por dos motivos:
 *     devuelve «lunes, 24 de agosto de 2026» —con una coma que es un detalle
 *     de ICU y puede cambiar entre versiones de Node— y, sobre todo, un Node
 *     compilado con `small-icu` en el VPS diría la fecha EN INGLÉS por
 *     teléfono sin que nada fallara. Aquí no hay datos de locale que puedan
 *     faltar.
 *
 *  3. LA SUMA DE DÍAS ES LA DEL DOMINIO. `addDays` pivota sobre mediodía UTC
 *     (ver `callEngine/domain/time.ts`), así que ni los cambios de hora ni la
 *     zona del servidor pueden mover la ventana un día. Fin de mes y fin de
 *     año salen gratis por construcción.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Lo que el lanzador de llamadas inyecta como `dynamic_variables`. Los nombres
 * van en `snake_case` a propósito: son los del JSON de `/health` y los del
 * prompt, no identificadores internos de TypeScript.
 */
export interface CallDateContext {
  /** «Hoy» en Europe/Madrid, `YYYY-MM-DD`. El mismo que rechaza el pasado. */
  readonly today_iso: string;
  /** El mismo día, dicho en voz alta: «lunes 24 de agosto de 2026». */
  readonly today_spoken_es: string;
  /** Último día que el puente admite, INCLUSIVE: `today_iso + horizonDays`. */
  readonly window_end_iso: string;
  /** La zona del dominio. Nunca la del servidor. */
  readonly timezone: typeof MADRID_TIME_ZONE;
}

/**
 * «2026-08-24» → «lunes 24 de agosto de 2026».
 *
 * Función PURA de la fecha: no lee ningún reloj, así que no existe ningún
 * instante que pueda discrepar del día que se le pide. `dayPhraseEs` pone el
 * día de la semana y el mes —los mismos que dice el motor— y aquí sólo se le
 * añade el año, que en el prompt sí hace falta: una llamada de finales de
 * diciembre habla de días que ya son del año siguiente.
 *
 * Todo es aritmética de calendario sobre los componentes de la fecha, sin
 * convertir a instante UTC en ningún punto: exactamente la regla del dominio
 * (`callEngine/domain/time.ts`), y por eso los cambios de hora no la rozan.
 */
export function spokenDateES(dateISO: string): string {
  const parsed = isValidDateISO(dateISO) ? parseDateTime(dateISO) : null;
  if (parsed === null) {
    throw new Error(`spokenDateES esperaba una fecha YYYY-MM-DD real y recibió «${dateISO}».`);
  }
  return `${dayPhraseEs(parsed)} de ${String(parsed.year)}`;
}

/**
 * El contexto de fecha de una llamada, a partir del reloj y del horizonte que
 * ya manda en el puente. `horizonDays` es INCLUSIVO —`6` significa `[hoy,
 * hoy+6]`, siete días— exactamente igual que en el rechazo 422.
 *
 * Falla ruidosamente ante un horizonte imposible en vez de devolver una
 * ventana inventada: una `window_end_iso` mal calculada acaba dicha en voz
 * alta a un cliente, y prefiero un `/health` que se queja a un agente que
 * promete un día que el puente va a rechazar.
 */
export function callDateContext(clock: Clock, horizonDays: number): CallDateContext {
  if (!Number.isFinite(horizonDays) || horizonDays < 0) {
    throw new Error(
      `callDateContext esperaba un horizonte de días finito y no negativo, y recibió «${String(horizonDays)}».`,
    );
  }
  // UNA sola lectura del reloj para los dos campos de «hoy».
  const todayISO = clock.nowISODate();
  return {
    today_iso: todayISO,
    today_spoken_es: spokenDateES(todayISO),
    // `Math.floor` reproduce el límite del 422 al pie de la letra: allí se
    // rechaza `distancia > horizonDays`, así que con un horizonte fraccionario
    // el último día admitido sigue siendo el entero de abajo.
    window_end_iso: addDays(todayISO, Math.floor(horizonDays)),
    timezone: MADRID_TIME_ZONE,
  };
}
