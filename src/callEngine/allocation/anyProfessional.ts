import type { EmployeeId, ServiceId } from "../domain/types.js";
import type { CalendarWithCapabilities } from "../capabilities.js";
import { canPerform } from "../capabilities.js";
import { freeSlotStarts, isIntervalFree, isSlotFree } from "../calendar/resolveAvailability.js";

export type ProfessionalChoice =
  | { employeeId: EmployeeId }
  | { employeeId: null; reason: "no_capable_and_free" };

export interface ChoiceExplanation {
  /** Candidates that are both capable of the service and free at the slot, ascending by id. */
  candidates: EmployeeId[];
  /** Remaining free slot-starts today, counted from `startMinutes` inclusive, per candidate. */
  remainingSlotCounts: Record<EmployeeId, number>;
  /** Confirmed reservations today, per candidate. */
  confirmedReservationCounts: Record<EmployeeId, number>;
  chosen: EmployeeId | null;
  reason?: "no_capable_and_free";
}

/**
 * Chooses a professional for a given service/date/slot, deterministically:
 *   1. Candidates = professionals who `canPerform` the service AND are free
 *      at that exact slot (`isSlotFree`, revalidated from scratch).
 *   2. None -> `{ employeeId: null, reason: 'no_capable_and_free' }`.
 *   3. One -> that one.
 *   4. Several -> prefer whoever has MORE free slots remaining today,
 *      counted from `startMinutes` inclusive.
 *   5. Tie -> prefer whoever has FEWER confirmed reservations today.
 *   6. Final, stable tie-break -> lowest numeric `employeeId` ascending.
 *      This is the same final criterion already used by
 *      src/services/availabilityService.ts (lowest id wins ties across the
 *      merged multi-barber slot listing) — no new tie-break criterion is
 *      introduced here.
 *
 * step 26 §2 — `durationMinutes` OPCIONAL, y sólo cambia el PASO 1:
 *   - `undefined` (la voz, el grupo, la lista de espera y el explorador sin
 *     duración): el filtro es `isSlotFree`, exactamente como siempre.
 *   - definido (la cita manual de duración flexible): el filtro pasa a ser
 *     `isIntervalFree(cal, id, dateISO, start, start + durationMinutes)`, de
 *     modo que quien salga elegido es capaz y está libre durante TODO el
 *     intervalo, no sólo en el minuto de inicio.
 * Los criterios de DESEMPATE (4, 5 y 6) NO cambian: `remainingSlotCounts`
 * sigue midiéndose sobre la rejilla de `cal.slotMinutes`, porque mide cuán
 * ocupado tiene cada uno el resto del día —no su elegibilidad— y cambiarlo
 * alteraría el reparto de la voz sin ningún motivo.
 */
export function chooseProfessional(
  cal: CalendarWithCapabilities,
  dateISO: string,
  startMinutes: number,
  serviceId: ServiceId,
  durationMinutes?: number,
): ProfessionalChoice {
  const explanation = explainChoice(cal, dateISO, startMinutes, serviceId, durationMinutes);
  if (explanation.chosen == null) {
    return { employeeId: null, reason: explanation.reason ?? "no_capable_and_free" };
  }
  return { employeeId: explanation.chosen };
}

/** Same algorithm as `chooseProfessional`, returning the intermediate counts used to decide. */
export function explainChoice(
  cal: CalendarWithCapabilities,
  dateISO: string,
  startMinutes: number,
  serviceId: ServiceId,
  durationMinutes?: number,
): ChoiceExplanation {
  const isFree = (id: EmployeeId): boolean =>
    durationMinutes === undefined
      ? isSlotFree(cal, id, dateISO, startMinutes)
      : isIntervalFree(cal, id, dateISO, startMinutes, startMinutes + durationMinutes);
  const candidates = cal.professionals
    .map((p) => p.employeeId)
    .filter((id) => canPerform(cal, id, serviceId) && isFree(id))
    .sort((a, b) => a - b);

  const remainingSlotCounts: Record<EmployeeId, number> = {};
  const confirmedReservationCounts: Record<EmployeeId, number> = {};
  for (const id of candidates) {
    remainingSlotCounts[id] = freeSlotStarts(cal, id, dateISO).filter(
      (s) => s >= startMinutes,
    ).length;
    confirmedReservationCounts[id] = cal.reservations.filter(
      (r) => r.employeeId === id && r.date === dateISO && r.status === "confirmed",
    ).length;
  }

  if (candidates.length === 0) {
    return {
      candidates,
      remainingSlotCounts,
      confirmedReservationCounts,
      chosen: null,
      reason: "no_capable_and_free",
    };
  }

  const ranked = [...candidates].sort((a, b) => {
    const remA = remainingSlotCounts[a] ?? 0;
    const remB = remainingSlotCounts[b] ?? 0;
    if (remA !== remB) return remB - remA; // more remaining slots first
    const resA = confirmedReservationCounts[a] ?? 0;
    const resB = confirmedReservationCounts[b] ?? 0;
    if (resA !== resB) return resA - resB; // fewer confirmed reservations first
    return a - b; // lowest employeeId ascending, final stable tie-break
  });

  return {
    candidates,
    remainingSlotCounts,
    confirmedReservationCounts,
    chosen: ranked[0] ?? null,
  };
}
