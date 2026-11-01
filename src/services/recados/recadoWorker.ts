import { madridDate, madridMinutes } from "../../utils/madridDate.js";
import type { Logger } from "../authTokenService.js";
import { OWNER_BACKOFF_MS } from "../ownerNotify/ownerNotifier.js";
import type { TelegramClient } from "../ownerNotify/telegramClient.js";
import type { OpeningGatePort } from "./openingHoursGate.js";
import {
  BUTTON_DONE,
  CALLBACK_PREFIX,
  formatRecadoMessage,
  headerText,
  recadoKeyboard,
  REMINDER_TEXT,
  summaryText,
} from "./recadoMessages.js";
import type { RecadoStore } from "./recadoStore.js";
import type { Recado } from "./recadoTypes.js";

/**
 * *** SENDS THE RECADOS — ONLY WITH THE SALON OPEN. ***
 *
 * (internal doc, not included in the template) §A.8. Everything that entered while the
 * salon was closed leaves at the next opening, behind ONE header «📋 N recados
 * de cuando estaba cerrado». The same worker sends the single reminder (45
 * open minutes unmarked) and the end-of-day summary. A sweep never runs in
 * parallel with itself and never throws. Logs carry ids and counts, never a
 * name, a phone, a summary or a chat id.
 */

export const RECADO_WORKER_INTERVAL_MS = 5_000;
export const RECADO_ENRICH_WAIT_MS = 15_000;
/** Longest the held recados wait for the agenda digest (its count wait is 10 min). */
export const RECADO_DIGEST_WAIT_MS = 11 * 60_000;
export const RECADO_MAX_ATTEMPTS = 8; // backoff = OWNER_BACKOFF_MS
export const REMINDER_MAX_ATTEMPTS = 3;
export const PENDING_WINDOW_MS = 7 * 24 * 3_600_000; // recordatorio y resumen solo de recados de los últimos 7 días
const REMINDER_RETRY_MS = 60_000;

export interface RecadoWorkerConfig {
  mode: "dry_run" | "live";
  chatId: string;
  reminderOpenMinutes: number;
  summaryBeforeCloseMinutes: number;
  voceroUrlTemplate: string;
}

function errorLabel(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return error instanceof Error ? error.name : "unknown_error";
}

