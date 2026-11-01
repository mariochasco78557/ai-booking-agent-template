import { describe, expect, it } from "vitest";

import { PUBLIC_SECTION_DOM_IDS } from "../../src/bookingWeb/model.js";
import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import { esVisibleParaElTeclado, ordenDeTabulacion, type FakeElement } from "./fakeDom.js";
import { documentoDe, freshApp } from "./paginaViva.helpers.js";
import { todosLosElementos } from "./seguridad.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * ACCESIBILIDAD ESTRUCTURAL: lo que se puede afirmar sobre el DOCUMENTO.
 *
 * Este fichero cubre la parte de la matriz de accesibilidad que NO necesita un
 * navegador: landmarks, jerarquía de encabezados, orden de tabulación, tipos de
 * campo, atributos prohibidos y las dos reglas de la hoja de estilos que
 * sostienen el foco visible y el respeto por «reducir movimiento».
 *
 * LO QUE NO ESTÁ AQUÍ, Y NO ES UN OLVIDO. El contraste real de un color
 * compuesto, el tamaño en píxeles de un objetivo táctil, el zoom al 200 % y el
 * recorrido con `Tab` de verdad dependen del CSS APLICADO y sólo se pueden
 * medir en Chrome. Fingirlos aquí daría una lista de casos verdes que no
 * probarían nada, que es peor que no tenerlos. Quedan para la auditoría con
 * CDP, y esta suite no los da por hechos.
 *
 * Todo se mide sobre el HTML REALMENTE SERVIDO de los DOS locales, analizado.
 * ════════════════════════════════════════════════════════════════════════
 */

const LOCALES = tenantIds(buildTenantRegistry());

/** Los encabezados del documento, en orden, con su nivel. */
function encabezados(elementos: FakeElement[]): Array<{ nivel: number; nodo: FakeElement }> {
  return elementos
    .filter((n) => /^H[1-6]$/.test(n.tagName))
    .map((n) => ({ nivel: Number(n.tagName.slice(1)), nodo: n }));
}

/**
 * Las reglas planas de una hoja: `selector { cuerpo }`, sin las envolturas de
 * `@media`. Los comentarios se quitan ANTES: si no, el selector de cada regla
 * arrastraría el comentario que la precede y ninguna comparación exacta
 * funcionaría —y esta hoja está comentada línea a línea—.
 */
function reglasCss(css: string): Array<{ selector: string; cuerpo: string }> {
  const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "\n");
  return [...sinComentarios.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").trim(),
    cuerpo: (m[2] ?? "").trim(),
  }));
}

/** El valor de un token `--txb-*` declarado en `:root`. */
function tokenDeRaiz(css: string, token: string): string {
  const raiz = css.slice(css.indexOf(":root {"));
  const encontrado = new RegExp(`${token}:\\s*([^;]+);`).exec(raiz.slice(0, raiz.indexOf("}")));
  if (!encontrado?.[1]) throw new Error(`La hoja no declara ${token} en :root.`);
  return encontrado[1].trim();
}

/**
 * Los encabezados que el CLIENTE rellena en tiempo de ejecución, derivados de
 * su propio texto. Nacen vacíos en el HTML servido a propósito —«Horarios del
 * jueves 27» no se puede escribir antes de saber qué día se ha elegido— y
 * exigirles texto sería exigir que la plantilla invente un dato.
 */
