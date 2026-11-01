import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import type { CalendarWithCapabilities } from "../callEngine/capabilities.js";
import {
  freeStartsForDuration,
  isIntervalFree,
  isWithinHorizon,
} from "../callEngine/calendar/resolveAvailability.js";
import { formatHHmm, isValidDateISO } from "../callEngine/domain/time.js";
import { fixedClock, type ServiceId } from "../callEngine/domain/types.js";
import {
  DEFAULT_BOOKING_WEB_PORT,
  loadBookingWebConfig,
  requireBookingWebEnabled,
  type BookingWebConfig,
} from "./config.js";
import {
  BOOKING_WEB_NOTICE,
  formatDurationLabel,
  formatEuros,
  PAYMENT_MESSAGES,
  PAYMENT_OPTION_LABELS,
  PAYMENT_STATUS_LABELS,
  type BrandAssetFile,
  type DemoBooking,
  type DemoEmployee,
  type PaymentOption,
  type ServiceCatalogEntry,
  type TenantBrandLogo,
  type TenantThemeId,
} from "./model.js";
import { openingWindowsFor } from "./opening.js";
import { buildTenantPublicView } from "./publicView.js";
import {
  createBookingStore,
  fingerprintConfirmation,
  toSyntheticReservations,
  type BookingStore,
} from "./store.js";
import {
  buildTenantRegistry,
  employeeCanPerform,
  findEmployee,
  findService,
  type TenantDefinition,
} from "./tenants.js";
import { BOOKING_CSS } from "./ui.css.js";
import { renderBookingHtml } from "./ui.html.js";
import { renderBookingAppJs } from "./ui.js.js";
import { escapeHtml } from "./ui.sections.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LA DEMOSTRACIÓN WEB DE RESERVAS — FASE 1 (sólo API, sin interfaz).
 *
 * Una instancia de Fastify PROPIA, en su propio proceso. Este fichero NUNCA
 * importa `src/app.ts`, ni `src/console/**`, ni `src/voice/**`, ni monta nada
 * dentro de la aplicación del middleware real. Los datos que sirve son todos
 * sintéticos (`fixtures/`), y no sale ni una petición de red de este módulo.
 *
 * EL PAGO ES UN ESTADO EN MEMORIA. No hay pasarela ni proveedor externo de
 * ningún tipo, no se pide ni se acepta ningún dato financiero de nadie, y las
 * dos opciones («pagar ahora, en simulacro» y «pagar en el local») sólo mueven
 * enteros de céntimos dentro de este proceso. La confirmación lo dice en
 * castellano en su propia respuesta: «No se ha realizado ningún cargo real».
 *
 * NADIE SE INVENTA UNA HORA AQUÍ. Todos los inicios que devuelve
 * `/availability` salen de `freeStartsForDuration` y toda confirmación se
 * revalida con `isIntervalFree`, ambas del motor de calendario ya existente,
 * que resuelve por su cuenta los siete niveles de precedencia —incluida la
 * pausa de mediodía y las reservas ya confirmadas—. Este fichero no contiene
 * ni una resta de intervalos.
 *
 * POSTURA DE SEGURIDAD, calcada de la consola y por los mismos motivos:
 * `listen()` sólo contra `BOOKING_WEB_HOST` (constante en código), guarda de
 * loopback por petición, lista blanca de `Host` (defensa contra revinculación
 * de DNS) y una CSP estricta con cuatro cabeceras más. Sin sesión, sin cookie
 * y sin credencial de ninguna clase: no hay superficie pública que proteger
 * con una.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * LAS DOS FUNCIONES QUE VIVÍAN AQUÍ Y AHORA VIVEN EN SU SITIO.
 *
 * `formatEuros` se ha mudado a `model.ts` y `openingWindowsFor` a `opening.ts`,
 * porque desde la web pública las necesitan consumidores que no pasan por
 * ninguna ruta de este fichero (`buildTenantPublicView` formatea precios y la
 * sección de información práctica publica la semana entera). Se re-exportan
 * DESDE AQUÍ, con su nombre de siempre, para no romper a nadie que las
 * importara de `server.js`: el traslado es un movimiento interno y no una
 * ruptura de la superficie pública de este módulo.
 */
export { formatEuros, openingWindowsFor };

// ---------------------------------------------------------------------
// Cabeceras
// ---------------------------------------------------------------------

/**
 * La MISMA CSP que la consola de operador. `frame-ancestors`, `base-uri` y
 * `form-action` no heredan de `default-src`, así que se nombran a mano: sin
 * ellas, `default-src 'none'` no dice nada sobre quién puede meter esta página
 * en un marco, sobre un `<base>` inyectado que reescribiría cada ruta relativa,
 * ni sobre a dónde puede enviarse un formulario.
 *
 * La fase 2 servirá su interfaz desde este mismo proceso con `script-src
 * 'self'` y `style-src 'self'`: sin `'unsafe-inline'`, sin `data:` y sin
 * origen remoto, así que su hoja de estilos y su JavaScript tendrán que ir en
 * sus propias rutas, como los de la consola.
 */
export const BOOKING_WEB_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * La dirección de origen NO basta. En una revinculación de DNS la petición sale
 * de loopback de verdad —la hace el navegador de esta misma máquina— y lo único
 * que delata el ataque es la cabecera `Host`, que lleva el dominio del atacante.
 * La lista blanca es la mínima, anclada por los dos extremos, con puerto
 * opcional de sólo dígitos; un `Host` ausente tampoco pasa.
 */
