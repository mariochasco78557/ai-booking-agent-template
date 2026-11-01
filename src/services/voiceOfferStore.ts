import { createHmac, randomBytes } from "node:crypto";

/**
 * *** VOICE OFFER STORE — the hueco this conversation is holding, right now. ***
 *
 * `src/services/slotAuthorization.ts` answers one question: *did this
 * middleware ever mint this token, for this conversation, and is it still
 * inside its lifetime*. That is a question about CRYPTOGRAPHY, and it is
 * answered by opening a sealed payload — with no state of any kind behind it.
 *
 * Which means a token stays acceptable for its whole TTL even after the
 * conversation has moved on. Concretely, all of these pass the crypto gate:
 *
 * - The agent offers 10:00, the caller says no, the agent re-checks and offers
 *   17:00 — and then books 10:00, because 10:00 is still in its context window
 *   and its token has not expired yet.
 * - The agent asks for availability, gets `available: false`, and books the
 *   token it was handed four minutes earlier.
 * - Availability throws, the tool call fails, and the agent falls back to the
 *   last token it saw.
 *
 * None of those are forgeries. Every one of them is a token this middleware
 * genuinely issued to this exact call, and every one of them books an hour the
 * caller was not, at that moment, being offered.
 *
 * This store closes that by remembering, per conversation, WHICH tokens the
 * most recent availability answer actually published. `/ai/voice/book` then
 * requires both: a token that verifies, AND a token that is the one currently
 * on the table.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────
 *
 * It is not a reservation, not a hold, and not a source of truth about the
 * agenda. The salon's diary remains the only authority on whether an hour is
 * free, and the cache-bypassing re-check immediately before `POST /reservation`
 * ((internal doc, not included in the template) ADR-010) is untouched and still decides. A record here
 * says only "this hueco is the one this call was last offered"; it never says
 * "this hueco is free".
 *
 * It is also not the one-booking-per-call rule. That lives in the durable
 * idempotency journal (`src/services/bookingIdempotencyStore.ts`,
 * (internal doc, not included in the template) ADR-014/ADR-015) and stays there — see
 * {@link MemoryVoiceOfferStore.markTerminal} for why duplicating it here would
 * make the system LESS informative rather than safer.
 *
 * ── Isolation is by exact key, never by recency ───────────────────────────
 *
 * Every lookup is an exact-match `Map.get(conversationId)`. There is
 * deliberately no "most recent conversation", no prefix match, no fallback to
 * another id, and no shared bucket. A new ElevenLabs call gets a new
 * `system__conversation_id` even if it dials back one minute later, so the
 * ONLY correct behaviour for that second call is to start from nothing — and
 * starting from nothing means it cannot book until it has asked for
 * availability itself.
 *
 * Expiry is NOT the isolation mechanism. It is a memory bound. Two live
 * conversations are isolated because their keys differ, not because one of
 * them will eventually time out.
 *
 * ── Single process, on purpose, and only for now ──────────────────────────
 *
 * The implementation below is in-memory and correct for the current
 * deployment: ONE container (`deploy/vps/`), one process. It is deliberately
 * behind an interface so that a future multi-replica deployment can replace it
 * — and it MUST be replaced before a second replica exists. Two replicas each
 * holding half the offers would mean a booking routed to the wrong one is
 * refused with `slot_not_authorized` even though the agent did everything
 * right. The migration target is shared storage keyed the same way (Redis, or
 * the same durable-file approach the idempotency journal already uses); see
 * (internal doc, not included in the template).
 *
 * A restart empties it, and that is the correct failure: a pending offer whose
 * memory is gone must FAIL CLOSED with `slot_not_authorized`, never be
 * reconstructed from the token itself. Reconstructing it would be exactly the
 * hole this module exists to close — the token is not evidence of what was
 * last offered, it is evidence of what was once offered.
 */

/**
 * Where a conversation is in the offer cycle.
 *
 * - `refreshing` — an availability question is IN FLIGHT. The previous offer
 *   is already gone and the new one does not exist yet, so booking is refused.
 *   This window is short but it is real: ElevenLabs fires tool calls roughly
 *   two seconds apart and the agenda answers in about one.
 * - `offered`    — the last availability answer published at least one token.
 *   These, and only these, may be booked.
 * - `empty`      — the last availability answer had nothing to offer (no
 *   slots, or no token could be minted, or the question failed). Nothing is
 *   bookable, and the PREVIOUS offer is still gone. Exception: a balanced V2
 *   `lock` that does not produce a token uses `publishEmptyPreservingPrior`
 *   and puts the prior live `offered` state back instead (ADR-022). V2
 *   browsing questions do not touch this store at all.
 * - `terminal`   — a booking was confirmed in this conversation.
 */
