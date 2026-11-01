import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import nock from "nock";

import { buildTestApp, WEBHOOK_SECRET } from "../helpers/testApp.js";
import { TELEGRAM_API_BASE_URL } from "../../src/services/ownerNotify/telegramClient.js";
import * as M from "../../src/services/recados/recadoMessages.js";
import { FileRecadoStore } from "../../src/services/recados/recadoStore.js";
import { recadosEnv, TG_SECRET } from "./appEnv.js";
import { at, CHAT, recado, TOKEN, TUE } from "./helpers.js";

let app: FastifyInstance | undefined;
let stateDir: string;

const sent = (over = {}) =>
  recado({ delivery: "sent", messageId: 42, sentAt: at(TUE, "10:42"), appointment: { status: "none" }, ...over });

function seed(...recados: ReturnType<typeof recado>[]): void {
  const store = new FileRecadoStore(join(stateDir, "recados.jsonl"), at(TUE, "10:00"));
  for (const r of recados) store.insert(r);
}

async function start(): Promise<FastifyInstance> {
  app = await buildTestApp();
  return app;
}

function callback(over: Record<string, unknown> = {}, chat: number | string = Number(CHAT)) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: { id: "cbq-1", data: "rh:aaaaaaaaaaaa", message: { message_id: 42, chat: { id: chat } }, ...over },
  };
}

function post(update: unknown, headers: Record<string, string> = { "x-telegram-bot-api-secret-token": TG_SECRET }) {
  return app!.inject({ method: "POST", url: "/telegram/recados", headers, payload: update as never });
}

/** Records the bodies Telegram receives for a method. */
function spy(method: string, times = 1): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  nock(TELEGRAM_API_BASE_URL)
    .post(`/bot${TOKEN}/${method}`, (body: Record<string, unknown>) => {
      bodies.push(body);
      return true;
    })
    .times(times)
    .reply(200, { ok: true, result: { message_id: 900 } });
  return bodies;
}

beforeEach(() => {
  nock.cleanAll();
  stateDir = recadosEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(TUE, "10:47"));
});
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
  nock.cleanAll();
  rmSync(dirname(stateDir), { recursive: true, force: true });
});

const reload = (id = "aaaaaaaaaaaa") => new FileRecadoStore(join(stateDir, "recados.jsonl"), at(TUE, "11:00")).get(id);

describe("POST /telegram/recados", () => {
  it("42. wrong secret_token → 401, no effects; missing header → 401", async () => {
    seed(sent());
    await start();
    const edit = spy("editMessageText");
    const bad = await post(callback(), { "x-telegram-bot-api-secret-token": "x".repeat(40) });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toBe("");
    expect((await post(callback(), {})).statusCode).toBe(401);
    expect(edit).toHaveLength(0);
    expect(reload()!.handledAt).toBeNull();
  });

  it("43. callback from another chat → 200, not marked, no answerCallbackQuery nor editMessageText", async () => {
    seed(sent());
    await start();
    const edit = spy("editMessageText");
    const answer = spy("answerCallbackQuery");
    const res = await post(callback({}, 999));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(edit).toHaveLength(0);
    expect(answer).toHaveLength(0);
    expect(reload()!.handledAt).toBeNull();
  });

  it("44. correct callback: handledAt persisted; «✅ Atendido a las 10:47» on top; voice keyboard empty; answers", async () => {
    seed(sent());
    await start();
    const edit = spy("editMessageText");
    const answer = spy("answerCallbackQuery");
    expect((await post(callback())).statusCode).toBe(200);
    expect(reload()!.handledAt).toBe(at(TUE, "10:47"));
    expect(edit).toHaveLength(1);
    expect(edit[0]).toMatchObject({ chat_id: CHAT, message_id: 42, reply_markup: { inline_keyboard: [] } });
    expect(String(edit[0]!.text).split("\n")[0]).toBe("✅ Atendido a las 10:47");
    expect(String(edit[0]!.text)).toContain("Cliente: Ana · +34 600 111 222");
    expect(answer[0]).toMatchObject({ callback_query_id: "cbq-1", text: "Marcado como atendido." });
  });

  it("44. WhatsApp keeps only «Abrir conversación»; with a reminder, the reminder is edited too", async () => {
    seed(sent({ channel: "whatsapp", reminderMessageId: 43, remindedAt: at(TUE, "10:46") }));
    await start();
    const edit = spy("editMessageText", 2);
    spy("answerCallbackQuery");
    await post(callback());
    expect(edit).toHaveLength(2);
    expect(edit[0]!.reply_markup).toEqual({ inline_keyboard: [[{ text: M.BUTTON_OPEN, url: "https://whatsapp.booking.example.com" }]] });
    expect(edit[1]).toMatchObject({ message_id: 43, text: "✅ Atendido a las 10:47", reply_markup: { inline_keyboard: [] } });
  });

  it("44. an edit that fails still leaves the recado handled", async () => {
    seed(sent());
    await start();
    nock(TELEGRAM_API_BASE_URL).post(`/bot${TOKEN}/editMessageText`).reply(500, { ok: false, description: "boom" });
    spy("answerCallbackQuery");
    await post(callback());
    expect(reload()!.handledAt).toBe(at(TUE, "10:47"));
  });

  it("45. second press → «Ya estaba marcado.»; repeated update_id ignored; malformed data ignored; unknown recado → gone", async () => {
    seed(sent());
    await start();
    spy("editMessageText");
    const answer = spy("answerCallbackQuery", 3);
    await post(callback());
    await post(callback());
    expect(answer.map((b) => b.text)).toEqual([M.CB_ANSWER_DONE, M.CB_ANSWER_ALREADY]);

    const repeated = callback({ id: "cbq-9" });
    await post(repeated);
    await post(repeated);
    expect(answer).toHaveLength(3);

    await post(callback({ data: "rh:zzzz" }));
    await post(callback({ data: "other" }));
    expect(answer).toHaveLength(3);

    nock.cleanAll();
    const gone = spy("answerCallbackQuery");
    await post(callback({ data: "rh:bbbbbbbbbbbb", id: "cbq-gone" }));
    expect(gone[0]).toMatchObject({ text: M.CB_ANSWER_GONE });
  });

  it("46. /start from any chat → START_REPLY with its id; a second /start in the same minute gets no answer", async () => {
    await start();
    const send = spy("sendMessage", 2);
    const start1 = { update_id: 1, message: { text: "/start", chat: { id: 123456 } } };
    expect((await post(start1)).statusCode).toBe(200);
    await post({ update_id: 2, message: { text: "/start", chat: { id: 123456 } } });
    await post({ update_id: 3, message: { text: "hola", chat: { id: 777 } } });
    expect(send).toHaveLength(1);
    expect(send[0]).toMatchObject({ chat_id: "123456", text: M.START_REPLY("123456") });
    await post({ update_id: 4, message: { text: "/start", chat: { id: 888 } } });
    expect(send).toHaveLength(2);
  });
});

describe("dry_run", () => {
  it("47. RECADOS_MODE=dry_run → /telegram/recados is a 404", async () => {
    stateDir = recadosEnv({ RECADOS_MODE: "dry_run" });
    await start();
    const res = await post({ update_id: 1 });
    expect(res.statusCode).toBe(404);
  });
});

void WEBHOOK_SECRET;
