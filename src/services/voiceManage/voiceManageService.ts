import { createHash } from "node:crypto";

import { shortConversationId } from "../../plugins/observability.js";
import { spokenAppointmentEs } from "../../utils/balancedPhrasing.js";
import { serviceLabel, t } from "../../core/texts/texts.js";
import { normalizeSpanishPhone } from "../../utils/phone.js";
import type { DashboardReservation } from "../waSelfService/dashboardMapping.js";

/**
 * *** 2026-10-10 — THE VOICE AGENT CONSULTS, CANCELS AND CHANGES EXISTING
 * BOOKINGS, ONLY THOSE OF THE NUMBER THAT IS CALLING. ***
 * (internal doc, not included in the template)
 *
 * Two new actions on the EXISTING availability tool (`/ai/voice/v2/availability`):
 *
 * - `my_bookings` — reads the agenda for the caller id of the call
 *   (`caller_phone`, bound by ElevenLabs to `system__caller_id`; the LLM never
 *   fills it) and keeps, PER CONVERSATION, the (at most two) next future
 *   bookings it read out, numbered 1 and 2 (`booking_index`).
 * - `cancel` — cancels booking `booking_index` OF THAT LISTING, only with
 *   `confirmed_by_customer: true`, only if the call's caller id is still the
 *   one the listing was read for, through the WhatsApp self-service cancel
 *   path (`WaSelfService.cancelForVoice`: re-read, ownership, mode gate,
 *   delete, verification, owner's notice). An index the server did not hand
 *   out in this call cancels nothing.
 *
 * A CHANGE is the create tool with `replaces_existing_booking` = that index:
 * `VoiceBookingService` creates the new booking first and only then cancels
 * the old one ({@link VoiceManageService.resolveForChange}).
 *
 * Security is entirely server-side: a hidden or foreign caller id gets the
 * WhatsApp sentence, and every answer is HTTP 200 with an `outcome`.
 * Logs carry the short conversation id, counts, outcomes and a hash of the
 * reservation id — never a phone, a name or an id.
 *
 * *** 2026-10-10 (tarde) — THE SERVER WRITES WHAT IS CONFIRMED, AND PLAN B.
 * (internal doc, not included in the template) ***
 *
 * - A `cancel` only cancels after a `confirm_required` the SERVER issued for
 *   that same `booking_index` in this call, whose question («¿Te anulo la cita
 *   del jueves quince de octubre a las once de la mañana?») carries the
 *   agenda's day and hour, and only when the «sí» arrives at least
 *   {@link VOICE_MANAGE_CONFIRM_MIN_GAP_MS} later (a call fired in the same
 *   turn as the question is refused: real calls conv_…1rg and conv_…pk7).
 *   `my_bookings` with `intent: "anular"` and ONE booking asks that question
 *   itself, so it counts as the `confirm_required`.
 * - A CHANGE: the lock sent with `booking_index` gets a summary that starts
 *   «Te cambio tu cita del …» ({@link VoiceManageService.offerChange}), and
 *   the create only changes after that summary, or after its own
 *   `change_confirm_required` ({@link VoiceManageService.gateChange}).
 * - `VOICE_MANAGE_DICTATED_PHONE_ENABLED`: a phone the customer DICTATES
 *   (`dictated_phone`) is used only together with the first name
 *   (`customer_name`) of the booking in the agenda, at most
 *   {@link DICTATED_MAX_PER_CALL} attempts per call and
 *   {@link DICTATED_MAX_PER_NUMBER} per number and day; a miss never says
 *   whether the number has bookings. Off: dictated phones are ignored, as before.
 */

export const VOICE_MANAGE_ACTIONS = ["my_bookings", "cancel", "change_service"] as const;
export type VoiceManageAction = (typeof VOICE_MANAGE_ACTIONS)[number];
export const BOOKING_INDEX_FIELD = "booking_index";
export const INTENT_FIELD = "intent";
export const VOICE_MANAGE_INTENTS = ["consultar", "anular", "cambiar"] as const;
export type VoiceManageIntent = (typeof VOICE_MANAGE_INTENTS)[number];
/** On the create tool: change booking N of this call's listing. */
export const REPLACES_EXISTING_BOOKING_FIELD = "replaces_existing_booking";
/** 2026-10-10 plan B: the phone the customer dictates, and their first name. */
export const DICTATED_PHONE_FIELD = "dictated_phone";
export const CUSTOMER_NAME_FIELD = "customer_name";

/**
 * A «sí» that arrives sooner than this after the server's question was not an
 * answer to it: the agent fired the tool in the same turn as the question
 * (conv_1001m4kaz3gae5mve2xwsh6yj1rg). Reading the question alone takes longer.
 */
export const VOICE_MANAGE_CONFIRM_MIN_GAP_MS = 3_000;
/** A question older than this is asked again. */
export const VOICE_MANAGE_CONFIRM_TTL_MS = 5 * 60_000;
/** Plan B rate limits: per call, per dictated number (24 h), all numbers (1 h). */
export const DICTATED_MAX_PER_CALL = 2;
export const DICTATED_MAX_PER_NUMBER = 4;
export const DICTATED_NUMBER_WINDOW_MS = 24 * 3_600_000;
export const DICTATED_MAX_GLOBAL = 30;
export const DICTATED_GLOBAL_WINDOW_MS = 3_600_000;

