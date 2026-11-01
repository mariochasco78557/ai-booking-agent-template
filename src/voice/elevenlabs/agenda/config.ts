import { z } from "zod";

/**
 * ────────────────────────────────────────────────────────────────────────
 * CONFIGURACIÓN DEL MODO real_readonly (puerta E5, MITAD DE LECTURA).
 *
 * Módulo aparte y deliberadamente desacoplado de `src/config/env.ts`. Ese
 * archivo llama a `dotenv.config()` al importarse y exige el juego completo
 * de variables del middleware histórico (AI_WEBHOOK_SECRET incluido), de
 * modo que importarlo aquí ataría el arranque del puente de voz a un
 * middleware que no usa y leería un `.env` que no es suyo. Se conservan sus
 * CONVENCIONES —los mismos nombres `BOOKING_*`, el mismo estilo de fallar
 * cerrado nombrando la variable y nunca su valor— sin heredar su carga.
 *
 * Reglas duras que este archivo hace cumplir, no sólo documenta:
 *   · `real_readonly` es opt-in explícito; por defecto se sirve `synthetic`.
 *   · sin credenciales completas NO se arranca en real: se lanza un error
 *     que las nombra. Jamás se degrada en silencio a sintético, porque un
 *     operador que pidió agenda real y recibe fixture sin enterarse es
 *     exactamente el fallo que este modo tiene que hacer imposible.
 *   · `BOOKING_REMEMBER_ME=true` es un rechazo, no un aviso: ese token vive
 *     un año (internal doc, not included in the template) y aquí se fuerza siempre `false`.
 *   · `ENABLE_WRITE_OPERATIONS=true` es un rechazo: este puente no arranca
 *     en un entorno donde las escrituras del middleware estén abiertas.
 *   · la autorización humana es una variable con firma, al estilo de
 *     `AI_CALLER_ID_PROVIDER_ATTESTED`/`_ATTESTATION_REF` en env.ts.
 * ────────────────────────────────────────────────────────────────────────
 */

export const ELEVENLABS_BRIDGE_AGENDA_MODES = ["synthetic", "real_readonly"] as const;
export type ElevenLabsBridgeAgendaMode = (typeof ELEVENLABS_BRIDGE_AGENDA_MODES)[number];

export const DEFAULT_AGENDA_TIMEOUT_MS = 4000;

/**
 * ─── CONTRATO DE ZONA HORARIA Y HORIZONTE DE CONSULTA ───────────────────
 *
 * ZONA HORARIA: **Europe/Madrid**, y wall-clock, no instantes UTC. El «hoy»
 * del modo real_readonly lo calcula `agenda/madridClock.ts` con `Intl` en esa
 * zona y NUNCA con la del servidor: un VPS en UTC atrasaría la agenda una o
 * dos horas según la estación, y a las 00:30 de Madrid en verano contestaría
 * sobre el día anterior. El upstream Symfony habla ese mismo wall-clock
 * ("YYYY-MM-DD HH:mm:ss", sin zona), así que no hay conversión en ningún
 * punto: se compara Madrid con Madrid.
 *
 * HORIZONTE: se cuenta en DÍAS NATURALES desde ese «hoy» de Madrid y es
 * INCLUSIVO por los dos extremos. `horizonDays = 6` significa la ventana
 * `[hoy, hoy+6]`, es decir siete días — exactamente los mismos que ya admite
 * el modo sintético (`MAX_WINDOW_OFFSET_DAYS` en `server.ts`), para que las
 * dos agendas no discrepen sobre qué es «la semana». Una fecha por debajo de
 * `hoy` (pasado) o por encima de `hoy + horizonDays` se rechaza con un 422
 * controlado; el puente NO consulta el upstream para una fecha que ya sabe
 * que no puede atender.
 *
 * Configurable con `ELEVENLABS_BRIDGE_AGENDA_HORIZON_DAYS` entre 0 y 30. El
 * 0 es legítimo y significa «sólo hoy»; el techo de 30 evita que un dedo de
 * más convierta una llamada telefónica en un barrido de meses de agenda, a
 * un `getEmployeesDay` + N `getFree` por día.
 * ────────────────────────────────────────────────────────────────────────
 */
export const DEFAULT_AGENDA_HORIZON_DAYS = 6;
/** Único `type` observado en el contrato Symfony (internal doc, not included in the template). */
export const DEFAULT_AGENDA_TYPE_RESERVATION = "1";

/** En blanco o ausente es «sin configurar», nunca la cadena vacía. */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

