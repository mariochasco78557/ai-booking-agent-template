import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import type { Clock } from "../callEngine/domain/types.js";
import { fixedClock } from "../callEngine/domain/types.js";
import { advanceableClock, type AdvanceableClock } from "../callEngine/domain/advanceableClock.js";
import type { CalendarWithCapabilities } from "../callEngine/capabilities.js";
import { SYNTHETIC_FIXTURE_BANNER } from "../callEngine/fixtures/syntheticVenue.js";
import { demoSalonVenue, BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../callEngine/fixtures/demoSalonVenue.js";
import type { AuditStamp } from "../callEngine/calendar/model.js";
import { applyChange, previewImpact, type CalendarChange, type ImpactedReservation, type ImpactResolution } from "../callEngine/calendar/impact.js";
import {
  applyWithdrawal,
  previewWithdrawal,
  type CalendarWithdrawal,
  type WithdrawalTargetKind,
} from "../callEngine/calendar/withdrawal.js";
import { runConversation, type ConversationScript, type ConversationTurn } from "../callEngine/engine.js";
import { OUTCOME_DIMENSIONS } from "../callEngine/outcomeDimension.js";
import { createCallEventEmitter, type CallEventEmitter } from "../callEngine/events/emitter.js";
import { createMemoryStore, type MemoryStore } from "../callEngine/store/memoryStore.js";
import { createWaitlistStore, type WaitlistStore } from "../callEngine/waitlist/store.js";
import {
  applyEntryCommand,
  cancelReservation,
  convertToReservation,
  createWaitlistEntry,
  declineOptIn,
  idempotentReplayEvent,
  reviewCancellation,
  setCancellationPolicy,
  type CommandOutcome,
  type WaitlistCommandContext,
} from "../callEngine/waitlist/commands.js";
import { createOperationsStore, type OperationsStore } from "../callEngine/operations/store.js";
import {
  correctNoShow,
  operationsReplayEvent,
  recordNoShow,
  type OperationsCommandContext,
  type OperationsCommandOutcome,
} from "../callEngine/operations/noShow.js";
import type { EngineSideEffects } from "../callEngine/shared/commandOutcome.js";
import {
  GROUP_MEMBER_LABEL_RE,
  isAllowedManualDuration,
  MANUAL_CLIENT_LABEL_RE,
  type OperationsAuditDraft,
  type OperationsWrite,
} from "../callEngine/operations/model.js";
import { proposeGroup } from "../callEngine/operations/groupProposal.js";
import {
  createManualBooking,
  proposeManualBooking,
  type ManualBookingOutcome,
} from "../callEngine/operations/manualBooking.js";
import {
  createGroup,
  type GroupCommandOutcome,
} from "../callEngine/operations/groupCommands.js";
import { buildReservationAnnotations, buildWaitlistSnapshot, projectWaitlistEntry } from "./waitlistSnapshot.js";
import {
  buildClockView,
  buildGroupAnnotations,
  buildManualBookingAnnotations,
  buildNoShowAnnotations,
  buildOperationsSnapshot,
  demoInstantLabel,
  formatDurationEs,
  manualConflictLabel,
  projectGroupProposals,
  projectManualBooking,
  projectManualProposal,
  projectNoShowRecord,
  projectReservationGroup,
  CLOCK_ADVANCE_MAX_MINUTES,
} from "./operationsSnapshot.js";
import {
  createIdempotencyStore,
  fingerprintRequest,
  IDEMPOTENCY_KEY_PATTERN,
  type IdempotencyMode,
  type IdempotencyStore,
} from "./idempotency.js";
import { buildCalendarSnapshot, buildSnapshot } from "./snapshot.js";
import { buildDemoWorkspace } from "./demoWorkspace.js";
import { isDirectExecution } from "./directExecution.js";
import { CONSOLE_HOST, DEFAULT_CONSOLE_PORT, loadConsoleConfig, requireConsoleEnabled, type ConsoleConfig } from "./config.js";
import { renderConsoleHtml } from "./ui.html.js";
import { CONSOLE_CSS } from "./ui.css.js";
import { renderConsoleAppJs } from "./ui.js.js";
import { compareDate, daysBetween, isValidDateISO } from "../callEngine/domain/time.js";
import {
  AVAILABILITY_EXPLORER_COPY,
  AVAILABILITY_EXPLORER_MAX_DAYS,
  exploreAvailability,
  type AvailabilityExploreQuery,
} from "./availabilityExplorer.js";

/**
 * A SEPARATE Fastify instance for the step 13 operator console demo — this
 * module NEVER imports src/app.ts and NEVER mounts anything under the real
 * middleware's own Fastify app. It is its own tiny local server, meant to be
 * started as its own process (see tools/call-engine-demo/console.sh),
 * loopback-only, unauthenticated (no public surface exists to authenticate),
 * showing only synthetic data (src/callEngine/fixtures/**).
 *
 * SECURITY POSTURE (senior decision, non-negotiable):
 *   - `listen({ host: CONSOLE_HOST, port })` — CONSOLE_HOST is hard-coded to
 *     "127.0.0.1" in config.ts; this file never reads a HOST env var.
 *   - every request is additionally checked at runtime to come from
 *     loopback (`onRequest` hook below) — defence in depth even though the
 *     socket itself never accepts a non-loopback connection.
 *   - a restrictive CSP plus three more security headers on every response.
 *   - no session, no cookie, no credential of any kind is ever read or
 *     required — this console has no public surface to protect with one.
 */

// ---------------------------------------------------------------------
// In-process synthetic state, mirroring tools/call-engine-demo/demo-driver.ts's
// pattern: one clock, one store, one emitter, one calendar, reused across
// every request this process serves.
// ---------------------------------------------------------------------

/**
 * The console's working calendar: `demoSalonVenue()` exactly as the fixture
 * declares it — venue hours (Monday closed), the dated August season, and a
 * handful of synthetic appointments on the synthetic "today", so the Agenda
 * has real content. Unlike the previous version this no longer blanks the
 * fixture's own exception lists: blanking them was what left the console
 * showing an empty week and a Monday that the shop does not open.
 */
function freshCalendar(): CalendarWithCapabilities {
  return demoSalonVenue();
}

export interface ConsoleServerDeps {
  store?: MemoryStore;
  emitter?: CallEventEmitter;
  clock?: Clock;
  salt?: string;
  initialCalendar?: CalendarWithCapabilities;
  /**
   * The TCP port this console is (or will be) bound to — used ONLY to render
   * the sidebar footer's "Local · 127.0.0.1:<port>" text (D6, step 14
   * repair). Defaults to `DEFAULT_CONSOLE_PORT` so `.inject()`-based tests
   * that never call `startConsoleServer` still see a plausible value. The
   * HOST half of that string stays `CONSOLE_HOST` — a hard-coded constant,
   * never taken from this (or any) dep — see config.ts's own docblock.
   */
  port?: number;
}

// ---------------------------------------------------------------------
// Request body validation — zod, mirroring the house style in src/config/env.ts.
// ---------------------------------------------------------------------

const DAY_NAME_SCHEMA = z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

const TURN_SCHEMA = z
  .object({
    utterance: z.string().max(500).optional(),
    day: DAY_NAME_SCHEMA.optional(),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    professionalId: z.union([z.number().int(), z.literal("any")]).optional(),
    serviceId: z.union([z.literal(0), z.literal(1), z.literal(2), z.null()]).optional(),
    serviceConfirmed: z.boolean().optional(),
    bookingConfirmed: z.boolean().optional(),
    reservationRef: z.string().max(200).optional(),
    identityProof: z.literal("verified").optional(),
    explicitlyRequestsHuman: z.boolean().optional(),
    attemptsThirdPartyAccess: z.boolean().optional(),
    injectFailure: z.boolean().optional(),
    urgent: z.boolean().optional(),
  })
  .strict();

const SCENARIO_RUN_SCHEMA = z
  .object({
    // Must match the pilot event schema's own `scenarioId` pattern
    // (callEngine/events/schema.ts). Accepting anything wider was not a
    // cosmetic mismatch: every id the console's UI suggested started with
    // "console-", failed the pilot schema on the FIRST emitted event, and
    // collapsed the whole call into a fabricated TECHNICAL_FAILURE with no
    // turns and no trace. Rejecting it here, loudly, is the difference
    // between a 400 the operator can read and a lie the operator cannot.
    scenarioId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^A[0-9]{2}[-a-z0-9]+$/, "scenarioId debe seguir el patrón del esquema de piloto, por ejemplo A01-mi-escenario"),
    callId: z.string().min(1).max(200).optional(),
    turns: z.array(TURN_SCHEMA).min(1).max(30),
    liveTransferAvailable: z.boolean().optional(),
  })
  .strict();

/**
 * step 26 REAPERTURA §R11 — LA NOTA OPERATIVA, y por qué es ESTE campo.
 *
 * Su destino es `AuditStamp.note` (`calendar/model.ts`), que existe en el
 * sello de LOS TRES tipos de registro y no lleva encima ningún contrato de
 * secreto. Es lo que permite que haya UNA sola forma de anotar en vez de dos,
 * y que la anotación se pueda leer luego en la pantalla de Horarios y
 * ausencias — que es justo lo que `EmployeeAbsence.privateReason` NO puede
 * hacer, porque tiene prohibido salir de este servidor hacia nadie.
 *
 * 280 caracteres: es una nota operativa de una línea, no un expediente; cabe
 * en la fila de la lista a 1024 px sin partirla en cuatro renglones, y está
 * en la misma horquilla que el resto de textos libres de la casa. El servidor
 * recorta espacios y rechaza con 400 lo que exceda; el cliente pone
 * `maxlength="280"` para que no se llegue ahí. Subir el tope exige corregir
 * antes el documento normativo.
 *
 * NO PIDE NI SUGIERE NINGÚN DATO MÉDICO NI PERSONAL, en ninguna etiqueta,
 * ayuda ni mensaje de error.
 *
 * SE RECORTA ANTES DE CONTAR, Y SE CUENTA EN CARACTERES (revisión adversarial
 * de la reapertura, V1-8/V3-11). `z.string().max(280)` hacía las dos cosas al
 * revés: medía la cadena SIN recortar —de modo que una nota de 280 caracteres
 * escrita con un espacio de más al final se rechazaba— y medía en unidades
 * UTF-16, de modo que 280 emojis (280 caracteres para quien los escribe, 560
 * unidades para el motor) también. Y el 400 llegaba con un mensaje de zod en
 * inglés, que no es de esta casa. El recorte va primero, la cuenta es de
 * PUNTOS DE CÓDIGO (`[...s].length`) —la misma que hará el contador del
 * cliente— y el mensaje está en castellano.
 */
const NOTA_OPERATIVA_SCHEMA = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => [...s].length <= 280, { message: "La nota no puede pasar de 280 caracteres." })
  .optional();

/**
 * EL NOMBRE DE UN CAMBIO DE CALENDARIO (revisión adversarial de la reapertura,
 * V3-4).
 *
 * Un `id` NO es prosa: es el nombre con el que se apunta, se busca y se retira
 * un cambio, y se INTERPOLA en la línea del historial de calendario
 * (`calendarAuditLog`). Mientras fue texto libre, un identificador con un
 * salto de línea dentro fabricaba —dentro de una sola entrada— otra entrada
 * perfectamente legible que nadie había escrito: un historial que se puede
 * falsificar desde el formulario no es un historial. La reparación no es
 * escapar en el punto de pintado (habría que acertar en todos, para siempre),
 * sino darle forma al nombre en la puerta: minúsculas sin acentos, cifras,
 * punto, guion y guion bajo; empieza por letra o cifra; hasta 200 caracteres.
 * Ahí dentro no cabe un salto de línea, ni un byte nulo, ni una marca de
 * dirección Unicode, ni `../`, ni `<img …>`.
 *
 * CONTRATO COMPARTIDO con el cliente, que genera los identificadores como
 * «slug del nombre que escribe el operador + sufijo estable» (§R13): todo lo
 * que el cliente produce cae dentro de este patrón por construcción, y los
 * identificadores de los fixtures (`agosto-2026-dow-1`, `closure-fixture-default`,
 * `holiday-national-fixture-1`…) ya lo cumplían.
 */
const IDENTIFICADOR_SCHEMA = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,199}$/,
    "El identificador sólo admite minúsculas sin acentos, cifras, punto, guion y guion bajo; empieza por letra o cifra y no pasa de 200 caracteres.",
  );

const CHANGE_SCHEMA = z.discriminatedUnion("changeKind", [
  z
    .object({
      changeKind: z.literal("venue_closure"),
      id: IDENTIFICADOR_SCHEMA,
      startDate: z.string().min(1),
      endDate: z.string().min(1),
      note: NOTA_OPERATIVA_SCHEMA,
    })
    .strict(),
  z
    .object({
      changeKind: z.literal("special_opening"),
      id: IDENTIFICADOR_SCHEMA,
      date: z.string().min(1),
      specialOpen: z.string().min(1),
      specialClose: z.string().min(1),
      note: NOTA_OPERATIVA_SCHEMA,
    })
    .strict(),
  z
    .object({
      changeKind: z.literal("employee_absence"),
      id: IDENTIFICADOR_SCHEMA,
      employeeId: z.number().int(),
      absenceKind: z.enum(["vacation", "absence", "training"]),
      startDate: z.string().min(1),
      endDate: z.string().min(1),
      allDay: z.boolean(),
      startMinutes: z.number().int().min(0).max(1439).optional(),
      endMinutes: z.number().int().min(0).max(1439).optional(),
      privateReason: z.string().max(500).optional(),
      note: NOTA_OPERATIVA_SCHEMA,
    })
    .strict(),
])
  // step 26 (revisión adversarial, hallazgo 5) — UNA AUSENCIA PARCIAL TIENE
  // QUE DURAR ALGO. Una de longitud cero (o invertida) no aparta a nadie de
  // ninguna hora, pero al restarse parte el día en dos tramos que se tocan por
  // un punto: tiempo continuo escrito en dos trozos. Ahí, y sólo ahí, la rejilla
  // de 30 de la voz y la aritmética de intervalo de la cita manual pueden dar
  // respuestas distintas sobre el mismo minuto. Se cierra el camino en la
  // puerta, que es donde se publica, en vez de enseñar a cada lector a
  // desconfiar de sus datos. Va sobre la unión entera, y no sobre su rama, para
  // no convertir una opción del discriminante en un `ZodEffects` (que
  // `discriminatedUnion` no admite).
  .refine(
    (c) =>
      c.changeKind !== "employee_absence" ||
      c.allDay ||
      c.startMinutes === undefined ||
      c.endMinutes === undefined ||
      c.endMinutes > c.startMinutes,
    { message: "una ausencia parcial tiene que terminar después de empezar" },
  );

