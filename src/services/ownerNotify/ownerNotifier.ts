import { createHash } from "node:crypto";

import { madridDate, madridHour } from "../../utils/madridDate.js";
import type { Logger } from "../authTokenService.js";
import type { ServiceChangeNotice } from "../waSelfService/serviceChange.js";
import {
  formatAgendaLine,
  formatDigest,
  formatDigestHeader,
  shortCustomer,
  shortProfessional,
  type AgendaChannel,
  type AgendaEvent,
  type AgendaLineEvent,
} from "./agendaLines.js";
import {
  formatCancellationMessage,
  formatOwnerAlertMessage,
  formatWaBookingMessage,
  type CancellationMotive,
} from "./ownerMessages.js";
import {
  FileOwnerNotifyQueueStore,
  type OwnerJob,
  type OwnerJobKind,
  type OwnerNotifyQueueStore,
} from "./ownerNotifyQueueStore.js";
import type { OpeningGatePort } from "../recados/openingHoursGate.js";
import { TelegramClient } from "./telegramClient.js";

/**
 * *** NOTICES TO THE OWNER (Telegram) — AND THE WALL BETWEEN THEM AND THE CANCELLATION. ***
 *
 * Same rule as `whatsappNotifier.ts`: nothing here may change the outcome or
 * the latency of a cancellation or a booking. `enqueue*` NEVER throws and never
 * awaits network: it appends one fsynced line and returns. The HTTP send is in
 * a worker. Logs never carry a message text, a name or a phone (a job's `text`
 * holds them on purpose, for the owner); the bot token never leaves
 * `TelegramClient`.
 */

export type TelegramNotifyMode = "off" | "dry_run" | "live";

export const OWNER_WORKER_INTERVAL_MS = 5_000;
export const OWNER_MAX_ATTEMPTS = 8;
/** Backoff after attempt 1..8: 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 6 h. */
export const OWNER_BACKOFF_MS = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000,
] as const;

/** Structural port the Bloque A (`WaSelfService`) declares; implemented here. */
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
      motive?: CancellationMotive;
      dryRun?: boolean;
      /** 2026-10-10 plan B: a voice cancel / change with a dictated phone. */
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

/** One-line agenda notices + morning digest (TELEGRAM_NOTIFY_AGENDA_LINES). */
export interface OwnerAgendaConfig {
  /** bookingDisplayPrefix(env): removed from the customer's name. */
  namePrefix: string;
  /** Standing rows of THAT day (read only). Throws if it cannot be read. */
  countDay: (date: string) => Promise<number>;
}

export const AGENDA_CHANGE_WINDOW_MS = 60 * 60_000;
export const DIGEST_COUNT_WAIT_MS = 10 * 60_000;
export const DIGEST_COUNT_RETRY_MS = 60_000;
export const DIGEST_GIVE_UP_MS = 60 * 60_000;

const AGENDA_LINE_KINDS: readonly OwnerJobKind[] = ["agenda_cancelled", "agenda_changed", "agenda_service"];

function isAgendaLine(kind: OwnerJobKind): boolean {
  return AGENDA_LINE_KINDS.includes(kind);
}

export interface OwnerNotifierConfig {
  mode: Exclude<TelegramNotifyMode, "off">;
  /** `TELEGRAM_CHAT_ID`. The only chat this process ever writes to. */
  chatId: string;
}

function sha12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Deterministic job keys ((internal doc, not included in the template) §8.2). */
export const ownerJobKeys = {
  cancellationDone: (reservationId: number): string => `cancellation_done:${reservationId}`,
  cancellationRequest: (reservationId: number, motive: string): string =>
    `cancellation_request:${reservationId}:${motive}`,
  waBooking: (reservationId: number): string => `wa_booking:${reservationId}`,
  ownerAlert: (conversationId: string | undefined, reason: string, summary: string, caller: string): string =>
    `owner_alert:${conversationId ?? "none"}:${sha12(`${reason}|${summary}|${caller}`)}`,
  agendaRid: (reservationId: number): string => `agenda_rid:${reservationId}`,
  agendaService: (n: { startsAt: string; phoneE164: string; fromType: number; toType: number }): string =>
    `agenda_service:${sha12(`${n.startsAt}|${n.phoneE164}|${n.fromType}|${n.toType}`)}`,
  agendaBooked: (conversationId: string, slotToken: string): string =>
    `agenda_booked:${conversationId}:${sha12(slotToken)}`,
  agendaDigest: (date: string): string => `agenda_digest:${date}`,
};

