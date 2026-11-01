import { describe, it, expect } from "vitest";

import { resolveDayWindows, freeSlotStarts } from "../../src/callEngine/calendar/resolveAvailability.js";
import type { OperationalCalendar, SeasonalVenueSchedule } from "../../src/callEngine/calendar/model.js";
import { baseSyntheticVenue, extendedSyntheticVenue, ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { demoSalonVenue, BOOKING_DEMO_TODAY, BOOKING_AUGUST_2026_PERIOD_ID } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { syntheticAudit } from "../../src/callEngine/fixtures/syntheticHolidays.js";
import { addDays, formatHHmm, parseHHmm } from "../../src/callEngine/domain/time.js";

/**
 * step 14 · W3 — la anulación estacional fechada (nivel 5 de precedencia).
 *
 * Lo que más importa aquí no es que agosto funcione, sino que AÑADIR un nivel
 * no cambie absolutamente nada en los calendarios que no declaran ninguna
 * temporada: eso es lo que sostienen los escenarios congelados A01..A15 y las
 * dos suites de calendario que ya existían.
 */

function windowsAsText(cal: OperationalCalendar, employeeId: number, dateISO: string): string {
  const r = resolveDayWindows(cal, employeeId, dateISO);
  const w = r.windows.map((i) => `${formatHHmm(i.startMinutes)}-${formatHHmm(i.endMinutes)}`).join(",");
  return `${r.appliedLevel}|${w}`;
}

/** Todas las fechas de un rango, para barrer semanas enteras en vez de un día suelto. */
function dateRange(from: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => addDays(from, i));
}

describe("nivel 5 estacional: un calendario que no lo declara resuelve exactamente igual que antes", () => {
  it("baseSyntheticVenue() y extendedSyntheticVenue() no declaran ninguna temporada", () => {
    expect(baseSyntheticVenue().seasonalSchedules).toBeUndefined();
    expect(extendedSyntheticVenue().seasonalSchedules).toBeUndefined();
  });

  it("los valores concretos de las fixtures existentes siguen siendo los de siempre (lunes y martes 09:00-17:00 con pausa)", () => {
    const base = baseSyntheticVenue();
    // 2026-08-03 es lunes; 2026-08-04, martes.
    expect(windowsAsText(base, ALEX_ID, "2026-08-03")).toBe("weekly_schedule|09:00-13:00,14:00-17:00");
    expect(windowsAsText(base, DANI_ID, "2026-08-04")).toBe("weekly_schedule|09:00-13:00,14:00-17:00");
    // Miércoles: la fixture base no declara horario, así que sigue cerrada.
    expect(windowsAsText(base, ALEX_ID, "2026-08-05")).toBe("none|");

    const extended = extendedSyntheticVenue();
    expect(windowsAsText(extended, NEREA_ID, "2026-08-05")).toBe("weekly_schedule|10:00-16:00");
    // Con las reservas sintéticas del lunes ya restadas (el nivel que se
    // reporta sigue siendo `weekly_schedule`, porque la pausa ya lo había
    // reclamado antes que las reservas: es el comportamiento previo, no uno
    // nuevo).
    expect(windowsAsText(extended, ALEX_ID, "2026-08-03")).toBe("weekly_schedule|10:00-13:00,14:00-17:00");
  });

  it("declarar `seasonalSchedules: []` da el MISMO resultado que no declararlo, en 60 días y para los tres empleados", () => {
    const withoutField = extendedSyntheticVenue();
    const withEmptyArray: OperationalCalendar = { ...withoutField, seasonalSchedules: [] };
    for (const date of dateRange("2026-07-20", 60)) {
      for (const employeeId of [ALEX_ID, DANI_ID, NEREA_ID]) {
        expect(windowsAsText(withEmptyArray, employeeId, date), `${date}/${String(employeeId)}`).toBe(
          windowsAsText(withoutField, employeeId, date),
        );
      }
    }
  });

  it("una temporada NO aprobada es completamente inerte (fallo cerrado), igual que una regla de local pendiente", () => {
    const withoutField = extendedSyntheticVenue();
    for (const approval of ["pending_review", "rejected"] as const) {
      const pending: SeasonalVenueSchedule[] = [1, 2].map((dayOfWeek) => ({
        id: `temporada-inerte-${String(dayOfWeek)}`,
        periodId: "temporada-inerte",
        label: "Temporada duplicada sin confirmar",
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        dayOfWeek,
        workDayStart: "11:00",
        workDayEnd: "12:00",
        recurrence: "does_not_repeat",
        duplicatedFromPeriodId: BOOKING_AUGUST_2026_PERIOD_ID,
        source: "manual_override",
        approval,
        audit: syntheticAudit(),
      }));
      const cal: OperationalCalendar = { ...withoutField, seasonalSchedules: pending };
      for (const date of dateRange("2026-08-01", 31)) {
        for (const employeeId of [ALEX_ID, DANI_ID, NEREA_ID]) {
          expect(windowsAsText(cal, employeeId, date), `${approval} ${date}`).toBe(
            windowsAsText(withoutField, employeeId, date),
          );
        }
      }
    }
  });
});

