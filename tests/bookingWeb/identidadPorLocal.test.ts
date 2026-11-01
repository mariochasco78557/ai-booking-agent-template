import { describe, expect, it } from "vitest";

import {
  assertTenantContentIsComplete,
  TenantContentError,
  type TenantContentInput,
} from "../../src/bookingWeb/content/validate.js";
import {
  HEADED_SECTION_IDS,
  isSectionEnabled,
  PUBLIC_SECTION_DOM_IDS,
  type TenantPublicContent,
} from "../../src/bookingWeb/model.js";
import { buildTenantRegistry, tenantIds, type TenantDefinition } from "../../src/bookingWeb/tenants.js";
import type { FakeDocument, FakeElement } from "./fakeDom.js";
import { byId, documentoDe, freshApp } from "./paginaViva.helpers.js";
import { conTodoElTextoReescrito, localDelRegistro, registroCambiando } from "./registro.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * DOS LOCALES, DOS IDENTIDADES — NO UNA REPINTADA.
 *
 * El 2026-08-26 la revisión de producto levantó dos hallazgos que ninguna de
 * las pruebas de entonces podía ver, porque todas comparaban al local consigo
 * mismo:
 *
 *   ALTA-2 · LOS SEIS RÓTULOS DE SECCIÓN ERAN CONSTANTES COMPARTIDAS
 *   (`SECTION_HEADINGS`, en `ui.sections.ts`). Los dos locales titulaban
 *   «Servicios», «El equipo», «Cómo funciona», «Reserva», «Información
 *   práctica» y «Preguntas frecuentes» — los rótulos más visibles de la página
 *   después del `<h1>`—, y encima cada uno los desmentía en su propio menú: el
 *   segundo local enlazaba «Qué hacemos» y aterrizabas en un `<h2>` que decía
 *   «Servicios». Un mismo sitio con dos nombres, en la misma pantalla.
 *
 *   ALTA-3 · EL EMBLEMA DEL HERO ERA UN ÚNICO DIBUJO COMPARTIDO
 *   (`HERO_EMBLEM_SVG`). Lo primero que se ve al abrir cualquiera de los dos
 *   locales era exactamente el mismo trazo, sólo que en otro color.
 *
 * QUÉ AFIRMA ESTE FICHERO, Y POR QUÉ ASÍ:
 *
 *   1. Los rótulos NO SE COMPARTEN entre locales. Se compara por PARES y
 *      derivando del registro, no contra una lista escrita a mano: el día que
 *      haya un tercer local entra solo.
 *   2. Cada `<h2>` SERVIDO dice lo mismo que el enlace del menú por el que se
 *      llega a esa sección, leído del HTML REAL de los dos locales. No del
 *      objeto de configuración: del documento, que es lo que ve una persona.
 *   3. Los emblemas del hero son DIBUJOS DISTINTOS, comparando el SVG del hero
 *      —etiqueta a etiqueta y atributo a atributo—, no la página entera: dos
 *      páginas distintas con el mismo dibujo dentro darían igual de verdes.
 *   4. Y la puerta que impide que la divergencia vuelva: el validador rechaza
 *      un menú que no coincida con su rótulo, y rechaza un rótulo vacío. Con
 *      un contenido INYECTADO — los locales reales no se tocan.
 * ════════════════════════════════════════════════════════════════════════
 */

