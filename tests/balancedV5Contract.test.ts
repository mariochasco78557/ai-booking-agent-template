import {
  BOOKING_INDEX_FIELD,
  CUSTOMER_NAME_FIELD,
  DICTATED_PHONE_FIELD,
  INTENT_FIELD,
  REPLACES_EXISTING_BOOKING_FIELD,
  VOICE_MANAGE_ACTIONS,
} from "../src/services/voiceManage/voiceManageService.js";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { balancedAvailabilitySchema } from "../src/schemas/balancedV2Schemas.js";
import { voiceBookSchema } from "../src/schemas/aiSchemas.js";
import {
  CALLER_PHONE_FIELD,
  DAY_NAME_FIELD,
  FECHA_DICHA_FIELD,
  FECHA_PIECE_FIELDS,
  OPTION_DATE_FIELD,
  OPTION_TIME_FIELD,
  REPLACES_BOOKING_NUMBER_FIELD,
} from "../src/routes/balancedV2.js";
import { bookingConfirmedMessage } from "../src/utils/phrasing.js";
import {
  AGENT_PROFILE_FIELD,
  AGENT_PROFILE_V5,
} from "../src/services/balanced/agentProfile.js";
import {
  BALANCED_ALREADY_BOOKED_MESSAGE,
  BALANCED_SLOT_ALREADY_BOOKED_IN_CALL_MESSAGE,
  balancedBookingLimitMessage,
  balancedEmployeeAlternativeMessage,
  balancedExtendedLookAheadMessage,
  balancedLookAheadTwoWeeksNothingMessage,
  balancedPeriodAlternativeMessage,
  balancedPreferredTimeMessage,
  balancedScanExtendedMessage,
  balancedV5ConfirmedMessage,
  balancedScanTwoWeeksNothingMessage,
} from "../src/utils/balancedPhrasing.js";

