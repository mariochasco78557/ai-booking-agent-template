import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY, demoSalonVenue } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createManualBooking } from "../../src/callEngine/operations/manualBooking.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 24 · REVISIÓN ADVERSARIAL — intentar ROMPER la cita manual.
 *
 * Este fichero no comprueba que la funcionalidad funcione: eso ya lo hacen las
 * pruebas de dominio y las de HTTP. Aquí se intenta, a propósito, que escriba
 * dos veces, que escriba sobre algo ocupado, que mienta sobre lo que ha hecho o
 * que deje la demostración con dos versiones de la verdad.
 *
 * Cada bloque lleva el nombre del ataque, no el de la funcionalidad.
 * ────────────────────────────────────────────────────────────────────────
 */

const SAL = "cita-manual-adversarial";
const HORA_LIBRE = 11 * 60;

type Json = Record<string, unknown>;

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: SAL,
  });
}

async function post(app: FastifyInstance, url: string, payload: unknown, headers?: Record<string, string>) {
  return app.inject({ method: "POST", url, payload: payload as never, ...(headers !== undefined ? { headers } : {}) });
}

async function snapshotOf(app: FastifyInstance): Promise<Json> {
  return JSON.parse((await app.inject({ method: "GET", url: "/api/snapshot" })).body) as Json;
}

async function reset(app: FastifyInstance): Promise<void> {
  expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
}

