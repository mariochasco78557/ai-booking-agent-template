/**
 * One customer turn: everything the customer wrote since the brain last
 * answered, answered once.
 *
 *   context (Vocero) → history → model ⇄ tools (middleware) → reply (Vocero)
 *   → handoff, if the model left a notice for Bruno
 *
 * Rules this file enforces regardless of what the model does:
 *  - Nothing is sent when a human has taken the conversation or the 24 h
 *    window is closed.
 *  - A handoff happens AFTER the farewell is sent: once Vocero pauses the AI,
 *    no message can go out any more.
 *  - If the model or the tools fail, the customer gets one honest sentence and
 *    the conversation goes to a human — never silence, never a made-up answer.
 */
import type { InboundMessage } from "./meta.js";
import type { LlmApi, ChatMessage } from "./llm.js";
import type { MiddlewareApi } from "./middleware.js";
import type { SendResult, VoceroApi } from "./vocero.js";
import type { Session, SessionStore } from "./store.js";
import { middlewareConversationId } from "./store.js";
import {
  NOTE_RETRY_BOOK,
  claimsBooking,
  classifyConfirmation,
  confirmationNote,
  CHANGE_ASK,
  NOT_BOOKED_LINE,
  isFarewell,
  isRejection,
  mentionsTime,
  pendingConfirmation,
  reaskText,
  statesNotBooked,
} from "./confirmation.js";
import { CLOSURE_FALLBACK, CLOSURE_RETRY_NOTE, unsupportedClosureClaim } from "./guards.js";
import { buildDynamicPrompt } from "./prompt.js";
import { spanishPhoneFromWaId } from "./phone.js";
import {
  dayLabelEs,
  executeTool,
  lockedSlotOf,
  nextDateConflictCount,
  TOOL_AVAILABILITY,
  TOOL_CANCEL,
  TOOL_CHANGE_SERVICE,
  TOOL_LATE_ARRIVAL,
  TOOL_MY_BOOKINGS,
  TOOL_NOTIFY_OWNER,
  voceroHandoffReason,
  type ConfirmedBooking,
  type DoneAction,
  type LockedSlotInfo,
  type ToolDefinition,
  type ToolSession,
} from "./tools.js";
import type { Logger } from "./log.js";
import type { OpeningHours } from "./hours.js";
import { buildConfirmButtons, buildInteractive, buildPageList, withListTapHint, type InteractiveMessage } from "./interactive.js";

export interface TurnDeps {
  vocero: VoceroApi;
  middleware: MiddlewareApi;
  llm: LlmApi;
  store: SessionStore;
  tools: ToolDefinition[];
  staticSystem: ChatMessage;
  bookingEnabled: boolean;
  /** WA_SELF_SERVICE_SECRET configured; defaults to false (stub `self_service_off`). */
  selfServiceEnabled?: boolean;
  /** Weekly schedule for the local closed-day guard on availability calls. */
  openingHours?: OpeningHours;
  /** BRAIN_INTERACTIVE=on: offered hours also go out as buttons / list. */
  interactive?: boolean;
  maxToolRounds: number;
  /** 2026-10-09 — confirmed bookings per WhatsApp conversation. Default 3. */
  maxBookingsPerConversation?: number;
  log: Logger;
  now?: () => number;
  /** Wait between context retries; 0 in tests. Also caps the waits of the calendar and send retries. */
  retryDelayMs?: number;
  /**
   * 2026-10-11 — a calendar link that could not be produced is retried after
   * this many ms (production: 5 min). Absent or 0 = no timer (tests); the next
   * customer turn retries it anyway.
   */
  calendarRetryMs?: number;
}

/** 2026-10-09 — up to three bookings (for several people) per WhatsApp conversation. */
export const DEFAULT_MAX_BOOKINGS_PER_CONVERSATION = 3;

export const FALLBACK_REPLY =
  "Perdona, ahora mismo no puedo atenderte bien por aquí. Se lo paso a la peluquería y te contestan por aquí.";

const PLACEHOLDER_BY_TYPE: Record<string, string> = {
  audio: "[nota de voz]",
  voice: "[nota de voz]",
  image: "[imagen]",
  video: "[vídeo]",
  sticker: "[pegatina]",
  document: "[documento]",
  location: "[ubicación]",
  contacts: "[contacto]",
};

export function customerText(messages: InboundMessage[]): string {
  return messages
    .map((m) => (m.text && m.text.trim() ? m.text.trim() : PLACEHOLDER_BY_TYPE[m.type] ?? `[${m.type}]`))
    .join("\n");
}

/** The model's way of saying "send nothing" (BOOKING_RULES_ES.md, closing messages). */
const SILENCE = /^\s*<\s*silencio\s*>\s*\.?\s*$/i;

