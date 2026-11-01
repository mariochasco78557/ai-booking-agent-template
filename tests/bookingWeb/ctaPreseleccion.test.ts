import { describe, expect, it } from "vitest";

import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import type { FakeElement } from "./fakeDom.js";
import {
  abrirPaginaLista,
  bootstrapDe,
  byId,
  ctaDelProfesional,
  ctaDelServicio,
  ctasDeProfesional,
  ctasDeServicio,
  esperarA,
  type BootstrapShape,
  type PaginaCargada,
} from "./paginaViva.helpers.js";
import { motivoDeUrlInaceptable } from "./seguridad.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * LOS CTA DE LA PORTADA, EN LA PÁGINA VIVA.
 *
 * Cada ficha de servicio y cada ficha de equipo lleva su propio botón de
 * reserva. Lo que tiene que pasar al pulsarlo no es «que se abra el asistente»:
 * es que se abra CON LO QUE SE HA PULSADO ya elegido. Un CTA que abre el
 * asistente en blanco obliga a repetir la elección, y un CTA que preselecciona
 * siempre «el primero de la lista» es peor todavía, porque parece que funciona.
 *
 * LA REGLA DURA QUE ESTE FICHERO VIGILA. Nunca pueden coexistir en el estado un
 * servicio y una persona incompatibles, y JAMÁS se le pregunta a
 * `/availability` por ese par. No basta con que el servidor lo rechace: una
 * combinación que el catálogo no admite no debe llegar ni a la barra de
 * direcciones ni a los registros, y quien reserva no tiene por qué ver un 409.
 *
 * Todo se observa en el DOM —resumen lateral, paso visible, cajón, región de
 * anuncios— y con clics reales sobre el documento SERVIDO. Aquí no se llama a
 * ninguna función interna del cliente: si el botón no está cableado, no pasa
 * nada, y eso es exactamente lo que se quiere detectar.
 * ════════════════════════════════════════════════════════════════════════
 */

/** Lo que se ve en el resumen lateral: la elección, tal y como la lee una persona. */
function resumen(pagina: PaginaCargada): {
  servicio: string | null;
  meta: string | null;
  profesional: string | null;
} {
  const { document } = pagina;
  const bloqueServicio = byId(document, "txb-resumen-servicio");
  const bloqueProfesional = byId(document, "txb-resumen-profesional");
  return {
    servicio: bloqueServicio.hidden ? null : byId(document, "txb-resumen-servicio-nombre").textContent,
    meta: bloqueServicio.hidden ? null : byId(document, "txb-resumen-servicio-meta").textContent,
    profesional: bloqueProfesional.hidden
      ? null
      : byId(document, "txb-resumen-profesional-nombre").textContent,
  };
}

/** El paso del asistente que se está viendo, deducido de qué sección es visible. */
function pasoVisible(pagina: PaginaCargada): number {
  const pasos = [
    "txb-paso-servicio",
    "txb-paso-profesional",
    "txb-paso-fecha-hora",
    "txb-paso-confirmacion",
  ];
  const visible = pasos.findIndex((id) => !byId(pagina.document, id).hidden);
  return visible + 1;
}

/** Una persona de este local que NO realiza ese servicio, sacada del bootstrap. */
function incapazPara(bootstrap: BootstrapShape, serviceId: number): BootstrapShape["employees"][number] {
  const persona = bootstrap.employees.find((e) => !e.serviceIds.includes(serviceId));
  if (!persona) throw new Error(`Todas las personas realizan el servicio ${String(serviceId)}.`);
  return persona;
}

/** Una persona de este local que SÍ realiza ese servicio. */
function capazPara(bootstrap: BootstrapShape, serviceId: number): BootstrapShape["employees"][number] {
  const persona = bootstrap.employees.find((e) => e.serviceIds.includes(serviceId));
  if (!persona) throw new Error(`Nadie realiza el servicio ${String(serviceId)}.`);
  return persona;
}

/** Un servicio que esa persona NO realiza. */
function servicioProhibidoPara(
  bootstrap: BootstrapShape,
  employeeId: number,
): BootstrapShape["services"][number] {
  const persona = bootstrap.employees.find((e) => e.employeeId === employeeId);
  const servicio = bootstrap.services.find((s) => !(persona?.serviceIds ?? []).includes(s.serviceId));
  if (!servicio) throw new Error(`La persona ${String(employeeId)} realiza todos los servicios.`);
  return servicio;
}

