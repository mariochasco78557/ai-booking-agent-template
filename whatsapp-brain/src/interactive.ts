/**
 * Tappable hours (BRAIN_INTERACTIVE=on).
 *
 * The model keeps writing a normal Spanish reply. If that reply mentions hours
 * the availability tools really returned this turn, the brain sends the SAME
 * text as a WhatsApp interactive message (reply buttons or a list) so the
 * customer can tap an hour. A tap comes back as the option's title text
 * (meta.ts), so titles must make sense to the model on their own.
 *
 * Pure functions: nothing here talks to the network.
 */

/** Meta Cloud API `interactive` object, as Vocero's patched `/api/bot/messages` accepts it. */
export type InteractiveMessage =
  | {
      type: "button";
      body: { text: string };
      action: { buttons: { type: "reply"; reply: { id: string; title: string } }[] };
    }
  | {
      type: "list";
      body: { text: string };
      action: { button: string; sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[] };
    };

/** An hour an availability tool offered during this turn. */
export interface OfferedSlot {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`. */
  time: string;
  /** Only when the tool named one (discover/scan never do). */
  professional?: string;
}

export const MAX_BUTTONS = 3;
export const MAX_ROWS = 10;
export const BUTTON_TITLE_MAX = 20;
export const ROW_TITLE_MAX = 24;
export const BUTTON_BODY_MAX = 1024;
export const LIST_BODY_MAX = 4096;
export const LIST_BUTTON_LABEL = "Ver horas";
const ID_MAX = 200;

const WEEKDAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const WEEKDAY_FULL = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export function normalizeTime(raw: string): string | null {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** Records the options of an availability answer (discover / scan / more). */
export function collectOfferedSlots(output: Record<string, unknown>): OfferedSlot[] {
  const options = output.options;
  if (!Array.isArray(options)) return [];
  const out: OfferedSlot[] = [];
  for (const o of options) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const time = typeof r.time === "string" ? normalizeTime(r.time) : null;
    const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
    if (!time || !date) continue;
    const name = r.professional ?? r.employee_name;
    out.push({ date, time, ...(typeof name === "string" && name.trim() ? { professional: name.trim() } : {}) });
  }
  return out;
}

function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function dayLabel(date: string): string {
  return `${WEEKDAY_SHORT[weekdayIndex(date)]} ${Number(date.slice(8, 10))}`;
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const TIME_IN_TEXT = /(?<![\d:.])(\d{1,2})[:.](\d{2})(?![\d])/g;

/**
 * The offered slots the reply mentions, in the order they appear in the text.
 * Match is by HH:MM. If the same time was offered on several days (or with
 * several professionals), the weekday / professional named in the text decides;
 * failing that, the most recently offered one wins.
 */
export function matchMentionedSlots(text: string, offered: readonly OfferedSlot[]): OfferedSlot[] {
  if (offered.length === 0) return [];
  const folded = fold(text);
  const picked: OfferedSlot[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TIME_IN_TEXT)) {
    const time = normalizeTime(`${m[1]}:${m[2]}`);
    if (!time) continue;
    let cands = offered.filter((s) => s.time === time);
    if (cands.length === 0) continue;
    if (new Set(cands.map((s) => s.date)).size > 1) {
      const byDay = cands.filter((s) => folded.includes(WEEKDAY_FULL[weekdayIndex(s.date)]!.normalize("NFD").replace(/[̀-ͯ]/g, "")));
      if (byDay.length > 0) cands = byDay;
    }
    if (new Set(cands.map((s) => s.professional ?? "")).size > 1) {
      const byPro = cands.filter((s) => s.professional && folded.includes(fold(s.professional)));
      if (byPro.length > 0) cands = byPro;
    }
    // Most recently offered date/professional for this time.
    const chosen = cands[cands.length - 1]!;
    const key = `${chosen.date}T${chosen.time}:${chosen.professional ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(chosen);
  }
  return picked;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function slotId(s: OfferedSlot): string {
  const pro = (s.professional ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `slot:${s.date}T${s.time}:${pro}`.slice(0, ID_MAX);
}

function slotTitle(s: OfferedSlot, withDay: boolean, max: number): string {
  const day = withDay ? `${dayLabel(s.date)} · ` : "";
  const full = `${day}${s.time}${s.professional ? ` ${s.professional}` : ""}`;
  if (full.length <= max) return full;
  const short = `${day}${s.time}`;
  return clip(short, max);
}

/**
 * Builds the interactive message for a reply, or null when it should go as
 * plain text. `body` is always the reply exactly as the model wrote it.
 */
export function buildInteractive(text: string, offered: readonly OfferedSlot[]): InteractiveMessage | null {
  const mentioned = matchMentionedSlots(text, offered).slice(0, MAX_ROWS);
  if (mentioned.length === 0) return null;
  const asButtons = mentioned.length <= MAX_BUTTONS;
  if (text.length > (asButtons ? BUTTON_BODY_MAX : LIST_BODY_MAX)) return null;

  const withDay = new Set(mentioned.map((s) => s.date)).size > 1;
  const max = asButtons ? BUTTON_TITLE_MAX : ROW_TITLE_MAX;
  const options: { id: string; title: string }[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const s of mentioned) {
    const id = slotId(s);
    const title = slotTitle(s, withDay, max);
    if (ids.has(id) || titles.has(title)) continue;
    ids.add(id);
    titles.add(title);
    options.push({ id, title });
  }
  if (options.length === 0) return null;
  // Dedup can move a list down to buttons; keep the shape consistent with the count.
  if (options.length <= MAX_BUTTONS) {
    if (text.length > BUTTON_BODY_MAX) return null;
    return {
      type: "button",
      body: { text },
      action: { buttons: options.map((o) => ({ type: "reply" as const, reply: { id: o.id, title: clip(o.title, BUTTON_TITLE_MAX) } })) },
    };
  }
  return { type: "list", body: { text }, action: { button: LIST_BUTTON_LABEL, sections: [{ rows: options }] } };
}

/**
 * 2026-10-11 — the summary's closing question as two reply buttons. The tap
 * comes back as the title, which `classifyConfirmation` reads («Sí, resérvala»
 * is a yes, «Cambiar algo» a change). The body keeps «Responde «sí»» in case a
 * phone does not show the buttons. Null when the text is too long for a body.
 */
export const CONFIRM_YES_TITLE = "Sí, resérvala";
export const CONFIRM_CHANGE_TITLE = "Cambiar algo";

export function buildConfirmButtons(text: string): InteractiveMessage | null {
  if (text.length === 0 || text.length > BUTTON_BODY_MAX) return null;
  return {
    type: "button",
    body: { text },
    action: {
      buttons: [
        { type: "reply", reply: { id: "confirm:yes", title: CONFIRM_YES_TITLE } },
        { type: "reply", reply: { id: "confirm:change", title: CONFIRM_CHANGE_TITLE } },
      ],
    },
  };
}

/** One-line summary for the simulator. */
export function describeInteractive(i: InteractiveMessage): string {
  const titles = i.type === "button" ? i.action.buttons.map((b) => b.reply.title) : i.action.sections.flatMap((s) => s.rows.map((r) => r.title));
  return `${i.type === "button" ? "botones" : `lista «${i.action.button}»`}: ${titles.map((t) => `[${t}]`).join(" ")}`;
}

// ── The whole page as a list (owner request, Bruno, 2026-10-08) ───────────────
//
// On WhatsApp the middleware pages up to ten hours (header `x-ai-channel:
// whatsapp`). When the LATEST availability answer of the turn has four or more
// options, the list is built from ALL of them, in their order — not only from
// the hours the model happened to write — so the customer sees every free hour
// of the half day even when the reply only summarises the range.

/** One option of the latest availability page, as the middleware numbered it. */
export interface PageOption {
  optionIndex: number;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`. */
  time: string;
}

/** The latest availability answer of this turn (discover / scan / more). */
export interface LatestPage {
  options: PageOption[];
  /** The middleware's `has_more`: hours remain beyond this page. */
  hasMore: boolean;
}

/** What one row of the hours list stood for, kept to read the tap back. */
export interface ListedRow {
  title: string;
  /** Absent on the «Más horas» row. */
  optionIndex?: number;
  date?: string;
  time?: string;
  more?: true;
}

export const MORE_ROW_TITLE = "Más horas";
export const MORE_ROW_ID = "more";
/** From this many options on, the page goes out as a list of all of them. */
export const PAGE_LIST_MIN_OPTIONS = MAX_BUTTONS + 1;

/** Reads `options` + `has_more` of an availability answer. */
export function collectPage(output: Record<string, unknown>): LatestPage {
  const options: PageOption[] = [];
  if (Array.isArray(output.options)) {
    for (const o of output.options) {
      if (!o || typeof o !== "object") continue;
      const r = o as Record<string, unknown>;
      const time = typeof r.time === "string" ? normalizeTime(r.time) : null;
      const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
      const index = r.option_index;
      if (!time || !date || typeof index !== "number" || !Number.isInteger(index) || index < 1) continue;
      options.push({ optionIndex: index, date, time });
    }
  }
  return { options, hasMore: output.has_more === true };
}

export interface PageList {
  interactive: InteractiveMessage;
  /** The rows, to recognise a tap on the next turn. */
  rows: ListedRow[];
  /** Plain text if Vocero rejects the list: the reply plus every hour. */
  fallbackText: string;
}

/**
 * The list for a page of 4+ options, or null (fewer options, or a body too
 * long for a list). Rows: "HH:MM", or "Mar 13 · HH:MM" when the page spans
 * several days; a final «Más horas» row when `hasMore` and a row is free.
 * An offered hour is never dropped to make room for «Más horas».
 */
export function buildPageList(text: string, page: LatestPage | undefined): PageList | null {
  if (!page || page.options.length < PAGE_LIST_MIN_OPTIONS) return null;
  if (text.length > LIST_BODY_MAX) return null;
  const withDay = new Set(page.options.map((o) => o.date)).size > 1;
  const rows: ListedRow[] = [];
  const out: { id: string; title: string }[] = [];
  const titles = new Set<string>();
  for (const o of page.options) {
    if (out.length >= MAX_ROWS) break;
    const title = clip(withDay ? `${dayLabel(o.date)} · ${o.time}` : o.time, ROW_TITLE_MAX);
    if (titles.has(title)) continue;
    titles.add(title);
    out.push({ id: `opt:${o.optionIndex}:${o.date}T${o.time}`.slice(0, ID_MAX), title });
    rows.push({ title, optionIndex: o.optionIndex, date: o.date, time: o.time });
  }
  if (out.length < PAGE_LIST_MIN_OPTIONS) return null;
  const hoursLine = `Horas libres: ${out.map((r) => r.title).join(", ")}`;
  if (page.hasMore && out.length < MAX_ROWS) {
    out.push({ id: MORE_ROW_ID, title: MORE_ROW_TITLE });
    rows.push({ title: MORE_ROW_TITLE, more: true });
  }
  return {
    interactive: { type: "list", body: { text }, action: { button: LIST_BUTTON_LABEL, sections: [{ rows: out }] } },
    rows,
    fallbackText: `${text}\n\n${hoursLine}`,
  };
}

/**
 * A tap on a list row comes back as the row's title. When the customer's text
 * is exactly one of the rows sent last turn, the model is told which option
 * it is (or that «Más horas» means action "more"), so "15:30" can never be
 * mapped to the wrong `option_index`. Anything else is returned unchanged.
 */
export function withListTapHint(text: string, rows: readonly ListedRow[] | undefined): string {
  if (!rows || rows.length === 0) return text;
  const said = fold(text.trim()).replace(/\s+/g, " ");
  const row = rows.find((r) => fold(r.title).replace(/\s+/g, " ") === said);
  if (!row) return text;
  if (row.more) {
    return `${text}\n[Ha tocado «${MORE_ROW_TITLE}» en la lista de horas: quiere ver más horas. Llama a booking_availability_balanced_v2 con action "more" (solo conversation_id).]`;
  }
  return `${text}\n[Ha elegido en la lista de horas la opción ${row.optionIndex} de la última página (${row.date} ${row.time}). Para reservarla: lock con option_index ${row.optionIndex}.]`;
}
