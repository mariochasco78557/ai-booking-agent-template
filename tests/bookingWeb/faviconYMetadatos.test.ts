import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { BOOKING_WEB_CSP } from "../../src/bookingWeb/server.js";
import { buildTenantRegistry, tenantIds, type TenantDefinition } from "../../src/bookingWeb/tenants.js";
import { documentoDe, freshApp } from "./paginaViva.helpers.js";
import { cspSoloPermiteSelf, origenesDeCsp } from "./seguridad.helpers.js";

/**
 * ════════════════════════════════════════════════════════════════════════
 * EL ICONO DE PESTAÑA Y LOS METADATOS DEL DOCUMENTO.
 *
 * Tres cosas que sólo se ven cuando fallan:
 *
 *  1. EL ICONO. Sin `<link rel="icon">` el navegador pide `/favicon.ico` él
 *     solo y se lleva un 404 en cada carga: una línea roja en la consola de
 *     desarrollo que confunde con un fallo de verdad. Y con un icono
 *     COMPARTIDO entre locales, la pestaña de un local llevaría la marca del
 *     otro — la única fuga de marca que ningún barrido del HTML detecta,
 *     porque no está en el HTML.
 *  2. LOS METADATOS. `noindex` para que una demostración con datos ficticios no
 *     acabe indexada; un `viewport` sin `maximum-scale` para no bloquear el
 *     zoom (SC 1.4.4); `lang="es"` para que no se lea con la voz equivocada; y
 *     el `charset` como PRIMER hijo del `<head>`, que es lo que evita el
 *     mojibake en «Peluquería» y «Mañana».
 *  3. LA CSP, IDÉNTICA EN TODAS LAS RUTAS. Se compara con `toBe` contra la
 *     constante exportada, no con `toContain`: una directiva añadida a
 *     escondidas para hacer funcionar una fuente externa no se cuela por ahí.
 *     Y la lista de rutas se DERIVA del propio servidor (`printRoutes`), así
 *     que una ruta nueva que se saltara el hook se delata sola.
 * ════════════════════════════════════════════════════════════════════════
 */

/** Las rutas que el servidor declara, sacadas de él mismo. */
async function rutasDeclaradas(app: FastifyInstance): Promise<Array<{ url: string; metodos: string[] }>> {
  await app.ready();
  const arbol = app.printRoutes({ commonPrefix: false });
  const salida: Array<{ url: string; metodos: string[] }> = [];
  for (const linea of arbol.split("\n")) {
    const m = /^[├└]──\s+(\S+)\s+\(([^)]+)\)/.exec(linea.trim());
    if (!m) continue;
    salida.push({ url: m[1] as string, metodos: (m[2] as string).split(",").map((x) => x.trim()) });
  }
  return salida;
}

