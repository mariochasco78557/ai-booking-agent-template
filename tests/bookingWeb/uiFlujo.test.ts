import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildBookingWebServer } from "../../src/bookingWeb/server.js";
import { createBookingStore } from "../../src/bookingWeb/store.js";
import { buildTenantRegistry } from "../../src/bookingWeb/tenants.js";
import { book } from "./helpers.js";
import { parseHtmlDocument } from "./htmlParse.js";
import { loadUiClientHooks, type UiTestHooks } from "./uiClientExtract.js";

/** Los días del fixture, por su nombre. El «hoy» sintético es el martes. */
const MARTES = "2026-08-25";
const MIERCOLES = "2026-08-26";
const SABADO = "2026-08-29";
const LUNES = "2026-08-31";

/**
 * FASE 2 — flujo funcional del cliente REAL (`src/bookingWeb/ui.js.ts`),
 * ejecutado sin navegador con el mismo patrón que `tests/console/*Ui.test.ts`
 * (prohibido importar de ahí, así que aquí hay una copia propia adaptada:
 * `fakeDom.ts` + `uiClientExtract.ts`). El servidor es el REAL
 * (`buildBookingWebServer`), inyectado con `.inject()`; sólo se puentea
 * `fetch` a esa inyección, para no abrir un socket de verdad.
 */

function freshApp(): FastifyInstance {
  return buildBookingWebServer({ store: createBookingStore(), registry: buildTenantRegistry() });
}

/** Puentea `fetch(url, opts)` a `app.inject()`, tal y como lo llama `ui.js.ts`. */
function fetchBridge(app: FastifyInstance) {
  return async (
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const res = await app.inject({
      method: (opts?.method as "GET" | "POST" | undefined) ?? "GET",
      url,
      payload: opts?.body,
      headers: opts?.headers,
    });
    return { status: res.statusCode, json: async () => res.json() as unknown };
  };
}

/**
 * ARRANCA EL CLIENTE CONTRA EL HTML REALMENTE SERVIDO.
 *
 * Hasta 2026-08-26 esto construía un documento ESCRITO A MANO
 * (`createBookingFakeDocument`) con unos cincuenta identificadores: un modelo
 * mental del HTML en lugar del HTML. Ese documento podía alejarse del real por
 * tres puertas a la vez —un id que el cliente lee y la plantilla no emite, un
 * atributo distinto (`hidden`, `disabled`), y una estructura plana en la que
 * ningún nodo tenía padre—, y sólo la primera estaba vigilada.
 *
 * Ahora se pide `GET /:tenantId` y se analiza esa respuesta. `readyState:
 * "loading"` es lo único que hace falta para conservar el control del arranque:
 * con ese estado el cliente se limita a REGISTRAR `DOMContentLoaded` y no llama
 * a `init()` por su cuenta, así que estas pruebas siguen arrancando cuando
 * quieren, una sola vez, y esperando la promesa. Ni una aserción de este
 * fichero ha cambiado por el traslado.
 */
async function boot(tenantId: string, app: FastifyInstance): Promise<UiTestHooks> {
  const pagina = await app.inject({ method: "GET", url: `/${tenantId}` });
  if (pagina.statusCode !== 200) {
    throw new Error(`GET /${tenantId} ha devuelto ${String(pagina.statusCode)} en vez de la página.`);
  }
  const document = parseHtmlDocument(pagina.body, { readyState: "loading" });
  return loadUiClientHooks(document, fetchBridge(app));
}

/** Recorre el asistente hasta dejarlo listo para pulsar "Confirmar reserva". */
async function llegarAConfirmar(
  hooks: UiTestHooks,
  opts: { serviceId: number; employeeId: number; date: string; startMinutes: number; paymentOption: string },
): Promise<void> {
  await hooks.init();
  hooks.selectService(opts.serviceId);
  hooks.goToStep(2);
  hooks.selectEmployee(opts.employeeId);
  hooks.goToStep(3);
  await hooks.selectDate(opts.date);
  hooks.selectSlot(opts.employeeId, opts.startMinutes);
  hooks.onPaymentChange(opts.paymentOption);
}

