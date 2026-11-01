/**
 * First-touch call-session pinning.
 * See (internal doc, not included in the template) §4.2.
 *
 * What this catches, stated as honestly as the design states it: this does
 * NOT stop a malicious secret-holder, who can simply keep the value
 * constant across a session. It DOES detect the realistic failure §2 of the
 * design fears most — a header populated from a conversation variable,
 * whose value therefore *varies* as the conversation varies — and it closes
 * the same-session/two-different-callers hole (design finding B5). One
 * control, two properties.
 *
 * The first `(phoneE164, source)` pair observed for a given `callSessionId`
 * is pinned for that session's TTL. Any LATER check under the same session
 * presenting a DIFFERENT phone or a different verification source fails
 * closed — and stays failed closed for the remainder of the TTL, even if a
 * subsequent check happens to match the original pin again ("poisoned").
 *
 * WIRED AND ACTIVE. It is constructed once in src/services/container.ts and
 * shared by LookupService and CancellationService, each of which calls
 * check() once per verified identity, per request, before touching upstream.
 * BookingService deliberately does NOT take one: it only ever reads an
 * already-verified phoneE164 and performs no session-scoped decision.
 *
 * (This docblock previously said the module was "deliberately NOT wired into
 * the resolver or any route in this wave" — true when it was written during
 * wave 1, and false from wave 2 onward once lookup and cancellation began
 * calling it. Corrected after an independent verifier caught the stale
 * claim. Noted rather than silently rewritten because a comment asserting
 * something untrue about its own module is the exact defect class this
 * mission kept finding elsewhere.)
 */

export type SessionPinCheckResult = "ok" | "conflict";

export interface SessionPinStoreConfig {
  /** Upper bound on the number of tracked sessions. Oldest-first eviction beyond this. */
  maxEntries: number;
  /**
   * How long a pin (and, if triggered, a poisoned/conflict state) survives.
   * Should be set to roughly the maximum plausible call length — long
   * enough to cover a real call, short enough that this stays a bounded
   * structure and not an unbounded memory sink.
   */
  ttlMs: number;
}

export interface SessionPinStore {
  /**
   * Checks (and, on first touch, pins) a `(phoneE164, source)` pair against
   * whatever was first observed for `callSessionId`. Returns `"conflict"`
   * for a mismatch AND for any subsequent check of an already-poisoned
   * session, even one that would otherwise match the original pin.
   */
  check(
    callSessionId: string,
    phoneE164: string,
    source: string,
    nowMs: number,
  ): SessionPinCheckResult;
}

interface PinEntry {
  phoneE164: string;
  source: string;
  poisoned: boolean;
  expiresAtMs: number;
}

export function createSessionPinStore(
  config: SessionPinStoreConfig,
): SessionPinStore {
  // A `Map` is used (rather than a plain object) specifically because its
  // iteration order is guaranteed insertion order, which is exactly what a
  // simple oldest-first FIFO eviction needs — and because re-setting the
  // value of an EXISTING key (poisoning it in place) does not move it in
  // that order, so "oldest" always means "oldest first-touch", never "most
  // recently checked".
  const entries = new Map<string, PinEntry>();

  function evictExpired(nowMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= nowMs) {
        entries.delete(key);
      }
    }
  }

  function evictOldestIfFull(): void {
    if (entries.size < config.maxEntries) return;
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) {
      entries.delete(oldestKey);
    }
  }

  return {
    check(
      callSessionId: string,
      phoneE164: string,
      source: string,
      nowMs: number,
    ): SessionPinCheckResult {
      // Bound the structure on every call, not just on insert, so a store
      // that is checked often but rarely grows still reclaims memory.
      evictExpired(nowMs);

      const existing = entries.get(callSessionId);
      if (!existing) {
        evictOldestIfFull();
        entries.set(callSessionId, {
          phoneE164,
          source,
          poisoned: false,
          expiresAtMs: nowMs + config.ttlMs,
        });
        return "ok";
      }

      if (existing.poisoned) {
        return "conflict";
      }

      if (existing.phoneE164 !== phoneE164 || existing.source !== source) {
        // Poisoned for the REMAINING TTL — not extended, not reset. A
        // session that has shown two different identities can never be
        // trusted again for the rest of its natural life.
        existing.poisoned = true;
        return "conflict";
      }

      return "ok";
    },
  };
}
