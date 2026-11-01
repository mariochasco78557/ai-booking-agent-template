/**
 * *** THE SPOKEN SENTENCES OF THE BALANCED V2 FLOW. ***
 *
 * The V2 script is not a paraphrase of the V1 one. It answers a different
 * question — "which HOURS does the salon have", not "which hours does this
 * barber have" — and its wording was specified word for word, because each
 * variant makes a different factual claim to the caller:
 *
 * - "También tengo otros horarios" is only true when more than three unique
 *   hours exist. Saying it with exactly three would invite a fourth request
 *   that has nothing behind it.
 * - "Solo me quedan las diez y las once" is a claim about THE WHOLE SALON on
 *   that day, in that band, for that service — not about one barber's diary.
 *   It is built from the deduplicated union of every eligible barber's free
 *   hours (`src/services/balanced/balancedAvailabilityService.ts`), which is
 *   the only construction that makes the word "solo" honest.
 * - The morning/afternoon fallback names BOTH bands out loud, so a caller who
 *   asked for the morning is never quietly given the afternoon.
 * - "Y aún tengo alguna más" is the SAME promise about inventory, made on a
 *   second or third page, and it is true for the same reason: it is read off
 *   the frozen ranking the continuation is walking, never guessed.
 * - "Ya no me quedan más horas esa mañana" is the sentence the production
 *   agent could not say — it gave up instead, and the caller hung up. It is
 *   deterministic and it always names a way forward.
 *
 * *** NO BARBER IS EVER NAMED HERE. ***
 *
 * That is the defining property of the V2 discovery step and it is enforced
 * structurally: none of these builders takes an employee, so there is no
 * parameter through which a name could reach a spoken option list. The
 * professional is revealed exactly once, by the LOCK step, in the final
 * summary the agent reads before confirming.
 */

import {
  joinSpokenEs,
  spokenDateEs,
  spokenDayOfMonthEs,
  spokenTimeEs,
  spokenWeekdayAndDayEs,
} from "./spokenTimeEs.js";
import { monthNameEs, parseDateTime, weekdayEs, weekdayNameEs } from "./dateFormatterEs.js";
import { serviceLabel, t } from "../core/texts/texts.js";
import type { FechaResolution } from "./dayName.js";

/**
 * «las diez», but «la una»: the one hour whose Spanish article is singular.
 *
 * Only the sentences that name a single boundary hour on its own — «hasta
 * la una y media» — need this. Every list built with `joinSpokenEs`
 * (`"a las diez, a las once…"`) already carries its article from the
 * template around it and is left exactly as it was.
 */
function articledSpokenTimeEs(hhmm: string): string {
  const spoken = spokenTimeEs(hhmm);
  return spoken.startsWith("una") ? `la ${spoken}` : `las ${spoken}`;
}

/** Which half of the day an answer is about. */
export type TimePeriod = "morning" | "afternoon";

/** The Spanish noun for a band, as it appears mid-sentence. */
export function periodLabelEs(period: TimePeriod): string {
  return period === "morning" ? "mañana" : "tarde";
}

/** The other half of the day. */
export function oppositePeriod(period: TimePeriod): TimePeriod {
  return period === "morning" ? "afternoon" : "morning";
}

/**
 * What the agent says when it has options to offer.
 *
 * @param times      `HH:mm` labels of the options, in the order they will be
 *                   numbered 1, 2, 3.
 * @param hasMore    True when the salon has MORE unique compatible hours than
 *                   the three being offered. Only then may the sentence say so.
 * @param requested  The band the caller actually asked for.
 * @param offered    The band being answered with. When it differs from
 *                   `requested`, the sentence must say both — see above.
 * @param lastTime   `HH:mm` of the LATEST hour in the whole band, when the
 *                   service has it at hand (`discover` always does: it ranks
 *                   the band in full before paging it). Lets the "hay más"
 *                   promise name how far it goes — «hasta la una y media» —
 *                   instead of the vaguer "disponibles", which a caller who
 *                   had just been told "nada a partir de las seis" on a
 *                   different day read as an invitation to ask again blind.
 *                   Undefined falls back to "disponibles", unchanged.
 */
export function balancedOptionsMessage(
  times: readonly string[],
  opts: { hasMore: boolean; requested: TimePeriod; offered: TimePeriod; lastTime?: string },
): string {
  const spoken = times.map(spokenTimeEs);
  if (spoken.length === 0) return BALANCED_NO_AVAILABILITY_MESSAGE;

  // The band flipped: the caller asked for one half of the day and the salon
  // has nothing there. Both halves are named, in that order, so the switch is
  // stated rather than performed silently.
  if (opts.offered !== opts.requested) {
    return (
      `Ese día no me queda ningún hueco por la ${periodLabelEs(opts.requested)}, ` +
      `pero por la ${periodLabelEs(opts.offered)} tengo a las ${joinSpokenEs(spoken)}. ` +
      `¿Cuál prefieres?`
    );
  }

  if (spoken.length === 1) {
    return `Ese día solo me queda un hueco a las ${spoken[0]}. ¿Te viene bien?`;
  }

  // More unique hours exist than the three on the table. "Te puedo ofrecer"
  // rather than "me quedan": the first is a selection, the second is an
  // inventory, and only the second would be false here.
  if (opts.hasMore) {
    const lastTime = given(opts.lastTime);
    const tail = lastTime === undefined ? "disponibles" : `hasta ${articledSpokenTimeEs(lastTime)}`;
    return (
      `Te puedo ofrecer a las ${joinSpokenEs(spoken, "a las ")}. ` +
      `También tengo otros horarios ${tail}. ¿Cuál prefieres?`
    );
  }

  // Exactly two or exactly three, and those are all there is. "Solo" is only
  // spoken for two, matching the specified wording: three reads as a normal
  // offer, two reads as a shortage worth flagging.
  const lead = spoken.length === 2 ? "Ese día solo me quedan" : "Ese día me quedan";
  return `${lead} las ${joinSpokenEs(spoken, "las ")}. ¿Cuál prefieres?`;
}

/**
 * *** THE CONTINUATION SENTENCE — «otros horarios», actually answered. ***
 *
 * A separate builder from `balancedOptionsMessage`, not a flag on it, because
 * the two make different claims and the difference is audible. The first
 * sentence of a call introduces the salon's hours; this one continues a list
 * the caller has already heard part of, so it must say "también" and "después
 * de esas" — a caller re-read "Ese día me quedan…" would reasonably think the
 * first three had been withdrawn.
 *
 * `hasMore` is the same promise it is above, and it is honest for the same
 * reason: it is computed from the frozen ranking's remaining length, not from
 * an optimistic guess.
 *
 * @param times   `HH:mm` of THIS page, in the order they are numbered.
 * @param hasMore True when a further page really exists after this one.
 */
export function balancedMoreOptionsMessage(
  times: readonly string[],
  opts: { hasMore: boolean },
): string {
  const spoken = times.map(spokenTimeEs);
  // Defensive only: the service answers `no_more_options` for an empty page and
  // never reaches here, but a sentence builder must not be able to speak «a las
  // .» mid-call.
  if (spoken.length === 0) return BALANCED_NO_AVAILABILITY_MESSAGE;

  if (opts.hasMore) {
    return (
      `Te puedo ofrecer también a las ${joinSpokenEs(spoken, "a las ")}. ` +
      `Y aún tengo alguna más. ¿Cuál prefieres?`
    );
  }

  if (spoken.length === 1) {
    return `Después de esas solo me queda una a las ${spoken[0]}. ¿Te viene bien?`;
  }

  return `Después de esas solo me quedan las ${joinSpokenEs(spoken, "las ")}. ¿Cuál prefieres?`;
}

/**
 * *** THE CALLER NAMED AN HOUR — ANSWER THAT HOUR FIRST. ***
 *
 * Incident 2026-09-15: the caller said «seis y cuarto» three times and heard
 * three more pages of the afternoon, because the answer to a named hour only
 * re-ranked the list and never said whether THAT hour was possible. This
 * sentence always does, before offering anything:
 *
 * - `exact`: the named hour is free and is the only option on the page —
 *   «Sí, a las seis tengo hueco. ¿Te viene bien?»
 * - otherwise: a plain «no» about the named hour, then the nearest real slots
 *   (one each side when both exist) as a choice — «A las seis y cuarto no
 *   tengo hueco; lo más cercano que tengo es a las seis o a las seis y media.»
 *
 * The named hour may be a quarter («seis y cuarto») because it is the caller's
 * own; the OFFERED hours are always real agenda slots, never invented.
 *
 * @param preferred `HH:mm` the caller named.
 * @param times     `HH:mm` of the page, in the order they are numbered.
 */
export function balancedPreferredTimeMessage(
  preferred: string,
  times: readonly string[],
  opts: { exact: boolean; employeeName?: string },
): string {
  if (times.length === 0) return BALANCED_NO_AVAILABILITY_MESSAGE;
  const at = (hhmm: string): string => `a ${articledSpokenTimeEs(hhmm)}`;
  const question = times.length === 1 ? "¿Te viene bien?" : "¿Cuál prefieres?";

  // V5 only (ADR-027): the caller named a professional for this hour. The
  // sentence says whose hour it is, so «con Bruno a las cinco y media» is never
  // answered with a bare «sí» that could be heard as «with whoever». A V4
  // request never passes `employeeName`, so its sentences are unchanged.
  if (opts.employeeName !== undefined) {
    const who = opts.employeeName;
    if (opts.exact) {
      return `Sí, ${at(preferred)} tengo hueco con ${who}. ¿Te viene bien?`;
    }
    return (
      `${capitalizeFirst(at(preferred))} ${who} no tiene hueco; ` +
      `con ${who}, lo más cercano es ${joinAlternativesEs(times.map(at))}. ${question}`
    );
  }

  if (opts.exact) {
    return `Sí, ${at(preferred)} tengo hueco. ¿Te viene bien?`;
  }
  return (
    `${capitalizeFirst(at(preferred))} no tengo hueco; ` +
    `lo más cercano que tengo es ${joinAlternativesEs(times.map(at))}. ${question}`
  );
}

