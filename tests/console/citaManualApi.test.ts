import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { formatDurationEs, manualConflictLabel } from "../../src/console/operationsSnapshot.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 24 · LA CAPA HTTP de la cita manual.
 *
 * Lo que se fija aquí es el CONTRATO: qué acepta la ruta, qué rechaza, qué
 * devuelve y —sobre todo— qué NO toca. La regla que más veces se comprueba en
 * este fichero es la que da sentido a la misión: una cita manual no emite un
 * solo evento de llamada, no mueve una sola métrica de llamadas y no inventa
 * ningún `callId`.
 * ────────────────────────────────────────────────────────────────────────
 */

const SAL = "cita-manual-test-salt";
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
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as Json;
}

async function reset(app: FastifyInstance): Promise<void> {
  expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
}

const PREVIA_BASE = {
  clientLabel: "Cliente A",
  serviceId: 1 as const,
  date: BOOKING_DEMO_TODAY,
  startMinutes: HORA_LIBRE,
  professional: { kind: "specific" as const, employeeId: ALEX_ID },
};

async function previa(app: FastifyInstance, extra: Json = {}) {
  return post(app, "/api/booking/manual/preview", { ...PREVIA_BASE, ...extra });
}

/**
 * Previsualiza y confirma en dos pasos, como hace el operador.
 *
 * REENVÍA `confirm` TAL CUAL, sin añadirle nada a mano (step 26, revisión
 * adversarial, hallazgo 1). Este ayudante añadía la duración por su cuenta, y
 * al hacerlo tapaba el defecto que ahora vigila: si `confirm` no describe la
 * petición ENTERA, quien lo reenvíe crea una cita distinta de la que vio.
 */
async function crear(app: FastifyInstance, extra: Json = {}, claveExplicita?: string) {
  const p = await previa(app, extra);
  expect(p.statusCode, p.body).toBe(200);
  const propuesta = (JSON.parse(p.body) as Json).proposal as Json;
  expect(propuesta, `la vista previa no propuso nada: ${p.body}`).not.toBeNull();
  const confirmar = propuesta.confirm as Json;
  return post(
    app,
    "/api/booking/manual",
    { ...confirmar, confirmed: true },
    { "idempotency-key": claveExplicita ?? (propuesta.keyToMint as string) },
  );
}