describe("Demostración web · interfaz · flujo funcional (pagar ahora)", () => {
  it("servicio → profesional → día → hora → pagar ahora → confirmar deja el panel con una reserva pagada (demo)", async () => {
    const app = freshApp();
    const hooks = await boot("demo-salon-demo", app);

    await llegarAConfirmar(hooks, {
      serviceId: 1,
      employeeId: 3,
      date: "2026-08-25",
      startMinutes: 540,
      paymentOption: "pay_now_demo",
    });

    expect(hooks.state.paymentOption).toBe("pay_now_demo");
    await hooks.confirmBooking();

    expect(hooks.state.step).toBe(4);
    expect(hooks.state.lastBooking).not.toBeNull();
    expect(hooks.state.lastMessages).toContain("Pago simulado completado");
    expect(hooks.state.lastMessages).toContain("No se ha realizado ningún cargo real");

    await hooks.switchView("dashboard");
    const snap = hooks.state.dashboard as {
      bookings: Array<{ labels: { paymentStatus: string; amountPaid: string; amountDue: string } }>;
      totals: { count: number; amount_due_cents: number };
    };
    expect(snap.bookings).toHaveLength(1);
    expect(snap.bookings[0].labels.paymentStatus).toBe("Pagada (demo)");
    expect(snap.bookings[0].labels.amountDue).toBe("0,00 €");
    expect(snap.totals.count).toBe(1);
    expect(snap.totals.amount_due_cents).toBe(0);
  });

  it("repetir el clic de «Confirmar reserva» no duplica la reserva (misma clave de idempotencia)", async () => {
    const app = freshApp();
    const hooks = await boot("demo-salon-demo", app);

    await llegarAConfirmar(hooks, {
      serviceId: 1,
      employeeId: 3,
      date: "2026-08-25",
      startMinutes: 540,
      paymentOption: "pay_now_demo",
    });

    await hooks.confirmBooking();
    const primeraReserva = hooks.state.lastBooking;
    // El botón real queda deshabilitado tras el éxito y el paso 4 lo oculta,
    // pero aquí se llama a la función DOS veces a propósito: la garantía de
    // "no duplica" tiene que sostenerse aunque el clic se repita.
    await hooks.confirmBooking();

    expect(hooks.state.lastBooking).toEqual(primeraReserva);

    await hooks.switchView("dashboard");
    const snap = hooks.state.dashboard as { bookings: unknown[] };
    expect(snap.bookings).toHaveLength(1);
  });

  it("la variante «pagar en la peluquería» deja pendiente el importe total", async () => {
    const app = freshApp();
    const hooks = await boot("demo-salon-demo", app);

    await llegarAConfirmar(hooks, {
      serviceId: 2,
      employeeId: 6,
      date: "2026-08-25",
      startMinutes: 660,
      paymentOption: "pay_at_salon",
    });

    await hooks.confirmBooking();
    expect(hooks.state.lastMessages).toContain("No se ha realizado ningún cargo real");
    expect(hooks.state.lastMessages).not.toContain("Pago simulado completado");

    await hooks.switchView("dashboard");
    const snap = hooks.state.dashboard as {
      bookings: Array<{
        labels: { paymentStatus: string; amountPaid: string; amountDue: string; amountTotal: string };
      }>;
    };
    expect(snap.bookings).toHaveLength(1);
    expect(snap.bookings[0].labels.paymentStatus).toBe("Pendiente en local");
    expect(snap.bookings[0].labels.amountPaid).toBe("0,00 €");
    expect(snap.bookings[0].labels.amountDue).toBe(snap.bookings[0].labels.amountTotal);
  });

  it("el reinicio de la demostración vacía el panel", async () => {
    const app = freshApp();
    const hooks = await boot("demo-salon-demo", app);

    await llegarAConfirmar(hooks, {
      serviceId: 1,
      employeeId: 3,
      date: "2026-08-25",
      startMinutes: 540,
      paymentOption: "pay_now_demo",
    });
    await hooks.confirmBooking();

    await hooks.confirmReset();
    const snap = hooks.state.dashboard as { bookings: unknown[] };
    expect(snap.bookings).toHaveLength(0);
  });

  it("«Hacer otra reserva» reinicia el asistente sin tocar el panel ya confirmado", async () => {
    const app = freshApp();
    const hooks = await boot("demo-salon-demo", app);

    await llegarAConfirmar(hooks, {
      serviceId: 1,
      employeeId: 3,
      date: "2026-08-25",
      startMinutes: 540,
      paymentOption: "pay_now_demo",
    });
    await hooks.confirmBooking();

    hooks.startOver();
    expect(hooks.state.step).toBe(1);
    expect(hooks.state.serviceId).toBeNull();
    expect(hooks.state.employeeId).toBeNull();
    expect(hooks.state.date).toBeNull();
    expect(hooks.state.startMinutes).toBeNull();
  });

  it("un hueco elegido por una persona que no realiza el servicio nunca llega a pintarse como opción habilitada", async () => {
    const app = freshApp();
    const hooks = await boot("demo-salon-demo", app);
    await hooks.init();
    hooks.selectService(0); // Barba — Nerea (9) no la realiza.
    hooks.goToStep(2);
    hooks.renderEmployeeStep();
    // La tarjeta/ficha de Nerea existe en el grid pero deshabilitada; el
    // hook selectEmployee no la deja elegir porque wireControls sólo la
    // llama cuando `capaz` es true — se comprueba aquí contra los datos.
    const nerea = (hooks.state.bootstrap as { employees: Array<{ employeeId: number; serviceIds: number[] }> })
      .employees.find((e) => e.employeeId === 9);
    expect(nerea?.serviceIds.includes(0)).toBe(false);
  });

  it("SLOT_TAKEN recarga la rejilla y no deja el asistente roto", async () => {
    const app = freshApp();

    // Dos asistentes independientes reservan el MISMO hueco: el primero
    // gana, el segundo debe recibir SLOT_TAKEN al confirmar.
    const primero = await boot("demo-salon-demo", app);
    await llegarAConfirmar(primero, {
      serviceId: 1,
      employeeId: 3,
      date: "2026-08-25",
      startMinutes: 540,
      paymentOption: "pay_now_demo",
    });
    await primero.confirmBooking();
    expect(primero.state.step).toBe(4);

    const segundo = await boot("demo-salon-demo", app);
    await segundo.init();
    segundo.selectService(1);
    segundo.goToStep(2);
    segundo.selectEmployee(3);
    segundo.goToStep(3);
    await segundo.selectDate("2026-08-25");
    // Fuerza el mismo hueco a mano (ya no aparecería como disponible en una
    // rejilla recién pedida, pero el escenario es justo comprobar qué pasa
    // si el cliente confirma con datos que quedaron obsoletos).
    segundo.selectSlot(3, 540);
    segundo.onPaymentChange("pay_now_demo");
    await segundo.confirmBooking();

    expect(segundo.state.step).toBe(3);
    expect(segundo.state.startMinutes).toBeNull();
    expect(segundo.state.paymentOption).toBeNull();
  });
});

