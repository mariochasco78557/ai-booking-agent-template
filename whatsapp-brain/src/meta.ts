/**
 * Reading a WhatsApp Cloud API webhook body.
 *
 * Only customer messages matter here; delivery/read statuses and every other
 * field are ignored (Vocero already received the whole body through the relay).
 */

export interface InboundMessage {
  waId: string;
  messageId: string;
  /** Meta's epoch seconds. */
  timestamp: number;
  type: string;
  /** The text to answer, or null for content the brain cannot read (audio, image…). */
  text: string | null;
  profileName: string | undefined;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function textOf(m: Obj, type: string): string | null {
  switch (type) {
    case "text":
      return str(obj(m.text)?.body) ?? null;
    case "button":
      return str(obj(m.button)?.text) ?? null;
    case "interactive": {
      const i = obj(m.interactive);
      return str(obj(i?.button_reply)?.title) ?? str(obj(i?.list_reply)?.title) ?? null;
    }
    default:
      return null;
  }
}

/**
 * @param phoneNumberId when set, events addressed to any other number are dropped
 */
export function parseInbound(body: unknown, phoneNumberId?: string): InboundMessage[] {
  const root = obj(body);
  if (!root || root.object !== "whatsapp_business_account") return [];
  const out: InboundMessage[] = [];
  for (const entry of arr(root.entry)) {
    for (const change of arr(obj(entry)?.changes)) {
      const c = obj(change);
      if (!c || c.field !== "messages") continue;
      const value = obj(c.value);
      if (!value) continue;
      const pnid = str(obj(value.metadata)?.phone_number_id);
      if (phoneNumberId && pnid !== phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const ct of arr(value.contacts)) {
        const o = obj(ct);
        const id = str(o?.wa_id);
        const name = str(obj(o?.profile)?.name);
        if (id && name) names.set(id, name);
      }
      for (const msg of arr(value.messages)) {
        const m = obj(msg);
        const from = str(m?.from);
        const id = str(m?.id);
        const type = str(m?.type);
        if (!m || !from || !id || !type) continue;
        const ts = Number(str(m.timestamp) ?? m.timestamp);
        out.push({
          waId: from.replace(/\D/g, ""),
          messageId: id,
          timestamp: Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000),
          type,
          text: textOf(m, type),
          profileName: names.get(from),
        });
      }
    }
  }
  return out;
}
