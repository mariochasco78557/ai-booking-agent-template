import { describe, expect, it } from "vitest";
import {
  buildInteractive,
  matchMentionedSlots,
  collectOfferedSlots,
  buildPageList,
  collectPage,
  withListTapHint,
  type OfferedSlot,
  type LatestPage,
} from "../src/interactive.js";
import { processTurn, FALLBACK_REPLY, type TurnDeps } from "../src/conversation.js";
import { VoceroClient, type VoceroApi } from "../src/vocero.js";
import { loadConfig } from "../src/config.js";
import type { ChatResult, LlmApi } from "../src/llm.js";
import type { MiddlewareApi } from "../src/middleware.js";
import { MemorySessionStore } from "../src/store.js";
import { buildToolDefinitions } from "../src/tools.js";
import { silentLogger } from "../src/log.js";
import type { InboundMessage } from "../src/meta.js";

const slot = (time: string, date = "2026-10-13", professional?: string): OfferedSlot => ({ date, time, ...(professional ? { professional } : {}) });
const hours = (n: number) => Array.from({ length: n }, (_, i) => slot(`${String(9 + i).padStart(2, "0")}:00`));
const textFor = (list: OfferedSlot[]) => `Tengo ${list.map((s) => s.time).join(", ")}. ¿Cuál te viene bien?`;

describe("matching hours in the reply", () => {
  it("orders by position in the text, not by offer order", () => {
    const m = matchMentionedSlots("Mejor a las 11:00 o a las 10:00", hours(4));
    expect(m.map((s) => s.time)).toEqual(["11:00", "10:00"]);
  });
  it("ignores hours that were not offered and repeats", () => {
    const m = matchMentionedSlots("A las 10:00, 10:00 o 23:30", hours(4));
    expect(m.map((s) => s.time)).toEqual(["10:00"]);
  });
  it("accepts 9.30 and 9:30 as the same", () => {
    expect(matchMentionedSlots("a las 9.30", [slot("09:30")]).length).toBe(1);
  });
  it("uses the weekday, then the professional, to disambiguate", () => {
    const offered = [slot("11:00", "2026-10-13"), slot("11:00", "2026-10-15")];
    expect(matchMentionedSlots("El jueves a las 11:00", offered)[0]!.date).toBe("2026-10-15");
    const pros = [slot("11:00", "2026-10-13", "Bruno"), slot("11:00", "2026-10-13", "Olga")];
    expect(matchMentionedSlots("11:00 con Bruno", pros)[0]!.professional).toBe("Bruno");
  });
  it("collects options from a tool answer and skips junk", () => {
    const got = collectOfferedSlots({ options: [{ date: "2026-10-13", time: "9:30" }, { date: "x", time: "10:00" }, null] });
    expect(got).toEqual([{ date: "2026-10-13", time: "09:30" }]);
  });
});

