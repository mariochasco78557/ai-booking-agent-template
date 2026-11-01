import { createHash } from "node:crypto";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Env } from "./config/env.js";
import { createServices, type Services } from "./services/container.js";
import { registerErrorHandlers } from "./plugins/errorHandler.js";
import { registerObservability } from "./plugins/observability.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAiRoutes } from "./routes/ai.js";
import { BALANCED_V2_PREFIX, registerBalancedV2Routes } from "./routes/balancedV2.js";
import { registerElevenLabsCompatRoutes } from "./routes/elevenlabsCompat.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { WA_PREFIX, registerWaSelfServiceRoutes } from "./routes/waSelfService.js";
import { registerRecadoRoutes } from "./routes/recados.js";
import { RECADOS_WEBHOOK_PATH } from "./services/recados/telegramUpdates.js";
import { CALENDAR_TOKEN_MAX_LENGTH } from "./services/whatsapp/calendarLink.js";
import { clientAddress, getClientConfig } from "./core/config/clientConfig.js";
import { ElevenLabsCompatService } from "./services/elevenlabsCompatService.js";
import { madridClock } from "./voice/elevenlabs/agenda/madridClock.js";

/**
 * A single fixed key for every request the resolver cannot attribute to a
 * caller identity (design §10.1). Deliberately a CONSTANT, not `req.ip`:
 * with `trustProxy: true` and no proxy allowlist, `req.ip` is the leftmost
 * `X-Forwarded-For` entry, which anyone calling this middleware can set to
 * whatever they like. Falling back to it would let the exact same actor
 * rotate an unbounded rate-limit budget by rotating a header — the
 * vulnerability this change exists to close, reintroduced as the "safe"
 * fallback. A shared constant key instead means every request with no
 * attributable identity shares ONE bucket, which is the honest worst case
 * for an unauthenticated/unverified caller (no worse than today).
 */
const RATE_LIMIT_NO_IDENTITY_KEY = "no-caller-identity";


/**
 * Design §10.1 (senior finding N4): keys the `/ai/*` rate limiter on a
 * SHA-256 hash of the caller's resolved `phoneE164` when the caller-identity
 * resolver can attribute one to this request, falling back to a constant
 * key otherwise. Hashed (not the raw phone) so the limiter's internal state
 * — which `@fastify/rate-limit` may log or expose for observability — never
 * holds a phone number in the clear; this is deliberately the SAME
 * resolver `LookupService` itself uses (`services.callerIdentityResolver`),
 * not a second independent one, so "does this request have a caller
 * identity" is answered identically in both places.
 */
function makeRateLimitKeyGenerator(
  services: Pick<Services, "callerIdentityResolver">,
): (req: FastifyRequest) => string {
  return (req: FastifyRequest): string => {
    const resolved = services.callerIdentityResolver.resolve(req.headers, Date.now());
    if (!resolved.ok) return RATE_LIMIT_NO_IDENTITY_KEY;
    return createHash("sha256").update(resolved.identity.phoneE164).digest("hex");
  };
}

/**
 * Whether a raw request URL addresses the Balanced V2 surface.
 *
 * The query string is cut off BEFORE the comparison: `req.url` is the raw
 * target, so `/ai/lookup?x=/ai/voice/v2/` must not match and
 * `/ai/voice/v2/book?debug=1` must. Fastify's parsed `routeOptions` is not
 * available this early (the rate limiter runs in `onRequest`, and its
 * `allowList` is consulted before the route's own hooks), so the path is taken
 * by hand rather than trusted from the caller's string as a whole.
 */
function isBalancedV2Path(url: string): boolean {
  const queryAt = url.indexOf("?");
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  return path.startsWith(BALANCED_V2_PREFIX);
}

/**
 * ADR-032: whether a raw request URL addresses `/ai/wa/*`. Same query-string
 * handling as `isBalancedV2Path`. Exempt from the global limiter for the same
 * reason as V2 (a 429 is a tool error and ElevenLabs retries); the real limit
 * is `WaRateLimiter`, answered as a structured 200 `rate_limited`.
 */
function isWaSelfServicePath(url: string): boolean {
  const queryAt = url.indexOf("?");
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  return path.startsWith(WA_PREFIX);
}

/**
 * Builds the Fastify app. Logger is configured to redact anything sensitive
 * (auth headers, passwords, tokens). Rate limiting applies globally; the
 * webhook-secret guard is scoped to /ai/* inside the routes.
 */