/** Sin acentos, sin mayúsculas: para comparar, nunca para mostrar. */
function normaliza(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Las palabras con las que un local se llama a sí mismo (nombre, no eslogan). */
function tokensDeIdentidad(tenant: TenantDefinition): string[] {
  const partes = [tenant.displayName, tenant.brand.title, tenant.brand.heading, tenant.brand.monogram];
  if (tenant.brand.logo.kind === "asset") partes.push(tenant.brand.logo.alt);
  else partes.push(tenant.brand.logo.initials, tenant.brand.logo.text);
  const salida = new Set<string>();
  for (const parte of partes) {
    for (const palabra of normaliza(parte).split(/[^a-z0-9]+/)) {
      if (palabra.length >= 4) salida.add(palabra);
    }
  }
  return [...salida];
}

describe("Demostración web · el icono de pestaña es propio de cada local", () => {
  it("cada local declara UN <link rel=icon>, y ese href —sacado del documento— responde 200", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const iconos = document.querySelectorAll('link[rel="icon"]');
      expect(iconos, `${tenantId}: número de <link rel="icon">`).toHaveLength(1);

      const href = iconos[0]?.getAttribute("href") as string;
      expect(href, tenantId).toBeTruthy();
      expect(iconos[0]?.getAttribute("type")).toBe("image/svg+xml");

      const res = await app.inject({ method: "GET", url: href });
      expect(res.statusCode, `${tenantId}: el icono declarado apunta a «${href}»`).toBe(200);
      expect(res.headers["content-type"]).toContain("image/svg+xml");
      expect(res.body.length).toBeGreaterThan(0);
    }
  });

  /**
   * UN SVG ES UN DOCUMENTO, NO UNA IMAGEN TONTA. Servido como `image/svg+xml`
   * puede llevar `<script>`, incrustar HTML con `<foreignObject>` o traerse
   * píxeles de fuera con `<image href>` o `<use href>`. El icono no tiene ni un
   * `href`, así que no queda ni un punto por donde ejecutar nada ni salir a la
   * red — y el único URI que contiene es el `xmlns` obligatorio para que el
   * navegador sepa que está pintando un SVG.
   */
  it("el icono servido no puede ejecutar nada ni pedir nada: ni script, ni href, ni imagen", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const href = document.querySelector('link[rel="icon"]')?.getAttribute("href") as string;
      const svg = (await app.inject({ method: "GET", url: href })).body;

      expect(svg.toLowerCase(), tenantId).not.toContain("<script");
      expect(svg.toLowerCase(), tenantId).not.toContain("<foreignobject");
      expect(svg.toLowerCase(), tenantId).not.toContain("<image");
      expect(svg.toLowerCase(), tenantId).not.toContain("<use");
      expect(svg.toLowerCase(), tenantId).not.toContain("href");
      expect(svg.toLowerCase(), tenantId).not.toContain("url(");

      // El ÚNICO URI del documento es el espacio de nombres de SVG, y va en un
      // `xmlns`. Se comprueba posicionalmente, no borrándolo del texto.
      const uris = [...svg.matchAll(/https?:\/\/[^\s"'<>]*/gi)].map((m) => m[0]);
      expect(uris, tenantId).toEqual(["http://www.w3.org/2000/svg"]);
      expect(svg, tenantId).toContain('xmlns="http://www.w3.org/2000/svg"');
    }
  });

  /**
   * LA FUGA QUE NINGÚN BARRIDO DEL HTML VE. Si el icono fuese una ruta
   * compartida (`/favicon.svg`), los dos locales enseñarían el mismo dibujo en
   * la pestaña y este caso tendría que fallar. Se comprueba en las dos
   * direcciones y derivado por PARES de locales, no con una lista de dos.
   */
  it("el icono de un local no contiene ni un rastro de la marca de otro", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();
    const iconos = new Map<string, string>();

    for (const tenantId of tenantIds(registro)) {
      const document = await documentoDe(app, tenantId);
      const href = document.querySelector('link[rel="icon"]')?.getAttribute("href") as string;
      // La ruta lleva el local DENTRO: el icono de uno no es alcanzable desde
      // la página del otro.
      expect(href, tenantId).toContain(tenantId);
      iconos.set(tenantId, (await app.inject({ method: "GET", url: href })).body);
    }

    for (const [propio, svg] of iconos) {
      for (const [ajeno, tenant] of registro) {
        if (ajeno === propio) continue;
        for (const token of tokensDeIdentidad(tenant)) {
          expect(
            normaliza(svg).includes(token),
            `el icono de «${propio}» contiene «${token}», que es de «${ajeno}»`,
          ).toBe(false);
        }
        expect(svg, `el icono de «${propio}» lleva el monograma de «${ajeno}»`).not.toContain(
          tenant.brand.monogram,
        );
      }
      // Y sí lleva el suyo.
      expect(svg).toContain(registro.get(propio)?.brand.monogram as string);
    }

    // Dos locales, dos iconos distintos byte a byte.
    expect(new Set(iconos.values()).size).toBe(iconos.size);
  });

  /**
   * `GET /favicon.ico` lo pide el navegador él solo en cada carga. Un 204 dice
   * lo único cierto —aquí no hay recurso, no ha pasado nada malo— sin inventar
   * un binario ni elegir «un local por defecto» desde un camino que no lleva
   * local, que es exactamente cómo la marca de uno acabaría en la pestaña del
   * otro.
   */
  it("GET /favicon.ico contesta 204 sin cuerpo, y sin elegir el local de nadie", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/favicon.ico" });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      expect(res.body).not.toContain(tenantId);
    }
  });
});

