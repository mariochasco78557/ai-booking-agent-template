import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { SUMMARY_COPY, SUMMARY_DISCLAIMERS, GUIDE_COPY } from "../../src/console/demoWorkspace.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID, DANI_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, FakeElement } from "./fakeDom.js";

/**
 * step 19 · Capacidad 3A — «Resumen para revisar con Bruno» (design §5.2).
 *
 * Cubre: cada una de las 27 medidas se mueve SÓLO cuando se mueve su fuente
 * canónica; la regla dura de que A4/B9/C4 nunca se suman; el rótulo
 * permanente estático, carácter a carácter; el texto copiado (reloj
 * sintético + aviso); el barrido negativo de vocabulario prohibido en las
 * MEDIDAS (no en los avisos, que declaran a propósito la ausencia de
 * latencia — ver el comentario de la prueba); el respaldo de copia y la
 * regla dura de `writeText` síncrono; y la limpieza del reinicio.
 */

const TEST_SALT = "resumen-bruno-test-salt";

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

async function reset(app: FastifyInstance): Promise<void> {
  expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
}

async function snapshotOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}

async function demoOf(app: FastifyInstance): Promise<Json> {
  return (await snapshotOf(app)).demo as Json;
}

async function summaryOf(app: FastifyInstance): Promise<Json> {
  return (await demoOf(app)).summary as Json;
}

function measuresOf(summary: Json): Json[] {
  return (summary.blocks as Json[]).flatMap((b) => b.measures as Json[]);
}

function measureById(summary: Json, id: string): Json {
  const m = measuresOf(summary).find((x) => x.id === id);
  expect(m, `no existe la medida ${id}`).toBeDefined();
  return m as Json;
}

async function cancel(app: FastifyInstance, reservationId: string, reasonCode = "unspecified") {
  return post(
    app,
    `/api/reservations/${reservationId}/cancel`,
    { reasonCode, confirmed: true },
    { "idempotency-key": `cancel:${reservationId}` },
  );
}

async function command(app: FastifyInstance, entryId: string, cmd: string, slotKey?: string) {
  return post(app, `/api/waitlist/entries/${entryId}/command`, {
    command: cmd,
    ...(slotKey !== undefined ? { slotKey } : {}),
  });
}

async function convert(app: FastifyInstance, entryId: string, slotKey: string) {
  return post(
    app,
    `/api/waitlist/entries/${entryId}/convert`,
    { slotKey, confirmed: true },
    { "idempotency-key": `convert:${entryId}:${slotKey}` },
  );
}

async function advanceMinutes(app: FastifyInstance, minutes: number) {
  return post(app, "/api/lab/clock/advance", { command: "advance_minutes", minutes });
}

async function claveDeAnotacion(app: FastifyInstance, reservationId: string): Promise<string> {
  const snap = await snapshotOf(app);
  const fila = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === reservationId);
  return String((fila as Json).noShowKeyToMint);
}

async function claveDeCorreccion(app: FastifyInstance, reservationId: string): Promise<string> {
  const snap = await snapshotOf(app);
  const fila = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === reservationId);
  return String((fila as Json).noShowFixKeyToMint);
}

async function anotarInasistencia(app: FastifyInstance, reservationId: string) {
  return post(app, `/api/reservations/${reservationId}/no-show`, { confirmed: true }, { "idempotency-key": await claveDeAnotacion(app, reservationId) });
}

async function corregirInasistencia(app: FastifyInstance, reservationId: string) {
  return post(
    app,
    `/api/reservations/${reservationId}/no-show/correction`,
    { confirmed: true },
    { "idempotency-key": await claveDeCorreccion(app, reservationId) },
  );
}

interface LineaDeGrupo {
  memberLabel: string;
  serviceId: 0 | 1 | 2;
  employeeId: number;
  startMinutes: number;
}

async function crearGrupo(app: FastifyInstance, lines: readonly LineaDeGrupo[], key: string, arrangement: "consecutive" | "simultaneous" = "consecutive") {
  return post(
    app,
    "/api/booking/groups",
    { arrangement, date: BOOKING_DEMO_TODAY, lines, confirmed: true },
    { "idempotency-key": key },
  );
}

/** El recorrido de `tareasHumanas.test.ts`: cancelar demo-salon-res-2 (13:00) libera un hueco compatible con wl-f01. */
async function driveWaitlistConversion(app: FastifyInstance): Promise<void> {
  const res = await cancel(app, "demo-salon-res-2");
  const body = res.json() as Json;
  const slotKey = ((body.releasedSlots as Json[])[0] as Json).key as string;
  // (step 23, R2) Una persona aprueba la propuesta de ESE hueco antes de que
  // se pueda simular ningún aviso.
  expect((await command(app, "wl-f01", "approve_proposal", slotKey)).statusCode).toBe(200);
  expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
  expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
  expect((await convert(app, "wl-f01", slotKey)).statusCode).toBe(200);
}

// =====================================================================
// (a) Cada medida sale de su fuente canónica: manipular el estado y
// comprobar que la cifra se mueve — y sólo ella.
// =====================================================================

