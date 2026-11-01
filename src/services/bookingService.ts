import type { CalendarBookingRequest, CalendarProvider } from "../core/calendar/CalendarProvider.js";
import { UpstreamError } from "../core/calendar/errors.js";
import type { Logger } from "./authTokenService.js";
import type { AvailabilityService } from "./availabilityService.js";
import type {
  CallerIdentityResolver,
  IncomingHeaders,
} from "../callerIdentity/resolver.js";
import type { BookInput } from "../schemas/aiSchemas.js";
import {
  bookingConfirmedMessage,
  NEEDS_CONFIRMATION_MESSAGE,
  SLOT_TAKEN_MESSAGE,
  WRITE_DISABLED_BOOK_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  ESCALATION_MESSAGE,
  BOOKING_UNCERTAIN_MESSAGE,
} from "../utils/phrasing.js";
import { maskName, maskPhone, maskPhoneStrict } from "../utils/mask.js";
import { applyBookingDisplayPrefix } from "../utils/displayName.js";
import {
  DEFAULT_MIN_LEAD_MINUTES,
  isSlotAfterEarlyClose,
  isSlotTooSoon,
  type EarlyCloseMap,
} from "../utils/slotLeadTime.js";
import { resolveWaCaller } from "./waSelfService/waCallerId.js";
import type { SlotHoldRegistry } from "./slotHolds.js";

export interface BookingConfig {
  /**
   * ADR-032: when true, a valid `X-AI-WA-Caller-Id` header (Spanish phone)
   * pins the written ownerPhone to the WhatsApp sender. Absent = false, which
   * is every instance except the V2 booking one.
   */
  waCallerPin?: boolean;
  employeeId: number;
  typeReservation: string;
  writeEnabled: boolean;
  /**
   * When true, the barber is resolved from live availability
   * (`/user/employees-day` + `/user/free`): a specific `employeeId` is honoured,
   * otherwise a free barber is chosen deterministically for the exact slot, and
   * its real name/surnames are sourced upstream. When false (default), the
   * original single-employee behaviour is used (fallback `employeeId` + the
   * `employee` display constant below).
   */
  multiBarber: boolean;
  /**
   * step 10 lab upstream mode (src/config/env.ts's `BOOKING_UPSTREAM_MODE`).
   * 'legacy' (default) preserves every existing code path byte-for-byte —
   * everything below this field's own branch in book() is untouched. 'ai'
   * calls the disposable lab's `/v1/ai/reservation` endpoint instead — see
   * bookAi() below. Never enables writes on its own; ENABLE_WRITE_OPERATIONS
   * (`writeEnabled` below) stays the independent kill-switch.
   */
  upstreamMode: "legacy" | "ai";
  /**
   * *** step CTL-3 — READ THIS BEFORE CHANGING THE `owner` FIELD. ***
   *
   * Who the reservation is attributed to upstream.
   *
   * `"service_account"` (the original behaviour) sends `owner.id =
   * BOOKING_DEFAULT_OWNER_ID`. That turned out to be the single cause of two
   * separate production defects, both observed on 2026-08-30:
   *
   * 1. **Only ONE appointment could ever exist.** The legacy controller
   *    rejects a create when the *authenticated* user already holds a
   *    reservation — `if (!isGranted('ROLE_EMPLOYEE')) { if
   *    (findUserReservationsByUSerCount($this->getUser()) > 0) block }`
   *    (`ReservationsController.php:75-79`). Because line 82-83 force-sets
   *    the owner FK to that same service account, our first booking made the
   *    count 1 and every later booking — any customer, any day, any barber —
   *    came back HTTP 400. Registered or unregistered callers were equally
   *    blocked; the phone number was never the problem.
   * 2. **The diary showed the wrong name.** The panel's dashboard query
   *    left-joins `owner` *and* selects the denormalized `ownerName`
   *    (`ReservationRepository.php:54-58`), so the card rendered the service
   *    account's name while the detail rendered `ownerName`.
   *
   * `"guest"` omits `owner` from the payload entirely. The conditional at
   * line 82-83 then leaves `reservation.user_id` NULL — a shape the schema
   * allows and, decisively, the shape the salon's OWN booking form already
   * produces: the compiled client sends `typeReservation`/`ownerName`/
   * `ownerSurnames`/`ownerPhone` and no `owner`
   * ((internal doc, not included in the template) §4). Every manual
   * and web reservation in the salon is already unowned. So guest mode is not
   * a new kind of row — it is the *normal* kind, and it needs no Symfony
   * change, no migration, no `ROLE_AGENT`, and no account created for anyone
   * who phones.
   *
   * Defaults to `"service_account"` in code so every pre-existing test keeps
   * exercising the exact path it was written for; the running deployment
   * selects `"guest"` through `BOOKING_BOOKING_OWNER_MODE`, which makes the
   * rollback one environment variable.
   */
  ownerMode: "service_account" | "guest";
  owner: {
    id?: number;
    name?: string;
    surnames?: string;
  };
  /**
   * Employee display name/surnames used in the reservation payload when
   * multi-barber is disabled. Temporary local fallback only (see
   * (internal doc, not included in the template) #5); in multi-barber mode these are ignored in
   * favour of the live `/user/employees-day` values.
   */
  employee: { name: string; surnames: string };
  /**
   * `BALANCED_MIN_LEAD_MINUTES` (incident 2026-09-18). A reservation for TODAY
   * whose start is not strictly later than now + this many minutes is refused
   * as `slot_taken` before anything is read or written — see
   * `src/utils/slotLeadTime.ts`. Defaults to {@link DEFAULT_MIN_LEAD_MINUTES}.
   */
  minLeadMinutes?: number;
  /** `BALANCED_EARLY_CLOSE`: slots at/after a weekday's early close are refused like a gone slot. */
  earlyClose?: EarlyCloseMap;
}

