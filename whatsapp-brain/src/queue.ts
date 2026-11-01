/**
 * Per-customer coalescing and serialisation.
 *
 * People write in bursts («hola» / «quería cita» / «para mañana»): the brain
 * waits `coalesceMs` after the LAST message and answers the burst once. While
 * a turn is being processed, new messages wait and form the next turn, so two
 * turns of the same customer never run at the same time.
 */
import type { InboundMessage } from "./meta.js";

export type TurnHandler = (waId: string, messages: InboundMessage[]) => Promise<void>;

interface Slot {
  pending: InboundMessage[];
  timer: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
}

export class TurnQueue {
  private readonly slots = new Map<string, Slot>();
  private readonly seen = new Set<string>();
  private oldestPendingAt: number | undefined;

  constructor(private readonly coalesceMs: number, private readonly handler: TurnHandler) {}

  /** Meta retries deliveries: the same message id is only ever queued once. */
  push(message: InboundMessage): void {
    if (this.seen.has(message.messageId)) return;
    this.seen.add(message.messageId);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);

    const slot = this.slots.get(message.waId) ?? { pending: [], timer: undefined, running: false };
    this.slots.set(message.waId, slot);
    slot.pending.push(message);
    this.oldestPendingAt ??= Date.now();
    if (!slot.running) this.arm(message.waId, slot);
  }

  private arm(waId: string, slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    // While draining nobody else can write in (the server is closed): no reason to wait.
    slot.timer = setTimeout(() => void this.run(waId), this.draining ? 0 : this.coalesceMs);
  }

  private draining = false;

  /**
   * 2026-10-09 (escaneo, hallazgo 3) — graceful shutdown: every burst still
   * waiting for its coalescing window is answered NOW instead of 6 s later,
   * and any turn that ends with new messages is re-run immediately. Pair with
   * {@link idle} to wait for the running turns.
   */
  drain(): void {
    this.draining = true;
    for (const [waId, slot] of this.slots) {
      if (!slot.running && slot.pending.length > 0) this.arm(waId, slot);
    }
  }

  /** Turns running right now (for the shutdown log). */
  runningCount(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.running) n += 1;
    return n;
  }

  private async run(waId: string): Promise<void> {
    const slot = this.slots.get(waId);
    if (!slot || slot.running || slot.pending.length === 0) return;
    slot.timer = undefined;
    slot.running = true;
    const batch = slot.pending.splice(0);
    try {
      await this.handler(waId, batch);
    } finally {
      slot.running = false;
      if (slot.pending.length > 0) this.arm(waId, slot);
      else this.slots.delete(waId);
      if (this.pendingCount() === 0) this.oldestPendingAt = undefined;
    }
  }

  pendingCount(): number {
    let n = 0;
    for (const s of this.slots.values()) n += s.pending.length;
    return n;
  }

  oldestPendingSeconds(): number {
    return this.oldestPendingAt ? (Date.now() - this.oldestPendingAt) / 1000 : 0;
  }

  /** Resolves when nothing is pending or running (tests and graceful shutdown). */
  async idle(pollMs = 20, timeoutMs = 30_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.slots.size > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, pollMs));
  }
}
