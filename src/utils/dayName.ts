/**
 * *** `day_name` — THE DAY THE CUSTOMER SAID, NOT THE DATE THE MODEL COMPUTED
 * (2026-10-08, call conv_0201m4dx6ayjfm3r4yw09k8mdn6g). ***
 *
 * On Thursday 2026-10-08 the caller said «jueves o viernes»; the model asked
 * «¿mañana jueves o el viernes?», searched 2026-10-09 (a Friday) for «jueves»
 * and 2026-10-10 (a Saturday) for «viernes», and the server's «Ese día…» hid
 * it. The weekday arithmetic is the model's weak spot, so the agent now also
 * sends the WORD the customer used, and the server decides the date:
 *
 * - `hoy` / `mañana` / `pasado mañana` → today + 0 / 1 / 2 (Europe/Madrid),
 *   whatever `date` said.
 * - a weekday that AGREES with `date` (and `date` is not in the past) → `date`
 *   unchanged: «el jueves de la semana que viene» keeps its week.
 * - a weekday that DISAGREES → the date of that weekday NEAREST to the date
 *   sent, never before today (today counts). For a date sent this week that is
 *   exactly "the nearest such day from today"; for a date sent in a later week
 *   it keeps that week instead of collapsing a whole week back. The two
 *   incident errors were off by one day, and a shift is at most three days.
 *
 * An unreadable `day_name` is ignored (the optional-field rule of the V2
 * surface): the request is answered exactly as without it.
 */

export type DayName =
  | { kind: "offset"; days: 0 | 1 | 2 }
  | { kind: "weekday"; dow: 0 | 1 | 2 | 3 | 4 | 5 | 6 };

const WEEKDAYS: Readonly<Record<string, DayName>> = {
  domingo: { kind: "weekday", dow: 0 },
  lunes: { kind: "weekday", dow: 1 },
  martes: { kind: "weekday", dow: 2 },
  miercoles: { kind: "weekday", dow: 3 },
  jueves: { kind: "weekday", dow: 4 },
  viernes: { kind: "weekday", dow: 5 },
  sabado: { kind: "weekday", dow: 6 },
  hoy: { kind: "offset", days: 0 },
  manana: { kind: "offset", days: 1 },
  "pasado manana": { kind: "offset", days: 2 },
};

/** `"Jueves"`, `" el miércoles "`, `"pasado mañana"` → a {@link DayName}; anything else → undefined. */
export function parseDayName(raw: unknown): DayName | undefined {
  if (typeof raw !== "string" || raw.length > 40) return undefined;
  const folded = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/^(el|este) /, "")
    // 2026-10-09: «el próximo jueves» is the nearest Thursday (owner's rule).
    .replace(/^proximo /, "");
  return WEEKDAYS[folded];
}

const DAY_MS = 86_400_000;

