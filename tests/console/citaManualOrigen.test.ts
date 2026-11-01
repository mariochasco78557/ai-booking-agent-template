import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildManualBookingAnnotations } from "../../src/console/operationsSnapshot.js";
import { buildConsoleServer } from "../../src/console/server.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import {
  manualBookingIdFor,
  manualIntentKey,
  manualReservationIdFor,
  type ManualBooking,
  type OperationsAuditEvent,
} from "../../src/callEngine/operations/model.js";
import type { OperationsStoreSnapshot } from "../../src/callEngine/operations/store.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 24 §11.1 · DE DÓNDE SALE «Creada manualmente por el operador».
 *
 * El diseño dice una frase corta y exigente: ese origen se DERIVA del evento
 * `RESERVATION_MANUAL_CREATED`. Una frase así sólo vale si algo la vigila,
 * porque la implementación tenía a mano un atajo cómodo —recorrer
 * `ops.manualBookings` y anotar— que da el mismo resultado en el camino feliz
 * y deja de darlo en cuanto el registro y la lista discrepan. Ese atajo es el
 * que hace que la verdad viva en dos sitios, y el que este fichero cierra.
 *
 * La regla que se fija aquí, y que ninguna pantalla puede arreglar después:
 *
 *   el evento es LA PUERTA (sin evento no hay origen),
 *   `manualBookings` es sólo EL DATO (a nombre de quién, y qué cita es).
 *
 * Las tres primeras pruebas le hablan a la función directamente, que es donde
 * se puede construir la discrepancia a mano; las dos últimas comprueban que el
 * camino real —HTTP, almacén y reinicio de verdad— sigue contando lo mismo.
 * ────────────────────────────────────────────────────────────────────────
 */

const SAL = "cita-manual-origen-test-salt";
const HORA_LIBRE = 11 * 60;
const SERVICIO = 1 as const;

/**
 * Una cita manual escrita, con la forma exacta que acuña el almacén. Desde
 * step 26 la duración es un dato suyo —y de su clave de intención—, así que
 * este ayudante la acepta: 30 minutos es la de siempre, y las pruebas de la
 * capacidad B piden otras.
 */
function citaManual(numero: number, clientLabel: string, durationMinutes = 30): ManualBooking {
  const id = manualBookingIdFor(numero);
  return {
    id,
    reservationId: manualReservationIdFor(id),
    clientLabel,
    serviceId: SERVICIO,
    employeeId: ALEX_ID,
    date: BOOKING_DEMO_TODAY,
    startMinutes: HORA_LIBRE,
    endMinutes: HORA_LIBRE + durationMinutes,
    intentKey: manualIntentKey(BOOKING_DEMO_TODAY, HORA_LIBRE, durationMinutes, ALEX_ID, SERVICIO, clientLabel),
    createdAtISO: "2026-08-04T09:00:00.000Z",
    createdBy: "console-operator",
    synthetic: true,
  };
}

/** El evento que ESA cita produjo al escribirse. */
function eventoDe(booking: ManualBooking, seq = 1): OperationsAuditEvent {
  return {
    id: `opa-${String(seq).padStart(8, "0")}`,
    seq,
    kind: "RESERVATION_MANUAL_CREATED",
    actor: "operator",
    atISO: booking.createdAtISO,
    reservationId: booking.reservationId,
    manualBookingId: booking.id,
    detail: {
      date: booking.date,
      serviceId: booking.serviceId,
      employeeId: booking.employeeId,
      startMinutes: booking.startMinutes,
      clientLabel: booking.clientLabel,
    },
    synthetic: true,
  };
}

function snapshotDe(
  manualBookings: readonly ManualBooking[],
  auditLog: readonly OperationsAuditEvent[],
): OperationsStoreSnapshot {
  return {
    noShows: [],
    groups: [],
    manualBookings,
    auditLog,
    nextGroupNumber: 1,
    nextManualNumber: manualBookings.length + 1,
  };
}

