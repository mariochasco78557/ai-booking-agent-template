/**
 * Per-conversation memory on disk (one JSON file per Vocero conversation),
 * so a restart does not make the assistant forget a booking half done.
 *
 * A conversation idle for longer than the session TTL starts over with an
 * empty history and a NEW middleware conversation id: a slot token or a
 * "more" continuation from yesterday must never be reused today.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "./llm.js";
import type { ListedRow } from "./interactive.js";

export interface Session {
  conversationId: string;
  /** epoch ms; part of the middleware conversation id. */
  startedAt: number;
  lastActivityAt: number;
  messages: ChatMessage[];
  /** Rows of the hours list sent in the last turn, to read a tap back (2026-10-08). */
  lastHourList?: ListedRow[];
  /**
   * 2026-10-09 — bookings confirmed in this conversation (replays excluded).
   * Survives the fresh middleware conversation id each booking starts; a new
   * session (idle past the TTL) starts again at 0.
   */
  bookingsConfirmed?: number;
  /**
   * 2026-10-11 — confirmed bookings whose calendar link could not be produced
   * yet. Retried on the next turn and by a timer; sent as a separate message.
   * Holds the slot (day, hour, professional) and the middleware conversation
   * id it was booked under, never a name or a phone.
   */
  pendingCalendar?: PendingCalendar[];
}

export interface PendingCalendar {
  slotToken: string;
  /** The middleware conversation id of the turn that booked it. */
  middlewareConversationId: string;
  date?: string;
  time?: string;
  professional?: string;
}

export interface SessionStore {
  load(conversationId: string, now: number): Session;
  save(session: Session): void;
}

/** History is cut at user-message boundaries so a tool call never loses its result. */
export function trimHistory(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  let start = messages.length - maxMessages;
  while (start < messages.length && messages[start]?.role !== "user") start++;
  return messages.slice(start);
}

export function middlewareConversationId(session: Session): string {
  // [A-Za-z0-9_-]{8,200}, the middleware's CONVERSATION_ID_RE.
  const safe = session.conversationId.replace(/[^A-Za-z0-9_-]/g, "");
  return `wa_${safe}_${session.startedAt.toString(36)}`;
}

export class FileSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(dataDir: string, private readonly ttlMs: number, private readonly maxMessages = 60) {
    this.dir = join(dataDir, "conversations");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(conversationId: string): string {
    return join(this.dir, `${conversationId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }

  load(conversationId: string, now: number): Session {
    try {
      const s = JSON.parse(readFileSync(this.path(conversationId), "utf8")) as Session;
      if (now - s.lastActivityAt <= this.ttlMs) return s;
    } catch {
      // missing or unreadable: start fresh
    }
    return { conversationId, startedAt: now, lastActivityAt: now, messages: [] };
  }

  save(session: Session): void {
    const s = { ...session, messages: trimHistory(session.messages, this.maxMessages) };
    const file = this.path(session.conversationId);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, file);
  }
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly ttlMs = 24 * 3600_000) {}
  load(conversationId: string, now: number): Session {
    const s = this.sessions.get(conversationId);
    if (s && now - s.lastActivityAt <= this.ttlMs) return structuredClone(s);
    return { conversationId, startedAt: now, lastActivityAt: now, messages: [] };
  }
  save(session: Session): void {
    this.sessions.set(session.conversationId, structuredClone(session));
  }
}
