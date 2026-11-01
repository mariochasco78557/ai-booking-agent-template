import type { EmployeeId, ServiceId, SyntheticProfessional } from "../domain/types.js";

/**
 * Canonical operational-calendar model for the call-engine synthetic demo.
 * Every instance in this module/tests is synthetic (`synthetic_fixture`) or
 * a manually authored test fixture — nothing here is ever read from or
 * written to a real Demo Salon system.
 */

export type CalendarSource =
  | "synthetic_fixture"
  | "manual_override"
  | "imported_provider";

export type ApprovalStatus = "pending_review" | "approved" | "rejected";

export interface AuditStamp {
  createdAt: string;
  createdBy: string;
  approvedAt?: string;
  approvedBy?: string;
  note?: string;
}

export interface WeeklySchedule {
  ownerKind: "venue" | "employee";
  employeeId?: EmployeeId;
  dayOfWeek: number; // 0=domingo .. 6=sábado
  workDayStart: string; // 'HH:mm'
  workDayEnd: string;
  breakStart?: string;
  breakEnd?: string;
}

export interface VenueClosure {
  id: string;
  kind: "full_closure";
  startDate: string;
  endDate: string;
  source: CalendarSource;
  approval: ApprovalStatus;
  audit: AuditStamp;
}

export interface VenueCalendarRule {
  id: string;
  kind: "holiday" | "special_opening";
  scope: "national" | "regional" | "municipal" | "venue";
  date: string;
  closed: boolean;
  specialOpen?: string;
  specialClose?: string;
  source: CalendarSource;
  approval: ApprovalStatus;
  externalRef?: string;
  audit: AuditStamp;
}

/**
 * How a `SeasonalVenueSchedule` behaves once its `endDate` has passed.
 *
 * A ONE-MEMBER union ON PURPOSE. A seasonal schedule is a DATED exception
 * (step 14 decision D3): it stops applying the day after `endDate` and
 * NOTHING re-applies it next year. Modelling the "no repetition" fact as a
 * literal — rather than as the absence of a field — means the console can
 * state it on screen from the data, and means that adding a genuinely
 * recurring variant later is a deliberate, reviewable amendment to this
 * union (and to `resolveAvailability.ts`, which today only understands this
 * single member), never an accident.
 */
export type SeasonalRecurrence = "does_not_repeat";

/**
 * A DATED venue-wide schedule that replaces the venue's ordinary weekly
 * hours for an explicit `startDate`..`endDate` window (e.g. August hours).
 *
 * WHY THIS EXISTS AS ITS OWN RECORD, AND NOT AS A `WeeklySchedule`:
 * `WeeklySchedule` has no dates — it is eternal by construction. A summer
 * timetable stored there would still be silently in force in 2027 with
 * nobody having looked at it again. That is the "eternal unreviewed
 * assumption" this record is designed to make impossible.
 *
 * PRECEDENCE (level 5 of seven, see `resolveAvailability.ts`): a seasonal
 * schedule is beaten by a venue closure (1) and by an approved
 * holiday/special opening (2), and it replaces the venue's ordinary weekly
 * hours (6). Like every venue-owned schedule in this model it then acts as
 * an OUTER BOUND on the people inside the venue: nobody can be booked while
 * the shop is shut. Fail-closed, exactly like `VenueCalendarRule`: any row
 * whose `approval !== "approved"` is ignored in full.
 *
 * SHAPE: one row per `dayOfWeek`, all rows of the same season sharing a
 * `periodId`. A day-of-week with NO row inside an active period is CLOSED —
 * that is how "en agosto el lunes cierra" is expressed, and it is why the
 * period is fail-closed rather than falling back to the ordinary week.
 *
 * DUPLICATING FOR THE NEXT YEAR: copy the rows, give them a new `periodId`,
 * shift the dates, set `duplicatedFromPeriodId` to the old period and
 * `approval: "pending_review"`. Until a human approves it, the copy is
 * inert and changes nothing.
 */