export type VoiceOfferState = "refreshing" | "offered" | "empty" | "terminal";

/** Why {@link VoiceOfferStore.authorizes} said no. Diagnostic only — every
 * value produces the same caller-facing refusal. */
export type VoiceOfferRefusal =
  /** No record at all: a conversation that never asked, or a restart. */
  | "no_record"
  /** The record expired through inactivity before this booking arrived. */
  | "expired"
  /** An availability question is in flight; the offer does not exist yet. */
  | "refreshing"
  /** The last availability answer had nothing to offer. */
  | "empty"
  /** Authentic token, but not one of the CURRENT generation's. */
  | "stale_token"
  /**
   * V5 (ADR-023): the token already produced a CONFIRMED booking in this call,
   * on a deployment that allows more than one. It can never authorize another
   * write; its identical retry is answered by the journal before this store is
   * consulted. Never produced when only one booking per call is allowed.
   */
  | "consumed";

/** Result of {@link VoiceOfferStore.publishEmptyPreservingPrior}. */
export type VoicePreserveOutcome = "preserved" | "empty" | "superseded";

export type VoiceOfferDecision =
  | { ok: true; generation: number }
  | { ok: false; refusal: VoiceOfferRefusal };

/** One conversation's offer memory, as an inspectable snapshot. */
export interface VoiceOfferRecord {
  conversationId: string;
  /**
   * Which availability question this record belongs to. Monotonic per
   * conversation, and the whole compare-and-set mechanism: a slow answer
   * carries the generation it STARTED with, so it can recognise that a newer
   * question has already replaced it and decline to publish.
   */
  generation: number;
  /**
   * Keyed digests of the tokens published by {@link generation}. Never the
   * tokens themselves — a token is a bearer credential for somebody's
   * appointment, and this map would otherwise be a pile of them.
   */
  tokenDigests: readonly string[];
  state: VoiceOfferState;
  createdAtMs: number;
  lastActivityAtMs: number;
  expiresAtMs: number;
}

export interface VoiceOfferStore {
  /**
   * Opens a new generation for `conversationId` and INVALIDATES the previous
   * offer immediately — before the agenda is read, not after it answers.
   *
   * Returns the new generation number, which the caller must hand back to
   * `publishOffered`/`publishEmpty`.
   */
  beginRefresh(conversationId: string, nowMs: number): number;
  /**
   * Publishes the tokens of `generation`, if it is still the current one.
   * Returns false when a newer question has already superseded it.
   */
  publishOffered(
    conversationId: string,
    generation: number,
    tokens: readonly string[],
    nowMs: number,
  ): boolean;
  /** Same compare-and-set, for a question that produced nothing bookable. */
  publishEmpty(conversationId: string, generation: number, nowMs: number): boolean;
  /**
   * Closes `generation` for a balanced V2 `lock` that ended WITHOUT a token
   * (refused, or threw). Used to serve V2 browsing questions that offered
   * nothing (incident 2026-09-14); since ADR-022 those no longer touch the
   * store, and only a failed lock needs to put the previous lock back.
   *
   * Same compare-and-set as {@link publishEmpty}. The difference: if
   * `beginRefresh` found the conversation holding a live `offered` state, that
   * offer is PUT BACK instead of being replaced by `empty` — the caller was
   * given nothing new, so the hueco they locked is still the one on the
   * table. See (internal doc, not included in the template) ADR-022.
   *
   * - `"preserved"`  — the prior offer is bookable again.
   * - `"empty"`      — there was nothing to restore; published `empty`.
   * - `"superseded"` — a newer generation (e.g. a lock) replaced this one, or
   *   the record expired; nothing was touched.
   */
  publishEmptyPreservingPrior(
    conversationId: string,
    generation: number,
    nowMs: number,
  ): VoicePreserveOutcome;
  /** Exact-match, no fallback: is this token the hueco this call is holding? */
  authorizes(conversationId: string, token: string, nowMs: number): VoiceOfferDecision;
  /**
   * Records that this conversation produced a confirmed booking, and pins the
   * token that authorized it so the idempotent replay of that same booking
   * still passes this gate.
   */
  markTerminal(conversationId: string, token: string, nowMs: number): void;
  /**
   * V5 (ADR-023) — records a confirmed booking in a call that may still make
   * ANOTHER one. The authorizing token leaves the table for good (refused as
   * `consumed` from now on, whatever state follows), and the conversation is
   * NOT marked terminal, so the next `lock` supersedes normally (ADR-022)
   * instead of accumulating tokens the way a terminal record does.
   *
   * Only called by a booking service configured for more than one booking per
   * call, and never for the last booking allowed — that one is
   * {@link markTerminal}, exactly as before.
   */
  markConsumed(conversationId: string, token: string, nowMs: number): void;
  /** A snapshot for tests, diagnostics and nothing else. */
  peek(conversationId: string, nowMs: number): VoiceOfferRecord | undefined;
  /** How many conversations are currently remembered. */
  readonly size: number;
}

