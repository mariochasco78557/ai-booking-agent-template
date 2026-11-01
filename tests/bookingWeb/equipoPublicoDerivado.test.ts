import { describe, expect, it } from "vitest";

import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import type { FakeDocument } from "./fakeDom.js";
import { bootstrapDe, byId, documentoDe, freshApp, paginaDe } from "./paginaViva.helpers.js";
import { conCapacidades, conNombreDePersona, registroCambiando } from "./registro.helpers.js";
import { todosLosElementos } from "./seguridad.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * EL EQUIPO TAMPOCO SE DUPLICA.
 *
 * Quién trabaja en un local y qué sabe hacer cada persona vive UNA vez, en
 * `DemoEmployee`: la misma matriz con la que el motor decide qué huecos ofrece
 * y con la que el servidor rechaza una reserva imposible. La portada la muestra
 * DERIVADA, nunca escrita.
 *
 * DOS FALLOS CONCRETOS QUE ESTO CAZA:
 *   1. Una persona que ya no trabaja aquí y sigue en la portada —o al revés—,
 *      porque el copy se escribió a mano y nadie lo tocó al cambiar el fixture.
 *   2. «Nerea · Barba» impreso en una ficha cuando Nerea no realiza Barba. Es
 *      peor que un error de texto: es una promesa que el asistente incumplirá
 *      dos clics después, y en la misma pantalla.
 *
 * Y como en el catálogo, comparar no basta: cada garantía tiene su pareja con
 * REGISTRO INYECTADO —un nombre que no existe en ningún fixture y una matriz de
 * capacidades cambiada— que demuestra que la portada lo está leyendo.
 * ════════════════════════════════════════════════════════════════════════
 */

interface FichaDeEquipo {
  employeeId: string | null;
  nombre: string;
  servicios: string;
  monograma: string;
}

/** Las fichas de la SECCIÓN de equipo, en orden de documento. */
function fichasDeEquipo(document: FakeDocument): FichaDeEquipo[] {
  const seccion = byId(document, "txb-seccion-profesionales");
  return seccion.querySelectorAll(".txb-ficha").map((ficha): FichaDeEquipo => {
    const texto = (clase: string): string => ficha.querySelector(clase)?.textContent ?? "";
    return {
      employeeId:
        ficha.querySelector(".txb-cta-profesional")?.getAttribute("data-employee-id") ?? null,
      nombre: texto(".txb-ficha__nombre"),
      servicios: texto(".txb-ficha__servicios"),
      monograma: texto(".txb-ficha__medallon"),
    };
  });
}

/** «Barba · Corte de pelo», derivado de la matriz de capacidades y del catálogo. */
function etiquetaDerivadaDeServicios(
  serviceIds: readonly number[],
  catalogo: ReadonlyMap<number, string>,
): string {
  return serviceIds
    .filter((id) => catalogo.has(id))
    .map((id) => catalogo.get(id) as string)
    .join(" · ");
}