/**
 * Comprueba que NINGUNA consulta de disponibilidad ha llevado un par imposible.
 * Se llama al final de cada caso de incompatibilidad: es lo que distingue
 * «impide el par» de «lo intenta y luego se disculpa».
 */
function ningunaConsultaImposible(pagina: PaginaCargada, bootstrap: BootstrapShape): void {
  for (const url of pagina.urlsPedidas) {
    if (!url.includes("/availability")) continue;
    const serviceId = Number(/serviceId=(\d+)/.exec(url)?.[1] ?? "-1");
    const employeeId = /employeeId=(\d+)/.exec(url)?.[1];
    if (employeeId === undefined) continue;
    const persona = bootstrap.employees.find((e) => e.employeeId === Number(employeeId));
    expect(
      persona?.serviceIds.includes(serviceId),
      `el cliente ha preguntado por un par imposible: ${url}`,
    ).toBe(true);
  }
}

describe("Demostración web · el CTA de una ficha de SERVICIO preselecciona ESE servicio", () => {
  it("preselecciona el servicio de la ficha pulsada, no el primero de la lista", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const bootstrap = await bootstrapDe(pagina.app, "demo-salon-demo");

    // A propósito el ÚLTIMO del catálogo: si el cliente preseleccionara «el
    // primero», este caso lo cazaría y el de la primera ficha no.
    const elegido = bootstrap.services[bootstrap.services.length - 1] as BootstrapShape["services"][number];
    expect(elegido.serviceId).not.toBe(bootstrap.services[0]?.serviceId);

    ctaDelServicio(pagina.document, elegido.serviceId).dispatchClick();

    expect(resumen(pagina).servicio).toBe(elegido.label);
    expect(resumen(pagina).meta).toContain(elegido.priceLabel);
    // Lo que falta por decidir es la persona: el asistente va al paso 2.
    expect(pasoVisible(pagina)).toBe(2);
    // Y no abre el cajón: elegir servicio no es elegir hora.
    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(false);
  });

  it("desde el segundo local, el CTA preselecciona el servicio CON EL PRECIO DE ESE LOCAL", async () => {
    const uno = await abrirPaginaLista("demo-salon-demo");
    const dos = await abrirPaginaLista("demo-dos");
    const bootUno = await bootstrapDe(uno.app, "demo-salon-demo");
    const bootDos = await bootstrapDe(dos.app, "demo-dos");

    const id = bootDos.services[1]?.serviceId as number;
    const precioAqui = bootDos.services.find((s) => s.serviceId === id)?.priceLabel as string;
    const precioAlla = bootUno.services.find((s) => s.serviceId === id)?.priceLabel as string;
    expect(precioAqui).not.toBe(precioAlla);

    ctaDelServicio(dos.document, id).dispatchClick();

    expect(resumen(dos).meta).toContain(precioAqui);
    expect(resumen(dos).meta).not.toContain(precioAlla);
  });

  it("cada CTA de servicio de la portada preselecciona el suyo, uno por uno", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const bootstrap = await bootstrapDe(pagina.app, "demo-salon-demo");

    for (const servicio of bootstrap.services) {
      ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
      expect(resumen(pagina).servicio, `CTA del servicio ${String(servicio.serviceId)}`).toBe(
        servicio.label,
      );
    }
  });
});