function encabezadosQueRellenaElCliente(js: string): Set<string> {
  const ids = new Set<string>();
  for (const m of js.matchAll(/byId\('([^']+)'\)\.textContent\s*=/g)) ids.add(m[1] as string);
  return ids;
}

describe("Demostración web · landmarks", () => {
  it("cada local sirve UN header, UN main y UN footer, y el main no cuelga de los otros", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);

      expect(document.querySelectorAll("header"), `${tenantId}: <header>`).toHaveLength(1);
      expect(document.querySelectorAll("main"), `${tenantId}: <main>`).toHaveLength(1);
      expect(document.querySelectorAll("footer"), `${tenantId}: <footer>`).toHaveLength(1);

      const main = document.querySelector("main") as FakeElement;
      const ancestros: string[] = [];
      for (let n = main.parentNode; n !== null; n = n.parentNode) ancestros.push(n.tagName);
      expect(ancestros, `${tenantId}: el <main> está dentro de otro landmark`).not.toContain("HEADER");
      expect(ancestros, tenantId).not.toContain("NAV");
      expect(ancestros, tenantId).not.toContain("FOOTER");
      expect(ancestros, tenantId).toContain("BODY");
    }
  });

  it("cada <nav> lleva su propio nombre accesible, y no hay dos iguales", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const navs = document.querySelectorAll("nav");
      expect(navs.length, `${tenantId}: no hay ninguna navegación`).toBeGreaterThan(0);

      const nombres = navs.map((n) => n.getAttribute("aria-label") ?? n.getAttribute("aria-labelledby") ?? "");
      for (const [i, nombre] of nombres.entries()) {
        expect(nombre.length, `${tenantId}: el <nav> nº ${String(i + 1)} no tiene nombre`).toBeGreaterThan(0);
      }
      expect(new Set(nombres).size, `${tenantId}: dos <nav> con el mismo nombre`).toBe(nombres.length);
    }
  });

  it("las regiones con role llevan el nombre que ese role exige", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      for (const nodo of todosLosElementos(document)) {
        const role = nodo.getAttribute("role");
        if (role !== "region" && role !== "group") continue;
        const nombre =
          nodo.getAttribute("aria-label") ?? nodo.getAttribute("aria-labelledby") ?? "";
        expect(nombre.length, `${tenantId}: <${nodo.tagName.toLowerCase()} role="${role}"> sin nombre`).toBeGreaterThan(
          0,
        );
      }
      // `role="tab"`/`role="tablist"` con `aria-pressed` era inválido y se
      // quitó: quedan botones normales con su estado de pulsado.
      expect(document.querySelectorAll('[role="tab"]'), tenantId).toEqual([]);
      expect(document.querySelectorAll('[role="tablist"]'), tenantId).toEqual([]);
      for (const boton of document.querySelectorAll("[aria-pressed]")) {
        expect(boton.tagName, `${tenantId}: aria-pressed fuera de un <button>`).toBe("BUTTON");
        expect(["true", "false"]).toContain(boton.getAttribute("aria-pressed"));
      }
    }
  });
});

describe("Demostración web · jerarquía de encabezados", () => {
  it("hay exactamente un <h1>, ninguno vacío y ningún salto de nivel", async () => {
    const app = freshApp();
    const js = (await app.inject({ method: "GET", url: "/app.js" })).body;
    const losRellenaElCliente = encabezadosQueRellenaElCliente(js);

    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const lista = encabezados(todosLosElementos(document));

      expect(lista.filter((h) => h.nivel === 1), `${tenantId}: número de <h1>`).toHaveLength(1);
      expect(lista.length, tenantId).toBeGreaterThan(5);
      expect(lista[0]?.nivel, `${tenantId}: el documento no empieza por el <h1>`).toBe(1);

      for (const [i, h] of lista.entries()) {
        const id = h.nodo.getAttribute("id") ?? "";
        if (!losRellenaElCliente.has(id)) {
          expect(
            h.nodo.textContent.trim().length,
            `${tenantId}: <${h.nodo.tagName.toLowerCase()}#${id}> vacío y nadie lo rellena`,
          ).toBeGreaterThan(0);
        }
        if (i === 0) continue;
        const anterior = lista[i - 1] as { nivel: number; nodo: FakeElement };
        expect(
          h.nivel - anterior.nivel,
          `${tenantId}: salto de <h${String(anterior.nivel)}> a <h${String(h.nivel)}> («${h.nodo.textContent.trim()}»)`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it("cada aria-labelledby apunta a un elemento que existe, y el de una sección es un encabezado", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      for (const nodo of todosLosElementos(document)) {
        const destino = nodo.getAttribute("aria-labelledby");
        if (destino === null) continue;
        const referido = document.getElementById(destino);
        expect(
          referido,
          `${tenantId}: <${nodo.tagName.toLowerCase()} aria-labelledby="${destino}"> apunta al vacío`,
        ).not.toBeNull();
        if (nodo.tagName === "SECTION" || nodo.tagName === "DIALOG") {
          expect(
            /^H[1-6]$/.test((referido as FakeElement).tagName),
            `${tenantId}: «${destino}» no es un encabezado`,
          ).toBe(true);
        }
      }
    }
  });

  it("ninguna sección pública nace oculta: la portada se lee sin JavaScript", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      for (const id of Object.values(PUBLIC_SECTION_DOM_IDS)) {
        const seccion = document.getElementById(id);
        if (seccion === null) continue; // una sección apagada por configuración no se pinta
        expect(seccion.hidden, `${tenantId}: la sección «${id}» nace oculta`).toBe(false);
        expect(esVisibleParaElTeclado(seccion), `${tenantId}: «${id}» no es alcanzable`).toBe(true);
      }
      // Y los pasos 2, 3 y 4 del asistente SÍ nacen ocultos: es su estado inicial.
      for (const paso of ["txb-paso-profesional", "txb-paso-fecha-hora", "txb-paso-confirmacion"]) {
        expect(document.getElementById(paso)?.hidden, `${tenantId}/${paso}`).toBe(true);
      }
    }
  });
});

