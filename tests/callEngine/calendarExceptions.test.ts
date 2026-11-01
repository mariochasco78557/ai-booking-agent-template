import { describe, expect, it } from "vitest";
import {
  resolveDayWindows,
  freeSlotStarts,
  isSlotFree,
} from "../../src/callEngine/calendar/resolveAvailability.js";
import { manualOverride } from "../../src/callEngine/calendar/approval.js";
import { previewImpact } from "../../src/callEngine/calendar/impact.js";
import type {
  AuditStamp,
  EmployeeAbsence,
  EmployeeScheduleOverride,
  OperationalCalendar,
  VenueCalendarRule,
  VenueClosure,
  WeeklySchedule,
} from "../../src/callEngine/calendar/model.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import {
  SYNTHETIC_MUNICIPAL_HOLIDAYS,
  SYNTHETIC_NATIONAL_HOLIDAYS,
  SYNTHETIC_REGIONAL_HOLIDAYS,
} from "../../src/callEngine/fixtures/syntheticHolidays.js";
import {
  ALEX_ID,
  DANI_ID,
  NEREA_ID,
  extendedSyntheticVenue,
} from "../../src/callEngine/fixtures/syntheticVenue.js";
import { chooseProfessional } from "../../src/callEngine/allocation/anyProfessional.js";

// Synthetic test fixtures only — no real Demo Salon data anywhere in this file.
const EMP = 1;
const MONDAY_ISO = "2026-08-03"; // A Monday (dayOfWeek === 1), purely for test convenience.
const TEST_PROFILE = { employeeId: EMP, displayName: "Test Pro (sintético)", synthetic: true as const };

function audit(overrides: Partial<AuditStamp> = {}): AuditStamp {
  return { createdAt: "2026-01-01T00:00:00", createdBy: "test-fixture", ...overrides };
}

