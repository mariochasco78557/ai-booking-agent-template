import { readExpectedOption, type ExpectedOption } from "../../utils/expectedOption.js";
import type { AgendaDay } from "../agenda/agendaSource.js";
import { freeFor } from "../agenda/agendaSource.js";
import type { AgendaRead } from "../agenda/agendaCache.js";
import type { AgendaReader } from "../agenda/agendaReader.js";
import type { SlotAuthorizationService } from "../slotAuthorization.js";
import type { VoiceOfferStore } from "../voiceOfferStore.js";
import {
  BALANCED_CONTINUATION_MAX_SLOTS,
  BALANCED_OPTION_MAX_OPTIONS,
  type BalancedContinuation,
  type BalancedOption,
  type BalancedOptionStore,
  type BalancedScanContinuation,
} from "./balancedOptionStore.js";
import { leastLoadedEmployee, type BalanceCandidate } from "./employeeBalance.js";
import type { EmployeeNameDirectory } from "../employeeNameDirectory.js";
import {
  BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
  BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE,
  BALANCED_INVALID_REQUEST_MESSAGE,
  BALANCED_NO_AVAILABILITY_MESSAGE,
  BALANCED_OPTION_UNKNOWN_MESSAGE,
  BALANCED_SLOT_TAKEN_MESSAGE,
  BALANCED_CLOSED_AFTERNOON_MESSAGE,
  BALANCED_CLOSED_DAY_MESSAGE,
  BALANCED_SCAN_ALL_CLOSED_MESSAGE,
  balancedEmployeeAlternativeMessage,
  balancedEmployeeUnavailableMessage,
  balancedExtendedLookAheadMessage,
  balancedLockedMessage,
  balancedLockMismatchMessage,
  balancedLookAheadMessage,
  balancedLookAheadNothingMessage,
  balancedAskOtherDayMessage,
  balancedLookAheadTwoWeeksNothingMessage,
  balancedMoreOptionsMessage,
  balancedNoMoreOptionsMessage,
  balancedOptionsMessage,
  balancedPeriodAlternativeMessage,
  balancedPreferredTimeMessage,
  balancedScanExtendedMessage,
  balancedScanMessage,
  balancedScanNoAvailabilityMessage,
  balancedScanNoMoreMessage,
  balancedOwnBookingMessage,
  balancedScanTwoWeeksNothingMessage,
  balancedScanWeekdayAfternoonClosedMessage,
  balancedScanWeekdayClosedMessage,
  balancedScanWeekdayNoAvailabilityMessage,
  oppositePeriod,
  type TimePeriod,
  withSpokenDayEs,
  balancedDateQuestionMessage,
  balancedLockSummaryEs,
} from "../../utils/balancedPhrasing.js";
import {
  BALANCED_MAX_OPTIONS,
  BALANCED_SCAN_DEADLINE_MS,
  BALANCED_SCAN_MAX_DAYS,
  BALANCED_SCAN_MAX_PER_DAY,
  BALANCED_SCAN_UPSTREAM_CAPACITY_DEFAULT,
  BALANCED_WA_MAX_OPTIONS_DEFAULT,
  BALANCED_WA_MAX_OPTIONS_MAX,
  balancedScanFanOut,
  clampBalancedWaMaxOptions,
  type BalancedDiscoverOutcome,
  type BalancedLockOutcome,
} from "../../schemas/balancedV2Schemas.js";
import {
  CONVERSATION_ID_MAX_LENGTH,
  CONVERSATION_ID_MIN_LENGTH,
  CONVERSATION_ID_RE,
} from "../../schemas/aiSchemas.js";
import {
  parseDateTime,
  timeLabelFromString,
  weekdayEs,
} from "../../utils/dateFormatterEs.js";
import { mapWithConcurrency } from "../../utils/concurrency.js";
// The salon's own calendar day. Imported from where it already lives rather
// than copied: "today" has to mean the same day for the refresher's window and
// for a caller's «esta semana», and two implementations of a timezone are two
// implementations that will disagree on one Sunday in October.
//
// *** FROM `src/utils/madridDate.ts`, NOT FROM THE REFRESHER. ***
//
// That is where both functions actually live (they were lifted out of
// `agendaRefresher.ts` precisely so a second caller would not have to import a
// background scheduler to learn what day it is). `agendaRefresher.ts` still
// re-exports them for its own callers, so the two spellings resolve to one
// implementation — but a voice read path importing the CACHE REFRESHER to
// format «mañana» is a dependency edge nobody could defend, and the one that
// would quietly drag the refresher into any build that only wanted a date.
import { madridDate, madridWallClock } from "../../utils/madridDate.js";
import { FECHA_PIECE_FIELDS, parseDayName, resolveDayName, resolveFechaPiezas } from "../../utils/dayName.js";
import {
  DEFAULT_MIN_LEAD_MINUTES,
  isSlotAfterEarlyClose,
  isSlotTooSoon,
  withoutAfterCloseSlots,
  withoutTooSoonSlots,
  type EarlyCloseMap,
} from "../../utils/slotLeadTime.js";

/**
 * *** THE BALANCED V2 READ PATH — discover, then lock. ***
 *
 * Read `src/services/balanced/balancedOptionStore.ts` first for why the flow is
 * split in two, and `employeeBalance.ts` for how a barber is chosen. This file
 * is the part that talks to the agenda and decides what the caller hears.
 *
 * ── THE PROPERTY THAT MATTERS MOST ────────────────────────────────────────
 *
 * **Discovery cannot authorize a write.** `discover`, `more` and `scan` mint no
 * `slot_token` — and, since ADR-022, they do not touch the V2 offer store at
 * all. **Only a LOCK changes what is bookable**: a successful lock replaces
 * the previous lock's token, atomically, and nothing else does. So the one
 * bookable hueco of a conversation is always EXACTLY the slot sealed by its
 * most recent successful lock — the one whose `slot` (date, time, professional)
 * the agent read the summary from.
 *
 * Why browsing no longer retires the lock ((internal doc, not included in the template) ADR-022): in V2 a
 * query never puts a token in the agent's hands, so the ADR-019 failure «offer
 * 18:00, book the 10:00 token still in context» cannot be reached by choosing
 * a new hour — choosing one REQUIRES a lock, and that lock supersedes the old
 * token. Retiring the lock on browsing only produced the production incident
 * of 2026-09-14 (lock Ramón 09:00 → «¿y con Olga?» → create refused) and the
 * unsafe silent re-lock-by-index retry the prompt then needed.
 *
 * A lock suspends the previous token at ENTRY (before the fresh agenda read)
 * and puts it back if the lock does not succeed. See {@link lock}.
 *
 * ── "SOLO ME QUEDAN DOS" IS A CLAIM ABOUT THE SALON ───────────────────────
 *
 * Counting is done over UNIQUE HOURS, not over (hour, barber) pairs. If Bruno
 * and Olga are both free at ten, the salon has ONE ten o'clock, not two. The
 * V1 path never had to be careful about this because it spoke about a barber's
 * diary; the V2 script says "ese día solo me quedan las diez y las once" about
 * the whole shop, and that sentence is only true if the deduplication happens
 * before the count.
 *
 * ── WHO IS ELIGIBLE ───────────────────────────────────────────────────────
 *
 * `/user/employees-day` already has holidays, vacations and absences applied
 * upstream: a barber who is away is simply not in the roster. `/user/free`
 * already has existing appointments and breaks applied: a booked hour is simply
 * not a slot, and a barber with no free hour at all is ABSENT from the array
 * rather than present with an empty one. This service therefore never infers an
 * absence, never synthesises an hour, and never assumes a weekly pattern — it
 * intersects the two lists and stops.
 */

/**
 * One day of a window, as `action: "scan"` reports it.
 *
 * This is what lets the agent say «el jueves tengo cuatro huecos y el viernes
 * solo uno» without a second tool call, and every field is a fact about the
 * SALON rather than about the page:
 *
 * - `count` is the day's unique free hours BEFORE the caller's time filter, so
 *   «ese día tengo hueco, pero no a partir de las cinco» is sayable;
 * - `matching_count` is how many survive the filter, UNCAPPED — the two-per-day
 *   ranking cap bounds what is OFFERED, never what is COUNTED, or the number
 *   the agent speaks would be a property of the page.
 */
export interface BalancedScanDaySummary {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `"jueves"`. Spoken, so the agent never has to derive it from the date. */
  weekday_es: string;
  /** Unique free hours that day before the caller's time constraint. */
  count: number;
  /** Earliest hour that SATISFIES the constraint. */
  first_time: string;
  /** Latest hour that satisfies it. */
  last_time: string;
  /** How many hours satisfy it, before the per-day offer cap. */
  matching_count: number;
}

/** One option as it appears in a discovery answer. NEVER carries a barber. */
export interface BalancedDiscoverOption {
  option_index: number;
  date: string;
  time: string;
}

export interface BalancedDiscoverResult {
  outcome: BalancedDiscoverOutcome;
  available: boolean;
  message: string;
  options: BalancedDiscoverOption[];
  /**
   * Unique compatible hours the salon has in the band actually offered.
   *
   * STABLE ACROSS PAGES: it describes the band, not the page, so the agent can
   * say "de las seis que tengo" on page one and page two without the number
   * moving underneath it.
   */
  total_unique_slots: number;
  /**
   * True when hours remain that this conversation has NOT been offered yet —
   * and therefore when `action: "more"` has something to answer with. It is
   * read off the frozen ranking, so the sentence that repeats it is a fact
   * rather than a hope.
   */
  has_more: boolean;
  requested_period: TimePeriod | null;
  offered_period: TimePeriod | null;
  /** True when the band was flipped because the requested one was empty. */
  period_fallback: boolean;
  /** 1 for a `discover`, 2, 3 … for each `more`. Diagnostic, never spoken. */
  page_index?: number;
  /** How many hours this conversation has been read out loud in total. */
  offered_so_far?: number;
  /**
   * `scan` only: the shape of the window, day by day. Present only for days
   * with at least one matching hour, so an empty entry never has to be spoken.
   */
  days_summary?: BalancedScanDaySummary[];
  /**
   * `scan` only: the days that were actually READ before the deadline.
   *
   * *** IT IS THE HONESTY FIELD. *** An answer built from five of seven days
   * is not "the salon has nothing on the other two"; it is "I did not look".
   * The agent is given the set it may speak about, never a silence it could
   * mistake for a negative.
   */
  days_checked?: string[];
  /** `scan` only: true when a day of the window did not arrive in time. */
  partial?: boolean;
  /**
   * `discover` look-ahead only: the day the caller asked for, which had no
   * hour (full or closed). Present together with `date_fallback: true`, and
   * the options then belong to a LATER day — read their own `date`.
   */
  requested_date?: string;
  /**
   * 2026-10-08 — present only when `day_name` disagreed with the date sent:
   * the date the agent sent. The date actually searched is in the options.
   */
  date_corrected_from?: string;
  /** `discover` look-ahead only: true when the page is for a later day. */
  date_fallback?: boolean;
  /**
   * 2026-10-10 — `outcome: "date_conflict"` only: why the customer's words
   * (`fecha_dicha`) named no single bookable day, and the dates the question
   * offers (`YYYY-MM-DD`, 0 to 2). Data for the agent, never spoken.
   */
  date_issue?: string;
  date_options?: string[];
  /**
   * On an empty look-ahead (`discover`) or an empty multi-day `scan`: the
   * `date_from` a follow-up «la semana siguiente» scan should use — the first
   * day NOT covered by the search just answered. Never spoken.
   */
  next_search_from?: string;
  /**
   * ADR-026, V5 requests only: the page mixes the requested day with the
   * nearest LATER day that has what the caller asked for (the requested band,
   * with the requested professional when one was named). This is that later
   * option — the LAST one of the page — with who has it. Absent on every V4
   * answer and on every page that is not such a mix.
   */
  next_in_requested_period?: {
    date: string;
    time: string;
    employee_name: string;
  };
  external_mutation: false;
}

/** How many same-day hours an ADR-026 mixed page offers before the later one. */
const ALTERNATIVE_SAME_DAY_OPTIONS = 2;

export interface BalancedLockedSlot {
  date: string;
  time: string;
  reservation_date: string;
  employee_id: number;
  employee_name: string;
  /** The ONLY token `/ai/voice/v2/book` accepts. Minted here and nowhere else. */
  slot_token: string;
}

export interface BalancedLockResult {
  outcome: BalancedLockOutcome;
  locked: boolean;
  message: string;
  slot?: BalancedLockedSlot;
  /**
   * 2026-10-10 — `locked` only: the summary, written by the server from the
   * slot just locked («Te resumo: corte de pelo, el viernes dieciséis de
   * octubre a las seis de la tarde, con Ramón»). The agent reads it as is
   * and appends only the name and the phone.
   */
  summary?: string;
  /**
   * On `employee_unavailable`, who the caller currently HAS. Present so the
   * agent can offer to keep them without a second round trip — the refusal and
   * the fallback arrive together.
   */
  current_employee_id?: number;
  current_employee_name?: string;
  /**
   * 2026-10-09 (call r3557a) — only when the lock carried `option_time` /
   * `option_date`. `option_mismatch: true` on an `option_not_found` that
   * happened because the most recent page holds no such option (nothing was
   * locked); `requested_time` / `requested_date` echo what the agent asked for.
   */
  option_mismatch?: true;
  requested_time?: string;
  requested_date?: string;
  /**
   * 2026-10-09 — the `option_index` the agent sent, when it pointed at another
   * hour and the page held exactly one option matching `option_time` /
   * `option_date`, which is the one locked.
   */
  option_index_corrected_from?: number;
  external_mutation: false;
}

/**
 * 2026-10-09 (call r3557a) — what the agent BELIEVES it is locking, read by
 * the route from the raw body (`option_time`, `option_date`), never through
 * the Zod schema, exactly like `day_name`. Absent or unreadable: `lock`
 * behaves exactly as before, by `option_index` alone.
 */
export interface BalancedLockOptions {
  optionTime?: unknown;
  optionDate?: unknown;
  /**
   * 2026-10-11 — the VERIFIED phone of the caller (WhatsApp header / caller id,
   * never a model field), E.164. With {@link BalancedAvailabilityDeps.ownBookingAt}
   * it arms the `own_booking_at_time` guard. Absent = no guard.
   */
  callerPhoneE164?: string;
  /** The request is WhatsApp: picks the wording of the guard's `message`. */
  whatsApp?: boolean;
}

/** The caller's own standing appointment at an hour (see `ownBookingAt`). */
export interface OwnBookingHit {
  employeeName?: string | null;
}

/**
 * 2026-10-11 — is there a standing appointment of THIS phone at `date` `time`
 * (and, if given, with this professional)? Implementations MUST fail open
 * (resolve `undefined`) and never log the phone.
 */
export type OwnBookingPort = (
  phoneE164: string,
  date: string,
  time: string,
  employeeId?: number,
) => Promise<OwnBookingHit | undefined>;

function matchesExpected(option: BalancedOption, expected: ExpectedOption): boolean {
  if (expected.time !== undefined && option.time !== expected.time) return false;
  if (expected.date !== undefined && option.date !== expected.date) return false;
  return true;
}

export interface BalancedAvailabilityDeps {
  /** The one door to the salon's agenda. `readFresh` bypasses every cache. */
  agenda: AgendaReader;
  /** This call's numbered hours. Not a hold, not a credential. */
  options: BalancedOptionStore;
  /**
   * Mints the V2 `slot_token`. Deliberately a DIFFERENT instance from the one
   * `/ai/voice/availability` uses, keyed on a derived secret — see
   * `src/services/container.ts`. A V1 token therefore fails the V2 AEAD tag and
   * a V2 token fails V1's, so neither flow can spend the other's authorization
   * and `ENABLE_BALANCED_V2_CREATE` cannot be sidestepped by pointing a V2
   * token at the stable route.
   */
  slotAuthorization: SlotAuthorizationService;
  /**
   * Which token this call is currently holding. The V2 instance of the same
   * store `/ai/voice/book` uses, so a locked hueco gets the identical
   * "is this the one on the table right now" guarantee (ADR-019).
   */
  offerStore: VoiceOfferStore;
  logger?: {
    warn: (detail: Record<string, unknown>, message: string) => void;
    info?: (detail: Record<string, unknown>, message: string) => void;
  };
  /**
   * Where the day's roster is remembered by id
   * (`src/services/employeeNameDirectory.ts`).
   *
   * `lock` is the only writer, and it writes what it has already read: the
   * fresh roster it authorized the hueco against. The reader is the WhatsApp
   * confirmation, which by then holds an `employee_id` and nothing else —
   * `EffectiveBooking` is built from the sealed token, on purpose.
   *
   * Optional, and absent by default, so every existing construction is
   * unchanged. Nothing here reads it and no decision depends on it: a name
   * that is missing costs a written message a nicer sentence, never anything
   * about the appointment.
   */
  employeeNames?: EmployeeNameDirectory;
  /**
   * How long `scan` waits for the salon before answering with what it has.
   *
   * Defaults to {@link BALANCED_SCAN_DEADLINE_MS}, which is the only value
   * production uses. It is a constructor seam purely so a test can prove the
   * PARTIAL path in milliseconds instead of sleeping for the real deadline —
   * the behaviour under test is "a day that has not arrived is reported as not
   * checked", and that is a property of the mechanism, not of the number.
   */
  scanDeadlineMs?: number;
  /**
   * The process's `UPSTREAM_MAX_CONCURRENCY` — the capacity of the ONE limiter
   * every upstream call in this process queues on.
   *
   * The scan needs the number because it must fan out to strictly FEWER days
   * than the limiter can hold: see {@link balancedScanFanOut} for the starvation
   * this prevents. It is a dependency rather than a config read because this
   * service has never read env, and because a test proving the fan-out has to be
   * able to state the capacity it is proving it against.
   *
   * Defaults to {@link BALANCED_SCAN_UPSTREAM_CAPACITY_DEFAULT}, which is the
   * env var's own default.
   */
  upstreamMaxConcurrency?: number;
  /**
   * The salon's static weekly closure, as the set of `getUTCDay()` weekdays it
   * never opens on. Sourced from `BALANCED_CLOSED_WEEKDAYS` in
   * `src/services/container.ts` — this service never reads env itself, for the
   * same reason `upstreamMaxConcurrency` is a constructor seam rather than a
   * config read: a test proving the closed-day behaviour has to be able to
   * state the set it is proving it against.
   *
   * Defaults to `{0, 1}` (Sunday, Monday) — the env var's own default — so
   * every existing test that never mentions this dependency keeps building the
   * exact posture it always has.
   */
  closedWeekdays?: ReadonlySet<number>;
  /**
   * `BALANCED_EARLY_CLOSE`: weekday (`getUTCDay()`) to the minute of day from
   * which the salon is closed (Saturday 14:00 = `[6, 840]`). Slots at/after it
   * are never offered, locked or booked, and an afternoon question on such a
   * day is answered closed-style WITHOUT reading upstream. Only a filter on
   * top of the live agenda. Defaults to none (the env default lives in config).
   */
  earlyClose?: EarlyCloseMap;
  /**
   * `BALANCED_MIN_LEAD_MINUTES` (incident 2026-09-18). A slot of TODAY whose
   * start is not strictly later than now + this many minutes is never offered,
   * locked or booked — see `src/utils/slotLeadTime.ts`. Applied to every
   * agenda read this service makes ({@link BalancedAvailabilityService.readAgenda}),
   * so ranking, period fallback, look-ahead, scan and `preferred_time` all see
   * the same filtered day. Defaults to {@link DEFAULT_MIN_LEAD_MINUTES}.
   */
  minLeadMinutes?: number;
  /**
   * `BALANCED_WA_MAX_OPTIONS` (owner request 2026-10-08): the page size of a
   * request that declared itself WhatsApp ({@link BalancedReadOptions.whatsApp}).
   * Clamped to 3..10 here as well as in the env schema. Defaults to
   * {@link BALANCED_WA_MAX_OPTIONS_DEFAULT}. Never used for a voice request.
   */
  whatsAppMaxOptions?: number;
  /**
   * 2026-10-11 ((internal doc, not included in the template) §3, bloque 0): the
   * `own_booking_at_time` guard. Absent = the guard never runs.
   */
  ownBookingAt?: OwnBookingPort;
}

/**
 * Per-request options of `discover` and `scan` (ADR-025). Decided by the route
 * from the request's agent profile — see `src/services/balanced/agentProfile.ts`.
 */
