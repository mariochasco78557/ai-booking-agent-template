import { describe, it, expect } from "vitest";

import {
  createManualBooking,
  proposeManualBooking,
  type ManualBookingContext,
} from "../../src/callEngine/operations/manualBooking.js";
import {
  countManualBookingsWithIntent,
  isAllowedManualDuration,
  manualBookingIdFor,
  manualIntentKey,
  manualIntentKeyToMint,
  manualReservationIdFor,
  MANUAL_CLIENT_LABEL_RE,
  type ManualBooking,
} from "../../src/callEngine/operations/model.js";
import { fixedClock, type Clock } from "../../src/callEngine/domain/types.js";
import {
  BOOKING_DEMO_NOW_MINUTES,
  BOOKING_DEMO_TODAY,
  demoSalonVenue,
} from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import { isSlotFree } from "../../src/callEngine/calendar/resolveAvailability.js";
import { chooseProfessional } from "../../src/callEngine/allocation/anyProfessional.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 24 · EL DOMINIO DE LA CITA MANUAL, en su forma pura.
 *
 * Aquí no hay HTTP, ni navegador, ni almacén: sólo el handler y un
 * calendario. Lo que se fija en este fichero es lo que ninguna pantalla puede
 * arreglar después — que la cita manual le pregunta a LAS MISMAS funciones de
 * disponibilidad que el motor de llamadas, que un conflicto no escribe nada, y
 * que repetir no crea dos citas mientras cancelar sí vuelve a permitir crear.
 * ────────────────────────────────────────────────────────────────────────
 */

const RELOJ = () => fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);

/** Un martes 4 de agosto a las 11:00: dentro del horario de agosto, libre para Álex. */
const HORA_LIBRE = 11 * 60;

function ctxDe(
  cal: CalendarWithCapabilities = demoSalonVenue(),
  manualBookings: readonly ManualBooking[] = [],
  clock: Clock = RELOJ(),
  nextManualNumber = 1,
): ManualBookingContext {
  return { cal, clock, manualBookings, nextManualNumber };
}

/** Aplica al calendario lo que el handler dice que hay que escribir. */
function aplicar(ctx: ManualBookingContext, resultado: ReturnType<typeof createManualBooking>): ManualBookingContext {
  const write = resultado.write;
  if (write === null) return ctx;
  return {
    ...ctx,
    cal: write.nextCal ?? ctx.cal,
    manualBookings: write.manualBookings ?? ctx.manualBookings,
    nextManualNumber: ctx.nextManualNumber + (write.manualBookingsMinted ?? 0),
  };
}

/**
 * La petición de siempre. `durationMinutes` es OBLIGATORIO en el dominio desde
 * step 26 §1 —el único valor por defecto de toda la capacidad vive en la
 * frontera HTTP—, así que aquí se escribe: son los 30 minutos del catálogo,
 * dichos en voz alta.
 */
const PETICION_VALIDA = {
  clientLabel: "Cliente A",
  serviceId: 1 as const,
  date: BOOKING_DEMO_TODAY,
  startMinutes: HORA_LIBRE,
  durationMinutes: 30,
  employeeId: ALEX_ID,
};

