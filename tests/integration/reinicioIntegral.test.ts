import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import {
  ALEX,
  DANI,
  type Json,
  type LineaDeGrupo,
  RES_ALEX_0930,
  RES_ALEX_1300,
  anotarInasistencia,
  avanzarMinutos,
  HUECO_1300_ALEX,
  aprobarPropuesta,
  cancelar,
  citasDe,
  claveDeAnotacion,
  comando,
  crearGrupo,
  ejecutarEscenario,
  freshApp,
  gruposDe,
  historialDeListaDeEspera,
  historialDeOperaciones,
  huellaCompleta,
  operationsOf,
  post,
  proponerGrupo,
  reset,
  snapshotOf,
  waitlistOf,
} from "./harness.js";

/**
 * step 18 · fase H — EL REINICIO CONTRA LOS SEIS DOMINIOS A LA VEZ.
 *
 * `tests/console/console.test.ts` (prueba 8) ya compara la instantánea tras
 * un reinicio con la de un servidor recién construido, pero ensucia UN solo
 * dominio: una llamada del Laboratorio. Aquí se ensucian los seis —llamadas,
 * cancelación, lista de espera con oferta viva, inasistencia anotada, grupo
 * creado y reloj movido— y se compara la instantánea COMPLETA, incluidos los
 * dos bloques que step 18 añadió (`operations`, con sus grupos, su registro
 * y su reloj). Cierra la parte de integración de los criterios 8.9 y 8.10.
 */

const LINEAS: LineaDeGrupo[] = [
  { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 660 },
  { memberLabel: "Menor B", serviceId: 1, employeeId: DANI, startMinutes: 660 },
];

/** Ensucia los SEIS dominios, en el orden en que un operador los tocaría. */
async function ensuciarloTodo(app: FastifyInstance): Promise<void> {
  // 1 — una llamada del Laboratorio, que además reserva.
  const llamada = await ejecutarEscenario(app, "A01-siembra-integral", {
    utterance: "quiero reservar una cita",
    day: "wednesday",
    time: "10:00",
    professionalId: ALEX,
    serviceId: 1,
    serviceConfirmed: true,
    bookingConfirmed: true,
  });
  expect(llamada.statusCode).toBe(200);

  // 2 — una cancelación, que libera dos huecos y empareja entradas.
  expect((await cancelar(app, RES_ALEX_1300)).statusCode).toBe(200);

  // 3 — una oferta VIVA sobre la lista de espera.
  // (step 23, R2) El paso humano que faltaba: una persona aprueba la
  // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
  await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
  expect((await comando(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);

  // 4 — una política de cancelación cambiada a mano.
  expect((await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: 240 })).statusCode).toBe(200);

  // 5 — un grupo creado.
  expect((await crearGrupo(app, LINEAS, "siembra:grupo:1", { arrangement: "simultaneous" })).statusCode).toBe(201);

  // 6 — el reloj movido, y una inasistencia anotada con la clave proyectada.
  expect((await avanzarMinutos(app, 120)).statusCode).toBe(200);
  expect((await anotarInasistencia(app, RES_ALEX_0930, await claveDeAnotacion(app, RES_ALEX_0930))).statusCode).toBe(201);
}

