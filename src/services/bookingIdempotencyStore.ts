import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * step PROD (Hito 6) — "one booking per conversation, and idempotency that
 * survives a restart".
 *
 * The problem this file exists to solve
 * -------------------------------------
 * `VoiceBookingService` remembers which `conversation_id` already produced a
 * booking, so a retry from ElevenLabs replays the first answer instead of
 * creating a second appointment. Until now that memory was a plain `Map`, and
 * a `Map` dies with the process.
 *
 * That is not a theoretical gap. ElevenLabs retries a tool call that did not
 * answer in time; `unattended-upgrades`, a `docker compose up`, an OOM kill or
 * a crash can restart the container between the write and the retry. The retry
 * then arrives at a process with an empty map, is treated as brand new, and
 * books the same customer twice. The customer finds out at the salon.
 *
 * So: while creation is disabled the in-memory store is honest and enough.
 * The moment creation is armed in production, a durable store is mandatory —
 * `src/config/env.ts` refuses to boot without one.
 *
 * Why a JSON-lines file and not SQLite
 * ------------------------------------
 * The write rate is a handful of bookings a day. An append of one line plus an
 * `fsync` is already stronger than what a database would give without explicit
 * durability settings, it adds no native dependency to an Alpine image, and it
 * is inspectable with `cat` during an incident. A database here would be more
 * moving parts protecting less.
 *
 * What is written to disk
 * -----------------------
 * A conversation id, a keyed fingerprint, a timestamp, and the short Spanish
 * result the agent already spoke. No name, no phone, no reservation id. (A
 * WhatsApp-channel answer may also hold its `calendar_url` — ADR-031 addendum
 * — whose signed token carries only an hour, a barber and a service.) The
 * fingerprint is an HMAC (see `VoiceBookingService`), not a bare hash, so the
 * file cannot be brute-forced back into phone numbers by anyone who obtains it
 * without also holding the webhook secret. Records expire (TTL) and the file
 * is compacted at boot, so it does not accumulate indefinitely.
 */

/** How long a completed booking stays replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling on live records held in memory. A phone call cannot produce more
 * than one record, so this is far above any real day; it exists so that a
 * misbehaving caller cannot turn the store into an unbounded memory sink.
 */
export const IDEMPOTENCY_MAX_ENTRIES = 5_000;

/**
 * step CTL-3 (phase 3) — the durable write state machine.
 *
 * Before this existed the store only ever recorded SUCCESS, which left the
 * dangerous half of the problem uncovered. On 2026-08-30 a booking for an
 * unregistered-looking caller was refused by upstream and ElevenLabs
 * immediately re-invoked the tool: four identical create requests reached the
 * salon's API in eleven seconds, because a failure left no trace to replay.
 *
 * The four states, and what each one licenses:
 *
 * - `started`   — written BEFORE the request leaves this process. If it is
 *                 still `started` when the file is next loaded, the process
 *                 died mid-write: promoted to `uncertain` on load, never
 *                 retried.
 * - `confirmed` — the appointment exists. Replay the same answer.
 * - `rejected`  — upstream (or a local gate) definitively refused. Replay the
 *                 refusal; repeating the identical command would only earn
 *                 the identical refusal.
 * - `uncertain` — timeout, dropped connection, 5xx, unreadable reply. The
 *                 appointment MAY exist. Replay the uncertain answer and
 *                 never, under any circumstance, write again.
 */
export type IdempotencyState = "started" | "confirmed" | "rejected" | "uncertain";

/**
 * 2026-10-08 — what the VOICE path remembers about one booking of a call so a
 * later request in the SAME call can change it (`replaces_booking_number`) or
 * be stopped from silently duplicating it. Written only by a multi-booking
 * voice request; every other record carries none.
 *
 * No name, no phone: `ph` and `who` are HMACs keyed exactly like the command
 * fingerprint, so the file still cannot be turned back into a phone number.
 * `at`/`emp` are an hour and a barber — the same facts a calendar link holds.
 */
