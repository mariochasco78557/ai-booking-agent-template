import { describe, expect, it } from "vitest";

import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import { esTabulable, ordenDeTabulacion, type FakeDocument } from "./fakeDom.js";
import { abrirPaginaLista, byId, documentoDe, freshApp } from "./paginaViva.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * LA NAVEGACIÓN Y EL MENÚ MÓVIL.
 *
 * Una web de una sola página vive de sus anclas, y el fallo más común de todas
 * ellas es un enlace de la barra que apunta a un identificador que ya no
 * existe: no da error, no avisa, simplemente no lleva a ninguna parte. Aquí
 * cada enlace se sigue hasta su destino DENTRO del documento servido.
 *
 * Del menú móvil lo que importa no es que se abra, sino el FOCO: un panel que
 * aparece y deja el foco detrás obliga a quien navega con teclado a recorrer la
 * página entera para llegar a él, y uno que se cierra sin devolver el foco lo
 * deja perdido en el `<body>`, que en teclado significa «vuelve a empezar por
 * el principio».
 *
 * `Escape` sobre este panel SÍ es responsabilidad de la aplicación, y por eso
 * se prueba: un `<div>` no es un `<dialog>` y no lo cierra solo. El DOM falso
 * de estas pruebas emula el cierre automático únicamente para un `<dialog
 * open>` —que es lo que hace el navegador—, nunca para un panel corriente.
 * ════════════════════════════════════════════════════════════════════════
 */

/** Los enlaces internos del documento y su identificador de destino. */
function anclasInternas(document: FakeDocument): Array<{ href: string; destino: string }> {
  return document
    .querySelectorAll("a")
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href.startsWith("#"))
    .map((href) => ({ href, destino: href.slice(1) }));
}

describe("Demostración web · la barra de navegación lleva a sitios que existen", () => {
  it("hay un <nav> con nombre accesible, y todo enlace suyo apunta a un id del documento", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);

      const navs = document.querySelectorAll("nav");
      expect(navs.length, `${tenantId}: número de <nav>`).toBe(1);
      expect(navs[0]?.getAttribute("aria-label"), tenantId).toBeTruthy();

      const enlaces = byId(document, "txb-nav").querySelectorAll("a");
      expect(enlaces.length, `${tenantId}: la navegación no tiene enlaces`).toBeGreaterThan(0);
      for (const enlace of enlaces) {
        const href = enlace.getAttribute("href") ?? "";
        expect(href.startsWith("#"), `${tenantId}: «${href}» no es un ancla interna`).toBe(true);
        expect(
          document.getElementById(href.slice(1)),
          `${tenantId}: la navegación enlaza «${href}», que no existe en el documento`,
        ).not.toBeNull();
        expect(enlace.textContent.trim().length, `${tenantId}: enlace sin texto`).toBeGreaterThan(0);
      }
    }
  });

  it("NINGÚN ancla del documento —de la barra o de donde sea— queda rota", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const rotas = anclasInternas(document)
        .filter(({ destino }) => document.getElementById(destino) === null)
        .map(({ href }) => href);
      expect(rotas, `${tenantId}: anclas que no llevan a ninguna parte`).toEqual([]);
    }
  });

  /**
   * EL ENLACE DE SALTO ES EL PRIMER TABULABLE. Si no lo fuera, no serviría de
   * nada: su razón de ser es que la primera pulsación de Tab en la página ofrezca
   * saltarse la cabecera. `txb-visually-hidden` lo esconde a la vista pero NO lo
   * saca de la secuencia de tabulación, y el ayudante de visibilidad de
   * `fakeDom.ts` lo tiene en cuenta a propósito.
   */
  it("el enlace de salto es el PRIMER tabulable y su destino existe y es enfocable", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);

      const primero = ordenDeTabulacion(document)[0];
      expect(primero?.getAttribute("id"), `${tenantId}: el primer tabulable`).toBe("txb-skip");

      const href = primero?.getAttribute("href") ?? "";
      expect(href.startsWith("#"), tenantId).toBe(true);
      const destino = document.getElementById(href.slice(1));
      expect(destino, `${tenantId}: el enlace de salto apunta a «${href}», que no existe`).not.toBeNull();
      // Enfocable por programa: `tabindex="-1"` es justo lo que permite recibir
      // el foco sin entrar en la secuencia de tabulación.
      expect(destino?.getAttribute("tabindex"), tenantId).toBe("-1");
      expect(destino?.tagName, tenantId).toBe("MAIN");
    }
  });

  it("ningún elemento del documento usa un tabindex POSITIVO", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const positivos = document
        .querySelectorAll("[tabindex]")
        .map((n) => ({ etiqueta: n.tagName, valor: n.getAttribute("tabindex") }))
        .filter((n) => Number(n.valor) > 0);
      expect(
        positivos,
        `${tenantId}: un tabindex positivo reordena la tabulación de toda la página`,
      ).toEqual([]);
    }
  });
});

