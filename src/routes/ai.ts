import type { FastifyInstance } from "fastify";
import type { Services } from "../services/container.js";
import {
  BOOKING_SECRET_HEADER,
  makeScopedWebhookAuth,
  makeWebhookAuth,
} from "../plugins/webhookAuth.js";
import {
  availabilitySchema,
  bookSchema,
  cancelSchema,
  checkSlotSchema,
  myReservationsSchema,
  voiceAvailabilitySchema,
  voiceBookSchema,
} from "../schemas/aiSchemas.js";
import { assertHumanAssistanceAction } from "../types/voiceOutcomes.js";
import { UpstreamError } from "../core/calendar/errors.js";
import { setResultCategory } from "../plugins/observability.js";
import { currentRequestMetrics } from "../observability/requestMetrics.js";
import { AGENDA_UNAVAILABLE_MESSAGE } from "../utils/phrasing.js";

export interface AiRoutesOptions {
  services: Services;
  webhookSecret: string;
  /**
   * step LAT (objective 3): a second credential required by `/ai/voice/book`
   * and by nothing else, carried in its own `x-ai-booking-secret` header.
   *
   * When set, reading the agenda and creating an appointment stop being the
   * same privilege: a booking must present the shared `/ai/*` secret AND this
   * one. When unset, booking keeps accepting the shared secret alone — today's
   * behaviour, and safe precisely because creation is disabled.
   */
  bookingWebhookSecret?: string;
}

/**
 * Registers all /ai/* endpoints under a shared webhook-secret guard.
 * Handlers are thin: validate with Zod (errors bubble to the global handler),
 * delegate to a service, return its Spanish result.
 */
