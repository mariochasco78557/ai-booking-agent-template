import type { SyntheticReservation } from "../calendar/model.js";
import type { CalendarWithCapabilities } from "../capabilities.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — THE NEUTRAL SIDE-EFFECT CONTRACT (design §4.7).
 *
 * The half of a command's result that does NOT belong to any one feature:
 * the calendar after the change, the synthetic reservations to mirror in the
 * `MemoryStore`, and the human queue. `waitlist/` and `operations/` both
 * produce it, and `src/console/server.ts` applies it with ONE shared,
 * SYNCHRONOUS function (`applyEngineSideEffects`), which is what makes the
 * anti-half-write rule of step 17 §14.5 hold for N reservations instead of
 * one.
 *
 * WHY `shared/` AND NOT `domain/` (design §4.7, repair of advertencia 7).
 * These fields need `CalendarWithCapabilities` and `SyntheticReservation`,
 * which live in `capabilities.ts` and `calendar/model.ts`. Putting this file
 * under `domain/` would make `domain/` — today the LEAF of the dependency
 * graph — depend on `calendar/`, inverting the direction of the graph in the
 * engine's base folder. `domain/slotTime.ts` does stay in `domain/`, because
 * it only needs `Clock` and a number.
 *
 * WHY THE PLURALS (design §4.7, option C). `WaitlistWrite` used to carry ONE
 * `reservationToAdd` and ONE `reservationToCancel`. A group of three needs
 * three reservations written in the SAME TICK. The singular fields were
 * REPLACED, not doubled: keeping both spellings would have been two ways of
 * saying the same thing, with the failure guaranteed the day somebody filled
 * the wrong one. `[x]` means exactly what `x` meant, so no inherited
 * behaviour changes.
 *
 * This module is TYPES ONLY: no logic, no state, no clock read, nothing to
 * execute.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * A human task to enqueue. Ids are DETERMINISTIC so a repeated command cannot
 * duplicate a task (step 17 design §7.3). This is the former
 * `WaitlistTaskRequest`, moved here and renamed because the operations side
 * hands the console exactly the same shape (design §4.7).
 */
export interface ConsoleTaskRequest {
  id: string;
  reason: string;
  createdAtISO: string;
}

/** What the SERVER must apply outside the feature's own store. */
export interface EngineSideEffects {
  /** The calendar AFTER the change, when the command touches it. */
  nextCal?: CalendarWithCapabilities;
  /** Synthetic reservations to record in the `MemoryStore` too (step 17 §14.4). */
  reservationsToAdd?: readonly SyntheticReservation[];
  /** Reservation ids to mark cancelled in the `MemoryStore` too (step 17 §14.4). */
  reservationsToCancel?: readonly string[];
  tasksToAdd?: readonly ConsoleTaskRequest[];
  tasksToComplete?: readonly string[];
}

/**
 * What a pure command handler answers with: the HTTP shape, plus the complete
 * description of the write, plus the two hints the console needs to finish the
 * body off. Generic in the write so each feature keeps its own store contract
 * (`WaitlistWrite`, `OperationsWrite`) without either of them re-declaring
 * this envelope.
 */
export interface CommandOutcome<W> {
  status: number;
  /** `null` means literally nothing is written — the honest shape of a rejected command. */
  write: W | null;
  body: Record<string, unknown>;
  /**
   * When present, the caller replaces `body.entry` with the SERVER-SIDE
   * PROJECTION of this entry. Raw domain objects never leave the process: the
   * projection is the privacy and "no business logic in the browser" boundary.
   */
  viewEntryId?: string;
  /**
   * When present, the caller adds `body[<this name>] = <id of the first audit
   * event this command wrote>`. Audit ids are minted by the store (a pure
   * handler cannot mint a monotonic sequence), so they can only be attached
   * after the commit.
   */
  singleAuditEventIdField?: string;
}
