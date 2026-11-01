import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { spanishPhoneFromWaId, displayWaId } from "../src/phone.js";
import { parseInbound } from "../src/meta.js";
import { loadConfig, shouldAnswer, ConfigError } from "../src/config.js";
import { recentFicha } from "../src/vocero.js";
import { buildStaticPrompt, buildDynamicPrompt, pasteablePart } from "../src/prompt.js";

describe("phone from WhatsApp id", () => {
  it("turns a Spanish wa_id into the 9-digit booking phone", () => {
    expect(spanishPhoneFromWaId("34600111222")).toBe("600111222");
    expect(spanishPhoneFromWaId("+34 910 00 00 25")).toBe("910000025");
    expect(spanishPhoneFromWaId("whatsapp:+34711222333")).toBe("711222333");
    expect(spanishPhoneFromWaId("600111222")).toBe("600111222");
  });
  it("returns null for foreign or malformed numbers", () => {
    expect(spanishPhoneFromWaId("447700900123")).toBeNull();
    expect(spanishPhoneFromWaId("34500111222")).toBeNull();
    expect(spanishPhoneFromWaId("")).toBeNull();
  });
  it("displays with a plus", () => {
    expect(displayWaId("34600111222")).toBe("+34600111222");
  });
});

const webhook = (messages: unknown[], pnid = "100000000000001") => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: pnid },
            contacts: [{ wa_id: "34600111222", profile: { name: "Ana" } }],
            messages,
          },
        },
      ],
    },
  ],
});

describe("parsing Meta webhooks", () => {
  it("reads text, buttons and list replies", () => {
    const got = parseInbound(
      webhook([
        { from: "34600111222", id: "w1", timestamp: "1700000000", type: "text", text: { body: "hola" } },
        { from: "34600111222", id: "w2", timestamp: "1700000001", type: "interactive", interactive: { button_reply: { title: "Sí" } } },
        { from: "34600111222", id: "w3", timestamp: "1700000002", type: "audio", audio: { id: "m1" } },
      ])
    );
    expect(got.map((m) => [m.messageId, m.type, m.text])).toEqual([
      ["w1", "text", "hola"],
      ["w2", "interactive", "Sí"],
      ["w3", "audio", null],
    ]);
    expect(got[0]?.profileName).toBe("Ana");
    expect(got[0]?.timestamp).toBe(1700000000);
  });
  it("ignores statuses, other fields, other numbers and junk", () => {
    expect(parseInbound({ object: "page" })).toEqual([]);
    expect(parseInbound(null)).toEqual([]);
    expect(
      parseInbound({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "x" }] } }] }] })
    ).toEqual([]);
    expect(parseInbound(webhook([{ from: "1", id: "w", type: "text", text: { body: "x" } }], "999"), "100000000000001")).toEqual([]);
  });
});

describe("config", () => {
  it("off needs nothing and answers nobody", () => {
    const c = loadConfig({});
    expect(c.mode).toBe("off");
    expect(c.bookingEnabled).toBe(false);
    expect(shouldAnswer(c, "34600111222")).toBe(false);
  });
  const full = {
    VOCERO_BOT_API_KEY: "k".repeat(32),
    AI_WEBHOOK_SECRET: "s".repeat(32),
    OPENROUTER_API_TOKEN: "sk-or-x",
  };
  it("pilot answers only the allowlist", () => {
    const c = loadConfig({ ...full, BRAIN_MODE: "pilot", BRAIN_ALLOWED_WA_IDS: "+34 600 111 222, 34711000000" });
    expect(shouldAnswer(c, "34600111222")).toBe(true);
    expect(shouldAnswer(c, "34699999999")).toBe(false);
  });
  it("pilot without allowlist or answering without secrets refuses to boot", () => {
    expect(() => loadConfig({ ...full, BRAIN_MODE: "pilot" })).toThrow(ConfigError);
    expect(() => loadConfig({ BRAIN_MODE: "live" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...full, BRAIN_MODE: "live", BRAIN_BOOKING_ENABLED: "yes" })).toThrow(ConfigError);
  });
  it("booking stays off unless explicitly true", () => {
    expect(loadConfig({ ...full, BRAIN_MODE: "live" }).bookingEnabled).toBe(false);
    expect(loadConfig({ ...full, BRAIN_MODE: "live", BRAIN_BOOKING_ENABLED: "true" }).bookingEnabled).toBe(true);
  });
});

describe("self-service secret", () => {
  const full = { VOCERO_BOT_API_KEY: "k".repeat(32), AI_WEBHOOK_SECRET: "s".repeat(32), OPENROUTER_API_TOKEN: "sk-or-x" };
  it("is optional and absent by default", () => {
    expect(loadConfig({ ...full, BRAIN_MODE: "live" }).selfServiceSecret).toBeUndefined();
    expect(loadConfig({ ...full, WA_SELF_SERVICE_SECRET: "  " }).selfServiceSecret).toBeUndefined();
  });
  it("is read when long enough and refused when short", () => {
    expect(loadConfig({ ...full, WA_SELF_SERVICE_SECRET: "w".repeat(32) }).selfServiceSecret).toBe("w".repeat(32));
    expect(() => loadConfig({ ...full, WA_SELF_SERVICE_SECRET: "short" })).toThrow(ConfigError);
  });
  it("reports version 0.3.0 by default", () => {
    expect(loadConfig({}).version).toBe("0.3.0");
  });
});

