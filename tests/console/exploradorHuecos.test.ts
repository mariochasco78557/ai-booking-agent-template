import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { EmployeeId, ServiceId } from "../../src/callEngine/domain/types.js";
import {
  exploreAvailability,
  AVAILABILITY_EXPLORER_MAX_DAYS,
  AVAILABILITY_EXPLORER_COPY,
  type AvailabilityExploreQuery,
} from "../../src/console/availabilityExplorer.js";
import type { CalendarWithCapabilities, CapabilityMatrix } from "../../src/callEngine/capabilities.js";
import type {
  AuditStamp,
  EmployeeAbsence,
  EmployeeScheduleOverride,
  OperationalCalendar,
  SeasonalVenueSchedule,
  SyntheticReservation,
  VenueCalendarRule,
  VenueClosure,
  WeeklySchedule,
} from "../../src/callEngine/calendar/model.js";
import {
  freeSlotStarts,
  isSlotFree,
  resolveDayWindows,
} from "../../src/callEngine/calendar/resolveAvailability.js";
import { formatHHmm } from "../../src/callEngine/domain/time.js";
import { demoSalonVenue, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";

/**
 * step 19 · Capacidad 1 — el explorador de huecos sintéticos (solo lectura).
 *
 * Dos técnicas, deliberadamente separadas:
 *  - Pruebas de DOMINIO: llaman a `exploreAvailability(cal, clock, query)`
 *    directamente, contra calendarios construidos A MANO (mismo patrón que
 *    `tests/callEngine/calendar.test.ts`), para alcanzar cada uno de los ocho
 *    valores de `CalendarLevel` por separado — el fixture vivo de la
 *    demostración (`demoSalonVenue()`) NO basta: en agosto de 2026,
 *    `seasonal_venue_schedule` (rango 5) SIEMPRE gana la etiqueta sobre
 *    `reservations` (rango 7) vía `preferMoreSenior`, así que "reservations"
 *    nunca es el `appliedLevel` de ningún profesional en el día de la
 *    demostración — pese a que las diez reservas de muestra sí narrowean su
 *    disponibilidad (las notas internas de `resolveDayWindows` lo confirman).
 *    Se documenta aquí como DESVIACIÓN DECLARADA del §3.6 del diseño, que
 *    afirma que "reservations" es "el caso más frecuente" del día de la
 *    demostración: es cierto que las reservas narrowean el día, pero el
 *    `appliedLevel` reportado ese día concreto es, siempre,
 *    `seasonal_venue_schedule`. Ningún código de producción se ha cambiado
 *    para esto: se demuestra "reservations" con un calendario de mano, igual
 *    que ya hace falta para "venue_closure"/"employee_override"/etc.
 *  - Pruebas HTTP: contra `GET /api/availability/explore` con
 *    `buildConsoleServer`, para los cinco `400` (que sólo existen en la capa
 *    de validación de `server.ts`) y el `200` de incapacidad (que sí es
 *    alcanzable con el fixture real: Nerea no hace Barba).
 */

const EMP: EmployeeId = 1;
const EMP2: EmployeeId = 2;
const MONDAY_ISO = "2026-08-03"; // Lunes real (dayOfWeek === 1), sólo por comodidad.
const SERVICE: ServiceId = 1;

function audit(): AuditStamp {
  return { createdAt: "2026-01-01T00:00:00", createdBy: "test-fixture" };
}

function baseCalendar(overrides: Partial<OperationalCalendar> = {}): CalendarWithCapabilities {
  const cal: OperationalCalendar = {
    professionals: [
      { employeeId: EMP, displayName: "Prueba Uno (sintético)", synthetic: true },
      { employeeId: EMP2, displayName: "Prueba Dos (sintético)", synthetic: true },
    ],
    weeklySchedules: [],
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    reservations: [],
    slotMinutes: 30,
    bookingHorizonDays: 90,
    minimumLeadMinutes: 0,
    ...overrides,
  };
  const capabilities: CapabilityMatrix = new Map([
    [EMP, new Set<ServiceId>([0, 1, 2])],
    [EMP2, new Set<ServiceId>([0, 1, 2])],
  ]);
  return { ...cal, capabilities };
}

function oneQuery(overrides: Partial<AvailabilityExploreQuery> = {}): AvailabilityExploreQuery {
  return { serviceId: SERVICE, mode: "one", employeeId: EMP, from: MONDAY_ISO, to: MONDAY_ISO, ...overrides };
}

const CLOCK = fixedClock(MONDAY_ISO, 9 * 60);

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: CLOCK,
    salt: "explorador-test-salt",
  });
}

async function explore(app: FastifyInstance, qs: string) {
  return app.inject({ method: "GET", url: `/api/availability/explore?${qs}` });
}

// =====================================================================
// Los cinco 400 de validación (§3.4, §8.2) — sólo alcanzables por HTTP.
// =====================================================================

