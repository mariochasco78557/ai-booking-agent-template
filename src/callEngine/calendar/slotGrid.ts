/**
 * Pure interval arithmetic over local wall-clock minutes-since-midnight
 * (0..1439). No dates, no clock, no state — see domain/time.ts for why
 * calendar math in this module never touches UTC instants.
 *
 * PROCEDENCIA: the interval-subtraction algorithm below reproduces the
 * semantics of the legacy Demo Salon `TimeslotManager` (working day minus break
 * minus reservations minus absences), whose public shape was established by
 * read-only static inspection of
 * legacy_LegacyBackend_readonly_clean/src/Utils/TimeSlot/. No PHP line was
 * translated and no legacy code was executed: only the *semantics* were
 * carried over, and the implementation below is original TypeScript.
 * See (internal doc, not included in the template).
 */

export interface Interval {
  startMinutes: number;
  endMinutes: number;
}

/**
 * Subtracts a single `cut` interval from a list of disjoint, ascending
 * `base` intervals, returning a new list of disjoint intervals. Handles
 * overlapping, adjacent, and fully-contained cuts.
 */
export function subtract(base: Interval[], cut: Interval): Interval[] {
  const result: Interval[] = [];
  for (const b of base) {
    if (cut.endMinutes <= b.startMinutes || cut.startMinutes >= b.endMinutes) {
      // No overlap at all (including merely-adjacent cuts): keep as-is.
      result.push(b);
      continue;
    }
    if (cut.startMinutes > b.startMinutes) {
      // A portion survives on the left of the cut.
      result.push({
        startMinutes: b.startMinutes,
        endMinutes: Math.min(cut.startMinutes, b.endMinutes),
      });
    }
    if (cut.endMinutes < b.endMinutes) {
      // A portion survives on the right of the cut.
      result.push({
        startMinutes: Math.max(cut.endMinutes, b.startMinutes),
        endMinutes: b.endMinutes,
      });
    }
    // If the cut fully contains `b`, neither branch above fires and `b` is
    // entirely removed, as intended.
  }
  return result;
}

/** Subtracts every interval in `cuts`, in order, from `base`. */
export function subtractAll(base: Interval[], cuts: Interval[]): Interval[] {
  return cuts.reduce((acc, cut) => subtract(acc, cut), base);
}

/**
 * Converts a list of open intervals into slot-start minutes aligned to an
 * absolute grid of `slotMinutes` (0, slotMinutes, 2*slotMinutes, ...) from
 * midnight. A slot start is only emitted when the *entire* slot
 * (`[start, start+slotMinutes)`) fits inside one of the intervals — a slot
 * that would run past the end of its interval is never emitted.
 */
export function toSlots(intervals: Interval[], slotMinutes: number): number[] {
  const starts: number[] = [];
  for (const interval of intervals) {
    const firstAligned = Math.ceil(interval.startMinutes / slotMinutes) * slotMinutes;
    for (
      let start = firstAligned;
      start + slotMinutes <= interval.endMinutes;
      start += slotMinutes
    ) {
      starts.push(start);
    }
  }
  return starts;
}

/**
 * Une los intervalos que se SOLAPAN o que meramente SE TOCAN, y los devuelve
 * ordenados. Uso interno de `coversInterval`/`startsFitting`, y de nadie más:
 * `toSlots` NO lo usa y no cambia de comportamiento (step 26 §2).
 *
 * Existe porque `subtract` puede dejar dos tramos que se tocan por un punto
 * —una pausa de longitud cero, dos reservas consecutivas— y esos dos tramos
 * describen tiempo continuo de verdad: un bloque de 90 minutos que los cruza
 * no pisa nada. Sin unirlos, la frontera ficticia entre ellos rechazaría una
 * cita perfectamente posible.
 */
function mergeContiguous(intervals: readonly Interval[]): Interval[] {
  const ordered = [...intervals]
    .filter((i) => i.endMinutes > i.startMinutes)
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  const merged: Interval[] = [];
  for (const interval of ordered) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.startMinutes <= last.endMinutes) {
      // Se tocan o se solapan: un solo tramo continuo.
      last.endMinutes = Math.max(last.endMinutes, interval.endMinutes);
      continue;
    }
    merged.push({ startMinutes: interval.startMinutes, endMinutes: interval.endMinutes });
  }
  return merged;
}

/**
 * ¿Está `[startMinutes, endMinutes)` contenido POR COMPLETO en la unión de
 * `intervals`, sin ningún corte por el medio? (step 26 §2.)
 *
 * Une los intervalos ADYACENTES antes de decidir (09:00-13:00 y 13:00-20:00
 * cubren 12:30-14:00). No mira ningún calendario: quien le pasa los intervalos
 * ya ha resuelto la precedencia.
 *
 * Un intervalo vacío o invertido contesta `false` a propósito: «no puedo
 * afirmar que eso esté libre» es la única respuesta honesta a una pregunta mal
 * formada, y ningún llamador legítimo la hace (la duración se valida antes,
 * con `isAllowedManualDuration`).
 */
export function coversInterval(
  intervals: readonly Interval[],
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (endMinutes <= startMinutes) return false;
  return mergeContiguous(intervals).some(
    (w) => w.startMinutes <= startMinutes && endMinutes <= w.endMinutes,
  );
}

/**
 * Los inicios, alineados a una rejilla absoluta de `stepMinutes` desde
 * medianoche, en los que cabe ENTERO un bloque de `durationMinutes`
 * (step 26 §2).
 *
 * Mismo criterio de «cabe entero» que `toSlots`, pero con el paso y la
 * duración desacoplados: `toSlots` los confunde a propósito —una rejilla de 30
 * sólo emite bloques de 30— y ésta no puede.
 */
export function startsFitting(
  intervals: readonly Interval[],
  durationMinutes: number,
  stepMinutes: number,
): number[] {
  const starts: number[] = [];
  if (durationMinutes <= 0 || stepMinutes <= 0) return starts;
  for (const interval of mergeContiguous(intervals)) {
    const firstAligned = Math.ceil(interval.startMinutes / stepMinutes) * stepMinutes;
    for (
      let start = firstAligned;
      start + durationMinutes <= interval.endMinutes;
      start += stepMinutes
    ) {
      starts.push(start);
    }
  }
  return starts;
}

/**
 * Intersects two lists of disjoint, ascending intervals. Used to clamp an
 * employee's hours against the venue's own opening window: the venue is a
 * physical place, so its hours are an outer bound that a per-employee
 * schedule or override can narrow but never escape.
 */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const startMinutes = Math.max(x.startMinutes, y.startMinutes);
      const endMinutes = Math.min(x.endMinutes, y.endMinutes);
      if (startMinutes < endMinutes) result.push({ startMinutes, endMinutes });
    }
  }
  return result.sort((p, q) => p.startMinutes - q.startMinutes);
}
