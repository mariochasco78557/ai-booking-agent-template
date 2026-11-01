import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { GENERIC_ERROR_MESSAGE } from "../utils/phrasing.js";

/**
 * Global error + not-found handlers. Callers only ever get a generic Spanish
 * message; the real error stays in structured logs. Zod validation errors
 * surface a short Spanish hint but no internal detail.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({
      success: false,
      message: "No he encontrado lo que buscas.",
    });
  });

  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      request.log.info({ issues: error.issues.length }, "validation error");
      return reply.code(400).send({
        success: false,
        message: "Faltan datos o no son válidos. ¿Puedes repetírmelo?",
      });
    }

    // Rate limit errors carry statusCode 429 from @fastify/rate-limit.
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({
        success: false,
        message: "Estoy recibiendo muchas peticiones. Prueba de nuevo en un momento.",
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    request.log.error({ err: message, statusCode: status }, "unhandled error");
    return reply.code(status >= 400 && status < 500 ? status : 500).send({
      success: false,
      message: GENERIC_ERROR_MESSAGE,
    });
  });
}