/** Product rule (owner, 2026-10-10): by phone, at most the two next ones. */
export const VOICE_MANAGE_MAX_LISTED = 2;
/** How long a listing stays usable inside one call. */
export const VOICE_MANAGE_LIST_TTL_MS = 30 * 60_000;
const VOICE_MANAGE_MAX_CONVERSATIONS = 2_000;

/** The sentence the prompt already uses for existing bookings (CITAS QUE YA EXISTEN). */
export const MSG_MANAGE_BY_WHATSAPP = t("voz.gestion.por_whatsapp");
export const MSG_NO_BOOKINGS = t("voz.gestion.sin_citas");
export const MSG_AGENDA_UNAVAILABLE = t("voz.gestion.agenda_no_disponible");
export const MSG_NOT_CONFIRMED_CANCEL =
  "Antes de anularla necesito que me confirmes que quieres anular esa cita.";
export const MSG_NOT_LISTED = "Déjame mirar otra vez tus citas.";
export const MSG_BOOKING_GONE = "Esa cita ya no está en la agenda con este número.";
export const MSG_INVALID_MANAGE = "No he podido leer la petición.";
/** Plan B (dictated phone) — never say whether a number has bookings. */
export const MSG_PHONE_NEEDED =
  "No me sale tu número en esta llamada. ¿Me dices el teléfono con el que pediste la cita y tu nombre?";
export const MSG_NO_BOOKINGS_ASK_OTHER =
  "Con este número no veo ninguna cita pendiente. Si la pediste con otro número, dime ese número y tu nombre.";
export const MSG_DICTATED_NOT_FOUND_RETRY =
  "No encuentro ninguna cita con esos datos. ¿Me repites el teléfono y el nombre con los que la pediste?";
export const MSG_DICTATED_NOT_FOUND_FINAL = t("voz.gestion.dictado_no_encontrado_final");
export const MSG_DICTATED_LIMIT = t("voz.gestion.dictado_limite");

function whenOf(at: string): string {
  return spokenAppointmentEs(at).replace(/^el /, "");
}

/** The server's question before a cancel: day and hour from the agenda. */
export function msgConfirmCancel(at: string): string {
  return `¿Te anulo la cita del ${whenOf(at)}?`;
}

/** The start of a change's summary (the lock with `booking_index`). */
export function msgChangeSummaryLead(at: string): string {
  return `Te cambio tu cita del ${whenOf(at)} por esta: `;
}

export function msgCancelledVoice(at: string): string {
  return `Hecho: tu cita del ${spokenAppointmentEs(at).replace(/^el /, "")} queda anulada.`;
}
export function msgNotCancelledVoice(at: string): string {
  return t("voz.gestion.no_anulada", { cita: spokenAppointmentEs(at).replace(/^el /, "") });
}
export function msgCancelUncertainVoice(at: string): string {
  return t("voz.gestion.anulacion_incierta", { cita: spokenAppointmentEs(at).replace(/^el /, "") });
}

function withWho(row: { startsAt: string; employeeName: string | null }): string {
  return `${spokenAppointmentEs(row.startsAt)}${row.employeeName ? ` con ${row.employeeName}` : ""}`;
}

/** The listing, said in one or two sentences, ending on the intent's question. */
export function msgBookingsFound(
  rows: ReadonlyArray<{ startsAt: string; employeeName: string | null }>,
  total: number,
  intent: VoiceManageIntent | undefined,
): string {
  if (rows.length === 1) {
    // 2026-10-10 (conv_0401m4kadr9zesythx1ga95zxpk7): the agent said only
    // «¿Te la anulo?». The question now CARRIES the day and the hour, so it
    // cannot be read without them; it is the server's confirm_required.
    if (intent === "anular") return `¿Te anulo tu cita ${withWho(rows[0]!).replace(/^el /, "del ")}?`;
    const question = intent === "cambiar" ? " ¿A qué día te la cambio?" : "";
    return `Tienes cita ${withWho(rows[0]!)}.${question}`;
  }
  const head = total > rows.length ? "Tus dos próximas citas son" : "Tienes dos citas";
  const question =
    intent === "anular" ? " ¿Cuál quieres anular?" : intent === "cambiar" ? " ¿Cuál quieres cambiar?" : "";
  return `${head}: ${withWho(rows[0]!)}, y ${withWho(rows[1]!)}.${question}`;
}

export type VoiceManageOutcome =
  | "bookings_found"
  | "no_bookings"
  | "caller_unknown"
  | "manage_unavailable"
  | "agenda_unavailable"
  | "invalid_request"
  | "cancelled"
  | "not_confirmed"
  | "booking_not_listed"
  | "booking_gone"
  | "not_cancelled"
  | "cancel_uncertain"
  /** 2026-10-10: the server's question before a cancel; nothing touched. */
  | "confirm_required"
  /** Plan B: hidden caller id, ask for the phone and the name. */
  | "phone_needed"
  /** Plan B: no booking with that phone AND that first name (or unreadable). */
  | "dictated_not_found"
  /** Plan B: too many attempts (this call, this number or overall). */
  | "dictated_limit"
  /** 2026-10-11 «cambiar servicio» ((internal doc, not included in the template) §4). */
  | "service_changed"
  | "same_service"
  | "service_not_changed"
  | "service_change_too_late"
  | "service_change_unavailable"
  | "service_change_lost"
  | "uncertain";

export interface VoiceManageBooking {
  booking_index: number;
  date: string;
  time: string;
  /** «el sábado diez de octubre a las nueve y media de la mañana». */
  spoken: string;
  professional: string | null;
  employee_id: number | null;
  /** 0, 1 or 2 when the salon's row says which service; else null. */
  service_id: number | null;
}

