import { describe, expect, it } from "vitest";

import {
  assertTenantContentIsComplete,
  TenantContentError,
  type TenantContentInput,
} from "../../src/bookingWeb/content/validate.js";
import {
  ALWAYS_ON_SECTION,
  BOOKING_WEB_NOTICE,
  PUBLIC_SECTION_DOM_IDS,
  type EnabledSections,
  type TenantPublicContent,
} from "../../src/bookingWeb/model.js";
import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import { documentoDe, freshApp, paginaDe } from "./paginaViva.helpers.js";
import { localDelRegistro, registroCambiando } from "./registro.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * LA PUERTA DEL CONTENIDO PÚBLICO.
 *
 * `assertTenantContentIsComplete` corre DENTRO de `buildTenantRegistry()`, así
 * que un local mal declarado no pinta una ficha vacía en una pestaña: mata el
 * arranque entero. Y como esa función la llama todo el mundo, un desajuste pone
 * en rojo la suite completa, no una prueba dedicada que alguien pudiera borrar.
 *
 * Aquí se comprueba que la puerta CIERRA de verdad, modo de fallo por modo de
 * fallo. Cada caso parte del contenido REAL de un local y estropea UNA cosa: si
 * el caso partiera de un objeto escrito a mano, probaría la validación de un
 * contenido que nadie sirve, y el día que el modelo gane un campo obligatorio la
 * prueba seguiría verde con un objeto que ya no representa nada.
 *
 * Se afirma la CLASE del error (`TenantContentError`) y no «que lance algo»: una
 * prueba que acepta cualquier excepción acaba pasando por el motivo equivocado
 * —un `undefined.length` en la línea de arriba también lanza—.
 * ════════════════════════════════════════════════════════════════════════
 */

const LOCAL = "demo-salon-demo";

/** El contenido REAL del local, listo para estropearle una cosa. */
function entradaReal(tenantId = LOCAL): TenantContentInput {
  const tenant = localDelRegistro(tenantId);
  return {
    tenantId: tenant.tenantId,
    services: tenant.services,
    employees: tenant.employees,
    content: tenant.content,
  };
}

/** La misma entrada con el bloque de contenido parcheado. */
function con(parche: Partial<TenantPublicContent>, tenantId = LOCAL): TenantContentInput {
  const base = entradaReal(tenantId);
  return { ...base, content: { ...base.content, ...parche } };
}

/** Comprueba que la puerta rechaza, y que lo hace con SU error y nombrando al culpable. */
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

describe("Demostración web · el contenido real de cada local pasa la puerta", () => {
  it("los dos locales validan sin una sola queja", () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      expect(() => {
        assertTenantContentIsComplete(entradaReal(tenantId));
      }, tenantId).not.toThrow();
    }
  });
});

describe("Demostración web · biyección entre el núcleo y su presentación", () => {
  it("un servicio del catálogo SIN presentación no arranca", () => {
    const base = entradaReal();
    rechaza(
      con({ servicePresentation: base.content.servicePresentation.slice(1) }),
      /está en el catálogo y no tiene presentación/,
    );
  });

  it("una presentación de un servicio que NO está en el catálogo tampoco", () => {
    const base = entradaReal();
    const primera = base.content.servicePresentation[0] as TenantPublicContent["servicePresentation"][number];
    rechaza(
      con({
        servicePresentation: [
          ...base.content.servicePresentation,
          // Un serviceId que este local no vende. El tipo lo admite; el
          // catálogo, no.
          { ...primera, serviceId: 2 as never, category: "Zzz" },
        ],
      }),
      /hay dos presentaciones para el mismo serviceId|que no está en su catálogo/,
    );
  });

  it("dos presentaciones para el mismo servicio son un desempate que nadie puede decidir", () => {
    const base = entradaReal();
    const primera = base.content.servicePresentation[0] as TenantPublicContent["servicePresentation"][number];
    rechaza(
      con({ servicePresentation: [...base.content.servicePresentation, { ...primera }] }),
      /dos presentaciones para el mismo serviceId/,
    );
  });

  it("una persona del local SIN ficha no arranca", () => {
    const base = entradaReal();
    rechaza(
      con({ professionalProfiles: base.content.professionalProfiles.slice(1) }),
      /trabaja aquí y no tiene ficha/,
    );
  });

  it("una ficha de quien NO trabaja en el local tampoco", () => {
    const base = entradaReal();
    const primera = base.content.professionalProfiles[0] as TenantPublicContent["professionalProfiles"][number];
    rechaza(
      con({ professionalProfiles: [...base.content.professionalProfiles, { ...primera, employeeId: 99 }] }),
      /que no trabaja en este local/,
    );
  });

  it("dos fichas para la misma persona, igual", () => {
    const base = entradaReal();
    const primera = base.content.professionalProfiles[0] as TenantPublicContent["professionalProfiles"][number];
    rechaza(
      con({ professionalProfiles: [...base.content.professionalProfiles, { ...primera }] }),
      /dos fichas para el mismo employeeId/,
    );
  });
});

