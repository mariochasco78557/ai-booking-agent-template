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
  freshApp,
  type BootstrapShape,
  type PaginaCargada,
} from "./paginaViva.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * EL PASO 3 NO PUEDE ABRIRSE VACÍO.
 *
 * El defecto que este fichero cierra (revisión de producto, 2026-08-26): al
 * llegar al paso de fecha y hora no había ningún día seleccionado. Lo que se
 * veía era la leyenda «✓ Disponible – No disponible» flotando sola sobre un
 * cuarto de pantalla en blanco, y las horas no aparecían hasta que alguien
 * adivinaba que había que pulsar un día de la tira. Quien llega ahí ya ha dicho
 * QUÉ quiere y CON QUIÉN: lo único que le falta es ver horas.
 *
 * LO QUE AQUÍ SE PRUEBA —Y LO QUE NO—. Se prueba que el cliente deja un día
 * marcado y la rejilla llena sin que nadie pulse nada, que avanza de día cuando
 * el primero no ofrece huecos, que la búsqueda está ACOTADA y que la persona
 * gana siempre. NO se prueba —ni se puede— que el cliente sepa qué días abre el
 * local: no lo sabe, y ése es el punto. Todo lo que se pinta sale de
 * `/availability`, del motor de calendario del servidor; el cliente sólo
 * pregunta y mira si la lista viene vacía.
 *
 * NINGUNA FECHA ESCRITA A MANO. El «hoy» sale del bootstrap del local y los
 * demás días se derivan de él sumando, igual que hace el propio cliente. Un
 * `"2026-08-25"` escrito aquí convertiría la prueba en un calco del fixture.
 * ════════════════════════════════════════════════════════════════════════
 */

/** Un día ISO desplazado N días. La aritmética de fechas SÍ vive en las pruebas. */
function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** El día del mes, sin ceros a la izquierda: lo que se lee dentro de un chip. */
function diaDelMes(iso: string): string {
  return String(Number(iso.slice(8, 10)));
}

/** Servicio y persona compatibles, DERIVADOS del bootstrap del local. */
async function parCompatible(
  app: FastifyInstance,
  tenantId: string,
): Promise<{
  bootstrap: BootstrapShape;
  servicio: BootstrapShape["services"][number];
  persona: BootstrapShape["employees"][number];
}> {
  const bootstrap = await bootstrapDe(app, tenantId);
  const servicio = bootstrap.services[1] as BootstrapShape["services"][number];
  const persona = bootstrap.employees.find((e) =>
    e.serviceIds.includes(servicio.serviceId),
  ) as BootstrapShape["employees"][number];
  expect(persona, `${tenantId}: nadie realiza el servicio elegido`).toBeDefined();
  return { bootstrap, servicio, persona };
}

/**
 * Deja el asistente EN EL PASO 3 pulsando los dos CTA de la portada, que es el
 * camino más corto para llegar ahí sin tocar ni un día. Nadie pulsa un chip:
 * todo lo que pase con la fecha a partir de aquí lo ha decidido el cliente.
 */
async function llegarAlPasoDeFecha(
  tenantId: string,
  app?: FastifyInstance,
): Promise<{
  pagina: PaginaCargada;
  bootstrap: BootstrapShape;
  servicio: BootstrapShape["services"][number];
  persona: BootstrapShape["employees"][number];
}> {
  const pagina = await abrirPaginaLista(tenantId, app ? { app } : {});
  const { bootstrap, servicio, persona } = await parCompatible(pagina.app, tenantId);

  ctaDelServicio(pagina.document, servicio.serviceId).dispatchClick();
  ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();
  expect(byId(pagina.document, "txb-drawer-fecha").open, `${tenantId}: el cajón no se ha abierto`).toBe(
    true,
  );

  return { pagina, bootstrap, servicio, persona };
}

