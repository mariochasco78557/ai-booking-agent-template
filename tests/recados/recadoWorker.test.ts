import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nock from "nock";

import { createOwnerNotifier } from "../../src/services/ownerNotify/ownerNotifier.js";
import type { TelegramClient } from "../../src/services/ownerNotify/telegramClient.js";
import { TELEGRAM_API_BASE_URL } from "../../src/services/ownerNotify/telegramClient.js";
import type { OpeningGatePort } from "../../src/services/recados/openingHoursGate.js";
import * as M from "../../src/services/recados/recadoMessages.js";
import { FileRecadoStore } from "../../src/services/recados/recadoStore.js";
import { RECADO_DIGEST_WAIT_MS, RECADO_MAX_ATTEMPTS, RecadoWorker } from "../../src/services/recados/recadoWorker.js";
import { at, CHAT, fixedGate, makeLogger, MON, recado, SAT, SUN, TOKEN, TUE, WED } from "./helpers.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recados-worker-"));
  path = join(dir, "recados.jsonl");
});
afterEach(() => {
  nock.cleanAll();
  rmSync(dir, { recursive: true, force: true });
});

// Sábado 09:00–14:00, martes y miércoles 09:30–20:00; domingo y lunes cerrado.
const gate = fixedGate({ [SAT]: [540, 840], [TUE]: [570, 1200], [WED]: [570, 1200] });
const alwaysOpen: OpeningGatePort = {
  isOpenAt: () => true,
  windowFor: (date) => ({ date, open: true, startMin: 0, endMin: 1440, source: "agenda" }),
  openMinutesBetween: (a, b) => Math.floor((b - a) / 60_000),
};

type SendInput = Parameters<TelegramClient["sendMessage"]>[0];
type SendResult = Awaited<ReturnType<TelegramClient["sendMessage"]>>;

function fakeClient(script: Array<SendResult> = []) {
  const calls: SendInput[] = [];
  let next = 1000;
  const client = {
    sendMessage: vi.fn(async (input: SendInput): Promise<SendResult> => {
      calls.push(input);
      return script.shift() ?? { ok: true, messageId: ++next };
    }),
  };
  return { client: client as unknown as TelegramClient, calls };
}

const CFG = {
  mode: "live" as const,
  chatId: CHAT,
  reminderOpenMinutes: 45,
  summaryBeforeCloseMinutes: 10,
  voceroUrlTemplate: "https://w.example.com",
};

function build(opts: { client?: TelegramClient; gate?: OpeningGatePort; mode?: "live" | "dry_run"; now?: number } = {}) {
  const { logger, lines } = makeLogger();
  const store = new FileRecadoStore(path, opts.now ?? at(SAT, "12:00"));
  const worker = new RecadoWorker({ ...CFG, mode: opts.mode ?? "live" }, store, opts.gate ?? gate, opts.client, logger);
  return { worker, store, lines };
}

const held = (id: string, createdAt: number, summary = id) =>
  recado({ id, dedupeKey: `voz:${id}`, createdAt, nextAttemptAt: createdAt, delivery: "held", heldAtCreation: true, kind: "question", channel: "voice", minutesLate: null, summary, appointment: { status: "none" } });

