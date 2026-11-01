import { describe, it, expect } from "vitest";
import {
  resolveDayWindows,
  freeSlotStarts,
  freeStartsForDuration,
  isIntervalFree,
  isSlotFree,
  isWithinHorizon,
} from "../../src/callEngine/calendar/resolveAvailability.js";
import {
  coversInterval,
  startsFitting,
  subtract,
  subtractAll,
  toSlots,
} from "../../src/callEngine/calendar/slotGrid.js";
import type {
  AuditStamp,
  EmployeeAbsence,
  EmployeeScheduleOverride,
  OperationalCalendar,
  SyntheticReservation,
  VenueCalendarRule,
  VenueClosure,
  WeeklySchedule,
} from "../../src/callEngine/calendar/model.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { addDays } from "../../src/callEngine/domain/time.js";
import { previewImpact, reservasQueDejanDeCaber } from "../../src/callEngine/calendar/impact.js";

// Synthetic test fixtures only — no real Demo Salon data anywhere in this file.
const EMP = 1;
const MONDAY_ISO = "2026-08-03"; // A Monday (dayOfWeek === 1), purely for test convenience.
const OTHER_EMP_PROFILE = { employeeId: EMP, displayName: "Test Pro (sintético)", synthetic: true as const };

function audit(overrides: Partial<AuditStamp> = {}): AuditStamp {
  return { createdAt: "2026-01-01T00:00:00", createdBy: "test-fixture", ...overrides };
}

function baseCalendar(overrides: Partial<OperationalCalendar> = {}): OperationalCalendar {
  return {
    professionals: [OTHER_EMP_PROFILE],
    weeklySchedules: [],
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    reservations: [],
    slotMinutes: 30,
    bookingHorizonDays: 90,
    minimumLeadMinutes: 0,
    ...overrides,
  };
}

function plainMondaySchedule(extra: Partial<WeeklySchedule> = {}): WeeklySchedule {
  return {
    ownerKind: "employee",
    employeeId: EMP,
    dayOfWeek: 1,
    workDayStart: "09:00",
    workDayEnd: "17:00",
    ...extra,
  };
}

describe("slotGrid: subtract / subtractAll", () => {
  it("removes an interval fully contained within a base interval", () => {
    const base = [{ startMinutes: 0, endMinutes: 100 }];
    const result = subtract(base, { startMinutes: 30, endMinutes: 60 });
    expect(result).toEqual([
      { startMinutes: 0, endMinutes: 30 },
      { startMinutes: 60, endMinutes: 100 },
    ]);
  });

  it("removes the whole interval when the cut fully overlaps it", () => {
    const base = [{ startMinutes: 30, endMinutes: 60 }];
    const result = subtract(base, { startMinutes: 0, endMinutes: 100 });
    expect(result).toEqual([]);
  });

  it("leaves an adjacent (non-overlapping) cut untouched", () => {
    const base = [{ startMinutes: 0, endMinutes: 30 }];
    const result = subtract(base, { startMinutes: 30, endMinutes: 60 });
    expect(result).toEqual([{ startMinutes: 0, endMinutes: 30 }]);
  });

  it("handles a cut overlapping the left edge only", () => {
    const base = [{ startMinutes: 30, endMinutes: 90 }];
    const result = subtract(base, { startMinutes: 0, endMinutes: 45 });
    expect(result).toEqual([{ startMinutes: 45, endMinutes: 90 }]);
  });

  it("handles a cut overlapping the right edge only", () => {
    const base = [{ startMinutes: 30, endMinutes: 90 }];
    const result = subtract(base, { startMinutes: 60, endMinutes: 120 });
    expect(result).toEqual([{ startMinutes: 30, endMinutes: 60 }]);
  });

  it("subtractAll applies several cuts in sequence", () => {
    const base = [{ startMinutes: 0, endMinutes: 120 }];
    const result = subtractAll(base, [
      { startMinutes: 30, endMinutes: 45 },
      { startMinutes: 90, endMinutes: 120 },
    ]);
    expect(result).toEqual([
      { startMinutes: 0, endMinutes: 30 },
      { startMinutes: 45, endMinutes: 90 },
    ]);
  });
});

describe("slotGrid: toSlots", () => {
  it("emits grid-aligned slot starts that fit entirely inside the interval", () => {
    const starts = toSlots([{ startMinutes: 0, endMinutes: 90 }], 30);
    expect(starts).toEqual([0, 30, 60]);
  });

  it("does not emit a slot that would not fit entirely (45-minute interval, 30-minute slots)", () => {
    const starts = toSlots([{ startMinutes: 540, endMinutes: 585 }], 30); // 09:00-09:45
    expect(starts).toEqual([540]); // only 09:00; 09:30-10:00 would not fit
  });

  it("aligns to the absolute grid even when the interval starts off-grid", () => {
    // 09:05-10:00: first grid-aligned slot start is 09:30, not 09:05.
    const starts = toSlots([{ startMinutes: 545, endMinutes: 600 }], 30);
    expect(starts).toEqual([570]);
  });
});

