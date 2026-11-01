import type { SyntheticReservation } from "../calendar/model.js";
import type { CalendarWithCapabilities } from "../capabilities.js";
import { daysBetween, formatHHmm } from "../domain/time.js";
import type { Clock } from "../domain/types.js";
import {
  noShowIdFor,
  type NoShowRecord,
  type OperationsAuditDraft,
  type OperationsWrite,
  type NoShowState,
} from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — PURE NO-SHOW COMMAND HANDLERS (design §2.3, §2.4, §2.7).
 *
 * Same discipline as `waitlist/commands.ts`: every handler is a PURE
 * function that reads a context and returns the COMPLETE description of what
 * should be written, without writing anything and without awaiting anything.
 * The caller (src/console/server.ts) applies the whole description in ONE
 * synchronous tick, so there is no window in which half a change can exist.
 *
 * THE THREE RULES THAT ARE NOT NEGOTIABLE (design §2.1):
 *   1. ONLY AN OPERATOR RECORDS. There is no timer, no sweep, no automatic
 *      transition anywhere in this file. Moving the clock changes ELIGIBILITY
 *      and nothing else: it never records anything for anybody.
 *   2. ONLY AFTER THE END OF THE APPOINTMENT, with NO grace period. The
 *      threshold is exactly the end of the appointment and it is NOT a
 *      configurable parameter: there is no `noShowGraceMinutes` anywhere in
 *      the repository (question K2).
 *   3. CORRECTING WRITES, NEVER ERASES. The record survives with its
 *      `recordedAtISO` intact and gains `correctedAtISO`; the log keeps both
 *      events. A `409` writes NOTHING AT ALL — not an event, not a task, not
 *      a record (design §2.6, criterion 8.13).
 *
 * NO NEW DATE ARITHMETIC: `minutesAfterEnd` uses `daysBetween` from
 * `domain/time.ts`, the same helper `evaluateTimeliness` uses.
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Context and result shapes
// ---------------------------------------------------------------------

export interface OperationsCommandContext {
  /** The working calendar: where the appointment being talked about lives. */
  cal: CalendarWithCapabilities;
  clock: Clock;
  noShows: readonly NoShowRecord[];
}

/**
 * The complete, atomic description of a write to the operations store.
 *
 * step 18 §4.7: it MOVED to `model.ts` and gained the neutral half
 * (`EngineSideEffects`) plus the groups, because multi-person booking writes N
 * reservations through the very same contract. Re-exported from here so every
 * import that already spelled it this way keeps working — the same type, not
 * a copy.
 */
export type { OperationsWrite };

export interface OperationsCommandOutcome {
  status: number;
  body: Record<string, unknown>;
  /** `null` means literally nothing is written — the honest shape of a rejected command. */
  write: OperationsWrite | null;
  /**
   * When present, the caller replaces `body.record` with the SERVER-SIDE
   * PROJECTION of the no-show record of this reservation. Raw domain objects
   * never leave the process.
   */
  viewNoShowReservationId?: string;
}

// ---------------------------------------------------------------------
// Eligibility (design §2.4)
// ---------------------------------------------------------------------

/** The two reasons an appointment cannot be marked as a no-show right now. */
export type NoShowIneligibleReasonCode = "reservation_is_cancelled" | "reservation_not_finished_yet";

/**
 * Minutes elapsed since the END of the appointment, on the synthetic clock.
 * Negative while the appointment has not finished yet.
 */
export function minutesAfterEnd(
  clock: Clock,
  reservation: { date: string; endMinutes: number },
): number {
  return clock.nowMinutes() - reservation.endMinutes - daysBetween(clock.nowISODate(), reservation.date) * 1440;
}

/**
 * THE eligibility rule, resolved SERVER-SIDE and never re-derived in the
 * browser (design §2.4). The boundary is INCLUSIVE ON THE END: at exactly
 * 10:00 the 09:30–10:00 appointment HAS finished and is eligible — the
 * natural Spanish reading of "cuando ya ha pasado la hora". Zero is zero, not
 * a parameter.
 */