const modeSchema = z
  .string()
  .optional()
  .transform((value) => optionalText(value) ?? "synthetic")
  .pipe(z.enum(ELEVENLABS_BRIDGE_AGENDA_MODES));

/**
 * Qué agenda pide el operador. Se resuelve sola, sin credenciales y sin
 * lanzar: el arranque necesita saber en qué modo va antes de exigir nada.
 */
export function loadElevenLabsBridgeAgendaMode(env: NodeJS.ProcessEnv = process.env): ElevenLabsBridgeAgendaMode {
  const parsed = modeSchema.safeParse(env.ELEVENLABS_BRIDGE_AGENDA_MODE);
  if (!parsed.success) {
    throw new Error(
      `ELEVENLABS_BRIDGE_AGENDA_MODE sólo admite ${ELEVENLABS_BRIDGE_AGENDA_MODES.join(" o ")}. ` +
        "Sin configurar, el puente sirve la agenda sintética.",
    );
  }
  return parsed.data;
}

const positiveIntList = z
  .string()
  .transform((value) => value.split(",").map((piece) => piece.trim()))
  .pipe(z.array(z.string().regex(/^\d+$/, "debe ser una lista de ids numéricos separados por comas")).min(1))
  .transform((pieces) => pieces.map((piece) => Number.parseInt(piece, 10)))
  .pipe(z.array(z.number().int().positive()).min(1));

/** Sin resolución de DNS: sólo lo que dice el texto de la URL. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * La URL base no puede llevar credenciales, ni query, ni fragmento. Un
 * `https://usuario:clave@host/v1` metería una contraseña dentro de un campo
 * que sí se imprime en claro (`toJSON()` conserva `baseUrl`, y axios la
 * arrastra a cada petición), y un token en la query acabaría en los logs del
 * intermediario que sea. Se rechaza en el arranque en vez de redactarlo
 * después: lo que no entra no hay que acordarse de tapar.
 */
