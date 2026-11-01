import { describe, it, expect } from "vitest";
import { chooseProfessional, explainChoice } from "../../src/callEngine/allocation/anyProfessional.js";
import type { CalendarWithCapabilities, CapabilityMatrix } from "../../src/callEngine/capabilities.js";
import type {
  OperationalCalendar,
  SyntheticReservation,
  WeeklySchedule,
} from "../../src/callEngine/calendar/model.js";
import type { ServiceId, SyntheticProfessional } from "../../src/callEngine/domain/types.js";
import { extendedSyntheticVenue, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";

// Synthetic test fixtures only — no real Demo Salon data anywhere in this file.
const A = 1;
const B = 2;
const MONDAY_ISO = "2026-08-03"; // dayOfWeek === 1 (Monday)

function schedule(employeeId: number, extra: Partial<WeeklySchedule> = {}): WeeklySchedule {
  return {
    ownerKind: "employee",
    employeeId,
    dayOfWeek: 1,
    workDayStart: "09:00",
    workDayEnd: "12:00",
    ...extra,
  };
}

function twoProByCapabilityCalendar(options: {
  reservations?: SyntheticReservation[];
  capabilities?: CapabilityMatrix;
} = {}): CalendarWithCapabilities {
  const professionals: SyntheticProfessional[] = [
    { employeeId: A, displayName: "A (sintético)", synthetic: true },
    { employeeId: B, displayName: "B (sintético)", synthetic: true },
  ];
  const capabilities: CapabilityMatrix =
    options.capabilities ??
    new Map<number, ReadonlySet<ServiceId>>([
      [A, new Set<ServiceId>([1])],
      [B, new Set<ServiceId>([1])],
    ]);
  const calendar: OperationalCalendar = {
    professionals,
    weeklySchedules: [schedule(A), schedule(B)],
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    reservations: options.reservations ?? [],
    slotMinutes: 30,
    bookingHorizonDays: 90,
    minimumLeadMinutes: 0,
  };
  return { ...calendar, capabilities };
}

function reservation(
  id: string,
  employeeId: number,
  startMinutes: number,
  endMinutes: number,
): SyntheticReservation {
  return {
    id,
    employeeId,
    serviceId: 1,
    date: MONDAY_ISO,
    startMinutes,
    endMinutes,
    status: "confirmed",
    synthetic: true,
  };
}

describe("chooseProfessional / explainChoice", () => {
  it("filters candidates by real capability: Nerea cannot perform service 0", () => {
    const cal = extendedSyntheticVenue();
    const choice = chooseProfessional(cal, MONDAY_ISO, 10 * 60, 0);
    // Nerea (id 9) can only do services 1 and 2 in this fixture; she must
    // never be chosen for service 0, even though she is free at 10:00.
    if (choice.employeeId !== null) {
      expect(choice.employeeId).not.toBe(NEREA_ID);
    }
    const explanation = explainChoice(cal, MONDAY_ISO, 10 * 60, 0);
    expect(explanation.candidates).not.toContain(NEREA_ID);
  });

  it("a single capable-and-free candidate is chosen directly", () => {
    const capabilities: CapabilityMatrix = new Map<number, ReadonlySet<ServiceId>>([
      [A, new Set<ServiceId>([1])],
      [B, new Set<ServiceId>([])], // B cannot perform service 1 at all
    ]);
    const cal = twoProByCapabilityCalendar({ capabilities });
    const choice = chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1);
    expect(choice).toEqual({ employeeId: A });
  });

  it("ties are resolved by whoever has more remaining free slots today (from the requested start)", () => {
    // Both work 09:00-12:00 (6 half-hour slots). A has two reservations at
    // the end of the day (11:00-12:00), leaving fewer remaining slots than B.
    const cal = twoProByCapabilityCalendar({
      reservations: [
        reservation("a-1", A, 11 * 60, 11 * 60 + 30),
        reservation("a-2", A, 11 * 60 + 30, 12 * 60),
      ],
    });
    const choice = chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1);
    expect(choice).toEqual({ employeeId: B });

    const explanation = explainChoice(cal, MONDAY_ISO, 9 * 60, 1);
    expect(explanation.remainingSlotCounts[A]).toBe(4);
    expect(explanation.remainingSlotCounts[B]).toBe(6);
  });

  it("a tie in remaining slots is resolved by fewer confirmed reservations today", () => {
    // A has one reservation *before* the requested start (09:00-09:30), so
    // it doesn't reduce A's remaining-from-09:30 count, but it does count
    // towards A's total confirmed reservations for the day.
    const cal = twoProByCapabilityCalendar({
      reservations: [reservation("a-early", A, 9 * 60, 9 * 60 + 30)],
    });
    const explanation = explainChoice(cal, MONDAY_ISO, 9 * 60 + 30, 1);
    expect(explanation.remainingSlotCounts[A]).toBe(explanation.remainingSlotCounts[B]);
    expect(explanation.confirmedReservationCounts[A]).toBe(1);
    expect(explanation.confirmedReservationCounts[B]).toBe(0);
    expect(explanation.chosen).toBe(B);
  });

  it("a complete tie (equal remaining slots, equal reservation counts) is resolved by the lowest employeeId", () => {
    const cal = twoProByCapabilityCalendar();
    const choice = chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1);
    expect(choice).toEqual({ employeeId: A });
  });

  it("no capable-and-free candidate returns reason 'no_capable_and_free'", () => {
    const cal = twoProByCapabilityCalendar({
      reservations: [
        reservation("a-full-1", A, 9 * 60, 9 * 60 + 30),
        reservation("b-full-1", B, 9 * 60, 9 * 60 + 30),
      ],
    });
    const choice = chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1);
    expect(choice).toEqual({ employeeId: null, reason: "no_capable_and_free" });
  });

  it("is fully deterministic across 100 identical runs", () => {
    const cal = twoProByCapabilityCalendar({
      reservations: [
        reservation("a-1", A, 11 * 60, 11 * 60 + 30),
        reservation("a-2", A, 11 * 60 + 30, 12 * 60),
      ],
    });
    const results = Array.from({ length: 100 }, () => chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1));
    for (const r of results) {
      expect(r).toEqual(results[0]);
    }
  });

  it("explainChoice's counts are coherent with the final decision", () => {
    const cal = twoProByCapabilityCalendar({
      reservations: [
        reservation("a-1", A, 11 * 60, 11 * 60 + 30),
        reservation("a-2", A, 11 * 60 + 30, 12 * 60),
      ],
    });
    const explanation = explainChoice(cal, MONDAY_ISO, 9 * 60, 1);
    expect(explanation.candidates.sort((x, y) => x - y)).toEqual([A, B]);
    expect(explanation.chosen).toBe(B);
    expect(explanation.remainingSlotCounts[B]).toBeGreaterThan(
      explanation.remainingSlotCounts[A] ?? 0,
    );
    expect(explanation.reason).toBeUndefined();
  });
});

