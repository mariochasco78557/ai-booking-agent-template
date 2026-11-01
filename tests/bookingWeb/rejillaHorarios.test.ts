import { describe, expect, it } from "vitest";

import { ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { BOOKING_DEMO_TODAY } from "../../src/bookingWeb/fixtures/bookingDemoVenue.js";
import { TENANT_BOOKING_DEMO } from "../../src/bookingWeb/tenants.js";
import { availability, freshApp, labelsOf, startsFor } from "./helpers.js";

/**
 * LA REJILLA, COMPARADA ENTERA.
 *
 * Ninguna de estas afirmaciones muestrea: se compara la LISTA COMPLETA de
 * inicios, en orden, contra la lista escrita a mano aquí. Una hora de más, una
 * de menos o una desordenada rompe la prueba, que es justo lo que se quiere de
 * la pieza que decide qué se le ofrece a un cliente.
 *
 * Ninguna de estas horas está escrita en el código de producción: todas salen
 * de `freeStartsForDuration`, del motor de calendario, aplicado al horario del
 * fixture (martes a viernes 09:00–19:00 con cierre de 14:00 a 16:00; sábado
 * 09:00–14:00; lunes y domingo cerrados).
 */

/** Martes 2026-08-25, el «hoy» sintético. */
const MARTES = BOOKING_DEMO_TODAY;
const MIERCOLES = "2026-08-26";
const JUEVES = "2026-08-27";
const VIERNES = "2026-08-28";
const SABADO = "2026-08-29";
const DOMINGO = "2026-08-30";
const LUNES = "2026-08-31";

/** Servicio 1 «Corte de pelo», 30 minutos en el catálogo del local principal. */
const SERVICIO_30 = 1;
/** Servicio 2 «Corte y barba», 60 minutos en el catálogo del local principal. */
const SERVICIO_60 = 2;
/** Servicio 0 «Barba», 30 minutos. Nerea NO lo hace. */
const SERVICIO_BARBA = 0;

const MANANA_30 = [
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "13:00",
  "13:30",
];
const TARDE_30 = ["16:00", "16:30", "17:00", "17:30", "18:00", "18:30"];
const DIA_COMPLETO_30 = [...MANANA_30, ...TARDE_30];

describe("Disponibilidad de la demostración web · la rejilla de un día laborable", () => {
  it("un martes ofrece EXACTAMENTE las dieciséis horas del día, en orden", async () => {
    const app = freshApp();
    expect(await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_30, MARTES, ALEX_ID)).toEqual(
      DIA_COMPLETO_30,
    );
  });

  it("miércoles, jueves y viernes ofrecen la misma lista exacta que el martes", async () => {
    const app = freshApp();
    for (const dia of [MIERCOLES, JUEVES, VIERNES]) {
      expect(await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_30, dia, ALEX_ID), dia).toEqual(
        DIA_COMPLETO_30,
      );
    }
  });

  it("el descanso de 14:00 a 16:00 no genera jamás un inicio", async () => {
    const app = freshApp();
    for (const dia of [MARTES, MIERCOLES, JUEVES, VIERNES]) {
      const inicios = await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_30, dia, ALEX_ID);
      // Ni el propio 14:00, ni nada entre 14:00 y 16:00, para ninguna duración.
      expect(inicios.filter((h) => h >= "14:00" && h < "16:00"), dia).toEqual([]);
      const inicios60 = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_60, dia, ALEX_ID);
      expect(labelsOf(inicios60.starts).filter((h) => h >= "14:00" && h < "16:00"), dia).toEqual([]);
    }
  });

  it("ningún inicio llega a las 19:00 ni las pasa", async () => {
    const app = freshApp();
    for (const dia of [MARTES, MIERCOLES, JUEVES, VIERNES]) {
      const inicios = await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_30, dia, ALEX_ID);
      expect(inicios.every((h) => h < "19:00"), dia).toBe(true);
      expect(inicios[inicios.length - 1]).toBe("18:30");
    }
  });

  it("el sábado no ofrece tarde: cierra a las 14:00 y ahí se acaba el día", async () => {
    const app = freshApp();
    const inicios = await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_30, SABADO, ALEX_ID);
    expect(inicios).toEqual(MANANA_30);
    expect(inicios.every((h) => h < "14:00")).toBe(true);
  });

  it("lunes y domingo están cerrados: la rejilla viene vacía para todo el mundo", async () => {
    const app = freshApp();
    for (const dia of [LUNES, DOMINGO]) {
      const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, dia);
      expect(labelsOf(body.starts), dia).toEqual([]);
      for (const fila of body.byEmployee as { starts: unknown[] }[]) {
        expect(fila.starts, dia).toEqual([]);
      }
    }
  });
});

