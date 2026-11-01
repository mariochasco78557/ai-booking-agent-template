#!/usr/bin/env -S npx tsx
/**
 * Demo Salon — demostración local del motor de llamadas (step 13).
 *
 * LOCAL. SINTÉTICO. NO PRODUCCIÓN. Ejecuta el motor real
 * (`src/callEngine/engine.ts`, `runConversation`) diez veces, en el mismo
 * proceso, contra datos y una agenda enteramente inventados para esta
 * demostración (`src/callEngine/fixtures/*`). No hay ningún servidor, ningún
 * puerto, ninguna llamada de red, ningún fichero escrito y ninguna conexión
 * con el sistema real de Demo Salon en ningún momento.
 *
 * REGLA DE ORO: este fichero NUNCA escribe a mano una frase de resultado.
 * Cada línea que aparece como "el sistema responde" se obtiene resolviendo
 * el `phraseKey` (y sus `params`) que el propio motor devolvió, a través del
 * catálogo en castellano `src/callEngine/phrasing/es.ts` — exactamente el
 * mismo catálogo que usaría cualquier integración real de este motor. Todo
 * lo demás (títulos de escena, qué pide el cliente, qué garantiza cada
 * escena, el cierre) es narración de esta demostración, nunca una frase que
 * el sistema "diga".
 *
 * SEPARACIÓN DE PÚBLICO: por defecto, esta salida es para Bruno (no es
 * técnico) — nada de rutas, nombres de fichero, variables de entorno ni
 * jerga de infraestructura. Con `--tecnico` se añade, siempre ADEMÁS de la
 * línea sencilla y nunca en su lugar, el detalle técnico (outcome, reasonCode,
 * announcesSuccess, mutaciones, estado final, recuento de eventos).
 */

import * as readline from "node:readline/promises";

import { fixedClock } from "../../src/callEngine/domain/types.js";
import type { Clock, EmployeeId, ServiceId } from "../../src/callEngine/domain/types.js";
import { SERVICE_LABELS } from "../../src/callEngine/domain/types.js";
import { parseHHmm } from "../../src/callEngine/domain/time.js";
import {
  ALEX_ID,
  DANI_ID,
  NEREA_ID,
  SYNTHETIC_FIXTURE_BANNER,
} from "../../src/callEngine/fixtures/syntheticVenue.js";
import {
  demoSalonVenue,
  BOOKING_DEMO_NOW_MINUTES,
  BOOKING_DEMO_TODAY,
} from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { syntheticAudit } from "../../src/callEngine/fixtures/syntheticHolidays.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import type { EmployeeAbsence, VenueClosure } from "../../src/callEngine/calendar/model.js";
import { explainChoice } from "../../src/callEngine/allocation/anyProfessional.js";
import {
  runConversation,
  type ConversationResult,
  type ConversationTurn,
  type DayName,
} from "../../src/callEngine/engine.js";
import { createCallEventEmitter, type CallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore, type MemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { ES } from "../../src/callEngine/phrasing/es.js";
import type { PhraseKey } from "../../src/callEngine/phrasing/keys.js";

// ---------------------------------------------------------------------
// Flags / terminal setup
// ---------------------------------------------------------------------

const args = process.argv.slice(2);
const TECNICO = args.includes("--tecnico");
const NO_PAUSE = args.includes("--no-pause");
for (const arg of args) {
  if (arg !== "--tecnico" && arg !== "--no-pause") {
    process.stderr.write(`Uso: tsx tools/call-engine-demo/demo-driver.ts [--no-pause] [--tecnico]\n`);
    process.exit(1);
  }
}

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const C_TITLE = useColor ? "[1;36m" : "";
const C_DIM = useColor ? "[2m" : "";
const C_RESET = useColor ? "[0m" : "";

function separator(): void {
  console.log("================================================================================");
}

function banner(title: string): void {
  console.log();
  separator();
  console.log(`${C_TITLE}${title}${C_RESET}`);
  separator();
  console.log();
}

function note(text: string): void {
  console.log(`${C_DIM}${text}${C_RESET}`);
}

function tecnico(text: string): void {
  if (TECNICO) note(`[detalle técnico] ${text}`);
}

async function pause(): Promise<void> {
  if (NO_PAUSE || process.stdout.isTTY !== true) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\nPulsa Enter para continuar...");
  rl.close();
}

// ---------------------------------------------------------------------
// Estado compartido de toda la demostración: un único reloj fijo, un único
// almacén en memoria y un único emisor de eventos, reutilizados en las diez
// escenas — igual que un único proceso serviría todas las llamadas de una
// sesión. Lo único que cambia entre escenas es la AGENDA (`cal`), construida
// de cero para cada escena a partir de los mismos datos sintéticos base, de
// forma que una escena nunca queda afectada por lo que ocurrió en otra
// escena distinta (salvo cuando la propia escena narra explícitamente una
// continuación, p. ej. la escena 2 sobre la reserva de la escena 1).
// ---------------------------------------------------------------------

// "Hoy" sintético: MARTES 2026-08-04, 09:00 (step 14, decisión D4). Antes
// era 2026-08-02, que es DOMINGO — y con el horario real del local (lunes y
// domingo cerrados) la demo habría narrado un día cerrado como si fuera
// normal.
const clock: Clock = fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);
const store: MemoryStore = createMemoryStore();
const emitter: CallEventEmitter = createCallEventEmitter();
const SALT = "call-engine-demo-salt";

