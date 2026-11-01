/**
 * Client for Vocero's service API (`/api/bot/*`).
 *
 * The brain never holds the WhatsApp token: every outgoing message goes out
 * THROUGH Vocero, so it lands in the inbox marked as AI, respects the 24 h
 * window and stops the moment a human takes the conversation (409 ai_paused).
 */
import { errorCode, requestJson, type FetchLike } from "./http.js";
import type { InteractiveMessage } from "./interactive.js";
import type { Logger } from "./log.js";

export interface ConversationContext {
  conversationId: string;
  contactName: string | null;
  aiEnabled: boolean;
  windowOpen: boolean;
  /**
   * The ficha fields about past cancellations and late notices that are still
   * inside the history window (`BRAIN_HISTORY_DAYS`). Older ones are dropped.
   * Internal: never shown to the customer.
   */
  ficha?: Record<string, unknown>;
}

/** Groups of ficha keys that share one timestamp key. */
const DATED_FICHA_GROUPS: ReadonlyArray<{ stamp: string; keys: readonly string[] }> = [
  {
    stamp: "ultima_anulacion_fecha",
    keys: ["ultima_anulacion", "ultima_anulacion_aviso_min", "ultima_anulacion_tardia", "ultima_anulacion_fecha"],
  },
  { stamp: "ultimo_aviso_retraso", keys: ["ultimo_aviso_retraso", "ultimo_aviso_retraso_min"] },
];

/** Keeps only the cancellation / late-notice fields younger than `maxAgeDays`. */
export function recentFicha(ficha: unknown, nowMs: number, maxAgeDays: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!ficha || typeof ficha !== "object") return out;
  const f = ficha as Record<string, unknown>;
  for (const g of DATED_FICHA_GROUPS) {
    const at = typeof f[g.stamp] === "string" ? Date.parse(f[g.stamp] as string) : NaN;
    if (Number.isNaN(at) || nowMs - at > maxAgeDays * 86_400_000) continue;
    for (const k of g.keys) if (f[k] !== undefined) out[k] = f[k];
  }
  return out;
}

export type SendResult = "sent" | "ai_paused" | "window_closed" | "failed";

export interface VoceroApi {
  getContext(waId: string): Promise<ConversationContext | null>;
  typing(conversationId: string): Promise<void>;
  send(conversationId: string, text: string): Promise<SendResult>;
  /**
   * Buttons / list. Falls back once to plain text if Vocero rejects it:
   * `fallbackText` when given (a page list adds every hour), else `interactive.body.text`.
   */
  sendInteractive(conversationId: string, interactive: InteractiveMessage, fallbackText?: string): Promise<SendResult>;
  handoff(conversationId: string, reason: "cliente" | "hostilidad" | "modelo" | "error"): Promise<boolean>;
  setFicha(conversationId: string, ficha: Record<string, unknown>): Promise<boolean>;
  knowledge(): Promise<string>;
}

export class VoceroClient implements VoceroApi {
  private kbCache: { at: number; text: string } | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly botKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
    private readonly historyDays = 60,
    private readonly log?: Logger
  ) {}

  private headers(): Record<string, string> {
    return { "x-api-key": this.botKey };
  }

  async getContext(waId: string): Promise<ConversationContext | null> {
    const url = `${this.baseUrl}/api/bot/context?identity=${encodeURIComponent(waId)}`;
    const res = await requestJson(this.fetchImpl, url, { method: "GET", headers: this.headers(), timeoutMs: this.timeoutMs });
    if (res.status !== 200 || !res.body || typeof res.body !== "object") return null;
    const b = res.body as {
      contact?: { name?: string | null; ficha?: unknown };
      conversation?: { id?: string; aiEnabled?: boolean; windowOpen?: boolean; ficha?: unknown };
    };
    if (!b.conversation?.id) return null;
    return {
      conversationId: b.conversation.id,
      contactName: b.contact?.name ?? null,
      aiEnabled: b.conversation.aiEnabled === true,
      windowOpen: b.conversation.windowOpen !== false,
      ficha: recentFicha(b.conversation.ficha ?? b.contact?.ficha, Date.now(), this.historyDays),
    };
  }

  async typing(conversationId: string): Promise<void> {
    try {
      await requestJson(this.fetchImpl, `${this.baseUrl}/api/bot/typing`, {
        method: "POST",
        headers: this.headers(),
        body: { conversationId },
        timeoutMs: 5_000,
      });
    } catch {
      // best-effort by contract
    }
  }

  async send(conversationId: string, text: string): Promise<SendResult> {
    const res = await requestJson(this.fetchImpl, `${this.baseUrl}/api/bot/messages`, {
      method: "POST",
      headers: this.headers(),
      body: { conversationId, text },
      timeoutMs: this.timeoutMs,
    });
    if (res.status === 200) return "sent";
    const code = errorCode(res.body);
    if (res.status === 409 && code === "ai_paused") return "ai_paused";
    if (res.status === 409 && code === "window_closed") return "window_closed";
    return "failed";
  }

  async sendInteractive(conversationId: string, interactive: InteractiveMessage, fallbackText?: string): Promise<SendResult> {
    const res = await requestJson(this.fetchImpl, `${this.baseUrl}/api/bot/messages`, {
      method: "POST",
      headers: this.headers(),
      body: { conversationId, interactive },
      timeoutMs: this.timeoutMs,
    });
    if (res.status === 200) return "sent";
    const code = errorCode(res.body);
    if (res.status === 409 && code === "ai_paused") return "ai_paused";
    if (res.status === 409 && code === "window_closed") return "window_closed";
    // An unpatched Vocero answers 422 invalid_body: never lose the reply.
    this.log?.warn("vocero.interactive_fallback", { status: res.status, code });
    return this.send(conversationId, fallbackText ?? interactive.body.text);
  }

  async handoff(conversationId: string, reason: "cliente" | "hostilidad" | "modelo" | "error"): Promise<boolean> {
    const res = await requestJson(this.fetchImpl, `${this.baseUrl}/api/bot/handoff`, {
      method: "POST",
      headers: this.headers(),
      body: { conversationId, reason },
      timeoutMs: this.timeoutMs,
    });
    return res.status === 200;
  }

  async setFicha(conversationId: string, ficha: Record<string, unknown>): Promise<boolean> {
    const res = await requestJson(this.fetchImpl, `${this.baseUrl}/api/bot/ficha`, {
      method: "PUT",
      headers: this.headers(),
      body: { conversationId, ficha },
      timeoutMs: this.timeoutMs,
    });
    return res.status === 200;
  }

  /** The knowledge base edited in Vocero's Agent screen, cached for a minute. */
  async knowledge(): Promise<string> {
    const now = Date.now();
    if (this.kbCache && now - this.kbCache.at < 60_000) return this.kbCache.text;
    try {
      const res = await requestJson(this.fetchImpl, `${this.baseUrl}/api/bot/profile`, {
        method: "GET",
        headers: this.headers(),
        timeoutMs: this.timeoutMs,
      });
      const kb = res.status === 200 && res.body && typeof res.body === "object" ? (res.body as { kb?: unknown }).kb : undefined;
      const text = typeof kb === "string" ? kb : "";
      this.kbCache = { at: now, text };
      return text;
    } catch {
      return this.kbCache?.text ?? "";
    }
  }
}