describe("resolveDayWindows: the six precedence levels", () => {
  it("level 1 — approved venue closure empties the day", () => {
    const closure: VenueClosure = {
      id: "closure-1",
      kind: "full_closure",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      closures: [closure],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("venue_closure");
  });

  it("level 2 — approved venue rule marked closed empties the day", () => {
    const rule: VenueCalendarRule = {
      id: "rule-1",
      kind: "holiday",
      scope: "national",
      date: MONDAY_ISO,
      closed: true,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      venueRules: [rule],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("venue_rule");
  });

  it("level 3 — approved all-day employee absence empties the day", () => {
    const absence: EmployeeAbsence = {
      id: "absence-1",
      employeeId: EMP,
      kind: "vacation",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: true,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      absences: [absence],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("employee_absence");
  });

  it("level 4 — approved employee schedule override replaces the day's hours", () => {
    const override: EmployeeScheduleOverride = {
      id: "override-1",
      employeeId: EMP,
      date: MONDAY_ISO,
      workDayStart: "11:00",
      workDayEnd: "13:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()], // would otherwise be 09:00-17:00
      overrides: [override],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 11 * 60, endMinutes: 13 * 60 }]);
    expect(result.appliedLevel).toBe("employee_override");
  });

  it("level 5 — plain weekly schedule with nothing else in play", () => {
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
    expect(result.appliedLevel).toBe("weekly_schedule");
  });

  it("level 6 — a confirmed reservation is the only thing narrowing an otherwise plain day", () => {
    const reservation: SyntheticReservation = {
      id: "res-1",
      employeeId: EMP,
      serviceId: 1,
      date: MONDAY_ISO,
      startMinutes: 10 * 60,
      endMinutes: 10 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      reservations: [reservation],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([
      { startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { startMinutes: 10 * 60 + 30, endMinutes: 17 * 60 },
    ]);
    expect(result.appliedLevel).toBe("reservations");
  });
});

describe("resolveDayWindows: combinations and edge cases", () => {
  it("venue closure beats an employee schedule override on the same date", () => {
    const closure: VenueClosure = {
      id: "closure-2",
      kind: "full_closure",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const override: EmployeeScheduleOverride = {
      id: "override-2",
      employeeId: EMP,
      date: MONDAY_ISO,
      workDayStart: "09:00",
      workDayEnd: "12:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      closures: [closure],
      overrides: [override],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("venue_closure");
  });

  it("a holiday rule and a special-opening rule for the same date: manual_override wins over imported_provider", () => {
    const holidayImported: VenueCalendarRule = {
      id: "rule-imported",
      kind: "holiday",
      scope: "national",
      date: MONDAY_ISO,
      closed: true,
      source: "imported_provider",
      approval: "approved",
      audit: audit(),
    };
    const specialOpeningManual: VenueCalendarRule = {
      id: "rule-manual",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "10:00",
      specialClose: "12:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    // Employee has no weekly schedule at all here, so the venue rule's
    // special hours are what surface for them (see level-2 fallback
    // documented on resolveDayWindows).
    const cal = baseCalendar({
      weeklySchedules: [], // deliberately no employee/venue weekly schedule
      venueRules: [holidayImported, specialOpeningManual],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.appliedLevel).toBe("venue_rule");
    expect(result.windows).toEqual([{ startMinutes: 10 * 60, endMinutes: 12 * 60 }]);
  });

  it("manual_override wins over imported_provider even when the manual rule sorts after it by id", () => {
    const manual: VenueCalendarRule = {
      id: "z-manual",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "08:00",
      specialClose: "09:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const imported: VenueCalendarRule = {
      id: "a-imported",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "10:00",
      specialClose: "11:00",
      source: "imported_provider",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [], venueRules: [manual, imported] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 8 * 60, endMinutes: 9 * 60 }]);
  });

  it("ties among rules of the same source break on lexicographically-smallest id", () => {
    const first: VenueCalendarRule = {
      id: "aaa",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "08:00",
      specialClose: "09:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const second: VenueCalendarRule = {
      id: "bbb",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "10:00",
      specialClose: "11:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [], venueRules: [second, first] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 8 * 60, endMinutes: 9 * 60 }]);
  });

  it("employee vacation (all-day) combined with an existing reservation: absence wins, day stays empty", () => {
    const absence: EmployeeAbsence = {
      id: "absence-2",
      employeeId: EMP,
      kind: "vacation",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: true,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const reservation: SyntheticReservation = {
      id: "res-2",
      employeeId: EMP,
      serviceId: 1,
      date: MONDAY_ISO,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      absences: [absence],
      reservations: [reservation],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("employee_absence");
  });

  it("a partial (not all-day) absence subtracts only its own range", () => {
    const absence: EmployeeAbsence = {
      id: "absence-3",
      employeeId: EMP,
      kind: "absence",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: false,
      startMinutes: 10 * 60,
      endMinutes: 11 * 60,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      absences: [absence],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([
      { startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { startMinutes: 11 * 60, endMinutes: 17 * 60 },
    ]);
    expect(result.appliedLevel).toBe("employee_absence");
  });

  it("a pending_review venue rule is ignored: it neither opens nor closes the venue", () => {
    // The employee has no weekly schedule at all here, so the day would
    // otherwise be closed; a pending_review special-opening rule must NOT
    // open it (fail-closed).
    const pendingOpen: VenueCalendarRule = {
      id: "rule-pending-open",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "10:00",
      specialClose: "12:00",
      source: "manual_override",
      approval: "pending_review",
      audit: audit(),
    };
    const calClosedDay = baseCalendar({ weeklySchedules: [], venueRules: [pendingOpen] });
    const resultClosedDay = resolveDayWindows(calClosedDay, EMP, MONDAY_ISO);
    expect(resultClosedDay.windows).toEqual([]);
    expect(resultClosedDay.appliedLevel).toBe("none");

    // And a pending_review "closed" rule must NOT close an otherwise-open day.
    const pendingClose: VenueCalendarRule = {
      id: "rule-pending-close",
      kind: "holiday",
      scope: "national",
      date: MONDAY_ISO,
      closed: true,
      source: "manual_override",
      approval: "pending_review",
      audit: audit(),
    };
    const calOpenDay = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      venueRules: [pendingClose],
    });
    const resultOpenDay = resolveDayWindows(calOpenDay, EMP, MONDAY_ISO);
    expect(resultOpenDay.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
    expect(resultOpenDay.appliedLevel).toBe("weekly_schedule");
  });

  it("a rejected venue rule is likewise ignored", () => {
    const rejectedClose: VenueCalendarRule = {
      id: "rule-rejected",
      kind: "holiday",
      scope: "national",
      date: MONDAY_ISO,
      closed: true,
      source: "manual_override",
      approval: "rejected",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      venueRules: [rejectedClose],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
  });

  it("the midday break is subtracted from the weekly schedule window", () => {
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule({ breakStart: "13:00", breakEnd: "14:00" })],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([
      { startMinutes: 9 * 60, endMinutes: 13 * 60 },
      { startMinutes: 14 * 60, endMinutes: 17 * 60 },
    ]);
  });

  it("falls back to the venue's own weekly schedule when the employee has none for that day", () => {
    const venueSchedule: WeeklySchedule = {
      ownerKind: "venue",
      dayOfWeek: 1,
      workDayStart: "08:00",
      workDayEnd: "15:00",
    };
    const cal = baseCalendar({ weeklySchedules: [venueSchedule] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 8 * 60, endMinutes: 15 * 60 }]);
    expect(result.appliedLevel).toBe("weekly_schedule");
  });

  it("an employee override still has confirmed reservations subtracted from it", () => {
    const override: EmployeeScheduleOverride = {
      id: "override-3",
      employeeId: EMP,
      date: MONDAY_ISO,
      workDayStart: "09:00",
      workDayEnd: "12:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const reservation: SyntheticReservation = {
      id: "res-3",
      employeeId: EMP,
      serviceId: 1,
      date: MONDAY_ISO,
      startMinutes: 10 * 60,
      endMinutes: 10 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({ overrides: [override], reservations: [reservation] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([
      { startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { startMinutes: 10 * 60 + 30, endMinutes: 12 * 60 },
    ]);
    // employee_override is more senior than reservations, so it stays the
    // reported reason even though a reservation also narrowed the day.
    expect(result.appliedLevel).toBe("employee_override");
  });

  it("privateReason is never present in the diagnostic notes or anywhere client-visible", () => {
    const secret = "SECRET-MEDICAL-REASON-NOT-FOR-CLIENT";
    const absence: EmployeeAbsence = {
      id: "absence-4",
      employeeId: EMP,
      kind: "absence",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: false,
      startMinutes: 10 * 60,
      endMinutes: 11 * 60,
      privateReason: secret,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      absences: [absence],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    for (const note of result.notes) {
      expect(note).not.toContain(secret);
    }
    expect(JSON.stringify(result.windows)).not.toContain(secret);
  });

  it("cancelled reservations are never subtracted", () => {
    const reservation: SyntheticReservation = {
      id: "res-cancelled",
      employeeId: EMP,
      serviceId: 1,
      date: MONDAY_ISO,
      startMinutes: 10 * 60,
      endMinutes: 10 * 60 + 30,
      status: "cancelled",
      synthetic: true,
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      reservations: [reservation],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
    expect(result.appliedLevel).toBe("weekly_schedule");
  });
});

describe("freeSlotStarts / isSlotFree", () => {
  it("freeSlotStarts produces grid-aligned starts for a plain day", () => {
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule({ workDayEnd: "10:00" })] });
    expect(freeSlotStarts(cal, EMP, MONDAY_ISO)).toEqual([9 * 60, 9 * 60 + 30]);
  });

  it("final revalidation: a free slot stops being free once a reservation is inserted", () => {
    const calBefore = baseCalendar({
      weeklySchedules: [plainMondaySchedule({ workDayEnd: "10:00" })],
    });
    expect(isSlotFree(calBefore, EMP, MONDAY_ISO, 9 * 60)).toBe(true);

    const reservation: SyntheticReservation = {
      id: "res-revalidate",
      employeeId: EMP,
      serviceId: 1,
      date: MONDAY_ISO,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const calAfter = baseCalendar({
      weeklySchedules: [plainMondaySchedule({ workDayEnd: "10:00" })],
      reservations: [reservation],
    });
    expect(isSlotFree(calAfter, EMP, MONDAY_ISO, 9 * 60)).toBe(false);
    // The rest of the day is untouched.
    expect(isSlotFree(calAfter, EMP, MONDAY_ISO, 9 * 60 + 30)).toBe(true);
  });
});

describe("isWithinHorizon", () => {
  it("a date beyond bookingHorizonDays is rejected", () => {
    const cal = baseCalendar({ bookingHorizonDays: 90 });
    const clock = fixedClock("2026-08-01", 9 * 60);
    const tooFar = addDays("2026-08-01", 91);
    expect(isWithinHorizon(cal, clock, tooFar)).toBe(false);
  });

  it("a date exactly at the horizon boundary is accepted", () => {
    const cal = baseCalendar({ bookingHorizonDays: 90 });
    const clock = fixedClock("2026-08-01", 9 * 60);
    const atBoundary = addDays("2026-08-01", 90);
    expect(isWithinHorizon(cal, clock, atBoundary)).toBe(true);
  });

  it("a past date is always rejected", () => {
    const cal = baseCalendar();
    const clock = fixedClock("2026-08-01", 9 * 60);
    expect(isWithinHorizon(cal, clock, "2026-07-31")).toBe(false);
  });

  it("today with a minimumLeadMinutes that no longer fits before midnight is rejected", () => {
    const cal = baseCalendar({ minimumLeadMinutes: 60 });
    const clock = fixedClock("2026-08-01", 23 * 60 + 30); // 23:30, +60min lead would be past midnight
    expect(isWithinHorizon(cal, clock, "2026-08-01")).toBe(false);
  });

  it("today with a minimumLeadMinutes that still fits is accepted", () => {
    const cal = baseCalendar({ minimumLeadMinutes: 60 });
    const clock = fixedClock("2026-08-01", 9 * 60);
    expect(isWithinHorizon(cal, clock, "2026-08-01")).toBe(true);
  });
});

// Regression tests for the lead's Phase 4a correction: the venue is an OUTER
// BOUND, not merely a fallback. Before the fix, a venue-level constraint was
// consulted only when the employee had no schedule of their own, which let
// levels 4 and 5 escape level 2 and inverted the required precedence.
describe("resolveDayWindows: the venue window clamps employee hours", () => {
  it("a special opening narrower than the employee's own schedule wins", () => {
    const rule: VenueCalendarRule = {
      id: "r-special",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "10:00",
      specialClose: "14:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()], // employee says 09:00-17:00
      venueRules: [rule], // venue says 10:00-14:00
    });
    const { windows, appliedLevel } = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(windows).toEqual([{ startMinutes: 600, endMinutes: 840 }]);
    expect(appliedLevel).toBe("venue_rule");
    // The employee cannot be booked at 09:00: the shop is shut.
    expect(isSlotFree(cal, EMP, MONDAY_ISO, 540)).toBe(false);
    expect(isSlotFree(cal, EMP, MONDAY_ISO, 600)).toBe(true);
  });

  it("a special opening also clamps an employee schedule override", () => {
    const rule: VenueCalendarRule = {
      id: "r-special",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "10:00",
      specialClose: "14:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const override: EmployeeScheduleOverride = {
      id: "o-late",
      employeeId: EMP,
      date: MONDAY_ISO,
      workDayStart: "08:00",
      workDayEnd: "20:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      venueRules: [rule],
      overrides: [override],
    });
    const { windows } = resolveDayWindows(cal, EMP, MONDAY_ISO);
    // The override may narrow within the venue window, never beyond it.
    expect(windows).toEqual([{ startMinutes: 600, endMinutes: 840 }]);
  });

  it("a special opening wider than the employee's schedule does not widen it", () => {
    const rule: VenueCalendarRule = {
      id: "r-wide",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "07:00",
      specialClose: "22:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      venueRules: [rule],
    });
    const { windows } = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(windows).toEqual([{ startMinutes: 540, endMinutes: 1020 }]);
  });

  it("venue-owned weekly hours bound an employee who claims a longer day", () => {
    const venueMonday: WeeklySchedule = {
      ownerKind: "venue",
      dayOfWeek: 1,
      workDayStart: "09:30",
      workDayEnd: "15:00",
    };
    const cal = baseCalendar({
      weeklySchedules: [venueMonday, plainMondaySchedule()], // employee 09:00-17:00
    });
    const { windows } = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(windows).toEqual([{ startMinutes: 570, endMinutes: 900 }]);
  });

  it("with no venue-owned hours at all, the employee schedule stands untouched", () => {
    // The frozen step 12 profile has this shape. Clamping against a
    // non-existent venue window would close the shop, so it must not happen.
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()] });
    const { windows } = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(windows).toEqual([{ startMinutes: 540, endMinutes: 1020 }]);
  });
});

// =====================================================================
// step 26 §2 · B1 y B2 — LA ARITMÉTICA DE INTERVALO Y SU PUERTA
//
// Lo que estas dos tandas fijan es lo que hace posible una cita manual de
// duración flexible sin construir un segundo calendario: que exista una
// pregunta —«¿está libre TODO [inicio, fin)?»— contestada por las MISMAS
// ventanas de `resolveDayWindows` que ya deciden todo lo demás, y que la
// rejilla de 30 minutos de la voz (`toSlots`, `freeSlotStarts`, `isSlotFree`)
// no se entere de nada.
//
// Lo que NO firman: nada de navegador, nada de HTTP y nada de duración
// comercial — el catálogo sigue diciendo que los tres servicios duran 30
// minutos, y estas funciones no opinan sobre eso.
// =====================================================================

describe("step 26 §2 · B1 — coversInterval: contención, adyacencia, :15 y :45", () => {
  const jornada = [{ startMinutes: 540, endMinutes: 1020 }]; // 09:00–17:00

  it("un intervalo contenido por completo está cubierto; uno que se sale, no", () => {
    expect(coversInterval(jornada, 600, 690)).toBe(true); // 10:00–11:30
    expect(coversInterval(jornada, 540, 1020)).toBe(true); // los bordes exactos
    expect(coversInterval(jornada, 990, 1080)).toBe(false); // 16:30–18:00, se sale por el final
    expect(coversInterval(jornada, 510, 600)).toBe(false); // 08:30–10:00, se sale por el principio
    expect(coversInterval([], 600, 690)).toBe(false);
  });

  it("inicios y finales a :15 y a :45 no son un caso especial: la aritmética es de minutos", () => {
    expect(coversInterval(jornada, 555, 645)).toBe(true); // 09:15–10:45
    expect(coversInterval(jornada, 645, 780)).toBe(true); // 10:45–13:00
    expect(coversInterval(jornada, 1005, 1035)).toBe(false); // 16:45–17:15
  });

  it("DOS TRAMOS QUE SE TOCAN describen tiempo continuo, y se unen antes de decidir", () => {
    // Lo que deja `subtract` con un corte de longitud cero, o dos reservas
    // consecutivas: una frontera que no existe en el reloj.
    const pegados = [
      { startMinutes: 540, endMinutes: 780 },
      { startMinutes: 780, endMinutes: 1200 },
    ];
    expect(coversInterval(pegados, 750, 840)).toBe(true); // 12:30–14:00, a caballo
    // Y un hueco de verdad entre los dos tramos NO se une.
    const separados = [
      { startMinutes: 540, endMinutes: 780 },
      { startMinutes: 840, endMinutes: 1200 },
    ];
    expect(coversInterval(separados, 750, 870)).toBe(false);
  });

  it("una pregunta mal formada —intervalo vacío o invertido— se contesta que NO", () => {
    expect(coversInterval(jornada, 600, 600)).toBe(false);
    expect(coversInterval(jornada, 690, 600)).toBe(false);
  });
});

describe("step 26 §2 · B1 — startsFitting: el paso y la duración, desacoplados", () => {
  it("emite sólo los inicios en los que el bloque cabe ENTERO, alineados al paso", () => {
    const tramo = [{ startMinutes: 540, endMinutes: 660 }]; // 09:00–11:00
    expect(startsFitting(tramo, 90, 15)).toEqual([540, 555, 570]);
    expect(startsFitting(tramo, 30, 30)).toEqual([540, 570, 600, 630]);
    // Una duración que no cabe no produce ningún inicio, y no es un error.
    expect(startsFitting(tramo, 150, 15)).toEqual([]);
  });

  it("la rejilla es ABSOLUTA desde medianoche, no relativa al inicio del tramo", () => {
    const tramo = [{ startMinutes: 545, endMinutes: 700 }]; // 09:05–11:40
    expect(startsFitting(tramo, 60, 15)[0]).toBe(555); // 09:15, no 09:05
  });

  it("une los tramos adyacentes, y por eso encuentra inicios que `toSlots` no puede encontrar", () => {
    const pegados = [
      { startMinutes: 540, endMinutes: 600 },
      { startMinutes: 600, endMinutes: 660 },
    ];
    expect(startsFitting(pegados, 60, 30)).toEqual([540, 570, 600]);
    // `toSlots`, la rejilla congelada de la voz, sigue contestando lo suyo:
    // bloques de 30 dentro de cada tramo, sin unir nada.
    expect(toSlots(pegados, 30)).toEqual([540, 570, 600, 630]);
  });

  it("una duración o un paso imposibles devuelven la lista vacía, no una división por cero", () => {
    const tramo = [{ startMinutes: 540, endMinutes: 660 }];
    expect(startsFitting(tramo, 0, 15)).toEqual([]);
    expect(startsFitting(tramo, -30, 15)).toEqual([]);
    expect(startsFitting(tramo, 30, 0)).toEqual([]);
  });
});

describe("step 26 §2 · B2 — isIntervalFree contra los siete niveles, sin añadir ni una regla", () => {
  it("cruzar la PAUSA es imposible, y los tramos de antes y de después sí caben", () => {
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule({ breakStart: "13:00", breakEnd: "14:00" })],
    });
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 750, 870)).toBe(false); // 12:30–14:30
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 600, 720)).toBe(true); // 10:00–12:00
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 840, 960)).toBe(true); // 14:00–16:00
  });

  it("cruzar el CIERRE del día es imposible, aunque el inicio sí esté dentro", () => {
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()] }); // 09:00–17:00
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 990, 1050)).toBe(false); // 16:30–17:30
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 960, 1020)).toBe(true); // 16:00–17:00, justo hasta el cierre
  });

  it("un CIERRE DEL LOCAL aprobado no deja caber nada", () => {
    const closure: VenueClosure = {
      id: "cierre-m26",
      kind: "full_closure",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], closures: [closure] });
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 600, 690)).toBe(false);
  });

  it("un FESTIVO aprobado tampoco, y uno sin aprobar no cierra nada por su cuenta", () => {
    const festivo = (approval: "approved" | "pending_review"): VenueCalendarRule => ({
      id: `festivo-m26-${approval}`,
      kind: "holiday",
      scope: "municipal",
      date: MONDAY_ISO,
      closed: true,
      source: "imported_provider",
      approval,
      audit: audit(),
    });
    const conFestivo = baseCalendar({ weeklySchedules: [plainMondaySchedule()], venueRules: [festivo("approved")] });
    expect(isIntervalFree(conFestivo, EMP, MONDAY_ISO, 600, 690)).toBe(false);

    const sinAprobar = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      venueRules: [festivo("pending_review")],
    });
    expect(isIntervalFree(sinAprobar, EMP, MONDAY_ISO, 600, 690)).toBe(true);
  });

  it("una AUSENCIA PARCIAL corta el día por donde ella dice, y no un minuto más", () => {
    const ausencia: EmployeeAbsence = {
      id: "ausencia-m26",
      employeeId: EMP,
      kind: "absence",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: false,
      startMinutes: 660, // 11:00
      endMinutes: 720, // 12:00
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], absences: [ausencia] });
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 630, 690)).toBe(false); // 10:30–11:30, la pisa
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 540, 660)).toBe(true); // 09:00–11:00, justo antes
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 720, 840)).toBe(true); // 12:00–14:00, justo después
  });

  it("OTRA CITA bloquea el intervalo por los DOS extremos, no sólo cuando contiene su inicio", () => {
    const cita: SyntheticReservation = {
      id: "res-m26-1",
      employeeId: EMP,
      serviceId: 1,
      date: MONDAY_ISO,
      startMinutes: 600, // 10:00
      endMinutes: 690, // 11:30
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], reservations: [cita] });
    // Solapamiento por el extremo IZQUIERDO: la petición empieza antes y pisa.
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 570, 630)).toBe(false); // 09:30–10:30
    // Por el derecho.
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 660, 750)).toBe(false); // 11:00–12:30
    // Conteniéndola entera.
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 570, 720)).toBe(false); // 09:30–12:00
    // Y los dos tramos que quedan de verdad libres, sí.
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 540, 600)).toBe(true); // 09:00–10:00
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 690, 780)).toBe(true); // 11:30–13:00
    // Una cita CANCELADA no bloquea nada: la verdad es el estado.
    const conCancelada = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      reservations: [{ ...cita, status: "cancelled" }],
    });
    expect(isIntervalFree(conCancelada, EMP, MONDAY_ISO, 570, 720)).toBe(true);
  });

  it("dos citas CONSECUTIVAS dejan un hueco continuo: la frontera entre ellas no existe", () => {
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      reservations: [
        {
          id: "res-m26-2",
          employeeId: EMP,
          serviceId: 1,
          date: MONDAY_ISO,
          startMinutes: 540,
          endMinutes: 570,
          status: "confirmed",
          synthetic: true,
        },
        {
          id: "res-m26-3",
          employeeId: EMP,
          serviceId: 1,
          date: MONDAY_ISO,
          startMinutes: 570,
          endMinutes: 600,
          status: "confirmed",
          synthetic: true,
        },
      ],
    });
    // 10:00–12:15, justo detrás de las dos: un solo tramo, aunque las dos
    // restas lo hayan dejado escrito en dos trozos pegados.
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 600, 735)).toBe(true);
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 555, 600)).toBe(false);
  });

  it("un día sin horario declarado no admite ningún intervalo", () => {
    const cal = baseCalendar({ weeklySchedules: [] });
    expect(isIntervalFree(cal, EMP, MONDAY_ISO, 600, 690)).toBe(false);
  });

  it("freeStartsForDuration ofrece inicios de 15 en 15 que caben enteros, y freeSlotStarts NO cambia", () => {
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule({ workDayStart: "09:00", workDayEnd: "12:00" })],
    });
    expect(freeStartsForDuration(cal, EMP, MONDAY_ISO, 90, 15)).toEqual([540, 555, 570, 585, 600, 615, 630]);
    expect(freeStartsForDuration(cal, EMP, MONDAY_ISO, 30, 30)).toEqual(freeSlotStarts(cal, EMP, MONDAY_ISO));
    // La puerta de la voz sigue contestando lo mismo que siempre.
    expect(freeSlotStarts(cal, EMP, MONDAY_ISO)).toEqual([540, 570, 600, 630, 660, 690]);
    expect(isSlotFree(cal, EMP, MONDAY_ISO, 555)).toBe(false); // :15 nunca fue un inicio de la rejilla
  });
});

