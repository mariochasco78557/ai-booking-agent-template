/**
 * Adaptador `google-calendar` (v0.6.0, D-014): huecos desde free/busy y el
 * horario de cliente.yaml, cierres, zona horaria distinta de Madrid, ida y
 * vuelta crear/buscar/anular, back office, calendario único y selección por
 * CALENDAR_PROVIDER. Google falso en memoria (tests/helpers/fakeGoogleCalendar.ts):
 * sin red y sin credenciales reales.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bookingIdFromEventId,
  createGoogleCalendar,
  createGoogleCalendarBackOffice,
  eventIdForBooking,
  PROP,
  type GoogleCalendar,
} from "../src/adapters/calendar/google-calendar/index.js";
import { wallToEpochMs, wallToMinutes } from "../src/adapters/calendar/google-calendar/timezone.js";
import { loadServiceAccount } from "../src/adapters/calendar/google-calendar/googleApi.js";
import { createCalendarBackOffice, createCalendarProvider } from "../src/adapters/calendar/index.js";
import { UpstreamError } from "../src/core/calendar/CalendarProvider.js";
import {
  clientConfigSchema,
  defaultEmployeeResourceId,
  loadClientConfigFrom,
  resetClientConfigForTests,
  type ClientConfig,
} from "../src/core/config/clientConfig.js";
import { loadEnv, resetEnvCache, type Env } from "../src/config/env.js";
import { FAKE_SA, FAKE_SA_B64, FakeGoogleCalendar } from "./helpers/fakeGoogleCalendar.js";

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const ANA_CAL = "ana@group.calendar.google.com";
const BEA_CAL = "bea@group.calendar.google.com";

function config(over: Record<string, unknown> = {}): ClientConfig {
  return clientConfigSchema.parse({
    nombre: "Negocio de prueba",
    sector: "peluquería",
    idioma: "es-ES",
    zona_horaria: "Europe/Madrid",
    telefono: { mostrar: "900 00 00 00", e164: "+34900000000" },
    horario: {
      lunes: ["09:00-13:00", "16:00-19:00"],
      martes: ["09:00-13:00", "16:00-19:00"],
      miercoles: ["09:00-13:00", "16:00-19:00"],
      jueves: ["09:00-13:00", "16:00-19:00"],
      viernes: ["09:00-13:00", "16:00-19:00"],
      sabado: ["09:00-14:00"],
      domingo: [],
    },
    cierre_temprano: { sabado: "12:00" },
    cierres: [{ desde: "2026-12-24", hasta: "2026-12-26", motivo: "Navidad" }],
    duracion_cita_min: 30,
    servicios: [
      { id: "1", nombre: "Corte", duracion_min: 30, precio: 15 },
      { id: "2", nombre: "Tinte", duracion_min: 60 },
    ],
    empleados: [
      { nombre: "Ana", calendario: ANA_CAL },
      { nombre: "Bea", calendario: BEA_CAL, apellidos_agenda: "Dos" },
    ],
    calendario: { provider: "google-calendar", empleado_por_defecto: ANA_CAL, servicio_por_defecto: "1" },
    ...over,
  });
}

const TUE = "2026-11-03"; // martes
const NOW = Date.parse("2026-11-01T08:00:00Z");

function setup(opts: { cfg?: ClientConfig; tz?: string; now?: number; calendars?: string[] } = {}) {
  const cfg = opts.cfg ?? config();
  const fake = new FakeGoogleCalendar(opts.tz ?? cfg.zona_horaria, opts.calendars ?? [ANA_CAL, BEA_CAL]);
  let nextId = 100;
  const make = () =>
    createGoogleCalendar({
      clientConfig: cfg,
      serviceAccount: FAKE_SA,
      timeoutMs: 2000,
      logger: silent,
      fetch: fake.fetch,
      now: () => opts.now ?? NOW,
      newBookingId: () => nextId++,
    });
  return { fake, cal: make(), make, cfg };
}

const starts = (free: Awaited<ReturnType<GoogleCalendar["listFreeSlots"]>>, id: number) =>
  free.find((r) => r.id === id)?.slots.map((s) => s.start.slice(11, 16));

describe("google-calendar · zona horaria", () => {
  it("convierte pared <-> instante en Madrid (invierno/verano), México y en los cambios de hora", () => {
    expect(new Date(wallToEpochMs("2026-11-03", 600, "Europe/Madrid")).toISOString()).toBe("2026-11-03T09:00:00.000Z");
    expect(new Date(wallToEpochMs("2026-07-03", 600, "Europe/Madrid")).toISOString()).toBe("2026-07-03T08:00:00.000Z");
    expect(new Date(wallToEpochMs("2026-11-03", 600, "America/Mexico_City")).toISOString()).toBe("2026-11-03T16:00:00.000Z");
    // 2026-03-29 02:30 no existe en Madrid; 2026-10-25 02:30 se repite (primera aparición, +02:00).
    expect(new Date(wallToEpochMs("2026-03-29", 180, "Europe/Madrid")).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(new Date(wallToEpochMs("2026-03-29", 150, "Europe/Madrid")).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(new Date(wallToEpochMs("2026-10-25", 150, "Europe/Madrid")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(wallToMinutes(Date.parse("2026-11-03T16:00:00Z"), "America/Mexico_City")).toEqual({ date: "2026-11-03", minutes: 600 });
    expect(wallToMinutes(Date.parse("2026-11-03T23:30:00Z"), "Europe/Madrid")).toEqual({ date: "2026-11-04", minutes: 30 });
  });
});

describe("google-calendar · huecos", () => {
  it("free/busy a huecos: horario de cliente.yaml, paso de 30 min y ocupado restado", async () => {
    const { fake, cal } = setup();
    fake.addBusy(ANA_CAL, TUE, "10:00", "11:00");
    fake.addBusy(ANA_CAL, TUE, "16:00", "19:00");
    const free = await cal.listFreeSlots({ date: TUE, resourceIds: [1, 2], serviceId: "1" });
    expect(starts(free, 1)).toEqual(["09:00", "09:30", "11:00", "11:30", "12:00", "12:30"]);
    expect(starts(free, 2)).toHaveLength(14);
    expect(free.find((r) => r.id === 1)!.slots[0]).toEqual({ start: `${TUE} 09:00:00`, end: `${TUE} 09:30:00` });
    const fb = fake.apiCalls().find((r) => r.path === "/freeBusy")!;
    expect(fb.body).toMatchObject({
      timeMin: "2026-11-02T23:00:00.000Z",
      timeMax: "2026-11-03T23:00:00.000Z",
      items: [{ id: ANA_CAL }, { id: BEA_CAL }],
    });
  });

  it("la duración del servicio manda: un tinte de 60 min no cruza ocupado ni el cierre de mediodía", async () => {
    const { fake, cal } = setup();
    fake.addBusy(ANA_CAL, TUE, "10:30", "11:00");
    const free = await cal.listFreeSlots({ date: TUE, resourceIds: [1], serviceId: "2" });
    expect(starts(free, 1)).toEqual(["09:00", "09:30", "11:00", "11:30", "12:00", "16:00", "16:30", "17:00", "17:30", "18:00"]);
    expect(free[0]!.slots.find((s) => s.start.endsWith("12:00:00"))!.end).toBe(`${TUE} 13:00:00`);
  });

  it("eventos transparentes no ocupan; el cierre temprano del sábado corta los inicios", async () => {
    const { fake, cal } = setup();
    fake.addBusy(ANA_CAL, TUE, "09:00", "13:00", { transparency: "transparent" });
    expect(starts(await cal.listFreeSlots({ date: TUE, resourceIds: [1], serviceId: "1" }), 1)).toContain("09:00");
    const sat = await cal.listFreeSlots({ date: "2026-11-07", resourceIds: [1], serviceId: "1" });
    expect(starts(sat, 1)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
  });

  it("día cerrado (domingo) y cierres de cliente.yaml: sin recursos ni huecos y sin llamar a Google", async () => {
    const { fake, cal } = setup();
    expect(await cal.listResourcesForDay("2026-11-08")).toEqual([]);
    expect(await cal.listFreeSlots({ date: "2026-12-25", resourceIds: [1, 2], serviceId: "1" })).toEqual([]);
    expect(fake.apiCalls()).toHaveLength(0);
    const holiday = await cal.checkAvailability({ date: "2026-12-24", typeReservation: 1 });
    expect(holiday).toMatchObject({ ok: false, code: "CLOSED_HOLIDAY", data: { employees: [] } });
  });

  it("no ofrece horas pasadas", async () => {
    const { cal } = setup({ now: Date.parse("2026-11-03T10:10:00Z") }); // 11:10 en Madrid
    const free = await cal.listFreeSlots({ date: TUE, resourceIds: [1], serviceId: "1" });
    expect(starts(free, 1)![0]).toBe("11:30");
  });

  it("recursos del día: fuera quien tiene un evento de día completo o un calendario no compartido", async () => {
    const { fake, cal } = setup({ calendars: [ANA_CAL] });
    expect(await cal.listResourcesForDay(TUE)).toEqual([{ id: 1, name: "Ana", surnames: "" }]);
    expect(silent.warn).toHaveBeenCalled();
    fake.addAllDay(ANA_CAL, TUE, "2026-11-04");
    expect(await cal.listResourcesForDay(TUE)).toEqual([]);
  });

  it("America/Mexico_City: horario local, ocupado en UTC y evento con su zona", async () => {
    const cfg = config({ zona_horaria: "America/Mexico_City" });
    const { fake, cal } = setup({ cfg });
    // 16:00Z-17:00Z = 10:00-11:00 en Ciudad de México (UTC-6).
    fake.addEvent(ANA_CAL, { start: { dateTime: "2026-11-03T16:00:00Z" }, end: { dateTime: "2026-11-03T17:00:00Z" } });
    const free = await cal.listFreeSlots({ date: TUE, resourceIds: [1], serviceId: "1" });
    expect(starts(free, 1)!.slice(0, 4)).toEqual(["09:00", "09:30", "11:00", "11:30"]);
    expect(fake.apiCalls()[0]!.body).toMatchObject({ timeMin: "2026-11-03T06:00:00.000Z", timeZone: "America/Mexico_City" });
    const created = await cal.createBooking({
      reservationDate: `${TUE} 12:00:00`,
      typeReservation: "1",
      employee: { id: 1, name: "Ana", surnames: "" },
      ownerName: "Luis",
      ownerSurnames: "Pérez",
      ownerPhone: "+525512345678",
    });
    const ev = fake.events(ANA_CAL).find((e) => e.id === eventIdForBooking(created.id!))!;
    expect(ev.start).toEqual({ dateTime: "2026-11-03T12:00:00", timeZone: "America/Mexico_City" });
    const office = createGoogleCalendarBackOffice({
      clientConfig: cfg,
      serviceAccount: FAKE_SA,
      timeoutMs: 2000,
      logger: silent,
      fetch: fake.fetch,
      now: () => NOW,
    });
    const list = await office.listBookings({ fromDate: TUE, toDate: TUE });
    expect(list.rows.map((r) => [r.startsAt, r.ownerPhoneE164])).toEqual([[`${TUE} 12:00`, "+525512345678"]]);
  });
});

describe("google-calendar · reservas", () => {
  it("crea el evento con resumen, descripción y propiedades privadas flowara.*", async () => {
    const { fake, cal } = setup();
    const created = await cal.createBooking({
      reservationDate: `${TUE} 09:30:00`,
      typeReservation: "2",
      employee: { id: 2, name: "Bea", surnames: "Dos" },
      ownerName: "IA - Marta",
      ownerSurnames: "Ruiz",
      ownerPhone: "600 11 22 33",
    });
    expect(created).toEqual({ id: 100 });
    const ev = fake.events(BEA_CAL)[0]!;
    expect(ev.id).toBe("fb000000000000100");
    expect(bookingIdFromEventId(ev.id)).toBe(100);
    expect(ev.summary).toBe("Tinte - IA - Marta Ruiz");
    expect(ev.description).toContain("+34600112233");
    expect(ev.end).toEqual({ dateTime: `${TUE}T10:30:00`, timeZone: "Europe/Madrid" });
    expect(ev.extendedProperties!.private).toEqual({
      [PROP.bookingId]: "100",
      [PROP.phone]: "+34600112233",
      [PROP.serviceId]: "2",
      [PROP.employeeId]: "2",
      [PROP.ownerName]: "IA - Marta",
      [PROP.ownerSurnames]: "Ruiz",
    });
  });

  it("hueco ocupado: UpstreamError 409 con el mensaje que el núcleo trata como «ya no disponible»", async () => {
    const { fake, cal } = setup();
    fake.addBusy(ANA_CAL, TUE, "10:00", "10:30");
    const req = {
      reservationDate: `${TUE} 10:00:00`,
      typeReservation: "1",
      employee: { id: 1, name: "Ana", surnames: "" },
      ownerName: "X",
      ownerSurnames: "Y",
    };
    const err = (await cal.createBooking(req).catch((e: unknown) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(409);
    expect(err.upstreamMessage).toMatch(/no est[aá]n? disponible|ya no est/i);
    const outOfHours = (await cal.createBooking({ ...req, reservationDate: `${TUE} 14:00:00` }).catch((e: unknown) => e)) as UpstreamError;
    expect(outOfHours.status).toBe(409);
    expect(fake.apiCalls().filter((r) => r.method === "POST" && r.path.endsWith("/events"))).toHaveLength(0);
  });

  it("dos reservas simultáneas al mismo hueco: solo una entra (cerrojo por calendario)", async () => {
    const { fake, cal } = setup();
    const req = {
      reservationDate: `${TUE} 11:00:00`,
      typeReservation: "1",
      employee: { id: 1, name: "Ana", surnames: "" },
      ownerName: "X",
      ownerSurnames: "Y",
    };
    const results = await Promise.allSettled([cal.createBooking(req), cal.createBooking(req)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(fake.events(ANA_CAL)).toHaveLength(1);
  });

  it("ida y vuelta (modo ai): crear, buscar por teléfono, justificante, anular y reintento idempotente", async () => {
    const { fake, cal } = setup();
    const phone = "+34611223344";
    const created = await cal.createCheckedBooking({
      customer: { name: "Marta", surnames: "Ruiz", phone },
      reservationDate: `${TUE} 12:00:00`,
      employeeId: 1,
      typeReservation: 1,
    });
    expect(created).toEqual({
      ok: true,
      code: "OK",
      message: expect.any(String),
      data: { reservationRef: "fb000000000000100", dateLabel: `${TUE} 12:00`, employeeName: "Ana" },
    });
    expect((await cal.checkSlot({ reservationDate: `${TUE} 12:00:00`, employeeId: 1, typeReservation: 1 })).data.available).toBe(false);
    expect((await cal.checkSlot({ reservationDate: `${TUE} 12:30:00`, employeeId: 1, typeReservation: 1 })).data.available).toBe(true);

    const dup = (await cal
      .createCheckedBooking({ customer: { name: "Marta", surnames: "Ruiz", phone }, reservationDate: `${TUE} 16:00:00`, employeeId: 2, typeReservation: 1 })
      .catch((e: unknown) => e)) as UpstreamError;
    expect([dup.status, dup.code]).toEqual([409, "DUPLICATE_CALLER_BOOKING"]);
    const taken = (await cal
      .createCheckedBooking({ customer: { name: "Otro", surnames: "", phone: "+34622000000" }, reservationDate: `${TUE} 12:00:00`, employeeId: 1, typeReservation: 1 })
      .catch((e: unknown) => e)) as UpstreamError;
    expect([taken.status, taken.code]).toEqual([409, "SLOT_TAKEN"]);

    const lookup = await cal.findBookingsByPhone({ phone }, phone);
    expect(lookup).toMatchObject({ ok: true, code: "OK", data: { matches: [{ reservationRef: "fb000000000000100", dateLabel: `${TUE} 12:00`, employeeName: "Ana" }] } });
    const listCall = fake.apiCalls().filter((r) => r.method === "GET" && r.path.endsWith("/events")).pop()!;
    expect(listCall.query.get("privateExtendedProperty")).toBe(`${PROP.phone}=${phone}`);
    const mismatch = (await cal.findBookingsByPhone({ phone }, "+34699999999").catch((e: unknown) => e)) as UpstreamError;
    expect(mismatch.code).toBe("CALLER_ID_MISMATCH");

    const wrong = (await cal
      .requestCancellationProof({ reservationRef: "fb000000000000100", confirm: { name: "Pedro", phone } })
      .catch((e: unknown) => e)) as UpstreamError;
    expect([wrong.status, wrong.code]).toEqual([403, "CONFIRMATION_MISMATCH"]);
    const proof = await cal.requestCancellationProof({ reservationRef: "fb000000000000100", confirm: { name: "marta", phone } });
    expect(proof).toMatchObject({ ok: true, code: "OK", data: { expiresInSeconds: 120 } });
    const scope = (await cal
      .cancelBooking({ reservationRef: "fb000000000000999", cancellationProof: proof.data.cancellationProof })
      .catch((e: unknown) => e)) as UpstreamError;
    expect(scope.code).toBe("PROOF_SCOPE_MISMATCH");

    const cancelled = await cal.cancelBooking({ reservationRef: "fb000000000000100", cancellationProof: proof.data.cancellationProof });
    expect(cancelled.data).toEqual({ cancelled: true, alreadyCancelled: false });
    expect(fake.events(ANA_CAL)[0]!.status).toBe("cancelled");
    const again = await cal.cancelBooking({ reservationRef: "fb000000000000100", cancellationProof: proof.data.cancellationProof });
    expect(again.data).toEqual({ cancelled: true, alreadyCancelled: true });
    expect(await cal.findBookingsByPhone({ phone }, phone)).toMatchObject({ ok: true, code: "NO_MATCH", data: { matches: [] } });
    expect((await cal.checkSlot({ reservationDate: `${TUE} 12:00:00`, employeeId: 1, typeReservation: 1 })).data.available).toBe(true);
  });

  it("justificante: caduca a los 120 s y como mucho 3 intentos por cita", async () => {
    let now = NOW;
    const cfg = config();
    const fake = new FakeGoogleCalendar("Europe/Madrid", [ANA_CAL, BEA_CAL]);
    const cal = createGoogleCalendar({ clientConfig: cfg, serviceAccount: FAKE_SA, timeoutMs: 2000, logger: silent, fetch: fake.fetch, now: () => now, newBookingId: () => 7 });
    const phone = "+34611223344";
    const { data } = await cal.createCheckedBooking({ customer: { name: "Marta", surnames: "", phone }, reservationDate: `${TUE} 09:00:00`, employeeId: 1, typeReservation: 1 });
    const ref = data.reservationRef;
    const proof = await cal.requestCancellationProof({ reservationRef: ref, confirm: { name: "Marta", phone } });
    now += 121_000;
    const expired = (await cal.cancelBooking({ reservationRef: ref, cancellationProof: proof.data.cancellationProof }).catch((e: unknown) => e)) as UpstreamError;
    expect([expired.status, expired.code]).toEqual([403, "PROOF_EXPIRED"]);
    await cal.requestCancellationProof({ reservationRef: ref, confirm: { name: "Marta", phone } });
    await cal.requestCancellationProof({ reservationRef: ref, confirm: { name: "Marta", phone } }).catch(() => undefined);
    const limited = (await cal.requestCancellationProof({ reservationRef: ref, confirm: { name: "Marta", phone } }).catch((e: unknown) => e)) as UpstreamError;
    expect([limited.status, limited.code]).toEqual([429, "TOO_MANY_ATTEMPTS"]);
    const bogus = (await cal.cancelBooking({ reservationRef: ref, cancellationProof: "inventado" }).catch((e: unknown) => e)) as UpstreamError;
    expect(bogus.code).toBe("PROOF_INVALID");
  });

  it("checkAvailability: huecos HH:mm por empleado, recortados a maxSlots", async () => {
    const { cal } = setup();
    const res = await cal.checkAvailability({ date: TUE, typeReservation: 1, maxSlots: 2 });
    expect(res).toEqual({
      ok: true,
      code: "OK",
      message: expect.any(String),
      data: {
        employees: [
          { employeeId: 1, name: "Ana", slots: ["09:00", "09:30"] },
          { employeeId: 2, name: "Bea Dos", slots: ["09:00", "09:30"] },
        ],
      },
    });
    const bad = (await cal.checkAvailability({ date: "03/11/2026", typeReservation: 1 }).catch((e: unknown) => e)) as UpstreamError;
    expect([bad.status, bad.code]).toEqual([400, "INVALID_DATE"]);
  });

  it("mover = parche del mismo evento, comprobando el hueco nuevo sin contar la propia cita", async () => {
    const { fake, cal } = setup();
    const { id } = await cal.createBooking({ reservationDate: `${TUE} 09:00:00`, typeReservation: "2", employee: { id: 1, name: "Ana", surnames: "" }, ownerName: "A", ownerSurnames: "B" });
    expect(await cal.moveBooking(id!, `${TUE} 09:30:00`)).toBe("moved");
    expect(fake.events(ANA_CAL)[0]!.start).toEqual({ dateTime: `${TUE}T09:30:00`, timeZone: "Europe/Madrid" });
    fake.addBusy(ANA_CAL, TUE, "12:00", "12:30");
    await expect(cal.moveBooking(id!, `${TUE} 11:30:00`)).rejects.toMatchObject({ status: 409 });
    expect(await cal.moveBooking(999, `${TUE} 11:00:00`)).toBe("not_found");
  });
});

describe("google-calendar · back office y calendario único", () => {
  it("listBookings solo lista citas de Flowara; cancelBookingById borra y luego no encuentra", async () => {
    const { fake, cal, cfg } = setup();
    await cal.createBooking({ reservationDate: `${TUE} 16:00:00`, typeReservation: "1", employee: { id: 2, name: "Bea", surnames: "Dos" }, ownerName: "Ana", ownerSurnames: "López", ownerPhone: "+34600000001" });
    await cal.createBooking({ reservationDate: `${TUE} 09:00:00`, typeReservation: "1", employee: { id: 1, name: "Ana", surnames: "" }, ownerName: "Eva", ownerSurnames: "", ownerPhone: "+34600000002" });
    fake.addBusy(ANA_CAL, TUE, "12:00", "12:30", { summary: "Cita a mano" });
    fake.pageSize = 1; // fuerza paginación
    const office = createGoogleCalendarBackOffice({ clientConfig: cfg, serviceAccount: FAKE_SA, timeoutMs: 2000, logger: silent, fetch: fake.fetch, now: () => NOW });
    const list = await office.listBookings({ fromDate: TUE, toDate: TUE });
    expect(list.stats).toEqual({ total: 2, unparseable: 0 });
    expect(list.rows).toEqual([
      { id: 101, startsAt: `${TUE} 09:00`, ownerPhoneE164: "+34600000002", ownerName: "Eva", ownerSurnames: "", employeeId: 1, employeeName: "Ana", typeReservation: 1, state: "active" },
      { id: 100, startsAt: `${TUE} 16:00`, ownerPhoneE164: "+34600000001", ownerName: "Ana", ownerSurnames: "López", employeeId: 2, employeeName: "Bea Dos", typeReservation: 1, state: "active" },
    ]);
    expect(await office.cancelBookingById(100)).toBe("deleted");
    expect(await office.cancelBookingById(100)).toBe("not_found");
    expect(await office.cancelBookingById(5)).toBe("not_found");
    expect((await office.listBookings({ fromDate: TUE, toDate: TUE })).rows.map((r) => r.id)).toEqual([101]);
  });

  it("calendario único: un evento sin empleado ocupa a todos; uno con flowara.employeeId solo a ese", async () => {
    const SHOP = "negocio@group.calendar.google.com";
    const cfg = config({
      empleados: [
        { nombre: "Ana", calendario: "ana", id: 7 },
        { nombre: "Bea", calendario: "bea", id: 8 },
      ],
      calendario: { provider: "google-calendar", google: { calendario_unico: SHOP, paso_min: 60 } },
    });
    const { fake, cal } = setup({ cfg, calendars: [SHOP] });
    fake.addBusy(SHOP, TUE, "09:00", "10:00", { summary: "Reunión" });
    fake.addBusy(SHOP, TUE, "10:00", "11:00", { extendedProperties: { private: { [PROP.employeeId]: "7" } } });
    const free = await cal.listFreeSlots({ date: TUE, resourceIds: [7, 8], serviceId: "1" });
    expect(starts(free, 7)!.slice(0, 2)).toEqual(["11:00", "12:00"]);
    expect(starts(free, 8)!.slice(0, 2)).toEqual(["10:00", "11:00"]);
    expect(fake.apiCalls().some((r) => r.path === "/freeBusy")).toBe(false);
    await cal.createBooking({ reservationDate: `${TUE} 10:00:00`, typeReservation: "1", employee: { id: 8, name: "Bea", surnames: "" }, ownerName: "C", ownerSurnames: "D" });
    expect(fake.events(SHOP).pop()!.extendedProperties!.private![PROP.employeeId]).toBe("8");
  });
});

describe("google-calendar · sesión y credencial", () => {
  it("firma el JWT de la cuenta de servicio (RS256) con ámbitos mínimos y reutiliza el token", async () => {
    const { fake, cal } = setup();
    await cal.ensureSession();
    await cal.listResourcesForDay(TUE);
    expect(fake.tokenRequests).toBe(1);
    expect(fake.lastJwtClaims).toMatchObject({
      iss: FAKE_SA.client_email,
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
    });
    fake.expireTokens();
    const err = (await cal.listResourcesForDay(TUE).catch((e: unknown) => e)) as UpstreamError;
    expect(err.status).toBe(401);
    await cal.listResourcesForDay(TUE); // el 401 descartó el token: pide otro
    expect(fake.tokenRequests).toBe(2);
  });

  it("credencial: base64 o ruta; errores sin contenido de la clave", () => {
    expect(loadServiceAccount({ jsonB64: FAKE_SA_B64 }).client_email).toBe(FAKE_SA.client_email);
    const dir = mkdtempSync(join(tmpdir(), "gsa-"));
    try {
      writeFileSync(join(dir, "sa.json"), JSON.stringify(FAKE_SA));
      expect(loadServiceAccount({ jsonPath: join(dir, "sa.json") }).token_uri).toBe(FAKE_SA.token_uri);
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ client_email: "x" }));
      expect(() => loadServiceAccount({ jsonPath: join(dir, "bad.json") })).toThrow(/faltan client_email o private_key/);
      expect(() => loadServiceAccount({ jsonPath: join(dir, "no.json") })).toThrow(/no se puede leer/);
      expect(() => loadServiceAccount({})).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("google-calendar · selección y configuración", () => {
  const KEYS = [
    "CALENDAR_PROVIDER",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_SERVICE_ACCOUNT_JSON_B64",
    "BOOKING_USERNAME",
    "BOOKING_PASSWORD",
    "BOOKING_DEFAULT_EMPLOYEE_ID",
    "CLIENT_ID",
    "CLIENT_CONFIG_PATH",
    "AI_WEBHOOK_SECRET",
  ];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.AI_WEBHOOK_SECRET = "x".repeat(32);
    dir = mkdtempSync(join(tmpdir(), "gcfg-"));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
    resetEnvCache();
    resetClientConfigForTests();
  });

  it("empleado por defecto por id de calendario -> id numérico del recurso; Demo Salon sigue en 1", () => {
    expect(defaultEmployeeResourceId(config())).toBe(1);
    expect(defaultEmployeeResourceId(config({ calendario: { provider: "google-calendar", empleado_por_defecto: BEA_CAL } }))).toBe(2);
    resetClientConfigForTests();
    delete process.env.CLIENT_CONFIG_PATH;
    delete process.env.CLIENT_ID;
    delete process.env.BOOKING_DEFAULT_EMPLOYEE_ID;
    process.env.BOOKING_USERNAME = "u";
    process.env.BOOKING_PASSWORD = "p";
    delete process.env.CALENDAR_PROVIDER;
    resetEnvCache();
    const env = loadEnv();
    expect([env.CALENDAR_PROVIDER, env.BOOKING_DEFAULT_EMPLOYEE_ID]).toEqual(["memory", 1]);
  });

  it("CALENDAR_PROVIDER=google-calendar: exige una credencial, no exige BOOKING_*, y selecciona el adaptador", () => {
    const path = join(dir, "cliente.yaml");
    writeFileSync(
      path,
      [
        'nombre: "Clínica Ejemplo"',
        'sector: "clínica"',
        "idioma: es-ES",
        "zona_horaria: America/Mexico_City",
        'telefono: { mostrar: "55 0000 0000", e164: "+525500000000" }',
        'horario: { lunes: ["09:00-14:00"] }',
        "duracion_cita_min: 30",
        'servicios: [{ id: "1", nombre: "Consulta", duracion_min: 30 }]',
        'empleados: [{ nombre: Ana, calendario: "ana@group.calendar.google.com" }]',
        'calendario: { provider: google-calendar, empleado_por_defecto: "ana@group.calendar.google.com", servicio_por_defecto: "1" }',
        "",
      ].join("\n"),
    );
    process.env.CLIENT_CONFIG_PATH = path;
    process.env.CALENDAR_PROVIDER = "google-calendar";
    delete process.env.BOOKING_USERNAME;
    delete process.env.BOOKING_PASSWORD;
    delete process.env.BOOKING_DEFAULT_EMPLOYEE_ID;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
    resetClientConfigForTests();
    resetEnvCache();
    expect(() => loadEnv()).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON/);
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 = FAKE_SA_B64;
    resetEnvCache();
    const env = loadEnv();
    expect(env.BOOKING_DEFAULT_EMPLOYEE_ID).toBe(1);
    expect(createCalendarProvider(env, silent).id).toBe("google-calendar");
    expect(createCalendarBackOffice(env, { username: "", password: "" }, silent)).toBeDefined();
  });

  it("el cliente ficticio clientes/ejemplo-google es válido y da huecos en su zona (México)", async () => {
    const cfg = loadClientConfigFrom(join(process.cwd(), "clientes", "ejemplo-google", "cliente.yaml"));
    expect(defaultEmployeeResourceId(cfg)).toBe(1);
    const fake = new FakeGoogleCalendar(cfg.zona_horaria, ["ana.ejemplo@group.calendar.google.com", "luis.ejemplo@group.calendar.google.com"]);
    const cal = createGoogleCalendar({ clientConfig: cfg, serviceAccount: FAKE_SA, timeoutMs: 1000, logger: silent, fetch: fake.fetch, now: () => NOW });
    expect((await cal.listResourcesForDay(TUE)).map((r) => r.id)).toEqual([1, 2]);
    const free = await cal.listFreeSlots({ date: TUE, resourceIds: [2], serviceId: "2" });
    expect(starts(free, 2)!.at(-1)).toBe("18:00");
    expect(await cal.listResourcesForDay("2026-11-07")).toEqual([]);
  });

  it("google-calendar sin horario en cliente.yaml falla al construir", () => {
    const cfg = config();
    delete (cfg as { horario?: unknown }).horario;
    expect(() =>
      createGoogleCalendar({ clientConfig: cfg, serviceAccount: FAKE_SA, timeoutMs: 1000, logger: silent }),
    ).toThrow(/horario/);
  });
});