/** WhatsApp shows plain text: drop markdown emphasis the model may add anyway. */
export function cleanReply(text: string | null): string {
  if (!text || SILENCE.test(text)) return "";
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").trim().slice(0, 4000);
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function contextWithRetry(deps: TurnDeps, waId: string) {
  for (let i = 0; i < 4; i++) {
    const ctx = await deps.vocero.getContext(waId);
    if (ctx) return ctx;
    await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 700));
  }
  return null;
}

/** One line per link; a link the reply already contains is not repeated. */
export function withCalendarLinks(reply: string, urls: string[] | undefined): string {
  const lines = [...new Set(urls ?? [])]
    .filter((u) => !reply.includes(u))
    .map((u) => `Para añadir la cita a tu calendario: ${u}`);
  if (lines.length === 0) return reply;
  return reply ? `${reply}\n\n${lines.join("\n")}` : lines.join("\n");
}

// ── 2026-10-11 · the calendar link is mandatory after every confirmed booking ──

export const CALENDAR_LATER_LINE = "El enlace para tu calendario te llega en un momento.";

interface CalendarEntry {
  url: string;
  info?: LockedSlotInfo;
}

interface CalendarResult {
  entries: CalendarEntry[];
  /** Confirmed bookings whose link could not be produced (even after retries). */
  missing: ConfirmedBooking[];
}

/** «el sábado 17 de octubre» + «09:30» -> «del sábado 17 de octubre a las 09:30». */
function ofSlot(info: LockedSlotInfo): string {
  const day = dayLabelEs(info.date);
  return `${day.startsWith("el ") ? `del ${day.slice(3)}` : `de ${day}`} a las ${info.time}`;
}

/**
 * One line per link (a link the reply already holds is not repeated). With
 * more than one booking in the turn each line says which appointment it is for.
 */
export function withCalendarEntries(reply: string, calendar: CalendarResult): string {
  const seen = new Set<string>();
  const labelled = calendar.entries.length > 1;
  const lines: string[] = [];
  for (const e of calendar.entries) {
    if (seen.has(e.url) || reply.includes(e.url)) continue;
    seen.add(e.url);
    lines.push(
      labelled && e.info ? `Para añadir la cita ${ofSlot(e.info)} a tu calendario: ${e.url}` : `Para añadir la cita a tu calendario: ${e.url}`
    );
  }
  if (calendar.missing.length > 0) lines.push(CALENDAR_LATER_LINE);
  if (lines.length === 0) return reply;
  return reply ? `${reply}\n\n${lines.join("\n")}` : lines.join("\n");
}