describe("GET /api/availability/explore — los cinco 400, código y mensaje exactos", () => {
  it("invalid_query: falta un parámetro", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=any&from=2026-08-04");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
    await app.close();
  });

  it("invalid_query: sobra un parámetro", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=any&from=2026-08-04&to=2026-08-04&extra=1");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
    await app.close();
  });

  it("invalid_query: fecha con formato calendrico imposible (31 de febrero) pasa la expresión regular pero no es una fecha real", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=any&from=2026-02-31&to=2026-02-31");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
    await app.close();
  });

  it("invalid_query: años fuera del rango razonable de esta demostración (0000-01-01, 9999-12-31) — año calendricamente real pero absurdo, y la causa del 500 del hallazgo H1", async () => {
    const app = freshApp();
    for (const qs of [
      "serviceId=1&mode=any&from=0000-01-01&to=0000-01-05",
      "serviceId=1&mode=any&from=9999-12-31&to=9999-12-31",
      "serviceId=1&mode=any&from=9999-12-25&to=9999-12-31",
    ]) {
      const res = await explore(app, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
    }
    await app.close();
  });

  it("invalid_query: sobra employeeId con mode=any — nadie ha preguntado por una persona concreta (§3.4 'sobra un parámetro', hallazgo H8)", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=any&employeeId=9&from=2026-08-04&to=2026-08-04");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
    await app.close();
  });

  it("unknown_service: serviceId fuera de {0,1,2}", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=9&mode=any&from=2026-08-04&to=2026-08-04");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.unknownService, code: "unknown_service" });
    await app.close();
  });

  it("unknown_professional: mode=one sin employeeId", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=one&from=2026-08-04&to=2026-08-04");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.unknownProfessional, code: "unknown_professional" });
    await app.close();
  });

  it("unknown_professional: mode=one con un employeeId que no está en el calendario", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=one&employeeId=999999&from=2026-08-04&to=2026-08-04");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.unknownProfessional, code: "unknown_professional" });
    await app.close();
  });

  it("range_backwards: to anterior a from", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=any&from=2026-08-05&to=2026-08-04");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.rangeBackwards, code: "range_backwards" });
    await app.close();
  });

  it("range_too_long: más de 14 días de una vez", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=any&from=2026-08-04&to=2026-08-20");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: AVAILABILITY_EXPLORER_COPY.rangeTooLong, code: "range_too_long" });
    await app.close();
  });

  it("exactamente 14 días es el máximo permitido, no un error", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=1&mode=any&from=2026-08-04&to=2026-08-17");
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  /**
   * *(Enmendado 2026-08-05 tras revisión adversarial de la capacidad 1,
   * hallazgo H1/H9.)* La primera redacción de esta prueba era tautológica:
   * comprobaba "nunca 409/201/204" con UNA sola consulta válida, que ya
   * pasaba por construcción — no ejercitaba ningún caso límite, y no habría
   * detectado el 500 real que producían las fechas extremas
   * ("0000-01-01"/"9999-12-31": `dateLabelOf` los pasaba a `parseDateTime`,
   * que devolvía `null` para el día siguiente al desbordar el año, y el
   * `as ParsedDateTime` sin comprobar tiraba abajo la petición entera). Un
   * barrido de ~20 consultas, con las fronteras exactas, es la única forma de
   * que esta prueba pueda de verdad fallar.
   */
  it("un barrido de ~20 consultas, con las fronteras del calendario, nunca contesta 500 (ni ninguna otra cosa que no sea 200 o 400)", async () => {
    const app = freshApp();
    const consultas = [
      "serviceId=1&mode=any&from=0000-01-01&to=0000-01-01", // año extremo mínimo
      "serviceId=1&mode=any&from=9999-12-31&to=9999-12-31", // año extremo máximo — el que desbordaba `addDays`
      "serviceId=1&mode=any&from=9999-12-31&to=9999-12-25", // invertida, en el extremo
      "serviceId=1&mode=any&from=0000-01-01&to=9999-12-31", // rango extremo por los dos lados
      "serviceId=1&mode=any&from=2026-08-04&to=2026-08-04", // válida, from === to
      "serviceId=1&mode=any&from=2026-08-04&to=2026-08-17", // válida, exactamente 14 días
      "serviceId=1&mode=any&from=2026-08-04&to=2026-08-20", // range_too_long
      "serviceId=1&mode=any&from=2026-08-05&to=2026-08-04", // range_backwards, rango normal
      "serviceId=1&mode=any&from=2026-02-30&to=2026-02-30", // 30 de febrero: formato válido, fecha imposible
      "serviceId=1&mode=any&from=2024-02-29&to=2024-02-29", // 29 de febrero de un año bisiesto: válida
      "serviceId=1&mode=any&from=2023-02-29&to=2023-02-29", // 29 de febrero de un año NO bisiesto: imposible
      "serviceId=1&mode=one&employeeId=3&from=2026-08-04&to=2026-08-04", // válida, mode=one
      "serviceId=1&mode=one&from=2026-08-04&to=2026-08-04", // mode=one sin employeeId
      "serviceId=9&mode=any&from=2026-08-04&to=2026-08-04", // unknown_service
      "serviceId=1&mode=any&employeeId=3&from=2026-08-04&to=2026-08-04", // sobra employeeId con mode=any (H8)
      "serviceId=1&mode=ANY&from=2026-08-04&to=2026-08-04", // mode con mayúsculas
      "serviceId=01&mode=any&from=2026-08-04&to=2026-08-04", // cero a la izquierda
      "serviceId=1&mode=any&from=2026-8-4&to=2026-8-4", // formato de fecha sin ceros
      "serviceId=1&mode=any&from=99999-12-31&to=99999-12-31", // año de cinco cifras
      "", // vacía
    ];
    for (const qs of consultas) {
      const res = await explore(app, qs);
      expect([200, 400], `${qs} -> ${String(res.statusCode)}`).toContain(res.statusCode);
    }
    await app.close();
  });
});

// =====================================================================
// 200 con nota de incapacidad (§3.4) — Nerea no hace Barba, en el fixture real.
// =====================================================================

describe("GET /api/availability/explore — 200 con la persona incapaz del servicio", () => {
  it("Nerea (sintética) no hace Barba: 200, sin huecos, con la nota exacta del §8.2", async () => {
    const app = freshApp();
    const res = await explore(app, "serviceId=0&mode=one&employeeId=9&from=2026-08-04&to=2026-08-04");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slots).toEqual([]);
    expect(body.days).toEqual([]);
    expect(body.emptyLabel).toBeNull();
    expect(body.noteLabel).toBe(
      "Nerea (sintética) no hace Barba, así que no hay ninguna media hora suya para ese servicio. Prueba con “Cualquiera del equipo”.",
    );
    expect(body.totalLabel).toBe("Ningún hueco.");
    await app.close();
  });
});

// =====================================================================
// El tope de 14 días, visible en la respuesta (§3.3, §3.4).
// =====================================================================

