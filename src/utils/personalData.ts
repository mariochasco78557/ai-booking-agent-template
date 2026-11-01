/**
 * *** PLACEHOLDER REJECTION — and an honest statement of its limits. ***
 *
 * On 2026-08-30 the voice agent never asked the caller for a name. It invented
 * one: `customer_name: "Cliente"`, `customer_surnames: "Desconocido"`,
 * `phone: "000000000"`. The request was refused, but only because that phone
 * does not have the shape of a Spanish number — a coincidence of format, not a
 * decision about the data. `"Cliente Desconocido"` with a well-formed phone
 * would have sailed through every check the middleware had.
 *
 * This module closes the specific hole: the values a model reaches for when it
 * has to fill a required field it never collected. `"Cliente"`,
 * `"Desconocido"`, `"N/A"`, `"Sin nombre"`, `"XXX"`, a repeated digit.
 *
 * *** WHAT THIS CANNOT DO. ***
 *
 * It can prove a value is a KNOWN placeholder. It cannot prove a value is
 * REAL. A model that fabricates `"Bruno"` / `"Martínez"` / `"612345678"`
 * produces something this function has no grounds to reject and no way to
 * distinguish from a caller who actually said those words — the middleware
 * receives a JSON body, not audio, and has no channel back to the utterance.
 *
 * So the honest statement of the guarantee is narrow, and it is written here
 * rather than in a commit message because it is the kind of thing that gets
 * rounded up over time into "the middleware validates the customer":
 *
 *   the middleware can validate FORMAT and reject KNOWN PLACEHOLDERS;
 *   it cannot, on its own, demonstrate that a plausible name was ever
 *   spoken by the customer.
 *
 * The control that DOES bind an appointment to something the middleware
 * itself produced is the slot token (`src/services/slotAuthorization.ts`):
 * the hour, the barber and the service can no longer be invented at all.
 * Identity remains attested only by the agent, and that is a property of the
 * ElevenLabs conversation design, not of this code. See
 * (internal doc, not included in the template).
 */

/**
 * The Spanish phone contract, in ONE place.
 *
 * Mobile or landline: nine digits starting 6, 7, 8 or 9, optionally prefixed
 * `+34`. `src/schemas/aiSchemas.ts` imports this constant rather than
 * declaring its own copy, so the format `POST /ai/book` enforces in Zod and
 * the format the voice path enforces here cannot drift apart.
 */
export const SPANISH_PHONE_RE = /^(\+34)?[6789]\d{8}$/;

/**
 * Upper bounds on what is even READ from a request body.
 *
 * These are abuse guards, not validation: anything longer is treated as
 * absent rather than rejected, so an oversized value produces the same
 * deterministic refusal as a missing one instead of a stack trace or a 400.
 * Fastify's own `bodyLimit` (32 KB) is the outer bound; these are the inner
 * ones, per field.
 */
export const CUSTOMER_NAME_MAX_LENGTH = 200;
export const CUSTOMER_PHONE_MAX_LENGTH = 40;

/** Why a customer identity was refused before reaching `BookingService`. */
export type IdentityRejection =
  /** Absent, not a string, oversized, or whitespace only. */
  | "missing_name"
  | "missing_surnames"
  | "missing_phone"
  /** Present but one character, no letters, or a single repeated character. */
  | "trivial_name"
  | "trivial_surnames"
  /** A known filler value a model reaches for when it never asked. */
  | "placeholder_name"
  | "placeholder_surnames"
  /** Not a Spanish phone number at all — the `000000000` of 2026-08-30. */
  | "invalid_phone"
  /**
   * 2026-10-08 (call conv_1801m4bj…): digits only, once the harmless prefixes
   * and separators are gone, but not NINE of them — the `6000000021` the agent
   * sent three times. The one rejection whose recovery is a question to the
   * CALLER about one field, so it is the one the voice path names
   * (`VoiceBookingService.identityRejectionResult`).
   */
  | "phone_wrong_length"
  /** Shape-valid but a known sentinel: a repeated or sequential digit run. */
  | "placeholder_phone";

