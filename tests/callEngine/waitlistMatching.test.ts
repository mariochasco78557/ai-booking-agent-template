import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import { demoSalonVenue, BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { runConversation, type ConversationScript } from "../../src/callEngine/engine.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { syntheticAudit } from "../../src/callEngine/fixtures/syntheticHolidays.js";
import {
  evaluateReleasedSlot,
  matchEntryAgainstSlot,
  proposalCandidatesFor,
  proposalStanding,
  releasedSlotsFrom,
} from "../../src/callEngine/waitlist/matching.js";
import { evaluateTimeliness } from "../../src/callEngine/waitlist/commands.js";
import { freshWaitlistEntries } from "../../src/callEngine/waitlist/fixture.js";
import { slotKeyFor, type ReleasedSlot, type SlotProposal, type WaitlistEntry } from "../../src/callEngine/waitlist/model.js";

/**
 * step 17 · fase C — el ALGORITMO de compatibilidad (§4 del diseño) y la
 * frontera de la política de antelación (§3), probados sin levantar HTTP.
 *
 * Cubre los criterios de aceptación 1, 2, 3, 6 y 14 de §12.
 */

const CLOCK = fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);

function cancelInCalendar(cal: CalendarWithCapabilities, reservationId: string): CalendarWithCapabilities {
  return {
    ...cal,
    reservations: cal.reservations.map((r) => (r.id === reservationId ? { ...r, status: "cancelled" as const } : r)),
  };
}

/** Fase A del §4.1: los huecos que libera cancelar `reservationId`, sobre el calendario YA actualizado. */
function releaseOf(reservationId: string, cal: CalendarWithCapabilities = demoSalonVenue()) {
  const reservation = cal.reservations.find((r) => r.id === reservationId);
  expect(reservation, `la fixture no trae ${reservationId}`).toBeDefined();
  const after = cancelInCalendar(cal, reservationId);
  return { after, slots: releasedSlotsFrom(after, reservation!, `cxl-${reservationId}`) };
}

const SEED_ENTRIES = freshWaitlistEntries(CLOCK);

function compatiblesFor(reservationId: string): { slotKey: string; compatible: readonly string[] }[] {
  const { after, slots } = releaseOf(reservationId);
  return slots.map((slot) => {
    const evaluation = evaluateReleasedSlot(after, CLOCK, SEED_ENTRIES, slot);
    return { slotKey: slot.key, compatible: evaluation.compatibleEntryIds };
  });
}

// ---------------------------------------------------------------------
// Criterio 1 — pureza
// ---------------------------------------------------------------------

