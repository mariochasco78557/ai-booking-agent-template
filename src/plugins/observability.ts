import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createRequestMetrics,
  runWithRequestMetrics,
  type RequestMetrics,
} from "../observability/requestMetrics.js";
import { resolveAppVersion } from "../utils/appVersion.js";

/**
 * step PROD (Hito 7) — one structured line per request, carrying exactly
 * what the mission asks for and nothing more:
 *
 *   request_id    correlation id, also returned to the caller as a header
 *   duration_ms   total time this process spent on the request
 *   upstream_ms   of which, time spent waiting on the Symfony API
 *   overhead_ms   duration_ms - upstream_ms, i.e. what this middleware costs
 *   result        a small closed set of categories, never a free-text message
 *
 * PRODUCTION FORENSICS 2026-09-11 (F1) added two more, and only two:
 *
 *   conversation_id  a SHORT HASH of the ElevenLabs conversation id
 *   action           discover | lock | more | book
 *
 * Everything above was true of a REQUEST; neither said anything about the CALL
 * the request belonged to. Reconstructing one conversation out of the fourteen
 * requests in the 2026-09-11 production window therefore required
 * cross-referencing Caddy's response sizes against pino's timestamps, because
 * `/ai/voice/v2/availability` is the route of a discovery, a continuation AND a
 * lock, and nothing in the line distinguished them. Two dimensions turn that
 * archaeology into a grep.
 *
 * `overhead_ms` is the field the acceptance criterion ("middleware overhead
 * under 100 ms") is actually about. Logging only the total would make that
 * criterion unmeasurable in production, because a slow upstream and a slow
 * middleware would be indistinguishable in the data.
 *
 * What is deliberately absent from the line: request bodies, response bodies,
 * headers, phone numbers, names, and the webhook secret. The category is a
 * fixed enum precisely so that no upstream- or user-derived string can ever
 * reach a log through this path.
 */

/**
 * The closed set of outcomes. Keep it small: the point of a categorical result
 * is that it can be counted and alerted on, which stops being true the moment
 * it can take an unbounded number of values.
 */
