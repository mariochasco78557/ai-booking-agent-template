import { dayPhraseEs, parseDateTime, timeLabel } from "../../utils/dateFormatterEs.js";

/**
 * Message texts for the owner's Telegram ((internal doc, not included in the template) §8.3). Pure functions,
 * plain text (no parse_mode). They contain the customer's full phone and name
 * ON PURPOSE (it is the owner's business); they must never reach a log.
 */

export const OWNER_MESSAGE_MAX_LENGTH = 3_500;

export type CancellationMotive = "mode" | "allowlist" | "too_late" | "technical" | "unknown";

const MOTIVE_TEXT: Record<CancellationMotive, string> = {
  mode: "el sistema aún no anula solo",
  allowlist: "este teléfono aún no está habilitado para anular solo",
  too_late: "fuera de plazo, falta muy poco para la cita",
  technical: "fallo técnico",
  unknown: "estado desconocido, compruébalo",
};

const REASON_TEXT: Record<string, string> = {
  wants_human: "el cliente quiere hablar con una persona",
  cannot_identify: "no se ha podido identificar al cliente",
  reservation_not_found: "no se encuentra su cita",
  cancel_request: "quiere anular una cita",
  change_request: "quiere cambiar una cita",
  complaint: "queja",
  other: "otro asunto",
};

export function motiveText(motive: CancellationMotive): string {
  return MOTIVE_TEXT[motive];
}

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}

/**
 * `+34600111222` / `34600111222` / `600111222` → `+34 600 111 222` (Telegram
 * makes it tappable). Anything else is returned trimmed, as is.
 */
export function formatPhoneForOwner(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[\s\-().]/g, "");
  const m = /^(?:\+|00)?34(\d{9})$/.exec(digits) ?? /^()(\d{9})$/.exec(digits);
  const national = m === null ? undefined : (m[2] ?? m[1]);
  if (national === undefined) return trimmed;
  return `+34 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** `"2026-10-07 10:30"` → `"martes 7 de octubre 10:30"`. Falls back to the raw string. */
export function whenText(startsAt: string): string {
  const parsed = parseDateTime(startsAt);
  if (parsed === null) return startsAt;
  return parsed.hasTime ? `${dayPhraseEs(parsed)} ${timeLabel(parsed)}` : dayPhraseEs(parsed);
}

function joinDots(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}

function fullName(name: string, surnames: string): string {
  const joined = `${name.trim()} ${surnames.trim()}`.trim();
  return joined === "" ? "sin nombre" : joined;
}

function truncate(text: string): string {
  return text.length > OWNER_MESSAGE_MAX_LENGTH ? text.slice(0, OWNER_MESSAGE_MAX_LENGTH) : text;
}

export interface CancellationMessageInput {
  kind: "cancellation_done" | "cancellation_request";
  startsAt: string;
  professional: string | null;
  service: string | null;
  ownerName: string;
  ownerSurnames: string;
  callerPhoneE164: string;
  motive?: CancellationMotive;
  dryRun?: boolean;
  /** 2026-10-10 plan B: done by phone with a DICTATED number (not the caller id). */
  via?: "dictated" | "dictated_change";
}

export function formatCancellationMessage(c: CancellationMessageInput): string {
  const client = `Cliente: ${fullName(c.ownerName, c.ownerSurnames)} · ${formatPhoneForOwner(c.callerPhoneE164)}`;
  const dictated =
    c.via === "dictated_change"
      ? "por llamada, al cambiarla (número dictado)"
      : c.via === "dictated"
        ? "por llamada (número dictado)"
        : undefined;
  if (c.kind === "cancellation_done") {
    return truncate(
      [
        dictated === undefined ? "ANULADA por WhatsApp" : `ANULADA ${dictated}`,
        joinDots([whenText(c.startsAt), c.professional, c.service]),
        client,
        "Ese hueco queda libre.",
      ].join("\n"),
    );
  }
  const motive = motiveText(c.motive ?? "mode");
  return truncate(
    [
      `${c.dryRun === true ? "[PRUEBA] " : ""}Quiere ANULAR (no anulada: ${motive})` +
        (dictated === undefined ? "" : ` · ${dictated}`),
      joinDots([whenText(c.startsAt), c.professional]),
      client,
      "Anúlala tú en el panel si procede.",
    ].join("\n"),
  );
}

export interface OwnerAlertMessageInput {
  conversationId?: string;
  reason: string;
  summary: string;
  callerPhoneE164?: string;
  callerFormat: string;
  customerName?: string;
  callbackPhone?: string;
}

export function formatOwnerAlertMessage(a: OwnerAlertMessageInput): string {
  const name = a.customerName !== undefined && a.customerName.trim() !== "" ? a.customerName.trim() : "sin nombre";
  const phone =
    a.callerPhoneE164 !== undefined && a.callerPhoneE164 !== ""
      ? formatPhoneForOwner(a.callerPhoneE164)
      : "sin número de WhatsApp visible";
  const lines = [
    `Aviso del WhatsApp: ${reasonText(a.reason)}`,
    a.summary,
    `Cliente: ${name} · ${phone}`,
  ];
  if (a.callbackPhone !== undefined && a.callbackPhone.trim() !== "") {
    lines.push(`Teléfono que da el cliente (no verificado): ${a.callbackPhone.trim()}`);
  }
  lines.push(`Conversación: ${a.conversationId ?? "—"}`);
  return truncate(lines.join("\n"));
}

export interface WaBookingMessageInput {
  startsAt: string;
  professional: string | null;
  customerName: string;
  phoneE164: string;
}

export function formatWaBookingMessage(b: WaBookingMessageInput): string {
  return truncate(
    [
      "Reserva nueva por WhatsApp",
      joinDots([whenText(b.startsAt), b.professional]),
      `Cliente: ${b.customerName.trim() === "" ? "sin nombre" : b.customerName.trim()} · ${formatPhoneForOwner(b.phoneE164)}`,
    ].join("\n"),
  );
}
