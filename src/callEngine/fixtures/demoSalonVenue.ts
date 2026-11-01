import type { CalendarWithCapabilities, CapabilityMatrix } from "../capabilities.js";
import type {
  OperationalCalendar,
  SeasonalVenueSchedule,
  SyntheticReservation,
  WeeklySchedule,
} from "../calendar/model.js";
import type { EmployeeId, ServiceId, SyntheticProfessional } from "../domain/types.js";
import { addDays } from "../domain/time.js";
import { ALEX_ID, DANI_ID, NEREA_ID } from "./syntheticVenue.js";
import { syntheticAudit } from "./syntheticHolidays.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * THE CONSOLE/DEMO FIXTURE (step 14, decisions D2/D3/D4).
 *
 * A THIRD fixture, deliberately separate from `baseSyntheticVenue()` (which
 * backs the frozen A01..A15 acceptance scenarios) and from
 * `extendedSyntheticVenue()` (which backs the allocation and calendar
 * exception suites). NEITHER of those is touched by this file: adding venue
 * hours to them would have changed the availability two existing suites
 * assert, and rewriting tests to fit a change is how a suite becomes
 * scenery.
 *
 * WHAT IS REAL AND WHAT IS INVENTED. The OPENING HOURS below are the ones
 * the client stated for Demo Salon. Everything else — the three professionals,
 * their names, who can do what, and every reservation — is entirely
 * synthetic and invented for this demo, exactly as in the other two
 * fixtures. No real person and no real appointment is represented here, and
 * nothing in this module ever reaches a real system.
 *
 * Prices are deliberately absent: no screen of the console shows them.
 * ────────────────────────────────────────────────────────────────────────
 */

// 0 (Sunday) and 1 (Monday) are deliberately absent from this file: a
// day-of-week with no row is a closed day, both in the ordinary week and
// inside the August season.
const TUE = 2;
const WED = 3;
const THU = 4;
const FRI = 5;
const SAT = 6;

/** Synthetic "today" for the console and the demo: TUESDAY 2026-08-04. */
export const BOOKING_DEMO_TODAY = "2026-08-04";
/** Synthetic "now" for the console and the demo: 09:00, expressed as minutes since midnight. */
export const BOOKING_DEMO_NOW_MINUTES = 9 * 60;

/** The id shared by every row of the dated August-2026 season. */
export const BOOKING_AUGUST_2026_PERIOD_ID = "temporada-agosto-2026";
/** First day covered by the dated August-2026 season (inclusive). */
export const BOOKING_AUGUST_2026_SEASON_START = "2026-08-01";
/** Last day covered by the dated August-2026 season (inclusive). */
export const BOOKING_AUGUST_2026_SEASON_END = "2026-08-31";

/**
 * Normal opening hours (September to July), as venue-owned rows.
 *
 * Monday and Sunday have NO row on purpose: a day-of-week the venue does not
 * declare is closed. `resolveAvailability.ts` treats venue-owned hours as an
 * OUTER BOUND, so this closes Monday for everybody, whatever an individual
 * schedule says — which is precisely why the schedule lives here and not
 * only in a paragraph of documentation.
 */
function venueWeeklySchedules(): WeeklySchedule[] {
  return [
    ...[TUE, WED, THU, FRI].map(
      (dayOfWeek): WeeklySchedule => ({
        ownerKind: "venue",
        dayOfWeek,
        workDayStart: "09:30",
        workDayEnd: "19:30",
      }),
    ),
    { ownerKind: "venue", dayOfWeek: SAT, workDayStart: "09:00", workDayEnd: "14:00" },
  ];
}

/**
 * WHY THERE ARE NO EMPLOYEE-OWNED ROWS IN THIS FIXTURE (step 15).
 *
 * This file used to declare a `WeeklySchedule` per professional, each with
 * its own start/end time and its own break. That was WRONG, twice over.
 *
 * 1. It duplicated the truth. The opening hours the business declared are
 *    the VENUE's, and they are the same for the whole team: there is no
 *    per-person shift and no per-person break. Writing them again, row by
 *    row, under each employee turned one fact into four copies of it — and
 *    the copies had drifted (a 10:00-18:00 day and two different lunch
 *    breaks) into individual differences nobody at Demo Salon ever stated.
 *
 * 2. It actively BROKE the August season. Level 5 (`SeasonalVenueSchedule`)
 *    only ever INTERSECTS against hours the employee already owns — see the
 *    `venueWindowFromSeasonal` branches in `resolveAvailability.ts`. With a
 *    personal 09:30-19:30 row in the way, August's earlier 09:00 opening
 *    could never reach anyone: the intersection clipped the extra morning
 *    half-hour straight back off. With NO row of their own, that same
 *    function ADOPTS the season (or, outside it, the venue's weekly hours)
 *    as the employee's hours, and the declared timetable applies whole.
 *
 * The people are still genuinely different where they genuinely differ: the
 * CAPABILITY MATRIX below still says Nerea does not do service 0, so the
 * capability filter is exercised for real and "cualquiera" still has to pick
 * among a subset. What is gone is only the invented difference in HOURS.
 *
 * A day-of-week nobody works is still closed for everybody, because the
 * VENUE declares no row for it (Monday and Sunday, above) — that is the
 * mechanism, and it needs no employee-level rows to work.
 */