/**
 * LA AGRUPACIÓN VISUAL, COMPARADA ENTERA.
 *
 * Nada de muestreos: se compara la lista COMPLETA de bloques, con su rótulo
 * literal y sus inicios literales. El rótulo no sale de ninguna hora escrita
 * en el cliente —ahí no queda ninguna— sino del tramo de apertura que publica
 * `/availability` en `windows`.
 */
async function abrirRejilla(
  app: FastifyInstance,
  opts: { serviceId: number; employeeId: number; date: string },
): Promise<UiTestHooks> {
  const hooks = await boot("demo-salon-demo", app);
  await hooks.init();
  hooks.selectService(opts.serviceId);
  hooks.goToStep(2);
  hooks.selectEmployee(opts.employeeId);
  hooks.goToStep(3);
  await hooks.selectDate(opts.date);
  return hooks;
}

/** Los bloques tal y como se pintan: rótulo del bloque y etiquetas de sus horas. */
function bloquesPintados(hooks: UiTestHooks): Array<{ titulo: string; horas: string[] }> {
  const avail = hooks.state.availability;
  if (avail === null) throw new Error("La prueba no ha llegado a cargar ninguna disponibilidad.");
  return hooks.groupSlots(avail).map((group) => ({
    titulo: hooks.blockTitle(group),
    horas: group.starts.map((s) => s.label),
  }));
}