export class RecadoWorker {
  private timer?: NodeJS.Timeout;
  private kickTimer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly cfg: RecadoWorkerConfig,
    private readonly store: RecadoStore,
    private readonly gate: OpeningGatePort,
    private readonly client: TelegramClient | undefined,
    private readonly logger: Logger,
    /**
     * AVISOS_AGENDA (decision 2026-10-11): at the opening the «📅 Hoy…» digest
     * goes BEFORE the «📋 N recados…» header. The held recados wait for it, at
     * most {@link RECADO_DIGEST_WAIT_MS}. Absent = no waiting (as before).
     */
    private readonly digestBarrier?: { isDigestSettled(nowMs: number): boolean },
  ) {}

  private barrierSince?: number;

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => {
      void this.sweep(Date.now());
    }, RECADO_WORKER_INTERVAL_MS);
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

  kick(): void {
    if (this.stopped || this.kickTimer !== undefined) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.sweep(Date.now());
    }, 0);
    this.kickTimer.unref();
  }

  /** Runs one sweep NOW and waits for it (tests / operator). */
  async drain(nowMs: number = Date.now()): Promise<void> {
    await this.inFlight;
    await this.sweep(nowMs);
  }

  private async sweep(now: number): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = (async (): Promise<void> => {
      try {
        await this.run(now);
      } catch (error) {
        this.logger.error(
          { reason: errorLabel(error) },
          "recados: the sweep failed; the store is unchanged and will be retried",
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

  private get live(): TelegramClient | undefined {
    return this.cfg.mode === "live" ? this.client : undefined;
  }

  private async run(now: number): Promise<void> {
    if (this.stopped) return;
    if (!this.gate.isOpenAt(now)) return;

    // ── 1. the recados waiting to leave ────────────────────────────────────
    let ready = this.store
      .all()
      .filter(
        (r) =>
          (r.delivery === "held" || r.delivery === "pending") &&
          r.nextAttemptAt <= now &&
          (r.appointment.status !== "pending" || now - r.createdAt >= RECADO_ENRICH_WAIT_MS),
      )
      .sort((a, b) => a.createdAt - b.createdAt);

    if (this.digestBarrier !== undefined) {
      if (ready.some((r) => r.delivery === "held") && !this.digestBarrier.isDigestSettled(now)) {
        this.barrierSince ??= now;
        // The held ones wait for the digest (at most RECADO_DIGEST_WAIT_MS); the rest go on.
        if (now - this.barrierSince < RECADO_DIGEST_WAIT_MS) ready = ready.filter((r) => r.delivery !== "held");
      } else {
        this.barrierSince = undefined;
      }
    }

    let queue = ready;
    const closed = ready.filter((r) => r.delivery === "held");
    if (closed.length > 0) {
      const client = this.live;
      if (client === undefined) {
        this.logger.info({ count: closed.length }, "recados dry run: header NOT sent");
      } else {
        const sent = await client.sendMessage({
          chatId: this.cfg.chatId,
          text: headerText(closed.length),
          disableNotification: false,
        });
        if (!sent.ok) {
          // No recado leaves before its header; the next pass retries both.
          this.logger.warn({ count: closed.length, reason: sent.error }, "recados: header failed, will retry");
          return;
        }
      }
      // Persist «header done» so a restart does not repeat it.
      const promoted = new Map<string, Recado>();
      for (const r of closed) {
        const next: Recado = { ...r, delivery: "pending" };
        this.store.update(next);
        promoted.set(r.id, next);
      }
      queue = ready.map((r) => promoted.get(r.id) ?? r);
      // The ones that came in closed first (oldest first), then the rest.
      queue = [
        ...queue.filter((r) => promoted.has(r.id)),
        ...queue.filter((r) => !promoted.has(r.id)),
      ];
    }

    for (const r of queue) {
      if (this.stopped) return;
      const keepGoing = await this.deliver(r, now);
      if (!keepGoing) break;
    }

    // ── 2. reminder ────────────────────────────────────────────────────────
    await this.reminders(now);

    // ── 3. end-of-day summary ──────────────────────────────────────────────
    await this.summary(now);
  }

  /** false = stop the pass (a retryable failure: keep the order). */
  private async deliver(r: Recado, now: number): Promise<boolean> {
    const client = this.live;
    if (client === undefined) {
      this.logger.info({ recado_id: r.id, kind: r.kind, channel: r.channel }, "recados dry run: NOT sent");
      this.store.update({ ...r, delivery: "sent_dry_run", sentAt: now });
      return true;
    }
    const attempts = r.attempts + 1;
    const result = await client.sendMessage({
      chatId: this.cfg.chatId,
      text: formatRecadoMessage(r, now),
      disableNotification: false,
      inlineKeyboard: recadoKeyboard(r, this.cfg.voceroUrlTemplate, false),
    });
    if (result.ok) {
      this.store.update({
        ...r,
        delivery: "sent",
        attempts,
        messageId: result.messageId,
        sentAt: now,
        lastError: null,
      });
      this.logger.info({ recado_id: r.id, kind: r.kind, channel: r.channel, attempts }, "recados: sent");
      return true;
    }
    if (!result.retryable || attempts >= RECADO_MAX_ATTEMPTS) {
      this.store.update({ ...r, delivery: "failed", attempts, lastError: result.error });
      this.logger.warn(
        { recado_id: r.id, attempts, retryable: result.retryable, reason: result.error },
        "recados: given up on",
      );
      return true;
    }
    const backoffMs = Math.max(
      OWNER_BACKOFF_MS[Math.min(attempts - 1, OWNER_BACKOFF_MS.length - 1)]!,
      result.retryAfterMs ?? 0,
    );
    this.store.update({ ...r, attempts, nextAttemptAt: now + backoffMs, lastError: result.error });
    this.logger.warn(
      { recado_id: r.id, attempts, retry_in_ms: backoffMs, reason: result.error },
      "recados: failed, will retry",
    );
    return false;
  }

  private async reminders(now: number): Promise<void> {
    const client = this.live;
    if (client === undefined) return;
    for (const r of this.store.all()) {
      if (this.stopped) return;
      if (
        r.dedupeKey.startsWith("prueba:") ||
        r.delivery !== "sent" ||
        r.handledAt !== null ||
        r.remindedAt !== null ||
        r.sentAt === null ||
        r.messageId === null ||
        now - r.sentAt >= PENDING_WINDOW_MS ||
        r.nextAttemptAt > now
      ) {
        continue;
      }
      if (this.gate.openMinutesBetween(r.sentAt, now) < this.cfg.reminderOpenMinutes) continue;
      const result = await client.sendMessage({
        chatId: this.cfg.chatId,
        text: REMINDER_TEXT,
        disableNotification: false,
        replyToMessageId: r.messageId,
        inlineKeyboard: [[{ text: BUTTON_DONE, callbackData: `${CALLBACK_PREFIX}${r.id}` }]],
      });
      if (result.ok) {
        this.store.update({ ...r, remindedAt: now, reminderMessageId: result.messageId });
        this.logger.info({ recado_id: r.id }, "recados: reminder sent");
        continue;
      }
      const reminderAttempts = r.reminderAttempts + 1;
      this.logger.warn({ recado_id: r.id, reminderAttempts, reason: result.error }, "recados: reminder failed");
      this.store.update(
        reminderAttempts >= REMINDER_MAX_ATTEMPTS
          ? { ...r, reminderAttempts, remindedAt: now, reminderMessageId: null }
          : { ...r, reminderAttempts, nextAttemptAt: now + REMINDER_RETRY_MS },
      );
    }
  }

  private async summary(now: number): Promise<void> {
    const today = madridDate(now);
    const w = this.gate.windowFor(today);
    if (!w.open || madridMinutes(now) < w.endMin - this.cfg.summaryBeforeCloseMinutes) return;
    if (this.store.summaryDone(today)) return;
    const pending = this.store
      .all()
      .filter((r) => !r.dedupeKey.startsWith("prueba:") && r.delivery === "sent" && r.handledAt === null && now - (r.sentAt ?? 0) < PENDING_WINDOW_MS);
    if (pending.length > 0) {
      const client = this.live;
      if (client === undefined) {
        this.logger.info({ count: pending.length }, "recados dry run: summary NOT sent");
      } else {
        const result = await client.sendMessage({
          chatId: this.cfg.chatId,
          text: summaryText(pending, now),
          disableNotification: false,
        });
        if (!result.ok) {
          this.logger.warn({ count: pending.length, reason: result.error }, "recados: summary failed, will retry while open");
          return;
        }
      }
    }
    this.store.markSummary(today, now, pending.length);
  }
}