// =====================================================================
// step 26 REAPERTURA §R13 — UNA SOLA ARITMÉTICA DE IMPACTO
//
// El bucle reserva-a-reserva de `previewImpact` se extrae a
// `reservasQueDejanDeCaber(cal, candidato, prefiltro)` para que el alta de un
// cambio y la RETIRADA de uno ya publicado (`calendar/withdrawal.ts`) hagan
// exactamente la misma cuenta con el mismo `resolveDayWindows`. Lo que estas
// pruebas fijan es (a) que la función existe y es la que usa `previewImpact`
// —mismo resultado, reserva por reserva—, (b) que una reserva no se declara
// impactada por ocuparse a sí misma, y (c) que el prefiltro es quien decide
// qué reservas se miran siquiera.
// =====================================================================

describe("REAPERTURA §R13 — reservasQueDejanDeCaber: el bucle de impacto, extraído y compartido", () => {
  function citaDeLaTarde(overrides: Partial<SyntheticReservation> = {}): SyntheticReservation {
    return {
      id: "res-impacto-1",
      employeeId: EMP,
      serviceId: 1,
      date: MONDAY_ISO,
      startMinutes: 10 * 60,
      endMinutes: 10 * 60 + 30,
      status: "confirmed",
      synthetic: true,
      ...overrides,
    };
  }

  function cierreDelDia(): VenueClosure {
    return {
      id: "cierre-r13",
      kind: "full_closure",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
  }

  it("da exactamente lo mismo que previewImpact para el mismo candidato: una sola cuenta, dos llamadas", () => {
    const cita = citaDeLaTarde();
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], reservations: [cita] });
    const cierre = cierreDelDia();

    const porElAlta = previewImpact(cal, { kind: "venue_closure", closure: cierre }).impacted;
    const porElAyudante = reservasQueDejanDeCaber(
      cal,
      { ...cal, closures: [...cal.closures, cierre] },
      (r) => r.date === MONDAY_ISO,
    );

    expect(porElAlta).toEqual([
      {
        reservationId: "res-impacto-1",
        employeeId: EMP,
        date: MONDAY_ISO,
        startMinutes: 600,
        endMinutes: 630,
        serviceId: 1,
      },
    ]);
    expect(porElAyudante).toEqual(porElAlta);
  });

  it("una reserva NO se declara impactada por ocuparse a sí misma: el candidato sin cambios no impacta a nadie", () => {
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      reservations: [citaDeLaTarde()],
    });
    expect(reservasQueDejanDeCaber(cal, cal, () => true)).toEqual([]);
  });

  it("el prefiltro decide qué reservas se miran: una fuera del filtro nunca se reporta, aunque el día se cierre entero", () => {
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      reservations: [citaDeLaTarde()],
    });
    const candidato = { ...cal, closures: [...cal.closures, cierreDelDia()] };
    expect(reservasQueDejanDeCaber(cal, candidato, (r) => r.employeeId !== EMP)).toEqual([]);
    // Y una cita CANCELADA tampoco entra jamás, filtre lo que filtre el prefiltro.
    const conCancelada = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      reservations: [citaDeLaTarde({ status: "cancelled" })],
    });
    expect(
      reservasQueDejanDeCaber(conCancelada, { ...conCancelada, closures: [cierreDelDia()] }, () => true),
    ).toEqual([]);
  });
});

