/**
 * The system prompt, in two parts:
 *
 *  1. STATIC — the WhatsApp V1 prompt (`docs/elevenlabs/AGENT_PROMPT_WHATSAPP_V1_ES.md`,
 *     copied into `prompts/`) plus Bruno's rules. Identical for every message,
 *     so the model provider can cache it.
 *  2. DYNAMIC — this chat's number, the date and time in Madrid and the
 *     knowledge base edited in Vocero. Small, and rebuilt on every turn.
 *
 * The ElevenLabs placeholders `{{system__caller_id}}` and `{{system__time}}`
 * are pointed at the dynamic part instead of being filled in, which is what
 * keeps part 1 byte-for-byte stable.
 */
import { readFileSync } from "node:fs";
import { displayWaId } from "./phone.js";
import { DEFAULT_OPENING_HOURS, parseOpeningHours, type OpeningHours } from "./hours.js";

const PASTE_END_MARKER = "<!-- No pegar en ElevenLabs";

function readPrompt(file: string): string {
  return readFileSync(new URL(`../prompts/${file}`, import.meta.url), "utf8");
}

/** The pasteable part of the V1 prompt: everything above its "do not paste" marker. */
export function pasteablePart(markdown: string): string {
  const idx = markdown.indexOf(PASTE_END_MARKER);
  let text = idx >= 0 ? markdown.slice(0, idx) : markdown;
  text = text.replace(/\n-{3,}\s*$/, "");
  return text.trim();
}

export function buildStaticPrompt(
  v1Markdown?: string,
  rulesMarkdown?: string,
  // 2026-10-11: no longer written into the prompt (the agent never states hours);
  // kept so callers need no change. BRAIN_OPENING_HOURS only drives the local closed-day shortcut.
  _openingHours: OpeningHours = parseOpeningHours(DEFAULT_OPENING_HOURS)
): string {
  const v1 = pasteablePart(v1Markdown ?? readPrompt("AGENT_PROMPT_WHATSAPP_V1_ES.md"))
    .replaceAll("{{system__caller_id}}", "el que figura en DATOS DE ESTA CONVERSACIÓN, al final")
    .replaceAll("{{system__time}}", "la fecha y hora de DATOS DE ESTA CONVERSACIÓN, al final");
  const rules = (rulesMarkdown ?? readPrompt("BOOKING_RULES_ES.md")).trim();
  const schedule = [
    "# HORARIO",
    "Abrimos de martes a sábado; domingos y lunes, cerrado. **Nunca digas a qué hora abre o cierra la peluquería ni que un día u hora está cerrado**: eso solo lo dice el `message` de DISPONIBILIDAD y lo copias tal cual. Si no hay hueco, es «no me queda hueco», nunca «cerramos». Si preguntan el horario: «Abrimos de martes a sábado. Dime qué día y hora te vendría bien y te miro el hueco ahora.»",
  ].join("\n");
  return `${v1}\n\n${rules}\n\n${schedule}`;
}

export function madridNow(now: Date): { label: string; isoDate: string } {
  const label = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { label, isoDate: parts };
}

export function buildDynamicPrompt(input: {
  waId: string;
  profileName?: string | null;
  now: Date;
  knowledge: string;
}): string {
  const { label, isoDate } = madridNow(input.now);
  const lines = [
    "# DATOS DE ESTA CONVERSACIÓN",
    `Número de este chat: ${displayWaId(input.waId)}`,
    `Ahora: ${label} (hora de Madrid). Hoy es ${isoDate}.`,
  ];
  if (input.profileName) {
    lines.push(
      `Nombre en su perfil de WhatsApp: «${input.profileName}». Es solo un alias: para la cita pide siempre nombre y apellidos.`
    );
  }
  const kb = input.knowledge.trim();
  lines.push("", "# CONOCIMIENTO DEL SALÓN", kb || "(sin datos)");
  return lines.join("\n");
}
