import { createHash, timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { resolveDayWindows } from "../../callEngine/calendar/resolveAvailability.js";
import type { CalendarWithCapabilities } from "../../callEngine/capabilities.js";
import type { Clock } from "../../callEngine/domain/types.js";
import { fixedClock } from "../../callEngine/domain/types.js";
import { addDays, dayOfWeek, daysBetween, formatHHmm, isValidDateISO } from "../../callEngine/domain/time.js";
import {
  runConversation,
  type ConversationResult,
  type ConversationTurn,
  type DayName,
  type EngineTurn,
} from "../../callEngine/engine.js";
import { createCallEventEmitter, hashCallId, type CallEventEmitter } from "../../callEngine/events/emitter.js";
import { demoSalonVenue } from "../../callEngine/fixtures/demoSalonVenue.js";
import { ES } from "../../callEngine/phrasing/es.js";
import type { PhraseKey } from "../../callEngine/phrasing/keys.js";
import { createMemoryStore, type MemoryStore } from "../../callEngine/store/memoryStore.js";
import { isDirectExecution } from "../../console/directExecution.js";
import {
  REAL_READONLY_SLOT_MINUTES,
  agendaUnavailableAnswer,
  availabilityAnswer,
  bookingAnswer,
  decideRealAgenda,
  type HeldSlot,
} from "./agenda/answers.js";
import { callDateContext, type CallDateContext } from "./agenda/callContext.js";
import { ReadOnlyAgendaError, type ReadOnlyAgendaFailureKind, type ReadOnlyAgendaPort } from "./agenda/port.js";
import {
  DEFAULT_ELEVENLABS_SYNTHETIC_NOW_MINUTES,
  DEFAULT_ELEVENLABS_SYNTHETIC_TODAY,
  ELEVENLABS_BRIDGE_HOST,
  loadElevenLabsBridgeConfig,
  requireElevenLabsBridgeEnabled,
  resolveElevenLabsSyntheticAnchor,
  type ElevenLabsSyntheticAnchor,
} from "./config.js";

const TOOL_PREFIX = "/v1/elevenlabs/";
const CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const CONVERSATION_ID_SCHEMA = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "conversation_id contiene caracteres no permitidos");

const DATE_SCHEMA = z.string().refine(isValidDateISO, "date_iso debe ser una fecha real con formato YYYY-MM-DD");

const TIME_SCHEMA = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "time debe tener formato HH:mm")
  .refine((value) => {
    const [hours, minutes] = value.split(":").map(Number);
    return hours !== undefined && minutes !== undefined && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
  }, "time debe representar una hora real");

const PROFESSIONAL_NUMBER_SCHEMA = z.number().int().positive().max(1_000_000);

/**
 * THE PROVIDER CANNOT DECLARE "number OR the word any", SO THE BRIDGE COERCES.
 *
 * ElevenLabs' tool API accepts a single JSON literal in `type`; sending
 * `["integer","string"]` is rejected with 422. The only declaration that can
 * still carry the literal `"any"` is `type: "string"`, and the LLM then emits
 * `"professional_id": "3"` for a named professional. Refusing that string
 * would break every request for a concrete person over a formatting detail
 * the provider does not let us fix upstream.
 *
 * The coercion stays deliberately narrow: digits only, nothing else. `""`,
 * `"abc"`, `"3.5"`, `" 3"` and `"-1"` remain 400, and a coerced number still
 * has to pass the same integer bounds and the same unknown-professional check
 * as a JSON number, so `"3"` and `3` are the same request — including for the
 * idempotency fingerprint, which is computed after parsing.
 */
const PROFESSIONAL_SCHEMA = z.union([
  PROFESSIONAL_NUMBER_SCHEMA,
  z.literal("any"),
  z
    .string()
    .regex(/^\d+$/, 'professional_id debe ser un número, un número en texto como "3", o el literal "any"')
    .transform((value) => Number.parseInt(value, 10))
    .pipe(PROFESSIONAL_NUMBER_SCHEMA),
]);
const SERVICE_SCHEMA = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const SLOT_REQUEST_FIELDS = {
  conversation_id: CONVERSATION_ID_SCHEMA,
  date_iso: DATE_SCHEMA,
  time: TIME_SCHEMA,
  service_id: SERVICE_SCHEMA,
  professional_id: PROFESSIONAL_SCHEMA,
  service_confirmed: z.literal(true),
} as const;

