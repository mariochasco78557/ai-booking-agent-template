import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * *** CONFIGURACIÓN DEL CLIENTE — `clientes/<id>/cliente.yaml`. ***
 *
 * Datos de negocio de UN cliente (nombre, teléfono, zona horaria, días de
 * cierre, empleados, servicios, duración de cita, marca IA...) fuera del
 * código (fase 2 de (internal doc, not included in the template), decisiones D-007 y D-008).
 *
 * Qué fichero se carga:
 * - `CLIENT_CONFIG_PATH` (ruta absoluta, o relativa al directorio de trabajo), si está;
 * - si no, `clientes/<CLIENT_ID>/cliente.yaml` desde la raíz del repo,
 *   con `CLIENT_ID` por defecto `demo-salon`.
 *
 * Precedencia (D-007): **variable de entorno > cliente.yaml > valor por defecto del código**.
 * Las variables de entorno que ya existían (p. ej. `BALANCED_CLOSED_WEEKDAYS`)
 * siguen ganando: este fichero solo sustituye a los valores por defecto que antes
 * estaban escritos a mano en `src/config/env.ts` y en otros módulos.
 *
 * Falla en voz alta: un fichero ausente o inválido lanza un error con la ruta y
 * los campos erróneos (sin valores; de todas formas el YAML no lleva secretos).
 */

/** Días en el orden de `Date#getUTCDay()`: 0 = domingo ... 6 = sábado. */
export const DIAS_SEMANA = [
  "domingo",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
] as const;
export type DiaSemana = (typeof DIAS_SEMANA)[number];

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FRANJA_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_ID_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/;

const diaSchema = z.enum(DIAS_SEMANA);

const zonaHorariaSchema = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "zona_horaria debe ser una zona del tz database válida, p. ej. Europe/Madrid");

const horarioSchema = z
  .object(
    Object.fromEntries(
      DIAS_SEMANA.map((dia) => [dia, z.array(z.string().regex(FRANJA_RE, "franja HH:MM-HH:MM")).optional()]),
    ) as Record<DiaSemana, z.ZodOptional<z.ZodArray<z.ZodString>>>,
  )
  .strict();

const empleadoSchema = z
  .object({
    nombre: z.string().min(1),
    /** Id del empleado en el calendario (Demo Salon: id numérico; Google: id de calendario). */
    calendario: z.union([z.string().min(1), z.number().int().positive()]),
    /**
     * Id numérico del empleado en el núcleo (opcional). Si falta: `calendario` si es
     * numérico (Demo Salon) o la posición 1..n en la lista (Google). Ver {@link employeeResourceId}.
     */
    id: z.number().int().positive().optional(),
    /** Nombre/apellidos tal y como los guarda la agenda (pueden llevar espacios finales). */
    nombre_agenda: z.string().optional(),
    apellidos_agenda: z.string().optional(),
  })
  .strict();

