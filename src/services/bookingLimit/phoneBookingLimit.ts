/**
 * 2026-10-09 — *** AT MOST N PENDING (FUTURE) APPOINTMENTS PER PHONE. ***
 * (internal doc, not included in the template)
 *
 * Counted on the salon's agenda itself — the SAME dashboard read and the SAME
 * «still standing» filter as the WhatsApp «mis citas» (`WaSelfService`,
 * `splitByState`) — so a booking made by voice, by WhatsApp or by the staff in the
 * app all count, and a cancelled one does not.
 *
 * *** FAIL-OPEN. *** Booking reliably matters more than the cap: if the
 * agenda cannot be read inside {@link PhoneBookingLimitConfig.readBudgetMs},
 * or the read fails, the booking goes ahead and the miss is logged.
 *
 * *** WHY A SNAPSHOT, AND WHEN IT IS TRUSTED. *** The dashboard is salon-wide
 * (it cannot be asked for one phone), so a read at create time would add its
 * whole latency to the silence the caller hears. Instead every `lock` (the
 * step right before the customer's data and the summary) starts a read in the
 * background ({@link prefetch}); the create then usually finds a fresh one
 * and the check costs no I/O at all. A snapshot is used for a phone only when
 * it was REQUESTED after the last booking or cancellation this process made
 * for that phone ({@link markChanged}) and is at most `snapshotMaxAgeMs` old;
 * otherwise the create reads the agenda itself, within the budget.
 *
 * What a snapshot can miss: changes the staff make by hand in the app during its
 * lifetime (minutes). A booking they add is missed (fail-open direction); one they
 * delete is still counted, which can refuse a booking that would have been
 * the customer's third — rare, and the refusal sends the customer to the staff.
 *
 * Never logs a full phone: `maskPhoneStrict` only.
 */
import { madridDate, madridWallClock } from "../../utils/madridDate.js";
import { maskPhoneStrict } from "../../utils/mask.js";
import { t } from "../../core/texts/texts.js";

/** One standing appointment of the agenda: who, and when (Madrid wall clock). */
export interface StandingRow {
  ownerPhoneE164: string | null;
  /** "YYYY-MM-DD HH:mm". */
  startsAt: string;
}

/** Reads the standing (not cancelled, known state) rows of a date range. */
export interface StandingRowsReader {
  readStandingRows(range: { fromDate: string; toDate: string }): Promise<StandingRow[]>;
}

export interface PhoneBookingLimitConfig {
  /** `MAX_FUTURE_BOOKINGS_PER_PHONE`, ≥ 1 (0 means no limiter is built). */
  max: number;
  /** Days ahead counted (`WA_LOOKUP_HORIZON_DAYS`, the «mis citas» horizon). */
  horizonDays: number;
  /** Longest a create may wait for the agenda before going ahead anyway. */
  readBudgetMs: number;
  /** Oldest snapshot a create may use. Default 180 s. */
  snapshotMaxAgeMs?: number;
  /** A lock refreshes a snapshot older than this. Default 30 s. */
  prefetchMinIntervalMs?: number;
}

export type PhoneLimitCheck =
  | { decision: "allow"; count: number; source: "snapshot" | "read"; waitedMs: number }
  | { decision: "refuse"; count: number; source: "snapshot" | "read"; waitedMs: number }
  | { decision: "allow"; count: null; source: "unknown"; waitedMs: number; why: "timeout" | "error" };

interface Logger {
  info: (detail: Record<string, unknown>, message: string) => void;
  warn: (detail: Record<string, unknown>, message: string) => void;
}

interface Snapshot {
  requestedAtMs: number;
  /** Future-or-today rows, phone → start times. */
  byPhone: Map<string, string[]>;
}

const DEFAULT_SNAPSHOT_MAX_AGE_MS = 180_000;
const DEFAULT_PREFETCH_MIN_INTERVAL_MS = 30_000;
/** Bound on the per-phone change marks kept in memory. */
const CHANGE_MARKS_MAX = 10_000;