describe("El tope de 14 días viaja en cada respuesta 200, con su nota", () => {
  it("cap.maxDays === 14 y cap.note es la frase exacta del §8.2", () => {
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP)] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.cap.maxDays).toBe(AVAILABILITY_EXPLORER_MAX_DAYS);
    expect(view.cap.note).toBe(
      "Como mucho 14 días de una vez. Es un tope técnico de esta demostración local, no una regla de Demo Salon.",
    );
  });
});

// =====================================================================
// El whyLabel de cada CalendarLevel alcanzable — calendarios de mano.
// =====================================================================

function weeklyFor(employeeId: EmployeeId, extra: Partial<WeeklySchedule> = {}): WeeklySchedule {
  return { ownerKind: "employee", employeeId, dayOfWeek: 1, workDayStart: "09:00", workDayEnd: "17:00", ...extra };
}

describe("El whyLabel de cada CalendarLevel alcanzable, empezando por reservations (§3.6, hallazgo B1)", () => {
  it("reservations — el caso que la primera redacción del diseño se dejó fuera", () => {
    const reserva: SyntheticReservation = {
      id: "r1",
      employeeId: EMP,
      serviceId: SERVICE,
      date: MONDAY_ISO,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP)], reservations: [reserva] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots.length).toBeGreaterThan(0);
    for (const slot of view.slots) {
      expect(slot.technical.appliedLevelLabel).toBe("Nivel de horario que decide ese día: reservations");
      expect(slot.whyLabel).toBe("Ese día Prueba Uno (sintético) ya tiene citas, y esta media hora sigue libre entre ellas; Prueba Uno (sintético) hace Corte de pelo.");
    }
    // La reserva sí ocupó su propio hueco: no aparece como libre.
    expect(view.slots.some((s) => s.startLabel === "09:00")).toBe(false);
  });

  it("weekly_schedule — un día ordinario, sin ninguna excepción", () => {
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP)] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots.length).toBeGreaterThan(0);
    for (const slot of view.slots) {
      expect(slot.technical.appliedLevelLabel).toBe("Nivel de horario que decide ese día: weekly_schedule");
      expect(slot.whyLabel).toBe(
        "Dentro del horario semanal del local; esta media hora cae en un tramo libre de Prueba Uno (sintético), de 09:00 a 17:00, y hace Corte de pelo.",
      );
    }
  });

  it("employee_override — un horario propio aprobado para ese día", () => {
    const override: EmployeeScheduleOverride = {
      id: "ov1",
      employeeId: EMP,
      date: MONDAY_ISO,
      workDayStart: "12:00",
      workDayEnd: "14:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ overrides: [override] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots.length).toBeGreaterThan(0);
    for (const slot of view.slots) {
      expect(slot.technical.appliedLevelLabel).toBe("Nivel de horario que decide ese día: employee_override");
      expect(slot.whyLabel).toBe(
        "Prueba Uno (sintético) tiene ese día un horario propio aprobado; esta media hora cae en un tramo suyo libre de 12:00 a 14:00, y hace Corte de pelo.",
      );
    }
  });

  it("venue_rule — una apertura especial aprobada del local, sin horario propio de la persona", () => {
    const rule: VenueCalendarRule = {
      id: "rule1",
      kind: "special_opening",
      scope: "venue",
      date: MONDAY_ISO,
      closed: false,
      specialOpen: "10:00",
      specialClose: "12:00",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ venueRules: [rule] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots.length).toBeGreaterThan(0);
    for (const slot of view.slots) {
      expect(slot.technical.appliedLevelLabel).toBe("Nivel de horario que decide ese día: venue_rule");
      expect(slot.whyLabel).toBe(
        "Ese día el local tiene una apertura especial aprobada; esta media hora cae en un tramo libre de Prueba Uno (sintético), de 10:00 a 12:00, y hace Corte de pelo.",
      );
    }
  });

  it("seasonal_venue_schedule — dentro de una temporada aprobada, con el rótulo de SeasonalVenueSchedule.label", () => {
    const season: SeasonalVenueSchedule = {
      id: "temporada-1",
      periodId: "periodo-1",
      label: "Horario de prueba de temporada",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      dayOfWeek: 1,
      workDayStart: "08:00",
      workDayEnd: "10:00",
      recurrence: "does_not_repeat",
      source: "synthetic_fixture",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ seasonalSchedules: [season] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots.length).toBeGreaterThan(0);
    for (const slot of view.slots) {
      expect(slot.technical.appliedLevelLabel).toBe("Nivel de horario que decide ese día: seasonal_venue_schedule");
      expect(slot.whyLabel).toBe(
        "Dentro del horario de prueba de temporada del local; esta media hora cae en un tramo libre de Prueba Uno (sintético), de 08:00 a 10:00, y hace Corte de pelo.",
      );
    }
  });

  it("seasonal_venue_schedule con una reserva en la apertura de temporada: el tramo libre NO se hace pasar por el horario declarado (revisión adversarial de la capacidad 1, hallazgo H3; re-verificado hallazgo R1)", () => {
    const season: SeasonalVenueSchedule = {
      id: "temporada-2",
      periodId: "periodo-2",
      label: "Horario de agosto de 2026",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      dayOfWeek: 1,
      workDayStart: "08:00",
      workDayEnd: "10:00",
      recurrence: "does_not_repeat",
      source: "synthetic_fixture",
      approval: "approved",
      audit: audit(),
    };
    // Reserva EXACTAMENTE en la apertura de temporada: el tramo declarado es
    // 08:00–10:00, pero lo que le queda libre a Prueba Uno ese día es sólo
    // 08:30–10:00.
    const reserva: SyntheticReservation = {
      id: "r-apertura",
      employeeId: EMP,
      serviceId: SERVICE,
      date: MONDAY_ISO,
      startMinutes: 8 * 60,
      endMinutes: 8 * 60 + 30,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({ seasonalSchedules: [season], reservations: [reserva] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots.length).toBeGreaterThan(0);
    for (const slot of view.slots) {
      expect(slot.technical.appliedLevelLabel).toBe("Nivel de horario que decide ese día: seasonal_venue_schedule");
      expect(slot.whyLabel).toBe(
        "Dentro del horario de agosto de 2026 del local; esta media hora cae en un tramo libre de Prueba Uno (sintético), de 08:30 a 10:00, y hace Corte de pelo.",
      );
      // El patrón falso de la primera redacción (H3): atribuir el tramo
      // residual (08:30–10:00, recortado por la reserva) al horario
      // DECLARADO, que en realidad es 08:00–10:00.
      expect(slot.whyLabel).not.toContain("del local (08:00");
      expect(slot.whyLabel).not.toContain("horario de agosto de 2026 del local (10:00");
      // El patrón falso de la segunda redacción (R1): decir que "tiene
      // libre" el ENVOLVENTE del día entero en vez de la ventana que
      // contiene este hueco concreto — en este caso sólo hay una ventana
      // residual, así que ambas coinciden (08:30–10:00), pero la FRASE ya
      // no debe usar ese verbo ("tiene libre de … a …") en absoluto.
      expect(slot.whyLabel).not.toContain("tiene libre de");
    }
  });

  it("con el fixture real de la demo, día 2026-08-04 (con una reserva a media mañana para cada profesional), el tramo que nombra la frase SIEMPRE contiene el hueco — nunca el envolvente del día entero (revisión adversarial de la capacidad 1, hallazgo R1)", () => {
    const cal = demoSalonVenue();
    for (const employeeId of [ALEX_ID, DANI_ID, NEREA_ID] as const) {
      const view = exploreAvailability(cal, CLOCK, {
        serviceId: 1,
        mode: "one",
        employeeId,
        from: BOOKING_DEMO_TODAY,
        to: BOOKING_DEMO_TODAY,
      });
      expect(view.slots.length).toBeGreaterThan(0);
      const { windows } = resolveDayWindows(cal, employeeId, BOOKING_DEMO_TODAY);
      // El día de la demostración, en agosto, tiene más de una ventana
      // residual para cada profesional (una reserva a media mañana la
      // parte en dos o más) — si no fuera así, esta prueba no ejercitaría
      // de verdad el hallazgo R1.
      expect(windows.length, `employeeId ${String(employeeId)}`).toBeGreaterThan(1);
      for (const slot of view.slots) {
        const contenedora = windows.find(
          (w) => slot.startLabel >= formatHHmm(w.startMinutes) && slot.endLabel <= formatHHmm(w.endMinutes),
        );
        expect(contenedora, `${slot.professionalLabel} ${slot.startLabel}`).toBeDefined();
        const inicioEsperado = formatHHmm(contenedora!.startMinutes);
        const finEsperado = formatHHmm(contenedora!.endMinutes);
        // La frase nombra EXACTAMENTE la ventana que contiene este hueco —
        // nunca una que se salte por en medio una media hora no libre
        // (la reserva de ese profesional ese día).
        expect(slot.whyLabel, slot.whyLabel).toContain(`de ${inicioEsperado} a ${finEsperado}`);
      }
      // El patrón falso de la redacción de R1: el envolvente de TODAS las
      // ventanas del día (09:00–17:30, el horario de temporada completo),
      // que en genérico se saltaría por encima de la reserva de media
      // mañana de cada profesional.
      for (const slot of view.slots) {
        expect(slot.whyLabel).not.toContain("de 09:00 a 17:30");
      }
    }
  });

  it("venue_closure — no produce ningún hueco; el día entero sale considered:false con su motivo", () => {
    const closure: VenueClosure = {
      id: "cierre-1",
      kind: "full_closure",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP)], closures: [closure] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots).toEqual([]);
    expect(view.days).toHaveLength(1);
    expect(view.days[0]?.considered).toBe(false);
    expect(view.days[0]?.notConsideredLabel).toBe(`El ${expectedDayPhrase(MONDAY_ISO)} hay un cierre del local aprobado.`);
  });

  it("employee_absence — no produce huecos para esa persona; con mode=one el día lo dice", () => {
    const absence: EmployeeAbsence = {
      id: "abs-1",
      employeeId: EMP,
      kind: "vacation",
      startDate: MONDAY_ISO,
      endDate: MONDAY_ISO,
      allDay: true,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP)], absences: [absence] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots).toEqual([]);
    expect(view.days[0]?.considered).toBe(false);
    expect(view.days[0]?.notConsideredLabel).toBe(`El ${expectedDayPhrase(MONDAY_ISO)} Prueba Uno (sintético) tiene una ausencia aprobada.`);
  });

  it("employee_absence PARCIAL (allDay:false), publicada por la ruta real: los huecos que quedan llevan una frase neutra, no vacía, que nunca nombra la ausencia — en los dos modos (revisión adversarial de la capacidad 1, hallazgo R2)", async () => {
    const app = freshApp();
    // Ausencia parcial de Álex, jueves 6 de agosto, 11:00-12:00 (todas las
    // horas del fixture real, no un calendario de mano): antes de esta
    // reparación, `employee_absence: () => ""` dejaba en blanco la razón de
    // CADA media hora libre de ese día, en mode=one y en mode=any.
    const publicacion = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "aus-parcial-r2",
          employeeId: 3,
          absenceKind: "absence",
          startDate: "2026-08-06",
          endDate: "2026-08-06",
          allDay: false,
          startMinutes: 660,
          endMinutes: 720,
        },
        resolutions: {},
      } as never,
    });
    expect(publicacion.statusCode).toBe(200);
    expect((publicacion.json() as { applied: boolean }).applied).toBe(true);

    const one = await explore(app, "serviceId=1&mode=one&employeeId=3&from=2026-08-06&to=2026-08-06");
    expect(one.statusCode).toBe(200);
    const oneBody = one.json();
    expect(oneBody.slots.length).toBeGreaterThan(0);
    // El día SIGUE considerado (no es un día entero perdido): la ausencia
    // sólo recorta un tramo, exactamente como una reserva.
    expect(oneBody.days[0].considered).toBe(true);
    for (const slot of oneBody.slots) {
      expect(slot.technical.appliedLevelLabel).toBe("Nivel de horario que decide ese día: employee_absence");
      expect(slot.whyLabel).not.toBe("");
      expect(slot.whyLabel).toContain("Esta media hora cae en un tramo libre de Álex (sintético), de");
      // El inicio/fin de la frase es el tramo que CONTIENE ese hueco
      // concreto, nunca 09:00-17:30 completo (11:00-12:00 está ausente).
      const inicio = Number(slot.startLabel.slice(0, 2)) * 60 + Number(slot.startLabel.slice(3));
      expect(inicio < 660 || inicio >= 720).toBe(true);
    }
    // Privacidad: ni una sola tarjeta nombra la ausencia, en mode=one.
    expect(JSON.stringify(oneBody.slots)).not.toContain("ausencia");

    const any = await explore(app, "serviceId=1&mode=any&from=2026-08-06&to=2026-08-06");
    expect(any.statusCode).toBe(200);
    const anyBody = any.json();
    const deAlex = anyBody.slots.filter((s: { employeeId: number }) => s.employeeId === 3);
    expect(deAlex.length).toBeGreaterThan(0);
    for (const slot of deAlex) {
      expect(slot.whyLabel).not.toBe("");
      expect(slot.whyLabel).toContain("Esta media hora cae en un tramo libre de Álex (sintético), de");
    }
    // Privacidad: `mode=any` tampoco nombra la ausencia de nadie — la misma
    // promesa que ya vale para el motivo de día (§8.2), ahora también para
    // el whyLabel de cada hueco.
    expect(JSON.stringify(anyBody.slots)).not.toContain("ausencia");
    await app.close();
  });

  it("none — declarado en el catálogo whyLabel por seguridad de tipos, pero NUNCA alcanzable como razón de un hueco concreto: 'resolveDayWindows' sólo reporta 'none' cuando NO hay ningún horario (ni de la persona ni del local), y entonces 'windows' es SIEMPRE vacío. Por eso, en la práctica, 'none' cae en el mismo motivo de día que 'el local no abre' (§8.2, tabla de motivos DEL LOCAL: 'venue_rule, seasonal_venue_schedule, weekly_schedule o none' comparten la misma frase) — nunca en una media hora libre con esa etiqueta. La entrada de WHY_LABEL_BUILDERS existe para que un noveno nivel futuro rompa la compilación en vez de caer en un respaldo silencioso (criterio 16), no porque este caso pinte un hueco hoy", () => {
    const cal = baseCalendar(); // sin ningún horario, de ningún tipo
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots).toEqual([]);
    expect(view.days[0]?.considered).toBe(false);
    expect(view.days[0]?.notConsideredLabel).toBe(`El ${expectedDayPhrase(MONDAY_ISO)} el local no abre.`);
  });
});