export interface VoiceManageResponse {
  outcome: VoiceManageOutcome;
  message: string;
  external_mutation: boolean | null;
  mutation_status: "confirmed" | "none" | "unknown";
  bookings?: VoiceManageBooking[];
  total_bookings?: number;
  booking_index?: number;
  idempotency_status?: "original" | "replayed";
}

/** What this service needs from `WaSelfService`. Structural, so tests can fake it. */
export interface VoiceManageSelfService {
  listForVoice(
    phoneE164: string,
    nowMs: number,
  ): Promise<
    | { ok: true; rows: DashboardReservation[] }
    | { ok: false; reason: "off" | "rate_limited" | "upstream_error" }
  >;
  cancelForVoice(
    req: { phoneE164: string; reservationId: number; startsAt: string; via?: "dictated" },
    nowMs: number,
  ): Promise<{ outcome: string; [key: string]: unknown }>;
  /** 2026-10-11 — absent on older fakes: the action then answers `service_change_unavailable`. */
  changeServiceForVoice?(
    req: {
      phoneE164: string;
      reservationId: number;
      startsAt: string;
      newType: 0 | 1 | 2;
      via?: "dictated";
      conversationId?: string;
    },
    nowMs: number,
  ): Promise<{ outcome: string; [key: string]: unknown }>;
}

type ListedStatus = "listed" | "cancelled" | "changing" | "changed";

interface ListedBooking {
  index: number;
  reservationId: number;
  startsAt: string;
  employeeId: number | null;
  employeeName: string | null;
  /** The service as the agenda says (0, 1, 2) or null. */
  serviceId: number | null;
  status: ListedStatus;
  cancelAnswer?: VoiceManageResponse;
  /** 2026-10-11: the answer of a service change that wrote (replayed on a repeat). */
  serviceAnswer?: { serviceId: number; answer: VoiceManageResponse };
}

interface ListEntry {
  phoneE164: string;
  storedAtMs: number;
  bookings: ListedBooking[];
  /** How the number was obtained: the call's caller id, or dictated (plan B). */
  source: "caller" | "dictated";
  /** The call's caller id when the list was read (undefined = hidden). */
  callerAtList: string | undefined;
  /** The last cancel question the server asked in this call. */
  pendingConfirm?: { index: number; askedAtMs: number };
  /** The last «cambiar servicio» question the server asked in this call. */
  pendingServiceConfirm?: { index: number; serviceId: number; askedAtMs: number };
  /** The last change summary the server wrote in this call. */
  changeOffer?: { index: number; tokenHash: string; askedAtMs: number };
}

/** The caller id of a voice call as an E.164 Spanish number, or undefined. */
export function resolveManageCaller(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const normalized = normalizeSpanishPhone(raw.trim().slice(0, 40));
  return normalized.ok ? normalized.e164 : undefined;
}

function field(body: unknown, key: string): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

/** 1..VOICE_MANAGE_MAX_LISTED, number or numeric string; else undefined. */
export function readBookingIndex(raw: unknown): number | undefined {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  return Number.isInteger(value) && value >= 1 && value <= VOICE_MANAGE_MAX_LISTED ? value : undefined;
}

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function readConversationId(raw: unknown): string | undefined {
  return typeof raw === "string" && CONVERSATION_ID_RE.test(raw.trim()) ? raw.trim() : undefined;
}

/**
 * The first given name, for plan B: no accents, lowercase, letters only.
 * «José Luis» -> «jose»; «  MARÍA » -> «maria». Under two letters: undefined.
 */
export function firstNameKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const first = raw
    .slice(0, 80)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")[0];
  return first !== undefined && first.length >= 2 ? first : undefined;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token.slice(0, 400)).digest("hex").slice(0, 16);
}

function ridHash(rid: number): string {
  return createHash("sha256").update(String(rid)).digest("hex").slice(0, 8);
}

function none(outcome: VoiceManageOutcome, message: string): VoiceManageResponse {
  return { outcome, message, external_mutation: false, mutation_status: "none" };
}

export type ChangeResolution =
  | {
      ok: true;
      reservationId: number;
      startsAt: string;
      employeeId: number | null;
      phoneE164: string;
      /** Plan B: the listing came from a dictated phone. */
      dictated?: boolean;
    }
  | { ok: false; reason: "not_listed" | "already_changed"; startsAt?: string };

// ------------------------------------------------ cambiar servicio (2026-10-11)
// (internal doc, not included in the template) §4, «Voz» column. Hours in words.

/** How the agent says a service: `servicios[].etiquetas.voz` or the name in lower case (D-010). */
function serviceWord(id: number | null): string | undefined {
  return serviceLabel(id, "voz");
}

function withProfessionalVoice(b: { startsAt: string; employeeName: string | null }): string {
  return `${whenOf(b.startsAt)}${b.employeeName ? ` con ${b.employeeName}` : ""}`;
}

export function msgServiceConfirmVoice(
  b: { startsAt: string; employeeName: string | null },
  fromId: number | null,
  toId: number,
): string {
  const from = serviceWord(fromId);
  return `¿Te dejo la cita del ${withProfessionalVoice(b)} como ${serviceWord(toId)}${from ? `, en vez de ${from}` : ""}?`;
}
export function msgServiceChangedVoice(b: { startsAt: string; employeeName: string | null }, toId: number): string {
  return `Hecho: tu cita del ${withProfessionalVoice(b)} queda como ${serviceWord(toId)}.`;
}
export function msgSameServiceVoice(toId: number): string {
  return `Tu cita ya es de ${serviceWord(toId)}.`;
}
export const MSG_SERVICE_NOT_CHANGED_VOICE = "No he podido cambiarlo; tu cita sigue como estaba.";
export const MSG_SERVICE_TOO_LATE_VOICE = t("voz.servicio.demasiado_tarde");
export const MSG_SERVICE_UNAVAILABLE_VOICE = t("voz.servicio.no_disponible");
export const MSG_SERVICE_LOST_VOICE = t("voz.servicio.perdido");