export async function registerAiRoutes(
  app: FastifyInstance,
  opts: AiRoutesOptions,
): Promise<void> {
  const { services, webhookSecret } = opts;

  await app.register(async (scoped) => {
    scoped.addHook("preHandler", makeWebhookAuth(webhookSecret));

    scoped.post("/ai/availability", async (request) => {
      const input = availabilitySchema.parse(request.body);
      return services.availability.getAvailability(input);
    });

    scoped.post("/ai/check-slot", async (request) => {
      const input = checkSlotSchema.parse(request.body);
      return services.availability.checkSlot(input);
    });

    scoped.post("/ai/voice/availability", async (request) => {
      const input = voiceAvailabilitySchema.parse(request.body);
      try {
        const result = await services.voiceBooking.findAvailability(input);
        setResultCategory(request, result.available ? "ok" : "no_slots");
        return result;
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        // step PROD (Hito 7): a controlled degradation, not an error page.
        // The agent is mid-call with a customer; a 502 becomes a tool error,
        // and a tool error is exactly when a model starts inventing times.
        // Answering 200 with an empty slot list and a scripted sentence keeps
        // the contract shape the tool expects and keeps the agent on script.
        // The failure is not hidden — it is in the access line's categorical
        // result, which is where an operator looks for it.
        const timedOut = (currentRequestMetrics()?.upstreamTimeouts ?? 0) > 0;
        setResultCategory(request, timedOut ? "upstream_timeout" : "upstream_error");
        request.log.warn(
          { upstream_status: error.status, timed_out: timedOut },
          "voice availability degraded: upstream agenda unreachable",
        );
        return {
          available: false,
          message: AGENDA_UNAVAILABLE_MESSAGE,
          slots: [],
          external_mutation: false,
        };
      }
    });

    // step LAT (objective 3): a SECOND, narrower gate on the one route that
    // can write. It is registered per-route, so the scope-level guard above
    // still runs first and a booking must satisfy both: the shared `/ai/*`
    // secret in `x-ai-webhook-secret`, and the booking-only secret in
    // `x-ai-booking-secret`.
    //
    // Two credentials in two headers rather than one header accepting two
    // values, because the property worth buying here is conjunction, not
    // choice: the availability secret travels on every single call the agent
    // makes and is therefore the one most exposed to log capture, rotation
    // mistakes and third-party configuration — and on its own it must never be
    // able to reach a write path.
    const bookingGuard =
      opts.bookingWebhookSecret !== undefined
        ? [makeScopedWebhookAuth(opts.bookingWebhookSecret, BOOKING_SECRET_HEADER)]
        : [];

    scoped.post("/ai/voice/book", { preHandler: bookingGuard }, async (request, reply) => {
      const input = voiceBookSchema.parse(request.body);
      const result = await services.voiceBooking.book(input, request.headers, Date.now());
      // The outcome the service computed is strictly more informative than the
      // status code (every branch below 502 is a 200), so it drives the log
      // category directly.
      setResultCategory(
        request,
        result.outcome === "confirmed"
          ? "ok"
          : result.outcome === "misconfigured_owner"
            ? "internal_error"
            : result.outcome === "uncertain"
              ? "booking_uncertain"
              : result.outcome,
      );
      // step CTL-3: ALWAYS 200, for every outcome.
      //
      // This used to answer 502 on `upstream_error`, and that status was not
      // cosmetic — it is what made the 2026-08-30 incident four writes instead
      // of one. ElevenLabs renders a non-2xx as a TOOL ERROR and re-invokes
      // the tool; the transcript shows `Error code: 502` followed immediately
      // by an identical call, four times. The same reasoning
      // `/ai/voice/availability` already applies to a degraded agenda applies
      // with more force to a write: a tool error is exactly when a model
      // starts improvising, and here improvising means booking again.
      //
      // The failure is not hidden. It is in the access line's categorical
      // `result` (set just above) and in the structured `outcome` field the
      // agent is instructed to read, which is a far more precise signal than
      // a status code that collapses every failure into one number.
      return result;
    });

    scoped.post("/ai/book", async (request, reply) => {
      const input = bookSchema.parse(request.body);
      // Headers ONLY reach the identity resolver — never the body (design
      // §2/§4, same rule as /ai/my-reservations and /ai/cancel above): a
      // header is an input, never a verdict. Design §10.2/§13 (senior
      // finding B8): this is what lets BookingService pin the phone it
      // writes upstream to a verified caller identity instead of the
      // spoken `customer.phone`, without ever trusting anything the
      // request body could influence.
      const result = await services.booking.book(input, request.headers, Date.now());
      // Map non-success to a soft status but always return a Spanish message.
      if (!result.success) reply.code(result.reason === "upstream_error" ? 502 : 200);
      return result;
    });

    scoped.post("/ai/my-reservations", async (request, reply) => {
      const input = myReservationsSchema.parse(request.body);
      // Headers ONLY reach the identity resolver — never the body (design
      // §2/§4: "whoever can call the middleware can set any header on that
      // call", so a header is an input, never a verdict, but a request BODY
      // must never even have a path to trust derivation in the first
      // place).
      const result = await services.lookup.myReservations(
        input,
        request.headers,
        Date.now(),
      );
      // Design §9 layer 2: defence in depth against a future `as any`
      // bypassing the type system (layer 1). Throws (-> 500) rather than
      // ever letting an invalid action leave the process.
      assertHumanAssistanceAction(result.action);
      // Design §5.2: `upstream_unavailable` is the one outcome that reflects
      // a genuine upstream/transport failure; every other outcome — even
      // the fail-closed security ones — is a normal, informative HTTP 200.
      if (result.outcome === "upstream_unavailable") reply.code(502);
      return result;
    });

    scoped.post("/ai/cancel", async (request, reply) => {
      const input = cancelSchema.parse(request.body);
      // Headers ONLY reach the identity resolver — never the body (same
      // rule as /ai/my-reservations above, design §2/§4). This is an
      // IRREVERSIBLE WRITE: the caller identity that authorizes it must
      // come from the same place lookup's does, never from anything the
      // request body could influence.
      const result = await services.cancellation.cancel(
        input,
        request.headers,
        Date.now(),
      );
      // Design §9 layer 2: defence in depth against a future `as any`
      // bypassing the type system (layer 1). Throws (-> 500) rather than
      // ever letting an invalid action leave the process.
      assertHumanAssistanceAction(result.action);
      // Design §6.2/§9: `upstream_unavailable` is the one outcome that
      // reflects a genuine upstream/transport failure; every other
      // outcome — even the fail-closed security ones — is a normal,
      // informative HTTP 200.
      if (result.outcome === "upstream_unavailable") reply.code(502);
      return result;
    });
  });
}
