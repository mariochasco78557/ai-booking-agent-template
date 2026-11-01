/**
 * 2026-10-10 — «¿Cuándo era mi cita?» on WhatsApp was answered with an OLD
 * conversation («las dos citas que tenías están anuladas…») although the
 * customer had booked again by phone. The model never called «mis citas».
 * Rule: what rules is ALWAYS Bruno's agenda for the number; the brain reads it
 * itself in the same turn. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import {
  asksAboutExistingBookings,
  FRESH_LOOKUP_NOTE,
  processTurn,
  STALE_CANCEL_NOTE,
  STALE_LOOKUP_NOTE,
  type TurnDeps,
} from "../src/conversation.js";
import type { ChatMessage, ChatResult, LlmApi } from "../src/llm.js";
import type { MiddlewareApi } from "../src/middleware.js";
import type { VoceroApi } from "../src/vocero.js";
import { MemorySessionStore } from "../src/store.js";
import { buildToolDefinitions, TOOL_CANCEL, TOOL_MY_BOOKINGS } from "../src/tools.js";
import { silentLogger } from "../src/log.js";

const OLD_LOOKUP = {
  outcome: "reservations_found",
  message: "Tienes dos citas: el sábado 24 a las 09:00 y el jueves 29 a las 11:00.",
  reservations: [
    { reservation_ref: "ref_a", date: "2026-10-24", time: "09:00", day_label: "sábado 24 de octubre", cancellable: true },
    { reservation_ref: "ref_b", date: "2026-10-29", time: "11:00", day_label: "jueves 29 de octubre", cancellable: true },
  ],
};
const NEW_LOOKUP = {
  outcome: "reservations_found",
  message: "Tienes una cita el jueves 15 de octubre a las 11:00 con Olga.",
  reservations: [
    { reservation_ref: "ref_new", date: "2026-10-15", time: "11:00", day_label: "jueves 15 de octubre", professional: "Olga", cancellable: true },
  ],
};

const call = (id: string, name: string, args = "{}") => ({ id, type: "function" as const, function: { name, arguments: args } });

/** An old WhatsApp conversation: both bookings looked up and cancelled. */
function oldConversation(): ChatMessage[] {
  return [
    { role: "user", content: "Quiero anular mis citas" },
    { role: "assistant", content: null, tool_calls: [call("c1", TOOL_MY_BOOKINGS)] },
    { role: "tool", tool_call_id: "c1", content: JSON.stringify(OLD_LOOKUP) },
    { role: "assistant", content: "Tienes dos citas. ¿Anulo las dos?" },
    { role: "user", content: "Sí, las dos" },
    { role: "assistant", content: null, tool_calls: [call("c2", TOOL_CANCEL, '{"reservation_ref":"ref_a","confirmed_by_customer":true}'), call("c3", TOOL_CANCEL, '{"reservation_ref":"ref_b","confirmed_by_customer":true}')] },
    { role: "tool", tool_call_id: "c2", content: JSON.stringify({ outcome: "cancelled", message: "Anulada la del sábado 24 a las 09:00." }) },
    { role: "tool", tool_call_id: "c3", content: JSON.stringify({ outcome: "cancelled", message: "Anulada la del jueves 29 a las 11:00." }) },
    { role: "assistant", content: "Las dos citas que tenías están anuladas: la del sábado 24 de octubre a las 09:00 y la del jueves 29 de octubre a las 11:00." },
  ];
}

/**
 * A model that answers from the LATEST booking information it can see, the
 * way the real one did: if no tool result carries a fresh note, it repeats its
 * own last sentence about bookings (the incident).
 */
function modelFromHistory(seen: ChatMessage[][]): LlmApi {
  return {
    async chat(messages) {
      seen.push(structuredClone(messages));
      const fresh = [...messages].reverse().find((m) => m.role === "tool" && JSON.parse(m.content).fresh_note) as { content: string } | undefined;
      if (fresh) return { content: JSON.parse(fresh.content).message as string, toolCalls: [] } satisfies ChatResult;
      const lastSaid = [...messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && /cita/.test(m.content)) as { content: string };
      return { content: lastSaid.content, toolCalls: [] };
    },
  };
}

