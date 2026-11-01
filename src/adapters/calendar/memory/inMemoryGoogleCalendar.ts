/**
 * Google Calendar v3 + OAuth falsos, en memoria, como `fetch` inyectable.
 * Sin red. Cubre lo que usa el adaptador `google-calendar`: token de cuenta
 * de servicio (verifica la firma RS256 del JWT), `freeBusy` y
 * `events.list/get/insert/patch/delete`.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { parseWall, wallToEpochMs } from "../google-calendar/timezone.js";
import type { GoogleEvent } from "../google-calendar/googleApi.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export const FAKE_SA = {
  client_email: "memory-calendar@example.com",
  private_key: privateKey,
  token_uri: "https://oauth2.googleapis.com/token",
};

export const FAKE_SA_B64 = Buffer.from(JSON.stringify({ type: "service_account", ...FAKE_SA })).toString("base64");

interface Failure {
  method: string;
  path: RegExp;
  status: number;
  message: string;
}

export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gError(status: number, message: string): Response {
  return json(status, { error: { code: status, message } });
}

export class FakeGoogleCalendar {
  readonly calendars = new Map<string, Map<string, GoogleEvent>>();
  readonly requests: SeenRequest[] = [];
  tokenRequests = 0;
  lastJwtClaims: Record<string, unknown> | null = null;
  pageSize = 2500;
  private validTokens = new Set<string>();
  private rejectNext401 = false;
  private failures: Failure[] = [];

  constructor(private readonly timeZone: string, calendarIds: string[] = []) {
    for (const id of calendarIds) this.calendars.set(id, new Map());
  }

  addCalendar(id: string): void {
    if (!this.calendars.has(id)) this.calendars.set(id, new Map());
  }

  /** Evento ya existente (p. ej. creado a mano por el negocio). */
  addEvent(calendarId: string, ev: Partial<GoogleEvent> & Pick<GoogleEvent, "start" | "end">): GoogleEvent {
    this.addCalendar(calendarId);
    const id = ev.id ?? `manual${this.calendars.get(calendarId)!.size + 1}x${Math.random().toString(32).slice(2, 8)}`;
    const stored: GoogleEvent = { status: "confirmed", ...ev, id };
    this.calendars.get(calendarId)!.set(id, stored);
    return stored;
  }

  /** Bloque ocupado en hora de pared local (`HH:mm`). */
  addBusy(calendarId: string, date: string, from: string, to: string, extra: Partial<GoogleEvent> = {}): GoogleEvent {
    return this.addEvent(calendarId, {
      summary: "Ocupado",
      start: { dateTime: `${date}T${from}:00`, timeZone: this.timeZone },
      end: { dateTime: `${date}T${to}:00`, timeZone: this.timeZone },
      ...extra,
    });
  }

  addAllDay(calendarId: string, date: string, nextDate: string, summary = "Vacaciones"): GoogleEvent {
    return this.addEvent(calendarId, { summary, start: { date }, end: { date: nextDate } });
  }

  events(calendarId: string): GoogleEvent[] {
    return [...(this.calendars.get(calendarId)?.values() ?? [])];
  }

  rejectNextApiCall(): void {
    this.rejectNext401 = true;
  }

  failNext(method: string, path: RegExp, status: number, message: string): void {
    this.failures.push({ method, path, status, message });
  }

  apiCalls(): SeenRequest[] {
    return this.requests.filter((r) => r.path !== "/token");
  }

  private instant(t: GoogleEvent["start"]): number {
    if (t?.dateTime !== undefined) {
      if (/(Z|[+-]\d{2}:\d{2})$/.test(t.dateTime)) return Date.parse(t.dateTime);
      const w = parseWall(t.dateTime)!;
      return wallToEpochMs(w.date, w.minutes, t.timeZone ?? this.timeZone);
    }
    return wallToEpochMs(t!.date!, 0, this.timeZone);
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const rawBody = typeof init.body === "string" ? init.body : undefined;

    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      this.requests.push({ method, path: "/token", query: u.searchParams, body: rawBody });
      return this.token(rawBody ?? "");
    }
    if (u.host !== "www.googleapis.com" || !u.pathname.startsWith("/calendar/v3/")) {
      return gError(404, "unknown host");
    }
    const path = u.pathname.slice("/calendar/v3".length);
    const body = rawBody !== undefined ? (JSON.parse(rawBody) as unknown) : undefined;
    this.requests.push({ method, path: decodeURIComponent(path), query: u.searchParams, body });

    const auth = new Headers(init.headers).get("authorization") ?? "";
    if (this.rejectNext401 || !this.validTokens.has(auth.replace(/^Bearer /, ""))) {
      this.rejectNext401 = false;
      return gError(401, "Request had invalid authentication credentials.");
    }
    const fIndex = this.failures.findIndex((f) => f.method === method && f.path.test(decodeURIComponent(path)));
    if (fIndex >= 0) {
      const [f] = this.failures.splice(fIndex, 1);
      return gError(f!.status, f!.message);
    }

    if (method === "POST" && path === "/freeBusy") return this.freeBusy(body as FreeBusyBody);
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return gError(404, "Not Found");
    const calendarId = decodeURIComponent(m[1]!);
    const cal = this.calendars.get(calendarId);
    if (cal === undefined) return gError(404, "Not Found");
    const eventId = m[2];
    if (eventId === undefined && method === "GET") return this.list(cal, u.searchParams);
    if (eventId === undefined && method === "POST") {
      const ev = body as GoogleEvent;
      if (cal.has(ev.id)) return gError(409, "The requested identifier already exists.");
      const stored: GoogleEvent = { ...structuredClone(ev), status: "confirmed" };
      cal.set(ev.id, stored);
      return json(200, stored);
    }
    const ev = cal.get(eventId!);
    if (method === "GET") return ev ? json(200, ev) : gError(404, "Not Found");
    if (method === "DELETE") {
      if (!ev) return gError(404, "Not Found");
      if (ev.status === "cancelled") return gError(410, "Resource has been deleted");
      ev.status = "cancelled";
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      if (!ev || ev.status === "cancelled") return gError(404, "Not Found");
      Object.assign(ev, body);
      return json(200, ev);
    }
    return gError(405, "Method not allowed");
  };

  private token(form: string): Response {
    this.tokenRequests += 1;
    const params = new URLSearchParams(form);
    const jwt = params.get("assertion") ?? "";
    const [h, c, sig] = jwt.split(".");
    const ok =
      params.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
      h !== undefined &&
      c !== undefined &&
      sig !== undefined &&
      createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"));
    if (!ok) return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    this.lastJwtClaims = JSON.parse(Buffer.from(c!, "base64url").toString("utf8")) as Record<string, unknown>;
    const token = `tok-${this.tokenRequests}`;
    this.validTokens.add(token);
    return json(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
  }

  /** Revoca todos los tokens emitidos (como si hubieran caducado). */
  expireTokens(): void {
    this.validTokens.clear();
  }

  private list(cal: Map<string, GoogleEvent>, q: URLSearchParams): Response {
    const tMin = q.get("timeMin") ? Date.parse(q.get("timeMin")!) : -Infinity;
    const tMax = q.get("timeMax") ? Date.parse(q.get("timeMax")!) : Infinity;
    const props = q.getAll("privateExtendedProperty").map((p) => p.split("=") as [string, string]);
    let items = [...cal.values()]
      .filter((e) => q.get("showDeleted") === "true" || e.status !== "cancelled")
      .filter((e) => this.instant(e.end) > tMin && this.instant(e.start) < tMax)
      .filter((e) => props.every(([k, v]) => e.extendedProperties?.private?.[k] === v));
    if (q.get("orderBy") === "startTime") items = items.sort((a, b) => this.instant(a.start) - this.instant(b.start));
    const offset = Number(q.get("pageToken") ?? "0");
    const page = items.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize < items.length ? String(offset + this.pageSize) : undefined;
    return json(200, { items: structuredClone(page), ...(next ? { nextPageToken: next } : {}) });
  }

  private freeBusy(body: FreeBusyBody): Response {
    const tMin = Date.parse(body.timeMin);
    const tMax = Date.parse(body.timeMax);
    const calendars: Record<string, unknown> = {};
    for (const { id } of body.items) {
      const cal = this.calendars.get(id);
      if (cal === undefined) {
        calendars[id] = { errors: [{ domain: "global", reason: "notFound" }], busy: [] };
        continue;
      }
      const ivs = [...cal.values()]
        .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
        .map((e) => [Math.max(this.instant(e.start), tMin), Math.min(this.instant(e.end), tMax)] as [number, number])
        .filter(([a, b]) => a < b)
        .sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const iv of ivs) {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else merged.push([...iv]);
      }
      calendars[id] = {
        busy: merged.map(([a, b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString() })),
      };
    }
    return json(200, { kind: "calendar#freeBusy", timeMin: body.timeMin, timeMax: body.timeMax, calendars });
  }
}

interface FreeBusyBody {
  timeMin: string;
  timeMax: string;
  items: Array<{ id: string }>;
}