describe("Disponibilidad de la demostración web · la duración manda", () => {
  it("con 60 minutos, el último inicio de la mañana es 13:00 y el de la tarde 18:00", async () => {
    const app = freshApp();
    const inicios = await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_60, MARTES, ALEX_ID);

    expect(inicios).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
      "12:00",
      "12:30",
      "13:00",
      "16:00",
      "16:30",
      "17:00",
      "17:30",
      "18:00",
    ]);

    const manana = inicios.filter((h) => h < "14:00");
    const tarde = inicios.filter((h) => h >= "16:00");
    expect(manana[manana.length - 1]).toBe("13:00");
    expect(tarde[tarde.length - 1]).toBe("18:00");
  });

  it("los dos últimos inicios del servicio de 30 caen media hora más tarde que los del de 60", async () => {
    const app = freshApp();
    const treinta = await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_30, MARTES, ALEX_ID);
    const sesenta = await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_60, MARTES, ALEX_ID);

    // La diferencia no viene de ninguna constante: viene de que un bloque de 60
    // minutos tiene que caber entero antes de las 14:00 y antes de las 19:00.
    expect(treinta.filter((h) => h < "14:00").at(-1)).toBe("13:30");
    expect(sesenta.filter((h) => h < "14:00").at(-1)).toBe("13:00");
    expect(treinta.at(-1)).toBe("18:30");
    expect(sesenta.at(-1)).toBe("18:00");
  });

  it("el sábado, un servicio de 60 minutos no puede empezar más tarde de las 13:00", async () => {
    const app = freshApp();
    const inicios = await startsFor(app, TENANT_BOOKING_DEMO, SERVICIO_60, SABADO, ALEX_ID);
    expect(inicios.at(-1)).toBe("13:00");
  });
});

describe("Disponibilidad de la demostración web · la rejilla por profesional", () => {
  it("sin employeeId devuelve una fila por persona capaz, y la unión de sus horas", async () => {
    const app = freshApp();
    const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, MARTES);
    const filas = body.byEmployee as { employeeId: number; displayName: string; starts: unknown[] }[];

    expect(filas.map((f) => f.employeeId)).toEqual([ALEX_ID, DANI_ID, NEREA_ID]);
    expect(filas.map((f) => f.displayName)).toEqual([
      "Álex (sintético)",
      "Dani (sintético)",
      "Nerea (sintética)",
    ]);
    for (const fila of filas) {
      expect(labelsOf(fila.starts), String(fila.employeeId)).toEqual(DIA_COMPLETO_30);
    }
    expect(labelsOf(body.starts)).toEqual(DIA_COMPLETO_30);
    expect(body.employeeId).toBeNull();
  });

  it("el miércoles la rejilla NO es idéntica para todo el mundo: Dani libra la mañana", async () => {
    const app = freshApp();
    const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, MIERCOLES);
    const filas = body.byEmployee as { employeeId: number; starts: unknown[] }[];
    const de = (id: number): string[] =>
      labelsOf(filas.find((f) => f.employeeId === id)?.starts ?? []);

    expect(de(ALEX_ID)).toEqual(DIA_COMPLETO_30);
    expect(de(NEREA_ID)).toEqual(DIA_COMPLETO_30);
    expect(de(DANI_ID)).toEqual(TARDE_30);
    // Y la unión sigue siendo el día entero: alguien cubre la mañana.
    expect(labelsOf(body.starts)).toEqual(DIA_COMPLETO_30);
  });

  it("Nerea no hace Barba: no aparece en la rejilla de ese servicio, y pedirla es un 409", async () => {
    const app = freshApp();
    const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_BARBA, MARTES);
    const filas = body.byEmployee as { employeeId: number }[];
    expect(filas.map((f) => f.employeeId)).toEqual([ALEX_ID, DANI_ID]);

    const res = await app.inject({
      method: "GET",
      url: `/api/${TENANT_BOOKING_DEMO}/availability?serviceId=0&date=${MARTES}&employeeId=${String(NEREA_ID)}`,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("EMPLOYEE_CANNOT_PERFORM_SERVICE");
  });
});

