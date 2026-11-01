import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";

import { TELEGRAM_API_BASE_URL, TelegramClient } from "../src/services/ownerNotify/telegramClient.js";

const TOKEN = "1234567890:AAFakeTokenForTestsOnly_0123456789abcdefgh";
const SEND_PATH = `/bot${TOKEN}/sendMessage`;

function client(timeoutMs = 2000): TelegramClient {
  return new TelegramClient({ botToken: TOKEN, sendTimeoutMs: timeoutMs });
}

const input = { chatId: "123456", text: "hola", disableNotification: false };

afterEach(() => {
  nock.cleanAll();
});

describe("TelegramClient", () => {
  it("sends plain text without parse_mode and passes disable_notification", async () => {
    let seen: Record<string, unknown> | undefined;
    nock(TELEGRAM_API_BASE_URL)
      .post(SEND_PATH, (body: Record<string, unknown>) => {
        seen = body;
        return true;
      })
      .reply(200, { ok: true, result: { message_id: 7 } });

    const result = await client().sendMessage({ ...input, disableNotification: true });

    expect(result).toEqual({ ok: true, messageId: 7 });
    expect(seen).toEqual({
      chat_id: "123456",
      text: "hola",
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    });
    expect(seen).not.toHaveProperty("parse_mode");
  });

  it("429 is retryable and honours retry_after", async () => {
    nock(TELEGRAM_API_BASE_URL)
      .post(SEND_PATH)
      .reply(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 12 } });
    const result = await client().sendMessage(input);
    expect(result).toMatchObject({ ok: false, retryable: true, retryAfterMs: 12_000 });
  });

  it("5xx is retryable", async () => {
    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).reply(500, { ok: false });
    const result = await client().sendMessage(input);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("timeout / network failure is retryable", async () => {
    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).delayConnection(300).reply(200, { ok: true, result: { message_id: 1 } });
    const timedOut = await client(50).sendMessage(input);
    expect(timedOut).toMatchObject({ ok: false, retryable: true });

    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).replyWithError({ code: "ECONNRESET", message: "boom" });
    const reset = await client().sendMessage(input);
    expect(reset).toMatchObject({ ok: false, retryable: true });
  });

  it.each([400, 401, 403, 404])("%i is not retryable", async (status) => {
    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).reply(status, { ok: false, description: "nope" });
    const result = await client().sendMessage(input);
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it("a 2xx without message_id is not retried", async () => {
    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).reply(200, { ok: true });
    const result = await client().sendMessage(input);
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it("never leaks the token in an error, even if Telegram echoes it", async () => {
    nock(TELEGRAM_API_BASE_URL)
      .post(SEND_PATH)
      .reply(401, { ok: false, description: `Unauthorized ${TOKEN} bot ${TOKEN.split(":")[1]}` });
    const unauthorized = await client().sendMessage(input);

    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).replyWithError({ code: "ECONNRESET", message: `reset at ${SEND_PATH}` });
    const reset = await client().sendMessage(input);

    nock(TELEGRAM_API_BASE_URL).post(SEND_PATH).delayConnection(300).reply(200, {});
    const timeout = await client(50).sendMessage(input);

    for (const result of [unauthorized, reset, timeout]) {
      expect(result.ok).toBe(false);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(TOKEN.split(":")[1]!);
    }
  });
});

describe("TelegramClient — recados additions", () => {
  it("sends reply_markup (callback and url buttons) and reply_parameters", async () => {
    let seen: Record<string, unknown> | undefined;
    nock(TELEGRAM_API_BASE_URL)
      .post(SEND_PATH, (body: Record<string, unknown>) => {
        seen = body;
        return true;
      })
      .reply(200, { ok: true, result: { message_id: 8 } });
    await client().sendMessage({
      ...input,
      replyToMessageId: 5,
      inlineKeyboard: [[{ text: "ok", callbackData: "rh:abc" }], [{ text: "abrir", url: "https://x.example.com" }]],
    });
    expect(seen!.reply_markup).toEqual({
      inline_keyboard: [[{ text: "ok", callback_data: "rh:abc" }], [{ text: "abrir", url: "https://x.example.com" }]],
    });
    expect(seen!.reply_parameters).toEqual({ message_id: 5, allow_sending_without_reply: true });
  });

  it("editMessageText: no keyboard clears it; «message is not modified» is ok", async () => {
    let seen: Record<string, unknown> | undefined;
    nock(TELEGRAM_API_BASE_URL)
      .post(`/bot${TOKEN}/editMessageText`, (body: Record<string, unknown>) => {
        seen = body;
        return true;
      })
      .reply(400, { ok: false, description: "Bad Request: message is not modified" });
    const r = await client().editMessageText({ chatId: "1", messageId: 9, text: "t" });
    expect(r).toEqual({ ok: true, messageId: 9 });
    expect(seen!.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("answerCallbackQuery works and errors never contain the token", async () => {
    nock(TELEGRAM_API_BASE_URL).post(`/bot${TOKEN}/answerCallbackQuery`).reply(200, { ok: true, result: true });
    expect(await client().answerCallbackQuery({ callbackQueryId: "q", text: "hi" })).toEqual({ ok: true });
    nock(TELEGRAM_API_BASE_URL)
      .post(`/bot${TOKEN}/answerCallbackQuery`)
      .reply(400, { ok: false, description: `bad ${TOKEN}` });
    const bad = await client().answerCallbackQuery({ callbackQueryId: "q" });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
    nock(TELEGRAM_API_BASE_URL).post(`/bot${TOKEN}/getMe`).reply(200, { ok: true, result: { username: "u" } });
    expect(await client().callMethod("getMe", {})).toEqual({ ok: true, result: { username: "u" } });
  });
});
