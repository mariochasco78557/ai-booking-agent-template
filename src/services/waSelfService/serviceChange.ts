import { createHash } from "node:crypto";
import { UpstreamError } from "../../core/calendar/errors.js";
import type {
  CalendarBackOffice,
  CalendarBookingRequest,
  CalendarResource,
} from "../../core/calendar/CalendarProvider.js";
import { madridWallClock } from "../../utils/madridDate.js";
import type { Logger } from "../authTokenService.js";
import type { SlotHoldRegistry } from "../slotHolds.js";
import { splitByState, type DashboardReservation } from "./dashboardMapping.js";

/**
 * *** 2026-10-11 — «CAMBIAR SERVICIO» ATÓMICO ((internal doc, not included in the template) §2.2). ***
 *
 * Bruno's API has no update for a reservation and a unique constraint
 * `(employee_id, reservation_date)`: the service of an existing appointment
 * can only change by DELETING it and CREATING it again, same slot, same
 * barber, same owner data. This module does both in ONE method the model can
 * never chain by hand, and never reports «done» without reading the agenda
 * back:
 *
 *   re-read the day -> checks -> hold the slot -> DELETE -> POST (new type)
 *   -> VERIFY -> (not there) RESTORE the old type -> VERIFY -> notices.
 *
 * The caller (`WaSelfService`) has ALREADY passed the gates (modes, allow
 * list, rate limits, server-side confirmation) and holds `withLock(rid)`.
 *
 * ownerPhone: written exactly as `BookingService` writes it when it creates a
 * booking from a verified caller — the E.164 `+34XXXXXXXXX` (see
 * `resolveOwnerPhone`: `identity.phoneE164` / `waCaller.e164`). The dashboard
 * hands the phone back normalised to that same format.
 *
 * Logs: `rid_hash`, `outcome`, `step`, `duration_ms`. Never a name or phone.
 */

export type ServiceChangeOutcome =
  | "confirm_required"
  | "service_changed"
  | "same_service"
  | "service_not_changed"
  | "service_change_too_late"
  | "service_change_unavailable"
  | "service_change_lost"
  | "uncertain"
  | "not_found"
  | "reservation_changed";

export type ServiceChangeStep = "delete" | "create" | "verify" | "restore";
export type ServiceChangeVia = "whatsapp" | "voice" | "voice_dictated";

/**
 * What Bruno is told. `urgent` ones leave AT ONCE (no opening-hours gate): a
 * customer may have lost the appointment. Contains personal data ON PURPOSE
 * (for the owner's Telegram); implementations must never log it.
 */
export interface ServiceChangeNotice {
  kind: "service_changed" | "service_not_changed" | "service_change_lost" | "uncertain";
  startsAt: string;
  professional: string | null;
  fromType: number;
  toType: number;
  ownerName: string;
  ownerSurnames: string;
  phoneE164: string;
  via: ServiceChangeVia;
  /** Step where it stopped (not changed / lost / uncertain). */
  step?: ServiceChangeStep;
}

/** Never throws, never waits for the network. */
export interface ServiceChangeAlertPort {
  info(notice: ServiceChangeNotice, nowMs: number): void;
  urgent(notice: ServiceChangeNotice, nowMs: number): void;
}