describe("step 24 §11.1 · el origen manual se deriva del evento, no de la lista", () => {
  it("con la cita y SU evento, la reserva gana el origen y los datos de la cita", () => {
    const cita = citaManual(1, "Cliente A");
    const anotaciones = buildManualBookingAnnotations(snapshotDe([cita], [eventoDe(cita)]));

    expect([...anotaciones.keys()]).toEqual([cita.reservationId]);
    expect(anotaciones.get(cita.reservationId)).toEqual({
      manualBookingId: cita.id,
      clientLabel: "Cliente A",
      originLabel: "Creada manualmente por el operador",
    });
  });

  it("con la cita pero SIN su evento, no se inventa ningún origen", () => {
    const cita = citaManual(1, "Cliente A");
    // El registro de operaciones no vacío, pero sin el evento que importa: si
    // la puerta fuese `manualBookings`, esto anotaría igual y el diseño
    // quedaría desmentido en silencio.
    const otroEvento: OperationsAuditEvent = {
      id: "opa-00000001",
      seq: 1,
      kind: "DEMO_CLOCK_ADVANCED",
      actor: "operator",
      atISO: "2026-08-04T09:00:00.000Z",
      detail: { fromDate: BOOKING_DEMO_TODAY, toDate: BOOKING_DEMO_TODAY, fromMinutes: 540, toMinutes: 600 },
      synthetic: true,
    };

    expect(buildManualBookingAnnotations(snapshotDe([cita], [])).size).toBe(0);
    expect(buildManualBookingAnnotations(snapshotDe([cita], [otroEvento])).size).toBe(0);
  });

  it("un evento de OTRA reserva no anota la reserva equivocada", () => {
    const laDelEvento = citaManual(1, "Cliente A");
    const laDeLaLista = citaManual(2, "Cliente B");
    // Sólo está escrita la segunda; el evento habla de la primera. Nadie debe
    // heredar el origen de nadie: ni por identificador de cita, ni por ser la
    // única candidata a mano.
    const anotaciones = buildManualBookingAnnotations(
      snapshotDe([laDeLaLista], [eventoDe(laDelEvento)]),
    );

    expect(anotaciones.size).toBe(0);
    expect(anotaciones.get(laDeLaLista.reservationId)).toBeUndefined();
    expect(anotaciones.get(laDelEvento.reservationId)).toBeUndefined();
  });

  it("y un evento que apunta a una cita que dice ser de otra reserva tampoco anota", () => {
    const cita = citaManual(1, "Cliente A");
    // Mismo `manualBookingId`, distinta reserva: las dos referencias no se
    // cuentan la misma historia, así que no hay origen que enseñar.
    const eventoTorcido: OperationsAuditEvent = {
      ...eventoDe(cita),
      reservationId: manualReservationIdFor(manualBookingIdFor(9)),
    };

    expect(buildManualBookingAnnotations(snapshotDe([cita], [eventoTorcido])).size).toBe(0);
  });
});

// ---------------------------------------------------------------------
// El camino real: mismo contrato, atravesando HTTP y el almacén de verdad.
// ---------------------------------------------------------------------

type Json = Record<string, unknown>;

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: SAL,
  });
}

async function snapshotOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as Json;
}

async function reset(app: FastifyInstance): Promise<void> {
  const res = await app.inject({ method: "POST", url: "/api/reset", payload: {} as never });
  expect(res.statusCode).toBe(200);
}

/** Previsualiza y confirma, igual que el operador en el diálogo de cinco pasos. */
async function crear(app: FastifyInstance, durationMinutes?: number): Promise<string> {
  const previa = await app.inject({
    method: "POST",
    url: "/api/booking/manual/preview",
    payload: {
      clientLabel: "Cliente A",
      serviceId: SERVICIO,
      date: BOOKING_DEMO_TODAY,
      startMinutes: HORA_LIBRE,
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      professional: { kind: "specific", employeeId: ALEX_ID },
    } as never,
  });
  expect(previa.statusCode, previa.body).toBe(200);
  const propuesta = (JSON.parse(previa.body) as Json).proposal as Json;
  expect(propuesta, `la vista previa no propuso nada: ${previa.body}`).not.toBeNull();

  const creada = await app.inject({
    method: "POST",
    url: "/api/booking/manual",
    payload: {
      ...(propuesta.confirm as Json),
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      confirmed: true,
    } as never,
    headers: { "idempotency-key": propuesta.keyToMint as string },
  });
  expect(creada.statusCode, creada.body).toBe(201);
  return ((JSON.parse(creada.body) as Json).booking as Json).reservationId as string;
}

