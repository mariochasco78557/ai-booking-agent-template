import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

import { buildBookingWebServer } from "../../src/bookingWeb/server.js";
import { createBookingStore } from "../../src/bookingWeb/store.js";
import { buildTenantRegistry, type TenantDefinition } from "../../src/bookingWeb/tenants.js";
import type { FakeDocument, FakeElement } from "./fakeDom.js";
import { parseHtmlDocument } from "./htmlParse.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LA CADENA ENTERA, EN UN SOLO SITIO.
 *
 * Todo lo que las pruebas de la web pública necesitan para abrir una página
 * como la abre un navegador vive aquí, y no copiado en cada fichero:
 *
 *   HTML servido → etiqueta <script> del propio documento → ese `src` pedido
 *   al servidor → ejecución de ese JavaScript contra el DOM ANALIZADO.
 *
 * TRES REGLAS QUE ESTE FICHERO IMPONE A QUIEN LO USE:
 *
 *   1. El DOM se ANALIZA del HTML real (`htmlParse.ts`). Nunca se escribe a
 *      mano. Si al HTML le falta un nodo, aquí falta.
 *   2. La ruta del script SALE DEL PROPIO DOCUMENTO: la cadena "/app.js" no
 *      aparece escrita en ninguna prueba. Si el documento no referencia nada,
 *      no hay nada que pedir y la prueba se cae sola. Ése fue el defecto del
 *      2026-08-26 y por eso se comprueba en el primer paso de cada apertura.
 *   3. `fetch` es lo ÚNICO puenteado, contra `app.inject()` del servidor REAL,
 *      para no abrir un socket. Y queda REGISTRADO: toda prueba puede
 *      preguntar a qué rutas ha llamado el cliente.
 * ────────────────────────────────────────────────────────────────────────
 */

