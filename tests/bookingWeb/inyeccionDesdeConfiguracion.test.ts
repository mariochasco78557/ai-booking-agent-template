import { describe, expect, it } from "vitest";

import { buildTenantPublicView } from "../../src/bookingWeb/publicView.js";
import { renderBookingHtml } from "../../src/bookingWeb/ui.html.js";
import type { FakeDocument, FakeElement } from "./fakeDom.js";
import { parseHtmlDocument } from "./htmlParse.js";
import { documentoDe, freshApp, paginaDe } from "./paginaViva.helpers.js";
import {
  CLAVES_DE_UNION_CERRADA,
  conTodoElTextoReescrito,
  localDelRegistro,
  registroCambiando,
} from "./registro.helpers.js";
import { todosLosElementos } from "./seguridad.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * TODO EL TEXTO DE LA PÁGINA VIENE DE CONFIGURACIÓN. TODO.
 *
 * Con la web pública, los campos de texto de un local se multiplicaron por
 * diez: titular, antetítulo, subtitular, dos etiquetas de CTA, cuatro frases
 * destacadas, cinco etiquetas de navegación, una categoría y una descripción por
 * servicio, un rol y una biografía por persona, los pasos de «cómo funciona»,
 * la información práctica, las preguntas frecuentes, el pie… Cada uno de ellos
 * es una interpolación, y CADA interpolación que se olvide de `escapeHtml()` es
 * una inyección de HTML directa. Es la amenaza con más probabilidad de aparecer
 * en esta misión, y la que peor envejece: el campo número treinta y uno lo
 * añadirá alguien dentro de un mes.
 *
 * POR ESO LA CARGA SE PONE EN TODOS A LA VEZ, RECORRIENDO LAS CLAVES. Una lista
 * de campos escrita a mano en la prueba es exactamente la lista que se queda
 * corta el día que se añade uno. `conTodoElTextoReescrito` recorre el objeto
 * entero y sustituye cada cadena; lo único que respeta son las UNIONES CERRADAS
 * (`theme`, `kind`, `assetFile`, `target`, `tenantId`), que no son prosa sino
 * índices de tablas y no compilarían con otro valor.
 *
 * QUÉ SE COMPRUEBA CON LA CARGA PUESTA, y por qué cada cosa:
 *   · UN solo `<script>`, y es `/app.js`. Si la inyección funcionara, habría dos.
 *   · El documento SE ANALIZA sin errores y tiene el MISMO número de elementos
 *     que su gemelo limpio. Un `<` sin escapar rompe la estructura; contar los
 *     elementos lo detecta aunque el marcado resultante siga siendo analizable.
 *   · Ningún atributo empieza por `on`. Es lo que caza un escape de comillas
 *     insuficiente.
 *   · El texto hostil aparece COMO TEXTO. Sin esto, «arreglar» el escape
 *     borrando el valor pasaría la prueba, y eso no es escapar: es perder datos.
 *   · `renderBookingHtml(...)` no contiene la secuencia `='`. La promesa de que
 *     un valor con comilla simple es inofensivo se apoyaba en la COSTUMBRE de
 *     entrecomillar siempre con `"`, y nadie la vigilaba.
 * ════════════════════════════════════════════════════════════════════════
 */

/**
 * Seis cargas, cada una ataca una vía distinta: cerrar el elemento en curso,
 * cerrar un atributo y abrir un manejador, salir de un atributo con comilla
 * simple, abrir un bloque de estilo, abrir un comentario que se coma el resto
 * del documento, y una carga YA ESCAPADA para comprobar que no se escapa dos
 * veces (`&amp;lt;` en pantalla sería un texto roto).
 */
const CARGAS_HOSTILES = [
  "</title><script>x</script>",
  '" onload="x',
  "'><img src=x onerror=y>",
  "</h1><style>",
  "<!--",
  "&lt;script&gt;",
] as const;

const LOCAL = "demo-salon-demo";

