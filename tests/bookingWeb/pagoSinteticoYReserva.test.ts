import { describe, expect, it } from "vitest";

import { ALEX_ID, DANI_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { BOOKING_DEMO_TODAY } from "../../src/bookingWeb/fixtures/bookingDemoVenue.js";
import { BOOKING_WEB_NOTICE } from "../../src/bookingWeb/model.js";
import { TENANT_BOOKING_DEMO } from "../../src/bookingWeb/tenants.js";
import { availability, book, dashboard, freshApp, labelsOf, type Json } from "./helpers.js";

/**
 * EL PAGO SINTÉTICO Y LA RESERVA.
 *
 * Todo lo que se comprueba aquí ocurre dentro del proceso: no hay pasarela, no
 * hay proveedor externo, no sale ninguna petición de red y en ningún momento se
 * pide un dato financiero. Las dos opciones sólo mueven enteros de céntimos
 * entre «pagado» y «pendiente», y esta suite fija exactamente cuánto mueve cada
 * una.
 */

const MARTES = BOOKING_DEMO_TODAY;
const CORTE = 1; // 30 minutos, 1800 céntimos en el catálogo del local principal
const CORTE_Y_BARBA = 2; // 60 minutos, 2800 céntimos
const NUEVE = 9 * 60;

function pagoDe(body: Json): Json {
  return (body.booking as Json).payment as Json;
}

function etiquetasDe(body: Json): Json {
  return (body.booking as Json).labels as Json;
}

describe("Demostración web · las dos opciones de pago", () => {
  it("«pagar ahora» deja pendiente 0 y pagado el total, y lo dice con las palabras exactas", async () => {
    const app = freshApp();
    const { statusCode, body } = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-pago-ahora-0001",
    });

    expect(statusCode).toBe(201);
    expect(pagoDe(body)).toEqual({
      payment_option: "pay_now_demo",
      payment_status: "demo_paid",
      amount_total_cents: 1800,
      amount_paid_cents: 1800,
      amount_due_cents: 0,
    });
    expect(etiquetasDe(body).paymentStatus).toBe("Pagada (demo)");
    expect(body.messages).toEqual(["Pago simulado completado", "No se ha realizado ningún cargo real"]);
    expect(body.notice).toBe(BOOKING_WEB_NOTICE);
  });

  it("«pagar en el local» deja pagado 0 y pendiente el total", async () => {
    const app = freshApp();
    const { statusCode, body } = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE_Y_BARBA,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_at_salon",
      idempotencyKey: "demo-pago-local-0001",
    });

    expect(statusCode).toBe(201);
    expect(pagoDe(body)).toEqual({
      payment_option: "pay_at_salon",
      payment_status: "pending_at_salon",
      amount_total_cents: 2800,
      amount_paid_cents: 0,
      amount_due_cents: 2800,
    });
    expect(etiquetasDe(body).paymentStatus).toBe("Pendiente en local");
    expect(body.messages).toContain("No se ha realizado ningún cargo real");
  });

  it("los importes cuadran siempre: pagado + pendiente = total", async () => {
    const app = freshApp();
    for (const [opcion, minutos] of [
      ["pay_now_demo", NUEVE],
      ["pay_at_salon", NUEVE + 30],
    ] as const) {
      const { body } = await book(app, TENANT_BOOKING_DEMO, {
        serviceId: CORTE,
        employeeId: ALEX_ID,
        date: MARTES,
        startMinutes: minutos,
        payment_option: opcion,
        idempotencyKey: `demo-cuadre-${opcion}`,
      });
      const pago = pagoDe(body) as unknown as {
        amount_total_cents: number;
        amount_paid_cents: number;
        amount_due_cents: number;
      };
      expect(pago.amount_paid_cents + pago.amount_due_cents).toBe(pago.amount_total_cents);
    }
  });

  it("elegir es obligatorio: sin `payment_option` la confirmación es un 400 y no crea nada", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/${TENANT_BOOKING_DEMO}/book`,
      payload: {
        serviceId: CORTE,
        employeeId: ALEX_ID,
        date: MARTES,
        startMinutes: NUEVE,
        idempotencyKey: "demo-sin-opcion-0001",
      } as never,
    });
    expect(res.statusCode).toBe(400);
    expect((await dashboard(app, TENANT_BOOKING_DEMO)).bookings).toEqual([]);
  });

  it("NINGUNA opción admite un dato financiero: un campo así es un 400 y no se guarda nada", async () => {
    const app = freshApp();
    for (const extra of [
      { card_number: "4111111111111111" },
      { cardholder: "Nombre Apellido" },
      { account: "ES0000000000000000000000" },
      { payment_token: "tok_demo" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/${TENANT_BOOKING_DEMO}/book`,
        payload: {
          serviceId: CORTE,
          employeeId: ALEX_ID,
          date: MARTES,
          startMinutes: NUEVE,
          payment_option: "pay_now_demo",
          idempotencyKey: "demo-dato-financiero-1",
          ...extra,
        } as never,
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect((await dashboard(app, TENANT_BOOKING_DEMO)).bookings).toEqual([]);

    // Y la respuesta de una reserva legítima tampoco contiene una sola palabra
    // de cobro: sólo céntimos, un estado y dos etiquetas en castellano.
    const { body } = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-respuesta-limpia-1",
    });
    const texto = JSON.stringify(body).toLowerCase();
    for (const prohibido of ["card", "cvv", "cvc", "token", "iban", "swift", "bic"]) {
      expect(texto.includes(prohibido), prohibido).toBe(false);
    }
  });
});

