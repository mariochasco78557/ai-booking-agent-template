import { z } from "zod";
import { madridDate, madridWallClock } from "../../utils/madridDate.js";
import { normalizeSpanishPhone } from "../../utils/phone.js";
import type { Logger } from "../authTokenService.js";
import type { DashboardRange, DashboardReservation } from "../waSelfService/dashboardMapping.js";
import { resolveWaCaller } from "../waSelfService/waCallerId.js";
import { resolveManageCaller } from "../voiceManage/voiceManageService.js";
import { serviceLabelOf } from "../whatsapp/whatsappNotifier.js";
import type { OpeningGatePort } from "./openingHoursGate.js";
import {
  customerPhrase,
  FALLBACK_WA,
  MSG_DICTATED_INVALID,
  MSG_INVALID_RECADO,
  MSG_NAME_AND_PHONE_NEEDED,
  MSG_PHONE_NEEDED,
  voiceFallback,
} from "./recadoMessages.js";
import type { RecadoStore } from "./recadoStore.js";
import {
  phoneHashOf,
  recadoIdOf,
  type PhoneSource,
  type Recado,
  type RecadoAppointment,
  type RecadoChannel,
  type RecadoKind,
  type RecadoResponse,
} from "./recadoTypes.js";

/**
 * *** THE TWO ENTRANCES OF A RECADO (voice and WhatsApp). ***
 *
 * (internal doc, not included in the template) §A.7. The answer to the agent is IMMEDIATE:
 * it only waits for one fsynced line. The appointment is looked up AFTERWARDS
 * (`enrich`), and Telegram is a worker's business. Never throws. The log of a
 * recado is `{ recado_id, kind, channel, outcome, phone_source, held }` and
 * nothing else: never a name, a phone, the summary or a chat id.
 */

export interface RecadoServiceConfig {
  mode: "dry_run" | "live";
  maxPerPhonePerHour: number;
  maxPerHourGlobal: number;
  /** WA_LOOKUP_HORIZON_DAYS */
  lookupHorizonDays: number;
}

type Headers = Record<string, string | string[] | undefined>;

const HOUR_MS = 3_600_000;
const ENRICH_TIMEOUT_MS = 6_000;
const DICTATED_ATTEMPTS_TTL_MS = HOUR_MS;
const LOOKBACK_MS = 90 * 60_000;
const INTERNATIONAL_RE = /^\+[1-9]\d{7,14}$/;

