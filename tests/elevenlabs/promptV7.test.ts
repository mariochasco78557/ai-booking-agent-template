import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../docs/elevenlabs/", import.meta.url);
const read = (f: string): string => readFileSync(new URL(f, DIR), "utf8");
const V6 = read("AGENT_PROMPT_LEAN_V6_ES.md");
const V7 = read("AGENT_PROMPT_LEAN_V7_ES.md");

// Mirrors the kind enum of the recado zod schema (src/services/recados, Block A: RecadoKind).
const RECADO_KINDS = ["late", "wants_human", "complaint", "question"];

describe("prompt V7 (recados)", () => {
  it("has the recado section, the tool name and the kept WhatsApp sentences", () => {
    expect(V7).toContain("RECADO PARA BRUNO");
    expect(V7).toContain("booking_recado_para_owner");
    expect(V7).toContain("Para no marearte, escríbenos por WhatsApp a este mismo número y la peluquería lo mira.");
    expect(V7).toContain("Lo siento, ahora mismo no he podido resolverlo. Escríbenos por WhatsApp a este mismo número y la peluquería te responderá en cuanto pueda.");
  });

  it("no longer routes people, late arrivals or consultations the V6 way", () => {
    expect(V7).not.toContain("Si pide hablar con una persona: «Ahora mismo no puedo pasarte con nadie");
    expect(V7).not.toContain("llegar tarde es consultar");
    expect(V7).not.toContain("Si llegará tarde: tras nombrar");
    // The persona sentence survives only as the fallback when RECADO fails without a message.
    expect(V7.split("Ahora mismo no puedo pasarte con nadie").length - 1).toBe(1);
    expect(V7).toMatch(/Si falla sin `message` en los demás casos: «Ahora mismo no puedo pasarte con nadie/);
  });

  it("no line about a person points to CONSULTAS NO RESUELTAS", () => {
    for (const line of V7.split("\n")) {
      if (/persona/i.test(line) && !line.startsWith("# ")) expect(line, line.slice(0, 60)).not.toContain("CONSULTAS NO RESUELTAS");
    }
    expect(V7).toContain("no le tranquilices: RECADO PARA BRUNO, a la primera.");
  });

  it("a late recado that fails without message gets the V6 late sentence", () => {
    expect(V7).toContain("Si RECADO falla sin `message` y era un retraso: «Escríbenos por WhatsApp a este mismo número para que la peluquería lo tenga en cuenta.»");
  });

  it("never mentions opening hours to the customer", () => {
    const section = V7.slice(V7.indexOf("# RECADO PARA BRUNO"), V7.indexOf("# CONSULTAS NO RESUELTAS POR WHATSAPP"));
    expect(section).not.toMatch(/horario|cerrad/i);
  });

  it("every section cited by name exists as a title", () => {
    const titles = new Set([...V7.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]!.trim()));
    for (const t of [...V6.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]!.trim())) expect(titles.has(t), t).toBe(true);
    expect(titles.has("RECADO PARA BRUNO")).toBe(true);
    const cited = [...V7.matchAll(/\b[A-ZÁÉÍÓÚÑ]{3,}(?: [A-ZÁÉÍÓÚÑ]{2,})+\b/g)].map((m) => m[0]);
    expect(cited.length).toBeGreaterThan(0);
    for (const name of new Set(cited)) {
      const known = [...titles].some((t) => t === name || t.includes(name) || name.includes(t));
      expect(known, name).toBe(true);
    }
  });

  it("is at most 2 500 characters bigger than V6", () => {
    expect(V7.length).toBeLessThanOrEqual(V6.length + 2500);
  });
});

describe("TOOL_SCHEMAS_RECADO_V1.json", () => {
  const doc = JSON.parse(read("TOOL_SCHEMAS_RECADO_V1.json")) as {
    tools: { name: string; path: string; parameters: { required: string[]; properties: { kind: { enum: string[] } } } }[];
  };
  const tool = doc.tools[0]!;

  it("is readable and requires conversation_id, kind and summary", () => {
    expect(tool.name).toBe("booking_recado_para_owner");
    expect(tool.path).toBe("/ai/voice/v2/recado");
    expect(tool.parameters.required).toEqual(["conversation_id", "kind", "summary"]);
  });

  it("kind enum matches the middleware's RecadoKind", () => {
    expect(tool.parameters.properties.kind.enum).toEqual(RECADO_KINDS);
    const types = new URL("../../src/services/recados/recadoTypes.ts", import.meta.url);
    if (existsSync(types)) {
      const src = readFileSync(types, "utf8");
      const m = /export type RecadoKind =([^;]+);/.exec(src);
      expect(m).not.toBeNull();
      const kinds = [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
      expect(kinds).toEqual(RECADO_KINDS);
    }
  });
});
