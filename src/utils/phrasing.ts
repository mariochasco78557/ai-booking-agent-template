/**
 * Voice-agent-friendly Spanish (Spain) sentence builders. Short, natural,
 * polite. No technical wording. These are the only customer-facing strings.
 * The ones that name the business come from the texts layer (D-010/D-012).
 */
import { fullPhraseEs, timeLabelFromString } from "./dateFormatterEs.js";
import { t } from "../core/texts/texts.js";

/** Generic fallback we can always fall back to when unsure. */
export const ESCALATION_MESSAGE = t("voz.escalar");

/** Generic internal-error message shown to callers (details stay in logs). */
export const GENERIC_ERROR_MESSAGE =
  "Ahora mismo no puedo comprobarlo. Inténtalo de nuevo en un momento, por favor.";

/** Join time labels naturally: "16:30, 17:00 y 18:00". */
export function joinTimesEs(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}`;
}

/** Availability message from a list of slot start strings. */
export function availabilityMessage(
  starts: string[],
  opts: { hasMore?: boolean } = {},
): string {
  if (starts.length === 0) {
    return "Lo siento, no me queda ningún hueco ese día. ¿Quieres que mire otro día?";
  }
  const day = fullPhraseEsDayOnly(starts[0]!);
  const labels = starts.map((s) => timeLabelFromString(s));
  const times = joinTimesEs(labels);
  const tail = opts.hasMore ? " ¿Alguna de esas te viene bien?" : " ¿Cuál prefieres?";
  return `Tengo hueco el ${day} a las ${times}.${tail}`;
}

/** Message for an exact-slot check. */
export function checkSlotMessage(available: boolean, start: string): string {
  const label = timeLabelFromString(start);
  return available
    ? `Sí, está libre a las ${label}.`
    : `Lo siento, a las ${label} no queda libre. ¿Quieres que mire otra hora?`;
}

/** Booking confirmation message. */
export function bookingConfirmedMessage(reservationDate: string): string {
  return `Perfecto, la reserva queda confirmada para el ${fullPhraseEs(reservationDate)}.`;
}

/** Slot lost (race condition) message. */
export const SLOT_TAKEN_MESSAGE =
  "Vaya, ese hueco ya no está disponible. Te puedo mirar otra hora si quieres.";

/** Booking blocked because writes are disabled. */
export const WRITE_DISABLED_BOOK_MESSAGE = t("voz.reserva.escritura_desactivada");

/** Cancel blocked because writes are disabled. */
export const WRITE_DISABLED_CANCEL_MESSAGE = t("voz.anular.escritura_desactivada");

/**
 * step PROD (Hito 7): what the agent says when the salon's agenda cannot be
 * read at all — a timeout, a refused connection, an upstream 5xx.
 *
 * It is short, it is honest, it promises nothing the middleware cannot keep,
 * and it hands the caller a way forward. The alternative — letting the failure
 * surface to the model as a tool error — invites improvisation about
 * availability nobody has checked, which is the one thing a booking agent must
 * never do.
 */
export const AGENDA_UNAVAILABLE_MESSAGE = t("voz.agenda_no_disponible");

/**
 * step CTL-3: what the agent says when the write to the salon's API neither
 * clearly succeeded nor clearly failed — a timeout, a dropped connection, an
 * upstream 5xx, or a reply we could not read.
 *
 * It is deliberately NOT the generic error message. A generic error invites
 * both the model and the caller to treat "try again" as the obvious next move,
 * and trying again is precisely what must not happen here: the appointment may
 * already exist upstream, and a second write would create a duplicate the
 * customer only discovers at the salon. So the sentence says the appointment
 * is NOT confirmed (true — we cannot assert that it is), promises a human will
 * look at it, and offers no retry.
 */
export const BOOKING_UNCERTAIN_MESSAGE = t("voz.reserva.incierta");

/** Missing explicit confirmation. */
export const NEEDS_CONFIRMATION_MESSAGE =
  "Necesito que me confirmes antes de continuar.";

/**
 * step SLOT: what the agent says when it tried to book a hueco this
 * middleware never offered it — no `slot_token`, a token it made up, a token
 * from another call, or one that no longer verifies.
 *
 * The sentence has ONE job beyond being polite: it must send the agent back
 * to `booking_check_availability`, because that is the only place a valid
 * token can come from. It deliberately does not say "error" and does not
 * apologise for a fault, because from the caller's side nothing has gone
 * wrong yet — the hour simply has to be looked up properly before it can be
 * taken.
 */
export const SLOT_NOT_AUTHORIZED_MESSAGE =
  "Antes de cerrar la cita necesito volver a comprobar ese hueco en la agenda.";

/**
 * step SLOT: the token was genuinely issued for this call, but it is old.
 *
 * Separated from the message above because the caller's experience is
 * different: they have been talking for a while and the hour they were
 * offered may well have gone. Saying so plainly is more honest than implying
 * a technical problem, and it makes the re-check sound like diligence rather
 * than a failure.
 */
export const SLOT_TOKEN_EXPIRED_MESSAGE =
  "Vuelvo a comprobar ese hueco en la agenda para no darte una hora que ya no esté libre.";

/**
 * step SLOT: the customer's name, surnames or phone are empty, trivial or a
 * known placeholder — the `"Cliente" / "Desconocido" / "000000000"` shape the
 * agent produced on 2026-08-30 when it never asked.
 *
 * The sentence asks the CALLER for the data, which is the only way to fix it,
 * and it does not tell the model that a retry with different invented values
 * is available.
 */
export const INVALID_CUSTOMER_DATA_MESSAGE =
  "Para dejar la cita a tu nombre necesito que me digas tu nombre, tus apellidos y un teléfono de contacto.";

/**
 * 2026-10-08 (call conv_1801m4bj7x1nfa4vqx2wn366n9vs) — the phone arrived as
 * digits, but not nine of them. The generic sentence above made the agent
 * re-ask all three fields three times while the caller repeated the same ten
 * digits; this one asks the CALLER for the number again, slowly, and states the
 * rule. It never says how many digits arrived or which one is wrong: the model
 * must not "fix" the number itself (the lesson of 2026-08-30).
 */
export const INVALID_PHONE_LENGTH_MESSAGE =
  "El teléfono que me ha llegado no tiene nueve cifras. ¿Me lo dices otra vez, despacio y de tres en tres?";

/**
 * 2026-10-09 (`VOICE_CALLER_ID_PHONE_ENABLED`) — the agent asked to use the
 * number the customer is calling from, and the call carries none (hidden
 * number, web call) or one that is not a Spanish mobile (a landline cannot
 * receive the WhatsApp confirmation). Asks the CALLER for a mobile; says
 * nothing about the number that arrived.
 */
export const CALLER_PHONE_UNAVAILABLE_MESSAGE =
  "No me sale un móvil en esta llamada. ¿Me dices un móvil de contacto?";

/** Cancellation success (`cancelled`, design §6.2). */
export const CANCEL_CONFIRMED_MESSAGE = "Reserva cancelada correctamente.";

/**
 * step 10C ((internal doc, not included in the template) §6.2):
 * one constant per `CancelOutcome` (`src/types/voiceOutcomes.ts`). The old,
 * single `CANCEL_FAILED_MESSAGE` catch-all is retired — it collapsed every
 * failure into one generic sentence, which is exactly what §6.2 forbids for
 * `confirmation_mismatch` (must invite a retry) vs the fail-closed states
 * (must not).
 */

/** `identity_missing` (design §6.2): no caller identity resolved for this call. */
export const CANCEL_IDENTITY_MISSING_MESSAGE = t("voz.anular.sin_identidad");

/** `identity_unverified` (design §6.2): resolved, but not trusted enough even to READ. */
export const CANCEL_IDENTITY_UNVERIFIED_MESSAGE = t("voz.anular.identidad_no_verificada");

/**
 * `insufficient_trust_for_write` (design §4.1.1 / senior finding B6): the
 * identity is `verified` — enough to READ — but not enough to authorize a
 * WRITE (an attested `provider_header` identity, never `signed_envelope` /
 * `synthetic_test`). Deliberately says nothing about that distinction —
 * caller-facing wording never explains the internal trust model, only that
 * phone cancellation is not possible right now.
 */
export const CANCEL_INSUFFICIENT_TRUST_MESSAGE = t("voz.anular.confianza_insuficiente");

/** `no_candidate` (design §6.2): reserved for a future lookup-then-cancel chain; not reachable today. */
export const CANCEL_NO_CANDIDATE_MESSAGE = t("voz.anular.no_encontrada");

/** `ambiguous` (design §6.2): reserved for a future lookup-then-cancel chain; not reachable today. Never lists any candidate. */
export const CANCEL_AMBIGUOUS_MESSAGE = t("voz.anular.ambigua");

/** `unsupported` (design §5.3/§6.2): `BOOKING_UPSTREAM_MODE !== "ai"`, or upstream's `OWNER_PHONE_UNSUPPORTED` (U-1). */
export const CANCEL_NOT_SUPPORTED_MESSAGE = t("voz.anular.no_soportado");

/** `already_cancelled` (design §6.2/§6.4): idempotent — either upstream's own idempotency branch, or the session-local repeat-cancellation short-circuit. */
export const CANCEL_ALREADY_CANCELLED_MESSAGE = "Esa reserva ya estaba cancelada.";

/**
 * `confirmation_mismatch` (design §6.2): upstream `CONFIRMATION_MISMATCH`.
 * NOT collapsed into `proof_invalid` — under a verified identity this
 * discloses nothing about a stranger, and it is the one failure genuinely
 * worth inviting a retry for (an accent tripping an exact-string name
 * compare), unlike the fail-closed states above.
 */
export const CANCEL_CONFIRMATION_MISMATCH_MESSAGE =
  "Los datos que me has dado no coinciden con los de la reserva. ¿Puedes repetirme tu nombre, por favor?";

/** `rate_limited` (design §6.2): upstream `TOO_MANY_ATTEMPTS`. Transient — invites a later retry. */
export const CANCEL_RATE_LIMITED_MESSAGE =
  "Se han hecho demasiados intentos con esta reserva. Inténtalo de nuevo más tarde, por favor.";

/**
 * `proof_invalid` (design §6.2): the deliberate collapse of upstream
 * `PROOF_INVALID` / `PROOF_EXPIRED` / `PROOF_ALREADY_USED` /
 * `PROOF_SCOPE_MISMATCH` — distinguishing them would make this middleware a
 * proof oracle, and no caller-facing action differs between them. Never
 * mentions a proof, a code, or a reservation reference.
 */
export const CANCEL_PROOF_INVALID_MESSAGE = t("voz.anular.prueba_invalida");

/** `upstream_unavailable` (design §6.2): transport failure, 5xx, a non-envelope response, or any unmapped code. */
export const CANCEL_UPSTREAM_UNAVAILABLE_MESSAGE =
  "Ahora mismo no puedo cancelar la reserva. Inténtalo de nuevo en un momento, por favor.";

/**
 * `human_assistance_required` as a bare `CancelOutcome` (as opposed to the
 * `action` field most fail-closed cancel outcomes also carry): not emitted
 * by `src/services/cancellationService.ts` today, kept for the same
 * forward-compatibility reason as `no_candidate`/`ambiguous` above.
 */
export const CANCEL_HUMAN_ASSISTANCE_MESSAGE = ESCALATION_MESSAGE;

/**
 * Reservation lookup / phone cancellation is not supported in this
 * configuration (e.g. `BOOKING_UPSTREAM_MODE !== "ai"`, or upstream itself
 * reports `LOOKUP_BY_PHONE_UNSUPPORTED`). Honest, non-technical.
 *
 * REWRITTEN (step 10C, closes defect T-1): the previous wording — "Te paso
 * con la peluquería para que lo vean contigo" ("I'm putting you through to
 * the salon") — claimed a transfer that no tool in this system can perform.
 * This uses the SAME honest register `ESCALATION_MESSAGE` already uses
 * elsewhere in this file: recommend calling the salon directly, never claim
 * a hand-off occurred, is occurring, or will occur. See design §9 and
 * src/types/voiceOutcomes.ts (`HumanAssistanceAction`) for the enforcement
 * that makes this more than a style choice.
 */
export const LOOKUP_NOT_SUPPORTED_MESSAGE = t("voz.consulta.no_soportada");

/**
 * `identity_missing` / `identity_unverified` (design §5.2): no caller
 * identity was resolved for this call, or the one resolved does not meet
 * the bar lookup requires (`trustLevel === "verified"`). Deliberately does
 * NOT explain WHY in caller-facing terms (that is exactly the kind of
 * internal detail `GENERIC_ERROR_MESSAGE` also withholds) — the reason is
 * logged, never spoken. Two distinct constants because they are logically
 * different situations for anyone reading the code later, even though the
 * caller hears functionally the same apology either way.
 */
export const LOOKUP_IDENTITY_MISSING_MESSAGE = t("voz.consulta.sin_identidad");

export const LOOKUP_IDENTITY_UNVERIFIED_MESSAGE = t("voz.consulta.identidad_no_verificada");

/**
 * `caller_id_rejected` (design §5.2): upstream refused the caller-id header
 * the MIDDLEWARE ITSELF sent — this always means the middleware has a bug,
 * never that the caller did anything wrong. Never spoken as "no tienes
 * ninguna reserva" (that would be the exact false-negative this whole
 * mission exists to prevent) and never mentions the technical cause; the
 * cause is logged at ERROR by the caller (src/services/lookupService.ts).
 */
export const LOOKUP_CALLER_ID_REJECTED_MESSAGE = t("voz.consulta.llamante_rechazado");

/**
 * `no_match` (design §5.2 / §5.3): the ONLY state honestly speakable as "no
 * booking" — upstream actually ran the query. MUST say "ninguna reserva
 * **próxima**", not "ninguna reserva": upstream only queries
 * `r.reservationDate > :now`, so a booking earlier today would make the
 * unqualified sentence false.
 */
export const LOOKUP_NO_MATCH_MESSAGE =
  "No encuentro ninguna reserva próxima con este número.";

/**
 * `one_match` (design §5.2): the only outcome that carries data. Bounded to
 * exactly the three fields `LookupCandidate` permits — no phone, name, email
 * or numeric id ever reaches this builder in the first place.
 */
export function lookupOneMatchMessage(candidate: {
  dateLabel: string;
  employeeName: string;
}): string {
  return `Tienes una reserva el ${fullPhraseEs(candidate.dateLabel)} con ${candidate.employeeName.trim()}.`;
}

/**
 * `ambiguous` (design §5.1/§5.2): several candidates matched. NEVER lists
 * any of them (that would leak another appointment's date/employee to
 * whoever is on the line) and never says "no tienes reservas" — the caller
 * genuinely has bookings, they just cannot be disambiguated over the phone
 * today.
 */
export const LOOKUP_AMBIGUOUS_MESSAGE = t("voz.consulta.ambigua");

/** `rate_limited` (design §5.2, upstream `TOO_MANY_ATTEMPTS`). Transient — invites a later retry, not a human hand-off. */
export const LOOKUP_RATE_LIMITED_MESSAGE =
  "Se han hecho demasiados intentos de consulta con este número. Inténtalo de nuevo más tarde, por favor.";

/**
 * `upstream_unavailable` (design §5.2): transport failure, 5xx, a
 * non-envelope response, or any code this middleware does not recognise
 * (the exhaustive switch's `default:` arm — design §5.1). Transient by
 * framing, matching `GENERIC_ERROR_MESSAGE`'s register elsewhere in this
 * file.
 */
export const LOOKUP_UPSTREAM_UNAVAILABLE_MESSAGE =
  "Ahora mismo no puedo consultar las reservas. Inténtalo de nuevo en un momento, por favor.";

/** Day-only phrase from a full datetime, e.g. "miércoles 29 de julio". */
function fullPhraseEsDayOnly(value: string): string {
  // fullPhraseEs on a date-only string yields the day phrase; strip time.
  const full = fullPhraseEs(value);
  const idx = full.indexOf(" a las ");
  return idx >= 0 ? full.slice(0, idx) : full;
}
