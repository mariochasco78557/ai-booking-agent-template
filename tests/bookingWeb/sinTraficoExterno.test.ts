import { describe, expect, it } from "vitest";

import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import type { FakeElement } from "./fakeDom.js";
import {
  abrirPaginaLista,
  byId,
  documentoDe,
  esperarA,
  freshApp,
  paginaDe,
} from "./paginaViva.helpers.js";
import {
  ATRIBUTOS_DE_URL,
  espaciosDeNombresDelDocumento,
  motivoDeUrlInaceptable,
  todosLosElementos,
  urlsDelDocumento,
} from "./seguridad.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * ESTA PÁGINA NO LE PIDE NADA A NADIE.
 *
 * La CSP (`default-src 'none'`, sin `data:` y sin ningún origen) protege a quien
 * abre la página. Lo que la CSP no protege es el REPOSITORIO: el día que alguien
 * quiera una fuente de Google, un icono de un CDN o un píxel de analítica, lo
 * primero que hará será aflojar la política para que funcione. Estas pruebas son
 * lo que hace que aflojarla salga caro.
 *
 * SE BARREN CUATRO SUPERFICIES, y las cuatro por separado porque fallan de
 * formas distintas:
 *   · EL DOCUMENTO, atributo a atributo. Caza `mailto:`, `tel:`, `data:`,
 *     `blob:`, `javascript:` y el protocolo-relativo `//cdn…`, que un barrido
 *     de `https?://` deja pasar entero.
 *   · LA HOJA DE ESTILOS: `url()`, `@import`, `@font-face` y `src:`. Una fuente
 *     externa entra por ahí sin tocar el HTML.
 *   · EL CLIENTE: ni un `http`, ni un literal de cadena que empiece por `//`.
 *   · EL ICONO SERVIDO, que es un documento SVG y admite `<script>`,
 *     `<foreignObject>` e `<image href>` si nadie lo mira.
 *
 * Y EL CASO QUE LO CIERRA TODO: un recorrido completo con `fetch` REGISTRADO. Al
 * terminar, toda URL por la que el cliente ha pasado cumple `^/api/<tenantId>/`.
 * Es lo único que detecta un `fetch` de analítica añadido en una función que
 * ninguna otra prueba ejecuta.
 * ════════════════════════════════════════════════════════════════════════
 */

describe("Demostración web · el documento no referencia nada de fuera", () => {
  it("todo src/href/action… empieza por # o por /, en los DOS locales", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const urls = urlsDelDocumento(document);
      expect(urls.length, `${tenantId}: el documento no referencia nada`).toBeGreaterThan(0);

      const ofensas = urls
        .map((u) => ({ ...u, motivo: motivoDeUrlInaceptable(u.valor) }))
        .filter((u) => u.motivo !== null)
        .map((u) => `${tenantId}: <${u.etiqueta} ${u.atributo}="${u.valor}"> ${u.motivo ?? ""}`);
      expect(ofensas).toEqual([]);
    }
  });

  it("cada ancla interna lleva a un id que existe, y cada ruta absoluta la sirve el servidor", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      for (const { valor, etiqueta, atributo } of urlsDelDocumento(document)) {
        if (valor.startsWith("#")) {
          expect(
            document.getElementById(valor.slice(1)),
            `${tenantId}: <${etiqueta} ${atributo}="${valor}"> no lleva a ninguna parte`,
          ).not.toBeNull();
          continue;
        }
        const res = await app.inject({ method: "GET", url: valor });
        expect(res.statusCode, `${tenantId}: <${etiqueta} ${atributo}="${valor}">`).toBe(200);
      }
    }
  });

  /**
   * La regla de texto se conserva ESTRICTA y sin excepciones. Los SVG que la
   * plantilla incrusta no declaran `xmlns` —en HTML no hace falta—, así que el
   * documento no contiene ni un `http://`. Montar aquí una excepción «por si
   * acaso» es lo que mañana alguien ensancha.
   */
  it("ni un http(s) ni un // en el texto del documento, sin excepciones", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const html = await paginaDe(app, tenantId);
      expect(html, tenantId).not.toMatch(/https?:\/\//i);
      expect(html, tenantId).not.toMatch(/(?:src|href|action|poster|cite|data)\s*=\s*["']\/\//i);
      expect(html, tenantId).not.toMatch(/javascript:/i);
      expect(html, tenantId).not.toMatch(/\bmailto:/i);
      expect(html, tenantId).not.toMatch(/\btel:/i);
      expect(html, tenantId).not.toMatch(/\bdata:[a-z]+\//i);

      const document = await documentoDe(app, tenantId);
      expect(espaciosDeNombresDelDocumento(document), `${tenantId}: el HTML declara un xmlns`).toEqual([]);
    }
  });

  it("la lista de atributos que se barren cubre los que el documento usa de verdad", async () => {
    // Una lista de atributos que no incluyera `src` o `href` dejaría el barrido
    // sin nada que mirar y las tres pruebas de arriba pasarían vacías.
    expect(ATRIBUTOS_DE_URL).toContain("src");
    expect(ATRIBUTOS_DE_URL).toContain("href");
    expect(ATRIBUTOS_DE_URL).toContain("action");
    expect(ATRIBUTOS_DE_URL).toContain("formaction");

    const document = await documentoDe(freshApp(), "demo-salon-demo");
    const usados = new Set(urlsDelDocumento(document).map((u) => u.atributo));
    expect([...usados].sort(), "el documento usa un atributo de URL inesperado").toEqual(["href", "src"]);
  });
});

