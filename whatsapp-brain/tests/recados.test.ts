import { describe, expect, it } from "vitest";
import { executeTool, TOOL_NOTIFY_OWNER, TOOL_LATE_ARRIVAL, type ToolSession } from "../src/tools.js";
import { MiddlewareClient, type MiddlewareApi, type RecadoBody } from "../src/middleware.js";
import { processTurn, type TurnDeps } from "../src/conversation.js";
import { createLogger, silentLogger } from "../src/log.js";
import { MemorySessionStore } from "../src/store.js";
import { buildToolDefinitions } from "../src/tools.js";
import type { ChatResult, LlmApi } from "../src/llm.js";
import type { VoceroApi, ConversationContext } from "../src/vocero.js";
import type { InboundMessage } from "../src/meta.js";

const QUEUED = "Le paso tu recado a Bruno y te atenderá a la mayor brevedad.";
const LATE_QUEUED = "Se lo paso a Bruno; si hay algún problema, te llamará.";
const OWNER_DEFAULT = "Le he dejado el aviso a Bruno. Te contestará en cuanto pueda.";
const LATE_DEFAULT = "Gracias por avisar. Te esperamos.";

function fakeMiddleware(recadoResult: Record<string, unknown> = { outcome: "recado_queued", message: QUEUED }) {
  const recados: { phone: string | null; body: RecadoBody }[] = [];
  const api: MiddlewareApi = {
    async availability() { return { outcome: "options" }; },
    async book() { return { outcome: "confirmed" }; },
    async myReservations() { return { outcome: "no_reservations" }; },
    async cancel() { return { outcome: "cancel_pending_owner" }; },
    async recado(phone, body) {
      recados.push({ phone, body });
      return recadoResult;
    },
  };
  return { api, recados };
}

const session = (over: Partial<ToolSession> = {}): ToolSession => ({
  middlewareConversationId: "wa_cv_abc_x1",
  spanishPhone: "600111222",
  bookingEnabled: true,
  selfServiceEnabled: true,
  voceroConversationId: "vc-123",
  ...over,
});

describe("avisar_a_owner sends a recado", () => {
  it("wants_human -> kind wants_human, server message, handoff kept", async () => {
    const m = fakeMiddleware();
    const s = session();
    const out = await executeTool(TOOL_NOTIFY_OWNER, { reason: "wants_human", summary: "Quiere hablar con Bruno." }, s, m.api);
    expect(m.recados[0]?.body).toMatchObject({ conversation_id: "wa_cv_abc_x1", kind: "wants_human", summary: "Quiere hablar con Bruno." });
    expect(out).toEqual({ outcome: "owner_notified", message: QUEUED });
    expect(s.pendingHandoff?.reason).toBe("wants_human");
  });

  it("maps reasons to kinds", async () => {
    for (const [reason, kind] of [["cancel_request", "question"], ["change_request", "question"], ["other", "question"], ["cannot_identify", "question"], ["reservation_not_found", "question"], ["complaint", "complaint"]] as const) {
      const m = fakeMiddleware();
      await executeTool(TOOL_NOTIFY_OWNER, { reason, summary: "x" }, session(), m.api);
      expect(m.recados[0]?.body.kind).toBe(kind);
    }
  });

  it.each(["recado_unavailable", "recado_dry_run"])("%s -> today's message and the handoff stays", async (outcome) => {
    const m = fakeMiddleware({ outcome, message: "Ahora mismo no he podido dejarle el recado a Bruno." });
    const s = session();
    const out = await executeTool(TOOL_NOTIFY_OWNER, { reason: "other", summary: "x" }, s, m.api);
    expect(out).toEqual({ outcome: "owner_notified", message: OWNER_DEFAULT });
    expect(s.pendingHandoff).toBeDefined();
  });

  it("a throwing recado call still answers owner_notified", async () => {
    const m = fakeMiddleware();
    m.api.recado = async () => { throw new Error("boom"); };
    const out = await executeTool(TOOL_NOTIFY_OWNER, { reason: "other", summary: "x" }, session(), m.api);
    expect(out).toEqual({ outcome: "owner_notified", message: OWNER_DEFAULT });
  });

  it("foreign number: no caller phone, callback_phone and name go in the body", async () => {
    const m = fakeMiddleware();
    await executeTool(TOOL_NOTIFY_OWNER, { reason: "wants_human", summary: "x", customer_name: "Ana", callback_phone: "+49 170 1234567" }, session({ spanishPhone: null }), m.api);
    expect(m.recados[0]?.phone).toBeNull();
    expect(m.recados[0]?.body).toMatchObject({ callback_phone: "+49 170 1234567", customer_name: "Ana" });
  });

  it("sends the Vocero conversation id", async () => {
    const m = fakeMiddleware();
    await executeTool(TOOL_NOTIFY_OWNER, { reason: "other", summary: "x" }, session(), m.api);
    expect(m.recados[0]?.body.vocero_conversation_id).toBe("vc-123");
  });
});

describe("notify_late_arrival sends a recado", () => {
  it("late with minutes, queued -> the server phrase", async () => {
    const m = fakeMiddleware({ outcome: "recado_queued", message: LATE_QUEUED });
    const s = session();
    const out = await executeTool(TOOL_LATE_ARRIVAL, { minutes_late: 10, summary: "Llego 10 minutos tarde" }, s, m.api);
    expect(m.recados[0]?.body).toMatchObject({ kind: "late", minutes_late: 10, summary: "Llego 10 minutos tarde" });
    expect(out).toEqual({ outcome: "late_arrival_recorded", message: LATE_QUEUED });
    expect(s.lateArrival).toEqual({ minutes: 10 });
    expect(s.pendingHandoff).toBeUndefined();
  });

  it("default summary, and today's message when not queued", async () => {
    const m = fakeMiddleware({ outcome: "recado_unavailable" });
    const out = await executeTool(TOOL_LATE_ARRIVAL, {}, session(), m.api);
    expect(m.recados[0]?.body.summary).toBe("Avisa de que llega tarde.");
    expect(m.recados[0]?.body.minutes_late).toBeUndefined();
    expect(out.message).toBe(LATE_DEFAULT);
  });
});

