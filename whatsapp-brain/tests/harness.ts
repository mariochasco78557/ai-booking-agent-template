/** Shared fakes for the 2026-10-11 tests (confirmation, guards, calendar guarantee). */
import type { TurnDeps } from "../src/conversation.js";
import type { ChatMessage, ChatResult, LlmApi } from "../src/llm.js";
import type { SendResult, VoceroApi } from "../src/vocero.js";
import type { CalendarLinkBody, MiddlewareApi, RecadoBody } from "../src/middleware.js";
import type { InteractiveMessage } from "../src/interactive.js";
import { MemorySessionStore } from "../src/store.js";
import { buildToolDefinitions } from "../src/tools.js";
import { silentLogger } from "../src/log.js";
import type { InboundMessage } from "../src/meta.js";

export const LOCKED = {
  outcome: "locked",
  locked: true,
  message: "Te lo dejo.",
  slot: { date: "2026-10-17", time: "09:30", employee_id: 2, employee_name: "Olga", slot_token: "tok-1" },
};
export const SUMMARY = "Te resumo: corte de pelo, el 17 de octubre a las 09:30, con Olga. ¿Te la reservo? Responde «sí» y queda hecha.";
export const URL1 = "https://cal.test/a1.ics";

export const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

export const inbound = (text: string): InboundMessage[] => [
  { waId: "34600111222", messageId: `m${Math.random()}`, timestamp: 1700000000, type: "text", text, profileName: "Ana" },
];

export const silence: ChatResult = { content: "<silencio>", toolCalls: [] };
export const bookCall = (id = "b1", token = "tok-1"): ChatResult => ({
  content: null,
  toolCalls: [toolCall(id, "booking_create_booking_balanced_v2", { slot_token: token, option_time: "09:30", option_date: "2026-10-17" })],
});

/** History of an earlier turn: the lock and the summary waiting for the «sí». */
export function historyWithSummary(summary = SUMMARY): ChatMessage[] {
  return [
    { role: "user", content: "la de las 9:30" },
    { role: "assistant", content: null, tool_calls: [toolCall("l1", "booking_availability_balanced_v2", { action: "lock", option_index: 1 })] },
    { role: "tool", tool_call_id: "l1", content: JSON.stringify(LOCKED) },
    { role: "assistant", content: summary },
  ];
}

export interface HarnessOptions {
  script: ChatResult[];
  messages?: ChatMessage[];
  interactive?: boolean;
  availability?: MiddlewareApi["availability"];
  book?: MiddlewareApi["book"];
  /** 2026-10-11: answers of POST /ai/wa/change-service; absent = the method does not exist. */
  changeService?: NonNullable<MiddlewareApi["changeService"]>;
  /** Undefined = the client has no calendarLink at all. */
  calendarLink?: ((phone: string | null, body: CalendarLinkBody) => Promise<Record<string, unknown>>) | "none";
  /** Results of successive `send` calls; the last one repeats. */
  sendResults?: SendResult[];
  calendarRetryMs?: number;
}

let startedSeq = 0;

export function harness(opts: HarnessOptions) {
  const events: string[] = [];
  const interactives: InteractiveMessage[] = [];
  const fichas: Record<string, unknown>[] = [];
  const recados: RecadoBody[] = [];
  const linkCalls: CalendarLinkBody[] = [];
  const bookCalls: Record<string, unknown>[] = [];
  const sendResults = [...(opts.sendResults ?? ["sent"])];
  const nextSend = (): SendResult => (sendResults.length > 1 ? (sendResults.shift() as SendResult) : (sendResults[0] as SendResult));
  const vocero: VoceroApi = {
    async getContext() {
      return { conversationId: "cv_test0001", contactName: null, aiEnabled: true, windowOpen: true };
    },
    async typing() {},
    async send(_c, text) {
      events.push(`send:${text}`);
      return nextSend();
    },
    async sendInteractive(_c, i) {
      interactives.push(i);
      events.push(`interactive:${i.body.text}`);
      return nextSend();
    },
    async handoff() {
      return true;
    },
    async setFicha(_c, f) {
      fichas.push(f);
      return true;
    },
    async knowledge() {
      return "";
    },
  };
  const middleware: MiddlewareApi = {
    async availability(body) {
      return opts.availability ? opts.availability(body) : LOCKED;
    },
    async book(body) {
      bookCalls.push(body);
      return opts.book ? opts.book(body) : { outcome: "confirmed", booked: true, calendar_url: URL1 };
    },
    async myReservations() {
      return { outcome: "no_reservations" };
    },
    async cancel() {
      return { outcome: "cancel_pending_owner" };
    },
    ...(opts.changeService ? { changeService: opts.changeService } : {}),
    async recado(_phone, body) {
      recados.push(body);
      return { outcome: "recado_queued" };
    },
    ...(opts.calendarLink === "none"
      ? {}
      : {
          async calendarLink(phone: string | null, body: CalendarLinkBody) {
            linkCalls.push(body);
            return opts.calendarLink ? opts.calendarLink(phone, body) : { outcome: "calendar_unavailable" };
          },
        }),
  };
  const seen: ChatMessage[][] = [];
  const script = [...opts.script];
  const llm: LlmApi = {
    async chat(messages) {
      seen.push(messages);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
  const store = new MemorySessionStore();
  if (opts.messages) store.save({ conversationId: "cv_test0001", startedAt: Date.now() + startedSeq++, lastActivityAt: Date.now(), messages: opts.messages });
  const deps: TurnDeps = {
    vocero,
    middleware,
    llm,
    store,
    tools: buildToolDefinitions(),
    staticSystem: { role: "system", content: "STATIC" },
    bookingEnabled: true,
    interactive: opts.interactive ?? false,
    maxToolRounds: 5,
    log: silentLogger,
    retryDelayMs: 0,
    ...(opts.calendarRetryMs !== undefined ? { calendarRetryMs: opts.calendarRetryMs } : {}),
  };
  return { deps, events, interactives, fichas, recados, linkCalls, bookCalls, seen, store };
}
