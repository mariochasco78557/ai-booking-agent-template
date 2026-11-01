import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { GENERIC_ERROR_MESSAGE } from "../utils/phrasing.js";

const HEADER = "x-ai-webhook-secret";

/**
 * The header carrying the booking-only credential. A SEPARATE header, not a
 * second accepted value of the one above: two credentials cannot travel in one
 * header, and the property worth having is that a booking request must present
 * BOTH — the shared `/ai/*` secret and this one.
 */
export const BOOKING_SECRET_HEADER = "x-ai-booking-secret";

/** Constant-time string compare that is safe for differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still burn a comparison to avoid trivial length timing leaks.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Fastify preHandler guarding /ai/* routes with a shared secret. Fails closed:
 * a missing/empty/wrong header returns 401 with a generic Spanish message. The
 * secret is never logged.
 */
export function makeWebhookAuth(expectedSecret: string) {
  return makeScopedWebhookAuth(expectedSecret, HEADER);
}

/**
 * step LAT (objective 3) — the same guard, for a route that must accept a
 * DIFFERENT secret from every other `/ai/*` route.
 *
 * Until now one `AI_WEBHOOK_SECRET` opened every `/ai/*` route, so the secret
 * the voice agent carries in order to READ the agenda was, by construction,
 * also the secret that would let anyone holding it attempt a BOOKING. Those
 * are not the same privilege and should never have been the same credential:
 * availability is consulted on every call, so its secret is the one most
 * exposed to rotation mistakes, log capture and third-party configuration —
 * while creation is the one that writes into a real customer's diary.
 *
 * Splitting them means a leaked availability secret can read the agenda and
 * nothing more, and that the booking credential can be rotated without
 * touching the tool the agent uses on every single call.
 *
 * Constant-time comparison, generic 401, and the secret is never logged —
 * all exactly as before.
 */
export function makeScopedWebhookAuth(expectedSecret: string, header: string) {
  return async function webhookAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const provided = request.headers[header];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!value || !safeEqual(value, expectedSecret)) {
      request.log.warn(
        { route: request.url },
        "rejected /ai request: bad or missing webhook secret",
      );
      await reply.code(401).send({
        success: false,
        message: GENERIC_ERROR_MESSAGE,
      });
    }
  };
}