describe("Demostración web · el copy no puede reescribir el dominio", () => {
  const base = entradaReal();
  const conTitular = (headline: string): TenantContentInput =>
    con({ hero: { ...base.content.hero, headline } });

  it("un importe escrito a mano se rechaza: el precio vive en el catálogo", () => {
    rechaza(conTitular("Cortes desde 12 €"), /escribe un importe/);
    rechaza(conTitular("Desde 12 euros"), /escribe un importe/);
  });

  it("una duración escrita a mano se rechaza: la duración vive en el catálogo", () => {
    rechaza(conTitular("Tu corte en 30 min"), /escribe una duración/);
    rechaza(conTitular("2 horas de calma"), /escribe una duración/);
    rechaza(conTitular("Reserva de 1 h"), /escribe una duración/);
  });

  /**
   * DÓNDE LLEGA LA REGLA Y DÓNDE NO. El validador busca una CIFRA seguida de una
   * unidad; «dos horas de calma», escrito con letra, pasa. No es un descuido que
   * convenga tapar ensanchando la expresión —«una hora de oficio» es copy
   * legítimo y prohibir la palabra «hora» dejaría al local sin castellano—, pero
   * sí conviene que quede escrito: la garantía es «el copy no repite el DATO del
   * catálogo», y un dato se escribe con cifras.
   */
  it("una duración escrita con letra pasa, y eso es deliberado", () => {
    expect(() => {
      assertTenantContentIsComplete(conTitular("Dos horas de calma"));
    }).not.toThrow();
  });

  it("una hora de reloj se rechaza: el horario vive en el calendario", () => {
    rechaza(conTitular("Abrimos a las 09:00"), /escribe una hora/);
  });

  it("un correo, una URL o un teléfono se rechazan: esta web no sale de su documento", () => {
    rechaza(conTitular("Escríbenos a hola@ejemplo.es"), /escribe un correo o un enlace/);
    rechaza(conTitular("Más en www.ejemplo.es"), /escribe un correo o un enlace/);
    rechaza(conTitular("Llámanos al 600 123 456"), /parece un teléfono/);
  });

  it("un campo vacío se rechaza: un hueco en la portada no es una decisión de diseño", () => {
    rechaza(conTitular("   "), /está vacío/);
  });

  /**
   * LA REGLA SE APLICA A TODOS LOS CAMPOS, no sólo al titular. Se comprueba
   * sobre varios de naturalezas distintas —una etiqueta de botón, la descripción
   * de un servicio, una respuesta de las preguntas frecuentes— porque la
   * tentación al escribir un validador es dejar fuera «lo pequeño».
   */
  it("la regla vale igual para una etiqueta de CTA, una descripción y una respuesta", () => {
    rechaza(
      con({ hero: { ...base.content.hero, primaryCtaLabel: "Reserva por 12 €" } }),
      /hero\.primaryCtaLabel/,
    );
    rechaza(
      con({
        servicePresentation: base.content.servicePresentation.map((p, i) =>
          i === 0 ? { ...p, description: "Dura 30 min" } : p,
        ),
      }),
      /servicePresentation\[\d\]\.description/,
    );
    rechaza(
      con({ faq: base.content.faq.map((f, i) => (i === 0 ? { ...f, answer: "A las 09:30" } : f)) }),
      /faq\[\d\]\.answer/,
    );
    rechaza(con({ footerTagline: "12 €" }), /footerTagline/);
    rechaza(con({ nav: { ...base.content.nav, ctaLabel: "Pide hora a las 10:00" } }), /nav\.ctaLabel/);
  });

  it("una especialidad que repite una etiqueta del catálogo se rechaza", () => {
    const catalogo = localDelRegistro(LOCAL).services[0]?.label as string;
    rechaza(
      con({
        professionalProfiles: base.content.professionalProfiles.map((p, i) =>
          i === 0 ? { ...p, specialties: [catalogo] } : p,
        ),
      }),
      /repite una etiqueta del catálogo/,
    );
  });

  it("un monograma de una letra o de cuatro se rechaza", () => {
    for (const monograma of ["A", "ABCD"]) {
      rechaza(
        con({
          professionalProfiles: base.content.professionalProfiles.map((p, i) =>
            i === 0 ? { ...p, initials: monograma } : p,
          ),
        }),
        /debe tener dos o tres letras/,
      );
    }
  });
});

