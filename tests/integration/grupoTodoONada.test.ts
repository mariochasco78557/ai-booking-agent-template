import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { IDEMPOTENCY_KEY_PATTERN } from "../../src/console/idempotency.js";
import {
  ALEX,
  DANI,
  type Json,
  type LineaDeGrupo,
  cancelar,
  citasDe,
  crearGrupo,
  ejecutarEscenario,
  freshApp,
  gruposDe,
  historialDeOperaciones,
  huellaDelMundo,
  proponerGrupo,
  reset,
  totalDeOperaciones,
} from "./harness.js";

/**
 * step 18 · fase H — TODO O NADA, de punta a punta, por el camino REAL del
 * operador: pedir propuestas, tomar de la propuesta las líneas ya resueltas Y
 * la clave de idempotencia que el servidor acuñó (`intentKeyToMint`, decisión
 * N3 del §4.6.1), y confirmar con ellas.
 *
 * Lo que estas pruebas añaden sobre `tests/console/groupApi.test.ts` —que
 * ejercita cada ruta por separado con claves escritas a mano— es el CICLO
 * COMPLETO propuesta→confirmación y las tres formas de repetirlo (doble clic,
 * clave reutilizada con otro cuerpo, reintento tras un 500). Cierra la parte
 * de integración de los criterios 8.19–8.22 y 8.42.
 */

/** Las cuatro longitudes que un rechazo no puede mover, por separado para que el fallo diga cuál se movió. */
async function contadores(app: FastifyInstance) {
  const { agenda, almacen } = await citasDe(app);
  return {
    citasAgenda: agenda.length,
    citasAlmacen: almacen.length,
    eventosOperaciones: await totalDeOperaciones(app),
    grupos: (await gruposDe(app)).length,
  };
}

/** Convierte una propuesta ya resuelta en el cuerpo exacto que pide `POST /api/booking/groups`. */
function lineasDe(propuesta: Json): LineaDeGrupo[] {
  return (propuesta.lines as Json[]).map((l) => ({
    memberLabel: String(l.memberLabel),
    serviceId: l.serviceId as 0 | 1 | 2,
    employeeId: Number(l.employeeId),
    startMinutes: Number(l.startMinutes),
  }));
}

const PETICION_ADULTO_Y_MENOR = [
  { memberLabel: "Adulto A", serviceId: 1 as const, professional: { kind: "specific", employeeId: ALEX } },
  { memberLabel: "Menor B", serviceId: 0 as const, professional: { kind: "specific", employeeId: DANI } },
];