function errorLabel(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return error instanceof Error ? error.name : "unknown_error";
}

/** Between 21:00 and 08:00 Madrid the message arrives without sound. */
export function isQuietHour(nowMs: number): boolean {
  const hour = madridHour(nowMs);
  return hour >= 21 || hour < 8;
}

export class OwnerNotifier implements OwnerAlertPort {
  private timer?: NodeJS.Timeout;
  private kickTimer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly config: OwnerNotifierConfig,
    private readonly store: OwnerNotifyQueueStore,
    private readonly client: TelegramClient | undefined,
    private readonly logger: Logger,
    /**
     * Recados (2026-10-11): when present, notices only leave while the salon
     * is open; outside it the jobs stay `pending` and go out at the opening.
     * Absent = the behaviour that existed before, byte for byte.
     */
    private readonly gate?: Pick<OpeningGatePort, "isOpenAt">,
    /** One-line agenda notices + digest. Absent = the behaviour of before, byte for byte. */
    private readonly agenda?: OwnerAgendaConfig,
  ) {}

  private digestState?: { date: string; firstTryAt: number; nextAt: number; attempts: number; count?: number | null };

  get queue(): OwnerNotifyQueueStore {
    return this.store;
  }

  get mode(): "dry_run" | "live" {
    return this.config.mode;
  }

  // ── entry points (never throw, never await network) ──────────────────────

  enqueueOwnerAlert(
    a: Parameters<OwnerAlertPort["enqueueOwnerAlert"]>[0],
    nowMs: number,
  ): boolean {
    return this.safeEnqueue(
      "owner_alert",
      () => {
        const caller = a.callerPhoneE164 ?? `${a.callerFormat}|${a.callbackPhone ?? ""}`;
        return {
          id: ownerJobKeys.ownerAlert(a.conversationId, a.reason, a.summary, caller),
          text: formatOwnerAlertMessage(a),
        };
      },
      nowMs,
    );
  }

  enqueueCancellation(
    c: Parameters<OwnerAlertPort["enqueueCancellation"]>[0],
    nowMs: number,
  ): boolean {
    const agenda = this.agenda;
    if (agenda !== undefined && c.kind === "cancellation_done") {
      const fold: { job?: OwnerJob } = {};
      const queued = this.safeEnqueue(
        "agenda_cancelled",
        () => {
          const customer = shortCustomer(c.ownerName, c.ownerSurnames, agenda.namePrefix);
          const professional = shortProfessional(c.professional);
          const dictated = c.via !== undefined ? ({ dictated: true } as const) : {};
          const channel: AgendaChannel = c.channel ?? "whatsapp";
          let to: { startsAt: string; professional: string | null } | undefined = c.changeTo;
          if (to === undefined && c.channel === "whatsapp" && c.conversationId !== undefined) {
            fold.job = this.findBookingToFold(c.conversationId, nowMs);
            const bookedEvent = fold.job?.event;
            if (bookedEvent?.type === "booked" && bookedEvent.startsAt !== null) {
              to = { startsAt: bookedEvent.startsAt, professional: bookedEvent.professional };
            }
          }
          const event: AgendaEvent =
            to !== undefined
              ? {
                  type: "changed",
                  fromStartsAt: c.startsAt,
                  toStartsAt: to.startsAt,
                  fromProfessional: professional,
                  toProfessional: shortProfessional(to.professional),
                  customer,
                  channel,
                  ...dictated,
                }
              : {
                  type: "cancelled",
                  startsAt: c.startsAt,
                  professional,
                  customer,
                  noticeMinutes: c.noticeMinutes ?? 0,
                  lateNotice: c.lateNotice ?? false,
                  channel,
                  ...dictated,
                };
          return {
            id: ownerJobKeys.agendaRid(c.reservationId),
            text: "",
            kind: event.type === "changed" ? "agenda_changed" : "agenda_cancelled",
            event,
          };
        },
        nowMs,
      );
      if (queued && fold.job !== undefined) {
        this.settle(fold.job, { status: "sent", sentAt: nowMs, lastError: "folded_change" });
      }
      return queued;
    }
    return this.safeEnqueue(
      c.kind,
      () => ({
        id:
          c.kind === "cancellation_done"
            ? ownerJobKeys.cancellationDone(c.reservationId)
            : ownerJobKeys.cancellationRequest(c.reservationId, c.motive ?? "mode"),
        text: formatCancellationMessage(c),
      }),
      nowMs,
    );
  }

  /** The newest unconsumed WhatsApp booking of this conversation, at most 60 min old. */
  private findBookingToFold(conversationId: string, nowMs: number): OwnerJob | undefined {
    let best: OwnerJob | undefined;
    for (const job of this.store.all()) {
      const event = job.event;
      if (
        job.kind !== "agenda_booked" ||
        job.status !== "digest_only" ||
        event?.type !== "booked" ||
        event.conversationId !== conversationId ||
        event.startsAt === null ||
        nowMs - job.createdAt > AGENDA_CHANGE_WINDOW_MS
      ) {
        continue;
      }
      if (best === undefined || job.createdAt >= best.createdAt) best = job;
    }
    return best;
  }

  /** A new booking by an agent: counted in the morning digest, never sent alone. */
  enqueueAgendaBooked(
    b: {
      channel: AgendaChannel;
      conversationId: string;
      slotToken: string;
      startsAt: string | null;
      professional: string | null;
    },
    nowMs: number,
  ): boolean {
    if (this.agenda === undefined) return false;
    return this.safeEnqueue(
      "agenda_booked",
      () => ({
        id: ownerJobKeys.agendaBooked(b.conversationId, b.slotToken),
        text: "",
        status: "digest_only",
        event: {
          type: "booked",
          channel: b.channel,
          conversationId: b.conversationId,
          startsAt: b.startsAt,
          professional: b.professional,
        },
      }),
      nowMs,
    );
  }

  /** A successful service change, as a one-line agenda notice (only `service_changed`). */
  enqueueServiceChanged(n: ServiceChangeNotice, nowMs: number): boolean {
    const agenda = this.agenda;
    if (agenda === undefined || n.kind !== "service_changed") return false;
    return this.safeEnqueue(
      "agenda_service",
      () => ({
        id: ownerJobKeys.agendaService(n),
        text: "",
        event: {
          type: "service",
          startsAt: n.startsAt,
          professional: shortProfessional(n.professional),
          fromService: n.fromType,
          toService: n.toType,
          customer: shortCustomer(n.ownerName, n.ownerSurnames, agenda.namePrefix),
          channel: n.via === "whatsapp" ? "whatsapp" : "voice",
        },
      }),
      nowMs,
    );
  }

  /** Optional (Bloque D). Not part of {@link OwnerAlertPort}. */
  enqueueWaBooking(
    b: {
      reservationId: number;
      startsAt: string;
      professional: string | null;
      customerName: string;
      phoneE164: string;
    },
    nowMs: number,
  ): boolean {
    return this.safeEnqueue(
      "wa_booking",
      () => ({ id: ownerJobKeys.waBooking(b.reservationId), text: formatWaBookingMessage(b) }),
      nowMs,
    );
  }

  private safeEnqueue(
    kind: OwnerJobKind,
    build: () => { id: string; text: string; event?: AgendaEvent; status?: OwnerJob["status"]; kind?: OwnerJobKind },
    nowMs: number,
  ): boolean {
    try {
      const built = build();
      const { id, text } = built;
      const jobKind = built.kind ?? kind;
      const job: OwnerJob = {
        id,
        kind: jobKind,
        text,
        ...(built.event !== undefined ? { event: built.event } : {}),
        createdAt: nowMs,
        status: built.status ?? "pending",
        attempts: 0,
        nextAttemptAt: nowMs,
        lastError: null,
        providerMessageId: null,
        sentAt: null,
      };
      const added = this.store.enqueue(job);
      this.logger.info(
        { kind: jobKind, job_id: id, mode: this.config.mode, duplicate: !added },
        added ? "owner notify: queued" : "owner notify: already queued",
      );
      if (added && job.status === "pending") this.kick();
      return true;
    } catch (error) {
      this.logger.error(
        { kind, reason: errorLabel(error) },
        "owner notify: could not be queued; the operation is unaffected",
      );
      return false;
    }
  }

  // ── the worker ───────────────────────────────────────────────────────────

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, OWNER_WORKER_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.kickTimer !== undefined) {
      clearTimeout(this.kickTimer);
      this.kickTimer = undefined;
    }
    await this.inFlight;
  }

  /** Runs one sweep NOW and waits for it (tests / operator). */
  async drain(nowMs: number = Date.now()): Promise<void> {
    await this.inFlight;
    await this.sweep(nowMs);
  }

  private kick(): void {
    if (this.stopped || this.kickTimer !== undefined) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.sweep();
    }, 0);
    this.kickTimer.unref();
  }

  private async sweep(nowMs: number = Date.now()): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = (async (): Promise<void> => {
      try {
        if (this.gate !== undefined && !this.gate.isOpenAt(nowMs)) return;
        if (this.agenda !== undefined) await this.digestStep(nowMs);
        const hold = this.agenda !== undefined && !this.digestSettled(madridDate(nowMs));
        for (const job of this.store.due(nowMs)) {
          if (this.stopped) break;
          if (job.kind === "agenda_digest" || job.kind === "agenda_booked") continue;
          if (hold && isAgendaLine(job.kind)) continue; // they wait for the digest
          await this.process(job, nowMs);
        }
      } catch (error) {
        this.logger.error(
          { reason: errorLabel(error) },
          "owner notify: the queue sweep failed; the queue is unchanged and will be retried",
        );
      }
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async process(job: OwnerJob, nowMs: number): Promise<void> {
    if (this.config.mode === "dry_run" || this.client === undefined) {
      this.logger.info(
        { kind: job.kind, job_id: job.id },
        "owner notify dry run: the notice was NOT sent",
      );
      this.settle(job, { status: "sent_dry_run", sentAt: nowMs });
      return;
    }

    const attempts = job.attempts + 1;
    const result = await this.client.sendMessage({
      chatId: this.config.chatId,
      text: job.event !== undefined && job.event.type !== "booked" ? formatAgendaLine(job.event, nowMs) : job.text,
      disableNotification: isQuietHour(nowMs),
    });

    if (result.ok) {
      this.settle(job, {
        status: "sent",
        attempts,
        providerMessageId: result.messageId,
        sentAt: nowMs,
        lastError: null,
      });
      this.logger.info({ kind: job.kind, job_id: job.id, attempts }, "owner notify: sent");
      return;
    }

    if (!result.retryable || attempts >= OWNER_MAX_ATTEMPTS) {
      this.settle(job, { status: "failed", attempts, lastError: result.error });
      this.logger.warn(
        { kind: job.kind, job_id: job.id, attempts, retryable: result.retryable, reason: result.error },
        "owner notify: given up on; the operation is unaffected",
      );
      return;
    }

    const backoffMs = Math.max(
      OWNER_BACKOFF_MS[Math.min(attempts - 1, OWNER_BACKOFF_MS.length - 1)]!,
      result.retryAfterMs ?? 0,
    );
    this.settle(job, {
      status: "pending",
      attempts,
      nextAttemptAt: nowMs + backoffMs,
      lastError: result.error,
    });
    this.logger.warn(
      { kind: job.kind, job_id: job.id, attempts, retry_in_ms: backoffMs, reason: result.error },
      "owner notify: failed, will retry",
    );
  }

  // ── the morning digest ───────────────────────────────────────────────────

  private digestSettled(date: string): boolean {
    const status = this.store.get(ownerJobKeys.agendaDigest(date))?.status;
    return status === "sent" || status === "sent_dry_run" || status === "failed";
  }

  /** True once today's digest is out (or given up on). Used by the recados worker to order its header after it. */
  isDigestSettled(nowMs: number): boolean {
    return this.digestSettled(madridDate(nowMs));
  }

  private writeDigest(job: Omit<OwnerJob, "kind" | "text" | "attempts" | "nextAttemptAt">, date: string, count: number | null): void {
    try {
      this.store.enqueue({
        ...job,
        kind: "agenda_digest",
        // Only the header (a date and a number) is kept: no personal data.
        text: formatDigestHeader(date, count),
        attempts: 0,
        nextAttemptAt: job.createdAt,
      });
    } catch (error) {
      this.logger.error({ reason: errorLabel(error) }, "owner digest: the queue could not record it");
    }
  }

  /** Never throws. */
  private async digestStep(nowMs: number): Promise<void> {
    const agenda = this.agenda;
    if (agenda === undefined) return;
    try {
      const today = madridDate(nowMs);
      if (this.digestSettled(today)) return;
      if (this.digestState === undefined || this.digestState.date !== today) {
        this.digestState = { date: today, firstTryAt: nowMs, nextAt: nowMs, attempts: 0 };
      }
      const state = this.digestState;
      if (nowMs < state.nextAt) return;

      if (state.count === undefined) {
        try {
          state.count = await agenda.countDay(today);
        } catch {
          if (nowMs - state.firstTryAt < DIGEST_COUNT_WAIT_MS) {
            state.nextAt = nowMs + DIGEST_COUNT_RETRY_MS;
            this.logger.warn({ date: today }, "owner digest: the day's count could not be read, will retry");
            return;
          }
          state.count = null;
        }
      }
      const count = state.count ?? null;

      const lines: OwnerJob[] = [];
      const booked: OwnerJob[] = [];
      for (const job of this.store.all()) {
        if (isAgendaLine(job.kind) && job.status === "pending" && job.event !== undefined) lines.push(job);
        else if (job.kind === "agenda_booked" && job.status === "digest_only") booked.push(job);
      }
      const bookedCount = { whatsapp: 0, voice: 0 };
      for (const job of booked) {
        if (job.event?.type === "booked") bookedCount[job.event.channel] += 1;
      }
      const events = lines.map((job) => job.event as AgendaLineEvent);
      const digestId = ownerJobKeys.agendaDigest(today);
      const numbers = {
        date: today,
        count_known: count !== null,
        lines: lines.length,
        booked_wa: bookedCount.whatsapp,
        booked_voice: bookedCount.voice,
      };
      const closeOut = (status: "sent" | "sent_dry_run", providerMessageId: number | null): void => {
        this.writeDigest(
          { id: digestId, createdAt: nowMs, status, lastError: null, providerMessageId, sentAt: nowMs },
          today,
          count,
        );
        for (const job of [...lines, ...booked]) {
          this.settle(job, { status, providerMessageId, sentAt: nowMs, lastError: null });
        }
      };

      if (this.config.mode === "dry_run" || this.client === undefined) {
        this.logger.info(numbers, "owner digest dry run: NOT sent");
        closeOut("sent_dry_run", null);
        return;
      }

      const result = await this.client.sendMessage({
        chatId: this.config.chatId,
        text: formatDigest({ date: today, count, lines: events, booked: bookedCount }, nowMs),
        disableNotification: isQuietHour(nowMs),
      });
      if (result.ok) {
        closeOut("sent", result.messageId);
        this.logger.info({ ...numbers, job_id: digestId }, "owner digest: sent");
        return;
      }
      state.attempts += 1;
      const giveUp = !result.retryable || nowMs - state.firstTryAt >= DIGEST_GIVE_UP_MS;
      if (giveUp) {
        this.writeDigest(
          { id: digestId, createdAt: nowMs, status: "failed", lastError: result.error, providerMessageId: null, sentAt: null },
          today,
          count,
        );
        this.logger.warn(
          { ...numbers, job_id: digestId, retryable: result.retryable, reason: result.error },
          "owner digest: given up on; the lines will go out one by one",
        );
        return;
      }
      const backoffMs = Math.max(
        OWNER_BACKOFF_MS[Math.min(state.attempts - 1, OWNER_BACKOFF_MS.length - 1)]!,
        result.retryAfterMs ?? 0,
      );
      state.nextAt = nowMs + backoffMs;
      this.logger.warn(
        { ...numbers, job_id: digestId, retry_in_ms: backoffMs, reason: result.error },
        "owner digest: failed, will retry",
      );
    } catch (error) {
      this.logger.error({ reason: errorLabel(error) }, "owner digest: the step failed; it will be retried");
    }
  }

  private settle(job: OwnerJob, changes: Partial<OwnerJob>): void {
    try {
      this.store.update({ ...job, ...changes });
    } catch (error) {
      this.logger.error(
        { job_id: job.id, reason: errorLabel(error) },
        "owner notify: the queue could not record a transition",
      );
    }
  }
}

export interface CreateOwnerNotifierOptions {
  mode: TelegramNotifyMode;
  queuePath?: string;
  /** `TELEGRAM_BOT_TOKEN` (required for `live`). */
  botToken?: string;
  /** `TELEGRAM_CHAT_ID` (required for `live`). */
  chatId?: string;
  sendTimeoutMs: number;
  logger: Logger;
  /** Injected by tests; production uses Telegram's real origin. */
  baseUrl?: string;
  nowMs?: number;
  /** Recados: the opening-hours gate (see {@link OwnerNotifier}). */
  gate?: Pick<OpeningGatePort, "isOpenAt">;
  /** TELEGRAM_NOTIFY_AGENDA_LINES: one-line notices + digest. */
  agenda?: OwnerAgendaConfig;
}

/**
 * Builds the notifier, or `undefined` — meaning "no owner notices", and never
 * anything else. Refuses to fail the boot (cancellations and bookings do not
 * depend on it).
 */
export function createOwnerNotifier(options: CreateOwnerNotifierOptions): OwnerNotifier | undefined {
  if (options.mode === "off") return undefined;
  if (options.queuePath === undefined || options.queuePath === "") return undefined;

  const chatId = options.chatId ?? "";
  if (options.mode === "live" && (options.botToken === undefined || options.botToken === "" || chatId === "")) {
    options.logger.error(
      { mode: options.mode },
      "owner notifications DISABLED for this process (bookings and cancellations are unaffected): live mode without bot token/chat id",
    );
    return undefined;
  }

  let store: OwnerNotifyQueueStore;
  try {
    store = new FileOwnerNotifyQueueStore(
      options.queuePath,
      options.nowMs ?? Date.now(),
      (message, detail) => options.logger.warn(detail, message),
    );
  } catch (error) {
    options.logger.error(
      { reason: errorLabel(error), mode: options.mode },
      "owner notifications DISABLED for this process (bookings and cancellations are unaffected): the queue file could not be opened",
    );
    return undefined;
  }

  const client =
    options.mode === "live" && options.botToken !== undefined
      ? new TelegramClient({
          botToken: options.botToken,
          sendTimeoutMs: options.sendTimeoutMs,
          ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        })
      : undefined;

  return new OwnerNotifier({ mode: options.mode, chatId }, store, client, options.logger, options.gate, options.agenda);
}
