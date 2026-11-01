import { z } from "zod";

/**
 * *** THE BALANCED V2 REQUEST CONTRACTS — liberal here, strict in the service. ***
 *
 * Every field below is `z.unknown()`, and that is the same deliberate choice
 * `voiceBookSchema` documents at length in `src/schemas/aiSchemas.ts`. The
 * short version, because it is the single most important property of this file:
 *
 * A Zod failure is an HTTP 400. ElevenLabs renders a non-2xx as a TOOL ERROR
 * and re-invokes the tool. On 2026-08-30 that mechanism turned one booking into
 * four. The failures a voice agent actually produces — a `date` it heard
 * wrong, an `option_index` it sent as the string `"2"`, a `time_period` it
 * translated to `"manana"` — are ORDINARY, and every one of them must come back
 * as a deterministic HTTP 200 with an `outcome` the prompt knows how to route,
 * never as a transport error the platform retries underneath us.
 *
 * So the split is:
 *
 * - **Here**: is this a JSON object at all? Nothing else.
 * - **`BalancedAvailabilityService`**: presence, type, range, format, the
 *   option lookup and the fresh re-check — each answering 200 with a named
 *   outcome, and none of them ever reaching a write path.
 *
 * `.strict()` is deliberately absent too, so an unknown key a future tool
 * version sends is stripped at this boundary rather than turned into a 400.
 * Nothing downstream reads the parsed object positionally, so a stripped field
 * reaches no code.
 *
 * The `shape` below remains the CANONICAL declaration of the tool contract:
 * `tests/balancedV2Contract.test.ts` compares these keys against
 * `docs/elevenlabs/TOOL_SCHEMAS_BALANCED_V2.json`, where the tool is strict and
 * declares which fields are required for which action. Liberal in what it
 * accepts, strict in what it declares.
 */

/**
 * ONE endpoint, FOUR actions.
 *
 * They are one tool rather than three because of what the ElevenLabs agent has
 * to hold in its head: a second tool is a second decision, a second set of edge
 * conditions, and a second opportunity to call the wrong one. `action` makes
 * the choice explicit and, more usefully, makes it impossible to LOCK without
 * naming the act — an agent cannot drift into authorizing a write while it
 * believes it is still browsing.
 *
 * The actions share no fields except `conversation_id`, and the service
 * validates each action's own set. A `discover` carrying an `option_index` is
 * simply a `discover`; the extra field reaches nothing.
 *
 * *** `"more"` ADDS NO INPUT FIELD, AND THAT IS THE POINT. ***
 *
 * The continuation of a page lives on the SERVER, keyed by `conversation_id`
 * (`BalancedContinuation` in `src/services/balanced/balancedOptionStore.ts`).
 * There is deliberately no `cursor`, no `offset`, no `page`, and no
 * `exclude_times` here, because every one of those would be a field the model
 * has to reconstruct between turns — and a model reconstructing a field is the
 * exact mechanism of the 2026-08-30 incident. `action: "more"` carries the
 * conversation id and nothing else; the middleware knows where it was.
 */
