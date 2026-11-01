import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { IDEMPOTENCY_KEY_PATTERN } from "../../src/console/idempotency.js";
import { CLOCK_ADVANCE_MAX_MINUTES, OPERATIONS_COPY } from "../../src/console/operationsSnapshot.js";

/**
 * step 18 · fase E — LA CAPA HTTP de las inasistencias y del reloj
 * avanzable (diseño §2.9, §3.5, §1.5).
 *
 * Recorre el escenario 19 del §9.1 paso a paso con la aritmética REAL del
 * fixture (martes 2026-08-04, 09:00; `demo-salon-res-1` = Álex 09:30–10:00, la
 * primera cita que termina; la siguiente, `demo-salon-res-3`, no acaba hasta las
 * 10:30) y cierra la parte de servidor de los criterios 8.11–8.16, 8.38 y el
 * orden de reinicio de §1.5.
 */

const TEST_SALT = "no-show-test-salt";
const RES_ALEX = "demo-salon-res-1"; // 09:30–10:00
const RES_DANI = "demo-salon-res-3"; // 10:00–10:30
const RES_CANCELADA = "demo-salon-res-7-cancelada";

type Json = Record<string, unknown>;

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

async function post(app: FastifyInstance, url: string, payload: unknown, headers?: Record<string, string>) {
  return app.inject({ method: "POST", url, payload: payload as never, ...(headers !== undefined ? { headers } : {}) });
}

async function snapshotOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}

async function operationsOf(app: FastifyInstance): Promise<Json> {
  return (await snapshotOf(app)).operations as Json;
}

/** La agenda que pinta la consola: la proyección de `cal`. */
async function reservationOf(app: FastifyInstance, id: string): Promise<Json> {
  const snap = await snapshotOf(app);
  const calendar = snap.calendar as Json;
  const found = (calendar.reservations as Json[]).find((r) => r.id === id);
  expect(found, `la agenda ya no trae ${id}`).toBeDefined();
  return found as Json;
}

async function reset(app: FastifyInstance): Promise<void> {
  const res = await post(app, "/api/reset", {});
  expect(res.statusCode).toBe(200);
}

async function advanceMinutes(app: FastifyInstance, minutes: number) {
  return post(app, "/api/lab/clock/advance", { command: "advance_minutes", minutes });
}

async function advanceToEndOf(app: FastifyInstance, reservationId: string) {
  return post(app, "/api/lab/clock/advance", { command: "advance_to_reservation_end", reservationId });
}

async function record(app: FastifyInstance, reservationId: string, key: string) {
  return post(app, `/api/reservations/${reservationId}/no-show`, { confirmed: true }, { "idempotency-key": key });
}

async function correct(app: FastifyInstance, reservationId: string, key: string) {
  return post(
    app,
    `/api/reservations/${reservationId}/no-show/correction`,
    { confirmed: true },
    { "idempotency-key": key },
  );
}

/** Todo lo que un rechazo NO puede haber tocado (criterio 8.13). */
async function worldFingerprint(app: FastifyInstance): Promise<string> {
  const snap = await snapshotOf(app);
  const operations = snap.operations as Json;
  return JSON.stringify({
    audit: operations.audit,
    records: (operations.noShows as Json).records,
    metrics: operations.metrics,
    reservations: (snap.calendar as Json).reservations,
    tasks: ((snap.humanQueue as Json).tasks as Json[]).map((t) => t.id),
  });
}

// ---------------------------------------------------------------------
// §3.5 — el reloj avanzable
// ---------------------------------------------------------------------