/** Las consultas de disponibilidad que el CLIENTE ha hecho, en orden. */
function consultas(pagina: PaginaCargada): string[] {
  return pagina.urlsPedidas.filter((u) => u.includes("/availability"));
}

/** La fecha de la última consulta de disponibilidad del cliente. */
function fechaDeLaUltimaConsulta(pagina: PaginaCargada): string | null {
  const ultima = consultas(pagina).at(-1);
  return ultima === undefined ? null : (/date=(\d{4}-\d{2}-\d{2})/.exec(ultima)?.[1] ?? null);
}

/**
 * El día del mes que dice un chip. Cada chip lleva dos `<span>`: el día de la
 * semana y el número. Se lee el segundo, en vez de comparar el texto entero,
 * para que «Mié 26» no se pueda confundir nunca con «Mar 2».
 */
function diaDelChip(chip: FakeElement): string {
  return chip.children[chip.children.length - 1]?.textContent ?? "";
}

/** El chip de la tira de la semana que está marcado como elegido, si lo hay. */
function chipMarcado(pagina: PaginaCargada): FakeElement | undefined {
  return byId(pagina.document, "txb-dia-chips").children.find(
    (c) => c.getAttribute("aria-pressed") === "true",
  );
}

/** El chip de un día concreto — nunca «el primero de la tira». */
function chipDelDia(pagina: PaginaCargada, iso: string): FakeElement {
  const chip = byId(pagina.document, "txb-dia-chips").children.find(
    (c) => !c.disabled && diaDelChip(c) === diaDelMes(iso),
  );
  if (!chip) throw new Error(`La tira de la semana no ofrece el día ${iso}.`);
  return chip;
}

/** Los botones de hora pintados en la rejilla. */
function huecos(pagina: PaginaCargada): FakeElement[] {
  return byId(pagina.document, "txb-rejilla").querySelectorAll(".txb-slot-btn");
}

/** La leyenda «✓ Disponible – No disponible», que sólo acompaña a una rejilla. */
function leyenda(pagina: PaginaCargada): FakeElement {
  const nodo = pagina.document.querySelector(".txb-legend");
  if (!nodo) throw new Error("El HTML servido ya no trae la leyenda de disponibilidad.");
  return nodo;
}

/** Reserva TODOS los huecos que ese día ofrece a esa persona, con la API real. */
async function ocuparElDiaEntero(
  app: FastifyInstance,
  tenantId: string,
  servicio: number,
  persona: number,
  fecha: string,
): Promise<number> {
  const res = await app.inject({
    method: "GET",
    url: `/api/${tenantId}/availability?serviceId=${String(servicio)}&date=${fecha}&employeeId=${String(persona)}`,
  });
  expect(res.statusCode, `availability de ${fecha}`).toBe(200);
  const { starts } = res.json() as { starts: Array<{ startMinutes: number }> };

  for (const inicio of starts) {
    const reserva = await app.inject({
      method: "POST",
      url: `/api/${tenantId}/book`,
      payload: {
        serviceId: servicio,
        employeeId: persona,
        date: fecha,
        startMinutes: inicio.startMinutes,
        payment_option: "pay_at_salon",
        idempotencyKey: `ocupar-${fecha}-${String(inicio.startMinutes)}`,
      } as never,
    });
    expect(reserva.statusCode, reserva.body).toBe(201);
  }
  return starts.length;
}