export interface OpcionesDeFetch {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface RespuestaDeFetch {
  status: number;
  json: () => Promise<unknown>;
}

/** Un servidor recién construido, con su propio almacén y su propio registro. */
export function freshApp(registry?: ReadonlyMap<string, TenantDefinition>): FastifyInstance {
  return buildBookingWebServer({
    store: createBookingStore(),
    registry: registry ?? buildTenantRegistry(),
  });
}

/**
 * Puentea `fetch(url, opts)` a `app.inject()`, tal y como lo llama `ui.js.ts`,
 * y APUNTA cada URL en `registro`. Ese registro es lo que permite afirmar dos
 * cosas que ningún barrido de texto puede: que el cliente no habla con nadie de
 * fuera, y que nunca pregunta por un par servicio/profesional imposible.
 */
export function fetchBridge(
  app: FastifyInstance,
  registro?: string[],
): (url: string, opts?: OpcionesDeFetch) => Promise<RespuestaDeFetch> {
  return async (url: string, opts?: OpcionesDeFetch): Promise<RespuestaDeFetch> => {
    registro?.push(url);
    const res = await app.inject({
      method: (opts?.method as "GET" | "POST" | undefined) ?? "GET",
      url,
      payload: opts?.body,
      headers: opts?.headers,
    });
    return { status: res.statusCode, json: async () => res.json() as unknown };
  };
}

/**
 * Espera a que se cumpla una condición cediendo el turno al bucle de eventos.
 * El arranque del cliente (`init()` → `GET /bootstrap` → pintar) es asíncrono y
 * aquí NO se tiene su promesa: la dispara el propio script al ejecutarse, igual
 * que en un navegador.
 *
 * Toda espera va SEGUIDA de una comparación exacta contra el servidor: esperar
 * a que «haya algo pintado» no prueba que sea lo correcto.
 */
export async function esperarA(
  condicion: () => boolean,
  queSeEsperaba: string,
  intentos = 200,
): Promise<void> {
  for (let i = 0; i < intentos; i += 1) {
    if (condicion()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Se agotó la espera de: ${queSeEsperaba}`);
}

/** El nodo con ese id, o un error que dice exactamente qué falta en el HTML servido. */
export function byId(document: FakeDocument, id: string): FakeElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`El HTML servido no contiene ningún elemento con id «${id}».`);
  return node;
}

/** El HTML de un local, tal y como sale por la ruta real. */
export async function paginaDe(app: FastifyInstance, tenantId: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: `/${tenantId}` });
  expect(res.statusCode, `GET /${tenantId}`).toBe(200);
  return res.body;
}

/** El documento ANALIZADO de un local. Sin ejecutar el cliente. */
export async function documentoDe(app: FastifyInstance, tenantId: string): Promise<FakeDocument> {
  return parseHtmlDocument(await paginaDe(app, tenantId));
}

export interface PaginaCargada {
  app: FastifyInstance;
  tenantId: string;
  document: FakeDocument;
  /** La ruta del script tal y como venía escrita en el HTML servido. */
  srcDelScript: string;
  /** TODAS las URL por las que el cliente ha pasado, en orden. */
  urlsPedidas: string[];
}

export interface OpcionesDeApertura {
  /** Para compartir servidor (y almacén) entre dos páginas de la misma prueba. */
  app?: FastifyInstance;
  /** Para abrir con un registro alterado y demostrar que la página DERIVA. */
  registry?: ReadonlyMap<string, TenantDefinition>;
}

/**
 * Hace lo que hace un navegador al abrir `/:tenantId`, en este orden:
 *   a) pide el HTML real,
 *   b) lo ANALIZA para construir el DOM,
 *   c) busca en ese DOM la etiqueta `<script>` y le pide su `src` al servidor,
 *   d) ejecuta ese JavaScript contra el DOM analizado.
 *
 * El documento nace con `readyState === "interactive"`, que es el estado en el
 * que un navegador ejecuta un `<script defer>`: el árbol ya está completo, así
 * que el cliente arranca SOLO. Nadie llama a `init()` aquí.
 */
export async function abrirPagina(
  tenantId: string,
  opciones: OpcionesDeApertura = {},
): Promise<PaginaCargada> {
  const app = opciones.app ?? freshApp(opciones.registry);

  // (a) el HTML REAL, por la ruta real.
  const pagina = await app.inject({ method: "GET", url: `/${tenantId}` });
  expect(pagina.statusCode).toBe(200);

  // (b) el DOM, ANALIZADO de ese HTML — no escrito a mano.
  const document = parseHtmlDocument(pagina.body);

  // (c) la referencia al script sale del documento, nunca de esta prueba.
  const scripts = document.querySelectorAll("script");
  expect(
    scripts.length,
    "el HTML servido no referencia ningún <script>: la página se pintaría entera y quedaría inerte",
  ).toBe(1);
  const src = scripts[0]?.getAttribute("src");
  expect(src, "la etiqueta <script> del HTML servido no tiene src").toBeTruthy();
  const srcDelScript = src as string;

  const cliente = await app.inject({ method: "GET", url: srcDelScript });
  expect(
    cliente.statusCode,
    `el HTML referencia «${srcDelScript}», pero el servidor no sirve esa ruta`,
  ).toBe(200);

  // (d) el TEXTO EXACTO que sirve esa ruta, ejecutado contra el DOM analizado.
  const urlsPedidas: string[] = [];
  const ejecutar = new Function("document", "window", "fetch", cliente.body) as (
    doc: FakeDocument,
    win: Record<string, unknown>,
    f: ReturnType<typeof fetchBridge>,
  ) => void;
  ejecutar(document, {}, fetchBridge(app, urlsPedidas));

  return { app, tenantId, document, srcDelScript, urlsPedidas };
}

/**
 * Abre la página y espera a que el asistente esté PINTADO con lo que dice el
 * servidor: el catálogo en la rejilla del paso 1. Antes de eso la página está
 * viva pero vacía, y una prueba que actuara ahí estaría midiendo el arranque.
 */
export async function abrirPaginaLista(
  tenantId: string,
  opciones: OpcionesDeApertura = {},
): Promise<PaginaCargada> {
  const pagina = await abrirPagina(tenantId, opciones);
  await esperarA(
    () => byId(pagina.document, "txb-servicios-grid").children.length > 0,
    `los servicios de «${tenantId}» pintados en la rejilla del paso 1`,
  );
  return pagina;
}

/** El cuerpo de `/api/:tenantId/bootstrap`, ya tipado con lo que las pruebas usan. */
export interface BootstrapShape {
  tenantId: string;
  demoToday: string;
  bookingHorizonDays: number;
  services: Array<{
    serviceId: number;
    label: string;
    priceLabel: string;
    /**
     * La duración YA ESCRITA por el servidor. Viaja formateada, como el precio,
     * porque el cliente componiéndola a mano («60 min») contradecía a la portada
     * («1 h») en la misma pantalla.
     */
    durationLabel: string;
    durationMinutes: number;
  }>;
  employees: Array<{ employeeId: number; displayName: string; serviceIds: number[] }>;
}

export async function bootstrapDe(app: FastifyInstance, tenantId: string): Promise<BootstrapShape> {
  const res = await app.inject({ method: "GET", url: `/api/${tenantId}/bootstrap` });
  expect(res.statusCode, `GET /api/${tenantId}/bootstrap`).toBe(200);
  return res.json() as BootstrapShape;
}

/** Los CTA de ficha de servicio de la portada, en orden de documento. */
export function ctasDeServicio(document: FakeDocument): FakeElement[] {
  return document.querySelectorAll(".txb-cta-servicio");
}

/** Los CTA de ficha de equipo de la portada, en orden de documento. */
export function ctasDeProfesional(document: FakeDocument): FakeElement[] {
  return document.querySelectorAll(".txb-cta-profesional");
}

/** El CTA de ESE servicio — nunca «el primero de la lista». */
export function ctaDelServicio(document: FakeDocument, serviceId: number): FakeElement {
  const boton = ctasDeServicio(document).find(
    (b) => b.getAttribute("data-service-id") === String(serviceId),
  );
  if (!boton) throw new Error(`La portada no tiene ningún CTA para el servicio ${String(serviceId)}.`);
  return boton;
}

/** El CTA de ESA persona — ídem. */
export function ctaDelProfesional(document: FakeDocument, employeeId: number): FakeElement {
  const boton = ctasDeProfesional(document).find(
    (b) => b.getAttribute("data-employee-id") === String(employeeId),
  );
  if (!boton) throw new Error(`La portada no tiene ningún CTA para la persona ${String(employeeId)}.`);
  return boton;
}
