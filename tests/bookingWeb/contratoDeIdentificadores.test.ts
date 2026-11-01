import { describe, expect, it } from "vitest";

import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import { renderBookingAppJs } from "../../src/bookingWeb/ui.js.js";
import type { FakeDocument } from "./fakeDom.js";
import { documentoDe, freshApp } from "./paginaViva.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * EL CONTRATO ENTRE EL CLIENTE Y LA PLANTILLA.
 *
 * ESTE ES EL AGUJERO QUE SEGUÍA ABIERTO. El defecto del 2026-08-26 —la página
 * servida sin `<script>`— lo cierra `paginaViva.test.ts`. Pero quedaba otro,
 * de la misma familia y más silencioso: NADIE COMPROBABA QUE CADA
 * IDENTIFICADOR QUE EL CLIENTE BUSCA EXISTA EN EL HTML SERVIDO. Si `ui.js.ts`
 * lee `byId('txb-nav-toggle')` y la plantilla no lo emite, `byId` devuelve
 * `null` y el cliente revienta en el primer clic —o, peor, se calla y deja un
 * control muerto—. Las pruebas de flujo sólo recorren los caminos que recorren:
 * un identificador de un camino que ninguna prueba pisa no lo miraba nadie.
 *
 * Con la web pública el cliente pasó a leer una docena de identificadores
 * nuevos (cajón, menú móvil, CTA de página), así que el agujero dejó de ser
 * teórico. Este fichero lo cierra DERIVANDO el inventario del propio cliente,
 * en vez de mantener una lista a mano — que es justo el tipo de lista que se
 * desincroniza en silencio, y por lo que se ha borrado
 * `createBookingFakeDocument`.
 *
 * ────────────────────────────────────────────────────────────────────────
 * CÓMO SE EXTRAE EL INVENTARIO SIN MENTIR EN NINGUNA DE LAS DOS DIRECCIONES
 *
 * Las dos extracciones ingenuas fallan, cada una por un lado:
 *
 *  · Recoger sólo los literales de `byId('…')` DEJA FUERA OCHO. Cuatro
 *    (`txb-paso-servicio`, `txb-paso-profesional`, `txb-paso-fecha-hora`,
 *    `txb-paso-confirmacion`) viajan dentro del array de `showPaso()` y llegan
 *    a `byId` por variable. Los otros cuatro (`…-titulo` de cada paso) viven en
 *    la constante `STEP_HEADING_IDS` y llegan por `focusHeading`. Ocho
 *    identificadores que el cliente necesita y que un extractor así bendice.
 *
 *  · Recoger TODA cadena `'txb-…'` mete OCHO FALSOS POSITIVOS que son clases
 *    CSS: `txb-tile`, `txb-chip`, `txb-day-btn`, `txb-slot-btn`,
 *    `txb-slots-block`, `txb-slots-blocks`, `txb-slots-table` y
 *    `txb-step--done`. Exigir que existan como `id` en el documento pondría la
 *    prueba en rojo por un motivo falso, y el arreglo natural —una lista de
 *    excepciones escrita a mano— vuelve a ser una lista que se desincroniza.
 *
 * La salida es clasificar cada literal POR SU POSICIÓN SINTÁCTICA, que es un
 * hecho del texto y no una opinión: un `'txb-…'` es una CLASE si —y sólo si—
 * aparece en un sitio donde el cliente pone clases (segundo argumento de
 * `el(tag, clase, texto)`, argumento de `classList.add/remove/toggle/contains`,
 * asignación a `className`, o selector con punto delante). Todo lo demás es un
 * IDENTIFICADOR. Así los ocho de `showPaso`/`STEP_HEADING_IDS` entran —no están
 * en ninguna posición de clase— y los ocho de CSS salen, sin una sola excepción
 * escrita a mano.
 *
 * La prueba de que la extracción no miente es doble y está abajo: el recuento
 * exacto (63) y la comprobación de que los ocho que se cuelan por cada lado
 * caen del lado correcto.
 * ════════════════════════════════════════════════════════════════════════
 */

const JS = renderBookingAppJs();

/** Un `'txb-…'` de un solo token. Incluye `__` y `--` para no perder ninguna clase. */
const LITERAL_TXB = /'(txb-[A-Za-z0-9_-]+)'/g;

/**
 * Las cuatro posiciones en las que el cliente escribe una CLASE. Cada una parte
 * su literal por espacios, porque `el('p', 'txb-status-line txb-status-line--error')`
 * declara dos clases de una vez.
 */
function clasesDelCliente(js: string): Set<string> {
  const clases = new Set<string>();
  const anotar = (texto: string, separador: RegExp): void => {
    for (const trozo of texto.split(separador)) if (trozo.length > 0) clases.add(trozo);
  };
  for (const m of js.matchAll(/\bel\(\s*'[^']*'\s*,\s*'([^']*)'/g)) anotar(m[1] ?? "", /\s+/);
  for (const m of js.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*'([^']*)'/g)) {
    anotar(m[1] ?? "", /\s+/);
  }
  for (const m of js.matchAll(/className\s*=\s*'([^']*)'/g)) anotar(m[1] ?? "", /\s+/);
  for (const m of js.matchAll(/querySelector(?:All)?\(\s*'([^']*)'/g)) {
    for (const parte of (m[1] ?? "").split(/[\s,]+/)) {
      if (parte.startsWith(".")) clases.add(parte.slice(1));
    }
  }
  return clases;
}

