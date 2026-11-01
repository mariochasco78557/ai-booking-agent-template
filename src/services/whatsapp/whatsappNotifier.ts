import { serviceLabel } from "../../core/texts/texts.js";
import { maskPhone } from "../../utils/mask.js";
import { normalizeSpanishPhone } from "../../utils/phone.js";
import type { Logger } from "../authTokenService.js";
import type { EmployeeNameDirectory } from "../employeeNameDirectory.js";
import { maskCalendarToken, mintCalendarToken } from "./calendarLink.js";
import { MetaWhatsAppClient } from "./metaWhatsappClient.js";
import {
  FileWhatsAppQueueStore,
  whatsappJobKey,
  type WhatsAppJob,
  type WhatsAppQueueStore,
} from "./whatsappQueueStore.js";
import { buildConfirmationParameters } from "./whatsappTemplate.js";

/**
 * *** THE CONFIRMATION BY WHATSAPP — AND THE WALL BETWEEN IT AND THE BOOKING. ***
 *
 * One rule governs this whole file, and every decision below follows from it:
 *
 *   ****  NOTHING HERE MAY CHANGE THE OUTCOME, THE SHAPE OR THE LATENCY OF  ****
 *   ****  A BOOKING. NOT A MISCONFIGURATION, NOT A FULL DISK, NOT META.     ****
 *
 * Concretely:
 *
 * - {@link WhatsAppNotifier.enqueueConfirmation} NEVER throws and never awaits.
 *   It appends one fsynced line and returns; a failure of any kind is logged
 *   and swallowed, and the caller — `VoiceBookingService.runUpstreamBook()` —
 *   simply gets `undefined` back and answers exactly as it did before this
 *   feature existed.
 * - The HTTP send happens in a worker, outside the request, and can take as
 *   long as it likes.
 * - With `WHATSAPP_NOTIFICATIONS_MODE` unset (the default, `off`) no store is
 *   created, no worker is started, and every response is byte for byte what it
 *   was before.
 *
 * ── Why the response field only exists in `live` ──────────────────────────
 *
 * `whatsapp_confirmation: "queued"` is what lets the prompt say «te lo mando
 * por WhatsApp» — so it must be a PROMISE THAT WILL BE KEPT, not a statement
 * about internal state. In `dry_run` nothing is ever dialled, and for a
 * recipient outside `WHATSAPP_ALLOWED_RECIPIENTS` nothing is ever sent, so in
 * both cases the field is absent and the agent says nothing about WhatsApp.
 * The job is still written in `dry_run`, because the point of that mode is to
 * inspect exactly what would have been sent.
 */

export type WhatsAppNotificationsMode = "off" | "dry_run" | "live";

/**
 * How long the worker waits between sweeps. Short enough that a confirmation
 * arrives while the customer is still on the phone, long enough to be free:
 * an idle sweep reads a `Map` and returns.
 */
export const WHATSAPP_WORKER_INTERVAL_MS = 5_000;

/** Attempts a message gets before it is given up on. */
export const WHATSAPP_MAX_ATTEMPTS = 5;

/**
 * Backoff after attempt 1, 2, 3… Deliberately long: the failures that reach
 * here are 429s and outages, and hammering either one makes both worse. The
 * last entry is unreachable while {@link WHATSAPP_MAX_ATTEMPTS} is 5; it is
 * kept so raising that constant does not silently mean "retry every hour".
 */
export const WHATSAPP_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000] as const;

/** What the booking path hands over. Everything else is derived here. */
export interface WhatsAppConfirmationInput {
  /** The upstream appointment id. Also the job key. */
  reservationId: number;
  conversationId: string;
  /** As the caller gave it; validated already by `readCustomerIdentity`. */
  phone: string;
  customerName: string;
  /** Upstream's own `"YYYY-MM-DD HH:mm:ss"`, Europe/Madrid wall clock. */
  reservationDate: string;
  /** From the slot token. Absent when availability named no barber. */
  employeeId?: number;
  /**
   * From the slot token (0 barba, 1 corte, 2 corte y barba). Only labels the
   * calendar entry; an unknown id just leaves the service out of it.
   */
  serviceId?: number;
}

