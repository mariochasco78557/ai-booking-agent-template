import { z } from "zod";

/**
 * Configuration for the step 13 operator console demo — a SEPARATE process
 * and a SEPARATE Fastify instance from the real middleware (src/app.ts).
 * This module never imports src/app.ts or src/config/env.ts: the console has
 * its own, much smaller configuration surface, and must never be able to
 * inherit or be confused with the real service's configuration.
 *
 * ARCHITECTURE DECISION (senior, non-negotiable — see the mission brief):
 *   - loopback only, ever: `CONSOLE_HOST` below is a HARD-CODED constant,
 *     not read from the environment at all, precisely so no environment
 *     variable can ever widen this console's bind address to something
 *     network-reachable.
 *   - default port 4310. Port 3000 is occupied by an UNRELATED process
 *     belonging to a different user on this machine and must never be
 *     touched. This module never binds it, never probes it and never kills
 *     anything by port or by process name; the only mentions of it anywhere
 *     here are in prose explaining why it is off limits.
 *   - the console is OFF by default (`CALL_ENGINE_CONSOLE_ENABLED=false`).
 *     `requireConsoleEnabled` below is the single, explicit gate a caller
 *     (tools/call-engine-demo/console.sh, or a future test) must pass
 *     through before anything starts listening.
 */

/** Hard-coded, non-configurable bind address. Never widen this to 0.0.0.0. */
export const CONSOLE_HOST = "127.0.0.1" as const;

/** Default port for the console demo. Deliberately NOT 3000 — see module docblock. */
export const DEFAULT_CONSOLE_PORT = 4310;

const configSchema = z.object({
  CALL_ENGINE_CONSOLE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  CALL_ENGINE_CONSOLE_PORT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v))
    .pipe(z.coerce.number().int().positive().max(65535).optional())
    .transform((v) => v ?? DEFAULT_CONSOLE_PORT),
});

export interface ConsoleConfig {
  /** Whether the console is switched on. Defaults to `false` — see module docblock. */
  enabled: boolean;
  /** TCP port to listen on. Defaults to `DEFAULT_CONSOLE_PORT` (4310), never 3000. */
  port: number;
  /** Always `CONSOLE_HOST` ("127.0.0.1") — not configurable, see module docblock. */
  host: typeof CONSOLE_HOST;
}

/**
 * Reads the console's own two environment variables. Never throws by
 * itself — a disabled console is a perfectly normal, expected configuration
 * (it is the DEFAULT). Use `requireConsoleEnabled` below to fail closed
 * before actually starting a listener.
 */
export function loadConsoleConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración de la consola inválida:\n${issues}`);
  }
  return {
    enabled: parsed.data.CALL_ENGINE_CONSOLE_ENABLED,
    port: parsed.data.CALL_ENGINE_CONSOLE_PORT,
    host: CONSOLE_HOST,
  };
}

/**
 * Fails LOUDLY and EXPLICITLY when the console is not switched on — never a
 * silent no-op. Must be called before any `listen()`. Kept as a separate
 * function (rather than folded into `loadConsoleConfig`) so a caller can
 * still inspect the resolved configuration (e.g. in a test) without the
 * disabled case throwing.
 */
export function requireConsoleEnabled(config: ConsoleConfig): void {
  if (!config.enabled) {
    throw new Error(
      "La consola operativa está desactivada (CALL_ENGINE_CONSOLE_ENABLED no es 'true'). " +
        "No se arranca ningún servidor. Actívala explícitamente con CALL_ENGINE_CONSOLE_ENABLED=1 " +
        "si de verdad quieres levantar esta demostración local.",
    );
  }
}
