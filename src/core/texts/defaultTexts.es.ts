/**
 * *** TEXTOS POR DEFECTO (español) — D-010. ***
 *
 * Plantillas genéricas de los textos al cliente final y al dueño que llevan
 * algún dato del negocio. El dato NUNCA va escrito aquí: va como marcador y
 * se rellena desde `cliente.yaml` (ver `texts.ts`). Un cliente puede cambiar
 * cualquier frase en `clientes/<id>/textos.yaml` (misma clave, mismo juego de
 * marcadores).
 *
 * Marcadores del cliente (siempre disponibles):
 *   {salon}            nombre del negocio (`nombre`)
 *   {marca}            nombre corto (`nombre_corto`, o `nombre`)
 *   {telefono}         teléfono para mostrar (`telefono.mostrar`)
 *   {telefono_e164}    teléfono E.164 (`telefono.e164`)
 *   {responsable}      quien recibe recados y avisos (`responsable`, o el empleado por defecto)
 *   {negocio}          el negocio en tercera persona, con artículo (`sector.negocio`, p. ej. «la peluquería»)
 *   {a_negocio}        lo mismo tras «a» («a la peluquería», «al taller»)
 *   {de_negocio}       lo mismo tras «de» («de la peluquería», «del taller»)
 *   {cerrado}          «cerrada» si `sector.negocio` empieza por «la », si no «cerrado»
 *   {sector}           nombre del sector (`sector` o `sector.nombre`)
 *   {palabra_empleado} cómo se llama a un profesional (`sector.palabra_empleado`, o «profesional»)
 *   {dias_cerrados}    «los domingos y los lunes» (de `dias_cerrados`/`horario`)
 * Un marcador con la primera letra en mayúscula ({Dias_cerrados}) pone en
 * mayúscula la primera letra del valor.
 *
 * Marcadores de ejecución (solo en las claves que los usan): {dia}, {hora},
 * {cita}, {chat_id}, {fecha}, {pendientes}, {servicios}.
 */
