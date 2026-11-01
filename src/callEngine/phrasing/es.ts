import { SERVICE_LABELS, type ServiceId } from "../domain/types.js";
import { serviceLabel as clientServiceLabel, t } from "../../core/texts/texts.js";
import { dayPhraseEs, parseDateTime } from "../../utils/dateFormatterEs.js";
import type { PhraseKey } from "./keys.js";

/**
 * Spanish phrasebook. `ES` covers every `PhraseKey` — `Record<PhraseKey, ...>`
 * makes that a compile error if a key is ever missing, which is the whole
 * point of separating `keys.ts` (no text) from this file (only text).
 *
 * `params` is intentionally typed as `any` to match the shape requested for
 * this module (`Record<PhraseKey, (params?: any) => string>`); each function
 * below narrows/reads only the fields it needs and tolerates `undefined`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = any;

/**
 * Turns a "YYYY-MM-DD" date into how a person would actually say it
 * ("martes 4 de agosto"). Nobody offers a customer an appointment "el
 * 2026-08-04". Reuses the middleware's existing, tested Spanish date
 * formatter rather than growing a second one here; it falls back to the raw
 * value on anything it cannot parse, and a weekday name like "monday" that
 * comes straight from a synthetic script passes through untouched.
 */
function dayLabel(day: unknown): string {
  if (typeof day !== "string" || day === "") return "";
  const parsed = parseDateTime(day);
  return parsed ? dayPhraseEs(parsed) : day;
}

function serviceLabel(serviceId: ServiceId | null | undefined): string {
  if (serviceId === null || serviceId === undefined) return "el servicio";
  return SERVICE_LABELS[serviceId];
}

/**
 * «barba, corte de pelo, o corte y barba»: the catalogue codes as they are
 * said (`etiquetas.voz` of `cliente.yaml`, or the label in lower case).
 */
function spokenServiceList(): string {
  const words = (Object.keys(SERVICE_LABELS).map(Number) as ServiceId[]).map(
    (id) => clientServiceLabel(id, "voz") ?? SERVICE_LABELS[id].toLowerCase(),
  );
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")}, o ${words[words.length - 1]}`;
}