function harness(opts: { selfService?: boolean; lookup?: () => Promise<Record<string, unknown>> } = {}) {
  const store = new MemorySessionStore();
  const s = store.load("cv_agenda01", Date.now());
  s.messages = oldConversation();
  store.save(s);
  const sent: string[] = [];
  const lookups: string[] = [];
  const vocero = {
    getContext: async () => ({ conversationId: "cv_agenda01", contactName: null, aiEnabled: true, windowOpen: true }),
    typing: async () => undefined,
    send: async (_c: string, text: string) => {
      sent.push(text);
      return "sent";
    },
    sendInteractive: async () => "sent",
    handoff: async () => true,
    setFicha: async () => true,
    knowledge: async () => "",
  } as unknown as VoceroApi;
  const middleware: MiddlewareApi = {
    availability: async () => ({}),
    book: async () => ({}),
    myReservations: async (phone) => {
      lookups.push(phone);
      return opts.lookup ? opts.lookup() : structuredClone(NEW_LOOKUP);
    },
    cancel: async () => ({}),
  };
  const seen: ChatMessage[][] = [];
  const deps: TurnDeps = {
    vocero,
    middleware,
    llm: modelFromHistory(seen),
    store,
    tools: buildToolDefinitions(),
    staticSystem: { role: "system", content: "STATIC" },
    bookingEnabled: true,
    selfServiceEnabled: opts.selfService ?? true,
    maxToolRounds: 5,
    log: silentLogger,
    retryDelayMs: 0,
  };
  const waId = "34600111222";
  const turn = (text: string) =>
    processTurn(deps, waId, [{ waId, messageId: `m${seen.length}`, timestamp: 1, type: "text", text, profileName: null }]);
  return { turn, sent, lookups, seen, store };
}

describe("a question about an existing booking reads Bruno's agenda in the same turn", () => {
  it("old cancelled bookings + a new booking made by phone → the answer is the new booking", async () => {
    const h = harness();
    expect(await h.turn("¿Cuándo era mi cita?")).toBe("answered");
    expect(h.lookups).toHaveLength(1);
    expect(h.sent).toEqual(["Tienes una cita el jueves 15 de octubre a las 11:00 con Olga."]);
    expect(h.sent[0]).not.toMatch(/anulad|24 de octubre|29 de octubre/);

    // What the model saw on its FIRST call: the fresh lookup right after the
    // question, and the old lookup/cancellations marked stale without their sentences.
    const first = h.seen[0]!;
    const last = first.at(-1) as { role: string; content: string };
    expect(last.role).toBe("tool");
    expect(JSON.parse(last.content)).toEqual({ ...NEW_LOOKUP, fresh_note: FRESH_LOOKUP_NOTE });
    const byId = (id: string) => JSON.parse((first.find((m) => m.role === "tool" && m.tool_call_id === id) as { content: string }).content);
    expect(byId("c1")).toMatchObject({ stale: true, stale_note: STALE_LOOKUP_NOTE });
    expect(byId("c1").message).toBeUndefined();
    expect(byId("c2")).toMatchObject({ outcome: "cancelled", stale: true, stale_note: STALE_CANCEL_NOTE });
    expect(byId("c3").message).toBeUndefined();
  });

  it("the fresh lookup becomes stale (and loses its note) on the next message", async () => {
    const h = harness();
    await h.turn("¿A qué hora tengo la cita?");
    await h.turn("vale gracias");
    const second = h.seen.at(-1)!;
    const prefetched = second.filter((m) => m.role === "tool").map((m) => JSON.parse((m as { content: string }).content));
    const mine = prefetched.find((r) => r.reservations?.[0]?.reservation_ref === "ref_new");
    expect(mine).toMatchObject({ stale: true, stale_note: STALE_LOOKUP_NOTE });
    expect(mine.fresh_note).toBeUndefined();
    expect(h.lookups).toHaveLength(1); // «vale gracias» does not read the agenda
  });

  it("no read when self-service is off, nor for a new booking request", async () => {
    const off = harness({ selfService: false });
    await off.turn("¿Cuándo era mi cita?");
    expect(off.lookups).toHaveLength(0);
    const on = harness();
    await on.turn("Quiero cita el martes por la tarde");
    expect(on.lookups).toHaveLength(0);
  });

  it("a failing read never fails the turn", async () => {
    const h = harness({
      lookup: async () => {
        throw new Error("timeout");
      },
    });
    expect(await h.turn("quiero anular la cita")).toBe("answered");
    expect(h.lookups).toHaveLength(1);
  });
});

describe("asksAboutExistingBookings", () => {
  it.each([
    "¿Cuándo era mi cita?",
    "cuando es mi cita",
    "¿A qué hora tengo?",
    "a que hora tenia la cita",
    "¿Qué día era?",
    "Quiero anular la cita",
    "Cancélame la del jueves",
    "¿Puedo cambiar la hora?",
    "No voy a poder ir mañana",
    "no puedo ir",
    "¿Tengo alguna cita?",
    "¿Qué citas tengo?",
    "¿Sigue en pie lo del jueves?",
    "La cita que tengo con Olga",
  ])("yes: %s", (t) => expect(asksAboutExistingBookings(t)).toBe(true));

  it.each(["Hola", "Quiero cita el martes por la tarde", "¿Tenéis hueco mañana?", "vale gracias", "Sí, a las 11", "Con Olga"])(
    "no: %s",
    (t) => expect(asksAboutExistingBookings(t)).toBe(false),
  );
});