describe("Demostración web · reservar ocupa el hueco", () => {
  it("un hueco reservado desaparece de la disponibilidad de esa persona, y sólo de la suya", async () => {
    const app = freshApp();
    const antes = await availability(app, TENANT_BOOKING_DEMO, CORTE, MARTES, ALEX_ID);
    expect(labelsOf(antes.starts)).toContain("09:00");

    const { statusCode } = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_at_salon",
      idempotencyKey: "demo-ocupa-hueco-01",
    });
    expect(statusCode).toBe(201);

    const despues = await availability(app, TENANT_BOOKING_DEMO, CORTE, MARTES, ALEX_ID);
    expect(labelsOf(despues.starts)).not.toContain("09:00");
    expect(labelsOf(despues.starts)[0]).toBe("09:30");

    const dani = await availability(app, TENANT_BOOKING_DEMO, CORTE, MARTES, DANI_ID);
    expect(labelsOf(dani.starts)).toContain("09:00");
  });

  it("una reserva de 60 minutos borra los DOS inicios de media hora que solapa", async () => {
    const app = freshApp();
    await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE_Y_BARBA,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_at_salon",
      idempotencyKey: "demo-sesenta-minutos-1",
    });
    const despues = await availability(app, TENANT_BOOKING_DEMO, CORTE, MARTES, ALEX_ID);
    expect(labelsOf(despues.starts)).not.toContain("09:00");
    expect(labelsOf(despues.starts)).not.toContain("09:30");
    expect(labelsOf(despues.starts)[0]).toBe("10:00");
  });

  it("reservar un hueco ya tomado es un 409 y NO duplica nada", async () => {
    const app = freshApp();
    await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-primera-reserva-1",
    });

    const segunda = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      // Clave DISTINTA: es una petición nueva de verdad, no una repetición.
      idempotencyKey: "demo-segunda-reserva-1",
    });
    expect(segunda.statusCode).toBe(409);
    expect(segunda.body.code).toBe("SLOT_TAKEN");

    const panel = await dashboard(app, TENANT_BOOKING_DEMO);
    expect((panel.bookings as Json[]).length).toBe(1);
  });

  it("una hora fuera de la rejilla de 30 minutos es un 400, no una cita imposible de pintar", async () => {
    const app = freshApp();
    const { statusCode, body } = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: 9 * 60 + 7,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-hora-torcida-01",
    });
    expect(statusCode).toBe(400);
    expect(body.code).toBe("START_NOT_ALIGNED");
  });

  it("reservar dentro del cierre de mediodía es imposible aunque se pida a mano", async () => {
    const app = freshApp();
    const { statusCode, body } = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: 14 * 60 + 30,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-en-el-cierre-01",
    });
    expect(statusCode).toBe(409);
    expect(body.code).toBe("SLOT_TAKEN");
  });

  it("una fecha fuera del horizonte no se puede reservar", async () => {
    const app = freshApp();
    const { statusCode, body } = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: "2026-10-06",
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-fuera-horizonte-1",
    });
    expect(statusCode).toBe(409);
    expect(body.code).toBe("OUT_OF_HORIZON");
  });
});

describe("Demostración web · idempotencia", () => {
  it("repetir la MISMA confirmación devuelve la MISMA reserva y no duplica ni reserva ni pago", async () => {
    const app = freshApp();
    const peticion = {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-idempotente-0001",
    } as const;

    const primera = await book(app, TENANT_BOOKING_DEMO, peticion);
    expect(primera.statusCode).toBe(201);
    expect(primera.body.repeated).toBe(false);

    const segunda = await book(app, TENANT_BOOKING_DEMO, peticion);
    expect(segunda.statusCode).toBe(200);
    expect(segunda.body.repeated).toBe(true);
    expect(segunda.body.booking).toEqual(primera.body.booking);
    expect(segunda.body.messages).toEqual(primera.body.messages);

    // Una tercera, por si acaso: sigue siendo la misma y única reserva.
    const tercera = await book(app, TENANT_BOOKING_DEMO, peticion);
    expect((tercera.body.booking as Json).id).toBe((primera.body.booking as Json).id);

    const panel = await dashboard(app, TENANT_BOOKING_DEMO);
    const reservas = panel.bookings as Json[];
    expect(reservas.length).toBe(1);
    expect(panel.totals).toEqual({
      count: 1,
      amount_total_cents: 1800,
      amount_paid_cents: 1800,
      amount_due_cents: 0,
      labels: { amountTotal: "18,00 €", amountPaid: "18,00 €", amountDue: "0,00 €" },
    });
  });

  it("la misma clave con una petición distinta es un choque y no ejecuta nada", async () => {
    const app = freshApp();
    await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-clave-reutilizada",
    });

    const choque = await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE + 30,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-clave-reutilizada",
    });
    expect(choque.statusCode).toBe(409);
    expect(choque.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");

    const panel = await dashboard(app, TENANT_BOOKING_DEMO);
    expect((panel.bookings as Json[]).length).toBe(1);
  });
});

