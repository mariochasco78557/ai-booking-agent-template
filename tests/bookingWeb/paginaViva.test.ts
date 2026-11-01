import { describe, expect, it } from "vitest";

import type { FakeDocument, FakeElement } from "./fakeDom.js";
import {
  abrirPagina,
  abrirPaginaLista,
  bootstrapDe,
  byId,
  esperarA,
  type PaginaCargada,
} from "./paginaViva.helpers.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LA PÁGINA VIVA — la prueba que habría cazado el defecto del 2026-08-26.
 *
 * Aquel día la demostración web se cargaba entera y no hacía NADA: ni
 * servicios, ni «Continuar», ni panel. La causa era de una sola línea:
 * `renderBookingHtml()` no emitía ninguna etiqueta `<script>`, así que
 * `/app.js` —que se servía perfectamente, con sus 32 KB y su 200— no lo
 * cargaba nadie. Y 93 pruebas seguían en verde, porque las de flujo ejecutaban
 * el cliente contra un documento ESCRITO A MANO, un modelo mental del HTML que
 * sí tenía todos los nodos. El eslabón que faltaba —«¿el documento servido
 * llega a referenciar su script?»— no lo miraba nadie.
 *
 * Esta prueba recorre la CADENA ENTERA, tal y como la recorre un navegador:
 *
 *   HTML servido → etiqueta <script> → ese `src` pedido al servidor →
 *   ejecución del JavaScript contra el DOM ANALIZADO → bootstrap → clics.
 *
 * La mecánica vive en `paginaViva.helpers.ts`, que la comparten las pruebas de
 * CTA, navegación, panel y accesibilidad: una sola forma de abrir la página, y
 * en ninguna de ellas aparece la cadena "/app.js" escrita a mano.
 *
 * EL DOCUMENTO DE PRUEBAS ESCRITO A MANO YA NO EXISTE. `uiFlujo.test.ts` pasó a
 * analizar el HTML realmente servido y `createBookingFakeDocument` se borró; el
 * inventario de identificadores que aquel fichero sostenía lo recupera ahora
 * `contratoDeIdentificadores.test.ts`, derivándolo del propio cliente.
 * ────────────────────────────────────────────────────────────────────────
 */

const LOCAL = "demo-salon-demo";

