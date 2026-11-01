import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildTenantRegistry, tenantIds } from "../../src/bookingWeb/tenants.js";
import type { FakeElement } from "./fakeDom.js";
import {
  abrirPaginaLista,
  bootstrapDe,
  byId,
  ctaDelProfesional,
  ctaDelServicio,
  esperarA,
  type BootstrapShape,
  type PaginaCargada,
} from "./paginaViva.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * EL CAJÓN DE FECHA Y HORA: APERTURA, ESCAPE Y DEVOLUCIÓN DEL FOCO.
 *
 * El paso 3 vive dentro de un `<dialog>` que se abre con `showModal()`. El
 * elemento nativo regala la trampa de foco, el cierre con `Escape`, el
 * `::backdrop` y el resto del documento inerte; lo que NO regala es que alguien
 * lo abra, ni que al cerrarse el foco vuelva a donde estaba.
 *
 * Y «donde estaba» no es un botón fijo: el cajón se puede abrir desde
 * «Continuar» del resumen o desde el CTA de una ficha de equipo. Devolver el
 * foco a un destino escrito a mano dejaría el foco perdido en la mitad de los
 * casos, así que aquí se prueba con DOS disparadores distintos. Ése es el fallo
 * concreto que este fichero caza.
 *
 * QUÉ NO SE PUEDE COMPROBAR AQUÍ, y por qué no se finge: que el fondo quede
 * inerte con el cajón abierto es cosa del `<dialog>` nativo, y el DOM de estas
 * pruebas no lo modela. Lo que sí se afirma —y es lo que sostiene la
 * garantía— es que el nodo ES un `<dialog>` y que se abre en modo modal: un
 * `<div>` con la misma pinta no daría nada de eso.
 * ════════════════════════════════════════════════════════════════════════
 */

/** Deja el asistente con servicio y persona compatibles elegidos, sin abrir el cajón. */
async function conServicioYPersona(
  tenantId: string,
): Promise<{ pagina: PaginaCargada; bootstrap: BootstrapShape; servicio: BootstrapShape["services"][number]; persona: BootstrapShape["employees"][number] }> {
  const pagina = await abrirPaginaLista(tenantId);
  const bootstrap = await bootstrapDe(pagina.app, tenantId);
  const servicio = bootstrap.services[1] as BootstrapShape["services"][number];
  const persona = bootstrap.employees.find((e) =>
    e.serviceIds.includes(servicio.serviceId),
  ) as BootstrapShape["employees"][number];
  return { pagina, bootstrap, servicio, persona };
}

/** El primer día ofrecible de la tira de la semana. Se DERIVA: nunca «el primer chip». */
function primerDiaOfrecible(pagina: PaginaCargada): FakeElement {
  const chips = byId(pagina.document, "txb-dia-chips").children;
  const ofrecible = chips.find((c) => !c.disabled);
  if (!ofrecible) {
    throw new Error("La tira de la semana no ofrece ni un día dentro del horizonte de reserva.");
  }
  return ofrecible;
}

describe("Demostración web · el cajón de fecha y hora nace cerrado y se abre en modal", () => {
  it("al cargar, el cajón está cerrado y la web pública se ve entera", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      const cajon = byId(pagina.document, "txb-drawer-fecha");

      expect(cajon.tagName, `${tenantId}: el cajón no es un <dialog> nativo`).toBe("DIALOG");
      expect(cajon.open, `${tenantId}: el cajón tapa la portada al entrar`).toBe(false);
      expect(byId(pagina.document, "txb-vista-reserva").hidden, tenantId).toBe(false);
      for (const seccion of ["hero", "servicios", "profesionales", "reserva"]) {
        expect(byId(pagina.document, `txb-seccion-${seccion}`).hidden, `${tenantId}/${seccion}`).toBe(
          false,
        );
      }
      // Y el cajón rotula con el encabezado del paso que contiene.
      const rotulo = cajon.getAttribute("aria-labelledby") ?? "";
      expect(pagina.document.getElementById(rotulo), `${tenantId}: aria-labelledby roto`).not.toBeNull();
    }
  });

  /**
   * EL CTA PRINCIPAL DE PÁGINA NO ABRE EL CAJÓN. Ancla a la sección de reserva
   * y lleva el foco al encabezado del paso que se está viendo; abrir el cajón
   * desde ahí saltaría por encima de las dos decisiones que faltan.
   */
  it("el CTA de la barra ancla a la reserva y enfoca su paso, sin abrir el cajón", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");

    byId(pagina.document, "txb-cta-nav").dispatchClick();

    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(false);
    expect(pagina.document.activeElement).toBe(byId(pagina.document, "txb-paso-servicio-titulo"));
  });

  it("«Continuar» desde el paso 2 abre el cajón en modal", async () => {
    const { pagina, servicio, persona } = await conServicioYPersona("demo-salon-demo");

    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();

    const cajon = byId(pagina.document, "txb-drawer-fecha");
    expect(cajon.open).toBe(true);
    expect(byId(pagina.document, "txb-paso-fecha-hora").hidden).toBe(false);
    expect(pagina.document.dialogoEnCima(), "no se ha abierto con showModal()").toBe(cajon);
  });
});