/** Cuenta los elementos del documento analizado, la raíz incluida. */
function cuantosElementos(document: FakeDocument): number {
  return todosLosElementos(document).length;
}

/**
 * Sirve el local con TODO su texto sustituido por `texto`. El control se
 * fabrica igual pero con una palabra inocente: comparar contra él —y no contra
 * el documento real— aísla el efecto de los CARACTERES de la carga del efecto de
 * cambiar la longitud o el contenido de los campos.
 */
async function paginaConTexto(texto: string): Promise<{ html: string; document: FakeDocument }> {
  const registry = registroCambiando(LOCAL, (t) => conTodoElTextoReescrito(t, () => texto));
  const app = freshApp(registry);
  const html = await paginaDe(app, LOCAL);
  return { html, document: parseHtmlDocument(html) };
}

describe("Demostración web · una carga hostil en CADA campo de texto del local", () => {
  it("el recorrido de claves toca de verdad todos los campos, y respeta las uniones cerradas", () => {
    const tenant = localDelRegistro(LOCAL);
    const marcado = conTodoElTextoReescrito(tenant, () => "ZZZ");

    // Ha tocado los campos de prosa…
    expect(marcado.displayName).toBe("ZZZ");
    expect(marcado.brand.title).toBe("ZZZ");
    expect(marcado.brand.tagline).toBe("ZZZ");
    expect(marcado.content.hero.headline).toBe("ZZZ");
    expect(marcado.content.hero.highlights.every((h) => h === "ZZZ")).toBe(true);
    expect(marcado.content.nav.links.every((l) => l.label === "ZZZ")).toBe(true);
    expect(marcado.content.servicePresentation.every((p) => p.description === "ZZZ")).toBe(true);
    expect(marcado.content.professionalProfiles.every((p) => p.bio === "ZZZ")).toBe(true);
    expect(marcado.content.faq.every((f) => f.question === "ZZZ" && f.answer === "ZZZ")).toBe(true);
    expect(marcado.content.practicalInfo.items.every((i) => i.value === "ZZZ")).toBe(true);
    expect(marcado.content.footerTagline).toBe("ZZZ");
    expect(marcado.content.syntheticDisclosure).toBe("ZZZ");

    // …y NO las uniones cerradas, que no son texto: son índices de tablas.
    expect(marcado.brand.theme).toBe(tenant.brand.theme);
    expect(marcado.brand.logo.kind).toBe(tenant.brand.logo.kind);
    expect(marcado.content.nav.links.map((l) => l.target)).toEqual(
      tenant.content.nav.links.map((l) => l.target),
    );
    expect(CLAVES_DE_UNION_CERRADA.has("theme")).toBe(true);
  });

  for (const carga of CARGAS_HOSTILES) {
    it(`«${carga}» en todos los campos: sigue habiendo UN script, y es /app.js`, async () => {
      const { document } = await paginaConTexto(carga);
      const scripts = document.querySelectorAll("script");
      expect(scripts, `la carga «${carga}» ha inyectado un script`).toHaveLength(1);
      expect(scripts[0]?.getAttribute("src")).toBe("/app.js");
      expect(scripts[0]?.textContent).toBe("");
    });

    it(`«${carga}»: el documento se analiza y conserva la MISMA estructura`, async () => {
      // Control con una palabra inocente de la misma naturaleza: lo único que
      // cambia entre los dos documentos son los caracteres peligrosos.
      const limpio = await paginaConTexto("Zeta");
      const hostil = await paginaConTexto(carga);
      expect(
        cuantosElementos(hostil.document),
        `la carga «${carga}» ha cambiado el número de elementos del documento`,
      ).toBe(cuantosElementos(limpio.document));
      // Y los mismos identificadores: no ha desaparecido ni aparecido un nodo.
      expect([...hostil.document.ids()].sort()).toEqual([...limpio.document.ids()].sort());
    });

    it(`«${carga}»: ningún elemento gana un atributo que empiece por on, ni un style`, async () => {
      const { document } = await paginaConTexto(carga);
      const ofensas: string[] = [];
      for (const nodo of todosLosElementos(document)) {
        for (const nombre of nodo.getAttributeNames()) {
          if (nombre.startsWith("on") || nombre === "style") {
            ofensas.push(`<${nodo.tagName.toLowerCase()} ${nombre}>`);
          }
        }
      }
      expect(ofensas, `la carga «${carga}» ha creado un atributo ejecutable`).toEqual([]);
      expect(document.querySelectorAll("style"), `la carga «${carga}» ha abierto un <style>`).toEqual([]);
      expect(document.querySelectorAll("img").length, "ha aparecido una imagen inyectada").toBeLessThanOrEqual(
        1,
      );
    });

    it(`«${carga}»: se ve COMO TEXTO, no se ha borrado por el camino`, async () => {
      const { document } = await paginaConTexto(carga);
      // El escape convierte el marcado en texto; el texto tiene que seguir ahí,
      // porque escapar no es censurar. `textContent` devuelve el valor ya
      // descodificado, así que se compara con la carga original.
      expect(
        document.body.textContent.includes(carga),
        `la carga «${carga}» no aparece como texto: el escape la ha hecho desaparecer`,
      ).toBe(true);
    });
  }

  /**
   * LA COMILLA SIMPLE. `escapeHtml` escapa `&`, `<`, `>`, `"` y `'`; aun así, la
   * garantía se apoya en que TODOS los atributos de la plantilla van con
   * comillas dobles. Si alguien escribiera `class='…'`, un valor con `'` dentro
   * saldría del atributo. Esta comprobación mira el HTML COMPUESTO, no el
   * fuente: da igual cómo se escriba, lo que no puede existir es un atributo
   * abierto con comilla simple.
   */
  it("ningún atributo del HTML compuesto se abre con comilla simple, ni con la carga puesta", async () => {
    const limpio = renderBookingHtml(buildTenantPublicView(localDelRegistro(LOCAL)));
    expect(limpio, "hay un atributo con comilla simple en la plantilla").not.toContain("='");

    for (const carga of CARGAS_HOSTILES) {
      const registry = registroCambiando(LOCAL, (t) => conTodoElTextoReescrito(t, () => carga));
      const tenant = registry.get(LOCAL);
      const html = renderBookingHtml(buildTenantPublicView(tenant as NonNullable<typeof tenant>));
      expect(html, `la carga «${carga}» ha producido un atributo con comilla simple`).not.toContain("='");
    }
  });

  it("con la carga puesta, la página sigue siendo servible y el cliente sigue siendo el mismo", async () => {
    for (const carga of CARGAS_HOSTILES) {
      const registry = registroCambiando(LOCAL, (t) => conTodoElTextoReescrito(t, () => carga));
      const app = freshApp(registry);
      const res = await app.inject({ method: "GET", url: `/${LOCAL}` });
      expect(res.statusCode, `carga «${carga}»`).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      // Y el cliente que sirve es el de siempre: la configuración de un local no
      // puede cambiar el JavaScript que ejecuta el navegador.
      const cliente = await app.inject({ method: "GET", url: "/app.js" });
      expect(cliente.statusCode).toBe(200);
      expect(cliente.body).not.toContain(carga);
    }
  });
});

