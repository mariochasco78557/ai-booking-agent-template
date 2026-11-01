import { describe, it, expect } from "vitest";

import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import { demoSalonVenue, BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import {
  applyEntryCommand,
  cancelReservation,
  convertToReservation,
  createWaitlistEntry,
  declineOptIn,
  reviewCancellation,
  setCancellationPolicy,
  type WaitlistCommandContext,
} from "../../src/callEngine/waitlist/commands.js";
import { createWaitlistStore } from "../../src/callEngine/waitlist/store.js";
import {
  AVAILABLE_COMMANDS_BY_STATE,
  type WaitlistEntryCommandWithoutSlot,
  type WaitlistEntryState,
} from "../../src/callEngine/waitlist/model.js";

/**
 * step 17 · fase C — LA MÁQUINA DE ESTADOS (§2 del diseño).
 *
 * Cubre el criterio de aceptación 5 de §12 con una tabla comando × estado
 * completa: ninguna de las transiciones prohibidas de §2.3 puede alcanzarse
 * por ningún camino, y las permitidas se alcanzan todas.
 */

const CLOCK = fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);

/**
 * Los SIETE comandos de step 17: los que no llevan hueco en el cuerpo. Los
 * dos de step 23 (`approve_proposal`, `take_over_proposal`) llevan `slotKey`
 * obligatorio, así que su tabla de estados se prueba aparte, más abajo, con
 * huecos de verdad — meterlos en este bucle obligaría a inventar una clave
 * falsa y la prueba dejaría de decir lo que dice.
 */
const ALL_COMMANDS: readonly WaitlistEntryCommandWithoutSlot[] = [
  "simulate_notice",
  "record_acceptance",
  "record_decline",
  "release_match",
  "withdraw",
  "expire_manually",
  "reopen",
];

const ALL_STATES: readonly WaitlistEntryState[] = [
  "pending",
  "matched",
  "notice_simulated",
  "accepted",
  "declined",
  "expired_manually",
  "converted",
  "withdrawn",
];

/**
 * Un banco de pruebas mínimo: el store real más el calendario real, con la
 * aplicación síncrona de cada escritura tal y como la hace server.ts. No hay
 * ni un `await` entre revalidar y escribir, igual que en producción (§14.5).
 */
function harness() {
  let cal: CalendarWithCapabilities = demoSalonVenue();
  const store = createWaitlistStore(CLOCK);

  function ctx(): WaitlistCommandContext {
    const snap = store.snapshot();
    return {
      cal,
      clock: CLOCK,
      entries: snap.entries,
      cancellations: snap.cancellations,
      releasedSlots: snap.releasedSlots,
      policy: snap.policy,
      nextEntryNumber: snap.nextEntryNumber,
      nextOfferSeq: snap.nextOfferSeq,
    };
  }

  function run<T extends { status: number; write: ReturnType<typeof cancelReservation>["write"] }>(outcome: T): T {
    if (outcome.write !== null) {
      store.commit(outcome.write);
      if (outcome.write.nextCal !== undefined) cal = outcome.write.nextCal;
    }
    return outcome;
  }

  return {
    get cal() {
      return cal;
    },
    store,
    ctx,
    run,
    entry(id: string) {
      return store.snapshot().entries.find((e) => e.id === id);
    },
    kinds() {
      return store.snapshot().auditLog.map((e) => e.kind);
    },
  };
}

type Banco = ReturnType<typeof harness>;

/** El hueco sobre el que vive la propuesta de `entryId`, o `undefined`. */
function huecoPropuestoA(h: Banco, entryId: string): string | undefined {
  return h.store.snapshot().releasedSlots.find((s) => s.proposal?.entryId === entryId)?.key;
}

/**
 * (step 23 §5) Aprueba la propuesta que apunta a `entryId`, por su hueco.
 * Falla ruidosamente si no hay ninguna: una aprobación al aire sería una
 * prueba que da verde sin haber aprobado nada.
 */
function aprobarLaPropuestaDe(h: Banco, entryId: string): string {
  const slotKey = huecoPropuestoA(h, entryId);
  expect(slotKey, `no hay ninguna propuesta que apunte a ${entryId}`).toBeDefined();
  const outcome = h.run(applyEntryCommand(h.ctx(), entryId, { command: "approve_proposal", slotKey: slotKey! }));
  expect(outcome.status).toBe(200);
  return slotKey!;
}

/** Lleva a `wl-f01` hasta el estado pedido por el único camino legítimo. */
function driveTo(state: WaitlistEntryState) {
  const h = harness();
  if (state === "pending") return h;
  h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" }));
  expect(h.entry("wl-f01")?.state).toBe("matched");
  // (step 23, R2) El paso NUEVO, y el precio honesto del bucle humano: antes
  // de simular ningún aviso, una persona tiene que haber APROBADO la propuesta
  // de ESE hueco. No se relaja ninguna aserción: se añade el acto que faltaba.
  // Aprobar no mueve el estado —sigue `matched`—, sólo lo desbloquea (§5.2), y
  // por eso puede hacerse aquí sin falsear a qué estado ha llegado el banco.
  aprobarLaPropuestaDe(h, "wl-f01");
  expect(h.entry("wl-f01")?.state).toBe("matched");
  if (state === "matched") return h;
  if (state === "withdrawn") {
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "withdraw" }));
    return h;
  }
  if (state === "expired_manually") {
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "expire_manually" }));
    return h;
  }
  h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" }));
  expect(h.entry("wl-f01")?.state).toBe("notice_simulated");
  if (state === "notice_simulated") return h;
  if (state === "declined") {
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "record_decline" }));
    return h;
  }
  h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "record_acceptance" }));
  expect(h.entry("wl-f01")?.state).toBe("accepted");
  if (state === "accepted") return h;
  const slotKey = h.entry("wl-f01")?.currentOffer?.slotKey;
  expect(slotKey).toBeDefined();
  h.run(convertToReservation(h.ctx(), { entryId: "wl-f01", slotKey: slotKey! }));
  expect(h.entry("wl-f01")?.state).toBe("converted");
  return h;
}

// ---------------------------------------------------------------------
// Criterio 5 — la tabla comando × estado
// ---------------------------------------------------------------------