export function isEligibleForNoShow(
  clock: Clock,
  reservation: { date: string; endMinutes: number; status: "confirmed" | "cancelled" },
): boolean {
  return reservation.status === "confirmed" && minutesAfterEnd(clock, reservation) >= 0;
}

/** Why not, as a closed code. `null` when the appointment IS eligible. */
export function noShowIneligibleReasonCode(
  clock: Clock,
  reservation: { date: string; endMinutes: number; status: "confirmed" | "cancelled" },
): NoShowIneligibleReasonCode | null {
  if (reservation.status === "cancelled") return "reservation_is_cancelled";
  if (minutesAfterEnd(clock, reservation) < 0) return "reservation_not_finished_yet";
  return null;
}

/**
 * How many corrections this reservation already carries: `0` while nobody has
 * corrected and `1` afterwards. It is the discriminant of the idempotency key
 * the interface mints (design §2.7) — and it can only ever be 0 or 1 because
 * correcting is terminal (§2.3, K3).
 */
export function noShowRevisionOf(noShows: readonly NoShowRecord[], reservationId: string): number {
  const record = findNoShow(noShows, reservationId);
  return record !== undefined && record.state === "corrected_not_a_no_show" ? 1 : 0;
}

export function findNoShow(
  noShows: readonly NoShowRecord[],
  reservationId: string,
): NoShowRecord | undefined {
  return noShows.find((r) => r.reservationId === reservationId);
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function reservationNotFound(): OperationsCommandOutcome {
  return {
    status: 404,
    body: { error: "No existe ninguna cita con ese identificador.", code: "reservation_not_found" },
    write: null,
  };
}

function repeatedCommandEvent(
  clock: Clock,
  record: NoShowRecord,
  command: "record_no_show" | "correct_no_show",
): OperationsAuditDraft {
  return {
    kind: "NO_SHOW_COMMAND_REPEATED",
    actor: "operator",
    atISO: clock.nowInstantISO(),
    reservationId: record.reservationId,
    noShowId: record.id,
    detail: { command },
    synthetic: true,
  };
}

/**
 * The event a REPEATED REQUEST over one of the two no-show routes writes
 * (design §4.8's implementation note): the transport layer memoised the first
 * response and executed nothing, which is precisely "an action that was
 * repeated and did nothing". It lands in the OPERATIONS register, never in
 * the waitlist's — that is why `decideIdempotency` takes its repeat-writer as
 * a parameter.
 */
export function operationsReplayEvent(
  clock: Clock,
  route: string,
  key: string,
  reservationId: string,
): OperationsAuditDraft {
  return {
    kind: "NO_SHOW_COMMAND_REPEATED",
    actor: "system",
    atISO: clock.nowInstantISO(),
    reservationId,
    noShowId: noShowIdFor(reservationId),
    detail: { command: "repeated_request", route, key },
    synthetic: true,
  };
}

// ---------------------------------------------------------------------
// recordNoShow (design §2.3, §2.7, §2.9)
// ---------------------------------------------------------------------

/**
 * Records that a synthetic appointment finished and nobody came. The order of
 * the checks is deliberate:
 *
 *   1. THE STRUCTURAL STATE FIRST. A repeat of a command that is already done
 *      is an idempotent `200`, never a conflict — even if the appointment was
 *      cancelled afterwards, because a recorded no-show and a cancellation
 *      coexist (design §2.3, K6) and repeating must stay safe.
 *   2. A record already CORRECTED is a `409` and writes nothing: correcting
 *      is terminal (K3).
 *   3. Only then the appointment itself: `cancelled` is a `409` (K17 —
 *      cancelling is warning, not showing up is not warning: two different
 *      facts that are never merged), and "not finished yet" is a `409` too.
 */
export function recordNoShow(ctx: OperationsCommandContext, reservationId: string): OperationsCommandOutcome {
  const { cal, clock } = ctx;
  const reservation: SyntheticReservation | undefined = cal.reservations.find((r) => r.id === reservationId);
  if (reservation === undefined) return reservationNotFound();

  const existing = findNoShow(ctx.noShows, reservationId);
  if (existing !== undefined) {
    if (existing.state === "corrected_not_a_no_show") {
      // NOTHING is written: no event, no record, no metric (criterion 8.13).
      return {
        status: 409,
        body: { conflict: "no_show_already_corrected", reservationId },
        write: null,
      };
    }
    // Structural idempotency (design §2.7): the record does NOT change and no
    // figure rises. Exactly one event says the command was repeated.
    return {
      status: 200,
      body: { recorded: true, alreadyRecorded: true },
      write: { events: [repeatedCommandEvent(clock, existing, "record_no_show")] },
      viewNoShowReservationId: reservationId,
    };
  }

  if (reservation.status === "cancelled") {
    return { status: 409, body: { conflict: "reservation_is_cancelled", reservationId }, write: null };
  }

  const elapsed = minutesAfterEnd(clock, reservation);
  if (elapsed < 0) {
    return {
      status: 409,
      body: {
        conflict: "reservation_not_finished_yet",
        reservationId,
        minutesUntilEnd: -elapsed,
        endsAtLabel: formatHHmm(reservation.endMinutes),
      },
      write: null,
    };
  }

  const atISO = clock.nowInstantISO();
  const record: NoShowRecord = {
    id: noShowIdFor(reservation.id),
    reservationId: reservation.id,
    employeeId: reservation.employeeId,
    serviceId: reservation.serviceId,
    date: reservation.date,
    startMinutes: reservation.startMinutes,
    endMinutes: reservation.endMinutes,
    minutesAfterEndAtRecording: elapsed,
    recordedBy: "console-operator",
    recordedAtISO: atISO,
    state: "recorded",
    synthetic: true,
  };

  return {
    status: 201,
    body: { recorded: true },
    write: {
      noShows: [...ctx.noShows, record],
      events: [
        {
          kind: "NO_SHOW_RECORDED",
          actor: "operator",
          atISO,
          reservationId: reservation.id,
          noShowId: record.id,
          toState: "recorded" as NoShowState,
          // `statusAtRecording` is what makes invariant 4 of §2.8 CHECKABLE
          // over the log instead of merely promised by this function: a
          // record whose event does not declare `confirmed` would light the
          // integrity banner.
          detail: { minutesAfterEnd: elapsed, statusAtRecording: reservation.status },
          synthetic: true,
        },
      ],
    },
    viewNoShowReservationId: reservationId,
  };
}

// ---------------------------------------------------------------------
// correctNoShow (design §2.3, §2.9)
// ---------------------------------------------------------------------

/**
 * Corrects a record: it was not a no-show after all. The record is NOT
 * deleted — there is no `DELETE` route anywhere for exactly this reason
 * (design §2.9) — and `recordedAtISO` stays untouched, so the history keeps
 * saying that it was recorded AND that it was corrected.
 */
export function correctNoShow(ctx: OperationsCommandContext, reservationId: string): OperationsCommandOutcome {
  const { clock } = ctx;
  const existing = findNoShow(ctx.noShows, reservationId);
  if (existing === undefined) {
    return {
      status: 404,
      body: {
        error: "No hay ninguna inasistencia anotada en esa cita.",
        code: "no_show_not_found",
        reservationId,
      },
      write: null,
    };
  }

  if (existing.state === "corrected_not_a_no_show") {
    return {
      status: 200,
      body: { corrected: true, alreadyCorrected: true },
      write: { events: [repeatedCommandEvent(clock, existing, "correct_no_show")] },
      viewNoShowReservationId: reservationId,
    };
  }

  const atISO = clock.nowInstantISO();
  const corrected: NoShowRecord = {
    ...existing,
    state: "corrected_not_a_no_show",
    correctedAtISO: atISO,
    correctedBy: "console-operator",
  };

  return {
    status: 200,
    body: { corrected: true },
    write: {
      noShows: ctx.noShows.map((r) => (r.reservationId === reservationId ? corrected : r)),
      events: [
        {
          kind: "NO_SHOW_CORRECTED",
          actor: "operator",
          atISO,
          reservationId,
          noShowId: existing.id,
          fromState: "recorded" as NoShowState,
          toState: "corrected_not_a_no_show" as NoShowState,
          synthetic: true,
        },
      ],
    },
    viewNoShowReservationId: reservationId,
  };
}