describe("Demostración web · el monograma hostil tampoco rompe el icono servido", () => {
  /**
   * EL MONOGRAMA LLEGA A UN SEGUNDO DOCUMENTO. `brand.monogram` no sólo se pinta
   * en el HTML: es el contenido del SVG que sirve `/brand/:tenantId/icon.svg`,
   * que es un documento aparte con sus propias reglas. Un escape que valga para
   * el HTML y no se aplique ahí sería una inyección en un fichero que el
   * navegador interpreta igual.
   *
   * CÓMO SE AFIRMA, Y CÓMO NO. Una carga que contenga `href=` aparece —escapada—
   * DENTRO del nodo de texto del SVG, así que `not.toContain("href=")` daría rojo
   * sin que exista ningún atributo. Lo que se comprueba es la ESTRUCTURA: el
   * documento sigue teniendo las mismas etiquetas, ninguna de ellas es peligrosa
   * y ningún elemento ha ganado un atributo.
   */
  it("una carga en el monograma no abre ninguna etiqueta dentro del SVG", async () => {
    const app = freshApp();
    const limpio = (await app.inject({ method: "GET", url: `/brand/${LOCAL}/icon.svg` })).body;
    const etiquetasLimpias = [...limpio.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)].map((m) => m[1]);

    for (const carga of [...CARGAS_HOSTILES, '"/><script href="x">', "</text><script>x</script>"]) {
      const registry = registroCambiando(LOCAL, (t) => ({
        ...t,
        brand: { ...t.brand, monogram: carga },
      }));
      const svg = (await freshApp(registry).inject({ method: "GET", url: `/brand/${LOCAL}/icon.svg` })).body;

      // MISMAS etiquetas, en el mismo orden: no se ha abierto ni cerrado nada.
      const etiquetas = [...svg.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)].map((m) => m[1]);
      expect(etiquetas, `el monograma «${carga}» ha alterado la estructura del SVG`).toEqual(
        etiquetasLimpias,
      );
      for (const peligrosa of ["script", "foreignObject", "image", "use", "a"]) {
        expect(etiquetas, `el monograma «${carga}» ha abierto un <${peligrosa}>`).not.toContain(peligrosa);
      }
      // Y el número de atributos del documento no ha crecido.
      const atributos = (texto: string): number => [...texto.matchAll(/\s[\w:-]+="/g)].length;
      expect(atributos(svg), `el monograma «${carga}» ha añadido un atributo`).toBe(atributos(limpio));
    }
  });

  it("el monograma hostil llega al icono como TEXTO, sin perderse", async () => {
    const carga = "</text><script>x</script>";
    const registry = registroCambiando(LOCAL, (t) => ({ ...t, brand: { ...t.brand, monogram: carga } }));
    const svg = (await freshApp(registry).inject({ method: "GET", url: `/brand/${LOCAL}/icon.svg` })).body;

    // Escapado, carácter a carácter: sigue estando, y no como marcado.
    expect(svg).toContain("&lt;/text&gt;&lt;script&gt;x&lt;/script&gt;");
    expect(svg).not.toContain("<script>");
  });
});

