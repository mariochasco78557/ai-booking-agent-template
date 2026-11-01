import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { makeScopedWebhookAuth, makeWebhookAuth, safeEqual } from "../plugins/webhookAuth.js";
import { WA_SECRET_HEADER } from "./waSelfService.js";
import { MSG_INVALID_RECADO } from "../services/recados/recadoMessages.js";
import type { RecadoService } from "../services/recados/recadoService.js";
import {
  RECADO_VOICE_PATH,
  RECADO_WA_PATH,
  RECADOS_WEBHOOK_PATH,
  TELEGRAM_SECRET_HEADER,
  type TelegramUpdates,
} from "../services/recados/telegramUpdates.js";

/**
 * Recados para Bruno — the three routes ((internal doc, not included in the template) §A.10).
 * Registered only with `RECADOS_MODE != off` (off = plain 404s).
 *
 * - `POST /ai/voice/v2/recado`: the `/ai/*` secret. Every authenticated answer
 *   is HTTP 200 (a non-2xx is a tool error and ElevenLabs retries tools).
 * - `POST /ai/wa/recado`: that secret AND `X-AI-WA-Secret`. Internal only (the
 *   brain calls it over the private network); Caddy does not expose it.
 * - `POST /telegram/recados`: Telegram's `secret_token` header, only in `live`.
 */

export interface RecadoRoutesOptions {
  service: RecadoService;
  updates?: TelegramUpdates;
  /** AI_WEBHOOK_SECRET */
  webhookSecret: string;
  /** WA_SELF_SERVICE_SECRET */
  waSecret?: string;
  /** RECADOS_WEBHOOK_SECRET */
  telegramSecret?: string;
}

/** Only failures that happen BEFORE the handler runs become a structured 200. */
function isPreDispatchFailure(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("FST_ERR_CTP_")) return true;
  const status = (error as { statusCode?: unknown }).statusCode;
  return status === 400 || status === 415 || status === 429;
}

function recadoErrorHandler(scope: FastifyInstance): void {
  scope.setErrorHandler(async (error, request: FastifyRequest, reply: FastifyReply) => {
    if (!isPreDispatchFailure(error)) {
      const message = error instanceof Error ? error.name : "unknown_error";
      request.log.error({ err: message }, "recados: unhandled error");
      return reply.code(500).send({ success: false, message: MSG_INVALID_RECADO });
    }
    request.log.warn(
      { route: request.routeOptions?.url ?? "unrouted", failure: (error as { code?: string }).code ?? "unknown" },
      "recados: unreadable request answered with a structured 200",
    );
    return reply.code(200).send({
      outcome: "invalid_request",
      message: MSG_INVALID_RECADO,
      external_mutation: false,
    });
  });
}

export async function registerRecadoRoutes(app: FastifyInstance, opts: RecadoRoutesOptions): Promise<void> {
  const { service, updates, webhookSecret, waSecret, telegramSecret } = opts;

  await app.register(async (scoped) => {
    scoped.addHook("preHandler", makeWebhookAuth(webhookSecret));
    recadoErrorHandler(scoped);
    scoped.post(RECADO_VOICE_PATH, async (request) => service.createFromVoice(request.body, Date.now()));
  });

  if (waSecret !== undefined) {
    await app.register(async (scoped) => {
      scoped.addHook("preHandler", makeWebhookAuth(webhookSecret));
      scoped.addHook("preHandler", makeScopedWebhookAuth(waSecret, WA_SECRET_HEADER));
      recadoErrorHandler(scoped);
      scoped.post(RECADO_WA_PATH, async (request) =>
        service.createFromWhatsApp(request.headers, request.body, Date.now()),
      );
    });
  }

  if (updates !== undefined && telegramSecret !== undefined) {
    await app.register(async (scoped) => {
      scoped.post(RECADOS_WEBHOOK_PATH, async (request, reply) => {
        const provided = request.headers[TELEGRAM_SECRET_HEADER];
        const value = Array.isArray(provided) ? provided[0] : provided;
        if (!value || !safeEqual(value, telegramSecret)) {
          request.log.warn({}, "recados: telegram webhook with a bad or missing secret");
          return reply.code(401).send();
        }
        await updates.handle(request.body, Date.now());
        return reply.code(200).send({});
      });
    });
  }
}