describe("Demostración web · los metadatos del documento", () => {
  it("los dos locales piden no ser indexados, en el documento y en la cabecera", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const robots = document.querySelectorAll('meta[name="robots"]');
      expect(robots, tenantId).toHaveLength(1);
      expect(robots[0]?.getAttribute("content")).toBe("noindex, nofollow");

      // Y en cabecera, que es lo único que cubre un recurso no-HTML.
      const res = await app.inject({ method: "GET", url: `/${tenantId}` });
      expect(res.headers["x-robots-tag"], tenantId).toBe("noindex, nofollow");
    }
  });

  /**
   * NADA DE BLOQUEAR EL ZOOM. `maximum-scale=1` o `user-scalable=no` en el
   * `viewport` incumplen la SC 1.4.4 y se cuelan en un segundo copiando un
   * `<meta>` de internet.
   */
  it("el viewport deja hacer zoom: ni maximum-scale ni user-scalable", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      const viewport = document.querySelectorAll('meta[name="viewport"]');
      expect(viewport, tenantId).toHaveLength(1);
      const content = viewport[0]?.getAttribute("content") ?? "";
      expect(content).toContain("width=device-width");
      expect(content).toContain("initial-scale=1");
      expect(content.toLowerCase(), tenantId).not.toContain("maximum-scale");
      expect(content.toLowerCase(), tenantId).not.toContain("user-scalable");
      expect(content.toLowerCase(), tenantId).not.toContain("minimum-scale");
    }
  });

  it("el documento se declara en castellano y con su charset como PRIMER hijo del head", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      expect(document.documentElement?.tagName, tenantId).toBe("HTML");
      expect(document.documentElement?.getAttribute("lang"), tenantId).toBe("es");

      const head = document.head;
      expect(head, tenantId).not.toBeNull();
      const primero = head?.children[0];
      expect(primero?.tagName, `${tenantId}: el primer elemento del <head>`).toBe("META");
      expect(primero?.getAttribute("charset")?.toLowerCase()).toBe("utf-8");

      // Y la respuesta lo dice también, que es lo que manda de verdad.
      const res = await app.inject({ method: "GET", url: `/${tenantId}` });
      expect(String(res.headers["content-type"]).toLowerCase()).toContain("charset=utf-8");
    }
  });

  it("ningún documento redirige por su cuenta ni reescribe sus rutas", async () => {
    const app = freshApp();
    for (const tenantId of tenantIds(buildTenantRegistry())) {
      const document = await documentoDe(app, tenantId);
      expect(document.querySelectorAll("meta[http-equiv]"), tenantId).toEqual([]);
      expect(document.querySelectorAll("base"), tenantId).toEqual([]);
      // Y ningún enlace que abra fuera: sin `target` no hay `_blank` sin `rel`.
      const conTarget = document
        .querySelectorAll("a, area, form")
        .filter((n) => n.getAttribute("target") !== null);
      expect(conTarget, tenantId).toEqual([]);
    }
  });

  it("la descripción del documento sale de la configuración del local, y son distintas", async () => {
    const app = freshApp();
    const registro = buildTenantRegistry();
    const descripciones = new Map<string, string>();

    for (const tenantId of tenantIds(registro)) {
      const document = await documentoDe(app, tenantId);
      const meta = document.querySelectorAll('meta[name="description"]');
      expect(meta, tenantId).toHaveLength(1);
      const content = meta[0]?.getAttribute("content") ?? "";
      expect(content, tenantId).toBe(registro.get(tenantId)?.content.seo.description);
      descripciones.set(tenantId, content);
    }
    expect(new Set(descripciones.values()).size).toBe(descripciones.size);
  });
});