describe("step 24 · HTTP — la vista previa no escribe y explica quién queda asignado", () => {
  it("con un profesional concreto, lo dice; y no escribe absolutamente nada", async () => {
    const app = freshApp();
    await reset(app);
    const antes = JSON.stringify(await snapshotOf(app));

    const res = await previa(app);
    expect(res.statusCode).toBe(200);
    const p = (JSON.parse(res.body) as Json).proposal as Json;
    expect(p.professionalLabel).toBe("Álex (sintético)");
    expect(p.professionalNote).toBe("Se ha pedido expresamente a Álex (sintético).");
    // step 26 §13: la duración la redacta `formatDurationEs`, en el servidor
    // y en un solo sitio. Antes decía «30 minutos»; ahora dice lo mismo que
    // rotula el control del asistente, para que no puedan separarse.
    expect(p.durationLabel).toBe("30 min");
    expect(p.originLabel).toBe("Creada manualmente por el operador");
    expect(p.confirmLabel).toBe("Confirmar y crear la cita sintética");
    expect(String(p.syntheticNotice)).toContain("Entorno sintético");

    // Nada ha cambiado: la vista previa es una pregunta, no un acto.
    const despues = JSON.stringify(await snapshotOf(app));
    expect(quitarSello(despues)).toBe(quitarSello(antes));
    await app.close();
  });

  it("con «cualquier profesional», dice a quién le TOCA antes de confirmar", async () => {
    const app = freshApp();
    await reset(app);
    const res = await previa(app, { professional: { kind: "any" } });
    const p = (JSON.parse(res.body) as Json).proposal as Json;
    expect(String(p.professionalNote)).toMatch(/^Con «cualquier profesional», a esta hora le toca .+\.$/);
    // Y quien queda asignado viaja resuelto, para que la confirmación no
    // vuelva a elegir por su cuenta.
    expect(typeof (p.confirm as Json).employeeId).toBe("number");
    await app.close();
  });

  it("un rechazo se contesta con 200, con la FRASE por delante y el código aparte", async () => {
    const app = freshApp();
    await reset(app);
    // Nerea no hace el servicio 0.
    const res = await previa(app, {
      serviceId: 0,
      professional: { kind: "specific", employeeId: NEREA_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Json;
    expect(body.proposal).toBeNull();
    const r = body.rejected as Json;
    expect(r.message).toBe("Esa persona del equipo no hace ese servicio.");
    // El código técnico viaja, pero NO como mensaje.
    expect(r.conflict).toBe("professional_cannot_perform_service");
    expect(String(r.message)).not.toContain("professional_cannot_perform_service");
    await app.close();
  });

  it("no acepta un campo de más, ni una etiqueta fuera del catálogo", async () => {
    const app = freshApp();
    await reset(app);
    expect((await previa(app, { nota: "cliente VIP" })).statusCode).toBe(400);
    expect((await previa(app, { clientLabel: "Pedro" })).statusCode).toBe(400);
    expect((await previa(app, { clientLabel: "Cliente G" })).statusCode).toBe(400);
    expect((await previa(app, { serviceId: 3 })).statusCode).toBe(400);
    await app.close();
  });
});

describe("step 24 · HTTP — crear la cita", () => {
  it("crea, contesta 201 y devuelve la PROYECCIÓN, con su frase de éxito", async () => {
    const app = freshApp();
    await reset(app);
    const res = await crear(app);
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body) as Json;
    expect(body.created).toBe(true);
    const cita = body.booking as Json;
    expect(cita.originLabel).toBe("Creada manualmente por el operador");
    expect(cita.statusLabel).toBe("Confirmada");
    // El éxito NOMBRA fecha, hora y profesional.
    expect(String(cita.successLabel)).toContain("Cliente A");
    expect(String(cita.successLabel)).toContain("11:00–11:30");
    expect(String(cita.successLabel)).toContain("Álex (sintético)");
    await app.close();
  });

  it("sin `Idempotency-Key` no se crea nada", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(app, "/api/booking/manual", {
      clientLabel: "Cliente A",
      serviceId: 1,
      date: BOOKING_DEMO_TODAY,
      startMinutes: HORA_LIBRE,
      employeeId: ALEX_ID,
      confirmed: true,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("sin `confirmed: true` es imposible escribir: el tipo no admite otra cosa", async () => {
    const app = freshApp();
    await reset(app);
    for (const cuerpo of [
      { confirmed: false },
      { confirmed: "true" },
      {},
    ]) {
      const res = await post(
        app,
        "/api/booking/manual",
        {
          clientLabel: "Cliente A",
          serviceId: 1,
          date: BOOKING_DEMO_TODAY,
          startMinutes: HORA_LIBRE,
          employeeId: ALEX_ID,
          ...cuerpo,
        },
        { "idempotency-key": `sin-confirmar-${JSON.stringify(cuerpo)}` },
      );
      expect(res.statusCode, JSON.stringify(cuerpo)).toBe(400);
    }
    await app.close();
  });

  it("un campo de más es un 400, nunca una instrucción ignorada en silencio", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(
      app,
      "/api/booking/manual",
      {
        clientLabel: "Cliente A",
        serviceId: 1,
        date: BOOKING_DEMO_TODAY,
        startMinutes: HORA_LIBRE,
        employeeId: ALEX_ID,
        confirmed: true,
        telefono: "600000000",
      },
      { "idempotency-key": "campo-de-mas-1" },
    );
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("step 24 · HTTP — idempotencia", () => {
  it("un reenvío exacto devuelve LA MISMA cita y no crea una segunda", async () => {
    const app = freshApp();
    await reset(app);
    const p = await previa(app);
    const propuesta = (JSON.parse(p.body) as Json).proposal as Json;
    const clave = propuesta.keyToMint as string;
    const cuerpo = { ...(propuesta.confirm as Json), confirmed: true };

    const primera = await post(app, "/api/booking/manual", cuerpo, { "idempotency-key": clave });
    expect(primera.statusCode).toBe(201);
    const idPrimera = ((JSON.parse(primera.body) as Json).booking as Json).id;

    const segunda = await post(app, "/api/booking/manual", cuerpo, { "idempotency-key": clave });
    expect(segunda.statusCode).toBe(200);
    const b2 = JSON.parse(segunda.body) as Json;
    expect(b2.created).toBe(false);
    expect(b2.alreadyExists).toBe(true);
    expect((b2.booking as Json).id).toBe(idPrimera);

    // Y una sola cita en la agenda.
    const snap = await snapshotOf(app);
    const manuales = (snap.reservations as Json[]).filter((r) => r.manual !== undefined);
    expect(manuales).toHaveLength(1);
    await app.close();
  });

  it("la MISMA clave con otro cuerpo es un 409 que no ejecuta nada", async () => {
    const app = freshApp();
    await reset(app);
    const p = await previa(app);
    const propuesta = (JSON.parse(p.body) as Json).proposal as Json;
    const clave = propuesta.keyToMint as string;

    expect(
      (await post(app, "/api/booking/manual", { ...(propuesta.confirm as Json), confirmed: true }, { "idempotency-key": clave }))
        .statusCode,
    ).toBe(201);

    // Mismo hueco, otra persona, misma clave: colisión.
    const choque = await post(
      app,
      "/api/booking/manual",
      { ...(propuesta.confirm as Json), clientLabel: "Cliente B", confirmed: true },
      { "idempotency-key": clave },
    );
    expect(choque.statusCode).toBe(409);
    const snap = await snapshotOf(app);
    expect((snap.reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(1);
    await app.close();
  });

  it("crear, CANCELAR y repetir la clave antigua no resucita una cita que ya no existe", async () => {
    const app = freshApp();
    await reset(app);
    const p = await previa(app);
    const propuesta = (JSON.parse(p.body) as Json).proposal as Json;
    const claveVieja = propuesta.keyToMint as string;
    const cuerpo = { ...(propuesta.confirm as Json), confirmed: true };

    const creada = await post(app, "/api/booking/manual", cuerpo, { "idempotency-key": claveVieja });
    const reservaId = ((JSON.parse(creada.body) as Json).booking as Json).reservationId as string;

    const cancelada = await post(
      app,
      `/api/reservations/${reservaId}/cancel`,
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": `cancel-manual-${reservaId}` },
    );
    expect(cancelada.statusCode, cancelada.body).toBe(200);

    // La clave VIEJA, otra vez. Con una respuesta memoizada esto contestaría
    // «creada» sobre una cita cancelada: la mentira que `collision-only` evita.
    const repetida = await post(app, "/api/booking/manual", cuerpo, { "idempotency-key": claveVieja });
    expect(repetida.statusCode).toBe(201);
    expect((JSON.parse(repetida.body) as Json).created).toBe(true);

    // Y ahora hay DOS citas manuales: una cancelada y una viva. Ninguna
    // perdida en silencio.
    const snap = await snapshotOf(app);
    const manuales = (snap.reservations as Json[]).filter((r) => r.manual !== undefined);
    expect(manuales).toHaveLength(2);
    expect(manuales.filter((r) => r.status === "confirmed")).toHaveLength(1);
    await app.close();
  });
});

describe("step 24 · HTTP — una cita manual NO es una llamada", () => {
  it("no emite eventos de llamada, no mueve sus métricas y no inventa ningún callIdHash", async () => {
    const app = freshApp();
    await reset(app);
    const antes = await snapshotOf(app);

    const res = await crear(app);
    expect(res.statusCode).toBe(201);
    const despues = await snapshotOf(app);

    // Los recuentos de eventos, intactos.
    expect(despues.eventCounts).toEqual(antes.eventCounts);
    // Las métricas de llamadas, intactas.
    expect(despues.metrics).toEqual(antes.metrics);
    // Ni una llamada nueva, ni una consulta de disponibilidad de llamada.
    expect((despues.calls as unknown[]).length).toBe((antes.calls as unknown[]).length);
    expect((despues.availabilityQueries as unknown[]).length).toBe((antes.availabilityQueries as unknown[]).length);

    // Y la cita creada NO lleva `callIdHash`.
    const manual = (despues.reservations as Json[]).find((r) => r.manual !== undefined);
    expect(manual).toBeDefined();
    expect(manual?.callIdHash).toBeUndefined();
    await app.close();
  });

  it("no crea ninguna tarea humana", async () => {
    const app = freshApp();
    await reset(app);
    const antes = ((await snapshotOf(app)).humanQueue as Json).tasks as unknown[];
    await crear(app);
    const despues = ((await snapshotOf(app)).humanQueue as Json).tasks as unknown[];
    expect(despues.length).toBe(antes.length);
    await app.close();
  });

  it("el origen se distingue de los otros tres, y no se abusa de `callIdHash`", async () => {
    const app = freshApp();
    await reset(app);
    await crear(app);
    const snap = await snapshotOf(app);
    const reservas = snap.reservations as Json[];

    const manual = reservas.find((r) => r.manual !== undefined) as Json;
    expect((manual.manual as Json).originLabel).toBe("Creada manualmente por el operador");
    expect(manual.originatedFromWaitlistEntryId).toBeUndefined();
    expect(manual.group).toBeUndefined();
    expect(manual.callIdHash).toBeUndefined();

    // Y ninguna reserva que NO sea manual gana la anotación por accidente.
    for (const r of reservas.filter((x) => x.id !== manual.id)) {
      expect(r.manual, String(r.id)).toBeUndefined();
    }
    await app.close();
  });
});

describe("step 24 · HTTP — una sola verdad de reservas", () => {
  it("la cita aparece en Agenda y en Calendario, y las dos proyecciones coinciden", async () => {
    const app = freshApp();
    await reset(app);
    const res = await crear(app);
    const reservaId = ((JSON.parse(res.body) as Json).booking as Json).reservationId;

    const snap = await snapshotOf(app);
    const enAgenda = (snap.reservations as Json[]).find((r) => r.id === reservaId);
    const enCalendario = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === reservaId);
    expect(enAgenda).toBeDefined();
    expect(enCalendario).toBeDefined();
    expect(enAgenda?.status).toBe(enCalendario?.status);
    expect(enAgenda?.startMinutes).toBe(enCalendario?.startMinutes);
    await app.close();
  });

  it("el hueco DESAPARECE del explorador, que es el resolvedor canónico", async () => {
    const app = freshApp();
    await reset(app);

    const url = `/api/availability/explore?serviceId=1&mode=one&employeeId=${String(ALEX_ID)}&from=${BOOKING_DEMO_TODAY}&to=${BOOKING_DEMO_TODAY}`;
    const antes = JSON.parse((await app.inject({ method: "GET", url })).body) as Json;
    const teniaLasOnce = (antes.slots as Json[]).some((s) => s.startLabel === "11:00");
    expect(teniaLasOnce).toBe(true);

    await crear(app);

    const despues = JSON.parse((await app.inject({ method: "GET", url })).body) as Json;
    expect((despues.slots as Json[]).some((s) => s.startLabel === "11:00")).toBe(false);
    await app.close();
  });

  /**
   * LA PRUEBA QUE DA SENTIDO A TODA LA MISIÓN. Un operador crea una cita a
   * mano; acto seguido, el MOTOR DE LLAMADAS pide ese mismo hueco. Si los dos
   * canales tuvieran calendarios distintos, el motor lo daría por libre y
   * escribiría encima. Lo que hace es verlo ocupado y ofrecer otra fecha —sin
   * que nadie le haya contado nada de la cita manual—, porque le pregunta a la
   * misma `isSlotFree` sobre el mismo `cal`.
   */
  it("una LLAMADA posterior ve el hueco ocupado, NO escribe encima y ofrece otra fecha", async () => {
    const app = freshApp();
    await reset(app);
    await crear(app);

    // El motor de llamadas, pidiendo EXACTAMENTE ese hueco con ese profesional.
    const llamada = await post(app, "/api/scenario/run", {
      scenarioId: "A90-la-llamada-llega-tarde",
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
    expect(llamada.statusCode).toBe(200);
    const guion = JSON.parse(llamada.body) as Json;

    // El motor NO reserva el hueco pedido: ofrece alternativas.
    expect((guion.turns as Json[]).map((t) => t.phraseKey)).toContain("OFFER_ALTERNATIVES");
    const reservaDeLaLlamada = guion.reservation as Json;
    expect(reservaDeLaLlamada.date).not.toBe(BOOKING_DEMO_TODAY);

    // Y en el hueco disputado —ese día, esa hora, esa persona— sigue habiendo
    // UNA sola cita: la manual.
    const snap = await snapshotOf(app);
    const enElHuecoDisputado = (snap.reservations as Json[]).filter(
      (r) =>
        r.date === BOOKING_DEMO_TODAY &&
        r.startMinutes === HORA_LIBRE &&
        r.employeeId === ALEX_ID &&
        r.status === "confirmed",
    );
    expect(enElHuecoDisputado).toHaveLength(1);
    expect(enElHuecoDisputado[0]?.manual).toBeDefined();
    expect(enElHuecoDisputado[0]?.callIdHash).toBeUndefined();
    await app.close();
  });

  it("otra cita manual sobre el mismo hueco recibe el conflicto, en castellano", async () => {
    const app = freshApp();
    await reset(app);
    await crear(app);

    const res = await previa(app, { clientLabel: "Cliente C" });
    const body = JSON.parse(res.body) as Json;
    expect(body.proposal).toBeNull();
    expect((body.rejected as Json).message).toBe("Ese hueco acaba de ocuparse. No se ha creado ninguna cita.");
    await app.close();
  });
});

describe("step 24 · HTTP — cancelar y reiniciar", () => {
  it("cancelar una cita manual de 30 minutos libera EXACTAMENTE un hueco", async () => {
    const app = freshApp();
    await reset(app);
    const res = await crear(app);
    const reservaId = ((JSON.parse(res.body) as Json).booking as Json).reservationId as string;

    const huecosAntes = (((await snapshotOf(app)).waitlist as Json).releasedSlots as Json[]).length;
    const cancel = await post(
      app,
      `/api/reservations/${reservaId}/cancel`,
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": `cancel-${reservaId}` },
    );
    expect(cancel.statusCode, cancel.body).toBe(200);

    const huecosDespues = (((await snapshotOf(app)).waitlist as Json).releasedSlots as Json[]).length;
    expect(huecosDespues - huecosAntes).toBe(1);
    await app.close();
  });

  it("«Reiniciar la demostración» borra TODAS las citas manuales", async () => {
    const app = freshApp();
    await reset(app);
    await crear(app);
    await crear(app, { startMinutes: 12 * 60 });
    expect(((await snapshotOf(app)).reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(2);

    await reset(app);
    const snap = await snapshotOf(app);
    expect((snap.reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(0);
    // Y el registro de operaciones vuelve a empezar, así que el origen
    // derivado tampoco sobrevive.
    const eventos = ((snap.operations as Json).audit as Json).items as Json[];
    expect(eventos.filter((e) => e.kind === "RESERVATION_MANUAL_CREATED")).toHaveLength(0);
    await app.close();
  });

  it("tras reiniciar, el mismo guion produce los MISMOS identificadores", async () => {
    const app = freshApp();
    await reset(app);
    const primera = await crear(app);
    const idPrimera = ((JSON.parse(primera.body) as Json).booking as Json).id;

    await reset(app);
    const segunda = await crear(app);
    expect(((JSON.parse(segunda.body) as Json).booking as Json).id).toBe(idPrimera);
    await app.close();
  });
});

/** El sello de pared cambia en cada lectura y no describe ningún cambio de estado. */
function quitarSello(texto: string): string {
  return texto.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"<sello>"');
}

// =====================================================================
// step 26 · LA DURACIÓN FLEXIBLE, EN EL CONTRATO HTTP
//
// Tres cosas se fijan aquí y en ningún otro sitio: que una petición que NO
// habla de duración sigue siendo la cita de siempre (compatibilidad), que una
// que sí habla crea exactamente el intervalo pedido, y que el resumen que lee
// el operador dice inicio, fin y duración sin un solo código técnico.
//
// Lo que NO firman: Safari real, VoiceOver, zoom al 200 %, ningún teclado
// nativo y ninguna pantalla — aquí no hay navegador.
// =====================================================================

describe("step 26 §1 · HTTP — compatibilidad y duración pedida", () => {
  it("una petición SIN `durationMinutes` sigue creando la cita de 30 minutos de siempre", async () => {
    const app = freshApp();
    await reset(app);
    const res = await crear(app);
    expect(res.statusCode, res.body).toBe(201);
    const cita = (JSON.parse(res.body) as Json).booking as Json;
    expect(cita.whenLabel).toBe("11:00–11:30");
    const enAgenda = ((await snapshotOf(app)).reservations as Json[]).find((r) => r.id === cita.reservationId);
    expect(enAgenda?.startMinutes).toBe(HORA_LIBRE);
    expect(enAgenda?.endMinutes).toBe(HORA_LIBRE + 30);
    await app.close();
  });

  it("una petición con `durationMinutes: 135` crea 135 minutos, ni uno más ni uno menos", async () => {
    const app = freshApp();
    await reset(app);
    const res = await crear(app, { startMinutes: 14 * 60, durationMinutes: 135 });
    expect(res.statusCode, res.body).toBe(201);
    const cita = (JSON.parse(res.body) as Json).booking as Json;
    // La frase que lee el operador dice el intervalo REAL, no media hora.
    expect(cita.whenLabel).toBe("14:00–16:15");
    expect(String(cita.successLabel)).toContain("14:00–16:15");
    // Y la agenda cuenta lo mismo que la respuesta.
    const enAgenda = ((await snapshotOf(app)).reservations as Json[]).find((r) => r.id === cita.reservationId);
    expect(enAgenda?.startMinutes).toBe(14 * 60);
    expect(enAgenda?.endMinutes).toBe(14 * 60 + 135);
    await app.close();
  });

  it("30, 60, 90, 120 y 150 minutos caben cada uno en su hueco, con el fin exacto", async () => {
    for (const durationMinutes of [30, 60, 90, 120, 150]) {
      const app = freshApp();
      await reset(app);
      const res = await crear(app, { startMinutes: 14 * 60, durationMinutes });
      expect(res.statusCode, `duración ${String(durationMinutes)}: ${res.body}`).toBe(201);
      const cita = (JSON.parse(res.body) as Json).booking as Json;
      const enAgenda = ((await snapshotOf(app)).reservations as Json[]).find((r) => r.id === cita.reservationId);
      expect(enAgenda?.endMinutes, String(durationMinutes)).toBe(14 * 60 + durationMinutes);
      await app.close();
    }
  });

  it("una duración que no va en pasos de 15 es un 400 en LAS DOS rutas, y no escribe nada", async () => {
    const app = freshApp();
    await reset(app);
    for (const durationMinutes of [20, 0, -15, 245, 12.5]) {
      expect((await previa(app, { durationMinutes })).statusCode, `previa ${String(durationMinutes)}`).toBe(400);
      const creada = await post(
        app,
        "/api/booking/manual",
        {
          clientLabel: "Cliente A",
          serviceId: 1,
          date: BOOKING_DEMO_TODAY,
          startMinutes: HORA_LIBRE,
          durationMinutes,
          employeeId: ALEX_ID,
          confirmed: true,
        },
        { "idempotency-key": `duracion-mala-${String(durationMinutes)}` },
      );
      expect(creada.statusCode, `crear ${String(durationMinutes)}`).toBe(400);
    }
    expect(((await snapshotOf(app)).reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(0);
    await app.close();
  });

  it("una duración que no CABE se contesta con la verdad del calendario, en castellano", async () => {
    const app = freshApp();
    await reset(app);
    // 16:30 + 120 minutos se sale del cierre de las 17:30 de la temporada de agosto.
    const res = await previa(app, { startMinutes: 16 * 60 + 30, durationMinutes: 120 });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Json;
    expect(body.proposal).toBeNull();
    // La verdad es que NO CABE, no que la persona falte: a las 16:30 Álex
    // trabaja y está libre (revisión adversarial, hallazgo 2).
    expect((body.rejected as Json).conflict).toBe("interval_does_not_fit");
    expect((body.rejected as Json).message).toBe(
      "Esa duración no cabe entera desde esa hora: el tramo libre acaba antes.",
    );
    expect(String((body.rejected as Json).message)).not.toContain("interval_does_not_fit");
    await app.close();
  });

  it("al confirmar, el 409 de «no cabe» lleva el intervalo intentado, ya rotulado", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(
      app,
      "/api/booking/manual",
      {
        clientLabel: "Cliente A",
        serviceId: 1,
        date: BOOKING_DEMO_TODAY,
        startMinutes: 16 * 60 + 45,
        durationMinutes: 60,
        employeeId: ALEX_ID,
        confirmed: true,
      },
      { "idempotency-key": "no-cabe-1" },
    );
    expect(res.statusCode).toBe(409);
    const cuerpo = JSON.parse(res.body) as Json;
    expect(cuerpo.conflict).toBe("interval_does_not_fit");
    const intento = cuerpo.attempted as Json;
    expect(intento.when).toBe("16:45");
    expect(intento.until).toBe("17:45");
    expect(intento.durationLabel).toBe("1 h");
    // Y ni un identificador interno en lo que se le enseña al operador.
    expect(JSON.stringify(intento)).not.toContain("res-m-");
    expect(JSON.stringify(intento)).not.toContain("man-");
    await app.close();
  });

  it("reenviar `confirm` TAL CUAL crea exactamente la cita que se previsualizó", async () => {
    const app = freshApp();
    await reset(app);
    const p = (JSON.parse((await previa(app, { startMinutes: 14 * 60, durationMinutes: 135 })).body) as Json)
      .proposal as Json;
    // El objeto se manda entero y sin tocar: es lo que haría cualquier cliente
    // que se fíe de la respuesta del servidor.
    const confirmar = p.confirm as Json;
    expect(confirmar.durationMinutes).toBe(135);
    const creada = await post(app, "/api/booking/manual", { ...confirmar, confirmed: true }, {
      "idempotency-key": p.keyToMint as string,
    });
    expect(creada.statusCode, creada.body).toBe(201);
    const cita = (JSON.parse(creada.body) as Json).booking as Json;
    // 135 minutos, no 30: sin `durationMinutes` en `confirm`, esto creaba una
    // cita de media hora con un 201 silencioso, y la clave acuñada (…d135…)
    // dejaba de describir la cita guardada (…d30…).
    expect(cita.whenLabel).toBe("14:00–16:15");
    // Y la clave que acuñó la vista previa describe la cita que existe: repetir
    // con ella contesta «ya existe», no crea una segunda.
    const repetida = await post(app, "/api/booking/manual", { ...confirmar, confirmed: true }, {
      "idempotency-key": p.keyToMint as string,
    });
    expect(repetida.statusCode).toBe(200);
    expect((JSON.parse(repetida.body) as Json).alreadyExists).toBe(true);
    expect(((await snapshotOf(app)).reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(1);
    await app.close();
  });

  it("una hora de inicio fuera de los pasos de 15 minutos es un 400 en las dos rutas", async () => {
    const app = freshApp();
    await reset(app);
    for (const startMinutes of [601, 660 + 1, 659]) {
      expect((await previa(app, { startMinutes })).statusCode, `previa ${String(startMinutes)}`).toBe(400);
      const creada = await post(
        app,
        "/api/booking/manual",
        {
          clientLabel: "Cliente A",
          serviceId: 1,
          date: BOOKING_DEMO_TODAY,
          startMinutes,
          durationMinutes: 135,
          employeeId: ALEX_ID,
          confirmed: true,
        },
        { "idempotency-key": `inicio-desalineado-${String(startMinutes)}` },
      );
      expect(creada.statusCode, `crear ${String(startMinutes)}`).toBe(400);
    }
    // Y los cuatro inicios legítimos del cuarto de hora siguen valiendo.
    for (const startMinutes of [14 * 60, 14 * 60 + 15, 14 * 60 + 30, 14 * 60 + 45]) {
      expect((await previa(app, { startMinutes })).statusCode, String(startMinutes)).toBe(200);
    }
    expect(((await snapshotOf(app)).reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(0);
    await app.close();
  });
});

describe("step 26 §13 · HTTP — el resumen dice inicio, fin y duración", () => {
  it("la vista previa de 135 minutos dice «2 h 15 min» y el intervalo real", async () => {
    const app = freshApp();
    await reset(app);
    const res = await previa(app, { startMinutes: 14 * 60, durationMinutes: 135 });
    const p = (JSON.parse(res.body) as Json).proposal as Json;
    expect(p.durationLabel).toBe("2 h 15 min");
    expect(p.whenLabel).toBe("14:00–16:15");
    await app.close();
  });

  it("el vocabulario de duración es el mismo en el servidor para los cinco preajustes y las once alternativas", () => {
    // La MISMA función que rotula el control del asistente. Si alguien cambia
    // una de estas cadenas, el rótulo y el resumen dejan de decir lo mismo.
    expect(formatDurationEs(30)).toBe("30 min");
    expect(formatDurationEs(60)).toBe("1 h");
    expect(formatDurationEs(90)).toBe("1 h 30 min");
    expect(formatDurationEs(120)).toBe("2 h");
    expect(formatDurationEs(150)).toBe("2 h 30 min");
    expect([15, 45, 75, 105, 135, 165, 180, 195, 210, 225, 240].map(formatDurationEs)).toEqual([
      "15 min",
      "45 min",
      "1 h 15 min",
      "1 h 45 min",
      "2 h 15 min",
      "2 h 45 min",
      "3 h",
      "3 h 15 min",
      "3 h 30 min",
      "3 h 45 min",
      "4 h",
    ]);
  });

  it("ningún código técnico es el mensaje principal, tampoco el de la duración", () => {
    const frase = manualConflictLabel("duration_not_allowed");
    expect(frase).toBe("Esa duración no es válida: sólo se puede elegir en pasos de 15 minutos.");
    expect(frase).not.toContain("duration_not_allowed");
    expect(frase).not.toContain("_");
  });
});

describe("step 26 §3 · HTTP — dos pestañas, doble clic y duraciones distintas", () => {
  it("DOS DURACIONES sobre el mismo inicio no colisionan como «ya existe»: la segunda choca de verdad", async () => {
    const app = freshApp();
    await reset(app);
    // Las dos pestañas previsualizan antes de que ninguna confirme.
    const corta = (JSON.parse((await previa(app, { startMinutes: 14 * 60, durationMinutes: 30 })).body) as Json)
      .proposal as Json;
    const larga = (JSON.parse((await previa(app, { startMinutes: 14 * 60, durationMinutes: 135 })).body) as Json)
      .proposal as Json;
    expect(corta).not.toBeNull();
    expect(larga).not.toBeNull();
    // Claves DISTINTAS: son dos intenciones distintas, no la misma repetida.
    expect(corta.keyToMint).not.toBe(larga.keyToMint);
    expect(String(corta.keyToMint)).toContain("d30");
    expect(String(larga.keyToMint)).toContain("d135");

    const primera = await post(
      app,
      "/api/booking/manual",
      { ...(corta.confirm as Json), durationMinutes: 30, confirmed: true },
      { "idempotency-key": corta.keyToMint as string },
    );
    expect(primera.statusCode, primera.body).toBe(201);

    const segunda = await post(
      app,
      "/api/booking/manual",
      { ...(larga.confirm as Json), durationMinutes: 135, confirmed: true },
      { "idempotency-key": larga.keyToMint as string },
    );
    // 409 DE CONFLICTO REAL, no de idempotencia: el mundo cambió, no la clave.
    expect(segunda.statusCode).toBe(409);
    const cuerpo = JSON.parse(segunda.body) as Json;
    expect(cuerpo.conflict).toBe("slot_no_longer_free");
    expect(cuerpo.conflict).not.toBe("idempotency_key_reused_with_different_body");
    expect(cuerpo.message).toBe("Ese hueco acaba de ocuparse. No se ha creado ninguna cita.");
    expect(((await snapshotOf(app)).reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(1);
    await app.close();
  });

  it("SOLAPAMIENTO POR EL EXTREMO IZQUIERDO: la cita larga empieza antes y pisa el tramo pedido", async () => {
    const app = freshApp();
    await reset(app);
    // Una cita de 14:00 a 16:15 con Álex.
    expect((await crear(app, { startMinutes: 14 * 60, durationMinutes: 135 })).statusCode).toBe(201);

    // Y ahora alguien pide las 15:00, que caen DENTRO de ella: la petición no
    // contiene su inicio, así que la comparación de punto habría dicho la frase
    // equivocada (la de la persona). Con solapamiento de rango, la verdad es
    // que el hueco está ocupado.
    const res = await previa(app, { startMinutes: 15 * 60, clientLabel: "Cliente C" });
    const body = JSON.parse(res.body) as Json;
    expect(body.proposal).toBeNull();
    expect((body.rejected as Json).conflict).toBe("slot_no_longer_free");
    expect((body.rejected as Json).message).toBe("Ese hueco acaba de ocuparse. No se ha creado ninguna cita.");

    // Y también por el otro extremo: 13:30–14:30 pisa el principio de la larga.
    const porLaIzquierda = await previa(app, {
      startMinutes: 13 * 60 + 30,
      durationMinutes: 60,
      clientLabel: "Cliente D",
    });
    const cuerpoIzq = JSON.parse(porLaIzquierda.body) as Json;
    expect(cuerpoIzq.proposal).toBeNull();
    expect((cuerpoIzq.rejected as Json).conflict).toBe("slot_no_longer_free");
    await app.close();
  });

  it("DOBLE CLIC sobre una cita larga deja UNA cita, con el mismo identificador", async () => {
    const app = freshApp();
    await reset(app);
    const p = (JSON.parse((await previa(app, { startMinutes: 14 * 60, durationMinutes: 90 })).body) as Json)
      .proposal as Json;
    const cuerpo = { ...(p.confirm as Json), durationMinutes: 90, confirmed: true };
    const uno = await post(app, "/api/booking/manual", cuerpo, { "idempotency-key": p.keyToMint as string });
    const dos = await post(app, "/api/booking/manual", cuerpo, { "idempotency-key": p.keyToMint as string });
    expect(uno.statusCode).toBe(201);
    expect(dos.statusCode).toBe(200);
    expect((JSON.parse(dos.body) as Json).alreadyExists).toBe(true);
    expect(((JSON.parse(dos.body) as Json).booking as Json).id).toBe(
      ((JSON.parse(uno.body) as Json).booking as Json).id,
    );
    expect(((await snapshotOf(app)).reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(1);
    await app.close();
  });

  it("la MISMA clave con otra duración sigue siendo la colisión de transporte, sin ejecutar nada", async () => {
    const app = freshApp();
    await reset(app);
    const p = (JSON.parse((await previa(app, { startMinutes: 14 * 60, durationMinutes: 30 })).body) as Json)
      .proposal as Json;
    const clave = p.keyToMint as string;
    expect(
      (await post(app, "/api/booking/manual", { ...(p.confirm as Json), durationMinutes: 30, confirmed: true }, { "idempotency-key": clave })).statusCode,
    ).toBe(201);

    const choque = await post(
      app,
      "/api/booking/manual",
      { ...(p.confirm as Json), durationMinutes: 90, confirmed: true },
      { "idempotency-key": clave },
    );
    expect(choque.statusCode).toBe(409);
    expect(((await snapshotOf(app)).reservations as Json[]).filter((r) => r.manual !== undefined)).toHaveLength(1);
    await app.close();
  });

  it("«CUALQUIER PROFESIONAL» con 90 minutos elige a alguien libre TODO el intervalo", async () => {
    const app = freshApp();
    await reset(app);
    // A las 16:00: Nerea tiene 16:00–17:00 y Dani 16:00–16:30. Sólo Álex puede.
    const res = await previa(app, {
      startMinutes: 16 * 60,
      durationMinutes: 90,
      professional: { kind: "any" },
    });
    const p = (JSON.parse(res.body) as Json).proposal as Json;
    expect(p, res.body).not.toBeNull();
    expect((p.confirm as Json).employeeId).toBe(ALEX_ID);
    expect(String(p.professionalNote)).toContain("Álex (sintético)");

    const creada = await post(
      app,
      "/api/booking/manual",
      { ...(p.confirm as Json), durationMinutes: 90, confirmed: true },
      { "idempotency-key": p.keyToMint as string },
    );
    expect(creada.statusCode, creada.body).toBe(201);
    await app.close();
  });
});

describe("step 26 · HTTP — cancelar una cita larga libera exactamente su intervalo", () => {
  it("cancelar 135 minutos devuelve el intervalo entero, y otra cita de 135 vuelve a caber", async () => {
    const app = freshApp();
    await reset(app);
    const creada = await crear(app, { startMinutes: 14 * 60, durationMinutes: 135 });
    const reservaId = ((JSON.parse(creada.body) as Json).booking as Json).reservationId as string;

    // Mientras vive, el mismo intervalo no cabe dos veces.
    expect((await previa(app, { startMinutes: 14 * 60, durationMinutes: 135, clientLabel: "Cliente B" })).body).toContain(
      "slot_no_longer_free",
    );

    const cancel = await post(
      app,
      `/api/reservations/${reservaId}/cancel`,
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": `cancel-larga-${reservaId}` },
    );
    expect(cancel.statusCode, cancel.body).toBe(200);

    // Y tras cancelar, vuelve a caber ENTERO: el calendario liberó el intervalo.
    const otra = await crear(app, { startMinutes: 14 * 60, durationMinutes: 135, clientLabel: "Cliente B" });
    expect(otra.statusCode, otra.body).toBe(201);
    expect(((JSON.parse(otra.body) as Json).booking as Json).whenLabel).toBe("14:00–16:15");
    await app.close();
  });
});