export interface BookingJournalMeta {
  /** `YYYY-MM-DD HH:mm:ss` of the appointment, from the slot grant. */
  readonly at: string;
  /** The barber, from the slot grant, when it named one. */
  readonly emp?: number;
  /** Keyed HMAC of the nine-digit phone. Ownership of a change. */
  readonly ph: string;
  /** Keyed HMAC of name + surnames + phone, normalised. The duplicate net. */
  readonly who: string;
  /**
   * 2026-10-10 — keyed HMAC of the FIRST given name + phone. The duplicate net
   * also matches on it (a change re-sent with other surnames, call pp3x4v).
   * Absent on lines written before 2026-10-10: `who` alone then.
   */
  readonly fn?: string;
  /**
   * 2026-10-10 — on the NEW booking of a change of an EXISTING booking: keyed
   * HMAC of the reservation id it replaces (never the id itself).
   */
  readonly xr?: string;
  /** The `booking_number` the agent was told for this booking. */
  readonly n?: number;
  /** On the NEW booking of a change: the JOURNAL number it replaces. */
  readonly rep?: number;
  /** On the OLD booking of a change: the booking number that replaced it. */
  readonly by?: number;
  /** On the OLD booking of a change: where its cancellation stands. */
  readonly cx?: "pending" | "cancelled" | "not_cancelled" | "unknown";
}

export interface IdempotencyRecord<TResult> {
  /** Keyed fingerprint of the exact command that produced `result`. */
  readonly fingerprint: string;
  /** The stored answer, replayed verbatim to an identical retry. */
  readonly result: TResult;
  /** When it was stored, in epoch milliseconds. */
  readonly storedAtMs: number;
  /**
   * See {@link IdempotencyState}. Optional so a file written before phase 3
   * still loads: a line with no state is, by construction, one of the old
   * success-only records, so it reads back as `confirmed`.
   */
  readonly state?: IdempotencyState;
  /**
   * Whether a write request actually reached the salon's API for this attempt.
   * Recorded for operators reading the journal during an incident; the replay
   * decision is driven by `state` alone.
   */
  readonly upstreamAttempted?: boolean;
  /** See {@link BookingJournalMeta}. Absent on every record but a voice
   * multi-booking one, and on every line written before 2026-10-08. */
  readonly meta?: BookingJournalMeta;
}

export interface BookingIdempotencyStore<TResult> {
  /** The live record for a conversation, or undefined if none/expired. */
  get(conversationId: string, nowMs: number): IdempotencyRecord<TResult> | undefined;
  /** Records a completed booking. Durable stores return only once written. */
  remember(conversationId: string, record: IdempotencyRecord<TResult>): void;
  /** True when a restart cannot lose what was remembered. */
  readonly durable: boolean;
}

/**
 * Shared bookkeeping: TTL, bounding, and last-write-wins. Both stores use it;
 * the file store additionally persists.
 */
class InMemoryIndex<TResult> {
  protected readonly entries = new Map<string, IdempotencyRecord<TResult>>();

