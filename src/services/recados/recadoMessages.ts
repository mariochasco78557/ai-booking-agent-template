import { madridDate, madridWallClock } from "../../utils/madridDate.js";
import type { InlineButton } from "../ownerNotify/telegramClient.js";
import { formatPhoneForOwner, OWNER_MESSAGE_MAX_LENGTH, whenText } from "../ownerNotify/ownerMessages.js";
import type { Recado, RecadoKind } from "./recadoTypes.js";
import { t } from "../../core/texts/texts.js";

/**
 * Texts of the «recados» feature (messages for the owner, `{responsable}`; ((internal doc, not included in the template)
 * §A.4). Wording with business data comes from `src/core/texts` (D-010). Pure functions, plain text (no parse_mode). The customer-facing
 * phrases NEVER mention the salon's opening hours. The Telegram texts hold a
 * name, a phone and a summary ON PURPOSE (it is the owner's business); they
 * must never reach a log.
 */

// ── To the customer (`message`) ─────────────────────────────────────────────
export const MSG_RECADO = t("recados.cliente.recado");
export const MSG_RECADO_LATE = t("recados.cliente.recado_tarde");
export const MSG_PHONE_NEEDED = t("recados.cliente.pide_telefono");
export const MSG_NAME_AND_PHONE_NEEDED = t("recados.cliente.pide_nombre_y_telefono");
export const MSG_DICTATED_INVALID = "Ese número no me sale bien. ¿Me lo dices otra vez, cifra a cifra?";
export const MSG_INVALID_RECADO = "No he podido leer la petición.";

// Respaldo de VOZ (off, dry_run, fallo, tope global): las frases de WhatsApp de V6
export const FALLBACK_VOICE_WANTS_HUMAN = t("recados.voz.quiere_humano");
export const FALLBACK_VOICE_OTHER = t("recados.voz.otro");
export const FALLBACK_VOICE_LATE = t("recados.voz.retraso");
// Respaldo de WHATSAPP (el cerebro no lo lee; usa el suyo, §B)
export const FALLBACK_WA = t("recados.wa.fallo");

export function customerPhrase(kind: RecadoKind): string {
  return kind === "late" ? MSG_RECADO_LATE : MSG_RECADO;
}

export function voiceFallback(kind: RecadoKind): string {
  if (kind === "wants_human") return FALLBACK_VOICE_WANTS_HUMAN;
  if (kind === "late") return FALLBACK_VOICE_LATE;
  return FALLBACK_VOICE_OTHER;
}

// ── To the owner (Telegram) ──────────────────────────────────────────────────────
export const KIND_HEAD: Record<RecadoKind, string> = {
  late: "🕐 RETRASO",
  wants_human: "📞 QUIERE HABLAR CONTIGO",
  complaint: "⚠️ QUEJA",
  question: "❓ CONSULTA",
};

function truncate(text: string): string {
  return text.length > OWNER_MESSAGE_MAX_LENGTH ? text.slice(0, OWNER_MESSAGE_MAX_LENGTH) : text;
}

function phoneText(r: Recado): string {
  if (r.phoneE164 === null || r.phoneSource === "none") return "sin teléfono";
  const base = formatPhoneForOwner(r.phoneE164);
  if (r.phoneSource === "dictated") return `${base} (dictado)`;
  if (r.phoneSource === "written") return `${base} (lo escribe el cliente)`;
  return base;
}

function appointmentLine(r: Recado, nowMs: number): string {
  const a = r.appointment;
  if (a.status === "found") {
    const cuando = a.startsAt.slice(0, 10) === madridDate(nowMs) ? `hoy ${a.startsAt.slice(11, 16)}` : whenText(a.startsAt);
    const base = `Próxima cita: ${cuando} · ${a.professional ?? "sin profesional"} · ${a.service ?? "servicio sin indicar"}`;
    return r.customerName === null ? `${base} (a nombre de ${a.bookedName})` : base;
  }
  if (a.status === "none") return "Próxima cita: ninguna";
  if (a.status === "not_searched") return "Próxima cita: no consultada (número no español)";
  return "Próxima cita: no se ha podido consultar"; // error, or still pending when it is time to send
}