describe("step 18 · integración §4.7 — el ciclo propuesta→confirmación escribe las N citas o ninguna", () => {
  it("confirmar una propuesta con SU propia clave crea las dos citas, en las dos copias, cada una con su referencia de grupo", async () => {
    const app = freshApp();
    await reset(app);

    const propuestas = ((await proponerGrupo(app, "consecutive", PETICION_ADULTO_Y_MENOR)).json() as Json)
      .proposals as Json[];
    expect(propuestas.length).toBeGreaterThan(0);
    const elegida = propuestas[0] as Json;
    const clave = String(elegida.intentKeyToMint);
    // La clave que acuña el servidor tiene que valer como cabecera: si no, el
    // camino real del cliente se rompería en el primer intento.
    expect(IDEMPOTENCY_KEY_PATTERN.test(clave)).toBe(true);

    const antes = await contadores(app);
    const creada = await crearGrupo(app, lineasDe(elegida), clave);
    expect(creada.statusCode).toBe(201);
    expect(creada.headers["idempotency-status"]).toBe("original");

    const cuerpo = creada.json() as Json;
    expect(cuerpo.created).toBe(true);
    const citasCreadas = cuerpo.reservations as Json[];
    expect(citasCreadas.map((r) => r.id)).toEqual(["res-g-grp-0001-1", "res-g-grp-0001-2"]);
    expect((cuerpo.auditEventIds as string[]).length).toBe(3); // 1 de grupo + 1 por línea

    // La Agenda las trae UNA A UNA (§4.9), cada una con la referencia
    // sintética compartida — nunca una fila "de grupo" que no existe.
    const { agenda, almacen } = await citasDe(app);
    for (const cita of citasCreadas) {
      const fila = agenda.find((r) => r.id === cita.id);
      expect(fila, `la agenda no trae ${String(cita.id)}`).toBeDefined();
      const grupo = (fila as Json).group as Json;
      expect(grupo.groupId).toBe("grp-0001");
      expect(String(grupo.groupLabel)).toContain("grupo 1");
      expect(almacen.find((r) => r.id === cita.id), `el almacén no trae ${String(cita.id)}`).toBeDefined();
    }

    const despues = await contadores(app);
    expect(despues.citasAgenda).toBe(antes.citasAgenda + 2);
    expect(despues.citasAlmacen).toBe(antes.citasAlmacen + 2);
    expect(despues.eventosOperaciones).toBe(antes.eventosOperaciones + 3);
    expect(despues.grupos).toBe(antes.grupos + 1);
    await app.close();
  });

  it("(criterio 8.21) una llamada del Laboratorio ocupa el hueco entre la propuesta y la confirmación: 409, cero citas y las MISMAS longitudes", async () => {
    const app = freshApp();
    await reset(app);

    const propuestas = ((await proponerGrupo(app, "consecutive", PETICION_ADULTO_Y_MENOR)).json() as Json)
      .proposals as Json[];
    // La tercera propuesta empieza a las 10:30 con Álex: es la que una llamada
    // del Laboratorio puede robar reservando esa misma hora.
    const elegida = propuestas.find((p) => Number((p.lines as Json[])[0]?.startMinutes) === 630);
    expect(elegida, "el fixture ya no ofrece la propuesta de las 10:30").toBeDefined();
    const lineas = lineasDe(elegida as Json);

    const llamada = await ejecutarEscenario(app, "A01-roba-el-hueco", {
      utterance: "quiero reservar una cita",
      day: "tuesday",
      time: "10:30",
      professionalId: ALEX,
      serviceId: 1,
      serviceConfirmed: true,
      bookingConfirmed: true,
    });
    expect(llamada.statusCode).toBe(200);
    expect((llamada.json() as Json).reasonCode).toBe("BOOKING_CONFIRMED");

    const antes = await contadores(app);
    const huellaAntes = await huellaDelMundo(app);

    const rechazada = await crearGrupo(app, lineas, String((elegida as Json).intentKeyToMint));
    expect(rechazada.statusCode).toBe(409);
    const cuerpo = rechazada.json() as Json;
    expect(cuerpo.created).toBe(false);
    expect(cuerpo.conflict).toBe("slot_no_longer_free");
    // Señala LA LÍNEA, no una frase genérica.
    expect((cuerpo.line as Json).memberLabel).toBe("Adulto A");
    expect((cuerpo.line as Json).when).toBe("10:30");

    // Ni una cita, ni un evento, ni un grupo: las longitudes son las mismas.
    expect(await contadores(app)).toEqual(antes);
    expect(await huellaDelMundo(app)).toBe(huellaAntes);
    expect((await citasDe(app)).agenda.filter((r) => String(r.id).startsWith("res-g-")).length).toBe(0);
    await app.close();
  });

  it("el rechazo no quema la intención: vuelta a proponer sobre el mundo nuevo, la confirmación sí crea", async () => {
    const app = freshApp();
    await reset(app);

    const primeras = ((await proponerGrupo(app, "consecutive", PETICION_ADULTO_Y_MENOR)).json() as Json)
      .proposals as Json[];
    const robada = primeras.find((p) => Number((p.lines as Json[])[0]?.startMinutes) === 630) as Json;
    await ejecutarEscenario(app, "A01-roba-otra-vez", {
      utterance: "quiero reservar una cita",
      day: "tuesday",
      time: "10:30",
      professionalId: ALEX,
      serviceId: 1,
      serviceConfirmed: true,
      bookingConfirmed: true,
    });
    expect((await crearGrupo(app, lineasDe(robada), String(robada.intentKeyToMint))).statusCode).toBe(409);

    // El operador vuelve a pedir propuestas: ahora el motor ya no ofrece la
    // hora robada, y la primera que ofrece sí se puede confirmar.
    const segundas = ((await proponerGrupo(app, "consecutive", PETICION_ADULTO_Y_MENOR)).json() as Json)
      .proposals as Json[];
    expect(segundas.some((p) => Number((p.lines as Json[])[0]?.startMinutes) === 630)).toBe(false);
    const buena = segundas[0] as Json;
    const creada = await crearGrupo(app, lineasDe(buena), String(buena.intentKeyToMint));
    expect(creada.statusCode).toBe(201);
    expect((await gruposDe(app)).map((g) => g.id)).toEqual(["grp-0001"]);
    await app.close();
  });
});