export interface ServiceChangeDeps {
  /** Staff-identity back office (CalendarProvider port). */
  employeeClient: CalendarBackOffice;
  /** Booking-account calendar (reservations session, one retry on 401). */
  createReservation: (body: CalendarBookingRequest) => Promise<void>;
  employeesDay: (date: string) => Promise<CalendarResource[]>;
  slotHolds: SlotHoldRegistry;
  alerts?: ServiceChangeAlertPort;
  /** Told the phone before the delete and after the end (booking limit). */
  onBookingsChanged?: (phoneE164: string) => void;
  /** `SERVICE_CHANGE_MIN_LEAD_MINUTES` (60). */
  minLeadMinutes: number;
  logger: Logger;
  /** Total time budget of the operation (default 60 s). Spent after the DELETE: no new POST, restore. */
  budgetMs?: number;
  /** Wait before the second re-read after a DELETE timeout (default 3 s). */
  recheckDelayMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

export interface ServiceChangeRequest {
  row: DashboardReservation;
  newType: 0 | 1 | 2;
  via: ServiceChangeVia;
  conversationId: string;
}

/** Longer than the budget plus a few slow upstream calls: the hold must outlive the whole chain. */
const HOLD_TTL_MS = 120_000;
const DEFAULT_BUDGET_MS = 60_000;
const DEFAULT_RECHECK_DELAY_MS = 3_000;

function ridHash(rid: number): string {
  return createHash("sha256").update(String(rid)).digest("hex").slice(0, 8);
}

type DayRead = { ok: true; live: DashboardReservation[]; notCancelled: DashboardReservation[] } | { ok: false };

async function readDay(deps: ServiceChangeDeps, date: string): Promise<DayRead> {
  try {
    const result = await deps.employeeClient.listBookings({ fromDate: date, toDate: date });
    const split = splitByState(result.rows);
    return { ok: true, live: split.live, notCancelled: split.notCancelled };
  } catch {
    return { ok: false };
  }
}

export async function swapService(
  deps: ServiceChangeDeps,
  req: ServiceChangeRequest,
  nowMs: number,
): Promise<{ outcome: ServiceChangeOutcome; step?: ServiceChangeStep }> {
  const startedAt = Date.now();
  const { row, newType } = req;
  let outcome: ServiceChangeOutcome = "uncertain";
  let step: ServiceChangeStep | undefined;
  try {
    const result = await swapInner(deps, req, nowMs);
    outcome = result.outcome;
    step = result.step;
    return result;
  } catch {
    // Unknown failure after unknown writes: never "done", and the customer
    // is told Bruno knows, so Bruno is told (URGENT).
    outcome = "uncertain";
    try {
      deps.alerts?.urgent(
        {
          kind: "uncertain",
          startsAt: row.startsAt,
          professional: row.employeeName,
          fromType: row.typeReservation ?? newType,
          toType: newType,
          ownerName: row.ownerName,
          ownerSurnames: row.ownerSurnames,
          phoneE164: row.ownerPhoneE164 ?? "",
          via: req.via,
        },
        nowMs,
      );
    } catch {
      deps.logger.warn({}, "service change: urgent notice threw (ignored)");
    }
    return { outcome };
  } finally {
    deps.logger.info(
      {
        rid_hash: ridHash(row.id),
        outcome,
        ...(step !== undefined ? { step } : {}),
        new_type: newType,
        via: req.via,
        duration_ms: Date.now() - startedAt,
      },
      "service change: finished",
    );
  }
}

async function swapInner(
  deps: ServiceChangeDeps,
  req: ServiceChangeRequest,
  nowMs: number,
): Promise<{ outcome: ServiceChangeOutcome; step?: ServiceChangeStep }> {
  const { row, newType, via } = req;
  const startsAt = row.startsAt;
  const day = startsAt.slice(0, 10);

  // 2. Re-read the day: the row must still stand, be this phone's and the same start.
  const first = await readDay(deps, day);
  if (!first.ok) return { outcome: "service_change_unavailable" };
  const current = first.live.find((r) => r.id === row.id);
  if (!current || current.ownerPhoneE164 !== row.ownerPhoneE164) return { outcome: "not_found" };
  if (current.startsAt !== startsAt) return { outcome: "reservation_changed" };
  if (current.employeeId === null || current.typeReservation === null || current.ownerPhoneE164 === null) {
    return { outcome: "service_change_unavailable" };
  }
  const oldType = current.typeReservation;
  const employeeId = current.employeeId;
  const phone = current.ownerPhoneE164;
  if (oldType === newType) return { outcome: "same_service" };

  // 3. Lead time: at least `minLeadMinutes` before the start.
  if (startsAt < madridWallClock(nowMs + deps.minLeadMinutes * 60_000)) {
    return { outcome: "service_change_too_late" };
  }

  // 4. The exact professional for the POST body, before deleting anything.
  let employee: CalendarResource | undefined;
  try {
    employee = (await deps.employeesDay(day)).find((e) => e.id === employeeId);
  } catch {
    employee = undefined;
  }
  if (employee === undefined) return { outcome: "service_change_unavailable" };
  const staff: CalendarResource = { id: employee.id, name: employee.name, surnames: employee.surnames };

  const notice = (kind: ServiceChangeNotice["kind"], at?: ServiceChangeStep): ServiceChangeNotice => ({
    kind,
    startsAt,
    professional: current.employeeName,
    fromType: oldType,
    toType: newType,
    ownerName: current.ownerName,
    ownerSurnames: current.ownerSurnames,
    phoneE164: phone,
    via,
    ...(at !== undefined ? { step: at } : {}),
  });
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      deps.logger.warn({}, "service change: notice threw (ignored)");
    }
  };
  const bodyOf = (type: number): CalendarBookingRequest => ({
    reservationDate: `${startsAt}:00`,
    typeReservation: String(type),
    employee: staff,
    // Copied literally from the row, «IA -» prefix included. No `owner`: guest mode.
    ownerName: current.ownerName,
    ownerSurnames: current.ownerSurnames,
    ownerPhone: phone,
  });
  const standing = (rows: DashboardReservation[]): DashboardReservation | undefined =>
    rows.find(
      (r) => r.employeeId === employeeId && r.startsAt === startsAt && r.ownerPhoneE164 === phone,
    );
  const lost = (at: ServiceChangeStep) => {
    safe(() => deps.alerts?.urgent(notice("service_change_lost", at), nowMs));
    return { outcome: "service_change_lost" as const, step: at };
  };
  const uncertain = (at: ServiceChangeStep) => {
    safe(() => deps.alerts?.urgent(notice("uncertain", at), nowMs));
    return { outcome: "uncertain" as const, step: at };
  };

  // 5. Hold the slot for the whole operation.
  const release = deps.slotHolds.hold(employeeId, startsAt, HOLD_TTL_MS);
  const clock = deps.now ?? Date.now;
  const deadline = clock() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  try {
    safe(() => deps.onBookingsChanged?.(phone));

    // 6. DELETE the old one.
    try {
      const deleted = await deps.employeeClient.cancelBookingById(row.id);
      if (deleted === "not_found") return { outcome: "not_found" };
    } catch (err) {
      // An unexpected error: the fate of the delete is unknown, never «done».
      if (!(err instanceof UpstreamError)) return uncertain("delete");
      const check = await readDay(deps, day);
      if (!check.ok) return uncertain("delete");
      // Unknown-state rows count as still there (fail-closed).
      let stillThere = check.notCancelled.some((r) => r.id === row.id);
      if (stillThere && err.status === undefined) {
        // A TIMEOUT: the delete may still be running upstream. One read is not
        // enough to say «sigue como estaba»: wait and read again.
        await new Promise<void>((resolve) => setTimeout(resolve, deps.recheckDelayMs ?? DEFAULT_RECHECK_DELAY_MS));
        const second = await readDay(deps, day);
        if (!second.ok) return uncertain("delete");
        stillThere = second.notCancelled.some((r) => r.id === row.id);
        // Present in both reads after a timeout is still not clear: URGENT.
        if (stillThere) return uncertain("delete");
      } else if (stillThere) {
        return { outcome: "service_not_changed", step: "delete" };
      }
      // The row is gone: the delete did go through.
    }

    // 7. POST the new one. Any failure is settled by the verification.
    // Budget spent after the DELETE: no new POST, go straight to the restore.
    if (clock() < deadline) {
      try {
        await deps.createReservation(bodyOf(newType));
      } catch {
        // A timeout or a 5xx may still have written the row: look.
      }
    } else {
      deps.logger.warn({ rid_hash: ridHash(row.id) }, "service change: time budget spent after the delete, restoring");
    }

    // 8. Verify, always.
    const after = await readDay(deps, day);
    if (!after.ok) return uncertain("verify");
    const found = standing(after.live);
    if (found !== undefined) {
      if (found.typeReservation === newType) {
        safe(() => deps.alerts?.info(notice("service_changed"), nowMs));
        return { outcome: "service_changed" };
      }
      if (found.typeReservation === oldType) {
        // Nothing was changed (the delete did not stick, or another path restored it).
        safe(() => deps.alerts?.info(notice("service_not_changed", "verify"), nowMs));
        return { outcome: "service_not_changed", step: "verify" };
      }
    }

    // 9. Roll back: the OLD type, same data; then verify again.
    try {
      await deps.createReservation(bodyOf(oldType));
    } catch {
      // Settled by the verification below.
    }
    const restored = await readDay(deps, day);
    if (!restored.ok) return uncertain("restore");
    const back = standing(restored.live);
    if (back !== undefined && back.typeReservation === newType) {
      safe(() => deps.alerts?.info(notice("service_changed"), nowMs));
      return { outcome: "service_changed" };
    }
    if (back !== undefined) {
      safe(() => deps.alerts?.info(notice("service_not_changed", "restore"), nowMs));
      return { outcome: "service_not_changed", step: "restore" };
    }
    return lost("restore");
  } finally {
    release();
    safe(() => deps.onBookingsChanged?.(phone));
  }
}
