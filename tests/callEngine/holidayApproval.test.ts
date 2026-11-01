import { describe, expect, it } from "vitest";
import {
  activateApproved,
  auditTrail,
  importHolidays,
  manualOverride,
  reviewRule,
} from "../../src/callEngine/calendar/approval.js";
import { applyChange, previewImpact } from "../../src/callEngine/calendar/impact.js";
import { StaticSyntheticHolidayProvider } from "../../src/callEngine/calendar/holidayProvider.js";
import {
  freeSlotStarts,
  isSlotFree,
  resolveDayWindows,
} from "../../src/callEngine/calendar/resolveAvailability.js";
import type {
  EmployeeAbsence,
  OperationalCalendar,
  SyntheticReservation,
  WeeklySchedule,
} from "../../src/callEngine/calendar/model.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";

// Synthetic test fixtures only — no real Demo Salon data anywhere in this file.
const EMP = 1;
const TEST_PROFILE = { employeeId: EMP, displayName: "Test Pro (sintético)", synthetic: true as const };
// A national holiday from the synthetic fixture catalogue, chosen because
// it is a Monday (see fixtures/syntheticHolidays.ts for the full list).
const HOLIDAY_DATE = "2026-07-20"; // synthetic municipal-fixture-1's own date
const NATIONAL_HOLIDAY_ID = "holiday-national-fixture-1"; // 2026-05-05, a Tuesday

function fullWeekSchedule(employeeId: number): WeeklySchedule[] {
  return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    ownerKind: "employee",
    employeeId,
    dayOfWeek,
    workDayStart: "09:00",
    workDayEnd: "17:00",
  }));
}

