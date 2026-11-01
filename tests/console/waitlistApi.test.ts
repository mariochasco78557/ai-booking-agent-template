import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { CONSOLE_HOST } from "../../src/console/config.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY, demoSalonVenue } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { PRECEDENCE_ORDER } from "../../src/callEngine/precedence.js";
import { INTERNAL_EVENT_NAMES, PILOT_EVENT_NAMES } from "../../src/callEngine/events/schema.js";
import { canonicalize, createIdempotencyStore, fingerprintRequest, IDEMPOTENCY_KEY_PATTERN } from "../../src/console/idempotency.js";
import {
  AVAILABLE_COMMANDS_BY_STATE,
  type WaitlistAuditEvent,
  type WaitlistEntryCommand,
  type WaitlistEntryState,
} from "../../src/callEngine/waitlist/model.js";
import {
  ACTIVITY_ITEMS_SHOWN,
  ACTIVITY_KINDS,
  auditText,
  buildWaitlistSnapshot,
  WAITLIST_COPY,
} from "../../src/console/waitlistSnapshot.js";
import type { WaitlistStoreSnapshot } from "../../src/callEngine/waitlist/store.js";
import { freshWaitlistEntries } from "../../src/callEngine/waitlist/fixture.js";

/**
 * step 17 · fase C — LA CAPA HTTP de la lista de espera.
 *
 * Recorre por `app.inject()` los diecisiete escenarios verificables de forma
 * automática del §10 (el 18 es de navegador real y sólo lo puede firmar el
 * runbook) y los criterios de aceptación 4, 7, 8, 9, 11, 12, 16, 17, 18 y 25
 * del §12. Los criterios 1, 2, 3, 5, 6, 10 y 14 viven en las dos suites de
 * dominio (`tests/callEngine/waitlist*.test.ts`).
 */

const TEST_SALT = "waitlist-test-salt";

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

type Json = Record<string, unknown>;

async function post(app: FastifyInstance, url: string, payload: unknown, headers?: Record<string, string>) {
  return app.inject({ method: "POST", url, payload: payload as never, ...(headers !== undefined ? { headers } : {}) });
}

async function snapshotOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}

async function waitlistOf(app: FastifyInstance): Promise<Json> {
  return (await snapshotOf(app)).waitlist as Json;
}

/** La demo empieza SIEMPRE por un reset explícito, como exige la precondición común del §10. */
async function reset(app: FastifyInstance): Promise<void> {
  const res = await post(app, "/api/reset", {});
  expect(res.statusCode).toBe(200);
}

async function cancel(app: FastifyInstance, reservationId: string, reasonCode = "unspecified") {
  return post(
    app,
    `/api/reservations/${reservationId}/cancel`,
    { reasonCode, confirmed: true },
    { "idempotency-key": `cancel:${reservationId}` },
  );
}

async function command(app: FastifyInstance, entryId: string, cmd: WaitlistEntryCommand, slotKey?: string) {
  return post(app, `/api/waitlist/entries/${entryId}/command`, {
    command: cmd,
    ...(slotKey !== undefined ? { slotKey } : {}),
  });
}

/**
 * (step 23, R2) El paso humano que faltaba: antes de simular ningún aviso una
 * persona tiene que APROBAR la propuesta de ESE hueco. No relaja ninguna
 * aserción — añade el acto que el bucle humano exige — y falla ruidosamente si
 * el servidor lo rechaza, para que ningún recorrido se lo salte sin enterarse.
 */
async function approve(app: FastifyInstance, entryId: string, slotKey: string) {
  const res = await command(app, entryId, "approve_proposal", slotKey);
  expect(res.statusCode, `no se pudo aprobar la propuesta de ${entryId}: ${res.body}`).toBe(200);
  return res;
}

async function convert(app: FastifyInstance, entryId: string, slotKey: string, extra: Json = {}, key?: string) {
  return post(
    app,
    `/api/waitlist/entries/${entryId}/convert`,
    { slotKey, confirmed: true, ...extra },
    { "idempotency-key": key ?? `convert:${entryId}:${slotKey}` },
  );
}

function entryOf(waitlist: Json, id: string): Json | undefined {
  return (waitlist.entries as Json[]).find((e) => e.id === id);
}

function slotOf(waitlist: Json, key: string): Json | undefined {
  return (waitlist.releasedSlots as Json[]).find((s) => s.key === key);
}

function auditKinds(waitlist: Json): string[] {
  return (waitlist.audit as { items: { kind: string }[] }).items.map((i) => i.kind);
}

function taskIds(snap: Json): string[] {
  return ((snap.humanQueue as { tasks: { id: string }[] }).tasks ?? []).map((t) => t.id);
}

function openTasks(snap: Json): { id: string; reasonKind: string; open: boolean }[] {
  return (snap.humanQueue as { tasks: { id: string; reasonKind: string; open: boolean }[] }).tasks.filter((t) => t.open);
}

/** El recorrido completo hasta 'aceptada' sobre `wl-f01` y el hueco de las 13:00. */
async function driveToAccepted(app: FastifyInstance): Promise<string> {
  await cancel(app, "demo-salon-res-2");
  const wl = await waitlistOf(app);
  const slotKey = (entryOf(wl, "wl-f01")?.offer as Json | null)?.slotKey as string;
  expect(slotKey).toBe("slot-2026-08-04-780-3");
  await approve(app, "wl-f01", slotKey);
  expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);
  expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(200);
  return slotKey;
}

// =====================================================================
// §10 — los escenarios, uno a uno
// =====================================================================

describe("step 17 · §10.1 — rechazo de opt-in", () => {
  it("registra el 'no' sin crear ninguna entrada en la sombra", async () => {
    const app = freshApp();
    await reset(app);
    const antes = ((await waitlistOf(app)).entries as Json[]).length;

    const res = await post(app, "/api/waitlist/opt-in-declined", { clientLabel: "Cliente G" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.recorded).toBe(true);
    expect(typeof body.auditEventId).toBe("string");

    const wl = await waitlistOf(app);
    expect((wl.entries as Json[]).length).toBe(antes);
    expect(auditKinds(wl).filter((k) => k === "WAITLIST_OPT_IN_DECLINED").length).toBe(1);
    expect((wl.metrics as Json).waitlistOptInsDeclined).toBe(1);
    expect((wl.metrics as Json).waitlistOptInsRecorded).toBe(0);
    await app.close();
  });

  it("una etiqueta que no es 'Cliente X' se rechaza con 400: aquí no entra el nombre de nadie", async () => {
    const app = freshApp();
    await reset(app);
    for (const clientLabel of ["Marta", "Cliente Marta", "cliente A", "Cliente AB", ""]) {
      const res = await post(app, "/api/waitlist/opt-in-declined", { clientLabel });
      expect(res.statusCode, clientLabel).toBe(400);
    }
    await app.close();
  });

  // -------------------------------------------------------------------
  // Reparación de la revisión adversarial (defecto 3): el escáner heredado
  // sólo rechazaba teléfonos con `+` inicial y correos, así que un móvil
  // español de nueve dígitos entraba y se guardaba. Ahora se rechaza — y el
  // mensaje del 400 promete exactamente eso y nada más.
  // -------------------------------------------------------------------

  it("una nota con un móvil español de nueve dígitos se rechaza con 400 y no escribe nada", async () => {
    const app = freshApp();
    await reset(app);
    for (const note of [
      "llamar al 600123456",
      "prefiere que le llamen: 600 12 34 56",
      "tel 712-345-678 por la tarde",
      "escribir a persona@example.com",
      "llamar al +34600123456",
    ]) {
      const res = await post(app, "/api/waitlist/opt-in-declined", { clientLabel: "Cliente G", note });
      expect(res.statusCode, note).toBe(400);
      expect((res.json() as Json).error).toBe("La nota no puede contener datos personales (teléfonos ni correos electrónicos).");
    }
    const wl = await waitlistOf(app);
    expect(auditKinds(wl).filter((k) => k === "WAITLIST_OPT_IN_DECLINED").length).toBe(0);
    await app.close();
  });

  it("una nota limpia se acepta con 200, y no aparece en ninguna parte de /api/snapshot", async () => {
    const app = freshApp();
    await reset(app);
    const note = "dijo que este mes no le viene bien";
    const res = await post(app, "/api/waitlist/opt-in-declined", { clientLabel: "Cliente G", note });
    expect(res.statusCode).toBe(200);
    // Ni en el propio cuerpo de respuesta.
    expect(JSON.stringify(res.json())).not.toContain(note);

    // Se guarda en el registro técnico, pero la instantánea que sirve a la
    // pantalla no la lleva: el texto del evento se genera del catálogo
    // cerrado del §7.1 y no incluye la nota.
    const snap = await snapshotOf(app);
    expect(JSON.stringify(snap)).not.toContain(note);
    expect(JSON.stringify(snap)).not.toContain("este mes no le viene bien");
    const wl = snap.waitlist as Json;
    expect(auditKinds(wl).filter((k) => k === "WAITLIST_OPT_IN_DECLINED").length).toBe(1);
    await app.close();
  });

  it("una fecha ISO en la nota no se confunde con un teléfono: la regla está anclada a nueve dígitos que empiezan por 6-9", async () => {
    const app = freshApp();
    await reset(app);
    for (const note of ["vuelve después del 2026-08-04", "prefiere las 09:30", "quedan 120 minutos de plazo"]) {
      const res = await post(app, "/api/waitlist/opt-in-declined", { clientLabel: "Cliente G", note });
      expect(res.statusCode, note).toBe(200);
    }
    await app.close();
  });
});

describe("step 17 · §10.2 — alta con opt-in explícito", () => {
  it("crea la entrada en 'Pendiente' y deja su evento en el registro", async () => {
    const app = freshApp();
    await reset(app);
    const res = await post(app, "/api/waitlist/entries", {
      clientLabel: "Cliente H",
      serviceId: 1,
      dateFrom: "2026-08-05",
      dateTo: "2026-08-05",
      earliestStartMinutes: 600,
      latestStartMinutes: 720,
      professional: { kind: "any" },
      optInSource: "phone_simulated",
      optInConfirmed: true,
    });
    expect(res.statusCode).toBe(201);
    const entry = (res.json() as Json).entry as Json;
    expect(entry.id).toBe("wl-0001");
    expect(entry.state).toBe("pending");
    expect(entry.stateLabel).toBe("Pendiente");
    expect(entry.optInLabel).toBe("Alta tomada por teléfono (simulada)");
    // (Reparación R2-UX, defecto 2) La frase ya no puede leerse como una cita
    // de dos horas: dice la DURACIÓN del servicio y, aparte, la VENTANA que la
    // persona acepta. Y los tres hechos viajan además por separado, para que
    // la pantalla no tenga que trocear una frase ya compuesta.
    expect(entry.preferenceSummary).toBe(
      "Corte de pelo (30 min) · el miércoles 5 de agosto · Disponible entre las 10:00 y las 12:00 · Cualquier profesional",
    );
    expect(entry.serviceLabel).toBe("Corte de pelo");
    expect(entry.serviceDurationLabel).toBe("30 min");
    expect(entry.availabilityWindowLabel).toBe("Disponible entre las 10:00 y las 12:00");
    expect(entry.professionalLabel).toBe("Cualquier profesional");
    // La ventana NO es la duración: 120 minutos de ventana, 30 de servicio.
    expect(entry.preferenceSummary).not.toContain("de 10:00 a 12:00");
    // (step 23 §5) `take_over_proposal` se ofrece también desde 'pendiente'.
    expect(entry.availableCommands).toEqual(["withdraw", "expire_manually", "take_over_proposal"]);

    const wl = await waitlistOf(app);
    expect(auditKinds(wl)).toContain("WAITLIST_ENTRY_CREATED");
    expect((wl.metrics as Json).waitlistOptInsRecorded).toBe(1);
    await app.close();
  });

  it("sin `optInConfirmed: true` la petición NO se puede hacer: el opt-in no es opcional", async () => {
    const app = freshApp();
    await reset(app);
    const base = {
      clientLabel: "Cliente H",
      serviceId: 1,
      dateFrom: "2026-08-05",
      dateTo: "2026-08-05",
      earliestStartMinutes: 600,
      latestStartMinutes: 720,
      professional: { kind: "any" },
      optInSource: "phone_simulated",
    };
    expect((await post(app, "/api/waitlist/entries", base)).statusCode).toBe(400);
    expect((await post(app, "/api/waitlist/entries", { ...base, optInConfirmed: false })).statusCode).toBe(400);
    // Y un campo de más tampoco cuela: los cuerpos son `.strict()`.
    expect((await post(app, "/api/waitlist/entries", { ...base, optInConfirmed: true, prioridad: 1 })).statusCode).toBe(400);
    expect(((await waitlistOf(app)).entries as Json[]).length).toBe(6);
    await app.close();
  });
});

describe("step 17 · §10.3 — profesional concreto", () => {
  it("sólo sale compatible quien pidió a esa persona; una entrada que pidió a otra NO aparece", async () => {
    const app = freshApp();
    await reset(app);
    // Una entrada que pide expresamente a Álex, en la misma franja que wl-f03.
    await post(app, "/api/waitlist/entries", {
      clientLabel: "Cliente H",
      serviceId: 1,
      dateFrom: BOOKING_DEMO_TODAY,
      dateTo: BOOKING_DEMO_TODAY,
      earliestStartMinutes: 720,
      latestStartMinutes: 780,
      professional: { kind: "specific", employeeId: ALEX_ID },
      optInSource: "counter_simulated",
      optInConfirmed: true,
    });

    const res = await cancel(app, "demo-salon-res-5");
    expect(res.statusCode).toBe(200);
    const matches = (res.json() as Json).matches as { slotKey: string; compatibleEntryIds: string[]; incompatible: { entryId: string; reasons: string[] }[] }[];
    expect(matches.length).toBe(1);
    expect(matches[0]?.compatibleEntryIds).toEqual(["wl-f03"]);
    expect(matches[0]?.incompatible.find((i) => i.entryId === "wl-0001")?.reasons).toContain("different_professional_requested");
    await app.close();
  });
});

describe("step 17 · §10.4 — «cualquiera» encaja con el profesional del hueco liberado", () => {
  it("wl-f01 sale compatible con Álex, que es de quien era la cita", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-2");
    const matches = (res.json() as Json).matches as { slotKey: string; compatibleEntryIds: string[] }[];
    expect(matches[0]?.compatibleEntryIds).toContain("wl-f01");

    const wl = await waitlistOf(app);
    const offer = entryOf(wl, "wl-f01")?.offer as Json;
    expect(offer.slotKey).toBe("slot-2026-08-04-780-3");
    expect(offer.slotLabel).toBe("martes 4 de agosto, 13:00–13:30, con Álex (sintético)");
    expect(offer.stillValid).toBe(true);
    expect(offer.invalidReasons).toEqual([]);
    await app.close();
  });
});

