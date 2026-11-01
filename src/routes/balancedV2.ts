import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { FECHA_PIECE_FIELDS } from "../utils/dayName.js";
import {
  BOOKING_SECRET_HEADER,
  makeScopedWebhookAuth,
  makeWebhookAuth,
  safeEqual,
} from "../plugins/webhookAuth.js";
import {
  BOOKING_INDEX_FIELD,
  MSG_MANAGE_BY_WHATSAPP,
  REPLACES_EXISTING_BOOKING_FIELD,
  VOICE_MANAGE_ACTIONS,
  readBookingIndex,
  type VoiceManageResponse,
  type VoiceManageService,
} from "../services/voiceManage/voiceManageService.js";
import { balancedAvailabilitySchema } from "../schemas/balancedV2Schemas.js";
import { voiceBookSchema, type VoiceBookInput } from "../schemas/aiSchemas.js";
import type {
  BalancedAvailabilityService,
  BalancedDiscoverResult,
} from "../services/balanced/balancedAvailabilityService.js";
import {
  isWhatsAppChannel,
  resolveCallerPhone,
  type VoiceBookResult,
  type VoiceBookingService,
} from "../services/voiceBookingService.js";
import type { AgentProfileResolver } from "../services/balanced/agentProfile.js";
import { ZodError } from "zod";

import { UpstreamError } from "../core/calendar/errors.js";
import {
  setRequestContext,
  setResultCategory,
  type ResultCategory,
} from "../plugins/observability.js";
import { GENERIC_ERROR_MESSAGE } from "../utils/phrasing.js";
import { normalizeSpanishPhone } from "../utils/phone.js";
import { resolveWaCaller } from "../services/waSelfService/waCallerId.js";
import { currentRequestMetrics } from "../observability/requestMetrics.js";
import {
  BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
  BALANCED_BOOK_MESSAGE_OVERRIDES,
  balancedConfirmedClosingEs,
  balancedConfirmedSpokenEs,
} from "../utils/balancedPhrasing.js";

/**
 * *** THE BALANCED V2 SURFACE — two routes, additive, beside the stable ones. ***
 *
 * `/ai/voice/availability` and `/ai/voice/book` are NOT touched by this file,
 * by the service behind it, or by anything it wires. They keep their contract,
 * their tokens, their offer store and their write flag exactly as the agent
 * currently in production expects them, because the V2 agent is a DUPLICATE of
 * that agent and the original has to keep answering calls while the duplicate is
 * tested.
 *
 * Registered in its own file rather than added to `src/routes/ai.ts` for the
 * same reason: `tests/voiceContract.test.ts` asserts that every route in that
 * file is documented by exactly one tool in `docs/elevenlabs/TOOL_SCHEMAS.json`,
 * which is the stable agent's contract. Adding V2 routes there would have forced
 * the stable agent's document to change in order to describe tools that agent
 * does not have. V2 gets its own document
 * (`docs/elevenlabs/TOOL_SCHEMAS_BALANCED_V2.json`) and its own agreement test.
 *
 * ── EVERY ANSWER IS HTTP 200. ───────────────────────────────────────────────
 *
 * Including a malformed request, an unknown option, a taken hour, an unreachable
 * agenda and a refused write. That is not laxity, it is the central lesson of
 * the 2026-08-30 incident: ElevenLabs renders a non-2xx as a TOOL ERROR and
 * re-invokes the tool, and a re-invoked write is a duplicate appointment. The
 * failure is not hidden — it is in the structured `outcome` the prompt is
 * instructed to read, and in the access line's categorical `result`, both of
 * which say strictly more than a status code that collapses every failure into
 * one number.
 */

/**
 * The path every Balanced V2 route lives under, exported because two other
 * decisions depend on knowing it: the rate limiter's exemption in
 * `src/app.ts`, and the tests that check the exemption applies to this surface
 * and to nothing else. A string literal repeated in three places is a string
 * literal that will eventually differ in one of them.
 */
export const BALANCED_V2_PREFIX = "/ai/voice/v2/";

/**
 * A booking request with nothing in it — the answer to a body this middleware
 * could not read at all.
 *
 * It is sent THROUGH `VoiceBookingService.book()` rather than turned into a
 * handwritten response, and that is the whole point: the service already owns
 * the deterministic refusal for "no conversation id, no slot token" — it is the
 * FIRST thing `book()` checks, it returns `invalid_slot_token` from the closed
 * catalogue `tests/balancedV2Contract.test.ts` extracts by regex, and it does
 * so before the idempotency journal, before the write gate and before any
 * upstream call. So an unreadable request is answered with an outcome the
 * prompt already knows, a message the prompt already handles, and a
 * `mutation_status: "none"` that is a statement of fact rather than a hope.
 *
 * Inventing an `invalid_request` outcome here instead would have added a
 * thirteenth member to a catalogue three documents describe, to say something
 * the twelfth already says: this hueco was never authorized, ask again.
 */
const UNREADABLE_BOOK_REQUEST = {} as VoiceBookInput;