/** Removes control characters and repeated spaces. */
function sanitize(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const text = (min: number, max: number) =>
  z
    .string()
    .transform(sanitize)
    .pipe(z.string().min(min).max(max));

const CONVERSATION_ID = z.string().trim().regex(/^[A-Za-z0-9_-]{8,128}$/);
const KIND = z.enum(["late", "wants_human", "complaint", "question"]);
// An unreadable value is ignored rather than losing the whole recado.
const MINUTES_LATE = z.number().int().min(1).max(240).optional().catch(undefined);
const OPTIONAL_NAME = z
  .string()
  .transform(sanitize)
  .pipe(z.string().max(80))
  .optional()
  .catch(undefined);

const voiceSchema = z
  .object({
    conversation_id: CONVERSATION_ID,
    caller_phone: z.string().max(40).optional().catch(undefined),
    kind: KIND,
    summary: text(1, 300),
    minutes_late: MINUTES_LATE,
    customer_name: OPTIONAL_NAME,
    dictated_phone: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .pipe(z.string().max(20))
      .optional()
      .catch(undefined),
  })
  .passthrough();

const whatsappSchema = z
  .object({
    conversation_id: CONVERSATION_ID,
    kind: KIND,
    summary: text(1, 300),
    minutes_late: MINUTES_LATE,
    customer_name: OPTIONAL_NAME,
    callback_phone: z.string().trim().max(32).optional().catch(undefined),
    vocero_conversation_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().catch(undefined),
  })
  .passthrough();

/** The earliest standing booking of this phone that has not ended its first 90 minutes. */
export function pickRecadoAppointment(
  rows: DashboardReservation[],
  phoneE164: string,
  nowMs: number,
): DashboardReservation | undefined {
  const from = madridWallClock(nowMs - LOOKBACK_MS);
  let best: DashboardReservation | undefined;
  for (const row of rows) {
    if (row.ownerPhoneE164 !== phoneE164 || row.startsAt < from) continue;
    if (best === undefined || row.startsAt < best.startsAt) best = row;
  }
  return best;
}

function errorLabel(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return error instanceof Error ? error.name : "unknown_error";
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Spanish national or international E.164, else undefined. */
function internationalPhone(raw: string): string | undefined {
  const spanish = normalizeSpanishPhone(raw);
  if (spanish.ok) return spanish.e164;
  const compact = raw.replace(/[\s\-().]/g, "").replace(/^00/, "+");
  return INTERNATIONAL_RE.test(compact) ? compact : undefined;
}

export class RecadoService {
  private readonly dictatedAttempts = new Map<string, number>();

  constructor(
    private readonly config: RecadoServiceConfig,
    /** undefined = the store could not be opened: every answer is `recado_unavailable`. */
    private readonly store: RecadoStore | undefined,
    private readonly gate: OpeningGatePort,
    private readonly appointments:
      | { readStandingRows(range: DashboardRange): Promise<DashboardReservation[]> }
      | undefined,
    private readonly logger: Logger,
    /** kick del worker */
    private readonly onCreated: () => void,
  ) {}

  createFromVoice(body: unknown, nowMs: number): RecadoResponse {
    try {
      const parsed = voiceSchema.safeParse(body);
      if (!parsed.success) return this.invalid("voice");
      const b = parsed.data;
      const dedupeKey = `voz:${b.conversation_id}`;
      const dup = this.duplicate(dedupeKey, b.kind, "voice");
      if (dup !== undefined) return dup;

      let phoneE164: string | null = null;
      let phoneSource: PhoneSource = "none";
      const caller =
        resolveManageCaller(b.caller_phone) ??
        (b.caller_phone !== undefined && INTERNATIONAL_RE.test(b.caller_phone.trim()) ? b.caller_phone.trim() : undefined);
      if (caller !== undefined) {
        phoneE164 = caller;
        phoneSource = "caller";
      } else if (b.dictated_phone === undefined || b.dictated_phone.trim() === "") {
        this.log(undefined, b.kind, "voice", "phone_needed", "none", false);
        return this.respond(
          "phone_needed",
          b.customer_name === undefined || b.customer_name === "" ? MSG_NAME_AND_PHONE_NEEDED : MSG_PHONE_NEEDED,
        );
      } else {
        const dictated = normalizeSpanishPhone(b.dictated_phone);
        if (!dictated.ok) {
          const tries = this.countDictatedFailure(b.conversation_id, nowMs);
          if (tries <= 1) {
            this.log(undefined, b.kind, "voice", "dictated_invalid", "none", false);
            return this.respond("dictated_invalid", MSG_DICTATED_INVALID);
          }
          this.log(undefined, b.kind, "voice", "recado_unavailable", "none", false);
          return this.respond("recado_unavailable", voiceFallback(b.kind));
        }
        phoneE164 = dictated.e164;
        phoneSource = "dictated";
      }

      return this.create({
        channel: "voice",
        dedupeKey,
        kind: b.kind,
        summary: b.summary,
        minutesLate: b.kind === "late" ? (b.minutes_late ?? null) : null,
        customerName: b.customer_name === undefined || b.customer_name === "" ? null : b.customer_name,
        phoneE164,
        phoneSource,
        voceroConversationId: null,
        nowMs,
      });
    } catch (error) {
      this.logger.error({ reason: errorLabel(error) }, "recados: voice entry failed");
      return this.respond("recado_unavailable", MSG_INVALID_RECADO);
    }
  }

  createFromWhatsApp(headers: Headers, body: unknown, nowMs: number): RecadoResponse {
    try {
      const parsed = whatsappSchema.safeParse(body);
      if (!parsed.success) return this.invalid("whatsapp");
      const b = parsed.data;
      const dedupeKey = `wa:${b.conversation_id}`;
      const dup = this.duplicate(dedupeKey, b.kind, "whatsapp");
      if (dup !== undefined) return dup;

      // The phone comes from the header (the platform's), never from the body.
      let phoneE164: string | null = null;
      let phoneSource: PhoneSource = "none";
      const wa = resolveWaCaller(headers);
      if (wa.ok) {
        phoneE164 = wa.e164;
        phoneSource = "whatsapp";
      } else if (b.callback_phone !== undefined && b.callback_phone !== "") {
        const written = internationalPhone(b.callback_phone);
        if (written !== undefined) {
          phoneE164 = written;
          phoneSource = "written";
        }
      }

      return this.create({
        channel: "whatsapp",
        dedupeKey,
        kind: b.kind,
        summary: b.summary,
        minutesLate: b.kind === "late" ? (b.minutes_late ?? null) : null,
        customerName: b.customer_name === undefined || b.customer_name === "" ? null : b.customer_name,
        phoneE164,
        phoneSource,
        voceroConversationId: b.vocero_conversation_id ?? null,
        nowMs,
      });
    } catch (error) {
      this.logger.error({ reason: errorLabel(error) }, "recados: whatsapp entry failed");
      return this.respond("recado_unavailable", FALLBACK_WA);
    }
  }

  /** At boot: redoes the appointment lookup of the recados that never got it. */
  resumeEnrichment(nowMs: number): void {
    if (this.store === undefined) return;
    for (const r of this.store.all()) {
      if ((r.delivery === "held" || r.delivery === "pending") && r.appointment.status === "pending") {
        void this.enrich(r.id, nowMs);
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private respond(outcome: RecadoResponse["outcome"], message: string, extra: Partial<RecadoResponse> = {}): RecadoResponse {
    return { outcome, message, external_mutation: false, ...extra };
  }

  private invalid(channel: RecadoChannel): RecadoResponse {
    this.logger.warn({ channel, outcome: "invalid_request" }, "recados: unreadable request");
    return this.respond("invalid_request", MSG_INVALID_RECADO);
  }

  private fallback(channel: RecadoChannel, kind: RecadoKind): string {
    return channel === "voice" ? voiceFallback(kind) : FALLBACK_WA;
  }

  private log(
    id: string | undefined,
    kind: RecadoKind,
    channel: RecadoChannel,
    outcome: string,
    phoneSource: PhoneSource,
    held: boolean,
  ): void {
    this.logger.info(
      { ...(id !== undefined ? { recado_id: id } : {}), kind, channel, outcome, phone_source: phoneSource, held },
      "recados: entry",
    );
  }

  /** dry_run is invisible to the customer: every answer carries the fallback phrase of the channel. */
  private phrase(channel: RecadoChannel, kind: RecadoKind): string {
    return this.config.mode === "dry_run" ? this.fallback(channel, kind) : customerPhrase(kind);
  }

  private duplicate(dedupeKey: string, kind: RecadoKind, channel: RecadoChannel): RecadoResponse | undefined {
    if (this.store === undefined) return undefined;
    const id = recadoIdOf(dedupeKey);
    const existing = this.store.get(id);
    if (existing === undefined) return undefined;
    this.log(id, kind, channel, "recado_duplicate", existing.phoneSource, existing.heldAtCreation);
    return this.respond("recado_duplicate", this.phrase(channel, kind), { duplicate: true });
  }

  /** Failed dictated numbers of this call (memory, 1 h TTL). Returns the count including this one. */
  private countDictatedFailure(conversationId: string, nowMs: number): number {
    for (const [key, at] of this.dictatedAttempts) {
      if (nowMs - at >= DICTATED_ATTEMPTS_TTL_MS) this.dictatedAttempts.delete(key);
    }
    const key = `${conversationId}`;
    const previous = this.dictatedAttempts.has(key) ? 1 : 0;
    this.dictatedAttempts.set(key, nowMs);
    return previous + 1;
  }

  private create(input: {
    channel: RecadoChannel;
    dedupeKey: string;
    kind: RecadoKind;
    summary: string;
    minutesLate: number | null;
    customerName: string | null;
    phoneE164: string | null;
    phoneSource: PhoneSource;
    voceroConversationId: string | null;
    nowMs: number;
  }): RecadoResponse {
    const { channel, kind, nowMs } = input;
    const store = this.store;
    if (store === undefined) {
      this.log(undefined, kind, channel, "recado_unavailable", input.phoneSource, false);
      return this.respond("recado_unavailable", this.fallback(channel, kind));
    }

    if (store.countSince(nowMs - HOUR_MS) >= this.config.maxPerHourGlobal) {
      this.logger.warn({ channel, kind, outcome: "recado_unavailable", reason: "global_cap" }, "recados: global hourly cap reached");
      return this.respond("recado_unavailable", this.fallback(channel, kind));
    }

    const phoneHash = input.phoneE164 === null ? null : phoneHashOf(input.phoneE164);
    if (phoneHash !== null && store.countSince(nowMs - HOUR_MS, phoneHash) >= this.config.maxPerPhonePerHour) {
      this.log(undefined, kind, channel, "recado_limit", input.phoneSource, false);
      return this.respond("recado_limit", this.phrase(channel, kind));
    }

    const held = !this.gate.isOpenAt(nowMs);
    const spanish = input.phoneE164 !== null && normalizeSpanishPhone(input.phoneE164).ok;
    const appointment: RecadoAppointment =
      spanish && this.appointments !== undefined ? { status: "pending" } : { status: "not_searched" };
    const recado: Recado = {
      id: recadoIdOf(input.dedupeKey),
      dedupeKey: input.dedupeKey,
      kind,
      channel,
      createdAt: nowMs,
      summary: input.summary,
      minutesLate: input.minutesLate,
      customerName: input.customerName,
      phoneE164: input.phoneE164,
      phoneSource: input.phoneSource,
      phoneHash,
      voceroConversationId: input.voceroConversationId,
      appointment,
      heldAtCreation: held,
      delivery: held ? "held" : "pending",
      attempts: 0,
      nextAttemptAt: nowMs,
      lastError: null,
      messageId: null,
      sentAt: null,
      handledAt: null,
      reminderMessageId: null,
      remindedAt: null,
      reminderAttempts: 0,
    };

    try {
      if (!store.insert(recado)) {
        // Lost a race with the same conversation: it is a duplicate.
        this.log(recado.id, kind, channel, "recado_duplicate", input.phoneSource, held);
        return this.respond("recado_duplicate", this.phrase(channel, kind), { duplicate: true });
      }
    } catch (error) {
      this.logger.error({ channel, kind, reason: errorLabel(error) }, "recados: the recado could not be stored");
      return this.respond("recado_unavailable", this.fallback(channel, kind));
    }

    if (appointment.status === "pending") void this.enrich(recado.id, nowMs);
    try {
      this.onCreated();
    } catch {
      // the worker's kick must never change the answer
    }

    if (this.config.mode === "dry_run") {
      this.log(recado.id, kind, channel, "recado_dry_run", input.phoneSource, held);
      return this.respond("recado_dry_run", this.fallback(channel, kind), { dry_run: true });
    }
    this.log(recado.id, kind, channel, "recado_queued", input.phoneSource, held);
    return this.respond("recado_queued", customerPhrase(kind));
  }

  /** Looks up the appointment of the recado's phone and records it. Never throws. */
  private async enrich(id: string, nowMs: number): Promise<void> {
    const store = this.store;
    const appointments = this.appointments;
    if (store === undefined || appointments === undefined) return;
    let result: RecadoAppointment;
    try {
      const recado = store.get(id);
      if (recado === undefined || recado.phoneE164 === null) return;
      const today = madridDate(nowMs);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ENRICH_TIMEOUT_MS);
        timer.unref();
      });
      let rows: DashboardReservation[];
      try {
        rows = await Promise.race([
          appointments.readStandingRows({ fromDate: today, toDate: addDays(today, this.config.lookupHorizonDays) }),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const row = pickRecadoAppointment(rows, recado.phoneE164, nowMs);
      result =
        row === undefined
          ? { status: "none" }
          : {
              status: "found",
              startsAt: row.startsAt,
              professional: row.employeeName,
              service: serviceLabelOf(row.typeReservation ?? undefined),
              bookedName: `${row.ownerName} ${row.ownerSurnames}`.trim(),
            };
    } catch {
      result = { status: "error" };
    }
    try {
      const current = store.get(id);
      if (current === undefined || current.appointment.status !== "pending") return;
      store.update({ ...current, appointment: result });
      this.onCreated();
    } catch (error) {
      this.logger.error({ recado_id: id, reason: errorLabel(error) }, "recados: the appointment could not be recorded");
    }
  }
}