/**
 * The seam `VoiceBookingService` depends on — deliberately one method that
 * cannot fail, so the write path has nothing to handle.
 */
export interface WhatsAppConfirmationSink {
  /** `"queued"` only when a message WILL be sent; `undefined` otherwise. */
  enqueueConfirmation(
    input: WhatsAppConfirmationInput,
    nowMs: number,
  ): "queued" | undefined;
}

export interface WhatsAppNotifierConfig {
  mode: Exclude<WhatsAppNotificationsMode, "off">;
  /**
   * Meta's test-number phase allows at most five verified recipients. With
   * this set, anybody else is recorded as `skipped_not_allowed` and never
   * dialled — so a real customer of the salon cannot receive a message from a
   * number that is not yet approved for production traffic.
   */
  allowedRecipients?: ReadonlySet<string>;
  /**
   * The «Añadir al calendario» button (`calendarLink.ts`). REQUIRED: the
   * approved template has the URL button, and Meta refuses a send without its
   * parameter. `src/config/env.ts` guarantees both values at boot.
   */
  calendar: CalendarLinkConfig;
}

export interface CalendarLinkConfig {
  /** `WHATSAPP_CALENDAR_LINK_SECRET`. Never logged. */
  secret: string;
  /** `WHATSAPP_CALENDAR_BASE_URL`, no trailing slash. For logs only. */
  baseUrl: string;
}

/**
 * The catalogue label (`servicios[].nombre` in `cliente.yaml`, D-012) for a
 * configured service id, `null` otherwise.
 */
export function serviceLabelOf(serviceId: number | undefined): string | null {
  return serviceLabel(serviceId, "nombre") ?? null;
}

/** The facts of a booked appointment that its calendar entry describes. */
export interface AppointmentCalendarFacts {
  /** Upstream's own `"YYYY-MM-DD HH:mm:ss"`, Europe/Madrid wall clock. */
  reservationDate: string;
  employeeId?: number;
  serviceId?: number;
}

/**
 * *** ONE DERIVATION OF «WHAT GOES IN THE CALENDAR LINK». ***
 *
 * Used by the queued WhatsApp confirmation (whose job stores these three
 * fields and mints from them at send time) AND by the booking answer's
 * `calendar_url` (ADR-031 addendum, `VoiceBookingService`). Both paths go
 * through here, so the same appointment yields the same inputs — and, the
 * token being deterministic, the same link.
 */
export function appointmentCalendarFields(
  facts: AppointmentCalendarFacts,
  employeeNames?: EmployeeNameDirectory,
): { startsAtIso: string; professionalName: string | null; serviceLabel: string | null } {
  return {
    startsAtIso: wallClockIso(facts.reservationDate),
    professionalName:
      facts.employeeId === undefined ? null : employeeNames?.nameOf(facts.employeeId) ?? null,
    serviceLabel: serviceLabelOf(facts.serviceId),
  };
}

/**
 * The absolute «Añadir al calendario» URL for a booked appointment —
 * `${baseUrl}/cal/${token}` — or `undefined` when no token can be minted.
 *
 * NEVER throws: it sits on the booking path, after the appointment exists,
 * and a link is never worth an exception there.
 */
export function appointmentCalendarUrl(
  calendar: CalendarLinkConfig,
  facts: AppointmentCalendarFacts,
  employeeNames?: EmployeeNameDirectory,
): string | undefined {
  try {
    const token = mintCalendarToken(
      calendar.secret,
      appointmentCalendarFields(facts, employeeNames),
    );
    if (token === undefined) return undefined;
    return `${calendar.baseUrl.replace(/\/+$/, "")}/cal/${token}`;
  } catch {
    return undefined;
  }
}

