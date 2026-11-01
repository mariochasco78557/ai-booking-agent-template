import { createHash } from "node:crypto";
import { z } from "zod";
import { UpstreamError } from "../../core/calendar/errors.js";
import { dayPhraseEs, parseDateTime } from "../../utils/dateFormatterEs.js";
import { madridDate, madridWallClock, madridWallToEpochMs } from "../../utils/madridDate.js";
import { maskPhoneStrict } from "../../utils/mask.js";
import type { Logger } from "../authTokenService.js";
import { serviceLabelOf } from "../whatsapp/whatsappNotifier.js";
import { splitByState, type DashboardRange, type DashboardReservation } from "./dashboardMapping.js";
import { mintReservationRef, openReservationRef } from "./reservationRef.js";
import { resolveWaCaller, WA_CALLER_ID_HEADER, type WaCaller } from "./waCallerId.js";
import type {
  CalendarBackOffice,
  CalendarBookingRequest,
  CalendarResource,
} from "../../core/calendar/CalendarProvider.js";
import type { SlotHoldRegistry } from "../slotHolds.js";
import {
  swapService,
  type ServiceChangeAlertPort,
  type ServiceChangeOutcome,
  type ServiceChangeVia,
} from "./serviceChange.js";
import {
  msgCancelled,
  msgCancelPendingOwner,
  msgReservationsFound,
  msgSameService,
  msgServiceChanged,
  msgServiceConfirm,
  msgServiceLost,
  msgServiceNotChanged,
  msgTooLate,
  MSG_SERVICE_TOO_LATE,
  MSG_SERVICE_UNAVAILABLE,
  MSG_INVALID_REQUEST,
  MSG_NOT_CONFIRMED,
  MSG_NOT_FOUND,
  MSG_NO_RESERVATIONS,
  MSG_OWNER_NOTIFICATION_UNAVAILABLE,
  MSG_OWNER_NOTIFIED,
  MSG_RATE_LIMITED,
  MSG_RELOOK,
  MSG_SELF_SERVICE_UNAVAILABLE,
  MSG_UNCERTAIN,
  MSG_UPSTREAM_ERROR,
} from "./waMessages.js";
import {
  CANCEL_GLOBAL,
  CANCEL_PER_PHONE,
  LOOKUP_GLOBAL,
  LOOKUP_PER_PHONE,
  NOTIFY_PER_CALLER,
  WA_LOOKUP_MAX_RESULTS,
  WaRateLimiter,
} from "./waRateLimiter.js";

/**
 * Structural port implemented by the Telegram notifier (block B). Declared
 * here, no shared file (DESIGN §8.3).
 */
export interface OwnerAlertPort {
  readonly mode: "dry_run" | "live";
  /** Never throws, never waits for network. true = enqueued (or already was). */
  enqueueOwnerAlert(
    a: {
      conversationId?: string;
      reason: string;
      summary: string;
      callerPhoneE164?: string;
      callerFormat: string;
      customerName?: string;
      callbackPhone?: string;
    },
    nowMs: number,
  ): boolean;
  enqueueCancellation(
    c: {
      kind: "cancellation_done" | "cancellation_request";
      reservationId: number;
      startsAt: string;
      professional: string | null;
      service: string | null;
      ownerName: string;
      ownerSurnames: string;
      callerPhoneE164: string;
      motive?: "mode" | "allowlist" | "too_late" | "technical" | "unknown";
      dryRun?: boolean;
      via?: "dictated" | "dictated_change";
      /** (internal doc, not included in the template): context for the one-line notices. */
      channel?: "whatsapp" | "voice";
      conversationId?: string;
      noticeMinutes?: number;
      lateNotice?: boolean;
      changeTo?: { startsAt: string; professional: string | null };
    },
    nowMs: number,
  ): boolean;
}

/** Where a cancellation came from, and (voice change) what replaced it. Feeds the owner's agenda notices only. */
export interface CancelNoticeContext {
  channel: "whatsapp" | "voice";
  conversationId?: string;
  changeTo?: { startsAt: string; professional: string | null };
}

export type WaSelfServiceMode = "off" | "lookup_only" | "cancel_dry_run" | "live";

export interface WaSelfServiceConfig {
  mode: WaSelfServiceMode;
  /** E.164 phones allowed to really cancel in `live`. Empty = everybody. */
  allowlist: ReadonlySet<string>;
  refSecret: string;
  refTtlMinutes: number;
  /** 0 (default since 2026-10-08) = a customer may cancel until the start time. */
  cancelMinLeadMinutes: number;
  /** Notice below this many minutes flags `late_notice` (owner's record only). Default 60. */
  lateCancelThresholdMinutes?: number;
  lookupHorizonDays: number;
  telegramLive: boolean;
}

export interface WaResponse {
  outcome: string;
  message: string;
  external_mutation: boolean | null;
  [key: string]: unknown;
}

type Headers = Record<string, string | string[] | undefined>;

// Local copies of the DESIGN §6.2 schemas (block C may centralise them in
// src/schemas/waSelfServiceSchemas.ts). Unknown fields — including any
// `phone` / `caller_id` — are passed through by zod and NEVER read.
const conversationId = z.string().min(1).max(128).optional();
export const waMyReservationsSchema = z.object({ conversation_id: conversationId }).passthrough();
export const waCancelSchema = z
  .object({
    conversation_id: conversationId,
    reservation_ref: z.string().min(1).max(200),
    confirmed_by_customer: z.boolean(),
  })
  .passthrough();
/** 2026-10-11 — `POST /ai/wa/change-service` ((internal doc, not included in the template) §4). */
export const waChangeServiceSchema = z
  .object({
    conversation_id: conversationId,
    reservation_ref: z.string().min(1).max(200),
    service_id: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    confirmed_by_customer: z.boolean().optional(),
  })
  .passthrough();
export const WA_NOTIFY_REASONS = [
  "wants_human",
  "cannot_identify",
  "reservation_not_found",
  "cancel_request",
  "change_request",
  "complaint",
  "other",
] as const;
export const waNotifyOwnerSchema = z
  .object({
    conversation_id: conversationId,
    reason: z.enum(WA_NOTIFY_REASONS),
    summary: z.string().trim().min(1).max(500),
    customer_name: z.string().trim().max(80).optional(),
    callback_phone: z.string().trim().max(32).optional(),
  })
  .passthrough();

const DELETED_MEMORY_MAX = 1000;
const DEFAULT_LATE_CANCEL_THRESHOLD_MINUTES = 60;