describe("Demostración web · el paso 3 se abre con un día ya elegido y la rejilla llena", () => {
  it("sin pulsar ningún día, queda un día marcado y hay botones de hora en la rejilla", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const { pagina, bootstrap } = await llegarAlPasoDeFecha(tenantId);

      await esperarA(
        () => huecos(pagina).length > 0,
        `${tenantId}: la rejilla llena sin que nadie pulse un día`,
      );

      // Un día marcado en la tira de la semana…
      const marcado = chipMarcado(pagina);
      expect(marcado, `${tenantId}: el paso 3 sigue abriéndose sin ningún día elegido`).toBeDefined();

      // …y es el PRIMER día del horizonte, que en estos locales abre y tiene
      // huecos. No se escribe la fecha: se deriva del bootstrap.
      expect(diaDelChip(marcado as FakeElement), tenantId).toBe(diaDelMes(bootstrap.demoToday));
      expect(fechaDeLaUltimaConsulta(pagina), tenantId).toBe(bootstrap.demoToday);

      // Y también queda marcado en la rejilla del mes, que habla del mismo día.
      const enElMes = byId(pagina.document, "txb-mes-grid-body")
        .querySelectorAll(".txb-day-btn")
        .filter((b) => b.getAttribute("aria-pressed") === "true");
      expect(enElMes.map((b) => b.textContent), tenantId).toEqual([diaDelMes(bootstrap.demoToday)]);

      // El título de horarios ya no está en blanco, y la leyenda acompaña a una
      // tabla de verdad en vez de flotar sobre nada.
      expect(byId(pagina.document, "txb-horarios-titulo").textContent.length, tenantId).toBeGreaterThan(
        0,
      );
      expect(leyenda(pagina).hidden, `${tenantId}: la leyenda no se ve con la rejilla puesta`).toBe(
        false,
      );

      // Y todo hueco habilitado lo ha marcado disponible el SERVIDOR: el cliente
      // no ha inventado ni una hora.
      const disponibilidad = (
        await pagina.app.inject({ method: "GET", url: consultas(pagina).at(-1) as string })
      ).json() as { starts: Array<{ label: string }> };
      const habilitados = huecos(pagina).filter((b) => !b.disabled);
      expect(habilitados.length, tenantId).toBe(disponibilidad.starts.length);
    }
  });

  /**
   * LA LEYENDA NO SE QUEDA SOLA. Un día sin huecos —el fixture cierra el
   * domingo— enseña el mensaje de vacío, y la leyenda de los glifos se retira
   * con la tabla que explicaba.
   */
  it("un día sin huecos enseña el mensaje de vacío y retira la leyenda", async () => {
    const { pagina, bootstrap } = await llegarAlPasoDeFecha("demo-salon-demo");
    await esperarA(() => huecos(pagina).length > 0, "la rejilla del día preseleccionado");
    expect(leyenda(pagina).hidden).toBe(false);

    // El domingo de esa misma semana: dentro del horizonte, pero el local no abre.
    const domingo = sumarDias(bootstrap.demoToday, 5);
    chipDelDia(pagina, domingo).dispatchClick();

    await esperarA(
      () => byId(pagina.document, "txb-rejilla").textContent.includes("No hay ningún hueco"),
      "el mensaje de día sin huecos",
    );
    expect(huecos(pagina)).toHaveLength(0);
    expect(leyenda(pagina).hidden, "la leyenda se ha quedado flotando sobre el vacío").toBe(true);
  });
});

