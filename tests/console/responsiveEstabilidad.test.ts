import { describe, it, expect } from "vitest";

import { CONSOLE_CSS } from "../../src/console/ui.css.js";
import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";

/**
 * M25 — estabilidad responsive de la barra lateral en Safari/WebKit.
 *
 * EL FALLO QUE ESTO IMPIDE QUE VUELVA
 * -----------------------------------
 * Con Safari maximizado y SIN tocar el zoom, al navegar entre rutas del panel
 * la barra lateral cambiaba sola: en `Llamadas` salía expandida (logotipo y
 * etiquetas) y en `Inicio` se replegaba a raíl de iconos.
 *
 * La causa, medida en WebKit 26.5, no supuesta:
 *
 *   1. Cuando macOS usa barras de desplazamiento CLÁSICAS (ajuste "siempre",
 *      o automático con un ratón conectado), la barra vertical del documento
 *      OCUPA sitio: documentElement.clientWidth queda ~15 px por debajo de
 *      window.innerWidth.
 *   2. Las media queries se evalúan contra clientWidth, NO contra innerWidth.
 *      Comprobado a ventana fija de 1290 px: página corta -> clientWidth 1290
 *      y (max-width: 1279px) NO casa; página larga -> clientWidth 1275 y SÍ
 *      casa.
 *   3. De las siete rutas, `llamadas` era la única que no desbordaba en
 *      vertical. Así que navegar Llamadas -> Inicio cambiaba el ancho útil en
 *      15 px sin tocar la ventana, y eso cruzaba el corte de 1279.
 *
 * QUÉ COMPRUEBA ESTE FICHERO
 * --------------------------
 * No es una prueba de píxeles: en esta suite no hay navegador (decisión de
 * misión, ver `tests/console/fakeDom.ts`). Pero tampoco se limita a buscar
 * cadenas: abajo se MODELA la cascada de la hoja servida —se leen de verdad
 * los bloques @media y se resuelven las declaraciones que deciden el modo de
 * navegación— y se afirma el MODO RESULTANTE a cada anchura, incluida la
 * regla de WebKit del punto 2.
 *
 * La comprobación en Safari de verdad la firma el owner a mano: ver
 * (internal doc, not included in the template). Aquí se demuestra el modelo, no el píxel.
 */

const HTML = renderConsoleHtml(4310);
const JS = renderConsoleAppJs();

function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, "");
}

const CSS = sinComentarios(CONSOLE_CSS);

// ---------------------------------------------------------------------
// Un modelo mínimo de la cascada, leído de la hoja REAL
// ---------------------------------------------------------------------

interface Bloque {
  /** `null` = reglas base, fuera de todo @media. */
  readonly maxWidth: number | null;
  readonly cuerpo: string;
}

/** Trocea la hoja en bloques base + @media (max-width: Npx), en orden. */
function trocear(css: string): Bloque[] {
  const bloques: Bloque[] = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let ultimoFin = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    bloques.push({ maxWidth: null, cuerpo: css.slice(ultimoFin, m.index) });
    // Equilibrado de llaves: el cuerpo de un @media contiene reglas anidadas.
    let profundidad = 1;
    let i = re.lastIndex;
    while (i < css.length && profundidad > 0) {
      if (css[i] === "{") profundidad++;
      else if (css[i] === "}") profundidad--;
      i++;
    }
    bloques.push({ maxWidth: Number(m[1]), cuerpo: css.slice(re.lastIndex, i - 1) });
    ultimoFin = i;
    re.lastIndex = i;
  }
  bloques.push({ maxWidth: null, cuerpo: css.slice(ultimoFin) });
  return bloques;
}

const BLOQUES = trocear(CSS);

/**
 * Última declaración `propiedad` que gana para `selector` a la anchura dada.
 * Modela lo que importa aquí: misma especificidad en todos estos selectores,
 * así que manda el orden de aparición y sólo cuentan los @media que casan.
 */
