import { createHmac, randomBytes } from "node:crypto";

import type { IncomingHeaders } from "../callerIdentity/resolver.js";
import {
  MemoryBookingIdempotencyStore,
  type BookingIdempotencyStore,
  type BookingJournalMeta,
  type IdempotencyRecord,
  type IdempotencyState,
} from "./bookingIdempotencyStore.js";
import {
  BOOKING_UNCERTAIN_MESSAGE,
  CALLER_PHONE_UNAVAILABLE_MESSAGE,
  INVALID_CUSTOMER_DATA_MESSAGE,
  INVALID_PHONE_LENGTH_MESSAGE,
  NEEDS_CONFIRMATION_MESSAGE,
  SLOT_NOT_AUTHORIZED_MESSAGE,
  SLOT_TOKEN_EXPIRED_MESSAGE,
} from "../utils/phrasing.js";
import {
  CONVERSATION_ID_MAX_LENGTH,
  CONVERSATION_ID_MIN_LENGTH,
  CONVERSATION_ID_RE,
  type VoiceAvailabilityInput,
  type VoiceBookInput,
} from "../schemas/aiSchemas.js";
import { fullPhraseEs, timeLabelFromString } from "../utils/dateFormatterEs.js";
import type { AvailabilityService, SlotOut } from "./availabilityService.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import type { BookOutcomeClass, BookingService } from "./bookingService.js";
import {
  SLOT_TOKEN_TTL_MIN_SECONDS,
  SlotAuthorizationService,
  type SlotAuthorizationFailure,
  type SlotGrant,
} from "./slotAuthorization.js";
import {
  readCustomerIdentity,
  readTrimmedString,
  type CustomerIdentity,
  type IdentityRejection,
} from "../utils/personalData.js";
import {
  MemoryVoiceOfferStore,
  VOICE_OFFER_TTL_MIN_SECONDS,
  type VoiceOfferStore,
} from "./voiceOfferStore.js";
import { ConversationSerializer } from "../utils/conversationSerializer.js";
import { shortConversationId } from "../plugins/observability.js";
import {
  BALANCED_SLOT_ALREADY_BOOKED_IN_CALL_MESSAGE,
  balancedBookingLimitMessage,
  balancedChangeConfirmMessage,
  balancedChangeDoneMessage,
  balancedChangeNotAvailableMessage,
  balancedChangeOldNotCancelledMessage,
  balancedBookTimeMismatchMessage,
  balancedPossibleDuplicateMessage,
  type ChangeRefusalReason,
} from "../utils/balancedPhrasing.js";
import { readExpectedOption } from "../utils/expectedOption.js";
import { t } from "../core/texts/texts.js";
import { normalizeSpanishPhone } from "../utils/phone.js";
import { assertBookingsPerCall } from "./balanced/agentProfile.js";
import {
  phoneBookingLimitVoiceMessage,
  phoneBookingLimitWhatsAppMessage,
  type PhoneLimitCheck,
} from "./bookingLimit/phoneBookingLimit.js";
import type { EmployeeNameDirectory } from "./employeeNameDirectory.js";
import {
  appointmentCalendarUrl,
  type CalendarLinkConfig,
  type WhatsAppConfirmationSink,
} from "./whatsapp/whatsappNotifier.js";

/**
 * ADR-031 addendum (2026-10-08) — the request header that names the CHANNEL a
 * booking came from. Only the WhatsApp «cerebro» sends it, with the value
 * `whatsapp` (compared case-insensitively, trimmed). The voice agent never
 * sends it, and without it the booking answer is byte for byte what it was.
 */
export const AI_CHANNEL_HEADER = "x-ai-channel";

