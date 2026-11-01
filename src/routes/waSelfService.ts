import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { makeScopedWebhookAuth, makeWebhookAuth } from "../plugins/webhookAuth.js";
import type { WaSelfService } from "../services/waSelfService/waSelfService.js";
import type { WaCalendarLinkService } from "../services/waSelfService/waCalendarLinkService.js";
import { MSG_INVALID_REQUEST } from "../services/waSelfService/waMessages.js";
import { GENERIC_ERROR_MESSAGE } from "../utils/phrasing.js";

/**
 * ADR-032 — `/ai/wa/*`: self-service for the WhatsApp ElevenLabs agent.
 *
 * Every AUTHENTICATED answer is HTTP 200 (a non-2xx is a tool error and
 * ElevenLabs retries tools on errors). Auth is two secrets: the shared
 * `/ai/*` one and `X-AI-WA-Secret`, which the voice agent does not have.
 * The sender's phone is read from the `X-AI-WA-Caller-Id` header by the
 * service, never from the body.
 */

export const WA_SECRET_HEADER = "x-ai-wa-secret";
export const WA_PREFIX = "/ai/wa/";

export interface WaSelfServiceRoutesOptions {
  /** Absent when WA self-service is off: only `calendarLink` is then served. */
  service?: WaSelfService;
  /** 2026-10-11 — `POST /ai/wa/calendar-link`. */
  calendarLink?: WaCalendarLinkService;
  webhookSecret: string;
  waSecret: string;
}

/** Only failures that happen BEFORE the handler runs become a structured 200. */
function isPreDispatchFailure(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("FST_ERR_CTP_")) return true;
  const status = (error as { statusCode?: unknown }).statusCode;
  return status === 400 || status === 415 || status === 429;
}

export async function registerWaSelfServiceRoutes(
  app: FastifyInstance,
  opts: WaSelfServiceRoutesOptions,
): Promise<void> {
  const { service, calendarLink, webhookSecret, waSecret } = opts;

  await app.register(async (scoped) => {
    scoped.addHook("preHandler", makeWebhookAuth(webhookSecret));
    scoped.addHook("preHandler", makeScopedWebhookAuth(waSecret, WA_SECRET_HEADER));

    scoped.setErrorHandler(async (error, request: FastifyRequest, reply: FastifyReply) => {
      if (!isPreDispatchFailure(error)) {
        // After an unknown failure we cannot claim "nothing was cancelled".
        const message = error instanceof Error ? error.message : String(error);
        request.log.error({ err: message }, "wa self-service: unhandled error");
        return reply.code(500).send({ success: false, message: GENERIC_ERROR_MESSAGE });
      }
      request.log.warn(
        { route: request.routeOptions?.url ?? "unrouted", failure: (error as { code?: string }).code ?? "unknown" },
        "wa self-service: unreadable request answered with a structured 200",
      );
      return reply.code(200).send({
        outcome: "invalid_request",
        message: MSG_INVALID_REQUEST,
        external_mutation: false,
      });
    });

    if (service !== undefined) {
      scoped.post("/ai/wa/my-reservations", async (request) =>
        service.myReservations(request.headers, request.body, Date.now()),
      );
      scoped.post("/ai/wa/cancel", async (request) =>
        service.cancel(request.headers, request.body, Date.now()),
      );
      // 2026-10-11 — only the service of a standing booking (internal doc, not included in the template).
      scoped.post("/ai/wa/change-service", async (request) =>
        service.changeService(request.headers, request.body, Date.now()),
      );
      scoped.post("/ai/wa/notify-owner", async (request) =>
        service.notifyOwner(request.headers, request.body, Date.now()),
      );
    }
    // 2026-10-11 — read-only: the calendar link of a booking, from its slot token.
    if (calendarLink !== undefined) {
      scoped.post("/ai/wa/calendar-link", async (request) =>
        calendarLink.lookup(request.body, Date.now()),
      );
    }
  });
}