const DAY_ES: Readonly<Record<DayName, string>> = {
  sunday: "domingo",
  monday: "lunes",
  tuesday: "martes",
  wednesday: "miércoles",
  thursday: "jueves",
  friday: "viernes",
  saturday: "sábado",
};

/**
 * Agenda sintética de partida: los tres profesionales inventados de la demo,
 * ya con el horario declarado de Demo Salon (`demoSalonVenue()`, step 14) —lunes y
 * domingo cerrados, y la temporada fechada de agosto—, sin cierres ni
 * ausencias y SIN las citas de muestra del fixture: cada escena construye su
 * propio estado y no debe heredar el de la consola.
 */
function freshCalendar(overrides: {
  closures?: readonly VenueClosure[];
  absences?: readonly EmployeeAbsence[];
} = {}): CalendarWithCapabilities {
  const venue = demoSalonVenue();
  return {
    ...venue,
    closures: overrides.closures ?? [],
    venueRules: [],
    absences: overrides.absences ?? [],
    overrides: [],
    reservations: [],
  };
}

const DISPLAY_NAME: Readonly<Record<EmployeeId, string>> = {
  [ALEX_ID]: "Álex",
  [DANI_ID]: "Dani",
  [NEREA_ID]: "Nerea",
};

function professionalLabel(employeeId: EmployeeId | undefined): string {
  if (employeeId === undefined) return "(sin asignar)";
  return DISPLAY_NAME[employeeId] ?? `profesional ${employeeId}`;
}

/** Ejecuta una llamada sintética real contra el motor y cuenta como una llamada más de la sesión. */
function call(
  cal: CalendarWithCapabilities,
  scenarioId: string,
  turns: readonly ConversationTurn[],
  liveTransferAvailable?: boolean,
): ConversationResult {
  return runConversation(
    {
      cal,
      clock,
      emitter,
      store,
      salt: SALT,
      ...(liveTransferAvailable !== undefined ? { liveTransferAvailable } : {}),
    },
    { scenarioId, callId: `demo-${scenarioId}`, turns },
  );
}

/** Añade la reserva (si la hubo) de `result` a `cal`, igual que haría una revalidación real — usado solo dentro de una misma escena para encadenar dos llamadas. */
function fold(cal: CalendarWithCapabilities, result: ConversationResult): CalendarWithCapabilities {
  if (result.reservation === undefined) return cal;
  return { ...cal, reservations: [...cal.reservations, result.reservation] };
}