/** Sin acentos y en minúsculas. Para comparar, nunca para mostrar. */
function normaliza(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/** El contenido REAL de un local, listo para estropearle una cosa. */
function entradaReal(tenantId: string): TenantContentInput {
  const tenant = localDelRegistro(tenantId);
  return {
    tenantId: tenant.tenantId,
    services: tenant.services,
    employees: tenant.employees,
    content: tenant.content,
  };
}

/** La misma entrada con el bloque de contenido parcheado. */
function con(tenantId: string, parche: Partial<TenantPublicContent>): TenantContentInput {
  const base = entradaReal(tenantId);
  return { ...base, content: { ...base.content, ...parche } };
}

/** La puerta rechaza, con SU error y nombrando al culpable. */
function rechaza(entrada: TenantContentInput, pista: RegExp): void {
  let capturado: unknown = null;
  try {
    assertTenantContentIsComplete(entrada);
  } catch (err) {
    capturado = err;
  }
  expect(capturado, "la puerta ha dejado pasar una configuración incoherente").toBeInstanceOf(
    TenantContentError,
  );
  expect((capturado as Error).message, "el error no dice qué está mal").toMatch(pista);
  expect((capturado as Error).message).toContain(entrada.tenantId);
}

/**
 * EL DIBUJO DEL HERO, RECONSTRUIDO DEL DOCUMENTO ANALIZADO.
 *
 * Se acota a la sección de apertura y se compone con la etiqueta y TODOS los
 * atributos de cada nodo del SVG, en orden de documento. Comparar el HTML
 * entero no serviría —las dos páginas difieren en todo—, y comparar sólo el
 * número de trazos dejaría pasar el mismo dibujo con otro grosor de línea.
 */
function emblemaDelHero(document: FakeDocument, tenantId: string): string {
  const hero = byId(document, PUBLIC_SECTION_DOM_IDS.hero);
  const svgs = hero.querySelectorAll("svg");
  expect(svgs.length, `${tenantId}: el hero no lleva exactamente un emblema`).toBe(1);
  const raiz = svgs[0] as FakeElement;
  const nodos = [raiz, ...raiz.descendants()];
  expect(nodos.length, `${tenantId}: el emblema del hero no dibuja nada`).toBeGreaterThan(1);
  return nodos
    .map((nodo) => {
      const atributos = nodo
        .getAttributeNames()
        .sort()
        .map((nombre) => `${nombre}=${nodo.getAttribute(nombre) ?? ""}`)
        .join("|");
      return `${nodo.tagName}{${atributos}}`;
    })
    .join(" ");
}

/**
 * Lo que el MENÚ SERVIDO dice de cada sección, indexado por el id de DOM al que
 * apunta el ancla. La lista se emite dos veces —escritorio y menú móvil— y aquí
 * se exige de paso que las dos copias digan lo mismo: un menú que se contradiga
 * consigo mismo sería la misma clase de defecto una capa más abajo.
 */
function etiquetasDelMenu(document: FakeDocument, tenantId: string): Map<string, string> {
  const salida = new Map<string, string>();
  const enlaces = document.querySelectorAll(".txb-nav__link");
  expect(enlaces.length, `${tenantId}: el documento no trae ningún enlace de menú`).toBeGreaterThan(0);
  for (const enlace of enlaces) {
    const href = enlace.getAttribute("href") ?? "";
    expect(href.startsWith("#"), `${tenantId}: el enlace de menú «${href}» no es un ancla`).toBe(true);
    const idSeccion = href.slice(1);
    const texto = enlace.textContent.trim();
    const yaVisto = salida.get(idSeccion);
    if (yaVisto !== undefined) {
      expect(
        texto,
        `${tenantId}: el menú de escritorio y el móvil rotulan distinto «${idSeccion}»`,
      ).toBe(yaVisto);
    }
    salida.set(idSeccion, texto);
  }
  return salida;
}

/** El `<h2>` de una sección servida. Cada sección con rótulo tiene uno y sólo uno. */
function tituloDeLaSeccion(document: FakeDocument, idDeDom: string, tenantId: string): string {
  const seccion = byId(document, idDeDom);
  const titulos = seccion.querySelectorAll("h2");
  expect(titulos.length, `${tenantId}: «${idDeDom}» no tiene exactamente un <h2>`).toBe(1);
  return (titulos[0] as FakeElement).textContent.trim();
}

describe("Demostración web · los rótulos de sección son de cada local (ALTA-2)", () => {
  it("ningún rótulo se comparte entre dos locales, y cada uno los tiene todos", () => {
    const registro = buildTenantRegistry();
    const ids = tenantIds(registro);
    expect(ids.length, "con un solo local esta comprobación no diría nada").toBeGreaterThan(1);

    for (const idA of ids) {
      const a = registro.get(idA) as TenantDefinition;
      // El `Record` es exhaustivo por tipo; aquí se comprueba que además no
      // trae claves de más, que el tipo sí dejaría pasar en un objeto ancho.
      expect([...Object.keys(a.content.sectionHeadings)].sort(), `${idA}: claves de rótulos`).toEqual(
        [...HEADED_SECTION_IDS].sort(),
      );
      for (const rotulo of Object.values(a.content.sectionHeadings)) {
        expect(rotulo.trim().length, `${idA}: un rótulo vacío`).toBeGreaterThan(0);
      }

      for (const idB of ids) {
        if (idA === idB) continue;
        const b = registro.get(idB) as TenantDefinition;
        const ajenos = new Set(Object.values(b.content.sectionHeadings).map((r) => normaliza(r)));
        const compartidos = Object.values(a.content.sectionHeadings).filter((r) =>
          ajenos.has(normaliza(r)),
        );
        expect(
          compartidos,
          `«${idA}» y «${idB}» rotulan igual alguna sección: el segundo local es el primero repintado`,
        ).toEqual([]);
      }
    }
  });

  it("cada <h2> SERVIDO dice lo mismo que el enlace de menú que lleva a esa sección", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();
    let comprobaciones = 0;

    for (const tenantId of tenantIds(registro)) {
      const document = await documentoDe(app, tenantId);
      const menu = etiquetasDelMenu(document, tenantId);

      for (const [idSeccion, etiqueta] of menu) {
        // La apertura se rotula con el `<h1>`, no con un `<h2>`: si algún día
        // un local la enlazara, no habría rótulo con el que compararla.
        if (idSeccion === PUBLIC_SECTION_DOM_IDS.hero) continue;
        comprobaciones += 1;
        expect(
          tituloDeLaSeccion(document, idSeccion, tenantId),
          `${tenantId}: el menú dice «${etiqueta}» y el titular de «${idSeccion}» dice otra cosa`,
        ).toBe(etiqueta);
      }
    }

    expect(comprobaciones, "no se ha comparado ni un rótulo: la prueba sería vacua").toBeGreaterThan(0);
  });

  it("y el <h2> de cada sección encendida es EXACTAMENTE el rótulo que declara el local", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();

    for (const tenantId of tenantIds(registro)) {
      const tenant = registro.get(tenantId) as TenantDefinition;
      const document = await documentoDe(app, tenantId);

      for (const seccion of HEADED_SECTION_IDS) {
        if (!isSectionEnabled(tenant.content.enabledSections, seccion)) continue;
        expect(
          tituloDeLaSeccion(document, PUBLIC_SECTION_DOM_IDS[seccion], tenantId),
          `${tenantId}: el <h2> de «${seccion}» no es el rótulo del local`,
        ).toBe(tenant.content.sectionHeadings[seccion]);
      }
    }
  });
});