// =====================================================================
// step 26 §2 · B5 — «CUALQUIERA» SOBRE EL INTERVALO ENTERO
//
// El quinto parámetro es OPCIONAL y sólo cambia el paso 1 del algoritmo (quién
// es candidato). Los tres desempates se quedan como estaban, medidos sobre la
// rejilla de 30 minutos: miden cuán ocupado tiene cada uno el resto del día, no
// su elegibilidad, y cambiarlos alteraría el reparto de la voz sin motivo.
//
// Lo que NO firman: nada de HTTP, nada de navegador y ninguna preferencia de
// negocio sobre a quién «le conviene» una cita larga — no existe tal regla.
// =====================================================================

describe("step 26 §2 · B5 — chooseProfessional con duración", () => {
  /**
   * Los dos trabajan 09:00–13:00 (ocho huecos de 30).
   *   A (id 1) tiene una cita de 12:00 a 13:00 → le quedan 6 huecos hoy.
   *   B (id 2) tiene una cita de 10:00 a 10:30 → le quedan 7.
   * A las 09:00 los dos están libres en el minuto de inicio, así que SIN
   * duración gana B, que es quien tiene más huecos restantes. Con 90 minutos
   * por delante, B ya no puede: su cita de las 10:00 cae dentro del intervalo.
   */
  function dosConAgendasDistintas(): CalendarWithCapabilities {
    const cal = twoProByCapabilityCalendar({
      reservations: [
        reservation("a-tarde", A, 12 * 60, 13 * 60),
        reservation("b-media-manana", B, 10 * 60, 10 * 60 + 30),
      ],
    });
    return {
      ...cal,
      weeklySchedules: [schedule(A, { workDayEnd: "13:00" }), schedule(B, { workDayEnd: "13:00" })],
    };
  }

  it("sin duración (la voz, el grupo, la lista de espera) elige exactamente lo de siempre", () => {
    const cal = dosConAgendasDistintas();
    expect(chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1)).toEqual({ employeeId: B });
    const explicacion = explainChoice(cal, MONDAY_ISO, 9 * 60, 1);
    expect(explicacion.candidates).toEqual([A, B]);
    expect(explicacion.remainingSlotCounts[A]).toBe(6);
    expect(explicacion.remainingSlotCounts[B]).toBe(7);
  });

  it("con 90 minutos por delante elige a quien puede cubrirlos ENTEROS, y la elección se da la vuelta", () => {
    const cal = dosConAgendasDistintas();
    expect(chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1, 90)).toEqual({ employeeId: A });
    const explicacion = explainChoice(cal, MONDAY_ISO, 9 * 60, 1, 90);
    // B deja de ser CANDIDATO, no meramente de ganar el desempate.
    expect(explicacion.candidates).toEqual([A]);
    expect(explicacion.chosen).toBe(A);
    // Y el desempate se sigue midiendo sobre la rejilla de 30: el número no
    // cambia por pedir 90 minutos.
    expect(explicacion.remainingSlotCounts[A]).toBe(6);
  });

  it("con 30 minutos contesta lo mismo que sin duración: nadie pierde su hueco por hablar de duración", () => {
    const cal = dosConAgendasDistintas();
    expect(chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1, 30)).toEqual(
      chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1),
    );
  });

  it("si NADIE puede con el intervalo entero, se dice que no queda nadie, no se elige a medias", () => {
    const cal = dosConAgendasDistintas();
    // 09:00 + 240 minutos se sale del cierre de las 13:00 para los dos.
    expect(chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1, 240)).toEqual({
      employeeId: null,
      reason: "no_capable_and_free",
    });
  });

  it("la CAPACIDAD sigue filtrando antes que nada: una duración no habilita a quien no hace el servicio", () => {
    const capabilities: CapabilityMatrix = new Map<number, ReadonlySet<ServiceId>>([
      [A, new Set<ServiceId>([])],
      [B, new Set<ServiceId>([1])],
    ]);
    const cal = twoProByCapabilityCalendar({ capabilities });
    expect(chooseProfessional(cal, MONDAY_ISO, 9 * 60, 1, 60)).toEqual({ employeeId: B });
    expect(explainChoice(cal, MONDAY_ISO, 9 * 60, 1, 60).candidates).toEqual([B]);
  });

  it("un inicio a :15 es elegible con duración, y no lo era con la rejilla de 30", () => {
    const cal = twoProByCapabilityCalendar();
    // `isSlotFree` sólo conoce inicios alineados: a las 09:15 no hay candidatos.
    expect(chooseProfessional(cal, MONDAY_ISO, 9 * 60 + 15, 1)).toEqual({
      employeeId: null,
      reason: "no_capable_and_free",
    });
    // Con un intervalo de verdad, las 09:15 son una hora como cualquier otra.
    expect(chooseProfessional(cal, MONDAY_ISO, 9 * 60 + 15, 1, 45)).toEqual({ employeeId: A });
  });
});