export interface VoiceManageLogger {
  info: (detail: Record<string, unknown>, message: string) => void;
  warn: (detail: Record<string, unknown>, message: string) => void;
}

export class VoiceManageService {
  private readonly lists = new Map<string, ListEntry>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Plan B: dictated attempts per conversation. */
  private readonly dictatedAttempts = new Map<string, number>();
  /** Plan B: lookups per dictated number (key = hash), and overall. */
  private readonly dictatedPerNumber = new Map<string, number[]>();
  private dictatedGlobal: number[] = [];

  constructor(
    private readonly config: { enabled: boolean; dictatedEnabled?: boolean; changeServiceEnabled?: boolean },
    private readonly selfService: VoiceManageSelfService | undefined,
    private readonly logger: VoiceManageLogger,
  ) {}

  /** Armed: the flag, and an agenda reader behind it. */
  get enabled(): boolean {
    return this.config.enabled && this.selfService !== undefined;
  }

  /** Plan B for existing bookings: `VOICE_MANAGE_DICTATED_PHONE_ENABLED` on top of {@link enabled}. */
  get dictatedEnabled(): boolean {
    return this.config.dictatedEnabled === true && this.enabled;
  }

  /** Plan B for a NEW booking (lock `ask_phone`): the flag alone. */
  get dictatedFlag(): boolean {
    return this.config.dictatedEnabled === true;
  }

  // ------------------------------------------------------------ my_bookings

  async myBookings(body: unknown, nowMs: number): Promise<VoiceManageResponse> {
    const conversationId = readConversationId(field(body, "conversation_id"));
    if (conversationId === undefined) return this.done("my_bookings", undefined, none("invalid_request", MSG_INVALID_MANAGE));
    if (!this.enabled) return this.done("my_bookings", conversationId, none("manage_unavailable", MSG_MANAGE_BY_WHATSAPP));
    const caller = resolveManageCaller(field(body, "caller_phone"));
    const rawIntent = field(body, INTENT_FIELD);
    const intent = (VOICE_MANAGE_INTENTS as readonly unknown[]).includes(rawIntent)
      ? (rawIntent as VoiceManageIntent)
      : undefined;

    // Plan B: a dictated phone (with its flag) is looked up only WITH the name.
    // Flag off: ignored, exactly as before.
    const rawDictated = field(body, DICTATED_PHONE_FIELD);
    const dictatedSent =
      (typeof rawDictated === "string" && rawDictated.trim() !== "") || typeof rawDictated === "number";
    if (this.dictatedEnabled && dictatedSent) {
      return this.myBookingsDictated(conversationId, caller, rawDictated, field(body, CUSTOMER_NAME_FIELD), intent, nowMs);
    }

    if (caller === undefined) {
      return this.done(
        "my_bookings",
        conversationId,
        this.dictatedEnabled ? none("phone_needed", MSG_PHONE_NEEDED) : none("caller_unknown", MSG_MANAGE_BY_WHATSAPP),
      );
    }

    return this.serialize(conversationId, async () => {
      const read = await this.selfService!.listForVoice(caller, nowMs);
      if (!read.ok) {
        return this.done(
          "my_bookings",
          conversationId,
          read.reason === "off"
            ? none("manage_unavailable", MSG_MANAGE_BY_WHATSAPP)
            : none("agenda_unavailable", MSG_AGENDA_UNAVAILABLE),
        );
      }
      if (read.rows.length === 0) {
        this.lists.delete(conversationId);
        return this.done(
          "my_bookings",
          conversationId,
          none("no_bookings", this.dictatedEnabled ? MSG_NO_BOOKINGS_ASK_OTHER : MSG_NO_BOOKINGS),
        );
      }
      return this.publish(conversationId, { source: "caller", phoneE164: caller, callerAtList: caller }, read.rows, intent, nowMs);
    });
  }