describe("Demostración web · la hoja de estilos no descarga nada", () => {
  it("sin url(), sin @import, sin @font-face y sin src:", async () => {
    const css = (await freshApp().inject({ method: "GET", url: "/app.css" })).body;
    expect(css.length).toBeGreaterThan(1000);

    const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls, "la hoja ha empezado a descargar algo").toEqual([]);
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toMatch(/@font-face/i);
    expect(css).not.toMatch(/(^|[;{\s])src\s*:/i);
    expect(css).not.toMatch(/https?:\/\//i);

    // Las familias tipográficas son las del SISTEMA: no hay nada que descargar.
    expect(css).toContain("--txb-font-text");
    expect(css).toContain("system-ui");
  });
});

describe("Demostración web · el cliente sólo habla con su propio servidor", () => {
  it("el texto del cliente no contiene ningún esquema ni ninguna URL protocolo-relativa", async () => {
    const js = (await freshApp().inject({ method: "GET", url: "/app.js" })).body;
    expect(js.length).toBeGreaterThan(1000);

    expect(js).not.toMatch(/https?:/i);
    // Protocolo-relativa SÓLO dentro de un literal de cadena: la comilla de
    // apertura pegada delante es lo que impide confundirla con un comentario
    // `//` de JavaScript, que este fichero tiene a decenas.
    expect(js).not.toMatch(/(['"`])\/\//);
    expect(js).not.toMatch(/\bXMLHttpRequest\b/);
    expect(js).not.toMatch(/\bWebSocket\b/);
    expect(js).not.toMatch(/\bnavigator\.sendBeacon\b/);
    expect(js).not.toMatch(/\bimportScripts\b/);
  });

  /**
   * EL CASO DECISIVO. La CSP protege al usuario; sólo esta prueba protege al
   * repositorio. Se recorre un flujo COMPLETO desde la portada —CTA, cajón, día,
   * hueco, pago, confirmación, panel, reinicio— con `fetch` registrado, y al
   * final se mira la lista entera: toda URL tiene que ser de la API de ESTE
   * local. Un `fetch` de analítica escondido en una función que ninguna otra
   * prueba ejecuta aparecería aquí.
   */
  it("tras un recorrido COMPLETO, toda URL pedida es /api/<tenantId>/…", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      const { document } = pagina;

      (document.getElementById("txb-servicios-grid")?.children[0] as FakeElement).dispatchClick();
      byId(document, "txb-btn-continuar").dispatchClick();
      byId(document, "txb-profesionales-grid").children.find((f) => !f.disabled)?.dispatchClick();
      byId(document, "txb-btn-continuar").dispatchClick();
      byId(document, "txb-dia-chips").children.find((c) => !c.disabled)?.dispatchClick();

      const rejilla = byId(document, "txb-rejilla");
      await esperarA(() => rejilla.querySelectorAll(".txb-slot-btn").length > 0, `los huecos de ${tenantId}`);
      rejilla.querySelectorAll(".txb-slot-btn").find((b) => !b.disabled)?.dispatchClick();

      const pago = byId(document, "txb-pago-ahora");
      pago.checked = true;
      pago.dispatchChange();
      byId(document, "txb-btn-confirmar").dispatchClick();
      await esperarA(() => !byId(document, "txb-paso-confirmacion").hidden, `la confirmación de ${tenantId}`);

      // Panel y reinicio, que son las dos rutas que faltaban por pisar.
      byId(document, "txb-tab-dashboard").dispatchClick();
      await esperarA(
        () => byId(document, "txb-dashboard-totales").children.length > 0,
        `el panel de ${tenantId}`,
      );
      byId(document, "txb-btn-abrir-reset").dispatchClick();
      byId(document, "txb-dialog-reset-confirmar").dispatchClick();
      await esperarA(
        () => pagina.urlsPedidas.some((u) => u.endsWith("/reset")),
        `el reinicio de ${tenantId}`,
      );

      expect(pagina.urlsPedidas.length, `${tenantId}: el cliente no ha pedido nada`).toBeGreaterThan(4);
      for (const url of pagina.urlsPedidas) {
        expect(
          url.startsWith(`/api/${tenantId}/`),
          `${tenantId}: el cliente ha pedido «${url}», que no es su propia API`,
        ).toBe(true);
        expect(motivoDeUrlInaceptable(url), `${tenantId}: «${url}»`).toBeNull();
      }
      // Y ha pasado por las cinco rutas de la API, no por una sola.
      for (const ruta of ["/bootstrap", "/availability", "/book", "/dashboard", "/reset"]) {
        expect(
          pagina.urlsPedidas.some((u) => u.includes(ruta)),
          `${tenantId}: el recorrido no ha llegado a «${ruta}»`,
        ).toBe(true);
      }
    }
  });
});

describe("Demostración web · el icono servido es inerte", () => {
  it("su único URI es el espacio de nombres de SVG, y no puede ejecutar ni descargar nada", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const href = document.querySelector('link[rel="icon"]')?.getAttribute("href") as string;
      const svg = (await app.inject({ method: "GET", url: href })).body;

      expect([...svg.matchAll(/https?:\/\/[^\s"'<>]*/gi)].map((m) => m[0]), tenantId).toEqual([
        "http://www.w3.org/2000/svg",
      ]);
      for (const prohibido of ["<script", "<foreignobject", "<image", "<use", "href", "url(", "onload"]) {
        expect(svg.toLowerCase().includes(prohibido), `${tenantId}: el icono contiene «${prohibido}»`).toBe(
          false,
        );
      }
    }
  });
});

describe("Demostración web · nada del documento puede salir del origen por otra vía", () => {
  it("ni <form>, ni <iframe>, ni <object>, ni <embed>, ni target, ni ping", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      for (const etiqueta of ["form", "iframe", "object", "embed", "frame", "frameset", "portal"]) {
        expect(document.querySelectorAll(etiqueta), `${tenantId}: hay un <${etiqueta}>`).toEqual([]);
      }
      const conSalida = todosLosElementos(document)
        .filter((n) => n.getAttribute("target") !== null || n.getAttribute("ping") !== null)
        .map((n) => n.tagName);
      expect(conSalida, tenantId).toEqual([]);
    }
  });
});