describe("Demostración web · la búsqueda automática avanza de día y está ACOTADA", () => {
  /**
   * El primer día del horizonte con la agenda de esa persona llena: no ofrece ni
   * un inicio, así que la preselección tiene que pasar al siguiente en vez de
   * dejar la pantalla en blanco. Las reservas se hacen con la API REAL —nadie
   * recorta una respuesta a mano—, así que el «no hay nada» es del motor.
   */
  it("si el primer día no ofrece nada, salta al siguiente que sí, con dos consultas", async () => {
    const app = freshApp();
    const { bootstrap, servicio, persona } = await parCompatible(app, "demo-salon-demo");

    const ocupados = await ocuparElDiaEntero(
      app,
      "demo-salon-demo",
      servicio.serviceId,
      persona.employeeId,
      bootstrap.demoToday,
    );
    expect(ocupados, "el primer día del horizonte no ofrecía nada ni antes de reservar").toBeGreaterThan(
      0,
    );

    const { pagina } = await llegarAlPasoDeFecha("demo-salon-demo", app);
    await esperarA(() => huecos(pagina).length > 0, "la rejilla del día encontrado");

    const siguiente = sumarDias(bootstrap.demoToday, 1);
    expect(fechaDeLaUltimaConsulta(pagina)).toBe(siguiente);
    expect(diaDelChip(chipMarcado(pagina) as FakeElement)).toBe(diaDelMes(siguiente));

    // Exactamente dos consultas: el día lleno y el siguiente. Ni una cascada, ni
    // una repetición del día que ya se había pedido para pintarlo.
    expect(consultas(pagina).map((u) => /date=(\d{4}-\d{2}-\d{2})/.exec(u)?.[1])).toEqual([
      bootstrap.demoToday,
      siguiente,
    ]);
  });

  /**
   * EL TOPE, MEDIDO. Con la semana entera ocupada —y con el domingo y el lunes,
   * que el local cierra, dentro de ella— la búsqueda no puede recorrer el
   * horizonte de treinta días llamando treinta veces al servidor: se detiene en
   * siete, deja seleccionado el último día consultado y enseña el mensaje de
   * vacío que ya existía. Una pantalla que dice «no hay nada ese día» informa;
   * una pantalla en blanco con una leyenda encima, no.
   */
  it("si en toda la semana no hay un solo hueco, para en siete consultas y lo dice", async () => {
    const app = freshApp();
    const { bootstrap, servicio, persona } = await parCompatible(app, "demo-salon-demo");

    const DIAS_DE_LA_SEMANA = 7;
    for (let i = 0; i < DIAS_DE_LA_SEMANA; i += 1) {
      await ocuparElDiaEntero(
        app,
        "demo-salon-demo",
        servicio.serviceId,
        persona.employeeId,
        sumarDias(bootstrap.demoToday, i),
      );
    }

    const { pagina } = await llegarAlPasoDeFecha("demo-salon-demo", app);
    await esperarA(
      () => byId(pagina.document, "txb-rejilla").textContent.includes("No hay ningún hueco"),
      "el mensaje de vacío tras agotar la búsqueda",
    );

    const pedidas = consultas(pagina);
    expect(pedidas.length, "la búsqueda automática se ha ido más allá de la semana").toBe(
      DIAS_DE_LA_SEMANA,
    );
    expect(pedidas.map((u) => /date=(\d{4}-\d{2}-\d{2})/.exec(u)?.[1])).toEqual(
      Array.from({ length: DIAS_DE_LA_SEMANA }, (_, i) => sumarDias(bootstrap.demoToday, i)),
    );

    // El último consultado queda seleccionado: no se deja el paso sin día.
    const ultimo = sumarDias(bootstrap.demoToday, DIAS_DE_LA_SEMANA - 1);
    expect(fechaDeLaUltimaConsulta(pagina)).toBe(ultimo);
    expect(byId(pagina.document, "txb-horarios-titulo").textContent).toContain(diaDelMes(ultimo));
    expect(leyenda(pagina).hidden).toBe(true);
  });
});

