import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exploreAvailability, type AvailabilityExploreQuery } from "../../src/console/availabilityExplorer.js";
import { chooseProfessional } from "../../src/callEngine/allocation/anyProfessional.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { EmployeeId, ServiceId } from "../../src/callEngine/domain/types.js";
import type { CalendarWithCapabilities, CapabilityMatrix } from "../../src/callEngine/capabilities.js";
import type { OperationalCalendar, WeeklySchedule } from "../../src/callEngine/calendar/model.js";

/**
 * step 19 · §3.5.1 (hallazgo B2) — la semántica exacta de "Cualquiera del
 * equipo": EXACTAMENTE una fila por (día, hora de inicio), nunca una fila
 * por profesional libre, y su `employeeId` es el que decide
 * `chooseProfessional` — nunca uno inventado por este módulo.
 */

const ALEX: EmployeeId = 3;
const DANI: EmployeeId = 6;
const NEREA: EmployeeId = 9;
const SERVICE: ServiceId = 1;
const MONDAY_ISO = "2026-08-03";
const CLOCK = fixedClock(MONDAY_ISO, 9 * 60);

function threeCapableCalendar(): CalendarWithCapabilities {
  const professionals = [
    { employeeId: ALEX, displayName: "Álex (sintético)", synthetic: true as const },
    { employeeId: DANI, displayName: "Dani (sintético)", synthetic: true as const },
    { employeeId: NEREA, displayName: "Nerea (sintética)", synthetic: true as const },
  ];
  const weeklySchedules: WeeklySchedule[] = [ALEX, DANI, NEREA].map((employeeId) => ({
    ownerKind: "employee",
    employeeId,
    dayOfWeek: 1,
    workDayStart: "09:00",
    workDayEnd: "13:00",
  }));
  const cal: OperationalCalendar = {
    professionals,
    weeklySchedules,
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    reservations: [],
    slotMinutes: 30,
    bookingHorizonDays: 90,
    minimumLeadMinutes: 0,
  };
  const capabilities: CapabilityMatrix = new Map([
    [ALEX, new Set<ServiceId>([0, 1, 2])],
    [DANI, new Set<ServiceId>([0, 1, 2])],
    [NEREA, new Set<ServiceId>([0, 1, 2])],
  ]);
  return { ...cal, capabilities };
}

function anyQuery(overrides: Partial<AvailabilityExploreQuery> = {}): AvailabilityExploreQuery {
  return { serviceId: SERVICE, mode: "any", from: MONDAY_ISO, to: MONDAY_ISO, ...overrides };
}

describe("mode=any produce EXACTAMENTE una fila por (día, hora) — nunca una por profesional libre", () => {
  it("a las 09:00, con tres profesionales libres y capaces, la respuesta trae UNA fila, y su employeeId es el de chooseProfessional", () => {
    const cal = threeCapableCalendar();
    const view = exploreAvailability(cal, CLOCK, anyQuery());
    const alas0900 = view.slots.filter((s) => s.startLabel === "09:00");
    expect(alas0900).toHaveLength(1);
    const esperado = chooseProfessional(cal, MONDAY_ISO, 9 * 60, SERVICE);
    expect(alas0900[0]?.employeeId).toBe(esperado.employeeId);
  });

  it("aserción negativa: NUNCA tres filas para la misma hora, en ningún hueco del día", () => {
    const cal = threeCapableCalendar();
    const view = exploreAvailability(cal, CLOCK, anyQuery());
    const porHora = new Map<string, number>();
    for (const slot of view.slots) {
      porHora.set(slot.startLabel, (porHora.get(slot.startLabel) ?? 0) + 1);
    }
    expect(view.slots.length).toBeGreaterThan(0);
    for (const [, cuantas] of porHora) expect(cuantas).toBe(1);
  });

  it("la fila no afirma que los demás estén ocupados, y anyProfessionalNote repite quién le tocaría en prosa", () => {
    const cal = threeCapableCalendar();
    const view = exploreAvailability(cal, CLOCK, anyQuery());
    const slot = view.slots[0];
    expect(slot?.anyProfessionalNote).toBe(`Con “Cualquiera”, a esta hora le tocaría ${slot?.professionalLabel}.`);
  });

  it("el detalle técnico publica candidatos y contadores de explainChoice, nunca como recomendación ni como orden visible", () => {
    const cal = threeCapableCalendar();
    const view = exploreAvailability(cal, CLOCK, anyQuery());
    const slot = view.slots.find((s) => s.startLabel === "09:00");
    expect(slot?.technical.anyProfessionalLabel).toMatch(/^Candidatos con “Cualquiera”: \d+(, \d+)* · huecos que le quedan hoy a cada uno: \d+(, \d+)* · citas confirmadas hoy: \d+(, \d+)*$/);
    expect(slot?.technical.anyProfessionalExplainerLabel).toBe(
      "Estos números explican el reparto, no lo recomiendan. Con “Cualquiera” esta consulta enseña UNA fila por hora, con la persona a la que le tocaría.",
    );
  });
});

