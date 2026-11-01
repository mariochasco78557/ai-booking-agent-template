import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getClientConfig, loadClientConfigFrom } from "../src/core/config/clientConfig.js";
import {
  DEFAULT_TEXTS_ES,
  buildTextContext,
  clientPlaceholders,
  getTexts,
  loadTextOverridesFrom,
  renderTemplate,
  serviceLabel,
} from "../src/core/texts/texts.js";
import * as recados from "../src/services/recados/recadoMessages.js";
import * as wa from "../src/services/waSelfService/waMessages.js";
import { WHATSAPP_TEAM_FALLBACK } from "../src/services/whatsapp/whatsappTemplate.js";
import {
  CALENDAR_EVENT_SUMMARY,
  CALENDAR_PAGE_TITLE,
  eventDescriptionLines,
  renderUnavailablePage,
} from "../src/services/whatsapp/calendarEvent.js";
import * as voz from "../src/services/voiceManage/voiceManageService.js";
import { shortService } from "../src/services/ownerNotify/agendaLines.js";
import {
  BALANCED_CLOSED_AFTERNOON_MESSAGE,
  BALANCED_CLOSED_DAY_MESSAGE,
  BALANCED_SCAN_ALL_CLOSED_MESSAGE,
  balancedLockSummaryEs,
  spokenAppointmentEs,
  withSpokenDayEs,
} from "../src/utils/balancedPhrasing.js";

/**
 * Fase 2, segundo tramo (D-010): los textos con datos del negocio salen de
 * plantillas + `cliente.yaml`. Para Demo Salon (cliente por defecto) cada texto
 * debe ser IDÉNTICO al literal que había en el código en v0.3.0: los valores
 * esperados de abajo son copia literal de aquellos literales.
 */