describe("step 17 · §12.1 — evaluateReleasedSlot es pura", () => {
  it("tres ejecuciones con la misma entrada dan exactamente el mismo JSON", () => {
    const { after, slots } = releaseOf("demo-salon-res-2");
    const slot = slots[0];
    expect(slot).toBeDefined();
    const runs = [0, 1, 2].map(() => JSON.stringify(evaluateReleasedSlot(after, CLOCK, SEED_ENTRIES, slot!)));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it("no lee el reloj real: con dos relojes sintéticos distintos el resultado cambia de forma determinista, y con el mismo reloj nunca cambia", () => {
    const { after, slots } = releaseOf("demo-salon-res-1");
    const slot = slots[0]!;
    const alDia = evaluateReleasedSlot(after, CLOCK, SEED_ENTRIES, slot);
    // Un reloj puesto a las 10:00 deja ese hueco de las 09:30 en el pasado.
    const masTarde = evaluateReleasedSlot(after, fixedClock(BOOKING_DEMO_TODAY, 10 * 60), SEED_ENTRIES, slot);
    expect(alDia.compatibleEntryIds).toEqual(["wl-f05"]);
    expect(masTarde.compatibleEntryIds).toEqual([]);
    expect(masTarde.incompatible.find((i) => i.entryId === "wl-f05")?.reasons).toContain("slot_in_the_past");
  });
});

// ---------------------------------------------------------------------
// Criterio 2 — la frontera de la política, INCLUSIVA en on_time
// ---------------------------------------------------------------------

describe("step 17 · §12.2 — la frontera del plazo de cancelación", () => {
  const POLICY = 120;

  it("exactamente 120 minutos de antelación ES dentro de plazo (frontera inclusiva)", () => {
    // 540 + 120 = 660 (11:00) sobre el 'hoy' sintético.
    const v = evaluateTimeliness(CLOCK, { date: BOOKING_DEMO_TODAY, startMinutes: 660 }, POLICY);
    expect(v.leadMinutes).toBe(120);
    expect(v.timeliness).toBe("on_time");
    expect(v.latenessKind).toBeUndefined();
  });

  it("119 minutos es fuera de plazo, dentro de la ventana de aviso", () => {
    const v = evaluateTimeliness(CLOCK, { date: BOOKING_DEMO_TODAY, startMinutes: 659 }, POLICY);
    expect(v.leadMinutes).toBe(119);
    expect(v.timeliness).toBe("late");
    expect(v.latenessKind).toBe("within_notice_window");
  });

  it("un solo minuto negativo es 'la cita ya había empezado'", () => {
    const v = evaluateTimeliness(CLOCK, { date: BOOKING_DEMO_TODAY, startMinutes: 539 }, POLICY);
    expect(v.leadMinutes).toBe(-1);
    expect(v.timeliness).toBe("late");
    expect(v.latenessKind).toBe("already_started");
  });

  it("con plazo 0 toda cancelación no empezada cuenta como dentro de plazo, y sigue sin haber consecuencia", () => {
    expect(evaluateTimeliness(CLOCK, { date: BOOKING_DEMO_TODAY, startMinutes: 540 }, 0).timeliness).toBe("on_time");
    expect(evaluateTimeliness(CLOCK, { date: BOOKING_DEMO_TODAY, startMinutes: 541 }, 0).timeliness).toBe("on_time");
    // Ni siquiera con plazo 0 se llama 'a tiempo' a una cita ya empezada.
    expect(evaluateTimeliness(CLOCK, { date: BOOKING_DEMO_TODAY, startMinutes: 500 }, 0).latenessKind).toBe("already_started");
  });

  it("la antelación cruza días con daysBetween, no con aritmética nueva", () => {
    const v = evaluateTimeliness(CLOCK, { date: "2026-08-06", startMinutes: 600 }, POLICY);
    expect(v.leadMinutes).toBe(2 * 1440 + 600 - 540);
    expect(v.timeliness).toBe("on_time");
  });
});

// ---------------------------------------------------------------------
// Criterio 3 — cuántos huecos libera cada cancelación
// ---------------------------------------------------------------------

describe("step 17 · §12.3 — huecos liberados por una cancelación", () => {
  it("una cita de 60 minutos libera exactamente DOS huecos de 30", () => {
    const { slots } = releaseOf("demo-salon-res-2");
    expect(slots.map((s) => s.startMinutes)).toEqual([13 * 60, 13 * 60 + 30]);
    expect(slots.map((s) => s.key)).toEqual([
      slotKeyFor(BOOKING_DEMO_TODAY, 780, ALEX_ID),
      slotKeyFor(BOOKING_DEMO_TODAY, 810, ALEX_ID),
    ]);
    expect(slots.every((s) => s.endMinutes - s.startMinutes === 30)).toBe(true);
  });

  it("una cita de 30 minutos libera exactamente UNO", () => {
    expect(releaseOf("demo-salon-res-5").slots.map((s) => s.startMinutes)).toEqual([12 * 60 + 30]);
    expect(releaseOf("demo-salon-res-4").slots.map((s) => s.startMinutes)).toEqual([11 * 60 + 30]);
  });

  it("en un día con el local cerrado libera CERO, y ni siquiera se llega a evaluar a nadie", () => {
    const closed: CalendarWithCapabilities = {
      ...demoSalonVenue(),
      closures: [
        {
          id: "cierre-06-agosto",
          kind: "full_closure",
          startDate: "2026-08-06",
          endDate: "2026-08-06",
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
    };
    const { slots } = releaseOf("demo-salon-res-8", closed);
    expect(slots).toEqual([]);

    // Y sin el cierre, ese mismo hueco SÍ encaja con wl-f06: lo que impide el
    // emparejamiento es el cierre del local, no una falta de capacidad.
    const abierto = releaseOf("demo-salon-res-8");
    expect(abierto.slots.map((s) => s.startMinutes)).toEqual([10 * 60]);
    expect(evaluateReleasedSlot(abierto.after, CLOCK, SEED_ENTRIES, abierto.slots[0]!).compatibleEntryIds).toEqual(["wl-f06"]);
  });

  it("nunca se anuncia un hueco fuera del tramo de la cita cancelada", () => {
    const { slots } = releaseOf("demo-salon-res-6");
    for (const slot of slots) {
      expect(slot.startMinutes).toBeGreaterThanOrEqual(16 * 60);
      expect(slot.startMinutes).toBeLessThan(17 * 60);
    }
    expect(slots.length).toBe(2);
  });
});

// ---------------------------------------------------------------------
// §4.1 B1..B7 — cada motivo, uno a uno, y todos a la vez
// ---------------------------------------------------------------------

describe("step 17 · §4.1 — las siete comprobaciones de compatibilidad", () => {
  const CAL = demoSalonVenue();
  const SLOT: ReleasedSlot = {
    key: slotKeyFor(BOOKING_DEMO_TODAY, 780, ALEX_ID),
    cancellationId: "cxl-demo-salon-res-2",
    employeeId: ALEX_ID,
    date: BOOKING_DEMO_TODAY,
    startMinutes: 780,
    endMinutes: 810,
  };
  const AFTER = cancelInCalendar(CAL, "demo-salon-res-2");

  function entry(overrides: Partial<WaitlistEntry>): WaitlistEntry {
    return {
      id: "wl-test",
      clientLabel: "Cliente Z",
      serviceId: 1,
      dateFrom: BOOKING_DEMO_TODAY,
      dateTo: BOOKING_DEMO_TODAY,
      earliestStartMinutes: 13 * 60,
      latestStartMinutes: 14 * 60,
      professional: { kind: "any" },
      optInSource: "operator_entered",
      optInConfirmed: true,
      state: "pending",
      createdSeq: 99,
      createdAtISO: "2026-08-04T09:00:00",
      synthetic: true,
      ...overrides,
    };
  }

  it("una entrada perfectamente compatible no devuelve ningún motivo", () => {
    expect(matchEntryAgainstSlot(AFTER, CLOCK, entry({}), SLOT)).toEqual([]);
  });

  it("B1 — fecha fuera del rango pedido", () => {
    const reasons = matchEntryAgainstSlot(AFTER, CLOCK, entry({ dateFrom: "2026-08-05", dateTo: "2026-08-05" }), SLOT);
    expect(reasons).toContain("date_outside_preferred_range");
  });

  it("B2 — la franja tiene que caber ENTERA: 13:30 no cabe en una franja que acaba a las 13:30", () => {
    const reasons = matchEntryAgainstSlot(AFTER, CLOCK, entry({ earliestStartMinutes: 13 * 60, latestStartMinutes: 13 * 60 + 30 }), {
      ...SLOT,
      key: slotKeyFor(BOOKING_DEMO_TODAY, 810, ALEX_ID),
      startMinutes: 810,
      endMinutes: 840,
    });
    expect(reasons).toContain("time_outside_preferred_window");
    // Y el hueco de las 13:00 sí cabe exactamente en esa misma franja.
    expect(matchEntryAgainstSlot(AFTER, CLOCK, entry({ latestStartMinutes: 13 * 60 + 30 }), SLOT)).toEqual([]);
  });

  it("B3 — pidió otro profesional", () => {
    const reasons = matchEntryAgainstSlot(AFTER, CLOCK, entry({ professional: { kind: "specific", employeeId: NEREA_ID } }), SLOT);
    expect(reasons).toContain("different_professional_requested");
    // El mismo profesional del hueco sí vale.
    expect(matchEntryAgainstSlot(AFTER, CLOCK, entry({ professional: { kind: "specific", employeeId: ALEX_ID } }), SLOT)).toEqual([]);
  });

  it("B4 — el profesional del hueco no hace ese servicio (Nerea no hace el 0)", () => {
    const nereaSlot: ReleasedSlot = { ...SLOT, employeeId: NEREA_ID, key: slotKeyFor(BOOKING_DEMO_TODAY, 780, NEREA_ID) };
    const reasons = matchEntryAgainstSlot(AFTER, CLOCK, entry({ serviceId: 0 }), nereaSlot);
    expect(reasons).toContain("professional_cannot_perform_service");
  });

  it("B5 — fecha fuera del horizonte de reserva", () => {
    const farAway = "2027-08-04";
    const reasons = matchEntryAgainstSlot(
      AFTER,
      CLOCK,
      entry({ dateFrom: farAway, dateTo: farAway }),
      { ...SLOT, date: farAway, key: slotKeyFor(farAway, 780, ALEX_ID) },
    );
    expect(reasons).toContain("date_outside_booking_horizon");
  });

  it("B6 — un hueco de hoy anterior a 'ahora' es pasado", () => {
    const past: ReleasedSlot = { ...SLOT, startMinutes: 8 * 60, endMinutes: 8 * 60 + 30, key: slotKeyFor(BOOKING_DEMO_TODAY, 480, ALEX_ID) };
    const reasons = matchEntryAgainstSlot(AFTER, CLOCK, entry({ earliestStartMinutes: 0, latestStartMinutes: 1440 }), past);
    expect(reasons).toContain("slot_in_the_past");
  });

  it("B7 — un hueco que ya no está libre", () => {
    // Sobre el calendario SIN cancelar, el hueco de las 13:00 sigue ocupado.
    const reasons = matchEntryAgainstSlot(CAL, CLOCK, entry({}), SLOT);
    expect(reasons).toContain("slot_no_longer_free");
  });

  it("no hay cortocircuito: una entrada que falla por varios motivos los devuelve TODOS", () => {
    const reasons = matchEntryAgainstSlot(
      CAL,
      CLOCK,
      entry({ dateFrom: "2026-08-05", dateTo: "2026-08-05", serviceId: 0, professional: { kind: "specific", employeeId: DANI_ID } }),
      // Las 12:30 de Nerea, con su cita todavía sin cancelar: el hueco no
      // está libre, ella no hace el servicio 0, se pidió a Dani, la hora cae
      // fuera de la franja y el día no es el del rango. Cinco motivos, y se
      // devuelven los cinco, en el orden fijo B1..B7.
      { ...SLOT, employeeId: NEREA_ID, startMinutes: 750, endMinutes: 780, key: slotKeyFor(BOOKING_DEMO_TODAY, 750, NEREA_ID) },
    );
    expect(reasons).toEqual([
      "date_outside_preferred_range",
      "time_outside_preferred_window",
      "different_professional_requested",
      "professional_cannot_perform_service",
      "slot_no_longer_free",
    ]);
  });

  it("una entrada 'cualquiera' se evalúa SIEMPRE contra el profesional de la cita cancelada, no contra otro con hueco", () => {
    // Dani tiene libre las 13:00 ese día, pero eso es irrelevante: el hueco
    // liberado es el de Nerea, y sobre Nerea se comprueba la capacidad.
    const nereaSlot: ReleasedSlot = { ...SLOT, employeeId: NEREA_ID, key: slotKeyFor(BOOKING_DEMO_TODAY, 780, NEREA_ID) };
    const reasons = matchEntryAgainstSlot(cancelInCalendar(CAL, "demo-salon-res-5"), CLOCK, entry({ serviceId: 0 }), nereaSlot);
    expect(reasons).toContain("professional_cannot_perform_service");
  });
});

// ---------------------------------------------------------------------
// La aritmética del reloj congelado (§8.3), verificada contra la fixture real
// ---------------------------------------------------------------------

describe("step 17 · §8.3 — la aritmética del reloj congelado, comprobada contra la fixture real", () => {
  const TABLE: { id: string; leadMinutes: number; timeliness: "on_time" | "late"; starts: number[]; compatible: string[][] }[] = [
    { id: "demo-salon-res-2", leadMinutes: 240, timeliness: "on_time", starts: [780, 810], compatible: [["wl-f01", "wl-f02"], ["wl-f01", "wl-f02"]] },
    { id: "demo-salon-res-5", leadMinutes: 210, timeliness: "on_time", starts: [750], compatible: [["wl-f03"]] },
    { id: "demo-salon-res-4", leadMinutes: 150, timeliness: "on_time", starts: [690], compatible: [[]] },
    { id: "demo-salon-res-1", leadMinutes: 30, timeliness: "late", starts: [570], compatible: [["wl-f05"]] },
    { id: "demo-salon-res-6", leadMinutes: 420, timeliness: "on_time", starts: [960, 990], compatible: [[], []] },
    { id: "demo-salon-res-10", leadMinutes: 420, timeliness: "on_time", starts: [960], compatible: [["wl-f04"]] },
    { id: "demo-salon-res-3", leadMinutes: 60, timeliness: "late", starts: [600], compatible: [[]] },
    { id: "demo-salon-res-8", leadMinutes: 2940, timeliness: "on_time", starts: [600], compatible: [["wl-f06"]] },
  ];

  for (const row of TABLE) {
    it(`${row.id}: antelación ${String(row.leadMinutes)} min (${row.timeliness}), ${String(row.starts.length)} hueco(s)`, () => {
      const cal = demoSalonVenue();
      const reservation = cal.reservations.find((r) => r.id === row.id);
      expect(reservation).toBeDefined();
      const verdict = evaluateTimeliness(CLOCK, reservation!, 120);
      expect(verdict.leadMinutes).toBe(row.leadMinutes);
      expect(verdict.timeliness).toBe(row.timeliness);

      const evaluated = compatiblesFor(row.id);
      expect(evaluated.map((e) => e.slotKey)).toEqual(
        row.starts.map((s) => slotKeyFor(reservation!.date, s, reservation!.employeeId)),
      );
      expect(evaluated.map((e) => [...e.compatible])).toEqual(row.compatible);
    });
  }

  it("el escenario 16 y su contraste: Nerea no puede con Barba a las 16:00; Dani, en el mismo hueco horario, sí", () => {
    const nerea = compatiblesFor("demo-salon-res-6");
    expect(nerea[0]?.compatible).toEqual([]);
    const { after, slots } = releaseOf("demo-salon-res-6");
    const razones = evaluateReleasedSlot(after, CLOCK, SEED_ENTRIES, slots[0]!).incompatible.find((i) => i.entryId === "wl-f04")?.reasons;
    expect(razones).toEqual(["professional_cannot_perform_service"]);

    const dani = compatiblesFor("demo-salon-res-10");
    expect(dani[0]?.compatible).toEqual(["wl-f04"]);
  });

  it("la cita ya cancelada de la fixture no libera nada: no hay hueco que anunciar", () => {
    const cal = demoSalonVenue();
    const cancelada = cal.reservations.find((r) => r.id === "demo-salon-res-7-cancelada");
    expect(cancelada?.status).toBe("cancelled");
  });

  it("el orden de los compatibles es el de CREACIÓN, no otro", () => {
    const { after, slots } = releaseOf("demo-salon-res-2");
    // Con las entradas barajadas al revés, el resultado sigue siendo el mismo.
    const barajadas = [...SEED_ENTRIES].reverse();
    expect(evaluateReleasedSlot(after, CLOCK, barajadas, slots[0]!).compatibleEntryIds).toEqual(["wl-f01", "wl-f02"]);
  });

  it("las entradas que no están 'pendiente' ni 'compatible' no se evalúan siquiera", () => {
    const { after, slots } = releaseOf("demo-salon-res-2");
    const conRetirada = SEED_ENTRIES.map((e) => (e.id === "wl-f01" ? { ...e, state: "withdrawn" as const } : e));
    const evaluation = evaluateReleasedSlot(after, CLOCK, conRetirada, slots[0]!);
    expect(evaluation.compatibleEntryIds).toEqual(["wl-f02"]);
    expect(evaluation.incompatible.some((i) => i.entryId === "wl-f01")).toBe(false);
    expect(evaluation.evaluated).toBe(SEED_ENTRIES.length - 1);
  });
});

// ---------------------------------------------------------------------
// Criterio 6 — B6 usa LA MISMA expresión que el motor
// ---------------------------------------------------------------------

describe("step 17 · §12.6 — B6 y el motor rechazan exactamente los mismos huecos", () => {
  /** Corre una conversación real y dice si el motor rechazó el hueco por pasado/antelación. */
  function engineRejectsAsPast(cal: CalendarWithCapabilities, clock: ReturnType<typeof fixedClock>, time: string): boolean {
    const emitter = createCallEventEmitter();
    const store = createMemoryStore();
    const script: ConversationScript = {
      scenarioId: "A31-b6-paridad",
      callId: `b6-${time}`,
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "tuesday",
          time,
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    };
    runConversation({ cal, clock, emitter, store, salt: "b6-salt" }, script);
    return emitter
      .all()
      .internal.some((e) => e.eventName === "SLOT_REJECTED" && (e.detail as { cause?: string } | undefined)?.cause === "past_or_lead_time");
  }

  /** Dice si la lista de espera rechaza ese mismo hueco con `slot_in_the_past`. */
  function waitlistRejectsAsPast(cal: CalendarWithCapabilities, clock: ReturnType<typeof fixedClock>, startMinutes: number): boolean {
    const slot: ReleasedSlot = {
      key: slotKeyFor(BOOKING_DEMO_TODAY, startMinutes, ALEX_ID),
      cancellationId: "cxl-paridad",
      employeeId: ALEX_ID,
      date: BOOKING_DEMO_TODAY,
      startMinutes,
      endMinutes: startMinutes + cal.slotMinutes,
    };
    const entry: WaitlistEntry = {
      id: "wl-b6",
      clientLabel: "Cliente Z",
      serviceId: 1,
      dateFrom: BOOKING_DEMO_TODAY,
      dateTo: BOOKING_DEMO_TODAY,
      earliestStartMinutes: 0,
      latestStartMinutes: 1440,
      professional: { kind: "any" },
      optInSource: "operator_entered",
      optInConfirmed: true,
      state: "pending",
      createdSeq: 1,
      createdAtISO: "2026-08-04T09:00:00",
      synthetic: true,
    };
    return matchEntryAgainstSlot(cal, clock, entry, slot).includes("slot_in_the_past");
  }

  const CASES: { label: string; minimumLeadMinutes: number; nowMinutes: number; time: string; startMinutes: number }[] = [
    { label: "hueco de esta mañana con el reloj a mediodía", minimumLeadMinutes: 0, nowMinutes: 12 * 60, time: "10:00", startMinutes: 600 },
    { label: "hueco justo en 'ahora' (no es pasado)", minimumLeadMinutes: 0, nowMinutes: 12 * 60, time: "12:00", startMinutes: 720 },
    { label: "hueco futuro con antelación mínima 0", minimumLeadMinutes: 0, nowMinutes: 12 * 60, time: "13:00", startMinutes: 780 },
    { label: "hueco futuro pero dentro de la antelación mínima de 60", minimumLeadMinutes: 60, nowMinutes: 12 * 60, time: "12:30", startMinutes: 750 },
    { label: "hueco futuro justo en el límite de la antelación mínima de 60", minimumLeadMinutes: 60, nowMinutes: 12 * 60, time: "13:00", startMinutes: 780 },
  ];

  for (const c of CASES) {
    it(`${c.label}: motor y lista de espera coinciden`, () => {
      const cal: CalendarWithCapabilities = { ...demoSalonVenue(), minimumLeadMinutes: c.minimumLeadMinutes, reservations: [] };
      const clock = fixedClock(BOOKING_DEMO_TODAY, c.nowMinutes);
      expect(waitlistRejectsAsPast(cal, clock, c.startMinutes)).toBe(engineRejectsAsPast(cal, clock, c.time));
    });
  }

  it("al menos uno de los casos rechaza de verdad (si no, la paridad de arriba sería 'false === false' siempre)", () => {
    const cal: CalendarWithCapabilities = { ...demoSalonVenue(), reservations: [] };
    const clock = fixedClock(BOOKING_DEMO_TODAY, 12 * 60);
    expect(waitlistRejectsAsPast(cal, clock, 600)).toBe(true);
    expect(engineRejectsAsPast(cal, clock, "10:00")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Criterio 14 — frontera de imports (mismo patrón que boundaries.test.ts)
// ---------------------------------------------------------------------

const SRC_CALL_ENGINE_ROOT = join(process.cwd(), "src", "callEngine");

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** Igual que en boundaries.test.ts: se busca en el CÓDIGO, no en la prosa que explica la regla. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("step 17 · §12.14 — la lista de espera es un CONSUMIDOR del motor, jamás al revés", () => {
  const ALL = listTsFiles(SRC_CALL_ENGINE_ROOT);

  it("ningún fichero de src/callEngine fuera de waitlist/ importa de waitlist/", () => {
    const outside = ALL.filter((f) => !relative(SRC_CALL_ENGINE_ROOT, f).startsWith(`waitlist${sep}`));
    expect(outside.length).toBeGreaterThan(0);
    const offenders = outside.filter((f) => /from\s+["'][^"']*waitlist\//.test(codeOnly(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => relative(process.cwd(), f))).toEqual([]);
  });

  it("los ficheros intocables no han cambiado de dependencias: ninguno menciona 'waitlist' ni 'operations' en su código", () => {
    const frozen = [
      "engine.ts",
      "precedence.ts",
      "outcomeDimension.ts",
      "intent.ts",
      "stateMachine.ts",
      "humanCascade.ts",
      join("calendar", "model.ts"),
      join("calendar", "resolveAvailability.ts"),
      join("calendar", "impact.ts"),
      join("calendar", "approval.ts"),
    ];
    for (const rel of frozen) {
      const source = codeOnly(readFileSync(join(SRC_CALL_ENGINE_ROOT, rel), "utf8"));
      expect(source.includes("waitlist"), rel).toBe(false);
      // step 18 (enmienda declarada, diseño §4.2 y criterio 8.28): la misma
      // regla, ampliada al segundo consumidor del motor. `operations/` es,
      // como `waitlist/`, un CONSUMIDOR: ninguno de estos diez ficheros puede
      // llegar a mencionarlo.
      expect(source.includes("operations"), rel).toBe(false);
    }
  });

  it("los módulos de waitlist/ no importan nada de src/console ni de src/clients ni de src/services", () => {
    const inside = ALL.filter((f) => relative(SRC_CALL_ENGINE_ROOT, f).startsWith(`waitlist${sep}`));
    expect(inside.length).toBeGreaterThan(0);
    for (const file of inside) {
      const source = codeOnly(readFileSync(file, "utf8"));
      for (const forbidden of ["src/console", "console.js", "src/clients", "src/services", "node:crypto", "setTimeout", "setInterval"]) {
        expect(source.includes(forbidden), `${relative(process.cwd(), file)} → ${forbidden}`).toBe(false);
      }
    }
  });

  // step 18 (diseño §4.2, criterio 8.28): las dos reglas de arriba,
  // duplicadas para el SEGUNDO consumidor del motor. `operations/` puede
  // importar de `src/callEngine/**` salvo de `waitlist/**` — y nadie puede
  // importar de él dentro del motor. Quien lo cose es `src/console/server.ts`,
  // que no vive aquí y por eso no aparece en estas listas.
  it("ningún fichero de src/callEngine fuera de operations/ importa de operations/", () => {
    const outside = ALL.filter((f) => !relative(SRC_CALL_ENGINE_ROOT, f).startsWith(`operations${sep}`));
    expect(outside.length).toBeGreaterThan(0);
    const offenders = outside.filter((f) => /from\s+["'][^"']*operations\//.test(codeOnly(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => relative(process.cwd(), f))).toEqual([]);
  });

  it("los módulos de operations/ no importan nada de src/console ni de src/clients ni de src/services", () => {
    const inside = ALL.filter((f) => relative(SRC_CALL_ENGINE_ROOT, f).startsWith(`operations${sep}`));
    expect(inside.length).toBeGreaterThan(0);
    for (const file of inside) {
      const source = codeOnly(readFileSync(file, "utf8"));
      for (const forbidden of ["src/console", "console.js", "src/clients", "src/services", "node:crypto", "setTimeout", "setInterval"]) {
        expect(source.includes(forbidden), `${relative(process.cwd(), file)} → ${forbidden}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------
// step 23 §3 — R1: la regla determinista de propuesta, pura y sin heurística
// ---------------------------------------------------------------------

describe("step 23 · §3 — proposalCandidatesFor aplica R1 entera, y nada más", () => {
  const { after, slots } = releaseOf("demo-salon-res-2");
  const alaUna = slots[0]!;
  const alaUnaYMedia = slots[1]!;

  function con(entries: readonly WaitlistEntry[], releasedSlots: readonly ReleasedSlot[], slot: ReleasedSlot) {
    return proposalCandidatesFor(after, CLOCK, entries, releasedSlots, slot).map((e) => e.id);
  }

  function conOferta(entry: WaitlistEntry, slotKey: string): WaitlistEntry {
    return { ...entry, state: "matched", currentOffer: { slotKey, cancellationId: "cxl-demo-salon-res-2", offeredSeq: 1 } };
  }

  const PROPUESTA_VIVA: SlotProposal = {
    entryId: "wl-f01",
    automaticEntryId: "wl-f01",
    origin: "system_first_compatible",
    status: "pending_approval",
    proposedAtISO: "2026-08-04T09:00:00",
  };

  it("(a)+(b) los candidatos son los compatibles activos, en orden de alta y sin ninguna puntuación", () => {
    expect(con(SEED_ENTRIES, slots, alaUna)).toEqual(["wl-f01", "wl-f02"]);
    // El orden es `createdSeq`, no el orden del array de entrada.
    const alReves = [...SEED_ENTRIES].reverse();
    expect(con(alReves, slots, alaUna)).toEqual(["wl-f01", "wl-f02"]);
  });

  it("(a) una entrada que ya no está en juego no es candidata, aunque encaje perfectamente", () => {
    for (const estado of ["declined", "withdrawn", "expired_manually", "converted", "notice_simulated", "accepted"] as const) {
      const entries = SEED_ENTRIES.map((e) => (e.id === "wl-f01" ? { ...e, state: estado } : e));
      expect(con(entries, slots, alaUna), estado).toEqual(["wl-f02"]);
    }
  });

  it("(c) quien retiene una oferta VIVA sobre otro hueco no es candidata: robársela sería quitársela en silencio", () => {
    const entries = SEED_ENTRIES.map((e) => (e.id === "wl-f01" ? conOferta(e, alaUnaYMedia.key) : e));
    expect(con(entries, slots, alaUna)).toEqual(["wl-f02"]);
    // Y sobre su PROPIO hueco sí lo es: una oferta que ya apunta aquí no estorba.
    expect(con(entries, slots, alaUnaYMedia)).toEqual(["wl-f01", "wl-f02"]);
  });

  it("(c) una oferta PROBADAMENTE muerta no bloquea: si su hueco ya no está en el registro, no protege nada", () => {
    const entries = SEED_ENTRIES.map((e) => (e.id === "wl-f01" ? conOferta(e, "slot-2026-08-04-600-3") : e));
    expect(con(entries, [alaUna], alaUna)).toEqual(["wl-f01", "wl-f02"]);
  });

  it("(d) quien ya es el sujeto de una propuesta VIVA de otro hueco no es candidata de este", () => {
    const entries = SEED_ENTRIES.map((e) => (e.id === "wl-f01" ? conOferta(e, alaUnaYMedia.key) : e));
    const registro: ReleasedSlot[] = [alaUna, { ...alaUnaYMedia, proposal: PROPUESTA_VIVA }];
    expect(con(entries, registro, alaUna)).toEqual(["wl-f02"]);
  });

  it("(d) una propuesta que ya NO se sostiene no bloquea a nadie", () => {
    // La misma propuesta, pero su sujeto se ha retirado: ya no se sostiene, así
    // que no puede seguir reservando a nadie para un hueco que no va a cubrir.
    const entries = SEED_ENTRIES.map((e) => (e.id === "wl-f02" ? { ...e, state: "withdrawn" as const } : e));
    const registro: ReleasedSlot[] = [
      alaUna,
      { ...alaUnaYMedia, proposal: { ...PROPUESTA_VIVA, entryId: "wl-f02", automaticEntryId: "wl-f02" } },
    ];
    expect(con(entries, registro, alaUna)).toEqual(["wl-f01"]);
  });

  it("es pura: tres ejecuciones con la misma entrada dan el mismo resultado, byte a byte", () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(con(SEED_ENTRIES, slots, alaUna)));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });
});

describe("step 23 · §4 — proposalStanding se re-deriva de cero, nunca se cachea", () => {
  const { after, slots } = releaseOf("demo-salon-res-2");
  const alaUna = slots[0]!;
  const conPropuesta: ReleasedSlot = {
    ...alaUna,
    proposal: {
      entryId: "wl-f01",
      automaticEntryId: "wl-f01",
      origin: "system_first_compatible",
      status: "approved",
      proposedAtISO: "2026-08-04T09:00:00",
      decidedAtISO: "2026-08-04T09:00:00",
    },
  };
  const emparejada = SEED_ENTRIES.map((e) =>
    e.id === "wl-f01"
      ? { ...e, state: "matched" as const, currentOffer: { slotKey: alaUna.key, cancellationId: alaUna.cancellationId, offeredSeq: 1 } }
      : e,
  );

  it("un hueco sin propuesta no sostiene nada, y no inventa razones", () => {
    expect(proposalStanding(after, CLOCK, SEED_ENTRIES, alaUna)).toEqual({ stands: false, reasons: [] });
  });

  it("se sostiene mientras la persona sigue emparejada con ESE hueco y encaja", () => {
    expect(proposalStanding(after, CLOCK, emparejada, conPropuesta).stands).toBe(true);
  });

  it("las tres razones por las que deja de sostenerse, cada una con su código", () => {
    // 1. La persona ya no está en juego.
    const retirada = emparejada.map((e) => (e.id === "wl-f01" ? { ...e, state: "withdrawn" as const } : e));
    expect(proposalStanding(after, CLOCK, retirada, conPropuesta)).toEqual({
      stands: false,
      reasons: ["entry_no_longer_active"],
    });

    // 2. El operador ha retirado el emparejamiento.
    const sinOferta = SEED_ENTRIES.map((e) => (e.id === "wl-f01" ? { ...e, state: "pending" as const } : e));
    expect(proposalStanding(after, CLOCK, sinOferta, conPropuesta)).toEqual({
      stands: false,
      reasons: ["offer_no_longer_on_this_slot"],
    });

    // 3. El hueco ha dejado de estar libre entre dos actos (B7).
    const ocupado: CalendarWithCapabilities = {
      ...after,
      reservations: [
        ...after.reservations,
        { id: "res-robada", employeeId: ALEX_ID, serviceId: 1 as const, date: BOOKING_DEMO_TODAY, startMinutes: 780, endMinutes: 810, status: "confirmed" as const, synthetic: true as const },
      ],
    };
    expect(proposalStanding(ocupado, CLOCK, emparejada, conPropuesta)).toEqual({
      stands: false,
      reasons: ["slot_no_longer_free"],
    });
  });

  it("una persona que ya va POR DELANTE en el bucle mantiene su propuesta en pie", () => {
    for (const estado of ["notice_simulated", "accepted", "converted"] as const) {
      const avanzada = emparejada.map((e) => (e.id === "wl-f01" ? { ...e, state: estado } : e));
      expect(proposalStanding(after, CLOCK, avanzada, conPropuesta).stands, estado).toBe(true);
    }
  });
});