const ALLOWED_HOST_HEADER = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  return ALLOWED_HOST_HEADER.test(hostHeader.trim().toLowerCase());
}

// ---------------------------------------------------------------------
// LOS ACTIVOS DE MARCA (fase 2). Mismo patrón que la consola de operador:
// se resuelven en disco RELATIVO A ESTE MÓDULO —nunca a partir de nada que
// traiga una petición—, se leen UNA vez por proceso y fallan ruidosamente si
// faltan, en vez de servir una imagen vacía que parecería un fallo del
// navegador.
//
// EL REGISTRO ES CERRADO Y LAS RUTAS SON LITERALES. La clave de este objeto es
// el tipo `BrandAssetFile`, una unión de literales, así que aquí no se
// concatena ningún nombre de fichero: cada camino está escrito entero. Un
// local no puede declarar un activo que no exista —no compilaría— y ninguna
// petición puede llegar a nombrar un camino, porque las peticiones traen un
// `tenantId` y no un fichero.
// ---------------------------------------------------------------------
const BRAND_ASSET_PATHS: Readonly<Record<BrandAssetFile, string>> = {
  "demo-salon-logo.png": fileURLToPath(new URL("../../assets/brand/demo-salon-logo.png", import.meta.url)),
};

const brandAssetCache = new Map<BrandAssetFile, Buffer>();

