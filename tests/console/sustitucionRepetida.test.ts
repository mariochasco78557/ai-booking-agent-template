import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 23 · REPARACIÓN R-SUB — LA SUSTITUCIÓN REPETIDA.
 *
 * EL DEFECTO, tal y como se reprodujo en `ea6bc359`: la proyección nombraba a
 * la persona desplazada comparando `proposal.entryId` con
 * `proposal.automaticEntryId` —quién propuso la REGLA AUTOMÁTICA la primera
 * vez—. Esa comparación acierta por casualidad mientras nadie vuelva atrás:
 *
 *   · A→B  →  entryId=B ≠ automaticEntryId=A  →  «B ha sustituido a A». Bien.
 *   · A→B→A →  entryId=A === automaticEntryId=A  →  desplazada = null.
 *
 * …y la tarjeta terminaba diciendo a la vez que estaba `substituted` y que no
 * había sustituido a nadie: `substitutionNote` y `substitutedFromClientLabel`
 * en `null` con `clientLabel = Cliente A`. El registro de auditoría SÍ sabía la
 * verdad (`WAITLIST_PROPOSAL_SUBSTITUTED` con `replacedEntryId = B`), así que
 * el defecto era exclusivamente de la proyección: la pantalla contradecía al
 * rastro que ella misma publicaba dos centímetros más abajo.
 *
 * LA REGLA QUE SE FIJA AQUÍ: la confirmación persistente refleja SIEMPRE la
 * sustitución MÁS RECIENTE, venga de donde venga, y nunca la primera. Estas
 * pruebas recorren A→B, A→B→A, la cadena A→B→A→B y una cadena con tres
 * personas distintas, y comprueban en cada paso que la tarjeta y el último
 * evento autoritativo cuentan LA MISMA historia.
 * ────────────────────────────────────────────────────────────────────────
 */

const TEST_SALT = "sustitucion-repetida-salt";
const HUECO_A_LA_UNA = "slot-2026-08-04-780-3";

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

async function waitlistOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as Json).waitlist as Json;
}

async function reset(app: FastifyInstance): Promise<void> {
  expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
}

async function cancel(app: FastifyInstance, reservationId: string) {
  return post(
    app,
    `/api/reservations/${reservationId}/cancel`,
    { reasonCode: "unspecified", confirmed: true },
    { "idempotency-key": `cancel:${reservationId}` },
  );
}

/** Sustituye y EXIGE 200: una sustitución rechazada invalidaría el recorrido en silencio. */
async function sustituir(app: FastifyInstance, entryId: string, slotKey = HUECO_A_LA_UNA) {
  const res = await post(app, `/api/waitlist/entries/${entryId}/command`, {
    command: "take_over_proposal",
    slotKey,
  });
  expect(res.statusCode, `no se pudo sustituir con ${entryId}: ${res.body}`).toBe(200);
  return res;
}

async function tarjetaDeHueco(app: FastifyInstance, key = HUECO_A_LA_UNA): Promise<Json> {
  const slots = (await waitlistOf(app)).releasedSlots as Json[];
  const slot = slots.find((s) => s.key === key);
  expect(slot, `no existe el hueco ${key}`).toBeDefined();
  return slot as Json;
}

async function propuesta(app: FastifyInstance, key = HUECO_A_LA_UNA): Promise<Json> {
  const p = (await tarjetaDeHueco(app, key)).proposal;
  expect(p, `el hueco ${key} no tiene propuesta`).not.toBeNull();
  return p as Json;
}

/** Los actos de sustitución de ese hueco EN EL RASTRO, en orden, tal y como los lee un operador. */
async function sustitucionesEnElRastro(app: FastifyInstance, key = HUECO_A_LA_UNA): Promise<Json[]> {
  const items = ((await waitlistOf(app)).audit as Json).items as Json[];
  return items
    .filter((e) => e.slotKey === key && e.kind === "WAITLIST_PROPOSAL_SUBSTITUTED")
    .sort((a, b) => (a.seq as number) - (b.seq as number));
}

/** El ÚLTIMO acto de sustitución de ese hueco: la única verdad que la tarjeta puede reflejar. */
async function ultimaSustitucion(app: FastifyInstance, key = HUECO_A_LA_UNA): Promise<Json | undefined> {
  return (await sustitucionesEnElRastro(app, key)).at(-1);
}

/**
 * Deja la demo con el hueco de la una liberado y su propuesta AUTOMÁTICA
 * puesta en Cliente A (`wl-f01`), que es el punto de partida de los cuatro
 * recorridos.
 */
async function demoConPropuestaAutomatica(): Promise<FastifyInstance> {
  const app = freshApp();
  await reset(app);
  expect((await cancel(app, "demo-salon-res-2")).statusCode).toBe(200);
  const p = await propuesta(app);
  expect([p.statusCode, p.clientLabel]).toEqual(["pending_approval", "Cliente A"]);
  expect(p.substitutedFromClientLabel).toBeNull();
  expect(p.substitutionNote).toBeNull();
  return app;
}