/** The bounds this store enforces ON ITSELF — same reasoning as
 * `SlotAuthorizationService`: the class is exported, so a future call site
 * that never passes through the env schema must still get a sane store or
 * none at all. */
export const VOICE_OFFER_TTL_MIN_SECONDS = 60;
export const VOICE_OFFER_TTL_MAX_SECONDS = 86_400;
export const VOICE_OFFER_MAX_ENTRIES_MIN = 1;
export const VOICE_OFFER_MAX_ENTRIES_MAX = 100_000;

/**
 * How many tokens one generation may authorize.
 *
 * `voiceAvailabilitySchema` caps `max_slots` at 3, so this is unreachable
 * today; it exists so the per-conversation memory stays bounded no matter what
 * a future caller of `findAvailability()` asks for. The ElevenLabs branch
 * being migrated uses `max_slots: 1`, and the store is deliberately written
 * for N rather than for 1 so that the other consumers of
 * `/ai/voice/availability` keep working unchanged.
 */
export const VOICE_OFFER_MAX_TOKENS = 16;

/**
 * How many expired entries one mutating call may reclaim.
 *
 * Bounded on purpose. A sweep that walked the whole map would make one
 * unlucky request pay for every idle conversation of the last hour, and this
 * code sits on the latency path of a live phone call. Entries are kept in
 * least-recently-touched order (see `touch`), so the expired ones cluster at
 * the head and the sweep can stop at the first live one.
 */
const SWEEP_BUDGET = 32;

interface MutableRecord {
  conversationId: string;
  generation: number;
  digests: Set<string>;
  state: VoiceOfferState;
  /**
   * The digests of the `offered` state this generation's `beginRefresh`
   * replaced, kept ONLY so a V2 lock that yields no token can put
   * them back (`publishEmptyPreservingPrior`). Never consulted by
   * `authorizes`: while it is set the state is `refreshing`, which refuses.
   * Cleared by every publish, so it never outlives its own generation.
   */
  suspended?: Set<string>;
  /**
   * V5 (ADR-023): digests of tokens that already produced a confirmed booking
   * in this call. Carried across every generation and checked FIRST by
   * `authorizes`. Absent unless `markConsumed` ran, which it never does when
   * one booking per call is the limit.
   */
  consumed?: Set<string>;
  createdAtMs: number;
  lastActivityAtMs: number;
  expiresAtMs: number;
}

export interface VoiceOfferStoreConfig {
  /**
   * Inactivity expiry. Every valid operation on a conversation pushes it out
   * again, so this bounds how long an ABANDONED conversation is remembered,
   * not how long a live one may run.
   *
   * It is deliberately generous (an hour by default). A short TTL would look
   * like a security control and would not be one — isolation comes from the
   * exact-match key, not from the clock — while a caller who is put on hold
   * for six minutes would lose an offer they are still entitled to.
   */
  ttlSeconds: number;
  /** Hard ceiling on remembered conversations; the least recently touched are
   * evicted first. */
  maxEntries: number;
  /**
   * HMAC key for the token digests. Defaults to a per-process random key,
   * which is the right default: the store is per-process anyway, and a random
   * key means the digests cannot be correlated with anything outside it.
   */
  digestKey?: string;
}

export class MemoryVoiceOfferStore implements VoiceOfferStore {
  private readonly records = new Map<string, MutableRecord>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly digestKey: Buffer;