/**
 * `"600000123"` / `"+34600000123"` → `"34600000123"`, Meta's shape.
 *
 * Reuses `normalizeSpanishPhone` — the same function the rest of the system
 * validates with — and only removes the `+`, so "what is a valid number here"
 * cannot drift from "what is a valid number anywhere else". Returns
 * `undefined` for anything it cannot normalize, which the caller treats as
 * "no confirmation for this booking" and nothing else.
 */
export function recipientDigits(phone: string): string | undefined {
  const normalized = normalizeSpanishPhone(phone);
  if (!normalized.ok) return undefined;
  return normalized.e164.replace(/^\+/, "");
}

export class WhatsAppNotifier implements WhatsAppConfirmationSink {
  private timer?: NodeJS.Timeout;
  private kickTimer?: NodeJS.Timeout;
  /** The sweep currently running, so `stop()` can wait for it. */
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly config: WhatsAppNotifierConfig,
    private readonly store: WhatsAppQueueStore,
    private readonly client: MetaWhatsAppClient | undefined,
    private readonly logger: Logger,
    private readonly employeeNames?: EmployeeNameDirectory,
  ) {}

  /** The queue itself. An in-process handle for diagnostics and tests. */
  get queue(): WhatsAppQueueStore {
    return this.store;
  }

  get mode(): WhatsAppNotificationsMode {
    return this.config.mode;
  }

  // ── the booking path's only entry point ──────────────────────────────────

  enqueueConfirmation(
    input: WhatsAppConfirmationInput,
    nowMs: number,
  ): "queued" | undefined {
    try {
      const to = recipientDigits(input.phone);
      if (to === undefined) {
        // Unreachable through the voice path (`readCustomerIdentity` has
        // already enforced the same shape), so this is about a future caller:
        // a number this process cannot dial is not a reason to do anything to
        // the appointment.
        this.logger.warn(
          { conversation_id: input.conversationId, reservation_id: input.reservationId },
          "whatsapp: the booking's phone could not be normalized; no confirmation was queued",
        );
        return undefined;
      }

      const allowed =
        this.config.allowedRecipients === undefined || this.config.allowedRecipients.has(to);
      // The same derivation the booking answer's `calendar_url` uses.
      const calendarFields = appointmentCalendarFields(input, this.employeeNames);
      const job: WhatsAppJob = {
        id: whatsappJobKey({ kind: "confirmation", reservationId: input.reservationId }),
        kind: "confirmation",
        reservationId: input.reservationId,
        conversationId: input.conversationId,
        to,
        customerName: input.customerName,
        professionalName: calendarFields.professionalName,
        serviceLabel: calendarFields.serviceLabel,
        startsAtIso: calendarFields.startsAtIso,
        createdAt: nowMs,
        status: allowed ? "pending" : "skipped_not_allowed",
        attempts: 0,
        nextAttemptAt: nowMs,
        lastError: allowed ? null : "recipient_not_in_allow_list",
        providerMessageId: null,
        sentAt: null,
      };

      const added = this.store.enqueue(job);
      this.logger.info(
        {
          conversation_id: input.conversationId,
          reservation_id: input.reservationId,
          to: maskPhone(to),
          mode: this.config.mode,
          status: job.status,
          duplicate: !added,
        },
        added
          ? "whatsapp: confirmation queued"
          : "whatsapp: a confirmation for this appointment was already queued",
      );
      if (!allowed) return undefined;
      // Only now, and only after the line is on disk: waking the worker can
      // never be what makes the enqueue fail.
      this.kick();
      // `dry_run` queues but never dials, so it must not let the agent promise
      // a message. See the file header. And a duplicate enqueue (`added ===
      // false`) means a job for this appointment already existed — this call
      // did not queue anything new, so it must not say `queued` either.
      return added && this.config.mode === "live" ? "queued" : undefined;
    } catch (error) {
      // *** THE BOOKING IS ALREADY DONE AND STAYS DONE. ***
      // A read-only volume, a full disk, anything: it costs a WhatsApp, never
      // an appointment, and the answer the agent speaks is unchanged.
      this.logger.error(
        {
          conversation_id: input.conversationId,
          reservation_id: input.reservationId,
          reason: errorLabel(error),
        },
        "whatsapp: the confirmation could not be queued; the appointment is unaffected",
      );
      return undefined;
    }
  }

  // ── the worker ───────────────────────────────────────────────────────────

  /**
   * Starts the sweep. `unref()` so a process whose only remaining handle is
   * this interval still exits — a test that forgot to close its app must not
   * hang the suite, and a container receiving SIGTERM must not wait 5 s.
   */
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, WHATSAPP_WORKER_INTERVAL_MS);
    this.timer.unref();
  }

  /** Stops accepting work and waits for the sweep in flight. */
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

  /**
   * Runs one sweep NOW and waits for it — including any sweep already in
   * flight, so a caller that has just enqueued something sees it processed.
   * For tests and for a future operator endpoint; the production worker uses
   * the interval and the kick.
   */
  async drain(nowMs: number = Date.now()): Promise<void> {
    await this.inFlight;
    await this.sweep(nowMs);
  }

  /** Wakes the worker immediately after an enqueue. Never throws. */
  private kick(): void {
    if (this.stopped || this.kickTimer !== undefined) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.sweep();
    }, 0);
    this.kickTimer.unref();
  }

  /**
   * One pass over the due jobs, ONE AT A TIME.
   *
   * Sequential on purpose: the volume is a handful of messages a day, Meta
   * rate-limits per phone number id, and a queue that cannot cause a thundering
   * herd is one fewer thing to reason about at 09:00 on a Saturday.
   */
  private async sweep(nowMs: number = Date.now()): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = (async (): Promise<void> => {
      try {
        for (const job of this.store.due(nowMs)) {
          if (this.stopped) break;
          await this.process(job);
        }
      } catch (error) {
        // A throw here would become an unhandled rejection on a timer, which
        // takes the process down — for a notification.
        this.logger.error(
          { reason: errorLabel(error) },
          "whatsapp: the queue sweep failed; the queue is unchanged and will be retried",
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

  private async process(job: WhatsAppJob): Promise<void> {
    // Re-checked at send time, not only at enqueue time: the allow list can
    // change with a restart while a job is still pending, and the list is a
    // safety rule about who may be messaged at all.
    if (
      this.config.allowedRecipients !== undefined &&
      !this.config.allowedRecipients.has(job.to)
    ) {
      this.settle(job, {
        status: "skipped_not_allowed",
        lastError: "recipient_not_in_allow_list",
      });
      return;
    }

    const parameters = buildConfirmationParameters(job);

    // The calendar link is minted HERE, at send time, from what the job
    // already stores — never persisted, so the queue file holds no token. It
    // is deterministic (same appointment → same token), so a retry carries the
    // same link. `undefined` only for a start this process cannot read, which
    // the booking path cannot produce; Meta would refuse the send without the
    // button anyway, so the job is settled as failed rather than dialled.
    const calendarToken = mintCalendarToken(this.config.calendar.secret, {
      startsAtIso: job.startsAtIso,
      professionalName: job.professionalName,
      serviceLabel: job.serviceLabel ?? null,
    });
    if (calendarToken === undefined) {
      this.settle(job, { status: "failed", lastError: "calendar_link_unavailable" });
      this.logger.warn(
        { conversation_id: job.conversationId, reservation_id: job.reservationId },
        "whatsapp: the calendar link could not be built; confirmation given up on (the appointment is unaffected)",
      );
      return;
    }

    if (this.config.mode === "dry_run" || this.client === undefined) {
      // NO NETWORK. What would have been sent, with the number masked, so a
      // rehearsal can be read in the logs without leaking a phone — and the
      // calendar link masked too: the full token would open the page.
      this.logger.info(
        {
          conversation_id: job.conversationId,
          reservation_id: job.reservationId,
          to: maskPhone(job.to),
          parameters: parameters.map((parameter) => ({
            name: parameter.parameter_name,
            text: parameter.parameter_name === "nombre" ? maskGivenName(parameter.text) : parameter.text,
          })),
          calendar_link: `${this.config.calendar.baseUrl}/cal/${maskCalendarToken(calendarToken)}`,
        },
        "whatsapp dry run: the confirmation was NOT sent",
      );
      this.settle(job, { status: "sent_dry_run", sentAt: Date.now() });
      return;
    }

    const attempts = job.attempts + 1;
    const result = await this.client.send(job.to, parameters, calendarToken);

    if (result.ok) {
      this.settle(job, {
        status: "sent",
        attempts,
        providerMessageId: result.messageId,
        sentAt: Date.now(),
        lastError: null,
      });
      this.logger.info(
        {
          conversation_id: job.conversationId,
          reservation_id: job.reservationId,
          to: maskPhone(job.to),
          attempts,
        },
        "whatsapp: confirmation sent",
      );
      return;
    }

    const exhausted = attempts >= WHATSAPP_MAX_ATTEMPTS;
    if (!result.retryable || exhausted) {
      this.settle(job, { status: "failed", attempts, lastError: result.error });
      this.logger.warn(
        {
          conversation_id: job.conversationId,
          reservation_id: job.reservationId,
          to: maskPhone(job.to),
          attempts,
          retryable: result.retryable,
          reason: result.error,
        },
        "whatsapp: confirmation given up on; the appointment is unaffected",
      );
      return;
    }

    const backoffMs =
      WHATSAPP_BACKOFF_MS[Math.min(attempts - 1, WHATSAPP_BACKOFF_MS.length - 1)]!;
    this.settle(job, {
      status: "pending",
      attempts,
      nextAttemptAt: Date.now() + backoffMs,
      lastError: result.error,
    });
    this.logger.warn(
      {
        conversation_id: job.conversationId,
        reservation_id: job.reservationId,
        to: maskPhone(job.to),
        attempts,
        retry_in_ms: backoffMs,
        reason: result.error,
      },
      "whatsapp: confirmation failed, will retry",
    );
  }

  /**
   * Writes a transition. A store failure here is logged and dropped: the job
   * stays as it was, which at worst means one duplicate attempt later — and
   * never an exception on a timer.
   */
  private settle(job: WhatsAppJob, changes: Partial<WhatsAppJob>): void {
    try {
      this.store.update({ ...job, ...changes });
    } catch (error) {
      this.logger.error(
        { reservation_id: job.reservationId, reason: errorLabel(error) },
        "whatsapp: the queue could not record a transition",
      );
    }
  }
}

/** `"2026-09-25 10:30:00"` → `"2026-09-25T10:30:00"`. No timezone math. */
function wallClockIso(reservationDate: string): string {
  return reservationDate.trim().replace(" ", "T");
}

/** First letter + `***`, so a customer's given name never appears in full in a log. */
function maskGivenName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "***";
  return `${trimmed.charAt(0)}***`;
}

/** A short, non-secret label for a caught value. Never a token, never a phone. */
function errorLabel(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return error instanceof Error ? error.name : "unknown_error";
}

export interface CreateWhatsAppNotifierOptions {
  mode: WhatsAppNotificationsMode;
  queuePath?: string;
  accessToken?: string;
  phoneNumberId?: string;
  templateName: string;
  templateLanguage: string;
  graphApiVersion: string;
  sendTimeoutMs: number;
  allowedRecipients?: ReadonlySet<string>;
  /** `WHATSAPP_CALENDAR_LINK_SECRET` / `WHATSAPP_CALENDAR_BASE_URL`. */
  calendarLinkSecret?: string;
  calendarBaseUrl?: string;
  logger: Logger;
  employeeNames?: EmployeeNameDirectory;
  /** Injected by tests; production always talks to Graph's real origin. */
  baseUrl?: string;
  nowMs?: number;
}

/**
 * Builds the notifier, or returns `undefined` — which means "no WhatsApp", and
 * never anything else.
 *
 * *** IT REFUSES TO FAIL THE BOOT. ***
 *
 * `src/config/env.ts` already rejects the combinations that are simply wrong
 * (a mode without a queue path, `live` without credentials), so what is left
 * here is the RUNTIME failure: a directory that cannot be created, a read-only
 * volume, a full disk. The durable idempotency store throws in that situation
 * and is right to — losing it double-books a customer. Losing this one costs a
 * notification, so it degrades instead: the middleware boots, takes calls,
 * books appointments, and says nothing about WhatsApp.
 */
export function createWhatsAppNotifier(
  options: CreateWhatsAppNotifierOptions,
): WhatsAppNotifier | undefined {
  if (options.mode === "off") return undefined;
  if (options.queuePath === undefined || options.queuePath === "") return undefined;
  // Second lock on the env schema's door: without the calendar link every
  // send would be refused by Meta (the template's button needs it), and in
  // `live` the agent would still be promising messages. Checked before the
  // queue file is opened, so nothing is created for a notifier that will not
  // exist.
  if (!options.calendarLinkSecret || !options.calendarBaseUrl) {
    options.logger.error(
      { mode: options.mode },
      "whatsapp: no calendar link secret/base URL; WhatsApp confirmations are DISABLED for this process (bookings are unaffected)",
    );
    return undefined;
  }
  const calendar: CalendarLinkConfig = {
    secret: options.calendarLinkSecret,
    baseUrl: options.calendarBaseUrl.replace(/\/+$/, ""),
  };

  let store: WhatsAppQueueStore;
  try {
    store = new FileWhatsAppQueueStore(
      options.queuePath,
      options.nowMs ?? Date.now(),
      (message, detail) => options.logger.warn(detail, message),
    );
  } catch (error) {
    options.logger.error(
      { reason: errorLabel(error), mode: options.mode },
      "whatsapp: the queue file could not be opened; WhatsApp confirmations are DISABLED for this process (bookings are unaffected)",
    );
    return undefined;
  }

  const client =
    options.mode === "live" &&
    options.accessToken !== undefined &&
    options.phoneNumberId !== undefined
      ? new MetaWhatsAppClient({
          accessToken: options.accessToken,
          phoneNumberId: options.phoneNumberId,
          graphApiVersion: options.graphApiVersion,
          templateName: options.templateName,
          templateLanguage: options.templateLanguage,
          sendTimeoutMs: options.sendTimeoutMs,
          ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        })
      : undefined;

  // `live` without a client would silently behave as a dry run — the one
  // outcome nobody could diagnose from the logs, because the agent would be
  // promising a message no code path can send. The env schema forbids it; this
  // is the second lock on the same door.
  if (options.mode === "live" && client === undefined) {
    options.logger.error(
      {},
      "whatsapp: live mode without credentials; WhatsApp confirmations are DISABLED for this process (bookings are unaffected)",
    );
    return undefined;
  }

  return new WhatsAppNotifier(
    {
      mode: options.mode,
      ...(options.allowedRecipients !== undefined
        ? { allowedRecipients: options.allowedRecipients }
        : {}),
      calendar,
    },
    store,
    client,
    options.logger,
    options.employeeNames,
  );
}

/**
 * `"34600000123,34600000124"` → a set. Shape is validated at boot by
 * `src/config/env.ts`; anything that still does not look like a recipient is
 * dropped here rather than half-applied.
 */
export function parseAllowedRecipients(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw === undefined) return undefined;
  const recipients = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (/^\d{10,15}$/.test(trimmed)) recipients.add(trimmed);
  }
  return recipients;
}