describe("Demostración web · la franja superior está obligada a delatar la demostración", () => {
  const base = entradaReal();

  it("vacía, se rechaza", () => {
    rechaza(con({ demoBanner: "  " }), /demoBanner.*está vacío|está vacío/);
  });

  it("repitiendo palabra por palabra el aviso contractual, se rechaza", () => {
    rechaza(con({ demoBanner: BOOKING_WEB_NOTICE }), /repite palabra por palabra el aviso contractual/);
  });

  it("sin la palabra «demostración», se rechaza", () => {
    rechaza(con({ demoBanner: "Peluquería de barrio con oficio" }), /no dice «demostración»/);
  });

  it("y el contenido real de cada local sí la dice, con o sin acento", () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const banner = entradaReal(tenantId).content.demoBanner;
      expect(
        banner
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase(),
        tenantId,
      ).toContain("demostracion");
      expect(banner, `${tenantId}: la franja repite el aviso contractual`).not.toBe(BOOKING_WEB_NOTICE);
      expect(base.content.demoBanner.length).toBeGreaterThan(0);
    }
  });
});

describe("Demostración web · la navegación y las secciones encendidas", () => {
  const base = entradaReal();

  it("enlazar una sección APAGADA se rechaza: sería un ancla rota", () => {
    rechaza(
      con({
        enabledSections: { ...base.content.enabledSections, faq: false },
      }),
      /enlaza «faq», que este local tiene apagada/,
    );
  });

  it("repetir un destino en la navegación se rechaza", () => {
    const primero = base.content.nav.links[0] as TenantPublicContent["nav"]["links"][number];
    rechaza(
      con({ nav: { ...base.content.nav, links: [...base.content.nav.links, { ...primero }] } }),
      /repite la sección/,
    );
  });

  it("una navegación sin enlaces se rechaza", () => {
    rechaza(con({ nav: { ...base.content.nav, links: [] } }), /no tiene ningún enlace/);
  });

  it("una sección encendida y VACÍA se rechaza, una por una", () => {
    rechaza(con({ experienceSteps: [] }), /experiencia está encendida y no hay ni un paso/);
    rechaza(
      con({ practicalInfo: { ...base.content.practicalInfo, items: [] } }),
      /información práctica está encendida y no hay ni un dato/,
    );
    rechaza(con({ faq: [] }), /preguntas está encendida y no hay ni una/);
  });

  it("un local sin catálogo no puede tener encendida la sección de servicios", () => {
    const entrada = entradaReal();
    rechaza({ ...entrada, services: [], content: { ...entrada.content, servicePresentation: [] } }, /servicios está encendida y el local no tiene catálogo/);
  });

  /**
   * LA SECCIÓN DE RESERVA NO SE PUEDE APAGAR, Y LA COMPROBACIÓN QUE LO DICE ES
   * INALCANZABLE POR CONSTRUCCIÓN: `EnabledSections` es
   * `Record<OptionalSectionId, boolean>` y `reserva` no es una clave posible, así
   * que `isSectionEnabled` devuelve `true` para ella sin mirar el objeto. El
   * caso se escribe igualmente, con un `as unknown as` explícito, porque esa
   * guarda es la RED para el día en que la configuración de un local llegue de
   * un JSON externo y no del compilador: entonces sí podrá venir apagada.
   */
  it("apagar la reserva es imposible por tipo, y la red del validador sigue ahí para un JSON futuro", () => {
    const conReservaApagada = {
      ...base.content.enabledSections,
      [ALWAYS_ON_SECTION]: false,
    } as unknown as EnabledSections;

    // Con el tipo respetado, apagarla no tiene efecto: la sección sigue viva.
    expect(() => {
      assertTenantContentIsComplete(con({ enabledSections: conReservaApagada }));
    }).not.toThrow();

    // Y la sección se sirve igual, que es lo que de verdad importa.
    expect(ALWAYS_ON_SECTION).toBe("reserva");
    expect(Object.keys(base.content.enabledSections)).not.toContain(ALWAYS_ON_SECTION);
  });
});