export const balancedAvailabilitySchema = z.object({
  /** The idempotency and isolation scope. Bound by ElevenLabs from
   * `system__conversation_id`; a missing one is a configuration failure to
   * answer deterministically, not to 400 into a retry loop. */
  conversation_id: z.unknown(),
  /** `"discover"`, `"scan"`, `"more"` or `"lock"`. Anything else is
   * `invalid_request`. */
  action: z.unknown(),

  // ── discover ────────────────────────────────────────────────────────────
  /** `0`, `1` or `2` — which service, and therefore how long the appointment
   * is. An hour free for one service is not necessarily free for another. */
  service_id: z.unknown(),
  /** `YYYY-MM-DD`. One day per question: the V2 script asks for a day. */
  date: z.unknown(),
  /** `"morning"` or `"afternoon"`. There is no `"any"`: the V2 script always
   * asks the caller which half of the day they want, and an answer that
   * silently spanned both would make "solo me quedan dos" unverifiable. */
  time_period: z.unknown(),
  /** Optional `HH:mm` the caller mentioned (discover, or scan with days 1).
   * Ranks the options; when the hour is inside the question's hard filters,
   * the first page is that hour alone if free, otherwise the nearest free
   * hour on each side, and the message says which (incident 2026-09-15). */
  preferred_time: z.unknown(),
  /** Optional. Set ONLY when the caller named a professional unprompted; it
   * narrows discovery to that person's hours. */
  employee_id: z.unknown(),

  // ── scan ────────────────────────────────────────────────────────────────
  /**
   * `YYYY-MM-DD`, the FIRST day of the window. Optional: absent means "from
   * today", and a date already in the past is lifted to today rather than
   * refused — the caller who says «la semana que viene» three days after the
   * agent wrote the date down is asking about a window, not about a day.
   */
  date_from: z.unknown(),
  /** How many days the window spans, `1`..{@link BALANCED_SCAN_MAX_DAYS}. */
  days: z.unknown(),
  /**
   * Optional `HH:mm` FLOOR. Unlike `preferred_time` this is a HARD filter: a
   * caller who says «a partir de las cinco» is stating a constraint, not a
   * preference, and an answer of 14:00 is a wrong answer however well ranked.
   */
  after_time: z.unknown(),
  /** Optional `HH:mm` CEILING, on the same terms as `after_time`. */
  before_time: z.unknown(),
  /**
   * 2026-10-11, scan only. Optional weekday («sábado»): the window becomes the
   * next `weeks` dates of THAT weekday and never another one. Read raw by the
   * service; an unrecognised value is `invalid_request`.
   */
  weekday: z.unknown(),
  /** 2026-10-11, scan with `weekday` only. 1..6, default 4. */
  weeks: z.unknown(),

  // ── lock ────────────────────────────────────────────────────────────────
  /** `1`, `2` or `3` — one of the options this conversation was just offered.
   * There is deliberately no way to state a date or an hour here. On a
   * WhatsApp-sized page (2026-10-08) it may go up to that page's stored size
   * (at most `BALANCED_WA_MAX_OPTIONS_MAX`); the service checks the stored
   * size, never the request's header. */
  option_index: z.unknown(),
  /** Optional. Set ONLY when the caller asks for a different professional at
   * the final summary. */
  preferred_employee_id: z.unknown(),
});
export type BalancedAvailabilityBody = z.infer<typeof balancedAvailabilitySchema>;

/**
 * The actions the endpoint accepts, as a value tests and docs can read.
 *
 * ORDER IS PART OF THE CONTRACT: `tests/balancedV2Contract.test.ts` compares
 * this array against the `action.enum` in
 * `docs/elevenlabs/TOOL_SCHEMAS_BALANCED_V2.json` positionally. `"more"` was
 * appended rather than inserted so the two original actions kept their places,
 * and `"scan"` is appended for the identical reason: an enum whose members move
 * is an enum whose published tool definition silently stops matching.
 */
export const BALANCED_ACTIONS = ["discover", "lock", "more", "scan"] as const;
export type BalancedAction = (typeof BALANCED_ACTIONS)[number];

/** The two bands. `any` is deliberately not one of them — see `time_period`. */
export const BALANCED_PERIODS = ["morning", "afternoon"] as const;

/**
 * Every `outcome` the READ actions — `discover`, `scan` and `more` — can
 * return.
 *
 * *** `scan` ADDS NO MEMBER, DELIBERATELY. ***
 *
 * A window with nothing in it is `no_availability`, exactly as a day with
 * nothing in it is: the salon had no hour to give. The fact that makes the two
 * different — WHICH days were actually read before we said so — is carried by
 * `days_checked` and `partial` in the answer body, where it is data the prompt
 * can speak («no he podido mirar el sábado») rather than a fourth outcome every
 * document and every branch would have to learn.
 * Exported so the tool definition and the prompt can be checked against the
 * code, not against a hand-maintained copy.
 *
 * `more` shares this union rather than owning a second one, because it answers
 * the SAME question in the same shape: a page of numbered hours for this call.
 * A separate union would have given the prompt two lists to keep straight and
 * would have let the two drift. The last three members are the only ones
 * `more` can produce that `discover` cannot:
 *
 * - `no_more_options` — the offered band is walked out. Deterministic, and it
 *   never rewinds to page one.
 * - `continuation_lost` — there is no page to continue (a restart, an expiry,
 *   or a `more` that never had a `discover`). The agent must ask again; the
 *   middleware will not rebuild an hour from the conversation.
 * - `continuation_mismatch` — the request names a day, service, band or
 *   professional that contradicts the page being continued. Refused for the
 *   same reason: the safe move is a fresh `discover`, never a guess.
 */