function sleepMs(deps: TurnDeps, ms: number): Promise<void> {
  const wait = deps.retryDelayMs === undefined ? ms : Math.min(ms, deps.retryDelayMs);
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

/** The link of a booked slot_token from POST /ai/wa/calendar-link, or undefined. Never throws. */
async function fetchCalendarUrl(
  deps: TurnDeps,
  spanishPhone: string | null,
  conversationId: string,
  slotToken: string,
  waitsMs: number[]
): Promise<string | undefined> {
  const call = deps.middleware.calendarLink?.bind(deps.middleware);
  if (!call) return undefined;
  for (let i = 0; i < waitsMs.length; i++) {
    await sleepMs(deps, waitsMs[i] ?? 0);
    try {
      const r = await call(spanishPhone, { conversation_id: conversationId, slot_token: slotToken });
      if (r.outcome === "calendar_url" && typeof r.calendar_url === "string" && r.calendar_url.startsWith("https://")) return r.calendar_url;
    } catch {
      // try again, then give up quietly: the confirmation goes out anyway
    }
  }
  return undefined;
}

async function resolveCalendar(deps: TurnDeps, tool: ToolSession, confirmed: ConfirmedBooking[]): Promise<CalendarResult> {
  const entries: CalendarEntry[] = [];
  const missing: ConfirmedBooking[] = [];
  let recovered = 0;
  for (const b of confirmed) {
    let url = b.url;
    if (!url && b.slotToken) {
      url = await fetchCalendarUrl(deps, tool.spanishPhone, tool.middlewareConversationId, b.slotToken, [0, 1000]);
      if (url) recovered++;
    }
    if (url) entries.push({ url, ...(b.info ? { info: b.info } : {}) });
    else missing.push(b);
  }
  if (recovered > 0) deps.log.info("calendar.recovered", { count: recovered });
  if (missing.length > 0) deps.log.error("calendar.missing", { count: missing.length });
  return { entries, missing };
}

/** What the brain says itself about bookings the middleware confirmed (day, hour, professional from the lock). */
function bookedActions(confirmed: ConfirmedBooking[]): DoneAction[] {
  return confirmed.map((b) =>
    b.info
      ? { kind: "booked", day: dayLabelEs(b.info.date), time: b.info.time, ...(b.info.professional ? { professional: b.info.professional } : {}) }
      : { kind: "booked" }
  );
}

function describeBookings(confirmed: ConfirmedBooking[]): string {
  const parts = confirmed.filter((b) => b.info).map((b) => `${dayLabelEs((b.info as LockedSlotInfo).date)} a las ${(b.info as LockedSlotInfo).time}`);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/**
 * Bruno hears about what the customer did not get: a recado (Telegram) with the
 * slot only. Never throws, never carries a name or a phone.
 */
async function recadoToOwner(deps: TurnDeps, tool: ToolSession, summary: string): Promise<void> {
  try {
    const r = await deps.middleware.recado(tool.spanishPhone, {
      conversation_id: tool.middlewareConversationId,
      kind: "question",
      summary: summary.slice(0, 300),
      ...(tool.voceroConversationId ? { vocero_conversation_id: tool.voceroConversationId } : {}),
    });
    deps.log.info("calendar.recado", { outcome: typeof r.outcome === "string" ? r.outcome : undefined });
  } catch {
    deps.log.warn("calendar.recado", { outcome: "recado_unavailable" });
  }
}

/** Late links being sent / already sent by this process (keyed by middleware conversation id + slot_token). */
const inFlightCalendar = new Set<string>();
const deliveredCalendar = new Set<string>();

/**
 * Sends the links that were missing at booking time, one separate message per
 * link. Returns the slot_tokens that went out.
 */
async function flushPendingCalendar(
  deps: TurnDeps,
  pending: Session["pendingCalendar"],
  spanishPhone: string | null,
  voceroConversationId: string
): Promise<string[]> {
  const sent: string[] = [];
  for (const p of pending ?? []) {
    const key = `${p.middlewareConversationId}:${p.slotToken}`;
    // Already delivered by the timer or another turn (a stale session may still list it).
    if (deliveredCalendar.has(key)) {
      sent.push(p.slotToken);
      continue;
    }
    // Being delivered right now by the timer or a turn: never send it twice.
    if (inFlightCalendar.has(key)) continue;
    inFlightCalendar.add(key);
    try {
      const url = await fetchCalendarUrl(deps, spanishPhone, p.middlewareConversationId, p.slotToken, [0]);
      if (!url) continue;
      const what = p.date && p.time ? ` ${ofSlot({ date: p.date, time: p.time })}` : "";
      const result = await deps.vocero.send(voceroConversationId, `Para añadir la cita${what} a tu calendario: ${url}`);
      if (result === "sent") {
        deliveredCalendar.add(key);
        sent.push(p.slotToken);
      }
    } finally {
      inFlightCalendar.delete(key);
    }
  }
  if (sent.length > 0) deps.log.info("calendar.late_sent", { count: sent.length });
  return sent;
}

function scheduleCalendarRetry(deps: TurnDeps, waId: string, voceroConversationId: string, spanishPhone: string | null, now: () => number): void {
  const ms = deps.calendarRetryMs ?? 0;
  if (ms <= 0) return;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const ctx = await deps.vocero.getContext(waId);
        if (!ctx || !ctx.aiEnabled || !ctx.windowOpen) return;
        const before = deps.store.load(voceroConversationId, now());
        const sent = await flushPendingCalendar(deps, before.pendingCalendar, spanishPhone, voceroConversationId);
        if (sent.length === 0) return;
        // Re-read right before writing: a turn may have saved meanwhile.
        const fresh = deps.store.load(voceroConversationId, now());
        fresh.pendingCalendar = (fresh.pendingCalendar ?? []).filter((p) => !sent.includes(p.slotToken));
        deps.store.save(fresh);
      } catch (err) {
        deps.log.warn("calendar.retry_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, ms);
  timer.unref?.();
}

/**
 * 2026-10-09 («¿cuándo es mi cita?» answered with appointments the customer
 * had cancelled): a «mis citas» answer from an EARLIER message is a snapshot.
 * Bookings are cancelled or made elsewhere (Bruno's panel, a phone call, the
 * app) between messages, so the model must not read it as the current list.
 *
 * Before each new customer message, every earlier `booking_mis_citas` result in
 * the history loses its ready-made `message` and is marked stale. The refs,
 * days and hours stay: a cancellation the customer is confirming from that
 * list still works (the middleware re-checks the booking before deleting).
 * Idempotent.
 */
export const STALE_LOOKUP_NOTE =
  "Consulta de un mensaje anterior: puede estar desfasada (citas anuladas o hechas después por teléfono, en la peluquería o en la app). Para decirle qué citas tiene, vuelve a llamar a booking_mis_citas. Solo para anular la cita que el cliente está eligiendo de esta lista puedes usar su reservation_ref.";

/**
 * 2026-10-10 — same incident one day later: «¿Cuándo era mi cita?» was
 * answered with the result of an OLD cancellation («las dos citas que tenías
 * están anuladas») although a new booking had been made by phone. An earlier
 * `booking_cancelar_cita` result is history too, never the current agenda.
 */
export const STALE_CANCEL_NOTE =
  "Anulación hecha en un mensaje anterior. No dice qué citas tiene ahora (puede haber reservado después por teléfono o en la peluquería): eso solo lo dice booking_mis_citas consultada ahora.";

/** 2026-10-11 — a service change (or its question) of an earlier message is history, never the current agenda. */
export const STALE_CHANGE_SERVICE_NOTE =
  "Cambio de servicio (o su pregunta) de un mensaje anterior. No dice qué citas tiene ahora: eso solo lo dice booking_mis_citas consultada ahora.";

export function markStaleLookups(messages: ChatMessage[]): ChatMessage[] {
  const noteById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) {
        if (c.function.name === TOOL_MY_BOOKINGS) noteById.set(c.id, STALE_LOOKUP_NOTE);
        else if (c.function.name === TOOL_CANCEL) noteById.set(c.id, STALE_CANCEL_NOTE);
        else if (c.function.name === TOOL_CHANGE_SERVICE) noteById.set(c.id, STALE_CHANGE_SERVICE_NOTE);
      }
    }
  }
  if (noteById.size === 0) return messages;
  return messages.map((m) => {
    const note = m.role === "tool" ? noteById.get(m.tool_call_id) : undefined;
    if (m.role !== "tool" || !note) return m;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      return m;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return m;
    const obj = parsed as Record<string, unknown>;
    if (obj.stale === true) return m;
    const { message: _old, fresh_note: _fresh, ...rest } = obj;
    return { ...m, content: JSON.stringify({ ...rest, stale: true, stale_note: note }) };
  });
}

