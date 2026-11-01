import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildBookingWebServer } from "../../src/bookingWeb/server.js";
import { createBookingStore } from "../../src/bookingWeb/store.js";
import {
  buildTenantRegistry,
  TENANT_DEMO_DOS,
  TENANT_BOOKING_DEMO,
  tenantIds,
} from "../../src/bookingWeb/tenants.js";
import { BOOKING_CSS } from "../../src/bookingWeb/ui.css.js";
import type { FakeDocument } from "./fakeDom.js";
import { parseHtmlDocument } from "./htmlParse.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * DOS LOCALES, DOS MARCAS — el defecto de la validación humana del
 * 2026-08-26.
 *
 * `/demo-dos` se presentaba con el LOGOTIPO y la identidad de Demo Salon: el
 * título, la imagen y su texto alternativo estaban escritos a fuego en el
 * envoltorio HTML común, y `/brand/logo.png` servía el PNG del local principal
 * a quien lo pidiera. El segundo local existía en los datos —su catálogo, su
 * gente, su horario— y no existía en la pantalla.
 *
 * Todo lo que se comprueba aquí se comprueba sobre el HTML **realmente
 * servido** por la ruta real y **analizado** con `htmlParse.ts`, no sobre la
 * cadena que devuelve una función ni sobre un documento escrito a mano. El
 * aislamiento de datos (precios, personas, reservas) NO se repite aquí: ya lo
 * cubre `aislamientoEntreLocales.test.ts`, y esta suite sólo mira la marca.
 * ────────────────────────────────────────────────────────────────────────
 */

function freshApp(): FastifyInstance {
  return buildBookingWebServer({ store: createBookingStore(), registry: buildTenantRegistry() });
}

/** El HTML de un local, tal y como sale por la ruta real. */
async function paginaDe(app: FastifyInstance, tenantId: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: `/${tenantId}` });
  expect(res.statusCode, `GET /${tenantId}`).toBe(200);
  return res.body;
}

async function documentoDe(app: FastifyInstance, tenantId: string): Promise<FakeDocument> {
  return parseHtmlDocument(await paginaDe(app, tenantId));
}

/** El texto del `<title>` del documento analizado. */
function tituloDe(document: FakeDocument): string {
  const title = document.querySelector("title");
  if (!title) throw new Error("El HTML servido no tiene <title>.");
  return title.textContent;
}

/** El distintivo de la cabecera, sea imagen o tipográfico, ya normalizado. */
function distintivoDe(document: FakeDocument): {
  imagenes: string[];
  monograma: string | null;
  nombre: string | null;
} {
  const marca = document.querySelector(".txb-brand");
  if (!marca) throw new Error("El HTML servido no tiene bloque de marca (.txb-brand).");
  return {
    imagenes: marca.querySelectorAll("img").map((img) => img.getAttribute("src") ?? ""),
    monograma: marca.querySelector(".txb-brand-mark")?.textContent ?? null,
    nombre: marca.querySelector(".txb-brand-wordmark")?.textContent ?? null,
  };
}

const PNG_DE_DEMO_SALON = readFileSync(
  join(fileURLToPath(new URL("../../", import.meta.url)), "assets", "brand", "demo-salon-logo.png"),
);

