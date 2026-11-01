import { addDays, daysBetween } from "./time.js";
import type { Clock } from "./types.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — THE ADVANCEABLE DEMO CLOCK (design §3.2).
 *
 * WHY IT EXISTS. `buildConsoleServer` runs on `fixedClock(BOOKING_DEMO_TODAY,
 * BOOKING_DEMO_NOW_MINUTES)` — 09:00 of Tuesday 2026-08-04. With the clock
 * nailed there, NO appointment of the fixture has ever finished, so the
 * manual no-show of §2 would have nothing to demonstrate: not one eligible
 * appointment would exist. This wrapper is the ONLY reason that feature is
 * demonstrable at all.
 *
 * WHY IT WRAPS A `Clock` INSTEAD OF REPLACING IT. `ConsoleServerDeps.clock`
 * is injected by several existing test suites. Wrapping preserves that
 * contract exactly: WITH OFFSET 0 THE WRAPPER IS INDISTINGUISHABLE FROM THE
 * CLOCK IT WRAPS, because the three readers DELEGATE LITERALLY — including
 * `nowInstantISO()`, whose format therefore stays whatever the injected clock
 * produces. Recomposing the instant unconditionally would have rewritten the
 * `atISO` of events that other missions already verified byte for byte
 * (design §3.2, criterion 8.39). Only once the offset is strictly positive is
 * the instant derived here, in `fixedClock`'s own `YYYY-MM-DDTHH:MM:00`
 * shape — and by then no foreign format is being overwritten, because the
 * instant is produced by this module.
 *
 * INVARIANTS (design §3.2, table I1..I5):
 *   I1 MONOTONIC — the instant NEVER decreases except through
 *      `resetToBaseline()`. `advanceMinutes` refuses anything that is not a
 *      positive integer; `advanceTo` returns `null` for a destination that is
 *      not strictly later, and changes nothing.
 *   I2 NO WALL CLOCK — no `Date.now()`, no bare `new Date()`, no
 *      `setTimeout`, no `setInterval`, no `Math.random()`. Pinned by
 *      tests/callEngine/boundaries.test.ts over all of src/callEngine/**.
 *   I3 DETERMINISTIC — the whole state is `offsetMinutes`, an integer, plus
 *      the wrapped clock. The same sequence of commands from a clean start
 *      always lands on the same instant.
 *   I4 MOVED ONLY BY AN OPERATOR COMMAND — the one caller of
 *      `advanceMinutes`/`advanceTo` is `POST /api/lab/clock/advance`.
 *   I5 `resetToBaseline()` IS CALLED ONLY BY `POST /api/reset` (design §1.5,
 *      criterion 8.9), and it must be the FIRST step of it: the waitlist
 *      store captures this clock BY REFERENCE and stamps its `DEMO_RESET`
 *      and its six seed entries with whatever hour it reads.
 *
 * NO DATE ARITHMETIC IS WRITTEN HERE: crossing midnight uses `addDays` and
 * `daysBetween` from `domain/time.ts`, the same helpers `evaluateTimeliness`
 * already uses, so every day boundary behaves identically across the demo.
 * ────────────────────────────────────────────────────────────────────────
 */

const MINUTES_PER_DAY = 1440;

/** A synthetic instant of the demo: a wall-clock date plus minutes since midnight. */
export interface DemoInstant {
  dateISO: string;
  minutes: number;
}

export interface AdvanceableClock extends Clock {
  /**
   * Advances `minutes` (a strictly positive integer) and returns the new
   * instant. NEVER goes backwards: a non-positive or non-integer amount is a
   * programming error, not an operator choice, and throws rather than
   * silently rewinding time.
   */
  advanceMinutes(minutes: number): DemoInstant;
  /**
   * Jumps to an absolute instant. Returns `null` — and changes NOTHING — when
   * the destination is earlier than or equal to the current instant (I1).
   */
  advanceTo(dateISO: string, minutes: number): DemoInstant | null;
  /** Back to the wrapped clock's own instant. ONLY `POST /api/reset` calls this (I5). */
  resetToBaseline(): void;
  /** How far the clock has been moved since the process started. Derived, for the screen. */
  advancedByMinutes(): number;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function advanceableClock(base: Clock): AdvanceableClock {
  let offsetMinutes = 0;

  function current(): DemoInstant {
    const baseDate = base.nowISODate();
    const baseMinutes = base.nowMinutes();
    if (offsetMinutes === 0) return { dateISO: baseDate, minutes: baseMinutes };
    const total = baseMinutes + offsetMinutes;
    // `Math.floor` (not a truncation) keeps this correct if a wrapped clock
    // ever reported a negative minute-of-day; the demo never does, but the
    // arithmetic should not depend on that.
    const dayShift = Math.floor(total / MINUTES_PER_DAY);
    const minutes = total - dayShift * MINUTES_PER_DAY;
    return { dateISO: addDays(baseDate, dayShift), minutes };
  }

  return {
    nowISODate() {
      return offsetMinutes === 0 ? base.nowISODate() : current().dateISO;
    },
    nowMinutes() {
      return offsetMinutes === 0 ? base.nowMinutes() : current().minutes;
    },
    nowInstantISO() {
      // DELEGATION, not reconstruction (criterion 8.39): while the clock has
      // not been moved, whatever the wrapped clock says IS the answer.
      if (offsetMinutes === 0) return base.nowInstantISO();
      const { dateISO, minutes } = current();
      return `${dateISO}T${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}:00`;
    },
    advanceMinutes(minutes) {
      if (!Number.isInteger(minutes) || minutes <= 0) {
        throw new RangeError(
          "El reloj de la demostración sólo avanza: 'minutes' debe ser un entero mayor que cero.",
        );
      }
      offsetMinutes += minutes;
      return current();
    },
    advanceTo(dateISO, minutes) {
      const from = current();
      const delta = daysBetween(from.dateISO, dateISO) * MINUTES_PER_DAY + minutes - from.minutes;
      if (delta <= 0) return null;
      offsetMinutes += delta;
      return current();
    },
    resetToBaseline() {
      offsetMinutes = 0;
    },
    advancedByMinutes() {
      return offsetMinutes;
    },
  };
}