// =====================================================================
// step 26 REAPERTURA §R11 — LA NOTA OPERATIVA NO SALE EN UN ImpactReport
//
// `AuditStamp.note` se habilita (R11) para que el operador pueda anotar en
// castellano por qué apuntó un cierre o una ausencia, y se LEE hacia el
// snapshot de la consola. Lo que NO puede pasar es que viaje dentro de un
// informe de impacto: el informe lleva el `change`, el `change` lleva el
// `audit`, y ésa sería una segunda vía de salida al lado de la que ya se
// cerró con `privateReason`. `sanitizeChangeForReport` se amplía para
// purgarla, con el mismo criterio y en la misma función.
// =====================================================================

describe("REAPERTURA §R11 — ni privateReason ni audit.note salen dentro de un ImpactReport", () => {
  const NOTA = "NOTA-OPERATIVA-QUE-NO-VIAJA-EN-EL-INFORME";
  const SECRETO = "SECRETO-QUE-NUNCA-SALE-DEL-SERVIDOR";

  it("el informe de un cierre de local no lleva la nota de su sello de auditoría", () => {
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()] });
    const informe = previewImpact(cal, {
      kind: "venue_closure",
      closure: {
        id: "cierre-con-nota",
        kind: "full_closure",
        startDate: MONDAY_ISO,
        endDate: MONDAY_ISO,
        source: "manual_override",
        approval: "approved",
        audit: audit({ note: NOTA }),
      },
    });
    expect(JSON.stringify(informe)).not.toContain(NOTA);
    expect(informe.change.kind).toBe("venue_closure");
    // Y lo que SÍ sigue viajando, sigue viajando: el informe no se vacía.
    expect(JSON.stringify(informe)).toContain("cierre-con-nota");
  });

  it("el informe de un día especial tampoco la lleva", () => {
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()] });
    const informe = previewImpact(cal, {
      kind: "venue_rule",
      rule: {
        id: "especial-con-nota",
        kind: "special_opening",
        scope: "venue",
        date: MONDAY_ISO,
        closed: false,
        specialOpen: "10:00",
        specialClose: "14:00",
        source: "manual_override",
        approval: "approved",
        audit: audit({ note: NOTA }),
      },
    });
    expect(JSON.stringify(informe)).not.toContain(NOTA);
  });

  it("el informe de una ausencia no lleva NI la nota NI el motivo privado", () => {
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()] });
    const informe = previewImpact(cal, {
      kind: "employee_absence",
      absence: {
        id: "ausencia-con-nota",
        employeeId: EMP,
        kind: "absence",
        startDate: MONDAY_ISO,
        endDate: MONDAY_ISO,
        allDay: true,
        privateReason: SECRETO,
        source: "manual_override",
        approval: "approved",
        audit: audit({ note: NOTA }),
      },
    });
    const comoTexto = JSON.stringify(informe);
    expect(comoTexto).not.toContain(NOTA);
    expect(comoTexto).not.toContain(SECRETO);
    expect(comoTexto).not.toContain("privateReason");
    // El resto del sello sigue ahí: quién lo apuntó y cuándo no es un secreto.
    expect(comoTexto).toContain("test-fixture");
  });
});