describe("Demostración web · la página servida COBRA VIDA (HTML → script → bootstrap → clics)", () => {
  it("el HTML servido referencia exactamente un script externo propio, y esa ruta existe", async () => {
    const { srcDelScript, document } = await abrirPagina(LOCAL);

    // La ruta es interna y absoluta desde la raíz: ni protocolo, ni `//`, ni
    // dominio. `script-src 'self'` no dejaría pasar otra cosa.
    expect(srcDelScript.startsWith("/")).toBe(true);
    expect(srcDelScript.startsWith("//")).toBe(false);
    expect(/^[a-z]+:/i.test(srcDelScript)).toBe(false);

    const script = document.querySelector("script");
    expect(script?.getAttribute("defer")).toBe("");
    expect(script?.textContent).toBe("");
  });

  it("(e) al cargar, el cliente pide /bootstrap solo y pinta los SERVICIOS del servidor", async () => {
    const { app, document } = await abrirPagina(LOCAL);

    const grid = byId(document, "txb-servicios-grid");
    // Antes de que responda el bootstrap la rejilla está vacía: esto es lo que
    // se veía en la demostración rota, y para siempre.
    await esperarA(() => grid.children.length > 0, "los servicios pintados en la rejilla del paso 1");

    const bootstrap = await bootstrapDe(app, LOCAL);

    expect(bootstrap.services.length).toBeGreaterThan(0);
    expect(grid.children).toHaveLength(bootstrap.services.length);
    for (const [i, svc] of bootstrap.services.entries()) {
      const ficha = grid.children[i] as FakeElement;
      expect(ficha.tagName).toBe("BUTTON");
      expect(ficha.textContent).toContain(svc.label);
      expect(ficha.textContent).toContain(svc.priceLabel);
    }

    // Y el paso 1 es el visible; los otros tres siguen ocultos.
    expect(byId(document, "txb-paso-servicio").hidden).toBe(false);
    expect(byId(document, "txb-paso-profesional").hidden).toBe(true);
    expect(byId(document, "txb-paso-fecha-hora").hidden).toBe(true);
    expect(byId(document, "txb-paso-confirmacion").hidden).toBe(true);
  });

  it("(f) elegir un servicio HABILITA «Continuar», que el HTML sirve deshabilitado", async () => {
    const { document } = await abrirPagina(LOCAL);

    const grid = byId(document, "txb-servicios-grid");
    const continuar = byId(document, "txb-btn-continuar");
    expect(continuar.textContent).toBe("Continuar");
    expect(continuar.disabled, "el HTML servido tiene que traer «Continuar» deshabilitado").toBe(true);

    await esperarA(() => grid.children.length > 0, "los servicios pintados en la rejilla del paso 1");
    expect(continuar.disabled).toBe(true);

    // Pulsarlo sin haber elegido servicio no lleva a ninguna parte: sigue el
    // paso 1 en pantalla (el DOM falso se traga el clic de un botón inhabilitado,
    // como el navegador).
    continuar.dispatchClick();
    expect(byId(document, "txb-paso-servicio").hidden).toBe(false);
    expect(byId(document, "txb-paso-profesional").hidden).toBe(true);

    (grid.children[0] as FakeElement).dispatchClick();

    expect(continuar.disabled).toBe(false);
    expect(byId(document, "txb-resumen-servicio").hidden).toBe(false);
    expect(byId(document, "txb-resumen-servicio-nombre").textContent.length).toBeGreaterThan(0);
  });

  it("(g) pulsar «Continuar» lleva al paso de PROFESIONAL y se ve, con su rejilla pintada", async () => {
    const { app, document } = await abrirPagina(LOCAL);

    const grid = byId(document, "txb-servicios-grid");
    await esperarA(() => grid.children.length > 0, "los servicios pintados en la rejilla del paso 1");
    (grid.children[0] as FakeElement).dispatchClick();

    byId(document, "txb-btn-continuar").dispatchClick();

    expect(byId(document, "txb-paso-servicio").hidden).toBe(true);
    expect(byId(document, "txb-paso-profesional").hidden).toBe(false);

    const bootstrap = await bootstrapDe(app, LOCAL);
    const rejillaProfesionales = byId(document, "txb-profesionales-grid");
    expect(rejillaProfesionales.children).toHaveLength(bootstrap.employees.length);
    const nombres = rejillaProfesionales.children.map((f) => f.textContent);
    for (const emp of bootstrap.employees) {
      expect(nombres.some((n) => n.includes(emp.displayName))).toBe(true);
    }

    // El indicador de pasos también se ha movido: es el nodo del HTML real.
    const pasos = byId(document, "txb-steps").children;
    expect(pasos[0]?.getAttribute("aria-current")).toBeNull();
    expect(pasos[1]?.getAttribute("aria-current")).toBe("step");
  });

  it("(h) pulsar «Panel de reservas» CAMBIA la vista y carga el panel del servidor", async () => {
    const { document } = await abrirPaginaLista(LOCAL);

    const vistaReserva = byId(document, "txb-vista-reserva");
    const vistaPanel = byId(document, "txb-vista-dashboard");

    expect(vistaReserva.hidden).toBe(false);
    expect(vistaPanel.hidden).toBe(true);

    byId(document, "txb-tab-dashboard").dispatchClick();

    expect(vistaReserva.hidden).toBe(true);
    expect(vistaPanel.hidden).toBe(false);
    expect(byId(document, "txb-tab-dashboard").getAttribute("aria-pressed")).toBe("true");
    expect(byId(document, "txb-tab-reserva").getAttribute("aria-pressed")).toBe("false");

    // Y no es sólo un `hidden`: el panel ha hablado con `/dashboard` y ha
    // pintado sus totales y su estado de "todavía no hay ninguna reserva".
    const totales = byId(document, "txb-dashboard-totales");
    await esperarA(() => totales.children.length > 0, "los totales del panel de reservas");
    expect(byId(document, "txb-dashboard-vacio").hidden).toBe(false);
    expect(byId(document, "txb-dashboard-tbody").children).toHaveLength(0);
    expect(totales.textContent).toContain("Reservas");

    // Volver a «Reservar» deshace el cambio: la vista es reversible.
    byId(document, "txb-tab-reserva").dispatchClick();
    expect(vistaReserva.hidden).toBe(false);
    expect(vistaPanel.hidden).toBe(true);
  });

  it("el segundo local también cobra vida, y su página lleva su propio identificador", async () => {
    const { document } = await abrirPaginaLista("demo-dos");
    expect(document.body.getAttribute("data-tenant-id")).toBe("demo-dos");
  });

  /**
   * LA MARCA, COMPROBADA EN VIVO (defecto de la validación humana del
   * 2026-08-26: `/demo-dos` se presentaba con el logotipo de Demo Salon).
   *
   * No basta con que los dos HTML sean distintos: hay que ver que la marca de
   * cada uno viaja en una página que además SIGUE FUNCIONANDO, con su único
   * script y su bootstrap. Las dos cosas a la vez, en el mismo recorrido, es lo
   * que impide «arreglar» la marca dejando la página inerte —o al revés—.
   */
  it("los DOS locales cobran vida, cada uno con su marca y con su propio catálogo", async () => {
    const uno = await abrirPaginaLista(LOCAL);
    const dos = await abrirPaginaLista("demo-dos");

    // (1) Cada uno carga exactamente UN script, y es el mismo cliente: la
    // marca cambia, el núcleo no. `abrirPagina` ya ha comprobado que hay uno
    // solo, que su ruta existe y que se ejecuta.
    expect(uno.srcDelScript).toBe(dos.srcDelScript);
    expect(uno.document.querySelectorAll("script")).toHaveLength(1);
    expect(dos.document.querySelectorAll("script")).toHaveLength(1);

    // (2) Marca distinta: título, encabezado, tema y distintivo. El conteo de
    // imágenes se acota AL BLOQUE DE MARCA: la portada puede ganar ilustración
    // sin que esta prueba deje de decir lo que quiere decir, que es que el
    // distintivo de un local es una imagen propia y el del otro es texto.
    const tituloDe = (d: FakeDocument): string => d.querySelector("title")?.textContent ?? "";
    const marcaDe = (d: FakeDocument): FakeElement => {
      const marca = d.querySelector(".txb-brand");
      if (!marca) throw new Error("El HTML servido no tiene bloque de marca (.txb-brand).");
      return marca;
    };
    expect(tituloDe(uno.document)).not.toBe(tituloDe(dos.document));
    expect(byId(uno.document, "txb-titulo").textContent).not.toBe(
      byId(dos.document, "txb-titulo").textContent,
    );
    expect(uno.document.body.getAttribute("data-theme")).toBe("demo-salon");
    expect(dos.document.body.getAttribute("data-theme")).toBe("aralar");
    expect(marcaDe(uno.document).querySelectorAll("img")).toHaveLength(1);
    expect(marcaDe(dos.document).querySelectorAll("img")).toHaveLength(0);
    expect(dos.document.querySelector(".txb-brand-mark")?.textContent).toBe("PA");

    // (3) Y los dos siguen siendo INTERACTIVOS: cada uno pinta su propio
    // catálogo con SUS precios, comparados uno a uno contra SU bootstrap.
    const preciosEnPantalla = async (pagina: PaginaCargada): Promise<string[]> => {
      const bootstrap = await bootstrapDe(pagina.app, pagina.tenantId);
      const grid = byId(pagina.document, "txb-servicios-grid");
      for (const [i, svc] of bootstrap.services.entries()) {
        expect((grid.children[i] as FakeElement).textContent).toContain(svc.priceLabel);
      }
      return bootstrap.services.map((s) => s.priceLabel);
    };

    const preciosUno = await preciosEnPantalla(uno);
    const preciosDos = await preciosEnPantalla(dos);
    expect(preciosUno).not.toEqual(preciosDos);

    // (4) Y en la página del segundo local no aparece la palabra «Demo Salon» ni
    // pintada por el cliente ni servida en el HTML. El barrido completo —cada
    // valor de atributo y cada recurso referenciado— vive en
    // `dosLocalesSinCruces.test.ts`; esto es la red que mira lo PINTADO.
    expect(dos.document.body.textContent.toLowerCase()).not.toContain("demo-salon");
  });
});