describe("step 17 · §10.5 — un hueco sin nadie que encaje", () => {
  it("libera el hueco, no crea NINGUNA tarea de decisión y trae la frase que lo dice", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-4");
    const body = res.json() as Json;
    const matches = body.matches as { compatibleEntryIds: string[] }[];
    expect((body.releasedSlots as Json[]).length).toBe(1);
    expect(matches[0]?.compatibleEntryIds).toEqual([]);
    expect(body.humanTaskIds).toEqual([]);

    const snap = await snapshotOf(app);
    expect(openTasks(snap).some((t) => t.reasonKind === "DECIDE_WAITLIST_MATCH")).toBe(false);
    const wl = snap.waitlist as Json;
    expect((wl.copy as Json).noneFit).toBe("Nadie de la lista encaja en este hueco.");
    const slot = (wl.releasedSlots as Json[])[0] as Json;
    expect(slot.decisionPending).toBe(false);
    expect(slot.compatibleEntryIds).toEqual([]);
    await app.close();
  });
});

describe("step 17 · §10.6 — un hueco con exactamente una persona compatible", () => {
  it("sale una sola entrada y se crea la tarea de decidir", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-5");
    const body = res.json() as Json;
    expect((body.matches as { compatibleEntryIds: string[] }[])[0]?.compatibleEntryIds).toEqual(["wl-f03"]);
    expect(body.humanTaskIds).toEqual(["decidir-hueco-slot-2026-08-04-750-9"]);

    const snap = await snapshotOf(app);
    const tarea = openTasks(snap).find((t) => t.reasonKind === "DECIDE_WAITLIST_MATCH");
    expect(tarea?.id).toBe("decidir-hueco-slot-2026-08-04-750-9");
    // Un compatible NO adjudica nada: sigue exigiendo aviso, aceptación y
    // conversión manuales (decisión J3).
    expect(entryOf(snap.waitlist as Json, "wl-f03")?.state).toBe("matched");
    await app.close();
  });
});

describe("step 17 · §10.7 — un hueco con varias personas compatibles", () => {
  it("dos huecos, dos compatibles en orden de creación, y la nota de orden de lectura", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-2");
    const body = res.json() as Json;
    const matches = body.matches as { slotKey: string; compatibleEntryIds: string[] }[];
    expect(matches.length).toBe(2);
    expect(matches[0]?.compatibleEntryIds).toEqual(["wl-f01", "wl-f02"]);
    expect(matches[1]?.compatibleEntryIds).toEqual(["wl-f01", "wl-f02"]);

    const wl = await waitlistOf(app);
    const slot = slotOf(wl, "slot-2026-08-04-780-3") as Json;
    expect(slot.readingOrderNote).toBe("Orden de lectura, no de prioridad.");
    expect(slot.decisionPending).toBe(true);
    // NI UNA CLAVE que insinúe prioridad, recomendación o preselección. Se
    // miran las CLAVES, no el texto: la frase que NIEGA la prioridad («orden
    // de lectura, no de prioridad») contiene la palabra a propósito.
    const clavesProhibidas = ["priority", "prioridad", "rank", "recommended", "recomendad", "preselected", "position", "score", "weight"];
    function claves(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(claves);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        for (const prohibido of clavesProhibidas) {
          expect(key.toLowerCase().includes(prohibido), `${key} → ${prohibido}`).toBe(false);
        }
        claves(child);
      }
    }
    claves(wl);
    // Y el orden que sí existe se llama `readingOrder`, nunca de otra forma.
    expect((wl.entries as Json[]).every((e) => typeof e.readingOrder === "number")).toBe(true);
    expect((wl.copy as Json).severalFit).toBe("Varias personas encajan en este hueco. Elige tú a quién se le ofrece.");
    // (step 23 §9) `systemChoseNobody` se RETIRÓ del contrato: desde esta
    // misión el sistema sí sugiere a alguien, y esa frase habría pasado a ser
    // falsa en la única tarjeta que la leía. Se comprueba que la clave ya no
    // viaja —dejarla sin usar sería guardar una promesa que no cumplimos— y
    // que las tres sustitutas sí lo hacen, con estas palabras exactas.
    expect(Object.keys(wl.copy as Json)).not.toContain("systemChoseNobody");
    expect((wl.copy as Json).proposalIsSuggestion).toBe(
      "Es una sugerencia del sistema, no una decisión. Nadie recibe este hueco hasta que una persona lo apruebe y avise.",
    );
    expect((wl.copy as Json).proposalReasonFifo).toBe("Primera persona compatible por orden de alta en lista.");
    expect((wl.copy as Json).proposalOperatorChoice).toBe(
      "Elegida por el operador. La persona que proponía el sistema sigue en la lista y puede quedarse con otro hueco.",
    );
    await app.close();
  });
});

describe("step 17 · §10.8 — cancelación dentro de plazo", () => {
  it("240 minutos de antelación, sin tarea de revisión, y la cita cancelada en LAS DOS proyecciones", async () => {
    const app = freshApp();
    await reset(app);
    // Primero una reserva creada por una llamada, para que la cita exista
    // también en el store y las dos proyecciones se puedan comparar de veras.
    const call = await post(app, "/api/scenario/run", {
      scenarioId: "A30-consola-reserva-para-cancelar",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "tuesday",
          time: "11:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    expect(call.statusCode).toBe(200);
    const created = (call.json() as Json).reservation as Json;
    expect(created).toBeDefined();

    const res = await cancel(app, created.id as string, "client_cancelled_by_phone_simulated");
    expect(res.statusCode).toBe(200);
    const cancellation = (res.json() as Json).cancellation as Json;
    expect(cancellation.timeliness).toBe("on_time");
    expect(cancellation.leadMinutes).toBe(120);
    expect(cancellation.reviewState).toBeUndefined();

    const snap = await snapshotOf(app);
    const enStore = (snap.reservations as Json[]).find((r) => r.id === created.id);
    const enCalendario = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === created.id);
    expect(enStore?.status).toBe("cancelled");
    expect(enCalendario?.status).toBe("cancelled");
    expect((enStore?.cancellation as Json).timelinessLabel).toBe("Cancelación dentro del plazo configurado");
    expect((enCalendario?.cancellation as Json).reasonLabel).toBe("El cliente canceló por teléfono (simulado)");
    expect(openTasks(snap).some((t) => t.reasonKind === "REVIEW_LATE_CANCELLATION")).toBe(false);
    await app.close();
  });

  it("240 minutos exactos sobre la cita de la fixture, tal y como dice §8.3", async () => {
    const app = freshApp();
    await reset(app);
    const cancellation = ((await cancel(app, "demo-salon-res-2")).json() as Json).cancellation as Json;
    expect(cancellation.leadMinutes).toBe(240);
    expect(cancellation.policyMinutesAtCancellation).toBe(120);
    expect(cancellation.timeliness).toBe("on_time");
    await app.close();
  });
});

describe("step 17 · §10.9 — cancelación fuera de plazo", () => {
  it("etiqueta, revisión pendiente y NINGUNA penalización: el hueco se libera igual y wl-f05 sale compatible", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-1", "client_cancelled_at_counter_simulated");
    const body = res.json() as Json;
    const cancellation = body.cancellation as Json;
    expect(cancellation.timeliness).toBe("late");
    expect(cancellation.leadMinutes).toBe(30);
    expect(cancellation.latenessKind).toBe("within_notice_window");
    expect(cancellation.reviewState).toBe("pending_review");
    expect((body.releasedSlots as Json[]).length).toBe(1);
    expect((body.matches as { compatibleEntryIds: string[] }[])[0]?.compatibleEntryIds).toEqual(["wl-f05"]);

    const snap = await snapshotOf(app);
    expect(openTasks(snap).some((t) => t.id === "revision-tardia-demo-salon-res-1")).toBe(true);
    const wl = snap.waitlist as Json;
    expect((wl.metrics as Json).lateCancellationsUnderReview).toBe(1);
    expect((wl.copy as Json).noPenalty).toContain("No se ha aplicado ninguna penalización");
    const registrada = (wl.cancellations as Json[])[0] as Json;
    expect(registrada.timelinessLabel).toBe("Cancelación fuera del plazo configurado");

    // La ÚNICA salida es «revisada, sin acción», y cierra su tarea.
    expect((await post(app, "/api/reservations/demo-salon-res-1/cancellation-review", { decision: "sancionar" })).statusCode).toBe(400);
    const revision = await post(app, "/api/reservations/demo-salon-res-1/cancellation-review", { decision: "reviewed_no_action" });
    expect(revision.statusCode).toBe(200);
    const despues = await snapshotOf(app);
    expect(openTasks(despues).some((t) => t.id === "revision-tardia-demo-salon-res-1")).toBe(false);
    expect(((despues.waitlist as Json).metrics as Json).lateCancellationsUnderReview).toBe(0);
    await app.close();
  });

  it("una cita que ya había empezado se etiqueta aparte, y tampoco tiene consecuencia", async () => {
    const app = freshApp();
    await reset(app);
    // A las 09:00 sintéticas, ninguna cita de la fixture ha empezado: se
    // mueve el plazo para llegar al caso por el camino real, cancelando una
    // cita futura con plazo 0 (dentro de plazo) y otra con plazo 1440.
    await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: 1440 });
    const res = await cancel(app, "demo-salon-res-2");
    const cancellation = (res.json() as Json).cancellation as Json;
    expect(cancellation.timeliness).toBe("late");
    expect(cancellation.latenessKind).toBe("within_notice_window");
    expect(cancellation.policyMinutesAtCancellation).toBe(1440);
    // Y el hueco se libera exactamente igual.
    expect((res.json() as Json).releasedSlots as Json[]).toHaveLength(2);
    await app.close();
  });
});

describe("step 17 · §10.10 — aviso simulado", () => {
  it("cambia el estado, escribe el evento con su noticeId y jamás dice que se ha enviado nada", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    await approve(app, "wl-f01", "slot-2026-08-04-780-3"); // (step 23, R2)
    const res = await command(app, "wl-f01", "simulate_notice");
    expect(res.statusCode).toBe(200);
    const entry = (res.json() as Json).entry as Json;
    expect(entry.state).toBe("notice_simulated");
    expect(entry.stateLabel).toBe("Aviso simulado");

    const wl = await waitlistOf(app);
    const evento = (wl.audit as { items: Json[] }).items.find((i) => i.kind === "WAITLIST_NOTICE_SIMULATED");
    expect(evento?.noticeId).toBe("aviso-wl-f01-1");
    expect(evento?.text).toBe("Aviso simulado a Cliente A por el hueco de las 13:00. No se ha enviado ningún mensaje.");
    expect(entryOf(wl, "wl-f01")?.trace).toMatchObject({ noticeId: "aviso-wl-f01-1", createdReservationId: null });
    expect((wl.copy as Json).simulatedNoticeOnly).toBe("Aviso simulado. No se ha enviado ningún mensaje ni se ha llamado a nadie.");

    // El verbo «enviar» no aparece jamás como una promesa en ningún texto
    // del bloque de lista de espera.
    const textos = (wl.audit as { items: { text: string }[] }).items.map((i) => i.text).join(" ");
    expect(/\bse ha enviado\b(?! ningún)/i.test(textos)).toBe(false);
    await app.close();
  });
});

describe("step 17 · §10.11 — conversión tras revalidación", () => {
  it("crea la reserva sintética, cierra la tarea del hueco y deja la traza completa", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveToAccepted(app);

    const res = await convert(app, "wl-f01", slotKey);
    expect(res.statusCode).toBe(200);
    expect(res.headers["idempotency-status"]).toBe("original");
    const body = res.json() as Json;
    expect(body.applied).toBe(true);
    const reservation = body.reservation as Json;
    expect(reservation.id).toBe("res-wl-wl-f01-2026-08-04-780-3");
    expect(reservation.status).toBe("confirmed");

    const snap = await snapshotOf(app);
    const wl = snap.waitlist as Json;
    const entry = entryOf(wl, "wl-f01") as Json;
    expect(entry.state).toBe("converted");
    expect(entry.stateLabel).toBe("Convertida en reserva sintética");
    expect(entry.availableCommands).toEqual([]);
    expect(entry.trace).toEqual({
      cancellationId: "cxl-demo-salon-res-2",
      releasedSlotKey: "slot-2026-08-04-780-3",
      noticeId: "aviso-wl-f01-1",
      createdReservationId: "res-wl-wl-f01-2026-08-04-780-3",
    });

    // El hueco deja de estar pendiente de decisión y wl-f02 pasa a
    // 'ese hueco ya no está libre', con el motivo a la vista.
    const slot = slotOf(wl, slotKey) as Json;
    expect(slot.stillFree).toBe(false);
    expect(slot.decisionPending).toBe(false);
    const f02 = (slot.incompatible as { entryId: string; reasons: { code: string; label: string }[] }[]).find((i) => i.entryId === "wl-f02");
    expect(f02?.reasons.map((r) => r.code)).toContain("slot_no_longer_free");
    expect(f02?.reasons.map((r) => r.label)).toContain("Ese hueco ya no está libre");

    // La tarea «decidir hueco» se cierra: dejarla abierta sería mentir.
    expect(openTasks(snap).some((t) => t.id === `decidir-hueco-${slotKey}`)).toBe(false);
    expect(taskIds(snap)).toContain(`decidir-hueco-${slotKey}`);

    // Y la reserva aparece en las DOS proyecciones, marcada como originada
    // en la lista de espera.
    const enStore = (snap.reservations as Json[]).find((r) => r.id === reservation.id);
    const enCalendario = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === reservation.id);
    expect(enStore?.originatedFromWaitlistEntryId).toBe("wl-f01");
    expect(enCalendario?.originatedFromWaitlistEntryId).toBe("wl-f01");
    expect((wl.integrity as Json).ok).toBe(true);
    await app.close();
  });
});

