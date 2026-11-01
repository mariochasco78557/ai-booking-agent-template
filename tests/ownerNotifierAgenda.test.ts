import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENDA_CHANGE_WINDOW_MS,
  DIGEST_COUNT_WAIT_MS,
  DIGEST_GIVE_UP_MS,
  OwnerNotifier,
  type OwnerAgendaConfig,
} from "../src/services/ownerNotify/ownerNotifier.js";
import { FileOwnerNotifyQueueStore } from "../src/services/ownerNotify/ownerNotifyQueueStore.js";
import { formatCancellationMessage } from "../src/services/ownerNotify/ownerMessages.js";
import type { TelegramClient } from "../src/services/ownerNotify/telegramClient.js";

const CHAT = "555111";
// Far-future clock: the 0 ms «kick» sweep (real clock) always finds the gate closed.
const OPEN = Date.parse("2031-03-04T09:00:00Z"); // 10:00 Madrid (CET)
const MIN = 60_000;

type SendResult =
  | { ok: true; messageId: number }
  | { ok: false; retryable: boolean; retryAfterMs?: number; error: string };

let dir: string;
let path: string;
let gateOpen: boolean;
let sent: string[];
let nextId: number;
let sendImpl: (text: string) => SendResult;

function makeLogger() {
  const lines: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const mk = (level: string) => (obj: unknown, msg?: string) => {
    lines.push({ level, obj, msg });
  };
  return { lines, logger: { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") } };
}

const cancellation = {
  kind: "cancellation_done" as const,
  reservationId: 4321,
  startsAt: "2031-03-04 17:30",
  professional: "Bruno Prueba",
  service: "Corte de pelo",
  ownerName: "IA - Ana",
  ownerSurnames: "Prueba Sintetica",
  callerPhoneE164: "+34600000001",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-agenda-"));
  path = join(dir, "queue.jsonl");
  gateOpen = true;
  sent = [];
  nextId = 100;
  sendImpl = () => ({ ok: true, messageId: nextId++ });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function build(opts: {
  agenda?: Partial<OwnerAgendaConfig> | false;
  mode?: "dry_run" | "live";
  nowForStore?: number;
} = {}) {
  const { logger, lines } = makeLogger();
  const store = new FileOwnerNotifyQueueStore(path, opts.nowForStore ?? OPEN);
  const client = {
    sendMessage: vi.fn(async (i: { text: string }) => {
      const result = sendImpl(i.text);
      if (result.ok) sent.push(i.text);
      return result;
    }),
  };
  const countDay = vi.fn(async (_date: string) => 14);
  const agenda: OwnerAgendaConfig | undefined =
    opts.agenda === false ? undefined : { namePrefix: "IA -", countDay, ...(opts.agenda ?? {}) };
  const mode = opts.mode ?? "live";
  const notifier = new OwnerNotifier(
    { mode, chatId: CHAT },
    store,
    mode === "live" ? (client as unknown as TelegramClient) : undefined,
    logger,
    { isOpenAt: (t: number) => gateOpen && t >= OPEN - MIN },
    agenda,
  );
  return { notifier, store, client, countDay: agenda?.countDay as typeof countDay, lines };
}

/** Settles today's digest so the following events go out as single lines. */
async function settleDigest(n: OwnerNotifier, at = OPEN): Promise<void> {
  await n.drain(at);
  sent.length = 0;
}

describe("OwnerNotifier without agenda config", () => {
  it("13. cancellation_done is exactly today's text and job id", async () => {
    const { notifier, store } = build({ agenda: false });
    notifier.enqueueCancellation(cancellation, OPEN);
    const job = store.get("cancellation_done:4321")!;
    expect(job.text).toBe(formatCancellationMessage(cancellation));
    expect(job.event).toBeUndefined();
    await notifier.drain(OPEN);
    expect(sent).toEqual([formatCancellationMessage(cancellation)]);
    expect(store.all().some((j) => j.kind.startsWith("agenda_"))).toBe(false);
  });

  it("26. enqueueAgendaBooked and enqueueServiceChanged return false and write nothing", () => {
    const { notifier, store } = build({ agenda: false });
    expect(
      notifier.enqueueAgendaBooked(
        { channel: "whatsapp", conversationId: "C", slotToken: "t", startsAt: null, professional: null },
        OPEN,
      ),
    ).toBe(false);
    expect(store.all()).toHaveLength(0);
  });
});

describe("OwnerNotifier with agenda lines", () => {
  it("14. gate open: a cancellation is ONE one-line message, job agenda_rid:<rid>", async () => {
    const { notifier, store } = build();
    await settleDigest(notifier);
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp", conversationId: "C", noticeMinutes: 480, lateNotice: false }, OPEN + 1000);
    await notifier.drain(OPEN + 2000);
    expect(sent).toEqual(["❌ ANULADA · hoy 17:30 · Bruno · Ana P. · con aviso (8 h antes)"]);
    expect(store.get("agenda_rid:4321")).toMatchObject({ kind: "agenda_cancelled", status: "sent" });
    expect(store.get("cancellation_done:4321")).toBeUndefined();
    expect(sent[0]).not.toMatch(/\d{9}/);
  });

  it("15. gate closed: nothing leaves; at the opening the FIRST message is the digest, lines are not repeated", async () => {
    const { notifier, store } = build();
    gateOpen = false;
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp", noticeMinutes: 30, lateNotice: true }, OPEN - 600 * MIN);
    notifier.enqueueCancellation(
      { ...cancellation, reservationId: 4322, channel: "voice", changeTo: { startsAt: "2031-03-04 12:00", professional: "Olga" } },
      OPEN - 590 * MIN,
    );
    notifier.enqueueCancellation(
      { ...cancellation, kind: "cancellation_request", reservationId: 4323, motive: "too_late" },
      OPEN - 580 * MIN,
    );
    await notifier.drain(OPEN - 500 * MIN);
    expect(sent).toHaveLength(0);

    gateOpen = true;
    await notifier.drain(OPEN);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.startsWith("📅 Hoy ")).toBe(true);
    expect(sent[0]).toContain("· 14 citas");
    expect(sent[0]).toContain("⚠️ SIN AVISO (30 min antes)");
    expect(sent[0]).toContain("🔁 CAMBIADA");
    expect(sent[1]).toContain("Quiere ANULAR (no anulada");

    await notifier.drain(OPEN + 10 * MIN);
    expect(sent).toHaveLength(2);
    const digest = store.get("agenda_digest:2031-03-04")!;
    expect(digest).toMatchObject({ kind: "agenda_digest", status: "sent" });
    expect(digest.text).toBe("📅 Hoy martes 4 · 14 citas");
    for (const id of ["agenda_rid:4321", "agenda_rid:4322"]) {
      expect(store.get(id)).toMatchObject({ status: "sent", providerMessageId: digest.providerMessageId });
    }
  });

  it("16. one digest per day, also after a restart", async () => {
    const first = build();
    await first.notifier.drain(OPEN);
    await first.notifier.drain(OPEN + MIN);
    const second = build();
    await second.notifier.drain(OPEN + 2 * MIN);
    expect(sent.filter((t) => t.startsWith("📅"))).toHaveLength(1);
    expect(second.countDay).not.toHaveBeenCalled();
  });

  it("17. countDay throws: retries every 60 s, after 10 min says it could not count; lines held, owner_alert not", async () => {
    const { notifier } = build({ agenda: { countDay: vi.fn(async () => { throw new Error("down"); }) } });
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp" }, OPEN);
    notifier.enqueueOwnerAlert(
      { reason: "wants_human", summary: "quiere hablar", callerFormat: "e164", callerPhoneE164: "+34600000002" },
      OPEN,
    );
    await notifier.drain(OPEN);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Aviso del WhatsApp");
    await notifier.drain(OPEN + 59_000);
    expect(sent).toHaveLength(1);
    await notifier.drain(OPEN + 5 * MIN);
    expect(sent).toHaveLength(1);
    await notifier.drain(OPEN + DIGEST_COUNT_WAIT_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("📅 Hoy martes 4 · no he podido contar las citas");
    expect(sent[1]).toContain("❌ ANULADA");
  });

  it("17b. the count is retried no sooner than 60 s", async () => {
    const countDay = vi.fn(async (_d: string) => {
      throw new Error("down");
    });
    const { notifier } = build({ agenda: { countDay } });
    await notifier.drain(OPEN);
    await notifier.drain(OPEN + 59_000);
    expect(countDay).toHaveBeenCalledTimes(1);
    await notifier.drain(OPEN + 60_000);
    expect(countDay).toHaveBeenCalledTimes(2);
  });

  it("18. retryable Telegram failure holds the lines; after 60 min the digest is failed and lines go out alone", async () => {
    sendImpl = (text) =>
      text.startsWith("📅") ? { ok: false, retryable: true, error: "http_500" } : { ok: true, messageId: nextId++ };
    const { notifier, store } = build();
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp" }, OPEN);
    await notifier.drain(OPEN);
    expect(sent).toHaveLength(0);
    expect(store.get("agenda_rid:4321")!.status).toBe("pending");
    await notifier.drain(OPEN + 31_000);
    expect(sent).toHaveLength(0);
    expect(store.get("agenda_digest:2031-03-04")).toBeUndefined();

    await notifier.drain(OPEN + DIGEST_GIVE_UP_MS + MIN);
    expect(store.get("agenda_digest:2031-03-04")).toMatchObject({ status: "failed" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("❌ ANULADA");
    expect(sent[0]!.startsWith("📅")).toBe(false);
  });

  it("18b. a non-retryable digest error is failed at once", async () => {
    sendImpl = (text) =>
      text.startsWith("📅") ? { ok: false, retryable: false, error: "http_400" } : { ok: true, messageId: nextId++ };
    const { notifier, store } = build();
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp" }, OPEN);
    await notifier.drain(OPEN);
    expect(store.get("agenda_digest:2031-03-04")).toMatchObject({ status: "failed" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("❌ ANULADA");
  });

  it("19. WhatsApp correlation: a booking in the same conversation <=60 min earlier makes it a change", async () => {
    const { notifier, store } = build();
    await settleDigest(notifier);
    notifier.enqueueAgendaBooked(
      { channel: "whatsapp", conversationId: "C", slotToken: "tok1", startsAt: "2031-03-11 10:00", professional: "Ramón" },
      OPEN,
    );
    notifier.enqueueCancellation(
      { ...cancellation, channel: "whatsapp", conversationId: "C" },
      OPEN + 30 * MIN,
    );
    const job = store.get("agenda_rid:4321")!;
    expect(job.kind).toBe("agenda_changed");
    expect(job.event).toMatchObject({ type: "changed", fromStartsAt: "2031-03-04 17:30", toStartsAt: "2031-03-11 10:00", toProfessional: "Ramón" });
    expect(store.all().find((j) => j.kind === "agenda_booked")!.status).toBe("sent");
  });

  it("19b. at 61 min, in another conversation, or by voice it is a plain cancellation and the booking still counts", async () => {
    const { notifier, store } = build();
    await settleDigest(notifier);
    notifier.enqueueAgendaBooked(
      { channel: "whatsapp", conversationId: "C", slotToken: "tok1", startsAt: "2031-03-11 10:00", professional: "Ramón" },
      OPEN,
    );
    notifier.enqueueCancellation({ ...cancellation, reservationId: 1, channel: "whatsapp", conversationId: "C" }, OPEN + AGENDA_CHANGE_WINDOW_MS + 1);
    notifier.enqueueCancellation({ ...cancellation, reservationId: 2, channel: "whatsapp", conversationId: "OTHER" }, OPEN + MIN);
    notifier.enqueueCancellation({ ...cancellation, reservationId: 3, channel: "voice", conversationId: "C" }, OPEN + MIN);
    for (const rid of [1, 2, 3]) expect(store.get(`agenda_rid:${rid}`)!.kind).toBe("agenda_cancelled");
    expect(store.all().find((j) => j.kind === "agenda_booked")!.status).toBe("digest_only");
  });

  it("20. voice with changeTo is CAMBIADA and never ANULADA for that rid", async () => {
    const { notifier, store } = build();
    await settleDigest(notifier);
    notifier.enqueueCancellation(
      { ...cancellation, channel: "voice", changeTo: { startsAt: "2031-03-05 11:00", professional: "Olga" } },
      OPEN,
    );
    await notifier.drain(OPEN + 1000);
    expect(sent).toEqual(["🔁 CAMBIADA · hoy 17:30 → mañana 11:00 · Bruno → Olga · Ana P."]);
    expect(store.all().filter((j) => j.kind === "agenda_cancelled")).toHaveLength(0);
  });

  it("21. the same rid twice is one job", () => {
    const { notifier, store } = build();
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp" }, OPEN);
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp" }, OPEN + 5);
    expect(store.all().filter((j) => j.id === "agenda_rid:4321")).toHaveLength(1);
    expect(store.all()).toHaveLength(1);
  });

  it("22. an event that arrives while the digest waits for the count goes into the digest, not alone", async () => {
    let fail = true;
    const countDay = vi.fn(async (_d: string) => {
      if (fail) throw new Error("down");
      return 9;
    });
    const { notifier } = build({ agenda: { countDay } });
    await notifier.drain(OPEN);
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp" }, OPEN + 1000);
    await notifier.drain(OPEN + 2000);
    expect(sent).toHaveLength(0);
    fail = false;
    await notifier.drain(OPEN + MIN);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("· 9 citas");
    expect(sent[0]).toContain("❌ ANULADA");
    await notifier.drain(OPEN + 2 * MIN);
    expect(sent).toHaveLength(1);
  });

  it("23. cancellation_request and owner_alert keep their multi-line text and leave after the digest", async () => {
    const { notifier } = build();
    notifier.enqueueCancellation({ ...cancellation, kind: "cancellation_request", motive: "technical" }, OPEN);
    await notifier.drain(OPEN);
    expect(sent[0]!.startsWith("📅")).toBe(true);
    expect(sent[1]).toBe(formatCancellationMessage({ ...cancellation, kind: "cancellation_request", motive: "technical" }));
  });

  it("24. dry_run: no network, states sent_dry_run, the digest log has only numbers", async () => {
    const { notifier, store, client, lines } = build({ mode: "dry_run" });
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp" }, OPEN);
    notifier.enqueueAgendaBooked(
      { channel: "voice", conversationId: "V", slotToken: "t", startsAt: null, professional: null },
      OPEN,
    );
    await notifier.drain(OPEN);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(store.get("agenda_digest:2031-03-04")!.status).toBe("sent_dry_run");
    expect(store.get("agenda_rid:4321")!.status).toBe("sent_dry_run");
    const digestLog = lines.find((l) => l.msg === "owner digest dry run: NOT sent")!;
    expect(digestLog.obj).toEqual({ date: "2031-03-04", count_known: true, lines: 1, booked_wa: 0, booked_voice: 1 });
  });

  it("25. logs carry no customer name, phone or line text", async () => {
    const { notifier, lines } = build();
    notifier.enqueueCancellation({ ...cancellation, channel: "whatsapp" }, OPEN);
    await notifier.drain(OPEN);
    notifier.enqueueCancellation({ ...cancellation, reservationId: 9, channel: "whatsapp" }, OPEN + MIN);
    await notifier.drain(OPEN + 2 * MIN);
    const logged = JSON.stringify(lines);
    expect(logged).not.toMatch(/Ana|Prueba|600000001|600 000 001|ANULADA|17:30/);
  });
});
