import { describe, expect, it } from "vitest";

import { BOOKING_WEB_NOTICE } from "../../src/bookingWeb/model.js";
import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import { BOOKING_CSS } from "../../src/bookingWeb/ui.css.js";
import type { FakeDocument, FakeElement } from "./fakeDom.js";
import {
  abrirPaginaLista,
  bootstrapDe,
  byId,
  documentoDe,
  freshApp,
} from "./paginaViva.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * EL ACABADO DEL ASISTENTE — DOS DEFECTOS VISTOS EN CHROME, NO EN EL CÓDIGO.
 *
 * Los dos salieron de mirar la pantalla a 1440 px, y los dos son de los que no
 * ponen nada en rojo: el HTML seguía siendo válido, la CSP seguía cerrada, el
 * flujo seguía funcionando y la suite seguía verde mientras la página se veía
 * mal. Por eso hace falta este fichero.
 *
 *  1 · LA COLUMNA DEL RESUMEN ARRANCABA VACÍA. Los cuatro bloques del resumen
 *      nacen ocultos, así que el paso 1 enseñaba una tarjeta blanca de 86 px
 *      con un único botón «Continuar» gris y apagado dentro, al lado de un
 *      panel derecho de 259 px. Parecía una pantalla a medio cargar.
 *
 *  2 · EL AVISO DE DEMOSTRACIÓN APLASTABA LA CABECERA DEL CAJÓN. Llevaba
 *      `text-overflow: ellipsis` sin `white-space: nowrap`, de modo que los
 *      puntos suspensivos no entraban nunca: el texto se partía en dos líneas
 *      dentro de la casilla del medio y dejaba «‹ Volver» y la ✕ flotando en
 *      mitad de un bloque de texto. Y la altura de la cabecera pasaba a
 *      depender de LO LARGO QUE FUERA EL AVISO DE CADA LOCAL —62 px con el
 *      largo, 61 px con el corto—, así que el título «Elige fecha y hora»
 *      empezaba en un sitio distinto en cada página.
 *
 * ────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE FICHERO NO PUEDE HACER, Y NO FINGE HACER
 *
 * Aquí no hay navegador, así que no se mide ni un rectángulo. Las medidas
 * reales están tomadas con Chrome por CDP y se citan como lo que son: la
 * observación que justificó cada regla. Lo que sí se puede exigir —y es lo que
 * impide que los dos arreglos se deshagan en silencio— es que las DECISIONES
 * sigan escritas donde tienen que estar: el rótulo de arranque en el árbol y
 * con el texto que le toca, el aviso vivo en la cabecera de los dos locales, y
 * en la hoja las tres declaraciones sin las cuales lo de arriba se vuelve a
 * romper (el suelo de altura, las casillas con nombre y el `nowrap` que hace
 * que los puntos suspensivos signifiquen algo).
 * ════════════════════════════════════════════════════════════════════════
 */

// El texto del rótulo de arranque, escrito aquí ENTERO y a propósito: es la
// única forma de que un cambio de copy tenga que pasar por una prueba que
// también comprueba que ese copy no inventa nada.
const INTRO_TITULO = "Aquí aparecerá tu reserva";
const INTRO_TEXTO =
  "Se irá completando con el servicio, la persona que te atiende y el día y la hora, según los vayas eligiendo.";