export interface BalancedReadOptions {
  /**
   * ADR-024 (V5 requests only). When true, an empty look-ahead or an empty,
   * fully read multi-day `scan` keeps reading up to
   * {@link EXTENDED_LOOKAHEAD_TOTAL_DAYS} days and offers the nearest day's
   * real hours. Absent/false: every answer is exactly the V4 one.
   */
  extendedLookAhead?: boolean;
  /**
   * ADR-026 (V5 requests only). When the requested band is full that day, or
   * the named professional has nothing that day while others do, `discover`
   * also offers the nearest later day that has what was asked (see
   * {@link BalancedAvailabilityService.discover}). Absent/false: V4 answers.
   */
  nearestAlternatives?: boolean;
  /**
   * 2026-10-08 (owner request): the request carried `x-ai-channel: whatsapp`,
   * so its pages hold up to `BALANCED_WA_MAX_OPTIONS` options instead of the
   * spoken three. Absent/false: every page is exactly the voice page. Also
   * accepted by `more`. Never consulted by `lock`, which reads the page size
   * stored with the page.
   */
  whatsApp?: boolean;
  /** 2026-10-11 — see {@link BalancedLockOptions.callerPhoneE164}. */
  callerPhoneE164?: string;
  /**
   * 2026-10-08 — the raw `day_name` of the request (the weekday, «hoy»,
   * «mañana» or «pasado mañana» the CUSTOMER said), read by the route from the
   * raw body. Corrects `date` (discover) / `date_from` (scan) when it
   * disagrees — see `src/utils/dayName.ts` — and makes a discover answer name
   * the day it searched. Absent or unreadable: the answer is exactly what it
   * was without it.
   */
  dayName?: unknown;
  /**
   * 2026-10-10 (v3) — the day PIECES of the request (`dia_semana`, `dia_mes`,
   * `mes`, `relativo`, `proximo`, `en_dias`) plus `fecha_dicha`, read by the
   * route from the raw body; only the keys that were sent. The pieces decide
   * the date, `fecha_dicha` only cross-checks — see `resolveFechaPiezas` in
   * `src/utils/dayName.ts`. Absent: the answer is exactly what it was.
   */
  fechaPiezas?: Record<string, unknown>;
}

/** What a look-ahead page was built from, for an ADR-026 mixed page. */
interface LookAheadCapture {
  /** The offered day's hours, in offer order (nearest to `preferred_time` first). */
  ranked: readonly BalancedOption[];
  read: AgendaRead;
}

/** The salon's unique free hours in a per-barber map, in clock order. */
function uniqueTimesOf(freeByEmployee: ReadonlyMap<number, Set<string>>): string[] {
  const unique = new Set<string>();
  for (const times of freeByEmployee.values()) {
    for (const time of times) unique.add(time);
  }
  return [...unique].sort((a, b) => a.localeCompare(b));
}

/**
 * The chronologically LATEST `time` in a list of options — never the last
 * array element, because `rankOptions` orders by distance to a preferred hour
 * when the caller gave one, not by the clock. Undefined for an empty list.
 *
 * Feeds the "hasta las…" clause `balancedOptionsMessage` appends to a `discover`
 * answer with `has_more`, so a caller who hears "también tengo otros horarios
 * hasta la una y media" is hearing the true edge of the band, whatever order
 * the three spoken hours came in.
 */
function latestTimeOf(options: readonly { time: string }[]): string | undefined {
  return options.reduce<string | undefined>(
    (latest, option) => (latest === undefined || option.time > latest ? option.time : latest),
    undefined,
  );
}

/** `"jueves"` for a `YYYY-MM-DD`. Empty for anything that is not one. */
function weekdayEsOf(date: string): string {
  const parsed = parseDateTime(date);
  return parsed === null ? "" : weekdayEs(parsed);
}

/** Minutes from midnight for `"YYYY-MM-DD HH:mm:ss"` or `"HH:mm"`. */
function minutesOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * The morning/afternoon boundary, at 14:00.
 *
 * The same constant `VoiceBookingService` already applies to
 * `/ai/voice/availability`. Kept identical on purpose: two endpoints reading
 * one agenda must not disagree about what "por la tarde" means, or the same
 * hour would be morning on one tool and afternoon on the other.
 */
const AFTERNOON_FROM_MINUTES = 14 * 60;
/** 2026-10-10 — the salon's usual closing time (20:00), for «today still open». */
const SALON_CLOSE_MINUTES = 20 * 60;

function periodOf(start: string): TimePeriod {
  return minutesOf(timeLabelFromString(start)) < AFTERNOON_FROM_MINUTES
    ? "morning"
    : "afternoon";
}

/**
 * The barber's name as a person would say it.
 *
 * Upstream stores display names loosely — `"bruno "` with a trailing space is
 * the real, verified shape. Trimmed and capitalized, never invented: accents
 * this middleware does not receive are not added, because a name the salon
 * does not use is worse than an unaccented one.
 */
function spokenEmployeeName(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (cleaned === "") return "el profesional asignado";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Validated `discover` input. Built only after every field has been checked. */
interface DiscoverRequest {
  conversationId: string;
  serviceId: number;
  date: string;
  period: TimePeriod;
  preferredTime?: string;
  employeeId?: number;
  /** How many options a page of this request may hold. Absent = the spoken 3. */
  pageSize?: number;
  /**
   * 2026-10-09 (WhatsApp, owner's rule): when the day asked for has nothing,
   * SAY SO AND ASK — never offer another day's hours before the customer says
   * yes. The look-ahead is not run. Absent: the voice behaviour, unchanged.
   */
  askBeforeOtherDay?: boolean;
}

/**
 * Validated `more` input.
 *
 * Everything except the conversation id is OPTIONAL and is used for exactly one
 * purpose: to detect that the agent is continuing a page it is no longer
 * talking about. None of it can steer the answer — there is no field here that
 * could move the cursor, choose a band or name an hour, because the whole point
 * of a server-side continuation is that the model has nothing to reconstruct.
 */
interface MoreRequest {
  conversationId: string;
  date?: string;
  serviceId?: number;
  period?: TimePeriod;
  employeeId?: number;
}

/**
 * Validated `scan` input — a WINDOW and a constraint, never a single day.
 *
 * The asymmetry with {@link DiscoverRequest} is deliberate. There, `date` and
 * `time_period` are REQUIRED because the caller named a day and a half of it.
 * Here every field except the conversation and the service is optional and has
 * a defined default, because the question this action answers («¿cuándo tienes
 * algo?») is precisely the one a caller asks when they cannot name a day.
 */
interface ScanRequest {
  conversationId: string;
  serviceId: number;
  /** `YYYY-MM-DD`, never in the past. */
  dateFrom: string;
  /** 1..{@link BALANCED_SCAN_MAX_DAYS}. */
  days: number;
  /** Hard `HH:mm` floor. */
  afterTime?: string;
  /** Hard `HH:mm` ceiling. */
  beforeTime?: string;
  /** Hard band filter. A scan never falls back to the other band. */
  period?: TimePeriod;
  /** Soft: ranks the hours WITHIN each day, and nothing else. */
  preferredTime?: string;
  employeeId?: number;
  /** How many options a page of this request may hold. Absent = the spoken 3. */
  pageSize?: number;
  /** See {@link DiscoverRequest.askBeforeOtherDay}. */
  askBeforeOtherDay?: boolean;
  /**
   * 2026-10-11 — a `weekday` scan: the Spanish name of the weekday («sábado»)
   * and the exact dates of the window (that weekday only, `weeks` of them,
   * first one at or after `dateFrom`). When present, `days` is `dates.length`
   * and `dateFrom` is `dates[0]`.
   */
  weekdayName?: string;
  weekdayDates?: readonly string[];
}

/** Validated `lock` input. */
interface LockRequest {
  conversationId: string;
  optionIndex: number;
  preferredEmployeeId?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** A real calendar date, not merely a date-shaped string. */
function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function readConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < CONVERSATION_ID_MIN_LENGTH) return undefined;
  if (trimmed.length > CONVERSATION_ID_MAX_LENGTH) return undefined;
  if (!CONVERSATION_ID_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * A positive integer, from a number or from the string a model may send
 * instead.
 *
 * Accepting `"2"` is not laxity: an employee id that arrived as a string is
 * the single most common shape error a voice tool produces, and refusing it
 * would answer `invalid_request` to a request whose MEANING is unambiguous. A
 * value that is not a positive integer in either form is still refused.
 */
/** An `HH:mm` the caller mentioned, or nothing. Never a partial guess. */
function readTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // 2026-10-10: «9:30» is the same hour as «09:30».
  const padded = /^\d:\d{2}$/.test(trimmed) ? `0${trimmed}` : trimmed;
  return TIME_RE.test(padded) && isWallClock(padded) ? padded : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isInteger(numeric) || numeric <= 0) return undefined;
  return numeric;
}

/**
 * One page, numbered the way it will be spoken.
 *
 * Chronological WITHIN the page and renumbered from 1, which is the pair of
 * rules that makes the numbering unambiguous: the caller hears three hours in
 * clock order and answers "la segunda", and `lock` resolves that against the
 * page currently published — never against the ranking, and never against a
 * page that has been replaced.
 *
 * *** CHRONOLOGICAL MEANS (DATE, TIME), NOT TIME. ***
 *
 * It used to sort on `time` alone, which was invisible while every page came
 * from ONE day and is a real bug the moment a page spans several: a window
 * answer of Monday 18:00, Tuesday 09:00 and Wednesday 12:00 would have been
 * read out as "nine, twelve, six" — Tuesday first, Monday last — while
 * `days_summary` and the sentence around it describe the days in calendar
 * order. The caller who then says «la primera» means the first thing they
 * heard, and the numbering has to agree with the order it was spoken in.
 *
 * For a single-day page the two comparators are identical, so `discover` and
 * its `more` are unaffected.
 */
function numberPage(options: readonly BalancedOption[]): BalancedOption[] {
  return [...options]
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
    .map((option, index) => ({ ...option, optionIndex: index + 1 }));
}

/**
 * *** THE FIRST PAGE FOR A NAMED HOUR (incident 2026-09-15). ***
 *
 * `ranked` is ONE day's options, already ordered by distance to `preferred`
 * (`rankOptions`), and already filtered by whatever the question makes hard
 * (band, `after_time`, `before_time`). Returns the ranking reordered so the
 * page comes first, and how long that page is:
 *
 * - the named hour is free → that hour alone (page of 1);
 * - otherwise the nearest free hour BEFORE and the nearest AFTER (page of 2).
 *   Plain distance could put both on one side — 18:00 and 17:30 for 18:15
 *   while 19:00 is free — which is not "lo más cercano" to a caller;
 * - only one side has hours → the two nearest on that side.
 *
 * Every other hour keeps its distance order behind the page, so `more` walks
 * outwards from the named hour. Undefined when there is nothing to rank.
 */
function preferredTimePage(
  ranked: readonly BalancedOption[],
  preferred: string,
): { ordered: BalancedOption[]; pageSize: number; exact: boolean } | undefined {
  if (ranked.length === 0) return undefined;
  const target = minutesOf(preferred);
  const first = ranked[0] as BalancedOption;
  if (first.time === preferred) {
    return { ordered: [...ranked], pageSize: 1, exact: true };
  }
  const before = ranked.find((option) => minutesOf(option.time) < target);
  const after = ranked.find((option) => minutesOf(option.time) > target);
  if (before !== undefined && after !== undefined) {
    const rest = ranked.filter((option) => option !== before && option !== after);
    return { ordered: [before, after, ...rest], pageSize: 2, exact: false };
  }
  return { ordered: [...ranked], pageSize: Math.min(2, ranked.length), exact: false };
}

/** A real `HH:mm` wall-clock time (00:00–23:59), not merely HH:mm-shaped. */
function isWallClock(hhmm: string): boolean {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return (
    hours !== undefined && minutes !== undefined &&
    hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60
  );
}

/**
 * How many pages this conversation has already been read.
 *
 * `ceil`, not `floor`: a final page of one or two hours is still a page, so an
 * offset of 4 means two pages were spoken, not one and a third.
 */
function publishedPages(offset: number, pageSize: number = BALANCED_OPTION_MAX_OPTIONS): number {
  return Math.ceil(offset / pageSize);
}

/** The page size of a request: its own (WhatsApp) or the spoken three. */
function pageSizeOf(request: { pageSize?: number }): number {
  return request.pageSize ?? BALANCED_OPTION_MAX_OPTIONS;
}

/**
 * *** HOW MANY OPTIONS GO ON THIS PAGE, given how many are left to offer. ***
 *
 * A WhatsApp list holds at most {@link BALANCED_WA_MAX_OPTIONS_MAX} rows, and
 * the brain adds a final «Más horas» row when hours remain beyond the page.
 * With a page size of 10 and more than 10 hours left, ten options plus that
 * row would be eleven — so the page leaves one row free and offers nine. A
 * band with ten hours or fewer is offered whole. Every smaller page size (the
 * spoken 3 included) already leaves room and is returned unchanged, which is
 * what keeps the voice page exactly what it was.
 */
function fittedPageSize(pageSize: number, available: number): number {
  return pageSize >= BALANCED_WA_MAX_OPTIONS_MAX && available > pageSize
    ? BALANCED_WA_MAX_OPTIONS_MAX - 1
    : pageSize;
}

/**
 * Does this `more` describe a DIFFERENT question from the page being continued?
 *
 * Absent fields are never compared: the tool contract does not require any of
 * them for `more`, so an agent that sends only `conversation_id` — the normal
 * case — can never trip this. What it catches is an agent that has moved on
 * (a new day, a different service, another professional) while still asking to
 * continue, which is the one situation where continuing would speak hours for
 * a question nobody asked.
 *
 * `time_period` is satisfied by EITHER stored band. After a fallback the caller
 * asked for the morning and was answered with the afternoon, and an agent that
 * resends the band it originally asked for is not contradicting anything — it
 * is repeating itself.
 */
function contradicts(request: MoreRequest, continuation: BalancedContinuation): boolean {
  if (request.serviceId !== undefined && request.serviceId !== continuation.serviceId) {
    return true;
  }
  if (request.employeeId !== undefined && request.employeeId !== continuation.employeeId) {
    return true;
  }

  if (continuation.kind === "scan") {
    // *** A WINDOW IS CONTRADICTED BY A DAY OUTSIDE IT, NOT BY A DAY. ***
    //
    // The normal `more` after a scan carries no date at all. When it does, the
    // agent is usually REPEATING a day it just heard in the answer — «otros
    // horarios para el jueves» — and the jueves is inside the window it is
    // paginating. Refusing that would send a caller back to the beginning for
    // agreeing with us. A day OUTSIDE the window is the real divergence: the
    // agent has moved to a question this frozen list cannot answer.
    if (request.date !== undefined && !withinWindow(request.date, continuation)) {
      return true;
    }
    // A band the scan never constrained cannot be contradicted by one: the
    // ranking spans both halves of every day, so «por la tarde» narrows the
    // agent's intent, not the list. When the scan DID constrain the band, a
    // different one is a different question.
    if (
      request.period !== undefined &&
      continuation.period !== undefined &&
      request.period !== continuation.period
    ) {
      return true;
    }
    return false;
  }

  // After a look-ahead the page belongs to a later day than the one asked for;
  // an agent resending the day it originally asked about is repeating itself,
  // exactly like the band rule below.
  if (
    request.date !== undefined &&
    request.date !== continuation.date &&
    request.date !== continuation.requestedDate
  ) {
    return true;
  }
  // 2026-10-10: with a named hour the band sent is not the question (the
  // hour's band was searched, see `readDiscover`), so it contradicts nothing.
  if (
    request.period !== undefined &&
    continuation.preferredTime === undefined &&
    request.period !== continuation.requestedPeriod &&
    request.period !== continuation.offeredPeriod
  ) {
    return true;
  }
  return false;
}

/** Is that day one of the days this scan's ranking was built from? */
function withinWindow(date: string, continuation: BalancedScanContinuation): boolean {
  // String comparison, because `YYYY-MM-DD` sorts lexicographically exactly as
  // it sorts chronologically — and a `date` the model invented ("manana") is
  // outside every window by the same rule, with no parsing to get wrong.
  // 2026-10-11: a `weekday` scan is a LIST of dates, not a run of days.
  if (continuation.dates !== undefined) return continuation.dates.includes(date);
  return (
    date >= continuation.dateFrom &&
    date <= addDays(continuation.dateFrom, continuation.days - 1)
  );
}

/** The weekdays a `scan` may name, by `getUTCDay()`. Accents and plural ignored on input. */
const SCAN_WEEKDAYS: ReadonlyArray<readonly [string, number]> = [
  ["domingo", 0],
  ["lunes", 1],
  ["martes", 2],
  ["miercoles", 3],
  ["jueves", 4],
  ["viernes", 5],
  ["sabado", 6],
];
const SCAN_WEEKDAY_NAMES_ES: Readonly<Record<number, string>> = {
  0: "domingo",
  1: "lunes",
  2: "martes",
  3: "miércoles",
  4: "jueves",
  5: "viernes",
  6: "sábado",
};
/** Default and ceiling of `weeks` in a `weekday` scan. */
const SCAN_WEEKDAY_DEFAULT_WEEKS = 4;
const SCAN_WEEKDAY_MAX_WEEKS = 6;

/** `"Sábados"` -> `6`; `undefined` for anything that is not a weekday name. */
function parseScanWeekday(value: string): number | undefined {
  const folded = value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  for (const [name, index] of SCAN_WEEKDAYS) {
    if (folded === name || folded === `${name}s`) return index;
  }
  return undefined;
}

/** The first date at or after `from` that falls on weekday `index` (`getUTCDay()`). */
function firstWeekdayOnOrAfter(from: string, index: number): string {
  const current = new Date(Date.parse(`${from}T00:00:00Z`)).getUTCDay();
  return addDays(from, (index - current + 7) % 7);
}

/** The bands a continuation reports, whichever question produced it. */
function continuationBands(continuation: BalancedContinuation): {
  requested: TimePeriod | null;
  offered: TimePeriod | null;
  fallback: boolean;
} {
  if (continuation.kind === "scan") {
    // A scan never flips the band (see `BalancedScanContinuation`), so the two
    // are the same value and `period_fallback` is false by construction.
    return {
      requested: continuation.period ?? null,
      offered: continuation.period ?? null,
      fallback: false,
    };
  }
  return {
    requested: continuation.requestedPeriod,
    offered: continuation.offeredPeriod,
    fallback: continuation.offeredPeriod !== continuation.requestedPeriod,
  };
}

const DAY_MS = 86_400_000;

/**
 * How many days AFTER an empty requested day `discover` looks ahead: the same
 * seven-day ceiling a `scan` window has, so the look-ahead can never cost more
 * than the window question the agent could have asked instead.
 */
const DISCOVER_LOOKAHEAD_DAYS = BALANCED_SCAN_MAX_DAYS;

/** `YYYY-MM-DD` plus N days, in the salon's own calendar terms. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** The window, first day first. */
function windowDates(dateFrom: string, days: number): string[] {
  return Array.from({ length: days }, (_unused, offset) => addDays(dateFrom, offset));
}

/** What one day of the fan-out produced. */
type DayRead =
  /** Upstream (or the cache) answered in time. */
  | { status: "ok"; read: AgendaRead }
  /** Upstream answered with a failure in time. */
  | { status: "failed"; error: unknown }
  /** The deadline closed first. The read is still running. */
  | { status: "timeout" };

/**
 * ONE timer for the whole fan-out.
 *
 * Not one per day, which is what a naive `Promise.race` per read would give:
 * seven timers whose deadlines drift apart by however long each read took to
 * start, so the last day gets a longer grace than the first and the answer's
 * total latency is no longer bounded by anything. A single shared instant is
 * what makes "this answer takes at most 2.5 s" a property rather than an
 * average.
 *
 * `unref` so a pending deadline can never hold the process (or a test runner)
 * open, and `cancel` so the normal path leaves nothing behind.
 */
