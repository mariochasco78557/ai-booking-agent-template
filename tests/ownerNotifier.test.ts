import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nock from "nock";

import {
  createOwnerNotifier,
  OWNER_BACKOFF_MS,
  OWNER_MAX_ATTEMPTS,
  OwnerNotifier,
} from "../src/services/ownerNotify/ownerNotifier.js";
import {
  FileOwnerNotifyQueueStore,
  type OwnerNotifyQueueStore,
} from "../src/services/ownerNotify/ownerNotifyQueueStore.js";
import { TELEGRAM_API_BASE_URL, TelegramClient } from "../src/services/ownerNotify/telegramClient.js";
import { formatPhoneForOwner } from "../src/services/ownerNotify/ownerMessages.js";

const TOKEN = "1234567890:AAFakeTokenForTestsOnly_0123456789abcdefgh";
const SEND_PATH = `/bot${TOKEN}/sendMessage`;
const CHAT = "555111";
// Far-future fixed clock so the 0 ms "kick" sweep (real clock) never finds work.
const NOW = Date.parse("2031-03-03T11:00:00Z"); // 12:00 Madrid (CET)
const NIGHT = Date.parse("2031-03-03T21:00:00Z"); // 22:00 Madrid

function makeLogger() {
  const lines: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const mk = (level: string) => (obj: unknown, msg?: string) => {
    lines.push({ level, obj, msg });
  };
  return {
    lines,
    logger: { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") },
  };
}

const cancellation = {
  kind: "cancellation_done" as const,
  reservationId: 4321,
  startsAt: "2026-10-06 10:30",
  professional: "Bruno",
  service: "Corte de pelo",
  ownerName: "Ana",
  ownerSurnames: "Prueba Sintetica",
  callerPhoneE164: "+34600000001",
};

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-notifier-"));
  path = join(dir, "queue.jsonl");
});
afterEach(() => {
  nock.cleanAll();
  rmSync(dir, { recursive: true, force: true });
});

function live() {
  const { logger, lines } = makeLogger();
  const notifier = createOwnerNotifier({
    mode: "live",
    queuePath: path,
    botToken: TOKEN,
    chatId: CHAT,
    sendTimeoutMs: 2000,
    logger,
    nowMs: NOW,
  });
  if (notifier === undefined) throw new Error("notifier not created");
  return { notifier, lines, logger };
}