/**
 * V5 — the agreement suite for the multi-booking prompt and tool document
 * ((internal doc, not included in the template) ADR-023).
 *
 * The V5 prompt is the V4 prompt plus one section. That is asserted LINE BY
 * LINE: every V4 line must be in V5 verbatim, except a short, explicit list of
 * lines V5 replaces — so a V4 rule can never silently disappear from V5, and a
 * V4 fix that is not carried over fails here. The tool document must keep the
 * V4 request contract exactly, plus ONE field on both tools: the constant
 * `agent_profile: "v5"` that activates V5 per request (ADR-025).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const elevenlabsDir = join(repoRoot, "docs", "elevenlabs");

const V4_PROMPT_PATH = join(elevenlabsDir, "AGENT_PROMPT_BALANCED_V2_ES.md");
const V5_PROMPT_PATH = join(elevenlabsDir, "AGENT_PROMPT_BALANCED_V5_ES.md");
const V4_SCHEMAS_PATH = join(elevenlabsDir, "TOOL_SCHEMAS_BALANCED_V2.json");
const V5_SCHEMAS_PATH = join(elevenlabsDir, "TOOL_SCHEMAS_BALANCED_V5.json");

const AVAILABILITY_TOOL = "booking_availability_balanced_v2";
const CREATE_TOOL = "booking_create_booking_balanced_v2";

interface JsonTool {
  name: string;
  path: string;
  method: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  [key: string]: unknown;
}

const read = (path: string): string => readFileSync(path, "utf8");
const tools = (path: string): JsonTool[] => (JSON.parse(read(path)) as { tools: JsonTool[] }).tools;
const flat = (text: string): string => text.replace(/\s+/g, " ");

/** V4 lines V5 rewrites, each with a fragment its V5 replacement must contain. */
const REPLACED_V4_LINES: ReadonlyArray<{
  startsWith: string;
  v5Contains: string;
  /** When V5 rewrites the start of the line too: the V5 line's own prefix. */
  v5StartsWith?: string;
}> = [
  {
    // 2026-10-08 (conv_1801m4bj…): read the message, re-ask only what it asks.
    startsWith: "- invalid_customer_data: vuelve a pedir nombre, apellidos y teléfono.",
    v5StartsWith: "- invalid_customer_data: lee el `message` tal cual",
    v5Contains: "sin corregir tú nada",
  },
  {
    startsWith: "Con el lock hecho y los datos, haz un único resumen corto",
    v5Contains: "sin repetir las cifras",
  },
  {
    startsWith: "Cuando `outcome` es `\"confirmed\"`, la cita está hecha",
    v5Contains: "sigue VARIAS CITAS EN UNA LLAMADA",
  },
  {
    startsWith: "- already_booked_in_call, write_disabled, upstream_error, misconfigured_owner",
    v5Contains: "`booking_limit_reached` falso",
  },
  {
    startsWith: "- invalid_slot_token, slot_token_expired, slot_not_authorized",
    v5Contains: "Como mucho una recomprobación por cita",
  },
  // ADR-024 — SIEMPRE UNA PUERTA ABIERTA: the open question gains «u hora» and
  // «Te lo miro ahora», and WhatsApp for lack of availability is routed there.
  {
    startsWith: "El cliente nunca puede quedarse solo con una negativa",
    v5Contains: "como dice SIEMPRE UNA PUERTA ABIERTA",
  },
  {
    startsWith: "- Si dice «no», «otro día» o que no le va ese día, sin decir cuál",
    v5Contains: "«¿Qué día u hora te vendría mejor? Te lo miro ahora.»",
  },
  {
    // V4 starts this line with «El cliente rechaza…»; V5 rewrites the start.
    startsWith: "- El cliente rechaza las alternativas de más horas y de franja",
    v5StartsWith: "- Falta de hueco, solo como dice SIEMPRE UNA PUERTA ABIERTA",
    v5Contains: "«¿Qué día u hora te vendría mejor? Te lo miro ahora.»",
  },
  // ADR-026 — TOMA LA INICIATIVA: the wait sentence varies and is skipped when
  // the previous turn already announced the search.
  {
    startsWith: "Antes de CADA herramienta de datos di una sola frase corta de espera",
    v5StartsWith: "Antes de cada herramienta de datos di una sola frase corta de espera",
    v5Contains: "no repitas la misma dos veces seguidas",
  },
  // ADR-026 — the server's own message may name a professional.
  {
    startsWith: "**No dices el nombre de ningún profesional hasta el resumen final.**",
    v5StartsWith: "**No dices el nombre de ningún profesional hasta el resumen final**, salvo",
    v5Contains: "(FRANJA O PROFESIONAL SIN HUECO)",
  },
  // Owner feedback 2026-09-16 — no abrupt closes: always ask an open question
  // before end_call and use a warm, varied farewell instead of «Pues te dejo».
  {
    startsWith: "- **Cita creada** (`booked: true` y `outcome` `\"confirmed\"`):",
    v5Contains: "pregunta abierta de arriba y espera la respuesta",
  },
  {
    startsWith: "- **Frase de WhatsApp**",
    v5Contains: "incluidos cambios y cancelaciones",
  },
  {
    startsWith: "- **El cliente se despide o dice que no necesita nada más**:",
    v5Contains: "despídete con calidez",
  },
  {
    startsWith: "- **Sigue callado tras dos intentos** de TOMA LA INICIATIVA:",
    v5Contains: "sin esperar respuesta",
  },
  {
    startsWith: "Nunca cuelgues a un cliente que sigue preguntando",
    v5Contains: "«pues te dejo», «te dejo», «voy a colgar» ni «corto»",
  },
  // ADR-027 — real calls 2026-09-16: a professional named after the offer is
  // looked up with discover, never locked blind with preferred_employee_id.
  {
    startsWith: "Vuelve a ejecutar booking_availability_balanced_v2 con action: lock, el mismo conversation_id",
    v5StartsWith: "Nunca hagas lock con preferred_employee_id de una hora que se ofreció sin ese profesional",
    v5Contains: "employee_id del profesional pedido, preferred_time esa hora",
  },
  // ADR-029 CONSULTAS NO RESUELTAS POR WHATSAPP, REGLA DE SALIDA y FLUJO —
  // «tranquilízale» queda acotado a la duda/desconfianza; una petición de
  // persona ya no pasa por ese párrafo, va directa a la salida de WhatsApp.
  {
    startsWith: "Si duda, se queda callado, parece confuso o desconfiado",
    v5StartsWith: "Esto vale SOLO para la duda o la desconfianza.",
    v5Contains: "no le tranquilices, no te presentes y no le pidas el día ni la hora",
  },
  // ADR-029 ALIAS FONÉTICOS DE NOMBRES / REPARTO ENTRE PROFESIONALES — un
  // nombre solo se dice si consta por employee_id de la consulta o por el
  // `message` del servidor.
  {
    startsWith: "No reformules y no menciones ningún profesional",
    v5Contains: "salvo el que ya conoces porque la consulta llevaba su employee_id (REPARTO ENTRE PROFESIONALES)",
  },
  // ADR-029 CAMBIO DE PROFESIONAL y REPARTO — «otro profesional» sin nombre ya
  // no se pregunta a ciegas: se pregunta con cuál, nombrando a los otros dos.
  {
    startsWith: "Si pide otro profesional, **No creas nada.** Si no dice cuál, pregúntaselo.",
    v5StartsWith: "**Si no dice cuál («otro profesional»",
    v5Contains: "pregúntaselo antes de consultar nada, nombrando a los DOS",
  },
  // ADR-029 CONSULTAS NO RESUELTAS POR WHATSAPP, REGLA DE SALIDA y FLUJO —
  // petición explícita de persona: salida a la primera, sin discutir.
  {
    startsWith: "- El cliente pide hablar con una persona.",
    v5StartsWith: "- **El cliente pide hablar con una persona, la PRIMERA vez que lo pide**",
    v5Contains: "pasas a CIERRE DE LA LLAMADA",
  },
  // ADR-029 CONSULTAS NO RESUELTAS POR WHATSAPP, REGLA DE SALIDA y FLUJO —
  // la petición de persona es la única salida que va la primera, no la última.
  {
    startsWith: "Nunca la uses para tapar algo que sí puedes continuar: otra página con more, la otra franja o un día distinto van antes.",
    v5Contains: "Cuando el cliente pide hablar con una persona es al revés: ahí es la primera salida",
  },
  // ADR-029 CONSULTAS NO RESUELTAS POR WHATSAPP, REGLA DE SALIDA y FLUJO —
  // dos frases exactas ahora, una para la petición de persona y otra para el
  // resto de esta sección.
  {
    startsWith: "En esos casos di exactamente:",
    v5StartsWith: "En todos los demás casos de esta sección",
    v5Contains: "algo fuera de tu alcance",
  },
];

