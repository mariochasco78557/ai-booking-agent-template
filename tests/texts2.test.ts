import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../src/config/env.js";
import * as p from "../src/utils/phrasing.js";
import { ES } from "../src/callEngine/phrasing/es.js";
import { SERVICE_LABELS } from "../src/callEngine/domain/types.js";
import { classifyIntent } from "../src/callEngine/intent.js";
import { serviceLabelOf } from "../src/services/whatsapp/whatsappNotifier.js";
import {
  phoneBookingLimitVoiceMessage,
  phoneBookingLimitWhatsAppMessage,
} from "../src/services/bookingLimit/phoneBookingLimit.js";
import { ALREADY_BOOKED_IN_CALL_MESSAGE } from "../src/services/voiceBookingService.js";
import { buildTextContext, clientPlaceholders, renderTemplate } from "../src/core/texts/texts.js";
import { loadClientConfigFrom, resetClientConfigForTests } from "../src/core/config/clientConfig.js";

/**
 * Fase 2, tercer tramo (D-012): los textos y etiquetas de cliente que quedaban
 * en el núcleo salen de la capa de textos y de `cliente.yaml`. Para Demo Salon
 * (cliente por defecto) cada salida debe ser IDÉNTICA al literal de v0.4.0:
 * los valores esperados de abajo son copia literal de aquellos literales.
 */

