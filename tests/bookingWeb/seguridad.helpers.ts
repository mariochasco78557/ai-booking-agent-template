import type { FakeDocument, FakeElement } from "./fakeDom.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LAS DOS COMPROBACIONES DE SEGURIDAD QUE SE REPITEN, ESCRITAS UNA VEZ.
 *
 * 1. EL BARRIDO DE URL, POSICIONAL. Hasta hoy la garantía «esta página no le
 *    pide nada a nadie» se sostenía con `expect(html).not.toMatch(/https?:\/\//)`
 *    sobre el texto. Con SVG en línea y un icono por local esa regla habría
 *    tenido que relajarse por el `xmlns` —y la forma cómoda de relajarla es un
 *    `replace` global que deja pasar cualquier URL que alguien escriba con esa
 *    misma cadena—. Aquí se hace al revés: se recorre el DOCUMENTO ANALIZADO
 *    atributo a atributo, se exige que TODO valor de URL empiece por `#` o por
 *    `/` (nunca por `//` ni por un esquema), y el espacio de nombres de SVG se
 *    admite ÚNICAMENTE en un atributo que se llame `xmlns` o empiece por
 *    `xmlns:`. Un `http://` en cualquier otro sitio sigue siendo un fallo.
 *
 * 2. LOS ORÍGENES DE LA CSP. La política se compara entera con `toBe` en cada
 *    ruta, pero además interesa lo que PERMITE: el conjunto de orígenes tiene
 *    que ser exactamente `'none'` y `'self'`. El extractor vive aquí para que
 *    haya uno solo y para poder probarlo contra una política DEBILITADA a
 *    propósito: si el extractor se rompiera, todas las afirmaciones sobre la
 *    CSP pasarían a ser vacías y nadie lo notaría.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Los atributos por los que un documento puede pedir —o mandar— algo. `content`
 * queda fuera a propósito: sólo es una URL en `<meta http-equiv="refresh">`, y
 * ese elemento está prohibido de por sí (se comprueba aparte).
 */
export const ATRIBUTOS_DE_URL = [
  "src",
  "href",
  "action",
  "formaction",
  "data",
  "poster",
  "srcset",
  "cite",
  "ping",
  "background",
  "xlink:href",
] as const;

/** Los dos únicos espacios de nombres de SVG, y sólo como valor de `xmlns*`. */
export const ESPACIOS_DE_NOMBRES_PERMITIDOS = [
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
];

export interface UrlDelDocumento {
  /** Etiqueta del elemento que la lleva, para que el fallo diga dónde mirar. */
  etiqueta: string;
  atributo: string;
  valor: string;
}

/** Todas las URL que el documento referencia, con su elemento y su atributo. */
export function urlsDelDocumento(document: FakeDocument): UrlDelDocumento[] {
  const raiz = document.documentElement ?? document.body;
  const salida: UrlDelDocumento[] = [];
  for (const nodo of [raiz, ...raiz.descendants()]) {
    for (const atributo of nodo.getAttributeNames()) {
      if (!(ATRIBUTOS_DE_URL as readonly string[]).includes(atributo)) continue;
      salida.push({
        etiqueta: nodo.tagName.toLowerCase(),
        atributo,
        valor: nodo.getAttribute(atributo) ?? "",
      });
    }
  }
  return salida;
}

/** Cualquier esquema: `http`, `https`, `data`, `blob`, `javascript`, `mailto`, `tel`, `ftp`, `ws`… */
export const CUALQUIER_ESQUEMA = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Una URL es aceptable si —y sólo si— es un ancla interna (`#…`) o una ruta
 * absoluta de ESTE origen (`/…`, nunca `//…`, que es protocolo-relativa y sale
 * fuera).
 */
export function motivoDeUrlInaceptable(valor: string): string | null {
  if (valor.startsWith("#")) return null;
  if (valor.startsWith("//")) return "es protocolo-relativa (`//`), así que sale de este origen";
  if (CUALQUIER_ESQUEMA.test(valor)) return "lleva un esquema";
  if (valor.startsWith("/")) return null;
  return "no empieza ni por `#` ni por `/`";
}

export interface AtributoDeEspacioDeNombres {
  etiqueta: string;
  atributo: string;
  valor: string;
}

/** Todos los `xmlns`/`xmlns:*` del documento, con el elemento que los lleva. */
export function espaciosDeNombresDelDocumento(document: FakeDocument): AtributoDeEspacioDeNombres[] {
  const raiz = document.documentElement ?? document.body;
  const salida: AtributoDeEspacioDeNombres[] = [];
  for (const nodo of [raiz, ...raiz.descendants()]) {
    for (const atributo of nodo.getAttributeNames()) {
      if (atributo !== "xmlns" && !atributo.startsWith("xmlns:")) continue;
      salida.push({
        etiqueta: nodo.tagName.toLowerCase(),
        atributo,
        valor: nodo.getAttribute(atributo) ?? "",
      });
    }
  }
  return salida;
}

/** Todos los elementos del documento, incluida la raíz. */
export function todosLosElementos(document: FakeDocument): FakeElement[] {
  const raiz = document.documentElement ?? document.body;
  return [raiz, ...raiz.descendants()];
}

/**
 * El conjunto de ORÍGENES que una CSP permite: cada directiva menos su nombre.
 * Para `default-src 'none'; script-src 'self'` devuelve `["'none'", "'self'"]`.
 */
export function origenesDeCsp(csp: string): string[] {
  const origenes = csp
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .flatMap((d) => d.split(/\s+/).slice(1));
  return [...new Set(origenes)].sort();
}

/** ¿Permite esta política algún origen que no sea `'none'` o `'self'`? */
export function cspSoloPermiteSelf(csp: string): boolean {
  return origenesDeCsp(csp).every((o) => o === "'none'" || o === "'self'");
}
