import { describe, expect, it } from "vitest";

import {
  ALEX,
  HUECO_1300_ALEX,
  HUECO_1330_ALEX,
  type Json,
  RES_ALEX_1300,
  aprobarPropuesta,
  cancelar,
  citasDe,
  comando,
  convertir,
  ejecutarEscenario,
  entradaDeListaDeEspera,
  freshApp,
  historialDeListaDeEspera,
  historialDeOperaciones,
  reset,
  snapshotOf,
  tareasHumanas,
  waitlistOf,
} from "./harness.js";

/**
 * step 18 · fase H — LA HERENCIA DE step 17, EJECUTADA SOBRE ESTE HEAD.
 *
 * Ninguna prueba de step 17 se ha tocado. Esto es lo contrario: una
 * ACEPTACIÓN nueva que recorre entero el escenario documentado (cancelar →
 * ofertar → aceptar → convertir, escenarios 4, 7, 8, 10 y 11 del §10 de
 * (internal doc, not included in the template)) y comprueba, sobre el código de
 * step 18, que los resultados son EXACTAMENTE los que aquel diseño dejó
 * escritos: los mismos identificadores deterministas, los mismos eventos en
 * el mismo orden y las mismas métricas.
 *
 * Además firma la parte de integración del criterio 8.24: el registro de la
 * lista de espera no recibe ni un evento de step 18, y el de operaciones no
 * recibe ni uno de step 17. Son dos registros, y siguen siéndolo.
 */

