/**
 * 2026-10-11 ((internal doc, not included in the template) §2.2 paso 5) — in-memory
 * holds on a slot `(employeeId, startsAt)` for the few hundred milliseconds
 * between the DELETE and the POST of a service change. `BookingService.book`
 * asks {@link SlotHoldRegistry.isHeld} right before its own POST and answers
 * `slot_taken`, so no channel of THIS middleware can take the slot in between.
 *
 * Safety TTL: a hold that was never released (a crash between hold and release
 * cannot happen in-process, but a forgotten release must not close a slot
 * forever) expires by itself. Holds on the same slot nest (counter).
 */

export const SLOT_HOLD_DEFAULT_TTL_MS = 20_000;

/** "YYYY-MM-DD HH:mm" from "YYYY-MM-DD HH:mm[:ss]" (or with a "T"). */
function slotKey(employeeId: number, startsAt: string): string {
  return `${employeeId}|${startsAt.replace("T", " ").slice(0, 16)}`;
}

export class SlotHoldRegistry {
  private readonly holds = new Map<string, Array<{ id: number; expiresAt: number }>>();
  private seq = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /** Holds the slot; the returned function releases THIS hold (idempotent). */
  hold(employeeId: number, startsAt: string, ttlMs: number = SLOT_HOLD_DEFAULT_TTL_MS): () => void {
    const key = slotKey(employeeId, startsAt);
    const id = (this.seq += 1);
    const list = this.holds.get(key) ?? [];
    list.push({ id, expiresAt: this.clock() + ttlMs });
    this.holds.set(key, list);
    return () => {
      const current = this.holds.get(key);
      if (current === undefined) return;
      const rest = current.filter((h) => h.id !== id);
      if (rest.length === 0) this.holds.delete(key);
      else this.holds.set(key, rest);
    };
  }

  isHeld(employeeId: number, startsAt: string, nowMs: number = this.clock()): boolean {
    const key = slotKey(employeeId, startsAt);
    const list = this.holds.get(key);
    if (list === undefined) return false;
    const live = list.filter((h) => h.expiresAt > nowMs);
    if (live.length === 0) {
      this.holds.delete(key);
      return false;
    }
    if (live.length !== list.length) this.holds.set(key, live);
    return true;
  }
}
