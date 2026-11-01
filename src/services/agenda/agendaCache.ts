import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  createRequestMetrics,
  currentRequestMetrics,
  runWithRequestMetrics,
} from "../../observability/requestMetrics.js";
import { SingleFlight } from "../../utils/concurrency.js";
import type { TaskPriority } from "../../utils/concurrency.js";
import { AgendaSource, isEmptyDay, type AgendaDay } from "./agendaSource.js";

/**
 * step LAT — the agenda cache.
 *
 * ## Why in-memory with an atomic snapshot, and not Redis or SQLite
 *
 * The whole working set is one salon's next 14 days for 3 services: 42
 * entries, each a roster of ~3 barbers and their free slots. Measured at
 * ~1.5 KB per entry, the entire cache is well under 100 KB resident, and the
 * snapshot on disk is smaller still. Against that:
 *
 * - **Redis** would add a second container, a network hop on every lookup, its
 *   own memory ceiling and eviction policy to reason about, and a new piece of
 *   infrastructure to patch — to hold 42 keys for ONE process. Redis earns its
 *   keep when several processes must share state or when the set outgrows the
 *   heap. Neither is true here: this deployment is a single container
 *   (`compose.yaml`), and a second one would need its own decision about
 *   upstream load first. If that day comes, the `AgendaCacheStore` seam below
 *   is where Redis goes, and the decision is recorded in (internal doc, not included in the template)
 *   ADR-009.
 * - **SQLite** would add a native dependency and file locking to durably store
 *   data that is 100% derived, disposable, and stale within two minutes. We
 *   are not storing records; we are remembering a recent answer.
 *
 * So: a `Map` for the live cache, and a single JSON file written atomically
 * (temp + `rename`) purely so a container restart does not begin with 42 cold
 * misses. Losing that file costs one warmup, never correctness.
 *
 * ## What the cache is, and is not, allowed to decide
 *
 * It may offer OPTIONS to a caller. It may never authorize a WRITE. The
 * booking path calls {@link readFresh}, which goes straight to upstream, and
 * (internal doc, not included in the template) ADR-010 records why that is not negotiable.
 */

/**
 * Bumped whenever {@link AgendaDay}'s meaning changes in a way that would make
 * an older snapshot wrong rather than merely stale. A snapshot whose contract
 * differs is discarded on load, never migrated: a cold start is cheap, a
 * silently misread agenda is not.
 */
export const AGENDA_CONTRACT_VERSION = 1;

/** Which barbers a lookup is asking about. Part of the logical cache key. */
export type EmployeeScope = { kind: "any" } | { kind: "one"; employeeId: number };

export type CacheOutcome =
  /** Served from cache, within its freshness target. */
  | "hit"
  /** Served from cache past its freshness target; a refresh was kicked off. */
  | "stale"
  /** Nothing usable cached; the caller waited for upstream. */
  | "miss"
  /** Cache deliberately skipped (pre-write revalidation). */
  | "bypass";

export interface AgendaRead {
  readonly day: AgendaDay;
  readonly outcome: CacheOutcome;
  /** How old the served data is, in ms. `0` for a miss or a bypass. */
  readonly ageMs: number;
}

export interface AgendaCacheMetrics {
  hits: number;
  misses: number;
  stale: number;
  bypasses: number;
  /** Background refreshes that completed successfully. */
  refreshOk: number;
  /** Background refreshes that threw. */
  refreshFailed: number;
  /** Sum of every background refresh's wall time, for a mean. */
  refreshDurationMsTotal: number;
  /** Slowest single refresh observed. */
  refreshDurationMsMax: number;
  /** Sum of `read()` lookup times (cache logic only, upstream excluded). */
  lookupMsTotal: number;
  lookupCount: number;
  /** Upstream calls this cache has caused, refresher included. */
  upstreamCalls: number;
  /** Wall time spent inside upstream calls this cache caused. */
  upstreamMs: number;
  /** Entries dropped because a booking invalidated them. */
  invalidations: number;
  /** Entries dropped because the cache was over its entry ceiling. */
  evictions: number;
  /** Epoch ms of the last refresh cycle in which every key succeeded. */
  lastFullRefreshOkMs: number | null;
  /** Consecutive failed refresh attempts; drives the refresher's backoff. */
  consecutiveFailures: number;
}