const AVAILABILITY_SCHEMA = z.object(SLOT_REQUEST_FIELDS).strict();
const BOOKING_SCHEMA = z.object({ ...SLOT_REQUEST_FIELDS, booking_confirmed: z.literal(true) }).strict();
const HUMAN_HELP_SCHEMA = z
  .object({
    conversation_id: CONVERSATION_ID_SCHEMA,
    reason: z.enum(["explicit_request", "cancel", "reschedule", "special_service", "price_or_policy", "urgent"]),
  })
  .strict();

export interface ElevenLabsSyntheticBridgeDeps {
  webhookSecret: string;
  salt: string;
  clock?: Clock;
  /**
   * The configured synthetic anchor. Ignored when `clock` is supplied: an
   * injected clock is the more specific instruction and stays authoritative
   * for tests.
   */
  anchor?: ElevenLabsSyntheticAnchor;
  initialCalendar?: CalendarWithCapabilities;
  store?: MemoryStore;
  emitter?: CallEventEmitter;
  /**
   * PRESENCIA = MODO real_readonly. Ausente —que es como lo construye todo
   * el código que existía antes— el puente sigue siendo exactamente el de
   * siempre: fixture sintético, reloj fijo y motor determinista. Que el modo
   * dependa de una dependencia que nadie inyectaba es lo que hace que «por
   * defecto no cambia nada» sea una propiedad estructural y no una promesa.
   */
  realAgenda?: RealReadOnlyAgendaWiring;
}

export interface RealReadOnlyAgendaWiring {
  /**
   * SOLO LECTURA POR TIPOS: `ReadOnlyAgendaPort` declara `readDay` y nada
   * más, así que desde este servidor no existe ninguna forma —ni siquiera
   * equivocándose— de crear, mover o cancelar una reserva de verdad.
   */
  port: ReadOnlyAgendaPort;
  /** Último día admitido, contado desde «hoy». Por defecto, los mismos siete días. */
  horizonDays?: number;
}

interface MemoizedResponse {
  statusCode: number;
  body: unknown;
}

interface RenderedResult {
  message: string;
  phraseKey: PhraseKey;
  messages: readonly string[];
}

const DAY_NAMES: readonly DayName[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function constantTimeSecretMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (item !== undefined) out[key] = canonicalize(item);
  }
  return out;
}

function requestFingerprint(route: string, body: unknown): string {
  return createHash("sha256").update(`${route}|${JSON.stringify(canonicalize(body))}`).digest("hex");
}

function renderTurn(turn: EngineTurn): string {
  return ES[turn.phraseKey](turn.params);
}

function renderResult(result: ConversationResult): RenderedResult {
  const visible = result.turns.filter(
    (turn) => turn.phraseKey !== "GREETING_DEMO_FRAME" && turn.phraseKey !== "FAREWELL",
  );
  const terminal = [...visible].reverse().find((turn) => turn.phraseKey.startsWith("REASON_")) ?? visible.at(-1);
  if (terminal === undefined) {
    return {
      message: ES.REASON_TECHNICAL_FAILURE(),
      phraseKey: "REASON_TECHNICAL_FAILURE",
      messages: [ES.REASON_TECHNICAL_FAILURE()],
    };
  }
  return {
    message: renderTurn(terminal),
    phraseKey: terminal.phraseKey,
    messages: visible.map(renderTurn),
  };
}

function slotsFrom(result: ConversationResult): readonly { date_iso: string; time: string }[] {
  const terminal = result.turns.find((turn) => turn.phraseKey === "REASON_AVAILABILITY_PROVIDED");
  const slots = terminal?.params?.slots;
  if (!Array.isArray(slots)) return [];
  return slots.flatMap((slot) => {
    if (slot === null || typeof slot !== "object") return [];
    const date = (slot as Record<string, unknown>).day;
    const time = (slot as Record<string, unknown>).time;
    return typeof date === "string" && typeof time === "string" ? [{ date_iso: date, time }] : [];
  });
}

function substitutedProfessionalFrom(result: ConversationResult): { employee_id: number; label: string } | undefined {
  const offer = result.turns.find((turn) => turn.phraseKey === "OFFER_ANOTHER_PROFESSIONAL");
  const employeeId = offer?.params?.employeeId;
  const label = offer?.params?.professional;
  return typeof employeeId === "number" && typeof label === "string"
    ? { employee_id: employeeId, label }
    : undefined;
}

