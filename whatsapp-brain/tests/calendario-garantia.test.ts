/**
 * 2026-10-11 — the calendar link is mandatory after every confirmed booking
 * (owner decision): a link that cannot be generated is recovered, retried
 * and, if it still fails, Bruno is told; the confirmation never waits for it.
 */
import { describe, expect, it } from "vitest";
import { processTurn, CALENDAR_LATER_LINE } from "../src/conversation.js";
import { MiddlewareClient } from "../src/middleware.js";
import type { ChatMessage } from "../src/llm.js";
import { LOCKED, URL1, bookCall, harness, historyWithSummary, inbound, silence, toolCall } from "./harness.js";

const CONFIRM = "Listo ✅ sábado 17 de octubre a las 09:30 con Olga.";
const confirmReply = { content: CONFIRM, toolCalls: [] };
const ok = (url: string) => async () => ({ outcome: "calendar_url", calendar_url: url });
const LINK_LINE = (url: string) => `Para añadir la cita a tu calendario: ${url}`;

describe("recovering the link of a confirmed booking", () => {
  it("a booking without calendar_url asks /ai/wa/calendar-link and the message carries confirmation + link", async () => {
    const h = harness({
      script: [bookCall(), confirmReply],
      messages: historyWithSummary(),
      book: async () => ({ outcome: "confirmed", booked: true }),
      calendarLink: ok("https://cal.test/recovered.ics"),
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.linkCalls).toHaveLength(1);
    expect(h.linkCalls[0]?.slot_token).toBe("tok-1");
    expect(h.linkCalls[0]?.conversation_id).toMatch(/^wa_cv_test0001_/);
    expect(h.events).toEqual([`send:${CONFIRM}\n\n${LINK_LINE("https://cal.test/recovered.ics")}`]);
  });

  it("an http:// link is treated as missing and recovered", async () => {
    const h = harness({
      script: [bookCall(), confirmReply],
      messages: historyWithSummary(),
      book: async () => ({ outcome: "confirmed", booked: true, calendar_url: "http://insecure.test/a.ics" }),
      calendarLink: ok("https://cal.test/recovered.ics"),
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.events[0]).toContain("https://cal.test/recovered.ics");
    expect(h.events[0]).not.toContain("http://insecure");
  });

  it("a replayed booking without a link is recovered as well", async () => {
    const h = harness({
      script: [bookCall(), confirmReply],
      messages: historyWithSummary(),
      book: async () => ({ outcome: "confirmed", booked: true, idempotency_status: "replayed" }),
      calendarLink: ok("https://cal.test/replay.ics"),
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.linkCalls).toHaveLength(1);
    expect(h.events[0]).toContain("https://cal.test/replay.ics");
  });

  it("when the model stays silent after booking, the fixed text (day, hour, professional) goes out with the link", async () => {
    const h = harness({ script: [bookCall(), silence], messages: historyWithSummary() });
    const out = await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(out).toBe("answered");
    expect(h.events).toEqual([
      "send:Tu cita queda reservada para el sábado 17 de octubre a las 09:30 con Olga.\n" +
        "Si necesitas algo más, escríbenos y la peluquería te contesta por aquí.\n\n" +
        LINK_LINE(URL1),
    ]);
  });

  it("when the model's text leaves out the hour, the fixed text replaces it", async () => {
    const h = harness({ script: [bookCall(), { content: "Listo ✅ ya está.", toolCalls: [] }], messages: historyWithSummary() });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.events[0]).toContain("a las 09:30 con Olga");
    expect(h.events[0]).not.toContain("ya está");
  });

  it("two bookings in one turn: each link line says which appointment it is for", async () => {
    const second = { ...LOCKED, slot: { ...LOCKED.slot, date: "2026-10-24", time: "10:00", slot_token: "tok-2" } };
    const messages: ChatMessage[] = [
      ...historyWithSummary(),
      { role: "assistant", content: null, tool_calls: [toolCall("l2", "booking_availability_balanced_v2", { action: "lock", option_index: 1 })] },
      { role: "tool", tool_call_id: "l2", content: JSON.stringify(second) },
      { role: "assistant", content: "Resumen de la segunda. ¿Te la reservo? Responde «sí» y queda hecha." },
    ];
    const urls = ["https://cal.test/a1.ics", "https://cal.test/a2.ics"];
    const h = harness({
      script: [
        { content: null, toolCalls: [bookCall("b1", "tok-1").toolCalls[0]!, bookCall("b2", "tok-2").toolCalls[0]!] },
        { content: "Listo ✅ las dos: 09:30 y 10:00.", toolCalls: [] },
      ],
      messages,
      book: async (body) => ({ outcome: "confirmed", booked: true, calendar_url: urls[body.slot_token === "tok-1" ? 0 : 1] }),
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.events[0]).toContain("Para añadir la cita del sábado 17 de octubre a las 09:30 a tu calendario: https://cal.test/a1.ics");
    expect(h.events[0]).toContain("Para añadir la cita del sábado 24 de octubre a las 10:00 a tu calendario: https://cal.test/a2.ics");
  });
});

describe("the link cannot be had: the confirmation goes out anyway", () => {
  it("confirmation + «en un momento», log, recado to Bruno, and the link goes out in the next turn", async () => {
    let up = false;
    const h = harness({
      script: [bookCall(), confirmReply, { content: "<silencio>", toolCalls: [] }],
      messages: historyWithSummary(),
      book: async () => ({ outcome: "confirmed", booked: true }),
      calendarLink: async () => (up ? { outcome: "calendar_url", calendar_url: "https://cal.test/late.ics" } : { outcome: "calendar_unavailable" }),
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.linkCalls).toHaveLength(2); // two attempts
    expect(h.events).toEqual([`send:${CONFIRM}\n\n${CALENDAR_LATER_LINE}`]);
    expect(h.recados).toHaveLength(1);
    expect(h.recados[0]?.kind).toBe("question");
    expect(h.recados[0]?.summary).toContain("enlace del calendario");
    expect(JSON.stringify(h.recados)).not.toMatch(/Ana|600111222/);

    up = true;
    h.events.length = 0;
    await processTurn(h.deps, "34600111222", inbound("gracias"));
    expect(h.events).toEqual(["send:Para añadir la cita del sábado 17 de octubre a las 09:30 a tu calendario: https://cal.test/late.ics"]);
    // Sent once: a third turn has nothing pending any more.
    const linkCallsAfter = h.linkCalls.length;
    h.deps.llm = { async chat() { return silence; } };
    await processTurn(h.deps, "34600111222", inbound("vale"));
    expect(h.linkCalls).toHaveLength(linkCallsAfter);
  });

  it("a client without calendarLink behaves as unavailable (confirmation still goes out)", async () => {
    const h = harness({
      script: [bookCall(), confirmReply],
      messages: historyWithSummary(),
      book: async () => ({ outcome: "confirmed", booked: true }),
      calendarLink: "none",
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.events).toEqual([`send:${CONFIRM}\n\n${CALENDAR_LATER_LINE}`]);
  });

  it("the timer retry sends the link after calendarRetryMs", async () => {
    let up = false;
    const h = harness({
      script: [bookCall(), confirmReply],
      messages: historyWithSummary(),
      book: async () => ({ outcome: "confirmed", booked: true }),
      calendarLink: async () => (up ? { outcome: "calendar_url", calendar_url: "https://cal.test/timer.ics" } : { outcome: "calendar_unavailable" }),
      calendarRetryMs: 20,
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    up = true;
    await new Promise((r) => setTimeout(r, 120));
    expect(h.events.at(-1)).toBe("send:Para añadir la cita del sábado 17 de octubre a las 09:30 a tu calendario: https://cal.test/timer.ics");
    expect(h.store.load("cv_test0001", Date.now()).pendingCalendar).toEqual([]);
  });
});

describe("the confirmation does not reach the customer", () => {
  it("Vocero «failed»: three attempts, then a note on the ficha and a recado for Bruno", async () => {
    const h = harness({ script: [bookCall(), confirmReply], messages: historyWithSummary(), sendResults: ["failed"] });
    const out = await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(out).toBe("answered");
    expect(h.events.filter((e) => e.startsWith("send:"))).toHaveLength(3);
    expect(String(h.fichas[0]?.aviso_para_owner)).toContain("el cliente no ha recibido la confirmación");
    expect(String(h.fichas[0]?.aviso_para_owner)).toContain("sábado 17 de octubre a las 09:30");
    expect(h.recados).toHaveLength(1);
    expect(JSON.stringify([h.fichas, h.recados])).not.toMatch(/Ana|600111222/);
  });

  it("a send that works on the second try needs no note", async () => {
    const h = harness({ script: [bookCall(), confirmReply], messages: historyWithSummary(), sendResults: ["failed", "sent"] });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(h.events.filter((e) => e.startsWith("send:"))).toHaveLength(2);
    expect(h.fichas).toHaveLength(0);
    expect(h.recados).toHaveLength(0);
  });

  it("ai_paused: ficha + recado, no more sends", async () => {
    const h = harness({ script: [bookCall(), confirmReply], messages: historyWithSummary(), sendResults: ["ai_paused"] });
    const out = await processTurn(h.deps, "34600111222", inbound("sí"));
    expect(out).toBe("skipped_human");
    expect(h.events.filter((e) => e.startsWith("send:"))).toHaveLength(1);
    expect(h.fichas).toHaveLength(1);
    expect(h.recados).toHaveLength(1);
  });
});

describe("MiddlewareClient.calendarLink", () => {
  type Call = { url: string; headers: Record<string, string>; body: unknown };
  function client(respond: () => Response | Promise<Response>, secret: string | null = "w".repeat(32)) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body ?? "null")) });
      return respond();
    }) as unknown as typeof fetch;
    return { c: new MiddlewareClient("http://mw", "hook", "book", secret ?? undefined, fetchImpl), calls };
  }
  const body = { conversation_id: "wa_cv_1_x", slot_token: "tok-1" };

  it("posts the conversation id and the token with the /ai/wa secrets", async () => {
    const { c, calls } = client(() => new Response(JSON.stringify({ outcome: "calendar_url", calendar_url: URL1 })));
    expect((await c.calendarLink("600111222", body)).calendar_url).toBe(URL1);
    expect(calls[0]?.url).toBe("http://mw/ai/wa/calendar-link");
    expect(calls[0]?.headers["x-ai-webhook-secret"]).toBe("hook");
    expect(calls[0]?.headers["x-ai-wa-secret"]).toBe("w".repeat(32));
    expect(calls[0]?.headers["x-ai-wa-caller-id"]).toBe("+34600111222");
    expect(calls[0]?.body).toEqual(body);
  });

  it("every failure is calendar_unavailable; without the secret nothing is sent", async () => {
    for (const r of [() => Promise.reject(new Error("down")), () => new Response("{}", { status: 500 }), () => new Response("<html>", { status: 502 })]) {
      expect((await client(r).c.calendarLink("600111222", body)).outcome).toBe("calendar_unavailable");
    }
    const none = client(() => new Response("{}"), null);
    expect((await none.c.calendarLink("600111222", body)).outcome).toBe("calendar_unavailable");
    expect(none.calls).toHaveLength(0);
  });
});

describe("late link is never sent twice", () => {
  it("the timer and a customer turn at the same time send it once", async () => {
    let up = false;
    const h = harness({
      script: [bookCall(), confirmReply, silence],
      messages: historyWithSummary(),
      book: async () => ({ outcome: "confirmed", booked: true }),
      calendarLink: async () => (up ? { outcome: "calendar_url", calendar_url: "https://cal.test/once.ics" } : { outcome: "calendar_unavailable" }),
      calendarRetryMs: 20,
    });
    await processTurn(h.deps, "34600111222", inbound("sí"));
    up = true;
    h.deps.vocero.send = async (_c, text) => {
      h.events.push(`send:${text}`);
      await new Promise((r) => setTimeout(r, 80));
      return "sent";
    };
    await new Promise((r) => setTimeout(r, 40)); // the timer is now sending
    await processTurn(h.deps, "34600111222", inbound("gracias"));
    await new Promise((r) => setTimeout(r, 150));
    expect(h.events.filter((e) => e.includes("once.ics"))).toHaveLength(1);
  });
});