describe("Demostración web · el panel y el reinicio", () => {
  it("cada reserva aparece UNA sola vez, con servicio, persona, hora, precio y estado de pago", async () => {
    const app = freshApp();
    await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-panel-uno-0001",
    });
    await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE_Y_BARBA,
      employeeId: DANI_ID,
      date: MARTES,
      startMinutes: 11 * 60,
      payment_option: "pay_at_salon",
      idempotencyKey: "demo-panel-dos-0001",
    });

    const panel = await dashboard(app, TENANT_BOOKING_DEMO);
    const reservas = panel.bookings as Json[];
    expect(reservas.length).toBe(2);
    expect(new Set(reservas.map((r) => r.id)).size).toBe(2);

    const primera = reservas[0] as Json;
    expect(primera.labels).toEqual({
      service: "Corte de pelo",
      employee: "Álex (sintético)",
      when: "2026-08-25 · 09:00–09:30",
      paymentOption: "Pagar ahora (demo)",
      paymentStatus: "Pagada (demo)",
      amountTotal: "18,00 €",
      amountPaid: "18,00 €",
      amountDue: "0,00 €",
    });

    const segunda = reservas[1] as Json;
    expect((segunda.labels as Json).service).toBe("Corte y barba");
    expect((segunda.labels as Json).employee).toBe("Dani (sintético)");
    expect((segunda.labels as Json).when).toBe("2026-08-25 · 11:00–12:00");
    expect((segunda.labels as Json).paymentStatus).toBe("Pendiente en local");
    expect((segunda.labels as Json).amountDue).toBe("28,00 €");

    expect(panel.totals).toEqual({
      count: 2,
      amount_total_cents: 4600,
      amount_paid_cents: 1800,
      amount_due_cents: 2800,
      labels: { amountTotal: "46,00 €", amountPaid: "18,00 €", amountDue: "28,00 €" },
    });
    expect(panel.notice).toBe(BOOKING_WEB_NOTICE);
  });

  it("el reinicio borra reservas y pagos, y devuelve el hueco a la disponibilidad", async () => {
    const app = freshApp();
    await book(app, TENANT_BOOKING_DEMO, {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_now_demo",
      idempotencyKey: "demo-antes-del-reinicio",
    });
    expect(labelsOf((await availability(app, TENANT_BOOKING_DEMO, CORTE, MARTES, ALEX_ID)).starts)).not.toContain(
      "09:00",
    );

    const res = await app.inject({ method: "POST", url: `/api/${TENANT_BOOKING_DEMO}/reset` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Json).removedBookings).toBe(1);

    const panel = await dashboard(app, TENANT_BOOKING_DEMO);
    expect(panel.bookings).toEqual([]);
    expect(panel.totals).toEqual({
      count: 0,
      amount_total_cents: 0,
      amount_paid_cents: 0,
      amount_due_cents: 0,
      labels: { amountTotal: "0,00 €", amountPaid: "0,00 €", amountDue: "0,00 €" },
    });
    expect(labelsOf((await availability(app, TENANT_BOOKING_DEMO, CORTE, MARTES, ALEX_ID)).starts)).toContain(
      "09:00",
    );
  });

  it("tras el reinicio, la MISMA clave de idempotencia vuelve a estar libre", async () => {
    const app = freshApp();
    const peticion = {
      serviceId: CORTE,
      employeeId: ALEX_ID,
      date: MARTES,
      startMinutes: NUEVE,
      payment_option: "pay_at_salon",
      idempotencyKey: "demo-clave-tras-reinicio",
    } as const;

    const primera = await book(app, TENANT_BOOKING_DEMO, peticion);
    await app.inject({ method: "POST", url: `/api/${TENANT_BOOKING_DEMO}/reset` });
    const segunda = await book(app, TENANT_BOOKING_DEMO, peticion);

    expect(segunda.statusCode).toBe(201);
    expect(segunda.body.repeated).toBe(false);
    // Los identificadores vuelven a empezar por 1: el reinicio es completo.
    expect((segunda.body.booking as Json).id).toBe((primera.body.booking as Json).id);
    expect((await dashboard(app, TENANT_BOOKING_DEMO)).totals).toEqual({
      count: 1,
      amount_total_cents: 1800,
      amount_paid_cents: 0,
      amount_due_cents: 1800,
      labels: { amountTotal: "18,00 €", amountPaid: "0,00 €", amountDue: "18,00 €" },
    });
  });
});