describe("buildInteractive", () => {
  it("1 to 3 hours are reply buttons with the body untouched", () => {
    const text = textFor(hours(3));
    const i = buildInteractive(text, hours(5))!;
    expect(i.type).toBe("button");
    expect(i.body.text).toBe(text);
    if (i.type !== "button") throw new Error();
    expect(i.action.buttons.map((b) => b.reply.title)).toEqual(["09:00", "10:00", "11:00"]);
    expect(i.action.buttons[0]!.reply.id).toBe("slot:2026-10-13T09:00:");
  });
  it("4 to 10 hours are a list with «Ver horas»", () => {
    const i = buildInteractive(textFor(hours(4)), hours(4))!;
    expect(i.type).toBe("list");
    if (i.type !== "list") throw new Error();
    expect(i.action.button).toBe("Ver horas");
    expect(i.action.sections[0]!.rows).toHaveLength(4);
  });
  it("caps at 10, keeping text order", () => {
    const i = buildInteractive(textFor(hours(12)), hours(12))!;
    if (i.type !== "list") throw new Error();
    const rows = i.action.sections[0]!.rows;
    expect(rows).toHaveLength(10);
    expect(rows[9]!.title).toBe("18:00");
  });
  it("labels the day when several days are offered, within title limits", () => {
    const offered = [slot("11:00", "2026-10-13", "Olga"), slot("17:00", "2026-10-15", "Ramón")];
    const i = buildInteractive("Martes 11:00 con Olga o jueves 17:00 con Ramón", offered)!;
    if (i.type !== "button") throw new Error();
    const titles = i.action.buttons.map((b) => b.reply.title);
    expect(titles).toEqual(["Mar 13 · 11:00 Olga", "Jue 15 · 17:00 Ramón"]);
    for (const t of titles) expect(t.length).toBeLessThanOrEqual(20);
  });
  it("titles and ids are unique and within limits", () => {
    const offered = [slot("11:00", "2026-10-13", "Olga"), slot("11:00", "2026-10-13", "Bruno")];
    const i = buildInteractive("11:00 con Olga y 11:00 con Bruno", offered)!;
    if (i.type !== "button") throw new Error();
    const ids = i.action.buttons.map((b) => b.reply.id);
    expect(new Set(ids).size).toBe(ids.length);
    const longPro = buildInteractive("11:00", [slot("11:00", "2026-10-13", "Maria de los Angeles Fernandez".repeat(20))])!;
    if (longPro.type !== "button") throw new Error();
    expect(longPro.action.buttons[0]!.reply.title.length).toBeLessThanOrEqual(20);
    expect(longPro.action.buttons[0]!.reply.id.length).toBeLessThanOrEqual(200);
  });
  it("null when no offered hour is mentioned or the body is too long", () => {
    expect(buildInteractive("Hola", hours(3))).toBeNull();
    expect(buildInteractive(`${"a".repeat(1100)} 09:00`, hours(3))).toBeNull();
    expect(buildInteractive(`${"a".repeat(1100)} ${textFor(hours(5))}`, hours(5))).not.toBeNull();
  });
});