/**
 * 2026-10-10 — what rules is ALWAYS Bruno's agenda for the customer's number
 * (a booking made by phone can be cancelled on WhatsApp hours later). Marking
 * old results stale was not enough: the model answered from its own earlier
 * sentences and never called `booking_mis_citas`. So the brain does not leave
 * it to the model: when the customer's message is about a booking they
 * already have (consult, cancel, change, «¿cuándo era?», «no puedo ir»), the
 * brain reads the agenda ITSELF before the first model call and puts the
 * result in the history as this turn's `booking_mis_citas` call.
 *
 * Deliberately broad: a false positive costs one read-only lookup; a miss
 * repeats the incident (the model can still call the tool on its own).
 */
const EXISTING_BOOKING_PATTERNS: RegExp[] = [
  /\bmis\s+citas?\b/,
  /\bmi\s+(cita|hora|reserva)\b/,
  /\b(la|una|alguna|las)\s+(cita|reserva)s?\s+que\s+(tengo|tenia|tenemos|teniamos|me\s+(diste|disteis|habeis\s+dado|has\s+dado))\b/,
  /\b(tengo|tenia|tenemos|teniamos)\s+(yo\s+)?(alguna\s+|una\s+)?(cita|hora|reserva)s?\b/,
  /\b(anular|anula|anulame|anulamela|anularla|anulad|cancelar|cancela|cancelame|cancelarla|desconvocar|cambiar|cambia|cambiame|cambiarla|mover|moverla|muevela|aplazar|aplazarla|retrasar|adelantar|adelantarla|retrasarla)\b/,
  /\b(no\s+(voy\s+a\s+)?(puedo|poder|podre|podemos|podremos|va\s+a\s+poder|vamos\s+a\s+poder)\s+(ir|acudir|venir|llegar))\b/,
  /\b(cuando|a\s+que\s+hora|que\s+dia|que\s+hora|para\s+cuando|a\s+que\s+dia)\s+(era|es|tengo|tenia|tenemos|teniamos|me\s+toca|me\s+tocaba|quedamos|quedo|reserve|pedi|cogi)\b/,
  /\bque\s+citas?\b/,
  /\b(sigue|sigo|esta|estoy)\s+(en\s+pie|apuntad[oa]|reservad[oa]|confirmad[oa])\b/,
];

export function asksAboutExistingBookings(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:()"«»]/g, " ")
    .replace(/\s+/g, " ");
  return EXISTING_BOOKING_PATTERNS.some((re) => re.test(t));
}

/** Told to the model on the lookup the brain made in this turn. */
export const FRESH_LOOKUP_NOTE =
  "Consulta hecha AHORA en la agenda de Bruno para el número de este cliente. Es la única lista válida: manda sobre cualquier cita, anulación o lista de mensajes anteriores de esta conversación. Contesta con esta.";

/**
 * 2026-10-09 (escaneo, hallazgo 2) — the `locked` slots of earlier turns, by
 * slot_token, so a create in this turn knows what it booked (the «sí» usually
 * comes in a later message than the lock).
 */