describe("textos de Demo Salon = literales de v0.3.0", () => {
  it("recados", () => {
    expect(recados.MSG_RECADO).toBe("Le paso tu recado a Bruno y te atenderá a la mayor brevedad.");
    expect(recados.MSG_RECADO_LATE).toBe("Se lo paso a Bruno; si hay algún problema, te llamará.");
    expect(recados.MSG_PHONE_NEEDED).toBe("¿Me dices un teléfono para que Bruno te llame?");
    expect(recados.MSG_NAME_AND_PHONE_NEEDED).toBe("¿Me dices tu nombre y un teléfono para que Bruno te llame?");
    expect(recados.FALLBACK_VOICE_WANTS_HUMAN).toBe(
      "Ahora mismo no puedo pasarte con nadie. Escríbenos por WhatsApp a este mismo número y la peluquería te responderá en cuanto pueda.",
    );
    expect(recados.FALLBACK_VOICE_OTHER).toBe(
      "Lo siento, ahora mismo no he podido resolverlo. Escríbenos por WhatsApp a este mismo número y la peluquería te responderá en cuanto pueda.",
    );
    expect(recados.FALLBACK_VOICE_LATE).toBe(
      "Escríbenos por WhatsApp a este mismo número para avisar del retraso y la peluquería lo tendrá en cuenta.",
    );
    expect(recados.FALLBACK_WA).toBe("Ahora mismo no he podido dejarle el recado a Bruno.");
    expect(recados.START_REPLY("12345")).toBe(
      "Hola. Este bot solo envía los recados de Demo Salon. Tu identificador de chat es: 12345",
    );
  });

  it("autogestión WhatsApp", () => {
    expect(wa.MSG_SELF_SERVICE_UNAVAILABLE).toBe(
      "Por aquí no puedo consultar ni anular citas con este número. Si quieres, le dejo el aviso a Bruno para que te conteste.",
    );
    expect(wa.MSG_UNCERTAIN).toBe(
      "No puedo confirmar si la cita ha quedado anulada. Le he pasado el aviso a Bruno para que lo compruebe.",
    );
    expect(wa.MSG_OWNER_NOTIFIED).toBe("Le he dejado el aviso a Bruno.");
    expect(wa.MSG_OWNER_NOTIFICATION_UNAVAILABLE).toBe("Ahora mismo no he podido dejarle el aviso a Bruno.");
    const item = { day_label: "viernes 16", time: "18:00", professional: "Olga" };
    expect(wa.msgReservationsFound([item], true)).toBe(
      "Con este número de WhatsApp tienes estas citas: el viernes 16 a las 18:00 con Olga. Tienes alguna más; si buscas otra, dímelo y aviso a Bruno.",
    );
    expect(wa.msgReservationsFound([item], false)).toBe(
      "Con este número de WhatsApp tienes estas citas: el viernes 16 a las 18:00 con Olga.",
    );
    expect(wa.msgTooLate(true)).toBe(
      "Esa cita ya ha empezado y no puedo anularla por aquí. Le he pasado el aviso a Bruno.",
    );
    expect(wa.msgTooLate(false)).toBe(
      "Esa cita ya ha empezado y no puedo anularla por aquí. Llama a la peluquería, por favor.",
    );
    expect(wa.msgCancelPendingOwner("viernes 16", "18:00", true)).toBe(
      "Le he pasado a Bruno tu petición de anular la cita del viernes 16 a las 18:00. Hasta que él la anule, la cita sigue en pie.",
    );
    expect(wa.msgCancelPendingOwner("viernes 16", "18:00", false)).toBe(
      "Ahora mismo no puedo anularla ni avisar a Bruno. La cita sigue en pie.",
    );
    expect(wa.MSG_SERVICE_TOO_LATE).toBe(
      "Tu cita es muy pronto y ya no puedo cambiarla por aquí. Se lo paso a Bruno, ¿te parece?",
    );
    expect(wa.MSG_SERVICE_UNAVAILABLE).toBe(
      "Ahora no puedo cambiar el servicio por aquí. ¿Quieres que se lo pase a Bruno?",
    );
    expect(wa.msgServiceLost(item)).toBe(
      "Ha habido un problema con tu cita del viernes 16 a las 18:00. Ya he avisado a Bruno para que te la deje apuntada; te contestará en cuanto pueda.",
    );
  });

  it("plantilla de WhatsApp y calendario", () => {
    expect(WHATSAPP_TEAM_FALLBACK).toBe("el equipo de Demo Salon");
    expect(CALENDAR_EVENT_SUMMARY).toBe("Cita en Demo Salon");
    expect(CALENDAR_PAGE_TITLE).toBe("Tu cita en Demo Salon");
    const event = { startMs: 0, durationMinutes: 30, professionalName: "Bruno", serviceLabel: "Corte de pelo" };
    expect(eventDescriptionLines(event as Parameters<typeof eventDescriptionLines>[0])).toEqual([
      "Profesional: Bruno",
      "Servicio: Corte de pelo",
      "Para cambiar o anular la cita, llama al 910 00 00 25.",
    ]);
    const page = renderUnavailablePage("expired");
    expect(page).toContain(
      '<p class="note">Para cambiar o anular la cita, llama al <a href="tel:+34910000025">910 00 00 25</a>.</p>',
    );
    expect(page).toContain("<title>Este enlace ha caducado · Demo Salon</title>");
  });

  it("gestión por voz", () => {
    expect(voz.MSG_MANAGE_BY_WHATSAPP).toBe(
      "Los cambios y las cancelaciones los gestiona directamente la peluquería por WhatsApp, en este mismo número al que has llamado. Escríbenos con tu nombre, el día y la hora de la cita y lo que necesitas, y la peluquería lo mira en la agenda y te lo confirma en cuanto pueda.",
    );
    expect(voz.MSG_NO_BOOKINGS).toBe(
      "Con este número no veo ninguna cita pendiente. Si la pediste con otro número, escríbenos por WhatsApp a este mismo número y la peluquería lo mira.",
    );
    expect(voz.MSG_AGENDA_UNAVAILABLE).toBe(
      "Ahora mismo no puedo ver tus citas. Escríbenos por WhatsApp a este mismo número y la peluquería lo mira.",
    );
    expect(voz.MSG_DICTATED_NOT_FOUND_FINAL).toBe(
      "No encuentro ninguna cita con esos datos. Escríbenos por WhatsApp a este mismo número y la peluquería lo mira.",
    );
    expect(voz.MSG_DICTATED_LIMIT).toBe(
      "Por teléfono no puedo comprobar más datos. Escríbenos por WhatsApp a este mismo número y la peluquería lo mira.",
    );
    const at = "2026-10-16 18:00:00";
    const when = spokenAppointmentEs(at).replace(/^el /, "");
    expect(voz.msgNotCancelledVoice(at)).toBe(
      `No he podido anularla: tu cita del ${when} sigue en pie. Escríbenos por WhatsApp a este mismo número y la peluquería la anula.`,
    );
    expect(voz.msgCancelUncertainVoice(at)).toBe(
      `No he podido confirmar si tu cita del ${when} ha quedado anulada. Escríbenos por WhatsApp a este mismo número y la peluquería lo comprueba.`,
    );
    expect(voz.MSG_SERVICE_TOO_LATE_VOICE).toBe("Tu cita es muy pronto para cambiarla por teléfono. ¿Se lo paso a Bruno?");
    expect(voz.MSG_SERVICE_UNAVAILABLE_VOICE).toBe("Ahora no puedo cambiarlo. ¿Se lo paso a Bruno?");
    expect(voz.MSG_SERVICE_LOST_VOICE).toBe(
      "Ha habido un problema con tu cita. Ya he avisado a Bruno para que te la deje apuntada.",
    );
    // SERVICE_WORDS = { 0: "barba", 1: "corte de pelo", 2: "corte y barba" }
    expect(voz.msgSameServiceVoice(0)).toBe("Tu cita ya es de barba.");
    expect(voz.msgSameServiceVoice(1)).toBe("Tu cita ya es de corte de pelo.");
    expect(voz.msgSameServiceVoice(2)).toBe("Tu cita ya es de corte y barba.");
    expect(voz.msgSameServiceVoice(9)).toBe("Tu cita ya es de undefined.");
    const b = { startsAt: at, employeeName: "Ramón" };
    expect(voz.msgServiceConfirmVoice(b, 1, 2)).toBe(
      `¿Te dejo la cita del ${when} con Ramón como corte y barba, en vez de corte de pelo?`,
    );
    expect(voz.msgServiceConfirmVoice(b, null, 0)).toBe(`¿Te dejo la cita del ${when} con Ramón como barba?`);
  });

  it("avisos de agenda: palabra corta del servicio", () => {
    expect(shortService(0)).toBe("barba");
    expect(shortService(1)).toBe("corte");
    expect(shortService(2)).toBe("corte y barba");
    expect(shortService(null)).toBe("otro servicio");
    expect(shortService(7)).toBe("otro servicio");
  });

  it("disponibilidad por voz", () => {
    expect(BALANCED_CLOSED_AFTERNOON_MESSAGE).toBe(
      "Ese día por la tarde la peluquería está cerrada. ¿Qué otro día te viene bien?",
    );
    expect(BALANCED_CLOSED_DAY_MESSAGE).toBe(
      "Los domingos y los lunes la peluquería está cerrada. ¿Qué otro día te viene bien?",
    );
    expect(BALANCED_SCAN_ALL_CLOSED_MESSAGE).toBe("Esos días la peluquería está cerrada. ¿Qué otras fechas miro?");
    expect(withSpokenDayEs(BALANCED_CLOSED_DAY_MESSAGE, "2026-10-12", "2026-10-12")).toMatch(
      /^Hoy, .+, la peluquería está cerrada\. ¿Qué otro día te viene bien\?$/,
    );
    expect(withSpokenDayEs(BALANCED_CLOSED_DAY_MESSAGE, "2026-10-19", "2026-10-12")).toMatch(
      /^El lunes .+ la peluquería está cerrada\. ¿Qué otro día te viene bien\?$/,
    );
    const summary = (serviceId: number): string =>
      balancedLockSummaryEs({ serviceId, reservationDate: "2026-10-16 18:00:00", employeeName: "Ramón" });
    expect(summary(0).startsWith("Te resumo: barba, ")).toBe(true);
    expect(summary(1).startsWith("Te resumo: corte de pelo, ")).toBe(true);
    expect(summary(2).startsWith("Te resumo: corte y barba, ")).toBe(true);
    expect(summary(9)).toMatch(/^Te resumo: /);
    expect(summary(9)).not.toContain("undefined");
  });
});

