import axios, { type AxiosInstance } from "axios";

/**
 * *** THE ONLY THING IN THIS PROCESS THAT TALKS TO TELEGRAM. ***
 *
 * One `POST {baseUrl}/bot{token}/sendMessage`, plain text (no `parse_mode`, so
 * nothing to escape and nothing a customer's name can break). No retries, no
 * state, no clock: it returns WHAT HAPPENED and `ownerNotifier.ts` decides what
 * to do about it (same split as `metaWhatsappClient.ts`).
 *
 * ── The token is in the URL ───────────────────────────────────────────────
 *
 * Telegram's API puts the bot token in the path. So: the request URL, the axios
 * `config` and axios' own `error.message` are NEVER logged or returned. Errors
 * are rebuilt from the HTTP status, axios' short error code and Telegram's
 * `description`, and even that is scrubbed of the token before it is returned.
 */

export type TelegramSendResult =
  | { ok: true; messageId: number }
  | { ok: false; retryable: boolean; retryAfterMs?: number; error: string };

export interface TelegramClientConfig {
  /** `TELEGRAM_BOT_TOKEN`. Never logged, never persisted, never in an error. */
  botToken: string;
  sendTimeoutMs: number;
  /** Overridable for tests; production always uses Telegram's real origin. */
  baseUrl?: string;
}

/** Exactly one of `callbackData` / `url`. */
export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface TelegramSendInput {
  chatId: string;
  text: string;
  disableNotification: boolean;
  /** Recados (2026-10-11): inline buttons under the message. */
  inlineKeyboard?: InlineButton[][];
  /** Recados: answer «in reply to» an earlier message of the same chat. */
  replyToMessageId?: number;
}

function toReplyMarkup(keyboard: InlineButton[][]): { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> } {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((b) =>
        b.url !== undefined ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData ?? "" },
      ),
    ),
  };
}

export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

const ERROR_MAX_LENGTH = 200;

function shorten(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_MAX_LENGTH ? `${flat.slice(0, ERROR_MAX_LENGTH)}…` : flat;
}

interface TelegramErrorBody {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: TelegramClientConfig) {
    this.http = axios.create({
      baseURL: (config.baseUrl ?? TELEGRAM_API_BASE_URL).replace(/\/+$/, ""),
      timeout: config.sendTimeoutMs,
      headers: { "Content-Type": "application/json" },
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  /** Removes every occurrence of the token (and its secret half) from a string. */
  private scrub(value: string): string {
    const token = this.config.botToken;
    if (token === "") return value;
    let out = value.split(token).join("[redacted]");
    const secretHalf = token.includes(":") ? token.slice(token.indexOf(":") + 1) : "";
    if (secretHalf.length >= 8) out = out.split(secretHalf).join("[redacted]");
    return out;
  }

  /**
   * The one HTTP call. Never throws; the failure is described without the URL
   * and without the token (see the header of this file).
   */
  private async request(
    method: string,
    body: Record<string, unknown>,
  ): Promise<
    | { ok: true; result: unknown }
    | { ok: false; retryable: boolean; retryAfterMs?: number; error: string; status?: number; description?: string }
  > {
    try {
      const response = await this.http.post<{ ok?: boolean; result?: unknown }>(
        `/bot${this.config.botToken}/${method}`,
        body,
      );
      return { ok: true, result: response.data?.result };
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        // Deliberately NOT String(error): it could embed the request URL.
        return { ok: false, retryable: false, error: "unexpected_client_error" };
      }
      const status = error.response?.status;
      if (status === undefined) {
        return {
          ok: false,
          retryable: true,
          error: shorten(`no_response ${error.code ?? "network_error"}`),
        };
      }
      const data = error.response?.data as TelegramErrorBody | undefined;
      const parts = [`http_${status}`];
      const description = typeof data?.description === "string" ? data.description : "";
      if (description !== "") parts.push(`: ${description}`);
      const error_ = shorten(this.scrub(parts.join(" ")));

      if (status === 429) {
        const retryAfter = data?.parameters?.retry_after;
        return {
          ok: false,
          retryable: true,
          ...(typeof retryAfter === "number" && retryAfter > 0
            ? { retryAfterMs: retryAfter * 1000 }
            : {}),
          error: error_,
          status,
          description,
        };
      }
      return { ok: false, retryable: status >= 500, error: error_, status, description };
    }
  }

  /**
   * Sends one text message. Never throws: every failure comes back as
   * `{ ok: false }` — the caller is a background worker.
   */
  async sendMessage(input: TelegramSendInput): Promise<TelegramSendResult> {
    const body: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
      disable_notification: input.disableNotification,
      link_preview_options: { is_disabled: true },
    };
    if (input.inlineKeyboard !== undefined) body.reply_markup = toReplyMarkup(input.inlineKeyboard);
    if (input.replyToMessageId !== undefined) {
      body.reply_parameters = { message_id: input.replyToMessageId, allow_sending_without_reply: true };
    }

    const r = await this.request("sendMessage", body);
    if (!r.ok) return stripExtra(r);
    const messageId = (r.result as { message_id?: number } | undefined)?.message_id;
    if (typeof messageId !== "number") {
      // No evidence the message exists; re-sending risks a duplicate.
      return { ok: false, retryable: false, error: "accepted_without_message_id" };
    }
    return { ok: true, messageId };
  }

  /**
   * Edits the text (and the buttons) of a message already sent. Without
   * `inlineKeyboard` the buttons are removed. «message is not modified» is a
   * success: the message already says what we wanted.
   */
  async editMessageText(i: {
    chatId: string;
    messageId: number;
    text: string;
    inlineKeyboard?: InlineButton[][];
  }): Promise<TelegramSendResult> {
    const r = await this.request("editMessageText", {
      chat_id: i.chatId,
      message_id: i.messageId,
      text: i.text,
      link_preview_options: { is_disabled: true },
      reply_markup: toReplyMarkup(i.inlineKeyboard ?? []),
    });
    if (r.ok) return { ok: true, messageId: i.messageId };
    if (r.status === 400 && /message is not modified/i.test(r.description ?? "")) {
      return { ok: true, messageId: i.messageId };
    }
    return stripExtra(r);
  }

  async answerCallbackQuery(i: { callbackQueryId: string; text?: string }): Promise<{ ok: boolean; error?: string }> {
    const r = await this.request("answerCallbackQuery", {
      callback_query_id: i.callbackQueryId,
      ...(i.text !== undefined ? { text: i.text } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** Operator CLI only (`src/cli/recadosTelegram.ts`). */
  async callMethod(
    method: "getMe" | "getWebhookInfo" | "setWebhook" | "deleteWebhook",
    body: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const r = await this.request(method, body);
    return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
  }
}

function stripExtra(r: {
  retryable: boolean;
  retryAfterMs?: number;
  error: string;
}): { ok: false; retryable: boolean; retryAfterMs?: number; error: string } {
  return {
    ok: false,
    retryable: r.retryable,
    ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}),
    error: r.error,
  };
}