function multiSection(): string {
  const text = read(V5_PROMPT_PATH);
  const start = text.indexOf("# VARIAS CITAS EN UNA LLAMADA");
  const end = text.indexOf("\n# ", start + 1);
  expect(start).toBeGreaterThan(0);
  return text.slice(start, end);
}

describe("balanced v5 · prompt = V4 + the multi-booking section", () => {
  it("every V4 line is in V5 verbatim, except the declared replacements", () => {
    const v5Lines = new Set(read(V5_PROMPT_PATH).split("\n"));
    const v4Lines = read(V4_PROMPT_PATH).split("\n");
    const missing: string[] = [];
    for (const line of v4Lines) {
      if (v5Lines.has(line)) continue;
      const replaced = REPLACED_V4_LINES.find((entry) => line.startsWith(entry.startsWith));
      if (replaced === undefined) missing.push(line);
    }
    expect(missing).toEqual([]);
  });

  it("each replaced V4 line has its V5 counterpart, and no more lines are replaced than declared", () => {
    const v5 = read(V5_PROMPT_PATH);
    const v4Lines = new Set(read(V4_PROMPT_PATH).split("\n"));
    for (const entry of REPLACED_V4_LINES) {
      const v5Line = v5
        .split("\n")
        .find((line) => line.startsWith(entry.v5StartsWith ?? entry.startsWith));
      expect(v5Line, entry.startsWith).toBeDefined();
      expect(v5Line).toContain(entry.v5Contains);
      expect(v4Lines.has(v5Line as string)).toBe(false);
    }
  });

  it("the V4 prompt itself carries no multi-booking rule", () => {
    const v4 = read(V4_PROMPT_PATH);
    expect(v4).not.toContain("VARIAS CITAS");
    expect(v4).not.toContain("max_bookings_per_call");
  });

  it("the section is only for a customer who asks, never offered, and capped at three", () => {
    const section = multiSection();
    expect(section).toContain("**Nunca ofrezcas otra cita ni preguntes si quiere más**");
    expect(section).toContain("solo se activa si el cliente la pide él mismo");
    expect(section).toContain("Máximo tres citas por llamada");
    expect(flat(section)).toContain(
      "«Por llamada puedo dejar como máximo tres citas. Para otra más, puedes volver a llamar o escribirnos por WhatsApp a este mismo número.»",
    );
  });

  it("the section is sequential: one appointment fully confirmed before the next, each with its own token", () => {
    const section = multiSection();
    expect(section).toContain("Una cita cada vez y completa");
    expect(section).toContain("Solo entonces pasas a la siguiente");
    expect(section).toContain("nunca crees una cita con el slot_token de otra");
    expect(section).toContain("Nunca bloquees ni reserves dos horas a la vez");
  });

  it("the section gates the next appointment on the server's own fields", () => {
    const section = multiSection();
    expect(section).toContain("`max_bookings_per_call`");
    expect(section).toContain("`booking_number`");
    expect(section).toContain("`booking_limit_reached` verdadero");
    expect(section).toContain("`booking_limit_reached` falso");
    // A deployment still at one booking per call answers with the V4 sentence.
    expect(section).toContain(BALANCED_ALREADY_BOOKED_MESSAGE);
  });

  it("the next appointment is anchored next to the previous one with preferred_time, no arithmetic", () => {
    const section = multiSection();
    expect(section).toContain("mismo `date`");
    expect(section).toContain("`preferred_time` igual a su `slot.time`");
    expect(section).toContain("sin employee_id");
  });

  it("asks each person's name, and the phone only as «¿Uso el mismo teléfono?»", () => {
    const section = multiSection();
    expect(section).toContain(
      "«¿Me dices el nombre y los apellidos de la persona de esta cita? ¿Uso el mismo teléfono?»",
    );
    expect(section).toContain("Nunca vuelvas a pedir el teléfono si ya ha dicho que es el mismo");
  });

  it("the prompt carries, verbatim, the V5 sentences the middleware produces", () => {
    const v5 = flat(read(V5_PROMPT_PATH));
    expect(v5).toContain(balancedBookingLimitMessage(3));
    expect(v5).toContain(BALANCED_SLOT_ALREADY_BOOKED_IN_CALL_MESSAGE);
    expect(v5).toContain("«dos citas» si el máximo es dos");
  });

  it("nothing new promises a callback, a transfer or contact", () => {
    const PROMISE_RE =
      /te (llamaremos|llamarán|llamamos)|devolver(te)? la llamada|pondr(á|emos) en contacto|te paso con|te transfiero/i;
    for (const text of [
      multiSection(),
      balancedBookingLimitMessage(2),
      balancedBookingLimitMessage(3),
      BALANCED_SLOT_ALREADY_BOOKED_IN_CALL_MESSAGE,
    ]) {
      expect(PROMISE_RE.test(text), text).toBe(false);
    }
  });
});

