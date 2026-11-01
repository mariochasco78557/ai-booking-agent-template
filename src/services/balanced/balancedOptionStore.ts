/**
 * *** THE THREE HOURS THIS CALL IS CURRENTLY CONSIDERING. ***
 *
 * The V2 flow splits what V1 did in one step into two, and this store is what
 * makes the split safe.
 *
 * `discover` speaks three hours and stores them HERE. It mints no token, so
 * nothing it produces can reach a write path: an option is a NUMBER the caller
 * can say out loud ("la segunda"), not a credential. `lock` then resolves that
 * number against this store, re-checks the hour upstream, and only then asks
 * `SlotAuthorizationService` for a token.
 *
 * That ordering is the whole design. The failure it removes is the one the
 * 2026-08-30 incident actually demonstrated: a model that reconstructs a
 * plausible `reservation_date` from the conversation. In V2 there is no field
 * for it to reconstruct at either step — discovery takes a day and a band, and
 * locking takes `1`, `2` or `3`. An index the store does not hold is refused
 * without a single upstream call.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────
 *
 * It is not a hold, not a reservation, and not evidence that an hour is free.
 * The salon's diary remains the only authority, and `lock` re-reads it with the
 * cache out of the path (`AgendaReader.readFresh`, (internal doc, not included in the template) ADR-010)
 * before it authorizes anything. A record here says "these are the hours this
 * call was last offered"; it never says "these hours are still free".
 *
 * It is also not the authorization store. That is
 * `src/services/voiceOfferStore.ts`, which holds the TOKENS a lock published
 * and is what `/ai/voice/v2/book` consults. The two are deliberately separate
 * objects with separate lifetimes: options are cheap, speakable and plural;
 * tokens are bearer credentials and singular.
 *
 * ── ISOLATION IS BY EXACT KEY ─────────────────────────────────────────────
 *
 * Every lookup is `Map.get(conversationId)`. No "most recent conversation", no
 * prefix match, no fallback. An option belonging to another call is simply not
 * found, which is the same answer as an option that never existed — and both
 * send the agent back to `discover`, which is the only correct recovery.
 *
 * Expiry is a memory bound, not the isolation mechanism. Two live calls are
 * isolated because their keys differ.
 *
 * In-memory and single-process, exactly like the offer store and for the same
 * reasons; a restart empties it and that is the correct failure, because a
 * pending option whose memory is gone must be re-offered rather than
 * reconstructed. See (internal doc, not included in the template) before adding a second replica.
 */

import type { TimePeriod } from "../../utils/balancedPhrasing.js";

