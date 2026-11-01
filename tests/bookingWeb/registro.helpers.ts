import type { ServiceId } from "../../src/callEngine/domain/types.js";
import { buildTenantRegistry, type TenantDefinition } from "../../src/bookingWeb/tenants.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * DERIVAR NO ES COINCIDIR.
 *
 * Una prueba que compara «los servicios de la portada» con «los servicios del
 * núcleo» y los ve iguales no ha demostrado que la portada los DERIVE: ha
 * demostrado que hoy coinciden. El día que alguien escriba a fuego la lista de
 * precios en la plantilla, esa prueba seguirá en verde hasta que el catálogo
 * cambie — y entonces habrá dos verdades y la que ve el cliente será la falsa.
 * Es el mismo error de forma que «93 pruebas verdes con la página inerte».
 *
 * La única manera de convertir «coincide» en «deriva» es CAMBIAR EL NÚCLEO y
 * ver moverse la pantalla. Eso es lo que sirven estas ayudas: un registro de
 * locales alterado a propósito —un precio imposible, una duración distinta, un
 * nombre inventado— que se le pasa a `buildBookingWebServer({ registry })`. Si
 * la portada no cambia con él, es que la portada no lo estaba leyendo.
 *
 * NO PASAN POR EL VALIDADOR, y es deliberado: `assertTenantContentIsComplete`
 * corre dentro de `buildTenantRegistry()`, no en la construcción del servidor.
 * Así una prueba puede servir un local con una carga hostil en el copy —para
 * comprobar el escape— sin que el arranque lo rechace antes. El validador tiene
 * su propio fichero (`contenidoPublicoValidado.test.ts`).
 * ────────────────────────────────────────────────────────────────────────
 */

/** El local del registro real, para partir de algo verdadero y cambiar UNA cosa. */
export function localDelRegistro(tenantId: string): TenantDefinition {
  const tenant = buildTenantRegistry().get(tenantId);
  if (!tenant) throw new Error(`El registro no conoce el local «${tenantId}».`);
  return tenant;
}

/**
 * Un registro COMPLETO en el que un local ha pasado por `cambio`. Los demás
 * locales siguen intactos: así una misma prueba puede comprobar que el alterado
 * cambia y que el otro no se entera.
 */
export function registroCambiando(
  tenantId: string,
  cambio: (tenant: TenantDefinition) => TenantDefinition,
): ReadonlyMap<string, TenantDefinition> {
  const registro = buildTenantRegistry();
  const original = registro.get(tenantId);
  if (!original) throw new Error(`El registro no conoce el local «${tenantId}».`);
  return new Map([...registro].map(([id, t]) => [id, id === tenantId ? cambio(original) : t]));
}

/** El mismo local con OTRO precio para un servicio suyo. */
export function conPrecio(
  tenant: TenantDefinition,
  serviceId: ServiceId,
  priceCents: number,
): TenantDefinition {
  return {
    ...tenant,
    services: tenant.services.map((s) => (s.serviceId === serviceId ? { ...s, priceCents } : s)),
  };
}

/** El mismo local con OTRA duración para un servicio suyo. */
export function conDuracion(
  tenant: TenantDefinition,
  serviceId: ServiceId,
  durationMinutes: number,
): TenantDefinition {
  return {
    ...tenant,
    services: tenant.services.map((s) => (s.serviceId === serviceId ? { ...s, durationMinutes } : s)),
  };
}

/** El mismo local con OTRO nombre visible para una de sus personas. */
export function conNombreDePersona(
  tenant: TenantDefinition,
  employeeId: number,
  displayName: string,
): TenantDefinition {
  return {
    ...tenant,
    employees: tenant.employees.map((e) => (e.employeeId === employeeId ? { ...e, displayName } : e)),
  };
}