describe("Demostración web · el CTA de una ficha de EQUIPO preselecciona a ESA persona", () => {
  it("sin servicio elegido, preselecciona a la persona y pide el servicio: nunca salta a la rejilla", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const bootstrap = await bootstrapDe(pagina.app, "demo-salon-demo");
    const persona = bootstrap.employees[bootstrap.employees.length - 1] as BootstrapShape["employees"][number];

    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();

    expect(resumen(pagina).profesional).toBe(persona.displayName);
    expect(resumen(pagina).servicio, "no había servicio y no puede haberlo inventado").toBeNull();
    expect(pasoVisible(pagina)).toBe(1);
    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(false);

    // Y no se ha preguntado por ninguna disponibilidad: sin servicio, esa
    // consulta sería un 400 garantizado.
    expect(pagina.urlsPedidas.filter((u) => u.includes("/availability"))).toEqual([]);
  });

  it("con un servicio compatible ya elegido, abre el cajón de fecha con LOS DOS conservados", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const bootstrap = await bootstrapDe(pagina.app, "demo-salon-demo");
    const servicio = bootstrap.services[1] as BootstrapShape["services"][number];
    const persona = capazPara(bootstrap, servicio.serviceId);

    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();

    expect(resumen(pagina).servicio).toBe(servicio.label);
    expect(resumen(pagina).profesional).toBe(persona.displayName);
    expect(pasoVisible(pagina)).toBe(3);
    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(true);
    ningunaConsultaImposible(pagina, bootstrap);
  });

  it("en el ORDEN INVERSO —persona y después servicio compatible— se conservan igual", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    const bootstrap = await bootstrapDe(pagina.app, "demo-salon-demo");
    const servicio = bootstrap.services[1] as BootstrapShape["services"][number];
    const persona = capazPara(bootstrap, servicio.serviceId);

    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();
    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();

    expect(resumen(pagina).servicio).toBe(servicio.label);
    expect(resumen(pagina).profesional, "el segundo CTA ha borrado lo del primero").toBe(
      persona.displayName,
    );
    expect(pasoVisible(pagina)).toBe(2);
    ningunaConsultaImposible(pagina, bootstrap);
  });
});