/** One numbered hour the caller may choose, plus the barber picked for it. */
export interface BalancedOption {
  /** 1, 2 or 3 — the number the agent speaks and the caller repeats (up to
   * 10 on a WhatsApp page, 2026-10-08). */
  optionIndex: number;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:mm`. */
  time: string;
  /** `"YYYY-MM-DD HH:mm:ss"`, upstream's own wall-clock shape. */
  reservationDate: string;
  /** The service the discovery question was asked with. */
  serviceId: number;
  /** The band actually offered (which may not be the one requested). */
  period: TimePeriod;
  /**
   * The least-loaded eligible barber for this hour, decided at discovery.
   *
   * *** NEVER SPOKEN AT THIS STAGE. *** It is stored so the assignment stays
   * stable across the call, and it is revealed only by `lock`, in the summary.
   */
  assignedEmployeeId: number;
  /** Every barber who was free at this hour when the options were built. */
  eligibleEmployeeIds: readonly number[];
}

/** Why a lookup failed. Diagnostic only — all three produce one refusal. */
export type BalancedOptionRefusal =
  /** No options at all: a call that never discovered, or a restart. */
  | "no_record"
  /** The options aged out before the caller chose. */
  | "expired"
  /** An index this conversation was never offered. */
  | "unknown_option";

export type BalancedOptionLookup =
  | { ok: true; option: BalancedOption; generation: number }
  | { ok: false; refusal: BalancedOptionRefusal };

/**
 * *** WHERE THE CALL IS UP TO IN THE SALON'S HOURS. ***
 *
 * The three options above are what the caller was just READ; this is what is
 * LEFT, and the two are stored together so a page and its cursor can never be
 * observed out of step.
 *
 * The whole ranking is frozen at `discover` and never recomputed. That is
 * deliberate and it is the property that makes "sin repetir horas" true: a
 * second page taken from a fresh agenda read could contain an hour the first
 * page already offered (the ranking would shift as the day fills), and could
 * silently drop one that is still free. Pagination walks a LIST, not a
 * changing query — and because a frozen list is a claim about the past, `lock`
 * still re-reads the day before it authorizes anything (ADR-010).
 *
 * The model never sees any of this. There is no cursor field in the tool
 * contract (`src/schemas/balancedV2Schemas.ts`): `action: "more"` carries a
 * conversation id, and the server knows the rest.
 */
/**
 * What every continuation carries, whatever question produced it.
 *
 * The ranking and the cursor live HERE rather than in each variant because
 * pagination is the one behaviour the two questions share exactly: `more`
 * slices `rankedOptions` at `offset` and knows nothing about how the list was
 * built. That is what makes «otros horarios» identical for a day and for a
 * window — one code path, one set of guarantees.
 */
export interface BalancedContinuationBase {
  /** The service the frozen ranking was computed for. */
  serviceId: number;
  /** The hour the caller mentioned, if any. It only ranked the list. */
  preferredTime?: string;
  /** Set only when the caller narrowed discovery to one professional. */
  employeeId?: number;
  /** The COMPLETE ranking, in the order it will be offered. Frozen. */
  rankedOptions: readonly BalancedOption[];
  /**
   * How many of `rankedOptions` have already been spoken. It advances ONLY
   * when a page is published, by exactly the number of options published, so
   * an answer that offers nothing cannot skip an hour.
   */
  offset: number;
}

/** The continuation of a ONE-DAY question — what `discover` freezes. */
export interface BalancedDayContinuation extends BalancedContinuationBase {
  kind: "day";
  /** `YYYY-MM-DD`. One continuation is one day. */
  date: string;
  /**
   * Set only by the discover LOOK-AHEAD: the day the caller asked for, when
   * the page (and so `date`) is the nearest following day with hours. A
   * `more` that repeats the requested day is not contradicting anything.
   */
  requestedDate?: string;
  /** The band the caller ASKED for. */
  requestedPeriod: TimePeriod;
  /**
   * The band actually being walked — which is the other one when `discover`
   * fell back. Pagination follows THIS, never the requested one, or the second
   * page would answer a question the first one already declined.
   */
  offeredPeriod: TimePeriod;
}

/**
 * The continuation of a WINDOW question — what `scan` freezes.
 *
 * *** IT REMEMBERS WHAT IT COULD NOT READ. ***
 *
 * `daysChecked` and `partial` are stored, not merely reported once, because a
 * window answer is a claim about a SET of days and the set is what makes the
 * claim honest. A `more` on a partial scan is still paginating a list built
 * from five of seven days, and `contradicts` still has to know which days the
 * agent is entitled to be talking about.
 *
 * There is no `offeredPeriod`: a scan never falls back to the other band. A
 * caller who says «por la tarde» about a whole week is stating a constraint,
 * and silently answering with mornings across seven days would be a different
 * question, not a graceful degradation.
 */
export interface BalancedScanContinuation extends BalancedContinuationBase {
  kind: "scan";
  /** `YYYY-MM-DD`, the first day of the window. */
  dateFrom: string;
  /** How many days the window spans, starting at `dateFrom`. */
  days: number;
  /**
   * 2026-10-11 — a `weekday` scan: the exact dates of the window (not a run of
   * consecutive days). Absent for an ordinary scan, which is `dateFrom`..`days`.
   */
  dates?: readonly string[];
  /** The hard `HH:mm` floor the caller asked for, if any. */
  afterTime?: string;
  /** The hard `HH:mm` ceiling the caller asked for, if any. */
  beforeTime?: string;
  /** The band, when the caller narrowed to one. A hard filter, not a preference. */
  period?: TimePeriod;
  /** The days that actually ARRIVED before the deadline, in window order. */
  daysChecked: readonly string[];
  /** True when at least one day of the window was not read in time. */
  partial: boolean;
}

/**
 * *** WHERE THE CALL IS UP TO IN THE SALON'S HOURS. ***
 *
 * The three options above are what the caller was just READ; this is what is
 * LEFT, and the two are stored together so a page and its cursor can never be
 * observed out of step.
 *
 * The whole ranking is frozen at `discover` (or at `scan`) and never
 * recomputed. That is deliberate and it is the property that makes "sin
 * repetir horas" true: a second page taken from a fresh agenda read could
 * contain an hour the first page already offered (the ranking would shift as
 * the day fills), and could silently drop one that is still free. Pagination
 * walks a LIST, not a changing query — and because a frozen list is a claim
 * about the past, `lock` still re-reads the day before it authorizes anything
 * (ADR-010).
 *
 * *** `kind` IS A DISCRIMINANT, NOT A FLAG. ***
 *
 * The two variants are genuinely different questions — one day and a band, or
 * a window and a time constraint — and a single optional-field shape would have
 * let a scan continuation be read as a day one with `date` missing. Every
 * branch that has to know which question it is continuing (`contradicts`, the
 * exhaustion sentence) switches on `kind` and the compiler checks it did.
 *
 * The model never sees any of this. There is no cursor field in the tool
 * contract (`src/schemas/balancedV2Schemas.ts`): `action: "more"` carries a
 * conversation id, and the server knows the rest.
 */
export type BalancedContinuation = BalancedDayContinuation | BalancedScanContinuation;

/** One conversation's options, as an inspectable snapshot. */
export interface BalancedOptionRecord {
  conversationId: string;
  /** Bumped by every `publish`, so a diagnostic can see re-discovery happen. */
  generation: number;
  options: readonly BalancedOption[];
  /**
   * The page size this page was published WITH (3 for voice, up to
   * {@link BALANCED_OPTION_PAGE_CEILING} for a WhatsApp page, 2026-10-08).
   * `lock` validates `option_index` against this, never against a header.
   */
  pageSize: number;
  /** Where this call is up to, when it has a page to continue. */
  continuation?: BalancedContinuation;
  createdAtMs: number;
  lastActivityAtMs: number;
  expiresAtMs: number;
}

export interface BalancedOptionStore {
  /**
   * Replaces this conversation's options wholesale. The previous set is gone
   * the moment a new discovery answers — a caller who asked for other hours is
   * not still holding the old ones.
   *
   * `continuation` is optional and REPLACES whatever was stored, including
   * with nothing: a `publish` that omits it deliberately erases the cursor, so
   * "there are no options" and "there is nowhere to continue from" are one
   * atomic fact rather than two that could disagree.
   */
  publish(
    conversationId: string,
    options: readonly BalancedOption[],
    nowMs: number,
    continuation?: BalancedContinuation,
    /**
     * How many options this page may hold. Omitted = the spoken page,
     * {@link BALANCED_OPTION_MAX_OPTIONS}, which is what every voice publish
     * uses. Clamped to 1..{@link BALANCED_OPTION_PAGE_CEILING}.
     */
    pageSize?: number,
  ): number;
  /**
   * The page size the CURRENT page was published with, or `undefined` when
   * this conversation has no live record. Same exact-key, same TTL rule as
   * `get`, and it is a pure read: it neither touches nor reclaims the record.
   */
  pageSize(conversationId: string, nowMs: number): number | undefined;
  /** Exact-match, no fallback: is this index one of THIS call's options? */
  get(conversationId: string, optionIndex: number, nowMs: number): BalancedOptionLookup;
  /**
   * Where this call is up to, or `undefined` when there is nothing to
   * continue. Same exact-key, same TTL, same no-fallback rule as `get`.
   */
  continuation(conversationId: string, nowMs: number): BalancedContinuation | undefined;
  /** A snapshot for tests and diagnostics. Never reached over HTTP. */
  peek(conversationId: string, nowMs: number): BalancedOptionRecord | undefined;
  /** How many conversations are currently remembered. */
  readonly size: number;
}

/** Bounds the store enforces on itself, for the same reason
 * `MemoryVoiceOfferStore` does: the class is exported, so a call site that
 * never passes through the env schema must still get a sane store or none. */
export const BALANCED_OPTION_TTL_MIN_SECONDS = 60;
export const BALANCED_OPTION_TTL_MAX_SECONDS = 86_400;
export const BALANCED_OPTION_MAX_ENTRIES_MIN = 1;
export const BALANCED_OPTION_MAX_ENTRIES_MAX = 100_000;

/** How many options ONE PAGE may publish. Three is the spoken maximum; the
 * ceiling exists so the per-conversation memory stays bounded whatever a
 * future caller asks for. It bounds the page, NOT the inventory — the rest of
 * the ranking lives in the continuation below. */
export const BALANCED_OPTION_MAX_OPTIONS = 3;

/**
 * The largest page ANY publish may store: a WhatsApp page (owner request
 * 2026-10-08, `BALANCED_WA_MAX_OPTIONS`), shown as a WhatsApp list, which
 * holds at most ten rows. Voice pages never use it — they are published with
 * {@link BALANCED_OPTION_MAX_OPTIONS}.
 */
export const BALANCED_OPTION_PAGE_CEILING = 10;

/** A publish's page size, made safe: an integer in 1..PAGE_CEILING. */
function boundedPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isInteger(pageSize) || pageSize < 1) {
    return BALANCED_OPTION_MAX_OPTIONS;
  }
  return Math.min(pageSize, BALANCED_OPTION_PAGE_CEILING);
}

/**
 * How many hours one continuation may remember.
 *
 * A band is at most a few hours wide on a half-hourly grid, so 32 is far above
 * anything the salon can produce and the truncation is a memory bound rather
 * than a product decision — the same role `maxEntries` plays for the map. It is
 * a hard cap on purpose: a per-conversation list whose length is decided by
 * upstream data is a per-conversation list an upstream fault can make enormous.
 *
 * When it does bite, the answer stays honest: `has_more` is computed from the
 * TRUNCATED list, so the agent is never told there are hours it can no longer
 * reach.
 */
export const BALANCED_CONTINUATION_MAX_SLOTS = 32;

/** Same bounded reclamation as the offer store: this code is on the latency
 * path of a live phone call and must never pay for every idle conversation. */
const SWEEP_BUDGET = 32;

interface MutableRecord {
  conversationId: string;
  generation: number;
  options: readonly BalancedOption[];
  pageSize: number;
  continuation?: BalancedContinuation;
  createdAtMs: number;
  lastActivityAtMs: number;
  expiresAtMs: number;
}

export interface BalancedOptionStoreConfig {
  /** Inactivity expiry. Every valid operation pushes it out again. */
  ttlSeconds: number;
  /** Hard ceiling; the least recently touched conversations are evicted. */
  maxEntries: number;
}

export class MemoryBalancedOptionStore implements BalancedOptionStore {
  private readonly records = new Map<string, MutableRecord>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(config: BalancedOptionStoreConfig) {
    if (
      !Number.isInteger(config.ttlSeconds) ||
      config.ttlSeconds < BALANCED_OPTION_TTL_MIN_SECONDS ||
      config.ttlSeconds > BALANCED_OPTION_TTL_MAX_SECONDS
    ) {
      throw new Error(
        `MemoryBalancedOptionStore: ttlSeconds must be an integer between ` +
          `${BALANCED_OPTION_TTL_MIN_SECONDS} and ${BALANCED_OPTION_TTL_MAX_SECONDS} ` +
          `(got ${config.ttlSeconds})`,
      );
    }
    if (
      !Number.isInteger(config.maxEntries) ||
      config.maxEntries < BALANCED_OPTION_MAX_ENTRIES_MIN ||
      config.maxEntries > BALANCED_OPTION_MAX_ENTRIES_MAX
    ) {
      throw new Error(
        `MemoryBalancedOptionStore: maxEntries must be an integer between ` +
          `${BALANCED_OPTION_MAX_ENTRIES_MIN} and ${BALANCED_OPTION_MAX_ENTRIES_MAX} ` +
          `(got ${config.maxEntries})`,
      );
    }
    this.ttlMs = config.ttlSeconds * 1000;
    this.maxEntries = config.maxEntries;
  }

  get size(): number {
    return this.records.size;
  }

  publish(
    conversationId: string,
    options: readonly BalancedOption[],
    nowMs: number,
    continuation?: BalancedContinuation,
    pageSize?: number,
  ): number {
    this.sweep(nowMs);
    const existing = this.live(conversationId, nowMs);
    const generation = (existing?.generation ?? 0) + 1;
    const size = boundedPageSize(pageSize);
    const record: MutableRecord = {
      conversationId,
      generation,
      options: options.slice(0, size),
      pageSize: size,
      // *** THE PAGE AND ITS CURSOR LAND IN THE SAME ASSIGNMENT. ***
      // One object, built whole and then swapped in below, so there is no
      // instant at which the new page is readable beside the old offset.
      ...(continuation !== undefined
        ? {
            continuation: {
              ...continuation,
              rankedOptions: continuation.rankedOptions.slice(
                0,
                BALANCED_CONTINUATION_MAX_SLOTS,
              ),
            },
          }
        : {}),
      createdAtMs: existing?.createdAtMs ?? nowMs,
      lastActivityAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
    // Delete-then-set keeps the map in least-recently-touched order, so the
    // head is both the best eviction candidate and where expired entries pile
    // up. Same trick as `MemoryVoiceOfferStore`.
    this.records.delete(conversationId);
    this.records.set(conversationId, record);
    this.evictOverflow();
    return generation;
  }

  get(conversationId: string, optionIndex: number, nowMs: number): BalancedOptionLookup {
    const record = this.records.get(conversationId);
    if (record === undefined) return { ok: false, refusal: "no_record" };
    if (nowMs >= record.expiresAtMs) {
      this.records.delete(conversationId);
      return { ok: false, refusal: "expired" };
    }
    const option = record.options.find((entry) => entry.optionIndex === optionIndex);
    if (option === undefined) return { ok: false, refusal: "unknown_option" };
    this.touch(record, nowMs);
    return { ok: true, option, generation: record.generation };
  }

  pageSize(conversationId: string, nowMs: number): number | undefined {
    // Read-only on purpose: no touch and no expiry delete, so asking the size
    // changes nothing `get` would later observe (including its `expired`).
    const record = this.records.get(conversationId);
    if (record === undefined || nowMs >= record.expiresAtMs) return undefined;
    return record.pageSize;
  }

  continuation(conversationId: string, nowMs: number): BalancedContinuation | undefined {
    // `live` applies the SAME expiry as `get`, and deliberately does not touch
    // the record: reading where a call is up to is not activity, publishing the
    // next page is — and that publish happens moments later on the one path
    // that has a page to publish.
    return this.live(conversationId, nowMs)?.continuation;
  }

  peek(conversationId: string, nowMs: number): BalancedOptionRecord | undefined {
    const record = this.live(conversationId, nowMs);
    if (record === undefined) return undefined;
    return {
      conversationId: record.conversationId,
      generation: record.generation,
      options: record.options,
      pageSize: record.pageSize,
      ...(record.continuation !== undefined ? { continuation: record.continuation } : {}),
      createdAtMs: record.createdAtMs,
      lastActivityAtMs: record.lastActivityAtMs,
      expiresAtMs: record.expiresAtMs,
    };
  }

  private live(conversationId: string, nowMs: number): MutableRecord | undefined {
    const record = this.records.get(conversationId);
    if (record === undefined) return undefined;
    if (nowMs >= record.expiresAtMs) {
      this.records.delete(conversationId);
      return undefined;
    }
    return record;
  }

  private touch(record: MutableRecord, nowMs: number): void {
    record.lastActivityAtMs = nowMs;
    record.expiresAtMs = nowMs + this.ttlMs;
    this.records.delete(record.conversationId);
    this.records.set(record.conversationId, record);
  }

  private sweep(nowMs: number): void {
    let budget = SWEEP_BUDGET;
    for (const [key, record] of this.records) {
      if (budget-- <= 0) break;
      if (nowMs < record.expiresAtMs) break;
      this.records.delete(key);
    }
  }

  private evictOverflow(): void {
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) return;
      this.records.delete(oldest.value);
    }
  }
}