/**
 * LA IDEMPOTENCIA, PULSANDO EL BOTÓN.
 *
 * `uiFlujo.test.ts` ya garantiza que llamar dos veces a `confirmBooking()` no
 * duplica la reserva. Eso prueba la lógica; no prueba la INTERFAZ. Con la web
 * pública, quien pulsa dos veces «Confirmar reserva» tiene que acabar con una
 * sola cita igual, y el camino entero —portada, CTA, cajón, hueco, pago— tiene
 * que llevarse a cabo con clics reales sobre el documento servido.
 */
describe("Demostración web · confirmar dos veces desde la portada deja UNA sola reserva", () => {
  it("recorre la portada entera, confirma, vuelve a pulsar y el panel sigue con una", async () => {
    const { app, document } = await abrirPaginaLista(LOCAL);
    const bootstrap = await bootstrapDe(app, LOCAL);

    // Paso 1 y 2, con clics sobre las fichas que el cliente ha pintado.
    (byId(document, "txb-servicios-grid").children[0] as FakeElement).dispatchClick();
    byId(document, "txb-btn-continuar").dispatchClick();
    const primeraCapaz = byId(document, "txb-profesionales-grid").children.find((f) => !f.disabled);
    expect(primeraCapaz, "ninguna persona puede realizar el primer servicio").toBeDefined();
    (primeraCapaz as FakeElement).dispatchClick();

    // Paso 3: «Continuar» abre el cajón, y el día se elige en la tira de la
    // semana. El «hoy» es el del bootstrap, nunca el reloj de la máquina.
    byId(document, "txb-btn-continuar").dispatchClick();
    expect(byId(document, "txb-drawer-fecha").open).toBe(true);

    const chipDeHoy = byId(document, "txb-dia-chips").children.find((c) => !c.disabled);
    expect(chipDeHoy, "la tira de días no ofrece ni un día dentro del horizonte").toBeDefined();
    (chipDeHoy as FakeElement).dispatchClick();

    const rejilla = byId(document, "txb-rejilla");
    await esperarA(() => rejilla.querySelectorAll(".txb-slot-btn").length > 0, "los huecos del día");

    const hueco = rejilla.querySelectorAll(".txb-slot-btn").find((b) => !b.disabled);
    expect(hueco, "el día elegido no ofrece ningún hueco libre").toBeDefined();
    (hueco as FakeElement).dispatchClick();

    // Pago sintético: la opción «en la peluquería», que no mueve un céntimo.
    const pagoLocal = byId(document, "txb-pago-local");
    pagoLocal.checked = true;
    pagoLocal.dispatchChange();

    const confirmar = byId(document, "txb-btn-confirmar");
    expect(confirmar.disabled).toBe(false);
    confirmar.dispatchClick();
    await esperarA(() => !byId(document, "txb-paso-confirmacion").hidden, "el paso de confirmación");

    // EL SEGUNDO CLIC. El botón queda deshabilitado tras el éxito, así que el
    // DOM falso se lo traga igual que el navegador: la interfaz no ofrece
    // siquiera la posibilidad de duplicar.
    expect(confirmar.disabled).toBe(true);
    confirmar.dispatchClick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    byId(document, "txb-tab-dashboard").dispatchClick();
    const tbody = byId(document, "txb-dashboard-tbody");
    await esperarA(() => tbody.children.length > 0, "la reserva en el panel");
    expect(tbody.children).toHaveLength(1);

    // Y el servidor opina lo mismo: una reserva, no dos.
    const panel = (await app.inject({ method: "GET", url: `/api/${LOCAL}/dashboard` })).json() as {
      bookings: unknown[];
    };
    expect(panel.bookings).toHaveLength(1);
    expect(bootstrap.tenantId).toBe(LOCAL);
  });
});