describe("Demostración web · la marca sale de la configuración del local", () => {
  it("los dos locales sirven TÍTULO, ENCABEZADO y DISTINTIVO distintos", async () => {
    const app = freshApp();
    const uno = await documentoDe(app, TENANT_BOOKING_DEMO);
    const dos = await documentoDe(app, TENANT_DEMO_DOS);

    // Título del documento (lo que se lee en la pestaña del navegador).
    expect(tituloDe(uno)).not.toBe(tituloDe(dos));
    expect(tituloDe(uno).length).toBeGreaterThan(0);
    expect(tituloDe(dos).length).toBeGreaterThan(0);

    // Encabezado <h1> — el mismo nodo, dos textos.
    const h1Uno = uno.getElementById("txb-titulo");
    const h1Dos = dos.getElementById("txb-titulo");
    expect(h1Uno?.tagName).toBe("H1");
    expect(h1Dos?.tagName).toBe("H1");
    expect(h1Uno?.textContent).not.toBe(h1Dos?.textContent);

    // Y el subtítulo, que también es de cada local.
    const subUno = uno.querySelector(".txb-subtitle")?.textContent;
    const subDos = dos.querySelector(".txb-subtitle")?.textContent;
    expect(subUno).not.toBe(subDos);

    // Distintivo: imagen propia en uno, distintivo tipográfico en el otro.
    expect(distintivoDe(uno)).not.toEqual(distintivoDe(dos));
  });

  it("el HTML de /demo-dos NO nombra a Demo Salon ni referencia su activo, en ninguna parte", async () => {
    const app = freshApp();
    const html = await paginaDe(app, TENANT_DEMO_DOS);

    // Sin distinguir mayúsculas y sobre el documento ENTERO: título, alt,
    // comentarios, atributos, clases… si la palabra estuviera, aparecería.
    expect(html.toLowerCase()).not.toContain("demo-salon");
    expect(html).not.toContain("/brand/demo-salon-demo/");
    expect(html.toLowerCase()).not.toContain("logo.png");

    // Y no hay NINGUNA imagen en su bloque de marca: su distintivo es texto.
    // El conteo se acota a `.txb-brand` a propósito: la portada pública puede
    // ganar ilustración algún día sin que esta prueba deje de decir lo que
    // quiere decir, que es que este local NO se presenta con una imagen.
    const document = parseHtmlDocument(html);
    expect(distintivoDe(document).imagenes).toEqual([]);
  });

  it("/demo-dos se presenta con su propio nombre y su monograma, en texto real y seleccionable", async () => {
    const app = freshApp();
    const distintivo = distintivoDe(await documentoDe(app, TENANT_DEMO_DOS));

    expect(distintivo.imagenes).toEqual([]);
    expect(distintivo.monograma).toBe("PA");
    expect(distintivo.nombre).toBe("Peluquería Aralar (demo)");

    // El monograma es decorativo y el nombre no: quien use un lector de
    // pantalla oye la marca UNA vez, no dos.
    const marca = (await documentoDe(app, TENANT_DEMO_DOS)).querySelector(".txb-brand-mark");
    expect(marca?.getAttribute("aria-hidden")).toBe("true");
  });

  /**
   * El activo se declara con sus dimensiones INTRÍNSECAS (400×400, que es lo
   * que mide el PNG versionado), no con el tamaño al que se pinta. Declarar el
   * tamaño de pantalla —una proporción apaisada que el fichero no tiene—
   * obligaba al navegador a encajar un cuadrado en ella, lo dejaba ilegible a
   * 40 px de lado y reservaba una caja del alto equivocado: al llegar la imagen,
   * la composición saltaba. A qué tamaño se ve lo decide la hoja de estilos.
   */
  it("/demo-salon-demo conserva su identidad: su PNG, con su texto alternativo y su proporción real", async () => {
    const app = freshApp();
    const document = await documentoDe(app, TENANT_BOOKING_DEMO);
    const distintivo = distintivoDe(document);

    expect(distintivo.imagenes).toEqual([`/brand/${TENANT_BOOKING_DEMO}/logo.png`]);
    expect(distintivo.monograma).toBeNull();

    const img = document.querySelector(".txb-brand")?.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("Demo Salon");
    expect(img?.getAttribute("width")).toBe("400");
    expect(img?.getAttribute("height")).toBe("400");
  });

  it("el tema viaja en el <body> de cada local, y son temas distintos", async () => {
    const app = freshApp();
    const uno = (await documentoDe(app, TENANT_BOOKING_DEMO)).body;
    const dos = (await documentoDe(app, TENANT_DEMO_DOS)).body;

    expect(uno.getAttribute("data-tenant-id")).toBe(TENANT_BOOKING_DEMO);
    expect(uno.getAttribute("data-theme")).toBe("demo-salon");
    expect(dos.getAttribute("data-tenant-id")).toBe(TENANT_DEMO_DOS);
    expect(dos.getAttribute("data-theme")).toBe("aralar");
  });

  it("ninguna página lleva estilo en línea: el tema se conmuta con un atributo, no con CSS embebido", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const html = await paginaDe(app, tenantId);
      expect(html, tenantId).not.toMatch(/<style/i);
      expect(html, tenantId).not.toMatch(/\sstyle\s*=/);
    }
  });
});