describe("Demostración web · el menú móvil, con su foco y su Escape", () => {
  it("nace cerrado, con su estado accesible declarado y apuntando a su panel", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const toggle = byId(document, "txb-nav-toggle");
      const menu = byId(document, "txb-nav-menu");

      expect(toggle.tagName, tenantId).toBe("BUTTON");
      expect(toggle.getAttribute("type"), tenantId).toBe("button");
      expect(toggle.getAttribute("aria-expanded"), tenantId).toBe("false");
      expect(toggle.getAttribute("aria-controls"), tenantId).toBe("txb-nav-menu");
      expect(document.getElementById(toggle.getAttribute("aria-controls") ?? ""), tenantId).toBe(menu);
      expect(menu.hidden, `${tenantId}: el panel del menú nace abierto`).toBe(true);

      // Un botón cuyo contenido es un icono necesita nombre accesible: aquí lo
      // pone un texto oculto a la vista, que un lector sí lee.
      expect(toggle.textContent.trim().length, `${tenantId}: el botón de menú no dice nada`).toBeGreaterThan(
        0,
      );

      // Y mientras está cerrado, sus enlaces NO son alcanzables con el teclado.
      for (const enlace of menu.querySelectorAll("a")) {
        expect(esTabulable(enlace), `${tenantId}: enlace tabulable dentro de un panel cerrado`).toBe(false);
      }
    }
  });

  it("al abrirlo, lo dice y lleva el foco al primer enlace del panel", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const toggle = byId(pagina.document, "txb-nav-toggle");
    const menu = byId(pagina.document, "txb-nav-menu");

    toggle.dispatchClick();

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(menu.hidden).toBe(false);
    const primerEnlace = menu.querySelectorAll("a")[0];
    expect(primerEnlace, "el panel del menú no tiene ningún enlace").toBeDefined();
    expect(
      pagina.document.activeElement,
      "el menú se ha abierto y el foco se ha quedado detrás",
    ).toBe(primerEnlace);
    // Y ahora sí son alcanzables.
    expect(esTabulable(primerEnlace as NonNullable<typeof primerEnlace>)).toBe(true);
  });

  it("Escape lo cierra y DEVUELVE el foco al botón", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const toggle = byId(pagina.document, "txb-nav-toggle");
    const menu = byId(pagina.document, "txb-nav-menu");

    toggle.dispatchClick();
    expect(menu.hidden).toBe(false);

    // La tecla se pulsa en el DOCUMENTO, como en un navegador. El panel es un
    // `<div>`, así que si el cliente no escuchara `Escape` no pasaría nada:
    // aquí no hay ningún cierre automático que lo salve.
    pagina.document.dispatchKeydown("Escape");

    expect(menu.hidden, "Escape no ha cerrado el menú").toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(pagina.document.activeElement, "el foco se ha quedado en el vacío").toBe(toggle);
  });

  it("Escape pulsado DENTRO del panel también lo cierra: la tecla burbujea", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const toggle = byId(pagina.document, "txb-nav-toggle");
    const menu = byId(pagina.document, "txb-nav-menu");

    toggle.dispatchClick();
    const primerEnlace = menu.querySelectorAll("a")[0];
    primerEnlace?.dispatchKeydown("Escape");

    expect(menu.hidden).toBe(true);
    expect(pagina.document.activeElement).toBe(toggle);
  });

  it("un segundo clic en el botón cierra y devuelve el foco igual", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const toggle = byId(pagina.document, "txb-nav-toggle");
    const menu = byId(pagina.document, "txb-nav-menu");

    toggle.dispatchClick();
    expect(menu.hidden).toBe(false);
    toggle.dispatchClick();

    expect(menu.hidden, "sólo se implementó el cierre con Escape").toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(pagina.document.activeElement).toBe(toggle);
  });

  it("pulsar un enlace del panel lo cierra: no se queda tapando el destino", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const toggle = byId(pagina.document, "txb-nav-toggle");
    const menu = byId(pagina.document, "txb-nav-menu");

    toggle.dispatchClick();
    menu.querySelectorAll("a")[0]?.dispatchClick();

    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * EL MENÚ NO BLOQUEA EL DESPLAZAMIENTO DEL DOCUMENTO. El truco habitual para
   * un panel a pantalla completa es añadirle una clase al `<body>` que le pone
   * `overflow: hidden`; el fallo habitual es no quitarla al cerrar, y la página
   * se queda sin poder desplazarse hasta recargar. Aquí se compara la lista de
   * clases del `<body>` antes de abrir y después de cerrar, por las dos vías.
   */
  it("abrir y cerrar deja el <body> exactamente como estaba, por Escape y por botón", async () => {
    for (const cerrar of ["escape", "boton"] as const) {
      const pagina = await abrirPaginaLista("demo-salon-demo");
      const toggle = byId(pagina.document, "txb-nav-toggle");
      const antes = pagina.document.body.className;

      toggle.dispatchClick();
      const conElMenuAbierto = pagina.document.body.className;
      if (cerrar === "escape") pagina.document.dispatchKeydown("Escape");
      else toggle.dispatchClick();

      expect(pagina.document.body.className, `cierre por ${cerrar}`).toBe(antes);
      expect(
        conElMenuAbierto,
        "el menú abierto ha tocado las clases del <body>: ahí es donde se bloquea el scroll",
      ).toBe(antes);
    }
  });

  /**
   * Y la lista de enlaces del panel es la MISMA que la de la barra: dos listas
   * distintas es una que se queda atrás. Se comparan los destinos, no el
   * marcado, porque el panel se emite aparte a propósito.
   */
  it("el panel móvil ofrece los mismos destinos, en el mismo orden, que la barra de escritorio", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);

      // La misma lista se emite DOS veces —la de escritorio y la del panel— y
      // ninguna repite identificador, porque sus enlaces van por clase.
      const listas = byId(document, "txb-nav").querySelectorAll(".txb-nav__list");
      expect(listas, `${tenantId}: número de listas de navegación`).toHaveLength(2);

      const destinos = listas.map((lista) =>
        lista.querySelectorAll("a").map((a) => a.getAttribute("href")),
      );
      expect(destinos[0]?.length, tenantId).toBeGreaterThan(0);
      expect(destinos[0], `${tenantId}: las dos listas de navegación no coinciden`).toEqual(destinos[1]);

      // La segunda es, exactamente, la que vive dentro del panel del menú.
      const menu = byId(document, "txb-nav-menu");
      expect(menu.querySelectorAll("a").map((a) => a.getAttribute("href"))).toEqual(destinos[1]);

      // El CTA de la barra va aparte de las listas y apunta a la reserva.
      const cta = byId(document, "txb-cta-nav");
      expect(cta.getAttribute("href"), tenantId).toBe("#txb-seccion-reserva");
      expect(destinos[0], `${tenantId}: el CTA no debe repetirse dentro de la lista`).not.toContain(
        "#txb-seccion-reserva",
      );
    }
  });
});