/** Whether this request declares itself as the WhatsApp channel. */
export function isWhatsAppChannel(headers: IncomingHeaders): boolean {
  const raw = headers[AI_CHANNEL_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim().toLowerCase() === "whatsapp";
}

/**
 * V5 ((internal doc, not included in the template) ADR-023/ADR-025) — per-request options of
 * {@link VoiceBookingService.book}. Absent = the classic rule.
 */
export interface VoiceBookOptions {
  /**
   * How many CONFIRMED appointments this request's conversation may hold,
   * 1..3. Decided per request by the agent profile (`agent_profile: "v5"` on
   * `/ai/voice/v2/book`, see `src/services/balanced/agentProfile.ts`); every
   * other caller — V1, and V4 on the V2 route — leaves it at 1 and keeps the
   * one-write-per-call rule exactly as it was: same journal key, same gate,
   * same terminal offer state, same response fields.
   */
  maxBookingsPerCall?: number;
  /**
   * 2026-10-08 — `replaces_booking_number` of a VOICE request (the route reads
   * it from the raw body and never passes it for the WhatsApp channel):
   *
   * - `1..n` — this create CHANGES booking n of this same call: the new one is
   *   created first and, only if confirmed, booking n is cancelled through the
   *   WhatsApp self-service cancel path (`VoiceBookingDeps.changeCanceller`).
   * - `0` — the caller wants BOTH: skips the duplicate net (see
   *   {@link VoiceBookingService} `possible_duplicate`).
   * - absent — an ordinary create, guarded by the duplicate net.
   *
   * Only honoured on the multi-booking path (V5); anywhere else a positive
   * value is answered `change_not_available` with nothing written.
   */
  replacesBookingNumber?: number;
  /**
   * 2026-10-10 — `replaces_existing_booking` of a VOICE request: this create
   * CHANGES booking N (1..2) of the listing `my_bookings` read for THIS call's
   * caller id (internal doc, not included in the template). New booking first;
   * only if confirmed, the old one is cancelled by its reservation id.
   * Ignored for WhatsApp and when `replacesBookingNumber` > 0 is present.
   */
  replacesExisting?: number;
  /**
   * 2026-10-09 — the raw `caller_phone` of a VOICE request (ElevenLabs binds
   * it to `system__caller_id`; the route never passes it for WhatsApp). Used
   * only when {@link VoiceBookingDeps.callerIdPhoneEnabled} and the request's
   * `phone` is absent, empty or a caller marker — see `resolveCallerPhone`.
   */
  callerPhone?: unknown;
  /**
   * 2026-10-09 (escaneo, hallazgo 1) — the raw `option_time` / `option_date`
   * of the create, voice AND WhatsApp: the hour the agent read to the customer
   * in the summary. When readable and different from the slot token's hour,
   * nothing is created (`slot_time_mismatch`). Absent or unreadable: the
   * create behaves exactly as before.
   */
  optionTime?: unknown;
  optionDate?: unknown;
}

/**
 * 2026-10-09 — what the agent sends as `phone` when the customer accepted the
 * number they are calling from. `"caller"` is the documented one; the others
 * are what a model might write instead. Compared lowercased, without accents.
 */
const CALLER_PHONE_MARKERS: ReadonlySet<string> = new Set([
  "caller",
  "caller_id",
  "callerid",
  "caller id",
  "system__caller_id",
  "llamante",
  "llamada",
  "este",
  "este numero",
  "mismo",
  "el mismo",
  "mismo numero",
  "el mismo numero",
]);

/**
 * 2026-10-09 — which phone a voice create should validate.
 *
 * - A `phone` with any digit is what the customer DICTATED: it always wins and
 *   is returned untouched (its own validation and messages apply).
 * - Otherwise (absent, empty, or a caller marker) the caller id is used when
 *   it is a Spanish MOBILE; `normalizeSpanishPhone` strips `+34`/`0034`/`34`.
 * - A marker/absent phone with no usable caller id → `unavailable`: the agent
 *   must ask the customer for a mobile.
 * - A digitless `phone` that is not a marker (e.g. `"Desconocido"`) is left
 *   alone, so it is refused as before.
 */
export function resolveCallerPhone(
  phone: unknown,
  callerPhone: unknown,
):
  | { kind: "dictated" }
  | { kind: "caller"; phone: string }
  | { kind: "unavailable"; reason: "missing" | "not_spanish" | "not_mobile" } {
  if (typeof phone === "string" && /\d/.test(phone)) return { kind: "dictated" };
  const marker =
    phone === undefined || phone === null
      ? ""
      : typeof phone === "string"
        ? phone.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim()
        : undefined;
  if (marker === undefined || (marker !== "" && !CALLER_PHONE_MARKERS.has(marker))) {
    return { kind: "dictated" };
  }
  if (typeof callerPhone !== "string" || callerPhone.trim() === "") {
    return { kind: "unavailable", reason: "missing" };
  }
  const normalized = normalizeSpanishPhone(callerPhone.slice(0, 40));
  if (!normalized.ok) return { kind: "unavailable", reason: "not_spanish" };
  if (normalized.kind !== "mobile") return { kind: "unavailable", reason: "not_mobile" };
  return { kind: "caller", phone: normalized.national };
}

/**
 * 2026-10-08 — how a voice change cancels the booking it replaces. Implemented
 * by `WaSelfService` (ADR-032): the SAME dashboard lookup, delete, verification
 * and owner notice the WhatsApp cancel uses. Structural, so tests can fake it.
 */
export interface VoiceChangeCanceller {
  /** Pre-write, no I/O, consumes nothing: could the old booking be cancelled now? */
  canCancelForVoiceChange(phoneE164: string, nowMs: number): boolean;
  /** Post-write. Never throws. */
  cancelForVoiceChange(
    req: {
      conversationId: string;
      phoneE164: string;
      startsAt: string;
      employeeId?: number;
      /** AVISOS_AGENDA: the new booking, for the owner's «CAMBIADA» line. */
      changeTo?: { startsAt: string; professional: string | null };
    },
    nowMs: number,
  ): Promise<"cancelled" | "not_cancelled" | "unknown">;
  /** 2026-10-10 — post-write, by reservation id (an EXISTING booking). Never throws. */
  cancelExistingForVoiceChange?(
    req: {
      conversationId: string;
      phoneE164: string;
      reservationId: number;
      startsAt: string;
      dictated?: boolean;
      changeTo?: { startsAt: string; professional: string | null };
    },
    nowMs: number,
  ): Promise<"cancelled" | "not_cancelled" | "unknown">;
}

/**
 * 2026-10-10 — the per-call listing of existing bookings
 * (`VoiceManageService`). Structural, so tests can fake it.
 */
export interface VoiceExistingBookingsPort {
  resolveForChange(
    conversationId: string,
    index: number,
    nowMs: number,
  ):
    | {
        ok: true;
        reservationId: number;
        startsAt: string;
        employeeId: number | null;
        phoneE164: string;
        dictated?: boolean;
      }
    | { ok: false; reason: "not_listed" | "already_changed"; startsAt?: string };
  markChange(conversationId: string, index: number, status: "changing" | "changed"): void;
  /**
   * 2026-10-10 — `go` only after the server wrote this change's summary for
   * this index and slot token (and not in the same breath); `ask` records the
   * question. Absent (test fakes): `go`.
   */
  gateChange?(conversationId: string, index: number, slotToken: string, nowMs: number): "go" | "ask";
}

/**
 * How many CHANGES one call may make on top of its bookings. A change takes a
 * new journal record (the old one is kept, marked), so the journal of a call
 * holds at most `max_bookings_per_call + MAX_CHANGES_PER_CALL` records.
 */
export const MAX_CHANGES_PER_CALL = 2;

/**
 * From the moment a change request starts, the most it may take before this
 * process answers: the create (bounded by `BALANCED_BOOK_DEADLINE_MS`) plus
 * the cancellation. ElevenLabs' tool timeout is 8 s; whatever is still running
 * at this budget keeps running and journals its truth, and the caller hears
 * the honest «no he podido confirmar…» sentence.
 */
export const CHANGE_TOTAL_BUDGET_MS = 7_000;

/**
 * V5 — the journal key of booking `number` of a conversation.
 *
 * Booking 1 keeps the bare `conversation_id`, which is what makes a
 * one-booking deployment's journal byte-for-byte what it always was, and what
 * makes a V1 service reading the same journal see booking 1 exactly where it
 * always looked. Later bookings append `#2`, `#3`: `#` is outside
 * `CONVERSATION_ID_RE`, so no real conversation id can ever collide with a
 * sub-record of another.
 */
export function bookingJournalId(conversationId: string, number: number): string {
  return number === 1 ? conversationId : `${conversationId}#${number}`;
}

/** Which journal record a write lands in, which booking of the call it is,
 * and the limit the REQUEST that makes it was granted. */
interface BookingSlot {
  journalId: string;
  number: number;
  max: number;
  /** The offer becomes terminal (no later booking) rather than consumed. */
  terminal: boolean;
  /** The `booking_number` the agent is told — not the journal key. */
  reported: number;
  /** Voice multi-booking only: what the journal keeps for changes. */
  meta?: BookingJournalMeta;
}

/**
 * The longest `slot_token` this service will even look at. A real one is 91
 * characters; the margin absorbs a future format without letting an arbitrary
 * string reach the crypto path. Anything longer is treated as ABSENT — the
 * same deterministic refusal, never a 400.
 */
const SLOT_TOKEN_MAX_LENGTH = 400;

const DAY_MS = 86_400_000;

export interface VoiceAvailabilitySlot {
  reservation_date: string;
  date: string;
  time: string;
  employee_id?: number;
  employee_name?: string;
  /**
   * step SLOT — the opaque authorization for THIS hueco, in THIS
   * conversation. `POST /ai/voice/book` accepts nothing else, and reads the
   * date, the barber and the service out of it rather than off the request
   * body (`src/services/slotAuthorization.ts`).
   *
   * Optional in the type, and absent only when `VOICE_SLOT_TOKEN_SECRET` is
   * not configured. That deployment can still READ the agenda — a missing
   * secret must not take availability offline — but it cannot book, because
   * there is no token for the agent to present. Fail-closed, and visible in
   * the response rather than as a silent behaviour change.
   */
  slot_token?: string;
}

export interface VoiceAvailabilityResult {
  available: boolean;
  message: string;
  slots: VoiceAvailabilitySlot[];
  external_mutation: false;
}

export interface VoiceBookResult {
  booked: boolean;
  message: string;
  /**
   * `uncertain` (step CTL-3) is the outcome the agent must treat most
   * carefully: it means the write neither clearly succeeded nor clearly
   * failed, so the appointment may or may not exist. It is NOT a licence to
   * try again — see `VoiceBookingService.book()`.
   */
  outcome:
    | "confirmed"
    | "not_confirmed"
    | "write_disabled"
    | "slot_taken"
    | "misconfigured_owner"
    | "upstream_error"
    | "uncertain"
    | "already_booked_in_call"
    /**
     * step SLOT. Four refusals that happen BEFORE the idempotency journal is
     * touched and BEFORE `BookingService` is called, so every one of them
     * makes exactly zero upstream requests and consumes none of the
     * conversation's one-write budget.
     *
     * That last property is deliberate and it is what makes them safe to
     * return: a call that is sent back to `booking_check_availability` must be
     * able to come back with a real token and still book. A rejection here is
     * not a failed attempt, it is an attempt that never started.
     */
    /** No token, a fabricated one, or one whose seal does not verify. */
    | "invalid_slot_token"
    /** A genuine token for this call, past its lifetime. */
    | "slot_token_expired"
    /** A genuine token, but minted for a different conversation. */
    | "slot_not_authorized"
    /** Name, surnames or phone empty, trivial, or a known placeholder. */
    | "invalid_customer_data"
    /**
     * 2026-10-08. The same name, surnames and phone already have a booking of
     * this call on that day, and the create did not say whether it replaces it
     * (`replaces_booking_number`). Nothing was written; the lock stays valid.
     */
    | "possible_duplicate"
    /** 2026-10-08. A change (`replaces_booking_number`) refused before
     * anything was written: switched off, not this call's booking, another
     * phone, already changed, or too many changes. The old booking stands. */
    | "change_not_available"
    /** 2026-10-08. The NEW booking of a change exists (`booked: true`), but the
     * old one could not be cancelled, or its cancellation could not be
     * confirmed (`old_booking_cancelled` false / null). */
    | "changed_old_not_cancelled"
    /**
     * 2026-10-10 (internal doc, not included in the template). A change of an
     * EXISTING booking whose summary the server had not written for this
     * slot token (or a «sí» in the same breath): nothing written, the lock
     * stays valid, and `message` is the server's summary to confirm.
     */
    | "change_confirm_required"
    /**
     * 2026-10-09 (internal doc, not included in the template). The phone the
     * booking would carry already has `MAX_FUTURE_BOOKINGS_PER_PHONE` future
     * appointments in the agenda. Nothing was written; the lock stays valid.
     * A change (`replaces_booking_number`) is never refused for this.
     */
    | "phone_booking_limit"
    /**
     * 2026-10-09 (escaneo, hallazgo 1). The create said which hour it confirms
     * (`option_time` / `option_date`) and the slot token holds another one.
     * Nothing was written, nothing was journaled; the lock stays valid.
     */
    | "slot_time_mismatch";
  /**
   * 2026-10-09 — only on `slot_time_mismatch`: the hour the slot token holds
   * (`locked_*`) and the one the create said (`requested_*`).
   */
  locked_time?: string;
  locked_date?: string;
  requested_time?: string;
  requested_date?: string;
  /**
   * Whether an appointment was created upstream: `true`, `false`, or — the
   * point of step CTL-4 — **`null`**.
   *
   * This field used to be a plain boolean, and `uncertain` answered `false`.
   * That was a claim we had no evidence for, and the most expensive kind to
   * get wrong: "nothing was written" is precisely what licenses a human to
   * stop looking. After a timeout or a 5xx the appointment may very well
   * exist, so the honest value is "unknown", and `null` is how JSON says it.
   *
   * PREFER {@link VoiceBookResult.mutation_status} anywhere the value can be
   * coerced. `null` is falsy, so `if (!external_mutation)` quietly restores
   * the same false statement this change exists to remove.
   */
  external_mutation: boolean | null;
  /**
   * The same fact in a form that cannot be coerced into the wrong answer.
   *
   * - `confirmed` — an appointment exists upstream.
   * - `none`      — nothing was written, and the refusal was deterministic.
   * - `unknown`   — we do not know; nobody may assume either way.
   *
   * It never authorizes speech on its own: announcing a booking still
   * requires `booked === true` AND `outcome === "confirmed"`.
   */
  mutation_status: "confirmed" | "none" | "unknown";
  idempotency_status: "original" | "replayed";
  /**
   * V5 ((internal doc, not included in the template) ADR-023/ADR-025). The three fields below exist ONLY
   * on a request granted more than one booking per call (a V5 request, see
   * {@link VoiceBookOptions}); a V4 or V1 request never carries them — except
   * an identical retry that replays a record a V5 request wrote.
   *
   * `booking_number` — on a `confirmed` answer, which booking of this call it
   * is (1, 2 or 3). Stored with the answer, so a replay says the same number.
   */
  booking_number?: number;
  /** The configured limit, on `confirmed` and on the V5 `already_booked_in_call`. */
  max_bookings_per_call?: number;
  /**
   * On the V5 `already_booked_in_call` only: `true` when the call already has
   * the maximum number of appointments, `false` when the `slot_token` sent
   * already booked one in this call (a new appointment needs its own lock).
   */
  booking_limit_reached?: boolean;
  /**
   * The confirmation by WhatsApp is on its way (`src/services/whatsapp/`).
   *
   * *** PRESENT ONLY WHEN THE MESSAGE WILL ACTUALLY BE SENT. *** That is: the
   * deployment is in `live` mode, the job reached the durable queue, and the
   * recipient is allowed. `off`, `dry_run`, a recipient outside
   * `WHATSAPP_ALLOWED_RECIPIENTS` and any failure to queue all leave the field
   * ABSENT — so the prompt's «te lo mando por WhatsApp» is gated on a promise
   * this middleware can keep, rather than on a feature flag.
   *
   * It says `queued`, never `sent`: the send happens in a background worker,
   * after this answer. Nothing about the appointment depends on it.
   */
  whatsapp_confirmation?: "queued";
  /**
   * ADR-031 addendum (2026-10-08). The absolute «Añadir al calendario» link
   * of THIS appointment — `${WHATSAPP_CALENDAR_BASE_URL}/cal/<token>`, the
   * same page and token the WhatsApp template button opens — so the WhatsApp
   * «cerebro» can put it in its own confirmation message.
   *
   * *** PRESENT ONLY WHEN ALL OF THESE HOLD: ***
   * - the write is `confirmed` with an upstream reservation id;
   * - `WHATSAPP_CALENDAR_LINK_SECRET` AND `WHATSAPP_CALENDAR_BASE_URL` are
   *   configured (independent of `WHATSAPP_NOTIFICATIONS_MODE`);
   * - the request carries `x-ai-channel: whatsapp` ({@link AI_CHANNEL_HEADER}).
   *
   * The voice agent never sends that header, so its answers never carry this
   * field. A failure to mint simply leaves it out; it never affects the
   * booking. Stored with the answer in the idempotency journal, so an
   * identical retry replays the same link (the token is deterministic and
   * carries no customer data — `calendarLink.ts`).
   */
  calendar_url?: string;
  /**
   * 2026-10-10 (saludo y cierre del profesional): the barber's name, on a `confirmed`
   * answer only, so the closing sentence says «con Olga» from the server and
   * not from the model's memory. Read from {@link VoiceBookingDeps.employeeNames}
   * (filled by the lock that authorized this slot); ABSENT when the process
   * has not seen the id, and then nobody is named. Never decides anything.
   * INTERNAL: `/ai/voice/v2/book` strips it from every answer (V4 and
   * WhatsApp stay byte-identical) and only uses it for the V5 voice closing.
   */
  employee_name?: string;
  /**
   * 2026-10-08, on the answer to a CHANGE only: the booking number it replaced,
   * and whether that old booking was cancelled — `true`, `false`, or `null`
   * when its fate could not be confirmed in time.
   */
  replaced_booking_number?: number;
  /** 2026-10-10, on the answer to a change of an EXISTING booking: its `booking_index`. */
  replaced_existing_booking?: number;
  old_booking_cancelled?: boolean | null;
  /** 2026-10-08, on `possible_duplicate` only: the booking it may duplicate. */
  existing_booking_number?: number;
  /** 2026-10-09, on `phone_booking_limit` only: the configured limit. */
  max_future_bookings_per_phone?: number;
}

/**
 * 2026-10-09 — the per-phone limit as this service sees it
 * (`PhoneBookingLimit`). Structural, so tests can fake it.
 */
export interface PhoneBookingLimitPort {
  readonly max: number;
  /** Never throws; `allow` whenever the agenda could not be read in time. */
  check(phoneE164: string): Promise<PhoneLimitCheck>;
  /** A booking for this phone is being (or was) written. Never throws. */
  markChanged(phoneE164: string): void;
}

/**
 * 2026-10-09 — the floor of the write deadline once the per-phone check has
 * spent part of the budget: the check's wait is taken off
 * `BALANCED_BOOK_DEADLINE_MS` (so the whole create stays inside ElevenLabs'
 * 8 s), but never below this.
 */
export const MIN_WRITE_DEADLINE_MS = 4_000;

/**
 * The two mutation fields, derived from ONE classification so they can never
 * disagree with each other or with `outcome`.
 */
function mutationFields(
  outcomeClass: BookOutcomeClass,
): Pick<VoiceBookResult, "external_mutation" | "mutation_status"> {
  if (outcomeClass === "confirmed") {
    return { external_mutation: true, mutation_status: "confirmed" };
  }
  if (outcomeClass === "uncertain") {
    return { external_mutation: null, mutation_status: "unknown" };
  }
  return { external_mutation: false, mutation_status: "none" };
}

/**
 * The answer stored the instant BEFORE a write is attempted, and the answer
 * replayed for any attempt whose fate we never learned.
 *
 * It exists as a constant because it is written in two very different moments
 * — the `started` marker and the `uncertain` conclusion — and those two must
 * agree. If a crash freezes the journal at `started`, the record that survives
 * is already the honest answer; promotion on load only relabels the state.
 */
const UNCERTAIN_RESULT: VoiceBookResult = {
  booked: false,
  message: BOOKING_UNCERTAIN_MESSAGE,
  outcome: "uncertain",
  ...mutationFields("uncertain"),
  idempotency_status: "original",
};

/** «… debe revisarlo la peluquería.»: the business comes from the texts layer (D-012). */
export const ALREADY_BOOKED_IN_CALL_MESSAGE = t("voz.reserva.ya_reservada_en_llamada");

/**
 * The answer to a SECOND, different booking in a call that already produced a
 * confirmed one. One appointment per call; a second needs a human.
 */
const ALREADY_BOOKED_RESULT: VoiceBookResult = {
  booked: false,
  message: ALREADY_BOOKED_IN_CALL_MESSAGE,
  outcome: "already_booked_in_call",
  ...mutationFields("rejected"),
  idempotency_status: "original",
};

/**
 * step SLOT — the answers to a booking that was never authorized.
 *
 * All three are `rejected`, so `external_mutation: false` and
 * `mutation_status: "none"` are STATEMENTS OF FACT rather than defaults: the
 * refusal happens before the write path exists, so "nothing was written" is
 * something this code knows, not something it assumes. That is the exact
 * distinction ADR-016 drew when it stopped `uncertain` from claiming `false`.
 */
function refusal(
  outcome: VoiceBookResult["outcome"],
  message: string,
): VoiceBookResult {
  return {
    booked: false,
    message,
    outcome,
    ...mutationFields("rejected"),
    idempotency_status: "original",
  };
}

/** Which refusal a failed slot-token verification produces. */
function slotFailureResult(failure: SlotAuthorizationFailure): VoiceBookResult {
  if (failure === "expired") {
    return refusal("slot_token_expired", SLOT_TOKEN_EXPIRED_MESSAGE);
  }
  if (failure === "wrong_conversation") {
    return refusal("slot_not_authorized", SLOT_NOT_AUTHORIZED_MESSAGE);
  }
  // `malformed`, `forged` and `unconfigured` collapse into one caller-facing
  // answer on purpose. The distinction matters to an operator and is logged;
  // it must not reach the model, because "your token was the wrong SHAPE" is
  // an invitation to try a different shape.
  return refusal("invalid_slot_token", SLOT_NOT_AUTHORIZED_MESSAGE);
}

/**
 * The command actually executed, once the token has been opened.
 *
 * Note where each field comes from. The customer's identity is the only thing
 * still taken from the request body (the agent is the only source there is
 * for it); the hour, the barber and the service come exclusively from the
 * grant. Nothing downstream of this type can tell the difference, which is
 * the point — `performBook` cannot accidentally prefer a body value it can no
 * longer see.
 */
interface EffectiveBooking {
  conversationId: string;
  customerName: string;
  customerSurnames: string;
  phone: string;
  /** From the grant. */
  reservationDate: string;
  /** From the grant; absent when availability named no barber. */
  employeeId?: number;
  /** From the grant. */
  serviceId: number;
}

export interface VoiceBookingDeps {
  /**
   * Where completed bookings are remembered. Defaults to an in-memory store,
   * which is correct while creation is disabled; production with creation
   * armed must pass a durable one (`src/config/env.ts` enforces this at boot).
   */
  store?: BookingIdempotencyStore<VoiceBookResult>;
  /**
   * Key for the command fingerprint. It must be a secret, not a constant: the
   * fingerprint covers a customer's name and phone number, and a plain
   * SHA-256 of a nine-digit Spanish phone plus a common first name is
   * enumerable in seconds by anyone who obtains the persisted file. Keyed, it
   * is not. Defaults to a per-process random key, so a deployment that never
   * configures one still gets a fingerprint nobody outside the process can
   * reproduce — at the cost of not matching across restarts, which only
   * matters when a durable store is configured anyway.
   */
  fingerprintKey?: string;
  /**
   * How many of a question's dates may be resolved at once. Defaults to 3,
   * matching the upstream concurrency ceiling, so a single 7-day question can
   * never queue more work against the salon's API than the limiter would let
   * through anyway.
   */
  dateConcurrency?: number;
  /**
   * The agenda-visible AI marker (step CTL, (internal doc, not included in the template) ADR-012),
   * from `VOICE_BOOKING_DISPLAY_PREFIX`. Applied by `BookingService` to the
   * upstream `ownerName` and to nothing else.
   *
   * It lives on THIS service, not on `BookingService`'s own config, because
   * it is a property of the CHANNEL: an appointment is marked because a
   * machine took it over the phone, not because this process created it.
   * `POST /ai/book` shares the same `BookingService` instance and is
   * deliberately unaffected.
   *
   * Defaults to `""` so a directly-constructed service (every existing test)
   * behaves exactly as before; `src/services/container.ts` is what supplies
   * the real, marked value in a running process.
   */
  displayPrefix?: string;
  /**
   * step SLOT — mints the per-hueco authorization on availability and opens
   * it on booking (`src/services/slotAuthorization.ts`).
   *
   * Defaults to a DISABLED instance, which refuses every booking. That is the
   * fail-closed direction and it is the right default for a
   * directly-constructed service: a caller that forgot to wire this must lose
   * the ability to write, not gain the ability to write unauthorized.
   */
  slotAuthorization?: SlotAuthorizationService;
  /**
   * step OFFER — the per-conversation memory of the hueco currently on the
   * table (`src/services/voiceOfferStore.ts`).
   *
   * Defaults to a fresh in-memory store with the minimum TTL, which is the
   * fail-closed direction for a directly-constructed service: it remembers
   * only what THIS instance offered, so a caller that forgot to wire the real
   * one cannot accidentally authorize a hueco somebody else published.
   */
  offerStore?: VoiceOfferStore;
  /**
   * Where a refused booking is recorded for an operator. Optional so the
   * existing unit-level constructions stay silent; `src/services/container.ts`
   * supplies the app logger.
   *
   * It is handed a REASON and a conversation id and nothing else — never the
   * token, never a fragment of it, and never the customer's data. A log line
   * that carried the token would hand a reader a bearer credential for
   * someone's appointment.
   */
  logger?: { warn: (detail: Record<string, unknown>, message: string) => void };
  /**
   * BALANCED V2 ((internal doc, not included in the template) ADR-020) — the per-conversation queue that
   * makes {@link gateAgainst} atomic.
   *
   * Optional, and defaulting to a private instance, so every existing
   * construction behaves exactly as it did. `src/services/container.ts` passes
   * ONE shared instance to both this service and the balanced-V2 one, because
   * they also share the idempotency journal. See
   * `src/utils/conversationSerializer.ts`.
   */
  serializer?: ConversationSerializer;
  /**
   * The total time budget for one write, from `BALANCED_BOOK_DEADLINE_MS`.
   *
   * Optional, and undefined by default, so a directly-constructed service
   * (every existing test, and the V1 `/ai/voice/book` instance in
   * `src/services/container.ts`) behaves exactly as before: the write is
   * simply awaited, however long it takes.
   *
   * When set, {@link performBook} races the upstream write against a timer
   * of this length. Losing the race does not cancel the write — it keeps
   * running, and its eventual outcome still lands in the durable journal —
   * it only means THIS caller is answered `uncertain` rather than kept
   * waiting past ElevenLabs' own 8 s tool timeout.
   */
  bookDeadlineMs?: number;
  /**
   * Where a confirmed appointment's WhatsApp confirmation is QUEUED —
   * `src/services/whatsapp/whatsappNotifier.ts`.
   *
   * Optional, and absent by default, so every existing construction (and
   * every deployment that has not configured `WHATSAPP_NOTIFICATIONS_MODE`)
   * behaves exactly as it did: no queue, no field, no new failure mode.
   *
   * The seam is one method that CANNOT throw and does no I/O beyond one
   * fsynced append. That is not a coincidence, it is the requirement: a
   * booking must never fail, change shape or slow down because of a
   * notification. See the interface's own documentation.
   */
  whatsapp?: WhatsAppConfirmationSink;
  /**
   * ADR-031 addendum — what {@link VoiceBookResult.calendar_url} is minted
   * with: the calendar secret and base URL, and the SAME employee-name
   * directory the WhatsApp notifier reads. Optional and absent by default, so
   * every existing construction answers exactly as before. Wired by
   * `src/services/container.ts` only when both calendar env vars are set.
   */
  calendarLink?: {
    config: CalendarLinkConfig;
    employeeNames?: EmployeeNameDirectory;
  };
  /**
   * 2026-10-10 — the same directory, for {@link VoiceBookResult.employee_name}.
   * Absent = no field. Only the balanced V2 service is wired with it.
   */
  employeeNames?: EmployeeNameDirectory;
  /**
   * 2026-10-08 — `VOICE_CHANGE_BOOKING_ENABLED` (default false). Off: every
   * `replaces_booking_number` is answered `change_not_available` with nothing
   * written. The duplicate net works either way.
   */
  changeEnabled?: boolean;
  /**
   * 2026-10-09 — `VOICE_CALLER_ID_PHONE_ENABLED` (default false). Off:
   * {@link VoiceBookOptions.callerPhone} is ignored and every create behaves
   * exactly as before.
   */
  callerIdPhoneEnabled?: boolean;
  /** 2026-10-08 — see {@link VoiceChangeCanceller}. Absent = no change possible. */
  changeCanceller?: VoiceChangeCanceller;
  /** Tests only: overrides {@link CHANGE_TOTAL_BUDGET_MS}. */
  changeBudgetMs?: number;
  /** 2026-10-10 — see {@link VoiceExistingBookingsPort}. Absent = no change of an existing booking. */
  existingBookings?: VoiceExistingBookingsPort;
  /**
   * 2026-10-09 — `MAX_FUTURE_BOOKINGS_PER_PHONE`. Absent (0, or no agenda
   * reader) = no limit, and every create behaves exactly as before.
   */
  phoneBookingLimit?: PhoneBookingLimitPort;
}

function datesInclusive(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const out: string[] = [];
  for (let value = start; value <= end; value += DAY_MS) {
    out.push(new Date(value).toISOString().slice(0, 10));
  }
  return out;
}

function minutesOf(start: string): number {
  const [hours, minutes] = timeLabelFromString(start).split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function preferredMinutes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function periodMatches(start: string, period: VoiceAvailabilityInput["time_period"]): boolean {
  if (period === "any") return true;
  const minutes = minutesOf(start);
  return period === "morning" ? minutes < 14 * 60 : minutes >= 14 * 60;
}

function projectSlot(slot: SlotOut): VoiceAvailabilitySlot {
  return {
    reservation_date: slot.start,
    date: slot.start.slice(0, 10),
    time: slot.label,
    ...(slot.employeeId !== undefined ? { employee_id: slot.employeeId } : {}),
    ...(slot.employeeName !== undefined ? { employee_name: slot.employeeName.trim() } : {}),
  };
}

/**
 * The sentence the agent speaks when it has options.
 *
 * Two things this wording is carefully doing, both required by step LAT
 * objective 2:
 *
 * 1. It says "los primeros", never "los únicos". The tool returns at most
 *    three slots (`max_slots` is capped at 3 by the schema), and a caller told
 *    "tengo estos tres huecos" reasonably concludes the salon has three free
 *    hours all week. Almost always untrue, and it is the kind of untrue that
 *    ends a call early.
 * 2. It offers the way out explicitly — "puedo mirar más horarios" — so
 *    declining all three is an obvious, invited move rather than a dead end.
 */
function availabilityMessage(slots: readonly VoiceAvailabilitySlot[]): string {
  if (slots.length === 0) {
    return "Lo siento, no encuentro ningún hueco en ese intervalo. ¿Quieres que mire otras fechas?";
  }
  const options = slots.map((slot) => fullPhraseEs(slot.reservation_date));
  if (options.length === 1) {
    return `Te puedo ofrecer ${options[0]}. Si no te encaja, puedo mirar más horarios. ¿Te viene bien?`;
  }
  const joined = `${options.slice(0, -1).join(", ")} y ${options.at(-1)}`;
  const count = options.length === 2 ? "dos" : "tres";
  return `Tengo estos ${count} primeros huecos: ${joined}. Si ninguno te encaja, puedo mirar más horarios. ¿Cuál prefieres?`;
}

/**
 * The command fingerprint, over the EFFECTIVE booking rather than the request
 * body.
 *
 * That change matters now that the hour, the barber and the service arrive
 * inside an opaque token. Fingerprinting the raw body would hash the token
 * string, and a token is freshly encrypted with a random IV on every
 * availability call — so two identical retries of the same hueco would
 * fingerprint DIFFERENTLY and the replay branch of the write gate would never
 * fire. Hashing the opened grant restores the property the gate depends on:
 * the same appointment produces the same fingerprint, and a different
 * appointment does not.
 *
 * The fields are serialized as a fixed-length ARRAY, in a fixed order,
 * rather than as a free-form object: an omitted optional key must not be
 * able to change the hash depending on how the object was constructed, and
 * a JSON array both escapes the separator and keeps `"Ana B" + "C"`
 * distinct from `"Ana" + "B C"`.
 */
function fingerprint(booking: EffectiveBooking, key: string): string {
  const canonical = JSON.stringify([
    booking.conversationId,
    booking.customerName,
    booking.customerSurnames,
    booking.phone,
    booking.reservationDate,
    booking.employeeId ?? null,
    booking.serviceId,
  ]);
  return createHmac("sha256", key).update(canonical).digest("hex");
}

/** Lowercase, no diacritics, punctuation and spaces folded: comparison only. */
function foldIdentity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * 2026-10-08 — the journal facts of one voice booking (see
 * {@link BookingJournalMeta}). Two keyed HMACs instead of the phone and the
 * name, so the durable journal still holds no personal data.
 */
function journalMetaOf(booking: EffectiveBooking, key: string): BookingJournalMeta {
  const mac = (parts: unknown[]): string =>
    createHmac("sha256", key).update(JSON.stringify(parts)).digest("hex");
  return {
    at: booking.reservationDate,
    ...(booking.employeeId !== undefined ? { emp: booking.employeeId } : {}),
    ph: mac(["ph", booking.phone]),
    who: mac([
      "who",
      foldIdentity(booking.customerName),
      foldIdentity(booking.customerSurnames),
      booking.phone,
    ]),
    // 2026-10-10 (call pp3x4v): first given name + phone, so a change sent
    // with different surnames is still caught by the duplicate net.
    fn: mac(["fn", foldIdentity(booking.customerName).split(" ")[0] ?? "", booking.phone]),
  };
}

/** `YYYY-MM-DD HH:mm` of a grant's `reservationDate`, the dashboard's shape. */
export function wallMinute(reservationDate: string): string {
  return reservationDate.replace("T", " ").slice(0, 16);
}

/** What a change replaces: a booking of this call, or an existing one (2026-10-10). */
type ChangeOld =
  | {
      kind: "call";
      number: number;
      reported: number;
      record: IdempotencyRecord<VoiceBookResult>;
      meta: BookingJournalMeta;
    }
  | {
      kind: "existing";
      /** `booking_index` of this call's listing. */
      index: number;
      reservationId: number;
      /** `YYYY-MM-DD HH:mm`, from the agenda read. */
      at: string;
      phoneE164: string;
      xr: string;
      /** Plan B: the listing came from a dictated phone. */
      dictated?: boolean;
    };

/** Per-request context of the multi-booking gate. */
interface MultiContext {
  /** Not the WhatsApp channel: changes and the duplicate net apply. */
  voice: boolean;
  /** See {@link VoiceBookOptions.replacesBookingNumber}. */
  replaces?: number;
  /** See {@link VoiceBookOptions.replacesExisting}. */
  replacesExisting?: number;
  /** Request start, real clock: the change budget is measured from here. */
  startedAtMs: number;
}

/**
 * *** THE WRITE GATE, as a pure function of what the journal already holds. ***
 *
 * Returns the answer to give WITHOUT writing, or `undefined` when — and only
 * when — this command has earned the right to reach the salon's API.
 *
 * step CTL-4 narrowed exactly one branch of this, and the narrowing is the
 * whole point of the fix. Phase 3 let ANY different command through after a
 * `rejected` state, on the reasoning that a rejection proves nothing was
 * written. That reasoning is sound about the appointment and wrong about the
 * conversation: after a generic HTTP 400 the model can change the phone, the
 * surname or the date and hit the origin again, and again, inside one call —
 * which is a slower version of the eleven-second loop of 2026-08-30, not a
 * fix for it. A generic 400 tells us the request was refused; it tells us
 * NOTHING about whether a differently-shaped one would be.
 *
 * So a rejection reopens the gate only when it is specifically
 * `slot_taken` — the one refusal whose meaning we actually know: that hour is
 * gone, nothing was created, and the legitimate next move is a different
 * hour. Everything else (`upstream_error` and the generic 4xx behind it,
 * `write_disabled`, `not_confirmed`, `misconfigured_owner`) is final for the
 * rest of the call.
 *
 * Note what this deliberately does NOT do: it never invents a new `outcome`.
 * A blocked follow-up replays the refusal already stored, so the agent sees a
 * value its prompt and edge conditions already know how to route. Adding a
 * new outcome string here would require an ElevenLabs change to be safe, and
 * the middleware must not depend on one.
 */
function gateAgainst(
  record: IdempotencyRecord<VoiceBookResult>,
  key: string,
): VoiceBookResult | undefined {
  // A record written before phase 3 carries no state and, by construction,
  // can only be a success — that was the only thing the old store kept.
  const state: IdempotencyState = record.state ?? "confirmed";

  // Same command, whatever its fate: replay it. Nothing leaves the process,
  // so hammering the tool is free.
  if (record.fingerprint === key) {
    return { ...record.result, idempotency_status: "replayed" };
  }

  // From here on the command genuinely differs from the one already
  // attempted in this call.
  if (state === "confirmed") return ALREADY_BOOKED_RESULT;
  if (state === "uncertain" || state === "started") {
    // We do not know whether the first write landed, so a second appointment
    // could duplicate a real one. Never reopened, by any payload.
    return { ...UNCERTAIN_RESULT, idempotency_status: "replayed" };
  }

  // state === "rejected" — consult the OUTCOME, not just the state.
  if (record.result.outcome === "slot_taken") return undefined;
  return { ...record.result, idempotency_status: "replayed" };
}

/**
 * ElevenLabs-facing façade. It deliberately returns no reservation id or
 * customer data: the model only learns whether the write succeeded and the
 * short Spanish sentence it may speak.
 */
export class VoiceBookingService {
  /**
   * Completed bookings, keyed by conversation. Durable when a store is
   * injected; see `src/services/bookingIdempotencyStore.ts` for why that
   * matters the moment creation is armed.
   */
  private readonly completedByConversation: BookingIdempotencyStore<VoiceBookResult>;
  /**
   * One booking attempt at a time, per conversation.
   *
   * step CTL-4. This used to key on the FINGERPRINT, which deduplicated two
   * identical simultaneous commands and did nothing at all about two
   * different ones: both would find an empty journal, both would pass the
   * gate, and both would write. ElevenLabs fires tool calls roughly two
   * seconds apart against an origin that answers in about one, so the
   * overlap is narrow but entirely reachable — and the gate above is only
   * meaningful if nothing can slip past it while it is deciding.
   *
   * Keying on the CONVERSATION closes that: the second request waits for the
   * first to finish, then re-reads the journal and is judged against a record
   * that now exists. Deliberately NOT persisted — it holds in-flight
   * promises, which belong to this process and mean nothing to another; a
   * restart cancels the request anyway and the durable store is what makes
   * the retry safe.
   */
  private readonly serializer: ConversationSerializer;
  private readonly fingerprintKey: string;
  /** How many dates of one availability question may be in flight at once. */
  private readonly dateConcurrency: number;
  /**
   * The AI marker for the agenda. Read once at construction from
   * configuration and never from a request, so nothing an ElevenLabs tool
   * call carries can change, suppress or forge it.
   */
  private readonly displayPrefix: string;
  /**
   * step SLOT — the only thing in this process that can mint or open a slot
   * token. Read once at construction, exactly like `displayPrefix` and for
   * the same reason: nothing a tool call carries may influence it.
   */
  private readonly slotAuthorization: SlotAuthorizationService;
  /**
   * step OFFER — which hueco each live conversation is currently holding.
   * The crypto layer above answers "did we ever issue this"; this one answers
   * "is this the one we are offering right now", and a booking needs both.
   */
  private readonly offerStore: VoiceOfferStore;
  private readonly logger?: VoiceBookingDeps["logger"];
  /** See {@link VoiceBookingDeps.bookDeadlineMs}. `undefined` = unbounded. */
  private readonly bookDeadlineMs?: number;
  /** See {@link VoiceBookingDeps.whatsapp}. `undefined` = no notifications. */
  private readonly whatsapp?: WhatsAppConfirmationSink;
  /** See {@link VoiceBookingDeps.calendarLink}. `undefined` = never a link. */
  private readonly calendarLink?: VoiceBookingDeps["calendarLink"];
  /** 2026-10-10 — see {@link VoiceBookingDeps.employeeNames}. */
  private readonly employeeNames?: EmployeeNameDirectory;
  /** 2026-10-08 — see {@link VoiceBookingDeps.changeEnabled}. */
  private readonly changeEnabled: boolean;
  private readonly callerIdPhoneEnabled: boolean;
  private readonly changeCanceller?: VoiceChangeCanceller;
  private readonly existingBookings?: VoiceExistingBookingsPort;
  private readonly phoneBookingLimit?: PhoneBookingLimitPort;
  private readonly changeBudgetMs: number;

  constructor(
    private readonly availability: AvailabilityService,
    private readonly booking: BookingService,
    deps: VoiceBookingDeps = {},
  ) {
    this.completedByConversation = deps.store ?? new MemoryBookingIdempotencyStore<VoiceBookResult>();
    this.fingerprintKey = deps.fingerprintKey ?? randomBytes(32).toString("hex");
    this.dateConcurrency = deps.dateConcurrency ?? 3;
    this.displayPrefix = deps.displayPrefix ?? "";
    // No secret => disabled => every booking is refused. The fail-closed
    // default is the whole reason this is not `deps.slotAuthorization!`.
    this.slotAuthorization =
      deps.slotAuthorization ??
      // No secret => disabled. The TTL is a valid one purely so the
      // constructor's own bounds check passes: a disabled service never
      // issues anything for it to apply to.
      new SlotAuthorizationService({ ttlSeconds: SLOT_TOKEN_TTL_MIN_SECONDS });
    this.offerStore =
      deps.offerStore ??
      new MemoryVoiceOfferStore({
        ttlSeconds: VOICE_OFFER_TTL_MIN_SECONDS,
        maxEntries: 1000,
      });
    this.serializer = deps.serializer ?? new ConversationSerializer();
    this.logger = deps.logger;
    this.bookDeadlineMs = deps.bookDeadlineMs;
    this.whatsapp = deps.whatsapp;
    this.calendarLink = deps.calendarLink;
    this.employeeNames = deps.employeeNames;
    this.changeEnabled = deps.changeEnabled ?? false;
    this.callerIdPhoneEnabled = deps.callerIdPhoneEnabled ?? false;
    this.changeCanceller = deps.changeCanceller;
    this.existingBookings = deps.existingBookings;
    this.phoneBookingLimit = deps.phoneBookingLimit;
    this.changeBudgetMs = deps.changeBudgetMs ?? CHANGE_TOTAL_BUDGET_MS;
  }

  /**
   * The offer memory this service is using.
   *
   * Exposed as an in-process handle — never over HTTP — so a composition root
   * can report on it and so a test can arrange the state a real availability
   * call would have left, exactly as `tests/helpers/slotToken.ts` already
   * mints real tokens with the production authorization service. Nothing in
   * `src/routes/` reads it.
   */
  get offers(): VoiceOfferStore {
    return this.offerStore;
  }

  /** True when a container restart cannot lose a recorded booking. */
  get idempotencyIsDurable(): boolean {
    return this.completedByConversation.durable;
  }

  /**
   * True when `/ai/voice/availability` can mint slot tokens, and therefore
   * when `/ai/voice/book` can accept any booking at all. Exposed so a
   * composition root can warn about the fail-closed posture at boot rather
   * than letting it be discovered mid-call.
   */
  get slotAuthorizationIsArmed(): boolean {
    return this.slotAuthorization.enabled;
  }

  async findAvailability(
    input: VoiceAvailabilityInput,
    nowMs: number = Date.now(),
  ): Promise<VoiceAvailabilityResult> {
    const dates = datesInclusive(input.date_from, input.date_to);
    const conversationId = input.conversation_id;

    // *** step OFFER — THE PREVIOUS OFFER DIES HERE, BEFORE THE AGENDA IS
    // *** EVEN READ.
    //
    // Not after the answer comes back. The window this closes is the one an
    // agent actually falls into: it asks for other hours, the read takes a
    // second, and while it waits it books the hour it was offered a minute
    // ago — with a token that is genuine, unexpired, and no longer an offer.
    // Invalidating on the way IN makes that impossible for the whole duration
    // of the question, which is exactly when the agent is most likely to try.
    //
    // The generation is the compare-and-set handle: this answer may only
    // publish if no newer question has started meanwhile.
    const generation = this.offerStore.beginRefresh(conversationId, nowMs);

    // step LAT: the dates used to be walked with `for … await`, so a 7-day
    // question paid seven round trips end to end even though the days are
    // completely independent of one another. They now run concurrently, with
    // the fan-out width bounded by `dateConcurrency` and the actual number of
    // simultaneous upstream requests bounded — globally, refresher included —
    // by the shared `PriorityLimiter`. A cache hit costs no upstream call at
    // all, so on the warm path this loop makes zero requests whatever its
    // width.
    let perDate: Awaited<ReturnType<AvailabilityService["getAvailability"]>>[];
    try {
      perDate = await mapWithConcurrency(dates, this.dateConcurrency, (date) =>
        this.availability.getAvailability({
          date,
          typeReservation: String(input.service_id),
          ...(input.employee_id !== undefined ? { employeeId: input.employee_id } : {}),
          ...(input.preferred_time !== undefined ? { preferredTime: input.preferred_time } : {}),
          maxSlots: 20,
        }),
      );
    } catch (error) {
      // A failed question leaves the conversation with NOTHING bookable — the
      // previous offer stays invalidated, because the one thing we know is
      // that we no longer know what is free. `/ai/routes/ai.ts` still turns
      // this into a degraded HTTP 200 for the agent; what must not happen is
      // that the degradation silently restores the last hueco.
      this.offerStore.publishEmpty(conversationId, generation, nowMs);
      throw error;
    }

    const candidates: SlotOut[] = [];
    for (const result of perDate) {
      candidates.push(...result.slots.filter((slot) => periodMatches(slot.start, input.time_period)));
    }

    const target = preferredMinutes(input.preferred_time);
    const ranked = candidates.sort((a, b) => {
      const dateOrder = a.start.slice(0, 10).localeCompare(b.start.slice(0, 10));
      if (dateOrder !== 0) return dateOrder;
      if (target !== undefined) {
        const distance = Math.abs(minutesOf(a.start) - target) - Math.abs(minutesOf(b.start) - target);
        if (distance !== 0) return distance;
      }
      return a.start.localeCompare(b.start);
    });
    // Pick by caller preference, then speak the chosen set chronologically.
    //
    // step SLOT: the token is attached HERE, at the last step, to the slots
    // actually being offered — not to every candidate considered. A token is
    // permission to book a specific hour in this specific call, so minting one
    // for an hour the caller is never told about would hand out authorizations
    // nobody asked for and widen the window for nothing.
    const slots = ranked
      .slice(0, input.max_slots)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((slot) => this.authorizeSlot(projectSlot(slot), input, nowMs));

    // *** ONLY THE TOKENS THIS GENERATION ACTUALLY PUBLISHED. ***
    //
    // `authorizeSlot` returns the slot untouched when the authorization
    // service is disabled or the date could not be sealed, so an offer with no
    // tokens is a real possibility and it means the same thing as no slots at
    // all: nothing here can be booked. Both land on `empty`, which refuses.
    //
    // The compare-and-set is what makes a slow answer harmless. If a newer
    // question has already started, this returns false and the newer
    // generation stands — an old answer can never resurrect an old hueco.
    const offered = slots
      .map((slot) => slot.slot_token)
      .filter((token): token is string => typeof token === "string");
    if (offered.length === 0) {
      this.offerStore.publishEmpty(conversationId, generation, nowMs);
    } else {
      this.offerStore.publishOffered(conversationId, generation, offered, nowMs);
    }

    return {
      available: slots.length > 0,
      message: availabilityMessage(slots),
      slots,
      external_mutation: false,
    };
  }

  /**
   * *** ONE CONFIRMED ATTEMPT, AT MOST ONE WRITE. ***
   *
   * What this method defends against is not hypothetical: on 2026-08-30
   * ElevenLabs invoked the booking tool eight times in sixteen seconds for
   * one successful appointment, and four times in eleven seconds for one that
   * upstream refused. The successes were absorbed by the old success-only
   * memory; the four refusals all reached the salon's API, because a failure
   * left nothing to replay.
   *
   * Two mechanisms, and both are needed:
   *
   * 1. {@link gateAgainst} decides, from the durable journal, whether this
   *    command may write at all. Read its comment — it holds the actual rule.
   * 2. `serialize()` guarantees the gate is never consulted by two requests
   *    of the same conversation at once, so a decision cannot be made against
   *    a journal that a sibling request is in the middle of writing.
   *
   * Note what is deliberately absent: any retry of our own. The middleware
   * never re-sends a write. `/ai/voice/book` also answers 200 for every
   * outcome (`src/routes/ai.ts`) so the provider does not see a tool error and
   * retry the transport underneath us.
   *
   * *** step SLOT adds a THIRD mechanism, and it runs first. ***
   *
   * Before the journal is read, before `serialize()` is even entered, the
   * request must produce a slot this middleware itself issued, a customer
   * identity that is not obvious filler, and an explicit confirmation. All
   * three checks are pure — no upstream call, no journal write, no state of
   * any kind — which is what makes it safe for them to run outside the
   * serialization: two simultaneous unauthorized requests are simply two
   * refusals.
   *
   * Running them BEFORE the journal is not an optimization. A rejection here
   * must not consume the conversation's single write, because the correct
   * recovery is for the agent to go back to `booking_check_availability` and
   * return with a real token — and that recovery is only available if the
   * gate is still closed behind it, untouched.
   *
   * *** AND ALL THREE ANSWER HTTP 200 (audit finding, 2026-08-30). ***
   *
   * These used to be Zod failures, which is to say HTTP 400, which is to say
   * a TOOL ERROR that ElevenLabs retries — the exact mechanism that turned
   * one booking into four. Validating in the service instead of in the schema
   * is what lets a mistranscribed phone or a forgotten confirmation flag come
   * back as a deterministic outcome the agent's prompt knows how to route.
   *
   * The ORDER matters when more than one is wrong, because only one answer
   * can be given. The token comes first because its recovery subsumes the
   * others: an agent sent back to re-check availability has to re-offer and
   * re-confirm anyway, so telling it about a missing confirmation on a
   * booking whose hueco was never authorized would be answering the smaller
   * question.
   */
  async book(
    input: VoiceBookInput,
    headers: IncomingHeaders,
    nowMs: number,
    options: VoiceBookOptions = {},
  ): Promise<VoiceBookResult> {
    // V5 (ADR-025): the limit comes from the request's profile, resolved by the
    // route from validated config. An out-of-range value is a programming
    // error, refused before anything is read or written.
    const maxBookingsPerCall = options.maxBookingsPerCall ?? 1;
    assertBookingsPerCall(maxBookingsPerCall, "VoiceBookingService.book");

    // ── 1. The hueco ───────────────────────────────────────────────────────
    const conversationId = readTrimmedString(
      input.conversation_id,
      CONVERSATION_ID_MAX_LENGTH,
    );
    const slotToken = readTrimmedString(input.slot_token, SLOT_TOKEN_MAX_LENGTH);

    if (
      conversationId === undefined ||
      conversationId.length < CONVERSATION_ID_MIN_LENGTH ||
      !CONVERSATION_ID_RE.test(conversationId) ||
      slotToken === undefined
    ) {
      // No usable conversation id means no token could ever have been sealed
      // for it, and no token at all means the same thing more directly. Both
      // are `invalid_slot_token`: from the agent's side there is one fact —
      // this hueco was never authorized — and one recovery.
      this.logger?.warn(
        {
          conversation_id: conversationId ?? "<absent-or-invalid>",
          slot_token_failure: slotToken === undefined ? "absent" : "no_conversation_id",
        },
        "voice booking refused: no slot token to authorize this hueco",
      );
      return refusal("invalid_slot_token", SLOT_NOT_AUTHORIZED_MESSAGE);
    }

    const verification = this.slotAuthorization.verify(slotToken, conversationId, nowMs);
    if (!verification.ok) {
      // The conversation id is an ElevenLabs identifier, not customer data,
      // and it is what an operator needs to find the call. The token itself
      // is NEVER logged, in whole or in part: it is a bearer credential for
      // somebody's appointment.
      this.logger?.warn(
        { conversation_id: conversationId, slot_token_failure: verification.failure },
        "voice booking refused: slot token did not authorize this hueco",
      );
      return slotFailureResult(verification.failure);
    }

    // *** 2026-10-09 (escaneo, hallazgo 1): THE HOUR READ ALOUD IS THE HOUR BOOKED. ***
    //
    // A lock that fails keeps the PREVIOUS lock bookable on purpose, and the
    // platform only stores the token of a lock that succeeded. A model that
    // misses the failure reads the summary with the new hour and creates with
    // the old token. When the create says which hour it confirms, the token's
    // hour must be that one; otherwise nothing is created and the answer says
    // both hours. Before the journal and before any I/O: costs no write budget.
    const expected = readExpectedOption({
      optionTime: options.optionTime,
      optionDate: options.optionDate,
    });
    if (expected !== undefined) {
      const locked = {
        date: verification.grant.reservationDate.slice(0, 10),
        time: verification.grant.reservationDate.slice(11, 16),
      };
      const timeDiffers = expected.time !== undefined && expected.time !== locked.time;
      const dateDiffers = expected.date !== undefined && expected.date !== locked.date;
      if (timeDiffers || dateDiffers) {
        // The conversation id and which part differs; no hour in the log.
        this.logger?.warn(
          {
            conversation_id: conversationId,
            time_mismatch: timeDiffers,
            date_mismatch: dateDiffers,
          },
          "voice booking refused: option_time/option_date differ from the locked slot",
        );
        return {
          ...refusal("slot_time_mismatch", balancedBookTimeMismatchMessage(locked, expected)),
          locked_time: locked.time,
          locked_date: locked.date,
          ...(expected.time !== undefined ? { requested_time: expected.time } : {}),
          ...(expected.date !== undefined ? { requested_date: expected.date } : {}),
        };
      }
    }

    // The SECOND half of the hueco question — "is this the one on the table
    // right now" — is asked in {@link attempt}, immediately before the write
    // and after the journal. See the comment there for why that is the right
    // place and not this one.

    // ── 2. The customer ────────────────────────────────────────────────────
    //
    // 2026-10-09 (`VOICE_CALLER_ID_PHONE_ENABLED`, voice only): a create
    // without a dictated phone may use the number the call comes from. The
    // resolved phone then goes through the SAME identity check, fingerprint,
    // duplicate net and change ownership as a dictated one — nothing below
    // knows where it came from. Flag off or WhatsApp: `input.phone` as always.
    let phoneInput: unknown = input.phone;
    // 2026-10-10 plan B: a change of an EXISTING booking without a dictated
    // phone keeps that booking's phone (the number of the listing this call
    // was authorized for: its caller id, or a dictated one with the name).
    const changeOf =
      !isWhatsAppChannel(headers) &&
      Number.isInteger(options.replacesExisting) &&
      (options.replacesExisting ?? 0) >= 1 &&
      this.existingBookings !== undefined &&
      // `phone` absent or a caller marker («caller»), never a dictated one.
      resolveCallerPhone(input.phone, undefined).kind === "unavailable"
        ? this.existingBookings.resolveForChange(conversationId, options.replacesExisting as number, nowMs)
        : undefined;
    const listedPhone =
      changeOf?.ok === true ? normalizeSpanishPhone(changeOf.phoneE164) : undefined;
    if (listedPhone?.ok === true) {
      phoneInput = listedPhone.national;
      this.logger?.warn(
        { conversation_id: conversationId, phone_source: "existing_booking" },
        "voice change: using the phone of the booking being changed",
      );
    } else if (this.callerIdPhoneEnabled && !isWhatsAppChannel(headers)) {
      const resolved = resolveCallerPhone(input.phone, options.callerPhone);
      if (resolved.kind === "unavailable") {
        // The reason only; never the number.
        this.logger?.warn(
          { conversation_id: conversationId, caller_phone_unavailable: resolved.reason },
          "voice booking refused: asked to use the caller's number, but the call carries no Spanish mobile",
        );
        return refusal("invalid_customer_data", CALLER_PHONE_UNAVAILABLE_MESSAGE);
      }
      if (resolved.kind === "caller") {
        phoneInput = resolved.phone;
        this.logger?.warn(
          { conversation_id: conversationId, phone_source: "caller_id" },
          "voice booking: using the caller's number as the booking phone",
        );
      }
    }
    const identity = readCustomerIdentity({
      name: input.customer_name,
      surnames: input.customer_surnames,
      phone: phoneInput,
    });
    if (!identity.ok) {
      // The REASON, never the value. Logging the rejected name would put the
      // very PII this refusal exists around into a log line, and the reason
      // is the whole diagnostic: `placeholder_name` says the agent never
      // asked, which is the finding.
      this.logger?.warn(
        { conversation_id: conversationId, identity_rejection: identity.rejection },
        "voice booking refused: customer identity is missing, malformed, trivial or a known placeholder",
      );
      return this.identityRejectionResult(identity.rejection, headers);
    }

    // ── 3. The consent ─────────────────────────────────────────────────────
    //
    // Strict `!== true`, so `"true"`, `1`, `"yes"` and absent are all refused.
    // `BookingService.book()` re-checks the same gate as defence in depth;
    // this copy exists so the refusal lands BEFORE the journal is written,
    // which the deeper one cannot do.
    if (input.confirmed_by_customer !== true) {
      this.logger?.warn(
        { conversation_id: conversationId },
        "voice booking refused: no explicit customer confirmation",
      );
      return refusal("not_confirmed", NEEDS_CONFIRMATION_MESSAGE);
    }

    const effective = this.effectiveBooking(
      conversationId,
      identity.identity,
      verification.grant,
    );
    const startedAtMs = Date.now();
    const voice = !isWhatsAppChannel(headers);
    const replaces =
      voice && Number.isInteger(options.replacesBookingNumber) && (options.replacesBookingNumber ?? -1) >= 0
        ? options.replacesBookingNumber
        : undefined;
    const replacesExisting =
      voice &&
      !(replaces !== undefined && replaces > 0) &&
      Number.isInteger(options.replacesExisting) &&
      (options.replacesExisting ?? 0) >= 1
        ? options.replacesExisting
        : undefined;
    return this.serialize(conversationId, () =>
      this.attempt(effective, slotToken, headers, nowMs, maxBookingsPerCall, {
        voice,
        ...(replaces !== undefined ? { replaces } : {}),
        ...(replacesExisting !== undefined ? { replacesExisting } : {}),
        startedAtMs,
      }),
    );
  }

  /** Gate, then — only if the gate allows — write. Never runs concurrently
   * with itself for the same conversation. */
  private async attempt(
    booking: EffectiveBooking,
    slotToken: string,
    headers: IncomingHeaders,
    nowMs: number,
    maxBookingsPerCall: number,
    ctx: MultiContext,
  ): Promise<VoiceBookResult> {
    const key = fingerprint(booking, this.fingerprintKey);
    const record = this.completedByConversation.get(booking.conversationId, nowMs);
    // V5 (ADR-025): the limit is the CREATE request's. A conversation whose
    // first appointment was made under the one-write rule (a V4 or V1 request:
    // its confirmed answer carries no `booking_number`) stays closed under
    // that rule, whatever a later request claims to be.
    const bookedUnderOneWriteRule =
      record !== undefined &&
      (record.state ?? "confirmed") === "confirmed" &&
      record.result.booking_number === undefined;
    if (maxBookingsPerCall > 1 && !bookedUnderOneWriteRule) {
      return this.attemptMulti(booking, slotToken, headers, nowMs, key, maxBookingsPerCall, ctx);
    }
    if (record !== undefined) {
      const withoutWriting = gateAgainst(record, key);
      if (withoutWriting !== undefined) return withoutWriting;
    }
    // 2026-10-08: a change needs the multi-booking journal; one booking per
    // call has nothing to change. Refused before anything is written.
    if ((ctx.replaces !== undefined && ctx.replaces > 0) || ctx.replacesExisting !== undefined) {
      return refusal("change_not_available", balancedChangeNotAvailableMessage("unavailable"));
    }

    // *** step OFFER — THE HUECO MUST BE THE ONE CURRENTLY ON THE TABLE. ***
    //
    // The crypto check in `book()` proved the token is authentic, unexpired,
    // and sealed for THIS conversation. It could not prove the hueco is the
    // one being offered right now, because a token carries no state: after a
    // second availability question, BOTH the old and the new token verify,
    // for the rest of the old one's lifetime. This is the question that
    // needs memory, and `src/services/voiceOfferStore.ts` is the memory.
    //
    // *** WHY HERE AND NOT AT THE TOP OF `book()`. ***
    //
    // Because this authorizes a NEW WRITE, and only a new write. Everything
    // above has already been decided without one: an exact replay of a
    // command the journal already holds is answered from the journal, which
    // is what makes the durable idempotency of ADR-014 survive a restart. Had
    // this run first, a process that restarted between a confirmed booking
    // and the agent's identical retry two seconds later would answer
    // `slot_not_authorized` — sending the agent back to re-check availability
    // for an appointment that already exists, which is both wrong and the one
    // instruction most likely to produce a second one.
    //
    // What it costs is nothing that matters: this line is still BEFORE the
    // journal is written, BEFORE `BookingService` is called, and therefore
    // before a single byte reaches the salon's API. A refusal here consumes
    // no part of the conversation's one-write budget, exactly like the
    // refusals in `book()`.
    const offer = this.offerStore.authorizes(booking.conversationId, slotToken, nowMs);
    if (!offer.ok) {
      // The reason and the conversation id. Never the token, never a fragment
      // of it, never the digest — and never the customer's data.
      this.logger?.warn(
        { conversation_id: booking.conversationId, offer_refusal: offer.refusal },
        "voice booking refused: this hueco is not the one currently offered in this conversation",
      );
      return refusal("slot_not_authorized", SLOT_NOT_AUTHORIZED_MESSAGE);
    }

    const limit = await this.checkPhoneLimit(booking, headers, nowMs);
    if (limit.refusal !== undefined) return limit.refusal;

    return this.performBook(
      booking,
      slotToken,
      headers,
      nowMs,
      key,
      {
        journalId: booking.conversationId,
        number: 1,
        max: 1,
        terminal: true,
        reported: 1,
      },
      limit.spentMs,
    );
  }

  /**
   * 2026-10-09 — *** AT MOST N PENDING APPOINTMENTS PER PHONE. ***
   * (internal doc, not included in the template)
   *
   * Runs after every check that can refuse without I/O and immediately before
   * the write; never for a change (a change replaces, it does not add). The
   * phone is the one the booking will really carry (dictated, caller id, or
   * pinned), normalised like every other phone here. FAIL-OPEN: no limiter, a
   * phone that cannot be normalised, or an agenda that cannot be read in time
   * all let the booking through. `spentMs` is what the check waited, taken
   * off the write deadline.
   */
  private async checkPhoneLimit(
    booking: EffectiveBooking,
    headers: IncomingHeaders,
    nowMs: number,
  ): Promise<{ refusal?: VoiceBookResult; spentMs: number }> {
    const limiter = this.phoneBookingLimit;
    if (limiter === undefined) return { spentMs: 0 };
    const phoneE164 = this.limitPhoneOf(booking, headers, nowMs);
    if (phoneE164 === undefined) return { spentMs: 0 };
    let result: PhoneLimitCheck;
    try {
      result = await limiter.check(phoneE164);
    } catch {
      return { spentMs: 0 };
    }
    this.logger?.warn(
      {
        conversation_id: shortConversationId(booking.conversationId),
        phone_limit: result.decision,
        phone_limit_source: result.source,
        future_bookings: result.count,
        phone_limit_wait_ms: result.waitedMs,
      },
      "voice booking: pending appointments per phone checked",
    );
    if (result.decision !== "refuse") return { spentMs: result.waitedMs };
    const message = isWhatsAppChannel(headers)
      ? phoneBookingLimitWhatsAppMessage(limiter.max)
      : phoneBookingLimitVoiceMessage(limiter.max);
    return {
      refusal: {
        ...refusal("phone_booking_limit", message),
        max_future_bookings_per_phone: limiter.max,
      },
      spentMs: result.waitedMs,
    };
  }

  /** E.164 of the phone the write will carry, or undefined if not Spanish. */
  private limitPhoneOf(
    booking: EffectiveBooking,
    headers: IncomingHeaders,
    nowMs: number,
  ): string | undefined {
    try {
      const writer = this.booking as Partial<Pick<BookingService, "writtenOwnerPhone">>;
      const written =
        typeof writer.writtenOwnerPhone === "function"
          ? writer.writtenOwnerPhone.call(this.booking, booking.phone, headers, nowMs)
          : booking.phone;
      const normalized = normalizeSpanishPhone(written);
      return normalized.ok ? normalized.e164 : undefined;
    } catch {
      return undefined;
    }
  }

  /** Never throws: the limit must never fail a booking. */
  private markPhoneChanged(booking: EffectiveBooking, headers: IncomingHeaders, nowMs: number): void {
    const limiter = this.phoneBookingLimit;
    if (limiter === undefined) return;
    try {
      const phoneE164 = this.limitPhoneOf(booking, headers, nowMs);
      if (phoneE164 !== undefined) limiter.markChanged(phoneE164);
    } catch {
      // ignored on purpose
    }
  }

  /**
   * *** V5 — UP TO N CONFIRMED WRITES PER CALL, EACH ONE AT MOST ONCE. ***
   * ((internal doc, not included in the template) ADR-023; only reached when the REQUEST was granted
   * more than one booking per call — a V5 request, ADR-025.)
   *
   * The journal holds one sub-record per booking of the call —
   * {@link bookingJournalId} 1..N — and this method is {@link gateAgainst}
   * applied to that sequence rather than to a single record. Same serializer,
   * so the whole decision is still atomic per conversation. In order:
   *
   * 1. **An identical command, in ANY sub-record, is replayed.** That is what
   *    makes a retry of booking 2 after a timeout return booking 2's answer
   *    instead of creating booking 3: the fingerprint covers the opened grant
   *    and the identity, so the same appointment finds its own record.
   * 2. **The LAST occupied sub-record decides what a different command may
   *    do**, with the classic gate's rules unchanged:
   *    - `confirmed` → the next booking may be attempted, in the next
   *      sub-record — unless the call already has N, which is refused
   *      (`already_booked_in_call`, `booking_limit_reached: true`);
   *    - `started` / `uncertain` → refused as uncertain: nobody knows whether
   *      that booking exists, so no further booking may be layered on it;
   *    - `rejected` + `slot_taken` → the SAME booking may be attempted again,
   *      in the same sub-record (another hour for the same person);
   *    - any other rejection → final for the rest of the call.
   * 3. **The hueco must be the one on the table now** (ADR-019/022), and a
   *    token that already produced a confirmed booking never is: it is refused
   *    as `already_booked_in_call` with `booking_limit_reached: false`, so a
   *    token cannot book a second person by changing the name.
   *
   * Every refusal here happens before the journal is written and before any
   * upstream call, exactly like the one-booking path.
   */
  private async attemptMulti(
    booking: EffectiveBooking,
    slotToken: string,
    headers: IncomingHeaders,
    nowMs: number,
    key: string,
    max: number,
    ctx: MultiContext,
  ): Promise<VoiceBookResult> {
    // 2026-10-08: a voice call may also CHANGE bookings, each change taking a
    // journal record of its own, so its journal can hold up to
    // `max + MAX_CHANGES_PER_CALL` records. The WhatsApp channel keeps `max`.
    const cap = max + (ctx.voice ? MAX_CHANGES_PER_CALL : 0);
    const records: Array<IdempotencyRecord<VoiceBookResult> | undefined> = [];
    for (let number = 1; number <= cap; number += 1) {
      records.push(
        this.completedByConversation.get(bookingJournalId(booking.conversationId, number), nowMs),
      );
    }

    // 1. Identical command anywhere in the call: replay it. A booking that a
    //    change already replaced replays the CHANGE's answer — what is true
    //    now — never its own stale «confirmed».
    for (const record of records) {
      if (record !== undefined && record.fingerprint === key) {
        const by = record.meta?.by;
        const replacement = by !== undefined ? records[by - 1] : undefined;
        return { ...(replacement ?? record).result, idempotency_status: "replayed" };
      }
    }

    // 2. The last booking attempted in this call decides.
    let lastNumber = 0;
    records.forEach((record, index) => {
      if (record !== undefined) lastNumber = index + 1;
    });
    // Bookings of the call that still stand in the diary: confirmed, and not
    // replaced by a change whose cancellation SUCCEEDED. This, not the record
    // count, is what `max_bookings_per_call` limits — so a completed change
    // never counts as an extra booking, and an old booking that could not be
    // cancelled (or whose fate is unknown) still does.
    const active = records.filter(
      (record) =>
        record !== undefined &&
        (record.state ?? "confirmed") === "confirmed" &&
        !(record.meta?.by !== undefined && record.meta.cx === "cancelled"),
    ).length;
    const isChange = ctx.replaces !== undefined && ctx.replaces > 0;
    // 2026-10-08 review (b): `replaces_booking_number` names the booking_number
    // the agent was TOLD (`meta.n`), not the journal key. Among bookings not
    // yet replaced it is unique: a change keeps its booking's number, and a new
    // booking takes the count of standing bookings.
    const reportedOf = (record: IdempotencyRecord<VoiceBookResult>, index: number): number =>
      record.meta?.n ?? index + 1;
    const replaceable = (n: number) =>
      records
        .map((record, index) => ({ record, number: index + 1 }))
        .filter(
          (entry): entry is { record: IdempotencyRecord<VoiceBookResult>; number: number } =>
            entry.record !== undefined &&
            (entry.record.state ?? "confirmed") === "confirmed" &&
            entry.record.meta !== undefined &&
            reportedOf(entry.record, entry.number - 1) === n,
        );
    const candidates = isChange ? replaceable(ctx.replaces as number) : [];
    const oldEntry =
      candidates.filter((entry) => entry.record.meta!.by === undefined).at(-1) ?? candidates.at(-1);

    let target = 1;
    if (lastNumber > 0) {
      const last = records[lastNumber - 1] as IdempotencyRecord<VoiceBookResult>;
      const state: IdempotencyState = last.state ?? "confirmed";
      if (state === "confirmed") {
        if (!isChange && active >= max) {
          this.logger?.warn(
            { conversation_id: booking.conversationId, bookings_in_call: active },
            "voice booking refused: this call already has the maximum number of appointments",
          );
          return this.multiAlreadyBooked(true, max);
        }
        if (lastNumber >= cap) {
          if (isChange) return this.changeRefused(booking, "limit", oldEntry?.record);
          return this.multiAlreadyBooked(true, max);
        }
        target = lastNumber + 1;
      } else if (state === "uncertain" || state === "started") {
        return { ...UNCERTAIN_RESULT, idempotency_status: "replayed" };
      } else if (last.result.outcome === "slot_taken") {
        target = lastNumber;
      } else {
        return { ...last.result, idempotency_status: "replayed" };
      }
    }

    const meta = ctx.voice ? journalMetaOf(booking, this.fingerprintKey) : undefined;

    // 3. A change: every check that can refuse it runs NOW, before anything is
    //    written — the old booking must be this call's, confirmed, unchanged,
    //    with the same phone, and its cancellation must be possible.
    let old: Extract<ChangeOld, { kind: "call" }> | undefined;
    if (isChange && meta !== undefined) {
      const number = oldEntry?.number ?? 0;
      const record = oldEntry?.record;
      if (
        record === undefined ||
        (record.state ?? "confirmed") !== "confirmed" ||
        record.meta === undefined
      ) {
        return this.changeRefused(booking, "not_found", undefined);
      }
      if (record.meta.by !== undefined) return this.changeRefused(booking, "already_changed", record);
      if (record.meta.ph !== meta.ph) return this.changeRefused(booking, "other_phone", record);
      const sameStart = wallMinute(record.meta.at) === wallMinute(booking.reservationDate);
      const ambiguous = sameStart && (record.meta.emp === undefined || booking.employeeId === undefined);
      if (
        !this.changeEnabled ||
        this.changeCanceller === undefined ||
        ambiguous ||
        !this.changeCanceller.canCancelForVoiceChange(`+34${booking.phone}`, nowMs)
      ) {
        return this.changeRefused(booking, "unavailable", record);
      }
      old = { kind: "call", number, reported: ctx.replaces as number, record, meta: record.meta };
    }

    // 2026-10-10 — a change of an EXISTING booking (read by `my_bookings` in
    // this call for its caller id). Every check before anything is written.
    let existing: Extract<ChangeOld, { kind: "existing" }> | undefined;
    if (!isChange && ctx.replacesExisting !== undefined && meta !== undefined) {
      const index = ctx.replacesExisting;
      if (
        !this.changeEnabled ||
        this.existingBookings === undefined ||
        this.changeCanceller?.cancelExistingForVoiceChange === undefined
      ) {
        return this.changeRefused(booking, "unavailable", undefined);
      }
      const resolved = this.existingBookings.resolveForChange(booking.conversationId, index, nowMs);
      if (!resolved.ok) {
        return this.changeRefusedAt(booking, resolved.reason, resolved.startsAt);
      }
      const xr = createHmac("sha256", this.fingerprintKey)
        .update(JSON.stringify(["xr", resolved.reservationId]))
        .digest("hex");
      if (records.some((record) => record?.meta?.xr === xr)) {
        return this.changeRefusedAt(booking, "already_changed", resolved.startsAt);
      }
      if (`+34${booking.phone}` !== resolved.phoneE164) {
        return this.changeRefusedAt(booking, "other_phone", resolved.startsAt);
      }
      if (!this.changeCanceller.canCancelForVoiceChange(resolved.phoneE164, nowMs)) {
        return this.changeRefusedAt(booking, "unavailable", resolved.startsAt);
      }
      existing = {
        kind: "existing",
        index,
        reservationId: resolved.reservationId,
        at: resolved.startsAt,
        phoneE164: resolved.phoneE164,
        xr,
        ...(resolved.dictated === true ? { dictated: true } : {}),
      };
    }

    // 4. The hueco on the table — and never one this call already booked.
    const offer = this.offerStore.authorizes(booking.conversationId, slotToken, nowMs);
    if (!offer.ok) {
      this.logger?.warn(
        { conversation_id: booking.conversationId, offer_refusal: offer.refusal },
        "voice booking refused: this hueco is not the one currently offered in this conversation",
      );
      if (offer.refusal === "consumed") return this.multiAlreadyBooked(false, max);
      return refusal("slot_not_authorized", SLOT_NOT_AUTHORIZED_MESSAGE);
    }

    if (meta !== undefined) {
      const standing = records
        .map((record, index) => ({ record, number: index + 1 }))
        .filter(
          (entry): entry is { record: IdempotencyRecord<VoiceBookResult>; number: number } =>
            entry.record !== undefined &&
            (entry.record.state ?? "confirmed") === "confirmed" &&
            entry.record.meta !== undefined &&
            entry.record.meta.by === undefined,
        );
      // The same hour and barber as a booking that still stands is that
      // booking's hueco, whatever token carried it here.
      if (
        standing.some(
          (entry) =>
            wallMinute(entry.record.meta!.at) === wallMinute(booking.reservationDate) &&
            entry.record.meta!.emp === booking.employeeId,
        )
      ) {
        return this.multiAlreadyBooked(false, max);
      }
      // 5. *** THE DUPLICATE NET (2026-10-08, conv_5401m4dv…). *** The same
      //    person already has a booking of this call that day, and nothing
      //    says whether this one replaces it: ask, write nothing, keep the
      //    lock. `replaces_booking_number: 0` is the caller's «las dos».
      if (ctx.replaces === undefined && existing === undefined) {
        // Same person = same name+surnames+phone, OR (2026-10-10, call pp3x4v)
        // same first given name + phone: a «change» re-sent with other
        // surnames must not slip through as a silent second booking.
        const twin = standing.find(
          (entry) =>
            (entry.record.meta!.who === meta.who ||
              (entry.record.meta!.fn !== undefined && entry.record.meta!.fn === meta.fn)) &&
            entry.record.meta!.at.slice(0, 10) === booking.reservationDate.slice(0, 10),
        );
        if (twin !== undefined) {
          this.logger?.warn(
            {
              conversation_id: booking.conversationId,
              existing_booking_number: reportedOf(twin.record, twin.number - 1),
            },
            "voice booking held: same person, same day as a booking of this call, no replaces_booking_number",
          );
          return {
            ...refusal("possible_duplicate", balancedPossibleDuplicateMessage(twin.record.meta!.at)),
            existing_booking_number: reportedOf(twin.record, twin.number - 1),
          };
        }
      }
    }

    const slot: BookingSlot = {
      journalId: bookingJournalId(booking.conversationId, target),
      number: target,
      max,
      // A change keeps the count; anything else adds one.
      terminal: (old !== undefined ? active : active + 1) >= max,
      // What the agent is told: a change keeps its booking's number; a new
      // booking is the count of standing bookings after it — so the prompt's
      // «booking_number < max_bookings_per_call» is the server's own rule.
      reported: old !== undefined ? old.reported : active + 1,
      ...(meta !== undefined
        ? {
            meta:
              old !== undefined
                ? { ...meta, rep: old.number, n: old.reported }
                : existing !== undefined
                  ? { ...meta, n: active + 1, xr: existing.xr }
                  : { ...meta, n: active + 1 },
          }
        : {}),
    };
    if (existing !== undefined) {
      // 2026-10-10 — what the customer said «sí» to must be the SERVER's
      // summary of this change (the lock's «Te cambio tu cita del …», or the
      // question below), never the model's paraphrase. Nothing written yet.
      if (this.existingBookings?.gateChange?.(booking.conversationId, existing.index, slotToken, nowMs) === "ask") {
        this.logger?.warn(
          { conversation_id: booking.conversationId, replaces_existing_booking: existing.index },
          "voice change held: the server had not written this change's summary yet",
        );
        const name = booking.employeeId !== undefined ? this.employeeNames?.nameOf(booking.employeeId) : undefined;
        return {
          ...refusal(
            "change_confirm_required",
            balancedChangeConfirmMessage(existing.at, booking.reservationDate, name),
          ),
          replaced_existing_booking: existing.index,
        };
      }
      // A change never adds an appointment: no per-phone limit (as in-call).
      return this.performChange(booking, slotToken, headers, nowMs, key, slot, existing, ctx);
    }
    if (old === undefined) {
      const limit = await this.checkPhoneLimit(booking, headers, nowMs);
      if (limit.refusal !== undefined) return limit.refusal;
      return this.performBook(booking, slotToken, headers, nowMs, key, slot, limit.spentMs);
    }
    return this.performChange(booking, slotToken, headers, nowMs, key, slot, old, ctx);
  }

  /** `change_not_available`, naming the old booking's hour when there is one. */
  private changeRefused(
    booking: EffectiveBooking,
    reason: ChangeRefusalReason,
    old: IdempotencyRecord<VoiceBookResult> | undefined,
  ): VoiceBookResult {
    this.logger?.warn(
      { conversation_id: booking.conversationId, change_refusal: reason },
      "voice change refused before writing anything",
    );
    return refusal(
      "change_not_available",
      balancedChangeNotAvailableMessage(reason, old?.meta?.at),
    );
  }

  /** `change_not_available` naming an EXISTING booking's hour (2026-10-10). */
  private changeRefusedAt(
    booking: EffectiveBooking,
    reason: ChangeRefusalReason,
    startsAt: string | undefined,
  ): VoiceBookResult {
    this.logger?.warn(
      { conversation_id: booking.conversationId, change_refusal: reason, existing_booking: true },
      "voice change refused before writing anything",
    );
    return refusal("change_not_available", balancedChangeNotAvailableMessage(reason, startsAt));
  }

  /**
   * *** A CHANGE: CREATE THE NEW BOOKING, THEN — ONLY IF CONFIRMED — CANCEL
   * THE OLD ONE. ***
   *
   * In that order so the customer can never end with nothing: if the create
   * fails, the old booking is untouched and the create's own refusal is the
   * answer. If it is confirmed, the old booking is marked replaced in the
   * journal (`cx: pending`) BEFORE the cancellation starts, so a second change
   * of it is refused, and the new record answers the honest «no he podido
   * confirmar…» until the cancellation's real outcome is journaled.
   *
   * The create is still raced against `bookDeadlineMs` exactly like any V2
   * write. A create that only confirms AFTER the caller was answered
   * `uncertain` never cancels anything: the caller believes the old booking
   * stands, so it must stand; the record says so and the log tells ops.
   */
  private async performChange(
    booking: EffectiveBooking,
    slotToken: string,
    headers: IncomingHeaders,
    nowMs: number,
    key: string,
    slot: BookingSlot,
    old: ChangeOld,
    ctx: MultiContext,
  ): Promise<VoiceBookResult> {
    const oldAt = old.kind === "call" ? old.meta.at : old.at;
    const replacedFields =
      old.kind === "call"
        ? { replaced_booking_number: old.reported }
        : { replaced_existing_booking: old.index };
    let answered = false;
    let rawWritten: string | undefined;
    // Announced before the write, exactly as `performBook` does.
    this.remember(slot.journalId, key, UNCERTAIN_RESULT, nowMs, "started", false, slot.meta);
    const upstream = this.runUpstreamBook(booking, slotToken, headers, nowMs, key, slot, (phone) => {
      rawWritten = phone;
    });

    const withChange = (
      created: VoiceBookResult,
      cancelled: boolean | null,
    ): VoiceBookResult => {
      const { message: _ignored, ...rest } = created;
      void _ignored;
      return {
        ...rest,
        outcome: cancelled === true ? "confirmed" : "changed_old_not_cancelled",
        message:
          cancelled === true
            ? balancedChangeDoneMessage(oldAt, booking.reservationDate)
            : balancedChangeOldNotCancelledMessage(oldAt, booking.reservationDate, cancelled === null),
        ...replacedFields,
        old_booking_cancelled: cancelled,
      };
    };
    const markOld = (cx: NonNullable<BookingJournalMeta["cx"]>): void => {
      if (old.kind === "existing") {
        // The listing never offers it again in this call, whatever happened.
        this.existingBookings?.markChange(booking.conversationId, old.index, cx === "pending" ? "changing" : "changed");
        return;
      }
      const oldId = bookingJournalId(booking.conversationId, old.number);
      this.remember(oldId, old.record.fingerprint, old.record.result, old.record.storedAtMs,
        old.record.state ?? "confirmed", old.record.upstreamAttempted ?? true,
        { ...old.meta, by: slot.number, cx });
    };
    const journalNew = (result: VoiceBookResult): void => {
      this.remember(slot.journalId, key, result, nowMs, "confirmed", true, slot.meta);
    };

    const flow = upstream.then(async (created): Promise<VoiceBookResult> => {
      if (created.outcome !== "confirmed") return created;
      if (answered) {
        // Confirmed too late: the caller already heard `uncertain`, so the old
        // booking is NOT cancelled — but it IS marked, so no later change of it
        // in this call can create yet another booking (review 2026-10-08 (a)).
        markOld("not_cancelled");
        // Nor does the new booking inherit the old one's number: the agent was
        // never told about it, so «booking 1» keeps meaning the old one only —
        // and that one is now marked, so every further change of it is refused.
        const { n: _inherited, ...unnumbered } = slot.meta ?? ({} as BookingJournalMeta);
        void _inherited;
        this.remember(
          slot.journalId,
          key,
          { ...withChange(created, false), booking_number: slot.number },
          nowMs,
          "confirmed",
          true,
          slot.meta === undefined ? undefined : (unnumbered as BookingJournalMeta),
        );
        this.logger?.warn(
          { conversation_id: shortConversationId(booking.conversationId), ...replacedFields },
          "voice change: the new booking confirmed after the deadline; the old one was NOT cancelled",
        );
        return created;
      }
      markOld("pending");
      const pending = withChange(created, null);
      journalNew(pending);

      const written = rawWritten === undefined ? undefined : normalizeSpanishPhone(rawWritten);
      const canceller = this.changeCanceller;
      // AVISOS_AGENDA: what replaced the old booking (owner's «CAMBIADA» line).
      const changeTo = { startsAt: wallMinute(booking.reservationDate), professional: created.employee_name ?? null };
      const cancelling: Promise<"cancelled" | "not_cancelled" | "unknown"> =
        written === undefined || !written.ok || canceller === undefined
          ? Promise.resolve("not_cancelled")
          : old.kind === "existing"
            ? written.e164 !== old.phoneE164 || canceller.cancelExistingForVoiceChange === undefined
              ? Promise.resolve("not_cancelled")
              : canceller
                  .cancelExistingForVoiceChange(
                    {
                      conversationId: booking.conversationId,
                      phoneE164: old.phoneE164,
                      reservationId: old.reservationId,
                      startsAt: wallMinute(old.at),
                      ...(old.dictated === true ? { dictated: true } : {}),
                      changeTo,
                    },
                    nowMs,
                  )
                  .catch(() => "unknown" as const)
            : canceller
                .cancelForVoiceChange(
                  {
                    conversationId: booking.conversationId,
                    phoneE164: written.e164,
                    startsAt: wallMinute(old.meta.at),
                    ...(old.meta.emp !== undefined ? { employeeId: old.meta.emp } : {}),
                    changeTo,
                  },
                  nowMs,
                )
                .catch(() => "unknown" as const);
      const settled = cancelling.then((outcome) => {
        markOld(outcome);
        const final = withChange(created, outcome === "cancelled" ? true : outcome === "unknown" ? null : false);
        journalNew(final);
        if (outcome !== "cancelled") {
          this.logger?.warn(
            {
              conversation_id: shortConversationId(booking.conversationId),
              ...replacedFields,
              old_booking_cancel: outcome,
            },
            "voice change: new booking confirmed but the old one is NOT (confirmed) cancelled — owner notified",
          );
        }
        return final;
      });
      const remaining = Math.max(0, this.changeBudgetMs - (Date.now() - ctx.startedAtMs));
      return new Promise<VoiceBookResult>((resolve) => {
        const timer = setTimeout(() => resolve(pending), remaining);
        void settled.then((final) => {
          clearTimeout(timer);
          resolve(final);
        });
      });
    });

    if (this.bookDeadlineMs === undefined) return flow;
    return new Promise<VoiceBookResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        answered = true;
        resolve(UNCERTAIN_RESULT);
      }, this.bookDeadlineMs);
      // The create part of `flow` is what the deadline bounds; once the create
      // has confirmed, `flow` itself is bounded by the change budget.
      void upstream.then((created) => {
        if (settled) return;
        if (created.outcome !== "confirmed") {
          settled = true;
          clearTimeout(timer);
          resolve(created);
          return;
        }
        settled = true;
        clearTimeout(timer);
        void flow.then(resolve);
      });
    });
  }

  /** The two V5 `already_booked_in_call` answers. Nothing was written. */
  private multiAlreadyBooked(limitReached: boolean, max: number): VoiceBookResult {
    return {
      ...refusal(
        "already_booked_in_call",
        limitReached
          ? balancedBookingLimitMessage(max)
          : BALANCED_SLOT_ALREADY_BOOKED_IN_CALL_MESSAGE,
      ),
      max_bookings_per_call: max,
      booking_limit_reached: limitReached,
    };
  }

  /**
   * Attaches the authorization to one offered hueco.
   *
   * The `service_id` sealed in is the one the AVAILABILITY QUESTION was asked
   * with, not one the booking may state later. That is the correct binding:
   * the service determines how long the appointment is, so an hour that is
   * free for a beard trim is not necessarily free for a cut and a beard, and
   * a token must never be able to move between the two.
   */
  private authorizeSlot(
    slot: VoiceAvailabilitySlot,
    input: VoiceAvailabilityInput,
    nowMs: number,
  ): VoiceAvailabilitySlot {
    const token = this.slotAuthorization.issue(
      {
        conversationId: input.conversation_id,
        reservationDate: slot.reservation_date,
        ...(slot.employee_id !== undefined ? { employeeId: slot.employee_id } : {}),
        serviceId: input.service_id,
      },
      nowMs,
    );
    return token === undefined ? slot : { ...slot, slot_token: token };
  }

  /**
   * The command to execute: identity from the request, hueco from the grant.
   *
   * There is deliberately no branch here that could prefer a body value — the
   * body no longer HAS a date, a barber or a service to prefer, and this
   * function does not receive the body at all. It takes the two things that
   * already survived validation, which is what makes "a legacy field cannot
   * influence a booking" a property of the types rather than of a review.
   */
  private effectiveBooking(
    conversationId: string,
    identity: CustomerIdentity,
    grant: SlotGrant,
  ): EffectiveBooking {
    return {
      conversationId,
      customerName: identity.name,
      customerSurnames: identity.surnames,
      phone: identity.phone,
      reservationDate: grant.reservationDate,
      ...(grant.employeeId !== undefined ? { employeeId: grant.employeeId } : {}),
      serviceId: grant.serviceId,
    };
  }

  private identityRejectionResult(
    rejection: IdentityRejection,
    headers: IncomingHeaders,
  ): VoiceBookResult {
    // One caller-facing sentence for every reason but one. The model must not
    // learn WHICH field it got wrong, because the next thing it would do is
    // invent a better-shaped value for that field — the exact behaviour of
    // 2026-08-30. Asking the caller for all three is the only recovery that
    // produces real data.
    //
    // The exception (2026-10-08, conv_1801m4bj…): a phone that is digits but
    // not nine of them. The generic sentence made the agent re-ask everything
    // three times while the caller repeated the same ten digits, and the
    // booking was lost. This sentence asks the CALLER — not the model — for
    // the number again, slowly, stating the rule and never how many digits
    // arrived. Voice only: the WhatsApp «cerebro» keeps the generic sentence.
    if (rejection === "phone_wrong_length" && !isWhatsAppChannel(headers)) {
      return refusal("invalid_customer_data", INVALID_PHONE_LENGTH_MESSAGE);
    }
    return refusal("invalid_customer_data", INVALID_CUSTOMER_DATA_MESSAGE);
  }

  /**
   * Runs `work` after every attempt already queued for this conversation.
   *
   * The queue itself lives in `src/utils/conversationSerializer.ts` so that the
   * balanced-V2 booking service can share this exact instance. The two services
   * share the durable idempotency journal, and {@link gateAgainst} is only
   * atomic if ONE queue guards it — two private queues over one journal would
   * reopen the race the queue exists to close.
   */
  private serialize<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    return this.serializer.run(conversationId, work);
  }

  private async performBook(
    booking: EffectiveBooking,
    slotToken: string,
    headers: IncomingHeaders,
    nowMs: number,
    key: string,
    slot: BookingSlot,
    spentMs = 0,
  ): Promise<VoiceBookResult> {
    // *** ANNOUNCE THE ATTEMPT BEFORE MAKING IT. ***
    //
    // Written to disk, fsynced, before a single byte goes upstream. If this
    // process dies between here and the answer, the journal says `started`,
    // the next boot promotes that to `uncertain`, and the retry is refused
    // instead of silently creating the appointment a second time. Recording
    // the outcome only afterwards — which is what the store did until now —
    // leaves exactly that window open.
    //
    // V5: `slot.journalId` is the bare conversation id for booking 1 (always,
    // and the only value a one-booking service ever uses), `…#2`/`…#3` after.
    this.remember(slot.journalId, key, UNCERTAIN_RESULT, nowMs, "started", false, slot.meta);

    // The write itself, journaled to completion whatever happens to it below.
    // It NEVER throws (see the try/catch inside) and it NEVER touches
    // anything but the journal and the offer store, so it is exactly as safe
    // to let run unobserved (the deadline branch) as it is to await directly.
    const upstream = this.runUpstreamBook(booking, slotToken, headers, nowMs, key, slot);

    // BALANCED V2 ONLY (`bookDeadlineMs` undefined ⇒ this branch never runs,
    // and `book()` behaves exactly as it did before this change). See
    // `VoiceBookingDeps.bookDeadlineMs`.
    if (this.bookDeadlineMs !== undefined) {
      // 2026-10-09: what the per-phone check waited comes off the deadline, so
      // the whole create still answers inside ElevenLabs' tool timeout.
      const deadlineMs =
        spentMs > 0
          ? Math.max(this.bookDeadlineMs - spentMs, Math.min(this.bookDeadlineMs, MIN_WRITE_DEADLINE_MS))
          : this.bookDeadlineMs;
      return this.raceAgainstDeadline(booking.conversationId, upstream, deadlineMs);
    }

    return upstream;
  }

  /**
   * ElevenLabs' tool timeout is 8 s; an upstream write takes up to ~2.5 s.
   * `deadlineMs` (`BALANCED_BOOK_DEADLINE_MS`) leaves headroom on both sides.
   *
   * Whichever of `upstream` or the timer settles first decides THIS caller's
   * answer. The one that loses is not cancelled: `upstream` already journals
   * its own true outcome when it finishes (inside {@link runUpstreamBook}),
   * so a losing upstream just finishes quietly in the background and a later
   * identical replay reads the truth from the journal instead of `started`.
   * The timer, if it loses, is cleared — nothing is left running for it.
   *
   * The per-conversation serializer is released once this race settles, not
   * once `upstream` does; it is the journal's "started" record — not the
   * serializer — that blocks a different fingerprint until the write lands.
   */
  private raceAgainstDeadline(
    conversationId: string,
    upstream: Promise<VoiceBookResult>,
    deadlineMs: number,
  ): Promise<VoiceBookResult> {
    return new Promise<VoiceBookResult>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.logger?.warn(
          {
            conversation_id: shortConversationId(conversationId),
            deadline_ms: deadlineMs,
            reason: "book_deadline",
          },
          "voice booking deadline reached before the upstream write finished; answering uncertain while the write continues in the background",
        );
        resolve(UNCERTAIN_RESULT);
      }, deadlineMs);

      // `upstream` never rejects — `runUpstreamBook` catches internally and
      // resolves with `UNCERTAIN_RESULT` on any throw — but `.then` alone
      // rather than `.then/.catch` is enough either way to guarantee no
      // unhandled rejection here.
      void upstream.then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /**
   * The write itself: calls `BookingService.book()`, classifies the result
   * and journals it. Split out of {@link performBook} so it can be awaited
   * directly (no deadline configured, or V1) or raced against a deadline and
   * left running in the background (Balanced V2) — the journaling behaviour
   * is identical either way, which is what makes a later replay honest.
   */
  private async runUpstreamBook(
    booking: EffectiveBooking,
    slotToken: string,
    headers: IncomingHeaders,
    nowMs: number,
    key: string,
    slot: BookingSlot,
    onWritten?: (ownerPhone: string) => void,
  ): Promise<VoiceBookResult> {
    let result: Awaited<ReturnType<BookingService["book"]>>;
    // 2026-10-09: an agenda snapshot taken before this write no longer counts
    // this phone's appointments (marked again once the outcome is known).
    this.markPhoneChanged(booking, headers, nowMs);
    try {
      result = await this.booking.book(
        {
          customer: {
            name: booking.customerName,
            surnames: booking.customerSurnames,
            phone: booking.phone,
          },
          // step SLOT: these three came out of the slot token, not out of
          // the request. `BookingService` is unchanged and cannot tell the
          // difference — which is the point: the guarantee is established
          // upstream of it, once, rather than re-litigated in the write path.
          reservationDate: booking.reservationDate,
          ...(booking.employeeId !== undefined ? { employeeId: booking.employeeId } : {}),
          typeReservation: String(booking.serviceId),
          // CANONICAL name and surnames, exactly as spoken. The marker is NOT
          // applied here: this object also feeds the log masking, the owner
          // fallback and — via `BookingService` — the caller-facing sentence.
          // Marking it at this level would leak "IA-" into all of them.
          //
          // Literal `true`: `voiceBookSchema` types the field as
          // `z.literal(true)`, so a booking that reached this line without an
          // explicit confirmation is not representable. The gate is still
          // enforced a second time inside `BookingService.book()`.
          confirmedByCustomer: true,
        },
        headers,
        nowMs,
        // The ONLY place the marker enters the write path. `BookingService`
        // applies it to the upstream `ownerName` field and nowhere else
        // ((internal doc, not included in the template) ADR-012).
        {
          displayPrefix: this.displayPrefix,
          // 2026-10-08: only a change asks; in-process, never journaled.
          ...(onWritten !== undefined ? { onOwnerPhoneWritten: onWritten } : {}),
        },
      );
    } catch {
      // `BookingService.book()` is written not to throw, but "written not to"
      // is not "cannot". An unexpected throw is the least-known outcome there
      // is, so it is recorded as the most cautious one rather than allowed to
      // clear the journal entry and re-open the write.
      this.remember(slot.journalId, key, UNCERTAIN_RESULT, nowMs, "uncertain", true, slot.meta);
      return UNCERTAIN_RESULT;
    }

    if (result.outcomeClass === "confirmed" || result.outcomeClass === "uncertain") {
      this.markPhoneChanged(booking, headers, nowMs);
    }
    const outcome: VoiceBookResult["outcome"] = result.success
      ? "confirmed"
      : result.reason === undefined || result.reason === "ok"
        ? "upstream_error"
        : result.reason;
    // *** THE APPOINTMENT EXISTS; NOW THE CUSTOMER GETS IT IN WRITING. ***
    //
    // Deliberately HERE: after the upstream write has already succeeded, and
    // before the journal records the answer, so the queued confirmation is
    // part of the stored result and an identical retry replays the same
    // sentence instead of queueing a second message. A replayed booking never
    // reaches this method at all (`book()` answers from the journal), so a
    // retry can neither send twice nor lose the field.
    //
    // `enqueueConfirmation` cannot throw and does not await: it appends one
    // fsynced line and returns. Everything that can go wrong — a full disk, a
    // number Meta will refuse, Meta being down — happens later, in the worker,
    // where it costs a message and never an appointment. `undefined` (off,
    // dry run, recipient not allowed, or anything at all failing) simply
    // leaves the field out, and this answer is byte for byte what it was
    // before the feature existed.
    const whatsapp =
      result.outcomeClass === "confirmed" && result.reservationId !== undefined
        ? this.whatsapp?.enqueueConfirmation(
            {
              reservationId: result.reservationId,
              conversationId: booking.conversationId,
              phone: booking.phone,
              customerName: booking.customerName,
              // From the slot token, exactly as the write used it.
              reservationDate: booking.reservationDate,
              ...(booking.employeeId !== undefined ? { employeeId: booking.employeeId } : {}),
              // Labels the «Añadir al calendario» event only.
              serviceId: booking.serviceId,
            },
            nowMs,
          )
        : undefined;
    // ADR-031 addendum: the calendar link for the WhatsApp «cerebro». Built
    // HERE, with the confirmation above, for the same reason: it becomes part
    // of the journaled answer, so an identical retry replays the same link.
    // Gated on the request's channel header — the voice agent never sends it,
    // so its answer is unchanged — and NOT on `WHATSAPP_NOTIFICATIONS_MODE`.
    // Same inputs the notifier mints from (`appointmentCalendarFields`);
    // `appointmentCalendarUrl` cannot throw, and `undefined` omits the field.
    const calendarUrl =
      // NOT gated on `reservationId`: the salon's POST /reservation answers an
      // empty 201 (no id, verified in production 2026-10-08), and the link
      // is minted from the date, barber and service alone.
      this.calendarLink !== undefined &&
      result.outcomeClass === "confirmed" &&
      isWhatsAppChannel(headers)
        ? appointmentCalendarUrl(
            this.calendarLink.config,
            {
              reservationDate: booking.reservationDate,
              ...(booking.employeeId !== undefined ? { employeeId: booking.employeeId } : {}),
              serviceId: booking.serviceId,
            },
            this.calendarLink.employeeNames,
          )
        : undefined;
    // 2026-10-10: who, for the closing sentence. Only on `confirmed`, only a
    // name this process already read from the agenda; otherwise absent.
    const employeeName =
      result.outcomeClass === "confirmed" && booking.employeeId !== undefined
        ? this.employeeNames?.nameOf(booking.employeeId)
        : undefined;
    const voiceResult: VoiceBookResult = {
      booked: result.success,
      message: result.message,
      outcome,
      // Derived from the SAME classification the journal records, so the
      // stored answer and the spoken one can never disagree about whether
      // the salon's agenda changed. `uncertain` yields `null`/`unknown`, not
      // a `false` we cannot support.
      ...mutationFields(result.outcomeClass),
      idempotency_status: "original",
      // V5 only: which booking of the call this is. Stored with the answer,
      // so its replay carries the same number. Absent with one booking per
      // call, so that response is exactly what it always was.
      ...(slot.max > 1 && result.outcomeClass === "confirmed"
        ? { booking_number: slot.reported, max_bookings_per_call: slot.max }
        : {}),
      // Absent unless a message will really be sent — see the block above and
      // {@link VoiceBookResult.whatsapp_confirmation}.
      ...(whatsapp !== undefined ? { whatsapp_confirmation: whatsapp } : {}),
      // Absent unless the WhatsApp channel asked and a link could be minted —
      // {@link VoiceBookResult.calendar_url}.
      ...(calendarUrl !== undefined ? { calendar_url: calendarUrl } : {}),
      ...(employeeName !== undefined && employeeName.trim() !== ""
        ? { employee_name: employeeName.trim() }
        : {}),
    };
    // step OFFER: the conversation has produced an appointment. The record
    // keeps the token that authorized it, so the agent's identical retry two
    // seconds later still reaches the journal and is REPLAYED rather than
    // refused — and the state says, to anyone inspecting it, that this call is
    // done. A second, different booking is still the journal's decision
    // (`already_booked_in_call`), not this store's.
    //
    // V5: while the call may still make another booking, the token is
    // CONSUMED instead — it leaves the table for good, and the next lock
    // supersedes normally (ADR-022). The last booking allowed is terminal, as
    // before; with one booking per call that is every booking.
    if (result.outcomeClass === "confirmed") {
      if (!slot.terminal) {
        this.offerStore.markConsumed(booking.conversationId, slotToken, nowMs);
      } else {
        this.offerStore.markTerminal(booking.conversationId, slotToken, nowMs);
      }
    }
    // Every outcome is now durable, not just the confirmations. That single
    // change is what makes a refused booking replayable instead of repeatable.
    this.remember(
      slot.journalId,
      key,
      voiceResult,
      nowMs,
      result.outcomeClass,
      result.upstreamAttempted,
      slot.meta,
    );
    return voiceResult;
  }

  /** One place that writes the journal, so no call site can forget a field.
   * `journalId` is {@link bookingJournalId} — the bare conversation id for the
   * first booking of a call. */
  private remember(
    journalId: string,
    fingerprintKey: string,
    result: VoiceBookResult,
    storedAtMs: number,
    state: IdempotencyState,
    upstreamAttempted: boolean,
    meta?: BookingJournalMeta,
  ): void {
    this.completedByConversation.remember(journalId, {
      fingerprint: fingerprintKey,
      result,
      storedAtMs,
      state,
      upstreamAttempted,
      ...(meta !== undefined ? { meta } : {}),
    });
  }
}