export interface AgendaCacheOptions {
  /** Freshness target for day offsets 0..`nearHorizonDays`-1, in ms. */
  nearTtlMs: number;
  /** Freshness target for the remaining warmed days, in ms. */
  farTtlMs: number;
  /** Day offset at which `farTtlMs` takes over. */
  nearHorizonDays: number;
  /**
   * TTL for a day upstream reported as having no slots at all.
   *
   * Deliberately SHORTER than the positive TTL, not longer. A fully booked day
   * is exactly the day a cancellation is most likely to change, and re-asking
   * about it is cheap (an empty day costs one upstream call, not two, because
   * an empty roster skips `/user/free` entirely).
   */
  negativeTtlMs: number;
  /**
   * Fraction of the TTL added or subtracted at random per entry (0.2 = ±20%).
   * Without it, 42 entries warmed together expire together, and every
   * subsequent cycle re-synchronises them into one thundering refresh.
   */
  jitterRatio: number;
  /**
   * How far past its TTL an entry may still be SERVED (while a refresh runs
   * behind it). Past this ceiling the caller waits for fresh data instead.
   * This is the honest bound on "how wrong can an offered slot be" when
   * upstream is down.
   */
  staleCeilingMs: number;
  /** Hard ceiling on live entries. 14 days × 3 services = 42; this is slack. */
  maxEntries: number;
  /** Snapshot file, or undefined to run without any persistence. */
  snapshotPath?: string;
  /** Refuse to load or write a snapshot larger than this. */
  maxSnapshotBytes: number;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests; `Math.random` in production. */
  random?: () => number;
}

interface CacheEntry {
  readonly day: AgendaDay;
  /** Epoch ms after which the entry is stale. Jitter is baked in here. */
  readonly expiresAtMs: number;
}

interface SnapshotFile {
  version: number;
  contract: number;
  savedAtMs: number;
  entries: Array<{ key: string; day: AgendaDay }>;
}

/**
 * The upstream HTTP status, when the failure had one.
 *
 * Read structurally rather than through `instanceof UpstreamError`, so this
 * module keeps depending on nothing below itself — and so a status still
 * surfaces if some other error type grows one. Absent (not null) when no
 * response ever arrived: a connection that was refused has no status, and a
 * field that is always present and sometimes empty invites a dashboard to
 * count the empties as a value.
 */
function upstreamStatusOf(error: unknown): { upstream_status?: number } {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? { upstream_status: status } : {};
}

/**
 * The error's class name, clamped. `Error.name` is set by the code that threw,
 * never by upstream data, but the clamp keeps one line one line even if that
 * ever stops being true.
 */
function errorTypeOf(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return error.name.replace(/[^\w.-]/g, "").slice(0, 40) || "unknown";
}

export interface CacheLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

const DAY_MS = 86_400_000;

/**
 * The logical cache key.
 *
 * The STORAGE unit is a whole (date, service) day — every barber at once —
 * while the LOOKUP key additionally names the employee scope. That asymmetry
 * is deliberate: storing one entry per employee subset would multiply entries
 * by the size of the power set of the roster, and worse, would let a query for
 * "any barber" and a query for "Bruno" be served from snapshots taken at
 * different moments, which is how a caller ends up offered a slot that the
 * other view already knows is gone. One day, one snapshot, all views
 * projected from it — so every answer about a given day is internally
 * consistent by construction.
 */
export function agendaKey(date: string, serviceId: string, scope: EmployeeScope): string {
  const who = scope.kind === "any" ? "any" : `emp${scope.employeeId}`;
  return `v${AGENDA_CONTRACT_VERSION}|${date}|s${serviceId}|${who}`;
}

/** The storage key a lookup key projects from. */
function storageKey(date: string, serviceId: string): string {
  return `v${AGENDA_CONTRACT_VERSION}|${date}|s${serviceId}`;
}

