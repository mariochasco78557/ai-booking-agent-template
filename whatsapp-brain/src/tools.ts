/**
 * The tools the model may call, and what each one really does.
 *
 * Definitions come from the SAME documents the ElevenLabs agents use
 * (`prompts/TOOL_SCHEMAS_*.json`, copies of `docs/elevenlabs/`), so the
 * WhatsApp V1 prompt reads exactly the contract it was written for.
 *
 * Two things are never left to the model:
 *  - `conversation_id`: the brain sets it (one per WhatsApp session), so the
 *    middleware's continuation and slot tokens can never cross conversations.
 *  - `phone`: for a Spanish WhatsApp number it is the sender's own number,
 *    read from Meta's webhook. The model cannot book under someone else's.
 */
import { readFileSync } from "node:fs";
import type { MiddlewareApi, RecadoBody } from "./middleware.js";
import { collectOfferedSlots, collectPage, MAX_ROWS, type LatestPage, type OfferedSlot } from "./interactive.js";
import { closedKind, weekdayNamePlural, type OpeningHours } from "./hours.js";

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface PendingHandoff {
  reason: string;
  summary: string;
  customerName?: string;
  callbackPhone?: string;
}

export interface ToolSession {
  /** Sent as `conversation_id` to the middleware. */
  middlewareConversationId: string;
  /** 9-digit Spanish phone of the sender, or null for a foreign number. */
  spanishPhone: string | null;
  bookingEnabled: boolean;
  /** WA_SELF_SERVICE_SECRET configured: «mis citas» / «anular» reach the middleware. */
  selfServiceEnabled: boolean;
  /** Vocero's conversation id (`ctx.conversationId`); lets Bruno open the chat from the recado. */
  voceroConversationId?: string;
  /** Outcome of the last recado call (for logs: never the message, name or phone). */
  lastRecadoOutcome?: string;
  /** Set by `avisar_a_owner`; executed after the final reply is sent. */
  pendingHandoff?: PendingHandoff;
  /** Outcome of the last booking attempt, for logs. */
  lastBookingOutcome?: string;
  /**
   * 2026-10-09 — bookings confirmed so far in this WhatsApp conversation and
   * how many it may make. Absent = no limit here (the middleware's per-phone
   * limit still applies).
   */
  bookingsConfirmed?: number;
  maxBookingsPerConversation?: number;
  /** Calendar links of the appointments booked this turn; appended to the reply by the brain. */
  calendarUrls?: string[];
  /** Cancellations done this turn that the salon's system did not announce to Bruno. */
  cancellations?: CancellationRecord[];
  /** Weekly schedule: availability calls for a closed day/afternoon are answered locally. */
  openingHours?: OpeningHours;
  /** Hours the availability tools returned this turn (for tappable options). */
  offeredSlots?: OfferedSlot[];
  /**
   * The LATEST discover / scan / more answer of this turn (all its options, in
   * order, and `has_more`). Cleared by a `lock`: a reply about a locked hour
   * is not a page to choose from.
   */
  latestAvailability?: LatestPage;
  /** Set by `notify_late_arrival`; only written to the ficha after the reply. */
  lateArrival?: { minutes?: number };
  /**
   * 2026-10-09 (escaneo, hallazgo 2) — the slot of every `locked` answer seen
   * (this turn and, seeded by the brain, earlier ones), by slot_token: what a
   * confirmed create booked, without asking the model.
   */
  knownLocks?: Record<string, LockedSlotInfo>;
  /** 2026-10-09 (hallazgo 2) — what really changed in the agenda this turn. */
  doneThisTurn?: DoneAction[];
  /**
   * 2026-10-10 («errores sin agobiar») — `date_conflict` answers in a row for
   * the day being asked (seeded by the brain from earlier turns). The second
   * one reaches the model marked `segundo_intento`.
   */
  dateConflicts?: number;
  /**
   * 2026-10-11 — every booking confirmed this turn (replays included), with the
   * calendar link when the middleware gave a valid one. A booking without `url`
   * is recovered by the brain through POST /ai/wa/calendar-link.
   */
  confirmedBookings?: ConfirmedBooking[];
  /** 2026-10-11 — the `message` of every tool answer of this turn (for the closure guard). */
  turnMessages?: string[];
  /** 2026-10-11 — the `message` of the last availability answer of this turn. */
  lastAvailabilityMessage?: string;
}