function expectedDayPhrase(_dateISO: string): string {
  // "lunes 3 de agosto" — mismo formato que dayPhraseEs(), sin año (§6.1, m5).
  return "lunes 3 de agosto";
}

// =====================================================================
// Estado vacío honesto (§3.6).
// =====================================================================

describe("Estado vacío, honesto: nunca 'el local está lleno', nunca un motivo inventado", () => {
  it("con dos personas capaces y ninguna con hueco ese día (todo el día ocupado), sale el estado vacío genérico", () => {
    const full: SyntheticReservation = {
      id: "full",
      employeeId: EMP,
      serviceId: SERVICE,
      date: MONDAY_ISO,
      startMinutes: 9 * 60,
      endMinutes: 17 * 60,
      status: "confirmed",
      synthetic: true,
    };
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP)], reservations: [full] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.slots).toEqual([]);
    expect(view.emptyLabel).toBe(
      "Con lo que has elegido, esta demostración no encuentra ninguna media hora libre. Eso no quiere decir que el local esté lleno: sólo que no hay ninguna con estos datos. Cambia el servicio, la persona o las fechas y vuelve a comprobar.",
    );
    // Nunca la afirmación DESNUDA "el local está lleno": sólo aparece dentro
    // de la frase que la niega ("Eso NO quiere decir que...").
    expect(view.emptyLabel).not.toContain("El local está lleno");
  });
});