function addDays(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export class PhoneBookingLimit {
  private snapshot: Snapshot | undefined;
  private inFlight: { requestedAtMs: number; promise: Promise<Snapshot | undefined> } | undefined;
  /** phone → epoch ms of the last booking / cancellation this process made for it. */
  private readonly changedAt = new Map<string, number>();
  private latestChangeMs = 0;
  private readonly snapshotMaxAgeMs: number;
  private readonly prefetchMinIntervalMs: number;

  constructor(
    private readonly config: PhoneBookingLimitConfig,
    private readonly reader: StandingRowsReader,
    private readonly logger?: Logger,
    /** Tests only. */
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isInteger(config.max) || config.max < 1) {
      throw new Error(`PhoneBookingLimit: max must be a positive integer (got ${config.max})`);
    }
    this.snapshotMaxAgeMs = config.snapshotMaxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS;
    this.prefetchMinIntervalMs = config.prefetchMinIntervalMs ?? DEFAULT_PREFETCH_MIN_INTERVAL_MS;
  }

  get max(): number {
    return this.config.max;
  }

  /**
   * Called at every `lock`. Starts a background read unless a recent one
   * exists or is running. Never throws, never awaited by the caller.
   */
  prefetch(): void {
    try {
      const now = this.clock();
      if (this.inFlight !== undefined && this.inFlight.requestedAtMs >= this.latestChangeMs) return;
      const snap = this.snapshot;
      if (
        snap !== undefined &&
        now - snap.requestedAtMs < this.prefetchMinIntervalMs &&
        snap.requestedAtMs >= this.latestChangeMs
      ) {
        return;
      }
      void this.startRead(now).promise;
    } catch {
      // A prefetch is an optimisation; nothing may fail because of it.
    }
  }

  /**
   * A booking was created (or may have been) or cancelled for this phone: a
   * snapshot requested before now no longer describes it.
   */
  markChanged(phoneE164: string): void {
    const now = this.clock();
    if (this.changedAt.size >= CHANGE_MARKS_MAX && !this.changedAt.has(phoneE164)) {
      // Marks older than any usable snapshot carry no information.
      const cutoff = now - this.snapshotMaxAgeMs - this.config.readBudgetMs;
      for (const [phone, at] of this.changedAt) if (at < cutoff) this.changedAt.delete(phone);
      if (this.changedAt.size >= CHANGE_MARKS_MAX) this.changedAt.clear();
    }
    this.changedAt.set(phoneE164, now);
    this.latestChangeMs = Math.max(this.latestChangeMs, now);
  }

  /**
   * How many future appointments `phoneE164` has, and whether one more is
   * allowed. Never throws: anything unexpected is `allow` / `unknown`.
   */
  async check(phoneE164: string): Promise<PhoneLimitCheck> {
    const started = this.clock();
    try {
      const changed = this.changedAt.get(phoneE164) ?? -Infinity;
      const usable = (s: Snapshot | undefined): s is Snapshot =>
        s !== undefined && s.requestedAtMs > changed && started - s.requestedAtMs <= this.snapshotMaxAgeMs;

      if (usable(this.snapshot)) {
        return this.decide(phoneE164, this.snapshot, "snapshot", started);
      }
      const pending =
        this.inFlight !== undefined && this.inFlight.requestedAtMs > changed
          ? this.inFlight
          : this.startRead(started);
      const snap = await this.withinBudget(pending.promise);
      if (snap === "timeout") return this.unknown(phoneE164, "timeout", started);
      if (snap === undefined) return this.unknown(phoneE164, "error", started);
      return this.decide(phoneE164, snap, "read", started);
    } catch {
      return this.unknown(phoneE164, "error", started);
    }
  }

  private decide(
    phoneE164: string,
    snap: Snapshot,
    source: "snapshot" | "read",
    started: number,
  ): PhoneLimitCheck {
    const nowWall = madridWallClock(this.clock());
    const count = (snap.byPhone.get(phoneE164) ?? []).filter((at) => at > nowWall).length;
    const waitedMs = this.clock() - started;
    if (count >= this.config.max) {
      this.logger?.warn(
        { phone: maskPhoneStrict(phoneE164), future_bookings: count, max: this.config.max, source },
        "booking refused: this phone already has the maximum number of pending appointments",
      );
      return { decision: "refuse", count, source, waitedMs };
    }
    return { decision: "allow", count, source, waitedMs };
  }

  private unknown(phoneE164: string, why: "timeout" | "error", started: number): PhoneLimitCheck {
    const waitedMs = this.clock() - started;
    this.logger?.warn(
      { phone: maskPhoneStrict(phoneE164), why, waited_ms: waitedMs },
      "booking limit per phone not checked (agenda unreadable in time); booking goes ahead (fail-open)",
    );
    return { decision: "allow", count: null, source: "unknown", waitedMs, why };
  }

  private withinBudget(promise: Promise<Snapshot | undefined>): Promise<Snapshot | undefined | "timeout"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), this.config.readBudgetMs);
      void promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
    });
  }

  private startRead(nowMs: number): { requestedAtMs: number; promise: Promise<Snapshot | undefined> } {
    const fromDate = madridDate(nowMs);
    const toDate = addDays(fromDate, this.config.horizonDays);
    const entry = {
      requestedAtMs: nowMs,
      promise: this.reader
        .readStandingRows({ fromDate, toDate })
        .then((rows): Snapshot => {
          const byPhone = new Map<string, string[]>();
          for (const row of rows) {
            if (row.ownerPhoneE164 === null) continue;
            const list = byPhone.get(row.ownerPhoneE164);
            if (list) list.push(row.startsAt);
            else byPhone.set(row.ownerPhoneE164, [row.startsAt]);
          }
          const snap: Snapshot = { requestedAtMs: nowMs, byPhone };
          if (this.snapshot === undefined || this.snapshot.requestedAtMs < nowMs) this.snapshot = snap;
          this.logger?.info(
            { rows: rows.length, read_ms: this.clock() - nowMs },
            "booking limit per phone: agenda snapshot read",
          );
          return snap;
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight === entry) this.inFlight = undefined;
        }),
    };
    this.inFlight = entry;
    return entry;
  }
}

const NUMBER_WORDS_ES = ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];

/** «tres citas pendientes» / «una cita pendiente». */
function pendingPhrase(max: number): string {
  const word = NUMBER_WORDS_ES[max] ?? String(max);
  return max === 1 ? "una cita pendiente" : `${word} citas pendientes`;
}

/** Voice: the customer is sent to WhatsApp, where the staff can handle it (texts layer, D-012). */
export function phoneBookingLimitVoiceMessage(max: number): string {
  return t("limite_citas.voz", { pendientes: pendingPhrase(max) });
}

/** WhatsApp: the brain offers the notice to the staff (AVISO). */
export function phoneBookingLimitWhatsAppMessage(max: number): string {
  return t("limite_citas.whatsapp", { pendientes: pendingPhrase(max) });
}