describe("step 17 · §10.12 — el hueco se ocupa antes de convertir", () => {
  it("409, cero reservas nuevas, la entrada vuelve a 'Pendiente' y queda una tarea de revisión", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveToAccepted(app);

    // Una llamada del Laboratorio se lleva el hueco. Se usa
    // `POST /api/scenario/run` TAL CUAL, sin tocarlo.
    const robo = await post(app, "/api/scenario/run", {
      scenarioId: "A32-consola-roba-el-hueco",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "tuesday",
          time: "13:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    expect(robo.statusCode).toBe(200);
    expect((robo.json() as Json).reasonCode).toBe("BOOKING_CONFIRMED");

    const res = await convert(app, "wl-f01", slotKey);
    expect(res.statusCode).toBe(409);
    const body = res.json() as Json;
    expect(body.applied).toBe(false);
    expect(body.conflict).toBe("slot_no_longer_free");
    expect((body.revalidation as { reasons: string[] }).reasons).toContain("slot_no_longer_free");
    expect(body.entryState).toBe("pending");

    const snap = await snapshotOf(app);
    expect((snap.reservations as Json[]).filter((r) => String(r.id).startsWith("res-wl-")).length).toBe(0);
    expect(((snap.calendar as Json).reservations as Json[]).filter((r) => String(r.id).startsWith("res-wl-")).length).toBe(0);
    const wl = snap.waitlist as Json;
    expect(entryOf(wl, "wl-f01")?.state).toBe("pending");
    expect(entryOf(wl, "wl-f01")?.offer).toBeNull();
    expect(auditKinds(wl)).toContain("WAITLIST_CONVERSION_CONFLICT");
    expect(auditKinds(wl)).not.toContain("WAITLIST_ENTRY_CONVERTED");
    expect((wl.metrics as Json).conversionConflictsPrevented).toBe(1);
    expect(openTasks(snap).some((t) => t.id === "conflicto-conversion-wl-f01")).toBe(true);
    expect((wl.integrity as Json).ok).toBe(true);
    await app.close();
  });
});

describe("step 17 · §10.13 — idempotencia", () => {
  it("repetir la MISMA petición devuelve el resultado guardado, sin una segunda reserva", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveToAccepted(app);
    const primera = await convert(app, "wl-f01", slotKey);
    expect(primera.statusCode).toBe(200);
    expect(primera.headers["idempotency-status"]).toBe("original");

    const segunda = await convert(app, "wl-f01", slotKey);
    expect(segunda.statusCode).toBe(200);
    expect(segunda.headers["idempotency-status"]).toBe("replayed");
    expect(segunda.json()).toEqual(primera.json());

    const snap = await snapshotOf(app);
    expect(((snap.calendar as Json).reservations as Json[]).filter((r) => String(r.id).startsWith("res-wl-")).length).toBe(1);
    const wl = snap.waitlist as Json;
    expect(auditKinds(wl).filter((k) => k === "WAITLIST_ENTRY_CONVERTED").length).toBe(1);
    expect(auditKinds(wl).filter((k) => k === "IDEMPOTENT_REPLAY").length).toBe(1);
    expect((wl.metrics as Json).idempotentReplays).toBe(1);
    expect((wl.metrics as Json).conversions).toBe(1);
    await app.close();
  });

  it("la misma clave con OTRO cuerpo es 409 y no ejecuta nada", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveToAccepted(app);
    const key = `convert:wl-f01:${slotKey}`;
    expect((await convert(app, "wl-f01", slotKey, {}, key)).statusCode).toBe(200);

    const antes = await snapshotOf(app);
    const choque = await convert(app, "wl-f01", "slot-2026-08-04-810-3", {}, key);
    expect(choque.statusCode).toBe(409);
    expect((choque.json() as Json).conflict).toBe("idempotency_key_reused_with_different_body");
    const despues = await snapshotOf(app);
    expect(JSON.stringify(despues.reservations)).toBe(JSON.stringify(antes.reservations));
    expect(JSON.stringify((despues.waitlist as Json).entries)).toBe(JSON.stringify((antes.waitlist as Json).entries));
    await app.close();
  });

  it("`convert` y `cancel` EXIGEN la cabecera; un formato inválido también es 400", async () => {
    const app = freshApp();
    await reset(app);
    const sinCabecera = await post(app, "/api/reservations/demo-salon-res-2/cancel", { reasonCode: "unspecified", confirmed: true });
    expect(sinCabecera.statusCode).toBe(400);
    expect((sinCabecera.json() as Json).error).toBe("Falta la cabecera Idempotency-Key.");

    const malFormada = await post(
      app,
      "/api/reservations/demo-salon-res-2/cancel",
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": "corta" },
    );
    expect(malFormada.statusCode).toBe(400);
    // Nada se ha cancelado por el camino.
    const wl = await waitlistOf(app);
    expect(wl.cancellations).toEqual([]);
    await app.close();
  });

  it("un conflicto NO se memoriza: reintentar después de resolverlo vuelve a ejecutar de verdad", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const slotKey = "slot-2026-08-04-780-3";
    const key = `convert:wl-f01:${slotKey}`;

    // Todavía en 'matched': convertir es un 409 de estado.
    const conflicto = await convert(app, "wl-f01", slotKey, {}, key);
    expect(conflicto.statusCode).toBe(409);

    // Se resuelve el conflicto y se REINTENTA con la misma clave: ahora sí
    // se ejecuta. Congelar el 409 para siempre sería el peor fallo posible.
    await approve(app, "wl-f01", slotKey); // (step 23, R2)
    await command(app, "wl-f01", "simulate_notice");
    await command(app, "wl-f01", "record_acceptance");
    const reintento = await convert(app, "wl-f01", slotKey, {}, key);
    expect(reintento.statusCode).toBe(200);
    expect(reintento.headers["idempotency-status"]).toBe("original");
    await app.close();
  });
});

describe("step 17 · §10.14 — reset", () => {
  it("devuelve las seis semillas, el plazo 120, cero cancelaciones, un único DEMO_RESET y el registro de idempotencia vacío", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveToAccepted(app);
    await convert(app, "wl-f01", slotKey);
    await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: 60 });

    await reset(app);
    const snap = await snapshotOf(app);
    const wl = snap.waitlist as Json;
    expect((wl.entries as Json[]).length).toBe(6);
    expect((wl.entries as Json[]).every((e) => e.state === "pending")).toBe(true);
    expect((wl.policy as Json).cancellationNoticeMinutes).toBe(120);
    expect((wl.policy as Json).source).toBe("demo_default");
    expect(wl.cancellations).toEqual([]);
    expect(wl.releasedSlots).toEqual([]);
    expect(auditKinds(wl)).toEqual(["DEMO_RESET"]);
    expect((snap.reservations as Json[]).length).toBe(0);
    // Las citas de la fixture vuelven a estar confirmadas.
    const fixture = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === "demo-salon-res-2");
    expect(fixture?.status).toBe("confirmed");
    expect(fixture?.cancellation).toBeUndefined();

    // Y la clave de idempotencia de antes ya no replica nada: se vuelve a
    // ejecutar contra el mundo nuevo.
    const otraVez = await cancel(app, "demo-salon-res-2");
    expect(otraVez.statusCode).toBe(200);
    expect(otraVez.headers["idempotency-status"]).toBe("original");
    await app.close();
  });
});

describe("step 17 · §10.15 — fallo sintético inyectado", () => {
  it("500, la entrada sigue 'Aceptada', cero reservas y ninguna métrica de conversión sube", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveToAccepted(app);
    const antes = await snapshotOf(app);

    const res = await convert(app, "wl-f01", slotKey, { injectFailure: true });
    expect(res.statusCode).toBe(500);
    const body = res.json() as Json;
    expect(body.applied).toBe(false);
    expect(body.code).toBe("synthetic_injected_failure");
    expect(body.error).toBe("Fallo sintético inyectado. No se ha escrito nada.");

    const despues = await snapshotOf(app);
    expect(JSON.stringify(despues.reservations)).toBe(JSON.stringify(antes.reservations));
    expect(JSON.stringify((despues.calendar as Json).reservations)).toBe(JSON.stringify((antes.calendar as Json).reservations));
    expect(JSON.stringify((despues.waitlist as Json).entries)).toBe(JSON.stringify((antes.waitlist as Json).entries));
    const wl = despues.waitlist as Json;
    expect(entryOf(wl, "wl-f01")?.state).toBe("accepted");
    expect((wl.metrics as Json).conversions).toBe(0);
    expect((wl.metrics as Json).injectedFailuresHandled).toBe(1);
    expect((wl.integrity as Json).ok).toBe(true);
    // Y un 500 no se memoriza: se puede reintentar sin el fallo.
    expect((await convert(app, "wl-f01", slotKey)).statusCode).toBe(200);
    await app.close();
  });
});

describe("step 17 · §10.16 — la capacidad impide un emparejamiento inválido, y su contraste", () => {
  it("Nerea no hace Barba a las 16:00; Dani, en el mismo horario, sí", async () => {
    const app = freshApp();
    await reset(app);

    const nerea = await cancel(app, "demo-salon-res-6");
    const matchesNerea = (nerea.json() as Json).matches as { compatibleEntryIds: string[]; incompatible: { entryId: string; reasons: string[] }[] }[];
    expect(matchesNerea.every((m) => m.compatibleEntryIds.length === 0)).toBe(true);
    expect(matchesNerea[0]?.incompatible.find((i) => i.entryId === "wl-f04")?.reasons).toEqual(["professional_cannot_perform_service"]);

    const wl1 = await waitlistOf(app);
    const slotNerea = slotOf(wl1, "slot-2026-08-04-960-9") as Json;
    const motivo = (slotNerea.incompatible as { entryId: string; reasons: { label: string }[] }[]).find((i) => i.entryId === "wl-f04");
    expect(motivo?.reasons[0]?.label).toBe("Nerea (sintética) no hace ese servicio");

    const dani = await cancel(app, "demo-salon-res-10");
    const matchesDani = (dani.json() as Json).matches as { compatibleEntryIds: string[] }[];
    expect(matchesDani[0]?.compatibleEntryIds).toEqual(["wl-f04"]);
    await app.close();
  });
});

describe("step 17 · §10.17 — el cierre del local impide un emparejamiento inválido", () => {
  it("con el 6 de agosto cerrado, cancelar no libera NADA y wl-f06 no se anuncia compatible", async () => {
    const app = freshApp();
    await reset(app);

    const publicacion = await post(app, "/api/calendar/publish", {
      change: { changeKind: "venue_closure", id: "cierre-6-agosto", startDate: "2026-08-06", endDate: "2026-08-06" },
      resolutions: { "demo-salon-res-8": "keep_and_flag", "demo-salon-res-9": "keep_and_flag" },
    });
    expect(publicacion.statusCode).toBe(200);
    expect((publicacion.json() as Json).applied).toBe(true);

    const res = await cancel(app, "demo-salon-res-8");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.releasedSlots).toEqual([]);
    expect(body.matches).toEqual([]);
    expect(body.humanTaskIds).toEqual([]);

    const wl = await waitlistOf(app);
    expect(auditKinds(wl)).toContain("SLOT_RELEASE_PRODUCED_NO_SLOTS");
    const evento = (wl.audit as { items: Json[] }).items.find((i) => i.kind === "SLOT_RELEASE_PRODUCED_NO_SLOTS");
    expect(evento?.text).toBe("Esta cancelación no libera ningún hueco: ese día el local no abre.");
    expect(entryOf(wl, "wl-f06")?.state).toBe("pending");
    expect(entryOf(wl, "wl-f06")?.offer).toBeNull();
    expect((wl.releasedSlots as Json[]).length).toBe(0);
    await app.close();
  });

  it("sin el cierre, esa misma cancelación SÍ encuentra a wl-f06: lo que lo impide es el cierre, no otra cosa", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-8");
    expect((res.json() as Json).matches as { compatibleEntryIds: string[] }[]).toEqual([
      expect.objectContaining({ compatibleEntryIds: ["wl-f06"] }),
    ]);
    await app.close();
  });
});

// =====================================================================
// §12 — criterios de aceptación
// =====================================================================

describe("step 17 · §12.4 — reproducir el registro reproduce el estado de cada entrada", () => {
  it("una reproducción independiente del auditLog da exactamente los mismos estados", async () => {
    const app = freshApp();
    await reset(app);
    // Una secuencia larga y variada, para que la reproducción tenga trabajo.
    await cancel(app, "demo-salon-res-2");
    await command(app, "wl-f01", "simulate_notice");
    await command(app, "wl-f01", "record_acceptance");
    await convert(app, "wl-f01", "slot-2026-08-04-780-3");
    await cancel(app, "demo-salon-res-5");
    await command(app, "wl-f03", "simulate_notice");
    await command(app, "wl-f03", "record_decline");
    await command(app, "wl-f03", "reopen");
    await command(app, "wl-f02", "withdraw");
    await cancel(app, "demo-salon-res-1");
    // Se caduca wl-f04 y NO wl-f05, a propósito: la secuencia anterior
    // caducaba justo a la única entrada que quedaba en 'matched', de modo que
    // la reproducción nunca tenía que reproducir ese estado y el defecto 2
    // pasaba desapercibido. Sigue habiendo una caducidad manual en la
    // secuencia; lo único que cambia es a quién le toca.
    await command(app, "wl-f04", "expire_manually");
    await post(app, "/api/waitlist/entries", {
      clientLabel: "Cliente H",
      serviceId: 1,
      dateFrom: "2026-08-05",
      dateTo: "2026-08-05",
      earliestStartMinutes: 600,
      latestStartMinutes: 720,
      professional: { kind: "any" },
      optInSource: "operator_entered",
      optInConfirmed: true,
    });

    const wl = await waitlistOf(app);
    const real = Object.fromEntries((wl.entries as Json[]).map((e) => [e.id as string, e.state as string]));
    // La prueba no puede pasar en vacío: si ninguna entrada acabara en
    // 'matched', la reproducción del paso automático pending→matched no se
    // estaría ejercitando en absoluto. Ese era justo el hueco del defecto 2.
    expect(real["wl-f05"]).toBe("matched");

    // La reproducción: se parte de "todas las semillas pendientes" y se
    // aplica el efecto declarado de cada evento del registro, en orden de
    // `seq`. Es una lectura INDEPENDIENTE del código de producción, y sale
    // SÓLO del registro: no se mira ni un campo del estado vivo.
    const reproducido: Record<string, WaitlistEntryState> = {};
    for (const raw of (wl.audit as { items: Json[] }).items) {
      const ev = raw as { kind: string; entryId: string | null; toState?: string };
      if (ev.kind === "DEMO_RESET") {
        for (const seed of ["wl-f01", "wl-f02", "wl-f03", "wl-f04", "wl-f05", "wl-f06"]) reproducido[seed] = "pending";
        continue;
      }
      if (ev.entryId === null) continue;
      if (ev.kind === "WAITLIST_ENTRY_CREATED") {
        reproducido[ev.entryId] = "pending";
        continue;
      }
      if (ev.kind === "WAITLIST_MATCH_EVALUATED") continue;
      // (step 23 §6) Los cinco eventos de propuesta llevan `entryId` pero NO
      // declaran transición: aprobar no mueve a nadie de estado (§5.2). Un
      // evento sin `toState` no puede reproducir un estado, y fingir que sí
      // sería inventarse la historia que el registro no cuenta.
      if (ev.toState === undefined || ev.toState === null) continue;
      reproducido[ev.entryId] = ev.toState as WaitlistEntryState;
    }
    expect(reproducido).toEqual(real);
    await app.close();
  });

  it("el paso automático pending→matched deja su propia fila en el registro, con entryId y transición", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-2");
    const emparejadas = ((res.json() as Json).matches as { compatibleEntryIds: string[] }[])[0]?.compatibleEntryIds ?? [];
    expect(emparejadas.length).toBeGreaterThan(0);

    const wl = await waitlistOf(app);
    const filas = (wl.audit as { items: Json[] }).items.filter((i) => (i as Json).kind === "WAITLIST_ENTRY_MATCHED");
    // Una fila por persona emparejada, ni una más: el hueco se ofrece a quien
    // encaja y no tiene ya una oferta viva.
    expect(filas.map((f) => (f as Json).entryId)).toEqual(emparejadas);
    for (const fila of filas) {
      const f = fila as Json;
      expect(f.slotKey).toBe("slot-2026-08-04-780-3");
      expect(f.cancellationId).toBe("cxl-demo-salon-res-2");
      expect(f.fromState).toBe("pending");
      expect(f.toState).toBe("matched");
      // El texto de operador no dice que el sistema haya elegido ni avisado a
      // nadie: sólo que el hueco encaja (§5, no-reglas J1/J3).
      expect(f.text as string).toMatch(/^El hueco de las 13:00 encaja con Cliente [A-Z]\.$/);
    }
    await app.close();
  });
});