export const DEFAULT_TEXTS_ES = {
  // ── recados (services/recados/recadoMessages.ts) ──────────────────────────
  "recados.cliente.recado": "Le paso tu recado a {responsable} y te atenderá a la mayor brevedad.",
  "recados.cliente.recado_tarde": "Se lo paso a {responsable}; si hay algún problema, te llamará.",
  "recados.cliente.pide_telefono": "¿Me dices un teléfono para que {responsable} te llame?",
  "recados.cliente.pide_nombre_y_telefono": "¿Me dices tu nombre y un teléfono para que {responsable} te llame?",
  "recados.voz.quiere_humano":
    "Ahora mismo no puedo pasarte con nadie. Escríbenos por WhatsApp a este mismo número y {negocio} te responderá en cuanto pueda.",
  "recados.voz.otro":
    "Lo siento, ahora mismo no he podido resolverlo. Escríbenos por WhatsApp a este mismo número y {negocio} te responderá en cuanto pueda.",
  "recados.voz.retraso":
    "Escríbenos por WhatsApp a este mismo número para avisar del retraso y {negocio} lo tendrá en cuenta.",
  "recados.wa.fallo": "Ahora mismo no he podido dejarle el recado a {responsable}.",
  "recados.telegram.inicio": "Hola. Este bot solo envía los recados de {marca}. Tu identificador de chat es: {chat_id}",

  // ── autogestión WhatsApp (services/waSelfService/waMessages.ts) ───────────
  "wa.autogestion_no_disponible":
    "Por aquí no puedo consultar ni anular citas con este número. Si quieres, le dejo el aviso a {responsable} para que te conteste.",
  "wa.anulacion_incierta":
    "No puedo confirmar si la cita ha quedado anulada. Le he pasado el aviso a {responsable} para que lo compruebe.",
  "wa.aviso_dejado": "Le he dejado el aviso a {responsable}.",
  "wa.aviso_no_disponible": "Ahora mismo no he podido dejarle el aviso a {responsable}.",
  "wa.citas.hay_mas": "Tienes alguna más; si buscas otra, dímelo y aviso a {responsable}.",
  "wa.demasiado_tarde.avisado": "Esa cita ya ha empezado y no puedo anularla por aquí. Le he pasado el aviso a {responsable}.",
  "wa.demasiado_tarde.sin_aviso": "Esa cita ya ha empezado y no puedo anularla por aquí. Llama {a_negocio}, por favor.",
  "wa.anular_pendiente.avisado":
    "Le he pasado a {responsable} tu petición de anular la cita del {dia} a las {hora}. Hasta que la anule, la cita sigue en pie.",
  "wa.anular_pendiente.sin_aviso": "Ahora mismo no puedo anularla ni avisar a {responsable}. La cita sigue en pie.",
  "wa.servicio.demasiado_tarde":
    "Tu cita es muy pronto y ya no puedo cambiarla por aquí. Se lo paso a {responsable}, ¿te parece?",
  "wa.servicio.no_disponible": "Ahora no puedo cambiar el servicio por aquí. ¿Quieres que se lo pase a {responsable}?",
  "wa.servicio.perdido":
    "Ha habido un problema con tu cita del {dia} a las {hora}. Ya he avisado a {responsable} para que te la deje apuntada; te contestará en cuanto pueda.",

  // ── plantilla de WhatsApp (services/whatsapp/whatsappTemplate.ts) ─────────
  "whatsapp.plantilla.equipo": "el equipo de {marca}",

  // ── evento y página de calendario (services/whatsapp/calendarEvent.ts) ────
  "calendario.evento.titulo": "Cita en {salon}",
  "calendario.cambios": "Para cambiar o anular la cita, llama al {telefono}.",
  "calendario.pagina.titulo": "Tu cita en {salon}",

  // ── gestión por voz (services/voiceManage/voiceManageService.ts) ──────────
  "voz.gestion.por_whatsapp":
    "Los cambios y las cancelaciones los gestiona directamente {negocio} por WhatsApp, en este mismo número al que has llamado. Escríbenos con tu nombre, el día y la hora de la cita y lo que necesitas, y {negocio} lo mira en la agenda y te lo confirma en cuanto pueda.",
  "voz.gestion.sin_citas":
    "Con este número no veo ninguna cita pendiente. Si la pediste con otro número, escríbenos por WhatsApp a este mismo número y {negocio} lo mira.",
  "voz.gestion.agenda_no_disponible":
    "Ahora mismo no puedo ver tus citas. Escríbenos por WhatsApp a este mismo número y {negocio} lo mira.",
  "voz.gestion.dictado_no_encontrado_final":
    "No encuentro ninguna cita con esos datos. Escríbenos por WhatsApp a este mismo número y {negocio} lo mira.",
  "voz.gestion.dictado_limite":
    "Por teléfono no puedo comprobar más datos. Escríbenos por WhatsApp a este mismo número y {negocio} lo mira.",
  "voz.gestion.no_anulada":
    "No he podido anularla: tu cita del {cita} sigue en pie. Escríbenos por WhatsApp a este mismo número y {negocio} la anula.",
  "voz.gestion.anulacion_incierta":
    "No he podido confirmar si tu cita del {cita} ha quedado anulada. Escríbenos por WhatsApp a este mismo número y {negocio} lo comprueba.",
  "voz.servicio.demasiado_tarde": "Tu cita es muy pronto para cambiarla por teléfono. ¿Se lo paso a {responsable}?",
  "voz.servicio.no_disponible": "Ahora no puedo cambiarlo. ¿Se lo paso a {responsable}?",
  "voz.servicio.perdido": "Ha habido un problema con tu cita. Ya he avisado a {responsable} para que te la deje apuntada.",

  // ── disponibilidad por voz (utils/balancedPhrasing.ts) ────────────────────
  "balanced.cerrado_tarde": "Ese día por la tarde {negocio} está {cerrado}. ¿Qué otro día te viene bien?",
  "balanced.cerrado_dia": "{Dias_cerrados} {negocio} está {cerrado}. ¿Qué otro día te viene bien?",
  "balanced.cerrado_dia_con_fecha": "{fecha} {negocio} está {cerrado}. ¿Qué otro día te viene bien?",
  "balanced.cerrado_varios_dias": "Esos días {negocio} está {cerrado}. ¿Qué otras fechas miro?",
  // ── reserva, anulación y consulta por voz (utils/phrasing.ts) ─────────────
  "voz.escalar": "No lo veo claro desde aquí. Te recomiendo llamar directamente {a_negocio}.",
  "voz.reserva.escritura_desactivada":
    "Ahora mismo no puedo cerrar la reserva por teléfono. Te recomiendo confirmarla directamente con {negocio}.",
  "voz.anular.escritura_desactivada":
    "Ahora mismo no puedo cancelar la reserva por teléfono. Te recomiendo hacerlo directamente con {negocio}.",
  "voz.agenda_no_disponible":
    "Ahora mismo no puedo consultar la agenda. ¿Prefieres que lo intentemos en un momento o que te llamen desde {negocio}?",
  "voz.reserva.incierta":
    "No he podido confirmar la reserva. No te la doy por hecha: el equipo {de_negocio} lo revisará y se pondrá en contacto contigo.",
  "voz.anular.sin_identidad":
    "No puedo confirmar tu número en esta llamada, así que no puedo cancelar la reserva por teléfono. Te recomiendo llamar directamente {a_negocio}.",
  "voz.anular.identidad_no_verificada":
    "Ahora mismo no puedo verificar tu número en esta llamada, así que no puedo cancelar la reserva. Te recomiendo llamar directamente {a_negocio}.",
  "voz.anular.confianza_insuficiente":
    "Para cancelar una reserva por teléfono necesito poder confirmar tu número de una forma más segura. Te recomiendo llamar directamente {a_negocio}.",
  "voz.anular.no_encontrada": "No encuentro esa reserva. Te recomiendo llamar directamente {a_negocio}.",
  "voz.anular.ambigua":
    "He encontrado varias reservas y no puedo saber cuál quieres cancelar por teléfono. Te recomiendo llamar directamente {a_negocio}.",
  "voz.anular.no_soportado":
    "Ahora mismo no puedo cancelar reservas por teléfono. Te recomiendo llamar directamente {a_negocio} para que lo revisen contigo.",
  "voz.anular.prueba_invalida": "Ahora mismo no puedo completar la cancelación. Te recomiendo llamar directamente {a_negocio}.",
  "voz.consulta.no_soportada":
    "Ahora mismo no puedo consultar ni cancelar reservas por teléfono. Te recomiendo llamar directamente {a_negocio} para que lo revisen contigo.",
  "voz.consulta.sin_identidad":
    "No puedo confirmar tu número en esta llamada, así que no puedo consultarte las reservas por teléfono. Te recomiendo llamar directamente {a_negocio}.",
  "voz.consulta.identidad_no_verificada":
    "Ahora mismo no puedo verificar tu número en esta llamada, así que no puedo consultarte las reservas. Te recomiendo llamar directamente {a_negocio}.",
  "voz.consulta.llamante_rechazado": "Ahora mismo no puedo consultar tu reserva por teléfono. Te recomiendo llamar directamente {a_negocio}.",
  "voz.consulta.ambigua":
    "He encontrado varias reservas con este número y no te las puedo detallar por teléfono. Te recomiendo llamar directamente {a_negocio}.",

  // ── reserva por voz (services/voiceBookingService.ts) ─────────────────────
  "voz.reserva.ya_reservada_en_llamada":
    "Ya se ha confirmado una reserva durante esta llamada. Para hacer otra, debe revisarlo {negocio}.",

  // ── límite de citas por número (services/bookingLimit/phoneBookingLimit.ts) ─
  "limite_citas.voz":
    "Con este número ya tienes {pendientes}, así que esta no la he podido reservar. Si necesitas otra, escríbenos por WhatsApp a este mismo número y te lo gestiona {responsable}.",
  "limite_citas.whatsapp":
    "Con este número ya tienes {pendientes}, así que esta no la he podido reservar. Si necesitas otra, se lo dejo apuntado a {responsable} y te contesta por aquí.",

  // ── demo sintética del motor de llamadas (callEngine/phrasing/es.ts) ──────
  "demo.saludo": "Hola, esto es una demostración local y sintética de {salon}, no producción. ¿En qué puedo ayudarte?",
  "demo.pide_servicio": "¿Qué servicio te gustaría: {servicios}?",
} as const satisfies Record<string, string>;

export type TextKey = keyof typeof DEFAULT_TEXTS_ES;
