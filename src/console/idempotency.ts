import { createHash } from "node:crypto";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 17 — IDEMPOTENCY FOR THE OPERATOR CONSOLE (design §6.2).
 *
 * It lives in `src/console/` and NOT under `callEngine/` on purpose: a
 * repeated HTTP request is a TRANSPORT concern, not a domain fact. The
 * domain has no idea a request was retried, and it should not.
 *
 * THE ONE DECISION THAT MATTERS MOST: **only `2xx` responses are memoised**.
 * A `409` or a `500` is never remembered, so retrying after the conflict has
 * been resolved genuinely executes again. Memoising a conflict would freeze
 * it for ever — the worst possible failure of a mechanism whose entire
 * purpose is to make a retry safe.
 *
 * NO WALL CLOCK, NO TIMER, NO EXPIRY. There is no TTL here, because a TTL
 * needs a real clock and this whole deliverable runs on an injected
 * synthetic one. Eviction is FIFO at a fixed size, which is deterministic
 * and needs no clock at all.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ENMIENDA DE FASE K (H1) — step 18. THE TWO MODES, AND WHY.
 *
 * Replaying a memoised body is only honest while the answer stays true. For
 * a command whose answer describes THE WORLD ("created: true", "las 2 citas
 * siguen en pie"), the world can change between the first request and the
 * repetition — and then the replay is a lie told with a `2xx`.
 *
 * So the mechanism has two modes, and the ROUTE picks one:
 *
 *   - `replay-body`   the historical behaviour (step 17's seven routes and
 *                     the two no-show ones): the answer is memoised and a
 *                     repetition gets it back without executing.
 *   - `collision-only` the group creation route (design §4.8): ONLY the
 *                     footprint is memoised, never the answer. A repeated key
 *                     with a DIFFERENT body is still a `409` collision that
 *                     executes nothing; a repeated key with the SAME body
 *                     RE-EXECUTES, and the truth is whatever the command says
 *                     about the world as it is now.
 *
 * The modes are a property of the RECORD and not just of the caller: in
 * `collision-only` the record has no `body` field at all, so there is nothing
 * to replay even by mistake. That is the repair of H1 made structural.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Transport format of the `Idempotency-Key` header. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_:.-]{8,200}$/;

/** Demo-scale ceiling, documented as such: 500 records, FIFO eviction. */
export const IDEMPOTENCY_LIMIT = 500;

/** What a route allows a repetition to do. See this module's docblock. */
export type IdempotencyMode = "replay-body" | "collision-only";

interface IdempotencyRecordBase {
  key: string;
  route: string;
  fingerprint: string;
  /** Kept in BOTH modes: it is what the "only `2xx` is memoised" rule reads. */
  statusCode: number;
}

/** The answer was memoised and a repetition gets it back. */
export interface ReplayableIdempotencyRecord extends IdempotencyRecordBase {
  mode: "replay-body";
  body: unknown;
}

/** ONLY the footprint was memoised. There is no `body` here, on purpose. */
export interface FootprintIdempotencyRecord extends IdempotencyRecordBase {
  mode: "collision-only";
}

export type IdempotencyRecord = ReplayableIdempotencyRecord | FootprintIdempotencyRecord;

export type IdempotencyLookup =
  | { kind: "miss" }
  | { kind: "replay"; record: ReplayableIdempotencyRecord }
  /**
   * Same key, same request, `collision-only` mode: nothing was memoised to
   * give back. The caller must EXECUTE AGAIN and answer with whatever is true
   * now. It deliberately carries no record: there is nothing to replay.
   */
  | { kind: "repeat" }
  /** Same key, different request: refuse, and execute nothing. */
  | { kind: "collision"; record: IdempotencyRecord };

export interface IdempotencyStore {
  lookup(key: string, route: string, fingerprint: string, mode: IdempotencyMode): IdempotencyLookup;
  /** Records a response. Silently ignores anything that is not `2xx` — see this module's docblock. */
  remember(record: IdempotencyRecord): void;
  clear(): void;
  size(): number;
}

/**
 * Recursively sorts object keys so that two bodies that differ only in key
 * ORDER produce the same fingerprint. Arrays keep their order: `[a, b]` and
 * `[b, a]` are genuinely different requests.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = canonicalize(v);
  return out;
}

/**
 * `sha256(route + "|" + canonical(body) + "|" + params)`. `node:crypto` is
 * the same primitive `events/emitter.ts` already uses to hash call ids, so
 * this introduces no new dependency (design criterion 18).
 */
export function fingerprintRequest(route: string, body: unknown, params: string): string {
  return createHash("sha256")
    .update(`${route}|${JSON.stringify(canonicalize(body))}|${params}`)
    .digest("hex");
}

export function createIdempotencyStore(limit: number = IDEMPOTENCY_LIMIT): IdempotencyStore {
  // A Map preserves insertion order, which is exactly what FIFO eviction
  // needs — no timestamp, no clock, no sorting.
  const records = new Map<string, IdempotencyRecord>();

  return {
    lookup(key, route, fingerprint, mode) {
      const record = records.get(key);
      if (record === undefined) return { kind: "miss" };
      if (record.route === route && record.fingerprint === fingerprint) {
        // BOTH conditions are asked for on purpose: the mode the route works
        // in AND the mode the record was written in. They cannot disagree
        // (the route decides both), and asking twice is what makes "a
        // `collision-only` route never replays a body" impossible to break
        // by editing one of the two places.
        if (mode === "collision-only" || record.mode === "collision-only") return { kind: "repeat" };
        return { kind: "replay", record };
      }
      return { kind: "collision", record };
    },
    remember(record) {
      // ONLY 2xx. See this module's docblock: freezing a conflict for ever
      // is the failure this refusal exists to prevent.
      if (record.statusCode < 200 || record.statusCode >= 300) return;
      if (!records.has(record.key) && records.size >= limit) {
        const oldest = records.keys().next();
        if (!oldest.done) records.delete(oldest.value);
      }
      records.set(record.key, record);
    },
    clear() {
      records.clear();
    },
    size() {
      return records.size;
    },
  };
}