type ChangeRequestBody = z.infer<typeof CHANGE_SCHEMA>;

const PUBLISH_SCHEMA = z
  .object({
    change: CHANGE_SCHEMA,
    resolutions: z.record(z.string(), z.enum(["keep_and_flag", "mark_for_human_contact"])),
  })
  .strict();

/**
 * step 26 REAPERTURA §R13 — LA RETIRADA.
 *
 * Retirar un cierre, un día especial o una ausencia es marcar la fila
 * `approval: "rejected"` conservándola (ver `calendar/withdrawal.ts`). Sólo
 * esos TRES tipos: `employee_override` queda expresamente fuera de alcance y
 * por eso no está en este `enum` — un tipo que no se puede nombrar no se
 * puede retirar por descuido.
 *
 * EDITAR NO TIENE ENDPOINT. Editar es retirar y volver a dar de alta, dos
 * publicaciones con sus dos previsualizaciones y sus dos líneas de historial,
 * y el operador tiene que verlo así.
 */
const WITHDRAWAL_TARGET_SCHEMA = z
  .object({
    targetKind: z.enum(["venue_closure", "venue_rule", "employee_absence"]),
    // El MISMO patrón que el alta (V3-4): lo que no se pudo apuntar tampoco se
    // puede nombrar para retirarlo, y la línea de historial de la retirada
    // interpola este `id` exactamente igual que la del alta.
    id: IDENTIFICADOR_SCHEMA,
  })
  .strict();

const WITHDRAWAL_SCHEMA = WITHDRAWAL_TARGET_SCHEMA;

const WITHDRAWAL_PUBLISH_SCHEMA = z
  .object({
    target: WITHDRAWAL_TARGET_SCHEMA,
    resolutions: z.record(z.string(), z.enum(["keep_and_flag", "mark_for_human_contact"])),
    note: NOTA_OPERATIVA_SCHEMA,
  })
  .strict();

// ---------------------------------------------------------------------
// step 17 — waitlist request schemas (design §6.1). Same house style:
// `.strict()` everywhere, so an unexpected field is a 400 and never a
// silently ignored instruction.
// ---------------------------------------------------------------------

/**
 * The ONLY shape a client label may take (design §8.4). No names, no phone
 * numbers, no free text about a person: the demo is synthetic and this
 * pattern is what makes that structurally true rather than merely promised.
 */
const CLIENT_LABEL_SCHEMA = z.string().regex(/^Cliente [A-Z]$/, "La etiqueta debe ser 'Cliente' seguido de una letra mayúscula, por ejemplo 'Cliente A'.");

const PROFESSIONAL_PREFERENCE_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("specific"), employeeId: z.number().int() }).strict(),
]);

const WAITLIST_ENTRY_SCHEMA = z
  .object({
    clientLabel: CLIENT_LABEL_SCHEMA,
    serviceId: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    earliestStartMinutes: z.number().int().min(0).max(1439),
    latestStartMinutes: z.number().int().min(1).max(1440),
    professional: PROFESSIONAL_PREFERENCE_SCHEMA,
    optInSource: z.enum(["phone_simulated", "counter_simulated", "operator_entered"]),
    // The opt-in CANNOT be omitted: `z.literal(true)` makes an entry without
    // an explicit yes structurally impossible, not merely discouraged.
    optInConfirmed: z.literal(true),
  })
  .strict();

const OPT_IN_DECLINED_SCHEMA = z
  .object({ clientLabel: CLIENT_LABEL_SCHEMA, note: z.string().max(200).optional() })
  .strict();

/**
 * The shape of `slot-<YYYY-MM-DD>-<startMinutes>-<employeeId>`, the SAME one
 * `parseSlotKey` knows (waitlist/model.ts). Validating it here means a
 * malformed key is a 400 with an explanation and never reaches the domain as a
 * key that simply matches nothing.
 */
const SLOT_KEY_SCHEMA = z
  .string()
  .max(120)
  .regex(/^slot-\d{4}-\d{2}-\d{2}-\d+--?\d+$/, "El identificador de hueco no tiene el formato esperado.");

/**
 * step 23 §5.4 — the nine commands, still through the SAME route
 * (`POST /api/waitlist/entries/:entryId/command`) and with NO new HTTP path.
 * The two of the human loop carry a MANDATORY `slotKey`: a proposal is
 * approved BY ITS SLOT, never "whichever proposal this person happens to
 * have", so a stale screen cannot approve a proposal that has already moved to
 * the sibling slot. The other seven stay `.strict()` with no extra field, so
 * sending a `slotKey` to `withdraw` is a 400 and never a silently ignored
 * instruction.
 */
const ENTRY_COMMAND_SCHEMA = z.discriminatedUnion("command", [
  z.object({ command: z.literal("simulate_notice") }).strict(),
  z.object({ command: z.literal("record_acceptance") }).strict(),
  z.object({ command: z.literal("record_decline") }).strict(),
  z.object({ command: z.literal("release_match") }).strict(),
  z.object({ command: z.literal("withdraw") }).strict(),
  z.object({ command: z.literal("expire_manually") }).strict(),
  z.object({ command: z.literal("reopen") }).strict(),
  z.object({ command: z.literal("approve_proposal"), slotKey: SLOT_KEY_SCHEMA }).strict(),
  z.object({ command: z.literal("take_over_proposal"), slotKey: SLOT_KEY_SCHEMA }).strict(),
]);

const CONVERT_SCHEMA = z
  .object({
    slotKey: z.string().min(1).max(120),
    // Explicit confirmation, deliberately not an optional flag.
    confirmed: z.literal(true),
    injectFailure: z.boolean().optional(),
  })
  .strict();

const CANCEL_RESERVATION_SCHEMA = z
  .object({
    reasonCode: z.enum([
      "client_cancelled_by_phone_simulated",
      "client_cancelled_at_counter_simulated",
      "venue_cancelled_simulated",
      "unspecified",
    ]),
    confirmed: z.literal(true),
  })
  .strict();

/** ONE possible value, on purpose: no other consequence of a late cancellation is approved (design §5.4). */
const CANCELLATION_REVIEW_SCHEMA = z.object({ decision: z.literal("reviewed_no_action") }).strict();

/**
 * Wider than the interface's six-value `<select>` ON PURPOSE and documented
 * as such (design §3.3): it lets a test script use an intermediate value
 * without widening the operator's own choices.
 */
const POLICY_SCHEMA = z.object({ cancellationNoticeMinutes: z.number().int().min(0).max(1440) }).strict();

// ---------------------------------------------------------------------
// step 18 — no-show and demo-clock request schemas (design §2.9, §3.5).
// Same house style: `.strict()` everywhere.
// ---------------------------------------------------------------------

/**
 * ONE possible value, on purpose (design §2.1): recording a no-show demands
 * an EXPLICIT yes. `z.literal(true)` makes a command without confirmation
 * structurally impossible, exactly like `optInConfirmed` and the cancellation
 * schema above.
 */
const NO_SHOW_SCHEMA = z.object({ confirmed: z.literal(true) }).strict();

/**
 * The demo clock's only command surface. WIDER THAN THE INTERFACE ON PURPOSE
 * and documented as such (design §3.5): the screen offers up to "+4 horas",
 * and this route accepts up to seven days so a test script can reach a closed
 * day or a date outside the booking horizon. The upper bound is never widened
 * without renegotiating that note.
 *
 * NO `Idempotency-Key` HERE, also on purpose: `advance_minutes` is a DELTA
 * (repeating it must advance again, and memoising the first answer would be a
 * lie), and `advance_to_reservation_end` is ABSOLUTE and therefore idempotent
 * by nature — repeating it yields `409 clock_cannot_go_backwards` with the
 * clock untouched, which is the honest answer.
 */
const CLOCK_ADVANCE_SCHEMA = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("advance_minutes"),
      minutes: z.number().int().min(1).max(CLOCK_ADVANCE_MAX_MINUTES),
    })
    .strict(),
  z
    .object({
      command: z.literal("advance_to_reservation_end"),
      reservationId: z.string().min(1).max(120),
    })
    .strict(),
]);

/**
 * step 18 §4.3/§4.9 — the ONLY shape a member label may take. The SAME closed
 * expression the domain uses (`GROUP_MEMBER_LABEL_RE`), imported rather than
 * retyped, so the wire and the model can never drift apart. No names, no phone
 * numbers, no free text about a person (criterion 8.32).
 */
const GROUP_MEMBER_LABEL_SCHEMA = z
  .string()
  .regex(GROUP_MEMBER_LABEL_RE, "La etiqueta debe ser «Persona 1..4», «Adulto A..D» o «Menor A..D».");

const GROUP_ARRANGEMENT_SCHEMA = z.enum(["consecutive", "simultaneous"]);
const GROUP_DATE_SCHEMA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GROUP_SERVICE_SCHEMA = z.union([z.literal(0), z.literal(1), z.literal(2)]);

/**
 * The proposal request (design §4.9). `serviceId` is REQUIRED on every line:
 * a body missing one is a `400`, which is how "prohibido copiar el servicio a
 * todos en silencio" (§4.4) is enforced structurally — there is nothing to
 * copy from, because nothing may be left out.
 */
