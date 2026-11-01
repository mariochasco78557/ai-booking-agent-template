import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { BASE_PATH, UPSTREAM, buildTestApp, nock, testEnv } from "./helpers/testApp.js";
import { RAMON, conv, mockAgendaDay, v2, v2Book } from "./helpers/balancedV2.js";
import { resolveFechaDicha, resolveFechaPiezas, type FechaResolution } from "../src/utils/dayName.js";
import { SLOT_TOKEN_SECRET } from "./helpers/testApp.js";
import { SlotAuthorizationService } from "../src/services/slotAuthorization.js";
import { BalancedAvailabilityService } from "../src/services/balanced/balancedAvailabilityService.js";
import { MemoryBalancedOptionStore } from "../src/services/balanced/balancedOptionStore.js";
import { MemoryVoiceOfferStore } from "../src/services/voiceOfferStore.js";
import type { AgendaReader } from "../src/services/agenda/agendaReader.js";
import type { AgendaRead } from "../src/services/agenda/agendaCache.js";
import type { AgendaDay } from "../src/services/agenda/agendaSource.js";
import { madridDate } from "../src/utils/madridDate.js";
import {
  balancedConfirmedSpokenEs,
  balancedDateQuestionMessage,
  balancedLockSummaryEs,
} from "../src/utils/balancedPhrasing.js";
import { bookingConfirmedMessage } from "../src/utils/phrasing.js";

/**
 * 2026-10-10 — the server resolves the date (internal doc, not included in the template).
 *
 * The call of Saturday 2026-10-10: «jueves 16» searched as Friday 16 and
 * confirmed out loud as «el jueves dieciséis»; «viernes 17» (a Saturday)
 * answered «el viernes diecisiete no tengo hueco». No personal data here.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;
const WEEKDAYS_FOLDED = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"] as const;

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function ms(dateIso: string): number {
  return Date.parse(`${dateIso}T00:00:00Z`);
}
function dow(dateIso: string): number {
  return new Date(ms(dateIso)).getUTCDay();
}
function plus(dateIso: string, days: number): string {
  return iso(ms(dateIso) + days * DAY_MS);
}
function dateOf(r: FechaResolution | undefined): string | undefined {
  return r?.kind === "date" ? r.date : undefined;
}

// ── 1. THE MATRIX: today = each weekday × three hours ───────────────────────

/** Sunday 2026-10-11 … Saturday 2026-10-17: one of each weekday. */
const WEEK = ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"];
/**
 * The hour only matters through «is the salon still open today»: before
 * opening and at midday it is (Tuesday–Saturday), after closing it is not.
 * Sunday and Monday are closed all day.
 */
const HOURS = [
  { label: "antes de abrir (08:00)", open: true },
  { label: "mediodía (13:00)", open: true },
  { label: "después de cerrar (21:00)", open: false },
] as const;

const CASES = WEEK.flatMap((today) =>
  HOURS.map((hour) => ({
    today,
    weekday: WEEKDAYS[dow(today)]!,
    hour: hour.label,
    stillOpen: hour.open && dow(today) !== 0 && dow(today) !== 1,
  })),
);

