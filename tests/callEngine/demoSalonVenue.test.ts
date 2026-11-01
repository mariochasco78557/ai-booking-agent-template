import { describe, it, expect } from "vitest";

import { resolveDayWindows, freeSlotStarts } from "../../src/callEngine/calendar/resolveAvailability.js";
import { canPerform } from "../../src/callEngine/capabilities.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import { chooseProfessional } from "../../src/callEngine/allocation/anyProfessional.js";
import { baseSyntheticVenue, extendedSyntheticVenue, ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { demoSalonVenue, BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { syntheticAudit } from "../../src/callEngine/fixtures/syntheticHolidays.js";
import { addDays, dayOfWeek, parseHHmm } from "../../src/callEngine/domain/time.js";

/**
 * step 14 · W2 — la fixture de la consola y de la demo.
 *
 * El horario de apertura es el declarado por el negocio; las personas, sus
 * capacidades y todas las citas son inventadas. Lo que se comprueba aquí es
 * que el horario del LOCAL actúa de verdad como cota exterior — no como un
 * párrafo de documentación.
 */

const EMPLOYEES = [ALEX_ID, DANI_ID, NEREA_ID];

describe("demoSalonVenue(): el horario del local manda", () => {
  const cal = demoSalonVenue();

  it("el lunes está cerrado para todos, dentro y fuera de agosto", () => {
    for (const monday of ["2026-08-03", "2026-09-07", "2026-12-07"]) {
      expect(dayOfWeek(monday)).toBe(1);
      for (const employeeId of EMPLOYEES) {
        expect(resolveDayWindows(cal, employeeId, monday).windows, `${monday}/${String(employeeId)}`).toEqual([]);
        expect(freeSlotStarts(cal, employeeId, monday)).toEqual([]);
      }
    }
  });

  it("el domingo está cerrado para todos", () => {
    for (const sunday of ["2026-08-09", "2026-09-06"]) {
      expect(dayOfWeek(sunday)).toBe(0);
      for (const employeeId of EMPLOYEES) {
        expect(resolveDayWindows(cal, employeeId, sunday).windows).toEqual([]);
      }
    }
  });

  it("fuera de agosto, de martes a viernes nadie empieza antes de las 09:30 ni termina después de las 19:30", () => {
    for (const date of ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]) {
      for (const employeeId of EMPLOYEES) {
        const { windows } = resolveDayWindows(cal, employeeId, date);
        expect(windows.length).toBeGreaterThan(0);
        for (const w of windows) {
          expect(w.startMinutes).toBeGreaterThanOrEqual(parseHHmm("09:30"));
          expect(w.endMinutes).toBeLessThanOrEqual(parseHHmm("19:30"));
        }
      }
    }
  });

  it("el sábado se trabaja de 09:00 a 14:00 y ni un minuto más", () => {
    const saturday = "2026-09-12";
    expect(dayOfWeek(saturday)).toBe(6);
    for (const employeeId of EMPLOYEES) {
      expect(resolveDayWindows(cal, employeeId, saturday).windows).toEqual([
        { startMinutes: parseHHmm("09:00"), endMinutes: parseHHmm("14:00") },
      ]);
    }
  });

  it("un horario de empleado más largo que el del local NO abre el local (cota exterior, no respaldo)", () => {
    // Nerea declara 10:00-18:00 los días laborables; el sábado el local cierra
    // a las 14:00 y ella no puede pasar de ahí.
    const withLongerEmployeeDay = {
      ...cal,
      weeklySchedules: [
        ...cal.weeklySchedules.filter((w) => !(w.ownerKind === "employee" && w.employeeId === NEREA_ID && w.dayOfWeek === 6)),
        { ownerKind: "employee" as const, employeeId: NEREA_ID, dayOfWeek: 6, workDayStart: "08:00", workDayEnd: "22:00" },
      ],
    };
    expect(resolveDayWindows(withLongerEmployeeDay, NEREA_ID, "2026-09-12").windows).toEqual([
      { startMinutes: parseHHmm("09:00"), endMinutes: parseHHmm("14:00") },
    ]);
  });

  it("todos los profesionales son sintéticos y la matriz de capacidades filtra de verdad", () => {
    expect(cal.professionals.every((p) => p.synthetic)).toBe(true);
    expect(cal.professionals.every((p) => p.displayName.includes("sintétic"))).toBe(true);
    expect(canPerform(cal, ALEX_ID, 0)).toBe(true);
    expect(canPerform(cal, NEREA_ID, 0)).toBe(false);
    expect(canPerform(cal, NEREA_ID, 1)).toBe(true);
  });

  it("hay citas de muestra en el 'hoy' sintético, y todas caben dentro del horario de ese día", () => {
    expect(BOOKING_DEMO_TODAY).toBe("2026-08-04");
    expect(dayOfWeek(BOOKING_DEMO_TODAY)).toBe(2); // martes
    expect(BOOKING_DEMO_NOW_MINUTES).toBe(9 * 60);

    const today = cal.reservations.filter((r) => r.date === BOOKING_DEMO_TODAY);
    expect(today.length).toBeGreaterThanOrEqual(5);
    expect(today.some((r) => r.status === "cancelled")).toBe(true);
    expect(cal.reservations.every((r) => r.synthetic)).toBe(true);
    for (const r of today) {
      expect(r.startMinutes).toBeGreaterThanOrEqual(parseHHmm("09:00"));
      expect(r.endMinutes).toBeLessThanOrEqual(parseHHmm("17:30"));
    }
  });

  it("deja libre la franja 10:00-12:00 de Álex, que es donde reservan la consola y la demo", () => {
    const free = freeSlotStarts(cal, ALEX_ID, BOOKING_DEMO_TODAY);
    expect(free).toContain(parseHHmm("10:00"));
    expect(free).toContain(parseHHmm("11:00"));
    expect(free).toContain(parseHHmm("11:30"));
  });

  it("no toca ninguna de las dos fixtures anteriores", () => {
    const base = baseSyntheticVenue();
    const extended = extendedSyntheticVenue();
    expect(base.professionals.length).toBe(2);
    expect(base.weeklySchedules.length).toBe(4);
    expect(base.weeklySchedules.every((w) => w.ownerKind === "employee")).toBe(true);
    expect(base.reservations).toEqual([]);
    expect(extended.professionals.length).toBe(3);
    expect(extended.weeklySchedules.every((w) => w.ownerKind === "employee")).toBe(true);
    expect(extended.reservations.length).toBe(4);
    expect(extended.reservations.every((r) => r.date === "2026-08-03")).toBe(true);
  });
});

/**
 * step 15 — el horario es del LOCAL, y es el mismo para las tres personas.
 *
 * El negocio declaró UN horario, no tres: martes-viernes 09:00-17:30 en
 * agosto y 09:30-19:30 el resto del año, sábados 09:00-14:00, lunes y domingo
 * cerrado. La fixture llegó a declarar además una fila por empleado con horas
 * y descansos propios que nadie había dicho nunca; el efecto colateral era que
 * la temporada de agosto no podía ampliar la mañana (el nivel 5 solo interseca
 * contra un horario propio del empleado). Estas pruebas fijan la verdad nueva:
 * mismas ventanas para todos, día a día.
 */
describe("demoSalonVenue(): el horario es el mismo para todo el equipo", () => {
  const cal = demoSalonVenue();
  /** La misma agenda SIN las citas de muestra: aquí se comprueba el horario, no quién tiene hueco. */
  const clean: CalendarWithCapabilities = { ...cal, reservations: [] };

  function windowsOf(calendar: CalendarWithCapabilities, employeeId: number, dateISO: string): { startMinutes: number; endMinutes: number }[] {
    return resolveDayWindows(calendar, employeeId, dateISO).windows;
  }

  it("un martes de agosto (2026-08-04) los tres trabajan de 09:00 a 17:30", () => {
    expect(dayOfWeek("2026-08-04")).toBe(2);
    for (const employeeId of EMPLOYEES) {
      expect(windowsOf(clean, employeeId, "2026-08-04"), String(employeeId)).toEqual([
        { startMinutes: parseHHmm("09:00"), endMinutes: parseHHmm("17:30") },
      ]);
      const free = freeSlotStarts(clean, employeeId, "2026-08-04");
      // Una cita de 30 minutos aún cabe empezando a las 17:00; a las 17:30 ya
      // no, porque a esa hora el local cierra en agosto.
      expect(free).toContain(parseHHmm("17:00"));
      expect(free).not.toContain(parseHHmm("17:30"));
      expect(free).toContain(parseHHmm("09:00"));
    }
  });

  it("un martes fuera de agosto (2026-09-01) los tres trabajan de 09:30 a 19:30", () => {
    expect(dayOfWeek("2026-09-01")).toBe(2);
    for (const employeeId of EMPLOYEES) {
      expect(windowsOf(clean, employeeId, "2026-09-01"), String(employeeId)).toEqual([
        { startMinutes: parseHHmm("09:30"), endMinutes: parseHHmm("19:30") },
      ]);
      const free = freeSlotStarts(clean, employeeId, "2026-09-01");
      expect(free[0]).toBe(parseHHmm("09:30"));
      expect(free).toContain(parseHHmm("19:00"));
      expect(free).not.toContain(parseHHmm("19:30"));
    }
  });

  it("el sábado son 09:00-14:00 para los tres, dentro y fuera de agosto", () => {
    for (const saturday of ["2026-08-08", "2026-09-12"]) {
      expect(dayOfWeek(saturday)).toBe(6);
      for (const employeeId of EMPLOYEES) {
        expect(windowsOf(clean, employeeId, saturday), `${saturday}/${String(employeeId)}`).toEqual([
          { startMinutes: parseHHmm("09:00"), endMinutes: parseHHmm("14:00") },
        ]);
        const free = freeSlotStarts(clean, employeeId, saturday);
        expect(free[0]).toBe(parseHHmm("09:00"));
        expect(free).toContain(parseHHmm("13:30"));
        expect(free).not.toContain(parseHHmm("14:00"));
      }
    }
  });

  it("lunes y domingo están cerrados para los tres, dentro y fuera de agosto, sin ningún inicio libre", () => {
    // Dentro de agosto: lunes 2026-08-03 y domingo 2026-08-09.
    // Fuera de agosto: lunes 2026-09-07 y domingo 2026-09-06.
    for (const closedDay of ["2026-08-03", "2026-08-09", "2026-09-07", "2026-09-06"]) {
      expect([0, 1]).toContain(dayOfWeek(closedDay));
      for (const employeeId of EMPLOYEES) {
        expect(windowsOf(clean, employeeId, closedDay), `${closedDay}/${String(employeeId)}`).toEqual([]);
        expect(freeSlotStarts(clean, employeeId, closedDay), `${closedDay}/${String(employeeId)}`).toEqual([]);
      }
    }
  });

  it("en 60 días seguidos, las ventanas de los tres son idénticas día a día", () => {
    // Barrido a caballo del final de la temporada (agosto) y de su vuelta al
    // horario ordinario, que es donde una diferencia individual asomaría.
    for (let i = 0; i < 60; i += 1) {
      const date = addDays("2026-07-20", i);
      const alex = JSON.stringify(windowsOf(clean, ALEX_ID, date));
      expect(JSON.stringify(windowsOf(clean, DANI_ID, date)), `${date} Dani`).toBe(alex);
      expect(JSON.stringify(windowsOf(clean, NEREA_ID, date)), `${date} Nerea`).toBe(alex);
    }
  });

  it("no queda ni una sola fila de horario propia de un empleado: todas son del local", () => {
    expect(cal.weeklySchedules.length).toBeGreaterThan(0);
    expect(cal.weeklySchedules.every((w) => w.ownerKind === "venue")).toBe(true);
  });

  it("las capacidades SÍ siguen diferenciando a las personas, aunque el horario ya no lo haga", () => {
    expect(canPerform(cal, ALEX_ID, 0)).toBe(true);
    expect(canPerform(cal, DANI_ID, 0)).toBe(true);
    expect(canPerform(cal, NEREA_ID, 0)).toBe(false);
  });

  it("una ausencia aprobada de una persona reduce SOLO su disponibilidad; las otras dos quedan intactas", () => {
    const withAbsence: CalendarWithCapabilities = {
      ...clean,
      absences: [
        {
          id: "ausencia-solo-de-dani",
          employeeId: DANI_ID,
          kind: "vacation",
          startDate: "2026-09-01",
          endDate: "2026-09-01",
          allDay: true,
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
    };
    expect(windowsOf(withAbsence, DANI_ID, "2026-09-01")).toEqual([]);
    for (const employeeId of [ALEX_ID, NEREA_ID]) {
      expect(windowsOf(withAbsence, employeeId, "2026-09-01"), String(employeeId)).toEqual([
        { startMinutes: parseHHmm("09:30"), endMinutes: parseHHmm("19:30") },
      ]);
    }
  });

  it("un cierre de local y un festivo aprobado cierran a los tres por igual", () => {
    const withClosure: CalendarWithCapabilities = {
      ...clean,
      closures: [
        {
          id: "cierre-de-local",
          kind: "full_closure",
          startDate: "2026-09-01",
          endDate: "2026-09-01",
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
      venueRules: [
        {
          id: "festivo-aprobado",
          kind: "holiday",
          scope: "venue",
          date: "2026-09-02",
          closed: true,
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
    };
    for (const employeeId of EMPLOYEES) {
      expect(windowsOf(withClosure, employeeId, "2026-09-01"), `cierre/${String(employeeId)}`).toEqual([]);
      expect(windowsOf(withClosure, employeeId, "2026-09-02"), `festivo/${String(employeeId)}`).toEqual([]);
    }
  });

  it("«cualquiera» sigue siendo determinista: la misma entrada elige siempre a la misma persona", () => {
    // Deliberadamente NO se fija QUIÉN sale elegido: al igualarse los
    // horarios, los empates los rompen los criterios posteriores
    // (huecos restantes, citas confirmadas, id) y ese resultado es un detalle
    // del reparto, no una verdad de negocio. Lo que esta prueba defiende es
    // que nunca sea al azar.
    const first = chooseProfessional(cal, BOOKING_DEMO_TODAY, parseHHmm("11:00"), 1);
    expect(first.employeeId).not.toBeNull();
    for (let i = 0; i < 5; i += 1) {
      expect(chooseProfessional(cal, BOOKING_DEMO_TODAY, parseHHmm("11:00"), 1)).toEqual(first);
    }
  });
});
