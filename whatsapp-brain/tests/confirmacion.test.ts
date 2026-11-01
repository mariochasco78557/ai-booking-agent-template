/**
 * 2026-10-11 — «Perfecto! Me lo apunto, gracias.» tras el resumen no reservó y
 * el cerebro se calló. Con un resumen pendiente el cerebro NUNCA se calla.
 */
import { describe, expect, it } from "vitest";
import { processTurn, type TurnDeps } from "../src/conversation.js";
import { classifyConfirmation, pendingConfirmation, reaskText, NOTE_CONFIRMED, NOTE_UNCLEAR, NOTE_RETRY_BOOK } from "../src/confirmation.js";
import type { ChatMessage, ChatResult, LlmApi } from "../src/llm.js";
import type { VoceroApi } from "../src/vocero.js";
import type { MiddlewareApi } from "../src/middleware.js";
import type { InteractiveMessage } from "../src/interactive.js";
import { MemorySessionStore } from "../src/store.js";
import { buildToolDefinitions } from "../src/tools.js";
import { silentLogger } from "../src/log.js";
import type { InboundMessage } from "../src/meta.js";

const LOCKED = {
  outcome: "locked",
  locked: true,
  message: "Te lo dejo.",
  slot: { date: "2026-10-17", time: "09:30", employee_id: 2, employee_name: "Olga", slot_token: "tok-1" },
};
const SUMMARY = "Te resumo: corte de pelo, el 17 de octubre a las 09:30, con Olga. ¿Te la reservo? Responde «sí» y queda hecha.";
const OLD_SUMMARY = "Te resumo: corte de pelo, el 17 de octubre a las 09:30, con Olga. ¿Confirmas que quieres reservar esta cita con estos datos o prefieres que mire otro profesional?";
const URL1 = "https://cal.test/a1.ics";

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** History of an earlier turn: the lock and the summary waiting for the «sí». */
function historyWithSummary(summary = SUMMARY): ChatMessage[] {
  return [
    { role: "user", content: "la de las 9:30" },
    { role: "assistant", content: null, tool_calls: [toolCall("l1", "booking_availability_balanced_v2", { action: "lock", option_index: 1 })] },
    { role: "tool", tool_call_id: "l1", content: JSON.stringify(LOCKED) },
    { role: "assistant", content: summary },
  ];
}