export type ResultCategory =
  | "ok"
  | "no_slots"
  | "write_disabled"
  | "slot_taken"
  | "already_booked_in_call"
  | "not_confirmed"
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "upstream_timeout"
  | "upstream_error"
  /**
   * step CTL-3: a write whose fate is genuinely unknown — a timeout, a
   * dropped connection, a 5xx, an unreadable reply. Deliberately separate
   * from `upstream_error`: an error is a thing that did not happen, and this
   * is a thing that may have happened. It is the category to alert on, and
   * the one that means a human should look at the diary.
   */
  | "booking_uncertain"
  /**
   * PRODUCTION FORENSICS 2026-09-11 (F2) — a `/book` that CONFIRMED an
   * appointment without creating one, because the durable idempotency journal
   * already held the answer.
   *
   * On 2026-09-11 at 15:12:02 the agent re-invoked the booking tool 1.19 s
   * after a confirmed write. The journal absorbed it exactly as designed — 2.6
   * ms, zero upstream calls, one appointment upstream — and the access line
   * said `result:"ok"`, the same word the real write had produced one second
   * earlier. The two are not the same event: one means the salon's agenda
   * changed, the other means the agent asked twice. Counting them together
   * hides the ONE signal that says the prompt (or the platform) is retrying a
   * write, which is the mechanism of the 2026-08-30 duplicate appointment.
   *
   * Separate from `already_booked_in_call`, which is a DIFFERENT second
   * booking and is refused. This one is the SAME booking, replayed.
   */
  | "booked_replay"
  /**
   * step SLOT — a booking that was refused before it could start, because
   * the hueco it named was never one this middleware offered.
   *
   * Four categories rather than one, because they are four different
   * operator stories and collapsing them would waste the signal:
   *
   * - `invalid_slot_token` is the alarming one. It means the agent called
   *   the booking tool without a real availability answer behind it — the
   *   2026-08-30 failure, caught. A non-zero count here is a prompt or tool
   *   configuration defect in ElevenLabs, not a middleware fault.
   * - `slot_token_expired` is benign and expected at a low rate: long calls
   *   happen. A high rate means the TTL is too short for real conversations.
   * - `slot_not_authorized` means a token from ANOTHER conversation was
   *   presented. It should be zero, and it is the one to alert on.
   * - `invalid_customer_data` means the agent sent filler where a name
   *   should be — again a conversation-design defect, caught before a write.
   */
  | "invalid_slot_token"
  | "slot_token_expired"
  | "slot_not_authorized"
  | "invalid_customer_data"
  /**
   * BALANCED V2 ((internal doc, not included in the template) ADR-020) — three refusals the two-step
   * discover/lock flow can produce that no existing category describes.
   *
   * Added rather than folded into a near-neighbour because each one names a
   * different fault and a different fix:
   *
   * - `option_not_found` means the agent locked an option number this
   *   conversation was never offered, or was offered too long ago. A low rate
   *   is long calls; a high rate is a prompt that lets the model invent an
   *   index instead of repeating one it heard.
   * - `employee_unavailable` means a caller asked for a specific professional
   *   at an hour that professional does not have. It is a NORMAL outcome of a
   *   normal conversation, not a defect — it is separated so it never inflates
   *   the counts that are.
   * - `authorization_unavailable` means the hour was real and free and could
   *   not be authorized anyway, which in practice means
   *   `VOICE_SLOT_TOKEN_SECRET` is missing. It should be zero, and it is the
   *   one of the three to alert on.
   */
  | "option_not_found"
  | "employee_unavailable"
  | "authorization_unavailable"
  | "internal_error"
  /**
   * 2026-10-08 — voice booking outcomes of the same name: the duplicate net
   * held a second booking of the same person and day; a change was refused
   * before writing; a change created the new booking but the old one is not
   * (confirmed) cancelled — the one of the three to alert on.
   */
  | "possible_duplicate"
  | "change_not_available"
  | "changed_old_not_cancelled"
  /** 2026-10-10 — a change held until the server's summary is confirmed. */
  | "change_confirm_required"
  | "phone_booking_limit"
  /** 2026-10-09 — create refused: option_time/option_date differ from the locked slot. */
  | "slot_time_mismatch";

/**
 * The actions the access line may name. A CLOSED set, for the same reason
 * `ResultCategory` is one: `action` arrives in a request body, i.e. from
 * outside, and a log dimension an outsider can fill with arbitrary strings is
 * a log dimension nobody can aggregate — and, with a newline in it, a log
 * nobody can trust. Anything not in this list is logged as nothing at all.
 */
export const LOGGED_ACTIONS = ["discover", "lock", "more", "scan", "book"] as const;
export type LoggedAction = (typeof LOGGED_ACTIONS)[number];

/**
 * What a request says about the CALL it belongs to. Never PII: a conversation
 * id is an ElevenLabs correlation identifier, and it is not even stored here in
 * full (see {@link shortConversationId}).
 */
export interface RequestLogContext {
  /** Short hash of the conversation id — never the id itself. */
  conversation?: string;
  action?: LoggedAction;
  /** Whether a write was performed or replayed from the idempotency journal. */
  idempotency?: "fresh" | "replayed";
}

declare module "fastify" {
  interface FastifyRequest {
    /** Timing + upstream counters for this request. Never holds caller data. */
    demoSalonMetrics?: RequestMetrics;
    /**
     * Set by a route that knows more than the status code does — e.g. a 200
     * that actually means "no slots" or "writes are disabled". When unset, the
     * status code decides (see `categoryFromStatus`).
     */
    demoSalonResult?: ResultCategory;
    /**
     * Which call, which action, and — for a write — whether it actually wrote.
     * Populated by the hook below for every request that carries a body, and
     * refined by routes that know more than the body does.
     */
    demoSalonContext?: RequestLogContext;
  }
}