describe("step 18 · §3.5 — POST /api/lab/clock/advance", () => {
  it("arranca a las 09:00 del martes y lo dice ya resuelto en la instantánea", async () => {
    const app = freshApp();
    await reset(app);
    const operations = await operationsOf(app);
    expect(operations.clock).toEqual({
      dateISO: "2026-08-04",
      minutes: 540,
      label: "martes 4 de agosto, 09:00",
      advancedByMinutes: 0,
      advancedLabel: null,
      isSynthetic: true,
      notice: OPERATIONS_COPY.clockNotice,
    });
    const snap = await snapshotOf(app);
    expect(snap.engineToday).toBe("2026-08-04");
    expect(snap.engineNowMinutes).toBe(540);
    await app.close();
  });

  it("«hasta el final de esta cita» deja el reloj en las 10:00 y escribe DEMO_CLOCK_ADVANCED", async () => {
    const app = freshApp();
    await reset(app);
    const res = await advanceToEndOf(app, RES_ALEX);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    // La hora resultante viaja RESUELTA en la respuesta: el cliente no la calcula.
    expect(body.clock).toMatchObject({
      dateISO: "2026-08-04",
      minutes: 600,
      label: "martes 4 de agosto, 10:00",
      advancedByMinutes: 60,
      advancedLabel: "movido +1 h por ti",
    });
    expect((body.auditEventIds as string[]).length).toBe(1);

    const operations = await operationsOf(app);
    const items = (operations.audit as Json).items as Json[];
    const advance = items.find((i) => i.kind === "DEMO_CLOCK_ADVANCED");
    expect(advance).toBeDefined();
    expect(advance?.text).toBe(
      "El reloj de la demostración ha pasado de las 09:00 a las 10:00 del martes 4 de agosto. Lo ha movido un operador.",
    );
    expect((operations.metrics as Json).clockAdvances).toBe(1);
    // Y la instantánea operativa entera se mueve con él.
    const snap = await snapshotOf(app);
    expect(snap.engineNowMinutes).toBe(600);
    await app.close();
  });

  it("+30 min, +1 h, +2 h y +4 h se acumulan y se etiquetan en castellano", async () => {
    const app = freshApp();
    await reset(app);
    for (const minutes of [30, 60, 120, 240]) {
      expect((await advanceMinutes(app, minutes)).statusCode).toBe(200);
    }
    const operations = await operationsOf(app);
    expect(operations.clock).toMatchObject({
      minutes: 540 + 450,
      advancedByMinutes: 450,
      advancedLabel: "movido +7 h 30 min por ti",
    });
    expect((operations.metrics as Json).clockAdvances).toBe(4);
    await app.close();
  });

  it("el endpoint es más ancho que la interfaz a propósito: acepta el tope de siete días y rechaza un minuto más", async () => {
    const app = freshApp();
    await reset(app);
    const tope = await advanceMinutes(app, CLOCK_ADVANCE_MAX_MINUTES);
    expect(CLOCK_ADVANCE_MAX_MINUTES).toBe(10_080);
    expect(tope.statusCode).toBe(200);
    expect((tope.json() as Json).clock).toMatchObject({ dateISO: "2026-08-11", minutes: 540 });

    const app2 = freshApp();
    await reset(app2);
    const pasado = await advanceMinutes(app2, CLOCK_ADVANCE_MAX_MINUTES + 1);
    expect(pasado.statusCode).toBe(400);
    expect((pasado.json() as Json).issues).toBeDefined();
    await app.close();
    await app2.close();
  });

  it("no existe forma de retroceder: repetir el salto absoluto es 409 y el reloj no se mueve (K11)", async () => {
    const app = freshApp();
    await reset(app);
    expect((await advanceToEndOf(app, RES_ALEX)).statusCode).toBe(200);
    const antes = await worldFingerprint(app);

    const otraVez = await advanceToEndOf(app, RES_ALEX);
    expect(otraVez.statusCode).toBe(409);
    expect(otraVez.json()).toMatchObject({
      conflict: "clock_cannot_go_backwards",
      currentLabel: "martes 4 de agosto, 10:00",
      requestedLabel: "martes 4 de agosto, 10:00",
    });
    // Un rechazo no escribe NADA: ni evento de reloj, ni nada más.
    expect(await worldFingerprint(app)).toBe(antes);
    expect((await operationsOf(app)).clock).toMatchObject({ minutes: 600 });
    await app.close();
  });

  it("una cita que no existe es 404 y no mueve el reloj", async () => {
    const app = freshApp();
    await reset(app);
    const res = await advanceToEndOf(app, "no-existe");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "reservation_not_found" });
    expect((await operationsOf(app)).clock).toMatchObject({ minutes: 540, advancedByMinutes: 0 });
    await app.close();
  });

  it("un cuerpo inválido es 400 con issues, y no mueve nada", async () => {
    const app = freshApp();
    await reset(app);
    for (const payload of [{}, { command: "advance_minutes" }, { command: "advance_minutes", minutes: 0 }, { command: "rewind", minutes: 30 }, { command: "advance_minutes", minutes: 30, extra: 1 }]) {
      const res = await post(app, "/api/lab/clock/advance", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await operationsOf(app)).clock).toMatchObject({ minutes: 540 });
    await app.close();
  });

  it("(§3.3) el efecto colateral sobre la lista de espera se DECLARA, no se arregla: el hueco pasa a ser pasado y la tarea se queda abierta", async () => {
    const app = freshApp();
    await reset(app);
    // Se cancela la cita de las 09:30 con el reloj en las 09:00: queda un
    // hueco liberado (570) y una tarea de «decidir a quién se ofrece».
    const cancelada = await post(
      app,
      `/api/reservations/${RES_ALEX}/cancel`,
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": `cancel:${RES_ALEX}` },
    );
    expect(cancelada.statusCode).toBe(200);
    const antes = await snapshotOf(app);
    const huecoAntes = ((antes.waitlist as Json).releasedSlots as Json[]).find((s) => String(s.key).endsWith("-570-3"));
    expect(huecoAntes).toBeDefined();
    const tareasAbiertasAntes = ((antes.humanQueue as Json).tasks as Json[]).filter(
      (t) => t.reasonKind === "DECIDE_WAITLIST_MATCH" && t.open === true,
    );
    expect(tareasAbiertasAntes.length).toBeGreaterThan(0);

    // Se mueve el reloj más allá de ese hueco.
    expect((await advanceMinutes(app, 120)).statusCode).toBe(200);

    const despues = await snapshotOf(app);
    const waitlist = despues.waitlist as Json;
    // El hueco sigue existiendo y ya no encaja con nadie: ha pasado.
    const incompatibles = (
      ((waitlist.releasedSlots as Json[]).find((s) => String(s.key).endsWith("-570-3")) as Json).incompatible as Json[]
    ).flatMap((i) => (i.reasons as Json[]).map((r) => r.code));
    expect(incompatibles).toContain("slot_in_the_past");
    // La tarea NO se cierra sola: cerrarla sería afirmar que alguien decidió
    // algo que nadie decidió. La salida limpia es reiniciar, y la copia del
    // panel del reloj lo avisa antes de mover.
    const tareasAbiertasDespues = ((despues.humanQueue as Json).tasks as Json[]).filter(
      (t) => t.reasonKind === "DECIDE_WAITLIST_MATCH" && t.open === true,
    );
    expect(tareasAbiertasDespues.map((t) => t.id)).toEqual(tareasAbiertasAntes.map((t) => t.id));
    const copy = ((despues.operations as Json).noShows as Json).copy as Json;
    expect(copy.clockOnlyForwards).toBe(OPERATIONS_COPY.clockOnlyForwards);
    await app.close();
  });

  it("mover el reloj NO anota ninguna inasistencia: sólo cambia la elegibilidad (§2.1)", async () => {
    const app = freshApp();
    await reset(app);
    await advanceMinutes(app, 8 * 60); // las 17:00: casi toda la agenda ha terminado
    const operations = await operationsOf(app);
    expect((operations.noShows as Json).records).toEqual([]);
    expect((operations.metrics as Json).noShowsRecordedNow).toBe(0);
    expect(((operations.noShows as Json).eligibleReservationIds as string[]).length).toBeGreaterThan(1);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// §2.4 y §2.10 — elegibilidad y proyección
// ---------------------------------------------------------------------

describe("step 18 · §2.10 — la proyección resuelve elegibilidad y claves en el servidor", () => {
  it("a las 09:00 ninguna cita es elegible y cada una dice por qué, en castellano", async () => {
    const app = freshApp();
    await reset(app);
    const operations = await operationsOf(app);
    expect((operations.noShows as Json).eligibleReservationIds).toEqual([]);

    const alex = await reservationOf(app, RES_ALEX);
    expect(alex.eligibleForNoShow).toBe(false);
    expect(alex.noShowIneligibleReason).toBe(OPERATIONS_COPY.notFinishedYet);
    expect(alex.noShow).toBeUndefined();
    expect(alex.noShowRevision).toBe(0);
    expect(alex.noShowKeyToMint).toBe(`noshow:${RES_ALEX}:v0`);
    expect(alex.noShowFixKeyToMint).toBe(`noshow-fix:${RES_ALEX}:v0`);

    const cancelada = await reservationOf(app, RES_CANCELADA);
    expect(cancelada.eligibleForNoShow).toBe(false);
    expect(cancelada.noShowIneligibleReason).toBe(OPERATIONS_COPY.cancelledCannotBeNoShow);
    await app.close();
  });

  it("tras avanzar a las 10:00 hay EXACTAMENTE una cita elegible, y no es la de las 10:30", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    const operations = await operationsOf(app);
    expect((operations.noShows as Json).eligibleReservationIds).toEqual([RES_ALEX]);
    expect((await reservationOf(app, RES_ALEX)).eligibleForNoShow).toBe(true);
    expect((await reservationOf(app, RES_DANI)).eligibleForNoShow).toBe(false);
    await app.close();
  });

  it("las claves que acuña la interfaz son válidas como Idempotency-Key", async () => {
    const app = freshApp();
    await reset(app);
    const alex = await reservationOf(app, RES_ALEX);
    expect(IDEMPOTENCY_KEY_PATTERN.test(String(alex.noShowKeyToMint))).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test(String(alex.noShowFixKeyToMint))).toBe(true);
    await app.close();
  });

  it("las DOS proyecciones de reserva (agenda y almacén) llevan los mismos campos", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    // Una reserva que vive en el MemoryStore: la crea una llamada del Laboratorio.
    const run = await post(app, "/api/scenario/run", {
      scenarioId: "A01-noshow-dos-proyecciones",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "wednesday",
          time: "11:00",
          professionalId: 3,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    expect(run.statusCode).toBe(200);
    const snap = await snapshotOf(app);
    const desdeAlmacen = (snap.reservations as Json[])[0];
    expect(desdeAlmacen).toBeDefined();
    for (const campo of ["eligibleForNoShow", "noShowRevision", "noShowKeyToMint", "noShowFixKeyToMint"]) {
      expect(Object.keys(desdeAlmacen as Json).includes(campo), campo).toBe(true);
    }
    await app.close();
  });
});

// ---------------------------------------------------------------------
// §9.1 — el escenario 19 completo
// ---------------------------------------------------------------------

describe("step 18 · §9.1 — escenario 19: inasistencia manual de principio a fin", () => {
  it("registra, repite, corrige y vuelve a intentarlo, exactamente como dice el diseño", async () => {
    const app = freshApp();
    await reset(app);

    // Paso 2 — el reloj a las 10:00.
    expect((await advanceToEndOf(app, RES_ALEX)).statusCode).toBe(200);

    // Paso 4 — registrar con la clave que acuña la proyección.
    const clave0 = String((await reservationOf(app, RES_ALEX)).noShowKeyToMint);
    expect(clave0).toBe(`noshow:${RES_ALEX}:v0`);
    const creado = await record(app, RES_ALEX, clave0);
    expect(creado.statusCode).toBe(201);
    expect(creado.headers["idempotency-status"]).toBe("original");
    const cuerpo = creado.json() as Json;
    expect(cuerpo.recorded).toBe(true);
    expect(cuerpo.record).toMatchObject({
      id: `nsh-${RES_ALEX}`,
      reservationId: RES_ALEX,
      state: "recorded",
      stateLabel: "Inasistencia registrada",
      when: "martes 4 de agosto, 09:30–10:00",
      serviceLabel: "Corte de pelo",
      recordedAtISO: "2026-08-04T10:00:00",
      correctedAtISO: null,
      minutesAfterEndWhenRecorded: 0,
      noShowRevision: 0,
      idempotencyKeyToMint: `noshow-fix:${RES_ALEX}:v0`,
      noPenaltyNotice: OPERATIONS_COPY.noPenalty,
      availableCommands: ["correct_no_show"],
    });
    expect((cuerpo.auditEventIds as string[]).length).toBe(1);

    // Paso 5 — la línea neutra de Inicio, y las dos cifras siempre juntas.
    let operations = await operationsOf(app);
    expect((operations.metrics as Json).homeLine).toBe(
      "Inasistencias anotadas hoy: 1 (registro manual, sin penalización).",
    );
    expect((operations.metrics as Json).recordedAndCorrectedLine).toBe(
      "Inasistencias anotadas ahora mismo (sintéticas): 1 · Registros corregidos: 0",
    );

    // Paso 6 — el historial cuenta las dos cosas, en castellano.
    let items = (operations.audit as Json).items as Json[];
    expect(items.map((i) => i.kind)).toEqual(["DEMO_RESET", "DEMO_CLOCK_ADVANCED", "NO_SHOW_RECORDED"]);
    expect(items[2]?.text).toBe(
      "Un operador ha anotado una inasistencia en la cita de las 09:30 con Álex (sintético). No se ha aplicado ninguna penalización.",
    );

    // La píldora viaja en la fila de la Agenda.
    let alex = await reservationOf(app, RES_ALEX);
    expect(alex.noShow).toEqual({
      state: "recorded",
      stateLabel: "Inasistencia registrada",
      recordedAtISO: "2026-08-04T10:00:00",
    });

    // Paso 7 — repetir con LA MISMA clave: replay, cero escrituras nuevas.
    const repetido = await record(app, RES_ALEX, clave0);
    expect(repetido.statusCode).toBe(201);
    expect(repetido.headers["idempotency-status"]).toBe("replayed");
    operations = await operationsOf(app);
    expect((operations.noShows as Json).records).toHaveLength(1);
    expect((operations.metrics as Json).noShowRecordCommands).toBe(1);
    expect((operations.metrics as Json).noShowsRecordedNow).toBe(1);

    // Paso 8 — corregir con la clave que la proyección ofrece AHORA.
    const claveFix0 = String((await reservationOf(app, RES_ALEX)).noShowFixKeyToMint);
    expect(claveFix0).toBe(`noshow-fix:${RES_ALEX}:v0`);
    const corregido = await correct(app, RES_ALEX, claveFix0);
    expect(corregido.statusCode).toBe(200);
    expect((corregido.json() as Json).record).toMatchObject({
      state: "corrected_not_a_no_show",
      stateLabel: "Registro corregido: no fue una inasistencia",
      // El registro NO se borra ni se reescribe: la historia conserva las dos cosas.
      recordedAtISO: "2026-08-04T10:00:00",
      correctedAtISO: "2026-08-04T10:00:00",
      noShowRevision: 1,
      availableCommands: [],
    });

    alex = await reservationOf(app, RES_ALEX);
    expect(alex.noShow).toMatchObject({ state: "corrected_not_a_no_show", recordedAtISO: "2026-08-04T10:00:00" });
    expect(alex.noShowRevision).toBe(1);
    expect(alex.noShowKeyToMint).toBe(`noshow:${RES_ALEX}:v1`);

    operations = await operationsOf(app);
    expect((operations.metrics as Json).noShowsRecordedNow).toBe(0);
    expect((operations.metrics as Json).noShowsCorrected).toBe(1);
    expect((operations.metrics as Json).homeLine).toBeNull();
    items = (operations.audit as Json).items as Json[];
    expect(items[items.length - 1]?.text).toBe(
      "Un operador ha corregido el registro: la cita de las 09:30 con Álex (sintético) no fue una inasistencia. El registro anterior no se ha borrado.",
    );

    // Paso 9 — volver a registrar con la clave NUEVA: 409, cero escrituras...
    const antes = await worldFingerprint(app);
    const rechazado = await record(app, RES_ALEX, `noshow:${RES_ALEX}:v1`);
    expect(rechazado.statusCode).toBe(409);
    expect(rechazado.json()).toMatchObject({ conflict: "no_show_already_corrected" });
    expect(await worldFingerprint(app)).toBe(antes);

    // ...y ese 409 NO se memoriza: repetirlo vuelve a ejecutarse y vuelve a
    // dar 409, en vez de quedarse congelado para siempre.
    const otraVez = await record(app, RES_ALEX, `noshow:${RES_ALEX}:v1`);
    expect(otraVez.statusCode).toBe(409);
    expect(otraVez.headers["idempotency-status"]).toBe("original");
    expect(await worldFingerprint(app)).toBe(antes);

    await app.close();
  });

  it("(8.38) reproducir la secuencia con la clave VIEJA devuelve el 201 memorizado pero no escribe nada, y la instantánea sigue diciendo la verdad", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    await correct(app, RES_ALEX, `noshow-fix:${RES_ALEX}:v0`);

    const antes = await worldFingerprint(app);
    const rancio = await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    expect(rancio.statusCode).toBe(201);
    expect(rancio.headers["idempotency-status"]).toBe("replayed");
    // El cuerpo memorizado describe un mundo anterior; LA PROYECCIÓN es la
    // verdad, y sigue diciendo `corrected_not_a_no_show`.
    const alex = await reservationOf(app, RES_ALEX);
    expect((alex.noShow as Json).state).toBe("corrected_not_a_no_show");
    const operations = await operationsOf(app);
    expect((operations.metrics as Json).noShowsRecordedNow).toBe(0);
    expect(((operations.noShows as Json).records as Json[])[0]).toMatchObject({
      state: "corrected_not_a_no_show",
    });
    // Un replay no ejecuta: lo único que cambia es que queda anotado que se repitió.
    const despues = JSON.parse(await worldFingerprint(app)) as Json;
    const antesJson = JSON.parse(antes) as Json;
    expect(despues.records).toEqual(antesJson.records);
    expect(despues.reservations).toEqual(antesJson.reservations);
    await app.close();
  });

  it("(8.14) dos pestañas con claves distintas: la segunda es 200 alreadyRecorded, un solo registro y ninguna métrica sube", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    expect((await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`)).statusCode).toBe(201);

    const segunda = await record(app, RES_ALEX, "otra-pestana-con-otra-clave");
    expect(segunda.statusCode).toBe(200);
    expect(segunda.json()).toMatchObject({ recorded: true, alreadyRecorded: true });
    expect((segunda.json() as Json).record).toMatchObject({ state: "recorded", recordedAtISO: "2026-08-04T10:00:00" });

    const operations = await operationsOf(app);
    expect((operations.noShows as Json).records).toHaveLength(1);
    const metrics = operations.metrics as Json;
    expect(metrics.noShowRecordCommands).toBe(1);
    expect(metrics.noShowsRecordedNow).toBe(1);
    expect(metrics.noShowsCorrected).toBe(0);
    expect(metrics.repeatedCommandsIgnored).toBe(1);
    const kinds = ((operations.audit as Json).items as Json[]).map((i) => i.kind);
    expect(kinds.filter((k) => k === "NO_SHOW_RECORDED")).toHaveLength(1);
    expect(kinds.filter((k) => k === "NO_SHOW_COMMAND_REPEATED")).toHaveLength(1);
    await app.close();
  });

  it("corregir dos veces con claves distintas es 200 alreadyCorrected sin segunda corrección", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    await correct(app, RES_ALEX, `noshow-fix:${RES_ALEX}:v0`);
    const segunda = await correct(app, RES_ALEX, "corregir-otra-vez-otra-clave");
    expect(segunda.statusCode).toBe(200);
    expect(segunda.json()).toMatchObject({ corrected: true, alreadyCorrected: true });
    const operations = await operationsOf(app);
    expect((operations.metrics as Json).noShowsCorrected).toBe(1);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// §2.6 / §2.9 — los rechazos y la validación
// ---------------------------------------------------------------------

describe("step 18 · §2.6 — un 409 no escribe absolutamente nada (criterio 8.13)", () => {
  it("cita sin terminar, cita cancelada y cita inexistente dejan el mundo idéntico", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX); // las 10:00
    const antes = await worldFingerprint(app);

    const sinTerminar = await record(app, RES_DANI, `noshow:${RES_DANI}:v0`);
    expect(sinTerminar.statusCode).toBe(409);
    expect(sinTerminar.json()).toMatchObject({
      conflict: "reservation_not_finished_yet",
      minutesUntilEnd: 30,
      endsAtLabel: "10:30",
    });

    const cancelada = await record(app, RES_CANCELADA, `noshow:${RES_CANCELADA}:v0`);
    expect(cancelada.statusCode).toBe(409);
    expect(cancelada.json()).toMatchObject({ conflict: "reservation_is_cancelled" });

    const inexistente = await record(app, "no-existe-esta-cita", "clave-de-una-cita-que-no-existe");
    expect(inexistente.statusCode).toBe(404);

    const sinRegistro = await correct(app, RES_DANI, `noshow-fix:${RES_DANI}:v0`);
    expect(sinRegistro.statusCode).toBe(404);
    expect(sinRegistro.json()).toMatchObject({ code: "no_show_not_found" });

    expect(await worldFingerprint(app)).toBe(antes);
    await app.close();
  });

  it("la cabecera Idempotency-Key es obligatoria en las dos rutas, y su formato se comprueba", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    const antes = await worldFingerprint(app);

    for (const url of [`/api/reservations/${RES_ALEX}/no-show`, `/api/reservations/${RES_ALEX}/no-show/correction`]) {
      const sinClave = await post(app, url, { confirmed: true });
      expect(sinClave.statusCode).toBe(400);
      expect(String((sinClave.json() as Json).error)).toContain("Idempotency-Key");

      const claveMala = await post(app, url, { confirmed: true }, { "idempotency-key": "corta" });
      expect(claveMala.statusCode).toBe(400);
    }
    expect(await worldFingerprint(app)).toBe(antes);
    await app.close();
  });

  it("la confirmación explícita es obligatoria: sin ella, o con false, es 400 y no escribe nada", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    const antes = await worldFingerprint(app);
    for (const payload of [{}, { confirmed: false }, { confirmed: true, extra: 1 }]) {
      const res = await post(app, `/api/reservations/${RES_ALEX}/no-show`, payload, {
        "idempotency-key": `noshow:${RES_ALEX}:v0`,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await worldFingerprint(app)).toBe(antes);
    await app.close();
  });

  it("no existe ninguna ruta para borrar un registro", async () => {
    const app = freshApp();
    await reset(app);
    const res = await app.inject({ method: "DELETE", url: `/api/reservations/${RES_ALEX}/no-show` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// §1.5 — el orden del reinicio
// ---------------------------------------------------------------------

describe("step 18 · §1.5 — el reinicio devuelve el reloj a las 09:00 ANTES de tocar nada más", () => {
  it("tras avanzar el reloj y anotar, el reinicio lo borra todo y vuelve a 09:00", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);

    await reset(app);

    const snap = await snapshotOf(app);
    expect(snap.engineToday).toBe("2026-08-04");
    expect(snap.engineNowMinutes).toBe(540);
    const operations = snap.operations as Json;
    expect(operations.clock).toMatchObject({ minutes: 540, advancedByMinutes: 0, advancedLabel: null });
    expect((operations.noShows as Json).records).toEqual([]);
    expect((operations.noShows as Json).eligibleReservationIds).toEqual([]);
    expect((operations.metrics as Json)).toMatchObject({
      noShowsRecordedNow: 0,
      noShowsCorrected: 0,
      noShowRecordCommands: 0,
      repeatedCommandsIgnored: 0,
      clockAdvances: 0,
    });
    // El log de operaciones vuelve a tener UN evento: su propio DEMO_RESET.
    const audit = operations.audit as Json;
    expect(audit.total).toBe(1);
    expect((audit.items as Json[])[0]).toMatchObject({
      id: "opa-00000001",
      seq: 1,
      kind: "DEMO_RESET",
      actor: "reset",
      atISO: "2026-08-04T09:00:00",
    });
    await app.close();
  });

  it("(§1.5, el defecto silencioso) el DEMO_RESET de la lista de espera queda sellado a las 09:00, no a la hora avanzada", async () => {
    const app = freshApp();
    await reset(app);
    // Se mueve el reloj MUY lejos y se reinicia: si el reloj se restaurase
    // después de `waitlist.reset()`, la lista de espera recién reiniciada
    // tendría entradas creadas a las 14:00 de un martes en el que aún no son
    // las 09:00.
    await advanceMinutes(app, 5 * 60);
    await reset(app);

    const snap = await snapshotOf(app);
    const waitlist = snap.waitlist as Json;
    const primerEvento = ((waitlist.audit as Json).items as Json[])[0];
    expect(primerEvento).toMatchObject({ kind: "DEMO_RESET", atISO: "2026-08-04T09:00:00" });
    for (const entry of (waitlist.entries as Json[])) {
      expect(entry.createdAtISO).toBe("2026-08-04T09:00:00");
    }
    await app.close();
  });

  it("dos reinicios seguidos dejan exactamente el mismo estado", async () => {
    const app = freshApp();
    await reset(app);
    await advanceMinutes(app, 90);
    await reset(app);
    const uno = await operationsOf(app);
    await reset(app);
    const dos = await operationsOf(app);
    expect(dos).toEqual(uno);
    await app.close();
  });

  it("resetToBaseline() tiene exactamente un llamante: POST /api/reset (criterio 8.9)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });
    }
    const callers = walk(join(process.cwd(), "src")).filter((file) =>
      readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .includes("resetToBaseline()"),
    );
    // El envoltorio que la declara y el servidor que la llama. Nadie más.
    expect(callers.map((f) => f.replace(`${process.cwd()}/`, "")).sort()).toEqual([
      "src/callEngine/domain/advanceableClock.ts",
      "src/console/server.ts",
    ]);
    const server = readFileSync(join(process.cwd(), "src/console/server.ts"), "utf8");
    expect(server.split("resetToBaseline()").length - 1).toBe(1);
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------
// §2.8, §2.11, §2.12 — integridad, vocabulario y privacidad
// ---------------------------------------------------------------------

describe("step 18 · §2.8/§2.11 — integridad, vocabulario y privacidad", () => {
  it("(8.16) los invariantes se cumplen tras la secuencia completa del escenario 19", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    await record(app, RES_ALEX, "otra-clave-cualquiera-larga");
    await record(app, RES_DANI, `noshow:${RES_DANI}:v0`);
    await correct(app, RES_ALEX, `noshow-fix:${RES_ALEX}:v0`);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v1`);

    const operations = await operationsOf(app);
    expect(operations.integrity).toEqual({ ok: true, problems: [] });
    await app.close();
  });

  it("una inasistencia anotada NO libera ningún hueco ni cambia la lista de espera (J10, §6.6/§6.7)", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    const antes = await snapshotOf(app);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    const despues = await snapshotOf(app);

    const wlAntes = antes.waitlist as Json;
    const wlDespues = despues.waitlist as Json;
    expect(wlDespues.releasedSlots).toEqual(wlAntes.releasedSlots);
    expect(wlDespues.entries).toEqual(wlAntes.entries);
    expect(wlDespues.cancellations).toEqual(wlAntes.cancellations);
    expect(wlDespues.audit).toEqual(wlAntes.audit);
    // Y la cita sigue confirmada: anotar no cancela nada.
    expect((await reservationOf(app, RES_ALEX)).status).toBe("confirmed");
    await app.close();
  });

  it("ninguna inasistencia crea una tarea humana nueva (§2.6)", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    const antes = ((await snapshotOf(app)).humanQueue as Json).tasks as Json[];
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    await correct(app, RES_ALEX, `noshow-fix:${RES_ALEX}:v0`);
    const despues = ((await snapshotOf(app)).humanQueue as Json).tasks as Json[];
    expect(despues).toEqual(antes);
    await app.close();
  });

  it("(8.11) el vocabulario prohibido no aparece en la instantánea, y «penalización» sólo aparece negada", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    const res = await app.inject({ method: "GET", url: "/api/snapshot" });
    const cuerpo = res.body;
    // La lista literal del §2.11, sobre EL CONTEXTO DE ESTA FUNCIÓN: el
    // bloque `operations` entero (registros, copia, métricas e historial).
    const operations = JSON.stringify((res.json() as Json).operations).toLowerCase();
    for (const prohibido of ["sanción", "sancion", "bloque", "riesgo", "fiable", "reincident", "tasa", "%", "coste", "pérdida", "perdida", "€"]) {
      expect(operations.includes(prohibido), prohibido).toBe(false);
    }
    // Y en TODA la instantánea, lo que no puede aparecer nunca en ningún sitio.
    for (const prohibido of ["lista negra", "blacklist", "penalizar", "penalizada", "penalizado"]) {
      expect(cuerpo.toLowerCase().includes(prohibido), prohibido).toBe(false);
    }
    // «penaliz» sólo puede aparecer dentro de la frase que niega la penalización.
    const trozos = cuerpo.split(/penaliz/i);
    expect(trozos.length).toBeGreaterThan(1);
    for (const previo of trozos.slice(0, -1)) {
      expect(previo.slice(-40)).toMatch(/ninguna |sin /);
    }
    await app.close();
  });

  it("ninguna clave del bloque operations casa con la lista negra de datos personales", async () => {
    const app = freshApp();
    await reset(app);
    await advanceToEndOf(app, RES_ALEX);
    await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
    const operations = await operationsOf(app);
    const prohibidas = [
      "phone",
      "telefono",
      "nombre",
      "apellido",
      "email",
      "transcript",
      "audio",
      "recording",
      "address",
      "direccion",
      "dni",
      "nif",
      "name",
    ];
    function walk(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = key
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase();
        for (const banned of prohibidas) expect(normalized.includes(banned), `${key} → ${banned}`).toBe(false);
        walk(child);
      }
    }
    // El bloque nuevo, y además la instantánea ENTERA con un registro vivo
    // dentro: la prueba (6) de console.test.ts recorre el mismo árbol, pero
    // nunca en este estado.
    walk(operations);
    walk(await snapshotOf(app));
    const texto = JSON.stringify(operations);
    expect(texto).not.toMatch(/\+\d[\d\s().-]{6,}/);
    expect(texto).not.toMatch(/[^\s@"]+@[^\s@"]+\.[^\s@",}]+/);
    await app.close();
  });

  it("(8.33) dos arranques limpios con la misma secuencia dan un bloque operations idéntico", async () => {
    async function run(): Promise<Json> {
      const app = freshApp();
      await reset(app);
      await advanceToEndOf(app, RES_ALEX);
      await record(app, RES_ALEX, `noshow:${RES_ALEX}:v0`);
      await record(app, RES_ALEX, "otra-clave-distinta-de-la-primera");
      await correct(app, RES_ALEX, `noshow-fix:${RES_ALEX}:v0`);
      const operations = await operationsOf(app);
      await app.close();
      return operations;
    }
    expect(await run()).toEqual(await run());
  });
});