describe("rules prompt", () => {
  it("drops the phase-1 bullet and tells the model not to write the calendar link", () => {
    const p = buildStaticPrompt();
    expect(p).not.toContain("Fase actual");
    expect(p).not.toContain("todavía no están conectadas");
    expect(p).toContain("el propio sistema añade el enlace");
  });
});

describe("opening hours and history config", () => {
  it("2026-10-11: the prompt never states opening hours; only the server's message does", () => {
    const p = buildStaticPrompt();
    expect(p).not.toContain("HORARIO SEMANAL");
    expect(p).not.toContain("solo hasta las");
    expect(p).not.toContain("sábado: ");
    expect(p).toContain("# HORARIO");
    expect(p).toContain("Nunca digas a qué hora abre o cierra");
  });
  it("a custom BRAIN_OPENING_HOURS is parsed (garbage rejected) but never written into the prompt", () => {
    const c = loadConfig({ BRAIN_OPENING_HOURS: "lun-vie=abierto,sab=13:30,dom=cerrado" });
    expect(buildStaticPrompt(undefined, undefined, c.openingHours)).not.toContain("solo hasta las 13:30");
    expect(() => loadConfig({ BRAIN_OPENING_HOURS: "xyz=abierto" })).toThrow(ConfigError);
  });
  it("2026-10-11: «cerrado» only from the message; changing only the service never goes through availability", () => {
    const p = buildStaticPrompt();
    expect(p).toContain("«Cerrado» (salvo domingos y lunes) solo si lo dice el `message`");
    expect(p).toContain("nunca lo busques en DISPONIBILIDAD");
    expect(p).toContain("Para cambiar el servicio de tu cita se lo paso a Bruno, que lo deja apuntado. ¿Te parece?");
    expect(p).toContain("`own_booking_at_time`");
    expect(p).toContain("scan con `weekday`");
  });
  it("BRAIN_HISTORY_DAYS defaults to 60", () => {
    expect(loadConfig({}).historyDays).toBe(60);
    expect(loadConfig({ BRAIN_HISTORY_DAYS: "30" }).historyDays).toBe(30);
  });
  it("ignores cancellation / late-notice ficha fields older than the window", () => {
    const now = Date.parse("2026-10-08T10:00:00Z");
    const ficha = {
      ultima_anulacion: "x",
      ultima_anulacion_fecha: "2026-07-01T10:00:00Z",
      ultimo_aviso_retraso: "2026-09-30T10:00:00Z",
      ultimo_aviso_retraso_min: 10,
      otro: 1,
    };
    expect(recentFicha(ficha, now, 60)).toEqual({ ultimo_aviso_retraso: "2026-09-30T10:00:00Z", ultimo_aviso_retraso_min: 10 });
  });
  it("rules no longer say short-notice cancellations are impossible and forbid money talk", () => {
    const p = buildStaticPrompt();
    expect(p).toContain("puede anular SIEMPRE");
    expect(p).toContain("nunca menciones cobros");
    expect(p).toContain("¿Quieres anular la cita o solo avisar de que llegas un poco tarde?");
  });
});

describe("prompt", () => {
  it("keeps only the pasteable part of V1 and points placeholders at the dynamic part", () => {
    const p = buildStaticPrompt();
    expect(p).toContain("Eres el asistente virtual de Demo Salon");
    expect(p).not.toContain("{{system__");
    expect(p).not.toContain("No pegar en ElevenLabs");
    expect(p).not.toContain("Cambios respecto a V6");
    expect(p).toContain("REGLAS DE DEMO SALON");
    expect(p).toContain("se cobra el servicio");
  });
  it("is identical across calls (cacheable)", () => {
    expect(buildStaticPrompt()).toBe(buildStaticPrompt());
  });
  it("cuts at the marker", () => {
    expect(pasteablePart("A\n\n---\n\n<!-- No pegar en ElevenLabs lo de abajo -->\nB")).toBe("A");
  });
  it("dynamic part carries number, Madrid date and knowledge", () => {
    const d = buildDynamicPrompt({ waId: "34600111222", now: new Date("2026-10-07T21:30:00Z"), knowledge: "Dirección: X" });
    expect(d).toContain("+34600111222");
    expect(d).toContain("Hoy es 2026-10-07");
    expect(d).toContain("23:30");
    expect(d).toContain("Dirección: X");
  });
});

describe("copies of the ElevenLabs documents", () => {
  // The brain ships its own copies (the Docker build only sees whatsapp-brain/).
  // When the repo is around, they must not drift from the canonical documents.
  const docs = new URL("../../docs/elevenlabs/", import.meta.url);
  for (const f of ["AGENT_PROMPT_WHATSAPP_V1_ES.md", "TOOL_SCHEMAS_BALANCED_V2.json", "TOOL_SCHEMAS_WHATSAPP_V1.json"]) {
    it.skipIf(!existsSync(new URL(f, docs)))(`${f} matches docs/elevenlabs`, () => {
      const copy = readFileSync(new URL(`../prompts/${f}`, import.meta.url), "utf8");
      expect(copy).toBe(readFileSync(new URL(f, docs), "utf8"));
    });
  }
});