/**
 * The conversation id, in the only form allowed into a log line: the first 8
 * hex characters of its SHA-256.
 *
 * *** WHY A HASH AND NOT THE FIRST 8 CHARACTERS OF THE ID. ***
 *
 * ElevenLabs conversation ids are `conv_` followed by a ULID-like body, so a
 * prefix of eight characters is `conv_01`-shaped for EVERY call: it identifies
 * nothing, and it still publishes part of a real identifier. A hash is the
 * opposite on both counts — every call gets a different value, and no part of
 * the id itself is ever written down.
 *
 * It is deliberately UNSALTED, because the whole point is that an operator
 * holding a conversation id from the ElevenLabs dashboard can find its lines:
 *
 *     node -e 'console.log(require("crypto").createHash("sha256")
 *       .update(process.argv[1]).digest("hex").slice(0,8))' conv_xxx
 *
 * 8 hex characters is ~4.3e9 values: collisions between two calls in one log
 * window are not a practical concern, and a collision costs an operator one
 * extra glance at the timestamps, never a wrong booking.
 *
 * 32 bits of a hash is not a secret and is not treated as one. The id is not
 * PII (it names a call, not a person) and it is not a credential — a slot token
 * is sealed against the conversation id AND a server-side secret, so knowing an
 * id authorizes nothing.
 */
export function shortConversationId(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

/** Bounds on what is accepted as a conversation id before it is hashed. */
const CONVERSATION_ID_LOG_MAX = 200;

function readLoggableAction(value: unknown): LoggedAction | undefined {
  return typeof value === "string" && (LOGGED_ACTIONS as readonly string[]).includes(value)
    ? (value as LoggedAction)
    : undefined;
}

/**
 * Records what this request is about, for the access line only.
 *
 * The same shape as {@link setResultCategory}: a route (or the hook below)
 * states a fact the HTTP layer cannot see, and the single line at the end picks
 * it up. Merging rather than replacing, so a later, better-informed caller can
 * add `idempotency` without knowing who set `action`.
 *
 * Every field is VALIDATED here rather than at the call sites: this is the one
 * place a caller-supplied value can enter a log, so it is the one place that
 * has to be sure it cannot carry a newline, a megabyte, or a name.
 */
export function setRequestContext(
  request: FastifyRequest,
  patch: { conversationId?: unknown; action?: unknown; idempotency?: "fresh" | "replayed" },
): void {
  const context = (request.demoSalonContext ??= {});
  if (
    typeof patch.conversationId === "string" &&
    patch.conversationId.length > 0 &&
    patch.conversationId.length <= CONVERSATION_ID_LOG_MAX
  ) {
    context.conversation = shortConversationId(patch.conversationId);
  }
  const action = readLoggableAction(patch.action);
  if (action !== undefined) context.action = action;
  if (patch.idempotency !== undefined) context.idempotency = patch.idempotency;
}

const REQUEST_ID_HEADER = "x-request-id";

/**
 * An inbound request id is attacker-controlled: whoever can call this
 * middleware can put anything in that header. It is echoed into a response
 * header and into every log line for the request, so it is accepted only in a
 * deliberately narrow shape — no newlines (log injection, which would let a
 * caller forge log entries), no control characters, no unbounded length. A
 * header that does not match is not an error; it is simply ignored and a
 * fresh id is generated, because a malformed correlation id is never a reason
 * to fail a booking call.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

function resolveRequestId(request: FastifyRequest): string {
  const inbound = request.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof value === "string" && SAFE_REQUEST_ID.test(value)) return value;
  return randomUUID();
}

/**
 * Fallback when a route did not classify its own outcome. Errors never reach a
 * route's own classification (they are thrown past it), so this is the path
 * every failure takes.
 */
export function categoryFromStatus(status: number): ResultCategory {
  if (status < 400) return "ok";
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
    case 403:
      return "unauthorized";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    case 504:
      return "upstream_timeout";
    case 502:
    case 503:
      return "upstream_error";
    default:
      return status >= 500 ? "internal_error" : "invalid_request";
  }
}

/** Lets a handler record what a 200 actually meant. */
export function setResultCategory(request: FastifyRequest, category: ResultCategory): void {
  request.demoSalonResult = category;
}

