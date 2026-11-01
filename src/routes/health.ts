import type { FastifyInstance } from "fastify";
import type { AgendaCache } from "../services/agenda/agendaCache.js";
import { resolveAppVersion } from "../utils/appVersion.js";

export interface HealthRoutesOptions {
  /** Present only when `ENABLE_AGENDA_CACHE=true`. */
  agendaCache?: AgendaCache;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  opts: HealthRoutesOptions = {},
): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    service: "ai-booking-agent",
    // Which code answered this call: `APP_VERSION` (the deployed commit SHA)
    // when the image was built with one, else `<package.json version>-dev`.
    // See src/utils/appVersion.ts.
    version: resolveAppVersion(),
  }));

  /**
   * step LAT — agenda cache health.
   *
   * A SEPARATE route from `/health` on purpose. `/health` is what Docker's
   * healthcheck polls every few seconds and what must stay trivially cheap and
   * stable; this one is for a human or a dashboard asking "is the cache warm,
   * is it hitting, and is the salon's API answering".
   *
   * *** It reports COUNTS, AGES and TIMINGS only. ***
   *
   * No date, no barber id, no barber name, no slot, ever. Both routes are
   * unauthenticated (they are excluded from the `/ai/*` webhook-secret guard
   * so a container healthcheck does not need a secret), and "which hours are
   * free at Demo Salon next Tuesday" is the salon's commercial information. A
   * liveness endpoint is not the place to publish it. `AgendaCache.health()`
   * is where that projection is built, and it is deliberately the only way out
   * of the cache for anything except the availability path itself.
   */
  app.get("/health/agenda", async (_request, reply) => {
    if (opts.agendaCache === undefined) {
      return {
        ok: true,
        cache: "disabled",
        note: "ENABLE_AGENDA_CACHE=false — availability reads go straight upstream",
      };
    }
    const health = opts.agendaCache.health();
    // 200 while the cache can still answer; 503 only once it is genuinely
    // cold, so a monitor distinguishes "warming up" from "upstream is gone".
    if (health.warmup === "cold" && (health.entries as number) === 0) {
      reply.code(503);
      return { ok: false, cache: health };
    }
    return { ok: true, cache: health };
  });
}
