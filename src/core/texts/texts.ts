import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type ClientConfig,
  DIAS_SEMANA,
  closedWeekdayNumbers,
  defaultEmployee,
  getClientConfig,
  resolveClientConfigPath,
} from "../config/clientConfig.js";
import { DEFAULT_TEXTS_ES, type TextKey } from "./defaultTexts.es.js";

export { DEFAULT_TEXTS_ES, type TextKey } from "./defaultTexts.es.js";

/**
 * *** CAPA DE TEXTOS (D-010). ***
 *
 * Plantilla final de cada clave = `defaultTexts.es.ts` ← `clientes/<id>/textos.yaml`
 * (opcional, junto al `cliente.yaml` cargado). Los marcadores `{x}` se rellenan
 * con datos de `cliente.yaml` ({@link clientPlaceholders}) y, en las frases con
 * día u hora, con los valores de ejecución que pasa quien llama.
 * Hoy no existe ninguna variable de entorno de textos, así que no hay capa env.
 *
 * Falla en voz alta, como `cliente.yaml`: una clave desconocida o un marcador que
 * esa clave no admite en `textos.yaml` impiden arrancar.
 */

export type Placeholders = Readonly<Record<string, string>>;
export type ServiceLabelUse = "nombre" | "voz" | "corta";

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Día de `DIAS_SEMANA` → forma plural con artículo. */
const DIA_PLURAL: Record<(typeof DIAS_SEMANA)[number], string> = {
  domingo: "los domingos",
  lunes: "los lunes",
  martes: "los martes",
  miercoles: "los miércoles",
  jueves: "los jueves",
  viernes: "los viernes",
  sabado: "los sábados",
};

function joinEs(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `sector` admite la forma corta (texto) o la larga (objeto). */
function sectorOf(cfg: ClientConfig): { nombre: string; negocio?: string; palabra_empleado?: string } {
  return typeof cfg.sector === "string" ? { nombre: cfg.sector } : cfg.sector;
}

/** Valores de los marcadores que salen de `cliente.yaml`. */
export function clientPlaceholders(cfg: ClientConfig): Placeholders {
  const sector = sectorOf(cfg);
  const negocio = sector.negocio?.trim() || "el negocio";
  const aNegocio = /^el /i.test(negocio) ? `al ${negocio.slice(3)}` : `a ${negocio}`;
  const deNegocio = /^el /i.test(negocio) ? `del ${negocio.slice(3)}` : `de ${negocio}`;
  // En el orden en que los escribe `dias_cerrados` («domingo, lunes»); si falta, el de `horario`.
  const closedDays = cfg.dias_cerrados ? [...new Set(cfg.dias_cerrados)] : closedWeekdayNumbers(cfg).map((n) => DIAS_SEMANA[n]!);
  const closed = closedDays.map((dia) => DIA_PLURAL[dia]);
  return {
    salon: cfg.nombre,
    marca: cfg.nombre_corto ?? cfg.nombre,
    telefono: cfg.telefono.mostrar,
    telefono_e164: cfg.telefono.e164,
    responsable: cfg.responsable ?? defaultEmployee(cfg)?.nombre ?? cfg.empleados[0]!.nombre,
    negocio,
    a_negocio: aNegocio,
    de_negocio: deNegocio,
    cerrado: /^la /i.test(negocio) ? "cerrada" : "cerrado",
    sector: sector.nombre,
    palabra_empleado: sector.palabra_empleado ?? "profesional",
    dias_cerrados: closed.length > 0 ? joinEs(closed) : "ese día",
  };
}

/**
 * Rellena `{x}` con `values[x]`; `{X}` (primera letra mayúscula) con el valor
 * de `x` en mayúscula inicial. Un marcador sin valor se deja tal cual.
 */
export function renderTemplate(template: string, values: Placeholders): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name]!;
    const lower = name.charAt(0).toLowerCase() + name.slice(1);
    if (lower !== name && Object.prototype.hasOwnProperty.call(values, lower)) return capitalizeFirst(values[lower]!);
    return whole;
  });
}

function placeholderNames(template: string): Set<string> {
  return new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1)));
}