describe("Demostración web · Escape cierra el cajón y devuelve el foco A QUIEN LO ABRIÓ", () => {
  /**
   * DOS DISPARADORES DISTINTOS, EL MISMO CONTRATO. Con uno solo, un cliente que
   * devolviera el foco a un botón escrito a mano pasaría la prueba.
   */
  it("desde «Continuar»: Escape cierra y el foco vuelve a «Continuar»", async () => {
    const { pagina, servicio, persona } = await conServicioYPersona("demo-salon-demo");

    // Camino largo: fichas del asistente y el botón «Continuar» del resumen.
    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    const continuar = byId(pagina.document, "txb-btn-continuar");
    const fichaPersona = byId(pagina.document, "txb-profesionales-grid").children.find(
      (f) => f.textContent.includes(persona.displayName) && !f.disabled,
    );
    expect(fichaPersona, "la rejilla del paso 2 no ofrece a esa persona").toBeDefined();
    (fichaPersona as FakeElement).dispatchClick();
    continuar.dispatchClick();

    const cajon = byId(pagina.document, "txb-drawer-fecha");
    expect(cajon.open).toBe(true);

    pagina.document.dispatchKeydown("Escape");

    expect(cajon.open, "Escape no ha cerrado el cajón").toBe(false);
    expect(pagina.document.activeElement, "el foco no ha vuelto al disparador").toBe(continuar);
  });

  it("desde el CTA de una ficha de equipo: Escape cierra y el foco vuelve A ESE CTA", async () => {
    const { pagina, servicio, persona } = await conServicioYPersona("demo-salon-demo");

    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    const cta = ctaDelProfesional(pagina.document, persona.employeeId);
    cta.dispatchClick();

    const cajon = byId(pagina.document, "txb-drawer-fecha");
    expect(cajon.open).toBe(true);

    pagina.document.dispatchKeydown("Escape");

    expect(cajon.open).toBe(false);
    expect(
      pagina.document.activeElement,
      "la devolución del foco está codificada a un único botón",
    ).toBe(cta);
  });

  it("el botón ✕ del cajón lo cierra igual, y el foco vuelve al mismo sitio", async () => {
    const { pagina, servicio, persona } = await conServicioYPersona("demo-salon-demo");

    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    const cta = ctaDelProfesional(pagina.document, persona.employeeId);
    cta.dispatchClick();

    const cerrar = byId(pagina.document, "txb-drawer-cerrar");
    expect(cerrar.getAttribute("aria-label"), "el botón ✕ no tiene nombre accesible").toBeTruthy();
    cerrar.dispatchClick();

    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(false);
    expect(pagina.document.activeElement).toBe(cta);
  });

  it("cerrar y reabrir CONSERVA lo elegido: el cierre no destruye el progreso", async () => {
    const { pagina, servicio, persona } = await conServicioYPersona("demo-salon-demo");

    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    const cta = ctaDelProfesional(pagina.document, persona.employeeId);
    cta.dispatchClick();
    pagina.document.dispatchKeydown("Escape");

    // Lo elegido sigue en el resumen lateral, que es donde se lee.
    expect(byId(pagina.document, "txb-resumen-servicio-nombre").textContent).toBe(servicio.label);
    expect(byId(pagina.document, "txb-resumen-profesional-nombre").textContent).toBe(
      persona.displayName,
    );

    // Y al reabrir sigue todo puesto.
    byId(pagina.document, "txb-btn-continuar").dispatchClick();
    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(true);
    expect(byId(pagina.document, "txb-resumen-servicio-nombre").textContent).toBe(servicio.label);
    expect(byId(pagina.document, "txb-resumen-profesional-nombre").textContent).toBe(
      persona.displayName,
    );
  });

  it("con el cajón abierto, el aviso obligatorio del pie sigue en el documento", async () => {
    const { pagina, servicio, persona } = await conServicioYPersona("demo-salon-demo");
    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();

    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(true);
    const pie = byId(pagina.document, "txb-footer");
    expect(pie.hidden).toBe(false);
    expect(pie.textContent).toContain("Entorno de demostración · Datos ficticios");
  });

  /**
   * Y `Escape` sobre el diálogo de reinicio cierra ESE y no arrastra al otro:
   * dos `<dialog>` en la misma página no pueden cerrarse en cascada.
   */
  it("Escape sobre el diálogo de reinicio no cierra nada más", async () => {
    const pagina = await abrirPaginaLista("demo-salon-demo");
    byId(pagina.document, "txb-tab-dashboard").dispatchClick();
    byId(pagina.document, "txb-btn-abrir-reset").dispatchClick();

    const reinicio = byId(pagina.document, "txb-dialog-reset");
    expect(reinicio.open).toBe(true);
    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(false);

    pagina.document.dispatchKeydown("Escape");

    expect(reinicio.open).toBe(false);
    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(false);
  });
});