/** Exportada para que un mismo fallo (fichero ausente o vacío) se pueda probar sin renombrar un activo versionado. */
export function readBookingBrandAsset(path: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(
      `No se ha podido leer el activo de marca en ${path}. ` +
        `La demostración web no arranca sin él a propósito. Detalle: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (bytes.length === 0) {
    throw new Error(`El activo de marca en ${path} está vacío (0 bytes).`);
  }
  return bytes;
}

function loadBrandAsset(file: BrandAssetFile): Buffer {
  const cached = brandAssetCache.get(file);
  if (cached !== undefined) return cached;
  const bytes = readBookingBrandAsset(BRAND_ASSET_PATHS[file]);
  brandAssetCache.set(file, bytes);
  return bytes;
}

/**
 * Los bytes del activo de CADA local que declara uno, indexados por local.
 *
 * Que el índice sea `tenantId → bytes` es lo que hace imposible por
 * construcción que un local sirva el activo de otro: la ruta busca por el
 * local ya resuelto del camino y no hay ninguna otra forma de llegar a un
 * buffer. Un local sin activo sencillamente no tiene entrada, y eso es un 404,
 * nunca la imagen del vecino.
 *
 * Se construye AL ARRANCAR (no por petición): si el fichero de un local falta,
 * la demostración revienta antes de tener rutas, como hacía antes.
 */
function loadTenantBrandAssets(registry: ReadonlyMap<string, TenantDefinition>): Map<string, Buffer> {
  const assets = new Map<string, Buffer>();
  for (const tenant of registry.values()) {
    if (tenant.brand.logo.kind === "asset") {
      assets.set(tenant.tenantId, loadBrandAsset(tenant.brand.logo.assetFile));
    }
  }
  return assets;
}

// ---------------------------------------------------------------------
// EL ICONO DE PESTAÑA, COMPUESTO AQUÍ Y NO SERVIDO DE DISCO.
//
// No se ha añadido ningún binario nuevo al repositorio —ni un `.ico`, ni un
// PNG— por tres motivos: un icono de 32×32 con dos letras es texto, no una
// fotografía; `BrandAssetFile` sigue siendo la unión cerrada de siempre, con un
// único fichero versionado; y un SVG compuesto en el proceso es DERIVADO de la
// marca del local, así que no puede quedarse desfasado respecto a ella.
//
// LOS COLORES VAN EN UNA TABLA CERRADA, indexada por `TenantThemeId`, igual que
// `BRAND_ASSET_PATHS` va indexada por `BrandAssetFile` y por el mismo motivo:
// ningún hex viaja en la configuración del local, así que el día que esa
// configuración venga de otra fuente no habrá por dónde inyectar un color, y el
// compilador exigirá una entrada nueva el día que se añada un tema. Son el
// `--txb-accent-700` y el papel de cada tema de `ui.css.ts`.
// ---------------------------------------------------------------------
const BRAND_ICON_COLORS: Readonly<Record<TenantThemeId, { bg: string; fg: string }>> = {
  "demo-salon": { bg: "#9A4A22", fg: "#F6F2E9" },
  aralar: { bg: "#23478A", fg: "#EEF1F7" },
};

/**
 * EL ICONO DE UN LOCAL, DETERMINISTA Y SIN UNA SOLA SUPERFICIE ACTIVA.
 *
 * Lo único variable del documento es el monograma del local y los dos colores
 * de su tema: la misma entrada da siempre exactamente los mismos bytes, aquí no
 * se lee el reloj ni se sortea nada, y por eso el icono se puede comparar
 * carácter a carácter en una prueba.
 *
 * QUÉ NO LLEVA, Y NO ES UNA CASUALIDAD. Un SVG es un documento, no una imagen
 * tonta: servido como `image/svg+xml` puede contener `<script>`, incrustar HTML
 * con `<foreignObject>` o traerse píxeles de fuera con `<image href>` o con un
 * `<use href>`. Aquí no hay ninguna de esas cosas —ni un solo atributo `href`—,
 * así que no queda ni un punto por donde este documento pueda ejecutar nada ni
 * salir a la red. El único `xmlns` es el del propio SVG, obligatorio para que el
 * navegador lo pinte, y es un espacio de nombres, no una descarga.
 *
 * EL MONOGRAMA SE ESCAPA con el mismo `escapeHtml` que usa la plantilla —una
 * sola función de escape en todo el proyecto, no dos que puedan divergir—, y
 * cae en un nodo de TEXTO, nunca en un atributo. Aun así el escape es el que
 * cierra la puerta: un monograma hostil no puede abrir una etiqueta.
 *
 * NO HAY NI UN TEXTO COMPARTIDO ENTRE LOCALES: el único contenido es el
 * monograma propio, así que el icono de un local no puede llevar dentro un
 * rastro de la marca del otro.
 */
export function renderBrandIconSvg(monogram: string, theme: TenantThemeId): string {
  const { bg, fg } = BRAND_ICON_COLORS[theme];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
    `<rect width="32" height="32" rx="6" fill="${bg}"></rect>` +
    `<text x="16" y="21" text-anchor="middle" font-family="Georgia, serif" font-size="14" ` +
    `font-weight="700" letter-spacing="0.5" fill="${fg}">${escapeHtml(monogram)}</text>` +
    `</svg>`
  );
}

// ---------------------------------------------------------------------
// Validación de entrada — zod en todas las rutas, `.strict()` en todas, para
// que un campo de más sea un 400 y jamás una instrucción ignorada en silencio.
// ---------------------------------------------------------------------

const TENANT_PARAMS_SCHEMA = z
  .object({ tenantId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) })
  .strict();

const DATE_SCHEMA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * La clave de idempotencia, con el MISMO formato de transporte que usa la
 * consola. Viaja en el cuerpo (y no en una cabecera) porque en esta API es
 * parte de la confirmación que la fase 2 compone y reintenta.
 */
const IDEMPOTENCY_KEY_SCHEMA = z.string().regex(/^[A-Za-z0-9_:.-]{8,200}$/);

const PAYMENT_OPTION_SCHEMA = z.enum(["pay_now_demo", "pay_at_salon"]);

const AVAILABILITY_QUERY_SCHEMA = z
  .object({
    serviceId: z.string().regex(/^\d$/),
    date: DATE_SCHEMA,
    employeeId: z.string().regex(/^[1-9]\d*$/).optional(),
  })
  .strict();

/**
 * El cuerpo de la confirmación. `payment_option` NO tiene valor por defecto y
 * no es opcional: elegir cómo se paga es una decisión explícita de quien
 * reserva. Ninguna de las dos opciones pide un solo dato financiero, y este
 * esquema —que es toda la entrada que el servidor acepta— no tiene ningún
 * campo donde uno pudiera colarse.
 */
const BOOK_BODY_SCHEMA = z
  .object({
    serviceId: z.number().int().min(0).max(9),
    employeeId: z.number().int().positive(),
    date: DATE_SCHEMA,
    startMinutes: z.number().int().min(0).max(1439),
    payment_option: PAYMENT_OPTION_SCHEMA,
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
  })
  .strict();

/** Los tres códigos históricos, y ni uno más. Devuelve `undefined` para cualquier otro número. */
function asServiceId(n: number): ServiceId | undefined {
  return n === 0 || n === 1 || n === 2 ? n : undefined;
}

// ---------------------------------------------------------------------
// Proyecciones (lo que ve la fase 2)
// ---------------------------------------------------------------------

interface StartOption {
  startMinutes: number;
  label: string;
}

function toStartOption(startMinutes: number): StartOption {
  return { startMinutes, label: formatHHmm(startMinutes) };
}

/**
 * LA MARCA DEL LOCAL, tal y como sale por `/bootstrap`.
 *
 * El distintivo se publica como URL (`/brand/:tenantId/logo.png`), NUNCA como
 * nombre de fichero: fuera de este proceso no hace falta —ni conviene— saber
 * cómo se llama nada en el disco. La rama es sobre la FORMA del distintivo, no
 * sobre qué local es.
 */
function projectBrandLogo(tenantId: string, logo: TenantBrandLogo): Record<string, unknown> {
  if (logo.kind === "asset") {
    return {
      kind: "asset",
      url: `/brand/${tenantId}/logo.png`,
      alt: logo.alt,
      width: logo.width,
      height: logo.height,
    };
  }
  return { kind: "wordmark", initials: logo.initials, text: logo.text };
}

function projectBrand(tenant: TenantDefinition): Record<string, unknown> {
  return {
    displayName: tenant.displayName,
    title: tenant.brand.title,
    heading: tenant.brand.heading,
    tagline: tenant.brand.tagline,
    theme: tenant.brand.theme,
    logo: projectBrandLogo(tenant.tenantId, tenant.brand.logo),
  };
}

/**
 * La proyección ÚNICA de una reserva: la misma la devuelve la confirmación y
 * la misma la lista el panel. Una sola función para las dos, para que no puedan
 * describir la misma reserva de dos maneras distintas.
 */
function projectBooking(tenant: TenantDefinition, booking: DemoBooking): Record<string, unknown> {
  const service = findService(tenant, booking.serviceId);
  const employee = findEmployee(tenant, booking.employeeId);
  const endMinutes = booking.startMinutes + booking.durationMinutes;
  return {
    id: booking.id,
    tenantId: booking.tenantId,
    serviceId: booking.serviceId,
    employeeId: booking.employeeId,
    date: booking.date,
    startMinutes: booking.startMinutes,
    endMinutes,
    durationMinutes: booking.durationMinutes,
    status: booking.status,
    payment: booking.payment,
    labels: {
      service: service?.label ?? "",
      employee: employee?.displayName ?? "",
      when: `${booking.date} · ${formatHHmm(booking.startMinutes)}–${formatHHmm(endMinutes)}`,
      paymentOption: PAYMENT_OPTION_LABELS[booking.payment.payment_option],
      paymentStatus: PAYMENT_STATUS_LABELS[booking.payment.payment_status],
      amountTotal: formatEuros(booking.payment.amount_total_cents),
      amountPaid: formatEuros(booking.payment.amount_paid_cents),
      amountDue: formatEuros(booking.payment.amount_due_cents),
    },
  };
}

// ---------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------

export interface BookingWebServerDeps {
  store?: BookingStore;
  registry?: ReadonlyMap<string, TenantDefinition>;
  /** Sólo para el texto informativo de `/bootstrap`; el HOST nunca sale de aquí. */
  port?: number;
}

/**
 * Construye (pero NO arranca) la instancia de Fastify de la demostración web.
 * Segura de usar con `.inject()` en pruebas: no abre ningún puerto TCP. El
 * único sitio que llama a `listen()` es `startBookingWebServer`, más abajo, y
 * ése sí falla en cerrado si la demostración no está encendida.
 */
export function buildBookingWebServer(deps: BookingWebServerDeps = {}): FastifyInstance {
  const store = deps.store ?? createBookingStore();
  const registry = deps.registry ?? buildTenantRegistry();
  const port = deps.port ?? DEFAULT_BOOKING_WEB_PORT;

  // Se leen en la CONSTRUCCIÓN, no por petición: si el activo de un local
  // falta, esto revienta aquí, antes de que exista una sola ruta, en vez de
  // fallar en silencio en una pestaña del navegador.
  const brandAssets = loadTenantBrandAssets(registry);

  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 64 * 1024 });

  // Defensa en profundidad: aunque `listen()` sólo se ata a loopback, cada
  // petición se comprueba aquí por su cuenta. `trustProxy: false` significa que
  // `req.ip` es la dirección real del socket y nunca una cabecera falsificable.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopbackAddress(req.ip)) {
      await reply
        .code(403)
        .send({ code: "FORBIDDEN_ORIGIN", message: "Esta demostración local solo admite peticiones desde 127.0.0.1 (loopback)." });
      return;
    }
    if (!isAllowedHostHeader(req.headers.host)) {
      await reply
        .code(403)
        .send({ code: "FORBIDDEN_HOST", message: "Esta demostración local solo admite peticiones cuyo Host sea localhost, 127.0.0.1 o [::1]." });
    }
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Content-Security-Policy", BOOKING_WEB_CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    // DEFENSA EN PROFUNDIDAD SOBRE EL `<meta name="robots">` de la plantilla.
    // Ese `<meta>` sólo lo lee un rastreador que analice HTML: no dice nada
    // sobre el icono, la hoja de estilos, el cliente JavaScript ni ninguna
    // respuesta de la API. La cabecera cubre TODAS las respuestas de este
    // proceso, y no cuesta nada emitirla aquí una vez.
    reply.header("X-Robots-Tag", "noindex, nofollow");
    return payload;
  });

  // -------------------------------------------------------------------
  // FASE 2 — la interfaz. Dos rutas verdaderamente estáticas (hoja de estilos
  // y cliente JavaScript), los dos distintivos POR LOCAL —el logotipo, que sale
  // de disco, y el icono de pestaña, que se compone—, el 204 de `/favicon.ico`
  // y la página por local.
  //
  // La hoja y el cliente sirven el MISMO texto para cualquier local, porque no
  // llevan ni un precio ni un horario escrito a mano: todo eso lo pide el
  // cliente a `/api/:tenantId/…`, y la identidad visual la conmuta el atributo
  // `data-theme` del `<body>`. Las otras dos —la página y el activo de marca—
  // resuelven el local con `resolveTenant` y contestan 404 si no existe.
  //
  // Registradas ANTES de `/:tenantId` por legibilidad, aunque el orden no
  // decide nada aquí: el enrutador de Fastify (find-my-way) prioriza SIEMPRE
  // una ruta estática (`/app.css`) sobre una paramétrica (`/:tenantId`),
  // exista o no un local llamado literalmente "app.css".
  // -------------------------------------------------------------------
  app.get("/app.css", async (_req, reply) => {
    reply.header("Content-Type", "text/css; charset=utf-8");
    return BOOKING_CSS;
  });

  app.get("/app.js", async (_req, reply) => {
    reply.header("Content-Type", "application/javascript; charset=utf-8");
    return renderBookingAppJs();
  });

  /**
   * EL ACTIVO DE MARCA, SIEMPRE POR LOCAL Y SIEMPRE VALIDADO AQUÍ.
   *
   * Antes había una sola ruta `/brand/logo.png` que servía el PNG del local
   * principal a quien lo pidiera, viniera de donde viniera: el segundo local se
   * presentaba con la marca del primero. Ahora el local va en el camino y se
   * resuelve con el MISMO `resolveTenant` que el resto de la API, así que:
   *   - local desconocido o mal formado → 404 `UNKNOWN_TENANT`, la misma
   *     respuesta que da cualquier otra ruta (esta API tampoco sirve aquí para
   *     averiguar qué locales existen);
   *   - local conocido que no declara activo → 404 `NO_BRAND_ASSET`, limpio, y
   *     jamás el PNG de otro: `brandAssets` está indexado por local y no hay
   *     ningún camino que lleve a los bytes de un local distinto del resuelto.
   */
  app.get("/brand/:tenantId/logo.png", async (req, reply) => {
    const tenant = resolveTenant(req);
    if (tenant === undefined) return fail(reply, 404, "UNKNOWN_TENANT", "No existe ese local en la demostración.");
    const bytes = brandAssets.get(tenant.tenantId);
    if (bytes === undefined) {
      return fail(reply, 404, "NO_BRAND_ASSET", "Este local no publica ningún activo de marca.");
    }
    reply.header("Content-Type", "image/png");
    return bytes;
  });

  /**
   * EL ICONO DE PESTAÑA, TAMBIÉN POR LOCAL Y POR EL MISMO CAMINO.
   *
   * Es una ruta LITERAL distinta de la del logotipo (`…/icon.svg` frente a
   * `…/logo.png`), no una variante suya: la del logotipo conserva intactos su
   * origen —los bytes versionados en disco, indexados por local—, su
   * `image/png` y sus dos 404. Aquí no se lee ningún fichero; el documento se
   * compone con `renderBrandIconSvg` a partir de la marca del local ya resuelto.
   *
   * Por eso un local sin activo de marca SÍ tiene icono: no depende de que
   * exista un fichero suyo en el disco, sino de que tenga monograma y tema, que
   * los tiene todo local por tipo. Y el local se resuelve con el MISMO
   * `resolveTenant` que el resto, así que uno desconocido o mal formado da el
   * mismo 404 `UNKNOWN_TENANT` de siempre.
   */
  app.get("/brand/:tenantId/icon.svg", async (req, reply) => {
    const tenant = resolveTenant(req);
    if (tenant === undefined) return fail(reply, 404, "UNKNOWN_TENANT", "No existe ese local en la demostración.");
    reply.header("Content-Type", "image/svg+xml; charset=utf-8");
    return renderBrandIconSvg(tenant.brand.monogram, tenant.brand.theme);
  });

  /**
   * `GET /favicon.ico` → 204, SIN CUERPO.
   *
   * El navegador pide este camino él solo en cada carga, no lo pide nadie del
   * documento, y hasta ahora caía en `/:tenantId` y contestaba 404: una línea
   * roja en la consola de herramientas de desarrollo en cada visita, que
   * confunde con un fallo de verdad.
   *
   * Las dos salidas fáciles serían peores. Inventar un `.ico` metería un
   * binario en el repositorio para algo que ya se resuelve con el `<link
   * rel="icon">` del documento. Y servir aquí el icono de ALGÚN local sería
   * elegir un local por defecto desde un camino que no lleva local: la marca de
   * uno se colaría en la pestaña del otro, que es exactamente el defecto que se
   * arregló al meter el local dentro de la ruta del activo de marca.
   *
   * 204 dice lo único cierto: aquí no hay recurso, no lo vuelvas a pedir y no
   * ha pasado nada malo. El icono de verdad está en el documento, por local.
   */
  app.get("/favicon.ico", async (_req, reply) => {
    return reply.code(204).send();
  });

  app.get("/:tenantId", async (req, reply) => {
    const tenant = resolveTenant(req);
    if (tenant === undefined) return fail(reply, 404, "UNKNOWN_TENANT", "No existe ese local en la demostración.");
    reply.header("Content-Type", "text/html; charset=utf-8");
    // A la plantilla NO se le pasa el local entero, sino la vista pública que
    // `buildTenantPublicView` construye y depura: cadenas ya formateadas,
    // servicios y personas ya derivados y la semana de apertura ya resuelta.
    //
    // La diferencia no es de estilo. `TenantPublicView` no tiene `priceCents`,
    // ni `durationMinutes`, ni `calendar`, ni `demoToday`, ni el almacén: la
    // plantilla no puede imprimir un precio en céntimos ni recorrer el
    // calendario aunque alguien lo intente, porque no están en el tipo. Y sigue
    // sin necesitar —ni tener— una sola comparación de `tenantId`: todo lo que
    // distingue a un local viaja dentro de la vista.
    return renderBookingHtml(buildTenantPublicView(tenant));
  });

  // -------------------------------------------------------------------
  // Ayudas comunes
  // -------------------------------------------------------------------

  function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
    return reply.code(status).send({ code, message, notice: BOOKING_WEB_NOTICE });
  }

  /**
   * Resuelve el local del camino. Un identificador mal formado y uno
   * desconocido dan la MISMA respuesta (404) a propósito: esta API no sirve
   * para averiguar qué locales existen.
   */
  function resolveTenant(req: FastifyRequest): TenantDefinition | undefined {
    const parsed = TENANT_PARAMS_SCHEMA.safeParse(req.params);
    if (!parsed.success) return undefined;
    return registry.get(parsed.data.tenantId);
  }

  /**
   * El calendario del local CON las reservas que hay ahora mismo en el almacén.
   * Se compone en cada consulta, sin caché de ninguna clase: es la garantía de
   * que la revalidación previa a escribir mira el mundo tal y como está y no
   * una foto anterior.
   */
  function calendarNow(tenant: TenantDefinition): CalendarWithCapabilities {
    return {
      ...tenant.calendar,
      reservations: toSyntheticReservations(store.list(tenant.tenantId)),
    };
  }

  /** Sólo las personas de ESTE local capaces de hacer ESE servicio. */
  function capableEmployees(tenant: TenantDefinition, serviceId: ServiceId): DemoEmployee[] {
    return tenant.employees.filter((e) => employeeCanPerform(e, serviceId));
  }

  /** Si la fecha entra en el horizonte de reserva declarado por el calendario del local. */
  function withinHorizon(tenant: TenantDefinition, cal: CalendarWithCapabilities, date: string): boolean {
    return isWithinHorizon(cal, fixedClock(tenant.demoToday, 0), date);
  }

  /**
   * La rejilla POR PROFESIONAL. Cada lista sale entera de
   * `freeStartsForDuration`, con la duración del catálogo de ESTE local y el
   * paso de la rejilla del calendario. Aquí no se filtra, ni se recorta, ni se
   * añade nada a lo que contesta el motor.
   */
  function gridFor(
    cal: CalendarWithCapabilities,
    employees: readonly DemoEmployee[],
    date: string,
    durationMinutes: number,
  ): { employeeId: number; displayName: string; starts: StartOption[] }[] {
    return employees.map((e) => ({
      employeeId: e.employeeId,
      displayName: e.displayName,
      starts: freeStartsForDuration(cal, e.employeeId, date, durationMinutes, cal.slotMinutes).map(
        toStartOption,
      ),
    }));
  }

  // -------------------------------------------------------------------
  // GET /api/:tenantId/bootstrap — todo lo que la interfaz necesita para
  // pintarse por primera vez, en una sola petición.
  // -------------------------------------------------------------------
  app.get("/api/:tenantId/bootstrap", async (req, reply) => {
    const tenant = resolveTenant(req);
    if (tenant === undefined) return fail(reply, 404, "UNKNOWN_TENANT", "No existe ese local en la demostración.");

    return reply.send({
      tenantId: tenant.tenantId,
      displayName: tenant.displayName,
      // AÑADIDO en 2026-08-26, sin tocar ni un campo de los que ya viajaban:
      // la identidad visual del local, para que quien pinte esta demostración
      // (hoy el propio envoltorio HTML; mañana, quien sea) no tenga que
      // deducirla del identificador.
      brand: projectBrand(tenant),
      demoToday: tenant.demoToday,
      notice: BOOKING_WEB_NOTICE,
      slotMinutes: tenant.calendar.slotMinutes,
      bookingHorizonDays: tenant.calendar.bookingHorizonDays,
      // `durationLabel` CIERRA UNA CONTRADICCIÓN VISIBLE EN LA MISMA PANTALLA.
      //
      // Aquí viajaban el precio en céntimos Y su rótulo, pero de la duración
      // sólo viajaban los minutos. Esa asimetría no era un descuido inocuo: el
      // cliente no tenía de dónde sacar un rótulo de duración, así que se
      // fabricaba el suyo pegando « min» a los minutos, y «Corte y barba»
      // aparecía como «1 h» en la sección pública de servicios —que lo pide a
      // `formatDurationLabel`— y como «60 min» en el paso 1 del asistente, unos
      // píxeles más abajo, en la misma carga de la misma página. El precio
      // nunca se contradijo por la razón contraria: ya viajaba formateado.
      //
      // El rótulo lo produce el MISMO `formatDurationLabel` que alimenta la
      // vista pública, así que las dos zonas de la página no pueden volver a
      // discrepar sin que discrepe una sola función. Es un campo AÑADIDO: los
      // que ya viajaban —`durationMinutes` incluido— siguen intactos, con su
      // nombre, su orden y su tipo.
      services: tenant.services.map((s: ServiceCatalogEntry) => ({
        serviceId: s.serviceId,
        label: s.label,
        durationMinutes: s.durationMinutes,
        priceCents: s.priceCents,
        priceLabel: formatEuros(s.priceCents),
        durationLabel: formatDurationLabel(s.durationMinutes),
      })),
      employees: tenant.employees.map((e) => ({
        employeeId: e.employeeId,
        displayName: e.displayName,
        serviceIds: [...e.serviceIds],
      })),
      paymentOptions: (["pay_now_demo", "pay_at_salon"] as const).map((value: PaymentOption) => ({
        value,
        label: PAYMENT_OPTION_LABELS[value],
      })),
      local: `127.0.0.1:${String(port)}`,
    });
  });

  // -------------------------------------------------------------------
  // GET /api/:tenantId/availability?serviceId&date[&employeeId]
  // -------------------------------------------------------------------
  app.get("/api/:tenantId/availability", async (req, reply) => {
    const tenant = resolveTenant(req);
    if (tenant === undefined) return fail(reply, 404, "UNKNOWN_TENANT", "No existe ese local en la demostración.");

    const parsed = AVAILABILITY_QUERY_SCHEMA.safeParse(req.query);
    if (!parsed.success) {
      return fail(reply, 400, "INVALID_QUERY", "La consulta de disponibilidad no tiene el formato esperado.");
    }
    const { date } = parsed.data;
    if (!isValidDateISO(date)) {
      return fail(reply, 400, "INVALID_DATE", "Esa fecha no existe en el calendario.");
    }

    const serviceId = asServiceId(Number(parsed.data.serviceId));
    const service = serviceId === undefined ? undefined : findService(tenant, serviceId);
    if (service === undefined || serviceId === undefined) {
      return fail(reply, 404, "UNKNOWN_SERVICE", "Ese servicio no está en el catálogo de este local.");
    }

    let employees = capableEmployees(tenant, serviceId);
    if (parsed.data.employeeId !== undefined) {
      const employeeId = Number(parsed.data.employeeId);
      const employee = findEmployee(tenant, employeeId);
      if (employee === undefined) {
        return fail(reply, 404, "UNKNOWN_EMPLOYEE", "Esa persona no trabaja en este local de la demostración.");
      }
      if (!employeeCanPerform(employee, serviceId)) {
        return fail(
          reply,
          409,
          "EMPLOYEE_CANNOT_PERFORM_SERVICE",
          "Esa persona no realiza ese servicio.",
        );
      }
      employees = [employee];
    }

    const cal = calendarNow(tenant);
    const inHorizon = withinHorizon(tenant, cal, date);
    // Fuera del horizonte no se inventa una respuesta vacía silenciosa: se dice
    // que está fuera, y la lista viene vacía porque de verdad no hay nada que
    // ofrecer ahí.
    const byEmployee = inHorizon ? gridFor(cal, employees, date, service.durationMinutes) : [];
    const union = [...new Set(byEmployee.flatMap((row) => row.starts.map((s) => s.startMinutes)))]
      .sort((a, b) => a - b)
      .map(toStartOption);
    // Los tramos van sobre TODAS las personas del local (`tenant.employees`),
    // no sobre `employees` —que aquí ya viene filtrado por servicio y, si se
    // pidió, por profesional—: ver el docblock de `openingWindowsFor`. Fuera
    // del horizonte no hay nada que rotular, así que van vacíos como `starts`.
    const windows = inHorizon ? openingWindowsFor(cal, tenant.employees, date) : [];

    return reply.send({
      tenantId: tenant.tenantId,
      date,
      serviceId,
      serviceLabel: service.label,
      durationMinutes: service.durationMinutes,
      stepMinutes: cal.slotMinutes,
      employeeId: parsed.data.employeeId === undefined ? null : Number(parsed.data.employeeId),
      withinHorizon: inHorizon,
      starts: union,
      byEmployee,
      windows,
      notice: BOOKING_WEB_NOTICE,
    });
  });

  // -------------------------------------------------------------------
  // POST /api/:tenantId/book
  // -------------------------------------------------------------------
  app.post("/api/:tenantId/book", async (req, reply) => {
    const tenant = resolveTenant(req);
    if (tenant === undefined) return fail(reply, 404, "UNKNOWN_TENANT", "No existe ese local en la demostración.");

    const parsed = BOOK_BODY_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return fail(reply, 400, "INVALID_BODY", "La confirmación no tiene el formato esperado.");
    }
    const body = parsed.data;

    if (!isValidDateISO(body.date)) {
      return fail(reply, 400, "INVALID_DATE", "Esa fecha no existe en el calendario.");
    }

    const serviceId = asServiceId(body.serviceId);
    const service = serviceId === undefined ? undefined : findService(tenant, serviceId);
    if (service === undefined || serviceId === undefined) {
      return fail(reply, 404, "UNKNOWN_SERVICE", "Ese servicio no está en el catálogo de este local.");
    }

    const employee = findEmployee(tenant, body.employeeId);
    if (employee === undefined) {
      return fail(reply, 404, "UNKNOWN_EMPLOYEE", "Esa persona no trabaja en este local de la demostración.");
    }
    if (!employeeCanPerform(employee, serviceId)) {
      return fail(reply, 409, "EMPLOYEE_CANNOT_PERFORM_SERVICE", "Esa persona no realiza ese servicio.");
    }

    // Guardarraíl ESTRUCTURAL, no comercial: la rejilla que publica
    // `/availability` va en pasos de `slotMinutes`, así que un inicio fuera de
    // esa rejilla no viene de ninguna pantalla de esta demostración. Quien
    // decide qué CABE sigue siendo el calendario, unas líneas más abajo.
    if (body.startMinutes % tenant.calendar.slotMinutes !== 0) {
      return fail(
        reply,
        400,
        "START_NOT_ALIGNED",
        `La hora de inicio va en pasos de ${String(tenant.calendar.slotMinutes)} minutos.`,
      );
    }

    // LA IDEMPOTENCIA SE CONSULTA ANTES DE REVALIDAR EL HUECO, y el orden no es
    // un detalle: la reserva que creó la primera petición OCUPA ese hueco, así
    // que revalidar primero convertiría toda repetición legítima en un
    // «hueco ocupado» y el cliente reintentaría para siempre.
    const fingerprint = fingerprintConfirmation({
      serviceId,
      employeeId: body.employeeId,
      date: body.date,
      startMinutes: body.startMinutes,
      paymentOption: body.payment_option,
    });
    const seen = store.lookupIdempotency(tenant.tenantId, body.idempotencyKey, fingerprint);
    if (seen.kind === "collision") {
      return fail(
        reply,
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "Esa clave de idempotencia ya se usó para una reserva distinta. No se ha creado nada.",
      );
    }
    if (seen.kind === "replay") {
      return reply.code(200).send({
        booking: projectBooking(tenant, seen.booking),
        messages: [...PAYMENT_MESSAGES[seen.booking.payment.payment_option]],
        repeated: true,
        notice: BOOKING_WEB_NOTICE,
      });
    }

    const cal = calendarNow(tenant);
    if (!withinHorizon(tenant, cal, body.date)) {
      return fail(reply, 409, "OUT_OF_HORIZON", "Esa fecha queda fuera del horizonte de reserva de la demostración.");
    }

    // LA PUERTA. Recalcula desde cero —sin caché— los siete niveles del
    // calendario y contesta si TODO el intervalo está libre: horario del local,
    // pausa de mediodía, horario propio de la persona y reservas ya
    // confirmadas, todo a la vez. Entre esta comprobación y la escritura no hay
    // ni un `await`, así que no hay ventana donde colarse.
    const endMinutes = body.startMinutes + service.durationMinutes;
    if (!isIntervalFree(cal, employee.employeeId, body.date, body.startMinutes, endMinutes)) {
      return fail(reply, 409, "SLOT_TAKEN", "Ese hueco ya no está libre. No se ha creado ninguna reserva.");
    }

    const booking = store.confirm({
      tenantId: tenant.tenantId,
      serviceId,
      employeeId: employee.employeeId,
      date: body.date,
      startMinutes: body.startMinutes,
      durationMinutes: service.durationMinutes,
      paymentOption: body.payment_option,
      amountTotalCents: service.priceCents,
      idempotencyKey: body.idempotencyKey,
      fingerprint,
    });

    return reply.code(201).send({
      booking: projectBooking(tenant, booking),
      messages: [...PAYMENT_MESSAGES[booking.payment.payment_option]],
      repeated: false,
      notice: BOOKING_WEB_NOTICE,
    });
  });

  // -------------------------------------------------------------------
  // GET /api/:tenantId/dashboard
  // -------------------------------------------------------------------
  app.get("/api/:tenantId/dashboard", async (req, reply) => {
    const tenant = resolveTenant(req);
    if (tenant === undefined) return fail(reply, 404, "UNKNOWN_TENANT", "No existe ese local en la demostración.");

    // `store.list` devuelve las reservas de ESTE local y de ninguno más, en
    // orden de creación y cada una UNA sola vez: es la lista misma, no una
    // agregación que pudiera duplicar filas.
    const bookings = store.list(tenant.tenantId);
    const totals = bookings.reduce(
      (acc, b) => ({
        amount_total_cents: acc.amount_total_cents + b.payment.amount_total_cents,
        amount_paid_cents: acc.amount_paid_cents + b.payment.amount_paid_cents,
        amount_due_cents: acc.amount_due_cents + b.payment.amount_due_cents,
      }),
      { amount_total_cents: 0, amount_paid_cents: 0, amount_due_cents: 0 },
    );

    return reply.send({
      tenantId: tenant.tenantId,
      displayName: tenant.displayName,
      demoToday: tenant.demoToday,
      notice: BOOKING_WEB_NOTICE,
      bookings: bookings.map((b) => projectBooking(tenant, b)),
      // `totals.labels` CIERRA EL ÚLTIMO SITIO DONDE EL CLIENTE SABÍA DE DINERO.
      //
      // Cada reserva ya viajaba con sus `labels.amount*` formateados por
      // `formatEuros`, pero el AGREGADO viajaba sólo en céntimos. Por eso —y
      // sólo por eso— el cliente arrastraba un formateador propio que
      // reimplementaba `formatEuros` carácter a carácter: una segunda verdad
      // sobre cómo se escribe un importe, en un fichero distinto, que podía
      // divergir de la primera sin que nada lo delatara. Con esto, la última
      // cifra de dinero de la pantalla la produce el servidor, y el cliente
      // puede dejar de saber dividir por cien.
      //
      // Misma FORMA que las etiquetas por reserva (`amountTotal`, `amountPaid`,
      // `amountDue`), para que el agregado y el detalle no se lean distinto. Es
      // un campo AÑADIDO: `count` y los tres importes en céntimos siguen donde
      // estaban, con su nombre y su tipo.
      totals: {
        count: bookings.length,
        ...totals,
        labels: {
          amountTotal: formatEuros(totals.amount_total_cents),
          amountPaid: formatEuros(totals.amount_paid_cents),
          amountDue: formatEuros(totals.amount_due_cents),
        },
      },
    });
  });

  // -------------------------------------------------------------------
  // POST /api/:tenantId/reset — reinicio de la demostración DE ESE LOCAL.
  // -------------------------------------------------------------------
  app.post("/api/:tenantId/reset", async (req, reply) => {
    const tenant = resolveTenant(req);
    if (tenant === undefined) return fail(reply, 404, "UNKNOWN_TENANT", "No existe ese local en la demostración.");

    // El argumento NO es opcional aquí a propósito: reiniciar un local jamás
    // toca los datos de otro, y la única forma de vaciarlos todos es llamar al
    // almacén sin identificador, cosa que ninguna ruta hace.
    const removed = store.reset(tenant.tenantId);
    return reply.send({
      tenantId: tenant.tenantId,
      removedBookings: removed,
      message: "Demostración reiniciada. Todo vuelve a estar a cero.",
      notice: BOOKING_WEB_NOTICE,
    });
  });

  return app;
}

export interface StartedBookingWebServer {
  app: FastifyInstance;
  config: BookingWebConfig;
}

/**
 * ARRANQUE EN CERRADO. Sin `BOOKING_WEB_DEMO_ENABLED`, esto lanza y no abre
 * ningún socket. `buildBookingWebServer` sigue funcionando para las pruebas,
 * porque construir no es escuchar.
 */
export async function startBookingWebServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedBookingWebServer> {
  const config = loadBookingWebConfig(env);
  requireBookingWebEnabled(config);
  const app = buildBookingWebServer({ port: config.port });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE") {
      throw new Error(
        `El puerto ${String(config.port)} ya está en uso. Esta demostración NO cambia de puerto en silencio: ` +
          `libera el puerto ${String(config.port)} o arráncala con BOOKING_WEB_PORT=<otro puerto libre>. ` +
          `El puerto 3000 pertenece a un proceso ajeno de este equipo y no debe usarse ni tocarse nunca.`,
      );
    }
    throw err;
  }
  return { app, config };
}