describe("Demostración web · la hoja de estilos define las DOS paletas", () => {
  it("el CSS servido trae el tema por defecto y el del segundo local, con acentos distintos", async () => {
    const res = await freshApp().inject({ method: "GET", url: "/app.css" });
    expect(res.statusCode).toBe(200);
    const css = res.body;

    // Una sola hoja para los dos locales: el selector de tema es lo único que
    // los separa, y es un atributo del <body>.
    expect(css).toContain(':root {');
    expect(css).toContain('body[data-theme="aralar"] {');

    const acento = (bloque: string, token: string): string => {
      const cuerpo = css.slice(css.indexOf(bloque));
      const fin = cuerpo.indexOf("}");
      const patron = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`);
      const encontrado = patron.exec(cuerpo.slice(0, fin));
      if (!encontrado?.[1]) throw new Error(`El bloque ${bloque} no define ${token}.`);
      return encontrado[1].toUpperCase();
    };

    for (const token of ["--txb-accent-700", "--txb-accent-800", "--txb-accent-50", "--txb-canvas"]) {
      const porDefecto = acento(":root {", token);
      const aralar = acento('body[data-theme="aralar"] {', token);
      expect(porDefecto, token).not.toBe(aralar);
    }

    // El cobre del local principal y el índigo del segundo, tal cual. Son los
    // dos acentos verificados contra el 4,5:1 de texto normal sobre marfil; el
    // par anterior (#8F4F2A / #2A4B8D) no llegaba.
    expect(acento(":root {", "--txb-accent-700")).toBe("#9A4A22");
    expect(acento('body[data-theme="aralar"] {', "--txb-accent-700")).toBe("#23478A");
  });

  /**
   * EL COLOR DE LA BARRA DEL NAVEGADOR NO PUEDE IR POR LIBRE.
   *
   * `theme-color` es el único color que el documento declara por su cuenta: lo
   * lee el sistema operativo antes de tener la hoja de estilos, así que no hay
   * forma de expresarlo con una variable CSS y vive duplicado en una tabla
   * cerrada de la plantilla. Una duplicación inevitable es exactamente lo que
   * una prueba tiene que vigilar: aquí se comprueba que el `<meta>` que sirve
   * CADA local es, letra por letra, el `--txb-accent-700` de SU tema. Si alguien
   * retoca la paleta y se olvida del `<meta>`, la barra del navegador se queda
   * con el color viejo y esto se pone rojo.
   */
  it("el theme-color de cada local es el mismo acento que su tema declara en la hoja", async () => {
    const app = freshApp();
    const css = (await app.inject({ method: "GET", url: "/app.css" })).body;

    const acentoDelBloque = (bloque: string): string => {
      const cuerpo = css.slice(css.indexOf(bloque));
      const encontrado = /--txb-accent-700:\s*(#[0-9A-Fa-f]{6})/.exec(cuerpo.slice(0, cuerpo.indexOf("}")));
      if (!encontrado?.[1]) throw new Error(`El bloque ${bloque} no define --txb-accent-700.`);
      return encontrado[1].toUpperCase();
    };

    const metaDe = async (tenantId: string): Promise<string> => {
      const document = await documentoDe(app, tenantId);
      const meta = document.querySelectorAll('meta[name="theme-color"]');
      expect(meta, `${tenantId} no declara <meta name="theme-color">`).toHaveLength(1);
      return (meta[0]?.getAttribute("content") ?? "").toUpperCase();
    };

    expect(await metaDe(TENANT_BOOKING_DEMO)).toBe(acentoDelBloque(":root {"));
    expect(await metaDe(TENANT_DEMO_DOS)).toBe(acentoDelBloque('body[data-theme="aralar"] {'));
    expect(await metaDe(TENANT_BOOKING_DEMO)).not.toBe(await metaDe(TENANT_DEMO_DOS));
  });

  it("ninguna REGLA de la hoja escribe un color a mano: todas nombran un token", () => {
    // Todo lo que hay tras el bloque de temas son reglas. Si una de ellas
    // llevara un hex escrito, ese color no podría cambiar con el tema y la
    // marca del segundo local volvería a filtrarse por la puerta de atrás.
    const finDeLosTemas = BOOKING_CSS.indexOf('body[data-theme="aralar"] {');
    const reglas = BOOKING_CSS.slice(BOOKING_CSS.indexOf("}", finDeLosTemas));
    const hexes = [...reglas.matchAll(/#[0-9A-Fa-f]{3,6}\b/g)].map((m) => m[0]);
    // `#fff` (el blanco del texto sobre el acento) y `#8f1c16` (el rojo de
    // «reiniciar» al pasar por encima) son los dos únicos literales tolerados,
    // y ninguno de los dos es un color de marca.
    expect([...new Set(hexes)].sort()).toEqual(["#8f1c16", "#fff"]);
  });
});

describe("Demostración web · las TRES tablas de color dicen lo mismo", () => {
  /**
   * ════════════════════════════════════════════════════════════════════════
   * EL MISMO ACENTO ESTÁ ESCRITO EN TRES SITIOS, Y NADA LOS ATABA.
   *
   *   1. `--txb-accent-700` en `ui.css.ts`, que es el color de la interfaz.
   *   2. `THEME_COLORS` en `ui.html.ts`, que sale en `<meta name="theme-color">`
   *      y pinta la barra del navegador.
   *   3. `BRAND_ICON_COLORS` en `server.ts`, que es el fondo del icono de
   *      pestaña.
   *
   * Las tres duplicaciones son INEVITABLES por motivos distintos: el navegador
   * lee el `<meta>` antes de tener la hoja de estilos, y el icono es un
   * documento SVG aparte que no puede leer una variable CSS. Lo que no es
   * inevitable es que se desincronicen: un retoque de paleta que se olvide de
   * una deja la barra del navegador —o la pestaña— con el color viejo, y no lo
   * avisa nada, porque cada tabla es correcta por su cuenta.
   *
   * Esta prueba las ata. No comprueba «que el color sea bonito»: comprueba que
   * las tres tablas coinciden POR TEMA, recorriendo los temas del registro y no
   * una lista escrita a mano.
   * ════════════════════════════════════════════════════════════════════════
   */
  it("el acento de la hoja, el theme-color del documento y el fondo del icono coinciden, por tema", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();
    const css = (await app.inject({ method: "GET", url: "/app.css" })).body;

    /** El bloque de la hoja que declara los tokens de ese tema. */
    const bloqueDelTema = (theme: string): string =>
      theme === "demo-salon" ? ":root {" : `body[data-theme="${theme}"] {`;

    const acentoDeLaHoja = (theme: string): string => {
      const cuerpo = css.slice(css.indexOf(bloqueDelTema(theme)));
      const encontrado = /--txb-accent-700:\s*(#[0-9A-Fa-f]{6})/.exec(cuerpo.slice(0, cuerpo.indexOf("}")));
      if (!encontrado?.[1]) throw new Error(`La hoja no declara --txb-accent-700 para el tema «${theme}».`);
      return encontrado[1].toUpperCase();
    };

    const vistos = new Set<string>();
    for (const tenantId of tenantIds(registro)) {
      const tema = registro.get(tenantId)?.brand.theme as string;
      vistos.add(tema);

      // (2) El `<meta>` que sirve ESTE local.
      const document = await documentoDe(app, tenantId);
      const metas = document.querySelectorAll('meta[name="theme-color"]');
      expect(metas, `${tenantId}: número de <meta name="theme-color">`).toHaveLength(1);
      const themeColor = (metas[0]?.getAttribute("content") ?? "").toUpperCase();

      // (3) El fondo del icono de pestaña que sirve ESTE local, sacado del
      // documento —nunca escrito a mano— y leído del SVG servido.
      const href = document.querySelector('link[rel="icon"]')?.getAttribute("href") as string;
      const svg = (await app.inject({ method: "GET", url: href })).body;
      const fondo = /<rect[^>]*fill="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1]?.toUpperCase();
      expect(fondo, `${tenantId}: el icono no declara su color de fondo`).toBeTruthy();

      // Y las tres, iguales.
      expect(themeColor, `${tenantId}: el theme-color no es el acento del tema «${tema}»`).toBe(
        acentoDeLaHoja(tema),
      );
      expect(fondo, `${tenantId}: el fondo del icono no es el acento del tema «${tema}»`).toBe(
        acentoDeLaHoja(tema),
      );
    }

    // Se han recorrido los DOS temas: si un local dejara de tener el suyo, esta
    // prueba pasaría mirando la mitad.
    expect(vistos.size, "no se han comprobado todos los temas del registro").toBeGreaterThanOrEqual(2);
  });

  it("dos temas, dos acentos: si coincidieran, la comprobación anterior no probaría nada", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();
    const colores = new Set<string>();
    for (const tenantId of tenantIds(registro)) {
      const document = await documentoDe(app, tenantId);
      colores.add((document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "").toUpperCase());
    }
    expect(colores.size, "los dos locales pintan la barra del navegador del mismo color").toBe(
      tenantIds(registro).length,
    );
  });
});