  /** Plan B: dictated phone + first name, both required, rate limited. */
  private async myBookingsDictated(
    conversationId: string,
    caller: string | undefined,
    rawPhone: unknown,
    rawName: unknown,
    intent: VoiceManageIntent | undefined,
    nowMs: number,
  ): Promise<VoiceManageResponse> {
    return this.serialize(conversationId, async () => {
      const used = this.dictatedAttempts.get(conversationId) ?? 0;
      if (used >= DICTATED_MAX_PER_CALL) {
        return this.done("my_bookings", conversationId, none("dictated_limit", MSG_DICTATED_LIMIT), {
          source: "dictated",
          limit: "call",
        });
      }
      this.dictatedAttempts.delete(conversationId);
      this.dictatedAttempts.set(conversationId, used + 1);
      while (this.dictatedAttempts.size > VOICE_MANAGE_MAX_CONVERSATIONS) {
        const oldest = this.dictatedAttempts.keys().next();
        if (oldest.done === true) break;
        this.dictatedAttempts.delete(oldest.value);
      }
      const notFound = (why: string): VoiceManageResponse =>
        this.done(
          "my_bookings",
          conversationId,
          none(
            "dictated_not_found",
            used + 1 < DICTATED_MAX_PER_CALL ? MSG_DICTATED_NOT_FOUND_RETRY : MSG_DICTATED_NOT_FOUND_FINAL,
          ),
          { source: "dictated", why, attempt: used + 1 },
        );

      const phone =
        typeof rawPhone === "string" || typeof rawPhone === "number"
          ? normalizeSpanishPhone(String(rawPhone).slice(0, 40))
          : undefined;
      const nameKey = firstNameKey(rawName);
      if (phone === undefined || !phone.ok || nameKey === undefined) return notFound("unreadable");
      if (!this.dictatedRateOk(phone.e164, nowMs)) {
        return this.done("my_bookings", conversationId, none("dictated_limit", MSG_DICTATED_LIMIT), {
          source: "dictated",
          limit: "number_or_global",
        });
      }
      const read = await this.selfService!.listForVoice(phone.e164, nowMs);
      if (!read.ok) {
        return this.done(
          "my_bookings",
          conversationId,
          read.reason === "off"
            ? none("manage_unavailable", MSG_MANAGE_BY_WHATSAPP)
            : none("agenda_unavailable", MSG_AGENDA_UNAVAILABLE),
          { source: "dictated" },
        );
      }
      // Only the bookings under THAT first name; the others are never named.
      const rows = read.rows.filter((row) => firstNameKey(row.ownerName) === nameKey);
      if (rows.length === 0) return notFound(read.rows.length === 0 ? "no_rows" : "name_mismatch");
      return this.publish(
        conversationId,
        { source: "dictated", phoneE164: phone.e164, callerAtList: caller },
        rows,
        intent,
        nowMs,
      );
    });
  }

  /** Stores the listing of this call and answers it. */
  private publish(
    conversationId: string,
    who: { source: "caller" | "dictated"; phoneE164: string; callerAtList: string | undefined },
    rows: DashboardReservation[],
    intent: VoiceManageIntent | undefined,
    nowMs: number,
  ): VoiceManageResponse {
    const shown = rows.slice(0, VOICE_MANAGE_MAX_LISTED);
    const previous = this.liveList(conversationId, nowMs);
    const bookings: ListedBooking[] = shown.map((row, i) => {
      // A booking already cancelled or changed in this call keeps its fate.
      const known =
        previous?.phoneE164 === who.phoneE164
          ? previous.bookings.find((b) => b.reservationId === row.id)
          : undefined;
      return {
        index: i + 1,
        reservationId: row.id,
        startsAt: row.startsAt,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        serviceId:
          row.typeReservation !== null && [0, 1, 2].includes(row.typeReservation) ? row.typeReservation : null,
        status: known?.status ?? "listed",
        ...(known?.cancelAnswer ? { cancelAnswer: known.cancelAnswer } : {}),
        ...(known?.serviceAnswer ? { serviceAnswer: known.serviceAnswer } : {}),
      };
    });
    // «¿Te anulo tu cita del …?» (intent anular, one booking) IS the question.
    const asks = intent === "anular" && shown.length === 1 && bookings[0]!.status === "listed";
    this.store(conversationId, {
      ...who,
      storedAtMs: nowMs,
      bookings,
      ...(asks ? { pendingConfirm: { index: 1, askedAtMs: nowMs } } : {}),
    });
    return this.done(
      "my_bookings",
      conversationId,
      {
        outcome: "bookings_found",
        message: msgBookingsFound(shown, rows.length, intent),
        bookings: shown.map((row, i) => ({
          booking_index: i + 1,
          date: row.startsAt.slice(0, 10),
          time: row.startsAt.slice(11, 16),
          spoken: spokenAppointmentEs(row.startsAt),
          professional: row.employeeName,
          employee_id: row.employeeId,
          service_id:
            row.typeReservation !== null && [0, 1, 2].includes(row.typeReservation) ? row.typeReservation : null,
        })),
        total_bookings: rows.length,
        external_mutation: false,
        mutation_status: "none",
      },
      { bookings: rows.length, ...(who.source === "dictated" ? { source: "dictated" } : {}) },
    );
  }

  /** Per dictated number (24 h) and overall (1 h). Consumes one when allowed. */
  private dictatedRateOk(phoneE164: string, nowMs: number): boolean {
    this.dictatedGlobal = this.dictatedGlobal.filter((t) => nowMs - t < DICTATED_GLOBAL_WINDOW_MS);
    const key = createHash("sha256").update(phoneE164).digest("hex").slice(0, 24);
    const hits = (this.dictatedPerNumber.get(key) ?? []).filter((t) => nowMs - t < DICTATED_NUMBER_WINDOW_MS);
    if (hits.length >= DICTATED_MAX_PER_NUMBER || this.dictatedGlobal.length >= DICTATED_MAX_GLOBAL) {
      this.dictatedPerNumber.set(key, hits);
      return false;
    }
    hits.push(nowMs);
    this.dictatedPerNumber.delete(key);
    this.dictatedPerNumber.set(key, hits);
    this.dictatedGlobal.push(nowMs);
    while (this.dictatedPerNumber.size > VOICE_MANAGE_MAX_CONVERSATIONS) {
      const oldest = this.dictatedPerNumber.keys().next();
      if (oldest.done === true) break;
      this.dictatedPerNumber.delete(oldest.value);
    }
    return true;
  }