describe("Demostración web · la carga hostil no cambia lo que la página ES", () => {
  it("los identificadores, los enlaces y los tipos de campo siguen intactos", async () => {
    const app = freshApp();
    const real = await documentoDe(app, LOCAL);
    const { document: hostil } = await paginaConTexto("'><img src=x onerror=y>");

    // La estructura no depende del copy: los mismos ids, los mismos enlaces.
    expect([...hostil.ids()].sort()).toEqual([...real.ids()].sort());
    expect(hostil.querySelectorAll("link").map((l) => l.getAttribute("rel"))).toEqual(
      real.querySelectorAll("link").map((l) => l.getAttribute("rel")),
    );
    for (const input of hostil.querySelectorAll("input")) {
      expect(["radio", "checkbox", "date"]).toContain(input.getAttribute("type"));
    }
  });

  it("los anclas siguen llevando a sitios que existen, con el copy envenenado", async () => {
    const { document } = await paginaConTexto('" onload="x');
    const rotas = document
      .querySelectorAll("a")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("#"))
      .filter((href) => document.getElementById(href.slice(1)) === null);
    expect(rotas).toEqual([]);
  });

  it("el aviso contractual sobrevive a la carga: no lo puede reescribir un local", async () => {
    const { document } = await paginaConTexto("</title><script>x</script>");
    const pie = document.getElementById("txb-footer") as FakeElement;
    expect(
      pie.textContent,
      "el aviso contractual ha desaparecido al envenenar el copy del local",
    ).toContain("Entorno de demostración · Datos ficticios");
  });
});
