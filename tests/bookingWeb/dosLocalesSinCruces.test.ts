import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildTenantRegistry, tenantIds, type TenantDefinition } from "../../src/bookingWeb/tenants.js";
import type { FakeDocument } from "./fakeDom.js";
import {
  abrirPaginaLista,
  byId,
  documentoDe,
  esperarA,
  freshApp,
  paginaDe,
} from "./paginaViva.helpers.js";
import { conTodoElTextoReescrito, registroCambiando } from "./registro.helpers.js";
import { todosLosElementos, urlsDelDocumento } from "./seguridad.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * NI UNA PALABRA DEL OTRO LOCAL.
 *
 * El 2026-08-26 `/demo-dos` se presentaba con el logotipo y la identidad de
 * Demo Salon. La cura fue sacar la marca a configuración, y la prueba que quedó
 * mira el HTML: «la página de demo-dos no contiene la cadena demo-salon». Eso deja
 * fuera tres superficies por las que la misma fuga vuelve:
 *
 *   1. LOS ATRIBUTOS. Un `aria-label`, un `alt`, una clase `txb-demo-salon-hero` o
 *      un `<title>` no son texto del cuerpo.
 *   2. LOS RECURSOS QUE LA PÁGINA REFERENCIA. El icono de pestaña es el caso
 *      claro: un icono compartido pone la «TX» en la pestaña del otro local y
 *      ningún barrido del HTML lo ve, porque no está en el HTML.
 *   3. EL FUTURO. Una lista de dos locales escrita a mano no dice nada el día
 *      que haya un tercero. Aquí el barrido se DERIVA por pares del registro.
 *
 * ────────────────────────────────────────────────────────────────────────
 * CÓMO SE DECIDE QUÉ PALABRA ES «DE UN LOCAL», SIN ESCRIBIR NINGUNA LISTA
 *
 * Una palabra es distintiva de B respecto de A cuando aparece en la IDENTIDAD
 * de B (su nombre visible, su título, su encabezado, su distintivo, su
 * monograma) y no aparece ni en la identidad de A ni EN EL VOCABULARIO DE LA
 * PROPIA PLANTILLA.
 *
 * Ese tercer conjunto también se deriva, y es la pieza que hace honesta a toda
 * la comprobación: se sirve un local FICTICIO cuyo texto se ha reescrito entero
 * con una palabra sin sentido, y se recogen las palabras que aparecen en su
 * página. Todo lo que salga ahí lo pone la plantilla, no el local — «peluquería»
 * es el ejemplo exacto, porque la opción de pago dice «Pagar en la peluquería» y
 * sin este paso el barrido acusaría a Demo Salon de llevar dentro la marca de
 * «Peluquería Aralar».
 * ════════════════════════════════════════════════════════════════════════
 */

const PNG_DE_DEMO_SALON = readFileSync(
  fileURLToPath(new URL("../../assets/brand/demo-salon-logo.png", import.meta.url)),
);

/** Sin acentos y en minúsculas. Para comparar, nunca para mostrar. */
function normaliza(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Las palabras de cuatro letras o más de un texto, ya normalizadas. */
function palabras(texto: string): string[] {
  return normaliza(texto)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 4);
}

/** Las palabras con las que un local se NOMBRA a sí mismo. No su eslogan: su nombre. */
function identidadDe(tenant: TenantDefinition): Set<string> {
  const partes = [tenant.displayName, tenant.brand.title, tenant.brand.heading, tenant.brand.monogram];
  if (tenant.brand.logo.kind === "asset") partes.push(tenant.brand.logo.alt);
  else partes.push(tenant.brand.logo.initials, tenant.brand.logo.text);
  return new Set(partes.flatMap((p) => palabras(p)));
}

