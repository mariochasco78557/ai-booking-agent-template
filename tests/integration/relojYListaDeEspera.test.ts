import { describe, expect, it } from "vitest";

import { OPERATIONS_COPY } from "../../src/console/operationsSnapshot.js";
import {
  HUECO_1300_ALEX,
  HUECO_1330_ALEX,
  type Json,
  RES_ALEX_1300,
  avanzarMinutos,
  aprobarPropuesta,
  cancelar,
  citasDe,
  comando,
  convertir,
  entradaDeListaDeEspera,
  freshApp,
  historialDeListaDeEspera,
  huellaDelMundo,
  operationsOf,
  reset,
  tareasHumanas,
  waitlistOf,
} from "./harness.js";

/**
 * step 18 · fase H — EL EFECTO COLATERAL DECLARADO DEL §3.3 (advertencia 9
 * de la revisión C), probado de punta a punta.
 *
 * El diseño lo dice con todas las letras y NO lo arregla: si el reloj avanza
 * más allá de un hueco liberado, ese hueco pasa a `slot_in_the_past`, la
 * conversión deja de ser posible y la tarea `DECIDE_WAITLIST_MATCH` se queda
 * ABIERTA sin forma de cerrarse por su camino natural. Cerrarla sola sería
 * afirmar que alguien decidió algo que nadie decidió; inventar un comando
 * nuevo para descartarla queda fuera de alcance [K11]. Lo que el sistema hace
 * es decir la verdad, y esto lo comprueba.
 *
 * Esta prueba es la fotografía del comportamiento CONOCIDO. Si algún día se
 * decide cerrarla o reabrir la oferta, esta prueba debe cambiar A LA VEZ que
 * el §3.3 del diseño — nunca antes, y nunca en silencio.
 */