const servicioSchema = z
  .object({
    /** Id del servicio en el calendario (Demo Salon: `type_reservation`). */
    id: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    nombre: z.string().min(1),
    duracion_min: z.number().int().positive(),
    precio: z.number().nonnegative().optional(),
    /**
     * Cómo se dice el servicio en los textos (D-010). `voz`: en frases al cliente
     * (por defecto `nombre` en minúsculas); `corta`: en los avisos de agenda al
     * dueño (por defecto, la de voz).
     */
    etiquetas: z
      .object({ voz: z.string().min(1).optional(), corta: z.string().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Sector: forma corta (`"peluquería"`) o larga, con las palabras que usan los
 * textos (D-010): `negocio` = el negocio en tercera persona con artículo
 * («la peluquería», «el taller»; por defecto «el negocio»); `palabra_empleado`
 * = cómo se llama a un profesional («peluquero», «mecánico»).
 */
const sectorSchema = z.union([
  z.string().min(1),
  z
    .object({
      nombre: z.string().min(1),
      negocio: z.string().min(1).max(60).optional(),
      palabra_empleado: z.string().min(1).max(30).optional(),
    })
    .strict(),
]);

export const clientConfigSchema = z
  .object({
    nombre: z.string().min(1).max(60),
    /** Nombre corto del negocio en los textos («el equipo de X»); por defecto `nombre`. */
    nombre_corto: z.string().min(1).max(40).optional(),
    sector: sectorSchema,
    /** Quien recibe recados y avisos en los textos; por defecto el empleado por defecto (o el primero). */
    responsable: z.string().min(1).max(40).optional(),
    idioma: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "idioma tipo es-ES"),
    zona_horaria: zonaHorariaSchema,
    telefono: z
      .object({
        mostrar: z.string().min(1).max(30),
        e164: z.string().regex(/^\+\d{6,15}$/, "telefono.e164 tipo +34910000000"),
      })
      .strict(),
    /** Dirección en una línea; opcional. Respaldo de `WHATSAPP_CALENDAR_LOCATION`. */
    direccion: z
      .string()
      .max(200)
      // eslint-disable-next-line no-control-regex
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "direccion debe ser una sola línea")
      .optional(),
    /** Enlaces públicos del negocio (informativos; ninguno activa nada por sí solo). */
    enlaces: z.record(z.string(), z.string().url()).optional(),
    horario: horarioSchema.optional(),
    /**
     * Días de cierre semanal. Si falta, se deducen de `horario` (días con lista vacía).
     * Respaldo de `BALANCED_CLOSED_WEEKDAYS`.
     */
    dias_cerrados: z.array(diaSchema).optional(),
    /** Cierre temprano por día (`sabado: "14:00"`). Respaldo de `BALANCED_EARLY_CLOSE`. */
    cierre_temprano: z.record(diaSchema, z.string().regex(HORA_RE, "hora HH:MM")).optional(),
    cierres: z
      .array(
        z
          .object({
            desde: z.string().regex(FECHA_RE),
            hasta: z.string().regex(FECHA_RE),
            motivo: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    /** Duración de una cita en minutos (enlace de calendario y ventanas de recados). */
    duracion_cita_min: z.number().int().min(10).max(120),
    servicios: z.array(servicioSchema).min(1),
    empleados: z.array(empleadoSchema).min(1),
    tono: z.string().optional(),
    canales: z.object({ whatsapp: z.boolean(), voz: z.boolean() }).strict().optional(),
    /**
     * Plantilla aprobada de WhatsApp para la confirmación de cita (D-012).
     * Respaldo de `WHATSAPP_TEMPLATE_NAME`; si faltan las dos, el arranque solo
     * falla con `WHATSAPP_NOTIFICATIONS_MODE` distinto de `off`.
     */
    plantilla_whatsapp: z.string().min(1).max(512).optional(),
    calendario: z
      .object({
        provider: z.enum(["memory", "google-calendar"]),
        /** Respaldo de `BOOKING_DEFAULT_EMPLOYEE_ID`; debe ser uno de `empleados[].calendario`. */
        empleado_por_defecto: z.union([z.string().min(1), z.number().int().positive()]).optional(),
        /** Respaldo de `BOOKING_DEFAULT_TYPE_RESERVATION` y `RECADOS_HOURS_SERVICE_ID`. */
        servicio_por_defecto: z.string().regex(/^\d+$/).optional(),
        /** Solo `google-calendar` (D-014). */
        google: z
          .object({
            /** Un único calendario para todo el negocio; el empleado va en el evento. */
            calendario_unico: z.string().min(1).optional(),
            /** Minutos entre inicios de hueco; por defecto `duracion_cita_min`. */
            paso_min: z.number().int().min(5).max(240).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** Marca que se antepone al nombre en las citas creadas por voz (ADR-012). */
    marca_ia: z
      .object({
        prefijo: z.string().max(16).default("IA -"),
        separador: z.enum(["space", "none"]).default("space"),
      })
      .strict()
      .default({}),
    limites: z.record(z.string(), z.number()).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const defecto = cfg.calendario.empleado_por_defecto;
    if (defecto !== undefined && findEmployee(cfg.empleados, defecto) === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calendario", "empleado_por_defecto"],
        message: "empleado_por_defecto debe coincidir con el campo calendario de algún empleado",
      });
    }
  });

export type ClientConfig = z.infer<typeof clientConfigSchema>;
type Empleado = ClientConfig["empleados"][number];

/** Empleado cuyo `calendario` (o, si no, `id`) coincide con `ref`. */
function findEmployee(empleados: readonly Empleado[], ref: string | number): Empleado | undefined {
  return (
    empleados.find((e) => String(e.calendario) === String(ref)) ??
    empleados.find((e) => e.id !== undefined && String(e.id) === String(ref))
  );
}

/**
 * Id numérico del empleado en el núcleo (recurso del puerto): `id` si está;
 * si no, `calendario` cuando es numérico (Demo Salon: id de empleado); si no
 * (Google: id de calendario), su posición 1..n en `empleados`.
 */
export function employeeResourceId(empleado: Empleado, index: number): number {
  if (empleado.id !== undefined) return empleado.id;
  if (typeof empleado.calendario === "number") return empleado.calendario;
  if (/^\d+$/.test(empleado.calendario)) return Number(empleado.calendario);
  return index + 1;
}

/**
 * Id numérico del empleado por defecto (respaldo de `BOOKING_DEFAULT_EMPLOYEE_ID`).
 * Demo Salon: el mismo `Number(empleado_por_defecto)` de siempre (1). Sin empleado
 * por defecto: `NaN` (la variable de entorno pasa a ser obligatoria, como antes).
 */
export function defaultEmployeeResourceId(cfg: ClientConfig): number {
  const ref = cfg.calendario.empleado_por_defecto;
  if (ref === undefined) return Number(ref);
  const asNumber = Number(ref);
  if (Number.isInteger(asNumber) && asNumber > 0) return asNumber;
  const index = cfg.empleados.findIndex((e) => e === findEmployee(cfg.empleados, ref));
  return index < 0 ? Number.NaN : employeeResourceId(cfg.empleados[index]!, index);
}

/** Raíz del repo: este fichero vive en `src/core/config/` (o `dist/core/config/`). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const DEFAULT_CLIENT_ID = "demo-salon";

/** Ruta del `cliente.yaml` que toca cargar según el entorno. */
export function resolveClientConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.CLIENT_CONFIG_PATH?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  const id = environment.CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
  if (!CLIENT_ID_RE.test(id)) {
    throw new Error("CLIENT_ID inválido: solo minúsculas, dígitos, '-' y '_' (sin rutas)");
  }
  return resolve(REPO_ROOT, "clientes", id, "cliente.yaml");
}

/** Lee, parsea y valida un `cliente.yaml`. Sin caché. */
export function loadClientConfigFrom(path: string): ClientConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No se puede leer la configuración de cliente: ${path} (revisa CLIENT_ID / CLIENT_CONFIG_PATH)`);
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (error) {
    throw new Error(`cliente.yaml con YAML inválido: ${path}: ${(error as Error).message}`);
  }
  const parsed = clientConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(raíz)"}: ${i.message}`).join("\n");
    throw new Error(`cliente.yaml inválido (${path}):\n${issues}`);
  }
  return parsed.data;
}

let cached: ClientConfig | null = null;

/** Configuración del cliente activo (cargada una vez por proceso). */
export function getClientConfig(): ClientConfig {
  if (cached === null) cached = loadClientConfigFrom(resolveClientConfigPath());
  return cached;
}

/** Solo tests: olvida la configuración cacheada para recargar con otro entorno. */
export function resetClientConfigForTests(): void {
  cached = null;
}

// ── Derivados que consumen `env.ts` y los módulos ────────────────────────────

/** `direccion` del cliente, o `undefined` si falta o está en blanco. */
export function clientAddress(cfg: ClientConfig): string | undefined {
  const value = cfg.direccion?.trim();
  return value ? value : undefined;
}

/** Zona horaria del tz database del negocio. */
export function clientTimeZone(): string {
  return getClientConfig().zona_horaria;
}

/** Números de día cerrados (0 = domingo), de `dias_cerrados` o, si falta, de `horario`. */
export function closedWeekdayNumbers(cfg: ClientConfig): number[] {
  if (cfg.dias_cerrados !== undefined) {
    return [...new Set(cfg.dias_cerrados.map((dia) => DIAS_SEMANA.indexOf(dia)))].sort((a, b) => a - b);
  }
  if (cfg.horario === undefined) return [];
  const horario = cfg.horario;
  return DIAS_SEMANA.flatMap((dia, index) => {
    const franjas = horario[dia];
    return franjas !== undefined && franjas.length === 0 ? [index] : [];
  });
}

/** `dias_cerrados` en el formato CSV de `BALANCED_CLOSED_WEEKDAYS` (`"0,1"`). */
export function closedWeekdaysCsv(cfg: ClientConfig): string {
  return closedWeekdayNumbers(cfg).join(",");
}

/** `cierre_temprano` en el formato CSV de `BALANCED_EARLY_CLOSE` (`"6=14:00"`); `""` si no hay. */
export function earlyCloseCsv(cfg: ClientConfig): string {
  const entries = cfg.cierre_temprano ?? {};
  return DIAS_SEMANA.flatMap((dia, index) => {
    const hora = entries[dia];
    return hora === undefined ? [] : [`${index}=${hora}`];
  }).join(",");
}

/** El empleado por defecto (el de `calendario.empleado_por_defecto`), si está configurado. */
export function defaultEmployee(cfg: ClientConfig): ClientConfig["empleados"][number] | undefined {
  const id = cfg.calendario.empleado_por_defecto;
  if (id === undefined) return undefined;
  return findEmployee(cfg.empleados, id);
}

/**
 * Identificador en minúsculas y con guiones del nombre del negocio, sin
 * acentos: `"Demo Salon"` → `"demo-salon"`. Se usa como dominio
 * del UID de los eventos de calendario.
 */
export function clientSlug(cfg: ClientConfig): string {
  return cfg.nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