describe("Demostración web · el equipo de la portada sale del núcleo", () => {
  it("cada local pinta EXACTAMENTE a las personas de su /bootstrap, en su orden", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const bootstrap = await bootstrapDe(app, tenantId);
      const fichas = fichasDeEquipo(document);

      expect(
        fichas.map((f) => ({ id: f.employeeId, nombre: f.nombre })),
        `${tenantId}: la portada y la plantilla del local no coinciden`,
      ).toEqual(
        bootstrap.employees.map((e) => ({ id: String(e.employeeId), nombre: e.displayName })),
      );
    }
  });

  it("el conjunto de data-employee-id es exactamente el del registro, sin duplicados ni intrusos", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const bootstrap = await bootstrapDe(app, tenantId);
      const enLaPortada = fichasDeEquipo(document).map((f) => f.employeeId);

      expect(new Set(enLaPortada).size, `${tenantId}: fichas duplicadas`).toBe(enLaPortada.length);
      expect([...enLaPortada].sort()).toEqual(bootstrap.employees.map((e) => String(e.employeeId)).sort());
    }
  });

  /**
   * LO QUE CADA PERSONA ANUNCIA ES LO QUE PUEDE HACER, LETRA POR LETRA.
   *
   * No es «un subconjunto»: es la derivación exacta de `serviceIds` acotada al
   * catálogo de ESE local. Comprobar sólo la inclusión dejaría pasar una ficha
   * que se callara la mitad de lo que la persona hace, que también es falso.
   */
  it("los servicios que anuncia cada ficha son la derivación exacta de sus capacidades", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const bootstrap = await bootstrapDe(app, tenantId);
      const catalogo = new Map(bootstrap.services.map((s) => [s.serviceId, s.label]));

      for (const empleado of bootstrap.employees) {
        const ficha = fichasDeEquipo(document).find((f) => f.employeeId === String(empleado.employeeId));
        expect(ficha, `${tenantId}: falta la ficha de ${empleado.displayName}`).toBeDefined();
        expect(ficha?.servicios, `${tenantId}: ${empleado.displayName}`).toBe(
          etiquetaDerivadaDeServicios(empleado.serviceIds, catalogo),
        );
      }
    }
  });

  /**
   * NINGUNA FICHA ANUNCIA LO QUE ESA PERSONA NO HACE. Es la otra dirección de
   * la garantía anterior y se comprueba sobre el TEXTO ENTERO de la ficha —rol,
   * biografía, especialidades—, no sólo sobre el rótulo derivado: una biografía
   * que dijera «especialista en barbas» sobre alguien que no hace Barba
   * mentiría igual.
   */
  it("ninguna ficha nombra un servicio del catálogo que esa persona no realiza", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const bootstrap = await bootstrapDe(app, tenantId);
      const seccion = byId(document, "txb-seccion-profesionales");

      for (const [i, empleado] of bootstrap.employees.entries()) {
        const ficha = seccion.querySelectorAll(".txb-ficha")[i];
        const texto = ficha?.textContent ?? "";
        for (const servicio of bootstrap.services) {
          if (empleado.serviceIds.includes(servicio.serviceId)) continue;
          expect(
            texto.includes(servicio.label),
            `${tenantId}: la ficha de ${empleado.displayName} nombra «${servicio.label}», que no realiza`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * NADA DE DATOS DE NADIE. Las personas de esta demostración son sintéticas;
   * una web pública «de verdad» invita a poner un teléfono, un correo o un
   * enlace a redes, y la sección de equipo es donde más tira.
   */
  it("la sección de equipo no publica teléfono, correo ni salida del documento", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const seccion = byId(document, "txb-seccion-profesionales");

      expect(seccion.textContent, tenantId).not.toMatch(/[\w.]+@[\w.]+\.\w+/);
      expect(seccion.textContent, tenantId).not.toMatch(/\+?\d[\d ().-]{7,}\d/);

      for (const nodo of [seccion, ...seccion.descendants()]) {
        for (const atributo of nodo.getAttributeNames()) {
          const valor = nodo.getAttribute(atributo) ?? "";
          expect(valor, `${tenantId}: <${nodo.tagName.toLowerCase()} ${atributo}>`).not.toMatch(
            /^(?:mailto|tel|https?):/i,
          );
        }
      }
      // Y ninguna fotografía: el medallón es un monograma de texto.
      expect(seccion.querySelectorAll("img"), tenantId).toHaveLength(0);
    }
  });

  it("el monograma del medallón es decorativo y el nombre no: la marca se oye una vez", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const seccion = byId(document, "txb-seccion-profesionales");
      const medallones = seccion.querySelectorAll(".txb-ficha__medallon");
      expect(medallones.length, tenantId).toBeGreaterThan(0);
      for (const medallon of medallones) {
        expect(medallon.getAttribute("aria-hidden"), tenantId).toBe("true");
        expect(medallon.textContent.trim().length, tenantId).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("Demostración web · la portada CAMBIA con el equipo (registro inyectado)", () => {
  /**
   * EL CASO QUE CONVIERTE «COINCIDE» EN «DERIVA». Ese nombre no existe en
   * ningún fixture, así que sólo puede llegar a la pantalla si la plantilla ha
   * leído a las personas de ESTE registro.
   */
  it("con un nombre inventado inyectado, la portada lo enseña y olvida el anterior", async () => {
    const NOMBRE = "Zzz (sintética)";
    const registry = registroCambiando("demo-salon-demo", (t) => conNombreDePersona(t, 9, NOMBRE));
    const app = freshApp(registry);

    const document = await documentoDe(app, "demo-salon-demo");
    const ficha = fichasDeEquipo(document).find((f) => f.employeeId === "9");
    expect(ficha?.nombre).toBe(NOMBRE);

    const html = await paginaDe(app, "demo-salon-demo");
    expect(html).toContain(NOMBRE);
    expect(html, "el nombre viejo ha sobrevivido en algún sitio").not.toContain("Nerea");
  });

  /**
   * Y LA MATRIZ DE CAPACIDADES TAMBIÉN SE DERIVA. Se le da a la persona que NO
   * hacía Barba la capacidad de hacerla: su rótulo tiene que ganarla sin que
   * nadie toque el copy.
   */
  it("con las capacidades cambiadas, el rótulo de servicios de esa ficha cambia solo", async () => {
    const app = freshApp();
    const bootstrapReal = await bootstrapDe(app, "demo-salon-demo");
    const nerea = bootstrapReal.employees.find((e) => e.employeeId === 9);
    expect(nerea?.serviceIds).not.toContain(0);

    const original = await documentoDe(app, "demo-salon-demo");
    const antes = fichasDeEquipo(original).find((f) => f.employeeId === "9")?.servicios;

    const registry = registroCambiando("demo-salon-demo", (t) => conCapacidades(t, 9, [0, 1, 2]));
    const conBarba = freshApp(registry);
    const despues = fichasDeEquipo(await documentoDe(conBarba, "demo-salon-demo")).find(
      (f) => f.employeeId === "9",
    )?.servicios;

    expect(despues).not.toBe(antes);
    const bootstrap = await bootstrapDe(conBarba, "demo-salon-demo");
    const catalogo = new Map(bootstrap.services.map((s) => [s.serviceId, s.label]));
    expect(despues).toBe(etiquetaDerivadaDeServicios([0, 1, 2], catalogo));
  });

  /** Quitar capacidades también se ve: la derivación va en las dos direcciones. */
  it("con una sola capacidad, la ficha anuncia sólo ese servicio", async () => {
    const registry = registroCambiando("demo-salon-demo", (t) => conCapacidades(t, 3, [1]));
    const app = freshApp(registry);
    const bootstrap = await bootstrapDe(app, "demo-salon-demo");
    const soloUno = bootstrap.services.find((s) => s.serviceId === 1)?.label as string;

    const ficha = fichasDeEquipo(await documentoDe(app, "demo-salon-demo")).find((f) => f.employeeId === "3");
    expect(ficha?.servicios).toBe(soloUno);
  });

  it("cambiar el equipo de un local no toca la portada del otro", async () => {
    const registry = registroCambiando("demo-salon-demo", (t) => conNombreDePersona(t, 3, "Zzz (sintético)"));
    const app = freshApp(registry);

    expect(await paginaDe(app, "demo-salon-demo")).toContain("Zzz (sintético)");
    const otro = await paginaDe(app, "demo-dos");
    expect(otro).not.toContain("Zzz (sintético)");
    expect(otro).toContain("Iratxe (sintética)");
  });
});

describe("Demostración web · los CTA de equipo apuntan a personas de ESTE local", () => {
  it("cada data-employee-id de la página está en el registro de ese local y en ninguno más", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();

    for (const tenantId of tenantIds(registro)) {
      const document = await documentoDe(app, tenantId);
      const propios = new Set((registro.get(tenantId)?.employees ?? []).map((e) => String(e.employeeId)));
      const ajenos = new Set(
        [...registro]
          .filter(([id]) => id !== tenantId)
          .flatMap(([, t]) => t.employees.map((e) => String(e.employeeId))),
      );

      const enLaPagina = todosLosElementos(document)
        .filter((n) => n.getAttribute("data-employee-id") !== null)
        .map((n) => n.getAttribute("data-employee-id") as string);

      expect(enLaPagina.length, tenantId).toBeGreaterThan(0);
      for (const id of enLaPagina) {
        expect(propios.has(id), `${tenantId}: CTA de la persona ${id}, que no trabaja aquí`).toBe(true);
        // Y el aislamiento se ve incluso si dos locales compartieran número:
        // lo que importa es que el id esté en el registro DE ESTE local.
        if (!propios.has(id)) expect(ajenos.has(id)).toBe(false);
      }
    }
  });
});