/**
 * Per-CALL options for {@link BookingService.book}. Deliberately a separate
 * argument rather than a field on `BookInput`: `BookInput` is what a Zod
 * schema parses out of an HTTP request body, so anything living there is
 * something a caller — and therefore the LLM — can set. Everything here is
 * decided by the process from its own configuration, and no request body has
 * a path to it.
 */
export interface BookOptions {
  /**
   * Agenda-visible marker for an appointment created by the VOICE channel
   * (step CTL, (internal doc, not included in the template) ADR-012). Supplied by
   * `VoiceBookingService` from `VOICE_BOOKING_DISPLAY_PREFIX`, and by nobody
   * else — `POST /ai/book` passes no options at all, so its bookings are
   * written exactly as they were before this existed.
   *
   * It affects ONE field of the upstream payload: `ownerName`. Not
   * `ownerSurnames`, not `owner.*`, not the phone, not the fingerprint, not
   * a log line, and not one word the agent speaks.
   */
  displayPrefix?: string;
  /**
   * 2026-10-08 — called once, on a CONFIRMED write, with the phone actually
   * written as `ownerPhone` (the spoken one, or the verified/WhatsApp caller it
   * was pinned to). A callback rather than a result field on purpose:
   * `POST /ai/book` returns the result object as-is, and a phone must never
   * reach a response. `VoiceBookingService` uses it to locate the booking a
   * voice change replaces; it never returns or journals it.
   */
  onOwnerPhoneWritten?: (phone: string) => void;
}

/**
 * How durable this outcome is, for the idempotency state machine in
 * `src/services/voiceBookingService.ts` (step CTL-3, phase 3).
 *
 * - `confirmed` — the appointment exists. Replay the same answer forever.
 * - `rejected`  — it definitively does not exist, and repeating the identical
 *                 command would be rejected identically. Replay the refusal;
 *                 never write again.
 * - `uncertain` — we do not know. The write may have landed. This is the one
 *                 state that must NEVER be retried automatically: a retry
 *                 risks a duplicate appointment the customer only finds out
 *                 about at the salon.
 */
export type BookOutcomeClass = "confirmed" | "rejected" | "uncertain";

