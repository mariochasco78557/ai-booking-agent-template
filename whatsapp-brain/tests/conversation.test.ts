import { describe, expect, it } from "vitest";
import { processTurn, FALLBACK_REPLY, customerText, cleanReply, type TurnDeps } from "../src/conversation.js";
import type { ChatResult, LlmApi } from "../src/llm.js";
import type { VoceroApi, ConversationContext, SendResult } from "../src/vocero.js";
import type { MiddlewareApi } from "../src/middleware.js";
import { MemorySessionStore } from "../src/store.js";
import { buildToolDefinitions } from "../src/tools.js";
import { silentLogger } from "../src/log.js";
import type { InboundMessage } from "../src/meta.js";

function fakeVocero(ctx: Partial<ConversationContext> | null = {}, sendResult: SendResult = "sent", failFicha = false) {
  const events: string[] = [];
  const api: VoceroApi = {
    async getContext() {
      return ctx === null ? null : { conversationId: "cv_test0001", contactName: null, aiEnabled: true, windowOpen: true, ...ctx };
    },
    async typing() {
      events.push("typing");
    },
    async send(_c, text) {
      events.push(`send:${text}`);
      return sendResult;
    },
    async sendInteractive(_c, i) {
      events.push(`interactive:${i.type}:${i.body.text}`);
      return sendResult;
    },
    async handoff(_c, reason) {
      events.push(`handoff:${reason}`);
      return true;
    },
    async setFicha(_c, f) {
      events.push(f.ultimo_aviso_retraso ? `retraso:${String(f.ultimo_aviso_retraso_min ?? "")}` : f.ultima_anulacion ? `nota:${String(f.ultima_anulacion)}` : `ficha:${String(f.aviso_para_owner)}`);
      if (failFicha) throw new Error("vocero down");
      return true;
    },
    async knowledge() {
      return "Dirección: Calle Ejemplo 1";
    },
  };
  return { api, events };
}