describe("step 17 · §12.7/§12.8/§12.9 — invariantes de integridad", () => {
  it("tras una secuencia larga, integrity.ok sigue en true y ningún hueco se convierte dos veces", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    await command(app, "wl-f01", "simulate_notice");
    await command(app, "wl-f01", "record_acceptance");
    await convert(app, "wl-f01", "slot-2026-08-04-780-3");
    await convert(app, "wl-f01", "slot-2026-08-04-780-3");
    await cancel(app, "demo-salon-res-5");
    await cancel(app, "demo-salon-res-1");
    await cancel(app, "demo-salon-res-4");
    await cancel(app, "demo-salon-res-6");
    await cancel(app, "demo-salon-res-10");
    await command(app, "wl-f04", "simulate_notice");
    await command(app, "wl-f04", "record_acceptance");
    await convert(app, "wl-f04", "slot-2026-08-04-960-6");

    const snap = await snapshotOf(app);
    const wl = snap.waitlist as Json;
    expect((wl.integrity as Json).ok).toBe(true);
    expect((wl.integrity as Json).falseSuccesses).toBe(0);
    expect((wl.integrity as Json).doubleBookedSlotKeys).toEqual([]);

    const convertidos = (wl.audit as { items: { kind: string; slotKey: string | null }[] }).items
      .filter((i) => i.kind === "WAITLIST_ENTRY_CONVERTED")
      .map((i) => i.slotKey);
    expect(new Set(convertidos).size).toBe(convertidos.length);
  });

  // -------------------------------------------------------------------
  // Reparación de la revisión adversarial (defecto 1): el invariante
  // contrastaba eventos del PASADO contra el estado del PRESENTE, y una
  // cancelación posterior perfectamente legítima lo hacía acusarse a sí
  // mismo. Estas tres pruebas fijan la frontera exacta: se afina, no se
  // debilita.
  // -------------------------------------------------------------------

  it("convertir y después cancelar desde Agenda la reserva creada NO es un falso éxito", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveToAccepted(app);
    const conversion = await convert(app, "wl-f01", slotKey);
    expect(conversion.statusCode).toBe(200);
    const creada = ((conversion.json() as Json).reservation as Json).id as string;

    const anulada = await cancel(app, creada);
    expect(anulada.statusCode).toBe(200);

    const snap = await snapshotOf(app);
    const wl = snap.waitlist as Json;
    expect(wl.integrity).toEqual({ falseSuccesses: 0, doubleBookedSlotKeys: [], ok: true });
    // Y el calendario dice la verdad: esa reserva existe, cancelada, y hay
    // una cancelación registrada que da cuenta de ella.
    const enCalendario = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === creada);
    expect(enCalendario?.status).toBe("cancelled");
    expect((wl.cancellations as Json[]).some((c) => c.reservationId === creada)).toBe(true);
    await app.close();
  });

  it("reconvertir el mismo hueco, ya libre otra vez, con otra entrada NO es doble reserva", async () => {
    const app = freshApp();
    await reset(app);
    const slotKey = await driveToAccepted(app);
    const primera = await convert(app, "wl-f01", slotKey);
    expect(primera.statusCode).toBe(200);
    expect((await cancel(app, ((primera.json() as Json).reservation as Json).id as string)).statusCode).toBe(200);

    // El hueco ha vuelto a quedar libre y wl-f02 encaja en él. Se recorre el
    // camino completo otra vez: aviso, aceptación, conversión.
    // (step 23) Al convertir, T2 reofertó a wl-f02 el hueco hermano de las
    // 13:30; para que compita por ESTE hueco hay que soltar aquel y que una
    // persona apruebe la propuesta nueva. Dos actos humanos, ninguno tácito.
    expect((await command(app, "wl-f02", "release_match")).statusCode).toBe(200);
    expect((await command(app, "wl-f02", "take_over_proposal", slotKey)).statusCode).toBe(200);
    expect((await command(app, "wl-f02", "simulate_notice")).statusCode).toBe(200);
    expect((await command(app, "wl-f02", "record_acceptance")).statusCode).toBe(200);
    const segunda = await convert(app, "wl-f02", slotKey);
    expect(segunda.statusCode).toBe(200);

    const snap = await snapshotOf(app);
    const wl = snap.waitlist as Json;
    // DOS eventos de conversión sobre el mismo slotKey, y aun así ninguna
    // doble reserva: en ningún instante hubo dos citas confirmadas ahí.
    const conversiones = (wl.audit as { items: { kind: string; slotKey: string | null }[] }).items.filter(
      (i) => i.kind === "WAITLIST_ENTRY_CONVERTED" && i.slotKey === slotKey,
    );
    expect(conversiones).toHaveLength(2);
    expect(wl.integrity).toEqual({ falseSuccesses: 0, doubleBookedSlotKeys: [], ok: true });
    const confirmadasAhi = ((snap.calendar as Json).reservations as Json[]).filter(
      (r) => r.date === "2026-08-04" && r.startMinutes === 780 && r.employeeId === 3 && r.status === "confirmed",
    );
    expect(confirmadasAhi).toHaveLength(1);
    await app.close();
  });

  it("un falso éxito DE VERDAD —conversión anunciada sin reserva y sin cancelación registrada— sigue encendiendo el aviso", () => {
    const cal = demoSalonVenue();
    const clock = fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);
    const evento: WaitlistAuditEvent = {
      id: "wla-00000001",
      seq: 1,
      kind: "WAITLIST_ENTRY_CONVERTED",
      actor: "operator",
      atISO: clock.nowInstantISO(),
      entryId: "wl-f01",
      slotKey: "slot-2026-08-04-780-3",
      newReservationId: "res-wl-que-no-existe",
      fromState: "accepted",
      toState: "converted",
      synthetic: true,
    };
    const base: WaitlistStoreSnapshot = {
      entries: [],
      cancellations: [],
      releasedSlots: [],
      auditLog: [evento],
      policy: { cancellationNoticeMinutes: 120, source: "demo_default" },
      nextEntryNumber: 1,
      nextOfferSeq: 1,
    };

    // Sin reserva y sin cancelación que dé cuenta de ella: el aviso rojo se
    // enciende, que es exactamente para lo que existe.
    const roto = buildWaitlistSnapshot(cal, clock, base, []);
    expect(roto.integrity).toEqual({ falseSuccesses: 1, doubleBookedSlotKeys: [], ok: false });

    // Con la cancelación registrada, la misma ausencia deja de ser mentira:
    // es una cancelación posterior de la que el sistema sí da cuenta.
    const conCancelacion = buildWaitlistSnapshot(
      cal,
      clock,
      {
        ...base,
        cancellations: [
          {
            id: "cxl-res-wl-que-no-existe",
            reservationId: "res-wl-que-no-existe",
            employeeId: 3,
            serviceId: 1,
            date: "2026-08-04",
            startMinutes: 780,
            endMinutes: 810,
            reasonCode: "unspecified",
            leadMinutes: 300,
            policyMinutesAtCancellation: 120,
            timeliness: "on_time",
            releasedSlotKeys: [],
            cancelledAtISO: clock.nowInstantISO(),
            cancelledBy: "console-operator",
            synthetic: true,
          },
        ],
      },
      [],
    );
    expect(conCancelacion.integrity).toEqual({ falseSuccesses: 0, doubleBookedSlotKeys: [], ok: true });
  });

  // -------------------------------------------------------------------
  // Reparación de la revisión adversarial (defecto 4): el registro de huecos
  // liberados es el estado PRESENTE, no un historial. Un mismo hueco físico
  // se puede liberar dos veces (liberar → convertir → cancelar la creada) y
  // el registro guardaba las dos, con lo que UN hueco de media hora salía
  // por duplicado en las tarjetas, en `trace` y en los minutos sin cubrir.
  // El historial completo sigue en el registro de auditoría, intacto.
  // -------------------------------------------------------------------

  /** Liberar el hueco de las 13:00, convertirlo con wl-f01 y cancelar la reserva creada. */
  async function liberarDosVeces(
    app: FastifyInstance,
    options: { soltarF02Antes?: boolean } = {},
  ): Promise<{ slotKey: string; segundaCancelacion: string }> {
    const slotKey = await driveToAccepted(app);
    const conversion = await convert(app, "wl-f01", slotKey);
    expect(conversion.statusCode).toBe(200);
    const creada = ((conversion.json() as Json).reservation as Json).id as string;
    expect(creada).toBe("res-wl-wl-f01-2026-08-04-780-3");
    // (step 23, T2) Convertir reoferta a wl-f02 el hueco HERMANO de las 13:30.
    // Quien quiera volver a competir por el de las 13:00 tiene que soltar aquel
    // primero: nadie retiene dos huecos a la vez y nada se le quita en silencio.
    if (options.soltarF02Antes === true) {
      expect((await command(app, "wl-f02", "release_match")).statusCode).toBe(200);
    }
    expect((await cancel(app, creada)).statusCode).toBe(200);
    return { slotKey, segundaCancelacion: `cxl-${creada}` };
  }

  it("(a) volver a liberar el mismo hueco SUSTITUYE el registro anterior, con la cancelación nueva como procedencia", async () => {
    const app = freshApp();
    await reset(app);
    const { slotKey, segundaCancelacion } = await liberarDosVeces(app);

    const wl = await waitlistOf(app);
    const registros = (wl.releasedSlots as Json[]).filter((s) => s.key === slotKey);
    expect(registros).toHaveLength(1);
    expect(registros[0]?.cancellationId).toBe(segundaCancelacion);

    // El historial NO se toca: `demo-salon-res-2` es una cita de una hora, así que
    // liberó DOS medias horas (13:00 y 13:30), y cancelar la reserva creada
    // liberó otra vez la de las 13:00. Tres liberaciones ocurrieron de verdad
    // y las tres siguen en el registro de auditoría y en su métrica; lo que no
    // puede haber es tres HUECOS donde sólo hay dos.
    expect(auditKinds(wl).filter((k) => k === "SLOT_RELEASED").length).toBe(3);
    expect((wl.metrics as Json).slotsReleasedTotal).toBe(3);
    expect(wl.releasedSlots as Json[]).toHaveLength(2);
    await app.close();
  });

  it("(b) el bloque de huecos pinta UNA sola tarjeta por hueco físico, y los minutos sin cubrir no se cuentan dos veces", async () => {
    const app = freshApp();
    await reset(app);
    const { slotKey } = await liberarDosVeces(app);

    const wl = await waitlistOf(app);
    const tarjetas = wl.releasedSlots as Json[];
    // Una tarjeta por hueco, y ninguna repetida: antes de la reparación
    // salían dos tarjetas idénticas y accionables para la misma media hora.
    expect(tarjetas.filter((s) => s.key === slotKey)).toHaveLength(1);
    const claves = new Set(tarjetas.map((s) => s.key as string));
    expect(claves.size).toBe(tarjetas.length);
    expect(tarjetas.filter((s) => s.key === slotKey && s.decisionPending === true)).toHaveLength(1);

    // Dos medias horas libres son 60 minutos de agenda sin cubrir. Contando
    // el hueco de las 13:00 dos veces salían 90 por dos huecos físicos: una
    // métrica que miente sobre la agenda real.
    const libres = tarjetas.filter((s) => s.stillFree === true);
    expect(libres).toHaveLength(2);
    expect((wl.metrics as Json).unfilledReleasedSlotMinutes).toBe(libres.length * 30);
    expect((wl.metrics as Json).unfilledReleasedSlotMinutes).toBe(60);
    await app.close();
  });

  it("(c) la traza de una entrada resuelta contra el registro apunta a la cancelación NUEVA, no a la vieja", async () => {
    const app = freshApp();
    await reset(app);
    const { slotKey, segundaCancelacion } = await liberarDosVeces(app, { soltarF02Antes: true });

    // wl-f02 suelta su oferta: a partir de aquí su traza se resuelve contra
    // el registro de huecos (no contra una oferta viva), que es justo el
    // camino que el registro duplicado envenenaba.
    expect((await command(app, "wl-f02", "release_match")).statusCode).toBe(200);

    const wl = await waitlistOf(app);
    const traza = entryOf(wl, "wl-f02")?.trace as Json;
    expect(traza.releasedSlotKey).toBe(slotKey);
    expect(traza.cancellationId).toBe(segundaCancelacion);
    await app.close();
  });

  it("(criterio 9) para todo identificador presente en las dos proyecciones, el `status` coincide", async () => {
    const app = freshApp();
    await reset(app);
    await post(app, "/api/scenario/run", {
      scenarioId: "A33-consola-doble-proyeccion",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "tuesday",
          time: "11:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    const creada = ((await snapshotOf(app)).reservations as Json[])[0] as Json;
    await cancel(app, creada.id as string);
    await cancel(app, "demo-salon-res-2");
    const slotKey = "slot-2026-08-04-780-3";
    await approve(app, "wl-f01", slotKey); // (step 23, R2)
    await command(app, "wl-f01", "simulate_notice");
    await command(app, "wl-f01", "record_acceptance");
    await convert(app, "wl-f01", slotKey);

    const snap = await snapshotOf(app);
    const store = new Map((snap.reservations as Json[]).map((r) => [r.id as string, r.status as string]));
    const calendario = new Map(((snap.calendar as Json).reservations as Json[]).map((r) => [r.id as string, r.status as string]));
    let comparados = 0;
    for (const [id, status] of store) {
      if (!calendario.has(id)) continue;
      expect(calendario.get(id), id).toBe(status);
      comparados += 1;
    }
    // Si esto bajara a cero, el bucle de arriba no habría comprobado nada.
    expect(comparados).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  it("(criterio 11) un 409 no escribe ni una reserva, ni un evento de éxito, ni un cambio de estado no documentado", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const antes = await snapshotOf(app);

    // Cuatro conflictos distintos, ninguno escribe. La segunda cancelación
    // lleva OTRA clave de idempotencia a propósito: con la misma clave la
    // respuesta correcta sería la repetición del 200 anterior, y lo que aquí
    // se quiere ejercer es el conflicto de verdad.
    const otraVez = await post(
      app,
      "/api/reservations/demo-salon-res-2/cancel",
      { reasonCode: "unspecified", confirmed: true },
      { "idempotency-key": "cancel:demo-salon-res-2:segundo-intento" },
    );
    expect(otraVez.statusCode).toBe(409);
    expect((otraVez.json() as Json).conflict).toBe("reservation_already_cancelled");
    expect((await command(app, "wl-f01", "record_acceptance")).statusCode).toBe(409);
    expect((await command(app, "wl-f04", "simulate_notice")).statusCode).toBe(409);
    expect((await convert(app, "wl-f01", "slot-2026-08-04-780-3")).statusCode).toBe(409);

    const despues = await snapshotOf(app);
    expect(JSON.stringify(despues.reservations)).toBe(JSON.stringify(antes.reservations));
    expect(JSON.stringify((despues.calendar as Json).reservations)).toBe(JSON.stringify((antes.calendar as Json).reservations));
    expect(JSON.stringify((despues.waitlist as Json).entries)).toBe(JSON.stringify((antes.waitlist as Json).entries));
    expect(auditKinds(despues.waitlist as Json)).toEqual(auditKinds(antes.waitlist as Json));
    await app.close();
  });

  it("(criterio 11) un 404 tampoco escribe nada", async () => {
    const app = freshApp();
    await reset(app);
    const antes = await waitlistOf(app);
    expect((await cancel(app, "no-existe")).statusCode).toBe(404);
    expect((await command(app, "wl-inexistente", "withdraw")).statusCode).toBe(404);
    expect((await post(app, "/api/reservations/no-existe/cancellation-review", { decision: "reviewed_no_action" })).statusCode).toBe(404);
    expect(JSON.stringify(await waitlistOf(app))).toBe(JSON.stringify(antes));
    await app.close();
  });
});

describe("step 17 · §12.12 — los contratos congelados siguen intactos", () => {
  it("PRECEDENCE_ORDER conserva sus diez códigos en el mismo orden", () => {
    expect([...PRECEDENCE_ORDER]).toEqual([
      "SECURITY_OR_PRIVACY_BOUNDARY",
      "TECHNICAL_FAILURE",
      "CUSTOMER_REQUESTS_HUMAN",
      "CANCEL_OR_CHANGE_NOT_ENABLED",
      "BUSINESS_DATA_NOT_APPROVED",
      "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
      "SERVICE_NOT_CONFIRMED",
      "INTENT_NOT_UNDERSTOOD",
      "BOOKING_CONFIRMED",
      "AVAILABILITY_PROVIDED",
    ]);
    expect(PRECEDENCE_ORDER.length).toBe(10);
  });

  it("PILOT_EVENT_NAMES e INTERNAL_EVENT_NAMES no han cambiado, y ninguno menciona la lista de espera", () => {
    expect([...PILOT_EVENT_NAMES]).toEqual([
      "CALL_STARTED",
      "INTENT_CLASSIFIED",
      "STATE_TRANSITION",
      "OUTCOME_EMITTED",
      "CALLBACK_REQUESTED",
      "STAFF_INTERRUPTION_RECORDED",
      "TECHNICAL_FAILURE",
      "CALL_ENDED",
    ]);
    expect([...PILOT_EVENT_NAMES, ...INTERNAL_EVENT_NAMES].some((n) => n.includes("WAITLIST"))).toBe(false);
  });

  it("una acción de lista de espera NO emite ni un evento de piloto ni uno interno", async () => {
    const app = freshApp();
    await reset(app);
    const antes = (await snapshotOf(app)).eventCounts;
    await cancel(app, "demo-salon-res-2");
    await command(app, "wl-f01", "simulate_notice");
    await command(app, "wl-f01", "record_acceptance");
    await convert(app, "wl-f01", "slot-2026-08-04-780-3");
    await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: 60 });
    expect((await snapshotOf(app)).eventCounts).toEqual(antes);
    await app.close();
  });
});