describe("step 18 · integración §1.5 — POST /api/reset devuelve el mundo ENTERO al principio", () => {
  it("sembrados los seis dominios, la instantánea tras el reinicio es BYTE A BYTE la de un servidor recién construido", async () => {
    const referencia = freshApp();
    const esperada = await huellaCompleta(referencia);
    await referencia.close();

    const app = freshApp();
    await ensuciarloTodo(app);
    const sucia = await huellaCompleta(app);
    expect(sucia).not.toBe(esperada);

    expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
    expect(await huellaCompleta(app)).toBe(esperada);
    await app.close();
  });

  it("bloque a bloque: llamadas, agenda, lista de espera, operaciones, grupos e inasistencias vuelven a su punto de partida", async () => {
    const referencia = freshApp();
    const base = await snapshotOf(referencia);
    await referencia.close();

    const app = freshApp();
    await ensuciarloTodo(app);
    await post(app, "/api/reset", {});
    const tras = await snapshotOf(app);

    // Se comparan uno a uno para que un fallo diga QUÉ dominio se quedó
    // hablando del mundo anterior, en vez de un diff de cien kilobytes.
    // step 19 §6.4: "demo" entra aquí igual que las demás — es enteramente
    // derivada de los otros seis bloques.
    for (const clave of ["calls", "reservations", "eventCounts", "humanQueue", "calendar", "waitlist", "operations", "demo"]) {
      expect(JSON.stringify(tras[clave]), clave).toBe(JSON.stringify(base[clave]));
    }
    // Y ninguna clave nueva ni perdida.
    expect(Object.keys(tras).sort()).toEqual(Object.keys(base).sort());
    await app.close();
  });

  /**
   * step 19 §5.3.6 (enmienda B3), criterio de aceptación 31 — tras
   * `ensuciarloTodo` (que mueve el reloj, anota una inasistencia, crea un
   * grupo y cancela/convierte lista de espera) los dos guiones tienen
   * `doneCount > 0`; tras el reinicio, `doneCount === 0` EN LOS DOS y ningún
   * paso de ninguno está en `hecho` — y la luz de precondición vuelve a
   * estar «lista», sin contar en ninguno de los tres números del progreso.
   */
  it("tras el reinicio, los dos guiones del espacio de evaluación para Bruno tienen doneCount === 0 y ningún paso en 'hecho'", async () => {
    const app = freshApp();
    await ensuciarloTodo(app);
    const sucio = await snapshotOf(app);
    const guiasSucias = ((sucio.demo as Json).guides as Json[]);
    expect(guiasSucias.some((g) => (g.doneCount as number) > 0)).toBe(true);

    await post(app, "/api/reset", {});
    const limpio = await snapshotOf(app);
    const demo = limpio.demo as Json;
    for (const guia of demo.guides as Json[]) {
      expect(guia.doneCount, `${String(guia.id)}.doneCount`).toBe(0);
      expect(
        (guia.steps as Json[]).some((s) => s.evidenceState === "hecho"),
        `${String(guia.id)} tiene un paso en 'hecho' tras el reinicio`,
      ).toBe(false);
    }
    expect((demo.startingPoint as Json).ready).toBe(true);
    await app.close();
  });

  it("el reloj vuelve a las 09:00 y el DEMO_RESET de los DOS registros queda sellado con esa hora, no con la avanzada", async () => {
    const app = freshApp();
    await ensuciarloTodo(app);
    await post(app, "/api/reset", {});

    const operations = await operationsOf(app);
    expect(operations.clock).toMatchObject({
      dateISO: "2026-08-04",
      minutes: 540,
      label: "martes 4 de agosto, 09:00",
      advancedByMinutes: 0,
      advancedLabel: null,
    });

    // El orden normativo del §1.5: el reloj PRIMERO. Si se restaurase después,
    // estos dos sellos llevarían las 11:00.
    const deOperaciones = await historialDeOperaciones(app);
    expect(deOperaciones.map((e) => e.kind)).toEqual(["DEMO_RESET"]);
    expect(deOperaciones[0]?.atISO).toBe("2026-08-04T09:00:00");

    const deListaEspera = await historialDeListaDeEspera(app);
    expect(deListaEspera.map((e) => e.kind)).toEqual(["DEMO_RESET"]);
    expect(deListaEspera[0]?.atISO).toBe("2026-08-04T09:00:00");

    // Y las seis entradas semilla vuelven a nacer a las 09:00.
    const entradas = (await waitlistOf(app)).entries as Json[];
    expect(entradas.length).toBe(6);
    expect(entradas.every((e) => e.createdAtISO === "2026-08-04T09:00:00")).toBe(true);
    expect(entradas.every((e) => e.state === "pending")).toBe(true);
    await app.close();
  });

  it("no queda ni un grupo, ni una inasistencia, ni una cita creada por la siembra", async () => {
    const app = freshApp();
    await ensuciarloTodo(app);
    await post(app, "/api/reset", {});

    expect(await gruposDe(app)).toEqual([]);
    const operations = await operationsOf(app);
    expect((operations.noShows as Json).records).toEqual([]);
    expect((operations.metrics as Json).clockAdvances).toBe(0);

    const { agenda, almacen } = await citasDe(app);
    expect(agenda.filter((r) => String(r.id).startsWith("res-g-"))).toEqual([]);
    expect(agenda.filter((r) => String(r.id).startsWith("res-wl-"))).toEqual([]);
    expect(almacen).toEqual([]);
    await app.close();
  });
});