/** A booking the middleware confirmed this turn. */
export interface ConfirmedBooking {
  slotToken?: string;
  info?: LockedSlotInfo;
  /** Absent when the middleware gave no valid `https://` calendar link. */
  url?: string;
}

/**
 * 2026-10-10 («errores sin agobiar», regla del owner) — at most two tries per
 * piece of data. A `date_conflict` is one failed try at the day; an answer
 * that read the agenda for a day (or a `locked`) means the day was understood,
 * so the count starts again. Anything else (errors, `more`) leaves it as is.
 */
export const SECOND_ATTEMPT_FIELD = "segundo_intento";
export const MAX_DATE_ATTEMPTS = 2;
const DAY_UNDERSTOOD_OUTCOMES = new Set(["options_available", "no_availability", "no_more_options", "locked"]);

export function nextDateConflictCount(previous: number, result: Record<string, unknown>): number {
  if (result.outcome === "date_conflict") return previous + 1;
  if (typeof result.outcome === "string" && DAY_UNDERSTOOD_OUTCOMES.has(result.outcome)) return 0;
  return previous;
}

export interface LockedSlotInfo {
  date: string;
  time: string;
  professional?: string;
}

/** A booking or a cancellation that the middleware confirmed this turn. */
export interface DoneAction {
  kind: "booked" | "cancelled";
  /** «el sábado 10 de octubre» (booked) or the middleware's day_label (cancelled). */
  day?: string;
  time?: string;
  professional?: string;
  /** The middleware's own fixed sentence, used when the slot is not known. */
  serverMessage?: string;
}

/** The `slot` of a `locked` lock answer, or undefined. */
export function lockedSlotOf(result: Record<string, unknown>): { token: string; info: LockedSlotInfo } | undefined {
  if (result.outcome !== "locked") return undefined;
  const slot = result.slot;
  if (!slot || typeof slot !== "object") return undefined;
  const { slot_token, date, time, employee_name } = slot as Record<string, unknown>;
  if (typeof slot_token !== "string" || typeof date !== "string" || typeof time !== "string") return undefined;
  return {
    token: slot_token,
    info: { date, time, ...(typeof employee_name === "string" && employee_name.trim() ? { professional: employee_name.trim() } : {}) },
  };
}

const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** `"2026-10-10"` -> `"el sábado 10 de octubre"`; anything else unchanged. */
export function dayLabelEs(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return date;
  return `el ${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]}`;
}

export interface CancellationRecord {
  day_label: string;
  time: string;
  professional: string;
  /** Minutes of notice given; internal record only, never shown to the customer. */
  notice_minutes?: number;
  late_notice?: boolean;
}

export const TOOL_AVAILABILITY = "booking_availability_balanced_v2";
export const TOOL_BOOK = "booking_create_booking_balanced_v2";
export const TOOL_MY_BOOKINGS = "booking_mis_citas";
export const TOOL_CANCEL = "booking_cancelar_cita";
/** 2026-10-11 (internal doc, not included in the template): changes ONLY the service of an appointment. */
export const TOOL_CHANGE_SERVICE = "booking_cambiar_servicio";
export const TOOL_NOTIFY_OWNER = "avisar_a_owner";
export const TOOL_LATE_ARRIVAL = "notify_late_arrival";

const SERVICE_CHANGE_UNAVAILABLE_MESSAGE = "Ahora no puedo cambiar el servicio por aquí. ¿Quieres que se lo pase a Bruno?";

const LATE_ARRIVAL_MESSAGE = "Gracias por avisar. Te esperamos.";

