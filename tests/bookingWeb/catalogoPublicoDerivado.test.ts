import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import { renderBookingHtml } from "../../src/bookingWeb/ui.html.js";
import type { FakeDocument, FakeElement } from "./fakeDom.js";
import {
  abrirPaginaLista,
  bootstrapDe,
  byId,
  documentoDe,
  freshApp,
  paginaDe,
} from "./paginaViva.helpers.js";
import { conDuracion, conPrecio, localDelRegistro, registroCambiando } from "./registro.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * EL CATÁLOGO NO SE DUPLICA: LA PORTADA LO DERIVA.
 *
 * La sección de servicios enseña nombre, duración y precio de cada servicio.
 * Ese dato ya existe UNA vez —`ServiceCatalogEntry`, en el registro de
 * locales— y es el mismo con el que se calcula la disponibilidad y se cobra la
 * reserva. Si la portada lo escribiera por su cuenta habría dos verdades, y la
 * primera vez que suba un precio la web anunciará uno y el asistente cobrará
 * otro en la misma pantalla.
 *
 * POR QUÉ NO BASTA CON COMPARAR. El caso «la portada muestra lo mismo que
 * /bootstrap» es necesario y no suficiente: pasaría igual con la lista escrita
 * a fuego, hasta el día que el catálogo cambiara. Por eso cada garantía de
 * derivación tiene aquí su pareja con REGISTRO INYECTADO Y ALTERADO: un precio
 * de 9999 céntimos y una duración de 45 minutos que no existen en ningún
 * fixture. Si la portada los enseña, los está leyendo.
 * ════════════════════════════════════════════════════════════════════════
 */

/** Una ficha de servicio de la portada, leída del documento. */
interface FichaDeServicio {
  serviceId: string | null;
  nombre: string;
  duracion: string;
  precio: string;
}

/**
 * Las fichas de la SECCIÓN de servicios, en orden de documento. Se acota a la
 * sección —nunca a todo el documento— porque `.txb-tile` es también la clase de
 * las fichas que el cliente pinta dentro del asistente: contarlas todas juntas
 * mezclaría lo servido con lo pintado y la prueba dejaría de decir de qué habla.
 */
function fichasDeServicio(document: FakeDocument): FichaDeServicio[] {
  const seccion = byId(document, "txb-seccion-servicios");
  return seccion.querySelectorAll(".txb-tile").map((tile): FichaDeServicio => {
    const texto = (clase: string): string => tile.querySelector(clase)?.textContent ?? "";
    return {
      serviceId: tile.querySelector(".txb-cta-servicio")?.getAttribute("data-service-id") ?? null,
      nombre: texto(".txb-tile__name"),
      duracion: texto(".txb-tile__meta"),
      precio: texto(".txb-tile__price"),
    };
  });
}

/**
 * Los importes con forma de precio que aparecen en el HTML servido. La mirada
 * atrás `(?<![\d.,])` no es adorno: sin ella «7000,00 €» se leería como
 * «000,00 €» y la prueba compararía una cifra truncada contra el catálogo.
 */
function importesEnElDocumento(html: string): string[] {
  return [...html.matchAll(/(?<![\d.,])\d[\d.]*,\d{2}\s*€/g)].map((m) => m[0]);
}

describe("Demostración web · el catálogo de la portada sale del núcleo", () => {
  it("cada local pinta EXACTAMENTE los servicios de su /bootstrap, en su orden y con su precio", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const bootstrap = await bootstrapDe(app, tenantId);
      const fichas = fichasDeServicio(document);

      expect(fichas.length, `${tenantId}: número de fichas`).toBe(bootstrap.services.length);
      expect(
        fichas.map((f) => ({ id: f.serviceId, nombre: f.nombre, precio: f.precio })),
        `${tenantId}: la portada y el catálogo no cuentan lo mismo`,
      ).toEqual(
        bootstrap.services.map((s) => ({
          id: String(s.serviceId),
          nombre: s.label,
          precio: s.priceLabel,
        })),
      );
    }
  });

  it("no hay ni una ficha de más ni un identificador de servicio inventado", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const bootstrap = await bootstrapDe(app, tenantId);
      const idsDelNucleo = bootstrap.services.map((s) => String(s.serviceId));
      const idsDeLaPortada = fichasDeServicio(document).map((f) => f.serviceId);

      // Ni duplicados (un bucle mal cerrado), ni apuntando a un servicio que el
      // catálogo no tiene (un CTA muerto que abriría el asistente en blanco).
      expect(new Set(idsDeLaPortada).size, `${tenantId}: hay fichas duplicadas`).toBe(
        idsDeLaPortada.length,
      );
      expect([...idsDeLaPortada].sort()).toEqual([...idsDelNucleo].sort());
    }
  });

  /**
   * TODO importe con forma de precio que sale del documento es uno de los del
   * catálogo. No es lo mismo que «los precios coinciden»: esto caza el literal
   * `18,00 €` escrito en un párrafo de marketing, que ninguna comparación de
   * fichas vería y que envejecería mal en cuanto el precio subiera.
   */
  it("ningún importe del documento es distinto de los que publica el catálogo", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const html = await paginaDe(app, tenantId);
      const bootstrap = await bootstrapDe(app, tenantId);
      const delCatalogo = new Set(bootstrap.services.map((s) => s.priceLabel));

      const intrusos = importesEnElDocumento(html).filter((i) => !delCatalogo.has(i));
      expect(intrusos, `${tenantId}: importes que no salen del catálogo`).toEqual([]);
      // Y los tres del catálogo están: la sección no se ha quedado muda.
      for (const precio of delCatalogo) expect(html, tenantId).toContain(precio);
    }
  });
});