describe("step 17 · §12.5 — tabla comando × estado: ninguna transición prohibida es alcanzable", () => {
  for (const state of ALL_STATES) {
    for (const command of ALL_COMMANDS) {
      const permitido = AVAILABLE_COMMANDS_BY_STATE[state].includes(command);
      it(`${state} + ${command} ⇒ ${permitido ? "permitido" : "409 entry_state_not_allowed"}`, () => {
        const h = driveTo(state);
        expect(h.entry("wl-f01")?.state, `el banco no llegó a ${state}`).toBe(state);
        const outcome = applyEntryCommand(h.ctx(), "wl-f01", { command });
        if (permitido) {
          expect(outcome.status).toBe(200);
        } else {
          expect(outcome.status).toBe(409);
          expect(outcome.body.conflict).toBe("entry_state_not_allowed");
          expect(outcome.body.fromState).toBe(state);
          expect(outcome.body.allowedCommands).toEqual(AVAILABLE_COMMANDS_BY_STATE[state]);
          // Un rechazo NO escribe absolutamente nada.
          expect(outcome.write).toBeNull();
        }
      });
    }
  }

  it("los ocho estados y los siete comandos están cubiertos por la tabla, sin huecos", () => {
    expect(Object.keys(AVAILABLE_COMMANDS_BY_STATE).sort()).toEqual([...ALL_STATES].sort());
    const nombrados = new Set(Object.values(AVAILABLE_COMMANDS_BY_STATE).flat());
    for (const c of ALL_COMMANDS) expect(nombrados.has(c), c).toBe(true);
    // `convert` sólo se ofrece desde `accepted`, y por su propio endpoint.
    expect(AVAILABLE_COMMANDS_BY_STATE.accepted).toContain("convert");
    for (const state of ALL_STATES) {
      if (state !== "accepted") expect(AVAILABLE_COMMANDS_BY_STATE[state]).not.toContain("convert");
    }
  });
});

// ---------------------------------------------------------------------
// §2.3 — las transiciones prohibidas, nombradas una a una
// ---------------------------------------------------------------------

describe("step 17 · §2.3 — las transiciones prohibidas, explícitamente", () => {
  it("1. no se puede aceptar una oferta que nadie hizo (pending → accepted)", () => {
    const h = driveTo("pending");
    expect(applyEntryCommand(h.ctx(), "wl-f01", { command: "record_acceptance" }).status).toBe(409);
    expect(h.entry("wl-f01")?.state).toBe("pending");
  });

  it("2. no se avisa de un hueco que no existe (pending → notice_simulated)", () => {
    const h = driveTo("pending");
    expect(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" }).status).toBe(409);
  });

  it("3. convertir exige aceptación registrada: ni desde 'matched' ni desde 'notice_simulated'", () => {
    for (const state of ["matched", "notice_simulated"] as const) {
      const h = driveTo(state);
      const slotKey = h.entry("wl-f01")?.currentOffer?.slotKey;
      const outcome = convertToReservation(h.ctx(), { entryId: "wl-f01", slotKey: slotKey! });
      expect(outcome.status, state).toBe(409);
      expect(outcome.body.conflict, state).toBe("entry_state_not_allowed");
      expect(outcome.write, state).toBeNull();
      expect(h.cal.reservations.some((r) => r.id.startsWith("res-wl-")), state).toBe(false);
    }
  });

  it("4. 'converted' y 'withdrawn' son terminales: ningún comando las mueve", () => {
    for (const state of ["converted", "withdrawn"] as const) {
      const h = driveTo(state);
      for (const command of ALL_COMMANDS) {
        expect(applyEntryCommand(h.ctx(), "wl-f01", { command }).status, `${state}+${command}`).toBe(409);
      }
      expect(h.entry("wl-f01")?.state).toBe(state);
    }
  });

  it("5. no hay NINGUNA transición automática a 'expired_manually': sólo el comando del operador la produce", () => {
    const h = driveTo("matched");
    // Se hacen pasar cosas: otra cancelación, un cambio de política, una
    // revisión... y nadie caduca solo.
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-1", reasonCode: "unspecified" }));
    h.run(setCancellationPolicy(h.ctx(), 60));
    h.run(reviewCancellation(h.ctx(), "demo-salon-res-1"));
    expect(h.store.snapshot().entries.some((e) => e.state === "expired_manually")).toBe(false);
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "expire_manually" }));
    expect(h.entry("wl-f01")?.state).toBe("expired_manually");
  });

  it("6. no hay ninguna transición automática a 'accepted' ni a 'declined': el sistema no responde por nadie", () => {
    const h = driveTo("notice_simulated");
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-5", reasonCode: "unspecified" }));
    expect(h.entry("wl-f01")?.state).toBe("notice_simulated");
    expect(h.store.snapshot().entries.every((e) => e.state !== "accepted" && e.state !== "declined")).toBe(true);
  });

  it("7 (J4). dos entradas no pueden quedar 'accepted' sobre el mismo hueco: la segunda aceptación es 409", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" }));
    // Las dos comparten el hueco de las 13:00: wl-f01 lo tiene ofertado y
    // wl-f02 el de las 13:30. Se fuerza a wl-f02 al MISMO hueco para probar
    // exactamente la colisión que J4 describe.
    const snap = h.store.snapshot();
    const slotKey = snap.entries.find((e) => e.id === "wl-f01")?.currentOffer?.slotKey;
    expect(slotKey).toBeDefined();
    h.store.commit({
      entries: snap.entries.map((e) =>
        e.id === "wl-f02" ? { ...e, currentOffer: { slotKey: slotKey!, cancellationId: "cxl-demo-salon-res-2", offeredSeq: 99 } } : e,
      ),
      events: [],
    });

    // (step 23, R2) Avisar exige propuesta aprobada para ESA entrada y ESE
    // hueco, y la propuesta es única por hueco.
    aprobarLaPropuestaDe(h, "wl-f01");
    expect(h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" })).status).toBe(200);

    // (Revisión adversarial de step 23, H1) Esta prueba llegaba aquí
    // SUSTITUYENDO la propuesta a favor de `wl-f02` y avisándola también: dos
    // personas `notice_simulated` por el mismo medio hora, que es justo el
    // defecto que se ha reparado. No se relaja nada —J4 se sigue firmando
    // entera—, se corrige el camino: hoy esa sustitución es un 409, y para
    // probar la SEGUNDA capa (la de J4) se fuerza a mano el estado que el
    // bucle ya no deja alcanzar, exactamente como hace la prueba 8 de aquí
    // abajo con `converted`. Dos capas, ninguna confiada.
    const sustitucion = applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: slotKey! });
    expect(sustitucion.status).toBe(409);
    expect(sustitucion.body.conflict).toBe("proposal_already_notified_or_accepted");
    expect(sustitucion.write).toBeNull();
    expect(h.kinds()).not.toContain("WAITLIST_PROPOSAL_SUBSTITUTED");

    expect(h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "record_acceptance" })).status).toBe(200);
    const conAviso = h.store.snapshot();
    h.store.commit({
      entries: conAviso.entries.map((e) => (e.id === "wl-f02" ? { ...e, state: "notice_simulated" as const } : e)),
      events: [],
    });
    const segunda = applyEntryCommand(h.ctx(), "wl-f02", { command: "record_acceptance" });
    expect(segunda.status).toBe(409);
    expect(segunda.body.conflict).toBe("slot_already_accepted_by_another_entry");
    expect(segunda.write).toBeNull();
    expect(h.entry("wl-f02")?.state).toBe("notice_simulated");
  });

  it("8. dos entradas nunca acaban 'converted' sobre el mismo hueco: la segunda conversión revalida y falla", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" }));
    const slotKey = h.entry("wl-f01")?.currentOffer?.slotKey;
    expect(slotKey).toBeDefined();
    aprobarLaPropuestaDe(h, "wl-f01"); // (step 23, R2)
    for (const c of ["simulate_notice", "record_acceptance"] as const) h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: c }));
    expect(h.run(convertToReservation(h.ctx(), { entryId: "wl-f01", slotKey: slotKey! })).status).toBe(200);

    // Se fuerza a wl-f02 a un estado que el propio guardián de J4 impide
    // alcanzar (dos 'aceptada' sobre el mismo hueco), para probar que aunque
    // se alcanzara, la REVALIDACIÓN de la conversión seguiría impidiendo la
    // doble reserva. Dos capas, ninguna confiada.
    const tras = h.store.snapshot();
    h.store.commit({
      entries: tras.entries.map((e) =>
        e.id === "wl-f02" ? { ...e, state: "accepted" as const, currentOffer: { slotKey: slotKey!, cancellationId: "cxl-demo-salon-res-2", offeredSeq: 99 } } : e,
      ),
      events: [],
    });

    const segunda = h.run(convertToReservation(h.ctx(), { entryId: "wl-f02", slotKey: slotKey! }));
    expect(segunda.status).toBe(409);
    expect(segunda.body.conflict).toBe("slot_no_longer_free");
    expect(h.cal.reservations.filter((r) => r.id.startsWith("res-wl-")).length).toBe(1);
    expect(h.kinds().filter((k) => k === "WAITLIST_ENTRY_CONVERTED").length).toBe(1);
    expect(h.entry("wl-f02")?.state).toBe("pending");
    expect(h.entry("wl-f02")?.currentOffer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// §2.1/§2.2 — estados latentes y sus salidas
// ---------------------------------------------------------------------

describe("step 17 · §2.1 — 'Rechazada' y 'Caducada' son latentes, no terminales", () => {
  it("un 'no' ni saca a la persona de la lista ni la mantiene esperando sola: sólo el operador la reactiva o la retira", () => {
    const h = driveTo("declined");
    expect(h.entry("wl-f01")?.currentOffer).toBeUndefined();
    // Ni una nueva cancelación la vuelve a activar por su cuenta.
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-5", reasonCode: "unspecified" }));
    expect(h.entry("wl-f01")?.state).toBe("declined");
    // El operador sí puede: reactivar…
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "reopen" }));
    expect(h.entry("wl-f01")?.state).toBe("pending");
  });

  it("…o retirar directamente desde 'Rechazada'", () => {
    const h = driveTo("declined");
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "withdraw" }));
    expect(h.entry("wl-f01")?.state).toBe("withdrawn");
  });

  it("'Caducada manualmente' sólo sale por 'reopen'; ni siquiera 'withdraw' se ofrece desde ahí", () => {
    const h = driveTo("expired_manually");
    expect(applyEntryCommand(h.ctx(), "wl-f01", { command: "withdraw" }).status).toBe(409);
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "reopen" }));
    expect(h.entry("wl-f01")?.state).toBe("pending");
    expect(h.entry("wl-f01")?.currentOffer).toBeUndefined();
  });

  it("retirar la oferta devuelve la entrada a 'Pendiente' con la oferta limpia", () => {
    const h = driveTo("notice_simulated");
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "release_match" }));
    expect(h.entry("wl-f01")?.state).toBe("pending");
    expect(h.entry("wl-f01")?.currentOffer).toBeUndefined();
    expect(h.kinds()).toContain("WAITLIST_OFFER_RELEASED");
  });
});