const LATE_ARRIVAL_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: TOOL_LATE_ARRIVAL,
    description:
      "The customer says they will arrive late to an existing appointment (\"llego tarde\", \"voy con retraso\"). This is NOT a cancellation: never cancel. It passes the notice to Bruno. Then reply ONLY by copying the tool's message exactly; never write \"no pasa nada\".",
    parameters: {
      type: "object",
      properties: {
        minutes_late: { type: "integer", minimum: 1, maximum: 240, description: "Optional. Approximate minutes of delay, if the customer said." },
        summary: { type: "string", maxLength: 300, description: "In Spanish, what the customer wrote about the delay, in their words." },
      },
      required: [],
    },
  },
};

const SELF_SERVICE_OFF_MESSAGE =
  "Por aquí todavía no puedo ver ni anular citas. Si quieres, le dejo el aviso a Bruno con el día y la hora y te contesta en cuanto pueda.";
const IDENTITY_UNAVAILABLE_MESSAGE =
  "Con este número no puedo consultar ni anular citas por aquí. Si quieres, le dejo el aviso a Bruno para que te conteste.";
const OWNER_NOTIFIED_MESSAGE = "Le he dejado el aviso a Bruno. Te contestará en cuanto pueda.";
/** 2026-10-09 — the brain's own refusal: this conversation already made its bookings. */
export const OUTCOME_CONVERSATION_LIMIT = "conversation_booking_limit";

const NUMBER_WORDS = ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];

export function conversationLimitMessage(max: number): string {
  const n = NUMBER_WORDS[max] ?? String(max);
  const what = max === 1 ? "una cita" : `${n} citas`;
  return `Por aquí puedo dejar como máximo ${what} en una misma conversación. Si necesitas otra, se lo dejo apuntado a Bruno y te contesta por aquí.`;
}

const WRITE_DISABLED_MESSAGE =
  "Ahora mismo no puedo crear la cita por aquí. Si quieres, le dejo el aviso a Bruno con el día y la hora para que te la confirme.";

/** `avisar_a_owner.reason` -> recado kind. Everything not listed is a `question`. */
const RECADO_KIND_BY_REASON: Record<string, RecadoBody["kind"]> = {
  wants_human: "wants_human",
  complaint: "complaint",
};

const RECADO_SERVER_MESSAGE_OUTCOMES = new Set(["recado_queued", "recado_duplicate", "recado_limit"]);

/**
 * Calls the middleware's recado route and returns the server's customer phrase
 * when it queued/deduplicated/limited the recado; otherwise `fallback`. Never
 * throws, never logs names, phones or summaries (only the outcome).
 */
async function sendRecado(
  middleware: MiddlewareApi,
  session: ToolSession,
  body: Omit<RecadoBody, "conversation_id" | "vocero_conversation_id">,
  fallback: string
): Promise<string> {
  let result: Record<string, unknown>;
  try {
    result = await middleware.recado(session.spanishPhone, {
      conversation_id: session.middlewareConversationId,
      ...body,
      ...(session.voceroConversationId ? { vocero_conversation_id: session.voceroConversationId } : {}),
    });
  } catch {
    session.lastRecadoOutcome = "recado_unavailable";
    return fallback;
  }
  const outcome = typeof result?.outcome === "string" ? result.outcome : "";
  session.lastRecadoOutcome = outcome || "recado_unavailable";
  const message = typeof result?.message === "string" ? result.message.trim() : "";
  return RECADO_SERVER_MESSAGE_OUTCOMES.has(outcome) && message ? message : fallback;
}

const NOTIFY_REASONS = new Set([
  "wants_human",
  "cannot_identify",
  "reservation_not_found",
  "cancel_request",
  "change_request",
  "complaint",
  "other",
]);

interface SchemaDoc {
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
}