function isAlternative(result: ConversationResult): boolean {
  return result.turns.some(
    (turn) => turn.phraseKey === "OFFER_ALTERNATIVES" || turn.phraseKey === "OFFER_ANOTHER_PROFESSIONAL",
  );
}

/**
 * `mode` nombra QUÉ PUENTE contesta, no de dónde salieron los datos de esa
 * respuesta concreta — es el mismo valor que publica `/health`. Importa para
 * `booking_human_help`, la única herramienta que en modo real_readonly sigue
 * pasando por el motor sintético: escala sin mirar ni un hueco, así que no
 * lee la agenda de nadie, y anunciar `synthetic` sólo en esa respuesta
 * dejaría al agente de voz con dos modos distintos dentro de una misma
 * llamada. Por defecto es `synthetic`, que es lo que respondía antes de
 * existir este parámetro y lo que sigue respondiendo el modo de siempre.
 */
function engineResponse(
  result: ConversationResult,
  mode: "synthetic" | "real_readonly" = "synthetic",
): Record<string, unknown> {
  const rendered = renderResult(result);
  return {
    ok: result.outcome === "RESUELVE",
    mode,
    message: rendered.message,
    phrase_key: rendered.phraseKey,
    messages: rendered.messages,
    outcome: result.outcome,
    reason_code: result.reasonCode,
    internal_reason_code: result.internalReasonCode,
    announces_success: result.announcesSuccess,
    external_mutation: false,
    synthetic_mutation: result.syntheticMutation,
  };
}

/** Last day the synthetic window accepts, as an offset from "today". */
const MAX_WINDOW_OFFSET_DAYS = 6;

function dateToSupportedDay(clock: Clock, dateISO: string): DayName | undefined {
  const distance = daysBetween(clock.nowISODate(), dateISO);
  if (distance < 0 || distance > MAX_WINDOW_OFFSET_DAYS) return undefined;
  return DAY_NAMES[dayOfWeek(dateISO)];
}

function humanTurn(reason: z.infer<typeof HUMAN_HELP_SCHEMA>["reason"]): ConversationTurn {
  const utteranceByReason: Readonly<Record<typeof reason, string>> = {
    explicit_request: "quiero hablar con una persona",
    cancel: "quiero cancelar mi cita y hablar con una persona",
    reschedule: "quiero cambiar mi cita y hablar con una persona",
    special_service: "necesito un servicio especial y hablar con una persona",
    price_or_policy: "quiero saber el precio y hablar con una persona",
    urgent: "necesito ayuda urgente de una persona",
  };
  return {
    utterance: utteranceByReason[reason],
    explicitlyRequestsHuman: true,
    ...(reason === "urgent" ? { urgent: true } : {}),
  };
}

/**
 * FAIL CLOSED ON A WEEK THAT CANNOT ANSWER — AND ONLY ON THAT.
 *
 * The unit of work here is the WINDOW, not the first day. A caller phoning on
 * a Sunday to book for Tuesday is the most ordinary call this bridge will
 * ever take, and the venue is closed on Sundays and Mondays: demanding that
 * day 0 be open would refuse to start on exactly the day the demo runs. What
 * is genuinely useless — and what this refuses out loud instead of serving —
 * is a whole seven-day window in which nobody works on any day, because then
 * every single request would come back "no hay hueco" and read like a broken
 * engine rather than a misconfigured calendar.
 *
 * The seven days are the same ones `dateToSupportedDay` accepts, so the
 * check and the 422 can never disagree about what "the window" is.
 */
function assertSyntheticWindowIsUsable(calendar: CalendarWithCapabilities, today: string): void {
  for (let offset = 0; offset <= MAX_WINDOW_OFFSET_DAYS; offset += 1) {
    const dateISO = addDays(today, offset);
    const somebodyWorks = calendar.professionals.some(
      (person) => resolveDayWindows(calendar, person.employeeId, dateISO).windows.length > 0,
    );
    if (somebodyWorks) return;
  }
  throw new Error(
    `Ningún día de la ventana sintética ${today}..${addDays(today, MAX_WINDOW_OFFSET_DAYS)} abre para nadie, ` +
      "así que el puente no arranca: serviría una semana entera sin un solo hueco. " +
      "Revisa ELEVENLABS_SYNTHETIC_TODAY y el horario de la agenda sintética.",
  );
}