  protected prune(nowMs: number): void {
    for (const [id, record] of this.entries) {
      if (nowMs - record.storedAtMs >= IDEMPOTENCY_TTL_MS) this.entries.delete(id);
    }
    // Map iteration order is insertion order, so the first keys are the
    // oldest writes. Evicting from the front keeps the most recent — the ones
    // a retry could still plausibly be about.
    while (this.entries.size > IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  get(conversationId: string, nowMs: number): IdempotencyRecord<TResult> | undefined {
    const record = this.entries.get(conversationId);
    if (record === undefined) return undefined;
    if (nowMs - record.storedAtMs >= IDEMPOTENCY_TTL_MS) {
      this.entries.delete(conversationId);
      return undefined;
    }
    return record;
  }
}

/**
 * Non-durable store. Correct and sufficient while creation is disabled, which
 * is the state this deployment ships in.
 */
export class MemoryBookingIdempotencyStore<TResult>
  extends InMemoryIndex<TResult>
  implements BookingIdempotencyStore<TResult>
{
  readonly durable = false;

  remember(conversationId: string, record: IdempotencyRecord<TResult>): void {
    this.entries.set(conversationId, record);
    this.prune(record.storedAtMs);
  }
}

interface PersistedLine<TResult> {
  v: 1;
  id: string;
  fp: string;
  at: number;
  result: TResult;
  /** Absent on pre-phase-3 lines; see {@link IdempotencyRecord.state}. */
  st?: IdempotencyState;
  /** Absent on pre-phase-3 lines. */
  ua?: boolean;
  /** Absent unless the record carries {@link IdempotencyRecord.meta}. */
  m?: BookingJournalMeta;
}

/** One journal line for a record, omitting keys the record does not carry. */
function persistedLine<TResult>(
  id: string,
  record: IdempotencyRecord<TResult>,
): PersistedLine<TResult> {
  return {
    v: 1,
    id,
    fp: record.fingerprint,
    at: record.storedAtMs,
    result: record.result,
    ...(record.state !== undefined ? { st: record.state } : {}),
    ...(record.upstreamAttempted !== undefined ? { ua: record.upstreamAttempted } : {}),
    ...(record.meta !== undefined ? { m: record.meta } : {}),
  };
}

/**
 * Durable store: an append-only JSON-lines file, fsynced on every write and
 * compacted at construction.
 */
export class FileBookingIdempotencyStore<TResult>
  extends InMemoryIndex<TResult>
  implements BookingIdempotencyStore<TResult>
{
  readonly durable = true;

  /**
   * @param path  File to persist to. Its directory must already exist or be
   *              creatable; construction throws otherwise, on purpose — a
   *              durable store that silently degrades to a volatile one is
   *              worse than no durable store at all, because the operator
   *              believes they have a guarantee they do not have.
   * @param nowMs Current time, injected so tests are not clock-dependent.
   */
  constructor(
    private readonly path: string,
    nowMs: number,
    private readonly onWarning: (message: string, detail: Record<string, number>) => void = () => {},
  ) {
    super();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.load(nowMs);
    this.compact();
    // Prove writability NOW rather than at the first booking. Discovering a
    // read-only volume when a customer is on the phone is the wrong time.
    this.append("");
  }

  private load(nowMs: number): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let skipped = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: PersistedLine<TResult>;
      try {
        parsed = JSON.parse(trimmed) as PersistedLine<TResult>;
      } catch {
        // A torn final line is the expected shape of a crash mid-append.
        // Dropping it is right: that booking never got a durable answer, so
        // treating the retry as new is the safe direction.
        skipped += 1;
        continue;
      }
      if (parsed?.v !== 1 || typeof parsed.id !== "string" || typeof parsed.fp !== "string" || typeof parsed.at !== "number") {
        skipped += 1;
        continue;
      }
      if (nowMs - parsed.at >= IDEMPOTENCY_TTL_MS) continue;
      // A line still reading `started` means the process died between
      // announcing the write and learning its outcome. That is the textbook
      // definition of not knowing whether the appointment exists, so it is
      // promoted to `uncertain` — which is a state that never authorizes
      // another write. Promoting on LOAD rather than at read time means the
      // very next compaction persists the promotion.
      const state: IdempotencyState =
        parsed.st === undefined ? "confirmed" : parsed.st === "started" ? "uncertain" : parsed.st;
      // Later lines for the same conversation win, which is what append-only
      // replay means.
      this.entries.set(parsed.id, {
        fingerprint: parsed.fp,
        result: parsed.result,
        storedAtMs: parsed.at,
        state,
        ...(parsed.ua !== undefined ? { upstreamAttempted: parsed.ua } : {}),
        ...(parsed.m !== undefined && typeof parsed.m === "object" && parsed.m !== null
          ? { meta: parsed.m }
          : {}),
      });
    }
    this.prune(nowMs);
    if (skipped > 0) this.onWarning("idempotency store: skipped unreadable lines", { skipped });
  }

  /**
   * Rewrites the file with only the live records, via a temp file + rename so
   * the real path is never observed half-written. Bounds file growth without
   * any scheduled job.
   */
  private compact(): void {
    const body = [...this.entries]
      .map(([id, record]) => JSON.stringify(persistedLine(id, record)))
      .join("\n");
    const temp = `${this.path}.compact`;
    writeFileSync(temp, body === "" ? "" : `${body}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  /**
   * Synchronous by design. The alternative — an async append — would let the
   * handler answer "booked" before the record reached the disk, which is the
   * exact window this store exists to close. At a few bookings a day, blocking
   * the event loop for one fsync is free.
   */
  private append(line: string): void {
    const fd = openSync(this.path, "a", 0o600);
    try {
      if (line !== "") writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  remember(conversationId: string, record: IdempotencyRecord<TResult>): void {
    // Disk first, then memory. If the append throws, the caller sees the
    // failure instead of a process that believes it recorded something it did
    // not; the booking is reported as an error and the retry is safe.
    this.append(`${JSON.stringify(persistedLine(conversationId, record))}\n`);
    this.entries.set(conversationId, record);
    this.prune(record.storedAtMs);
  }
}