describe("Demostración web · teclado y campos", () => {
  it("el enlace de salto es el primer tabulable y su destino es enfocable", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const primero = ordenDeTabulacion(document)[0] as FakeElement;
      expect(primero.tagName, tenantId).toBe("A");
      const href = primero.getAttribute("href") ?? "";
      expect(href.startsWith("#"), `${tenantId}: «${href}»`).toBe(true);
      const destino = document.getElementById(href.slice(1));
      expect(destino, `${tenantId}: el enlace de salto no lleva a ninguna parte`).not.toBeNull();
      expect((destino as FakeElement).getAttribute("tabindex"), tenantId).toBe("-1");
    }
  });

  it("ningún tabindex positivo reordena la tabulación", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const positivos = document
        .querySelectorAll("[tabindex]")
        .filter((n) => Number(n.getAttribute("tabindex")) > 0)
        .map((n) => `${n.tagName}#${n.getAttribute("id") ?? ""}`);
      expect(positivos, tenantId).toEqual([]);
    }
  });

  /**
   * LOS CAMPOS, SOBRE EL DOCUMENTO Y NO POR EXPRESIÓN REGULAR. Un
   * `<input name="email">` sin `type=` es `type="text"` en HTML y no aparece en
   * ningún `matchAll(/type="…"/)`: es el agujero más probable el día que alguien
   * quiera un formulario de contacto en la portada. Se cuentan los dos totales
   * —todos los `<input>` y los que tienen tipo permitido— y se exige que
   * coincidan, que es lo que cierra la puerta.
   */
  it("todo <input> declara type y es de la lista blanca; ni form, ni textarea, ni select", async () => {
    const app = freshApp();
    const PERMITIDOS = ["radio", "checkbox", "date"];
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const inputs = document.querySelectorAll("input");
      expect(inputs.length, `${tenantId}: el documento no tiene ni un <input>`).toBeGreaterThan(0);

      const conTipoPermitido = inputs.filter((i) => PERMITIDOS.includes(i.getAttribute("type") ?? ""));
      expect(
        conTipoPermitido.length,
        `${tenantId}: hay ${String(inputs.length - conTipoPermitido.length)} <input> con tipo no permitido o sin type`,
      ).toBe(inputs.length);

      for (const etiqueta of ["form", "textarea", "select"]) {
        expect(document.querySelectorAll(etiqueta), `${tenantId}: hay un <${etiqueta}>`).toEqual([]);
      }
    }
  });

  it("cada <input> tiene nombre accesible: <label> que lo envuelve, aria-label o aria-labelledby", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      for (const input of document.querySelectorAll("input")) {
        const propio =
          (input.getAttribute("aria-label") ?? "") + (input.getAttribute("aria-labelledby") ?? "");
        if (propio.length > 0) continue;
        let etiqueta: FakeElement | null = input.parentNode;
        while (etiqueta !== null && etiqueta.tagName !== "LABEL") etiqueta = etiqueta.parentNode;
        expect(
          etiqueta,
          `${tenantId}: el <input id="${input.getAttribute("id") ?? "?"}"> no tiene nombre accesible`,
        ).not.toBeNull();
        expect((etiqueta as FakeElement).textContent.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("las regiones que anuncian llevan su role y su cortesía", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const error = document.getElementById("txb-error") as FakeElement;
      const anuncio = document.getElementById("txb-anuncio") as FakeElement;

      expect(error.getAttribute("role"), tenantId).toBe("alert");
      expect(error.hidden, `${tenantId}: el aviso de error nace visible y vacío`).toBe(true);
      expect(anuncio.getAttribute("role"), tenantId).toBe("status");
      expect(anuncio.getAttribute("aria-live"), tenantId).toBe("polite");
      // La región de anuncios NO nace oculta: un `hidden` impediría que un
      // lector de pantalla la observara, y entonces no anunciaría nada.
      expect(anuncio.hidden, `${tenantId}: la región de anuncios nace hidden`).toBe(false);
    }
  });
});