describe.each(CASES)("hoy es $weekday $today, $hour", ({ today, stillOpen }) => {
  const ctx = { todayIso: today, todayStillOpen: stillOpen };
  const resolve = (said: string) => resolveFechaDicha(said, ctx);

  it("«hoy», «mañana», «pasado mañana»", () => {
    expect(dateOf(resolve("hoy"))).toBe(today);
    expect(dateOf(resolve("Mañana"))).toBe(plus(today, 1));
    expect(dateOf(resolve("pasado mañana"))).toBe(plus(today, 2));
    expect(dateOf(resolve("mañana por la tarde"))).toBe(plus(today, 1));
  });

  it.each(WEEKDAYS_FOLDED.map((name, w) => ({ name, w })))(
    "«el $name» suelto y «este $name»: el más próximo; hoy cuenta si sigue abierto",
    ({ name, w }) => {
      // Independent oracle: walk forward from today.
      let expected = "";
      for (let d = 0; d <= 7; d += 1) {
        const candidate = plus(today, d);
        if (dow(candidate) === w && (d > 0 || stillOpen)) {
          expected = candidate;
          break;
        }
      }
      expect(dateOf(resolve(`el ${name}`))).toBe(expected);
      expect(dateOf(resolve(`este ${name}`))).toBe(expected);
      expect(dateOf(resolve(name.toUpperCase()))).toBe(expected);
    },
  );

  it.each(WEEKDAYS_FOLDED.map((name, w) => ({ name, w })))(
    "«el próximo $name» y «el $name que viene»: el más próximo DESPUÉS de hoy",
    ({ name, w }) => {
      let expected = "";
      for (let d = 1; d <= 7; d += 1) {
        if (dow(plus(today, d)) === w) {
          expected = plus(today, d);
          break;
        }
      }
      expect(dateOf(resolve(`el próximo ${name}`))).toBe(expected);
      expect(dateOf(resolve(`el ${name} que viene`))).toBe(expected);
    },
  );

  it("«X N» que casa: esa fecha; «X N» que no casa: pregunta, nunca busca", () => {
    const target = plus(today, 9);
    const n = Number(target.slice(8, 10));
    const w = dow(target);
    expect(dateOf(resolve(`${WEEKDAYS[w]} ${n}`))).toBe(target);
    const wrong = (w + 1) % 7;
    const conflict = resolve(`el ${WEEKDAYS[wrong]} ${n}`);
    expect(conflict?.kind).toBe("question");
    if (conflict?.kind === "question") {
      expect(conflict.reason).toBe("weekday_mismatch");
      expect(conflict.date).toBe(target);
      for (const option of conflict.candidates) {
        expect(ms(option)).toBeGreaterThanOrEqual(ms(today));
        expect([0, 1]).not.toContain(dow(option));
      }
    }
  });

  it("«el N» solo: este mes si no ha pasado; si ya pasó, el mes que viene (con su mes)", () => {
    const td = Number(today.slice(8, 10));
    expect(dateOf(resolve(`el ${td}`))).toBe(today);
    const later = plus(today, 3);
    expect(dateOf(resolve(`el día ${Number(later.slice(8, 10))}`))).toBe(later);
    const past = td - 1; // 10..16 -> 9..15, already gone this month
    const r = resolve(`el ${past}`);
    expect(r).toEqual({ kind: "date", date: `2026-11-${String(past).padStart(2, "0")}`, rolled: "next_month" });
  });

  it("«la semana que viene»: la semana natural siguiente, de lunes a domingo", () => {
    const r = resolve("la semana que viene");
    expect(r?.kind).toBe("week");
    if (r?.kind === "week") {
      expect(dow(r.from)).toBe(1);
      expect(ms(r.from) - ms(today)).toBeGreaterThan(0);
      expect(ms(r.from) - ms(today)).toBeLessThanOrEqual(7 * DAY_MS);
      expect(r.days).toBe(7);
    }
    const thursday = dateOf(resolve("el jueves de la semana que viene"));
    expect(thursday).toBe(plus(r?.kind === "week" ? r.from : today, 3));
  });

  it("una fecha pasada nunca se busca", () => {
    const yesterday = plus(today, -1);
    const r = resolve(`el ${Number(yesterday.slice(8, 10))} de octubre`);
    expect(r?.kind).toBe("question");
  });
});

// ── 2. FIXED DATES: the incident, month/year ends, leap day, DST, closures ───

