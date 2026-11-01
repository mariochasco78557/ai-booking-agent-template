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
import type { Recado } from "./recadoTypes.js";

/**
 * The durable store of recados ((internal doc, not included in the template) §A.5). Same
 * construction as `ownerNotifyQueueStore.ts`: JSON lines, append + fsync,
 * compaction by temp file + rename, directory 0700, file 0600, last line wins.
 *
 * What is written to disk: the summary, the name and the phone of the customer
 * (Bruno needs them). Hence 0700/0600, and nothing of a recado is ever logged.
 * Unreadable lines are counted and reported WITHOUT their content.
 */

type RecadoLine =
  | { v: 1; recado: Recado }
  | { v: 1; daySummary: { date: string; at: number; count: number } };

/** Recados that are not `held`/`pending` are dropped after this long. */
export const RECADO_RETENTION_MS = 30 * 24 * 3_600_000;
/** Day-summary markers are kept this long (they only say «done»). */
const SUMMARY_RETENTION_MS = 60 * 24 * 3_600_000;
/** Ceiling on recados held in memory. */
export const RECADO_MAX_ENTRIES = 5_000;

export interface RecadoStore {
  /** false si el id ya existe; LANZA si no pudo escribir */
  insert(r: Recado): boolean;
  /** lanza si no pudo escribir */
  update(r: Recado): void;
  get(id: string): Recado | undefined;
  all(): Recado[];
  /** createdAt >= fromMs */
  countSince(fromMs: number, phoneHash?: string): number;
  summaryDone(date: string): boolean;
  markSummary(date: string, at: number, count: number): void;
}

function isUsableRecado(value: unknown): value is Recado {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<Recado>;
  return (
    typeof r.id === "string" &&
    typeof r.dedupeKey === "string" &&
    typeof r.kind === "string" &&
    typeof r.channel === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.summary === "string" &&
    typeof r.delivery === "string" &&
    typeof r.nextAttemptAt === "number" &&
    typeof r.attempts === "number" &&
    typeof r.appointment === "object" &&
    r.appointment !== null
  );
}

function isUsableSummary(value: unknown): value is { date: string; at: number; count: number } {
  if (typeof value !== "object" || value === null) return false;
  const s = value as { date?: unknown; at?: unknown; count?: unknown };
  return typeof s.date === "string" && typeof s.at === "number" && typeof s.count === "number";
}

function expired(r: Recado, nowMs: number): boolean {
  return r.delivery !== "held" && r.delivery !== "pending" && nowMs - r.createdAt >= RECADO_RETENTION_MS;
}

export class FileRecadoStore implements RecadoStore {
  private readonly recados = new Map<string, Recado>();
  private readonly summaries = new Map<string, { date: string; at: number; count: number }>();

  /**
   * @param path      File to persist to; its directory is created 0700.
   * @param nowMs     Current time, injected so tests are not clock-dependent.
   * @param onWarning Told about unreadable lines. Never handed a name or a phone.
   */
  constructor(
    private readonly path: string,
    nowMs: number,
    private readonly onWarning: (message: string, detail: Record<string, number>) => void = () => {},
    /**
     * `compact: false` is for the operator CLI, which opens the file while the
     * server is running: it must not rewrite it under the server's feet.
     */
    options: { compact?: boolean } = {},
  ) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.load(nowMs);
    if (options.compact !== false) this.compact();
    // Prove writability NOW rather than at the first recado.
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
      let parsed: { v?: unknown; recado?: unknown; daySummary?: unknown };
      try {
        parsed = JSON.parse(trimmed) as typeof parsed;
      } catch {
        skipped += 1;
        continue;
      }
      if (parsed?.v !== 1) {
        skipped += 1;
        continue;
      }
      if (isUsableRecado(parsed.recado)) {
        // Last line wins, including when the last line is the one that aged out.
        if (expired(parsed.recado, nowMs)) this.recados.delete(parsed.recado.id);
        else this.recados.set(parsed.recado.id, parsed.recado);
        continue;
      }
      if (isUsableSummary(parsed.daySummary)) {
        if (nowMs - parsed.daySummary.at < SUMMARY_RETENTION_MS) {
          this.summaries.set(parsed.daySummary.date, parsed.daySummary);
        }
        continue;
      }
      skipped += 1;
    }
    for (const [key, r] of this.recados) {
      if (expired(r, nowMs)) this.recados.delete(key);
    }
    this.bound();
    if (skipped > 0) this.onWarning("recados store: skipped unreadable lines", { skipped });
  }

  /** Rewrites the file with only the live entries (temp file + rename). */
  private compact(): void {
    const lines: RecadoLine[] = [
      ...[...this.recados.values()].map((recado): RecadoLine => ({ v: 1, recado })),
      ...[...this.summaries.values()].map((daySummary): RecadoLine => ({ v: 1, daySummary })),
    ];
    const body = lines.map((l) => JSON.stringify(l)).join("\n");
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

  private bound(): void {
    while (this.recados.size > RECADO_MAX_ENTRIES) {
      const oldest = this.recados.keys().next();
      if (oldest.done === true) break;
      this.recados.delete(oldest.value);
    }
  }

  insert(r: Recado): boolean {
    if (this.recados.has(r.id)) return false;
    this.write(r);
    return true;
  }

  update(r: Recado): void {
    this.write(r);
  }

  /** Disk first, then memory. */
  private write(r: Recado): void {
    this.append(`${JSON.stringify({ v: 1, recado: r } satisfies RecadoLine)}\n`);
    this.recados.set(r.id, r);
    this.bound();
  }

  get(id: string): Recado | undefined {
    const known = this.recados.get(id);
    if (known !== undefined) return known;
    return this.fromDisk(id);
  }

  private lastDiskLookup = 0;

  /**
   * A recado written by ANOTHER process (the operator CLI's test notice) is not
   * in memory: on a miss, look for it in the file — at most once every 5 s.
   */
  private fromDisk(id: string): Recado | undefined {
    const now = Date.now();
    if (now - this.lastDiskLookup < 5_000) return undefined;
    this.lastDiskLookup = now;
    try {
      let found: Recado | undefined;
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line.includes(id)) continue;
        const parsed = JSON.parse(line) as { v?: unknown; recado?: unknown };
        if (parsed?.v === 1 && isUsableRecado(parsed.recado) && parsed.recado.id === id) found = parsed.recado;
      }
      if (found !== undefined) this.recados.set(found.id, found);
      return found;
    } catch {
      return undefined;
    }
  }

  all(): Recado[] {
    return [...this.recados.values()];
  }

  countSince(fromMs: number, phoneHash?: string): number {
    let n = 0;
    for (const r of this.recados.values()) {
      if (r.createdAt < fromMs) continue;
      if (phoneHash !== undefined && r.phoneHash !== phoneHash) continue;
      n += 1;
    }
    return n;
  }

  summaryDone(date: string): boolean {
    return this.summaries.has(date);
  }

  markSummary(date: string, at: number, count: number): void {
    const daySummary = { date, at, count };
    this.append(`${JSON.stringify({ v: 1, daySummary } satisfies RecadoLine)}\n`);
    this.summaries.set(date, daySummary);
  }
}