function openDoorSection(): string {
  const text = read(V5_PROMPT_PATH);
  const start = text.indexOf("## SIEMPRE UNA PUERTA ABIERTA");
  expect(start).toBeGreaterThan(0);
  const end = text.indexOf("\n#", start + 1);
  return text.slice(start, end);
}

describe("balanced v5 · SIEMPRE UNA PUERTA ABIERTA (ADR-024)", () => {
  it("the rule is in V5 and not in V4", () => {
    expect(openDoorSection()).toContain("Nunca pierdas una cita por falta de hueco");
    const v4 = read(V4_PROMPT_PATH);
    expect(v4).not.toContain("SIEMPRE UNA PUERTA ABIERTA");
    expect(v4).not.toContain("Si quieres te lo miro ahora");
    expect(v4).not.toContain("próximas dos semanas");
  });

  it("WhatsApp for lack of availability only after offer, refusal and ONE open question", () => {
    const section = flat(openDoorSection());
    expect(section).toContain("solo ofreces WhatsApp o te despides cuando se cumplen las tres cosas");
    expect(section).toContain("el servidor ha ofrecido las alternativas concretas más cercanas");
    expect(section).toContain("el cliente las ha rechazado");
    expect(section).toContain(
      "le has hecho UNA sola vez la pregunta abierta «¿Qué día u hora te vendría mejor? Te lo miro ahora.» y has consultado lo que ha dicho",
    );
    // The two other places that route to WhatsApp point at the rule.
    const v5 = read(V5_PROMPT_PATH);
    expect(v5.match(/como dice SIEMPRE UNA PUERTA ABIERTA/g)?.length).toBe(2);
    // The old, shorter open question is gone from V5.
    expect(v5).not.toContain("«¿Qué día te vendría mejor?»");
  });

  it("«Si quieres te lo miro ahora» is offered once, and a clear no is respected", () => {
    const v5 = read(V5_PROMPT_PATH);
    expect(v5.match(/Si quieres te lo miro ahora/g)?.length).toBe(1);
    const section = flat(openDoorSection());
    expect(section).toContain("«ya llamaré», «lo miro y te llamo»");
    expect(section).toContain("le ofreces una sola vez: «Si quieres te lo miro ahora y te lo dejo apañado, ¿te parece?»");
    expect(section).toContain("lo respetas sin insistir");
    expect(section).toContain("Nunca lo ofreces una segunda vez en la llamada");
  });

  it("every turn after no availability ends on a question, and the rule applies per booking", () => {
    const section = flat(openDoorSection());
    expect(section).toContain("Cada turno tuyo después de una respuesta sin hueco termina en una pregunta");
    expect(section).toContain("VARIAS CITAS EN UNA LLAMADA la regla vale para cada cita por separado");
  });

  it("the exact forms are the sentences the middleware produces", () => {
    const section = openDoorSection();
    const expected = [
      balancedExtendedLookAheadMessage({
        reason: "full",
        requestedDate: "2026-09-22",
        period: "afternoon",
        otherPeriodHasHours: true,
        offeredDate: "2026-09-29",
        times: ["17:00", "17:30"],
      }),
      balancedExtendedLookAheadMessage({
        reason: "closed",
        requestedDate: "2026-09-21",
        period: "afternoon",
        otherPeriodHasHours: true,
        offeredDate: "2026-09-29",
        times: ["17:00"],
      }),
      balancedLookAheadTwoWeeksNothingMessage({
        reason: "full",
        requestedDate: "2026-09-22",
        period: "afternoon",
        otherPeriodHasHours: true,
      }),
      balancedLookAheadTwoWeeksNothingMessage({
        reason: "full",
        requestedDate: "2026-09-22",
        period: "afternoon",
        otherPeriodHasHours: false,
      }),
      balancedScanExtendedMessage({
        afterTime: "17:00",
        days: 7,
        offeredDate: "2026-09-29",
        times: ["17:00", "17:30"],
      }),
      balancedScanTwoWeeksNothingMessage({ afterTime: "17:00", otherHoursSeen: true }),
      balancedScanTwoWeeksNothingMessage({ period: "afternoon", otherHoursSeen: true }),
      balancedScanTwoWeeksNothingMessage({ afterTime: "17:00", otherHoursSeen: false }),
    ];
    const lines = section.split("\n");
    for (const sentence of expected) {
      expect(lines, sentence).toContain(sentence);
    }
  });
});

