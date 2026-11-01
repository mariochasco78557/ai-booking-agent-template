import { dayPhraseEs, parseDateTime, timeLabel } from "../../utils/dateFormatterEs.js";
import type { WhatsAppJob } from "./whatsappQueueStore.js";
import { t } from "../../core/texts/texts.js";

/**
 * *** THE FOUR WORDS META PUTS INTO THE MESSAGE. ***
 *
 * The utility template approved in the WhatsApp Manager
 * (`WHATSAPP_TEMPLATE_NAME`, by default `plantilla_whatsapp` of `cliente.yaml`) reads, in
 * Spanish and with NAMED parameters:
 *
 *   «Hola {{nombre}}, tu cita en <negocio> queda confirmada para el
 *    {{fecha}} a las {{hora}} con {{profesional}}. …»
 *
 * Named parameters rather than positional ones because the order of a
 * template's variables is editable in Meta's console by a human who is not
 * this repository: with `{{1}}`..`{{4}}` a reordering in the console would
 * silently swap the hour and the professional in a message a customer reads,
 * and nothing here would fail. With names, a mismatch is a Graph API error
 * (code 132000/132012), the job is marked `failed`, and the appointment — as
 * always — is untouched.
 *
 * ── The hour is a WALL CLOCK, and it is never converted ───────────────────
 *
 * `job.startsAtIso` is the salon's own `"YYYY-MM-DD HH:mm:ss"` with a `T` in
 * the middle: Europe/Madrid local time, no offset, no `Z`. It is formatted
 * here by reading its components literally, exactly as
 * `src/utils/dateFormatterEs.ts` already does for everything the agent says
 * out loud, so the WhatsApp and the sentence spoken on the phone cannot
 * disagree.
 *
 * Round-tripping it through an epoch would be the one way to get this wrong:
 * the October DST fold makes "01:30" genuinely ambiguous, and an hour that is
 * off by one in a written confirmation is the kind of error a customer acts
 * on. `src/services/slotAuthorization.ts` refuses the same conversion for the
 * same reason; this file follows it.
 */

/** What the template says when this process cannot name the professional («el equipo de {marca}», D-010). */
export const WHATSAPP_TEAM_FALLBACK = t("whatsapp.plantilla.equipo");

/** One `{{nombre}}`-style value, in the shape Graph API expects. */
export interface WhatsAppTemplateParameter {
  type: "text";
  parameter_name: string;
  text: string;
}

/**
 * The greeting name: the FIRST word of what the caller gave, capitalized.
 *
 * Only the first word, because the template greets («Hola Carlos») and a
 * spoken "Carlos García Pérez" in the name field — which happens, callers do
 * not respect field boundaries — would otherwise be read back in full. The
 * surnames are deliberately not used at all: they are on the appointment, not
 * in the greeting.
 *
 * An ALL-CAPS token is lowercased before capitalizing, because the transcript
 * sometimes arrives shouted («CARLOS») and «CARLOS» in a written message reads
 * as an error. A mixed-case token is left alone past its first letter, so
 * «McCarthy» and «de la Fuente» survive untouched.
 */
export function greetingName(customerName: string): string {
  const first = customerName.trim().split(/\s+/)[0] ?? "";
  if (first === "") return "";
  const body = first.length > 1 && first === first.toUpperCase() ? first.toLowerCase() : first;
  return body.charAt(0).toUpperCase() + body.slice(1);
}

/** «jueves 25 de septiembre» from a wall-clock string, or the raw value. */
export function spelledDateEs(startsAtIso: string): string {
  const parsed = parseDateTime(startsAtIso);
  return parsed === null ? startsAtIso : dayPhraseEs(parsed);
}

/** «10:30» from a wall-clock string, or the raw value. */
export function spelledTimeEs(startsAtIso: string): string {
  const parsed = parseDateTime(startsAtIso);
  return parsed === null || !parsed.hasTime ? startsAtIso : timeLabel(parsed);
}

/**
 * The template's body parameters for one confirmation job.
 *
 * `profesional` falls back to {@link WHATSAPP_TEAM_FALLBACK} rather than being
 * omitted: Graph API rejects a template call whose parameter count does not
 * match the approved template, so «con el equipo de <marca>» is what the
 * message says when the barber could not be named. A true sentence, and one
 * that never costs the customer their confirmation.
 */
export function buildConfirmationParameters(
  job: Pick<WhatsAppJob, "customerName" | "professionalName" | "startsAtIso">,
): WhatsAppTemplateParameter[] {
  const professional = job.professionalName?.trim();
  return [
    { type: "text", parameter_name: "nombre", text: greetingName(job.customerName) },
    { type: "text", parameter_name: "fecha", text: spelledDateEs(job.startsAtIso) },
    { type: "text", parameter_name: "hora", text: spelledTimeEs(job.startsAtIso) },
    {
      type: "text",
      parameter_name: "profesional",
      text: professional === undefined || professional === "" ? WHATSAPP_TEAM_FALLBACK : professional,
    },
  ];
}

/**
 * *** THE «AÑADIR AL CALENDARIO» BUTTON. ***
 *
 * The approved template has ONE button, a "Visit website" URL button with a
 * dynamic suffix, registered in the WhatsApp Manager as
 *
 *   https://api.booking.example.com/cal/{{1}}
 *
 * and this is the component that fills that `{{1}}` with the signed calendar
 * token (`calendarLink.ts`). The shape is Cloud API's documented one for URL
 * buttons: `sub_type: "url"`, the button's zero-based `index` AS A STRING, and
 * a single `text` parameter that Meta appends to the registered base URL.
 * URL-button variables are positional even in a template whose BODY uses
 * named parameters, so this parameter carries no `parameter_name`.
 *
 * Meta rejects a send that omits it once the template has the button, which
 * is why `src/config/env.ts` refuses to boot a sending mode without the
 * calendar secret: a missing link must be a boot error, never a failed job.
 */
export interface WhatsAppUrlButtonComponent {
  type: "button";
  sub_type: "url";
  index: string;
  parameters: [{ type: "text"; text: string }];
}

export function buildCalendarButtonComponent(token: string): WhatsAppUrlButtonComponent {
  return { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: token }] };
}