describe("step 24 · dominio — crear una cita manual", () => {
  it("crea la cita, la reserva de 30 minutos y UN evento, todo en la misma escritura", () => {
    const ctx = ctxDe();
    const r = createManualBooking(ctx, PETICION_VALIDA);

    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    const write = r.write;
    expect(write).not.toBeNull();

    // La reserva: treinta minutos, leídos del calendario y no escritos a mano.
    const reserva = (write?.reservationsToAdd ?? [])[0];
    expect(reserva).toBeDefined();
    expect(reserva?.endMinutes! - reserva?.startMinutes!).toBe(ctx.cal.slotMinutes);
    expect(reserva?.status).toBe("confirmed");
    expect(reserva?.synthetic).toBe(true);
    expect(reserva?.id).toBe(manualReservationIdFor(manualBookingIdFor(1)));

    // LAS DOS COPIAS en la misma escritura: el calendario y el espejo.
    expect(write?.nextCal?.reservations.some((x) => x.id === reserva?.id)).toBe(true);
    expect(write?.reservationsToAdd).toHaveLength(1);

    // UN evento, del catálogo de operaciones, y ninguno de llamada.
    expect(write?.events.map((e) => e.kind)).toEqual(["RESERVATION_MANUAL_CREATED"]);
    expect(write?.events[0]?.actor).toBe("operator");

    // Y la cita, sin estado propio que pueda discrepar de su reserva.
    const cita = (write?.manualBookings ?? [])[0];
    expect(cita?.createdBy).toBe("console-operator");
    expect(cita?.clientLabel).toBe("Cliente A");
    expect(Object.keys(cita ?? {})).not.toContain("state");
    expect(write?.manualBookingsMinted).toBe(1);
  });

  it("NO crea tareas humanas, NO cancela nada y NO emite un solo evento de llamada", () => {
    const r = createManualBooking(ctxDe(), PETICION_VALIDA);
    const write = r.write;
    expect(write?.tasksToAdd ?? []).toEqual([]);
    expect(write?.tasksToComplete ?? []).toEqual([]);
    expect(write?.reservationsToCancel ?? []).toEqual([]);
    // El catálogo de operaciones no contiene ningún evento de llamada, y esto
    // lo comprueba de forma que un `kind` nuevo mal elegido lo rompería.
    for (const ev of write?.events ?? []) {
      expect(ev.kind.startsWith("CALL_")).toBe(false);
      expect(JSON.stringify(ev)).not.toContain("callId");
    }
  });

  it("la reserva creada OCUPA el hueco para todo el mundo, porque vive en el mismo calendario", () => {
    const ctx = ctxDe();
    expect(isSlotFree(ctx.cal, ALEX_ID, BOOKING_DEMO_TODAY, HORA_LIBRE)).toBe(true);

    const despues = aplicar(ctx, createManualBooking(ctx, PETICION_VALIDA));

    // La MISMA función que usan el motor, el explorador y la lista de espera.
    expect(isSlotFree(despues.cal, ALEX_ID, BOOKING_DEMO_TODAY, HORA_LIBRE)).toBe(false);
    // Y sigue libre para los demás: se ocupa un hueco, no una franja horaria.
    expect(isSlotFree(despues.cal, DANI_ID, BOOKING_DEMO_TODAY, HORA_LIBRE)).toBe(true);
  });

  it("los tres servicios del catálogo cerrado se pueden crear", () => {
    for (const serviceId of [0, 1, 2] as const) {
      const ctx = ctxDe();
      // Álex hace los tres; Nerea no hace el 0, y eso se prueba aparte.
      const r = createManualBooking(ctx, { ...PETICION_VALIDA, serviceId });
      expect(r.status, `servicio ${String(serviceId)}`).toBe(201);
    }
  });

  it("con «cualquier profesional», quien decide es `chooseProfessional` y nadie más", () => {
    const ctx = ctxDe();
    // El paso 2 del flujo resuelve con la MISMA función que el motor.
    const elegido = chooseProfessional(ctx.cal, BOOKING_DEMO_TODAY, HORA_LIBRE, 1);
    expect(elegido.employeeId).not.toBeNull();

    const r = createManualBooking(ctx, { ...PETICION_VALIDA, employeeId: elegido.employeeId! });
    expect(r.status).toBe(201);

    // Determinista: dos veces la misma pregunta, la misma respuesta.
    expect(chooseProfessional(demoSalonVenue(), BOOKING_DEMO_TODAY, HORA_LIBRE, 1).employeeId).toBe(elegido.employeeId);
  });
});