describe("Demostración web · el emblema del hero es de cada local (ALTA-3)", () => {
  it("los dos locales abren con un DIBUJO distinto, no con el mismo en otro color", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();
    const emblemas = new Map<string, string>();

    for (const tenantId of tenantIds(registro)) {
      emblemas.set(tenantId, emblemaDelHero(await documentoDe(app, tenantId), tenantId));
    }

    for (const [idA, emblemaA] of emblemas) {
      for (const [idB, emblemaB] of emblemas) {
        if (idA === idB) continue;
        expect(
          emblemaA,
          `«${idA}» y «${idB}» abren con el mismo emblema: el hero de uno es el del otro repintado`,
        ).not.toBe(emblemaB);
      }
    }
  });

  it("cada emblema es decorativo, hereda el color del tema y no pide nada a nadie", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const hero = byId(document, PUBLIC_SECTION_DOM_IDS.hero);
      const svg = hero.querySelector("svg") as FakeElement;

      expect(svg.getAttribute("aria-hidden"), `${tenantId}: el emblema no es decorativo`).toBe("true");
      expect(svg.getAttribute("focusable"), `${tenantId}: el emblema es tabulable en IE/Edge`).toBe(
        "false",
      );
      expect(svg.getAttribute("stroke"), `${tenantId}: el emblema no hereda el color del tema`).toBe(
        "currentColor",
      );

      for (const nodo of [svg, ...svg.descendants()]) {
        const donde = `${tenantId}: <${nodo.tagName.toLowerCase()}> del emblema`;
        expect(nodo.getAttribute("style"), `${donde} lleva estilo en línea`).toBeNull();
        const fill = nodo.getAttribute("fill");
        if (fill !== null) expect(fill, `${donde} pinta un color literal`).toBe("none");
        for (const atributo of nodo.getAttributeNames()) {
          expect(nodo.getAttribute(atributo) ?? "", `${donde}, atributo «${atributo}»`).not.toMatch(
            /url\(|https?:/i,
          );
        }
      }
    }
  });

  /**
   * EL EMBLEMA NO ES PROSA, Y REESCRIBIR EL COPY NO PUEDE BORRARLO.
   *
   * `conTodoElTextoReescrito` sustituye TODA cadena del local salvo las claves
   * de unión cerrada, y es lo que alimenta las pruebas de carga hostil. Si
   * `heroEmblem` no estuviera entre esas claves, la carga acabaría en el
   * identificador del emblema, la tabla `HERO_EMBLEMS` no lo encontraría y la
   * página servida a esas pruebas se quedaría sin el SVG del hero — un trozo
   * del documento que creerían estar barriendo y no estarían.
   *
   * El `?? ""` de `heroEmblemSvg` impide que eso imprima «undefined», pero no
   * devuelve el dibujo. Esto afirma lo otro: que el dibujo sigue ahí, y que es
   * EL MISMO que el de la página real, no uno cualquiera.
   */
  it("reescribir el copy del local en bloque no le borra el emblema: no es prosa", async () => {
    const LOCAL = "demo-salon-demo";
    const real = emblemaDelHero(await documentoDe(freshApp(), LOCAL), LOCAL);

    const registry = registroCambiando(LOCAL, (t) =>
      conTodoElTextoReescrito(t, () => "</h1><script>x</script>"),
    );
    const conCargaHostil = emblemaDelHero(await documentoDe(freshApp(registry), LOCAL), LOCAL);

    expect(
      conCargaHostil,
      "reescribir el copy ha cambiado el emblema: el identificador se está tratando como texto",
    ).toBe(real);
  });
});