describe("mode=one no interviene chooseProfessional en absoluto: el employeeId es el que eligió el operador", () => {
  it("con mode=one, la persona elegida es la que sale, aunque no sea a quien le tocaría con 'Cualquiera'", () => {
    const cal = threeCapableCalendar();
    // Añadimos una reserva que hace que, a las 09:00, Álex ya no sea quien
    // 'Cualquiera' elegiría (le quedan menos huecos que a Dani/Nerea).
    const calConReserva: CalendarWithCapabilities = {
      ...cal,
      reservations: [
        {
          id: "r-alex",
          employeeId: ALEX,
          serviceId: SERVICE,
          date: MONDAY_ISO,
          startMinutes: 11 * 60,
          endMinutes: 13 * 60,
          status: "confirmed",
          synthetic: true,
        },
      ],
    };
    const anyView = exploreAvailability(calConReserva, CLOCK, anyQuery());
    const anyChoice = anyView.slots.find((s) => s.startLabel === "09:00")?.employeeId;
    expect(anyChoice).not.toBe(ALEX); // Dani/Nerea tienen más huecos restantes que Álex

    const oneView = exploreAvailability(calConReserva, CLOCK, { serviceId: SERVICE, mode: "one", employeeId: ALEX, from: MONDAY_ISO, to: MONDAY_ISO });
    const oneSlot = oneView.slots.find((s) => s.startLabel === "09:00");
    expect(oneSlot?.employeeId).toBe(ALEX);
    expect(oneSlot?.anyProfessionalNote).toBeNull();
    expect(oneSlot?.technical.anyProfessionalLabel).toBeNull();
  });
});

describe("El desempate por employeeId (§3.5.1): desempate estable de último recurso, ESCRITO pero SIN caso vivo hoy", () => {
  it("con la regla de una fila por (día, hora), el par (día, hora) ya es único en los dos modos: ningún día de esta suite produce dos filas con la misma fecha y la misma hora de inicio", () => {
    const cal = threeCapableCalendar();
    for (const mode of ["any", "one"] as const) {
      const query: AvailabilityExploreQuery =
        mode === "one"
          ? { serviceId: SERVICE, mode, employeeId: ALEX, from: MONDAY_ISO, to: MONDAY_ISO }
          : anyQuery();
      const view = exploreAvailability(cal, CLOCK, query);
      const claves = view.slots.map((s) => `${s.dateISO}|${s.startLabel}`);
      expect(new Set(claves).size).toBe(claves.length);
    }
  });

  it("la especificación de ordenación conserva el desempate por employeeId, por escrito, en el código fuente — un orden que depende de que nunca haya empates es el que un día se vuelve no determinista sin que nadie se entere", () => {
    const source = readFileSync(join(process.cwd(), "src", "console", "availabilityExplorer.ts"), "utf8");
    expect(source).toContain("a.start.employeeId - b.start.employeeId");
    expect(source).toContain("desempate estable de último recurso");
  });
});