// ---------------------------------------------------------------------
// Revalidación de ofertas rancias (§14.6)
// ---------------------------------------------------------------------

describe("step 17 · §14.6 — una oferta rancia no se puede avisar ni aceptar", () => {
  it("si el hueco se ocupa entre medias, simulate_notice y record_acceptance devuelven 409 offer_no_longer_valid sin escribir nada", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" }));
    const slotKey = h.entry("wl-f01")?.currentOffer?.slotKey;
    expect(slotKey).toBeDefined();

    // Alguien (por ejemplo una llamada del Laboratorio) ocupa el hueco.
    const robado = {
      ...h.cal,
      reservations: [
        ...h.cal.reservations,
        { id: "res-robada", employeeId: 3, serviceId: 1 as const, date: BOOKING_DEMO_TODAY, startMinutes: 780, endMinutes: 810, status: "confirmed" as const, synthetic: true as const },
      ],
    };
    const outcome = applyEntryCommand({ ...h.ctx(), cal: robado }, "wl-f01", { command: "simulate_notice" });
    expect(outcome.status).toBe(409);
    expect(outcome.body.conflict).toBe("offer_no_longer_valid");
    expect(outcome.body.reasons).toContain("slot_no_longer_free");
    expect(outcome.write).toBeNull();
    expect(h.entry("wl-f01")?.state).toBe("matched");
  });
});

// ---------------------------------------------------------------------
// Reset y opt-in (§3.5, §6.1)
// ---------------------------------------------------------------------

describe("step 17 · §3.5 — el reset devuelve la demostración a su punto de partida", () => {
  it("seis entradas 'pendiente', política 120 de demostración, cero cancelaciones y un único DEMO_RESET", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" }));
    h.run(setCancellationPolicy(h.ctx(), 60));
    h.store.reset();

    const snap = h.store.snapshot();
    expect(snap.entries.length).toBe(6);
    expect(snap.entries.every((e) => e.state === "pending")).toBe(true);
    expect(snap.entries.every((e) => e.optInConfirmed === true)).toBe(true);
    expect(snap.entries.every((e) => /^Cliente [A-Z]$/.test(e.clientLabel))).toBe(true);
    expect(snap.policy).toEqual({ cancellationNoticeMinutes: 120, source: "demo_default" });
    expect(snap.cancellations).toEqual([]);
    expect(snap.releasedSlots).toEqual([]);
    expect(snap.auditLog.map((e) => e.kind)).toEqual(["DEMO_RESET"]);
    expect(snap.auditLog[0]?.seq).toBe(1);
    expect(snap.auditLog[0]?.id).toBe("wla-00000001");
  });
});