describe("step 17 · §12.16/§12.17/§12.18 — seguridad, privacidad y dependencias", () => {
  it("la CSP y las tres cabeceras siguen siendo exactamente las mismas en las rutas nuevas", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-2");
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(CONSOLE_HOST).toBe("127.0.0.1");
    await app.close();
  });

  it("una petición que no viene de loopback se rechaza también en las rutas nuevas", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/waitlist/policy",
      payload: { cancellationNoticeMinutes: 60 },
      remoteAddress: "10.0.0.7",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("ningún cuerpo de respuesta trae teléfono, correo, nombre real ni privateReason", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    await command(app, "wl-f01", "simulate_notice");
    await command(app, "wl-f01", "record_acceptance");
    await convert(app, "wl-f01", "slot-2026-08-04-780-3");
    const snap = await snapshotOf(app);
    const wl = JSON.stringify(snap.waitlist);

    // Las etiquetas de cliente sólo casan el patrón cerrado.
    for (const entry of (snap.waitlist as Json).entries as Json[]) {
      expect(String(entry.clientLabel)).toMatch(/^Cliente [A-Z]$/);
    }
    expect(wl).not.toContain("privateReason");
    expect(wl).not.toMatch(/\+\d[\d\s().-]{6,}/);
    expect(wl).not.toMatch(/[^\s@"]+@[^\s@"]+\.[^\s@",}]+/);

    // Ni una clave de datos personales en ninguna profundidad. El nombre
    // sintético del profesional viaja como VALOR (igual que en snapshot.ts),
    // nunca como una clave `displayName`/`name`.
    const prohibidas = ["phone", "telefono", "nombre", "apellido", "email", "transcript", "audio", "recording", "address", "direccion", "dni", "nif"];
    function walk(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = key.toLowerCase();
        for (const banned of prohibidas) expect(normalized.includes(banned), `${key} → ${banned}`).toBe(false);
        walk(child);
      }
    }
    walk(snap.waitlist);
    await app.close();
  });

  it("no hay ni una dependencia nueva en package.json", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // v0.3.0 (D-007): `yaml` (ISC, gratuita) para leer clientes/<id>/cliente.yaml.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@fastify/rate-limit", "axios", "dotenv", "fastify", "yaml", "zod"]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "nock", "tsx", "typescript", "vitest"]);
  });

  it("(criterio 19) el código nuevo de src/console no usa temporizadores ni el reloj real más allá del sello de presentación que ya existía", () => {
    for (const file of ["waitlistSnapshot.ts", "idempotency.ts"]) {
      const source = readFileSync(join(process.cwd(), "src", "console", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const prohibido of ["setTimeout", "setInterval", "Date.now(", "Math.random(", "new Date()"]) {
        expect(source.includes(prohibido), `${file} → ${prohibido}`).toBe(false);
      }
    }
  });
});

describe("step 17 · §6.2 — la mecánica de idempotencia, por dentro", () => {
  it("la huella no depende del ORDEN de las claves del cuerpo, pero sí del contenido", () => {
    const a = fingerprintRequest("R", { b: 2, a: 1 }, "p");
    const b = fingerprintRequest("R", { a: 1, b: 2 }, "p");
    expect(a).toBe(b);
    expect(fingerprintRequest("R", { a: 1, b: 3 }, "p")).not.toBe(a);
    expect(fingerprintRequest("R", { a: 1, b: 2 }, "otro")).not.toBe(a);
    expect(fingerprintRequest("OTRA", { a: 1, b: 2 }, "p")).not.toBe(a);
    // Un array sí conserva su orden: [a,b] y [b,a] son peticiones distintas.
    expect(fingerprintRequest("R", { xs: [1, 2] }, "p")).not.toBe(fingerprintRequest("R", { xs: [2, 1] }, "p"));
    expect(canonicalize({ b: 1, a: { d: 1, c: 2 } })).toEqual({ a: { c: 2, d: 1 }, b: 1 });
  });

  // ENMIENDA DE FASE K (H1) de step 18: `remember` y `lookup` ganan el MODO.
  // El comportamiento de las siete rutas de step 17 no cambia ni un ápice —
  // aquí se declara `replay-body`, que es el que tenían y siguen teniendo—; lo
  // que cambia es que ahora hay que decirlo. La comprobación no se afloja: se
  // conserva entera y se le añade la del modo nuevo, abajo.
  it("sólo memoriza 2xx, y expulsa por orden de llegada al llegar al límite", () => {
    const store = createIdempotencyStore(3);
    for (const status of [409, 500, 404, 302]) {
      store.remember({ mode: "replay-body", key: `k-${String(status)}`, route: "R", fingerprint: "f", statusCode: status, body: {} });
    }
    expect(store.size()).toBe(0);

    for (const n of [1, 2, 3, 4]) {
      store.remember({ mode: "replay-body", key: `k${String(n)}`, route: "R", fingerprint: "f", statusCode: 200, body: { n } });
    }
    expect(store.size()).toBe(3);
    expect(store.lookup("k1", "R", "f", "replay-body").kind).toBe("miss");
    expect(store.lookup("k4", "R", "f", "replay-body").kind).toBe("replay");
    expect(store.lookup("k4", "R", "otra", "replay-body").kind).toBe("collision");
    store.clear();
    expect(store.size()).toBe(0);
  });

  it("(H1) en modo huella-sólo NADA de la respuesta se guarda: la repetición es `repeat`, y la colisión sigue siendo colisión", () => {
    const store = createIdempotencyStore(3);
    store.remember({ mode: "collision-only", key: "grupo-clave-1", route: "G", fingerprint: "f", statusCode: 201 });
    expect(store.size()).toBe(1);

    // Misma clave, mismo cuerpo: NO hay cuerpo memorizado que devolver, así
    // que la ruta tiene que volver a ejecutar. Y el resultado NO lleva
    // registro: no hay nada que reproducir.
    const repetida = store.lookup("grupo-clave-1", "G", "f", "collision-only");
    expect(repetida.kind).toBe("repeat");
    expect(Object.keys(repetida)).toEqual(["kind"]);

    // Misma clave, OTRO cuerpo: sigue siendo colisión, que es la mitad del
    // mecanismo que este modo conserva a propósito.
    expect(store.lookup("grupo-clave-1", "G", "otra", "collision-only").kind).toBe("collision");
    // Y un 409 tampoco se memoriza en este modo.
    store.remember({ mode: "collision-only", key: "grupo-clave-2", route: "G", fingerprint: "f", statusCode: 409 });
    expect(store.lookup("grupo-clave-2", "G", "f", "collision-only").kind).toBe("miss");

    // La guarda de los dos lados: un registro escrito en modo huella-sólo no
    // se puede reproducir NI aunque quien consulte pidiera `replay-body`.
    expect(store.lookup("grupo-clave-1", "G", "f", "replay-body").kind).toBe("repeat");
  });

  it("el patrón de la cabecera acepta las claves que acuña la interfaz y rechaza lo que no", () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test("convert:wl-f01:slot-2026-08-04-780-3")).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("cancel:demo-salon-res-2")).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("corta")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("con espacio aquí")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("a".repeat(201))).toBe(false);
  });
});

describe("step 17 · §12.25 — determinismo", () => {
  it("tres arranques limpios con la misma secuencia dan un bloque `waitlist` idéntico byte a byte", async () => {
    async function recorrido(): Promise<string> {
      const app = freshApp();
      await reset(app);
      await cancel(app, "demo-salon-res-2");
      await approve(app, "wl-f01", "slot-2026-08-04-780-3"); // (step 23, R2)
      await command(app, "wl-f01", "simulate_notice");
      await command(app, "wl-f01", "record_acceptance");
      await convert(app, "wl-f01", "slot-2026-08-04-780-3");
      await cancel(app, "demo-salon-res-1");
      await post(app, "/api/reservations/demo-salon-res-1/cancellation-review", { decision: "reviewed_no_action" });
      await post(app, "/api/waitlist/opt-in-declined", { clientLabel: "Cliente G" });
      await post(app, "/api/waitlist/entries", {
        clientLabel: "Cliente H",
        serviceId: 1,
        dateFrom: "2026-08-05",
        dateTo: "2026-08-05",
        earliestStartMinutes: 600,
        latestStartMinutes: 720,
        professional: { kind: "any" },
        optInSource: "operator_entered",
        optInConfirmed: true,
      });
      await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: 60 });
      const snap = await snapshotOf(app);
      await app.close();
      // `generatedAt` es el ÚNICO sello de reloj real de todo el entregable
      // y nunca formó parte de la promesa de determinismo.
      const { generatedAt: _ignorado, ...resto } = snap;
      return JSON.stringify({ waitlist: resto.waitlist, reservations: resto.reservations, humanQueue: resto.humanQueue });
    }

    const primero = await recorrido();
    expect(await recorrido()).toBe(primero);
    expect(await recorrido()).toBe(primero);
    // Y de verdad ha pasado algo: si el recorrido no escribiera nada, la
    // comparación de arriba sería la del mismo estado vacío tres veces.
    expect(primero).toContain("res-wl-wl-f01-2026-08-04-780-3");
    expect(primero).toContain("WAITLIST_ENTRY_CONVERTED");
  });
});

describe("step 17 · §6.3 — la instantánea llega RESUELTA, sin cálculo para el navegador", () => {
  it("cada entrada trae etiqueta, resumen, comandos y traza ya en castellano", async () => {
    const app = freshApp();
    await reset(app);
    const wl = await waitlistOf(app);
    for (const entry of wl.entries as Json[]) {
      expect(typeof entry.stateLabel).toBe("string");
      expect(typeof entry.stateTone).toBe("string");
      expect(typeof entry.serviceLabel).toBe("string");
      expect(typeof entry.preferenceSummary).toBe("string");
      expect(typeof entry.professionalLabel).toBe("string");
      expect(typeof entry.optInLabel).toBe("string");
      expect(Array.isArray(entry.availableCommands)).toBe(true);
      expect(entry.availableCommands).toEqual(AVAILABLE_COMMANDS_BY_STATE[entry.state as WaitlistEntryState]);
      expect(entry.trace).toMatchObject({ noticeId: null, createdReservationId: null });
    }
    // La política se explica sola, con su rótulo de valor de demostración.
    const policy = wl.policy as Json;
    expect(policy.sentence).toBe("Dentro de plazo = avisar con 120 minutos o más de antelación.");
    expect(policy.demoNotice).toBe("120 minutos · Valor de demostración, configurable por local. No es una política aprobada por Demo Salon.");
    expect(policy.isDemoValue).toBe(true);
    expect((policy.options as Json[]).map((o) => o.minutes)).toEqual([0, 30, 60, 120, 240, 1440]);
    // ENMIENDA DELIBERADA (step 18 §0.5, E3 y E9). La aserción NO se debilita:
    // sigue exigiendo que el aviso del reloj viaje SIEMPRE con las métricas, y
    // sigue comprobando su texto. Lo que cambia es (a) la clave, renombrada
    // porque `frozenClockNotice` mentía sobre un reloj que ya se mueve, y (b)
    // la frase, que ya no dice "congelado" sino lo que de verdad pasa. Se
    // comprueba además que la clave vieja YA NO existe: un renombrado a medias
    // dejaría las dos y nadie se enteraría.
    expect((wl.metrics as Json).syntheticClockNotice).toContain(
      "El reloj de esta demostración es sintético y sólo avanza cuando tú lo mueves en el Laboratorio",
    );
    expect((wl.metrics as Json)).not.toHaveProperty("frozenClockNotice");
    expect((wl.metrics as Json)).not.toHaveProperty("averageTimeToFill");
    await app.close();
  });

  it("con plazo 0 la frase lo dice sin valores mágicos escondidos", async () => {
    const app = freshApp();
    await reset(app);
    await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: 0 });
    const policy = (await waitlistOf(app)).policy as Json;
    expect(policy.sentence).toBe("Sin plazo: toda cancelación cuenta como dentro de plazo.");
    expect(policy.source).toBe("operator_set");
    await app.close();
  });

  it("el registro se recorta a 200 con su total, y cada línea trae ya su texto en castellano", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const wl = await waitlistOf(app);
    const audit = wl.audit as { total: number; shown: number; items: { text: string }[] };
    expect(audit.shown).toBeLessThanOrEqual(200);
    expect(audit.total).toBe(audit.items.length);
    expect(audit.items.every((i) => typeof i.text === "string" && i.text.length > 0)).toBe(true);
    expect(audit.items.map((i) => i.text)).toContain("Se ha liberado el hueco de las 13:00 con Álex (sintético).");
    expect(audit.items.map((i) => i.text)).toContain(
      "Se ha cancelado la cita de las 13:00 con Álex (sintético). Dentro del plazo configurado (120 min).",
    );
    await app.close();
  });

  it("un plazo fuera de 0..1440 se rechaza con 400", async () => {
    const app = freshApp();
    await reset(app);
    for (const minutes of [-1, 1441, 12.5]) {
      expect((await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: minutes })).statusCode, String(minutes)).toBe(400);
    }
    // El endpoint es más ancho que el `<select>` a propósito y documentado.
    expect((await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: 45 })).statusCode).toBe(200);
    await app.close();
  });
});