describe("Demostración web · el activo de marca se valida SIEMPRE en el servidor", () => {
  it("el local que declara activo lo sirve, con sus bytes reales y su image/png", async () => {
    const res = await freshApp().inject({ method: "GET", url: `/brand/${TENANT_BOOKING_DEMO}/logo.png` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.equals(PNG_DE_DEMO_SALON)).toBe(true);
    // La CSP y las demás cabeceras de seguridad siguen viajando también aquí.
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("un local DESCONOCIDO es el mismo 404 UNKNOWN_TENANT que el resto de la API", async () => {
    const app = freshApp();
    for (const inventado of ["local-inventado", "DEMO SALON-DEMO", "no-existe"]) {
      const res = await app.inject({ method: "GET", url: `/brand/${inventado}/logo.png` });
      expect(res.statusCode, inventado).toBe(404);
      expect((res.json() as { code: string }).code, inventado).toBe("UNKNOWN_TENANT");
      expect((res.json() as { notice: string }).notice).toBe("Entorno de demostración · Datos ficticios");
    }
  });

  it("un local CONOCIDO que no declara activo es un 404 limpio, jamás el PNG de otro", async () => {
    const res = await freshApp().inject({ method: "GET", url: `/brand/${TENANT_DEMO_DOS}/logo.png` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("NO_BRAND_ASSET");
    expect(res.headers["content-type"]).not.toContain("image/png");
    expect(res.rawPayload.includes(PNG_DE_DEMO_SALON.subarray(0, 16))).toBe(false);
  });

  it("NINGÚN local sirve el activo de otro: se recorre el registro entero", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();
    const conActivo: string[] = [];

    for (const tenantId of tenantIds(registro)) {
      const res = await app.inject({ method: "GET", url: `/brand/${tenantId}/logo.png` });
      if (res.statusCode === 200) {
        conActivo.push(tenantId);
        const tenant = registro.get(tenantId);
        // Un 200 sólo puede venir de un local que DECLARA activo propio.
        expect(tenant?.brand.logo.kind, tenantId).toBe("asset");
        continue;
      }
      expect(res.statusCode, tenantId).toBe(404);
      // Y un local sin activo no devuelve ni un byte de imagen de nadie.
      expect(res.rawPayload.includes(PNG_DE_DEMO_SALON.subarray(0, 16)), tenantId).toBe(false);
    }

    // Exactamente un local publica activo hoy, y es el suyo.
    expect(conActivo).toEqual([TENANT_BOOKING_DEMO]);
  });
});

describe("Demostración web · la marca también viaja en /bootstrap", () => {
  it("cada local publica su nombre visible, su tema y el distintivo que le toca", async () => {
    const app = freshApp();
    const uno = (await app.inject({ method: "GET", url: `/api/${TENANT_BOOKING_DEMO}/bootstrap` })).json() as {
      displayName: string;
      brand: { displayName: string; theme: string; title: string; heading: string; logo: Record<string, unknown> };
    };
    const dos = (await app.inject({ method: "GET", url: `/api/${TENANT_DEMO_DOS}/bootstrap` })).json() as {
      displayName: string;
      brand: { displayName: string; theme: string; title: string; heading: string; logo: Record<string, unknown> };
    };

    expect(uno.brand.theme).toBe("demo-salon");
    expect(dos.brand.theme).toBe("aralar");
    expect(uno.brand.displayName).toBe(uno.displayName);
    expect(dos.brand.displayName).toBe(dos.displayName);
    expect(uno.brand.title).not.toBe(dos.brand.title);
    expect(uno.brand.heading).not.toBe(dos.brand.heading);

    // Las dimensiones son las INTRÍNSECAS del fichero (el PNG versionado es
    // cuadrado, 400×400), no el tamaño al que se pinta: ver el caso del
    // distintivo, más arriba.
    expect(uno.brand.logo).toEqual({
      kind: "asset",
      url: `/brand/${TENANT_BOOKING_DEMO}/logo.png`,
      alt: "Demo Salon",
      width: 400,
      height: 400,
    });
    expect(dos.brand.logo).toEqual({
      kind: "wordmark",
      initials: "PA",
      text: "Peluquería Aralar (demo)",
    });

    // El distintivo se publica como URL, nunca como nombre de fichero del disco.
    expect(JSON.stringify(dos.brand)).not.toContain(".png");
    expect(JSON.stringify(uno.brand)).not.toContain("assets/");
  });

  it("los campos que ya viajaban en /bootstrap siguen intactos, uno a uno", async () => {
    const app = freshApp();
    const cuerpo = (await app.inject({ method: "GET", url: `/api/${TENANT_BOOKING_DEMO}/bootstrap` })).json() as Record<
      string,
      unknown
    >;

    // La lista COMPLETA de claves de antes del cambio, más `brand` y nada más:
    // añadir marca no podía renombrar, quitar ni reordenar nada de lo que la
    // interfaz ya consumía.
    expect(Object.keys(cuerpo).sort()).toEqual(
      [
        "bookingHorizonDays",
        "brand",
        "demoToday",
        "displayName",
        "employees",
        "local",
        "notice",
        "paymentOptions",
        "services",
        "slotMinutes",
        "tenantId",
      ].sort(),
    );

    expect(cuerpo.tenantId).toBe(TENANT_BOOKING_DEMO);
    expect(cuerpo.displayName).toBe("Demo Salon (demo)");
    expect(cuerpo.notice).toBe("Entorno de demostración · Datos ficticios");
    expect(cuerpo.slotMinutes).toBe(30);
    expect((cuerpo.services as unknown[]).length).toBe(3);
    expect((cuerpo.employees as unknown[]).length).toBe(3);
  });
});