describe("step 18 · integración §4.7 — un reinicio en medio de una confirmación pendiente", () => {
  it("la propuesta se pidió ANTES del reinicio y choca con el mundo restaurado: 409 y ninguna escritura fantasma", async () => {
    const app = freshApp();
    await reset(app);
    // Con `demo-salon-res-2` cancelada, las 13:00 de Álex están libres y el motor
    // las propone. El operador se queda esa propuesta en la mano.
    expect((await cancelar(app, RES_ALEX_1300)).statusCode).toBe(200);
    const propuestas = ((await proponerGrupo(app, "simultaneous", [
      { memberLabel: "Adulto A", serviceId: 1, professional: { kind: "specific", employeeId: ALEX } },
      { memberLabel: "Menor B", serviceId: 1, professional: { kind: "specific", employeeId: DANI } },
    ])).json() as Json).proposals as Json[];
    expect(propuestas.length).toBeGreaterThan(0);

    // Otro operador reinicia la demostración. `demo-salon-res-2` vuelve a estar
    // confirmada: las 13:00 de Álex han dejado de existir como hueco.
    expect((await post(app, "/api/reset", {})).statusCode).toBe(200);

    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 780 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI, startMinutes: 780 },
    ];
    const creada = await crearGrupo(app, lineas, "tras-reinicio:choca:1", { arrangement: "simultaneous" });
    expect(creada.statusCode).toBe(409);
    const cuerpo = creada.json() as Json;
    expect(cuerpo.conflict).toBe("slot_no_longer_free");
    expect((cuerpo.line as Json).when).toBe("13:00");

    // La revalidación decide, y decide contra el mundo NUEVO: nada escrito.
    expect(await gruposDe(app)).toEqual([]);
    expect((await citasDe(app)).agenda.filter((r) => String(r.id).startsWith("res-g-"))).toEqual([]);
    expect((await historialDeOperaciones(app)).map((e) => e.kind)).toEqual(["DEMO_RESET"]);
    await app.close();
  });

  it("una propuesta que SÍ sobrevive al reinicio se crea contra el mundo nuevo, y la numeración empieza otra vez en grp-0001", async () => {
    const app = freshApp();
    await reset(app);
    // Primero un grupo cualquiera, para que el contador de grupos avance.
    expect((await crearGrupo(app, LINEAS, "antes-del-reinicio:1", { arrangement: "simultaneous" })).statusCode).toBe(201);
    expect((await gruposDe(app)).map((g) => g.id)).toEqual(["grp-0001"]);

    const propuestas = ((await proponerGrupo(app, "simultaneous", [
      { memberLabel: "Persona 1", serviceId: 1, professional: { kind: "specific", employeeId: ALEX } },
      { memberLabel: "Persona 2", serviceId: 1, professional: { kind: "specific", employeeId: DANI } },
    ])).json() as Json).proposals as Json[];
    const elegida = propuestas[0] as Json;
    const lineas: LineaDeGrupo[] = (elegida.lines as Json[]).map((l) => ({
      memberLabel: String(l.memberLabel),
      serviceId: l.serviceId as 0 | 1 | 2,
      employeeId: Number(l.employeeId),
      startMinutes: Number(l.startMinutes),
    }));

    expect((await post(app, "/api/reset", {})).statusCode).toBe(200);

    // La clave que la propuesta acuñó vale igual: el registro de idempotencia
    // también se vació, así que no hay ningún replay que mienta sobre un
    // mundo que ya no existe.
    const creada = await crearGrupo(app, lineas, String(elegida.intentKeyToMint), { arrangement: "simultaneous", date: BOOKING_DEMO_TODAY });
    expect(creada.statusCode).toBe(201);
    expect(creada.headers["idempotency-status"]).toBe("original");
    expect((await gruposDe(app)).map((g) => g.id)).toEqual(["grp-0001"]);
    expect(((creada.json() as Json).reservations as Json[]).map((r) => r.id)).toEqual([
      "res-g-grp-0001-1",
      "res-g-grp-0001-2",
    ]);
    await app.close();
  });
});

