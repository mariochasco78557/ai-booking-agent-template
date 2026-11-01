import type { Clock, EmployeeId } from "../domain/types.js";
import { addDays, compareDate, dayOfWeek, parseHHmm } from "../domain/time.js";
import type { Interval } from "./slotGrid.js";
import {
  coversInterval,
  intersect,
  startsFitting,
  subtract,
  subtractAll,
  toSlots,
} from "./slotGrid.js";
import type {
  OperationalCalendar,
  SeasonalVenueSchedule,
  VenueCalendarRule,
  WeeklySchedule,
} from "./model.js";

/**
 * The precedence level that shaped the final result of `resolveDayWindows`,
 * for internal diagnostics/explainability only (see `notes` below).
 *
 * DESIGN DECISION (not fully pinned down by the spec, documented here and
 * in the implementation report): a level is only reported as `appliedLevel`
 * when it actually *changed* something relative to what a plain, ordinary
 * working day would look like. `venue_closure`, `venue_rule` (closed, or
 * used as the day's hours because no employee-specific schedule exists),
 * `employee_absence` (only if its subtraction actually removes minutes),
 * `employee_override` and `seasonal_venue_schedule` (only when it supplies
 * the day's hours or actually narrows them) are exceptional/explicit
 * records, so they count as "applied" whenever they change the day.
 * `weekly_schedule` is the ordinary baseline — a plain week schedule with no break does NOT, by
 * itself, count as "the reason" for the result; it only becomes the
 * reported level when nothing more specific happened (the plain baseline
 * case), or when it removes minutes via a break. This lets `reservations`
 * be reachable as its own explanation on an otherwise perfectly ordinary
 * day. `none` is reserved for genuinely missing schedule data (no
 * employee-specific AND no venue-level weekly schedule for that
 * day-of-week at all).
 */
export type CalendarLevel =
  | "venue_closure"
  | "venue_rule"
  | "employee_absence"
  | "employee_override"
  | "seasonal_venue_schedule"
  | "weekly_schedule"
  | "reservations"
  | "none";

/** Precedence rank: lower number = more senior = wins when both "applied". */
const LEVEL_RANK: Record<CalendarLevel, number> = {
  venue_closure: 1,
  venue_rule: 2,
  employee_absence: 3,
  employee_override: 4,
  seasonal_venue_schedule: 5,
  weekly_schedule: 6,
  reservations: 7,
  none: 8,
};

function preferMoreSenior(current: CalendarLevel, candidate: CalendarLevel): CalendarLevel {
  return LEVEL_RANK[candidate] < LEVEL_RANK[current] ? candidate : current;
}

function totalMinutes(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.endMinutes - i.startMinutes), 0);
}

function dateWithinRange(dateISO: string, startDate: string, endDate: string): boolean {
  return compareDate(dateISO, startDate) >= 0 && compareDate(dateISO, endDate) <= 0;
}

/** Builds the window for a weekly-schedule-like record, subtracting its break if any. */
function windowFromScheduleLike(
  workDayStart: string,
  workDayEnd: string,
  breakStart: string | undefined,
  breakEnd: string | undefined,
): Interval[] {
  let windows: Interval[] = [
    { startMinutes: parseHHmm(workDayStart), endMinutes: parseHHmm(workDayEnd) },
  ];
  if (breakStart != null && breakEnd != null) {
    windows = subtract(windows, {
      startMinutes: parseHHmm(breakStart),
      endMinutes: parseHHmm(breakEnd),
    });
  }
  return windows;
}

/**
 * Chooses the applicable `VenueCalendarRule` among several approved rules
 * for the same date: `manual_override` always wins over `imported_provider`
 * (deterministic and same in every direction — a manual decision made by a
 * human always overrides an unreviewed/imported one); ties break on the
 * lexicographically smallest `id` (deterministic, stable).
 */