describe("fecha_dicha · casos fijos", () => {
  const SAT_10 = { todayIso: "2026-10-10", todayStillOpen: true };

  it("la llamada real: «Jueves 16» un sábado 10 → pregunta exacta", () => {
    const r = resolveFechaDicha("Jueves 16", SAT_10);
    expect(r).toEqual({
      kind: "question",
      reason: "weekday_mismatch",
      date: "2026-10-16",
      saidWeekday: 4,
      candidates: ["2026-10-16", "2026-10-15"],
    });
    expect(balancedDateQuestionMessage(r as Extract<FechaResolution, { kind: "question" }>, "2026-10-10")).toBe(
      "El dieciséis es viernes. ¿Te lo busco el viernes dieciséis o el jueves quince?",
    );
  });

  it("la llamada real: «viernes 17» (sábado) → pregunta, no «el viernes diecisiete no tengo hueco»", () => {
    const r = resolveFechaDicha("viernes 17", SAT_10) as Extract<FechaResolution, { kind: "question" }>;
    expect(balancedDateQuestionMessage(r, "2026-10-10")).toBe(
      "El diecisiete es sábado. ¿Te lo busco el sábado diecisiete o el viernes dieciséis?",
    );
  });

  it("números en palabras y con mes: «jueves dieciséis», «el quince de octubre»", () => {
    expect(resolveFechaDicha("jueves dieciséis", SAT_10)?.kind).toBe("question");
    expect(dateOf(resolveFechaDicha("el quince de octubre", SAT_10))).toBe("2026-10-15");
    expect(dateOf(resolveFechaDicha("el viernes dieciséis a las seis de la tarde", SAT_10))).toBe("2026-10-16");
  });

  it("domingo y lunes cerrados: la pregunta no ofrece un día cerrado", () => {
    const monday = resolveFechaDicha("jueves 19", SAT_10) as Extract<FechaResolution, { kind: "question" }>;
    expect(monday.candidates).toEqual(["2026-10-22"]);
    expect(balancedDateQuestionMessage(monday, "2026-10-10")).toBe(
      "El diecinueve es lunes, y ese día cerramos. ¿Te lo busco el jueves veintidós?",
    );
    const saidMonday = resolveFechaDicha("lunes 20", SAT_10) as Extract<FechaResolution, { kind: "question" }>;
    expect(balancedDateQuestionMessage(saidMonday, "2026-10-10")).toBe(
      "El veinte es martes. ¿Te lo busco el martes veinte?",
    );
    // A closed day that the words name correctly is a date: the server says «cerramos».
    expect(dateOf(resolveFechaDicha("domingo 18", SAT_10))).toBe("2026-10-18");
  });

  it("sábado por la tarde: «el sábado» dicho el sábado ya cerrado es el sábado siguiente", () => {
    expect(dateOf(resolveFechaDicha("el sábado", { todayIso: "2026-10-10", todayStillOpen: false }))).toBe("2026-10-17");
    expect(dateOf(resolveFechaDicha("el sábado", { todayIso: "2026-10-10", todayStillOpen: true }))).toBe("2026-10-10");
  });

  it("«mañana jueves» cuando mañana es domingo: pregunta", () => {
    const r = resolveFechaDicha("mañana jueves", SAT_10) as Extract<FechaResolution, { kind: "question" }>;
    expect(r.reason).toBe("weekday_mismatch");
    expect(balancedDateQuestionMessage(r, "2026-10-10")).toBe(
      "Mañana es domingo once, y ese día cerramos. ¿Te lo busco el jueves quince?",
    );
  });

  it("fin de mes: 31-10 → noviembre", () => {
    const ctx = { todayIso: "2026-10-31", todayStillOpen: true };
    expect(dateOf(resolveFechaDicha("mañana", ctx))).toBe("2026-11-01");
    expect(resolveFechaDicha("el 3", ctx)).toEqual({ kind: "date", date: "2026-11-03", rolled: "next_month" });
    expect(dateOf(resolveFechaDicha("el 31", ctx))).toBe("2026-10-31");
    // November has no 31st.
    const nov = { todayIso: "2026-11-10", todayStillOpen: true };
    const r = resolveFechaDicha("el 31", nov) as Extract<FechaResolution, { kind: "question" }>;
    expect(r.reason).toBe("invalid_day");
    expect(balancedDateQuestionMessage(r, nov.todayIso)).toBe("Noviembre no tiene día treinta y uno. ¿Qué día te viene bien?");
  });

  it("31-12 → enero del año siguiente", () => {
    const ctx = { todayIso: "2026-12-31", todayStillOpen: true };
    expect(dateOf(resolveFechaDicha("mañana", ctx))).toBe("2027-01-01");
    expect(resolveFechaDicha("el 5", ctx)).toEqual({ kind: "date", date: "2027-01-05", rolled: "next_month" });
    expect(dateOf(resolveFechaDicha("jueves 7", ctx))).toBe("2027-01-07");
    expect(dateOf(resolveFechaDicha("el 8 de enero", ctx))).toBe("2027-01-08");
    expect(dateOf(resolveFechaDicha("el martes", ctx))).toBe("2027-01-05");
  });

  it("29-02 en un año no bisiesto (2027): pregunta; «mañana» del 28-02 es el 1 de marzo", () => {
    const ctx = { todayIso: "2027-02-10", todayStillOpen: true };
    for (const said of ["el 29", "el 29 de febrero"]) {
      const r = resolveFechaDicha(said, ctx) as Extract<FechaResolution, { kind: "question" }>;
      expect(r.reason, said).toBe("invalid_day");
      expect(balancedDateQuestionMessage(r, ctx.todayIso)).toBe("Febrero no tiene día veintinueve. ¿Qué día te viene bien?");
    }
    expect(dateOf(resolveFechaDicha("mañana", { todayIso: "2027-02-28", todayStillOpen: false }))).toBe("2027-03-01");
  });

  it("cambio de hora del 25-10-2026: «hoy» y «mañana» siguen el día de Madrid", () => {
    // 00:30 Madrid on Sunday 25 (still CEST, UTC+2) and on Monday 26 (CET, UTC+1).
    const sunday = Date.parse("2026-10-24T22:30:00Z");
    const monday = Date.parse("2026-10-25T23:30:00Z");
    expect(madridDate(sunday)).toBe("2026-10-25");
    expect(madridDate(monday)).toBe("2026-10-26");
    expect(dateOf(resolveFechaDicha("mañana", { todayIso: madridDate(sunday), todayStillOpen: false }))).toBe("2026-10-26");
    expect(dateOf(resolveFechaDicha("pasado mañana", { todayIso: madridDate(monday), todayStillOpen: false }))).toBe("2026-10-28");
    // 23:30 UTC on Saturday 24 is already Sunday 25 in Madrid.
    expect(madridDate(Date.parse("2026-10-24T23:30:00Z"))).toBe("2026-10-25");
  });

  it("fechas pasadas con mes: preguntar (cerca) o el año que viene (lejos)", () => {
    const r = resolveFechaDicha("el 5 de octubre", SAT_10) as Extract<FechaResolution, { kind: "question" }>;
    expect(r.reason).toBe("past");
    expect(balancedDateQuestionMessage(r, "2026-10-10")).toBe("El lunes cinco ya ha pasado. ¿Qué día te viene bien?");
    expect(resolveFechaDicha("el 5 de enero", SAT_10)).toEqual({ kind: "date", date: "2027-01-05", rolled: "next_year" });
    const thisWeek = resolveFechaDicha("el martes de esta semana", SAT_10) as Extract<FechaResolution, { kind: "question" }>;
    expect(balancedDateQuestionMessage(thisWeek, "2026-10-10")).toBe("El martes seis ya ha pasado. ¿Te lo busco el martes trece?");
  });

  it("«el otro jueves» pregunta cuál; lo ilegible no es una fecha", () => {
    const r = resolveFechaDicha("el otro jueves", SAT_10) as Extract<FechaResolution, { kind: "question" }>;
    expect(balancedDateQuestionMessage(r, "2026-10-10")).toBe(
      "¿Qué jueves te viene bien: el jueves quince o el jueves veintidós?",
    );
    // Nothing sent: as if absent. Anything sent that is not ONE clear day: asked (fail-closed).
    for (const raw of ["", "   ", null, undefined]) {
      expect(resolveFechaDicha(raw, SAT_10), String(raw)).toBeUndefined();
    }
    for (const raw of ["cuando sea", "otro día", 16, "x".repeat(100), "el finde largo"]) {
      expect(resolveFechaDicha(raw, SAT_10), String(raw)).toMatchObject({ kind: "question", reason: "unclear" });
    }
  });

  it("el mes que viene se nombra: «el 5» dicho el 10 → «el jueves cinco de noviembre»", () => {
    const r = resolveFechaDicha("lunes 5", SAT_10) as Extract<FechaResolution, { kind: "question" }>;
    expect(balancedDateQuestionMessage(r, "2026-10-10")).toBe(
      "El cinco de noviembre es jueves. ¿Te lo busco el jueves cinco de noviembre?",
    );
  });
});

