import type { EmployeeId, ServiceId } from "./domain/types.js";
import type { OperationalCalendar } from "./calendar/model.js";

/**
 * Explicit professional x service capability matrix. We deliberately do NOT
 * assume every professional performs every service, even though the
 * initial synthetic profile happens to have both Álex and Dani capable of
 * all three historical services — that is a property of the fixture, not
 * an assumption baked into this module. See fixtures/syntheticVenue.ts's
 * `extendedSyntheticVenue()`, where Nerea (sintética) is deliberately
 * restricted to a subset of services, so the allocation logic (and its
 * tests) exercise this filter for real rather than trivially.
 */
export type CapabilityMatrix = ReadonlyMap<EmployeeId, ReadonlySet<ServiceId>>;

/**
 * `OperationalCalendar` (calendar/model.ts) intentionally has no
 * capabilities field of its own — capability is a separate concern from
 * the calendar/precedence model. Call-engine code that needs both (like
 * allocation/anyProfessional.ts) works against this calendar-plus-matrix
 * shape instead. `fixtures/syntheticVenue.ts` exports values of this type.
 */
export type CalendarWithCapabilities = OperationalCalendar & {
  capabilities: CapabilityMatrix;
};

/** Whether `employeeId` is capable of performing `serviceId`, per the declared matrix. */
export function canPerform(
  cal: CalendarWithCapabilities,
  employeeId: EmployeeId,
  serviceId: ServiceId,
): boolean {
  return cal.capabilities.get(employeeId)?.has(serviceId) ?? false;
}
