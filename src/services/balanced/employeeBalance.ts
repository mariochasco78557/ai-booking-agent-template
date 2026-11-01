import { createHash } from "node:crypto";

/**
 * *** WHO GETS THE NEXT APPOINTMENT — the balancing rule, as a pure function. ***
 *
 * The salon's ask is plain: spread the work. The V1 flow does the opposite by
 * construction — `AvailabilityService` attributes a shared hour to the LOWEST
 * BARBER ID, deterministically, so a phone line that books all day fills Bruno's
 * diary first and only ever reaches Olga once Bruno is full.
 *
 * This module is the replacement rule, and it is deliberately separate from
 * everything that reads the agenda or speaks to a caller: it takes numbers and
 * returns an id, so every property below is testable without a network, a
 * clock, or a Fastify instance.
 *
 * ── THE SIGNAL ────────────────────────────────────────────────────────────
 *
 * "Least loaded" needs a measurement, and the salon's API gives us only one
 * half of the obvious one. `/user/free` reports FREE hours; nothing upstream
 * reports total capacity or the number of booked appointments, so an occupancy
 * PERCENTAGE — the better signal, and the one to use the day it exists — is not
 * computable today.
 *
 * The proxy is the free-hour count itself, within the same day, service and
 * band: **more free hours means less observable load**. It is not a perfect
 * measure of a working day (a barber who starts at noon looks busy all
 * morning), and it does not need to be. It needs to be monotone in the right
 * direction and to stop the lowest id from winning every time, and it is both.
 *
 * {@link resolveBalanceSignal} picks between the two, for the ROSTER AS A
 * WHOLE rather than per barber. Mixing an occupancy ratio for one barber with a
 * free-slot count for another would compare numbers on different scales and
 * silently produce nonsense; if capacity data ever arrives for some barbers and
 * not others, the proxy is used for everyone.
 *
 * ── THE TIE-BREAK ─────────────────────────────────────────────────────────
 *
 * Ties are the normal case, not the edge case: at nine in the morning every
 * barber on duty typically has an identical, empty diary. A tie-break by lowest
 * id would reinstate exactly the bias this module exists to remove, so it must
 * be something else — and it must satisfy two requirements that pull against
 * each other:
 *
 * - **Different conversations must diverge.** Two callers asking for the same
 *   Tuesday at ten must not both be sent to the same barber.
 * - **One conversation must not.** Within a call, the same hour must resolve to
 *   the same barber every time it is evaluated — at discovery, at lock, and at
 *   a lock repeated after the caller changed their mind — or the summary the
 *   agent reads would contradict the appointment it creates.
 *
 * A hash of `(conversationId, date, time, employeeId)` satisfies both exactly:
 * it is a fixed function of its inputs, so it never moves inside a call, and it
 * decorrelates across conversation ids, so the winner rotates between calls. It
 * is NOT randomness — nothing here calls `Math.random()`, and re-running the
 * whole flow for the same call reproduces the same assignment.
 *
 * A plain SHA-256 rather than a keyed digest, on purpose: this value orders a
 * roster, it does not authenticate anything, and there is nothing here worth
 * hiding from someone who already knows the conversation id. Introducing a
 * secret would imply a security property this does not have.
 */

/** Which measurement is being used to compare barbers. */
export type BalanceSignal =
  /** Real occupancy: `occupied / totalCapacity`. Lower is less loaded. */
  | "occupancy_ratio"
  /** Free compatible hours as a proxy. More free hours is less loaded. */
  | "free_slots_proxy";

/** One barber's measurable load within ONE day, service and band. */
export interface BalanceCandidate {
  employeeId: number;
  /**
   * Free hours this barber has that are compatible with the question being
   * asked — same day, same service, same band. Always available: it is what
   * `/user/free` returns.
   */
  freeCompatibleSlots: number;
  /** Total bookable hours, when upstream ever exposes it. */
  totalCapacity?: number;
  /** Booked hours, when upstream ever exposes it. */
  occupied?: number;
}

/**
 * The best signal the WHOLE candidate set supports.
 *
 * Requires capacity data on every candidate, and a non-zero capacity, before
 * choosing the ratio: a division by zero would be `NaN`, and `NaN` sorts
 * unpredictably, which is the worst possible failure mode for a rule whose only
 * job is to be fair.
 */
export function resolveBalanceSignal(
  candidates: readonly BalanceCandidate[],
): BalanceSignal {
  if (candidates.length === 0) return "free_slots_proxy";
  const everyoneMeasured = candidates.every(
    (candidate) =>
      typeof candidate.totalCapacity === "number" &&
      candidate.totalCapacity > 0 &&
      typeof candidate.occupied === "number" &&
      candidate.occupied >= 0,
  );
  return everyoneMeasured ? "occupancy_ratio" : "free_slots_proxy";
}

/**
 * How loaded this barber is, on the chosen scale. LOWER IS LESS LOADED, in
 * both branches, so the comparison below reads the same either way.
 */
export function loadScore(signal: BalanceSignal, candidate: BalanceCandidate): number {
  if (signal === "occupancy_ratio") {
    const capacity = candidate.totalCapacity ?? 0;
    const occupied = candidate.occupied ?? 0;
    // `resolveBalanceSignal` has already established capacity > 0 for every
    // candidate before this branch can be selected; the guard is here so a
    // direct caller cannot produce a NaN.
    return capacity > 0 ? occupied / capacity : 1;
  }
  // Negated so "more free hours" sorts FIRST, exactly like "lower occupancy".
  return -candidate.freeCompatibleSlots;
}

/** The context a tie is broken against. Stable per call, varies between calls. */
export interface TieBreakContext {
  conversationId: string;
  date: string;
  time: string;
}

/**
 * A stable, conversation-scoped ordering key. See the module comment for why
 * this is a hash and not the employee id, and why it is not randomness.
 */
export function tieBreakKey(context: TieBreakContext, employeeId: number): string {
  return createHash("sha256")
    .update(`${context.conversationId}|${context.date}|${context.time}|${employeeId}`, "utf8")
    .digest("hex");
}

/**
 * The barber to assign, or `undefined` when there is nobody to assign.
 *
 * Comparison order — load first, then the tie-break key. The tie-break NEVER
 * overrides a real difference in load: a barber with a fuller diary does not win
 * because their hash happened to sort first. It only decides between barbers the
 * signal cannot distinguish.
 */
export function leastLoadedEmployee(
  candidates: readonly BalanceCandidate[],
  context: TieBreakContext,
): number | undefined {
  if (candidates.length === 0) return undefined;
  const signal = resolveBalanceSignal(candidates);
  const ranked = [...candidates].sort((a, b) => {
    const byLoad = loadScore(signal, a) - loadScore(signal, b);
    if (byLoad !== 0) return byLoad;
    const keyA = tieBreakKey(context, a.employeeId);
    const keyB = tieBreakKey(context, b.employeeId);
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    // Two identical hashes would be a SHA-256 collision on a four-field string;
    // the id keeps `sort` total rather than leaving it to the engine.
    return a.employeeId - b.employeeId;
  });
  return ranked[0]?.employeeId;
}
