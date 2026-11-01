/**
 * Deterministic, lexical intent classifier. NO AI/LLM anywhere in this
 * module — every classification decision is a plain keyword/lexicon match
 * over a normalised (lower-cased, accent-stripped) copy of the utterance.
 * Same input -> same output, forever, on any machine.
 *
 * `Intent` here is intentionally a *richer* 9-value set than the frozen
 * pilot-event schema's 7-value `intent` enum
 * (docs/call_interruption_mvp/pilot-event.schema.json) — this module is
 * internal engine vocabulary, not the frozen v1 pilot contract. `PRICE_OR_
 * POLICY`, `SPECIAL_SERVICE` and `THIRD_PARTY_DATA` are internal
 * distinctions the pilot schema doesn't need (it only needs to know the
 * call ended in `ASK_PRICE`/`OTHER`/etc.); `events/emitter.ts` maps this
 * richer set down onto the pilot schema's `intent` enum before emitting a
 * pilot event, precisely so the frozen v1 schema is never touched by this
 * mission (see events/schema.ts's docblock for the full rationale).
 */
import { getPlaceholders } from "../core/texts/texts.js";
export type Intent =
  | "BOOK"
  | "AVAILABILITY"
  | "CANCEL"
  | "RESCHEDULE"
  | "HUMAN_HELP"
  | "PRICE_OR_POLICY"
  | "SPECIAL_SERVICE"
  | "THIRD_PARTY_DATA"
  | "OTHER";

export interface IntentClassification {
  intent: Intent;
  confident: boolean;
}

function normalize(utterance: string): string {
  return utterance
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (tildes, etc.)
    .toLowerCase()
    .trim();
}

/**
 * Every lexicon below is normalised once, at module load, through the same
 * `normalize()` used on the incoming utterance — so a lexicon entry can be
 * written with its natural Spanish accents (readable source) while still
 * matching correctly against an accent-stripped utterance. Writing an
 * unaccented entry directly also works (normalize() is idempotent on
 * already-unaccented text).
 */
function lexicon(words: readonly string[]): readonly string[] {
  return words.map(normalize);
}

function includesAny(normalized: string, needles: readonly string[]): boolean {
  return needles.some((needle) => normalized.includes(needle));
}

// ---------------------------------------------------------------------
// Lexicons. Ordered by precedence WITHIN classification itself (not to be
// confused with precedence.ts's ReasonCode order, which acts on the
// resulting Finding[] afterwards): HUMAN_HELP and THIRD_PARTY_DATA are
// checked first because they must be detected even when the same utterance
// also mentions cancelling, rescheduling, booking, etc. — see acceptance
// scenario A15 (docs/call_interruption_mvp/acceptance-scenarios.json):
// "quiero cancelar... pero prefiero hablar con una persona" must classify
// as HUMAN_HELP, not CANCEL, precisely so that a later CUSTOMER_REQUESTS_
// HUMAN finding is available to win under precedence.ts's total order.
// ---------------------------------------------------------------------

const THIRD_PARTY_DATA_WORDS = lexicon([
  "otra persona",
  "otro cliente",
  "cita de mi hermano",
  "cita de mi hermana",
  "cita de mi marido",
  "cita de mi mujer",
  "cita de mi pareja",
  "cita de un amigo",
  "datos de otra persona",
  "reserva de otra persona",
  "la cita de él",
  "la cita de ella",
]);

const HUMAN_HELP_WORDS = lexicon([
  "hablar con una persona",
  "hablar con alguien",
  "hablar con un humano",
  "persona real",
  "operador",
  "operadora",
  "agente humano",
  "quiero hablar con",
  "ponme con una persona",
  "pasame con una persona",
  "atención al cliente",
  "necesito ayuda humana",
  "quiero un humano",
]);

const CANCEL_WORDS = lexicon(["cancelar", "cancela", "anular", "anula", "quitar la cita", "borrar la cita"]);

const RESCHEDULE_WORDS = lexicon([
  "cambiar la cita",
  "cambiar de hora",
  "cambiar de día",
  "mover la cita",
  "reprogramar",
  "aplazar",
  "posponer",
]);

const PRICE_OR_POLICY_WORDS = lexicon([
  "precio",
  "cuánto cuesta",
  "cuánto vale",
  "tarifa",
  "tarifas",
  "coste",
  "costo",
  "política de cancelación",
  // The business in third person from `cliente.yaml` (D-012): «la peluquería».
  `política de ${getPlaceholders().negocio}`,
]);

const SPECIAL_SERVICE_WORDS = lexicon([
  "color",
  "colorear",
  "mechas",
  "tinte",
  "teñir",
  "alisado",
  "keratina",
  "permanente",
  "peinado de novia",
  "extensiones",
]);

const AVAILABILITY_WORDS = lexicon([
  "disponibilidad",
  "hay hueco",
  "hay sitio",
  "hay hora",
  "qué horas hay",
  "qué horas tenéis",
  "está libre",
  "consultar horario",
  "consultar disponibilidad",
]);

const BOOK_WORDS = lexicon([
  "reservar",
  "reserva",
  "quiero una cita",
  "pedir cita",
  "pedir hora",
  "coger cita",
  "coger hora",
  "quiero cita",
  "necesito cita",
]);

export function classifyIntent(utterance: string): IntentClassification {
  const normalized = normalize(utterance);

  if (normalized.length === 0) {
    return { intent: "OTHER", confident: false };
  }

  // Highest lexical precedence: privacy boundary and explicit human request
  // must win even when the utterance also names another operation.
  if (includesAny(normalized, THIRD_PARTY_DATA_WORDS)) {
    return { intent: "THIRD_PARTY_DATA", confident: true };
  }
  if (includesAny(normalized, HUMAN_HELP_WORDS)) {
    return { intent: "HUMAN_HELP", confident: true };
  }

  if (includesAny(normalized, CANCEL_WORDS)) {
    return { intent: "CANCEL", confident: true };
  }
  if (includesAny(normalized, RESCHEDULE_WORDS)) {
    return { intent: "RESCHEDULE", confident: true };
  }
  if (includesAny(normalized, SPECIAL_SERVICE_WORDS)) {
    return { intent: "SPECIAL_SERVICE", confident: true };
  }
  if (includesAny(normalized, PRICE_OR_POLICY_WORDS)) {
    return { intent: "PRICE_OR_POLICY", confident: true };
  }
  if (includesAny(normalized, AVAILABILITY_WORDS)) {
    return { intent: "AVAILABILITY", confident: true };
  }
  if (includesAny(normalized, BOOK_WORDS)) {
    return { intent: "BOOK", confident: true };
  }

  return { intent: "OTHER", confident: false };
}