  /** Whether this call may act on `list`: same caller id, and plan B still on. */
  private owns(list: ListEntry, caller: string | undefined): boolean {
    if (list.source === "dictated") return this.dictatedEnabled && list.callerAtList === caller;
    return caller !== undefined && list.phoneE164 === caller;
  }

  // ----------------------------------------------------------------- cancel

  async cancel(body: unknown, nowMs: number): Promise<VoiceManageResponse> {
    const conversationId = readConversationId(field(body, "conversation_id"));
    if (conversationId === undefined) return this.done("cancel", undefined, none("invalid_request", MSG_INVALID_MANAGE));
    if (!this.enabled) return this.done("cancel", conversationId, none("manage_unavailable", MSG_MANAGE_BY_WHATSAPP));
    const caller = resolveManageCaller(field(body, "caller_phone"));
    if (caller === undefined && !this.dictatedEnabled) {
      return this.done("cancel", conversationId, none("caller_unknown", MSG_MANAGE_BY_WHATSAPP));
    }
    const index = readBookingIndex(field(body, BOOKING_INDEX_FIELD));

    return this.serialize(conversationId, async () => {
      const list = this.liveList(conversationId, nowMs);
      const booking =
        list !== undefined && this.owns(list, caller) && index !== undefined
          ? list.bookings.find((b) => b.index === index)
          : undefined;
      if (list === undefined || booking === undefined) {
        return this.done("cancel", conversationId, none("booking_not_listed", MSG_NOT_LISTED));
      }
      // Idempotency: the same cancel in the same call answers what it answered.
      if (booking.status === "cancelled" && booking.cancelAnswer !== undefined) {
        return this.done("cancel", conversationId, {
          ...booking.cancelAnswer,
          external_mutation: false,
          idempotency_status: "replayed",
        });
      }
      if (booking.status !== "listed") {
        return this.done("cancel", conversationId, none("booking_not_listed", MSG_NOT_LISTED));
      }

      // *** THE SERVER ASKS, THE CUSTOMER ANSWERS, THEN IT CANCELS. ***
      // Only `true`, for the booking the server's last question named, and
      // not in the same breath as that question.
      const pending = list.pendingConfirm;
      const confirmed = field(body, "confirmed_by_customer") === true;
      const sameQuestion = pending !== undefined && pending.index === booking.index;
      const elapsed = sameQuestion ? nowMs - pending.askedAtMs : -1;
      if (!confirmed || !sameQuestion || elapsed < VOICE_MANAGE_CONFIRM_MIN_GAP_MS || elapsed > VOICE_MANAGE_CONFIRM_TTL_MS) {
        list.pendingConfirm = { index: booking.index, askedAtMs: nowMs };
        return this.done(
          "cancel",
          conversationId,
          { ...none("confirm_required", msgConfirmCancel(booking.startsAt)), booking_index: booking.index },
          {
            confirmed_sent: confirmed,
            ...(confirmed && sameQuestion && elapsed < VOICE_MANAGE_CONFIRM_MIN_GAP_MS ? { premature: true } : {}),
            ...(list.source === "dictated" ? { source: "dictated" } : {}),
          },
        );
      }
      list.pendingConfirm = undefined;

      const resp = await this.selfService!.cancelForVoice(
        {
          phoneE164: list.phoneE164,
          reservationId: booking.reservationId,
          startsAt: booking.startsAt,
          ...(list.source === "dictated" ? { via: "dictated" as const } : {}),
        },
        nowMs,
      );
      const at = booking.startsAt;
      let answer: VoiceManageResponse;
      switch (resp.outcome) {
        case "cancelled":
          answer = {
            outcome: "cancelled",
            message: msgCancelledVoice(at),
            booking_index: booking.index,
            external_mutation: resp["idempotency_status"] === "replayed" ? false : true,
            mutation_status: "confirmed",
            idempotency_status: resp["idempotency_status"] === "replayed" ? "replayed" : "original",
          };
          booking.status = "cancelled";
          booking.cancelAnswer = answer;
          break;
        case "not_found":
          answer = { ...none("booking_gone", MSG_BOOKING_GONE), booking_index: booking.index };
          break;
        case "reservation_changed":
          answer = none("booking_not_listed", MSG_NOT_LISTED);
          this.lists.delete(conversationId);
          break;
        case "uncertain":
          answer = {
            outcome: "cancel_uncertain",
            message: msgCancelUncertainVoice(at),
            booking_index: booking.index,
            external_mutation: null,
            mutation_status: "unknown",
          };
          booking.status = "changing"; // never offered for a second cancel on a guess
          break;
        default:
          // cancel_pending_owner (mode / allow list), upstream_error (still
          // there), too_late_to_cancel, rate_limited, self_service_off: the
          // booking STANDS, and the sentence says so.
          answer = {
            ...none("not_cancelled", msgNotCancelledVoice(at)),
            booking_index: booking.index,
          };
      }
      return this.done("cancel", conversationId, answer, {
        rid_hash: ridHash(booking.reservationId),
        upstream_outcome: resp.outcome,
        ...(list.source === "dictated" ? { source: "dictated" } : {}),
      });
    });
  }

  // ----------------------------------------------------------- change_service