/**
 * True when the appointment can no longer be cancelled by the customer: its
 * start (Madrid wall clock, minute resolution) is not later than now + lead.
 * With lead 0 that is exactly "the start time has passed". Unlike
 * `isSlotTooSoon` it also judges dates before today (they have started).
 */
function cancelWindowClosed(startsAt: string, nowMs: number, leadMinutes: number): boolean {
  const parsed = parseDateTime(startsAt);
  if (parsed === null || !parsed.hasTime) return false;
  return wallKey(parsed) <= madridWallClock(nowMs + leadMinutes * 60_000);
}

function wallKey(p: { year: number; month: number; day: number; hour: number; minute: number }): string {
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Whole minutes between now and the start (0 when already started). */
function noticeMinutesOf(startsAt: string, nowMs: number): number {
  const parsed = parseDateTime(startsAt);
  if (parsed === null || !parsed.hasTime) return 0;
  return Math.max(0, Math.floor((madridWallToEpochMs(parsed) - nowMs) / 60_000));
}

interface DeletedEntry {
  expiresAt: number;
  startsAt: string;
  professional: string | null;
  /** Stored so a replay returns the very same record values. */
  noticeMinutes: number;
  lateNotice: boolean;
}

function sha256Hex(value: string, len: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, len);
}

function addDays(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function labels(startsAt: string): { date: string; time: string; day_label: string } {
  const parsed = parseDateTime(startsAt);
  return {
    date: startsAt.slice(0, 10),
    time: startsAt.slice(11, 16),
    day_label: parsed ? dayPhraseEs(parsed) : startsAt.slice(0, 10),
  };
}

/**
 * 2026-10-10 plan B (internal doc, not included in the template): a voice
 * cancel or change done with a DICTATED phone. Only marks the owner's notice
 * («número dictado»); it never changes what is allowed.
 */
export type VoiceCancelVia = "dictated" | "dictated_change";

/**
 * 2026-10-11 — what «cambiar servicio» needs on top of the cancel machinery.
 * Absent (or `mode: "off"`) = every change answers `service_change_unavailable`.
 */
export interface WaServiceChangeConfig {
  /** `SERVICE_CHANGE_MODE`. */
  mode: "off" | "dry_run" | "live";
  /** `ENABLE_WRITE_OPERATIONS`. */
  writeEnabled: boolean;
  /** `SERVICE_CHANGE_MIN_LEAD_MINUTES` (60). */
  minLeadMinutes: number;
  createReservation: (body: CalendarBookingRequest) => Promise<void>;
  employeesDay: (date: string) => Promise<CalendarResource[]>;
  slotHolds: SlotHoldRegistry;
  alerts?: ServiceChangeAlertPort;
}

/** The server's question must be answered no sooner than this (same rule as the voice cancel). */
export const SERVICE_CHANGE_CONFIRM_MIN_GAP_MS = 3_000;
/** A question older than this is asked again. */
export const SERVICE_CHANGE_CONFIRM_TTL_MS = 5 * 60_000;
const SERVICE_CHANGE_MEMORY_MAX = 1000;

interface ServiceChangeMemory {
  expiresAt: number;
  response: WaResponse;
}

export class WaSelfService {
  private readonly lookupPhone = new WaRateLimiter(LOOKUP_PER_PHONE);
  private readonly lookupGlobal = new WaRateLimiter(LOOKUP_GLOBAL);
  private readonly cancelPhone = new WaRateLimiter(CANCEL_PER_PHONE);
  private readonly cancelGlobal = new WaRateLimiter(CANCEL_GLOBAL);
  private readonly notifyCaller = new WaRateLimiter(NOTIFY_PER_CALLER);
  private readonly deleted = new Map<string, DeletedEntry>();
  private readonly locks = new Map<number, Promise<void>>();
  /** 2026-10-11: final answers of service changes that wrote (key `rid|phone|newType`). */
  private readonly serviceChanges = new Map<string, ServiceChangeMemory>();
  /** 2026-10-11: the questions the server asked (key `phone|conversation|rid|newType`) -> asked at. */
  private readonly serviceQuestions = new Map<string, number>();
  /**
   * 2026-10-09 — told the phone of every delete this service attempts, so the
   * per-phone booking limit (`src/services/bookingLimit/`) re-reads the agenda.
   */
  onBookingsChanged?: (phoneE164: string) => void;

  constructor(
    private readonly config: WaSelfServiceConfig,
    private readonly employeeClient: CalendarBackOffice | undefined,
    private readonly notifier: OwnerAlertPort | undefined,
    private readonly logger: Logger,
    private readonly serviceChange?: WaServiceChangeConfig,
  ) {}

  // ---------------------------------------------------------------- lookup

  async myReservations(headers: Headers, body: unknown, nowMs: number): Promise<WaResponse> {
    if (this.config.mode === "off" || !this.employeeClient) return this.simple("self_service_off");
    // Body is irrelevant (the phone is NEVER read from it) but a non-object is still invalid.
    if (!waMyReservationsSchema.safeParse(body ?? {}).success) return this.simple("invalid_request");

    const caller = this.observeCaller(headers);
    if (!caller.ok) return this.simple("identity_unavailable");

    if (
      !this.lookupPhone.check(caller.e164, nowMs) ||
      !this.lookupGlobal.check("global", nowMs)
    ) {
      return this.simple("rate_limited");
    }

    const fromDate = madridDate(nowMs);
    const toDate = addDays(fromDate, this.config.lookupHorizonDays);
    let result;
    try {
      result = await this.readDashboard({ fromDate, toDate });
    } catch (err) {
      if (err instanceof UpstreamError) return this.simple("upstream_error");
      throw err;
    }

    const nowWall = madridWallClock(nowMs);
    const matches = result.live
      .filter((r) => r.ownerPhoneE164 === caller.e164 && r.startsAt > nowWall)
      .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id - b.id));
    const phoneUnusable = result.live.filter((r) => r.ownerPhoneE164 === null).length;
    this.logger.info(
      {
        wa_caller: caller.masked,
        rows_total: result.stats.total,
        rows_unparseable: result.stats.unparseable,
        rows_phone_unusable: phoneUnusable,
        rows_cancelled: result.cancelled,
        rows_state_unknown: result.unknown,
        matches: matches.length,
      },
      "wa lookup: done",
    );

    if (matches.length === 0) return this.simple("no_reservations");

    const reservations = matches.slice(0, WA_LOOKUP_MAX_RESULTS).flatMap((r) => {
      let ref: string;
      try {
        ref = mintReservationRef(
          { reservationId: r.id, startsAt: r.startsAt, phoneE164: caller.e164, nowMs },
          { secret: this.config.refSecret, ttlMinutes: this.config.refTtlMinutes },
        );
      } catch {
        return []; // fail closed: an unmintable row is not offered
      }
      return [
        {
          reservation_ref: ref,
          ...labels(r.startsAt),
          professional: r.employeeName,
          service: serviceLabelOf(r.typeReservation ?? undefined),
          cancellable: !cancelWindowClosed(r.startsAt, nowMs, this.config.cancelMinLeadMinutes),
        },
      ];
    });
    if (reservations.length === 0) return this.simple("upstream_error");
    const moreThanShown = matches.length > WA_LOOKUP_MAX_RESULTS;
    return {
      outcome: "reservations_found",
      message: msgReservationsFound(reservations, moreThanShown),
      reservations,
      more_than_shown: moreThanShown,
      external_mutation: false,
    };
  }

  // ---------------------------------------------------------------- cancel

  async cancel(headers: Headers, body: unknown, nowMs: number): Promise<WaResponse> {
    const mode = this.config.mode;
    if (mode === "off" || !this.employeeClient) return this.simple("self_service_off");

    const parsed = waCancelSchema.safeParse(body);
    if (!parsed.success) return this.simple("invalid_request");

    const caller = this.observeCaller(headers);
    if (!caller.ok) return this.simple("identity_unavailable");

    if (
      !this.cancelPhone.check(caller.e164, nowMs) ||
      !this.cancelGlobal.check("global", nowMs)
    ) {
      return this.simple("rate_limited");
    }

    if (parsed.data.confirmed_by_customer !== true) return this.simple("not_confirmed");

    const opened = openReservationRef(parsed.data.reservation_ref, caller.e164, nowMs, {
      secret: this.config.refSecret,
    });
    if (!opened.ok) {
      return this.simple(opened.reason === "expired" ? "reference_expired" : "invalid_reference");
    }
    const { reservationId: rid, startsAt } = opened;
    const key = `${rid}|${caller.e164}`;

    const finish = (resp: WaResponse): WaResponse => {
      this.logger.info(
        { wa_caller: caller.masked, outcome: resp.outcome, mode, rid_hash: sha256Hex(String(rid), 8) },
        "wa cancel: finished",
      );
      return resp;
    };

    const replay = this.replayOf(key, startsAt, nowMs);
    if (replay) return finish(replay);

    return this.withLock(rid, async () => {
      const again = this.replayOf(key, startsAt, nowMs);
      if (again) return finish(again);
      return finish(
        await this.cancelLocked(caller, rid, startsAt, key, nowMs, undefined, {
          channel: "whatsapp",
          conversationId: parsed.data.conversation_id,
        }),
      );
    });
  }

  private async cancelLocked(
    caller: Extract<WaCaller, { ok: true }>,
    rid: number,
    startsAt: string,
    key: string,
    nowMs: number,
    via?: VoiceCancelVia,
    ctx?: CancelNoticeContext,
  ): Promise<WaResponse> {
    const day = startsAt.slice(0, 10);

    // 9. Re-read the day of the appointment.
    let rows: DashboardReservation[];
    try {
      rows = (await this.readDashboard({ fromDate: day, toDate: day })).live;
    } catch (err) {
      if (err instanceof UpstreamError) return this.simple("upstream_error");
      throw err;
    }
    const row = rows.find((r) => r.id === rid);
    if (!row || row.ownerPhoneE164 !== caller.e164) return this.simple("not_found");
    if (row.startsAt !== startsAt) return this.simple("reservation_changed");

    return this.cancelRow(caller, row, startsAt, key, nowMs, via, ctx);
  }

  /**
   * Steps 10–12 of a cancellation — too late, mode gate, delete (with the
   * verify-on-failure re-read), owner notice and the idempotency memory — for a
   * row ALREADY read from the dashboard and already proven to belong to
   * `caller`. Shared, unchanged, by the WhatsApp cancel above and by the voice
   * change below (2026-10-08): there is one cancel code path, not two.
   */
  private async cancelRow(
    caller: Extract<WaCaller, { ok: true }>,
    row: DashboardReservation,
    startsAt: string,
    key: string,
    nowMs: number,
    via?: VoiceCancelVia,
    ctx?: CancelNoticeContext,
  ): Promise<WaResponse> {
    const client = this.employeeClient!;
    const rid = row.id;
    const day = startsAt.slice(0, 10);
    const info = labels(startsAt);
    const reservation = {
      date: info.date,
      time: info.time,
      day_label: info.day_label,
      professional: row.employeeName,
    };
    const notifyReq = (
      motive: "mode" | "allowlist" | "too_late" | "technical" | "unknown",
      dryRun?: boolean,
    ): boolean => this.enqueueCancellation("cancellation_request", row, caller, nowMs, motive, dryRun, via);

    // 10. Too late: only an appointment that has already started (lead 0) is
    // refused. Bruno's rule, 2026-10-08: any future cancellation goes through.
    if (cancelWindowClosed(startsAt, nowMs, this.config.cancelMinLeadMinutes)) {
      const notified = notifyReq("too_late");
      return {
        outcome: "too_late_to_cancel",
        message: msgTooLate(notified),
        reservation,
        owner_notified: notified,
        external_mutation: false,
      };
    }

    // For the owner's record only; never changes what is allowed.
    const noticeMinutes = noticeMinutesOf(startsAt, nowMs);
    const lateNotice =
      noticeMinutes <
      (this.config.lateCancelThresholdMinutes ?? DEFAULT_LATE_CANCEL_THRESHOLD_MINUTES);

    // 11. Mode gate.
    const mode = this.config.mode;
    const allowlistBlocks =
      mode === "live" && this.config.allowlist.size > 0 && !this.config.allowlist.has(caller.e164);
    if (mode !== "live" || allowlistBlocks) {
      const dryRun = mode === "cancel_dry_run";
      if (dryRun) {
        this.logger.info(
          { wa_caller: caller.masked, rid_hash: sha256Hex(String(rid), 8) },
          "wa cancel: DRY RUN, would delete",
        );
      }
      const notified = notifyReq(allowlistBlocks ? "allowlist" : "mode", dryRun || undefined);
      return {
        outcome: "cancel_pending_owner",
        message: msgCancelPendingOwner(info.day_label, info.time, notified),
        reservation,
        owner_notified: notified,
        notice_minutes: noticeMinutes,
        late_notice: lateNotice,
        ...(dryRun ? { dry_run: true } : {}),
        external_mutation: false,
      };
    }

    // 12. Delete.
    let treatAsDeleted = false;
    // 2026-10-09: the per-phone booking limit must not trust an agenda
    // snapshot taken before this delete. Never throws.
    try {
      this.onBookingsChanged?.(caller.e164);
    } catch {
      // A hook may never fail a cancellation.
    }
    try {
      const outcome = await client.cancelBookingById(rid);
      if (outcome === "not_found") return this.simple("not_found");
      treatAsDeleted = true;
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      try {
        // A row known to be cancelled is gone; an UNKNOWN one still counts as
        // there (fail-closed: a failed delete is never reported done on a guess).
        const check = await this.readDashboard({ fromDate: day, toDate: day });
        if (check.notCancelled.some((r) => r.id === rid)) {
          const notified = notifyReq("technical");
          return {
            outcome: "upstream_error",
            message: MSG_UPSTREAM_ERROR,
            owner_notified: notified,
            external_mutation: false,
          };
        }
        treatAsDeleted = true; // the row is gone: the delete did go through
      } catch (err2) {
        if (!(err2 instanceof UpstreamError)) throw err2;
        const notified = notifyReq("unknown");
        return {
          outcome: "uncertain",
          message: MSG_UNCERTAIN,
          owner_notified: notified,
          external_mutation: null,
        };
      }
    }

    if (treatAsDeleted) this.remember(key, startsAt, row.employeeName, nowMs, noticeMinutes, lateNotice);
    const notified = this.enqueueCancellation("cancellation_done", row, caller, nowMs, undefined, undefined, via, {
      ...(ctx ?? {}),
      noticeMinutes,
      lateNotice,
    });
    return {
      outcome: "cancelled",
      message: msgCancelled(info.day_label, info.time),
      reservation,
      idempotency_status: "original",
      owner_notified: notified,
      notice_minutes: noticeMinutes,
      late_notice: lateNotice,
      external_mutation: true,
    };
  }

  // ------------------------------------------------- voice change (2026-10-08)

  /**
   * Whether a voice change could cancel the OLD booking of `phoneE164` right
   * now: mode `live`, an employee client, the allow list, and both cancel
   * rate limits — checked WITHOUT consuming anything and without I/O. The
   * voice path asks this BEFORE creating the new booking, so a change that
   * cannot be completed is refused while nothing has been written yet.
   */
  canCancelForVoiceChange(phoneE164: string, nowMs: number): boolean {
    if (this.config.mode !== "live" || !this.employeeClient) return false;
    if (this.config.allowlist.size > 0 && !this.config.allowlist.has(phoneE164)) return false;
    return (
      this.cancelPhone.wouldAllow(phoneE164, nowMs) && this.cancelGlobal.wouldAllow("global", nowMs)
    );
  }

  /**
   * Cancels the booking a voice CHANGE replaces, after the new one has been
   * confirmed. The salon's create answers an empty 201 (no id), so the old
   * booking is LOCATED the way WhatsApp locates one: the dashboard of its day,
   * filtered by the phone it was written with, its start and — when known —
   * its barber. Exactly one match is required; zero or several cancel nothing.
   *
   * Then the SAME `cancelRow` the WhatsApp cancel uses: mode gate, delete,
   * verify-on-failure, the owner's Telegram notice, the replay memory.
   *
   * Never throws. `cancelled` = the row is gone; `not_cancelled` = it is
   * known to still be there (or was never found); `unknown` = the delete's
   * fate could not be read back. Every outcome other than `cancelled` leaves
   * the owner a notice, so the duplicate is never silent.
   */
  async cancelForVoiceChange(
    req: {
      conversationId: string;
      phoneE164: string;
      startsAt: string;
      employeeId?: number;
      changeTo?: { startsAt: string; professional: string | null };
    },
    nowMs: number,
  ): Promise<"cancelled" | "not_cancelled" | "unknown"> {
    const caller: Extract<WaCaller, { ok: true }> = {
      ok: true,
      format: "es_phone",
      e164: req.phoneE164,
      masked: maskPhoneStrict(req.phoneE164),
    };
    const done = (outcome: "cancelled" | "not_cancelled" | "unknown", why: string) => {
      this.logger.info(
        { wa_caller: caller.masked, outcome, why, conversation_id: req.conversationId },
        "voice change: old booking cancellation finished",
      );
      if (outcome !== "cancelled" && why !== "cancel_row") this.alertChangeNotCancelled(req, caller, nowMs);
      return outcome;
    };
    try {
      if (!this.canCancelForVoiceChange(req.phoneE164, nowMs)) return done("not_cancelled", "unavailable");
      if (
        !this.cancelPhone.check(req.phoneE164, nowMs) ||
        !this.cancelGlobal.check("global", nowMs)
      ) {
        return done("not_cancelled", "rate_limited");
      }
      const day = req.startsAt.slice(0, 10);
      let rows: DashboardReservation[];
      try {
        rows = (await this.readDashboard({ fromDate: day, toDate: day })).live;
      } catch (err) {
        if (err instanceof UpstreamError) return done("not_cancelled", "dashboard_unreadable");
        throw err;
      }
      const matches = rows.filter(
        (r) =>
          r.ownerPhoneE164 === req.phoneE164 &&
          r.startsAt === req.startsAt &&
          (req.employeeId === undefined || r.employeeId === req.employeeId),
      );
      if (matches.length !== 1) {
        return done("not_cancelled", matches.length === 0 ? "not_found" : "ambiguous");
      }
      const row = matches[0]!;
      const key = `${row.id}|${caller.e164}`;
      const resp = await this.withLock(row.id, async () => {
        const again = this.replayOf(key, row.startsAt, nowMs);
        if (again) return again;
        return this.cancelRow(caller, row, row.startsAt, key, nowMs, undefined, {
          channel: "voice",
          ...(req.changeTo ? { changeTo: req.changeTo } : {}),
        });
      });
      // `cancelRow` already notified the owner on every path it does not
      // complete (too late, mode, technical, unknown) — except `not_found`:
      // the delete answered 404 for a row read a moment ago. Probably gone,
      // but not something we can state, so `unknown`, with the owner's notice.
      if (resp.outcome === "cancelled") return done("cancelled", "cancel_row");
      if (resp.outcome === "uncertain") return done("unknown", "cancel_row");
      if (resp.outcome === "not_found") return done("unknown", "delete_not_found");
      return done("not_cancelled", "cancel_row");
    } catch {
      return done("unknown", "unexpected_error");
    }
  }

  // ------------------------------------- voice self-service (2026-10-10)

  /**
   * 2026-10-10 (internal doc, not included in the template) — the FUTURE standing
   * bookings of `phoneE164`, for the voice agent. Same dashboard read, state
   * filter, horizon and lookup rate limits as «mis citas»; no reference is
   * minted (the voice listing lives in `VoiceManageService`, per call).
   * `phoneE164` is the caller id of the call, never a dictated number.
   */
  async listForVoice(
    phoneE164: string,
    nowMs: number,
  ): Promise<
    | { ok: true; rows: DashboardReservation[] }
    | { ok: false; reason: "off" | "rate_limited" | "upstream_error" }
  > {
    if (this.config.mode === "off" || !this.employeeClient) return { ok: false, reason: "off" };
    if (!this.lookupPhone.check(phoneE164, nowMs) || !this.lookupGlobal.check("global", nowMs)) {
      return { ok: false, reason: "rate_limited" };
    }
    const fromDate = madridDate(nowMs);
    const toDate = addDays(fromDate, this.config.lookupHorizonDays);
    let live: DashboardReservation[];
    try {
      live = (await this.readDashboard({ fromDate, toDate })).live;
    } catch (err) {
      if (err instanceof UpstreamError) return { ok: false, reason: "upstream_error" };
      throw err;
    }
    const nowWall = madridWallClock(nowMs);
    const rows = live
      .filter((r) => r.ownerPhoneE164 === phoneE164 && r.startsAt > nowWall)
      .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id - b.id));
    return { ok: true, rows };
  }

  /**
   * 2026-10-10 — cancels ONE booking for the voice agent, by the id the voice
   * listing read from the dashboard for this caller. The SAME path as the
   * WhatsApp cancel after its reference is opened: cancel rate limits, replay
   * memory, per-reservation lock, re-read of the day (the row must still be
   * this phone's and start at the same minute), then `cancelRow` (too late,
   * mode gate, delete, verify-on-failure, owner's notice). Nothing is sent to
   * the customer. Nothing personal is logged here.
   */
  async cancelForVoice(
    req: {
      phoneE164: string;
      reservationId: number;
      startsAt: string;
      via?: VoiceCancelVia;
      changeTo?: { startsAt: string; professional: string | null };
    },
    nowMs: number,
  ): Promise<WaResponse> {
    if (this.config.mode === "off" || !this.employeeClient) return this.simple("self_service_off");
    const caller: Extract<WaCaller, { ok: true }> = {
      ok: true,
      format: "es_phone",
      e164: req.phoneE164,
      masked: "",
    };
    if (!this.cancelPhone.check(caller.e164, nowMs) || !this.cancelGlobal.check("global", nowMs)) {
      return this.simple("rate_limited");
    }
    const rid = req.reservationId;
    const key = `${rid}|${caller.e164}`;
    const replay = this.replayOf(key, req.startsAt, nowMs);
    if (replay) return replay;
    return this.withLock(rid, async () => {
      const again = this.replayOf(key, req.startsAt, nowMs);
      if (again) return again;
      return this.cancelLocked(caller, rid, req.startsAt, key, nowMs, req.via, {
        channel: "voice",
        ...(req.changeTo ? { changeTo: req.changeTo } : {}),
      });
    });
  }

  /**
   * 2026-10-10 — the old booking of a voice CHANGE of an EXISTING booking
   * (one read by the voice listing, not made in this call), after the new one
   * is confirmed. Never throws. Every outcome other than `cancelled` leaves
   * the owner a notice (from `cancelRow`, or from here), so a duplicate is
   * never silent.
   */
  async cancelExistingForVoiceChange(
    req: {
      conversationId: string;
      phoneE164: string;
      reservationId: number;
      startsAt: string;
      dictated?: boolean;
      changeTo?: { startsAt: string; professional: string | null };
    },
    nowMs: number,
  ): Promise<"cancelled" | "not_cancelled" | "unknown"> {
    const caller: Extract<WaCaller, { ok: true }> = {
      ok: true,
      format: "es_phone",
      e164: req.phoneE164,
      masked: maskPhoneStrict(req.phoneE164),
    };
    const done = (outcome: "cancelled" | "not_cancelled" | "unknown", ownerKnows: boolean) => {
      this.logger.info(
        { outcome, rid_hash: sha256Hex(String(req.reservationId), 8) },
        "voice change (existing booking): old booking cancellation finished",
      );
      if (outcome !== "cancelled" && !ownerKnows) this.alertChangeNotCancelled(req, caller, nowMs);
      return outcome;
    };
    try {
      if (!this.canCancelForVoiceChange(req.phoneE164, nowMs)) return done("not_cancelled", false);
      const { dictated, ...rest } = req;
      const resp = await this.cancelForVoice(
        { ...rest, ...(dictated === true ? { via: "dictated_change" as const } : {}) },
        nowMs,
      );
      const ownerKnows = resp["owner_notified"] === true;
      if (resp.outcome === "cancelled") return done("cancelled", true);
      if (resp.outcome === "uncertain" || resp.outcome === "not_found") return done("unknown", ownerKnows);
      return done("not_cancelled", ownerKnows);
    } catch {
      return done("unknown", false);
    }
  }

  /** The owner's record of a voice change whose old booking is still there. */
  private alertChangeNotCancelled(
    req: { conversationId: string; startsAt: string; dictated?: boolean },
    caller: Extract<WaCaller, { ok: true }>,
    nowMs: number,
  ): void {
    const notifier = this.notifier;
    if (!notifier) return;
    this.safeEnqueue(() =>
      notifier.enqueueOwnerAlert(
        {
          conversationId: req.conversationId,
          reason: "change_request",
          summary:
            `Cambio de cita por llamada: la cita nueva está hecha, pero NO he podido anular ` +
            `la anterior (${req.startsAt}). Revisa la agenda: puede haber dos citas.` +
            (req.dictated === true ? " (número dictado)" : ""),
          callerPhoneE164: caller.e164,
          callerFormat: "voice_change",
        },
        nowMs,
      ),
    );
  }

  // ------------------------------------------- change service (2026-10-11)

  /**
   * (internal doc, not included in the template) — changes ONLY the service of a
   * standing booking of the sender (same day, hour and professional), for the
   * WhatsApp brain. The first call (no `confirmed_by_customer`) NEVER writes:
   * it answers `confirm_required` with the question written from the agenda.
   * Only a second call with `confirmed_by_customer: true` for the SAME
   * reference and `service_id`, at least 3 s later, runs `swapService`.
   */
  async changeService(headers: Headers, body: unknown, nowMs: number): Promise<WaResponse> {
    if (this.config.mode === "off" || !this.employeeClient) return this.simple("service_change_unavailable");

    const parsed = waChangeServiceSchema.safeParse(body);
    if (!parsed.success) return this.simple("invalid_request");

    const caller = this.observeCaller(headers);
    if (!caller.ok) return this.simple("identity_unavailable");

    if (!this.serviceChangeAllowed(caller.e164)) return this.simple("service_change_unavailable");
    if (!this.cancelPhone.wouldAllow(caller.e164, nowMs) || !this.cancelGlobal.wouldAllow("global", nowMs)) {
      return this.simple("rate_limited");
    }

    const opened = openReservationRef(parsed.data.reservation_ref, caller.e164, nowMs, {
      secret: this.config.refSecret,
    });
    if (!opened.ok) {
      return this.simple(opened.reason === "expired" ? "reference_expired" : "invalid_reference");
    }
    const { reservationId: rid, startsAt } = opened;
    const newType = parsed.data.service_id;
    const confirmed = parsed.data.confirmed_by_customer === true;
    const questionKey = `${caller.e164}|${parsed.data.conversation_id ?? ""}|${rid}|${newType}`;

    const ask = (row: DashboardReservation): WaResponse | null => {
      const askedAt = this.serviceQuestions.get(questionKey);
      const elapsed = askedAt === undefined ? -1 : nowMs - askedAt;
      if (confirmed && elapsed >= SERVICE_CHANGE_CONFIRM_MIN_GAP_MS && elapsed <= SERVICE_CHANGE_CONFIRM_TTL_MS) {
        this.serviceQuestions.delete(questionKey);
        return null;
      }
      this.rememberQuestion(questionKey, nowMs);
      const w = this.whenOf(row);
      return {
        outcome: "confirm_required",
        message: msgServiceConfirm(w, serviceLabelOf(row.typeReservation ?? undefined), serviceLabelOf(newType)),
        reservation: { ...w, service: serviceLabelOf(row.typeReservation ?? undefined) },
        new_service: serviceLabelOf(newType),
        external_mutation: false,
      };
    };

    return this.changeCore(caller, rid, startsAt, newType, "whatsapp", parsed.data.conversation_id ?? "", nowMs, ask);
  }

  /**
   * 2026-10-11 — the voice agent's change of ONE booking it listed for this
   * caller (`VoiceManageService` has already asked and got the «sí»; the
   * answers here carry the WhatsApp wording, the voice service rewrites it).
   * Same gates, limits, lock, re-read and `swapService` as WhatsApp.
   */
  async changeServiceForVoice(
    req: {
      phoneE164: string;
      reservationId: number;
      startsAt: string;
      newType: 0 | 1 | 2;
      via?: VoiceCancelVia;
      conversationId?: string;
    },
    nowMs: number,
  ): Promise<WaResponse> {
    if (this.config.mode === "off" || !this.employeeClient) return this.simple("service_change_unavailable");
    const caller: Extract<WaCaller, { ok: true }> = {
      ok: true,
      format: "es_phone",
      e164: req.phoneE164,
      masked: "",
    };
    if (!this.serviceChangeAllowed(caller.e164)) return this.simple("service_change_unavailable");
    if (!this.cancelPhone.wouldAllow(caller.e164, nowMs) || !this.cancelGlobal.wouldAllow("global", nowMs)) {
      return this.simple("rate_limited");
    }
    return this.changeCore(
      caller,
      req.reservationId,
      req.startsAt,
      req.newType,
      req.via === undefined ? "voice" : "voice_dictated",
      req.conversationId ?? "",
      nowMs,
      null,
    );
  }

  /** Mode, write switch, WA live mode, allow list. `dry_run` only logs. */
  private serviceChangeAllowed(phoneE164: string): boolean {
    const sc = this.serviceChange;
    if (!sc || sc.mode === "off") return false;
    if (sc.mode === "dry_run") {
      this.logger.info({}, "service change: DRY RUN, would swap");
      return false;
    }
    if (!sc.writeEnabled || this.config.mode !== "live" || !this.employeeClient) return false;
    if (this.config.allowlist.size > 0 && !this.config.allowlist.has(phoneE164)) return false;
    return true;
  }

  private changeCore(
    caller: Extract<WaCaller, { ok: true }>,
    rid: number,
    startsAt: string,
    newType: 0 | 1 | 2,
    via: ServiceChangeVia,
    conversationId: string,
    nowMs: number,
    ask: ((row: DashboardReservation) => WaResponse | null) | null,
  ): Promise<WaResponse> {
    const key = `${rid}|${caller.e164}|${newType}`;
    const replay = this.serviceReplayOf(key, nowMs);
    if (replay) return Promise.resolve(replay);

    return this.withLock(rid, async () => {
      const again = this.serviceReplayOf(key, nowMs);
      if (again) return again;
      const sc = this.serviceChange!;
      const day = startsAt.slice(0, 10);

      // Re-read the day: the row must still stand, be this phone's and start at the same minute.
      let rows: DashboardReservation[];
      try {
        rows = (await this.readDashboard({ fromDate: day, toDate: day })).live;
      } catch (err) {
        if (err instanceof UpstreamError) return this.simple("service_change_unavailable");
        throw err;
      }
      const row = rows.find((r) => r.id === rid);
      if (!row || row.ownerPhoneE164 !== caller.e164) return this.simple("not_found");
      if (row.startsAt !== startsAt) return this.simple("reservation_changed");
      if (row.employeeId === null || row.typeReservation === null) return this.simple("service_change_unavailable");

      const w = this.whenOf(row);
      const toLabel = serviceLabelOf(newType);
      if (row.typeReservation === newType) {
        return {
          outcome: "same_service",
          message: msgSameService(w, toLabel),
          reservation: { ...w, service: toLabel },
          external_mutation: false,
        };
      }
      if (row.startsAt < madridWallClock(nowMs + sc.minLeadMinutes * 60_000)) {
        return {
          outcome: "service_change_too_late",
          message: MSG_SERVICE_TOO_LATE,
          reservation: { ...w, service: serviceLabelOf(row.typeReservation) },
          external_mutation: false,
        };
      }

      const question = ask?.(row) ?? null;
      if (question) return question;

      // From here on it writes: the cancel limits are consumed.
      if (!this.cancelPhone.check(caller.e164, nowMs) || !this.cancelGlobal.check("global", nowMs)) {
        return this.simple("rate_limited");
      }

      const result = await swapService(
        {
          employeeClient: this.employeeClient!,
          createReservation: sc.createReservation,
          employeesDay: sc.employeesDay,
          slotHolds: sc.slotHolds,
          ...(sc.alerts ? { alerts: sc.alerts } : {}),
          onBookingsChanged: (phone) => this.onBookingsChanged?.(phone),
          minLeadMinutes: sc.minLeadMinutes,
          logger: this.logger,
        },
        { row, newType, via, conversationId },
        nowMs,
      );
      const resp = this.serviceChangeResponse(result.outcome, result.step, row, newType, sc.alerts !== undefined);
      if (
        result.outcome === "service_changed" ||
        result.outcome === "service_change_lost" ||
        result.outcome === "uncertain"
      ) {
        this.rememberServiceChange(key, nowMs, resp);
      }
      return resp;
    });
  }

  private serviceChangeResponse(
    outcome: ServiceChangeOutcome,
    step: string | undefined,
    row: DashboardReservation,
    newType: number,
    ownerNotifiable: boolean,
  ): WaResponse {
    const w = this.whenOf(row);
    const reservation = { ...w, service: serviceLabelOf(row.typeReservation ?? undefined) };
    switch (outcome) {
      case "service_changed":
        return {
          outcome,
          message: msgServiceChanged(w, serviceLabelOf(newType)),
          reservation: { ...w, service: serviceLabelOf(newType) },
          idempotency_status: "original",
          external_mutation: true,
        };
      case "service_not_changed":
        return {
          outcome,
          message: msgServiceNotChanged(w),
          reservation,
          external_mutation: step === "delete" ? false : null,
        };
      case "service_change_lost":
      case "uncertain":
        return {
          outcome,
          message: msgServiceLost(w),
          reservation,
          owner_notified: ownerNotifiable,
          external_mutation: null,
        };
      case "service_change_too_late":
        return { outcome, message: MSG_SERVICE_TOO_LATE, reservation, external_mutation: false };
      case "same_service":
        return { outcome, message: msgSameService(w, serviceLabelOf(newType)), reservation, external_mutation: false };
      case "not_found":
      case "reservation_changed":
        return this.simple(outcome);
      default:
        return this.simple("service_change_unavailable");
    }
  }

  private whenOf(row: DashboardReservation): { date: string; time: string; day_label: string; professional: string | null } {
    const info = labels(row.startsAt);
    return { date: info.date, time: info.time, day_label: info.day_label, professional: row.employeeName };
  }

  private serviceReplayOf(key: string, nowMs: number): WaResponse | null {
    const entry = this.serviceChanges.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs) {
      this.serviceChanges.delete(key);
      return null;
    }
    return { ...entry.response, idempotency_status: "replayed", external_mutation: false };
  }

  private rememberServiceChange(key: string, nowMs: number, response: WaResponse): void {
    for (const [k, v] of this.serviceChanges) {
      if (v.expiresAt <= nowMs) this.serviceChanges.delete(k);
    }
    while (this.serviceChanges.size >= SERVICE_CHANGE_MEMORY_MAX) {
      const oldest = this.serviceChanges.keys().next().value;
      if (oldest === undefined) break;
      this.serviceChanges.delete(oldest);
    }
    this.serviceChanges.set(key, { expiresAt: nowMs + this.config.refTtlMinutes * 60_000, response });
  }

  private rememberQuestion(key: string, nowMs: number): void {
    for (const [k, askedAt] of this.serviceQuestions) {
      if (nowMs - askedAt > SERVICE_CHANGE_CONFIRM_TTL_MS) this.serviceQuestions.delete(k);
    }
    while (this.serviceQuestions.size >= SERVICE_CHANGE_MEMORY_MAX) {
      const oldest = this.serviceQuestions.keys().next().value;
      if (oldest === undefined) break;
      this.serviceQuestions.delete(oldest);
    }
    this.serviceQuestions.delete(key);
    this.serviceQuestions.set(key, nowMs);
  }

  // ---------------------------------------------------------------- notify

  async notifyOwner(headers: Headers, body: unknown, nowMs: number): Promise<WaResponse> {
    const parsed = waNotifyOwnerSchema.safeParse(body);
    if (!parsed.success) return this.simple("invalid_request");
    const data = parsed.data;

    const caller = this.observeCaller(headers);
    const rawHeader = headers[WA_CALLER_ID_HEADER];
    const rawFirst = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader) ?? "";
    let rateKey: string;
    if (caller.ok) rateKey = caller.e164;
    else if (caller.format !== "missing") rateKey = `h:${sha256Hex(rawFirst, 32)}`;
    else rateKey = `c:${data.conversation_id ?? "anon"}`;
    if (!this.notifyCaller.check(rateKey, nowMs)) return this.simple("rate_limited");

    const notifier = this.notifier;
    if (!notifier) return this.simple("owner_notification_unavailable");
    const live = this.config.telegramLive && notifier.mode === "live";
    // Fail closed: only a dry_run notifier enqueues without promising anything.
    if (!live && notifier.mode !== "dry_run") return this.simple("owner_notification_unavailable");

    const enqueued = this.safeEnqueue(() =>
      notifier.enqueueOwnerAlert(
        {
          ...(data.conversation_id ? { conversationId: data.conversation_id } : {}),
          reason: data.reason,
          summary: data.summary,
          ...(caller.ok ? { callerPhoneE164: caller.e164 } : {}),
          callerFormat: caller.format,
          ...(data.customer_name ? { customerName: data.customer_name } : {}),
          ...(data.callback_phone ? { callbackPhone: data.callback_phone } : {}),
        },
        nowMs,
      ),
    );
    if (!live) {
      this.logger.info({ wa_caller: caller.masked, reason: data.reason }, "wa notify: DRY RUN, not promised");
      return { ...this.simple("owner_notification_unavailable"), dry_run: true };
    }
    if (!enqueued) return this.simple("owner_notification_unavailable");
    return this.simple("owner_notified");
  }

  // --------------------------------------------------------------- helpers

  /**
   * 2026-10-09 — the ONLY way this service reads the dashboard: lookup, the
   * cancel re-read, the post-delete check and the voice-change lookup all go
   * through here, so a cancelled (or unreadable-state) row is filtered in one
   * place (`splitByState`). `live` = still standing; `notCancelled` adds the
   * rows of unknown state, for the post-delete check only.
   */
  private async readDashboard(range: DashboardRange): Promise<{
    live: DashboardReservation[];
    notCancelled: DashboardReservation[];
    cancelled: number;
    unknown: number;
    stats: { total: number; unparseable: number };
  }> {
    const result = await this.employeeClient!.listBookings(range);
    const split = splitByState(result.rows);
    if (split.unknown > 0) {
      this.logger.warn(
        { rows_state_unknown: split.unknown, rows_cancelled: split.cancelled },
        "wa dashboard: rows with an unknown state were left out (fail-closed)",
      );
    }
    return { ...split, stats: result.stats };
  }

  /**
   * 2026-10-09 — the standing rows of a range, for the per-phone booking
   * limit: the SAME dashboard read and state filter as «mis citas». Throws
   * when the agenda cannot be read or this service has no employee client
   * (the limit then fails open).
   */
  async readStandingRows(range: DashboardRange): Promise<DashboardReservation[]> {
    if (this.config.mode === "off" || !this.employeeClient) {
      throw new Error("wa self-service has no dashboard reader");
    }
    return (await this.readDashboard(range)).live;
  }

  private observeCaller(headers: Headers): WaCaller {
    const caller = resolveWaCaller(headers);
    this.logger.info(
      { wa_caller_format: caller.format, wa_caller: caller.masked },
      "wa: caller id format observed",
    );
    return caller;
  }

  private simple(outcome: string): WaResponse {
    const messages: Record<string, string> = {
      self_service_off: MSG_SELF_SERVICE_UNAVAILABLE,
      identity_unavailable: MSG_SELF_SERVICE_UNAVAILABLE,
      no_reservations: MSG_NO_RESERVATIONS,
      rate_limited: MSG_RATE_LIMITED,
      upstream_error: MSG_UPSTREAM_ERROR,
      not_confirmed: MSG_NOT_CONFIRMED,
      invalid_reference: MSG_RELOOK,
      reference_expired: MSG_RELOOK,
      reservation_changed: MSG_RELOOK,
      not_found: MSG_NOT_FOUND,
      owner_notified: MSG_OWNER_NOTIFIED,
      owner_notification_unavailable: MSG_OWNER_NOTIFICATION_UNAVAILABLE,
      invalid_request: MSG_INVALID_REQUEST,
      service_change_unavailable: MSG_SERVICE_UNAVAILABLE,
    };
    return { outcome, message: messages[outcome] ?? MSG_INVALID_REQUEST, external_mutation: false };
  }

  private safeEnqueue(fn: () => boolean): boolean {
    try {
      return fn() === true;
    } catch {
      this.logger.warn({}, "wa: owner notice enqueue threw (ignored)");
      return false;
    }
  }

  /** true only if enqueued AND the notifier is really sending (live). */
  private enqueueCancellation(
    kind: "cancellation_done" | "cancellation_request",
    row: DashboardReservation,
    caller: Extract<WaCaller, { ok: true }>,
    nowMs: number,
    motive?: "mode" | "allowlist" | "too_late" | "technical" | "unknown",
    dryRun?: boolean,
    via?: VoiceCancelVia,
    notice?: Partial<CancelNoticeContext> & { noticeMinutes?: number; lateNotice?: boolean },
  ): boolean {
    const notifier = this.notifier;
    if (!notifier) return false;
    const enqueued = this.safeEnqueue(() =>
      notifier.enqueueCancellation(
        {
          kind,
          reservationId: row.id,
          startsAt: row.startsAt,
          professional: row.employeeName,
          service: serviceLabelOf(row.typeReservation ?? undefined),
          ownerName: row.ownerName,
          ownerSurnames: row.ownerSurnames,
          callerPhoneE164: caller.e164,
          ...(motive ? { motive } : {}),
          ...(dryRun ? { dryRun: true } : {}),
          ...(via ? { via } : {}),
          ...(kind === "cancellation_done" && notice
            ? {
                ...(notice.channel ? { channel: notice.channel } : {}),
                ...(notice.conversationId !== undefined ? { conversationId: notice.conversationId } : {}),
                ...(notice.noticeMinutes !== undefined ? { noticeMinutes: notice.noticeMinutes } : {}),
                ...(notice.lateNotice !== undefined ? { lateNotice: notice.lateNotice } : {}),
                ...(notice.changeTo ? { changeTo: notice.changeTo } : {}),
              }
            : {}),
        },
        nowMs,
      ),
    );
    return enqueued && notifier.mode === "live" && this.config.telegramLive;
  }

  private replayOf(key: string, startsAt: string, nowMs: number): WaResponse | null {
    const entry = this.deleted.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs) {
      this.deleted.delete(key);
      return null;
    }
    const info = labels(startsAt);
    return {
      outcome: "cancelled",
      message: msgCancelled(info.day_label, info.time),
      reservation: {
        date: info.date,
        time: info.time,
        day_label: info.day_label,
        professional: entry.professional,
      },
      idempotency_status: "replayed",
      owner_notified: false,
      notice_minutes: entry.noticeMinutes,
      late_notice: entry.lateNotice,
      external_mutation: false,
    };
  }

  private remember(
    key: string,
    startsAt: string,
    professional: string | null,
    nowMs: number,
    noticeMinutes: number,
    lateNotice: boolean,
  ): void {
    for (const [k, v] of this.deleted) {
      if (v.expiresAt <= nowMs) this.deleted.delete(k);
    }
    while (this.deleted.size >= DELETED_MEMORY_MAX) {
      const oldest = this.deleted.keys().next().value;
      if (oldest === undefined) break;
      this.deleted.delete(oldest);
    }
    this.deleted.set(key, {
      expiresAt: nowMs + this.config.refTtlMinutes * 60_000,
      startsAt,
      professional,
      noticeMinutes,
      lateNotice,
    });
  }

  private async withLock<T>(rid: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(rid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.locks.set(rid, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(rid) === chained) this.locks.delete(rid);
    }
  }
}
