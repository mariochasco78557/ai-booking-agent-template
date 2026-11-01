import { describe, expect, it } from "vitest";

import { advanceableClock } from "../../src/callEngine/domain/advanceableClock.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY, demoSalonVenue } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { noShowIdFor, type NoShowRecord, type OperationsAuditDraft } from "../../src/callEngine/operations/model.js";
import {
  correctNoShow,
  isEligibleForNoShow,
  minutesAfterEnd,
  noShowIneligibleReasonCode,
  noShowRevisionOf,
  recordNoShow,
  type OperationsCommandContext,
} from "../../src/callEngine/operations/noShow.js";

/**
 * step 18 · fase E — LAS INASISTENCIAS, EN EL DOMINIO PURO (diseño §2.3,
 * §2.4, §2.7, §2.8).
 *
 * Aritmética real del fixture (§9.1): hoy es martes 2026-08-04 y son las
 * 09:00 (540). `demo-salon-res-1` es Álex, 09:30–10:00 (570–600) y es la primera
 * cita que termina de toda la agenda; la siguiente, `demo-salon-res-3`, no acaba
 * hasta las 10:30. `demo-salon-res-7-cancelada` está cancelada.
 *
 * Cierra la parte de dominio de los criterios 8.12 (frontera exacta), 8.13
 * (un rechazo no escribe NADA), 8.14/8.15 (idempotencia estructural y
 * corrección terminal) y 8.16/8.17 (invariantes y reproducción del log).
 */

const RES_ALEX = "demo-salon-res-1"; // 09:30–10:00, confirmada
const RES_DANI = "demo-salon-res-3"; // 10:00–10:30, confirmada
const RES_CANCELADA = "demo-salon-res-7-cancelada"; // 15:00–15:30, cancelada

function contextAt(minutes: number, noShows: readonly NoShowRecord[] = []): OperationsCommandContext {
  return { cal: demoSalonVenue(), clock: fixedClock(BOOKING_DEMO_TODAY, minutes), noShows };
}

function reservationOf(id: string) {
  const reservation = demoSalonVenue().reservations.find((r) => r.id === id);
  if (reservation === undefined) throw new Error(`El fixture ya no trae ${id}`);
  return reservation;
}

/** El registro tal y como quedaría tras aplicar el write (el almacén no participa aquí). */
function recordsAfter(ctx: OperationsCommandContext, write: { noShows?: readonly NoShowRecord[] } | null): readonly NoShowRecord[] {
  return write?.noShows ?? ctx.noShows;
}

