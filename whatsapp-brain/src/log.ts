/**
 * JSON-lines logging. Message texts, names and phone numbers are never
 * logged: only events, ids and outcomes.
 */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const write = (level: string, event: string, fields?: Record<string, unknown>) =>
    sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, ...fields }));
  return {
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
    child: (f) => createLogger({ ...base, ...f }, sink),
  };
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** A short, non-reversible tag for a WhatsApp id, so logs can correlate turns without the number. */
export async function waTag(waId: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(`demo-salon-wa:${waId}`).digest("hex").slice(0, 10);
}
