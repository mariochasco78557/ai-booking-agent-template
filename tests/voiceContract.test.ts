import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  myReservationsSchema,
  cancelSchema,
  voiceBookSchema,
} from "../src/schemas/aiSchemas.js";
import {
  LOOKUP_OUTCOMES,
  CANCEL_OUTCOMES,
} from "../src/types/voiceOutcomes.js";

/**
 * step 10C wave 4 ((internal doc, not included in the template)
 * §8, §9, §11 "Prompt/schema agreement"). This is the AGREEMENT suite: it
 * reads the actual `docs/elevenlabs/*` artefacts and the actual runtime
 * exports of `src/schemas/aiSchemas.ts` / `src/types/voiceOutcomes.ts` /
 * `src/routes/ai.ts`, and asserts they agree — nothing here hardcodes a
 * duplicated list that could silently drift from the code.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const elevenlabsDir = join(repoRoot, "docs", "elevenlabs");

const TOOL_SCHEMAS_PATH = join(elevenlabsDir, "TOOL_SCHEMAS.json");
const AGENT_PROMPT_PATH = join(elevenlabsDir, "AGENT_PROMPT_ES.md");
const README_PATH = join(elevenlabsDir, "README.md");
const LOCAL_DEMO_PATH = join(elevenlabsDir, "LOCAL_DEMO.md");
const AI_ROUTES_PATH = join(repoRoot, "src", "routes", "ai.ts");

interface JsonSchemaToolParameters {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface JsonSchemaTool {
  name: string;
  description: string;
  method: string;
  path: string;
  parameters: JsonSchemaToolParameters;
  [key: string]: unknown;
}

interface ToolSchemasFile {
  $comment: string;
  baseUrl: string;
  authHeader: unknown;
  tools: JsonSchemaTool[];
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function loadToolSchemas(): ToolSchemasFile {
  return JSON.parse(readText(TOOL_SCHEMAS_PATH)) as ToolSchemasFile;
}

function findTool(schemas: ToolSchemasFile, name: string): JsonSchemaTool {
  const tool = schemas.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in TOOL_SCHEMAS.json`);
  return tool;
}

/** Every `scoped.post("/ai/...")` path literally registered by src/routes/ai.ts. */
function extractRegisteredAiPaths(): string[] {
  const source = readText(AI_ROUTES_PATH);
  const paths: string[] = [];
  const re = /scoped\.post\(\s*["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    paths.push(match[1]!);
  }
  return paths;
}

const BANNED_TRANSFER_PHRASE_RE =
  /te paso con|le paso con|te transfiero|paso la llamada|te comunico con/i;

/** design §9 / senior finding B10 — retired identifiers, one word each, exact-case. */
const RETIRED_TERMS = ["customerPhone", "reservationId", "transfer_to_human"];
/** Loose enough to catch "RETIRED", "retired", "retirado(s)", "retirada(s)". */
const RETIREMENT_MARKER_RE = /retir/i;
const RETIREMENT_WINDOW = 600;

describe("voice tool contract agreement (step 10C wave 4)", () => {
  it("TOOL_SCHEMAS.json parses as valid JSON", () => {
    expect(() => loadToolSchemas()).not.toThrow();
  });

  it("every tool has name/description/method/path/parameters", () => {
    const schemas = loadToolSchemas();
    expect(schemas.tools.length).toBeGreaterThan(0);
    for (const tool of schemas.tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.method).toBe("string");
      expect(typeof tool.path).toBe("string");
      expect(tool.path.startsWith("/")).toBe(true);
      expect(tool.parameters).toBeTruthy();
      expect(tool.parameters.type).toBe("object");
    }
  });

  it("every tool's path exactly matches a route registered in src/routes/ai.ts", () => {
    const schemas = loadToolSchemas();
    const registered = extractRegisteredAiPaths();
    expect(registered.length).toBeGreaterThan(0);
    for (const tool of schemas.tools) {
      expect(registered).toContain(tool.path);
    }
  });

  it("every route registered in src/routes/ai.ts is documented by exactly one tool", () => {
    const schemas = loadToolSchemas();
    const documentedPaths = schemas.tools.map((t) => t.path);
    const registered = extractRegisteredAiPaths();
    for (const path of registered) {
      const count = documentedPaths.filter((p) => p === path).length;
      expect(count).toBe(1);
    }
  });

  it("find_my_reservations' parameter names are EXACTLY the keys of myReservationsSchema", () => {
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "find_my_reservations");
    const documentedKeys = Object.keys(tool.parameters.properties ?? {}).sort();
    const schemaKeys = Object.keys(myReservationsSchema.shape).sort();
    expect(documentedKeys).toEqual(schemaKeys);
  });

  it("cancel_appointment's parameter names are EXACTLY the keys of cancelSchema", () => {
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "cancel_appointment");
    const documentedKeys = Object.keys(tool.parameters.properties ?? {}).sort();
    const schemaKeys = Object.keys(cancelSchema.shape).sort();
    expect(documentedKeys).toEqual(schemaKeys);
  });

  /**
   * step SLOT. The agreement that matters most after 2026-08-30, and the one
   * that was missing: the booking tool's parameters must be EXACTLY the keys
   * `voiceBookSchema` accepts.
   *
   * Without it, `reservation_date` could be quietly restored to the
   * ElevenLabs tool while the middleware had stopped accepting it — the agent
   * would send a field that is silently a 400, mid-call, and the symptom
   * would read as "booking is broken" rather than as "the contract drifted".
   * More dangerously, the reverse: a field removed here and left in the tool
   * is a field the model keeps being asked to invent.
   */
  it("booking_create_booking's parameter names are EXACTLY the keys of voiceBookSchema", () => {
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "booking_create_booking");
    const documentedKeys = Object.keys(tool.parameters.properties ?? {}).sort();
    const schemaKeys = Object.keys(voiceBookSchema.shape).sort();
    expect(documentedKeys).toEqual(schemaKeys);
  });

  it("the booking tool tells the agent that failures come back as HTTP 200", () => {
    // Audit correction 1 (2026-08-30). The middleware now answers 200 for
    // every failure a model can produce, and that is only half a fix: a
    // prompt that still believes a failure arrives as a tool error will keep
    // treating `outcome` as noise. The tool definition has to say so.
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "booking_create_booking");
    const text = JSON.stringify(tool);
    expect(text).toMatch(/200/);
    expect(text).toMatch(/outcome/);
  });

  it("no tool definition promises the caller a wait", () => {
    // Audit correction 2 (2026-08-30). A voice agent that says "dame un
    // segundo" has promised something nothing behind it can keep: there is no
    // asynchronous work here, and a caller left listening to silence hangs up.
    const text = readText(TOOL_SCHEMAS_PATH);
    const promptText = readText(AGENT_PROMPT_PATH);
    // Deliberately narrow: a TIME UNIT after a waiting verb. A broader
    // pattern matched `espera un "sí" claro y explícito` in rule 6, which is
    // the confirmation gate — the agent waiting for the CUSTOMER, not the
    // customer waiting for the agent. Those are opposite instructions and
    // only one of them is a defect.
    const TIME_PROMISE_RE =
      /(dame|d[eé]jame|espera|esp[eé]rame|aguarda)\s+(un|unos|una|unas)\s+(segundo|segundito|momento|momentito|instante|minuto|ratito)/i;
    expect(TIME_PROMISE_RE.test(text)).toBe(false);
    expect(TIME_PROMISE_RE.test(promptText)).toBe(false);
  });

  it("the booking tool no longer offers the three fields the agent used to fabricate", () => {
    // Named literally, because their ABSENCE is the control. `slot_token`
    // replaced all three (src/services/slotAuthorization.ts).
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "booking_create_booking");
    const documented = Object.keys(tool.parameters.properties ?? {});
    for (const retired of ["reservation_date", "employee_id", "service_id"]) {
      expect(documented, `booking_create_booking still offers "${retired}"`).not.toContain(retired);
    }
    expect(documented).toContain("slot_token");
    expect(tool.parameters.required ?? []).toContain("slot_token");
  });

  it("every hueco the availability tool documents carries a slot_token", () => {
    // The two halves have to agree: booking requires a token, so availability
    // must be documented as producing one, or the agent has no way to comply.
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "booking_check_availability");
    const example = tool["responseExample"] as { slots?: Array<Record<string, unknown>> };
    expect(example.slots?.length ?? 0).toBeGreaterThan(0);
    for (const slot of example.slots ?? []) {
      expect(typeof slot["slot_token"]).toBe("string");
    }
  });

  it("the booking tool enumerates every slot-authorization outcome it can return", () => {
    // These four are new refusals with a new recovery ("go back to
    // availability"). A prompt that has never seen them will improvise.
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "booking_create_booking");
    const text = JSON.stringify(tool);
    for (const outcome of [
      "invalid_slot_token",
      "slot_token_expired",
      "slot_not_authorized",
      "invalid_customer_data",
      // Not new, but newly REACHABLE: `confirmed_by_customer` used to be a
      // Zod literal, so a missing confirmation was an HTTP 400 the prompt
      // never saw. It is now a 200 the agent has to route.
      "not_confirmed",
    ]) {
      expect(text.includes(outcome), `missing outcome "${outcome}"`).toBe(true);
    }
  });

  it("no tool exposes a parameter that could let the agent assert verification", () => {
    const schemas = loadToolSchemas();
    const suspiciousParamRe = /verif|trust|caller.?id/i;
    for (const tool of schemas.tools) {
      const paramNames = Object.keys(tool.parameters.properties ?? {});
      for (const name of paramNames) {
        expect(
          suspiciousParamRe.test(name),
          `tool "${tool.name}" exposes suspicious parameter "${name}"`,
        ).toBe(false);
      }
    }
  });

  it("every LookupOutcome value appears in find_my_reservations' JSON text", () => {
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "find_my_reservations");
    const text = JSON.stringify(tool);
    expect(LOOKUP_OUTCOMES.length).toBeGreaterThan(0);
    for (const outcome of LOOKUP_OUTCOMES) {
      expect(text.includes(outcome), `missing LookupOutcome "${outcome}"`).toBe(true);
    }
  });

  it("every CancelOutcome value appears in cancel_appointment's JSON text", () => {
    const schemas = loadToolSchemas();
    const tool = findTool(schemas, "cancel_appointment");
    const text = JSON.stringify(tool);
    expect(CANCEL_OUTCOMES.length).toBeGreaterThan(0);
    for (const outcome of CANCEL_OUTCOMES) {
      expect(text.includes(outcome), `missing CancelOutcome "${outcome}"`).toBe(true);
    }
  });

  it("neither TOOL_SCHEMAS.json nor AGENT_PROMPT_ES.md contains a banned transfer phrase", () => {
    const toolSchemasText = readText(TOOL_SCHEMAS_PATH);
    const promptText = readText(AGENT_PROMPT_PATH);
    expect(BANNED_TRANSFER_PHRASE_RE.test(toolSchemasText)).toBe(false);
    expect(BANNED_TRANSFER_PHRASE_RE.test(promptText)).toBe(false);
  });

  it('AGENT_PROMPT_ES.md contains the "ninguna reserva próxima" wording', () => {
    const promptText = readText(AGENT_PROMPT_PATH);
    expect(promptText.includes("ninguna reserva próxima")).toBe(true);
  });

  it("AGENT_PROMPT_ES.md explicitly forbids claiming a call transfer", () => {
    const promptText = readText(AGENT_PROMPT_PATH);
    // No transfer tool exists (design §9): the prompt must instruct the
    // agent never to claim or imply the call is being moved/transferred to
    // someone else — asserted by content, not by the (deliberately absent)
    // banned literal phrases checked in the test above.
    expect(/transferir|traslad|trasladar|desviar/i.test(promptText)).toBe(true);
    expect(/no existe ninguna herramienta/i.test(promptText)).toBe(true);
  });

  describe("no retired identifier is presented as current", () => {
    const files: Array<{ label: string; path: string }> = [
      { label: "TOOL_SCHEMAS.json", path: TOOL_SCHEMAS_PATH },
      { label: "AGENT_PROMPT_ES.md", path: AGENT_PROMPT_PATH },
      { label: "README.md", path: README_PATH },
      { label: "LOCAL_DEMO.md", path: LOCAL_DEMO_PATH },
    ];

    for (const { label, path } of files) {
      for (const term of RETIRED_TERMS) {
        it(`${label}: every mention of "${term}" (if any) is accompanied by retirement wording`, () => {
          const text = readText(path);
          let searchFrom = 0;
          let occurrences = 0;
          for (;;) {
            const idx = text.indexOf(term, searchFrom);
            if (idx === -1) break;
            occurrences++;
            const windowStart = Math.max(0, idx - RETIREMENT_WINDOW);
            const windowEnd = Math.min(
              text.length,
              idx + term.length + RETIREMENT_WINDOW,
            );
            const window = text.slice(windowStart, windowEnd);
            expect(
              RETIREMENT_MARKER_RE.test(window),
              `${label} mentions "${term}" at offset ${idx} without nearby retirement wording`,
            ).toBe(true);
            searchFrom = idx + term.length;
          }
          // Not every file need mention every term; this test is only
          // meaningful when at least the file was actually scanned, which
          // the loop above always does regardless of `occurrences`.
          expect(occurrences).toBeGreaterThanOrEqual(0);
        });
      }
    }
  });

  it("no real-looking Spanish phone number appears anywhere in docs/elevenlabs/ (only +34600000xxx-style synthetic ones)", () => {
    const files = [TOOL_SCHEMAS_PATH, AGENT_PROMPT_PATH, README_PATH, LOCAL_DEMO_PATH];
    const phoneRe = /(?:\+34)?[6789]\d{8}/g;
    for (const path of files) {
      const text = readText(path);
      const matches = text.match(phoneRe) ?? [];
      for (const m of matches) {
        const digits = m.startsWith("+34") ? m.slice(3) : m;
        expect(
          digits.startsWith("600000"),
          `${path} contains a phone-shaped number "${m}" that is not the synthetic +34600000xxx pattern`,
        ).toBe(true);
      }
    }
  });
});