/**
 * The band is walked out: every hour it had has already been offered.
 *
 * It must be DETERMINISTIC and it must leave a way forward, because this is the
 * exact point at which the production agent gave up ("no puedo mostrarte más
 * opciones directamente") and the caller hung up. Two doors are always named:
 * the other half of the day, or another day.
 *
 * @param offeredPeriod             The band that was actually walked.
 * @param fallbackAlreadyHappened   True when that band was ALREADY the
 *   fallback — the caller asked for the other one and it was empty. Offering
 *   it again would be offering a band the middleware has already declined, so
 *   the sentence speaks about the day instead.
 */
export function balancedNoMoreOptionsMessage(
  offeredPeriod: TimePeriod,
  opts: { fallbackAlreadyHappened: boolean },
): string {
  if (opts.fallbackAlreadyHappened) {
    return "Ya no me quedan más horas ese día. ¿Quieres que mire otro día?";
  }
  return (
    `Ya no me quedan más horas esa ${periodLabelEs(offeredPeriod)}. ` +
    `¿Quieres que mire por la ${periodLabelEs(oppositePeriod(offeredPeriod))} ` +
    `o que pruebe otro día?`
  );
}

/** Nothing free that day, in either band, for that service. */
export const BALANCED_NO_AVAILABILITY_MESSAGE =
  "Ese día no me queda ningún hueco disponible. ¿Quieres que mire otro día?";

/** The weekday opens in the morning only (early close): the afternoon was asked for. */
export const BALANCED_CLOSED_AFTERNOON_MESSAGE = t("balanced.cerrado_tarde");

/**
 * The salon is closed that whole day (`BalancedAvailabilityService.isClosedDay`,
 * env `BALANCED_CLOSED_WEEKDAYS`). Answered WITHOUT reading the upstream
 * agenda for that day — a closed day is a fact about the calendar, not the
 * diary. Since the look-ahead (`balancedLookAheadMessage`) it is the FALLBACK:
 * spoken only when the following days could not be read, so it proposes no day
 * itself. See `docs/elevenlabs/AGENT_PROMPT_BALANCED_V2_ES.md`.
 */
export const BALANCED_CLOSED_DAY_MESSAGE = t("balanced.cerrado_dia");

/**
 * A `scan` window whose every day is closed (e.g. `days: 2` starting on a
 * Sunday). Answered immediately, with zero upstream calls, for the same
 * reason `BALANCED_CLOSED_DAY_MESSAGE` is.
 */
export const BALANCED_SCAN_ALL_CLOSED_MESSAGE = t("balanced.cerrado_varios_dias");

/**
 * *** THE DISCOVER LOOK-AHEAD — NEVER A BARE «NO TENGO». ***
 *
 * When the day the caller named has nothing (every hour booked, or the salon
 * is closed that weekday), `discover` itself reads the following days and
 * answers the way a receptionist would: what is wrong with the day asked for,
 * then the NEAREST real day with hours in the same band, as an open question.
 *
 * The day proposed is the server's, never the model's: it comes from an agenda
 * read, and the hours are that day's real slots in page order (`option_index`
 * 1, 2, 3), spoken as alternatives with «o».
 *
 * Only two variants are fallbacks, and neither is this builder: when the
 * look-ahead could not be read (failure, deadline, an unread nearer day) the
 * service answers the OLD sentences (`BALANCED_NO_AVAILABILITY_MESSAGE` /
 * `BALANCED_CLOSED_DAY_MESSAGE`), because naming a day as «lo más cercano»
 * without having read the days before it would be a claim nobody checked.
 *
 * @param opts.reason         `"closed"` — the requested weekday is a closure
 *                            day; `"full"` — it is open and has no free hour.
 * @param opts.requestedDate  `YYYY-MM-DD` the caller asked for.
 * @param opts.offeredDate    `YYYY-MM-DD` of the nearest day with hours.
 * @param opts.times          `HH:mm` of the page, in the order numbered.
 */
export function balancedLookAheadMessage(opts: {
  reason: "closed" | "full";
  requestedDate: string;
  offeredDate: string;
  times: readonly string[];
  /** The weekday is open in the morning and only the afternoon is closed. */
  afternoonOnly?: boolean;
}): string {
  if (opts.times.length === 0) {
    return opts.reason === "closed"
      ? opts.afternoonOnly === true
        ? BALANCED_CLOSED_AFTERNOON_MESSAGE
        : BALANCED_CLOSED_DAY_MESSAGE
      : BALANCED_NO_AVAILABILITY_MESSAGE;
  }
  const lead =
    opts.reason === "closed"
      ? `${closedWeekdayLeadEs(opts.requestedDate, opts.afternoonOnly)}`
      : `${capitalizeFirst(spokenWeekdayAndDayEs(opts.requestedDate))} no me queda hueco`;
  const hours = joinAlternativesEs(opts.times.map((time) => `a ${articledSpokenTimeEs(time)}`));
  const question =
    opts.times.length === 1 ? "¿Te va bien, o te busco otro día?" : "¿Te va bien alguna, o te busco otro día?";
  return `${lead}; lo más cercano es ${spokenWeekdayAndDayEs(opts.offeredDate)} ${hours}. ${question}`;
}

/**
 * 2026-10-09 — WhatsApp (owner's rule): the day the customer asked for has
 * nothing, so the agent SAYS SO AND ASKS before looking at — let alone
 * offering — any other day. «El jueves quince no me queda hueco. ¿Quieres que
 * te mire otro día?»; for a closed weekday, «Los lunes cerramos. ¿…?».
 */
export function balancedAskOtherDayMessage(opts: {
  reason: "closed" | "full";
  requestedDate: string;
  afternoonOnly?: boolean;
}): string {
  const lead =
    opts.reason === "closed"
      ? closedWeekdayLeadEs(opts.requestedDate, opts.afternoonOnly)
      : `${capitalizeFirst(spokenWeekdayAndDayEs(opts.requestedDate))} no me queda hueco`;
  return `${lead}. ¿Quieres que te mire otro día?`;
}

/**
 * The look-ahead read every open day of the following week and NONE has an
 * hour in the requested band. Still an open door, never a dead end: the week
 * after, and — only when the look-ahead actually saw hours there — the other
 * band. Offering a band that is also empty would be a door onto nothing.
 *
 * @param opts.reason         As in {@link balancedLookAheadMessage}.
 * @param opts.requestedDate  `YYYY-MM-DD` the caller asked for.
 * @param opts.period         The band that was searched.
 * @param opts.otherPeriodHasHours True when some day read has an hour in the
 *                            OTHER band.
 */
export function balancedLookAheadNothingMessage(opts: {
  reason: "closed" | "full";
  requestedDate: string;
  period: TimePeriod;
  otherPeriodHasHours: boolean;
  /** The weekday is open in the morning and only the afternoon is closed. */
  afternoonOnly?: boolean;
}): string {
  const band = opts.otherPeriodHasHours ? ` por la ${periodLabelEs(opts.period)}` : "";
  const statement =
    opts.reason === "closed"
      ? `${closedWeekdayLeadEs(opts.requestedDate, opts.afternoonOnly)}, y en los próximos días no me queda hueco${band}.`
      : `${capitalizeFirst(spokenWeekdayAndDayEs(opts.requestedDate))} y los días siguientes no me queda hueco${band}.`;
  const question = opts.otherPeriodHasHours
    ? `¿Te busco la semana siguiente, o te va bien por la ${periodLabelEs(oppositePeriod(opts.period))}?`
    : "¿Te busco la semana siguiente?";
  return `${statement} ${question}`;
}

/**
 * *** EXTENDED LOOK-AHEAD (ADR-024; V5 requests only, ADR-025). ***
 *
 * The seven days after the requested one were ALL read and none has an hour in
 * the band, so the server kept reading days 8–14 and found the nearest real
 * day. Instead of «¿Te busco la semana siguiente?» — a door a caller may answer
 * with «ya llamaré» — the sentence names that day and its hours, and ends on an
 * open question so the booking can be closed in this call.
 *
 * «En los próximos días» rather than «esta semana»: the seven days read may
 * straddle two calendar weeks, and only the first claim is always true. The
 * band is named only when the first week actually had hours in the other band
 * (same rule as {@link balancedLookAheadNothingMessage}).
 *
 * @param opts.times `HH:mm` of the page, in the order numbered. Empty is
 *                   unreachable from the service; it answers the seven-day
 *                   sentence rather than speak «a las .».
 */
export function balancedExtendedLookAheadMessage(opts: {
  reason: "closed" | "full";
  requestedDate: string;
  period: TimePeriod;
  otherPeriodHasHours: boolean;
  offeredDate: string;
  times: readonly string[];
  /** The weekday is open in the morning and only the afternoon is closed. */
  afternoonOnly?: boolean;
}): string {
  if (opts.times.length === 0) return balancedLookAheadNothingMessage(opts);
  const band = opts.otherPeriodHasHours ? ` por la ${periodLabelEs(opts.period)}` : "";
  const statement =
    opts.reason === "closed"
      ? `${closedWeekdayLeadEs(opts.requestedDate, opts.afternoonOnly)}, y en los próximos días no me queda hueco${band}`
      : `${capitalizeFirst(spokenWeekdayAndDayEs(opts.requestedDate))} y los días siguientes no me queda hueco${band}`;
  return `${statement}; ${nearestDayOfferEs(opts.offeredDate, opts.times)}`;
}

/**
 * Extended look-ahead: fourteen days fully read, nothing in the band. Still an
 * open question, never a dead end and never WhatsApp: the other band only when
 * some day read actually had hours there, otherwise the caller is asked which
 * dates to look at.
 */
