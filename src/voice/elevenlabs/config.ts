import { z } from "zod";

import { formatHHmm, isValidDateISO, parseHHmm } from "../../callEngine/domain/time.js";
import {
  BOOKING_AUGUST_2026_SEASON_END,
  BOOKING_AUGUST_2026_SEASON_START,
  BOOKING_DEMO_NOW_MINUTES,
  BOOKING_DEMO_TODAY,
} from "../../callEngine/fixtures/demoSalonVenue.js";

/**
 * The ElevenLabs bridge is a separate synthetic process. It never inherits
 * the historical middleware configuration from `src/config/env.ts`, and it
 * never widens its listener beyond loopback. A future public staging ingress
 * must terminate in front of this process and is a separate deployment gate.
 */
export const ELEVENLABS_BRIDGE_HOST = "127.0.0.1" as const;
export const DEFAULT_ELEVENLABS_BRIDGE_PORT = 4321;

/**
 * The synthetic "now" the bridge runs on when nothing is configured: exactly
 * the console/demo anchor, so an unconfigured bridge behaves as it always did.
 */
export const DEFAULT_ELEVENLABS_SYNTHETIC_TODAY = BOOKING_DEMO_TODAY;
export const DEFAULT_ELEVENLABS_SYNTHETIC_NOW_MINUTES = BOOKING_DEMO_NOW_MINUTES;

const HHMM = /^\d{2}:\d{2}$/;

function isValidHHmm(value: string): boolean {
  if (!HHMM.test(value)) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return hours !== undefined && minutes !== undefined && hours <= 23 && minutes <= 59;
}

/** Blank or absent means "not configured", never "the empty string". */
function optionalText(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

const envSchema = z.object({
  ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  ELEVENLABS_SYNTHETIC_BRIDGE_PORT: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? undefined : value))
    .pipe(z.coerce.number().int().positive().max(65_535).optional())
    .transform((value) => value ?? DEFAULT_ELEVENLABS_BRIDGE_PORT),
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(32).max(512).optional(),
  ELEVENLABS_CALL_HASH_SALT: z.string().min(32).max(512).optional(),
  ELEVENLABS_SYNTHETIC_TODAY: z
    .string()
    .optional()
    .transform(optionalText)
    .pipe(
      z
        .string()
        .refine(isValidDateISO, "debe ser una fecha real con formato YYYY-MM-DD")
        .refine(
          (value) => value >= BOOKING_AUGUST_2026_SEASON_START && value <= BOOKING_AUGUST_2026_SEASON_END,
          `debe caer dentro de la temporada sintética del fixture (${BOOKING_AUGUST_2026_SEASON_START}..${BOOKING_AUGUST_2026_SEASON_END})`,
        )
        .optional(),
    ),
  ELEVENLABS_SYNTHETIC_NOW_TIME: z
    .string()
    .optional()
    .transform(optionalText)
    .pipe(z.string().refine(isValidHHmm, "debe ser una hora real con formato HH:mm entre 00:00 y 23:59").optional()),
});

export interface ElevenLabsBridgeConfig {
  enabled: boolean;
  host: typeof ELEVENLABS_BRIDGE_HOST;
  port: number;
  webhookSecret?: string;
  callHashSalt?: string;
  /**
   * Present ONLY when the operator set `ELEVENLABS_SYNTHETIC_TODAY` /
   * `ELEVENLABS_SYNTHETIC_NOW_TIME`. An absent key means "nothing was
   * configured", which is a different fact from "configured to the default",
   * and the difference is visible in the parsed config instead of being
   * flattened by an eager default. Read the effective anchor through
   * `resolveElevenLabsSyntheticAnchor()`, never these fields directly.
   */
  syntheticToday?: string;
  syntheticNowMinutes?: number;
}

/** The synthetic anchor actually used by the bridge, defaults already applied. */
export interface ElevenLabsSyntheticAnchor {
  /** "YYYY-MM-DD" wall-clock day the bridge calls "today". */
  today: string;
  /** Minutes since midnight the bridge calls "now". */
  nowMinutes: number;
  /** `nowMinutes` rendered as "HH:mm", for /health and startup logs. */
  nowTime: string;
}

export function loadElevenLabsBridgeConfig(env: NodeJS.ProcessEnv = process.env): ElevenLabsBridgeConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Configuración del puente ElevenLabs inválida:\n${issues}`);
  }

  return {
    enabled: parsed.data.ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED,
    host: ELEVENLABS_BRIDGE_HOST,
    port: parsed.data.ELEVENLABS_SYNTHETIC_BRIDGE_PORT,
    ...(parsed.data.ELEVENLABS_WEBHOOK_SECRET !== undefined
      ? { webhookSecret: parsed.data.ELEVENLABS_WEBHOOK_SECRET }
      : {}),
    ...(parsed.data.ELEVENLABS_CALL_HASH_SALT !== undefined
      ? { callHashSalt: parsed.data.ELEVENLABS_CALL_HASH_SALT }
      : {}),
    ...(parsed.data.ELEVENLABS_SYNTHETIC_TODAY !== undefined
      ? { syntheticToday: parsed.data.ELEVENLABS_SYNTHETIC_TODAY }
      : {}),
    ...(parsed.data.ELEVENLABS_SYNTHETIC_NOW_TIME !== undefined
      ? { syntheticNowMinutes: parseHHmm(parsed.data.ELEVENLABS_SYNTHETIC_NOW_TIME) }
      : {}),
  };
}

/**
 * The synthetic anchor the bridge runs on: what the operator configured, or
 * the console/demo anchor when they configured nothing. There is no third
 * source — the real wall clock is never read.
 */
export function resolveElevenLabsSyntheticAnchor(config: ElevenLabsBridgeConfig): ElevenLabsSyntheticAnchor {
  const nowMinutes = config.syntheticNowMinutes ?? DEFAULT_ELEVENLABS_SYNTHETIC_NOW_MINUTES;
  return {
    today: config.syntheticToday ?? DEFAULT_ELEVENLABS_SYNTHETIC_TODAY,
    nowMinutes,
    nowTime: formatHHmm(nowMinutes),
  };
}

export function requireElevenLabsBridgeEnabled(
  config: ElevenLabsBridgeConfig,
): asserts config is ElevenLabsBridgeConfig & { webhookSecret: string; callHashSalt: string } {
  if (!config.enabled) {
    throw new Error(
      "El puente sintético de ElevenLabs está desactivado. " +
        "Actívalo explícitamente con ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED=1.",
    );
  }
  if (config.webhookSecret === undefined || config.callHashSalt === undefined) {
    throw new Error(
      "Faltan ELEVENLABS_WEBHOOK_SECRET o ELEVENLABS_CALL_HASH_SALT (mínimo 32 caracteres cada uno). " +
        "No se inicia un webhook sin autenticación ni hash salado.",
    );
  }
}