function baseUrlHasNoEmbeddedSecrets(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

/**
 * TLS obligatorio salvo contra loopback. Este modo manda usuario y
 * contraseña de una cuenta de servicio en el `POST /login` y luego un bearer
 * en cada lectura; por HTTP plano hacia un host remoto eso es una credencial
 * regalada a cualquiera que esté en el camino. `localhost` se admite porque
 * ahí no hay camino: es el mismo equipo, y es como se prueba contra un
 * Symfony local sin certificado.
 */
function baseUrlIsEncryptedOrLoopback(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const realSchema = z.object({
  BOOKING_API_BASE_URL: z
    .string({ required_error: "BOOKING_API_BASE_URL es obligatoria en modo real_readonly" })
    .transform(optionalText)
    .pipe(
      z
        .string({ required_error: "BOOKING_API_BASE_URL es obligatoria en modo real_readonly" })
        .url("debe ser una URL completa, sin valor por defecto a producción")
        .refine(
          baseUrlHasNoEmbeddedSecrets,
          "sólo esquema, host y ruta base: nada de usuario:clave@, ni query, ni fragmento en la URL",
        )
        .refine(
          baseUrlIsEncryptedOrLoopback,
          "debe ser https:// (o http:// contra localhost): este modo envía credenciales de cuenta de servicio",
        ),
    ),
  // OJO CON EL TRIM: estas dos se validan con `refine`, no con
  // `.transform(optionalText)` como el resto. Todo lo demás en este esquema
  // se recorta porque son ajustes escritos a mano y un espacio sobrante es
  // siempre un descuido; una CONTRASEÑA no, ahí un espacio al final puede
  // ser parte del secreto y recortarlo produciría un 401 imposible de
  // diagnosticar. Se comprueba que no estén en blanco —«   » no es una
  // credencial configurada— y se pasa el valor EXACTO.
  BOOKING_USERNAME: z
    .string({ required_error: "BOOKING_USERNAME es obligatoria en modo real_readonly" })
    .refine((value) => value.trim() !== "", "BOOKING_USERNAME no puede estar vacía ni en blanco"),
  BOOKING_PASSWORD: z
    .string({ required_error: "BOOKING_PASSWORD es obligatoria en modo real_readonly" })
    .refine((value) => value.trim() !== "", "BOOKING_PASSWORD no puede estar vacía ni en blanco"),
  BOOKING_REMEMBER_ME: z
    .string()
    .optional()
    .transform(optionalText)
    .refine(
      (value) => value === undefined || value === "false",
      "el puente de voz nunca pide sesión persistente: deja BOOKING_REMEMBER_ME sin definir o en false",
    ),
  ENABLE_WRITE_OPERATIONS: z
    .string()
    .optional()
    .transform(optionalText)
    .refine(
      (value) => value !== "true",
      "este puente sólo lee: no arranca con ENABLE_WRITE_OPERATIONS=true en el entorno",
    ),
  BOOKING_DEFAULT_TYPE_RESERVATION: z
    .string()
    .optional()
    .transform((value) => optionalText(value) ?? DEFAULT_AGENDA_TYPE_RESERVATION),
  ELEVENLABS_BRIDGE_AGENDA_EMPLOYEE_IDS: z
    .string()
    .optional()
    .transform(optionalText)
    .pipe(positiveIntList.optional()),
  ELEVENLABS_BRIDGE_AGENDA_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((value) => optionalText(value))
    .pipe(z.coerce.number().int().min(250).max(30_000).optional())
    .transform((value) => value ?? DEFAULT_AGENDA_TIMEOUT_MS),
  ELEVENLABS_BRIDGE_AGENDA_HORIZON_DAYS: z
    .string()
    .optional()
    .transform((value) => optionalText(value))
    .pipe(z.coerce.number().int().min(0).max(30).optional())
    .transform((value) => value ?? DEFAULT_AGENDA_HORIZON_DAYS),
  ELEVENLABS_BRIDGE_AGENDA_REAL_READ_AUTHORIZED: z
    .string()
    .optional()
    .transform(optionalText)
    .refine(
      (value) => value === "true",
      "la lectura de la agenda real exige autorización humana explícita: ELEVENLABS_BRIDGE_AGENDA_REAL_READ_AUTHORIZED=true",
    ),
  ELEVENLABS_BRIDGE_AGENDA_AUTHORIZATION_REF: z
    .string()
    .optional()
    .transform(optionalText)
    .pipe(
      z
        .string({ required_error: "nombra quién autorizó la lectura real y cuándo (documento, commit o decisión fechada)" })
        .min(3, "nombra quién autorizó la lectura real y cuándo (documento, commit o decisión fechada)"),
    ),
});

export interface ElevenLabsRealAgendaConfig {
  mode: "real_readonly";
  baseUrl: string;
  /** Nunca se registra ni viaja fuera del arranque; ver `toJSON` más abajo. */
  username: string;
  password: string;
  /** Siempre `false`: no es configurable, es una decisión de seguridad. */
  rememberMe: false;
  typeReservation: string;
  employeeIds?: readonly number[];
  timeoutMs: number;
  horizonDays: number;
  authorizationRef: string;
  /** Redacta las credenciales si alguien serializa esta configuración por error. */
  toJSON(): Record<string, unknown>;
}

/**
 * Carga —y exige— todo lo que el modo real_readonly necesita. Falla cerrado
 * con un mensaje que nombra las variables que hay que corregir y NUNCA su
 * valor, igual que `loadEnv()` en el middleware histórico.
 */
export function loadElevenLabsRealAgendaConfig(
  env: NodeJS.ProcessEnv = process.env,
): ElevenLabsRealAgendaConfig {
  const parsed = realSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(configuración)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      "Configuración inválida para ELEVENLABS_BRIDGE_AGENDA_MODE=real_readonly:\n" +
        `${issues}\n` +
        "El puente no arranca a medias ni cae en silencio a la agenda sintética.",
    );
  }

  const data = parsed.data;
  return {
    mode: "real_readonly",
    baseUrl: data.BOOKING_API_BASE_URL,
    username: data.BOOKING_USERNAME,
    password: data.BOOKING_PASSWORD,
    rememberMe: false,
    typeReservation: data.BOOKING_DEFAULT_TYPE_RESERVATION,
    ...(data.ELEVENLABS_BRIDGE_AGENDA_EMPLOYEE_IDS !== undefined
      ? { employeeIds: data.ELEVENLABS_BRIDGE_AGENDA_EMPLOYEE_IDS }
      : {}),
    timeoutMs: data.ELEVENLABS_BRIDGE_AGENDA_TIMEOUT_MS,
    horizonDays: data.ELEVENLABS_BRIDGE_AGENDA_HORIZON_DAYS,
    authorizationRef: data.ELEVENLABS_BRIDGE_AGENDA_AUTHORIZATION_REF,
    toJSON() {
      return {
        mode: "real_readonly",
        baseUrl: this.baseUrl,
        username: "[redactado]",
        password: "[redactado]",
        rememberMe: false,
        typeReservation: this.typeReservation,
        employeeIds: this.employeeIds ?? "plantilla del día",
        timeoutMs: this.timeoutMs,
        horizonDays: this.horizonDays,
        authorizationRef: this.authorizationRef,
      };
    },
  };
}
