import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clientAddress,
  clientSlug,
  closedWeekdaysCsv,
  defaultEmployee,
  earlyCloseCsv,
  getClientConfig,
  loadClientConfigFrom,
  resetClientConfigForTests,
  resolveClientConfigPath,
} from "../src/core/config/clientConfig.js";
import { loadEnv, resetEnvCache } from "../src/config/env.js";
import { madridDate, madridHour, madridWallClock } from "../src/utils/madridDate.js";
import {
  CALENDAR_PRODID,
  CALENDAR_UID_DOMAIN,
  SALON_NAME,
  SALON_PHONE_DISPLAY,
  calendarUid,
} from "../src/services/whatsapp/calendarEvent.js";
import { CALENDAR_DEFAULT_DURATION_MINUTES } from "../src/services/whatsapp/calendarLink.js";

/**
 * Fase 2, primer tramo (D-007/D-008): los datos de negocio de Demo Salon salen de
 * `clientes/demo-salon/cliente.yaml` y deben reproducir EXACTAMENTE los valores que
 * antes estaban escritos en el código (v0.2.0). Cada aserción cita el valor viejo.
 */

const ENV_KEYS = [
  "CLIENT_ID",
  "CLIENT_CONFIG_PATH",
  "BALANCED_CLOSED_WEEKDAYS",
  "BALANCED_EARLY_CLOSE",
  "VOICE_BOOKING_DISPLAY_PREFIX",
  "VOICE_BOOKING_DISPLAY_SEPARATOR",
  "BOOKING_DEFAULT_EMPLOYEE_ID",
  "BOOKING_DEFAULT_TYPE_RESERVATION",
  "RECADOS_HOURS_SERVICE_ID",
  "RECADOS_APPOINTMENT_MINUTES",
  "WHATSAPP_CALENDAR_LOCATION",
  "BOOKING_USERNAME",
  "BOOKING_PASSWORD",
  "AI_WEBHOOK_SECRET",
] as const;

const REPO = fileURLToPath(new URL("..", import.meta.url));

let saved: Record<string, string | undefined> = {};
let tempDir: string | undefined;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.BOOKING_USERNAME = "test-user";
  process.env.BOOKING_PASSWORD = "test-pass";
  process.env.AI_WEBHOOK_SECRET = "x".repeat(32);
  resetClientConfigForTests();
  resetEnvCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  resetClientConfigForTests();
  resetEnvCache();
});

