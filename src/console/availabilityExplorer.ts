import { addDays, compareDate, daysBetween, formatHHmm } from "../callEngine/domain/time.js";
import { SERVICE_LABELS, type Clock, type EmployeeId, type ServiceId } from "../callEngine/domain/types.js";
import type { CalendarWithCapabilities } from "../callEngine/capabilities.js";
import { canPerform } from "../callEngine/capabilities.js";
import {
  resolveDayWindows,
  freeStartsForDuration,
  isIntervalFree,
  isWithinHorizon,
  type CalendarLevel,
} from "../callEngine/calendar/resolveAvailability.js";
import type { Interval } from "../callEngine/calendar/slotGrid.js";
import { isStartInThePast } from "../callEngine/domain/slotTime.js";
import { chooseProfessional, explainChoice } from "../callEngine/allocation/anyProfessional.js";
import { dayPhraseEs, parseDateTime, type ParsedDateTime } from "../utils/dateFormatterEs.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 19 — CAPACITY 1: THE READ-ONLY SYNTHETIC AVAILABILITY EXPLORER
 * (design §3, §6.1, §8.2, §8.3).
 *
 * PURE, STATELESS, NO CLOCK OF ITS OWN. Every "now" arrives through the
 * injected `Clock`. No `Date.now()`, no `new Date()` with no argument, no
 * `Math.random()`, no timer, no mutation of `cal`, no event emission. This
 * module answers ONE question — "which half-hours does this synthetic
 * calendar leave free, and why" — with the SAME frozen engine functions the
 * real booking path uses (`resolveDayWindows`, `freeStartsForDuration`,
 * `isIntervalFree`, `isWithinHorizon`, `chooseProfessional`, `explainChoice`,
 * `canPerform`, `isStartInThePast`), plus eight small, already-existing date
 * and label helpers (§3.5.2). (step 26 §13 swapped the two availability
 * gates for their interval-aware siblings, which live in the SAME module and
 * ask the SAME `resolveDayWindows`: with no `durationMinutes` in the query
 * they are asked for a `cal.slotMinutes` block on the `cal.slotMinutes` grid,
 * which is the very question the old pair answered.) NOT ONE new rule of schedule, capability,
 * precedence, horizon or allocation is written here: if a ninth question
 * needed answering, the correct move is not to build this capacity, not to
 * invent an answer.
 *
 * WHY EVERYTHING ARRIVES RESOLVED. Same hard rule as `waitlistSnapshot.ts`
 * and `operationsSnapshot.ts`: every Spanish sentence below is composed HERE,
 * once, from an explicit allow-list of copy. The browser only ever prints
 * `AvailabilityExploreView` fields — it never derives a schedule reason, a
 * day motive or an incapacity note itself (I2).
 * ────────────────────────────────────────────────────────────────────────
 */

/** §3.4 — a visible, declared demonstration cap, never a performance limit. */
export const AVAILABILITY_EXPLORER_MAX_DAYS = 14;

export type AvailabilityExploreErrorCode =
  | "invalid_query"
  | "unknown_service"
  | "unknown_professional"
  | "range_backwards"
  | "range_too_long";

export interface AvailabilityExploreErrorBody {
  error: string;
  code: AvailabilityExploreErrorCode;
}

export interface AvailabilityExploreQuery {
  serviceId: ServiceId;
  mode: "any" | "one";
  /** Required (and pre-validated against the calendar) when `mode === "one"`. */
  employeeId?: EmployeeId;
  from: string;
  to: string;
  /**
   * step 26 §13 — OPCIONAL, y sólo lo manda el asistente de cita manual. Ya
   * viene validado con `isAllowedManualDuration` por el servidor: aquí no se
   * vuelve a comprobar, igual que no se vuelve a comprobar la fecha.
   *
   * SIN ÉL, ESTE MÓDULO SE COMPORTA EXACTAMENTE COMO SIEMPRE: media hora de
   * duración y rejilla de media hora. El panel «Comprobar huecos sintéticos»
   * no lo manda nunca.
   */
  durationMinutes?: number;
}

/**
 * Los DOS valores efectivos de una consulta, calculados UNA sola vez y pasados
 * hacia abajo (step 26 §13):
 *   `duration` — cuánto dura el bloque que se busca.
 *   `step`     — cada cuánto se prueba un inicio. Sin duración pedida, la
 *                rejilla de siempre; con duración pedida, 15 minutos, que es el
 *                paso en que el operador puede expresarla.
 */
