/**
 * 2026-10-11 («Perfecto! Me lo apunto, gracias.» no reservó) — the «sí» to a
 * summary is no longer left to the model alone.
 *
 * Pure functions (nothing here talks to the network):
 *  - `pendingConfirmation`: is a summary waiting for its «sí»?
 *  - `classifyConfirmation`: is the customer's answer a yes, a no/change, or unclear?
 *  - `reaskText`: the fixed sentence that is sent instead of silence.
 *  - `claimsBooking` / `isFarewell`: replies that must not go out while the
 *    customer does not know whether the appointment exists.
 *
 * Design: (internal doc, not included in the template), section 2.4.
 */
import type { ChatMessage } from "./llm.js";
import { dayLabelEs, lockedSlotOf, type LockedSlotInfo } from "./tools.js";

export interface PendingConfirmation {
  slotToken: string;
  date: string;
  time: string;
  professional?: string;
}

export type ConfirmationClass = "yes" | "no_or_change" | "unclear";

/** The question that closes a booking summary («¿Te la reservo?», «¿Confirmas…?», «¿Confirmas el cambio?»). */
const SUMMARY_QUESTION = /¿\s*(te\s+la\s+reservo|te\s+reservo|confirmas)/i;
/** «¿Confirmas que anulo tu cita…?» is a cancellation, not a booking summary. */
const CANCEL_QUESTION = /¿\s*confirmas\s+que\s+anulo/i;

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A summary is pending when the LAST assistant message with text asks the
 * summary question, there is a `locked` slot in the history before it, and no
 * confirmed booking of that slot_token came after the lock.
 */
export function pendingConfirmation(messages: readonly ChatMessage[]): PendingConfirmation | null {
  let lastText = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "") {
      lastText = i;
      break;
    }
  }
  if (lastText < 0) return null;
  const text = (messages[lastText] as { content: string }).content;
  if (!SUMMARY_QUESTION.test(text) || CANCEL_QUESTION.test(text)) return null;

  // The last lock, and the slot_tokens booked (confirmed) after it.
  const tokenByCallId = new Map<string, string>();
  let lock: { token: string; info: LockedSlotInfo } | undefined;
  let lockIndex = -1;
  let bookedAfterLock = false;
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) {
        const token = parseObject(c.function.arguments || "{}")?.slot_token;
        if (typeof token === "string") tokenByCallId.set(c.id, token);
      }
      return;
    }
    if (m.role !== "tool") return;
    const obj = parseObject(m.content);
    if (!obj) return;
    const locked = lockedSlotOf(obj);
    if (locked) {
      lock = locked;
      lockIndex = i;
      bookedAfterLock = false;
      return;
    }
    if (obj.outcome === "confirmed" && obj.booked === true && lock && i > lockIndex) {
      const token = tokenByCallId.get(m.tool_call_id);
      if (token === undefined || token === lock.token) bookedAfterLock = true;
    }
  });
  if (!lock || lockIndex < 0 || lockIndex > lastText || bookedAfterLock) return null;
  const found: { token: string; info: LockedSlotInfo } = lock;
  return {
    slotToken: found.token,
    date: found.info.date,
    time: found.info.time,
    ...(found.info.professional ? { professional: found.info.professional } : {}),
  };
}

