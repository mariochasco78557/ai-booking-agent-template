import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { IDEMPOTENCY_KEY_PATTERN } from "../../src/console/idempotency.js";
import { GROUP_COPY } from "../../src/console/operationsSnapshot.js";

/**
 * step 18 · fase F — LA CAPA HTTP de la reserva para varias personas
 * (diseño §4.7, §4.8, §4.9), con la aritmética REAL del fixture.
 *
 * Martes 2026-08-04 a las 09:00. Álex = 3, Dani = 6, Nerea = 9; Nerea no hace
 * el servicio 0. Recorre los escenarios §9.2, §9.3, §9.5 y §9.6 (incluida su
 * continuación obligatoria) y cierra la parte de servidor de los criterios
 * 8.19–8.23, 8.42 y 8.43.
 */

const TEST_SALT = "group-test-salt";
const ALEX = 3;
const DANI = 6;
const NEREA = 9;

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

async function groupsOf(app: FastifyInstance): Promise<Json[]> {
  return ((await operationsOf(app)).groups as Json).items as Json[];
}

async function auditTotal(app: FastifyInstance): Promise<number> {
  return ((await operationsOf(app)).audit as Json).total as number;
}

/** Las citas de `cal` (la agenda) y las del MemoryStore: las DOS copias (§14.4). */
async function bothReservationCopies(app: FastifyInstance): Promise<{ cal: Json[]; store: Json[] }> {
  const snap = await snapshotOf(app);
  return {
    cal: (snap.calendar as Json).reservations as Json[],
    store: snap.reservations as Json[],
  };
}

/** Todo lo que un rechazo NO puede haber tocado (criterios 8.19 y 8.21). */
async function worldFingerprint(app: FastifyInstance): Promise<string> {
  const snap = await snapshotOf(app);
  const operations = snap.operations as Json;
  return JSON.stringify({
    audit: operations.audit,
    groups: operations.groups,
    noShows: operations.noShows,
    calReservations: (snap.calendar as Json).reservations,
    storeReservations: snap.reservations,
    waitlist: (snap.waitlist as Json).entries,
  });
}

async function reset(app: FastifyInstance): Promise<void> {
  const res = await post(app, "/api/reset", {});
  expect(res.statusCode).toBe(200);
}

interface RequestLine {
  memberLabel: string;
  serviceId: 0 | 1 | 2;
  employeeId: number;
  startMinutes: number;
}