export interface BookResult {
  success: boolean;
  message: string;
  /** Internal reason (never customer-facing) for observability. */
  reason?:
    | "not_confirmed"
    | "write_disabled"
    | "slot_taken"
    | "misconfigured_owner"
    | "upstream_error"
    | "uncertain"
    | "ok";
  /**
   * Whether a create request actually left this process for the salon's API.
   *
   * The idempotency store needs this and `outcomeClass` is not enough on its
   * own: a booking refused by our own kill-switch and a booking refused by
   * upstream are both `rejected`, but only the second one may have touched
   * anything. Kept honest at every return site below.
   */
  upstreamAttempted: boolean;
  /** See {@link BookOutcomeClass}. */
  outcomeClass: BookOutcomeClass;
  reservationId?: number;
  /** Additive (ai upstream mode only): the opaque ref Symfony returned. */
  reservationRef?: string;
}

/**
 * Classifies a failed upstream write.
 *
 * A 4xx is the salon's API telling us it looked at the request and refused it
 * BEFORE writing anything — a validation error, the per-user reservation cap,
 * a rejected field. Repeating it byte-for-byte gets the same refusal, so it is
 * safely `rejected`.
 *
 * Everything else is `uncertain`: a 5xx means the request was received and may
 * have been half-applied, and no response at all (timeout, reset connection,
 * DNS) means we never learned whether the row was written. Both must be
 * treated as "an appointment might exist upstream".
 */
function classifyUpstreamFailure(status: number | undefined): BookOutcomeClass {
  return status !== undefined && status >= 400 && status < 500 ? "rejected" : "uncertain";
}

/** Upper bound on how much upstream prose is allowed into a log line. */
const UPSTREAM_LOG_MAX = 300;

/** Bounds an upstream message before it reaches a log. Never throws. */
function truncateForLog(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > UPSTREAM_LOG_MAX ? `${flat.slice(0, UPSTREAM_LOG_MAX)}…` : flat;
}

/**
 * Result of `BookingService.resolveOwnerPhone()` — design §10.2/§13, senior
 * finding B8. `phone` is the value that will actually be written upstream as
 * `ownerPhone`/`customer.phone`; `pinned` records WHY, purely for logging
 * (it never reaches any upstream request — see resolveOwnerPhone()'s own
 * comment for why no such field is invented).
 */
interface ResolvedOwnerPhone {
  phone: string;
  pinned: boolean;
}

/** Heuristic: does the upstream message indicate the slot is gone? */
function looksLikeSlotTaken(msg?: string): boolean {
  if (!msg) return false;
  return /no est[aá]n? disponible|ya no est/i.test(msg);
}

export class BookingService {
  constructor(
    private readonly calendar: CalendarProvider,
    private readonly availability: AvailabilityService,
    private readonly identityResolver: CallerIdentityResolver,
    private readonly config: BookingConfig,
    private readonly logger: Logger,
    /**
     * 2026-10-11 ((internal doc, not included in the template) §2.2): slots held by a
     * service change in flight. Absent = no check (every older caller).
     */
    private readonly slotHolds?: Pick<SlotHoldRegistry, "isHeld">,
  ) {}

