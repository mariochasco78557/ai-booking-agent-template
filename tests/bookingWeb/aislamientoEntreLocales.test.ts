import { describe, expect, it } from "vitest";

import { ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { BOOKING_DEMO_TODAY } from "../../src/bookingWeb/fixtures/bookingDemoVenue.js";
import { GORKA_ID, IRATXE_ID } from "../../src/bookingWeb/fixtures/segundoLocalVenue.js";
import { TENANT_DEMO_DOS, TENANT_BOOKING_DEMO } from "../../src/bookingWeb/tenants.js";
import { availability, book, dashboard, freshApp, getJson, labelsOf, type Json } from "./helpers.js";

/**
 * EL AISLAMIENTO ENTRE LOCALES.
 *
 * Los dos locales de la demostración no comparten ni personas, ni horario, ni
 * precios, ni contadores de identificadores. Estas pruebas comprueban que
 * tampoco comparten NADA de lo que se escribe en tiempo de ejecución: una
 * reserva de uno no aparece jamás en el panel del otro, el pago de uno no suma
 * en los totales del otro y reiniciar uno deja el otro intacto.
 */

const MARTES = BOOKING_DEMO_TODAY;
const CORTE = 1;

describe("Demostración web · dos locales, dos mundos", () => {
  it("cada local declara su propio nombre, su propio catálogo y su propia gente", async () => {
    const app = freshApp();
    const uno = await getJson(app, `/api/${TENANT_BOOKING_DEMO}/bootstrap`);
    const dos = await getJson(app, `/api/${TENANT_DEMO_DOS}/bootstrap`);

    expect(uno.displayName).toBe("Demo Salon (demo)");
    expect(dos.displayName).toBe("Peluquería Aralar (demo)");

    const preciosDe = (b: Json): number[] =>
      (b.services as { priceCents: number }[]).map((s) => s.priceCents);
    expect(preciosDe(uno)).toEqual([1200, 1800, 2800]);
    expect(preciosDe(dos)).toEqual([1000, 1500, 2400]);

    const genteDe = (b: Json): number[] =>
      (b.employees as { employeeId: number }[]).map((e) => e.employeeId);
    expect(genteDe(uno)).toEqual([3, 6, 9]);
    expect(genteDe(dos)).toEqual([IRATXE_ID, GORKA_ID]);

    // El aviso de entorno de demostración está en los dos, palabra por palabra.
    expect(uno.notice).toBe("Entorno de demostración · Datos ficticios");
    expect(dos.notice).toBe("Entorno de demostración · Datos ficticios");
  });

  it("los horarios son distintos: el lunes abre uno y cierra el otro; el sábado, al revés", async () => {
    const app = freshApp();
    const lunes = "2026-08-31";
    const sabado = "2026-08-29";

    expect(labelsOf((await availability(app, TENANT_BOOKING_DEMO, CORTE, lunes)).starts)).toEqual([]);
    expect(labelsOf((await availability(app, TENANT_DEMO_DOS, CORTE, lunes)).starts).length).toBeGreaterThan(0);

    expect(labelsOf((await availability(app, TENANT_BOOKING_DEMO, CORTE, sabado)).starts).length).toBeGreaterThan(0);
    expect(labelsOf((await availability(app, TENANT_DEMO_DOS, CORTE, sabado)).starts)).toEqual([]);
  });

  it("el segundo local tiene su propio cierre de mediodía, de 13:30 a 14:30", async () => {
    const app = freshApp();
    const inicios = labelsOf((await availability(app, TENANT_DEMO_DOS, CORTE, MARTES, IRATXE_ID)).starts);
    expect(inicios).toEqual([
      "10:00",
      "10:30",
      "11:00",
      "11:30",
      "12:00",
      "12:30",
      "13:00",
      "14:30",
      "15:00",
      "15:30",
      "16:00",
      "16:30",
      "17:00",
      "17:30",
    ]);
  });

  it("una persona de un local no existe en el otro", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/${TENANT_DEMO_DOS}/availability?serviceId=1&date=${MARTES}&employeeId=${String(ALEX_ID)}`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as Json).code).toBe("UNKNOWN_EMPLOYEE");
  });
});

describe("Demostración web · las reservas de un local no cruzan al otro", () => {
  it("reservar en uno no aparece nunca en el panel del otro", async () => {
    const app = freshApp();

    const uno = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: 9 * 60,
      payment_option: "pay_now_demo",
      idempotencyKey: "aislamiento-local-uno-1",
    });
    expect(uno.statusCode).toBe(201);

    expect((await dashboard(app, TENANT_DEMO_DOS)).bookings).toEqual([]);
    expect((await dashboard(app, TENANT_DEMO_DOS)).totals).toEqual({
      count: 0,
      amount_total_cents: 0,
      amount_paid_cents: 0,
      amount_due_cents: 0,
      // Los mismos importes YA FORMATEADOS, para que el panel no vuelva a
      // componerlos por su cuenta (ver `mismaDuracionEnTodaLaPagina`).
      labels: { amountTotal: "0,00 €", amountPaid: "0,00 €", amountDue: "0,00 €" },
    });

    const dos = await book(app, TENANT_DEMO_DOS, {
      serviceId: CORTE,
      employeeId: IRATXE_ID,
      date: MARTES,
      startMinutes: 10 * 60,
      payment_option: "pay_at_salon",
      idempotencyKey: "aislamiento-local-dos-1",
    });
    expect(dos.statusCode).toBe(201);

    const panelUno = await dashboard(app, TENANT_BOOKING_DEMO);
    const panelDos = await dashboard(app, TENANT_DEMO_DOS);

    expect((panelUno.bookings as Json[]).length).toBe(1);
    expect((panelDos.bookings as Json[]).length).toBe(1);
    expect((panelUno.bookings as Json[])[0]?.tenantId).toBe(TENANT_BOOKING_DEMO);
    expect((panelDos.bookings as Json[])[0]?.tenantId).toBe(TENANT_DEMO_DOS);

    // Los pagos tampoco se mezclan: cada uno con el precio de SU catálogo.
    expect(panelUno.totals).toEqual({
      count: 1,
      amount_total_cents: 1800,
      amount_paid_cents: 1800,
      amount_due_cents: 0,
      labels: { amountTotal: "18,00 €", amountPaid: "18,00 €", amountDue: "0,00 €" },
    });
    expect(panelDos.totals).toEqual({
      count: 1,
      amount_total_cents: 1500,
      amount_paid_cents: 0,
      amount_due_cents: 1500,
      labels: { amountTotal: "15,00 €", amountPaid: "0,00 €", amountDue: "15,00 €" },
    });
  });

  it("ocupar un hueco en un local no ocupa nada en el otro", async () => {
    const app = freshApp();
    await book(app, TENANT_DEMO_DOS, {
      serviceId: CORTE,
      employeeId: IRATXE_ID,
      date: MARTES,
      startMinutes: 10 * 60,
      payment_option: "pay_now_demo",
      idempotencyKey: "aislamiento-hueco-dos-1",
    });

    expect(labelsOf((await availability(app, TENANT_DEMO_DOS, CORTE, MARTES, IRATXE_ID)).starts)).not.toContain(
      "10:00",
    );
    expect(labelsOf((await availability(app, TENANT_BOOKING_DEMO, CORTE, MARTES, ALEX_ID)).starts)).toContain(
      "10:00",
    );
  });

  it("la misma clave de idempotencia en dos locales son dos reservas distintas", async () => {
    const app = freshApp();
    const clave = "aislamiento-misma-clave-1";

    const uno = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: 10 * 60,
      payment_option: "pay_now_demo",
      idempotencyKey: clave,
    });
    const dos = await book(app, TENANT_DEMO_DOS, {
      serviceId: CORTE,
      employeeId: IRATXE_ID,
      date: MARTES,
      startMinutes: 10 * 60,
      payment_option: "pay_now_demo",
      idempotencyKey: clave,
    });

    expect(uno.statusCode).toBe(201);
    expect(dos.statusCode).toBe(201);
    expect(uno.body.repeated).toBe(false);
    expect(dos.body.repeated).toBe(false);
    expect((uno.body.booking as Json).id).not.toBe((dos.body.booking as Json).id);
  });

  it("reiniciar un local no borra el otro", async () => {
    const app = freshApp();
    await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: 9 * 60,
      payment_option: "pay_now_demo",
      idempotencyKey: "aislamiento-reinicio-uno",
    });
    await book(app, TENANT_DEMO_DOS, {
      serviceId: CORTE,
      employeeId: IRATXE_ID,
      date: MARTES,
      startMinutes: 10 * 60,
      payment_option: "pay_at_salon",
      idempotencyKey: "aislamiento-reinicio-dos",
    });

    const res = await app.inject({ method: "POST", url: `/api/${TENANT_BOOKING_DEMO}/reset` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Json).removedBookings).toBe(1);

    expect((await dashboard(app, TENANT_BOOKING_DEMO)).bookings).toEqual([]);
    expect(((await dashboard(app, TENANT_DEMO_DOS)).bookings as Json[]).length).toBe(1);

    // Y al revés: reiniciar el segundo tampoco resucita ni borra nada del primero.
    await app.inject({ method: "POST", url: `/api/${TENANT_DEMO_DOS}/reset` });
    expect((await dashboard(app, TENANT_DEMO_DOS)).bookings).toEqual([]);
    expect((await dashboard(app, TENANT_BOOKING_DEMO)).bookings).toEqual([]);
  });

  it("un local que no existe es un 404 en todas las rutas", async () => {
    const app = freshApp();
    const rutas: [string, string][] = [
      ["GET", "/api/local-inventado/bootstrap"],
      ["GET", `/api/local-inventado/availability?serviceId=1&date=${MARTES}`],
      ["GET", "/api/local-inventado/dashboard"],
      ["POST", "/api/local-inventado/reset"],
    ];
    for (const [method, url] of rutas) {
      const res = await app.inject({ method: method as "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect((res.json() as Json).code, url).toBe("UNKNOWN_TENANT");
    }
  });
});