export const ES: Record<PhraseKey, (params?: AnyParams) => string> = {
  // -------------------------------------------------------------------
  // Functional phrases
  // -------------------------------------------------------------------
  GREETING_DEMO_FRAME: () => t("demo.saludo"),

  ASK_SERVICE: () => t("demo.pide_servicio", { servicios: spokenServiceList() }),

  ASK_SERVICE_CONFIRMATION: (params?: AnyParams) =>
    `¿Confirmas que quieres ${serviceLabel(params?.serviceId)}?`,

  // Honesty rule 4 (see phrasing/keys.ts): these two never name concrete days
  // or hours. The catalogue is static and has no access to the calendar, so any
  // schedule it recited would be a guess about someone else's data — and it was
  // already wrong: it announced "solo abrimos lunes y martes" while the venue
  // profile the console and the demo now run on closes precisely on Mondays.
  // The engine offers real alternatives from the resolver; the words must not
  // compete with it.
  ASK_DATE: () => "¿Qué día te viene bien?",

  ASK_TIME: () => "¿A qué hora te viene bien?",

  ASK_PROFESSIONAL: () => "¿Tienes preferencia de profesional, o te vale cualquiera disponible?",

  // (step 22, B2) El «con quién» sólo aparece cuando el profesional NO es el
  // que pidió quien llama: ese es justamente el caso en el que callarlo hacía
  // que se confirmara una reserva creyendo que era con otra persona. Cuando
  // no hay sustitución, la frase es exactamente la de siempre.
  ASK_BOOKING_CONFIRMATION: (params?: AnyParams) =>
    `Entonces, ${serviceLabel(params?.serviceId)} el ${params?.day ?? ""} a las ${params?.time ?? ""}` +
    (typeof params?.professional === "string" && params.professional !== "" ? ` con ${params.professional}` : "") +
    ". ¿Confirmas la reserva?",

  CLARIFY_ONCE: (params?: AnyParams) =>
    params?.topic === "intent"
      ? "Perdona, no te he entendido bien. ¿Puedes decirme de otra forma qué necesitas?"
      : `No he entendido bien tu respuesta sobre ${params?.topic ?? "eso"}. ¿Puedes repetirlo?`,

  OFFER_ALTERNATIVES: (params?: AnyParams) =>
    Array.isArray(params?.alternatives) && params.alternatives.length > 0
      ? `Ese horario exacto no está libre, pero tengo hueco el ${dayLabel(params.alternatives[0]?.day)} ` +
        `a las ${params.alternatives[0]?.time ?? ""}. ¿Te sirve?`
      : "Ese horario exacto no está libre ahora mismo; puedo mirar otro día u hora dentro de nuestro horario de atención.",

  // (step 22, B2) Esta frase existía desde el primer día y no la emitía
  // NADIE: el motor anunciaba el cambio de profesional con OFFER_ALTERNATIVES,
  // que afirma «ese horario exacto no está libre» — falso justo aquí, donde la
  // hora sí está libre y quien no puede es el profesional que se pidió. La
  // frase aprobada se conserva palabra por palabra; lo único que se añade es
  // el nombre de quien atendería, porque una sustitución sin nombre sigue
  // siendo una sustitución a ciegas.
  OFFER_ANOTHER_PROFESSIONAL: (params?: AnyParams) =>
    typeof params?.professional === "string" && params.professional !== ""
      ? "El profesional solicitado no está disponible en ese horario. " +
        `¿Te vale con ${params.professional}, que sí puede con ese servicio?`
      : "El profesional solicitado no está disponible en ese horario. ¿Te vale con otro profesional capacitado para ese servicio?",

  FAREWELL: () => "Gracias por probar esta demostración local y sintética. Hasta pronto.",

  // -------------------------------------------------------------------
  // Terminal outcome phrases — one per ReasonCode.
  // -------------------------------------------------------------------
  REASON_BOOKING_CONFIRMED: () => "La reserva ficticia queda confirmada en esta demostración local.",

  REASON_AVAILABILITY_PROVIDED: (params?: AnyParams) =>
    Array.isArray(params?.slots) && params.slots.length > 0
      ? `Tengo estos huecos: ${params.slots
          .map((s: { day: string; time: string }) => `${dayLabel(s.day)} a las ${s.time}`)
          .join("; ")}.`
      : "No encuentro disponibilidad ficticia para lo solicitado ahora mismo dentro de nuestro horario de atención.",

  // Honesty rule 1: never claims a transfer was completed, never promises a
  // response time — only states that human help has been REQUESTED.
  REASON_CUSTOMER_REQUESTS_HUMAN: (params?: AnyParams) =>
    params?.liveTransferRequested === true
      ? "He solicitado que una persona se ponga al teléfono. No puedo confirmar que la transferencia se haya completado ni un plazo de respuesta."
      : "He registrado tu solicitud de ayuda humana para que una persona del equipo lo revise. No puedo confirmar un plazo de respuesta.",

  REASON_CANCEL_OR_CHANGE_NOT_ENABLED: () =>
    "En esta demostración no puedo cancelar ni cambiar la cita; hace falta ayuda humana. No se ha modificado nada.",

  REASON_BUSINESS_DATA_NOT_APPROVED: () =>
    "No tengo ese dato confirmado (precio, duración o política); hace falta que lo revise una persona.",

  // Honesty rule 2: never claims the shop is indefinitely full — always
  // frames it as "that particular slot" within a bounded synthetic schedule.
  //
  // step 13 correction (B3(b) in the final report): this phrase used to
  // ASSERT a specific cause ("por estar fuera de nuestro horario sintético
  // de referencia... o por caer en la pausa") even when the real,
  // internally-recorded cause (see `Finding.detail` in precedence.ts and
  // engine.ts's `SLOT_REJECTED` internal event) was that the slot was
  // simply OCCUPIED, or that the requested professional cannot perform the
  // service — neither of which has anything to do with the schedule. That
  // was a false statement to the caller. This wording no longer attributes
  // a cause at all: it only states that the exact slot cannot be offered,
  // and that another day/time can be searched within the reference
  // schedule — true regardless of which of the several real causes applied.
  REASON_SLOT_OUTSIDE_SYNTHETIC_SCHEDULE: () =>
    "Ese horario concreto no lo puedo ofrecer en esta demostración. Puedo mirar otro día u hora dentro de nuestro horario de atención.",

  REASON_SERVICE_NOT_CONFIRMED: () =>
    "No he podido confirmar contigo qué servicio quieres, así que no reservo nada por defecto.",

  REASON_TECHNICAL_FAILURE: () =>
    "No he podido completar la operación por un fallo técnico. No hay ninguna confirmación ni reserva.",

  REASON_INTENT_NOT_UNDERSTOOD: () =>
    "No he conseguido entender qué necesitas en esta demostración. Hace falta que te atienda una persona.",

  // step 13 correction (A3/D2 in the final report): a DISTINCT phrase for
  // "I understood you perfectly, but you never gave the final booking
  // confirmation" — spoken instead of REASON_INTENT_NOT_UNDERSTOOD for that
  // specific case (see phrasing/keys.ts's docblock and engine.ts's
  // `bookingConfirmationNotObtained` flag). Reusing the "I didn't
  // understand" phrase there was false: the intent, service and slot were
  // all understood and confirmed — only the final yes/no was missing.
  REASON_BOOKING_CONFIRMATION_NOT_OBTAINED: () =>
    "Te he entendido bien, pero no llegué a recibir tu confirmación final para la reserva, así que no reservo nada por defecto. Hace falta que te atienda una persona.",

  // Honesty rule 3: a security/privacy boundary never reveals whether a
  // third party's data exists, nor gives any professional-unavailability
  // reason — only the boundary itself.
  REASON_SECURITY_OR_PRIVACY_BOUNDARY: () =>
    "No puedo ayudar a acceder o actuar sobre datos de otra persona en esta demostración.",
};