function epochOf(dateIso: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (match === null) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === dateIso ? ms : undefined;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The date to search for `dayName`, given the date the agent sent (may be
 * absent or invalid) and the salon's today (`madridDate`). Pure.
 *
 * 2026-10-09 — `nearestFromToday` (WhatsApp, owner's rule): a weekday the
 * customer wrote is ALWAYS the nearest such day from today (today counts),
 * whatever `date` said — «el próximo jueves» written on Friday 9 is Thursday
 * 15, never the 29th. The WhatsApp agent only sends `day_name` when the
 * customer gave a bare weekday (no day number, no «de la semana que viene»).
 */
export function resolveDayName(
  dayName: DayName,
  sentDate: string | undefined,
  todayIso: string,
  opts: { nearestFromToday?: boolean } = {},
): string {
  const today = epochOf(todayIso);
  if (today === undefined) return sentDate ?? todayIso;
  if (dayName.kind === "offset") return isoOf(today + dayName.days * DAY_MS);
  if (opts.nearestFromToday === true) {
    const todayDow = new Date(today).getUTCDay();
    return isoOf(today + (((dayName.dow - todayDow + 7) % 7) * DAY_MS));
  }

  const sent = sentDate === undefined ? undefined : epochOf(sentDate);
  const base = sent !== undefined && sent >= today ? sent : today;
  const baseDow = new Date(base).getUTCDay();
  if (baseDow === dayName.dow) return isoOf(base);
  const forward = base + (((dayName.dow - baseDow + 7) % 7) * DAY_MS);
  const backward = forward - 7 * DAY_MS;
  if (backward < today) return isoOf(forward);
  return forward - base < base - backward ? isoOf(forward) : isoOf(backward);
}

// ════════════════════════════════════════════════════════════════════════════
// 2026-10-10 — `fecha_dicha`: THE SERVER RESOLVES THE DATE, THE MODEL NEVER DOES.
// ════════════════════════════════════════════════════════════════════════════
//
// Incident of Saturday 2026-10-10: the caller said «jueves 16», the model sent
// `date: "2026-10-16"` (a FRIDAY) and then said «el jueves dieciséis» in the
// summary and the confirmation; later «viernes 17» (a Saturday) became «el
// viernes diecisiete no tengo hueco». `day_name` could not help: it was never
// sent, and a weekday WITH a number was out of its scope.
//
// `fecha_dicha` is the customer's LITERAL words about the day («jueves 16»,
// «el martes», «mañana», «el 17», «la semana que viene»). The server resolves
// them against the salon's today (Europe/Madrid) and:
// - a weekday and a number that do not agree are NEVER searched: the caller is
//   asked which one («El dieciséis es viernes. ¿Te lo busco el viernes
//   dieciséis o el jueves quince?») — see `balancedDateQuestionMessage`;
// - a date in the past is corrected (a bare «el 5» on the 10th is the 5th of
//   next month, named WITH its month) or asked, never searched;
// - anything it cannot read returns `undefined`, and the request is answered
//   exactly as without `fecha_dicha` (the optional-field rule of V2).
//
// THE WEEKDAY RULE (voice and WhatsApp, the same): a bare weekday («el
// jueves», «este jueves») is the NEAREST such day from today; TODAY COUNTS
// while the salon is still open today (`todayStillOpen`), otherwise it is the
// same weekday next week. «el próximo jueves» / «el jueves que viene» is the
// nearest such day AFTER today (never today). «el jueves de la semana que
// viene» is the Thursday of next calendar week (Monday to Sunday).
//
// Pure: no clock. The caller passes today and whether the salon is still open.

/** What the customer's words were read as. Exported for tests only. */
export interface FechaDichaParsed {
  offset?: number;
  weekday?: number;
  day?: number;
  month?: number;
  year?: number;
  /** «próximo», «que viene», «siguiente» next to a weekday. */
  next?: boolean;
  /** «de la semana que viene». */
  nextWeek?: boolean;
  /** «de esta semana». */
  thisWeek?: boolean;
  /** «el otro jueves». */
  other?: boolean;
  /** Which word gave the offset, to say it back («mañana es sábado»). */
  offsetWord?: "hoy" | "mañana" | "pasado mañana";
}

export interface FechaContext {
  /** The salon's today, `YYYY-MM-DD` (Europe/Madrid). */
  todayIso: string;
  /** False once today's closing time has passed (or today is closed). */
  todayStillOpen: boolean;
  /** Weekdays the salon is closed all day (0 = Sunday). Default Sunday and Monday. */
  closedWeekdays?: ReadonlySet<number>;
}

export type FechaQuestionReason =
  | FechaUnreadable
  | "cross_check"
  | "weekday_mismatch"
  | "offset_mismatch"
  | "past"
  | "invalid_day"
  | "ambiguous_week"
  | "ambiguous_other";

export type FechaResolution =
  | {
      kind: "date";
      date: string;
      /** The date was moved forward because the literal one was past. */
      rolled?: "next_month" | "next_year";
    }
  | { kind: "week"; from: string; days: number }
  | {
      kind: "question";
      reason: FechaQuestionReason;
      /** The date the words pointed at, when there is one. */
      date?: string;
      /** The weekday the customer said, when it matters for the question. */
      saidWeekday?: number;
      offsetWord?: "hoy" | "mañana" | "pasado mañana";
      /** Day / month that does not exist (`invalid_day`). */
      day?: number;
      month?: number;
      /** Bookable dates to offer in the question (0, 1 or 2), nearest first. */
      candidates: string[];
    };

const FD_WEEKDAYS: Readonly<Record<string, number>> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
  domingos: 0, sabados: 6,
};

const FD_MONTHS: Readonly<Record<string, number>> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const FD_UNITS: Readonly<Record<string, number>> = {
  uno: 1, una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
};

/** Single-word day numbers (folded, after the STT normalisation below). */
const FD_NUMBER_WORDS: Readonly<Record<string, number>> = {
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  primero: 1, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30,
};

/**
 * Words that may surround a day without changing it. ANY other word left
 * over makes the whole `fecha_dicha` unclear (fail-closed, 2026-10-10 review).
 */
const FD_FILLERS = new Set([
  "el", "la", "los", "las", "lo", "de", "del", "dia", "dias", "para", "a", "al", "en", "por", "y",
  "que", "este", "esta", "pues", "vale", "si", "bueno", "mejor", "me", "va", "viene", "vendria",
  "bien", "puede", "ser", "seria", "porfa", "favor", "mi", "cita", "hueco", "mira", "mirame",
  "busca", "buscame", "quiero", "quisiera", "prefiero", "tienes", "hay", "algo", "ver", "eh",
  "un", "una", "mismo", "misma", "primera", "ultima", "hora", "tarde", "noche", "mediodia",
  "temprano", "se", "queria", "querria", "gracias", "pudiera", "podria", "posible", "tambien",
  "entonces", "venir", "ir", "pasarme", "pasar", "hola", "ok", "okey", "claro", "perfecto",
]);

/** Number-word STT variants: «ventisiete», «beintisiete», «vientisiete», «diesiseis», «trenta». */
function normaliseNumberWord(token: string): string {
  return token
    .replace(/^[bv](?:e|ie|ei|i)?nt(?=[ei])/, "veint")
    .replace(/^veint(?=[aou])/, "veinti")
    .replace(/^die[sz]i(?=[snoc])/, "dieci")
    .replace(/^trenta$/, "treinta");
}

function foldEs(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Clock-time words that may follow «las» / «la» in an hour expression. */
const FD_HOUR_WORD =
  "(?:\\d{1,2}(?: \\d{2})?(?: h| horas?)?|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|" +
  "trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuna|veintiuno|veintidos|veintitres)";
const FD_HOUR =
  FD_HOUR_WORD +
  "(?: y (?:media|cuarto|veinte|diez|cinco)| menos cuarto| en punto)?" +
  "(?: (?:de la|por la) (?:manana|tarde|noche)| del mediodia)?";
/** «a las seis», «después de las 20», «a eso de las siete», «sobre la una», «tipo las 5», «entre las 5 y las 7». */
const FD_TIME_RE = new RegExp(
  ` (?:(?:a|sobre|hacia|para|tipo|como a|como|desde|hasta|entre|y|despues de|antes de|a partir de|a eso de|sobre eso de|alrededor de|cerca de) )?(?:la|las) ${FD_HOUR}(?= )`,
  "g",
);
/** «5 de la tarde», «las 6 y media de la mañana» without «a las»: an hour, never a day number. */
const FD_BARE_TIME_RE = new RegExp(
  ` ${FD_HOUR_WORD}(?: y (?:media|cuarto)| menos cuarto)? (?:de la (?:manana|tarde|noche)|del mediodia)(?= )`,
  "g",
);

/** Why a `fecha_dicha` could not be read as ONE day. */
export type FechaUnreadable = "unclear" | "multiple" | "past_word";

/**
 * The customer's words -> what they name, or why they cannot be read.
 * `undefined` ONLY when nothing was sent (not a string, or blank).
 * FAIL-CLOSED: every word must be understood; any leftover word, a second
 * day, or a past word («ayer», «el lunes pasado») is NOT guessed around.
 */
export function readFechaDicha(
  raw: unknown,
): { ok: true; said: FechaDichaParsed } | { ok: false; why: FechaUnreadable } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  if (typeof raw !== "string" || raw.length > 120) return { ok: false, why: "unclear" };
  let s = ` ${foldEs(raw).split(" ").map(normaliseNumberWord).join(" ")} `;
  const out: FechaDichaParsed = {};
  const unclear = { ok: false as const, why: "unclear" as const };
  const take = (re: RegExp): RegExpExecArray[] => {
    const found = [...s.matchAll(new RegExp(re.source, "g"))];
    s = s.replace(new RegExp(re.source, "g"), " ").replace(/\s+/g, " ");
    if (!s.startsWith(" ")) s = ` ${s}`;
    if (!s.endsWith(" ")) s = `${s} `;
    return found;
  };

  // 1. Hours are not part of the day.
  s = s.replace(FD_TIME_RE, " ").replace(FD_BARE_TIME_RE, " ");
  // 2. Past words: asked, never searched (but «pasado mañana» is a future day).
  if (/ (?:ayer|anteayer|antier) /.test(s) || / pasad[oa] (?!manana )/.test(s) || / hace /.test(s)) {
    return { ok: false, why: "past_word" };
  }
  // 3. «esta mañana / tarde / noche» = today; bands are not days.
  let offsets: Array<{ days: number; word: FechaDichaParsed["offsetWord"] }> = [];
  if (take(/ esta (?:manana|tarde|noche) /).length > 0) offsets.push({ days: 0, word: "hoy" });
  take(/ (?:por|de|en|a|durante) la (?:manana|tarde|noche) /);
  take(/ la (?:manana|tarde|noche) del? /);
  take(/ (?:a|al|sobre el|hacia el) mediodia /);
  // 4. Offsets.
  for (const _ of take(/ pasado manana /)) offsets.push({ days: 2, word: "pasado mañana" });
  for (const _ of take(/ manana /)) offsets.push({ days: 1, word: "mañana" });
  for (const _ of take(/ hoy /)) offsets.push({ days: 0, word: "hoy" });
  for (const m of take(/ (?:dentro de|en) (\d{1,2}|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince) (dias?|semanas?) /)) {
    // 2026-10-10 review: «una»/«un» were missing (RangeError / undefined).
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : m[1] === "una" || m[1] === "un" ? 1 : FD_NUMBER_WORDS[m[1]!];
    if (n === undefined || !Number.isFinite(n)) return unclear;
    offsets.push({ days: m[2]!.startsWith("semana") ? n * 7 : n, word: undefined });
  }
  // 5. Year, month and week qualifiers.
  const years = take(/ (20\d\d) /);
  if (years.length > 1) return { ok: false, why: "multiple" };
  if (years.length === 1) out.year = Number(years[0]![1]);
  if (take(/ (?:del? )?(?:mes que viene|proximo mes|mes siguiente|siguiente mes) /).length > 0) out.month = -1;
  if (take(/ (?:de )?este mes /).length > 0) out.month = out.month === -1 ? -2 : 0;
  if (take(/ (?:de )?(?:la )?(?:semana que viene|proxima semana|semana proxima|semana siguiente|siguiente semana) /).length > 0) out.nextWeek = true;
  if (take(/ (?:de )?esta semana /).length > 0) out.thisWeek = true;
  const weekdays = new Set<number>();
  if (take(/ (?:este |el )?(?:fin de semana|finde) /).length > 0) weekdays.add(6);
  // 6. Weekdays, months, numbers — and how many of each.
  for (const [word, dow] of Object.entries(FD_WEEKDAYS)) {
    if (take(new RegExp(` ${word} `)).length > 0) weekdays.add(dow);
  }
  const months = new Set<number>();
  for (const [word, month] of Object.entries(FD_MONTHS)) {
    if (take(new RegExp(` ${word} `)).length > 0) months.add(month);
  }
  const numbers = new Set<number>();
  for (const m of take(/ (veinte|treinta|diez) y (uno|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve) /)) {
    numbers.add({ veinte: 20, treinta: 30, diez: 10 }[m[1] as "veinte"]! + FD_UNITS[m[2]!]!);
  }
  for (const m of take(/ (\d{1,2}) /)) numbers.add(Number(m[1]));
  for (const [word, n] of Object.entries(FD_NUMBER_WORDS)) {
    if (take(new RegExp(` ${word} `)).length > 0) numbers.add(n);
  }
  if (take(/ (?:proximo|proxima|que viene|siguiente) /).length > 0) out.next = true;
  if (take(/ otro /).length > 0) out.other = true;
  const alternatives = take(/ (?:o|u|ni) /).length > 0;

  // 7. Fail-closed: every word understood, ONE day named.
  const leftover = s.trim().split(" ").filter((t) => t !== "" && !FD_FILLERS.has(t));
  if (leftover.length > 0) return unclear;
  const offsetDays = new Set(offsets.map((o) => o.days));
  if (weekdays.size > 1 || months.size > 1 || numbers.size > 1 || offsetDays.size > 1) {
    return { ok: false, why: "multiple" };
  }
  const named = offsets.length + weekdays.size + numbers.size;
  if (alternatives && named > 1) return { ok: false, why: "multiple" };
  if (out.month === -2) return { ok: false, why: "multiple" };
  if (offsets.length > 0) {
    out.offset = offsets[0]!.days;
    if (offsets[0]!.word !== undefined) out.offsetWord = offsets[0]!.word;
  }
  if (weekdays.size === 1) out.weekday = [...weekdays][0]!;
  if (months.size === 1) {
    if (out.month === -1 || out.month === 0) return { ok: false, why: "multiple" };
    out.month = [...months][0]!;
  }
  if (numbers.size === 1) out.day = [...numbers][0]!;
  if (out.day !== undefined && (out.day < 1 || out.day > 31)) return unclear;
  if (named === 0 && out.nextWeek !== true && out.thisWeek !== true) return unclear;
  return { ok: true, said: out };
}

/** {@link readFechaDicha}, as the parsed day or undefined (tests and old callers). */
export function parseFechaDicha(raw: unknown): FechaDichaParsed | undefined {
  const read = readFechaDicha(raw);
  return read?.ok === true ? read.said : undefined;
}

function fdEpoch(y: number, m: number, d: number): number | undefined {
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? ms : undefined;
}

function dowOf(ms: number): number {
  return new Date(ms).getUTCDay();
}

/** The `weekday` nearest to `ms` (either side), never before `todayMs`. */
function nearestWeekdayTo(ms: number, weekday: number, todayMs: number): number {
  const forward = ms + (((weekday - dowOf(ms) + 7) % 7) * DAY_MS);
  const backward = forward === ms ? ms : forward - 7 * DAY_MS;
  if (backward < todayMs) return forward;
  return forward - ms <= ms - backward ? forward : backward;
}

/**
 * The customer's words -> the date to search, a week to scan, or a question to
 * ask. `undefined` when the words name no day at all (the request is then
 * answered exactly as without `fecha_dicha`).
 */
export function resolveFechaDicha(raw: unknown, ctx: FechaContext): FechaResolution | undefined {
  const read = readFechaDicha(raw);
  if (read === undefined) return undefined;
  if (!read.ok) return { kind: "question", reason: read.why, candidates: [] };
  return resolveSaid(read.said, ctx);
}

/** The shared core: what was said (from the text, or from the pieces) -> date, week or question. */
function resolveSaid(said: FechaDichaParsed, ctx: FechaContext): FechaResolution | undefined {
  if (said.offset !== undefined && (!Number.isInteger(said.offset) || said.offset < 0)) {
    return { kind: "question", reason: "unclear", candidates: [] };
  }
  const today = epochOf(ctx.todayIso);
  if (today === undefined) return undefined;
  const closed = ctx.closedWeekdays ?? new Set([0, 1]);
  const todayDate = new Date(today);
  const ty = todayDate.getUTCFullYear();
  const tm = todayDate.getUTCMonth() + 1;
  const td = todayDate.getUTCDate();
  const isOpen = (ms: number): boolean => !closed.has(dowOf(ms));
  const bookable = (dates: number[]): string[] =>
    [...new Set(dates.filter((ms) => ms >= today && isOpen(ms)))].map(isoOf);

  /** A weekday that does not match `ms`: never searched, always asked. */
  const mismatch = (ms: number, weekday: number): FechaResolution => ({
    kind: "question",
    reason: "weekday_mismatch",
    date: isoOf(ms),
    saidWeekday: weekday,
    ...(said.offsetWord !== undefined && said.day === undefined ? { offsetWord: said.offsetWord } : {}),
    candidates: bookable([ms, nearestWeekdayTo(ms, weekday, today)]),
  });

  // 1. «hoy», «mañana», «pasado mañana», «dentro de N días».
  if (said.offset !== undefined && said.day === undefined) {
    const ms = today + said.offset * DAY_MS;
    if (said.weekday !== undefined && dowOf(ms) !== said.weekday) return mismatch(ms, said.weekday);
    return { kind: "date", date: isoOf(ms) };
  }

  // 2. A day number, with or without month / weekday.
  if (said.day !== undefined) {
    const n = said.day;
    let ms: number | undefined;
    let rolled: "next_month" | "next_year" | undefined;
    if (said.month !== undefined && said.month > 0) {
      const m = said.month;
      const y = said.year ?? ty;
      ms = fdEpoch(y, m, n);
      if (ms === undefined) return { kind: "question", reason: "invalid_day", day: n, month: m, candidates: [] };
      if (ms < today) {
        // Explicit past («el 5 de octubre» on the 10th): asked. Far past
        // without a year («el 5 de enero» in October): next year.
        if (said.year !== undefined || today - ms <= 183 * DAY_MS) {
          return { kind: "question", reason: "past", date: isoOf(ms), candidates: [] };
        }
        ms = fdEpoch(y + 1, m, n);
        if (ms === undefined) return { kind: "question", reason: "invalid_day", day: n, month: m, candidates: [] };
        rolled = "next_year";
      }
    } else {
      // No month: this month if the number has not passed, else next month.
      const wantNext = said.month === -1 || (said.month !== 0 && n < td);
      const y = wantNext && tm === 12 ? ty + 1 : ty;
      const m = wantNext ? (tm === 12 ? 1 : tm + 1) : tm;
      ms = fdEpoch(y, m, n);
      if (ms === undefined) return { kind: "question", reason: "invalid_day", day: n, month: m, candidates: [] };
      if (ms < today) return { kind: "question", reason: "past", date: isoOf(ms), candidates: [] };
      if (wantNext && said.month !== -1) rolled = "next_month";
    }
    if (said.weekday !== undefined && dowOf(ms) !== said.weekday) return mismatch(ms, said.weekday);
    if (said.offset !== undefined && ms !== today + said.offset * DAY_MS) {
      // «mañana 16» when tomorrow is the 11th: two different days, asked.
      const offsetMs = today + said.offset * DAY_MS;
      return {
        kind: "question",
        reason: "offset_mismatch",
        date: isoOf(offsetMs),
        ...(said.offsetWord !== undefined ? { offsetWord: said.offsetWord } : {}),
        candidates: bookable([offsetMs, ms]),
      };
    }
    return { kind: "date", date: isoOf(ms), ...(rolled !== undefined ? { rolled } : {}) };
  }

  const todayDow = dowOf(today);
  const mondayThisWeek = today - (((todayDow + 6) % 7) * DAY_MS);

  // 3. A weekday without a number.
  if (said.weekday !== undefined) {
    const w = said.weekday;
    if (said.other === true) {
      const first = today + ((((w - todayDow + 7) % 7) || 7) * DAY_MS);
      return { kind: "question", reason: "ambiguous_other", saidWeekday: w, candidates: bookable([first, first + 7 * DAY_MS]) };
    }
    if (said.nextWeek === true) {
      return { kind: "date", date: isoOf(mondayThisWeek + 7 * DAY_MS + (((w + 6) % 7) * DAY_MS)) };
    }
    if (said.thisWeek === true) {
      const ms = mondayThisWeek + (((w + 6) % 7) * DAY_MS);
      if (ms < today) {
        return { kind: "question", reason: "past", date: isoOf(ms), saidWeekday: w, candidates: bookable([ms + 7 * DAY_MS]) };
      }
      return { kind: "date", date: isoOf(ms) };
    }
    let delta = (w - todayDow + 7) % 7;
    if (said.next === true && delta === 0) delta = 7;
    if (delta === 0 && !ctx.todayStillOpen) delta = 7;
    return { kind: "date", date: isoOf(today + delta * DAY_MS) };
  }

  // 4. A whole week.
  if (said.nextWeek === true) {
    return { kind: "week", from: isoOf(mondayThisWeek + 7 * DAY_MS), days: 7 };
  }
  if (said.thisWeek === true) {
    return { kind: "week", from: isoOf(today), days: 7 - ((todayDow + 6) % 7) };
  }
  return undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// 2026-10-10 (v3, decided by the orchestrator) — THE PIECES ARE THE AUTHORITY.
// ════════════════════════════════════════════════════════════════════════════
//
// Free Spanish cannot be parsed to closure: some phrase always escapes. The
// model is good at EXTRACTING pieces and bad at CALCULATING dates, so it now
// sends the pieces the customer said and the server does the arithmetic:
//
//   dia_semana  lunes…domingo            «el jueves»
//   dia_mes     1..31 (never an hour)    the 16 of «jueves 16»
//   mes         1..12                    «de noviembre»
//   relativo    hoy | mañana | pasado_mañana
//   proximo     true only for «próximo» / «que viene»
//   en_dias     1..60                    «en 3 días», «dentro de una semana» = 7
//
// `en_dias` is a piece (not a prompt-side conversion) for the same reason as
// `dia_mes`: the model only COPIES a number the customer said; adding it to
// today is exactly the arithmetic it got wrong.
//
// `fecha_dicha` (the literal words) is only the CROSS-CHECK: when the text
// analyser above reads it confidently and it names another day (or a
// conflict), the customer is asked. When it cannot read it, it is ignored —
// that was the source of the over-asking.

export const FECHA_PIECE_FIELDS = ["dia_semana", "dia_mes", "mes", "relativo", "proximo", "en_dias"] as const;

const PIECE_WEEKDAYS: Readonly<Record<string, number>> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};
const PIECE_RELATIVE: Readonly<Record<string, { days: number; word: FechaDichaParsed["offsetWord"] }>> = {
  hoy: { days: 0, word: "hoy" },
  manana: { days: 1, word: "mañana" },
  pasado_manana: { days: 2, word: "pasado mañana" },
  "pasado manana": { days: 2, word: "pasado mañana" },
};

/** «16», 16, "16" -> 16; null / "" / "null" -> null (not sent); anything else -> NaN (invalid). */
function pieceInt(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : Number.NaN;
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (t === "" || t === "null" || t === "none") return null;
    return /^\d{1,2}$/.test(t) ? Number(t) : Number.NaN;
  }
  return Number.NaN;
}