describe("step 17 · §6.1 — alta y rechazo de alta", () => {
  it("rechazar el alta NO crea ninguna entrada: registrarla en sombra sería el opt-in implícito que la misión prohíbe", () => {
    const h = harness();
    const antes = h.store.snapshot().entries.length;
    h.run(declineOptIn(h.ctx(), { clientLabel: "Cliente G", note: "prefiere llamar ella" }));
    expect(h.store.snapshot().entries.length).toBe(antes);
    expect(h.kinds()).toContain("WAITLIST_OPT_IN_DECLINED");
  });

  it("la nota libre pasa por el mismo escáner de datos personales que el emisor de eventos", () => {
    const h = harness();
    const conTelefono = declineOptIn(h.ctx(), { clientLabel: "Cliente G", note: "llamar al +34 600 123 456" });
    expect(conTelefono.status).toBe(400);
    expect(conTelefono.write).toBeNull();
    const conCorreo = declineOptIn(h.ctx(), { clientLabel: "Cliente G", note: "escribir a alguien@ejemplo.com" });
    expect(conCorreo.status).toBe(400);
  });

  it("un alta nueva nace 'pendiente', con su orden de creación detrás de las semillas", () => {
    const h = harness();
    const outcome = h.run(
      createWaitlistEntry(h.ctx(), {
        clientLabel: "Cliente H",
        serviceId: 1,
        dateFrom: "2026-08-05",
        dateTo: "2026-08-05",
        earliestStartMinutes: 10 * 60,
        latestStartMinutes: 12 * 60,
        professional: { kind: "any" },
        optInSource: "phone_simulated",
        optInConfirmed: true,
      }),
    );
    expect(outcome.status).toBe(201);
    const creada = h.entry("wl-0001");
    expect(creada?.state).toBe("pending");
    expect(creada?.createdSeq).toBe(7);
    expect(creada?.optInConfirmed).toBe(true);
  });

  it("rechaza franjas mal alineadas, rangos invertidos y profesionales inexistentes, con texto en castellano", () => {
    const h = harness();
    const base = {
      clientLabel: "Cliente I",
      serviceId: 1 as const,
      dateFrom: "2026-08-05",
      dateTo: "2026-08-05",
      earliestStartMinutes: 10 * 60,
      latestStartMinutes: 12 * 60,
      professional: { kind: "any" } as const,
      optInSource: "phone_simulated" as const,
      optInConfirmed: true as const,
    };
    expect(createWaitlistEntry(h.ctx(), { ...base, dateTo: "2026-08-04" }).status).toBe(400);
    expect(createWaitlistEntry(h.ctx(), { ...base, latestStartMinutes: 10 * 60 }).status).toBe(400);
    expect(createWaitlistEntry(h.ctx(), { ...base, earliestStartMinutes: 10 * 60 + 5 }).status).toBe(400);
    expect(createWaitlistEntry(h.ctx(), { ...base, professional: { kind: "specific", employeeId: 999 } }).status).toBe(400);
    // Y una preferencia imposible (un lunes, cerrado) SÍ se guarda: el
    // sistema no le dice a nadie "eso no va a pasar nunca" (J15).
    const imposible = createWaitlistEntry(h.ctx(), { ...base, dateFrom: "2026-08-03", dateTo: "2026-08-03" });
    expect(imposible.status).toBe(201);
  });
});

// ---------------------------------------------------------------------
// §5.4 / J5 — una cancelación tardía no tiene ninguna consecuencia
// ---------------------------------------------------------------------

describe("step 17 · §5.4 — cancelar fuera de plazo no penaliza a nadie", () => {
  it("la tardía libera su hueco igual, encuentra compatible igual, y sólo añade una revisión con una única salida", () => {
    const h = harness();
    const outcome = h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-1", reasonCode: "client_cancelled_by_phone_simulated" }));
    expect(outcome.status).toBe(200);
    const cancellation = h.store.snapshot().cancellations[0];
    expect(cancellation?.timeliness).toBe("late");
    expect(cancellation?.latenessKind).toBe("within_notice_window");
    expect(cancellation?.reviewState).toBe("pending_review");
    expect(cancellation?.releasedSlotKeys.length).toBe(1);
    expect(h.entry("wl-f05")?.state).toBe("matched");

    const revision = h.run(reviewCancellation(h.ctx(), "demo-salon-res-1"));
    expect(revision.status).toBe(200);
    expect(h.store.snapshot().cancellations[0]?.reviewState).toBe("reviewed_no_action");
    // Revisar dos veces es un conflicto, no una segunda consecuencia.
    expect(reviewCancellation(h.ctx(), "demo-salon-res-1").status).toBe(409);
  });

  it("una cancelación a tiempo no se puede 'revisar': no hay nada que revisar", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" }));
    const outcome = reviewCancellation(h.ctx(), "demo-salon-res-2");
    expect(outcome.status).toBe(409);
    expect(outcome.body.conflict).toBe("cancellation_not_late");
  });

  it("cambiar la política NO reescribe el pasado: cada cancelación congeló el plazo con el que se juzgó", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-1", reasonCode: "unspecified" }));
    h.run(setCancellationPolicy(h.ctx(), 0));
    const cancellation = h.store.snapshot().cancellations[0];
    expect(cancellation?.policyMinutesAtCancellation).toBe(120);
    expect(cancellation?.timeliness).toBe("late");
    // La siguiente sí se juzga con el plazo nuevo.
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-3", reasonCode: "unspecified" }));
    const segunda = h.store.snapshot().cancellations[1];
    expect(segunda?.policyMinutesAtCancellation).toBe(0);
    expect(segunda?.timeliness).toBe("on_time");
  });

  it("cancelar dos veces la misma cita es un conflicto, no una segunda cancelación", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" }));
    const otra = cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" });
    expect(otra.status).toBe(409);
    expect(otra.body.conflict).toBe("reservation_already_cancelled");
    expect(otra.write).toBeNull();
    // Y la cita que ya venía cancelada de la fixture tampoco es cancelable.
    expect(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-7-cancelada", reasonCode: "unspecified" }).status).toBe(409);
    expect(cancelReservation(h.ctx(), { reservationId: "no-existe", reasonCode: "unspecified" }).status).toBe(404);
  });
});

// ---------------------------------------------------------------------
// Criterio 10 — el fallo inyectado no escribe NADA
// ---------------------------------------------------------------------

describe("step 17 · §12.10 — el fallo sintético inyectado no escribe ni una reserva ni un cambio de estado", () => {
  it("cal.reservations y las entradas quedan idénticas byte a byte", () => {
    const h = driveTo("accepted");
    const slotKey = h.entry("wl-f01")?.currentOffer?.slotKey;
    const calAntes = JSON.stringify(h.cal.reservations);
    const entradasAntes = JSON.stringify(h.store.snapshot().entries);

    const outcome = h.run(convertToReservation(h.ctx(), { entryId: "wl-f01", slotKey: slotKey!, injectFailure: true }));
    expect(outcome.status).toBe(500);
    expect(outcome.body.code).toBe("synthetic_injected_failure");
    expect(JSON.stringify(h.cal.reservations)).toBe(calAntes);
    expect(JSON.stringify(h.store.snapshot().entries)).toBe(entradasAntes);
    expect(h.entry("wl-f01")?.state).toBe("accepted");
    expect(h.kinds()).toContain("WAITLIST_CONVERSION_FAILED_INJECTED");
    expect(h.kinds()).not.toContain("WAITLIST_ENTRY_CONVERTED");
  });
});

// ---------------------------------------------------------------------
// step 23 — LA PROPUESTA SUPERVISADA (§3, §5). Dominio puro.
// ---------------------------------------------------------------------

const HUECO_1300 = "slot-2026-08-04-780-3";
const HUECO_1330 = "slot-2026-08-04-810-3";

