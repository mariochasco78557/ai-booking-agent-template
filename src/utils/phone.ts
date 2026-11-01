/**
 * Spanish phone number normalization.
 *
 * Evidence-aligned with the legacy `User.phone` validation regex
 * `^(\+34|0034|34)?[6789]\d{8}$`: an optional Spain international prefix
 * (`+34`, `0034`, or `34`) followed by exactly 9 digits, the first of which
 * must be 6, 7, 8, or 9.
 *
 * IMPORTANT: a phone number is NOT assumed to be a globally unique identifier
 * for a person (shared/household phones, reassigned numbers, etc.) — callers
 * must not treat it as one.
 *
 * IMPORTANT: callers MUST use {@link maskPhone} from `./mask.js` when logging
 * a phone number — never log the full `e164`/`national` value.
 */

export type NormalizedPhone =
  | { ok: true; e164: string; national: string; kind: "mobile" | "landline" }
  | { ok: false; reason: string };

/** Matches "ext"/"x" followed by digits, e.g. "ext 12", "x12", used to detect extensions. */
const EXTENSION_RE = /(?:\bext\b|\bx)\s*\d+/i;
/** Any alphabetic character. */
const ALPHA_RE = /[a-z]/i;
/** Characters we strip before parsing: spaces, hyphens, parentheses, dots. */
const STRIP_RE = /[\s\-().]/g;
/** Optional Spain prefix + 9 national digits starting with 6/7/8/9. */
const SPANISH_PHONE_RE = /^(?:\+34|0034|34)?([6789]\d{8})$/;

/**
 * Normalizes a Spanish phone number to E.164 form.
 *
 * @param input Raw phone string as provided by a caller (voice transcript,
 *   form field, etc.). May be null/undefined.
 * @returns A discriminated result: `{ ok: true, e164, national, kind }` on
 *   success, or `{ ok: false, reason }` explaining why it was rejected.
 */
export function normalizeSpanishPhone(
  input: string | null | undefined,
): NormalizedPhone {
  if (input == null) {
    return { ok: false, reason: "empty" };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (EXTENSION_RE.test(trimmed)) {
    return { ok: false, reason: "extension_not_supported" };
  }
  if (ALPHA_RE.test(trimmed)) {
    return { ok: false, reason: "contains_letters" };
  }

  const stripped = trimmed.replace(STRIP_RE, "");

  const match = SPANISH_PHONE_RE.exec(stripped);
  if (!match) {
    return { ok: false, reason: "invalid_format" };
  }

  const national = match[1]!;
  const firstDigit = national[0]!;
  const kind: "mobile" | "landline" =
    firstDigit === "6" || firstDigit === "7" ? "mobile" : "landline";

  return { ok: true, e164: `+34${national}`, national, kind };
}
