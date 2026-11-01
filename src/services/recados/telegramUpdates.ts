import type { Logger } from "../authTokenService.js";
import type { TelegramClient } from "../ownerNotify/telegramClient.js";
import {
  CALLBACK_PREFIX,
  CB_ANSWER_ALREADY,
  CB_ANSWER_DONE,
  CB_ANSWER_GONE,
  formatRecadoMessage,
  handledLine,
  handledText,
  recadoKeyboard,
  START_REPLY,
} from "./recadoMessages.js";
import type { RecadoStore } from "./recadoStore.js";

/**
 * *** WHAT TELEGRAM TELLS US (webhook) ***: the ✅ button and `/start`.
 * (internal doc, not included in the template) §A.10. `handle` never throws. A callback from
 * a chat that is not the configured one is ignored without a word. Ids of
 * chats, messages and recados never reach a log line.
 */

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const RECADOS_WEBHOOK_PATH = "/telegram/recados";
export const RECADO_VOICE_PATH = "/ai/voice/v2/recado";
export const RECADO_WA_PATH = "/ai/wa/recado";

const SEEN_UPDATES_MAX = 500;
const START_PER_CHAT_MS = 60_000;
const START_GLOBAL_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const CALLBACK_RE = new RegExp(`^${CALLBACK_PREFIX}([0-9a-f]{12})$`);

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class TelegramUpdates {
  private readonly seen: number[] = [];
  private readonly startByChat = new Map<string, number>();
  private startTimes: number[] = [];

  constructor(
    private readonly cfg: { chatId: string; voceroUrlTemplate: string },
    private readonly store: RecadoStore,
    private readonly client: TelegramClient,
    private readonly logger: Logger,
  ) {}

  async handle(update: unknown, nowMs: number): Promise<void> {
    try {
      const u = asRecord(update);
      if (u === undefined) return;
      const updateId = u.update_id;
      if (typeof updateId === "number") {
        if (this.seen.includes(updateId)) return;
        this.seen.push(updateId);
        if (this.seen.length > SEEN_UPDATES_MAX) this.seen.shift();
      }
      const callback = asRecord(u.callback_query);
      if (callback !== undefined) {
        await this.onCallback(callback, nowMs);
        return;
      }
      const message = asRecord(u.message);
      if (message !== undefined) await this.onMessage(message, nowMs);
    } catch (error) {
      this.logger.error({ reason: errorLabel(error) }, "recados: webhook update failed");
    }
  }

  private async onCallback(cb: Record<string, unknown>, nowMs: number): Promise<void> {
    const message = asRecord(cb.message);
    const chatId = asRecord(message?.chat)?.id;
    if (typeof chatId !== "number" && typeof chatId !== "string") return;
    if (String(chatId) !== this.cfg.chatId) {
      this.logger.warn({}, "recados: callback from another chat ignored");
      return;
    }
    const callbackQueryId = cb.id;
    const data = cb.data;
    if (typeof callbackQueryId !== "string" || typeof data !== "string") return;
    const match = CALLBACK_RE.exec(data);
    if (match === null) return;

    const recado = this.store.get(match[1]!);
    if (recado === undefined) {
      await this.client.answerCallbackQuery({ callbackQueryId, text: CB_ANSWER_GONE });
      return;
    }
    if (recado.handledAt !== null) {
      await this.client.answerCallbackQuery({ callbackQueryId, text: CB_ANSWER_ALREADY });
      return;
    }

    // Persisted BEFORE touching Telegram: the recado is handled even if the edit fails.
    const handled = { ...recado, handledAt: nowMs };
    try {
      this.store.update(handled);
    } catch (error) {
      this.logger.error({ reason: errorLabel(error) }, "recados: the ✅ could not be recorded");
      return;
    }

    if (recado.messageId !== null) {
      const edited = await this.client.editMessageText({
        chatId: this.cfg.chatId,
        messageId: recado.messageId,
        text: handledText(formatRecadoMessage(recado, recado.sentAt ?? nowMs), nowMs),
        inlineKeyboard: recadoKeyboard(handled, this.cfg.voceroUrlTemplate, true),
      });
      if (!edited.ok) this.logger.warn({ reason: edited.error }, "recados: could not edit the handled message");
    }
    if (recado.reminderMessageId !== null) {
      const edited = await this.client.editMessageText({
        chatId: this.cfg.chatId,
        messageId: recado.reminderMessageId,
        text: handledLine(nowMs),
      });
      if (!edited.ok) this.logger.warn({ reason: edited.error }, "recados: could not edit the handled reminder");
    }
    await this.client.answerCallbackQuery({ callbackQueryId, text: CB_ANSWER_DONE });
  }

  private async onMessage(message: Record<string, unknown>, nowMs: number): Promise<void> {
    const text = message.text;
    if (typeof text !== "string" || !(text === "/start" || text.startsWith("/start "))) return;
    const chatId = asRecord(message.chat)?.id;
    if (typeof chatId !== "number" && typeof chatId !== "string") return;
    const key = String(chatId);

    this.startTimes = this.startTimes.filter((t) => nowMs - t < HOUR_MS);
    const last = this.startByChat.get(key);
    if (last !== undefined && nowMs - last < START_PER_CHAT_MS) return;
    if (this.startTimes.length >= START_GLOBAL_PER_HOUR) return;
    this.startByChat.set(key, nowMs);
    this.startTimes.push(nowMs);
    if (this.startByChat.size > 200) {
      for (const [k, t] of this.startByChat) if (nowMs - t >= START_PER_CHAT_MS) this.startByChat.delete(k);
    }

    const sent = await this.client.sendMessage({
      chatId: key,
      text: START_REPLY(key),
      disableNotification: false,
    });
    if (!sent.ok) this.logger.warn({ reason: sent.error }, "recados: /start reply failed");
  }
}