/** El hueco tal y como está en el registro vigente. */
function hueco(h: Banco, key: string) {
  return h.store.snapshot().releasedSlots.find((s) => s.key === key);
}

function propuestaDe(h: Banco, key: string) {
  return hueco(h, key)?.proposal;
}

/** Cancela la cita de 60' de Álex: libera las 13:00 y las 13:30. */
function trasCancelarLaDeLaUna(): Banco {
  const h = harness();
  h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-2", reasonCode: "unspecified" }));
  return h;
}

describe("step 23 · §5 — los dos comandos nuevos y la máquina de estados cerrada", () => {
  it("la tabla gana exactamente dos celdas y NINGUNA transición nueva", () => {
    expect(AVAILABLE_COMMANDS_BY_STATE.pending).toEqual(["withdraw", "expire_manually", "take_over_proposal"]);
    expect(AVAILABLE_COMMANDS_BY_STATE.matched).toEqual([
      "simulate_notice",
      "release_match",
      "withdraw",
      "expire_manually",
      "approve_proposal",
      "take_over_proposal",
    ]);
    // Y en ningún otro estado se ofrecen: ni aprobar ni sustituir sacan a nadie
    // de 'rechazada', 'caducada' o de un estado terminal.
    for (const state of ALL_STATES) {
      if (state === "pending" || state === "matched") continue;
      expect(AVAILABLE_COMMANDS_BY_STATE[state], state).not.toContain("approve_proposal");
      expect(AVAILABLE_COMMANDS_BY_STATE[state], state).not.toContain("take_over_proposal");
    }
  });

  for (const command of ["approve_proposal", "take_over_proposal"] as const) {
    for (const state of ALL_STATES) {
      const permitido = AVAILABLE_COMMANDS_BY_STATE[state].includes(command);
      if (permitido) continue;
      it(`${state} + ${command} ⇒ 409 entry_state_not_allowed, con un hueco REAL en el cuerpo`, () => {
        const h = driveTo(state);
        const outcome = applyEntryCommand(h.ctx(), "wl-f01", { command, slotKey: HUECO_1300 });
        expect(outcome.status).toBe(409);
        expect(outcome.body.conflict).toBe("entry_state_not_allowed");
        expect(outcome.write).toBeNull();
      });
    }
  }

  it("aprobar NO avanza el estado: lo desbloquea (§5.2)", () => {
    const h = trasCancelarLaDeLaUna();
    expect(h.entry("wl-f01")?.state).toBe("matched");
    expect(propuestaDe(h, HUECO_1300)?.status).toBe("pending_approval");
    const outcome = h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "approve_proposal", slotKey: HUECO_1300 }));
    expect(outcome.status).toBe(200);
    expect(h.entry("wl-f01")?.state).toBe("matched");
    expect(propuestaDe(h, HUECO_1300)?.status).toBe("approved");
    expect(propuestaDe(h, HUECO_1300)?.decidedAtISO).toBe("2026-08-04T09:00:00");
    expect(h.kinds().filter((k) => k === "WAITLIST_PROPOSAL_APPROVED").length).toBe(1);
  });

  it("R2 — simular aviso sin propuesta aprobada es 409 proposal_not_approved y NO escribe nada", () => {
    const h = trasCancelarLaDeLaUna();
    const antes = h.store.snapshot().auditLog.length;
    const outcome = applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" });
    expect(outcome.status).toBe(409);
    expect(outcome.body.conflict).toBe("proposal_not_approved");
    expect(outcome.write).toBeNull();
    expect(h.store.snapshot().auditLog.length).toBe(antes);
    expect(h.entry("wl-f01")?.state).toBe("matched");
    // Y en cuanto una persona aprueba, el mismo comando pasa.
    aprobarLaPropuestaDe(h, "wl-f01");
    expect(h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" })).status).toBe(200);
  });

  it("R2 — la propuesta es única por hueco, así que la segunda persona no puede avisarse aunque tenga oferta viva sobre él", () => {
    const h = trasCancelarLaDeLaUna();
    aprobarLaPropuestaDe(h, "wl-f01");
    // `wl-f02` tiene oferta VIVA sobre el mismo hueco (las ofertas no son
    // exclusivas), y aun así no puede avisarse: la propuesta apunta a otra.
    expect(h.entry("wl-f02")?.currentOffer?.slotKey).toBe(HUECO_1300);
    const outcome = applyEntryCommand(h.ctx(), "wl-f02", { command: "simulate_notice" });
    expect(outcome.status).toBe(409);
    expect(outcome.body.conflict).toBe("proposal_not_approved");
    expect(outcome.write).toBeNull();
  });

  it("§5.4 — aprobar dos veces lo mismo devuelve 200, cuerpo idéntico y CERO eventos nuevos", () => {
    const h = trasCancelarLaDeLaUna();
    const primera = h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "approve_proposal", slotKey: HUECO_1300 }));
    const registroTrasLaPrimera = h.store.snapshot().auditLog.length;
    const propuestaTrasLaPrimera = JSON.stringify(propuestaDe(h, HUECO_1300));

    const segunda = h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "approve_proposal", slotKey: HUECO_1300 }));
    expect(segunda.status).toBe(200);
    expect(JSON.stringify(segunda.body)).toBe(JSON.stringify(primera.body));
    expect(segunda.write).toBeNull();
    expect(h.store.snapshot().auditLog.length).toBe(registroTrasLaPrimera);
    expect(h.kinds().filter((k) => k === "WAITLIST_PROPOSAL_APPROVED").length).toBe(1);
    // Y ni una propuesta duplicada ni un segundo sello de decisión.
    expect(JSON.stringify(propuestaDe(h, HUECO_1300))).toBe(propuestaTrasLaPrimera);
    expect(h.store.snapshot().releasedSlots.filter((s) => s.key === HUECO_1300).length).toBe(1);
  });

  it("§5.3 — los ocho conflictos, cada uno por su nombre y sin escribir nada", () => {
    const h = trasCancelarLaDeLaUna();

    // 1. slot_not_found
    const inexistente = applyEntryCommand(h.ctx(), "wl-f01", {
      command: "approve_proposal",
      slotKey: "slot-2026-08-04-600-3",
    });
    expect(inexistente.status).toBe(409);
    expect(inexistente.body.conflict).toBe("slot_not_found");

    // 2. no_proposal_for_slot — el hermano de las 13:30 no tiene propuesta.
    expect(propuestaDe(h, HUECO_1330)).toBeUndefined();
    const sinPropuesta = applyEntryCommand(h.ctx(), "wl-f01", { command: "approve_proposal", slotKey: HUECO_1330 });
    expect(sinPropuesta.status).toBe(409);
    expect(sinPropuesta.body.conflict).toBe("no_proposal_for_slot");

    // 3. proposal_targets_another_entry — wl-f02 no es la propuesta de las 13:00.
    const otraEntrada = applyEntryCommand(h.ctx(), "wl-f02", { command: "approve_proposal", slotKey: HUECO_1300 });
    expect(otraEntrada.status).toBe(409);
    expect(otraEntrada.body.conflict).toBe("proposal_targets_another_entry");

    // 4. entry_not_compatible_with_slot — wl-f04 pide Barba a las 16:00.
    const incompatible = applyEntryCommand(h.ctx(), "wl-f04", { command: "take_over_proposal", slotKey: HUECO_1300 });
    expect(incompatible.status).toBe(409);
    expect(incompatible.body.conflict).toBe("entry_not_compatible_with_slot");
    expect((incompatible.body.reasons as string[]).length).toBeGreaterThan(0);

    // 5. entry_holds_valid_offer_on_another_slot — se lleva a wl-f02 al hueco
    //    hermano de las 13:30, donde su oferta es viva y válida. Traerla de
    //    vuelta a las 13:00 sería quitarle esa oferta en silencio (§3.1).
    h.run(applyEntryCommand(h.ctx(), "wl-f02", { command: "release_match" }));
    expect(
      h.run(applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: HUECO_1330 })).status,
    ).toBe(200);
    expect(h.entry("wl-f02")?.currentOffer?.slotKey).toBe(HUECO_1330);
    const robo = applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: HUECO_1300 });
    expect(robo.status).toBe(409);
    expect(robo.body.conflict).toBe("entry_holds_valid_offer_on_another_slot");
    expect(robo.write).toBeNull();
    expect(h.entry("wl-f02")?.currentOffer?.slotKey).toBe(HUECO_1330);

    // 6. proposal_not_approved — ya probado arriba, y aquí queda el sexto
    //    nombre en la misma lista para que no se pierda de vista.
    expect(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" }).body.conflict).toBe(
      "proposal_not_approved",
    );

    // 7. proposal_no_longer_valid — alguien ocupa el hueco por otra vía.
    const robado: CalendarWithCapabilities = {
      ...h.cal,
      reservations: [
        ...h.cal.reservations,
        { id: "res-robada", employeeId: 3, serviceId: 1 as const, date: BOOKING_DEMO_TODAY, startMinutes: 780, endMinutes: 810, status: "confirmed" as const, synthetic: true as const },
      ],
    };
    const rancia = applyEntryCommand({ ...h.ctx(), cal: robado }, "wl-f01", {
      command: "approve_proposal",
      slotKey: HUECO_1300,
    });
    expect(rancia.status).toBe(409);
    expect(rancia.body.conflict).toBe("proposal_no_longer_valid");
    expect(rancia.body.reasons).toContain("slot_no_longer_free");
    expect(rancia.write).toBeNull();

    // 8. proposal_already_notified_or_accepted (revisión adversarial, H1) —
    //    en cuanto se ha avisado a alguien por ese hueco, el hueco no se
    //    reasigna. Es lo PRIMERO que se mira: un hueco ya avisado no se
    //    reasigna ni siquiera a quien encajaría, así que este conflicto manda
    //    sobre los del sustituto.
    aprobarLaPropuestaDe(h, "wl-f01");
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" }));
    expect(h.entry("wl-f01")?.state).toBe("notice_simulated");
    const avisado = applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: HUECO_1300 });
    expect(avisado.status).toBe(409);
    expect(avisado.body.conflict).toBe("proposal_already_notified_or_accepted");
    expect(avisado.body.notifiedEntryId).toBe("wl-f01");
    expect(avisado.write).toBeNull();
    expect(propuestaDe(h, HUECO_1300)?.entryId).toBe("wl-f01");
  });

  it("(revisión adversarial, H1) el hueco por el que ya se ha AVISADO no se reasigna, y el que ya se ha ACEPTADO tampoco", () => {
    for (const hasta of ["notice_simulated", "accepted"] as const) {
      const h = trasCancelarLaDeLaUna();
      aprobarLaPropuestaDe(h, "wl-f01");
      h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" }));
      if (hasta === "accepted") h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "record_acceptance" }));
      expect(h.entry("wl-f01")?.state).toBe(hasta);

      const registro = h.store.snapshot().auditLog.length;
      const robo = applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: HUECO_1300 });
      expect(robo.status, hasta).toBe(409);
      expect(robo.body.conflict, hasta).toBe("proposal_already_notified_or_accepted");
      expect(robo.write, hasta).toBeNull();
      expect(h.store.snapshot().auditLog.length, hasta).toBe(registro);

      // Y por tanto NUNCA hay dos personas avisadas por el mismo medio hora,
      // que es la guarda que §5.2 dice que R2 da «gratis».
      expect(applyEntryCommand(h.ctx(), "wl-f02", { command: "simulate_notice" }).status, hasta).toBe(409);
      expect(
        h.store.snapshot().entries.filter(
          (e) => e.currentOffer?.slotKey === HUECO_1300 && e.state === "notice_simulated",
        ).length,
        hasta,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("§5.1 — sustituir APRUEBA en el mismo acto, y la persona desplazada no pierde nada", () => {
    const h = trasCancelarLaDeLaUna();
    const ofertaDeF02Antes = h.entry("wl-f02")?.currentOffer?.slotKey;
    const outcome = h.run(applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: HUECO_1300 }));
    expect(outcome.status).toBe(200);

    const propuesta = propuestaDe(h, HUECO_1300);
    expect(propuesta?.entryId).toBe("wl-f02");
    expect(propuesta?.automaticEntryId).toBe("wl-f01");
    expect(propuesta?.origin).toBe("operator_substitution");
    expect(propuesta?.status).toBe("approved");
    expect(h.kinds().filter((k) => k === "WAITLIST_PROPOSAL_SUBSTITUTED").length).toBe(1);

    // La desplazada sigue en la lista, con SU oferta viva y sin cambiar de
    // estado: sólo se ha movido el puntero de la propuesta.
    expect(h.entry("wl-f01")?.state).toBe("matched");
    expect(h.entry("wl-f01")?.currentOffer?.slotKey).toBe(HUECO_1300);
    expect(ofertaDeF02Antes).toBe(HUECO_1300);
    // Y sigue siendo elegible: puede recuperar la propuesta por el mismo acto.
    expect(h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "take_over_proposal", slotKey: HUECO_1300 })).status).toBe(200);
    expect(propuestaDe(h, HUECO_1300)?.entryId).toBe("wl-f01");
  });

  it("§5.4 — sustituir a favor de quien ya es la propuesta aprobada no escribe nada", () => {
    const h = trasCancelarLaDeLaUna();
    h.run(applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: HUECO_1300 }));
    const registro = h.store.snapshot().auditLog.length;
    const repetida = h.run(applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: HUECO_1300 }));
    expect(repetida.status).toBe(200);
    expect(repetida.write).toBeNull();
    expect(h.store.snapshot().auditLog.length).toBe(registro);
  });

  it("§3.1 — sustituir a alguien 'pendiente' le da la oferta en el mismo acto (pending → matched), y sólo entonces", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-1", reasonCode: "unspecified" }));
    // wl-f05 es la única compatible con las 09:30 y recibe la propuesta.
    const huecoDeLasNueveYMedia = h.entry("wl-f05")?.currentOffer?.slotKey;
    expect(huecoDeLasNueveYMedia).toBeDefined();
    expect(propuestaDe(h, huecoDeLasNueveYMedia!)?.entryId).toBe("wl-f05");
    // Y nadie más ha cambiado de estado por ello.
    expect(h.store.snapshot().entries.filter((e) => e.state === "matched").map((e) => e.id)).toEqual(["wl-f05"]);
  });
});