  /**
   * 2026-10-11 — changes ONLY the service of booking `booking_index` of this
   * call's listing (same day, hour and professional). The first call (and any
   * call without a «sí» to THIS question, or sooner than 3 s after it) answers
   * `confirm_required` and writes nothing; the second, with
   * `confirmed_by_customer: true`, the same index and the same `service_id`,
   * runs `WaSelfService.changeServiceForVoice` (re-read, `swapService`).
   * `VOICE_CHANGE_SERVICE_ENABLED` off: `service_change_unavailable`.
   */
  async changeService(body: unknown, nowMs: number): Promise<VoiceManageResponse> {
    const conversationId = readConversationId(field(body, "conversation_id"));
    if (conversationId === undefined) {
      return this.done("change_service", undefined, none("invalid_request", MSG_INVALID_MANAGE));
    }
    if (!this.enabled) return this.done("change_service", conversationId, none("manage_unavailable", MSG_MANAGE_BY_WHATSAPP));
    if (this.config.changeServiceEnabled !== true || this.selfService!.changeServiceForVoice === undefined) {
      return this.done(
        "change_service",
        conversationId,
        none("service_change_unavailable", MSG_SERVICE_UNAVAILABLE_VOICE),
      );
    }
    const caller = resolveManageCaller(field(body, "caller_phone"));
    if (caller === undefined && !this.dictatedEnabled) {
      return this.done("change_service", conversationId, none("caller_unknown", MSG_MANAGE_BY_WHATSAPP));
    }
    const index = readBookingIndex(field(body, BOOKING_INDEX_FIELD));
    const rawService = field(body, "service_id");
    const serviceId =
      typeof rawService === "number"
        ? rawService
        : typeof rawService === "string" && rawService.trim() !== ""
          ? Number(rawService.trim())
          : NaN;
    if (serviceId !== 0 && serviceId !== 1 && serviceId !== 2) {
      return this.done("change_service", conversationId, none("invalid_request", MSG_INVALID_MANAGE));
    }
    const newType: 0 | 1 | 2 = serviceId;

    return this.serialize(conversationId, async () => {
      const list = this.liveList(conversationId, nowMs);
      const booking =
        list !== undefined && this.owns(list, caller) && index !== undefined
          ? list.bookings.find((b) => b.index === index)
          : undefined;
      if (list === undefined || booking === undefined) {
        return this.done("change_service", conversationId, none("booking_not_listed", MSG_NOT_LISTED));
      }
      // Idempotency: the same change in the same call answers what it answered.
      if (booking.serviceAnswer !== undefined && booking.serviceAnswer.serviceId === newType) {
        return this.done("change_service", conversationId, {
          ...booking.serviceAnswer.answer,
          external_mutation: false,
          idempotency_status: "replayed",
        });
      }
      if (booking.status !== "listed") {
        return this.done("change_service", conversationId, none("booking_not_listed", MSG_NOT_LISTED));
      }
      if (booking.serviceId === newType) {
        return this.done("change_service", conversationId, {
          ...none("same_service", msgSameServiceVoice(newType)),
          booking_index: booking.index,
        });
      }

      // *** THE SERVER ASKS, THE CUSTOMER ANSWERS, THEN IT WRITES. ***
      const pending = list.pendingServiceConfirm;
      const confirmed = field(body, "confirmed_by_customer") === true;
      const sameQuestion = pending !== undefined && pending.index === booking.index && pending.serviceId === newType;
      const elapsed = sameQuestion ? nowMs - pending.askedAtMs : -1;
      if (!confirmed || !sameQuestion || elapsed < VOICE_MANAGE_CONFIRM_MIN_GAP_MS || elapsed > VOICE_MANAGE_CONFIRM_TTL_MS) {
        list.pendingServiceConfirm = { index: booking.index, serviceId: newType, askedAtMs: nowMs };
        return this.done(
          "change_service",
          conversationId,
          {
            ...none("confirm_required", msgServiceConfirmVoice(booking, booking.serviceId, newType)),
            booking_index: booking.index,
          },
          {
            confirmed_sent: confirmed,
            ...(confirmed && sameQuestion && elapsed < VOICE_MANAGE_CONFIRM_MIN_GAP_MS ? { premature: true } : {}),
          },
        );
      }
      list.pendingServiceConfirm = undefined;

      const resp = await this.selfService!.changeServiceForVoice!(
        {
          phoneE164: list.phoneE164,
          reservationId: booking.reservationId,
          startsAt: booking.startsAt,
          newType,
          conversationId,
          ...(list.source === "dictated" ? { via: "dictated" as const } : {}),
        },
        nowMs,
      );
      let answer: VoiceManageResponse;
      switch (resp.outcome) {
        case "service_changed":
          answer = {
            outcome: "service_changed",
            message: msgServiceChangedVoice(booking, newType),
            booking_index: booking.index,
            external_mutation: resp["idempotency_status"] === "replayed" ? false : true,
            mutation_status: "confirmed",
            idempotency_status: resp["idempotency_status"] === "replayed" ? "replayed" : "original",
          };
          booking.status = "changed";
          booking.serviceAnswer = { serviceId: newType, answer };
          break;
        case "same_service":
          answer = { ...none("same_service", msgSameServiceVoice(newType)), booking_index: booking.index };
          break;
        case "service_not_changed":
          answer = {
            outcome: "service_not_changed",
            message: MSG_SERVICE_NOT_CHANGED_VOICE,
            booking_index: booking.index,
            external_mutation: resp.external_mutation === false ? false : null,
            mutation_status: resp.external_mutation === false ? "none" : "unknown",
          };
          break;
        case "service_change_too_late":
          answer = { ...none("service_change_too_late", MSG_SERVICE_TOO_LATE_VOICE), booking_index: booking.index };
          break;
        case "service_change_lost":
        case "uncertain":
          answer = {
            outcome: resp.outcome === "uncertain" ? "uncertain" : "service_change_lost",
            message: MSG_SERVICE_LOST_VOICE,
            booking_index: booking.index,
            external_mutation: null,
            mutation_status: "unknown",
          };
          booking.status = "changing"; // never offered again on a guess
          break;
        case "not_found":
          answer = { ...none("booking_gone", MSG_BOOKING_GONE), booking_index: booking.index };
          break;
        case "reservation_changed":
          answer = none("booking_not_listed", MSG_NOT_LISTED);
          this.lists.delete(conversationId);
          break;
        default:
          // service_change_unavailable, rate_limited, invalid_request, identity_unavailable...
          answer = {
            ...none("service_change_unavailable", MSG_SERVICE_UNAVAILABLE_VOICE),
            booking_index: booking.index,
          };
      }
      return this.done("change_service", conversationId, answer, {
        rid_hash: ridHash(booking.reservationId),
        upstream_outcome: resp.outcome,
        ...(list.source === "dictated" ? { source: "dictated" } : {}),
      });
    });
  }

