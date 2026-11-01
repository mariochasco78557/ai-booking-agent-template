import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONSOLE_CSS } from "../../src/console/ui.css.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";

/**
 * step 21A — contratos del rediseño visual de la consola de operación.
 *
 * Qué NO es este fichero: una prueba de renderizado. No hay navegador en esta
 * suite (decisión de misión, ver `tests/console/fakeDom.ts`), así que aquí no
 * se afirma en ningún sitio "esto se ve bien". Lo que se comprueba es lo que
 * SÍ se puede demostrar sin pintar un píxel: que el texto servido (HTML, CSS
 * y JavaScript) sigue diciendo lo que el diseño manda y sigue sin decir lo
 * que el diseño prohíbe.
 *
 * El comportamiento de cada pantalla ya lo cubren los ficheros de siempre
 * (console.test.ts, uiClientLogic.test.ts, tallerUi.test.ts, waitlistUi...).
 * Aquí sólo vive lo transversal del rediseño: las siete rutas, la marca, la
 * cabecera honesta, la capa de alias, la estructura semántica y las reglas
 * duras de la hoja de estilos.
 */

const HTML = renderConsoleHtml(4310);
const JS = renderConsoleAppJs();

/** Los contratos miran CÓDIGO, no comentarios: un comentario que nombra la
 *  palabra prohibida justamente para prohibirla no puede disparar el barrido. */