describe("step 19 · Capacidad 3A — cada medida se mueve SÓLO cuando se mueve su fuente canónica", () => {
  it("Bloque A: callsHandled/callsWithOutcome/resolvedWithoutHumanInterruption/bookingsCreated/technicalErrors/staffInterruptions se leen literalmente de metrics", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(app, "/api/scenario/run", {
      scenarioId: "A50-resumen-bruno",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "tuesday",
          time: "15:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const snap = await snapshotOf(app);
    const metrics = snap.metrics as Json;
    const summary = snap.demo as Json;
    const s = (summary.summary as Json);
    expect(measureById(s, "A1").value).toBe(metrics.callsHandled);
    expect(measureById(s, "A2").value).toBe(metrics.callsWithOutcome);
    expect(measureById(s, "A3").value).toBe(metrics.resolvedWithoutHumanInterruption);
    expect(measureById(s, "A4").value).toBe(metrics.bookingsCreated);
    expect(measureById(s, "A5").value).toBe(metrics.technicalErrors);
    expect(measureById(s, "A6").value).toBe(metrics.pendingHumanTasks);
    expect(measureById(s, "A7").value).toBe(metrics.staffInterruptions);
    expect(measureById(s, "A8").value).toBe((snap.availabilityQueries as Json[]).length);
    await app.close();
  });

  it("A4 sube en 1 exactamente con una llamada que reserva, y ninguna otra medida de reservas se mueve por ella", async () => {
    const app = freshApp();
    await reset(app);
    const antes = await summaryOf(app);
    const res = await post(app, "/api/scenario/run", {
      scenarioId: "A51-resumen-bruno-reserva",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "tuesday",
          time: "16:00",
          professionalId: DANI_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const despues = await summaryOf(app);
    expect(measureById(despues, "A4").value).toBe((measureById(antes, "A4").value as number) + 1);
    expect(measureById(despues, "B9").value).toBe(measureById(antes, "B9").value);
    expect(measureById(despues, "C4").value).toBe(measureById(antes, "C4").value);
    await app.close();
  });

  it("Bloque B: cancellationsOnTime (B3) sube con una cancelación a tiempo, y slotsReleasedWithoutCompatibles (B7) sube cuando nadie encaja", async () => {
    const app = freshApp();
    await reset(app);
    const antes = await summaryOf(app);
    // demo-salon-res-4 (Dani, servicio 0 «Barba», 11:30-12:00): ningún alta de la
    // demostración pide ese servicio a esa hora — cero compatibles — y se
    // cancela con 150 minutos de antelación (>= 120 por defecto): a tiempo.
    const res = await cancel(app, "demo-salon-res-4");
    expect(res.statusCode).toBe(200);
    const despues = await summaryOf(app);
    expect(measureById(despues, "B3").value).toBe((measureById(antes, "B3").value as number) + 1);
    expect(measureById(despues, "B4").value).toBe(measureById(antes, "B4").value); // B4 no se mueve por una cancelación a tiempo
    expect(measureById(despues, "B5").value).toBe((measureById(antes, "B5").value as number) + 1);
    expect(measureById(despues, "B7").value).toBe((measureById(antes, "B7").value as number) + 1);
    expect(measureById(despues, "B6").value).toBe(measureById(antes, "B6").value); // B6 no se mueve: nadie encajaba
    await app.close();
  });

  it("B9 (reservas desde la lista de espera) sube SÓLO con una conversión real, y A4/C4 no se mueven por ella", async () => {
    const app = freshApp();
    await reset(app);
    const antes = await summaryOf(app);
    await driveWaitlistConversion(app);
    const despues = await summaryOf(app);
    expect(measureById(despues, "B9").value).toBe((measureById(antes, "B9").value as number) + 1);
    expect(measureById(despues, "A4").value).toBe(measureById(antes, "A4").value);
    expect(measureById(despues, "C4").value).toBe(measureById(antes, "C4").value);
    await app.close();
  });

  it("Bloque C: C2 (avances del reloj), C1 (frase de inasistencias) y C3-C7 (grupos) se derivan de operations.metrics", async () => {
    const app = freshApp();
    await reset(app);
    expect((await advanceMinutes(app, 60)).statusCode).toBe(200);
    expect((await anotarInasistencia(app, "demo-salon-res-1")).statusCode).toBe(201);
    expect((await corregirInasistencia(app, "demo-salon-res-1")).statusCode).toBe(200);

    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
    ];
    const creada = await crearGrupo(app, lineas, "resumen-bruno:grupo:1", "consecutive");
    expect(creada.statusCode).toBe(201);
    const grupo = (creada.json() as Json);
    const primeraLinea = (grupo.reservations as Json[])[0] as Json;

    const snap = await snapshotOf(app);
    const ops = snap.operations as Json;
    const s = (snap.demo as Json).summary as Json;
    expect(measureById(s, "C1").valueLabel).toBe(ops.metrics && (ops.metrics as Json).recordedAndCorrectedLine);
    expect(measureById(s, "C2").value).toBe((ops.metrics as Json).clockAdvances);
    expect(measureById(s, "C3").value).toBe(1);
    expect(measureById(s, "C4").value).toBe(2);
    expect(measureById(s, "C5").value).toBe(1);
    expect(measureById(s, "C6").value).toBe(0);
    expect(measureById(s, "C7").value).toBe(0);

    // Se cancela una de las dos citas del grupo: pasa a "parcialmente cancelado".
    expect((await cancel(app, String(primeraLinea.id))).statusCode).toBe(200);
    const snap2 = await snapshotOf(app);
    const s2 = (snap2.demo as Json).summary as Json;
    expect(measureById(s2, "C5").value).toBe(0);
    expect(measureById(s2, "C6").value).toBe(1);
    expect(measureById(s2, "C7").value).toBe(0);
    // C3/C4 (cuántos grupos, cuántas citas) no cambian por cancelar una línea.
    expect(measureById(s2, "C3").value).toBe(1);
    expect(measureById(s2, "C4").value).toBe(2);
    await app.close();
  });
});

// =====================================================================
// (b) La regla dura: A4/B9/C4 nunca se suman
// =====================================================================

describe("step 19 · Capacidad 3A — regla dura: A4, B9 y C4 nunca se suman", () => {
  it("las 27 medidas están todas presentes, en tres bloques, y ninguna es un total conjunto de reservas", async () => {
    const app = freshApp();
    await reset(app);
    // Se mueven las tres cifras de reservas a la vez, para que un total
    // conjunto (si existiera) fuera detectable.
    await driveWaitlistConversion(app);
    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 16 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 + 30 },
    ];
    expect((await crearGrupo(app, lineas, "regla-dura:grupo:1")).statusCode).toBe(201);
    expect(
      (
        await post(app, "/api/scenario/run", {
          scenarioId: "A52-regla-dura",
          turns: [
            { utterance: "quiero reservar una cita", day: "tuesday", time: "16:30", professionalId: DANI_ID, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true },
          ],
        })
      ).statusCode,
    ).toBe(200);

    const s = await summaryOf(app);
    const measures = measuresOf(s);
    expect(measures.map((m) => m.id).sort()).toEqual(
      [
        "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8",
        "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12",
        "C1", "C2", "C3", "C4", "C5", "C6", "C7",
      ].sort(),
    );
    const a4 = measureById(s, "A4").value as number;
    const b9 = measureById(s, "B9").value as number;
    const c4 = measureById(s, "C4").value as number;
    expect(a4).toBeGreaterThan(0);
    expect(b9).toBeGreaterThan(0);
    expect(c4).toBeGreaterThan(0);
    const sumaProhibida = a4 + b9 + c4;
    // Ninguna medida numérica coincide con la suma prohibida.
    for (const m of measures) {
      if (typeof m.value === "number") expect(m.value).not.toBe(sumaProhibida);
    }
    // Y el texto copiado no contiene ninguna cadena de total conjunto.
    expect((s.copyText as string).toLowerCase()).not.toMatch(/reservas? totales?/);
    await app.close();
  });

  it("A4 vive en el bloque «llamadas», B9 en «espera» y C4 en «operaciones» — nunca en el mismo bloque", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    const blocks = s.blocks as Json[];
    const blockOf = (id: string) => (blocks.find((b) => (b.measures as Json[]).some((m) => m.id === id)) as Json).id;
    expect(blockOf("A4")).toBe("llamadas");
    expect(blockOf("B9")).toBe("espera");
    expect(blockOf("C4")).toBe("operaciones");
    await app.close();
  });

  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo M1a.)* Antes de esta prueba, una mutación que AÑADIERA un campo
   * nuevo a `DemoSummaryView` (por ejemplo un `reservationsGrandTotal`) no la
   * habría hecho fallar: ninguna prueba fijaba la lista EXACTA de claves.
   */
  it("(M1a) DemoSummaryView expone EXACTAMENTE estas nueve claves — un campo nuevo la rompe a la vista", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    expect(Object.keys(s).sort()).toEqual(
      [
        "permanentLabel",
        "clockLine",
        "fixtureLine",
        "blocks",
        "disclaimers",
        "reservationsNote",
        "copyText",
        "copyStampPrefix",
        "copyStampSuffix",
      ].sort(),
    );
    await app.close();
  });

  /**
   * *(Añadido 2026-08-06 tras revisión adversarial de misión completa,
   * hallazgo MEDIO 2.)* Las pruebas (M1b/R1, M1c, más abajo) usan
   * `SUMMARY_COPY.reservationsNote`/`.reservationsSumWarning` como las
   * FRASES PERMITIDAS que excluyen del barrido léxico y numérico — pero
   * nunca comprobaban que esas dos constantes dijeran, de verdad, lo que
   * el §8.5 normativo del diseño exige, carácter a carácter. La exclusión
   * era, hasta ahora, auto-referencial: si alguien invirtiera el sentido de
   * la frase (por ejemplo, «Estas tres cifras SÍ se suman…»), el barrido de
   * abajo seguiría excluyéndola sin fallar — una frase que AFIRMA la suma
   * prohibida pasaría disfrazada de negación conocida. Se fijan aquí, ANTES
   * de usarse como exclusión, contra el texto literal del diseño
   * ((internal doc, not included in the template) §8.5,
   * líneas 3013 y 3026).
   */
  it("(MEDIO 2) reservationsNote y reservationsSumWarning coinciden, carácter a carácter, con el §8.5 normativo — antes de usarse como exclusión de ningún barrido", () => {
    expect(SUMMARY_COPY.reservationsNote).toBe(
      "Estas tres cifras no se suman: dicen cosas distintas y sumarlas daría un número que no significa nada.",
    );
    expect(SUMMARY_COPY.reservationsSumWarning).toBe(
      "Las tres cifras de reservas de este resumen —creadas por una llamada (A4), nacidas de la lista de espera (B9) y citas dentro de reservas para varias personas (C4)— no se suman: dicen cosas distintas y sumarlas daría un número que no significa nada.",
    );
    // Las dos, de verdad, NIEGAN la suma — no la afirman. Una prueba que
    // sólo comparara el texto contra sí mismo no detectaría una frase
    // invertida que declarara SUMAR: esta comprobación léxica sí lo hace.
    expect(SUMMARY_COPY.reservationsNote).toMatch(/no se suman/);
    expect(SUMMARY_COPY.reservationsSumWarning).toMatch(/no se suman/);
    expect(SUMMARY_COPY.reservationsNote).not.toMatch(/\bsí se suman\b/i);
    expect(SUMMARY_COPY.reservationsSumWarning).not.toMatch(/\bsí se suman\b/i);
  });

  /**
   * *(Añadido 2026-08-05 tras re-verificación adversarial de la capacidad 3,
   * hallazgo R1.)* M1a sólo fijaba las claves de `DemoSummaryView` — un nivel
   * por debajo de `snap.demo`. Una mutación que añadiera un campo nuevo a
   * `DemoWorkspaceView` (por ejemplo `reservationsGrandTotal`, UN nivel por
   * ENCIMA de `summary`) pasaba el conjunto entero de la suite. Se fijan aquí
   * las claves de `snap.demo` y, dentro de él, las de cada `DemoGuideView` y
   * cada `DemoGuideStepView` — los otros dos niveles del árbol donde un campo
   * nuevo podría colarse sin que ninguna prueba lo notara.
   */
  it("(R1) snap.demo, cada DemoGuideView y cada DemoGuideStepView exponen EXACTAMENTE sus claves declaradas — un campo nuevo en cualquier nivel se detecta", async () => {
    const app = freshApp();
    await reset(app);
    const demo = await demoOf(app);
    // ENSANCHAMIENTO DELIBERADO (2026-08-06, step 20 D20-54, hallazgo R4-4).
    // El taller de decisiones con Bruno añade el QUINTO campo autorizado de
    // `demo`: `decisionWorkshop` (diseño §2.3/§6.1). Se añade el nombre a la
    // lista y NADA más: la aserción sigue siendo de igualdad exacta, sigue
    // siendo cerrada y un sexto campo la seguiría rompiendo.
    expect(Object.keys(demo).sort()).toEqual(["startingPoint", "summary", "guides", "taskLedger", "decisionWorkshop"].sort());

    const guides = demo.guides as Json[];
    expect(guides.length).toBe(2);
    for (const guide of guides) {
      expect(Object.keys(guide).sort()).toEqual(
        ["id", "title", "steps", "checkableCount", "doneCount", "progressLine"].sort(),
      );
      for (const step of guide.steps as Json[]) {
        // ENMIENDA DELIBERADA (revisión adversarial de la capacidad 3,
        // hallazgo M2). Un campo nuevo, `numberLabel` — la numeración del
        // runbook ("1.2", "1.A"…) de la que ahora se compone `stepTitleLine`,
        // en vez de `order` (un correlativo interno). No se afloja la
        // aserción: sigue fijando el conjunto EXACTO de claves.
        expect(Object.keys(step).sort()).toEqual(
          ["id", "order", "numberLabel", "title", "stepTitleLine", "cue", "whereLabel", "whereHref", "linkLabel", "evidenceState", "evidenceLabel"].sort(),
        );
      }
    }
    await app.close();
  });

  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo M1b; ampliado el mismo día tras re-verificación adversarial,
   * hallazgo R1.)* La primera redacción sólo comprobaba que ninguna MEDIDA
   * numérica coincidiera con la suma prohibida, y sólo barría
   * `valueLabel`/`copyText` — nunca `snap.demo` entero. Una mutación que
   * añadiera, UN NIVEL POR ENCIMA de `summary` (en `DemoWorkspaceView`), un
   * campo `reservationsGrandTotal` con la suma, habría pasado: no vive en
   * ningún `valueLabel` ni en `copyText`, así que el barrido original nunca
   * lo habría visto. Aquí se construye un mundo donde A4/B9/C4 son
   * distintas, no nulas, y su suma (12) no coincide con ninguna otra cifra
   * del resumen NI con ningún `order`/`checkableCount`/`doneCount` de paso
   * de guion (el mayor de todos ellos es 11) — y se barre
   * `JSON.stringify(demo)` ENTERO buscando esa suma como número AISLADO,
   * excluyendo sólo las frases que ya existen y que NIEGAN la suma.
   */
  it("(M1b/R1) con A4/B9/C4 distintas y su suma sin colisión (12, mayor que cualquier order de paso): la suma no aparece como número aislado en NINGÚN punto de snap.demo", async () => {
    const app = freshApp();
    await reset(app);

    // A4 = 3 (tres llamadas que reservan, en huecos libres de sobra).
    const llamadas: Array<[string, number]> = [["14:00", ALEX_ID], ["14:30", DANI_ID], ["15:00", 9]];
    for (let i = 0; i < llamadas.length; i += 1) {
      const [time, professionalId] = llamadas[i] as [string, number];
      const res = await post(app, "/api/scenario/run", {
        scenarioId: `A6${String(i)}-suma-${time.replace(":", "")}`,
        turns: [{ utterance: "quiero reservar una cita", day: "tuesday", time, professionalId, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true }],
      });
      expect(res.statusCode).toBe(200);
    }

    // B9 = 2 (dos conversiones reales, dos entradas y dos huecos distintos).
    const c1 = await cancel(app, "demo-salon-res-2");
    expect(c1.statusCode).toBe(200);
    const slot1 = ((c1.json() as Json).releasedSlots as Json[])[0]?.key as string;
    expect((await command(app, "wl-f01", "approve_proposal", slot1)).statusCode).toBe(200); // (step 23, R2)
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
    expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
    expect((await convert(app, "wl-f01", slot1)).statusCode).toBe(200);

    const c2 = await cancel(app, "demo-salon-res-1");
    expect(c2.statusCode).toBe(200);
    const slot2 = ((c2.json() as Json).releasedSlots as Json[])[0]?.key as string;
    expect((await command(app, "wl-f05", "approve_proposal", slot2)).statusCode).toBe(200); // (step 23, R2)
    expect((await command(app, "wl-f05", "simulate_notice")).statusCode).toBe(200);
    expect((await command(app, "wl-f05", "record_acceptance")).statusCode).toBe(200);
    expect((await convert(app, "wl-f05", slot2)).statusCode).toBe(200);

    // C4 = 7 (tres grupos: 2 + 2 + 3 citas, las siete en pie).
    const grupo1: LineaDeGrupo[] = [
      { memberLabel: "Persona 1", serviceId: 1, employeeId: ALEX_ID, startMinutes: 16 * 60 },
      { memberLabel: "Persona 2", serviceId: 1, employeeId: DANI_ID, startMinutes: 16 * 60 + 30 },
    ];
    expect((await crearGrupo(app, grupo1, "suma-r1:grupo:1")).statusCode).toBe(201);
    const grupo2: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 15 * 60 },
      { memberLabel: "Adulto B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 },
    ];
    expect((await crearGrupo(app, grupo2, "suma-r1:grupo:2", "simultaneous")).statusCode).toBe(201);
    const grupo3: LineaDeGrupo[] = [
      { memberLabel: "Menor A", serviceId: 1, employeeId: 9, startMinutes: 11 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: 9, startMinutes: 11 * 60 + 30 },
      { memberLabel: "Menor C", serviceId: 1, employeeId: 9, startMinutes: 12 * 60 },
    ];
    expect((await crearGrupo(app, grupo3, "suma-r1:grupo:3")).statusCode).toBe(201);

    const demo = await demoOf(app);
    const s = demo.summary as Json;
    const a4 = measureById(s, "A4").value as number;
    const b9 = measureById(s, "B9").value as number;
    const c4 = measureById(s, "C4").value as number;
    expect(a4).toBe(3);
    expect(b9).toBe(2);
    expect(c4).toBe(7);
    expect(new Set([a4, b9, c4]).size).toBe(3); // las tres, distintas entre sí
    const suma = a4 + b9 + c4;
    expect(suma).toBe(12);
    // Mayor que el "order" más alto de cualquier paso de guion (11): así la
    // aparición de la suma como número aislado no puede confundirse con un
    // número de paso legítimo dentro de snap.demo.guides.
    const ordenMaximo = Math.max(...(demo.guides as Json[]).flatMap((g) => (g.steps as Json[]).map((st) => Number(st.order))));
    expect(ordenMaximo).toBeLessThan(suma);

    const measures = measuresOf(s);
    for (const m of measures) {
      if (typeof m.value === "number") expect(m.value, `${String(m.id)} coincide con la suma prohibida`).not.toBe(suma);
    }

    // El barrido de verdad: ni un solo valueLabel, ni el texto copiado, dicen
    // la suma como número AISLADO. `\b` no separa dígitos contiguos (todos
    // son \w), así que "12" no colisiona con "112" o "120".
    const patronSuma = new RegExp(`\\b${String(suma)}\\b`);
    for (const m of measures) {
      expect(String(m.valueLabel), `${String(m.id)}.valueLabel contiene la suma prohibida`).not.toMatch(patronSuma);
    }
    expect(s.copyText as string, "copyText contiene la suma prohibida como número aislado").not.toMatch(patronSuma);

    // (R1) El barrido AMPLIADO: snap.demo ENTERO, no sólo el resumen — una
    // mutación que añadiera la suma en cualquier otro rincón del árbol
    // (guides, startingPoint, taskLedger, o un campo nuevo en cualquiera de
    // ellos) se detecta aquí. Las únicas exclusiones son las frases YA
    // EXISTENTES que niegan la suma a propósito.
    const negaciones = [SUMMARY_COPY.reservationsSumWarning, SUMMARY_COPY.reservationsNote, "esa cifra es la de al lado, y las dos juntas son siempre el total de huecos liberados"];
    let textoDemo = JSON.stringify(demo);
    for (const negacion of negaciones) textoDemo = textoDemo.split(negacion).join("");
    expect(textoDemo, "snap.demo (fuera de las negaciones conocidas) contiene la suma prohibida como número aislado").not.toMatch(patronSuma);
    await app.close();
  });

  /**
   * *(Corregido 2026-08-06 tras revisión adversarial de misión completa,
   * hallazgo ALTO 2.)* La comprobación anterior decía que una coincidencia
   * estaba permitida si `frase.includes(coincidencia)` — si la PALABRA
   * encontrada era una subcadena de alguna frase permitida. Para una palabra
   * corriente como «total» eso es casi siempre cierto (las dos frases
   * permitidas de abajo CONTIENEN la palabra «total»), así que la
   * comprobación pasaba para CUALQUIER aparición de «total» en cualquier
   * parte del texto barrido, viniera o no de dentro de una frase permitida:
   * una guarda vacía por construcción, que ninguna frase inyectada podía
   * hacer fallar. Se compara POSICIÓN, no pertenencia léxica: una
   * coincidencia sólo está permitida si su span (inicio, fin) cae DENTRO de
   * un span real donde el texto barrido contiene, carácter a carácter, una
   * de las frases permitidas.
   */
  function dentroDeFrasePermitida(texto: string, inicio: number, fin: number, permitidas: readonly string[]): boolean {
    return permitidas.some((frase) => {
      let desde = 0;
      let pos = texto.indexOf(frase, desde);
      while (pos !== -1) {
        if (inicio >= pos && fin <= pos + frase.length) return true;
        desde = pos + 1;
        pos = texto.indexOf(frase, desde);
      }
      return false;
    });
  }

  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo M1c; reparado 2026-08-06 tras revisión adversarial de misión
   * completa, hallazgo ALTO 2.)* La prueba original sólo buscaba
   * `/reservas? totales?/`. Se amplía el barrido léxico con las palabras que
   * de verdad delatarían un total conjunto — excluyendo, a propósito, las
   * frases que ya existen y que NIEGAN la suma (la nota de A4/B9/C4, y "esa
   * cifra es la de al lado... total de huecos liberados" de B7, que sí
   * describe una suma legítima y distinta — B6+B7=B5, no una regla dura de
   * esta misión).
   */
  it("(M1c) barrido léxico ampliado: ni «total», ni «en total», ni «suma», ni «juntas» aparecen afirmando un total conjunto de reservas", async () => {
    const app = freshApp();
    await reset(app);
    await driveWaitlistConversion(app);
    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX_ID, startMinutes: 16 * 60 },
      { memberLabel: "Menor B", serviceId: 1, employeeId: DANI_ID, startMinutes: 15 * 60 + 30 },
    ];
    expect((await crearGrupo(app, lineas, "m1c:grupo:1")).statusCode).toBe(201);
    expect(
      (
        await post(app, "/api/scenario/run", {
          scenarioId: "A65-m1c-barrido",
          turns: [{ utterance: "quiero reservar una cita", day: "tuesday", time: "16:30", professionalId: DANI_ID, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true }],
        })
      ).statusCode,
    ).toBe(200);

    const s = await summaryOf(app);
    const texto = s.copyText as string;
    // Las únicas apariciones toleradas de estas palabras son las frases que
    // ya declaran, expresamente, que algo NO se suma o que es un desglose
    // legítimo de un total DISTINTO de la regla dura (B6+B7=B5).
    const permitidas = [
      SUMMARY_COPY.reservationsSumWarning,
      "esa cifra es la de al lado, y las dos juntas son siempre el total de huecos liberados",
    ];
    for (const palabra of [/total/i, /en total/i, /\bsuma(n|r)?\b/i, /juntas/i]) {
      const regexGlobal = new RegExp(palabra.source, `${palabra.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = regexGlobal.exec(texto)) !== null) {
        const coincidencia = m[0];
        const inicio = m.index;
        const fin = inicio + coincidencia.length;
        const contexto = texto.slice(Math.max(0, inicio - 5), fin + 80);
        const esPermitida = dentroDeFrasePermitida(texto, inicio, fin, permitidas);
        expect(esPermitida, `«${coincidencia}» en la posición ${String(inicio)} no cae dentro de ninguna frase permitida: …${contexto}…`).toBe(true);
      }
    }
    await app.close();
  });

  /**
   * *(Añadido 2026-08-06 tras revisión adversarial de misión completa,
   * hallazgo ALTO 2.)* El caso negativo que SOBREVIVÍA hoy: con la
   * comprobación anterior (`frase.includes(coincidencia)`), inyectar esta
   * frase en `copyText` no hacía fallar la prueba de arriba, porque «total»
   * y «suman» son subcadenas de las frases permitidas — en cualquier
   * posición del documento. Con la comprobación por POSICIÓN, la misma
   * frase inyectada, que no coincide caracter a carácter con ninguna frase
   * permitida en esa posición del texto, se detecta.
   */
  it("(ALTO 2) el barrido corregido SÍ detecta una frase inyectada que afirma el total prohibido — el caso que la versión anterior dejaba pasar", () => {
    const permitidas = [
      SUMMARY_COPY.reservationsSumWarning,
      "esa cifra es la de al lado, y las dos juntas son siempre el total de huecos liberados",
    ];
    const fraseInyectada = "Las tres cifras de reservas se suman y dan el total conjunto de la demostracion.";
    const textoMutado = `Cabecera de prueba. ${fraseInyectada} Pie de prueba.`;
    for (const palabra of [/total/i, /\bsuma(n|r)?\b/i]) {
      const regexGlobal = new RegExp(palabra.source, `${palabra.flags}g`);
      let m: RegExpExecArray | null;
      let vistaAlgunaVez = false;
      while ((m = regexGlobal.exec(textoMutado)) !== null) {
        vistaAlgunaVez = true;
        const inicio = m.index;
        const fin = inicio + m[0].length;
        expect(
          dentroDeFrasePermitida(textoMutado, inicio, fin, permitidas),
          `«${m[0]}» de la frase inyectada, en la posición ${String(inicio)}, no debería caer dentro de ninguna frase permitida`,
        ).toBe(false);
      }
      expect(vistaAlgunaVez, `el patrón ${palabra.source} no encontró ninguna coincidencia en la frase inyectada`).toBe(true);
    }
  });

  /**
   * *(Añadido 2026-08-06 tras revisión adversarial de misión completa,
   * hallazgo BAJO 3.)* (M1c) sólo barre `copyText`. Una palabra de la
   * familia «total»/«suma»/«juntas» metida en `label`, `increasesWhen` o
   * `doesNotIncreaseWhen` de CUALQUIER medida —no sólo A4/B9/C4— no pasaba
   * por ningún barrido léxico: el numérico de (M1b/R1) sólo caza un NÚMERO
   * aislado, nunca una palabra sin él. Se extiende el mismo barrido léxico
   * de (M1c) a los tres campos de las 27 medidas, con las frases YA
   * EXISTENTES que niegan la suma —las de A4, B7, B9 y C4— como únicas
   * excepciones conocidas.
   */
  it("(BAJO 3) el barrido léxico también cubre label/increasesWhen/doesNotIncreaseWhen de las 27 medidas, no sólo copyText", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    const permitidas = [
      "No sube por una reserva recuperada de la lista de espera ni por una creada a mano por un operador: esas tienen sus propias cifras, más abajo, y nunca se suman con ésta.", // A4
      "No sube cuando al menos una persona sí encaja: esa cifra es la de al lado, y las dos juntas son siempre el total de huecos liberados.", // B7
      "No sube por una reserva de una llamada ni por una creada a mano para varias personas: esas tienen sus propias cifras, y las tres nunca se suman.", // B9
      "No sube por una reserva de una llamada ni por una recuperada de la lista de espera: esas tienen sus propias cifras, y las tres nunca se suman.", // C4
    ];
    for (const m of measuresOf(s)) {
      const texto = `${String(m.label)} ${String(m.increasesWhen)} ${String(m.doesNotIncreaseWhen)}`;
      for (const palabra of [/total/i, /en total/i, /\bsuma(n|r)?\b/i, /juntas/i]) {
        const regexGlobal = new RegExp(palabra.source, `${palabra.flags}g`);
        let mm: RegExpExecArray | null;
        while ((mm = regexGlobal.exec(texto)) !== null) {
          const inicio = mm.index;
          const fin = inicio + mm[0].length;
          const contexto = texto.slice(Math.max(0, inicio - 5), fin + 80);
          expect(
            dentroDeFrasePermitida(texto, inicio, fin, permitidas),
            `${String(m.id)}: «${mm[0]}» aparece sin ser una negación conocida: …${contexto}…`,
          ).toBe(true);
        }
      }
    }
    await app.close();
  });
});

// =====================================================================
// (c) Barrido negativo de vocabulario prohibido — sobre las MEDIDAS, no
// sobre los avisos (que declaran a propósito la ausencia de latencia,
// §8.5: «Ninguna medida de latencia…» contiene la palabra a propósito).
// =====================================================================

describe("step 19 · Capacidad 3A — barrido negativo: ninguna medida es un porcentaje, una latencia, dinero o un objetivo", () => {
  it("ninguna label/valueLabel de una medida contiene %, €, «objetivo», «latencia», «tasa», «ranking» ni «umbral»", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    const prohibidas = ["%", "€", "objetivo", "latencia", "tasa", "ranking", "umbral", "puntuación", "porcentaje"];
    for (const m of measuresOf(s)) {
      for (const palabra of prohibidas) {
        expect(String(m.label).toLowerCase(), `${String(m.id)}.label contiene "${palabra}"`).not.toContain(palabra);
        expect(String(m.valueLabel).toLowerCase(), `${String(m.id)}.valueLabel contiene "${palabra}"`).not.toContain(palabra);
      }
    }
    await app.close();
  });
});

// =====================================================================
// (d) El rótulo permanente: estático, y carácter a carácter
// =====================================================================

describe("step 19 · Capacidad 3A — el rótulo permanente es HTML estático y coincide carácter a carácter", () => {
  it("el HTML servido lleva el rótulo, sin que JavaScript lo pinte", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(SUMMARY_COPY.permanentLabel);
    // ENMIENDA DELIBERADA (revisión adversarial de la capacidad 3, hallazgo
    // m5). Vivía en un <p class="tx-panel--notice">, sin `.tx-panel` — el
    // único de los cuatro usos de ese modificador que no lo tiene, así que
    // se quedaba sin el padding que `.tx-panel` aporta a los otros tres y el
    // texto tocaba el borde. Ahora vive en `.tx-permanent-label`, la clase
    // que añade la reparación con su propia caja (padding + radio).
    expect(html).toContain(`<p class="tx-permanent-label">${SUMMARY_COPY.permanentLabel}</p>`);
  });

  it("nunca aparece pintado también por JavaScript (no hay una segunda fuente que pudiera divergir)", () => {
    const js = renderConsoleAppJs();
    expect(js).not.toContain(SUMMARY_COPY.permanentLabel);
  });
});

// =====================================================================
// (d bis) Otras cadenas de SUMMARY_COPY que sólo viven como HTML estático o
// literal ya escrito en ui.js.ts — comprobadas byte a byte, mismo patrón que
// el rótulo permanente (revisión adversarial de la capacidad 3, hallazgo M3)
// =====================================================================

describe("step 19 · Capacidad 3A — el resto de SUMMARY_COPY que vive por duplicado, comprobado byte a byte", () => {
  it("heading/note/copyButtonLabel existen, tal cual, en el HTML servido", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(SUMMARY_COPY.heading);
    expect(html).toContain(SUMMARY_COPY.note);
    expect(html).toContain(SUMMARY_COPY.copyButtonLabel);
  });

  it("definitionSummary/copiedStatus/fallbackStatus existen, tal cual, en el JavaScript servido (donde el cliente los escribe, uno por cada medida o desde el manejador de copiar)", () => {
    const js = renderConsoleAppJs();
    expect(js).toContain(`'${SUMMARY_COPY.definitionSummary}'`);
    expect(js).toContain(`'${SUMMARY_COPY.copiedStatus}'`);
    expect(js).toContain(`'${SUMMARY_COPY.fallbackStatus}'`);
  });
});

// =====================================================================
// (d ter) GUIDE_COPY: idéntico tratamiento — hallazgo M3
// =====================================================================

describe("step 19 · Capacidad 3B — GUIDE_COPY que vive como HTML estático, comprobado byte a byte", () => {
  it("el aviso de reinicio (resetWarning) nace visible en el HTML servido — ya no lo pinta JavaScript (hallazgo m4)", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(GUIDE_COPY.resetWarning);
    expect(html).toContain(`id="lab-guion-aviso"`);
    const js = renderConsoleAppJs();
    expect(js).not.toContain(GUIDE_COPY.resetWarning);
  });

  /**
   * (revisión adversarial de la capacidad 3, hallazgos M3/m6/m7) Ninguna de
   * las tres lleva ya `role`/`aria-live` — no son el resultado de una acción
   * que inicia el operador (§9.5) — y el aviso estático usa el tono ámbar de
   * "conflicto" (`--conflict`), no rojo de "error": nada está roto.
   */
  it("#lab-guion-aviso, #lab-guion-precondicion y #lab-guion-progreso ya no llevan role/aria-live, y el aviso usa el tono de conflicto (ámbar), no de error (rojo)", () => {
    const html = renderConsoleHtml();
    for (const id of ["lab-guion-aviso", "lab-guion-precondicion", "lab-guion-progreso"]) {
      const inicio = html.indexOf(`id="${id}"`);
      const aperturaEtiqueta = html.lastIndexOf("<p", inicio);
      const etiqueta = html.slice(aperturaEtiqueta, html.indexOf(">", inicio) + 1);
      expect(etiqueta, `${id} no debería llevar role`).not.toContain("role=");
      expect(etiqueta, `${id} no debería llevar aria-live`).not.toContain("aria-live");
    }
    const avisoIdx = html.indexOf('id="lab-guion-aviso"');
    const avisoApertura = html.lastIndexOf("<p", avisoIdx);
    const avisoEtiqueta = html.slice(avisoApertura, html.indexOf(">", avisoIdx) + 1);
    expect(avisoEtiqueta).toContain("tx-status-line--conflict");
    expect(avisoEtiqueta).not.toContain("tx-status-line--error");
  });

  it("goToResetLabel/chooseGuideLegend/noneChosen/hardNote existen, tal cual, en el HTML servido", () => {
    const html = renderConsoleHtml();
    expect(html).toContain(GUIDE_COPY.goToResetLabel);
    expect(html).toContain(GUIDE_COPY.chooseGuideLegend);
    expect(html).toContain(GUIDE_COPY.noneChosen);
    expect(html).toContain(GUIDE_COPY.hardNote);
  });

  it("el catálogo ya NO declara pillDone/pillNotYet/pillNotCheckable: eran muertas y su formato divergía del DOM real (hallazgo M3)", () => {
    expect(Object.keys(GUIDE_COPY)).not.toContain("pillDone");
    expect(Object.keys(GUIDE_COPY)).not.toContain("pillNotYet");
    expect(Object.keys(GUIDE_COPY)).not.toContain("pillNotCheckable");
  });

  it("linkPrefix SÍ viaja de verdad ahora, dentro de step.linkLabel — no es una copia muerta", async () => {
    const app = freshApp();
    await reset(app);
    const demo = (await snapshotOf(app)).demo as Json;
    const g1 = (demo.guides as Json[])[0] as Json;
    const paso = (g1.steps as Json[])[0] as Json;
    expect(paso.linkLabel).toBe(`${GUIDE_COPY.linkPrefix}${String(paso.whereLabel)}`);
    await app.close();
  });
});

// =====================================================================
// (e) El texto copiado: reloj sintético + aviso, sin rama ni commit
// =====================================================================

describe("step 19 · Capacidad 3A — el texto copiado lleva el reloj sintético y el aviso, y nunca rama ni commit", () => {
  it("contiene el reloj de la demostración, el fixture y el bloque sintético íntegro", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    const texto = s.copyText as string;
    expect(texto).toContain("Resumen de la demostración de Demo Salon");
    expect(texto).toContain("Reloj de la demostración: martes 4 de agosto de 2026, 09:00.");
    expect(texto).toContain("Fixture de demostración: Demo Salon, temporada de agosto de 2026 (09:00–17:30), tres profesionales sintéticos.");
    expect(texto).toContain("TODO LO DE ABAJO ES SINTÉTICO");
    for (const linea of SUMMARY_DISCLAIMERS) expect(texto).toContain(linea);
    await app.close();
  });

  it("el reloj avanzado dice «movido +N por una persona», nunca «por ti»", async () => {
    const app = freshApp();
    await reset(app);
    expect((await advanceMinutes(app, 60)).statusCode).toBe(200);
    const s = await summaryOf(app);
    expect(s.clockLine).toBe("Reloj de la demostración: martes 4 de agosto de 2026, 10:00 (movido +1 h por una persona).");
    expect(s.copyText as string).toContain("movido +1 h por una persona");
    expect(s.copyText as string).not.toContain("por ti");
  });

  it("no lleva ninguna cadena de rama ni de commit (git, branch, sha, commit)", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    const texto = (s.copyText as string).toLowerCase();
    for (const prohibido of ["branch", "commit", "sha", "git"]) expect(texto).not.toContain(prohibido);
    await app.close();
  });
});

// =====================================================================
// (f) «Copiar resumen»: writeText síncrono, sin red, con respaldo accesible
// =====================================================================

const RESUMEN_IDS = [
  "lab-resumen-reloj",
  "lab-resumen-fixture",
  { id: "lab-resumen-bloques", tag: "div" },
  { id: "lab-resumen-copiar", tag: "button" },
  "lab-resumen-copiar-estado",
  { id: "lab-resumen-respaldo", tag: "textarea" },
] as const;

/**
 * Todo lo que `renderLaboratorio` toca ANTES de su primer `return` de guarda
 * (el de `#lab-waitlist-lista`, ausente a propósito aquí): los dos paneles
 * de esta capacidad, más `lab-eventos-*`/`lab-auditoria-*`/`lab-json`, que
 * `renderLaboratorio` no protege con un `if (!x) return` propio — exactamente
 * el mismo patrón que ya usa `tareasHumanas.test.ts` (`LABORATORIO_IDS`).
 */
const LABORATORIO_MIN_IDS = [
  ...RESUMEN_IDS,
  "lab-guion-aviso",
  "lab-guion-precondicion",
  { id: "lab-guion-ir-a-reiniciar", tag: "button" },
  { id: "lab-guion-radio-1", tag: "input" },
  { id: "lab-guion-radio-2", tag: "input" },
  "lab-guion-sin-elegir",
  { id: "lab-guion-contenido", tag: "div" },
  "lab-guion-titulo",
  { id: "lab-guion-pasos", tag: "ol" },
  "lab-guion-progreso",
  { id: "lab-eventos-pilot", tag: "dl" },
  { id: "lab-eventos-internal", tag: "dl" },
  "lab-auditoria-vacio",
  { id: "lab-auditoria-lista", tag: "ul" },
  { id: "lab-json", tag: "pre" },
  { id: "tx-view-title", tag: "h1" },
  "tx-freshness",
  "inicio-ruta-desconocida",
] as const;

describe("step 19 · Capacidad 3A — «Copiar resumen»: estrategia y respaldo (§5.2.6)", () => {
  it("writeText se llama de forma SÍNCRONA dentro del manejador del clic: nada de fetch/await/.then ANTES de la llamada", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("function wireResumenOwnerControls");
    expect(inicio).toBeGreaterThan(-1);
    const fin = js.indexOf("\n  function ", inicio + 10);
    const cuerpo = js.slice(inicio, fin === -1 ? undefined : fin);
    const idxWriteText = cuerpo.indexOf("navigator.clipboard.writeText(");
    expect(idxWriteText).toBeGreaterThan(-1);
    const antes = cuerpo.slice(0, idxWriteText);
    expect(antes).not.toContain("fetch(");
    expect(antes).not.toContain(".then(");
    expect(antes).not.toContain("await ");
    // Y nunca toISOString(): la hora del sello es LOCAL, formateada a mano.
    expect(cuerpo).not.toContain("toISOString(");
    // Tampoco ninguna variante UTC (revisión adversarial de la capacidad 3,
    // hallazgo m3): getUTCFullYear/getUTCHours/etc. devolverían la hora en
    // UTC bajo un rótulo que promete hora LOCAL — el mismo defecto que
    // toISOString(), con otro nombre. Sólo getHours/getMinutes (y sus
    // hermanos de fecha) locales.
    expect(cuerpo).not.toContain("getUTC");
  });

  it("sin navigator.clipboard (el stub por defecto de las pruebas), la rama de respaldo rellena el <textarea>, ya seleccionado, y lo dice", async () => {
    const app = freshApp();
    await reset(app);
    const { document, nodes } = createFakeDocumentWithIds([...LABORATORIO_MIN_IDS]);
    const win = { location: { hash: "#/laboratorio" }, scrollTo: () => undefined };
    // UNA sola instancia de hooks: `latestSnapshot` es una variable de
    // módulo, y dos llamadas a `loadUiClientHooks` crean dos cierres
    // INDEPENDIENTES que no comparten nada entre sí.
    const hooks = loadUiClientHooks("#/laboratorio", document, win);
    hooks.applyRoute();
    hooks.wireResumenOwnerControls();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      const res = await app.inject({ method: "GET", url: "/api/snapshot" });
      return { json: () => Promise.resolve(res.json()) };
    }) as unknown as typeof fetch;
    try {
      await hooks.refresh();
    } finally {
      globalThis.fetch = original;
    }
    (nodes["lab-resumen-copiar"] as FakeElement).dispatchClick();
    const respaldo = nodes["lab-resumen-respaldo"] as FakeElement;
    expect(respaldo.hidden).toBe(false);
    expect(respaldo.value).toContain("Resumen de la demostración de Demo Salon");
    expect(respaldo.value).toMatch(/Sello de copia: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(hora local de este ordenador\)\. Sólo dice cuándo se copió; no mide nada\./);
    expect(nodes["lab-resumen-copiar-estado"]?.textContent).toBe(
      "Tu navegador no ha dejado copiar. El texto está aquí abajo, entero y ya seleccionado: cópialo con Cmd+C.",
    );
  });

  /**
   * *(Añadido 2026-08-05 tras revisión adversarial de la capacidad 3,
   * hallazgo m5.)* Hasta ahora sólo se probaba el camino de RESPALDO (sin
   * `navigator.clipboard`, el `{}` por defecto de `loadUiClientHooks`). El
   * camino de ÉXITO — el que de verdad usa un navegador con portapapeles —
   * no tenía ninguna prueba propia.
   */
  it("con navigator.clipboard.writeText resolviendo: UN sello, el estado dice «copiado» en tono ok, y el respaldo queda oculto", async () => {
    const app = freshApp();
    await reset(app);
    const { document, nodes } = createFakeDocumentWithIds([...LABORATORIO_MIN_IDS]);
    const win = { location: { hash: "#/laboratorio" }, scrollTo: () => undefined };
    let escrito: string | null = null;
    const nav = { clipboard: { writeText: (texto: string) => { escrito = texto; return Promise.resolve(); } } };
    const hooks = loadUiClientHooks("#/laboratorio", document, win, nav);
    hooks.applyRoute();
    hooks.wireResumenOwnerControls();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      const res = await app.inject({ method: "GET", url: "/api/snapshot" });
      return { json: () => Promise.resolve(res.json()) };
    }) as unknown as typeof fetch;
    try {
      await hooks.refresh();
    } finally {
      globalThis.fetch = original;
    }
    (nodes["lab-resumen-copiar"] as FakeElement).dispatchClick();
    await new Promise((r) => setTimeout(r, 0));

    expect(escrito).not.toBeNull();
    const texto = escrito as unknown as string;
    expect(texto).toContain("Resumen de la demostración de Demo Salon");
    // UN solo sello, justo detrás de la línea del fixture (§5.2.7).
    const lineas = texto.split("\n");
    const iFixture = lineas.findIndex((l) => l.startsWith("Fixture de demostración"));
    expect(iFixture).toBeGreaterThan(-1);
    expect(lineas[iFixture + 1]).toMatch(/^Sello de copia: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(hora local de este ordenador\)\. Sólo dice cuándo se copió; no mide nada\.$/);
    expect(lineas.filter((l) => l.startsWith("Sello de copia")).length).toBe(1);

    const estadoEl = nodes["lab-resumen-copiar-estado"] as FakeElement;
    expect(estadoEl.textContent).toBe("Resumen copiado al portapapeles.");
    expect(estadoEl.className).toContain("tx-status-line--ok");
    expect((nodes["lab-resumen-respaldo"] as FakeElement).hidden).toBe(true);
  });

  it("prohibido en los dos caminos: ningún fetch/XMLHttpRequest dentro del manejador de copiar", () => {
    const js = renderConsoleAppJs();
    const inicio = js.indexOf("function wireResumenOwnerControls");
    const fin = js.indexOf("\n  function ", inicio + 10);
    const cuerpo = js.slice(inicio, fin === -1 ? undefined : fin);
    expect(cuerpo).not.toContain("fetch(");
    expect(cuerpo).not.toContain("XMLHttpRequest");
    expect(cuerpo).not.toContain("localStorage");
  });
});