export function balancedLookAheadTwoWeeksNothingMessage(opts: {
  reason: "closed" | "full";
  requestedDate: string;
  period: TimePeriod;
  otherPeriodHasHours: boolean;
  /** The weekday is open in the morning and only the afternoon is closed. */
  afternoonOnly?: boolean;
}): string {
  const band = opts.otherPeriodHasHours ? ` por la ${periodLabelEs(opts.period)}` : "";
  const statement =
    opts.reason === "closed"
      ? `${closedWeekdayLeadEs(opts.requestedDate, opts.afternoonOnly)}, y en las próximas dos semanas no me queda hueco${band}.`
      : `${capitalizeFirst(spokenWeekdayAndDayEs(opts.requestedDate))} y en las dos semanas siguientes no me queda hueco${band}.`;
  const question = opts.otherPeriodHasHours
    ? `¿Te va bien por la ${periodLabelEs(oppositePeriod(opts.period))}, o prefieres que mire otras fechas?`
    : BALANCED_OTHER_DATES_QUESTION;
  return `${statement} ${question}`;
}

/** The open question when no other band or hour can honestly be offered. */
const BALANCED_OTHER_DATES_QUESTION = "¿Qué otras fechas quieres que mire?";

/**
 * «lo más cercano es el martes veintinueve a las cinco o a las cinco y media.
 * ¿Te va bien alguna, o te miro otro día?» — the shared tail of every extended
 * offer. The hours are the page's real slots, spoken as alternatives.
 */
function nearestDayOfferEs(offeredDate: string, times: readonly string[]): string {
  const hours = joinAlternativesEs(times.map((time) => `a ${articledSpokenTimeEs(time)}`));
  const question =
    times.length === 1 ? "¿Te va bien, o te miro otro día?" : "¿Te va bien alguna, o te miro otro día?";
  return `lo más cercano es ${spokenWeekdayAndDayEs(offeredDate)} ${hours}. ${question}`;
}

/** «Los lunes cerramos», «Los domingos cerramos» for a closed `YYYY-MM-DD`. */
function closedWeekdayLeadEs(dateIso: string, afternoonOnly = false): string {
  const parsed = parseDateTime(dateIso);
  if (parsed === null) return "Ese día cerramos";
  const weekday = weekdayEs(parsed);
  // Only «sábado» and «domingo» take an -s; lunes…viernes are invariant.
  const plural = weekday.endsWith("s") ? weekday : `${weekday}s`;
  // `afternoonOnly`: the weekday opens in the morning (early close, e.g. Saturday 14:00).
  // 2026-10-10: the day itself is named («El sábado diecisiete por la tarde
  // cerramos»), so the agent can never pin the closure on another weekday
  // (the call where «viernes 17» became «el viernes diecisiete no tengo hueco»).
  void plural;
  const day = capitalizeFirst(spokenWeekdayAndDayEs(dateIso));
  return afternoonOnly ? `${day} por la tarde cerramos` : `${day} cerramos`;
}

/**
 * 2026-10-11 — `own_booking_at_time` ((internal doc, not included in the template) §3):
 * the hour asked for is the customer's OWN standing appointment, so nothing is
 * offered or locked. WhatsApp names day, hour and professional; voice only the
 * professional (the caller hears no dates and no digits).
 */