describe("Demostración web · la preselección nunca pisa lo que ha elegido la persona", () => {
  /**
   * LA CARRERA, PROVOCADA A PROPÓSITO. El clic sobre un chip ocurre con la
   * búsqueda automática ya lanzada y todavía sin respuesta. Gana la persona: la
   * respuesta que venía de camino se descarta en vez de repintar la rejilla con
   * otro día bajo el dedo de quien acaba de elegir.
   */
  it("pulsar un día mientras corre la búsqueda automática deja ese día, no el buscado", async () => {
    const { pagina, bootstrap } = await llegarAlPasoDeFecha("demo-salon-demo");

    // Sin ceder el turno al bucle de eventos: la búsqueda automática está en
    // vuelo justo ahora.
    const elegido = sumarDias(bootstrap.demoToday, 3);
    expect(elegido).not.toBe(bootstrap.demoToday);
    chipDelDia(pagina, elegido).dispatchClick();

    await esperarA(() => huecos(pagina).length > 0, "la rejilla del día elegido a mano");
    // Y se deja correr el bucle de eventos por si la respuesta descartada
    // llegara tarde y repintara.
    await esperarA(() => true, "un turno más del bucle de eventos");

    expect(byId(pagina.document, "txb-horarios-titulo").textContent).toContain(diaDelMes(elegido));
    expect(diaDelChip(chipMarcado(pagina) as FakeElement)).toBe(diaDelMes(elegido));
    expect(fechaDeLaUltimaConsulta(pagina)).toBe(elegido);
  });

  /**
   * VOLVER AL PASO 3 NO REEMPIEZA. Con un día ya elegido, entrar otra vez lo
   * respeta y no lanza ninguna búsqueda: se limita a recargar SU disponibilidad.
   */
  it("al volver al paso 3 con un día ya elegido, ni lo cambia ni vuelve a buscar", async () => {
    const { pagina, bootstrap, persona } = await llegarAlPasoDeFecha("demo-salon-demo");
    await esperarA(() => huecos(pagina).length > 0, "la rejilla del día preseleccionado");

    const elegido = sumarDias(bootstrap.demoToday, 3);
    chipDelDia(pagina, elegido).dispatchClick();
    await esperarA(
      () => byId(pagina.document, "txb-horarios-titulo").textContent.includes(diaDelMes(elegido)),
      "la rejilla del día elegido a mano",
    );

    // Salir del cajón y volver a entrar por el mismo CTA.
    pagina.document.dispatchKeydown("Escape");
    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(false);
    const consultasAntes = consultas(pagina).length;

    ctaDelProfesional(pagina.document, persona.employeeId).dispatchClick();
    expect(byId(pagina.document, "txb-drawer-fecha").open).toBe(true);

    await esperarA(() => consultas(pagina).length > consultasAntes, "la recarga del día ya elegido");
    await esperarA(() => true, "un turno más del bucle de eventos");

    // Ni una consulta por el primer día del horizonte: la elección manda.
    expect(consultas(pagina).slice(consultasAntes).map((u) => /date=(\d{4}-\d{2}-\d{2})/.exec(u)?.[1]))
      .toEqual([elegido]);
    expect(diaDelChip(chipMarcado(pagina) as FakeElement)).toBe(diaDelMes(elegido));
  });
});

describe("Demostración web · la carga inicial no mueve el foco ni el desplazamiento", () => {
  /**
   * EL DEFECTO BLOQUEANTE, PROTEGIDO. El arranque termina en `goToStep(1)`, que
   * enfoca el encabezado del paso 1; ese encabezado vive en la quinta sección de
   * la página, así que enfocarlo arrastraba el documento hasta ella y la portada
   * —héroe, servicios, equipo— no la veía nadie. La cura es `primerPintado`, y
   * la preselección del día NO puede reabrir el agujero: se dispara al ENTRAR en
   * el paso 3, no al pintar la página.
   *
   * QUÉ SE MIDE AQUÍ, HONESTAMENTE. Este DOM no tiene ventana ni desplazamiento,
   * así que no se puede leer `window.scrollY`. Lo que sí se mide es su CAUSA: en
   * un navegador el documento se desplaza porque algo recibe el foco, y aquí
   * `activeElement` sigue vacío después de la carga entera. Ningún encabezado ha
   * sido enfocado, así que no hay nada que pudiera arrastrar la página.
   */
  it("tras cargar la página entera, nadie ha recibido el foco y el cajón sigue cerrado", async () => {
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const pagina = await abrirPaginaLista(tenantId);
      // Se deja correr el bucle de eventos por si algo enfocara con retraso.
      await esperarA(() => true, "un turno más del bucle de eventos");

      expect(
        pagina.document.activeElement,
        `${tenantId}: la carga ha movido el foco, y con él el desplazamiento de la página`,
      ).toBeNull();
      expect(byId(pagina.document, "txb-drawer-fecha").open, tenantId).toBe(false);
      expect(byId(pagina.document, "txb-paso-servicio").hidden, tenantId).toBe(false);
      expect(byId(pagina.document, "txb-paso-fecha-hora").hidden, tenantId).toBe(true);

      // Y la búsqueda de día no se ha disparado: sin servicio ni persona no hay
      // nada que preguntar, y la portada tiene que ser lo primero que se ve.
      expect(consultas(pagina), tenantId).toEqual([]);
    }
  });
});