interface EffectiveGrid {
  duration: number;
  step: number;
}

function effectiveGrid(cal: CalendarWithCapabilities, query: AvailabilityExploreQuery): EffectiveGrid {
  return query.durationMinutes === undefined
    ? { duration: cal.slotMinutes, step: cal.slotMinutes }
    : { duration: query.durationMinutes, step: 15 };
}

export interface AvailabilityExploreDayView {
  dateISO: string;
  /** "martes 4 de agosto" — SIN AÑO (§6.1, hallazgo A5, decisión m5). */
  dateLabel: string;
  considered: boolean;
  /** Sólo cuando `considered === false`. Motivo REAL, del calendario. */
  notConsideredLabel: string | null;
  slotCount: number;
}

/** Los cinco datos que sólo se leen dentro del `<details>` técnico (§8.3, I6). */
export interface AvailabilityExploreSlotTechnicalView {
  employeeIdLabel: string;
  serviceIdLabel: string;
  appliedLevelLabel: string;
  /** Sólo con `mode === "any"`. */
  anyProfessionalLabel: string | null;
  /** Sólo con `mode === "any"`. */
  anyProfessionalExplainerLabel: string | null;
}

export interface AvailabilityExploreSlotView {
  /** Clave de reconciliación del cliente. NO es una `slotKey` de dominio y no se pinta fuera del `<details>`. */
  key: string;
  dateISO: string;
  dateLabel: string;
  startLabel: string;
  endLabel: string;
  timeRangeLabel: string;
  serviceLabel: string;
  employeeId: EmployeeId;
  professionalLabel: string;
  whyLabel: string;
  /** Sólo con `mode === "any"`. */
  anyProfessionalNote: string | null;
  technical: AvailabilityExploreSlotTechnicalView;
}

export interface AvailabilityExploreView {
  query: {
    serviceLabel: string;
    modeLabel: string;
    fromLabel: string;
    toLabel: string;
    dayCountLabel: string;
  };
  cap: { maxDays: number; note: string };
  syntheticNote: string;
  orderNote: string;
  days: readonly AvailabilityExploreDayView[];
  slots: readonly AvailabilityExploreSlotView[];
  totalLabel: string;
  /** Sólo cuando `slots` está vacío y no hay una nota de incapacidad más concreta. */
  emptyLabel: string | null;
  /** Sólo cuando la persona elegida no hace el servicio elegido (mode === "one"). */
  noteLabel: string | null;
  computedAt: {
    engineToday: string;
    engineNowMinutes: number;
    confirmedReservationCount: number;
  };
}

/**
 * Toda cadena ESTÁTICA y visible de este panel (I2). Las plantillas con
 * datos (motivos de día, `whyLabel`, la nota de incapacidad) viven en las
 * funciones de más abajo, exactamente como `mismatchLabel` en
 * `waitlistSnapshot.ts`: compuestas aquí y en ningún otro sitio.
 */
export const AVAILABILITY_EXPLORER_COPY = {
  invalidQuery: "La consulta no es válida. Vuelve a elegir el servicio, a quién y las fechas.",
  unknownService: "Ese servicio no existe en esta demostración.",
  unknownProfessional: "Esa persona no está en el equipo de esta demostración.",
  rangeBackwards: "La fecha de fin es anterior a la de inicio.",
  rangeTooLong:
    "El rango no puede pasar de 14 días de una vez. Es un tope técnico de esta demostración local, no una regla de Demo Salon: pídelo en trozos más cortos.",
  capNote: "Como mucho 14 días de una vez. Es un tope técnico de esta demostración local, no una regla de Demo Salon.",
  syntheticNote:
    "Todos estos huecos son de la agenda sintética de esta demostración. No hay ninguna cita real detrás y desde aquí no se reserva nada.",
  orderNote:
    "Orden de lectura: por día, luego por hora, y a igualdad de hora por el identificador interno de cada persona del equipo, que es sólo un desempate estable. No es una recomendación: ninguna de estas opciones es mejor que otra, y esta pantalla no elige por nadie.",
  emptyState:
    "Con lo que has elegido, esta demostración no encuentra ninguna media hora libre. Eso no quiere decir que el local esté lleno: sólo que no hay ninguna con estos datos. Cambia el servicio, la persona o las fechas y vuelve a comprobar.",
  desfase: "La agenda ha cambiado desde esta comprobación. Vuelve a comprobar para verla al día.",
} as const;

