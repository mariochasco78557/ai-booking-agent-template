import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { processTurn, DEFAULT_MAX_BOOKINGS_PER_CONVERSATION, type TurnDeps } from "../src/conversation.js";
import type { ChatMessage, ChatResult, LlmApi } from "../src/llm.js";
import type { VoceroApi } from "../src/vocero.js";
import type { MiddlewareApi } from "../src/middleware.js";
import { MemorySessionStore } from "../src/store.js";
import {
  buildToolDefinitions,
  conversationLimitMessage,
  executeTool,
  OUTCOME_CONVERSATION_LIMIT,
  TOOL_BOOK,
  type ToolSession,
} from "../src/tools.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import type { InboundMessage } from "../src/meta.js";

/**
 * 2026-10-09 — up to three bookings (for several people) in one WhatsApp
 * conversation ((internal doc, not included in the template), finding 6).
 * Fictitious numbers only.
 */

const vocero: VoceroApi = {
  async getContext() {
    return { conversationId: "cv_limit0001", contactName: null, aiEnabled: true, windowOpen: true };
  },
  async typing() {},
  async send() {
    return "sent";
  },
  async sendInteractive() {
    return "sent";
  },
  async handoff() {
    return true;
  },
  async setFicha() {
    return true;
  },
  async knowledge() {
    return "";
  },
};

function middleware(bookAnswer: () => Record<string, unknown> = () => ({ outcome: "confirmed", booked: true })) {
  const books: Record<string, unknown>[] = [];
  const api: MiddlewareApi = {
    async availability() {
      return { outcome: "options" };
    },
    async book(body) {
      books.push(body);
      return bookAnswer();
    },
    async myReservations() {
      return { outcome: "no_reservations" };
    },
    async cancel() {
      return { outcome: "cancel_pending_owner" };
    },
  };
  return { api, books };
}

/** One booking attempt per turn; records what the tool answered the model. */
function bookingTurn(toolAnswers: Record<string, unknown>[]): LlmApi {
  let step = 0;
  return {
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      step += 1;
      if (step === 1) {
        return {
          content: null,
          toolCalls: [{ id: "b1", type: "function", function: { name: TOOL_BOOK, arguments: JSON.stringify({ slot_token: "t" }) } }],
        } as ChatResult;
      }
      const last = messages[messages.length - 1];
      if (last && last.role === "tool") toolAnswers.push(JSON.parse(last.content) as Record<string, unknown>);
      return { content: "Listo.", toolCalls: [] } as ChatResult;
    },
  };
}

const msg = (text: string): InboundMessage => ({
  waId: "34600111222",
  messageId: `m${Math.random()}`,
  timestamp: 1700000000,
  type: "text",
  text,
  profileName: "Ana",
});

function deps(over: Partial<TurnDeps>): TurnDeps {
  return {
    vocero,
    middleware: middleware().api,
    llm: bookingTurn([]),
    store: new MemorySessionStore(),
    tools: buildToolDefinitions(),
    staticSystem: { role: "system", content: "STATIC" },
    bookingEnabled: true,
    maxToolRounds: 5,
    log: silentLogger,
    retryDelayMs: 0,
    ...over,
  };
}

describe("several bookings in one WhatsApp conversation", () => {
  it("three bookings go through, each with a fresh middleware id; the fourth is refused without calling the middleware", async () => {
    const store = new MemorySessionStore();
    const m = middleware();
    const answers: Record<string, unknown>[] = [];
    let t = 1_800_000_000_000;
    const now = () => t;
    for (let i = 0; i < 4; i += 1) {
      await processTurn(deps({ store, middleware: m.api, llm: bookingTurn(answers), now }), "34600111222", [msg("otra más")]);
      t += 60_000;
    }
    expect(m.books).toHaveLength(3);
    expect(new Set(m.books.map((b) => b.conversation_id)).size).toBe(3);
    expect(answers.slice(0, 3).every((a) => a.outcome === "confirmed")).toBe(true);
    expect(answers[3]).toMatchObject({
      outcome: OUTCOME_CONVERSATION_LIMIT,
      booked: false,
      external_mutation: false,
      max_bookings_per_conversation: 3,
      message: conversationLimitMessage(3),
    });
  });

  it("a replayed confirmation does not count twice; a refusal does not count", async () => {
    const s: ToolSession = {
      middlewareConversationId: "wa_cv_x_1",
      spanishPhone: "600111222",
      bookingEnabled: true,
      selfServiceEnabled: true,
      bookingsConfirmed: 0,
      maxBookingsPerConversation: 3,
    };
    const answers = [
      { outcome: "confirmed", booked: true, idempotency_status: "original" },
      { outcome: "confirmed", booked: true, idempotency_status: "replayed" },
      { outcome: "phone_booking_limit", booked: false },
      { outcome: "slot_taken", booked: false },
    ];
    const m = middleware(() => answers.shift()!);
    for (let i = 0; i < 4; i += 1) await executeTool(TOOL_BOOK, { slot_token: "t" }, s, m.api);
    expect(s.bookingsConfirmed).toBe(1);
    expect(m.books).toHaveLength(4);
  });

  it("the middleware's phone limit reaches the model untouched", async () => {
    const s: ToolSession = {
      middlewareConversationId: "wa_cv_x_1",
      spanishPhone: "600111222",
      bookingEnabled: true,
      selfServiceEnabled: true,
      bookingsConfirmed: 0,
      maxBookingsPerConversation: 3,
    };
    const answer = { outcome: "phone_booking_limit", booked: false, message: "Con este número ya tienes tres citas pendientes…" };
    const out = await executeTool(TOOL_BOOK, { slot_token: "t" }, s, middleware(() => answer).api);
    expect(out).toMatchObject(answer);
  });

  it("a new session (idle past the TTL) starts counting again", async () => {
    const store = new MemorySessionStore(3600_000);
    const m = middleware();
    let t = 1_800_000_000_000;
    const now = () => t;
    for (let i = 0; i < 3; i += 1) {
      await processTurn(deps({ store, middleware: m.api, llm: bookingTurn([]), now }), "34600111222", [msg("una más")]);
      t += 60_000;
    }
    t += 2 * 3600_000;
    await processTurn(deps({ store, middleware: m.api, llm: bookingTurn([]), now }), "34600111222", [msg("hola de nuevo")]);
    expect(m.books).toHaveLength(4);
  });

  it("default 3, BRAIN_MAX_BOOKINGS_PER_CONVERSATION overrides it", () => {
    expect(DEFAULT_MAX_BOOKINGS_PER_CONVERSATION).toBe(3);
    expect(loadConfig({}).maxBookingsPerConversation).toBe(3);
    expect(loadConfig({ BRAIN_MAX_BOOKINGS_PER_CONVERSATION: "2" }).maxBookingsPerConversation).toBe(2);
    expect(conversationLimitMessage(2)).toContain("dos citas");
    expect(conversationLimitMessage(3)).not.toMatch(/\d/);
  });

  it("the prompt no longer makes a second booking depend on max_bookings_per_call", () => {
    const prompt = readFileSync(new URL("../prompts/AGENT_PROMPT_WHATSAPP_V1_ES.md", import.meta.url), "utf8");
    expect(prompt).not.toContain("Solo hay siguiente si la anterior trae `max_bookings_per_call`");
    expect(prompt).toContain("`phone_booking_limit`");
    expect(prompt).toContain("`conversation_booking_limit`");
  });
});
