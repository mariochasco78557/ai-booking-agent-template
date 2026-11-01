/**
 * Configuration, read once from the environment and validated.
 *
 * The brain fails closed: in any mode other than `off` a missing secret stops
 * the process at boot instead of letting it answer customers half-configured.
 * In `off` it is a pure relay and needs nothing but the Vocero URL.
 */

import { DEFAULT_OPENING_HOURS, OpeningHoursError, parseOpeningHours, type OpeningHours } from "./hours.js";

export type BrainMode = "off" | "pilot" | "live";

export interface Config {
  port: number;
  /**
   * off   — relay every Meta webhook to Vocero and do nothing else.
   * pilot — also answer, but only the WhatsApp numbers in `allowedWaIds`.
   * live  — answer everyone.
   */
  mode: BrainMode;
  allowedWaIds: ReadonlySet<string>;
  /** Phone Number ID of the salon's line; events for any other number are ignored. */
  phoneNumberId: string | undefined;

  voceroUrl: string;
  voceroBotKey: string;

  middlewareUrl: string;
  aiWebhookSecret: string;
  aiBookingSecret: string | undefined;
  /** false: the booking tool answers `write_disabled` and nothing is created. */
  bookingEnabled: boolean;
  /**
   * `x-ai-wa-secret` of the middleware's ADR-032 routes. Absent: «mis citas»
   * and «anular» keep answering `self_service_off`, exactly as before.
   */
  selfServiceSecret: string | undefined;

  openrouterKey: string;
  openrouterBaseUrl: string;
  model: string;

  /** Weekly schedule rendered into the system prompt (`BRAIN_OPENING_HOURS`). */
  openingHours: OpeningHours;
  /** on: hours offered in a reply are also sent as tappable buttons / list. */
  interactive: boolean;
  /** Past cancellations / late notices on a ficha older than this many days are ignored. */
  historyDays: number;

  coalesceMs: number;
  maxToolRounds: number;
  /**
   * 2026-10-09 — confirmed bookings one WhatsApp conversation (one session)
   * may make, for several people. Default 3. The middleware also caps the
   * PENDING appointments per phone (MAX_FUTURE_BOOKINGS_PER_PHONE).
   */
  maxBookingsPerConversation: number;
  /** A conversation idle for longer than this starts a fresh session. */
  sessionTtlMs: number;
  dataDir: string;
  version: string;
  commit: string | undefined;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function req(env: Env, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`${key} is required`);
  return v;
}

function opt(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = opt(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = opt(env, key);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(`${key} must be "true" or "false"`);
}

/** WhatsApp ids as Meta sends them: digits only, no "+". */
export function normalizeWaId(raw: string): string {
  return raw.replace(/\D/g, "");
}

export function loadConfig(env: Env = process.env): Config {
  const modeRaw = (opt(env, "BRAIN_MODE") ?? "off").toLowerCase();
  if (modeRaw !== "off" && modeRaw !== "pilot" && modeRaw !== "live") {
    throw new ConfigError('BRAIN_MODE must be "off", "pilot" or "live"');
  }
  const mode = modeRaw as BrainMode;
  const answering = mode !== "off";

  const allowedWaIds = new Set(
    (opt(env, "BRAIN_ALLOWED_WA_IDS") ?? "")
      .split(",")
      .map((s) => normalizeWaId(s))
      .filter((s) => s.length > 0)
  );
  if (mode === "pilot" && allowedWaIds.size === 0) {
    throw new ConfigError("BRAIN_MODE=pilot needs at least one number in BRAIN_ALLOWED_WA_IDS");
  }

  const voceroBotKey = answering ? req(env, "VOCERO_BOT_API_KEY") : (opt(env, "VOCERO_BOT_API_KEY") ?? "");
  if (answering && voceroBotKey.length < 16) {
    throw new ConfigError("VOCERO_BOT_API_KEY must be at least 16 characters");
  }

  const bookingEnabled = bool(env, "BRAIN_BOOKING_ENABLED", false);
  const aiBookingSecret = opt(env, "AI_BOOKING_WEBHOOK_SECRET");

  const selfServiceSecret = opt(env, "WA_SELF_SERVICE_SECRET");
  if (selfServiceSecret !== undefined && selfServiceSecret.length < 32) {
    throw new ConfigError("WA_SELF_SERVICE_SECRET must be at least 32 characters");
  }

  let openingHours: OpeningHours;
  try {
    openingHours = parseOpeningHours(opt(env, "BRAIN_OPENING_HOURS") ?? DEFAULT_OPENING_HOURS);
  } catch (err) {
    if (err instanceof OpeningHoursError) throw new ConfigError(`BRAIN_OPENING_HOURS: ${err.message}`);
    throw err;
  }

  const interactiveRaw = (opt(env, "BRAIN_INTERACTIVE") ?? "off").toLowerCase();
  if (interactiveRaw !== "off" && interactiveRaw !== "on") throw new ConfigError('BRAIN_INTERACTIVE must be "off" or "on"');

  return {
    port: int(env, "PORT", 8080, 1, 65535),
    mode,
    allowedWaIds,
    phoneNumberId: opt(env, "WA_PHONE_NUMBER_ID"),
    voceroUrl: (opt(env, "VOCERO_URL") ?? "http://vocero-app:3000").replace(/\/+$/, ""),
    voceroBotKey,
    middlewareUrl: (opt(env, "MIDDLEWARE_URL") ?? "http://middleware:3000").replace(/\/+$/, ""),
    aiWebhookSecret: answering ? req(env, "AI_WEBHOOK_SECRET") : (opt(env, "AI_WEBHOOK_SECRET") ?? ""),
    aiBookingSecret,
    bookingEnabled,
    selfServiceSecret,
    openrouterKey: answering ? req(env, "OPENROUTER_API_TOKEN") : (opt(env, "OPENROUTER_API_TOKEN") ?? ""),
    openrouterBaseUrl: (opt(env, "OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    model: opt(env, "BRAIN_MODEL") ?? "anthropic/claude-haiku-4.5",
    openingHours,
    interactive: interactiveRaw === "on",
    historyDays: int(env, "BRAIN_HISTORY_DAYS", 60, 1, 3650),
    coalesceMs: int(env, "BRAIN_COALESCE_MS", 6000, 0, 60000),
    maxToolRounds: int(env, "BRAIN_MAX_TOOL_ROUNDS", 8, 1, 20),
    maxBookingsPerConversation: int(env, "BRAIN_MAX_BOOKINGS_PER_CONVERSATION", 3, 1, 10),
    sessionTtlMs: int(env, "BRAIN_SESSION_TTL_HOURS", 24, 1, 720) * 3600_000,
    dataDir: opt(env, "BRAIN_DATA_DIR") ?? "/data",
    version: opt(env, "BRAIN_VERSION") ?? "0.3.0",
    commit: opt(env, "BRAIN_COMMIT"),
  };
}

/** Whether this brain should answer a given WhatsApp id. */
export function shouldAnswer(config: Config, waId: string): boolean {
  if (config.mode === "off") return false;
  if (config.mode === "live") return true;
  return config.allowedWaIds.has(normalizeWaId(waId));
}
