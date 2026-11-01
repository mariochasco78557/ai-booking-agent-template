/**
 * 2026-10-11 ((internal doc, not included in the template), bloque 2): the brain changes
 * ONLY the service of an appointment with `booking_cambiar_servicio`, never via
 * DISPONIBILIDAD. Synthetic data only.
 */
import { describe, expect, it, vi } from "vitest";
import { markStaleLookups, processTurn, STALE_CHANGE_SERVICE_NOTE } from "../src/conversation.js";
import type { ChatMessage } from "../src/llm.js";
import { MiddlewareClient } from "../src/middleware.js";
import { buildToolDefinitions, executeTool, TOOL_CHANGE_SERVICE, type ToolSession } from "../src/tools.js";
import { harness, inbound, toolCall } from "./harness.js";

const QUESTION =
  "¿Cambio tu cita del sábado 10 de octubre a las 13:30 con Ramón de corte y barba a corte de pelo? Misma hora y mismo profesional. Responde «sí».";
const DONE = "Listo ✅ tu cita del sábado 10 de octubre a las 13:30 con Ramón queda como corte de pelo.";
const REF = "r1.SYNTHETICREFERENCE";

const session = (over: Partial<ToolSession> = {}): ToolSession => ({
  middlewareConversationId: "wa_cv_abc_x1",
  spanishPhone: "600111222",
  bookingEnabled: true,
  selfServiceEnabled: true,
  ...over,
});

describe("booking_cambiar_servicio: schema and dispatch", () => {
  it("is exposed and dispatches to the middleware with the verified caller, dropping foreign fields", async () => {
    const defs = buildToolDefinitions();
    const def = defs.find((d) => d.function.name === TOOL_CHANGE_SERVICE)!;
    expect(def).toBeDefined();
    const props = (def.function.parameters.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["reservation_ref", "service_id", "confirmed_by_customer"]));
    expect(props.conversation_id).toBeUndefined();

    const changeService = vi.fn(async () => ({ outcome: "confirm_required", message: QUESTION }));
    const out = await executeTool(
      TOOL_CHANGE_SERVICE,
      { reservation_ref: REF, service_id: 1, phone: "699999999", confirmed_by_customer: "true" },
      session(),
      { changeService } as never,
    );
    expect(out.outcome).toBe("confirm_required");
    expect(changeService).toHaveBeenCalledWith("600111222", {
      reservation_ref: REF,
      service_id: 1,
      confirmed_by_customer: false,
      conversation_id: "wa_cv_abc_x1",
    });
  });

  it("the client posts /ai/wa/change-service with the caller header", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ outcome: "confirm_required", message: QUESTION }), { status: 200 });
    }) as never;
    try {
      const client = new MiddlewareClient("https://mw.test", "web-secret", "book-secret", "wa-secret");
      const r = await client.changeService("600111222", { reservation_ref: REF, service_id: 1, confirmed_by_customer: false });
      expect(r.outcome).toBe("confirm_required");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen[0]!.url).toBe("https://mw.test/ai/wa/change-service");
    expect(seen[0]!.headers["x-ai-wa-caller-id"]).toBe("+34600111222");
    expect(seen[0]!.headers["x-ai-wa-secret"]).toBe("wa-secret");
  });

  it("without the method or the self-service secret it answers service_change_unavailable (falls back to the notice)", async () => {
    const a = await executeTool(TOOL_CHANGE_SERVICE, { reservation_ref: REF, service_id: 1 }, session(), {} as never);
    expect(a.outcome).toBe("service_change_unavailable");
    const b = await executeTool(TOOL_CHANGE_SERVICE, { reservation_ref: REF, service_id: 1 }, session({ selfServiceEnabled: false }), {
      changeService: vi.fn(),
    } as never);
    expect(b.outcome).toBe("service_change_unavailable");
  });

  it("the reference never reaches the customer: the tool result has none and a stale result loses its message", async () => {
    const out = await executeTool(TOOL_CHANGE_SERVICE, { reservation_ref: REF, service_id: 1 }, session(), {
      changeService: async () => ({ outcome: "confirm_required", message: QUESTION }),
    } as never);
    expect(JSON.stringify(out)).not.toContain("r1.");

    const history: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [toolCall("c1", TOOL_CHANGE_SERVICE, { reservation_ref: REF, service_id: 1 })] },
      { role: "tool", tool_call_id: "c1", content: JSON.stringify({ outcome: "service_changed", message: DONE }) },
    ];
    const stale = markStaleLookups(history);
    expect(JSON.parse((stale[1] as { content: string }).content)).toMatchObject({
      outcome: "service_changed",
      stale: true,
      stale_note: STALE_CHANGE_SERVICE_NOTE,
    });
    expect((stale[1] as { content: string }).content).not.toContain("Listo");
  });
});

describe("simulation: «solo corte» -> question -> «sí» -> service_changed", () => {
  const first = { content: null, toolCalls: [toolCall("k1", TOOL_CHANGE_SERVICE, { reservation_ref: REF, service_id: 1 })] };
  const second = { content: null, toolCalls: [toolCall("k2", TOOL_CHANGE_SERVICE, { reservation_ref: REF, service_id: 1, confirmed_by_customer: true })] };

  it("asks, then changes after the yes, without any DISPONIBILIDAD call", async () => {
    const availability = vi.fn(async () => ({ outcome: "options" }));
    const changeService = vi.fn(async (_p: string, b: { confirmed_by_customer: boolean }) =>
      b.confirmed_by_customer ? { outcome: "service_changed", message: DONE } : { outcome: "confirm_required", message: QUESTION },
    );
    const h = harness({
      script: [first, { content: QUESTION, toolCalls: [] }, second, { content: DONE, toolCalls: [] }],
      availability,
      changeService,
    });
    h.deps.selfServiceEnabled = true;
    await processTurn(h.deps, "34600111222", inbound("¿puedes dejarla solo en corte?"));
    expect(h.events).toEqual([`send:${QUESTION}`]);
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.events).toContain(`send:${DONE}`);
    expect(changeService).toHaveBeenCalledTimes(2);
    expect(availability).not.toHaveBeenCalled();
  });

  it("without a «sí» there is no second call", async () => {
    const changeService = vi.fn(async () => ({ outcome: "confirm_required", message: QUESTION }));
    const h = harness({
      script: [first, { content: QUESTION, toolCalls: [] }, { content: "De acuerdo, la cita sigue como estaba.", toolCalls: [] }],
      changeService,
    });
    h.deps.selfServiceEnabled = true;
    await processTurn(h.deps, "34600111222", inbound("¿puedes dejarla solo en corte?"));
    await processTurn(h.deps, "34600111222", inbound("mejor no"));
    expect(changeService).toHaveBeenCalledTimes(1);
  });

  it("own_booking_at_time is copied as the server wrote it", async () => {
    const msg = "A esa hora ya tienes tu cita del sábado 10 de octubre a las 13:30 con Ramón. ¿Quieres cambiarle el servicio o prefieres otra hora?";
    const h = harness({
      script: [
        { content: null, toolCalls: [toolCall("d1", "booking_availability_balanced_v2", { action: "discover", date: "2026-10-10", preferred_time: "13:30" })] },
        { content: msg, toolCalls: [] },
      ],
      availability: async () => ({ outcome: "own_booking_at_time", message: msg }),
    });
    await processTurn(h.deps, "34600111222", inbound("¿hay hueco el sábado a las 13:30?"));
    expect(h.events).toEqual([`send:${msg}`]);
  });
});
