import { createHmac, timingSafeEqual } from "node:crypto";

import { parseDateTime } from "../../utils/dateFormatterEs.js";
import { madridWallClock } from "../../utils/madridDate.js";
import { getClientConfig } from "../../core/config/clientConfig.js";

/**
 * *** THE «AÑADIR AL CALENDARIO» LINK — a signed, stateless description of ONE
 * appointment, and nothing about the person who booked it. ***
 *
 * The WhatsApp confirmation (ADR-030) is the only reminder the salon sends. Its
 * URL button opens `https://<host>/cal/<token>`, and everything that page and
 * its `.ics` need is INSIDE the token: there is no table to look it up in, no
 * file, no state to lose on a restart, and nothing for a stranger to enumerate.
 *
 * ── What the token holds, and what it deliberately does not ───────────────
 *
 *   { v: 1, s: <start, UTC epoch SECONDS>, d: <minutes>, x: <expiry, UTC
 *     epoch SECONDS>, p?: <professional>, sv?: <service label> }
 *
 * NEVER the customer's name, NEVER their phone. The payload is signed, not
 * encrypted — anybody holding the link can read it — so it carries only what a
 * calendar entry shows: an hour, a barber's first name and a service. The same
 * facts are on the salon's shop-window agenda.
 *
 * ── The start is an INSTANT, and the conversion happens exactly once ──────
 *
 * The queue stores the salon's own Europe/Madrid WALL CLOCK
 * (`whatsappTemplate.ts` explains why it is never converted for the text of
 * the message). A calendar entry, however, must be an instant: the ICS and the
 * Google link are written in UTC (`…Z`), which every calendar app on earth
 * understands without a VTIMEZONE block. So the wall clock is converted here,
 * ONCE, at mint time, and the token carries the unambiguous UTC second. The
 * page converts it back to Madrid time for display with `Intl` — the same
 * function (`madridWallClock`) the rest of the system trusts.
 *
 * The only ambiguous wall clocks are the October fold (02:00–03:00 happens
 * twice) and the March gap (02:00–03:00 never happens). The salon is closed at
 * both; {@link madridWallClockToEpochMs} still resolves them deterministically
 * (fold → the first, summer-time occurrence; gap → read as winter time) so no
 * input can make minting throw.
 *
 * ── The signature ─────────────────────────────────────────────────────────
 *
 * HMAC-SHA256 over a DOMAIN-SEPARATED message (`demo-salon-cal-v1.` + payload),
 * truncated to 128 bits and base64url'd — 22 characters. 128 bits is far
 * beyond what an online forger behind a rate limit can search, and the link
 * stays short enough to read in a log. The comparison is constant-time and
 * happens BEFORE the payload is parsed: untrusted JSON is never even decoded.
 */

/** Bumped only if the payload shape changes; old tokens then fail as malformed. */
export const CALENDAR_TOKEN_VERSION = 1;

/**
 * *** EVERY APPOINTMENT LASTS 30 MINUTES — THE OWNER'S RULE. ***
 *
 * The salon's API returns slot STARTS, not durations ((internal doc, not included in the template), V5
 * «El middleware no conoce la duración de los servicios»), and the job only
 * carries the start. A calendar entry still needs an end. Bruno's rule
 * (2026-10-07): every appointment at Demo Salon lasts 30 minutes, whatever the
 * service — so every event is written as 30 minutes long. This replaces the
 * earlier «generous 60 minutes» guess (ADR-031): the duration is now the
 * owner's decision, not an estimate. The page itself still shows only the
 * START hour.
 *
 * Tokens minted before the change keep the duration they were signed with
 * (`d` is inside the payload), so an already-sent link is unaffected.
 */
export const CALENDAR_DEFAULT_DURATION_MINUTES = getClientConfig().duracion_cita_min; // Demo Salon: 30 (cliente.yaml, D-007)

/** How long after the appointment ENDS the link keeps working. */
export const CALENDAR_LINK_GRACE_MS = 24 * 60 * 60 * 1000;

/** Truncated MAC length. 16 bytes = 128 bits = 22 base64url characters. */
const MAC_BYTES = 16;
const MAC_CHARS = 22;

/**
 * Hard ceiling on a token. Checked before any crypto, so a hostile 1 MB path
 * segment costs a regex and nothing else. The router's own `maxParamLength`
 * (`src/app.ts`) refuses anything longer still, earlier.
 */
export const CALENDAR_TOKEN_MAX_LENGTH = 240;

/** Displayed strings inside the token are bounded, and so is the token. */
const TEXT_MAX_LENGTH = 60;

const DOMAIN_PREFIX = `demo-salon-cal-v${CALENDAR_TOKEN_VERSION}.`;

const TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{8,${CALENDAR_TOKEN_MAX_LENGTH}}\\.[A-Za-z0-9_-]{${MAC_CHARS}}$`);

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** What a verified token describes. Times are UTC instants in epoch ms. */
export interface CalendarEvent {
  readonly startMs: number;
  readonly durationMinutes: number;
  readonly professionalName: string | null;
  readonly serviceLabel: string | null;
  readonly expiresAtMs: number;
}

export type CalendarTokenVerification =
  | { ok: true; event: CalendarEvent }
  /**
   * `malformed` — not a token at all (or a shape this version does not read);
   * `forged`    — well formed, but not signed with this deployment's secret;
   * `expired`   — genuine, and past appointment end + grace.
   * The route shows `expired` as «este enlace ha caducado» (410) and the other
   * two as «no es válido» (404); neither page says which check failed.
   */
  | { ok: false; reason: "malformed" | "forged" | "expired" };

export interface MintCalendarTokenInput {
  /** Europe/Madrid wall clock, `YYYY-MM-DDTHH:mm[:ss]` (the queue's shape). */
  startsAtIso: string;
  professionalName?: string | null;
  serviceLabel?: string | null;
  /** Defaults to {@link CALENDAR_DEFAULT_DURATION_MINUTES}. */
  durationMinutes?: number;
}

interface CalendarTokenPayload {
  v: number;
  s: number;
  d: number;
  x: number;
  p?: string;
  sv?: string;
}

/**
 * `"2026-09-25T10:30:00"` (Madrid wall clock) → the UTC instant, in epoch ms.
 * `undefined` for anything that is not a date WITH a time.
 *
 * Tries the two offsets Madrid ever uses (+02:00 first, then +01:00) and keeps
 * the one whose instant formats back to the same wall clock. See the file
 * header for the fold and the gap.
 */
export function madridWallClockToEpochMs(wall: string): number | undefined {
  const parsed = parseDateTime(wall);
  if (parsed === null || !parsed.hasTime) return undefined;
  const naive = Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute);
  if (Number.isNaN(naive)) return undefined;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const expected = `${parsed.year}-${pad(parsed.month)}-${pad(parsed.day)} ${pad(parsed.hour)}:${pad(parsed.minute)}`;
  for (const offsetHours of [2, 1]) {
    const candidate = naive - offsetHours * 3_600_000;
    if (madridWallClock(candidate) === expected) return candidate;
  }
  // The spring-forward gap: a wall clock that never happens. Read as winter
  // time so minting stays total; the salon is never open at 02:30.
  return naive - 3_600_000;
}

/**
 * Collapses whitespace, bounds the length (by code point, so an accent is never
 * cut in half) and DROPS the field outright if anything unprintable is left —
 * a professional's name is never worth a control character in an ICS file.
 */
function displayText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat === "" || CONTROL_RE.test(flat)) return undefined;
  const points = Array.from(flat);
  return points.length > TEXT_MAX_LENGTH ? points.slice(0, TEXT_MAX_LENGTH).join("").trimEnd() : flat;
}

function mac(secret: string, payloadB64: string): Buffer {
  return createHmac("sha256", secret)
    .update(DOMAIN_PREFIX)
    .update(payloadB64)
    .digest()
    .subarray(0, MAC_BYTES);
}

/**
 * Mints the token for one appointment, or `undefined` when the start is not a
 * wall clock this module can read (unreachable through the booking path, whose
 * dates come out of a validated slot token).
 *
 * Deterministic: the same appointment always yields the same token, so a
 * retried send carries the same link and the token never has to be stored.
 */
export function mintCalendarToken(secret: string, input: MintCalendarTokenInput): string | undefined {
  const startMs = madridWallClockToEpochMs(input.startsAtIso);
  if (startMs === undefined) return undefined;
  const duration = input.durationMinutes ?? CALENDAR_DEFAULT_DURATION_MINUTES;
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) return undefined;

  const startSec = Math.floor(startMs / 1000);
  const payload: CalendarTokenPayload = {
    v: CALENDAR_TOKEN_VERSION,
    s: startSec,
    d: duration,
    x: startSec + duration * 60 + CALENDAR_LINK_GRACE_MS / 1000,
  };
  const professional = displayText(input.professionalName);
  if (professional !== undefined) payload.p = professional;
  const service = displayText(input.serviceLabel);
  if (service !== undefined) payload.sv = service;

  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const token = `${payloadB64}.${mac(secret, payloadB64).toString("base64url")}`;
  return token.length <= CALENDAR_TOKEN_MAX_LENGTH ? token : undefined;
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    Array.from(value).length <= TEXT_MAX_LENGTH &&
    !CONTROL_RE.test(value)
  );
}

/** Whether a decoded, AUTHENTICATED payload is one this version can render. */
function readPayload(raw: unknown): CalendarEvent | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (p.v !== CALENDAR_TOKEN_VERSION) return undefined;
  const { s, d, x } = p;
  if (typeof s !== "number" || !Number.isInteger(s) || s < 1_600_000_000 || s > 4_000_000_000) {
    return undefined;
  }
  if (typeof d !== "number" || !Number.isInteger(d) || d < 5 || d > 600) return undefined;
  if (typeof x !== "number" || !Number.isInteger(x) || x < s || x > s + d * 60 + 7 * 86_400) {
    return undefined;
  }
  if (p.p !== undefined && !isBoundedText(p.p)) return undefined;
  if (p.sv !== undefined && !isBoundedText(p.sv)) return undefined;
  return {
    startMs: s * 1000,
    durationMinutes: d,
    professionalName: (p.p as string | undefined) ?? null,
    serviceLabel: (p.sv as string | undefined) ?? null,
    expiresAtMs: x * 1000,
  };
}

/**
 * Verifies a token. Order matters and is the security argument:
 *
 * 1. shape (a regex; no allocation beyond it for garbage),
 * 2. signature, constant-time, over the RAW base64url text,
 * 3. only then decode + parse + validate the payload,
 * 4. expiry against the caller's clock.
 */
export function verifyCalendarToken(
  secret: string,
  token: string,
  nowMs: number,
): CalendarTokenVerification {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  const payloadB64 = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = mac(secret, payloadB64);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "forged" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const event = readPayload(decoded);
  if (event === undefined) return { ok: false, reason: "malformed" };
  if (nowMs >= event.expiresAtMs) return { ok: false, reason: "expired" };
  return { ok: true, event };
}

/**
 * `abcdef…(len=97)` — enough to correlate a dry-run log line with a request,
 * never enough to open the link.
 */
export function maskCalendarToken(token: string): string {
  return `${token.slice(0, 6)}…(len=${token.length})`;
}