describe("capa de textos (D-010)", () => {
  const dir = mkdtempSync(join(tmpdir(), "textos-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const otroCliente = `
nombre: "Taller Ejemplo"
nombre_corto: "Ejemplo"
sector: { nombre: "taller", negocio: "el taller", palabra_empleado: "mecánico" }
responsable: "Ane"
idioma: es-ES
zona_horaria: Europe/Madrid
telefono: { mostrar: "910 00 00 00", e164: "+34910000000" }
dias_cerrados: [sabado, domingo]
duracion_cita_min: 60
servicios:
  - { id: "5", nombre: "Cambio de aceite", duracion_min: 60, etiquetas: { corta: "aceite" } }
empleados:
  - { nombre: "Ane", calendario: "cal-ane" }
calendario: { provider: google-calendar }
`;

  it("Demo Salon: marcadores del cliente y servicios", () => {
    const p = clientPlaceholders(getClientConfig());
    expect(p).toMatchObject({
      salon: "Demo Salon",
      marca: "Demo Salon",
      telefono: "910 00 00 25",
      responsable: "Bruno",
      negocio: "la peluquería",
      a_negocio: "a la peluquería",
      cerrado: "cerrada",
      dias_cerrados: "los domingos y los lunes",
    });
    expect(serviceLabel(1, "voz")).toBe("corte de pelo");
    expect(serviceLabel("1", "corta")).toBe("corte");
    expect(serviceLabel(null, "voz")).toBeUndefined();
    // La única frase de Demo Salon que no cabe en el texto genérico (pronombre «él») va en textos.yaml.
    expect(getTexts()["wa.anular_pendiente.avisado"]).toContain("Hasta que él la anule");
    expect(DEFAULT_TEXTS_ES["wa.anular_pendiente.avisado"]).toContain("Hasta que la anule");
  });

  it("otro cliente: forma larga de sector, contracción «al» y género", () => {
    const path = join(dir, "cliente.yaml");
    writeFileSync(path, otroCliente);
    const cfg = loadClientConfigFrom(path);
    const ctx = buildTextContext(cfg, {});
    const r = (key: keyof typeof DEFAULT_TEXTS_ES, vars = {}): string =>
      renderTemplate(ctx.templates[key], { ...ctx.placeholders, ...vars });
    expect(r("recados.cliente.recado")).toBe("Le paso tu recado a Ane y te atenderá a la mayor brevedad.");
    expect(r("wa.demasiado_tarde.sin_aviso")).toContain("Llama al taller, por favor.");
    expect(r("balanced.cerrado_dia")).toBe(
      "Los sábados y los domingos el taller está cerrado. ¿Qué otro día te viene bien?",
    );
    expect(r("whatsapp.plantilla.equipo")).toBe("el equipo de Ejemplo");
    expect(ctx.placeholders.palabra_empleado).toBe("mecánico");
    expect(ctx.serviceLabels.get("5")).toEqual({ nombre: "Cambio de aceite", voz: "cambio de aceite", corta: "aceite" });
  });

  it("forma corta de sector: valores genéricos", () => {
    const path = join(dir, "corto.yaml");
    writeFileSync(path, otroCliente.replace(/^sector: .*$/m, 'sector: "clínica"').replace(/^responsable: .*$/m, ""));
    const p = clientPlaceholders(loadClientConfigFrom(path));
    expect(p).toMatchObject({ negocio: "el negocio", a_negocio: "al negocio", cerrado: "cerrado", responsable: "Ane" });
    expect(p.sector).toBe("clínica");
    expect(p.palabra_empleado).toBe("profesional");
  });

  it("textos.yaml: sustituye, y falla con clave o marcador desconocidos", () => {
    const keys = ["salon", "responsable", "negocio"];
    const ok = join(dir, "ok.yaml");
    writeFileSync(ok, '"wa.aviso_dejado": "Aviso enviado a {responsable}."\n');
    expect(loadTextOverridesFrom(ok, keys)).toEqual({ "wa.aviso_dejado": "Aviso enviado a {responsable}." });
    expect(loadTextOverridesFrom(join(dir, "no-existe.yaml"), keys)).toEqual({});
    const empty = join(dir, "vacio.yaml");
    writeFileSync(empty, "# sin cambios\n");
    expect(loadTextOverridesFrom(empty, keys)).toEqual({});
    const badKey = join(dir, "clave.yaml");
    writeFileSync(badKey, '"wa.no_existe": "x"\n');
    expect(() => loadTextOverridesFrom(badKey, keys)).toThrow(/clave desconocida/);
    const badVar = join(dir, "marcador.yaml");
    writeFileSync(badVar, '"wa.aviso_dejado": "Aviso a {hora}."\n');
    expect(() => loadTextOverridesFrom(badVar, keys)).toThrow(/marcador no admitido \{hora\}/);
    const runtimeVar = join(dir, "ejecucion.yaml");
    writeFileSync(runtimeVar, '"wa.servicio.perdido": "Problema el {dia} a las {hora}; aviso a {responsable}."\n');
    expect(loadTextOverridesFrom(runtimeVar, keys)).toHaveProperty("wa.servicio.perdido");
  });

  it("renderTemplate: mayúscula inicial y marcador sin valor intacto", () => {
    expect(renderTemplate("{Negocio} y {negocio} {x}", { negocio: "la tienda" })).toBe("La tienda y la tienda {x}");
  });
});