describe("Demostración web · atributos prohibidos en el documento", () => {
  it("ni un atributo que empiece por on, ni un style, ni un <style>, ni un <base>, ni un target", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      const ofensas: string[] = [];
      for (const nodo of todosLosElementos(document)) {
        for (const nombre of nodo.getAttributeNames()) {
          if (nombre.startsWith("on")) ofensas.push(`${tenantId}: <${nodo.tagName.toLowerCase()} ${nombre}>`);
          if (nombre === "style") ofensas.push(`${tenantId}: <${nodo.tagName.toLowerCase()} style>`);
          if (nombre === "target") ofensas.push(`${tenantId}: <${nodo.tagName.toLowerCase()} target>`);
        }
      }
      expect(ofensas).toEqual([]);
      expect(document.querySelectorAll("style"), tenantId).toEqual([]);
      expect(document.querySelectorAll("base"), tenantId).toEqual([]);
    }
  });

  it("toda <img> lleva alt y sus dimensiones intrínsecas, para no dar un salto de composición", async () => {
    const app = freshApp();
    for (const tenantId of LOCALES) {
      const document = await documentoDe(app, tenantId);
      for (const img of document.querySelectorAll("img")) {
        expect(img.getAttribute("alt"), `${tenantId}: <img> sin alt`).not.toBeNull();
        expect(img.getAttribute("width"), `${tenantId}: <img> sin width`).toMatch(/^\d+$/);
        expect(img.getAttribute("height"), `${tenantId}: <img> sin height`).toMatch(/^\d+$/);
      }
      // Los SVG en línea son decorativos y no se anuncian dos veces.
      for (const svg of document.querySelectorAll("svg")) {
        expect(svg.getAttribute("aria-hidden"), `${tenantId}: un <svg> sin aria-hidden`).toBe("true");
        expect(svg.getAttribute("focusable"), `${tenantId}: un <svg> tabulable en IE/Edge`).toBe("false");
      }
    }
  });
});