  // --------------------------------------------- change (VoiceBookingService)

  /**
   * Booking `index` of this call's listing, for a CHANGE — pure, no I/O.
   * The create checks the new booking's phone against `phoneE164`.
   */
  resolveForChange(conversationId: string, index: number, nowMs: number): ChangeResolution {
    if (!this.enabled) return { ok: false, reason: "not_listed" };
    const list = this.liveList(conversationId, nowMs);
    const booking = list?.bookings.find((b) => b.index === index);
    if (list === undefined || booking === undefined) return { ok: false, reason: "not_listed" };
    if (list.source === "dictated" && !this.dictatedEnabled) return { ok: false, reason: "not_listed" };
    if (booking.status !== "listed") {
      return { ok: false, reason: "already_changed", startsAt: booking.startsAt };
    }
    return {
      ok: true,
      reservationId: booking.reservationId,
      startsAt: booking.startsAt,
      employeeId: booking.employeeId,
      phoneE164: list.phoneE164,
      ...(list.source === "dictated" ? { dictated: true } : {}),
    };
  }

  /**
   * The lock of a CHANGE (`booking_index` on the lock): the start of the
   * summary, written by the server from the agenda, and remembered for the
   * create. Undefined = not a booking of this call's listing: a plain lock.
   */
  offerChange(conversationId: string, index: number, slotToken: string, nowMs: number): string | undefined {
    const resolved = this.resolveForChange(conversationId, index, nowMs);
    const list = this.lists.get(conversationId);
    if (!resolved.ok || list === undefined) return undefined;
    list.changeOffer = { index, tokenHash: tokenHash(slotToken), askedAtMs: nowMs };
    this.logger.info(
      { conversation_id: shortConversationId(conversationId), action: "lock", change_of_booking: index },
      "voice manage: change summary written by the server",
    );
    return msgChangeSummaryLead(resolved.startsAt);
  }

  /**
   * The create of a CHANGE: `go` only after the server wrote the change's
   * summary for THIS index and THIS slot token (the lock, or an earlier
   * `change_confirm_required`) and not in the same breath. Otherwise `ask`,
   * and the question is remembered.
   */
  gateChange(conversationId: string, index: number, slotToken: string, nowMs: number): "go" | "ask" {
    const list = this.liveList(conversationId, nowMs);
    if (list === undefined) return "ask";
    const offer = list.changeOffer;
    const hash = tokenHash(slotToken);
    if (
      offer !== undefined &&
      offer.index === index &&
      offer.tokenHash === hash &&
      nowMs - offer.askedAtMs >= VOICE_MANAGE_CONFIRM_MIN_GAP_MS
    ) {
      return "go";
    }
    list.changeOffer = { index, tokenHash: hash, askedAtMs: nowMs };
    return "ask";
  }

  /** A change of booking `index` started / ended: never cancelled twice. */
  markChange(conversationId: string, index: number, status: "changing" | "changed"): void {
    const booking = this.lists.get(conversationId)?.bookings.find((b) => b.index === index);
    if (booking !== undefined) booking.status = status;
  }

  // ---------------------------------------------------------------- helpers

  private liveList(conversationId: string, nowMs: number): ListEntry | undefined {
    const entry = this.lists.get(conversationId);
    if (entry === undefined) return undefined;
    if (nowMs - entry.storedAtMs >= VOICE_MANAGE_LIST_TTL_MS) {
      this.lists.delete(conversationId);
      return undefined;
    }
    return entry;
  }

  private store(conversationId: string, entry: ListEntry): void {
    this.lists.delete(conversationId);
    this.lists.set(conversationId, entry);
    while (this.lists.size > VOICE_MANAGE_MAX_CONVERSATIONS) {
      const oldest = this.lists.keys().next();
      if (oldest.done === true) break;
      this.lists.delete(oldest.value);
    }
  }

  private async serialize<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(conversationId, settled);
    try {
      return await run;
    } finally {
      if (this.chains.get(conversationId) === settled) this.chains.delete(conversationId);
    }
  }

  private done(
    action: VoiceManageAction,
    conversationId: string | undefined,
    resp: VoiceManageResponse,
    extra: Record<string, unknown> = {},
  ): VoiceManageResponse {
    this.logger.info(
      {
        conversation_id: conversationId === undefined ? "<absent-or-invalid>" : shortConversationId(conversationId),
        action,
        outcome: resp.outcome,
        ...extra,
      },
      "voice manage: answered",
    );
    return resp;
  }
}
