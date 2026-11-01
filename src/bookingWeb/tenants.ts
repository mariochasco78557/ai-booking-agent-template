import type { CalendarWithCapabilities } from "../callEngine/capabilities.js";
import type { ServiceId } from "../callEngine/domain/types.js";
import { SERVICE_LABELS } from "../callEngine/domain/types.js";
import { DEMO_DOS_CONTENT } from "./content/demoDos.content.js";
import { BOOKING_DEMO_CONTENT } from "./content/demoSalonDemo.content.js";
import { assertTenantContentIsComplete } from "./content/validate.js";
import {
  BOOKING_DEMO_EMPLOYEES,
  BOOKING_DEMO_TODAY,
  bookingDemoVenue,
} from "./fixtures/bookingDemoVenue.js";
import {
  SEGUNDO_LOCAL_EMPLOYEES,
  SEGUNDO_LOCAL_TODAY,
  segundoLocalVenue,
} from "./fixtures/segundoLocalVenue.js";
import type {
  DemoEmployee,
  ServiceCatalogEntry,
  TenantBrand,
  TenantPublicContent,
} from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL REGISTRO DE LOCALES, Y EL ÚNICO SITIO DE TODA LA CAPA QUE CONOCE DINERO.
 *
 * Los precios y las duraciones viven AQUÍ, por local, y no en
 * `src/callEngine/**`: el motor de calendario no sabe cuánto cuesta nada, y no
 * debe aprenderlo nunca (`domain/types.ts` lo dice con todas las letras:
 * «Never add prices here»). Reutilizamos el motor entero sin tocarle una línea
 * precisamente porque el precio no es asunto suyo.
 *
 * EL AISLAMIENTO ES ESTRUCTURAL, NO UNA COSTUMBRE. `tenantId` es la clave de
 * absolutamente todo el estado (reservas, pagos, idempotencia) y ninguna
 * consulta de este módulo ni del almacén acepta una lista de locales: se
 * resuelve UNO y se trabaja con UNO. Una consulta que cruce locales no es que
 * esté prohibida, es que no hay ninguna función capaz de expresarla.
 *
 * LAS ETIQUETAS DE SERVICIO NO SE REESCRIBEN: salen de `SERVICE_LABELS`, del
 * dominio, para que la web y la voz llamen igual a la misma cosa. Lo que sí es
 * de cada local es la DURACIÓN y el PRECIO.
 *
 * Y TAMBIÉN LA MARCA. Desde 2026-08-26 cada local declara aquí su identidad
 * visual (`brand`): título, encabezado, subtítulo, paleta y distintivo. El
 * envoltorio HTML, el cliente y la hoja de estilos siguen siendo UNO SOLO para
 * los dos locales; lo que los distingue en pantalla sale entero de este
 * registro. Antes, «Demo Salon» estaba escrito a fuego en la plantilla común y el
 * segundo local se presentaba con la marca del primero.
 *
 * Y AHORA TAMBIÉN EL CONTENIDO PÚBLICO (`content`). La página que sirve
 * `GET /:tenantId` dejó de ser un asistente pelado y pasó a ser la web del
 * local: portada, servicios contados, fichas del equipo, información práctica y
 * preguntas frecuentes. Ese texto es CONFIGURACIÓN DE ESTE REGISTRO y de ningún
 * otro sitio —ni de la plantilla, ni del cliente, ni de la hoja de estilos—,
 * porque en cuanto una frase se escribe en la plantilla deja de haber dos
 * locales y pasa a haber un local y una copia suya.
 *
 * LO QUE `content` NO PUEDE CONTENER es precisamente lo que ya vive aquí al
 * lado: un precio, una duración o un horario. El catálogo, la matriz de
 * capacidades de cada persona y los horarios semanales del calendario son la
 * única verdad, y la pantalla los recibe DERIVADOS. Un copy que los repitiera
 * sería una segunda verdad condenada a desviarse de la primera.
 *
 * POR ESO SE VALIDA AL CONSTRUIR. `buildTenantRegistry()` pasa cada local por
 * `assertTenantContentIsComplete` ANTES de devolver el registro, y ese
 * validador revienta ruidosamente: exige la biyección entre el catálogo y su
 * presentación, entre las personas y sus fichas, y rechaza cualquier texto que
 * escriba a mano un importe, una duración o una hora de reloj. La postura es la
 * misma que la de la lectura del activo de marca —morir en el arranque antes de
 * que exista una ruta— y, como esta función la llama todo el mundo, un local
 * mal declarado pone en rojo la suite entera y no una prueba aislada que
 * alguien pudiera borrar.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Identificador del local principal de la demostración. */