// ── 3. THE ROUTE: date_conflict, fecha_dicha wins, every date names its day ───

const V5 = { agent_profile: "v5" } as const;
const HOURS_FRI = { 3: ["17:00", "17:30", "18:00"] };


// ── 3b. THE PIECES: today = each weekday × three hours, every combination ─────

describe.each(CASES)("piezas · hoy es $weekday $today, $hour", ({ today, stillOpen }) => {
  const ctx = { todayIso: today, todayStillOpen: stillOpen };
  const p = (body: Record<string, unknown>) => resolveFechaPiezas(body, ctx, undefined);

  it("relativo hoy / mañana / pasado_mañana, y en_dias", () => {
    expect(dateOf(p({ relativo: "hoy" }))).toBe(today);
    expect(dateOf(p({ relativo: "mañana" }))).toBe(plus(today, 1));
    expect(dateOf(p({ relativo: "pasado_mañana" }))).toBe(plus(today, 2));
    expect(dateOf(p({ en_dias: 2 }))).toBe(plus(today, 2));
    expect(dateOf(p({ en_dias: 10 }))).toBe(plus(today, 10));
    expect(dateOf(p({ en_dias: 7 }))).toBe(plus(today, 7));
  });

  it.each(WEEKDAYS_FOLDED.map((name, w) => ({ name, w })))(
    "dia_semana $name suelto y con proximo",
    ({ name, w }) => {
      let bare = "";
      let next = "";
      for (let d = 7; d >= 0; d -= 1) {
        const c = plus(today, d);
        if (dow(c) !== w) continue;
        if (d > 0 || stillOpen) bare = c;
        if (d > 0) next = c;
      }
      expect(dateOf(p({ dia_semana: name }))).toBe(bare);
      expect(dateOf(p({ dia_semana: WEEKDAYS[w] }))).toBe(bare);
      expect(dateOf(p({ dia_semana: name, proximo: true }))).toBe(next);
      expect(dateOf(p({ dia_semana: name, proximo: false }))).toBe(bare);
    },
  );

  it("dia_semana + dia_mes: casan → fecha; no casan → pregunta", () => {
    const target = plus(today, 9);
    const n = Number(target.slice(8, 10));
    expect(dateOf(p({ dia_semana: WEEKDAYS[dow(target)], dia_mes: n }))).toBe(target);
    expect(p({ dia_semana: WEEKDAYS[(dow(target) + 1) % 7], dia_mes: n })).toMatchObject({
      kind: "question",
      reason: "weekday_mismatch",
      date: target,
    });
  });

  it("dia_mes solo, con mes, y ya pasado", () => {
    const td = Number(today.slice(8, 10));
    expect(dateOf(p({ dia_mes: td }))).toBe(today);
    expect(dateOf(p({ dia_mes: td + 2 }))).toBe(plus(today, 2));
    expect(dateOf(p({ dia_mes: td - 1 }))).toBe(`2026-11-${String(td - 1).padStart(2, "0")}`);
    expect(dateOf(p({ dia_mes: 20, mes: 11 }))).toBe("2026-11-20");
    expect(p({ dia_mes: td - 1, mes: 10 })).toMatchObject({ kind: "question", reason: "past" });
  });

  it("relativo + dia_mes / dia_semana que no casan → pregunta", () => {
    const tomorrow = plus(today, 1);
    expect(dateOf(p({ relativo: "mañana", dia_mes: Number(tomorrow.slice(8, 10)) }))).toBe(tomorrow);
    expect(p({ relativo: "mañana", dia_mes: Number(plus(today, 5).slice(8, 10)) })).toMatchObject({
      kind: "question",
      reason: "offset_mismatch",
    });
    expect(p({ relativo: "mañana", dia_semana: WEEKDAYS[(dow(tomorrow) + 2) % 7] })).toMatchObject({
      kind: "question",
      reason: "weekday_mismatch",
    });
  });

  it.each([
    { dia_mes: 0 },
    { dia_mes: 32 },
    { dia_mes: "5 de la tarde" },
    { dia_mes: 16.5 },
    { dia_semana: "juebes" },
    { dia_semana: 4 },
    { mes: 11 },
    { mes: 13, dia_mes: 2 },
    { relativo: "ayer" },
    { relativo: "hoy", en_dias: 2 },
    { en_dias: 0 },
    { en_dias: 61 },
  ])("pieza inválida o combinación imposible → pregunta: %j", (body) => {
    expect(p(body)).toMatchObject({ kind: "question", reason: "unclear" });
  });

  it("sin piezas (o solo proximo / null) → undefined: manda date", () => {
    expect(p({})).toBeUndefined();
    expect(p({ proximo: true })).toBeUndefined();
    expect(p({ dia_semana: null, dia_mes: null, mes: null, relativo: null, en_dias: null })).toBeUndefined();
  });
});

