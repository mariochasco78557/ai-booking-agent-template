import { clientTimeZone } from "../core/config/clientConfig.js";

/**
 * *** "TODAY", AS THE SALON MEANS IT. ***
 *
 * Zona horaria: `zona_horaria` de `clientes/<id>/cliente.yaml` (D-007; Demo Salon:
 * Europe/Madrid). Los nombres `madrid*` se conservan para no tocar a los
 * llamadores; renombrarlos queda para un tramo posterior de la fase 2.
 *
 * Europe/Madrid wall-clock date and hour, DST included, without pulling in a
 * date library. Both functions were born in
 * `src/services/agenda/agendaRefresher.ts`, where the background scheduler
 * needs them to decide which dates to warm and whether the salon is inside its
 * quiet window. They now live here because a SECOND caller needs the same
 * answer for a different reason: the window search (`action: "scan"`) has to
 * know which calendar day "hoy" is before it can say "mañana" out loud, and a
 * voice route importing the cache refresher to learn today's date would be a
 * dependency nobody could defend.
 *
 * `agendaRefresher.ts` re-exports both names, so every existing import keeps
 * working and the move is invisible to it. Nothing about the behaviour
 * changed: the implementations below are byte-for-byte the ones that shipped.
 *
 * *** WHY NOT `new Date().toISOString().slice(0, 10)`. ***
 *
 * Because that is UTC, and the salon is not. Between midnight and 02:00 Madrid
 * in summer, UTC is still on the previous day — an agent that trusted it would
 * offer "hoy" for a day that is already over, and warm a window one day short.
 * `Intl` is the only thing in the standard library that knows when Spain moves
 * its clocks.
 *
 * Both take the instant as a parameter rather than reading the clock, so every
 * caller — and every test — decides what "now" is.
 */

/** Europe/Madrid hour-of-day, DST included, without pulling in a date library. */
export function madridHour(nowMs: number): number {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: clientTimeZone(),
    hour: "2-digit",
    hour12: false,
  }).format(new Date(nowMs));
  return Number(formatted);
}

/** Europe/Madrid calendar date, so "today" means today for the salon. */
export function madridDate(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: clientTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/**
 * Europe/Madrid wall clock of an instant, as `YYYY-MM-DD HH:MM` (24 h, DST
 * included). The same spelling the salon's agenda uses for a slot start, cut
 * to the minute, so the two compare as strings.
 *
 * `hourCycle: "h23"` because some ICU builds spell midnight `24` under
 * `hour12: false`, and «24:10» would sort after every hour of the day.
 */
export function madridWallClock(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: clientTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/** Epoch ms of a Europe/Madrid wall clock (DST-correct by one refinement pass). */
export function madridWallToEpochMs(p: { year: number; month: number; day: number; hour: number; minute: number }): number {
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  let guess = asUtc;
  for (let i = 0; i < 2; i += 1) {
    const wall = madridWallClock(guess); // "YYYY-MM-DD HH:MM"
    const shown = Date.UTC(
      Number(wall.slice(0, 4)),
      Number(wall.slice(5, 7)) - 1,
      Number(wall.slice(8, 10)),
      Number(wall.slice(11, 13)),
      Number(wall.slice(14, 16)),
    );
    guess += asUtc - shown;
  }
  return guess;
}

/** Minutes since midnight, Europe/Madrid (DST included). */
export function madridMinutes(nowMs: number): number {
  const wall = madridWallClock(nowMs); // "YYYY-MM-DD HH:MM"
  return Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
}