export function registerObservability(app: FastifyInstance): void {
  const startedAt = new WeakMap<FastifyRequest, bigint>();
  // Resolved once per process, not per request: it cannot change between two
  // requests served by the same running container.
  const appVersion = resolveAppVersion();

  // `done` is called INSIDE the AsyncLocalStorage run, so the store stays
  // current for the rest of the request — every later hook, the handler, and
  // every upstream call the handler awaits. This is the documented way to
  // scope an ALS context to a Fastify request.
  app.addHook("onRequest", (request, reply, done) => {
    const metrics = createRequestMetrics(resolveRequestId(request));
    request.demoSalonMetrics = metrics;
    startedAt.set(request, process.hrtime.bigint());
    // Returned to the caller so a problem reported by the salon or by
    // ElevenLabs can be found in the logs without guessing at timestamps.
    void reply.header(REQUEST_ID_HEADER, metrics.requestId);
    runWithRequestMetrics(metrics, done);
  });

  /**
   * The CALL context, derived generically from the parsed body.
   *
   * Registered here rather than in each route on purpose: `conversation_id` is
   * one field with one meaning on every voice endpoint, V1 and V2 alike, and a
   * per-route copy would be four chances for one of them to be forgotten — the
   * defect this hook exists to fix, reintroduced as its own maintenance. Routes
   * that know MORE than the body does (`/ai/voice/v2/book` knows whether the
   * journal replayed it) refine the context afterwards through the same
   * function.
   *
   * `preHandler` is the earliest hook at which `request.body` is parsed, and it
   * runs BEFORE the encapsulated webhook-secret guard, so a refused request is
   * attributable too. Nothing here can fail the request: a body that is not an
   * object, a missing id and an unknown action all simply leave the fields
   * absent — an access line with no `conversation_id` is a fact, whereas an
   * invented one would be a lie.
   */
  app.addHook("preHandler", (request, _reply, done) => {
    const body: unknown = request.body;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      setRequestContext(request, {
        conversationId: record["conversation_id"],
        action: record["action"],
      });
    }
    // `/ai/voice/book` and `/ai/voice/v2/book` carry no `action` field — the
    // act IS the route. Derived from the route PATTERN (never the raw URL), so
    // nothing a caller sends can steer it.
    if (
      request.demoSalonContext?.action === undefined &&
      (request.routeOptions?.url ?? "").endsWith("/book")
    ) {
      setRequestContext(request, { action: "book" });
    }
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const began = startedAt.get(request);
    startedAt.delete(request);
    const metrics = request.demoSalonMetrics;
    const durationMs =
      began === undefined ? 0 : Number(process.hrtime.bigint() - began) / 1e6;
    const upstreamMs = metrics?.upstreamMs ?? 0;

    const result =
      request.demoSalonResult ??
      // A timeout deep in the client surfaces as a generic 500/502 at the HTTP
      // layer; the counter is the only place that distinguishes "upstream was
      // slow" from "upstream said no", so it wins over the status code.
      ((metrics?.upstreamTimeouts ?? 0) > 0 && reply.statusCode >= 500
        ? "upstream_timeout"
        : categoryFromStatus(reply.statusCode));

    const context = request.demoSalonContext;

    request.log.info(
      {
        request_id: metrics?.requestId,
        method: request.method,
        // `routeOptions.url` is the route PATTERN ("/ai/voice/book"), not the
        // caller's raw URL. It cannot carry a query string, so it cannot leak
        // whatever a caller appended to the path.
        route: request.routeOptions?.url ?? "unrouted",
        // Spread rather than assigned, so a request that has no conversation
        // has no `conversation_id` KEY — not a key whose value is null. A field
        // that is sometimes absent is honest; one that is always present and
        // sometimes empty invites a dashboard to count the empties.
        ...(context?.conversation !== undefined
          ? { conversation_id: context.conversation }
          : {}),
        ...(context?.action !== undefined ? { action: context.action } : {}),
        status: reply.statusCode,
        result,
        ...(context?.idempotency !== undefined ? { idempotency: context.idempotency } : {}),
        duration_ms: Math.round(durationMs * 10) / 10,
        upstream_ms: Math.round(upstreamMs * 10) / 10,
        overhead_ms: Math.round((durationMs - upstreamMs) * 10) / 10,
        upstream_calls: metrics?.upstreamCalls ?? 0,
        // Which code served this call (see src/utils/appVersion.ts).
        v: appVersion,
      },
      "request",
    );
    done();
  });
}