/**
 * 2026-10-08 — two optional fields read from the RAW body, beside
 * `agent_profile` and for the same reason: the Zod schemas are the published
 * V4/V1 contracts and strip unknown keys. Only the V5 tool document declares
 * them (`docs/elevenlabs/TOOL_SCHEMAS_BALANCED_V5.json`).
 */
export const DAY_NAME_FIELD = "day_name";
/** 2026-10-10 — the customer's literal words about the day; see `resolveFechaDicha`. */
export const FECHA_DICHA_FIELD = "fecha_dicha";
export { FECHA_PIECE_FIELDS } from "../utils/dayName.js";
export const REPLACES_BOOKING_NUMBER_FIELD = "replaces_booking_number";
/**
 * 2026-10-09 — three more raw-body fields, same rule:
 * - `option_time` / `option_date` (lock): what the agent believes it is
 *   locking (call r3557a). Absent: the lock is by `option_index` alone.
 *   Also read by the create (escaneo 2026-10-09, hallazgo 1), both channels:
 *   the hour read in the summary must be the slot token's hour.
 * - `caller_phone` (create): bound by ElevenLabs to `system__caller_id`, never
 *   filled by the LLM. Read only for voice and only when
 *   `VOICE_CALLER_ID_PHONE_ENABLED` is armed.
 */
export const OPTION_TIME_FIELD = "option_time";
export const OPTION_DATE_FIELD = "option_date";
export const CALLER_PHONE_FIELD = "caller_phone";

function rawField(body: unknown, field: string): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)[field]
    : undefined;
}

/**
 * 2026-10-11 — the E.164 phone that may arm the `own_booking_at_time` guard.
 * WhatsApp: the verified caller-id HEADER (a Spanish phone only). Voice: the
 * ElevenLabs-bound `caller_phone`, and only with `VOICE_CALLER_ID_PHONE_ENABLED`
 * (a Spanish mobile only). `undefined` otherwise. Never logged.
 */
function ownBookingPhone(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  whatsApp: boolean,
  voiceEnabled: boolean,
): string | undefined {
  if (whatsApp) {
    const caller = resolveWaCaller(headers);
    return caller.ok ? caller.e164 : undefined;
  }
  if (!voiceEnabled) return undefined;
  const resolved = resolveCallerPhone("caller", rawField(body, CALLER_PHONE_FIELD));
  if (resolved.kind !== "caller") return undefined;
  const normalized = normalizeSpanishPhone(resolved.phone);
  return normalized.ok ? normalized.e164 : undefined;
}

/** `replaces_booking_number`: an integer 0..9 (number or numeric string), else absent. */
function readReplacesBookingNumber(body: unknown): number | undefined {
  const raw = rawField(body, REPLACES_BOOKING_NUMBER_FIELD);
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  return Number.isInteger(value) && value >= 0 && value <= 9 ? value : undefined;
}

/** 2026-10-10 — a voice-manage answer -> the access line's categorical `result`. */
function manageCategory(outcome: VoiceManageResponse["outcome"]): ResultCategory {
  switch (outcome) {
    case "bookings_found":
    case "cancelled":
    case "service_changed":
    case "same_service":
      return "ok";
    case "no_bookings":
    case "booking_gone":
      return "not_found";
    case "not_confirmed":
      return "not_confirmed";
    case "agenda_unavailable":
    case "not_cancelled":
    case "service_not_changed":
      return "upstream_error";
    case "cancel_uncertain":
    case "service_change_lost":
    case "uncertain":
      return "booking_uncertain";
    case "service_change_too_late":
    case "service_change_unavailable":
    case "manage_unavailable":
      return "write_disabled";
    case "caller_unknown":
    case "phone_needed":
      return "unauthorized";
    case "confirm_required":
      return "not_confirmed";
    case "dictated_not_found":
      return "not_found";
    case "dictated_limit":
      return "rate_limited";
    default:
      return "invalid_request";
  }
}

/**
 * Balanced outcomes -> the access line's categorical `result`.
 *
 * A mapping rather than a pass-through, because `ResultCategory` is a CLOSED
 * union on purpose (see its comment: a log dimension an unbounded set of values
 * can enter is a log dimension nobody can aggregate). Three genuinely new
 * stories earned their own members there; the rest map onto categories that
 * already mean the same thing — `no_availability` really is `no_slots`, and an
 * unreachable agenda really is an upstream error.
 */
function discoverCategory(outcome: string): ResultCategory {
  if (outcome === "options_available") return "ok";
  // A band walked out is the same operational story as a day with nothing in
  // it: the salon had no hour to give, and no fault occurred.
  if (
    outcome === "no_availability" ||
    outcome === "no_more_options" ||
    outcome === "own_booking_at_time"
  ) {
    return "no_slots";
  }
  if (outcome === "agenda_unavailable") return "upstream_error";
  // A continuation that is gone, or that the request contradicts, is the same
  // story `lock` already logs when an index is not one this call is holding:
  // the conversation's state and the agent's belief have diverged, and the
  // recovery is a fresh `discover`. Reusing the member keeps `ResultCategory`
  // closed — see its comment — and keeps the dashboards aggregable.
  if (outcome === "continuation_lost" || outcome === "continuation_mismatch") {
    return "option_not_found";
  }
  return "invalid_request";
}