/** A customer identity that survived every check, trimmed and ready to write. */
export interface CustomerIdentity {
  name: string;
  surnames: string;
  phone: string;
}

export type IdentityCheck =
  | { ok: true; identity: CustomerIdentity }
  | { ok: false; rejection: IdentityRejection };

/**
 * Compared after lowercasing, stripping diacritics and collapsing whitespace,
 * so `"DESCONOCIDO"`, `"Desconocido"` and `"  descónocido  "` are one entry.
 *
 * Deliberately a list of FILLERS, not of suspicious words. `"Otro"` is a real
 * surname fragment, `"Mayor"` is a real surname, and a deny-list that starts
 * guessing at implausibility rather than matching known filler text will
 * eventually refuse a real customer at the exact moment they are trying to
 * book — a worse failure than the one being prevented, because it is silent
 * to everyone except the caller.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  "cliente",
  "clienta",
  "cliente desconocido",
  "clientes",
  "desconocido",
  "desconocida",
  "desconocidos",
  "desconocidas",
  "anonimo",
  "anonima",
  "sin nombre",
  "sin apellido",
  "sin apellidos",
  "sin datos",
  "sin dato",
  "no consta",
  "nombre",
  "apellido",
  "apellidos",
  "nombre apellidos",
  "usuario",
  "user",
  "customer",
  "unknown",
  "none",
  "null",
  "undefined",
  "nan",
  // `"N/A"`, `"n.a."` and `"N-A"` all normalize to this.
  "n a",
  "na",
  "nn",
  "test",
  "testing",
  "prueba",
  "pruebas",
  "ejemplo",
  "example",
  "asdf",
  "qwerty",
]);

/**
 * Phone numbers that satisfy `^(\+34)?[6789]\d{8}$` and are still obviously
 * not a customer's. Kept SHORT and literal on purpose: every entry here is a
 * number that can never belong to a real caller, and the moment the list
 * starts including merely improbable numbers it starts hanging up on people.
 */
const PLACEHOLDER_PHONES: ReadonlySet<string> = new Set([
  "000000000",
  "111111111",
  "222222222",
  "333333333",
  "444444444",
  "555555555",
  "666666666",
  "777777777",
  "888888888",
  "999999999",
  "123456789",
  "987654321",
]);

/**
 * Lowercase, strip diacritics, reduce every run of punctuation and whitespace
 * to a single space, trim.
 *
 * Punctuation is folded rather than kept so that `"N/A"`, `"n.a."` and
 * `"N-A"` all reach the deny list as the same `"n a"`. It is deliberately
 * lossy — this value is used ONLY for comparison, never for anything that is
 * stored or sent upstream, where the customer's name is passed through
 * untouched.
 */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Spaces, dots, hyphens and brackets: how a dictated number gets written down. */
const PHONE_SEPARATORS_RE = /[\s.\-()]/g;

/**
 * The national digits of a phone as the agent wrote it, or `undefined` when it
 * is not even made of digits.
 *
 * Harmless spelling is removed BEFORE validating (2026-10-08): separators, and
 * the Spanish prefix in its three spoken forms — `+34`, `0034`, and a bare `34`
 * only when it leaves exactly nine digits (`34` + nine). Any other `+` is a
 * foreign number. What is returned is NOT yet validated: its length and first
 * digit are checked by the caller, so a wrong LENGTH can be told apart from a
 * wrong NUMBER.
 */
export function phoneDigitsOf(phone: string): string | undefined {
  const compact = phone.replace(PHONE_SEPARATORS_RE, "");
  if (!/^\+?\d*$/.test(compact)) return undefined;
  if (compact.startsWith("+")) return compact.startsWith("+34") ? compact.slice(3) : undefined;
  if (compact.startsWith("0034")) return compact.slice(4);
  if (compact.startsWith("34") && compact.length === 11) return compact.slice(2);
  return compact;
}