describe("step 17 · aceptación completa sobre el HEAD de step 18 — cancelar → ofertar → aceptar → convertir", () => {
  it("el recorrido entero da los identificadores, los eventos y las cifras documentados", async () => {
    const app = freshApp();
    await reset(app);

    // --- Escenarios 4, 7 y 8: la cancelación a tiempo y sus dos huecos.
    const cancelacion = await cancelar(app, RES_ALEX_1300);
    expect(cancelacion.statusCode).toBe(200);
    const cuerpo = cancelacion.json() as Json;
    expect(cuerpo.cancellation).toMatchObject({
      id: "cxl-demo-salon-res-2",
      reservationId: RES_ALEX_1300,
      employeeId: ALEX,
      leadMinutes: 240,
      policyMinutesAtCancellation: 120,
      timeliness: "on_time",
      cancelledAtISO: "2026-08-04T09:00:00",
    });
    expect((cuerpo.cancellation as Json).releasedSlotKeys).toEqual([HUECO_1300_ALEX, HUECO_1330_ALEX]);
    expect((cuerpo.releasedSlots as Json[]).map((s) => s.key)).toEqual([HUECO_1300_ALEX, HUECO_1330_ALEX]);
    // Escenario 7, en la propia respuesta: los dos compatibles, en orden.
    expect(((cuerpo.matches as Json[])[0] as Json).compatibleEntryIds).toEqual(["wl-f01", "wl-f02"]);

    // Escenario 7: dos compatibles, en orden de lectura, sin nadie preferido.
    const huecos = (await waitlistOf(app)).releasedSlots as Json[];
    expect(huecos.map((s) => s.key)).toEqual([HUECO_1300_ALEX, HUECO_1330_ALEX]);
    expect(huecos[0]?.compatibleEntryIds).toEqual(["wl-f01", "wl-f02"]);

    // --- Escenario 10: el aviso simulado.
    // (step 23, R2) El paso humano que faltaba: una persona aprueba la
    // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    expect((await comando(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    expect((await entradaDeListaDeEspera(app, "wl-f01")).state).toBe("notice_simulated");
    expect((await comando(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
    expect((await entradaDeListaDeEspera(app, "wl-f01")).state).toBe("accepted");

    // --- Escenario 11: la conversión, con el id determinista de siempre.
    const conversion = await convertir(app, "wl-f01", HUECO_1300_ALEX);
    expect(conversion.statusCode).toBe(200);
    const nueva = (conversion.json() as Json).reservation as Json;
    expect(nueva).toMatchObject({
      id: "res-wl-wl-f01-2026-08-04-780-3",
      employeeId: ALEX,
      serviceId: 1,
      date: "2026-08-04",
      startMinutes: 780,
      endMinutes: 810,
      status: "confirmed",
    });

    // En LAS DOS copias (criterio 9 de step 17).
    const { agenda, almacen } = await citasDe(app);
    expect(agenda.some((r) => r.id === nueva.id)).toBe(true);
    expect(almacen.some((r) => r.id === nueva.id)).toBe(true);

    // --- El registro, entero y en orden. Los once de step 17 siguen ahí,
    // en el mismo orden relativo; step 23 INTERCALA los cuatro suyos, cada
    // uno en el tic exacto en que ocurre: la propuesta automática del primer
    // hueco, la aprobación humana, y —al convertir— la reoferta del hermano
    // de las 13:30 con su propia propuesta pendiente.
    expect((await historialDeListaDeEspera(app)).map((e) => e.kind)).toEqual([
      "DEMO_RESET",
      "RESERVATION_CANCELLED_ON_TIME",
      "SLOT_RELEASED",
      "WAITLIST_MATCH_EVALUATED",
      "WAITLIST_ENTRY_MATCHED",
      "WAITLIST_ENTRY_MATCHED",
      "WAITLIST_PROPOSAL_CREATED",
      "SLOT_RELEASED",
      "WAITLIST_MATCH_EVALUATED",
      "WAITLIST_PROPOSAL_APPROVED",
      "WAITLIST_NOTICE_SIMULATED",
      "WAITLIST_OFFER_ACCEPTED",
      "WAITLIST_ENTRY_CONVERTED",
      "WAITLIST_ENTRY_MATCHED",
      "WAITLIST_PROPOSAL_CREATED",
    ]);

    // --- Las métricas derivadas, una a una.
    expect((await waitlistOf(app)).metrics).toMatchObject({
      waitlistOptInsRecorded: 0,
      waitlistOptInsDeclined: 0,
      slotsReleasedTotal: 2,
      slotsReleasedWithCompatibles: 2,
      noticesSimulated: 1,
      conversions: 1,
      lateCancellationsUnderReview: 0,
      actionsRequiringAPerson: 1,
      conversionConflictsPrevented: 0,
      idempotentReplays: 0,
      injectedFailuresHandled: 0,
      unfilledReleasedSlotMinutes: 30,
    });

    // --- Los estados de las seis entradas semilla.
    expect(((await waitlistOf(app)).entries as Json[]).map((e) => [e.id, e.state])).toEqual([
      ["wl-f01", "converted"],
      ["wl-f02", "matched"],
      ["wl-f03", "pending"],
      ["wl-f04", "pending"],
      ["wl-f05", "pending"],
      ["wl-f06", "pending"],
    ]);

    // --- Las tareas: la del hueco convertido se cierra, la del hermano no.
    const tareas = await tareasHumanas(app);
    expect(tareas.map((t) => [t.id, t.open])).toEqual([
      [`decidir-hueco-${HUECO_1300_ALEX}`, false],
      [`decidir-hueco-${HUECO_1330_ALEX}`, true],
    ]);

    // --- Y el registro de operaciones de step 18 no se ha enterado de nada.
    expect((await historialDeOperaciones(app)).map((e) => e.kind)).toEqual(["DEMO_RESET"]);
    await app.close();
  });

  it("(escenario 12) el hueco robado por una llamada antes de convertir sigue dando 409 y cero reservas nuevas", async () => {
    const app = freshApp();
    await reset(app);
    await cancelar(app, RES_ALEX_1300);
    // (step 23, R2) El paso humano que faltaba: una persona aprueba la
    // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    await comando(app, "wl-f01", "simulate_notice");
    await comando(app, "wl-f01", "record_acceptance");

    const llamada = await ejecutarEscenario(app, "A01-roba-las-1300", {
      utterance: "quiero reservar una cita",
      day: "tuesday",
      time: "13:00",
      professionalId: ALEX,
      serviceId: 1,
      serviceConfirmed: true,
      bookingConfirmed: true,
    });
    expect(llamada.statusCode).toBe(200);
    expect((llamada.json() as Json).reasonCode).toBe("BOOKING_CONFIRMED");

    const conversion = await convertir(app, "wl-f01", HUECO_1300_ALEX);
    expect(conversion.statusCode).toBe(409);
    expect((conversion.json() as Json).conflict).toBe("slot_no_longer_free");

    expect((await citasDe(app)).agenda.filter((r) => String(r.id).startsWith("res-wl-"))).toEqual([]);
    expect((await entradaDeListaDeEspera(app, "wl-f01")).state).toBe("pending");
    expect((await tareasHumanas(app)).some((t) => t.id === "conflicto-conversion-wl-f01" && t.open === true)).toBe(true);
    expect((await waitlistOf(app)).metrics).toMatchObject({ conversionConflictsPrevented: 1, conversions: 0 });
    await app.close();
  });

  it("(criterio 8.24, capa HTTP) los dos registros no se mezclan: ni un evento de step 18 en el de la lista de espera", async () => {
    const app = freshApp();
    await reset(app);
    await cancelar(app, RES_ALEX_1300);
    // (step 23, R2) El paso humano que faltaba: una persona aprueba la
    // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    await comando(app, "wl-f01", "simulate_notice");
    await comando(app, "wl-f01", "record_acceptance");
    await convertir(app, "wl-f01", HUECO_1300_ALEX);

    const deListaEspera = (await historialDeListaDeEspera(app)).map((e) => String(e.kind));
    for (const prohibido of [
      "NO_SHOW_RECORDED",
      "NO_SHOW_CORRECTED",
      "NO_SHOW_COMMAND_REPEATED",
      "DEMO_CLOCK_ADVANCED",
      "RESERVATION_GROUP_CREATED",
      "RESERVATION_GROUP_LINE_CREATED",
      "RESERVATION_GROUP_REPEATED",
    ]) {
      expect(deListaEspera, prohibido).not.toContain(prohibido);
    }

    const deOperaciones = (await historialDeOperaciones(app)).map((e) => String(e.kind));
    for (const ajeno of deListaEspera.filter((k) => k !== "DEMO_RESET")) {
      expect(deOperaciones, ajeno).not.toContain(ajeno);
    }
    expect(deOperaciones).toEqual(["DEMO_RESET"]);
    await app.close();
  });

  it("una acción de lista de espera no emite ni un evento de piloto ni uno interno, tampoco ahora", async () => {
    const app = freshApp();
    await reset(app);
    const antes = (await snapshotOf(app)).eventCounts;
    await cancelar(app, RES_ALEX_1300);
    // (step 23, R2) El paso humano que faltaba: una persona aprueba la
    // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    await comando(app, "wl-f01", "simulate_notice");
    await comando(app, "wl-f01", "record_acceptance");
    await convertir(app, "wl-f01", HUECO_1300_ALEX);
    expect((await snapshotOf(app)).eventCounts).toEqual(antes);
    await app.close();
  });
});