function pieceWord(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const t = foldEs(raw).replace(/ /g, "_");
  return t === "" || t === "null" || t === "none" ? null : t;
}

/**
 * The pieces of a request body. `undefined` when NONE was sent (then the
 * request is answered from `date`, as the live prompt expects). `ok: false`
 * when one was sent with an unusable value (fail-closed: asked).
 */
export function readFechaPiezas(
  body: Record<string, unknown>,
): { ok: true; said: FechaDichaParsed } | { ok: false } | undefined {
  const dow = pieceWord(body["dia_semana"]);
  const day = pieceInt(body["dia_mes"]);
  const month = pieceInt(body["mes"]);
  const rel = pieceWord(body["relativo"]);
  const inDays = pieceInt(body["en_dias"]);
  const nextRaw = body["proximo"];
  // Review 2026-10-10: a non-boolean `proximo` is asked, never ignored.
  if (nextRaw !== undefined && nextRaw !== null && typeof nextRaw !== "boolean") return { ok: false };
  const next = nextRaw === true;
  const sent = dow !== null || day !== null || month !== null || rel !== null || inDays !== null;
  if (!sent) return undefined; // `proximo` alone names no day
  const said: FechaDichaParsed = {};
  if (dow !== null) {
    const w = dow === undefined ? undefined : PIECE_WEEKDAYS[dow];
    if (w === undefined) return { ok: false };
    said.weekday = w;
  }
  if (day !== null) {
    if (!(day >= 1 && day <= 31)) return { ok: false };
    said.day = day;
  }
  if (month !== null) {
    if (!(month >= 1 && month <= 12) || day === null) return { ok: false }; // a month alone is no day
    said.month = month;
  }
  if (rel !== null) {
    const r = rel === undefined ? undefined : PIECE_RELATIVE[rel];
    if (r === undefined) return { ok: false };
    said.offset = r.days;
    said.offsetWord = r.word;
  }
  if (inDays !== null) {
    if (!(inDays >= 1 && inDays <= 60) || rel !== null) return { ok: false };
    said.offset = inDays;
  }
  if (next) said.next = true;
  return { ok: true, said };
}