/**
 * THE DATED AUGUST SEASON (decision D3). 2026-08-01 .. 2026-08-31, and not
 * one day more: `recurrence: "does_not_repeat"` says out loud that August
 * 2027 will NOT reuse this record. To reuse it, duplicate the rows with a
 * new `periodId`, shift the dates, set `duplicatedFromPeriodId` and leave
 * the copy `pending_review` until a human confirms it — a `pending_review`
 * season is completely inert (see `resolveSeasonal`).
 *
 * Monday and Sunday have no row, so they stay closed inside the season too.
 * The season applies to every active worker: it is venue-owned hours, so it
 * bounds every employee schedule and every employee override.
 */
function august2026Season(): SeasonalVenueSchedule[] {
  const common = {
    periodId: BOOKING_AUGUST_2026_PERIOD_ID,
    label: "Horario de agosto de 2026",
    startDate: BOOKING_AUGUST_2026_SEASON_START,
    endDate: BOOKING_AUGUST_2026_SEASON_END,
    recurrence: "does_not_repeat" as const,
    source: "synthetic_fixture" as const,
    approval: "approved" as const,
    audit: syntheticAudit(),
  };
  return [
    ...[TUE, WED, THU, FRI].map(
      (dayOfWeek): SeasonalVenueSchedule => ({
        ...common,
        id: `agosto-2026-dow-${String(dayOfWeek)}`,
        dayOfWeek,
        workDayStart: "09:00",
        workDayEnd: "17:30",
      }),
    ),
    {
      ...common,
      id: `agosto-2026-dow-${String(SAT)}`,
      dayOfWeek: SAT,
      workDayStart: "09:00",
      workDayEnd: "14:00",
    },
  ];
}

/**
 * A handful of synthetic appointments on the synthetic "today"
 * (`BOOKING_DEMO_TODAY` unless the caller anchors them elsewhere), so the
 * Agenda view has real content instead of an empty state that proves
 * nothing.
 *
 * `todayISO` exists so a process that runs on a different synthetic "today"
 * (the ElevenLabs synthetic bridge does, via `ELEVENLABS_SYNTHETIC_TODAY`)
 * gets its sample agenda MOVED with it rather than an empty day. The default
 * reproduces the previous hardcoded dates byte for byte.
 *
 * They deliberately leave Álex's 10:00-12:00 free: the console's own tests
 * and the demo book there, and a fixture that silently occupied those slots
 * would turn a legitimate booking into a confusing "no hay hueco".
 *
 * step 17 adds three more (design §8.1): two on THURSDAY 2026-08-06, the
 * day the waitlist demo publishes a venue closure on (scenario 17), and one
 * more on today that gives scenario 16 its contrast — the same 16:00 slot
 * that Nerea cannot fill for service 0, filled by somebody who can.
 *
 * WHY 2026-08-06 CARRIES NO ÁLEX APPOINTMENT (deliberate deviation from the
 * design's §8.1 table, which named Álex for `demo-salon-res-8`): the existing
 * suite `tests/callEngine/seasonalSchedule.test.ts` pins Álex's windows on
 * that exact date — `resolveDayWindows(withOverride, ALEX_ID, "2026-08-06")`
 * must be ONE unbroken 09:00-17:30 window. Any Álex reservation that day
 * splits it in two and turns that assertion red. The scenario needs "an
 * appointment on the day that gets closed", not a particular person, so the
 * appointment moved to Nerea — who can perform service 1, which is what
 * keeps scenario 17 honest: without the closure the slot WOULD match
 * `wl-f06`, so the closure is provably what prevents the match, not a
 * capability gap. No existing assertion was weakened to make room.
 */
