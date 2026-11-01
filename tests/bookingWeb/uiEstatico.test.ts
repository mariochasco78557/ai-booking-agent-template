import { describe, expect, it } from "vitest";

import type { TenantPublicView } from "../../src/bookingWeb/model.js";
import { buildTenantPublicView } from "../../src/bookingWeb/publicView.js";
import { buildBookingWebServer } from "../../src/bookingWeb/server.js";
import { createBookingStore } from "../../src/bookingWeb/store.js";
import { buildTenantRegistry } from "../../src/bookingWeb/tenants.js";
import { BOOKING_CSS } from "../../src/bookingWeb/ui.css.js";
import { renderBookingHtml } from "../../src/bookingWeb/ui.html.js";
import { renderBookingAppJs } from "../../src/bookingWeb/ui.js.js";
import type { FakeElement } from "./fakeDom.js";
import { parseHtmlDocument } from "./htmlParse.js";
import {
  espaciosDeNombresDelDocumento,
  ESPACIOS_DE_NOMBRES_PERMITIDOS,
  motivoDeUrlInaceptable,
  origenesDeCsp,
  todosLosElementos,
  urlsDelDocumento,
} from "./seguridad.helpers.js";

/**
 * FASE 2 — pruebas ESTÁTICAS de la interfaz: las rutas que sirven la página,
 * la hoja de estilos y el cliente JavaScript, más un barrido de texto sobre
 * los tres fuentes que la componen. El flujo funcional (elegir servicio →
 * profesional → hora → pagar → confirmar) vive en `uiFlujo.test.ts`.
 */

function freshApp() {
  return buildBookingWebServer({ store: createBookingStore(), registry: buildTenantRegistry() });
}

/**
 * LA VISTA PÚBLICA del local, que es lo que `renderBookingHtml` recibe desde
 * M-WEB-1: no la definición entera del local, sino lo que
 * `buildTenantPublicView` deriva de ella —cadenas ya formateadas, servicios y
 * personas ya resueltos, la semana de apertura ya calculada—.
 *
 * Que la plantilla ya no acepte una `TenantDefinition` no es un detalle de
 * firma: es lo que impide imprimir un precio en céntimos o recorrer el
 * calendario desde el envoltorio HTML, porque esos campos no están en el tipo.
 */
function vistaDelRegistro(tenantId: string): TenantPublicView {
  const tenant = buildTenantRegistry().get(tenantId);
  if (!tenant) throw new Error(`El registro no conoce el local «${tenantId}».`);
  return buildTenantPublicView(tenant);
}

describe("Demostración web · interfaz · rutas", () => {
  it("GET /:tenantId sirve HTML con la CSP estricta de la fase 1, sin cambiarla", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/demo-salon-demo" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.body).toContain('<link rel="stylesheet" href="/app.css">');
    expect(res.body).toContain('data-tenant-id="demo-salon-demo"');
  });

  it("GET /:tenantId con un local desconocido es 404 UNKNOWN_TENANT, igual que la API", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/no-existe-este-local" });
    expect(res.statusCode).toBe(404);
    const json = res.json() as { code: string; notice: string };
    expect(json.code).toBe("UNKNOWN_TENANT");
    expect(json.notice).toBe("Entorno de demostración · Datos ficticios");
  });

  it("GET /:tenantId con un segundo local aislado también sirve su propia página", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/demo-dos" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-tenant-id="demo-dos"');
  });

  it("GET /app.css responde con su content-type", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/app.css" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
    expect(res.body.length).toBeGreaterThan(100);
  });

  it("GET /app.js responde con su content-type", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
    expect(res.body.length).toBeGreaterThan(100);
  });

  /**
   * La ruta del activo de marca lleva el LOCAL dentro desde 2026-08-26. La
   * ruta antigua y sin local (`/brand/logo.png`) ya no existe: servía el PNG
   * del local principal a quien lo pidiera, que es justo lo que hacía que el
   * segundo local pudiera presentarse con la marca del primero. Lo que aquí
   * era «responde con image/png» sigue comprobándose, ahora sobre la ruta del
   * local que sí declara activo; el resto de garantías (404 del local
   * desconocido, 404 del local sin activo, ningún local sirviendo lo ajeno)
   * vive en `marcaPorLocal.test.ts`.
   */
  it("GET /brand/:tenantId/logo.png responde con image/png para el local que declara activo", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/brand/demo-salon-demo/logo.png" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("la ruta antigua sin local ya no existe", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/brand/logo.png" });
    expect(res.statusCode).toBe(404);
  });
});

