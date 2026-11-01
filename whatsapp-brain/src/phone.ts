/**
 * The customer's phone comes from WhatsApp (Meta's `from` / wa_id), never
 * from the model. A Spanish number becomes the 9-digit phone the booking
 * route expects; anything else returns null and the prompt asks for one.
 */
export function spanishPhoneFromWaId(waId: string): string | null {
  let d = waId.trim().replace(/^whatsapp:/i, "");
  d = d.replace(/^\+/, "").replace(/^00/, "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("34") && /^[6789]/.test(d.slice(2))) return d.slice(2);
  if (d.length === 9 && /^[6789]/.test(d)) return d;
  return null;
}

/** "+34 6xx…" style display of a wa_id, for the prompt only. */
export function displayWaId(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  return digits ? `+${digits}` : waId;
}