// ---------------------------------------------------------------------
// Pequeños ayudantes de rótulo. Ninguno decide nada de negocio: sólo
// formatean lo que las nueve funciones de dominio ya han decidido.
// ---------------------------------------------------------------------

function professionalDisplayName(cal: CalendarWithCapabilities, employeeId: EmployeeId): string {
  const found = cal.professionals.find((p) => p.employeeId === employeeId);
  return found ? found.displayName : String(employeeId);
}

function dateLabelOf(dateISO: string): string {
  // Precondición: `dateISO` ya es "YYYY-MM-DD" válido — lo garantiza quien
  // llama (el servidor valida la consulta antes de invocar este módulo).
  return dayPhraseEs(parseDateTime(dateISO) as ParsedDateTime);
}

/**
 * El tramo RESIDUAL (tras restar reservas y ausencias, que es lo único que
 * `resolveDayWindows` devuelve) que de verdad CONTIENE este hueco concreto.
 *
 * *(Enmendado 2026-08-05 tras revisión adversarial de la capacidad 1,
 * hallazgo H3, y re-enmendado el mismo día tras re-verificación adversarial,
 * hallazgo R1.)* La redacción de H3 sustituyó "el horario declarado" por el
 * ENVOLVENTE de todas las ventanas del día (`Math.min`/`Math.max` sobre
 * todas ellas) — más correcto que citar el horario aprobado, pero TODAVÍA
 * falso en cuanto una reserva a media mañana parte el día en dos ventanas: el
 * envolvente vuelve a abarcar horas que, en medio, no están libres (en el día
 * de la demostración, con una reserva a media mañana para cada profesional,
 * la frase decía "tiene libre de 09:00 a 17:30" cuando la propia tarjeta,
 * dos líneas más abajo, mostraba una reserva de por medio). La única
 * afirmación que es SIEMPRE cierta es la de la ventana CONCRETA que contiene
 * este hueco — nunca la unión de todas las ventanas del día — y por eso este
 * ayudante busca esa única ventana, con la misma aritmética que decide qué
 * inicios son válidos.
 *
 * *(Corregido en step 26, revisión adversarial, hallazgo 5.)* Esta nota
 * terminaba diciendo que la búsqueda «no necesita respaldo», porque
 * `toSlots` sólo alinea inicios DENTRO de cada intervalo y nunca a caballo
 * entre dos. Eso dejó de ser cierto: `startsFitting` une los tramos adyacentes
 * antes de emitir inicios —dos tramos que se tocan son tiempo continuo—, así
 * que un bloque puede caber legítimamente a caballo de dos ventanas contiguas
 * y entonces NINGUNA ventana suelta lo contiene. Con el respaldo anterior
 * («cadena vacía») la tarjeta habría dicho «cae en un tramo libre de  a », que
 * es peor que no decir nada. El respaldo es ahora el propio intervalo del
 * hueco: siempre es cierto —ese bloque está libre, por construcción— y nunca
 * afirma de más sobre el tramo que lo rodea.
 */