describe("Demostración web · interfaz · invariantes estáticos de los fuentes servidos", () => {
  const html = renderBookingHtml(vistaDelRegistro("demo-salon-demo"));
  const js = renderBookingAppJs();
  const css = BOOKING_CSS;

  it("ningún fuente usa innerHTML", () => {
    expect(html).not.toMatch(/innerHTML/);
    expect(js).not.toMatch(/innerHTML/);
    expect(css).not.toMatch(/innerHTML/);
  });

  it("ningún fuente usa .style. ni un atributo style= en línea", () => {
    expect(html).not.toMatch(/\sstyle\s*=/);
    expect(js).not.toMatch(/\.style\./);
  });

  it("el HTML no lleva ningún <style> embebido", () => {
    expect(html).not.toMatch(/<style/i);
  });

  /**
   * EL DEFECTO M-SAAS-1, cerrado por texto. El cliente rotulaba los bloques
   * de la rejilla con `first < 720` (un pivote inventado a las 12:00), así que
   * una mañana cuyos primeros huecos estuvieran reservados se rotulaba
   * «Tarde». Ahora los tramos y sus rótulos llegan en `windows`, desde el
   * servidor, y aquí no puede volver a aparecer una hora de corte.
   */
  it("el cliente no lleva ninguna hora de corte escrita a mano", () => {
    expect(js).not.toMatch(/\b720\b/);
    // Ninguna comparación de un minuto-del-día contra un literal (`< 720`,
    // `>= 960`…). Las únicas comparaciones de tiempo del fichero son entre
    // valores que vienen los dos de la API.
    expect(js).not.toMatch(/[<>]=?\s*\d{3,4}\b/);
    // Y tampoco decide él cómo se llama un tramo: «Mañana»/«Tarde» no
    // aparecen como literal de cadena en ninguna parte del cliente —llegan
    // dentro de `windows`, desde el servidor—.
    expect(js).not.toMatch(/['"`]Mañana['"`]/);
    expect(js).not.toMatch(/['"`]Tarde['"`]/);
  });

  it("barrido de tokens prohibidos (tarjeta/cuenta bancaria/proveedores), sin distinguir mayúsculas", () => {
    const prohibidos = ["card", "iban", "cvv", "stripe", "redsys", "paypal"];
    const textoCompleto = (html + "\n" + js + "\n" + css).toLowerCase();
    for (const token of prohibidos) {
      expect(textoCompleto.includes(token), `los fuentes servidos contienen «${token}»`).toBe(false);
    }
  });

  /**
   * LOS `<input>`, SOBRE EL DOCUMENTO ANALIZADO Y NO POR EXPRESIÓN REGULAR.
   *
   * La versión anterior recorría `matchAll(/<input[^>]*type="…"/)`, y por tanto
   * SÓLO veía los `<input>` que declaran `type=`. Un `<input name="email">` sin
   * `type` —que en HTML es `type="text"`— no aparecía en la lista y no lo
   * cazaba ninguna de las dos comprobaciones: el agujero más probable el día que
   * a alguien se le ocurra poner un formulario de contacto en la portada.
   *
   * Ahora se pregunta al documento: CADA `<input>` tiene `type` declarado y ese
   * tipo está en la lista blanca. Y se prohíben además `<textarea>`, `<select>`
   * y `<form>`, que son las otras tres formas de pedirle un dato a alguien.
   */
  it("ningún <input> de tarjeta, cuenta bancaria, teléfono o correo en el HTML", () => {
    const document = parseHtmlDocument(html);
    const inputs = document.querySelectorAll("input");
    expect(inputs.length, "el documento no tiene ni un <input>: algo se ha perdido").toBeGreaterThan(0);
    for (const input of inputs) {
      const tipo = input.getAttribute("type");
      expect(tipo, `un <input> sin type= es un campo de texto encubierto`).not.toBeNull();
      expect(["radio", "checkbox", "date"]).toContain(tipo);
    }
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
    expect(document.querySelectorAll("select")).toHaveLength(0);
    expect(document.querySelectorAll("form")).toHaveLength(0);
  });

  /**
   * Ni `on*=`, ni `style=`, ni `<style>`, comprobados sobre el DOCUMENTO. Las
   * versiones de texto que había —`/\son[a-z]+\s*=\s*["']/` y `/\sstyle\s*=/`—
   * no cazan un atributo escrito sin comillas (`onclick=algo`) ni un espacio
   * raro. Preguntándole al analizador por los NOMBRES de atributo, la forma en
   * que estén escritos deja de importar.
   */
  it("ningún elemento del documento lleva un manejador en línea ni un estilo propio", () => {
    const document = parseHtmlDocument(html);
    const ofensas: string[] = [];
    for (const nodo of todosLosElementos(document)) {
      for (const nombre of nodo.getAttributeNames()) {
        if (nombre.startsWith("on")) ofensas.push(`<${nodo.tagName.toLowerCase()} ${nombre}>`);
        if (nombre === "style") ofensas.push(`<${nodo.tagName.toLowerCase()} style>`);
      }
    }
    expect(ofensas).toEqual([]);
    expect(document.querySelectorAll("style")).toHaveLength(0);
    expect(document.querySelectorAll("base"), "un <base> reescribiría todas las rutas").toHaveLength(0);
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL ÚNICO SCRIPT DE LA PÁGINA, COMPROBADO POR PARTES.
 *
 * Aquí vivía `expect(html).not.toMatch(/<script/i)`, una prohibición ciega que
 * confundía «nada de JavaScript EN LÍNEA» con «ningún JavaScript» y que, por
 * tanto, EXIGÍA el defecto del 2026-08-26: la página se servía sin referencia
 * a `/app.js` y quedaba inerte, y esta prueba lo bendecía.
 *
 * Lo que hay que garantizar no es la ausencia de `<script>`, sino su FORMA:
 * exactamente uno, externo, propio, diferido y vacío. Eso es lo que
 * `script-src 'self'` sin `'unsafe-inline'` permite, ni más ni menos. Y se
 * comprueba sobre el HTML SERVIDO por la ruta real, no sobre una cadena
 * cualquiera.
 * ────────────────────────────────────────────────────────────────────────
 */
describe("Demostración web · interfaz · el único <script> de la página", () => {
  async function htmlServido(): Promise<string> {
    const res = await freshApp().inject({ method: "GET", url: "/demo-salon-demo" });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  /** Todas las etiquetas `<script …>` de apertura del documento. */
  function aperturas(html: string): string[] {
    return [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  }

  it("hay EXACTAMENTE una etiqueta <script>, contada por apertura y por cierre", async () => {
    const html = await htmlServido();
    expect(aperturas(html)).toHaveLength(1);
    expect([...html.matchAll(/<\/script\s*>/gi)]).toHaveLength(1);
  });

  it("su src es exactamente /app.js, la misma ruta que el servidor sirve", async () => {
    const html = await htmlServido();
    const apertura = aperturas(html)[0] as string;
    const src = /\ssrc="([^"]*)"/.exec(apertura)?.[1];
    expect(src).toBe("/app.js");

    const res = await freshApp().inject({ method: "GET", url: src as string });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
  });

  it("se carga con `defer`, para ejecutarse con el documento ya completo", async () => {
    const html = await htmlServido();
    const apertura = aperturas(html)[0] as string;
    // Atributo booleano, sin valor: `defer`, no `defer="true"` ni `async`.
    expect(apertura).toMatch(/\sdefer\s*>/);
    expect(apertura).not.toMatch(/\basync\b/);
  });

  it("el elemento va VACÍO: ni una línea de JavaScript en línea entre sus etiquetas", async () => {
    const html = await htmlServido();
    const cuerpo = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html)?.[1];
    expect(cuerpo).toBe("");
    // Y ningún manejador en línea del tipo `onclick="…"` por la puerta de atrás.
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  /**
   * NINGUNA URL EXTERNA, COMPROBADO POSICIONALMENTE.
   *
   * Aquí vivía `expect(html).not.toMatch(/https?:\/\//i)`, un barrido de texto
   * que la web pública iba a obligar a relajar en cuanto apareciera un `xmlns`
   * de SVG — y la forma cómoda de relajarlo (un `replace` global de esa cadena
   * antes de comparar) habría dejado pasar CUALQUIER URL escrita así.
   *
   * Se sustituye por el barrido del documento ANALIZADO: cada atributo capaz de
   * llevar una URL debe empezar por `#` o por `/`. Es más estricto que lo
   * anterior, no menos: caza también un `mailto:`, un `tel:`, un `data:` y un
   * `//cdn.ejemplo`, que el barrido de `https?` dejaba pasar.
   *
   * Y LA REGLA DE TEXTO SE QUEDA IGUAL DE DURA, sin ninguna excepción. Los SVG
   * que la plantilla incrusta NO declaran `xmlns` —en HTML no hace falta,
   * porque el analizador ya sabe en qué espacio de nombres está un `<svg>`—,
   * así que el documento no contiene ni un `http://`. Se afirman las dos cosas:
   * cero `xmlns` en el documento y cero `https?://` en su texto. Dejar montada
   * una excepción «por si acaso» es lo que mañana alguien ensancha; si algún día
   * hiciera falta de verdad, tendrá que añadirse aquí a propósito.
   */
  it("no hay ningún recurso de terceros: ni //, ni esquema, ni dominio, en NINGÚN atributo", async () => {
    const html = await htmlServido();
    const document = parseHtmlDocument(html);

    const ofensas = urlsDelDocumento(document)
      .map((u) => ({ ...u, motivo: motivoDeUrlInaceptable(u.valor) }))
      .filter((u) => u.motivo !== null)
      .map((u) => `<${u.etiqueta} ${u.atributo}="${u.valor}"> ${u.motivo ?? ""}`);
    expect(ofensas).toEqual([]);

    // El HTML no declara NINGÚN espacio de nombres: no le hace falta.
    expect(
      espaciosDeNombresDelDocumento(document),
      "el HTML ha ganado un xmlns; si es legítimo, la excepción se añade aquí a propósito",
    ).toEqual([]);
    expect(ESPACIOS_DE_NOMBRES_PERMITIDOS).toHaveLength(2);

    // Y por tanto la regla de texto sigue siendo la estricta de siempre.
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/(?:src|href)="\/\//i);
  });

  it("la CSP servida sigue permitiendo sólo 'self', sin 'unsafe-inline' ni 'unsafe-eval'", async () => {
    const res = await freshApp().inject({ method: "GET", url: "/demo-salon-demo" });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https?:/i);
    expect(csp).not.toMatch(/\/\//);
    // La lista de orígenes permitidos es, literalmente, sólo `'self'`.
    expect(origenesDeCsp(csp)).toEqual(["'none'", "'self'"]);
  });

  /**
   * LA LISTA DE `<link>`, ENUMERADA ENTERA.
   *
   * Antes decía «hay exactamente uno y es `/app.css`». Con el icono por local
   * hay dos, y la tentación al verla en rojo es relajarla a «hay al menos uno»
   * —con lo que un `<link rel="stylesheet" href="//cdn…">` colado entraría sin
   * que nadie se enterase—. Se hace al revés: se enumera el CONJUNTO COMPLETO
   * de pares `(rel, href)` con `toEqual`, así que añadir o quitar un enlace
   * obliga a editar esta línea a propósito. Y cada `href` se saca del documento
   * y SE PIDE AL SERVIDOR: un `<link>` que apunta a un 404 es un recurso que no
   * existe, y eso no lo dice ninguna comparación de cadenas.
   */
  it("la lista de <link> del documento es exactamente la esperada, y cada href responde 200", async () => {
    const app = freshApp();
    for (const tenantId of ["demo-salon-demo", "demo-dos"]) {
      const res = await app.inject({ method: "GET", url: `/${tenantId}` });
      const document = parseHtmlDocument(res.body);
      const enlaces = document
        .querySelectorAll("link")
        .map((l) => [l.getAttribute("rel"), l.getAttribute("href")]);

      expect(enlaces, tenantId).toEqual([
        ["stylesheet", "/app.css"],
        ["icon", `/brand/${tenantId}/icon.svg`],
      ]);

      for (const [, href] of enlaces) {
        expect(motivoDeUrlInaceptable(href as string), `<link href="${href ?? ""}">`).toBeNull();
        const recurso = await app.inject({ method: "GET", url: href as string });
        expect(recurso.statusCode, `el <link> de ${tenantId} apunta a «${href ?? ""}»`).toBe(200);
      }
    }
  });
});

describe("Demostración web · interfaz · textos obligatorios estáticos", () => {
  const html = renderBookingHtml(vistaDelRegistro("demo-salon-demo"));

  /**
   * EL AVISO CONTRACTUAL, EXACTAMENTE UNA VEZ Y COLGANDO DEL `<footer>`.
   *
   * `>= 1` sobre el texto entero era una comprobación que nunca podía detectar
   * lo que importa: que el NODO del pie se perdiera mientras la frase sobrevive
   * en un párrafo de marketing. Con copy público, esa frase puede aparecer por
   * casualidad en cualquier sitio. Ahora se exige la cuenta exacta —una— y se
   * comprueba que el nodo que la lleva tiene un `<footer>` entre sus ancestros.
   *
   * La franja superior y la cabecera del cajón dicen otra cosa
   * (`content.demoBanner`, propia del local y obligada a contener la palabra
   * «demostración»), así que el aviso está en tres sitios sin que el literal del
   * contrato se pueda contar dos veces.
   */
  it('el aviso "Entorno de demostración · Datos ficticios" aparece UNA vez, y en el <footer>', () => {
    const AVISO = "Entorno de demostración · Datos ficticios";
    expect(html.split(AVISO).length - 1).toBe(1);

    const document = parseHtmlDocument(html);
    const portador = todosLosElementos(document).find(
      (n) => n.children.length === 0 && n.textContent.includes(AVISO),
    );
    expect(portador, "nadie pinta el aviso contractual").toBeDefined();

    const ancestros: string[] = [];
    for (let n = (portador as FakeElement).parentNode; n !== null; n = n.parentNode) {
      ancestros.push(n.tagName);
    }
    expect(ancestros, "el aviso contractual no cuelga del <footer>").toContain("FOOTER");
  });

  /**
   * Las dos frases del pago, sobre el NODO que las lleva y no sobre el texto del
   * documento. `toContain` sobre el HTML entero seguiría en verde aunque el
   * `<fieldset>` de pago desapareciera y la frase quedara suelta en un párrafo
   * de la portada: comparando `textContent` del nodo con su identificador, la
   * prueba habla de la interfaz de pago y no del diccionario de la página.
   */
  it('"Pago simulado · No se realizarán cargos" es el texto de su propio nodo, junto a confirmar', () => {
    const document = parseHtmlDocument(html);
    const nota = document.getElementById("txb-pago-simulado-nota");
    expect(nota?.textContent).toBe("Pago simulado · No se realizarán cargos");
    // Nace oculto: lo enseña el cliente al elegir hueco, no antes.
    expect(nota?.hidden).toBe(true);
    expect(document.getElementById("txb-btn-confirmar")?.tagName).toBe("BUTTON");
  });

  it('la opción "Pagar en la peluquería" es un radio con su valor del contrato', () => {
    const document = parseHtmlDocument(html);
    const radio = document.getElementById("txb-pago-local");
    expect(radio?.tagName).toBe("INPUT");
    expect(radio?.getAttribute("type")).toBe("radio");
    expect(radio?.getAttribute("value")).toBe("pay_at_salon");
    expect(radio?.getAttribute("name")).toBe(
      document.getElementById("txb-pago-ahora")?.getAttribute("name"),
    );

    // Y su etiqueta —el `<label>` que lo envuelve— es la que dice la frase.
    let etiqueta = radio?.parentNode ?? null;
    while (etiqueta !== null && etiqueta.tagName !== "LABEL") etiqueta = etiqueta.parentNode;
    expect(etiqueta, "el radio de pago no está dentro de un <label>").not.toBeNull();
    expect(etiqueta?.textContent).toContain("Pagar en la peluquería");
  });

  it("los nombres de los profesionales del mockup descartado (Bruno/Unai) no aparecen en ningún fuente", () => {
    const js = renderBookingAppJs();
    for (const nombreDescartado of ["Bruno", "Unai"]) {
      expect(html.includes(nombreDescartado)).toBe(false);
      expect(js.includes(nombreDescartado)).toBe(false);
    }
  });
});

/**
 * ACABADO VISUAL — LO QUE SÓLO EXISTE EN LA HOJA DE ESTILOS.
 *
 * Estos tres arreglos de la revisión de producto no dejan rastro en el marcado
 * —el marcado no cambió—, así que sin estas comprobaciones nadie se enteraría
 * de que se han deshecho: la hoja seguiría siendo válida, seguiría pasando el
 * resto de la suite, y la página volvería a verse mal.
 */
describe("Demostración web · acabado visual de la hoja de estilos", () => {
  const css = BOOKING_CSS;
  /** El cuerpo de la primera regla cuyo selector contiene ese texto. */
  const cuerpoDeLaRegla = (selector: string): string => {
    const i = css.indexOf(selector);
    expect(i, `la hoja no declara ninguna regla para «${selector}»`).toBeGreaterThan(-1);
    const abre = css.indexOf("{", i);
    return css.slice(abre + 1, css.indexOf("}", abre));
  };

  /**
   * EL MODIFICADOR DE UNA COLUMNA ES UN CONTRATO ENTRE DOS FICHEROS: el cliente
   * lo pone (`ui.js.ts`, cuando `byEmployee` trae una sola persona) y la hoja lo
   * presenta. Si aterrizara sólo una de las dos mitades no fallaría nada: la
   * clase quedaría puesta y sin efecto, y la rejilla volvería a leerse como una
   * hoja de cálculo de una columna sin que ninguna prueba lo notara.
   */
  it("la clase que marca la vista de una persona tiene presentación en la hoja", () => {
    expect(renderBookingAppJs()).toContain("txb-slots-table--una-columna");
    expect(css).toContain("txb-slots-table--una-columna");
    // Y lo que hace es repartir las horas en columnas fluidas, no apilarlas.
    expect(cuerpoDeLaRegla("table.txb-slots-table--una-columna tbody {")).toMatch(
      /display:\s*grid/,
    );
    expect(cuerpoDeLaRegla("table.txb-slots-table--una-columna tbody {")).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill/,
    );
  });

  /**
   * Y NADA DE ESA REJILLA SE RETIRA DEL ÁRBOL DE ACCESIBILIDAD. Cambiar
   * `display` en una tabla es una maniobra delicada; taparla con `display:
   * none` sería, además, borrar el encabezado para quien no ve la pantalla. El
   * rótulo «Hora» se oculta como se oculta todo aquí —fuera de la vista,
   * dentro del árbol—, que es exactamente lo que hace `.txb-visually-hidden`.
   */
  it("en la rejilla de una columna nada se esconde con display:none, y el encabezado sigue en el árbol", () => {
    const desde = css.indexOf("table.txb-slots-table--una-columna {");
    const hasta = css.indexOf(".txb-slot-btn {", desde);
    expect(desde).toBeGreaterThan(-1);
    expect(hasta).toBeGreaterThan(desde);
    const bloque = css.slice(desde, hasta);
    expect(bloque, "algo de la rejilla de una columna se retira con display:none").not.toMatch(
      /display:\s*none/,
    );
    expect(bloque).not.toMatch(/visibility:\s*hidden/);

    // El rótulo «Hora» se oculta con el mismo recurso que `.txb-visually-hidden`.
    const rotulo = cuerpoDeLaRegla("table.txb-slots-table--una-columna thead th:first-child {");
    expect(rotulo).toMatch(/position:\s*absolute/);
    expect(rotulo).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
  });

  /**
   * EL LOGOTIPO. El activo es un escudo cuadrado, en blanco y sin canal alfa,
   * con un tercio de su alto en margen: metido entero en la barra no se leía, y
   * la placa que le hacía falta para no dejar costura contra el lienzo se veía
   * como una pegatina. Ahora se recorta el margen muerto y el blanco lo absorbe
   * la mezcla, así que NO puede volver la placa ni el aro.
   */
  it("el logotipo se muestra recortado y sin placa, y el distintivo tipográfico mide lo mismo", () => {
    const logo = cuerpoDeLaRegla(".txb-brand img {");
    expect(logo).toMatch(/height:\s*44px/);
    expect(logo).toMatch(/width:\s*auto/);
    expect(logo, "sin object-fit el recorte deformaría el activo").toMatch(
      /object-fit:\s*cover/,
    );
    expect(logo).toMatch(/mix-blend-mode:\s*multiply/);
    expect(logo, "la placa blanca del logotipo ha vuelto").not.toMatch(/background/);
    expect(logo, "el aro que peleaba con el lienzo ha vuelto").not.toMatch(/box-shadow/);

    // Las dos barras anclan a la misma altura: PNG recortado y monograma.
    expect(cuerpoDeLaRegla(".txb-brand-mark {")).toMatch(/height:\s*44px/);
  });

  /**
   * LA JERARQUÍA DE LA FICHA DE SERVICIO. Manda el NOMBRE, y manda por familia
   * —la serif de titulares— además de por tamaño. Si volviera a la sans del
   * texto corrido perdería la única señal que lo separa del resto de la ficha.
   */
  it("en la ficha de servicio manda el nombre, y ni el precio ni la categoría le disputan el sitio", () => {
    const nombre = cuerpoDeLaRegla(".txb-tile__name {");
    expect(nombre).toMatch(/font-family:\s*var\(--txb-font-display\)/);

    // El precio deja de ser lo más grande y lo más saturado de la ficha: pasa a
    // tinta, para que el único acento de ahí abajo sea el botón de reserva.
    const precio = cuerpoDeLaRegla(".txb-tile__price {");
    expect(precio).toMatch(/color:\s*var\(--txb-ink-900\)/);
    expect(precio, "el precio ha vuelto a llevarse el acento de la ficha").not.toMatch(
      /var\(--txb-accent/,
    );
  });
});