function loadSchemaDoc(file: string): SchemaDoc {
  const url = new URL(`../prompts/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as SchemaDoc;
}

/** A deep copy of a JSON schema without the properties the brain fills itself. */
function withoutServerFields(parameters: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
  const props = copy.properties as Record<string, unknown> | undefined;
  if (props) for (const f of fields) delete props[f];
  if (Array.isArray(copy.required)) copy.required = (copy.required as string[]).filter((r) => !fields.includes(r));
  return copy;
}

/**
 * WhatsApp pages (2026-10-08): the middleware sends up to ten options when the
 * brain declares the WhatsApp channel, so the model's copy of the tool must
 * accept `option_index` up to that. The shared document
 * (`docs/elevenlabs/TOOL_SCHEMAS_BALANCED_V2.json`, voice) keeps `[1, 2, 3]`:
 * only this in-memory copy is widened.
 */
const WHATSAPP_PAGE_NOTE =
  " WHATSAPP: in this chat a discover/scan/more page holds UP TO TEN options, numbered 1..N (not only 1, 2, 3); lock takes the option_index of the LATEST page, 1..N. When the customer answers with an hour («15:30», «Mar 13 · 15:30»), use the option_index that hour has in the options of the LATEST page. «Más horas» means action=\"more\".";

/**
 * 2026-10-09 («el próximo jueves» became the 29th): the WORD the customer
 * wrote for the day. The middleware reads it from the raw body and, on
 * WhatsApp, always searches the NEAREST such day from today, whatever `date`
 * says — the weekday arithmetic is the model's weak spot.
 */
export const DAY_NAME_PROPERTY = {
  type: "string",
  description:
    "discover and scan, optional. The day word the customer wrote, ONLY when they named the day as a bare weekday or as today/tomorrow: «jueves», «el próximo jueves», «este viernes», «hoy», «mañana», «pasado mañana». The server then searches the NEAREST such day from today and that wins over date/date_from. Do NOT send it when the customer gave a day number («el jueves 22») or another week («el jueves de la semana que viene», «el otro jueves»): then send only the date.",
} as const;

/**
 * 2026-10-10 (v3) — the day PIECES the customer said. The middleware computes
 * the date from them (it wins over date/date_from and day_name); the model
 * never does the arithmetic. `fecha_dicha` (the literal words) only
 * cross-checks. Same contract as the voice agent (TOOL_SCHEMAS_BALANCED_V5.json).
 */
export const DAY_PIECE_PROPERTIES = {
  dia_semana: {
    type: "string",
    enum: ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"],
    description: "discover/scan: día de la semana que escribió el cliente («el jueves» = jueves). Si no dijo ninguno, no lo mandes. Nunca lo calcules tú.",
  },
  dia_mes: {
    type: "integer",
    minimum: 1,
    maximum: 31,
    description: "Número del día del mes que escribió el cliente (el 16 de «jueves 16»). NUNCA una hora: «a las 5», «5 de la tarde» no van aquí.",
  },
  mes: {
    type: "integer",
    minimum: 1,
    maximum: 12,
    description: "Mes que escribió el cliente, 1-12 («de noviembre» = 11). Solo junto a dia_mes; si no dijo mes, no lo mandes.",
  },
  relativo: {
    type: "string",
    enum: ["hoy", "mañana", "pasado_mañana"],
    description: "Solo si dijo «hoy», «mañana» o «pasado mañana» como día (no «por la mañana»).",
  },
  proximo: {
    type: "boolean",
    description: "true solo si dijo «próximo» o «que viene» junto al día de la semana («el próximo jueves»). Si no, no lo mandes.",
  },
  en_dias: {
    type: "integer",
    minimum: 1,
    maximum: 60,
    description: "Si dijo «en N días» o «dentro de N días»: N. «Dentro de una semana» = 7. No lo sumes tú a ninguna fecha.",
  },
} as const;

export const FECHA_DICHA_PROPERTY = {
  type: "string",
  description:
    "discover/scan: lo que escribió del día, literal («jueves 16», «el martes»). Solo para comprobar: el día lo fijan las otras piezas. outcome date_conflict: copy the message (a question) and wait; with segundo_intento true, do not copy it: SI ALGO NO CUADRA.",
} as const;

/**
 * 2026-10-09 (escaneo, hallazgo 1) — the hour the customer said «sí» to. The
 * middleware refuses the create (`slot_time_mismatch`, nothing written) when
 * the locked slot holds another hour: a failed second lock keeps the first.
 */
export const BOOK_OPTION_PROPERTIES = {
  option_time: {
    type: "string",
    description:
      "HH:mm (24 h) of the hour you wrote in the summary the customer said «sí» to. Always send it. If the locked slot holds another hour, nothing is created (outcome slot_time_mismatch).",
  },
  option_date: {
    type: "string",
    description: "YYYY-MM-DD of the day you wrote in that summary.",
  },
} as const;

function widenForWhatsApp(name: string, parameters: Record<string, unknown>): Record<string, unknown> {
  if (name === TOOL_BOOK) {
    const props = parameters.properties as Record<string, unknown> | undefined;
    if (props) {
      props.option_time = { ...BOOK_OPTION_PROPERTIES.option_time };
      props.option_date = { ...BOOK_OPTION_PROPERTIES.option_date };
    }
    return parameters;
  }
  if (name !== TOOL_AVAILABILITY) return parameters;
  const props = parameters.properties as Record<string, Record<string, unknown>> | undefined;
  if (props) props.day_name = { ...DAY_NAME_PROPERTY };
  if (props) {
    for (const [key, spec] of Object.entries(DAY_PIECE_PROPERTIES)) props[key] = { ...spec };
    props.fecha_dicha = { ...FECHA_DICHA_PROPERTY };
  }
  const idx = props?.option_index;
  if (props && idx) {
    props.option_index = {
      type: "integer",
      minimum: 1,
      maximum: MAX_ROWS,
      description:
        "lock only. The option_index of the hour the customer chose, from the options of the MOST RECENT discover/scan/more answer (1..N, up to 10 on WhatsApp). Never invent one; an index from an older page selects nothing.",
    };
  }
  return parameters;
}

export function buildToolDefinitions(): ToolDefinition[] {
  const v2 = loadSchemaDoc("TOOL_SCHEMAS_BALANCED_V2.json");
  const wa = loadSchemaDoc("TOOL_SCHEMAS_WHATSAPP_V1.json");
  const all = [...v2.tools, ...wa.tools];
  const wanted = [TOOL_AVAILABILITY, TOOL_BOOK, TOOL_MY_BOOKINGS, TOOL_CANCEL, TOOL_CHANGE_SERVICE, TOOL_NOTIFY_OWNER];
  const defs = wanted.map((name) => {
    const t = all.find((x) => x.name === name);
    if (!t) throw new Error(`tool schema missing: ${name}`);
    return {
      type: "function" as const,
      function: {
        name: t.name,
        description: t.name === TOOL_AVAILABILITY ? `${t.description}${WHATSAPP_PAGE_NOTE}` : t.description,
        // The sender's identity never comes from the model, whatever a schema says.
        parameters: widenForWhatsApp(
          t.name,
          withoutServerFields(t.parameters, ["conversation_id", "phone_number", "caller_id", "caller_phone"])
        ),
      },
    };
  });
  return [...defs, LATE_ARRIVAL_TOOL];
}

/** Vocero's handoff catalogue: anything else would be stored as "modelo" anyway. */
export function voceroHandoffReason(reason: string): "cliente" | "hostilidad" | "modelo" {
  if (reason === "wants_human") return "cliente";
  if (reason === "complaint") return "hostilidad";
  return "modelo";
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Takes the long calendar link out of what the model sees; the brain appends it itself. */
function withoutCalendarUrl(result: Record<string, unknown>, session: ToolSession): Record<string, unknown> {
  const url = result.calendar_url;
  if (result.booked === true && result.outcome === "confirmed" && typeof url === "string" && url.startsWith("https://")) {
    const { calendar_url: _removed, ...rest } = result;
    session.calendarUrls = [...(session.calendarUrls ?? []), url];
    return rest;
  }
  return result;
}

/** Bruno's system does not announce an employee-account deletion: keep what is needed for a note. */
function recordCancellation(result: Record<string, unknown>, session: ToolSession): void {
  if (result.outcome !== "cancelled" || result.owner_notified === true || result.idempotency_status === "replayed") return;
  const r = result.reservation;
  if (!r || typeof r !== "object") return;
  const { day_label, time, professional } = r as Record<string, unknown>;
  if (typeof day_label !== "string" || typeof time !== "string") return;
  session.cancellations = [
    ...(session.cancellations ?? []),
    {
      day_label,
      time,
      professional: typeof professional === "string" && professional ? professional : "el equipo",
      ...(typeof result.notice_minutes === "number" ? { notice_minutes: result.notice_minutes } : {}),
      ...(typeof result.late_notice === "boolean" ? { late_notice: result.late_notice } : {}),
    },
  ];
}

/** Hallazgo 2: every real cancellation of this turn (announced to Bruno or not), for the fixed reply. */
function recordDoneCancellation(result: Record<string, unknown>, session: ToolSession): void {
  if (result.outcome !== "cancelled" || result.idempotency_status === "replayed") return;
  const r = result.reservation;
  const { day_label, time, professional } = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
  session.doneThisTurn = [
    ...(session.doneThisTurn ?? []),
    {
      kind: "cancelled",
      ...(typeof day_label === "string" && day_label ? { day: day_label } : {}),
      ...(typeof time === "string" && time ? { time } : {}),
      ...(typeof professional === "string" && professional ? { professional } : {}),
    },
  ];
}

/** The notice fields are the owner's record: the model never sees them, so it cannot voice them. */
function withoutNoticeFields(result: Record<string, unknown>): Record<string, unknown> {
  const { notice_minutes: _n, late_notice: _l, ...rest } = result;
  return rest;
}

/**
 * Cheap guard: a discover/scan that can only land on a day the salon is closed
 * ALL DAY (Sunday, Monday) is answered here, with no middleware call.
 *
 * 2026-10-11: the "afternoon" branch is gone. Whether a Saturday afternoon (or
 * an hour) is closed depends on `preferred_time` and the agenda, and only the
 * server's `message` may say it; the local shortcut said «por la tarde cerrada»
 * for a 13:30 request.
 */
function closedAnswer(args: Record<string, unknown>, week: OpeningHours | undefined): Record<string, unknown> | null {
  if (!week) return null;
  // With a day word the middleware decides the date (the model's `date` may
  // be a miscomputed weekday): never judge that date closed here.
  if (typeof args.day_name === "string" && args.day_name.trim() !== "") return null;
  if (typeof args.fecha_dicha === "string" && args.fecha_dicha.trim() !== "") return null;
  // 2026-10-10 (v3): with day pieces the middleware decides the date.
  if (Object.keys(DAY_PIECE_PROPERTIES).some((key) => key !== "proximo" && args[key] !== undefined && args[key] !== null)) return null;
  // 2026-10-11: a scan by weekday is judged by the server.
  if (args.weekday !== undefined && args.weekday !== null) return null;
  const build = (date: string): Record<string, unknown> => ({
    outcome: "no_availability",
    available: false,
    options: [],
    message: `Los ${weekdayNamePlural(date)} la peluquería está cerrada. ¿Qué otro día te viene bien?`,
    external_mutation: false,
  });
  if (args.action === "discover") {
    const kind = closedKind(week, args.date);
    return kind === "day" && typeof args.date === "string" ? build(args.date) : null;
  }
  if (args.action === "scan") {
    const from = args.date_from;
    const days = typeof args.days === "number" && Number.isInteger(args.days) ? Math.min(Math.max(args.days, 1), 7) : 7;
    if (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
    let first: Record<string, unknown> | null = null;
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      if (closedKind(week, d) !== "day") return null;
      first ??= build(d);
    }
    return days === 1 ? first : { ...(first as Record<string, unknown>), message: "Esos días la peluquería está cerrada. ¿Qué otras fechas miro?" };
  }
  return null;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  session: ToolSession,
  middleware: MiddlewareApi
): Promise<Record<string, unknown>> {
  switch (name) {
    case TOOL_AVAILABILITY: {
      const local = closedAnswer(args, session.openingHours);
      if (local) {
        session.latestAvailability = { options: [], hasMore: false };
        session.dateConflicts = nextDateConflictCount(session.dateConflicts ?? 0, local);
        return local;
      }
      const answer = await middleware.availability({ ...args, conversation_id: session.middlewareConversationId });
      session.dateConflicts = nextDateConflictCount(session.dateConflicts ?? 0, answer);
      // The message (a question) is left untouched; the model decides with the flag.
      const result =
        answer.outcome === "date_conflict" && session.dateConflicts >= MAX_DATE_ATTEMPTS
          ? { ...answer, [SECOND_ATTEMPT_FIELD]: true }
          : answer;
      const slots = collectOfferedSlots(result);
      if (slots.length > 0) session.offeredSlots = [...(session.offeredSlots ?? []), ...slots];
      if (args.action === "lock") delete session.latestAvailability;
      else session.latestAvailability = collectPage(result);
      const locked = lockedSlotOf(result);
      if (locked) session.knownLocks = { ...(session.knownLocks ?? {}), [locked.token]: locked.info };
      if (typeof result.message === "string" && result.message.trim() && args.action !== "lock") {
        session.lastAvailabilityMessage = result.message.trim();
      }
      return result;
    }

    case TOOL_BOOK: {
      if (!session.bookingEnabled) {
        session.lastBookingOutcome = "write_disabled";
        return { outcome: "write_disabled", booked: false, message: WRITE_DISABLED_MESSAGE };
      }
      const max = session.maxBookingsPerConversation;
      if (max !== undefined && (session.bookingsConfirmed ?? 0) >= max) {
        // Nothing reaches the middleware: the lock stays as it was.
        session.lastBookingOutcome = OUTCOME_CONVERSATION_LIMIT;
        return {
          outcome: OUTCOME_CONVERSATION_LIMIT,
          booked: false,
          external_mutation: false,
          max_bookings_per_conversation: max,
          message: conversationLimitMessage(max),
        };
      }
      const phone = session.spanishPhone ?? str(args.phone, 32);
      const result = await middleware.book({
        ...args,
        phone,
        conversation_id: session.middlewareConversationId,
      });
      session.lastBookingOutcome = typeof result.outcome === "string" ? result.outcome : "unknown";
      if (result.outcome === "confirmed" && result.booked === true && result.idempotency_status !== "replayed") {
        session.bookingsConfirmed = (session.bookingsConfirmed ?? 0) + 1;
        // Hallazgo 2: what was booked comes from the lock of THIS token, never from the model.
        const slot = typeof args.slot_token === "string" ? session.knownLocks?.[args.slot_token] : undefined;
        session.doneThisTurn = [
          ...(session.doneThisTurn ?? []),
          slot
            ? { kind: "booked", day: dayLabelEs(slot.date), time: slot.time, ...(slot.professional ? { professional: slot.professional } : {}) }
            : { kind: "booked", ...(typeof result.message === "string" ? { serverMessage: result.message } : {}) },
        ];
      }
      if (result.outcome === "confirmed" && result.booked === true) {
        // Replays count too: the customer must get the link whenever the booking stands.
        const token = typeof args.slot_token === "string" && args.slot_token ? args.slot_token : undefined;
        const info = token ? session.knownLocks?.[token] : undefined;
        const url = typeof result.calendar_url === "string" && result.calendar_url.startsWith("https://") ? result.calendar_url : undefined;
        session.confirmedBookings = [
          ...(session.confirmedBookings ?? []),
          { ...(token ? { slotToken: token } : {}), ...(info ? { info } : {}), ...(url ? { url } : {}) },
        ];
      }
      return withoutCalendarUrl(result, session);
    }

    case TOOL_MY_BOOKINGS:
    case TOOL_CANCEL: {
      // Without the self-service secret (ADR-032) nothing is wired: the prompt
      // handles `self_service_off` by offering the notice to Bruno.
      if (!session.selfServiceEnabled) return { outcome: "self_service_off", message: SELF_SERVICE_OFF_MESSAGE };
      // Identity is ONLY Meta's wa_id; a foreign number cannot be looked up.
      const caller = session.spanishPhone;
      if (!caller) {
        return { outcome: "identity_unavailable", message: IDENTITY_UNAVAILABLE_MESSAGE, external_mutation: false };
      }
      if (name === TOOL_MY_BOOKINGS) return middleware.myReservations(caller, session.middlewareConversationId);
      // Only the fields the middleware schema allows; any phone/caller the model sends is dropped.
      const reservationRef = str(args.reservation_ref, 200);
      if (!reservationRef) return { outcome: "invalid_request", message: "Falta la referencia de la cita.", external_mutation: false };
      const result = await middleware.cancel(caller, {
        reservation_ref: reservationRef,
        confirmed_by_customer: args.confirmed_by_customer === true,
        conversation_id: session.middlewareConversationId,
      });
      recordCancellation(result, session);
      recordDoneCancellation(result, session);
      return withoutNoticeFields(result);
    }

    case TOOL_CHANGE_SERVICE: {
      // Not wired / no identity: the prompt falls back to the notice to Bruno, as before this tool.
      const unavailable = { outcome: "service_change_unavailable", message: SERVICE_CHANGE_UNAVAILABLE_MESSAGE, external_mutation: false };
      if (!session.selfServiceEnabled || !middleware.changeService) return unavailable;
      const caller = session.spanishPhone;
      if (!caller) {
        return { outcome: "identity_unavailable", message: IDENTITY_UNAVAILABLE_MESSAGE, external_mutation: false };
      }
      const reservationRef = str(args.reservation_ref, 200);
      const serviceId = args.service_id;
      if (!reservationRef || (serviceId !== 0 && serviceId !== 1 && serviceId !== 2)) {
        return { outcome: "invalid_request", message: "Falta la cita o el servicio.", external_mutation: false };
      }
      // Only these fields; any phone/caller the model sends is dropped.
      return middleware.changeService(caller, {
        reservation_ref: reservationRef,
        service_id: serviceId,
        confirmed_by_customer: args.confirmed_by_customer === true,
        conversation_id: session.middlewareConversationId,
      });
    }

    case TOOL_NOTIFY_OWNER: {
      const reason = typeof args.reason === "string" && NOTIFY_REASONS.has(args.reason) ? args.reason : "other";
      const summary = str(args.summary, 500);
      if (!summary) return { outcome: "invalid_request", message: "Falta el resumen del aviso." };
      session.pendingHandoff = {
        reason,
        summary,
        customerName: str(args.customer_name, 80),
        callbackPhone: str(args.callback_phone, 32),
      };
      const customerName = str(args.customer_name, 80);
      const callbackPhone = str(args.callback_phone, 32);
      // The Vocero handoff above stays: it is the net when Telegram is off.
      const message = await sendRecado(
        middleware,
        session,
        {
          kind: RECADO_KIND_BY_REASON[reason] ?? "question",
          summary: summary.slice(0, 300),
          ...(customerName ? { customer_name: customerName } : {}),
          ...(callbackPhone ? { callback_phone: callbackPhone } : {}),
        },
        OWNER_NOTIFIED_MESSAGE
      );
      return { outcome: "owner_notified", message };
    }

    case TOOL_LATE_ARRIVAL: {
      const m = args.minutes_late;
      session.lateArrival = typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= 240 ? { minutes: m } : {};
      const lateSummary = str(args.summary, 300) ?? "Avisa de que llega tarde.";
      const message = await sendRecado(
        middleware,
        session,
        {
          kind: "late",
          summary: lateSummary,
          ...(session.lateArrival.minutes !== undefined ? { minutes_late: session.lateArrival.minutes } : {}),
        },
        LATE_ARRIVAL_MESSAGE
      );
      return { outcome: "late_arrival_recorded", message };
    }

    default:
      return { outcome: "invalid_request", message: "Herramienta desconocida." };
  }
}
