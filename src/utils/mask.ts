/**
 * Masking helpers for logs. We never log passwords, JWTs, or full phone
 * numbers / personal data. These helpers keep enough for debugging without
 * leaking PII or secrets.
 */

/** Mask a phone: keep first 3 and last 3 digits, e.g. 612345678 -> 612***678. */
export function maskPhone(phone: string | undefined | null): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 6) return "***";
  return `${digits.slice(0, 3)}***${digits.slice(-3)}`;
}

/**
 * Mask a phone that is being used as a CREDENTIAL (a verified caller
 * identity), not as incidental booking data. `maskPhone()` above keeps six
 * of nine Spanish digits (`612***678`), which is fine for a phone that is
 * merely stored alongside a booking but is a real leak once the phone IS
 * the authentication factor — see
 * (internal doc, not included in the template) §10 (closing
 * defect T-2). This reveals only the last TWO digits, e.g.
 * "+34600000001" -> "+34•••••••01". `maskPhone()` is unchanged and remains
 * correct for its existing, non-credential callers.
 */
export function maskPhoneStrict(phone: string | undefined | null): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 2) return "•".repeat(digits.length);

  // Every value this function actually receives is the `phoneE164` output
  // of normalizeSpanishPhone() (src/utils/phone.ts), which is always
  // "+34" + 9 national digits. The "+34" country-code prefix carries no
  // caller-specific information (it is shared by every Spanish number), so
  // it stays visible verbatim — masking it would waste width without
  // protecting anything — and ONLY the national number is subject to the
  // last-two-digits rule. e.g. "+34612345678" -> "+34•••••••78", matching
  // design §10's literal example.
  if (phone.startsWith("+34") && digits.startsWith("34")) {
    const national = digits.slice(2);
    if (national.length <= 2) return `+34${"•".repeat(national.length)}`;
    const last2 = national.slice(-2);
    const hiddenCount = national.length - 2;
    return `+34${"•".repeat(hiddenCount)}${last2}`;
  }

  // Fallback for anything not in the expected +34 E.164 shape: still
  // reveal only the last two digits of whatever was given.
  const prefix = phone.startsWith("+") ? "+" : "";
  const last2 = digits.slice(-2);
  const hiddenCount = digits.length - 2;
  return `${prefix}${"•".repeat(hiddenCount)}${last2}`;
}

/** Never reveal a token. Only confirms presence and length bucket. */
export function maskToken(token: string | undefined | null): string {
  if (!token) return "<none>";
  return `<jwt:len=${token.length}>`;
}

/** Keep a first name but mask surnames to an initial for logs. */
export function maskName(name?: string, surnames?: string): string {
  const n = (name ?? "").trim();
  const s = (surnames ?? "").trim();
  const initial = s ? `${s[0]}.` : "";
  return [n, initial].filter(Boolean).join(" ");
}