describe("Demostración web · la rejilla del cajón se rotula con los tramos del SERVIDOR", () => {
  /**
   * LOS RÓTULOS DE BLOQUE SALEN DE `windows`, NUNCA DE UNA HORA ESCRITA.
   *
   * Aquí no aparece «Mañana», «Tarde» ni «Horario» escrito: los rótulos
   * esperados se componen con lo que `/availability` publica en `windows`
   * (`label` y `rangeLabel`), que es la estructura real del horario del local.
   * Ése es el defecto M-SAAS-1 cerrado por el lado de la pantalla: antes el
   * cliente agrupaba con un pivote a las 12:00 y una mañana con los primeros
   * huecos reservados se rotulaba «Tarde».
   *
   * Y se prueban DOS días a propósito: uno que abre en dos tramos y otro que
   * abre de una sentada. Una prueba que sólo mirase el primero no distinguiría
   * «deriva» de «siempre pinta dos bloques».
   */
  async function rotulosPintados(
    tenantId: string,
    fecha: string,
  ): Promise<{ pintados: string[]; esperados: string[]; app: FastifyInstance }> {
    const { pagina, servicio, persona } = await conServicioYPersona(tenantId);
    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();

    // El día se elige pulsando su chip, derivado de la tira: los días fuera del
    // horizonte nacen deshabilitados, así que «el primero» no serviría.
    const chip = byId(pagina.document, "txb-dia-chips").children.find(
      (c) => !c.disabled && c.textContent.includes(String(Number(fecha.slice(8, 10)))),
    );
    expect(chip, `la tira no ofrece el día ${fecha}`).toBeDefined();
    (chip as FakeElement).dispatchClick();

    const rejilla = byId(pagina.document, "txb-rejilla");
    await esperarA(() => rejilla.querySelectorAll(".txb-slots-block").length > 0, `la rejilla de ${fecha}`);

    const pintados = rejilla
      .querySelectorAll(".txb-slots-block__title")
      .map((t) => t.textContent);

    const disponibilidad = (
      await pagina.app.inject({
        method: "GET",
        url: `/api/${tenantId}/availability?serviceId=${String(servicio.serviceId)}&date=${fecha}&employeeId=${String(persona.employeeId)}`,
      })
    ).json() as {
      windows: Array<{ label: string; rangeLabel: string; startMinutes: number; endMinutes: number }>;
      starts: Array<{ startMinutes: number }>;
    };

    const esperados = disponibilidad.windows
      .filter((w) =>
        disponibilidad.starts.some((s) => s.startMinutes >= w.startMinutes && s.startMinutes < w.endMinutes),
      )
      .map((w) => `${w.label} · ${w.rangeLabel}`);

    return { pintados, esperados, app: pagina.app };
  }

  it("un día de DOS tramos pinta dos bloques, con los rótulos que publica /availability", async () => {
    // El «hoy» sintético del local, que es martes y abre mañana y tarde.
    const hoy = (buildTenantRegistry().get("demo-salon-demo") as { demoToday: string }).demoToday;
    const { pintados, esperados } = await rotulosPintados("demo-salon-demo", hoy);

    expect(esperados.length, "el día elegido no tiene dos tramos: el fixture ha cambiado").toBe(2);
    expect(pintados).toEqual(esperados);
  });

  it("un día que abre DE UNA SENTADA pinta un único bloque, y su rótulo también viene del servidor", async () => {
    // El sábado de la misma semana: el fixture sólo lo abre por la mañana. Se
    // deriva del «hoy» sintético, no se escribe la fecha.
    const hoy = (buildTenantRegistry().get("demo-salon-demo") as { demoToday: string }).demoToday;
    const martes = new Date(`${hoy}T12:00:00Z`);
    const sabado = new Date(martes.getTime() + 4 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    const { pintados, esperados } = await rotulosPintados("demo-salon-demo", sabado);

    expect(esperados.length, "el sábado ha dejado de abrir de una sentada").toBe(1);
    expect(pintados).toEqual(esperados);
    // Y es un rótulo DISTINTO del de un día de dos tramos: si fuera el mismo,
    // el cliente no estaría derivando nada.
    const { esperados: deDosTramos } = await rotulosPintados("demo-salon-demo", hoy);
    expect(pintados[0]).not.toBe(deDosTramos[0]);
  });

  /**
   * EL INTERRUPTOR DE JORNADA COMPLETA CAMBIA QUÉ SE PIDE, NO CÓMO SE DIBUJA.
   *
   * Encendido, el cliente vuelve a preguntar por la disponibilidad SIN filtro de
   * profesional, así que la rejilla gana las columnas del resto del equipo. Lo
   * que NO cambia es la separación por tramos: el corte de mediodía es
   * información del local y fundir la jornada en un bloque «Horario» era
   * exactamente perder lo que hay que ver (corregido el 2026-08-26).
   *
   * Los rótulos no se escriben aquí: se comparan con los de antes de tocar el
   * interruptor, y las columnas con los nombres que publica `/availability`.
   */
  it("la jornada completa pide la disponibilidad SIN filtro y añade columnas, conservando los tramos", async () => {
    const { pagina, servicio, persona } = await conServicioYPersona("demo-salon-demo");
    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();
    primerDiaOfrecible(pagina).dispatchClick();

    const rejilla = byId(pagina.document, "txb-rejilla");
    await esperarA(() => rejilla.querySelectorAll(".txb-slots-block").length > 0, "la rejilla filtrada");

    const rotulosAntes = rejilla.querySelectorAll(".txb-slots-block__title").map((t) => t.textContent);
    const columnasAntes = rejilla.querySelectorAll("th").map((t) => t.textContent);
    const consultasAntes = pagina.urlsPedidas.filter((u) => u.includes("/availability")).length;

    const interruptor = byId(pagina.document, "txb-vista-dia-completa");
    expect(interruptor.getAttribute("type")).toBe("checkbox");
    interruptor.checked = true;
    interruptor.dispatchChange();

    await esperarA(
      () => pagina.urlsPedidas.filter((u) => u.includes("/availability")).length > consultasAntes,
      "la consulta de disponibilidad sin filtro de profesional",
    );
    await esperarA(
      () => rejilla.querySelectorAll("th").map((t) => t.textContent).length > columnasAntes.length,
      "las columnas del resto del equipo",
    );

    const ultima = pagina.urlsPedidas.filter((u) => u.includes("/availability")).at(-1) as string;
    expect(ultima, "la jornada completa sigue preguntando por una sola persona").not.toContain(
      "employeeId=",
    );

    // Los tramos siguen ahí, con los mismos rótulos que antes de encenderlo.
    expect(rejilla.querySelectorAll(".txb-slots-block__title").map((t) => t.textContent)).toEqual(
      rotulosAntes,
    );

    // Y las columnas son, exactamente, las personas que publica el servidor.
    const disponibilidad = (await pagina.app.inject({ method: "GET", url: ultima })).json() as {
      byEmployee: Array<{ displayName: string }>;
    };
    expect(rejilla.querySelectorAll("th").slice(0, disponibilidad.byEmployee.length + 1).map((t) => t.textContent)).toEqual([
      "Hora",
      ...disponibilidad.byEmployee.map((e) => e.displayName),
    ]);
  });

  /**
   * Los huecos no se comunican SÓLO por color: cada botón lleva un nombre
   * accesible que empieza por «Disponible» o «No disponible», y además un glifo
   * de texto. Quien no distingue el verde del gris tiene que poder saberlo.
   */
  it("cada hueco de la rejilla dice en palabras si está disponible", async () => {
    const hoy = (buildTenantRegistry().get("demo-salon-demo") as { demoToday: string }).demoToday;
    const { pagina, servicio, persona } = await conServicioYPersona("demo-salon-demo");
    ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();
    primerDiaOfrecible(pagina).dispatchClick();

    const rejilla = byId(pagina.document, "txb-rejilla");
    await esperarA(() => rejilla.querySelectorAll(".txb-slot-btn").length > 0, `los huecos de ${hoy}`);

    const botones = rejilla.querySelectorAll(".txb-slot-btn");
    expect(botones.length).toBeGreaterThan(0);
    for (const boton of botones) {
      const etiqueta = boton.getAttribute("aria-label") ?? "";
      expect(
        /^(?:Disponible|No disponible) /.test(etiqueta),
        `un hueco con aria-label «${etiqueta}»`,
      ).toBe(true);
      // El glifo textual acompaña al color, y un hueco no ofrecible además está
      // deshabilitado: tres señales, no una.
      expect(boton.textContent.trim().length).toBeGreaterThan(0);
      expect(boton.disabled).toBe(etiqueta.startsWith("No disponible"));
    }
  });
});