function writeTempYaml(content: string): string {
  tempDir = mkdtempSync(join(tmpdir(), "cliente-yaml-"));
  const path = join(tempDir, "cliente.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

const OTRO_CLIENTE = `
nombre: "Clínica Ñandú"
sector: clínica
idioma: es-ES
zona_horaria: America/New_York
telefono: { mostrar: "900 000 000", e164: "+34900000000" }
direccion: "Calle Falsa 1, Ciudad"
horario:
  lunes: ["09:00-14:00"]
  sabado: []
  domingo: []
duracion_cita_min: 45
servicios: [{ id: "7", nombre: "Consulta", duracion_min: 45 }]
empleados: [{ nombre: "Ana", calendario: 9 }]
calendario: { provider: memory, empleado_por_defecto: 9, servicio_por_defecto: "7" }
`;

describe("cliente.yaml de Demo Salon = valores antes fijos en el código", () => {
  it("se carga por defecto (CLIENT_ID=demo-salon) desde clientes/demo-salon/cliente.yaml", () => {
    expect(resolveClientConfigPath({})).toBe(resolve(REPO, "clientes", "demo-salon", "cliente.yaml"));
    const cfg = getClientConfig();
    expect(cfg.nombre).toBe("Demo Salon");
    expect(cfg.idioma).toBe("es-ES");
    expect(cfg.zona_horaria).toBe("Europe/Madrid");
    expect(cfg.calendario.provider).toBe("memory");
  });

  it("derivados: cierres '0,1', cierre temprano '6=14:00', empleado 1 «Bruno»/«Demo», sin dirección", () => {
    const cfg = getClientConfig();
    expect(closedWeekdaysCsv(cfg)).toBe("0,1");
    expect(earlyCloseCsv(cfg)).toBe("6=14:00");
    expect(cfg.calendario.empleado_por_defecto).toBe(1);
    expect(cfg.calendario.servicio_por_defecto).toBe("1");
    const bruno = defaultEmployee(cfg);
    expect(bruno?.nombre_agenda).toBe("Bruno");
    expect(bruno?.apellidos_agenda).toBe("Demo");
    expect(cfg.marca_ia).toEqual({ prefijo: "IA -", separador: "space" });
    expect(cfg.duracion_cita_min).toBe(30);
    expect(clientAddress(cfg)).toBeUndefined();
  });

  it("los valores por defecto de env.ts no cambian (antes literales en el esquema)", () => {
    const env = loadEnv();
    expect(env.BALANCED_CLOSED_WEEKDAYS).toEqual(new Set([0, 1]));
    expect(env.BALANCED_EARLY_CLOSE).toEqual(new Map([[6, 14 * 60]]));
    expect(env.VOICE_BOOKING_DISPLAY_PREFIX).toBe("IA -");
    expect(env.VOICE_BOOKING_DISPLAY_SEPARATOR).toBe("space");
    expect(env.BOOKING_DEFAULT_EMPLOYEE_ID).toBe(1);
    expect(env.BOOKING_DEFAULT_TYPE_RESERVATION).toBe("1");
    expect(env.RECADOS_HOURS_SERVICE_ID).toBe("1");
    expect(env.RECADOS_APPOINTMENT_MINUTES).toBe(30);
    expect(env.WHATSAPP_CALENDAR_LOCATION).toBeUndefined();
  });

  it("calendario: nombre, teléfono, PRODID, dominio del UID y duración idénticos", () => {
    expect(SALON_NAME).toBe("Demo Salon");
    expect(SALON_PHONE_DISPLAY).toBe("910 00 00 25");
    expect(CALENDAR_PRODID).toBe("-//Demo Salon//Reservas//ES");
    expect(CALENDAR_UID_DOMAIN).toBe("demo-salon");
    expect(calendarUid("abc")).toMatch(/^[0-9a-f]{32}@demo-salon$/);
    expect(CALENDAR_DEFAULT_DURATION_MINUTES).toBe(30);
  });

  it("madridDate/madridHour/madridWallClock siguen siendo Europe/Madrid", () => {
    const fixed = (ms: number) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(
        new Date(ms),
      );
    // 2026-07-14 22:30 UTC = 15 julio 00:30 en Madrid (verano); 2026-01-14 23:30 UTC = 15 enero 00:30 (invierno).
    for (const ms of [Date.UTC(2026, 6, 14, 22, 30), Date.UTC(2026, 0, 14, 23, 30)]) {
      expect(madridDate(ms)).toBe(fixed(ms));
    }
    expect(madridWallClock(Date.UTC(2026, 6, 14, 22, 30))).toBe("2026-07-15 00:30");
    expect(madridHour(Date.UTC(2026, 0, 14, 23, 30))).toBe(0);
  });
});

describe("precedencia: variable de entorno > cliente.yaml > código", () => {
  it("una variable de entorno definida gana al YAML", () => {
    process.env.BALANCED_CLOSED_WEEKDAYS = "2";
    process.env.BALANCED_EARLY_CLOSE = "";
    process.env.VOICE_BOOKING_DISPLAY_PREFIX = "";
    process.env.BOOKING_DEFAULT_EMPLOYEE_ID = "3";
    process.env.RECADOS_APPOINTMENT_MINUTES = "45";
    const env = loadEnv();
    expect(env.BALANCED_CLOSED_WEEKDAYS).toEqual(new Set([2]));
    expect(env.BALANCED_EARLY_CLOSE).toEqual(new Map());
    expect(env.VOICE_BOOKING_DISPLAY_PREFIX).toBe("");
    expect(env.BOOKING_DEFAULT_EMPLOYEE_ID).toBe(3);
    expect(env.RECADOS_APPOINTMENT_MINUTES).toBe(45);
  });

  it("CLIENT_CONFIG_PATH carga otro cliente: valores del YAML y, si faltan, los del código", () => {
    process.env.CLIENT_CONFIG_PATH = writeTempYaml(OTRO_CLIENTE);
    const cfg = getClientConfig();
    expect(cfg.nombre).toBe("Clínica Ñandú");
    expect(clientSlug(cfg)).toBe("clinica-nandu");
    expect(clientAddress(cfg)).toBe("Calle Falsa 1, Ciudad");
    const env = loadEnv();
    expect(env.BALANCED_CLOSED_WEEKDAYS).toEqual(new Set([0, 6])); // deducido de horario
    expect(env.BALANCED_EARLY_CLOSE).toEqual(new Map()); // sin cierre_temprano
    expect(env.VOICE_BOOKING_DISPLAY_PREFIX).toBe("IA -"); // valor del código
    expect(env.BOOKING_DEFAULT_EMPLOYEE_ID).toBe(9);
    expect(env.BOOKING_DEFAULT_TYPE_RESERVATION).toBe("7");
    expect(env.RECADOS_APPOINTMENT_MINUTES).toBe(45);
    // La zona horaria del cliente manda en madridDate: 22:30 UTC del 14 de julio sigue siendo día 14 en Nueva York.
    expect(madridDate(Date.UTC(2026, 6, 14, 22, 30))).toBe("2026-07-14");
  });
});

describe("validación del cliente.yaml", () => {
  it("la plantilla clientes/_plantilla/cliente.yaml cumple el esquema", () => {
    const cfg = loadClientConfigFrom(resolve(REPO, "clientes", "_plantilla", "cliente.yaml"));
    expect(closedWeekdaysCsv(cfg)).toBe("0");
    expect(earlyCloseCsv(cfg)).toBe("6=14:00");
  });

  it("CLIENT_ID con ruta se rechaza", () => {
    expect(() => resolveClientConfigPath({ CLIENT_ID: "../etc" })).toThrow(/CLIENT_ID inválido/);
  });

  it("un cliente inexistente falla en voz alta", () => {
    process.env.CLIENT_ID = "no-existe";
    expect(() => getClientConfig()).toThrow(/No se puede leer la configuración de cliente/);
  });

  it("un campo inválido se nombra en el error", () => {
    const badZone = writeTempYaml(OTRO_CLIENTE.replace("America/New_York", "Marte/Olympus"));
    expect(() => loadClientConfigFrom(badZone)).toThrow(/zona_horaria/);
    rmSync(tempDir!, { recursive: true, force: true });
    const badEmployee = writeTempYaml(OTRO_CLIENTE.replace("empleado_por_defecto: 9", "empleado_por_defecto: 10"));
    expect(() => loadClientConfigFrom(badEmployee)).toThrow(/calendario\.empleado_por_defecto/);
  });

  it("una clave desconocida se rechaza (erratas)", () => {
    const path = writeTempYaml(`${OTRO_CLIENTE}\nzona_horara: Europe/Madrid\n`);
    expect(() => loadClientConfigFrom(path)).toThrow(/cliente\.yaml inválido/);
  });
});