// =====================================================================
// (g) El reinicio limpia el estado de copiado y el respaldo (§5.2.6, M2)
// =====================================================================

describe("step 19 · Capacidad 3A — el reinicio vacía y vuelve a ocultar el respaldo, y limpia el mensaje de copiado", () => {
  it("limpiarRespaldoDeCopiaDelResumen vacía el valor y vuelve a ocultar el <textarea>", () => {
    const { document, nodes } = createFakeDocumentWithIds([...RESUMEN_IDS]);
    const { limpiarRespaldoDeCopiaDelResumen } = loadUiClientHooks("", document);
    const respaldo = nodes["lab-resumen-respaldo"] as FakeElement;
    respaldo.value = "algo que ya no es cierto";
    respaldo.hidden = false;
    limpiarRespaldoDeCopiaDelResumen();
    expect(respaldo.value).toBe("");
    expect(respaldo.hidden).toBe(true);
  });

  it("'lab-resumen-copiar-estado' está en REGIONES_TRANSITORIAS", () => {
    const { REGIONES_TRANSITORIAS } = loadUiClientHooks();
    expect(REGIONES_TRANSITORIAS).toContain("lab-resumen-copiar-estado");
  });
});

// =====================================================================
// (h) esMedidaDeReservas — la nota de A4/B9/C4 va con las tres, y sólo ellas
// =====================================================================