export const TENANT_BOOKING_DEMO = "demo-salon-demo";

/** Identificador del segundo local, que sólo existe para probar el aislamiento. */
export const TENANT_DEMO_DOS = "demo-dos";

export interface TenantDefinition {
  tenantId: string;
  displayName: string;
  /** La identidad visual PROPIA de este local: ver `TenantBrand` en `model.ts`. */
  brand: TenantBrand;
  /** Catálogo PROPIO: mismas etiquetas de servicio, precios y duraciones de este local. */
  services: readonly ServiceCatalogEntry[];
  employees: readonly DemoEmployee[];
  calendar: CalendarWithCapabilities;
  /** El «hoy» sintético de este local. Ninguna ruta lee el reloj real. */
  demoToday: string;
  /**
   * EL COPY DE LA WEB PÚBLICA DE ESTE LOCAL: ver `TenantPublicContent` en
   * `model.ts`. Sólo presentación. Ni un precio, ni una duración, ni una hora,
   * ni la lista de servicios de nadie: eso ya está arriba y llega derivado.
   */
  content: TenantPublicContent;
}

/**
 * LO ÚNICO QUE VE LA PLANTILLA. `renderBookingHtml` recibe esto y no la
 * definición entera: desde el envoltorio HTML no se puede leer un precio, un
 * horario ni una persona ni por accidente, porque no están en el tipo. El
 * catálogo y la disponibilidad siguen llegando a la pantalla como llegaban,
 * pedidos por el cliente a `/api/:tenantId/…`.
 *
 * Una `TenantDefinition` vale como `TenantBrandView` tal cual, sin conversión.
 */
export type TenantBrandView = Pick<TenantDefinition, "tenantId" | "brand">;

/**
 * LA MARCA DEL LOCAL PRINCIPAL. Conserva su identidad de siempre: su PNG
 * versionado (`assets/brand/demo-salon-logo.png`, servido por
 * `GET /brand/demo-salon-demo/logo.png`) y su paleta de cobre sobre marfil.
 */
const BOOKING_DEMO_BRAND: TenantBrand = {
  title: "Demo Salon — Reserva tu cita",
  heading: "Reserva tu cita en Demo Salon",
  tagline: "Elige servicio, profesional y hora. Sin esperas.",
  theme: "demo-salon",
  monogram: "TX",
  logo: {
    kind: "asset",
    assetFile: "demo-salon-logo.png",
    alt: "Demo Salon",
    /**
     * LAS DIMENSIONES INTRÍNSECAS DEL FICHERO, y no el tamaño al que se pinta.
     * El PNG versionado es cuadrado, de cuatrocientos por cuatrocientos.
     * Declarar aquí el tamaño de pantalla —como se hacía antes, con una
     * proporción apaisada que el fichero no tiene— obligaba al navegador a
     * encajar un cuadrado en ella, lo dejaba ilegible y, de paso, reservaba una
     * caja del alto equivocado: al cargar la imagen, la composición saltaba.
     *
     * `width`/`height` sirven para que el navegador reserve el hueco con la
     * PROPORCIÓN correcta antes de descargar nada. A qué tamaño se ve lo decide
     * la hoja de estilos, que es donde vive la escala de la interfaz.
     */
    width: 400,
    height: 400,
  },
};

/**
 * LA MARCA DEL SEGUNDO LOCAL, que es SUYA y no una copia de la del primero.
 *
 * El distintivo es TIPOGRÁFICO a propósito: un monograma («PA») y el nombre
 * escrito, compuestos con texto real del documento y estilo de `ui.css.ts`. No
 * se ha añadido ningún activo binario nuevo al repositorio —ni se ha
 * inventado un logotipo de una peluquería que no existe—, y de paso el
 * distintivo es seleccionable, escalable y legible por un lector de pantalla.
 * El monograma va decorativo (`aria-hidden`) porque el nombre completo va al
 * lado: leerlo dos veces sería ruido.
 */
const DEMO_DOS_BRAND: TenantBrand = {
  title: "Peluquería Aralar — Reserva tu cita",
  heading: "Reserva tu cita en Aralar",
  tagline: "Elige servicio, profesional y hora. Te esperamos en Aralar.",
  theme: "aralar",
  monogram: "PA",
  logo: {
    kind: "wordmark",
    initials: "PA",
    text: "Peluquería Aralar (demo)",
  },
};

