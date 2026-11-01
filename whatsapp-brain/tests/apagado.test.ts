import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TurnQueue } from "../src/queue.js";
import type { InboundMessage } from "../src/meta.js";

/**
 * 2026-10-09 (escaneo, hallazgo 3) — a redeploy must not lose the messages the
 * brain already accepted: on SIGTERM the queue answers bursts still in their
 * coalescing window at once and waits for running turns; Docker must give it
 * longer than that wait.
 */

const msg = (waId: string, id: string): InboundMessage => ({
  waId,
  messageId: id,
  timestamp: 1700000000,
  type: "text",
  text: "hola",
  profileName: undefined,
});

describe("hallazgo 3 · graceful drain", () => {
  it("drain() answers a burst still in its 60 s coalescing window right away", async () => {
    const handled: string[] = [];
    const q = new TurnQueue(60_000, async (waId, batch) => {
      handled.push(`${waId}:${batch.length}`);
    });
    q.push(msg("34600000001", "a"));
    q.push(msg("34600000001", "b"));
    q.push(msg("34600000002", "c"));
    const started = Date.now();
    q.drain();
    await q.idle(5, 2_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(handled.sort()).toEqual(["34600000001:2", "34600000002:1"]);
    expect(q.pendingCount()).toBe(0);
    expect(q.runningCount()).toBe(0);
  });

  it("a message that arrives while a turn runs is answered in the same drain", async () => {
    const handled: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new TurnQueue(0, async (_waId, batch) => {
      handled.push(batch.length);
      if (handled.length === 1) await gate;
    });
    q.push(msg("34600000003", "a"));
    await new Promise((r) => setTimeout(r, 10));
    expect(q.runningCount()).toBe(1);
    q.push(msg("34600000003", "b"));
    q.drain();
    release();
    await q.idle(5, 2_000);
    expect(handled).toEqual([1, 1]);
  });

  it("idle() gives up at its budget and reports the turn still running", async () => {
    const q = new TurnQueue(0, () => new Promise<void>(() => undefined));
    q.push(msg("34600000004", "a"));
    await new Promise((r) => setTimeout(r, 10));
    q.drain();
    await q.idle(5, 50);
    expect(q.runningCount()).toBe(1);
  });

});
