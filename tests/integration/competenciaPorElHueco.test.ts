import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  ALEX,
  DANI,
  HUECO_1300_ALEX,
  HUECO_1330_ALEX,
  type Json,
  type LineaDeGrupo,
  NEREA,
  RES_ALEX_1300,
  aprobarPropuesta,
  cancelar,
  citasDe,
  comando,
  convertir,
  crearGrupo,
  entradaDeListaDeEspera,
  freshApp,
  gruposDe,
  historialDeListaDeEspera,
  historialDeOperaciones,
  huellaDelMundo,
  reset,
  tareasHumanas,
  waitlistOf,
} from "./harness.js";

/**
 * step 18 · fase H — EL CRUCE que ninguna suite anterior podía hacer: una
 * conversión de lista de espera (step 17) y una reserva para varias personas
 * (step 18) peleándose por EL MISMO hueco físico. Es el ataque 18 del
 * encargo de misión, y se prueba en los dos órdenes y también a la vez.
 *
 * El hueco: cancelar `demo-salon-res-2` (Álex, 13:00–14:00) libera
 * `slot-2026-08-04-780-3`, que es justo el que la entrada `wl-f01` recibe en
 * oferta. Un grupo puede pedir esa misma hora con Álex.
 *
 * LO QUE SE FIRMA AQUÍ: quien llega primero gana; el segundo recibe SU
 * conflicto veraz; y el perdedor no escribe NI UNA CITA NI UN GRUPO. Lo que
 * NO se firma —porque no es cierto— es que el perdedor no escriba nada en
 * absoluto: cuando el que pierde es la conversión, step 17 devuelve la
 * entrada a `pending`, anota `WAITLIST_CONVERSION_CONFLICT` y abre una tarea
 * de revisión. Eso es el camino de conflicto DECLARADO del criterio 11 de
 * step 17 (`waitlist/commands.ts`, `convertToReservation`), y existe
 * precisamente para que la pantalla no siga enseñando una oferta que ya no
 * existe. Se comprueba tal cual es.
 */

const LINEAS_A_LAS_13: LineaDeGrupo[] = [
  { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 780 },
  { memberLabel: "Menor B", serviceId: 1, employeeId: DANI, startMinutes: 780 },
];