/**
 * LAS CLAVES QUE NO SON TEXTO LIBRE, y por tanto no se tocan al reescribir el
 * copy de un local en bloque.
 *
 * No es una comodidad: son UNIONES CERRADAS del modelo —`TenantThemeId`,
 * `TenantBrandLogo["kind"]`, `BrandAssetFile`, `PublicSectionId`,
 * `HeroEmblemId`— o el propio identificador del local. Ninguna llega nunca al
 * documento como prosa: el tema indexa una tabla de colores, la forma del
 * distintivo elige una rama, el fichero indexa un registro cerrado de rutas, el
 * destino de un enlace indexa la tabla de identificadores de sección y el
 * emblema indexa la tabla de SVG del hero. Cambiarlas no probaría el escape de
 * texto; probaría qué pasa al romper un tipo, que es otra cosa y no compila.
 *
 * `heroEmblem` SE AÑADIÓ TARDE (2026-08-26), y conviene que quede escrito por
 * qué importa. Mientras faltó, reescribir el copy en bloque dejaba al local con
 * un identificador de emblema que no existe en `HERO_EMBLEMS`, así que la
 * página servida a las pruebas de carga hostil se quedaba SIN el SVG del hero
 * —un trozo del documento que esas pruebas creían estar barriendo y no
 * estaban—. El `?? ""` de `heroEmblemSvg` (en `ui.sections.ts`) sigue ahí y
 * sigue haciendo falta: es el TIRANTE, para que un identificador imposible no
 * imprima «undefined» en la portada. Esta clave es el CINTURÓN, para que el
 * identificador imposible no llegue a existir. Cumplen cosas distintas.
 *
 * REGLA AL AÑADIR UN CAMPO NUEVO al modelo público: si su tipo es una unión de
 * literales, su clave va aquí; si es prosa, no.
 */
export const CLAVES_DE_UNION_CERRADA = new Set([
  "theme",
  "kind",
  "assetFile",
  "target",
  "tenantId",
  "heroEmblem",
]);

/**
 * Reescribe TODA cadena de una estructura, recorriendo sus claves en vez de
 * enumerarlas a mano. Es lo que permite que una prueba de inyección cubra los
 * campos de copy que se añadan mañana sin que nadie se acuerde de apuntarlos.
 */
export function reemplazarTextos<T>(valor: T, nuevo: (original: string, ruta: string) => string, ruta = ""): T {
  if (typeof valor === "string") return nuevo(valor, ruta) as unknown as T;
  if (Array.isArray(valor)) {
    return valor.map((v, i) => reemplazarTextos(v, nuevo, `${ruta}[${String(i)}]`)) as unknown as T;
  }
  if (valor !== null && typeof valor === "object") {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
      salida[clave] = CLAVES_DE_UNION_CERRADA.has(clave)
        ? v
        : reemplazarTextos(v, nuevo, ruta === "" ? clave : `${ruta}.${clave}`);
    }
    return salida as unknown as T;
  }
  return valor;
}

/**
 * El mismo local con TODO su texto público reescrito: nombre visible, marca y
 * bloque de contenido. Se usa para dos cosas distintas y complementarias:
 * meter una carga hostil en cada campo a la vez, y fabricar un local SIN
 * vocabulario propio con el que averiguar qué palabras pone la plantilla.
 */
export function conTodoElTextoReescrito(
  tenant: TenantDefinition,
  nuevo: (original: string, ruta: string) => string,
): TenantDefinition {
  return {
    ...tenant,
    displayName: nuevo(tenant.displayName, "displayName"),
    brand: reemplazarTextos(tenant.brand, nuevo, "brand"),
    content: reemplazarTextos(tenant.content, nuevo, "content"),
  };
}

/** El mismo local con OTRA lista de capacidades para una de sus personas. */
export function conCapacidades(
  tenant: TenantDefinition,
  employeeId: number,
  serviceIds: readonly ServiceId[],
): TenantDefinition {
  return {
    ...tenant,
    employees: tenant.employees.map((e) => (e.employeeId === employeeId ? { ...e, serviceIds } : e)),
  };
}