describe("step 24 · dominio — la revalidación, y que un conflicto no escribe NADA", () => {
  it("hueco ya ocupado: 409 `slot_no_longer_free` y `write` en null", () => {
    const ctx = ctxDe();
    const primera = aplicar(ctx, createManualBooking(ctx, PETICION_VALIDA));

    // Otra persona sintética pidiendo EL MISMO hueco al mismo profesional.
    const segunda = createManualBooking(primera, { ...PETICION_VALIDA, clientLabel: "Cliente B" });
    expect(segunda.status).toBe(409);
    expect(segunda.body.conflict).toBe("slot_no_longer_free");
    expect(segunda.write).toBeNull();
  });

  it("el profesional no hace ese servicio: se dice eso, y no «el hueco está ocupado»", () => {
    // Nerea no hace el servicio 0. La verdad es la incapacidad, no el hueco.
    const r = createManualBooking(ctxDe(), {
      ...PETICION_VALIDA,
      employeeId: NEREA_ID,
      serviceId: 0,
    });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toBe("professional_cannot_perform_service");
    expect(r.write).toBeNull();
  });

  it("una hora que ya ha pasado se llama PASADO, aunque también quede fuera del horizonte", () => {
    // El reloj sintético marca las 09:00; las 08:00 de hoy ya pasaron.
    const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes: 8 * 60 });
    expect(r.status).toBe(409);
    // EL ORDEN ES NORMATIVO: para un día ido las dos cosas son ciertas y la
    // que ayuda es ésta.
    expect(r.body.conflict).toBe("slot_in_the_past");
  });

  it("un día anterior a hoy también es PASADO, no «fuera del horizonte»", () => {
    const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, date: "2026-08-03" });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toBe("slot_in_the_past");
    expect(r.body.reasons).toContain("date_outside_booking_horizon");
  });

  it("más allá del horizonte de reserva: se dice el horizonte", () => {
    // 90 días de horizonte desde el 2026-08-04.
    const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, date: "2027-08-04" });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toBe("date_outside_booking_horizon");
  });

  it("un día que el local no abre se llama CERRADO, no «ese hueco no está libre»", () => {
    // Lunes 10 de agosto: el local no declara fila para el lunes, ni en la
    // temporada de agosto ni fuera de ella.
    const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, date: "2026-08-10" });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toBe("venue_closed");
    expect(r.write).toBeNull();
  });

  it("una hora fuera del horario de ese día, con el local abierto, se llama NO DISPONIBLE", () => {
    // Martes de agosto: 09:00–17:30. Las 18:00 caen fuera del horario, pero el
    // local abre ese día, así que no es un cierre.
    const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes: 18 * 60 });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toBe("professional_no_longer_available");
  });

  it("el horario de AGOSTO manda: las 09:00 del 4 de agosto valen, y las 09:00 de septiembre no", () => {
    // Agosto abre a las 09:00; septiembre–julio, a las 09:30.
    expect(createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes: 9 * 60 }).status).toBe(201);

    // Martes 1 de septiembre de 2026, a las 09:00: todavía no ha abierto.
    const septiembre = createManualBooking(ctxDe(), {
      ...PETICION_VALIDA,
      date: "2026-09-01",
      startMinutes: 9 * 60,
    });
    expect(septiembre.status).toBe(409);
    // Y a las 09:30 de ese mismo día, sí.
    expect(
      createManualBooking(ctxDe(), { ...PETICION_VALIDA, date: "2026-09-01", startMinutes: 9 * 60 + 30 }).status,
    ).toBe(201);
  });

  it("agosto de 2026 NO se repite en 2027: allí manda el horario ordinario", () => {
    // El horizonte impide llegar a 2027 desde el reloj de la demostración, así
    // que se pregunta con un reloj situado en agosto de 2027. La temporada
    // fechada (`does_not_repeat`) no debe aplicarse allí: a las 09:00 de un
    // martes de agosto de 2027 el local todavía no ha abierto, porque rige el
    // horario ordinario de 09:30.
    const relojDe2027 = fixedClock("2027-08-03", 8 * 60);
    const ctx = ctxDe(demoSalonVenue(), [], relojDe2027);
    expect(createManualBooking(ctx, { ...PETICION_VALIDA, date: "2027-08-03", startMinutes: 9 * 60 }).status).toBe(409);
    expect(
      createManualBooking(ctx, { ...PETICION_VALIDA, date: "2027-08-03", startMinutes: 9 * 60 + 30 }).status,
    ).toBe(201);
  });

  it("una etiqueta que no es del catálogo cerrado es un 400, y no escribe nada", () => {
    for (const etiqueta of ["Pedro", "Cliente Z", "Cliente A ", "cliente a", "<b>Cliente A</b>", ""]) {
      const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, clientLabel: etiqueta });
      expect(r.status, etiqueta).toBe(400);
      expect(r.write, etiqueta).toBeNull();
    }
  });
});