  async book(
    input: BookInput,
    headers: IncomingHeaders,
    nowMs: number,
    options: BookOptions = {},
  ): Promise<BookResult> {
    // 1. Hard safety gate — never book without explicit confirmation.
    if (input.confirmedByCustomer !== true) {
      return {
        success: false,
        message: NEEDS_CONFIRMATION_MESSAGE,
        reason: "not_confirmed",
        upstreamAttempted: false,
        outcomeClass: "rejected",
      };
    }

    // *** AN HOUR THAT HAS ALREADY STARTED CANNOT BE BOOKED (2026-09-18). ***
    //
    // The one door every write goes through — V1, V4 and V5 alike — so a token
    // minted for 10:30 and spent at 10:40 is refused here whatever route it
    // came in by. Before the owner resolution, before either upstream mode,
    // before any read: zero upstream calls. `slot_taken` because that is what
    // it means to the caller and to the idempotency journal: that hour is no
    // longer available, choose another (never a new outcome name for V4).
    // The same door refuses a slot at/after the weekday's early close (Saturday
    // afternoon): a filter on top of the live agenda, zero upstream calls.
    if (
      isSlotTooSoon(
        input.reservationDate,
        nowMs,
        this.config.minLeadMinutes ?? DEFAULT_MIN_LEAD_MINUTES,
      ) ||
      isSlotAfterEarlyClose(input.reservationDate, this.config.earlyClose ?? new Map())
    ) {
      this.logger.warn({}, "book refused: the slot has already started, is within the minimum lead time or is after the early close");
      return {
        success: false,
        message: SLOT_TAKEN_MESSAGE,
        reason: "slot_taken",
        upstreamAttempted: false,
        outcomeClass: "rejected",
      };
    }

    // Design §10.2/§13, senior finding B8 (the booking-write asymmetry):
    // decided ONCE, here, before either upstream branch below builds its
    // own request body, so 'legacy' and 'ai' upstream modes inherit the
    // exact same rule. See resolveOwnerPhone() for what it does and why.
    const ownerPhone = this.resolveOwnerPhone(input, headers, nowMs);

    // step 10 lab upstream mode: delegate entirely to the disposable-lab
    // `/v1/ai/reservation` contract. Everything below this branch (the
    // legacy multi-barber resolution, /user/free re-check, owner-id
    // strategy, /reservation call) is untouched and only reached in
    // 'legacy' mode (the default).
    //
    // step CTL / ADR-012: `options.displayPrefix` is deliberately NOT
    // forwarded into this branch. The lab contract has a single `customer.name`
    // that is at once the canonical name AND the displayed one, so marking it
    // would mean corrupting the canonical value — the one thing ADR-012
    // forbids. Rather than leave that as a silent hole in which a voice
    // booking lands in a real diary UNMARKED, `src/config/env.ts` refuses to
    // boot a production process that has creation armed, a marker configured
    // and `BOOKING_UPSTREAM_MODE=ai` at the same time. The gap is closed at
    // boot, not papered over here.
    if (this.config.upstreamMode === "ai") {
      const aiResult = await this.bookAi(input, ownerPhone);
      if (aiResult.outcomeClass === "confirmed") options.onOwnerPhoneWritten?.(ownerPhone.phone);
      return aiResult;
    }

    const type = input.typeReservation ?? this.config.typeReservation;

    // 2. Re-check availability immediately before writing (race protection),
    //    and resolve the concrete barber to book.
    let employeeRef: { id: number; name: string; surnames: string };
    if (this.config.multiBarber) {
      // Multi-barber: honour an explicit employeeId, else pick a free barber
      // deterministically for the exact slot; sources real name/surnames.
      const resolved = await this.availability.resolveEmployeeForBooking({
        reservationDate: input.reservationDate,
        employeeId: input.employeeId,
        type,
      });
      if (!resolved.available || !resolved.employee) {
        return {
          success: false,
          message: SLOT_TAKEN_MESSAGE,
          reason: "slot_taken",
          upstreamAttempted: false,
          outcomeClass: "rejected",
        };
      }
      employeeRef = resolved.employee;
    } else {
      // Single-employee (original behaviour): fallback employeeId + constants.
      const employeeId = input.employeeId ?? this.config.employeeId;
      const check = await this.availability.checkSlot({
        reservationDate: input.reservationDate,
        employeeId,
      });
      if (!check.available) {
        return {
          success: false,
          message: SLOT_TAKEN_MESSAGE,
          reason: "slot_taken",
          upstreamAttempted: false,
          outcomeClass: "rejected",
        };
      }
      employeeRef = {
        id: employeeId,
        name: this.config.employee.name,
        surnames: this.config.employee.surnames,
      };
    }

    // 3. Kill-switch: run every check but do not write upstream.
    if (!this.config.writeEnabled) {
      this.logger.warn(
        {
          employeeId: employeeRef.id,
          customer: maskName(input.customer.name, input.customer.surnames),
          phone: maskPhone(input.customer.phone),
        },
        "book blocked: ENABLE_WRITE_OPERATIONS=false",
      );
      return {
        success: false,
        message: WRITE_DISABLED_BOOK_MESSAGE,
        reason: "write_disabled",
        upstreamAttempted: false,
        outcomeClass: "rejected",
      };
    }

    // 4. Owner strategy.
    //
    // In `guest` mode there is no owner to misconfigure: the payload carries
    // none, upstream leaves `user_id` NULL, and `BOOKING_DEFAULT_OWNER_ID`
    // becomes irrelevant. This gate therefore only applies to the legacy
    // `service_account` mode, which really does need a real user id.
    if (this.config.ownerMode === "service_account" && this.config.owner.id == null) {
      this.logger.error(
        {},
        "book blocked: BOOKING_DEFAULT_OWNER_ID not configured (owner strategy)",
      );
      return {
        success: false,
        message: ESCALATION_MESSAGE,
        reason: "misconfigured_owner",
        upstreamAttempted: false,
        outcomeClass: "rejected",
      };
    }

    // 2026-10-11: a service change holds this slot between its DELETE and its
    // POST. Refused like a gone slot, before any upstream write.
    if (this.slotHolds?.isHeld(employeeRef.id, input.reservationDate) === true) {
      this.logger.warn({}, "book refused: the slot is held by a service change in flight");
      return {
        success: false,
        message: SLOT_TAKEN_MESSAGE,
        reason: "slot_taken",
        upstreamAttempted: false,
        outcomeClass: "rejected",
      };
    }

    const body: CalendarBookingRequest = {
      reservationDate: input.reservationDate,
      typeReservation: type,
      employee: {
        id: employeeRef.id,
        name: employeeRef.name,
        surnames: employeeRef.surnames,
      },
      // *** THE OWNER FK — the field that caused both 2026-08-30 defects. ***
      //
      // Spread in only for `service_account` mode. Upstream's conditional
      // (`ReservationsController.php:82-83`) means supplying ANY owner makes
      // the row belong to our service account, which both trips the
      // one-reservation-per-user cap on the very next booking and puts the
      // service account's name on the panel's card. In `guest` mode the key
      // is absent from the JSON entirely — not null, absent — so
      // `$reservation->getOwner()` is falsy and `user_id` stays NULL, exactly
      // as it does for every booking the salon takes through its own form.
      // See `BookingConfig.ownerMode`.
      ...(this.config.ownerMode === "service_account"
        ? {
            owner: {
              // CANONICAL, never marked. Upstream overwrites this FK with the
              // authenticated service account anyway, so the marker would be
              // discarded here even if it were applied — and applying it
              // would corrupt the only place the caller's raw spoken name
              // survives in the payload for anyone reading it back.
              id: this.config.owner.id as number,
              name: this.config.owner.name ?? input.customer.name,
              surnames: this.config.owner.surnames ?? input.customer.surnames,
            },
          }
        : {}),
      // *** THE AI MARKER LANDS HERE, AND ONLY HERE (ADR-012). ***
      // `ownerName` is the column Bruno's panel actually renders
      // (`ReservationRepository::findReservationsDashboard`), and the legacy
      // Reservation entity has no source/channel/actor column to carry the
      // fact structurally. `options.displayPrefix` is empty for every caller
      // except the voice endpoint, so this is a no-op for `/ai/book`.
      ownerName: applyBookingDisplayPrefix(
        input.customer.name,
        options.displayPrefix ?? "",
      ),
      // Surnames stay CLEAN, on purpose: one marker per row is what makes it
      // scannable. Marking both would read as part of the customer's name.
      ownerSurnames: input.customer.surnames,
      // ownerPhone: design §10.2/§13 (senior finding B8). `ownerPhone.phone`
      // is EITHER `identity.phoneE164` (pinned, verified caller) OR the
      // spoken `input.customer.phone` (no verified identity — today's
      // unchanged behaviour) — decided ONCE by resolveOwnerPhone() above,
      // never `input.customer.phone` directly. Acceptance is still
      // UNVERIFIED upstream either way; documented in KNOWN_LIMITATIONS.
      ownerPhone: ownerPhone.phone,
    };

    try {
      const created = await this.calendar.createBooking(body);
      // step LAT: the agenda just changed. Drop every cached view of that day
      // BEFORE returning, so no subsequent caller can be offered the hour we
      // have just taken, and warm it again behind us.
      this.invalidateAgenda(input.reservationDate, type);
      this.logger.info(
        {
          reservationId: created.id,
          employeeId: employeeRef.id,
          customer: maskName(input.customer.name, input.customer.surnames),
          // Masked with maskPhoneStrict() when the phone written is the
          // pinned, credential-grade identity; maskPhone() otherwise — same
          // rule resolveOwnerPhone() itself uses (design §10).
          phone: ownerPhone.pinned
            ? maskPhoneStrict(ownerPhone.phone)
            : maskPhone(ownerPhone.phone),
        },
        "reservation created",
      );
      options.onOwnerPhoneWritten?.(ownerPhone.phone);
      return {
        success: true,
        message: bookingConfirmedMessage(input.reservationDate),
        reason: "ok",
        upstreamAttempted: true,
        outcomeClass: "confirmed",
        reservationId: created.id,
      };
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : undefined;
      if (err instanceof UpstreamError && looksLikeSlotTaken(err.upstreamMessage)) {
        // A conflict is upstream telling us our picture of that day is stale —
        // someone took the hour between our revalidation and our write. That
        // is precisely when the cached day must go, so the next caller is not
        // offered the same hour again.
        this.invalidateAgenda(input.reservationDate, type);
        return {
          success: false,
          message: SLOT_TAKEN_MESSAGE,
          reason: "slot_taken",
          upstreamAttempted: true,
          outcomeClass: "rejected",
        };
      }
      const outcomeClass = classifyUpstreamFailure(status);
      // step CTL-3: log the upstream's own words, truncated.
      //
      // The 2026-08-30 failure was diagnosable only by inference, because this
      // line recorded the status and threw the body away — and the container
      // that held even that line was recreated before anyone read it. The
      // message upstream sends here is operational text about ITS OWN rules
      // ("ya tiene una reserva…"), not customer data; it is capped so a
      // pathological body cannot flood the log, and nothing from the request
      // (no name, no phone) is added to it.
      this.logger.error(
        {
          status,
          outcome_class: outcomeClass,
          upstream_message: truncateForLog(
            err instanceof UpstreamError ? err.upstreamMessage : undefined,
          ),
        },
        "createReservation failed",
      );
      return {
        success: false,
        message: outcomeClass === "uncertain" ? BOOKING_UNCERTAIN_MESSAGE : GENERIC_ERROR_MESSAGE,
        reason: outcomeClass === "uncertain" ? "uncertain" : "upstream_error",
        upstreamAttempted: true,
        outcomeClass,
      };
    }
  }

