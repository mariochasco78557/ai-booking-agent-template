import { createHash } from "node:crypto";

import { dayPhraseEs, parseDateTime, timeLabel } from "../../utils/dateFormatterEs.js";
import { madridWallClock } from "../../utils/madridDate.js";
import { clientSlug, getClientConfig } from "../../core/config/clientConfig.js";
import { t } from "../../core/texts/texts.js";
import type { CalendarEvent } from "./calendarLink.js";

/**
 * *** WHAT THE «AÑADIR AL CALENDARIO» LINK SHOWS. ***
 *
 * Three renderings of one verified {@link CalendarEvent}, all pure functions of
 * it (plus a clock for `DTSTAMP`):
 *
 * - {@link buildIcs}              — the RFC 5545 file Apple Calendar imports;
 * - {@link googleCalendarUrl}     — Google Calendar's "new event" template URL;
 * - {@link renderCalendarPage}    — the small Spanish page with BOTH buttons.
 *
 * ── The owner's rules, which this file is the enforcement of ──────────────
 *
 * - This WhatsApp is the ONLY reminder. So the event carries NO alarm: there
 *   is no `VALARM` anywhere in this file, and a test asserts it never appears.
 *   The customer's own calendar app decides whether to remind them.
 * - The customer CHOOSES iPhone or Android. The User-Agent only decides which
 *   of the two buttons is drawn as the primary one; both are always there,
 *   because a UA is a guess and an iPad on desktop mode reports «Macintosh».
 * - No customer data. The event names the salon, the professional and (when
 *   known) the service — never the person who booked. It could not name them
 *   if it tried: the token does not carry them (`calendarLink.ts`).
 *
 * ── The page is self-contained ───────────────────────────────────────────
 *
 * Inline CSS, no script, no font, no image, no external request of any kind.
 * It is opened from inside WhatsApp's in-app browser on a phone on 4G, and a
 * page that loads one thing loads fast. The inline stylesheet is authorised by
 * its SHA-256 in the CSP ({@link CALENDAR_PAGE_CSP}), not by `unsafe-inline`.
 */

// Datos del negocio: `clientes/<id>/cliente.yaml` (D-007), leídos una vez al
// cargar el módulo. Demo Salon: "Demo Salon", "910 00 00 25", "+34910000025".
const CLIENT = getClientConfig();
export const SALON_NAME = CLIENT.nombre;
/** Where a customer calls to change or cancel. Also on the page, as a `tel:` link. */
export const SALON_PHONE_DISPLAY = CLIENT.telefono.mostrar;
const SALON_PHONE_TEL = CLIENT.telefono.e164;
// Frases: `src/core/texts` (D-010), con {salon} y {telefono} del cliente.
export const CALENDAR_EVENT_SUMMARY = t("calendario.evento.titulo");
const CHANGES_LINE = t("calendario.cambios");
/** Demo Salon: `-//Demo Salon//Reservas//ES`. */
export const CALENDAR_PRODID = `-//${SALON_NAME}//Reservas//${CLIENT.idioma.slice(0, 2).toUpperCase()}`;
const PRODID = CALENDAR_PRODID;
/** Dominio del UID de los eventos. Demo Salon: `demo-salon`. */
export const CALENDAR_UID_DOMAIN = clientSlug(CLIENT);

// ── time ───────────────────────────────────────────────────────────────────

/** `1790325000000` → `20260925T083000Z` (RFC 5545 UTC form; also Google's). */
export function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function endMs(event: CalendarEvent): number {
  return event.startMs + event.durationMinutes * 60_000;
}

/** «viernes 25 de septiembre» and «10:30», in Madrid time, from the instant. */
export function madridLabels(ms: number): { day: string; time: string } {
  const parsed = parseDateTime(madridWallClock(ms));
  // `madridWallClock` always yields a parseable `YYYY-MM-DD HH:MM`.
  return parsed === null
    ? { day: "", time: "" }
    : { day: dayPhraseEs(parsed), time: timeLabel(parsed) };
}

// ── shared text ────────────────────────────────────────────────────────────

/** The event description, one fact per line. Shared by the ICS and Google. */
export function eventDescriptionLines(event: CalendarEvent): string[] {
  const lines: string[] = [];
  if (event.professionalName !== null) lines.push(`Profesional: ${event.professionalName}`);
  if (event.serviceLabel !== null) lines.push(`Servicio: ${event.serviceLabel}`);
  lines.push(CHANGES_LINE);
  return lines;
}