/**
 * A `scan` answer -> the access line's categorical `result`.
 *
 * *** A PARTIAL WINDOW IS `upstream_timeout`, WHATEVER THE OUTCOME SAYS. ***
 *
 * The outcome describes what the CALLER got — hours, or none. The access line
 * has to describe what the SYSTEM did, and "we answered without one of the days
 * because the salon did not reply in 2.5 s" is an upstream timeout in exactly
 * the sense this category already means: it is the same member
 * `/ai/voice/v2/availability` stamps when a degraded read times out, and it is
 * the signal an operator needs when the salon's host starts to sag. Counting
 * those answers as `ok` would make the one thing worth alerting on invisible —
 * a scan that quietly stops looking at half the week still speaks a perfectly
 * cheerful sentence.
 *
 * `no_availability` on a COMPLETE window keeps `no_slots`: nothing failed, the
 * salon simply had nothing matching.
 *
 * *** `agenda_unavailable` WITH `days_checked: []` IS ALSO A TIMEOUT. ***
 *
 * `BalancedAvailabilityService.scan` answers `agenda_unavailable` in two
 * situations that look identical in the outcome alone but are not the same
 * operational story: the deadline expired before ANY day came back (see the
 * `days_checked.length === 0` branch there), which is this process's OWN
 * clock running out — an `upstream_timeout`, exactly like a partial window,
 * just one where every day happened to miss the deadline instead of some.
 * `days_checked` travels on the result for precisely this reason (it is "the
 * honesty field") and an empty array is present, not missing.
 *
 * The genuinely unreachable agenda — the salon answering an error, caught by
 * `src/routes/balancedV2.ts`'s `UpstreamError` handler and turned into a
 * hand-built `agenda_unavailable` refusal — never reaches this function: that
 * catch block sets the category itself and that refusal carries no
 * `days_checked` at all. So the absence of the field, not its emptiness, is
 * what keeps `upstream_error` true to a real upstream failure.
 */
function scanCategory(
  result: Pick<BalancedDiscoverResult, "outcome" | "partial" | "days_checked">,
): ResultCategory {
  if (result.partial) return "upstream_timeout";
  if (
    result.outcome === "agenda_unavailable" &&
    result.days_checked !== undefined &&
    result.days_checked.length === 0
  ) {
    return "upstream_timeout";
  }
  return discoverCategory(result.outcome);
}

function lockCategory(outcome: string): ResultCategory {
  switch (outcome) {
    case "locked":
      return "ok";
    case "slot_taken":
    case "own_booking_at_time":
      return "slot_taken";
    case "option_not_found":
      return "option_not_found";
    case "employee_unavailable":
      return "employee_unavailable";
    case "authorization_unavailable":
      return "authorization_unavailable";
    case "agenda_unavailable":
      return "upstream_error";
    default:
      return "invalid_request";
  }
}

/**
 * The shape every read refusal shares, restated as `invalid_request`.
 *
 * The service's own refusal already carries that outcome; the restatement
 * exists so the two call sites (an unparseable body, an unknown action) cannot
 * drift from each other or from the outcome the tool document declares.
 */
function invalidDiscoverAnswer<T>(refusal: T): T & { outcome: "invalid_request" } {
  return { ...refusal, outcome: "invalid_request" as const };
}

/** A book outcome + whether the journal replayed it -> the access category. */
function bookCategory(
  outcome: VoiceBookResult["outcome"],
  replayed: boolean,
): ResultCategory {
  // *** THE ONE DISTINCTION THE 2026-09-11 LOG COULD NOT MAKE. ***
  //
  // A confirmed booking and a confirmed booking REPLAYED from the durable
  // idempotency journal both answered `result:"ok"`, so the access line for
  // 15:12:02 — a re-invocation 1.19 s after the real write, served in 2.6 ms
  // with zero upstream calls — was word for word the line of the write itself.
  // The journal behaved perfectly; the log simply did not say so, and "the
  // agent is retrying writes" is exactly the signal that must not be silent
  // (it is the mechanism of the 2026-08-30 duplicate appointment).
  if (outcome === "confirmed") return replayed ? "booked_replay" : "ok";
  if (outcome === "misconfigured_owner") return "internal_error";
  if (outcome === "uncertain") return "booking_uncertain";
  // Every remaining outcome IS a category of the same name: they were added to
  // `ResultCategory` for this path.
  return outcome;
}

/**
 * Records what a booking answer means, for the access line only.
 *
 * `idempotency` is stamped for EVERY outcome, not just the confirmed one: a
 * replayed refusal is also a re-invocation, and counting re-invocations is the
 * point. The categorical `result` keeps the refusal's own name, because a
 * replayed `write_disabled` is still `write_disabled` and renaming it would
 * cost the dashboard the outcome to gain the repetition — which the separate
 * field already carries.
 */