export function sampleReservations(todayISO: string = BOOKING_DEMO_TODAY): SyntheticReservation[] {
  const date = todayISO;
  /**
   * Two days after the anchor. With the default anchor this is EXACTLY
   * 2026-08-06, the Thursday the waitlist demo publishes its closure on
   * (step 17 §8.1) — the date is derived, not re-stated, so a caller that
   * moves the anchor moves this day with it instead of leaving the sample
   * appointments stranded on a day the caller no longer looks at.
   */
  const secondDay = addDays(todayISO, 2);
  return [
    { id: "demo-salon-res-1", employeeId: ALEX_ID, serviceId: 1, date, startMinutes: 9 * 60 + 30, endMinutes: 10 * 60, status: "confirmed", synthetic: true },
    { id: "demo-salon-res-2", employeeId: ALEX_ID, serviceId: 2, date, startMinutes: 13 * 60, endMinutes: 14 * 60, status: "confirmed", synthetic: true },
    { id: "demo-salon-res-3", employeeId: DANI_ID, serviceId: 1, date, startMinutes: 10 * 60, endMinutes: 10 * 60 + 30, status: "confirmed", synthetic: true },
    { id: "demo-salon-res-4", employeeId: DANI_ID, serviceId: 0, date, startMinutes: 11 * 60 + 30, endMinutes: 12 * 60, status: "confirmed", synthetic: true },
    { id: "demo-salon-res-5", employeeId: NEREA_ID, serviceId: 1, date, startMinutes: 12 * 60 + 30, endMinutes: 13 * 60, status: "confirmed", synthetic: true },
    { id: "demo-salon-res-6", employeeId: NEREA_ID, serviceId: 2, date, startMinutes: 16 * 60, endMinutes: 17 * 60, status: "confirmed", synthetic: true },
    // One cancelled appointment: availability must ignore it, and the agenda
    // must be able to show that "cancelada" is a state that exists.
    { id: "demo-salon-res-7-cancelada", employeeId: DANI_ID, serviceId: 1, date, startMinutes: 15 * 60, endMinutes: 15 * 60 + 30, status: "cancelled", synthetic: true },
    // step 17 §8.1 — scenario 17: the appointment on the day the closure is
    // published on. See this function's docblock for why it is Nerea's.
    { id: "demo-salon-res-8", employeeId: NEREA_ID, serviceId: 1, date: secondDay, startMinutes: 10 * 60, endMinutes: 10 * 60 + 30, status: "confirmed", synthetic: true },
    // A second appointment on that same second day, so the demo can be run
    // more than once without exhausting it.
    { id: "demo-salon-res-9", employeeId: DANI_ID, serviceId: 1, date: secondDay, startMinutes: 11 * 60, endMinutes: 11 * 60 + 30, status: "confirmed", synthetic: true },
    // step 17 §8.1 — scenario 16's CONTRAST: the very same 16:00 slot that
    // Nerea cannot fill for service 0 (she does not do it), held by somebody
    // who can. Cancelling this one makes `wl-f04` compatible; cancelling
    // Nerea's does not, and the only difference is capability.
    { id: "demo-salon-res-10", employeeId: DANI_ID, serviceId: 1, date, startMinutes: 16 * 60, endMinutes: 16 * 60 + 30, status: "confirmed", synthetic: true },
  ];
}

/**
 * The calendar the operator console and `tools/call-engine-demo/demo-driver.ts`
 * run against. Everything in it is synthetic; the opening hours are the real
 * declared business hours, the people are not real people.
 *
 * `todayISO` only moves the SAMPLE APPOINTMENTS (see `sampleReservations`).
 * Opening hours, season, people and capabilities do not depend on it, and
 * omitting it reproduces the previous calendar exactly.
 */
export function demoSalonVenue(todayISO: string = BOOKING_DEMO_TODAY): CalendarWithCapabilities {
  const professionals: SyntheticProfessional[] = [
    { employeeId: ALEX_ID, displayName: "Álex (sintético)", synthetic: true },
    { employeeId: DANI_ID, displayName: "Dani (sintético)", synthetic: true },
    { employeeId: NEREA_ID, displayName: "Nerea (sintética)", synthetic: true },
  ];

  const allServices: ReadonlySet<ServiceId> = new Set<ServiceId>([0, 1, 2]);
  // Same shape as `extendedSyntheticVenue()`: Nerea deliberately cannot do
  // service 0, so the capability filter is exercised for real here too.
  const capabilities: CapabilityMatrix = new Map<EmployeeId, ReadonlySet<ServiceId>>([
    [ALEX_ID, allServices],
    [DANI_ID, allServices],
    [NEREA_ID, new Set<ServiceId>([1, 2])],
  ]);

  const calendar: OperationalCalendar = {
    professionals,
    weeklySchedules: [...venueWeeklySchedules()],
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    seasonalSchedules: august2026Season(),
    reservations: sampleReservations(todayISO),
    slotMinutes: 30,
    bookingHorizonDays: 90,
    minimumLeadMinutes: 0,
  };

  return { ...calendar, capabilities };
}