describe("step 19 · Capacidad 3A — esMedidaDeReservas identifica EXACTAMENTE A4, B9 y C4", () => {
  it("A4/B9/C4 sí, y ninguna otra medida", () => {
    const { esMedidaDeReservas } = loadUiClientHooks();
    expect(esMedidaDeReservas("A4")).toBe(true);
    expect(esMedidaDeReservas("B9")).toBe(true);
    expect(esMedidaDeReservas("C4")).toBe(true);
    for (const otra of ["A1", "A8", "B1", "B12", "C1", "C7"]) expect(esMedidaDeReservas(otra)).toBe(false);
  });
});

// =====================================================================
// (i) Cada medida lleva su definición desplegable (dos frases)
// =====================================================================

describe("step 19 · Capacidad 3A — cada una de las 27 medidas lleva sus dos frases («Sube cuando…»/«No sube cuando…»)", () => {
  it("increasesWhen y doesNotIncreaseWhen existen y no están vacías, para las 27", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    const measures = measuresOf(s);
    expect(measures.length).toBe(27);
    for (const m of measures) {
      expect(typeof m.increasesWhen).toBe("string");
      expect((m.increasesWhen as string).length).toBeGreaterThan(0);
      expect(typeof m.doesNotIncreaseWhen).toBe("string");
      expect((m.doesNotIncreaseWhen as string).length).toBeGreaterThan(0);
    }
    await app.close();
  });
});