/** La hoja sin comentarios: esta hoja está comentada línea a línea. */
const CSS_LIMPIO = BOOKING_CSS.replace(/\/\*[\s\S]*?\*\//g, "\n");

/**
 * El cuerpo de la regla cuyo selector es EXACTAMENTE ése, buscando sólo en el
 * trozo de hoja que se le pase. Comparar el selector entero —y no `indexOf`—
 * evita que `.txb-summary-intro` case con `.txb-summary-intro__title`.
 */
function cuerpoDeRegla(trozo: string, selector: string): string {
  for (const m of trozo.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((m[1] ?? "").trim() === selector) return (m[2] ?? "").trim();
  }
  throw new Error(`La hoja no declara ninguna regla para «${selector}».`);
}

/** El interior de un `@media` localizado por su texto, con las llaves casadas. */
function bloqueDeMedia(css: string, consulta: string): string {
  const i = css.indexOf(consulta);
  if (i === -1) throw new Error(`La hoja no declara ninguna consulta «${consulta}».`);
  const abre = css.indexOf("{", i);
  let profundidad = 0;
  for (let j = abre; j < css.length; j += 1) {
    if (css[j] === "{") profundidad += 1;
    else if (css[j] === "}") {
      profundidad -= 1;
      if (profundidad === 0) return css.slice(abre + 1, j);
    }
  }
  throw new Error(`La consulta «${consulta}» no cierra sus llaves.`);
}

/** La hoja SIN el interior de ninguna consulta de medios. */
const CSS_SIN_MEDIAS = ((): string => {
  let salida = "";
  let resto = CSS_LIMPIO;
  for (;;) {
    const i = resto.indexOf("@media");
    if (i === -1) return salida + resto;
    salida += resto.slice(0, i);
    const abre = resto.indexOf("{", i);
    let profundidad = 0;
    let cierre = resto.length;
    for (let j = abre; j < resto.length; j += 1) {
      if (resto[j] === "{") profundidad += 1;
      else if (resto[j] === "}") {
        profundidad -= 1;
        if (profundidad === 0) {
          cierre = j;
          break;
        }
      }
    }
    resto = resto.slice(cierre + 1);
  }
})();

/** El aside del resumen del asistente, dentro de la sección de reserva. */
function columnaDelResumen(document: FakeDocument): FakeElement {
  const aside = byId(document, "txb-seccion-reserva").querySelector(".txb-summary");
  if (aside === null) throw new Error("La sección de reserva no tiene columna de resumen.");
  return aside;
}

function rotuloDeArranque(document: FakeDocument): FakeElement | null {
  return columnaDelResumen(document).querySelector(".txb-summary-intro");
}

const LOCALES = tenantIds(buildTenantRegistry());

function avisoDelLocal(tenantId: string): string {
  const tenant = buildTenantRegistry().get(tenantId);
  if (!tenant) throw new Error(`El registro no conoce el local «${tenantId}».`);
  return tenant.content.demoBanner;
}

// ═══════════════════════════════════════════════════════════════════════
// 1 · LA COLUMNA DEL RESUMEN, ANTES DE QUE HAYA NADA QUE RESUMIR
// ═══════════════════════════════════════════════════════════════════════

describe("Demostración web · el paso 1 no enseña una columna vacía", () => {
  /**
   * EL DEFECTO, DICHO ENTERO. Se afirman las dos mitades: que los cuatro
   * bloques del resumen siguen naciendo ocultos y que el botón sigue naciendo
   * apagado —eso no cambia, es lo correcto— Y que aun así la columna dice de
   * qué va. Sin la primera mitad, la prueba no estaría hablando del defecto:
   * seguiría verde el día que alguien «arreglara» esto dejando los bloques
   * visibles y vacíos, que es peor.
   */
  it("con la página recién cargada, la columna se presenta en vez de quedarse en blanco", async () => {
    for (const tenantId of LOCALES) {
      const { document } = await abrirPaginaLista(tenantId);

      for (const id of [
        "txb-resumen-servicio",
        "txb-resumen-profesional",
        "txb-resumen-fecha-bloque",
        "txb-resumen-hora",
      ]) {
        expect(byId(document, id).hidden, `${tenantId}: «${id}» ya no nace oculto`).toBe(true);
      }
      expect(byId(document, "txb-btn-continuar").disabled, tenantId).toBe(true);

      const rotulo = rotuloDeArranque(document);
      expect(
        rotulo,
        `${tenantId}: la columna del resumen vuelve a ser una tarjeta con un botón apagado dentro`,
      ).not.toBeNull();
      expect((rotulo as FakeElement).hidden, `${tenantId}: el rótulo nace oculto`).toBe(false);

      const parrafos = (rotulo as FakeElement).children;
      expect(parrafos.map((p) => p.textContent), tenantId).toEqual([INTRO_TITULO, INTRO_TEXTO]);
    }
  });

  /**
   * Y OCUPA EL SITIO DE SU RELEVO. El rótulo va DELANTE del primer bloque del
   * resumen, que es el que va a sustituirlo en cuanto se elija un servicio. Si
   * apareciera al final —debajo del botón «Continuar», por ejemplo— el
   * intercambio dejaría de ser un cambio de contenido y volvería a mover cosas
   * de sitio.
   */
  it("el rótulo es lo PRIMERO de la columna, justo delante del bloque que lo releva", async () => {
    for (const tenantId of LOCALES) {
      const { document } = await abrirPaginaLista(tenantId);
      const hijos = columnaDelResumen(document).children;
      expect(hijos[0]?.className, tenantId).toContain("txb-summary-intro");
      expect(hijos[1]?.getAttribute("id"), tenantId).toBe("txb-resumen-servicio");
    }
  });

  /**
   * ES CHROME DEL ASISTENTE, NO COPY DE NADIE. El mismo texto en los dos
   * locales, y ninguno de los dos lo tiene escrito en su configuración: si
   * mañana alguien lo saca a `content/**`, esta prueba obliga a decidirlo a
   * propósito en vez de dejar que se cuele un rótulo por local sin que nadie
   * lo pida.
   */
  it("el texto es el mismo en los dos locales y no sale de la configuración de ninguno", async () => {
    const textos: string[] = [];
    for (const tenantId of LOCALES) {
      const { document } = await abrirPaginaLista(tenantId);
      textos.push((rotuloDeArranque(document) as FakeElement).textContent);

      const tenant = buildTenantRegistry().get(tenantId);
      const configuracion = JSON.stringify(tenant?.content ?? {});
      for (const frase of [INTRO_TITULO, INTRO_TEXTO]) {
        expect(
          configuracion.includes(frase),
          `${tenantId} tiene el rótulo del asistente en su contenido público`,
        ).toBe(false);
      }
    }
    expect(textos.length).toBeGreaterThanOrEqual(2);
    expect(new Set(textos).size, "cada local enseña un rótulo distinto").toBe(1);
  });

  /**
   * NO INVENTA NADA. El rótulo describe la PANTALLA, así que no puede llevar
   * una cifra —ni un precio, ni una duración, ni una hora—, ni un dato de
   * contacto, ni el nombre de un servicio o de una persona del local. Lo
   * último se comprueba contra el bootstrap REAL de cada local y no contra una
   * lista escrita a mano: así sigue valiendo el día que cambie el catálogo.
   */
  it("no lleva ni una cifra, ni un dato de contacto, ni nada del catálogo de ningún local", async () => {
    const completo = INTRO_TITULO + " " + INTRO_TEXTO;
    expect(completo, "el rótulo escribe una cifra a mano").not.toMatch(/\d/);
    expect(completo, "el rótulo lleva un dato de contacto o una moneda").not.toMatch(/[@€$]/);
    expect(completo).not.toMatch(/https?:/i);
    expect(completo, "el rótulo escribe una hora").not.toMatch(/\b\d{1,2}[:.]\d{2}\b/);

    const app = freshApp();
    for (const tenantId of LOCALES) {
      const bootstrap = await bootstrapDe(app, tenantId);
      for (const svc of bootstrap.services) {
        expect(completo.includes(svc.label), `${tenantId}: el rótulo nombra «${svc.label}»`).toBe(false);
      }
      for (const emp of bootstrap.employees) {
        expect(
          completo.includes(emp.displayName),
          `${tenantId}: el rótulo nombra a «${emp.displayName}»`,
        ).toBe(false);
      }
    }
  });

  /**
   * Y SE RETIRA EN CUANTO HAY ALGO DE VERDAD QUE ENSEÑAR. Se elige por el
   * camino del propio asistente —la primera ficha de la rejilla del paso 1— y
   * se comprueba lo que queda: el rótulo fuera, el bloque del servicio dentro y
   * con el nombre que dice el servidor.
   */
  it("al elegir un servicio, el rótulo se va y manda el resumen real", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const { document } = await abrirPaginaLista(tenantId, { app });
      const primero = (await bootstrapDe(app, tenantId)).services[0];
      expect(primero, `${tenantId} no publica ni un servicio`).toBeDefined();

      byId(document, "txb-servicios-grid").children[0]?.dispatchClick();

      expect(
        (rotuloDeArranque(document) as FakeElement).hidden,
        `${tenantId}: el rótulo sigue puesto con un servicio ya elegido`,
      ).toBe(true);
      expect(byId(document, "txb-resumen-servicio").hidden, tenantId).toBe(false);
      expect(byId(document, "txb-resumen-servicio-nombre").textContent, tenantId).toBe(
        primero?.label,
      );
    }
  });

  /**
   * EL SALTO DE ALTURA, POR LA ÚNICA VÍA QUE HAY SIN NAVEGADOR.
   *
   * Medido en Chrome: la columna pasa de 228 px con el rótulo a 230 px con el
   * bloque «SERVICIO SELECCIONADO» — dos píxeles, en los dos locales y a 1440,
   * 1024, 900, 768, 560 y 390. Eso lo consiguen dos cosas, y las dos tienen que
   * seguir escritas:
   *
   *   · el rótulo declara un SUELO de altura, para reservar el sitio que va a
   *     ocupar su relevo (sin él, medido, la columna caía a 188 px y luego
   *     subía a 230: un tirón en dos tiempos en el mismo instante);
   *   · ese suelo va en `rem`, no en píxeles, porque el bloque al que tiene que
   *     igualar también crece si alguien sube el cuerpo de texto del navegador;
   *   · y las dos cajas se maquetan igual —mismo relleno, mismo radio y mismo
   *     borde—, que es lo que hace que el intercambio sea de CONTENIDO y no de
   *     TAMAÑO.
   */
  it("el rótulo reserva por hoja el mismo sitio que el bloque que lo releva", () => {
    const rotulo = cuerpoDeRegla(CSS_SIN_MEDIAS, ".txb-summary-intro");
    const bloque = cuerpoDeRegla(CSS_SIN_MEDIAS, ".txb-summary-block");

    const suelo = /min-height:\s*([\d.]+)rem\s*;/.exec(rotulo);
    expect(
      suelo,
      "el rótulo ya no reserva altura: al elegir un servicio la columna vuelve a dar un tirón",
    ).not.toBeNull();
    expect(Number(suelo?.[1] ?? 0), "el suelo de altura del rótulo es cero").toBeGreaterThan(0);

    const declaracion = (cuerpo: string, propiedad: string): string | undefined =>
      new RegExp(`(?:^|;)\\s*${propiedad}:\\s*([^;]+);`).exec(cuerpo)?.[1]?.trim();

    for (const propiedad of ["padding", "border-radius", "border"]) {
      expect(
        declaracion(rotulo, propiedad),
        `el rótulo y el bloque del resumen ya no comparten «${propiedad}»: el relevo mueve la caja`,
      ).toBe(declaracion(bloque, propiedad));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2 · LA CABECERA DEL CAJÓN DE FECHA Y HORA
// ═══════════════════════════════════════════════════════════════════════

describe("Demostración web · la cabecera del cajón se lee como una cabecera", () => {
  /**
   * LA REGLA DURA, PRIMERO: EL AVISO NO SE ELIMINA. Está en la cabecera del
   * cajón de los DOS locales, con el texto propio de cada uno, y cumple lo que
   * el validador de contenido exige: no vacío, con la palabra «demostración» y
   * distinto palabra por palabra del aviso contractual del pie.
   *
   * El arreglo de presentación es lo único que se ha tocado, y esta prueba
   * existe para que «arreglarlo» borrándolo no sea una salida.
   */
  it("el aviso de demostración del local sigue vivo en la cabecera del cajón", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const aviso = byId(document, "txb-drawer-aviso");

      const esperado = avisoDelLocal(tenantId);
      expect(aviso.textContent, tenantId).toBe(esperado);
      expect(esperado.trim().length, `${tenantId}: el aviso está vacío`).toBeGreaterThan(0);
      expect(
        esperado
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase(),
        tenantId,
      ).toContain("demostracion");
      expect(esperado, `${tenantId}: el aviso repite el contractual`).not.toBe(BOOKING_WEB_NOTICE);

      // Y cuelga de la cabecera del cajón, no de cualquier sitio.
      expect(aviso.parentNode?.className, tenantId).toContain("txb-drawer__bar");
      let n: FakeElement | null = aviso.parentNode;
      while (n !== null && n.getAttribute("id") !== "txb-drawer-fecha") n = n.parentNode;
      expect(n, `${tenantId}: el aviso se ha salido del cajón`).not.toBeNull();
    }
  });

  /**
   * EL AVISO ESTÁ EN DOS NODOS Y EN DOS SITIOS, Y NI UNO MÁS NI UNO MENOS: la
   * franja superior de la página y la cabecera del cajón. Se cuentan los NODOS
   * que llevan ese texto exacto, no las veces que la cadena aparece en el HTML:
   * así la prueba habla de la interfaz y no del diccionario del documento.
   */
  it("ese mismo texto lo llevan exactamente dos nodos: la franja de arriba y el cajón", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const esperado = avisoDelLocal(tenantId);
      const portadores = document
        .querySelectorAll("p")
        .filter((n) => n.children.length === 0 && n.textContent === esperado)
        .map((n) => n.getAttribute("id"));
      expect(portadores.sort(), tenantId).toEqual(["txb-demobar", "txb-drawer-aviso"]);
    }
  });

  /**
   * LAS TRES PIEZAS DECLARAN SU CASILLA. Colocar por el ORDEN en que estén
   * escritas es lo que hacía que el aviso, al crecer, empujase a los botones:
   * compartían fila porque nadie había dicho lo contrario. Con casillas
   * nombradas, la hoja puede bajar el aviso a una fila propia sin tocar el
   * marcado — y esta prueba comprueba las dos mitades del contrato, la clase en
   * el HTML y el `grid-area` en la hoja, porque aterrizar sólo una no falla
   * nada: la clase quedaría puesta y sin efecto.
   */
  it("cada pieza de la cabecera nombra su casilla, en el marcado y en la hoja", async () => {
    const app = freshApp();
    const casillas: Array<[string, string, string]> = [
      ["txb-volver-profesional", "txb-drawer__back", "volver"],
      ["txb-drawer-aviso", "txb-drawer__demo", "aviso"],
      ["txb-drawer-cerrar", "txb-drawer__close", "cerrar"],
    ];

    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const barra = byId(document, "txb-drawer-aviso").parentNode as FakeElement;
      expect(
        barra.children.map((n) => n.getAttribute("id")),
        `${tenantId}: la cabecera del cajón ya no tiene sus tres piezas`,
      ).toEqual(casillas.map(([id]) => id));

      for (const [id, clase] of casillas) {
        expect(byId(document, id).className, `${tenantId}: «${id}» sin su clase de casilla`).toContain(
          clase,
        );
      }
    }

    for (const [, clase, area] of casillas) {
      expect(
        cuerpoDeRegla(CSS_SIN_MEDIAS, `.${clase}`),
        `la hoja no le da casilla a «${clase}»: volvería a colocarse por su posición`,
      ).toMatch(new RegExp(`grid-area:\\s*${area}\\b`));
    }
  });

  /**
   * LA ALTURA DE LA CABECERA LA FIJA EL OBJETIVO TÁCTIL, NO EL TEXTO.
   *
   * Medido en Chrome con el arreglo puesto: 61 px a 1440 en los DOS locales
   * (antes 62 con el aviso largo y 61 con el corto), y «‹ Volver», el aviso y
   * la ✕ con el mismo centro vertical exacto en todos los anchos probados
   * —1440, 1280, 1140, 1024, 900, 899, 768, 767, 600, 560, 559, 430, 390 y
   * 360—, incluidos los anchos en los que el aviso necesita dos líneas.
   *
   * Sin navegador, lo que se puede exigir es de dónde sale esa altura: del
   * token de objetivo táctil, que es el que garantiza los 44 px de los botones.
   * Un número escrito a mano volvería a desacoplar la cabecera de sus botones.
   */
  it("la cabecera declara su altura desde el token de objetivo táctil", () => {
    const barra = cuerpoDeRegla(CSS_SIN_MEDIAS, ".txb-drawer__bar");
    expect(
      barra,
      "la cabecera del cajón ya no fija su altura: vuelve a medir lo que mida el aviso del local",
    ).toMatch(/min-height:\s*calc\(\s*var\(--txb-tap\)/);
  });

  /**
   * POR DEFECTO EL AVISO OCUPA SU PROPIA FILA. Es la única colocación que no
   * depende de cuánto escriba un local: los botones se quedan anclados a los
   * extremos de SU fila y el aviso crece hacia abajo sin tocarlos. Medido a
   * 390 px: el aviso necesita dos líneas en los dos locales y los botones
   * siguen exactamente donde estaban.
   */
  it("por defecto el aviso tiene una fila para él solo, y los botones otra", () => {
    const barra = cuerpoDeRegla(CSS_SIN_MEDIAS, ".txb-drawer__bar");
    const areas = /grid-template-areas:\s*([^;]+);/.exec(barra)?.[1] ?? "";
    const filas = [...areas.matchAll(/"([^"]*)"/g)].map((m) =>
      (m[1] ?? "").trim().split(/\s+/).filter(Boolean),
    );

    expect(filas.length, "la cabecera vuelve a tener una sola fila para las tres piezas").toBe(2);
    expect(filas[0], "los botones ya no están solos en su fila").toEqual([
      "volver",
      ".",
      "cerrar",
    ]);
    expect(
      new Set(filas[1] ?? []),
      "el aviso ya no ocupa una fila entera: vuelve a competir con los botones",
    ).toEqual(new Set(["aviso"]));
    expect((filas[1] ?? []).length, "la fila del aviso no cruza el ancho de la cabecera").toBe(3);
  });

  /**
   * ────────────────────────────────────────────────────────────────────
   * EL DEFECTO EXACTO, CONGELADO: PUNTOS SUSPENSIVOS SIN `nowrap` SON
   * DECORACIÓN.
   *
   * `text-overflow: ellipsis` sólo actúa sobre texto que DESBORDA, y un párrafo
   * que puede partirse no desborda nunca: se hace más alto. Ésa era la línea
   * que hacía creer que el caso estaba resuelto mientras el aviso se partía en
   * dos y aplastaba la cabecera.
   *
   * Así que las dos declaraciones tienen que viajar JUNTAS y sólo donde el
   * aviso comparte fila con los botones: en la regla base —donde el aviso tiene
   * fila propia— `nowrap` sobraría y además cortaría un texto que ahí cabe
   * entero.
   * ────────────────────────────────────────────────────────────────────
   */
  it("los puntos suspensivos del aviso van con nowrap, y sólo donde comparte fila", () => {
    const base = cuerpoDeRegla(CSS_SIN_MEDIAS, ".txb-drawer__demo");
    expect(base).toMatch(/overflow:\s*hidden/);
    expect(base).toMatch(/text-overflow:\s*ellipsis/);
    expect(
      base,
      "con fila propia, `nowrap` corta un aviso que cabía entero",
    ).not.toMatch(/white-space:\s*nowrap/);

    // La consulta que devuelve las tres piezas a una sola fila es la ÚNICA que
    // puede declarar `nowrap`, y tiene que declararlo: si no, los puntos
    // suspensivos vuelven a ser decorativos y el aviso vuelve a partirse.
    const filaUnica = bloqueDeMedia(CSS_LIMPIO, "@media (min-width: 1400px)");
    expect(
      cuerpoDeRegla(filaUnica, ".txb-drawer__bar"),
      "la fila única ya no recoloca las casillas",
    ).toMatch(/grid-template-areas:\s*"volver\s+aviso\s+cerrar"/);
    expect(
      cuerpoDeRegla(filaUnica, ".txb-drawer__demo"),
      "el aviso vuelve a poder partirse en la fila que comparte con los botones",
    ).toMatch(/white-space:\s*nowrap/);
  });
});