describe("Demostración web · la rejilla de una sola columna se marca como tal", () => {
  /**
   * En la vista de un solo profesional la tabla se leía como una hoja de cálculo
   * de una columna —hora, ✓, hora, ✓— en vez de como fichas de hora. La
   * estructura no cambia: lo que cambia es que el cliente MARCA el caso con una
   * clase modificadora y la hoja de estilos lo presenta. Quién decide cuántas
   * columnas hay sigue siendo el servidor, en `byEmployee`.
   */
  const MODIFICADOR = ".txb-slots-table--una-columna";

  it("con un solo profesional, cada tabla lleva el modificador de una columna", async () => {
    const { pagina, persona } = await llegarAlPasoDeFecha("demo-salon-demo");
    await esperarA(() => huecos(pagina).length > 0, "la rejilla filtrada por una persona");

    const rejilla = byId(pagina.document, "txb-rejilla");
    const tablas = rejilla.querySelectorAll(".txb-slots-table");
    expect(tablas.length, "la rejilla no ha pintado ninguna tabla").toBeGreaterThan(0);
    expect(rejilla.querySelectorAll(MODIFICADOR).length).toBe(tablas.length);

    // Y de verdad hay UNA columna de persona: la cabecera es «Hora» y su nombre.
    for (const tabla of tablas) {
      expect(tabla.querySelectorAll("th").map((t) => t.textContent)).toEqual([
        "Hora",
        persona.displayName,
      ]);
    }
  });

  it("en la vista de día completo, con varias columnas, el modificador NO está", async () => {
    const { pagina } = await llegarAlPasoDeFecha("demo-salon-demo");
    const rejilla = byId(pagina.document, "txb-rejilla");
    await esperarA(() => huecos(pagina).length > 0, "la rejilla filtrada");

    const columnasAntes = rejilla.querySelectorAll("th").length;
    const consultasAntes = consultas(pagina).length;

    const interruptor = byId(pagina.document, "txb-vista-dia-completa");
    interruptor.checked = true;
    interruptor.dispatchChange();

    await esperarA(() => consultas(pagina).length > consultasAntes, "la consulta sin filtro");
    await esperarA(
      () => rejilla.querySelectorAll("th").length > columnasAntes,
      "las columnas del resto del equipo",
    );

    const tablas = rejilla.querySelectorAll(".txb-slots-table");
    expect(tablas.length).toBeGreaterThan(0);
    expect(
      rejilla.querySelectorAll(MODIFICADOR),
      "una tabla con varias columnas se ha marcado como de una sola",
    ).toEqual([]);

    // Y las columnas son, exactamente, las que publica el servidor.
    const disponibilidad = (
      await pagina.app.inject({ method: "GET", url: consultas(pagina).at(-1) as string })
    ).json() as { byEmployee: Array<{ displayName: string }> };
    expect(disponibilidad.byEmployee.length).toBeGreaterThan(1);
    for (const tabla of tablas) {
      expect(tabla.querySelectorAll("th").map((t) => t.textContent)).toEqual([
        "Hora",
        ...disponibilidad.byEmployee.map((e) => e.displayName),
      ]);
    }
  });
});