function containingWindowBounds(windows: readonly Interval[], startMinutes: number, durationMinutes: number): { spanStart: string; spanEnd: string } {
  const containing = windows.find((w) => startMinutes >= w.startMinutes && startMinutes + durationMinutes <= w.endMinutes);
  if (!containing) {
    return { spanStart: formatHHmm(startMinutes), spanEnd: formatHHmm(startMinutes + durationMinutes) };
  }
  return { spanStart: formatHHmm(containing.startMinutes), spanEnd: formatHHmm(containing.endMinutes) };
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

/** El rótulo de la temporada activa ese día, si la hay — nunca escrito a mano (§3.6, punto 5). */
function activeSeasonLabel(cal: CalendarWithCapabilities, dateISO: string): string {
  const season = (cal.seasonalSchedules ?? []).find(
    (s) => s.approval === "approved" && compareDate(dateISO, s.startDate) >= 0 && compareDate(dateISO, s.endDate) <= 0,
  );
  return season ? season.label : "horario de temporada";
}

function pluralDays(n: number): string {
  return n === 1 ? "1 día" : `${String(n)} días`;
}

function pluralHuecos(n: number): string {
  if (n === 0) return "Ningún hueco.";
  if (n === 1) return "1 hueco.";
  return `${String(n)} huecos.`;
}

// ---------------------------------------------------------------------
// Motivos de día (§8.2). Cada frase se compone UNA vez, aquí.
// ---------------------------------------------------------------------

function pastDayLabel(dateISO: string): string {
  return `El ${dateLabelOf(dateISO)} ya ha pasado.`;
}

function horizonLabel(dateISO: string): string {
  return `El ${dateLabelOf(dateISO)} queda fuera del plazo en el que se puede reservar.`;
}

function venueClosureLabel(dateISO: string): string {
  return `El ${dateLabelOf(dateISO)} hay un cierre del local aprobado.`;
}

function venueNotOpenLabel(dateISO: string): string {
  return `El ${dateLabelOf(dateISO)} el local no abre.`;
}

function noSlotsLeftTodayLabel(dateISO: string): string {
  return `El ${dateLabelOf(dateISO)} no queda ninguna media hora libre antes de la hora actual.`;
}

function absenceLabel(dateISO: string, who: string): string {
  return `El ${dateLabelOf(dateISO)} ${who} tiene una ausencia aprobada.`;
}

function notWorkingLabel(dateISO: string, who: string): string {
  return `El ${dateLabelOf(dateISO)} ${who} no trabaja.`;
}

function occupiedForServiceLabel(dateISO: string, serviceLabel: string): string {
  return `El ${dateLabelOf(dateISO)} no queda ninguna media hora libre para ${serviceLabel}.`;
}

function incapacityNoteLabel(who: string, serviceLabel: string): string {
  return `${who} no hace ${serviceLabel}, así que no hay ninguna media hora suya para ese servicio. Prueba con “Cualquiera del equipo”.`;
}

/**
 * Los niveles cuyas ventanas vacías son un hecho DEL LOCAL, uniforme para
 * todo el mundo (§8.2). `venue_closure` faltaba aquí (revisión adversarial de
 * la capacidad 1, hallazgo H2): sin él, un cierre del local aprobado en
 * `mode=any` nunca cumplía `allClosedSameLevel` en `dayVerdictForAny` y caía
 * en la frase genérica «no queda ninguna media hora libre para {servicio}»
 * en vez de nombrar el cierre — pese a que el ternario de `venueClosureLabel`
 * ya existía, muerto, un poco más abajo, esperando este caso.
 */
const CLOSED_LOCAL_LEVELS: ReadonlySet<CalendarLevel> = new Set([
  "venue_closure",
  "venue_rule",
  "seasonal_venue_schedule",
  "weekly_schedule",
  "none",
]);

/**
 * §3.6 — el catálogo `whyLabel`, declarado como `Record<CalendarLevel, …>`
 * para que un noveno nivel rompa la COMPILACIÓN de este módulo en vez de
 * caer en un respaldo silencioso (criterio 16).
 *
 * *(Corregido 2026-08-05 tras re-verificación adversarial de la capacidad 1,
 * hallazgo R2: esta nota decía que `venue_closure` Y `employee_absence`
 * «nunca se invocan con ventanas no vacías». Es cierto para `venue_closure`
 * — el nivel 1 de `resolveDayWindows` corta el día entero y siempre devuelve
 * `windows: []` — pero es **falso** para `employee_absence`: una ausencia
 * PARCIAL (`allDay: false`, con `startMinutes`/`endMinutes`) sólo resta ese
 * tramo, exactamente como una reserva, y dejar `appliedLevel:
 * "employee_absence"` con `windows` NO vacías para el resto del día
 * (`resolveAvailability.ts:419-436`). Antes de esta corrección,
 * `employee_absence: () => ""` pintaba una tarjeta con la razón EN BLANCO en
 * cada media hora de un día con ausencia parcial, en los dos modos.)*
 */
interface WhyLabelContext {
  who: string;
  servicio: string;
  /** Inicio/fin de la ventana RESIDUAL que CONTIENE este hueco concreto — nunca el envolvente de todas las ventanas del día (hallazgo R1). */
  spanStart: string;
  spanEnd: string;
  seasonLabel: string;
}

/**
 * *(Enmendado 2026-08-05 tras revisión adversarial de la capacidad 1,
 * hallazgo H3 — decisión: opción 1, enmienda de redacción, sin regla nueva —
 * y re-enmendado el mismo día tras re-verificación adversarial, hallazgo R1
 * — decisión: opción (b), la ventana que CONTIENE el hueco.)* `venue_rule`,
 * `employee_override`, `seasonal_venue_schedule` y `weekly_schedule` citaban
 * `{spanStart}–{spanEnd}` primero como el HORARIO DECLARADO (H3: falso en
 * cuanto una reserva recorta la ventana) y después como el ENVOLVENTE de
 * TODAS las ventanas del día (R1: sigue siendo falso si una reserva a media
 * mañana parte el día en dos ventanas — el envolvente vuelve a abarcar horas
 * ocupadas). `spanStart`/`spanEnd` es ahora el inicio y el fin de la ventana
 * CONCRETA que contiene ESTE hueco (`containingWindowBounds`, más arriba),
 * que es la única afirmación sobre un tramo que es SIEMPRE cierta: el hueco
 * está, por construcción, dentro de ella. Las cuatro plantillas ya no dicen
 * «tiene libre {spanStart}–{spanEnd}» sobre el día entero: dicen que ESTA
 * media hora cae en un tramo libre concreto, con esos límites.
 *
 * *(Re-enmendado 2026-08-05 tras re-verificación adversarial, hallazgo R2.)*
 * `employee_absence` devolvía `""` con el argumento de que «nunca se invoca
 * con ventanas no vacías» — falso para una ausencia PARCIAL (`allDay:
 * false`), que sólo resta un tramo del día y deja huecos reales antes y/o
 * después de ella. Con `""`, cada una de esas medias horas pintaba una razón
 * EN BLANCO, en `mode=one` y en `mode=any`. La frase nueva es NEUTRA — la
 * misma forma que ya usan `venue_rule`/`seasonal_venue_schedule`/
 * `weekly_schedule` para el tramo, sin ninguna cláusula inicial sobre el
 * horario — y **no nombra la ausencia**: la regla dura de §8.2 («con
 * `mode=any` no se dice ni una palabra sobre la ausencia o el horario de
 * nadie en concreto») se aplica aquí en LOS DOS MODOS, no sólo en `any`,
 * porque revelar que ese hueco existe "por culpa de" una ausencia sería
 * filtrar el mismo dato privado que la ausencia ya protege en el motivo de
 * día (`absenceLabel`, sólo con `mode=one`).
 */
const WHY_LABEL_BUILDERS: Readonly<Record<CalendarLevel, (ctx: WhyLabelContext) => string>> = {
  venue_closure: () => "",
  venue_rule: (ctx) =>
    `Ese día el local tiene una apertura especial aprobada; esta media hora cae en un tramo libre de ${ctx.who}, de ${ctx.spanStart} a ${ctx.spanEnd}, y hace ${ctx.servicio}.`,
  employee_absence: (ctx) =>
    `Esta media hora cae en un tramo libre de ${ctx.who}, de ${ctx.spanStart} a ${ctx.spanEnd}, y hace ${ctx.servicio}.`,
  employee_override: (ctx) =>
    `${ctx.who} tiene ese día un horario propio aprobado; esta media hora cae en un tramo suyo libre de ${ctx.spanStart} a ${ctx.spanEnd}, y hace ${ctx.servicio}.`,
  seasonal_venue_schedule: (ctx) =>
    `Dentro del ${lowerFirst(ctx.seasonLabel)} del local; esta media hora cae en un tramo libre de ${ctx.who}, de ${ctx.spanStart} a ${ctx.spanEnd}, y hace ${ctx.servicio}.`,
  weekly_schedule: (ctx) =>
    `Dentro del horario semanal del local; esta media hora cae en un tramo libre de ${ctx.who}, de ${ctx.spanStart} a ${ctx.spanEnd}, y hace ${ctx.servicio}.`,
  reservations: (ctx) => `Ese día ${ctx.who} ya tiene citas, y esta media hora sigue libre entre ellas; ${ctx.who} hace ${ctx.servicio}.`,
  none: (ctx) => `Esa media hora está libre en la agenda de ${ctx.who}, que hace ${ctx.servicio}.`,
};

// ---------------------------------------------------------------------
// El veredicto de un día (§3.5, §8.2).
// ---------------------------------------------------------------------

interface DayStart {
  startMinutes: number;
  employeeId: EmployeeId;
}

interface DayVerdict {
  considered: boolean;
  notConsideredLabel: string | null;
  starts: readonly DayStart[];
}

function usableStarts(
  cal: CalendarWithCapabilities,
  clock: Clock,
  employeeId: EmployeeId,
  dateISO: string,
  grid: EffectiveGrid,
): number[] {
  return freeStartsForDuration(cal, employeeId, dateISO, grid.duration, grid.step).filter(
    (s) =>
      !isStartInThePast(cal.minimumLeadMinutes, clock, dateISO, s) &&
      isIntervalFree(cal, employeeId, dateISO, s, s + grid.duration),
  );
}

function dayVerdictForOne(
  cal: CalendarWithCapabilities,
  clock: Clock,
  employeeId: EmployeeId,
  dateISO: string,
  today: string,
  grid: EffectiveGrid,
): DayVerdict {
  const usable = usableStarts(cal, clock, employeeId, dateISO, grid);
  if (usable.length > 0) {
    return { considered: true, notConsideredLabel: null, starts: usable.map((startMinutes) => ({ startMinutes, employeeId })) };
  }
  const { windows, appliedLevel } = resolveDayWindows(cal, employeeId, dateISO);
  if (windows.length === 0) {
    const who = professionalDisplayName(cal, employeeId);
    switch (appliedLevel) {
      case "venue_closure":
        return { considered: false, notConsideredLabel: venueClosureLabel(dateISO), starts: [] };
      case "venue_rule":
      case "seasonal_venue_schedule":
      case "weekly_schedule":
      case "none":
        return { considered: false, notConsideredLabel: venueNotOpenLabel(dateISO), starts: [] };
      case "employee_absence":
        return { considered: false, notConsideredLabel: absenceLabel(dateISO, who), starts: [] };
      case "employee_override":
        return { considered: false, notConsideredLabel: notWorkingLabel(dateISO, who), starts: [] };
      case "reservations":
        // No hay motivo declarado para "un día lleno de citas": el catálogo
        // de motivos de día (§8.2) no incluye este caso a propósito.
        return { considered: true, notConsideredLabel: null, starts: [] };
    }
  }
  const structural = freeStartsForDuration(cal, employeeId, dateISO, grid.duration, grid.step);
  if (dateISO === today && structural.length > 0) {
    return { considered: false, notConsideredLabel: noSlotsLeftTodayLabel(dateISO), starts: [] };
  }
  return { considered: true, notConsideredLabel: null, starts: [] };
}

function dayVerdictForAny(
  cal: CalendarWithCapabilities,
  clock: Clock,
  serviceId: ServiceId,
  dateISO: string,
  today: string,
  grid: EffectiveGrid,
): DayVerdict {
  const capableIds = cal.professionals.map((p) => p.employeeId).filter((id) => canPerform(cal, id, serviceId));
  const perEmployee = capableIds.map((id) => {
    const { windows, appliedLevel } = resolveDayWindows(cal, id, dateISO);
    const structural = freeStartsForDuration(cal, id, dateISO, grid.duration, grid.step);
    const usable = usableStarts(cal, clock, id, dateISO, grid);
    return { id, windows, appliedLevel, structural, usable };
  });

  const usableStartSet = new Set<number>();
  perEmployee.forEach((pe) => pe.usable.forEach((s) => usableStartSet.add(s)));
  if (usableStartSet.size > 0) {
    const starts = [...usableStartSet].sort((a, b) => a - b).map((startMinutes): DayStart => {
      // step 26 §13: con la duración puesta, «cualquiera» elige a alguien
      // capaz y libre durante TODO el intervalo, no sólo en el minuto de
      // inicio. Sin duración pedida, `grid.duration` es `cal.slotMinutes` y el
      // reparto es el de siempre.
      const choice = chooseProfessional(cal, dateISO, startMinutes, serviceId, grid.duration);
      // Non-null by construction: `usableStartSet` only ever collects starts
      // that `isIntervalFree` already confirmed free for a capable candidate,
      // so `chooseProfessional` always finds at least that one.
      return { startMinutes, employeeId: choice.employeeId as EmployeeId };
    });
    return { considered: true, notConsideredLabel: null, starts };
  }

  if (perEmployee.length > 0) {
    const allClosedSameLevel =
      perEmployee.every((pe) => pe.windows.length === 0 && CLOSED_LOCAL_LEVELS.has(pe.appliedLevel)) &&
      perEmployee.every((pe) => pe.appliedLevel === perEmployee[0]!.appliedLevel);
    if (allClosedSameLevel) {
      const level = perEmployee[0]!.appliedLevel;
      const label = level === "venue_closure" ? venueClosureLabel(dateISO) : venueNotOpenLabel(dateISO);
      return { considered: false, notConsideredLabel: label, starts: [] };
    }
    const allHadStructuralButNoneUsable = perEmployee.every((pe) => pe.structural.length > 0);
    if (dateISO === today && allHadStructuralButNoneUsable) {
      return { considered: false, notConsideredLabel: noSlotsLeftTodayLabel(dateISO), starts: [] };
    }
  }
  return { considered: false, notConsideredLabel: occupiedForServiceLabel(dateISO, SERVICE_LABELS[serviceId]), starts: [] };
}

function dayVerdict(
  cal: CalendarWithCapabilities,
  clock: Clock,
  query: AvailabilityExploreQuery,
  dateISO: string,
  today: string,
  grid: EffectiveGrid,
): DayVerdict {
  if (compareDate(dateISO, today) < 0) {
    return { considered: false, notConsideredLabel: pastDayLabel(dateISO), starts: [] };
  }
  if (!isWithinHorizon(cal, clock, dateISO)) {
    return { considered: false, notConsideredLabel: horizonLabel(dateISO), starts: [] };
  }
  if (query.mode === "one") {
    return dayVerdictForOne(cal, clock, query.employeeId as EmployeeId, dateISO, today, grid);
  }
  return dayVerdictForAny(cal, clock, query.serviceId, dateISO, today, grid);
}

// ---------------------------------------------------------------------
// La vista de un hueco (§6.1, §8.2, §8.3).
// ---------------------------------------------------------------------

function buildSlotView(
  cal: CalendarWithCapabilities,
  mode: "any" | "one",
  serviceId: ServiceId,
  serviceLabel: string,
  dateISO: string,
  dateLabel: string,
  start: DayStart,
  grid: EffectiveGrid,
): AvailabilityExploreSlotView {
  const { windows, appliedLevel } = resolveDayWindows(cal, start.employeeId, dateISO);
  const who = professionalDisplayName(cal, start.employeeId);
  const { spanStart, spanEnd } = containingWindowBounds(windows, start.startMinutes, grid.duration);
  const ctx: WhyLabelContext = {
    who,
    servicio: serviceLabel,
    spanStart,
    spanEnd,
    seasonLabel: activeSeasonLabel(cal, dateISO),
  };
  const startLabel = formatHHmm(start.startMinutes);
  // El FIN del bloque que se está ofreciendo, no el de media hora: con una
  // duración pedida, el rango que se enseña es el rango que se reservaría.
  const endLabel = formatHHmm(start.startMinutes + grid.duration);

  let anyProfessionalNote: string | null = null;
  let anyProfessionalLabel: string | null = null;
  let anyProfessionalExplainerLabel: string | null = null;
  if (mode === "any") {
    anyProfessionalNote = `Con “Cualquiera”, a esta hora le tocaría ${who}.`;
    const explanation = explainChoice(cal, dateISO, start.startMinutes, serviceId, grid.duration);
    const ids = explanation.candidates.join(", ");
    const remaining = explanation.candidates.map((id) => explanation.remainingSlotCounts[id] ?? 0).join(", ");
    const confirmed = explanation.candidates.map((id) => explanation.confirmedReservationCounts[id] ?? 0).join(", ");
    anyProfessionalLabel = `Candidatos con “Cualquiera”: ${ids} · huecos que le quedan hoy a cada uno: ${remaining} · citas confirmadas hoy: ${confirmed}`;
    anyProfessionalExplainerLabel =
      "Estos números explican el reparto, no lo recomiendan. Con “Cualquiera” esta consulta enseña UNA fila por hora, con la persona a la que le tocaría.";
  }

  return {
    key: `${dateISO}|${String(start.startMinutes)}|${String(start.employeeId)}`,
    dateISO,
    dateLabel,
    startLabel,
    endLabel,
    timeRangeLabel: `${startLabel}–${endLabel}`,
    serviceLabel,
    employeeId: start.employeeId,
    professionalLabel: who,
    whyLabel: WHY_LABEL_BUILDERS[appliedLevel](ctx),
    anyProfessionalNote,
    technical: {
      employeeIdLabel: `Identificador interno de la persona del equipo: ${String(start.employeeId)}`,
      serviceIdLabel: `Servicio (identificador interno): ${String(serviceId)}`,
      appliedLevelLabel: `Nivel de horario que decide ese día: ${appliedLevel}`,
      anyProfessionalLabel,
      anyProfessionalExplainerLabel,
    },
  };
}

// ---------------------------------------------------------------------
// La función pública (§6.1).
// ---------------------------------------------------------------------

export function exploreAvailability(
  cal: CalendarWithCapabilities,
  clock: Clock,
  query: AvailabilityExploreQuery,
): AvailabilityExploreView {
  const today = clock.nowISODate();
  // Los dos valores efectivos, calculados UNA sola vez para toda la consulta.
  const grid = effectiveGrid(cal, query);
  const serviceLabel = SERVICE_LABELS[query.serviceId];
  const modeLabel = query.mode === "any" ? "Cualquiera del equipo" : professionalDisplayName(cal, query.employeeId as EmployeeId);
  const fromLabel = dateLabelOf(query.from);
  const toLabel = dateLabelOf(query.to);
  const dayCount = daysBetween(query.from, query.to) + 1;
  const computedAt = {
    engineToday: today,
    engineNowMinutes: clock.nowMinutes(),
    confirmedReservationCount: cal.reservations.filter((r) => r.status === "confirmed").length,
  };
  const baseView = {
    query: { serviceLabel, modeLabel, fromLabel, toLabel, dayCountLabel: pluralDays(dayCount) },
    cap: { maxDays: AVAILABILITY_EXPLORER_MAX_DAYS, note: AVAILABILITY_EXPLORER_COPY.capNote },
    syntheticNote: AVAILABILITY_EXPLORER_COPY.syntheticNote,
    orderNote: AVAILABILITY_EXPLORER_COPY.orderNote,
    computedAt,
  };

  // §3.4 — mode=one y la persona elegida no hace el servicio: verdad
  // incómoda, 200, sin recorrer un solo día.
  if (query.mode === "one" && !canPerform(cal, query.employeeId as EmployeeId, query.serviceId)) {
    return {
      ...baseView,
      days: [],
      slots: [],
      totalLabel: pluralHuecos(0),
      emptyLabel: null,
      noteLabel: incapacityNoteLabel(professionalDisplayName(cal, query.employeeId as EmployeeId), serviceLabel),
    };
  }

  const days: AvailabilityExploreDayView[] = [];
  const rawSlots: Array<{ dateISO: string; dateLabel: string; start: DayStart }> = [];

  // Bounded by `dayCount` — the already-validated day count, § above — and
  // NOT by a `while (compareDate(cursor, query.to) <= 0)` loop, which the
  // first redaction used and which never terminates for a `to` right at the
  // edge of the representable calendar: `addDays` overflows past
  // "9999-12-31" into a five-digit year ("10000-01-01") that never compares
  // `<= to` again, and the loop never stops (revisión adversarial de la
  // capacidad 1, hallazgo H1). The server already rejects any `from`/`to`
  // outside a sane year range before this function is ever called, so
  // `dayCount` here is always a small, finite, positive number.
  for (let i = 0; i < dayCount; i++) {
    const dateISO = addDays(query.from, i);
    const dateLabel = dateLabelOf(dateISO);
    const verdict = dayVerdict(cal, clock, query, dateISO, today, grid);
    days.push({
      dateISO,
      dateLabel,
      considered: verdict.considered,
      notConsideredLabel: verdict.notConsideredLabel,
      slotCount: verdict.starts.length,
    });
    verdict.starts.forEach((start) => rawSlots.push({ dateISO, dateLabel, start }));
  }

  rawSlots.sort((a, b) => {
    if (a.dateISO !== b.dateISO) return a.dateISO < b.dateISO ? -1 : 1;
    if (a.start.startMinutes !== b.start.startMinutes) return a.start.startMinutes - b.start.startMinutes;
    return a.start.employeeId - b.start.employeeId; // desempate estable de último recurso (§3.5.1), sin caso vivo hoy
  });

  const slots = rawSlots.map((raw) =>
    buildSlotView(cal, query.mode, query.serviceId, serviceLabel, raw.dateISO, raw.dateLabel, raw.start, grid),
  );

  return {
    ...baseView,
    days,
    slots,
    totalLabel: pluralHuecos(slots.length),
    emptyLabel: slots.length === 0 ? AVAILABILITY_EXPLORER_COPY.emptyState : null,
    noteLabel: null,
  };
}