// =====================================================================
// (k) El <details> "Qué NO sale en este resumen" lleva las TRES filas que
// faltaban (revisión adversarial de la capacidad 3, hallazgo m6)
// =====================================================================

describe("step 19 · Capacidad 3A — el <details> de omisiones completa las tres filas de §5.2.3 que faltaban", () => {
  it("nombra unfilledReleasedSlotMinutes, actionsRequiringAPerson y las alarmas de integridad, dentro del <details> de omisiones", () => {
    const html = renderConsoleHtml();
    const inicio = html.indexOf("Qué NO sale en este resumen");
    expect(inicio).toBeGreaterThan(-1);
    const fin = html.indexOf("</details>", inicio);
    const cuerpo = html.slice(inicio, fin);
    expect(cuerpo).toContain("unfilledReleasedSlotMinutes");
    expect(cuerpo).toContain("actionsRequiringAPerson");
    expect(cuerpo.toLowerCase()).toContain("alarmas de integridad");
  });
});

// =====================================================================
// (l) A6: "se cierran solos" corregido a "tienen camino de cierre"
// (revisión adversarial de la capacidad 3, hallazgo m8, alineado con §7.6)
// =====================================================================

describe("step 19 · Capacidad 3A — A6 ya no dice que las tareas «se cierran solas»: las cierra una acción real del operador", () => {
  it("doesNotIncreaseWhen de A6 dice «tienen camino de cierre», nunca «se cierran solos»", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    const a6 = measureById(s, "A6");
    expect(a6.doesNotIncreaseWhen).toContain("tienen camino de cierre");
    expect(a6.doesNotIncreaseWhen).not.toContain("se cierran solos");
  });
});