describe("createOwnerNotifier", () => {
  it("returns undefined for off, missing path and unwritable path (logging an error)", () => {
    const { logger, lines } = makeLogger();
    const base = { sendTimeoutMs: 1000, logger, botToken: TOKEN, chatId: CHAT };
    expect(createOwnerNotifier({ ...base, mode: "off", queuePath: path })).toBeUndefined();
    expect(createOwnerNotifier({ ...base, mode: "live" })).toBeUndefined();
    expect(createOwnerNotifier({ ...base, mode: "live", queuePath: "" })).toBeUndefined();
    expect(lines).toHaveLength(0);

    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(createOwnerNotifier({ ...base, mode: "live", queuePath: join(blocker, "q.jsonl") })).toBeUndefined();
    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toContain("owner notifications DISABLED for this process");
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it("live without token or chat id is disabled", () => {
    const { logger, lines } = makeLogger();
    expect(
      createOwnerNotifier({ mode: "live", queuePath: path, sendTimeoutMs: 1000, logger, chatId: CHAT }),
    ).toBeUndefined();
    expect(lines.some((l) => l.level === "error")).toBe(true);
  });
});

describe("OwnerNotifier worker", () => {
  it("live: enqueue -> drain -> sent with providerMessageId", async () => {
    const { notifier } = live();
    let body: Record<string, unknown> | undefined;
    nock(TELEGRAM_API_BASE_URL)
      .post(SEND_PATH, (b: Record<string, unknown>) => {
        body = b;
        return true;
      })
      .reply(200, { ok: true, result: { message_id: 42 } });

    expect(notifier.enqueueCancellation(cancellation, NOW)).toBe(true);
    await notifier.drain(NOW);

    const stored = notifier.queue.get("cancellation_done:4321")!;
    expect(stored).toMatchObject({ status: "sent", providerMessageId: 42, attempts: 1 });
    expect(body).toMatchObject({ chat_id: CHAT, disable_notification: false });
    expect(nock.isDone()).toBe(true);
    await notifier.stop();
  });

  it("dry_run: sent_dry_run, no network, no text in logs", async () => {
    const { logger, lines } = makeLogger();
    const notifier = createOwnerNotifier({
      mode: "dry_run",
      queuePath: path,
      sendTimeoutMs: 1000,
      logger,
      nowMs: NOW,
    })!;
    expect(notifier.mode).toBe("dry_run");
    notifier.enqueueCancellation(cancellation, NOW);
    await notifier.drain(NOW);
    expect(notifier.queue.get("cancellation_done:4321")).toMatchObject({ status: "sent_dry_run" });
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain("600 000 001");
    expect(logged).not.toContain("600000001");
    expect(logged).not.toContain("Ana");
    await notifier.stop();
  });

  it("backoff: 500 -> pending now+30s; 8th failure -> failed", async () => {
    const { notifier } = live();
    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).times(OWNER_MAX_ATTEMPTS).reply(500, { ok: false });
    notifier.enqueueCancellation(cancellation, NOW);

    let t = NOW;
    await notifier.drain(t);
    let stored = notifier.queue.get("cancellation_done:4321")!;
    expect(stored).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: NOW + 30_000 });

    // Not due yet: nothing happens.
    await notifier.drain(NOW + 29_000);
    expect(notifier.queue.get("cancellation_done:4321")!.attempts).toBe(1);

    for (let i = 1; i < OWNER_MAX_ATTEMPTS; i++) {
      t = notifier.queue.get("cancellation_done:4321")!.nextAttemptAt;
      await notifier.drain(t);
    }
    stored = notifier.queue.get("cancellation_done:4321")!;
    expect(stored).toMatchObject({ status: "failed", attempts: OWNER_MAX_ATTEMPTS });
    expect(OWNER_BACKOFF_MS).toHaveLength(8);
    await notifier.stop();
  });

  it("429 honours retry_after when larger than the backoff", async () => {
    const { notifier } = live();
    nock(TELEGRAM_API_BASE_URL)
      .post(SEND_PATH)
      .reply(429, { ok: false, parameters: { retry_after: 300 } });
    notifier.enqueueCancellation(cancellation, NOW);
    await notifier.drain(NOW);
    expect(notifier.queue.get("cancellation_done:4321")).toMatchObject({
      status: "pending",
      nextAttemptAt: NOW + 300_000,
    });
    await notifier.stop();
  });

  it("400 -> failed without retry", async () => {
    const { notifier } = live();
    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).reply(400, { ok: false, description: "chat not found" });
    notifier.enqueueCancellation(cancellation, NOW);
    await notifier.drain(NOW);
    expect(notifier.queue.get("cancellation_done:4321")).toMatchObject({ status: "failed", attempts: 1 });
    await notifier.stop();
  });

  it("quiet hours: 22:00 Madrid is silent, 12:00 is not", async () => {
    const { notifier } = live();
    const bodies: Array<Record<string, unknown>> = [];
    nock(TELEGRAM_API_BASE_URL)
      .post(SEND_PATH, (b: Record<string, unknown>) => {
        bodies.push(b);
        return true;
      })
      .times(2)
      .reply(200, { ok: true, result: { message_id: 1 } });

    notifier.enqueueCancellation({ ...cancellation, reservationId: 1 }, NIGHT);
    await notifier.drain(NIGHT);
    notifier.enqueueCancellation({ ...cancellation, reservationId: 2 }, NOW);
    await notifier.drain(NOW);

    expect(bodies[0]!.disable_notification).toBe(true);
    expect(bodies[1]!.disable_notification).toBe(false);
    await notifier.stop();
  });

  it("job keys deduplicate and are deterministic", () => {
    const { notifier } = live();
    expect(notifier.enqueueCancellation(cancellation, NOW)).toBe(true);
    expect(notifier.enqueueCancellation(cancellation, NOW + 1)).toBe(true);
    const req = { ...cancellation, kind: "cancellation_request" as const, motive: "too_late" as const };
    notifier.enqueueCancellation(req, NOW);
    notifier.enqueueCancellation({ ...req, motive: "technical" }, NOW);
    const alert = { conversationId: "conv_1", reason: "wants_human", summary: "quiere hablar", callerFormat: "es_phone", callerPhoneE164: "+34600000001" };
    notifier.enqueueOwnerAlert(alert, NOW);
    notifier.enqueueOwnerAlert(alert, NOW + 5);
    notifier.enqueueOwnerAlert({ ...alert, summary: "otra cosa" }, NOW);
    const ids = notifier.queue.all().map((j) => j.id).sort();
    expect(ids).toHaveLength(5);
    expect(ids).toContain("cancellation_done:4321");
    expect(ids).toContain("cancellation_request:4321:too_late");
    expect(ids).toContain("cancellation_request:4321:technical");
    expect(ids.filter((i) => /^owner_alert:conv_1:[0-9a-f]{12}$/.test(i))).toHaveLength(2);
  });

  it("exact message texts for the three kinds", () => {
    const { notifier } = live();
    notifier.enqueueCancellation(cancellation, NOW);
    notifier.enqueueCancellation(
      { ...cancellation, kind: "cancellation_request", motive: "too_late", dryRun: true, service: null },
      NOW,
    );
    notifier.enqueueOwnerAlert(
      {
        conversationId: "conv_9",
        reason: "wants_human",
        summary: "Quiere hablar con Bruno",
        callerFormat: "es_phone",
        callerPhoneE164: "+34600000001",
        customerName: "Ana",
      },
      NOW,
    );
    notifier.enqueueOwnerAlert(
      {
        conversationId: "conv_10",
        reason: "complaint",
        summary: "Se queja",
        callerFormat: "bsuid",
        callbackPhone: "611 22 33 44",
      },
      NOW,
    );

    const texts = Object.fromEntries(notifier.queue.all().map((j) => [j.id.split(":").slice(0, 3).join(":"), j.text]));
    expect(texts["cancellation_done:4321"]).toBe(
      "ANULADA por WhatsApp\nmartes 6 de octubre 10:30 · Bruno · Corte de pelo\nCliente: Ana Prueba Sintetica · +34 600 000 001\nEse hueco queda libre.",
    );
    expect(texts["cancellation_request:4321:too_late"]).toBe(
      "[PRUEBA] Quiere ANULAR (no anulada: fuera de plazo, falta muy poco para la cita)\nmartes 6 de octubre 10:30 · Bruno\nCliente: Ana Prueba Sintetica · +34 600 000 001\nAnúlala tú en el panel si procede.",
    );
    const alerts = notifier.queue.all().filter((j) => j.kind === "owner_alert");
    expect(alerts.find((j) => j.id.startsWith("owner_alert:conv_9"))!.text).toBe(
      "Aviso del WhatsApp: el cliente quiere hablar con una persona\nQuiere hablar con Bruno\nCliente: Ana · +34 600 000 001\nConversación: conv_9",
    );
    expect(alerts.find((j) => j.id.startsWith("owner_alert:conv_10"))!.text).toBe(
      "Aviso del WhatsApp: queja\nSe queja\nCliente: sin nombre · sin número de WhatsApp visible\nTeléfono que da el cliente (no verificado): 611 22 33 44\nConversación: conv_10",
    );
  });

  it("formats phones and truncates to 3500 characters", () => {
    expect(formatPhoneForOwner("+34600111222")).toBe("+34 600 111 222");
    expect(formatPhoneForOwner("600111222")).toBe("+34 600 111 222");
    const { notifier } = live();
    notifier.enqueueOwnerAlert(
      { conversationId: "c", reason: "other", summary: "x".repeat(10_000), callerFormat: "missing" },
      NOW,
    );
    expect(notifier.queue.all()[0]!.text).toHaveLength(3_500);
  });

  it("enqueue never throws even if the store throws (returns false)", () => {
    const { logger, lines } = makeLogger();
    const throwing: OwnerNotifyQueueStore = {
      enqueue: () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
      update: () => {},
      due: () => [],
      get: () => undefined,
      all: () => [],
    };
    const notifier = new OwnerNotifier({ mode: "live", chatId: CHAT }, throwing, undefined, logger);
    expect(notifier.enqueueCancellation(cancellation, NOW)).toBe(false);
    expect(
      notifier.enqueueOwnerAlert({ reason: "other", summary: "s", callerFormat: "missing" }, NOW),
    ).toBe(false);
    expect(lines.filter((l) => l.level === "error")).toHaveLength(2);
  });

  it("a failing store.update during a sweep does not throw", async () => {
    const { logger } = makeLogger();
    const real = new FileOwnerNotifyQueueStore(path, NOW);
    const store: OwnerNotifyQueueStore = {
      enqueue: (j) => real.enqueue(j),
      update: vi.fn(() => {
        throw new Error("boom");
      }),
      due: (n) => real.due(n),
      get: (i) => real.get(i),
      all: () => real.all(),
    };
    const notifier = new OwnerNotifier(
      { mode: "live", chatId: CHAT },
      store,
      new TelegramClient({ botToken: TOKEN, sendTimeoutMs: 1000 }),
      logger,
    );
    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).reply(200, { ok: true, result: { message_id: 3 } });
    notifier.enqueueCancellation(cancellation, NOW);
    await expect(notifier.drain(NOW)).resolves.toBeUndefined();
    await notifier.stop();
  });
});
