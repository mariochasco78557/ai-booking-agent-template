import { mapWithConcurrency } from "../../utils/concurrency.js";
import { madridDate, madridHour } from "../../utils/madridDate.js";
import type { AgendaCache, CacheLogger } from "./agendaCache.js";

/**
 * step LAT — the background scheduler that keeps the rolling window warm.
 *
 * ## The cost this class is designed around
 *
 * Warming N days × S services costs `N × (1 + S)` upstream calls per full
 * sweep: one `/user/employees-day` per date (service-independent) plus one
 * batched `/user/free` per date and service. For the shipped default —
 * 14 days, services 0/1/2 — that is 14 × 4 = 56 calls per sweep.
 *
 * At the mission's freshness targets (≤2 min for days 0–6, ≤5 min for days
 * 7–13) an undamped scheduler would issue roughly:
 *
 *   days 0–6 :  7 × 4 = 28 calls every  90 s → 26 880 calls/day
 *   days 7–13:  7 × 4 = 28 calls every 300 s →  8 064 calls/day
 *                                        total ≈ 34 900 calls/day (~0.40 rps)
 *
 * Sustained 24/7 against one small shared Symfony host, that is not a
 * responsible default, so two dampers apply — and both are measured, not
 * guessed:
 *
 * 1. **Quiet hours.** Between `quietFromHour` and `quietToHour` Europe/Madrid
 *    the salon is shut: nobody books, nobody edits a holiday, and the agenda
 *    is essentially frozen. Intervals are multiplied by `quietFactor`
 *    (default 6). A call arriving at 03:00 is still answered correctly — a
 *    stale read refreshes itself behind the caller.
 * 2. **Backoff.** Consecutive upstream failures multiply the tick interval,
 *    so an upstream outage is met with retreat rather than a retry storm.
 *
 * With the defaults that lands at roughly **22 200 calls/day (~0.26 rps)**,
 * reported exactly by {@link estimateDailyUpstreamCalls} and echoed at boot
 * so the number is in the logs rather than in someone's head. Every input is
 * an env var: halving the window or dropping to the one service actually in
 * use cuts it proportionally.
 */

export interface AgendaRefresherOptions {
  /** How many days ahead to keep materialized, starting at today. */
  horizonDays: number;
  /** Upstream `type` values to warm, e.g. `["0", "1", "2"]`. */
  serviceIds: readonly string[];
  /** Proactive refresh interval for day offsets below `nearHorizonDays`. */
  nearIntervalMs: number;
  /** Proactive refresh interval for the rest of the window. */
  farIntervalMs: number;
  nearHorizonDays: number;
  /** How often the scheduler wakes up to look for work. */
  tickMs: number;
  /** Most keys refreshed in one tick, so a sweep is spread out, not bursty. */
  maxKeysPerTick: number;
  /** How many of those may be in flight at once (on top of the global limiter). */
  refreshConcurrency: number;
  /** Local hour (Europe/Madrid) quiet hours begin, inclusive. */
  quietFromHour: number;
  /** Local hour quiet hours end, exclusive. */
  quietToHour: number;
  /** Interval multiplier during quiet hours. */
  quietFactor: number;
  /** Ceiling on the backoff multiplier after consecutive failures. */
  maxBackoffFactor: number;
  /** Write the snapshot at most this often. */
  snapshotIntervalMs: number;
  now?: () => number;
}

interface TargetKey {
  date: string;
  serviceId: string;
  offset: number;
}

const DAY_MS = 86_400_000;

/** Calls one full sweep costs: `1` employees-day per date + `1` free per service. */
export function callsPerSweep(horizonDays: number, serviceCount: number): number {
  return horizonDays * (1 + serviceCount);
}

/**
 * Upstream calls per day the shipped configuration implies. Reported at boot
 * and on `/health` so the load this service puts on the salon's API is a
 * number anyone can read, not an assumption.
 */