function pickRule(rulesForDate: readonly VenueCalendarRule[]): VenueCalendarRule {
  const sorted = [...rulesForDate].sort((a, b) => {
    if (a.source !== b.source) {
      if (a.source === "manual_override") return -1;
      if (b.source === "manual_override") return 1;
    }
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  // Non-empty by construction (caller only invokes this with rulesForDate.length > 0).
  return sorted[0] as VenueCalendarRule;
}

/**
 * The seasonal state of one date: whether ANY approved seasonal period
 * covers it (which alone is enough to take the venue's ordinary weekly
 * hours out of play) and, if so, the row that governs this day-of-week.
 *
 * `row: undefined` while `active: true` is the deliberate "closed" answer:
 * a season that does not list a day-of-week closes it. See
 * `SeasonalVenueSchedule`'s docblock.
 */
interface SeasonalResolution {
  active: boolean;
  row?: SeasonalVenueSchedule;
  /** The id of the period that made `active` true, for diagnostics. */
  periodId?: string;
}

/**
 * Resolves level 5 for one date. Fail-closed exactly like level 2: any row
 * that is not `approved` is ignored entirely, so a duplicated-but-unconfirmed
 * season for next year changes nothing until a human approves it.
 *
 * Determinism: when two approved periods overlap the same date (an operator
 * mistake this function must not resolve at random), rows are ordered by
 * `periodId` then `id` and the first match for the day-of-week wins — the
 * same shape of stable tie-break `pickRule` uses one level above.
 */
function resolveSeasonal(cal: OperationalCalendar, dateISO: string, dow: number): SeasonalResolution {
  const covering = (cal.seasonalSchedules ?? []).filter(
    (s) => s.approval === "approved" && dateWithinRange(dateISO, s.startDate, s.endDate),
  );
  if (covering.length === 0) return { active: false };
  const sorted = [...covering].sort((a, b) => {
    if (a.periodId !== b.periodId) return a.periodId < b.periodId ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
  // Non-empty by construction.
  const first = sorted[0] as SeasonalVenueSchedule;
  const row = sorted.find((s) => s.dayOfWeek === dow);
  return row !== undefined
    ? { active: true, row, periodId: row.periodId }
    : { active: true, periodId: first.periodId };
}

export interface ResolveDayWindowsResult {
  windows: Interval[];
  appliedLevel: CalendarLevel;
  /**
   * Internal diagnostics only. NEVER contains `EmployeeAbsence.privateReason`
   * — see the guarantee documented on that field in calendar/model.ts, and
   * the assertion in tests/callEngine/calendar.test.ts that checks this
   * directly against a fixture whose `privateReason` is a distinctive
   * string that must never appear here.
   */
  notes: string[];
}

/**
 * Resolves the free working windows for one employee on one date, applying
 * the seven-level precedence documented in the mission brief (step 14
 * decision D3 inserted level 5; everything else is unchanged):
 *   1. VenueClosure (approved)               -> empty, short-circuit.
 *   2. VenueCalendarRule (approved)           -> closed empty; a special
 *      opening becomes the day's hours when the employee has none of their
 *      own, and otherwise CLAMPS whatever levels 4/5/6 produced. The venue
 *      is a physical place: its hours bound everyone inside it.
 *   3. EmployeeAbsence (approved)             -> all-day empty; partial
 *      subtracts [startMinutes, endMinutes).
 *   4. EmployeeScheduleOverride (approved)    -> replaces the employee's
 *      hours for that date.
 *   5. SeasonalVenueSchedule (approved, dated) -> replaces the VENUE's
 *      ordinary weekly hours for its date range, and then bounds everyone
 *      inside the venue just like level 2 does. A calendar that declares no
 *      seasonal schedule resolves EXACTLY as it did before this level
 *      existed (asserted in tests/callEngine/seasonalSchedule.test.ts).
 *   6. WeeklySchedule                         -> employee-specific if it
 *      exists, else the venue's; subtracts its break.
 *   7. SyntheticReservation (status:'confirmed') -> subtracted.
 */
export function resolveDayWindows(
  cal: OperationalCalendar,
  employeeId: EmployeeId,
  dateISO: string,
): ResolveDayWindowsResult {
  const notes: string[] = [];
  const dow = dayOfWeek(dateISO);

  // --- Level 1: venue closure ------------------------------------------
  const closure = cal.closures.find(
    (c) => c.approval === "approved" && dateWithinRange(dateISO, c.startDate, c.endDate),
  );
  if (closure) {
    notes.push(`venue_closure '${closure.id}' covers ${dateISO}: venue fully closed.`);
    return { windows: [], appliedLevel: "venue_closure", notes };
  }

  // --- Level 2: venue calendar rule -------------------------------------
  // `pending_review`/`rejected` rules are ignored entirely (fail-closed:
  // they never open, and never close, the venue on their own).
  const rulesForDate = cal.venueRules.filter(
    (r) => r.approval === "approved" && r.date === dateISO,
  );
  let chosenRule: VenueCalendarRule | undefined;
  if (rulesForDate.length > 0) {
    chosenRule = pickRule(rulesForDate);
    notes.push(
      `venue_rule '${chosenRule.id}' selected for ${dateISO} (source=${chosenRule.source}, closed=${chosenRule.closed}).`,
    );
    if (chosenRule.closed) {
      return { windows: [], appliedLevel: "venue_rule", notes };
    }
  }

  // Venue-level fallback window: only used when the employee has no
  // schedule of their own for this day-of-week (see level 5 below). A rule
  // with special opening hours replaces the *venue's* normal weekly hours;
  // otherwise fall back to the venue's own WeeklySchedule, if any.
  let venueWindow: Interval[] = [];
  let venueWindowFromRule = false;
  let venueWindowFromSeasonal = false;
  // Set when the venue window has already become the employee's own window,
  // so the clamp further down does not intersect it pointlessly with itself.
  let venueWindowAlreadyUsed = false;
  // Level 5 is resolved here (not lower down) because it competes for the
  // SAME slot as the venue's ordinary weekly hours: it is a venue-owned
  // schedule with dates. It never touches levels 1-4, which are read before
  // and after it exactly as before.
  const seasonal = resolveSeasonal(cal, dateISO, dow);
  if (chosenRule && chosenRule.specialOpen != null && chosenRule.specialClose != null) {
    venueWindow = [
      {
        startMinutes: parseHHmm(chosenRule.specialOpen),
        endMinutes: parseHHmm(chosenRule.specialClose),
      },
    ];
    venueWindowFromRule = true;
  } else if (seasonal.active) {
    // A dated seasonal period REPLACES the venue's ordinary weekly hours for
    // its date range. A day-of-week the season does not list is closed:
    // `venueWindow` stays empty and the clamp below shuts the day. That is
    // fail-closed on purpose — a season that forgot to declare a day must
    // never silently reopen it with the ordinary timetable.
    venueWindowFromSeasonal = true;
    if (seasonal.row) {
      venueWindow = windowFromScheduleLike(
        seasonal.row.workDayStart,
        seasonal.row.workDayEnd,
        seasonal.row.breakStart,
        seasonal.row.breakEnd,
      );
      notes.push(
        `seasonal_venue_schedule '${seasonal.row.id}' (period '${seasonal.row.periodId}', ${seasonal.row.startDate}..${seasonal.row.endDate}) sets the venue hours for ${dateISO}.`,
      );
    } else {
      notes.push(
        `seasonal_venue_schedule period '${seasonal.periodId ?? ""}' covers ${dateISO} and declares no hours for dayOfWeek=${dow}: venue closed.`,
      );
    }
  } else {
    const venueWeekly = cal.weeklySchedules.find(
      (w) => w.ownerKind === "venue" && w.dayOfWeek === dow,
    );
    if (venueWeekly) {
      venueWindow = windowFromScheduleLike(
        venueWeekly.workDayStart,
        venueWeekly.workDayEnd,
        venueWeekly.breakStart,
        venueWeekly.breakEnd,
      );
    }
  }

  // --- Level 3 (checked before 4/5 because an all-day absence overrides
  // whatever they would otherwise compute): all-day absence -> empty. -----
  const absence = cal.absences.find(
    (a) =>
      a.approval === "approved" &&
      a.employeeId === employeeId &&
      dateWithinRange(dateISO, a.startDate, a.endDate),
  );
  if (absence?.allDay) {
    notes.push(
      `employee_absence '${absence.id}' covers ${dateISO} (all day): employee not available. (Reason withheld from client-facing notes.)`,
    );
    return { windows: [], appliedLevel: "employee_absence", notes };
  }

  // --- Level 4: employee schedule override, else level 5 (seasonal, resolved
  // into `venueWindow` above) or level 6: weekly schedule.
  // `appliedLevel` starts at 'none' and is only upgraded via
  // `preferMoreSenior`, so a plain schedule with no break stays 'none' here
  // — that is deliberate: see the DESIGN DECISION note on `CalendarLevel`.
  // A schedule was found at all is tracked separately in `hadScheduleData`,
  // so the final fallback below can still label a perfectly ordinary day
  // 'weekly_schedule' once nothing more specific (absence/reservations) has
  // claimed the label.
  let windows: Interval[];
  let appliedLevel: CalendarLevel = "none";
  let hadScheduleData = false;
  const override = cal.overrides.find(
    (o) => o.approval === "approved" && o.employeeId === employeeId && o.date === dateISO,
  );
  if (override) {
    // An override is explicit, day-specific data — always counts as applied.
    windows = windowFromScheduleLike(
      override.workDayStart,
      override.workDayEnd,
      override.breakStart,
      override.breakEnd,
    );
    notes.push(`employee_override '${override.id}' replaces the schedule for ${dateISO}.`);
    appliedLevel = preferMoreSenior(appliedLevel, "employee_override");
    hadScheduleData = true;
  } else {
    const employeeWeekly: WeeklySchedule | undefined = cal.weeklySchedules.find(
      (w) => w.ownerKind === "employee" && w.employeeId === employeeId && w.dayOfWeek === dow,
    );
    if (employeeWeekly) {
      const full: Interval[] = [
        {
          startMinutes: parseHHmm(employeeWeekly.workDayStart),
          endMinutes: parseHHmm(employeeWeekly.workDayEnd),
        },
      ];
      windows = windowFromScheduleLike(
        employeeWeekly.workDayStart,
        employeeWeekly.workDayEnd,
        employeeWeekly.breakStart,
        employeeWeekly.breakEnd,
      );
      hadScheduleData = true;
      notes.push(`weekly_schedule: employee-specific schedule applied for dayOfWeek=${dow}.`);
      if (totalMinutes(windows) < totalMinutes(full)) {
        // The break actually narrowed the day: worth reporting.
        appliedLevel = preferMoreSenior(appliedLevel, "weekly_schedule");
      }
    } else if (venueWindowFromRule) {
      // Explicit exceptional rule data used as the employee's fallback
      // hours — always counts as applied.
      windows = venueWindow;
      venueWindowAlreadyUsed = true;
      hadScheduleData = true;
      notes.push(
        `venue_rule '${chosenRule?.id}' special opening used as fallback for dayOfWeek=${dow} (no employee-specific schedule).`,
      );
      appliedLevel = preferMoreSenior(appliedLevel, "venue_rule");
    } else if (venueWindowFromSeasonal) {
      // Explicit, dated, exceptional data used as the employee's hours —
      // always counts as applied, like the venue_rule branch above. Note
      // this fires even when `venueWindow` is empty (a closed day inside an
      // active season): the season IS the reason there are no hours.
      windows = venueWindow;
      venueWindowAlreadyUsed = true;
      hadScheduleData = venueWindow.length > 0;
      notes.push(`seasonal_venue_schedule used as the hours for dayOfWeek=${dow} (no employee-specific schedule).`);
      appliedLevel = preferMoreSenior(appliedLevel, "seasonal_venue_schedule");
    } else if (venueWindow.length > 0) {
      windows = venueWindow;
      venueWindowAlreadyUsed = true;
      hadScheduleData = true;
      notes.push(`weekly_schedule: venue schedule applied as fallback for dayOfWeek=${dow}.`);
      // (Break-narrowing, if any, was already folded into `venueWindow`
      // above; we don't re-derive it here since this ordinary-baseline
      // fallback is rare in the fixtures and either way it degrades
      // gracefully to the final 'weekly_schedule' fallback below.)
    } else {
      windows = [];
      notes.push(`No weekly schedule (employee or venue) found for dayOfWeek=${dow}.`);
    }
  }

  // --- Level 2 as an OUTER BOUND, not merely a fallback -------------------
  // The venue is a physical place. If an approved rule says it opens only
  // 10:00-14:00, then nobody can be booked at 09:00 — not even an employee
  // whose own weekly schedule or override says otherwise. Treating the venue
  // window purely as a fallback (used only when the employee had no schedule)
  // would let levels 4 and 5 escape level 2, which inverts the required
  // precedence. So whenever a venue-level constraint exists we INTERSECT it
  // with whatever levels 4/5 produced.
  //
  // The clamp deliberately does not fire when the calendar declares no
  // venue-owned hours at all: in that shape the employee schedules *are* the
  // venue's hours, and clamping against an empty set would close the shop.
  if (venueWindowFromRule && !venueWindowAlreadyUsed) {
    const before = totalMinutes(windows);
    windows = intersect(windows, venueWindow);
    if (totalMinutes(windows) < before) {
      notes.push(
        `venue_rule '${chosenRule?.id}' special opening clamps the employee hours on ${dateISO}.`,
      );
      appliedLevel = preferMoreSenior(appliedLevel, "venue_rule");
    }
  } else if (venueWindowFromSeasonal && !venueWindowAlreadyUsed) {
    // The season bounds everyone inside the venue, exactly as the ordinary
    // venue hours do below — including an employee override, which sets the
    // person's hours but cannot open the shop.
    const before = totalMinutes(windows);
    windows = intersect(windows, venueWindow);
    if (totalMinutes(windows) < before) {
      notes.push(`seasonal_venue_schedule clamps the employee hours on ${dateISO}.`);
      appliedLevel = preferMoreSenior(appliedLevel, "seasonal_venue_schedule");
    }
  } else if (!venueWindowFromRule && hasVenueOwnedSchedules(cal) && !venueWindowAlreadyUsed) {
    const before = totalMinutes(windows);
    windows = intersect(windows, venueWindow);
    if (totalMinutes(windows) < before) {
      notes.push(`weekly_schedule: venue opening hours clamp the employee hours on ${dateISO}.`);
      appliedLevel = preferMoreSenior(appliedLevel, "weekly_schedule");
    }
  }

  // --- Level 3 (partial): subtract the absence, if any, now that the base
  // window is established. Only "wins" the appliedLevel label (level 3 is
  // more senior than 4/5) if it actually removed minutes.
  if (absence && !absence.allDay && absence.startMinutes != null && absence.endMinutes != null) {
    const before = totalMinutes(windows);
    windows = subtract(windows, {
      startMinutes: absence.startMinutes,
      endMinutes: absence.endMinutes,
    });
    const after = totalMinutes(windows);
    if (after < before) {
      notes.push(
        `employee_absence '${absence.id}' (partial) removed time on ${dateISO}. (Reason withheld from client-facing notes.)`,
      );
      appliedLevel = preferMoreSenior(appliedLevel, "employee_absence");
    } else {
      notes.push(
        `employee_absence '${absence.id}' recorded for ${dateISO} but does not overlap working hours.`,
      );
    }
  }

  // --- Level 7: subtract confirmed reservations. -------------------------
  const dayReservations = cal.reservations.filter(
    (r) => r.employeeId === employeeId && r.date === dateISO && r.status === "confirmed",
  );
  if (dayReservations.length > 0) {
    const cuts: Interval[] = dayReservations.map((r) => ({
      startMinutes: r.startMinutes,
      endMinutes: r.endMinutes,
    }));
    const before = totalMinutes(windows);
    windows = subtractAll(windows, cuts);
    const after = totalMinutes(windows);
    if (after < before) {
      notes.push(`reservations: ${dayReservations.length} confirmed reservation(s) reduced availability on ${dateISO}.`);
      appliedLevel = preferMoreSenior(appliedLevel, "reservations");
    }
  }

  // Final fallback: nothing exceptional (absence/override/rule-fallback)
  // and nothing narrowing (break/reservations) claimed the label, but a
  // weekly schedule (employee or venue) *was* found and used — that
  // ordinary schedule is, by elimination, the reason for these windows.
  if (appliedLevel === "none" && hadScheduleData) {
    appliedLevel = "weekly_schedule";
  }

  return { windows, appliedLevel, notes };
}

/** Free slot-start minutes for one employee/date, aligned to `cal.slotMinutes`. */
export function freeSlotStarts(
  cal: OperationalCalendar,
  employeeId: EmployeeId,
  dateISO: string,
): number[] {
  const { windows } = resolveDayWindows(cal, employeeId, dateISO);
  return toSlots(windows, cal.slotMinutes);
}

/**
 * Final revalidation gate: recomputes availability from scratch (no cache,
 * no memoisation) for one exact slot start. This is the function that must
 * be called immediately before writing a synthetic reservation, so a
 * previously computed/cached result can never be trusted stale.
 */
export function isSlotFree(
  cal: OperationalCalendar,
  employeeId: EmployeeId,
  dateISO: string,
  startMinutes: number,
): boolean {
  return freeSlotStarts(cal, employeeId, dateISO).includes(startMinutes);
}

/**
 * PUERTA DE REVALIDACIÓN DE INTERVALO (step 26 §2). Recalcula desde cero, sin
 * caché, y contesta una sola pregunta: ¿está libre TODO `[start, end)`?
 *
 * No añade ni una regla. `resolveDayWindows` ya resuelve los siete niveles
 * —cierre de local, festivo aprobado, ausencia, excepción de horario,
 * temporada, horario semanal con su pausa y, en su nivel 7, las reservas
 * confirmadas—, así que un intervalo que quepa entero en sus ventanas no cruza
 * cierre, ni pausa, ni ausencia, ni otra cita, ni un tramo no laborable. Ésa es
 * toda la demostración: la continuidad es una propiedad de las ventanas, no una
 * comprobación aparte.
 *
 * NO SUSTITUYE A `isSlotFree`, que sigue siendo la puerta —alineada a
 * `cal.slotMinutes`— de la voz, del grupo y de la lista de espera.
 */
export function isIntervalFree(
  cal: OperationalCalendar,
  employeeId: EmployeeId,
  dateISO: string,
  startMinutes: number,
  endMinutes: number,
): boolean {
  const { windows } = resolveDayWindows(cal, employeeId, dateISO);
  return coversInterval(windows, startMinutes, endMinutes);
}

/**
 * Inicios libres para una duración concreta, con el paso que pida el llamador
 * (step 26 §2). Hermana de `freeSlotStarts`, que no cambia.
 */
export function freeStartsForDuration(
  cal: OperationalCalendar,
  employeeId: EmployeeId,
  dateISO: string,
  durationMinutes: number,
  stepMinutes: number,
): number[] {
  const { windows } = resolveDayWindows(cal, employeeId, dateISO);
  return startsFitting(windows, durationMinutes, stepMinutes);
}

/**
 * Whether `dateISO` falls within the booking horizon: not before today, not
 * beyond `cal.bookingHorizonDays` days from today, and — for today itself —
 * not so late that `cal.minimumLeadMinutes` could no longer fit before
 * midnight. (Per-slot lead-time checks against an exact start time are the
 * caller's responsibility; this is a whole-day horizon gate.)
 */
export function isWithinHorizon(cal: OperationalCalendar, clock: Clock, dateISO: string): boolean {
  const today = clock.nowISODate();
  if (compareDate(dateISO, today) < 0) return false;

  const horizonEnd = addDays(today, cal.bookingHorizonDays);
  if (compareDate(dateISO, horizonEnd) > 0) return false;

  if (dateISO === today && cal.minimumLeadMinutes > 0) {
    const earliestPossible = clock.nowMinutes() + cal.minimumLeadMinutes;
    if (earliestPossible >= 24 * 60) return false;
  }

  return true;
}

/**
 * True when the calendar declares any venue-owned weekly hours at all.
 *
 * This distinguishes two legitimate calendar shapes. In the shape the frozen
 * step 12 profile uses, hours are declared per employee and there is no
 * venue-level schedule: there, the employees' hours *are* the venue's, and
 * clamping against a non-existent venue window would close the shop. In the
 * shape a real multi-establishment deployment would use, the venue declares
 * its own hours and every employee schedule is bounded by them.
 *
 * A dated `SeasonalVenueSchedule` is handled separately (see
 * `venueWindowFromSeasonal` in `resolveDayWindows`): an active season is
 * itself venue-owned hours, so it clamps even in a calendar that declares no
 * venue-owned `WeeklySchedule` rows.
 */
function hasVenueOwnedSchedules(cal: OperationalCalendar): boolean {
  return cal.weeklySchedules.some((w) => w.ownerKind === "venue");
}