function classifyBookResult(request: FastifyRequest, result: VoiceBookResult): void {
  const replayed = result.idempotency_status === "replayed";
  setRequestContext(request, { idempotency: replayed ? "replayed" : "fresh" });
  setResultCategory(request, bookCategory(result.outcome, replayed));
}

/**
 * Whether an error happened BEFORE the handler could run — i.e. whether
 * "nothing was written" is something we KNOW rather than assume.
 *
 * That distinction is the whole reason this is a predicate and not a blanket
 * `return 200`. The deterministic answers below all assert
 * `mutation_status: "none"`, and asserting it after an unknown failure deep in
 * a write would be exactly the false statement ADR-016 removed from
 * `uncertain`. A ZodError, a body Fastify could not parse, an unsupported
 * content type and a rate-limit refusal all share one property: the route
 * function never ran, so no upstream call was ever made.
 */
function isPreDispatchFailure(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("FST_ERR_CTP_")) return true;
  const status = (error as { statusCode?: unknown }).statusCode;
  // 429 is belt and braces: `src/app.ts` exempts this whole surface from the
  // limiter. If that exemption is ever undone, the answer here is still a 200
  // rather than the tool error that makes ElevenLabs retry the write.
  return status === 400 || status === 415 || status === 429;
}

/** Never throws, never waits for the network. */
export interface AgendaBookingPort {
  noteBooking(
    b: { channel: "whatsapp" | "voice"; conversationId: string; slotToken: string; employeeName?: string },
    nowMs: number,
  ): void;
}

export interface BalancedV2RoutesOptions {
  /** Discovery and locking. Reads the agenda; writes nothing, ever. */
  balanced: BalancedAvailabilityService;
  /**
   * The V2-configured booking service. A SEPARATE instance from the one
   * `/ai/voice/book` uses, wired in `src/services/container.ts` with:
   *
   * - the V2 slot-authorization domain, so only a token a V2 `lock` minted can
   *   be spent here, and a V2 token cannot be spent on the stable route;
   * - the V2 offer store, so a token no longer on the table is refused;
   * - a `BookingService` whose write permission is
   *   `create && ENABLE_BALANCED_V2_CREATE`, so the V2 flag really does gate
   *   V2 creation even when general creation is armed;
   * - the SAME durable idempotency journal and the SAME per-conversation
   *   serializer as the stable path, so "one appointment per call" is one rule
   *   for the call, not one rule per endpoint.
   */
  voiceBookingV2: VoiceBookingService;
  /**
   * 2026-10-11 — `VOICE_CALLER_ID_PHONE_ENABLED`: only then may a voice
   * request's `caller_phone` arm the `own_booking_at_time` guard.
   */
  callerIdPhoneEnabled?: boolean;
  webhookSecret: string;
  /**
   * The booking-only second credential (ADR-011). Applied to
   * `/ai/voice/v2/book` on exactly the same terms as to `/ai/voice/book`: the
   * shared `/ai/*` secret AND this one, in two different headers. A read secret
   * must never on its own reach a write path, and that must stay true of the
   * new write path from its first line.
   */
  bookingWebhookSecret?: string;
  /**
   * V5 ((internal doc, not included in the template) ADR-025) — reads each request's `agent_profile`
   * from the RAW body and decides whether it is served as V4 (absent, unknown,
   * or V5 disabled) or as V5. The Zod schemas never see the field.
   */
  agentProfiles: AgentProfileResolver;
  /**
   * 2026-10-09 — the per-phone booking limit. Every `lock` starts its agenda
   * read in the background (never awaited), so the create that follows a
   * minute later usually finds it ready and waits for nothing.
   */
  phoneBookingLimit?: { prefetch(): void };
  /**
   * (internal doc, not included in the template) — told of every NEW confirmed booking
   * (counted in the owner's morning digest). Absent = no hook at all.
   */
  agendaBookings?: AgendaBookingPort;
  /**
   * 2026-10-10 — `my_bookings` / `cancel` on the availability tool
   * (internal doc, not included in the template). Absent: those actions answer
   * the WhatsApp sentence. Voice only.
   */
  voiceManage?: VoiceManageService;
}