/** Una vista previa: exactamente lo que ve una pestaña abierta antes de confirmar. */
async function previa(app: FastifyInstance, extra: Json = {}): Promise<Json | null> {
  const res = await post(app, "/api/booking/manual/preview", {
    clientLabel: "Cliente A",
    serviceId: 1,
    date: BOOKING_DEMO_TODAY,
    startMinutes: HORA_LIBRE,
    professional: { kind: "specific", employeeId: ALEX_ID },
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as Json).proposal as Json | null;
}

/** Confirma UNA propuesta concreta, con SU clave: es lo que haría esa pestaña. */
async function confirmar(app: FastifyInstance, propuesta: Json, extra: Json = {}) {
  return post(
    app,
    "/api/booking/manual",
    { ...(propuesta.confirm as Json), confirmed: true, ...extra },
    { "idempotency-key": propuesta.keyToMint as string },
  );
}

async function crear(app: FastifyInstance, extra: Json = {}) {
  const p = await previa(app, extra);
  expect(p).not.toBeNull();
  // step 26 §13: la duración viaja en las DOS peticiones, porque es parte de
  // lo que se pidió, no de lo que el servidor resolvió.
  return confirmar(app, p as Json, extra.durationMinutes !== undefined ? { durationMinutes: extra.durationMinutes } : {});
}

function manuales(snap: Json): Json[] {
  return (snap.reservations as Json[]).filter((r) => r.manual !== undefined);
}

// =====================================================================
// A · DOS ESCRITURAS DONDE DEBERÍA HABER UNA
// =====================================================================

describe("step 24 · adversarial — dos escrituras donde debería haber una", () => {
  it("DOBLE CLIC: dos peticiones idénticas seguidas dejan UNA cita", async () => {
    const app = freshApp();
    await reset(app);
    const p = (await previa(app)) as Json;
    // Los dos clics salen de la MISMA propuesta, con la MISMA clave: es
    // exactamente lo que hace un doble clic sobre el botón de confirmar.
    const uno = await confirmar(app, p);
    const dos = await confirmar(app, p);
    expect(uno.statusCode).toBe(201);
    expect(dos.statusCode).toBe(200);
    expect((JSON.parse(dos.body) as Json).alreadyExists).toBe(true);
    expect(manuales(await snapshotOf(app))).toHaveLength(1);
    await app.close();
  });

  it("DOS PESTAÑAS: las dos ven el hueco libre, las dos confirman, sólo una escribe", async () => {
    const app = freshApp();
    await reset(app);
    // Las dos pestañas previsualizan ANTES de que ninguna confirme, así que
    // las dos creen que el hueco está libre.
    const pestañaA = (await previa(app)) as Json;
    const pestañaB = (await previa(app, { clientLabel: "Cliente B" })) as Json;
    expect(pestañaA).not.toBeNull();
    expect(pestañaB).not.toBeNull();
    // Y llevan claves DISTINTAS, porque piden cosas distintas: la idempotencia
    // no puede salvarnos aquí, tiene que salvarnos la revalidación.
    expect(pestañaA.keyToMint).not.toBe(pestañaB.keyToMint);

    const primera = await confirmar(app, pestañaA);
    const segunda = await confirmar(app, pestañaB);
    expect(primera.statusCode).toBe(201);
    expect(segunda.statusCode).toBe(409);
    expect((JSON.parse(segunda.body) as Json).conflict).toBe("slot_no_longer_free");
    expect((JSON.parse(segunda.body) as Json).message).toBe(
      "Ese hueco acaba de ocuparse. No se ha creado ninguna cita.",
    );
    expect(manuales(await snapshotOf(app))).toHaveLength(1);
    await app.close();
  });

  it("INSTANTÁNEA VIEJA: se previsualiza, una LLAMADA se lleva el hueco, y confirmar falla", async () => {
    const app = freshApp();
    await reset(app);
    const p = (await previa(app)) as Json;

    // Entre la vista previa y la confirmación, el motor de llamadas reserva.
    await post(app, "/api/scenario/run", {
      scenarioId: "A91-la-llamada-se-adelanta",
      turns: [
        {
          utterance: "quiero reservar",
          day: "tuesday",
          time: "11:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });

    const res = await confirmar(app, p);
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as Json).conflict).toBe("slot_no_longer_free");
    expect(manuales(await snapshotOf(app))).toHaveLength(0);
    await app.close();
  });

  it("EL CALENDARIO CAMBIA entre elegir y confirmar: una ausencia publicada tumba la confirmación", async () => {
    const app = freshApp();
    await reset(app);
    // Mañana, para que la ausencia se pueda publicar sin discutir con el hoy.
    const mañana = "2026-08-05";
    const p = (await previa(app, { date: mañana })) as Json;
    expect(p).not.toBeNull();

    const publicada = await post(app, "/api/calendar/publish", {
      change: {
        changeKind: "employee_absence",
        id: "ausencia-adversarial-1",
        employeeId: ALEX_ID,
        absenceKind: "absence",
        startDate: mañana,
        endDate: mañana,
        allDay: true,
      },
      resolutions: {},
    });
    expect(publicada.statusCode, publicada.body).toBe(200);

    const res = await confirmar(app, p);
    expect(res.statusCode).toBe(409);
    // La razón que se le da al operador es la de la PERSONA, no la del hueco:
    // el local abre, quien no está es Álex.
    expect((JSON.parse(res.body) as Json).conflict).toBe("professional_no_longer_available");
    expect(manuales(await snapshotOf(app))).toHaveLength(0);
    await app.close();
  });

  it("«CUALQUIERA» QUE PIERDE DISPONIBILIDAD: se resuelve en X, X se ocupa, y confirmar falla honestamente", async () => {
    const app = freshApp();
    await reset(app);
    const p = (await previa(app, { professional: { kind: "any" } })) as Json;
    expect(p).not.toBeNull();
    const elegido = (p.confirm as Json).employeeId as number;

    // Se ocupa EXACTAMENTE a esa persona en ese hueco, con otra cita manual.
    const robo = (await previa(app, {
      clientLabel: "Cliente F",
      professional: { kind: "specific", employeeId: elegido },
    })) as Json;
    expect((await confirmar(app, robo)).statusCode).toBe(201);

    // La confirmación de la primera pestaña NO se reasigna sola a otra
    // persona: se pidió «cualquiera», pero el resumen ya nombró a alguien y el
    // operador confirmó ESO. Reasignar en silencio sería crear una cita que
    // nadie ha revisado.
    const res = await confirmar(app, p);
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as Json).conflict).toBe("slot_no_longer_free");
    expect(manuales(await snapshotOf(app)).filter((r) => r.status === "confirmed")).toHaveLength(1);
    await app.close();
  });

  it("CANCELAR Y VOLVER A CREAR: se puede, y son dos citas distintas, no una resucitada", async () => {
    const app = freshApp();
    await reset(app);
    const primera = await crear(app);
    const idPrimera = ((JSON.parse(primera.body) as Json).booking as Json).id;
    const reservaId = ((JSON.parse(primera.body) as Json).booking as Json).reservationId as string;

    await post(
      app,
      `/api/reservations/${reservaId}/cancel`,
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": `cxl-${reservaId}` },
    );

    // Una vista previa NUEVA: acuña una clave nueva, porque ya hay una cita con
    // esta intención (aunque esté cancelada).
    const p2 = (await previa(app)) as Json;
    expect(p2.keyToMint).not.toBe(idPrimera);
    const segunda = await confirmar(app, p2);
    expect(segunda.statusCode).toBe(201);
    expect(((JSON.parse(segunda.body) as Json).booking as Json).id).not.toBe(idPrimera);

    const snap = await snapshotOf(app);
    expect(manuales(snap)).toHaveLength(2);
    expect(manuales(snap).filter((r) => r.status === "confirmed")).toHaveLength(1);
    await app.close();
  });
});

// =====================================================================
// B · LA CITA MANUAL CONTRA LA LISTA DE ESPERA
// =====================================================================

describe("step 24 · adversarial — la cita manual y la lista de espera", () => {
  /** Cancela `demo-salon-res-2` y devuelve la clave del hueco de las 13:00. */
  async function liberarElHuecoDeLaUna(app: FastifyInstance): Promise<string> {
    const res = await post(
      app,
      "/api/reservations/demo-salon-res-2/cancel",
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": "cxl-res-2" },
    );
    expect(res.statusCode).toBe(200);
    return "slot-2026-08-04-780-3";
  }

  it("una cita manual OCUPA un hueco propuesto a la lista de espera, y la propuesta deja de valer", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await liberarElHuecoDeLaUna(app);

    // Hay una propuesta viva sobre ese hueco.
    let hueco = (((await snapshotOf(app)).waitlist as Json).releasedSlots as Json[]).find((s) => s.key === slotKey) as Json;
    expect((hueco.proposal as Json).statusCode).toBe("pending_approval");

    // El operador crea una cita manual JUSTO ahí.
    const creada = await crear(app, { startMinutes: 13 * 60, clientLabel: "Cliente E" });
    expect(creada.statusCode, creada.body).toBe(201);

    // La propuesta no se borra en silencio: se muestra ROTA, con su motivo.
    hueco = (((await snapshotOf(app)).waitlist as Json).releasedSlots as Json[]).find((s) => s.key === slotKey) as Json;
    expect((hueco.proposal as Json).statusCode).toBe("invalidated");
    expect(((hueco.proposal as Json).invalidReasons as Json[]).map((r) => r.code)).toContain("slot_no_longer_free");
    expect(hueco.stillFree).toBe(false);
    await app.close();
  });

  it("la lista de espera NO puede convertir sobre un hueco que se llevó una cita manual", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await liberarElHuecoDeLaUna(app);

    // Se recorre el ciclo humano hasta dejar a la persona en `accepted`.
    expect((await post(app, "/api/waitlist/entries/wl-f01/command", { command: "approve_proposal", slotKey })).statusCode).toBe(200);
    expect((await post(app, "/api/waitlist/entries/wl-f01/command", { command: "simulate_notice" })).statusCode).toBe(200);
    expect((await post(app, "/api/waitlist/entries/wl-f01/command", { command: "record_acceptance" })).statusCode).toBe(200);

    // …y JUSTO ANTES de convertir, el operador crea una cita manual ahí.
    expect((await crear(app, { startMinutes: 13 * 60, clientLabel: "Cliente E" })).statusCode).toBe(201);

    const convertir = await post(
      app,
      "/api/waitlist/entries/wl-f01/convert",
      { slotKey, confirmed: true },
      { "idempotency-key": "convert-adversarial-1" },
    );
    expect(convertir.statusCode).toBe(409);
    expect((JSON.parse(convertir.body) as Json).conflict).toBe("slot_no_longer_free");

    // Y en ese hueco sigue habiendo UNA cita: la manual.
    const enElHueco = (await snapshotOf(app)).reservations as Json[];
    const ahi = enElHueco.filter(
      (r) => r.date === BOOKING_DEMO_TODAY && r.startMinutes === 13 * 60 && r.employeeId === ALEX_ID && r.status === "confirmed",
    );
    expect(ahi).toHaveLength(1);
    expect(ahi[0]?.manual).toBeDefined();
    await app.close();
  });

  it("cancelar una cita manual ABRE una reoferta supervisada: propuesta pendiente, nadie avisado", async () => {
    const app = freshApp();
    await reset(app);
    // Una cita manual a las 13:00 con DANI, dentro de la ventana que la lista
    // de espera sabe querer (13:00–14:00, cualquier profesional). Con Álex no
    // vale: a esa hora ya tiene la cita de la demostración, y crear ahí sería
    // imposible — que es justo lo que comprueban las dos pruebas de arriba.
    const creada = await crear(app, {
      startMinutes: 13 * 60,
      clientLabel: "Cliente E",
      professional: { kind: "specific", employeeId: DANI_ID },
    });
    const reservaId = ((JSON.parse(creada.body) as Json).booking as Json).reservationId as string;

    const antes = ((await snapshotOf(app)).waitlist as Json).releasedSlots as Json[];

    const cancelada = await post(
      app,
      `/api/reservations/${reservaId}/cancel`,
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": `cxl-${reservaId}` },
    );
    expect(cancelada.statusCode, cancelada.body).toBe(200);

    const w = (await snapshotOf(app)).waitlist as Json;
    const despues = w.releasedSlots as Json[];
    // EXACTAMENTE un hueco más, de 30 minutos.
    expect(despues.length - antes.length).toBe(1);
    const nuevo = despues.find((s) => !antes.some((a) => a.key === s.key)) as Json;
    expect(nuevo).toBeDefined();

    // La lista de espera lo EVALÚA y propone… pero no avisa a nadie ni reserva.
    const propuesta = nuevo.proposal as Json | null;
    expect(propuesta).not.toBeNull();
    expect(propuesta?.statusCode).toBe("pending_approval");
    // Ni un aviso simulado, ni una aceptación, ni una conversión.
    const eventos = ((w.audit as Json).items as Json[]).map((e) => e.kind);
    expect(eventos).not.toContain("WAITLIST_NOTICE_SIMULATED");
    expect(eventos).not.toContain("WAITLIST_OFFER_ACCEPTED");
    expect(eventos).not.toContain("WAITLIST_ENTRY_CONVERTED");
    await app.close();
  });
});