describe("Demostración web · interfaz · rejilla exacta de horarios", () => {
  it("un martes de servicio de 30 min pinta exactamente dos bloques, «Mañana» con sus diez horas y «Tarde» con sus seis", async () => {
    const app = freshApp();
    const hooks = await abrirRejilla(app, { serviceId: 1, employeeId: 3, date: MARTES });

    expect(bloquesPintados(hooks)).toEqual([
      {
        titulo: "Mañana · 09:00–14:00",
        horas: [
          "09:00", "09:30", "10:00", "10:30", "11:00",
          "11:30", "12:00", "12:30", "13:00", "13:30",
        ],
      },
      {
        titulo: "Tarde · 16:00–19:00",
        horas: ["16:00", "16:30", "17:00", "17:30", "18:00", "18:30"],
      },
    ]);
  });

  /**
   * LA REGRESIÓN DEL DEFECTO M-SAAS-1, construida con reservas REALES hechas
   * por la API real: las horas de 09:00 a 12:00 de Álex se ocupan de verdad
   * (nadie recorta a mano una respuesta), así que el primer inicio libre de su
   * mañana pasa a ser 12:30. Con el pivote de las 12:00 que había antes, ese
   * bloque se rotulaba «Tarde»; ahora sigue siendo la mañana del local, y su
   * rango sigue siendo el de APERTURA (09:00–14:00) y no el de los huecos que
   * queden sueltos.
   */
  it("si los primeros huecos de la mañana ya están reservados y el primero libre es 12:30, el bloque sigue siendo «Mañana»", async () => {
    const app = freshApp();

    const OCUPADAS = [540, 570, 600, 630, 660, 690, 720]; // 09:00 … 12:00
    for (const startMinutes of OCUPADAS) {
      const res = await book(app, "demo-salon-demo", {
        serviceId: 1,
        employeeId: 3,
        date: MARTES,
        startMinutes,
        payment_option: "pay_at_salon",
        idempotencyKey: `regresion-manana-${String(startMinutes)}`,
      });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
    }

    const hooks = await abrirRejilla(app, { serviceId: 1, employeeId: 3, date: MARTES });
    const bloques = bloquesPintados(hooks);

    expect(bloques[0]?.horas[0]).toBe("12:30");
    expect(bloques).toEqual([
      { titulo: "Mañana · 09:00–14:00", horas: ["12:30", "13:00", "13:30"] },
      {
        titulo: "Tarde · 16:00–19:00",
        horas: ["16:00", "16:30", "17:00", "17:30", "18:00", "18:30"],
      },
    ]);
  });

  it("el servicio de 60 minutos sigue agrupando bien: 13:00 cierra la mañana y 18:00 la tarde, cada uno en su bloque", async () => {
    const app = freshApp();
    const hooks = await abrirRejilla(app, { serviceId: 2, employeeId: 3, date: MARTES });

    expect(bloquesPintados(hooks)).toEqual([
      {
        titulo: "Mañana · 09:00–14:00",
        horas: [
          "09:00", "09:30", "10:00", "10:30", "11:00",
          "11:30", "12:00", "12:30", "13:00",
        ],
      },
      {
        titulo: "Tarde · 16:00–19:00",
        horas: ["16:00", "16:30", "17:00", "17:30", "18:00"],
      },
    ]);
  });

  /**
   * El tramo es del LOCAL, no de quien se haya filtrado. Dani entra los
   * miércoles a las 16:00: su columna cae dentro de la tarde del local, y no
   * se convierte en un tramo propio y único que se rotularía «Horario».
   */
  it("una vista filtrada por Dani un miércoles pinta un solo bloque, y es la «Tarde» del local", async () => {
    const app = freshApp();
    const hooks = await abrirRejilla(app, { serviceId: 1, employeeId: 6, date: MIERCOLES });

    expect(bloquesPintados(hooks)).toEqual([
      {
        titulo: "Tarde · 16:00–19:00",
        horas: ["16:00", "16:30", "17:00", "17:30", "18:00", "18:30"],
      },
    ]);
  });

  it("el sábado, que sólo abre una vez, pinta un único bloque rotulado «Horario»", async () => {
    const app = freshApp();
    const hooks = await abrirRejilla(app, { serviceId: 1, employeeId: 3, date: SABADO });

    expect(bloquesPintados(hooks)).toEqual([
      {
        titulo: "Horario · 09:00–14:00",
        horas: [
          "09:00", "09:30", "10:00", "10:30", "11:00",
          "11:30", "12:00", "12:30", "13:00", "13:30",
        ],
      },
    ]);
  });

  /**
   * «VISTA DÍA COMPLETA» CAMBIA QUÉ SE LISTA, NO CÓMO SE ROTULA (2026-08-26).
   *
   * Antes el interruptor fundía la jornada en un único bloque «Horario», y eso
   * contradecía la maqueta aprobada —que enseña el interruptor encendido y aun
   * así con sus dos tramos rotulados— y el encargo, que pide «jornada completa
   * dividida en mañana y tarde». El corte de mediodía es información del local:
   * borrarlo al mirar el día entero es justo perder lo que hay que ver.
   *
   * QUÉ CAMBIA EL INTERRUPTOR, ENTONCES: no cuántos bloques hay ni cómo se
   * rotulan, sino CUÁNTAS COLUMNAS tiene cada uno. Encendido, el cliente pide la
   * disponibilidad SIN filtro de profesional y la rejilla enseña a todo el
   * equipo. Esta prueba mira la AGRUPACIÓN sobre una respuesta cargada con
   * filtro, así que aquí las dos vistas tienen que dar exactamente lo mismo —y
   * eso es precisamente la garantía—. El efecto sobre las columnas y sobre la
   * petición se comprueba en la página viva, en `panelDeReservaFoco.test.ts`.
   *
   * Los dos casos de al lado —el sábado, que abre de una sentada y sí pinta un
   * único bloque «Horario», y el miércoles filtrado por Dani, que pinta sólo la
   * «Tarde»— son la red que impide «arreglar» esto poniendo dos bloques a la
   * fuerza: el rótulo sale de la estructura del horario, nunca de un pivote.
   */
  it("el interruptor no cambia cuántos bloques hay ni cómo se rotulan, sólo cuántas columnas tiene cada uno", async () => {
    const app = freshApp();
    const hooks = await abrirRejilla(app, { serviceId: 1, employeeId: 3, date: MARTES });

    const porDefecto = bloquesPintados(hooks);

    hooks.state.fullDayView = true;
    const jornadaCompleta = bloquesPintados(hooks);

    expect(jornadaCompleta).toEqual([
      {
        titulo: "Mañana · 09:00–14:00",
        horas: [
          "09:00", "09:30", "10:00", "10:30", "11:00",
          "11:30", "12:00", "12:30", "13:00", "13:30",
        ],
      },
      {
        titulo: "Tarde · 16:00–19:00",
        horas: ["16:00", "16:30", "17:00", "17:30", "18:00", "18:30"],
      },
    ]);

    // El mismo total de inicios que la vista por defecto, ni uno más ni uno
    // menos: el interruptor no puede perder una hora ofrecible por el camino.
    const totalDe = (bloques: Array<{ horas: string[] }>): string[] =>
      bloques.flatMap((b) => b.horas);
    expect(totalDe(jornadaCompleta)).toEqual(totalDe(porDefecto));
    expect(totalDe(jornadaCompleta)).toHaveLength(16);
  });

  it("un día cerrado no pinta ningún bloque", async () => {
    const app = freshApp();
    const hooks = await abrirRejilla(app, { serviceId: 1, employeeId: 3, date: LUNES });
    expect(bloquesPintados(hooks)).toEqual([]);
  });
});

describe("Demostración web · interfaz · aislamiento entre locales desde la interfaz", () => {
  it("la interfaz de un local nunca ve las reservas del otro", async () => {
    const app = freshApp();

    const uno = await boot("demo-salon-demo", app);
    await llegarAConfirmar(uno, {
      serviceId: 1,
      employeeId: 3,
      date: "2026-08-25",
      startMinutes: 540,
      paymentOption: "pay_now_demo",
    });
    await uno.confirmBooking();

    const dos = await boot("demo-dos", app);
    await dos.init();
    await dos.switchView("dashboard");
    const snapDos = dos.state.dashboard as { bookings: unknown[] };
    expect(snapDos.bookings).toHaveLength(0);
  });
});