describe("balanced v5 · tool document", () => {
  it("has the same two tools, names, paths and methods as V4", () => {
    const pick = (path: string) =>
      tools(path)
        .map(({ name, path: route, method }) => ({ name, route, method }))
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(pick(V5_SCHEMAS_PATH)).toEqual(pick(V4_SCHEMAS_PATH));
  });

  
  it("the V4 tool document never mentions agent_profile", () => {
    expect(read(V4_SCHEMAS_PATH)).not.toContain(AGENT_PROFILE_FIELD);
    expect(read(V4_PROMPT_PATH)).not.toContain(AGENT_PROFILE_FIELD);
  });

  it("the create tool enumerates every booking outcome and describes the three V5 response fields", () => {
    const source = read(join(repoRoot, "src", "services", "voiceBookingService.ts"));
    const block = source.slice(
      source.indexOf("  outcome:"),
      source.indexOf("  /**\n   * Whether an appointment was created upstream"),
    );
    const outcomes = [...block.matchAll(/\|\s*"([a-z_]+)"/g)].map((match) => match[1]!);
    expect(outcomes.length).toBeGreaterThan(8);
    const text = JSON.stringify(tools(V5_SCHEMAS_PATH).find((t) => t.name === CREATE_TOOL));
    for (const outcome of outcomes) expect(text, outcome).toContain(outcome);
    for (const field of ["booking_number", "max_bookings_per_call", "booking_limit_reached"]) {
      expect(text, field).toContain(field);
      expect(source, `VoiceBookResult declares ${field}`).toContain(`  ${field}?:`);
    }
    expect(text).toContain(balancedBookingLimitMessage(3));
    expect(text).toContain(BALANCED_SLOT_ALREADY_BOOKED_IN_CALL_MESSAGE);
    expect(text).toContain("never more than three per call");
  });

  it("no real-looking Spanish phone number appears in the V5 artefacts", () => {
    const phoneRe = /(?:\+34)?[6789]\d{8}/g;
    for (const path of [V5_SCHEMAS_PATH, V5_PROMPT_PATH]) {
      for (const match of read(path).match(phoneRe) ?? []) {
        const digits = match.startsWith("+34") ? match.slice(3) : match;
        expect(digits.startsWith("600000"), `${path}: ${match}`).toBe(true);
      }
    }
  });
});

function sectionOf(heading: string): string {
  const text = read(V5_PROMPT_PATH);
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(0);
  const end = text.indexOf("\n#", start + 1);
  return text.slice(start, end);
}

describe("balanced v5 · the V4 prompt is untouched (ADR-026)", () => {
  
  it("carries none of the ADR-026 rules", () => {
    const v4 = read(V4_PROMPT_PATH);
    for (const fragment of [
      "TOMA LA INICIATIVA",
      "FRANJA O PROFESIONAL SIN HUECO",
      "next_in_requested_period",
      "¿Te lo reservo ya",
      "Déjame ver.",
    ]) {
      expect(v4, fragment).not.toContain(fragment);
    }
  });
});