export function knownLocksFromHistory(messages: ChatMessage[]): Record<string, LockedSlotInfo> {
  const out: Record<string, LockedSlotInfo> = {};
  for (const m of messages) {
    if (m.role !== "tool") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const locked = lockedSlotOf(parsed as Record<string, unknown>);
    if (locked) out[locked.token] = locked.info;
  }
  return out;
}

/**
 * 2026-10-10 («errores sin agobiar») — the `date_conflict` answers in a row
 * from earlier turns (the customer answers the question in a later message),
 * counted with the same rule as `executeTool`. Only availability results.
 */
export function dateConflictsFromHistory(messages: ChatMessage[]): number {
  const availabilityIds = new Set<string>();
  let count = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) if (c.function.name === TOOL_AVAILABILITY) availabilityIds.add(c.id);
      continue;
    }
    if (m.role !== "tool" || !availabilityIds.has(m.tool_call_id)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    count = nextDateConflictCount(count, parsed as Record<string, unknown>);
  }
  return count;
}

function doneLine(d: DoneAction): string {
  if (d.kind === "booked") {
    if (d.day && d.time) return `Tu cita queda reservada para ${d.day} a las ${d.time}${d.professional ? ` con ${d.professional}` : ""}.`;
    return d.serverMessage ?? "Tu cita queda reservada.";
  }
  const day = d.day ? (d.day.startsWith("el ") ? ` del ${d.day.slice(3)}` : ` de ${d.day}`) : "";
  return `Tu cita${day}${d.time ? ` a las ${d.time}` : ""}${d.professional ? ` con ${d.professional}` : ""} queda anulada.`;
}

/**
 * 2026-10-09 (escaneo, hallazgo 2) — the model failed AFTER a tool booked or
 * cancelled for real: the customer gets a FIXED text with what was done (no
 * model involved), never the generic «no puedo atenderte».
 */
export function doneReply(done: DoneAction[]): string {
  return [...done.map(doneLine), "Si necesitas algo más, escríbenos y la peluquería te contesta por aquí."].join("\n");
}

export type TurnOutcome ="answered" | "silent" | "skipped_human" | "skipped_window" | "no_context" | "fallback";