describe("step 19 · D3 — el servidor compone la frase entera del hueco liberado (0/1/N), y nunca en el navegador", () => {
  it("0 compatibles: la frase remite a WAITLIST_COPY.noneFit, sin ningún nombre", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-4");
    const wl = await waitlistOf(app);
    const slot = slotOf(wl, "slot-2026-08-04-690-6") as Json;
    expect(slot.announcementLine).toBe(
      `Hueco liberado: martes 4 de agosto, 11:30–12:00, con Dani (sintético). ${WAITLIST_COPY.noneFit}`,
    );
    await app.close();
  });

  it("1 compatible: la frase es la del SINGULAR (oneFits) seguida de la remisión a Lista de espera — nunca «Encajan Ana.»", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-5");
    const wl = await waitlistOf(app);
    const slot = slotOf(wl, "slot-2026-08-04-750-9") as Json;
    expect(slot.compatibleEntryIds).toEqual(["wl-f03"]);
    expect(slot.announcementLine).toBe(
      `Hueco liberado: martes 4 de agosto, 12:30–13:00, con Nerea (sintética). ${WAITLIST_COPY.oneFits} ${WAITLIST_COPY.decideInWaitlistScreen}`,
    );
    // La regla dura del propio bloque, ahora sin su única excepción: ningún
    // candidato se nombra aquí, y "Encajan" (el plural agramatical que
    // componía el navegador con un solo candidato) no aparece en ningún sitio.
    expect(String(slot.announcementLine)).not.toContain("Encajan");
    await app.close();
  });

  it("N (≥2) compatibles: la frase es la del PLURAL (severalFit), y ninguno de los dos huecos nombra a nadie", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const wl = await waitlistOf(app);
    const s1 = slotOf(wl, "slot-2026-08-04-780-3") as Json;
    const s2 = slotOf(wl, "slot-2026-08-04-810-3") as Json;
    expect(s1.compatibleEntryIds).toEqual(["wl-f01", "wl-f02"]);
    expect(s1.announcementLine).toBe(
      `Hueco liberado: martes 4 de agosto, 13:00–13:30, con Álex (sintético). ${WAITLIST_COPY.severalFit} ${WAITLIST_COPY.decideInWaitlistScreen}`,
    );
    expect(s2.announcementLine).toBe(
      `Hueco liberado: martes 4 de agosto, 13:30–14:00, con Álex (sintético). ${WAITLIST_COPY.severalFit} ${WAITLIST_COPY.decideInWaitlistScreen}`,
    );
    await app.close();
  });
});

describe("step 19 · D3b — el texto de auditoría WAITLIST_MATCH_EVALUATED en singular, y el plural intacto", () => {
  const ctx = { cal: demoSalonVenue(), entries: [], cancellations: [] };
  function evaluado(evaluated: number, compatible: number): string {
    return auditText(
      {
        id: "wla-probe",
        seq: 1,
        kind: "WAITLIST_MATCH_EVALUATED",
        actor: "system",
        atISO: "2026-08-04T09:00:00.000Z",
        slotKey: "slot-2026-08-04-540-3",
        detail: { evaluated, compatible },
        synthetic: true,
      },
      ctx,
    );
  }

  it("evaluated === 1: singular («Se ha comprobado 1 entrada…»)", () => {
    expect(evaluado(1, 0)).toBe("Se ha comprobado 1 entrada contra el hueco de las 09:00: 0 encajan.");
  });

  it("compatible === 1: singular («…: 1 encaja.»), combinado con evaluated === 1", () => {
    expect(evaluado(1, 1)).toBe("Se ha comprobado 1 entrada contra el hueco de las 09:00: 1 encaja.");
  });

  it("compatible === 1 con evaluated plural: sólo la mitad singular cambia", () => {
    expect(evaluado(6, 1)).toBe("Se han comprobado 6 entradas contra el hueco de las 09:00: 1 encaja.");
  });

  it("los plurales quedan BYTE A BYTE como estaban: evaluated > 1 y compatible !== 1 (incluido 0)", () => {
    expect(evaluado(6, 0)).toBe("Se han comprobado 6 entradas contra el hueco de las 09:00: 0 encajan.");
    expect(evaluado(6, 2)).toBe("Se han comprobado 6 entradas contra el hueco de las 09:00: 2 encajan.");
  });

  it("el escenario por defecto (6 entradas del fixture) sigue en plural en los tres casos ya cubiertos por el §10.5-10.7", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-4");
    const wl0 = await waitlistOf(app);
    expect((wl0.audit as { items: { text: string }[] }).items.map((i) => i.text)).toContain(
      "Se han comprobado 6 entradas contra el hueco de las 11:30: 0 encajan.",
    );
    await app.close();

    const app2 = freshApp();
    await reset(app2);
    await cancel(app2, "demo-salon-res-5");
    const wl1 = await waitlistOf(app2);
    expect((wl1.audit as { items: { text: string }[] }).items.map((i) => i.text)).toContain(
      "Se han comprobado 6 entradas contra el hueco de las 12:30: 1 encaja.",
    );
    await app2.close();

    const app3 = freshApp();
    await reset(app3);
    await cancel(app3, "demo-salon-res-2");
    const wlN = await waitlistOf(app3);
    expect((wlN.audit as { items: { text: string }[] }).items.map((i) => i.text)).toContain(
      "Se han comprobado 6 entradas contra el hueco de las 13:00: 2 encajan.",
    );
    await app3.close();
  });
});

// =====================================================================
// step 22 · N1 — la pantalla no ofrece lo que no puede cumplir
// =====================================================================

/**
 * Revisión adversarial de step 22, N1. Una cancelación de 60 minutos libera
 * DOS medias horas y crea DOS recados («una por cada media hora liberada»,
 * guion 2, paso 2.4). Pero la oferta se engancha al PRIMER hueco en el que
 * cada entrada encaja, y cada entrada sostiene UNA sola oferta viva: cuando
 * alguien convierte el primer hueco, quien competía por él se queda con una
 * oferta muerta —apuntando a un hueco ya ocupado— y no hay ningún camino que
 * la mueva al segundo hueco, que sigue libre.
 *
 * Reofertar automáticamente sería decidir quién se queda un hueco liberado:
 * justo la pregunta abierta que este proyecto se niega a responder solo
 * (`matching.ts` §4.2: «no encadena; convertir una entrada no reevalúa
 * nada»), y que necesita a Bruno. Lo que sí es exigible sin decidir nada es
 * que la pantalla DEJE DE OFRECER lo que el servidor va a rechazar: ni un
 * botón que sólo puede dar 409, ni una tarjeta de decisión que nadie puede
 * cerrar.
 */
describe("step 22 · N1 — con la oferta muerta, la consola deja de ofrecer botones que sólo pueden fallar", () => {
  const HUECO_1 = "slot-2026-08-04-780-3";
  const HUECO_2 = "slot-2026-08-04-810-3";

  async function convertirElPrimerHueco(app: FastifyInstance): Promise<void> {
    await reset(app);
    await driveToAccepted(app);
    expect((await convert(app, "wl-f01", HUECO_1)).statusCode).toBe(200);
  }

  it("la cancelación sigue creando DOS recados, uno por cada media hora liberada (guion 2, paso 2.4)", async () => {
    const app = freshApp();
    await reset(app);
    const res = await cancel(app, "demo-salon-res-2");
    expect((res.json() as Json).humanTaskIds).toEqual([
      `decidir-hueco-${HUECO_1}`,
      `decidir-hueco-${HUECO_2}`,
    ]);
    await app.close();
  });

  /**
   * (step 23, T2) LA REPARACIÓN DE N1 SE VUELVE INNECESARIA POR ESTE CAMINO,
   * y decirlo es más honesto que conservar una prueba cuya premisa ya no se
   * da. Al convertir de verdad el primer hueco, la oferta de `wl-f02` sobre él
   * queda PROBADAMENTE muerta, y el disparador T2 la reapunta al hueco hermano
   * de las 13:30 con una propuesta PENDIENTE de aprobación. Ya no hay ninguna
   * oferta muerta que enseñar por aquí.
   *
   * El caso de la oferta que muere y NADIE repara sigue existiendo y sigue
   * probado, en `tests/integration/competenciaPorElHueco.test.ts`: allí quien
   * se queda el hueco es un grupo, la conversión FALLA, y ningún disparador se
   * dispara — la oferta de `wl-f02` se queda muerta, con su motivo escrito.
   */
  it("al convertir de verdad, la segunda persona no se queda con una oferta muerta: T2 la reoferta al hueco hermano", async () => {
    const app = freshApp();
    await convertirElPrimerHueco(app);

    const wl = await waitlistOf(app);
    const segunda = entryOf(wl, "wl-f02");
    expect(segunda?.state).toBe("matched");
    expect((segunda?.offer as Json).slotKey).toBe(HUECO_2);
    expect((segunda?.offer as Json).stillValid).toBe(true);
    expect((segunda?.offer as Json).invalidReasons).toEqual([]);
    expect(segunda?.availableCommands).toEqual(AVAILABLE_COMMANDS_BY_STATE.matched);

    // Pero NADA se ha decidido por ella: la propuesta nueva está pendiente de
    // aprobación, así que el aviso simulado sigue siendo un 409 veraz.
    const forzado = await command(app, "wl-f02", "simulate_notice");
    expect(forzado.statusCode).toBe(409);
    expect((forzado.json() as Json).conflict).toBe("proposal_not_approved");
    await app.close();
  });

  it("y el segundo hueco vuelve a ser una decisión pendiente, porque ahora sí hay alguien a quien ofrecérselo", async () => {
    const app = freshApp();
    await convertirElPrimerHueco(app);

    const wl = await waitlistOf(app);
    const segundo = slotOf(wl, HUECO_2);
    expect(segundo?.stillFree).toBe(true);
    expect(segundo?.compatibleEntryIds).toEqual(["wl-f02"]);
    // La guarda de N1 (`someoneCanBeOffered`) se cumple sin tocarla: la
    // propuesta trae, por construcción, alguien con oferta viva sobre ESTE
    // hueco. La tarjeta deja de ser muda sin que nadie relaje la condición.
    expect(segundo?.decisionPending).toBe(true);

    // El recado sigue abierto, como el resto de recados de esta demo: nada se
    // cierra solo (ver `relojYListaDeEspera.test.ts`).
    const snap = await snapshotOf(app);
    expect(openTasks(snap).map((t) => t.id)).toContain(`decidir-hueco-${HUECO_2}`);
    await app.close();
  });

  it("mientras la oferta SÍ es válida, los dos huecos siguen esperando su decisión", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const wl = await waitlistOf(app);
    for (const id of ["wl-f01", "wl-f02"]) {
      const entrada = entryOf(wl, id);
      expect((entrada?.offer as Json).stillValid).toBe(true);
      expect(entrada?.availableCommands).toEqual(AVAILABLE_COMMANDS_BY_STATE.matched);
    }
    // El primero, porque las dos ofertas vivas apuntan a él. El segundo no:
    // nadie sostiene una oferta suya, y eso ya era así antes de esta
    // reparación — lo que cambia es que ahora se dice.
    expect(slotOf(wl, HUECO_1)?.decisionPending).toBe(true);
    await app.close();
  });
});

// =====================================================================
// step 23 — el transporte de los dos comandos nuevos y las cinco frases
// =====================================================================

describe("step 23 · §5.4 — el esquema del comando: unión discriminada, `slotKey` obligatorio y sin ruta nueva", () => {
  const HUECO = "slot-2026-08-04-780-3";

  it("aprobar sin `slotKey` es un 400: una propuesta se aprueba por su hueco, nunca 'la que tenga esta persona'", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const res = await post(app, "/api/waitlist/entries/wl-f01/command", { command: "approve_proposal" });
    expect(res.statusCode).toBe(400);
    // Y no ha aprobado nada por el camino.
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(409);
    await app.close();
  });

  it("los siete comandos de step 17 siguen SIN admitir campos extra: un `slotKey` de más es un 400", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const res = await post(app, "/api/waitlist/entries/wl-f01/command", { command: "withdraw", slotKey: HUECO });
    expect(res.statusCode).toBe(400);
    expect(entryOf(await waitlistOf(app), "wl-f01")?.state).toBe("matched");
    await app.close();
  });

  it("un `slotKey` con forma inventada es un 400 del esquema, no un 409 del dominio", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    for (const malo of ["", "hueco-de-las-once", "slot-2026-08-04-780", "slot-04-08-2026-780-3"]) {
      const res = await post(app, "/api/waitlist/entries/wl-f01/command", {
        command: "approve_proposal",
        slotKey: malo,
      });
      expect(res.statusCode, malo).toBe(400);
    }
    await app.close();
  });

  it("viajan por la ruta de siempre y con la idempotencia de siempre: misma clave + otro `slotKey` = 409 de huella", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const clave = "aprobar:wl-f01:1";
    const primera = await post(
      app,
      "/api/waitlist/entries/wl-f01/command",
      { command: "approve_proposal", slotKey: HUECO },
      { "idempotency-key": clave },
    );
    expect(primera.statusCode).toBe(200);
    expect(primera.headers["idempotency-status"]).toBe("original");

    // La MISMA petición: se reproduce el cuerpo, no se ejecuta otra vez.
    const repetida = await post(
      app,
      "/api/waitlist/entries/wl-f01/command",
      { command: "approve_proposal", slotKey: HUECO },
      { "idempotency-key": clave },
    );
    expect(repetida.statusCode).toBe(200);
    expect(repetida.headers["idempotency-status"]).toBe("replayed");

    // La misma clave con OTRO hueco es una colisión de huella, no un replay:
    // una pantalla desfasada no puede colar una aprobación distinta.
    const distinta = await post(
      app,
      "/api/waitlist/entries/wl-f01/command",
      { command: "approve_proposal", slotKey: "slot-2026-08-04-810-3" },
      { "idempotency-key": clave },
    );
    expect(distinta.statusCode).toBe(409);
    expect((distinta.json() as Json).conflict).toBe("idempotency_key_reused_with_different_body");
    await app.close();
  });

  it("aprobar dos veces SIN cabecera de idempotencia sigue siendo 200 y no duplica nada (idempotencia de dominio)", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    expect((await command(app, "wl-f01", "approve_proposal", HUECO)).statusCode).toBe(200);
    const antes = await waitlistOf(app);
    expect((await command(app, "wl-f01", "approve_proposal", HUECO)).statusCode).toBe(200);
    const despues = await waitlistOf(app);
    expect(auditKinds(despues).filter((k) => k === "WAITLIST_PROPOSAL_APPROVED").length).toBe(1);
    expect(JSON.stringify(despues.audit)).toBe(JSON.stringify(antes.audit));
    await app.close();
  });
});