// =====================================================================
// Un cierre del local aprobado, con mode=any, nombra el cierre — no cae en
// la frase genérica de "ocupado" (§8.2, revisión adversarial de la
// capacidad 1, hallazgo H2). Mismo cierre que step 17 §10.17 (escenario 17):
// jueves 6 de agosto de 2026, publicado con el fixture real de la demo.
// =====================================================================

describe("Un cierre del local publicado, con mode=any, nombra el cierre (§8.2, hallazgo H2)", () => {
  it("jueves 6 de agosto cerrado (escenario 17 de step 17): mode=any dice 'hay un cierre del local aprobado', no la frase genérica de ocupado", async () => {
    const app = freshApp();
    const publicacion = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-6-agosto", startDate: "2026-08-06", endDate: "2026-08-06" },
        resolutions: { "demo-salon-res-8": "keep_and_flag", "demo-salon-res-9": "keep_and_flag" },
      } as never,
    });
    expect(publicacion.statusCode).toBe(200);
    expect((publicacion.json() as { applied: boolean }).applied).toBe(true);

    const any = await explore(app, "serviceId=1&mode=any&from=2026-08-06&to=2026-08-06");
    expect(any.statusCode).toBe(200);
    const anyBody = any.json();
    expect(anyBody.days[0].considered).toBe(false);
    expect(anyBody.days[0].notConsideredLabel).toBe("El jueves 6 de agosto hay un cierre del local aprobado.");
    // El defecto de la primera redacción: caer en la frase genérica de
    // "ocupado" en vez de nombrar el cierre.
    expect(anyBody.days[0].notConsideredLabel).not.toContain("no queda ninguna media hora libre para");

    // mode=one, con el mismo cierre, sigue diciendo lo mismo — la reparación
    // no ha tocado ese camino, que ya funcionaba.
    const one = await explore(app, "serviceId=1&mode=one&employeeId=3&from=2026-08-06&to=2026-08-06");
    expect(one.statusCode).toBe(200);
    expect(one.json().days[0].notConsideredLabel).toBe("El jueves 6 de agosto hay un cierre del local aprobado.");
    await app.close();
  });
});