// =====================================================================
// step 26 · B9 — REINICIAR SE LLEVA TAMBIÉN LAS CITAS LARGAS
//
// Una cita de duración especial no es un caso aparte del reinicio: tiene que
// desaparecer entera, con su evento y con la anotación de origen que ese evento
// sostiene, y la instantánea tiene que volver a ser BYTE A BYTE la de un
// servidor recién construido. Si algo de la duración flexible se guardase en un
// sitio que el reinicio no barre, esta comparación lo destaparía.
//
// Lo que NO firma: ninguna pantalla y ningún navegador.
// =====================================================================

describe("step 26 · B9 — el reinicio y una cita manual de duración especial", () => {
  /** 14:15–16:30 con Álex: desalineada, larga y con su evento de origen. */
  async function crearCitaLarga(app: FastifyInstance): Promise<string> {
    const previa = await post(app, "/api/booking/manual/preview", {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: BOOKING_DEMO_TODAY,
      startMinutes: 14 * 60 + 15,
      durationMinutes: 135,
      professional: { kind: "specific", employeeId: ALEX },
    });
    expect(previa.statusCode, previa.body).toBe(200);
    const propuesta = (previa.json() as Json).proposal as Json;
    expect(propuesta, previa.body).not.toBeNull();
    const creada = await post(
      app,
      "/api/booking/manual",
      { ...(propuesta.confirm as Json), durationMinutes: 135, confirmed: true },
      { "idempotency-key": propuesta.keyToMint as string },
    );
    expect(creada.statusCode, creada.body).toBe(201);
    return ((creada.json() as Json).booking as Json).reservationId as string;
  }

  it("tras reiniciar, la instantánea vuelve a ser byte a byte la de un servidor recién construido", async () => {
    const referencia = freshApp();
    const esperada = await huellaCompleta(referencia);
    await referencia.close();

    const app = freshApp();
    await crearCitaLarga(app);
    const sucia = await huellaCompleta(app);
    expect(sucia).not.toBe(esperada);

    expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
    expect(await huellaCompleta(app)).toBe(esperada);
    await app.close();
  });

  it("no queda ni la cita, ni su evento, ni la anotación de origen que ese evento sostenía", async () => {
    const app = freshApp();
    const reservaId = await crearCitaLarga(app);

    const conCita = await snapshotOf(app);
    const fila = (conCita.reservations as Json[]).find((r) => r.id === reservaId) as Json;
    expect(fila.endMinutes).toBe(14 * 60 + 150);
    expect(fila.manual).toBeDefined();
    expect(
      (await historialDeOperaciones(app)).filter((e) => e.kind === "RESERVATION_MANUAL_CREATED"),
    ).toHaveLength(1);

    await post(app, "/api/reset", {});

    const tras = await snapshotOf(app);
    expect((tras.reservations as Json[]).find((r) => r.id === reservaId)).toBeUndefined();
    expect((tras.reservations as Json[]).filter((r) => r.manual !== undefined)).toEqual([]);
    expect((await historialDeOperaciones(app)).map((e) => e.kind)).toEqual(["DEMO_RESET"]);
    // Y el hueco de las 14:15 vuelve a estar disponible para una cita larga.
    const otra = await post(app, "/api/booking/manual/preview", {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: BOOKING_DEMO_TODAY,
      startMinutes: 14 * 60 + 15,
      durationMinutes: 135,
      professional: { kind: "specific", employeeId: ALEX },
    });
    expect((otra.json() as Json).proposal).not.toBeNull();
    await app.close();
  });
});