export async function registerBalancedV2Routes(
  app: FastifyInstance,
  opts: BalancedV2RoutesOptions,
): Promise<void> {
  const { balanced, voiceBookingV2, webhookSecret, agentProfiles } = opts;
  /** The booking secret, when configured, must be on a voice `cancel` too. */
  const bookingSecretPresent = (request: FastifyRequest): boolean => {
    if (opts.bookingWebhookSecret === undefined) return true;
    const raw = request.headers[BOOKING_SECRET_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value !== "" && safeEqual(value, opts.bookingWebhookSecret);
  };

  await app.register(async (scoped) => {
    scoped.addHook("preHandler", makeWebhookAuth(webhookSecret));

    /**
     * *** THE "EVERY ANSWER IS 200" RULE, ENFORCED WHERE THE HANDLER CANNOT. ***
     *
     * PRODUCTION FORENSICS 2026-09-11 (F5). The file header above states the
     * rule, and every route below honours it — but a request can fail BEFORE
     * any route function runs: a body that is not JSON, a content type Fastify
     * will not parse, a schema that cannot read the body at all. Those errors
     * went to the GLOBAL handler in `src/plugins/errorHandler.ts`, which
     * answers 400 (and 429 for a limiter refusal), which ElevenLabs renders as
     * a TOOL ERROR, which it answers by invoking the tool again. On the write
     * tool, that is the 2026-08-30 duplicate appointment.
     *
     * An ENCAPSULATED error handler rather than a V2 special case inside the
     * global one: the rule belongs to this surface, and the global handler must
     * not have to know the V2 contract — its answer for `/ai/*`, the console
     * and the booking web is still exactly what it was.
     *
     * Only pre-dispatch failures are converted. An unexpected error from inside
     * a handler keeps its 500, because the deterministic bodies below all
     * assert that nothing was written, and after an unknown failure that is not
     * something this code can know (ADR-016).
     */
    scoped.setErrorHandler(async (error, request: FastifyRequest, reply: FastifyReply) => {
      if (!isPreDispatchFailure(error)) {
        const message = error instanceof Error ? error.message : String(error);
        request.log.error({ err: message }, "balanced v2: unhandled error");
        return reply.code(500).send({ success: false, message: GENERIC_ERROR_MESSAGE });
      }
      // The CODE, never the message: a JSON parse error's text can quote the
      // byte it choked on, and the body of a booking call is customer data.
      request.log.warn(
        {
          route: request.routeOptions?.url ?? "unrouted",
          failure:
            (error as { code?: string }).code ??
            (error instanceof Error ? error.name : "unknown"),
        },
        "balanced v2: unreadable request answered with a structured 200",
      );

      if ((request.routeOptions?.url ?? "").endsWith("/book")) {
        // Through the real service, so the outcome, the message and the
        // "nothing was written" claim all come from the one implementation
        // that owns them. See `UNREADABLE_BOOK_REQUEST`.
        const result = await voiceBookingV2.book(
          UNREADABLE_BOOK_REQUEST,
          request.headers,
          Date.now(),
        );
        classifyBookResult(request, result);
        return reply.code(200).send(result);
      }
      setResultCategory(request, "invalid_request");
      return reply
        .code(200)
        .send(invalidDiscoverAnswer(await balanced.discover({}, Date.now())));
    });

    /**
     * ONE endpoint, FOUR actions — `discover`, `scan`, `more` and `lock`. See
     * `src/schemas/balancedV2Schemas.ts` for why `action` is a field rather
     * than three routes.
     *
     * The comment used to say TWO, then THREE, each true at the time and each
     * exactly the kind of stale line a reader trusts: it is the first thing
     * anyone opening this file reads about the endpoint's shape.
     */
    scoped.post("/ai/voice/v2/availability", async (request) => {
      const nowMs = Date.now();
      // 2026-10-10 — consult / cancel EXISTING bookings of the caller id.
      // Read from the raw body BEFORE the V4 schema (whose `action` list is
      // the published V2/V4 contract and stays as it is).
      const rawAction = rawField(request.body, "action");
      if ((VOICE_MANAGE_ACTIONS as readonly unknown[]).includes(rawAction)) {
        const manage = opts.voiceManage;
        let answer: VoiceManageResponse;
        if (manage === undefined || isWhatsAppChannel(request.headers)) {
          answer = {
            outcome: "manage_unavailable",
            message: MSG_MANAGE_BY_WHATSAPP,
            external_mutation: false,
            mutation_status: "none",
          };
        } else if (rawAction === "my_bookings") {
          answer = await manage.myBookings(request.body, nowMs);
        } else if (!bookingSecretPresent(request)) {
          // A cancel / service change is a write: it needs the create tool's credential too.
          request.log.warn({ action: rawAction }, "voice manage: write action without the booking secret refused");
          answer = {
            outcome: "manage_unavailable",
            message: MSG_MANAGE_BY_WHATSAPP,
            external_mutation: false,
            mutation_status: "none",
          };
        } else if (rawAction === "change_service") {
          answer = await manage.changeService(request.body, nowMs);
        } else {
          answer = await manage.cancel(request.body, nowMs);
        }
        setResultCategory(request, manageCategory(answer.outcome));
        return answer;
      }
      // V5 (ADR-025): the agent profile of THIS request. Only `discover` and
      // `scan` have anything that differs by profile (the 14-day look-ahead);
      // `lock` and `more` are identical for V4 and V5.
      // ADR-026: `nearestAlternatives` only changes `discover`.
      const capabilities = agentProfiles.resolve(request.body, "availability");
      // 2026-10-08 (owner request): a WhatsApp request gets WRITTEN pages of
      // up to `BALANCED_WA_MAX_OPTIONS` options (discover, scan, more). The
      // flag is added ONLY when the header is present, so a voice request
      // builds exactly the options object it always did. `lock` is not given
      // it: it validates against the page size stored with the page.
      const whatsApp = isWhatsAppChannel(request.headers);
      const dayName = rawField(request.body, DAY_NAME_FIELD);
      // 2026-10-10 (v3): the day pieces + fecha_dicha, only the keys sent.
      const fechaPiezas = Object.fromEntries(
        [...FECHA_PIECE_FIELDS, FECHA_DICHA_FIELD]
          .map((key) => [key, rawField(request.body, key)] as const)
          .filter(([, value]) => value !== undefined),
      );
      // 2026-10-11 (own_booking_at_time): the VERIFIED phone of the caller —
      // the WhatsApp header, or the voice caller id when its flag is armed.
      // Never a field the model writes. Absent = the guard does not run.
      const callerPhoneE164 = ownBookingPhone(request.headers, request.body, whatsApp, opts.callerIdPhoneEnabled === true);
      const readOptions = {
        extendedLookAhead: capabilities.extendedLookAhead,
        nearestAlternatives: capabilities.nearestAlternatives,
        ...(callerPhoneE164 !== undefined ? { callerPhoneE164 } : {}),
        ...(whatsApp ? { whatsApp: true } : {}),
        // 2026-10-08: only when sent, so a request without it builds exactly
        // the options object it always did.
        ...(dayName !== undefined ? { dayName } : {}),
        // 2026-10-10: same rule — only when sent.
        ...(Object.keys(fechaPiezas).length > 0 ? { fechaPiezas } : {}),
      };
      // *** A BODY ZOD CANNOT READ IS ANSWERED, NOT REJECTED. ***
      //
      // The schema types every field as `unknown` (see its comment), so the
      // only way this fails is a body that is not a JSON object at all — and
      // `.parse()` threw a ZodError for it, which the GLOBAL error handler
      // turns into HTTP 400, which ElevenLabs turns into a tool error, which
      // ElevenLabs answers by calling the tool again. The one thing this file's
      // header says must never happen, reached by the one path no V2 route
      // handler could see. `safeParse` keeps the decision here, where the
      // contract is.
      const parsed = balancedAvailabilitySchema.safeParse(request.body);
      if (!parsed.success) {
        setResultCategory(request, "invalid_request");
        return invalidDiscoverAnswer(await balanced.discover({}, nowMs));
      }
      const body = parsed.data;
      const action = body.action;

      try {
        if (action === "lock") {
          // 2026-10-09: warm the per-phone limit's agenda read. Never throws,
          // never awaited: the lock answers exactly as fast as before.
          opts.phoneBookingLimit?.prefetch();
          // 2026-10-09: only when sent, so a lock without them is the old lock.
          const optionTime = rawField(request.body, OPTION_TIME_FIELD);
          const optionDate = rawField(request.body, OPTION_DATE_FIELD);
          const result = await balanced.lock(body, nowMs, {
            ...(optionTime !== undefined ? { optionTime } : {}),
            ...(optionDate !== undefined ? { optionDate } : {}),
            ...(callerPhoneE164 !== undefined ? { callerPhoneE164 } : {}),
            ...(whatsApp ? { whatsApp: true } : {}),
          });
          setResultCategory(request, lockCategory(result.outcome));
          const manage = opts.voiceManage;
          if (result.outcome !== "locked" || result.slot === undefined || whatsApp || manage === undefined) {
            return result;
          }
          let answer: typeof result & { replaces_existing_booking?: number; ask_phone?: boolean } = result;
          // 2026-10-10 — the lock of a CHANGE of an existing booking
          // (`booking_index`): the summary is the server's «Te cambio tu cita
          // del … por esta: …», and the create will only change after it.
          const changeIndex = readBookingIndex(rawField(request.body, BOOKING_INDEX_FIELD));
          const lockConversation = rawField(request.body, "conversation_id");
          if (changeIndex !== undefined && typeof lockConversation === "string" && answer.summary !== undefined) {
            const lead = manage.offerChange(lockConversation.trim(), changeIndex, result.slot.slot_token, nowMs);
            if (lead !== undefined) {
              answer = {
                ...answer,
                summary: lead + answer.summary!.replace(/^Te resumo: /, ""),
                replaces_existing_booking: changeIndex,
              };
            }
          }
          // 2026-10-10 plan B (VOICE_MANAGE_DICTATED_PHONE_ENABLED): no Spanish
          // mobile in this call, so the data question asks for a phone.
          if (
            manage.dictatedFlag &&
            resolveCallerPhone("caller", rawField(request.body, CALLER_PHONE_FIELD)).kind === "unavailable"
          ) {
            answer = { ...answer, ask_phone: true };
          }
          return answer;
        }
        if (action === "more") {
          // The continuation of the page this conversation is already on. It
          // reads no upstream and suspends nowhere — see
          // `BalancedAvailabilityService.more` for why both matter — so the
          // degradation branch below simply never applies to it.
          const result = whatsApp
            ? balanced.more(body, nowMs, { whatsApp: true })
            : balanced.more(body, nowMs);
          setResultCategory(request, discoverCategory(result.outcome));
          return result;
        }
        if (action === "scan") {
          // The WINDOW question. Reads several days at once, bounded by its own
          // deadline, and — exactly like `discover` — mints no token and can
          // reach no write path. See `BalancedAvailabilityService.scan`.
          const result = await balanced.scan(body, nowMs, readOptions);
          setResultCategory(request, scanCategory(result));
          return result;
        }
        if (action !== "discover") {
          // An action nobody implements. Answered as a normal, structured
          // refusal rather than a 400, so the agent re-asks instead of the
          // platform retrying an unparseable call.
          setResultCategory(request, "invalid_request");
          return invalidDiscoverAnswer(await balanced.discover({}, nowMs));
        }
        const result = await balanced.discover(body, nowMs, readOptions);
        setResultCategory(request, discoverCategory(result.outcome));
        return result;
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        // The same controlled degradation `/ai/voice/availability` already
        // performs (step PROD Hito 7): the agent is mid-call, a 502 becomes a
        // tool error, and a tool error is exactly when a model starts inventing
        // times. An empty, correctly-shaped 200 keeps it on script.
        const timedOut = (currentRequestMetrics()?.upstreamTimeouts ?? 0) > 0;
        setResultCategory(request, timedOut ? "upstream_timeout" : "upstream_error");
        request.log.warn(
          { upstream_status: error.status, timed_out: timedOut, action },
          "balanced v2 degraded: upstream agenda unreachable",
        );
        return action === "lock"
          ? {
              outcome: "agenda_unavailable" as const,
              locked: false,
              // *** THE V2 SENTENCE, NOT THE ONE THE STABLE AGENT SPEAKS. ***
              // `AGENDA_UNAVAILABLE_MESSAGE` ends «…o que te llamen desde la
              // peluquería?», which commits a person to a call nobody has
              // queued — and the V1 constant cannot simply be reworded,
              // because the agent currently taking real calls is speaking it.
              // See `src/utils/balancedPhrasing.ts`.
              message: BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
              external_mutation: false as const,
            }
          : {
              outcome: "agenda_unavailable" as const,
              available: false,
              message: BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
              options: [],
              total_unique_slots: 0,
              has_more: false,
              requested_period: null,
              offered_period: null,
              period_fallback: false,
              external_mutation: false as const,
            };
      }
    });

    const bookingGuard =
      opts.bookingWebhookSecret !== undefined
        ? [makeScopedWebhookAuth(opts.bookingWebhookSecret, BOOKING_SECRET_HEADER)]
        : [];

    scoped.post("/ai/voice/v2/book", { preHandler: bookingGuard }, async (request) => {
      // The SAME body contract as `/ai/voice/book`, deliberately: the V2 change
      // is about how a hueco is chosen, not about what a booking is. Reusing
      // `voiceBookSchema` means the two write paths cannot drift apart in what
      // they accept, and `VoiceBookingService.book()` — the one implementation
      // of the slot check, the identity check, the confirmation gate, the
      // idempotency journal and the single-write rule — is reused whole rather
      // than reimplemented for V2.
      // `safeParse`, for the reason the availability route gives above: the
      // schema accepts anything object-shaped, so a failure here means the body
      // was not an object — and a 400 on the WRITE tool is the worst of all
      // non-2xx answers, because the platform's reaction to a tool error is to
      // invoke the tool again.
      const parsed = voiceBookSchema.safeParse(request.body);
      const input = parsed.success ? parsed.data : UNREADABLE_BOOK_REQUEST;
      // V5 (ADR-025): how many appointments this call may hold is decided by
      // THIS create request's profile — never by an earlier availability call,
      // so a V5 search followed by a V4 create is a V4 create.
      const { maxBookingsPerCall, profile } = agentProfiles.resolve(request.body, "book");
      // 2026-10-08: a change of a booking of this call, or 0 for «las dos».
      // Never for the WhatsApp channel (its «cerebro» knows no such outcome).
      const replacesBookingNumber = isWhatsAppChannel(request.headers)
        ? undefined
        : readReplacesBookingNumber(request.body);
      // 2026-10-09: the caller id ElevenLabs binds (`system__caller_id`).
      // Never for WhatsApp; the service ignores it unless its flag is armed.
      const callerPhone = isWhatsAppChannel(request.headers)
        ? undefined
        : rawField(request.body, CALLER_PHONE_FIELD);
      const replacesExisting = isWhatsAppChannel(request.headers)
        ? undefined
        : readBookingIndex(rawField(request.body, REPLACES_EXISTING_BOOKING_FIELD));
      // 2026-10-09 (escaneo, hallazgo 1): the hour the agent read in the
      // summary, voice AND WhatsApp. Only when sent: without them, as before.
      const optionTime = rawField(request.body, OPTION_TIME_FIELD);
      const optionDate = rawField(request.body, OPTION_DATE_FIELD);
      const { employee_name: closingEmployeeName, ...serviceResult } = await voiceBookingV2.book(
        input,
        request.headers,
        Date.now(),
        {
        maxBookingsPerCall,
        ...(replacesBookingNumber !== undefined ? { replacesBookingNumber } : {}),
        ...(replacesExisting !== undefined ? { replacesExisting } : {}),
        ...(callerPhone !== undefined ? { callerPhone } : {}),
        ...(optionTime !== undefined ? { optionTime } : {}),
        ...(optionDate !== undefined ? { optionDate } : {}),
        },
      );
      // AVISOS_AGENDA: a NEW confirmed booking (not a replay, not a voice
      // change) is noted for the owner's morning digest. Never throws, never
      // waits for the network, and never alters the answer.
      try {
        const whatsAppChannel = isWhatsAppChannel(request.headers);
        const conversationId = input.conversation_id;
        const slotToken = input.slot_token;
        if (
          opts.agendaBookings !== undefined &&
          serviceResult.outcome === "confirmed" &&
          serviceResult.idempotency_status !== "replayed" &&
          typeof conversationId === "string" &&
          typeof slotToken === "string" &&
          (whatsAppChannel || (replacesBookingNumber === undefined && replacesExisting === undefined))
        ) {
          opts.agendaBookings.noteBooking(
            {
              channel: whatsAppChannel ? "whatsapp" : "voice",
              conversationId,
              slotToken,
              ...(closingEmployeeName !== undefined ? { employeeName: closingEmployeeName } : {}),
            },
            Date.now(),
          );
        }
      } catch {
        // A hook may never touch the booking's answer.
      }
      // *** ONE FIELD IS REPLACED, AND ONLY ONE. ***
      //
      // `VoiceBookingService` is reused WHOLE — the slot check, the identity
      // check, the confirmation gate, the idempotency journal and the
      // single-write rule are one implementation for both agents, and forking
      // it to change five sentences would trade a wording problem for a
      // correctness one. What the V2 agent may not do is repeat the V1 wording
      // of the failures: «se pondrá en contacto contigo», «confirmarla
      // directamente con la peluquería», «Te recomiendo llamar directamente a
      // la peluquería» all commit a human being to an action this middleware
      // neither performs nor observes.
      //
      // So `message` — the only customer-facing field — is substituted for the
      // outcomes listed in `BALANCED_BOOK_MESSAGE_OVERRIDES`, and every field
      // the prompt actually gates on (`booked`, `outcome`, `external_mutation`,
      // `mutation_status`, `idempotency_status`) is passed through untouched.
      // In particular `uncertain` keeps `external_mutation: null` /
      // `mutation_status: "unknown"`: the sentence changes, the honest "we do
      // not know" does not (ADR-016).
      //
      // The way OUT of a terminal failure is the prompt's WhatsApp sentence,
      // not this route's: when to say it depends on the conversation, and this
      // route sees one tool call.
      //
      // V5 (ADR-023): the two multi-booking `already_booked_in_call` answers
      // carry `max_bookings_per_call` and ALREADY speak a V2 sentence that says
      // something the V4 one cannot (the limit, or «esa hora ya quedó
      // reservada»). They keep it. A V4 request (one booking per call) never
      // produces that field, so this exception can never fire there.
      const v5Refusal =
        serviceResult.outcome === "already_booked_in_call" &&
        serviceResult.max_bookings_per_call !== undefined;
      // V5 (ADR-027): the confirmed sentence loses its «Perfecto» opening,
      // which the prompt forbids and the agent echoed. Same fields, only
      // `message`; a V4 create keeps the shared sentence byte for byte.
      // 2026-10-10 (saludo y cierre de Bruno): one closing sentence, day, hour
      // and barber from the server, plus the cancellation reminder on the
      // first booking of the call only. Voice only: WhatsApp writes its own.
      const v5Confirmed =
        profile === "v5" && serviceResult.outcome === "confirmed"
          ? isWhatsAppChannel(request.headers)
            ? // 2026-10-10: and the date and hour in words, for a literal read.
              balancedConfirmedSpokenEs(serviceResult.message)
            : balancedConfirmedClosingEs(serviceResult.message, {
                ...(closingEmployeeName !== undefined ? { employeeName: closingEmployeeName } : {}),
                reminder: (serviceResult.booking_number ?? 1) <= 1,
              })
          : undefined;
      const override = v5Refusal
        ? undefined
        : v5Confirmed ?? BALANCED_BOOK_MESSAGE_OVERRIDES[serviceResult.outcome];
      const result =
        override === undefined ? serviceResult : { ...serviceResult, message: override };
      classifyBookResult(request, result);
      // ALWAYS 200, for every outcome — step CTL-3's rule, inherited
      // deliberately. See the file comment.
      return result;
    });
  });
}