function declaracionGanadora(selector: string, propiedad: string, anchura: number): string | null {
  let ganadora: string | null = null;
  for (const bloque of BLOQUES) {
    if (bloque.maxWidth !== null && anchura > bloque.maxWidth) continue;
    const reglas = [...bloque.cuerpo.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const [, selectores, cuerpo] of reglas) {
      const lista = selectores.split(",").map((s) => s.trim());
      if (!lista.includes(selector)) continue;
      const decl = [...cuerpo.matchAll(new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`, "g"))];
      if (decl.length > 0) ganadora = decl[decl.length - 1][1].trim();
    }
  }
  return ganadora;
}

type Modo = "expandida" | "rail" | "horizontal";

/** El modo de navegación resultante a una anchura ÚTIL (clientWidth) dada. */
function modoNavegacion(anchuraUtil: number): Modo {
  const direccion = declaracionGanadora(".tx-sidebar", "flex-direction", anchuraUtil);
  if (direccion === "row") return "horizontal";
  const etiqueta = declaracionGanadora(".tx-nav__label", "display", anchuraUtil);
  return etiqueta === "none" ? "rail" : "expandida";
}

/** La anchura de la barra lateral resultante a una anchura útil dada. */
function anchuraBarra(anchuraUtil: number): string | null {
  return declaracionGanadora(".tx-sidebar", "width", anchuraUtil);
}

/**
 * V3-14 — LOS CORTES, LEÍDOS DEL MODELO, NO ESCRITOS A MANO.
 *
 * Abajo había dos aserciones sobre literales —`expect(1119 - 1024)` y un
 * `const corteRail = 1119`— que son aritmética de la propia prueba: no miran
 * el producto y no pueden fallar aunque alguien mueva un @media. Estas dos
 * funciones DERIVAN los cortes recorriendo el modelo de la cascada que ya se
 * construye arriba, así que si un corte se mueve, se mueven con él.
 */
function anchuraMasAlta(modo: Modo): number {
  for (let w = 2000; w >= 200; w -= 1) {
    if (modoNavegacion(w) === modo) return w;
  }
  throw new Error(`el modelo no produce el modo ${modo} a ninguna anchura`);
}

function anchuraMasBaja(modo: Modo): number {
  for (let w = 200; w <= 2000; w += 1) {
    if (modoNavegacion(w) === modo) return w;
  }
  throw new Error(`el modelo no produce el modo ${modo} a ninguna anchura`);
}

// ---------------------------------------------------------------------
// El modelo de WebKit: media queries contra clientWidth, no innerWidth
// ---------------------------------------------------------------------

/** Anchura de una barra de desplazamiento clásica de macOS. */
const BARRA_CLASICA = 15;

/** ¿Reserva la hoja el canal de la barra de forma permanente? */
function reservaCanalSiempre(css: string): boolean {
  const reglaHtml = /(?:^|\})\s*html\s*\{([^}]*)\}/.exec(css);
  return reglaHtml !== null && /overflow-y\s*:\s*scroll/.test(reglaHtml[1]);
}

/**
 * Anchura ÚTIL (la que ven las media queries) para una ventana dada, según
 * desborde o no la página en vertical. Con el canal reservado siempre, el
 * resultado deja de depender del contenido: ese es justo el arreglo.
 */
function anchuraUtil(anchuraVentana: number, desbordaEnVertical: boolean): number {
  if (reservaCanalSiempre(CSS)) return anchuraVentana - BARRA_CLASICA;
  return desbordaEnVertical ? anchuraVentana - BARRA_CLASICA : anchuraVentana;
}

// ---------------------------------------------------------------------

describe("M25 · la barra lateral no depende del largo de la página", () => {
  // La banda de la ventana del owner, deducida del informe: Llamadas salía
  // expandida (luego anchura útil >= 1280 sin barra) e Inicio salía en raíl
  // (luego anchura útil <= 1279 con barra), así que la ventana está entre
  // 1280 y 1280 + 15 - 1.
  const VENTANA_OWNER = [1280, 1285, 1290, 1294] as const;

  it("misma ventana, página corta y página larga: el mismo modo (el fallo del owner)", () => {
    // Contra 252792e esto falla: a 1280 la página corta daba "expandida" y la
    // larga "rail".
    for (const ventana of [...VENTANA_OWNER, 1440, 1300, 1200, 1160, 1024, 900, 768]) {
      const corta = modoNavegacion(anchuraUtil(ventana, false));
      const larga = modoNavegacion(anchuraUtil(ventana, true));
      expect(larga, `a ${String(ventana)}px el modo cambia según desborde o no`).toBe(corta);
    }
  });

  it("en la ventana que usa el owner todas las rutas quedan EXPANDIDAS, con o sin scroll", () => {
    for (const ventana of VENTANA_OWNER) {
      for (const desborda of [false, true]) {
        expect(
          modoNavegacion(anchuraUtil(ventana, desborda)),
          `ventana ${String(ventana)}px, desborda=${String(desborda)}`,
        ).toBe("expandida");
      }
    }
  });

  it("la reserva del canal no deja la consola en modo compacto: hay separación real hasta el corte", () => {
    // El aviso de la misión: reservar el canal a secas, sin bajar el corte,
    // habría dejado 1265 px útiles a 1280 y por tanto TODO en raíl.
    const utilPeor = anchuraUtil(1280, true);
    expect(utilPeor).toBe(1265);
    expect(modoNavegacion(utilPeor)).toBe("expandida");
    // Y la holgura sobra: más de 100 px hasta el corte del raíl. El corte se
    // LEE del modelo (V3-14): antes era un `1119` escrito a mano, y una
    // @media movida lo habría dejado mintiendo sin que nada fallara.
    const corteRail = anchuraMasAlta("rail");
    expect(modoNavegacion(corteRail)).toBe("rail");
    expect(modoNavegacion(corteRail + 1)).toBe("expandida");
    expect(utilPeor - corteRail).toBeGreaterThan(100);
  });
});

describe("M25 · el modo compacto y el horizontal siguen existiendo", () => {
  it("matriz de anchuras útiles: cada banda da el modo que le toca", () => {
    const matriz: ReadonlyArray<readonly [number, Modo]> = [
      [1440, "expandida"],
      [1280, "expandida"],
      [1265, "expandida"], // la del owner con el canal reservado
      [1200, "expandida"],
      [1120, "expandida"],
      [1119, "rail"], // primera anchura compacta
      [1080, "rail"],
      [1024, "rail"],
      [1023, "horizontal"],
      [900, "horizontal"],
      [768, "horizontal"],
      [690, "horizontal"],
    ];
    for (const [ancho, esperado] of matriz) {
      expect(modoNavegacion(ancho), `anchura útil ${String(ancho)}px`).toBe(esperado);
    }
  });

  it("el raíl de iconos conserva su banda propia entre el horizontal y lo expandido", () => {
    // V3-14 — la banda se MIDE sobre el modelo, no se escribe. `expect(1119 -
    // 1024).toBeGreaterThan(90)` es aritmética de la prueba sobre dos
    // literales: cierta pase lo que pase en el CSS.
    const alto = anchuraMasAlta("rail");
    const bajo = anchuraMasBaja("rail");
    expect(bajo).toBe(1024);
    expect(alto).toBe(1119);
    expect(anchuraBarra(alto)).toBe("76px");
    expect(anchuraBarra(bajo)).toBe("76px");
    // La banda es CONTINUA: ni una anchura intermedia se sale del raíl.
    for (let w = bajo; w <= alto; w += 1) expect(modoNavegacion(w), `${String(w)}px`).toBe("rail");
    // Y no es simbólica: son casi cien píxeles de recorrido.
    expect(alto - bajo).toBeGreaterThan(90);
    // Sus dos fronteras son de verdad fronteras.
    expect(modoNavegacion(bajo - 1)).toBe("horizontal");
    expect(modoNavegacion(alto + 1)).toBe("expandida");
  });

  it("por debajo de 1024 la navegación sigue siendo horizontal y desplazable", () => {
    expect(modoNavegacion(1023)).toBe("horizontal");
    const bloque1023 = BLOQUES.find((b) => b.maxWidth === 1023);
    expect(bloque1023).toBeDefined();
    expect(bloque1023?.cuerpo).toContain("overflow-x: auto");
    expect(bloque1023?.cuerpo).toContain("scroll-snap-type: x proximity");
  });
});

describe("M25 · la reserva del canal está donde tiene que estar", () => {
  it("html reserva el canal SIEMPRE, no según el contenido", () => {
    expect(reservaCanalSiempre(CSS)).toBe(true);
  });

  it("scrollbar-gutter acompaña, pero la garantía no depende de él", () => {
    // Medido en WebKit 26.5: CSS.supports('scrollbar-gutter','stable') dice
    // true y aun así NO reserva el canal. Va por corrección (Chrome, Firefox
    // y el Safari que venga), pero quien sostiene la estabilidad en Safari
    // hoy es overflow-y: scroll. Si alguien quita esa línea creyendo que
    // scrollbar-gutter basta, la prueba de arriba se cae.
    const reglaHtml = /(?:^|\})\s*html\s*\{([^}]*)\}/.exec(CSS);
    expect(reglaHtml?.[1]).toMatch(/scrollbar-gutter\s*:\s*stable/);
  });

  it("nada de esto introduce desbordamiento horizontal", () => {
    // El único overflow-x: auto permitido sigue siendo el de la navegación y
    // el de las tablas; y en html no se ha colado ningún overflow-x.
    const conScrollX = [...CSS.matchAll(/([^{}]*)\{[^}]*overflow-x:\s*auto[^}]*\}/g)].map((m) => m[1].trim());
    expect(conScrollX.sort()).toEqual([".tx-sidebar", ".tx-table-scroll"]);
    const reglaHtml = /(?:^|\})\s*html\s*\{([^}]*)\}/.exec(CSS);
    expect(reglaHtml?.[1]).not.toMatch(/overflow-x/);
  });
});