describe("Demostración web · apagar una sección la quita de la página Y de la navegación", () => {
  /**
   * El validador impide enlazar una sección apagada, así que apagar «faq» de
   * verdad implica quitarle también su enlace. Aquí se hace las dos cosas —como
   * las haría una configuración real— y se comprueba lo único que importa en
   * pantalla: la sección no está, su enlace no está, y no queda ningún ancla
   * apuntando al vacío.
   */
  it("sin «faq», ni la sección ni su enlace, y ningún ancla rota", async () => {
    const registry = registroCambiando(LOCAL, (t) => ({
      ...t,
      content: {
        ...t.content,
        enabledSections: { ...t.content.enabledSections, faq: false },
        nav: {
          ...t.content.nav,
          links: t.content.nav.links.filter((l) => l.target !== "faq"),
        },
      },
    }));
    const app = freshApp(registry);
    const document = await documentoDe(app, LOCAL);

    expect(document.getElementById(PUBLIC_SECTION_DOM_IDS.faq), "la sección apagada sigue ahí").toBeNull();
    const enlaces = document.querySelectorAll("a").map((a) => a.getAttribute("href") ?? "");
    expect(enlaces, "ha quedado un enlace a la sección apagada").not.toContain(
      `#${PUBLIC_SECTION_DOM_IDS.faq}`,
    );

    const rotas = enlaces
      .filter((href) => href.startsWith("#"))
      .filter((href) => document.getElementById(href.slice(1)) === null);
    expect(rotas, "apagar una sección ha dejado un ancla rota").toEqual([]);

    // Y el resto de la página sigue en pie: un solo script, y la reserva viva.
    expect(document.querySelectorAll("script")).toHaveLength(1);
    expect(document.getElementById(PUBLIC_SECTION_DOM_IDS.reserva)).not.toBeNull();
    // El rótulo se lee de la CONFIGURACIÓN del local, no se escribe aquí: desde
    // que cada local rotula sus secciones con su voz, un literal en la prueba
    // sería una tercera copia del texto y se quedaría atrás al primer retoque.
    const rotuloFaq = localDelRegistro(LOCAL).content.sectionHeadings.faq;
    expect(await paginaDe(app, LOCAL)).not.toContain(rotuloFaq);
  });

  it("el otro local conserva su sección: apagar es de UNO, no de todos", async () => {
    const registry = registroCambiando(LOCAL, (t) => ({
      ...t,
      content: {
        ...t.content,
        enabledSections: { ...t.content.enabledSections, faq: false },
        nav: { ...t.content.nav, links: t.content.nav.links.filter((l) => l.target !== "faq") },
      },
    }));
    const otro = await documentoDe(freshApp(registry), "demo-dos");
    expect(otro.getElementById(PUBLIC_SECTION_DOM_IDS.faq)).not.toBeNull();
  });
});