export class AgendaCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new SingleFlight<AgendaDay>();
  private readonly now: () => number;
  private readonly random: () => number;
  private snapshotDirty = false;
  private warmupState: "cold" | "warming" | "warm" | "degraded" = "cold";

  readonly metrics: AgendaCacheMetrics = {
    hits: 0,
    misses: 0,
    stale: 0,
    bypasses: 0,
    refreshOk: 0,
    refreshFailed: 0,
    refreshDurationMsTotal: 0,
    refreshDurationMsMax: 0,
    lookupMsTotal: 0,
    lookupCount: 0,
    upstreamCalls: 0,
    upstreamMs: 0,
    invalidations: 0,
    evictions: 0,
    lastFullRefreshOkMs: null,
    consecutiveFailures: 0,
  };

  constructor(
    private readonly source: AgendaSource,
    private readonly options: AgendaCacheOptions,
    private readonly logger: CacheLogger,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  /**
   * The read every caller-facing availability question goes through.
   *
   * Hit  → returned immediately, zero upstream calls.
   * Stale→ returned immediately, refresh kicked off behind the caller. The
   *        caller never waits on upstream for a day we already know something
   *        about, which is what keeps a bad upstream minute from becoming a
   *        four-second silence on a live phone call.
   * Miss → the caller waits, sharing one in-flight fetch with every other
   *        caller asking about the same day (single-flight).
   */
  async read(
    date: string,
    serviceId: string,
    scope: EmployeeScope,
    priority: TaskPriority = "interactive",
  ): Promise<AgendaRead> {
    const startedAt = process.hrtime.bigint();
    const key = storageKey(date, serviceId);
    const entry = this.entries.get(key);
    const nowMs = this.now();

    if (entry !== undefined) {
      const ageMs = nowMs - entry.day.fetchedAtMs;
      if (nowMs < entry.expiresAtMs) {
        this.metrics.hits += 1;
        this.recordLookup(startedAt);
        return { day: entry.day, outcome: "hit", ageMs };
      }
      if (ageMs <= this.options.staleCeilingMs) {
        this.metrics.stale += 1;
        this.recordLookup(startedAt);
        // Detached on purpose: the caller must not inherit this promise's
        // latency OR its rejection. Failures are counted in refresh().
        void this.refresh(date, serviceId, "background").catch(() => undefined);
        return { day: entry.day, outcome: "stale", ageMs };
      }
      // Past the ceiling. Too old to speak aloud; fall through and wait.
    }

    this.metrics.misses += 1;
    this.recordLookup(startedAt);
    const day = await this.refresh(date, serviceId, priority);
    return { day, outcome: "miss", ageMs: 0 };
  }

  /**
   * Reads a day from upstream with the cache COMPLETELY out of the path, and
   * stores the result.
   *
   * This is the pre-write revalidation. It exists as its own method, rather
   * than a `bypass: true` option on {@link read}, so that "this call cannot be
   * served from cache" is visible at the call site and cannot be lost in a
   * default argument. See (internal doc, not included in the template) ADR-010.
   */
  async readFresh(date: string, serviceId: string): Promise<AgendaRead> {
    this.metrics.bypasses += 1;
    // Not single-flighted with background refreshes: a booking revalidation
    // must never be answered by a fetch that started before the caller asked.
    const day = await this.fetchAndStore(date, serviceId, "interactive");
    return { day, outcome: "bypass", ageMs: 0 };
  }

  /** Cached day without touching upstream, or undefined. Used by /health. */
  peek(date: string, serviceId: string): { day: AgendaDay; ageMs: number } | undefined {
    const entry = this.entries.get(storageKey(date, serviceId));
    if (entry === undefined) return undefined;
    return { day: entry.day, ageMs: this.now() - entry.day.fetchedAtMs };
  }

  // -------------------------------------------------------------------
  // Writes into the cache
  // -------------------------------------------------------------------

  /**
   * Fetches one day and stores it, collapsing concurrent callers for the same
   * key onto a single upstream fan-out.
   */
  async refresh(date: string, serviceId: string, priority: TaskPriority): Promise<AgendaDay> {
    return this.inflight.run(storageKey(date, serviceId), async () => {
      const startedAt = process.hrtime.bigint();
      // PRODUCTION FORENSICS 2026-09-11 (F3) — a private set of upstream
      // counters for THIS refresh.
      //
      // Whether the call timed out or merely failed is known in exactly one
      // place: the axios interceptor in `LegacyRestClient`, which reports it to
      // whatever `RequestMetrics` store is current. A background refresh has no
      // request and therefore no store, so the fact was discarded — and that is
      // precisely the refresh whose warning an operator has to read: every one
      // of the warnings observed on 2026-09-11 fired from a refresher CYCLE
      // (several keys within the same millisecond, no request in flight), not
      // from a call's own cache miss.
      //
      // Establishing a store here captures it without touching the client. The
      // parent store, when there is one, is credited in the `finally` below, so
      // an INTERACTIVE miss still attributes its upstream time and its timeouts
      // to the request that waited — which is what `upstream_ms` on the access
      // line and the `upstream_timeout` classification in the voice routes both
      // read. Credited after the fact rather than during, which is soon enough:
      // nothing reads those counters until the handler returns.
      const parent = currentRequestMetrics();
      const local = createRequestMetrics("agenda-refresh");
      try {
        const day = await runWithRequestMetrics(local, () =>
          this.fetchAndStore(date, serviceId, priority),
        );
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        this.metrics.refreshOk += 1;
        this.metrics.refreshDurationMsTotal += durationMs;
        this.metrics.refreshDurationMsMax = Math.max(
          this.metrics.refreshDurationMsMax,
          durationMs,
        );
        this.metrics.consecutiveFailures = 0;
        return day;
      } catch (error) {
        this.metrics.refreshFailed += 1;
        this.metrics.consecutiveFailures += 1;
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        // Date, service, and the SHAPE of the failure — never a slot, a name, a
        // caller, or anything upstream said. `upstreamMessage` in particular is
        // deliberately not read: it is a string from another system, it has
        // carried customer data before, and it would make this line unbounded.
        this.logger.warn(
          {
            date,
            service_id: serviceId,
            consecutive_failures: this.metrics.consecutiveFailures,
            ...upstreamStatusOf(error),
            timed_out: local.upstreamTimeouts > 0,
            duration_ms: Math.round(durationMs * 10) / 10,
            error_type: errorTypeOf(error),
          },
          "agenda refresh failed",
        );
        throw error;
      } finally {
        if (parent !== undefined) {
          parent.upstreamMs += local.upstreamMs;
          parent.upstreamCalls += local.upstreamCalls;
          parent.upstreamTimeouts += local.upstreamTimeouts;
        }
      }
    });
  }

  private async fetchAndStore(
    date: string,
    serviceId: string,
    priority: TaskPriority,
  ): Promise<AgendaDay> {
    const startedAt = process.hrtime.bigint();
    const day = await this.source.fetchDay(date, serviceId, priority);
    this.metrics.upstreamMs += Number(process.hrtime.bigint() - startedAt) / 1e6;
    this.metrics.upstreamCalls += day.upstreamCalls;
    this.store(day);
    return day;
  }

  private store(day: AgendaDay): void {
    const key = storageKey(day.date, day.serviceId);
    this.entries.set(key, { day, expiresAtMs: day.fetchedAtMs + this.ttlFor(day) });
    this.snapshotDirty = true;
    this.enforceEntryCeiling();
  }

  /**
   * Drops cached days so the next read re-reads upstream.
   *
   * Called immediately after a booking succeeds OR fails with a conflict —
   * both change what upstream will say next, and a stale "that hour is free"
   * survives exactly as long as we let it.
   */
  invalidate(date: string, serviceId?: string): number {
    let dropped = 0;
    for (const key of [...this.entries.keys()]) {
      const parts = key.split("|");
      if (parts[1] !== date) continue;
      if (serviceId !== undefined && parts[2] !== `s${serviceId}`) continue;
      this.entries.delete(key);
      dropped += 1;
    }
    this.metrics.invalidations += dropped;
    if (dropped > 0) this.snapshotDirty = true;
    return dropped;
  }

  // -------------------------------------------------------------------
  // Freshness policy
  // -------------------------------------------------------------------

  /**
   * TTL for a freshly fetched day: tier by how far ahead it is, shorten it if
   * the day came back empty, then jitter it.
   */
  private ttlFor(day: AgendaDay): number {
    const base = isEmptyDay(day)
      ? this.options.negativeTtlMs
      : this.dayOffset(day.date) < this.options.nearHorizonDays
        ? this.options.nearTtlMs
        : this.options.farTtlMs;
    const jitter = 1 + (this.random() * 2 - 1) * this.options.jitterRatio;
    return Math.max(1_000, Math.round(base * jitter));
  }

  /** Whole days between today and `date`; negative for the past. */
  private dayOffset(date: string): number {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  }

  /**
   * Bounds memory by evicting the entries furthest in the future first.
   *
   * Not LRU: near days are both the most asked about and the most volatile,
   * so under pressure the right thing to lose is next fortnight, not tomorrow.
   */
  private enforceEntryCeiling(): void {
    while (this.entries.size > this.options.maxEntries) {
      let victim: string | undefined;
      let worstOffset = -Infinity;
      for (const [key, entry] of this.entries) {
        const offset = this.dayOffset(entry.day.date);
        if (offset > worstOffset) {
          worstOffset = offset;
          victim = key;
        }
      }
      if (victim === undefined) return;
      this.entries.delete(victim);
      this.metrics.evictions += 1;
    }
  }

  private recordLookup(startedAt: bigint): void {
    this.metrics.lookupMsTotal += Number(process.hrtime.bigint() - startedAt) / 1e6;
    this.metrics.lookupCount += 1;
  }

  // -------------------------------------------------------------------
  // Warmup state + observability
  // -------------------------------------------------------------------

  setWarmupState(state: "cold" | "warming" | "warm" | "degraded"): void {
    this.warmupState = state;
  }

  markFullRefreshOk(): void {
    this.metrics.lastFullRefreshOkMs = this.now();
  }

  /**
   * A health projection. Counts, ages and timings only — deliberately NOT a
   * single date, barber id or slot. `/health` is unauthenticated, and "which
   * hours are free at Demo Salon tomorrow" is the salon's business information,
   * not a liveness signal.
   */
  health(): Record<string, unknown> {
    const nowMs = this.now();
    let oldestAgeMs = 0;
    let newestAgeMs = Number.POSITIVE_INFINITY;
    let staleEntries = 0;
    for (const entry of this.entries.values()) {
      const ageMs = nowMs - entry.day.fetchedAtMs;
      oldestAgeMs = Math.max(oldestAgeMs, ageMs);
      newestAgeMs = Math.min(newestAgeMs, ageMs);
      if (nowMs >= entry.expiresAtMs) staleEntries += 1;
    }
    const served = this.metrics.hits + this.metrics.stale + this.metrics.misses;
    return {
      warmup: this.warmupState,
      entries: this.entries.size,
      max_entries: this.options.maxEntries,
      approx_bytes: this.approximateBytes(),
      stale_entries: staleEntries,
      oldest_entry_age_ms: this.entries.size === 0 ? null : Math.round(oldestAgeMs),
      newest_entry_age_ms: this.entries.size === 0 ? null : Math.round(newestAgeMs),
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      stale: this.metrics.stale,
      bypasses: this.metrics.bypasses,
      hit_ratio: served === 0 ? null : Number((this.metrics.hits / served).toFixed(3)),
      cache_lookup_ms_avg:
        this.metrics.lookupCount === 0
          ? null
          : Number((this.metrics.lookupMsTotal / this.metrics.lookupCount).toFixed(3)),
      refresh_ok: this.metrics.refreshOk,
      refresh_failed: this.metrics.refreshFailed,
      refresh_duration_ms_avg:
        this.metrics.refreshOk === 0
          ? null
          : Math.round(this.metrics.refreshDurationMsTotal / this.metrics.refreshOk),
      refresh_duration_ms_max: Math.round(this.metrics.refreshDurationMsMax),
      upstream_calls: this.metrics.upstreamCalls,
      upstream_ms: Math.round(this.metrics.upstreamMs),
      invalidations: this.metrics.invalidations,
      evictions: this.metrics.evictions,
      inflight: this.inflight.size,
      consecutive_failures: this.metrics.consecutiveFailures,
      last_full_refresh_ok_ms: this.metrics.lastFullRefreshOkMs,
      last_full_refresh_age_ms:
        this.metrics.lastFullRefreshOkMs === null
          ? null
          : nowMs - this.metrics.lastFullRefreshOkMs,
    };
  }

  /** Cheap resident-size estimate: the serialized snapshot's own length. */
  private approximateBytes(): number {
    let bytes = 0;
    for (const [key, entry] of this.entries) {
      bytes += key.length * 2;
      // ~90 bytes per slot and ~60 per employee, measured against real
      // payloads. An estimate, not a promise — good enough to alert on.
      bytes += entry.day.employees.length * 60;
      for (const record of entry.day.free) bytes += 60 + record.slots.length * 90;
    }
    return bytes;
  }

  // -------------------------------------------------------------------
  // Persistence — a warm start, never a source of truth
  // -------------------------------------------------------------------

  /**
   * Loads the snapshot written by a previous process.
   *
   * Every loaded entry is given an expiry of NOW, not its original one: it is
   * immediately stale, so it is revalidated before it is trusted, but it is
   * still there to be served while that happens. That is the whole value —
   * the first caller after a restart gets an answer in milliseconds instead of
   * seconds, and gets the fresh one from the refresh that their own request
   * triggered.
   *
   * Any problem at all (missing, unreadable, wrong contract, oversized,
   * malformed) is a debug line and a cold start. A cache that refuses to boot
   * is worse than no cache.
   */
  loadSnapshot(): number {
    const path = this.options.snapshotPath;
    if (path === undefined) return 0;
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.length > this.options.maxSnapshotBytes) {
        this.logger.warn({ bytes: raw.length }, "agenda snapshot too large; ignoring");
        return 0;
      }
      const parsed = JSON.parse(raw) as SnapshotFile;
      if (parsed.contract !== AGENDA_CONTRACT_VERSION) {
        this.logger.info(
          { found: parsed.contract, expected: AGENDA_CONTRACT_VERSION },
          "agenda snapshot contract mismatch; starting cold",
        );
        return 0;
      }
      const nowMs = this.now();
      let loaded = 0;
      for (const item of parsed.entries ?? []) {
        if (typeof item?.key !== "string" || item.day == null) continue;
        if (!Array.isArray(item.day.employees) || !Array.isArray(item.day.free)) continue;
        this.entries.set(item.key, { day: item.day, expiresAtMs: nowMs });
        loaded += 1;
        if (this.entries.size >= this.options.maxEntries) break;
      }
      this.logger.info({ entries: loaded }, "agenda snapshot loaded (all entries start stale)");
      return loaded;
    } catch (error) {
      this.logger.debug(
        { reason: error instanceof Error ? error.name : "unknown" },
        "no usable agenda snapshot; starting cold",
      );
      return 0;
    }
  }

  /**
   * Writes the snapshot atomically: a temp file in the same directory, then a
   * `rename`. A partially written JSON file is never observable, so a crash
   * mid-write costs the snapshot, never a corrupt one that the next boot would
   * happily half-parse.
   */
  saveSnapshot(force = false): boolean {
    const path = this.options.snapshotPath;
    if (path === undefined) return false;
    if (!this.snapshotDirty && !force) return false;

    const payload: SnapshotFile = {
      version: 1,
      contract: AGENDA_CONTRACT_VERSION,
      savedAtMs: this.now(),
      entries: [...this.entries].map(([key, entry]) => ({ key, day: entry.day })),
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > this.options.maxSnapshotBytes) {
      this.logger.warn(
        { bytes: serialized.length, max: this.options.maxSnapshotBytes },
        "agenda snapshot over size ceiling; not written",
      );
      return false;
    }

    const temp = `${path}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temp, serialized, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
      this.snapshotDirty = false;
      return true;
    } catch (error) {
      this.logger.warn(
        { reason: error instanceof Error ? error.name : "unknown" },
        "could not write agenda snapshot (cache still fully functional)",
      );
      try {
        unlinkSync(temp);
      } catch {
        // The temp file may not exist; nothing to clean up.
      }
      return false;
    }
  }

  /** Test seam. */
  clear(): void {
    this.entries.clear();
    this.snapshotDirty = true;
  }

  get size(): number {
    return this.entries.size;
  }
}