describe("Demostración web · la MISMA duración en toda la página, letra por letra", () => {
  /**
   * ════════════════════════════════════════════════════════════════════════
   * EL DEFECTO QUE ESTA PRUEBA CIERRA (2026-08-26).
   *
   * La misma página decía dos cosas distintas del mismo servicio: la ficha
   * pública, «1 h»; el asistente, «60 min». Y las dos eran «correctas»: el
   * precio viajaba YA FORMATEADO desde el servidor (`priceLabel`) y la duración
   * NO, así que el cliente se la componía él concatenando `durationMinutes` y la
   * cadena `' min'`. Dos formateadores para el mismo dato es una segunda verdad,
   * y se ve a simple vista en la misma pantalla, a dos dedos de distancia.
   *
   * La cura fue añadir `durationLabel` a `/bootstrap`. La prueba negativa es
   * ésta: la cadena de duración se saca del servidor y se exige IDÉNTICA en los
   * tres sitios donde se lee —la ficha de la portada, la ficha del paso 1 y el
   * resumen lateral—. Si alguien vuelve a componer minutos en el cliente, deja
   * de coincidir con «1 h» y esto se pone rojo.
   * ════════════════════════════════════════════════════════════════════════
   */
  it("la ficha pública, la del asistente y el resumen dicen exactamente la misma duración", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      const bootstrap = await bootstrapDe(pagina.app, tenantId);

      // El servidor la publica UNA vez, ya escrita. Nadie más la compone.
      for (const servicio of bootstrap.services) {
        expect(servicio.durationLabel, `${tenantId}/${String(servicio.serviceId)}`).toBeTruthy();
      }

      const fichasPublicas = fichasDeServicio(pagina.document);
      const rejilla = byId(pagina.document, "txb-servicios-grid");

      for (const [i, servicio] of bootstrap.services.entries()) {
        const esperada = servicio.durationLabel;

        // (1) La ficha de la portada, servida en el HTML.
        expect(
          fichasPublicas.find((f) => f.serviceId === String(servicio.serviceId))?.duracion,
          `${tenantId}: la ficha pública de «${servicio.label}»`,
        ).toBe(esperada);

        // (2) La ficha que el CLIENTE pinta en el paso 1.
        const enElAsistente = rejilla.children[i] as FakeElement;
        expect(
          enElAsistente.querySelector(".txb-tile__meta")?.textContent,
          `${tenantId}: la ficha del asistente de «${servicio.label}»`,
        ).toBe(esperada);

        // (3) El resumen lateral, tras elegir ese servicio.
        enElAsistente.dispatchClick();
        const meta = byId(pagina.document, "txb-resumen-servicio-meta").textContent;
        expect(meta, `${tenantId}: el resumen de «${servicio.label}»`).toContain(esperada);
        expect(meta, `${tenantId}: el resumen de «${servicio.label}»`).toContain(servicio.priceLabel);

        // Y la duración en crudo NO aparece por ninguna parte: si el cliente
        // volviera a componerla, «60 min» se colaría junto a «1 h».
        const compuestaAMano = `${String(servicio.durationMinutes)} min`;
        if (compuestaAMano !== esperada) {
          expect(
            pagina.document.body.textContent.includes(compuestaAMano),
            `${tenantId}: alguien vuelve a componer «${compuestaAMano}» en vez de usar «${esperada}»`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * Y LA COMPROBACIÓN QUE HACE QUE LA ANTERIOR NO SEA VACUA: en el catálogo real
   * hay al menos un servicio cuya etiqueta NO es «N min» —el de sesenta minutos
   * se rotula «1 h»—. Sin él, componer a mano y usar la etiqueta darían lo
   * mismo y la prueba de arriba pasaría con el defecto puesto.
   */
  it("hay al menos un servicio cuya etiqueta NO coincide con componer «N min» a mano", async () => {
    const app = freshApp();
    const bootstrap = await bootstrapDe(app, "demo-salon-demo");
    const discrepantes = bootstrap.services.filter(
      (s) => s.durationLabel !== `${String(s.durationMinutes)} min`,
    );
    expect(
      discrepantes.length,
      "ningún servicio distingue la etiqueta del cálculo a mano: la prueba de coherencia no probaría nada",
    ).toBeGreaterThan(0);
    expect(discrepantes[0]?.durationLabel).toBe("1 h");
  });

  it("el cliente no compone ninguna duración: no queda ni un «min» escrito en su código", async () => {
    const js = (await freshApp().inject({ method: "GET", url: "/app.js" })).body;
    // La única forma de que la pantalla contradiga al catálogo es que el cliente
    // sepa escribir una duración. Que no sepa es la garantía.
    expect(js, "el cliente vuelve a componer duraciones a mano").not.toMatch(/['"`]\s*min['"`]/);
    expect(js).not.toMatch(/durationMinutes\s*\+/);
    expect(js).toContain("durationLabel");
  });
});

describe("Demostración web · la portada CAMBIA con el catálogo (registro inyectado)", () => {
  /**
   * EL CASO QUE CONVIERTE «COINCIDE» EN «DERIVA». 9999 céntimos no existen en
   * ningún fixture, así que «99,99 €» sólo puede aparecer en la página si la
   * plantilla ha leído el catálogo de este registro concreto.
   */
  it("con un precio de 9999 céntimos inyectado, la portada dice 99,99 €", async () => {
    const registry = registroCambiando("demo-salon-demo", (t) => conPrecio(t, 1, 9999));
    const app = freshApp(registry);

    const document = await documentoDe(app, "demo-salon-demo");
    const ficha = fichasDeServicio(document).find((f) => f.serviceId === "1");
    expect(ficha, "la portada ha perdido la ficha del servicio 1").toBeDefined();
    expect(ficha?.precio).toBe("99,99 €");

    // Y el precio viejo ha desaparecido del documento entero, no sólo de la
    // ficha: si sobreviviera en otro sitio habría dos precios en la pantalla.
    const html = await paginaDe(app, "demo-salon-demo");
    expect(html).not.toContain("18,00 €");
    expect(importesEnElDocumento(html)).toContain("99,99 €");
  });

  it("con una duración de 45 minutos inyectada, la portada dice 45 min", async () => {
    const registry = registroCambiando("demo-salon-demo", (t) => conDuracion(t, 2, 45));
    const app = freshApp(registry);

    const document = await documentoDe(app, "demo-salon-demo");
    const ficha = fichasDeServicio(document).find((f) => f.serviceId === "2");
    expect(ficha?.duracion).toBe("45 min");

    // El servicio de sesenta minutos era el único que se rotulaba «1 h»: al
    // cambiarlo, ese rótulo desaparece de la sección.
    const seccion = byId(document, "txb-seccion-servicios");
    expect(seccion.textContent).not.toContain("1 h");
  });

  /**
   * El local alterado cambia y el OTRO no se entera. Sin esto, un cambio que
   * afectara a los dos locales a la vez pasaría por «derivación» siendo, en
   * realidad, una fuga.
   */
  it("alterar el catálogo de un local no toca la portada del otro", async () => {
    const registry = registroCambiando("demo-salon-demo", (t) => conPrecio(t, 1, 9999));
    const app = freshApp(registry);

    expect(await paginaDe(app, "demo-salon-demo")).toContain("99,99 €");
    const otro = await paginaDe(app, "demo-dos");
    expect(otro).not.toContain("99,99 €");
    expect(otro).toContain("15,00 €");
  });

  /**
   * Y el catálogo alterado llega COMPLETO al asistente: la portada y el
   * bootstrap no pueden discrepar, porque los dos salen del mismo registro.
   */
  it("el precio inyectado es también el que publica /bootstrap: una sola verdad", async () => {
    const registry = registroCambiando("demo-salon-demo", (t) => conPrecio(t, 1, 9999));
    const app: FastifyInstance = freshApp(registry);

    const bootstrap = await bootstrapDe(app, "demo-salon-demo");
    const servicio = bootstrap.services.find((s) => s.serviceId === 1);
    expect(servicio?.priceLabel).toBe("99,99 €");

    const document = await documentoDe(app, "demo-salon-demo");
    const ficha = fichasDeServicio(document).find((f) => f.serviceId === "1");
    expect(ficha?.precio).toBe(servicio?.priceLabel);
  });
});

describe("Demostración web · la plantilla no sabe formatear un precio", () => {
  /**
   * El formato de importe vive en UN sitio (`formatEuros`, en `model.ts`) y la
   * plantilla vuelca lo que le llega. Si `ui.html.ts` compusiera un precio,
   * tendría que dividir céntimos entre cien en algún sitio — y aquí no hay
   * ningún sitio donde hacerlo, porque `TenantPublicView` no lleva céntimos.
   *
   * Se comprueba sobre el texto renderizado con un catálogo IMPOSIBLE: si la
   * plantilla tuviera un importe escrito, aparecería junto a los derivados.
   */
  it("con TODOS los precios cambiados, en el documento no queda ni un importe del fixture", async () => {
    const registry = registroCambiando("demo-salon-demo", (t) => {
      let alterado = t;
      for (const [i, servicio] of t.services.entries()) {
        alterado = conPrecio(alterado, servicio.serviceId, 700000 + i);
      }
      return alterado;
    });
    const app = freshApp(registry);
    const html = await paginaDe(app, "demo-salon-demo");

    for (const viejo of ["12,00 €", "18,00 €", "28,00 €"]) expect(html).not.toContain(viejo);
    // Lo esperado no se escribe: se le pide al servidor. Si el formato de
    // importe cambiara, cambiarían los dos lados a la vez y con razón.
    const bootstrap = await bootstrapDe(app, "demo-salon-demo");
    expect(importesEnElDocumento(html).sort()).toEqual(
      bootstrap.services.map((s) => s.priceLabel).sort(),
    );
  });

  it("el texto de la plantilla no contiene ningún importe fuera de los derivados de la vista", () => {
    const tenant = localDelRegistro("demo-salon-demo");
    // Se renderiza con la vista REAL y se comprueba que los importes del
    // resultado son, uno a uno, los que la vista traía ya formateados.
    const html = renderBookingHtml({
      ...buildVistaMinima(tenant),
    });
    expect(importesEnElDocumento(html)).toEqual([]);
  });
});

/**
 * Una vista pública con el catálogo VACÍO. Sirve para una sola pregunta: sin un
 * solo servicio que volcar, ¿queda algún importe en el documento? Si queda,
 * está escrito en la plantilla.
 *
 * OJO AL AÑADIR UN CAMPO A `TenantPublicView`: esta vista se fabrica A MANO y
 * `tsc` NO la cubre, porque `tsconfig.json` excluye `tests/`. Un campo nuevo que
 * no se copie aquí no da error de compilación: revienta en tiempo de ejecución
 * dentro del renderizador que lo lea, con un `Cannot read properties of
 * undefined` que apunta a `ui.sections.ts` y no a esta función. Ya pasó el
 * 2026-08-26 con `sectionHeadings`, que es justo lo que se acaba de añadir.
 */
function buildVistaMinima(tenant: ReturnType<typeof localDelRegistro>) {
  return {
    tenantId: tenant.tenantId,
    brand: tenant.brand,
    seo: tenant.content.seo,
    demoBanner: tenant.content.demoBanner,
    hero: tenant.content.hero,
    heroEmblem: tenant.content.heroEmblem,
    nav: { links: [], ctaLabel: tenant.content.nav.ctaLabel },
    sectionHeadings: tenant.content.sectionHeadings,
    services: [] as const,
    professionals: [] as const,
    experience: tenant.content.experienceSteps,
    practicalInfo: tenant.content.practicalInfo,
    week: [] as const,
    faq: tenant.content.faq,
    enabledSections: tenant.content.enabledSections,
    footerTagline: tenant.content.footerTagline,
    syntheticDisclosure: tenant.content.syntheticDisclosure,
    notice: "Entorno de demostración · Datos ficticios",
  };
}

describe("Demostración web · el número de fichas sigue al catálogo, no a la plantilla", () => {
  it("cada ficha lleva un CTA con el data-service-id de SU servicio y nada más", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const seccion = byId(document, "txb-seccion-servicios");

      for (const tile of seccion.querySelectorAll(".txb-tile")) {
        const ctas = tile.querySelectorAll(".txb-cta-servicio");
        expect(ctas, `${tenantId}: una ficha con ${String(ctas.length)} CTA`).toHaveLength(1);
        const cta = ctas[0] as FakeElement;
        expect(cta.tagName).toBe("BUTTON");
        expect(cta.getAttribute("type"), "un botón sin type dentro de un <form> enviaría").toBe("button");
        expect(cta.getAttribute("data-service-id")).toMatch(/^\d+$/);
        // El nombre accesible incluye el servicio: tres botones con el mismo
        // texto son tres botones indistinguibles para quien no ve la ficha.
        expect(cta.textContent).toContain(tile.querySelector(".txb-tile__name")?.textContent ?? "");
      }
    }
  });
});