describe("Demostración web · la puerta que impide que la divergencia vuelva", () => {
  const LOCAL = "demo-salon-demo";

  it("un menú que llama a una sección de otra manera que su rótulo se rechaza", () => {
    const base = entradaReal(LOCAL);
    expect(
      base.content.nav.links.some((l) => l.target === "servicios"),
      "este local ya no enlaza «servicios»: el caso habría dejado de probar nada",
    ).toBe(true);

    // (a) cambiando la ETIQUETA del menú y dejando el rótulo quieto.
    rechaza(
      con(LOCAL, {
        nav: {
          ...base.content.nav,
          links: base.content.nav.links.map((l) =>
            l.target === "servicios" ? { ...l, label: "Lo que hacemos aquí" } : l,
          ),
        },
      }),
      /la navegación llama «Lo que hacemos aquí» a la sección «servicios», cuyo rótulo es/,
    );

    // (b) y al revés: cambiando el RÓTULO y dejando el menú quieto. La puerta
    //     no protege una dirección concreta, protege que los dos coincidan.
    rechaza(
      con(LOCAL, {
        sectionHeadings: { ...base.content.sectionHeadings, servicios: "Titular por su cuenta" },
      }),
      /el menú y el titular de una sección son el mismo texto, no dos/,
    );
  });

  it("un rótulo vacío se rechaza: un <h2> en blanco no es una decisión de diseño", () => {
    const base = entradaReal(LOCAL);
    for (const vacio of ["", "   "]) {
      rechaza(
        con(LOCAL, {
          sectionHeadings: { ...base.content.sectionHeadings, info: vacio },
        }),
        /«sectionHeadings\.info» está vacío/,
      );
    }
  });

  it("un rótulo que escriba un precio, una hora o un contacto se rechaza como cualquier copy", () => {
    const base = entradaReal(LOCAL);
    const conRotulo = (reserva: string): TenantContentInput =>
      con(LOCAL, { sectionHeadings: { ...base.content.sectionHeadings, reserva } });

    rechaza(conRotulo("Reserva desde 12 €"), /«sectionHeadings\.reserva» escribe un importe/);
    rechaza(conRotulo("Abrimos a las 09:00"), /«sectionHeadings\.reserva» escribe una hora/);
    rechaza(conRotulo("Escríbenos a hola@ejemplo.es"), /«sectionHeadings\.reserva» escribe un correo/);
  });

  it("y el contenido real de los dos locales pasa la puerta con los rótulos puestos", () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      expect(() => {
        assertTenantContentIsComplete(entradaReal(tenantId));
      }, tenantId).not.toThrow();
    }
  });
});
