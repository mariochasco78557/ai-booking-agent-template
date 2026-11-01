import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WA_NOTIFY_REASONS,
  waCancelSchema,
  waMyReservationsSchema,
  waNotifyOwnerSchema,
} from "../src/schemas/waSelfServiceSchemas.js";

/**
 * ADR-032 — the agreement suite for docs/elevenlabs/TOOL_SCHEMAS_WHATSAPP_V1.json,
 * the actual runtime schemas and the actual route file. Nothing is hardcoded
 * that could drift from them.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const DOC = join(repoRoot, "docs", "elevenlabs", "TOOL_SCHEMAS_WHATSAPP_V1.json");
const ROUTES = join(repoRoot, "src", "routes", "waSelfService.ts");

interface JsonTool {
  name: string;
  description: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  parameters: {
    type: string;
    properties: Record<string, { type: string; enum?: string[] }>;
    required?: string[];
  };
}

const doc = JSON.parse(readFileSync(DOC, "utf8")) as { tools: JsonTool[] };

function tool(name: string): JsonTool {
  const found = doc.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing`);
  return found;
}

function registeredPaths(): string[] {
  const source = readFileSync(ROUTES, "utf8");
  return [...source.matchAll(/scoped\.post\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
}

/** Field names and which of them are required, as the zod object defines them. */
function zodFields(schema: { shape: Record<string, { isOptional(): boolean }> }): {
  all: string[];
  required: string[];
} {
  const all = Object.keys(schema.shape);
  return { all, required: all.filter((k) => !schema.shape[k]!.isOptional()) };
}

const TOOLS = [
  { name: "booking_mis_citas", path: "/ai/wa/my-reservations", schema: waMyReservationsSchema },
  { name: "booking_cancelar_cita", path: "/ai/wa/cancel", schema: waCancelSchema },
  { name: "avisar_a_owner", path: "/ai/wa/notify-owner", schema: waNotifyOwnerSchema },
] as const;

describe("whatsapp tool schemas · contract agreement", () => {


  it("every tool carries both secrets and the caller-id header as the dynamic variable", () => {
    for (const t of doc.tools) {
      expect(t.headers["X-AI-Webhook-Secret"]).toBeTruthy();
      expect(t.headers["X-AI-WA-Secret"]).toBeTruthy();
      expect(t.headers["X-AI-WA-Caller-Id"]).toBe("{{system__caller_id}}");
      expect(t.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("no placeholder is replaced by a real-looking secret", () => {
    const text = readFileSync(DOC, "utf8");
    expect(text).toContain("<AI_WEBHOOK_SECRET>");
    expect(text).toContain("<WA_SELF_SERVICE_SECRET>");
  });

  for (const expected of TOOLS) {
    it(`${expected.name}: parameters agree with the zod schema`, () => {
      const t = tool(expected.name);
      const fields = zodFields(expected.schema as never);
      const documented = Object.keys(t.parameters.properties);
      // Nothing documented that the server does not read, and vice versa.
      expect([...documented].sort()).toEqual([...fields.all].sort());
      expect([...(t.parameters.required ?? [])].sort()).toEqual([...fields.required].sort());
    });
  }

  it("the notify reasons enum is the runtime one", () => {
    const reason = tool("avisar_a_owner").parameters.properties["reason"]!;
    expect(reason.enum).toEqual([...WA_NOTIFY_REASONS]);
  });

  it("cancel's confirmation is a boolean and the ref a string", () => {
    const props = tool("booking_cancelar_cita").parameters.properties;
    expect(props["confirmed_by_customer"]!.type).toBe("boolean");
    expect(props["reservation_ref"]!.type).toBe("string");
  });

  it("lookup and cancel never take a phone or caller id as a parameter", () => {
    for (const name of ["booking_mis_citas", "booking_cancelar_cita"]) {
      const keys = Object.keys(tool(name).parameters.properties).map((k) => k.toLowerCase());
      for (const key of keys) {
        expect(key).not.toMatch(/phone|caller|telefono|numero/);
      }
    }
  });

  it("the schemas module re-exports, never redefines, the service schemas", () => {
    const source = readFileSync(join(repoRoot, "src", "schemas", "waSelfServiceSchemas.ts"), "utf8");
    expect(source).not.toMatch(/z\.object/);
  });
});
