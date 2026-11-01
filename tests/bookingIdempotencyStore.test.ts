import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileBookingIdempotencyStore,
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
  MemoryBookingIdempotencyStore,
} from "../src/services/bookingIdempotencyStore.js";

const T0 = Date.parse("2026-08-30T09:00:00Z");

const dirs: string[] = [];
function tempPath(name = "idempotency.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "demo-salon-idem-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const record = (fingerprint: string, at: number, message = "confirmada") => ({
  fingerprint,
  result: { message },
  storedAtMs: at,
});

describe("in-memory booking idempotency store", () => {
  it("declares itself non-durable, which is what the boot guard keys on", () => {
    expect(new MemoryBookingIdempotencyStore().durable).toBe(false);
  });

  it("replays a remembered booking within the TTL and forgets it after", () => {
    const store = new MemoryBookingIdempotencyStore<{ message: string }>();
    store.remember("conv-1", record("fp-1", T0));

    expect(store.get("conv-1", T0 + IDEMPOTENCY_TTL_MS - 1)?.fingerprint).toBe("fp-1");
    expect(store.get("conv-1", T0 + IDEMPOTENCY_TTL_MS)).toBeUndefined();
  });

  it("stays bounded under a flood, keeping the most recent conversations", () => {
    const store = new MemoryBookingIdempotencyStore<{ message: string }>();
    for (let i = 0; i < IDEMPOTENCY_MAX_ENTRIES + 50; i += 1) {
      store.remember(`conv-${i}`, record(`fp-${i}`, T0 + i));
    }

    // The oldest were evicted; the newest are still replayable. Without the
    // bound, an unbounded number of conversation ids would be a memory sink.
    expect(store.get("conv-0", T0)).toBeUndefined();
    const newest = IDEMPOTENCY_MAX_ENTRIES + 49;
    expect(store.get(`conv-${newest}`, T0 + newest)?.fingerprint).toBe(`fp-${newest}`);
  });
});

describe("file-backed booking idempotency store", () => {
  it("survives a restart — the whole reason this store exists", () => {
    const path = tempPath();
    const before = new FileBookingIdempotencyStore<{ message: string }>(path, T0);
    before.remember("conv-restart", record("fp-restart", T0));

    // A brand new instance over the same file is exactly what a container
    // restart produces. The booking must still be known, or ElevenLabs'
    // retry of the same tool call would book the customer a second time.
    const after = new FileBookingIdempotencyStore<{ message: string }>(path, T0 + 1000);
    const replay = after.get("conv-restart", T0 + 1000);

    expect(after.durable).toBe(true);
    expect(replay?.fingerprint).toBe("fp-restart");
    expect(replay?.result).toEqual({ message: "confirmada" });
  });

  it("does not resurrect a record that expired while the process was down", () => {
    const path = tempPath();
    new FileBookingIdempotencyStore<{ message: string }>(path, T0).remember(
      "conv-old",
      record("fp-old", T0),
    );

    const after = new FileBookingIdempotencyStore<{ message: string }>(
      path,
      T0 + IDEMPOTENCY_TTL_MS + 1,
    );
    expect(after.get("conv-old", T0 + IDEMPOTENCY_TTL_MS + 1)).toBeUndefined();
  });

  it("compacts on boot so an append-only file cannot grow forever", () => {
    const path = tempPath();
    const store = new FileBookingIdempotencyStore<{ message: string }>(path, T0);
    for (let i = 0; i < 20; i += 1) {
      store.remember("conv-same", record(`fp-${i}`, T0 + i));
    }
    const linesBefore = readFileSync(path, "utf8").trim().split("\n").length;

    new FileBookingIdempotencyStore<{ message: string }>(path, T0 + 20);
    const linesAfter = readFileSync(path, "utf8").trim().split("\n").length;

    expect(linesBefore).toBe(20);
    expect(linesAfter).toBe(1);
  });

  it("drops a torn trailing line instead of refusing to start", () => {
    const path = tempPath();
    const store = new FileBookingIdempotencyStore<{ message: string }>(path, T0);
    store.remember("conv-good", record("fp-good", T0));
    // What a crash in the middle of an append leaves behind.
    writeFileSync(path, `${readFileSync(path, "utf8")}{"v":1,"id":"conv-tor`);

    const warnings: Array<Record<string, number>> = [];
    const after = new FileBookingIdempotencyStore<{ message: string }>(path, T0, (_m, d) =>
      warnings.push(d),
    );

    // The intact record survives; the truncated one is gone. Treating an
    // unreadable record as absent is the safe direction: the retry is handled
    // as new, which at worst re-books nothing (writes are gated separately).
    expect(after.get("conv-good", T0)?.fingerprint).toBe("fp-good");
    expect(warnings).toEqual([{ skipped: 1 }]);
  });

  it("keeps the persisted file unreadable to other users on the host", () => {
    const path = tempPath();
    new FileBookingIdempotencyStore<{ message: string }>(path, T0).remember(
      "conv-perm",
      record("fp-perm", T0),
    );

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to construct when the path is not writable, rather than degrading silently", () => {
    const path = tempPath("regular-file");
    writeFileSync(path, "not a directory");

    // A durable store that quietly falls back to memory is worse than none:
    // the operator would believe they have a guarantee they do not have.
    expect(
      () => new FileBookingIdempotencyStore<{ message: string }>(join(path, "nested.jsonl"), T0),
    ).toThrow();
  });

  it("persists no customer name or phone — only a keyed fingerprint", () => {
    const path = tempPath();
    const store = new FileBookingIdempotencyStore<{ message: string }>(path, T0);
    store.remember("conv-pii", record("d0b7c1a2f3", T0, "Perfecto, la reserva queda confirmada."));

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("Carlos");
    expect(raw).not.toContain("600000101");
    expect(raw).toContain("d0b7c1a2f3");
  });
});

/**
 * step CTL-3 (phase 3) — the store now records every write outcome, not just
 * the successes, and it does so BEFORE the request leaves the process.
 *
 * These tests are about what survives a restart, because the whole point of a
 * durable state machine is the window a `Map` cannot cover: the container is
 * recreated between a write and the provider's retry.
 */
describe("durable write state machine", () => {
  const stateRecord = (
    fingerprint: string,
    at: number,
    state: "started" | "confirmed" | "rejected" | "uncertain",
    upstreamAttempted = true,
  ) => ({ fingerprint, result: { message: state }, storedAtMs: at, state, upstreamAttempted });

  it("carries a rejection across a restart, so the retry cannot re-write", () => {
    // The 2026-08-30 regression, at the storage layer: four identical creates
    // reached the salon because a refusal was never written down.
    const path = tempPath();
    const first = new FileBookingIdempotencyStore<{ message: string }>(path, T0);
    first.remember("conv-rejected", stateRecord("fp-r", T0, "rejected"));

    const restarted = new FileBookingIdempotencyStore<{ message: string }>(path, T0 + 1000);
    const found = restarted.get("conv-rejected", T0 + 1000);
    expect(found?.state).toBe("rejected");
    expect(found?.upstreamAttempted).toBe(true);
  });

  it("promotes a record still reading 'started' to 'uncertain' on load", () => {
    // `started` on disk means the process died between announcing the write
    // and learning its fate. We do not know whether the appointment exists,
    // and "do not know" must never license another write.
    const path = tempPath();
    const first = new FileBookingIdempotencyStore<{ message: string }>(path, T0);
    first.remember("conv-crash", stateRecord("fp-c", T0, "started", false));

    const restarted = new FileBookingIdempotencyStore<{ message: string }>(path, T0 + 500);
    expect(restarted.get("conv-crash", T0 + 500)?.state).toBe("uncertain");
  });

  it("persists the promotion, so a second restart does not have to redo it", () => {
    const path = tempPath();
    new FileBookingIdempotencyStore<{ message: string }>(path, T0).remember(
      "conv-crash",
      stateRecord("fp-c", T0, "started", false),
    );
    // Constructing compacts, writing the promoted state back to the file.
    new FileBookingIdempotencyStore<{ message: string }>(path, T0 + 500);
    expect(readFileSync(path, "utf8")).toContain('"st":"uncertain"');
  });

  it("lets the final outcome supersede the 'started' line for the same call", () => {
    const path = tempPath();
    const store = new FileBookingIdempotencyStore<{ message: string }>(path, T0);
    store.remember("conv-ok", stateRecord("fp-o", T0, "started", false));
    store.remember("conv-ok", stateRecord("fp-o", T0, "confirmed"));

    const restarted = new FileBookingIdempotencyStore<{ message: string }>(path, T0 + 10);
    expect(restarted.get("conv-ok", T0 + 10)?.state).toBe("confirmed");
  });

  it("reads a pre-phase-3 line as a confirmation rather than an unknown", () => {
    // Backwards compatibility with the one record the production journal
    // already holds: the old store only ever wrote successes, so a line with
    // no state can only be a success. Reading it as `uncertain` would refuse
    // to replay a booking that demonstrably exists.
    const path = tempPath();
    writeFileSync(
      path,
      `${JSON.stringify({ v: 1, id: "conv-legacy", fp: "fp-l", at: T0, result: { message: "confirmada" } })}\n`,
      { mode: 0o600 },
    );
    const store = new FileBookingIdempotencyStore<{ message: string }>(path, T0 + 10);
    expect(store.get("conv-legacy", T0 + 10)?.state).toBe("confirmed");
  });

  it("still persists no customer data when it records a failure", () => {
    const path = tempPath();
    const store = new FileBookingIdempotencyStore<{ message: string }>(path, T0);
    store.remember("conv-priv", stateRecord("fp-p", T0, "rejected"));
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("612345678");
    expect(raw).not.toContain("Jorge");
  });
});