describe("Demostración web · la hoja de estilos sostiene el foco y el movimiento reducido", () => {
  /**
   * EL ANILLO DE FOCO, Y SU ÚNICA EXCEPCIÓN DELIBERADA.
   *
   * La hoja declara un `:focus-visible` universal con un aro doble (una banda
   * clara pegada al elemento y un aro oscuro por fuera) porque el anillo de un
   * solo trazo no llegaba al 3:1 sobre el botón de acento.
   *
   * Y HAY UNA REGLA QUE LO ANULA, a propósito: la de `[tabindex="-1"]`. En este
   * documento ese atributo significa una sola cosa —«el cliente te va a traer el
   * foco aquí al cambiar de paso»— y lo llevan los encabezados de paso y el
   * `<main>`. Ninguno es OPERABLE con teclado: no se pulsan, no se escriben, no
   * están en la secuencia de tabulación. El criterio 2.4.7 exige el indicador en
   * los componentes operables, así que quitárselo no es una regresión; dejarlo
   * pintaba un recuadro negro ceñido al titular cada vez que se avanzaba de
   * paso, que en pantalla se lee como un error de maquetación. La otra es el
   * propio `<dialog>`, que recibe el foco si `showModal()` no encuentra nada
   * dentro que enfocar y tampoco es un control.
   *
   * La excepción se comprueba EXPLÍCITAMENTE en vez de eludirse: cualquier OTRA
   * regla que anule el foco pone esto en rojo.
   */
  it("declara un :focus-visible con outline de 2px o más, y sólo lo anula donde debe", async () => {
    const css = (await freshApp().inject({ method: "GET", url: "/app.css" })).body;
    const reglas = reglasCss(css);
    expect(reglas.length, "la hoja no se ha podido descomponer en reglas").toBeGreaterThan(50);

    const universal = reglas.find((r) => r.selector === ":focus-visible");
    expect(universal, "la hoja no declara un :focus-visible universal").toBeDefined();
    const grosor = /outline:\s*(\d+(?:\.\d+)?)px/.exec((universal as { cuerpo: string }).cuerpo);
    expect(grosor, "el :focus-visible universal no declara un outline en px").not.toBeNull();
    expect(Number(grosor?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
    expect((universal as { cuerpo: string }).cuerpo, "el aro exterior del foco ha desaparecido").toContain(
      "box-shadow",
    );

    const anulaciones = reglas.filter((r) => /outline:\s*(?:none|0)\b/.test(r.cuerpo));
    expect(anulaciones.length, "nadie anula el foco: la excepción documentada ha desaparecido").toBeGreaterThan(
      0,
    );
    for (const regla of anulaciones) {
      const esDestinoDeFocoNoOperable =
        regla.selector.includes('[tabindex="-1"]') || /(^|[\s,])dialog(:|,|\s|$)/.test(regla.selector);
      expect(
        esDestinoDeFocoNoOperable,
        `una regla anula el anillo de foco fuera de la excepción documentada: «${regla.selector}»`,
      ).toBe(true);
    }
  });

  it("respeta «reducir movimiento» con su bloque, y no anima nada fuera de él sin pareja", async () => {
    const css = (await freshApp().inject({ method: "GET", url: "/app.css" })).body;

    expect(css, "no hay bloque de movimiento reducido").toMatch(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/,
    );
    const bloque = css.slice(css.indexOf("prefers-reduced-motion: reduce"));

    // Las dos duraciones se anulan de verdad: no basta con que la declaración
    // exista, tiene que quedar en un valor imperceptible y con `!important`,
    // porque compite con reglas más específicas.
    for (const propiedad of ["transition-duration", "animation-duration"]) {
      const declarada = new RegExp(`${propiedad}:\\s*([\\d.]+)(m?s)\\s*!important`).exec(bloque);
      expect(declarada, `${propiedad} no se anula en el bloque de movimiento reducido`).not.toBeNull();
      const enMilisegundos =
        Number(declarada?.[1] ?? 9999) * (declarada?.[2] === "s" ? 1000 : 1);
      expect(enMilisegundos, `${propiedad} sigue durando algo perceptible`).toBeLessThanOrEqual(1);
    }
    expect(bloque, "el cajón sigue deslizándose con movimiento reducido").toMatch(
      /transition:\s*none\s*!important/,
    );

    // Y el desplazamiento suave sólo se ofrece a quien NO ha pedido lo contrario.
    if (css.includes("scroll-behavior: smooth")) {
      const antes = css.slice(0, css.indexOf("scroll-behavior: smooth"));
      expect(
        antes.lastIndexOf("prefers-reduced-motion: no-preference"),
        "hay un scroll-behavior: smooth fuera de `no-preference`",
      ).toBeGreaterThan(antes.lastIndexOf("@media"));
    }
  });

  /**
   * LOS OBJETIVOS TÁCTILES, POR EL TOKEN Y NO POR EL PÍXEL.
   *
   * Sin navegador no se puede medir un rectángulo, pero sí exigir dos cosas que
   * juntas dan la garantía: que exista UN token con la medida mínima y que valga
   * 44 px o más, y que los controles más pulsados de la interfaz —los huecos, los
   * días y las cápsulas de fecha— lo NOMBREN en vez de escribir su propio número.
   * Ese era el defecto concreto: `.txb-slot-btn` medía 36×32 px, por debajo del
   * objetivo, y nadie lo veía porque su medida era suya.
   *
   * La medición real a 390×844 sigue siendo cosa de Chrome; esto es lo que
   * impide que la medida vuelva a dispersarse en veinte sitios.
   */
  it("los controles más pulsados nombran el token de objetivo táctil, y ese token llega a 44px", async () => {
    const css = (await freshApp().inject({ method: "GET", url: "/app.css" })).body;

    const tap = tokenDeRaiz(css, "--txb-tap");
    const enPx = /^(\d+(?:\.\d+)?)px$/.exec(tap);
    expect(enPx, `el objetivo táctil no está declarado en px, sino «${tap}»`).not.toBeNull();
    expect(Number(enPx?.[1] ?? 0), "el objetivo táctil no llega a 44px").toBeGreaterThanOrEqual(44);

    const reglas = reglasCss(css);
    for (const clase of [".txb-slot-btn", ".txb-day-btn", ".txb-chip"]) {
      const regla = reglas.find(
        (r) => r.selector.split(",").some((s) => s.trim() === clase) && /min-height/.test(r.cuerpo),
      );
      expect(regla, `${clase} no declara ninguna altura mínima`).toBeDefined();
      expect(
        (regla as { cuerpo: string }).cuerpo,
        `${clase} se inventa su propia medida en vez de usar var(--txb-tap)`,
      ).toMatch(/min-height:\s*var\(--txb-tap\)/);
    }
  });
});