describe("step 24 · dominio — idempotencia estructural", () => {
  it("repetir la misma intención con la cita viva no crea una segunda", () => {
    const ctx = ctxDe();
    const primera = createManualBooking(ctx, PETICION_VALIDA);
    const estado = aplicar(ctx, primera);

    const repetida = createManualBooking(estado, PETICION_VALIDA);
    expect(repetida.status).toBe(200);
    expect(repetida.body.created).toBe(false);
    expect(repetida.body.alreadyExists).toBe(true);
    // Apunta a LA MISMA cita.
    expect(repetida.viewManualBookingId).toBe((primera.write?.manualBookings ?? [])[0]?.id);
    // Y no escribe ninguna reserva nueva: sólo deja constancia de la repetición.
    expect(repetida.write?.reservationsToAdd ?? []).toEqual([]);
    expect(repetida.write?.events.map((e) => e.kind)).toEqual(["RESERVATION_MANUAL_REPEATED"]);
  });

  it("CANCELAR rompe la repetición: la misma intención vuelve a crear, y eso es la verdad", () => {
    const ctx = ctxDe();
    const estado = aplicar(ctx, createManualBooking(ctx, PETICION_VALIDA));
    const reservaId = manualReservationIdFor(manualBookingIdFor(1));

    // La cancelación, tal y como la deja el flujo existente: la reserva pasa a
    // `cancelled` en el calendario.
    const trasCancelar: ManualBookingContext = {
      ...estado,
      cal: {
        ...estado.cal,
        reservations: estado.cal.reservations.map((r) =>
          r.id === reservaId ? { ...r, status: "cancelled" as const } : r,
        ),
      },
    };

    const segunda = createManualBooking(trasCancelar, PETICION_VALIDA);
    // Decir «ya estaba creada» aquí sería mentir y perder la cita en silencio:
    // es el bloqueante B2 de step 18, que no se reintroduce.
    expect(segunda.status).toBe(201);
    expect(segunda.body.created).toBe(true);
    expect((segunda.write?.manualBookings ?? []).at(-1)?.id).toBe(manualBookingIdFor(2));
  });

  /**
   * ACTUALIZADA A PROPÓSITO POR step 26 §3 (C5 del normativo). Esta prueba
   * fijaba el literal `"manual:2026-08-04:660-3-1:A"`, sin duración. La clave
   * la lleva ahora SIEMPRE, en un token propio pegado al inicio (`660d30`),
   * también cuando vale 30: un valor implícito dentro de una clave de identidad
   * es exactamente el supuesto oculto que esta misión prohíbe, y sin él dos
   * peticiones de duración distinta sobre la misma hora colisionarían como si
   * fueran la misma intención.
   */
  it("la intención se deriva del CONTENIDO, incluye a la PERSONA y la DURACIÓN, y encaja en el formato de clave", () => {
    const clave = manualIntentKey(BOOKING_DEMO_TODAY, HORA_LIBRE, 30, ALEX_ID, 1, "Cliente A");
    expect(clave).toBe("manual:2026-08-04:660d30-3-1:A");
    expect(/^[A-Za-z0-9_:.-]{8,200}$/.test(clave)).toBe(true);
    // Viaja la LETRA, no la etiqueta: el espacio no cabría en el formato.
    expect(clave).not.toContain("Cliente");
    expect(clave).not.toContain(" ");

    // Dos personas distintas son DOS intenciones distintas. La primera
    // redacción del diseño las confundía, y por eso «Cliente B pide el hueco de
    // Cliente A» contestaba «ya estaba creada» en vez de «acaba de ocuparse».
    expect(manualIntentKey(BOOKING_DEMO_TODAY, HORA_LIBRE, 30, ALEX_ID, 1, "Cliente B")).not.toBe(clave);

    // Y DOS DURACIONES distintas sobre el mismo inicio también son dos
    // intenciones distintas: es el caso nuevo de step 26.
    expect(manualIntentKey(BOOKING_DEMO_TODAY, HORA_LIBRE, 135, ALEX_ID, 1, "Cliente A")).toBe(
      "manual:2026-08-04:660d135-3-1:A",
    );
    expect(manualIntentKey(BOOKING_DEMO_TODAY, HORA_LIBRE, 135, ALEX_ID, 1, "Cliente A")).not.toBe(clave);

    // Y la clave de transporte lleva el discriminante de repetición, sin cambios.
    expect(manualIntentKeyToMint(clave, 0)).toBe("manual:2026-08-04:660d30-3-1:A:r0");
    expect(/^[A-Za-z0-9_:.-]{8,200}$/.test(manualIntentKeyToMint(clave, 2))).toBe(true);
    // La duración más larga posible son tres cifras, y la clave sigue cumpliendo
    // el patrón de transporte con ella (la `d` es una letra, no un separador nuevo).
    const laMasLarga = manualIntentKeyToMint(
      manualIntentKey(BOOKING_DEMO_TODAY, HORA_LIBRE, 240, ALEX_ID, 1, "Cliente A"),
      99,
    );
    expect(laMasLarga).toBe("manual:2026-08-04:660d240-3-1:A:r99");
    expect(/^[A-Za-z0-9_:.-]{8,200}$/.test(laMasLarga)).toBe(true);
  });

  it("otra persona sobre el mismo hueco NO es una repetición: es un conflicto", () => {
    const ctx = ctxDe();
    const estado = aplicar(ctx, createManualBooking(ctx, PETICION_VALIDA));
    const otra = createManualBooking(estado, { ...PETICION_VALIDA, clientLabel: "Cliente C" });
    expect(otra.status).toBe(409);
    expect(otra.body.conflict).toBe("slot_no_longer_free");
    expect(otra.write).toBeNull();
  });

  it("`countManualBookingsWithIntent` cuenta las creadas, y cancelar no la baja", () => {
    const ctx = ctxDe();
    const estado = aplicar(ctx, createManualBooking(ctx, PETICION_VALIDA));
    const clave = manualIntentKey(BOOKING_DEMO_TODAY, HORA_LIBRE, 30, ALEX_ID, 1, "Cliente A");
    expect(countManualBookingsWithIntent(estado.manualBookings, clave)).toBe(1);
    expect(countManualBookingsWithIntent(estado.manualBookings, "manual:2026-08-04:0d30-3-1:A")).toBe(0);
    // Contar por intención cuenta ahora POR DURACIÓN, que es lo correcto: la
    // misma hora con otra duración no es la misma cita.
    expect(
      countManualBookingsWithIntent(
        estado.manualBookings,
        manualIntentKey(BOOKING_DEMO_TODAY, HORA_LIBRE, 90, ALEX_ID, 1, "Cliente A"),
      ),
    ).toBe(0);
  });
});

