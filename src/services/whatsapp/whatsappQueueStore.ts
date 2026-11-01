import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * *** THE WHATSAPP QUEUE — a promise made on the phone, kept off it. ***
 *
 * The agent confirms an appointment out loud and the customer expects a
 * WhatsApp. Sending it inside the tool call would be the obvious
 * implementation and it is the wrong one: `POST /ai/voice/v2/book` answers
 * inside ElevenLabs' 8 s tool timeout, the write upstream already spends up to
 * ~2.5 s of it, and Meta's Graph API is a third party this middleware does not
 * control. A slow Meta would turn a CREATED appointment into an `uncertain`
 * answer — a real appointment the agent cannot announce — which is the exact
 * failure this queue exists to make impossible.
 *
 * So the booking path only ever does this: append one line, fsync, return.
 * Milliseconds, no network, and — because {@link WhatsAppNotifier} wraps every
 * call to it — no exception that could reach the booking. The HTTP send
 * happens later, in a worker, where taking a minute costs nobody anything.
 *
 * ── Why the same JSON-lines file the idempotency journal uses ─────────────
 *
 * Deliberately the same construction as `src/services/bookingIdempotencyStore.ts`
 * (append + `fsync`, compaction by temp file + rename, directory mode 0700),
 * for the same reasons stated there: a handful of writes a day, no native
 * dependency in an Alpine image, and a file an operator can `cat` during an
 * incident. Copying a proven pattern is worth more here than any improvement
 * a second mechanism could offer.
 *
 * The one difference is what a failure MEANS. Losing the idempotency journal
 * can double-book a customer, so that store refuses to exist if it cannot
 * write. Losing this one costs a WhatsApp message, so a queue that cannot be
 * built or written degrades to "no notifications" and NEVER to "no booking" —
 * see `createWhatsAppNotifier` in `whatsappNotifier.ts`.
 *
 * ── What is written to disk ───────────────────────────────────────────────
 *
 * A phone number, a first name, an hour and a professional's name: the same
 * data the salon's own agenda holds, and strictly less than the upstream
 * reservation. It is NOT masked in the file — the worker has to dial it — so
 * the file lives in the same 0700 directory as the journal and nothing in it
 * is ever logged unmasked (`maskPhone`). The access token is never persisted.
 */

/** Where a job is in its life. Only `pending` is ever retried. */
export type WhatsAppJobStatus =
  /** Waiting for its turn (or for its backoff to elapse). */
  | "pending"
  /** Meta accepted it and returned a message id. */
  | "sent"
  /** `WHATSAPP_NOTIFICATIONS_MODE=dry_run`: logged, never dialled. */
  | "sent_dry_run"
  /** Definitively given up on: a non-retryable refusal, or attempts exhausted. */
  | "failed"
  /** Outside `WHATSAPP_ALLOWED_RECIPIENTS` — Meta's test-number phase. */
  | "skipped_not_allowed";

/** The only kind of message this middleware sends. Part of the job key. */
export type WhatsAppJobKind = "confirmation";

export interface WhatsAppJob {
  /** `"<kind>:<reservationId>"` — see {@link whatsappJobKey}. */
  readonly id: string;
  readonly kind: WhatsAppJobKind;
  /** The upstream appointment this message is about. */
  readonly reservationId: number;
  /** For correlating a message with the call that produced it, in logs. */
  readonly conversationId: string;
  /** Meta's recipient shape: country code + national digits, no `+`. */
  readonly to: string;
  /** As the caller gave it; the template greets with the first name only. */
  readonly customerName: string;
  /** The barber, or `null` when this process could not name one. */
  readonly professionalName: string | null;
  /**
   * «Corte de pelo», for the calendar entry only (never in the message text).
   * Optional so a line written before the calendar link existed still loads;
   * absent or `null` simply leaves the service out of the event.
   */
  readonly serviceLabel?: string | null;
  /**
   * `YYYY-MM-DDTHH:mm:ss` — Europe/Madrid WALL CLOCK, with no offset and no
   * `Z`, because that is what upstream stores and what the customer will
   * read. It is deliberately NOT an instant: see `whatsappTemplate.ts`.
   */
  readonly startsAtIso: string;
  readonly createdAt: number;
  readonly status: WhatsAppJobStatus;
  /** How many times the message has actually been dialled. */
  readonly attempts: number;
  /** Epoch ms before which the worker leaves this job alone. */
  readonly nextAttemptAt: number;
  /** Short, non-secret reason of the last failure. Never a token. */
  readonly lastError: string | null;
  readonly providerMessageId: string | null;
  readonly sentAt: number | null;
}

/**
 * ONE job per appointment and kind.
 *
 * The key is what makes a second enqueue for the same appointment a no-op
 * rather than a second WhatsApp. The booking path already guarantees it is
 * reached once per confirmed write (a replayed booking never re-enters
 * `runUpstreamBook`), so this is the belt to that braces — and the reason the
 * job id is derived rather than random.
 */
export function whatsappJobKey(job: Pick<WhatsAppJob, "kind" | "reservationId">): string {
  return `${job.kind}:${job.reservationId}`;
}

/** How long a finished job stays in the file, for an operator to inspect. */
export const WHATSAPP_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ceiling on jobs held in memory. A confirmed appointment produces one job, so
 * this is far above any real week; it exists so the queue cannot become an
 * unbounded memory sink if something upstream starts behaving strangely.
 */
export const WHATSAPP_QUEUE_MAX_ENTRIES = 5_000;