describe("step 23 · §6 — las cinco frases del registro, compuestas en el servidor y sin un solo identificador crudo", () => {
  const ctx = { cal: demoSalonVenue(), entries: freshWaitlistEntries(fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES)), cancellations: [] };
  function texto(kind: string, extra: Json = {}): string {
    return auditText(
      {
        id: "wla-probe",
        seq: 1,
        kind: kind as never,
        actor: "system",
        atISO: "2026-08-04T09:00:00.000Z",
        slotKey: "slot-2026-08-04-780-3",
        synthetic: true,
        ...extra,
      } as never,
      ctx,
    );
  }

  it("la propuesta automática nombra el hueco, la persona y la razón literal de R1", () => {
    expect(texto("WAITLIST_PROPOSAL_CREATED", { entryId: "wl-f01" })).toBe(
      "Propuesta automática para el hueco de las 13:00 con Álex (sintético): Cliente A. Primera persona compatible por orden de alta en lista. Pendiente de aprobación.",
    );
  });

  it("la aprobación dice, en la misma frase, que todavía no se ha avisado a nadie", () => {
    expect(texto("WAITLIST_PROPOSAL_APPROVED", { entryId: "wl-f01" })).toBe(
      "Un operador ha aprobado la propuesta del hueco de las 13:00: Cliente A. Todavía no se ha avisado a nadie.",
    );
  });

  it("la sustitución nombra a las dos personas y dice que la desplazada sigue en la lista", () => {
    expect(texto("WAITLIST_PROPOSAL_SUBSTITUTED", { entryId: "wl-f02", detail: { replacedEntryId: "wl-f01" } })).toBe(
      "Un operador ha propuesto a Cliente B en lugar de Cliente A para el hueco de las 13:00. Decisión del operador. Cliente A sigue en la lista.",
    );
  });

  it("la invalidación explica POR QUÉ, en castellano y sin códigos crudos", () => {
    expect(texto("WAITLIST_PROPOSAL_INVALIDATED", { entryId: "wl-f01", detail: { reasons: "slot_no_longer_free" } })).toBe(
      "La propuesta del hueco de las 13:00 para Cliente A ya no vale: Ese hueco ya no está libre.",
    );
    expect(texto("WAITLIST_PROPOSAL_INVALIDATED", { entryId: "wl-f01", detail: { reasons: "entry_no_longer_active" } })).toBe(
      "La propuesta del hueco de las 13:00 para Cliente A ya no vale: Esa persona ya no está activa en la lista.",
    );
    expect(
      texto("WAITLIST_PROPOSAL_INVALIDATED", { entryId: "wl-f01", detail: { reasons: "offer_no_longer_on_this_slot" } }),
    ).toBe("La propuesta del hueco de las 13:00 para Cliente A ya no vale: Esa persona ya no está emparejada con este hueco.");
  });

  it("cuando no encaja nadie, lo dice y no promete nada", () => {
    expect(texto("WAITLIST_PROPOSAL_NONE_AVAILABLE")).toBe(
      "Nadie de la lista encaja ahora mismo con el hueco de las 13:00. No hay propuesta.",
    );
  });

  it("ninguna de las cinco frases enseña un identificador crudo como explicación", () => {
    const frases = [
      texto("WAITLIST_PROPOSAL_CREATED", { entryId: "wl-f01" }),
      texto("WAITLIST_PROPOSAL_APPROVED", { entryId: "wl-f01" }),
      texto("WAITLIST_PROPOSAL_SUBSTITUTED", { entryId: "wl-f02", detail: { replacedEntryId: "wl-f01" } }),
      texto("WAITLIST_PROPOSAL_INVALIDATED", { entryId: "wl-f01", detail: { reasons: "slot_no_longer_free" } }),
      texto("WAITLIST_PROPOSAL_NONE_AVAILABLE"),
    ];
    for (const frase of frases) {
      expect(frase, frase).not.toContain("wl-f");
      expect(frase, frase).not.toContain("slot-2026");
      expect(frase, frase).not.toContain("cxl-");
      expect(frase, frase).not.toContain("_");
    }
  });

  it("la razón literal de R1 vive en WAITLIST_COPY y viaja en la instantánea, una sola vez y con estas palabras", () => {
    expect(WAITLIST_COPY.proposalReasonFifo).toBe("Primera persona compatible por orden de alta en lista.");
    expect(WAITLIST_COPY.proposalIsSuggestion).toBe(
      "Es una sugerencia del sistema, no una decisión. Nadie recibe este hueco hasta que una persona lo apruebe y avise.",
    );
    expect(WAITLIST_COPY.proposalOperatorChoice).toBe(
      "Elegida por el operador. La persona que proponía el sistema sigue en la lista y puede quedarse con otro hueco.",
    );
  });
});

// =====================================================================
// step 23 §7 — LOS CONTRATOS DE LA INSTANTÁNEA: forma, orden y filtro
// =====================================================================

const HUECO_A_LA_UNA = "slot-2026-08-04-780-3";
const HUECO_Y_MEDIA = "slot-2026-08-04-810-3";

/** El vocabulario CERRADO de tonos de la consola (A8 de step 21A). */
const TONOS = ["ok", "attention", "derived", "incomplete", "none"];

async function tarjetaDeHueco(app: FastifyInstance, key: string): Promise<Json> {
  return slotOf(await waitlistOf(app), key) as Json;
}

describe("step 23 · §7 — el bloque `waitlist` gana DOS claves y ni una más", () => {
  it("las claves de primer nivel son exactamente las diez esperadas", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    expect(Object.keys(await waitlistOf(app)).sort()).toEqual(
      ["activity", "attention", "audit", "cancellations", "copy", "entries", "integrity", "metrics", "policy", "releasedSlots"].sort(),
    );
    // Y la instantánea entera no gana ninguna clave de primer nivel.
    const snap = await snapshotOf(app);
    expect(Object.keys(snap)).not.toContain("proposals");
    expect(Object.keys(snap)).not.toContain("activity");
    expect(Object.keys(snap)).not.toContain("attention");
    await app.close();
  });

  it("la propuesta viaja por LISTA EXPLÍCITA: ni un campo del dominio se cuela por un spread", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const slot = await tarjetaDeHueco(app, HUECO_A_LA_UNA);
    const propuesta = slot.proposal as Json;
    expect(Object.keys(propuesta).sort()).toEqual(
      [
        "canApprove",
        "canSimulateNotice",
        "clientLabel",
        "decidedAtISO",
        "entryId",
        "invalidReasons",
        "originLabel",
        "proposedAtISO",
        "reasonLabel",
        // (Reparación R2-UX, defectos 3 y 4) Dos campos más, y ninguno del
        // dominio: la frase de QUÉ FALTA desde este peldaño y la confirmación
        // persistente de una sustitución, ya redactadas por el servidor.
        "stageNote",
        "statusCode",
        "statusLabel",
        "statusTone",
        "substitutedFromClientLabel",
        "substitutionNote",
      ].sort(),
    );
    // Los tres campos del MODELO que no son asunto del navegador no viajan:
    // `automaticEntryId` se traduce a `substitutedFromClientLabel`, `origin` a
    // `originLabel` y `status` a la escalera derivada de §4.
    for (const crudo of ["automaticEntryId", "origin", "status", "synthetic"]) {
      expect(Object.keys(propuesta), crudo).not.toContain(crudo);
    }
    // Y el hueco gana exactamente tres campos nuevos, ninguno más.
    expect(Object.keys(slot).sort()).toEqual(
      [
        "activityItemIds",
        "announcementLine",
        "cancellationId",
        "compatibleEntryIds",
        "decisionPending",
        "incompatible",
        "key",
        "label",
        "proposal",
        "readingOrderNote",
        "stillFree",
        "substitutableEntryIds",
      ].sort(),
    );
    await app.close();
  });

  it("la escalera de §4 llega resuelta, con etiqueta en texto y un tono del vocabulario cerrado", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");

    // 8 — pendiente de aprobación
    let p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.statusCode, p.statusLabel, p.statusTone]).toEqual(["pending_approval", "Pendiente de aprobación", "attention"]);
    expect(p.originLabel).toBe("Sistema");
    expect(p.reasonLabel).toBe("Primera persona compatible por orden de alta en lista.");
    expect(p.decidedAtISO).toBeNull();

    // 7 — aprobada, pendiente de avisar
    await approve(app, "wl-f01", HUECO_A_LA_UNA);
    p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.statusCode, p.statusLabel, p.statusTone]).toEqual(["approved", "Aprobada — pendiente de avisar", "ok"]);
    expect(p.decidedAtISO).toBe("2026-08-04T09:00:00");

    // 3 — aviso simulado
    await command(app, "wl-f01", "simulate_notice");
    p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.statusCode, p.statusLabel, p.statusTone]).toEqual([
      "notice_simulated",
      "Aviso simulado (no se ha enviado nada)",
      "derived",
    ]);

    // 2 — aceptada
    await command(app, "wl-f01", "record_acceptance");
    p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.statusCode, p.statusLabel, p.statusTone]).toEqual([
      "accepted",
      "Aceptada (respuesta registrada por el operador)",
      "ok",
    ]);

    // 1 — convertida (por encima de «ya no vale», aunque el hueco esté ocupado)
    await convert(app, "wl-f01", HUECO_A_LA_UNA);
    p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.statusCode, p.statusLabel, p.statusTone]).toEqual(["converted", "Convertida en reserva sintética", "ok"]);
    expect(p.invalidReasons).toEqual([]);
    await app.close();
  });

  it("los otros tres peldaños: rechazada, sustituida e invalidada, cada uno con su porqué", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");

    // 6 — sustituida por el operador, con la persona desplazada NOMBRADA.
    expect((await command(app, "wl-f02", "take_over_proposal", HUECO_A_LA_UNA)).statusCode).toBe(200);
    let p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.statusCode, p.statusLabel, p.statusTone]).toEqual([
      "substituted",
      "Aprobada — elegida por el operador",
      "ok",
    ]);
    expect(p.originLabel).toBe("Operador");
    expect(p.substitutedFromClientLabel).toBe("Cliente A");
    expect(p.reasonLabel).toBe(
      "Elegida por el operador. La persona que proponía el sistema sigue en la lista y puede quedarse con otro hueco.",
    );

    // 4 — rechazada. Por HTTP no se alcanza, y eso es correcto: `record_decline`
    // sobre el sujeto de una propuesta hace saltar T3 en el mismo tic y la
    // propuesta se retira. Se comprueba lo que SÍ se puede comprobar de punta
    // a punta —que el «no» retira la propuesta y, sin nadie más compatible,
    // deja el hueco sin ninguna— y el peldaño en sí se prueba abajo, llamando
    // a la proyección directamente.
    const app2 = freshApp();
    await reset(app2);
    await cancel(app2, "demo-salon-res-1");
    const huecoTardio = ((await waitlistOf(app2)).releasedSlots as Json[])[0] as Json;
    await approve(app2, "wl-f05", huecoTardio.key as string);
    await command(app2, "wl-f05", "simulate_notice");
    await command(app2, "wl-f05", "record_decline");
    expect((await tarjetaDeHueco(app2, huecoTardio.key as string)).proposal).toBeNull();

    // 5 — invalidada: el hueco se lo lleva una llamada, y NINGÚN disparador
    // repara nada entre medias, así que la propuesta se muestra rota con su
    // motivo escrito, exactamente como manda §3.2.
    const app3 = freshApp();
    await reset(app3);
    await cancel(app3, "demo-salon-res-2");
    await post(app3, "/api/scenario/run", {
      scenarioId: "A33-roba-el-hueco-de-la-propuesta",
      turns: [
        {
          utterance: "quiero reservar",
          day: "tuesday",
          time: "13:00",
          professionalId: ALEX_ID,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    p = (await tarjetaDeHueco(app3, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.statusCode, p.statusLabel, p.statusTone]).toEqual(["invalidated", "Ya no vale", "incomplete"]);
    expect((p.invalidReasons as Json[]).map((r) => r.code)).toEqual(["slot_no_longer_free"]);
    expect((p.invalidReasons as Json[]).map((r) => r.label)).toEqual(["Ese hueco ya no está libre"]);
    expect(p.canApprove).toBe(false);
    expect(p.canSimulateNotice).toBe(false);
    for (const a of [app, app2, app3]) await a.close();
  });

  it("`canApprove` y `canSimulateNotice` MANDAN: lo que el servidor promete, el servidor lo acepta", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");

    // Pendiente: se puede aprobar y NO se puede avisar. Las dos, comprobadas
    // contra el servidor real, no contra la opinión de la prueba.
    let p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.canApprove, p.canSimulateNotice]).toEqual([true, false]);
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(409);
    expect((await command(app, "wl-f01", "approve_proposal", HUECO_A_LA_UNA)).statusCode).toBe(200);

    // Aprobada: ya no se puede volver a «aprobar» como acción pendiente, y sí
    // se puede avisar.
    p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.canApprove, p.canSimulateNotice]).toEqual([false, true]);
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(200);

    // Avisada: ninguna de las dos, y el servidor coincide.
    p = (await tarjetaDeHueco(app, HUECO_A_LA_UNA)).proposal as Json;
    expect([p.canApprove, p.canSimulateNotice]).toEqual([false, false]);
    expect((await command(app, "wl-f01", "approve_proposal", HUECO_A_LA_UNA)).statusCode).toBe(409);
    expect((await command(app, "wl-f01", "simulate_notice")).statusCode).toBe(409);
    await app.close();
  });

  it("`substitutableEntryIds` es exactamente lo que `take_over_proposal` aceptaría, en orden de alta", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const slot = await tarjetaDeHueco(app, HUECO_A_LA_UNA);
    const sustituibles = slot.substitutableEntryIds as string[];
    // Ni la propuesta actual (no es «otra») ni los incompatibles.
    expect(sustituibles).toEqual(["wl-f02"]);
    expect(sustituibles).not.toContain((slot.proposal as Json).entryId);

    // Quien SÍ está en la lista es aceptado por el servidor…
    expect((await command(app, "wl-f02", "take_over_proposal", HUECO_A_LA_UNA)).statusCode).toBe(200);

    // …y quien NO está, rechazado. Ofrecerlo sería un botón que sólo puede 409.
    const app2 = freshApp();
    await reset(app2);
    await cancel(app2, "demo-salon-res-2");
    const fuera = ((await waitlistOf(app2)).entries as Json[])
      .map((e) => e.id as string)
      .filter((id) => !((slot.substitutableEntryIds as string[]).includes(id) || id === "wl-f01"));
    expect(fuera.length).toBeGreaterThan(0);
    for (const id of fuera) {
      expect((await command(app2, id, "take_over_proposal", HUECO_A_LA_UNA)).statusCode, id).toBe(409);
    }
    for (const a of [app, app2]) await a.close();
  });
});