// ── The customer's answer ────────────────────────────────────────────────────

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "")
    .replace(/[¡!.,;:"«»'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const YES_WORDS = [
  "si",
  "vale",
  "ok",
  "okey",
  "okay",
  "oki",
  "perfecto",
  "perfecta",
  "genial",
  "de acuerdo",
  "adelante",
  "confirmo",
  "confirmado",
  "confirmada",
  "reservala",
  "reservamela",
  "apuntala",
  "apuntamela",
  "me lo apunto",
  "me la apunto",
  "dale",
  "venga",
  "estupendo",
  "fenomenal",
  "correcto",
  "eso es",
  "claro",
  "por supuesto",
  "me viene bien",
  "me va bien",
];
const YES_EMOJIS = ["👍", "👌", "✅", "🙌"];
const YES_ONLY = new RegExp(
  `^(?:(?:${[...YES_WORDS.map((w) => w.replace(/ /g, "\\s+") + "(?![a-z])"), ...YES_EMOJIS].join("|")})\\s*)+$`,
  "u"
);

const CHANGE_PATTERNS: RegExp[] = [
  /\bno\b/,
  /\b(mejor|otro|otra|otros|otras|cambia|cambiar|cambio|espera|esperate|prefiero|pero|aunque)\b/,
  /\ben vez\b/,
  /\d{1,2}[:.]\d{2}/,
  /\ba las \w+/,
  /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/,
  /\b\d{1,2}\b/,
  /\?/,
];

export function classifyConfirmation(text: string): ConfirmationClass {
  // «no hay problema» is a yes in disguise; every other «no» is a no.
  const t = normalize(text).replace(/\bno hay (ningun )?problema\b/g, "vale");
  if (t === "") return "unclear";
  if (CHANGE_PATTERNS.some((re) => re.test(t))) return "no_or_change";
  const rest = t
    .replace(/\b(muchas |mil |muchisimas )?gracias\b/g, " ")
    .replace(/\bpor favor\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (rest !== "" && YES_ONLY.test(rest)) return "yes";
  return "unclear";
}

// ── Fixed texts and output guards ───────────────────────────────────────────

export function reaskText(p: PendingConfirmation): string {
  const day = dayLabelEs(p.date);
  const label = day.startsWith("el ") ? `del ${day.slice(3)}` : `de ${day}`;
  return `Aún no está reservada. ¿Te reservo la cita ${label} a las ${p.time}? Responde «sí» y queda hecha.`;
}

export const NOTE_CONFIRMED =
  "[Nota del sistema: el cliente acaba de confirmar el resumen. Haz ya la RESERVA con el slot_token del último lock. No vuelvas a preguntar.]";
export const NOTE_UNCLEAR =
  "[Nota del sistema: no está claro si confirma el resumen. No reserves. Escribe solo: «Aún no está reservada. ¿Te la reservo? Responde «sí» y queda hecha.»]";
export const NOTE_RETRY_BOOK = "[Nota del sistema: el cliente ya ha dicho que sí; llama ahora a la RESERVA.]";

export function confirmationNote(klass: ConfirmationClass): string | null {
  if (klass === "yes") return NOTE_CONFIRMED;
  if (klass === "unclear") return NOTE_UNCLEAR;
  return null;
}

const BOOKING_CLAIM = /(listo\s*✅|queda\s+reservada|cita\s+confirmada|est[aá]\s+reservada|queda\s+confirmada|queda\s+apuntada)/i;
const NEGATED_CLAIM = /\b(a[uú]n\s+no|todav[ií]a\s+no|no\s+(est[aá]|ha\s+quedado|queda)|no\s+(te\s+la\s+|te\s+|la\s+)?reservo)\b/i;

/** Said after a flat «no» to the summary when the model's goodbye does not say it is not booked. */
export const NOT_BOOKED_LINE = "Vale, no la reservo.";
/** Said when the customer changes or declines the summary and the model wrote nothing. */
export const CHANGE_ASK = "¿Qué quieres cambiar: el día, la hora o el profesional?";

const REJECTION = /^(?:ya no|no(?: la| lo)?(?: quiero| hace falta| importa)?|mejor no|dejalo|dejala|olvidalo|olvidala)$/;

/** The customer plainly declines the summary («no, gracias», «no», «déjalo», «mejor no»). */
export function isRejection(text: string): boolean {
  const t = normalize(text)
    .replace(/\b(muchas |mil )?gracias\b/g, " ")
    .replace(/\bpor favor\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return REJECTION.test(t);
}

/** The reply says the appointment is NOT booked («Aún no está reservada», «no queda reservada»). */
export function statesNotBooked(reply: string): boolean {
  return NEGATED_CLAIM.test(reply);
}

/** The reply says the appointment is booked. «Aún no está reservada» is not a claim. */
export function claimsBooking(reply: string): boolean {
  return BOOKING_CLAIM.test(reply) && !statesNotBooked(reply);
}

const FAREWELL = /(nos\s+vemos|hasta\s+pronto|un\s+saludo|que\s+vaya\s+bien|hasta\s+luego|buen\s+d[ií]a|que\s+tengas)/i;

export function isFarewell(reply: string): boolean {
  return FAREWELL.test(reply);
}

/** True when the reply mentions the time (`09:30`, also written `9:30`). */
export function mentionsTime(reply: string, time: string): boolean {
  return reply.includes(time) || reply.includes(time.replace(/^0/, ""));
}