describe("nivel 5 estacional: agosto en el calendario de Demo Salon", () => {
  const cal = demoSalonVenue();

  it("dentro de agosto, de martes a viernes el local cierra a las 17:30 y nadie puede pasar de ahí", () => {
    // Jueves 2026-08-06, sin reservas de muestra.
    const alex = resolveDayWindows(cal, ALEX_ID, "2026-08-06");
    expect(alex.appliedLevel).toBe("seasonal_venue_schedule");
    const last = alex.windows[alex.windows.length - 1];
    expect(last?.endMinutes).toBe(parseHHmm("17:30"));
    expect(Math.max(...freeSlotStarts(cal, ALEX_ID, "2026-08-06"))).toBe(parseHHmm("17:00"));
  });

  it("dentro de agosto, el lunes sigue cerrado para todo el mundo, y la razón es la temporada", () => {
    for (const employeeId of [ALEX_ID, DANI_ID, NEREA_ID]) {
      const r = resolveDayWindows(cal, employeeId, "2026-08-03");
      expect(r.windows).toEqual([]);
      expect(r.appliedLevel).toBe("seasonal_venue_schedule");
      expect(r.notes.join(" ")).toContain("declares no hours");
    }
  });

  it("el domingo también sigue cerrado dentro de la temporada", () => {
    expect(resolveDayWindows(cal, ALEX_ID, "2026-08-09").windows).toEqual([]);
  });

  it("el sábado de agosto mantiene 09:00-14:00", () => {
    const r = resolveDayWindows(cal, DANI_ID, "2026-08-08");
    expect(r.windows).toEqual([{ startMinutes: parseHHmm("09:00"), endMinutes: parseHHmm("14:00") }]);
  });

  it("una anulación puntual de un empleado NO abre el local más allá de la temporada", () => {
    const withOverride: OperationalCalendar = {
      ...cal,
      overrides: [
        {
          id: "override-tarde-agosto",
          employeeId: ALEX_ID,
          date: "2026-08-06",
          workDayStart: "09:00",
          workDayEnd: "21:00",
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
    };
    const r = resolveDayWindows(withOverride, ALEX_ID, "2026-08-06");
    expect(r.windows).toEqual([{ startMinutes: parseHHmm("09:00"), endMinutes: parseHHmm("17:30") }]);
    expect(r.notes.join(" ")).toContain("seasonal_venue_schedule clamps");
  });

  it("la temporada tiene FECHAS: el 1 de septiembre vuelve el horario normal, sin que nadie tenga que retirarla", () => {
    // Martes 2026-09-01, primer día fuera de la temporada. El horario que
    // vuelve es el ORDINARIO DEL LOCAL, 09:30-19:30, y es el mismo para todo
    // el equipo (step 15): antes esta prueba esperaba un 10:00-18:00 propio
    // de Nerea que nunca fue una verdad del negocio — era una diferencia
    // individual inventada por la fixture, y ya no existe.
    const r = resolveDayWindows(cal, NEREA_ID, "2026-09-01");
    expect(r.windows).toEqual([{ startMinutes: parseHHmm("09:30"), endMinutes: parseHHmm("19:30") }]);
    expect(r.appliedLevel).not.toBe("seasonal_venue_schedule");
    // Y el 31 de julio, el día anterior al inicio, tampoco se aplicaba.
    expect(resolveDayWindows(cal, NEREA_ID, "2026-07-31").windows).toEqual([
      { startMinutes: parseHHmm("09:30"), endMinutes: parseHHmm("19:30") },
    ]);
  });

  it("no se repite sola: cada fila declara `recurrence: 'does_not_repeat'` y agosto de 2027 no se ve afectado", () => {
    for (const row of cal.seasonalSchedules ?? []) {
      expect(row.recurrence).toBe("does_not_repeat");
      expect(row.periodId).toBe(BOOKING_AUGUST_2026_PERIOD_ID);
      expect(row.startDate).toBe("2026-08-01");
      expect(row.endDate).toBe("2026-08-31");
    }
    // Martes 2027-08-03: fuera del rango, luego horario normal, no el de
    // agosto. Es un único tramo 09:30-19:30 (step 15): la pausa 14:00-15:00
    // que partía este día en dos venía de una fila de empleado inventada por
    // la fixture; el negocio nunca declaró descansos individuales. Lo que
    // esta prueba defiende no cambia: agosto de 2027 NO hereda el horario de
    // agosto de 2026.
    const r = resolveDayWindows(cal, ALEX_ID, "2027-08-03");
    expect(r.windows).toEqual([{ startMinutes: parseHHmm("09:30"), endMinutes: parseHHmm("19:30") }]);
  });

  it("duplicar para 2027 y dejarlo sin confirmar no cambia nada hasta que alguien lo aprueba", () => {
    const duplicated: SeasonalVenueSchedule[] = (cal.seasonalSchedules ?? []).map((row) => ({
      ...row,
      id: row.id.replace("2026", "2027"),
      periodId: "temporada-agosto-2027",
      label: "Horario de agosto de 2027",
      startDate: "2027-08-01",
      endDate: "2027-08-31",
      duplicatedFromPeriodId: row.periodId,
      approval: "pending_review",
    }));
    const pending: OperationalCalendar = { ...cal, seasonalSchedules: [...(cal.seasonalSchedules ?? []), ...duplicated] };
    expect(windowsAsText(pending, ALEX_ID, "2027-08-03")).toBe(windowsAsText(cal, ALEX_ID, "2027-08-03"));

    const approved: OperationalCalendar = {
      ...cal,
      seasonalSchedules: [...(cal.seasonalSchedules ?? []), ...duplicated.map((r) => ({ ...r, approval: "approved" as const }))],
    };
    // Aprobada, 2027 pasa a cerrar a las 17:30 igual que 2026.
    const r = resolveDayWindows(approved, ALEX_ID, "2027-08-03");
    expect(r.windows[r.windows.length - 1]?.endMinutes).toBe(parseHHmm("17:30"));
  });

  it("un cierre total del local (nivel 1) y un festivo aprobado (nivel 2) siguen ganando a la temporada", () => {
    const closed: OperationalCalendar = {
      ...cal,
      closures: [
        {
          id: "cierre-en-agosto",
          kind: "full_closure",
          startDate: BOOKING_DEMO_TODAY,
          endDate: BOOKING_DEMO_TODAY,
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
    };
    const r1 = resolveDayWindows(closed, ALEX_ID, BOOKING_DEMO_TODAY);
    expect(r1.windows).toEqual([]);
    expect(r1.appliedLevel).toBe("venue_closure");

    const special: OperationalCalendar = {
      ...cal,
      venueRules: [
        {
          id: "apertura-especial-en-agosto",
          kind: "special_opening",
          scope: "venue",
          date: "2026-08-06",
          closed: false,
          specialOpen: "18:00",
          specialClose: "20:00",
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
    };
    const r2 = resolveDayWindows(special, ALEX_ID, "2026-08-06");
    expect(r2.appliedLevel).toBe("venue_rule");
    // La apertura especial aprobada manda de 18:00 a 20:00 y esas son las
    // horas del día (step 15). Antes esta prueba esperaba 18:00-19:30: ese
    // 19:30 no salía de la regla ni del horario del local, sino de una fila
    // de empleado que duplicaba el cierre ordinario y recortaba la apertura
    // por detrás. Sin fila propia, `resolveAvailability.ts` adopta la ventana
    // de la regla como horas del empleado, que es justo lo que una apertura
    // especial significa.
    expect(r2.windows).toEqual([{ startMinutes: parseHHmm("18:00"), endMinutes: parseHHmm("20:00") }]);
  });

  it("dos temporadas aprobadas que se solapan se resuelven de forma determinista, no al azar", () => {
    const other: SeasonalVenueSchedule[] = [
      {
        id: "aaa-otra-temporada",
        periodId: "aaa-temporada-solapada",
        label: "Temporada solapada",
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        dayOfWeek: 4,
        workDayStart: "11:00",
        workDayEnd: "12:00",
        recurrence: "does_not_repeat",
        source: "manual_override",
        approval: "approved",
        audit: syntheticAudit(),
      },
    ];
    const overlapped: OperationalCalendar = { ...cal, seasonalSchedules: [...(cal.seasonalSchedules ?? []), ...other] };
    const first = windowsAsText(overlapped, ALEX_ID, "2026-08-06");
    for (let i = 0; i < 5; i += 1) {
      expect(windowsAsText(overlapped, ALEX_ID, "2026-08-06")).toBe(first);
    }
    // Gana el `periodId` menor ("aaa-..."), que es la regla documentada.
    expect(first).toContain("11:00-12:00");
  });
});
