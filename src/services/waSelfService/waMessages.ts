import { t } from "../../core/texts/texts.js";

/**
 * Exact Spanish texts for /ai/wa/* (DESIGN §6.7). Tests compare them literally.
 * Wording with business data comes from `src/core/texts` (D-010).
 */

export const MSG_SELF_SERVICE_UNAVAILABLE = t("wa.autogestion_no_disponible");
export const MSG_NO_RESERVATIONS = "No veo ninguna cita a partir de hoy con este número de WhatsApp.";
export const MSG_RATE_LIMITED =
  "Ahora mismo no puedo hacer más consultas. Prueba de nuevo dentro de un rato.";
export const MSG_UPSTREAM_ERROR = "Ahora mismo no puedo consultar la agenda.";
export const MSG_NOT_CONFIRMED =
  "Antes de anularla necesito que me confirmes que quieres anular esa cita.";
export const MSG_RELOOK = "Déjame volver a mirar tus citas.";
export const MSG_NOT_FOUND = "Ya no veo esa cita con este número de WhatsApp.";
export const MSG_UNCERTAIN = t("wa.anulacion_incierta");
export const MSG_OWNER_NOTIFIED = t("wa.aviso_dejado");
export const MSG_OWNER_NOTIFICATION_UNAVAILABLE = t("wa.aviso_no_disponible");
export const MSG_INVALID_REQUEST = "No he podido leer la petición.";

export interface MessageItem {
  day_label: string;
  time: string;
  professional: string | null;
}

export function msgReservationsFound(items: MessageItem[], moreThanShown: boolean): string {
  const parts = items.map(
    (i) => `el ${i.day_label} a las ${i.time}${i.professional ? ` con ${i.professional}` : ""}`,
  );
  let list: string;
  if (parts.length <= 1) list = parts.join("");
  else list = `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
  return (
    `Con este número de WhatsApp tienes estas citas: ${list}.` +
    (moreThanShown ? ` ${t("wa.citas.hay_mas")}` : "")
  );
}

export function msgTooLate(ownerNotified: boolean): string {
  return ownerNotified ? t("wa.demasiado_tarde.avisado") : t("wa.demasiado_tarde.sin_aviso");
}

export function msgCancelPendingOwner(
  dayLabel: string,
  time: string,
  ownerNotified: boolean,
): string {
  return ownerNotified
    ? t("wa.anular_pendiente.avisado", { dia: dayLabel, hora: time })
    : t("wa.anular_pendiente.sin_aviso");
}

export function msgCancelled(dayLabel: string, time: string): string {
  return `Hecho: la cita del ${dayLabel} a las ${time} queda anulada.`;
}

// ------------------------------------------------ cambiar servicio (2026-10-11)
// (internal doc, not included in the template) §4. Written by the server, copied by the model.

export interface ServiceChangeWhen {
  day_label: string;
  time: string;
  professional: string | null;
}

function withProfessional(w: ServiceChangeWhen): string {
  return `${w.day_label} a las ${w.time}${w.professional ? ` con ${w.professional}` : ""}`;
}

/** «Corte y barba» -> «corte y barba». */
export function serviceWordEs(label: string | null): string {
  return label === null ? "otro servicio" : label.toLowerCase();
}

export function msgServiceConfirm(w: ServiceChangeWhen, fromLabel: string | null, toLabel: string | null): string {
  return `¿Cambio tu cita del ${withProfessional(w)} de ${serviceWordEs(fromLabel)} a ${serviceWordEs(toLabel)}? Misma hora y mismo profesional. Responde «sí».`;
}

export function msgServiceChanged(w: ServiceChangeWhen, toLabel: string | null): string {
  return `Listo ✅ tu cita del ${withProfessional(w)} queda como ${serviceWordEs(toLabel)}.`;
}

export function msgSameService(w: ServiceChangeWhen, label: string | null): string {
  return `Tu cita del ${w.day_label} a las ${w.time} ya es de ${serviceWordEs(label)}.`;
}

export function msgServiceNotChanged(w: ServiceChangeWhen): string {
  return `No he podido cambiar el servicio; tu cita del ${withProfessional(w)} sigue como estaba.`;
}

export const MSG_SERVICE_TOO_LATE = t("wa.servicio.demasiado_tarde");
export const MSG_SERVICE_UNAVAILABLE = t("wa.servicio.no_disponible");

export function msgServiceLost(w: ServiceChangeWhen): string {
  return t("wa.servicio.perdido", { dia: w.day_label, hora: w.time });
}
