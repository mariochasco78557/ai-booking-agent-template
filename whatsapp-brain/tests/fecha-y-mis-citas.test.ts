/**
 * 2026-10-09 — two WhatsApp incidents:
 *  - «¿cuándo es mi cita?» answered with appointments the customer had
 *    cancelled: an earlier «mis citas» result must not pass for the current one;
 *  - «el próximo jueves» became a Thursday three weeks ahead: the model sends
 *    the customer's day word (`day_name`) and the middleware fixes the date.
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { markStaleLookups, processTurn, STALE_LOOKUP_NOTE, type TurnDeps } from "../src/conversation.js";
import type { ChatMessage, ChatResult, LlmApi } from "../src/llm.js";
import type { MiddlewareApi } from "../src/middleware.js";
import type { VoceroApi } from "../src/vocero.js";
import { MemorySessionStore } from "../src/store.js";
import { buildToolDefinitions, executeTool, TOOL_AVAILABILITY, TOOL_MY_BOOKINGS, type ToolSession } from "../src/tools.js";
import { DEFAULT_OPENING_HOURS, parseOpeningHours } from "../src/hours.js";
import { silentLogger } from "../src/log.js";

const LOOKUP_RESULT = {
  outcome: "reservations_found",
  message: "Tienes dos citas: el sábado 24 a las 09:00 y el jueves 29 a las 11:00.",
  reservations: [
    { reservation_ref: "ref_a", date: "2026-10-24", time: "09:00", day_label: "sábado 24 de octubre", cancellable: true },
    { reservation_ref: "ref_b", date: "2026-10-29", time: "11:00", day_label: "jueves 29 de octubre", cancellable: true },
  ],
  external_mutation: false,
};

function history(): ChatMessage[] {
  return [
    { role: "user", content: "¿Qué citas tengo?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: TOOL_MY_BOOKINGS, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: JSON.stringify(LOOKUP_RESULT) },
    { role: "assistant", content: "Tienes dos citas." },
    { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: TOOL_AVAILABILITY, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_2", content: JSON.stringify({ outcome: "options_available", message: "Tengo a las 10:00." }) },
  ];
}

describe("earlier «mis citas» results are marked stale", () => {
  it("drops the ready-made message, keeps refs/days, adds the note; other tools untouched", () => {
    const out = markStaleLookups(history());
    const lookup = JSON.parse((out[2] as { content: string }).content) as Record<string, unknown>;
    expect(lookup.message).toBeUndefined();
    expect(lookup.stale).toBe(true);
    expect(lookup.stale_note).toBe(STALE_LOOKUP_NOTE);
    expect(lookup.reservations).toEqual(LOOKUP_RESULT.reservations);
    expect(out[5]).toEqual(history()[5]);
    expect(out[0]).toEqual(history()[0]);
  });

  it("is idempotent and leaves a history without lookups as it was", () => {
    const once = markStaleLookups(history());
    expect(markStaleLookups(once)).toEqual(once);
    const plain: ChatMessage[] = [{ role: "user", content: "hola" }];
    expect(markStaleLookups(plain)).toBe(plain);
  });

  it("a non-JSON tool content is left alone", () => {
    const h = history();
    (h[2] as { content: string }).content = "not json";
    expect((markStaleLookups(h)[2] as { content: string }).content).toBe("not json");
  });

  it("processTurn: the model sees the earlier lookup as stale, and a fresh one in the same turn is not", async () => {
    const store = new MemorySessionStore();
    const s = store.load("cv_test0001", Date.now());
    s.messages = history();
    store.save(s);

    const seen: ChatMessage[][] = [];
    const script: ChatResult[] = [
      { content: null, toolCalls: [{ id: "call_3", type: "function", function: { name: TOOL_MY_BOOKINGS, arguments: "{}" } }] },
      { content: "No veo ninguna cita.", toolCalls: [] },
    ];
    const llm: LlmApi = {
      async chat(messages) {
        seen.push(structuredClone(messages));
        return script.shift()!;
      },
    };
    const vocero: VoceroApi = {
      getContext: async () => ({ conversationId: "cv_test0001", contactName: null, aiEnabled: true, windowOpen: true }),
      typing: async () => undefined,
      send: async () => "sent",
      sendInteractive: async () => "sent",
      handoff: async () => true,
      setFicha: async () => true,
      knowledge: async () => "",
    } as unknown as VoceroApi;
    const middleware: MiddlewareApi = {
      availability: async () => ({}),
      book: async () => ({}),
      myReservations: async () => ({ outcome: "no_reservations", message: "No veo ninguna cita." }),
      cancel: async () => ({}),
    };
    const deps: TurnDeps = {
      vocero,
      middleware,
      llm,
      store,
      tools: buildToolDefinitions(),
      staticSystem: { role: "system", content: "STATIC" },
      bookingEnabled: true,
      selfServiceEnabled: true,
      maxToolRounds: 5,
      log: silentLogger,
      retryDelayMs: 0,
    };
    const waId = "34600111222";
    await processTurn(deps, waId, [{ waId, messageId: "m1", timestamp: 1, type: "text", text: "¿Cuándo es mi cita?", profileName: null }]);

    const first = seen[0]!;
    const old = first.find((m) => m.role === "tool" && m.tool_call_id === "call_1") as { content: string };
    expect(JSON.parse(old.content).stale).toBe(true);
    const second = seen[1]!;
    const fresh = second.find((m) => m.role === "tool" && m.tool_call_id === "call_3") as { content: string };
    expect(JSON.parse(fresh.content)).toEqual({ outcome: "no_reservations", message: "No veo ninguna cita." });
  });
});

describe("day_name reaches the middleware", () => {
  const session = (over: Partial<ToolSession> = {}): ToolSession => ({
    middlewareConversationId: "wa_cv_abc_x1",
    spanishPhone: "600111222",
    bookingEnabled: true,
    selfServiceEnabled: true,
    ...over,
  });

  it("the availability tool offers day_name to the model", () => {
    const t = buildToolDefinitions().find((d) => d.function.name === TOOL_AVAILABILITY)!;
    const props = (t.function.parameters as { properties: Record<string, { type: string; description: string }> }).properties;
    expect(props.day_name?.type).toBe("string");
    expect(props.day_name?.description).toMatch(/NEAREST/);
  });

  it("day_name is forwarded as sent", async () => {
    const calls: Record<string, unknown>[] = [];
    const m: MiddlewareApi = {
      availability: async (b) => (calls.push(b), { outcome: "no_availability", message: "x" }),
      book: async () => ({}),
      myReservations: async () => ({}),
      cancel: async () => ({}),
    };
    await executeTool(TOOL_AVAILABILITY, { action: "discover", date: "2026-10-29", time_period: "morning", service_id: 1, day_name: "el próximo jueves" }, session(), m);
    expect(calls[0]).toMatchObject({ day_name: "el próximo jueves", conversation_id: "wa_cv_abc_x1" });
  });

  it("with day_name the local closed-day guard does not judge the model's date (the server fixes it)", async () => {
    const calls: Record<string, unknown>[] = [];
    const m: MiddlewareApi = {
      availability: async (b) => (calls.push(b), { outcome: "options_available", message: "x" }),
      book: async () => ({}),
      myReservations: async () => ({}),
      cancel: async () => ({}),
    };
    const s = session({ openingHours: parseOpeningHours(DEFAULT_OPENING_HOURS) });
    // 2026-10-12 is a Monday (closed) but the customer said «jueves».
    await executeTool(TOOL_AVAILABILITY, { action: "discover", date: "2026-10-12", time_period: "morning", day_name: "jueves" }, s, m);
    expect(calls).toHaveLength(1);
    // Without day_name the guard still answers locally.
    const r = await executeTool(TOOL_AVAILABILITY, { action: "discover", date: "2026-10-12", time_period: "morning" }, s, m);
    expect(r.outcome).toBe("no_availability");
    expect(calls).toHaveLength(1);
  });
});
