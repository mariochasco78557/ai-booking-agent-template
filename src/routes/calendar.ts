import type { FastifyInstance, FastifyReply } from "fastify";

import {
  buildIcs,
  CALENDAR_PAGE_CSP,
  detectPlatform,
  googleCalendarUrl,
  renderCalendarPage,
  renderUnavailablePage,
} from "../services/whatsapp/calendarEvent.js";
import { verifyCalendarToken } from "../services/whatsapp/calendarLink.js";

/**
 * *** THE ONLY PUBLIC, UNAUTHENTICATED ROUTES THAT READ A TOKEN. ***
 *
 * `GET /cal/:token`          → the Spanish page with the two buttons;
 * `GET /cal/:token/cita.ics` → the RFC 5545 file (the iPhone button).
 *
 * ── Why no bearer / webhook secret ────────────────────────────────────────
 *
 * The caller is a customer's phone, opening a link from a WhatsApp. It has no
 * credential and never will. The token IS the authorisation: HMAC-signed,
 * expiring a day after the appointment, and describing nothing but an hour, a
 * barber and a service (`calendarLink.ts`). These routes are registered on the
 * ROOT instance, outside the encapsulated `/ai/*` scopes whose `preHandler`
 * checks the webhook secret — so they gain no credential check, and no other
 * route loses one: every guard in this app is scoped to its own plugin.
 *
 * ── Registered only when the secret exists ────────────────────────────────
 *
 * `src/app.ts` calls this only with `WHATSAPP_CALENDAR_LINK_SECRET` set.
 * Without it the paths do not exist and fall through to the ordinary 404 —
 * which is also what `WHATSAPP_NOTIFICATIONS_MODE=off` looks like from outside.
 *
 * ── Its own rate-limit bucket ─────────────────────────────────────────────
 *
 * The global limiter keys every request without a caller identity on ONE
 * shared constant (see `src/app.ts`). A public page left on that key would let
 * anyone reloading it spend the voice agent's budget. So these routes carry a
 * route-level limit, which `@fastify/rate-limit` backs with its OWN store: a
 * flood here throttles calendar links and nothing else.
 */

/** Generous for a salon (a handful of taps a day); a ceiling, not a quota. */
export const CALENDAR_RATE_LIMIT_MAX = 60;
const CALENDAR_RATE_LIMIT_KEY = "calendar-link";

export interface CalendarRoutesOptions {
  secret: string;
  /** `WHATSAPP_CALENDAR_LOCATION`: the salon's address, free text. */
  location?: string;
  /** Injected by tests; production reads the wall clock per request. */
  now?: () => number;
}

/** Headers on EVERY answer of these routes, success or not. */
function privateHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("Cache-Control", "private, no-store")
    .header("X-Robots-Tag", "noindex, nofollow")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY");
}

function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return privateHeaders(reply)
    .code(status)
    .header("Content-Security-Policy", CALENDAR_PAGE_CSP)
    .type("text/html; charset=utf-8")
    .send(html);
}

export async function registerCalendarRoutes(
  app: FastifyInstance,
  options: CalendarRoutesOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const location =
    options.location !== undefined && options.location.trim() !== "" ? options.location.trim() : undefined;
  const routeConfig = {
    config: {
      rateLimit: {
        max: CALENDAR_RATE_LIMIT_MAX,
        timeWindow: "1 minute",
        keyGenerator: () => CALENDAR_RATE_LIMIT_KEY,
      },
    },
  };

  /** Verifies, or answers the friendly page and returns `undefined`. */
  function verified(token: string, reply: FastifyReply) {
    const result = verifyCalendarToken(options.secret, token, now());
    if (result.ok) return result.event;
    // 410 for a genuine link whose appointment is over; 404 for everything
    // else. The body never says which check failed.
    void sendHtml(
      reply,
      result.reason === "expired" ? 410 : 404,
      renderUnavailablePage(result.reason === "expired" ? "expired" : "invalid"),
    );
    return undefined;
  }

  app.get<{ Params: { token: string } }>("/cal/:token", routeConfig, async (request, reply) => {
    const { token } = request.params;
    const event = verified(token, reply);
    if (event === undefined) return reply;
    const html = renderCalendarPage(event, {
      icsPath: `/cal/${encodeURIComponent(token)}/cita.ics`,
      googleUrl: googleCalendarUrl(event, location !== undefined ? { location } : {}),
      platform: detectPlatform(request.headers["user-agent"]),
      ...(location !== undefined ? { location } : {}),
    });
    // The body depends on the UA (which button is primary); nothing may cache
    // it anyway, but a proxy that ignored `no-store` must not mix the two.
    return sendHtml(reply.header("Vary", "User-Agent"), 200, html);
  });

  app.get<{ Params: { token: string } }>("/cal/:token/cita.ics", routeConfig, async (request, reply) => {
    const { token } = request.params;
    const event = verified(token, reply);
    if (event === undefined) return reply;
    const ics = buildIcs(event, { token, nowMs: now(), ...(location !== undefined ? { location } : {}) });
    return privateHeaders(reply)
      .code(200)
      .type("text/calendar; charset=utf-8")
      // `inline`: iOS Safari then offers «Añadir al calendario» directly
      // instead of treating the file as a download.
      .header("Content-Disposition", 'inline; filename="cita-demo-salon.ics"')
      .send(ics);
  });
}
