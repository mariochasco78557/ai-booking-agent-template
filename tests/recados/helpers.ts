import type { AgendaDay } from "../../src/services/agenda/agendaSource.js";
import type { OpeningGatePort, DayWindow } from "../../src/services/recados/openingHoursGate.js";
import type { Recado } from "../../src/services/recados/recadoTypes.js";
import { madridDate, madridMinutes } from "../../src/utils/madridDate.js";

/** Octubre de 2026 en horario de verano (Madrid = UTC+2). */
export const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+02:00`);

// Sábado 2026-10-10, domingo 11, lunes 12, martes 13, miércoles 14.
export const SAT = "2026-10-10";
export const SUN = "2026-10-11";
export const MON = "2026-10-12";
export const TUE = "2026-10-13";
export const WED = "2026-10-14";

export const TOKEN = "1234567890:AAFakeTokenForTestsOnly_0123456789abcdefgh";
export const CHAT = "555111";

export function makeLogger() {
  const lines: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const mk = (level: string) => (obj: unknown, msg?: string) => {
    lines.push({ level, obj, msg });
  };
  return {
    lines,
    logger: { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") },
  };
}

/** A day of agenda: `ranges` are the free slots; `working=false` is a closed day / holiday. */
export function agendaDay(date: string, ranges: Array<[string, string]>, working = true): AgendaDay {
  const employees = working ? [{ id: 1, name: "Bruno", surnames: "" }] : [];
  const free =
    working && ranges.length > 0
      ? [
          {
            id: 1,
            name: "Bruno",
            surnames: "",
            date,
            slots: ranges.map(([a, b]) => ({ start: `${date} ${a}:00`, end: `${date} ${b}:00` })),
          },
        ]
      : [];
  return { date, serviceId: "1", employees, free, fetchedAtMs: 0, upstreamCalls: 2 };
}

export function fakeReader(days: Record<string, AgendaDay | "fail">) {
  return {
    read: async (date: string) => {
      const d = days[date];
      if (d === undefined || d === "fail") throw new Error("agenda down");
      return { day: d, outcome: "miss" as const, ageMs: 0 };
    },
  };
}

/** A gate whose windows are given by hand: `{ "2026-10-13": [570, 1200] }`. */
export function fixedGate(windows: Record<string, [number, number]>): OpeningGatePort {
  const windowFor = (date: string): DayWindow => {
    const w = windows[date];
    return w === undefined
      ? { date, open: false, startMin: 0, endMin: 0, source: "agenda" }
      : { date, open: true, startMin: w[0], endMin: w[1], source: "agenda" };
  };
  const isOpenAt = (ms: number): boolean => {
    const w = windowFor(madridDate(ms));
    const m = madridMinutes(ms);
    return w.open && w.startMin <= m && m < w.endMin;
  };
  return {
    windowFor,
    isOpenAt,
    openMinutesBetween: (a, b) => {
      let n = 0;
      for (let t = a; t < b; t += 60_000) if (isOpenAt(t)) n += 1;
      return n;
    },
  };
}

export function recado(over: Partial<Recado> = {}): Recado {
  return {
    id: "aaaaaaaaaaaa",
    dedupeKey: "voz:conv-00000001",
    kind: "late",
    channel: "voice",
    createdAt: at(TUE, "10:42"),
    summary: "Llego unos diez minutos tarde, estoy aparcando.",
    minutesLate: 10,
    customerName: "Ana",
    phoneE164: "+34600111222",
    phoneSource: "caller",
    phoneHash: "0123456789abcdef",
    voceroConversationId: null,
    appointment: { status: "found", startsAt: `${TUE} 11:00`, professional: "Bruno", service: "Corte de pelo", bookedName: "Ana Prueba" },
    heldAtCreation: false,
    delivery: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    messageId: null,
    sentAt: null,
    handledAt: null,
    reminderMessageId: null,
    remindedAt: null,
    reminderAttempts: 0,
    ...over,
  };
}
