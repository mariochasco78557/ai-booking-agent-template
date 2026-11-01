/**
 * 2026-10-11 — output guard against schedule excuses the agenda never gave
 * («Los sábados cerramos a las 14:00» for a 9:30 request).
 *
 * The agent never states opening hours or closures on its own: only the
 * `message` of an availability answer does, and it is copied as it is. The one
 * thing it may say without a tool is that Sundays and Mondays are closed.
 */

const CLOSURE_CLAIM = /(cerramos|cerrad[oa]s?|no\s+abrimos|abrimos\s+hasta|cierra[a-z]*\s+a\s+las)/i;
const ONLY_SUNDAY_OR_MONDAY = /\b(domingos?|lunes)\b/i;

/**
 * True when `reply` claims the salon is closed, no tool message of this turn
 * said anything about closing, and the claim is not just about Sunday/Monday.
 */
export function unsupportedClosureClaim(reply: string, toolMessages: readonly string[]): boolean {
  if (!CLOSURE_CLAIM.test(reply)) return false;
  if (toolMessages.some((m) => /cerr/i.test(m))) return false;
  const claims = reply.split(/[.!?\n]+/).filter((s) => CLOSURE_CLAIM.test(s));
  return !claims.every((s) => ONLY_SUNDAY_OR_MONDAY.test(s));
}

export const CLOSURE_RETRY_NOTE =
  "[Nota del sistema: has dicho que la peluquería cierra sin que lo diga la agenda. Repite la respuesta sin hablar del horario: copia el `message` de la última consulta.]";

export const CLOSURE_FALLBACK = "Dime qué día y hora te vendría bien y te miro el hueco ahora.";