/** Ruta de `textos.yaml`: junto al `cliente.yaml` activo. */
export function resolveTextOverridesPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(resolveClientConfigPath(environment)), "textos.yaml");
}

/**
 * Lee y valida un `textos.yaml`. Fichero ausente o vacío = sin cambios.
 * Cada clave debe existir en los textos por defecto y cada marcador debe ser
 * de cliente o uno de los que ya usa el texto por defecto de esa clave.
 */
export function loadTextOverridesFrom(path: string, clientKeys: Iterable<string>): Partial<Record<TextKey, string>> {
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`textos.yaml con YAML inválido: ${path}: ${(error as Error).message}`);
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`textos.yaml inválido (${path}): debe ser un mapa clave: texto`);
  }
  const client = new Set(clientKeys);
  const problems: string[] = [];
  const out: Partial<Record<TextKey, string>> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TEXTS_ES, key)) {
      problems.push(`  - ${key}: clave desconocida`);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`  - ${key}: debe ser un texto no vacío`);
      continue;
    }
    const allowed = placeholderNames(DEFAULT_TEXTS_ES[key as TextKey]);
    const bad = [...placeholderNames(value)].filter((name) => !client.has(name) && !allowed.has(name));
    if (bad.length > 0) {
      problems.push(`  - ${key}: marcador no admitido {${bad.join("}, {")}}`);
      continue;
    }
    out[key as TextKey] = value;
  }
  if (problems.length > 0) throw new Error(`textos.yaml inválido (${path}):\n${problems.join("\n")}`);
  return out;
}

interface TextContext {
  templates: Record<TextKey, string>;
  placeholders: Placeholders;
  serviceLabels: Map<string, Record<ServiceLabelUse, string>>;
}

/** Arma plantillas, marcadores y etiquetas de servicio de una configuración. */
export function buildTextContext(cfg: ClientConfig, overrides: Partial<Record<TextKey, string>>): TextContext {
  const serviceLabels = new Map<string, Record<ServiceLabelUse, string>>();
  for (const s of cfg.servicios) {
    if (s.id === undefined) continue;
    const voz = s.etiquetas?.voz ?? s.nombre.toLowerCase();
    serviceLabels.set(String(s.id), { nombre: s.nombre, voz, corta: s.etiquetas?.corta ?? voz });
  }
  return {
    templates: { ...DEFAULT_TEXTS_ES, ...overrides },
    placeholders: clientPlaceholders(cfg),
    serviceLabels,
  };
}

let cached: TextContext | null = null;

function context(): TextContext {
  if (cached === null) {
    const cfg = getClientConfig();
    const placeholders = clientPlaceholders(cfg);
    cached = buildTextContext(cfg, loadTextOverridesFrom(resolveTextOverridesPath(), Object.keys(placeholders)));
  }
  return cached;
}

/** Texto de una clave para el cliente activo; `vars` aporta los marcadores de ejecución. */
export function t(key: TextKey, vars: Placeholders = {}): string {
  const ctx = context();
  return renderTemplate(ctx.templates[key], { ...ctx.placeholders, ...vars });
}

/** Todos los textos del cliente activo con los marcadores de cliente ya puestos. */
export function getTexts(): Record<TextKey, string> {
  const ctx = context();
  return Object.fromEntries(
    Object.entries(ctx.templates).map(([key, template]) => [key, renderTemplate(template, ctx.placeholders)]),
  ) as Record<TextKey, string>;
}

/** Valores de los marcadores del cliente activo (p. ej. `negocio` para un léxico). */
export function getPlaceholders(): Placeholders {
  return context().placeholders;
}

/**
 * Cómo se dice un servicio (por su id de `servicios[]`): `nombre` = el `nombre`
 * tal cual (etiqueta de catálogo, «Corte de pelo»); `voz` = `etiquetas.voz`
 * o el nombre en minúsculas; `corta` = `etiquetas.corta` o la de voz.
 * `undefined` si el id no está configurado.
 */
export function serviceLabel(id: number | string | null | undefined, use: ServiceLabelUse): string | undefined {
  if (id === null || id === undefined) return undefined;
  return context().serviceLabels.get(String(id))?.[use];
}

/** Solo tests: olvida los textos cacheados. */
export function resetTextsForTests(): void {
  cached = null;
}