describe("step 18 · integración §3.3 — avanzar el reloj más allá de un hueco liberado lo vuelve irresoluble, y se dice", () => {
  it("la oferta aceptada deja de valer, la conversión da su conflicto veraz y la tarea DECIDE_WAITLIST_MATCH sigue abierta", async () => {
    const app = freshApp();
    await reset(app);

    // Las 09:00. Se cancela la cita de las 13:00 y `wl-f01` acepta el hueco.
    expect((await cancelar(app, RES_ALEX_1300)).statusCode).toBe(200);
    // (step 23, R2) El paso humano que faltaba: una persona aprueba la
    // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    expect((await comando(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    expect((await comando(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
    const antesDeMover = await entradaDeListaDeEspera(app, "wl-f01");
    expect((antesDeMover.offer as Json).stillValid).toBe(true);
    const tareasAntes = (await tareasHumanas(app)).filter(
      (t) => t.reasonKind === "DECIDE_WAITLIST_MATCH" && t.open === true,
    );
    expect(tareasAntes.map((t) => t.id)).toEqual([`decidir-hueco-${HUECO_1300_ALEX}`, `decidir-hueco-${HUECO_1330_ALEX}`]);

    // El operador mueve el reloj a las 14:30, más allá de las 13:00.
    expect((await avanzarMinutos(app, 330)).statusCode).toBe(200);
    expect((await operationsOf(app)).clock).toMatchObject({
      minutes: 870,
      label: "martes 4 de agosto, 14:30",
      advancedByMinutes: 330,
    });

    // La oferta se re-deriva sola en cada instantánea: la pantalla dice la
    // verdad sin que nadie la haya tocado (§14.6 de step 17).
    const trasMover = await entradaDeListaDeEspera(app, "wl-f01");
    expect(trasMover.state).toBe("accepted");
    expect((trasMover.offer as Json).stillValid).toBe(false);
    expect(((trasMover.offer as Json).invalidReasons as Json[]).map((r) => r.code)).toEqual(["slot_in_the_past"]);
    expect(((trasMover.offer as Json).invalidReasons as Json[]).map((r) => r.label)).toEqual(["Ese hueco ya ha pasado"]);

    // Y convertir devuelve el conflicto veraz, sin escribir ni una cita.
    const citasAntes = (await citasDe(app)).agenda.map((r) => r.id);
    const conversion = await convertir(app, "wl-f01", HUECO_1300_ALEX);
    expect(conversion.statusCode).toBe(409);
    expect(conversion.json()).toEqual({
      applied: false,
      conflict: "slot_no_longer_free",
      revalidation: { reasons: ["slot_in_the_past"] },
      entryState: "pending",
    });
    expect((await citasDe(app)).agenda.map((r) => r.id)).toEqual(citasAntes);

    // LA TAREA SIGUE ABIERTA. No se cierra sola y no hay comando que la cierre.
    const tareasDespues = (await tareasHumanas(app)).filter(
      (t) => t.reasonKind === "DECIDE_WAITLIST_MATCH" && t.open === true,
    );
    expect(tareasDespues.map((t) => t.id)).toEqual(tareasAntes.map((t) => t.id));
    await app.close();
  });

  it("los comandos que quedan sobre esa entrada devuelven su conflicto veraz, y ninguno resucita el hueco", async () => {
    const app = freshApp();
    await reset(app);
    await cancelar(app, RES_ALEX_1300);
    // (step 23, R2) El paso humano que faltaba: una persona aprueba la
    // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    await comando(app, "wl-f01", "simulate_notice");
    await comando(app, "wl-f01", "record_acceptance");
    await avanzarMinutos(app, 330);
    // La conversión fallida devuelve la entrada a `pending` sin oferta.
    expect((await convertir(app, "wl-f01", HUECO_1300_ALEX)).statusCode).toBe(409);
    const entrada = await entradaDeListaDeEspera(app, "wl-f01");
    expect(entrada.state).toBe("pending");
    expect(entrada.offer).toBeNull();
    // (step 23 §5) `take_over_proposal` se ofrece también desde 'pendiente':
    // sustituir a quien no tiene oferta es justo el caso para el que existe.
    expect(entrada.availableCommands).toEqual(["withdraw", "expire_manually", "take_over_proposal"]);

    // Los tres comandos de oferta ya no son alcanzables, y cada 409 dice
    // exactamente desde qué estado y qué queda disponible.
    const antes = await huellaDelMundo(app);
    for (const cmd of ["simulate_notice", "record_acceptance", "record_decline"]) {
      const res = await comando(app, "wl-f01", cmd);
      expect(res.statusCode, cmd).toBe(409);
      expect(res.json(), cmd).toEqual({
        conflict: "entry_state_not_allowed",
        fromState: "pending",
        command: cmd,
        allowedCommands: ["withdraw", "expire_manually", "take_over_proposal"],
      });
    }
    // Ni uno de los tres rechazos ha escrito nada.
    expect(await huellaDelMundo(app)).toBe(antes);

    // Y el hueco sigue existiendo, pasado, sin nadie compatible: no ha
    // desaparecido ni se ha reciclado en silencio.
    const hueco = ((await waitlistOf(app)).releasedSlots as Json[]).find((s) => s.key === HUECO_1300_ALEX);
    expect(hueco, "el hueco de las 13:00 ha desaparecido del historial").toBeDefined();
    expect((hueco as Json).compatibleEntryIds).toEqual([]);
    const motivos = ((hueco as Json).incompatible as Json[]).flatMap((i) => (i.reasons as Json[]).map((r) => r.code));
    expect(motivos).toContain("slot_in_the_past");
    await app.close();
  });

  it("la salida limpia es reiniciar, y la copia del panel del reloj lo avisa antes de mover", async () => {
    const app = freshApp();
    await reset(app);
    await cancelar(app, RES_ALEX_1300);
    // (step 23, R2) El paso humano que faltaba: una persona aprueba la
    // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    await comando(app, "wl-f01", "simulate_notice");
    await comando(app, "wl-f01", "record_acceptance");
    await avanzarMinutos(app, 330);
    await convertir(app, "wl-f01", HUECO_1300_ALEX);

    // El aviso que el operador lee ANTES de mover está en la instantánea, ya
    // resuelto por el servidor, y dice que el reloj no retrocede.
    const operations = await operationsOf(app);
    expect(((operations.noShows as Json).copy as Json).clockOnlyForwards).toBe(OPERATIONS_COPY.clockOnlyForwards);
    expect((operations.clock as Json).notice).toBe(OPERATIONS_COPY.clockNotice);

    // Y reiniciar deshace el callejón sin salida: entradas pendientes, cero
    // huecos, cero tareas abiertas, reloj a las 09:00.
    expect((await avanzarMinutos(app, 1)).statusCode).toBe(200);
    const reinicio = await app.inject({ method: "POST", url: "/api/reset", payload: {} as never });
    expect(reinicio.statusCode).toBe(200);

    expect(((await waitlistOf(app)).releasedSlots as Json[])).toEqual([]);
    expect((await tareasHumanas(app)).filter((t) => t.open === true)).toEqual([]);
    expect(((await waitlistOf(app)).entries as Json[]).every((e) => e.state === "pending")).toBe(true);
    expect((await operationsOf(app)).clock).toMatchObject({ minutes: 540, advancedByMinutes: 0 });
    expect((await historialDeListaDeEspera(app)).map((e) => e.kind)).toEqual(["DEMO_RESET"]);
    await app.close();
  });
});

/**
 * LA REPRODUCCIÓN EXACTA DE H2 (revisión adversarial, fase J). Cruzar la
 * medianoche —cuatro pulsaciones de «+4 h» en la pantalla, `+1500` minutos
 * aquí— dejaba los huecos de AYER etiquetados sólo como
 * `date_outside_booking_horizon` («Ese día queda fuera del plazo en el que se
 * puede reservar»), que es cierto pero no es el motivo: el motivo es que ese
 * hueco YA HA PASADO, y `isStartInThePast` sólo miraba el mismo día.
 */