describe("step 18 · §2.4 — elegibilidad determinista, con la aritmética real del fixture", () => {
  it("a las 09:00 no ha terminado NI UNA cita del martes", () => {
    const clock = fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);
    const hoy = demoSalonVenue().reservations.filter((r) => r.date === BOOKING_DEMO_TODAY);
    expect(hoy.length).toBeGreaterThan(0);
    expect(hoy.filter((r) => isEligibleForNoShow(clock, r))).toEqual([]);
  });

  it("(8.12) la frontera es INCLUSIVA en el fin: minutosDesdeElFin === 0 ya es elegible", () => {
    const clock = fixedClock(BOOKING_DEMO_TODAY, 600); // las 10:00 exactas
    const alex = reservationOf(RES_ALEX);
    expect(minutesAfterEnd(clock, alex)).toBe(0);
    expect(isEligibleForNoShow(clock, alex)).toBe(true);
  });

  it("(8.12) un minuto antes, minutosDesdeElFin === -1, NO es elegible", () => {
    const clock = fixedClock(BOOKING_DEMO_TODAY, 599);
    const alex = reservationOf(RES_ALEX);
    expect(minutesAfterEnd(clock, alex)).toBe(-1);
    expect(isEligibleForNoShow(clock, alex)).toBe(false);
    expect(noShowIneligibleReasonCode(clock, alex)).toBe("reservation_not_finished_yet");
  });

  it("a las 10:00 hay EXACTAMENTE UNA cita elegible en toda la agenda de hoy", () => {
    const clock = fixedClock(BOOKING_DEMO_TODAY, 600);
    const elegibles = demoSalonVenue().reservations.filter((r) => isEligibleForNoShow(clock, r));
    expect(elegibles.map((r) => r.id)).toEqual([RES_ALEX]);
  });

  it("una cita cancelada NUNCA es elegible, por muy pasada que esté (K17)", () => {
    const clock = fixedClock(BOOKING_DEMO_TODAY, 1200);
    const cancelada = reservationOf(RES_CANCELADA);
    expect(minutesAfterEnd(clock, cancelada)).toBeGreaterThan(0);
    expect(isEligibleForNoShow(clock, cancelada)).toBe(false);
    expect(noShowIneligibleReasonCode(clock, cancelada)).toBe("reservation_is_cancelled");
  });

  it("la aritmética cruza los días con daysBetween, no con una resta de minutos", () => {
    // Una cita del jueves 2026-08-06 vista desde el martes: quedan dos días.
    const jueves = reservationOf("demo-salon-res-8"); // 10:00–10:30 del 2026-08-06
    const clock = fixedClock(BOOKING_DEMO_TODAY, 600);
    expect(minutesAfterEnd(clock, jueves)).toBe(600 - 630 - 2 * 1440);
    expect(isEligibleForNoShow(clock, jueves)).toBe(false);
    // Y desde el propio jueves a esa misma hora, ya ha terminado.
    expect(isEligibleForNoShow(fixedClock("2026-08-06", 630), jueves)).toBe(true);
  });

  it("no existe ningún margen de cortesía configurable en el código de la función (K2)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "src/callEngine/operations/noShow.ts",
      "src/callEngine/operations/model.ts",
      "src/console/operationsSnapshot.ts",
    ]) {
      // Igual que boundaries.test.ts: se busca en el CÓDIGO, no en la prosa
      // que explica precisamente por qué ese parámetro no existe.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      // La única mención permitida de «grace» es la copia que EXPLICA que no
      // hay margen (`noGracePeriod`); lo prohibido es un PARÁMETRO.
      expect(/graceminutes/i.test(source), file).toBe(false);
      expect(/graceperiodminutes/i.test(source), file).toBe(false);
      expect(source.includes("noShowGrace"), file).toBe(false);
    }
  });
});

describe("step 18 · §2.3 — registrar una inasistencia", () => {
  it("crea el registro con el id natural, el actor literal y los minutos transcurridos", () => {
    const ctx = contextAt(600);
    const outcome = recordNoShow(ctx, RES_ALEX);
    expect(outcome.status).toBe(201);
    expect(outcome.body).toEqual({ recorded: true });
    const records = recordsAfter(ctx, outcome.write);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      id: noShowIdFor(RES_ALEX),
      reservationId: RES_ALEX,
      employeeId: reservationOf(RES_ALEX).employeeId,
      serviceId: 1,
      date: BOOKING_DEMO_TODAY,
      startMinutes: 570,
      endMinutes: 600,
      minutesAfterEndAtRecording: 0,
      recordedBy: "console-operator",
      recordedAtISO: "2026-08-04T10:00:00",
      state: "recorded",
      synthetic: true,
    });
    expect(record?.correctedAtISO).toBeUndefined();
    expect(outcome.write?.events.map((e) => e.kind)).toEqual(["NO_SHOW_RECORDED"]);
  });

  it("el registro NO trae ningún campo que un panel futuro pueda leer como sanción", () => {
    const outcome = recordNoShow(contextAt(600), RES_ALEX);
    const record = outcome.write?.noShows?.[0] as Record<string, unknown>;
    for (const prohibido of ["note", "notes", "severity", "count", "flag", "score", "reviewState", "penalty", "deposit"]) {
      expect(Object.keys(record).includes(prohibido), prohibido).toBe(false);
    }
  });

  it("(8.13) una cita que no ha terminado se rechaza con 409 y NO escribe nada", () => {
    const ctx = contextAt(600); // las 10:00: res-3 termina a las 10:30
    const outcome = recordNoShow(ctx, RES_DANI);
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({
      conflict: "reservation_not_finished_yet",
      minutesUntilEnd: 30,
      endsAtLabel: "10:30",
    });
    expect(outcome.write).toBeNull();
  });

  it("(8.13, K17) una cita cancelada se rechaza con 409 y NO escribe nada", () => {
    const outcome = recordNoShow(contextAt(1200), RES_CANCELADA);
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ conflict: "reservation_is_cancelled" });
    expect(outcome.write).toBeNull();
  });

  it("una cita que no existe se rechaza con 404 y NO escribe nada", () => {
    const outcome = recordNoShow(contextAt(600), "no-existe-esta-cita");
    expect(outcome.status).toBe(404);
    expect(outcome.body).toMatchObject({ code: "reservation_not_found" });
    expect(outcome.write).toBeNull();
  });

  it("(8.14) repetir el registro devuelve 200 alreadyRecorded, deja el registro intacto y escribe UN evento de repetición", () => {
    const primero = recordNoShow(contextAt(600), RES_ALEX);
    const records = recordsAfter(contextAt(600), primero.write);
    const ctx = contextAt(660, records); // media hora después
    const segundo = recordNoShow(ctx, RES_ALEX);
    expect(segundo.status).toBe(200);
    expect(segundo.body).toEqual({ recorded: true, alreadyRecorded: true });
    // El registro NO cambia: ni el estado, ni la hora, ni los minutos.
    expect(segundo.write?.noShows).toBeUndefined();
    expect(segundo.write?.events.map((e) => e.kind)).toEqual(["NO_SHOW_COMMAND_REPEATED"]);
    expect(segundo.write?.events[0]?.detail).toEqual({ command: "record_no_show" });
  });
});

