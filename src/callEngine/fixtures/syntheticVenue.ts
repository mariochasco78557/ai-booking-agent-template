import type { CalendarWithCapabilities, CapabilityMatrix } from "../capabilities.js";
import type {
  OperationalCalendar,
  SyntheticReservation,
  WeeklySchedule,
} from "../calendar/model.js";
import type { ServiceId, SyntheticProfessional } from "../domain/types.js";

/**
 * Local demo banner. Any surface (console demo, test output) that displays
 * data from these fixtures should show this text so nobody mistakes it for
 * live Demo Salon data.
 */
export const SYNTHETIC_FIXTURE_BANNER = "Demo local · Datos sintéticos · No producción";

// ---------------------------------------------------------------------
// Employee ids used throughout these fixtures. All of it is synthetic.
// ---------------------------------------------------------------------
export const ALEX_ID = 3;
export const DANI_ID = 6;
export const NEREA_ID = 9;

const MON = 1;
const TUE = 2;
const WED = 3;

/**
 * `baseSyntheticVenue()` reflects the frozen synthetic profile from
 * step 12 (docs/call_interruption_mvp/demo-salon.synthetic-demo-profile.json).
 * The names "Álex (sintético)" and "Dani (sintético)" are entirely
 * synthetic and do NOT correspond to any real Demo Salon staff member — the
 * provisional public evidence available for this mission mentions
 * different names, which are deliberately NOT used here, precisely so this
 * module never has to handle a real person's data.
 *
 * This fixture must not change: it backs the frozen A01..A15 acceptance
 * scenarios from step 12. `extendedSyntheticVenue()` below is the one
 * used by the new calendar/allocation tests in this mission.
 */
export function baseSyntheticVenue(): CalendarWithCapabilities {
  const professionals: SyntheticProfessional[] = [
    { employeeId: ALEX_ID, displayName: "Álex (sintético)", synthetic: true },
    { employeeId: DANI_ID, displayName: "Dani (sintético)", synthetic: true },
  ];

  const weeklySchedules: WeeklySchedule[] = [ALEX_ID, DANI_ID].flatMap((employeeId) =>
    [MON, TUE].map(
      (dayOfWeek): WeeklySchedule => ({
        ownerKind: "employee",
        employeeId,
        dayOfWeek,
        workDayStart: "09:00",
        workDayEnd: "17:00",
        breakStart: "13:00",
        breakEnd: "14:00",
      }),
    ),
  );

  const allServices: ReadonlySet<ServiceId> = new Set<ServiceId>([0, 1, 2]);
  const capabilities: CapabilityMatrix = new Map([
    [ALEX_ID, allServices],
    [DANI_ID, allServices],
  ]);

  const calendar: OperationalCalendar = {
    professionals,
    weeklySchedules,
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    reservations: [],
    slotMinutes: 30,
    bookingHorizonDays: 90,
    minimumLeadMinutes: 0,
  };

  return { ...calendar, capabilities };
}

/**
 * `extendedSyntheticVenue()` starts from `baseSyntheticVenue()` and adds a
 * third synthetic professional, "Nerea (sintética)" (employeeId 9), whose
 * name is likewise entirely synthetic and invented for this demo — it does
 * not name any real Demo Salon employee. Nerea has a schedule that diverges
 * from Álex/Dani's (she also works Wednesdays, and her hours differ) and a
 * deliberately LIMITED capability (only services 1 and 2, not 0), so tests
 * can prove the capability matrix genuinely filters candidates rather than
 * assuming everyone can do everything. A handful of synthetic reservations
 * are added too, for the allocation tie-break tests.
 *
 * This fixture is used by tests/callEngine/calendar.test.ts and
 * tests/callEngine/allocation.test.ts only; `baseSyntheticVenue()` is left
 * untouched so it keeps backing the frozen A01..A15 scenarios.
 */
export function extendedSyntheticVenue(): CalendarWithCapabilities {
  const base = baseSyntheticVenue();

  const nereaSchedule: WeeklySchedule[] = [MON, TUE, WED].map(
    (dayOfWeek): WeeklySchedule => ({
      ownerKind: "employee",
      employeeId: NEREA_ID,
      dayOfWeek,
      workDayStart: "10:00",
      workDayEnd: "16:00",
      // Nerea's day has no midday break, unlike Álex/Dani's.
    }),
  );

  const professionals: SyntheticProfessional[] = [
    ...base.professionals,
    { employeeId: NEREA_ID, displayName: "Nerea (sintética)", synthetic: true },
  ];

  const capabilities: CapabilityMatrix = new Map([
    ...base.capabilities,
    [NEREA_ID, new Set<ServiceId>([1, 2])],
  ]);

  // A Monday used by the allocation tests, 2026-08-03 (a synthetic date,
  // chosen only because it is a Monday within the fixture's schedule).
  const sampleDate = "2026-08-03";
  const reservations: SyntheticReservation[] = [
    {
      id: "synthetic-res-1",
      employeeId: ALEX_ID,
      serviceId: 1,
      date: sampleDate,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    },
    {
      id: "synthetic-res-2",
      employeeId: ALEX_ID,
      serviceId: 1,
      date: sampleDate,
      startMinutes: 9 * 60 + 30,
      endMinutes: 10 * 60,
      status: "confirmed",
      synthetic: true,
    },
    {
      id: "synthetic-res-3",
      employeeId: DANI_ID,
      serviceId: 1,
      date: sampleDate,
      startMinutes: 15 * 60 + 30,
      endMinutes: 16 * 60,
      status: "confirmed",
      synthetic: true,
    },
    {
      id: "synthetic-res-4-cancelled",
      employeeId: DANI_ID,
      serviceId: 1,
      date: sampleDate,
      startMinutes: 10 * 60,
      endMinutes: 10 * 60 + 30,
      status: "cancelled",
      synthetic: true,
    },
  ];

  const calendar: OperationalCalendar = {
    professionals,
    weeklySchedules: [...base.weeklySchedules, ...nereaSchedule],
    closures: [...base.closures],
    venueRules: [...base.venueRules],
    absences: [...base.absences],
    overrides: [...base.overrides],
    reservations,
    slotMinutes: base.slotMinutes,
    bookingHorizonDays: base.bookingHorizonDays,
    minimumLeadMinutes: base.minimumLeadMinutes,
  };

  return { ...calendar, capabilities };
}