/** Imprime, en castellano, las frases que el propio motor devolvió para esta llamada — nunca un texto inventado aquí. `skipFraming` omite el saludo/despedida de apertura y cierre (que son siempre los mismos), para no repetirlos en cada escena. */
function speak(result: ConversationResult, skipFraming = true): void {
  for (const turn of result.turns) {
    if (skipFraming && (turn.phraseKey === "GREETING_DEMO_FRAME" || turn.phraseKey === "FAREWELL")) continue;
    const resolve = ES[turn.phraseKey as PhraseKey];
    const text = resolve(turn.params);
    console.log(`  Sistema: ${text}`);
  }
}

function tecnicoResult(result: ConversationResult): void {
  tecnico(`resultado interno = outcome:${result.outcome} reasonCode:${result.reasonCode}`);
  tecnico(
    `anuncia éxito:${String(result.announcesSuccess)} cambia algo real:${String(result.externalMutation)} cambia algo sintético:${String(result.syntheticMutation)}`,
  );
  tecnico(`estado final del motor: ${result.finalState}`);
}

let scenesShown = 0;

async function scene(number: number, title: string, body: () => void): Promise<void> {
  banner(`ESCENA ${String(number).padStart(2, "0")} — ${title}`);
  body();
  scenesShown += 1;
  await pause();
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

async function main(): Promise<void> {
  banner("INTRODUCCIÓN");
  console.log(SYNTHETIC_FIXTURE_BANNER);
  console.log();
  console.log(
    "Esto es una demostración local, con datos inventados, de la parte del motor de la",
  );
  console.log(
    "peluquería que decide qué contestar cuando alguien llama para pedir cita. No está",
  );
  console.log("conectada al sistema real de Demo Salon y no cambia ninguna agenda real.");
  console.log();
  console.log(
    "El problema que resuelve: hoy, cada llamada interrumpe a alguien del equipo mientras",
  );
  console.log(
    "tiene las manos ocupadas cortando el pelo a un cliente. Este motor está pensado para",
  );
  console.log(
    "contestar solo cuando puede hacerlo con seguridad, y para avisar al equipo solo",
  );
  console.log("cuando de verdad hace falta una persona — nunca en una reserva normal.");
  console.log();
  console.log(
    "Vas a ver diez situaciones. En cada una: qué pide el cliente (inventado), qué le",
  );
  console.log(
    "contesta el sistema (con sus propias palabras, tal cual las genera ahora mismo) y qué",
  );
  console.log("queda garantizado con esa respuesta.");
  tecnico("cada llamada se ejecuta con runConversation() del motor real (src/callEngine/engine.ts).");
  tecnico(`reloj fijo (no se lee la hora real): ${BOOKING_DEMO_TODAY} 09:00. Todo el estado vive en memoria.`);
  await pause();

  // ---------------------------------------------------------------------
  // ESCENA 1 — reserva con un profesional concreto
  // ---------------------------------------------------------------------
  let cal1 = freshCalendar();
  let r1!: ConversationResult;
  await scene(1, "RESERVA CON UN PROFESIONAL CONCRETO", () => {
    console.log(
      `El cliente pide: ${SERVICE_LABELS[1 as ServiceId]}, el miércoles a las 10:00, concretamente con Álex.`,
    );
    r1 = call(cal1, "A01-reserva-concreta", [
      {
        utterance: "quiero reservar una cita",
        day: "wednesday",
        time: "10:00",
        professionalId: ALEX_ID,
        serviceId: 1,
        serviceConfirmed: true,
        bookingConfirmed: true,
      },
    ]);
    speak(r1);
    console.log();
    console.log(
      `Garantía: la reserva queda anotada en la agenda sintética con el profesional pedido (${professionalLabel(r1.reservation?.employeeId)}); no se ha tocado ninguna agenda real.`,
    );
    tecnicoResult(r1);
  });
  cal1 = fold(cal1, r1);

  // ---------------------------------------------------------------------
  // ESCENA 2 — "me da igual quién" -> reparto de carga
  // ---------------------------------------------------------------------
  await scene(2, "«ME DA IGUAL QUIÉN» — REPARTO DE CARGA DE TRABAJO", () => {
    console.log(
      `El cliente pide: ${SERVICE_LABELS[1 as ServiceId]}, el miércoles a las 11:00, y dice que le da igual quién le atienda.`,
    );
    const explanation = explainChoice(cal1, "2026-08-05", parseHHmm("11:00"), 1);
    console.log();
    console.log("Antes de contestar, el sistema mira quién puede atender ese hueco y cómo tiene el resto del día:");
    for (const employeeId of explanation.candidates) {
      const remaining = explanation.remainingSlotCounts[employeeId] ?? 0;
      const confirmed = explanation.confirmedReservationCounts[employeeId] ?? 0;
      console.log(
        `  - ${professionalLabel(employeeId)}: le quedan ${remaining} huecos libres el resto del día y ya tiene ${confirmed} cita(s) confirmada(s) ese día.`,
      );
    }
    // La regla se explica tal y como es, no como quedaría más bonita. Decir
    // simplemente "elige al que menos trabajo tiene" sería una simplificación
    // que oculta los desempates, y esta demo existe para que Bruno entienda la
    // regla de verdad antes de aprobarla.
    console.log("La regla, en orden, es esta:");
    console.log("  1º quién puede hacer ese servicio y tiene ese hueco libre;");
    console.log("  2º de esos, quien MÁS huecos libres le queden ese día;");
    console.log("  3º si empatan, quien MENOS citas confirmadas tenga ese día;");
    console.log("  4º si siguen empatando, un criterio fijo para que el resultado nunca sea al azar.");
    console.log(`Con eso, queda asignado a: ${professionalLabel(explanation.chosen ?? undefined)}.`);
    const r2 = call(cal1, "A02-reparto-de-carga", [
      {
        utterance: "me da igual quien, quiero reservar una cita",
        day: "wednesday",
        time: "11:00",
        professionalId: "any",
        serviceId: 1,
        serviceConfirmed: true,
        bookingConfirmed: true,
      },
    ]);
    console.log();
    speak(r2);
    console.log();
    console.log(
      `Garantía: el reparto nunca es al azar — sigue esa regla en ese orden, así que con los mismos datos sale siempre lo mismo. Aquí queda asignado a ${professionalLabel(r2.reservation?.employeeId)}.`,
    );
    tecnicoResult(r2);
  });

  // ---------------------------------------------------------------------
  // ESCENA 3 — no hay hueco a esa hora exacta -> alternativas
  // ---------------------------------------------------------------------
  await scene(3, "NO HAY HUECO A ESA HORA EXACTA", () => {
    let cal3 = freshCalendar();
    console.log("Antes de esta llamada, esa hora concreta ya está ocupada (otra cita, en esta agenda de pruebas).");
    const occupy = call(cal3, "A03a-hueco-ya-ocupado", [
      {
        utterance: "quiero reservar una cita",
        day: "wednesday",
        time: "10:00",
        professionalId: ALEX_ID,
        serviceId: 1,
        serviceConfirmed: true,
        bookingConfirmed: true,
      },
    ]);
    cal3 = fold(cal3, occupy);
    console.log();
    console.log(
      `El cliente pide: ${SERVICE_LABELS[1 as ServiceId]}, el miércoles a las 10:00, con Álex — justo la hora que ya está ocupada.`,
    );
    const r3 = call(cal3, "A03b-consulta-mismo-hueco", [
      {
        utterance: "quiero consultar disponibilidad",
        day: "wednesday",
        time: "10:00",
        professionalId: ALEX_ID,
        serviceId: 1,
        serviceConfirmed: true,
      },
    ]);
    speak(r3);
    console.log();
    console.log(
      "Garantía: nunca se dice que esté lleno sin más — siempre se ofrece un día o una hora concretos dentro del horario de referencia.",
    );
    tecnicoResult(r3);
  });

  // ---------------------------------------------------------------------
  // ESCENA 4 — día festivo o local cerrado
  // ---------------------------------------------------------------------
  await scene(4, "DÍA FESTIVO O LOCAL CERRADO", () => {
    const cal4 = freshCalendar({
      closures: [
        {
          id: "demo-cierre-festivo",
          kind: "full_closure",
          startDate: "2026-08-04",
          endDate: "2026-08-04",
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
    });
    console.log("En esta agenda de pruebas, el martes el local está cerrado (festivo / cierre).");
    console.log(
      `El cliente pide: ${SERVICE_LABELS[1 as ServiceId]}, el martes a las 10:00, con Álex.`,
    );
    const r4 = call(cal4, "A04-festivo-local-cerrado", [
      {
        utterance: "quiero reservar una cita",
        day: "tuesday",
        time: "10:00",
        professionalId: ALEX_ID,
        serviceId: 1,
        serviceConfirmed: true,
        bookingConfirmed: true,
      },
    ]);
    speak(r4);
    console.log();
    console.log("Garantía: no se inventa un hueco en un día cerrado; se invita a mirar otro día u hora.");
    tecnicoResult(r4);
  });

  // ---------------------------------------------------------------------
  // ESCENA 5 — profesional de vacaciones -> se ofrece otro
  // ---------------------------------------------------------------------
  await scene(5, "EL PROFESIONAL PEDIDO NO ESTÁ — Y EL CLIENTE ACEPTA A CUALQUIERA", () => {
    const cal5 = freshCalendar({
      absences: [
        {
          id: "demo-ausencia-dani",
          employeeId: DANI_ID,
          kind: "vacation",
          startDate: "2026-08-05",
          endDate: "2026-08-05",
          allDay: true,
          source: "manual_override",
          approval: "approved",
          audit: syntheticAudit(),
        },
      ],
    });
    console.log("En esta agenda de pruebas, Dani no está disponible ese día (el motivo no se comparte con el cliente).");
    console.log(
      `El cliente pide, primero: ${SERVICE_LABELS[1 as ServiceId]}, el miércoles a las 10:00, concretamente con Dani.`,
    );
    const r5a = call(cal5, "A05a-pide-al-que-no-esta", [
      {
        utterance: "quiero reservar una cita con Dani",
        day: "wednesday",
        time: "10:00",
        professionalId: DANI_ID,
        serviceId: 1,
        serviceConfirmed: true,
        bookingConfirmed: true,
      },
    ]);
    speak(r5a);
    console.log();
    console.log("El cliente responde: de acuerdo, que le atienda cualquiera que esté libre a esa hora.");
    const r5b = call(cal5, "A05b-cualquiera-libre", [
      {
        utterance: "vale, pues quiero reservar con cualquiera, me sirve cualquiera",
        day: "wednesday",
        time: "10:00",
        professionalId: "any",
        serviceId: 1,
        serviceConfirmed: true,
        bookingConfirmed: true,
      },
    ]);
    speak(r5b);
    console.log();
    console.log(
      `Garantía: en ningún momento se dice por qué Dani no está disponible — solo que no lo está. Al aceptar a cualquiera, queda asignado a ${professionalLabel(r5b.reservation?.employeeId)}, un profesional distinto y realmente libre.`,
    );
    tecnico(`primera llamada -> outcome:${r5a.outcome} reasonCode:${r5a.reasonCode}`);
    tecnico(`segunda llamada -> outcome:${r5b.outcome} reasonCode:${r5b.reasonCode}`);
  });

  // ---------------------------------------------------------------------
  // ESCENA 6 — servicio especial -> deriva a una persona
  // ---------------------------------------------------------------------
  await scene(6, "UN SERVICIO ESPECIAL (COLOR) SE DERIVA A UNA PERSONA", () => {
    const cal6 = freshCalendar();
    console.log("El cliente pide: quiere hacerse color (un servicio que esta demo no gestiona sola).");
    const r6 = call(cal6, "A06-servicio-especial", [{ utterance: "quiero teñirme el pelo, hacerme color" }]);
    speak(r6);
    console.log();
    console.log(
      "Garantía: no se inventa ni una duración ni un hueco libre para un servicio que el sistema no conoce; se deriva a una persona antes de decir nada más.",
    );
    tecnicoResult(r6);
  });

  // ---------------------------------------------------------------------
  // ESCENA 7 — fallo técnico -> nunca se anuncia éxito
  // ---------------------------------------------------------------------
  await scene(7, "UN FALLO TÉCNICO NUNCA SE DISFRAZA DE ÉXITO", () => {
    const cal7 = freshCalendar();
    console.log(
      `El cliente pide: ${SERVICE_LABELS[1 as ServiceId]}, el miércoles a las 10:00, con Álex — y, en esta prueba, se provoca a propósito un fallo técnico durante la operación.`,
    );
    const r7 = call(cal7, "A07-fallo-tecnico", [
      {
        utterance: "quiero reservar una cita",
        day: "wednesday",
        time: "10:00",
        professionalId: ALEX_ID,
        serviceId: 1,
        serviceConfirmed: true,
        bookingConfirmed: true,
        injectFailure: true,
      },
    ]);
    speak(r7);
    console.log();
    console.log(
      `Garantía: ante un fallo, nunca se dice que la reserva se ha hecho. Aquí announcesSuccess = ${String(r7.announcesSuccess)} y no queda ninguna reserva.`,
    );
    tecnicoResult(r7);
  });

  // ---------------------------------------------------------------------
  // ESCENA 8 — urgencia -> se solicita ayuda humana (nunca "le paso")
  // ---------------------------------------------------------------------
  await scene(8, "UNA URGENCIA PIDE AYUDA HUMANA", () => {
    const cal8 = freshCalendar();
    console.log("El cliente dice: es urgente, necesita que le atienda una persona ya.");
    const r8 = call(
      cal8,
      "A08-urgencia",
      [{ utterance: "es urgente, necesito ayuda humana ya", urgent: true }],
      true,
    );
    speak(r8);
    console.log();
    console.log(
      "Garantía: el sistema dice que ha SOLICITADO que una persona se ponga — nunca que ya le está atendiendo ni en cuánto tiempo lo hará.",
    );
    tecnicoResult(r8);
  });

  // ---------------------------------------------------------------------
  // ESCENA 9 — contraste: pedir ayuda interrumpe; una reserva normal no
  // ---------------------------------------------------------------------
  await scene(9, "UNA RESERVA NORMAL NO INTERRUMPE A NADIE", () => {
    console.log(
      "Primer caso: el cliente pide hablar con una persona por una duda (sin urgencia). Eso sí puede generar aviso interno para el equipo:",
    );
    const cal9a = freshCalendar();
    const r9a = call(
      cal9a,
      "A09a-ayuda-no-urgente",
      [{ utterance: "quiero hablar con una persona por una duda" }],
      false,
    );
    speak(r9a);
    const snapshotAfterA = store.snapshot();
    console.log(
      `  -> esto ha generado ${snapshotAfterA.humanTasks.length} aviso(s) interno(s) para el equipo hasta ahora.`,
    );
    console.log();
    console.log("Segundo caso: el cliente pide una cita normal, correcta, sin ninguna urgencia:");
    const cal9b = freshCalendar();
    const r9b = call(cal9b, "A09b-reserva-normal", [
      {
        utterance: "quiero reservar una cita",
        day: "wednesday",
        time: "12:00",
        professionalId: ALEX_ID,
        serviceId: 1,
        serviceConfirmed: true,
        bookingConfirmed: true,
      },
    ]);
    speak(r9b);
    const snapshotAfterB = store.snapshot();
    console.log(
      `  -> tras esta reserva normal, el número de avisos internos sigue en ${snapshotAfterB.humanTasks.length} — no ha subido.`,
    );
    console.log();
    console.log(
      "Garantía: pedir ayuda genera aviso para el equipo; una reserva correcta, en cambio, no interrumpe a nadie — que es exactamente el objetivo de este motor.",
    );
    tecnico(`primer caso -> outcome:${r9a.outcome} reasonCode:${r9a.reasonCode}`);
    tecnico(`segundo caso -> outcome:${r9b.outcome} reasonCode:${r9b.reasonCode}`);
  });

  // ---------------------------------------------------------------------
  // ESCENA 10 — cancelación/cambio sin identidad verificada
  // ---------------------------------------------------------------------
  await scene(10, "SIN IDENTIDAD VERIFICADA NO SE CANCELA NI SE CAMBIA NADA", () => {
    const cal10 = freshCalendar();
    console.log(
      "El cliente pide cancelar una cita, y afirma que se le puede reconocer por cómo llama (nada más que eso).",
    );
    const r10 = call(cal10, "A10-cancelar-sin-identidad", [
      { utterance: "quiero cancelar mi cita", identityProof: "verified" },
    ]);
    speak(r10);
    console.log();
    console.log(
      `Garantía: reconocer cómo llama alguien no basta como identidad — no se cancela ni se cambia nada.${r10.syntheticMutation ? "" : " Ninguna cita ha cambiado, ni siquiera en la agenda de pruebas."}`,
    );
    tecnicoResult(r10);
  });

  // ---------------------------------------------------------------------
  // CIERRE — garantías finales
  // ---------------------------------------------------------------------
  banner("GARANTÍAS FINALES");
  console.log(`Se han mostrado ${scenesShown} de 10 escenas, todas completadas.`);
  console.log();
  console.log("En toda esta demostración NO ha ocurrido:");
  console.log("  - ninguna llamada real a nadie");
  console.log("  - ningún mensaje real enviado");
  console.log("  - ningún dato real de ningún cliente");
  console.log("  - ninguna conexión a internet");
  console.log("  - ningún cambio en la agenda de verdad");
  console.log();
  console.log(SYNTHETIC_FIXTURE_BANNER);

  if (TECNICO) {
    const allEvents = emitter.all();
    const pilotCounts = new Map<string, number>();
    for (const ev of allEvents.pilot) pilotCounts.set(ev.eventName, (pilotCounts.get(ev.eventName) ?? 0) + 1);
    const internalCounts = new Map<string, number>();
    for (const ev of allEvents.internal) internalCounts.set(ev.eventName, (internalCounts.get(ev.eventName) ?? 0) + 1);
    tecnico(`eventos de piloto en toda la sesión (${allEvents.pilot.length} en total):`);
    for (const [name, n] of [...pilotCounts.entries()].sort()) tecnico(`  ${name}: ${n}`);
    tecnico(`eventos internos en toda la sesión (${allEvents.internal.length} en total):`);
    for (const [name, n] of [...internalCounts.entries()].sort()) tecnico(`  ${name}: ${n}`);
    const finalSnapshot = store.snapshot();
    tecnico(
      `almacén en memoria al terminar: ${finalSnapshot.calls.length} llamada(s), ${finalSnapshot.reservations.length} reserva(s) sintética(s), ${finalSnapshot.humanTasks.length} aviso(s) interno(s), ${finalSnapshot.internalNotices.length} aviso(s) simulado(s), ${finalSnapshot.errors.length} error(es).`,
    );
  }
  console.log();
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("Fallo inesperado en la demostración:", err);
    process.exit(1);
  });