export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          'req.headers["x-ai-webhook-secret"]',
          // Design §10: these three headers now carry (or claim to carry)
          // caller-identity material. The `req` serializer below already
          // limits every logged request to `{method, url}`, so this is
          // "largely inert" defence in depth today, not the primary
          // control — but it must not create false confidence that IT is
          // the control (see the serializer comment below for the real
          // one).
          'req.headers["x-ai-verified-caller-id"]',
          'req.headers["x-ai-caller-identity"]',
          'req.headers["x-ai-caller-identity-signature"]',
          "*.password",
          "*.token",
          "*.access_token",
        ],
        censor: "[redacted]",
      },
      // Do not auto-log request bodies (they contain PII). This serializer
      // is the REAL control for header leakage too (design §10): it means
      // request headers never reach a log line at all, from any `req.log.*`
      // call in the framework's own access logging. The redact list above
      // only helps if something bypasses this serializer (e.g. a future
      // explicit `log.info({ headers: req.headers })` call) — services must
      // still never pass a raw headers object to a logger; only the
      // resolved `CallerIdentity`, and only through `maskPhoneStrict()`.
      serializers: {
        req(req) {
          return { method: req.method, url: req.url };
        },
      },
    },
    bodyLimit: 32 * 1024,
    trustProxy: true,
    // step PROD (Hito 7): Fastify's built-in "incoming request"/"request
    // completed" pair is replaced by the single richer line in
    // src/plugins/observability.ts. Two lines per request that say less than
    // one is not observability, it is log volume.
    //
    // Set through `logController` rather than the top-level
    // `disableRequestLogging`: the latter is deprecated in Fastify 5
    // (FSTDEP023) and removed in 6, and it emits a deprecation warning on
    // every app construction — noise in production logs, and noise in the
    // test output that would eventually train someone to ignore warnings.
    // A fresh instance per app: Fastify keeps a reference to it, and two apps
    // (as in the test suite) must not share mutable logging state.
    logController: new LogController({ disableRequestLogging: true }),
    // The «Añadir al calendario» token travels as a path parameter and is
    // longer than the router's default 100-character limit, past which
    // find-my-way answers 404 without reaching the handler. Raised ONLY when
    // the calendar routes will exist (they are the app's only parametric
    // routes), and only to just above the token's own ceiling — so it stays a
    // cheap, early bound on a hostile path. Unset: exactly the old options.
    ...(env.WHATSAPP_CALENDAR_LINK_SECRET
      ? { routerOptions: { maxParamLength: CALENDAR_TOKEN_MAX_LENGTH + 16 } }
      : {}),
  });

  registerErrorHandlers(app);
  // Registered before everything else so its onRequest hook runs first and the
  // request id exists for every later log line, including error-handler ones.
  registerObservability(app);

  // Built BEFORE the rate-limit plugin registers (rather than after, as in
  // the previous ordering) because the limiter's own `keyGenerator` needs
  // `services.callerIdentityResolver` (design §10.1) to exist first.
  const services = createServices(env, app.log);

  // step OFFER: an IN-PROCESS handle on the per-conversation offer memory.
  //
  // It is a decoration, not a route: nothing over HTTP can read or write it,
  // and no handler in `src/routes/` touches it. It exists so a test can put
  // the store into the state a real `/ai/voice/availability` call would have
  // left, which is the same arrangement `tests/helpers/slotToken.ts` already
  // uses to mint real slot tokens with the production service rather than
  // fake-looking ones. Arranging the precondition is not the same as
  // weakening the check: every booking below still passes the identical gate
  // a live call does.
  app.decorate("voiceOffers", services.voiceOffers);
  // BALANCED V2 ((internal doc, not included in the template) ADR-020): the same arrangement, for the V2
  // stores. In-process handles for tests and diagnostics; no route reads them,
  // and nothing over HTTP can reach them.
  app.decorate("balancedV2Offers", services.balancedV2Offers);
  app.decorate("balancedV2Options", services.balancedV2Options);

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Health checks should not be throttled. `/health/agenda` is included for
    // the same reason as `/health`: it is an operator endpoint, it is not
    // reachable from the Internet at all (Caddy's allowlist does not carry it
    // — see `Caddyfile`), and a diagnostic that rate-limits itself is useless
    // during exactly the incident it exists for.
    //
    // *** AND NEITHER IS THE BALANCED V2 SURFACE. ***
    //
    // PRODUCTION FORENSICS 2026-09-11 (F6). A 429 is a non-2xx, ElevenLabs
    // renders a non-2xx as a TOOL ERROR, and its reaction to a tool error is to
    // INVOKE THE TOOL AGAIN — so on `/ai/voice/v2/book` the limiter would
    // answer a burst by causing the exact duplicate write it exists to prevent
    // (the 2026-08-30 incident). The header of `src/routes/balancedV2.ts` makes
    // "every answer is HTTP 200" a property of that surface; a plugin-level 429
    // silently contradicted it, outside every V2 route handler and therefore
    // outside every V2 test.
    //
    // What is given up by exempting it is small and bounded: both V2 routes
    // already require the `/ai/*` webhook secret (and the write route a SECOND,
    // booking-only credential), Caddy only exposes this path to the Internet at
    // all, and ElevenLabs is the only caller. An unauthenticated flood is
    // refused at the guard, which costs no upstream call and no write. What is
    // given up is therefore a defence against a CREDENTIALED caller sending too
    // much — and the one credentialed caller is the platform whose retries this
    // limiter would be amplifying.
    //
    // Matched on the route PATH, never the raw URL, so a query string cannot
    // buy an exemption for a route outside the surface.
    allowList: (req) =>
      req.url === "/health" ||
      req.url === "/health/agenda" ||
      isBalancedV2Path(req.url) ||
      isWaSelfServicePath(req.url) ||
      // Recados: Telegram would retry a 429, and the shared «no-caller-identity»
      // bucket would make an unrelated burst starve its callbacks.
      req.url === RECADOS_WEBHOOK_PATH,
    keyGenerator: makeRateLimitKeyGenerator(services),
  });

  await registerHealthRoutes(app, { agendaCache: services.agendaCache });

  // The «Añadir al calendario» link of the WhatsApp confirmation (ADR-030).
  // PUBLIC: registered on the root instance, outside every `/ai/*` scope, so
  // it inherits no webhook-secret guard and takes none away from anything —
  // the token is its own authorisation (`src/routes/calendar.ts`). Absent
  // without the secret, which is every deployment with WhatsApp off.
  if (env.WHATSAPP_CALENDAR_LINK_SECRET !== undefined) {
    // D-007: la variable gana; si falta, `direccion` de cliente.yaml (Demo Salon no la tiene: igual que antes).
    const calendarLocation = env.WHATSAPP_CALENDAR_LOCATION ?? clientAddress(getClientConfig());
    await registerCalendarRoutes(app, {
      secret: env.WHATSAPP_CALENDAR_LINK_SECRET,
      ...(calendarLocation !== undefined ? { location: calendarLocation } : {}),
    });
  }
  await registerAiRoutes(app, {
    services,
    webhookSecret: env.AI_WEBHOOK_SECRET,
    ...(env.AI_BOOKING_WEBHOOK_SECRET
      ? { bookingWebhookSecret: env.AI_BOOKING_WEBHOOK_SECRET }
      : {}),
  });

  // BALANCED V2 ((internal doc, not included in the template) ADR-020) — the duplicated agent's surface.
  //
  // Registered UNCONDITIONALLY, and that is a deliberate choice rather than an
  // oversight. Two of the three routes' powers are already gated where they
  // belong: reading the agenda needs the same `/ai/*` webhook secret every
  // other read needs, and creating an appointment needs the booking-only second
  // credential AND `ENABLE_BALANCED_V2_CREATE`, which defaults to false. A
  // fourth flag governing mere REGISTRATION would add a way to misconfigure the
  // system without removing a way to misuse it — and it would mean the
  // duplicated ElevenLabs agent could not be pointed at the deployment at all
  // without an environment change, which is the one thing this whole feature is
  // supposed to make unnecessary.
  await registerBalancedV2Routes(app, {
    balanced: services.balancedV2,
    voiceBookingV2: services.voiceBookingBalancedV2,
    ...(services.phoneBookingLimit ? { phoneBookingLimit: services.phoneBookingLimit } : {}),
    ...(services.agendaBookings ? { agendaBookings: services.agendaBookings } : {}),
    agentProfiles: services.balancedAgentProfiles,
    voiceManage: services.voiceManage,
    callerIdPhoneEnabled: env.VOICE_CALLER_ID_PHONE_ENABLED,
    webhookSecret: env.AI_WEBHOOK_SECRET,
    ...(env.AI_BOOKING_WEBHOOK_SECRET
      ? { bookingWebhookSecret: env.AI_BOOKING_WEBHOOK_SECRET }
      : {}),
  });

  // ADR-032 — WhatsApp self-service. Registered ONLY when its own secret is
  // configured; otherwise the three paths are plain 404s.
  if (
    (services.waSelfService !== undefined || services.waCalendarLink !== undefined) &&
    env.WA_SELF_SERVICE_SECRET !== undefined
  ) {
    await registerWaSelfServiceRoutes(app, {
      ...(services.waSelfService ? { service: services.waSelfService } : {}),
      ...(services.waCalendarLink ? { calendarLink: services.waCalendarLink } : {}),
      webhookSecret: env.AI_WEBHOOK_SECRET,
      waSecret: env.WA_SELF_SERVICE_SECRET,
    });
  }

  // Recados para Bruno (internal doc, not included in the template). Registered ONLY with
  // RECADOS_MODE != off; otherwise the three paths are plain 404s.
  if (services.recados !== undefined) {
    await registerRecadoRoutes(app, {
      service: services.recados.service,
      ...(services.recados.updates ? { updates: services.recados.updates } : {}),
      webhookSecret: env.AI_WEBHOOK_SECRET,
      ...(env.WA_SELF_SERVICE_SECRET !== undefined ? { waSecret: env.WA_SELF_SERVICE_SECRET } : {}),
      ...(env.RECADOS_WEBHOOK_SECRET !== undefined ? { telegramSecret: env.RECADOS_WEBHOOK_SECRET } : {}),
    });
  }

  // step PROD (Hito 10): la ruta de compatibilidad con el contrato que
  // ElevenLabs ya habla. Registrada SÓLO si está explícitamente encendida —
  // mientras el agente apunte al túnel esta ruta no tiene ningún cliente
  // legítimo, y no registrarla es más fuerte que registrarla y rechazar.
  // El secreto está garantizado por el `superRefine` de `config/env.ts`, que
  // se niega a arrancar con la bandera encendida y la variable ausente.
  if (env.ENABLE_ELEVENLABS_COMPAT && env.ELEVENLABS_COMPAT_SECRET !== undefined) {
    await registerElevenLabsCompatRoutes(app, {
      compat: new ElevenLabsCompatService({
        availability: services.availability,
        clock: madridClock(),
        typeReservation: env.BOOKING_DEFAULT_TYPE_RESERVATION,
        defaultEmployeeId: env.BOOKING_DEFAULT_EMPLOYEE_ID,
        horizonDays: env.ELEVENLABS_COMPAT_HORIZON_DAYS,
      }),
      secret: env.ELEVENLABS_COMPAT_SECRET,
    });
  }

  // step LAT. Two deliberate choices about lifecycle:
  //
  // - The refresher is started only after every route is registered, so the
  //   process is already able to answer `/health` before it makes its first
  //   upstream call. `start()` returns synchronously and warms in the
  //   background: boot NEVER waits on the salon's API being reachable.
  // - It is stopped through Fastify's own `onClose`, not a bare signal
  //   handler, so `app.close()` in a test tears the interval and its snapshot
  //   down exactly as SIGTERM does in production. A test that leaves an
  //   interval running is a test suite that will not exit.
  // The WhatsApp worker, on the same two rules as the refresher below: started
  // only once every route is registered (a queued confirmation is never more
  // urgent than being able to answer `/health`), and stopped through Fastify's
  // own `onClose`, so `app.close()` in a test tears its interval down exactly
  // as SIGTERM does in production.
  //
  // Absent entirely when `WHATSAPP_NOTIFICATIONS_MODE` is off, which is the
  // default: no object, no timer, no file.
  if (services.whatsapp !== undefined) {
    // In-process handle, exactly like `voiceOffers` above: no route reads it
    // and nothing over HTTP can reach it. It lets a test drain the queue
    // deterministically instead of sleeping on a 5 s interval.
    app.decorate("whatsapp", services.whatsapp);
    services.whatsapp.start();
    app.addHook("onClose", async () => {
      await services.whatsapp?.stop();
    });
  }

  // Recados para Bruno: in-process handle for tests (no route reads it). The
  // gate is loaded BEFORE the workers that depend on it start; the lookup of
  // the appointments that never got one is redone at boot.
  if (services.recados !== undefined) {
    const { gate, service, worker } = services.recados;
    app.decorate("recados", services.recados);
    gate.load(Date.now());
    gate.start();
    service.resumeEnrichment(Date.now());
    worker?.start();
    app.addHook("onClose", async () => {
      await gate.stop();
      await worker?.stop();
    });
  }

  // ADR-032: the Telegram owner-notice worker, same lifecycle rules as above.
  if (services.ownerNotifier !== undefined) {
    app.decorate("ownerNotifier", services.ownerNotifier);
    services.ownerNotifier.start();
    app.addHook("onClose", async () => {
      await services.ownerNotifier?.stop();
    });
  }

  if (services.agendaRefresher !== undefined) {
    services.agendaCache?.loadSnapshot();
    services.agendaRefresher.start();
    app.addHook("onClose", async () => {
      await services.agendaRefresher?.stop();
    });
  }

  return app;
}