function harness(opts: { script: ChatResult[]; messages?: ChatMessage[]; interactive?: boolean; book?: MiddlewareApi["book"] }) {
  const events: string[] = [];
  const interactives: InteractiveMessage[] = [];
  const vocero: VoceroApi = {
    async getContext() {
      return { conversationId: "cv_test0001", contactName: null, aiEnabled: true, windowOpen: true };
    },
    async typing() {},
    async send(_c, text) {
      events.push(`send:${text}`);
      return "sent";
    },
    async sendInteractive(_c, i) {
      interactives.push(i);
      events.push(`interactive:${i.body.text}`);
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
  const bookCalls: Record<string, unknown>[] = [];
  const middleware: MiddlewareApi = {
    async availability() {
      return LOCKED;
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
    async recado() {
      return { outcome: "recado_queued" };
    },
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
  if (opts.messages) store.save({ conversationId: "cv_test0001", startedAt: Date.now(), lastActivityAt: Date.now(), messages: opts.messages });
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
  };
  return { deps, events, interactives, seen, bookCalls, store };
}

const inbound = (text: string): InboundMessage[] => [
  { waId: "34600111222", messageId: `m${Math.random()}`, timestamp: 1700000000, type: "text", text, profileName: "Ana" },
];
const silence: ChatResult = { content: "<silencio>", toolCalls: [] };
const bookCall: ChatResult = { content: null, toolCalls: [toolCall("b1", "booking_create_booking_balanced_v2", { slot_token: "tok-1", option_time: "09:30", option_date: "2026-10-17" })] };

describe("classifyConfirmation", () => {
  it.each([
    ["Perfecto! Me lo apunto, gracias.", "yes"],
    ["sí, gracias", "yes"],
    ["Sí", "yes"],
    ["vale", "yes"],
    ["ok gracias", "yes"],
    ["Genial", "yes"],
    ["de acuerdo", "yes"],
    ["Sí, resérvala", "yes"],
    ["👍", "yes"],
    ["👍🏽", "yes"],
    ["✅", "yes"],
    ["perfecto, me la apunto, muchas gracias", "yes"],
    ["perfecto pero mejor a las 10", "no_or_change"],
    ["Cambiar algo", "no_or_change"],
    ["no, gracias", "no_or_change"],
    ["mejor el sábado 24", "no_or_change"],
    ["vale?", "no_or_change"],
    ["a las 10:00", "no_or_change"],
    ["gracias", "unclear"],
    ["👋", "unclear"],
    ["me lo pienso", "unclear"],
  ])("%s -> %s", (text, expected) => {
    expect(classifyConfirmation(text)).toBe(expected);
  });
});

describe("pendingConfirmation", () => {
  it("a summary with a lock and no booking is pending", () => {
    expect(pendingConfirmation(historyWithSummary())).toEqual({ slotToken: "tok-1", date: "2026-10-17", time: "09:30", professional: "Olga" });
    expect(pendingConfirmation(historyWithSummary(OLD_SUMMARY))).not.toBeNull();
  });
  it("a change summary («¿Confirmas el cambio?») is pending too", () => {
    expect(pendingConfirmation(historyWithSummary("Después anulo tu cita del martes 13 a las 10:00. ¿Confirmas el cambio? Responde «sí»."))).not.toBeNull();
  });
  it("a confirmed booking of that token ends it; a slot_taken does not", () => {
    const confirmed: ChatMessage[] = [
      ...historyWithSummary(),
      { role: "user", content: "sí" },
      { role: "assistant", content: null, tool_calls: [toolCall("b1", "booking_create_booking_balanced_v2", { slot_token: "tok-1" })] },
      { role: "tool", tool_call_id: "b1", content: JSON.stringify({ outcome: "confirmed", booked: true }) },
      { role: "assistant", content: "Listo ✅ ... ¿Te la reservo?" },
    ];
    expect(pendingConfirmation(confirmed)).toBeNull();
    const taken: ChatMessage[] = [
      ...historyWithSummary(),
      { role: "user", content: "sí" },
      { role: "assistant", content: null, tool_calls: [toolCall("b1", "booking_create_booking_balanced_v2", { slot_token: "tok-1" })] },
      { role: "tool", tool_call_id: "b1", content: JSON.stringify({ outcome: "slot_taken", booked: false }) },
      { role: "assistant", content: `Ese hueco se acaba de ocupar. ${SUMMARY}` },
    ];
    expect(pendingConfirmation(taken)).not.toBeNull();
  });
  it("no summary question, or a cancellation question, is not pending", () => {
    expect(pendingConfirmation(historyWithSummary("¿Qué día te vendría bien?"))).toBeNull();
    expect(pendingConfirmation(historyWithSummary("¿Confirmas que anulo tu cita del martes a las 10:00? Responde «sí» para anularla."))).toBeNull();
    expect(pendingConfirmation([])).toBeNull();
  });
});

describe("the incident: «Perfecto! Me lo apunto, gracias.» after the summary", () => {
  const SAID = "Perfecto! Me lo apunto, gracias.";

  it("the model says <silencio> (twice): the customer gets the fixed re-ask, never silence", async () => {
    const h = harness({ script: [silence, silence], messages: historyWithSummary() });
    const out = await processTurn(h.deps, "34600111222", inbound(SAID));
    expect(out).toBe("answered");
    expect(out).not.toBe("silent");
    expect(h.events).toEqual([
      "send:Aún no está reservada. ¿Te reservo la cita del sábado 17 de octubre a las 09:30? Responde «sí» y queda hecha.",
    ]);
    expect(h.events[0]).toContain("sábado 17 de octubre");
    expect(h.events[0]).toContain("09:30");
    expect(h.bookCalls).toHaveLength(0);
    expect(reaskText({ slotToken: "t", date: "2026-10-17", time: "09:30" })).toBe(h.events[0]!.slice(5));
  });

  it("the model gets the «sí» note, books, and the customer gets the confirmation with the link", async () => {
    const h = harness({
      script: [bookCall, { content: "Listo ✅ sábado 17 de octubre a las 09:30 con Olga.", toolCalls: [] }],
      messages: historyWithSummary(),
    });
    const out = await processTurn(h.deps, "34600111222", inbound(SAID));
    expect(out).toBe("answered");
    const lastUser = h.seen[0]!.filter((m) => m.role === "user").at(-1) as { content: string };
    expect(lastUser.content).toContain(SAID);
    expect(lastUser.content).toContain(NOTE_CONFIRMED);
    expect(h.bookCalls).toHaveLength(1);
    expect(h.events).toEqual([`send:Listo ✅ sábado 17 de octubre a las 09:30 con Olga.\n\nPara añadir la cita a tu calendario: ${URL1}`]);
  });

  it("a «sí» and the model never books (two rounds): re-ask, exactly 2 model rounds", async () => {
    const h = harness({
      script: [{ content: "De nada, ¡hasta pronto!", toolCalls: [] }, { content: "Listo ✅ queda reservada.", toolCalls: [] }],
      messages: historyWithSummary(),
    });
    await processTurn(h.deps, "34600111222", inbound(SAID));
    expect(h.seen).toHaveLength(2);
    const retryUser = h.seen[1]!.filter((m) => m.role === "user").at(-1) as { content: string };
    expect(retryUser.content).toBe(NOTE_RETRY_BOOK);
    expect(h.events).toEqual([expect.stringContaining("Aún no está reservada. ¿Te reservo la cita del sábado 17 de octubre a las 09:30?")]);
    expect(h.bookCalls).toHaveLength(0);
  });

  it("the retry makes the model book: confirmation, no re-ask", async () => {
    const h = harness({
      script: [silence, bookCall, { content: "Listo ✅ sábado 17 de octubre a las 09:30 con Olga.", toolCalls: [] }],
      messages: historyWithSummary(),
    });
    await processTurn(h.deps, "34600111222", inbound(SAID));
    expect(h.bookCalls).toHaveLength(1);
    expect(h.events[0]).toContain("Listo ✅ sábado 17 de octubre a las 09:30");
  });

  it("unclear («gracias»): the model is told not to book; if it stays silent, the re-ask goes out", async () => {
    const h = harness({ script: [silence], messages: historyWithSummary() });
    await processTurn(h.deps, "34600111222", inbound("gracias"));
    const lastUser = h.seen[0]!.filter((m) => m.role === "user").at(-1) as { content: string };
    expect(lastUser.content).toContain(NOTE_UNCLEAR);
    expect(h.seen).toHaveLength(1);
    expect(h.events).toEqual([expect.stringContaining("Aún no está reservada.")]);
  });

  it("«Listo ✅ …» without a confirmed booking is replaced by the re-ask", async () => {
    const h = harness({ script: [{ content: "Listo ✅ sábado 17 de octubre a las 09:30 con Olga.", toolCalls: [] }], messages: historyWithSummary() });
    await processTurn(h.deps, "34600111222", inbound("gracias"));
    expect(h.events).toEqual([expect.stringContaining("Aún no está reservada.")]);
  });

  it("a change («mejor a las 10») is left to the model, but silence is still never sent", async () => {
    const h = harness({ script: [silence], messages: historyWithSummary() });
    await processTurn(h.deps, "34600111222", inbound("perfecto pero mejor a las 10"));
    const lastUser = h.seen[0]!.filter((m) => m.role === "user").at(-1) as { content: string };
    expect(lastUser.content).not.toContain("[Nota del sistema");
    expect(h.events).toHaveLength(1);
  });

  it("a failed booking attempt keeps the model's honest message (no re-ask on top)", async () => {
    const h = harness({
      script: [bookCall, { content: "Ese hueco se acaba de ocupar. ¿Te miro otro?", toolCalls: [] }],
      messages: historyWithSummary(),
      book: async () => ({ outcome: "slot_taken", booked: false }),
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.seen).toHaveLength(2);
    expect(h.events).toEqual(["send:Ese hueco se acaba de ocupar. ¿Te miro otro?"]);
  });

  it("with NO summary pending, «gracias» + <silencio> still sends nothing", async () => {
    const h = harness({
      script: [silence],
      messages: [
        { role: "user", content: "hola" },
        { role: "assistant", content: "¿Qué día te viene mejor?" },
      ],
    });
    const out = await processTurn(h.deps, "34600111222", inbound("gracias"));
    expect(out).toBe("silent");
    expect(h.events).toEqual([]);
  });
});

describe("confirm buttons", () => {
  it("a summary with a pending lock goes out with «Sí, resérvala» / «Cambiar algo»", async () => {
    const h = harness({
      interactive: true,
      script: [
        { content: null, toolCalls: [toolCall("l1", "booking_availability_balanced_v2", { action: "lock", option_index: 1 })] },
        { content: SUMMARY, toolCalls: [] },
      ],
      messages: [{ role: "user", content: "la de las 9:30" }],
    });
    await processTurn(h.deps, "34600111222", inbound("la primera"));
    expect(h.interactives).toHaveLength(1);
    const i = h.interactives[0]!;
    expect(i.type).toBe("button");
    expect(i.type === "button" ? i.action.buttons.map((b) => b.reply.title) : []).toEqual(["Sí, resérvala", "Cambiar algo"]);
    expect(i.body.text).toBe(SUMMARY);
  });

  it("without a pending lock the same question goes as plain text", async () => {
    const h = harness({
      interactive: true,
      script: [{ content: SUMMARY, toolCalls: [] }],
      messages: [{ role: "user", content: "hola" }],
    });
    await processTurn(h.deps, "34600111222", inbound("quiero cita"));
    expect(h.interactives).toHaveLength(0);
    expect(h.events).toEqual([`send:${SUMMARY}`]);
  });

  it("the tapped title «Sí, resérvala» is a yes", () => {
    expect(classifyConfirmation("Sí, resérvala")).toBe("yes");
    expect(classifyConfirmation("Cambiar algo")).toBe("no_or_change");
  });
});

describe("the customer declines the summary", () => {
  it.each(["no, gracias", "no", "déjalo", "mejor no", "No gracias"])("%s is a rejection", async (text) => {
    const { isRejection } = await import("../src/confirmation.js");
    expect(isRejection(text)).toBe(true);
  });
  it("a change or a yes is not a rejection", async () => {
    const { isRejection, statesNotBooked } = await import("../src/confirmation.js");
    expect(isRejection("no, a las 10:00")).toBe(false);
    expect(isRejection("sí")).toBe(false);
    expect(statesNotBooked("Vale, no te la reservo.")).toBe(true);
    expect(statesNotBooked("Vale, no la reservo.")).toBe(true);
  });

  it("the model's goodbye is respected and says it is not booked", async () => {
    const h = harness({ script: [{ content: "De acuerdo. ¡Hasta pronto!", toolCalls: [] }], messages: historyWithSummary() });
    await processTurn(h.deps, "34600111222", inbound("no, gracias"));
    expect(h.events).toEqual(["send:Vale, no la reservo. De acuerdo. ¡Hasta pronto!"]);
    expect(h.bookCalls).toHaveLength(0);
  });

  it("a goodbye that already says it is not booked is left as it is", async () => {
    const h = harness({ script: [{ content: "Sin problema, no te la reservo. ¡Hasta pronto!", toolCalls: [] }], messages: historyWithSummary() });
    await processTurn(h.deps, "34600111222", inbound("mejor no"));
    expect(h.events).toEqual(["send:Sin problema, no te la reservo. ¡Hasta pronto!"]);
  });

  it("a decline answered with silence asks what to change, not the old hour", async () => {
    const h = harness({ script: [silence], messages: historyWithSummary() });
    await processTurn(h.deps, "34600111222", inbound("no"));
    expect(h.events).toEqual(["send:¿Qué quieres cambiar: el día, la hora o el profesional?"]);
    expect(h.events[0]).not.toContain("09:30");
  });
});