function scriptedLlm(script: ChatResult[]) {
  const seen: unknown[][] = [];
  const api: LlmApi = {
    async chat(messages) {
      seen.push(messages);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
  return { api, seen };
}

function fakeMiddleware(over: Partial<MiddlewareApi> = {}) {
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  const api: MiddlewareApi = {
    async availability(body) {
      calls.push({ route: "availability", body });
      return { outcome: "options", message: "El jueves tengo a las 17:00 o a las 18:00." };
    },
    async book(body) {
      calls.push({ route: "book", body });
      return { outcome: "confirmed", booked: true };
    },
    async myReservations() {
      return { outcome: "no_reservations" };
    },
    async cancel() {
      return { outcome: "cancel_pending_owner" };
    },
    ...over,
  };
  return { api, calls };
}

const msg = (text: string | null, type = "text"): InboundMessage => ({
  waId: "34600111222",
  messageId: `m${Math.random()}`,
  timestamp: 1700000000,
  type,
  text,
  profileName: "Ana",
});

function deps(over: Partial<TurnDeps>): TurnDeps {
  return {
    vocero: fakeVocero().api,
    middleware: fakeMiddleware().api,
    llm: scriptedLlm([{ content: "Hola", toolCalls: [] }]).api,
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

describe("a customer turn", () => {
  it("answers through Vocero with typing first", async () => {
    const v = fakeVocero();
    const out = await processTurn(deps({ vocero: v.api }), "34600111222", [msg("hola")]);
    expect(out).toBe("answered");
    expect(v.events).toEqual(["typing", "send:Hola"]);
  });

  it("runs the tool loop against the middleware and keeps the history", async () => {
    const v = fakeVocero();
    const m = fakeMiddleware();
    const store = new MemorySessionStore();
    const llm = scriptedLlm([
      {
        content: null,
        toolCalls: [{ id: "c1", type: "function", function: { name: "booking_availability_balanced_v2", arguments: '{"action":"discover","service_id":1,"date":"2026-10-09","time_period":"afternoon"}' } }],
      },
      { content: "El jueves tengo a las 17:00 o a las 18:00.", toolCalls: [] },
    ]);
    await processTurn(deps({ vocero: v.api, middleware: m.api, llm: llm.api, store }), "34600111222", [msg("corte el jueves por la tarde")]);
    expect(m.calls[0]?.route).toBe("availability");
    expect(String(m.calls[0]?.body.conversation_id)).toMatch(/^wa_cv_test0001_/);
    expect(v.events.at(-1)).toBe("send:El jueves tengo a las 17:00 o a las 18:00.");
    // second model call saw the tool result
    const second = llm.seen[1] as { role: string }[];
    expect(second.map((x) => x.role)).toEqual(["system", "system", "user", "assistant", "tool"]);
    const s = store.load("cv_test0001", Date.now());
    expect(s.messages.map((x) => x.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("hands off to the salon AFTER sending the farewell, with a note for Bruno", async () => {
    const v = fakeVocero();
    const llm = scriptedLlm([
      {
        content: null,
        toolCalls: [{ id: "c1", type: "function", function: { name: "avisar_a_owner", arguments: '{"reason":"wants_human","summary":"Quiere hablar con Bruno"}' } }],
      },
      { content: "Le he dejado el aviso a Bruno. Te contestará en cuanto pueda.", toolCalls: [] },
    ]);
    await processTurn(deps({ vocero: v.api, llm: llm.api }), "34600111222", [msg("quiero hablar con una persona")]);
    const sendIdx = v.events.findIndex((e) => e.startsWith("send:"));
    const handoffIdx = v.events.indexOf("handoff:cliente");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(handoffIdx).toBeGreaterThan(sendIdx);
    expect(v.events).toContain("ficha:Quiere hablar con Bruno");
  });

  it("stays silent when a human has the conversation or the window is closed", async () => {
    const llm = scriptedLlm([]);
    expect(await processTurn(deps({ vocero: fakeVocero({ aiEnabled: false }).api, llm: llm.api }), "34600111222", [msg("hola")])).toBe("skipped_human");
    expect(await processTurn(deps({ vocero: fakeVocero({ windowOpen: false }).api, llm: llm.api }), "34600111222", [msg("hola")])).toBe("skipped_window");
    expect(llm.seen).toHaveLength(0);
  });

  it("gives up quietly when Vocero has no conversation", async () => {
    expect(await processTurn(deps({ vocero: fakeVocero(null).api }), "34600111222", [msg("hola")])).toBe("no_context");
  });

  it("on model failure sends one honest sentence and hands off", async () => {
    const v = fakeVocero();
    const out = await processTurn(deps({ vocero: v.api, llm: scriptedLlm([]).api }), "34600111222", [msg("hola")]);
    expect(out).toBe("fallback");
    expect(v.events).toEqual(["typing", `send:${FALLBACK_REPLY}`, "handoff:error"]);
  });

  it("stops after too many tool rounds", async () => {
    const v = fakeVocero();
    const loop = Array.from({ length: 10 }, (_, i) => ({
      content: null,
      toolCalls: [{ id: `c${i}`, type: "function" as const, function: { name: "booking_mis_citas", arguments: "{}" } }],
    }));
    const out = await processTurn(deps({ vocero: v.api, llm: scriptedLlm(loop).api, maxToolRounds: 3 }), "34600111222", [msg("hola")]);
    expect(out).toBe("fallback");
  });

  it("an empty reply sends nothing (closing «gracias»)", async () => {
    const v = fakeVocero();
    const out = await processTurn(deps({ vocero: v.api, llm: scriptedLlm([{ content: "", toolCalls: [] }]).api }), "34600111222", [msg("gracias")]);
    expect(out).toBe("silent");
    expect(v.events).toEqual(["typing"]);
  });
});

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe("booking again in the same chat", () => {
  const bookingTurn = () =>
    scriptedLlm([
      { content: null, toolCalls: [toolCall("c1", "booking_create_booking_balanced_v2", { slot_token: "t" })] },
      { content: "Listo.", toolCalls: [] },
    ]).api;

  it("a confirmed booking starts a new middleware conversation id", async () => {
    const store = new MemorySessionStore();
    const m = fakeMiddleware();
    let t = 1_800_000_000_000;
    const now = () => t;
    await processTurn(deps({ store, middleware: m.api, llm: bookingTurn(), now }), "34600111222", [msg("sí")]);
    t += 60_000;
    await processTurn(deps({ store, middleware: m.api, llm: bookingTurn(), now }), "34600111222", [msg("otra para mi hijo")]);
    const ids = m.calls.filter((c) => c.route === "book").map((c) => String(c.body.conversation_id));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("without a confirmed booking the id stays the same", async () => {
    const store = new MemorySessionStore();
    const m = fakeMiddleware({
      async book(body) {
        m.calls.push({ route: "book", body });
        return { outcome: "slot_taken", booked: false };
      },
    });
    let t = 1_800_000_000_000;
    const now = () => t;
    await processTurn(deps({ store, middleware: m.api, llm: bookingTurn(), now }), "34600111222", [msg("sí")]);
    t += 60_000;
    await processTurn(deps({ store, middleware: m.api, llm: bookingTurn(), now }), "34600111222", [msg("sí")]);
    const ids = m.calls.filter((c) => c.route === "book").map((c) => String(c.body.conversation_id));
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("calendar link", () => {
  const URL1 = "https://cal.test/a1.ics";
  const bookMw = (urls: string[]) => {
    const q = [...urls];
    return fakeMiddleware({
      async book() {
        return { outcome: "confirmed", booked: true, calendar_url: q.shift() };
      },
    }).api;
  };
  const bookTurn = (reply: string | null, mw = bookMw([URL1])) => ({
    mw,
    llm: scriptedLlm([
      { content: null, toolCalls: [toolCall("c1", "booking_create_booking_balanced_v2", { slot_token: "t" })] },
      { content: reply, toolCalls: [] },
    ]),
  });

  it("appends the link after the reply and never shows it to the model", async () => {
    const v = fakeVocero();
    const t = bookTurn("Listo, cita confirmada.");
    await processTurn(deps({ vocero: v.api, middleware: t.mw, llm: t.llm.api }), "34600111222", [msg("sí")]);
    expect(v.events.at(-1)).toBe(`send:Listo, cita confirmada.\n\nPara añadir la cita a tu calendario: ${URL1}`);
    expect(JSON.stringify(t.llm.seen[1])).not.toContain(URL1);
  });

  it("one line per booking, and not twice if the reply has it", async () => {
    const v = fakeVocero();
    const llm = scriptedLlm([
      { content: null, toolCalls: [toolCall("c1", "booking_create_booking_balanced_v2"), toolCall("c2", "booking_create_booking_balanced_v2")] },
      { content: "Hechas.", toolCalls: [] },
    ]);
    await processTurn(deps({ vocero: v.api, middleware: bookMw([URL1, "https://cal.test/a2.ics"]), llm: llm.api }), "34600111222", [msg("sí")]);
    expect(v.events.at(-1)).toBe(
      "send:Hechas.\n\nPara añadir la cita a tu calendario: https://cal.test/a1.ics\nPara añadir la cita a tu calendario: https://cal.test/a2.ics"
    );
    const v2 = fakeVocero();
    const t = bookTurn(`Listo ${URL1}`);
    await processTurn(deps({ vocero: v2.api, middleware: t.mw, llm: t.llm.api }), "34600111222", [msg("sí")]);
    expect(v2.events.at(-1)).toBe(`send:Listo ${URL1}`);
  });

  it("2026-10-11: when the model stays silent after booking, the fixed confirmation goes out WITH the link", async () => {
    const v = fakeVocero();
    const t = bookTurn("<silencio>");
    const out = await processTurn(deps({ vocero: v.api, middleware: t.mw, llm: t.llm.api }), "34600111222", [msg("sí")]);
    expect(out).toBe("answered");
    expect(v.events.at(-1)).toBe(
      `send:Tu cita queda reservada.\nSi necesitas algo más, escríbenos y la peluquería te contesta por aquí.\n\nPara añadir la cita a tu calendario: ${URL1}`
    );
  });

  it("never rides on the generic fallback message (nothing done)", async () => {
    const v = fakeVocero();
    const llm = scriptedLlm([{ content: null, toolCalls: [toolCall("c1", "booking_availability_balanced_v2", { action: "discover" })] }]);
    await processTurn(deps({ vocero: v.api, middleware: bookMw([URL1]), llm: llm.api }), "34600111222", [msg("hola")]);
    expect(v.events).toContain(`send:${FALLBACK_REPLY}`);
    expect(v.events.join("|")).not.toContain(URL1);
  });

  it("hallazgo 2: a failure after a booking still sends the link, inside the fixed text", async () => {
    const v = fakeVocero();
    const llm = scriptedLlm([{ content: null, toolCalls: [toolCall("c1", "booking_create_booking_balanced_v2")] }]);
    await processTurn(deps({ vocero: v.api, middleware: bookMw([URL1]), llm: llm.api }), "34600111222", [msg("sí")]);
    expect(v.events).not.toContain(`send:${FALLBACK_REPLY}`);
    expect(v.events.find((e) => e.startsWith("send:"))).toContain(`Para añadir la cita a tu calendario: ${URL1}`);
  });
});

describe("hallazgo 2 · the AI fails after the agenda changed", () => {
  const LOCKED = {
    outcome: "locked",
    locked: true,
    message: "Te lo dejo a las nueve y media con Bruno.",
    slot: { date: "2026-10-10", time: "09:30", employee_id: 1, employee_name: "Bruno", slot_token: "tok-1" },
  };
  const URL1 = "https://cal.test/a1.ics";
  const mw = () =>
    fakeMiddleware({
      async availability() {
        return LOCKED;
      },
      async book() {
        return { outcome: "confirmed", booked: true, calendar_url: URL1, message: "Perfecto, la reserva queda confirmada." };
      },
      async cancel() {
        return { outcome: "cancelled", owner_notified: true, reservation: { day_label: "el martes 13", time: "10:00", professional: "Olga" } };
      },
    }).api;

  it("lock in an earlier message, «sí» + create now, model dies: fixed text with day, hour, professional and link; note for Bruno", async () => {
    const store = new MemorySessionStore();
    const v = fakeVocero();
    // Turn 1: the lock and the summary.
    const turn1 = scriptedLlm([
      { content: null, toolCalls: [toolCall("l1", "booking_availability_balanced_v2", { action: "lock", option_index: 1 })] },
      { content: "Sábado 10 a las 09:30 con Bruno. ¿Te lo reservo?", toolCalls: [] },
    ]);
    await processTurn(deps({ store, vocero: fakeVocero().api, middleware: mw(), llm: turn1.api }), "34600111222", [msg("la primera")]);
    // Turn 2: create succeeds, then the model call throws (script exhausted).
    const turn2 = scriptedLlm([{ content: null, toolCalls: [toolCall("c1", "booking_create_booking_balanced_v2", { slot_token: "tok-1" })] }]);
    const out = await processTurn(deps({ store, vocero: v.api, middleware: mw(), llm: turn2.api }), "34600111222", [msg("sí")]);
    expect(out).toBe("fallback");
    const sent = v.events.find((e) => e.startsWith("send:"))!;
    expect(sent).toBe(
      "send:Tu cita queda reservada para el sábado 10 de octubre a las 09:30 con Bruno.\n" +
        "Si necesitas algo más, escríbenos y la peluquería te contesta por aquí.\n\n" +
        `Para añadir la cita a tu calendario: ${URL1}`
    );
    expect(v.events.join("|")).not.toContain(FALLBACK_REPLY);
    const note = v.events.find((e) => e.startsWith("ficha:"))!;
    expect(note).toContain("el sábado 10 de octubre a las 09:30 con Bruno");
    // The note goes BEFORE the handoff (once paused, nothing can be written to the chat).
    expect(v.events.indexOf(note)).toBeLessThan(v.events.indexOf("handoff:error"));
  });

  it("a cancellation done before the failure is confirmed with a fixed text too", async () => {
    const v = fakeVocero();
    const llm = scriptedLlm([{ content: null, toolCalls: [toolCall("x1", "booking_cancelar_cita", { reservation_ref: "r", confirmed_by_customer: true })] }]);
    await processTurn(deps({ vocero: v.api, selfServiceEnabled: true, middleware: mw(), llm: llm.api }), "34600111222", [msg("sí")]);
    expect(v.events).toContain(
      "send:Tu cita del martes 13 a las 10:00 con Olga queda anulada.\nSi necesitas algo más, escríbenos y la peluquería te contesta por aquí."
    );
    expect(v.events).toContain("handoff:error");
  });

  it("a booking whose lock is unknown falls back to the middleware's own fixed sentence", async () => {
    const v = fakeVocero();
    const llm = scriptedLlm([{ content: null, toolCalls: [toolCall("c1", "booking_create_booking_balanced_v2", { slot_token: "unknown" })] }]);
    await processTurn(deps({ vocero: v.api, middleware: mw(), llm: llm.api }), "34600111222", [msg("sí")]);
    expect(v.events.find((e) => e.startsWith("send:"))).toContain("Perfecto, la reserva queda confirmada.");
  });

  it("a refused create (nothing done) keeps the generic fallback", async () => {
    const v = fakeVocero();
    const m = fakeMiddleware({ book: async () => ({ outcome: "slot_time_mismatch", booked: false }) });
    const llm = scriptedLlm([{ content: null, toolCalls: [toolCall("c1", "booking_create_booking_balanced_v2", { slot_token: "t" })] }]);
    await processTurn(deps({ vocero: v.api, middleware: m.api, llm: llm.api }), "34600111222", [msg("sí")]);
    expect(v.events).toContain(`send:${FALLBACK_REPLY}`);
    expect(v.events.some((e) => e.startsWith("ficha:"))).toBe(false);
  });
});

describe("cancellation note", () => {
  const cancelled = {
    outcome: "cancelled",
    owner_notified: false,
    reservation: { day_label: "el martes 13", time: "10:00", professional: "Bruno" },
  };
  const script = () =>
    scriptedLlm([
      { content: null, toolCalls: [toolCall("c1", "booking_cancelar_cita", { reservation_ref: "r", confirmed_by_customer: true })] },
      { content: "Anulada.", toolCalls: [] },
    ]);

  it("leaves a note in the ficha, without a handoff", async () => {
    const v = fakeVocero();
    const out = await processTurn(
      deps({ vocero: v.api, selfServiceEnabled: true, middleware: fakeMiddleware({ cancel: async () => cancelled }).api, llm: script().api }),
      "34600111222",
      [msg("sí")]
    );
    expect(out).toBe("answered");
    expect(v.events).toContain("nota:Anulada por WhatsApp: el martes 13 a las 10:00 con Bruno");
    expect(v.events.some((e) => e.startsWith("handoff"))).toBe(false);
  });

  it("a failing note never fails the turn", async () => {
    const v = fakeVocero({}, "sent", true);
    const out = await processTurn(
      deps({ vocero: v.api, selfServiceEnabled: true, middleware: fakeMiddleware({ cancel: async () => cancelled }).api, llm: script().api }),
      "34600111222",
      [msg("sí")]
    );
    expect(out).toBe("answered");
  });

  it("without the self-service flag the cancel is a stub and no note is left", async () => {
    const v = fakeVocero();
    await processTurn(deps({ vocero: v.api, middleware: fakeMiddleware({ cancel: async () => cancelled }).api, llm: script().api }), "34600111222", [msg("sí")]);
    expect(v.events.some((e) => e.startsWith("nota:"))).toBe(false);
  });
});

describe("notice record and late arrival", () => {
  it("adds the notice to the internal note only", async () => {
    const v = fakeVocero();
    const llm = scriptedLlm([
      { content: null, toolCalls: [toolCall("c1", "booking_cancelar_cita", { reservation_ref: "r", confirmed_by_customer: true })] },
      { content: "Anulada.", toolCalls: [] },
    ]);
    const cancelled = { outcome: "cancelled", owner_notified: false, notice_minutes: 25, late_notice: true, reservation: { day_label: "hoy", time: "10:00", professional: "Bruno" } };
    await processTurn(deps({ vocero: v.api, selfServiceEnabled: true, middleware: fakeMiddleware({ cancel: async () => cancelled }).api, llm: llm.api }), "34600111222", [msg("sí")]);
    expect(v.events).toContain("nota:Anulada por WhatsApp: hoy a las 10:00 con Bruno (avisó 25 min antes)");
    expect(v.events.some((e) => e.startsWith("send:") && e.includes("25"))).toBe(false);
  });

  it("«llego tarde» writes the ficha field silently: no cancel, no handoff", async () => {
    const v = fakeVocero();
    let cancelled = false;
    const llm = scriptedLlm([
      { content: null, toolCalls: [toolCall("c1", "notify_late_arrival", { minutes_late: 15 })] },
      { content: "Gracias por avisar.", toolCalls: [] },
    ]);
    const out = await processTurn(deps({ vocero: v.api, middleware: fakeMiddleware({ cancel: async () => { cancelled = true; return {}; } }).api, llm: llm.api }), "34600111222", [msg("llego tarde")]);
    expect(out).toBe("answered");
    expect(cancelled).toBe(false);
    expect(v.events).toContain("retraso:15");
    expect(v.events.some((e) => e.startsWith("handoff"))).toBe(false);
  });
});

describe("helpers", () => {
  it("joins a burst and labels media", () => {
    expect(customerText([msg("hola"), msg(null, "audio"), msg(null, "image")])).toBe("hola\n[nota de voz]\n[imagen]");
  });
  it("strips markdown emphasis", () => {
    expect(cleanReply("**Listo**, ya tienes la cita")).toBe("Listo, ya tienes la cita");
    expect(cleanReply(null)).toBe("");
  });
  it("treats the silence marker as no reply", () => {
    expect(cleanReply("<silencio>")).toBe("");
    expect(cleanReply(" <SILENCIO>. ")).toBe("");
    expect(cleanReply("Hola <silencio>")).toBe("Hola <silencio>");
  });
});