describe("step 23 · R-SUB — la sustitución repetida nombra SIEMPRE al desplazado más reciente", () => {
  it("A→B: la primera sustitución nombra a A como desplazado (comportamiento heredado, no se rompe)", async () => {
    const app = await demoConPropuestaAutomatica();

    await sustituir(app, "wl-f02");

    const p = await propuesta(app);
    expect(p.statusCode).toBe("substituted");
    expect(p.clientLabel).toBe("Cliente B");
    expect(p.substitutedFromClientLabel).toBe("Cliente A");
    expect(p.substitutionNote).toBe("Cliente B ha sustituido a Cliente A para esta propuesta.");

    // Y coincide con el acto autoritativo del rastro, que es de donde sale.
    const ev = await ultimaSustitucion(app);
    expect(ev?.entryId).toBe("wl-f02");
    expect(ev?.text).toContain("Un operador ha propuesto a Cliente B en lugar de Cliente A");

    await app.close();
  });

  it("A→B→A: volver atrás NO borra la sustitución — la tarjeta dice que A ha sustituido a B", async () => {
    const app = await demoConPropuestaAutomatica();

    await sustituir(app, "wl-f02"); // A → B
    await sustituir(app, "wl-f01"); // B → A, deliberadamente de vuelta

    const p = await propuesta(app);
    // Esto es EXACTAMENTE lo que fallaba: `substituted` sin desplazado.
    expect(p.statusCode).toBe("substituted");
    expect(p.clientLabel).toBe("Cliente A");
    expect(p.substitutedFromClientLabel).toBe("Cliente B");
    expect(p.substitutionNote).toBe("Cliente A ha sustituido a Cliente B para esta propuesta.");
    expect(p.originLabel).toBe("Operador");

    // La proyección y el rastro cuentan la MISMA historia, que es la prueba de
    // que no hay un segundo estado guardado que pueda divergir.
    const ev = await ultimaSustitucion(app);
    expect(ev?.entryId).toBe("wl-f01");
    expect(ev?.text).toContain("Un operador ha propuesto a Cliente A en lugar de Cliente B");

    await app.close();
  });

  it("A→B→A→B: la cadena sigue nombrando al desplazado del ÚLTIMO acto, nunca al del primero", async () => {
    const app = await demoConPropuestaAutomatica();

    await sustituir(app, "wl-f02"); // A → B
    let p = await propuesta(app);
    expect([p.clientLabel, p.substitutedFromClientLabel]).toEqual(["Cliente B", "Cliente A"]);

    await sustituir(app, "wl-f01"); // B → A
    p = await propuesta(app);
    expect([p.clientLabel, p.substitutedFromClientLabel]).toEqual(["Cliente A", "Cliente B"]);

    await sustituir(app, "wl-f02"); // A → B otra vez
    p = await propuesta(app);
    expect([p.clientLabel, p.substitutedFromClientLabel]).toEqual(["Cliente B", "Cliente A"]);
    expect(p.substitutionNote).toBe("Cliente B ha sustituido a Cliente A para esta propuesta.");

    // Tres actos de sustitución en el rastro, ni uno perdido ni uno inventado,
    // y cada uno nombrando a su pareja real.
    const sustituciones = await sustitucionesEnElRastro(app);
    expect(sustituciones.map((e) => e.entryId)).toEqual(["wl-f02", "wl-f01", "wl-f02"]);
    expect(sustituciones.map((e) => (e.text as string).split(" para el hueco")[0])).toEqual([
      "Un operador ha propuesto a Cliente B en lugar de Cliente A",
      "Un operador ha propuesto a Cliente A en lugar de Cliente B",
      "Un operador ha propuesto a Cliente B en lugar de Cliente A",
    ]);

    await app.close();
  });

  it("cadena con TRES personas distintas: A→B→G→A nombra en cada paso a quien acaba de perder la propuesta", async () => {
    const app = await demoConPropuestaAutomatica();

    // Una tercera persona compatible con el mismo hueco, dada de alta por la
    // ruta real de la consola: sin ella la cadena sólo podría ir y venir entre
    // dos, y «A ha sustituido a B» podría acertar por simetría en vez de por
    // leer el último acto.
    const alta = await post(app, "/api/waitlist/entries", {
      clientLabel: "Cliente G",
      serviceId: 1,
      dateFrom: "2026-08-04",
      dateTo: "2026-08-04",
      earliestStartMinutes: 13 * 60,
      latestStartMinutes: 14 * 60,
      professional: { kind: "any" },
      optInSource: "operator_entered",
      optInConfirmed: true,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const nuevaId = ((JSON.parse(alta.body) as Json).entry as Json).id as string;

    await sustituir(app, "wl-f02"); // A → B
    let p = await propuesta(app);
    expect([p.clientLabel, p.substitutedFromClientLabel]).toEqual(["Cliente B", "Cliente A"]);

    await sustituir(app, nuevaId); // B → G
    p = await propuesta(app);
    expect([p.clientLabel, p.substitutedFromClientLabel]).toEqual(["Cliente G", "Cliente B"]);
    expect(p.substitutionNote).toBe("Cliente G ha sustituido a Cliente B para esta propuesta.");

    await sustituir(app, "wl-f01"); // G → A, cerrando el círculo sobre la automática
    p = await propuesta(app);
    expect([p.clientLabel, p.substitutedFromClientLabel]).toEqual(["Cliente A", "Cliente G"]);
    expect(p.substitutionNote).toBe("Cliente A ha sustituido a Cliente G para esta propuesta.");

    await app.close();
  });

  it("una propuesta que nunca se sustituyó no inventa desplazado, y aprobarla tampoco lo inventa", async () => {
    const app = await demoConPropuestaAutomatica();

    const aprobada = await post(app, "/api/waitlist/entries/wl-f01/command", {
      command: "approve_proposal",
      slotKey: HUECO_A_LA_UNA,
    });
    expect(aprobada.statusCode).toBe(200);

    const p = await propuesta(app);
    expect(p.statusCode).toBe("approved");
    expect(p.substitutedFromClientLabel).toBeNull();
    expect(p.substitutionNote).toBeNull();
    expect(p.originLabel).toBe("Sistema");
    expect(await ultimaSustitucion(app)).toBeUndefined();

    await app.close();
  });
});
