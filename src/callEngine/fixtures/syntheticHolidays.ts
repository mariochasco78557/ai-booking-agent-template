import type {
  AuditStamp,
  EmployeeAbsence,
  EmployeeScheduleOverride,
  VenueCalendarRule,
  VenueClosure,
} from "../calendar/model.js";
import type { EmployeeId } from "../domain/types.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * SINTÉTICAS. Todas las fechas, ámbitos y motivos de este fichero están
 * INVENTADOS para la demo local de step 13. NO son el calendario laboral
 * real de ningún año, de ninguna Comunidad Autónoma ni de ningún
 * ayuntamiento — no coinciden a propósito con festivos nacionales reales de
 * España (1 enero, 1 mayo, 15 agosto, 12 octubre, 1/6/8 diciembre, etc.)
 * para que nadie las confunda con datos reales. No deben usarse como
 * referencia de festivos real para Demo Salon ni para ningún otro negocio. Ver
 * (internal doc, not included in the template).
 * ────────────────────────────────────────────────────────────────────────
 */
export const SYNTHETIC_HOLIDAYS_BANNER =
  "Festivos sintéticos · Datos inventados para la demo · No es el calendario laboral real";

/**
 * Forma que devolvería `HolidayProvider.fetchHolidays` (declarada en
 * calendar/model.ts): todavía sin `approval` ni `audit` — esos dos campos
 * los añade `calendar/approval.ts` al importar (siempre como
 * `pending_review`, nunca activo por sí solo). `scope` se restringe aquí a
 * los tres ámbitos que un proveedor de festivos puede declarar (nunca
 * `'venue'`, que es un ámbito exclusivamente manual).
 */
export type ImportedHolidayFixture = Omit<VenueCalendarRule, "approval" | "audit" | "scope"> & {
  source: "imported_provider";
  scope: "national" | "regional" | "municipal";
};

export const SYNTHETIC_NATIONAL_HOLIDAYS: readonly ImportedHolidayFixture[] = [
  {
    id: "holiday-national-fixture-1",
    kind: "holiday",
    scope: "national",
    date: "2026-05-05",
    closed: true,
    source: "imported_provider",
    externalRef: "synthetic-national-fixture-1",
  },
  {
    id: "holiday-national-fixture-2",
    kind: "holiday",
    scope: "national",
    date: "2026-11-11",
    closed: true,
    source: "imported_provider",
    externalRef: "synthetic-national-fixture-2",
  },
];

export const SYNTHETIC_REGIONAL_HOLIDAYS: readonly ImportedHolidayFixture[] = [
  {
    id: "holiday-regional-fixture-1",
    kind: "holiday",
    scope: "regional",
    date: "2026-06-09",
    closed: true,
    source: "imported_provider",
    externalRef: "synthetic-regional-fixture-1",
  },
  {
    id: "holiday-regional-fixture-2",
    kind: "holiday",
    scope: "regional",
    date: "2026-09-08",
    closed: true,
    source: "imported_provider",
    externalRef: "synthetic-regional-fixture-2",
  },
];

export const SYNTHETIC_MUNICIPAL_HOLIDAYS: readonly ImportedHolidayFixture[] = [
  {
    id: "holiday-municipal-fixture-1",
    kind: "holiday",
    scope: "municipal",
    date: "2026-07-20",
    closed: true,
    source: "imported_provider",
    externalRef: "synthetic-municipal-fixture-1",
  },
  {
    id: "holiday-municipal-fixture-2",
    kind: "holiday",
    scope: "municipal",
    date: "2026-10-05",
    closed: true,
    source: "imported_provider",
    externalRef: "synthetic-municipal-fixture-2",
  },
];

/** Union of the three scopes above — the full synthetic catalogue a `HolidayProvider` might return. */
export function allSyntheticHolidays(): readonly ImportedHolidayFixture[] {
  return [
    ...SYNTHETIC_NATIONAL_HOLIDAYS,
    ...SYNTHETIC_REGIONAL_HOLIDAYS,
    ...SYNTHETIC_MUNICIPAL_HOLIDAYS,
  ];
}

/** Deterministic, synthetic `AuditStamp` builder shared by every fixture below. No wall clock read. */
export function syntheticAudit(overrides: Partial<AuditStamp> = {}): AuditStamp {
  return {
    createdAt: "2026-01-01T00:00:00",
    createdBy: "fixture:synthetic-demo",
    ...overrides,
  };
}

/** A synthetic full closure of the venue (e.g. "cerramos por reforma"), already approved. */
export function syntheticManualClosure(overrides: Partial<VenueClosure> = {}): VenueClosure {
  return {
    id: "closure-fixture-default",
    kind: "full_closure",
    startDate: "2026-08-10",
    endDate: "2026-08-10",
    source: "manual_override",
    approval: "approved",
    audit: syntheticAudit(),
    ...overrides,
  };
}

/** A synthetic special-opening rule (e.g. "abrimos festivo con horario reducido"), already approved. */
export function syntheticSpecialOpening(overrides: Partial<VenueCalendarRule> = {}): VenueCalendarRule {
  return {
    id: "special-opening-fixture-default",
    kind: "special_opening",
    scope: "venue",
    date: "2026-08-11",
    closed: false,
    specialOpen: "10:00",
    specialClose: "13:00",
    source: "manual_override",
    approval: "approved",
    audit: syntheticAudit(),
    ...overrides,
  };
}

/** A synthetic employee vacation (all-day, multi-day), already approved. */
export function syntheticEmployeeVacation(
  employeeId: EmployeeId,
  overrides: Partial<EmployeeAbsence> = {},
): EmployeeAbsence {
  return {
    id: `vacation-fixture-${employeeId}`,
    employeeId,
    kind: "vacation",
    startDate: "2026-08-12",
    endDate: "2026-08-14",
    allDay: true,
    source: "manual_override",
    approval: "approved",
    audit: syntheticAudit(),
    ...overrides,
  };
}

/** A synthetic employee training absence (`kind: 'training'`), all-day, already approved. */
export function syntheticTrainingAbsence(
  employeeId: EmployeeId,
  overrides: Partial<EmployeeAbsence> = {},
): EmployeeAbsence {
  return {
    id: `training-fixture-${employeeId}`,
    employeeId,
    kind: "training",
    startDate: "2026-08-13",
    endDate: "2026-08-13",
    allDay: true,
    source: "manual_override",
    approval: "approved",
    audit: syntheticAudit(),
    ...overrides,
  };
}

/** A synthetic PARTIAL-day absence (e.g. a medical appointment mid-shift), already approved. */
export function syntheticPartialDayAbsence(
  employeeId: EmployeeId,
  overrides: Partial<EmployeeAbsence> = {},
): EmployeeAbsence {
  return {
    id: `partial-absence-fixture-${employeeId}`,
    employeeId,
    kind: "absence",
    startDate: "2026-08-17",
    endDate: "2026-08-17",
    allDay: false,
    startMinutes: 11 * 60,
    endMinutes: 12 * 60,
    source: "manual_override",
    approval: "approved",
    audit: syntheticAudit(),
    ...overrides,
  };
}

/** A synthetic one-day schedule override for a single employee, already approved. */
export function syntheticScheduleOverride(
  employeeId: EmployeeId,
  overrides: Partial<EmployeeScheduleOverride> = {},
): EmployeeScheduleOverride {
  return {
    id: `override-fixture-${employeeId}`,
    employeeId,
    date: "2026-08-18",
    workDayStart: "12:00",
    workDayEnd: "16:00",
    source: "manual_override",
    approval: "approved",
    audit: syntheticAudit(),
    ...overrides,
  };
}