function scanDeadline(ms: number): { expired: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return {
    expired,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * One day's read, bounded by the shared deadline.
 *
 * *** THE LOSING READ IS NOT CANCELLED, AND THAT IS THE POINT. ***
 *
 * There is no way to cancel it that would help anyone: the upstream request is
 * already in flight and abandoning it would waste the round trip the salon's
 * host is already paying for. Left running, it lands in the agenda cache — so
 * the day that missed THIS answer is warm for the next question, which on a
 * phone call is usually the caller's very next sentence.
 *
 * The rejection is absorbed here rather than propagated, so a day that fails
 * after the deadline cannot surface as an unhandled rejection long after the
 * answer was sent.
 */
async function raceDeadline(
  work: Promise<AgendaRead>,
  expired: Promise<void>,
): Promise<DayRead> {
  const settled: Promise<DayRead> = work.then(
    (read) => ({ status: "ok", read }),
    (error: unknown) => ({ status: "failed", error }),
  );
  return Promise.race([settled, expired.then((): DayRead => ({ status: "timeout" }))]);
}

/**
 * ADR-024 — how far the EXTENDED look-ahead reads in total: two scan windows.
 * `discover` reads days 1–7 after the requested day and then 8–14; a `scan`
 * of N days reads the following 14 − N days. Never more.
 */
const EXTENDED_LOOKAHEAD_TOTAL_DAYS = 2 * BALANCED_SCAN_MAX_DAYS;

/** One day of a nearest-day read: a {@link DayRead}, or never started. */
type LookAheadRead = DayRead | { status: "skipped" };

/** The shared deadline plus a synchronous "has it passed?" probe. */
interface SharedDeadline {
  expired: Promise<void>;
  isExpired: () => boolean;
  cancel: () => void;
}

function sharedDeadline(ms: number): SharedDeadline {
  const deadline = scanDeadline(ms);
  let passed = false;
  void deadline.expired.then(() => {
    passed = true;
  });
  return { expired: deadline.expired, isExpired: () => passed, cancel: deadline.cancel };
}

/** The agenda read of day `index`, when it arrived in time. */
function okReadOf(reads: readonly LookAheadRead[], index: number): AgendaRead | undefined {
  const entry = reads[index];
  return entry !== undefined && entry.status === "ok" ? entry.read : undefined;
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * *** THE WINDOW'S HONESTY FIELDS, CARRIED INTO EVERY PAGE OF IT. ***
 *
 * `days_checked` and `partial` describe the READ that produced the ranking, and
 * that read happened once, at the `scan`. Page two is a slice of the same frozen
 * list, so the same two facts are true of it — and page two is exactly where
 * forgetting them bites: the agent hears `partial: undefined`, concludes the
 * window was complete, and says «no me queda nada más en los siete días» about
 * a week of which it read four days. The sentence the caller acts on would be a
 * claim about days nobody ever looked at.
 *
 * A day continuation has no window and therefore no such fields — the object is
 * empty for it, so nothing is invented for a question that cannot be partial.
 */
function windowHonesty(
  continuation: BalancedContinuation,
): { days_checked?: string[]; partial?: boolean } {
  if (continuation.kind !== "scan") return {};
  return { days_checked: [...continuation.daysChecked], partial: continuation.partial };
}

export class BalancedAvailabilityService {
  private readonly agenda: AgendaReader;
  private readonly optionStore: BalancedOptionStore;
  private readonly slotAuthorization: SlotAuthorizationService;
  private readonly offerStore: VoiceOfferStore;
  private readonly logger?: BalancedAvailabilityDeps["logger"];
  /** See {@link BalancedAvailabilityDeps.employeeNames}. Write-only from here. */
  private readonly employeeNames?: EmployeeNameDirectory;
  private readonly scanDeadlineMs: number;
  private readonly upstreamMaxConcurrency: number;
  private readonly closedWeekdays: ReadonlySet<number>;
  private readonly earlyClose: EarlyCloseMap;
  private readonly minLeadMinutes: number;
  private readonly whatsAppMaxOptions: number;

  constructor(deps: BalancedAvailabilityDeps) {
    this.agenda = deps.agenda;
    this.optionStore = deps.options;
    this.slotAuthorization = deps.slotAuthorization;
    this.offerStore = deps.offerStore;
    this.logger = deps.logger;
    this.employeeNames = deps.employeeNames;
    this.scanDeadlineMs = deps.scanDeadlineMs ?? BALANCED_SCAN_DEADLINE_MS;
    this.upstreamMaxConcurrency =
      deps.upstreamMaxConcurrency ?? BALANCED_SCAN_UPSTREAM_CAPACITY_DEFAULT;
    this.closedWeekdays = deps.closedWeekdays ?? new Set([0, 1]);
    this.earlyClose = deps.earlyClose ?? new Map();
    this.minLeadMinutes = deps.minLeadMinutes ?? DEFAULT_MIN_LEAD_MINUTES;
    this.whatsAppMaxOptions = clampBalancedWaMaxOptions(
      deps.whatsAppMaxOptions ?? BALANCED_WA_MAX_OPTIONS_DEFAULT,
    );
    this.ownBookingAt = deps.ownBookingAt;
  }

  private readonly ownBookingAt?: OwnBookingPort;

  /**
   * 2026-10-11 — the `own_booking_at_time` guard. Returns the sentence when the
   * hour asked for is a standing appointment of the VERIFIED caller phone; else
   * `undefined`. FAILS OPEN: no port, no phone, a throw or a rejection all
   * answer `undefined` (the question is then answered as always). Never logs
   * the phone, the date or the hour.
   */
  private async ownBookingMessage(
    phoneE164: string | undefined,
    whatsApp: boolean,
    date: string,
    time: string | undefined,
    employeeId?: number,
  ): Promise<string | undefined> {
    // Only with a named professional: without `employee_id` the customer may be
    // booking for someone else at the same hour with another barber.
    if (this.ownBookingAt === undefined || phoneE164 === undefined || time === undefined) return undefined;
    if (employeeId === undefined) return undefined;
    if (!isWallClock(time)) return undefined;
    try {
      const hit = await this.ownBookingAt(phoneE164, date, time, employeeId);
      if (hit === undefined) return undefined;
      return balancedOwnBookingMessage({
        whatsApp,
        date,
        time,
        ...(hit.employeeName !== undefined ? { employeeName: hit.employeeName } : {}),
      });
    } catch {
      this.logger?.warn({}, "balanced v2: own_booking_at_time guard failed open");
      return undefined;
    }
  }

  /**
   * The page size for one read request. `undefined` for a voice request, so
   * the request object — and everything built from it — stays exactly what
   * it was before WhatsApp pages existed.
   */
  private pageSizeFor(options: { whatsApp?: boolean }): number | undefined {
    return options.whatsApp === true ? this.whatsAppMaxOptions : undefined;
  }

  /**
   * *** THE ONE DOOR THROUGH WHICH THIS SERVICE SEES THE AGENDA. ***
   *
   * Every read — discover, look-ahead, scan, extended scan, and the fresh read
   * of `lock` — goes through here or {@link readAgendaFresh}, and both strip the
   * slots of today that have already started or start within the lead time
   * (incident 2026-09-18: «a las diez y media» offered at 14:37). Filtering the
   * DAY rather than one list of options is what makes every consumer agree:
   * the band fallback, the look-ahead's «does this day have an hour», the
   * scan's per-day counts, the barber balancing and the lock's «is it still
   * free» all read the same, already-honest day. A day that is not today comes
   * back as the very same object, untouched.
   */
  private async readAgenda(
    date: string,
    serviceId: number,
    nowMs: number,
    priority?: "interactive",
  ): Promise<AgendaRead> {
    const read =
      priority === undefined
        ? await this.agenda.read(date, String(serviceId), { kind: "any" })
        : await this.agenda.read(date, String(serviceId), { kind: "any" }, priority);
    return this.honest(read, nowMs);
  }

  /** {@link readAgenda}, with every cache out of the path (the lock's read). */
  private async readAgendaFresh(
    date: string,
    serviceId: number,
    nowMs: number,
  ): Promise<AgendaRead> {
    return this.honest(await this.agenda.readFresh(date, String(serviceId)), nowMs);
  }

  private honest(read: AgendaRead, nowMs: number): AgendaRead {
    const day = withoutAfterCloseSlots(
      withoutTooSoonSlots(read.day, nowMs, this.minLeadMinutes),
      this.earlyClose,
    );
    return day === read.day ? read : { ...read, day };
  }

  /** True when this `reservation_date` may no longer be offered, locked or booked. */
  private tooSoon(reservationDate: string, nowMs: number): boolean {
    return (
      isSlotTooSoon(reservationDate, nowMs, this.minLeadMinutes) ||
      // Early close: refused exactly like a slot that is gone (`slot_taken`).
      isSlotAfterEarlyClose(reservationDate, this.earlyClose)
    );
  }

  /**
   * Is the AFTERNOON of this `YYYY-MM-DD` closed by an early close (the weekday
   * is open, but closes at or before the afternoon band starts)? Answered with
   * no upstream read, like {@link isClosedDay}.
   */
  private isClosedAfternoon(
    dateIso: string,
    period: TimePeriod | undefined,
    afterTime?: string,
  ): boolean {
    const [year, month, day] = dateIso.split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) return false;
    const closeAt = this.earlyClose.get(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
    if (closeAt === undefined) return false;
    if (period === "afternoon" && closeAt <= AFTERNOON_FROM_MINUTES) return true;
    // A hard floor ("a partir de las 15:00") that is already past the close.
    return afterTime !== undefined && minutesOf(afterTime) >= closeAt;
  }

  /**
   * Is this `YYYY-MM-DD` one of the salon's static closed weekdays?
   *
   * Derives the weekday exactly like `weekdayEsOf` above (`Date.UTC` then
   * `getUTCDay()`) rather than a second date routine, so this check and the
   * Spanish weekday name a caller might hear always agree on which day a
   * date falls on.
   */
  private isClosedDay(dateIso: string): boolean {
    const [year, month, day] = dateIso.split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) return false;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return this.closedWeekdays.has(weekday);
  }

  /** True when a lock can mint anything at all. Fail-closed when false. */
  get authorizationIsArmed(): boolean {
    return this.slotAuthorization.enabled;
  }

  /**
   * *** ACTION: discover — the salon's free hours, with nobody named. ***
   *
   * Never throws for a bad request and never authorizes a write. An upstream
   * failure is the caller's problem to handle (`src/routes/balancedV2.ts` turns
   * it into a degraded HTTP 200), because the answer to "the agenda is
   * unreachable" is a sentence, not a status code.
   */
  async discover(
    body: unknown,
    nowMs: number,
    options: BalancedReadOptions = {},
  ): Promise<BalancedDiscoverResult> {
    const fecha = this.fechaDichaCorrection(body, "date", options.fechaPiezas, nowMs);
    if (fecha !== undefined && "conflict" in fecha) return fecha.conflict;
    const day =
      fecha ?? this.dayNameCorrection(body, "date", options.dayName, nowMs, options.whatsApp === true);
    const read = this.readDiscover(day?.body ?? body, nowMs);
    if (read === undefined) {
      return this.discoverRefusal("invalid_request", BALANCED_INVALID_REQUEST_MESSAGE);
    }
    const pageSize = this.pageSizeFor(options);
    const request: DiscoverRequest = {
      ...read,
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(options.whatsApp === true ? { askBeforeOtherDay: true } : {}),
    };
    // 2026-10-11: the hour asked for is the caller's own appointment.
    const ownMessage = await this.ownBookingMessage(
      options.callerPhoneE164,
      options.whatsApp === true,
      request.date,
      request.preferredTime,
      request.employeeId,
    );
    if (ownMessage !== undefined) {
      this.optionStore.publish(request.conversationId, [], nowMs);
      return this.discoverRefusal("own_booking_at_time", ownMessage);
    }
    // 2026-10-10: EVERY answer names the day searched, with its number — not
    // only when `day_name` / `fecha_dicha` came (the «jueves 16» call: the
    // offer never said «viernes», so the model kept its own «jueves»).
    {
      const result = await this.discoverRefreshed(
        request,
        nowMs,
        options.extendedLookAhead === true,
        options.nearestAlternatives === true,
      );
      if (result.outcome !== "options_available" && result.outcome !== "no_availability") {
        return result;
      }
      return {
        ...result,
        message: withSpokenDayEs(result.message, request.date, madridDate(nowMs)),
        ...(day?.correctedFrom !== undefined ? { date_corrected_from: day.correctedFrom } : {}),
      };
    }

    // *** THE LOCKED HUECO IS NOT TOUCHED HERE (ADR-022). ***
    //
    // A discovery mints nothing and publishes nothing bookable, so it has no
    // business changing what is bookable. The token of the last successful
    // lock stays valid — until another lock replaces it, it expires, or the
    // call books — and it can only ever book the slot that lock sealed. A new
    // choice from this page needs its own lock, which supersedes the old token.
    return this.discoverRefreshed(
      request,
      nowMs,
      options.extendedLookAhead === true,
      options.nearestAlternatives === true,
    );
  }

  /** The body of `discover`. */
  private async discoverRefreshed(
    request: DiscoverRequest,
    nowMs: number,
    extendedLookAhead: boolean,
    nearestAlternatives: boolean,
  ): Promise<BalancedDiscoverResult> {

    // *** AND SO DOES THE PAGE THIS DISCOVERY IS ABOUT TO REPLACE. ***
    //
    // The same argument as the two lines above, applied to the OTHER piece of
    // per-conversation state, and it has to happen here for the same reason:
    // this method suspends at the agenda read below, and `more` is synchronous.
    // A «otros horarios» that lands inside that window used to be answered from
    // the frozen ranking of the question this call is already abandoning — the
    // caller would hear three hours of the previous day, numbered 1, 2, 3,
    // moments before the new day's hours arrived with the same three numbers.
    //
    // Published WITHOUT a continuation, which erases the cursor as well as the
    // options (see `BalancedOptionStore.publish`). So for the duration of the
    // read this conversation has nothing to choose and nothing to continue,
    // which is exactly true: its question is being replaced. A `more` in the
    // window answers `continuation_lost` — recoverable, and never a page of a
    // query nobody asked about any more.
    this.optionStore.publish(request.conversationId, [], nowMs);

    // *** THE SALON'S WEEKLY CLOSURE — ANSWERED WITHOUT THE AGENDA. ***
    //
    // A closed day is a fact about the calendar, not about the diary: reading
    // the upstream agenda for a Sunday would cost a round trip to learn
    // something this deployment's env already knows for free. The option
    // invalidation above still runs — a caller asking about a closed day is
    // browsing, exactly as one asking about an open day with nothing free is.
    //
    // *** AND THEN THE FOLLOWING DAYS ARE READ (look-ahead, 2026-09-15). ***
    // The caller never ends at a bare «cerramos»: `discoverLookAhead` offers
    // the nearest open day with hours in the same band, or falls back to the
    // closed-day sentence when that could not be read.
    if (this.isClosedDay(request.date) || this.isClosedAfternoon(request.date, request.period)) {
      return this.discoverLookAhead(request, nowMs, "closed", extendedLookAhead);
    }

    const read = await this.readAgenda(request.date, request.serviceId, nowMs);

    // The requested band first; only if it is empty is the other one offered,
    // and then the sentence says so out loud.
    const requested = this.buildOptions(read.day, request, request.period);
    const chosen =
      requested.options.length > 0
        ? requested
        : this.buildOptions(read.day, request, oppositePeriod(request.period));

    if (chosen.options.length === 0) {
      // Nothing anywhere in the day. The previous options are already gone —
      // an empty answer must not leave yesterday's three hours choosable — and
      // so is any continuation, because there is now nothing to continue.
      this.optionStore.publish(request.conversationId, [], nowMs);
      if (nearestAlternatives && request.employeeId !== undefined) {
        // ADR-026: the named professional is full, perhaps others are not.
        return this.discoverEmployeeAlternative(request, nowMs, read, extendedLookAhead);
      }
      // Not a dead end: the nearest following day with hours, same band.
      return this.discoverLookAhead(request, nowMs, "full", extendedLookAhead);
    }

    if (nearestAlternatives && chosen.period !== request.period) {
      // ADR-026: the requested band is full; also name the nearest day that
      // has it. Falls through to the V4 page when that day cannot be named.
      const mixed = await this.discoverPeriodAlternative(
        request,
        nowMs,
        chosen,
        extendedLookAhead,
      );
      if (mixed !== undefined) return mixed;
    }

    // *** THE RANKING IS COMPUTED ONCE AND FROZEN HERE. ***
    //
    // `buildOptions` now returns the WHOLE band in offer order; the first three
    // are spoken and the rest are kept, so «también tengo otros horarios» has
    // something behind it. Re-ranking on each page from a fresh read would let
    // an hour repeat or vanish as the day fills — see `BalancedContinuation`.
    // *** A NAMED HOUR IS ANSWERED ABOUT THAT HOUR (incident 2026-09-15). ***
    //
    // Only when the hour belongs to the band actually being offered, and that
    // band is the one asked for: an hour in the other half of the day was never
    // looked at, so «a las once no tengo hueco» could be false. Those cases keep
    // the plain distance ranking below, unchanged.
    const named =
      request.preferredTime !== undefined &&
      isWallClock(request.preferredTime) &&
      chosen.period === request.period &&
      periodOf(request.preferredTime) === chosen.period
        ? preferredTimePage(chosen.options, request.preferredTime)
        : undefined;

    const ranked = named?.ordered ?? chosen.options;
    const page = numberPage(
      ranked.slice(0, named?.pageSize ?? fittedPageSize(pageSizeOf(request), ranked.length)),
    );
    const continuation: BalancedContinuation = {
      kind: "day",
      serviceId: request.serviceId,
      date: request.date,
      requestedPeriod: request.period,
      offeredPeriod: chosen.period,
      ...(request.preferredTime !== undefined
        ? { preferredTime: request.preferredTime }
        : {}),
      ...(request.employeeId !== undefined ? { employeeId: request.employeeId } : {}),
      rankedOptions: ranked,
      offset: page.length,
    };
    this.optionStore.publish(request.conversationId, page, nowMs, continuation, pageSizeOf(request));

    const hasMore = page.length < ranked.length;
    // V5 only (ADR-027): a named hour asked WITH a named professional is
    // answered naming that professional. `nearestAlternatives` is the V5
    // capability; a V4 request never reaches the name.
    const namedEmployee =
      nearestAlternatives && request.employeeId !== undefined
        ? this.nameOf(read.day, request.employeeId)
        : undefined;
    return {
      outcome: "options_available",
      available: true,
      message:
        named !== undefined && request.preferredTime !== undefined
          ? balancedPreferredTimeMessage(
              request.preferredTime,
              page.map((option) => option.time),
              {
                exact: named.exact,
                ...(namedEmployee !== undefined ? { employeeName: namedEmployee } : {}),
              },
            )
          : balancedOptionsMessage(page.map((option) => option.time), {
              hasMore,
              requested: request.period,
              offered: chosen.period,
              ...(hasMore ? { lastTime: latestTimeOf(ranked) } : {}),
            }),
      options: this.project(page),
      total_unique_slots: ranked.length,
      has_more: hasMore,
      requested_period: request.period,
      offered_period: chosen.period,
      period_fallback: chosen.period !== request.period,
      page_index: 1,
      offered_so_far: page.length,
      external_mutation: false,
    };
  }

  /**
   * *** THE DISCOVER LOOK-AHEAD — a day with nothing is not a dead end. ***
   *
   * Called when the day the caller named offers ZERO hours: closed weekday, or
   * open and fully booked in both bands. A receptionist would not stop at
   * «ese día no tengo»; they would say which is the nearest day that does have
   * something. This does exactly that, on the server, so the day proposed is
   * a fact read from the agenda and never a guess by the model.
   *
   * - Window: the {@link DISCOVER_LOOKAHEAD_DAYS} days AFTER the requested one,
   *   closed weekdays (`closedWeekdays`) dropped before any read.
   * - Same question: service, professional preference (`employee_id`), band
   *   (`time_period` is kept, never flipped across days) and `preferred_time`
   *   (same nearest-hours page as a plain discover).
   * - Budget: the SAME fan-out (`balancedScanFanOut`), interactive priority
   *   and single shared deadline (`scanDeadlineMs`) as `scan`. It also stops
   *   STARTING reads for days after the nearest match already found, and
   *   starts none once the deadline has passed, so a typical answer costs one
   *   or two days of upstream reads, not seven.
   * - Honesty: a day is only «lo más cercano» when every open day before it
   *   was actually read. Any failure, deadline miss or unread nearer day falls
   *   back to the pre-look-ahead sentence with zero options — never an error,
   *   never an invented hour.
   *
   * The page is an ordinary discover page (continuation `kind: "day"` on the
   * offered date), so `lock` by `option_index` and `more` behave exactly as for
   * any other page. It offers ≥1 slot, so `settleOffer` retires any prior lock
   * (ADR-019); the empty answers offer nothing and restore it.
   */
  private async discoverLookAhead(
    request: DiscoverRequest,
    nowMs: number,
    reason: "closed" | "full",
    extendedLookAhead: boolean,
    capture?: (offer: LookAheadCapture) => void,
    /**
     * 2026-10-09 — a `scan` whose whole window is closed reuses this
     * look-ahead (call 8dx8gn); its HARD `after_time` / `before_time` keep
     * filtering here. Absent for every discover: the predicates are the old ones.
     */
    hardFilter?: (time: string) => boolean,
  ): Promise<BalancedDiscoverResult> {
    // Open in the morning, afternoon closed (early close): says so in the lead.
    const afternoonOnly = reason === "closed" && !this.isClosedDay(request.date);
    const empty = (
      message: string,
      extra: Pick<BalancedDiscoverResult, "requested_date" | "next_search_from"> = {},
    ): BalancedDiscoverResult => {
      this.optionStore.publish(request.conversationId, [], nowMs);
      return {
        outcome: "no_availability",
        available: false,
        message,
        options: [],
        total_unique_slots: 0,
        has_more: false,
        requested_period: request.period,
        offered_period: null,
        period_fallback: false,
        ...extra,
        external_mutation: false,
      };
    };
    const fallback = (cause: string): BalancedDiscoverResult => {
      this.logger?.warn(
        { conversation_id: request.conversationId, reason, lookahead_fallback: cause },
        "balanced v2 discover look-ahead could not name the nearest day; answering without it",
      );
      return empty(
        reason === "closed"
          ? afternoonOnly
            ? BALANCED_CLOSED_AFTERNOON_MESSAGE
            : BALANCED_CLOSED_DAY_MESSAGE
          : BALANCED_NO_AVAILABILITY_MESSAGE,
      );
    };

    // *** 2026-10-09 — WHATSAPP: NEVER ANOTHER DAY WITHOUT THE CUSTOMER'S «SÍ». ***
    // «El próximo jueves» answered with the hours of a later Thursday was a
    // jump the customer never agreed to. On WhatsApp the day asked for is
    // judged on its own: nothing there -> say so and ask. With a «sí» the
    // agent scans from `next_search_from`. No other day is read or published.
    if (request.askBeforeOtherDay === true) {
      return empty(
        balancedAskOtherDayMessage({ reason, afternoonOnly, requestedDate: request.date }),
        { requested_date: request.date, next_search_from: addDays(request.date, 1) },
      );
    }

    const openDates = windowDates(addDays(request.date, 1), DISCOVER_LOOKAHEAD_DAYS).filter(
      (date) => !this.isClosedDay(date) && !this.isClosedAfternoon(date, request.period),
    );
    if (openDates.length === 0) return fallback("no_open_day");

    const allowed = (time: string): boolean => hardFilter === undefined || hardFilter(time);
    const inBand = (time: string): boolean => periodOf(time) === request.period && allowed(time);
    const hasBandHour = (read: AgendaRead, date: string): boolean =>
      this.freeTimesByEmployee(read.day, date, request.employeeId, inBand).size > 0;
    const hasOtherBandHour = (read: AgendaRead, date: string): boolean =>
      this.freeTimesByEmployee(
        read.day,
        date,
        request.employeeId,
        (time) => periodOf(time) !== request.period && allowed(time),
      ).size > 0;

    // Wall-clock start of the look-ahead: the extended second week (ADR-024)
    // only gets what is LEFT of this one budget, never a budget of its own.
    const startedAt = Date.now();
    const deadline = sharedDeadline(this.scanDeadlineMs);
    let week: { reads: LookAheadRead[]; nearest: number };
    try {
      week = await this.readUntilNearest(
        openDates,
        request.serviceId,
        hasBandHour,
        deadline,
        nowMs,
      );
    } catch {
      return fallback("read_error");
    } finally {
      deadline.cancel();
    }

    if (!Number.isFinite(week.nearest)) {
      // Nothing in the band. Only sayable when EVERY open day was read.
      if (openDates.some((_date, index) => okReadOf(week.reads, index) === undefined)) {
        return fallback("partial_window");
      }
      const otherPeriodHasHours = openDates.some((date, index) =>
        hasOtherBandHour(okReadOf(week.reads, index) as AgendaRead, date),
      );
      const nothingInSevenDays = (): BalancedDiscoverResult =>
        empty(
          balancedLookAheadNothingMessage({
            reason,
            afternoonOnly,
            requestedDate: request.date,
            period: request.period,
            otherPeriodHasHours,
          }),
          {
            requested_date: request.date,
            next_search_from: addDays(request.date, DISCOVER_LOOKAHEAD_DAYS + 1),
          },
        );
      if (!extendedLookAhead) return nothingInSevenDays();

      // *** ADR-024: THE SECOND WEEK (days 8–14), SAME QUESTION, SAME BUDGET. ***
      //
      // The first week was read IN FULL and has nothing, so «¿te busco la
      // semana siguiente?» is replaced by actually reading it and naming the
      // nearest real day. Anything that stops that from being a checked fact
      // (failure, deadline, an unread nearer day) answers the seven-day
      // sentence above — true, because the first week WAS fully read.
      const extendedFallback = (cause: string): BalancedDiscoverResult => {
        this.logger?.warn(
          { conversation_id: request.conversationId, reason, extended_lookahead_fallback: cause },
          "balanced v2 extended look-ahead could not read the second week; answering the seven-day sentence",
        );
        return nothingInSevenDays();
      };
      const secondDates = windowDates(
        addDays(request.date, DISCOVER_LOOKAHEAD_DAYS + 1),
        EXTENDED_LOOKAHEAD_TOTAL_DAYS - DISCOVER_LOOKAHEAD_DAYS,
      ).filter((date) => !this.isClosedDay(date) && !this.isClosedAfternoon(date, request.period));
      const remainingMs = this.scanDeadlineMs - (Date.now() - startedAt);
      if (remainingMs <= 0) return extendedFallback("deadline");

      const secondDeadline = sharedDeadline(remainingMs);
      let second: { reads: LookAheadRead[]; nearest: number };
      try {
        second = await this.readUntilNearest(
          secondDates,
          request.serviceId,
          hasBandHour,
          secondDeadline,
          nowMs,
        );
      } catch {
        return extendedFallback("read_error");
      } finally {
        secondDeadline.cancel();
      }

      if (!Number.isFinite(second.nearest)) {
        if (secondDates.some((_date, index) => okReadOf(second.reads, index) === undefined)) {
          return extendedFallback("partial_window");
        }
        const otherInTwoWeeks =
          otherPeriodHasHours ||
          secondDates.some((date, index) =>
            hasOtherBandHour(okReadOf(second.reads, index) as AgendaRead, date),
          );
        return empty(
          balancedLookAheadTwoWeeksNothingMessage({
            reason,
            afternoonOnly,
            requestedDate: request.date,
            period: request.period,
            otherPeriodHasHours: otherInTwoWeeks,
          }),
          {
            requested_date: request.date,
            next_search_from: addDays(request.date, EXTENDED_LOOKAHEAD_TOTAL_DAYS + 1),
          },
        );
      }

      for (let index = 0; index < second.nearest; index += 1) {
        if (okReadOf(second.reads, index) === undefined) {
          return extendedFallback("nearer_day_unread");
        }
      }
      const offeredDate = secondDates[second.nearest] as string;
      return (
        this.lookAheadOffer(
          request,
          nowMs,
          offeredDate,
          okReadOf(second.reads, second.nearest) as AgendaRead,
          inBand,
          (times) =>
            balancedExtendedLookAheadMessage({
              reason,
              afternoonOnly,
              requestedDate: request.date,
              period: request.period,
              otherPeriodHasHours,
              offeredDate,
              times,
            }),
          capture,
        ) ?? extendedFallback("no_assignable_hour")
      );
    }

    // «Lo más cercano» is only true if no nearer open day went unread.
    for (let index = 0; index < week.nearest; index += 1) {
      if (okReadOf(week.reads, index) === undefined) return fallback("nearer_day_unread");
    }

    const date = openDates[week.nearest] as string;
    return (
      this.lookAheadOffer(
        request,
        nowMs,
        date,
        okReadOf(week.reads, week.nearest) as AgendaRead,
        inBand,
        (times) =>
          balancedLookAheadMessage({
            reason,
            afternoonOnly,
            requestedDate: request.date,
            offeredDate: date,
            times,
          }),
        capture,
      ) ?? fallback("no_assignable_hour")
    );
  }

  /**
   * Reads `dates` with the scan's fan-out and interactive priority, bounded by
   * `deadline`, and returns the index of the nearest day for which `hasMatch`
   * is true. Stops STARTING reads for days after a match already found, and
   * starts none once the deadline has passed. The caller decides what an
   * unread day means; this never interprets one as empty.
   */
  private async readUntilNearest(
    dates: readonly string[],
    serviceId: number,
    hasMatch: (read: AgendaRead, date: string) => boolean,
    deadline: SharedDeadline,
    nowMs: number,
  ): Promise<{ reads: LookAheadRead[]; nearest: number }> {
    // Index (into `dates`) of the nearest day known to match.
    let nearest = Number.POSITIVE_INFINITY;
    const fanOut = balancedScanFanOut(dates.length, this.upstreamMaxConcurrency);
    const reads = await mapWithConcurrency(
      dates,
      fanOut,
      async (date, index): Promise<LookAheadRead> => {
        // A nearer day already matches: this one can never be the answer.
        if (index > nearest) return { status: "skipped" };
        if (deadline.isExpired()) return { status: "timeout" };
        const outcome = await raceDeadline(
          this.readAgenda(date, serviceId, nowMs, "interactive"),
          deadline.expired,
        );
        if (outcome.status === "ok" && index < nearest && hasMatch(outcome.read, date)) {
          nearest = index;
        }
        return outcome;
      },
    );
    return { reads, nearest };
  }

  /**
   * The look-ahead page for `date`: an ordinary discover page (continuation
   * `kind: "day"`), published, with the message `speak` builds from its hours.
   * `undefined` when no hour could be put on the page — the caller falls back.
   */
  private lookAheadOffer(
    request: DiscoverRequest,
    nowMs: number,
    date: string,
    read: AgendaRead,
    inBand: (time: string) => boolean,
    speak: (times: string[]) => string,
    capture?: (offer: LookAheadCapture) => void,
  ): BalancedDiscoverResult | undefined {
    const options = this.rankOptions(
      this.freeTimesByEmployee(read.day, date, request.employeeId, inBand),
      {
        conversationId: request.conversationId,
        date,
        serviceId: request.serviceId,
        ...(request.preferredTime !== undefined ? { preferredTime: request.preferredTime } : {}),
        limit: BALANCED_CONTINUATION_MAX_SLOTS,
      },
    );
    // The same nearest-hours page a plain discover gives a named hour.
    const named =
      request.preferredTime !== undefined &&
      isWallClock(request.preferredTime) &&
      periodOf(request.preferredTime) === request.period
        ? preferredTimePage(options, request.preferredTime)
        : undefined;
    const ranked = named?.ordered ?? options;
    const page = numberPage(
      ranked.slice(0, named?.pageSize ?? fittedPageSize(pageSizeOf(request), ranked.length)),
    );
    if (page.length === 0) return undefined;

    const continuation: BalancedContinuation = {
      kind: "day",
      serviceId: request.serviceId,
      date,
      requestedDate: request.date,
      requestedPeriod: request.period,
      offeredPeriod: request.period,
      ...(request.preferredTime !== undefined ? { preferredTime: request.preferredTime } : {}),
      ...(request.employeeId !== undefined ? { employeeId: request.employeeId } : {}),
      rankedOptions: ranked,
      offset: page.length,
    };
    this.optionStore.publish(request.conversationId, page, nowMs, continuation, pageSizeOf(request));
    capture?.({ ranked, read });

    const hasMore = page.length < ranked.length;
    return {
      outcome: "options_available",
      available: true,
      message: speak(page.map((option) => option.time)),
      options: this.project(page),
      total_unique_slots: ranked.length,
      has_more: hasMore,
      requested_period: request.period,
      offered_period: request.period,
      period_fallback: false,
      page_index: 1,
      offered_so_far: page.length,
      requested_date: request.date,
      date_fallback: true,
      external_mutation: false,
    };
  }

  // ── ADR-026: the same day, plus the nearest day that has what was asked ──

  /**
   * *** THE NEAREST LATER DAY WITH WHAT THE CALLER ASKED FOR. ***
   *
   * Runs the ordinary look-ahead UNCHANGED — same window after the requested
   * day, closed weekdays skipped, same service, professional, band and
   * `preferred_time`, same fan-out and single deadline, and (with
   * `extendedLookAhead`) the same second week inside the same budget — and
   * keeps only its first offered hour. Every way the look-ahead can fail to
   * name a day (failure, deadline, an unread nearer day, nothing found)
   * answers `undefined`, and the caller then answers exactly as V4.
   *
   * The look-ahead publishes its own page on the way; the caller republishes
   * (the mixed page or the V4 one) with no `await` in between, so that page is
   * never observable by another request of this conversation.
   */
  private async nearestLaterOption(
    request: DiscoverRequest,
    nowMs: number,
    extendedLookAhead: boolean,
  ): Promise<{ option: BalancedOption; read: AgendaRead } | undefined> {
    let captured: LookAheadCapture | undefined;
    const result = await this.discoverLookAhead(
      request,
      nowMs,
      "full",
      extendedLookAhead,
      (offer) => {
        captured = offer;
      },
    );
    if (result.outcome !== "options_available" || result.date_fallback !== true) return undefined;
    const option = captured?.ranked[0];
    if (captured === undefined || option === undefined || option.date <= request.date) {
      return undefined;
    }
    return { option, read: captured.read };
  }

  /**
   * *** ITEM 1 — «Esa tarde la tengo completa…» (V5 only). ***
   *
   * `sameDay` is the OTHER band's ranking for the requested day, exactly as
   * V4 would page it. The mixed page is up to
   * {@link ALTERNATIVE_SAME_DAY_OPTIONS} of those hours plus the nearest later
   * day's hour in the requested band, numbered in (date, time) order — so the
   * same-day hours are 1 and 2 and the later day is the last number, which is
   * also the order the message speaks them in. Each option carries its own
   * `date`, so `lock` re-reads and seals the right day.
   *
   * *** `more` CONTINUES THE SAME-DAY LIST. *** The continuation is the
   * ordinary day continuation of the fallback band with the cursor after the
   * same-day hours spoken; the later day is a single suggestion, not a list.
   * A caller who wants more hours on that later day gets them from a new
   * `discover` of that day.
   *
   * `undefined` when the later day cannot be named: the caller answers V4.
   */
  private async discoverPeriodAlternative(
    request: DiscoverRequest,
    nowMs: number,
    sameDay: { options: BalancedOption[]; period: TimePeriod },
    extendedLookAhead: boolean,
  ): Promise<BalancedDiscoverResult | undefined> {
    const later = await this.nearestLaterOption(request, nowMs, extendedLookAhead);
    if (later === undefined) {
      // The look-ahead left its own empty answer published; the V4 page the
      // caller builds next replaces it synchronously.
      return undefined;
    }
    const taken = sameDay.options.slice(0, ALTERNATIVE_SAME_DAY_OPTIONS);
    return this.publishMixedPage(request, nowMs, {
      ranked: sameDay.options,
      taken,
      offeredPeriod: sameDay.period,
      keepEmployee: true,
      later: later.option,
      laterName: this.assignedName(later.read.day, later.option),
      message: balancedPeriodAlternativeMessage({
        requested: request.period,
        offered: sameDay.period,
        sameDayTimes: numberPage(taken).map((option) => option.time),
        nextDate: later.option.date,
        nextTime: later.option.time,
      }),
    });
  }

  /**
   * *** ITEM 2 — «Con Bruno ese día está completo…» (V5 only). ***
   *
   * `employee_id` in `discover` is a HARD filter (see `freeTimesByEmployee`):
   * V4 never tells a caller who asked for Bruno that Ramón is free, it jumps to
   * Bruno's nearest day. Here the same day's roster is asked WITHOUT the filter
   * (requested band first, the other band only when the requested one is empty
   * for everybody), and when someone else has an hour the page is up to
   * {@link ALTERNATIVE_SAME_DAY_OPTIONS} of those plus the nearest later day
   * with the requested professional in the requested band.
   *
   * The same-day options are assigned by the balancer among the OTHER
   * professionals, and `lock` keeps that assignment while it is still free —
   * so locking them must be done WITHOUT `preferred_employee_id`. The later
   * option is the requested professional's by construction.
   *
   * The continuation drops `employeeId`: its list is other professionals'
   * hours, so a `more` that still names the requested professional is refused
   * as `continuation_mismatch` instead of paging hours that are not theirs.
   *
   * Nobody else has an hour, or the later day cannot be named → exactly the
   * V4 answer (the professional's own look-ahead).
   */
  private async discoverEmployeeAlternative(
    request: DiscoverRequest,
    nowMs: number,
    read: AgendaRead,
    extendedLookAhead: boolean,
  ): Promise<BalancedDiscoverResult> {
    const anyone: DiscoverRequest = { ...request };
    delete anyone.employeeId;
    const inBand = this.buildOptions(read.day, anyone, request.period);
    const others =
      inBand.options.length > 0
        ? inBand
        : this.buildOptions(read.day, anyone, oppositePeriod(request.period));
    if (others.options.length === 0) {
      return this.discoverLookAhead(request, nowMs, "full", extendedLookAhead);
    }

    let captured: LookAheadCapture | undefined;
    const v4 = await this.discoverLookAhead(request, nowMs, "full", extendedLookAhead, (offer) => {
      captured = offer;
    });
    const later = captured?.ranked[0];
    if (
      v4.outcome !== "options_available" ||
      v4.date_fallback !== true ||
      captured === undefined ||
      later === undefined ||
      later.date <= request.date
    ) {
      return v4;
    }

    const taken = numberPage(others.options.slice(0, ALTERNATIVE_SAME_DAY_OPTIONS));
    const employeeId = request.employeeId as number;
    const employeeName =
      this.nameOf(read.day, employeeId) ?? this.nameOf(captured.read.day, employeeId);
    if (employeeName === undefined) return v4;
    return this.publishMixedPage(anyone, nowMs, {
      ranked: others.options,
      taken,
      offeredPeriod: others.period,
      keepEmployee: false,
      later,
      laterName: this.assignedName(captured.read.day, later),
      message: balancedEmployeeAlternativeMessage({
        employeeName,
        others: taken.map((option) => ({
          name: this.assignedName(read.day, option),
          time: option.time,
        })),
        ...(others.period !== request.period ? { othersPeriod: others.period } : {}),
        nextDate: later.date,
        nextTime: later.time,
      }),
    });
  }

  /** Publishes an ADR-026 mixed page and builds its answer. */
  private publishMixedPage(
    request: DiscoverRequest,
    nowMs: number,
    mix: {
      ranked: readonly BalancedOption[];
      taken: readonly BalancedOption[];
      offeredPeriod: TimePeriod;
      keepEmployee: boolean;
      later: BalancedOption;
      laterName: string;
      message: string;
    },
  ): BalancedDiscoverResult {
    const requestedPeriod = request.period;
    // (date, time) order: the same-day hours first, the later day last.
    const page = numberPage([...mix.taken, mix.later]);
    const continuation: BalancedContinuation = {
      kind: "day",
      serviceId: request.serviceId,
      date: request.date,
      requestedPeriod,
      offeredPeriod: mix.offeredPeriod,
      ...(request.preferredTime !== undefined ? { preferredTime: request.preferredTime } : {}),
      ...(mix.keepEmployee && request.employeeId !== undefined
        ? { employeeId: request.employeeId }
        : {}),
      rankedOptions: mix.ranked,
      offset: mix.taken.length,
    };
    this.optionStore.publish(request.conversationId, page, nowMs, continuation);

    return {
      outcome: "options_available",
      available: true,
      message: mix.message,
      options: this.project(page),
      total_unique_slots: mix.ranked.length,
      // About the same-day list `more` continues.
      has_more: mix.taken.length < mix.ranked.length,
      requested_period: requestedPeriod,
      offered_period: mix.offeredPeriod,
      period_fallback: mix.offeredPeriod !== requestedPeriod,
      page_index: 1,
      offered_so_far: page.length,
      next_in_requested_period: {
        date: mix.later.date,
        time: mix.later.time,
        employee_name: mix.laterName,
      },
      external_mutation: false,
    };
  }

  /** The spoken name of the professional an option was assigned to. */
  private assignedName(day: AgendaDay, option: BalancedOption): string {
    return this.nameOf(day, option.assignedEmployeeId) ?? spokenEmployeeName("");
  }

  /**
   * *** ACTION: more — the next hours of the SAME question. ***
   *
   * The gap this closes is the one a real call fell into: the agent was told
   * `has_more: true`, said so out loud, the caller asked for other hours, and
   * the contract had no way to answer. Everything below exists to make the
   * answer safe rather than merely possible.
   *
   * *** IT MAKES NO UPSTREAM CALL AND CONTAINS NO `await`. ***
   *
   * Two reasons, and both are load-bearing. It is ATOMIC: the page is read and
   * the new page is published without a suspension point in between, so there
   * is no instant at which an old index and a new index both resolve. And it
   * is INSTANT: this runs mid-call, on a phone line, and
   * the salon's diary has nothing to add — the hours were already read and the
   * ranking was already frozen. `lock` still re-reads the day (ADR-010), which
   * is where freshness actually has to be paid for.
   */
  more(
    body: unknown,
    nowMs: number,
    options: Pick<BalancedReadOptions, "whatsApp"> = {},
  ): BalancedDiscoverResult {
    const request = this.readMore(body);
    if (request === undefined) {
      // No usable conversation id, so there is no conversation whose tokens
      // could be retired. Nothing has been touched.
      return this.discoverRefusal("invalid_request", BALANCED_INVALID_REQUEST_MESSAGE);
    }

    // *** THE LOCKED HUECO IS NOT TOUCHED HERE (ADR-022). *** Identical to
    // `discover`: only a lock changes what is bookable.
    return this.moreRefreshed(request, nowMs, this.pageSizeFor(options) ?? BALANCED_OPTION_MAX_OPTIONS);
  }

  /** The body of `more`. `pageSize` is 3 for voice, the WhatsApp size otherwise. */
  private moreRefreshed(
    request: MoreRequest,
    nowMs: number,
    pageSize: number,
  ): BalancedDiscoverResult {

    const continuation = this.optionStore.continuation(request.conversationId, nowMs);
    if (continuation === undefined) {
      // A restart, an eviction, an expiry, or a `more` that never had a
      // `discover`. The hours are NOT rebuilt: the request carries no day, no
      // band and no service to rebuild them from, which is precisely why it is
      // safe.
      //
      // *** THE EMPTY PUBLISH IS DEFENCE IN DEPTH, NOT THE MECHANISM. ***
      //
      // In every way a continuation is actually lost today the whole record is
      // already gone — `MemoryBalancedOptionStore` expires and evicts the page
      // and its cursor together — so this call is usually a no-op. It exists
      // for the narrower state a future store could present: options alive,
      // continuation absent. There, a surviving index would still resolve to an
      // hour whose question cannot be continued, and that is not a state any
      // conversation may be left in.
      this.optionStore.publish(request.conversationId, [], nowMs);
      this.logger?.warn(
        { conversation_id: request.conversationId },
        "balanced v2 more refused: this conversation has no page to continue",
      );
      return this.discoverRefusal("continuation_lost", BALANCED_OPTION_UNKNOWN_MESSAGE);
    }

    if (contradicts(request, continuation)) {
      // The agent is continuing a page it is no longer talking about. Refusing
      // is the only safe answer: continuing would offer hours for the wrong
      // day, and "correcting" the continuation from these fields would be the
      // model steering the cursor, which the contract deliberately forbids.
      //
      // *** AND THE NUMBERED TABLE GOES WITH THE REFUSAL. ***
      //
      // Refusing to PAGINATE was never the whole answer: the three numbers the
      // caller is holding belong to the question the agent has just said it is
      // no longer asking, so leaving them live means `lock(2)` still books an
      // hour on a day nobody is talking about. The options are published empty
      // and every index this call held stops resolving.
      //
      // The CONTINUATION is passed through unchanged, deliberately. The cursor
      // is server-side state about a question the caller may well still be on —
      // the contradiction is in the agent's FIELDS, not necessarily in the
      // conversation — so an agent that immediately re-asks with
      // `conversation_id` alone gets the page it was owed instead of being sent
      // back to `discover` for its own bad field.
      this.optionStore.publish(request.conversationId, [], nowMs, continuation);
      this.logger?.warn(
        { conversation_id: request.conversationId },
        "balanced v2 more refused: the request contradicts the page being continued",
      );
      return this.discoverRefusal("continuation_mismatch", BALANCED_OPTION_UNKNOWN_MESSAGE);
    }

    const bands = continuationBands(continuation);
    const ranked = continuation.rankedOptions;
    // *** THE FROZEN RANKING MAY HOLD HOURS THAT HAVE SINCE STARTED. ***
    //
    // It was computed from a read made minutes ago (incident 2026-09-18). An
    // hour of today that is now too soon is SKIPPED — consumed by the cursor,
    // never spoken — so the page, `has_more` and the exhaustion answer all
    // speak only of hours that can still be booked. With nothing too soon this
    // is exactly the old `slice(offset, offset + N)`.
    const slice: BalancedOption[] = [];
    let cursor = continuation.offset;
    // Voice: always 3. WhatsApp: the page size, or one less when more hours
    // remain than fit beside the «Más horas» row (see `fittedPageSize`).
    const fitted =
      pageSize >= BALANCED_WA_MAX_OPTIONS_MAX
        ? fittedPageSize(
            pageSize,
            ranked
              .slice(cursor)
              .filter((option) => !this.tooSoon(option.reservationDate, nowMs)).length,
          )
        : pageSize;
    while (cursor < ranked.length && slice.length < fitted) {
      const option = ranked[cursor]!;
      cursor += 1;
      if (!this.tooSoon(option.reservationDate, nowMs)) slice.push(option);
    }

    if (slice.length === 0) {
      // *** EXHAUSTION IS DETERMINISTIC AND DOES NOT REWIND. ***
      // The continuation is kept with its offset UNTOUCHED, so a second "otros
      // horarios" produces the identical refusal rather than silently replaying
      // page one — which would re-offer hours the caller has already declined
      // and make the numbering ambiguous.
      //
      // *** AND NOTHING IS PUBLISHED, SO THE LAST PAGE STAYS CHOOSABLE. ***
      //
      // Deliberate, and the opposite of the `continuation_mismatch` branch
      // above. There the agent said it had moved on; here the caller simply
      // heard every hour there is, and the ordinary next sentence is "pues
      // ponme la de las doce". Retiring the table at this point would turn the
      // exhaustion sentence into the dead end this whole action exists to
      // remove — so the numbers of the last page keep resolving, and `lock`
      // re-reads the day before it authorizes any of them, exactly as always.
      return {
        outcome: "no_more_options",
        available: false,
        // *** THE EXHAUSTION SENTENCE BELONGS TO THE QUESTION. ***
        // «No me quedan más huecos esa mañana» is false about a window that
        // spanned seven days, and it is the sentence a caller acts on. The
        // band phrasing stays with the band question; the window has its own.
        message:
          continuation.kind === "scan"
            ? balancedScanNoMoreMessage()
            : withSpokenDayEs(
                balancedNoMoreOptionsMessage(continuation.offeredPeriod, {
                  fallbackAlreadyHappened:
                    continuation.offeredPeriod !== continuation.requestedPeriod,
                }),
                continuation.date,
                madridDate(nowMs),
              ),
        options: [],
        total_unique_slots: ranked.length,
        has_more: false,
        requested_period: bands.requested,
        offered_period: bands.offered,
        period_fallback: bands.fallback,
        page_index: publishedPages(continuation.offset, pageSize),
        offered_so_far: continuation.offset,
        // Still true of the exhaustion sentence, and it is the page where it
        // matters most: «ya te he dicho todas las que tengo en esos días» is
        // only honest about the days that were read.
        ...windowHonesty(continuation),
        external_mutation: false,
      };
    }

    // *** THE NEW PAGE REPLACES THE TABLE. ***
    // Renumbered 1..n and published in the same synchronous assignment that
    // advances the offset, so "which hour is number 1" has exactly one answer
    // at every instant. An index from the previous page now resolves to a
    // different hour or to nothing — never to the hour it used to mean.
    const page = numberPage(slice);
    const offset = cursor;
    this.optionStore.publish(
      request.conversationId,
      page,
      nowMs,
      { ...continuation, offset },
      pageSize,
    );

    const hasMore = ranked
      .slice(offset)
      .some((option) => !this.tooSoon(option.reservationDate, nowMs));
    return {
      outcome: "options_available",
      available: true,
      // *** A CONTINUED PAGE IS SPOKEN IN THE VOICE OF ITS OWN QUESTION. ***
      //
      // `balancedMoreOptionsMessage` speaks HOURS — «te puedo ofrecer a las
      // diez, a las once y a las doce» — which is complete for a day question
      // and unusable for a window one: page two of a scan can hold three hours
      // on three different days, and a caller who is read three bare hours has
      // no way to tell which day any of them is. The window builder takes the
      // page itself and says the day with each hour. It needs no `days_summary`
      // for a non-empty page (see its own comment), which is why the cursor
      // does not have to carry one.
      message:
        continuation.kind === "scan"
          ? balancedScanMessage(page, [], { hasMore, todayIso: madridDate(nowMs) })
          : withSpokenDayEs(
              balancedMoreOptionsMessage(
                page.map((option) => option.time),
                { hasMore },
              ),
              continuation.date,
              madridDate(nowMs),
            ),
      options: this.project(page),
      total_unique_slots: ranked.length,
      has_more: hasMore,
      requested_period: bands.requested,
      offered_period: bands.offered,
      period_fallback: bands.fallback,
      page_index: publishedPages(continuation.offset, pageSize) + 1,
      offered_so_far: offset,
      ...windowHonesty(continuation),
      external_mutation: false,
    };
  }

  /**
   * *** ACTION: scan — the same question, asked of a WINDOW. ***
   *
   * The gap this closes is the one «¿cuándo tienes algo a partir de las cinco?»
   * fell into. `discover` answers about ONE day and ranks `preferred_time`
   * without filtering on it, so the honest answer to that sentence was three
   * hours on the day the agent happened to name, at whatever time the salon had
   * — 14:00 offered to a caller who said "a partir de las cinco". The agent's
   * only recovery was to guess another day and ask again, one round trip at a
   * time, which is how a caller ends up hearing six wrong hours.
   *
   * Four properties make the window version safe rather than merely broader:
   *
   * 1. **The time constraint is HARD.** `after_time` / `before_time` /
   *    `time_period` filter; only `preferred_time` ranks. An hour outside the
   *    constraint is not offered at all, however few hours remain — a wrong
   *    answer politely ranked last is still a wrong answer.
   * 2. **Breadth is enforced**, at {@link BALANCED_SCAN_MAX_PER_DAY} hours per
   *    day, so the first page names days rather than filling itself with one
   *    busy afternoon.
   * 3. **The answer is bounded in time** ({@link BALANCED_SCAN_DEADLINE_MS}),
   *    and a day that did not arrive is REPORTED, never treated as empty.
   * 4. **It authorizes nothing**, exactly as `discover` does not: no token is
   *    minted, and the last lock's token is neither widened nor retired
   *    (ADR-022 — only a lock changes what is bookable).
   */
  async scan(
    body: unknown,
    nowMs: number,
    options: BalancedReadOptions = {},
  ): Promise<BalancedDiscoverResult> {
    const fecha = this.fechaDichaCorrection(body, "date_from", options.fechaPiezas, nowMs);
    if (fecha !== undefined && "conflict" in fecha) return fecha.conflict;
    const day =
      fecha ?? this.dayNameCorrection(body, "date_from", options.dayName, nowMs, options.whatsApp === true);
    const read = this.readScan(day?.body ?? body, nowMs);
    if (read === undefined) {
      return this.discoverRefusal("invalid_request", BALANCED_INVALID_REQUEST_MESSAGE);
    }
    const pageSize = this.pageSizeFor(options);
    const request: ScanRequest = {
      ...read,
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(options.whatsApp === true ? { askBeforeOtherDay: true } : {}),
    };
    // 2026-10-11: a ONE-day scan about an hour that is the caller's own appointment.
    if (request.days === 1 && request.weekdayDates === undefined) {
      const ownMessage = await this.ownBookingMessage(
        options.callerPhoneE164,
        options.whatsApp === true,
        request.dateFrom,
        request.preferredTime,
        request.employeeId,
      );
      if (ownMessage !== undefined) {
        this.optionStore.publish(request.conversationId, [], nowMs);
        return this.discoverRefusal("own_booking_at_time", ownMessage);
      }
    }
    {
      // A scan's sentence already names each day from its real date; the
      // correction of where the window starts is the whole fix here.
      // 2026-10-10: a ONE-day window names that day in every answer
      // («No tengo nada a partir de las seis el viernes dieciséis»).
      const result = await this.scanRefreshed(request, nowMs, options.extendedLookAhead === true);
      const named =
        request.days === 1 && (result.outcome === "options_available" || result.outcome === "no_availability")
          ? { ...result, message: withSpokenDayEs(result.message, request.dateFrom, madridDate(nowMs)) }
          : result;
      return day?.correctedFrom !== undefined ? { ...named, date_corrected_from: day.correctedFrom } : named;
    }

    // *** THE LOCKED HUECO IS NOT TOUCHED HERE (ADR-022). *** A caller asking
    // «¿y cuándo tienes algo?» is browsing. The numbered table still dies
    // BEFORE the reads start (see `scanRefreshed`), so nothing from the old
    // page is choosable; the last lock's token stays exactly as bookable — and
    // exactly as narrow — as it was.
    return this.scanRefreshed(request, nowMs, options.extendedLookAhead === true);
  }

  /** The body of `scan`. */
  private async scanRefreshed(
    request: ScanRequest,
    nowMs: number,
    extendedLookAhead: boolean,
  ): Promise<BalancedDiscoverResult> {
    this.optionStore.publish(request.conversationId, [], nowMs);

    // The salon's own today, for the sentence builder's «hoy» / «mañana».
    const today = madridDate(nowMs);
    const dates = request.weekdayDates
      ? [...request.weekdayDates]
      : windowDates(request.dateFrom, request.days);

    // *** 2026-10-11 — A `weekday` SCAN NEVER LOOKS AT, OR SPEAKS ABOUT, ANOTHER
    // WEEKDAY. *** A closed weekday (or its closed afternoon) is the server's
    // own sentence with zero reads; it never falls into the look-ahead that
    // would offer the nearest OTHER day.
    if (request.weekdayDates !== undefined && request.weekdayName !== undefined) {
      const first = request.weekdayDates[0] as string;
      const closedAll: BalancedDiscoverResult = {
        outcome: "no_availability",
        available: false,
        message: "",
        options: [],
        total_unique_slots: 0,
        has_more: false,
        requested_period: request.period ?? null,
        offered_period: request.period ?? null,
        period_fallback: false,
        days_summary: [],
        days_checked: [],
        partial: false,
        external_mutation: false,
      };
      if (this.isClosedDay(first)) {
        return { ...closedAll, message: balancedScanWeekdayClosedMessage(request.weekdayName) };
      }
      if (this.isClosedAfternoon(first, request.period, request.afterTime)) {
        return { ...closedAll, message: balancedScanWeekdayAfternoonClosedMessage(first) };
      }
    }

    // *** THE SALON'S WEEKLY CLOSURE — DROPPED FROM THE WINDOW BEFORE THE
    // FAN-OUT, NOT AFTER. ***
    //
    // A closed day costs nothing upstream to answer, so it is never fanned
    // out to `this.agenda.read` at all — it cannot appear in `days_checked`
    // or `days_summary`, and it can never be the reason `partial` is set,
    // because it was never "not yet checked": it was never going to be
    // checked.
    const openDates = dates.filter(
      (date) =>
        !this.isClosedDay(date) &&
        !this.isClosedAfternoon(date, request.period, request.afterTime),
    );

    if (openDates.length === 0) {
      // *** 2026-10-09 (call 8dx8gn): THE SAME ANSWER `discover` GIVES. ***
      //
      // A one-day scan of a Saturday afternoon answered «Esos días la
      // peluquería está cerrada» — false, the salon opens Saturday morning —
      // and the caller hung up, while `discover` of the very same question
      // says «Los sábados por la tarde cerramos; lo más cercano es el martes
      // trece…». So when a band can be told from the request, the scan IS that
      // discover look-ahead (same reads, same sentences, same page and
      // continuation), with the scan's hard time limits still filtering.
      const band = this.scanBand(request);
      if (band !== undefined) {
        return this.discoverLookAhead(
          {
            conversationId: request.conversationId,
            serviceId: request.serviceId,
            date: request.dateFrom,
            period: band,
            ...(request.preferredTime !== undefined ? { preferredTime: request.preferredTime } : {}),
            ...(request.employeeId !== undefined ? { employeeId: request.employeeId } : {}),
            ...(request.pageSize !== undefined ? { pageSize: request.pageSize } : {}),
            ...(request.askBeforeOtherDay === true ? { askBeforeOtherDay: true } : {}),
          },
          nowMs,
          "closed",
          extendedLookAhead,
          undefined,
          request.afterTime !== undefined || request.beforeTime !== undefined
            ? this.scanFilter(request)
            : undefined,
        );
      }
      // No band to ask about (e.g. «domingo y lunes» with no time at all).
      // Answered immediately, with zero upstream calls, in the same normal
      // `scan` response shape a `no_availability` answer already has.
      return {
        outcome: "no_availability",
        available: false,
        message: BALANCED_SCAN_ALL_CLOSED_MESSAGE,
        options: [],
        total_unique_slots: 0,
        has_more: false,
        requested_period: request.period ?? null,
        offered_period: request.period ?? null,
        period_fallback: false,
        days_summary: [],
        days_checked: [],
        partial: false,
        external_mutation: false,
      };
    }

    // Wall-clock start: the extended window (ADR-024) only gets what is LEFT.
    const startedAt = Date.now();
    const deadline = scanDeadline(this.scanDeadlineMs);
    let reads: DayRead[];
    try {
      // *** THE DAYS ARE READ TOGETHER, AND THE FAN-OUT LEAVES A PERMIT FREE. ***
      //
      // Seven days sequentially is seven round trips end to end — four seconds
      // of silence on a cold window, which is the latency this action exists to
      // avoid. `mapWithConcurrency` runs them at once; the number of requests
      // actually in flight against the salon's shared host is bounded GLOBALLY,
      // refresher included, by the `PriorityLimiter` inside `AgendaSource`
      // (capacity `UPSTREAM_MAX_CONCURRENCY`, 3).
      //
      // *** IT USED TO FAN OUT TO `request.days`, AND THAT STARVED ITSELF. ***
      //
      // `fetchDay` takes the shared limiter twice per day and lets go in
      // between, so seven lanes against three permits meant three slow days
      // could hold every permit while the fast days queued for their SECOND
      // call — and the deadline then expired on a window whose fast days had
      // been ready for two seconds. Measured: three slow days cost all seven,
      // `days_checked: []`, and a caller heard «no tengo nada» about a week
      // with hours in it. `balancedScanFanOut` keeps one permit free, which is
      // what lets a day in progress finish, and what stops this window from
      // parking another conversation's `discover` behind it.
      //
      // A warm window still makes no upstream call at all, and pays nothing for
      // the narrower fan-out: a cache hit never reaches the limiter.
      const fanOut = balancedScanFanOut(request.days, this.upstreamMaxConcurrency);
      reads = await mapWithConcurrency(openDates, fanOut, (date) =>
        raceDeadline(
          this.readAgenda(
            date,
            request.serviceId,
            nowMs,
            // A caller is on the phone right now: this jumps the refresher's
            // background work in the limiter's queue.
            "interactive",
          ),
          deadline.expired,
        ),
      );
    } finally {
      deadline.cancel();
    }

    // *** ONE DAY FAILING IS A PARTIAL ANSWER; EVERY DAY FAILING IS AN OUTAGE. ***
    //
    // The distinction matters because the two need different sentences. A
    // window with six good days and one failure is still an answer, and
    // pretending otherwise would throw away hours the salon really has. A
    // window where nothing came back is the agenda being unreachable, which is
    // the story `agenda_unavailable` already tells — so the error is rethrown
    // and `src/routes/balancedV2.ts` degrades it exactly as it does for
    // `discover`, with the same message and the same access-line category.
    const failed = reads.filter((entry) => entry.status === "failed");
    if (failed.length === reads.length && failed.length > 0) {
      throw (failed[0] as { status: "failed"; error: unknown }).error;
    }

    const accept = this.scanFilter(request);

    // *** THE PER-DAY CAP EXISTS FOR BREADTH, AND A WINDOW WITH ONE ANSWER
    // HAS NOTHING TO SPREAD. ***
    //
    // Two hours per day is what stops a busy Monday from filling a page the
    // caller asked to be about the WEEK. Applied when only ONE day of the
    // window actually has a matching slot, it does the opposite of its
    // purpose: `days: 2`, Monday empty and Tuesday with seven free hours, the
    // cap still ranked two of Tuesday's, so the caller heard `has_more:
    // false` and `total_unique_slots: 2` about a day that really had seven —
    // and the saved continuation held only the two ranked, so «¿no tienes
    // nada más ese día?» answered `no_more_options` about hours the salon
    // still had. The number spoken out loud was a property of the cap rather
    // than of the salon, exactly as it was for `days: 1` below.
    //
    // The fix is the same one `days: 1` already gets, decided one step later:
    // count the days that came out of the loop with at least one matching
    // slot, and if that count is exactly one — whether because `days` WAS 1
    // or because every other day in the window was empty — there is nothing
    // to spread across, so the only cap left is the memory ceiling every
    // continuation already has (`BALANCED_CONTINUATION_MAX_SLOTS`). `more`
    // can then walk the rest. A window where two or more days matched keeps
    // `BALANCED_SCAN_MAX_PER_DAY`, unchanged, so a caller who really asked
    // about a week still hears a week.
    const daysChecked: string[] = [];
    const daysSummary: BalancedScanDaySummary[] = [];
    const matchingByDay: Array<{ date: string; matching: Map<number, Set<string>> }> = [];
    let partial = false;

    // *** THE ONLY-DAY'S WHOLE INVENTORY, KEPT ASIDE FOR AN EMPTY ANSWER. ***
    //
    // `request.days === 1` means the caller named one day and an hour, and the
    // day WAS read in full — so if nothing matches, the middleware can still
    // say the real nearest free hour instead of gesturing at a band (see the
    // incident note on `balancedScanNoAvailabilityMessage`). `daysSummary`
    // cannot carry that: it only ever holds days with a MATCH. This is that
    // same day's unfiltered, uncapped free hours, kept only when `days === 1`
    // so a seven-day window never pays for a list it will not use.
    let onlyDayEverythingTimes: string[] | undefined;

    openDates.forEach((date, index) => {
      const outcome = reads[index] as DayRead;
      if (outcome.status !== "ok") {
        // Absent from `days_checked`, and the answer says so. Never counted as
        // "nothing that day".
        partial = true;
        return;
      }
      daysChecked.push(date);

      // The day's whole inventory, for the count the agent speaks ("ese día
      // tengo cuatro huecos"), and then the same intersection again under the
      // caller's constraint. Two passes of ONE rule rather than one pass and a
      // subtraction, so "how many are there" and "which ones can I offer" can
      // never be computed from different notions of what a free hour is.
      const everything = this.freeTimesByEmployee(outcome.read.day, date, request.employeeId);
      if (request.days === 1) onlyDayEverythingTimes = uniqueTimesOf(everything);
      const matching = this.freeTimesByEmployee(
        outcome.read.day,
        date,
        request.employeeId,
        accept,
      );
      const matchingTimes = uniqueTimesOf(matching);
      if (matchingTimes.length === 0) return;

      daysSummary.push({
        date,
        weekday_es: weekdayEsOf(date),
        count: uniqueTimesOf(everything).length,
        first_time: matchingTimes[0] as string,
        last_time: matchingTimes[matchingTimes.length - 1] as string,
        // UNCAPPED on purpose: this is how many the SALON has, and the cap
        // below only bounds how many are offered.
        matching_count: matchingTimes.length,
      });
      matchingByDay.push({ date, matching });
    });

    const perDayLimit =
      request.days === 1 || matchingByDay.length === 1
        ? BALANCED_CONTINUATION_MAX_SLOTS
        : BALANCED_SCAN_MAX_PER_DAY;

    const perDay: BalancedOption[][] = matchingByDay.map(({ date, matching }) =>
      this.rankOptions(matching, {
        conversationId: request.conversationId,
        date,
        serviceId: request.serviceId,
        ...(request.preferredTime !== undefined
          ? { preferredTime: request.preferredTime }
          : {}),
        limit: perDayLimit,
      }),
    );

    // *** NOTHING READ AT ALL IS AN OUTAGE, NOT AN EMPTY SALON. ***
    //
    // `days_checked: []` means this answer looked at ZERO days. Reporting that
    // as `no_availability` is the one mistake this whole action was built to
    // avoid: «no tengo nada en los días que he podido mirar» is a sentence
    // about the salon, spoken about a week nobody ever read, and the prompt
    // routes `no_availability` to «¿miramos la otra franja?» — sending the
    // agent off to ask a second question that will fail the same way.
    //
    // `agenda_unavailable` is the story that is actually true, and the prompt
    // already routes it: offer one retry, then hand the caller to WhatsApp. It
    // is the SAME answer the route degrades to when every day of the window
    // fails outright (see the rethrow above) — the only difference is that the
    // salon went silent instead of answering 500, which is a distinction the
    // caller cannot act on.
    //
    // `partial` is deliberately ABSENT rather than true: the field qualifies an
    // answer built from part of a window, and there is no part here. An agent
    // that reads `partial` on an outage would say «en los días que he podido
    // mirar» about nothing at all.
    if (daysChecked.length === 0) {
      this.optionStore.publish(request.conversationId, [], nowMs);
      this.logger?.warn(
        {
          conversation_id: request.conversationId,
          days: request.days,
          date_from: request.dateFrom,
        },
        "balanced v2 scan read no day of the window before its deadline",
      );
      return {
        outcome: "agenda_unavailable",
        available: false,
        message: BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
        options: [],
        total_unique_slots: 0,
        has_more: false,
        requested_period: request.period ?? null,
        offered_period: request.period ?? null,
        period_fallback: false,
        days_summary: [],
        days_checked: [],
        external_mutation: false,
      };
    }

    // *** THE RANKING: DAY ORDER FIRST, ALWAYS. ***
    //
    // `perDay` is already in window order and each day's list is already ranked
    // by the caller's preferred hour and then by the clock, so the flattened
    // list is exactly "date asc, then |hour − preferred| asc, then hour asc".
    // The per-day cap has already been applied, so the global memory cap
    // truncates a list that is ALREADY spread across the window — a fully
    // booked first day can never consume the 32 slots a later day needed.
    const flatRanked = perDay.flat().slice(0, BALANCED_CONTINUATION_MAX_SLOTS);

    // *** A NAMED HOUR ON ONE DAY IS ANSWERED ABOUT THAT HOUR (2026-09-15). ***
    //
    // Same rule as `discover`, for the one scan shape that is a single day:
    // «el martes a partir de las seis… ¿y a las seis y cuarto?». Only when the
    // named hour itself passes the caller's hard condition — otherwise the hour
    // was never eligible and «no tengo hueco» about it could be false. The
    // nearest hours come from `flatRanked`, which `accept` has already
    // filtered, so the floor/ceiling is never crossed to find a neighbour.
    const named =
      request.days === 1 &&
      request.preferredTime !== undefined &&
      isWallClock(request.preferredTime) &&
      accept(request.preferredTime)
        ? preferredTimePage(flatRanked, request.preferredTime)
        : undefined;

    const ranked = (named?.ordered ?? flatRanked).map((option, index) => ({
      ...option,
      optionIndex: index + 1,
    }));

    if (
      ranked.length === 0 &&
      extendedLookAhead &&
      request.days > 1 &&
      !partial &&
      request.weekdayDates === undefined
    ) {
      // *** ADR-024: A FULLY READ, EMPTY WINDOW READS THE FOLLOWING DAYS. ***
      // Only when every open day of the window WAS read: otherwise «no tengo
      // nada en los próximos N días» is not a fact to build on, and the
      // V4 sentence below («en los días que he podido mirar») answers.
      const otherHoursSeen = openDates.some((date, index) => {
        const outcome = reads[index] as DayRead;
        return (
          outcome.status === "ok" &&
          this.freeTimesByEmployee(
            outcome.read.day,
            date,
            request.employeeId,
            (time) => !accept(time),
          ).size > 0
        );
      });
      const extended = await this.scanExtended(request, nowMs, {
        startedAt,
        accept,
        daysChecked,
        otherHoursSeen,
      });
      if (extended !== undefined) return extended;
    }

    if (ranked.length === 0 && request.weekdayDates !== undefined && request.weekdayName !== undefined) {
      // 2026-10-11: nothing on any of those dates. The server's sentence, about
      // THAT weekday only; the next search starts the day after the last date.
      this.optionStore.publish(request.conversationId, [], nowMs);
      return {
        outcome: "no_availability",
        available: false,
        message: balancedScanWeekdayNoAvailabilityMessage({
          weekday: request.weekdayName,
          weeks: request.weekdayDates.length,
          partial,
        }),
        options: [],
        total_unique_slots: 0,
        has_more: false,
        requested_period: request.period ?? null,
        offered_period: request.period ?? null,
        period_fallback: false,
        days_summary: [],
        days_checked: daysChecked,
        partial,
        next_search_from: addDays(request.weekdayDates[request.weekdayDates.length - 1] as string, 1),
        external_mutation: false,
      };
    }

    if (ranked.length === 0) {
      // *** THE NEAREST HOUR OUTSIDE THE CONSTRAINT — ONLY WHEN ONE BOUNDARY
      // BOUNDS A SINGLE, FULLY-READ DAY. ***
      //
      // Exactly one of `afterTime` / `beforeTime` (never both, never neither):
      // that is the one shape a single day's uncapped inventory can answer
      // with a real "closest" hour rather than a band. Since NOTHING on this
      // day satisfied `accept`, every free hour it has sits on the wrong side
      // of the boundary — so the nearest one is simply the last hour before an
      // `afterTime` floor, or the first hour after a `beforeTime` ceiling.
      const oneHourBoundary =
        (request.afterTime !== undefined) !== (request.beforeTime !== undefined);
      const nearestOutsideConstraint =
        request.days === 1 && oneHourBoundary && onlyDayEverythingTimes !== undefined
          ? request.afterTime !== undefined
            ? onlyDayEverythingTimes.at(-1)
            : onlyDayEverythingTimes[0]
          : undefined;

      // Nothing anywhere in the window — or nothing in the part of it we could
      // read, which is why `days_checked` and `partial` travel with the
      // refusal. The options and the cursor are already empty from the publish
      // above; this second one is the same belt-and-braces `discover` uses.
      this.optionStore.publish(request.conversationId, [], nowMs);
      return {
        outcome: "no_availability",
        available: false,
        message: balancedScanNoAvailabilityMessage({
          ...(request.afterTime !== undefined ? { afterTime: request.afterTime } : {}),
          ...(request.beforeTime !== undefined ? { beforeTime: request.beforeTime } : {}),
          ...(request.period !== undefined ? { period: request.period } : {}),
          days: request.days,
          partial,
          ...(nearestOutsideConstraint !== undefined ? { nearestOutsideConstraint } : {}),
        }),
        options: [],
        total_unique_slots: 0,
        has_more: false,
        requested_period: request.period ?? null,
        offered_period: request.period ?? null,
        period_fallback: false,
        days_summary: [],
        days_checked: daysChecked,
        partial,
        // The message now offers «la semana siguiente» / «los días siguientes»
        // concretely; this is where that next window starts.
        ...(request.days > 1
          ? { next_search_from: addDays(request.dateFrom, request.days) }
          : {}),
        external_mutation: false,
      };
    }

    const page = numberPage(
      ranked.slice(0, named?.pageSize ?? fittedPageSize(pageSizeOf(request), ranked.length)),
    );
    const continuation: BalancedContinuation = {
      kind: "scan",
      serviceId: request.serviceId,
      dateFrom: request.dateFrom,
      days: request.days,
      ...(request.weekdayDates !== undefined ? { dates: [...request.weekdayDates] } : {}),
      ...(request.afterTime !== undefined ? { afterTime: request.afterTime } : {}),
      ...(request.beforeTime !== undefined ? { beforeTime: request.beforeTime } : {}),
      ...(request.period !== undefined ? { period: request.period } : {}),
      ...(request.preferredTime !== undefined
        ? { preferredTime: request.preferredTime }
        : {}),
      ...(request.employeeId !== undefined ? { employeeId: request.employeeId } : {}),
      daysChecked,
      partial,
      rankedOptions: ranked,
      offset: page.length,
    };
    this.optionStore.publish(request.conversationId, page, nowMs, continuation, pageSizeOf(request));

    const hasMore = page.length < ranked.length;
    return {
      outcome: "options_available",
      available: true,
      // The PAGE itself, not its projection: the sentence builder numbers its
      // day chunks from the same `optionIndex` the caller will say back, and
      // `todayIso` is what lets it say «hoy» / «mañana» instead of a date the
      // caller has to translate. Both are facts this service already holds.
      message:
        named !== undefined && request.preferredTime !== undefined
          ? balancedPreferredTimeMessage(
              request.preferredTime,
              page.map((option) => option.time),
              { exact: named.exact },
            )
          : balancedScanMessage(page, daysSummary, { hasMore, todayIso: today }),
      // The SAME three fields as `discover`: no professional, no token, no
      // hint of the assignment. A window question is still a browsing question.
      options: this.project(page),
      total_unique_slots: ranked.length,
      has_more: hasMore,
      // A scan never flips the band, so the two are the same value and the
      // fallback is false by construction — see `BalancedScanContinuation`.
      requested_period: request.period ?? null,
      offered_period: request.period ?? null,
      period_fallback: false,
      page_index: 1,
      offered_so_far: page.length,
      days_summary: daysSummary,
      days_checked: daysChecked,
      partial,
      external_mutation: false,
    };
  }

  /**
   * *** ADR-024 — THE EXTENDED SCAN (V5 requests only, ADR-025). ***
   *
   * Called only for a multi-day window that was read IN FULL and has nothing
   * matching. Reads the following days — up to
   * {@link EXTENDED_LOOKAHEAD_TOTAL_DAYS} in total counted from `date_from` —
   * under EXACTLY the same condition (after/before/band/professional,
   * `preferred_time` for ranking), with the scan's fan-out, closed weekdays
   * dropped, reads stopped at the nearest matching day, and only the time LEFT
   * of the scan's single deadline.
   *
   * - Nearest day found, every nearer open day read → a normal scan page of
   *   that day (continuation `kind: "scan"` spanning `date_from`..that day, so
   *   `more` and `lock` by `option_index` work as for any scan page).
   * - Every following day read, nothing → an open question with no options
   *   and `next_search_from` fourteen days after `date_from`.
   * - Anything else (failure, deadline, an unread nearer day) → `undefined`,
   *   and the caller answers the V4 sentence.
   *
   * Like every query it never touches the locked hueco (ADR-022).
   */
  private async scanExtended(
    request: ScanRequest,
    nowMs: number,
    first: {
      startedAt: number;
      accept: (time: string) => boolean;
      daysChecked: readonly string[];
      otherHoursSeen: boolean;
    },
  ): Promise<BalancedDiscoverResult | undefined> {
    const fallback = (cause: string): undefined => {
      this.logger?.warn(
        {
          conversation_id: request.conversationId,
          days: request.days,
          date_from: request.dateFrom,
          extended_lookahead_fallback: cause,
        },
        "balanced v2 extended scan could not read the following days; answering the window sentence",
      );
      return undefined;
    };

    const dates = windowDates(
      addDays(request.dateFrom, request.days),
      EXTENDED_LOOKAHEAD_TOTAL_DAYS - request.days,
    ).filter(
      (date) =>
        !this.isClosedDay(date) &&
        !this.isClosedAfternoon(date, request.period, request.afterTime),
    );
    const remainingMs = this.scanDeadlineMs - (Date.now() - first.startedAt);
    if (remainingMs <= 0) return fallback("deadline");

    const matchingOf = (read: AgendaRead, date: string): Map<number, Set<string>> =>
      this.freeTimesByEmployee(read.day, date, request.employeeId, first.accept);

    const deadline = sharedDeadline(remainingMs);
    let result: { reads: LookAheadRead[]; nearest: number };
    try {
      result = await this.readUntilNearest(
        dates,
        request.serviceId,
        (read, date) => matchingOf(read, date).size > 0,
        deadline,
        nowMs,
      );
    } catch {
      return fallback("read_error");
    } finally {
      deadline.cancel();
    }
    const { reads, nearest } = result;

    const common = {
      requested_period: request.period ?? null,
      offered_period: request.period ?? null,
      period_fallback: false,
    } as const;

    if (!Number.isFinite(nearest)) {
      if (dates.some((_date, index) => okReadOf(reads, index) === undefined)) {
        return fallback("partial_window");
      }
      const otherHoursSeen =
        first.otherHoursSeen ||
        dates.some(
          (date, index) =>
            this.freeTimesByEmployee(
              (okReadOf(reads, index) as AgendaRead).day,
              date,
              request.employeeId,
              (time) => !first.accept(time),
            ).size > 0,
        );
      this.optionStore.publish(request.conversationId, [], nowMs);
      return {
        outcome: "no_availability",
        available: false,
        message: balancedScanTwoWeeksNothingMessage({
          ...(request.afterTime !== undefined ? { afterTime: request.afterTime } : {}),
          ...(request.beforeTime !== undefined ? { beforeTime: request.beforeTime } : {}),
          ...(request.period !== undefined ? { period: request.period } : {}),
          otherHoursSeen,
        }),
        options: [],
        total_unique_slots: 0,
        has_more: false,
        ...common,
        days_summary: [],
        days_checked: [...first.daysChecked, ...dates],
        partial: false,
        next_search_from: addDays(request.dateFrom, EXTENDED_LOOKAHEAD_TOTAL_DAYS),
        external_mutation: false,
      };
    }

    // «Lo más cercano» is only true if no nearer open day went unread.
    for (let index = 0; index < nearest; index += 1) {
      if (okReadOf(reads, index) === undefined) return fallback("nearer_day_unread");
    }

    const date = dates[nearest] as string;
    const read = okReadOf(reads, nearest) as AgendaRead;
    const matching = matchingOf(read, date);
    const matchingTimes = uniqueTimesOf(matching);
    const options = this.rankOptions(matching, {
      conversationId: request.conversationId,
      date,
      serviceId: request.serviceId,
      ...(request.preferredTime !== undefined ? { preferredTime: request.preferredTime } : {}),
      // One day: nothing to spread across, so only the memory ceiling applies.
      limit: BALANCED_CONTINUATION_MAX_SLOTS,
    });
    const named =
      request.preferredTime !== undefined &&
      isWallClock(request.preferredTime) &&
      first.accept(request.preferredTime)
        ? preferredTimePage(options, request.preferredTime)
        : undefined;
    const ranked = (named?.ordered ?? options).map((option, index) => ({
      ...option,
      optionIndex: index + 1,
    }));
    const page = numberPage(
      ranked.slice(0, named?.pageSize ?? fittedPageSize(pageSizeOf(request), ranked.length)),
    );
    if (page.length === 0) return fallback("no_assignable_hour");

    // Honest about what was read: the first window, then the following days
    // up to and including the offered one (every one of them arrived).
    const daysChecked = [...first.daysChecked, ...dates.slice(0, nearest + 1)];
    const daysSummary: BalancedScanDaySummary[] = [
      {
        date,
        weekday_es: weekdayEsOf(date),
        count: uniqueTimesOf(this.freeTimesByEmployee(read.day, date, request.employeeId)).length,
        first_time: matchingTimes[0] as string,
        last_time: matchingTimes[matchingTimes.length - 1] as string,
        matching_count: matchingTimes.length,
      },
    ];
    const continuation: BalancedContinuation = {
      kind: "scan",
      serviceId: request.serviceId,
      dateFrom: request.dateFrom,
      days: daysBetween(request.dateFrom, date) + 1,
      ...(request.afterTime !== undefined ? { afterTime: request.afterTime } : {}),
      ...(request.beforeTime !== undefined ? { beforeTime: request.beforeTime } : {}),
      ...(request.period !== undefined ? { period: request.period } : {}),
      ...(request.preferredTime !== undefined ? { preferredTime: request.preferredTime } : {}),
      ...(request.employeeId !== undefined ? { employeeId: request.employeeId } : {}),
      daysChecked,
      partial: false,
      rankedOptions: ranked,
      offset: page.length,
    };
    this.optionStore.publish(request.conversationId, page, nowMs, continuation, pageSizeOf(request));

    const hasMore = page.length < ranked.length;
    return {
      outcome: "options_available",
      available: true,
      message: balancedScanExtendedMessage({
        ...(request.afterTime !== undefined ? { afterTime: request.afterTime } : {}),
        ...(request.beforeTime !== undefined ? { beforeTime: request.beforeTime } : {}),
        ...(request.period !== undefined ? { period: request.period } : {}),
        days: request.days,
        offeredDate: date,
        times: page.map((option) => option.time),
      }),
      options: this.project(page),
      total_unique_slots: ranked.length,
      has_more: hasMore,
      ...common,
      page_index: 1,
      offered_so_far: page.length,
      days_summary: daysSummary,
      days_checked: daysChecked,
      partial: false,
      external_mutation: false,
    };
  }

  /**
   * The caller's constraint, as ONE predicate over `HH:mm`.
   *
   * Built once per scan rather than per day so every day of the window is
   * filtered by literally the same function — the cheapest possible guarantee
   * that "a partir de las cinco" cannot mean something different on Thursday.
   */
  /**
   * 2026-10-09 — the half of the day a scan is about, for the closed-window
   * look-ahead: `time_period` if sent, else the band of `after_time`, of
   * `before_time`, or of `preferred_time`. `undefined` when none was sent.
   */
  private scanBand(request: ScanRequest): TimePeriod | undefined {
    if (request.period !== undefined) return request.period;
    const hint = request.afterTime ?? request.beforeTime ?? request.preferredTime;
    return hint !== undefined && isWallClock(hint) ? periodOf(hint) : undefined;
  }

  private scanFilter(request: ScanRequest): (time: string) => boolean {
    const floor =
      request.afterTime !== undefined ? minutesOf(request.afterTime) : undefined;
    const ceiling =
      request.beforeTime !== undefined ? minutesOf(request.beforeTime) : undefined;
    const period = request.period;
    return (time: string): boolean => {
      const minutes = minutesOf(time);
      if (floor !== undefined && minutes < floor) return false;
      if (ceiling !== undefined && minutes > ceiling) return false;
      if (period !== undefined && periodOf(time) !== period) return false;
      return true;
    };
  }

  /**
   * *** THE BARBER IS NOT IN THIS PROJECTION. ***
   *
   * Three fields, by construction and in ONE place shared by `discover` and
   * `more`, so there is no path by which an assignment could reach the model
   * before the summary — and no second projection that could gain a field.
   */
  private project(options: readonly BalancedOption[]): BalancedDiscoverOption[] {
    return options.map((option) => ({
      option_index: option.optionIndex,
      date: option.date,
      time: option.time,
    }));
  }

  /** A read refusal: no options, no bands, nothing reconstructed. */
  private discoverRefusal(
    outcome: BalancedDiscoverOutcome,
    message: string,
  ): BalancedDiscoverResult {
    return {
      outcome,
      available: false,
      message,
      options: [],
      total_unique_slots: 0,
      has_more: false,
      requested_period: null,
      offered_period: null,
      period_fallback: false,
      external_mutation: false,
    };
  }

  /**
   * *** ACTION: lock — the one place a bookable token is born. ***
   *
   * Three things have to be true before a token exists, and they are checked in
   * this order because each one is cheaper and more informative than the next:
   *
   * 1. The index is one THIS conversation was offered. An index from another
   *    call, an expired set, or a number nobody spoke is refused with zero
   *    upstream calls and zero mutation.
   * 2. The exact hour is still free UPSTREAM, read with the cache out of the
   *    path (`readFresh`, ADR-010). A cached day may OFFER an hour; it may
   *    never authorize one.
   * 3. A barber is genuinely free at it — the caller's requested one when they
   *    asked for someone, otherwise the assignment, re-validated.
   */
  async lock(
    body: unknown,
    nowMs: number,
    lockOptions: BalancedLockOptions = {},
  ): Promise<BalancedLockResult> {
    const request = this.readLock(body);
    if (request === undefined) {
      return this.lockRefusal("invalid_request", BALANCED_INVALID_REQUEST_MESSAGE);
    }
    // *** THE INDEX IS CHECKED AGAINST THE PAGE THAT WAS PUBLISHED (2026-10-08). ***
    //
    // A WhatsApp page may hold up to ten options, so `readLock` accepts up to
    // that ceiling. Whether THIS conversation's page did is a fact of the
    // store, not of any header: a voice page (or no page at all) keeps the
    // spoken limit, and an index above it is the very same `invalid_request`
    // it always was — no store lookup, no touch, no upstream call.
    // Indices 1..3 never consult it, so the voice path is untouched.
    if (
      request.optionIndex > BALANCED_MAX_OPTIONS &&
      request.optionIndex >
        (this.optionStore.pageSize(request.conversationId, nowMs) ?? BALANCED_MAX_OPTIONS)
    ) {
      return this.lockRefusal("invalid_request", BALANCED_INVALID_REQUEST_MESSAGE);
    }

    // *** 2026-10-09 (call r3557a): THE INDEX IS POSITIONAL, THE HOUR IS NOT. ***
    //
    // `option_index` means «the n-th hour of the MOST RECENT page», and every
    // discover/scan/more replaces that page wholesale (`publish`). When a
    // later discover (a misheard «7:00 a.m.») replaced the page the agent was
    // thinking of, `option_index: 1` locked 10:00 instead of 19:00. When the
    // lock also says WHAT it means (`option_time`, optionally `option_date`),
    // the option is resolved against that: the index if it matches, otherwise
    // the single option of the page that does, otherwise nothing is locked.
    // Without those fields this is exactly the old lookup.
    const expected = readExpectedOption(lockOptions);
    const lookup:
      | { ok: true; option: BalancedOption; generation: number; correctedFrom?: number }
      | { ok: false; refusal: string } =
      expected === undefined
        ? this.optionStore.get(request.conversationId, request.optionIndex, nowMs)
        : this.lookupExpected(request.conversationId, request.optionIndex, expected, nowMs);
    if (!lookup.ok && expected !== undefined) {
      // No hour in the log: the conversation id and the reason only.
      this.logger?.warn(
        {
          conversation_id: request.conversationId,
          option_index: request.optionIndex,
          option_refusal: lookup.refusal,
        },
        "balanced v2 lock refused: option_time/option_date match no option of the most recent page",
      );
      return {
        outcome: "option_not_found",
        locked: false,
        message: balancedLockMismatchMessage(expected.time, expected.date),
        option_mismatch: true,
        ...(expected.time !== undefined ? { requested_time: expected.time } : {}),
        ...(expected.date !== undefined ? { requested_date: expected.date } : {}),
        external_mutation: false,
      };
    }
    if (!lookup.ok) {
      // The reason and the conversation id. Never the option contents — an
      // hour a caller was offered is still the salon's commercial information.
      this.logger?.warn(
        { conversation_id: request.conversationId, option_refusal: lookup.refusal },
        "balanced v2 lock refused: that option is not one this conversation is holding",
      );
      return this.lockRefusal("option_not_found", BALANCED_OPTION_UNKNOWN_MESSAGE);
    }

    // *** THE PREVIOUS LOCK IS SUSPENDED AT ENTRY, NOT AT THE END (ADR-022). ***
    //
    // A lock is the ONLY operation that changes what this conversation can
    // book. From here until this lock finishes, nothing is bookable: a create
    // racing a change of choice cannot spend the previous token while the new
    // one is being minted. How the suspension ends:
    //
    // - `locked` → the new token REPLACES the previous one (compare-and-set by
    //   generation; if an even newer lock started meanwhile, this one yields).
    // - any refusal, or a throw → the previous lock is PUT BACK: nothing new
    //   was chosen, so the hueco the caller confirmed is still the one they hold.
    const generation = this.offerStore.beginRefresh(request.conversationId, nowMs);
    // 2026-10-11: the chosen hour is the caller's own appointment. AFTER the
    // suspension on purpose (the guard may await the dashboard, and ADR-022
    // needs the suspension to be synchronous with the lock's entry). Nothing is
    // locked; the previous lock is put back, like any other refusal.
    const ownMessage = await this.ownBookingMessage(
      lockOptions.callerPhoneE164,
      lockOptions.whatsApp === true,
      lookup.option.date,
      lookup.option.time,
      request.preferredEmployeeId,
    );
    if (ownMessage !== undefined) {
      this.restorePreviousLock(request.conversationId, generation, nowMs);
      return this.lockRefusal("own_booking_at_time", ownMessage);
    }
    let result: BalancedLockResult;
    try {
      result = await this.lockOption(request, lookup.option, nowMs);
    } catch (error) {
      this.restorePreviousLock(request.conversationId, generation, nowMs);
      throw error;
    }

    const token = result.locked ? result.slot?.slot_token : undefined;
    if (token === undefined) {
      this.restorePreviousLock(request.conversationId, generation, nowMs);
      return result;
    }
    if (!this.offerStore.publishOffered(request.conversationId, generation, [token], nowMs)) {
      // A newer lock of this same conversation started while this one was
      // reading the agenda. It wins; this token was never bookable, so it must
      // not be announced as locked.
      this.logger?.warn(
        { conversation_id: request.conversationId },
        "balanced v2 lock superseded by a newer lock of the same conversation",
      );
      return this.lockRefusal("option_not_found", BALANCED_OPTION_UNKNOWN_MESSAGE);
    }
    if (lookup.correctedFrom !== undefined) {
      this.logger?.warn(
        { conversation_id: request.conversationId, option_index_corrected_from: lookup.correctedFrom },
        "balanced v2 lock: option_index pointed at another hour; locked the option matching option_time",
      );
      return { ...result, option_index_corrected_from: lookup.correctedFrom };
    }
    return result;
  }

  /**
   * 2026-10-09 — resolves a lock that said what it means. The index wins only
   * when its option matches; otherwise exactly ONE option of the most recent
   * page must match (two hours «18:00» on different days of a scan page,
   * without `option_date`, is ambiguous and refused). Only the page that was
   * spoken is searched, never the continuation behind it.
   */
  private lookupExpected(
    conversationId: string,
    optionIndex: number,
    expected: ExpectedOption,
    nowMs: number,
  ):
    | { ok: true; option: BalancedOption; generation: number; correctedFrom?: number }
    | { ok: false; refusal: string } {
    const indexed = this.optionStore.get(conversationId, optionIndex, nowMs);
    if (indexed.ok && matchesExpected(indexed.option, expected)) return indexed;
    const size = this.optionStore.pageSize(conversationId, nowMs);
    if (size === undefined) return { ok: false, refusal: indexed.ok ? "expired" : indexed.refusal };
    const matches: Array<{ option: BalancedOption; generation: number }> = [];
    for (let index = 1; index <= size; index += 1) {
      const candidate = this.optionStore.get(conversationId, index, nowMs);
      if (candidate.ok && matchesExpected(candidate.option, expected)) matches.push(candidate);
    }
    if (matches.length === 0) return { ok: false, refusal: "option_mismatch" };
    if (matches.length > 1) return { ok: false, refusal: "option_ambiguous" };
    const match = matches[0]!;
    return { ok: true, option: match.option, generation: match.generation, correctedFrom: optionIndex };
  }

  /** A lock that did not produce a token leaves the previous one bookable. */
  private restorePreviousLock(conversationId: string, generation: number, nowMs: number): void {
    const outcome = this.offerStore.publishEmptyPreservingPrior(conversationId, generation, nowMs);
    if (outcome === "preserved") {
      // Conversation id only: no token, no digest, no customer data.
      const detail = { conversation_id: conversationId, previous_lock_kept: true };
      const message = "balanced v2: lock did not succeed, previous lock kept";
      if (this.logger?.info !== undefined) this.logger.info(detail, message);
      else this.logger?.warn(detail, message);
    }
  }

  /**
   * The body of `lock`, with the offer store already suspended: re-reads the
   * day, picks the professional and mints the token. Publishing it is the
   * caller's job ({@link lock}).
   */
  private async lockOption(
    request: LockRequest,
    option: BalancedOption,
    nowMs: number,
  ): Promise<BalancedLockResult> {
    // *** THE CACHE MAY NOT AUTHORIZE THIS. *** ((internal doc, not included in the template) ADR-010.)
    // *** AN HOUR THAT HAS STARTED SINCE IT WAS OFFERED IS GONE (2026-09-18). ***
    // Offered at 10:05 for 10:30, locked at 10:12: too late, and the answer is
    // the one that already means «that hour is no longer available». Refused
    // before the agenda is even read; the fresh read below is filtered too.
    if (this.tooSoon(option.reservationDate, nowMs)) {
      return this.lockRefusal("slot_taken", BALANCED_SLOT_TAKEN_MESSAGE);
    }
    const read = await this.readAgendaFresh(option.date, option.serviceId, nowMs);
    // *** THE ONLY MOMENT THE BARBER'S NAME AND ID ARE BOTH IN HAND. ***
    //
    // The slot token seals an `employee_id` and nothing else, so by the time
    // `/ai/voice/v2/book` writes the appointment the person has become a
    // number. Remembering the roster HERE — from a read this lock was making
    // anyway — is what lets the WhatsApp confirmation say «con Bruno» without
    // putting one extra upstream call on the write path. Nothing below reads
    // it and no decision depends on it.
    for (const employee of read.day.employees) {
      this.employeeNames?.record(employee.id, employee.name);
    }
    const freeNow = this.employeesFreeAt(read.day, option.reservationDate);

    if (freeNow.length === 0) {
      // Taken between the offer and the choice. Nothing was written, nothing
      // was authorized, and the honest next move is another hour.
      return this.lockRefusal("slot_taken", BALANCED_SLOT_TAKEN_MESSAGE);
    }

    // Who the caller currently has, recomputed against the FRESH day so the
    // fallback offered below is real rather than remembered.
    const assignedId = freeNow.some((entry) => entry.id === option.assignedEmployeeId)
      ? // *** STABILITY WITHIN THE CALL. *** The barber picked at discovery is
        // kept whenever they are still free, so the summary the agent reads
        // cannot contradict a summary it read a moment earlier. Only when that
        // person is gone is the choice recomputed.
        option.assignedEmployeeId
      : this.pickLeastLoaded(read.day, option, freeNow, request.conversationId);
    const assigned = freeNow.find((entry) => entry.id === assignedId) ?? freeNow[0]!;

    let chosen = assigned;
    if (request.preferredEmployeeId !== undefined) {
      // *** AN EXPLICIT PREFERENCE BEATS THE BALANCER, ALWAYS. ***
      // Balancing is the salon's convenience; the caller's request is the
      // caller's. But it is a request for a real hour with a real person, so it
      // is checked against the same fresh day and refused if it is not true.
      const preferred = freeNow.find((entry) => entry.id === request.preferredEmployeeId);
      if (preferred === undefined) {
        return {
          outcome: "employee_unavailable",
          locked: false,
          message: balancedEmployeeUnavailableMessage(
            this.nameOf(read.day, request.preferredEmployeeId),
            spokenEmployeeName(assigned.name),
            option.time,
          ),
          current_employee_id: assigned.id,
          current_employee_name: spokenEmployeeName(assigned.name),
          external_mutation: false,
        };
      }
      chosen = preferred;
    }

    const token = this.slotAuthorization.issue(
      {
        conversationId: request.conversationId,
        reservationDate: option.reservationDate,
        employeeId: chosen.id,
        serviceId: option.serviceId,
      },
      nowMs,
    );
    if (token === undefined) {
      // No secret configured, or a date this service cannot seal exactly. Both
      // are fail-closed: the hour is real and still free, it simply cannot be
      // authorized, so nothing is offered that could not be honoured.
      this.logger?.warn(
        { conversation_id: request.conversationId },
        "balanced v2 lock refused: no slot token could be issued (VOICE_SLOT_TOKEN_SECRET absent?)",
      );
      // *** AND IT MUST NOT SAY «necesito volver a mirar la agenda». ***
      //
      // That is `BALANCED_OPTION_UNKNOWN_MESSAGE`, the sentence for an option
      // this conversation is not holding, and it was the wrong one here twice
      // over: it misstates the cause — the hour is real, free, and held — and
      // it INSTRUCTS the agent to go back to `discover`. On a deployment with
      // no secret that closes a loop: discover, offer, lock, fail, discover,
      // until the caller hangs up. This sentence names the real state and
      // invites nothing; the way forward is the prompt's, not the middleware's.
      return this.lockRefusal(
        "authorization_unavailable",
        BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE,
      );
    }

    // *** THIS TOKEN, AND NOTHING ELSE, BECOMES BOOKABLE — in `lock`. ***
    //
    // `lock` publishes it over the generation it suspended at entry, so a
    // caller who locks option 2, then changes to option 3, then changes
    // professional, is left with exactly ONE live authorization at every
    // instant — the one whose `slot` the agent reads the summary from.
    return {
      outcome: "locked",
      locked: true,
      message: balancedLockedMessage(option.reservationDate, spokenEmployeeName(chosen.name)),
      summary: balancedLockSummaryEs({
        serviceId: option.serviceId,
        reservationDate: option.reservationDate,
        employeeName: spokenEmployeeName(chosen.name),
      }),
      slot: {
        date: option.date,
        time: option.time,
        reservation_date: option.reservationDate,
        employee_id: chosen.id,
        employee_name: spokenEmployeeName(chosen.name),
        slot_token: token,
      },
      external_mutation: false,
    };
  }

  // ── building the options ────────────────────────────────────────────────

  /**
   * The salon's unique free hours in one band — ALL of them, in the order they
   * will be offered — each with its least-loaded eligible barber.
   *
   * It used to return three. That single `slice(0, 3)` was the bug: the other
   * hours were computed, counted, promised through `has_more`, announced out
   * loud by `balancedOptionsMessage`, and then thrown away, so there was
   * nothing left for a continuation to continue. Now the cut happens at the
   * CALLER, which publishes a page and keeps the tail.
   *
   * It is now two steps — the eligibility intersection and the ranking — and
   * both are shared with `scan`, which asks the identical question of seven
   * days and a time constraint instead of one day and a band. What `discover`
   * still owns is the BAND: the filter it passes, and the fallback to the other
   * half of the day that `scan` deliberately does not have.
   */
  private buildOptions(
    day: AgendaDay,
    request: DiscoverRequest,
    period: TimePeriod,
  ): { options: BalancedOption[]; period: TimePeriod } {
    const freeByEmployee = this.freeTimesByEmployee(
      day,
      request.date,
      request.employeeId,
      (time) => periodOf(time) === period,
    );
    const options = this.rankOptions(freeByEmployee, {
      conversationId: request.conversationId,
      date: request.date,
      serviceId: request.serviceId,
      ...(request.preferredTime !== undefined
        ? { preferredTime: request.preferredTime }
        : {}),
      // Bounded ONLY by the continuation's memory cap — a page is cut later, by
      // the caller. See `BALANCED_CONTINUATION_MAX_SLOTS` for why a hard
      // ceiling exists at all.
      limit: BALANCED_CONTINUATION_MAX_SLOTS,
    });
    // No separate "how many there really are" is returned, deliberately. The
    // list IS the count — `total_unique_slots` is `options.length` — so the
    // number the agent speaks can never exceed the number of hours the
    // middleware is actually able to offer, even at the truncation cap.
    return { options, period };
  }

  /**
   * *** ELIGIBILITY, IN ONE PLACE — AND NOW IN ONE PLACE FOR BOTH QUESTIONS. ***
   *
   * On duty that day (`employees`), with at least one free hour (`freeFor`
   * returns nothing for a barber who has none), on the DATE asked about, and —
   * only when the caller named someone — that specific person. Nothing here
   * infers an absence, synthesises an hour or assumes a weekly pattern.
   *
   * `accept` is the only thing `discover` and `scan` differ by: a band for one,
   * the caller's floor/ceiling/band for the other. Everything else — which
   * barbers count, which slots belong to this day, how a free hour is spelled —
   * is this function's, so the two actions cannot drift into two notions of
   * what the salon has free.
   *
   * The returned sets are ALSO the load proxy (`employeeBalance.ts` compares
   * their sizes), which is why the filter is applied here rather than
   * afterwards: "least loaded" has to mean least loaded among the hours the
   * caller could actually be offered.
   */
  private freeTimesByEmployee(
    day: AgendaDay,
    date: string,
    employeeId: number | undefined,
    accept: (time: string) => boolean = () => true,
  ): Map<number, Set<string>> {
    const roster = day.employees.filter(
      (employee) => employeeId === undefined || employee.id === employeeId,
    );

    const freeByEmployee = new Map<number, Set<string>>();
    for (const employee of roster) {
      const record = freeFor(day, employee.id);
      if (record === undefined) continue;
      const times = new Set<string>();
      for (const slot of record.slots) {
        if (slot.start.slice(0, 10) !== date) continue;
        const time = timeLabelFromString(slot.start);
        if (!accept(time)) continue;
        times.add(time);
      }
      if (times.size > 0) freeByEmployee.set(employee.id, times);
    }
    return freeByEmployee;
  }

  /**
   * One day's free hours, ranked and turned into options with a barber each.
   *
   * The list is in OFFER order (nearest to `preferred_time`, otherwise
   * chronological), not clock order. Clock order is applied per page by
   * `numberPage`, because the numbering must match the order the caller hears —
   * and a page is what they hear.
   *
   * `limit` is what `discover` and `scan` disagree about, and only that: the
   * whole band for a day question (bounded by the continuation's memory cap),
   * {@link BALANCED_SCAN_MAX_PER_DAY} for one day of a window.
   */
  private rankOptions(
    freeByEmployee: Map<number, Set<string>>,
    context: {
      conversationId: string;
      date: string;
      serviceId: number;
      preferredTime?: string;
      limit: number;
    },
  ): BalancedOption[] {
    // *** UNIQUE HOURS OF THE SALON, NOT (hour, barber) PAIRS. ***
    const uniqueTimes = uniqueTimesOf(freeByEmployee);
    if (uniqueTimes.length === 0) return [];

    // Rank: nearest to a time the caller mentioned, otherwise chronological.
    const target =
      context.preferredTime !== undefined ? minutesOf(context.preferredTime) : undefined;
    const ranked = [...uniqueTimes].sort((a, b) => {
      if (target !== undefined) {
        const distance = Math.abs(minutesOf(a) - target) - Math.abs(minutesOf(b) - target);
        if (distance !== 0) return distance;
      }
      return a.localeCompare(b);
    });

    const selected = ranked.slice(0, context.limit);

    const options: BalancedOption[] = [];
    selected.forEach((time, index) => {
      const eligible = [...freeByEmployee.entries()]
        .filter(([, times]) => times.has(time))
        .map(([employeeId]) => employeeId);
      const candidates: BalanceCandidate[] = eligible.map((employeeId) => ({
        employeeId,
        // The load proxy: free compatible hours in this same day, service and
        // band. See `employeeBalance.ts` for why this measures load and what
        // would replace it the day upstream exposes real occupancy.
        freeCompatibleSlots: freeByEmployee.get(employeeId)?.size ?? 0,
      }));
      const assigned = leastLoadedEmployee(candidates, {
        conversationId: context.conversationId,
        date: context.date,
        time,
      });
      if (assigned === undefined) return;
      options.push({
        optionIndex: index + 1,
        date: context.date,
        time,
        reservationDate: `${context.date} ${time}:00`,
        serviceId: context.serviceId,
        // From the hour ITSELF, not from the question. Identical to the band
        // being built for `discover` (every hour in it is in that band by
        // construction), and the only correct answer for a window, where two
        // options of the same page can sit either side of 14:00.
        period: periodOf(time),
        assignedEmployeeId: assigned,
        eligibleEmployeeIds: eligible,
      });
    });

    return options;
  }

  /** Every barber free at that EXACT wall-clock instant, in a fresh day. */
  private employeesFreeAt(
    day: AgendaDay,
    reservationDate: string,
  ): Array<{ id: number; name: string; surnames: string }> {
    const out: Array<{ id: number; name: string; surnames: string }> = [];
    for (const employee of day.employees) {
      const record = freeFor(day, employee.id);
      if (record === undefined) continue;
      if (record.slots.some((slot) => slot.start === reservationDate)) {
        out.push({ id: employee.id, name: employee.name, surnames: employee.surnames });
      }
    }
    return out;
  }

  /**
   * Re-runs the balancer against the fresh day, for the case where the barber
   * picked at discovery is no longer free at that hour.
   *
   * The load proxy is recomputed from the same band the option belongs to, so
   * "least loaded" still means the same thing it meant at discovery.
   */
  private pickLeastLoaded(
    day: AgendaDay,
    option: BalancedOption,
    freeNow: ReadonlyArray<{ id: number }>,
    conversationId: string,
  ): number {
    const candidates: BalanceCandidate[] = freeNow.map((entry) => {
      const record = freeFor(day, entry.id);
      const count = (record?.slots ?? []).filter(
        (slot) =>
          slot.start.slice(0, 10) === option.date && periodOf(slot.start) === option.period,
      ).length;
      return { employeeId: entry.id, freeCompatibleSlots: count };
    });
    return (
      leastLoadedEmployee(candidates, {
        conversationId,
        date: option.date,
        time: option.time,
      }) ?? freeNow[0]!.id
    );
  }

  private nameOf(day: AgendaDay, employeeId: number): string | undefined {
    const employee = day.employees.find((entry) => entry.id === employeeId);
    return employee === undefined ? undefined : spokenEmployeeName(employee.name);
  }

  private lockRefusal(
    outcome: BalancedLockOutcome,
    message: string,
  ): BalancedLockResult {
    return { outcome, locked: false, message, external_mutation: false };
  }

  // ── request reading ─────────────────────────────────────────────────────

  /**
   * 2026-10-10 — applies `fecha_dicha` (the customer's literal words) to the
   * body's `field`. `undefined` when absent or naming no day (then `day_name`
   * and `date` work exactly as before). A question (`date_conflict`) is
   * answered WITHOUT reading the agenda, and the conversation's page is
   * emptied so no option of an earlier day can be locked by index.
   */
  private fechaDichaCorrection(
    body: unknown,
    field: "date" | "date_from",
    fields: Record<string, unknown> | undefined,
    nowMs: number,
  ):
    | { body: Record<string, unknown>; correctedFrom?: string }
    | { conflict: BalancedDiscoverResult }
    | undefined {
    if (fields === undefined || typeof body !== "object" || body === null) return undefined;
    const raw = body as Record<string, unknown>;
    const todayIso = madridDate(nowMs);
    const sentRaw = typeof raw[field] === "string" ? (raw[field] as string).trim() : "";
    const sent = isRealDate(sentRaw) ? sentRaw : undefined;
    // 2026-10-10 (v3): the PIECES decide; `fecha_dicha` only cross-checks.
    const resolution = resolveFechaPiezas(
      fields,
      { todayIso, todayStillOpen: this.stillOpenToday(nowMs), closedWeekdays: this.closedWeekdays },
      sent,
    );
    const conversationId = readConversationId(raw["conversation_id"]);
    const logFields = {
      conversation_id: conversationId ?? "<invalid>",
      fecha_dicha: typeof fields["fecha_dicha"] === "string" ? (fields["fecha_dicha"] as string).slice(0, 80) : null,
      piezas: Object.fromEntries(FECHA_PIECE_FIELDS.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]])),
    };
    if (resolution === undefined) return undefined;
    const asQuestion = (
      question: Parameters<typeof balancedDateQuestionMessage>[0],
    ): { conflict: BalancedDiscoverResult } => {
      if (conversationId !== undefined) this.optionStore.publish(conversationId, [], nowMs);
      this.logger?.warn(
        { ...logFields, date_issue: question.reason },
        "balanced v2: the day said is not one bookable day; the customer is asked, nothing searched",
      );
      return {
        conflict: {
          ...this.discoverRefusal("date_conflict", balancedDateQuestionMessage(question, todayIso)),
          date_issue: question.reason,
          date_options: [...question.candidates],
        },
      };
    };
    if (resolution.kind === "question") return asQuestion(resolution);

    let used: string;
    let extra: Record<string, unknown> = {};
    if (resolution.kind === "week") {
      // A whole week is a window: a scan reads it; a discover must ask the day.
      if (field === "date") return asQuestion({ reason: "ambiguous_week", candidates: [] });
      used = resolution.from;
      extra = { days: resolution.days };
    } else {
      used = resolution.date;
    }
    if (sent !== used) {
      this.logger?.warn(
        { ...logFields, field, sent_date: sent ?? null, used_date: used },
        "balanced v2: the day pieces disagreed with the date sent; the customer's day was searched",
      );
    }
    return {
      body: { ...raw, [field]: used, ...extra },
      ...(sent !== undefined && sent !== used ? { correctedFrom: sent } : {}),
    };
  }

  /**
   * 2026-10-10 — is the salon still open today, Madrid time? Closed weekday:
   * no. Otherwise open until the early close of that weekday, or until
   * {@link SALON_CLOSE_MINUTES}. Decides whether a bare «el sábado» said on a
   * Saturday is today (still open) or next Saturday.
   */
  private stillOpenToday(nowMs: number): boolean {
    const today = madridDate(nowMs);
    if (this.isClosedDay(today)) return false;
    const [year, month, day] = today.split("-").map(Number);
    const closeAt =
      this.earlyClose.get(new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()) ?? SALON_CLOSE_MINUTES;
    return minutesOf(madridWallClock(nowMs).slice(11, 16)) < closeAt;
  }

  /**
   * 2026-10-08 — applies `day_name` to the body's `field` (`date` for discover,
   * `date_from` for scan). `undefined` when there is no readable `day_name`;
   * otherwise the body to read, and `correctedFrom` when the date changed.
   */
  private dayNameCorrection(
    body: unknown,
    field: "date" | "date_from",
    rawDayName: unknown,
    nowMs: number,
    nearestFromToday = false,
  ): { body: Record<string, unknown>; correctedFrom?: string } | undefined {
    const dayName = parseDayName(rawDayName);
    if (dayName === undefined || typeof body !== "object" || body === null) return undefined;
    const raw = body as Record<string, unknown>;
    const sentRaw = typeof raw[field] === "string" ? (raw[field] as string).trim() : "";
    const sent = isRealDate(sentRaw) ? sentRaw : undefined;
    // Review 2026-10-08 (c): discover REQUIRES a date. A missing or invalid
    // one stays `invalid_request`, exactly as before day_name existed — the
    // day word corrects a date, it never invents one. (Scan's `date_from` is
    // optional, "from today", so there it may resolve from today.)
    if (sent === undefined && field === "date") return undefined;
    const used = resolveDayName(dayName, sent, madridDate(nowMs), { nearestFromToday });
    if (used === sent) return { body: raw };
    this.logger?.warn(
      {
        conversation_id: readConversationId(raw["conversation_id"]) ?? "<invalid>",
        field,
        sent_date: sent ?? null,
        used_date: used,
      },
      "balanced v2: day_name disagreed with the date sent; the customer's day was searched",
    );
    return { body: { ...raw, [field]: used }, ...(sent !== undefined ? { correctedFrom: sent } : {}) };
  }

  private readDiscover(body: unknown, nowMs: number): DiscoverRequest | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const raw = body as Record<string, unknown>;

    const conversationId = readConversationId(raw["conversation_id"]);
    if (conversationId === undefined) return undefined;

    const serviceId = typeof raw["service_id"] === "number"
      ? raw["service_id"]
      : typeof raw["service_id"] === "string"
        ? Number(raw["service_id"].trim())
        : NaN;
    if (serviceId !== 0 && serviceId !== 1 && serviceId !== 2) return undefined;

    const date = typeof raw["date"] === "string" ? raw["date"].trim() : "";
    if (!isRealDate(date)) return undefined;

    // Optional fields: a malformed OPTIONAL field is dropped rather than
    // refused. It only narrows or ranks, so ignoring it answers the caller's
    // actual question instead of sending the agent back for a field that was
    // never required.
    const preferredTime = readTime(raw["preferred_time"]);
    const employeeId = readPositiveInt(raw["employee_id"]);

    // *** 2026-10-10 — THE NAMED HOUR DECIDES THE BAND. ***
    //
    // Two calls of that day: «el martes que viene» sent with `preferred_time`
    // 12:30 and NO `time_period` was refused (`invalid_request`, the caller had
    // to repeat); the same hour sent with `time_period: "afternoon"` offered
    // 14:30, 15:00, 15:30 while 12:30 was free (the hour was never looked at,
    // because it is a morning hour). A caller who names an hour asked for THAT
    // hour: its band is searched, whatever band the model put next to it.
    // Without an hour, the band sent; without either, a default instead of a
    // refusal (`defaultPeriod`) — the band only orders what is offered, the
    // other one is still offered when it is empty.
    const sentPeriod = raw["time_period"];
    const period: TimePeriod =
      preferredTime !== undefined
        ? periodOf(preferredTime)
        : sentPeriod === "morning" || sentPeriod === "afternoon"
          ? sentPeriod
          : this.defaultPeriod(date, nowMs);

    return {
      conversationId,
      serviceId,
      date,
      period,
      ...(preferredTime !== undefined ? { preferredTime } : {}),
      ...(employeeId !== undefined ? { employeeId } : {}),
    };
  }

  /**
   * 2026-10-10 — the band of a `discover` that named neither a band nor an
   * hour: the afternoon for today once the morning is over, else the morning.
   */
  private defaultPeriod(date: string, nowMs: number): TimePeriod {
    if (date !== madridDate(nowMs)) return "morning";
    return minutesOf(madridWallClock(nowMs).slice(11, 16)) >= AFTERNOON_FROM_MINUTES ? "afternoon" : "morning";
  }

  /**
   * `scan` reads TWO required fields; everything else has a default.
   *
   * *** A MALFORMED OPTIONAL FIELD IS DROPPED, NEVER REFUSED. ***
   *
   * The same rule `readDiscover` applies, and it matters more here because
   * almost every field IS optional. The fields a voice agent gets wrong are the
   * ones it inferred from speech — a `date_from` it heard as last week, a
   * `days` it sent as `"siete"`, an `after_time` of `"5pm"` — and every one of
   * those has a defensible default that answers the caller's actual question.
   * Refusing would send the agent back to ask a question the caller already
   * answered, which on a phone line is how a call ends.
   *
   * The two that are NOT optional are the two nothing can be invented for: the
   * conversation this page belongs to (the isolation key — a wrong one would
   * hand this call another call's hours) and the service (an hour free for a
   * haircut is not free for a haircut and beard).
   */
  private readScan(body: unknown, nowMs: number): ScanRequest | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const raw = body as Record<string, unknown>;

    const conversationId = readConversationId(raw["conversation_id"]);
    if (conversationId === undefined) return undefined;

    const serviceId = typeof raw["service_id"] === "number"
      ? raw["service_id"]
      : typeof raw["service_id"] === "string"
        ? Number(raw["service_id"].trim())
        : NaN;
    if (serviceId !== 0 && serviceId !== 1 && serviceId !== 2) return undefined;

    // *** A WINDOW NEVER STARTS IN THE PAST. ***
    //
    // Not because a past date is malformed — it is a perfectly good date — but
    // because reading it would spend the deadline on days nobody can book and
    // report `no_availability` for a week the salon may be wide open. It is
    // LIFTED to today rather than refused: «la semana que viene» said on a
    // Monday and turned into a date by an agent that still thinks it is last
    // Friday is an ordinary, recoverable mistake, and today is what the caller
    // meant by "from now on". `madridDate` because the salon's day, not the
    // server's UTC day, is the one that decides whether a date is past.
    const today = madridDate(nowMs);
    const dateRaw = typeof raw["date_from"] === "string" ? raw["date_from"].trim() : "";
    const dateFrom = isRealDate(dateRaw) && dateRaw > today ? dateRaw : today;

    // Clamped, not refused, for the reason above: 14 means "as far as you can
    // see", and answering seven days of it is the caller's question answered.
    const daysRaw =
      typeof raw["days"] === "number"
        ? raw["days"]
        : typeof raw["days"] === "string" && raw["days"].trim() !== ""
          ? Number(raw["days"].trim())
          : NaN;
    const days = Number.isInteger(daysRaw)
      ? Math.min(Math.max(daysRaw, 1), BALANCED_SCAN_MAX_DAYS)
      : BALANCED_SCAN_MAX_DAYS;

    const afterTime = readTime(raw["after_time"]);
    const beforeTime = readTime(raw["before_time"]);
    // *** AN IMPOSSIBLE WINDOW DROPS THE CEILING, NOT THE FLOOR. ***
    //
    // "a partir de las cinco, antes de las tres" is a pair no hour can satisfy,
    // and honouring both would answer `no_availability` for a salon that is
    // open all evening. The floor is kept because it is the constraint callers
    // actually state and the one an agent mistranscribes least — and because
    // keeping the ceiling instead would offer MORNINGS to someone who just said
    // "a partir de las cinco", which is the exact wrong answer this action
    // exists to stop.
    const usableBefore =
      beforeTime !== undefined &&
      afterTime !== undefined &&
      minutesOf(afterTime) > minutesOf(beforeTime)
        ? undefined
        : beforeTime;

    const preferredTime = readTime(raw["preferred_time"]);
    // 2026-10-10 — a named hour rules over the band (see `readDiscover`): a
    // band that does not contain the hour is dropped, so the hour itself and
    // the nearest ones of BOTH halves are ranked first.
    const periodRaw = raw["time_period"];
    const period =
      (periodRaw === "morning" || periodRaw === "afternoon") &&
      (preferredTime === undefined || periodOf(preferredTime) === periodRaw)
        ? periodRaw
        : undefined;
    const employeeId = readPositiveInt(raw["employee_id"]);

    // *** 2026-10-11 — `weekday`: ONLY that weekday, the next `weeks` of them. ***
    // Absent (undefined / null / empty) = the scan of always, byte for byte.
    // Present but not a weekday name = `invalid_request`: falling back to a
    // normal window would repeat the fault this field exists to fix (offering
    // other weekdays for «cualquier sábado»).
    const weekdayRaw = raw["weekday"];
    let weekdayWindow:
      | { weekdayName: string; weekdayDates: string[]; days: number; dateFrom: string }
      | undefined;
    if (weekdayRaw !== undefined && weekdayRaw !== null && weekdayRaw !== "") {
      if (typeof weekdayRaw !== "string") return undefined;
      const index = parseScanWeekday(weekdayRaw);
      if (index === undefined) return undefined;
      const weeksRaw =
        typeof raw["weeks"] === "number"
          ? raw["weeks"]
          : typeof raw["weeks"] === "string" && raw["weeks"].trim() !== ""
            ? Number(raw["weeks"].trim())
            : NaN;
      const weeks = Number.isInteger(weeksRaw)
        ? Math.min(Math.max(weeksRaw, 1), SCAN_WEEKDAY_MAX_WEEKS)
        : SCAN_WEEKDAY_DEFAULT_WEEKS;
      let first = firstWeekdayOnOrAfter(dateFrom, index);
      // Today counts only while the salon is still open; otherwise next week's.
      if (first === today && !this.stillOpenToday(nowMs)) first = addDays(first, 7);
      const weekdayDates = Array.from({ length: weeks }, (_unused, week) => addDays(first, week * 7));
      weekdayWindow = {
        weekdayName: SCAN_WEEKDAY_NAMES_ES[index] as string,
        weekdayDates,
        days: weeks,
        dateFrom: first,
      };
    }

    return {
      conversationId,
      serviceId,
      dateFrom: weekdayWindow?.dateFrom ?? dateFrom,
      days: weekdayWindow?.days ?? days,
      ...(afterTime !== undefined ? { afterTime } : {}),
      ...(usableBefore !== undefined ? { beforeTime: usableBefore } : {}),
      ...(period !== undefined ? { period } : {}),
      ...(preferredTime !== undefined ? { preferredTime } : {}),
      ...(employeeId !== undefined ? { employeeId } : {}),
      ...(weekdayWindow !== undefined
        ? { weekdayName: weekdayWindow.weekdayName, weekdayDates: weekdayWindow.weekdayDates }
        : {}),
    };
  }

  /**
   * `more` reads ONE required field and four optional ones.
   *
   * The optional four are never used to decide WHAT to answer, only whether the
   * agent is still talking about the same question — see `contradicts`. A
   * malformed optional field is dropped rather than refused, exactly as in
   * `readDiscover`: it narrows nothing, so refusing on it would send the agent
   * back for a field the contract never asked it to send.
   */
  private readMore(body: unknown): MoreRequest | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const raw = body as Record<string, unknown>;

    const conversationId = readConversationId(raw["conversation_id"]);
    if (conversationId === undefined) return undefined;

    const dateRaw = raw["date"];
    const date =
      typeof dateRaw === "string" && dateRaw.trim() !== "" ? dateRaw.trim() : undefined;

    const serviceRaw = raw["service_id"];
    const serviceNumber =
      typeof serviceRaw === "number"
        ? serviceRaw
        : typeof serviceRaw === "string" && serviceRaw.trim() !== ""
          ? Number(serviceRaw.trim())
          : NaN;
    const serviceId = Number.isInteger(serviceNumber) ? serviceNumber : undefined;

    const periodRaw = raw["time_period"];
    const period =
      periodRaw === "morning" || periodRaw === "afternoon" ? periodRaw : undefined;

    const employeeId = readPositiveInt(raw["employee_id"]);

    return {
      conversationId,
      ...(date !== undefined ? { date } : {}),
      ...(serviceId !== undefined ? { serviceId } : {}),
      ...(period !== undefined ? { period } : {}),
      ...(employeeId !== undefined ? { employeeId } : {}),
    };
  }

  private readLock(body: unknown): LockRequest | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const raw = body as Record<string, unknown>;

    const conversationId = readConversationId(raw["conversation_id"]);
    if (conversationId === undefined) return undefined;

    const optionIndex = readPositiveInt(raw["option_index"]);
    // The absolute ceiling of ANY page; `lock` then narrows it to the size
    // stored with this conversation's page (3 for every voice page).
    if (optionIndex === undefined || optionIndex > BALANCED_WA_MAX_OPTIONS_MAX) return undefined;

    const preferredEmployeeId = readPositiveInt(raw["preferred_employee_id"]);

    return {
      conversationId,
      optionIndex,
      ...(preferredEmployeeId !== undefined ? { preferredEmployeeId } : {}),
    };
  }
}