export const BALANCED_DISCOVER_OUTCOMES = [
  "options_available",
  "no_availability",
  "invalid_request",
  "agenda_unavailable",
  "no_more_options",
  "continuation_lost",
  "continuation_mismatch",
  // 2026-10-10: `fecha_dicha` names no single bookable day (weekday and number
  // disagree, a past date, «la semana que viene» in a discover…). Nothing was
  // searched; the `message` is the question to read to the customer.
  "date_conflict",
  // 2026-10-11: the hour asked for is the caller's OWN standing appointment
  // (WhatsApp / caller id only). Nothing offered or locked; the `message` asks
  // whether to change its service or pick another hour.
  "own_booking_at_time",
] as const;
export type BalancedDiscoverOutcome = (typeof BALANCED_DISCOVER_OUTCOMES)[number];

/** Every `outcome` `action: "lock"` can return. */
export const BALANCED_LOCK_OUTCOMES = [
  "locked",
  "option_not_found",
  "slot_taken",
  "employee_unavailable",
  "authorization_unavailable",
  "invalid_request",
  "agenda_unavailable",
  // 2026-10-11: the chosen hour is the caller's OWN standing appointment.
  "own_booking_at_time",
] as const;
export type BalancedLockOutcome = (typeof BALANCED_LOCK_OUTCOMES)[number];

/**
 * The largest `option_index` this contract will ever offer IN ONE PAGE. Three
 * is a spoken limit, not a technical one: a caller cannot hold more than three
 * times in their head while being read them over the phone.
 *
 * It is not a limit on how many hours the salon may have. The hours beyond the
 * three are kept server-side and reached with `action: "more"`, which renumbers
 * its page 1, 2, 3 again — so the spoken ceiling holds while the inventory does
 * not have to be thrown away.
 */
export const BALANCED_MAX_OPTIONS = 3;

/**
 * *** THE WRITTEN PAGE — WhatsApp only (owner request, 2026-10-08). ***
 *
 * `BALANCED_MAX_OPTIONS` is a SPOKEN limit. A WhatsApp customer READS the
 * hours, and the brain shows them as a WhatsApp list (up to ten rows), so a
 * request that carries `x-ai-channel: whatsapp` gets pages of up to
 * `BALANCED_WA_MAX_OPTIONS` options for `discover`, `scan` and `more`.
 *
 * Bounds: never below the spoken page (3), never above what one WhatsApp list
 * can show (10). The env value is CLAMPED into that range rather than refused,
 * because the meaning of «show more hours» is unambiguous and the clamp keeps
 * every value safe. A request WITHOUT the header — every voice call — keeps
 * pages of exactly {@link BALANCED_MAX_OPTIONS}, byte for byte.
 *
 * `lock` never reads the header: it validates `option_index` against the page
 * size STORED with the page that was actually published
 * (`BalancedOptionStore.pageSize`), so an index above 3 can only ever select an
 * hour on a page that really offered more than three.
 */
export const BALANCED_WA_MAX_OPTIONS_MIN = BALANCED_MAX_OPTIONS;
export const BALANCED_WA_MAX_OPTIONS_MAX = 10;
export const BALANCED_WA_MAX_OPTIONS_DEFAULT = 10;

/** Clamps any number into `BALANCED_WA_MAX_OPTIONS_MIN..MAX` (non-integers are floored, NaN is the default). */
export function clampBalancedWaMaxOptions(value: number): number {
  if (!Number.isFinite(value)) return BALANCED_WA_MAX_OPTIONS_DEFAULT;
  return Math.min(
    BALANCED_WA_MAX_OPTIONS_MAX,
    Math.max(BALANCED_WA_MAX_OPTIONS_MIN, Math.floor(value)),
  );
}