describe("Demostración web · el par imposible no se compone JAMÁS", () => {
  /**
   * PRIMERA DIRECCIÓN: con un servicio elegido, quien no puede realizarlo tiene
   * el CTA deshabilitado. El DOM falso se traga el clic de un botón
   * deshabilitado igual que el navegador, así que este caso prueba de verdad la
   * deshabilitación y no sólo el atributo.
   */
  it("con un servicio elegido, el CTA de quien no lo realiza queda deshabilitado y no hace nada", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      const bootstrap = await bootstrapDe(pagina.app, tenantId);

      // El servicio que alguien NO realiza, derivado del bootstrap: no está
      // escrito «Barba» ni «Nerea» en ninguna parte de esta prueba.
      const servicio = bootstrap.services.find((s) =>
        bootstrap.employees.some((e) => !e.serviceIds.includes(s.serviceId)),
      );
      expect(servicio, `${tenantId}: todas las personas hacen de todo`).toBeDefined();
      const incapaz = incapazPara(bootstrap, (servicio as BootstrapShape["services"][number]).serviceId);
      const capaz = capazPara(bootstrap, (servicio as BootstrapShape["services"][number]).serviceId);

      ctaDelServicio(pagina.document, (servicio as BootstrapShape["services"][number]).serviceId).dispatchClick();

      const botonIncapaz = ctaDelProfesional(pagina.document, incapaz.employeeId);
      const botonCapaz = ctaDelProfesional(pagina.document, capaz.employeeId);
      expect(botonIncapaz.disabled, `${tenantId}: ${incapaz.displayName} debería estar deshabilitada`).toBe(
        true,
      );
      expect(botonCapaz.disabled, `${tenantId}: ${capaz.displayName} no debería estarlo`).toBe(false);

      const antes = resumen(pagina);
      botonIncapaz.dispatchClick();
      expect(resumen(pagina), `${tenantId}: el clic deshabilitado ha cambiado el estado`).toEqual(antes);
      ningunaConsultaImposible(pagina, bootstrap);
    }
  });

  /**
   * SEGUNDA DIRECCIÓN, la del camino inverso: con la persona ya elegida, se
   * pulsa el CTA de un servicio que no realiza. Gana lo recién pulsado, se
   * descarta la otra mitad, se dice en voz alta y el asistente queda en un paso
   * desde el que se puede seguir. Lo que no puede pasar nunca es que los dos
   * convivan en el estado.
   */
  it("con la persona elegida, pulsar un servicio que no realiza descarta a la persona y lo ANUNCIA", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      const bootstrap = await bootstrapDe(pagina.app, tenantId);

      const persona = bootstrap.employees.find(
        (e) => e.serviceIds.length < bootstrap.services.length,
      ) as BootstrapShape["employees"][number];
      const prohibido = servicioProhibidoPara(bootstrap, persona.employeeId);

      ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();
      expect(resumen(pagina).profesional, tenantId).toBe(persona.displayName);

      ctaDelServicio(pagina.document, prohibido.serviceId).dispatchClick();

      // El servicio recién pulsado gana; la persona se ha descartado.
      expect(resumen(pagina).servicio, tenantId).toBe(prohibido.label);
      expect(
        resumen(pagina).profesional,
        `${tenantId}: ${persona.displayName} sigue elegida con un servicio que no realiza`,
      ).toBeNull();

      // Y se ha dicho por qué, en la región que un lector de pantalla anuncia.
      const anuncio = byId(pagina.document, "txb-anuncio");
      expect(anuncio.getAttribute("role"), tenantId).toBe("status");
      expect(anuncio.getAttribute("aria-live"), tenantId).toBe("polite");
      expect(anuncio.textContent, tenantId).toContain(persona.displayName);
      expect(anuncio.textContent, tenantId).toContain(prohibido.label);

      // El asistente queda en un paso desde el que se puede continuar.
      expect([1, 2], tenantId).toContain(pasoVisible(pagina));
      ningunaConsultaImposible(pagina, bootstrap);
    }
  });

  /**
   * Y LA GARANTÍA DE FONDO, medida sobre TODAS las llamadas de un recorrido
   * completo: ni una sola consulta de disponibilidad con un par que el catálogo
   * no admite. Es lo que separa «lo impide» de «lo intenta y encaja el 409».
   */
  it("tras zarandear los CTA en todos los órdenes, ninguna consulta lleva un par imposible", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      const bootstrap = await bootstrapDe(pagina.app, tenantId);

      for (const servicio of bootstrap.services) {
        ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
        for (const persona of bootstrap.employees) {
          // Se pulsan TODOS, capaces e incapaces: los deshabilitados se tragan
          // el clic solos, que es justo lo que se quiere comprobar.
          ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();
        }
      }
      await esperarA(() => true, "el turno del bucle de eventos");

      const consultas = pagina.urlsPedidas.filter((u) => u.includes("/availability"));
      ningunaConsultaImposible(pagina, bootstrap);
      // Y ninguna consulta ha salido de las rutas de ESTE local.
      for (const url of pagina.urlsPedidas) {
        expect(url.startsWith(`/api/${tenantId}/`), `${tenantId}: ${url}`).toBe(true);
      }
      expect(consultas.every((u) => u.startsWith(`/api/${tenantId}/availability`))).toBe(true);
    }
  });
});

describe("Demostración web · los CTA son controles nativos y no sacan a nadie del origen", () => {
  it("todo CTA de ficha es un <button type=button> con su atributo de datos", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      const todos: FakeElement[] = [
        ...ctasDeServicio(pagina.document),
        ...ctasDeProfesional(pagina.document),
      ];
      expect(todos.length, tenantId).toBeGreaterThan(0);
      for (const cta of todos) {
        expect(cta.tagName, tenantId).toBe("BUTTON");
        expect(cta.getAttribute("type"), tenantId).toBe("button");
        expect(cta.getAttribute("href"), "un CTA de reserva no navega").toBeNull();
      }
    }
  });

  it("los CTA de página son anclas INTERNAS: funcionan aunque el cliente no llegue a cargar", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      for (const id of ["txb-cta-nav", "txb-cta-hero-primario", "txb-cta-hero-secundario", "txb-cta-movil"]) {
        const nodo = byId(pagina.document, id);
        expect(nodo.tagName, `${tenantId}/${id}`).toBe("A");
        const href = nodo.getAttribute("href") ?? "";
        expect(motivoDeUrlInaceptable(href), `${tenantId}/${id}: href «${href}»`).toBeNull();
        expect(href.startsWith("#"), `${tenantId}/${id}: no es un ancla interna`).toBe(true);
        expect(
          pagina.document.getElementById(href.slice(1)),
          `${tenantId}/${id}: el ancla no lleva a ninguna parte`,
        ).not.toBeNull();
      }
    }
  });
});