describe("balanced v5 · CIERRE DE LA LLAMADA cálido (owner feedback 2026-09-16)", () => {
  const section = (): string => sectionOf("# CIERRE DE LA LLAMADA");

  it("never uses a curt closing phrase as an actual farewell — only names them to forbid them", () => {
    const v5 = read(V5_PROMPT_PATH);
    // The old abrupt example is gone.
    expect(v5).not.toContain("«Pues te dejo. Gracias por llamar, ¡hasta pronto!»");
    // Each forbidden quoted phrase appears exactly once: inside the sentence
    // that forbids it (CIERRE DE LA LLAMADA), never as a suggested farewell.
    for (const forbidden of ["«pues te dejo»", "«te dejo»", "«voy a colgar»", "«corto»"]) {
      expect(v5.match(new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length, forbidden).toBe(1);
    }
    expect(section()).toContain("«pues te dejo», «te dejo», «voy a colgar» ni «corto»");
  });

  it("always asks an open question and waits for the answer before end_call, except the silence exception", () => {
    const text = flat(section());
    expect(text).toContain(
      "Antes de colgar por cualquier motivo, salvo el silencio de TOMA LA INICIATIVA, haz siempre una sola pregunta abierta y espera la respuesta",
    );
    expect(text).toContain("«¿Te puedo ayudar en algo más?»");
    expect(text).toContain("«¿Hay algo más en lo que te pueda ayudar?»");
    // Including the appointment-change / cancellation → WhatsApp path.
    expect(text).toContain("también cuando solo quería cambiar o cancelar una cita, justo después de la frase de WhatsApp");
    expect(text).toContain("incluidos cambios y cancelaciones");
    // The silence exception does not wait for an answer.
    expect(text).toContain("sin esperar respuesta");
  });

  it("has varied, warm example farewells that make clear the call is ending", () => {
    const text = flat(section());
    for (const farewell of [
      "«Muchas gracias por llamar a Chimac Peluqueros. ¡Que tengas muy buen día!»",
      "«Gracias a ti. ¡Nos vemos pronto en la peluquería!»",
      "«Un placer, ¡que vaya muy bien!»",
    ]) {
      expect(text, farewell).toContain(farewell);
    }
    // ADR-027: no example farewell opens with the word the prompt forbids.
    expect(text).not.toContain("«Perfecto, muchas gracias");
    expect(text).toContain("La despedida nunca empieza por «Perfecto».");
  });

  it("never hangs up on a customer still asking, and keeps helping on a yes", () => {
    const text = flat(section());
    expect(text).toContain("Si pregunta otra cosa, le sigues ayudando: nunca cuelgas a quien todavía está preguntando");
    expect(text).toContain("Si dice que sí, sigue ayudando y no cuelgues");
  });
});

describe("balanced v5 · FRANJA O PROFESIONAL SIN HUECO (ADR-026)", () => {
  const section = (): string => sectionOf("## FRANJA O PROFESIONAL SIN HUECO");

  it("the exact forms are the sentences the middleware produces", () => {
    const expected = [
      balancedPeriodAlternativeMessage({
        requested: "afternoon",
        offered: "morning",
        sameDayTimes: ["12:00", "12:30"],
        nextDate: "2026-09-24",
        nextTime: "16:00",
      }),
      balancedPeriodAlternativeMessage({
        requested: "morning",
        offered: "afternoon",
        sameDayTimes: ["17:00", "18:00"],
        nextDate: "2026-09-23",
        nextTime: "10:30",
      }),
      balancedEmployeeAlternativeMessage({
        employeeName: "Bruno",
        others: [
          { name: "Ramón", time: "12:00" },
          { name: "Ramón", time: "12:30" },
        ],
        nextDate: "2026-09-22",
        nextTime: "17:00",
      }),
      balancedEmployeeAlternativeMessage({
        employeeName: "Bruno",
        others: [
          { name: "Ramón", time: "12:00" },
          { name: "Olga", time: "12:30" },
        ],
        nextDate: "2026-09-22",
        nextTime: "17:00",
      }),
      balancedEmployeeAlternativeMessage({
        employeeName: "Bruno",
        others: [
          { name: "Olga", time: "12:00" },
          { name: "Olga", time: "13:00" },
        ],
        othersPeriod: "morning",
        nextDate: "2026-09-22",
        nextTime: "17:00",
      }),
    ];
    const lines = section().split("\n");
    for (const sentence of expected) {
      expect(lines, sentence).toContain(sentence);
    }
    // The two literal examples of the 2026-09-16 feedback.
    expect(lines).toContain(
      "Esa tarde la tengo completa. Por la mañana tengo a las doce o a las doce y media; y si prefieres tarde, lo más cercano es el jueves veinticuatro a las cuatro. ¿Qué te viene mejor?",
    );
    expect(lines).toContain(
      "Con Bruno ese día está completo. Ramón tiene a las doce o a las doce y media; o con Bruno, lo más cercano es el martes veintidós a las cinco. ¿Qué prefieres?",
    );
  });

  it("locks without preferred_employee_id, keeps `more` on the requested day and never reads the new field", () => {
    const text = flat(section());
    expect(text).toContain("**sin preferred_employee_id**");
    expect(text).toContain("`more` sigue con las horas del día pedido");
    expect(text).toContain("`next_in_requested_period`");
    expect(text).toContain("no lo leas aparte");
    expect(text).toContain("el resumen sale del `slot` del lock");
  });
});

describe("balanced v5 · TOMA LA INICIATIVA (ADR-026)", () => {
  const section = (): string => flat(sectionOf("# TOMA LA INICIATIVA"));

  it("silence is met with a next step, never a cold «¿Sigues ahí?», at most twice", () => {
    const text = section();
    expect(text).toContain("nunca preguntes en frío «¿Sigues ahí?»");
    expect(text).toContain("«¿Te miro otro día de esta semana o pasamos a la siguiente?»");
    expect(text).toContain("Como mucho dos intentos así seguidos");
    expect(text).toContain(
      "«Si quieres, piénsalo con calma y cuando lo tengas nos llamas o nos escribes por WhatsApp a este mismo número. ¡Que vaya bien!»",
    );
    expect(text).toContain("`end_call` como dice CIERRE DE LA LLAMADA");
    expect(flat(sectionOf("# CIERRE DE LA LLAMADA"))).toContain(
      "**Sigue callado tras dos intentos** de TOMA LA INICIATIVA",
    );
  });

  it("short turns, at most three hours, and a solution in the same sentence as a no", () => {
    const text = section();
    expect(text).toContain("frases de unas veinte palabras como mucho");
    expect(text).toContain("nunca más de tres horas en un turno");
    expect(text).toContain("la solución va en la misma frase");
  });

  it("the wait sentence varies, never repeats, and is skipped after an announced search", () => {
    const v5 = flat(read(V5_PROMPT_PATH));
    expect(v5).toContain("«Un momento.», «Lo miro.», «Déjame ver.»");
    expect(v5).toContain("no repitas la misma dos veces seguidas");
    expect(v5).toContain("no digas frase de espera: llama directamente");
    expect(v5).not.toContain("«Un momento, lo miro.»");
  });

  it("«ya llamaré»: one offer, «¿Te lo reservo ya…?» after a liked hour, no holds, no WhatsApp deadlines", () => {
    const text = flat(openDoorSection());
    expect(text).toContain("«¿Te lo reservo ya y así te aseguras la hora?»");
    expect(text).toContain("Nunca prometas guardarle una hora sin reservarla ni un plazo de respuesta por WhatsApp");
    expect(text).toContain("«lo pienso»");
    const v5 = read(V5_PROMPT_PATH);
    expect(v5.match(/¿Te lo reservo ya/g)?.length).toBe(1);
  });

  it("nothing new promises a callback, a transfer or a response time", () => {
    const PROMISE_RE =
      /\bte (llamaremos|llamarán|llamamos)|devolver(te)? la llamada|pondr(á|emos) en contacto|\bte paso con|\bte transfiero|\bte (responderemos|contestaremos) en/i;
    // `\b`: «el siguiente paso con…» is not «te paso con».
    expect(PROMISE_RE.test(section())).toBe(false);
    expect(PROMISE_RE.test(sectionOf("## FRANJA O PROFESIONAL SIN HUECO"))).toBe(false);
  });
});

describe("balanced v5 · real calls 2026-09-16 (ADR-027)", () => {
  const v5 = (): string => flat(read(V5_PROMPT_PATH));

  it("no quoted example the agent may say opens with «Perfecto»; only the ✗ examples and the rule name it", () => {
    const lines = read(V5_PROMPT_PATH).split("\n");
    for (const line of lines) {
      if (!line.includes("«Perfecto")) continue;
      const allowed =
        line.startsWith("✗ ") ||
        line.includes("Nunca empieces un turno con «Perfecto»") ||
        line.includes("nunca empieza por «Perfecto»") ||
        line.includes("un «Perfecto, gracias» o un «vale» dichos antes de la pregunta final");
      expect(allowed, line).toBe(true);
    }
    expect(v5()).toContain(
      "✓ «Listo, ya tienes la cita: corte de pelo, el viernes dieciocho de septiembre a las doce. ¿Te puedo ayudar en algo más?»",
    );
    expect(v5()).toContain("El `message` de la cita creada empieza por «Listo, …».");
  });

  it("the tool document's confirmed example is the V5 sentence the middleware produces", () => {
    const text = JSON.stringify(tools(V5_SCHEMAS_PATH).find((t) => t.name === CREATE_TOOL));
    const sentence = balancedV5ConfirmedMessage(bookingConfirmedMessage("2026-09-15 11:00:00"));
    expect(sentence.startsWith("Listo, ")).toBe(true);
    expect(text).toContain(sentence);
    expect(text).not.toContain("Perfecto");
  });

  it("the lock always comes before the customer's data, and create never runs without it", () => {
    const text = v5();
    expect(text).toContain(
      "**El lock va SIEMPRE justo después de que elija hora, en ese mismo turno, antes de pedir ningún dato.**",
    );
    expect(text).toContain("nunca llamas a booking_create_booking_balanced_v2: sin el slot_token de ese lock la creación falla");
    expect(text).toContain("sin haber hecho lock; o, tras el «sí» del resumen, llamas a crear la cita sin slot_token.");
  });

  it("the day is the customer's: a different day at choice or in the summary is a new discover", () => {
    const text = v5();
    expect(text).toContain("**El día lo pone el cliente.**");
    expect(text).toContain("no hagas lock: haz discover del día que ha dicho, con preferred_time esa hora");
    expect(text).toContain("nunca repitas el mismo resumen: haz discover del día que dice");
  });

  it("a professional named after the offer is a discover with employee_id, never a blind lock", () => {
    const section = flat(sectionOf("# CAMBIO DE PROFESIONAL"));
    expect(section).toContain("Nunca hagas lock con preferred_employee_id de una hora que se ofreció sin ese profesional o para otro");
    expect(section).toContain("lock de la opción 1 sin preferred_employee_id");
    expect(section).toContain("✗ «¿Con Bruno?» y haces lock de la misma opción con preferred_employee_id de Bruno.");
    expect(section).toContain("no bloquees nada: repite el resumen con el `slot` de ese lock");
    expect(v5()).toContain("sigue CAMBIO DE PROFESIONAL: esas horas se ofrecieron sin mirar su agenda");
    // The exact forms are the sentences the middleware produces.
    const lines = sectionOf("# CAMBIO DE PROFESIONAL").split("\n");
    expect(lines).toContain(
      balancedPreferredTimeMessage("17:30", ["17:30"], { exact: true, employeeName: "Bruno" }),
    );
    expect(lines).toContain(
      balancedPreferredTimeMessage("17:30", ["16:30", "18:00"], { exact: false, employeeName: "Bruno" }),
    );
  });

  it("no cold «¿Sigues ahí?» at any moment, and an interrupted farewell is answered, not re-greeted", () => {
    const initiative = flat(sectionOf("# TOMA LA INICIATIVA"));
    expect(initiative).toContain("un turno vacío («...») o solo un ruido (una tos, un carraspeo), nunca digas «¿Sigues ahí?»");
    expect(initiative).toContain("«¿Te busco cita para corte de pelo, barba, o corte y barba?»");
    const closing = flat(sectionOf("# CIERRE DE LA LLAMADA"));
    expect(closing).toContain("Si el cliente habla mientras te despides, la llamada no se cuelga");
    expect(closing).toContain("«Tu cita ya está hecha.»");
  });
});

describe("balanced v5 · real calls 2026-09-19: Saturday is open", () => {
  const flow = (): string => flat(sectionOf("# FLUJO PARA UNA CITA NUEVA"));

  it("says explicitly that Saturday opens and only Sunday and Monday close", () => {
    const text = flow();
    expect(text).toContain("La peluquería cierra los domingos y los lunes.");
    expect(text).toContain("**Los sábados SÍ abrimos**");
    expect(text).toContain(
      "nunca digas que la peluquería cierra o está cerrada un día que no sea domingo o lunes",
    );
    expect(text).toContain("Si la agenda no tiene hueco ese día, di que no queda hueco");
    expect(text).toContain("nunca que está cerrado");
  });

  it("«hoy» and «mañana» are always looked up, never judged closed or too late by the agent", () => {
    const text = flow();
    expect(text).toContain("**«Hoy», «mañana» y «pasado mañana» se consultan siempre.**");
    expect(text).toContain("No decides tú si ese día abre ni si ya es tarde");
    expect(text).toContain("Solo te ahorras la herramienta cuando el cliente dice él mismo «domingo» o «lunes».");
    expect(text).toContain("✓ Dice «hoy» un sábado: frase de espera y discover de hoy; lees el `message`.");
  });

  it("never announces or argues which day today is, and never proposes a day itself", () => {
    const text = flow();
    expect(text).toContain("**No anuncies ni discutas qué día es hoy.**");
    expect(text).toContain("Nunca propongas tú un día, y menos un domingo o un lunes");
  });

  it("no line the agent may say puts Saturday among the closed days; only the ✗ example names it", () => {
    for (const line of read(V5_PROMPT_PATH).split("\n")) {
      if (!/s[áa]bados?/i.test(line) || !/cerr|cierra/i.test(line)) continue;
      const allowed =
        line.startsWith("✗ ") ||
        line.startsWith("**Los sábados SÍ abrimos**") ||
        line.startsWith("**«Hoy», «mañana» y «pasado mañana» se consultan siempre.**");
      expect(allowed, line).toBe(true);
    }
  });

  it("the V4 prompt is not touched by this fix", () => {
    expect(read(V4_PROMPT_PATH)).not.toContain("Los sábados SÍ abrimos");
  });
});