  constructor(config: VoiceOfferStoreConfig) {
    if (
      !Number.isInteger(config.ttlSeconds) ||
      config.ttlSeconds < VOICE_OFFER_TTL_MIN_SECONDS ||
      config.ttlSeconds > VOICE_OFFER_TTL_MAX_SECONDS
    ) {
      throw new Error(
        `MemoryVoiceOfferStore: ttlSeconds must be an integer between ` +
          `${VOICE_OFFER_TTL_MIN_SECONDS} and ${VOICE_OFFER_TTL_MAX_SECONDS} ` +
          `(got ${config.ttlSeconds})`,
      );
    }
    if (
      !Number.isInteger(config.maxEntries) ||
      config.maxEntries < VOICE_OFFER_MAX_ENTRIES_MIN ||
      config.maxEntries > VOICE_OFFER_MAX_ENTRIES_MAX
    ) {
      throw new Error(
        `MemoryVoiceOfferStore: maxEntries must be an integer between ` +
          `${VOICE_OFFER_MAX_ENTRIES_MIN} and ${VOICE_OFFER_MAX_ENTRIES_MAX} ` +
          `(got ${config.maxEntries})`,
      );
    }
    this.ttlMs = config.ttlSeconds * 1000;
    this.maxEntries = config.maxEntries;
    // NEVER the value, and never its length, in any error above — a digest key
    // is key material like any other.
    this.digestKey =
      config.digestKey !== undefined && config.digestKey !== ""
        ? Buffer.from(config.digestKey, "utf8")
        : randomBytes(32);
  }

  get size(): number {
    return this.records.size;
  }