describe("MiddlewareClient.recado", () => {
  function client(respond: () => Response | Promise<Response>, secret: string | null = "w".repeat(32)) {
    const calls: { url: string; headers: Record<string, string>; body: unknown; signal?: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body ?? "null")), signal: init.signal });
      return respond();
    }) as unknown as typeof fetch;
    return { c: new MiddlewareClient("http://mw", "hook", "book", secret ?? undefined, fetchImpl), calls };
  }
  const body: RecadoBody = { conversation_id: "wa_cv_abc_x1", kind: "question", summary: "x" };

  it("posts to /ai/wa/recado with both secrets and the caller id", async () => {
    const { c, calls } = client(() => new Response(JSON.stringify({ outcome: "recado_queued", message: QUEUED })));
    expect((await c.recado("600111222", body)).outcome).toBe("recado_queued");
    expect(calls[0]?.url).toBe("http://mw/ai/wa/recado");
    expect(calls[0]?.headers["x-ai-webhook-secret"]).toBe("hook");
    expect(calls[0]?.headers["x-ai-wa-secret"]).toBe("w".repeat(32));
    expect(calls[0]?.headers["x-ai-wa-caller-id"]).toBe("+34600111222");
    expect(calls[0]?.body).toEqual(body);
    expect(calls[0]?.signal).toBeDefined(); // the 8 s cap
  });

  it("no caller id header for a foreign number", async () => {
    const { c, calls } = client(() => new Response(JSON.stringify({ outcome: "recado_queued" })));
    await c.recado(null, body);
    expect(calls[0]?.headers["x-ai-wa-caller-id"]).toBeUndefined();
  });

  it("a 500 without outcome is recado_unavailable; a network error too", async () => {
    const http = client(() => new Response(JSON.stringify({ success: false }), { status: 500 }));
    expect((await http.c.recado("600111222", body)).outcome).toBe("recado_unavailable");
    const net = client(() => Promise.reject(new Error("down")));
    expect((await net.c.recado("600111222", body)).outcome).toBe("recado_unavailable");
  });

  it("without the self-service secret there is no fetch", async () => {
    const { c, calls } = client(() => new Response("{}"), null);
    expect((await c.recado("600111222", body)).outcome).toBe("recado_unavailable");
    expect(calls).toHaveLength(0);
  });
});

describe("full turn", () => {
  function vocero(events: string[]): VoceroApi {
    const ctx: ConversationContext = { conversationId: "vc-xyz", contactName: null, aiEnabled: true, windowOpen: true };
    return {
      async getContext() { return ctx; },
      async typing() {},
      async send(_id: string, text: string) { events.push(`send:${text}`); return "sent" as const; },
      async sendInteractive() { return "sent"; },
      async handoff(_id: string, reason: string) { events.push(`handoff:${reason}`); return true; },
      async knowledge() { return "Dirección: Calle X"; },
      async setFicha(_id: string, ficha: Record<string, unknown>) { events.push(`ficha:${Object.keys(ficha).join(",")}`); return true; },
    } as unknown as VoceroApi;
  }
  const toolCall = (name: string, args: Record<string, unknown>) => ({ id: "c1", type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
  const msg: InboundMessage = { waId: "34600111222", messageId: "m1", timestamp: 1700000000, type: "text", text: "llego tarde, 10 min", profileName: "Ana" };

  it("late: ficha written, no handoff, the model sees the server phrase; the logger gets no phone or summary", async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const seen: unknown[][] = [];
    const script: ChatResult[] = [
      { content: null, toolCalls: [toolCall("notify_late_arrival", { minutes_late: 10, summary: "Llego diez minutos tarde" })] },
      { content: LATE_QUEUED, toolCalls: [] },
    ];
    const llm: LlmApi = { async chat(messages) { seen.push([...messages]); return script.shift()!; } };
    const m = fakeMiddleware({ outcome: "recado_queued", message: LATE_QUEUED });
    const deps: TurnDeps = {
      vocero: vocero(events), middleware: m.api, llm, store: new MemorySessionStore(), tools: buildToolDefinitions(),
      staticSystem: { role: "system", content: "STATIC" }, bookingEnabled: true, maxToolRounds: 5,
      log: createLogger({}, (l) => lines.push(l)), retryDelayMs: 0,
    };
    const out = await processTurn(deps, "34600111222", [msg]);
    expect(out).toBe("answered");
    expect(m.recados[0]?.body.vocero_conversation_id).toBe("vc-xyz");
    expect(events.some((e) => e.startsWith("ficha:") && e.includes("ultimo_aviso_retraso"))).toBe(true);
    expect(events.some((e) => e.startsWith("handoff"))).toBe(false);
    expect(JSON.stringify(seen[1])).toContain(LATE_QUEUED);
    expect(events).toContain(`send:${LATE_QUEUED}`);
    const logs = lines.join("\n");
    expect(logs).toContain("\"recado_outcome\":\"recado_queued\"");
    expect(logs).not.toContain("600111222");
    expect(logs).not.toContain("diez minutos");
    expect(logs).not.toContain("Ana");
    void silentLogger;
  });
});