  /**
   * Invalidates and re-warms the agenda cache for the day a write touched.
   *
   * Wrapped in try/catch on purpose: cache bookkeeping must never be able to
   * turn a SUCCESSFUL booking into an error the customer hears about. The
   * worst case if this throws is a day that stays cached until its TTL — a
   * couple of minutes — which is the same window the design already accepts.
   */
  private invalidateAgenda(reservationDate: string, serviceId: string): void {
    try {
      this.availability.invalidateAndWarm(reservationDate.slice(0, 10), serviceId);
    } catch {
      // Deliberately silent: see above.
    }
  }

  // ---------------------------------------------------------------------
  // *** THE B8 GATE — design §10.2/§13, senior finding B8. Read this      ***
  // *** before touching `ownerPhone` anywhere else in this file.          ***
  //
  // `ownerPhone`/`customer.phone` upstream is the EXACT column lookup
  // matches on and `confirm.phone` is compared against (the same field
  // `LookupService`/`CancellationService` pin `identity.phoneE164` to for
  // READS and cancellation WRITES — see src/services/lookupService.ts and
  // src/services/cancellationService.ts). Left as the LLM-transcribed
  // `customer.phone` for THIS write, an attacker can book stating a
  // victim's number: the victim's own next verified lookup then returns a
  // booking they never made, and upstream's one-booking-per-phone rule
  // (`DUPLICATE_CALLER_BOOKING`) means that booking LOCKS the victim out of
  // booking by phone entirely — a targeted denial of service costing one
  // phone call.
  // ---------------------------------------------------------------------