// =====================================================================
// (m) B11 sólo cuenta repeticiones idempotentes de la LISTA DE ESPERA —
// nunca las de inasistencias ni de grupo (revisión adversarial de la
// capacidad 3, hallazgo M4; probeta u4)
// =====================================================================

describe("step 19 · Capacidad 3A — B11 está acotado a la lista de espera, por rótulo y por definición", () => {
  it("el rótulo y las dos frases nombran 'la lista de espera' explícitamente", async () => {
    const app = freshApp();
    await reset(app);
    const s = await summaryOf(app);
    const b11 = measureById(s, "B11");
    expect(b11.label).toContain("lista de espera");
    expect(b11.increasesWhen).toContain("LISTA DE ESPERA");
    expect(b11.doesNotIncreaseWhen).toContain("inasistencia");
    expect(b11.doesNotIncreaseWhen).toContain("reserva para varias personas");
    await app.close();
  });

  it("una repetición idempotente de anotar una inasistencia, y otra de crear un grupo, no mueven B11 (probeta u4)", async () => {
    const app = freshApp();
    await reset(app);
    // El grupo se crea ANTES de mover el reloj: a las 16:00 sigue siendo
    // futuro y el hueco está libre.
    const lineas: LineaDeGrupo[] = [
      { memberLabel: "Persona 1", serviceId: 1, employeeId: ALEX_ID, startMinutes: 16 * 60 },
      { memberLabel: "Persona 2", serviceId: 0, employeeId: ALEX_ID, startMinutes: 16 * 60 + 30 },
    ];
    expect((await crearGrupo(app, lineas, "m4-b11-grupo-1")).statusCode).toBe(201);
    const repetido = await crearGrupo(app, lineas, "m4-b11-grupo-1");
    expect(repetido.statusCode).toBe(200);
    expect(repetido.headers["idempotency-status"]).toBe("re-executed");

    expect((await advanceMinutes(app, 60)).statusCode).toBe(200);
    const claveNoShow = await claveDeAnotacion(app, "demo-salon-res-1");
    const r1 = await post(app, "/api/reservations/demo-salon-res-1/no-show", { confirmed: true }, { "idempotency-key": claveNoShow });
    expect(r1.statusCode).toBe(201);
    const r2 = await post(app, "/api/reservations/demo-salon-res-1/no-show", { confirmed: true }, { "idempotency-key": claveNoShow });
    expect(r2.statusCode).toBe(201);
    expect(r2.headers["idempotency-status"]).toBe("replayed");

    const s = await summaryOf(app);
    expect(measureById(s, "B11").value).toBe(0);
    await app.close();
  });
});