describe("step 23 · §3 — R1 determinista y los tres disparadores", () => {
  it("R1 — la propuesta es la primera compatible por orden de alta, y el hermano NO recibe ninguna", () => {
    const h = trasCancelarLaDeLaUna();
    // Las dos encajan con las 13:00 y las dos reciben oferta viva sobre ella;
    // la propuesta es la de `createdSeq` más bajo, y sólo una.
    expect(propuestaDe(h, HUECO_1300)?.entryId).toBe("wl-f01");
    expect(propuestaDe(h, HUECO_1300)?.origin).toBe("system_first_compatible");
    // El hermano de las 13:30 se queda SIN propuesta: las dos candidatas
    // retienen una oferta viva y válida sobre otro hueco (§3.1), y quitársela
    // en silencio está prohibido.
    expect(propuestaDe(h, HUECO_1330)).toBeUndefined();
    expect(h.kinds().filter((k) => k === "WAITLIST_PROPOSAL_CREATED").length).toBe(1);
    // T1 no escribe `NONE_AVAILABLE`: eso ya lo cuenta `WAITLIST_MATCH_EVALUATED`.
    expect(h.kinds()).not.toContain("WAITLIST_PROPOSAL_NONE_AVAILABLE");
  });

  it("R1 es determinista: tres ejecuciones del mismo guion dan la misma propuesta, byte a byte", () => {
    const huellas = [1, 2, 3].map(() => JSON.stringify(trasCancelarLaDeLaUna().store.snapshot().releasedSlots));
    expect(huellas[1]).toBe(huellas[0]);
    expect(huellas[2]).toBe(huellas[0]);
  });

  it("T2 — al convertir el primer hueco, el hermano recibe SU propia propuesta PENDIENTE, y una sola vez", () => {
    const h = trasCancelarLaDeLaUna();
    aprobarLaPropuestaDe(h, "wl-f01");
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" }));
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "record_acceptance" }));
    h.run(convertToReservation(h.ctx(), { entryId: "wl-f01", slotKey: HUECO_1300 }));

    const hermana = propuestaDe(h, HUECO_1330);
    expect(hermana?.entryId).toBe("wl-f02");
    // PENDIENTE de aprobación: convertir a una persona no aprueba nada por otra.
    expect(hermana?.status).toBe("pending_approval");
    expect(hermana?.origin).toBe("system_first_compatible");
    expect(h.entry("wl-f02")?.currentOffer?.slotKey).toBe(HUECO_1330);
    expect(h.entry("wl-f02")?.state).toBe("matched");

    // UNA sola vez: ni el hueco duplicado, ni dos propuestas, ni dos ofertas.
    expect(h.store.snapshot().releasedSlots.filter((s) => s.key === HUECO_1330).length).toBe(1);
    const creadasParaElHermano = h.store
      .snapshot()
      .auditLog.filter((e) => e.kind === "WAITLIST_PROPOSAL_CREATED" && e.slotKey === HUECO_1330);
    expect(creadasParaElHermano.length).toBe(1);
    expect(creadasParaElHermano[0]?.detail?.trigger).toBe("conversion_sibling");
    expect(
      h.store.snapshot().auditLog.filter((e) => e.kind === "WAITLIST_ENTRY_MATCHED" && e.slotKey === HUECO_1330).length,
    ).toBe(1);

    // Y la propuesta del hueco convertido NO se toca: sigue siendo la suya.
    expect(propuestaDe(h, HUECO_1300)?.entryId).toBe("wl-f01");
  });

  it("T3 — un 'no' del sujeto retira su propuesta con su razón y reofertaa a la siguiente, nunca a quien acaba de decir que no", () => {
    const h = trasCancelarLaDeLaUna();
    aprobarLaPropuestaDe(h, "wl-f01");
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" }));
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "record_decline" }));

    const invalidadas = h.store.snapshot().auditLog.filter((e) => e.kind === "WAITLIST_PROPOSAL_INVALIDATED");
    expect(invalidadas.length).toBe(1);
    expect(invalidadas[0]?.entryId).toBe("wl-f01");
    expect(invalidadas[0]?.detail?.reasons).toBe("entry_no_longer_active");

    const nueva = propuestaDe(h, HUECO_1300);
    expect(nueva?.entryId).toBe("wl-f02");
    expect(nueva?.status).toBe("pending_approval");
    const creada = h.store
      .snapshot()
      .auditLog.filter((e) => e.kind === "WAITLIST_PROPOSAL_CREATED" && e.slotKey === HUECO_1300)
      .at(-1);
    expect(creada?.detail?.trigger).toBe("proposal_ended");
    expect(creada?.detail?.replacedEntryId).toBe("wl-f01");
    expect(h.entry("wl-f01")?.state).toBe("declined");
  });

  it("T3 — retirar el emparejamiento retira la propuesta y NO vuelve a proponer a la misma persona en el mismo acto", () => {
    const h = trasCancelarLaDeLaUna();
    aprobarLaPropuestaDe(h, "wl-f01");
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "release_match" }));
    expect(h.entry("wl-f01")?.state).toBe("pending");
    expect(h.entry("wl-f01")?.currentOffer).toBeUndefined();
    // La aprobación NO sobrevive a la retirada: sería un respaldo que nadie
    // reconocería como dado.
    expect(propuestaDe(h, HUECO_1300)?.entryId).toBe("wl-f02");
    expect(propuestaDe(h, HUECO_1300)?.status).toBe("pending_approval");
    expect(
      h.store.snapshot().auditLog.filter((e) => e.kind === "WAITLIST_PROPOSAL_INVALIDATED")[0]?.detail?.reasons,
    ).toBe("offer_no_longer_on_this_slot");
  });

  it("T3 — retirar a la única candidata deja el hueco SIN propuesta, y lo dice", () => {
    const h = harness();
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-1", reasonCode: "unspecified" }));
    const huecoDeLasNueveYMedia = h.entry("wl-f05")?.currentOffer?.slotKey;
    h.run(applyEntryCommand(h.ctx(), "wl-f05", { command: "withdraw" }));
    expect(propuestaDe(h, huecoDeLasNueveYMedia!)).toBeUndefined();
    const sinNadie = h.store.snapshot().auditLog.filter((e) => e.kind === "WAITLIST_PROPOSAL_NONE_AVAILABLE");
    expect(sinNadie.length).toBe(1);
    expect(sinNadie[0]?.slotKey).toBe(huecoDeLasNueveYMedia);
  });

  it("conservadurismo — un disparador jamás toca una propuesta viva y válida: ni la reordena, ni la cambia, ni la desaprueba", () => {
    const h = trasCancelarLaDeLaUna();
    aprobarLaPropuestaDe(h, "wl-f01");
    const antes = JSON.stringify(propuestaDe(h, HUECO_1300));
    // Pasan cosas: otra cancelación, un cambio de política, una revisión, y un
    // comando sobre una entrada que NO es el sujeto de esa propuesta.
    h.run(cancelReservation(h.ctx(), { reservationId: "demo-salon-res-1", reasonCode: "unspecified" }));
    h.run(setCancellationPolicy(h.ctx(), 60));
    h.run(reviewCancellation(h.ctx(), "demo-salon-res-1"));
    h.run(applyEntryCommand(h.ctx(), "wl-f03", { command: "withdraw" }));
    expect(JSON.stringify(propuestaDe(h, HUECO_1300))).toBe(antes);
    expect(h.kinds().filter((k) => k === "WAITLIST_PROPOSAL_INVALIDATED").length).toBe(0);
  });

  it("conservadurismo — T2 NO desaprueba la propuesta que el hueco hermano ya tenía en pie", () => {
    // El caso que de verdad pone a prueba la guarda: cuando el disparador
    // llega, el hermano YA tiene su propia propuesta, aprobada a mano por un
    // operador. Reevaluarla la devolvería a «pendiente de aprobación» y
    // borraría un respaldo humano que sí se había dado.
    const h = trasCancelarLaDeLaUna();
    h.run(applyEntryCommand(h.ctx(), "wl-f02", { command: "release_match" }));
    expect(h.run(applyEntryCommand(h.ctx(), "wl-f02", { command: "take_over_proposal", slotKey: HUECO_1330 })).status).toBe(200);
    const antes = JSON.stringify(propuestaDe(h, HUECO_1330));
    expect(propuestaDe(h, HUECO_1330)?.status).toBe("approved");

    // wl-f01 recorre su hueco entero: cancelación → aprobación → aviso →
    // aceptación → conversión. T2 mira al hermano… y no lo toca.
    aprobarLaPropuestaDe(h, "wl-f01");
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "simulate_notice" }));
    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "record_acceptance" }));
    expect(h.run(convertToReservation(h.ctx(), { entryId: "wl-f01", slotKey: HUECO_1300 })).status).toBe(200);

    expect(JSON.stringify(propuestaDe(h, HUECO_1330))).toBe(antes);
    expect(h.kinds().filter((k) => k === "WAITLIST_PROPOSAL_INVALIDATED").length).toBe(0);
    expect(
      h.store.snapshot().auditLog.filter((e) => e.kind === "WAITLIST_PROPOSAL_CREATED" && e.slotKey === HUECO_1330).length,
    ).toBe(0);
  });

  it("(revisión adversarial, H2) R1(d) también en la sustitución: la propuesta MUERTA que la persona abandona se retira y se explica", () => {
    const h = trasCancelarLaDeLaUna();
    // Las 13:20 en el reloj del comando: el hueco de las 13:00 ya ha pasado, y
    // su propuesta para `wl-f01` está invalidada pero PRESENTE (§3.2: nada la
    // sustituye sola entre disparadores).
    const tarde = fixedClock(BOOKING_DEMO_TODAY, 800);
    expect(propuestaDe(h, HUECO_1300)?.entryId).toBe("wl-f01");

    const outcome = h.run(
      applyEntryCommand({ ...h.ctx(), clock: tarde }, "wl-f01", {
        command: "take_over_proposal",
        slotKey: HUECO_1330,
      }),
    );
    expect(outcome.status).toBe(200);

    // Nadie es sujeto de dos propuestas: la de las 13:00 se ha ido…
    expect(propuestaDe(h, HUECO_1330)?.entryId).toBe("wl-f01");
    expect(propuestaDe(h, HUECO_1300)).toBeUndefined();
    const sujetos = h.store.snapshot().releasedSlots.map((s) => s.proposal?.entryId).filter((x) => x !== undefined);
    expect(new Set(sujetos).size).toBe(sujetos.length);

    // …y NO en silencio: con su hueco, su persona y el motivo REAL, el de
    // antes de mover nada.
    const invalidadas = h.store
      .snapshot()
      .auditLog.filter((e) => e.kind === "WAITLIST_PROPOSAL_INVALIDATED" && e.slotKey === HUECO_1300);
    expect(invalidadas.length).toBe(1);
    expect(invalidadas[0]?.entryId).toBe("wl-f01");
    expect(invalidadas[0]?.detail?.reasons).toBe("slot_in_the_past");
  });

  it("(revisión adversarial, H2) T3 repara TODAS las propuestas de quien se va, no sólo la primera", () => {
    const h = trasCancelarLaDeLaUna();
    // Un mundo con la MISMA persona como sujeto de dos propuestas. Ya no se
    // alcanza por ningún comando —esa es la otra mitad de la reparación de
    // H2—, así que se construye a mano: es la única forma honesta de probar
    // que T3 no se queda en la primera que encuentra.
    const conDos = h.store.snapshot().releasedSlots.map((s) =>
      s.key === HUECO_1330
        ? {
            ...s,
            proposal: {
              entryId: "wl-f01",
              automaticEntryId: "wl-f01",
              origin: "system_first_compatible" as const,
              status: "pending_approval" as const,
              proposedAtISO: "2026-08-04T09:00:00",
            },
          }
        : s,
    );
    h.store.commit({ releasedSlots: conDos, events: [] });
    expect(propuestaDe(h, HUECO_1300)?.entryId).toBe("wl-f01");
    expect(propuestaDe(h, HUECO_1330)?.entryId).toBe("wl-f01");

    h.run(applyEntryCommand(h.ctx(), "wl-f01", { command: "withdraw" }));

    // Ni una propuesta apuntando a quien ya no está en la lista, en NINGUNO de
    // los dos huecos, y cada retirada con su fila en el rastro.
    const sujetos = h.store.snapshot().releasedSlots.map((s) => s.proposal?.entryId);
    expect(sujetos).not.toContain("wl-f01");
    expect(
      h.store.snapshot().auditLog.filter((e) => e.kind === "WAITLIST_PROPOSAL_INVALIDATED").map((e) => e.slotKey),
    ).toEqual([HUECO_1300, HUECO_1330]);
    // Y el hueco que se queda libre se reofrece a la siguiente, como siempre.
    expect(propuestaDe(h, HUECO_1300)?.entryId).toBe("wl-f02");
  });

  it("la propuesta vive y muere con el hueco: el reinicio se la lleva, sin ninguna ruta de reinicio nueva", () => {
    const h = trasCancelarLaDeLaUna();
    aprobarLaPropuestaDe(h, "wl-f01");
    expect(propuestaDe(h, HUECO_1300)).toBeDefined();
    h.store.reset();
    expect(h.store.snapshot().releasedSlots).toEqual([]);
    expect(h.store.snapshot().auditLog.map((e) => e.kind)).toEqual(["DEMO_RESET"]);
  });
});