/** Los identificadores de DOM que el cliente necesita, derivados de su texto. */
function identificadoresDelCliente(js: string): string[] {
  const clases = clasesDelCliente(js);
  const todos = new Set<string>();
  for (const m of js.matchAll(LITERAL_TXB)) todos.add(m[1] as string);
  return [...todos].filter((t) => !clases.has(t)).sort();
}

/**
 * Cada `querySelector`/`querySelectorAll` del cliente, con SU receptor. El
 * receptor importa: `document.querySelectorAll('.txb-cta-servicio')` busca en
 * toda la página, y `menu.querySelectorAll('a')` sólo dentro del menú móvil.
 * Una prueba que buscara los `<a>` en todo el documento pasaría siempre y no
 * diría nada.
 */
function selectoresDelCliente(js: string): string[] {
  const pares = new Set<string>();
  for (const m of js.matchAll(/(\w+)\.querySelector(?:All)?\(\s*'([^']*)'/g)) {
    pares.add(`${m[1] ?? ""} :: ${m[2] ?? ""}`);
  }
  return [...pares].sort();
}

/** Los atributos que el cliente LEE del marcado. */
function atributosLeidosPorElCliente(js: string): string[] {
  const nombres = new Set<string>();
  for (const m of js.matchAll(/getAttribute\(\s*'([^']*)'/g)) nombres.add(m[1] as string);
  return [...nombres].sort();
}

async function documentosDeTodosLosLocales(): Promise<Array<{ tenantId: string; document: FakeDocument }>> {
  const app = freshApp();
  const salida: Array<{ tenantId: string; document: FakeDocument }> = [];
  for (const tenantId of tenantIds(buildTenantRegistry())) {
    salida.push({ tenantId, document: await documentoDe(app, tenantId) });
  }
  return salida;
}

describe("Demostración web · la extracción de identificadores del cliente no miente", () => {
  it("recoge los SESENTA Y TRES que el cliente necesita, ni uno más ni uno menos", () => {
    expect(identificadoresDelCliente(JS)).toHaveLength(63);
  });

  /**
   * Los ocho que un extractor de `byId('…')` se dejaría fuera. Si mañana
   * `showPaso` o `STEP_HEADING_IDS` dejan de existir, esta prueba lo dice; y si
   * alguien simplifica la extracción a los `byId`, se pone roja al instante.
   */
  it("incluye los OCHO que no llegan a byId como literal, sino por array o por constante", () => {
    const ids = identificadoresDelCliente(JS);
    const porVariable = [
      "txb-paso-servicio",
      "txb-paso-profesional",
      "txb-paso-fecha-hora",
      "txb-paso-confirmacion",
      "txb-paso-servicio-titulo",
      "txb-paso-profesional-titulo",
      "txb-paso-fecha-hora-titulo",
      "txb-paso-confirmacion-titulo",
    ];
    for (const id of porVariable) expect(ids, `«${id}» se ha quedado fuera`).toContain(id);

    // Y de verdad NO están escritos dentro de un `byId('…')`: si lo estuvieran,
    // este caso no probaría nada.
    const literalesDeById = new Set(
      [...JS.matchAll(/(?:byId|getElementById)\(\s*'([^']*)'/g)].map((m) => m[1] as string),
    );
    for (const id of porVariable) {
      expect(literalesDeById.has(id), `«${id}» sí aparece en un byId literal`).toBe(false);
    }
  });

  /**
   * Los ocho que un extractor de «toda cadena txb-…» tragaría como si fueran
   * identificadores. Son clases CSS, no existen como `id` en ninguna parte, y
   * exigirlas pondría la suite en rojo por un motivo falso.
   */
  it("excluye los OCHO literales que son CLASES CSS, y lo hace por posición, no por lista", async () => {
    const ids = identificadoresDelCliente(JS);
    const clasesQueParecenIds = [
      "txb-tile",
      "txb-chip",
      "txb-day-btn",
      "txb-slot-btn",
      "txb-slots-block",
      "txb-slots-blocks",
      "txb-slots-table",
      "txb-step--done",
    ];
    for (const clase of clasesQueParecenIds) {
      expect(JS, `«${clase}» ya no aparece en el cliente`).toContain(`'${clase}'`);
      expect(ids, `«${clase}» se ha colado como identificador`).not.toContain(clase);
    }

    // Y la razón por la que excluirlas es correcta: ninguna existe como `id` en
    // el HTML servido de ningún local.
    for (const { tenantId, document } of await documentosDeTodosLosLocales()) {
      for (const clase of clasesQueParecenIds) {
        expect(document.getElementById(clase), `${tenantId} tiene un id «${clase}»`).toBeNull();
      }
    }
  });
});

describe("Demostración web · cada identificador que el cliente busca existe en el HTML servido", () => {
  it("los SESENTA Y TRES existen en los DOS locales, y el fallo nombra al que falta", async () => {
    const ids = identificadoresDelCliente(JS);
    for (const { tenantId, document } of await documentosDeTodosLosLocales()) {
      const ausentes = ids.filter((id) => document.getElementById(id) === null);
      expect(
        ausentes,
        `el cliente busca estos identificadores y «${tenantId}» no los emite: el navegador recibiría null`,
      ).toEqual([]);
    }
  });

  /**
   * LOS SELECTORES, CON SU ÁMBITO. El conjunto se compara ENTERO: si el cliente
   * empieza a usar un selector nuevo, esta prueba se pone roja y obliga a decidir
   * dónde tiene que existir, en vez de dejar que caiga en un `querySelectorAll`
   * que devuelve una lista vacía sin quejarse.
   */
  it("cada selector del cliente encuentra al menos un nodo, en el ámbito que le corresponde", async () => {
    expect(selectoresDelCliente(JS)).toEqual([
      "document :: .txb-cta-profesional",
      "document :: .txb-cta-servicio",
      "menu :: a",
    ]);

    for (const { tenantId, document } of await documentosDeTodosLosLocales()) {
      expect(document.querySelectorAll(".txb-cta-servicio").length, tenantId).toBeGreaterThan(0);
      expect(document.querySelectorAll(".txb-cta-profesional").length, tenantId).toBeGreaterThan(0);

      // `menu` es `byId('txb-nav-menu')`: los enlaces se buscan DENTRO, nunca
      // en todo el documento.
      const menu = document.getElementById("txb-nav-menu");
      expect(menu, `${tenantId} no emite el panel del menú móvil`).not.toBeNull();
      expect(menu?.querySelectorAll("a").length, `${tenantId}: menú móvil sin enlaces`).toBeGreaterThan(0);
    }
  });

  it("cada atributo de datos que el cliente lee lo emite el HTML de los dos locales", async () => {
    const atributos = atributosLeidosPorElCliente(JS);
    expect(atributos.filter((a) => a.startsWith("data-"))).toEqual([
      "data-employee-id",
      "data-service-id",
      "data-tenant-id",
    ]);

    for (const { tenantId, document } of await documentosDeTodosLosLocales()) {
      for (const atributo of atributos.filter((a) => a.startsWith("data-"))) {
        expect(
          document.querySelectorAll(`[${atributo}]`).length,
          `${tenantId} no emite ningún elemento con «${atributo}», que el cliente lee`,
        ).toBeGreaterThan(0);
      }
      // `data-tenant-id` es EL sitio del que sale el identificador del local, y
      // hay uno solo: dos harían que el cliente pudiera hablar por otro.
      const portadores = document.querySelectorAll("[data-tenant-id]");
      expect(portadores, tenantId).toHaveLength(1);
      expect(portadores[0]?.tagName).toBe("BODY");
      expect(portadores[0]?.getAttribute("data-tenant-id")).toBe(tenantId);
    }
  });
});

describe("Demostración web · la estructura del documento es la MISMA en los dos locales", () => {
  /**
   * `parseHtmlDocument` lanza ante marcado mal formado —etiqueta sin cerrar,
   * cierre cruzado, comentario sin cerrar, atributo sin comilla, más de una
   * raíz— y ante un `id` REPETIDO. Merece un caso explícito que lo diga: si
   * alguien «arreglara» el analizador volviéndolo tolerante, se perderían seis
   * garantías de una vez sin que ninguna prueba lo dijera.
   */
  it("el HTML de cada local se analiza sin un solo error, y ningún id se repite", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      await expect(documentoDe(app, tenantId)).resolves.toBeDefined();
    }
  });

  /**
   * La marca cambia el TEXTO, no la ESTRUCTURA. Un conjunto de identificadores
   * distinto entre locales es exactamente por donde vuelve el
   * `if (tenantId === …)` a la plantilla: primero una sección que sólo tiene
   * uno, después dos plantillas.
   */
  it("el conjunto de ids del documento es idéntico en los dos locales", async () => {
    const documentos = await documentosDeTodosLosLocales();
    expect(documentos.length).toBeGreaterThanOrEqual(2);

    const [primero, ...resto] = documentos;
    const referencia = [...(primero as { document: FakeDocument }).document.ids()].sort();
    expect(referencia.length).toBeGreaterThan(60);

    for (const { tenantId, document } of resto) {
      expect([...document.ids()].sort(), `«${tenantId}» tiene otra estructura`).toEqual(referencia);
    }
  });

  /** Y todos los que el cliente busca están dentro de ese conjunto común. */
  it("los identificadores del cliente son un subconjunto de los que emite la plantilla", async () => {
    const ids = new Set(identificadoresDelCliente(JS));
    const documentos = await documentosDeTodosLosLocales();
    const emitidos = new Set((documentos[0] as { document: FakeDocument }).document.ids());
    expect([...ids].filter((id) => !emitidos.has(id))).toEqual([]);
  });
});
