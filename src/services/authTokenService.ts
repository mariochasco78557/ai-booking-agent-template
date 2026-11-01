/** Anything that can exchange service credentials for a JWT (a REST backend adapter). */
export interface LoginClient {
  login(username: string, password: string): Promise<string>;
}
import { maskToken } from "../utils/mask.js";

/** Minimal logger contract (pino-compatible). */
export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

interface CachedToken {
  token: string;
  /** Epoch ms after which we should proactively re-login. */
  refreshAfter: number;
}

/** Fallback TTL if the JWT has no readable exp (Lexik default is 32400s). */
const FALLBACK_TTL_SECONDS = 32400;
/** Re-login once we are within this fraction of expiry (90% -> refresh at 90%). */
const REFRESH_RATIO = 0.9;
/** Absolute safety margin so we never use a token about to die. */
const MIN_MARGIN_MS = 30_000;

/** Decode a JWT payload's `exp` (seconds) without verifying signature. */
export function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(payload, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp : null;
  } catch {
    return null;
  }
}

/**
 * Logs into a REST booking backend once and caches the JWT in memory until near
 * expiry. Concurrent callers share a single in-flight login (single-flight).
 * Never logs the token or password.
 */
export class AuthTokenService {
  private cache: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly client: LoginClient,
    private readonly creds: { username: string; password: string },
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns a valid token, logging in or refreshing as needed. */
  async getToken(): Promise<string> {
    if (this.cache && this.now() < this.cache.refreshAfter) {
      return this.cache.token;
    }
    return this.refresh();
  }

  /** Force a fresh login (e.g. after a 401). */
  async refresh(): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doLogin().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Invalidate the cache so the next getToken re-logs in. */
  invalidate(): void {
    this.cache = null;
  }

  private async doLogin(): Promise<string> {
    const token = await this.client.login(
      this.creds.username,
      this.creds.password,
    );
    const issuedAt = this.now();
    const exp = decodeJwtExp(token);
    let refreshAfter: number;
    if (exp) {
      const lifetimeMs = exp * 1000 - issuedAt;
      refreshAfter = issuedAt + Math.max(lifetimeMs * REFRESH_RATIO, MIN_MARGIN_MS);
    } else {
      refreshAfter = issuedAt + FALLBACK_TTL_SECONDS * 1000 * REFRESH_RATIO;
    }
    this.cache = { token, refreshAfter };
    this.logger.debug(
      { token: maskToken(token), refreshInSec: Math.round((refreshAfter - issuedAt) / 1000) },
      "obtained upstream JWT",
    );
    return token;
  }
}