describe("M25 · la corrección es global: ninguna ruta tiene trato especial", () => {
  const RUTAS = ["inicio", "agenda", "lista-espera", "llamadas", "horarios-y-ausencias", "equipo", "laboratorio"];

  it("la hoja de estilos no mira la ruta para decidir la barra lateral", () => {
    for (const ruta of RUTAS) {
      expect(CSS, `la hoja trata ${ruta} aparte`).not.toContain(`data-route="${ruta}"`);
      expect(CSS).not.toContain(`#/${ruta}`);
    }
    // Y ninguna regla de barra/navegación cuelga de un selector de ruta.
    expect(CSS).not.toMatch(/\[data-route[^\]]*\][^{}]*\{[^}]*flex-basis/);
  });

  it("el JavaScript servido no fuerza el diseño de la barra según la ruta", () => {
    const jsLimpio = JS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // Nada de medir la ventana para decidir el diseño: esto es CSS y sólo CSS.
    expect(jsLimpio).not.toMatch(/matchMedia/);
    expect(jsLimpio).not.toMatch(/innerWidth/);
    expect(jsLimpio).not.toMatch(/clientWidth/);
    // Ni de tocar las clases que deciden el modo de navegación.
    expect(jsLimpio).not.toMatch(/classList\.[a-z]+\(\s*["'`]tx-sidebar/);
    expect(jsLimpio).not.toMatch(/classList\.[a-z]+\(\s*["'`]tx-nav__label/);
  });

  it("las siete rutas siguen sirviéndose del mismo armazón", () => {
    for (const ruta of RUTAS) {
      expect(HTML).toContain(`href="#/${ruta}"`);
    }
  });
});

describe("M25 · la accesibilidad de la navegación no se toca", () => {
  it("cada entrada conserva su nombre accesible, esté en raíl o expandida", () => {
    // El raíl esconde la etiqueta VISIBLE; el nombre lo da el aria-label, que
    // vive en el HTML y no depende de ninguna anchura.
    for (const ruta of ["inicio", "agenda", "llamadas", "horarios-y-ausencias", "equipo", "laboratorio"]) {
      const enlace = new RegExp(`href="#/${ruta}"[^>]*aria-label="[^"]+"`);
      expect(HTML, `${ruta} se queda sin nombre accesible`).toMatch(enlace);
    }
  });

  it("el rótulo de herramientas se oculta a la vista pero no del árbol de accesibilidad", () => {
    // En las dos bandas que lo esconden (raíl y horizontal) tiene que seguir
    // siendo la técnica de ocultación visual, nunca display: none.
    for (const corte of [1119, 1023]) {
      const bloque = BLOQUES.find((b) => b.maxWidth === corte);
      const regla = /\.tx-sidebar__tools-label\s*\{([^}]*)\}/.exec(bloque?.cuerpo ?? "");
      expect(regla, `falta la regla en ≤${String(corte)}px`).not.toBeNull();
      expect(regla?.[1]).toContain("clip: rect(0, 0, 0, 0)");
      expect(regla?.[1]).not.toMatch(/display\s*:\s*none/);
    }
  });

  it("el foco visible y el aria-current siguen sin depender de la anchura", () => {
    expect(CSS).toMatch(/\.tx-nav__list a\[aria-current="page"\]/);
    // El halo de foco de la barra lateral no vive dentro de ningún @media.
    const fueraDeMedia = BLOQUES.filter((b) => b.maxWidth === null).map((b) => b.cuerpo).join("\n");
    expect(fueraDeMedia).toContain(".tx-sidebar :focus-visible");
  });
});

// =====================================================================
// step 26 REAPERTURA · Decisión R5 — la barra lateral se queda FIJA al
// bajar, y SÓLO en escritorio (≥1024 px).
//
// EL FALLO QUE ESTO IMPIDE QUE VUELVA (Defecto 1 de la reapertura, verificado
// a mano por el owner en un navegador real): `.tx-shell` es `display: flex` sin
// `align-items`, que en flexbox equivale a `stretch`: la CAJA de
// `.tx-sidebar` se estira a toda la altura del documento (por eso el fondo
// oscuro seguía abajo), pero su CONTENIDO se queda arriba del todo y se
// marcha con el desplazamiento. `tools/console-audit/audit-m26-reapertura.mjs`
// mide el mismo defecto en un navegador real (Blink); aquí se comprueba el
// contrato exacto de las declaraciones CSS, sin navegador.
//
// Estas pruebas FALLAN contra `c21118b` (y contra el HEAD de esta reapertura
// antes de la reparación): el bloque base `.tx-sidebar` de `ui.css.ts:323-331`
// no declara `position`, ni `height`, ni `overflow-y`, ni `align-self`.
// =====================================================================

describe("step 26 REAPERTURA · R5 — barra lateral fija en escritorio (≥1024px)", () => {
  /** La primera regla `selector { … }` encontrada en `cuerpo`, o null. */
  function reglaExacta(cuerpo: string, selector: string): string | null {
    const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`${escapado}\\s*\\{([^{}]*)\\}`).exec(cuerpo);
    return m ? m[1] : null;
  }

  const bloqueBase = BLOQUES.filter((b) => b.maxWidth === null).map((b) => b.cuerpo).join("\n");
  const bloque1023 = BLOQUES.find((b) => b.maxWidth === 1023);

  it("el bloque BASE de .tx-sidebar (fuera de cualquier @media) declara las cinco propiedades de la barra fija", () => {
    const regla = reglaExacta(bloqueBase, ".tx-sidebar");
    expect(regla, "no se encuentra la regla base .tx-sidebar { … } fuera de @media").not.toBeNull();
    expect(regla).toMatch(/position\s*:\s*sticky/);
    expect(regla).toMatch(/top\s*:\s*0\b/);
    expect(regla).toMatch(/align-self\s*:\s*flex-start/);
    expect(regla).toMatch(/height\s*:\s*100vh/);
    expect(regla).toMatch(/overflow-y\s*:\s*auto/);
  });

  it("el bloque BASE de .tx-sidebar reserva el canal de su barra de desplazamiento (V2-1)", () => {
    // HALLAZGO V2-1 de la revisión adversarial, medido en WebKit real a
    // 1280×500: `overflow-y: auto` a secas no reserva canal cuando el sistema
    // usa barras por SUPERPOSICIÓN (el ajuste por defecto de macOS con
    // trackpad). La séptima entrada («Laboratorio», que vive en la SEGUNDA
    // `.tx-nav__list`) quedaba fuera de la barra sin ni un píxel de barra
    // visible que dijera que hay más abajo — justo lo que §R15 A11 prohíbe:
    // «Prohibido que el desplazamiento interno oculte una entrada sin barra
    // de desplazamiento visible».
    //
    // DISCRIMINANTE: falla contra `f6ab8e7`, donde la regla base declara
    // overflow-y pero no scrollbar-gutter.
    const regla = reglaExacta(bloqueBase, ".tx-sidebar");
    expect(regla).toMatch(/scrollbar-gutter\s*:\s*stable/);
    // Y, porque `scrollbar-gutter` NO reserva canal en WebKit (medido: 0px a
    // 1280x500 con la declaración puesta, el mismo comportamiento ya anotado
    // arriba para `html`), la barra de esta barra se declara: eso saca a
    // WebKit del modo superpuesto para este contenedor y la hace visible
    // (canal medido 0px -> 10px). Las dos van juntas o A11 no se cumple.
    expect(CSS).toMatch(/\.tx-sidebar::-webkit-scrollbar\s*\{[^}]*width\s*:\s*10px/);
    expect(CSS).toMatch(/\.tx-sidebar::-webkit-scrollbar-thumb\s*\{[^}]*background\s*:\s*var\(--tx-sidebar-line\)/);
    // Y va en la regla BASE, no en una @media nueva (§R15 A10).
    expect([...CSS.matchAll(/@media\s*\([^)]*\)\s*\{/g)].length).toBe(6);
  });

  it("el bloque .tx-sidebar de @media (max-width: 1023px) ANULA las cinco: la barra fija es de escritorio", () => {
    expect(bloque1023, "falta el bloque @media (max-width: 1023px)").toBeDefined();
    const regla = reglaExacta(bloque1023!.cuerpo, ".tx-sidebar");
    expect(regla, "no se encuentra .tx-sidebar dentro de @media (max-width: 1023px)").not.toBeNull();
    expect(regla).toMatch(/position\s*:\s*static/);
    expect(regla).toMatch(/height\s*:\s*auto/);
    expect(regla).toMatch(/overflow-y\s*:\s*visible/);
    expect(regla).toMatch(/align-self\s*:\s*auto/);
  });

  it("candado — @media (max-width:1023px) conserva scroll-snap, eje oculto y pie oculto, byte a byte", () => {
    // No discriminante: ya pasa hoy y tiene que seguir pasando tras R5.
    expect(bloque1023?.cuerpo).toContain("scroll-snap-type: x proximity");
    expect(bloque1023?.cuerpo).toContain(".tx-agenda-grid__axis { display: none; }");
    expect(bloque1023?.cuerpo).toContain(".tx-sidebar__foot { display: none; }");
    // Y las tres reglas de flexión horizontal que R5 tiene que dejar intactas.
    const sidebarRegla = reglaExacta(bloque1023!.cuerpo, ".tx-sidebar");
    expect(sidebarRegla).toMatch(/flex-basis\s*:\s*auto/);
    expect(sidebarRegla).toMatch(/flex-direction\s*:\s*row/);
    expect(sidebarRegla).toMatch(/width\s*:\s*auto/);
  });

  it("no se ha introducido ninguna @media (min-width…) nueva — R5 prohíbe esa vía", () => {
    expect(CSS).not.toMatch(/@media\s*\(\s*min-width/);
  });

  it("el número total de @media de la hoja no ha crecido por la reparación (6: prefers-reduced-motion + las cinco max-width; la del comentario de cabecera no cuenta)", () => {
    // NOTA DE DESVIACIÓN respecto al normativo: R5 §Pruebas dice "exactamente
    // 5 (prefers-reduced-motion + las cuatro max-width)". Verificado contra
    // el CSS servido (idéntico en c21118b y en el HEAD de esta reapertura):
    // hay CINCO bloques @media (max-width: …) — 1439, 1279, 1119, 1023 Y
    // 720 — más el de prefers-reduced-motion, total 6. El normativo no contó
    // el de 720px. El invariante que la prueba protege (ninguna @media nueva)
    // se conserva igual con 6 que con 5: se ancla al recuento REAL para no
    // afirmar un número que el propio CSS servido contradice.
    const total = [...CSS.matchAll(/@media\s*\([^)]*\)\s*\{/g)].length;
    expect(total).toBe(6);
  });
});