// ── 3c. CROSS-CHECK: the verifier's table (hoy = sábado 10, 12:00) ─────────────

describe("comprobación cruzada piezas ↔ fecha_dicha (tabla del verificador)", () => {
  const ctx = { todayIso: "2026-10-10", todayStillOpen: true };
  const check = (pieces: Record<string, unknown>, fecha_dicha: string, sent?: string) =>
    resolveFechaPiezas({ ...pieces, fecha_dicha }, ctx, sent);

  it.each([
    ["en 2 días", { en_dias: 2 }, "2026-10-12"],
    ["en 10 días", { en_dias: 10 }, "2026-10-20"],
    ["el jueves 5 de la tarde", { dia_semana: "jueves" }, "2026-10-15"],
    ["el martes a las veinte", { dia_semana: "martes" }, "2026-10-13"],
    ["el jueves a las veintidós", { dia_semana: "jueves" }, "2026-10-15"],
    ["dentro de una semana", { en_dias: 7 }, "2026-10-17"],
    ["dentro de un día", { en_dias: 1 }, "2026-10-11"],
    ["martes veinte y siete", { dia_semana: "martes", dia_mes: 27 }, "2026-10-27"],
    ["el martes ventisiete", { dia_semana: "martes", dia_mes: 27 }, "2026-10-27"],
    ["el martes después de las 20", { dia_semana: "martes" }, "2026-10-13"],
    ["el martes a eso de las 20", { dia_semana: "martes" }, "2026-10-13"],
    ["mañana mismo", { relativo: "mañana" }, "2026-10-11"],
    ["el jueves a primera hora", { dia_semana: "jueves" }, "2026-10-15"],
    ["jueves tarde", { dia_semana: "jueves" }, "2026-10-15"],
    ["el martes si se puede", { dia_semana: "martes" }, "2026-10-13"],
    ["quería el viernes", { dia_semana: "viernes" }, "2026-10-16"],
    ["el sábado, gracias", { dia_semana: "sábado" }, "2026-10-10"],
    ["el viernes que viene", { dia_semana: "viernes", proximo: true }, "2026-10-16"],
    ["cuando puedas el martes, que me pilla bien", { dia_semana: "martes" }, "2026-10-13"],
  ])("«%s» con las piezas correctas → %s, sin preguntar", (said, pieces, date) => {
    expect(check(pieces, said)).toEqual({ kind: "date", date });
  });

  it.each([
    ["en 2 días", { dia_mes: 2 }],
    ["el jueves 5 de la tarde", { dia_semana: "jueves", dia_mes: 5 }],
    ["el martes a las veinte", { dia_semana: "martes", dia_mes: 20 }],
    ["el jueves a las veintidós", { dia_semana: "jueves", dia_mes: 22 }],
    ["mañana", { relativo: "pasado_mañana" }],
    ["el viernes", { dia_semana: "jueves" }],
  ])("«%s» con piezas que dicen OTRO día → pregunta (cross_check)", (said, pieces) => {
    const r = check(pieces, said);
    expect(r?.kind).toBe("question");
  });

  it.each([
    ["el 16 o el 17", { dia_mes: 16 }, "multiple"],
    ["martes o miércoles", { dia_semana: "martes" }, "multiple"],
    ["ayer", { relativo: "hoy" }, "past_word"],
    ["el lunes pasado", { dia_semana: "lunes" }, "past_word"],
    ["jueves 16", { dia_semana: "viernes", dia_mes: 16 }, "weekday_mismatch"],
  ])("«%s»: el texto entendido con confianza manda preguntar (%s)", (said, pieces, reason) => {
    expect(check(pieces, said)).toMatchObject({ kind: "question", reason });
  });

  it("cross_check: mensaje con los dos días", () => {
    const r = check({ dia_semana: "jueves" }, "el viernes") as Extract<FechaResolution, { kind: "question" }>;
    expect(r.reason).toBe("cross_check");
    expect(balancedDateQuestionMessage(r, "2026-10-10")).toBe(
      "¿Me confirmas el día: el jueves quince o el viernes dieciséis?",
    );
  });

  it("solo fecha_dicha (prompt viejo) y date: el texto solo puede objetar", () => {
    expect(check({}, "el viernes", "2026-10-16")).toBeUndefined();
    expect(check({}, "Jueves 16", "2026-10-16")).toMatchObject({ reason: "weekday_mismatch" });
    expect(check({}, "el jueves", "2026-10-16")).toMatchObject({ reason: "cross_check" });
    expect(check({}, "cuando puedas", "2026-10-16")).toBeUndefined();
  });
});