describe("step 24 · dominio — privacidad e identidad", () => {
  it("la expresión de la etiqueta es CERRADA: seis personas y ni una más", () => {
    for (const buena of ["Cliente A", "Cliente B", "Cliente C", "Cliente D", "Cliente E", "Cliente F"]) {
      expect(MANUAL_CLIENT_LABEL_RE.test(buena), buena).toBe(true);
    }
    for (const mala of ["Cliente G", "Cliente AA", "Cliente 1", "Clienta A", "Cliente", "Cliente a"]) {
      expect(MANUAL_CLIENT_LABEL_RE.test(mala), mala).toBe(false);
    }
  });

  it("la cita escrita no tiene NINGÚN campo donde quepa un dato personal", () => {
    const r = createManualBooking(ctxDe(), PETICION_VALIDA);
    const cita = (r.write?.manualBookings ?? [])[0];
    const claves = Object.keys(cita ?? {});
    for (const prohibida of ["phone", "telefono", "email", "correo", "note", "nota", "address", "direccion", "name", "nombre"]) {
      expect(claves, prohibida).not.toContain(prohibida);
    }
    // Y la única cadena libre que lleva es la etiqueta cerrada.
    expect(MANUAL_CLIENT_LABEL_RE.test(cita?.clientLabel ?? "")).toBe(true);
  });

  it("el identificador sale de la SECUENCIA, no del hueco: cancelar y recrear no lo reutiliza", () => {
    expect(manualBookingIdFor(1)).toBe("man-0001");
    expect(manualBookingIdFor(42)).toBe("man-0042");
    expect(manualReservationIdFor("man-0001")).toBe("res-m-man-0001");
  });
});

// =====================================================================
// step 26 · B3 y B4 — LA DURACIÓN FLEXIBLE, EN EL DOMINIO
//
// La anulación es SÓLO de la cita manual: ni el catálogo, ni el explorador
// general, ni el motor de llamadas cambian de duración por su culpa. Lo que
// aquí se fija es que el intervalo pedido se escribe entero, que no se puede
// pedir cualquier cosa, y que la clave de intención distingue duraciones.
//
// Lo que NO firman: ninguna pantalla, ningún texto de navegador y ninguna
// política comercial de duración (nadie ha dado una, y esta misión no la
// inventa: el tope de 240 minutos es estructural).
// =====================================================================