// ── ICS (RFC 5545) ─────────────────────────────────────────────────────────

/** TEXT escaping, RFC 5545 §3.3.11: `\` `;` `,` and newlines. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds one content line at 75 OCTETS (RFC 5545 §3.1): continuation lines
 * start with a single space, which counts toward their 75. Splits on code
 * points, never inside a UTF-8 sequence — «Peña» must not become two halves of
 * an «ñ».
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > limit) {
      out.push(current);
      current = ` ${char}`;
      bytes = 1 + size;
      limit = 75;
      continue;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n");
}

/**
 * The deterministic UID: the same link always describes the same event, so
 * opening it twice updates the entry instead of duplicating it in calendars
 * that honour UIDs.
 */
export function calendarUid(token: string): string {
  return `${createHash("sha256").update(token).digest("hex").slice(0, 32)}@${CALENDAR_UID_DOMAIN}`;
}

export interface BuildIcsOptions {
  /** The verified token; only its hash reaches the file (as the UID). */
  token: string;
  /** `WHATSAPP_CALENDAR_LOCATION`, when configured. */
  location?: string;
  /** For `DTSTAMP`: when this file was generated. */
  nowMs: number;
}

/** A complete `VCALENDAR` with one `VEVENT`. CRLF throughout. NO `VALARM`. */
export function buildIcs(event: CalendarEvent, options: BuildIcsOptions): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${calendarUid(options.token)}`,
    `DTSTAMP:${utcStamp(options.nowMs)}`,
    `DTSTART:${utcStamp(event.startMs)}`,
    `DTEND:${utcStamp(endMs(event))}`,
    `SUMMARY:${escapeIcsText(CALENDAR_EVENT_SUMMARY)}`,
    `DESCRIPTION:${escapeIcsText(eventDescriptionLines(event).join("\n"))}`,
    ...(options.location !== undefined && options.location.trim() !== ""
      ? [`LOCATION:${escapeIcsText(options.location.trim())}`]
      : []),
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

// ── Google Calendar ────────────────────────────────────────────────────────

/**
 * `https://calendar.google.com/calendar/render?action=TEMPLATE&…`
 *
 * `dates` in UTC with `Z` (unambiguous whatever the phone's zone), `ctz`
 * only tells Google which zone to DISPLAY the form in. The `/` between the two
 * stamps is left literal, as Google's own examples write it; every free-text
 * value goes through `encodeURIComponent`.
 */
export function googleCalendarUrl(event: CalendarEvent, options: { location?: string } = {}): string {
  const params = [
    "action=TEMPLATE",
    `text=${encodeURIComponent(CALENDAR_EVENT_SUMMARY)}`,
    `dates=${utcStamp(event.startMs)}/${utcStamp(endMs(event))}`,
    `details=${encodeURIComponent(eventDescriptionLines(event).join("\n"))}`,
    ...(options.location !== undefined && options.location.trim() !== ""
      ? [`location=${encodeURIComponent(options.location.trim())}`]
      : []),
    "ctz=Europe%2FMadrid",
  ];
  return `https://calendar.google.com/calendar/render?${params.join("&")}`;
}

// ── the page ───────────────────────────────────────────────────────────────

export type CalendarPlatform = "apple" | "android" | "unknown";

/** A GUESS, used only to choose which button looks primary. */
export function detectPlatform(userAgent: string | undefined): CalendarPlatform {
  if (userAgent === undefined) return "unknown";
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod|macintosh/i.test(userAgent)) return "apple";
  return "unknown";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_CSS = [
  "*{box-sizing:border-box}",
  "body{margin:0;background:#f4f1ec;color:#1f1b16;font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
  "main{max-width:28rem;margin:0 auto;padding:1.5rem 1rem 2.5rem}",
  "h1{font-size:1.35rem;margin:0 0 1rem}",
  "dl{background:#fff;border-radius:12px;padding:1rem 1.1rem;margin:0 0 1.25rem;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
  "dt{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:#6b6258;margin-top:.6rem}",
  "dt:first-child{margin-top:0}",
  "dd{margin:0;font-size:1.05rem;font-weight:600}",
  "p{margin:0 0 .9rem}",
  ".btn{display:block;text-align:center;text-decoration:none;font-weight:600;padding:.95rem 1rem;border-radius:12px;margin:0 0 .75rem;border:2px solid #1f1b16;color:#1f1b16;background:#fff}",
  ".btn.primary{background:#1f1b16;color:#fff}",
  ".hint{display:block;font-size:.75rem;font-weight:400;opacity:.8}",
  ".note{font-size:.9rem;color:#4a433b;margin-top:1.25rem}",
  ".note a{color:inherit}",
].join("");

function cspHash(css: string): string {
  return `'sha256-${createHash("sha256").update(css, "utf8").digest("base64")}'`;
}

/**
 * The page's own Content-Security-Policy. Nothing may load; the one inline
 * stylesheet is allowed by hash. No script is allowed at all, because there
 * is none.
 */
export const CALENDAR_PAGE_CSP = [
  "default-src 'none'",
  `style-src ${cspHash(PAGE_CSS)}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function pageShell(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_CSS}</style>`,
    "</head>",
    "<body>",
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The same sentence as {@link CHANGES_LINE}, escaped, with the phone as a `tel:` link. */
const PHONE_MARK = "\u0000telefono\u0000";
const PHONE_NOTE = `<p class="note">${escapeHtml(t("calendario.cambios", { telefono: PHONE_MARK })).replace(
  PHONE_MARK,
  `<a href="tel:${escapeHtml(SALON_PHONE_TEL)}">${escapeHtml(SALON_PHONE_DISPLAY)}</a>`,
)}</p>`;

export const CALENDAR_PAGE_TITLE = t("calendario.pagina.titulo");
export const APPLE_BUTTON_LABEL = "iPhone (Calendario de Apple)";
export const GOOGLE_BUTTON_LABEL = "Android / Google Calendar";

export interface RenderCalendarPageOptions {
  /** Root-relative URL of the `.ics` for this same token. */
  icsPath: string;
  googleUrl: string;
  platform: CalendarPlatform;
  location?: string;
}

export function renderCalendarPage(event: CalendarEvent, options: RenderCalendarPageOptions): string {
  const { day, time } = madridLabels(event.startMs);
  const rows: Array<[string, string]> = [
    ["Día", day],
    ["Hora", time],
  ];
  if (event.professionalName !== null) rows.push(["Profesional", event.professionalName]);
  if (event.serviceLabel !== null) rows.push(["Servicio", event.serviceLabel]);
  if (options.location !== undefined && options.location.trim() !== "") {
    rows.push(["Dirección", options.location.trim()]);
  }
  const details = rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");

  const button = (href: string, label: string, primary: boolean, extra = ""): string =>
    `<a class="btn${primary ? " primary" : ""}" href="${escapeHtml(href)}"${extra}>${escapeHtml(label)}${
      primary ? '<span class="hint">Recomendado para tu móvil</span>' : ""
    }</a>`;

  const body = [
    `<h1>${escapeHtml(CALENDAR_PAGE_TITLE)}</h1>`,
    `<dl>${details}</dl>`,
    "<p>Añádela al calendario de tu móvil:</p>",
    button(options.icsPath, APPLE_BUTTON_LABEL, options.platform === "apple"),
    button(options.googleUrl, GOOGLE_BUTTON_LABEL, options.platform === "android", ' rel="noopener noreferrer"'),
    PHONE_NOTE,
  ].join("\n");
  return pageShell(CALENDAR_PAGE_TITLE, body);
}

/**
 * The page for a link that does not open. Says what the customer can DO, and
 * nothing about why: `expired` and «not valid» are the only two stories, and
 * neither mentions tokens, signatures or anything internal.
 */
export function renderUnavailablePage(kind: "expired" | "invalid"): string {
  const heading = kind === "expired" ? "Este enlace ha caducado" : "Este enlace no es válido";
  const lead =
    kind === "expired"
      ? "La cita de este enlace ya ha pasado, así que ya no se puede añadir al calendario."
      : "No hemos podido abrir esta cita. Revisa que el enlace esté completo, tal como te llegó por WhatsApp.";
  return pageShell(`${heading} · ${SALON_NAME}`, [
    `<h1>${escapeHtml(heading)}</h1>`,
    `<p>${escapeHtml(lead)}</p>`,
    PHONE_NOTE,
  ].join("\n"));
}