/**
 * EL CATÁLOGO DEL LOCAL PRINCIPAL.
 *
 * El de 60 minutos («Corte y barba») existe A PROPÓSITO: es lo que demuestra
 * que la duración condiciona el último inicio de cada tramo del día. Con el
 * horario de martes a viernes (09:00–14:00 y 16:00–19:00) el último inicio de
 * la mañana es 13:00 y el de la tarde 18:00, y ese 13:00 no está escrito en
 * ninguna constante: sale de restarle 60 minutos al final del tramo dentro de
 * `freeStartsForDuration`.
 */
const BOOKING_DEMO_SERVICES: readonly ServiceCatalogEntry[] = [
  { serviceId: 0, label: SERVICE_LABELS[0], durationMinutes: 30, priceCents: 1200 },
  { serviceId: 1, label: SERVICE_LABELS[1], durationMinutes: 30, priceCents: 1800 },
  { serviceId: 2, label: SERVICE_LABELS[2], durationMinutes: 60, priceCents: 2800 },
];

/**
 * EL CATÁLOGO DEL SEGUNDO LOCAL. Los tres precios son distintos de los del
 * principal (el requisito era «al menos uno»), porque dos locales que cobran
 * exactamente lo mismo no permiten ver de un vistazo, en una respuesta, cuál de
 * los dos la produjo.
 */
const DEMO_DOS_SERVICES: readonly ServiceCatalogEntry[] = [
  { serviceId: 0, label: SERVICE_LABELS[0], durationMinutes: 30, priceCents: 1000 },
  { serviceId: 1, label: SERVICE_LABELS[1], durationMinutes: 30, priceCents: 1500 },
  { serviceId: 2, label: SERVICE_LABELS[2], durationMinutes: 60, priceCents: 2400 },
];

/**
 * Construye el registro COMPLETO, ya resuelto. Es una función y no una
 * constante de módulo para que cada proceso —y cada prueba— arranque con
 * calendarios recién construidos y jamás compartidos por referencia entre
 * servidores distintos.
 *
 * Y ES LA PUERTA DEL CONTENIDO PÚBLICO: ningún local sale de aquí sin haber
 * pasado por `assertTenantContentIsComplete`. Se valida al construir, y no al
 * pintar, porque una ficha que falta o un importe escrito a mano en el copy son
 * un defecto de configuración, no un accidente de una petición: tiene que matar
 * el arranque entero, no ensuciar una pestaña del navegador.
 */
export function buildTenantRegistry(): ReadonlyMap<string, TenantDefinition> {
  const tenants: TenantDefinition[] = [
    {
      tenantId: TENANT_BOOKING_DEMO,
      displayName: "Demo Salon (demo)",
      brand: BOOKING_DEMO_BRAND,
      services: BOOKING_DEMO_SERVICES,
      employees: BOOKING_DEMO_EMPLOYEES,
      calendar: bookingDemoVenue(),
      demoToday: BOOKING_DEMO_TODAY,
      content: BOOKING_DEMO_CONTENT,
    },
    {
      tenantId: TENANT_DEMO_DOS,
      displayName: "Peluquería Aralar (demo)",
      brand: DEMO_DOS_BRAND,
      services: DEMO_DOS_SERVICES,
      employees: SEGUNDO_LOCAL_EMPLOYEES,
      calendar: segundoLocalVenue(),
      demoToday: SEGUNDO_LOCAL_TODAY,
      content: DEMO_DOS_CONTENT,
    },
  ];

  for (const t of tenants) {
    assertTenantContentIsComplete({
      tenantId: t.tenantId,
      services: t.services,
      employees: t.employees,
      content: t.content,
    });
  }

  return new Map(tenants.map((t) => [t.tenantId, t]));
}

/** Todos los identificadores conocidos, en orden estable. */
export function tenantIds(registry: ReadonlyMap<string, TenantDefinition>): readonly string[] {
  return [...registry.keys()];
}

/** El servicio del catálogo DE ESE LOCAL, o `undefined`. Nunca mira el catálogo de otro. */
export function findService(
  tenant: TenantDefinition,
  serviceId: ServiceId,
): ServiceCatalogEntry | undefined {
  return tenant.services.find((s) => s.serviceId === serviceId);
}

/** La persona DE ESE LOCAL, o `undefined`. */
export function findEmployee(tenant: TenantDefinition, employeeId: number): DemoEmployee | undefined {
  return tenant.employees.find((e) => e.employeeId === employeeId);
}

/** Si esa persona de ese local sabe hacer ese servicio, según su propia declaración. */
export function employeeCanPerform(employee: DemoEmployee, serviceId: ServiceId): boolean {
  return employee.serviceIds.includes(serviceId);
}