describe("Disponibilidad de la demostración web · los tramos de apertura del local", () => {
  /** El campo `windows` de la respuesta, comparado entero. */
  const tramos = (body: Record<string, unknown>): unknown[] => body.windows as unknown[];

  it("de martes a viernes publica los dos tramos del local: 09:00–14:00 «Mañana» y 16:00–19:00 «Tarde»", async () => {
    const app = freshApp();
    for (const dia of [MARTES, MIERCOLES, JUEVES, VIERNES]) {
      const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, dia);
      expect(tramos(body), dia).toEqual([
        { index: 0, startMinutes: 540, endMinutes: 840, label: "Mañana", rangeLabel: "09:00–14:00" },
        { index: 1, startMinutes: 960, endMinutes: 1140, label: "Tarde", rangeLabel: "16:00–19:00" },
      ]);
    }
  });

  it("el sábado, que abre de una sentada, publica un solo tramo 09:00–14:00 rotulado «Horario»", async () => {
    const app = freshApp();
    const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, SABADO);
    expect(tramos(body)).toEqual([
      { index: 0, startMinutes: 540, endMinutes: 840, label: "Horario", rangeLabel: "09:00–14:00" },
    ]);
  });

  it("lunes y domingo, cerrados, no publican ningún tramo", async () => {
    const app = freshApp();
    for (const dia of [LUNES, DOMINGO]) {
      expect(tramos(await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, dia)), dia).toEqual([]);
    }
  });

  /**
   * El tramo es del LOCAL y no de quien se filtre: Dani entra los miércoles a
   * las 16:00, y pedir SU disponibilidad sigue devolviendo los dos tramos del
   * local —no uno solo que empezara a las 16:00—, para que su columna se
   * rotule «Tarde» y no se convierta en un horario propio.
   */
  it("filtrar por una persona no encoge los tramos: los de Dani un miércoles siguen siendo los del local", async () => {
    const app = freshApp();
    const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, MIERCOLES, DANI_ID);
    expect(labelsOf(body.starts)).toEqual(TARDE_30);
    expect(tramos(body)).toEqual([
      { index: 0, startMinutes: 540, endMinutes: 840, label: "Mañana", rangeLabel: "09:00–14:00" },
      { index: 1, startMinutes: 960, endMinutes: 1140, label: "Tarde", rangeLabel: "16:00–19:00" },
    ]);
  });

  /**
   * APERTURA, NO DISPONIBILIDAD. Reservar la mañana entera de todo el mundo no
   * cierra el local a mediodía: los tramos son los mismos, y lo único que
   * cambia es que ya no hay huecos que ofrecer dentro del primero.
   */
  it("reservar huecos no mueve ni parte los tramos", async () => {
    const app = freshApp();
    const antes = tramos(await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, MARTES));

    for (const empleado of [ALEX_ID, DANI_ID, NEREA_ID]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/${TENANT_BOOKING_DEMO}/book`,
        payload: {
          serviceId: SERVICIO_30,
          employeeId: empleado,
          date: MARTES,
          startMinutes: 660, // 11:00, en mitad de la mañana
          payment_option: "pay_at_salon",
          idempotencyKey: `tramos-intactos-${String(empleado)}`,
        } as never,
      });
      expect(res.statusCode, res.body).toBe(201);
    }

    const despues = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, MARTES);
    // El hueco de las 11:00 desaparece de la oferta…
    expect(labelsOf(despues.starts)).not.toContain("11:00");
    // …y aun así la mañana sigue siendo un solo tramo 09:00–14:00.
    expect(tramos(despues)).toEqual(antes);
  });
});

describe("Disponibilidad de la demostración web · el horizonte", () => {
  it("una fecha anterior al «hoy» sintético no ofrece nada y lo dice", async () => {
    const app = freshApp();
    const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, "2026-08-18");
    expect(body.withinHorizon).toBe(false);
    expect(labelsOf(body.starts)).toEqual([]);
    // Fuera del horizonte tampoco se rotula nada: no hay día que enseñar.
    expect(body.windows).toEqual([]);
  });

  it("una fecha más allá del horizonte de 30 días tampoco", async () => {
    const app = freshApp();
    const body = await availability(app, TENANT_BOOKING_DEMO, SERVICIO_30, "2026-10-06");
    expect(body.withinHorizon).toBe(false);
    expect(labelsOf(body.starts)).toEqual([]);
    expect(body.windows).toEqual([]);
  });
});