function vocero(sendResult: "sent" | "ai_paused" = "sent") {
  const events: string[] = [];
  const api: VoceroApi = {
    async getContext() {
      return { conversationId: "cv_test0001", contactName: null, aiEnabled: true, windowOpen: true };
    },
    async typing() {},
    async send(_c, t) {
      events.push(`send:${t}`);
      return sendResult;
    },
    async sendInteractive(_c, i) {
      events.push(`interactive:${i.type}`);
      return sendResult;
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
  return { api, events };
}

const msg: InboundMessage = { waId: "34600111222", messageId: "m1", timestamp: 1, type: "text", text: "hola", profileName: "Ana" };
const call = (id: string, name: string, args: object) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

function setup(script: ChatResult[], over: Partial<TurnDeps> = {}, mw: Partial<MiddlewareApi> = {}) {
  const q = [...script];
  const llm: LlmApi = {
    async chat() {
      return q.shift()!;
    },
  };
  const middleware: MiddlewareApi = {
    async availability() {
      return { outcome: "options_available", options: [{ option_index: 1, date: "2026-10-13", time: "11:00" }, { option_index: 2, date: "2026-10-13", time: "12:00" }] };
    },
    async book() {
      return { outcome: "confirmed", booked: true };
    },
    async myReservations() {
      return {};
    },
    async cancel() {
      return {};
    },
    ...mw,
  };
  const v = vocero();
  const deps: TurnDeps = {
    vocero: v.api,
    middleware,
    llm,
    store: new MemorySessionStore(),
    tools: buildToolDefinitions(),
    staticSystem: { role: "system", content: "S" },
    bookingEnabled: true,
    interactive: true,
    maxToolRounds: 5,
    log: silentLogger,
    retryDelayMs: 0,
    ...over,
  };
  return { deps, v };
}

const availTurn = (reply: string | null): ChatResult[] => [
  { content: null, toolCalls: [call("c1", "booking_availability_balanced_v2", { action: "discover", date: "2026-10-13" })] },
  { content: reply, toolCalls: [] },
];

describe("interactive in a turn", () => {
  it("sends buttons when the reply mentions offered hours", async () => {
    const { deps, v } = setup(availTurn("Tengo a las 11:00 o a las 12:00. ¿Cuál te viene bien?"));
    await processTurn(deps, "34600111222", [msg]);
    expect(v.events).toEqual(["interactive:button"]);
  });
  it("flag off behaves as today: plain text only", async () => {
    const { deps, v } = setup(availTurn("Tengo a las 11:00 o a las 12:00."), { interactive: false });
    await processTurn(deps, "34600111222", [msg]);
    expect(v.events).toEqual(["send:Tengo a las 11:00 o a las 12:00."]);
  });
  it("plain text if the reply mentions no offered hour", async () => {
    const { deps, v } = setup(availTurn("¿Qué día prefieres?"));
    await processTurn(deps, "34600111222", [msg]);
    expect(v.events).toEqual(["send:¿Qué día prefieres?"]);
  });
  it("no buttons on a confirmation (even with calendar link)", async () => {
    const { deps, v } = setup(
      [
        ...availTurn(null).slice(0, 1),
        { content: null, toolCalls: [call("c2", "booking_create_booking_balanced_v2", { slot_token: "t" })] },
        { content: "Hecho: martes a las 11:00.", toolCalls: [] },
      ],
      {},
      { async book() { return { outcome: "confirmed", booked: true, calendar_url: "https://cal.test/a.ics" }; } }
    );
    await processTurn(deps, "34600111222", [msg]);
    expect(v.events).toHaveLength(1);
    expect(v.events[0]).toMatch(/^send:Hecho/);
  });
  it("no buttons when a booking was confirmed even without a link", async () => {
    const { deps, v } = setup([
      ...availTurn(null).slice(0, 1),
      { content: null, toolCalls: [call("c2", "booking_create_booking_balanced_v2", { slot_token: "t" })] },
      { content: "Hecho: martes a las 11:00.", toolCalls: [] },
    ]);
    await processTurn(deps, "34600111222", [msg]);
    // No link could be had: the confirmation still goes out (plain text), with the «en un momento» line.
    expect(v.events).toEqual(["send:Hecho: martes a las 11:00.\n\nEl enlace para tu calendario te llega en un momento."]);
  });
  it("no buttons on silence or on the fallback", async () => {
    const a = setup(availTurn("<silencio>"));
    await processTurn(a.deps, "34600111222", [msg]);
    expect(a.v.events).toEqual([]);
    const b = setup([{ content: null, toolCalls: [call("c1", "booking_availability_balanced_v2", { action: "discover", date: "2026-10-13" })] }]);
    await processTurn({ ...b.deps, maxToolRounds: 0 }, "34600111222", [msg]);
    expect(b.v.events).toEqual([`send:${FALLBACK_REPLY}`]);
  });
});

describe("VoceroClient.sendInteractive", () => {
  const i = buildInteractive("Tengo 11:00 o 12:00", [slot("11:00"), slot("12:00")])!;
  const run = async (responses: { status: number; body: unknown }[]) => {
    const bodies: unknown[] = [];
    const f = (async (_u: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    const warns: string[] = [];
    const log = { ...silentLogger, warn: (e: string) => void warns.push(e) };
    const c = new VoceroClient("http://v", "k".repeat(20), f, 1000, 60, log);
    return { result: await c.sendInteractive("cv1", i), bodies, warns };
  };
  it("posts the interactive body", async () => {
    const r = await run([{ status: 200, body: {} }]);
    expect(r.result).toBe("sent");
    expect(r.bodies).toEqual([{ conversationId: "cv1", interactive: i }]);
  });
  it("falls back once to plain text on 422", async () => {
    const r = await run([{ status: 422, body: { error: "invalid_body" } }, { status: 200, body: {} }]);
    expect(r.result).toBe("sent");
    expect(r.bodies[1]).toEqual({ conversationId: "cv1", text: "Tengo 11:00 o 12:00" });
    expect(r.warns).toEqual(["vocero.interactive_fallback"]);
  });
  it("does not fall back when AI is paused or the window is closed", async () => {
    const a = await run([{ status: 409, body: { error: "ai_paused" } }]);
    expect(a.result).toBe("ai_paused");
    expect(a.bodies).toHaveLength(1);
    const b = await run([{ status: 409, body: { error: "window_closed" } }]);
    expect(b.result).toBe("window_closed");
  });
});

describe("BRAIN_INTERACTIVE config", () => {
  it("defaults to off and accepts on", () => {
    expect(loadConfig({}).interactive).toBe(false);
    expect(loadConfig({ BRAIN_INTERACTIVE: "on" }).interactive).toBe(true);
    expect(() => loadConfig({ BRAIN_INTERACTIVE: "maybe" })).toThrow();
  });
});

// ── Whole page as a list (owner request 2026-10-08) ─────────────────────────

const pageOf = (times: string[], hasMore = false, date = "2026-10-13"): LatestPage => ({
  options: times.map((time, i) => ({ optionIndex: i + 1, date, time })),
  hasMore,
});
const AFTERNOON = ["15:00", "15:30", "16:00", "16:30", "17:00", "17:30"];
const SUMMARY = "El martes por la tarde tengo libres de 15:00 a 17:30. ¿Cuál te viene bien?";

describe("buildPageList", () => {
  it("4+ options: a list of ALL of them in page order, even if the text names only two", () => {
    const list = buildPageList(SUMMARY, pageOf(AFTERNOON))!;
    expect(list.interactive.type).toBe("list");
    if (list.interactive.type !== "list") throw new Error();
    expect(list.interactive.action.button).toBe("Ver horas");
    expect(list.interactive.body.text).toBe(SUMMARY);
    expect(list.interactive.action.sections[0]!.rows.map((r) => r.title)).toEqual(AFTERNOON);
    expect(list.fallbackText).toBe(`${SUMMARY}\n\nHoras libres: 15:00, 15:30, 16:00, 16:30, 17:00, 17:30`);
  });
  it("adds «Más horas» last when the middleware says has_more", () => {
    const list = buildPageList(SUMMARY, pageOf(AFTERNOON, true))!;
    if (list.interactive.type !== "list") throw new Error();
    const rows = list.interactive.action.sections[0]!.rows;
    expect(rows.at(-1)).toEqual({ id: "more", title: "Más horas" });
    expect(list.rows.at(-1)).toEqual({ title: "Más horas", more: true });
    // The fallback lists hours only.
    expect(list.fallbackText.endsWith("17:30")).toBe(true);
  });
  it("never drops an offered hour for «Más horas»: ten options fill the list", () => {
    const ten = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"];
    const list = buildPageList(SUMMARY, pageOf(ten, true))!;
    if (list.interactive.type !== "list") throw new Error();
    expect(list.interactive.action.sections[0]!.rows.map((r) => r.title)).toEqual(ten);
  });
  it("labels the day when the page spans several days", () => {
    const page: LatestPage = {
      options: [
        { optionIndex: 1, date: "2026-10-13", time: "17:00" },
        { optionIndex: 2, date: "2026-10-13", time: "18:00" },
        { optionIndex: 3, date: "2026-10-14", time: "17:00" },
        { optionIndex: 4, date: "2026-10-15", time: "17:30" },
      ],
      hasMore: false,
    };
    const list = buildPageList("Tengo varias tardes. ¿Cuál te viene bien?", page)!;
    expect(list.rows.map((r) => r.title)).toEqual(["Mar 13 · 17:00", "Mar 13 · 18:00", "Mié 14 · 17:00", "Jue 15 · 17:30"]);
  });
  it("1–3 options are not a page list (buttons as before)", () => {
    expect(buildPageList(SUMMARY, pageOf(["15:00", "16:00", "17:00"]))).toBeNull();
    expect(buildPageList(SUMMARY, undefined)).toBeNull();
  });
  it("reads options and has_more from a middleware answer", () => {
    const page = collectPage({ options: [{ option_index: 4, date: "2026-10-13", time: "9:30" }, { time: "x" }], has_more: true });
    expect(page).toEqual({ options: [{ optionIndex: 4, date: "2026-10-13", time: "09:30" }], hasMore: true });
  });
});

describe("withListTapHint", () => {
  const rows = buildPageList(SUMMARY, pageOf(AFTERNOON, true))!.rows;
  it("maps a tapped hour to its option_index of the current page", () => {
    const hinted = withListTapHint("16:30", rows);
    expect(hinted.startsWith("16:30\n[")).toBe(true);
    expect(hinted).toContain("option_index 4");
    expect(hinted).toContain("2026-10-13 16:30");
  });
  it("maps «Más horas» to action more", () => {
    expect(withListTapHint("más horas", rows)).toContain('action "more"');
  });
  it("leaves any other text alone", () => {
    expect(withListTapHint("mejor el jueves", rows)).toBe("mejor el jueves");
    expect(withListTapHint("16:30", undefined)).toBe("16:30");
  });
});

describe("whole page as a list, in a turn", () => {
  const six = (hasMore: boolean) => async () => ({
    outcome: "options_available",
    has_more: hasMore,
    options: AFTERNOON.map((time, i) => ({ option_index: i + 1, date: "2026-10-13", time })),
  });

  it("sends a list of every option with the fallback, and a tap next turn reaches lock with the right index", async () => {
    const seen: unknown[][] = [];
    const script: ChatResult[] = [
      { content: null, toolCalls: [call("c1", "booking_availability_balanced_v2", { action: "discover", date: "2026-10-13", time_period: "afternoon", service_id: 0 })] },
      { content: SUMMARY, toolCalls: [] },
      // Next turn: the customer tapped «16:30»; the scripted model locks index 4.
      { content: null, toolCalls: [call("c2", "booking_availability_balanced_v2", { action: "lock", option_index: 4 })] },
      { content: "Te lo dejo a las 16:30 con Bruno. ¿Me dices tu nombre y apellido?", toolCalls: [] },
    ];
    const llm: LlmApi = {
      async chat(messages) {
        seen.push(messages);
        return script.shift()!;
      },
    };
    const calls: Record<string, unknown>[] = [];
    let fallback: string | undefined;
    const { deps, v } = setup([], {}, {
      async availability(body) {
        calls.push(body);
        return body.action === "lock" ? { outcome: "locked", locked: true } : six(true)();
      },
    });
    deps.llm = llm;
    deps.vocero = { ...deps.vocero, async sendInteractive(_c, i, f) { v.events.push(`interactive:${i.type}`); fallback = f; return "sent"; } };

    await processTurn(deps, "34600111222", [msg]);
    expect(v.events).toEqual(["interactive:list"]);
    expect(fallback).toBe(`${SUMMARY}\n\nHoras libres: ${AFTERNOON.join(", ")}`);

    await processTurn(deps, "34600111222", [{ ...msg, messageId: "m2", type: "interactive", text: "16:30" }]);
    const lastUser = (seen[2] as { role: string; content: unknown }[]).filter((m) => m.role === "user").at(-1)!;
    expect(String(lastUser.content)).toContain("option_index 4");
    expect(calls.at(-1)).toMatchObject({ action: "lock", option_index: 4 });
    // A reply about a locked hour is not a list.
    expect(v.events.at(-1)).toMatch(/^send:Te lo dejo/);
  });

  it("the tool the model sees accepts option_index up to 10", () => {
    const tool = buildToolDefinitions().find((t) => t.function.name === "booking_availability_balanced_v2")!;
    const idx = (tool.function.parameters.properties as Record<string, Record<string, unknown>>).option_index!;
    expect(idx).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
    expect(idx.enum).toBeUndefined();
    expect(tool.function.description).toContain("UP TO TEN options");
  });
});

describe("VoceroClient.sendInteractive fallback text", () => {
  it("sends the given fallback (reply + hours) when Vocero rejects the list", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ error: "invalid_body" }), { status: bodies.length === 1 ? 422 : 200 });
    }) as unknown as typeof fetch;
    const client = new VoceroClient("http://v", "k", fetchImpl);
    const list = buildPageList(SUMMARY, pageOf(AFTERNOON))!;
    expect(await client.sendInteractive("cv1", list.interactive, list.fallbackText)).toBe("sent");
    expect(bodies[1]).toEqual({ conversationId: "cv1", text: list.fallbackText });
  });
});