export function estimateDailyUpstreamCalls(options: AgendaRefresherOptions): number {
  const services = options.serviceIds.length;
  const near = Math.min(options.nearHorizonDays, options.horizonDays);
  const far = Math.max(0, options.horizonDays - near);
  // Per date: 1 employees-day + 1 free per service.
  const callsPerDate = 1 + services;

  const quietHours = hoursInQuietWindow(options.quietFromHour, options.quietToHour);
  const activeHours = 24 - quietHours;

  const perTier = (dates: number, intervalMs: number): number => {
    const sweepsPerActiveHour = 3_600_000 / intervalMs;
    const sweepsPerQuietHour = 3_600_000 / (intervalMs * options.quietFactor);
    return dates * callsPerDate * (sweepsPerActiveHour * activeHours + sweepsPerQuietHour * quietHours);
  };

  return Math.round(perTier(near, options.nearIntervalMs) + perTier(far, options.farIntervalMs));
}

function hoursInQuietWindow(fromHour: number, toHour: number): number {
  if (fromHour === toHour) return 0;
  return fromHour < toHour ? toHour - fromHour : 24 - fromHour + toHour;
}

/**
 * *** `madridHour` AND `madridDate` NOW LIVE IN `src/utils/madridDate.ts`. ***
 *
 * They were moved unchanged — same implementation, same behaviour — because
 * the window search needs "today, as the salon means it" and importing the
 * background cache refresher to get it would be a dependency in the wrong
 * direction. They are re-exported from here so every existing importer
 * (`tests/agendaRefresher.test.ts` among them) keeps working untouched.
 */
export { madridDate, madridHour } from "../../utils/madridDate.js";