/**
 * EL VOCABULARIO DE LA PLANTILLA, derivado sirviendo un local sin vocabulario.
 *
 * Se hace con los DOS caminos del distintivo —el de imagen y el tipográfico—
 * para que ninguna rama del marcado quede fuera del conjunto.
 *
 * SE LE QUITAN LOS IDENTIFICADORES DE TEMA, y hace falta explicarlo. `demo-salon` y
 * `aralar` son también los dos valores de `TenantThemeId`, que viaja en
 * `<body data-theme="…">` para elegir un bloque de variables CSS. Como el local
 * ficticio conserva su tema —es una unión cerrada, no prosa—, esas dos palabras
 * aparecerían en su página y el conjunto se tragaría justo las que hay que
 * vigilar: el barrido quedaría vacuo sin que nadie lo notara. Se excluyen, y el
 * hueco que dejan lo tapa `marcaPorLocal.test.ts`, que afirma cuál es el
 * `data-theme` de CADA local, uno por uno.
 */
async function vocabularioDeLaPlantilla(): Promise<Set<string>> {
  const MARCADOR = "zzqqx";
  const vocabulario = new Set<string>();
  const registro = buildTenantRegistry();
  const temas = new Set([...registro.values()].map((t) => normaliza(t.brand.theme)));

  for (const [i, base] of [...registro.values()].entries()) {
    const neutro: TenantDefinition = {
      ...conTodoElTextoReescrito(base, () => MARCADOR),
      tenantId: `neutro${String(i)}`,
    };
    const app = freshApp(new Map([[neutro.tenantId, neutro]]));
    // Sólo la PÁGINA y su icono: lo que la plantilla pone en un documento. La
    // hoja y el cliente son compartidos y se comprueban por identidad de bytes,
    // no por vocabulario.
    for (const p of palabras(await paginaDe(app, neutro.tenantId))) vocabulario.add(p);
    const icono = await app.inject({ method: "GET", url: `/brand/${neutro.tenantId}/icon.svg` });
    for (const p of palabras(icono.body)) vocabulario.add(p);
  }

  for (const tema of temas) vocabulario.delete(tema);
  return vocabulario;
}

/** Todos los valores de atributo del documento: donde no mira `textContent`. */
function valoresDeAtributo(document: FakeDocument): string[] {
  const salida: string[] = [];
  for (const nodo of todosLosElementos(document)) {
    salida.push(nodo.className);
    for (const nombre of nodo.getAttributeNames()) salida.push(nodo.getAttribute(nombre) ?? "");
  }
  return salida;
}