describe("step 18 · integración §4.8 — repetir la confirmación por los tres caminos posibles", () => {
  const LINEAS: LineaDeGrupo[] = [
    { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
    { memberLabel: "Menor B", serviceId: 0, employeeId: DANI, startMinutes: 570 },
  ];
  const OTRAS_LINEAS: LineaDeGrupo[] = [
    { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 600 },
    { memberLabel: "Menor B", serviceId: 0, employeeId: DANI, startMinutes: 630 },
  ];
  const CLAVE = "group:2026-08-04:consecutive:540-3-1.570-6-0:r0";

  /**
   * ENMIENDA DE FASE K (H1). Fijaba `replayed` y «cuerpo idéntico byte a
   * byte»: era fijar el replay de transporte, que es justo lo que podía mentir
   * sobre un mundo cambiado. La expectativa pasa a la verdad —se re-ejecuta y
   * la idempotencia ESTRUCTURAL contesta— sin soltar nada de lo que protegía:
   * ni una cita nueva, un solo grupo y exactamente una anotación de repetición.
   */
  it("doble clic con la MISMA clave: se re-ejecuta, contesta «ya existía» y ni una cita nueva", async () => {
    const app = freshApp();
    await reset(app);

    const primera = await crearGrupo(app, LINEAS, CLAVE);
    expect(primera.statusCode).toBe(201);
    const citasTrasLaPrimera = (await citasDe(app)).agenda.map((r) => r.id);

    const segunda = await crearGrupo(app, LINEAS, CLAVE);
    expect(segunda.statusCode).toBe(200);
    expect(segunda.headers["idempotency-status"]).toBe("re-executed");
    const cuerpo = segunda.json() as Json;
    expect(cuerpo.created).toBe(false);
    expect(cuerpo.alreadyExists).toBe(true);
    expect((cuerpo.group as Json).id).toBe("grp-0001");

    expect((await citasDe(app)).agenda.map((r) => r.id)).toEqual(citasTrasLaPrimera);
    expect((await gruposDe(app)).length).toBe(1);
    // Una repetición escribe EXACTAMENTE una cosa: que fue una repetición.
    const historial = await historialDeOperaciones(app);
    expect(historial.map((e) => e.kind)).toEqual([
      "DEMO_RESET",
      "RESERVATION_GROUP_CREATED",
      "RESERVATION_GROUP_LINE_CREATED",
      "RESERVATION_GROUP_LINE_CREATED",
      "RESERVATION_GROUP_REPEATED",
    ]);
    await app.close();
  });

  /**
   * LA REPRODUCCIÓN DE H1 de extremo a extremo: el mundo cambia entre la
   * primera petición y su repetición, y la repetición dice la verdad del
   * mundo nuevo en vez de la respuesta guardada del viejo.
   */
  it("(H1) si entre el clic y su repetición se cancelan las citas, la MISMA clave crea de verdad y no miente", async () => {
    const app = freshApp();
    await reset(app);
    expect((await crearGrupo(app, LINEAS, CLAVE)).statusCode).toBe(201);
    expect((await cancelar(app, "res-g-grp-0001-1")).statusCode).toBe(200);
    expect((await cancelar(app, "res-g-grp-0001-2")).statusCode).toBe(200);

    const repetida = await crearGrupo(app, LINEAS, CLAVE);
    expect(repetida.statusCode).toBe(201);
    expect(repetida.headers["idempotency-status"]).toBe("re-executed");
    const cuerpo = repetida.json() as Json;
    expect(cuerpo.created).toBe(true);
    expect((cuerpo.group as Json).id).toBe("grp-0002");
    // Las citas existen DE VERDAD, no sólo en un cuerpo memorizado.
    const agenda = (await citasDe(app)).agenda;
    for (const id of ["res-g-grp-0002-1", "res-g-grp-0002-2"]) {
      expect(agenda.find((r) => r.id === id)?.status, id).toBe("confirmed");
    }
    expect((await gruposDe(app)).map((g) => g.id)).toEqual(["grp-0001", "grp-0002"]);
    await app.close();
  });

  it("la misma clave con OTRO cuerpo es una colisión: 409 y ni un byte escrito", async () => {
    const app = freshApp();
    await reset(app);
    expect((await crearGrupo(app, LINEAS, CLAVE)).statusCode).toBe(201);

    const antes = await huellaDelMundo(app);
    const chocada = await crearGrupo(app, OTRAS_LINEAS, CLAVE);
    expect(chocada.statusCode).toBe(409);
    expect(chocada.json()).toEqual({ conflict: "idempotency_key_reused_with_different_body" });
    // Una colisión ni siquiera llega al motor: no ejecuta, no escribe y
    // tampoco anota un "repetido" (no hubo nada que repetir).
    expect(await huellaDelMundo(app)).toBe(antes);
    await app.close();
  });

  it("(N4, enmendado en fase K) tras un 500 inyectado la misma clave vuelve a ejecutarse, crea UNA sola vez y el tercer intento contesta «ya existía»", async () => {
    const app = freshApp();
    await reset(app);

    const fallida = await crearGrupo(app, LINEAS, CLAVE, { injectFailure: true });
    expect(fallida.statusCode).toBe(500);
    expect((fallida.json() as Json).code).toBe("synthetic_injected_failure");
    expect((await citasDe(app)).agenda.filter((r) => String(r.id).startsWith("res-g-")).length).toBe(0);

    // N4, comportamiento DECLARADO: `remember` sólo memoriza 2xx, así que un
    // fallo no congela la clave. El reintento ejecuta de verdad.
    const reintento = await crearGrupo(app, LINEAS, CLAVE);
    expect(reintento.statusCode).toBe(201);
    expect(reintento.headers["idempotency-status"]).toBe("original");

    // Y sólo una vez: el tercer intento vuelve a ejecutar (H1) y se topa con
    // la idempotencia ESTRUCTURAL, que mira el mundo y ve el grupo entero en
    // pie. No hay ningún cuerpo memorizado que reproducir.
    const tercero = await crearGrupo(app, LINEAS, CLAVE);
    expect(tercero.statusCode).toBe(200);
    expect(tercero.headers["idempotency-status"]).toBe("re-executed");
    expect((tercero.json() as Json).alreadyExists).toBe(true);

    expect((await gruposDe(app)).map((g) => g.id)).toEqual(["grp-0001"]);
    expect((await citasDe(app)).agenda.filter((r) => String(r.id).startsWith("res-g-")).map((r) => r.id)).toEqual([
      "res-g-grp-0001-1",
      "res-g-grp-0001-2",
    ]);
    await app.close();
  });

  it("una intención repetida con OTRA clave y las mismas líneas vivas no duplica: 200 «ya existía» y cero citas nuevas", async () => {
    const app = freshApp();
    await reset(app);
    expect((await crearGrupo(app, LINEAS, CLAVE)).statusCode).toBe(201);
    const citas = (await citasDe(app)).agenda.map((r) => r.id);

    const otra = await crearGrupo(app, LINEAS, "otra-clave-distinta-del-mismo-grupo");
    expect(otra.statusCode).toBe(200);
    const cuerpo = otra.json() as Json;
    expect(cuerpo.created).toBe(false);
    expect(cuerpo.alreadyExists).toBe(true);
    expect((cuerpo.group as Json).id).toBe("grp-0001");

    expect((await citasDe(app)).agenda.map((r) => r.id)).toEqual(citas);
    expect((await gruposDe(app)).length).toBe(1);
    await app.close();
  });

  it("proponer no escribe nada aunque se pida diez veces seguidas: la huella del mundo no se mueve", async () => {
    const app = freshApp();
    await reset(app);
    const antes = await huellaDelMundo(app);
    for (let i = 0; i < 10; i += 1) {
      const res = await proponerGrupo(app, "simultaneous", [
        { memberLabel: "Persona 1", serviceId: 1, professional: { kind: "any" } },
        { memberLabel: "Persona 2", serviceId: 1, professional: { kind: "any" } },
      ], BOOKING_DEMO_TODAY);
      expect(res.statusCode).toBe(200);
    }
    expect(await huellaDelMundo(app)).toBe(antes);
    await app.close();
  });
});