/** Las dos líneas del escenario §9.2, ya resueltas por la propuesta. */
const ESCENARIO_20_LINES: RequestLine[] = [
  { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
  { memberLabel: "Menor B", serviceId: 0, employeeId: DANI, startMinutes: 570 },
];

const ESCENARIO_20_KEY = "group:2026-08-04:consecutive:540-3-1.570-6-0:r0";

async function proposeGroupOver(
  app: FastifyInstance,
  arrangement: "consecutive" | "simultaneous",
  lines: readonly { memberLabel: string; serviceId: 0 | 1 | 2; professional: Json }[],
  date = BOOKING_DEMO_TODAY,
) {
  return post(app, "/api/booking/group/proposals", { date, arrangement, lines });
}

async function createGroupOver(
  app: FastifyInstance,
  lines: readonly RequestLine[],
  key: string,
  options: { arrangement?: "consecutive" | "simultaneous"; injectFailure?: boolean; date?: string } = {},
) {
  return post(
    app,
    "/api/booking/groups",
    {
      arrangement: options.arrangement ?? "consecutive",
      date: options.date ?? BOOKING_DEMO_TODAY,
      lines,
      confirmed: true,
      ...(options.injectFailure !== undefined ? { injectFailure: options.injectFailure } : {}),
    },
    { "idempotency-key": key },
  );
}

async function cancelReservation(app: FastifyInstance, reservationId: string, key: string) {
  return post(
    app,
    `/api/reservations/${reservationId}/cancel`,
    { reasonCode: "client_cancelled_by_phone_simulated", confirmed: true },
    { "idempotency-key": key },
  );
}

// ---------------------------------------------------------------------
// §4.9 — la propuesta es una CONSULTA
// ---------------------------------------------------------------------

describe("step 18 · §4.9 — POST /api/booking/group/proposals", () => {
  it("devuelve las propuestas del §9.2 completamente RESUELTAS, con la clave que debe acuñar la interfaz", async () => {
    const app = freshApp();
    await reset(app);
    const res = await proposeGroupOver(app, "consecutive", [
      { memberLabel: "Adulto A", serviceId: 1, professional: { kind: "any" } },
      { memberLabel: "Menor B", serviceId: 0, professional: { kind: "any" } },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    const proposals = body.proposals as Json[];
    expect(proposals.length).toBe(3);

    const first = proposals[0] as Json;
    expect(first.label).toBe("Propuesta 1");
    expect(first.arrangementLabel).toBe("Una detrás de otra");
    expect(first.dateLabel).toBe("martes 4 de agosto");
    expect(first.intentKeyToMint).toBe(ESCENARIO_20_KEY);
    expect(IDEMPOTENCY_KEY_PATTERN.test(first.intentKeyToMint as string)).toBe(true);
    expect(first.lines).toEqual([
      {
        memberLabel: "Adulto A",
        serviceId: 1,
        serviceLabel: "Corte de pelo",
        employeeId: ALEX,
        professionalLabel: "Álex (sintético)",
        professionalWasRequested: false,
        date: BOOKING_DEMO_TODAY,
        startMinutes: 540,
        endMinutes: 570,
        whenLabel: "09:00–09:30",
      },
      {
        memberLabel: "Menor B",
        serviceId: 0,
        serviceLabel: "Barba",
        employeeId: DANI,
        professionalLabel: "Dani (sintético)",
        professionalWasRequested: false,
        date: BOOKING_DEMO_TODAY,
        startMinutes: 570,
        endMinutes: 600,
        whenLabel: "09:30–10:00",
      },
    ]);
    await app.close();
  });

  it("(criterio 8.19) proponer no escribe NADA: el mundo queda byte a byte igual", async () => {
    const app = freshApp();
    await reset(app);
    const before = await worldFingerprint(app);
    await proposeGroupOver(app, "consecutive", [
      { memberLabel: "Adulto A", serviceId: 1, professional: { kind: "any" } },
      { memberLabel: "Menor B", serviceId: 0, professional: { kind: "any" } },
    ]);
    await proposeGroupOver(app, "simultaneous", [
      { memberLabel: "Persona 1", serviceId: 1, professional: { kind: "any" } },
      { memberLabel: "Persona 2", serviceId: 1, professional: { kind: "any" } },
    ]);
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  it("las simultáneas del §9.3 salen con profesionales distintos y a la misma hora", async () => {
    const app = freshApp();
    await reset(app);
    const res = await proposeGroupOver(app, "simultaneous", [
      { memberLabel: "Persona 1", serviceId: 1, professional: { kind: "any" } },
      { memberLabel: "Persona 2", serviceId: 1, professional: { kind: "any" } },
    ]);
    const first = (res.json() as Json).proposals as Json[];
    const lines = (first[0] as Json).lines as Json[];
    expect(lines.map((l) => l.employeeId)).toEqual([ALEX, NEREA]);
    expect(lines.every((l) => l.startMinutes === 540)).toBe(true);
    expect((first[0] as Json).intentKeyToMint).toBe("group:2026-08-04:simultaneous:540-3-1.540-9-1:r0");
    await app.close();
  });

  it("(criterio 8.23) dos personas a la vez con el mismo profesional: rechazo ANTES de proponer, con la verdad", async () => {
    const app = freshApp();
    await reset(app);
    const before = await worldFingerprint(app);
    const res = await proposeGroupOver(app, "simultaneous", [
      { memberLabel: "Persona 1", serviceId: 1, professional: { kind: "specific", employeeId: ALEX } },
      { memberLabel: "Persona 2", serviceId: 1, professional: { kind: "specific", employeeId: ALEX } },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.proposals).toEqual([]);
    expect(body.rejected).toEqual({
      conflict: "same_professional_twice_at_the_same_time",
      message:
        "Has pedido a Álex (sintético) para dos personas a la vez. " +
        "Una misma persona del equipo no puede atender dos citas en la misma media hora.",
    });
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  it("dos etiquetas iguales son un 400, no una propuesta rara", async () => {
    const app = freshApp();
    await reset(app);
    const res = await proposeGroupOver(app, "consecutive", [
      { memberLabel: "Persona 1", serviceId: 1, professional: { kind: "any" } },
      { memberLabel: "Persona 1", serviceId: 0, professional: { kind: "any" } },
    ]);
    expect(res.statusCode).toBe(400);
    expect((res.json() as Json).error).toBe("Cada persona necesita una etiqueta distinta.");
    await app.close();
  });

  it("una línea sin servicio es un 400: nada se copia de otra fila", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(app, "/api/booking/group/proposals", {
      date: BOOKING_DEMO_TODAY,
      arrangement: "consecutive",
      lines: [
        { memberLabel: "Adulto A", serviceId: 1, professional: { kind: "any" } },
        { memberLabel: "Menor B", professional: { kind: "any" } },
      ],
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("una etiqueta con nombre propio no pasa del esquema", async () => {
    const app = freshApp();
    await reset(app);
    const res = await proposeGroupOver(app, "consecutive", [
      { memberLabel: "Marta", serviceId: 1, professional: { kind: "any" } },
      { memberLabel: "Persona 2", serviceId: 1, professional: { kind: "any" } },
    ]);
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// §9.2 — crear el grupo
// ---------------------------------------------------------------------

describe("step 18 · §9.2 — POST /api/booking/groups crea las N citas o ninguna", () => {
  it("crea grp-0001 con sus dos citas, en las DOS copias, y escribe 1 + 2 eventos", async () => {
    const app = freshApp();
    await reset(app);
    const auditBefore = await auditTotal(app);

    const res = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(res.statusCode).toBe(201);
    expect(res.headers["idempotency-status"]).toBe("original");
    const body = res.json() as Json;
    expect(body.created).toBe(true);
    expect((body.auditEventIds as string[]).length).toBe(3);

    const group = body.group as Json;
    expect(group.id).toBe("grp-0001");
    expect(group.label).toBe("Reserva para varias personas · grupo 1");
    expect(group.groupState).toBe("fully_active");
    expect(group.groupStateLabel).toBe("Las 2 citas siguen en pie");
    expect(group.cancelNote).toBe("Cancelar una de estas citas no cancela las demás.");
    expect((group.lines as Json[]).map((l) => l.reservationId)).toEqual([
      "res-g-grp-0001-1",
      "res-g-grp-0001-2",
    ]);
    expect((group.lines as Json[])[0]).toEqual({
      reservationId: "res-g-grp-0001-1",
      memberLabel: "Adulto A",
      serviceLabel: "Corte de pelo",
      professionalLabel: "Álex (sintético)",
      whenLabel: "09:00–09:30",
      status: "confirmed",
      statusLabel: "Confirmada",
    });

    // LAS DOS COPIAS, en el mismo tick: la agenda y el MemoryStore.
    const copies = await bothReservationCopies(app);
    for (const id of ["res-g-grp-0001-1", "res-g-grp-0001-2"]) {
      expect(copies.cal.some((r) => r.id === id && r.status === "confirmed"), `cal ${id}`).toBe(true);
      expect(copies.store.some((r) => r.id === id && r.status === "confirmed"), `store ${id}`).toBe(true);
    }

    const operations = await operationsOf(app);
    expect(((operations.audit as Json).total as number) - auditBefore).toBe(3);
    const kinds = ((operations.audit as Json).items as Json[]).slice(-3).map((e) => e.kind);
    expect(kinds).toEqual([
      "RESERVATION_GROUP_CREATED",
      "RESERVATION_GROUP_LINE_CREATED",
      "RESERVATION_GROUP_LINE_CREATED",
    ]);
    const texts = ((operations.audit as Json).items as Json[]).slice(-3).map((e) => e.text);
    expect(texts[0]).toBe(
      "Se han creado 2 citas sintéticas para una reserva de varias personas, el martes 4 de agosto a partir de las 09:00.",
    );
    expect(texts[1]).toBe("Adulto A: martes 4 de agosto, 09:00, Corte de pelo, con Álex (sintético).");
    expect(texts[2]).toBe("Menor B: martes 4 de agosto, 09:30, Barba, con Dani (sintético).");
    await app.close();
  });

  it("las dos citas salen INDIVIDUALMENTE en la agenda, con la referencia sintética del grupo", async () => {
    const app = freshApp();
    await reset(app);
    await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    const snap = await snapshotOf(app);
    const reservations = (snap.calendar as Json).reservations as Json[];
    const primera = reservations.find((r) => r.id === "res-g-grp-0001-1") as Json;
    expect(primera.group).toEqual({
      groupId: "grp-0001",
      groupLabel: "grupo 1",
      memberLabel: "Adulto A",
      positionLabel: "1 de 2",
      cancelNote: "Cancelar esta cita no cancela las demás.",
      cancelDialogNote:
        "Esta cita es parte de una reserva para varias personas (grupo 1, cita 1 de 2). " +
        "Se cancela sólo ésta; las demás se quedan como están.",
      // (Enmienda de fase K, prescrita en DECISIONES §10) La redacción
      // correcta en singular. El plural, con N > 1, no cambia.
      siblingsNote: "La otra cita de este grupo sigue en pie.",
    });
    // Y una cita ajena al grupo no gana ninguna referencia.
    const ajena = reservations.find((r) => r.id === "demo-salon-res-1") as Json;
    expect(ajena.group).toBeUndefined();
    // La MISMA referencia en las dos proyecciones (criterio 9 de step 13).
    const enStore = (snap.reservations as Json[]).find((r) => r.id === "res-g-grp-0001-1") as Json;
    expect(enStore.group).toEqual(primera.group);
    await app.close();
  });

  it("(criterio 8.23) unas simultáneas creadas dejan employeeId distintos y la misma hora", async () => {
    const app = freshApp();
    await reset(app);
    const res = await createGroupOver(
      app,
      [
        { memberLabel: "Persona 1", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
        { memberLabel: "Persona 2", serviceId: 1, employeeId: NEREA, startMinutes: 540 },
      ],
      "group:2026-08-04:simultaneous:540-3-1.540-9-1:r0",
      { arrangement: "simultaneous" },
    );
    expect(res.statusCode).toBe(201);
    const lines = ((res.json() as Json).group as Json).lines as Json[];
    expect(lines.map((l) => l.whenLabel)).toEqual(["09:00–09:30", "09:00–09:30"]);
    expect(lines.map((l) => l.professionalLabel)).toEqual(["Álex (sintético)", "Nerea (sintética)"]);
    await app.close();
  });

  it("pedir a la misma persona del equipo para dos líneas a la vez es 409 y no escribe nada", async () => {
    const app = freshApp();
    await reset(app);
    const before = await worldFingerprint(app);
    const res = await createGroupOver(
      app,
      [
        { memberLabel: "Persona 1", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
        { memberLabel: "Persona 2", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
      ],
      "group:2026-08-04:simultaneous:540-3-1.540-3-1:r0",
      { arrangement: "simultaneous" },
    );
    expect(res.statusCode).toBe(409);
    expect((res.json() as Json).conflict).toBe("same_professional_twice_at_the_same_time");
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  it("sin `confirmed: true` no se crea nada: la confirmación es explícita", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(
      app,
      "/api/booking/groups",
      { arrangement: "consecutive", date: BOOKING_DEMO_TODAY, lines: ESCENARIO_20_LINES },
      { "idempotency-key": ESCENARIO_20_KEY },
    );
    expect(res.statusCode).toBe(400);
    expect(await groupsOf(app)).toEqual([]);
    await app.close();
  });

  it("sin cabecera Idempotency-Key no se crea nada", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(app, "/api/booking/groups", {
      arrangement: "consecutive",
      date: BOOKING_DEMO_TODAY,
      lines: ESCENARIO_20_LINES,
      confirmed: true,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Json).error).toBe("Falta la cabecera Idempotency-Key.");
    expect(await groupsOf(app)).toEqual([]);
    await app.close();
  });

  it("el cuerpo NO admite groupId: la identidad la acuña el servidor", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(
      app,
      "/api/booking/groups",
      {
        arrangement: "consecutive",
        date: BOOKING_DEMO_TODAY,
        lines: ESCENARIO_20_LINES,
        confirmed: true,
        groupId: "grp-9999",
      },
      { "idempotency-key": ESCENARIO_20_KEY },
    );
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// §9.5 — el conflicto: todo o nada
// ---------------------------------------------------------------------

describe("step 18 · §9.5 — el hueco se ocupa entre la propuesta y la confirmación", () => {
  it("(criterio 8.21) 409 slot_no_longer_free con la línea exacta y CERO escrituras", async () => {
    const app = freshApp();
    await reset(app);
    // Alguien ocupa el hueco de Álex a las 09:00 por la ruta de escenarios,
    // exactamente como hace el Laboratorio (§4.13).
    const ocupar = await post(app, "/api/scenario/run", {
      scenarioId: "A01-ocupa-el-hueco",
      turns: [
        {
          utterance: "quiero reservar",
          day: "tuesday",
          time: "09:00",
          professionalId: ALEX,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    expect(ocupar.statusCode).toBe(200);
    expect((ocupar.json() as Json).reservation).toBeDefined();

    const before = await worldFingerprint(app);
    const auditBefore = await auditTotal(app);
    const res = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);

    expect(res.statusCode).toBe(409);
    const body = res.json() as Json;
    expect(body.created).toBe(false);
    expect(body.conflict).toBe("slot_no_longer_free");
    expect(body.line).toEqual({
      memberLabel: "Adulto A",
      when: "09:00",
      professionalLabel: "Álex (sintético)",
    });
    expect(body.reasons).toEqual(["slot_no_longer_free"]);

    // Ni siquiera la cita de Dani, que SÍ estaba libre.
    const copies = await bothReservationCopies(app);
    expect(copies.cal.some((r) => String(r.id).startsWith("res-g-"))).toBe(false);
    expect(copies.store.some((r) => String(r.id).startsWith("res-g-"))).toBe(false);
    expect(await auditTotal(app)).toBe(auditBefore);
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  it("el fallo sintético inyectado devuelve 500 y no escribe nada", async () => {
    const app = freshApp();
    await reset(app);
    const before = await worldFingerprint(app);
    const res = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY, { injectFailure: true });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      created: false,
      code: "synthetic_injected_failure",
      error: "Fallo sintético inyectado. No se ha creado ninguna cita.",
    });
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  it("un 500 no se memoriza: la misma clave vuelve a ejecutarse y esta vez sí crea", async () => {
    const app = freshApp();
    await reset(app);
    expect((await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY, { injectFailure: true })).statusCode).toBe(500);
    // `remember` sólo memoriza 2xx: un fallo no congela la clave para siempre.
    const segunda = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(segunda.statusCode).toBe(201);
    expect(segunda.headers["idempotency-status"]).toBe("original");
    expect(((segunda.json() as Json).group as Json).id).toBe("grp-0001");
    expect((await bothReservationCopies(app)).cal.filter((r) => String(r.id).startsWith("res-g-")).length).toBe(2);
    await app.close();
  });

  it("una línea con un profesional que no puede hacer ese servicio se rechaza señalando la línea", async () => {
    const app = freshApp();
    await reset(app);
    const before = await worldFingerprint(app);
    const res = await createGroupOver(
      app,
      [
        { memberLabel: "Adulto A", serviceId: 0, employeeId: NEREA, startMinutes: 540 },
        { memberLabel: "Menor B", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
      ],
      "group:2026-08-04:simultaneous:540-3-1.540-9-0:r0",
      { arrangement: "simultaneous" },
    );
    expect(res.statusCode).toBe(409);
    const body = res.json() as Json;
    expect(body.conflict).toBe("professional_cannot_perform_service");
    expect((body.line as Json).memberLabel).toBe("Adulto A");
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  it("un hueco ya pasado se rechaza como tal, no como ocupado", async () => {
    const app = freshApp();
    await reset(app);
    // El reloj avanza a las 12:00; el hueco de las 09:00 pasa a ser pasado.
    expect((await post(app, "/api/lab/clock/advance", { command: "advance_minutes", minutes: 180 })).statusCode).toBe(200);
    const before = await worldFingerprint(app);
    const res = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(res.statusCode).toBe(409);
    const body = res.json() as Json;
    expect(body.reasons).toContain("slot_in_the_past");
    expect(body.conflict).toBe("slot_in_the_past");
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  /**
   * LA REPRODUCCIÓN DE H2 por el lado del grupo (revisión adversarial, fase
   * J): con el reloj pasada la medianoche, una fecha de AYER contestaba
   * `date_outside_booking_horizon` —«Ese día queda fuera del plazo…»—, que
   * suena a política de calendario y manda al operador a buscarla. El motivo
   * verdadero es que esos huecos ya han pasado.
   */
  it("(H2) pasada la medianoche, una fecha de AYER se rechaza como pasada, no como fuera de plazo", async () => {
    const app = freshApp();
    await reset(app);
    // 25 horas: el reloj cambia de día y el 2026-08-04 queda atrás.
    expect((await post(app, "/api/lab/clock/advance", { command: "advance_minutes", minutes: 1500 })).statusCode).toBe(200);
    const before = await worldFingerprint(app);

    const res = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(res.statusCode).toBe(409);
    const body = res.json() as Json;
    // El motivo que se enseña es el primero, y es el verdadero. El de horizonte
    // también es cierto y también se dice: no se esconde ninguno de los dos.
    expect(body.conflict).toBe("slot_in_the_past");
    expect(body.reasons).toEqual(["slot_in_the_past", "date_outside_booking_horizon"]);
    expect((body.line as Json).memberLabel).toBe("Adulto A");
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// §4.8 — idempotencia de transporte y estructural
// ---------------------------------------------------------------------

describe("step 18 · §4.8 — repetir no duplica", () => {
  /**
   * ENMIENDA DE FASE K (H1). Esta prueba fijaba `replayed` y «el mismo cuerpo
   * byte a byte». Fijaba, por tanto, la mentira: la respuesta memorizada del
   * `201` decía «created: true» con las citas `confirmed` aunque para entonces
   * estuvieran canceladas. La expectativa cambia —no se afloja— a lo que ahora
   * es verdad: la ruta VUELVE A EJECUTAR y contesta lo que pasa de verdad, que
   * con el grupo entero en pie es `200 alreadyExists` con la proyección de AHORA.
   * La protección que importaba sigue entera y se comprueba aquí abajo: ni una
   * cita nueva, un solo grupo, y una sola anotación de repetición.
   */
  it("(criterio 8.22, enmendado en fase K) doble clic con la MISMA clave: se vuelve a ejecutar y dice la verdad, sin ni una cita nueva", async () => {
    const app = freshApp();
    await reset(app);
    const primera = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(primera.statusCode).toBe(201);
    const auditTrasPrimera = await auditTotal(app);

    const segunda = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(segunda.statusCode).toBe(200);
    // La cabecera lo dice con todas las letras: la clave ya se conocía y esta
    // ruta ha ejecutado igualmente. Nunca dice `replayed`, porque no reproduce.
    expect(segunda.headers["idempotency-status"]).toBe("re-executed");
    const cuerpoSegunda = segunda.json() as Json;
    expect(cuerpoSegunda.created).toBe(false);
    expect(cuerpoSegunda.alreadyExists).toBe(true);
    // Y lo que devuelve es la proyección del mundo de AHORA, no un cuerpo guardado.
    expect((cuerpoSegunda.group as Json).id).toBe("grp-0001");
    expect((cuerpoSegunda.group as Json).groupStateLabel).toBe("Las 2 citas siguen en pie");

    expect((await groupsOf(app)).length).toBe(1);
    const copies = await bothReservationCopies(app);
    expect(copies.cal.filter((r) => String(r.id).startsWith("res-g-")).length).toBe(2);
    expect(copies.store.filter((r) => String(r.id).startsWith("res-g-")).length).toBe(2);
    // La repetición escribe UNA cosa: que fue una repetición.
    expect(await auditTotal(app)).toBe(auditTrasPrimera + 1);
    const operations = await operationsOf(app);
    const ultimo = ((operations.audit as Json).items as Json[]).at(-1) as Json;
    expect(ultimo.kind).toBe("RESERVATION_GROUP_REPEATED");
    expect(ultimo.text).toBe(
      "Se ha repetido la creación de esta reserva de varias personas. No se ha creado ninguna cita nueva.",
    );
    // Y es la repetición ESTRUCTURAL, la que sabe de qué grupo habla: ya no
    // existe la de transporte, que no podía decirlo.
    expect(ultimo.groupId).toBe("grp-0001");
    await app.close();
  });

  /**
   * LA REPRODUCCIÓN EXACTA DE H1 (revisión adversarial, fase J). Antes de la
   * enmienda de fase K, esta misma secuencia devolvía el `201` memorizado
   * —«created: true», citas `confirmed`— sin llegar jamás a la comprobación
   * estructural, y el operador perdía una reserva en silencio.
   */
  it("(H1) crear, cancelar las DOS citas y repetir la MISMA clave: se ejecuta de verdad y crea grp-0002", async () => {
    const app = freshApp();
    await reset(app);
    expect((await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY)).statusCode).toBe(201);
    expect((await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0")).statusCode).toBe(200);
    expect((await cancelReservation(app, "res-g-grp-0001-2", "cancel:res-g-grp-0001-2:v0")).statusCode).toBe(200);

    // LA MISMA CLAVE de la primera creación, la que la interfaz mandó entonces.
    const repetida = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(repetida.statusCode).toBe(201);
    expect(repetida.headers["idempotency-status"]).toBe("re-executed");
    const body = repetida.json() as Json;
    expect(body.created).toBe(true);
    expect(body.alreadyExists).toBeUndefined();
    // Ni una palabra sobre citas que ya no están: el grupo que se devuelve es
    // el nuevo, con sus dos citas de verdad.
    expect((body.group as Json).id).toBe("grp-0002");
    expect(((body.group as Json).lines as Json[]).map((l) => l.reservationId)).toEqual([
      "res-g-grp-0002-1",
      "res-g-grp-0002-2",
    ]);
    const copies = await bothReservationCopies(app);
    for (const id of ["res-g-grp-0002-1", "res-g-grp-0002-2"]) {
      expect(copies.cal.some((r) => r.id === id && r.status === "confirmed"), `cal ${id}`).toBe(true);
      expect(copies.store.some((r) => r.id === id && r.status === "confirmed"), `store ${id}`).toBe(true);
    }
    expect(((await operationsOf(app)).integrity as Json).ok).toBe(true);
    await app.close();
  });

  it("(H1) crear, cancelar UNA cita y repetir la MISMA clave: 409 slot_no_longer_free señalando la línea VIVA", async () => {
    const app = freshApp();
    await reset(app);
    expect((await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY)).statusCode).toBe(201);
    expect((await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0")).statusCode).toBe(200);

    const before = await worldFingerprint(app);
    const repetida = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(repetida.statusCode).toBe(409);
    const body = repetida.json() as Json;
    expect(body.created).toBe(false);
    expect(body.alreadyExists).toBeUndefined();
    expect(body.conflict).toBe("slot_no_longer_free");
    // La línea que señala es la que NO se canceló: la cita de las 09:30 con Dani.
    expect(body.line).toEqual({
      memberLabel: "Menor B",
      when: "09:30",
      professionalLabel: "Dani (sintético)",
    });
    // Un rechazo no se memoriza y no escribe nada: ni un evento, ni una cita.
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  it("(criterio 8.22) con clave distinta y las mismas líneas VIVAS: 200 alreadyExists, sin citas nuevas", async () => {
    const app = freshApp();
    await reset(app);
    expect((await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY)).statusCode).toBe(201);
    const auditTrasPrimera = await auditTotal(app);

    const otraPestana = await createGroupOver(app, ESCENARIO_20_LINES, "group:2026-08-04:consecutive:540-3-1.570-6-0:r9");
    expect(otraPestana.statusCode).toBe(200);
    expect(otraPestana.headers["idempotency-status"]).toBe("original");
    const body = otraPestana.json() as Json;
    expect(body.created).toBe(false);
    expect(body.alreadyExists).toBe(true);
    expect((body.group as Json).id).toBe("grp-0001");

    expect((await groupsOf(app)).length).toBe(1);
    expect((await bothReservationCopies(app)).cal.filter((r) => String(r.id).startsWith("res-g-")).length).toBe(2);
    expect(await auditTotal(app)).toBe(auditTrasPrimera + 1);
    await app.close();
  });

  it("la instantánea acuña :r1 cuando ya existe un grupo con esa intención", async () => {
    const app = freshApp();
    await reset(app);
    await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    const grupo = (await groupsOf(app))[0] as Json;
    expect(grupo.intentKeyToMint).toBe("group:2026-08-04:consecutive:540-3-1.570-6-0:r1");

    // Y cuando esos dos huecos vuelven a estar libres, la propuesta que los
    // vuelve a resolver acuña esa MISMA clave con el discriminante ya subido:
    // cancelar no cambia el contador, crear sí. El cliente no deriva nada.
    await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0");
    await cancelReservation(app, "res-g-grp-0001-2", "cancel:res-g-grp-0001-2:v0");
    const res = await proposeGroupOver(app, "consecutive", [
      { memberLabel: "Adulto A", serviceId: 1, professional: { kind: "any" } },
      { memberLabel: "Menor B", serviceId: 0, professional: { kind: "any" } },
    ]);
    const primera = ((res.json() as Json).proposals as Json[])[0] as Json;
    expect((primera.lines as Json[]).map((l) => [l.employeeId, l.startMinutes])).toEqual([
      [ALEX, 540],
      [DANI, 570],
    ]);
    expect(primera.intentKeyToMint).toBe("group:2026-08-04:consecutive:540-3-1.570-6-0:r1");
    await app.close();
  });
});

// ---------------------------------------------------------------------
// §9.6 — cancelar una línea, y la continuación obligatoria (criterio 8.42)
// ---------------------------------------------------------------------

describe("step 18 · §9.6 — cancelar una cita del grupo", () => {
  it("(criterio 8.24) cancelar una línea deja la hermana en pie y el grupo en partially_cancelled", async () => {
    const app = freshApp();
    await reset(app);
    await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);

    const res = await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    // El hueco liberado se evalúa contra la lista de espera EXACTAMENTE igual
    // que cualquier otro: la cancelación devuelve sus huecos y sus compatibles.
    expect((body.releasedSlots as Json[]).length).toBeGreaterThan(0);
    expect(body.matches).toBeDefined();

    const grupo = (await groupsOf(app))[0] as Json;
    expect(grupo.groupState).toBe("partially_cancelled");
    expect(grupo.groupStateLabel).toBe("Queda 1 cita en pie de 2");
    expect((grupo.lines as Json[]).map((l) => l.status)).toEqual(["cancelled", "confirmed"]);

    const copies = await bothReservationCopies(app);
    expect(copies.cal.find((r) => r.id === "res-g-grp-0001-2")?.status).toBe("confirmed");
    expect(copies.store.find((r) => r.id === "res-g-grp-0001-2")?.status).toBe("confirmed");
    expect(copies.cal.find((r) => r.id === "res-g-grp-0001-1")?.status).toBe("cancelled");
    expect(copies.store.find((r) => r.id === "res-g-grp-0001-1")?.status).toBe("cancelled");

    // La cita cancelada dice, sin inventar nada, qué pasa con sus hermanas.
    const cancelada = copies.cal.find((r) => r.id === "res-g-grp-0001-1") as Json;
    // (Enmienda de fase K, prescrita en DECISIONES §10) Singular correcto.
    expect((cancelada.group as Json).siblingsNote).toBe("La otra cita de este grupo sigue en pie.");
    await app.close();
  });

  it("(criterio 8.42, a) con UNA línea cancelada NO se dice «ya estaba creada»: se revalida de verdad", async () => {
    const app = freshApp();
    await reset(app);
    expect((await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY)).statusCode).toBe(201);
    expect((await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0")).statusCode).toBe(200);

    // La interfaz acuña :r1 porque ya existe UN grupo con esa intención.
    const before = await worldFingerprint(app);
    const res = await createGroupOver(app, ESCENARIO_20_LINES, "group:2026-08-04:consecutive:540-3-1.570-6-0:r1");

    // NO es una repetición: la condición estructural exige que TODAS las
    // líneas sigan en pie, y una está cancelada. Lo que se obtiene es la
    // verdad de la revalidación — la cita de las 09:30 con Dani, la que NO se
    // canceló, sigue ocupando su hueco — y no la mentira «ya estaba creada».
    expect(res.statusCode).toBe(409);
    const body = res.json() as Json;
    expect(body.alreadyExists).toBeUndefined();
    expect(body.conflict).toBe("slot_no_longer_free");
    expect((body.line as Json).memberLabel).toBe("Menor B");
    expect(JSON.stringify(body)).not.toContain("group_id");
    // Y el hueco NO queda bloqueado ni se escribe nada.
    expect(await worldFingerprint(app)).toBe(before);
    await app.close();
  });

  it("(criterio 8.42, b) canceladas las dos citas, la misma petición crea grp-0002 sin ids duplicados", async () => {
    const app = freshApp();
    await reset(app);
    expect((await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY)).statusCode).toBe(201);
    expect((await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0")).statusCode).toBe(200);
    expect((await cancelReservation(app, "res-g-grp-0001-2", "cancel:res-g-grp-0001-2:v0")).statusCode).toBe(200);

    const res = await createGroupOver(app, ESCENARIO_20_LINES, "group:2026-08-04:consecutive:540-3-1.570-6-0:r1");
    expect(res.statusCode).toBe(201);
    const body = res.json() as Json;
    expect(body.created).toBe(true);
    expect(body.alreadyExists).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("group_id");
    expect((body.group as Json).id).toBe("grp-0002");
    expect(((body.group as Json).lines as Json[]).map((l) => l.reservationId)).toEqual([
      "res-g-grp-0002-1",
      "res-g-grp-0002-2",
    ]);

    // Ningún id de reserva duplicado en NINGUNA de las dos copias: es lo que
    // hace inofensivo que `memoryStore.addReservation` empuje sin comprobar.
    const copies = await bothReservationCopies(app);
    for (const [name, list] of [["cal", copies.cal], ["store", copies.store]] as const) {
      const ids = list.map((r) => r.id as string);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
    expect(copies.cal.filter((r) => String(r.id).startsWith("res-g-")).length).toBe(4);
    expect((await groupsOf(app)).map((g) => g.id)).toEqual(["grp-0001", "grp-0002"]);
    expect(((await operationsOf(app)).integrity as Json).ok).toBe(true);
    await app.close();
  });

  it("(criterio 8.42, c) el camino del operador: cancelar una, volver a proponer y confirmar crea grp-0002", async () => {
    const app = freshApp();
    await reset(app);
    expect((await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY)).statusCode).toBe(201);
    expect((await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0")).statusCode).toBe(200);

    // Exactamente la misma petición del §9.2, desde el principio: dos
    // personas, sus dos servicios, «cualquiera». El servidor vuelve a
    // resolverla contra el mundo de AHORA.
    const propuesta = await proposeGroupOver(app, "consecutive", [
      { memberLabel: "Adulto A", serviceId: 1, professional: { kind: "any" } },
      { memberLabel: "Menor B", serviceId: 0, professional: { kind: "any" } },
    ]);
    const primera = ((propuesta.json() as Json).proposals as Json[])[0] as Json;
    const lines = (primera.lines as Json[]).map((l) => ({
      memberLabel: l.memberLabel as string,
      serviceId: l.serviceId as 0 | 1 | 2,
      employeeId: l.employeeId as number,
      startMinutes: l.startMinutes as number,
    }));
    // El hueco de Dani a las 09:30 sigue ocupado por la cita que NO se
    // canceló, así que la propuesta nueva no puede ser la misma.
    expect(lines.some((l) => l.employeeId === DANI && l.startMinutes === 570)).toBe(false);

    const res = await createGroupOver(app, lines, primera.intentKeyToMint as string);
    expect(res.statusCode).toBe(201);
    expect(((res.json() as Json).group as Json).id).toBe("grp-0002");
    const copies = await bothReservationCopies(app);
    const ids = copies.cal.map((r) => r.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(((await operationsOf(app)).integrity as Json).ok).toBe(true);
    await app.close();
  });

  it("cancelar una línea no toca a la otra ni en el historial de operaciones", async () => {
    const app = freshApp();
    await reset(app);
    await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    const antes = await auditTotal(app);
    await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0");
    // La cancelación es de la lista de espera: el registro de operaciones no
    // gana ni un evento, porque un grupo no propaga nada.
    expect(await auditTotal(app)).toBe(antes);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// Criterio 8.43 — dos grupos disputándose un hueco
// ---------------------------------------------------------------------

describe("step 18 · criterio 8.43 — dos peticiones distintas sobre el mismo hueco", () => {
  it("la segunda sale por slot_no_longer_free, sin ningún código de identidad", async () => {
    const app = freshApp();
    await reset(app);
    const primera = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(primera.statusCode).toBe(201);

    // Otro grupo, con OTRAS personas y otro servicio, que quiere el mismo
    // primer hueco (Álex, 09:00).
    const segunda = await createGroupOver(
      app,
      [
        { memberLabel: "Persona 1", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
        { memberLabel: "Persona 2", serviceId: 1, employeeId: NEREA, startMinutes: 540 },
      ],
      "group:2026-08-04:simultaneous:540-3-1.540-9-1:r0",
      { arrangement: "simultaneous" },
    );
    expect(segunda.statusCode).toBe(409);
    const body = segunda.json() as Json;
    expect(body.conflict).toBe("slot_no_longer_free");
    expect((body.line as Json).memberLabel).toBe("Persona 1");
    expect(JSON.stringify(body)).not.toContain("group_id");
    expect((await groupsOf(app)).length).toBe(1);
    await app.close();
  });

  it("dos peticiones seguidas, sin nada entre medias: la segunda no puede doblar la reserva", async () => {
    const app = freshApp();
    await reset(app);
    // Node atiende una petición por tick y este camino no es `async`: lanzar
    // las dos a la vez y esperarlas juntas es la carrera más ajustada que se
    // puede montar contra este servidor.
    const [a, b] = await Promise.all([
      createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY),
      createGroupOver(
        app,
        [
          { memberLabel: "Persona 1", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
          { memberLabel: "Persona 2", serviceId: 1, employeeId: NEREA, startMinutes: 540 },
        ],
        "group:2026-08-04:simultaneous:540-3-1.540-9-1:r0",
        { arrangement: "simultaneous" },
      ),
    ]);
    const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(codes).toEqual([201, 409]);
    const perdedora = (a.statusCode === 409 ? a : b).json() as Json;
    expect(perdedora.conflict).toBe("slot_no_longer_free");

    // Un solo grupo, dos citas, y el hueco de Álex ocupado UNA vez.
    expect((await groupsOf(app)).length).toBe(1);
    const copies = await bothReservationCopies(app);
    const alexALas9 = copies.cal.filter(
      (r) => r.employeeId === ALEX && r.startMinutes === 540 && r.status === "confirmed",
    );
    expect(alexALas9.length).toBe(1);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// Reinicio, determinismo y privacidad
// ---------------------------------------------------------------------

describe("step 18 · §1.5 y §8 — reinicio, determinismo y privacidad con grupos vivos", () => {
  it("el reinicio borra los grupos Y devuelve la secuencia al principio", async () => {
    const app = freshApp();
    await reset(app);
    expect((await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY)).statusCode).toBe(201);
    expect((await groupsOf(app)).length).toBe(1);

    await reset(app);
    expect(await groupsOf(app)).toEqual([]);
    const copies = await bothReservationCopies(app);
    expect(copies.cal.some((r) => String(r.id).startsWith("res-g-"))).toBe(false);
    expect(copies.store.some((r) => String(r.id).startsWith("res-g-"))).toBe(false);

    // Y el siguiente grupo vuelve a ser grp-0001: la secuencia no arrastra
    // nada del mundo anterior.
    const otra = await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(((otra.json() as Json).group as Json).id).toBe("grp-0001");
    await app.close();
  });

  it("(criterio 8.33) la misma secuencia de peticiones desde cero da los mismos identificadores", async () => {
    const run = async (): Promise<string> => {
      const app = freshApp();
      await reset(app);
      await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
      await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0");
      await cancelReservation(app, "res-g-grp-0001-2", "cancel:res-g-grp-0001-2:v0");
      await createGroupOver(app, ESCENARIO_20_LINES, "group:2026-08-04:consecutive:540-3-1.570-6-0:r1");
      const operations = await operationsOf(app);
      const snapshot = JSON.stringify({
        groups: operations.groups,
        audit: operations.audit,
        integrity: operations.integrity,
      });
      await app.close();
      return snapshot;
    };
    const a = await run();
    const b = await run();
    const c = await run();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).toContain("grp-0002");
  });

  it("la instantánea con grupos vivos no trae ningún dato personal ni identificador prohibido en texto", async () => {
    const app = freshApp();
    await reset(app);
    await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    const snap = await snapshotOf(app);

    // (a) Ninguna clave del árbol casa con la lista negra de datos personales.
    const banned = ["phone", "telefono", "name", "nombre", "apellido", "email", "transcript", "audio", "recording", "dni", "nif"];
    const offenders: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => { walk(item, `${path}[${String(i)}]`); });
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = key.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        for (const word of banned) if (normalized.includes(word)) offenders.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    };
    walk(snap.operations, "$.operations");
    walk((snap.calendar as Json).reservations, "$.calendar.reservations");
    expect(offenders).toEqual([]);

    // (b) Las etiquetas de persona son SÓLO las de la expresión cerrada.
    const grupo = (await groupsOf(app))[0] as Json;
    for (const line of grupo.lines as Json[]) {
      expect(/^(Persona [1-4]|Adulto [A-D]|Menor [A-D])$/.test(line.memberLabel as string)).toBe(true);
    }

    // (c) Ningún texto pintable del historial contiene identificadores internos.
    const textos = (((snap.operations as Json).audit as Json).items as Json[]).map((e) => e.text as string);
    for (const texto of textos) {
      expect(texto.includes("grp-"), texto).toBe(false);
      expect(texto.includes("res-g-"), texto).toBe(false);
      expect(texto.includes("slot-2026"), texto).toBe(false);
      expect(texto.includes("group:"), texto).toBe(false);
    }
    // Y las frases del grupo tampoco.
    for (const texto of [grupo.label, grupo.groupStateLabel, grupo.cancelNote, grupo.dateLabel] as string[]) {
      expect(texto.includes("grp-"), texto).toBe(false);
      expect(texto.includes("slot-2026"), texto).toBe(false);
    }
    await app.close();
  });

  it("los invariantes de integridad siguen en verde con grupos vivos y con grupos a medio cancelar", async () => {
    const app = freshApp();
    await reset(app);
    await createGroupOver(app, ESCENARIO_20_LINES, ESCENARIO_20_KEY);
    expect(((await operationsOf(app)).integrity as Json).ok).toBe(true);
    // El invariante de la lista de espera (step 17) tampoco se inmuta: un
    // grupo no es una conversión y no aparece en su recuento.
    const snapConGrupo = await snapshotOf(app);
    expect(((snapConGrupo.waitlist as Json).integrity as Json).ok).toBe(true);

    await cancelReservation(app, "res-g-grp-0001-1", "cancel:res-g-grp-0001-1:v0");
    const snapTrasCancelar = await snapshotOf(app);
    expect(((snapTrasCancelar.operations as Json).integrity as Json).ok).toBe(true);
    expect(((snapTrasCancelar.waitlist as Json).integrity as Json).ok).toBe(true);
    await app.close();
  });

  it("la copia del grupo dice, en las dos direcciones, que cancelar una no cancela las demás", async () => {
    const app = freshApp();
    await reset(app);
    const operations = await operationsOf(app);
    expect((operations.groups as Json).copy).toEqual(GROUP_COPY);
    expect(GROUP_COPY.cancelNoteForGroup).toBe("Cancelar una de estas citas no cancela las demás.");
    expect(GROUP_COPY.cancelNoteForLine).toBe("Cancelar esta cita no cancela las demás.");
    await app.close();
  });
});