// =====================================================================
// (j) Fronteras (§10.1) — demoWorkspace.ts se somete voluntariamente a la
// misma regla que tests/callEngine/boundaries.test.ts, exactamente como
// availabilityExplorer.ts (tests/console/exploradorHuecos.test.ts).
// =====================================================================

describe("step 19 · Capacidad 3 — demoWorkspace.ts se somete a las mismas fronteras que el motor", () => {
  const source = readFileSync(join(process.cwd(), "src", "console", "demoWorkspace.ts"), "utf8");
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("ningún Date.now(), Math.random(), randomUUID() ni 'new Date()' a pelo", () => {
    expect(codeOnly).not.toContain("Date.now(");
    expect(codeOnly).not.toContain("Math.random(");
    expect(codeOnly).not.toContain("randomUUID(");
    expect(/new\s+Date\s*\(\s*\)/.test(codeOnly)).toBe(false);
  });

  it("ningún temporizador ni llamada de red", () => {
    expect(codeOnly).not.toContain("setTimeout(");
    expect(codeOnly).not.toContain("setInterval(");
    expect(codeOnly).not.toContain("fetch(");
  });

  it("pura y de solo lectura: ninguna mutación de store/waitlist/operations/idempotency/clock", () => {
    // Formas de LLAMADA, no de lectura de un campo: "operations.clock.
    // advancedByMinutes" (una lectura legítima) NO debe casar con ninguna de
    // éstas.
    for (const prohibido of ["store.reset(", "waitlist.reset(", "operations.reset(", "idempotency.", "clock.advance("]) {
      expect(codeOnly, `aparece '${prohibido}'`).not.toContain(prohibido);
    }
  });
});