describe("RecadoWorker", () => {
  it("32. Saturday afternoon → nothing Saturday/Sunday/Monday; Tuesday 09:30 the header and then the recado", async () => {
    const { client, calls } = fakeClient();
    const { worker, store } = build({ client });
    store.insert(held("sat000000001", at(SAT, "16:00")));
    for (const t of [at(SAT, "16:00"), at(SUN, "11:00"), at(MON, "11:00"), at(TUE, "09:29")]) await worker.drain(t);
    expect(calls).toHaveLength(0);
    await worker.drain(at(TUE, "09:30"));
    expect(calls.map((c) => c.text.split("\n")[0])).toEqual(["📋 1 recado de cuando estaba cerrado", expect.stringContaining("CONSULTA")]);
    expect(store.get("sat000000001")).toMatchObject({ delivery: "sent", messageId: 1002 });
    expect(calls[1]!.inlineKeyboard).toEqual([[{ text: M.BUTTON_DONE, callbackData: "rh:sat000000001" }]]);
    expect(calls[1]!.disableNotification).toBe(false);
  });

  it("33. three recados from when it was closed → «📋 3 recados…» and the three in order; an open one has no header", async () => {
    const { client, calls } = fakeClient();
    const { worker, store } = build({ client });
    store.insert(held("two000000002", at(SUN, "10:00"), "segundo"));
    store.insert(held("one000000001", at(SAT, "16:00"), "primero"));
    store.insert(held("thr000000003", at(MON, "10:00"), "tercero"));
    store.insert({ ...held("opn000000004", at(TUE, "09:35"), "abierto"), delivery: "pending", heldAtCreation: false });
    await worker.drain(at(TUE, "09:40"));
    expect(calls.map((c) => c.text.split("\n").find((l) => l.startsWith("«")) ?? c.text.split("\n")[0])).toEqual([
      "📋 3 recados de cuando estaba cerrado",
      "«primero»",
      "«segundo»",
      "«tercero»",
      "«abierto»",
    ]);
  });

  it("34. the header fails → no recado leaves; next pass header and recados", async () => {
    const { client, calls } = fakeClient([{ ok: false, retryable: true, error: "http_500" }]);
    const { worker, store } = build({ client });
    store.insert(held("hdr000000001", at(SAT, "16:00")));
    await worker.drain(at(TUE, "09:30"));
    expect(calls).toHaveLength(1);
    expect(store.get("hdr000000001")!.delivery).toBe("held");
    await worker.drain(at(TUE, "09:30") + 5_000);
    expect(calls).toHaveLength(3);
    expect(store.get("hdr000000001")!.delivery).toBe("sent");
  });

  it("35. restart after the header → the header is not repeated", async () => {
    const first = fakeClient([{ ok: true, messageId: 1 }, { ok: false, retryable: true, error: "http_500" }]);
    const a = build({ client: first.client });
    a.store.insert(held("rst000000001", at(SAT, "16:00")));
    await a.worker.drain(at(TUE, "09:30"));
    expect(first.calls).toHaveLength(2);
    expect(a.store.get("rst000000001")!.delivery).toBe("pending");

    const second = fakeClient();
    const b = build({ client: second.client });
    await b.worker.drain(at(TUE, "09:30") + 60_000);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.text).not.toContain("📋");
    expect(b.store.get("rst000000001")!.delivery).toBe("sent");
  });

  it("36. 429 with retry_after is honoured; 8 attempts → failed", async () => {
    const { client, calls } = fakeClient([{ ok: false, retryable: true, retryAfterMs: 600_000, error: "http_429" }]);
    const { worker, store } = build({ client, gate: alwaysOpen });
    store.insert({ ...held("rty000000001", at(TUE, "10:00")), delivery: "pending", heldAtCreation: false });
    await worker.drain(at(TUE, "10:00"));
    expect(store.get("rty000000001")).toMatchObject({ attempts: 1, nextAttemptAt: at(TUE, "10:00") + 600_000 });
    await worker.drain(at(TUE, "10:09"));
    expect(calls).toHaveLength(1);
    await worker.drain(at(TUE, "10:11"));
    expect(calls).toHaveLength(2);
    expect(store.get("rty000000001")!.delivery).toBe("sent");

    path = join(dir, "second.jsonl");
    const failing = fakeClient(Array.from({ length: 20 }, () => ({ ok: false as const, retryable: true, error: "http_500" })));
    const b = build({ client: failing.client, gate: alwaysOpen });
    b.store.insert({ ...held("bad000000001", at(TUE, "10:00")), delivery: "pending", heldAtCreation: false });
    let t = at(TUE, "10:00");
    for (let i = 0; i < RECADO_MAX_ATTEMPTS; i += 1) {
      await b.worker.drain(t);
      t += 7 * 3_600_000;
    }
    expect(failing.calls).toHaveLength(RECADO_MAX_ATTEMPTS);
    expect(b.store.get("bad000000001")).toMatchObject({ delivery: "failed", attempts: RECADO_MAX_ATTEMPTS });
  });

  it("37. enrichment wait: with the lookup pending nothing leaves before 15 s; at 15 s it leaves as «no se ha podido consultar»", async () => {
    const { client, calls } = fakeClient();
    const { worker, store } = build({ client });
    store.insert({
      ...held("enr000000001", at(TUE, "10:00")),
      delivery: "pending",
      heldAtCreation: false,
      appointment: { status: "pending" },
    });
    await worker.drain(at(TUE, "10:00") + 5_000);
    expect(calls).toHaveLength(0);
    await worker.drain(at(TUE, "10:00") + 15_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("Próxima cita: no se ha podido consultar");
  });

  it("38. reminder: sent Tue 19:40 → nothing at 20:25; Wed 09:55 (20 + 25 open minutes) → one reminder replying to the message; none if handled", async () => {
    const { client, calls } = fakeClient();
    const { worker, store } = build({ client });
    const sent = { ...held("rem000000001", at(TUE, "19:40")), delivery: "sent" as const, heldAtCreation: false, sentAt: at(TUE, "19:40"), messageId: 100 };
    store.insert(sent);
    store.insert({ ...sent, id: "rem000000002", dedupeKey: "voz:rem2", handledAt: at(TUE, "19:45"), messageId: 101 });
    await worker.drain(at(TUE, "19:41"));
    await worker.drain(at(TUE, "20:25"));
    await worker.drain(at(WED, "09:54"));
    expect(calls).toHaveLength(0);
    await worker.drain(at(WED, "09:55"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      text: M.REMINDER_TEXT,
      replyToMessageId: 100,
      inlineKeyboard: [[{ text: M.BUTTON_DONE, callbackData: "rh:rem000000001" }]],
    });
    expect(store.get("rem000000001")).toMatchObject({ remindedAt: at(WED, "09:55"), reminderMessageId: 1001 });
    await worker.drain(at(WED, "10:30"));
    expect(calls).toHaveLength(1);
  });

  it("38. a failing reminder is given up after 3 attempts", async () => {
    const { client, calls } = fakeClient(Array.from({ length: 5 }, () => ({ ok: false as const, retryable: true, error: "http_500" })));
    const { worker, store } = build({ client });
    store.insert({ ...held("rmf000000001", at(TUE, "10:00")), delivery: "sent", sentAt: at(TUE, "10:00"), messageId: 7 });
    let t = at(TUE, "11:00");
    for (let i = 0; i < 5; i += 1) {
      await worker.drain(t);
      t += 2 * 60_000;
    }
    expect(calls).toHaveLength(3);
    expect(store.get("rmf000000001")).toMatchObject({ remindedAt: expect.any(Number), reminderMessageId: null, reminderAttempts: 3 });
  });

  it("39. summary: 19:50 with two pending → one summary; with none → nothing and not evaluated again; not at 20:05", async () => {
    const { client, calls } = fakeClient();
    const { worker, store } = build({ client });
    const sent = (id: string, k: string) => ({ ...held(id, at(TUE, "10:00")), dedupeKey: k, delivery: "sent" as const, sentAt: at(TUE, "10:00"), messageId: 5, remindedAt: 1 });
    store.insert(sent("sm1000000001", "k1"));
    store.insert(sent("sm2000000002", "k2"));
    await worker.drain(at(TUE, "19:49"));
    expect(calls).toHaveLength(0);
    await worker.drain(at(TUE, "19:50"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text.split("\n")[0]).toBe("🌙 Cierre de hoy: 2 recados sin marcar");
    await worker.drain(at(TUE, "19:55"));
    expect(calls).toHaveLength(1);

    // Wednesday: everything handled → no message, but the day is marked.
    store.update({ ...store.get("sm1000000001")!, handledAt: 1 });
    store.update({ ...store.get("sm2000000002")!, handledAt: 1 });
    await worker.drain(at(WED, "19:50"));
    expect(calls).toHaveLength(1);
    expect(store.summaryDone(WED)).toBe(true);
    await worker.drain(at(WED, "19:55"));
    expect(calls).toHaveLength(1);
  });

  it("39. no summary after closing time", async () => {
    const { client, calls } = fakeClient();
    const { worker, store } = build({ client });
    store.insert({ ...held("sm3000000003", at(TUE, "10:00")), delivery: "sent", sentAt: at(TUE, "10:00"), messageId: 5, remindedAt: 1 });
    await worker.drain(at(TUE, "20:05"));
    expect(calls).toHaveLength(0);
    expect(store.summaryDone(TUE)).toBe(false);
  });

  it("39. a failing summary is retried while the salon is still open", async () => {
    const { client, calls } = fakeClient([{ ok: false, retryable: true, error: "http_500" }]);
    const { worker, store } = build({ client });
    store.insert({ ...held("sm4000000004", at(TUE, "10:00")), delivery: "sent", sentAt: at(TUE, "10:00"), messageId: 5, remindedAt: 1 });
    await worker.drain(at(TUE, "19:50"));
    expect(store.summaryDone(TUE)).toBe(false);
    await worker.drain(at(TUE, "19:55"));
    expect(calls).toHaveLength(2);
    expect(store.summaryDone(TUE)).toBe(true);
  });

  it("the CLI test notice never gets a reminder nor enters the closing summary, even after a restart", async () => {
    const { client, calls } = fakeClient();
    const a = build({ client });
    a.store.insert({ ...held("tst000000001", at(TUE, "10:00")), dedupeKey: "prueba:1", delivery: "sent", sentAt: at(TUE, "10:00"), messageId: 5 });
    await a.worker.drain(at(TUE, "11:00"));
    const b = build({ client });
    await b.worker.drain(at(TUE, "19:50"));
    expect(calls).toHaveLength(0);
    expect(b.store.summaryDone(TUE)).toBe(true);
  });

  it("40. dry_run: nothing reaches the client, the recado becomes sent_dry_run", async () => {
    const { client, calls } = fakeClient();
    const { worker, store, lines } = build({ client, mode: "dry_run" });
    store.insert(held("dry000000001", at(SAT, "16:00")));
    await worker.drain(at(TUE, "09:30"));
    expect(calls).toHaveLength(0);
    expect(store.get("dry000000001")!.delivery).toBe("sent_dry_run");
    expect(lines.some((l) => l.msg === "recados dry run: NOT sent")).toBe(true);
  });

  it("41. OwnerNotifier with the gate: a job queued on Sunday stays pending; Tuesday at opening it is sent", async () => {
    const { logger } = makeLogger();
    const notifier = createOwnerNotifier({
      mode: "live",
      queuePath: join(dir, "owner.jsonl"),
      botToken: TOKEN,
      chatId: CHAT,
      sendTimeoutMs: 2000,
      logger,
      gate,
    })!;
    notifier.enqueueCancellation(
      {
        kind: "cancellation_done",
        reservationId: 77,
        startsAt: "2026-10-14 10:30",
        professional: "Bruno",
        service: "Corte de pelo",
        ownerName: "Ana",
        ownerSurnames: "Prueba",
        callerPhoneE164: "+34600000001",
      },
      at(SUN, "23:00"),
    );
    const scope = nock(TELEGRAM_API_BASE_URL).post(`/bot${TOKEN}/sendMessage`).reply(200, { ok: true, result: { message_id: 3 } });
    await notifier.drain(at(SUN, "23:00"));
    expect(notifier.queue.get("cancellation_done:77")!.status).toBe("pending");
    expect(scope.isDone()).toBe(false);
    await notifier.drain(at(TUE, "09:30"));
    expect(notifier.queue.get("cancellation_done:77")!.status).toBe("sent");
    expect(scope.isDone()).toBe(true);
    await notifier.stop();
  });
});

describe("RecadoWorker: after the agenda digest (AVISOS_AGENDA)", () => {
  function withBarrier(client: TelegramClient, settled: { value: boolean }) {
    const { logger } = makeLogger();
    const store = new FileRecadoStore(path, at(SAT, "12:00"));
    const worker = new RecadoWorker({ ...CFG }, store, gate, client, logger, { isDigestSettled: () => settled.value });
    return { worker, store };
  }

  it("the «📋» header waits for the digest, and goes anyway after the wait", async () => {
    const { client, calls } = fakeClient();
    const settled = { value: false };
    const { worker, store } = withBarrier(client, settled);
    store.insert(held("sat000000001", at(SAT, "16:00")));
    const open = at(TUE, "09:30");
    await worker.drain(open);
    await worker.drain(open + 60_000);
    expect(calls).toHaveLength(0);
    settled.value = true;
    await worker.drain(open + 120_000);
    expect(calls.map((c) => c.text.split("\n")[0])).toEqual(["📋 1 recado de cuando estaba cerrado", expect.stringContaining("CONSULTA")]);
  });

  it("never settled: the header leaves once the wait is over", async () => {
    const { client, calls } = fakeClient();
    const { worker, store } = withBarrier(client, { value: false });
    store.insert(held("sat000000001", at(SAT, "16:00")));
    const open = at(TUE, "09:30");
    await worker.drain(open);
    expect(calls).toHaveLength(0);
    await worker.drain(open + RECADO_DIGEST_WAIT_MS + 1);
    expect(calls).toHaveLength(2);
  });
});