function validationError(reply: FastifyReply, parsed: { error: z.ZodError }): FastifyReply {
  return reply.code(400).send({
    error: "invalid_tool_request",
    external_mutation: false,
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/**
 * Builds the authenticated ElevenLabs server-tool bridge without opening a
 * socket. Tests exercise this exact instance via Fastify `.inject()`.
 *
 * ElevenLabs owns speech recognition, turn-taking and entity extraction. The
 * bridge accepts only a complete structured tool command; the deterministic
 * call engine remains the authority that validates the slot and the two
 * confirmation gates. No historical `/ai/*` route is imported here.
 */
export function buildElevenLabsSyntheticBridge(deps: ElevenLabsSyntheticBridgeDeps): FastifyInstance {
  if (deps.webhookSecret.length < 32 || deps.salt.length < 32) {
    throw new Error("webhookSecret y salt deben tener al menos 32 caracteres");
  }

  const anchor = deps.anchor ?? {
    today: DEFAULT_ELEVENLABS_SYNTHETIC_TODAY,
    nowMinutes: DEFAULT_ELEVENLABS_SYNTHETIC_NOW_MINUTES,
    nowTime: formatHHmm(DEFAULT_ELEVENLABS_SYNTHETIC_NOW_MINUTES),
  };
  const clock = deps.clock ?? fixedClock(anchor.today, anchor.nowMinutes);
  const store = deps.store ?? createMemoryStore();
  const emitter = deps.emitter ?? createCallEventEmitter();
  const realAgenda = deps.realAgenda;
  const realHorizonDays = realAgenda?.horizonDays ?? MAX_WINDOW_OFFSET_DAYS;
  // The sample appointments follow the clock, not a hardcoded day: an agenda
  // anchored elsewhere would leave the configured "today" completely empty.
  let calendar = deps.initialCalendar ?? demoSalonVenue(clock.nowISODate());
  if (realAgenda === undefined) {
    assertSyntheticWindowIsUsable(calendar, clock.nowISODate());
  } else {
    /**
     * EN real_readonly EL FIXTURE NO DECIDE NADA.
     *
     * La disponibilidad la contesta el puerto de solo lectura, no este
     * calendario. Lo que se conserva de él son dos cosas y ninguna toca la
     * agenda: `booking_human_help`, que escala sin mirar ni un hueco, y la
     * lista `reservations`, que hace de overlay en memoria de lo que
     * `booking_book` retiene durante este proceso.
     *
     * Las citas de MUESTRA del fixture se vacían aquí a propósito: son de
     * profesionales sintéticos en días sintéticos y, si por casualidad un id
     * coincidiera con el de una persona real, bloquearían huecos que en la
     * agenda de verdad están libres. Un overlay que empieza vacío sólo puede
     * contener lo que este proceso ha retenido de verdad.
     *
     * Tampoco se exige aquí `assertSyntheticWindowIsUsable`: comprueba que
     * la semana del FIXTURE tenga huecos, y en este modo el fixture no
     * contesta ninguna consulta.
     */
    calendar = { ...calendar, reservations: [] };
  }
  let scenarioSequence = 0;
  const memoizedCommands = new Map<string, MemoizedResponse>();

  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 32 * 1024 });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith(TOOL_PREFIX)) return;
    const raw = request.headers["x-booking-voice-secret"];
    const supplied = Array.isArray(raw) ? undefined : raw;
    if (!constantTimeSecretMatches(supplied, deps.webhookSecret)) {
      await reply.code(401).send({ error: "unauthorized_tool_request", external_mutation: false });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  function nextScenario(label: string): string {
    scenarioSequence += 1;
    return `A90-elevenlabs-${label}-${String(scenarioSequence).padStart(6, "0")}`;
  }

  function run(
    label: string,
    conversationId: string,
    turn: ConversationTurn,
    options: { scratch?: boolean } = {},
  ): ConversationResult {
    return runConversation(
      {
        cal: calendar,
        clock,
        emitter: options.scratch ? createCallEventEmitter() : emitter,
        store: options.scratch ? createMemoryStore() : store,
        salt: deps.salt,
        liveTransferAvailable: false,
      },
      {
        scenarioId: nextScenario(label),
        callId: `${conversationId}:${label}`,
        turns: [turn],
      },
    );
  }

  function ensureKnownProfessional(professionalId: number | "any", reply: FastifyReply): boolean {
    if (professionalId === "any" || calendar.professionals.some((person) => person.employeeId === professionalId)) {
      return true;
    }
    reply.code(400).send({ error: "unknown_professional", external_mutation: false });
    return false;
  }

  function slotTurn(input: z.infer<typeof AVAILABILITY_SCHEMA>, utterance: string): ConversationTurn {
    const day = dateToSupportedDay(clock, input.date_iso);
    if (day === undefined) throw new Error("unsupported_demo_date");
    return {
      utterance,
      day,
      time: input.time,
      professionalId: input.professional_id,
      serviceId: input.service_id,
      serviceConfirmed: true,
    };
  }

  function unsupportedDate(reply: FastifyReply): FastifyReply {
    return reply.code(422).send({
      error: "date_outside_synthetic_window",
      message: `Esta fase sintética sólo admite fechas entre ${clock.nowISODate()} y los seis días siguientes.`,
      external_mutation: false,
    });
  }

  function replayIfKnown(route: string, body: unknown, reply: FastifyReply): string | undefined {
    const key = requestFingerprint(route, body);
    const known = memoizedCommands.get(key);
    if (known === undefined) return key;
    reply.header("Idempotency-Status", "replayed").code(known.statusCode).send(known.body);
    return undefined;
  }

  function remember(key: string, statusCode: number, body: unknown): void {
    if (statusCode >= 200 && statusCode < 300) memoizedCommands.set(key, { statusCode, body });
  }

  // -------------------------------------------------------------------
  // Modo real_readonly. Todo lo que sigue está muerto —literalmente
  // inalcanzable— mientras `deps.realAgenda` sea `undefined`, que es como
  // arranca el puente por defecto y como lo construye cada prueba anterior
  // a esta puerta.
  // -------------------------------------------------------------------

  /** Los huecos que este proceso ya ha retenido; nunca salen de esta memoria. */
  function heldSlots(): HeldSlot[] {
    return calendar.reservations
      .filter((reservation) => reservation.status === "confirmed")
      .map((reservation) => ({
        dateISO: reservation.date,
        employeeId: reservation.employeeId,
        startMinutes: reservation.startMinutes,
      }));
  }

  function realFailureKind(error: unknown): ReadOnlyAgendaFailureKind {
    return error instanceof ReadOnlyAgendaError ? error.kind : "unavailable";
  }

  function outsideRealWindow(dateISO: string): boolean {
    const distance = daysBetween(clock.nowISODate(), dateISO);
    return distance < 0 || distance > realHorizonDays;
  }

  function unsupportedRealDate(reply: FastifyReply): FastifyReply {
    return reply.code(422).send({
      error: "date_outside_supported_window",
      message:
        `Este puente sólo consulta entre ${clock.nowISODate()} y ` +
        `${addDays(clock.nowISODate(), realHorizonDays)}.`,
      external_mutation: false,
    });
  }

  async function realDecision(
    wiring: RealReadOnlyAgendaWiring,
    input: z.infer<typeof AVAILABILITY_SCHEMA>,
  ): Promise<ReturnType<typeof decideRealAgenda> | { kind: "unavailable"; failure: ReadOnlyAgendaFailureKind }> {
    try {
      const day = await wiring.port.readDay({ dateISO: input.date_iso, serviceId: input.service_id });
      return decideRealAgenda(
        day,
        { dateISO: input.date_iso, time: input.time, professional: input.professional_id },
        { clock, held: heldSlots() },
      );
    } catch (error) {
      return { kind: "unavailable", failure: realFailureKind(error) };
    }
  }

  /** Referencia estable y sin datos personales para una retención en memoria. */
  function realReservationReference(dateISO: string, employeeId: number, startMinutes: number): string {
    const digest = createHash("sha256")
      .update(`${deps.salt}|real_readonly|${dateISO}|${String(employeeId)}|${String(startMinutes)}`)
      .digest("hex");
    return `RRO-${digest.slice(0, 12)}`;
  }

  /**
   * `booking_book` EN MODO real_readonly: LEE LA AGENDA REAL, ESCRIBE SÓLO EN MEMORIA.
   *
   * La reserva se revalida contra la agenda de verdad —el hueco puede haberse
   * ocupado entre la consulta y la confirmación— y, si sigue libre, se retiene
   * en el overlay en memoria de ESTE proceso. En el Symfony real no se crea
   * nada: el puerto inyectado no tiene con qué. Por eso la respuesta viaja con
   * `external_mutation: false`, `reservation.synthetic: true` y, dicho sin
   * ambigüedad, `reservation.upstream_persisted: false`.
   *
   * La frase que se dice en voz alta es la aprobada de siempre («la reserva
   * ficticia queda confirmada en esta demostración local»): sigue siendo
   * literalmente cierta aquí, y es lo que impide que alguien cuelgue creyendo
   * que tiene cita en la peluquería.
   */
  async function realBook(
    wiring: RealReadOnlyAgendaWiring,
    input: z.infer<typeof BOOKING_SCHEMA>,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    if (outsideRealWindow(input.date_iso)) return unsupportedRealDate(reply);

    const memoKey = replayIfKnown("POST /v1/elevenlabs/book", input, reply);
    if (memoKey === undefined) return reply;

    const decision = await realDecision(wiring, input);
    reply.header("Idempotency-Status", "original");

    if (decision.kind === "unavailable") {
      // Un fallo técnico NO se memoiza. Memoizarlo convertiría una caída de
      // treinta segundos en la respuesta definitiva de esa reserva para toda
      // la vida del proceso: el reintento del proveedor tiene que poder
      // acabar en una respuesta de verdad.
      return reply.code(200).send({
        ...agendaUnavailableAnswer(decision.failure),
        booked: false,
        requires_customer_confirmation: false,
        offered_slots: [],
      });
    }

    if (decision.kind !== "exact") {
      // Una alternativa NO se reserva sola, exactamente igual que en modo
      // sintético: se ofrece y hace falta una segunda llamada confirmada.
      const body = { ...availabilityAnswer(decision), booked: false };
      remember(memoKey, 200, body);
      return reply.code(200).send(body);
    }

    const reservation = {
      id: realReservationReference(decision.dateISO, decision.employeeId, decision.startMinutes),
      employeeId: decision.employeeId,
      serviceId: input.service_id,
      date: decision.dateISO,
      startMinutes: decision.startMinutes,
      // La rejilla de 30' del demo. La duración REAL por servicio en el
      // contrato Symfony está sin verificar (internal doc, not included in the template), y
      // este puente no la inventa: sólo retiene el hueco que consultó.
      endMinutes: decision.startMinutes + REAL_READONLY_SLOT_MINUTES,
      status: "confirmed" as const,
      // El identificador de conversación se guarda SALADO, nunca en claro.
      callIdHash: hashCallId(input.conversation_id, deps.salt),
      synthetic: true as const,
    };
    calendar = store.addReservation(calendar, reservation);

    const body = {
      ...bookingAnswer(),
      booked: true,
      requires_customer_confirmation: false,
      reservation: {
        reference: reservation.id,
        employee_id: reservation.employeeId,
        service_id: reservation.serviceId,
        date_iso: reservation.date,
        start_minutes: reservation.startMinutes,
        end_minutes: reservation.endMinutes,
        synthetic: true,
        /** Dicho explícitamente: en el sistema real no se ha escrito nada. */
        upstream_persisted: false,
      },
    };
    remember(memoKey, 200, body);
    return reply.code(200).send(body);
  }

  /**
   * EL CONTEXTO DE FECHA QUE `/health` PUBLICA, CON EL HORIZONTE QUE DE VERDAD
   * MANDA EN ESTE PUENTE.
   *
   * En real_readonly la ventana la fija `realHorizonDays` —el mismo número
   * que usa `outsideRealWindow` para el 422— y en sintético la fija
   * `MAX_WINDOW_OFFSET_DAYS`, el mismo que usa `dateToSupportedDay`. Se elige
   * aquí con la MISMA condición que elige el modo (`realAgenda === undefined`)
   * para que `window_end_iso` no pueda anunciar un día que la otra mitad del
   * fichero rechazaría.
   */
  function dateContext(): CallDateContext {
    return callDateContext(clock, realAgenda === undefined ? MAX_WINDOW_OFFSET_DAYS : realHorizonDays);
  }

  /**
   * `/health` ES LA FUENTE DE LA FECHA DEL PROMPT.
   *
   * El prompt del agente de ElevenLabs ya no lleva la fecha escrita a mano:
   * el lanzador de llamadas lee esto y copia `today_spoken_es`,
   * `window_end_iso` y `timezone` como variables dinámicas, sin recalcular
   * nada por su cuenta. Los campos de siempre siguen intactos —hay pruebas y
   * documentación que los citan—; lo nuevo se AÑADE.
   */
  app.get("/health", async () => {
    const dates = dateContext();
    return realAgenda === undefined
      ? {
          ok: true,
          service: "demo-salon-elevenlabs-synthetic-bridge",
          mode: "synthetic",
          external_mutation: false,
          synthetic_today: clock.nowISODate(),
          synthetic_now: formatHHmm(clock.nowMinutes()),
          today_spoken_es: dates.today_spoken_es,
          window_end_iso: dates.window_end_iso,
          timezone: dates.timezone,
        }
      : {
          ok: true,
          service: "demo-salon-elevenlabs-real-readonly-bridge",
          mode: "real_readonly",
          external_mutation: false,
          /** La mitad de escritura de la puerta E5 sigue cerrada, y se dice. */
          upstream_writes: "disabled",
          today: clock.nowISODate(),
          now: formatHHmm(clock.nowMinutes()),
          today_spoken_es: dates.today_spoken_es,
          window_end_iso: dates.window_end_iso,
          timezone: dates.timezone,
        };
  });

  app.post(`${TOOL_PREFIX}availability`, async (request, reply) => {
    const parsed = AVAILABILITY_SCHEMA.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed);
    if (realAgenda !== undefined) {
      if (outsideRealWindow(parsed.data.date_iso)) return unsupportedRealDate(reply);
      // Aquí NO se valida el profesional contra el fixture: la plantilla la
      // decide la agenda real, día a día. Un id que ese día no trabaja acaba
      // ofreciendo otra persona o ningún hueco —que es la verdad— en vez de
      // un 400 dictado por una lista sintética que en este modo no manda.
      const decision = await realDecision(realAgenda, parsed.data);
      if (decision.kind === "unavailable") {
        return reply.code(200).send({
          ...agendaUnavailableAnswer(decision.failure),
          requested_slot_available: false,
          requires_customer_confirmation: false,
          offered_slots: [],
        });
      }
      return reply.code(200).send(availabilityAnswer(decision));
    }

    if (!ensureKnownProfessional(parsed.data.professional_id, reply)) return reply;
    if (dateToSupportedDay(clock, parsed.data.date_iso) === undefined) return unsupportedDate(reply);

    const result = run(
      "availability",
      parsed.data.conversation_id,
      slotTurn(parsed.data, "quiero consultar disponibilidad"),
    );
    const offeredSlots = slotsFrom(result);
    const offeredProfessional = substitutedProfessionalFrom(result);
    const alternative = isAlternative(result);
    return reply.code(200).send({
      ...engineResponse(result),
      requested_slot_available: result.reasonCode === "AVAILABILITY_PROVIDED" && !alternative,
      requires_customer_confirmation: result.reasonCode === "AVAILABILITY_PROVIDED",
      offered_slots: offeredSlots,
      ...(offeredProfessional !== undefined ? { offered_professional: offeredProfessional } : {}),
    });
  });

  app.post(`${TOOL_PREFIX}book`, async (request, reply) => {
    const parsed = BOOKING_SCHEMA.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed);

    if (realAgenda !== undefined) return await realBook(realAgenda, parsed.data, reply);

    if (!ensureKnownProfessional(parsed.data.professional_id, reply)) return reply;
    if (dateToSupportedDay(clock, parsed.data.date_iso) === undefined) return unsupportedDate(reply);

    const memoKey = replayIfKnown("POST /v1/elevenlabs/book", parsed.data, reply);
    if (memoKey === undefined) return reply;

    // The current batch engine can propose an alternative and continue in
    // the same scripted turn. A real voice caller has not accepted that new
    // slot yet. Preflight on disposable stores first and refuse the write if
    // an OFFER_* phrase appears. The provider must ask, then call `book`
    // again with the accepted slot as the new exact request.
    const preflight = run(
      "booking-preflight",
      parsed.data.conversation_id,
      slotTurn(parsed.data, "quiero consultar disponibilidad"),
      { scratch: true },
    );
    if (preflight.reasonCode !== "AVAILABILITY_PROVIDED" || isAlternative(preflight)) {
      const body = {
        ...engineResponse(preflight),
        booked: false,
        requires_customer_confirmation: preflight.reasonCode === "AVAILABILITY_PROVIDED",
        offered_slots: slotsFrom(preflight),
        ...(substitutedProfessionalFrom(preflight) !== undefined
          ? { offered_professional: substitutedProfessionalFrom(preflight) }
          : {}),
      };
      remember(memoKey, 200, body);
      reply.header("Idempotency-Status", "original");
      return reply.code(200).send(body);
    }

    const bookingTurn = {
      ...slotTurn(parsed.data, "quiero reservar una cita"),
      bookingConfirmed: true,
    } satisfies ConversationTurn;
    const result = run("booking", parsed.data.conversation_id, bookingTurn);
    if (result.reservation !== undefined) {
      calendar = { ...calendar, reservations: [...calendar.reservations, result.reservation] };
    }
    const body = {
      ...engineResponse(result),
      booked: result.reasonCode === "BOOKING_CONFIRMED" && result.reservation !== undefined,
      requires_customer_confirmation: false,
      ...(result.reservation !== undefined
        ? {
            reservation: {
              reference: result.reservation.id,
              employee_id: result.reservation.employeeId,
              service_id: result.reservation.serviceId,
              date_iso: result.reservation.date,
              start_minutes: result.reservation.startMinutes,
              end_minutes: result.reservation.endMinutes,
              synthetic: true,
            },
          }
        : {}),
    };
    remember(memoKey, 200, body);
    reply.header("Idempotency-Status", "original");
    return reply.code(200).send(body);
  });

  app.post(`${TOOL_PREFIX}human-help`, async (request, reply) => {
    const parsed = HUMAN_HELP_SCHEMA.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed);

    const memoKey = replayIfKnown("POST /v1/elevenlabs/human-help", parsed.data, reply);
    if (memoKey === undefined) return reply;

    // NINGUNA LECTURA DE AGENDA, EN NINGUNO DE LOS DOS MODOS. Escalar a una
    // persona no depende de que haya hueco, así que `realAgenda.port` no se
    // toca aquí ni cuando existe: en modo real_readonly esta ruta no genera
    // ni una petición al upstream.
    const result = run("human-help", parsed.data.conversation_id, humanTurn(parsed.data.reason));
    const body = {
      ...engineResponse(result, realAgenda === undefined ? "synthetic" : "real_readonly"),
      help_requested: result.reasonCode === "CUSTOMER_REQUESTS_HUMAN",
      transfer_completed: false,
      reason: parsed.data.reason,
    };
    remember(memoKey, 200, body);
    reply.header("Idempotency-Status", "original");
    return reply.code(200).send(body);
  });

  return app;
}

