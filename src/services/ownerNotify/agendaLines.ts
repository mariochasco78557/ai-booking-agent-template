import { madridDate } from "../../utils/madridDate.js";
import { serviceLabel } from "../../core/texts/texts.js";

/**
 * One-line agenda notices for the owner and the morning digest
 * ((internal doc, not included in the template) §3.1-§3.2). PURE functions, plain
 * text, and NEVER a phone number: the events are stored without one and with
 * the customer's name already shortened («Mikel A.»).
 */

export type AgendaChannel = "whatsapp" | "voice";

export type AgendaEvent =
  | {
      type: "cancelled";
      startsAt: string; // "YYYY-MM-DD HH:mm" (Madrid)
      professional: string | null;
      customer: string;
      noticeMinutes: number;
      lateNotice: boolean;
      channel: AgendaChannel;
      dictated?: true;
    }
  | {
      type: "changed";
      fromStartsAt: string;
      toStartsAt: string;
      fromProfessional: string | null;
      toProfessional: string | null;
      customer: string;
      channel: AgendaChannel;
      dictated?: true;
    }
  | {
      type: "service";
      startsAt: string;
      professional: string | null;
      fromService: number | null;
      toService: number;
      customer: string;
      channel: AgendaChannel;
    }
  | {
      type: "booked";
      channel: AgendaChannel;
      conversationId: string;
      startsAt: string | null;
      professional: string | null;
    };

export type AgendaLineEvent = Exclude<AgendaEvent, { type: "booked" }>;

export const AGENDA_DIGEST_MAX_LINES = 25;
const MAX_NAME_LENGTH = 20;

const SHORT_DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;
const LONG_DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** «IA - Mikel» + «Aguirre» → «Mikel A.». No name → «sin nombre». */
export function shortCustomer(name: string, surnames: string, prefix: string): string {
  let n = name.trim();
  const p = prefix.trim();
  if (p !== "") {
    const pattern = p
      .split(/\s*-\s*/)
      .map(escapeRegExp)
      .join("\\s*-\\s*");
    n = n.replace(new RegExp(`^${pattern}\\s*`, "i"), "");
  }
  n = n.replace(/^ia\s*-\s*/i, "").replace(/\s+/g, " ").trim();
  if (n.length > MAX_NAME_LENGTH) n = n.slice(0, MAX_NAME_LENGTH).trim();
  if (n === "") return "sin nombre";
  n = `${n.slice(0, 1).toUpperCase()}${n.slice(1)}`;
  const first = surnames.trim().split(/\s+/)[0] ?? "";
  if (first === "") return n;
  return `${n} ${first.slice(0, 1).toUpperCase()}.`;
}

export function shortProfessional(employeeName: string | null | undefined): string | null {
  if (typeof employeeName !== "string") return null;
  const first = employeeName.trim().split(/\s+/)[0] ?? "";
  return first === "" ? null : first;
}

interface Stamp {
  y: number;
  m: number;
  d: number;
  hhmm: string;
}

function parseStamp(startsAt: string): Stamp | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(startsAt);
  if (match === null) return null;
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    hhmm: `${match[4]}:${match[5]}`,
  };
}

function dayNumber(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dayTimeShort(startsAt: string, nowMs: number): string {
  const stamp = parseStamp(startsAt);
  if (stamp === null) return startsAt;
  const today = madridDate(nowMs);
  const diff =
    dayNumber(stamp.y, stamp.m, stamp.d) -
    dayNumber(Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(today.slice(8, 10)));
  if (diff === 0) return `hoy ${stamp.hhmm}`;
  if (diff === 1) return `mañana ${stamp.hhmm}`;
  const weekday = SHORT_DAYS[new Date(Date.UTC(stamp.y, stamp.m - 1, stamp.d)).getUTCDay()]!;
  if (diff >= 2 && diff <= 6) return `${weekday} ${stamp.hhmm}`;
  return `${weekday} ${stamp.d}/${stamp.m} ${stamp.hhmm}`;
}

export function noticeText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h`;
  const days = Math.floor(m / 1440);
  return days === 1 ? "1 día" : `${days} días`;
}

/** The service in an agenda line: `servicios[].etiquetas.corta` (or voz / name in lower case), D-010. */
export function shortService(type: number | null): string {
  return serviceLabel(type, "corta") ?? "otro servicio";
}

function joinDots(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}

export function formatAgendaLine(e: AgendaLineEvent, nowMs: number): string {
  if (e.type === "cancelled") {
    const notice = noticeText(e.noticeMinutes);
    return joinDots([
      "❌ ANULADA",
      dayTimeShort(e.startsAt, nowMs),
      e.professional,
      e.customer,
      e.lateNotice ? `⚠️ SIN AVISO (${notice} antes)` : `con aviso (${notice} antes)`,
      // Decision 2026-10-11: no «nº dictado» suffix (`dictated` is kept as data only).
    ]);
  }
  if (e.type === "changed") {
    const profs =
      e.fromProfessional !== null && e.toProfessional !== null && e.fromProfessional !== e.toProfessional
        ? `${e.fromProfessional} → ${e.toProfessional}`
        : e.fromProfessional;
    return joinDots([
      "🔁 CAMBIADA",
      `${dayTimeShort(e.fromStartsAt, nowMs)} → ${dayTimeShort(e.toStartsAt, nowMs)}`,
      profs,
      e.customer,
    ]);
  }
  return joinDots([
    "✂️ SERVICIO",
    dayTimeShort(e.startsAt, nowMs),
    e.professional,
    `${shortService(e.fromService)} → ${shortService(e.toService)}`,
    e.customer,
  ]);
}

function sortKey(e: AgendaLineEvent): string {
  if (e.type === "changed") return e.fromStartsAt < e.toStartsAt ? e.fromStartsAt : e.toStartsAt;
  return e.startsAt;
}

function bookedLine(booked: { whatsapp: number; voice: number }): string | null {
  const total = booked.whatsapp + booked.voice;
  if (total <= 0) return null;
  const parts: string[] = [];
  if (booked.whatsapp > 0) parts.push(`${booked.whatsapp} WhatsApp`);
  if (booked.voice > 0) parts.push(`${booked.voice} ${booked.voice === 1 ? "llamada" : "llamadas"}`);
  return `🆕 ${total} ${total === 1 ? "reserva nueva" : "reservas nuevas"} de los agentes (${parts.join(" · ")})`;
}

/** The header alone: the only part of the digest kept on disk. */
export function formatDigestHeader(date: string, count: number | null): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const weekday = LONG_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  const tail =
    count === null ? "no he podido contar las citas" : count === 0 ? "sin citas" : count === 1 ? "1 cita" : `${count} citas`;
  return `📅 Hoy ${weekday} ${d} · ${tail}`;
}

export function formatDigest(
  d: {
    date: string;
    count: number | null;
    lines: AgendaLineEvent[];
    booked: { whatsapp: number; voice: number };
  },
  nowMs: number,
): string {
  const sorted = [...d.lines].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const out: string[] = [formatDigestHeader(d.date, d.count)];
  for (const e of sorted.slice(0, AGENDA_DIGEST_MAX_LINES)) out.push(formatAgendaLine(e, nowMs));
  if (sorted.length > AGENDA_DIGEST_MAX_LINES) out.push(`… y ${sorted.length - AGENDA_DIGEST_MAX_LINES} más`);
  const booked = bookedLine(d.booked);
  if (booked !== null) out.push(booked);
  return out.join("\n");
}
