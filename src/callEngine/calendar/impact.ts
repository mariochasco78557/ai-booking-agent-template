import type { EmployeeId, ServiceId } from "../domain/types.js";
import { resolveDayWindows } from "./resolveAvailability.js";
import type { Interval } from "./slotGrid.js";
import type {
  AuditStamp,
  EmployeeAbsence,
  EmployeeScheduleOverride,
  OperationalCalendar,
  VenueCalendarRule,
  VenueClosure,
} from "./model.js";

/**
 * Impact-preview and explicit-resolution apply flow for calendar changes.
 *
 * WHY THIS EXISTS: a calendar change (a venue closure, a holiday/special
 * opening, an employee absence, a schedule override) can make a room that
 * used to hold a confirmed reservation stop being available. This module
 * NEVER resolves that conflict on its own — it only ever surfaces it, so a
 * human decides. Moving or cancelling a client's appointment without asking
 * them is exactly the kind of silent failure this whole product exists to
 * prevent (see the mission brief and docs/call_interruption_mvp/**, whose
 * entire premise is that a caller must never be told something false about
 * their own booking). See `applyChange` below for the hard gate that
 * enforces this.
 */

/** The four kinds of pending calendar change this module knows how to preview. */
export type CalendarChange =
  | { kind: "venue_closure"; closure: VenueClosure }
  | { kind: "venue_rule"; rule: VenueCalendarRule }
  | { kind: "employee_absence"; absence: EmployeeAbsence }
  | { kind: "employee_override"; override: EmployeeScheduleOverride };

/**
 * One confirmed `SyntheticReservation` that would fall outside the
 * available windows if `change` were applied. Deliberately carries only
 * schedule facts (who, when, which service code) — never `privateReason`
 * (that field lives on `EmployeeAbsence`, not on a reservation, and is
 * never read by this module) and never a client name (the model has none:
 * `SyntheticReservation` carries no client-identifying field at all).
 */
export interface ImpactedReservation {
  reservationId: string;
  employeeId: EmployeeId;
  date: string;
  startMinutes: number;
  endMinutes: number;
  serviceId: ServiceId;
}

export interface ImpactReport {
  change: CalendarChange;
  /** Every impacted reservation, in the order found. */
  impacted: readonly ImpactedReservation[];
  /** The same reservations, grouped by `"${employeeId}|${date}"`. */
  byEmployeeAndDate: ReadonlyMap<string, readonly ImpactedReservation[]>;
}

function intervalContains(windows: readonly Interval[], startMinutes: number, endMinutes: number): boolean {
  return windows.some((w) => w.startMinutes <= startMinutes && endMinutes <= w.endMinutes);
}

function dateWithinRange(dateISO: string, startDate: string, endDate: string): boolean {
  return dateISO >= startDate && dateISO <= endDate;
}

/**
 * Strips `EmployeeAbsence.privateReason` from `change` before it is stored
 * on an `ImpactReport`. HARD RULE: "Ninguna salida de impact.ts puede
 * contener `privateReason` ni nombres de clientes" — that includes the
 * `change` field itself, even though the caller who requested this preview
 * necessarily already knows the absence's own `privateReason` (they passed
 * it in). Reports are exactly the kind of value that gets logged, displayed,
 * or handed to another layer, so this module never re-emits that field
 * anywhere in its own output, not even as an echo of the input.
 *
 * EXPORTADA (step 26 REAPERTURA §R13) para que `calendar/withdrawal.ts`
 * purgue por ESTA función y no por una copia suya: dos purgas parecidas es
 * exactamente cómo se abre una segunda vía de salida.
 */
export function sanitizeChangeForReport(change: CalendarChange): CalendarChange {
  switch (change.kind) {
    case "venue_closure":
      return { kind: "venue_closure", closure: sinNotaOperativa(change.closure) };
    case "venue_rule":
      return { kind: "venue_rule", rule: sinNotaOperativa(change.rule) };
    case "employee_absence": {
      const { privateReason: _privateReason, ...absenceWithoutPrivateReason } = change.absence;
      return { kind: "employee_absence", absence: sinNotaOperativa(absenceWithoutPrivateReason) };
    }
    case "employee_override":
      return { kind: "employee_override", override: sinNotaOperativa(change.override) };
  }
}

/**
 * Quita `AuditStamp.note` de una fila antes de que viaje en un informe
 * (step 26 REAPERTURA §R11). La nota operativa que escribe el operador es
 * para la CONSOLA —viaja por el snapshot, que es donde se lee— y no para el
 * informe de impacto: el informe lleva el `change`, el `change` lleva el
 * `audit`, y dejarla ahí sería abrir una segunda vía de salida justo al lado
 * de la que `privateReason` tiene cerrada. Se purga en las CUATRO ramas —las
 * tres retirables más `employee_override`— porque el campo existe en el sello
 * de todas ellas y una purga con excepciones no es una purga.
 */