function eventosManuales(snap: Json): Json[] {
  const items = ((snap.operations as Json).audit as Json).items as Json[];
  return items.filter((e) => e.kind === "RESERVATION_MANUAL_CREATED");
}

function reservasConOrigenManual(snap: Json): Json[] {
  return (snap.reservations as Json[]).filter((r) => r.manual !== undefined);
}

describe("step 24 §11.1 · el flujo real sigue enseñando el origen, y el reinicio se lleva los dos", () => {
  it("crear por HTTP deja el evento y la anotación, sobre la MISMA reserva", async () => {
    const app = freshApp();
    await reset(app);
    const reservaId = await crear(app);
    const snap = await snapshotOf(app);

    const eventos = eventosManuales(snap);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.reservationId).toBe(reservaId);

    const anotadas = reservasConOrigenManual(snap);
    expect(anotadas.map((r) => r.id)).toEqual([reservaId]);
    expect((anotadas[0]?.manual as Json).originLabel).toBe("Creada manualmente por el operador");
    expect((anotadas[0]?.manual as Json).clientLabel).toBe("Cliente A");
    await app.close();
  });

  it("«Reiniciar la demostración» borra el evento Y el origen derivado, a la vez", async () => {
    const app = freshApp();
    await reset(app);
    await crear(app);
    const conCita = await snapshotOf(app);
    expect(eventosManuales(conCita)).toHaveLength(1);
    expect(reservasConOrigenManual(conCita)).toHaveLength(1);

    await reset(app);
    const despues = await snapshotOf(app);
    expect(eventosManuales(despues)).toHaveLength(0);
    expect(reservasConOrigenManual(despues)).toHaveLength(0);
    await app.close();
  });
});

// =====================================================================
// step 26 · B10 — LA PUERTA DEL ORIGEN NO CAMBIA PORQUE LA CITA SEA LARGA
//
// La duración flexible no toca esta regla y no puede tocarla: el origen
// «Creada manualmente por el operador» sigue saliendo del evento
// RESERVATION_MANUAL_CREATED, no de `ops.manualBookings`. Una cita de 135
// minutos es una cita manual como cualquier otra, y una lista sin su evento
// sigue sin dar origen a nadie.
//
// Lo que NO firma: ninguna pantalla, ningún lector de pantalla y ninguna
// afirmación sobre cómo se dibuja el bloque en la agenda.
// =====================================================================