// =====================================================================
// C · REINICIO Y CONVIVENCIA CON EL RESTO
// =====================================================================

describe("step 24 · adversarial — reinicio y convivencia", () => {
  it("REINICIAR con una cita manual recién creada la borra, y la clave vieja ya no vale para nada", async () => {
    const app = freshApp();
    await reset(app);
    const p = (await previa(app)) as Json;
    expect((await confirmar(app, p)).statusCode).toBe(201);

    await reset(app);
    expect(manuales(await snapshotOf(app))).toHaveLength(0);

    // La MISMA clave, después del reinicio: no puede replicar una respuesta
    // sobre un mundo que ya no existe, así que crea de verdad.
    const res = await confirmar(app, p);
    expect(res.statusCode).toBe(201);
    expect((JSON.parse(res.body) as Json).created).toBe(true);
    await app.close();
  });

  it("convive con una RESERVA DE GRUPO: ninguna de las dos pisa a la otra", async () => {
    const app = freshApp();
    await reset(app);

    // Un grupo de dos, en el primer hueco que el propio servidor proponga.
    const prop = await post(app, "/api/booking/group/proposals", {
      arrangement: "consecutive",
      date: BOOKING_DEMO_TODAY,
      lines: [
        { memberLabel: "Persona 1", serviceId: 1, professional: { kind: "any" } },
        { memberLabel: "Persona 2", serviceId: 1, professional: { kind: "any" } },
      ],
    });
    expect(prop.statusCode).toBe(200);
    const propuesta = ((JSON.parse(prop.body) as Json).proposals as Json[])[0] as Json;
    expect(propuesta).toBeDefined();

    const creado = await post(
      app,
      "/api/booking/groups",
      {
        arrangement: propuesta.arrangement,
        date: propuesta.date,
        lines: (propuesta.lines as Json[]).map((l) => ({
          memberLabel: l.memberLabel,
          serviceId: l.serviceId,
          employeeId: l.employeeId,
          startMinutes: l.startMinutes,
        })),
        confirmed: true,
      },
      { "idempotency-key": propuesta.intentKeyToMint as string },
    );
    expect(creado.statusCode, creado.body).toBe(201);

    // Ahora una cita manual sobre EL PRIMER hueco del grupo: tiene que chocar.
    const primeraLinea = (propuesta.lines as Json[])[0] as Json;
    const choque = await previa(app, {
      startMinutes: primeraLinea.startMinutes,
      professional: { kind: "specific", employeeId: primeraLinea.employeeId },
    });
    expect(choque).toBeNull();

    // Y una cita manual en OTRO hueco convive sin problema, con su propio origen.
    const aparte = await crear(app, { startMinutes: 16 * 60 + 30, clientLabel: "Cliente C" });
    expect(aparte.statusCode, aparte.body).toBe(201);

    const snap = await snapshotOf(app);
    const conGrupo = (snap.reservations as Json[]).filter((r) => r.group !== undefined);
    const conManual = manuales(snap);
    expect(conGrupo.length).toBe(2);
    expect(conManual.length).toBe(1);
    // Ninguna reserva es las dos cosas.
    expect(conManual.filter((r) => r.group !== undefined)).toHaveLength(0);
    await app.close();
  });

  it("NO HAY DUPLICACIÓN entre el calendario y el espejo del MemoryStore", async () => {
    const app = freshApp();
    await reset(app);
    await crear(app);
    await crear(app, { startMinutes: 12 * 60, clientLabel: "Cliente B" });

    const snap = await snapshotOf(app);
    const enAgenda = snap.reservations as Json[];
    const enCalendario = (snap.calendar as Json).reservations as Json[];

    // Ni un identificador repetido en ninguna de las dos proyecciones.
    for (const lista of [enAgenda, enCalendario]) {
      const ids = lista.map((r) => r.id as string);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // Y las dos coinciden en estado para cada cita manual.
    for (const m of manuales(snap)) {
      const gemela = enCalendario.find((r) => r.id === m.id);
      expect(gemela, String(m.id)).toBeDefined();
      expect(gemela?.status).toBe(m.status);
      expect(gemela?.startMinutes).toBe(m.startMinutes);
      expect(gemela?.endMinutes).toBe(m.endMinutes);
    }
    await app.close();
  });

  it("EL CONTRATO DE LA INSTANTÁNEA SIGUE CERRADO: la cita manual no abre ninguna clave de primer nivel", async () => {
    const app = freshApp();
    await reset(app);
    const antes = Object.keys(await snapshotOf(app)).sort();
    await crear(app);
    const despues = Object.keys(await snapshotOf(app)).sort();
    expect(despues).toEqual(antes);
    expect(despues).not.toContain("manualBookings");
    expect(despues).not.toContain("manual");

    // Y la anotación de la reserva viaja por LISTA EXPLÍCITA: tres campos, ni
    // uno del dominio.
    const m = manuales(await snapshotOf(app))[0] as Json;
    expect(Object.keys(m.manual as Json).sort()).toEqual(["clientLabel", "manualBookingId", "originLabel"]);
    await app.close();
  });

  it("NINGÚN IDENTIFICADOR INTERNO ni dato personal viaja en la anotación de la Agenda", async () => {
    const app = freshApp();
    await reset(app);
    await crear(app);
    const m = manuales(await snapshotOf(app))[0] as Json;
    const anotacion = m.manual as Json;
    // La etiqueta de la persona es del catálogo cerrado, y no hay nada más.
    expect(/^Cliente [A-F]$/.test(anotacion.clientLabel as string)).toBe(true);
    expect(anotacion.originLabel).toBe("Creada manualmente por el operador");
    // La clave del hueco y la de intención NO viajan.
    expect(JSON.stringify(anotacion)).not.toContain("slot-");
    expect(JSON.stringify(anotacion)).not.toContain("manual:");
    await app.close();
  });
});

// =====================================================================
// D · LO QUE EL RELOJ Y EL HORARIO IMPONEN
// =====================================================================

describe("step 24 · adversarial — antelación mínima, festivos y ausencias", () => {
  it("con ANTELACIÓN MÍNIMA configurada, la hora demasiado próxima se rechaza como pasada", () => {
    // El calendario de la demostración tiene `minimumLeadMinutes: 0`, así que
    // esta regla se prueba sobre un calendario que sí la declara: es un HECHO
    // del calendario, no de la cita manual, y la cita manual sólo tiene que
    // respetarlo.
    const cal = { ...demoSalonVenue(), minimumLeadMinutes: 120 };
    const clock = fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);
    const ctx = { cal, clock, manualBookings: [], nextManualNumber: 1 };

    // Las 10:00 con un reloj a las 09:00 y 120 minutos de antelación: no llega.
    const pronto = createManualBooking(ctx, {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: BOOKING_DEMO_TODAY,
      startMinutes: 10 * 60,
      durationMinutes: 30,
      employeeId: ALEX_ID,
    });
    expect(pronto.status).toBe(409);
    expect(pronto.body.conflict).toBe("slot_in_the_past");

    // Las 11:30 sí: 09:00 + 120 minutos = 11:00, y la comparación es estricta.
    const aTiempo = createManualBooking(ctx, {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: BOOKING_DEMO_TODAY,
      startMinutes: 11 * 60 + 30,
      durationMinutes: 30,
      employeeId: ALEX_ID,
    });
    expect(aTiempo.status).toBe(201);
  });

  it("un CIERRE del local publicado impide crear ese día, y lo dice como cierre", async () => {
    const app = freshApp();
    await reset(app);
    // Viernes 7 de agosto: sin citas de la demostración, así que el cierre se
    // puede publicar sin resolver ninguna. Se exige 200: aceptar también un
    // 409 —como hacía la primera redacción— dejaba pasar una prueba que no
    // había publicado nada y que por tanto no comprobaba nada.
    const dia = "2026-08-07";

    const publicada = await post(app, "/api/calendar/publish", {
      change: {
        changeKind: "venue_closure",
        id: "cierre-adversarial-1",
        startDate: dia,
        endDate: dia,
      },
      resolutions: {},
    });
    expect(publicada.statusCode, publicada.body).toBe(200);

    const res = await post(app, "/api/booking/manual/preview", {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: dia,
      startMinutes: HORA_LIBRE,
      professional: { kind: "specific", employeeId: ALEX_ID },
    });
    const body = JSON.parse(res.body) as Json;
    expect(body.proposal).toBeNull();
    expect((body.rejected as Json).conflict).toBe("venue_closed");
    expect((body.rejected as Json).message).toBe("El local está cerrado ese día.");
    await app.close();
  });

  it("una AUSENCIA de la persona se dice como ausencia de la persona, no como cierre del local", async () => {
    const app = freshApp();
    await reset(app);
    const dia = "2026-08-05";

    const publicada = await post(app, "/api/calendar/publish", {
      change: {
        changeKind: "employee_absence",
        id: "ausencia-adversarial-2",
        employeeId: DANI_ID,
        absenceKind: "vacation",
        startDate: dia,
        endDate: dia,
        allDay: true,
      },
      resolutions: {},
    });
    expect(publicada.statusCode, publicada.body).toBe(200);

    const res = await post(app, "/api/booking/manual/preview", {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: dia,
      startMinutes: HORA_LIBRE,
      professional: { kind: "specific", employeeId: DANI_ID },
    });
    const body = JSON.parse(res.body) as Json;
    expect(body.proposal).toBeNull();
    expect((body.rejected as Json).conflict).toBe("professional_no_longer_available");
    // Y el local NO está cerrado: otra persona sí puede ese día.
    const otra = await post(app, "/api/booking/manual/preview", {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: dia,
      startMinutes: HORA_LIBRE,
      professional: { kind: "specific", employeeId: NEREA_ID },
    });
    expect((JSON.parse(otra.body) as Json).proposal).not.toBeNull();
    await app.close();
  });
});