export class AgendaRefresher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private lastSnapshotMs = 0;
  private inflightCycle: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly cache: AgendaCache,
    private readonly options: AgendaRefresherOptions,
    private readonly logger: CacheLogger,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Starts the scheduler and kicks off the initial warm.
   *
   * Returns SYNCHRONOUSLY, and the warm runs detached. Boot must never wait on
   * the salon's API being reachable: a middleware that will not start because
   * an upstream is down is a middleware that cannot even answer "I am up, and
   * the agenda is unavailable" — which is precisely the answer the voice agent
   * needs in that situation.
   */
  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    this.cache.setWarmupState("warming");

    const estimate = estimateDailyUpstreamCalls(this.options);
    this.logger.info(
      {
        horizon_days: this.options.horizonDays,
        services: this.options.serviceIds.length,
        near_interval_ms: this.options.nearIntervalMs,
        far_interval_ms: this.options.farIntervalMs,
        quiet_hours: `${this.options.quietFromHour}-${this.options.quietToHour} Europe/Madrid`,
        quiet_factor: this.options.quietFactor,
        calls_per_sweep: callsPerSweep(this.options.horizonDays, this.options.serviceIds.length),
        estimated_upstream_calls_per_day: estimate,
      },
      "agenda refresher started",
    );

    void this.warmup();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs);
    // Do not hold the event loop open: a process whose only remaining work is
    // a cache refresh should be free to exit.
    this.timer.unref?.();
  }

  /**
   * Stops the scheduler cleanly: no new cycles, wait for the current one, then
   * write a final snapshot so the next boot starts warm.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inflightCycle !== undefined) {
      await this.inflightCycle.catch(() => undefined);
    }
    this.cache.saveSnapshot(true);
    this.logger.info({}, "agenda refresher stopped and snapshot written");
  }

  /**
   * First fill after boot. Nearest days first, so the days a caller is most
   * likely to ask about are warm soonest — a caller at second 3 gets a hit for
   * tomorrow even though next fortnight is still cold.
   */
  private async warmup(): Promise<void> {
    const targets = this.targets();
    let failed = 0;
    await mapWithConcurrency(targets, this.options.refreshConcurrency, async (target) => {
      if (this.stopped) return;
      try {
        await this.cache.refresh(target.date, target.serviceId, "background");
      } catch {
        failed += 1;
      }
    });
    if (this.stopped) return;
    if (failed === 0) {
      this.cache.markFullRefreshOk();
      this.cache.setWarmupState("warm");
    } else {
      // Warm enough to serve, not warm enough to claim it. `/health` shows
      // "degraded" and the operator sees which half of the window is missing.
      this.cache.setWarmupState(failed >= targets.length ? "cold" : "degraded");
    }
    this.cache.saveSnapshot(true);
    this.lastSnapshotMs = this.now();
    this.logger.info(
      { targets: targets.length, failed, entries: this.cache.size },
      "agenda warmup finished",
    );
  }

  /** One scheduler wake-up. Never overlaps itself. */
  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const cycle = this.runCycle().finally(() => {
      this.running = false;
      this.inflightCycle = undefined;
    });
    this.inflightCycle = cycle;
    await cycle.catch(() => undefined);
  }

  private async runCycle(): Promise<void> {
    const nowMs = this.now();
    const backoff = this.backoffFactor();
    const quiet = this.isQuietHour(nowMs);

    const due = this.targets()
      .map((target) => {
        const cached = this.cache.peek(target.date, target.serviceId);
        const intervalMs = this.intervalFor(target.offset, quiet) * backoff;
        return { target, ageMs: cached?.ageMs ?? Number.POSITIVE_INFINITY, intervalMs };
      })
      .filter((item) => item.ageMs >= item.intervalMs)
      // Oldest relative to its own target first: a day that is 3× overdue is
      // refreshed before one that has only just come due, whatever its offset.
      .sort((a, b) => b.ageMs / b.intervalMs - a.ageMs / a.intervalMs)
      .slice(0, this.options.maxKeysPerTick);

    if (due.length === 0) {
      this.maybeSnapshot(nowMs);
      return;
    }

    let failed = 0;
    await mapWithConcurrency(due, this.options.refreshConcurrency, async (item) => {
      if (this.stopped) return;
      try {
        await this.cache.refresh(item.target.date, item.target.serviceId, "background");
      } catch {
        failed += 1;
      }
    });

    if (failed === 0 && due.length > 0) {
      // Not "the whole window is fresh" — that is what warmup asserts. This
      // records that the most recent cycle completed with nothing failing,
      // which is what an operator watching for an upstream outage needs.
      this.cache.markFullRefreshOk();
      if (this.cache.size > 0) this.cache.setWarmupState("warm");
    } else if (failed > 0) {
      this.cache.setWarmupState("degraded");
    }
    this.maybeSnapshot(this.now());
  }

  /** The rolling window, nearest first. */
  private targets(): TargetKey[] {
    const todayMs = Date.parse(`${madridDate(this.now())}T00:00:00Z`);
    const out: TargetKey[] = [];
    for (let offset = 0; offset < this.options.horizonDays; offset += 1) {
      const date = new Date(todayMs + offset * DAY_MS).toISOString().slice(0, 10);
      for (const serviceId of this.options.serviceIds) {
        out.push({ date, serviceId, offset });
      }
    }
    return out;
  }

  private intervalFor(offset: number, quiet: boolean): number {
    const base =
      offset < this.options.nearHorizonDays
        ? this.options.nearIntervalMs
        : this.options.farIntervalMs;
    return quiet ? base * this.options.quietFactor : base;
  }

  isQuietHour(nowMs: number): boolean {
    const { quietFromHour: from, quietToHour: to } = this.options;
    if (from === to) return false;
    const hour = madridHour(nowMs);
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
  }

  /** 1, 2, 4, 8 … capped. Resets the moment a refresh succeeds. */
  private backoffFactor(): number {
    const failures = this.cache.metrics.consecutiveFailures;
    if (failures === 0) return 1;
    return Math.min(2 ** Math.min(failures, 10), this.options.maxBackoffFactor);
  }

  private maybeSnapshot(nowMs: number): void {
    if (nowMs - this.lastSnapshotMs < this.options.snapshotIntervalMs) return;
    if (this.cache.saveSnapshot()) this.lastSnapshotMs = nowMs;
  }
}
