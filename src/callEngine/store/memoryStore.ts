import type { CalendarWithCapabilities } from "../capabilities.js";
import type { SyntheticReservation } from "../calendar/model.js";

/**
 * Purely in-memory synthetic state for one process's lifetime: no file, no
 * database, no network call anywhere in this module. `reset()` exists
 * mainly for tests so each one starts from a clean store; a real deployment
 * of this shape doesn't exist and is explicitly out of scope (see
 * ports/index.ts's `AgendaPort`, which is what a real backend would sit
 * behind).
 */

export interface CallRecord {
  callIdHash: string;
  scenarioId: string;
  startedAtISO: string;
}

export interface HumanTask {
  id: string;
  callIdHash: string;
  /** Kept as a plain string (not `ReasonCode`) so this module never has to import precedence.ts just to label a task. */
  reason: string;
  createdAtISO: string;
  /**
   * When a human actually dealt with it (step 17, design §7.3). Absent
   * means still open.
   *
   * ADDITIVE AND WITHOUT ANY EFFECT ON TODAY'S BEHAVIOUR: no existing caller
   * sets it and no existing caller calls `completeHumanTask`, so every task
   * the engine and the calendar flow create today stays exactly as open as
   * it was before this field existed. It exists because a "decide who gets
   * this released slot" task that stayed open AFTER the slot was converted
   * would be a lie, and this console does not tell those.
   */
  completedAtISO?: string;
}

export interface InternalNotice {
  id: string;
  callIdHash: string;
  channel: "whatsapp" | "internal";
  createdAtISO: string;
}

export interface EngineError {
  id: string;
  callIdHash: string;
  message: string;
  atISO: string;
}

export interface MemoryStoreSnapshot {
  calls: readonly CallRecord[];
  reservations: readonly SyntheticReservation[];
  humanTasks: readonly HumanTask[];
  internalNotices: readonly InternalNotice[];
  errors: readonly EngineError[];
}

export interface MemoryStore {
  recordCallStarted(record: CallRecord): void;
  /**
   * Records a synthetic reservation AND returns an updated calendar whose
   * `reservations` includes it, so that any subsequent `isSlotFree`/
   * `freeSlotStarts` call against the returned calendar correctly sees it
   * as occupied. `OperationalCalendar`/`CalendarWithCapabilities` values are
   * treated as immutable throughout src/callEngine — this never mutates
   * `cal` in place.
   */
  addReservation(cal: CalendarWithCapabilities, reservation: SyntheticReservation): CalendarWithCapabilities;
  /**
   * Marks one already-recorded synthetic reservation as `cancelled`
   * (step 17, design §14.4). A no-op when this store never saw that
   * reservation — the console's fixture appointments live in the calendar,
   * not in this store, and only the ones a call created are here.
   *
   * WHY IT EXISTS: a reservation has TWO copies, one in the working calendar
   * and one here. Cancelling only the calendar's copy would leave
   * `snap.reservations` saying `confirmed` for a call-created booking that
   * the agenda already shows as cancelled. The console's design criterion 9
   * ("the two projections agree on `status` for every shared id") is exactly
   * that invariant, and this method is what lets one handler keep both
   * copies in step inside a single synchronous tick.
   */
  markReservationCancelled(reservationId: string): void;
  addHumanTask(task: HumanTask): void;
  /**
   * Closes one human task (step 17, design §7.3). A no-op for an unknown
   * id, and idempotent: completing an already-completed task keeps the FIRST
   * completion timestamp, so a double click cannot rewrite history.
   *
   * ADDITIVE: nothing that existed before this mission calls it.
   */
  completeHumanTask(id: string, completedAtISO: string): void;
  addInternalNotice(notice: InternalNotice): void;
  addError(error: EngineError): void;
  snapshot(): MemoryStoreSnapshot;
  reset(): void;
}

export function createMemoryStore(): MemoryStore {
  let calls: CallRecord[] = [];
  let reservations: SyntheticReservation[] = [];
  let humanTasks: HumanTask[] = [];
  let internalNotices: InternalNotice[] = [];
  let errors: EngineError[] = [];

  return {
    recordCallStarted(record) {
      calls.push(record);
    },
    addReservation(cal, reservation) {
      reservations.push(reservation);
      return { ...cal, reservations: [...cal.reservations, reservation] };
    },
    markReservationCancelled(reservationId) {
      reservations = reservations.map((r) => (r.id === reservationId ? { ...r, status: "cancelled" as const } : r));
    },
    addHumanTask(task) {
      humanTasks.push(task);
    },
    completeHumanTask(id, completedAtISO) {
      humanTasks = humanTasks.map((t) => (t.id === id && t.completedAtISO === undefined ? { ...t, completedAtISO } : t));
    },
    addInternalNotice(notice) {
      internalNotices.push(notice);
    },
    addError(error) {
      errors.push(error);
    },
    snapshot() {
      return {
        calls: [...calls],
        reservations: [...reservations],
        humanTasks: [...humanTasks],
        internalNotices: [...internalNotices],
        errors: [...errors],
      };
    },
    reset() {
      calls = [];
      reservations = [];
      humanTasks = [];
      internalNotices = [];
      errors = [];
    },
  };
}