// ── 4. EVERY MESSAGE WITH A DATE NAMES THE DAY; THE SUMMARY IS THE BOOKING ────


describe("horas en palabras sin ambigüedad (12-13 h)", () => {
  it.each([
    ["2026-10-16 12:00:00", "el viernes dieciséis de octubre a las doce del mediodía"],
    ["2026-10-16 12:30:00", "el viernes dieciséis de octubre a las doce y media del mediodía"],
    ["2026-10-16 13:00:00", "el viernes dieciséis de octubre a la una del mediodía"],
    ["2026-10-16 13:30:00", "el viernes dieciséis de octubre a la una y media del mediodía"],
    ["2026-10-16 10:00:00", "el viernes dieciséis de octubre a las diez de la mañana"],
    ["2026-10-16 18:00:00", "el viernes dieciséis de octubre a las seis de la tarde"],
  ])("%s → «%s»", (reservationDate, when) => {
    expect(balancedLockSummaryEs({ serviceId: 2, reservationDate, employeeName: "Olga" })).toBe(
      `Te resumo: corte y barba, ${when}, con Olga`,
    );
    expect(balancedConfirmedSpokenEs(bookingConfirmedMessage(reservationDate))).toBe(
      `Listo, la reserva queda confirmada para ${when}.`,
    );
  });
});