function isTrivial(normalized: string): boolean {
  if (normalized.length < 2) return true;
  // No letter at all: "---", "123", ".", "??".
  if (!/\p{L}/u.test(normalized)) return true;
  // One character repeated: "aa", "xxx", "....". A real two-letter name has
  // two different letters.
  const withoutSpaces = normalized.replace(/ /g, "");
  if (withoutSpaces.length > 0 && new Set(withoutSpaces).size === 1) return true;
  return false;
}

/**
 * Reads a field that arrived as `unknown` and may be anything at all.
 *
 * Returns `undefined` for a non-string, an oversized string, or one that is
 * empty after trimming. All three collapse to "absent" on purpose: the caller
 * turns absent into ONE deterministic refusal, and a model that sent a number
 * where a name goes must get the same answer as one that sent nothing, not a
 * different error to react to.
 */
export function readTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > maxLength) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The WHOLE customer-identity check for the voice path: presence, type, size,
 * format, triviality and known fillers, in one place.
 *
 * It owns the phone FORMAT too, not just the placeholder list. That moved here
 * from Zod deliberately (audit finding, 2026-08-30): a phone the model
 * mistranscribed is an ordinary, expected failure of a voice agent, and Zod
 * answering 400 turns it into a TOOL ERROR that ElevenLabs retries. Every
 * refusal this function can produce is now an HTTP 200 with a deterministic
 * outcome, decided before the idempotency journal and before any upstream
 * call.
 *
 * Returns the trimmed identity, or the single reason to refuse. The caller
 * NEVER tells the model which reason it was — see
 * `VoiceBookingService.identityRejectionResult()`.
 *
 * Scoped to the VOICE booking path. `POST /ai/book` is a different, non-agent
 * contract with its own callers and keeps its Zod validation: the failure
 * being fixed here is a language model filling a field it never collected,
 * and that failure does not exist on a route no language model calls.
 */
export function readCustomerIdentity(input: {
  name: unknown;
  surnames: unknown;
  phone: unknown;
}): IdentityCheck {
  const name = readTrimmedString(input.name, CUSTOMER_NAME_MAX_LENGTH);
  if (name === undefined) return { ok: false, rejection: "missing_name" };
  const surnames = readTrimmedString(input.surnames, CUSTOMER_NAME_MAX_LENGTH);
  if (surnames === undefined) return { ok: false, rejection: "missing_surnames" };
  const phone = readTrimmedString(input.phone, CUSTOMER_PHONE_MAX_LENGTH);
  if (phone === undefined) return { ok: false, rejection: "missing_phone" };

  const normalizedName = normalize(name);
  const normalizedSurnames = normalize(surnames);

  if (isTrivial(normalizedName)) return { ok: false, rejection: "trivial_name" };
  if (isTrivial(normalizedSurnames)) return { ok: false, rejection: "trivial_surnames" };
  if (PLACEHOLDER_VALUES.has(normalizedName)) {
    return { ok: false, rejection: "placeholder_name" };
  }
  if (PLACEHOLDER_VALUES.has(normalizedSurnames)) {
    return { ok: false, rejection: "placeholder_surnames" };
  }
  // Format BEFORE sentinel: `000000000` fails both, and "that is not a Spanish
  // number" is the more accurate operator signal of the two.
  //
  // 2026-10-08: the prefix and the separators are normalised first, and the
  // phone that leaves this function is the NINE national digits. So
  // `+34 600 000 123`, `0034600000123` and `600-000-123` are one number, written
  // upstream and fingerprinted identically — and a WRONG LENGTH is its own
  // rejection, distinct from a number that is simply not Spanish.
  const digits = phoneDigitsOf(phone);
  if (digits === undefined) return { ok: false, rejection: "invalid_phone" };
  if (digits.length !== 9) return { ok: false, rejection: "phone_wrong_length" };
  const national = digits;
  if (!SPANISH_PHONE_RE.test(national)) return { ok: false, rejection: "invalid_phone" };
  if (PLACEHOLDER_PHONES.has(national)) {
    return { ok: false, rejection: "placeholder_phone" };
  }

  return { ok: true, identity: { name, surnames, phone: national } };
}