function baseCalendar(overrides: Partial<OperationalCalendar> = {}): OperationalCalendar {
  return {
    professionals: [TEST_PROFILE],
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

describe("calendarExceptions: combinaciones exigidas por la misión", () => {
  it("1. cierre de local + horario sobrescrito de empleado -> gana el cierre", () => {
    const closure: VenueClosure = {
      id: "closure-combo-1",
      kind: "full_closure",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const override: EmployeeScheduleOverride = {
      id: "override-combo-1",
      employeeId: EMP,
      date: MONDAY_ISO,
      workDayStart: "10:00",
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

  it("2. festivo importado (cerrado) + apertura especial manual el mismo día -> gana la manual", () => {
    const holidayImported: VenueCalendarRule = {
      ...SYNTHETIC_NATIONAL_HOLIDAYS[0]!,
      date: MONDAY_ISO,
      approval: "approved",
      audit: audit(),
    };
    const specialOpeningManual: VenueCalendarRule = {
      id: "rule-manual-combo-2",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "11:00",
      specialClose: "13:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [],
      venueRules: [holidayImported, specialOpeningManual],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 11 * 60, endMinutes: 13 * 60 }]);
    expect(result.appliedLevel).toBe("venue_rule");
  });

  it("3. vacaciones de empleado + reserva existente -> día vacío, pero la reserva sigue registrada", () => {
    const absence: EmployeeAbsence = {
      id: "vacation-combo-3",
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
      reservations: [
        {
          id: "res-combo-3",
          employeeId: EMP,
          serviceId: 1,
          date: MONDAY_ISO,
          startMinutes: 9 * 60,
          endMinutes: 9 * 60 + 30,
          status: "confirmed",
          synthetic: true,
        },
      ],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("employee_absence");
    // Nothing cancelled or removed the reservation itself.
    expect(cal.reservations).toHaveLength(1);
    expect(cal.reservations[0]!.status).toBe("confirmed");
  });

  it("4. ausencia PARCIAL de día subtrae solo su propio rango", () => {
    const absence: EmployeeAbsence = {
      id: "partial-combo-4",
      employeeId: EMP,
      kind: "absence",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: false,
      startMinutes: 11 * 60,
      endMinutes: 11 * 60 + 30,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], absences: [absence] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([
      { startMinutes: 9 * 60, endMinutes: 11 * 60 },
      { startMinutes: 11 * 60 + 30, endMinutes: 17 * 60 },
    ]);
    expect(result.appliedLevel).toBe("employee_absence");
  });

  it("5. ausencia por formación (kind 'training') bloquea el día igual que una vacación", () => {
    const training: EmployeeAbsence = {
      id: "training-combo-5",
      employeeId: EMP,
      kind: "training",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: true,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], absences: [training] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("employee_absence");
  });

  it("6. se ofrece un profesional alternativo capacitado y libre cuando el primero está ausente", () => {
    const base = extendedSyntheticVenue();
    const alexAbsent: EmployeeAbsence = {
      id: "absence-combo-6",
      employeeId: ALEX_ID,
      kind: "absence",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: true,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = { ...base, absences: [...base.absences, alexAbsent] };
    // Service 1 (corte de pelo): Álex is out, Nerea does not start until
    // 10:00, so Dani is the only capable-and-free alternative at 09:00.
    const choice = chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1);
    expect(choice).toEqual({ employeeId: DANI_ID });
  });

  it("18b. sin alternativa cuando la capacidad y la ausencia se combinan y nadie más puede hacer el servicio", () => {
    const base = extendedSyntheticVenue();
    // Barba (service 0) is only performed by Álex and Dani (Nerea cannot).
    // Take both out and confirm no alternative is offered.
    const bothAbsent: EmployeeAbsence[] = [
      {
        id: "absence-combo-18b-alex",
        employeeId: ALEX_ID,
        kind: "absence",
        startDate: MONDAY_ISO,
        endDate: MONDAY_ISO,
        allDay: true,
        source: "manual_override",
        approval: "approved",
        audit: audit(),
      },
      {
        id: "absence-combo-18b-dani",
        employeeId: DANI_ID,
        kind: "absence",
        startDate: MONDAY_ISO,
        endDate: MONDAY_ISO,
        allDay: true,
        source: "manual_override",
        approval: "approved",
        audit: audit(),
      },
    ];
    const cal = { ...base, absences: [...base.absences, ...bothAbsent] };
    const choice = chooseProfessional(cal, MONDAY_ISO, 9 * 60, 0);
    expect(choice).toEqual({ employeeId: null, reason: "no_capable_and_free" });
  });

  it("7. el motivo privado nunca aparece en notas, ventanas ni en un informe de impacto", () => {
    const secret = "SECRETO-DISTINTIVO-NO-VISIBLE-PARA-CLIENTE";
    const absence: EmployeeAbsence = {
      id: "absence-combo-7",
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
      reservations: [
        {
          id: "res-combo-7",
          employeeId: EMP,
          serviceId: 1,
          date: MONDAY_ISO,
          startMinutes: 10 * 60,
          endMinutes: 10 * 60 + 30,
          status: "confirmed",
          synthetic: true,
        },
      ],
    });

    const resolved = resolveDayWindows(cal, EMP, MONDAY_ISO);
    for (const note of resolved.notes) {
      expect(note).not.toContain(secret);
    }
    expect(JSON.stringify(resolved.windows)).not.toContain(secret);

    // Same absence, previewed as an impact-report change: still no leak.
    const report = previewImpact(cal, { kind: "employee_absence", absence });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("8. revalidación final: un hueco libre deja de serlo tras aplicar una excepción, recalculado desde cero", () => {
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule({ workDayEnd: "10:00" })] });
    expect(isSlotFree(cal, EMP, MONDAY_ISO, 9 * 60)).toBe(true);

    const clock = fixedClock("2026-01-01", 0);
    const rule = manualOverride(
      {
        id: "rule-combo-8",
        kind: "holiday",
        scope: "venue",
        date: MONDAY_ISO,
        closed: true,
      },
      clock,
      "test-manager",
    );
    const calAfter = { ...cal, venueRules: [...cal.venueRules, rule] };
    expect(isSlotFree(calAfter, EMP, MONDAY_ISO, 9 * 60)).toBe(false);
    // Recomputed from scratch again — still false, no caching involved.
    expect(isSlotFree(calAfter, EMP, MONDAY_ISO, 9 * 60)).toBe(false);
  });

  it("9. festivo municipal cierra el día por sí solo", () => {
    const municipal: VenueCalendarRule = {
      ...SYNTHETIC_MUNICIPAL_HOLIDAYS[0]!,
      date: MONDAY_ISO,
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], venueRules: [municipal] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("venue_rule");
  });

  it("10. festivo autonómico (regional) cierra el día por sí solo", () => {
    const regional: VenueCalendarRule = {
      ...SYNTHETIC_REGIONAL_HOLIDAYS[0]!,
      date: MONDAY_ISO,
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], venueRules: [regional] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("venue_rule");
  });

  it("11. festivo nacional cierra el día por sí solo", () => {
    const national: VenueCalendarRule = {
      ...SYNTHETIC_NATIONAL_HOLIDAYS[0]!,
      date: MONDAY_ISO,
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], venueRules: [national] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("venue_rule");
  });

  it("12. una regla pending_review no abre ni cierra el día", () => {
    const pendingHoliday: VenueCalendarRule = {
      ...SYNTHETIC_NATIONAL_HOLIDAYS[1]!,
      date: MONDAY_ISO,
      approval: "pending_review",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      venueRules: [pendingHoliday],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
    expect(result.appliedLevel).toBe("weekly_schedule");
  });

  it("13. una regla rejected se ignora igualmente", () => {
    const rejectedHoliday: VenueCalendarRule = {
      ...SYNTHETIC_REGIONAL_HOLIDAYS[1]!,
      date: MONDAY_ISO,
      approval: "rejected",
      audit: audit(),
    };
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()],
      venueRules: [rejectedHoliday],
    });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
  });

  it("14. manual_override gana a imported_provider en la misma fecha (festivo municipal importado)", () => {
    const municipalImported: VenueCalendarRule = {
      ...SYNTHETIC_MUNICIPAL_HOLIDAYS[1]!,
      date: MONDAY_ISO,
      approval: "approved",
      audit: audit(),
    };
    const manualOpening: VenueCalendarRule = {
      id: "rule-manual-combo-14",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "09:00",
      specialClose: "12:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [], venueRules: [municipalImported, manualOpening] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 12 * 60 }]);
  });

  it("15. una apertura especial (creada vía manualOverride) acota la jornada del empleado", () => {
    const clock = fixedClock("2026-01-01", 0);
    const rule = manualOverride(
      {
        id: "rule-combo-15",
        kind: "special_opening",
        scope: "venue",
        date: MONDAY_ISO,
        closed: false,
        specialOpen: "10:00",
        specialClose: "14:00",
      },
      clock,
      "test-manager",
    );
    const cal = baseCalendar({
      weeklySchedules: [plainMondaySchedule()], // employee says 09:00-17:00
      venueRules: [rule],
    });
    const { windows, appliedLevel } = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(windows).toEqual([{ startMinutes: 10 * 60, endMinutes: 14 * 60 }]);
    expect(appliedLevel).toBe("venue_rule");
    expect(isSlotFree(cal, EMP, MONDAY_ISO, 9 * 60)).toBe(false);
    expect(isSlotFree(cal, EMP, MONDAY_ISO, 10 * 60)).toBe(true);
  });

  it("16. un cierre de local deja a TODOS los profesionales sin huecos", () => {
    const base = extendedSyntheticVenue();
    const closure: VenueClosure = {
      id: "closure-combo-16",
      kind: "full_closure",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = { ...base, closures: [...base.closures, closure] };
    expect(freeSlotStarts(cal, ALEX_ID, MONDAY_ISO)).toEqual([]);
    expect(freeSlotStarts(cal, DANI_ID, MONDAY_ISO)).toEqual([]);
    expect(freeSlotStarts(cal, NEREA_ID, MONDAY_ISO)).toEqual([]);
  });

  it("17. el proveedor sintético filtra festivos por ámbito solicitado y por rango de fechas", async () => {
    const { StaticSyntheticHolidayProvider } = await import(
      "../../src/callEngine/calendar/holidayProvider.js"
    );
    const provider = new StaticSyntheticHolidayProvider();
    const result = await provider.fetchHolidays({
      from: "2026-01-01",
      to: "2026-12-31",
      scopes: ["municipal"],
    });
    expect(result.length).toBe(SYNTHETIC_MUNICIPAL_HOLIDAYS.length);
    for (const rule of result) {
      expect(rule.scope).toBe("municipal");
      expect(rule.source).toBe("imported_provider");
    }
  });

  it("19. una jornada ordinaria (sin excepciones) permanece intacta como control", () => {
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
    expect(result.appliedLevel).toBe("weekly_schedule");
  });

  it("20. una ausencia por formación parcial (no todo el día) también solo subtrae su rango", () => {
    const training: EmployeeAbsence = {
      id: "training-combo-20",
      employeeId: EMP,
      kind: "training",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: false,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [plainMondaySchedule()], absences: [training] });
    const result = resolveDayWindows(cal, EMP, MONDAY_ISO);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60 + 30, endMinutes: 17 * 60 }]);
    expect(result.appliedLevel).toBe("employee_absence");
  });
});