function sinComentarios(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Sólo líneas ENTERAS de comentario: así no se toca ningún `//` que
    // viviera dentro de una cadena. (En el JavaScript servido no hay
    // ninguno — otra prueba de este mismo fichero lo comprueba.)
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const CSS_LIMPIO = sinComentarios(CONSOLE_CSS);
const HTML_LIMPIO = sinComentarios(HTML);
const JS_LIMPIO = sinComentarios(JS);

const RUTAS = ["inicio", "agenda", "lista-espera", "llamadas", "horarios-y-ausencias", "equipo", "laboratorio"] as const;

// =====================================================================
// 1. Las siete rutas: mismas, mismo orden, mismos hashes
// =====================================================================

describe("step 21A · las siete rutas sobreviven al rediseño", () => {
  it("la barra lateral ofrece exactamente las siete, en el orden del diseño", () => {
    const rutas = [...HTML.matchAll(/data-route="([a-z-]+)"/g)].map((m) => m[1]);
    expect(rutas).toEqual([...RUTAS]);
  });

  it("cada entrada de navegación apunta a su hash y a ninguna otra dirección", () => {
    for (const ruta of RUTAS) {
      const enlace = new RegExp(`<a href="#/${ruta}" data-route="${ruta}"[^>]*>`).exec(HTML)?.[0] ?? "";
      expect(enlace, `no existe la entrada de navegación de ${ruta}`).not.toBe("");
      expect(enlace).toContain(`aria-label="`);
    }
  });

  it("cada ruta tiene su <section> y el enrutador conoce esas siete y ninguna más", () => {
    for (const ruta of RUTAS) {
      expect(HTML).toContain(`id="vista-${ruta}"`);
    }
    const cuerpo = JS.slice(JS.indexOf("var ROUTE_TITLES = {"), JS.indexOf("};", JS.indexOf("var ROUTE_TITLES = {")));
    const claves = [...cuerpo.matchAll(/^\s{4}'?([a-z-]+)'?:/gm)].map((m) => m[1]);
    expect(claves).toEqual([...RUTAS]);
  });

  it("aria-current lo pone y lo quita SÓLO el enrutador: el HTML servido no lo trae puesto para ninguna ruta", () => {
    expect(HTML).not.toContain("aria-current");
    expect(JS_LIMPIO).toContain("navEl.setAttribute('aria-current', 'page')");
    expect(JS_LIMPIO).toContain("navEl.removeAttribute('aria-current')");
  });

  it("los enlaces profundos siguen existiendo: una llamada concreta y un mes concreto", () => {
    expect(JS_LIMPIO).toContain("link.href = '#/llamadas/' + call.callIdHash;");
    expect(JS_LIMPIO).toMatch(/calendarVisibleMonth = \{ year: Number\(mp\[0\]\), month: Number\(mp\[1\]\) \}/);
  });

  it("el enlace de salto sigue siendo el primer elemento del cuerpo y sigue apuntando a un <main> enfocable", () => {
    const cuerpo = HTML.slice(HTML.indexOf("<body>"));
    expect(cuerpo.indexOf('class="tx-skip-link" href="#contenido"')).toBeLessThan(cuerpo.indexOf('class="tx-shell"'));
    const main = /<main[^>]*id="contenido"[^>]*>/.exec(HTML)?.[0] ?? "";
    expect(main).toContain('tabindex="-1"');
    expect(main).toContain("tx-workspace");
  });

  it("ninguna orden de tabulación se adelanta a mano: no hay ni un tabindex positivo", () => {
    const tabindices = [...HTML.matchAll(/tabindex="([^"]+)"/g)].map((m) => m[1]);
    expect(tabindices.length).toBeGreaterThan(0);
    for (const valor of tabindices) expect(Number(valor)).toBeLessThanOrEqual(0);
  });
});

// =====================================================================
// 2. Marca: ni un byte del logotipo, ni un activo de fuera
// =====================================================================

describe("step 21A · la marca es la de siempre y no entra nada de fuera", () => {
  it("el logotipo versionado sigue siendo BYTE A BYTE el mismo fichero que antes del rediseño", () => {
    const bytes = readFileSync(join(process.cwd(), "assets", "brand", "demo-salon-logo.png"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe("2b0ccf5efe108e52990835fcf28be01cb028a827b6871df6c4dbb7f7c2dc88c3");
  });

  it("el rediseño enmarca el logotipo por CSS, sin tocar la imagen ni su texto alternativo", () => {
    expect(HTML).toContain('<img src="/brand/logo.png" alt="Demo Salon Barbershop" width="400" height="400">');
    expect(CSS_LIMPIO).toMatch(/\.tx-brand__plate\s*\{[^}]*max-width: 132px/);
  });

  it("ni el HTML, ni el CSS, ni el JavaScript servidos traen un activo remoto, una fuente externa o un data: URI de imagen", () => {
    for (const [nombre, texto] of [["HTML", HTML], ["CSS", CONSOLE_CSS], ["JS", JS]] as const) {
      expect(texto, `${nombre} contiene http://`).not.toContain("http://");
      expect(texto, `${nombre} contiene https://`).not.toContain("https://");
      expect(texto, `${nombre} contiene @font-face`).not.toContain("@font-face");
      expect(texto, `${nombre} contiene un data: URI`).not.toContain("data:image");
    }
    // La pila tipográfica es la del sistema: ni una familia que haya que descargar.
    expect(CSS_LIMPIO).toMatch(/--tx-font-sans: system-ui/);
  });

  it("los iconos del rediseño son SVG estáticos del HTML: el cliente no crea ni uno (fakeDom no tiene createElementNS)", () => {
    expect((HTML.match(/<svg /g) ?? []).length).toBe(11);
    expect(JS).not.toContain("createElementNS");
    expect(JS).not.toContain("<svg");
    // Y todos van escondidos del árbol de accesibilidad: van AL LADO de texto.
    expect((HTML.match(/<svg /g) ?? []).length).toBe((HTML.match(/aria-hidden="true"><svg /g) ?? []).length);
  });
});

// =====================================================================
// 3. Cabecera honesta: sin identidad falsa, sin campana, sin tendencias
// =====================================================================

describe("step 21A · la cabecera dice la verdad y no promete lo que no hay", () => {
  it("el aviso de demostración está entero, una sola vez, y ninguna regla puede esconderlo", () => {
    expect((HTML.match(/<span class="tx-badge-demo">/g) ?? []).length).toBe(1);
    expect(HTML).toContain('<span class="tx-badge-demo">Demo local · Datos sintéticos · No producción</span>');
    expect(CSS_LIMPIO).not.toMatch(/\.tx-badge-demo[^{]*\{[^}]*display:\s*none/);
  });

  it("el <h1> es el nombre de la ruta, nunca un saludo con nombre: no hay sesión ni usuario detrás (D1)", () => {
    expect(HTML).toContain('<h1 class="tx-topbar__title" id="tx-view-title" tabindex="-1">Inicio</h1>');
    for (const saludo of ["Buenos días", "Buenas tardes", "Bienvenido", "Hola,"]) {
      expect(HTML_LIMPIO.includes(saludo), `'${saludo}' aparece en el HTML servido`).toBe(false);
      expect(JS_LIMPIO.includes(saludo), `'${saludo}' aparece en el JavaScript servido`).toBe(false);
    }
  });

  it("'Bruno' sólo puede aparecer donde la copia es explícitamente de taller o demostración, nunca como usuario de la consola", () => {
    const cabecera = HTML.slice(HTML.indexOf("<header"), HTML.indexOf("</header>"));
    expect(cabecera).not.toContain("Bruno");
    const inicio = HTML.slice(HTML.indexOf('id="vista-inicio"'), HTML.indexOf('id="vista-agenda"'));
    expect(sinComentarios(inicio)).not.toContain("Bruno");
  });

  it("no hay campana, ni avatar, ni ajustes, ni buscador, ni menú de hamburguesa: ninguno tendría destino (D4, D5)", () => {
    const cabecera = sinComentarios(HTML.slice(HTML.indexOf("<header"), HTML.indexOf("</header>")));
    for (const falso of ["notificacion", "campana", "avatar", "perfil", "ajustes", "hamburgues", "buscar"]) {
      expect(cabecera.toLowerCase().includes(falso), `'${falso}' aparece en la barra superior`).toBe(false);
    }
    // Y la barra superior no gana ni un control: sus únicos hijos son textos.
    expect(cabecera).not.toContain("<button");
  });

  it("el estado del asistente habla del sondeo local, nunca de una línea telefónica ni de salud de producción (D6)", () => {
    expect(JS_LIMPIO).toContain("'Asistente sintético · Sin respuesta'");
    expect(JS_LIMPIO).toContain("'Asistente sintético · Respondiendo'");
    for (const mentira of ["Asistente activo", "Operativo", "En producción", "Línea activa"]) {
      expect(JS_LIMPIO.includes(mentira), `'${mentira}' aparece en el JavaScript servido`).toBe(false);
    }
    expect(HTML).toContain("No hay ninguna línea telefónica conectada");
  });

  it("ni la cabecera ni Inicio afirman una tendencia, una comparación con ayer o un ranking: no hay serie histórica detrás (D2)", () => {
    // El barrido se acota a las dos superficies donde el diseño lo prohíbe.
    // Laboratorio SÍ nombra «objetivos o tendencias», y debe seguir
    // haciéndolo: es la frase que EXPLICA por qué esta demostración no los
    // enseña. Prohibirla a ciegas castigaría la copia honesta.
    const cabecera = sinComentarios(HTML.slice(HTML.indexOf("<header"), HTML.indexOf("</header>")));
    const inicio = sinComentarios(HTML.slice(HTML.indexOf('id="vista-inicio"'), HTML.indexOf('id="vista-agenda"')));
    for (const prohibido of ["vs ayer", "vs. ayer", "respecto a ayer", "que ayer", "objetivo", "ranking", "tendencia"]) {
      expect(cabecera.toLowerCase().includes(prohibido), `'${prohibido}' aparece en la barra superior`).toBe(false);
      expect(inicio.toLowerCase().includes(prohibido), `'${prohibido}' aparece en Inicio`).toBe(false);
      expect(JS_LIMPIO.toLowerCase().includes(prohibido), `'${prohibido}' aparece en el JavaScript servido`).toBe(false);
    }
  });

  it("ninguna región viva nueva: la frescura no es aria-live, el reloj sintético tampoco, y la de conexión sigue siendo una", () => {
    const frescura = /<p class="tx-freshness" id="tx-freshness"[^>]*>/.exec(HTML)?.[0] ?? "";
    expect(frescura).not.toContain("aria-live");
    const reloj = /<p class="tx-synthetic-clock" id="tx-reloj-sintetico"[^>]*>/.exec(HTML)?.[0] ?? "";
    expect(reloj).not.toContain("aria-live");
    const cabecera = sinComentarios(HTML.slice(HTML.indexOf("<header"), HTML.indexOf("</header>")));
    expect((cabecera.match(/aria-live/g) ?? []).length).toBe(1);
    expect(cabecera).toContain('id="tx-conexion-anuncio" role="status" aria-live="polite"');
  });
});

// =====================================================================
// 4. Las cuatro cifras canónicas y sus destinos reales
// =====================================================================

describe("step 21A · las cuatro cifras de Inicio conservan definición y destino", () => {
  const inicio = HTML.slice(HTML.indexOf('id="vista-inicio"'), HTML.indexOf('id="vista-agenda"'));

  it("son cuatro tarjetas, con los cuatro rótulos de siempre y en el mismo orden", () => {
    expect((inicio.match(/class="tx-stat"/g) ?? []).length).toBe(4);
    const rotulos = [...inicio.matchAll(/<span class="tx-stat__label">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(rotulos).toEqual([
      "Llamadas atendidas hoy",
      "Resueltas sin molestar a nadie",
      "Reservas creadas hoy",
      "Errores técnicos",
    ]);
  });

  it("las tres que son enlace llevan a una ruta real de la consola, y la cuarta no finge serlo", () => {
    expect(inicio).toContain('<a class="tx-stat" href="#/llamadas" id="kpi-resueltas">');
    expect(inicio).toContain('<a class="tx-stat" href="#/agenda" id="kpi-reservas">');
    expect(inicio).toContain('<a class="tx-stat" href="#/llamadas" id="kpi-errores">');
    // La de llamadas atendidas es un <div>: su matiz dice «Simuladas», no un destino.
    expect(inicio).toContain('<div class="tx-stat" id="kpi-llamadas">');
    expect(inicio).toContain('<span class="tx-stat__hint">Simuladas</span>');
  });

  it("cada cifra sigue leyendo su campo canónico del snapshot, ni uno derivado en el navegador", () => {
    expect(JS_LIMPIO).toContain("byId('kpi-llamadas-valor').textContent = String(m.callsHandled);");
    expect(JS_LIMPIO).toContain("statForValue(m.resolvedWithoutHumanInterruption, m.callsWithOutcome)");
    expect(JS_LIMPIO).toContain("byId('kpi-reservas-valor').textContent = String(m.bookingsCreated);");
    expect(JS_LIMPIO).toContain("String(m.technicalErrors)");
  });

  it("las inasistencias siguen siendo una línea neutra y condicional, no una quinta cifra (K14)", () => {
    expect(inicio).toContain('id="inicio-inasistencias" hidden');
    expect(JS_LIMPIO).toContain("snap.operations.metrics.homeLine");
    expect(JS_LIMPIO).toContain("setHidden(lineaInasistencias, !frase);");
    const gridInicio = inicio.slice(inicio.indexOf('class="tx-stat-grid"'), inicio.indexOf('class="tx-col-8'));
    expect(gridInicio).not.toContain("inasistencia");
  });
});

// =====================================================================
// 5. Estructura semántica: encabezados, regiones y secciones rotuladas
// =====================================================================

describe("step 21A · la estructura semántica no se toca", () => {
  it("hay un solo <h1> en toda la página, y es el título de la vista", () => {
    expect((HTML.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(HTML).toContain('id="tx-view-title"');
  });

  it("las tres regiones de referencia están y son únicas: banner, navegación rotulada y main", () => {
    expect((HTML_LIMPIO.match(/<header[\s>]/g) ?? []).length).toBe(1);
    expect((HTML_LIMPIO.match(/<nav[\s>]/g) ?? []).length).toBe(1);
    expect((HTML_LIMPIO.match(/<main[\s>]/g) ?? []).length).toBe(1);
    expect(HTML).toContain('<nav class="tx-sidebar" aria-label="Secciones de la consola">');
  });

  it("cada <section> de contenido va rotulada por su encabezado: ninguna región anónima", () => {
    const secciones = [...HTML.matchAll(/<section[^>]*>/g)].map((m) => m[0]);
    expect(secciones.length).toBeGreaterThan(7);
    for (const s of secciones) {
      const esVista = /id="vista-[a-z-]+"/.test(s);
      expect(esVista || s.includes("aria-labelledby"), `sección sin rótulo: ${s}`).toBe(true);
    }
  });

  it("ningún encabezado se salta un nivel dentro de Inicio: <h2> de panel, y el <h3> vive DENTRO de un panel", () => {
    const inicio = sinComentarios(HTML.slice(HTML.indexOf('id="vista-inicio"'), HTML.indexOf('id="vista-agenda"')));
    expect((inicio.match(/<h1[\s>]/g) ?? []).length).toBe(0);
    // (step 23 §8.2) Seis paneles: el sexto es la actividad operativa.
    expect((inicio.match(/<h2[\s>]/g) ?? []).length).toBe(6);
    // (step 23 §8.1) Y UN <h3>, el de las propuestas pendientes. No se salta
    // ningún nivel: va dentro de `#panel-atencion`, DESPUÉS de su <h2>. Se
    // comprueba la posición, no sólo el recuento — un <h3> suelto antes del
    // primer <h2> pasaría un recuento y rompería el árbol igual.
    const h3 = [...inicio.matchAll(/<h3[\s>]/g)];
    expect(h3.length).toBe(1);
    const posH3 = h3[0]!.index!;
    const panel = inicio.indexOf('id="panel-atencion"');
    const h2DelPanel = inicio.indexOf("<h2", panel);
    const finDelPanel = inicio.indexOf("</section>", panel);
    expect(panel).toBeGreaterThan(-1);
    expect(posH3).toBeGreaterThan(h2DelPanel);
    expect(posH3).toBeLessThan(finDelPanel);
  });

  it("el atributo hidden sigue siendo el único interruptor del enrutador, y esconde de verdad", () => {
    for (const ruta of RUTAS) {
      expect(HTML).toContain(`<section id="vista-${ruta}" class="tx-view" hidden>`);
    }
    expect(CSS_LIMPIO).toMatch(/\[hidden\]\s*\{[^}]*display: none !important/);
  });
});

// =====================================================================
// 6. La capa de alias: resuelve entera y no deja nada suelto
// =====================================================================

describe("step 21A · la capa de alias semánticos (§2.1)", () => {
  const definidos = new Set([...CONSOLE_CSS.matchAll(/^\s*(--tx-[a-z0-9-]+):/gm)].map((m) => m[1]));
  const usados = new Set([...CONSOLE_CSS.matchAll(/var\((--tx-[a-z0-9-]+)\)/g)].map((m) => m[1]));

  it("todo token que se usa está definido: ni una referencia rota que el navegador resolvería a nada", () => {
    const rotos = [...usados].filter((u) => !definidos.has(u));
    expect(rotos).toEqual([]);
  });

  it("los alias del diseño existen todos y apuntan al token crudo que la tabla §2.1 declara", () => {
    const esperados: Record<string, string> = {
      "--tx-canvas": "var(--tx-ivory-50)",
      "--tx-panel-bg": "var(--tx-surface)",
      "--tx-panel-bg-quiet": "var(--tx-surface-alt)",
      "--tx-notice-bg": "var(--tx-sand-100)",
      "--tx-text-strong": "var(--tx-ink-900)",
      "--tx-text-body": "var(--tx-ink-700)",
      "--tx-text-muted": "var(--tx-ink-500)",
      "--tx-text-on-accent": "#FFFFFF",
      "--tx-text-on-dark": "var(--tx-sidebar-text)",
      "--tx-text-on-dark-muted": "var(--tx-sidebar-muted)",
      "--tx-divider": "var(--tx-line)",
      "--tx-divider-strong": "var(--tx-line-strong)",
      "--tx-action": "var(--tx-copper-700)",
      "--tx-action-strong": "var(--tx-copper-800)",
      "--tx-action-mark": "var(--tx-copper-500)",
      "--tx-action-bg": "var(--tx-copper-50)",
      "--tx-status-ok": "var(--tx-green-700)",
      "--tx-status-ok-bg": "var(--tx-green-50)",
      "--tx-status-warn": "var(--tx-amber-800)",
      "--tx-status-warn-bg": "var(--tx-amber-50)",
      "--tx-status-error": "var(--tx-red-700)",
      "--tx-status-error-bg": "var(--tx-red-50)",
      "--tx-status-neutral": "var(--tx-neutral-700)",
      "--tx-status-neutral-bg": "var(--tx-neutral-50)",
    };
    for (const [alias, destino] of Object.entries(esperados)) {
      const regla = new RegExp(`${alias}:\\s*${destino.replace(/[()\-]/g, "\\$&")};`);
      expect(regla.test(CONSOLE_CSS), `${alias} ya no apunta a ${destino}`).toBe(true);
    }
  });

  it("el ÚNICO valor nuevo del rediseño es el cobre oscuro del hover, y es el que usa el botón primario", () => {
    expect(CONSOLE_CSS).toContain("--tx-copper-800:   #74401F;");
    expect(CSS_LIMPIO).toMatch(/\.tx-btn--primary:hover[^{]*\{[^}]*background: var\(--tx-action-strong\)/);
  });

  it("ningún alias se queda sin usar: la capa es la que visten los componentes, no una lista de deseos", () => {
    const alias = [...definidos].filter((d) => /^--tx-(canvas|panel-bg|notice-bg|text-|divider|action|status-)/.test(d));
    expect(alias.length).toBeGreaterThanOrEqual(24);
    const huerfanos = alias.filter((a) => !usados.has(a));
    expect(huerfanos).toEqual([]);
  });

  it("los tokens crudos conservan nombre y valor: no se ha renombrado ni uno solo", () => {
    for (const crudo of [
      "--tx-ink-900:      #171615;",
      "--tx-ivory-50:     #F5F1E8;",
      "--tx-surface:      #FFFFFF;",
      "--tx-copper-700:   #8F4F2A;",
      "--tx-line-strong:  #7E766A;",
      "--tx-sidebar-bg:      #171615;",
    ]) {
      expect(CONSOLE_CSS).toContain(crudo);
    }
  });
});

// =====================================================================
// 7. Reglas duras de la hoja de estilos
// =====================================================================

describe("step 21A · las reglas duras de la hoja de estilos", () => {
  it("un solo tema claro: ni prefers-color-scheme ni color-scheme, ni siquiera de cortesía", () => {
    expect(CSS_LIMPIO).not.toContain("prefers-color-scheme");
    expect(CSS_LIMPIO).not.toContain("color-scheme");
  });

  it("el foco no se apaga en ningún sitio, y toda regla con sombra propia sobre un enfocable repone el halo", () => {
    expect(CSS_LIMPIO).not.toMatch(/outline\s*:\s*none/);
    expect(CSS_LIMPIO).not.toMatch(/outline\s*:\s*0(\s|;)/);
    const reglas = [...CONSOLE_CSS.matchAll(/([^\n{}]*:focus-visible[^\n{}]*)\{([^}]*)\}/g)];
    expect(reglas.length).toBeGreaterThan(0);
    for (const [, selector, cuerpo] of reglas) {
      if (!cuerpo.includes("box-shadow")) continue;
      expect(cuerpo, `${selector.trim()} pisa el halo`).toContain("var(--tx-focus-halo)");
    }
  });

  // (M25) Esta prueba decía "cero puntos de corte nuevos" y valía 5 @media.
  // Ahora son 6. El corte añadido NO es decorativo: separa el modo de
  // NAVEGACIÓN (raíl de iconos, ahora a ≤1119) de la densidad de CONTENIDO
  // (columnas 8/4 apiladas, que se queda a ≤1279). Juntarlos era la causa de
  // que 15 px de barra de scroll replegaran la barra lateral sola al navegar
  // — ver la nota de §4.5 en ui.css.ts y (internal doc, not included in the template). El listado sigue
  // siendo CERRADO a propósito: un corte nuevo obliga a comprobar A MANO un
  // estado más, así que añadir otro debe seguir costando cambiar esta prueba.
  it("los puntos de corte son exactamente los seis previstos, ni uno más", () => {
    expect([...CSS_LIMPIO.matchAll(/@media/g)].length).toBe(6);
    for (const ancho of [1439, 1279, 1119, 1023, 720]) {
      expect(CSS_LIMPIO).toContain(`@media (max-width: ${String(ancho)}px)`);
    }
    expect(CSS_LIMPIO).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("el rediseño no añade ninguna animación decorativa, y el bloque de movimiento reducido sigue anulándolo todo", () => {
    expect(CSS_LIMPIO).not.toContain("@keyframes");
    expect(CSS_LIMPIO).not.toMatch(/animation-name\s*:/);
    const bloque = CSS_LIMPIO.slice(CSS_LIMPIO.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(bloque).toContain("transition-duration: 0ms !important");
    expect(bloque).toContain("animation-duration: 0ms !important");
  });

  it("las únicas anchuras fijas en píxeles son las que el diseño ancla; ningún contenedor de contenido estrena una", () => {
    const anchuras = [...CSS_LIMPIO.matchAll(/(?:^|[;{\s])(?:max-|min-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    const permitidas = new Set([1, 3, 8, 10, 20, 40, 76, 88, 132, 200, 216, 640, 880, 1000, 1176]);
    for (const px of anchuras) {
      expect(permitidas.has(px), `anchura fija no prevista: ${String(px)}px`).toBe(true);
    }
    // Y las cuatro que el diseño ancla por prueba siguen literalmente escritas.
    expect(CONSOLE_CSS).toContain("flex: 0 0 216px");
    expect(CONSOLE_CSS).toContain("max-width: 132px");
    expect(CONSOLE_CSS).toContain("max-width: 1176px");
  });

  it("el desplazamiento horizontal sólo se permite donde el diseño lo permite: la rejilla del mes y la navegación", () => {
    const conScrollX = [...CSS_LIMPIO.matchAll(/([^{}]*)\{[^}]*overflow-x:\s*auto[^}]*\}/g)].map((m) => m[1].trim());
    expect(conScrollX.sort()).toEqual([".tx-sidebar", ".tx-table-scroll"]);
    expect(CSS_LIMPIO).toMatch(/\.tx-month-grid \{ min-width: 640px/);
  });

  it("por debajo de 720px las tablas se apilan con el rótulo por attr(data-label), nunca con texto inyectado", () => {
    const bloque720 = CSS_LIMPIO.slice(CSS_LIMPIO.indexOf("@media (max-width: 720px)"));
    expect(bloque720).toContain("content: attr(data-label)");
    expect(bloque720).not.toMatch(/content:\s*'[^']{3,}'/);
  });
});

// =====================================================================
// 8. El taller de decisiones de step 20, intacto tras el cambio de ropa
// =====================================================================

describe("step 21A · el taller de step 20 sigue entero después del rediseño", () => {
  const laboratorio = HTML.slice(HTML.indexOf('id="vista-laboratorio"'));

  it("los controles del taller siguen todos ahí, con sus identificadores exactos", () => {
    for (const id of [
      "tx-taller-filtro-todas",
      "tx-taller-filtro-bloquean",
      "tx-taller-filtro-esperan",
      "tx-taller-filtro-sin-respuesta",
      "tx-taller-filtro-anotadas",
      "tx-taller-buscar",
      "tx-taller-estado",
      "tx-taller-cobertura",
      "tx-taller-lista",
      "tx-taller-vacio",
      "tx-taller-copiar-acta",
      "tx-taller-acta-estado",
      "tx-taller-acta-respaldo",
      "tx-taller-copiar-mision",
      "tx-taller-mision-estado",
      "tx-taller-mision-respaldo",
      "tx-taller-borrar-todo",
      "dialogo-taller-borrar",
    ]) {
      expect(laboratorio, `falta #${id}`).toContain(`id="${id}"`);
    }
  });

  it("los cinco filtros siguen siendo botones con aria-pressed dentro de su grupo rotulado", () => {
    const grupo = laboratorio.slice(laboratorio.indexOf("tx-taller-filtro-todas") - 400);
    expect(grupo).toContain('role="group"');
    expect((laboratorio.match(/id="tx-taller-filtro-[a-z-]+"/g) ?? []).length).toBe(5);
    for (const m of laboratorio.matchAll(/<button[^>]*id="tx-taller-filtro-[a-z-]+"[^>]*>/g)) {
      expect(m[0]).toContain("aria-pressed");
    }
  });

  it("la única región viva del panel sigue siendo la de estado, y sigue siendo enfocable por programa", () => {
    const estado = /<p[^>]*id="tx-taller-estado"[^>]*>/.exec(laboratorio)?.[0] ?? "";
    expect(estado).toContain('role="status"');
    expect(estado).toContain('aria-live="polite"');
    expect(estado).toContain('tabindex="-1"');
    // La cobertura NO es región viva: se repinta con cada radio que se marca.
    const cobertura = /<p[^>]*id="tx-taller-cobertura"[^>]*>/.exec(laboratorio)?.[0] ?? "";
    expect(cobertura).not.toContain("aria-live");
  });

  it("(I20-5) el rediseño no ha colado ni un selector que distinga una opción de otra dentro de una tarjeta", () => {
    expect(CSS_LIMPIO).not.toMatch(/tx-taller[^{]*:first-child/);
    expect(CSS_LIMPIO).not.toMatch(/tx-taller[^{]*:last-child/);
    expect(CSS_LIMPIO).not.toMatch(/tx-taller[^{]*:nth-child/);
    expect(CSS_LIMPIO).not.toMatch(/tx-taller[^{]*\[value=/);
    expect(CSS_LIMPIO).not.toMatch(/tx-taller[^{]*\[data-key=/);
    expect(CSS_LIMPIO).not.toMatch(/tx-taller[^{]*:checked/);
  });

  it("ninguna regla del rediseño esconde una pieza del taller para 'ganar sitio'", () => {
    for (const clase of [
      "tx-taller-card",
      "tx-taller-card__opciones",
      "tx-taller-card__hoy",
      "tx-taller-nota",
      "tx-taller-nota__campo",
      "tx-taller-urgencia",
      "tx-taller-bloque",
    ]) {
      expect(CSS_LIMPIO, `${clase} se esconde en alguna regla`).not.toMatch(
        new RegExp(`\\.${clase}[^{]*\\{[^}]*display:\\s*none`),
      );
    }
  });

  it("el panel sigue siendo de una sola columna a las cinco anchuras: ninguna rejilla nueva y ningún @media propio", () => {
    const inicioTaller = CONSOLE_CSS.indexOf("step 20 §6.3 — Taller de decisiones con Bruno");
    const seccion = sinComentarios(CONSOLE_CSS.slice(inicioTaller, CONSOLE_CSS.indexOf("4.5 Breakpoints", inicioTaller)));
    expect(inicioTaller).toBeGreaterThan(-1);
    expect(seccion).not.toContain("grid-template-columns");
    expect(seccion).not.toContain("@media");
  });
});

// =====================================================================
// 9. Adopción cruzada: cada ruta conserva sus controles
// =====================================================================

describe("step 21A · la adopción visual no se ha llevado por delante ningún control", () => {
  // (step 26 §10) Los tres botones de rango (Hoy/Mañana/Próximos 7 días)
  // se RETIRAN a propósito: su capacidad la absorben anterior/Hoy/siguiente
  // sobre la fecha ancla, y el selector de vista gana Día/Semana/Mes/Lista.
  it("Agenda tiene el selector de vista Día/Semana/Mes/Lista, la navegación por fecha, su filtro y el explorador de huecos", () => {
    const agenda = HTML.slice(HTML.indexOf('id="vista-agenda"'), HTML.indexOf('id="vista-lista-espera"'));
    for (const id of [
      "agenda-vista-dia",
      "agenda-vista-semana",
      "agenda-vista-mes",
      "agenda-vista-lista",
      "agenda-anterior",
      "agenda-hoy",
      "agenda-siguiente",
      "agenda-filtro-profesional",
      "agenda-titulo-rango",
      "agenda-aviso-ruta",
      "agenda-rejilla",
      "agenda-semana-resumen",
      "agenda-mes",
      "huecos-panel",
      "huecos-servicio",
      "huecos-profesional",
    ]) {
      expect(agenda, `falta #${id} en Agenda`).toContain(`id="${id}"`);
    }
    for (const id of ["agenda-filtro-hoy", "agenda-filtro-manana", "agenda-filtro-semana"]) {
      expect(agenda, `#${id} debería haberse retirado`).not.toContain(`id="${id}"`);
    }
    for (const m of agenda.matchAll(/<button[^>]*id="agenda-vista-(dia|semana|mes|lista)"[^>]*>/g)) {
      expect(m[0]).toContain("aria-pressed");
    }
  });

  // (step 26 REAPERTURA §R4) La jerarquía de Agenda: controles → fecha/rango
  // y avisos → rejilla/lista → herramientas secundarias. El panel de huecos
  // BAJA (revierte conscientemente step 19 §3 en cuanto al orden, §1.2 S2 del
  // normativo de reapertura) y se pliega. Las tres pruebas son
  // DISCRIMINANTES contra `7ad0c6d`: hoy el panel se lee antes de la rejilla
  // y es una `<section>` desplegada.
  it("R4 — la rejilla y la lista de Agenda se leen ANTES del panel de huecos", () => {
    const agenda = HTML.slice(HTML.indexOf('id="vista-agenda"'), HTML.indexOf('id="vista-lista-espera"'));
    const rejilla = agenda.indexOf('id="agenda-rejilla"');
    const huecos = agenda.indexOf('id="huecos-panel"');
    expect(rejilla).toBeGreaterThan(-1);
    expect(huecos).toBeGreaterThan(-1);
    expect(rejilla).toBeLessThan(huecos);
    // El orden completo de los cuatro niveles, de arriba abajo.
    const orden = [
      "tx-controls tx-panel",
      'id="agenda-aviso-ruta"',
      'id="agenda-titulo-rango"',
      'id="agenda-rejilla"',
      'id="agenda-semana-resumen"',
      'id="agenda-mes"',
      'id="agenda-dias"',
      'id="agenda-vacio"',
      'id="huecos-panel"',
    ];
    const posiciones = orden.map((marca) => agenda.indexOf(marca));
    for (const [i, pos] of posiciones.entries()) {
      expect(pos, `falta la marca ${orden[i]} en Agenda`).toBeGreaterThan(-1);
      if (i > 0) expect(pos, `${orden[i]} tiene que ir después de ${orden[i - 1]}`).toBeGreaterThan(posiciones[i - 1]!);
    }
  });

  it("R4 — #huecos-panel es un <details> plegado por defecto, con su <summary id=\"tit-huecos\">", () => {
    const agenda = HTML.slice(HTML.indexOf('id="vista-agenda"'), HTML.indexOf('id="vista-lista-espera"'));
    const etiqueta = /<[a-z]+[^>]*id="huecos-panel"[^>]*>/.exec(agenda)?.[0] ?? "";
    expect(etiqueta.startsWith("<details")).toBe(true);
    // Nace PLEGADO: ningún atributo `open`.
    expect(etiqueta).not.toMatch(/\sopen(\s|>|=)/);
    // El <summary> nombra la región, así que el aria-labelledby ya no hace falta.
    expect(etiqueta).not.toContain("aria-labelledby");
    expect(agenda).toContain('<summary id="tit-huecos">Comprobar huecos sintéticos</summary>');
    expect(agenda).not.toContain('<h2 id="tit-huecos">');
  });

  it("R4 — el HTML documenta la reversión consciente de step 19 §3", () => {
    const agenda = HTML.slice(HTML.indexOf('id="vista-agenda"'), HTML.indexOf('id="vista-lista-espera"'));
    expect(agenda).toContain("REVIERTE CONSCIENTEMENTE step 19");
    expect(agenda).toContain("04-normativo-");
    // Lo que NO se deroga sigue escrito donde vive el panel.
    expect(agenda).toContain("panel EN LÍNEA");
  });

  it("R4 — «Crear cita manual» y «Nueva reserva para varias personas» siguen en los controles, sin plegar", () => {
    const agenda = HTML.slice(HTML.indexOf('id="vista-agenda"'), HTML.indexOf('id="vista-lista-espera"'));
    const controles = agenda.slice(agenda.indexOf('class="tx-controls tx-panel"'), agenda.indexOf('id="agenda-aviso-ruta"'));
    expect(controles).toContain('id="btn-abrir-cita-manual"');
    expect(controles).toContain('id="btn-abrir-grupo"');
    expect(agenda.indexOf('id="btn-abrir-cita-manual"')).toBeLessThan(agenda.indexOf('id="huecos-panel"'));
  });

  it("Lista de espera conserva su filtro, su plazo, su tabla apilable y su detalle técnico", () => {
    const espera = HTML.slice(HTML.indexOf('id="vista-lista-espera"'), HTML.indexOf('id="vista-llamadas"'));
    expect(espera).toContain('id="le-filtro-estado"');
    expect(espera).toContain('id="le-plazo-select"');
    expect(espera).toContain('class="tx-table tx-table--stack"');
    expect(espera).toContain('class="tx-details"');
    // Los rótulos del modo tarjeta los pone el cliente celda a celda, con
    // setAttribute: la regla de ::before los lee con attr(data-label).
    expect(JS_LIMPIO).toContain("td.setAttribute('data-label', rotulo);");
  });

  it("Llamadas conserva su tabla apilable y el panel de detalle que nace oculto y devuelve el foco", () => {
    const llamadas = HTML.slice(HTML.indexOf('id="vista-llamadas"'), HTML.indexOf('id="vista-horarios-y-ausencias"'));
    expect(llamadas).toContain('class="tx-table tx-table--stack"');
    const detalle = /<article[^>]*id="llamada-detalle"[^>]*>/.exec(llamadas)?.[0] ?? "";
    expect(detalle).toMatch(/\shidden(\s|>)/);
    expect(llamadas).toMatch(/id="llamada-detalle-titulo"[^>]*tabindex="-1"/);
    expect(JS_LIMPIO).toContain("var a = el('a', 'tx-row-link', 'Ver');");
    expect(JS_LIMPIO).toContain("byId('llamada-detalle-cerrar').addEventListener('click', closeCallDetail);");
  });

  it("Horarios y ausencias conserva su rejilla, su contenedor de desplazamiento y el botón de día especial", () => {
    const calendario = HTML.slice(HTML.indexOf('id="vista-horarios-y-ausencias"'), HTML.indexOf('id="vista-equipo"'));
    expect(calendario).toContain('id="calendario-grid"');
    expect(calendario).toContain('id="btn-abrir-dia-especial"');
    expect(calendario).toContain("tx-table-scroll");
    expect(CSS_LIMPIO).toMatch(/\.tx-day-cell--today \{ border: 2px solid var\(--tx-ink-900\); \}/);
  });

  it("Equipo se pinta sólo con createElement y textContent: es el caso de referencia del DOM falso", () => {
    const cuerpo = JS.slice(JS.indexOf("function renderEquipo("), JS.indexOf("function renderLaboratorio("));
    expect(cuerpo.length).toBeGreaterThan(0);
    expect(cuerpo).not.toContain("innerHTML");
    expect(cuerpo).not.toContain("createElementNS");
    expect(cuerpo).not.toContain(".style.");
  });

  it("Laboratorio conserva sus diálogos, su formulario de escenario y su zona peligrosa apartada", () => {
    const laboratorio = HTML.slice(HTML.indexOf('id="vista-laboratorio"'));
    expect(laboratorio).toContain('id="form-escenario"');
    expect((HTML.match(/<dialog /g) ?? []).length).toBeGreaterThanOrEqual(9);
    expect(HTML).toContain("tx-danger-zone");
    expect(CSS_LIMPIO).toMatch(/\.tx-danger-zone \{[^}]*border-color: var\(--tx-status-error\)/);
  });
});

// =====================================================================
// 10. (revisión adversarial F4, H4 y H5) Los dos únicos pares de contraste
//     que la revisión dejó por debajo de su umbral. Ninguno era un
//     incumplimiento formal —un control inactivo está exento de 1.4.3, y un
//     filete decorativo no es un componente de 1.4.11—, pero los dos eran
//     el único sitio donde la consola pedía al ojo algo que no le daba.
//     Aquí no se comprueba una cadena de color concreta: se CALCULA el
//     contraste con la fórmula de WCAG 2.1 sobre los tokens que la hoja de
//     estilos declara de verdad, así que el candado sobrevive a un cambio
//     de paleta.
// =====================================================================

/** Luminancia relativa (WCAG 2.1, §relative luminance) de un #RRGGBB. */
function luminancia(hex: string): number {
  const canales = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * canales[0] + 0.7152 * canales[1] + 0.0722 * canales[2];
}

/** Razón de contraste entre dos colores opacos en notación #RRGGBB. */
function contraste(a: string, b: string): number {
  const la = luminancia(a);
  const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Resuelve un token hasta su valor literal, siguiendo la cadena de alias.
 * Se lee del CSS SIN comentarios: un valor citado dentro de una explicación
 * no puede hacerse pasar por la declaración de verdad.
 */
function valorDeToken(nombre: string): string {
  let actual = nombre;
  for (let salto = 0; salto < 5; salto += 1) {
    const encontrado = new RegExp(`${actual}:\\s*([^;]+);`).exec(CSS_LIMPIO);
    if (!encontrado) throw new Error(`token sin declarar: ${actual}`);
    const valor = encontrado[1].trim();
    const alias = /^var\((--tx-[a-z0-9-]+)\)$/.exec(valor);
    if (!alias) return valor;
    actual = alias[1];
  }
  throw new Error(`cadena de alias sin fondo: ${nombre}`);
}

describe("step 21A · los dos contrastes de la revisión adversarial (H4 y H5)", () => {
  it("(H5) el filete que separa Laboratorio del resto de la barra llega a 3:1 sobre el negro cálido, que a ≤1279px es la única señal visual que queda", () => {
    expect(contraste(valorDeToken("--tx-sidebar-line"), valorDeToken("--tx-sidebar-bg"))).toBeGreaterThanOrEqual(3);
    // Y sigue siendo ESE filete el que separa, en las dos orientaciones de la barra.
    expect(CSS_LIMPIO).toMatch(/\.tx-nav__list--tools \{[^}]*border-top: 1px solid var\(--tx-sidebar-line\)/);
    const bloque1023 = CSS_LIMPIO.slice(CSS_LIMPIO.indexOf("@media (max-width: 1023px)"));
    expect(bloque1023).toContain("border-left: 1px solid var(--tx-sidebar-line)");
  });

  it("(H4) un botón inactivo NO se dice bajando la opacidad: lleva superficie y texto propios, legibles y claramente apagados", () => {
    const regla = /\.tx-btn:disabled \{([^}]*)\}/.exec(CSS_LIMPIO);
    expect(regla, "la regla del botón inactivo ha desaparecido").not.toBeNull();
    const cuerpo = regla?.[1] ?? "";
    // Con opacity el color efectivo era el de la mezcla con lo que hubiera
    // debajo: incalculable desde la hoja de estilos, y en el primario 2,46:1.
    expect(cuerpo).not.toContain("opacity");
    expect(cuerpo).toContain("cursor: not-allowed");
    expect(cuerpo).toContain("background: var(--tx-panel-bg-quiet)");
    expect(cuerpo).toContain("color: var(--tx-text-disabled)");
    expect(contraste(valorDeToken("--tx-text-disabled"), valorDeToken("--tx-panel-bg-quiet"))).toBeGreaterThanOrEqual(3);
    // Y no puede parecer que se pueda pulsar: ni el cobre de la acción, ni el
    // rojo de la zona peligrosa, ni el blanco sobre acento.
    for (const activo of ["--tx-action", "--tx-status-error", "--tx-text-on-accent"]) {
      expect(cuerpo).not.toContain(`var(${activo})`);
    }
  });
});

// =====================================================================
// 11. step 26 §8/§14 (A13) — el contraste de la paleta de IDENTIDAD DE
//     PERSONA de la Agenda. Reparación adversarial: esta era la única
//     decisión de color de step 26 sin candado de prueba. Misma fórmula
//     WCAG de la casa (arriba), sobre los tokens tal y como los resuelve
//     `valorDeToken` — nunca un hex citado a mano, para que el candado
//     sobreviva a un cambio de paleta.
// =====================================================================

describe("step 26 · A13 — contraste de los tres tintes de identidad de profesional", () => {
  const TINTES = ["--tx-identity-1-bg", "--tx-identity-2-bg", "--tx-identity-3-bg"] as const;

  it("--tx-text-strong y --tx-text-body llegan a 4,5:1 sobre los tres tintes", () => {
    for (const tinte of TINTES) {
      expect(contraste(valorDeToken("--tx-text-strong"), valorDeToken(tinte)), `--tx-text-strong sobre ${tinte}`).toBeGreaterThanOrEqual(4.5);
      expect(contraste(valorDeToken("--tx-text-body"), valorDeToken(tinte)), `--tx-text-body sobre ${tinte}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("el borde --tx-divider-strong del bloque llega a 3:1 sobre los tres tintes (decisión 6.4: el borde delimita el bloque aunque el tinte sea muy claro)", () => {
    for (const tinte of TINTES) {
      expect(contraste(valorDeToken("--tx-divider-strong"), valorDeToken(tinte)), `--tx-divider-strong sobre ${tinte}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("los tres tintes de identidad son exactamente los que declara la decisión 8: dos valores nuevos y --tx-sand-100 reutilizado", () => {
    expect(valorDeToken("--tx-identity-1-bg")).toBe(valorDeToken("--tx-sand-100"));
    expect(CSS_LIMPIO).toContain("--tx-slate-50:     #E6ECF2;");
    expect(CSS_LIMPIO).toContain("--tx-plum-50:      #F0E7EF;");
  });
});