describe("step 18 · §2.3 — corregir es definitivo y no borra historia (K3)", () => {
  function conRegistro(minutes = 600) {
    const ctx = contextAt(minutes);
    const outcome = recordNoShow(ctx, RES_ALEX);
    return recordsAfter(ctx, outcome.write);
  }

  it("(8.15) la corrección conserva el registro, su recordedAtISO y añade la hora de corrección", () => {
    const ctx = contextAt(660, conRegistro());
    const outcome = correctNoShow(ctx, RES_ALEX);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ corrected: true });
    const record = outcome.write?.noShows?.[0];
    expect(record).toMatchObject({
      id: noShowIdFor(RES_ALEX),
      state: "corrected_not_a_no_show",
      recordedAtISO: "2026-08-04T10:00:00",
      correctedAtISO: "2026-08-04T11:00:00",
      correctedBy: "console-operator",
      minutesAfterEndAtRecording: 0,
    });
    expect(outcome.write?.events.map((e) => e.kind)).toEqual(["NO_SHOW_CORRECTED"]);
    expect(outcome.write?.events[0]).toMatchObject({ fromState: "recorded", toState: "corrected_not_a_no_show" });
  });

  it("corregir dos veces devuelve 200 alreadyCorrected sin tocar el registro", () => {
    const corregidos = correctNoShow(contextAt(660, conRegistro()), RES_ALEX).write?.noShows ?? [];
    const outcome = correctNoShow(contextAt(720, corregidos), RES_ALEX);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ corrected: true, alreadyCorrected: true });
    expect(outcome.write?.noShows).toBeUndefined();
    expect(outcome.write?.events.map((e) => e.kind)).toEqual(["NO_SHOW_COMMAND_REPEATED"]);
  });

  it("(8.15) volver a registrar tras corregir es 409 no_show_already_corrected y NO escribe nada", () => {
    const corregidos = correctNoShow(contextAt(660, conRegistro()), RES_ALEX).write?.noShows ?? [];
    const outcome = recordNoShow(contextAt(720, corregidos), RES_ALEX);
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ conflict: "no_show_already_corrected" });
    expect(outcome.write).toBeNull();
  });

  it("corregir algo que nadie anotó es 404 y NO escribe nada", () => {
    const outcome = correctNoShow(contextAt(600), RES_ALEX);
    expect(outcome.status).toBe(404);
    expect(outcome.body).toMatchObject({ code: "no_show_not_found" });
    expect(outcome.write).toBeNull();
  });

  it("la revisión vale 0 antes de corregir y 1 después, y nunca más (la corrección es terminal)", () => {
    const registrados = conRegistro();
    expect(noShowRevisionOf(registrados, RES_ALEX)).toBe(0);
    const corregidos = correctNoShow(contextAt(660, registrados), RES_ALEX).write?.noShows ?? [];
    expect(noShowRevisionOf(corregidos, RES_ALEX)).toBe(1);
    // No hay ningún camino que devuelva el registro a `recorded`.
    expect(recordNoShow(contextAt(720, corregidos), RES_ALEX).write).toBeNull();
    expect(noShowRevisionOf(corregidos, RES_ALEX)).toBe(1);
  });

  it("una inasistencia anotada y una cancelación posterior COEXISTEN (K6)", () => {
    const registrados = conRegistro();
    // El mundo cambia: la cita pasa a `cancelled` desde la Agenda.
    const cal = demoSalonVenue();
    const cancelada = {
      ...cal,
      reservations: cal.reservations.map((r) => (r.id === RES_ALEX ? { ...r, status: "cancelled" as const } : r)),
    };
    const ctx: OperationsCommandContext = {
      cal: cancelada,
      clock: fixedClock(BOOKING_DEMO_TODAY, 660),
      noShows: registrados,
    };
    // Repetir el comando sigue siendo idempotente, no un conflicto...
    expect(recordNoShow(ctx, RES_ALEX).status).toBe(200);
    // ...y corregir sigue siendo posible.
    expect(correctNoShow(ctx, RES_ALEX).status).toBe(200);
  });
});

