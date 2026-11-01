import { createHash } from "node:crypto";

/**
 * Recados para Bruno ((internal doc, not included in the template) §A.2). Types only, plus
 * the two hash helpers every module needs to agree on.
 */

export type RecadoKind = "late" | "wants_human" | "complaint" | "question";
export type RecadoChannel = "voice" | "whatsapp";
/** caller = caller id de la llamada; whatsapp = wa_id; dictated = dictado por voz; written = escrito en WhatsApp (número extranjero). */
export type PhoneSource = "caller" | "whatsapp" | "dictated" | "written" | "none";
export type RecadoDelivery = "held" | "pending" | "sent" | "sent_dry_run" | "failed";
export type RecadoAppointment =
  | { status: "pending" }
  | { status: "none" }
  | { status: "error" }
  | { status: "not_searched" } // sin teléfono español
  | { status: "found"; startsAt: string; professional: string | null; service: string | null; bookedName: string };

export interface Recado {
  readonly id: string; // sha256(dedupeKey) hex, 12 primeros
  readonly dedupeKey: string; // "voz:<conversation_id>" | "wa:<conversation_id>"
  readonly kind: RecadoKind;
  readonly channel: RecadoChannel;
  readonly createdAt: number;
  readonly summary: string; // PII posible: nunca a logs
  readonly minutesLate: number | null;
  readonly customerName: string | null; // PII
  readonly phoneE164: string | null; // PII
  readonly phoneSource: PhoneSource;
  readonly phoneHash: string | null; // sha256(phoneE164) hex 16, para el tope por teléfono
  readonly voceroConversationId: string | null;
  readonly appointment: RecadoAppointment;
  readonly heldAtCreation: boolean;
  readonly delivery: RecadoDelivery;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null; // corto, sin token
  readonly messageId: number | null;
  readonly sentAt: number | null;
  readonly handledAt: number | null;
  readonly reminderMessageId: number | null;
  readonly remindedAt: number | null;
  readonly reminderAttempts: number;
}

export interface RecadoResponse {
  outcome:
    | "recado_queued"
    | "recado_duplicate"
    | "recado_limit"
    | "recado_dry_run"
    | "recado_unavailable"
    | "phone_needed"
    | "dictated_invalid"
    | "invalid_request";
  message: string;
  external_mutation: false;
  duplicate?: true;
  dry_run?: true;
}

/** First 12 hex of sha256(dedupeKey): the recado id and the Telegram `callback_data` payload. */
export function recadoIdOf(dedupeKey: string): string {
  return createHash("sha256").update(dedupeKey).digest("hex").slice(0, 12);
}

/** First 16 hex of sha256(phone): the per-phone cap, never the number itself. */
export function phoneHashOf(phoneE164: string): string {
  return createHash("sha256").update(phoneE164).digest("hex").slice(0, 16);
}