export type FechaPiecesResolution =
  | FechaResolution
  | { kind: "question"; reason: "cross_check"; date: string; candidates: string[] };

/**
 * Pieces (authority) + `fecha_dicha` (cross-check) + the date the model sent
 * -> what to search, or the question to ask. `undefined`: nothing was sent,
 * answer from `date` exactly as before.
 */
export function resolveFechaPiezas(
  body: Record<string, unknown>,
  ctx: FechaContext,
  sentDate: string | undefined,
): FechaPiecesResolution | undefined {
  const pieces = readFechaPiezas(body);
  const text = readFechaDicha(body["fecha_dicha"]);
  const ask = (reason: FechaUnreadable): FechaResolution => ({ kind: "question", reason, candidates: [] });

  // What the text says, when it is read CONFIDENTLY (unclear text is ignored).
  let textSays: FechaResolution | undefined;
  if (text !== undefined) {
    textSays = text.ok ? resolveSaid(text.said, ctx) : text.why === "unclear" ? undefined : ask(text.why);
  }

  let main: FechaResolution | undefined;
  if (pieces === undefined) {
    // No pieces: `date` stays the authority (live prompt). The text can only object
    // — except a whole week («la semana que viene»), which no piece can say:
    // discover asks the day, scan reads Monday to Sunday of next week.
    if (textSays === undefined) return undefined;
    if (textSays.kind === "week") return textSays;
    if (sentDate === undefined) return undefined;
    if (textSays.kind === "question") return textSays;
    if (textSays.kind === "date" && textSays.date !== sentDate) return crossCheck(sentDate, textSays.date, ctx);
    return undefined;
  }
  if (!pieces.ok) return ask("unclear");
  main = resolveSaid(pieces.said, ctx);
  if (main === undefined || main.kind !== "date") return main;
  if (textSays === undefined || textSays.kind === "week") return main;
  if (textSays.kind === "question") return textSays;
  return textSays.date === main.date ? main : crossCheck(main.date, textSays.date, ctx);
}

function crossCheck(piecesDate: string, textDate: string, ctx: FechaContext): FechaPiecesResolution {
  const closed = ctx.closedWeekdays ?? new Set([0, 1]);
  const today = epochOf(ctx.todayIso) ?? 0;
  const candidates = [piecesDate, textDate].filter((d) => {
    const ms = epochOf(d);
    return ms !== undefined && ms >= today && !closed.has(dowOf(ms));
  });
  return { kind: "question", reason: "cross_check", date: piecesDate, candidates };
}
