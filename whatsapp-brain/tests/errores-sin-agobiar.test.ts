/**
 * 2026-10-10 — «errores sin agobiar al cliente» (internal doc, not included in the template):
 * at most two tries per piece of data. The brain marks the second
 * `date_conflict` in a row (also across messages) with `segundo_intento`; the
 * prompt then hands the conversation to Bruno with `avisar_a_owner`.
 * Fictitious data only.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dateConflictsFromHistory, processTurn, type TurnDeps } from "../src/conversation.js";
import type { ChatMessage, ChatResult, LlmApi } from "../src/llm.js";
import type { VoceroApi } from "../src/vocero.js";
import type { MiddlewareApi } from "../src/middleware.js";
import { MemorySessionStore } from "../src/store.js";
import {
  buildToolDefinitions,
  executeTool,
  nextDateConflictCount,
  SECOND_ATTEMPT_FIELD,
  TOOL_AVAILABILITY,
  TOOL_NOTIFY_OWNER,
  type ToolSession,
} from "../src/tools.js";
import { buildStaticPrompt } from "../src/prompt.js";
import { DEFAULT_OPENING_HOURS, parseOpeningHours } from "../src/hours.js";
import { silentLogger } from "../src/log.js";
import type { InboundMessage } from "../src/meta.js";

const CONFLICT = {
  outcome: "date_conflict",
  available: false,
  message: "El dieciséis es viernes. ¿Te lo busco el viernes dieciséis o el jueves quince?",
  options: [],
  date_issue: "weekday_mismatch",
};
const OPTIONS = { outcome: "options_available", available: true, message: "El jueves quince te puedo ofrecer…", options: [] };
const LOCKED = {
  outcome: "locked",
  locked: true,
  slot: { slot_token: "tok_1", date: "2026-10-15", time: "10:00", employee_name: "Olga" },
};
const HANDOFF_REPLY = "Para no marearte, se lo paso a Bruno y lo revisa él en persona.";

const session = (over: Partial<ToolSession> = {}): ToolSession => ({
  middlewareConversationId: "wa_cv_err_x1",
  spanishPhone: "600111222",
  bookingEnabled: true,
  selfServiceEnabled: true,
  ...over,
});

function scripted(answers: Record<string, unknown>[]): { calls: Record<string, unknown>[]; m: MiddlewareApi } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    m: {
      availability: async (b) => (calls.push(b), answers.shift() ?? OPTIONS),
      book: async () => ({}),
      myReservations: async () => ({}),
      cancel: async () => ({}),
    },
  };
}

const discover = { action: "discover", service_id: 1, time_period: "morning", dia_semana: "jueves", dia_mes: 16, fecha_dicha: "jueves 16" };

describe("nextDateConflictCount", () => {
  it("counts date_conflict, resets when the day was read, keeps it on errors", () => {
    expect(nextDateConflictCount(0, CONFLICT)).toBe(1);
    expect(nextDateConflictCount(1, CONFLICT)).toBe(2);
    for (const outcome of ["options_available", "no_availability", "no_more_options", "locked"]) {
      expect(nextDateConflictCount(1, { outcome }), outcome).toBe(0);
    }
    for (const outcome of ["agenda_unavailable", "invalid_request", "continuation_lost"]) {
      expect(nextDateConflictCount(1, { outcome }), outcome).toBe(1);
    }
  });
});

describe("executeTool marks the second date_conflict in a row", () => {
  it("the first one reaches the model untouched; the second carries segundo_intento and the same message", async () => {
    const s = session();
    const { m } = scripted([CONFLICT, CONFLICT]);
    const first = await executeTool(TOOL_AVAILABILITY, discover, s, m);
    expect(first).toEqual(CONFLICT);
    const second = await executeTool(TOOL_AVAILABILITY, discover, s, m);
    expect(second).toMatchObject({ ...CONFLICT, [SECOND_ATTEMPT_FIELD]: true });
    expect(s.dateConflicts).toBe(2);
  });

  it("a day that was understood in between starts the count again", async () => {
    const s = session();
    const { m } = scripted([CONFLICT, OPTIONS, CONFLICT]);
    await executeTool(TOOL_AVAILABILITY, discover, s, m);
    await executeTool(TOOL_AVAILABILITY, discover, s, m);
    const third = await executeTool(TOOL_AVAILABILITY, discover, s, m);
    expect(third).not.toHaveProperty(SECOND_ATTEMPT_FIELD);
    expect(s.dateConflicts).toBe(1);
  });

  it("a locked slot also resets it; an agenda error does not", async () => {
    const s = session({ dateConflicts: 1 });
    await executeTool(TOOL_AVAILABILITY, { action: "lock", option_index: 1 }, s, scripted([LOCKED]).m);
    expect(s.dateConflicts).toBe(0);
    const s2 = session({ dateConflicts: 1 });
    await executeTool(TOOL_AVAILABILITY, discover, s2, scripted([{ outcome: "agenda_unavailable", message: "x" }]).m);
    const out = await executeTool(TOOL_AVAILABILITY, discover, s2, scripted([CONFLICT]).m);
    expect(out).toMatchObject({ [SECOND_ATTEMPT_FIELD]: true });
  });

  it("the local closed-day answer counts as a day understood", async () => {
    const s = session({ dateConflicts: 1, openingHours: parseOpeningHours(DEFAULT_OPENING_HOURS) });
    const { calls, m } = scripted([]);
    // 2026-10-12 is a Monday: answered locally, no day pieces.
    const out = await executeTool(TOOL_AVAILABILITY, { action: "discover", date: "2026-10-12", time_period: "morning" }, s, m);
    expect(calls).toHaveLength(0);
    expect(out.outcome).toBe("no_availability");
    expect(s.dateConflicts).toBe(0);
  });
});

describe("dateConflictsFromHistory", () => {
  const call = (id: string, name: string): ChatMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  });
  const result = (id: string, body: unknown): ChatMessage => ({ role: "tool", tool_call_id: id, content: JSON.stringify(body) });

  it("counts the conflicts in a row of earlier turns and ignores other tools and broken content", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "jueves 16" },
      call("a1", TOOL_AVAILABILITY),
      result("a1", CONFLICT),
      { role: "assistant", content: CONFLICT.message },
      { role: "user", content: "el 16" },
      call("n1", TOOL_NOTIFY_OWNER),
      result("n1", { outcome: "date_conflict" }), // not an availability answer
      { role: "tool", tool_call_id: "a1", content: "{not json" },
    ];
    expect(dateConflictsFromHistory(history)).toBe(1);
    expect(dateConflictsFromHistory([...history, call("a2", TOOL_AVAILABILITY), result("a2", OPTIONS)])).toBe(0);
    expect(dateConflictsFromHistory([])).toBe(0);
  });
});

// ── One conversation, two messages: the second conflict goes to Bruno ────────

function voceroRecorder(): { api: VoceroApi; events: string[]; fichas: Record<string, unknown>[] } {
  const events: string[] = [];
  const fichas: Record<string, unknown>[] = [];
  return {
    events,
    fichas,
    api: {
      async getContext() {
        return { conversationId: "cv_err0001", contactName: null, aiEnabled: true, windowOpen: true };
      },
      async typing() {},
      async send(_c, text) {
        events.push(`send:${text}`);
        return "sent";
      },
      async sendInteractive() {
        return "sent";
      },
      async handoff(_c, reason) {
        events.push(`handoff:${reason}`);
        return true;
      },
      async setFicha(_c, ficha) {
        fichas.push(ficha);
        events.push("ficha");
        return true;
      },
      async knowledge() {
        return "";
      },
    },
  };
}

/** Turn 1: discover → copies the question. Turn 2: discover → on segundo_intento, avisar_a_owner + the fixed sentence. */
function modelFollowingThePrompt(seen: Record<string, unknown>[]): LlmApi {
  return {
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      const last = messages[messages.length - 1];
      if (last?.role === "user") {
        return {
          content: null,
          toolCalls: [{ id: `d${messages.length}`, type: "function", function: { name: TOOL_AVAILABILITY, arguments: JSON.stringify(discover) } }],
        } as ChatResult;
      }
      if (last?.role === "tool") {
        const body = JSON.parse(last.content) as Record<string, unknown>;
        seen.push(body);
        if (body.outcome === "date_conflict" && body[SECOND_ATTEMPT_FIELD] === true) {
          const args = { reason: "other", summary: "Quiere corte de pelo; el día no se aclaró (dijo «jueves 16»)." };
          return {
            content: null,
            toolCalls: [{ id: `n${messages.length}`, type: "function", function: { name: TOOL_NOTIFY_OWNER, arguments: JSON.stringify(args) } }],
          } as ChatResult;
        }
        if (body.outcome === "date_conflict") return { content: String(body.message), toolCalls: [] } as ChatResult;
        if (body.outcome === "owner_notified") return { content: HANDOFF_REPLY, toolCalls: [] } as ChatResult;
      }
      return { content: "?", toolCalls: [] } as ChatResult;
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

describe("second failed try on WhatsApp: note for Bruno and handoff, nothing closed", () => {
  it("counts across messages, leaves the note with reason other and hands off AFTER the reply", async () => {
    const store = new MemorySessionStore();
    const vocero = voceroRecorder();
    const { m } = scripted([CONFLICT, CONFLICT]);
    const seen: Record<string, unknown>[] = [];
    let t = 1_800_000_000_000;
    const deps: TurnDeps = {
      vocero: vocero.api,
      middleware: m,
      llm: modelFollowingThePrompt(seen),
      store,
      tools: buildToolDefinitions(),
      staticSystem: { role: "system", content: "STATIC" },
      bookingEnabled: true,
      maxToolRounds: 5,
      log: silentLogger,
      retryDelayMs: 0,
      now: () => t,
    };

    expect(await processTurn(deps, "34600111222", [msg("corte el jueves 16")])).toBe("answered");
    expect(seen[0]).not.toHaveProperty(SECOND_ATTEMPT_FIELD);
    expect(vocero.events).toEqual([`send:${CONFLICT.message}`]);

    t += 60_000;
    expect(await processTurn(deps, "34600111222", [msg("el 16, el jueves")])).toBe("answered");
    expect(seen[1]).toMatchObject({ outcome: "date_conflict", [SECOND_ATTEMPT_FIELD]: true });
    expect(vocero.events.slice(1)).toEqual([`send:${HANDOFF_REPLY}`, "ficha", "handoff:modelo"]);
    expect(vocero.fichas[0]).toMatchObject({ aviso_motivo: "other" });
    expect(String(vocero.fichas[0]?.aviso_para_owner)).toContain("el día no se aclaró");
  });
});

describe("prompts", () => {
  it("WhatsApp: SI ALGO NO CUADRA, segundo_intento and the handoff sentence", () => {
    const prompt = buildStaticPrompt(undefined, undefined, parseOpeningHours(DEFAULT_OPENING_HOURS));
    expect(prompt).toContain("# SI ALGO NO CUADRA");
    expect(prompt).toContain("`segundo_intento`");
    expect(prompt).toContain(`«${HANDOFF_REPLY}»`);
    expect(prompt).toContain("Salvo la persona y SI ALGO NO CUADRA, primero ofrécelo");
  });

  it("the tool tells the model what segundo_intento means", () => {
    const t = buildToolDefinitions().find((d) => d.function.name === TOOL_AVAILABILITY)!;
    const props = (t.function.parameters as { properties: Record<string, { description: string }> }).properties;
    expect(props.fecha_dicha?.description).toContain("segundo_intento");
  });

  // The voice prompt lives in the repo, not in this package: checked only when present.
  const voice = new URL("../../docs/elevenlabs/AGENT_PROMPT_LEAN_V6_ES.md", import.meta.url);
  it.skipIf(!existsSync(voice))("voice V6: the rule and its WhatsApp sentence, three exact sentences", () => {
    const p = readFileSync(voice, "utf8");
    expect(p).toContain("# SI ALGO NO CUADRA");
    expect(p).toContain("Como mucho dos intentos por dato (cada `date_conflict` cuenta como uno)");
    expect(p).toContain("«Para no marearte, escríbenos por WhatsApp a este mismo número y la peluquería lo mira.»");
    expect(p).toContain("Tres frases exactas; dices siempre una entera y nunca dos:");
    expect(p).not.toContain("Dos frases exactas");
  });
});