export interface SeasonalVenueSchedule {
  id: string;
  /** Groups every row of one season. Rows sharing a `periodId` must share `startDate`/`endDate`. */
  periodId: string;
  /** Operator-facing name of the season, e.g. "Horario de agosto de 2026". Never caller-facing. */
  label: string;
  /** Inclusive first date the season applies. */
  startDate: string;
  /** Inclusive last date the season applies. After this date the record does nothing, for ever. */
  endDate: string;
  dayOfWeek: number; // 0=domingo .. 6=sábado
  workDayStart: string; // 'HH:mm'
  workDayEnd: string;
  breakStart?: string;
  breakEnd?: string;
  /** Always `"does_not_repeat"` today — see `SeasonalRecurrence`. */
  recurrence: SeasonalRecurrence;
  /** Set when this season was created by duplicating a previous one, so the console can say where it came from. */
  duplicatedFromPeriodId?: string;
  source: CalendarSource;
  approval: ApprovalStatus;
  audit: AuditStamp;
}

export interface EmployeeAbsence {
  id: string;
  employeeId: EmployeeId;
  kind: "vacation" | "absence" | "training";
  startDate: string;
  endDate: string;
  allDay: boolean;
  startMinutes?: number;
  endMinutes?: number;
  /**
   * ────────────────────────────────────────────────────────────────────
   * PRIVATE — `privateReason` MUST NEVER LEAVE THIS SERVER TOWARDS A
   * CALLER/CLIENT. It exists purely for internal record-keeping/audit.
   * The call engine may only ever tell a caller that the professional is
   * "not available" for the requested slot — never why. In particular,
   * `resolveAvailability.ts`'s `notes` (internal diagnostics) must never
   * contain this value; that invariant is asserted directly in
   * tests/callEngine/calendar.test.ts.
   * ────────────────────────────────────────────────────────────────────
   */
  privateReason?: string;
  source: CalendarSource;
  approval: ApprovalStatus;
  audit: AuditStamp;
}

export interface EmployeeScheduleOverride {
  id: string;
  employeeId: EmployeeId;
  date: string;
  workDayStart: string;
  workDayEnd: string;
  breakStart?: string;
  breakEnd?: string;
  source: CalendarSource;
  approval: ApprovalStatus;
  audit: AuditStamp;
}

export interface SyntheticReservation {
  id: string;
  employeeId: EmployeeId;
  serviceId: ServiceId;
  date: string;
  startMinutes: number;
  endMinutes: number;
  status: "confirmed" | "cancelled";
  callIdHash?: string;
  synthetic: true;
}

export interface OperationalCalendar {
  professionals: readonly SyntheticProfessional[];
  weeklySchedules: readonly WeeklySchedule[];
  closures: readonly VenueClosure[];
  venueRules: readonly VenueCalendarRule[];
  absences: readonly EmployeeAbsence[];
  overrides: readonly EmployeeScheduleOverride[];
  /**
   * OPTIONAL on purpose. Absent (or empty) means "this venue declares no
   * seasonal exception", which is the shape of every calendar that existed
   * before step 14 and the shape `resolveAvailability.ts` must keep
   * resolving byte-identically — asserted in
   * tests/callEngine/seasonalSchedule.test.ts.
   */
  seasonalSchedules?: readonly SeasonalVenueSchedule[];
  reservations: readonly SyntheticReservation[];
  slotMinutes: number;
  bookingHorizonDays: number;
  minimumLeadMinutes: number;
}

/**
 * DECLARATION ONLY — the shape of a *future* holiday-import provider. This
 * interface is NOT implemented against any network anywhere in this repo,
 * and nothing under src/callEngine (this module tree) imports axios,
 * node:http(s)/net, or any src/clients or src/services module. It exists
 * purely as a documented contract for a future integration.
 *
 * Everything a `HolidayProvider` would return carries `source:
 * 'imported_provider'` and is born `pending_review` and INERT:
 * `resolveAvailability.ts`'s `resolveDayWindows` ignores any
 * `VenueCalendarRule` that is `pending_review` or `rejected` — fail-closed,
 * it never opens (or closes) the venue on its own. Only a human action,
 * recorded in an `AuditStamp` (moving `approval` to `'approved'`), can ever
 * activate an imported rule. Even once approved, `manual_override` always
 * wins over `imported_provider` for the same date — see the tie-break rule
 * documented on `resolveDayWindows`.
 */
export interface HolidayProvider {
  readonly id: string;
  fetchHolidays(input: {
    from: string;
    to: string;
    scopes: ReadonlyArray<"national" | "regional" | "municipal">;
  }): Promise<
    ReadonlyArray<
      Omit<VenueCalendarRule, "approval" | "audit"> & { source: "imported_provider" }
    >
  >;
}
