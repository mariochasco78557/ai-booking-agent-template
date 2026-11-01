/**
 * In-memory sliding-window rate limiter for /ai/wa/* (DESIGN §5, §9).
 * One replica only (see (internal doc, not included in the template)). Bounded: at most
 * {@link WA_RATE_LIMITER_MAX_KEYS} keys; stale keys are pruned.
 */
export interface WaRateLimit {
  max: number;
  windowMs: number;
}

const MIN = 60_000;
export const LOOKUP_PER_PHONE: WaRateLimit = { max: 10, windowMs: 10 * MIN };
export const CANCEL_PER_PHONE: WaRateLimit = { max: 5, windowMs: 60 * MIN };
export const NOTIFY_PER_CALLER: WaRateLimit = { max: 3, windowMs: 60 * MIN };
export const CANCEL_GLOBAL: WaRateLimit = { max: 20, windowMs: 60 * MIN };
export const LOOKUP_GLOBAL: WaRateLimit = { max: 200, windowMs: 60 * MIN };
export const WA_LOOKUP_MAX_RESULTS = 3;
export const WA_RATE_LIMITER_MAX_KEYS = 10_000;

export class WaRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: WaRateLimit) {}

  /** Records a hit and returns true if allowed; returns false (without recording) if over the limit. */
  check(key: string, now: number): boolean {
    const cutoff = now - this.limit.windowMs;
    const existing = this.hits.get(key);
    const recent = existing ? existing.filter((t) => t > cutoff) : [];
    if (recent.length >= this.limit.max) {
      this.hits.set(key, recent);
      return false;
    }
    if (!existing && this.hits.size >= WA_RATE_LIMITER_MAX_KEYS) {
      this.prune(cutoff);
      // Fail closed: still full of live keys -> refuse a new key.
      if (this.hits.size >= WA_RATE_LIMITER_MAX_KEYS) return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /**
   * Whether {@link check} would allow a hit now, WITHOUT recording one. Used by
   * the voice change (2026-10-08) to refuse BEFORE creating the new booking
   * when the cancellation that must follow it would be rate-limited.
   */
  wouldAllow(key: string, now: number): boolean {
    const cutoff = now - this.limit.windowMs;
    const existing = this.hits.get(key);
    const recent = existing ? existing.filter((t) => t > cutoff) : [];
    if (recent.length >= this.limit.max) return false;
    return existing !== undefined || this.hits.size < WA_RATE_LIMITER_MAX_KEYS;
  }

  private prune(cutoff: number): void {
    for (const [key, times] of this.hits) {
      const last = times[times.length - 1];
      if (last === undefined || last <= cutoff) this.hits.delete(key);
    }
  }
}