  /**
   * Decides which phone gets written upstream as `ownerPhone`/`customer.phone`
   * for THIS booking. Called exactly once per `book()` call, before either
   * upstream branch builds its own request body.
   */
  /**
   * 2026-10-09 — the phone {@link resolveOwnerPhone} WOULD write for this
   * spoken/typed phone and these headers, without logging anything. Used by
   * the per-phone booking limit, so it counts the number the booking will
   * really carry. Pure: the identity resolver has no side effects.
   */
  writtenOwnerPhone(customerPhone: string, headers: IncomingHeaders, nowMs: number): string {
    const resolved = this.identityResolver.resolve(headers, nowMs);
    if (resolved.ok && resolved.identity.trustLevel === "verified") return resolved.identity.phoneE164;
    if (this.config.waCallerPin === true) {
      const wa = resolveWaCaller(headers);
      if (wa.ok) return wa.e164;
    }
    return customerPhone;
  }

  private resolveOwnerPhone(
    input: BookInput,
    headers: IncomingHeaders,
    nowMs: number,
  ): ResolvedOwnerPhone {
    const resolved = this.identityResolver.resolve(headers, nowMs);

    // Only a FULLY VERIFIED identity pins the phone. An `asserted`
    // (unattested provider_header) identity is deliberately NOT enough
    // here — the same read/write split design §4.1.1 draws for lookup vs.
    // cancellation (senior finding B6), applied to this write for the
    // first time: an unproven claim about who is calling must never be
    // allowed to silently rewrite what gets PERSISTED under someone's name,
    // any more than it may authorize destroying someone else's booking.
    // `trustLevel === "asserted"` therefore falls straight through to the
    // unverified branch below, unchanged.
    if (resolved.ok && resolved.identity.trustLevel === "verified") {
      this.logger.info(
        {
          phone: maskPhoneStrict(resolved.identity.phoneE164),
          source: resolved.identity.verification.source,
        },
        "book: owner phone pinned to verified caller identity (design §10.2, senior finding B8) — spoken customer.phone ignored",
      );
      return { phone: resolved.identity.phoneE164, pinned: true };
    }

    // ADR-032: WhatsApp sender pin. Only on the instance configured with
    // `waCallerPin`, and only when the dedicated header carries a valid
    // Spanish phone; otherwise falls through unchanged.
    if (this.config.waCallerPin === true) {
      const wa = resolveWaCaller(headers);
      if (wa.ok) {
        this.logger.info(
          { phone: wa.masked, source: "wa_caller_id" },
          "book: owner phone pinned to WhatsApp sender (ADR-032) — LLM-provided customer.phone ignored",
        );
        return { phone: wa.e164, pinned: true };
      }
    }

    // No verified identity resolved — `AI_CALLER_ID_TRUST_MODE=none` (the
    // default) or any missing/unverified/asserted case. TODAY'S BEHAVIOUR,
    // UNCHANGED: the spoken `customer.phone` is used, exactly as before
    // this wave — this is the normal path, and a first-time caller with no
    // verified identity must still be able to book. There is no upstream
    // field to carry "this phone is unverified" — Symfony's contract has
    // no such field, and inventing one here would be a false claim against
    // it — so this fact is recorded ONLY in this log line, never sent
    // upstream and never surfaced to the caller.
    this.logger.info(
      { phone: maskPhone(input.customer.phone) },
      "book: owner phone recorded from unverified, spoken customer.phone (no verified caller identity resolved) — default, unchanged behaviour",
    );
    return { phone: input.customer.phone, pinned: false };
  }