describe("Demostración web · la CSP es la MISMA en todas las rutas, incluidas las nuevas", () => {
  /**
   * La lista de rutas se le pide al servidor. Si mañana aparece una que no pase
   * por el hook `onSend` —o que se registre en otra instancia—, este caso la
   * recorre igual y la delata, sin que nadie tenga que acordarse de añadirla.
   */
  it("cada ruta declarada por el servidor devuelve la CSP exacta y las cinco cabeceras", async () => {
    const app = freshApp();
    const rutas = await rutasDeclaradas(app);
    expect(rutas.length, "el servidor no declara ninguna ruta").toBeGreaterThanOrEqual(11);

    const visitadas: string[] = [];
    for (const ruta of rutas) {
      const url = ruta.url.replace(":tenantId", "demo-salon-demo");
      const metodo = ruta.metodos.includes("GET") ? "GET" : "POST";
      const res = await app.inject({ method: metodo as "GET" | "POST", url, payload: {} });
      visitadas.push(url);

      expect(res.headers["content-security-policy"], url).toBe(BOOKING_WEB_CSP);
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
      expect(res.headers["x-frame-options"], url).toBe("DENY");
      expect(res.headers["referrer-policy"], url).toBe("no-referrer");
      expect(res.headers["x-robots-tag"], url).toBe("noindex, nofollow");
    }

    // Las dos rutas nuevas de esta misión están, de verdad, entre las visitadas.
    expect(visitadas).toContain("/brand/demo-salon-demo/icon.svg");
    expect(visitadas).toContain("/favicon.ico");
  });

  it("una ruta inexistente contesta con las mismas cabeceras: el 404 no es una puerta trasera", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/no-existe-este-local" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-security-policy"]).toBe(BOOKING_WEB_CSP);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("los orígenes que la CSP permite siguen siendo exactamente 'none' y 'self'", () => {
    expect(origenesDeCsp(BOOKING_WEB_CSP)).toEqual(["'none'", "'self'"]);
    expect(BOOKING_WEB_CSP).not.toMatch(/unsafe-inline|unsafe-eval|data:|blob:/i);
    // `frame-ancestors`, `base-uri` y `form-action` no heredan de `default-src`:
    // sin nombrarlos, `'none'` no diría nada sobre marcos, `<base>` ni envíos.
    for (const directiva of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
      expect(BOOKING_WEB_CSP).toContain(directiva);
    }
  });

  /**
   * META-GARANTÍA, Y ES BARATA. Todas las afirmaciones de este fichero sobre la
   * CSP pasan por el mismo extractor de orígenes. Si ese extractor se rompiera
   * —o alguien lo reescribiera mal—, TODAS pasarían a ser vacías y nadie lo
   * notaría. Así que se le da de comer una política DEBILITADA a propósito y se
   * exige que la rechace.
   */
  it("el extractor de orígenes rechaza una CSP debilitada: la garantía no es vacía", () => {
    expect(cspSoloPermiteSelf(BOOKING_WEB_CSP)).toBe(true);

    for (const debilitada of [
      `${BOOKING_WEB_CSP} 'unsafe-inline'`,
      BOOKING_WEB_CSP.replace("img-src 'self'", "img-src 'self' data:"),
      BOOKING_WEB_CSP.replace("script-src 'self'", "script-src 'self' https://cdn.ejemplo"),
      BOOKING_WEB_CSP.replace("connect-src 'self'", "connect-src *"),
    ]) {
      expect(cspSoloPermiteSelf(debilitada), `no ha detectado: ${debilitada}`).toBe(false);
      expect(debilitada).not.toBe(BOOKING_WEB_CSP);
    }
  });
});