describe("textos de Demo Salon = literales de v0.4.0 (tercer tramo)", () => {
  it("utils/phrasing.ts: los 17 mensajes que mandaban a «la peluquería»", () => {
    expect(p.ESCALATION_MESSAGE).toBe(
      "No lo veo claro desde aquí. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.WRITE_DISABLED_BOOK_MESSAGE).toBe(
      "Ahora mismo no puedo cerrar la reserva por teléfono. Te recomiendo confirmarla directamente con la peluquería.",
    );
    expect(p.WRITE_DISABLED_CANCEL_MESSAGE).toBe(
      "Ahora mismo no puedo cancelar la reserva por teléfono. Te recomiendo hacerlo directamente con la peluquería.",
    );
    expect(p.AGENDA_UNAVAILABLE_MESSAGE).toBe(
      "Ahora mismo no puedo consultar la agenda. ¿Prefieres que lo intentemos en un momento o que te llamen desde la peluquería?",
    );
    expect(p.BOOKING_UNCERTAIN_MESSAGE).toBe(
      "No he podido confirmar la reserva. No te la doy por hecha: el equipo de la peluquería lo revisará y se pondrá en contacto contigo.",
    );
    expect(p.CANCEL_IDENTITY_MISSING_MESSAGE).toBe(
      "No puedo confirmar tu número en esta llamada, así que no puedo cancelar la reserva por teléfono. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.CANCEL_IDENTITY_UNVERIFIED_MESSAGE).toBe(
      "Ahora mismo no puedo verificar tu número en esta llamada, así que no puedo cancelar la reserva. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.CANCEL_INSUFFICIENT_TRUST_MESSAGE).toBe(
      "Para cancelar una reserva por teléfono necesito poder confirmar tu número de una forma más segura. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.CANCEL_NO_CANDIDATE_MESSAGE).toBe(
      "No encuentro esa reserva. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.CANCEL_AMBIGUOUS_MESSAGE).toBe(
      "He encontrado varias reservas y no puedo saber cuál quieres cancelar por teléfono. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.CANCEL_NOT_SUPPORTED_MESSAGE).toBe(
      "Ahora mismo no puedo cancelar reservas por teléfono. Te recomiendo llamar directamente a la peluquería para que lo revisen contigo.",
    );
    expect(p.CANCEL_PROOF_INVALID_MESSAGE).toBe(
      "Ahora mismo no puedo completar la cancelación. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.LOOKUP_NOT_SUPPORTED_MESSAGE).toBe(
      "Ahora mismo no puedo consultar ni cancelar reservas por teléfono. Te recomiendo llamar directamente a la peluquería para que lo revisen contigo.",
    );
    expect(p.LOOKUP_IDENTITY_MISSING_MESSAGE).toBe(
      "No puedo confirmar tu número en esta llamada, así que no puedo consultarte las reservas por teléfono. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.LOOKUP_IDENTITY_UNVERIFIED_MESSAGE).toBe(
      "Ahora mismo no puedo verificar tu número en esta llamada, así que no puedo consultarte las reservas. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.LOOKUP_CALLER_ID_REJECTED_MESSAGE).toBe(
      "Ahora mismo no puedo consultar tu reserva por teléfono. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.LOOKUP_AMBIGUOUS_MESSAGE).toBe(
      "He encontrado varias reservas con este número y no te las puedo detallar por teléfono. Te recomiendo llamar directamente a la peluquería.",
    );
    expect(p.CANCEL_HUMAN_ASSISTANCE_MESSAGE).toBe(p.ESCALATION_MESSAGE);
  });

  it("callEngine: saludo de la demo, pregunta de servicio y etiquetas", () => {
    expect(ES.GREETING_DEMO_FRAME()).toBe(
      "Hola, esto es una demostración local y sintética de Demo Salon, no producción. " +
        "¿En qué puedo ayudarte?",
    );
    expect(ES.ASK_SERVICE()).toBe("¿Qué servicio te gustaría: barba, corte de pelo, o corte y barba?");
    expect(ES.ASK_SERVICE_CONFIRMATION({ serviceId: 1 })).toBe("¿Confirmas que quieres Corte de pelo?");
    expect(ES.ASK_BOOKING_CONFIRMATION({ serviceId: 2, day: "martes", time: "10:00" })).toBe(
      "Entonces, Corte y barba el martes a las 10:00. ¿Confirmas la reserva?",
    );
    expect(SERVICE_LABELS).toEqual({ 0: "Barba", 1: "Corte de pelo", 2: "Corte y barba" });
  });

  it("serviceLabelOf (WhatsApp, recados, autogestión)", () => {
    expect(serviceLabelOf(0)).toBe("Barba");
    expect(serviceLabelOf(1)).toBe("Corte de pelo");
    expect(serviceLabelOf(2)).toBe("Corte y barba");
    expect(serviceLabelOf(3)).toBeNull();
    expect(serviceLabelOf(undefined)).toBeNull();
  });

  it("callEngine/intent.ts: «política de la peluquería» sigue siendo PRICE_OR_POLICY", () => {
    expect(classifyIntent("¿Cuál es la política de la peluquería?")).toEqual({
      intent: "PRICE_OR_POLICY",
      confident: true,
    });
  });

  it("voiceBookingService: segunda reserva en la misma llamada", () => {
    // Literal de v0.4.0 (const ALREADY_BOOKED_RESULT.message, sin exportar entonces).
    expect(ALREADY_BOOKED_IN_CALL_MESSAGE).toBe(
      "Ya se ha confirmado una reserva durante esta llamada. Para hacer otra, debe revisarlo la peluquería.",
    );
  });

  it("límite de citas por número: la salida de cada canal", () => {
    expect(phoneBookingLimitVoiceMessage(3)).toBe(
      "Con este número ya tienes tres citas pendientes, así que esta no la he podido reservar. " +
        "Si necesitas otra, escríbenos por WhatsApp a este mismo número y te lo gestiona Bruno.",
    );
    expect(phoneBookingLimitWhatsAppMessage(3)).toBe(
      "Con este número ya tienes tres citas pendientes, así que esta no la he podido reservar. " +
        "Si necesitas otra, se lo dejo apuntado a Bruno y te contesta por aquí.",
    );
    expect(phoneBookingLimitWhatsAppMessage(1)).toBe(
      "Con este número ya tienes una cita pendiente, así que esta no la he podido reservar. " +
        "Si necesitas otra, se lo dejo apuntado a Bruno y te contesta por aquí.",
    );
  });
});

