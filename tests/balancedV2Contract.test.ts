import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  BALANCED_ACTIONS,
  BALANCED_DISCOVER_OUTCOMES,
  BALANCED_LOCK_OUTCOMES,
  BALANCED_MAX_OPTIONS,
  BALANCED_PERIODS,
  BALANCED_SCAN_MAX_PER_DAY,
  balancedAvailabilitySchema,
} from "../src/schemas/balancedV2Schemas.js";
import { voiceBookSchema } from "../src/schemas/aiSchemas.js";
import { buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { BRUNO, OLGA, conv, mockAgendaDay, v2 } from "./helpers/balancedV2.js";
import {
  BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
  BALANCED_ALREADY_BOOKED_MESSAGE,
  BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE,
  BALANCED_BOOKING_FAILED_MESSAGE,
  BALANCED_BOOKING_UNCERTAIN_MESSAGE,
  BALANCED_CLOSED_DAY_MESSAGE,
  BALANCED_INVALID_REQUEST_MESSAGE,
  BALANCED_NO_AVAILABILITY_MESSAGE,
  BALANCED_OPTION_UNKNOWN_MESSAGE,
  BALANCED_SCAN_ALL_CLOSED_MESSAGE,
  BALANCED_SLOT_TAKEN_MESSAGE,
  BALANCED_WRITE_DISABLED_MESSAGE,
  balancedEmployeeUnavailableMessage,
  balancedLockedMessage,
  balancedLookAheadMessage,
  balancedLookAheadNothingMessage,
  balancedMoreOptionsMessage,
  balancedNoMoreOptionsMessage,
  balancedOptionsMessage,
  balancedPreferredTimeMessage,
  balancedScanMessage,
  balancedScanNoAvailabilityMessage,
  balancedScanNoMoreMessage,
} from "../src/utils/balancedPhrasing.js";

/**
 * BALANCED V2 — the agreement suite.
 *
 * It reads the ACTUAL document the duplicated ElevenLabs agent will be
 * configured from, the ACTUAL runtime schemas, and the ACTUAL route file, and
 * asserts they agree. Nothing here hardcodes a list that could drift.
 *
 * Two directions of drift, and both are dangerous:
 *
 * - A field removed from the document but still accepted by the middleware is
 *   dead weight nobody notices.
 * - A field removed from the middleware but still in the document is a field
 *   the model keeps being asked to invent — which is exactly the 2026-08-30
 *   failure mode.
 *
 * It also asserts that this document does NOT disturb the stable agent: it must
 * describe only the two V2 routes, and `docs/elevenlabs/TOOL_SCHEMAS.json` must
 * still describe only the stable ones.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const elevenlabsDir = join(repoRoot, "docs", "elevenlabs");

const V2_SCHEMAS_PATH = join(elevenlabsDir, "TOOL_SCHEMAS_BALANCED_V2.json");
const V2_PROMPT_PATH = join(elevenlabsDir, "AGENT_PROMPT_BALANCED_V2_ES.md");
const STABLE_SCHEMAS_PATH = join(elevenlabsDir, "TOOL_SCHEMAS.json");
const V2_ROUTES_PATH = join(repoRoot, "src", "routes", "balancedV2.ts");
const STABLE_ROUTES_PATH = join(repoRoot, "src", "routes", "ai.ts");

interface JsonTool {
  name: string;
  description: string;
  method: string;
  path: string;
  parameters: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  [key: string]: unknown;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * The prompt as a SENTENCE, not as Markdown.
 *
 * A quoted sentence in the prompt is wrapped across lines and prefixed with
 * `> `, so a substring check against the sentence the middleware or the agent
 * actually speaks fails on formatting alone. Stripping the blockquote marker
 * and collapsing whitespace compares the WORDS, which is the only thing the
 * contract is about.
 */
function spokenText(path: string): string {
  return readText(path)
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

function flatten(sentence: string): string {
  return sentence.replace(/\s+/g, " ").trim();
}

function loadV2(): { tools: JsonTool[]; [key: string]: unknown } {
  return JSON.parse(readText(V2_SCHEMAS_PATH)) as { tools: JsonTool[] };
}

function tool(name: string): JsonTool {
  const found = loadV2().tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} not found in TOOL_SCHEMAS_BALANCED_V2.json`);
  return found;
}

/** Every `scoped.post("/ai/...")` path a route file literally registers. */
function registeredPaths(path: string): string[] {
  const source = readText(path);
  const out: string[] = [];
  const re = /scoped\.post\(\s*["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.push(match[1]!);
  return out;
}

const AVAILABILITY_TOOL = "booking_availability_balanced_v2";
const CREATE_TOOL = "booking_create_booking_balanced_v2";

describe("balanced v2 · tool contract agreement", () => {
  it("the document parses and declares exactly the two tools the agent has", () => {
    const schemas = loadV2();
    expect(schemas.tools.map((entry) => entry.name).sort()).toEqual(
      [AVAILABILITY_TOOL, CREATE_TOOL].sort(),
    );
  });

  it("every declared path is a route src/routes/balancedV2.ts really registers", () => {
    const registered = registeredPaths(V2_ROUTES_PATH);
    expect(registered.sort()).toEqual(["/ai/voice/v2/availability", "/ai/voice/v2/book"]);
    for (const entry of loadV2().tools) {
      expect(registered).toContain(entry.path);
    }
  });

  it("every registered V2 route is documented by exactly one tool", () => {
    const documented = loadV2().tools.map((entry) => entry.path);
    for (const path of registeredPaths(V2_ROUTES_PATH)) {
      expect(documented.filter((entry) => entry === path).length).toBe(1);
    }
  });

  /** *** THE STABLE AGENT IS UNTOUCHED. *** */
  it("does not add anything to the stable agent's routes or document", () => {
    const stableRoutes = registeredPaths(STABLE_ROUTES_PATH);
    for (const path of stableRoutes) {
      expect(path.startsWith("/ai/voice/v2/")).toBe(false);
    }
    const stableDoc = readText(STABLE_SCHEMAS_PATH);
    expect(stableDoc).not.toContain("/ai/voice/v2/");
    expect(stableDoc).not.toContain("balanced_v2");
  });

  /**
   * *** THE ASSERTION THE WINDOW SEARCH LANDED AGAINST. ***
   *
   * `date_from`, `days`, `after_time` and `before_time` reached the document
   * and the `z.object` in two separate pieces of work, and for the hours in
   * between this comparison was the only thing that could tell. It was left
   * strict on purpose — not relaxed, not skipped, not softened — because a
   * field the document offers and the middleware does not accept is a field the
   * model is being asked to invent, which is the 2026-08-30 failure mode. It
   * stays the alarm if one of the four is ever dropped from either side.
   */
  it("the availability tool's parameters are EXACTLY the keys the endpoint accepts", () => {
    const documented = Object.keys(tool(AVAILABILITY_TOOL).parameters.properties ?? {}).sort();
    expect(documented).toEqual(Object.keys(balancedAvailabilitySchema.shape).sort());
  });

  it("the booking tool's parameters are EXACTLY the keys voiceBookSchema accepts", () => {
    // The V2 write path reuses `voiceBookSchema` and `VoiceBookingService`
    // wholesale, so the two booking contracts cannot be allowed to drift.
    const documented = Object.keys(tool(CREATE_TOOL).parameters.properties ?? {}).sort();
    expect(documented).toEqual(Object.keys(voiceBookSchema.shape).sort());
  });

  it("the booking tool still offers none of the three fields the agent used to fabricate", () => {
    const documented = Object.keys(tool(CREATE_TOOL).parameters.properties ?? {});
    for (const retired of ["reservation_date", "employee_id", "service_id"]) {
      expect(documented, `${CREATE_TOOL} still offers "${retired}"`).not.toContain(retired);
    }
    expect(documented).toContain("slot_token");
    expect(tool(CREATE_TOOL).parameters.required ?? []).toContain("slot_token");
  });

  /**
   * The enum is POSITIONAL, and `"scan"` is appended rather than inserted, so
   * the three shipped actions keep their places. An agent configured from the
   * old document and talking to the new middleware still means `"lock"` when it
   * says `"lock"`.
   */
  it("the availability tool declares every action and both bands, and no «any»", () => {
    const properties = tool(AVAILABILITY_TOOL).parameters.properties as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(properties["action"]?.enum).toEqual([...BALANCED_ACTIONS]);
    expect(properties["time_period"]?.enum).toEqual([...BALANCED_PERIODS]);
    expect(JSON.stringify(properties["time_period"])).not.toContain('"any"');
  });

  it("the availability tool enumerates every outcome the code can return", () => {
    const text = JSON.stringify(tool(AVAILABILITY_TOOL));
    for (const outcome of [...BALANCED_DISCOVER_OUTCOMES, ...BALANCED_LOCK_OUTCOMES]) {
      expect(text.includes(outcome), `missing outcome "${outcome}"`).toBe(true);
    }
  });

  it("the booking tool enumerates every outcome VoiceBookingService can return", () => {
    // Read from the type's own declaration rather than a copy, so a new
    // outcome in the service fails here instead of reaching a prompt that has
    // never seen it.
    const source = readText(join(repoRoot, "src", "services", "voiceBookingService.ts"));
    const block = source.slice(
      source.indexOf("  outcome:"),
      source.indexOf("  /**\n   * Whether an appointment was created upstream"),
    );
    const outcomes = [...block.matchAll(/\|\s*"([a-z_]+)"/g)].map((match) => match[1]!);
    expect(outcomes.length).toBeGreaterThan(8);
    const text = JSON.stringify(tool(CREATE_TOOL));
    for (const outcome of outcomes) {
      expect(text.includes(outcome), `missing booking outcome "${outcome}"`).toBe(true);
    }
  });

  it("both tools tell the agent that failures arrive as HTTP 200 with an outcome", () => {
    for (const name of [AVAILABILITY_TOOL, CREATE_TOOL]) {
      const text = JSON.stringify(tool(name));
      expect(text).toMatch(/200/);
      expect(text).toMatch(/outcome/);
    }
  });

  it("the document and the prompt carry the three professional ids and nothing else", () => {
    const text = readText(V2_SCHEMAS_PATH);
    const promptText = readText(V2_PROMPT_PATH);
    for (const source of [text, promptText]) {
      expect(source).toMatch(/Bruno\W+(employee_id )?1\b/);
      expect(source).toMatch(/Olga\W+(employee_id )?2\b/);
      expect(source).toMatch(/Ram[oó]n\W+(employee_id )?3\b/);
    }
    // And both say, explicitly, that the agent must not ask.
    expect(text).toMatch(/NEVER ask who they want/i);
    expect(promptText).toMatch(/[Nn]unca preguntas por profesional/);
  });

  it("the prompt forbids naming a professional before the final summary", () => {
    const promptText = readText(V2_PROMPT_PATH);
    expect(promptText).toMatch(/No dices el nombre de ningún profesional hasta el resumen final/);
    expect(promptText).toContain("employee_name");
  });

  /**
   * *** THE SENTENCES ARE BUILT, NOT COPIED. ***
   *
   * Every expected string below comes from `balancedOptionsMessage` itself, so
   * this asserts that the prompt and the RUNTIME agree — not that the prompt
   * agrees with a second hand-written copy of the wording, which is the version
   * of this test that would pass forever after the code changed.
   */
  it("the prompt carries, verbatim, the sentences the middleware actually produces", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const expected = [
      balancedOptionsMessage(["10:00", "11:00", "12:00"], {
        hasMore: true,
        requested: "morning",
        offered: "morning",
      }),
      balancedOptionsMessage(["10:00", "11:00", "12:00"], {
        hasMore: false,
        requested: "morning",
        offered: "morning",
      }),
      balancedOptionsMessage(["10:00", "11:00"], {
        hasMore: false,
        requested: "morning",
        offered: "morning",
      }),
      balancedOptionsMessage(["10:00"], {
        hasMore: false,
        requested: "morning",
        offered: "morning",
      }),
      balancedOptionsMessage(["16:00", "17:30", "18:00"], {
        hasMore: false,
        requested: "morning",
        offered: "afternoon",
      }),
      BALANCED_NO_AVAILABILITY_MESSAGE,
      // *** THE CLOSED-DAY SENTENCE. *** Answered without an agenda read at
      // all (see `BalancedAvailabilityService.discover`), but still a
      // `message` this prompt must be able to quote verbatim.
      BALANCED_CLOSED_DAY_MESSAGE,
    ];
    for (const sentence of expected) {
      expect(promptText.includes(sentence), `prompt is missing: ${sentence}`).toBe(true);
    }
    // And the seven really are seven distinct sentences, not one repeated.
    expect(new Set(expected).size).toBe(7);
  });

  /**
   * *** THE CONTINUATION SENTENCES, BUILT RATHER THAN COPIED. ***
   *
   * Same rule as the six above: every expected string comes out of the RUNTIME
   * builder, so the prompt is checked against what the middleware will actually
   * say on the phone. These six are the ones that answer «otros horarios» — the
   * exact moment at which the production agent gave up and the caller hung up.
   */
  it("the prompt carries, verbatim, the sentences the continuation produces", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const expected = [
      balancedMoreOptionsMessage(["10:00", "11:00", "12:00"], { hasMore: true }),
      balancedMoreOptionsMessage(["10:00", "11:00"], { hasMore: false }),
      balancedMoreOptionsMessage(["10:00"], { hasMore: false }),
      balancedNoMoreOptionsMessage("morning", { fallbackAlreadyHappened: false }),
      balancedNoMoreOptionsMessage("afternoon", { fallbackAlreadyHappened: false }),
      balancedNoMoreOptionsMessage("afternoon", { fallbackAlreadyHappened: true }),
    ];
    for (const sentence of expected) {
      expect(promptText.includes(sentence), `prompt is missing: ${sentence}`).toBe(true);
    }
    expect(new Set(expected).size).toBe(6);
    // The band is irrelevant once the fallback has already happened: the
    // sentence speaks about the day, so both bands produce the same words.
    expect(balancedNoMoreOptionsMessage("morning", { fallbackAlreadyHappened: true })).toBe(
      balancedNoMoreOptionsMessage("afternoon", { fallbackAlreadyHappened: true }),
    );
  });

  it("the prompt knows the continuation action and every outcome it can answer", () => {
    const promptText = readText(V2_PROMPT_PATH);
    expect(promptText).toContain('"more"');
    for (const outcome of [
      "no_more_options",
      "continuation_lost",
      "continuation_mismatch",
    ]) {
      expect(promptText.includes(outcome), `prompt is missing: ${outcome}`).toBe(true);
    }
    // *** BOTH LOST STATES ROUTE BACK TO `discover`. ***
    //
    // The middleware answers them with BALANCED_OPTION_UNKNOWN_MESSAGE, whose
    // whole job is to send the agent back to a fresh lookup; the prompt is not
    // required to quote that sentence, but it IS required to describe that
    // recovery, because the alternative — reciting remembered hours — is the
    // failure the continuation exists to prevent.
    for (const outcome of ["continuation_lost", "continuation_mismatch"]) {
      const row = promptText
        .split("\n")
        .find((line) => line.includes(`\`${outcome}\``) && line.includes("|"));
      expect(row, `the prompt has no routing row for "${outcome}"`).toBeDefined();
      expect(row).toContain("`discover`");
    }
    expect(BALANCED_OPTION_UNKNOWN_MESSAGE).toContain("volver a mirar la agenda");
  });

  it("the tool document describes the continuation as server-side, with no cursor", () => {
    const availability = tool(AVAILABILITY_TOOL);
    const text = JSON.stringify(availability);
    expect(text).toContain('action=\\"more\\"');
    // *** NO FIELD THE MODEL COULD USE AS A CURSOR. *** The whole safety
    // argument for `more` is that there is nothing to reconstruct, so a future
    // edit that adds one must fail here.
    const documented = Object.keys(availability.parameters.properties ?? {});
    for (const forbidden of ["cursor", "page", "page_index", "offset", "exclude_times"]) {
      expect(documented, `the tool offers a cursor field "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
    expect(text).toContain("has_more");
  });

  it("the prompt tells the agent to change professional with lock, never by booking", () => {
    const promptText = readText(V2_PROMPT_PATH);
    expect(promptText).toContain("preferred_employee_id");
    expect(promptText).toMatch(/\*\*No creas nada\.\*\*/);
    expect(promptText).toContain("employee_unavailable");
    expect(promptText).toContain("current_employee_name");
  });

  it("the prompt states the one-creation rule and the two-signal confirmation rule", () => {
    const promptText = readText(V2_PROMPT_PATH);
    expect(promptText).toMatch(/UNA sola vez/);
    expect(promptText).toMatch(/`booked` es `true` Y `outcome` es `"confirmed"`/);
    expect(promptText).toContain("already_booked_in_call");
    expect(promptText).toContain("uncertain");
  });

  it("neither the V2 document nor the V2 prompt promises a transfer or a wait", () => {
    const BANNED_TRANSFER_RE =
      /te paso con|le paso con|te transfiero|paso la llamada|te comunico con/i;
    const TIME_PROMISE_RE =
      /(dame|d[eé]jame|espera|esp[eé]rame|aguarda)\s+(un|unos|una|unas)\s+(segundo|segundito|momento|momentito|instante|minuto|ratito)/i;
    for (const path of [V2_SCHEMAS_PATH, V2_PROMPT_PATH]) {
      const text = readText(path);
      expect(BANNED_TRANSFER_RE.test(text), `${path} promises a transfer`).toBe(false);
      expect(TIME_PROMISE_RE.test(text), `${path} promises a wait`).toBe(false);
    }
  });

  it("no tool exposes a parameter that could let the agent assert verification", () => {
    const suspicious = /verif|trust|caller.?id/i;
    for (const entry of loadV2().tools) {
      for (const name of Object.keys(entry.parameters.properties ?? {})) {
        expect(suspicious.test(name), `"${entry.name}" exposes "${name}"`).toBe(false);
      }
    }
  });

  it("no real-looking Spanish phone number appears in the V2 artefacts", () => {
    const phoneRe = /(?:\+34)?[6789]\d{8}/g;
    for (const path of [V2_SCHEMAS_PATH, V2_PROMPT_PATH]) {
      for (const match of readText(path).match(phoneRe) ?? []) {
        const digits = match.startsWith("+34") ? match.slice(3) : match;
        expect(
          digits.startsWith("600000"),
          `${path} contains a phone-shaped number "${match}" outside the synthetic +34600000xxx pattern`,
        ).toBe(true);
      }
    }
  });

  /**
   * *** THE WAY OUT OF A DEAD END IS A SENTENCE, AND IT LIVES IN THE PROMPT. ***
   *
   * The production call this whole mission exists for ended with «Disculpa, no
   * puedo mostrarte más opciones directamente» and a caller hanging up. The
   * paging work removes that particular dead end; this assertion is about every
   * other one. A terminal failure must end with a next step the salon can
   * actually honour, and the owner's platform decision is that the step is WhatsApp
   * to the number already dialled — answered by a person, with no promise that
   * anybody will ring back.
   *
   * It is checked here rather than in the middleware because the middleware
   * must NOT say it: when to say it depends on the conversation (a lost page is
   * recoverable, a failed write is not), and the middleware sees one tool call.
   */
  it("the prompt ends a terminal failure with the WhatsApp exit, verbatim", () => {
    const WHATSAPP_EXIT =
      "Lo siento, ahora mismo no he podido resolverlo. Escríbenos por WhatsApp a " +
      "este mismo número y la peluquería te responderá en cuanto pueda.";
    expect(spokenText(V2_PROMPT_PATH)).toContain(WHATSAPP_EXIT);
    // And it is the PROMPT's sentence: no sentence the middleware can SPEAK may
    // contain it, or the agent would read it at moments the conversation can
    // still recover from — the exact thing rule 12 of the prompt forbids.
    for (const sentence of [
      BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
      BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE,
      BALANCED_BOOKING_UNCERTAIN_MESSAGE,
      BALANCED_WRITE_DISABLED_MESSAGE,
      BALANCED_ALREADY_BOOKED_MESSAGE,
      BALANCED_BOOKING_FAILED_MESSAGE,
      BALANCED_NO_AVAILABILITY_MESSAGE,
      BALANCED_OPTION_UNKNOWN_MESSAGE,
    ]) {
      expect(sentence.toLowerCase(), sentence).not.toContain("whatsapp");
    }
  });

  /**
   * *** THE SIX V2 SENTENCES, PROMPT AGAINST RUNTIME. ***
   *
   * Built from the constants rather than copied, exactly as the offer and
   * continuation sentences above are, so this asserts that the prompt matches
   * what the middleware will really say — not that it matches a second
   * hand-written copy of the wording.
   *
   * They exist because the V1 sentences these replace promise that a human will
   * make contact («se pondrá en contacto contigo», «que te llamen desde la
   * peluquería»), and the V2 agent may promise nothing of the sort.
   */
  it("the prompt carries, verbatim, the V2 failure sentences the middleware produces", () => {
    const prompt = spokenText(V2_PROMPT_PATH);
    const expected = [
      BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
      BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE,
      BALANCED_BOOKING_UNCERTAIN_MESSAGE,
      BALANCED_WRITE_DISABLED_MESSAGE,
      BALANCED_ALREADY_BOOKED_MESSAGE,
      BALANCED_BOOKING_FAILED_MESSAGE,
    ];
    for (const sentence of expected) {
      expect(prompt.includes(flatten(sentence)), `prompt is missing: ${sentence}`).toBe(true);
    }
    expect(new Set(expected).size).toBe(6);
  });

  /**
   * *** THE SIX REMAINING RENDERINGS THE MIDDLEWARE CAN SPEAK. ***
   *
   * The three verbatim tests above cover eighteen renderings: the six
   * `discover` sentences, the six `more` continuation sentences and the six
   * V2 failure sentences. These six are the ones that were still
   * unprotected — a caller could hear any of them and the prompt could drift
   * out from under the wording without a single test noticing:
   *
   * - `BALANCED_SLOT_TAKEN_MESSAGE` — `lock`'s `slot_taken`.
   * - `BALANCED_OPTION_UNKNOWN_MESSAGE` — `lock`'s `option_not_found`, and
   *   `more`'s `continuation_lost` / `continuation_mismatch` (same sentence,
   *   three outcomes).
   * - `BALANCED_INVALID_REQUEST_MESSAGE` — shared by `discover`, `more` and
   *   `lock`.
   * - `balancedLockedMessage` — a representative `"locked"` message.
   * - `balancedEmployeeUnavailableMessage` — a representative
   *   `"employee_unavailable"` message.
   * - `balancedMoreOptionsMessage` with three hours and `hasMore: false` —
   *   the one shape the continuation test above does not exercise (it only
   *   tries this branch with one and with two hours).
   *
   * Built from the constants and builders, exactly like every other verbatim
   * test in this file — never a hand-typed second copy.
   */
  it("the prompt carries, verbatim, the remaining renderings the middleware can speak", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const expected = [
      BALANCED_SLOT_TAKEN_MESSAGE,
      BALANCED_OPTION_UNKNOWN_MESSAGE,
      BALANCED_INVALID_REQUEST_MESSAGE,
      balancedLockedMessage("2026-09-15 14:00:00", "Bruno"),
      balancedEmployeeUnavailableMessage("Olga", "Bruno", "14:00"),
      balancedMoreOptionsMessage(["16:00", "16:30", "17:00"], { hasMore: false }),
    ];
    for (const sentence of expected) {
      expect(promptText.includes(sentence), `prompt is missing: ${sentence}`).toBe(true);
    }
    expect(new Set(expected).size).toBe(6);
  });

  it("the prompt routes the three outcomes that are not about a hueco", () => {
    const prompt = readText(V2_PROMPT_PATH);
    for (const outcome of [
      "invalid_request",
      "agenda_unavailable",
      "authorization_unavailable",
    ]) {
      expect(prompt.includes(outcome), `prompt is missing: ${outcome}`).toBe(true);
    }
  });

  /**
   * *** WHEN `more` IS CALLED IS A PRODUCT DECISION, AND IT HAS ONE ANSWER. ***
   *
   * The tool document used to say «Only call it when the previous answer had
   * has_more=true». The prompt says to call it whenever the customer asks for
   * other hours. Those are different instructions, and the document's version
   * is the harmful one: a model that believes `more` is forbidden after
   * `has_more:false` has no tool for «¿no tienes más?» and improvises — which
   * is precisely the failure of the production call.
   *
   * The server already answers that case deterministically (`no_more_options`),
   * so the safe instruction is to CALL IT and read the outcome.
   */
  it("the tool document and the prompt agree on when more is called", () => {
    const availability = JSON.stringify(tool(AVAILABILITY_TOOL));
    expect(availability).not.toContain("Only call it when");
    expect(availability).toMatch(/no_more_options/);
    // The document states the server-side guarantee the instruction rests on.
    expect(availability).toMatch(/whenever the customer asks for other or more hours/i);
    // …and the outcome description must not contradict it either.
    expect(availability).not.toContain("do not ask for more");
  });

  /**
   * *** EXHAUSTION DOES NOT WITHDRAW THE HOURS ALREADY OFFERED. ***
   *
   * `no_more_options` publishes nothing, so the LAST page stays on the table
   * and its numbers still resolve. An agent told otherwise would re-`discover`
   * after the caller said «pues ponme la de las doce», and re-offer hours they
   * had already chosen between.
   */
  it("the tool document says the last page is still lockable after no_more_options", () => {
    const outcomes = tool(AVAILABILITY_TOOL)["discoverOutcomes"] as Record<string, string>;
    expect(outcomes["no_more_options"]).toMatch(/last page/i);
    expect(outcomes["no_more_options"]).toMatch(/lock/);
  });

  /** The terminal outcomes document the sentence the middleware really sends. */
  it("the tool document quotes the V2 sentences for the terminal outcomes", () => {
    const availability = JSON.stringify(tool(AVAILABILITY_TOOL));
    const create = JSON.stringify(tool(CREATE_TOOL));
    expect(availability).toContain(BALANCED_AGENDA_UNAVAILABLE_MESSAGE);
    expect(availability).toContain(BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE);
    for (const sentence of [
      BALANCED_BOOKING_UNCERTAIN_MESSAGE,
      BALANCED_WRITE_DISABLED_MESSAGE,
      BALANCED_ALREADY_BOOKED_MESSAGE,
      BALANCED_BOOKING_FAILED_MESSAGE,
    ]) {
      expect(create.includes(sentence), `create tool is missing: ${sentence}`).toBe(true);
    }
    // *** AND NEITHER DOCUMENT TELLS THE AGENT TO PROMISE A CALL. ***
    const NO_CONTACT_PROMISE_RE =
      /te llamen|se pondr[\u00e1a] en contacto|call back|ring back|have the salon call/i;
    for (const path of [V2_SCHEMAS_PATH, V2_PROMPT_PATH]) {
      expect(NO_CONTACT_PROMISE_RE.test(readText(path)), `${path} promises contact`).toBe(
        false,
      );
    }
  });

  /**
   * The route file's own comment, DERIVED rather than pinned.
   *
   * It used to assert the literal «THREE actions», which turns every new action
   * into a test that has to be edited by hand — and a hand-edited assertion is
   * one nobody reads. Counting `BALANCED_ACTIONS` instead means the comment is
   * required to keep up with the schema: ship `scan` and leave the comment
   * saying THREE, and this fails.
   */
  /**
   * *** THE WINDOW SEARCH — `action: "scan"`. ***
   *
   * `scan` exists because the prompt used to do this job by hand: «propón tú el
   * siguiente día laborable», «ofrece solo las horas que cumplen la condición»,
   * «recorre los días, como máximo tres». Every one of those is the model doing
   * arithmetic and filtering between turns, which is the same class of fault as
   * the 2026-08-30 incident — and it is now the SERVER's job. The assertions
   * below are about the two ways that could silently come undone: a field that
   * lets the model page the window itself, and a prompt that keeps filtering.
   */
  it("the availability tool offers scan LAST in the enum, so the shipped actions keep their places", () => {
    const properties = tool(AVAILABILITY_TOOL).parameters.properties as Record<
      string,
      { enum?: unknown[] }
    >;
    // Positional, and asserted against the literal the console will be typed
    // from — the comparison against BALANCED_ACTIONS above is the other half.
    expect(properties["action"]?.enum).toEqual(["discover", "lock", "more", "scan"]);
    expect((properties["action"]?.enum ?? []).at(-1)).toBe("scan");
  });

  it("the availability tool declares the four window fields, all optional", () => {
    const availability = tool(AVAILABILITY_TOOL);
    const documented = Object.keys(availability.parameters.properties ?? {});
    for (const field of ["date_from", "days", "after_time", "before_time"]) {
      expect(documented, `the tool is missing "${field}"`).toContain(field);
    }
    // *** `required` DOES NOT GROW. *** Only the two fields EVERY action needs
    // are required; everything else is validated per action by the service and
    // answered as a deterministic 200. A required field the model must invent
    // for a `lock` is exactly what this contract exists to prevent.
    expect(availability.parameters.required).toEqual(["conversation_id", "action"]);
  });

  /**
   * *** A WINDOW IS A QUESTION, NOT A CURSOR. ***
   *
   * `more` is safe because there is nothing for the model to reconstruct
   * between turns. `scan` adds four fields, and the danger is that they get
   * USED as a cursor — «scan again with date_from = the last day I heard» is
   * fine (it is a new question), but «scan again with offset 3» would be the
   * model paging the answer itself. So: none of the four may be named like a
   * position, and the document has to say so in words.
   */
  it("the window fields describe the question, and none of them is a cursor", () => {
    const availability = tool(AVAILABILITY_TOOL);
    const documented = Object.keys(availability.parameters.properties ?? {});
    for (const forbidden of [
      "cursor",
      "page",
      "page_index",
      "offset",
      "exclude_times",
      "skip",
      "seen_times",
      "last_time",
    ]) {
      expect(documented, `the tool offers a cursor field "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
    const text = JSON.stringify(availability);
    expect(text).toMatch(/DESCRIBE THE QUESTION, NOT A POSITION IN THE ANSWER/);
    expect(text).toMatch(/not a page number, not an offset, not a list of hours to skip/);
    // And the document states the guarantee the prompt's «no filtres tú la
    // lista» rests on: the filtering happens on the server.
    expect(text).toMatch(/THE SERVER FILTERS/);
  });

  it("the scan example carries the page, the per-day summary and the diagnostics", () => {
    const example = tool(AVAILABILITY_TOOL)["responseExampleScan"] as Record<string, unknown>;
    expect(example).toBeDefined();
    for (const field of [
      "days_summary",
      "days_checked",
      "partial",
      "page_index",
      "offered_so_far",
      "total_unique_slots",
      "has_more",
    ]) {
      expect(example[field], `the scan example is missing "${field}"`).toBeDefined();
    }
    // Read-only, like every other action on this endpoint.
    expect(example["external_mutation"]).toBe(false);
    // The page is the same three-field shape `discover` returns, so the agent
    // has one thing to learn and `lock` works on it unchanged.
    const options = example["options"] as Record<string, unknown>[];
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(["date", "option_index", "time"]);
    }
    // *** NO NEW OUTCOME. *** `scan` answers in the vocabulary the prompt
    // already routes; a fourth action with a private outcome list would be a
    // fourth table for the model to keep straight.
    expect(BALANCED_DISCOVER_OUTCOMES).toContain(example["outcome"]);
  });

  /**
   * *** THE SCAN SENTENCES, BUILT RATHER THAN COPIED. ***
   *
   * Same rule as every other verbatim test here: the expected strings come out
   * of the RUNTIME builders, so the prompt is checked against what the
   * middleware will really say on the phone — never against a second
   * hand-written copy of the wording.
   *
   * The dates are anchored to Friday 2026-09-11 because the day phrases are a
   * function of DISTANCE: lunes is +3, martes +4 and jueves +6, all inside the
   * window where a bare weekday is unambiguous.
   */
  it("the prompt carries, verbatim, the sentences a window search produces", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const TODAY = "2026-09-11";
    const summary = [
      {
        date: "2026-09-14",
        weekday_es: "lunes",
        count: 4,
        first_time: "09:00",
        last_time: "20:00",
        matching_count: 2,
      },
    ];
    const threeDays = [
      { date: "2026-09-14", time: "17:30", optionIndex: 1 },
      { date: "2026-09-15", time: "17:00", optionIndex: 2 },
      { date: "2026-09-17", time: "19:00", optionIndex: 3 },
    ];
    const expected = [
      balancedScanMessage(threeDays, summary, { hasMore: false, todayIso: TODAY }),
      balancedScanMessage(threeDays, summary, { hasMore: true, todayIso: TODAY }),
      balancedScanMessage(
        [
          { date: "2026-09-15", time: "17:00", optionIndex: 1 },
          { date: "2026-09-15", time: "18:00", optionIndex: 2 },
          { date: "2026-09-15", time: "19:00", optionIndex: 3 },
        ],
        summary,
        { hasMore: false, todayIso: TODAY },
      ),
      balancedScanMessage([{ date: "2026-09-17", time: "19:00", optionIndex: 1 }], summary, {
        hasMore: false,
        todayIso: TODAY,
      }),
      balancedScanNoAvailabilityMessage({ afterTime: "17:00", days: 7, partial: false }),
      balancedScanNoAvailabilityMessage({ period: "afternoon", days: 7, partial: false }),
      balancedScanNoAvailabilityMessage({ afterTime: "17:00", days: 7, partial: true }),
      balancedScanNoMoreMessage(),
      // *** THE ALL-CLOSED SENTENCE. *** A window whose every day is closed,
      // answered with zero upstream calls (see
      // `BalancedAvailabilityService.scan`).
      BALANCED_SCAN_ALL_CLOSED_MESSAGE,
    ];
    for (const sentence of expected) {
      expect(promptText.includes(sentence), `prompt is missing: ${sentence}`).toBe(true);
    }
    expect(new Set(expected).size).toBe(9);
    // A multi-day empty window ends on a concrete offer, never the vague one.
    expect(promptText).not.toContain("en los próximos siete días. ¿Quieres que mire más adelante");
    expect(promptText).toContain("`next_search_from`");
  });

  /**
   * *** THE DISCOVER LOOK-AHEAD (2026-09-15): NEVER A BARE «NO TENGO». ***
   *
   * A full or closed day is answered with the nearest later day that has hours,
   * or with an open offer of the following week. Every sentence below is built
   * by the runtime builder, so the prompt is checked against what the caller
   * will really hear.
   */
  it("the prompt carries, verbatim, the sentences the discover look-ahead produces", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const expected = [
      balancedLookAheadMessage({
        reason: "full",
        requestedDate: "2026-09-22",
        offeredDate: "2026-09-23",
        times: ["17:00", "17:30", "18:00"],
      }),
      balancedLookAheadMessage({
        reason: "closed",
        requestedDate: "2026-09-21",
        offeredDate: "2026-09-22",
        times: ["17:00", "17:30", "18:00"],
      }),
      balancedLookAheadMessage({
        reason: "full",
        requestedDate: "2026-09-22",
        offeredDate: "2026-09-23",
        times: ["18:00"],
      }),
      balancedLookAheadNothingMessage({
        reason: "full",
        requestedDate: "2026-09-22",
        period: "afternoon",
        otherPeriodHasHours: true,
      }),
      balancedLookAheadNothingMessage({
        reason: "full",
        requestedDate: "2026-09-22",
        period: "afternoon",
        otherPeriodHasHours: false,
      }),
      balancedLookAheadNothingMessage({
        reason: "closed",
        requestedDate: "2026-09-21",
        period: "afternoon",
        otherPeriodHasHours: true,
      }),
    ];
    for (const sentence of expected) {
      expect(promptText.includes(sentence), `prompt is missing: ${sentence}`).toBe(true);
    }
    expect(new Set(expected).size).toBe(6);
    // The owner's own example, word for word.
    expect(expected[0]).toBe(
      "El martes veintidós no me queda hueco; lo más cercano es el miércoles veintitrés a las cinco, a las cinco y media o a las seis. ¿Te va bien alguna, o te busco otro día?",
    );
    // The fallback sentences are still quoted: they are what the caller hears
    // when the following days could not be read.
    expect(promptText).toContain(BALANCED_NO_AVAILABILITY_MESSAGE);
    expect(promptText).toContain(BALANCED_CLOSED_DAY_MESSAGE);
    // The agent knows the look-ahead page is an ordinary, lockable page.
    const section = promptText.slice(
      promptText.indexOf("## DÍA SIN HUECO: EL SERVIDOR PROPONE EL MÁS CERCANO"),
      promptText.indexOf("## BÚSQUEDA DE VARIOS DÍAS"),
    );
    expect(section).toContain("`date_fallback`");
    expect(section).toMatch(/lock con su option_index/);
    expect(section).toMatch(/Ese día lo propone el servidor, no tú/);
  });

  /**
   * *** A «NO» TO ONE ALTERNATIVE IS NOT A REJECTION OF ALL OF THEM. ***
   *
   * Before the look-ahead, «¿Quieres que mire otro día?» answered «no» sent the
   * caller straight to WhatsApp and the call ended. The prompt now requires one
   * open question — «¿Qué día te vendría mejor?» — and a lookup of the answer
   * before the WhatsApp exit for lack of hueco, and says so in both places the
   * model decides it: the exit rule and the WhatsApp section.
   */
  it("the prompt asks one open day question and tries it before the WhatsApp exit", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const salida = promptText.slice(
      promptText.indexOf("# REGLA DE SALIDA"),
      promptText.indexOf("# HERRAMIENTAS"),
    );
    expect(salida).toMatch(/Un «no» a una alternativa no es rechazar todas/);
    expect(salida).toContain("«¿Qué día te vendría mejor?»");
    expect(salida).toMatch(/haber consultado lo que conteste/);

    const whatsapp = promptText.slice(promptText.indexOf("# CONSULTAS NO RESUELTAS POR WHATSAPP"));
    expect(whatsapp).toContain("«¿Qué día te vendría mejor?»");
    expect(whatsapp).toMatch(/NO es rechazar las alternativas/);
    expect(promptText).not.toContain("- El cliente rechaza las alternativas de más horas, de franja y de día.");
    // The WhatsApp exit is still the last resort, and still verbatim.
    expect(whatsapp).toMatch(/El WhatsApp es la última salida, nunca la primera/);

    // Every rule this change must not disturb is still there.
    expect(promptText).toContain("## EL CLIENTE DICE UNA HORA");
    expect(promptText).toContain("### LA RESTRICCIÓN HORARIA SE MANTIENE");
    expect(promptText).toMatch(/La peluquería cierra los domingos y los lunes/);
    expect(promptText).toMatch(/El slot_token vigente es siempre el del lock MÁS RECIENTE/);
  });

  /**
   * *** THE AGENT MUST NEVER CALL A TOOL FOR A NAMED CLOSED DAY. ***
   *
   * `discover`/`scan` already answer a closed day correctly if the agent DOES
   * call them (that is what `BALANCED_CLOSED_DAY_MESSAGE` /
   * `BALANCED_SCAN_ALL_CLOSED_MESSAGE` are for) — but the mission is cheaper
   * than that: a caller who says «el domingo» should never cost a tool call
   * at all. This pins that instruction lives in the FLUJO section, ahead of
   * the day question, and names both closed days together with the exact
   * "no llames a ninguna herramienta" instruction.
   */
  it("the FLUJO section tells the agent never to call a tool for a named closed day", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const flujoSection = promptText
      .split(/^# /m)
      .find((section) => section.startsWith("FLUJO PARA UNA CITA NUEVA"));
    expect(flujoSection, "the prompt has no FLUJO PARA UNA CITA NUEVA section").toBeDefined();
    expect(flujoSection).toMatch(/domingos/i);
    expect(flujoSection).toMatch(/lunes/i);
    expect(flujoSection).toMatch(/no llames a ninguna herramienta/i);
  });

  /**
   * *** THE SAME-DAY EXAMPLE IS ONLY REACHABLE AS A ONE-DAY QUESTION. ***
   *
   * The prompt's «El martes tengo a las cinco, a las seis o a las siete» is
   * three hours of ONE day. The per-day cap means a window wider than a day can
   * never produce it — so as a general example it taught the agent to expect a
   * shape the middleware would not send, and the caller's «¿y a qué horas?»
   * would be answered from a page the model had mis-predicted. The prompt now
   * says which question produces it, and this test holds the two together: the
   * sentence still comes out of the builder, and the cap that makes it a
   * one-day shape is still the cap the middleware applies.
   */
  it("the prompt presents the same-day list as the one-day question it is", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const TODAY = "2026-09-11";
    const sameDay = balancedScanMessage(
      [
        { date: "2026-09-15", time: "17:00", optionIndex: 1 },
        { date: "2026-09-15", time: "18:00", optionIndex: 2 },
        { date: "2026-09-15", time: "19:00", optionIndex: 3 },
      ],
      [
        {
          date: "2026-09-15",
          weekday_es: "martes",
          count: 3,
          first_time: "17:00",
          last_time: "19:00",
          matching_count: 3,
        },
      ],
      { hasMore: false, todayIso: TODAY },
    );
    // Still the runtime's own sentence, not a second hand-written copy.
    expect(promptText.includes(sameDay), `prompt is missing: ${sameDay}`).toBe(true);

    // …and three hours of one day really do need `days: 1`, because a wider
    // window is capped below that.
    expect(BALANCED_SCAN_MAX_PER_DAY).toBeLessThan(BALANCED_MAX_OPTIONS);

    const label = promptText
      .split("\n")
      .find((line) => line.startsWith("Varias horas del mismo día"));
    expect(label, "the prompt has no label for the same-day sentence").toBeDefined();
    expect(label).toContain("days 1");
    // And the routing rule that sends a named day to a one-day scan says the
    // whole day comes back, paged — not two hours of it.
    expect(promptText).toMatch(/Con days 1 el servidor te da todas las horas de ese día/);
  });

  /**
   * *** THE ONE-DAY, ONE-BOUNDARY NEAREST-HOUR SENTENCES, BUILT RATHER THAN
   * COPIED. ***
   *
   * Same rule as every other verbatim test here: the two sentences the prompt
   * shows for «a partir de las seis, nada ese día» — with a real nearest hour,
   * and without one at all — come out of `balancedScanNoAvailabilityMessage`
   * itself, not out of a second hand-written copy.
   */
  it("the prompt carries, verbatim, the nearest-hour sentences a one-day boundary search produces", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const expected = [
      balancedScanNoAvailabilityMessage({
        afterTime: "18:00",
        days: 1,
        partial: false,
        nearestOutsideConstraint: "16:30",
      }),
      balancedScanNoAvailabilityMessage({
        afterTime: "18:00",
        days: 1,
        partial: false,
      }),
    ];
    for (const sentence of expected) {
      expect(promptText.includes(sentence), `prompt is missing: ${sentence}`).toBe(true);
    }
    expect(new Set(expected).size).toBe(2);
  });

  /**
   * *** THE "HASTA" TAIL, BUILT RATHER THAN COPIED, FOR BOTH SHAPES OF LIST. ***
   *
   * `balancedScanMessage`'s single-day continuation naming how far the rest of
   * the day's hours go («hasta las ocho»), and `balancedOptionsMessage`'s own
   * «hasta la una y media» — the discover twin of the same promise — are
   * exercised together because both answer the same question: is the "hay más"
   * claim honestly bounded, or left as the vaguer "disponibles"?
   */
  it("the prompt carries, verbatim, the sentences that bound the 'hay más' promise with a real hour", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const TODAY = "2026-09-11";
    const sameDaySeveral = balancedScanMessage(
      [
        { date: "2026-09-15", time: "17:00", optionIndex: 1 },
        { date: "2026-09-15", time: "18:00", optionIndex: 2 },
        { date: "2026-09-15", time: "19:00", optionIndex: 3 },
      ],
      [
        {
          date: "2026-09-15",
          weekday_es: "martes",
          count: 4,
          first_time: "17:00",
          last_time: "20:00",
          matching_count: 4,
        },
      ],
      { hasMore: true, todayIso: TODAY },
    );
    const discoverWithLastTime = balancedOptionsMessage(["10:00", "11:00", "12:00"], {
      hasMore: true,
      requested: "morning",
      offered: "morning",
      lastTime: "13:30",
    });
    for (const sentence of [sameDaySeveral, discoverWithLastTime]) {
      expect(promptText.includes(sentence), `prompt is missing: ${sentence}`).toBe(true);
    }
    expect(sameDaySeveral).not.toBe(discoverWithLastTime);
  });

  /**
   * *** `partial` BINDS PAGE TWO TOO. ***
   *
   * The window is read once, so a `more` that continues a scan carries the same
   * `partial`. Without a rule for it the agent applies «no digas siete días»
   * only to page one and then says «ya te he dicho todas las que tengo esta
   * semana» on page two — about a week it never finished reading.
   */
  it("the prompt forbids the seven-day claim on a partial continuation too", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const rule = promptText
      .split("\n")
      .find((line) => line.includes("`more`") && line.includes("`partial`"));
    expect(rule, "the prompt has no rule about partial on a continuation").toBeDefined();
    expect(rule).toMatch(/siete días/);
  });

  /**
   * *** THE PROMPT NO LONGER DOES THE SERVER'S JOB. ***
   *
   * The two rules `scan` replaces told the agent to pick the next working day
   * itself and to filter the returned hours itself. Both are gone, and they
   * have to STAY gone: a prompt that keeps either one will quietly go back to
   * chaining `discover` calls the moment the model finds it familiar.
   */
  it("the prompt sends an open day or an hour condition to scan, and filters nothing", () => {
    const promptText = readText(V2_PROMPT_PATH);
    expect(promptText).toContain('`action: "scan"`');
    for (const field of ["date_from", "days", "after_time", "before_time"]) {
      expect(promptText.includes(field), `prompt is missing: ${field}`).toBe(true);
    }
    // The server filters; the agent does not.
    expect(promptText).toMatch(/No filtres tú la lista/);
    // 2026-09-15: reworded from «Nunca propones tú un día…» because the server's
    // look-ahead now proposes days. The agent still never INVENTS one.
    expect(promptText).toMatch(/Nunca te inventas un día ni recorres los días uno a uno/);
    expect(promptText).toMatch(/los únicos días que propones son los que trae el `message` del servidor/);
    // The retired rules, by their own words.
    expect(promptText).not.toContain("propón tú el siguiente día laborable");
    expect(promptText).not.toContain("como máximo tres días seguidos");
    expect(promptText).not.toContain("recorre los días en orden");
    // `no_availability` after a scan is an answer, not a failure to retry.
    expect(promptText).toMatch(/`no_availability` tras un scan no es un error/);
  });

  /** The window diagnostics are for the agent's head, never for the caller. */
  it("the prompt forbids speaking the window diagnostics out loud", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const row = promptText
      .split("\n")
      .find((line) => line.includes("`days_summary`") && line.includes("`partial`"));
    expect(row, "the prompt has no rule about the scan diagnostics").toBeDefined();
    for (const field of [
      "days_checked",
      "page_index",
      "offered_so_far",
      "total_unique_slots",
    ]) {
      expect(row!.includes(field), `the rule is missing: ${field}`).toBe(true);
    }
    expect(row).toMatch(/nunca los dices en voz alta/);
    // `partial` also changes what may be CLAIMED, not just what is spoken.
    expect(promptText).toMatch(/Si `partial` es verdadero no digas «siete días»/);
  });

  it("the route file describes the endpoint it actually registers", () => {
    const words = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"] as const;
    const source = readText(V2_ROUTES_PATH);
    expect(source).not.toContain("ONE endpoint, TWO actions");
    expect(source).toContain(`ONE endpoint, ${words[BALANCED_ACTIONS.length]} actions`);
  });

  /**
   * *** «MÁS TARDE» MEANS THE SAME DAY. ***
   *
   * The production call this rule exists for named hours for one day, the
   * caller asked «¿tienes algo más tarde?», and the agent spent four turns
   * asking whether that meant the same day or another one. The fix is a rule,
   * not a sentence to recite, so this asserts on structure: the same-day
   * subsection exists, sits next to the words «mismo día», and tells the agent
   * to scan that one day (`days 1`) with a time filter — while «más adelante»,
   * which keeps meaning another day, is still on record.
   */
  it("the prompt treats «más tarde» and «más pronto» as the same day, with days 1 and a time filter", () => {
    const promptText = readText(V2_PROMPT_PATH);
    expect(promptText).toContain("«más tarde»");
    expect(promptText).toContain("«más pronto»");
    expect(promptText).toContain("«más adelante»");
    const headingIndex = promptText.indexOf("## MÁS TARDE, MÁS PRONTO, OTRA HORA");
    expect(headingIndex, "the prompt has no same-day continuity subsection").toBeGreaterThanOrEqual(
      0,
    );
    const nextHeadingIndex = promptText.indexOf("\n# OTROS HORARIOS", headingIndex);
    expect(nextHeadingIndex).toBeGreaterThan(headingIndex);
    const block = promptText.slice(headingIndex, nextHeadingIndex);
    expect(block).toMatch(/mismo día/);
    expect(block).toContain("days 1");
    expect(block).toContain("after_time");
  });

  /**
   * *** `end_call` HANGS UP; NOTHING ELSE DOES. ***
   *
   * `end_call` is an ElevenLabs SYSTEM tool, enabled in the console, never a
   * webhook the middleware serves — so it must never reach
   * `TOOL_SCHEMAS_BALANCED_V2.json`, which documents only the two HTTP tools.
   * Reusing `V2_SCHEMAS_PATH` here means a future edit that accidentally adds
   * it to the JSON fails in the same place every other schema drift does.
   */
  it("the prompt closes the call with end_call, and the JSON schema never mentions it", () => {
    const promptText = readText(V2_PROMPT_PATH);
    expect(promptText).toContain("end_call");
    expect(promptText).toContain("# CIERRE DE LA LLAMADA");
    expect(promptText).toContain("¿Te puedo ayudar en algo más?");
    const schemasText = readText(V2_SCHEMAS_PATH);
    expect(schemasText).not.toContain("end_call");
  });

  /**
   * *** CUSTOMER DATA IS THE ONE EXCEPTION TO "ONE QUESTION AT A TIME". ***
   *
   * 17 real calls with Qwen3.5-397B asked name, then surnames, then phone in
   * three separate turns — the combined question was never used, because the
   * general "one question at a time" rule (stated twice) was read as
   * overriding the specific one. This locks in the fix: the exception is
   * spelled out in both general places, the combined sentence is a hard rule,
   * and the one-by-one pattern appears in the document ONLY inside its own
   * ✗ example, never as an instruction to follow.
   */
  /**
   * *** A TOKEN ERROR AT CREATE TIME IS RE-CHECKED WITH THE CUSTOMER, NEVER SILENTLY. ***
   *
   * The 2026-09-15 rule was a SILENT re-lock «of the same slot» plus a create
   * without re-confirmation. `lock` takes an `option_index` that resolves
   * against the CURRENT page, so after any other page that silent re-lock
   * could lock — and book — a different day, hour or professional
   * (tests/balancedV2LockSupersession.test.ts proves it). ADR-022 removed the
   * cause (browsing no longer retires a lock), so this refusal is now rare, and
   * its recovery re-checks the exact confirmed hour (discover with day,
   * professional and preferred_time → lock option 1) and repeats the summary
   * before any second create.
   */
  it("the prompt re-checks a refused slot_token with a new summary, never with a silent re-lock", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const rowIndex = promptText.indexOf(
      "invalid_slot_token, slot_token_expired, slot_not_authorized:",
    );
    expect(rowIndex, "prompt has no combined row for the three token outcomes").toBeGreaterThanOrEqual(0);
    const row = promptText.slice(rowIndex, promptText.indexOf("\n", rowIndex));
    expect(row).toMatch(/tampoco vuelvas a crear sin el cliente/);
    expect(row).toContain("preferred_time igual a su hora");
    expect(row).toMatch(/repite el resumen completo con el `slot` de ESE lock/);
    expect(row).toMatch(/solo tras un «sí» claro haz create/);
    expect(row).toMatch(/Nunca bloquees un option_index de una página anterior/);
    expect(row).toMatch(/[Cc]omo mucho una recomprobación por llamada/);
    expect(row).toContain("CONSULTAS NO RESUELTAS POR WHATSAPP");
    // The unsafe instruction is gone from the whole prompt.
    expect(promptText).not.toMatch(/sin repetir resumen ni confirmación/);
    expect(promptText).not.toMatch(/reintento automático/);
    expect(promptText).not.toMatch(/lock nuevo para el MISMO hueco/);
    // slot_taken keeps its own, separate meaning: the slot is really gone.
    const slotTakenRow = promptText
      .split("\n")
      .find((line) => line.startsWith("- slot_taken:"));
    expect(slotTakenRow, "prompt has no dedicated slot_taken row under CREACIÓN DE LA CITA").toBeDefined();
    expect(slotTakenRow).toMatch(/el hueco se acaba de ocupar/);
    // One creation per token, and a new token needs a new «sí».
    expect(promptText).toMatch(/La creación se ejecuta UNA sola vez por slot_token\./);
    expect(promptText).toMatch(/sin haber repetido antes el resumen con el `slot` de ese nuevo lock/);
  });

  /**
   * *** THE TOKEN IS ALWAYS THE MOST RECENT SUCCESSFUL LOCK'S (ADR-022). ***
   *
   * Browsing never retires it, so a caller who returns to the locked choice
   * is booked with that same token; any NEW choice is locked before the
   * summary, and the summary reads day, hour and professional from that
   * lock's `slot` — which is exactly what the server will book.
   */
  it("the prompt states the most-recent-lock rule and reads the summary from the lock's slot", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const headingIndex = promptText.indexOf("# SELECCIÓN Y BLOQUEO DE LA HORA");
    const nextHeadingIndex = promptText.indexOf("\n# DATOS DEL CLIENTE", headingIndex);
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(nextHeadingIndex).toBeGreaterThan(headingIndex);
    const block = promptText.slice(headingIndex, nextHeadingIndex);
    expect(block).toMatch(/slot_token vigente es siempre el del lock MÁS RECIENTE que salió locked/);
    expect(block).toMatch(/Consultar \(discover, more o scan\) no lo anula/);
    expect(block).toMatch(/haz lock de esa hora antes del resumen/);
    expect(block).toMatch(/sigue la recomprobación de CREACIÓN DE LA CITA/);

    const summaryIndex = promptText.indexOf("# RESUMEN Y CONFIRMACIÓN");
    const summary = promptText.slice(summaryIndex, promptText.indexOf("\n# CAMBIO DE PROFESIONAL", summaryIndex));
    expect(summary).toMatch(/salen SIEMPRE del `slot` del último lock que salió locked/);

    const changeIndex = promptText.indexOf("# CAMBIO DE PROFESIONAL");
    const change = promptText.slice(changeIndex, promptText.indexOf("\n# CREACIÓN DE LA CITA", changeIndex));
    expect(change).toMatch(/solo si desde ese lock no has hecho ninguna consulta nueva/);
  });

  /**
   * *** THE HESITANT CALLER GETS REASSURANCE, NOT A HANG-UP. ***
   *
   * Some callers — mostly elderly — hang up at the greeting, unsure whether
   * they have reached a scam or a machine. The prompt now answers that doubt
   * with what booking actually needs (day, time, name and phone) and an
   * explicit denial of ever asking for money or bank details, never with a
   * promised callback the salon cannot honour.
   */
  it("the prompt reassures a hesitant or distrustful caller without asking for money or promising a callback", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const rule = promptText
      .split("\n")
      .find((line) => line.includes("¿esto es de verdad?"));
    expect(rule, "the prompt has no rule for the hesitant/distrustful caller").toBeDefined();
    expect(rule).toMatch(/el día, la hora, su nombre y un teléfono de contacto/);
    expect(rule).toMatch(/nunca pides datos bancarios, tarjetas, códigos ni dinero/);
    expect(rule).toContain("CONSULTAS NO RESUELTAS POR WHATSAPP");
    const NO_CONTACT_PROMISE_RE =
      /te llamen|se pondr[áa] en contacto|call back|ring back|have the salon call/i;
    expect(NO_CONTACT_PROMISE_RE.test(rule ?? "")).toBe(false);
  });

  it("the prompt asks name, surnames and phone together, and marks asking one by one as wrong", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const combined = "¿Me dices tu nombre, apellidos y un teléfono de contacto?";
    expect(promptText).toContain(combined);
    // Both general "one question at a time" rules carry the exception.
    const exceptionRule = /Haz una sola pregunta cada vez \(la única excepción son los datos del cliente/;
    const exceptionBullet = /Una sola pregunta cada vez y frases cortas \(excepción: los datos del cliente/;
    expect(promptText).toMatch(exceptionRule);
    expect(promptText).toMatch(exceptionBullet);
    // The one-by-one pattern is a documented mistake, not an instruction: it
    // must only ever appear next to its own "✗".
    const oneByOne = "«¿Cuál es tu nombre?»";
    const occurrences = promptText.split(oneByOne).length - 1;
    expect(occurrences).toBe(1);
    const index = promptText.indexOf(oneByOne);
    const linesBefore = promptText.slice(0, index).split("\n");
    expect(linesBefore.at(-1)).toContain("✗");
  });

  /**
   * *** A STATED HOUR IS NEVER ANSWERED WITH `more` (incident 2026-09-15). ***
   *
   * The caller said «seis y cuarto» three times and the agent paged three
   * times, because the prompt only sent `preferred_time` for «una hora
   * aproximada» in the first discover and routed everything said after the
   * offer to `more`. The rule, its server sentences and the tool field have to
   * move together, or the model reads one and the server speaks another.
   */
  it("the prompt sends any stated hour to preferred_time, never to more, and never offers quarters", () => {
    const promptText = readText(V2_PROMPT_PATH);
    const spoken = spokenText(V2_PROMPT_PATH);

    const headingIndex = promptText.indexOf("## EL CLIENTE DICE UNA HORA");
    expect(headingIndex, "the prompt has no stated-hour subsection").toBeGreaterThanOrEqual(0);
    const nextHeadingIndex = promptText.indexOf("\n# GESTIÓN DE LA DISPONIBILIDAD", headingIndex);
    expect(nextHeadingIndex).toBeGreaterThan(headingIndex);
    const block = promptText.slice(headingIndex, nextHeadingIndex);

    // Any moment, including after hours were offered, and never `more`.
    expect(block).toMatch(/en cualquier momento/);
    expect(block).toMatch(/después de oír horas/);
    expect(block).toMatch(/nunca respondes con `more`/);
    // A lookup around THAT hour: discover with preferred_time, or the one-day
    // scan when a hard restriction is active.
    expect(block).toMatch(/`discover` del día[^\n]*`preferred_time`/);
    expect(block).toMatch(/`scan` de ese día con days 1, la misma restricción y `preferred_time`/);
    // Never quarters offered.
    expect(block).toMatch(/Nunca ofreces horas «y cuarto» ni «menos cuarto»/);
    // An insistent caller is answered, not paged.
    expect(block).toMatch(/Si insiste en una hora/);

    // The sentences quoted are the ones the middleware builds.
    for (const sentence of [
      balancedPreferredTimeMessage("18:00", ["18:00"], { exact: true }),
      balancedPreferredTimeMessage("18:15", ["18:00", "18:30"], { exact: false }),
      balancedPreferredTimeMessage("18:15", ["14:00"], { exact: false }),
    ]) {
      expect(spoken).toContain(sentence);
    }

    // The old narrowing is gone from the discover field list.
    expect(promptText).not.toContain("preferred_time solo si ha mencionado una hora aproximada");
    expect(promptText).toMatch(/- preferred_time siempre que haya dicho una hora/);

    // OTROS HORARIOS: a concrete hour is not a request for the next page.
    const otros = promptText.slice(
      promptText.indexOf("\n# OTROS HORARIOS"),
      promptText.indexOf("\n# SELECCIÓN Y BLOQUEO DE LA HORA"),
    );
    expect(otros).toMatch(/SIN decir una hora concreta/);
    expect(otros).toContain(
      "Si dice una hora concreta que no está en la página vigente, eso no es more: sigue EL CLIENTE DICE UNA HORA.",
    );

    // The tool field says the same thing the prompt does.
    const properties = tool(AVAILABILITY_TOOL).parameters.properties ?? {};
    const field = properties["preferred_time"] as { description: string } | undefined;
    expect(field).toBeDefined();
    expect(field?.description).toMatch(/Never answer a stated hour with action="more"/);
    expect(field?.description).toMatch(/nearest free hours before and after/);
    expect(field?.description).not.toMatch(/only RANKS/);
  });
});

/**
 * *** WHAT THE ACCESS LINE SAYS A CONTINUATION MEANT. ***
 *
 * `ResultCategory` is a CLOSED union, so `more`'s three new outcomes had to be
 * MAPPED onto it rather than passed through. The mapping is a claim about
 * operations, and a wrong one is invisible: every answer is still HTTP 200, so
 * a `continuation_lost` logged as `ok` would simply never appear on a
 * dashboard, and the failure this whole mission exists for would be silent all
 * over again.
 *
 * The category is read off the request the way the access line reads it, not
 * off the source, so this fails if the mapping changes for any reason.
 */