  // ---------------------------------------------------------------------
  // step 10 lab upstream mode (`upstreamMode === "ai"`). Delegates entirely
  // to POST /v1/ai/reservation, which performs its own write guard,
  // owner-phone guard, employee/type validation, availability re-check and
  // per-caller-telephone duplicate rule server-side (design §7.2) — the
  // middleware does not duplicate any of that here, it only maps the
  // envelope/machine-code to the SAME caller-facing messages the legacy
  // path already uses.
  // ---------------------------------------------------------------------

  private async bookAi(input: BookInput, ownerPhone: ResolvedOwnerPhone): Promise<BookResult> {
    const type = input.typeReservation ?? this.config.typeReservation;
    const employeeId = input.employeeId ?? this.config.employeeId;

    try {
      const envelope = await this.calendar.createCheckedBooking({
        customer: {
          name: input.customer.name,
          surnames: input.customer.surnames,
          // Design §10.2/§13, senior finding B8: this ai-mode upstream
          // enforces `DUPLICATE_CALLER_BOOKING` on exactly this field
          // (design §7.2) — the same column a spoofed spoken phone would
          // both write AND lock a victim out of. `ownerPhone.phone`, never
          // `input.customer.phone` directly; see resolveOwnerPhone() above.
          phone: ownerPhone.phone,
        },
        reservationDate: input.reservationDate,
        employeeId,
        typeReservation: Number(type),
      });

      if (!envelope.ok) {
        if (envelope.code === "SLOT_TAKEN" || envelope.code === "DUPLICATE_CALLER_BOOKING") {
          this.invalidateAgenda(input.reservationDate, type);
        }
        // A structured envelope IS a definite answer from upstream: it looked
        // at the command and refused it. Deterministic, so `rejected`.
        return this.mapAiBookingFailure(envelope.code, "rejected");
      }

      // Same rule as the legacy path: the agenda changed, so the cached day
      // goes before this call returns.
      this.invalidateAgenda(input.reservationDate, type);
      this.logger.info(
        {
          reservationRef: envelope.data.reservationRef,
          employeeId,
          customer: maskName(input.customer.name, input.customer.surnames),
          phone: ownerPhone.pinned
            ? maskPhoneStrict(ownerPhone.phone)
            : maskPhone(ownerPhone.phone),
        },
        "reservation created (ai upstream mode)",
      );
      return {
        success: true,
        message: bookingConfirmedMessage(input.reservationDate),
        reason: "ok",
        upstreamAttempted: true,
        outcomeClass: "confirmed",
        reservationRef: envelope.data.reservationRef,
      };
    } catch (err) {
      // A THROWN error carries no envelope, so we only know the transport
      // outcome. Same rule as the legacy path: 4xx is a definite refusal,
      // anything else (5xx, timeout, reset) is genuinely unknown.
      const status = err instanceof UpstreamError ? err.status : undefined;
      return this.mapAiBookingFailure(
        err instanceof UpstreamError ? err.code : undefined,
        classifyUpstreamFailure(status),
      );
    }
  }