describe("otro cliente: los mismos textos sin datos de Demo Salon", () => {
  const dir = mkdtempSync(join(tmpdir(), "textos2-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("{de_negocio}/{a_negocio} contraen con «el», y {responsable} sustituye a Bruno", () => {
    const path = join(dir, "cliente.yaml");
    writeFileSync(
      path,
      `
nombre: "Taller Ejemplo"
sector: { nombre: "taller", negocio: "el taller" }
responsable: "Ane"
idioma: es-ES
zona_horaria: Europe/Madrid
telefono: { mostrar: "910 00 00 00", e164: "+34910000000" }
duracion_cita_min: 60
servicios:
  - { id: "5", nombre: "Cambio de aceite", duracion_min: 60 }
empleados:
  - { nombre: "Ane", calendario: "cal-ane" }
calendario: { provider: google-calendar }
`,
    );
    const cfg = loadClientConfigFrom(path);
    expect(cfg.plantilla_whatsapp).toBeUndefined();
    const ctx = buildTextContext(cfg, {});
    const r = (key: keyof typeof ctx.templates, vars = {}): string =>
      renderTemplate(ctx.templates[key], { ...ctx.placeholders, ...vars });
    expect(clientPlaceholders(cfg).de_negocio).toBe("del taller");
    expect(r("voz.escalar")).toBe("No lo veo claro desde aquí. Te recomiendo llamar directamente al taller.");
    expect(r("voz.reserva.incierta")).toContain("el equipo del taller lo revisará");
    expect(r("limite_citas.voz", { pendientes: "dos citas pendientes" })).toContain("te lo gestiona Ane.");
    expect(r("demo.saludo")).toContain("sintética de Taller Ejemplo,");
    expect(ctx.serviceLabels.get("5")?.nombre).toBe("Cambio de aceite");
    const all = Object.keys(ctx.templates).map((key) => r(key as keyof typeof ctx.templates));
    expect(all.filter((text) => /demo-salon|bruno|peluquer/i.test(text))).toEqual([]);
  });
});

describe("WHATSAPP_TEMPLATE_NAME: variable de entorno > cliente.yaml", () => {
  const KEYS = [
    "WHATSAPP_TEMPLATE_NAME",
    "WHATSAPP_NOTIFICATIONS_MODE",
    "WHATSAPP_QUEUE_PATH",
    "CLIENT_ID",
    "CLIENT_CONFIG_PATH",
    "BOOKING_USERNAME",
    "BOOKING_PASSWORD",
    "AI_WEBHOOK_SECRET",
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    process.env.BOOKING_USERNAME = "test-user";
    process.env.BOOKING_PASSWORD = "test-pass";
    process.env.AI_WEBHOOK_SECRET = "x".repeat(32);
    resetClientConfigForTests();
    resetEnvCache();
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetClientConfigForTests();
    resetEnvCache();
  });

  it("sin variable: la plantilla de Demo Salon", () => {
    expect(loadEnv().WHATSAPP_TEMPLATE_NAME).toBe("cita_confirmada_demo_salon");
  });

  it("la variable sigue ganando", () => {
    process.env.WHATSAPP_TEMPLATE_NAME = "otra_plantilla";
    expect(loadEnv().WHATSAPP_TEMPLATE_NAME).toBe("otra_plantilla");
  });

  it("cliente sin plantilla: vale con WhatsApp apagado y falla al arrancar si no lo está", () => {
    const dir = mkdtempSync(join(tmpdir(), "plantilla-"));
    try {
      const path = join(dir, "cliente.yaml");
      writeFileSync(
        path,
        [
          'nombre: "Taller Ejemplo"',
          'sector: "taller"',
          "idioma: es-ES",
          "zona_horaria: Europe/Madrid",
          'telefono: { mostrar: "910 00 00 00", e164: "+34910000000" }',
          "duracion_cita_min: 60",
          'servicios: [{ id: "5", nombre: "Cambio de aceite", duracion_min: 60 }]',
          "empleados: [{ nombre: Ane, calendario: 7 }]",
          'calendario: { provider: google-calendar, empleado_por_defecto: 7, servicio_por_defecto: "5" }',
          "",
        ].join("\n"),
      );
      process.env.CLIENT_CONFIG_PATH = path;
      resetClientConfigForTests();
      expect(loadEnv().WHATSAPP_TEMPLATE_NAME).toBe("");
      resetEnvCache();
      process.env.WHATSAPP_NOTIFICATIONS_MODE = "dry_run";
      process.env.WHATSAPP_QUEUE_PATH = join(dir, "queue.json");
      expect(() => loadEnv()).toThrow(/WHATSAPP_TEMPLATE_NAME/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