// ── 5. FAIL-CLOSED (review 2026-10-10): never a wrong date without asking ────

describe("fecha_dicha · fail-closed (revisión del verificador)", () => {
  const SAT_10 = { todayIso: "2026-10-10", todayStillOpen: true };
  const r = (said: string) => resolveFechaDicha(said, SAT_10);

  it.each([
    ["martes veinte y siete", "2026-10-27"],
    ["el martes veintisiete", "2026-10-27"],
    ["el martes ventisiete", "2026-10-27"],
    ["el martes beintisiete", "2026-10-27"],
    ["el martes vientisiete", "2026-10-27"],
    ["jueves veinte y dos", "2026-10-22"],
    ["viernes diez y seis", "2026-10-16"],
    ["viernes diesiseis", "2026-10-16"],
    ["el sábado treinta y uno", "2026-10-31"],
    ["el treinta y uno de octubre", "2026-10-31"],
  ])("números en letra y variantes de STT: «%s» → %s", (said, date) => {
    expect(r(said)).toEqual({ kind: "date", date });
  });

  it.each([
    "el martes después de las 20",
    "el martes a eso de las 20",
    "el martes a partir de las seis",
    "el martes antes de las 11",
    "el martes tipo las 5",
    "el martes sobre la una",
    "el martes a la una y media",
    "el martes entre las 5 y las 7",
    "el martes a las 18:30",
    "el martes por la tarde",
  ])("las horas se recortan, no son el día: «%s» → martes 13", (said) => {
    expect(r(said)).toEqual({ kind: "date", date: "2026-10-13" });
  });

  it.each([
    "el martes ventisiet",
    "el martes veintisiet",
    "el martes dieci seis",
    "el martes cuando sea",
    "el martes o cuando puedas",
    "martes 13 o así",
  ])("una palabra que no se entiende entera → pregunta, nunca se ignora: «%s»", (said) => {
    expect(r(said)).toMatchObject({ kind: "question", reason: "unclear" });
  });

  it.each(["el 16 o el 17", "martes o miércoles", "hoy o mañana", "el jueves o el viernes", "el martes 13 o el 20"])(
    "dos días en el mismo texto → pregunta: «%s»",
    (said) => {
      const q = r(said) as Extract<FechaResolution, { kind: "question" }>;
      expect(q).toMatchObject({ kind: "question", reason: "multiple" });
      expect(balancedDateQuestionMessage(q, "2026-10-10")).toBe(
        "¿Qué día prefieres? Dime solo uno: el día de la semana o la fecha.",
      );
    },
  );

  it.each(["ayer", "anteayer", "el lunes pasado", "la semana pasada", "hace dos días"])(
    "fechas pasadas → pregunta: «%s»",
    (said) => {
      const q = r(said) as Extract<FechaResolution, { kind: "question" }>;
      expect(q).toMatchObject({ kind: "question", reason: "past_word" });
      expect(balancedDateQuestionMessage(q, "2026-10-10")).toBe(
        "Ese día ya ha pasado. ¿Qué día te viene bien? Dime el día de la semana o la fecha.",
      );
    },
  );

  it("«pasado mañana» sigue siendo futuro, y «mañana por la mañana» es mañana", () => {
    expect(r("pasado mañana")).toEqual({ kind: "date", date: "2026-10-12" });
    expect(r("mañana por la mañana")).toEqual({ kind: "date", date: "2026-10-11" });
    expect(r("el martes por la mañana a las diez")).toEqual({ kind: "date", date: "2026-10-13" });
  });

  it("ilegible → mensaje corto para leer tal cual", () => {
    const q = r("ventisiet") as Extract<FechaResolution, { kind: "question" }>;
    expect(balancedDateQuestionMessage(q, "2026-10-10")).toBe(
      "¿Qué día te viene bien? Dime el día de la semana o la fecha.",
    );
  });
});