export interface WhatsAppQueueStore {
  /**
   * Adds a job unless its key is already present. Returns whether it was
   * added. Durable implementations return only once the line is on disk, and
   * THROW if it could not be written — the caller decides what that means.
   */
  enqueue(job: WhatsAppJob): boolean;
  /** Records a transition. Same durability contract as {@link enqueue}. */
  update(job: WhatsAppJob): void;
  /** `pending` jobs whose `nextAttemptAt` has arrived, oldest deadline first. */
  due(nowMs: number): WhatsAppJob[];
  /** One job by key, for diagnostics and tests. */
  get(key: string): WhatsAppJob | undefined;
  /** Every live job, in insertion order. Diagnostics and tests. */
  all(): WhatsAppJob[];
}

interface PersistedLine {
  v: 1;
  job: WhatsAppJob;
}

/** Whether a parsed line carries everything the worker needs. */
function isUsableJob(value: unknown): value is WhatsAppJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Partial<WhatsAppJob>;
  return (
    typeof job.id === "string" &&
    job.kind === "confirmation" &&
    typeof job.reservationId === "number" &&
    typeof job.to === "string" &&
    typeof job.status === "string" &&
    typeof job.attempts === "number" &&
    typeof job.nextAttemptAt === "number" &&
    typeof job.createdAt === "number"
  );
}

/** A finished job old enough to stop carrying around. */
function expired(job: WhatsAppJob, nowMs: number): boolean {
  return job.status !== "pending" && nowMs - job.createdAt >= WHATSAPP_JOB_RETENTION_MS;
}

/**
 * The durable queue: an append-only JSON-lines file, fsynced on every write
 * and compacted at construction.
 *
 * Every line is the WHOLE job in its new state, not a diff. Replay is then
 * "the last line for a key wins", which is the same rule the idempotency
 * journal uses and the only one that survives a torn write without a schema
 * for partial updates.
 */
export class FileWhatsAppQueueStore implements WhatsAppQueueStore {
  private readonly jobs = new Map<string, WhatsAppJob>();

  /**
   * @param path    File to persist to; its directory is created 0700.
   * @param nowMs   Current time, injected so tests are not clock-dependent.
   * @param onWarning Told about unreadable lines. Never handed a phone number.
   */
  constructor(
    private readonly path: string,
    nowMs: number,
    private readonly onWarning: (message: string, detail: Record<string, number>) => void = () => {},
  ) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.load(nowMs);
    this.compact();
    // Prove writability NOW rather than at the first confirmed booking. The
    // notifier turns a throw here into "notifications are off", which is the
    // whole point of discovering it at boot instead of mid-call.
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
      let parsed: PersistedLine;
      try {
        parsed = JSON.parse(trimmed) as PersistedLine;
      } catch {
        // A torn final line is the expected shape of a crash mid-append.
        // Dropping it is right: that job never got a durable record, so the
        // message was never promised to anybody.
        skipped += 1;
        continue;
      }
      if (parsed?.v !== 1 || !isUsableJob(parsed.job)) {
        skipped += 1;
        continue;
      }
      // Later lines win, which is what append-only replay means — including
      // when the later line is the one that aged out: a job whose FINAL state
      // is past retention must take its earlier states with it, or the replay
      // would resurrect a `pending` line for a message already sent.
      const key = whatsappJobKey(parsed.job);
      if (expired(parsed.job, nowMs)) {
        this.jobs.delete(key);
        continue;
      }
      this.jobs.set(key, parsed.job);
    }
    this.prune(nowMs);
    if (skipped > 0) this.onWarning("whatsapp queue: skipped unreadable lines", { skipped });
  }

  /**
   * Rewrites the file with only the live jobs, via a temp file + rename so the
   * real path is never observed half-written. Bounds growth with no scheduled
   * job: a queue that is sent as fast as it fills would otherwise keep every
   * transition of every message it ever sent.
   */
  private compact(): void {
    const body = [...this.jobs.values()]
      .map((job) => JSON.stringify({ v: 1, job } satisfies PersistedLine))
      .join("\n");
    const temp = `${this.path}.compact`;
    writeFileSync(temp, body === "" ? "" : `${body}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  /**
   * Synchronous by design, exactly like the idempotency journal's: one
   * `fsync` of one short line, a handful of times a day. The alternative — an
   * async append — would let the booking answer before the job reached the
   * disk, which is the window this store exists to close.
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

  /** Drops finished jobs past retention, then bounds the map. Time-based
   * expiry happens at load only, where the clock is injected. */
  private prune(nowMs: number): void {
    for (const [key, job] of this.jobs) {
      if (expired(job, nowMs)) this.jobs.delete(key);
    }
    this.bound();
  }

  /**
   * The hard ceiling. Map iteration order is insertion order, so the first
   * keys are the oldest; evicting from the front keeps the most recent — the
   * ones still plausibly waiting to be sent.
   */
  private bound(): void {
    while (this.jobs.size > WHATSAPP_QUEUE_MAX_ENTRIES) {
      const oldest = this.jobs.keys().next();
      if (oldest.done === true) break;
      this.jobs.delete(oldest.value);
    }
  }

  enqueue(job: WhatsAppJob): boolean {
    const key = whatsappJobKey(job);
    if (this.jobs.has(key)) return false;
    this.write(key, job);
    return true;
  }

  update(job: WhatsAppJob): void {
    this.write(whatsappJobKey(job), job);
  }

  /** Disk first, then memory: a caller never sees a job this process believes
   * it recorded and did not. */
  private write(key: string, job: WhatsAppJob): void {
    this.append(`${JSON.stringify({ v: 1, job } satisfies PersistedLine)}\n`);
    this.jobs.set(key, job);
    this.bound();
  }

  due(nowMs: number): WhatsAppJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.status === "pending" && job.nextAttemptAt <= nowMs)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  get(key: string): WhatsAppJob | undefined {
    return this.jobs.get(key);
  }

  all(): WhatsAppJob[] {
    return [...this.jobs.values()];
  }
}