// =====================================================================
// E · step 26 — LA CITA LARGA CONTRA TODO LO DEMÁS
//
// Una cita de 135 minutos desalineada es la forma más incómoda que puede tomar
// la agenda de esta demostración: empieza a y cuarto, cruza cinco medias horas
// de la rejilla de la voz y, al cancelarse, libera un intervalo que la lista de
// espera no sabe describir entero. Aquí se comprueba que las tres superficies
// —agenda, explorador y motor de llamadas— cuentan LA MISMA historia, y que la
// consecuencia honesta del comportamiento conservador de J12 (opción A) es la
// que de verdad ocurre, no la que sería cómoda.
//
// Lo que NO firman: ninguna pantalla, ningún lector de pantalla y ninguna
// política comercial sobre qué hacer con un hueco largo liberado — ésa sigue
// siendo una decisión abierta de Bruno, y esta misión no la toma.
// =====================================================================

describe("step 26 · B6 — una cita de 135 minutos bloquea TODOS los tramos que solapa", () => {
  /** 14:15–16:30 con Álex, el caso desalineado de verdad. */
  async function citaLarga(app: FastifyInstance): Promise<string> {
    const res = await crear(app, { startMinutes: 14 * 60 + 15, durationMinutes: 135 });
    expect(res.statusCode, res.body).toBe(201);
    return ((JSON.parse(res.body) as Json).booking as Json).reservationId as string;
  }

  it("la AGENDA la publica con su intervalo real, y una sola vez", async () => {
    const app = freshApp();
    await reset(app);
    const reservaId = await citaLarga(app);
    const snap = await snapshotOf(app);
    const fila = (snap.reservations as Json[]).find((r) => r.id === reservaId) as Json;
    expect(fila.startMinutes).toBe(14 * 60 + 15);
    expect(fila.endMinutes).toBe(14 * 60 + 135 + 15);
    expect((fila.manual as Json).originLabel).toBe("Creada manualmente por el operador");
    // Y el calendario dice exactamente lo mismo que la agenda.
    const gemela = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === reservaId) as Json;
    expect(gemela.startMinutes).toBe(fila.startMinutes);
    expect(gemela.endMinutes).toBe(fila.endMinutes);
    await app.close();
  });

  it("el EXPLORADOR deja de ofrecer los cinco inicios de media hora que la cita pisa", async () => {
    const app = freshApp();
    await reset(app);
    const url = `/api/availability/explore?serviceId=1&mode=one&employeeId=${String(ALEX_ID)}&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}`;
    const antes = JSON.parse((await app.inject({ method: "GET", url })).body) as Json;
    for (const etiqueta of ["14:00", "14:30", "15:00", "15:30", "16:00"]) {
      expect((antes.slots as Json[]).map((s) => s.startLabel), etiqueta).toContain(etiqueta);
    }

    await citaLarga(app);

    const despues = JSON.parse((await app.inject({ method: "GET", url })).body) as Json;
    for (const etiqueta of ["14:00", "14:30", "15:00", "15:30", "16:00"]) {
      expect((despues.slots as Json[]).map((s) => s.startLabel), etiqueta).not.toContain(etiqueta);
    }
    expect((despues.slots as Json[]).map((s) => s.startLabel)).toContain("16:30");
    await app.close();
  });

  it("el MOTOR DE LLAMADAS no escribe encima de ningún tramo suyo", async () => {
    const app = freshApp();
    await reset(app);
    await citaLarga(app);

    for (const [scenarioId, time] of [
      ["A70-tramo-1430", "14:30"],
      ["A71-tramo-1500", "15:00"],
      ["A72-tramo-1600", "16:00"],
    ] as const) {
      const llamada = await post(app, "/api/scenario/run", {
        scenarioId,
        turns: [
          {
            utterance: "quiero reservar",
            day: "tuesday",
            time,
            professionalId: ALEX_ID,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      });
      expect(llamada.statusCode).toBe(200);
      const guion = JSON.parse(llamada.body) as Json;
      // El motor llegó a un veredicto de verdad, no a un fallo técnico.
      expect(guion.reasonCode, time).not.toBe("TECHNICAL_FAILURE");
      const escrita = guion.reservation as Json | undefined;
      if (escrita !== undefined && escrita.date === BOOKING_DEMO_TODAY && escrita.employeeId === ALEX_ID) {
        const pisa = (escrita.startMinutes as number) < 14 * 60 + 150 && 14 * 60 + 15 < (escrita.endMinutes as number);
        expect(pisa, `${time} escribió ${JSON.stringify(escrita)}`).toBe(false);
      }
    }

    // Y en la franja disputada sigue habiendo UNA sola cita: la manual.
    const enLaFranja = ((await snapshotOf(app)).reservations as Json[]).filter(
      (r) =>
        r.date === BOOKING_DEMO_TODAY &&
        r.employeeId === ALEX_ID &&
        r.status === "confirmed" &&
        (r.startMinutes as number) < 14 * 60 + 150 &&
        14 * 60 + 15 < (r.endMinutes as number),
    );
    expect(enLaFranja).toHaveLength(1);
    expect(enLaFranja[0]?.manual).toBeDefined();
    await app.close();
  });

  it("otra cita manual que sólo roza el intervalo por un minuto también choca", async () => {
    const app = freshApp();
    await reset(app);
    await citaLarga(app);
    // 16:15–16:45: se solapa quince minutos con el final de la larga.
    const rozando = await previa(app, {
      startMinutes: 16 * 60 + 15,
      durationMinutes: 30,
      clientLabel: "Cliente C",
    });
    expect(rozando).toBeNull();
    // Y 16:30 en punto, que empieza justo cuando la otra acaba, sí cabe.
    const pegada = await crear(app, { startMinutes: 16 * 60 + 30, durationMinutes: 60, clientLabel: "Cliente C" });
    expect(pegada.statusCode, pegada.body).toBe(201);
    await app.close();
  });
});

describe("step 26 · B8 — cancelar 135 minutos: se libera el intervalo, y nadie es avisado", () => {
  it("no crea ninguna cita, no avisa a nadie y toda propuesta queda pendiente de aprobación", async () => {
    const app = freshApp();
    await reset(app);
    // Con DANI y de 13:15 a 15:30: cabe entero en su día (tiene libre de 12:00
    // a 16:00) y empieza DESALINEADA, que es lo que hace incómodo el caso.
    const creada = await crear(app, {
      startMinutes: 13 * 60 + 15,
      durationMinutes: 135,
      clientLabel: "Cliente E",
      professional: { kind: "specific", employeeId: DANI_ID },
    });
    expect(creada.statusCode, creada.body).toBe(201);
    const reservaId = ((JSON.parse(creada.body) as Json).booking as Json).reservationId as string;

    const citasAntes = manuales(await snapshotOf(app)).length;
    const previos = ((await snapshotOf(app)).waitlist as Json).releasedSlots as Json[];
    const huecosAntes = previos.length;
    const clavesPrevias = new Set(previos.map((s) => String(s.key)));

    const cancelada = await post(
      app,
      `/api/reservations/${reservaId}/cancel`,
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": `cxl-larga-${reservaId}` },
    );
    expect(cancelada.statusCode, cancelada.body).toBe(200);

    const snap = await snapshotOf(app);
    const w = snap.waitlist as Json;
    // NINGUNA cita nueva: cancelar no reserva por su cuenta.
    expect(manuales(snap).length).toBe(citasAntes);
    expect((snap.reservations as Json[]).filter((r) => String(r.id).startsWith("res-wl-"))).toEqual([]);

    // Los huecos liberados son los ALINEADOS que caben dentro del intervalo:
    // 13:30, 14:00, 14:30 y 15:00. El trozo de 13:15 a 13:30 vuelve a estar
    // libre en el calendario pero NO se convierte en oferta, porque la lista de
    // espera vive en la rejilla de 30. Es la consecuencia honesta de J12-A, y
    // se escribe aquí para que nadie la corrija a escondidas.
    const despues = w.releasedSlots as Json[];
    expect(despues.length - huecosAntes).toBe(4);
    // La clave de un hueco liberado es `slot-<fecha>-<inicio>-<profesional>`.
    const nuevos = despues.filter(
      (s) => String(s.key).startsWith(`slot-${BOOKING_DEMO_TODAY}-`) && !clavesPrevias.has(String(s.key)),
    );
    expect(nuevos.map((s) => s.key).sort()).toEqual([
      `slot-${BOOKING_DEMO_TODAY}-810-${String(DANI_ID)}`,
      `slot-${BOOKING_DEMO_TODAY}-840-${String(DANI_ID)}`,
      `slot-${BOOKING_DEMO_TODAY}-870-${String(DANI_ID)}`,
      `slot-${BOOKING_DEMO_TODAY}-900-${String(DANI_ID)}`,
    ]);
    // El cuarto de hora de 13:15 a 13:30 NO tiene hueco liberado propio.
    expect(nuevos.map((s) => s.key)).not.toContain(`slot-${BOOKING_DEMO_TODAY}-795-${String(DANI_ID)}`);
    // Y la métrica de minutos sin cubrir sigue contando bloques de 30, porque
    // todos los huecos liberados siguen durando `cal.slotMinutes`.
    expect(Number((w.metrics as Json).unfilledReleasedSlotMinutes) % 30).toBe(0);

    // Nadie ha sido avisado, nada se ha confirmado solo.
    for (const hueco of nuevos) {
      const propuesta = hueco.proposal as Json | null;
      if (propuesta !== null) expect(propuesta.statusCode).toBe("pending_approval");
    }
    const eventos = ((w.audit as Json).items as Json[]).map((e) => e.kind);
    expect(eventos).not.toContain("WAITLIST_NOTICE_SIMULATED");
    expect(eventos).not.toContain("WAITLIST_OFFER_ACCEPTED");
    expect(eventos).not.toContain("WAITLIST_ENTRY_CONVERTED");
    await app.close();
  });

  it("tras cancelar, otra cita de 135 minutos vuelve a caber en el hueco ENTERO", async () => {
    const app = freshApp();
    await reset(app);
    const creada = await crear(app, {
      startMinutes: 13 * 60 + 15,
      durationMinutes: 135,
      clientLabel: "Cliente E",
      professional: { kind: "specific", employeeId: DANI_ID },
    });
    expect(creada.statusCode, creada.body).toBe(201);
    const reservaId = ((JSON.parse(creada.body) as Json).booking as Json).reservationId as string;

    // Mientras vive, no cabe otra igual.
    expect(
      await previa(app, {
        startMinutes: 13 * 60 + 15,
        durationMinutes: 135,
        clientLabel: "Cliente F",
        professional: { kind: "specific", employeeId: DANI_ID },
      }),
    ).toBeNull();

    await post(
      app,
      `/api/reservations/${reservaId}/cancel`,
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": `cxl-larga-2-${reservaId}` },
    );

    // El calendario liberó el intervalo COMPLETO, incluido el cuarto de hora
    // que la lista de espera no supo ofrecer.
    const otra = await crear(app, {
      startMinutes: 13 * 60 + 15,
      durationMinutes: 135,
      clientLabel: "Cliente F",
      professional: { kind: "specific", employeeId: DANI_ID },
    });
    expect(otra.statusCode, otra.body).toBe(201);
    const snap = await snapshotOf(app);
    expect(manuales(snap).filter((r) => r.status === "confirmed")).toHaveLength(1);
    await app.close();
  });
});

describe("step 26 · B11 — dos pestañas con duraciones distintas", () => {
  it("la que confirma segunda recibe un 409 de CONFLICTO, no uno de idempotencia", async () => {
    const app = freshApp();
    await reset(app);
    const corta = (await previa(app, { startMinutes: 14 * 60, durationMinutes: 30 })) as Json;
    const larga = (await previa(app, { startMinutes: 14 * 60, durationMinutes: 135 })) as Json;
    expect(corta.keyToMint).not.toBe(larga.keyToMint);

    expect((await confirmar(app, larga, { durationMinutes: 135 })).statusCode).toBe(201);
    const segunda = await confirmar(app, corta, { durationMinutes: 30 });
    expect(segunda.statusCode).toBe(409);
    const cuerpo = JSON.parse(segunda.body) as Json;
    expect(cuerpo.conflict).toBe("slot_no_longer_free");
    expect(cuerpo.message).toBe("Ese hueco acaba de ocuparse. No se ha creado ninguna cita.");
    expect(manuales(await snapshotOf(app))).toHaveLength(1);
    await app.close();
  });

  it("INSTANTÁNEA VIEJA con una cita larga de por medio: la confirmación cae, y no a medias", async () => {
    const app = freshApp();
    await reset(app);
    // Una pestaña se queda con la propuesta de las 15:00, de media hora.
    const pestaña = (await previa(app, { startMinutes: 15 * 60 })) as Json;
    expect(pestaña).not.toBeNull();

    // Entre tanto, otro operador crea 14:15–16:30 con la misma persona.
    expect((await crear(app, { startMinutes: 14 * 60 + 15, durationMinutes: 135, clientLabel: "Cliente E" })).statusCode).toBe(201);

    const res = await confirmar(app, pestaña);
    expect(res.statusCode).toBe(409);
    // Solapamiento por el extremo IZQUIERDO: la cita larga empezó ANTES del
    // tramo pedido. La comparación de punto habría dicho la frase de la persona.
    expect((JSON.parse(res.body) as Json).conflict).toBe("slot_no_longer_free");
    expect(manuales(await snapshotOf(app))).toHaveLength(1);
    await app.close();
  });
});

// =====================================================================
// F · step 26 (revisión adversarial, hallazgo 5) — LA AUSENCIA DEGENERADA
//
// Una ausencia parcial de longitud cero no aparta a nadie de ninguna hora,
// pero al restarse parte el día en dos tramos que se tocan por un punto. Ése
// es el único camino por el que la rejilla de 30 de la voz y la aritmética de
// intervalo de la cita manual podrían contestar cosas distintas sobre el mismo
// minuto. Se cierra donde se publica, y no enseñando a cada lector a
// desconfiar de sus propios datos.
// =====================================================================

describe("step 26 · publicar una ausencia parcial que no dura nada", () => {
  it("se rechaza con un 400, y el calendario no cambia", async () => {
    const app = freshApp();
    await reset(app);
    const antes = JSON.stringify((await snapshotOf(app)).calendar);

    for (const [startMinutes, endMinutes] of [
      [12 * 60, 12 * 60],
      [13 * 60, 12 * 60],
    ] as const) {
      const res = await post(app, "/api/calendar/publish", {
        change: {
          changeKind: "employee_absence",
          id: `ausencia-degenerada-${String(startMinutes)}-${String(endMinutes)}`,
          employeeId: ALEX_ID,
          absenceKind: "absence",
          startDate: "2026-08-05",
          endDate: "2026-08-05",
          allDay: false,
          startMinutes,
          endMinutes,
        },
        resolutions: {},
      });
      expect(res.statusCode, `${String(startMinutes)}→${String(endMinutes)}: ${res.body}`).toBe(400);
    }

    expect(JSON.stringify((await snapshotOf(app)).calendar)).toBe(antes);
    await app.close();
  });

  it("una ausencia parcial que SÍ dura algo se sigue publicando, y sigue apartando esas horas", async () => {
    const app = freshApp();
    await reset(app);
    const dia = "2026-08-05";
    const publicada = await post(app, "/api/calendar/publish", {
      change: {
        changeKind: "employee_absence",
        id: "ausencia-parcial-valida-m26",
        employeeId: ALEX_ID,
        absenceKind: "absence",
        startDate: dia,
        endDate: dia,
        allDay: false,
        startMinutes: 11 * 60,
        endMinutes: 12 * 60,
      },
      resolutions: {},
    });
    expect(publicada.statusCode, publicada.body).toBe(200);

    // 10:30 + 60 pisaría la ausencia: no cabe.
    expect(await previa(app, { date: dia, startMinutes: 10 * 60 + 30, durationMinutes: 60 })).toBeNull();
    // Y 90 minutos justo después, a las 12:00, sí.
    const despues = await previa(app, { date: dia, startMinutes: 12 * 60, durationMinutes: 90 });
    expect(despues).not.toBeNull();
    await app.close();
  });
});