function sinNotaOperativa<T extends { audit: AuditStamp }>(row: T): T {
  if (row.audit.note === undefined) return row;
  const { note: _note, ...auditSinNota } = row.audit;
  return { ...row, audit: auditSinNota };
}

/**
 * Cheap pre-filter: which confirmed reservations *could plausibly* be
 * touched by `change`, before we pay for a full `resolveDayWindows`
 * recomputation. A closure/venue rule is venue-wide (any employee); an
 * absence/override is scoped to one employee.
 */
function mightBeAffected(
  change: CalendarChange,
  reservation: { employeeId: EmployeeId; date: string },
): boolean {
  switch (change.kind) {
    case "venue_closure":
      return dateWithinRange(reservation.date, change.closure.startDate, change.closure.endDate);
    case "venue_rule":
      return reservation.date === change.rule.date;
    case "employee_absence":
      return (
        reservation.employeeId === change.absence.employeeId &&
        dateWithinRange(reservation.date, change.absence.startDate, change.absence.endDate)
      );
    case "employee_override":
      return (
        reservation.employeeId === change.override.employeeId && reservation.date === change.override.date
      );
  }
}

/**
 * Returns `cal` with `change` folded in AS IF IT WERE ALREADY APPROVED.
 * This is a deliberate simulation choice: `previewImpact`'s whole purpose
 * is to answer "what would happen if this were approved and activated?" —
 * before that decision is made. It never writes this candidate calendar
 * back anywhere; see `previewImpact`'s purity guarantee below.
 */
function withChangeApplied(cal: OperationalCalendar, change: CalendarChange): OperationalCalendar {
  switch (change.kind) {
    case "venue_closure":
      return { ...cal, closures: [...cal.closures, { ...change.closure, approval: "approved" }] };
    case "venue_rule":
      return { ...cal, venueRules: [...cal.venueRules, { ...change.rule, approval: "approved" }] };
    case "employee_absence":
      return { ...cal, absences: [...cal.absences, { ...change.absence, approval: "approved" }] };
    case "employee_override":
      return { ...cal, overrides: [...cal.overrides, { ...change.override, approval: "approved" }] };
  }
}

/**
 * PURA. LA ÚNICA ARITMÉTICA DE IMPACTO DE TODO EL SISTEMA (step 26
 * REAPERTURA §R13). Extraída literalmente del bucle que vivía dentro de
 * `previewImpact`, para que el ALTA de un cambio (`previewImpact`, aquí
 * abajo) y la RETIRADA de uno ya publicado (`calendar/withdrawal.ts`) hagan
 * la misma cuenta con el mismo `resolveDayWindows`, en vez de dos cuentas
 * parecidas que puedan divergir.
 *
 * Para cada reserva CONFIRMADA de `cal` que pase `prefiltro`, recalcula las
 * ventanas del día sobre `candidato` —el calendario tal y como quedaría si
 * el cambio (o la retirada) ya estuviera aplicado— con esa ÚNICA reserva
 * quitada de la lista de ocupación, para que `resolveDayWindows` no se la
 * reste a sí misma (nivel 7, ver resolveAvailability.ts). Si su
 * `[startMinutes, endMinutes)` exacto ya no cabe entero dentro de una de las
 * ventanas resultantes, se reporta como impactada.
 *
 * `cal` manda sobre QUÉ reservas se examinan y `candidato` sobre QUÉ
 * disponibilidad tendrían: ni una ni otra se mutan nunca, y `reservations`
 * no se toca en ningún caso.
 */
export function reservasQueDejanDeCaber(
  cal: OperationalCalendar,
  candidato: OperationalCalendar,
  prefiltro: (r: { employeeId: EmployeeId; date: string }) => boolean,
): ImpactedReservation[] {
  const candidates = cal.reservations.filter((r) => r.status === "confirmed" && prefiltro(r));

  const impacted: ImpactedReservation[] = [];
  for (const reservation of candidates) {
    const candidateCal: OperationalCalendar = {
      ...candidato,
      reservations: candidato.reservations.filter((other) => other.id !== reservation.id),
    };
    const { windows } = resolveDayWindows(candidateCal, reservation.employeeId, reservation.date);
    if (!intervalContains(windows, reservation.startMinutes, reservation.endMinutes)) {
      impacted.push({
        reservationId: reservation.id,
        employeeId: reservation.employeeId,
        date: reservation.date,
        startMinutes: reservation.startMinutes,
        endMinutes: reservation.endMinutes,
        serviceId: reservation.serviceId,
      });
    }
  }

  return impacted;
}

/**
 * Agrupa un impacto por `"${employeeId}|${date}"`. Vive aquí, y no duplicada
 * en `withdrawal.ts`, por la misma razón que `reservasQueDejanDeCaber`: un
 * `ImpactReport` se construye en un solo sitio o acaba habiendo dos formas
 * distintas de leer el mismo hecho.
 */