// =====================================================================
// Días fuera del horizonte de reserva, y la distinción "ya ha pasado" vs
// "fuera del plazo" (compareDate ANTES que isWithinHorizon, §8.2, m9).
// =====================================================================

describe("La distinción 'ya ha pasado' vs 'fuera del plazo', y los rangos explícitos", () => {
  it("un día ANTERIOR a hoy, dentro de un rango explícito, sale 'ya ha pasado' — nunca 'fuera del plazo'", () => {
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP), weeklyFor(EMP, { dayOfWeek: 2 })] });
    const yesterday = "2026-08-02";
    const view = exploreAvailability(cal, CLOCK, oneQuery({ from: yesterday, to: MONDAY_ISO }));
    const dayView = view.days.find((d) => d.dateISO === yesterday);
    expect(dayView?.considered).toBe(false);
    expect(dayView?.notConsideredLabel).toContain("ya ha pasado");
    expect(dayView?.notConsideredLabel).not.toContain("fuera del plazo");
  });

  it("un día MÁS ALLÁ del horizonte de reserva sale 'fuera del plazo en el que se puede reservar'", () => {
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP)], bookingHorizonDays: 2 });
    const farAway = "2026-08-20";
    const view = exploreAvailability(cal, CLOCK, oneQuery({ from: farAway, to: farAway }));
    expect(view.days[0]?.considered).toBe(false);
    expect(view.days[0]?.notConsideredLabel).toBe("El " + expectedFarDayPhrase() + " queda fuera del plazo en el que se puede reservar.");
  });

  it("un rango explícito con from !== to recorre cada día, y query.dayCountLabel dice cuántos", () => {
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP), weeklyFor(EMP, { dayOfWeek: 2 })] });
    const view = exploreAvailability(cal, CLOCK, oneQuery({ from: MONDAY_ISO, to: "2026-08-04" }));
    expect(view.days).toHaveLength(2);
    expect(view.query.dayCountLabel).toBe("2 días");
  });

  it("un solo día: query.dayCountLabel dice '1 día'", () => {
    const cal = baseCalendar({ weeklySchedules: [weeklyFor(EMP)] });
    const view = exploreAvailability(cal, CLOCK, oneQuery());
    expect(view.query.dayCountLabel).toBe("1 día");
  });
});

function expectedFarDayPhrase(): string {
  return "jueves 20 de agosto";
}

// =====================================================================
// Fronteras (§10.1, §10.4-9): el módulo se somete voluntariamente a la
// regla de tests/callEngine/boundaries.test.ts, y su barrido de imports es
// exactamente el de las nueve funciones de dominio + los ocho ayudantes de
// §3.5.2 — ninguno más, como import de VALOR (los `import type` quedan
// exentos, hallazgo A8).
// =====================================================================

describe("availabilityExplorer.ts se somete a las mismas fronteras que el motor (criterio 9, M5/A8)", () => {
  const source = readFileSync(join(process.cwd(), "src", "console", "availabilityExplorer.ts"), "utf8");
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("ningún Date.now(), Math.random(), randomUUID() ni 'new Date()' a pelo", () => {
    expect(codeOnly).not.toContain("Date.now(");
    expect(codeOnly).not.toContain("Math.random(");
    expect(codeOnly).not.toContain("randomUUID(");
    expect(/new\s+Date\s*\(\s*\)/.test(codeOnly)).toBe(false);
  });

  it("ningún temporizador", () => {
    expect(codeOnly).not.toContain("setTimeout(");
    expect(codeOnly).not.toContain("setInterval(");
  });

  it("ninguna llamada que mute: sin store., waitlist., operations., idempotency., clock.advance*", () => {
    for (const prohibido of ["store.", "waitlist.", "operations.", "idempotency.", "clock.advance", ".push(", ".splice("]) {
      // '.push('/'.splice(' se permiten sobre ARRAYS LOCALES de este módulo
      // (construir 'days'/'rawSlots' de la respuesta); lo que de verdad
      // importa aquí es que no exista NINGUNA de las cuatro llamadas de
      // mutación de estado ajeno.
      if (prohibido === ".push(" || prohibido === ".splice(") continue;
      expect(codeOnly, `aparece '${prohibido}'`).not.toContain(prohibido);
    }
  });

  it("el barrido de imports: sólo las nueve funciones de dominio y los ocho ayudantes de §3.5.2 llegan como import de VALOR", () => {
    const PERMITIDOS = new Set([
      // Los ocho ayudantes (§3.5.2).
      "addDays",
      "compareDate",
      "daysBetween",
      "formatHHmm",
      "SERVICE_LABELS",
      "dayPhraseEs",
      "parseDateTime",
      // Las nueve funciones de dominio (§3.5), menos las de tipo únicamente.
      "canPerform",
      "resolveDayWindows",
      // step 26 §13 — ACTUALIZADO A PROPÓSITO. Las dos puertas de
      // disponibilidad que este módulo usa son ahora las HERMANAS de intervalo
      // de las de siempre: viven en el MISMO módulo congelado, preguntan a la
      // MISMA `resolveDayWindows` y, sin duración en la consulta, se les pide
      // un bloque de `cal.slotMinutes` sobre la rejilla de `cal.slotMinutes`
      // —exactamente la pregunta que contestaban `freeSlotStarts`/`isSlotFree`,
      // que siguen existiendo intactas para la voz, el grupo y la lista de
      // espera—. La lista sigue siendo cerrada: nada nuevo entra por aquí.
      "freeStartsForDuration",
      "isIntervalFree",
      "isWithinHorizon",
      "isStartInThePast",
      "chooseProfessional",
      "explainChoice",
    ]);
    const importLines = [...source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/gm)];
    expect(importLines.length).toBeGreaterThan(0);
    const infractores: string[] = [];
    for (const m of importLines) {
      const esImportDeTipoEntero = m[1] !== undefined; // "import type { ... }" — exento por completo (A8)
      if (esImportDeTipoEntero) continue;
      const especificadores = (m[2] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const spec of especificadores) {
        if (spec.startsWith("type ")) continue; // "import { type X }" — exento (A8)
        const nombre = (spec.split(" as ")[0] ?? "").trim();
        if (!PERMITIDOS.has(nombre)) infractores.push(nombre);
      }
    }
    expect(infractores).toEqual([]);
  });

  it("no importa 'zod', 'precedence.ts' ni ningún fichero del motor fuera de la lista permitida", () => {
    expect(codeOnly).not.toContain('from "zod"');
    expect(codeOnly).not.toContain("precedence.js");
  });
});

