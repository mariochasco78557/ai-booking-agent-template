import type { Clock } from "../domain/types.js";
import type {
  ManualBooking,
  NoShowRecord,
  OperationsAuditDraft,
  OperationsAuditEvent,
  OperationsWrite,
  ReservationGroup,
} from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — THE IN-MEMORY OPERATIONS STORE (design §2.13, §4.2).
 *
 * Modelled line by line on `waitlist/store.ts`, which is itself modelled on
 * `store/memoryStore.ts`: purely in-process state for one process's
 * lifetime. No file, no database, no network call anywhere in this module.
 * It is the only mutable thing in the whole no-show feature; every decision
 * about WHAT to write is taken by the pure handlers in `noShow.ts`.
 *
 * `commit()` applies a complete `OperationsWrite` in ONE synchronous call: it
 * is not async, it awaits nothing, and it cannot leave a half-write behind.
 * For a group that means the group, its N reservations and its N+1 audit
 * events land together or not at all (design §4.7).
 *
 * NOTHING IS RETAINED (question K15): a reset erases every record, and the
 * process holds no copy anywhere else.
 * ────────────────────────────────────────────────────────────────────────
 */

export interface OperationsStoreSnapshot {
  noShows: readonly NoShowRecord[];
  groups: readonly ReservationGroup[];
  /** step 24 — las citas manuales, con la misma disciplina que los grupos. */
  manualBookings: readonly ManualBooking[];
  auditLog: readonly OperationsAuditEvent[];
  /**
   * The NEXT group number the store will mint (design §4.6.2). A pure handler
   * cannot mint a monotonic sequence for itself, so it is handed this — the
   * same arrangement `nextEntryNumber` already has in `waitlist/store.ts:60`.
   */
  nextGroupNumber: number;
  /** step 24 — el siguiente `man-NNNN`, por la misma razón exacta. */
  nextManualNumber: number;
}

export interface OperationsStore {
  snapshot(): OperationsStoreSnapshot;
  /** Applies a complete write atomically, stamping every audit event with its `id`/`seq`. Returns the stamped events. */
  commit(write: OperationsWrite): readonly OperationsAuditEvent[];
  /** Appends audit events without touching anything else (used by the idempotent-replay path). */
  appendEvents(events: readonly OperationsAuditDraft[]): readonly OperationsAuditEvent[];
  /** Empties records and log and writes a single `DEMO_RESET` as event 1 (design §2.13). */
  reset(): void;
}

function auditEventId(seq: number): string {
  return `opa-${String(seq).padStart(8, "0")}`;
}

export function createOperationsStore(clock: Clock): OperationsStore {
  let noShows: NoShowRecord[] = [];
  let groups: ReservationGroup[] = [];
  let manualBookings: ManualBooking[] = [];
  let auditLog: OperationsAuditEvent[] = [];
  let nextAuditSeq = 1;
  // The group sequence of §4.6.2. It starts at 1 on a clean process and goes
  // back to 1 on a reset, which is what makes "the same sequence of commands
  // yields the same identifiers" true (criterion 8.33).
  let nextGroupNumber = 1;
  // step 24 — la secuencia de las citas manuales, con la misma propiedad: el
  // mismo guion de demostración produce dos veces los mismos identificadores.
  let nextManualNumber = 1;

  function stamp(drafts: readonly OperationsAuditDraft[]): OperationsAuditEvent[] {
    return drafts.map((draft) => {
      const seq = nextAuditSeq;
      nextAuditSeq += 1;
      return { ...draft, id: auditEventId(seq), seq };
    });
  }

  const store: OperationsStore = {
    snapshot() {
      return {
        noShows: [...noShows],
        groups: [...groups],
        manualBookings: [...manualBookings],
        auditLog: [...auditLog],
        nextGroupNumber,
        nextManualNumber,
      };
    },
    commit(write) {
      if (write.noShows !== undefined) noShows = [...write.noShows];
      if (write.groups !== undefined) groups = [...write.groups];
      if (write.manualBookings !== undefined) manualBookings = [...write.manualBookings];
      // The sequence is consumed by the STORE, from what the handler declares
      // it used — exactly like `entriesMinted` in the waitlist. A handler that
      // minted an id without saying so would be a handler that can hand out
      // the same id twice.
      nextGroupNumber += write.groupsMinted ?? 0;
      nextManualNumber += write.manualBookingsMinted ?? 0;
      const stamped = stamp(write.events);
      auditLog = [...auditLog, ...stamped];
      return stamped;
    },
    appendEvents(events) {
      const stamped = stamp(events);
      auditLog = [...auditLog, ...stamped];
      return stamped;
    },
    reset() {
      noShows = [];
      groups = [];
      // step 24 (diseño §13): las citas manuales se van con todo lo demás. No
      // sobrevive ninguna, y su secuencia vuelve a 1 para que la misma
      // demostración produzca dos veces los mismos identificadores.
      manualBookings = [];
      auditLog = [];
      nextAuditSeq = 1;
      nextGroupNumber = 1;
      nextManualNumber = 1;
      // The clock is captured BY REFERENCE, exactly like the waitlist store's:
      // `POST /api/reset` must therefore call `clock.resetToBaseline()` FIRST
      // (design §1.5), or this `DEMO_RESET` would be stamped with an advanced
      // hour on a demo that claims to be back at the beginning.
      auditLog = stamp([
        {
          kind: "DEMO_RESET",
          actor: "reset",
          atISO: clock.nowInstantISO(),
          synthetic: true,
        },
      ]);
    },
  };

  store.reset();
  return store;
}