describe("Demostración web · la marca de un local no aparece en la página de otro", () => {

  it("tampoco en el <title>, ni en un <meta>, ni en una clase", async () => {
    const registro = buildTenantRegistry();
    const plantilla = await vocabularioDeLaPlantilla();
    const app = freshApp();

    for (const idA of tenantIds(registro)) {
      const document = await documentoDe(app, idA);
      const superficies = [
        document.querySelector("title")?.textContent ?? "",
        ...document.querySelectorAll("meta").map((m) => m.getAttribute("content") ?? ""),
        ...todosLosElementos(document).map((n) => n.className),
        ...todosLosElementos(document).map((n) => n.getAttribute("alt") ?? ""),
        ...todosLosElementos(document).map((n) => n.getAttribute("aria-label") ?? ""),
      ].join(" ");

      for (const idB of tenantIds(registro)) {
        if (idA === idB) continue;
        const propias = identidadDe(registro.get(idA) as TenantDefinition);
        for (const palabra of identidadDe(registro.get(idB) as TenantDefinition)) {
          if (propias.has(palabra) || plantilla.has(palabra)) continue;
          expect(
            normaliza(superficies).includes(palabra),
            `«${idA}» filtra «${palabra}» de «${idB}» por título, meta, clase, alt o aria-label`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * CADA RECURSO QUE LA PÁGINA REFERENCIA, DESCARGADO Y BARRIDO.
   *
   * Los recursos POR LOCAL (los que llevan el identificador en la ruta) no
   * pueden contener nada del otro. Los COMPARTIDOS —una sola hoja y un solo
   * cliente para los dos locales, que es la decisión de diseño— se comprueban de
   * otra forma, y más fuerte: tienen que ser BYTE A BYTE IGUALES se pidan desde
   * la página que se pidan. Un recurso idéntico para todos no puede llevar la
   * identidad de nadie; y si algún día uno de ellos empezara a variar por local,
   * esta prueba lo diría.
   */
  it("cada recurso referenciado se descarga y se barre: el icono incluido", async () => {
    const registro = buildTenantRegistry();
    const plantilla = await vocabularioDeLaPlantilla();
    const app = freshApp();
    const compartidos = new Map<string, string>();

    for (const idA of tenantIds(registro)) {
      const document = await documentoDe(app, idA);
      const rutas = [
        ...new Set(
          urlsDelDocumento(document)
            .map((u) => u.valor)
            .filter((v) => v.startsWith("/")),
        ),
      ];
      expect(rutas.length, `${idA}: la página no referencia ningún recurso`).toBeGreaterThan(0);

      for (const ruta of rutas) {
        const res = await app.inject({ method: "GET", url: ruta });
        expect(res.statusCode, `${idA} referencia «${ruta}»`).toBe(200);

        if (ruta.includes(`/${idA}/`)) {
          // Recurso PROPIO: ni una palabra ni un byte del vecino.
          const cuerpo = normaliza(res.body);
          for (const idB of tenantIds(registro)) {
            if (idA === idB) continue;
            const propias = identidadDe(registro.get(idA) as TenantDefinition);
            for (const palabra of identidadDe(registro.get(idB) as TenantDefinition)) {
              if (propias.has(palabra) || plantilla.has(palabra)) continue;
              expect(cuerpo.includes(palabra), `«${ruta}» de «${idA}» contiene «${palabra}»`).toBe(false);
            }
          }
          continue;
        }

        // Recurso COMPARTIDO: los mismos bytes para todos los locales.
        const yaVisto = compartidos.get(ruta);
        if (yaVisto === undefined) compartidos.set(ruta, res.body);
        else expect(res.body, `«${ruta}» cambia según quién lo pida`).toBe(yaVisto);
      }
    }
    expect(compartidos.size, "no hay ningún recurso compartido: la hoja y el cliente son uno").toBeGreaterThan(0);
  });

  it("ningún local sirve, ni por asomo, los bytes del activo de marca de otro", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();

    for (const idA of tenantIds(registro)) {
      const document = await documentoDe(app, idA);
      const conActivo = (registro.get(idA) as TenantDefinition).brand.logo.kind === "asset";

      for (const { valor } of urlsDelDocumento(document)) {
        if (!valor.startsWith("/")) continue;
        const res = await app.inject({ method: "GET", url: valor });
        const llevaElPng = res.rawPayload.includes(PNG_DE_DEMO_SALON.subarray(0, 16));
        if (llevaElPng) {
          // Sólo puede llevarlo el local que DECLARA ese activo, y por su ruta.
          expect(conActivo, `«${idA}» sirve el PNG de otro en «${valor}»`).toBe(true);
          expect(valor).toContain(`/${idA}/`);
        }
      }
    }
  });
});

describe("Demostración web · el copy público es CONFIGURACIÓN, no plantilla", () => {
  /**
   * EL DEFECTO DEL 2026-08-26, REPETIDO EN LA CAPA NUEVA. Si una frase del
   * titular estuviera escrita en la plantilla, los dos locales dirían lo mismo
   * y nadie se enteraría hasta ver las dos pantallas juntas. Con un registro
   * inyectado, la frase nueva sólo puede llegar a la página si la plantilla la
   * ha leído del local.
   */
  it("con el titular alterado en el registro, la página lo enseña y el otro local no", async () => {
    const TITULAR = "Zzz titular inyectado por la prueba";
    const registry = registroCambiando("demo-salon-demo", (t) => ({
      ...t,
      content: { ...t.content, hero: { ...t.content.hero, headline: TITULAR } },
    }));
    const app = freshApp(registry);

    const document = await documentoDe(app, "demo-salon-demo");
    expect(byId(document, "txb-titulo").textContent).toBe(TITULAR);
    expect(await paginaDe(app, "demo-dos")).not.toContain(TITULAR);
  });

  it("los dos locales cuentan cosas DISTINTAS en cada sección, no la misma con otro nombre", async () => {
    const app = freshApp();
    const secciones = ["hero", "servicios", "profesionales", "experiencia", "info", "faq"];
    const uno = await documentoDe(app, "demo-salon-demo");
    const dos = await documentoDe(app, "demo-dos");

    for (const seccion of secciones) {
      const textoUno = byId(uno, `txb-seccion-${seccion}`).textContent.trim();
      const textoDos = byId(dos, `txb-seccion-${seccion}`).textContent.trim();
      expect(textoUno.length, seccion).toBeGreaterThan(0);
      expect(textoUno, `la sección «${seccion}» dice exactamente lo mismo en los dos locales`).not.toBe(
        textoDos,
      );
    }
  });

  /**
   * LA MARCA VUELVE A SER CÓDIGO POR UNA SOLA PUERTA: un `if` por local en la
   * plantilla. Se lee el fuente como texto y se exige que no mencione a ningún
   * local conocido, ni para compararlo ni para nada.
   */
  it("ni la plantilla ni sus secciones mencionan a ningún local por su nombre", () => {
    const fuentes = ["ui.html.ts", "ui.sections.ts", "ui.css.ts", "ui.js.ts"];
    const identificadores = tenantIds(buildTenantRegistry());

    for (const fichero of fuentes) {
      const texto = readFileSync(
        fileURLToPath(new URL(`../../src/bookingWeb/${fichero}`, import.meta.url)),
        "utf8",
      );
      for (const tenantId of identificadores) {
        expect(texto.includes(`"${tenantId}"`), `${fichero} compara contra «${tenantId}»`).toBe(false);
        expect(texto.includes(`'${tenantId}'`), `${fichero} compara contra «${tenantId}»`).toBe(false);
      }
      // Y ninguna comparación con un identificador de local, escrita como sea.
      expect(texto, `${fichero} compara un tenantId`).not.toMatch(/tenantId\s*===/);
    }
  });
});

describe("Demostración web · el aislamiento se ve desde LAS DOS páginas vivas", () => {
  it("una reserva hecha desde la portada de un local deja vacío el panel del otro", async () => {
    const app: FastifyInstance = freshApp();
    const uno = await abrirPaginaLista("demo-salon-demo", { app });
    const dos = await abrirPaginaLista("demo-dos", { app });

    // Recorrido completo en el primer local, con clics reales.
    (byId(uno.document, "txb-servicios-grid").children[0] as { dispatchClick: () => void }).dispatchClick();
    byId(uno.document, "txb-btn-continuar").dispatchClick();
    const capaz = byId(uno.document, "txb-profesionales-grid").children.find((f) => !f.disabled);
    capaz?.dispatchClick();
    byId(uno.document, "txb-btn-continuar").dispatchClick();
    byId(uno.document, "txb-dia-chips").children.find((c) => !c.disabled)?.dispatchClick();

    const rejilla = byId(uno.document, "txb-rejilla");
    await esperarA(() => rejilla.querySelectorAll(".txb-slot-btn").length > 0, "los huecos del día");
    rejilla.querySelectorAll(".txb-slot-btn").find((b) => !b.disabled)?.dispatchClick();

    const pago = byId(uno.document, "txb-pago-local");
    pago.checked = true;
    pago.dispatchChange();
    byId(uno.document, "txb-btn-confirmar").dispatchClick();
    await esperarA(() => !byId(uno.document, "txb-paso-confirmacion").hidden, "la confirmación");

    // El panel del primero tiene una; el del segundo, ninguna.
    byId(uno.document, "txb-tab-dashboard").dispatchClick();
    await esperarA(() => byId(uno.document, "txb-dashboard-tbody").children.length > 0, "la reserva");
    expect(byId(uno.document, "txb-dashboard-tbody").children).toHaveLength(1);

    byId(dos.document, "txb-tab-dashboard").dispatchClick();
    await esperarA(
      () => byId(dos.document, "txb-dashboard-totales").children.length > 0,
      "los totales del segundo local",
    );
    expect(byId(dos.document, "txb-dashboard-tbody").children).toHaveLength(0);
    expect(byId(dos.document, "txb-dashboard-vacio").hidden).toBe(false);

    // Y ninguna de las dos páginas ha hablado por la otra.
    for (const url of uno.urlsPedidas) expect(url.startsWith("/api/demo-salon-demo/")).toBe(true);
    for (const url of dos.urlsPedidas) expect(url.startsWith("/api/demo-dos/")).toBe(true);
  });
});
