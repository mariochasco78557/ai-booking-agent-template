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

import type { AgendaEvent } from "./agendaLines.js";

/**
 * The durable queue for notices to the owner (Telegram). Same construction as
 * `src/services/whatsapp/whatsappQueueStore.ts` (JSON lines, append + fsync,
 * compaction by temp file + rename, directory 0700, last line wins) and for the
 * same reasons — read that header.
 *
 * What is written to disk: the FULL message text, which contains the customer's
 * name and phone (the owner needs them; it is his business). Hence the 0700
 * directory and 0600 file, and nothing from a job's `text` is ever logged. The
 * bot token is never persisted.
 */

export type OwnerJobKind =
  | "owner_alert"
  | "cancellation_done"
  | "cancellation_request"
  | "wa_booking"
  | "agenda_cancelled"
  | "agenda_changed"
  | "agenda_service"
  | "agenda_booked"
  | "agenda_digest";

/** `digest_only`: only `agenda_booked` — counted in the morning digest, never sent alone. */
export type OwnerJobStatus = "pending" | "sent" | "sent_dry_run" | "failed" | "digest_only";

const OWNER_JOB_KINDS: readonly string[] = [
  "owner_alert",
  "cancellation_done",
  "cancellation_request",
  "wa_booking",
  "agenda_cancelled",
  "agenda_changed",
  "agenda_service",
  "agenda_booked",
  "agenda_digest",
];

/** Kinds that carry a structured `event` (everything agenda-related except the digest itself). */
const EVENT_KINDS: readonly string[] = ["agenda_cancelled", "agenda_changed", "agenda_service", "agenda_booked"];

export interface OwnerJob {
  /** Deterministic key (see `ownerNotifier.ts`); also the dedup key. */
  readonly id: string;
  readonly kind: OwnerJobKind;
  /** Final message text. Contains a full phone and a name: never log it. */
  readonly text: string;
  readonly createdAt: number;
  readonly status: OwnerJobStatus;
  readonly attempts: number;
  /** Epoch ms before which the worker leaves this job alone. */
  readonly nextAttemptAt: number;
  /** Short, non-secret reason of the last failure. Never a token. */
  readonly lastError: string | null;
  readonly providerMessageId: number | null;
  readonly sentAt: number | null;
  /**
   * Agenda notices (internal doc, not included in the template): structured data, no
   * phone, name already shortened. The text is rendered when it is SENT.
   */
  readonly event?: AgendaEvent;
}

/** How long a finished job stays in the file. */
export const OWNER_JOB_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Ceiling on jobs held in memory. */
export const OWNER_QUEUE_MAX_ENTRIES = 5_000;

export interface OwnerNotifyQueueStore {
  /** Adds a job unless its id is already present. Returns whether it was added. THROWS if it could not be written. */
  enqueue(job: OwnerJob): boolean;
  /** Records a transition. Same durability contract as {@link enqueue}. */
  update(job: OwnerJob): void;
  /** `pending` jobs whose `nextAttemptAt` has arrived, oldest deadline first. */
  due(nowMs: number): OwnerJob[];
  get(id: string): OwnerJob | undefined;
  all(): OwnerJob[];
}

interface PersistedLine {
  v: 1;
  job: OwnerJob;
}

function isUsableJob(value: unknown): value is OwnerJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Partial<OwnerJob>;
  if (typeof job.kind === "string" && EVENT_KINDS.includes(job.kind)) {
    const event = job.event as { type?: unknown } | undefined;
    if (typeof event !== "object" || event === null || typeof event.type !== "string") return false;
  }
  return (
    typeof job.id === "string" &&
    typeof job.kind === "string" &&
    OWNER_JOB_KINDS.includes(job.kind) &&
    typeof job.text === "string" &&
    typeof job.status === "string" &&
    typeof job.attempts === "number" &&
    typeof job.nextAttemptAt === "number" &&
    typeof job.createdAt === "number"
  );
}

function expired(job: OwnerJob, nowMs: number): boolean {
  return job.status !== "pending" && nowMs - job.createdAt >= OWNER_JOB_RETENTION_MS;
}

export class FileOwnerNotifyQueueStore implements OwnerNotifyQueueStore {
  private readonly jobs = new Map<string, OwnerJob>();

  /**
   * @param path      File to persist to; its directory is created 0700.
   * @param nowMs     Current time, injected so tests are not clock-dependent.
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
    // Prove writability NOW rather than at the first notice.
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
        skipped += 1;
        continue;
      }
      if (parsed?.v !== 1 || !isUsableJob(parsed.job)) {
        skipped += 1;
        continue;
      }
      // Last line wins, including when the last line is the one that aged out:
      // its earlier `pending` states must not be resurrected.
      if (expired(parsed.job, nowMs)) {
        this.jobs.delete(parsed.job.id);
        continue;
      }
      this.jobs.set(parsed.job.id, parsed.job);
    }
    this.prune(nowMs);
    if (skipped > 0) this.onWarning("owner notify queue: skipped unreadable lines", { skipped });
  }

  /** Rewrites the file with only the live jobs (temp file + rename). */
  private compact(): void {
    const body = [...this.jobs.values()]
      .map((job) => JSON.stringify({ v: 1, job } satisfies PersistedLine))
      .join("\n");
    const temp = `${this.path}.compact`;
    writeFileSync(temp, body === "" ? "" : `${body}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  private append(line: string): void {
    const fd = openSync(this.path, "a", 0o600);
    try {
      if (line !== "") writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private prune(nowMs: number): void {
    for (const [key, job] of this.jobs) {
      if (expired(job, nowMs)) this.jobs.delete(key);
    }
    this.bound();
  }

  private bound(): void {
    while (this.jobs.size > OWNER_QUEUE_MAX_ENTRIES) {
      const oldest = this.jobs.keys().next();
      if (oldest.done === true) break;
      this.jobs.delete(oldest.value);
    }
  }

  enqueue(job: OwnerJob): boolean {
    if (this.jobs.has(job.id)) return false;
    this.write(job);
    return true;
  }

  update(job: OwnerJob): void {
    this.write(job);
  }

  /** Disk first, then memory. */
  private write(job: OwnerJob): void {
    this.append(`${JSON.stringify({ v: 1, job } satisfies PersistedLine)}\n`);
    this.jobs.set(job.id, job);
    this.bound();
  }

  due(nowMs: number): OwnerJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.status === "pending" && job.nextAttemptAt <= nowMs)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  get(id: string): OwnerJob | undefined {
    return this.jobs.get(id);
  }

  all(): OwnerJob[] {
    return [...this.jobs.values()];
  }
}