  /**
   * Maps a `/v1/ai/reservation` machine `code` to the SAME caller-facing
   * behaviour the legacy path already uses for the equivalent situation.
   * WRITE_OPERATIONS_DISABLED maps to the existing write-kill-switch
   * message/reason (never a generic error) -- explicitly required, not
   * merely a nice-to-have. No code or technical detail ever reaches
   * `message`.
   */
  private mapAiBookingFailure(
    code?: string,
    outcomeClass: BookOutcomeClass = "rejected",
  ): BookResult {
    if (code === "WRITE_OPERATIONS_DISABLED") {
      this.logger.warn({}, "book blocked: upstream reports WRITE_OPERATIONS_DISABLED (ai mode)");
      return {
        success: false,
        message: WRITE_DISABLED_BOOK_MESSAGE,
        reason: "write_disabled",
        upstreamAttempted: true,
        outcomeClass: "rejected",
      };
    }
    if (code === "SLOT_TAKEN" || code === "DUPLICATE_CALLER_BOOKING") {
      return {
        success: false,
        message: SLOT_TAKEN_MESSAGE,
        reason: "slot_taken",
        upstreamAttempted: true,
        outcomeClass: "rejected",
      };
    }
    this.logger.error({ code, outcome_class: outcomeClass }, "ai reservation failed");
    return {
      success: false,
      message: outcomeClass === "uncertain" ? BOOKING_UNCERTAIN_MESSAGE : GENERIC_ERROR_MESSAGE,
      reason: outcomeClass === "uncertain" ? "uncertain" : "upstream_error",
      upstreamAttempted: true,
      outcomeClass,
    };
  }
}