export function balancedOwnBookingMessage(opts: {
  whatsApp: boolean;
  date: string;
  time: string;
  employeeName?: string | null;
}): string {
  const raw = opts.employeeName?.trim() ?? "";
  const who = raw === "" ? "" : ` con ${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
  const question = "¿Quieres cambiarle el servicio o prefieres otra hora?";
  if (!opts.whatsApp) return `A esa hora ya tienes tu cita${who}. ${question}`;
  const parsed = parseDateTime(opts.date);
  const day =
    parsed === null ? opts.date : `${weekdayEs(parsed)} ${parsed.day} de ${monthNameEs(parsed.month)}`;
  return `A esa hora ya tienes tu cita del ${day} a las ${opts.time}${who}. ${question}`;
}

/** «sábados», «martes»: only sábado and domingo take an -s. */
function pluralWeekdayEs(weekday: string): string {
  return weekday.endsWith("s") ? weekday : `${weekday}s`;
}

const WEEKS_WORDS_ES = ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis"] as const;

/**
 * 2026-10-11 — `scan` with `weekday`: that weekday is closed all day
 * («Los lunes cerramos…»). Zero reads.
 */
export function balancedScanWeekdayClosedMessage(weekday: string): string {
  return `Los ${pluralWeekdayEs(weekday)} cerramos. ¿Quieres que te mire otro día?`;
}

/**
 * 2026-10-11 — `scan` with `weekday` and an afternoon that is closed
 * («El sábado diecisiete por la tarde cerramos…»). The date is the first
 * of the window. Zero reads.
 */
export function balancedScanWeekdayAfternoonClosedMessage(firstDateIso: string): string {
  return `${closedWeekdayLeadEs(firstDateIso, true)}. ¿Quieres que te mire otro día?`;
}

/**
 * 2026-10-11 — `scan` with `weekday` and not one of its dates has an hour
 * that fits. Never proposes another weekday. `partial`: some date could not
 * be read in time, so only «los que he podido mirar» may be claimed.
 */
export function balancedScanWeekdayNoAvailabilityMessage(opts: {
  weekday: string;
  weeks: number;
  partial: boolean;
}): string {
  const plural = pluralWeekdayEs(opts.weekday);
  if (opts.partial) {
    return `En los ${plural} que he podido mirar no me queda hueco a esa hora. ¿Te miro esos ${plural} a otra hora?`;
  }
  if (opts.weeks <= 1) {
    return `El próximo ${opts.weekday} no me queda hueco a esa hora. ¿Te miro ese ${opts.weekday} a otra hora?`;
  }
  const count = WEEKS_WORDS_ES[opts.weeks] ?? String(opts.weeks);
  return `Los próximos ${count} ${plural} no me queda hueco a esa hora. ¿Te miro esos ${plural} a otra hora?`;
}

/**
 * The hour the caller chose is gone between the offer and the lock.
 *
 * Distinct from `SLOT_TAKEN_MESSAGE` because nothing has been attempted yet:
 * this is a re-check that came back empty, not a write that was refused, and
 * the caller should hear an invitation rather than an apology for a failure.
 */
export const BALANCED_SLOT_TAKEN_MESSAGE =
  "Vaya, esa hora acaba de ocuparse. ¿Quieres que te diga las que me quedan?";

/**
 * The caller asked for a specific professional at the hour already chosen,
 * and that professional is not free at it.
 *
 * The sentence must leave BOTH doors open — keep the assigned professional at
 * this hour, or keep the requested professional at another hour — because the
 * middleware genuinely supports both and a sentence that offered only one
 * would make the other unreachable through the agent.
 */
export function balancedEmployeeUnavailableMessage(
  requestedName: string | undefined,
  assignedName: string,
  time: string,
): string {
  const who = requestedName === undefined ? "ese profesional" : requestedName;
  return (
    `A las ${spokenTimeEs(time)} ${who} no tiene hueco. ` +
    `Puedo dejarte esa hora con ${assignedName}, o mirarte otro horario con ${who}. ` +
    `¿Qué prefieres?`
  );
}

/**
 * The option number the agent sent does not exist in this conversation — it
 * expired, it belongs to another call, or it was never offered.
 *
 * Deliberately identical in tone to `SLOT_NOT_AUTHORIZED_MESSAGE`: from the
 * caller's side nothing has gone wrong, the hours simply have to be looked up
 * again before one can be taken. It sends the agent back to `discover`, which
 * is the only place an option can come from.
 */
export const BALANCED_OPTION_UNKNOWN_MESSAGE =
  "Necesito volver a mirar la agenda para darte las horas que quedan. ¿Qué día te viene bien?";

/**
 * 2026-10-09 (call r3557a) — a `lock` that said WHAT it meant to lock
 * (`option_time`, optionally `option_date`) and the most recent page holds no
 * such option: a later `discover` replaced the list the agent was thinking of.
 * Nothing was locked. Addressed to the AGENT, not to be read aloud: it names
 * the exact `HH:mm` so the next call is a `discover` with that `preferred_time`.
 */
export function balancedLockMismatchMessage(time?: string, date?: string): string {
  if (time === undefined) {
    return (
      `Ese día (${date ?? "?"}) no está en la última búsqueda y no he fijado nada. ` +
      `Consulta otra vez la disponibilidad de ese día y fija la opción que salga.`
    );
  }
  const day = date === undefined ? "" : ` del ${date}`;
  return (
    `Esa hora (${time}${day}) no está en la última búsqueda y no he fijado nada. ` +
    `Consulta otra vez la disponibilidad para las ${time}${date === undefined ? "" : " de ese día"} ` +
    `y fija la opción que salga.`
  );
}

/** `"19:00"` -> `"siete de la tarde"`; the half of the day is always said,
 * because the mistake this guards against is precisely 07:00 for 19:00. */
function spokenHourWithPeriodEs(hhmm: string): string {
  const hour = Number(hhmm.slice(0, 2));
  const period = hour < 12 ? "de la mañana" : hour < 14 ? "del mediodía" : "de la tarde";
  return `${articledSpokenTimeEs(hhmm)} ${period}`;
}

/** `"2026-10-13"` -> `"martes trece"` (without the article). */
function weekdayAndDayNoArticleEs(dateIso: string): string {
  return spokenWeekdayAndDayEs(dateIso).replace(/^el /, "");
}

/**
 * 2026-10-09 (escaneo, hallazgo 1) — a `create` that said WHICH hour it is
 * confirming (`option_time`, optionally `option_date`) while its slot token
 * holds another one: typically a later lock failed, the server kept the
 * previous lock, and the summary was read with the new hour. NOTHING was
 * created. Spoken to the customer as is; both hours carry their half of the day.
 *
 * @param locked    the slot of the token, `HH:mm` and `YYYY-MM-DD`.
 * @param requested what the create said; at least one field is set.
 */
export function balancedBookTimeMismatchMessage(
  locked: { time: string; date: string },
  requested: { time?: string; date?: string },
): string {
  const lockedHour = spokenHourWithPeriodEs(locked.time);
  if (requested.date !== undefined && requested.date !== locked.date) {
    const otherHour =
      requested.time !== undefined ? ` a ${spokenHourWithPeriodEs(requested.time)}` : "";
    return (
      `La cita que tengo apartada es la del ${weekdayAndDayNoArticleEs(locked.date)} a ${lockedHour}, ` +
      `no la del ${weekdayAndDayNoArticleEs(requested.date)}${otherHour}. Confírmame cuál quieres.`
    );
  }
  const otherHour = spokenHourWithPeriodEs(requested.time ?? locked.time);
  return `La hora que tengo apartada es la de ${lockedHour}, no la de ${otherHour}. Confírmame cuál quieres.`;
}

/**
 * The agent sent something the contract cannot read at all.
 *
 * It answers HTTP 200 like every other refusal in this flow — a tool error is
 * exactly when a model starts improvising, and here improvising means inventing
 * an hour. See `src/routes/balancedV2.ts`.
 */
export const BALANCED_INVALID_REQUEST_MESSAGE =
  "No he podido consultar la agenda con esos datos. ¿Me confirmas el día y si lo prefieres por la mañana o por la tarde?";

/**
 * *** THE V2 FAILURE SENTENCES — SHORT, HONEST, AND PROMISING NOTHING. ***
 *
 * The V1 file `src/utils/phrasing.ts` is NOT touched by any of this, and the
 * constants below are not paraphrases of it: they exist because the V1 wording
 * makes promises the V2 agent is forbidden to make.
 *
 * V1 says «…o que te llamen desde la peluquería», «se pondrá en contacto
 * contigo», «Te recomiendo confirmarla directamente con la peluquería»,
 * «Te recomiendo llamar directamente a la peluquería». Every one of those
 * commits a human being to an action this middleware neither performs nor
 * observes: nobody is queued to call back, no message reaches Bruno, and the
 * salon's phone is the very line the caller is already on. A voice agent that
 * says them is inventing an outcome, which is the same class of fault as
 * inventing an hour.
 *
 * *** THE WAY OUT IS NOT IN THE MIDDLEWARE. ***
 *
 * The WhatsApp exit («Escríbenos por WhatsApp a este mismo número…») belongs to
 * the AGENT PROMPT, not here. It is a platform-level decision about how the owner's
 * salon handles what an agent cannot finish, it is a different sentence in a
 * different register, and the moment to say it depends on the conversation, not
 * on the outcome of one tool call. These constants therefore state ONE fact
 * each — what did not happen — and stop. The prompt decides what comes next.
 *
 * V1 and V2 are two live agents on one deployment. Anything shared between
 * `/ai/voice/*` and `/ai/voice/v2/*` is a sentence the production agent is
 * already speaking, so the V2 wording lives HERE, in the V2 layer, and changes
 * to it can never reach the agent currently taking real calls.
 */

/**
 * The salon's diary could not be read at all — for `discover`, `more` or
 * `lock`.
 *
 * The V1 sentence appends «¿Prefieres que lo intentemos en un momento o que te
 * llamen desde la peluquería?». The second half is a promise of a call back;
 * the first half invites the model to retry a tool that just failed. Neither
 * belongs in a V2 answer, so both are gone.
 */
export const BALANCED_AGENDA_UNAVAILABLE_MESSAGE =
  "Ahora mismo no puedo consultar la agenda.";

/**
 * `lock` found the hour, found it free, and could not authorize it —
 * `VOICE_SLOT_TOKEN_SECRET` is absent, or the date cannot be sealed exactly.
 *
 * It used to answer `BALANCED_OPTION_UNKNOWN_MESSAGE` («Necesito volver a mirar
 * la agenda…»), which is the sentence for an option this call does not hold.
 * That is a LIE about the cause and, worse, an instruction: it sends the agent
 * back to `discover`, which re-offers the same hour, which is locked again,
 * which fails again. A deployment with no secret would loop until the caller
 * hung up. This sentence names the real state and invites nothing.
 */
export const BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE =
  "Ahora mismo no puedo dejar esa hora apartada.";

/**
 * `/ai/voice/v2/book` — the write neither clearly succeeded nor clearly
 * failed (`outcome: "uncertain"`, step CTL-3).
 *
 * The one fact the caller needs is that the appointment is NOT confirmed from
 * this side. The V1 version adds «el equipo de la peluquería lo revisará y se
 * pondrá en contacto contigo», which is a promise about people. It is removed
 * and not replaced: a retry is still forbidden (a second write can duplicate an
 * appointment that may already exist), and the prompt supplies the way out.
 */
export const BALANCED_BOOKING_UNCERTAIN_MESSAGE =
  "No he podido confirmar si la cita ha quedado hecha. Por mi parte no está confirmada.";

/** `outcome: "write_disabled"` — booking by phone is switched off here.
 * Deterministic, nothing was written, and «confirmarla directamente con la
 * peluquería» is not something this agent may recommend. */
export const BALANCED_WRITE_DISABLED_MESSAGE =
  "Ahora mismo no puedo dejar la cita hecha. No ha quedado confirmada.";

/** `outcome: "already_booked_in_call"` — one appointment per call. It names
 * THIS call, so «llamada» here is a fact about the conversation in progress,
 * not a promise that anyone will call. */
export const BALANCED_ALREADY_BOOKED_MESSAGE =
  "En esta llamada ya hay una cita hecha. No puedo hacer otra desde aquí.";

/**
 * V5 ((internal doc, not included in the template) ADR-023) — `outcome: "already_booked_in_call"` with
 * `booking_limit_reached: true`: the call already has the maximum number of
 * confirmed appointments a V5 request allows (`BALANCED_V5_MAX_BOOKINGS_PER_CALL`,
 * 2 or 3; ADR-025).
 *
 * Only ever produced for a V5 request with that limit above one, so the V4
 * sentence above is still the only one a V4 request can hear. Like it, «llamada»
 * names the call in progress and promises no call from anyone; the way out
 * (WhatsApp, or calling again) is the prompt's.
 */
export function balancedBookingLimitMessage(maxBookings: number): string {
  const count = maxBookings === 2 ? "dos" : "tres";
  return `En esta llamada ya hay ${count} citas hechas, que es el máximo por llamada. No puedo hacer otra desde aquí.`;
}

/**
 * V5 (ADR-023) — `outcome: "already_booked_in_call"` with
 * `booking_limit_reached: false`: the `slot_token` sent already produced a
 * confirmed appointment in this call, and the request is NOT an identical
 * retry of it (different name or phone). Nothing was written. The new
 * appointment needs its own hour, locked and confirmed; that recovery is the
 * prompt's.
 */
/** The opening the shared confirmation sentence (`bookingConfirmedMessage`) has. */
const SHARED_CONFIRMED_OPENING = "Perfecto, ";

/**
 * V5 only (ADR-027): the confirmed-booking sentence without «Perfecto».
 *
 * The prompt forbids opening a turn with «Perfecto», yet the shared
 * `bookingConfirmedMessage` — used by V1 and V4 too, and so left untouched —
 * starts with it, and the agent echoed it in 10 of 11 closes on 2026-09-16
 * («Perfecto, ya está todo listo…»). A V5 create answer swaps only that
 * opening: «Listo, la reserva queda confirmada para el …». Any other sentence
 * is returned unchanged.
 */
export function balancedV5ConfirmedMessage(message: string): string {
  return message.startsWith(SHARED_CONFIRMED_OPENING)
    ? `Listo, ${message.slice(SHARED_CONFIRMED_OPENING.length)}`
    : message;
}

export const BALANCED_SLOT_ALREADY_BOOKED_IN_CALL_MESSAGE =
  "Esa hora ya ha quedado reservada en esta llamada. Para la cita nueva tengo que apartar otra hora.";

/** `outcome: "upstream_error"` and `outcome: "misconfigured_owner"` — the write
 * was refused deterministically. Both collapse into one sentence because the
 * DIFFERENCE is operational: it belongs in the log, and telling a caller which
 * of our systems is at fault only invites a retry. */
export const BALANCED_BOOKING_FAILED_MESSAGE =
  "No he podido hacer la cita. No ha quedado confirmada.";

/**
 * *** WHICH BOOKING OUTCOMES GET A V2 SENTENCE, IN ONE PLACE. ***
 *
 * `/ai/voice/v2/book` reuses `VoiceBookingService` WHOLE — the slot check, the
 * identity check, the confirmation gate, the idempotency journal and the
 * single-write rule are one implementation for both agents, and duplicating
 * them to change five sentences would be trading a wording problem for a
 * correctness one. So the route overrides the `message` FIELD of the outcomes
 * whose V1 wording promises contact, and leaves every other field — `booked`,
 * `outcome`, `external_mutation`, `mutation_status`, `idempotency_status` —
 * exactly as the shared service produced it.
 *
 * Outcomes deliberately ABSENT from this table keep their V1 sentence because
 * that sentence already promises nothing: `confirmed`, `slot_taken`,
 * `not_confirmed`, `invalid_customer_data`, `invalid_slot_token`,
 * `slot_token_expired` and `slot_not_authorized`.
 */
export const BALANCED_BOOK_MESSAGE_OVERRIDES: Readonly<Record<string, string>> = {
  uncertain: BALANCED_BOOKING_UNCERTAIN_MESSAGE,
  write_disabled: BALANCED_WRITE_DISABLED_MESSAGE,
  already_booked_in_call: BALANCED_ALREADY_BOOKED_MESSAGE,
  upstream_error: BALANCED_BOOKING_FAILED_MESSAGE,
  misconfigured_owner: BALANCED_BOOKING_FAILED_MESSAGE,
};

/**
 * The summary the agent reads before confirming — the FIRST moment a
 * professional is named in the V2 flow.
 *
 * Built here rather than left to the prompt so the four facts it asserts
 * (service, day, hour, professional) come from the locked slot instead of from
 * the model's memory of the conversation.
 */
export function balancedLockedMessage(
  reservationDate: string,
  employeeName: string,
): string {
  // 2026-10-10: with the day and the half of the day, never a bare hour.
  const time = reservationDate.slice(11, 16);
  return `Te lo dejo ${spokenWeekdayAndDayEs(reservationDate.slice(0, 10))} a ${spokenHourWithPeriodEs(time)} con ${employeeName}.`;
}


/**
 * 2026-10-10 — THE SUMMARY IS WRITTEN BY THE SERVER, from the slot it just
 * locked: «Te resumo: corte de pelo, el viernes dieciséis de octubre a las
 * seis de la tarde, con Ramón». No final period: the agent appends «, a
 * nombre de …, a este número. ¿Lo confirmo así?» (the only parts the server
 * does not know). The date is the token's date, so the summary and the
 * booking the token can create are the same appointment by construction.
 */
export function balancedLockSummaryEs(opts: {
  serviceId: number;
  reservationDate: string;
  employeeName: string;
}): string {
  const date = opts.reservationDate.slice(0, 10);
  const time = opts.reservationDate.slice(11, 16);
  // The services as the summary says them: `servicios[].etiquetas.voz` (D-010).
  const service = serviceLabel(opts.serviceId, "voz");
  return (
    `Te resumo: ${service === undefined ? "" : `${service}, `}` +
    `${spokenWeekdayAndDayEs(date)} de ${monthOfEs(date)} a ${spokenHourWithPeriodEs(time)}, ` +
    `con ${opts.employeeName}`
  );
}

/**
 * 2026-10-10 — an existing appointment named in full, for the voice listing:
 * «el sábado diez de octubre a las nueve y media de la mañana».
 * `at` is `YYYY-MM-DD HH:mm[:ss]`.
 */
export function spokenAppointmentEs(at: string): string {
  const date = at.slice(0, 10);
  const month = monthOfEs(date);
  return `${spokenWeekdayAndDayEs(date)}${month === "" ? "" : ` de ${month}`} a ${spokenHourWithPeriodEs(at.slice(11, 16))}`;
}

function monthOfEs(dateIso: string): string {
  const parsed = parseDateTime(dateIso);
  return parsed === null ? "" : monthNameEs(parsed.month);
}

/**
 * 2026-10-10 — the V5 create confirmation, in words: the shared sentence
 * «Perfecto, la reserva queda confirmada para el viernes 16 de octubre a las
 * 18:00.» becomes «Listo, la reserva queda confirmada para el viernes
 * dieciséis de octubre a las seis de la tarde.» Only the digits are turned
 * into words: the weekday, the day and the month are the ones the server
 * wrote from the booked date. Anything else goes through
 * {@link balancedV5ConfirmedMessage} unchanged.
 */
export function balancedConfirmedSpokenEs(message: string): string {
  const match =
    /^Perfecto, la reserva queda confirmada para el (\S+) (\d{1,2}) de (\S+) a las (\d{2}:\d{2})\.$/u.exec(message);
  if (match === null) return balancedV5ConfirmedMessage(message);
  const [, weekday, day, month, time] = match;
  return (
    `Listo, la reserva queda confirmada para el ${weekday} ${spokenDayOfMonthEs(Number(day))} ` +
    `de ${month} a ${spokenHourWithPeriodEs(time!)}.`
  );
}

/**
 * 2026-10-10 (saludo y cierre de Bruno) — the cancellation reminder, said once
 * per call, after the first booking. Changing and cancelling are possible by
 * phone too, so both ways are named.
 */
export const BALANCED_CLOSING_REMINDER_ES =
  "Si necesitas cambiarla o anularla, llámanos o escríbenos por WhatsApp, con al menos una hora de antelación.";

/**
 * 2026-10-10 (saludo y cierre de Bruno) — the voice closing of a V5 create,
 * in Bruno's line («Listo ✅ [día] a las [hora] con [profesional]»), spoken:
 * «Listo, cita confirmada: el viernes dieciséis de octubre a las seis de la
 * tarde con Olga. Si necesitas cambiarla o anularla, llámanos o escríbenos por
 * WhatsApp, con al menos una hora de antelación.»
 *
 * Every fact comes from the server: the day and the hour from the booked
 * date (the shared sentence), the barber from the name the lock recorded
 * (`employee_name`; absent = nobody is named). `reminder` false (a later
 * booking of the same call) leaves the reminder out. Any other sentence (a
 * change, a replay of something else) goes through
 * {@link balancedConfirmedSpokenEs} unchanged.
 */
export function balancedConfirmedClosingEs(
  message: string,
  opts: { employeeName?: string; reminder: boolean },
): string {
  const match =
    /^Perfecto, la reserva queda confirmada para el (\S+) (\d{1,2}) de (\S+) a las (\d{2}:\d{2})\.$/u.exec(message);
  if (match === null) return balancedConfirmedSpokenEs(message);
  const [, weekday, day, month, time] = match;
  const name = opts.employeeName?.trim();
  return (
    `Listo, cita confirmada: el ${weekday} ${spokenDayOfMonthEs(Number(day))} de ${month} ` +
    `a ${spokenHourWithPeriodEs(time!)}${name ? ` con ${name}` : ""}.` +
    (opts.reminder ? ` ${BALANCED_CLOSING_REMINDER_ES}` : "")
  );
}

/**
 * 2026-10-10 — «el viernes dieciséis», plus « de noviembre» when the day is
 * not in today's month (a bare «el 5» on the 10th is next month's 5th, and
 * the customer must hear which month).
 */
export function spokenDayFullEs(dateIso: string, todayIso: string): string {
  const named = spokenWeekdayAndDayEs(dateIso);
  return differentMonth(dateIso, todayIso) ? `${named} de ${monthOfEs(dateIso)}` : named;
}

function differentMonth(dateIso: string, todayIso: string): boolean {
  return dateIso.slice(0, 7) !== todayIso.slice(0, 7);
}

/**
 * 2026-10-10 — `outcome: "date_conflict"`: the customer's words about the day
 * do not name one bookable date. Nothing was searched. The agent reads this
 * and waits for the answer.
 *
 * «El dieciséis es viernes. ¿Te lo busco el viernes dieciséis o el jueves quince?»
 */
/** 2026-10-10 — `fecha_dicha` that cannot be read completely: asked, never guessed. */
export const BALANCED_DATE_UNCLEAR_MESSAGE = "¿Qué día te viene bien? Dime el día de la semana o la fecha.";

export function balancedDateQuestionMessage(
  question: Extract<FechaResolution, { kind: "question" }> | { reason: "ambiguous_week"; candidates: string[] },
  todayIso: string,
): string {
  const offer = (candidates: readonly string[]): string => {
    if (candidates.length === 0) return "¿Qué día te viene bien?";
    const days = candidates.map((date) => spokenDayFullEs(date, todayIso));
    return days.length === 1 ? `¿Te lo busco ${days[0]}?` : `¿Te lo busco ${days[0]} o ${days[1]}?`;
  };
  const q = question as Extract<FechaResolution, { kind: "question" }>;
  const date = q.date;
  const parsed = date === undefined ? null : parseDateTime(date);
  const dayWords =
    parsed === null || date === undefined
      ? ""
      : `${spokenDayOfMonthEs(parsed.day)}${differentMonth(date, todayIso) ? ` de ${monthNameEs(parsed.month)}` : ""}`;
  switch (question.reason) {
    case "weekday_mismatch":
    case "offset_mismatch": {
      if (parsed === null) return offer(q.candidates);
      const weekday = weekdayEs(parsed);
      const lead =
        q.offsetWord !== undefined
          ? `${capitalizeFirst(q.offsetWord)} es ${weekday} ${dayWords}.`
          : `El ${dayWords} es ${weekday}.`;
      const closedNote =
        question.reason === "weekday_mismatch" && date !== undefined && !q.candidates.includes(date)
          ? lead.replace(/\.$/, ", y ese día cerramos.")
          : lead;
      return `${closedNote} ${offer(q.candidates)}`;
    }
    case "past":
      return date === undefined
        ? offer(q.candidates)
        : `${capitalizeFirst(spokenDayFullEs(date, todayIso))} ya ha pasado. ${offer(q.candidates)}`;
    case "invalid_day":
      return `${capitalizeFirst(monthNameEs(q.month ?? 0))} no tiene día ${spokenDayOfMonthEs(q.day ?? 0)}. ¿Qué día te viene bien?`;
    case "ambiguous_week":
      return "¿Qué día de la semana que viene te va bien?";
    // 2026-10-10 (fail-closed): words that are not ONE clear future day.
    case "unclear":
      return BALANCED_DATE_UNCLEAR_MESSAGE;
    // 2026-10-10 (v3): the pieces and the customer's literal words name different days.
    case "cross_check":
      return q.candidates.length === 2
        ? `¿Me confirmas el día: ${spokenDayFullEs(q.candidates[0]!, todayIso)} o ${spokenDayFullEs(q.candidates[1]!, todayIso)}?`
        : BALANCED_DATE_UNCLEAR_MESSAGE;
    case "multiple":
      return "¿Qué día prefieres? Dime solo uno: el día de la semana o la fecha.";
    case "past_word":
      return "Ese día ya ha pasado. ¿Qué día te viene bien? Dime el día de la semana o la fecha.";
    case "ambiguous_other":
      return q.candidates.length === 2
        ? `¿Qué ${weekdayNameEs(q.saidWeekday ?? -1)} te viene bien: ${spokenDayFullEs(q.candidates[0]!, todayIso)} o ${spokenDayFullEs(q.candidates[1]!, todayIso)}?`
        : "¿Qué día te viene bien?";
    default:
      return "¿Qué día te viene bien?";
  }
}


/**
 * *** THE WINDOW SENTENCES — `action: "scan"`. ***
 *
 * `discover` answers about ONE day and one band, so its sentences never have
 * to name a day: the caller just said which one. `scan` answers about up to
 * SEVEN days at once, which changes the sentence in three ways, and every one
 * of them is a place a voice agent can lie:
 *
 * 1. **The day has to be spoken, and spoken as a distance.** «El jueves» is
 *    only unambiguous inside the coming week; `spokenDateEs` handles that, and
 *    it is the ONLY source of a day phrase here. `days_summary.weekday_es`
 *    deliberately is not used for speech — it cannot say "hoy" or "mañana",
 *    and a caller who hears the weekday for tomorrow has to do arithmetic.
 * 2. **Hours inside one day are ALTERNATIVES, hours across days are a LIST.**
 *    «a las cinco, a las seis o a las siete» within Tuesday; «el lunes …, el
 *    martes … y el jueves …» across days. Using «y» inside a day would read as
 *    an offer of three appointments.
 * 3. **«Solo» is unsayable here, and that is structural.** On one day the
 *    middleware knows the whole inventory, so «solo me quedan dos» is a fact.
 *    Across a window it does NOT: `scan` reads as far as it can within its
 *    budget, `partial` says so, and a page of three is a SELECTION, never an
 *    inventory. So no scan sentence contains the word — see the lock in
 *    `tests/balancedV2Phrasing.test.ts`.
 *
 * *** THE PAGE'S ORDER IS THE OPTION NUMBERING. ***
 *
 * `option_index` 1, 2, 3 is positional, so the sentence must speak the page in
 * the order it arrived. Days are grouped by FIRST appearance and hours keep
 * their slot inside the day; nothing is sorted, ever. A prettier sentence that
 * reordered the hours would make «la segunda» select the wrong hueco.
 */

/** One day of the page, as it is spoken: its date and its hours, in page order. */
interface ScanDayGroup {
  date: string;
  times: string[];
}

/**
 * Alternatives within ONE day: `["cinco","seis","siete"]` ->
 * `"cinco, a las seis o a las siete"`.
 *
 * The sibling of `joinSpokenEs`, with «o» instead of «y». It is a separate
 * helper rather than a flag because the choice is semantic: «y» offers a list,
 * «o» offers a choice, and the caller can only have one of these hours.
 */
function joinAlternativesEs(items: readonly string[], prefix = ""): string {
  if (items.length === 0) return "";
  const decorated = items.map((item, index) => (index === 0 ? item : `${prefix}${item}`));
  if (decorated.length === 1) return decorated[0]!;
  return `${decorated.slice(0, -1).join(", ")} o ${decorated.at(-1)}`;
}

/** «el martes» -> «El martes», «mañana» -> «Mañana». Sentence-initial only. */
function capitalizeFirst(sentence: string): string {
  return sentence.length === 0 ? sentence : sentence[0]!.toUpperCase() + sentence.slice(1);
}

/** Groups the page by day, preserving the order the page arrived in. */
function groupByDay(
  page: readonly { date: string; time: string; optionIndex: number }[],
): ScanDayGroup[] {
  const groups: ScanDayGroup[] = [];
  for (const option of page) {
    const existing = groups.find((group) => group.date === option.date);
    if (existing === undefined) groups.push({ date: option.date, times: [option.time] });
    else existing.times.push(option.time);
  }
  return groups;
}

/** `"el lunes a las cinco o a las seis"`. */
function spokenDayChunk(group: ScanDayGroup, todayIso: string): string {
  const hours = joinAlternativesEs(group.times.map(spokenTimeEs), "a las ");
  return `${spokenDateEs(group.date, todayIso)} a las ${hours}`;
}

/**
 * What the agent says when a window search has hours to offer.
 *
 * @param page        The options of THIS page, in the order they are numbered
 *                    1, 2, 3. At most three, spanning at most three days.
 * @param daysSummary The per-day counts the answer also carries. Mostly NOT
 *                    spoken — `days_summary`, `days_checked`, `matching_count`
 *                    and the rest are diagnostics the prompt forbids reading
 *                    aloud. It is taken so the builder can still produce a
 *                    truthful sentence for the (unreachable) empty page, and
 *                    so a future wording that needs the counts has them
 *                    without a signature change at the route. The ONE
 *                    exception is `last_time`, on a single-day page with more
 *                    than one hour: see `opts.hasMore` below.
 * @param opts        `hasMore` — more matching hours exist beyond this page,
 *                    read off the server's own ranking, never guessed. On a
 *                    SINGLE day with several hours, and only there, it also
 *                    names how far the rest go — «hasta las ocho», taken from
 *                    that day's `last_time` — because "alguna más" alone, on
 *                    the exact page shape that follows a dropped hour
 *                    constraint, is the sentence a caller reasonably reads as
 *                    "ask me something else". A multi-day page keeps the bare
 *                    "Y tengo alguna más.": it is a promise about the WINDOW,
 *                    and no single day's `last_time` could make it truer.
 *                    `todayIso` — the salon's today, for «hoy» and «mañana».
 */
export function balancedScanMessage(
  page: readonly { date: string; time: string; optionIndex: number }[],
  daysSummary: readonly {
    date: string;
    weekday_es: string;
    count: number;
    first_time: string;
    last_time: string;
    matching_count: number;
  }[],
  opts: { hasMore: boolean; todayIso: string },
): string {
  // Defensive only: the service answers `no_availability` for an empty window
  // and never reaches here. A sentence builder must never speak «a las .».
  if (page.length === 0) {
    return balancedScanNoAvailabilityMessage({
      days: Math.max(1, daysSummary.length),
      partial: false,
    });
  }

  const groups = groupByDay(page);
  const question = page.length === 1 ? "¿Te viene bien?" : "¿Cuál te viene mejor?";

  // ONE day with several hours puts the day first — «El martes tengo a las…» —
  // because repeating «Tengo el martes a las cinco, el martes a las seis» is
  // how a machine talks. Across days the day belongs to each item, so the
  // sentence leads with the verb instead.
  if (groups.length === 1 && page.length > 1) {
    const group = groups[0]!;
    const hours = joinAlternativesEs(group.times.map(spokenTimeEs), "a las ");
    const day = capitalizeFirst(spokenDateEs(group.date, opts.todayIso));
    // The one place `daysSummary` is spoken: `last_time` says how far "alguna
    // más" actually goes, on the exact shape a dropped hour constraint takes.
    // Absent when `more()` re-renders a continuation page with no summary at
    // hand (`daysSummary` arrives empty there) — then the plain promise below
    // is all that can honestly be said.
    const daySummary = daysSummary.find((entry) => entry.date === group.date);
    const more = !opts.hasMore
      ? ""
      : daySummary === undefined
        ? " Y tengo alguna más."
        : ` Y tengo alguna más hasta ${articledSpokenTimeEs(daySummary.last_time)}.`;
    return `${day} tengo a las ${hours}.${more} ${question}`;
  }

  // Honest on every page: it is read off the remaining ranking, so «alguna
  // más» is a fact about inventory rather than an invitation to keep asking.
  const more = opts.hasMore ? " Y tengo alguna más." : "";
  const chunks = groups.map((group) => spokenDayChunk(group, opts.todayIso));
  return `Tengo ${joinSpokenEs(chunks)}.${more} ${question}`;
}

/** 1..7 in words. The window is capped at seven days, so the table ends there. */
const DAY_COUNT_WORDS_ES = ["", "un", "dos", "tres", "cuatro", "cinco", "seis", "siete"] as const;

/** Present and non-blank, or absent. An empty string is not a condition. */
function given(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * *** NOTHING IN THE WHOLE WINDOW — AND IT IS NOT AN ERROR. ***
 *
 * The caller asked a question with a shape («a partir de las cinco», «por la
 * tarde», «los próximos días») and the honest answer is empty. Three things
 * this sentence must do, because the production incident this flow exists for
 * was a dead end the caller hung up on:
 *
 * - **Repeat the condition back.** «No tengo nada» alone invites «¿nada de
 *   nada?», and the answer to that is yes-nothing-matching-what-you-asked.
 * - **Name the window truthfully.** When `partial` is true the middleware ran
 *   out of budget before reading every day, so «en los próximos siete días»
 *   would be a claim it cannot support: it says «en los días que he podido
 *   mirar» instead. One day is «ese día», never «en el próximo un día».
 * - **Leave two doors open**, always: the other band, and further ahead.
 *
 * *** AN HOUR CONSTRAINT MUST NEVER BE SPOKEN AS AN INVITATION TO DROP IT. ***
 *
 * The production incident this whole file was rewritten for: the caller said
 * «a partir de las seis», the day had nothing there, and the OLD sentence
 * answered «¿quieres que mire por la mañana…?» — a question about the band,
 * which is exactly the axis the caller had just constrained away. The model
 * took the offer, ran a plain morning `discover` with no hour filter at all,
 * and read out the first three hours of the morning to a caller who had never
 * withdrawn "a partir de las seis". Two separate fixes follow from that one
 * failure, split by how much the middleware actually knows:
 *
 * - **A single day** (`days <= 1`) has been read IN FULL, so when the caller
 *   gave a floor or a ceiling and nothing on that one day satisfies it, the
 *   middleware can name the real nearest hour instead of gesturing at a band —
 *   «lo más cercano es a las cuatro y media» — and still ask to keep the SAME
 *   constraint on a different day. `nearestOutsideConstraint` carries that
 *   hour; its absence means the day has no free hour at all, not merely none
 *   that qualifies, and the sentence shortens accordingly.
 * - **A window of several days** cannot make that claim about any one day, so
 *   it offers the NEXT window concretely («¿Te busco la semana siguiente…?») or
 *   "a otra hora" — never a band, because naming one is the sentence that
 *   taught the model it could drop the hour.
 *
 * Two hours (`afterTime` AND `beforeTime` together) bind a slice rather than a
 * single boundary and are left exactly as they were: "otra franja" already
 * asks the caller to say which hour, without implying either one is gone.
 *
 * @param opts `afterTime` / `beforeTime` — the `HH:mm` the caller named, either,
 *   both or neither. `period` — a plain morning/afternoon ask, spoken only when
 *   no hour was given (an hour is the more specific condition and states the
 *   band implicitly). `days` — how many days the question spanned. `partial` —
 *   the window was NOT fully read. `nearestOutsideConstraint` — on a one-day
 *   question bound by ONE hour (`afterTime` xor `beforeTime`), the closest real
 *   free hour that day, taken from the service's uncapped per-day list; leave
 *   it out when the day has no free hour at all.
 */
export function balancedScanNoAvailabilityMessage(opts: {
  afterTime?: string;
  beforeTime?: string;
  period?: TimePeriod;
  days: number;
  partial: boolean;
  nearestOutsideConstraint?: string;
}): string {
  const after = given(opts.afterTime);
  const before = given(opts.beforeTime);
  // Exactly one boundary, not two: the only shape a single day can answer
  // with a real nearest hour, because "entre las cinco y las siete" bounds a
  // slice the middleware never measured a distance to.
  const oneHourBoundary = (after !== undefined) !== (before !== undefined);

  // *** THE ONE-DAY, ONE-BOUNDARY ANSWER — A REAL HOUR, NEVER A BAND. ***
  //
  // `partial` rules this out on purpose: a day that did not finish reading in
  // time cannot honestly claim to know its nearest free hour either. That
  // combination cannot reach here from `scan()` (a day that fails to arrive
  // never counts as `days_checked`, so the route answers `agenda_unavailable`
  // first) — this guard only keeps the builder itself honest if ever called
  // directly with `days: 1, partial: true`.
  if (opts.days <= 1 && !opts.partial && oneHourBoundary) {
    const boundary =
      after !== undefined
        ? `a partir de las ${spokenTimeEs(after)}`
        : `antes de las ${spokenTimeEs(before as string)}`;
    const nearest = given(opts.nearestOutsideConstraint);
    if (nearest !== undefined) {
      return (
        `No tengo nada ${boundary} ese día; lo más cercano es a las ${spokenTimeEs(nearest)}. ` +
        `¿Te sirve, o miro ${boundary} otro día?`
      );
    }
    return `No tengo nada ${boundary} ese día. ¿Miro ${boundary} otro día?`;
  }

  const condition = scanConditionEs(after, before, opts.period);

  // `partial` outranks the day count: the number of days ASKED FOR is not the
  // number of days looked at, and only the second one may be claimed.
  let window: string;
  if (opts.partial) {
    window = " en los días que he podido mirar";
  } else if (opts.days <= 1) {
    window = " ese día";
  } else {
    window = scanWindowEs(opts.days);
  }

  let question: string;
  if (opts.days <= 1) {
    // One day, no single-boundary answer above: unchanged wording.
    if (after !== undefined || before !== undefined) {
      question =
        after !== undefined && before !== undefined
          ? "¿Quieres que mire en otra franja o más adelante?"
          : "¿Quieres que mire más adelante o a otra hora?";
    } else if (opts.period !== undefined) {
      question = `¿Quieres que mire por la ${periodLabelEs(oppositePeriod(opts.period))} o más adelante?`;
    } else {
      question = "¿Quieres que mire más adelante?";
    }
    return `No tengo nada${condition}${window}. ${question}`;
  }

  // *** A WINDOW WITH NOTHING ENDS ON A CONCRETE OFFER, NOT «¿más adelante?». ***
  //
  // «¿Quieres que mire más adelante?» was a vague door a caller answered «no»
  // to, and the agent read that «no» as a rejection of every alternative. The
  // offer is now the NEXT window itself — the following week for a seven-day
  // question, the following days for a shorter one — and, when the caller
  // constrained the hour or the band, the other hour/band as the second door.
  // One hour alone still never names a band (incident note above).
  const further = opts.days >= 7 ? "la semana siguiente" : "los días siguientes";
  if (after !== undefined || before !== undefined) {
    question =
      after !== undefined && before !== undefined
        ? `¿Te busco ${further}, o te va bien en otra franja?`
        : `¿Te busco ${further}, o te va bien a otra hora?`;
  } else if (opts.period !== undefined) {
    // No hour, only a band: the OTHER band is still a real, honest door.
    question = `¿Te busco ${further}, o te va bien por la ${periodLabelEs(oppositePeriod(opts.period))}?`;
  } else {
    question = `¿Te busco ${further}?`;
  }

  return `No tengo nada${condition}${window}. ${question}`;
}

/** « a partir de las cinco», « entre las cinco y las siete», « por la tarde» or "". */
function scanConditionEs(
  after: string | undefined,
  before: string | undefined,
  period: TimePeriod | undefined,
): string {
  if (after !== undefined && before !== undefined) {
    return ` entre las ${spokenTimeEs(after)} y las ${spokenTimeEs(before)}`;
  }
  if (after !== undefined) return ` a partir de las ${spokenTimeEs(after)}`;
  if (before !== undefined) return ` antes de las ${spokenTimeEs(before)}`;
  if (period !== undefined) return ` por la ${periodLabelEs(period)}`;
  return "";
}

/** « en los próximos siete días» for a fully read multi-day window. */
function scanWindowEs(days: number): string {
  const word = DAY_COUNT_WORDS_ES[days] ?? String(days);
  return ` en los próximos ${word} días`;
}

/**
 * *** EXTENDED SCAN (ADR-024; V5 requests only, ADR-025). ***
 *
 * A multi-day window was read IN FULL with nothing matching, and the server
 * read the following days (up to fourteen in total, same condition) and found
 * the nearest day that does match. The statement is the SAME one
 * {@link balancedScanNoAvailabilityMessage} makes about the window — condition
 * repeated back, window named — and instead of «¿Te busco la semana
 * siguiente…?» it names that day's real hours, all of which satisfy the
 * caller's condition, and ends on an open question.
 *
 * @param opts.days  The window the caller asked for (2..7), fully read.
 * @param opts.times `HH:mm` of the page, in the order numbered.
 */
export function balancedScanExtendedMessage(opts: {
  afterTime?: string;
  beforeTime?: string;
  period?: TimePeriod;
  days: number;
  offeredDate: string;
  times: readonly string[];
}): string {
  const condition = scanConditionEs(given(opts.afterTime), given(opts.beforeTime), opts.period);
  if (opts.times.length === 0) {
    return balancedScanNoAvailabilityMessage({ ...opts, partial: false });
  }
  return `No tengo nada${condition}${scanWindowEs(opts.days)}; ${nearestDayOfferEs(opts.offeredDate, opts.times)}`;
}

/**
 * Extended scan: fourteen days fully read and nothing satisfies the caller's
 * condition. The second door (another hour, another slice, the other band) is
 * named only when some day read actually had a free hour OUTSIDE the
 * condition; otherwise the caller is asked which dates to look at.
 */
export function balancedScanTwoWeeksNothingMessage(opts: {
  afterTime?: string;
  beforeTime?: string;
  period?: TimePeriod;
  otherHoursSeen: boolean;
}): string {
  const after = given(opts.afterTime);
  const before = given(opts.beforeTime);
  const condition = scanConditionEs(after, before, opts.period);
  let door: string | undefined;
  if (after !== undefined && before !== undefined) door = "en otra franja";
  else if (after !== undefined || before !== undefined) door = "a otra hora";
  else if (opts.period !== undefined) door = `por la ${periodLabelEs(oppositePeriod(opts.period))}`;
  const question =
    door !== undefined && opts.otherHoursSeen
      ? `¿Te va bien ${door}, o prefieres que mire otras fechas?`
      : BALANCED_OTHER_DATES_QUESTION;
  return `No tengo nada${condition} en las próximas dos semanas. ${question}`;
}

/**
 * Every matching hour in the window has already been offered to this call.
 *
 * The window twin of `balancedNoMoreOptionsMessage`, and NOT a paraphrase of
 * it: that one can say «ya no me quedan más horas», because on one day in one
 * band the middleware really has seen the whole inventory. Here it has not —
 * the window was searched under a condition and within a budget — so the
 * sentence makes the smaller, true claim: everything it FOUND has been said.
 *
 * Both doors stay open, for the same reason every terminal V2 sentence keeps
 * them open: this is the moment the production agent said «no puedo mostrarte
 * más opciones directamente» and the caller hung up.
 */
export function balancedScanNoMoreMessage(): string {
  return "Ya te he dicho todas las que tengo en esos días. ¿Quieres que mire más adelante o en otra franja?";
}

/**
 * *** ADR-026 (V5 requests only): THE SAME DAY, AND THE NEAREST DAY THAT HAS
 * WHAT WAS ASKED. ***
 *
 * The requested band was full, so the page offers up to two hours of the OTHER
 * band that same day — and, because a caller who asked for the afternoon may
 * well prefer another afternoon to this morning, the nearest later day with an
 * hour in the REQUESTED band (real call, 2026-09-16: the V4 answer offered only
 * the morning and the caller hung up).
 *
 * «Esa tarde la tengo completa. Por la mañana tengo a las doce o a las doce y
 * media; y si prefieres tarde, lo más cercano es el jueves veinticuatro a las
 * cuatro. ¿Qué te viene mejor?»
 *
 * «si prefieres por la mañana», never «si prefieres mañana»: on a phone line
 * that is «tomorrow».
 *
 * @param opts.sameDayTimes `HH:mm` of the same-day hours, in page order.
 * @param opts.nextDate     `YYYY-MM-DD` of the nearest day in the requested band.
 * @param opts.nextTime     `HH:mm` offered on that day.
 */
export function balancedPeriodAlternativeMessage(opts: {
  requested: TimePeriod;
  offered: TimePeriod;
  sameDayTimes: readonly string[];
  nextDate: string;
  nextTime: string;
}): string {
  const requested = periodLabelEs(opts.requested);
  const sameDay = joinAlternativesEs(
    opts.sameDayTimes.map((time) => `a ${articledSpokenTimeEs(time)}`),
  );
  const preference = opts.requested === "afternoon" ? "tarde" : "por la mañana";
  return (
    `Esa ${requested} la tengo completa. ` +
    `Por la ${periodLabelEs(opts.offered)} tengo ${sameDay}; ` +
    `y si prefieres ${preference}, lo más cercano es ` +
    `${spokenWeekdayAndDayEs(opts.nextDate)} a ${articledSpokenTimeEs(opts.nextTime)}. ` +
    `¿Qué te viene mejor?`
  );
}

/**
 * *** ADR-026 (V5 requests only): THE REQUESTED PROFESSIONAL HAS NOTHING THAT
 * DAY, OTHERS DO. ***
 *
 * «Con Bruno ese día está completo. Ramón tiene a las doce o a las doce y media;
 * o con Bruno, lo más cercano es el martes veintidós a las cinco. ¿Qué
 * prefieres?»
 *
 * Each same-day hour is spoken with the professional it was assigned to at
 * discovery, which is the one `lock` keeps while still free. Two different
 * professionals are named each with their own hour: «Ramón tiene a las doce y
 * Olga a las doce y media».
 *
 * @param opts.others       Same-day hours, in page order, with their professional.
 * @param opts.othersPeriod Set only when those hours are in the OTHER band.
 */
export function balancedEmployeeAlternativeMessage(opts: {
  employeeName: string;
  others: ReadonlyArray<{ name: string; time: string }>;
  othersPeriod?: TimePeriod;
  nextDate: string;
  nextTime: string;
}): string {
  const band =
    opts.othersPeriod === undefined ? "" : ` por la ${periodLabelEs(opts.othersPeriod)}`;
  const names = [...new Set(opts.others.map((other) => other.name))];
  const sameDay =
    names.length === 1
      ? `${names[0]} tiene${band} ${joinAlternativesEs(
          opts.others.map((other) => `a ${articledSpokenTimeEs(other.time)}`),
        )}`
      : `${opts.others
          .map(
            (other, index) =>
              `${other.name}${index === 0 ? ` tiene${band}` : ""} a ${articledSpokenTimeEs(other.time)}`,
          )
          .join(" y ")}`;
  return (
    `Con ${opts.employeeName} ese día está completo. ${sameDay}; ` +
    `o con ${opts.employeeName}, lo más cercano es ` +
    `${spokenWeekdayAndDayEs(opts.nextDate)} a ${articledSpokenTimeEs(opts.nextTime)}. ` +
    `¿Qué prefieres?`
  );
}

/**
 * *** 2026-10-08 — CHANGING A BOOKING MADE IN THIS SAME CALL, AND THE NET
 * AGAINST A SILENT DUPLICATE (call conv_5401m4dvaaayeksa3bbz77pp3x4v). ***
 *
 * Every sentence names the hours involved, from the journal and the slot
 * grant — never from the model — because the incident was a caller told about
 * the new hours while the old one quietly stayed in the diary.
 *
 * `at` values are `YYYY-MM-DD HH:mm[:ss]`. When both hours are on the same day
 * only the hours are spoken («de las nueve y media a las doce»); otherwise
 * each carries its weekday and day number.
 */
function changeHourEs(at: string): string {
  return articledSpokenTimeEs(at.slice(11, 16));
}

/** «de las nueve y media» / «del sábado diez a las nueve y media». */
function deWhenEs(at: string, other: string): string {
  if (at.slice(0, 10) === other.slice(0, 10)) return `de ${changeHourEs(at)}`;
  return `del ${spokenWeekdayAndDayEs(at.slice(0, 10)).replace(/^el /, "")} a ${changeHourEs(at)}`;
}

/** «a las doce» / «al martes trece a las doce». */
function aWhenEs(at: string, other: string): string {
  if (at.slice(0, 10) === other.slice(0, 10)) return `a ${changeHourEs(at)}`;
  return `al ${spokenWeekdayAndDayEs(at.slice(0, 10)).replace(/^el /, "")} a ${changeHourEs(at)}`;
}

/** The change is complete: the new booking exists and the old one is cancelled. */
export function balancedChangeDoneMessage(oldAt: string, newAt: string): string {
  if (oldAt.slice(0, 16) === newAt.slice(0, 16)) {
    return `Hecho: te he cambiado de profesional la cita ${deWhenEs(oldAt, newAt)}.`;
  }
  return `Hecho: te he cambiado la cita ${deWhenEs(oldAt, newAt)} ${aWhenEs(newAt, oldAt)}.`;
}

/**
 * 2026-10-10 (internal doc, not included in the template) — `outcome:
 * "change_confirm_required"`: the summary of a change of an EXISTING booking,
 * written by the server from the agenda (old) and the slot (new), to be read
 * as is and answered with a «sí» before the create is sent again.
 */
export function balancedChangeConfirmMessage(oldAt: string, newAt: string, employeeName?: string): string {
  const name = employeeName?.trim();
  return (
    `Te cambio tu cita del ${spokenAppointmentEs(oldAt).replace(/^el /, "")} ` +
    `por la del ${spokenAppointmentEs(newAt).replace(/^el /, "")}${name ? ` con ${name}` : ""}. ¿Lo confirmo así?`
  );
}

/**
 * The new booking exists, the old one could NOT be cancelled (`cancelled`
 * false) or its cancellation could not be confirmed (`unknown`). Honest about
 * both, and the way out is in the sentence itself.
 */
export function balancedChangeOldNotCancelledMessage(
  oldAt: string,
  newAt: string,
  unknown: boolean,
): string {
  const kept = `Te he dejado la cita ${deWhenEs(newAt, oldAt)}`;
  return unknown
    ? `${kept}, pero no he podido confirmar que la ${deWhenEs(oldAt, newAt)} quede anulada. ` +
        "Escríbenos por WhatsApp a este mismo número para comprobarlo."
    : `${kept}, pero no he podido anular la ${deWhenEs(oldAt, newAt)}. ` +
        "Escríbenos por WhatsApp a este mismo número para quitarla.";
}

/** Why a change was refused BEFORE anything was written. */
export type ChangeRefusalReason =
  | "unavailable"
  | "not_found"
  | "already_changed"
  | "other_phone"
  | "limit"
  /** 2026-10-10: `replaces_existing_booking` names no booking read in this call. */
  | "not_listed";

/** `outcome: "change_not_available"` — nothing was created, nothing cancelled. */
export function balancedChangeNotAvailableMessage(
  reason: ChangeRefusalReason,
  oldAt?: string,
): string {
  const stands =
    oldAt === undefined ? "" : ` La ${deWhenEs(oldAt, oldAt)} sigue en pie.`;
  switch (reason) {
    case "not_found":
      return "No encuentro esa cita entre las que hemos hecho en esta llamada, así que no puedo cambiarla desde aquí.";
    case "already_changed":
      return "Esa cita ya la he cambiado antes en esta llamada.";
    case "not_listed":
      return "Antes de cambiarla tengo que mirar tus citas, así que todavía no he cambiado nada.";
    case "other_phone":
      return `Solo puedo cambiar una cita de esta llamada si es con el mismo teléfono.${stands}`;
    case "limit":
      return `En esta llamada no puedo hacer más cambios.${stands} Si quieres cambiarla, escríbenos por WhatsApp a este mismo número.`;
    case "unavailable":
    default:
      return `Ahora mismo no puedo cambiarte la cita por teléfono.${stands} Si quieres cambiarla, escríbenos por WhatsApp a este mismo número.`;
  }
}

/**
 * `outcome: "possible_duplicate"` — the same person (name, surnames, phone)
 * already has a booking from this call on that day, and the request did not
 * say whether this one replaces it. Nothing was written and the lock is
 * still valid: the answer to this question is the SAME create, with
 * `replaces_booking_number` (change) or 0 (both).
 */
export function balancedPossibleDuplicateMessage(existingAt: string): string {
  return (
    `Ese día ya te he dejado una cita ${aWhenEs(existingAt, existingAt)}. ` +
    "¿Quieres cambiar esa cita a esta nueva hora, o prefieres tener las dos?"
  );
}

/**
 * 2026-10-08 (call conv_0201m4dx6ayjfm3r4yw09k8mdn6g) — the day the server
 * actually searched, said out loud, when the agent sent `day_name`. Returns
 * the message unchanged when it already names its day (look-ahead, closed
 * weekday, scan) or has no recognisable opening.
 *
 * «Ese día me quedan…» → «Hoy, jueves ocho, me quedan…»;
 * «Te puedo ofrecer…» → «El jueves ocho te puedo ofrecer…»;
 * «Sí, a las seis…» → «Sí, el jueves ocho a las seis…».
 */
export function withSpokenDayEs(message: string, dateIso: string, todayIso: string): string {
  // 2026-10-10: now applied to EVERY discover / day-`more` / one-day `scan`
  // answer, not only when `day_name` was sent, and with the month when the
  // day is not in today's month.
  const named = spokenDayFullEs(dateIso, todayIso); // «el jueves ocho»
  const offset = Math.round((Date.parse(`${dateIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
  const bare = named.replace(/^el /, "");
  // Sentence-initial and mid-sentence forms of the same day.
  const lead = offset === 0 ? `Hoy, ${bare},` : offset === 1 ? `Mañana, ${bare},` : capitalizeFirst(named);
  const inner = offset === 0 ? `hoy, ${bare}` : offset === 1 ? `mañana, ${bare}` : named;
  if (message.startsWith("Ese día ")) return `${lead} ${message.slice("Ese día ".length)}`;
  const band = /^Esa (mañana|tarde) /.exec(message);
  if (band !== null) {
    return `${capitalizeFirst(`la ${band[1]} del ${bare}`)} ${message.slice(band[0].length)}`;
  }
  if (message.startsWith("Sí, ")) return `Sí, ${inner}, ${message.slice("Sí, ".length)}`;
  // `more` of a day: «Después de esas solo me quedan…».
  if (message.startsWith("Después de esas ")) {
    return `${lead} ${message[0]!.toLowerCase()}${message.slice(1)}`;
  }
  // The closed-day fallback without look-ahead («Los domingos y los lunes…»).
  if (message === BALANCED_CLOSED_DAY_MESSAGE) {
    return t("balanced.cerrado_dia_con_fecha", { fecha: lead });
  }
  // «Ya no me quedan más horas esa tarde.»
  const midBand = / esa (mañana|tarde)(?=[ .,;])/.exec(message);
  if (midBand !== null) {
    return message.replace(midBand[0], ` la ${midBand[1]} del ${bare.replace(/^hoy, |^mañana, /, "")}`);
  }
  // «No tengo nada a partir de las seis ese día…», «Con Bruno ese día está…».
  if (/ ese día(?=[ .,;])/.test(message)) return message.replace(/ ese día(?=[ .,;])/, ` ${inner}`);
  if (/^(Te puedo ofrecer|A las |A la )/.test(message)) {
    return `${lead} ${message[0]!.toLowerCase()}${message.slice(1)}`;
  }
  return message;
}
