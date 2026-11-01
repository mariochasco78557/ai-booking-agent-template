import type { Clock } from "../domain/types.js";
import type { WaitlistWrite } from "./commands.js";
import { freshWaitlist } from "./fixture.js";
import type {
  CancellationPolicy,
  CancellationRecord,
  ReleasedSlot,
  WaitlistAuditDraft,
  WaitlistAuditEvent,
  WaitlistEntry,
} from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 17 — THE IN-MEMORY WAITLIST STORE (design §1.1, §3.5).
 *
 * Modelled on `store/memoryStore.ts`: purely in-process state for one
 * process's lifetime. No file, no database, no network call anywhere in this
 * module. It is the only mutable thing in the whole waitlist feature; every
 * decision about WHAT to write is taken by the pure handlers in commands.ts.
 *
 * `commit()` applies a complete `WaitlistWrite` in ONE synchronous call: it
 * is not async, it awaits nothing, and it cannot leave a half-write behind
 * (design §14.5).
 * ────────────────────────────────────────────────────────────────────────
 */

export interface WaitlistStoreSnapshot {
  entries: readonly WaitlistEntry[];
  cancellations: readonly CancellationRecord[];
  releasedSlots: readonly ReleasedSlot[];
  auditLog: readonly WaitlistAuditEvent[];
  policy: CancellationPolicy;
  /** The next `wl-NNNN` number an operator-created entry would take. */
  nextEntryNumber: number;
  /** The running offer counter, so simulated-notice ids stay unique. */
  nextOfferSeq: number;
}

export interface WaitlistStore {
  snapshot(): WaitlistStoreSnapshot;
  /** Applies a complete write atomically, stamping every audit event with its `id`/`seq`. Returns the stamped events. */
  commit(write: WaitlistWrite): readonly WaitlistAuditEvent[];
  /** Appends audit events without touching anything else (used by the idempotent-replay path). */
  appendEvents(events: readonly WaitlistAuditDraft[]): readonly WaitlistAuditEvent[];
  /** Restores the fixture, the 120-minute demo policy and an empty log with a single `DEMO_RESET` (design §3.5). */
  reset(): void;
}

function auditEventId(seq: number): string {
  return `wla-${String(seq).padStart(8, "0")}`;
}

export function createWaitlistStore(clock: Clock): WaitlistStore {
  let entries: WaitlistEntry[] = [];
  let cancellations: CancellationRecord[] = [];
  let releasedSlots: ReleasedSlot[] = [];
  let auditLog: WaitlistAuditEvent[] = [];
  let policy: CancellationPolicy = { cancellationNoticeMinutes: 120, source: "demo_default" };
  let nextEntryNumber = 1;
  let nextOfferSeq = 1;
  let nextAuditSeq = 1;

  function stamp(drafts: readonly WaitlistAuditDraft[]): WaitlistAuditEvent[] {
    return drafts.map((draft) => {
      const seq = nextAuditSeq;
      nextAuditSeq += 1;
      return { ...draft, id: auditEventId(seq), seq };
    });
  }

  function loadFixture(): void {
    const fresh = freshWaitlist(clock);
    entries = fresh.entries;
    policy = fresh.policy;
    cancellations = [];
    releasedSlots = [];
    auditLog = [];
    nextEntryNumber = 1;
    nextOfferSeq = 1;
    nextAuditSeq = 1;
  }

  const store: WaitlistStore = {
    snapshot() {
      return {
        entries: [...entries],
        cancellations: [...cancellations],
        releasedSlots: [...releasedSlots],
        auditLog: [...auditLog],
        policy: { ...policy },
        nextEntryNumber,
        nextOfferSeq,
      };
    },
    commit(write) {
      if (write.entries !== undefined) entries = [...write.entries];
      if (write.cancellations !== undefined) cancellations = [...write.cancellations];
      if (write.releasedSlots !== undefined) releasedSlots = [...write.releasedSlots];
      if (write.policy !== undefined) policy = { ...write.policy };
      nextEntryNumber += write.entriesMinted ?? 0;
      nextOfferSeq += write.offersMinted ?? 0;
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
      loadFixture();
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