/** Deja `wl-f01` en `accepted` sobre el hueco de las 13:00, listo para convertir. */
async function hastaAceptada(app: FastifyInstance): Promise<void> {
  expect((await cancelar(app, RES_ALEX_1300)).statusCode).toBe(200);
  const entrada = await entradaDeListaDeEspera(app, "wl-f01");
  expect((entrada.offer as Json).slotKey).toBe(HUECO_1300_ALEX);
  // (step 23, R2) El paso humano que faltaba: una persona aprueba la
  // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
  await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
  expect((await comando(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
  expect((await comando(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
}

async function citasDeAlexALaUna(app: FastifyInstance): Promise<Json[]> {
  const { agenda } = await citasDe(app);
  return agenda.filter((r) => r.employeeId === ALEX && r.startMinutes === 780 && r.status === "confirmed");
}

describe("step 18 · integración (ataque 18) — un grupo y una conversión pelean por el hueco de las 13:00", () => {
  it("orden A · el grupo llega primero: la conversión sale por slot_no_longer_free y no escribe NI UNA cita", async () => {
    const app = freshApp();
    await reset(app);
    await hastaAceptada(app);

    const grupo = await crearGrupo(app, LINEAS_A_LAS_13, "carrera:grupo-primero:1", { arrangement: "simultaneous" });
    expect(grupo.statusCode).toBe(201);
    expect(((grupo.json() as Json).reservations as Json[]).map((r) => r.id)).toEqual([
      "res-g-grp-0001-1",
      "res-g-grp-0001-2",
    ]);

    const citasAntes = (await citasDe(app)).agenda.map((r) => r.id);
    const conversion = await convertir(app, "wl-f01", HUECO_1300_ALEX);
    expect(conversion.statusCode).toBe(409);
    expect(conversion.json()).toEqual({
      applied: false,
      conflict: "slot_no_longer_free",
      revalidation: { reasons: ["slot_no_longer_free"] },
      entryState: "pending",
    });

    // CERO citas escritas por el perdedor: la lista de citas es la misma.
    expect((await citasDe(app)).agenda.map((r) => r.id)).toEqual(citasAntes);
    expect((await citasDeAlexALaUna(app)).map((r) => r.id)).toEqual(["res-g-grp-0001-1"]);

    // Lo ÚNICO que el conflicto deja escrito, y está declarado: la entrada
    // vuelve a `pending` sin oferta y queda una tarea de revisión abierta.
    const entrada = await entradaDeListaDeEspera(app, "wl-f01");
    expect(entrada.state).toBe("pending");
    expect(entrada.offer).toBeNull();
    const kinds = (await historialDeListaDeEspera(app)).map((e) => e.kind);
    expect(kinds.filter((k) => k === "WAITLIST_ENTRY_CONVERTED").length).toBe(0);
    expect(kinds.filter((k) => k === "WAITLIST_CONVERSION_CONFLICT").length).toBe(1);
    const tareas = await tareasHumanas(app);
    expect(tareas.some((t) => t.id === "conflicto-conversion-wl-f01" && t.open === true)).toBe(true);
    await app.close();
  });

  it("orden B · la conversión llega primero: el grupo sale por slot_no_longer_free señalando su línea y no escribe NADA", async () => {
    const app = freshApp();
    await reset(app);
    await hastaAceptada(app);

    const conversion = await convertir(app, "wl-f01", HUECO_1300_ALEX);
    expect(conversion.statusCode).toBe(200);
    expect((conversion.json() as Json).applied).toBe(true);
    expect((await entradaDeListaDeEspera(app, "wl-f01")).state).toBe("converted");

    const huellaAntes = await huellaDelMundo(app);
    const grupo = await crearGrupo(app, LINEAS_A_LAS_13, "carrera:lista-primero:1", { arrangement: "simultaneous" });
    expect(grupo.statusCode).toBe(409);
    const cuerpo = grupo.json() as Json;
    expect(cuerpo.created).toBe(false);
    expect(cuerpo.conflict).toBe("slot_no_longer_free");
    expect((cuerpo.line as Json).memberLabel).toBe("Adulto A");
    expect((cuerpo.line as Json).when).toBe("13:00");

    // El grupo que pierde no deja rastro NINGUNO: ni grupo, ni cita, ni evento.
    expect(await huellaDelMundo(app)).toBe(huellaAntes);
    expect(await gruposDe(app)).toEqual([]);
    expect((await citasDeAlexALaUna(app)).map((r) => r.id)).toEqual([`res-wl-wl-f01-2026-08-04-780-3`]);
    expect((await historialDeOperaciones(app)).map((e) => e.kind)).toEqual(["DEMO_RESET"]);
    await app.close();
  });

  it("lanzadas A LA VEZ: exactamente una gana, la otra recibe su conflicto y el hueco de Álex queda ocupado UNA sola vez", async () => {
    const app = freshApp();
    await reset(app);
    await hastaAceptada(app);

    // Node atiende una petición por tick y ninguno de los dos caminos es
    // `async` entre revalidar y escribir: lanzarlas juntas es la carrera más
    // ajustada que se puede montar contra este servidor.
    const [grupo, conversion] = await Promise.all([
      crearGrupo(app, LINEAS_A_LAS_13, "carrera:a-la-vez:1", { arrangement: "simultaneous" }),
      convertir(app, "wl-f01", HUECO_1300_ALEX, "carrera:a-la-vez:2"),
    ]);

    const codigos = [grupo.statusCode, conversion.statusCode];
    expect(codigos.filter((c) => c === 409).length, JSON.stringify(codigos)).toBe(1);
    expect(codigos.filter((c) => c === 201 || c === 200).length).toBe(1);

    const perdedora = (grupo.statusCode === 409 ? grupo : conversion).json() as Json;
    expect(perdedora.conflict).toBe("slot_no_longer_free");

    // El invariante que de verdad importa: el hueco físico, ocupado una vez.
    expect((await citasDeAlexALaUna(app)).length).toBe(1);
    // Y nunca las dos escrituras a la vez: exactamente UNA de las dos ocurrió.
    const grupoCreado = (await gruposDe(app)).length === 1;
    const entradaConvertida = (await entradaDeListaDeEspera(app, "wl-f01")).state === "converted";
    expect([grupoCreado, entradaConvertida].filter(Boolean).length).toBe(1);
    await app.close();
  });

  it("dos grupos distintos a la vez sobre el mismo hueco: una crea, la otra 409, jamás dos citas", async () => {
    const app = freshApp();
    await reset(app);

    const [a, b] = await Promise.all([
      crearGrupo(
        app,
        [
          { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 660 },
          { memberLabel: "Menor B", serviceId: 1, employeeId: DANI, startMinutes: 660 },
        ],
        "carrera:grupo-a:1",
        { arrangement: "simultaneous" },
      ),
      crearGrupo(
        app,
        [
          { memberLabel: "Persona 1", serviceId: 1, employeeId: ALEX, startMinutes: 660 },
          { memberLabel: "Persona 2", serviceId: 1, employeeId: NEREA, startMinutes: 660 },
        ],
        "carrera:grupo-b:1",
        { arrangement: "simultaneous" },
      ),
    ]);

    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([201, 409]);
    const perdedora = (a.statusCode === 409 ? a : b).json() as Json;
    expect(perdedora.conflict).toBe("slot_no_longer_free");

    const { agenda } = await citasDe(app);
    expect(agenda.filter((r) => r.employeeId === ALEX && r.startMinutes === 660 && r.status === "confirmed").length).toBe(1);
    expect((await gruposDe(app)).length).toBe(1);
    await app.close();
  });

  it("la SEGUNDA entrada, que tenía oferta sobre el mismo hueco, dice la verdad y puede soltarla; el hueco hermano de las 13:30 sigue intacto", async () => {
    const app = freshApp();
    await reset(app);
    await hastaAceptada(app);
    expect((await crearGrupo(app, LINEAS_A_LAS_13, "carrera:hermano:1", { arrangement: "simultaneous" })).statusCode).toBe(201);
    expect((await convertir(app, "wl-f01", HUECO_1300_ALEX)).statusCode).toBe(409);

    // `wl-f02` también estaba emparejada con el hueco de las 13:00. Su oferta
    // ya no vale, y la proyección lo dice sin que nadie la toque (§14.6 de
    // step 17: `stillValid` se re-deriva en cada instantánea).
    const f02 = await entradaDeListaDeEspera(app, "wl-f02");
    expect(f02.state).toBe("matched");
    expect((f02.offer as Json).slotKey).toBe(HUECO_1300_ALEX);
    expect((f02.offer as Json).stillValid).toBe(false);
    expect(((f02.offer as Json).invalidReasons as Json[]).map((r) => r.code)).toEqual(["slot_no_longer_free"]);

    // Y el comando sobre esa oferta muerta devuelve SU conflicto veraz, sin
    // escribir nada y sin inventar una reserva.
    const citasAntes = (await citasDe(app)).agenda.map((r) => r.id);
    const aviso = await comando(app, "wl-f02", "simulate_notice");
    expect(aviso.statusCode).toBe(409);
    expect(aviso.json()).toEqual({ conflict: "offer_no_longer_valid", reasons: ["slot_no_longer_free"] });
    expect((await citasDe(app)).agenda.map((r) => r.id)).toEqual(citasAntes);

    // Soltar el emparejamiento la devuelve a `pending`, y entonces vuelve a
    // figurar como compatible con el hueco de las 13:30, que nadie ha tocado.
    expect((await comando(app, "wl-f02", "release_match")).statusCode).toBe(200);
    expect((await entradaDeListaDeEspera(app, "wl-f02")).state).toBe("pending");
    const huecos = (await waitlistOf(app)).releasedSlots as Json[];
    const hermano = huecos.find((s) => s.key === HUECO_1330_ALEX);
    expect(hermano, "el hueco de las 13:30 ha desaparecido").toBeDefined();
    expect((hermano as Json).compatibleEntryIds).toContain("wl-f02");
    await app.close();
  });
});

/**
 * step 23 · REVISIÓN ADVERSARIAL (H1) — la otra competencia por el mismo
 * hueco: la de dos personas de la lista, con el operador en medio.
 *
 * §5.1 permite sustituir la propuesta de un hueco «porque sólo se mueve un
 * puntero y la desplazada no pierde nada». Eso deja de ser cierto en cuanto a
 * la desplazada SE LE HA AVISADO: entonces la sustitución dejaría a dos
 * personas `notice_simulated` por el mismo medio hora —lo que §5.2 dice que R2
 * impide «gratis»— y el rastro escribiría «sigue en la lista» de alguien que
 * está a un clic de convertir ese hueco. Aquí se firma que el servidor lo
 * rechaza, que no publica sustitutos para un hueco así, y que el aviso y la
 * aceptación siguen siendo de quien lo son.
 */
describe("step 23 · revisión adversarial (H1) — el hueco por el que ya se ha avisado no se reasigna", () => {
  it("con la propuesta ya avisada, sustituirla es 409 y NADIE más queda avisado por ese medio hora", async () => {
    const app = freshApp();
    await reset(app);
    expect((await cancelar(app, RES_ALEX_1300)).statusCode).toBe(200);
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    expect((await comando(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);

    const huellaAntes = await huellaDelMundo(app);
    const robo = await comando(app, "wl-f02", "take_over_proposal", HUECO_1300_ALEX);
    expect(robo.statusCode).toBe(409);
    expect((robo.json() as Json).conflict).toBe("proposal_already_notified_or_accepted");
    expect(await huellaDelMundo(app)).toBe(huellaAntes);

    // Y `wl-f02` tampoco puede avisarse por la puerta de atrás: la propuesta
    // sigue siendo de `wl-f01`, así que R2 la para.
    expect((await comando(app, "wl-f02", "simulate_notice")).statusCode).toBe(409);
    const avisadas = ((await waitlistOf(app)).entries as Json[]).filter(
      (e) => e.state === "notice_simulated" && ((e.offer as Json | null)?.slotKey ?? null) === HUECO_1300_ALEX,
    );
    expect(avisadas.map((e) => e.id)).toEqual(["wl-f01"]);
    await app.close();
  });

  it("un hueco YA ACEPTADO no publica ni un sustituto, y su propuesta sigue siendo de quien aceptó", async () => {
    const app = freshApp();
    await reset(app);
    await hastaAceptada(app);

    const huecos = (await waitlistOf(app)).releasedSlots as Json[];
    const alaUna = huecos.find((s) => s.key === HUECO_1300_ALEX) as Json;
    // Publicar aquí a `wl-f02` era ofrecer un botón que sólo puede dar 409, y
    // además insinuar que a quien ha aceptado se la puede apartar sin más.
    expect(alaUna.substitutableEntryIds).toEqual([]);
    const propuesta = alaUna.proposal as Json;
    expect(propuesta.entryId).toBe("wl-f01");
    expect(propuesta.statusCode).toBe("accepted");
    expect(propuesta.canSimulateNotice).toBe(false);
    expect(propuesta.substitutedFromClientLabel).toBeNull();
    await app.close();
  });

  it("y sustituir a la aceptada es 409: ni el copy ni el rastro dicen que sigue en la lista", async () => {
    const app = freshApp();
    await reset(app);
    await hastaAceptada(app);

    const robo = await comando(app, "wl-f02", "take_over_proposal", HUECO_1300_ALEX);
    expect(robo.statusCode).toBe(409);
    expect((robo.json() as Json).conflict).toBe("proposal_already_notified_or_accepted");

    const alaUna = ((await waitlistOf(app)).releasedSlots as Json[]).find((s) => s.key === HUECO_1300_ALEX) as Json;
    const propuesta = alaUna.proposal as Json;
    expect(propuesta.entryId).toBe("wl-f01");
    expect(propuesta.statusCode).toBe("accepted");
    expect(propuesta.canSimulateNotice).toBe(false);
    // El rastro no ha escrito ninguna sustitución, así que tampoco la frase
    // «{Cliente A} sigue en la lista» sobre alguien que ha aceptado ese hueco.
    const rastro = await historialDeListaDeEspera(app);
    expect(rastro.filter((e) => e.kind === "WAITLIST_PROPOSAL_SUBSTITUTED")).toEqual([]);
    expect(rastro.map((e) => String(e.text)).filter((t) => t.includes("sigue en la lista"))).toEqual([]);
    await app.close();
  });
});