/**
 * *** THE WINDOW `action: "scan"` MAY WALK, AND WHY IT IS SEVEN DAYS. ***
 *
 * `discover` answers about ONE day, which is the right shape for «¿tienes hueco
 * el jueves?» and the wrong shape for «¿cuándo tienes algo a partir de las
 * cinco?». `scan` answers the second question by reading a WINDOW and ranking
 * across it — and the ceiling on that window is the property that keeps the
 * question affordable: seven days is what the salon's caller actually means by
 * "esta semana", it is inside `AGENDA_CACHE_HORIZON_DAYS` (14) so every day of
 * it can be warm, and it bounds the fan-out at a number the shared upstream
 * host can absorb even entirely cold.
 *
 * A `days` above this is CLAMPED, never refused: the request's meaning is
 * unambiguous and answering six days of a seven-day question is a better answer
 * than `invalid_request`.
 */
export const BALANCED_SCAN_MAX_DAYS = 7;

/**
 * How long a scan will wait for the salon's agenda before answering with what
 * it already has.
 *
 * This is a PHONE CALL. A caller who hears nothing for four seconds assumes the
 * line dropped, and an ElevenLabs tool call that runs long is a tool call the
 * platform may re-invoke — the mechanism behind the 2026-08-30 duplicate. So
 * the deadline is a property of the ANSWER, not of the reads: a day that has
 * not arrived is reported as not checked (`partial: true`, and it is absent
 * from `days_checked`), and the agent says so out loud rather than claiming the
 * salon has nothing.
 *
 * *** THE SLOW READ IS NOT CANCELLED. *** It keeps running and fills the cache,
 * so the day that missed this answer is warm for the next question — which is
 * usually the caller's very next sentence.
 */
export const BALANCED_SCAN_DEADLINE_MS = 2_500;

/**
 * How many hours of ONE day a scan may put into its ranking.
 *
 * The whole point of a window question is BREADTH: a caller who asks "¿cuándo
 * tienes algo por la tarde?" is asking which DAYS work, and a first page of
 * three hours all on Monday answers a question they did not ask. Two per day
 * keeps a busy day from crowding out every other one while still letting the
 * caller choose between two hours on the day they prefer.
 *
 * Applied BEFORE `BALANCED_CONTINUATION_MAX_SLOTS`, so the global memory cap
 * truncates a list that is already spread across the window.
 */
export const BALANCED_SCAN_MAX_PER_DAY = 2;

/**
 * *** THE UPSTREAM CAPACITY A SCAN ASSUMES WHEN NOBODY TELLS IT. ***
 *
 * The mirror of `UPSTREAM_MAX_CONCURRENCY` (`src/config/env.ts`), whose default
 * is the mission's stated starting point of 3. It is a DEFAULT and not a second
 * source of truth: `BalancedAvailabilityDeps.upstreamMaxConcurrency` is the
 * value the process is actually running with, and this number only applies to a
 * service built without it (every test that does not care, and — until the
 * container is wired — production, where the env default is this same 3).
 *
 * Raising the env var without passing it through therefore costs breadth, never
 * correctness: the scan simply fans out narrower than it could.
 */
export const BALANCED_SCAN_UPSTREAM_CAPACITY_DEFAULT = 3;

/**
 * *** HOW MANY DAYS OF A WINDOW MAY BE READ AT ONCE — AND WHY IT IS NOT `days`. ***
 *
 * `AgendaSource.fetchDay` takes the global limiter TWICE for one day — once for
 * `/user/employees-day`, once for `/user/free` — and RELEASES IT IN BETWEEN. So
 * a day that has its roster but not yet its free hours has to queue again,
 * behind whatever is holding the limiter now. Fanning out to `days` made the
 * scan its own worst queue-mate: with a capacity of 3 and three slow days
 * holding all three permits, the fast days could not get their second call
 * either, and the answer came back `days_checked: []` for a window in which
 * four days were available instantly. A caller heard «no tengo nada» about a
 * week with hours in it.
 *
 * Leaving ONE permit free is the whole fix, and it is deliberately a property of
 * the CALLER rather than of the limiter — the agenda layer is shared with the
 * refresher and the stable voice path, and a fairness policy invented there
 * would change how every one of them queues. The spare permit is what lets a
 * day already in progress finish its second call, and what keeps another
 * conversation's `discover` from waiting behind a whole window.
 *
 * Clamped to at least 1 so a deployment pinned to `UPSTREAM_MAX_CONCURRENCY=1`
 * still reads its window, one day at a time, instead of not at all.
 */
export function balancedScanFanOut(days: number, upstreamCapacity: number): number {
  return Math.max(1, Math.min(days, upstreamCapacity - 1));
}