describe("step 18 · enmienda de fase K (H2) — pasada la medianoche, un hueco de ayer dice que ha pasado", () => {
  it("la oferta de ayer se etiqueta `slot_in_the_past`, y también sigue estando fuera del plazo", async () => {
    const app = freshApp();
    await reset(app);
    expect((await cancelar(app, RES_ALEX_1300)).statusCode).toBe(200);
    // (step 23, R2) El paso humano que faltaba: una persona aprueba la
    // propuesta de ESE hueco antes de que se pueda simular ningún aviso.
    await aprobarPropuesta(app, "wl-f01", HUECO_1300_ALEX);
    expect((await comando(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    expect((await comando(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);

    // 25 horas: el reloj cambia de DÍA, que es la parte que faltaba.
    expect((await avanzarMinutos(app, 1500)).statusCode).toBe(200);
    expect((await operationsOf(app)).clock).toMatchObject({ label: "miércoles 5 de agosto, 10:00" });

    const entrada = await entradaDeListaDeEspera(app, "wl-f01");
    const oferta = entrada.offer as Json;
    expect(oferta.stillValid).toBe(false);
    // Los DOS motivos, en el orden canónico de `WAITLIST_MISMATCH_REASONS`, y
    // los dos ciertos. Lo que H2 echaba en falta era el segundo.
    expect((oferta.invalidReasons as Json[]).map((r) => r.code)).toEqual([
      "date_outside_booking_horizon",
      "slot_in_the_past",
    ]);
    expect((oferta.invalidReasons as Json[]).map((r) => r.label)).toEqual([
      "Ese día queda fuera del plazo en el que se puede reservar",
      "Ese hueco ya ha pasado",
    ]);

    // Y convertir tampoco puede mentir sobre el porqué.
    const conversion = await convertir(app, "wl-f01", HUECO_1300_ALEX);
    expect(conversion.statusCode).toBe(409);
    expect((conversion.json() as Json).revalidation).toEqual({
      reasons: ["date_outside_booking_horizon", "slot_in_the_past"],
    });
    await app.close();
  });
});

/**
 * step 23 · REVISIÓN ADVERSARIAL (H2) — R1(d) también cuando quien decide es
 * una persona.
 *
 * «Nadie es sujeto de dos propuestas a la vez» sólo se comprobaba en el camino
 * automático. Con el reloj pasado de las 13:00, la propuesta de ese hueco queda
 * INVALIDADA PERO PRESENTE (§3.2: no se sustituye sola entre disparadores), y
 * el operador podía darle además el hueco de las 13:30 a la misma persona. Al
 * retirarse ella, T3 reparaba el primero que encontraba y el otro se quedaba
 * con una propuesta hacia alguien que ya no está y sin disparador que fuera a
 * tocarla nunca.
 */
describe("step 23 · revisión adversarial (H2) — nadie queda como sujeto de dos propuestas, ni por la mano del operador", () => {
  it("sustituir en el hermano retira la propuesta muerta del primer hueco, la explica en el rastro, y al retirarse no queda ninguna huérfana", async () => {
    const app = freshApp();
    await reset(app);
    expect((await cancelar(app, RES_ALEX_1300)).statusCode).toBe(200);

    // Las 13:20: el hueco de las 13:00 ya ha pasado y su propuesta para
    // `wl-f01` sigue ahí, invalidada y dicha, esperando un disparador.
    expect((await avanzarMinutos(app, 260)).statusCode).toBe(200);
    const antes = (await waitlistOf(app)).releasedSlots as Json[];
    expect(((antes.find((s) => s.key === HUECO_1300_ALEX) as Json).proposal as Json).statusCode).toBe("invalidated");

    expect((await comando(app, "wl-f01", "take_over_proposal", HUECO_1330_ALEX)).statusCode).toBe(200);
    const huecos = (await waitlistOf(app)).releasedSlots as Json[];
    const sujetos = huecos.map((s) => (s.proposal as Json | null)?.entryId).filter((x) => x !== undefined);
    expect(sujetos).toEqual(["wl-f01"]);
    expect((huecos.find((s) => s.key === HUECO_1300_ALEX) as Json).proposal).toBeNull();

    // Y no se ha ido en silencio: el rastro dice qué propuesta ha dejado de
    // valer, de quién era y por qué, con el motivo REAL de antes de mover nada.
    const invalidadas = (await historialDeListaDeEspera(app)).filter(
      (e) => e.kind === "WAITLIST_PROPOSAL_INVALIDATED" && e.slotKey === HUECO_1300_ALEX,
    );
    expect(invalidadas.length).toBe(1);
    expect(invalidadas[0]?.entryId).toBe("wl-f01");
    expect(String(invalidadas[0]?.text)).toContain("ya ha pasado");

    // Al retirarse, no queda NI UNA propuesta apuntando a quien ya no está.
    expect((await comando(app, "wl-f01", "withdraw")).statusCode).toBe(200);
    const despues = (await waitlistOf(app)).releasedSlots as Json[];
    expect(despues.map((s) => (s.proposal as Json | null)?.entryId).filter((x) => x !== undefined)).not.toContain(
      "wl-f01",
    );
    await app.close();
  });
});
