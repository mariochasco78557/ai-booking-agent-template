/**
 * Cliente REST mínimo de Google Calendar v3 sobre `fetch`, con token OAuth de
 * cuenta de servicio firmado con `node:crypto` (RS256). Sin dependencias npm
 * (D-014): solo usa los cuatro recursos que necesita el adaptador
 * (`freeBusy`, `events.list/get/insert/patch/delete`).
 *
 * `fetch` se inyecta: los tests pasan un Google falso en memoria y nunca hay
 * red. La credencial nunca se registra ni se incluye en un error.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { UpstreamError } from "../../../core/calendar/errors.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
/** Mínimo privilegio: eventos (leer/escribir) + libre/ocupado. */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/**
 * Lee la credencial de la cuenta de servicio: ruta a un JSON
 * (`GOOGLE_SERVICE_ACCOUNT_JSON`) o el JSON en base64
 * (`GOOGLE_SERVICE_ACCOUNT_JSON_B64`). Los errores nombran la variable, nunca
 * el contenido.
 */
export function loadServiceAccount(source: { jsonPath?: string; jsonB64?: string }): ServiceAccountCredentials {
  let raw: string;
  let origin: string;
  if (source.jsonB64 !== undefined && source.jsonB64.trim() !== "") {
    origin = "GOOGLE_SERVICE_ACCOUNT_JSON_B64";
    raw = Buffer.from(source.jsonB64.trim(), "base64").toString("utf8");
  } else if (source.jsonPath !== undefined && source.jsonPath.trim() !== "") {
    origin = "GOOGLE_SERVICE_ACCOUNT_JSON";
    try {
      raw = readFileSync(source.jsonPath.trim(), "utf8");
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON: no se puede leer el fichero indicado");
    }
  } else {
    throw new Error("google-calendar necesita GOOGLE_SERVICE_ACCOUNT_JSON o GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${origin}: no es un JSON válido de cuenta de servicio`);
  }
  const c = parsed as Partial<ServiceAccountCredentials>;
  if (typeof c.client_email !== "string" || typeof c.private_key !== "string" || !c.private_key.includes("PRIVATE KEY")) {
    throw new Error(`${origin}: faltan client_email o private_key (¿es el JSON de una cuenta de servicio?)`);
  }
  return {
    client_email: c.client_email,
    private_key: c.private_key,
    ...(typeof c.token_uri === "string" ? { token_uri: c.token_uri } : {}),
  };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** JWT RS256 de la cuenta de servicio (RFC 7523, grant jwt-bearer). */
export function signServiceAccountJwt(creds: ServiceAccountCredentials, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      aud: creds.token_uri ?? GOOGLE_TOKEN_URI,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(creds.private_key).toString("base64url")}`;
}

export interface GoogleApiOptions {
  credentials: ServiceAccountCredentials;
  fetch: FetchLike;
  timeoutMs: number;
  now: () => number;
  baseUrl?: string;
}

export type Query = Record<string, string | number | boolean | undefined>;

/**
 * Token cacheado + peticiones JSON. Un 401 de la API descarta el token (la
 * siguiente llamada pide otro) y se lanza como `UpstreamError` 401, igual que
 * en Demo Salon: quien llama decide reintentar.
 */
export class GoogleApi {
  private token: { value: string; expiresAtMs: number } | null = null;
  private pending: Promise<string> | null = null;
  private readonly baseUrl: string;

  constructor(private readonly opts: GoogleApiOptions) {
    this.baseUrl = opts.baseUrl ?? GOOGLE_CALENDAR_BASE;
  }

  /** Token vigente (lo pide si falta o caduca en menos de 60 s). */
  async getToken(): Promise<string> {
    if (this.token !== null && this.token.expiresAtMs - 60_000 > this.opts.now()) return this.token.value;
    if (this.pending === null) {
      this.pending = this.fetchToken().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  invalidate(): void {
    this.token = null;
  }

  private async fetchToken(): Promise<string> {
    const creds = this.opts.credentials;
    const assertion = signServiceAccountJwt(creds, Math.floor(this.opts.now() / 1000));
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString();
    const res = await this.send("token", creds.token_uri ?? GOOGLE_TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await safeJson(res)) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
    if (!res.ok || typeof json?.access_token !== "string") {
      throw new UpstreamError("google token request failed", {
        status: res.status,
        upstreamMessage: json?.error_description ?? json?.error ?? undefined,
      });
    }
    this.token = {
      value: json.access_token,
      expiresAtMs: this.opts.now() + (Number(json.expires_in) || 3600) * 1000,
    };
    return json.access_token;
  }

  /** Petición autenticada; devuelve el JSON (o `null` en 204). Errores HTTP -> `UpstreamError`. */
  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const token = await this.getToken();
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.append(k, String(v));
    }
    const res = await this.send(`${method} ${path.split("/")[1] ?? ""}`, url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (res.status === 204) return null as T;
    const json = await safeJson(res);
    if (!res.ok) {
      if (res.status === 401) this.invalidate();
      const message = (json as { error?: { message?: string } } | null)?.error?.message;
      throw new UpstreamError(`google calendar ${method} failed`, {
        status: res.status,
        ...(typeof message === "string" ? { upstreamMessage: message } : {}),
      });
    }
    return json as T;
  }

  private async send(what: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.opts.fetch(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (err) {
      // Sin estado HTTP: la escritura pudo llegar o no (el núcleo la trata como incierta).
      const timeout = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      throw new UpstreamError(`google calendar ${what} ${timeout ? "timed out" : "network error"}`);
    }
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

// ── Tipos de la API usados por el adaptador ──────────────────────────────────

export interface GoogleEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  transparency?: "opaque" | "transparent";
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

export interface GoogleEventList {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

export interface GoogleFreeBusyResponse {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }>;
}