// =====================================================================
// step 26 §13 · B12 y B13 — LA DURACIÓN EN EL EXPLORADOR
//
// El explorador es el resolvedor canónico de huecos que consulta el asistente
// de cita manual. Con duración pedida tiene que ofrecer inicios de 15 en 15 y
// rangos de verdad; SIN ella tiene que seguir contestando exactamente lo que
// contestaba antes de esta misión, porque el panel «Comprobar huecos
// sintéticos» de Agenda no manda duración nunca.
//
// Lo que NO firman: ninguna pantalla, ningún navegador y ninguna afirmación
// sobre cómo se pintan estos huecos.
// =====================================================================

describe("step 26 §13 · B12 — sin `durationMinutes`, el explorador contesta lo de siempre", () => {
  it("los inicios coinciden EXACTAMENTE con la rejilla congelada de la voz", async () => {
    const app = freshApp();
    const res = await explore(
      app,
      `serviceId=1&mode=one&employeeId=${String(ALEX_ID)}&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}`,
    );
    expect(res.statusCode).toBe(200);
    const cuerpo = res.json() as { slots: Array<{ startLabel: string; endLabel: string; timeRangeLabel: string }> };

    // La verdad de referencia se recalcula aquí con las funciones ANTIGUAS,
    // que step 26 no ha tocado: si el explorador hubiera cambiado de rejilla
    // sin querer, estas dos listas dejarían de coincidir.
    const cal = demoSalonVenue();
    const esperados = freeSlotStarts(cal, ALEX_ID, BOOKING_DEMO_TODAY)
      .filter((s) => isSlotFree(cal, ALEX_ID, BOOKING_DEMO_TODAY, s))
      .map((s) => formatHHmm(s));
    expect(cuerpo.slots.map((s) => s.startLabel)).toEqual(esperados);

    // Y cada hueco sigue durando media hora, con su rango de siempre.
    for (const hueco of cuerpo.slots) {
      expect(hueco.timeRangeLabel).toBe(`${hueco.startLabel}–${hueco.endLabel}`);
    }
    expect(cuerpo.slots.every((s) => s.startLabel.endsWith(":00") || s.startLabel.endsWith(":30"))).toBe(true);
    await app.close();
  });

  it("mode=any sin duración tampoco cambia: mismos inicios que la rejilla de la voz", async () => {
    const app = freshApp();
    const res = await explore(app, `serviceId=1&mode=any&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}`);
    expect(res.statusCode).toBe(200);
    const cuerpo = res.json() as { slots: Array<{ startLabel: string }> };
    const cal = demoSalonVenue();
    const union = new Set<number>();
    for (const p of cal.professionals) {
      if (!canPerformService(cal, p.employeeId)) continue;
      for (const s of freeSlotStarts(cal, p.employeeId, BOOKING_DEMO_TODAY)) union.add(s);
    }
    expect(cuerpo.slots.map((s) => s.startLabel)).toEqual(
      [...union].sort((a, b) => a - b).map((s) => formatHHmm(s)),
    );
    await app.close();
  });
});

/** Los tres profesionales del fixture hacen el servicio 1; Nerea no hace el 0. */
function canPerformService(cal: ReturnType<typeof demoSalonVenue>, employeeId: number): boolean {
  return cal.capabilities.get(employeeId)?.has(1) ?? false;
}