// ── 6. 15 MESSAGES WRITTEN LITERALLY (independent of withSpokenDayEs) ─────────


// ── 7. THE LOG: a date that disagrees with the pieces is recorded ─────────────

describe("logger.warn de discrepancia entre date y las piezas", () => {
  function service(warn: (obj: unknown, msg?: string) => void): BalancedAvailabilityService {
    const day = (date: string): AgendaDay => ({
      date,
      serviceId: "1",
      employees: [RAMON],
      free: [{ ...RAMON, date: `${date} 14:00:00`, slots: [{ start: `${date} 17:00:00`, end: `${date} 17:00:00` }] }],
    }) as unknown as AgendaDay;
    const agenda: AgendaReader = {
      read: async (date): Promise<AgendaRead> => ({ day: day(date), outcome: "miss", ageMs: 0 }),
      readFresh: async (date) => ({ day: day(date), outcome: "bypass", ageMs: 0 }),
      invalidate: () => 0,
    };
    return new BalancedAvailabilityService({
      agenda,
      options: new MemoryBalancedOptionStore({ ttlSeconds: 3_600, maxEntries: 16 }),
      slotAuthorization: new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds: 600 }),
      offerStore: new MemoryVoiceOfferStore({ ttlSeconds: 3_600, maxEntries: 16 }),
      scanDeadlineMs: 500,
      logger: { warn, info: () => undefined },
    });
  }
  const NOW = Date.parse("2026-10-10T10:00:00Z"); // Saturday 10, 12:00 Madrid
  const body = { conversation_id: "conv_test_fd_log", service_id: 1, date: "2026-10-15", time_period: "afternoon" };

  it("date 15 con piezas viernes 16: busca el 16 y deja un warn con lo enviado y lo usado", async () => {
    const warns: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const svc = service((obj, msg) => warns.push({ obj: obj as Record<string, unknown>, ...(msg !== undefined ? { msg } : {}) }));
    const result = await svc.discover(body, NOW, {
      fechaPiezas: { dia_semana: "viernes", dia_mes: 16, fecha_dicha: "el viernes 16" },
    });
    expect(result.outcome).toBe("options_available");
    expect(result.date_corrected_from).toBe("2026-10-15");
    const warn = warns.find((w) => w.msg?.includes("the day pieces disagreed with the date sent"));
    expect(warn, JSON.stringify(warns)).toBeDefined();
    expect(warn!.obj).toMatchObject({
      conversation_id: "conv_test_fd_log",
      field: "date",
      sent_date: "2026-10-15",
      used_date: "2026-10-16",
      fecha_dicha: "el viernes 16",
      piezas: { dia_semana: "viernes", dia_mes: 16 },
    });
  });

  it("date que coincide con las piezas: ningún warn de discrepancia", async () => {
    const msgs: string[] = [];
    const svc = service((_obj, msg) => msgs.push(String(msg)));
    await svc.discover({ ...body, date: "2026-10-16" }, NOW, { fechaPiezas: { dia_semana: "viernes", dia_mes: 16 } });
    expect(msgs.some((m) => m.includes("disagreed with the date sent"))).toBe(false);
  });

  it("pregunta (date_conflict): warn con el motivo", async () => {
    const warns: Array<Record<string, unknown>> = [];
    const svc = service((obj) => warns.push(obj as Record<string, unknown>));
    await svc.discover(body, NOW, { fechaPiezas: { dia_semana: "jueves", dia_mes: 16 } });
    expect(warns.some((w) => w["date_issue"] === "weekday_mismatch")).toBe(true);
  });
});
