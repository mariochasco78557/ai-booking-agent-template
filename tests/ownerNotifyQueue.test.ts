import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileOwnerNotifyQueueStore,
  OWNER_JOB_RETENTION_MS,
  type OwnerJob,
} from "../src/services/ownerNotify/ownerNotifyQueueStore.js";

const NOW = Date.parse("2031-03-03T10:00:00Z");

function job(overrides: Partial<OwnerJob> = {}): OwnerJob {
  return {
    id: "cancellation_done:1",
    kind: "cancellation_done",
    text: "texto",
    createdAt: NOW,
    status: "pending",
    attempts: 0,
    nextAttemptAt: NOW,
    lastError: null,
    providerMessageId: null,
    sentAt: null,
    ...overrides,
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-queue-"));
  path = join(dir, "sub", "queue.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileOwnerNotifyQueueStore", () => {
  it("enqueues, survives a reload and creates the directory 0700", () => {
    const store = new FileOwnerNotifyQueueStore(path, NOW);
    expect(store.enqueue(job())).toBe(true);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const reloaded = new FileOwnerNotifyQueueStore(path, NOW);
    expect(reloaded.get("cancellation_done:1")).toMatchObject({ text: "texto", status: "pending" });
    expect(reloaded.all()).toHaveLength(1);
  });

  it("a duplicate key is a no-op", () => {
    const store = new FileOwnerNotifyQueueStore(path, NOW);
    expect(store.enqueue(job())).toBe(true);
    expect(store.enqueue(job({ text: "otro" }))).toBe(false);
    expect(store.get("cancellation_done:1")?.text).toBe("texto");
  });

  it("the last line wins on reload", () => {
    const store = new FileOwnerNotifyQueueStore(path, NOW);
    store.enqueue(job());
    store.update(job({ status: "sent", attempts: 1, providerMessageId: 9, sentAt: NOW }));
    const reloaded = new FileOwnerNotifyQueueStore(path, NOW);
    expect(reloaded.get("cancellation_done:1")).toMatchObject({ status: "sent", providerMessageId: 9 });
    expect(reloaded.due(NOW + 1)).toHaveLength(0);
  });

  it("ignores a corrupt line and warns without content", () => {
    const store = new FileOwnerNotifyQueueStore(path, NOW);
    store.enqueue(job());
    appendFileSync(path, "{not json\n");
    appendFileSync(path, `${JSON.stringify({ v: 1, job: { id: "x" } })}\n`);
    const warnings: Array<[string, Record<string, number>]> = [];
    const reloaded = new FileOwnerNotifyQueueStore(path, NOW, (m, d) => warnings.push([m, d]));
    expect(reloaded.all()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![1]).toEqual({ skipped: 2 });
  });

  it("compaction drops finished jobs older than 14 days and keeps pending ones", () => {
    const store = new FileOwnerNotifyQueueStore(path, NOW);
    store.enqueue(job({ id: "old_done", status: "sent", createdAt: NOW }));
    store.enqueue(job({ id: "old_pending", status: "pending", createdAt: NOW }));
    store.enqueue(job({ id: "recent", status: "sent", createdAt: NOW + OWNER_JOB_RETENTION_MS - 1000 }));

    const later = NOW + OWNER_JOB_RETENTION_MS + 1;
    const reloaded = new FileOwnerNotifyQueueStore(path, later);
    expect(reloaded.get("old_done")).toBeUndefined();
    expect(reloaded.get("old_pending")).toBeDefined();
    expect(reloaded.get("recent")).toBeDefined();
    expect(readFileSync(path, "utf8")).not.toContain("old_done");
  });

  it("due() returns only pending jobs whose time arrived, oldest first", () => {
    const store = new FileOwnerNotifyQueueStore(path, NOW);
    store.enqueue(job({ id: "b", nextAttemptAt: NOW + 10 }));
    store.enqueue(job({ id: "a", nextAttemptAt: NOW }));
    store.enqueue(job({ id: "later", nextAttemptAt: NOW + 10_000 }));
    store.enqueue(job({ id: "done", status: "sent" }));
    expect(store.due(NOW + 100).map((j) => j.id)).toEqual(["a", "b"]);
  });
});

describe("agenda jobs (AVISOS_AGENDA)", () => {
  const event = {
    type: "cancelled" as const,
    startsAt: "2026-10-13 17:30",
    professional: "Olga",
    customer: "Mikel A.",
    noticeMinutes: 480,
    lateNotice: false,
    channel: "whatsapp" as const,
  };

  it("new kinds with an event are stored, reloaded and survive compaction; an agenda job without event is skipped", () => {
    const store = new FileOwnerNotifyQueueStore(path, NOW);
    store.enqueue(job({ id: "agenda_rid:1", kind: "agenda_cancelled", text: "", event }));
    store.enqueue(job({ id: "agenda_digest:2026-10-13", kind: "agenda_digest", text: "📅 Hoy martes 13 · 3 citas", status: "sent" }));
    appendFileSync(
      path,
      `${JSON.stringify({ v: 1, job: job({ id: "agenda_rid:2", kind: "agenda_changed", text: "" }) })}\n`,
    );
    const warnings: Array<[string, Record<string, number>]> = [];
    const reloaded = new FileOwnerNotifyQueueStore(path, NOW, (m, d) => warnings.push([m, d]));
    expect(reloaded.get("agenda_rid:1")).toMatchObject({ kind: "agenda_cancelled", event });
    expect(reloaded.get("agenda_digest:2026-10-13")).toBeDefined();
    expect(reloaded.get("agenda_rid:2")).toBeUndefined();
    expect(warnings[0]![1]).toEqual({ skipped: 1 });
    const again = new FileOwnerNotifyQueueStore(path, NOW);
    expect(again.get("agenda_rid:1")?.event).toEqual(event);
  });

  it("digest_only is never due and is pruned after 14 days", () => {
    const store = new FileOwnerNotifyQueueStore(path, NOW);
    const booked = {
      type: "booked" as const,
      channel: "whatsapp" as const,
      conversationId: "wa_1_1",
      startsAt: "2026-10-13 10:00",
      professional: "Ramón",
    };
    store.enqueue(job({ id: "agenda_booked:x:y", kind: "agenda_booked", text: "", status: "digest_only", event: booked }));
    expect(store.due(NOW + 1_000)).toHaveLength(0);
    const later = new FileOwnerNotifyQueueStore(path, NOW + OWNER_JOB_RETENTION_MS + 1);
    expect(later.get("agenda_booked:x:y")).toBeUndefined();
  });
});