describe("step 23 · §7/§8.2 — el rastro operativo: filtro cerrado, orden y claves estables", () => {
  it("ni un `kind` fuera de la lista blanca aparece — y los excluidos siguen enteros en el historial técnico", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    await approve(app, "wl-f01", HUECO_A_LA_UNA);
    await command(app, "wl-f01", "simulate_notice");
    await command(app, "wl-f01", "record_acceptance");
    await convert(app, "wl-f01", HUECO_A_LA_UNA);
    await post(app, "/api/waitlist/entries", {
      clientLabel: "Cliente H",
      serviceId: 1,
      dateFrom: "2026-08-05",
      dateTo: "2026-08-05",
      earliestStartMinutes: 600,
      latestStartMinutes: 720,
      professional: { kind: "any" },
      optInSource: "operator_entered",
      optInConfirmed: true,
    });
    await post(app, "/api/waitlist/policy", { cancellationNoticeMinutes: 60 });

    const wl = await waitlistOf(app);
    const actividad = (wl.activity as Json).items as Json[];
    const kindsTecnicos = auditKinds(wl);

    // (a) Todo lo que sale del filtro está en la lista blanca. El `kind` se
    // resuelve por CLAVE contra el historial técnico, no por posición: dos
    // listas ordenadas al revés la una de la otra harían de una comprobación
    // por índice una comprobación de nada.
    const kindPorId = new Map(
      (wl.audit as { items: Json[] }).items.map((e) => [e.id as string, e.kind as string]),
    );
    expect(kindsTecnicos.length).toBeGreaterThan(actividad.length);
    for (const item of actividad) {
      const kind = kindPorId.get(item.id as string);
      expect(kind, `la fila ${String(item.id)} no existe en el historial técnico`).toBeDefined();
      expect(ACTIVITY_KINDS as readonly string[], String(kind)).toContain(kind);
    }

    // (b) Y los prohibidos ocurrieron de verdad y NO aparecen: si no hubieran
    // ocurrido, este filtro no estaría filtrando nada.
    const prohibidos = [
      "DEMO_RESET",
      "WAITLIST_MATCH_EVALUATED",
      "WAITLIST_ENTRY_MATCHED",
      "WAITLIST_ENTRY_CREATED",
      "CANCELLATION_POLICY_CHANGED",
    ];
    const idsDeActividad = new Set(actividad.map((i) => i.id as string));
    for (const kind of prohibidos) {
      const tecnicos = (wl.audit as { items: Json[] }).items.filter((e) => e.kind === kind);
      expect(tecnicos.length, `${kind} no llegó a ocurrir: el filtro no prueba nada`).toBeGreaterThan(0);
      for (const e of tecnicos) expect(idsDeActividad.has(e.id as string), `${kind} se ha colado`).toBe(false);
    }
    await app.close();
  });

  it("orden por `seq` estrictamente descendente, claves únicas y estables entre dos sondeos", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    await approve(app, "wl-f01", HUECO_A_LA_UNA);

    const primera = ((await waitlistOf(app)).activity as Json).items as Json[];
    expect(primera.length).toBeGreaterThan(3);
    for (let i = 1; i < primera.length; i += 1) {
      expect(Number(primera[i]?.seq), "el rastro no va de más nuevo a más viejo").toBeLessThan(Number(primera[i - 1]?.seq));
    }
    expect(new Set(primera.map((i) => i.id)).size).toBe(primera.length);
    for (const item of primera) expect(String(item.id)).toMatch(/^wla-\d{8}$/);

    // Un segundo sondeo sin que pase nada: mismas claves, mismo orden, mismo
    // texto. Un rastro que se reordena solo hace saltar el foco del navegador.
    const segunda = ((await waitlistOf(app)).activity as Json).items as Json[];
    expect(JSON.stringify(segunda)).toBe(JSON.stringify(primera));
    await app.close();
  });

  it("cada fila trae origen, hora sintética, título corto, razón larga, píldora con texto y su enlace", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const items = ((await waitlistOf(app)).activity as Json).items as Json[];
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ["cancellationId", "entryId", "href", "id", "originLabel", "reason", "seq", "slotKey", "statusLabel", "statusTone", "timeLabel", "title"].sort(),
      );
      expect(["Sistema", "Operador"]).toContain(item.originLabel);
      expect(item.href).toBe("#/lista-espera");
      expect(String(item.timeLabel)).toMatch(/^\d{2}:\d{2}$/);
      expect(TONOS, String(item.statusTone)).toContain(item.statusTone);
      // Nunca sólo color: la píldora y las dos líneas llevan SIEMPRE texto.
      expect(String(item.statusLabel).length).toBeGreaterThan(0);
      expect(String(item.title).length).toBeGreaterThan(0);
      expect(String(item.reason).length).toBeGreaterThan(0);
      // Y ni un identificador crudo como explicación (§10).
      for (const texto of [item.title, item.reason, item.statusLabel]) {
        expect(String(texto), String(texto)).not.toMatch(/wl-f\d|slot-2026|cxl-|wla-/);
      }
    }
    // La hora es la del RELOJ SINTÉTICO, no la de pared: la demo arranca a las
    // 09:00 y nada la ha movido.
    expect(items.every((i) => i.timeLabel === "09:00")).toBe(true);
    await app.close();
  });

  it("`total` cuenta DESPUÉS del filtro y `shown` nunca pasa de sesenta", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const wl = await waitlistOf(app);
    const activity = wl.activity as Json;
    const permitidos = (wl.audit as { items: Json[] }).items.filter((e) =>
      (ACTIVITY_KINDS as readonly string[]).includes(e.kind as string),
    ).length;
    expect(activity.total).toBe(permitidos);
    expect(activity.total).toBeLessThan((wl.audit as Json).total as number);
    expect(activity.shown).toBe(Math.min(permitidos, ACTIVITY_ITEMS_SHOWN));
    expect((activity.items as Json[]).length).toBe(activity.shown);
    await app.close();
  });

  it("el historial contextual de un hueco es un subconjunto real del rastro, y el del hermano no se mezcla", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const wl = await waitlistOf(app);
    const idsDelRastro = new Set(((wl.activity as Json).items as Json[]).map((i) => i.id as string));
    const uno = slotOf(wl, HUECO_A_LA_UNA) as Json;
    const otro = slotOf(wl, HUECO_Y_MEDIA) as Json;

    for (const id of uno.activityItemIds as string[]) expect(idsDelRastro.has(id)).toBe(true);
    // La propuesta de las 13:00 está en SU hueco y no en el hermano.
    const propuestaId = ((wl.activity as Json).items as Json[]).find(
      (i) => i.slotKey === HUECO_A_LA_UNA && i.entryId === "wl-f01",
    )?.id as string;
    expect(uno.activityItemIds).toContain(propuestaId);
    expect(otro.activityItemIds).not.toContain(propuestaId);
    // Y la cancelación, que es de la cita entera, sale en los dos: es verdad
    // para los dos, y ocultarla en uno contaría la historia a medias.
    const cancelacionId = ((wl.activity as Json).items as Json[]).find((i) => i.slotKey === null)?.id as string;
    expect(uno.activityItemIds).toContain(cancelacionId);
    expect(otro.activityItemIds).toContain(cancelacionId);
    await app.close();
  });
});

describe("step 23 · §8.1 — el bloque de atención: sumando disjunto, sin doble conteo", () => {
  it("una tarjeta por propuesta PENDIENTE, con su titular, su detalle y su enlace con destino real", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const attention = (await waitlistOf(app)).attention as Json;
    expect(attention.pendingProposalCount).toBe(1);
    const tarjeta = (attention.cards as Json[])[0] as Json;
    expect(Object.keys(tarjeta).sort()).toEqual(
      ["cancellationId", "detail", "headline", "href", "slotKey", "statusLabel", "statusTone"].sort(),
    );
    expect(tarjeta.slotKey).toBe(HUECO_A_LA_UNA);
    expect(tarjeta.headline).toBe("Cancelación de las 13:00 · 2 huecos liberados · 1 propuesta pendiente de aprobación");
    expect(tarjeta.detail).toBe(
      "martes 4 de agosto, 13:00–13:30, con Álex (sintético) · Cliente A · Primera persona compatible por orden de alta en lista.",
    );
    expect(tarjeta.statusLabel).toBe("Pendiente de aprobación");
    expect(tarjeta.statusTone).toBe("attention");
    expect(tarjeta.href).toBe("#/lista-espera");
    await app.close();
  });

  it("aprobar retira la tarjeta sin cerrar el recado: la sugerencia no es la tarea", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const antes = await snapshotOf(app);
    const tareasAntes = (antes.metrics as Json).pendingHumanTasks as number;

    await approve(app, "wl-f01", HUECO_A_LA_UNA);
    const despues = await snapshotOf(app);
    expect(((despues.waitlist as Json).attention as Json).pendingProposalCount).toBe(0);
    expect((((despues.waitlist as Json).attention as Json).cards as Json[]).length).toBe(0);
    // `pendingHumanTasks` NO se toca: la tarea `DECIDE_WAITLIST_MATCH` es el
    // recado; la propuesta es la sugerencia PARA ese recado, no un recado más.
    expect((despues.metrics as Json).pendingHumanTasks).toBe(tareasAntes);
    await app.close();
  });

  it("los dos sumandos de la cabecera son DISJUNTOS: una llamada nunca es una propuesta", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const snap = await snapshotOf(app);
    const propuestas = ((snap.waitlist as Json).attention as Json).pendingProposalCount as number;
    const llamadas = (snap.metrics as Json).needsAttention as number;
    expect(propuestas).toBe(1);
    // Las tarjetas de propuesta se identifican por `slotKey`; las de llamada,
    // por `callId`. No hay ni un identificador compartido entre las dos listas,
    // así que la suma no puede contar dos veces lo mismo.
    const clavesDePropuesta = (((snap.waitlist as Json).attention as Json).cards as Json[]).map((c) => c.slotKey);
    expect(new Set(clavesDePropuesta).size).toBe(propuestas);
    expect(typeof llamadas).toBe("number");
    for (const clave of clavesDePropuesta) expect(String(clave)).toMatch(/^slot-/);
    await app.close();
  });

  it("el reinicio devuelve el rastro y la atención a su punto de partida documentado", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    await approve(app, "wl-f01", HUECO_A_LA_UNA);
    expect((((await waitlistOf(app)).activity as Json).items as Json[]).length).toBeGreaterThan(0);

    await reset(app);
    const wl = await waitlistOf(app);
    // `DEMO_RESET` no está en la lista blanca, así que el rastro operativo
    // arranca literalmente vacío — y sigue habiendo una fila técnica.
    expect(wl.activity).toEqual({ total: 0, shown: 0, items: [] });
    expect(wl.attention).toEqual({ pendingProposalCount: 0, cards: [] });
    expect(wl.releasedSlots).toEqual([]);
    expect(auditKinds(wl)).toEqual(["DEMO_RESET"]);
    await app.close();
  });

  it("repetir la aprobación con la misma Idempotency-Key no añade ni una fila al rastro", async () => {
    const app = freshApp();
    await reset(app);
    await cancel(app, "demo-salon-res-2");
    const clave = "aprobar:rastro:1";
    const cuerpo = { command: "approve_proposal", slotKey: HUECO_A_LA_UNA };
    expect((await post(app, "/api/waitlist/entries/wl-f01/command", cuerpo, { "idempotency-key": clave })).statusCode).toBe(200);
    const trasLaPrimera = (await waitlistOf(app)).activity as Json;

    expect((await post(app, "/api/waitlist/entries/wl-f01/command", cuerpo, { "idempotency-key": clave })).statusCode).toBe(200);
    const trasLaSegunda = (await waitlistOf(app)).activity as Json;
    // La repetición escribe `IDEMPOTENT_REPLAY`, que está FUERA de la lista
    // blanca: en el rastro operativo no se ve absolutamente nada nuevo.
    expect(JSON.stringify(trasLaSegunda)).toBe(JSON.stringify(trasLaPrimera));
    expect(auditKinds(await waitlistOf(app))).toContain("IDEMPOTENT_REPLAY");
    await app.close();
  });
});

describe("step 23 · §4 — el peldaño defensivo de la escalera, probado donde se puede probar", () => {
  /**
   * `declined` no se alcanza por HTTP: T3 retira la propuesta en el mismo tic
   * en que la persona dice que no. Sigue en la escalera porque es un contrato
   * de PRECEDENCIA — si un día T3 dejara de retirarla, la tarjeta tiene que
   * decir «Rechazada», que es la verdad, y no «Ya no vale», que sería una
   * explicación falsa. Probarlo llamando a la proyección directamente es la
   * única forma honesta: montar el estado por HTTP sería imposible, y fingir
   * que sí se alcanza sería peor que no probarlo.
   */
  it("una propuesta cuyo sujeto ha dicho que no se lee «Rechazada», por encima de «Ya no vale»", () => {
    const cal = demoSalonVenue();
    const clock = fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);
    const entradas = freshWaitlistEntries(clock).map((e) =>
      e.id === "wl-f01" ? { ...e, state: "declined" as const } : e,
    );
    const base: WaitlistStoreSnapshot = {
      entries: entradas,
      cancellations: [],
      releasedSlots: [
        {
          key: HUECO_A_LA_UNA,
          cancellationId: "cxl-demo-salon-res-2",
          employeeId: ALEX_ID,
          date: BOOKING_DEMO_TODAY,
          startMinutes: 780,
          endMinutes: 810,
          proposal: {
            entryId: "wl-f01",
            automaticEntryId: "wl-f01",
            origin: "system_first_compatible",
            status: "approved",
            proposedAtISO: clock.nowInstantISO(),
            decidedAtISO: clock.nowInstantISO(),
          },
        },
      ],
      auditLog: [],
      policy: { cancellationNoticeMinutes: 120, source: "demo_default" },
      nextEntryNumber: 1,
      nextOfferSeq: 1,
    };

    const propuesta = buildWaitlistSnapshot(cal, clock, base, []).releasedSlots[0]?.proposal;
    expect(propuesta?.statusCode).toBe("declined");
    expect(propuesta?.statusLabel).toBe("Rechazada");
    expect(propuesta?.statusTone).toBe("incomplete");
    // Y una propuesta rechazada no ofrece ni aprobar ni avisar.
    expect(propuesta?.canApprove).toBe(false);
    expect(propuesta?.canSimulateNotice).toBe(false);
  });
});
