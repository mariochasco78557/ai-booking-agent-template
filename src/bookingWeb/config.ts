import { z } from "zod";

/**
 * ────────────────────────────────────────────────────────────────────────
 * CONFIGURACIÓN DE LA DEMOSTRACIÓN WEB DE RESERVAS — un CUARTO proceso, con
 * su propia instancia de Fastify, independiente del middleware real
 * (`src/app.ts`), de la consola de operador (`src/console/`) y del puente de
 * voz (`src/voice/`). Este módulo no importa ninguno de los tres, y ninguno de
 * los tres importa éste.
 *
 * DECISIONES NO NEGOCIABLES, iguales a las de la consola y por los mismos
 * motivos:
 *   - SÓLO LOOPBACK, siempre: `BOOKING_WEB_HOST` es una constante EN CÓDIGO,
 *     que no se lee del entorno, precisamente para que ninguna variable pueda
 *     ampliar la dirección de escucha a algo alcanzable desde la red.
 *   - Puerto por defecto 4330. El 3000 pertenece a un proceso ajeno de este
 *     equipo y no se toca nunca: este módulo no lo escucha, no lo sondea y no
 *     mata nada por puerto ni por nombre de proceso. La única mención que hay
 *     de él en todo el fichero es esta frase que explica por qué está vetado.
 *   - APAGADA POR DEFECTO (`BOOKING_WEB_DEMO_ENABLED` ausente = apagada).
 *     `requireBookingWebEnabled` es la única puerta, explícita, por la que se
 *     pasa antes de que nada se ponga a escuchar. Construir el servidor para
 *     inyectar peticiones en pruebas NO pasa por esa puerta, porque no abre
 *     ningún socket.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Dirección de escucha, fija y no configurable. Nunca ampliar a 0.0.0.0. */
export const BOOKING_WEB_HOST = "127.0.0.1" as const;

/** Puerto por defecto de la demostración web. Deliberadamente NO es el 3000. */
export const DEFAULT_BOOKING_WEB_PORT = 4330;

const configSchema = z.object({
  BOOKING_WEB_DEMO_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  BOOKING_WEB_PORT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v))
    .pipe(z.coerce.number().int().positive().max(65535).optional())
    .transform((v) => v ?? DEFAULT_BOOKING_WEB_PORT),
});

export interface BookingWebConfig {
  /** Si la demostración está encendida. Por defecto `false` — ver el docblock del módulo. */
  enabled: boolean;
  /** Puerto TCP. Por defecto `DEFAULT_BOOKING_WEB_PORT` (4330). */
  port: number;
  /** Siempre `BOOKING_WEB_HOST` ("127.0.0.1"), no configurable. */
  host: typeof BOOKING_WEB_HOST;
}

/**
 * Lee las dos variables propias de esta demostración. No lanza por sí misma:
 * una demostración apagada es una configuración perfectamente normal, y es LA
 * POR DEFECTO. Para fallar en cerrado antes de escuchar, ver
 * `requireBookingWebEnabled`.
 */
export function loadBookingWebConfig(env: NodeJS.ProcessEnv = process.env): BookingWebConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración de la demostración web inválida:\n${issues}`);
  }
  return {
    enabled: parsed.data.BOOKING_WEB_DEMO_ENABLED,
    port: parsed.data.BOOKING_WEB_PORT,
    host: BOOKING_WEB_HOST,
  };
}

/**
 * Falla RUIDOSAMENTE cuando la demostración no está encendida, nunca en
 * silencio. Se llama antes de cualquier `listen()`. Es una función aparte de
 * `loadBookingWebConfig` para que una prueba pueda inspeccionar la
 * configuración resuelta sin que el caso «apagada» lance.
 */
export function requireBookingWebEnabled(config: BookingWebConfig): void {
  if (!config.enabled) {
    throw new Error(
      "La demostración web de reservas está desactivada (BOOKING_WEB_DEMO_ENABLED no es 'true'). " +
        "No se arranca ningún servidor. Actívala explícitamente con BOOKING_WEB_DEMO_ENABLED=1 " +
        "si de verdad quieres levantar esta demostración local.",
    );
  }
}