  beginRefresh(conversationId: string, nowMs: number): number {
    this.sweep(nowMs);
    const existing = this.live(conversationId, nowMs);

    // *** THE INVALIDATION IS HERE, NOT AFTER THE AGENDA ANSWERS. ***
    //
    // The previous offer dies the moment a new question is asked, so the
    // window in which the OLD hueco is still bookable is closed before the
    // upstream call even starts. Doing it on the way back would leave exactly
    // the gap this module exists to remove: a slow agenda read, and an agent
    // booking last minute's hour while it waits.
    const generation = (existing?.generation ?? 0) + 1;
    // *** `terminal` IS STICKY, AND IT KEEPS ITS DIGESTS. ***
    //
    // A conversation that already booked stays booked. Availability is a READ
    // and must keep answering — an agent that asks again after a confirmation
    // gets a normal answer — but the fact that this call has produced an
    // appointment is not something a later question may erase, and neither is
    // the authorization that produced it: the idempotent replay of that
    // booking has to keep passing {@link authorizes}. See `markTerminal`.
    const terminal = existing?.state === "terminal";
    // *** ONLY A LIVE `offered` STATE IS SUSPENDED — NOTHING ELSE. ***
    //
    // `empty`, `refreshing` (an overlapping question), an expired record or no
    // record at all have nothing bookable to keep, so there is nothing to
    // restore later: those conversations stay exactly as fail-closed as before.
    // Carrying a suspension THROUGH an overlapping refresh is deliberately not
    // done — two questions in flight is the ambiguous case, and ambiguity
    // resolves to "not bookable".
    const suspended =
      existing !== undefined && existing.state === "offered" && existing.digests.size > 0
        ? existing.digests
        : undefined;
    const record: MutableRecord = {
      conversationId,
      generation,
      digests: terminal ? existing.digests : new Set(),
      state: terminal ? "terminal" : "refreshing",
      ...(suspended !== undefined && !terminal ? { suspended } : {}),
      // V5: a consumed token stays consumed across every later generation.
      ...(existing?.consumed !== undefined ? { consumed: existing.consumed } : {}),
      createdAtMs: existing?.createdAtMs ?? nowMs,
      lastActivityAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
    this.records.delete(conversationId);
    this.records.set(conversationId, record);
    this.evictOverflow();
    return generation;
  }

  publishOffered(
    conversationId: string,
    generation: number,
    tokens: readonly string[],
    nowMs: number,
  ): boolean {
    const usable = tokens.filter((token) => typeof token === "string" && token !== "");
    if (usable.length === 0) return this.publishEmpty(conversationId, generation, nowMs);
    const digests = new Set(
      usable.slice(0, VOICE_OFFER_MAX_TOKENS).map((token) => this.digest(token)),
    );
    return this.publish(conversationId, generation, nowMs, "offered", digests);
  }

  publishEmpty(conversationId: string, generation: number, nowMs: number): boolean {
    return this.publish(conversationId, generation, nowMs, "empty", new Set());
  }

  publishEmptyPreservingPrior(
    conversationId: string,
    generation: number,
    nowMs: number,
  ): VoicePreserveOutcome {
    const record = this.live(conversationId, nowMs);
    // Same compare-and-set as `publish`: a newer generation — above all a LOCK
    // that completed while this question was in flight — is never clobbered
    // with the older offer.
    if (record === undefined || record.generation !== generation) return "superseded";
    const suspended = record.suspended;
    if (record.state === "refreshing" && suspended !== undefined) {
      record.suspended = undefined;
      record.digests = suspended;
      record.state = "offered";
      this.touch(record, nowMs);
      return "preserved";
    }
    this.publish(conversationId, generation, nowMs, "empty", new Set());
    return "empty";
  }

  /**
   * *** COMPARE-AND-SET BY GENERATION. ***
   *
   * The requirement this satisfies is narrow and easy to get wrong: an OLD
   * availability answer that resolves AFTER a newer question has started must
   * not be able to restore its own tokens. `mapWithConcurrency` fans a
   * multi-day question out over several upstream calls, ElevenLabs can fire a
   * second question while the first is still in flight, and the salon's API
   * does not answer in a fixed order — so "the last answer to arrive" and "the
   * last question to be asked" genuinely differ.
   *
   * The check is `record.generation === generation` and nothing else. A stale
   * answer finds a bigger number and silently declines; it does NOT clear the
   * newer state, because a late arrival knows nothing about what replaced it.
   */
  private publish(
    conversationId: string,
    generation: number,
    nowMs: number,
    nextState: "offered" | "empty",
    digests: Set<string>,
  ): boolean {
    const record = this.live(conversationId, nowMs);
    if (record === undefined) return false;
    if (record.generation !== generation) return false;

    if (record.state === "terminal") {
      // A conversation that has already booked keeps that label — relabelling
      // it `offered` would erase the one fact worth keeping — and keeps the
      // authorization that produced the booking, so its idempotent replay
      // still passes. The new tokens are ADDED rather than substituted; every
      // booking from here on is refused by the journal with
      // `already_booked_in_call`, which is the outcome that actually describes
      // the situation.
      for (const digest of digests) record.digests.add(digest);
      this.touch(record, nowMs);
      return true;
    }

    record.suspended = undefined;
    record.digests = digests;
    record.state = nextState;
    this.touch(record, nowMs);
    return true;
  }

  authorizes(conversationId: string, token: string, nowMs: number): VoiceOfferDecision {
    // Exact match, and nothing else. No "most recent", no prefix, no fallback.
    const record = this.records.get(conversationId);
    if (record === undefined) return { ok: false, refusal: "no_record" };
    if (nowMs >= record.expiresAtMs) {
      this.records.delete(conversationId);
      return { ok: false, refusal: "expired" };
    }
    // V5: checked before the state, so a consumed token is named as such
    // whatever this conversation is doing now. `consumed` is absent unless
    // more than one booking per call is allowed.
    if (record.consumed !== undefined && record.consumed.has(this.digest(token))) {
      return { ok: false, refusal: "consumed" };
    }
    if (record.state === "refreshing") return { ok: false, refusal: "refreshing" };
    if (record.state === "empty") return { ok: false, refusal: "empty" };
    if (!record.digests.has(this.digest(token))) {
      return { ok: false, refusal: "stale_token" };
    }
    this.touch(record, nowMs);
    return { ok: true, generation: record.generation };
  }

  /**
   * Records the confirmed booking. Called once, from the write path, after the
   * salon's API has said yes.
   *
   * *** IT DELIBERATELY KEEPS THE CURRENT DIGESTS. ***
   *
   * Two things depend on that. First, a replay of the very same booking must
   * still reach the idempotency journal, which is what returns the original
   * answer without writing again; refusing it here would turn a correct,
   * already-answered retry into `slot_not_authorized` and lose the
   * `idempotency_status: "replayed"` signal the agent is told to read.
   *
   * Second — and this is the reason this state is not a gate — a SECOND,
   * different booking in the same call is already refused, by the journal,
   * with `already_booked_in_call`. That outcome names the actual situation.
   * Re-answering it from here as `slot_not_authorized` would tell the agent
   * "go and re-check availability", which is precisely the wrong instruction
   * when the caller already has an appointment. The one-booking-per-call rule
   * has one owner (ADR-014/ADR-015) and this is not it.
   */
  markTerminal(conversationId: string, token: string, nowMs: number): void {
    const record = this.live(conversationId, nowMs);
    if (record === undefined) return;
    record.state = "terminal";
    record.suspended = undefined;
    // Pinned explicitly rather than assumed to be there already: an
    // availability question that started while this booking was in flight has
    // its own generation and has already cleared the digest set. The token
    // that actually authorized the appointment must survive that, or the
    // agent's next identical retry — the ordinary case, two seconds later —
    // would be refused instead of replayed.
    record.digests.add(this.digest(token));
    this.touch(record, nowMs);
  }

  /**
   * V5 (ADR-023). See {@link VoiceOfferStore.markConsumed}.
   *
   * *** IT ONLY REMOVES THE TOKEN THAT BOOKED — NEVER A NEWER LOCK. ***
   *
   * A write can finish in the background after its deadline, by which time
   * the agent may already have locked the NEXT booking's hour. Clearing the
   * whole digest set here would silently un-lock that newer hour; removing
   * exactly the booked token leaves it untouched. When the booked token was
   * the only one on the table, the conversation drops to `empty`: nothing is
   * bookable until the next `lock`, which is precisely the V5 flow.
   */
  markConsumed(conversationId: string, token: string, nowMs: number): void {
    const record = this.live(conversationId, nowMs);
    if (record === undefined) return;
    const digest = this.digest(token);
    if (record.consumed === undefined) record.consumed = new Set();
    record.consumed.add(digest);
    record.digests.delete(digest);
    record.suspended?.delete(digest);
    if (record.state === "offered" && record.digests.size === 0) {
      record.state = "empty";
    }
    this.touch(record, nowMs);
  }

  peek(conversationId: string, nowMs: number): VoiceOfferRecord | undefined {
    const record = this.live(conversationId, nowMs);
    if (record === undefined) return undefined;
    return {
      conversationId: record.conversationId,
      generation: record.generation,
      tokenDigests: [...record.digests],
      state: record.state,
      createdAtMs: record.createdAtMs,
      lastActivityAtMs: record.lastActivityAtMs,
      expiresAtMs: record.expiresAtMs,
    };
  }

  /** The record, or nothing — dropping it if it has aged out. */
  private live(conversationId: string, nowMs: number): MutableRecord | undefined {
    const record = this.records.get(conversationId);
    if (record === undefined) return undefined;
    if (nowMs >= record.expiresAtMs) {
      this.records.delete(conversationId);
      return undefined;
    }
    return record;
  }

  /**
   * Pushes the inactivity deadline out and moves the entry to the tail.
   *
   * The re-insertion is what makes eviction least-recently-touched rather than
   * oldest-created: a `Map` iterates in insertion order, so deleting and
   * re-setting is an O(1) way to keep the head of the map the best eviction
   * candidate — and, incidentally, the place where expired entries collect.
   */
  private touch(record: MutableRecord, nowMs: number): void {
    record.lastActivityAtMs = nowMs;
    record.expiresAtMs = nowMs + this.ttlMs;
    this.records.delete(record.conversationId);
    this.records.set(record.conversationId, record);
  }

  /** Bounded reclamation of aged-out entries. No timers, no full scans. */
  private sweep(nowMs: number): void {
    let budget = SWEEP_BUDGET;
    for (const [key, record] of this.records) {
      if (budget-- <= 0) break;
      // The head is the least recently touched, so the first live entry ends
      // the sweep: everything behind it was touched later and expires later.
      if (nowMs < record.expiresAtMs) break;
      this.records.delete(key);
    }
  }

  /** The hard ceiling. Evicts the least recently touched until it holds. */
  private evictOverflow(): void {
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) return;
      this.records.delete(oldest.value);
    }
  }

  /**
   * Keyed digest of a token.
   *
   * Keyed rather than a bare SHA-256 so the stored value is useless outside
   * this process: an unkeyed digest of a token is a perfectly good lookup key
   * for anyone who obtains both the digest and a list of candidate tokens.
   * Truncated to 32 base64url characters (192 bits) — far past collision
   * relevance for a set of at most sixteen entries, and shorter to hold.
   */
  private digest(token: string): string {
    return createHmac("sha256", this.digestKey)
      .update(token, "utf8")
      .digest("base64url")
      .slice(0, 32);
  }
}