const GROUP_PROPOSAL_SCHEMA = z
  .object({
    date: GROUP_DATE_SCHEMA,
    // NOT optional and with NO default: the operator chooses explicitly (§4.4).
    arrangement: GROUP_ARRANGEMENT_SCHEMA,
    lines: z
      .array(
        z
          .object({
            memberLabel: GROUP_MEMBER_LABEL_SCHEMA,
            serviceId: GROUP_SERVICE_SCHEMA,
            professional: PROFESSIONAL_PREFERENCE_SCHEMA,
          })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict();

/**
 * The creation request (design §4.9). It carries NO `groupId`: the identity is
 * minted by the store (§4.6.2), so a client cannot mint one — which is what
 * made the two `group_id_*` conflicts disappear.
 */
const GROUP_CREATE_SCHEMA = z
  .object({
    arrangement: GROUP_ARRANGEMENT_SCHEMA,
    date: GROUP_DATE_SCHEMA,
    lines: z
      .array(
        z
          .object({
            memberLabel: GROUP_MEMBER_LABEL_SCHEMA,
            serviceId: GROUP_SERVICE_SCHEMA,
            // ALREADY RESOLVED by the proposal — and revalidated from scratch
            // by the server before a single byte is written (§4.7, step 4).
            employeeId: z.number().int(),
            startMinutes: z.number().int().min(0).max(1439),
          })
          .strict(),
      )
      .min(2)
      .max(4),
    // Explicit confirmation of the whole set, deliberately not an optional flag.
    confirmed: z.literal(true),
    injectFailure: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------
// step 24 — la cita manual del operador (diseño §5)
// ---------------------------------------------------------------------

/**
 * El catálogo CERRADO de personas sintéticas. Seis, con la misma expresión que
 * el dominio valida por su cuenta: aquí para que un cuerpo mal formado sea un
 * 400 con explicación, y allí para que el dominio no dependa de que nadie añada
 * mañana una segunda ruta que se salte este esquema.
 */
const MANUAL_CLIENT_LABEL_SCHEMA = z
  .string()
  .regex(MANUAL_CLIENT_LABEL_RE, "La persona tiene que ser una del catálogo sintético cerrado (Cliente A..F).");

/** Los tres servicios de la demostración, y ni uno más. */
const MANUAL_SERVICE_SCHEMA = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const MANUAL_DATE_SCHEMA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * step 26 §1 — LA DURACIÓN, en el único formato que un operador puede pedir:
 * entero, entre 15 y 240 minutos, en pasos de 15. El tope es ESTRUCTURAL, no
 * comercial (nadie ha fijado una duración máxima de servicio para Demo Salon): el
 * límite real de cada día lo pone el calendario, al revalidar el intervalo.
 *
 * Es OPCIONAL en los dos esquemas a propósito: una petición que no habla de
 * duración es la cita de siempre, y así ninguna de las peticiones ya escritas
 * —ni las de las pruebas— tiene que cambiar para seguir significando lo mismo.
 */
const MANUAL_DURATION_SCHEMA = z
  .number()
  .int()
  .min(15)
  .max(240)
  .refine((n) => n % 15 === 0, { message: "la duración va en pasos de 15 minutos" });

/**
 * step 26 (revisión adversarial, hallazgo 4) — EL INICIO TAMBIÉN VA EN PASOS
 * DE 15. Guardarraíl ESTRUCTURAL, de la misma clase que `0..1439` y que el paso
 * de la duración: la precisión de toda esta capacidad es de un cuarto de hora
 * —la rejilla de la agenda, la lista de huecos del asistente y el propio
 * `durationMinutes`—, así que un inicio en el minuto 601 no viene de ninguna
 * pantalla de esta consola y describe una cita que ninguna vista puede dibujar
 * ni ningún hueco puede ofrecer. No es una regla de negocio de Demo Salon, y por eso
 * vive aquí, en la frontera, y no dentro del dominio: el calendario sigue
 * siendo quien decide qué cabe.
 */
const MANUAL_START_SCHEMA = z
  .number()
  .int()
  .min(0)
  .max(1439)
  .refine((n) => n % 15 === 0, { message: "la hora de inicio va en pasos de 15 minutos" });

/**
 * La VISTA PREVIA (diseño §4, paso 5). No escribe nada, así que no pide
 * `Idempotency-Key`: no hay nada que hacer idempotente. Existe porque el paso 5
 * del flujo exige decir QUÉ PROFESIONAL quedó asignado antes de confirmar —y
 * sobre todo cuando se pidió «cualquiera»— y porque es el servidor, no el
 * navegador, quien acuña la clave de idempotencia (decisión N3 de step 18).
 */
const MANUAL_PREVIEW_SCHEMA = z
  .object({
    clientLabel: MANUAL_CLIENT_LABEL_SCHEMA,
    serviceId: MANUAL_SERVICE_SCHEMA,
    date: MANUAL_DATE_SCHEMA,
    startMinutes: MANUAL_START_SCHEMA,
    durationMinutes: MANUAL_DURATION_SCHEMA.optional(),
    professional: PROFESSIONAL_PREFERENCE_SCHEMA,
  })
  .strict();

/**
 * LA CREACIÓN (diseño §5.1). `employeeId` viaja YA RESUELTO por la vista
 * previa, exactamente como en la reserva para varias personas — y se revalida
 * desde cero igualmente antes de escribir un solo byte.
 *
 * `confirmed: z.literal(true)` hace ESTRUCTURALMENTE IMPOSIBLE una escritura
 * sin confirmación humana: no es una comprobación que alguien pueda olvidarse
 * de hacer, es un tipo que no admite otra cosa. Y `.strict()` significa que un
 * campo de más es un 400, nunca una instrucción ignorada en silencio.
 */
const MANUAL_CREATE_SCHEMA = z
  .object({
    clientLabel: MANUAL_CLIENT_LABEL_SCHEMA,
    serviceId: MANUAL_SERVICE_SCHEMA,
    date: MANUAL_DATE_SCHEMA,
    startMinutes: MANUAL_START_SCHEMA,
    durationMinutes: MANUAL_DURATION_SCHEMA.optional(),
    employeeId: z.number().int(),
    confirmed: z.literal(true),
  })
  .strict();

// ---------------------------------------------------------------------
// step 19 — the availability explorer's query (design §3.4, §6.1). A
// GET, so validation happens on the QUERY STRING: every value arrives as a
// string, `.strict()` rejects anything missing or extra (the "formato
// inválido" bucket of §3.4), and the remaining semantic checks (unknown
// service/professional, backwards or too-long range) happen right after,
// each with its own `code` and its exact Spanish message from
// `AVAILABILITY_EXPLORER_COPY`. NONE of this lives in
// `availabilityExplorer.ts`: that module is pure and knows nothing of zod
// or query strings (design §3.5.2 — `zod` is not one of its permitted
// imports).
// ---------------------------------------------------------------------
const AVAILABILITY_EXPLORE_QUERY_SCHEMA = z
  .object({
    serviceId: z.string().regex(/^\d+$/),
    mode: z.enum(["any", "one"]),
    employeeId: z.string().regex(/^\d+$/).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // step 26 §13 — la duración que pide el asistente de cita manual. Aquí
    // sólo se comprueba la FORMA (dígitos); que sea una duración permitida lo
    // decide `isAllowedManualDuration`, la misma función que valida el dominio,
    // unas líneas más abajo. El panel «Comprobar huecos sintéticos» no lo manda
    // nunca, y sin él esta ruta contesta exactamente lo que contestaba antes.
    // `^[1-9]\d*$` y no `^\d+$`: `030` y `0090` son la misma duración escrita
    // de tres formas, y tres formas de escribir lo mismo en una consulta son
    // tres cachés, tres claves y tres oportunidades de discrepar. Una sola
    // grafía por valor (step 26, revisión adversarial, hallazgo 6).
    durationMinutes: z.string().regex(/^[1-9]\d*$/).optional(),
  })
  .strict()
  // §3.4 "sobra un parámetro" también cubre un parámetro que sobra POR EL
  // SENTIDO de la consulta, no sólo por la forma: con `mode=any` nadie ha
  // preguntado por una persona concreta, así que un `employeeId` presente es
  // el mismo "sobra" que un campo desconocido (revisión adversarial de la
  // capacidad 1, hallazgo H8).
  .refine((q) => !(q.mode === "any" && q.employeeId !== undefined), {
    message: "sobra employeeId con mode=any",
  });

/**
 * §3.4/§8.2 — límite de años razonable para esta demostración local, junto a
 * `isValidDateISO` y no dentro de él (revisión adversarial de la capacidad 1,
 * hallazgo H1). `isValidDateISO` (`domain/time.ts`, frozen engine helper) sólo
 * comprueba que la fecha exista en el calendario gregoriano — y "0000-01-01" y
 * "9999-12-31" existen. Ninguna demostración de Demo Salon necesita jamás una
 * fecha fuera de este rango; el rango es deliberadamente amplio para no
 * rechazar nunca una fecha real.
 */
const AVAILABILITY_EXPLORE_MIN_YEAR = 1000;
const AVAILABILITY_EXPLORE_MAX_YEAR = 9998;

function isSaneQueryYear(dateISO: string): boolean {
  const year = Number(dateISO.slice(0, 4));
  return year >= AVAILABILITY_EXPLORE_MIN_YEAR && year <= AVAILABILITY_EXPLORE_MAX_YEAR;
}

/** Builds a fully-typed `CalendarChange` (calendar/impact.ts) from the console's own minimal request DTO. Always authored+approved by "console-operator", mirroring calendar/approval.ts's `manualOverride` convention (same actor authors and approves a direct manual decision). */
function toCalendarChange(body: ChangeRequestBody, clock: Clock): CalendarChange {
  const now = clock.nowInstantISO();
  const nota = body.note?.trim();
  const audit: AuditStamp = {
    createdAt: now,
    createdBy: "console-operator",
    approvedAt: now,
    approvedBy: "console-operator",
    // REAPERTURA §R11 — la nota operativa, recortada, y sólo si dice algo:
    // una cadena de espacios no es una nota, y escribirla dejaría filas con
    // un campo vacío que la consola tendría que aprender a ignorar.
    ...(nota !== undefined && nota !== "" ? { note: nota } : {}),
  };
  switch (body.changeKind) {
    case "venue_closure":
      return {
        kind: "venue_closure",
        closure: {
          id: body.id,
          kind: "full_closure",
          startDate: body.startDate,
          endDate: body.endDate,
          source: "manual_override",
          approval: "approved",
          audit,
        },
      };
    case "special_opening":
      return {
        kind: "venue_rule",
        rule: {
          id: body.id,
          kind: "special_opening",
          scope: "venue",
          date: body.date,
          closed: false,
          specialOpen: body.specialOpen,
          specialClose: body.specialClose,
          source: "manual_override",
          approval: "approved",
          audit,
        },
      };
    case "employee_absence":
      return {
        kind: "employee_absence",
        absence: {
          id: body.id,
          employeeId: body.employeeId,
          kind: body.absenceKind,
          startDate: body.startDate,
          endDate: body.endDate,
          allDay: body.allDay,
          ...(body.startMinutes !== undefined ? { startMinutes: body.startMinutes } : {}),
          ...(body.endMinutes !== undefined ? { endMinutes: body.endMinutes } : {}),
          ...(body.privateReason !== undefined ? { privateReason: body.privateReason } : {}),
          source: "manual_override",
          approval: "approved",
          audit,
        },
      };
  }
}

/**
 * REAPERTURA §R13 — el `id` que ya está APROBADO en la colección que le toca.
 * La comprobación mira lo VIGENTE, no el historial: un identificador que se
 * apuntó y luego se retiró vuelve a estar libre, porque su fila ya no gobierna
 * ninguna disponibilidad. La guarda vive aquí, en la frontera, y NO dentro de
 * `impact.ts`: `applyChange` no cambia de firma ni de pureza por esto.
 */
function yaHayCambioAprobadoConEseId(cal: CalendarWithCapabilities, body: ChangeRequestBody): boolean {
  switch (body.changeKind) {
    case "venue_closure":
      return cal.closures.some((c) => c.id === body.id && c.approval === "approved");
    case "special_opening":
      return cal.venueRules.some((r) => r.id === body.id && r.approval === "approved");
    case "employee_absence":
      return cal.absences.some((a) => a.id === body.id && a.approval === "approved");
  }
}

/**
 * La nota, aplanada a UNA sola línea, para que pueda interpolarse en una
 * entrada del historial de calendario (revisión adversarial de la reapertura,
 * V3-4).
 *
 * `calendarAuditLog` es una lista de líneas, y una entrada se lee como una
 * línea. Una nota con un salto de línea dentro fabricaba —dentro de una sola
 * entrada— texto que se leía como OTRA entrada, escrita por nadie: bastaba con
 * teclear en el campo de nota una frase con el formato del historial. Se
 * colapsa todo espacio en blanco (saltos, tabuladores, U+2028/U+2029, espacios
 * repetidos) a un espacio simple.
 *
 * NO SE TOCA EL DATO: `AuditStamp.note` conserva la nota tal y como la
 * escribieron, saltos incluidos, y la consola la pinta con `textContent`. Lo
 * que se sanea es LA LÍNEA que se compone con ella, que es donde el formato
 * significa algo.
 */
function enUnaSolaLinea(texto: string): string {
  return texto.replace(/\s+/gu, " ").trim();
}

/** Cómo se llama en castellano, para el historial, lo que se acaba de retirar. */
function withdrawalLabel(targetKind: WithdrawalTargetKind, id: string): string {
  switch (targetKind) {
    case "venue_closure":
      return `cierre de local '${id}'`;
    case "venue_rule":
      return `día especial '${id}'`;
    case "employee_absence":
      return `ausencia de empleado '${id}'`;
  }
}

function changeLabel(body: ChangeRequestBody): string {
  switch (body.changeKind) {
    case "venue_closure":
      return `cierre de local '${body.id}' (${body.startDate}..${body.endDate})`;
    case "special_opening":
      return `horario especial '${body.id}' (${body.date}, ${body.specialOpen}-${body.specialClose})`;
    case "employee_absence":
      return `ausencia de empleado '${body.id}' (empleado ${body.employeeId}, ${body.startDate}..${body.endDate})`;
  }
}

// ---------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------

// `img-src 'self'` (step 14 decision D1) is the MINIMUM widening that lets
// the brand logo and the favicon render at all: without it they inherit
// `default-src 'none'` and the browser refuses to paint any image, including
// one served by this very process. Deliberately no `data:`, no `blob:`, no
// remote origin — every byte comes from the two explicit routes below.
// (Revisión adversarial de step 22, N2) `frame-ancestors`, `base-uri` y
// `form-action` NO heredan de `default-src`: sin nombrarlas, `default-src
// 'none'` no dice absolutamente nada sobre quién puede meter esta página en
// un marco, sobre un `<base>` inyectado que reescribiría cada ruta relativa,
// ni sobre a dónde puede enviarse un formulario. `frame-ancestors` estaba
// compensada por `X-Frame-Options: DENY`; las otras dos no lo estaban por
// nada. Las tres se cierran a `'none'`: es estrictamente MÁS estricto y no
// cambia ni un comportamiento —la página servida no tiene `<base>`, su único
// `<form>` no tiene `action`, y nadie la enmarca.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The brand PNG, resolved RELATIVE TO THIS MODULE and never from anything a
 * request carries — there is no path built from user input anywhere in this
 * file, so there is no directory-traversal surface to protect.
 *
 * The same relative path is correct both when this file runs from source
 * (`src/console/server.ts` under tsx: `src/console` -> repo root) and when it
 * runs compiled (`dist/console/server.js`: `dist/console` -> repo root),
 * because tsconfig maps `rootDir: src` onto `outDir: dist` one-for-one. The
 * asset itself is NOT copied into `dist/` by `tsc` (which only emits .js), so
 * a compiled deployment must ship the repo's `assets/` directory alongside
 * `dist/`; the console is a local-only developer tool that is always run from
 * the repo, so this is a documented limitation, not a silent one.
 */
const BRAND_LOGO_PATH = fileURLToPath(new URL("../../assets/brand/demo-salon-logo.png", import.meta.url));

let brandLogoCache: Buffer | undefined;

/**
 * Reads a brand asset from disk, failing LOUDLY and in Spanish if it is
 * missing or empty: a console that silently served an empty body would look
 * like a broken browser instead of a missing file. Exported so the failure
 * path itself can be tested without renaming a versioned asset mid-run.
 */
export function readBrandAsset(path: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(
      `No se ha podido leer el activo de marca en ${path}. ` +
        `La consola no arranca sin él a propósito: servir una imagen vacía habría parecido un fallo del navegador. ` +
        `Comprueba que el fichero existe en el repositorio (assets/brand/demo-salon-logo.png). Detalle: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (bytes.length === 0) {
    throw new Error(`El activo de marca en ${path} está vacío (0 bytes). La consola no arranca con un activo vacío.`);
  }
  return bytes;
}

/** Reads the logo ONCE per process and keeps it in memory. */
function loadBrandLogo(): Buffer {
  brandLogoCache ??= readBrandAsset(BRAND_LOGO_PATH);
  return brandLogoCache;
}

/**
 * The favicon is an INTERFACE GLYPH, not the brand logo: two letters drawn
 * with the page's own type. Serving the official logo here would claim, at
 * 16x16, an identity this local demo has no business claiming; §6.12 of the
 * design spec makes the same distinction on screen.
 *
 * SVG rather than ICO, on purpose: it is a handful of auditable text (no
 * binary blob to review), it scales, it needs no `data:` in the CSP, and it
 * contains NO `<script>` and NO `<foreignObject>` — with
 * `X-Content-Type-Options: nosniff` and its correct media type, that is the
 * shape of SVG a browser will not execute.
 */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="TX">' +
  '<rect width="32" height="32" rx="6" fill="#1f2933"/>' +
  '<text x="16" y="22" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" ' +
  'font-size="16" font-weight="700" fill="#f5f0e8">TX</text>' +
  "</svg>";

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * (Revisión de seguridad de step 22, fase 7, aviso 2) La dirección de origen
 * NO basta por sí sola. En una re-vinculación de DNS la petición sale de
 * loopback de verdad —la hace el navegador de esta misma máquina— y lo único
 * que delata el ataque es la cabecera `Host`: lleva el dominio del atacante,
 * que es justo lo que le deja saltarse la política de mismo origen y leer o
 * mutar la demostración desde una pestaña cualquiera.
 *
 * La lista blanca es la mínima: los tres nombres con los que se puede llamar
 * a esta consola, con puerto opcional. Es estrictamente MÁS estricta y no
 * rompe a nadie, porque un cliente de loopback siempre manda uno de ellos.
 * Un `Host` ausente tampoco pasa: sin cabecera no hay nada que comprobar, y
 * todo cliente HTTP/1.1 está obligado a mandarla.
 *
 * (Recomprobación de seguridad sobre `b7a0180`) El patrón valida la cabecera
 * ENTERA, y está anclado por los dos extremos a propósito. La primera versión
 * extraía el nombre y tiraba el resto sin mirarlo —hasta el `]` en la forma
 * con corchetes, hasta los dos puntos en la otra—, así que `[::1].evil.com`,
 * `[::1]@evil.com`, `localhost:4390@evil.com` o `localhost:notaport` pasaban
 * por buenos. No era explotable (un navegador no puede componer esas cadenas
 * en una re-vinculación, y a un cliente local arbitrario le bastaría con
 * mandar `Host: localhost`), pero una lista blanca que acepta basura detrás
 * del nombre no es una lista blanca. El puerto, si viene, tiene que ser
 * dígitos y nada más.
 *
 * `::1` sin corchetes no está: no es una forma válida de `Host` y tampoco se
 * aceptaba antes.
 */
const ALLOWED_HOST_HEADER = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  return ALLOWED_HOST_HEADER.test(hostHeader.trim().toLowerCase());
}

/**
 * Builds (but never starts) the console's Fastify instance. Safe to use with
 * `.inject()` in tests — never opens a real TCP port. See `startConsoleServer`
 * below for the one place that actually calls `listen()`.
 */
export function buildConsoleServer(deps: ConsoleServerDeps = {}): FastifyInstance {
  const store = deps.store ?? createMemoryStore();
  const emitter = deps.emitter ?? createCallEventEmitter();
  // Synthetic "today" = TUESDAY 2026-08-04, 09:00 (decision D4). The previous
  // value, 2026-08-02, was a SUNDAY: with the venue's real hours applied, the
  // console's home screen would have shown an empty day for ever.
  //
  // step 18 (design §3.2): the clock is WRAPPED EXACTLY ONCE, here. With
  // offset 0 the wrapper is indistinguishable from what it wraps — the three
  // readers delegate literally — so every suite that injects its own clock
  // behaves byte for byte as before. It only moves through
  // `POST /api/lab/clock/advance`, and it only goes back to the baseline
  // through `POST /api/reset`, which is the first thing that route does.
  const clock: AdvanceableClock = advanceableClock(deps.clock ?? fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES));
  const salt = deps.salt ?? "call-engine-console-salt";
  const initial = deps.initialCalendar ?? freshCalendar();
  const port = deps.port ?? DEFAULT_CONSOLE_PORT;
  let cal: CalendarWithCapabilities = initial;
  let scenarioCounter = 0;
  const calendarAuditLog: string[] = [];
  // step 17: one waitlist store and one idempotency registry per process,
  // exactly like the calendar above. `createWaitlistStore` loads the fixture
  // and writes its own `DEMO_RESET` as event 1.
  const waitlist: WaitlistStore = createWaitlistStore(clock);
  // step 18: a second, independent register for operator operations
  // (no-shows and the demo clock). It writes its own `DEMO_RESET` as event 1
  // and it never touches `WaitlistAuditKind`, which must stay verifiably
  // unchanged (criterion 8.27).
  const operations: OperationsStore = createOperationsStore(clock);
  const idempotency: IdempotencyStore = createIdempotencyStore();

  // Read at CONSTRUCTION, not per request: if the asset is missing this
  // throws here, before a single route exists, instead of failing quietly in
  // a browser tab.
  const brandLogo = loadBrandLogo();

  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 256 * 1024 });

  // Defence in depth: even though `listen()` only ever binds to loopback
  // (see `startConsoleServer`), every request is independently checked here
  // too — `trustProxy: false` above means `req.ip` reflects the real socket
  // address, never a spoofable `X-Forwarded-For` header.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopbackAddress(req.ip)) {
      await reply.code(403).send({ error: "Esta consola local solo admite peticiones desde 127.0.0.1 (loopback)." });
      return;
    }
    // Segunda mitad de la misma guarda: ver `isAllowedHostHeader`. La
    // dirección dice DE DÓNDE viene la petición; el `Host`, en nombre de quién.
    if (!isAllowedHostHeader(req.headers.host)) {
      await reply
        .code(403)
        .send({ error: "Esta consola local solo admite peticiones cuyo Host sea localhost, 127.0.0.1 o [::1]." });
    }
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  app.get("/", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return renderConsoleHtml(port);
  });

  // Served from its own route rather than inlined, so `style-src 'self'`
  // holds and the page never needs `'unsafe-inline'`.
  app.get("/app.css", async (_req, reply) => {
    reply.header("Content-Type", "text/css; charset=utf-8");
    return CONSOLE_CSS;
  });

  app.get("/app.js", async (_req, reply) => {
    reply.header("Content-Type", "application/javascript; charset=utf-8");
    return renderConsoleAppJs();
  });

  // Two explicit routes, one in-memory Buffer, zero filesystem access per
  // request. No static-file plugin and no directory is ever exposed.
  //
  // `/brand/logo.png` is the path the step 14 work order fixed; DESIGN_SPEC
  // Anexo A.3 wrote `/brand/demo-salon-logo.png` before that. Both are registered
  // against the same handler so whichever one the interface asks for works —
  // an alias costs three lines, a 404 on the logo costs the demo.
  const serveBrandLogo = async (_req: FastifyRequest, reply: FastifyReply): Promise<Buffer> => {
    reply.header("Content-Type", "image/png");
    // Immutable for a day: the asset only changes when the repository does,
    // and the console is a local process an operator restarts freely.
    reply.header("Cache-Control", "public, max-age=86400, immutable");
    return brandLogo;
  };
  app.get("/brand/logo.png", serveBrandLogo);
  app.get("/brand/demo-salon-logo.png", serveBrandLogo);

  app.get("/favicon.svg", async (_req, reply) => {
    reply.header("Content-Type", "image/svg+xml; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=86400");
    return FAVICON_SVG;
  });

  // -------------------------------------------------------------------
  // step 17 — the waitlist plumbing (design §6.1, §6.2, §14.5).
  //
  // THE ANTI-HALF-WRITE RULE, made structural: every handler below builds
  // the complete write with a PURE function from callEngine/waitlist and
  // then calls `applyWrite`, which commits calendar, waitlist store, memory
  // store and human queue in ONE synchronous block with NO `await` inside
  // it. There is no window between revalidating and writing.
  // -------------------------------------------------------------------

  function waitlistContext(): WaitlistCommandContext {
    const snap = waitlist.snapshot();
    return {
      cal,
      clock,
      entries: snap.entries,
      cancellations: snap.cancellations,
      releasedSlots: snap.releasedSlots,
      policy: snap.policy,
      nextEntryNumber: snap.nextEntryNumber,
      nextOfferSeq: snap.nextOfferSeq,
    };
  }

  /**
   * THE SHARED, SYNCHRONOUS half of every write (step 18 design §4.7): the
   * calendar, the `MemoryStore`'s own copy of the reservations, and the human
   * queue. Both features hand over the very same shape (`EngineSideEffects`),
   * so this is written ONCE and both `applyWrite` and `applyOperationsWrite`
   * call it.
   *
   * IT IS NOT `async` AND CONTAINS NO `await`, deliberately: an `await` here
   * would be the one way to write half a change, and with a group of three
   * that would mean a family with one appointment booked and two lost. The
   * loops walk arrays of exactly one element on every step 17 path.
   */
  /**
   * Revisión adversarial de la capacidad 2, hallazgo H1a. `HumanTask.id` es
   * determinista por errand (`decidir-hueco-<slotKey>`, `contacto-<reservaId>`,
   * `revision-tardia-<reservaId>`…), así que el MISMO id puede volver a
   * proponerse más de una vez en la vida de la demostración: un hueco liberado
   * que se vuelve a liberar más tarde es, otra vez, "decidir a quién se le
   * ofrece ESE hueco" — el MISMO recado. `store.addHumanTask`
   * (`callEngine/store/memoryStore.ts`, de fábrica, sin tocar) añade sin
   * preguntar; sin esta guarda, dos altas para el mismo id mientras la primera
   * SIGUE abierta crean dos filas ABIERTAS duplicadas del mismo recado, y
   * `store.completeHumanTask` (que cierra por id, no por instancia) las cierra
   * las DOS de un solo golpe — un cierre en cadena que resuelve un recado y
   * dos contadores a la vez. Un id que ya está CERRADO no cuenta: una tarea
   * cerrada y una nueva abierta con el mismo id son, de verdad, dos sucesos
   * distintos en el tiempo (§7.6, residuo declarado).
   */
  function hasOpenHumanTask(id: string): boolean {
    return store.snapshot().humanTasks.some((t) => t.id === id && t.completedAtISO === undefined);
  }

  function applyEngineSideEffects(write: EngineSideEffects): void {
    if (write.nextCal !== undefined) cal = write.nextCal;
    for (const reservation of write.reservationsToAdd ?? []) {
      // `store.addReservation` returns a calendar with the reservation
      // folded in; `write.nextCal` already carries it, so the returned
      // value is not reused — what matters is that the MemoryStore's own
      // copy exists too, or `snap.reservations` would never show it.
      store.addReservation(cal, reservation);
    }
    for (const reservationId of write.reservationsToCancel ?? []) {
      // BOTH copies, same tick (design §14.4, criterion 9).
      store.markReservationCancelled(reservationId);
    }
    for (const task of write.tasksToAdd ?? []) {
      // H1a — skip a duplicate OPEN row for the very same errand; see the
      // docblock on `hasOpenHumanTask`, right above.
      if (hasOpenHumanTask(task.id)) continue;
      store.addHumanTask({
        id: task.id,
        // An operator action has no call. Same convention the calendar
        // flow already uses for its own task.
        callIdHash: "sin-llamada-asociada",
        reason: task.reason,
        createdAtISO: task.createdAtISO,
      });
    }
    for (const taskId of write.tasksToComplete ?? []) {
      store.completeHumanTask(taskId, clock.nowInstantISO());
    }
  }

  /**
   * Commits a whole `WaitlistWrite` and returns the ids the store minted for
   * its audit events. Deliberately NOT async, for the reason above.
   */
  function applyWrite(outcome: CommandOutcome): string[] {
    const write = outcome.write;
    if (write === null) return [];
    const stamped = waitlist.commit(write);
    applyEngineSideEffects(write);
    return stamped.map((e) => e.id);
  }

  /**
   * Turns a `CommandOutcome` into a reply body: the raw entry is replaced by
   * its SERVER-SIDE PROJECTION (raw domain objects never leave the process),
   * and the audit ids the store minted are attached so the operator can find
   * what just happened in the log.
   */
  function replyBody(outcome: CommandOutcome, auditEventIds: readonly string[]): Record<string, unknown> {
    const body: Record<string, unknown> = { ...outcome.body };
    if (outcome.viewEntryId !== undefined) {
      const snap = waitlist.snapshot();
      const entry = snap.entries.find((e) => e.id === outcome.viewEntryId);
      if (entry !== undefined) body.entry = projectWaitlistEntry(cal, clock, snap, entry);
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      body.auditEventIds = [...auditEventIds];
      if (outcome.singleAuditEventIdField !== undefined && auditEventIds[0] !== undefined) {
        body[outcome.singleAuditEventIdField] = auditEventIds[0];
      }
    }
    return body;
  }

  interface IdempotencyDecision {
    /** `undefined` when the request must be executed normally. */
    replay?: { statusCode: number; body: unknown };
    rejection?: { statusCode: number; body: Record<string, unknown> };
    /** Present when the outcome must be memoised afterwards. */
    key?: string;
    fingerprint?: string;
    /** The mode the route works in, so the memoising below cannot pick another one. */
    mode?: IdempotencyMode;
    /**
     * (Enmienda de fase K, H1) `true` when this key HAS been seen before with
     * the same body and the route is going to execute again anyway, because it
     * works in `collision-only` mode. It is what the `Idempotency-Status:
     * re-executed` header says out loud: the key is known, and nothing was
     * replayed.
     */
    reExecutedRepeat?: boolean;
  }

  /**
   * WHERE A REPEATED REQUEST IS WRITTEN DOWN. A replay writes exactly one
   * thing: the fact that it was a replay. WHICH register that lands in
   * depends on the route — the waitlist's for step 17's seven routes, the
   * operations one for step 18's two (design §4.8's implementation note).
   * Passing it as a parameter is the whole change: the mechanism is not
   * duplicated and the behaviour of the seven existing routes is untouched,
   * because they keep using the default below.
   */
  type ReplayRecorder = (route: string, key: string) => void;

  const recordWaitlistReplay: ReplayRecorder = (route, key) => {
    waitlist.appendEvents([idempotentReplayEvent(clock, route, key)]);
  };

  /**
   * The whole of §6.2 in one place. `required` is true for `convert` and
   * `cancel`; elsewhere the header is optional but honoured, so a client
   * that sends one gets the same protection without a second mechanism.
   *
   * (Enmienda de fase K, H1) `mode` says what a repetition of an ALREADY SEEN
   * key with the SAME body is allowed to do: give the memoised answer back
   * (`replay-body`, the historical behaviour of the nine routes that had it)
   * or execute again and answer with the truth of the moment
   * (`collision-only`, the group creation route). The `409` for a repeated key
   * with a DIFFERENT body is identical in both modes, and so is the "only
   * `2xx` is memoised" rule.
   *
   * A `collision-only` route brings no replay recorder, because it can never
   * take that branch: there is no transport replay to write down.
   */
  type IdempotencyOptions =
    | { mode: "replay-body"; recordReplay: ReplayRecorder }
    | { mode: "collision-only" };

  function decideIdempotency(
    req: FastifyRequest,
    route: string,
    params: string,
    body: unknown,
    required: boolean,
    options: IdempotencyOptions = { mode: "replay-body", recordReplay: recordWaitlistReplay },
  ): IdempotencyDecision {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (key === undefined || key === "") {
      if (required) {
        return { rejection: { statusCode: 400, body: { error: "Falta la cabecera Idempotency-Key." } } };
      }
      return {};
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      return {
        rejection: {
          statusCode: 400,
          body: { error: "La cabecera Idempotency-Key no tiene un formato válido (8 a 200 caracteres de [A-Za-z0-9_:.-])." },
        },
      };
    }
    const fingerprint = fingerprintRequest(route, body, params);
    const found = idempotency.lookup(key, route, fingerprint, options.mode);
    if (found.kind === "replay" && options.mode === "replay-body") {
      // A replay writes exactly ONE thing: the fact that it was a replay.
      // Never a second success event.
      options.recordReplay(route, key);
      return {
        replay: { statusCode: found.record.statusCode, body: found.record.body },
        key,
        fingerprint,
        mode: options.mode,
      };
    }
    if (found.kind === "collision") {
      return {
        rejection: { statusCode: 409, body: { conflict: "idempotency_key_reused_with_different_body" } },
        key,
        fingerprint,
        mode: options.mode,
      };
    }
    // `repeat` (only reachable in `collision-only` mode) falls through to the
    // execution below, exactly like a `miss`. Nothing is written down here:
    // whatever the repetition turns out to be — "ya estaba creada", a new
    // group or a conflict — the COMMAND says it and the command writes it.
    return { key, fingerprint, mode: options.mode, ...(found.kind === "repeat" ? { reExecutedRepeat: true } : {}) };
  }

  /** Executes one waitlist command end to end, honouring §6.2. */
  function runWaitlistRoute(
    req: FastifyRequest,
    reply: FastifyReply,
    options: { route: string; params: string; body: unknown; requiresKey: boolean },
    execute: () => CommandOutcome,
  ): unknown {
    const decision = decideIdempotency(req, options.route, options.params, options.body, options.requiresKey);
    if (decision.rejection !== undefined) {
      return reply.code(decision.rejection.statusCode).send(decision.rejection.body);
    }
    if (decision.replay !== undefined) {
      reply.header("Idempotency-Status", "replayed");
      return reply.code(decision.replay.statusCode).send(decision.replay.body);
    }

    const outcome = execute();
    const auditEventIds = applyWrite(outcome);
    const body = replyBody(outcome, auditEventIds);

    if (decision.key !== undefined && decision.fingerprint !== undefined) {
      reply.header("Idempotency-Status", "original");
      // `remember` itself refuses anything that is not 2xx.
      idempotency.remember({
        mode: "replay-body",
        key: decision.key,
        route: options.route,
        fingerprint: decision.fingerprint,
        statusCode: outcome.status,
        body,
      });
    }
    return reply.code(outcome.status).send(body);
  }

  // -------------------------------------------------------------------
  // step 18 — the no-show plumbing (design §2.9). Same anti-half-write
  // rule: a pure handler decides everything, and one synchronous commit
  // applies it. A rejected command carries `write: null` and therefore
  // writes NOTHING — not an event, not a task, not a record (criterion 8.13).
  // -------------------------------------------------------------------

  function operationsContext(): OperationsCommandContext {
    return { cal, clock, noShows: operations.snapshot().noShows };
  }

  /**
   * Commits a whole `OperationsWrite`. Deliberately NOT async, for the same
   * reason as `applyWrite`: for a group, the group, its N reservations (in
   * `cal` AND in the `MemoryStore`) and its N+1 audit events land in ONE tick.
   */
  function applyOperationsWrite(outcome: { write: OperationsWrite | null }): string[] {
    const write = outcome.write;
    if (write === null) return [];
    const stamped = operations.commit(write);
    applyEngineSideEffects(write);
    return stamped.map((e) => e.id);
  }

  function operationsReplyBody(
    outcome: OperationsCommandOutcome,
    auditEventIds: readonly string[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { ...outcome.body };
    if (outcome.viewNoShowReservationId !== undefined) {
      const snap = operations.snapshot();
      const record = snap.noShows.find((r) => r.reservationId === outcome.viewNoShowReservationId);
      // The SERVER-SIDE PROJECTION, never the raw domain object.
      if (record !== undefined) body.record = projectNoShowRecord(cal, snap.noShows, record);
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      body.auditEventIds = [...auditEventIds];
    }
    return body;
  }

  /**
   * Executes ONE operations command end to end, honouring §6.2 with the
   * operations register. Generic in the outcome and in the three things that
   * differ between the no-show routes and the group route: WHICH idempotency
   * MODE the route works in, WHAT a repeated request writes down, and HOW the
   * reply body is finished off. The mechanism itself — `decideIdempotency`,
   * one synchronous commit, memoise only 2xx — is written once.
   *
   * (Enmienda de fase K, H1) A `collision-only` route brings no `replayDraft`,
   * because it never takes the replay branch: what a repetition writes down is
   * decided by the COMMAND, over the world as it is now — for the group route,
   * the structural `RESERVATION_GROUP_REPEATED` of `createGroup` (§4.8).
   */
  function runOperationsCommand<O extends { status: number; body: Record<string, unknown>; write: OperationsWrite | null }>(
    req: FastifyRequest,
    reply: FastifyReply,
    options: {
      route: string;
      params: string;
      body: unknown;
    } & (
      | { idempotency: "replay-body"; replayDraft: (route: string, key: string) => OperationsAuditDraft }
      | { idempotency: "collision-only" }
    ),
    execute: () => O,
    project: (outcome: O, auditEventIds: readonly string[]) => Record<string, unknown>,
  ): unknown {
    // The header is REQUIRED on every writing route of step 18 (design §2.9, §4.9).
    const decision = decideIdempotency(
      req,
      options.route,
      options.params,
      options.body,
      true,
      options.idempotency === "collision-only"
        ? { mode: "collision-only" }
        : {
            mode: "replay-body",
            recordReplay: (route, key) => {
              operations.appendEvents([options.replayDraft(route, key)]);
            },
          },
    );
    if (decision.rejection !== undefined) {
      return reply.code(decision.rejection.statusCode).send(decision.rejection.body);
    }
    if (decision.replay !== undefined) {
      reply.header("Idempotency-Status", "replayed");
      return reply.code(decision.replay.statusCode).send(decision.replay.body);
    }

    const outcome = execute();
    const auditEventIds = applyOperationsWrite(outcome);
    const body = project(outcome, auditEventIds);

    if (decision.key !== undefined && decision.fingerprint !== undefined) {
      // THREE values, and each one is literally true: `original` (this key was
      // never seen), `replayed` (nothing executed, the memoised answer came
      // back) and `re-executed` (the key was seen, and this route executed
      // again anyway instead of replaying — H1).
      reply.header("Idempotency-Status", decision.reExecutedRepeat === true ? "re-executed" : "original");
      // `remember` itself refuses anything that is not 2xx — which is exactly
      // what lets a `409 no_show_already_corrected` be reached again instead
      // of being frozen for ever (design §2.7). In `collision-only` mode the
      // record has no `body` at all: what is kept is the footprint, so a
      // repeated key with another body is still caught, and no answer of this
      // route can ever be given back as if the world had not moved.
      idempotency.remember(
        options.idempotency === "collision-only"
          ? {
              mode: "collision-only",
              key: decision.key,
              route: options.route,
              fingerprint: decision.fingerprint,
              statusCode: outcome.status,
            }
          : {
              mode: "replay-body",
              key: decision.key,
              route: options.route,
              fingerprint: decision.fingerprint,
              statusCode: outcome.status,
              body,
            },
      );
    }
    return reply.code(outcome.status).send(body);
  }

  /**
   * The reply body of the group route: the raw `ReservationGroup` is replaced
   * by its SERVER-SIDE PROJECTION, read from the store AFTER the commit, so
   * what comes back is the world as it now is and not what the handler hoped
   * for. Raw domain objects never leave the process.
   */
  function groupReplyBody(outcome: GroupCommandOutcome, auditEventIds: readonly string[]): Record<string, unknown> {
    const body: Record<string, unknown> = { ...outcome.body };
    if (outcome.viewGroupId !== undefined) {
      const snap = operations.snapshot();
      const group = snap.groups.find((g) => g.id === outcome.viewGroupId);
      if (group !== undefined) body.group = projectReservationGroup(cal, snap.groups, group);
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      body.auditEventIds = [...auditEventIds];
    }
    return body;
  }

  /**
   * step 24 — el cuerpo de respuesta de la cita manual. Sustituye
   * `body.booking` por la PROYECCIÓN del servidor: el `ManualBooking` de
   * dominio no sale del proceso, ni siquiera en la respuesta de la ruta.
   *
   * La frase de conflicto se añade AQUÍ, junto al código, para que el navegador
   * no tenga que traducir nada: el código viaja para el detalle técnico y el
   * mensaje es lo que se lee.
   */
  function manualReplyBody(
    outcome: ManualBookingOutcome,
    auditEventIds: readonly string[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { ...outcome.body };
    if (outcome.viewManualBookingId !== undefined) {
      const snap = operations.snapshot();
      const booking = snap.manualBookings.find((b) => b.id === outcome.viewManualBookingId);
      if (booking !== undefined) body.booking = projectManualBooking(cal, booking);
    }
    if (typeof outcome.body.conflict === "string") {
      body.message = manualConflictLabel(outcome.body.conflict);
    }
    // step 26 (revisión adversarial, hallazgo 2). El dominio no puede redactar
    // «2 h 15 min» —`formatDurationEs` vive en la consola, y `callEngine` no
    // importa de aquí—, así que la duración intentada se rotula en esta
    // frontera, junto a los datos que el dominio ya dejó resueltos. Es la misma
    // función que rotula el resumen del paso 5: una sola redacción.
    const intento = body.attempted;
    if (intento !== null && typeof intento === "object") {
      const minutos = (intento as Record<string, unknown>).durationMinutes;
      if (typeof minutos === "number") {
        body.attempted = { ...(intento as Record<string, unknown>), durationLabel: formatDurationEs(minutos) };
      }
    }
    if (typeof outcome.body.code === "string" && outcome.body.message === undefined) {
      body.message = manualConflictLabel(outcome.body.code);
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      body.auditEventIds = [...auditEventIds];
    }
    return body;
  }

  /** The two no-show routes (design §2.9). */
  function runOperationsRoute(
    req: FastifyRequest,
    reply: FastifyReply,
    options: { route: string; params: string; body: unknown },
    execute: () => OperationsCommandOutcome,
  ): unknown {
    return runOperationsCommand(
      req,
      reply,
      {
        ...options,
        // The two no-show routes keep the historical transport behaviour,
        // untouched by the fase-K amendment: their answer describes a record
        // whose revision travels INSIDE the key (`:v<revision>`, §2.7), so a
        // memoised answer cannot describe a world that moved on.
        idempotency: "replay-body",
        replayDraft: (route, key) => operationsReplayEvent(clock, route, key, options.params),
      },
      execute,
      operationsReplyBody,
    );
  }

  app.get("/api/snapshot", async () => {
    const waitlistSnapshot = waitlist.snapshot();
    const operationsSnapshot = operations.snapshot();
    const waitlistAnnotations = buildReservationAnnotations(waitlistSnapshot);
    // Field by field, never a spread of somebody else's object: the two
    // reservation projections gain the no-show facts of step 18 exactly the
    // way they gained the cancellation facts of step 17 (design §2.10).
    const annotations = {
      cancellations: waitlistAnnotations.cancellations,
      originatedFromWaitlistEntryId: waitlistAnnotations.originatedFromWaitlistEntryId,
      noShows: buildNoShowAnnotations(cal, clock, operationsSnapshot),
      // step 18 §4.9: the appointments of a group appear ONE BY ONE, each
      // carrying the shared, synthetic reference to its group.
      groups: buildGroupAnnotations(cal, operationsSnapshot),
      // step 24 §11.1: el CUARTO origen. Derivado del registro de
      // operaciones, igual que el de lista de espera se deriva del suyo, así
      // que no hay dos copias de esta verdad que puedan divergir.
      manualBookings: buildManualBookingAnnotations(operationsSnapshot),
    };
    const operational = buildSnapshot(store, emitter, clock, annotations);
    const calendar = buildCalendarSnapshot(cal, calendarAuditLog, annotations);
    const waitlistView = buildWaitlistSnapshot(cal, clock, waitlistSnapshot, store.snapshot().humanTasks);
    const operationsView = buildOperationsSnapshot(cal, clock, operationsSnapshot);
    return {
      // The ONLY real wall-clock read in this whole deliverable, and it is
      // deliberate: an operator staring at a dashboard needs to know whether
      // what they are looking at is a second old or an hour old, and the
      // engine's injected clock is frozen synthetic time that would answer
      // that question wrongly. It is a presentation stamp: it feeds no
      // decision, enters no event, and is stripped before any structural
      // comparison in tests. The determinism guarantee of this mission
      // covers the ENGINE (src/callEngine), which the boundaries test
      // enforces; it was never claimed for this timestamp.
      generatedAt: new Date().toISOString(),
      ...operational,
      calendar,
      // ONE new top-level key, ENTIRELY resolved in the server (design
      // §6.3): labels, `stillValid`, mismatch reasons, available commands
      // and audit texts all arrive ready to paint. Nothing about timetables,
      // precedence, capability or compatibility travels raw.
      waitlist: waitlistView,
      // The SECOND new top-level key, from step 18 §2.10: the demo clock,
      // the no-show records, the derived figures, the integrity invariants
      // and the operations log — all resolved here, including the
      // idempotency keys the interface will mint (decision N3).
      operations: operationsView,
      // step 19 §6.4: the THIRD (and last) new top-level key. Built from the
      // four projections already computed above — nothing here reads `cal`
      // or `store`/`waitlist`/`operations` a second time. All resolved here:
      // labels, the two-sentence definitions, every step's evidence phrase
      // and the entire copyable text. The browser only paints.
      demo: buildDemoWorkspace({
        metrics: operational.metrics,
        availabilityQueryCount: operational.availabilityQueries.length,
        tasks: operational.humanQueue.tasks,
        reservations: operational.reservations,
        waitlist: waitlistView,
        operations: operationsView,
        engineToday: operational.engineToday,
        engineNowMinutes: operational.engineNowMinutes,
      }),
    };
  });

  /**
   * step 19 capacity 1 (design §3.4, §6.1) — "Comprobar huecos sintéticos".
   * A QUERY that happens to be a `GET`: it writes NOTHING (no reservation,
   * no calendar change, no event, no `eventCounts`, no audit entry), exactly
   * like `POST /api/booking/group/proposals` writes nothing despite being a
   * `POST` — that route is a `POST` only because its request does not fit a
   * query string. This one does, so it is a `GET`, with no
   * `Idempotency-Key` and no body: there is nothing here to make
   * idempotent, and it can be repeated as many times as anyone likes with no
   * consequence. `exploreAvailability` never mutates `cal` and reads no
   * clock beyond the one already wrapped once, above (§3.7).
   */
  app.get("/api/availability/explore", async (req, reply) => {
    const parsed = AVAILABILITY_EXPLORE_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
    }
    const {
      serviceId: serviceIdRaw,
      mode,
      employeeId: employeeIdRaw,
      from,
      to,
      durationMinutes: durationRaw,
    } = parsed.data;

    // step 26 §13 — la duración, con la MISMA regla que el dominio: 15..240 en
    // pasos de 15. Una duración imposible es una consulta inválida, del mismo
    // saco que un parámetro que sobra: no se inventa un código nuevo ni una
    // frase nueva para ella.
    let durationMinutes: number | undefined;
    if (durationRaw !== undefined) {
      const candidate = Number(durationRaw);
      if (!isAllowedManualDuration(candidate)) {
        return reply.code(400).send({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
      }
      durationMinutes = candidate;
    }

    // The pattern above only checks SHAPE ("four digits, a dash, …"); it
    // passes "2026-02-31" straight through. `isValidDateISO` is the one
    // helper in this whole deliverable that also checks the calendar is
    // real (§3.5.2) — used here, at the HTTP boundary, and not inside
    // `availabilityExplorer.ts`, which never re-validates what the server
    // already guaranteed.
    if (!isValidDateISO(from) || !isValidDateISO(to)) {
      return reply.code(400).send({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
    }
    // `isValidDateISO` accepts any calendrically real year, including
    // "0000-01-01" and "9999-12-31" — both syntactically valid, calendrically
    // real, and yet outside any year this synthetic demo could ever mean
    // (revisión adversarial de la capacidad 1, hallazgo H1). Worse, a day
    // AFTER "9999-12-31" (`addDays` inside `exploreAvailability`, when it
    // walks the range) overflows into a five-digit year ("10000-01-01") that
    // `parseDateTime` (`utils/dateFormatterEs.ts`) cannot parse at all,
    // crashing `dateLabelOf` with a 500. This bound is deliberately generous
    // (it must never reject a real demo date) and lives right next to
    // `isValidDateISO`, not inside it: `isValidDateISO` is a frozen, general
    // calendar-correctness helper, and this is a query-shape sanity check
    // specific to this endpoint.
    if (!isSaneQueryYear(from) || !isSaneQueryYear(to)) {
      return reply.code(400).send({ error: AVAILABILITY_EXPLORER_COPY.invalidQuery, code: "invalid_query" });
    }

    const serviceIdNum = Number(serviceIdRaw);
    if (serviceIdNum !== 0 && serviceIdNum !== 1 && serviceIdNum !== 2) {
      return reply.code(400).send({ error: AVAILABILITY_EXPLORER_COPY.unknownService, code: "unknown_service" });
    }
    const serviceId = serviceIdNum as 0 | 1 | 2;

    let employeeId: number | undefined;
    if (mode === "one") {
      const candidate = employeeIdRaw !== undefined ? Number(employeeIdRaw) : undefined;
      if (candidate === undefined || !cal.professionals.some((p) => p.employeeId === candidate)) {
        return reply.code(400).send({ error: AVAILABILITY_EXPLORER_COPY.unknownProfessional, code: "unknown_professional" });
      }
      employeeId = candidate;
    }

    if (compareDate(to, from) < 0) {
      return reply.code(400).send({ error: AVAILABILITY_EXPLORER_COPY.rangeBackwards, code: "range_backwards" });
    }
    if (daysBetween(from, to) + 1 > AVAILABILITY_EXPLORER_MAX_DAYS) {
      return reply.code(400).send({ error: AVAILABILITY_EXPLORER_COPY.rangeTooLong, code: "range_too_long" });
    }

    const query: AvailabilityExploreQuery = {
      serviceId,
      mode,
      ...(employeeId !== undefined ? { employeeId } : {}),
      from,
      to,
      // Ausente = ausente: NO se rellena con `cal.slotMinutes` aquí. El
      // explorador distingue «no me han pedido duración» (rejilla y textos de
      // siempre) de «me han pedido 30», y esa distinción es lo que mantiene el
      // panel de Agenda byte a byte como estaba.
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    };
    return reply.code(200).send(exploreAvailability(cal, clock, query));
  });

  app.post("/api/scenario/run", async (req, reply) => {
    const parsed = SCENARIO_RUN_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Escenario inválido", issues: parsed.error.issues.map((i) => i.message) });
    }
    scenarioCounter += 1;
    const script: ConversationScript = {
      scenarioId: parsed.data.scenarioId,
      callId: parsed.data.callId ?? `console-call-${scenarioCounter}`,
      turns: parsed.data.turns as readonly ConversationTurn[],
    };
    const result = runConversation(
      {
        cal,
        clock,
        emitter,
        store,
        salt,
        ...(parsed.data.liveTransferAvailable !== undefined
          ? { liveTransferAvailable: parsed.data.liveTransferAvailable }
          : {}),
      },
      script,
    );
    // Fold any new synthetic reservation into this process's own working
    // calendar (mirrors tools/call-engine-demo/demo-driver.ts's `fold()`) so
    // the NEXT scenario run sees it as occupied. `store.addReservation` is
    // NOT called again here — `runConversation` already recorded it once;
    // calling it a second time would duplicate the entry in the store.
    if (result.reservation !== undefined) {
      cal = { ...cal, reservations: [...cal.reservations, result.reservation] };
    }
    // D1 (step 14 repair): the frozen `reasonCode` alone let Laboratorio
    // mislabel a genuinely-understood-but-unconfirmed booking as
    // `INTENT_NOT_UNDERSTOOD`. `internalReasonCode` is read straight off
    // what `runConversation` already resolved (engine.ts's own `finalize()`)
    // — nothing here re-derives it. The three metric booleans are a pure,
    // already-frozen table lookup (`OUTCOME_DIMENSIONS`, the SAME table
    // `finalize()` itself reads), not a second business-logic computation.
    const dimensions = OUTCOME_DIMENSIONS[result.internalReasonCode];
    return {
      scenarioId: result.scenarioId,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      internalReasonCode: result.internalReasonCode,
      countsAsNotUnderstood: dimensions.countsAsNotUnderstood,
      countsAsBookingConversion: dimensions.countsAsBookingConversion,
      countsAsContained: dimensions.countsAsContained,
      announcesSuccess: result.announcesSuccess,
      externalMutation: result.externalMutation,
      syntheticMutation: result.syntheticMutation,
      ...(result.requiresOperatorReview !== undefined ? { requiresOperatorReview: result.requiresOperatorReview } : {}),
      finalState: result.finalState,
      turns: result.turns.map((t) => (t.params !== undefined ? { phraseKey: t.phraseKey, params: t.params } : { phraseKey: t.phraseKey })),
      ...(result.reservation !== undefined
        ? {
            reservation: {
              id: result.reservation.id,
              employeeId: result.reservation.employeeId,
              serviceId: result.reservation.serviceId,
              date: result.reservation.date,
              startMinutes: result.reservation.startMinutes,
              endMinutes: result.reservation.endMinutes,
              status: result.reservation.status,
            },
          }
        : {}),
    };
  });

  app.post("/api/reset", async () => {
    // step 18 (design §1.5, §3.4): THE CLOCK GOES FIRST, and the order is
    // normative. `createWaitlistStore(clock)` captured this clock BY
    // REFERENCE and reads it in `reset()`: if the hour were restored
    // afterwards, `DEMO_RESET` and the `createdAtISO` of the six seed entries
    // would be stamped with the advanced time, and a demo that claims to be
    // back at 09:00 would carry entries created at 14:00 of a Tuesday on
    // which it is not yet 09:00. It is a silent defect that only shows up
    // reading the history — which is exactly why it is pinned by a test.
    clock.resetToBaseline();
    store.reset();
    emitter.reset();
    cal = freshCalendar();
    calendarAuditLog.length = 0;
    // step 18 (design §1.6): the scenario counter goes back to zero, so the
    // first Laboratorio scenario after a reset is `console-call-1` again and
    // the same guided demo produces the same identifiers twice running. It is
    // safe precisely because `store.reset()` and `emitter.reset()` above have
    // just erased every call and every event: reusing `console-call-1` cannot
    // collide with anything observable.
    scenarioCounter = 0;
    // step 17 (design §3.5): the six seed entries come back `pending`, the
    // policy goes back to the 120-minute demo value, cancellations, released
    // slots and the audit log are emptied, and a single `DEMO_RESET` becomes
    // event 1 of the new log. The idempotency registry is emptied too, so a
    // key used before the reset cannot replay a response about a world that
    // no longer exists.
    waitlist.reset();
    // step 18 (design §1.5 step 8, §2.13): no-shows and the operations log
    // go too, and a single `DEMO_RESET` becomes event 1 of the new log —
    // stamped with the clock ALREADY back at 09:00.
    operations.reset();
    idempotency.clear();
    return { ok: true };
  });

  // -------------------------------------------------------------------
  // step 18 — the two no-show routes (design §2.9) and the demo clock
  // (§3.5). THERE IS NO `DELETE` ROUTE: a no-show record cannot be erased,
  // which is §2.3's guarantee written into the HTTP surface itself.
  // -------------------------------------------------------------------

  app.post("/api/reservations/:reservationId/no-show", async (req, reply) => {
    const parsed = NO_SHOW_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Registro de inasistencia inválido", issues: parsed.error.issues.map((i) => i.message) });
    }
    const { reservationId } = req.params as { reservationId: string };
    return runOperationsRoute(
      req,
      reply,
      { route: "POST /api/reservations/:reservationId/no-show", params: reservationId, body: req.body },
      () => recordNoShow(operationsContext(), reservationId),
    );
  });

  app.post("/api/reservations/:reservationId/no-show/correction", async (req, reply) => {
    const parsed = NO_SHOW_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Corrección de inasistencia inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const { reservationId } = req.params as { reservationId: string };
    return runOperationsRoute(
      req,
      reply,
      { route: "POST /api/reservations/:reservationId/no-show/correction", params: reservationId, body: req.body },
      () => correctNoShow(operationsContext(), reservationId),
    );
  });

  // -------------------------------------------------------------------
  // step 18 — the two multi-person booking routes (design §4.9).
  //
  // THERE IS NO `DELETE /api/booking/groups/:id`: cancelling is done ONE
  // APPOINTMENT AT A TIME, through the cancellation route that already exists
  // (§4.11). Mass cancellation is out of scope [K9] and is not invented.
  // -------------------------------------------------------------------

  /**
   * A QUERY that happens to carry a body. It writes NOTHING: no reservation,
   * no group, not one audit event — criterion 8.19 compares the log and the
   * calendar byte for byte before and after. That is also why it takes no
   * `Idempotency-Key`: there is nothing to make idempotent.
   */
  app.post("/api/booking/group/proposals", async (req, reply) => {
    const parsed = GROUP_PROPOSAL_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Propuesta de grupo inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const result = proposeGroup(cal, clock, {
      date: parsed.data.date,
      arrangement: parsed.data.arrangement,
      lines: parsed.data.lines,
    });
    const groups = operations.snapshot().groups;
    if (result.rejected !== undefined) {
      // A repeated label is a malformed request, not a fact about the world
      // (design §4.9). Everything else is a truthful "this cannot be done",
      // answered with `200` and no proposals, because asking was legitimate.
      if (result.rejected.conflict === "duplicate_member_label" || result.rejected.conflict === "invalid_member_label") {
        return reply.code(400).send({ error: result.rejected.message, code: result.rejected.conflict });
      }
      return reply.code(200).send({
        proposals: [],
        rejected: { conflict: result.rejected.conflict, message: result.rejected.message },
      });
    }
    return reply.code(200).send({ proposals: projectGroupProposals(cal, groups, result.proposals) });
  });

  /**
   * CREATES. `Idempotency-Key` obligatory, with the intention key the
   * projection minted (§4.6.1, §4.8). All or nothing: the whole write is one
   * synchronous commit, and a conflict on any line writes nothing at all.
   *
   * (Enmienda de fase K, H1) `collision-only`: the key is still demanded and
   * still validated, and a repeated key with a DIFFERENT body is still a
   * `409 idempotency_key_reused_with_different_body` that executes nothing.
   * What it no longer does is hand the memoised answer of the first request
   * back: the answers of this route describe THE WORLD ("created: true", "las
   * 2 citas siguen en pie"), and the world can have moved — an appointment of
   * that group cancelled — between one request and its repetition. So it
   * executes again, and the truth is put by the STRUCTURAL idempotency of
   * `createGroup` (§4.8): whole group still standing → `200 alreadyExists` as
   * it is NOW; a cancelled line → revalidation, which either creates for real
   * or answers the conflict that is true today.
   */
  app.post("/api/booking/groups", async (req, reply) => {
    const parsed = GROUP_CREATE_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Reserva de grupo inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const data = parsed.data;
    return runOperationsCommand(
      req,
      reply,
      {
        route: "POST /api/booking/groups",
        params: "",
        body: req.body,
        idempotency: "collision-only",
      },
      () => {
        const snap = operations.snapshot();
        return createGroup(
          { cal, clock, groups: snap.groups, nextGroupNumber: snap.nextGroupNumber },
          {
            arrangement: data.arrangement,
            date: data.date,
            lines: data.lines,
            ...(data.injectFailure !== undefined ? { injectFailure: data.injectFailure } : {}),
          },
        );
      },
      groupReplyBody,
    );
  });

  // -------------------------------------------------------------------
  // step 24 — LA CITA MANUAL DEL OPERADOR (diseño §5).
  //
  // DOS rutas, y la primera no escribe. La segunda es la única de toda esta
  // consola que un operador usa para crear una cita él mismo, y está separada
  // a propósito de las rutas de llamadas: no se mezcla con ellas, no emite sus
  // eventos y no toca sus métricas.
  // -------------------------------------------------------------------

  /**
   * PREVISUALIZA. No escribe nada —ni una reserva, ni un evento, ni una tarea—,
   * así que no pide `Idempotency-Key`: no hay nada que hacer idempotente y
   * repetirla cuantas veces se quiera no tiene consecuencia alguna.
   *
   * Resuelve «cualquier profesional» con `chooseProfessional` y revalida con la
   * MISMA función que usará la confirmación, para que el resumen no pueda
   * prometer una cita que la confirmación rechazaría. Un rechazo se contesta
   * con 200 y sin propuesta: preguntar era legítimo, y la respuesta honesta es
   * la razón por la que no se puede.
   */
  app.post("/api/booking/manual/preview", async (req, reply) => {
    const parsed = MANUAL_PREVIEW_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Petición de cita manual inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const data = parsed.data;
    const snap = operations.snapshot();
    const result = proposeManualBooking(
      { cal, clock, manualBookings: snap.manualBookings, nextManualNumber: snap.nextManualNumber },
      {
        clientLabel: data.clientLabel,
        serviceId: data.serviceId,
        date: data.date,
        startMinutes: data.startMinutes,
        // step 26 §1 — el ÚNICO valor por defecto de toda la capacidad, y vive aquí,
        // en la frontera HTTP, para que el dominio no tenga ninguno: una petición que
        // no habla de duración es la cita de siempre, la del catálogo.
        durationMinutes: data.durationMinutes ?? cal.slotMinutes,
        professional: data.professional,
      },
    );
    if (result.rejected !== undefined) {
      return reply.code(200).send({
        proposal: null,
        rejected: {
          conflict: result.rejected.conflict,
          // La FRASE primero; el código va aparte, para el detalle técnico.
          message: manualConflictLabel(result.rejected.conflict),
          reasons: result.rejected.reasons,
        },
      });
    }
    return reply.code(200).send({
      proposal: projectManualProposal(cal, snap, result.proposal),
      rejected: null,
    });
  });

  /**
   * CREA. `Idempotency-Key` obligatoria, con la clave que acuñó la vista
   * previa.
   *
   * `collision-only`, y por la misma razón exacta que la creación de grupos: la
   * respuesta de esta ruta describe EL MUNDO («created: true»), y el mundo
   * puede haberse movido —la cita cancelada— entre una petición y su
   * repetición. Devolver la respuesta memoizada de la primera sería contar una
   * mentira con un 2xx y perder la cita en silencio. Así que se vuelve a
   * ejecutar, y la verdad la pone la idempotencia ESTRUCTURAL de
   * `createManualBooking`: cita viva → 200 «ya existe»; cita cancelada →
   * revalidación, que o crea de verdad o contesta el conflicto que hoy es cierto.
   *
   * Una clave repetida con un cuerpo DISTINTO sigue siendo un 409 que no
   * ejecuta nada.
   */
  app.post("/api/booking/manual", async (req, reply) => {
    const parsed = MANUAL_CREATE_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Cita manual inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const data = parsed.data;
    return runOperationsCommand(
      req,
      reply,
      {
        route: "POST /api/booking/manual",
        params: "",
        body: req.body,
        idempotency: "collision-only",
      },
      () => {
        const snap = operations.snapshot();
        return createManualBooking(
          { cal, clock, manualBookings: snap.manualBookings, nextManualNumber: snap.nextManualNumber },
          {
            clientLabel: data.clientLabel,
            serviceId: data.serviceId,
            date: data.date,
            startMinutes: data.startMinutes,
            // step 26 §1 — el ÚNICO valor por defecto de toda la capacidad, y vive aquí,
            // en la frontera HTTP, para que el dominio no tenga ninguno: una petición que
            // no habla de duración es la cita de siempre, la del catálogo.
            durationMinutes: data.durationMinutes ?? cal.slotMinutes,
            employeeId: data.employeeId,
          },
        );
      },
      manualReplyBody,
    );
  });

  app.post("/api/lab/clock/advance", async (req, reply) => {
    const parsed = CLOCK_ADVANCE_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Avance de reloj inválido", issues: parsed.error.issues.map((i) => i.message) });
    }
    const command = parsed.data;
    const from = { dateISO: clock.nowISODate(), minutes: clock.nowMinutes() };

    let to: { dateISO: string; minutes: number };
    if (command.command === "advance_minutes") {
      to = clock.advanceMinutes(command.minutes);
    } else {
      const reservation = cal.reservations.find((r) => r.id === command.reservationId);
      if (reservation === undefined) {
        return reply.code(404).send({ error: "No existe ninguna cita con ese identificador.", code: "reservation_not_found" });
      }
      const moved = clock.advanceTo(reservation.date, reservation.endMinutes);
      if (moved === null) {
        // I1: the clock NEVER goes backwards, and a refusal writes nothing.
        // The way back to the beginning is to restart the demo, and the
        // interface says so.
        return reply.code(409).send({
          conflict: "clock_cannot_go_backwards",
          currentLabel: buildClockView(clock).label,
          requestedLabel: demoInstantLabel(reservation.date, reservation.endMinutes),
        });
      }
      to = moved;
    }

    // Stamped with the NEW instant: the move has already happened when this
    // is written down. Moving the clock records a fact and changes NOTHING
    // else — it never marks anybody as a no-show (design §2.1, §6.2).
    const stamped = operations.appendEvents([
      {
        kind: "DEMO_CLOCK_ADVANCED",
        actor: "operator",
        atISO: clock.nowInstantISO(),
        detail: {
          fromDate: from.dateISO,
          fromMinutes: from.minutes,
          toDate: to.dateISO,
          toMinutes: to.minutes,
          command: command.command,
        },
        synthetic: true,
      },
    ]);

    return reply.code(200).send({ clock: buildClockView(clock), auditEventIds: stamped.map((e) => e.id) });
  });

  // -------------------------------------------------------------------
  // The seven waitlist routes (design §6.1)
  // -------------------------------------------------------------------

  app.post("/api/waitlist/entries", async (req, reply) => {
    const parsed = WAITLIST_ENTRY_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Alta de lista de espera inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    return runWaitlistRoute(
      req,
      reply,
      { route: "POST /api/waitlist/entries", params: "", body: req.body, requiresKey: false },
      () => createWaitlistEntry(waitlistContext(), parsed.data),
    );
  });

  app.post("/api/waitlist/opt-in-declined", async (req, reply) => {
    const parsed = OPT_IN_DECLINED_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Registro de rechazo inválido", issues: parsed.error.issues.map((i) => i.message) });
    }
    return runWaitlistRoute(
      req,
      reply,
      { route: "POST /api/waitlist/opt-in-declined", params: "", body: req.body, requiresKey: false },
      () => declineOptIn(waitlistContext(), parsed.data),
    );
  });

  app.post("/api/waitlist/entries/:entryId/command", async (req, reply) => {
    const parsed = ENTRY_COMMAND_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Comando de lista de espera inválido", issues: parsed.error.issues.map((i) => i.message) });
    }
    const { entryId } = req.params as { entryId: string };
    return runWaitlistRoute(
      req,
      reply,
      { route: "POST /api/waitlist/entries/:entryId/command", params: entryId, body: req.body, requiresKey: false },
      // The whole parsed object travels, not just the literal: `slotKey` is
      // part of the command for the two of step 23 (§5.4). The idempotency
      // fingerprint already covers `route + entryId + body`, so the same
      // `Idempotency-Key` with a different `slotKey` is a 409, not a replay.
      () => applyEntryCommand(waitlistContext(), entryId, parsed.data),
    );
  });

  app.post("/api/waitlist/entries/:entryId/convert", async (req, reply) => {
    const parsed = CONVERT_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Conversión inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const { entryId } = req.params as { entryId: string };
    return runWaitlistRoute(
      req,
      reply,
      { route: "POST /api/waitlist/entries/:entryId/convert", params: entryId, body: req.body, requiresKey: true },
      () =>
        convertToReservation(waitlistContext(), {
          entryId,
          slotKey: parsed.data.slotKey,
          ...(parsed.data.injectFailure !== undefined ? { injectFailure: parsed.data.injectFailure } : {}),
        }),
    );
  });

  app.post("/api/reservations/:reservationId/cancel", async (req, reply) => {
    const parsed = CANCEL_RESERVATION_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Cancelación inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const { reservationId } = req.params as { reservationId: string };
    return runWaitlistRoute(
      req,
      reply,
      { route: "POST /api/reservations/:reservationId/cancel", params: reservationId, body: req.body, requiresKey: true },
      () => cancelReservation(waitlistContext(), { reservationId, reasonCode: parsed.data.reasonCode }),
    );
  });

  app.post("/api/reservations/:reservationId/cancellation-review", async (req, reply) => {
    const parsed = CANCELLATION_REVIEW_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Revisión inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const { reservationId } = req.params as { reservationId: string };
    return runWaitlistRoute(
      req,
      reply,
      { route: "POST /api/reservations/:reservationId/cancellation-review", params: reservationId, body: req.body, requiresKey: false },
      () => reviewCancellation(waitlistContext(), reservationId),
    );
  });

  app.post("/api/waitlist/policy", async (req, reply) => {
    const parsed = POLICY_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Plazo de cancelación inválido", issues: parsed.error.issues.map((i) => i.message) });
    }
    return runWaitlistRoute(
      req,
      reply,
      { route: "POST /api/waitlist/policy", params: "", body: req.body, requiresKey: false },
      () => setCancellationPolicy(waitlistContext(), parsed.data.cancellationNoticeMinutes),
    );
  });

  /**
   * Una reserva que el operador resolvió como «hay que llamar al cliente»
   * tiene que aterrizar de verdad en la cola humana. `applyChange` (y
   * `applyWithdrawal`) se quedan puros y sólo reportan la lista; encolar es
   * trabajo de esta capa, que sí tiene reloj y almacén. Sin esto, la opción
   * prometía una llamada que nadie iba a hacer.
   *
   * Lo usan el ALTA y la RETIRADA, con el MISMO dedupe por
   * `contacto-<reservationId>`: si esa reserva ya tiene un recado abierto —por
   * ejemplo, porque un segundo cambio de calendario vuelve a impactarla antes
   * de que nadie haya llamado— no se abre un segundo aviso del mismo recado.
   */
  function encolarLlamadasAlCliente(flagged: readonly { reservationId: string }[]): void {
    for (const impactada of flagged) {
      const taskId = `contacto-${impactada.reservationId}`;
      if (hasOpenHumanTask(taskId)) continue;
      store.addHumanTask({
        id: taskId,
        // `ImpactedReservation` deliberately carries no call identifier —
        // the impact report is a privacy boundary. The reservation id is
        // what an operator needs to find the appointment anyway.
        callIdHash: "sin-llamada-asociada",
        reason: "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE",
        createdAtISO: clock.nowInstantISO(),
      });
    }
  }

  /**
   * Las claves de `resolutions` que NO corresponden a ninguna cita afectada
   * (revisión adversarial de la reapertura, V3-5).
   *
   * Una resolución es el reconocimiento humano de UN conflicto concreto. Sin
   * esta comprobación, mandar quinientas resoluciones inventadas junto a un
   * cambio que no afecta a nadie se contestaba con un 200 y escribía en el
   * historial «500 resolución(es) aplicada(s), 0 pendiente(s) de llamar al
   * cliente»: un acta que no describe nada de lo que pasó, y que además
   * sugiere que hubo quinientas decisiones humanas donde no hubo ninguna.
   * Se aplica IGUAL al alta y a la retirada, porque el defecto era el mismo.
   */
  function resolucionesSinCitaAfectada(
    impacted: readonly ImpactedReservation[],
    resolutions: Record<string, unknown>,
  ): string[] {
    const afectadas = new Set(impacted.map((r) => r.reservationId));
    return Object.keys(resolutions).filter((reservationId) => !afectadas.has(reservationId));
  }

  const RESOLUCIONES_QUE_SOBRAN = "Hay resoluciones que no corresponden a ninguna cita afectada";

  /** El DTO de impacto, idéntico en el alta y en la retirada. Una sola forma de contarlo. */
  function impactoDto(r: ImpactedReservation): Record<string, unknown> {
    return {
      reservationId: r.reservationId,
      employeeId: r.employeeId,
      date: r.date,
      startMinutes: r.startMinutes,
      endMinutes: r.endMinutes,
      serviceId: r.serviceId,
    };
  }

  app.post("/api/calendar/preview", async (req, reply) => {
    const parsed = CHANGE_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Cambio de calendario inválido", issues: parsed.error.issues.map((i) => i.message) });
    }
    const change = toCalendarChange(parsed.data, clock);
    // PURE — previewImpact never mutates `cal`. See calendar/impact.ts.
    const report = previewImpact(cal, change);
    return {
      impacted: report.impacted.map((r) => ({
        reservationId: r.reservationId,
        employeeId: r.employeeId,
        date: r.date,
        startMinutes: r.startMinutes,
        endMinutes: r.endMinutes,
        serviceId: r.serviceId,
      })),
    };
  });

  app.post("/api/calendar/publish", async (req, reply) => {
    const parsed = PUBLISH_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Publicación de calendario inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    // REAPERTURA §R13 — GUARDA DE IDENTIFICADOR DUPLICADO. `withChangeApplied`
    // (`impact.ts`) AÑADE SIN COMPROBAR, así que publicar dos veces el mismo
    // `id` dejaba dos filas con ese `id` en el mismo array. Mientras nadie
    // buscaba por `id` era inocuo; con la retirada dejaría media capacidad
    // puesta y media retirada. Se cierra aquí, en la frontera, en castellano y
    // sin tocar la pureza ni la firma de `applyChange`.
    //
    // EL MENSAJE NO MANDA RETIRAR NADA (revisión adversarial de la reapertura,
    // V3-2): decía «Ponle otro, o retira el que hay», y «el que hay» puede ser
    // una fila que el operador no tiene delante ni forma de alcanzar desde
    // donde está. Un error que ordena una acción que quizá no se puede hacer
    // deja a quien lo lee en un callejón sin salida. Se queda con la salida
    // que SIEMPRE está disponible: ponerle otro nombre.
    if (yaHayCambioAprobadoConEseId(cal, parsed.data.change)) {
      return reply.code(409).send({
        applied: false,
        error: "Ya hay un cambio apuntado con ese nombre. Ponle otro.",
      });
    }
    const change = toCalendarChange(parsed.data.change, clock);
    // PURO. Se pide aquí para poder comprobar las resoluciones contra las citas
    // realmente afectadas y para que el historial cuente ÉSAS (V3-5).
    // `applyChange` vuelve a calcularlo por su cuenta: su firma y su pureza no
    // se tocan, que es justo lo que el normativo exige de ese módulo.
    const report = previewImpact(cal, change);
    const sobran = resolucionesSinCitaAfectada(report.impacted, parsed.data.resolutions);
    if (sobran.length > 0) {
      return reply.code(400).send({ error: RESOLUCIONES_QUE_SOBRAN, issues: sobran });
    }
    const resolutions = new Map<string, ImpactResolution>(Object.entries(parsed.data.resolutions));
    // applyChange (calendar/impact.ts) applies NOTHING and NEVER cancels/moves
    // a reservation unless every impacted reservation has an explicit
    // resolution — that hard rule is enforced there, not re-implemented here.
    const result = applyChange(cal, change, resolutions);
    if (result.unresolved.length > 0) {
      return reply.code(409).send({
        applied: false,
        unresolved: result.unresolved.map((r) => ({
          reservationId: r.reservationId,
          employeeId: r.employeeId,
          date: r.date,
          startMinutes: r.startMinutes,
          endMinutes: r.endMinutes,
          serviceId: r.serviceId,
        })),
      });
    }
    // `result.cal` is `OperationalCalendar` (calendar/impact.ts never knows
    // about `capabilities`); the underlying runtime object was built via
    // `{ ...cal, ... }` spreads throughout impact.ts, so it still carries
    // `capabilities` as an own property — re-attaching it explicitly here
    // keeps that fact expressed in the TYPE too, rather than relying on an
    // unchecked cast.
    cal = { ...result.cal, capabilities: cal.capabilities };

    encolarLlamadasAlCliente(result.flaggedForHumanContact);

    // Se cuentan las citas AFECTADAS —todas resueltas, porque la puerta de
    // arriba no deja pasar ninguna sin resolución—, no las claves que llegaron
    // en la petición (V3-5).
    calendarAuditLog.push(
      `Cambio ${changeLabel(parsed.data.change)} publicado el ${clock.nowInstantISO()} por consola-operador ` +
        `(${report.impacted.length} resolución(es) aplicada(s), ` +
        `${result.flaggedForHumanContact.length} pendiente(s) de llamar al cliente).`,
    );
    return {
      applied: true,
      unresolved: [],
      flaggedForHumanContact: result.flaggedForHumanContact.map((r) => r.reservationId),
    };
  });

  // -------------------------------------------------------------------
  // REAPERTURA §R13 — RETIRADA. Una capacidad de calendario no existe hasta
  // que se puede DESHACER: todo lo que esta consola permite crear (cierres,
  // días especiales, ausencias) se retira por aquí, con auditoría, sin tocar
  // ni una reserva.
  //
  // La retirada pasa por la MISMA puerta de resoluciones que el alta, y no
  // por simetría estética: retirar un `special_opening` puede ROMPER una cita,
  // porque una apertura especial REEMPLAZA el horario del local (ver el
  // docblock de `calendar/withdrawal.ts`). Sin esta puerta, retirar un día
  // especial cancelaría en silencio la posibilidad de una cita real.
  // -------------------------------------------------------------------

  /** Construye la retirada con el reloj INYECTADO — nunca `Date.now()`. */
  function toCalendarWithdrawal(target: { targetKind: WithdrawalTargetKind; id: string }, note?: string): CalendarWithdrawal {
    const nota = note?.trim();
    return {
      kind: target.targetKind,
      id: target.id,
      withdrawnAt: clock.nowInstantISO(),
      withdrawnBy: "console-operator",
      ...(nota !== undefined && nota !== "" ? { note: nota } : {}),
    };
  }

  const SIN_ESE_IDENTIFICADOR = "No hay ningún cambio con ese identificador.";

  app.post("/api/calendar/withdrawal/preview", async (req, reply) => {
    const parsed = WITHDRAWAL_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Retirada de calendario inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    // PURO — `previewWithdrawal` nunca muta `cal`. Ver calendar/withdrawal.ts.
    const report = previewWithdrawal(cal, toCalendarWithdrawal(parsed.data));
    // `undefined` es "no hay ninguna fila APROBADA con ese identificador", que
    // no es lo mismo que "no impacta a nadie": lo primero es un 404 y lo
    // segundo un 200 con la lista vacía. El 404 y la cuenta del impacto salen
    // de la MISMA búsqueda, así que no pueden discrepar.
    if (report === undefined) {
      return reply.code(404).send({ error: SIN_ESE_IDENTIFICADOR });
    }
    return { impacted: report.impacted.map(impactoDto) };
  });

  app.post("/api/calendar/withdrawal/publish", async (req, reply) => {
    const parsed = WITHDRAWAL_PUBLISH_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Retirada de calendario inválida", issues: parsed.error.issues.map((i) => i.message) });
    }
    const withdrawal = toCalendarWithdrawal(parsed.data.target, parsed.data.note);
    // PURO. Mismo papel que el `previewImpact` del alta: el 404 y la
    // comprobación de resoluciones salen de la MISMA cuenta que luego repetirá
    // `applyWithdrawal`, así que no pueden discrepar (V3-5).
    const report = previewWithdrawal(cal, withdrawal);
    if (report === undefined) {
      return reply.code(404).send({ error: SIN_ESE_IDENTIFICADOR });
    }
    const sobran = resolucionesSinCitaAfectada(report.impacted, parsed.data.resolutions);
    if (sobran.length > 0) {
      return reply.code(400).send({ error: RESOLUCIONES_QUE_SOBRAN, issues: sobran });
    }
    const resolutions = new Map<string, ImpactResolution>(Object.entries(parsed.data.resolutions));
    // `applyWithdrawal` (calendar/withdrawal.ts) no aplica NADA si alguna
    // reserva impactada se queda sin resolución, y NUNCA cancela, mueve ni
    // modifica una reserva — esa regla dura vive allí, no se reimplementa aquí.
    // Y devuelve `undefined` —no un resultado vacío— cuando no hay ninguna
    // fila aprobada con ese identificador; aquí `report` ya lo descartó, y la
    // comprobación se conserva porque el tipo lo dice y sale gratis.
    const result = applyWithdrawal(cal, withdrawal, resolutions);
    if (result === undefined) {
      return reply.code(404).send({ error: SIN_ESE_IDENTIFICADOR });
    }
    if (result.unresolved.length > 0) {
      return reply.code(409).send({ applied: false, unresolved: result.unresolved.map(impactoDto) });
    }
    // Igual que en el alta: `result.cal` es `OperationalCalendar`, y el objeto
    // de tiempo de ejecución conserva `capabilities` por los spreads; se
    // reengancha explícitamente para que el TIPO también lo diga.
    cal = { ...result.cal, capabilities: cal.capabilities };

    encolarLlamadasAlCliente(result.flaggedForHumanContact);

    const nota = enUnaSolaLinea(parsed.data.note ?? "");
    calendarAuditLog.push(
      `Retirada de ${withdrawalLabel(parsed.data.target.targetKind, parsed.data.target.id)} publicada el ${clock.nowInstantISO()} por consola-operador ` +
        `(${report.impacted.length} resolución(es) aplicada(s), ` +
        `${result.flaggedForHumanContact.length} pendiente(s) de llamar al cliente).` +
        (nota !== "" ? ` Nota: «${nota}».` : ""),
    );
    return {
      applied: true,
      unresolved: [],
      flaggedForHumanContact: result.flaggedForHumanContact.map((r) => r.reservationId),
    };
  });

  return app;
}

// ---------------------------------------------------------------------
// Actual startup — the ONLY place in this module tree that calls listen().
// ---------------------------------------------------------------------

export interface StartedConsoleServer {
  app: FastifyInstance;
  config: ConsoleConfig;
}

/**
 * Loads config, fails closed if the console is disabled, then binds
 * STRICTLY to loopback. Never auto-increments the port on EADDRINUSE — see
 * config.ts's docblock and the mission brief: port 3000 belongs to an
 * unrelated process on this machine and must never be touched, and this
 * console must never silently pick a different port than the one asked for.
 */
export async function startConsoleServer(env: NodeJS.ProcessEnv = process.env): Promise<StartedConsoleServer> {
  const config = loadConsoleConfig(env);
  requireConsoleEnabled(config);
  const app = buildConsoleServer({ port: config.port });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE") {
      throw new Error(
        `El puerto ${config.port} ya está en uso. Esta consola NO cambia de puerto en silencio: ` +
          `libera el puerto ${config.port} o arráncala con CALL_ENGINE_CONSOLE_PORT=<otro puerto libre>. ` +
          `El puerto 3000 pertenece a un proceso ajeno de este equipo y no debe usarse ni tocarse nunca.`,
      );
    }
    throw err;
  }
  return { app, config };
}

// Only actually starts the server when this file is run directly (e.g. by
// tools/call-engine-demo/console.sh via `tsx`), never on a plain import —
// so tests can import `buildConsoleServer` freely without side effects.
//
// La comparación vive en `directExecution.ts` y NO se hace aquí a mano: la que
// había —`import.meta.url === \`file://${process.argv[1]}\``— comparaba una URL
// percent-encoded con una ruta sin codificar y daba false en cuanto la ruta del
// repositorio tenía un espacio, dejando el proceso muerto en silencio. El
// porqué completo está en el docblock de ese módulo.
if (isDirectExecution(import.meta.url, process.argv[1])) {
  startConsoleServer()
    .then(({ config }) => {
      console.log(`Consola operativa local de Demo Salon escuchando en http://${CONSOLE_HOST}:${String(config.port)}/`);
      console.log(SYNTHETIC_FIXTURE_BANNER);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