export function agruparImpactoPorEmpleadoYFecha(
  impacted: readonly ImpactedReservation[],
): ReadonlyMap<string, readonly ImpactedReservation[]> {
  const byEmployeeAndDate = new Map<string, ImpactedReservation[]>();
  for (const item of impacted) {
    const key = `${item.employeeId}|${item.date}`;
    const bucket = byEmployeeAndDate.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      byEmployeeAndDate.set(key, [item]);
    }
  }
  return byEmployeeAndDate;
}

/**
 * PURE. Never mutates `cal` (or `change`) and never writes anything back —
 * it only ever reads and returns a report. For each confirmed reservation
 * that could plausibly be touched by `change`, this recomputes the day's
 * windows on a throwaway candidate calendar that (a) has `change` folded in
 * as approved, and (b) has that ONE reservation removed from the busy list
 * (so it isn't self-subtracted by `resolveDayWindows`'s own level-6 step —
 * see resolveAvailability.ts). If the reservation's exact
 * `[startMinutes, endMinutes)` no longer fits entirely inside one of the
 * resulting windows, it is reported as impacted.
 *
 * La cuenta la hace `reservasQueDejanDeCaber` (arriba): esta función sólo
 * decide QUÉ candidato se mira (`withChangeApplied`) y con QUÉ prefiltro
 * (`mightBeAffected`). El comportamiento observable no cambió al extraerla.
 */
export function previewImpact(cal: OperationalCalendar, change: CalendarChange): ImpactReport {
  const impacted = reservasQueDejanDeCaber(cal, withChangeApplied(cal, change), (r) =>
    mightBeAffected(change, r),
  );
  return {
    change: sanitizeChangeForReport(change),
    impacted,
    byEmployeeAndDate: agruparImpactoPorEmpleadoYFecha(impacted),
  };
}

/**
 * How a human disposes of one impacted reservation. Neither option ever
 * cancels or moves the reservation — see `applyChange` below for why.
 *   - `keep_and_flag`: leave the reservation exactly as it is; staff will
 *     handle the now-out-of-hours appointment manually (e.g. honour it
 *     anyway, or call the client themselves).
 *   - `mark_for_human_contact`: same as above, additionally recorded as
 *     needing a human to reach out to the client about the conflict.
 */
export type ImpactResolution = "keep_and_flag" | "mark_for_human_contact";

export interface ApplyChangeResult {
  cal: OperationalCalendar;
  /** Impacted reservations that had no entry in `resolutions`. Non-empty here means NOTHING was applied. */
  unresolved: readonly ImpactedReservation[];
  /**
   * Reservations the operator resolved as `mark_for_human_contact`, so the
   * caller can actually put them in a queue.
   *
   * This module stays pure — it has no store and no clock — so it reports
   * the list rather than creating the tasks itself. It exists because the
   * security audit found that `mark_for_human_contact` was documented as
   * "recorded as needing a human to reach out" while nothing anywhere
   * recorded it: an operator could believe the client would be called when
   * no such thing was queued. Promising contact and queueing nothing is a
   * worse failure than not offering the option at all.
   */
  flaggedForHumanContact: readonly ImpactedReservation[];
}

/**
 * Applies `change` to `cal` — but ONLY when every reservation `previewImpact`
 * would report as impacted has an explicit entry in `resolutions` (keyed by
 * `reservationId`). If even one impacted reservation is missing a
 * resolution, this function applies NOTHING and returns the original `cal`
 * unchanged, together with the list of reservations still needing a
 * decision.
 *
 * HARD RULE, BY DESIGN: this function NEVER cancels, moves, or otherwise
 * mutates a `SyntheticReservation` — not even one that has a resolution.
 * `cal.reservations` is always passed through untouched; only `change`
 * itself gets folded into the calendar. Silently cancelling or rescheduling
 * someone's appointment because of a calendar change they were never told
 * about is precisely the failure mode this whole product exists to avoid —
 * a human resolution acknowledges the conflict, it does not authorise this
 * module to act on the client's behalf.
 */
export function applyChange(
  cal: OperationalCalendar,
  change: CalendarChange,
  resolutions: ReadonlyMap<string, ImpactResolution>,
): ApplyChangeResult {
  const { impacted } = previewImpact(cal, change);
  const unresolved = impacted.filter((r) => !resolutions.has(r.reservationId));
  if (unresolved.length > 0) {
    return { cal, unresolved, flaggedForHumanContact: [] };
  }
  const flaggedForHumanContact = impacted.filter(
    (r) => resolutions.get(r.reservationId) === "mark_for_human_contact",
  );
  return { cal: withChangeApplied(cal, change), unresolved: [], flaggedForHumanContact };
}
