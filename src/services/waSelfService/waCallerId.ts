import { createHash } from "node:crypto";
import { maskPhoneStrict } from "../../utils/mask.js";
import { normalizeSpanishPhone } from "../../utils/phone.js";

/**
 * WhatsApp sender identity (ADR-032, DESIGN §2).
 *
 * The function receives HEADERS ONLY — never a body — so the LLM cannot
 * influence which phone is used. Only `es_phone` may look up or cancel.
 */
export const WA_CALLER_ID_HEADER = "x-ai-wa-caller-id";
export const WA_CALLER_ID_MAX_LENGTH = 256;

export type WaCallerIdFormat =
  | "es_phone"
  | "foreign_phone"
  | "bsuid"
  | "missing"
  | "unrecognized";

export type WaCaller =
  | { ok: true; format: "es_phone"; e164: string; masked: string }
  | { ok: false; format: Exclude<WaCallerIdFormat, "es_phone">; masked: string };

const PHONE_PLUS_RE = /^\+?\d{8,15}$/;
const PHONE_00_RE = /^00\d{8,15}$/;
const BSUID_RE = /^[A-Z]{2}\.[A-Za-z0-9_-]{8,128}$/;
const WHATSAPP_PREFIX_RE = /^whatsapp:/i;

function sha256Hex8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function resolveWaCaller(
  headers: Record<string, string | string[] | undefined>,
): WaCaller {
  const rawHeader = headers[WA_CALLER_ID_HEADER];
  const first = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const trimmed = typeof first === "string" ? first.trim() : "";
  if (trimmed === "") return { ok: false, format: "missing", masked: "" };

  if (trimmed.length > WA_CALLER_ID_MAX_LENGTH) {
    return { ok: false, format: "unrecognized", masked: `(len=${trimmed.length})` };
  }

  const value = trimmed.replace(WHATSAPP_PREFIX_RE, "").trim();

  if (PHONE_PLUS_RE.test(value) || PHONE_00_RE.test(value)) {
    const normalized = normalizeSpanishPhone(value);
    if (normalized.ok) {
      return {
        ok: true,
        format: "es_phone",
        e164: normalized.e164,
        masked: maskPhoneStrict(normalized.e164),
      };
    }
    const digits = (PHONE_00_RE.test(value) ? value.slice(2) : value).replace(/\D/g, "");
    return {
      ok: false,
      format: "foreign_phone",
      masked: `+${digits.slice(0, 2)}•••${digits.slice(-2)}`,
    };
  }

  if (BSUID_RE.test(value)) {
    return {
      ok: false,
      format: "bsuid",
      masked: `${value.slice(0, 2)}.…(len=${value.length},h=${sha256Hex8(value)})`,
    };
  }

  return { ok: false, format: "unrecognized", masked: `(len=${trimmed.length})` };
}