export function formatRecadoMessage(r: Recado, nowMs: number): string {
  const created = madridWallClock(r.createdAt);
  const entrada =
    created.slice(0, 10) === madridDate(nowMs) ? `entró a las ${created.slice(11, 16)}` : `entró el ${whenText(created)}`;
  const lines = [
    `${KIND_HEAD[r.kind]} · ${r.channel === "voice" ? "por llamada" : "por WhatsApp"} · ${entrada}`,
    `«${r.summary}»`,
  ];
  if (r.minutesLate !== null) lines.push(`Retraso: unos ${r.minutesLate} min`);
  lines.push(`Cliente: ${r.customerName ?? "sin nombre"} · ${phoneText(r)}`);
  lines.push(appointmentLine(r, nowMs));
  // The operator CLI's test notice (`recadosTelegram prueba`) says so on its first line.
  if (r.dedupeKey.startsWith("prueba:")) lines.unshift("[PRUEBA]");
  return truncate(lines.join("\n"));
}

export function headerText(n: number): string {
  return n === 1 ? "📋 1 recado de cuando estaba cerrado" : `📋 ${n} recados de cuando estaba cerrado`;
}

function hhmm(atMs: number): string {
  return madridWallClock(atMs).slice(11, 16);
}

export function handledLine(atMs: number): string {
  return `✅ Atendido a las ${hhmm(atMs)}`;
}

export function handledText(original: string, atMs: number): string {
  return truncate(`${handledLine(atMs)}\n${original}`);
}

export const REMINDER_TEXT = "⏰ Este recado sigue sin marcar.";

const SUMMARY_MAX_LINES = 20;

export function summaryText(pending: Recado[], nowMs: number): string {
  const n = pending.length;
  const head = n === 1 ? "🌙 Cierre de hoy: 1 recado sin marcar" : `🌙 Cierre de hoy: ${n} recados sin marcar`;
  const today = madridDate(nowMs);
  const sorted = [...pending].sort((a, b) => a.createdAt - b.createdAt);
  const lines = sorted.slice(0, SUMMARY_MAX_LINES).map((r) => {
    const wall = madridWallClock(r.createdAt);
    const when = wall.slice(0, 10) === today ? wall.slice(11, 16) : `${wall.slice(8, 10)}/${wall.slice(5, 7)} ${wall.slice(11, 16)}`;
    const tel = r.phoneE164 === null ? "sin teléfono" : formatPhoneForOwner(r.phoneE164);
    return `• ${KIND_HEAD[r.kind]} · ${r.customerName ?? "sin nombre"} · ${tel} · ${when}`;
  });
  if (n > SUMMARY_MAX_LINES) lines.push(`… y ${n - SUMMARY_MAX_LINES} más`);
  return truncate([head, ...lines].join("\n"));
}

export const BUTTON_DONE = "✅ Ya le he llamado";
export const BUTTON_OPEN = "Abrir conversación";
export const START_REPLY = (chatId: string): string => t("recados.telegram.inicio", { chat_id: chatId });
export const CB_ANSWER_DONE = "Marcado como atendido.";
export const CB_ANSWER_ALREADY = "Ya estaba marcado.";
export const CB_ANSWER_GONE = "Este recado ya no está.";

/**
 * sin {conversationId} → la plantilla tal cual; con él y con id → sustituido
 * (encodeURIComponent); con él y sin id → origen de la plantilla.
 */
export function voceroUrl(template: string, voceroConversationId: string | null): string {
  if (!template.includes("{conversationId}")) return template;
  if (voceroConversationId === null) {
    try {
      return new URL(template.replace("{conversationId}", "x")).origin;
    } catch {
      return template.split("{conversationId}")[0] ?? template;
    }
  }
  return template.replace("{conversationId}", encodeURIComponent(voceroConversationId));
}

export const CALLBACK_PREFIX = "rh:";

/** Voz: `[[✅]]`. WhatsApp: `[[✅],[Abrir conversación]]`. Atendido: voz vacío; WhatsApp solo «Abrir». */
export function recadoKeyboard(r: Recado, voceroUrlTemplate: string, handled: boolean): InlineButton[][] {
  const rows: InlineButton[][] = [];
  if (!handled) rows.push([{ text: BUTTON_DONE, callbackData: `${CALLBACK_PREFIX}${r.id}` }]);
  if (r.channel === "whatsapp") {
    rows.push([{ text: BUTTON_OPEN, url: voceroUrl(voceroUrlTemplate, r.voceroConversationId) }]);
  }
  return rows;
}