describe("step 26 §11.1 · B10 — el origen de una cita manual LARGA", () => {
  it("con la cita de 135 minutos y SU evento, la reserva gana el origen; sin el evento, no", () => {
    const larga = citaManual(1, "Cliente A", 135);
    expect(larga.endMinutes - larga.startMinutes).toBe(135);
    expect(larga.intentKey).toContain("d135");

    const conEvento = buildManualBookingAnnotations(snapshotDe([larga], [eventoDe(larga)]));
    expect(conEvento.get(larga.reservationId)).toEqual({
      manualBookingId: larga.id,
      clientLabel: "Cliente A",
      originLabel: "Creada manualmente por el operador",
    });

    // La lista SOLA no basta, y que la cita sea larga no la asciende a puerta.
    expect(buildManualBookingAnnotations(snapshotDe([larga], [])).size).toBe(0);
  });

  it("una cita de 30 y otra de 135 sobre la MISMA hora son dos intenciones distintas", () => {
    const corta = citaManual(1, "Cliente A", 30);
    const larga = citaManual(2, "Cliente A", 135);
    expect(corta.intentKey).not.toBe(larga.intentKey);
  });

  it("por HTTP, una cita de 135 minutos deja su evento y su anotación sobre la MISMA reserva", async () => {
    const app = freshApp();
    await reset(app);
    // 14:00–16:15 con Álex: cabe entero dentro del horario de agosto.
    const previa = await app.inject({
      method: "POST",
      url: "/api/booking/manual/preview",
      payload: {
        clientLabel: "Cliente A",
        serviceId: SERVICIO,
        date: BOOKING_DEMO_TODAY,
        startMinutes: 14 * 60,
        durationMinutes: 135,
        professional: { kind: "specific", employeeId: ALEX_ID },
      } as never,
    });
    expect(previa.statusCode, previa.body).toBe(200);
    const propuesta = (JSON.parse(previa.body) as Json).proposal as Json;
    expect(propuesta).not.toBeNull();

    const creada = await app.inject({
      method: "POST",
      url: "/api/booking/manual",
      payload: { ...(propuesta.confirm as Json), durationMinutes: 135, confirmed: true } as never,
      headers: { "idempotency-key": propuesta.keyToMint as string },
    });
    expect(creada.statusCode, creada.body).toBe(201);
    const reservaId = ((JSON.parse(creada.body) as Json).booking as Json).reservationId as string;

    const snap = await snapshotOf(app);
    const eventos = eventosManuales(snap);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.reservationId).toBe(reservaId);

    const anotadas = reservasConOrigenManual(snap);
    expect(anotadas.map((r) => r.id)).toEqual([reservaId]);
    expect((anotadas[0]?.manual as Json).originLabel).toBe("Creada manualmente por el operador");
    // Y la reserva dura de verdad los 135 minutos pedidos.
    expect(anotadas[0]?.startMinutes).toBe(14 * 60);
    expect(anotadas[0]?.endMinutes).toBe(14 * 60 + 135);
    await app.close();
  });
});

// =====================================================================
// step 26 (revisión adversarial, hallazgo 3) — EL REGISTRO CUENTA LA
// DURACIÓN, porque el acto que ocurrió fue crear una cita de dos horas y
// cuarto, no «una cita a las 14:00». El evento sigue siendo la puerta del
// origen; lo que cambia es que su detalle ya no se calla lo que duró.
// =====================================================================

describe("step 26 · el historial dice cuánto duraba la cita creada a mano", () => {
  it("con una duración especial, el evento la registra y la frase la dice en voz alta", async () => {
    const app = freshApp();
    await reset(app);
    const previa = await app.inject({
      method: "POST",
      url: "/api/booking/manual/preview",
      payload: {
        clientLabel: "Cliente A",
        serviceId: SERVICIO,
        date: BOOKING_DEMO_TODAY,
        startMinutes: 14 * 60,
        durationMinutes: 135,
        professional: { kind: "specific", employeeId: ALEX_ID },
      } as never,
    });
    const propuesta = (JSON.parse(previa.body) as Json).proposal as Json;
    const creada = await app.inject({
      method: "POST",
      url: "/api/booking/manual",
      payload: { ...(propuesta.confirm as Json), confirmed: true } as never,
      headers: { "idempotency-key": propuesta.keyToMint as string },
    });
    expect(creada.statusCode, creada.body).toBe(201);

    // El detalle crudo del evento NO se publica —la proyección enseña una
    // frase, no el registro por dentro—, así que lo que se comprueba aquí es su
    // consecuencia visible. Que el detalle lleve `durationMinutes`/`endMinutes`
    // lo fija la prueba de dominio, en tests/callEngine/citaManual.test.ts.
    const snap = await snapshotOf(app);
    const evento = eventosManuales(snap)[0] as Json;
    const frase = String(evento.text ?? "");
    expect(frase).toContain("2 h 15 min");
    expect(frase).toContain("16:15");
    // Y sigue sin nombrar un solo identificador interno.
    expect(frase).not.toContain("man-");
    expect(frase).not.toContain("res-m-");
    await app.close();
  });

  it("con los 30 minutos del catálogo, la frase es EXACTAMENTE la de siempre", async () => {
    const app = freshApp();
    await reset(app);
    await crear(app);
    const evento = eventosManuales(await snapshotOf(app))[0] as Json;
    const frase = String(evento.text ?? "");
    expect(frase).not.toContain("Duración especial");
    expect(frase).toContain("No ha intervenido ninguna llamada.");
    await app.close();
  });
});