describe("step 26 §13 · B13 — con `durationMinutes`, inicios de 15 en 15 y rangos correctos", () => {
  it("90 minutos: sólo inicios donde cabe el bloque ENTERO, y el rango lo dice", async () => {
    const app = freshApp();
    const res = await explore(
      app,
      `serviceId=1&mode=one&employeeId=${String(ALEX_ID)}&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}&durationMinutes=90`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const cuerpo = res.json() as { slots: Array<{ startLabel: string; endLabel: string; timeRangeLabel: string }> };
    const inicios = cuerpo.slots.map((s) => s.startLabel);

    // Álex, 4 de agosto: libre 09:00–09:30, 10:00–13:00 y 14:00–17:30.
    // De 09:00 no sale nada (media hora no da para 90 minutos).
    expect(inicios).not.toContain("09:00");
    // De 10:00 a 11:30 sí, de 15 en 15.
    expect(inicios).toContain("10:00");
    expect(inicios).toContain("10:15");
    expect(inicios).toContain("11:30");
    // 11:45 ya no cabe entero antes de las 13:00.
    expect(inicios).not.toContain("11:45");
    // La tarde llega hasta las 16:00 (16:00 + 90 = 17:30, el cierre exacto).
    expect(inicios).toContain("16:00");
    expect(inicios).not.toContain("16:15");
    // Y el rango que se enseña es el que se reservaría.
    const alasDiez = cuerpo.slots.find((s) => s.startLabel === "10:00");
    expect(alasDiez?.endLabel).toBe("11:30");
    expect(alasDiez?.timeRangeLabel).toBe("10:00–11:30");
    // Todos los inicios están en la rejilla de 15.
    for (const etiqueta of inicios) {
      expect(Number(etiqueta.slice(3)) % 15, etiqueta).toBe(0);
    }
    await app.close();
  });

  it("135 minutos por la tarde, y 15 minutos en el hueco que ninguna media hora aprovecha", async () => {
    const app = freshApp();
    const base = `serviceId=1&mode=one&employeeId=${String(ALEX_ID)}&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}`;

    const largo = (await explore(app, `${base}&durationMinutes=135`)).json() as {
      slots: Array<{ startLabel: string; endLabel: string }>;
    };
    expect(largo.slots.map((s) => s.startLabel)).toContain("14:00");
    expect(largo.slots.find((s) => s.startLabel === "14:00")?.endLabel).toBe("16:15");
    // 15:15 + 135 = 17:30, el cierre exacto: es el último que cabe.
    expect(largo.slots.map((s) => s.startLabel)).toContain("15:15");
    expect(largo.slots.map((s) => s.startLabel)).not.toContain("15:30");

    const corto = (await explore(app, `${base}&durationMinutes=15`)).json() as {
      slots: Array<{ startLabel: string; endLabel: string }>;
    };
    // El tramo de 09:00 a 09:30 admite dos citas de cuarto de hora, que la
    // rejilla de 30 no podía ofrecer más que como una.
    expect(corto.slots.map((s) => s.startLabel)).toContain("09:00");
    expect(corto.slots.map((s) => s.startLabel)).toContain("09:15");
    expect(corto.slots.find((s) => s.startLabel === "09:15")?.endLabel).toBe("09:30");
    await app.close();
  });

  it("con «cualquiera» y 90 minutos, a las 16:00 le toca quien puede cubrirlos enteros", async () => {
    const app = freshApp();
    const res = await explore(
      app,
      `serviceId=1&mode=any&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}&durationMinutes=90`,
    );
    expect(res.statusCode).toBe(200);
    const cuerpo = res.json() as { slots: Array<{ startLabel: string; employeeId: number }> };
    const alasCuatro = cuerpo.slots.find((s) => s.startLabel === "16:00");
    expect(alasCuatro).toBeDefined();
    // Nerea tiene 16:00–17:00 y Dani 16:00–16:30: sólo Álex puede.
    expect(alasCuatro?.employeeId).toBe(ALEX_ID);
    await app.close();
  });

  it("una duración fuera de contrato es una consulta inválida, con el código y la frase de siempre", async () => {
    const app = freshApp();
    const base = `serviceId=1&mode=one&employeeId=${String(ALEX_ID)}&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}`;
    for (const mala of ["20", "0", "245", "7", "abc", "-15"]) {
      const res = await explore(app, `${base}&durationMinutes=${mala}`);
      expect(res.statusCode, mala).toBe(400);
      const cuerpo = res.json() as { code: string; error: string };
      expect(cuerpo.code, mala).toBe("invalid_query");
      expect(cuerpo.error, mala).toBe(AVAILABILITY_EXPLORER_COPY.invalidQuery);
      // Y ningún código técnico como mensaje principal.
      expect(cuerpo.error).not.toContain("durationMinutes");
    }
    // Y una duración con ceros a la izquierda también se rechaza (step 26,
    // revisión adversarial, hallazgo 6): `030`, `0090` y `30` serían la misma
    // duración escrita de tres formas, y tres grafías del mismo valor son tres
    // claves, tres cachés y tres oportunidades de discrepar.
    for (const conCeros of ["030", "0090", "00"]) {
      expect((await explore(app, `${base}&durationMinutes=${conCeros}`)).statusCode, conCeros).toBe(400);
    }
    // Los dos extremos del rango sí se aceptan.
    for (const buena of ["15", "240"]) {
      expect((await explore(app, `${base}&durationMinutes=${buena}`)).statusCode, buena).toBe(200);
    }
    await app.close();
  });

  it("una cita manual larga borra del explorador TODOS los inicios que solapa", async () => {
    const app = freshApp();
    const base = `serviceId=1&mode=one&employeeId=${String(ALEX_ID)}&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}`;
    const antes = (await explore(app, base)).json() as { slots: Array<{ startLabel: string }> };
    for (const etiqueta of ["14:30", "15:00", "15:30", "16:00"]) {
      expect(antes.slots.map((s) => s.startLabel), etiqueta).toContain(etiqueta);
    }

    // 14:15–16:30 creada a mano por el operador.
    const previa = await app.inject({
      method: "POST",
      url: "/api/booking/manual/preview",
      payload: {
        clientLabel: "Cliente A",
        serviceId: 1,
        date: BOOKING_DEMO_TODAY,
        startMinutes: 14 * 60 + 15,
        durationMinutes: 135,
        professional: { kind: "specific", employeeId: ALEX_ID },
      } as never,
    });
    const propuesta = (previa.json() as { proposal: { confirm: Record<string, unknown>; keyToMint: string } }).proposal;
    const creada = await app.inject({
      method: "POST",
      url: "/api/booking/manual",
      payload: { ...propuesta.confirm, durationMinutes: 135, confirmed: true } as never,
      headers: { "idempotency-key": propuesta.keyToMint },
    });
    expect(creada.statusCode, creada.body).toBe(201);

    const despues = (await explore(app, base)).json() as { slots: Array<{ startLabel: string }> };
    for (const etiqueta of ["14:00", "14:30", "15:00", "15:30", "16:00"]) {
      expect(despues.slots.map((s) => s.startLabel), etiqueta).not.toContain(etiqueta);
    }
    // Y lo que queda fuera del intervalo sigue ofreciéndose.
    expect(despues.slots.map((s) => s.startLabel)).toContain("16:30");
    await app.close();
  });
});