function baseCalendar(overrides: Partial<OperationalCalendar> = {}): OperationalCalendar {
  return {
    professionals: [TEST_PROFILE],
    weeklySchedules: fullWeekSchedule(EMP),
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

describe("holidayApproval: importar, aprobar/rechazar y auditar", () => {
  it("1. lo importado nace pending_review e INERTE: no cambia ninguna disponibilidad", async () => {
    const cal = baseCalendar();
    const before = resolveDayWindows(cal, EMP, HOLIDAY_DATE);

    const provider = new StaticSyntheticHolidayProvider();
    const clock = fixedClock("2026-01-01", 9 * 60);
    const batch = await importHolidays(
      provider,
      { from: "2026-01-01", to: "2026-12-31", scopes: ["national", "regional", "municipal"] },
      clock,
      "gerente@demo-salon.test",
    );
    expect(batch.rules.length).toBeGreaterThan(0);
    expect(batch.rules.every((r) => r.approval === "pending_review")).toBe(true);

    const calWithBatch = activateApproved(cal, batch);
    const after = resolveDayWindows(calWithBatch, EMP, HOLIDAY_DATE);
    expect(after.windows).toEqual(before.windows);
    expect(after.appliedLevel).toBe(before.appliedLevel);
  });

  it("2. aprobar una regla la activa (el día pasa a cerrado)", async () => {
    const cal = baseCalendar();
    const provider = new StaticSyntheticHolidayProvider();
    const clock = fixedClock("2026-01-01", 9 * 60);
    const batch = await importHolidays(
      provider,
      { from: "2026-01-01", to: "2026-12-31", scopes: ["municipal"] },
      clock,
      "gerente@demo-salon.test",
    );
    const target = batch.rules.find((r) => r.date === HOLIDAY_DATE);
    expect(target).toBeDefined();

    const reviewed = reviewRule(batch, target!.id, "approve", clock, "responsable@demo-salon.test");
    const calAfter = activateApproved(cal, reviewed);
    const result = resolveDayWindows(calAfter, EMP, HOLIDAY_DATE);
    expect(result.windows).toEqual([]);
    expect(result.appliedLevel).toBe("venue_rule");
  });

  it("3. rechazar una regla NO la activa (el día sigue abierto)", async () => {
    const cal = baseCalendar();
    const provider = new StaticSyntheticHolidayProvider();
    const clock = fixedClock("2026-01-01", 9 * 60);
    const batch = await importHolidays(
      provider,
      { from: "2026-01-01", to: "2026-12-31", scopes: ["municipal"] },
      clock,
      "gerente@demo-salon.test",
    );
    const target = batch.rules.find((r) => r.date === HOLIDAY_DATE)!;

    const reviewed = reviewRule(batch, target.id, "reject", clock, "responsable@demo-salon.test");
    const calAfter = activateApproved(cal, reviewed);
    const result = resolveDayWindows(calAfter, EMP, HOLIDAY_DATE);
    expect(result.windows).toEqual([{ startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
  });

  it("4. reviewRule no muta el lote recibido", async () => {
    const provider = new StaticSyntheticHolidayProvider();
    const clock = fixedClock("2026-01-01", 9 * 60);
    const batch = await importHolidays(
      provider,
      { from: "2026-01-01", to: "2026-12-31", scopes: ["national"] },
      clock,
      "gerente@demo-salon.test",
    );
    const target = batch.rules.find((r) => r.id === NATIONAL_HOLIDAY_ID)!;
    const snapshot = JSON.parse(JSON.stringify(batch));

    const reviewed = reviewRule(batch, target.id, "approve", clock, "responsable@demo-salon.test");

    expect(JSON.parse(JSON.stringify(batch))).toEqual(snapshot);
    expect(batch.rules.find((r) => r.id === NATIONAL_HOLIDAY_ID)!.approval).toBe("pending_review");
    expect(reviewed.rules.find((r) => r.id === NATIONAL_HOLIDAY_ID)!.approval).toBe("approved");
    expect(reviewed).not.toBe(batch);
  });

  it("5. el AuditStamp conserva quién importó, quién aprobó y cuándo", async () => {
    const provider = new StaticSyntheticHolidayProvider();
    const importClock = fixedClock("2026-01-01", 9 * 60);
    const reviewClock = fixedClock("2026-01-02", 10 * 60);
    const batch = await importHolidays(
      provider,
      { from: "2026-01-01", to: "2026-12-31", scopes: ["national"] },
      importClock,
      "importador@demo-salon.test",
    );
    const target = batch.rules.find((r) => r.id === NATIONAL_HOLIDAY_ID)!;
    expect(target.audit.createdBy).toBe("importador@demo-salon.test");
    expect(target.audit.createdAt).toBe(importClock.nowInstantISO());
    expect(target.audit.approvedAt).toBeUndefined();
    expect(target.audit.approvedBy).toBeUndefined();

    const reviewed = reviewRule(batch, target.id, "approve", reviewClock, "responsable@demo-salon.test");
    const reviewedRule = reviewed.rules.find((r) => r.id === NATIONAL_HOLIDAY_ID)!;
    expect(reviewedRule.audit.createdBy).toBe("importador@demo-salon.test");
    expect(reviewedRule.audit.createdAt).toBe(importClock.nowInstantISO());
    expect(reviewedRule.audit.approvedBy).toBe("responsable@demo-salon.test");
    expect(reviewedRule.audit.approvedAt).toBe(reviewClock.nowInstantISO());
  });

  it("6. auditTrail rinde cuentas legibles, en castellano, de importación y revisión", async () => {
    const provider = new StaticSyntheticHolidayProvider();
    const clock = fixedClock("2026-01-01", 9 * 60);
    const batch = await importHolidays(
      provider,
      { from: "2026-01-01", to: "2026-12-31", scopes: ["national"] },
      clock,
      "importador@demo-salon.test",
    );
    const target = batch.rules.find((r) => r.id === NATIONAL_HOLIDAY_ID)!;
    const reviewed = reviewRule(batch, target.id, "approve", clock, "responsable@demo-salon.test");

    const trail = auditTrail(reviewed);
    expect(trail.length).toBeGreaterThan(1);
    expect(trail[0]).toContain("importado");
    expect(trail[0]).toContain("importador@demo-salon.test");
    const ruleLine = trail.find((l) => l.includes(NATIONAL_HOLIDAY_ID))!;
    expect(ruleLine).toContain("importador@demo-salon.test");
    expect(ruleLine).toContain("responsable@demo-salon.test");
    expect(ruleLine).toContain("aprobada");

    // A never-reviewed rule is reported as pending, not silently omitted.
    const pendingLine = trail.find(
      (l) => l.includes("holiday-national-fixture-2") && !l.includes(NATIONAL_HOLIDAY_ID),
    );
    expect(pendingLine).toContain("Pendiente de revisión humana");
  });

  it("7. manualOverride gana a lo importado en la misma fecha", async () => {
    const cal = baseCalendar();
    const provider = new StaticSyntheticHolidayProvider();
    const clock = fixedClock("2026-01-01", 9 * 60);
    const batch = await importHolidays(
      provider,
      { from: "2026-01-01", to: "2026-12-31", scopes: ["municipal"] },
      clock,
      "gerente@demo-salon.test",
    );
    const target = batch.rules.find((r) => r.date === HOLIDAY_DATE)!;
    const reviewed = reviewRule(batch, target.id, "approve", clock, "responsable@demo-salon.test");
    let calAfter = activateApproved(cal, reviewed);

    const manual = manualOverride(
      {
        id: "manual-opening-approval-test",
        kind: "special_opening",
        scope: "venue",
        date: HOLIDAY_DATE,
        closed: false,
        specialOpen: "12:00",
        specialClose: "14:00",
      },
      clock,
      "responsable@demo-salon.test",
    );
    calAfter = { ...calAfter, venueRules: [...calAfter.venueRules, manual] };

    const result = resolveDayWindows(calAfter, EMP, HOLIDAY_DATE);
    expect(result.windows).toEqual([{ startMinutes: 12 * 60, endMinutes: 14 * 60 }]);
  });

  it("8. previewImpact NO muta nada: el calendario es idéntico antes y después", () => {
    const reservation: SyntheticReservation = {
      id: "res-approval-8",
      employeeId: EMP,
      serviceId: 1,
      date: HOLIDAY_DATE,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({ reservations: [reservation] });
    const before = JSON.parse(JSON.stringify(cal));

    const clock = fixedClock("2026-01-01", 9 * 60);
    const closure = manualOverride(
      { id: "irrelevant-rule-8", kind: "holiday", scope: "venue", date: HOLIDAY_DATE, closed: true },
      clock,
      "gerente@demo-salon.test",
    );
    previewImpact(cal, { kind: "venue_rule", rule: closure });

    expect(JSON.parse(JSON.stringify(cal))).toEqual(before);
  });

  it("9. applyChange SIN resoluciones no aplica nada y devuelve las reservas no resueltas", () => {
    const reservation: SyntheticReservation = {
      id: "res-approval-9",
      employeeId: EMP,
      serviceId: 1,
      date: HOLIDAY_DATE,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({ reservations: [reservation] });
    const clock = fixedClock("2026-01-01", 9 * 60);
    const closure = manualOverride(
      { id: "closing-rule-9", kind: "holiday", scope: "venue", date: HOLIDAY_DATE, closed: true },
      clock,
      "gerente@demo-salon.test",
    );

    const { cal: calAfter, unresolved } = applyChange(
      cal,
      { kind: "venue_rule", rule: closure },
      new Map(),
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.reservationId).toBe("res-approval-9");
    // Nothing applied: the rule never made it into the calendar.
    expect(calAfter.venueRules).toEqual(cal.venueRules);
    expect(resolveDayWindows(calAfter, EMP, HOLIDAY_DATE).windows).toEqual([
      { startMinutes: 9 * 60 + 30, endMinutes: 17 * 60 },
    ]);
  });

  it("10. applyChange CON resoluciones para todas las reservas impactadas aplica el cambio y no cancela ninguna reserva", () => {
    const reservation: SyntheticReservation = {
      id: "res-approval-10",
      employeeId: EMP,
      serviceId: 1,
      date: HOLIDAY_DATE,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({ reservations: [reservation] });
    const clock = fixedClock("2026-01-01", 9 * 60);
    const closure = manualOverride(
      { id: "closing-rule-10", kind: "holiday", scope: "venue", date: HOLIDAY_DATE, closed: true },
      clock,
      "gerente@demo-salon.test",
    );

    const { cal: calAfter, unresolved } = applyChange(
      cal,
      { kind: "venue_rule", rule: closure },
      new Map([["res-approval-10", "mark_for_human_contact"]]),
    );
    expect(unresolved).toEqual([]);
    expect(calAfter.venueRules).toHaveLength(1);
    expect(resolveDayWindows(calAfter, EMP, HOLIDAY_DATE).windows).toEqual([]);
    // The reservation is still there, still confirmed — never cancelled or moved.
    expect(calAfter.reservations).toEqual(cal.reservations);
    expect(calAfter.reservations[0]!.status).toBe("confirmed");
  });

  it("11. ninguna reserva desaparece nunca del calendario por efecto de un cambio (cierre, ausencia u horario)", () => {
    const reservations: SyntheticReservation[] = [
      {
        id: "res-approval-11a",
        employeeId: EMP,
        serviceId: 1,
        date: HOLIDAY_DATE,
        startMinutes: 9 * 60,
        endMinutes: 9 * 60 + 30,
        status: "confirmed",
        synthetic: true,
      },
      {
        id: "res-approval-11b",
        employeeId: EMP,
        serviceId: 2,
        date: HOLIDAY_DATE,
        startMinutes: 15 * 60,
        endMinutes: 15 * 60 + 30,
        status: "confirmed",
        synthetic: true,
      },
    ];
    const cal = baseCalendar({ reservations });
    const absence: EmployeeAbsence = {
      id: "absence-approval-11",
      employeeId: EMP,
      kind: "vacation",
      startDate: HOLIDAY_DATE,
      endDate: HOLIDAY_DATE,
      allDay: true,
      source: "manual_override",
      approval: "pending_review", // irrelevant to applyChange, which forces it approved for the preview
      audit: { createdAt: "2026-01-01T00:00:00", createdBy: "test" },
    };

    const preview = previewImpact(cal, { kind: "employee_absence", absence });
    expect(preview.impacted).toHaveLength(2);

    const resolutions = new Map(
      preview.impacted.map((r) => [r.reservationId, "keep_and_flag" as const]),
    );
    const { cal: calAfter, unresolved } = applyChange(
      cal,
      { kind: "employee_absence", absence },
      resolutions,
    );
    expect(unresolved).toEqual([]);
    expect(calAfter.reservations).toHaveLength(2);
    expect(calAfter.reservations.map((r) => r.id).sort()).toEqual(["res-approval-11a", "res-approval-11b"]);
    expect(calAfter.reservations.every((r) => r.status === "confirmed")).toBe(true);
  });
});