describe("step 26 §1 · B3 — la duración pedida se escribe tal cual", () => {
  it("30, 60, 90, 120, 135 y 150 minutos escriben el `endMinutes` exacto", () => {
    // 11:00 en adelante Álex tiene libre hasta las 13:00, y de 14:00 a 17:30.
    // Los tramos largos se piden a las 14:00, donde caben todos.
    for (const [durationMinutes, startMinutes] of [
      [30, 11 * 60],
      [60, 11 * 60],
      [90, 11 * 60],
      [120, 14 * 60],
      [135, 14 * 60],
      [150, 14 * 60],
    ] as const) {
      const ctx = ctxDe();
      const r = createManualBooking(ctx, { ...PETICION_VALIDA, startMinutes, durationMinutes });
      expect(r.status, `duración ${String(durationMinutes)}`).toBe(201);
      const reserva = (r.write?.reservationsToAdd ?? [])[0];
      expect(reserva?.startMinutes, `duración ${String(durationMinutes)}`).toBe(startMinutes);
      expect(reserva?.endMinutes, `duración ${String(durationMinutes)}`).toBe(startMinutes + durationMinutes);
      // Y la cita escrita dice lo mismo que su reserva, sin una segunda verdad.
      const cita = (r.write?.manualBookings ?? [])[0];
      expect(cita?.endMinutes).toBe(reserva?.endMinutes);
    }
  });

  it("inicios a :15 y a :45 son inicios como cualquier otro", () => {
    for (const startMinutes of [11 * 60 + 15, 11 * 60 + 45, 14 * 60 + 15, 14 * 60 + 45]) {
      const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes, durationMinutes: 45 });
      expect(r.status, String(startMinutes)).toBe(201);
      expect((r.write?.reservationsToAdd ?? [])[0]?.endMinutes).toBe(startMinutes + 45);
    }
  });

  it("una duración que no cabe en el día se rechaza con la verdad del calendario, no con un 400", () => {
    // 16:30 + 120 minutos se sale del cierre de las 17:30 de la temporada de agosto.
    const r = createManualBooking(ctxDe(), {
      ...PETICION_VALIDA,
      startMinutes: 16 * 60 + 30,
      durationMinutes: 120,
    });
    expect(r.status).toBe(409);
    // Y se llama por su nombre: no es que la persona no esté —está, y a esa
    // hora trabaja—, es que lo pedido no cabe (revisión adversarial, hallazgo 2).
    expect(r.body.conflict).toBe("interval_does_not_fit");
    expect(r.write).toBeNull();
    // Y 60 minutos ahí mismo sí caben, hasta el cierre exacto.
    expect(
      createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes: 16 * 60 + 30, durationMinutes: 60 }).status,
    ).toBe(201);
  });

  /**
   * step 26, revisión adversarial, hallazgo 2. Tres situaciones que antes
   * contestaban todas «Esa persona del equipo ya no está disponible a esa
   * hora», y que son tres cosas distintas. La frase importa: la primera invita
   * a acortar la cita, la segunda a mirar el día especial, y la tercera a mirar
   * el horario. Decirlas igual manda al operador a buscar donde no es.
   */
  it("distingue «no cabe lo pedido» de «esa persona no trabaja a esa hora»", () => {
    // (a) 16:45 + 60 contra el cierre de las 17:30: el inicio SÍ está en un
    // tramo libre suyo; lo que no entra es la hora entera.
    const noCabe = createManualBooking(ctxDe(), {
      ...PETICION_VALIDA,
      startMinutes: 16 * 60 + 45,
      durationMinutes: 60,
    });
    expect(noCabe.status).toBe(409);
    expect(noCabe.body.conflict).toBe("interval_does_not_fit");
    // Y el intento viaja completo, para que una pantalla pueda decir la verdad
    // sin recalcular nada: principio, fin y minutos pedidos.
    expect((noCabe.body.attempted as Record<string, unknown>).when).toBe("16:45");
    expect((noCabe.body.attempted as Record<string, unknown>).until).toBe("17:45");
    expect((noCabe.body.attempted as Record<string, unknown>).durationMinutes).toBe(60);

    // (b) 45 minutos ahí mismo sí caben, hasta el cierre exacto: el conflicto
    // anterior era de duración y no de persona, y esto lo demuestra.
    expect(
      createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes: 16 * 60 + 45, durationMinutes: 45 }).status,
    ).toBe(201);

    // (c) Las 23:00: ahí no trabaja nadie, y eso es lo que se dice. El inicio
    // no cae en ningún tramo libre, así que NO es un problema de duración.
    const deMadrugada = createManualBooking(ctxDe(), {
      ...PETICION_VALIDA,
      startMinutes: 23 * 60,
      durationMinutes: 240,
    });
    expect(deMadrugada.status).toBe(409);
    expect(deMadrugada.body.conflict).toBe("professional_no_longer_available");
  });

  it("un día con horario especial REDUCIDO también dice que no cabe, no que la persona falte", () => {
    // Miércoles 5 de agosto, con una apertura especial aprobada de 09:00 a
    // 11:00: a las 10:30 Álex trabaja, pero no le caben 60 minutos.
    const cal = demoSalonVenue();
    const conDiaEspecial: CalendarWithCapabilities = {
      ...cal,
      venueRules: [
        {
          id: "apertura-reducida-m26",
          kind: "special_opening",
          scope: "venue",
          date: "2026-08-05",
          closed: false,
          specialOpen: "09:00",
          specialClose: "11:00",
          source: "manual_override",
          approval: "approved",
          audit: { createdAt: "2026-08-01T09:00:00", createdBy: "test-fixture" },
        },
      ],
    };
    const ctx = ctxDe(conDiaEspecial);
    const r = createManualBooking(ctx, {
      ...PETICION_VALIDA,
      date: "2026-08-05",
      startMinutes: 10 * 60 + 30,
      durationMinutes: 60,
    });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toBe("interval_does_not_fit");
    // Y 30 minutos, hasta las 11:00 exactas, sí caben.
    expect(
      createManualBooking(ctx, {
        ...PETICION_VALIDA,
        date: "2026-08-05",
        startMinutes: 10 * 60 + 30,
        durationMinutes: 30,
      }).status,
    ).toBe(201);
  });

  it("una cita justo detrás también hace que «no quepa», sin culpar a la persona", () => {
    // Álex tiene 13:00–14:00 ocupado. A las 12:15 trabaja y está libre, pero
    // 60 minutos chocarían con esa cita: lo que se dice es que hay una cita
    // (solapamiento), no que no quepa el tramo.
    const r = createManualBooking(ctxDe(), {
      ...PETICION_VALIDA,
      startMinutes: 12 * 60 + 15,
      durationMinutes: 60,
    });
    expect(r.status).toBe(409);
    expect(r.body.conflict).toBe("slot_no_longer_free");
    // Y 45 minutos, justo hasta las 13:00, caben.
    expect(
      createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes: 12 * 60 + 15, durationMinutes: 45 }).status,
    ).toBe(201);
  });

  it("el evento del registro deja escrita la DURACIÓN, no sólo la hora de inicio", () => {
    const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes: 14 * 60, durationMinutes: 135 });
    const evento = (r.write?.events ?? [])[0];
    expect(evento?.kind).toBe("RESERVATION_MANUAL_CREATED");
    expect(evento?.detail?.durationMinutes).toBe(135);
    expect(evento?.detail?.endMinutes).toBe(14 * 60 + 135);
    expect(evento?.detail?.startMinutes).toBe(14 * 60);
  });

  it("un intervalo que CRUZA otra cita no se escribe, aunque su inicio esté libre", () => {
    // Álex tiene 13:00–14:00 ocupado en el fixture. 12:30 está libre; 12:30–13:30 no.
    const r = createManualBooking(ctxDe(), {
      ...PETICION_VALIDA,
      startMinutes: 12 * 60 + 30,
      durationMinutes: 60,
    });
    expect(r.status).toBe(409);
    // Solapamiento de rango: la frase correcta es la del HUECO, no la de la persona.
    expect(r.body.conflict).toBe("slot_no_longer_free");
    expect(r.write).toBeNull();
  });

  it("una duración fuera de contrato es un 400 que no escribe nada, y NO un conflicto", () => {
    for (const durationMinutes of [20, 0, -15, 245, 12.5, 241, 14]) {
      const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, durationMinutes });
      expect(r.status, String(durationMinutes)).toBe(400);
      expect(r.body.code, String(durationMinutes)).toBe("duration_not_allowed");
      expect(r.body.error, String(durationMinutes)).toBe(
        "Esa duración no es válida: sólo se puede elegir en pasos de 15 minutos.",
      );
      expect(r.write, String(durationMinutes)).toBeNull();
    }
    // Los dos extremos del rango sí son válidos como FORMA.
    expect(isAllowedManualDuration(15)).toBe(true);
    expect(isAllowedManualDuration(240)).toBe(true);
    expect(isAllowedManualDuration(30)).toBe(true);
    expect(isAllowedManualDuration(0)).toBe(false);
  });

  it("la vista previa rechaza la misma duración imposible, y con el mismo código", () => {
    const r = proposeManualBooking(ctxDe(), {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: BOOKING_DEMO_TODAY,
      startMinutes: HORA_LIBRE,
      durationMinutes: 20,
      professional: { kind: "specific", employeeId: ALEX_ID },
    });
    expect(r.proposal).toBeUndefined();
    expect(r.rejected?.conflict).toBe("duration_not_allowed");
    expect(r.rejected?.reasons).toEqual(["duration_not_allowed"]);
  });

  it("la vista previa y la creación prometen EL MISMO intervalo", () => {
    const ctx = ctxDe();
    const previa = proposeManualBooking(ctx, {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: BOOKING_DEMO_TODAY,
      startMinutes: 14 * 60 + 15,
      durationMinutes: 135,
      professional: { kind: "specific", employeeId: ALEX_ID },
    });
    expect(previa.proposal?.startMinutes).toBe(14 * 60 + 15);
    expect(previa.proposal?.endMinutes).toBe(14 * 60 + 15 + 135);

    const creada = createManualBooking(ctx, {
      ...PETICION_VALIDA,
      startMinutes: 14 * 60 + 15,
      durationMinutes: 135,
    });
    const reserva = (creada.write?.reservationsToAdd ?? [])[0];
    expect(reserva?.startMinutes).toBe(previa.proposal?.startMinutes);
    expect(reserva?.endMinutes).toBe(previa.proposal?.endMinutes);
  });

  it("una cita LARGA bloquea todos los inicios de 30 que solapa, para la voz y para todos", () => {
    const ctx = ctxDe();
    const despues = aplicar(
      ctx,
      createManualBooking(ctx, { ...PETICION_VALIDA, startMinutes: 14 * 60 + 15, durationMinutes: 135 }),
    );
    // 14:15–16:30 con Álex. La rejilla de 30 de la voz pierde 14:30, 15:00,
    // 15:30 y 16:00 —y también las 14:00, cuyo bloque de 30 ya no cabe entero.
    for (const inicio of [14 * 60, 14 * 60 + 30, 15 * 60, 15 * 60 + 30, 16 * 60]) {
      expect(isSlotFree(despues.cal, ALEX_ID, BOOKING_DEMO_TODAY, inicio), String(inicio)).toBe(false);
    }
    // Y lo de fuera sigue libre: se ocupa un intervalo, no la tarde entera.
    expect(isSlotFree(despues.cal, ALEX_ID, BOOKING_DEMO_TODAY, 16 * 60 + 30)).toBe(true);
    expect(isSlotFree(despues.cal, DANI_ID, BOOKING_DEMO_TODAY, 15 * 60)).toBe(true);
  });

  it("«cualquier profesional» elige a alguien libre durante TODO el intervalo", () => {
    const ctx = ctxDe();
    // A las 16:00 Nerea tiene cita (16:00–17:00) y Dani también (16:00–16:30):
    // sólo Álex puede con 90 minutos seguidos desde las 16:00.
    const elegido = chooseProfessional(ctx.cal, BOOKING_DEMO_TODAY, 16 * 60, 1, 90);
    expect(elegido.employeeId).toBe(ALEX_ID);
    const r = createManualBooking(ctx, {
      ...PETICION_VALIDA,
      startMinutes: 16 * 60,
      durationMinutes: 90,
      employeeId: elegido.employeeId!,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe("step 26 §3 · B4 — la clave de intención distingue duraciones", () => {
  it("la misma hora con dos duraciones son DOS citas, no una repetición", () => {
    const ctx = ctxDe();
    const treinta = createManualBooking(ctx, { ...PETICION_VALIDA, startMinutes: 14 * 60, durationMinutes: 30 });
    expect(treinta.status).toBe(201);
    const estado = aplicar(ctx, treinta);

    // La MISMA hora, la misma persona, el mismo servicio, otra duración: no es
    // «ya estaba creada» —eso describiría una cita que no es la suya—, sino un
    // conflicto honesto contra la cita que acaba de escribirse.
    const noventa = createManualBooking(estado, { ...PETICION_VALIDA, startMinutes: 14 * 60, durationMinutes: 90 });
    expect(noventa.status).toBe(409);
    expect(noventa.body.conflict).toBe("slot_no_longer_free");
    expect(noventa.body.alreadyExists).toBeUndefined();
    expect(noventa.write).toBeNull();
  });

  it("la cita escrita guarda la clave CON la duración", () => {
    const r = createManualBooking(ctxDe(), { ...PETICION_VALIDA, startMinutes: 14 * 60, durationMinutes: 135 });
    const cita = (r.write?.manualBookings ?? [])[0];
    expect(cita?.intentKey).toBe(
      manualIntentKey(BOOKING_DEMO_TODAY, 14 * 60, 135, ALEX_ID, 1, "Cliente A"),
    );
    expect(cita?.intentKey).toContain("d135");
  });

  it("repetir la MISMA petición larga sigue sin crear una segunda cita", () => {
    const ctx = ctxDe();
    const larga = { ...PETICION_VALIDA, startMinutes: 14 * 60, durationMinutes: 135 };
    const primera = createManualBooking(ctx, larga);
    const estado = aplicar(ctx, primera);
    const repetida = createManualBooking(estado, larga);
    expect(repetida.status).toBe(200);
    expect(repetida.body.alreadyExists).toBe(true);
    expect(repetida.viewManualBookingId).toBe((primera.write?.manualBookings ?? [])[0]?.id);
    expect(repetida.write?.reservationsToAdd ?? []).toEqual([]);
  });
});
