import { describe, it, expect } from "vitest";
import { ES } from "../../src/callEngine/phrasing/es.js";
import type { PhraseKey } from "../../src/callEngine/phrasing/keys.js";

/**
 * Honesty rule 4 (see `phrasing/keys.ts`): the phrase catalogue is static and
 * has no access to the calendar, so it must never recite concrete opening days
 * or hours.
 *
 * This is not a hypothetical. Before step 14 the catalogue told every caller
 * "En esta demo solo abrimos lunes y martes" and offered "nuestro horario de
 * referencia (lunes y martes, 09:00-17:00...)". The console and the demo now
 * run on `fixtures/demoSalonVenue.ts`, whose venue profile closes on Mondays — so
 * the assistant was stating business hours that contradicted the very calendar
 * shown on the screen next to it.
 *
 * Availability belongs to `calendar/resolveAvailability.ts`, which knows the
 * real windows and offers genuine alternatives. These tests keep the words from
 * competing with it.
 */

/**
 * Every phrase the catalogue can produce, rendered with neutral params.
 *
 * The keys come from `ES` itself rather than a separate list: `es.ts` is typed
 * `Record<PhraseKey, ...>`, so `tsc` already guarantees the two agree, and
 * reading them here means a phrase added tomorrow is covered without anyone
 * remembering to register it.
 */
function allRenderedPhrases(): { key: string; text: string }[] {
  return (Object.keys(ES) as PhraseKey[]).map((key) => {
    const render = ES[key] as (params?: Record<string, unknown>) => string;
    // Neutral params: enough to satisfy the interpolating keys without
    // smuggling a weekday or an hour in through the test itself.
    const text = render({ serviceId: 1, day: "", time: "", employeeId: 3 });
    return { key, text };
  });
}

describe("honesty rule 4: no phrase recites concrete opening days or hours", () => {
  const WEEKDAYS = /\b(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\b/i;
  // A clock time such as "09:00" or "17:30" — including the en-dash ranges the
  // old wording used.
  const CLOCK_TIME = /\b\d{1,2}[:.]\d{2}\b/;

  it("no phrase names a day of the week", () => {
    const offenders = allRenderedPhrases()
      .filter(({ text }) => WEEKDAYS.test(text))
      .map(({ key, text }) => `${key}: ${text}`);

    expect(offenders).toEqual([]);
  });

  it("no phrase states a clock time", () => {
    const offenders = allRenderedPhrases()
      .filter(({ text }) => CLOCK_TIME.test(text))
      .map(({ key, text }) => `${key}: ${text}`);

    expect(offenders).toEqual([]);
  });

  it("no phrase claims a weekly opening pattern in words either", () => {
    // Catches a future rewrite that dodges the two regexes above by saying
    // "abrimos de lunes a viernes" in some other spelling, or by naming the
    // break the old ASK_TIME advertised.
    const offenders = allRenderedPhrases()
      .filter(({ text }) => /\babrimos\b|\bcon pausa de\b|\bhorario de referencia\b/i.test(text))
      .map(({ key, text }) => `${key}: ${text}`);

    expect(offenders).toEqual([]);
  });

  it("the two questions that used to recite the schedule still ask their question", () => {
    // Removing a false claim must not leave a phrase that asks nothing.
    expect(ES.ASK_DATE()).toContain("¿");
    expect(ES.ASK_DATE().toLowerCase()).toContain("día");
    expect(ES.ASK_TIME()).toContain("¿");
    expect(ES.ASK_TIME().toLowerCase()).toContain("hora");
  });

  it("the out-of-schedule phrase still offers to look elsewhere, without naming when", () => {
    const phrase = ES.REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE();
    expect(phrase.toLowerCase()).toContain("otro día");
    expect(WEEKDAYS.test(phrase)).toBe(false);
    expect(CLOCK_TIME.test(phrase)).toBe(false);
  });
});