export interface StartedElevenLabsSyntheticBridge {
  app: FastifyInstance;
  host: typeof ELEVENLABS_BRIDGE_HOST;
  port: number;
  /** The synthetic date/time this process actually runs on. Never a secret. */
  anchor: ElevenLabsSyntheticAnchor;
}

export async function startElevenLabsSyntheticBridge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedElevenLabsSyntheticBridge> {
  const config = loadElevenLabsBridgeConfig(env);
  requireElevenLabsBridgeEnabled(config);
  const anchor = resolveElevenLabsSyntheticAnchor(config);
  const app = buildElevenLabsSyntheticBridge({
    webhookSecret: config.webhookSecret,
    salt: config.callHashSalt,
    anchor,
  });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
      throw new Error(`El puerto ${config.port} ya está en uso; el puente ElevenLabs no cambia de puerto en silencio.`);
    }
    throw error;
  }
  return { app, host: config.host, port: config.port, anchor };
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  startElevenLabsSyntheticBridge()
    .then(({ host, port, anchor }) => {
      console.log(`Puente sintético de ElevenLabs escuchando en http://${host}:${String(port)}/`);
      console.log(`«Hoy» sintético: ${anchor.today} a las ${anchor.nowTime} (reloj fijo, nunca el reloj real)`);
      console.log("Datos sintéticos · Sin producción · Sin mutaciones externas");
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