describe("step 18 · §2.8 — invariantes calculados sobre el log", () => {
  /** Reproduce a mano lo que hace el almacén: acumula estados y eventos. */
  function run(steps: readonly ("record" | "correct" | "record-again")[]) {
    let noShows: readonly NoShowRecord[] = [];
    const log: OperationsAuditDraft[] = [];
    let minutes = 600;
    for (const step of steps) {
      const ctx = contextAt(minutes, noShows);
      const outcome = step === "correct" ? correctNoShow(ctx, RES_ALEX) : recordNoShow(ctx, RES_ALEX);
      if (outcome.write !== null) {
        noShows = outcome.write.noShows ?? noShows;
        log.push(...outcome.write.events);
      }
      minutes += 30;
    }
    return { noShows, log };
  }

  it("count(NO_SHOW_RECORDED) − count(NO_SHOW_CORRECTED) === |registros en recorded|, pase lo que pase con los reintentos", () => {
    for (const steps of [
      ["record"],
      ["record", "record-again"],
      ["record", "correct"],
      ["record", "correct", "record-again"],
      ["record", "record-again", "correct", "correct"],
    ] as const) {
      const { noShows, log } = run(steps);
      const count = (kind: string): number => log.filter((e) => e.kind === kind).length;
      const vivos = noShows.filter((r) => r.state === "recorded").length;
      expect(count("NO_SHOW_RECORDED") - count("NO_SHOW_CORRECTED"), steps.join("+")).toBe(vivos);
      // Y nunca hay más de un NO_SHOW_RECORDED por reserva distinta anotada.
      expect(count("NO_SHOW_RECORDED")).toBeLessThanOrEqual(1);
    }
  });

  it("reproducir el log desde cero reproduce exactamente el conjunto de registros y sus estados (8.17)", () => {
    const { noShows, log } = run(["record", "record-again", "correct"]);
    const replayed = new Map<string, string>();
    for (const ev of log) {
      if (ev.reservationId === undefined) continue;
      if (ev.kind === "NO_SHOW_RECORDED") replayed.set(ev.reservationId, "recorded");
      if (ev.kind === "NO_SHOW_CORRECTED") replayed.set(ev.reservationId, "corrected_not_a_no_show");
    }
    expect(replayed.size).toBe(noShows.length);
    for (const record of noShows) expect(replayed.get(record.reservationId)).toBe(record.state);
  });

  it("el reloj sólo avanza, así que lo que había terminado sigue terminado (invariante 3)", () => {
    const clock = advanceableClock(fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES));
    const alex = reservationOf(RES_ALEX);
    expect(isEligibleForNoShow(clock, alex)).toBe(false);
    clock.advanceMinutes(60);
    expect(isEligibleForNoShow(clock, alex)).toBe(true);
    clock.advanceMinutes(5000);
    expect(isEligibleForNoShow(clock, alex)).toBe(true);
  });
});