export async function processTurn(deps: TurnDeps, waId: string, inbound: InboundMessage[]): Promise<TurnOutcome> {
  const now = deps.now ?? Date.now;
  const ctx = await contextWithRetry(deps, waId);
  if (!ctx) {
    deps.log.warn("turn.no_context", {});
    return "no_context";
  }
  if (!ctx.aiEnabled) return "skipped_human";
  if (!ctx.windowOpen) return "skipped_window";

  const session = deps.store.load(ctx.conversationId, now());
  session.messages = markStaleLookups(session.messages);
  // A tap on last turn's hours list arrives as the row title; the hint tells
  // the model which option_index of the current page that is.
  // 2026-10-11: is a booking summary waiting for its «sí»? Decided before this
  // message enters the history, and told to the model as a system note.
  const pendingBefore = pendingConfirmation(session.messages);
  const confirmationClass = pendingBefore ? classifyConfirmation(customerText(inbound)) : undefined;
  const confirmNote = confirmationClass ? confirmationNote(confirmationClass) : null;
  session.messages.push({
    role: "user",
    content: `${withListTapHint(customerText(inbound), session.lastHourList)}${confirmNote ? `\n${confirmNote}` : ""}`,
  });
  delete session.lastHourList;

  const toolSession: ToolSession = {
    middlewareConversationId: middlewareConversationId(session),
    spanishPhone: spanishPhoneFromWaId(waId),
    voceroConversationId: ctx.conversationId,
    bookingEnabled: deps.bookingEnabled,
    bookingsConfirmed: session.bookingsConfirmed ?? 0,
    maxBookingsPerConversation: deps.maxBookingsPerConversation ?? DEFAULT_MAX_BOOKINGS_PER_CONVERSATION,
    selfServiceEnabled: deps.selfServiceEnabled ?? false,
    ...(deps.openingHours ? { openingHours: deps.openingHours } : {}),
    knownLocks: knownLocksFromHistory(session.messages),
    dateConflicts: dateConflictsFromHistory(session.messages),
  };

  await deps.vocero.typing(ctx.conversationId);

  // 2026-10-11: a link that was missing at booking time goes out as soon as it exists.
  if ((session.pendingCalendar?.length ?? 0) > 0) {
    try {
      const sent = await flushPendingCalendar(deps, session.pendingCalendar, toolSession.spanishPhone, ctx.conversationId);
      if (sent.length > 0) session.pendingCalendar = session.pendingCalendar?.filter((p) => !sent.includes(p.slotToken));
    } catch (err) {
      deps.log.warn("turn.calendar_flush_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2026-10-10: a question about an existing booking is answered from the
  // agenda read NOW, never from earlier messages (see asksAboutExistingBookings).
  if (deps.selfServiceEnabled && toolSession.spanishPhone && asksAboutExistingBookings(customerText(inbound))) {
    const id = `srv_mis_citas_${now().toString(36)}_${session.messages.length}`;
    try {
      const output = await executeTool(TOOL_MY_BOOKINGS, {}, toolSession, deps.middleware);
      deps.log.info("tool", {
        tool: TOOL_MY_BOOKINGS,
        action: "server_prefetch",
        outcome: typeof output.outcome === "string" ? output.outcome : undefined,
      });
      session.messages.push(
        { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: TOOL_MY_BOOKINGS, arguments: "{}" } }] },
        { role: "tool", tool_call_id: id, content: JSON.stringify({ ...output, fresh_note: FRESH_LOOKUP_NOTE }) },
      );
    } catch (err) {
      // The model can still call the tool itself; never fail the turn here.
      deps.log.warn("turn.prefetch_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  let reply = "";
  let failed = false;
  try {
    const dynamic: ChatMessage = {
      role: "system",
      content: buildDynamicPrompt({
        waId,
        profileName: inbound.find((m) => m.profileName)?.profileName ?? ctx.contactName,
        now: new Date(now()),
        knowledge: await deps.vocero.knowledge(),
      }),
    };
    /** One run of the model ⇄ tools loop until it writes a reply (which goes into the history). */
    const runModel = async (): Promise<string> => {
      let rounds = 0;
      for (;;) {
        const result = await deps.llm.chat([deps.staticSystem, dynamic, ...session.messages], deps.tools);
        if (result.toolCalls.length === 0) {
          const text = cleanReply(result.content);
          session.messages.push({ role: "assistant", content: text });
          return text;
        }
        if (++rounds > deps.maxToolRounds) throw new Error("too many tool rounds");
        session.messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
        for (const call of result.toolCalls) {
          const args = parseArgs(call.function.arguments);
          const output = await executeTool(call.function.name, args, toolSession, deps.middleware);
          deps.log.info("tool", {
            tool: call.function.name,
            action: typeof args.action === "string" ? args.action : undefined,
            outcome: typeof output.outcome === "string" ? output.outcome : undefined,
            ...(call.function.name === TOOL_NOTIFY_OWNER || call.function.name === TOOL_LATE_ARRIVAL
              ? { recado_outcome: toolSession.lastRecadoOutcome }
              : {}),
          });
          if (typeof output.message === "string") toolSession.turnMessages = [...(toolSession.turnMessages ?? []), output.message];
          session.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
        }
      }
    };
    /** Takes the model's last reply out of the history (it is about to be replaced). */
    const dropLastReply = () => {
      const last = session.messages.at(-1);
      if (last?.role === "assistant" && !last.tool_calls) session.messages.pop();
    };
    const replaceLastReply = (text: string) => {
      dropLastReply();
      session.messages.push({ role: "assistant", content: text });
    };
    const bookedNow = () => (toolSession.confirmedBookings?.length ?? 0) > 0;

    reply = await runModel();

    // Guard 1 (2026-10-11): the agent never states closures the agenda did not state.
    if (unsupportedClosureClaim(reply, toolSession.turnMessages ?? [])) {
      dropLastReply();
      session.messages.push({ role: "user", content: CLOSURE_RETRY_NOTE });
      reply = await runModel();
      let action = "retry";
      if (unsupportedClosureClaim(reply, toolSession.turnMessages ?? [])) {
        reply = toolSession.lastAvailabilityMessage ?? CLOSURE_FALLBACK;
        replaceLastReply(reply);
        action = "replaced";
      }
      deps.log.warn("guard.closure_claim", { action });
    }

    // Guard 2 (2026-10-11): with a summary waiting for its «sí» the brain NEVER
    // stays silent and never says goodbye or «listo» without a confirmed booking.
    if (pendingBefore && confirmationClass) {
      const attempted = () => toolSession.lastBookingOutcome !== undefined;
      if (confirmationClass === "yes" && !bookedNow() && !attempted()) {
        dropLastReply();
        session.messages.push({ role: "user", content: NOTE_RETRY_BOOK });
        reply = await runModel();
      }
      let action: "booked" | "reask" | "model" = "model";
      const rejected = isRejection(customerText(inbound));
      if (bookedNow()) {
        action = "booked";
      } else if (reply === "" && confirmationClass === "no_or_change") {
        // Never re-ask the old hour to someone who is changing or declining it.
        reply = CHANGE_ASK;
        replaceLastReply(reply);
        action = "reask";
      } else if (rejected && reply !== "" && !claimsBooking(reply)) {
        // The customer declined the summary: a goodbye is respected, and says it is not booked.
        if (!statesNotBooked(reply)) {
          reply = `${NOT_BOOKED_LINE} ${reply}`;
          replaceLastReply(reply);
        }
      } else if (
        reply === "" ||
        claimsBooking(reply) ||
        (isFarewell(reply) && !statesNotBooked(reply)) ||
        (confirmationClass === "yes" && !attempted() && !toolSession.pendingHandoff)
      ) {
        reply = reaskText(pendingBefore);
        replaceLastReply(reply);
        action = "reask";
      }
      deps.log.info("confirmation", { pending: true, class: confirmationClass, action });
    }
  } catch (err) {
    failed = true;
    deps.log.error("turn.failed", { error: err instanceof Error ? err.message : String(err) });
  }

  // 2026-10-11: every confirmed booking gets its calendar link. A link the
  // middleware did not give is asked for (POST /ai/wa/calendar-link); one that
  // still cannot be had never holds back the confirmation.
  const confirmed = toolSession.confirmedBookings ?? [];
  const calendar: CalendarResult = confirmed.length > 0 ? await resolveCalendar(deps, toolSession, confirmed) : { entries: [], missing: [] };
  const hasCalendarLinks = calendar.entries.length > 0 || calendar.missing.length > 0;
  const pendingBookings = calendar.missing.filter((b) => b.slotToken);
  if (pendingBookings.length > 0) {
    session.pendingCalendar = [
      ...(session.pendingCalendar ?? []).filter((p) => !pendingBookings.some((b) => b.slotToken === p.slotToken)),
      ...pendingBookings.map((b) => ({
        slotToken: b.slotToken as string,
        middlewareConversationId: toolSession.middlewareConversationId,
        ...(b.info ? { date: b.info.date, time: b.info.time, ...(b.info.professional ? { professional: b.info.professional } : {}) } : {}),
      })),
    ];
  }

  if (failed) {
    // Hallazgo 2: with a booking or a cancellation already done, say exactly
    // that (fixed text + calendar links); the generic sentence only when
    // nothing changed in the agenda.
    const done = toolSession.doneThisTurn ?? [];
    const sayable = done.length > 0 ? done : bookedActions(confirmed);
    reply = sayable.length > 0 ? withCalendarEntries(doneReply(sayable), calendar) : FALLBACK_REPLY;
    session.messages.push({ role: "assistant", content: reply });
  }
  const doneOnFailure = failed ? (toolSession.doneThisTurn ?? []) : [];

  if (!failed && confirmed.length > 0) {
    // The customer always gets the full confirmation: if the model stayed silent
    // or left out the hour, the brain's fixed text (day, hour, professional) replaces it.
    const incomplete = reply === "" || confirmed.some((b) => b.info && !mentionsTime(reply, b.info.time));
    if (incomplete) {
      reply = doneReply(bookedActions(confirmed));
      const last = session.messages.at(-1);
      if (last?.role === "assistant" && !last.tool_calls) last.content = reply;
      else session.messages.push({ role: "assistant", content: reply });
    }
  }

  // The calendar link is appended by the brain, never typed by the model.
  // Not on the generic fallback (on a failure after a booking it is already in `doneReply`).
  if (!failed) reply = withCalendarEntries(reply, calendar);

  // 2026-10-09: the conversation's count survives the fresh id below.
  if ((toolSession.bookingsConfirmed ?? 0) > 0) session.bookingsConfirmed = toolSession.bookingsConfirmed;

  // The middleware allows one booking per conversation id (a voice-call rule).
  // On WhatsApp the same chat may book again later (another day, another
  // person, or after the shop deleted the first one), so a confirmed booking
  // starts a fresh middleware conversation id for the next turns.
  if (toolSession.lastBookingOutcome === "confirmed") session.startedAt = Math.max(now(), session.startedAt + 1);

  // Tappable hours: never on the fallback, a confirmation or a calendar-link message.
  // A page of 4+ options (latest availability answer) goes out as a list of ALL
  // of them; otherwise the hours the reply mentions, as before.
  let interactive: InteractiveMessage | null = null;
  let fallbackText: string | undefined;
  if (reply && deps.interactive && !failed && !hasCalendarLinks && toolSession.lastBookingOutcome !== "confirmed") {
    // 2026-10-11: a summary waiting for its «sí» goes out with two buttons.
    const confirmButtons = pendingConfirmation(session.messages) ? buildConfirmButtons(reply) : null;
    if (confirmButtons) {
      interactive = confirmButtons;
    } else {
      const page = buildPageList(reply, toolSession.latestAvailability);
      if (page) {
        interactive = page.interactive;
        fallbackText = page.fallbackText;
        session.lastHourList = page.rows;
      } else {
        interactive = buildInteractive(reply, toolSession.offeredSlots ?? []);
      }
    }
  }

  session.lastActivityAt = now();
  deps.store.save(session);
  if (pendingBookings.length > 0) scheduleCalendarRetry(deps, waId, ctx.conversationId, toolSession.spanishPhone, now);

  for (const c of toolSession.cancellations ?? []) {
    // No handoff: the customer is done. A failure here must never fail the turn.
    try {
      await deps.vocero.setFicha(ctx.conversationId, {
        // Internal record only: the notice is never said to the customer.
        ultima_anulacion: `Anulada por WhatsApp: ${c.day_label} a las ${c.time} con ${c.professional}${
          c.notice_minutes !== undefined ? ` (avisó ${c.notice_minutes} min antes)` : ""
        }`,
        ...(c.notice_minutes !== undefined ? { ultima_anulacion_aviso_min: c.notice_minutes } : {}),
        ...(c.late_notice !== undefined ? { ultima_anulacion_tardia: c.late_notice } : {}),
        ultima_anulacion_fecha: new Date(now()).toISOString(),
      });
    } catch (err) {
      deps.log.warn("turn.cancel_note_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (toolSession.lateArrival) {
    // Ficha interna; el aviso a Bruno lo hace el recado (tools.ts).
    try {
      await deps.vocero.setFicha(ctx.conversationId, {
        ultimo_aviso_retraso: new Date(now()).toISOString(),
        ...(toolSession.lateArrival.minutes !== undefined ? { ultimo_aviso_retraso_min: toolSession.lateArrival.minutes } : {}),
      });
    } catch (err) {
      deps.log.warn("turn.late_note_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // A message about a booking that did not reach the customer is retried (1 s,
  // 3 s); if it still does not arrive, Bruno is told (ficha + recado).
  const bookedThisTurn = confirmed.length > 0;
  if (reply) {
    const sendOnce = (): Promise<SendResult> =>
      interactive ? deps.vocero.sendInteractive(ctx.conversationId, interactive, fallbackText) : deps.vocero.send(ctx.conversationId, reply);
    let sent = await sendOnce();
    if (sent === "failed" && bookedThisTurn) {
      for (const wait of [1000, 3000]) {
        await sleepMs(deps, wait);
        sent = await sendOnce();
        if (sent !== "failed") break;
      }
    }
    if (sent !== "sent") {
      deps.log.warn("turn.not_sent", { result: sent });
      if (bookedThisTurn && (sent === "failed" || sent === "ai_paused")) {
        const note = `Cita hecha por WhatsApp${describeBookings(confirmed)}, pero el cliente no ha recibido la confirmación.`;
        try {
          await deps.vocero.setFicha(ctx.conversationId, {
            aviso_para_owner: note,
            aviso_motivo: "error",
            aviso_fecha: new Date(now()).toISOString(),
          });
        } catch (err) {
          deps.log.warn("turn.undelivered_note_failed", { error: err instanceof Error ? err.message : String(err) });
        }
        await recadoToOwner(deps, toolSession, note);
      }
      if (sent === "ai_paused") return "skipped_human";
    }
  }
  if (calendar.missing.length > 0) {
    // The confirmation went out without the link: Bruno can send it by hand if the retries fail too.
    await recadoToOwner(
      deps,
      toolSession,
      `Cita hecha por WhatsApp${describeBookings(calendar.missing)}: no he podido generar el enlace del calendario. El enlace se enviará en el próximo mensaje del cliente.`
    );
  }

  if (failed) {
    if (doneOnFailure.length > 0) {
      // Hallazgo 2: Bruno gets the detail, not just «error». Never fails the turn.
      try {
        await deps.vocero.setFicha(ctx.conversationId, {
          aviso_para_owner: `La IA falló en mitad de la conversación, pero esto quedó hecho y el cliente ya tiene el resumen: ${doneOnFailure
            .map(doneLine)
            .join(" ")} Revisa si pedía algo más.`,
          aviso_motivo: "error",
          aviso_fecha: new Date(now()).toISOString(),
        });
      } catch (err) {
        deps.log.warn("turn.failure_note_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    await deps.vocero.handoff(ctx.conversationId, "error");
    return "fallback";
  }

  const pending = toolSession.pendingHandoff;
  if (pending) {
    await deps.vocero.setFicha(ctx.conversationId, {
      aviso_para_owner: pending.summary,
      aviso_motivo: pending.reason,
      ...(pending.customerName ? { aviso_nombre: pending.customerName } : {}),
      ...(pending.callbackPhone ? { aviso_telefono: pending.callbackPhone } : {}),
      aviso_fecha: new Date(now()).toISOString(),
    });
    await deps.vocero.handoff(ctx.conversationId, voceroHandoffReason(pending.reason));
  }
  if (toolSession.lastBookingOutcome) {
    deps.log.info("booking", { outcome: toolSession.lastBookingOutcome });
  }
  return reply ? "answered" : "silent";
}
