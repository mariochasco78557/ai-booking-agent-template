/**
 * ────────────────────────────────────────────────────────────────────────
 * LA HOJA DE ESTILOS DE LA WEB PÚBLICA, servida desde su propia ruta
 * (`GET /app.css`, ver server.ts) para que `style-src 'self'` baste sin
 * `'unsafe-inline'`: la CSP de `src/bookingWeb/server.ts` no admite estilo en
 * línea de ninguna clase, ni un `<style>` embebido ni un `style="…"`.
 *
 * Es un fichero PROPIO de la demostración, deliberadamente SIN importar nada de
 * `src/console/**` (regla dura de la misión): los tokens de abajo se escriben de
 * cero con prefijo `--txb-` (booking web) para que no puedan confundirse nunca
 * con los `--tx-*` de la consola de operador, aunque la dirección visual sea de
 * la misma familia.
 *
 * DIRECCIÓN VISUAL. Barbería con oficio contada como una revista impresa: papel
 * marfil, tinta densa, un solo golpe de cobre, y la reserva como el único gesto
 * brillante de la página. Dos pilas tipográficas del SISTEMA —una serif para los
 * titulares, una sans para todo lo demás—, porque sin contraste de familia no
 * hay voz de marca; y ninguna fuente descargada, que la CSP no la dejaría pasar.
 *
 * DOS LOCALES, DOS PALETAS, UNA SOLA HOJA. Las reglas de abajo NUNCA nombran un
 * color: nombran un TOKEN. Los tokens de tema —acento, lienzo, líneas, banda
 * oscura y anillo de foco— se declaran dos veces: en `:root`, con la identidad
 * del local principal (cobre sobre marfil), y en `body[data-theme="aralar"]`,
 * con la del segundo (índigo sobre niebla). El documento elige cuál se aplica
 * con un atributo del `<body>`. Aquí NO hay ni puede haber un selector
 * `body[data-tenant-id="…"]`: eso volvería a meter la marca en el código, que es
 * justo lo que `tenants.ts` y la vista pública acaban de sacar de él.
 *
 * Los tokens SEMÁNTICOS no se tematizan: el verde de «disponible», el ámbar de
 * «pendiente» y el rojo de «reiniciar» significan lo mismo en los dos locales, y
 * teñirlos de marca convertiría un mensaje en decoración.
 *
 * PROHIBICIONES QUE VIGILAN LAS PRUEBAS (`marcaPorLocal.test.ts`,
 * `uiEstatico.test.ts`) y que hay que respetar al editar este fichero:
 *   - Ninguna regla posterior a los dos bloques de tema puede escribir un hex.
 *   - Cero `@import`, cero `@font-face`, cero `url(...)`, cero orígenes ajenos.
 *   - Cero imágenes: los seis símbolos de la página son SVG en línea del marcado
 *     y heredan el color con `currentColor`.
 *
 * EL ANILLO DE FOCO ES DOBLE Y NO PUEDE FALLAR. El anterior —un trazo de tinta
 * sobre el botón de acento— daba 2,88:1 en el tema cobre y 1,99:1 en el índigo,
 * por debajo del 3:1 de la SC 1.4.11 justo en el control más importante de la
 * página. El de ahora tiene dos aros de color opuesto: uno claro pegado al
 * elemento y otro oscuro por fuera, así que siempre hay un tramo con contraste
 * de sobra contra lo que tenga detrás, y sobre la banda oscura se invierte solo.
 * Se ha omitido a propósito el `border-radius: inherit` del boceto: heredar el
 * radio del contenedor deformaría el aro de cada botón al enfocarlo; sin esa
 * línea, el aro sigue la curva propia del elemento, que es lo que se busca.
 *
 * Y ese anillo es de CONTROLES, no de destinos: los encabezados de paso y el
 * `<main>` llevan `tabindex="-1"` sólo para que el cliente les traiga el foco
 * al cambiar de paso, y pintarles el aro de un botón dejaba un recuadro negro
 * ceñido al titular que se lee como un error de maquetación. La distinción, y
 * por qué no es una regresión de accesibilidad, están razonadas en la última
 * sección de la hoja, junto a la regla.
 * ────────────────────────────────────────────────────────────────────────
 */
export const BOOKING_CSS = `
:root {
  /* ── TIPOGRAFÍA: dos pilas, sólo fuentes del sistema ──────────────────
     macOS/iOS → New York / San Francisco · Windows → Georgia / Segoe UI
     Android → Noto Serif / Roboto · el resto → serif / sans-serif. */
  --txb-font-display: ui-serif, "New York", Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", "Noto Serif", "Droid Serif", "Times New Roman", serif;
  --txb-font-text: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

  --txb-fs-display: clamp(2.75rem, 1.55rem + 4.8vw, 5rem);
  --txb-fs-h1:      clamp(2rem, 1.4rem + 2.4vw, 3rem);
  --txb-fs-h2:      clamp(1.5rem, 1.18rem + 1.3vw, 2.125rem);
  --txb-fs-h3:      clamp(1.125rem, 1.05rem + 0.32vw, 1.3125rem);
  --txb-fs-lead:    clamp(1.125rem, 1.03rem + 0.42vw, 1.375rem);
  --txb-fs-body:    clamp(1rem, 0.97rem + 0.13vw, 1.0625rem);
  --txb-fs-small:   0.875rem;
  --txb-fs-eyebrow: 0.75rem;

  /* ── TINTA Y PAPEL — tema por defecto: el local principal ─────────────
     Éstos son los tokens que un local puede reescribir. Cada valor de aquí
     tiene su pareja en el bloque \`body[data-theme="aralar"]\`. */
  --txb-ink-950:     #12100E;
  --txb-ink-900:     #191714;
  --txb-ink-700:     #3B3630;
  --txb-ink-500:     #5A5249;
  --txb-surface:     #FFFFFF;

  --txb-canvas:      #F6F2E9;
  --txb-canvas-alt:  #EFE8DA;
  --txb-canvas-band: #E7DFCF;

  --txb-line:        #DCD4C4;
  --txb-line-strong: #7C7365;

  --txb-accent-900:  #5E2B11;
  --txb-accent-800:  #7A3818;
  --txb-accent-700:  #9A4A22;
  --txb-accent-500:  #C0703F;
  --txb-accent-50:   #F7EAE0;

  /* Sobre la banda oscura ni la tinta apagada ni el acento llegan al
     contraste exigido: la banda tiene sus propios cuatro colores. */
  --txb-on-dark:        #F6F2E9;
  --txb-on-dark-muted:  #C9C1B4;
  --txb-on-dark-line:   #3A342D;
  --txb-accent-on-dark: #D6A87F;
  --txb-green-on-dark:  #8FC7A5;

  --txb-focus-ring:       #191714;
  --txb-focus-ring-inner: #FFFFFF;

  /* ── MENSAJE, NO DECORACIÓN: estos cuatro no se tematizan ─────────── */
  --txb-green-700:   #1E6B3A;
  --txb-green-50:    #E6F1E9;
  --txb-amber-800:   #8A5300;
  --txb-amber-50:    #FAEFD8;
  --txb-red-700:     #B3261E;
  --txb-red-50:      #F8E6E4;
  --txb-neutral-700: #5A5249;
  --txb-neutral-50:  #EDE9E0;

  --txb-radius-sm:   4px;
  --txb-radius-md:   8px;
  --txb-radius-lg:   12px;
  --txb-radius-xl:   20px;
  --txb-radius-pill: 999px;

  --txb-space-1:  0.25rem;
  --txb-space-2:  0.5rem;
  --txb-space-3:  0.75rem;
  --txb-space-4:  1rem;
  --txb-space-5:  1.25rem;
  --txb-space-6:  1.5rem;
  --txb-space-7:  1.75rem;
  --txb-space-8:  2rem;
  --txb-space-10: 2.5rem;
  --txb-space-12: 3rem;
  --txb-space-16: 4rem;
  --txb-space-20: 5rem;
  --txb-space-24: 6rem;

  --txb-section-y: clamp(3rem, 1.4rem + 6.4vw, 6rem);
  --txb-gutter:    clamp(1rem, 0.4rem + 2.4vw, 2.5rem);
  --txb-maxw:      1200px;
  --txb-measure:   66ch;

  /* La altura de las dos barras pegadas la fija el sistema, NUNCA el
     logotipo: así la cabecera no salta entre el local que publica un PNG y
     el que se presenta con un distintivo tipográfico. */
  --txb-demobar-h: 32px;
  --txb-nav-h:     80px;
  /* DÓNDE SE PEGA LA CABECERA, y cuánto sitio ocupa lo pegado. Se declaran
     como tokens porque los usan cinco reglas —la barra, el menú móvil, el
     anclaje de sección, el resumen pegado y el desplazamiento del documento—
     y una sola de ellas desalineada deja un título debajo de la barra. Por
     defecto valen lo de móvil: ahí la franja de demostración NO se pega (su
     texto lo escribe el local y puede ocupar dos líneas, así que un desfase
     fijo la taparía), y la cabecera se pega arriba del todo. */
  --txb-topbar-top: 0px;
  --txb-bars-h:     var(--txb-nav-h);
  /* Objetivo táctil mínimo de la WCAG 2.2 (SC 2.5.8 es 24, esto es el 44 de
     la 2.1 AAA / iOS): TODO control de esta página lo cumple. */
  --txb-tap:       44px;

  --txb-shadow-1: 0 1px 2px rgba(18, 16, 14, 0.06), 0 1px 1px rgba(18, 16, 14, 0.04);
  --txb-shadow-2: 0 2px 4px rgba(18, 16, 14, 0.07), 0 8px 16px -8px rgba(18, 16, 14, 0.12);
  --txb-shadow-3: 0 24px 64px -24px rgba(18, 16, 14, 0.34), 0 2px 8px rgba(18, 16, 14, 0.08);
  /* La sombra de la barra pegada NO se declara aquí como token, y es a
     propósito: un token que contuviera \`var(--txb-line)\` se resolvería en
     \`:root\` —donde manda el tema por defecto— y bajaría YA RESUELTO a todos
     los elementos, así que el segundo local pintaba la línea de su cabecera
     con el color cálido del primero. Defecto real, visto en pantalla. Se
     escribe entera en \`.txb-topbar\`, donde el token se resuelve contra el
     tema que de verdad está puesto. */

  --txb-dur-1: 120ms;
  --txb-dur-2: 180ms;
  --txb-dur-3: 260ms;
  --txb-ease: cubic-bezier(0.2, 0, 0, 1);
  --txb-ease-out: cubic-bezier(0, 0, 0.2, 1);
}

/* ------------------------------------------------------------------ */
/* TEMA DEL SEGUNDO LOCAL — índigo sobre niebla.                       */
/*                                                                     */
/* No es otro tono del mismo cobre: es otro TONO DEL CÍRCULO. El acento */
/* pasa de naranja quemado (matiz ~24°) a índigo (~218°), y el lienzo   */
/* de marfil cálido a un gris azulado frío, así que las dos páginas se  */
/* distinguen de un vistazo incluso en una captura pequeña. El índigo   */
/* tampoco se confunde con el verde de «disponible» ni con el ámbar de  */
/* «pendiente», que siguen intactos.                                    */
/*                                                                     */
/* CONTRASTE COMPROBADO (WCAG 2.1, ratio calculado sobre los hex, no    */
/* estimado a ojo). Ninguna pareja empeora respecto al tema por defecto: */
/*   #FFFFFF sobre --txb-accent-700 (texto de todo botón) ....  8,98:1  */
/*   #FFFFFF sobre --txb-accent-800 (botón en hover) ......... 12,67:1  */
/*   --txb-accent-700 sobre --txb-accent-50 (chip/distintivo)   7,57:1  */
/*   --txb-accent-700 sobre --txb-canvas (precio) ............  7,93:1  */
/*   --txb-ink-900 sobre --txb-canvas (texto corrido) ........ 15,81:1  */
/*   --txb-ink-500 sobre --txb-canvas (metadatos) ............  6,78:1  */
/*   --txb-line-strong sobre #FFFFFF (borde de control) ......  4,51:1  */
/*   --txb-on-dark sobre --txb-ink-950 (banda oscura) ........ 15,85:1  */
/*   --txb-accent-on-dark sobre --txb-ink-950 ................  9,35:1  */
/* Los mismos pares del tema por defecto dan 6,22 / 8,73 / 5,27 / 5,57 / */
/* 16,01 / 6,87 / 4,67 / 16,99 / 8,83.                                  */
/* ------------------------------------------------------------------ */
body[data-theme="aralar"] {
  --txb-ink-950:     #101725;

  --txb-canvas:      #EEF1F7;
  --txb-canvas-alt:  #E2E8F3;
  --txb-canvas-band: #D9E1F0;

  --txb-line:        #D0D8E6;
  --txb-line-strong: #6E7788;

  --txb-accent-900:  #0F2549;
  --txb-accent-800:  #17325F;
  --txb-accent-700:  #23478A;
  --txb-accent-500:  #4A6FB5;
  --txb-accent-50:   #E6ECF8;

  --txb-on-dark:        #EEF1F7;
  --txb-on-dark-muted:  #B9C2D4;
  --txb-on-dark-line:   #28303F;
  --txb-accent-on-dark: #A9BCE0;
}

/* ══════════════════════════════════════════════════════════════════ */
/* BASE                                                                */
/* ══════════════════════════════════════════════════════════════════ */

* { box-sizing: border-box; }
[hidden] { display: none !important; }

html {
  -webkit-text-size-adjust: 100%;
  /* Que un ancla no deje el título debajo de lo que está pegado arriba. */
  scroll-padding-top: calc(var(--txb-bars-h) + var(--txb-space-4));
}

body {
  margin: 0;
  background: var(--txb-canvas);
  color: var(--txb-ink-900);
  font-family: var(--txb-font-text);
  font-size: var(--txb-fs-body);
  line-height: 1.6;
}

h1, h2, h3 { margin: 0; color: var(--txb-ink-900); }
h1 { font-family: var(--txb-font-display); font-size: var(--txb-fs-h1); font-weight: 700; line-height: 1.08; letter-spacing: -0.016em; }
h2 { font-family: var(--txb-font-display); font-size: var(--txb-fs-h2); font-weight: 700; line-height: 1.15; letter-spacing: -0.010em; }
h3 { font-size: var(--txb-fs-h3); font-weight: 700; line-height: 1.30; }
p { margin: 0; }
ul, ol { margin: 0; }
dl, dd { margin: 0; }
button { font: inherit; color: inherit; }
a { color: var(--txb-accent-700); }

/* Nada de lo que pinta esta página puede empujar el documento de lado: las
   palabras largas se parten y ningún gráfico desborda su columna. */
img, svg { max-width: 100%; }
p, h1, h2, h3, li, dt, dd, summary, td, th { overflow-wrap: break-word; }

/* El anillo de foco se declara al FINAL de la hoja, no aquí: ver la última
   sección. Lo que sí va arriba es la inversión de sus dos colores sobre la
   banda oscura, que es una declaración de variables y no compite con nada. */
.txb-on-dark {
  --txb-focus-ring: var(--txb-on-dark);
  --txb-focus-ring-inner: var(--txb-ink-900);
}

.txb-visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* El primer tabulable del documento: invisible hasta que recibe el foco, y
   entonces se planta encima de todo. */
.txb-skip {
  position: fixed;
  top: var(--txb-space-2);
  left: var(--txb-space-2);
  z-index: 120;
  transform: translateY(-300%);
  background: var(--txb-surface);
  color: var(--txb-ink-900);
  text-decoration: none;
  font-weight: 700;
  padding: var(--txb-space-3) var(--txb-space-5);
  border-radius: var(--txb-radius-md);
  box-shadow: var(--txb-shadow-2);
  transition: transform var(--txb-dur-2) var(--txb-ease);
}
.txb-skip:focus { transform: translateY(0); }

/* ── HERRAMIENTAS DE COMPOSICIÓN ───────────────────────────────────── */
.txb-wrap {
  max-width: var(--txb-maxw);
  margin-inline: auto;
  padding-inline: var(--txb-gutter);
  width: 100%;
}
.txb-measure { max-width: var(--txb-measure); }
.txb-eyebrow {
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--txb-ink-500);
}
.txb-lead {
  font-size: var(--txb-fs-lead);
  line-height: 1.45;
  letter-spacing: 0.002em;
  color: var(--txb-ink-700);
}

/* ══════════════════════════════════════════════════════════════════ */
/* FRANJA DE DEMOSTRACIÓN, CABECERA Y NAVEGACIÓN                       */
/* ══════════════════════════════════════════════════════════════════ */

.txb-demobar {
  z-index: 60;
  min-height: var(--txb-demobar-h);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--txb-space-2);
  padding: 0 var(--txb-space-4);
  background: var(--txb-canvas-band);
  color: var(--txb-ink-700);
  font-size: var(--txb-fs-small);
  font-weight: 600;
  text-align: center;
  border-bottom: 1px solid var(--txb-line);
}

.txb-topbar {
  position: sticky;
  top: var(--txb-topbar-top);
  z-index: 50;
  background: var(--txb-canvas);
  box-shadow: 0 1px 0 var(--txb-line), 0 6px 16px -12px rgba(18, 16, 14, 0.18);
}
.txb-topbar > .txb-wrap {
  display: flex;
  align-items: center;
  gap: var(--txb-space-4);
  min-height: var(--txb-nav-h);
}

/* La marca PUEDE encoger. Si no pudiera, el local que se presenta con un
   nombre largo en texto —y no con un activo— empujaría la navegación fuera
   de la ventana y arrastraría la página entera de lado en un móvil. */
.txb-brand {
  display: flex;
  align-items: center;
  gap: var(--txb-space-3);
  flex: 0 1 auto;
  min-width: 0;
}
/* EL LOGOTIPO, LEGIBLE Y SIN PLACA.
 *
 * QUÉ PASABA. El activo es un ESCUDO cuadrado (400×400) con el rótulo en tres
 * pisos —tijeras, nombre, cinta, y un lema diminuto debajo— y con un tercio de
 * su alto en blanco de margen. Metido entero en una caja de 72 px, el rótulo se
 * quedaba en 10 px de altura de mayúscula y el lema en un borrón: a 1× no se
 * leía. Y como el PNG NO tiene canal alfa, iba montado en una placa blanca con
 * un aro de línea que, sobre el marfil, se veía como una pegatina pegada encima
 * de la barra en vez de como la marca de la casa.
 *
 * QUÉ SE HACE AHORA, y por qué en este orden:
 *   1. SE TIRA LA PLACA. \`mix-blend-mode: multiply\` deja pasar el papel del
 *      tema por debajo del blanco del activo y sólo conserva la tinta, así que
 *      el escudo queda impreso sobre el lienzo —marfil o niebla, el que toque—
 *      sin costura, sin aro y sin recuadro. Comprobado en los DOS temas. La
 *      barra crea su propio contexto de apilado (\`position: sticky\` con
 *      \`z-index\`), de modo que la mezcla ocurre contra el fondo de la barra y
 *      nunca contra lo que pase por debajo al desplazar.
 *   2. SE RECORTA EL MARGEN MUERTO. \`object-fit: cover\` sobre una caja 2:1
 *      tira el blanco de arriba y de abajo y el lema ilegible, y deja el
 *      rótulo —que es lo que hay que leer— ocupando el alto entero. Es un
 *      RECORTE, no un estirón: la tinta conserva su proporción exacta.
 *   3. EL ALTO MOSTRADO ES 44 px, el mismo objetivo táctil del resto de la
 *      página, así que la marca pesa ópticamente lo mismo que el distintivo
 *      tipográfico del local que no publica activo y las dos barras se leen
 *      iguales. El ancho lo pone la proporción, no una medida a mano.
 *
 * SIGUE SIN HABER SALTO DE COMPOSICIÓN: \`width\`/\`height\` en el marcado siguen
 * declarando el tamaño INTRÍNSECO del activo, y \`aspect-ratio\` fija aquí la
 * caja final antes de que la imagen llegue, así que la barra no se mueve. */
.txb-brand img {
  display: block;
  height: 44px;
  width: auto;
  aspect-ratio: 2 / 1;
  object-fit: cover;
  object-position: 50% 38%;
  mix-blend-mode: multiply;
}
/* El distintivo TIPOGRÁFICO del local que no publica activo: monograma en
   placa de acento. Mide 44 px de alto, EXACTAMENTE lo que mide el escudo
   recortado del otro local, para que las dos barras tengan el mismo ancla
   óptica y la navegación caiga a la misma altura en las dos. */
.txb-brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 44px;
  padding: 0 var(--txb-space-2);
  border-radius: var(--txb-radius-md);
  background: var(--txb-accent-700);
  color: #fff;
  font-family: var(--txb-font-display);
  font-weight: 700;
  font-size: 1.25rem;
  letter-spacing: 0.08em;
}
.txb-brand-wordmark {
  font-family: var(--txb-font-display);
  font-weight: 700;
  font-size: clamp(1.0625rem, 0.72rem + 0.72vw, 1.375rem);
  line-height: 1.15;
  letter-spacing: 0.01em;
  color: var(--txb-accent-700);
  min-width: 0;
  overflow-wrap: anywhere;
}
.txb-subtitle {
  color: var(--txb-ink-500);
  font-size: var(--txb-fs-small);
  border-left: 1px solid var(--txb-line);
  padding-left: var(--txb-space-4);
  max-width: 24ch;
}

.txb-nav {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--txb-space-2);
}
.txb-nav__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: center;
  gap: var(--txb-space-1);
}
.txb-nav__list > li { list-style: none; }
.txb-nav__link {
  display: inline-flex;
  align-items: center;
  min-height: var(--txb-tap);
  padding: 0 var(--txb-space-2);
  white-space: nowrap;
  border-radius: var(--txb-radius-sm);
  color: var(--txb-ink-700);
  text-decoration: none;
  font-size: var(--txb-fs-small);
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: color var(--txb-dur-1) var(--txb-ease), background-color var(--txb-dur-1) var(--txb-ease);
}
.txb-nav__link:hover { color: var(--txb-accent-700); background: var(--txb-canvas-alt); }
/* El botón de la barra no se parte en dos líneas por muy larga que sea la
   frase que el local haya elegido para él. */
.txb-nav > .txb-btn { white-space: nowrap; flex: 0 0 auto; }

.txb-nav__toggle {
  display: none;
  align-items: center;
  justify-content: center;
  min-width: var(--txb-tap);
  min-height: var(--txb-tap);
  border: 1px solid var(--txb-line-strong);
  border-radius: var(--txb-radius-md);
  background: var(--txb-surface);
  color: var(--txb-ink-900);
  cursor: pointer;
}
.txb-nav__toggle svg { width: 22px; height: 22px; }
.txb-nav__toggle[aria-expanded="true"] { background: var(--txb-canvas-alt); }

/* EL MENÚ MÓVIL se despliega BAJO las dos barras pegadas y no bloquea el
   desplazamiento del documento: es un panel más, no una capa modal. */
.txb-nav__menu {
  position: fixed;
  top: var(--txb-bars-h);
  left: 0;
  right: 0;
  z-index: 45;
  max-height: calc(100vh - var(--txb-bars-h));
  max-height: calc(100dvh - var(--txb-bars-h));
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--txb-canvas);
  border-bottom: 1px solid var(--txb-line);
  box-shadow: var(--txb-shadow-2);
  padding: var(--txb-space-2) var(--txb-gutter) calc(var(--txb-space-4) + env(safe-area-inset-bottom));
  animation: txb-menu-in var(--txb-dur-3) var(--txb-ease);
}
.txb-nav__menu .txb-nav__list {
  flex-direction: column;
  align-items: stretch;
  gap: 0;
}
.txb-nav__menu .txb-nav__link {
  min-height: 52px;
  width: 100%;
  border-radius: 0;
  border-bottom: 1px solid var(--txb-line);
  font-size: var(--txb-fs-body);
}
@keyframes txb-menu-in {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ══════════════════════════════════════════════════════════════════ */
/* SECCIONES — el ritmo de fondo de la página                          */
/* ══════════════════════════════════════════════════════════════════ */

.txb-main { display: block; }
.txb-main > .txb-status-line--error {
  margin: var(--txb-space-4) var(--txb-gutter) 0;
}

.txb-section {
  padding-block: var(--txb-section-y);
  background: var(--txb-canvas);
  scroll-margin-top: var(--txb-bars-h);
}
.txb-section--alt { background: var(--txb-canvas-alt); }
.txb-section--dark { background: var(--txb-ink-950); }

.txb-section__head {
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-2);
  margin-bottom: var(--txb-space-8);
}
.txb-section__head h2 {
  font-family: var(--txb-font-display);
  font-size: var(--txb-fs-h2);
}

/* LA BANDA OSCURA. Dentro de ella ni la tinta apagada ni el acento llegan al
   contraste exigido (2,48:1 y 2,12:1 en el tema índigo), así que sólo se usan
   los cuatro colores propios de la banda. */
.txb-on-dark { color: var(--txb-on-dark); }
.txb-on-dark h1,
.txb-on-dark h2,
.txb-on-dark h3 { color: var(--txb-on-dark); }
.txb-on-dark .txb-eyebrow { color: var(--txb-accent-on-dark); }
.txb-on-dark .txb-lead { color: var(--txb-on-dark-muted); }

/* ══════════════════════════════════════════════════════════════════ */
/* 1 · HERO — la primera pantalla, sin un solo formulario              */
/* ══════════════════════════════════════════════════════════════════ */

.txb-hero { padding-block: clamp(2.5rem, 1rem + 5vw, 5rem) var(--txb-section-y); }
.txb-hero > .txb-wrap {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: var(--txb-space-16);
  align-items: center;
  min-height: 58vh;
  min-height: 58svh;
}
.txb-hero__body {
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-5);
  min-width: 0;
}
.txb-hero h1 {
  font-size: var(--txb-fs-display);
  line-height: 1.02;
  letter-spacing: -0.022em;
}
.txb-hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--txb-space-4);
  margin-top: var(--txb-space-2);
}
.txb-hero__actions .txb-btn { min-height: 52px; }
.txb-hero__marks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--txb-space-2) var(--txb-space-6);
}
.txb-hero__mark {
  display: flex;
  align-items: baseline;
  gap: var(--txb-space-2);
  color: var(--txb-ink-500);
  font-size: var(--txb-fs-small);
}
.txb-hero__mark::before {
  content: "\\2713";
  color: var(--txb-green-700);
  font-weight: 700;
}
.txb-hero__aside {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: var(--txb-space-8);
  background: var(--txb-canvas-alt);
  border-radius: var(--txb-radius-xl);
  box-shadow: var(--txb-shadow-2);
}
.txb-hero__emblem {
  display: block;
  width: 100%;
  max-width: 320px;
  height: auto;
  color: var(--txb-accent-700);
}

/* ══════════════════════════════════════════════════════════════════ */
/* 2 · SERVICIOS — las fichas de la portada y las del asistente        */
/* ══════════════════════════════════════════════════════════════════ */

.txb-tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--txb-space-6);
}
.txb-tile-grid > * { min-width: 0; }

/* LA CAJA es igual para las dos formas de la ficha —el \`<article>\` de la
   portada y el \`<button>\` de las rejillas del asistente—; lo INTERACTIVO
   sólo lo lleva la segunda. */
.txb-tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--txb-space-2);
  padding: var(--txb-space-5);
  text-align: left;
  background: var(--txb-surface);
  border: 1px solid var(--txb-line-strong);
  border-radius: var(--txb-radius-lg);
  box-shadow: var(--txb-shadow-1);
  color: var(--txb-ink-900);
}
.txb-tile:is(button) {
  cursor: pointer;
  width: 100%;
  min-height: var(--txb-tap);
  transition: border-color var(--txb-dur-1) var(--txb-ease),
              background-color var(--txb-dur-1) var(--txb-ease),
              box-shadow var(--txb-dur-1) var(--txb-ease),
              transform var(--txb-dur-2) var(--txb-ease);
}
.txb-tile:is(button):hover:not(:disabled) {
  border-color: var(--txb-accent-700);
  box-shadow: var(--txb-shadow-2);
  transform: translateY(-1px);
}
.txb-tile:is(button):active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--txb-shadow-1);
}
/* SELECCIONADO sin engordar el borde: el segundo píxel es una sombra
   interior, así que nada se mueve al elegir. Y no va sólo por color: la
   marca de verificación lo dice también con forma. */
.txb-tile[aria-pressed="true"] {
  border-color: var(--txb-accent-700);
  background: var(--txb-accent-50);
  box-shadow: inset 0 0 0 1px var(--txb-accent-700), var(--txb-shadow-1);
}
.txb-tile[aria-pressed="true"]::after {
  content: "\\2713";
  align-self: flex-end;
  margin-top: auto;
  color: var(--txb-accent-700);
  font-weight: 700;
}
.txb-tile[disabled] {
  opacity: 0.45;
  cursor: not-allowed;
  border-style: dashed;
  box-shadow: none;
}
.txb-tile--featured { box-shadow: inset 0 3px 0 0 var(--txb-accent-700), var(--txb-shadow-1); }
.txb-tile--featured .txb-tile__cat { color: var(--txb-accent-700); }

/* ── LA JERARQUÍA DE LA FICHA, DE ARRIBA ABAJO ─────────────────────────
 *
 * QUÉ PASABA. Mandaba lo que no debía. El rótulo de categoría iba a 12 px en
 * negrita, versales y 0,14 em de espaciado: una banda ancha y ruidosa que
 * entraba antes que nada. Y el precio iba a 20 px en negrita y en el color de
 * acento —lo más saturado de la ficha— pegado a un nombre de 21 px en la sans
 * de texto, así que el ojo aterrizaba en el precio y el SERVICIO, que es lo
 * que se está eligiendo, quedaba tercero.
 *
 * QUÉ MANDA AHORA. El NOMBRE, y por dos vías a la vez: sube de tamaño y cambia
 * de familia a la serif de titulares, la misma con la que hablan \`h1\` y \`h2\`.
 * Es el único texto de la ficha con voz editorial, así que gana sin necesidad
 * de gritar más fuerte que nadie.
 *
 * Y LO DEMÁS SE APARTA, no desaparece:
 *   · la categoría baja a 11 px y afloja el espaciado: antetítulo, no banda;
 *   · duración y precio se juntan en un bloque tranquilo al pie del texto —el
 *     margen negativo del precio los pega— y el precio deja el acento y pasa a
 *     tinta: sube de 5,57:1 a 16,01:1 de contraste y deja de competir con el
 *     botón de reserva, que es el único cobre que debe haber ahí abajo. */
.txb-tile__cat {
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--txb-ink-500);
  margin-bottom: calc(-1 * var(--txb-space-1));
}
.txb-tile__name {
  font-family: var(--txb-font-display);
  font-size: clamp(1.3125rem, 1.15rem + 0.62vw, 1.625rem);
  font-weight: 700;
  line-height: 1.14;
  letter-spacing: -0.012em;
  color: var(--txb-ink-900);
}
.txb-tile__desc {
  color: var(--txb-ink-700);
  font-size: var(--txb-fs-small);
  line-height: 1.55;
  margin-top: var(--txb-space-1);
}
.txb-tile__meta {
  color: var(--txb-ink-500);
  font-size: 0.8125rem;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  margin-top: var(--txb-space-1);
}
.txb-tile__price {
  font-weight: 700;
  font-size: var(--txb-fs-body);
  color: var(--txb-ink-900);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  margin-top: calc(-1 * var(--txb-space-1));
}
/* El CTA repetido de cada servicio: sin \`id\` —habría uno por servicio— y
   alineado al fondo de la ficha, para que la fila de botones quede a la
   misma altura aunque las descripciones midan distinto. */
.txb-cta-servicio { margin-top: auto; width: 100%; }

/* ══════════════════════════════════════════════════════════════════ */
/* 3 · EQUIPO — monogramas, cero fotografías                           */
/* ══════════════════════════════════════════════════════════════════ */

.txb-ficha-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--txb-space-6);
}
.txb-ficha-grid > * { min-width: 0; }
.txb-ficha {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--txb-space-3);
  padding: var(--txb-space-6);
  background: var(--txb-surface);
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-lg);
  box-shadow: var(--txb-shadow-1);
}
/* El medallón se compone SÓLO con CSS: círculo de arena, aro de acento y la
   inicial en serif. Sin ninguna imagen, y por tanto sin ninguna petición. */
.txb-ficha__medallon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: var(--txb-canvas-band);
  box-shadow: inset 0 0 0 1px var(--txb-accent-700);
  color: var(--txb-accent-700);
  font-family: var(--txb-font-display);
  font-weight: 700;
  font-size: 2.5rem;
  line-height: 1;
  letter-spacing: 0.02em;
}
.txb-ficha__nombre { font-size: var(--txb-fs-h3); }
.txb-ficha__rol {
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--txb-accent-700);
}
.txb-ficha__bio { color: var(--txb-ink-700); font-size: var(--txb-fs-small); }
.txb-ficha__esp {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--txb-space-2);
}
.txb-ficha__esp > li {
  border-radius: var(--txb-radius-pill);
  background: var(--txb-accent-50);
  color: var(--txb-accent-700);
  padding: 2px var(--txb-space-3);
  font-size: 0.8125rem;
  font-weight: 600;
}
.txb-ficha__servicios {
  width: 100%;
  padding-top: var(--txb-space-3);
  border-top: 1px solid var(--txb-line);
  color: var(--txb-ink-500);
  font-size: var(--txb-fs-small);
}
/* Ídem para el CTA de cada persona, que además es secundario: la acción
   fuerte de la página es una sola y vive en el hero y en la barra. */
.txb-cta-profesional { margin-top: auto; width: 100%; }

/* ══════════════════════════════════════════════════════════════════ */
/* 4 · EXPERIENCIA — la banda oscura                                   */
/* ══════════════════════════════════════════════════════════════════ */

.txb-pasos {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  /* 230 px y no 260: con cuatro pasos, una columna más ancha dejaba el
     cuarto huérfano en una segunda fila y un hueco enorme al lado. */
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: var(--txb-space-8) var(--txb-space-10);
}
.txb-pasos > li {
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-3);
  min-width: 0;
}
.txb-paso-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 1px solid var(--txb-on-dark-muted);
  color: var(--txb-accent-on-dark);
  font-family: var(--txb-font-display);
  font-weight: 700;
  font-size: 1.75rem;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.txb-paso-titulo { color: var(--txb-on-dark); }
.txb-paso-desc { color: var(--txb-on-dark-muted); }

/* ══════════════════════════════════════════════════════════════════ */
/* 5 · RESERVA — el asistente dentro de la página                      */
/* ══════════════════════════════════════════════════════════════════ */

/* Cuatro segmentos iguales, nunca una escalera de guiones sueltos. */
.txb-steps {
  list-style: none;
  margin: 0 0 var(--txb-space-8);
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--txb-space-2);
}
.txb-steps > li {
  display: flex;
  align-items: center;
  gap: var(--txb-space-2);
  min-width: 0;
  padding-top: var(--txb-space-3);
  border-top: 3px solid var(--txb-line);
  color: var(--txb-ink-500);
  font-size: var(--txb-fs-small);
}
.txb-step__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  border: 1px solid var(--txb-line-strong);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--txb-ink-700);
}
.txb-step__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.txb-steps > li[aria-current="step"] { border-top-color: var(--txb-accent-700); }
.txb-steps > li[aria-current="step"] .txb-step__num {
  border-color: var(--txb-accent-700);
  background: var(--txb-accent-700);
  color: #fff;
}
.txb-steps > li[aria-current="step"] .txb-step__label {
  color: var(--txb-ink-900);
  font-weight: 700;
}
.txb-steps > li.txb-step--done { border-top-color: var(--txb-green-700); }
.txb-steps > li.txb-step--done .txb-step__num {
  border-color: var(--txb-green-700);
  color: var(--txb-green-700);
}

.txb-layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: var(--txb-space-8);
  align-items: start;
}
.txb-layout > * { min-width: 0; }

.txb-summary {
  position: sticky;
  top: calc(var(--txb-bars-h) + var(--txb-space-4));
  background: var(--txb-surface);
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-lg);
  box-shadow: var(--txb-shadow-1);
  padding: var(--txb-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-4);
}
.txb-summary-block {
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-md);
  padding: var(--txb-space-3) var(--txb-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-1);
  position: relative;
}
.txb-summary-block h3 {
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--txb-ink-500);
}
.txb-summary-block__name { font-weight: 700; font-size: 1.0625rem; }
.txb-summary-block__meta {
  color: var(--txb-ink-500);
  font-size: var(--txb-fs-small);
  font-variant-numeric: tabular-nums;
}

/* EL RÓTULO DE ARRANQUE DEL RESUMEN — LO QUE LLENA LA COLUMNA ANTES DE QUE
   HAYA NADA QUE RESUMIR.

   DEFECTO REAL, VISTO EN CHROME A 1440 px. Los cuatro bloques del resumen
   nacen ocultos, así que el paso 1 del asistente enseñaba una tarjeta blanca
   de 86 px con un único botón «Continuar» gris y apagado dentro, al lado de un
   panel derecho de 259 px. No parecía un resumen vacío: parecía una pantalla a
   medio cargar.

   Este bloque dice de qué va la columna y qué va a aparecer en ella. Es texto
   de la INTERFAZ, igual que «Elige un servicio» o los cuatro rótulos de paso:
   no habla del negocio, no promete nada, no escribe ni un precio, ni una hora,
   ni un dato de contacto, y por eso lo comparten los dos locales y lo pinta el
   cliente. Los rótulos que sí son de cada local siguen viniendo de su
   configuración y no pasan por aquí.

   LA ALTURA MÍNIMA ES EL ARREGLO DEL SALTO, y es la razón por la que este
   bloque tiene \`min-height\` y los demás no. En cuanto se elige un servicio,
   este rótulo se oculta y en su sitio aparece el bloque «SERVICIO
   SELECCIONADO», que mide unos 126 px: sin suelo, la columna daba un tirón
   hacia arriba y otro hacia abajo en el mismo instante. Con el suelo puesto a
   la altura de ese bloque, el intercambio es un cambio de CONTENIDO y no de
   TAMAÑO. El valor está en \`rem\` y no en píxeles a propósito: si alguien sube
   el cuerpo de texto del navegador, el suelo sube con él, igual que sube el
   bloque al que tiene que igualar. */
.txb-summary-intro {
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-md);
  background: var(--txb-canvas-alt);
  padding: var(--txb-space-3) var(--txb-space-4);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--txb-space-1);
  min-height: 8rem;
}
.txb-summary-intro__title {
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--txb-ink-500);
}
.txb-summary-intro__text {
  color: var(--txb-ink-700);
  font-size: var(--txb-fs-small);
  line-height: 1.5;
}

.txb-content {
  background: var(--txb-surface);
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-lg);
  padding: var(--txb-space-6);
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-6);
  min-width: 0;
}
.txb-content .txb-tile-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--txb-space-4); }
.txb-paso {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--txb-space-4);
  min-width: 0;
  scroll-margin-top: var(--txb-bars-h);
}
.txb-paso > .txb-tile-grid,
.txb-paso > div,
.txb-paso > table { width: 100%; }

.txb-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--txb-space-1);
  align-self: flex-start;
  border: 1px solid var(--txb-green-700);
  color: var(--txb-green-700);
  background: var(--txb-green-50);
  border-radius: var(--txb-radius-pill);
  padding: 2px var(--txb-space-3);
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  letter-spacing: 0.04em;
}
.txb-badge--optional {
  border-color: var(--txb-accent-700);
  color: var(--txb-accent-700);
  background: var(--txb-accent-50);
}

.txb-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--txb-space-2);
}
.txb-btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--txb-space-3);
}

.txb-chip {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid var(--txb-line-strong);
  background: var(--txb-surface);
  border-radius: var(--txb-radius-md);
  padding: var(--txb-space-2) var(--txb-space-3);
  min-width: 4rem;
  min-height: var(--txb-tap);
  text-align: center;
  font-weight: 600;
  color: var(--txb-ink-900);
  font-variant-numeric: tabular-nums;
}
.txb-chip:is(button) {
  cursor: pointer;
  min-height: 60px;
  transition: border-color var(--txb-dur-1) var(--txb-ease),
              background-color var(--txb-dur-1) var(--txb-ease),
              box-shadow var(--txb-dur-1) var(--txb-ease);
}
.txb-chip:is(button) > span:first-child {
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--txb-ink-500);
}
.txb-chip:is(button) > span:last-child { font-size: 1.5rem; font-weight: 700; line-height: 1.1; }
.txb-chip:is(button):hover:not(:disabled) { border-color: var(--txb-accent-700); }
.txb-chip[aria-pressed="true"] {
  border-color: var(--txb-accent-700);
  color: var(--txb-accent-700);
  background: var(--txb-accent-50);
  box-shadow: inset 0 0 0 1px var(--txb-accent-700);
}
.txb-chip[aria-pressed="true"] > span:first-child { color: var(--txb-accent-700); }
.txb-chip[disabled] { opacity: 0.4; cursor: not-allowed; border-style: dashed; }

/* ══════════════════════════════════════════════════════════════════ */
/* BOTONES — la misma pieza para \`<button>\` y para \`<a>\`               */
/* ══════════════════════════════════════════════════════════════════ */

.txb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--txb-space-2);
  min-height: var(--txb-tap);
  padding: var(--txb-space-2) var(--txb-space-6);
  border-radius: var(--txb-radius-md);
  font-family: var(--txb-font-text);
  font-size: var(--txb-fs-small);
  font-weight: 700;
  letter-spacing: 0.02em;
  text-align: center;
  text-decoration: none;
  border: 1px solid transparent;
  cursor: pointer;
  background: var(--txb-accent-700);
  color: #fff;
  box-shadow: var(--txb-shadow-1);
  transition: background-color var(--txb-dur-1) var(--txb-ease),
              border-color var(--txb-dur-1) var(--txb-ease),
              color var(--txb-dur-1) var(--txb-ease),
              box-shadow var(--txb-dur-1) var(--txb-ease),
              transform var(--txb-dur-2) var(--txb-ease);
}
.txb-btn:hover:not(:disabled) {
  background: var(--txb-accent-800);
  box-shadow: var(--txb-shadow-2);
  transform: translateY(-1px);
}
.txb-btn:active:not(:disabled) {
  background: var(--txb-accent-900);
  transform: translateY(0);
  box-shadow: var(--txb-shadow-1);
}
.txb-btn:disabled {
  background: var(--txb-line);
  color: var(--txb-ink-500);
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}
.txb-btn--secondary {
  background: var(--txb-surface);
  color: var(--txb-ink-900);
  border-color: var(--txb-line-strong);
}
.txb-btn--secondary:hover:not(:disabled) {
  background: var(--txb-canvas-alt);
  border-color: var(--txb-ink-700);
  color: var(--txb-ink-900);
}
.txb-btn--secondary:active:not(:disabled) { background: var(--txb-canvas-band); }
.txb-btn--secondary:disabled { background: var(--txb-surface); opacity: 0.5; border-color: var(--txb-line); }
.txb-btn--danger { background: var(--txb-red-700); border-color: transparent; }
.txb-btn--danger:hover:not(:disabled) { background: #8f1c16; }
.txb-btn--danger:active:not(:disabled) { background: #8f1c16; }

/* Botón de texto: el «‹ Volver» del cajón. Pesa lo que tiene que pesar —nada—
   y sigue midiendo 44 px de alto. */
.txb-linkbtn {
  display: inline-flex;
  align-items: center;
  gap: var(--txb-space-1);
  min-height: var(--txb-tap);
  padding: 0 var(--txb-space-2);
  background: none;
  border: 0;
  border-radius: var(--txb-radius-sm);
  color: var(--txb-ink-700);
  font-size: var(--txb-fs-small);
  font-weight: 600;
  cursor: pointer;
}
.txb-linkbtn:hover { color: var(--txb-accent-700); }

.txb-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--txb-tap);
  min-height: var(--txb-tap);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--txb-radius-md);
  color: var(--txb-ink-700);
  cursor: pointer;
}
.txb-iconbtn:hover { background: var(--txb-canvas-alt); color: var(--txb-ink-900); }
.txb-iconbtn svg { width: 20px; height: 20px; }

/* La barra inferior de reserva: SÓLO en móvil, y por encima de la
   zona segura del dispositivo. */
.txb-cta-movil { display: none; }

/* ══════════════════════════════════════════════════════════════════ */
/* EL CAJÓN DE FECHA Y HORA                                            */
/* ══════════════════════════════════════════════════════════════════ */

dialog.txb-drawer {
  position: fixed;
  inset: 0 0 0 auto;
  margin: 0;
  width: min(720px, 52vw);
  max-width: 100%;
  height: 100vh;
  height: 100dvh;
  max-height: 100dvh;
  padding: 0;
  border: 0;
  border-radius: var(--txb-radius-xl) 0 0 var(--txb-radius-xl);
  background: var(--txb-canvas);
  color: var(--txb-ink-900);
  box-shadow: var(--txb-shadow-3);
  overflow: hidden;
}
dialog.txb-drawer[open] {
  display: flex;
  flex-direction: column;
  animation: txb-drawer-in-x var(--txb-dur-3) var(--txb-ease);
}
dialog.txb-drawer::backdrop { background: rgba(18, 16, 14, 0.52); }
dialog.txb-drawer[open]::backdrop { animation: txb-fade-in var(--txb-dur-3) var(--txb-ease); }
@keyframes txb-drawer-in-x {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
@keyframes txb-drawer-in-y {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}
@keyframes txb-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

/* LA CABECERA DEL CAJÓN — TRES CASILLAS CON NOMBRE, Y NINGÚN BOTÓN QUE SE
   MUEVA POR CULPA DE UN TEXTO.

   DEFECTO REAL, VISTO EN CHROME A 1440 px. El aviso llevaba
   \`text-overflow: ellipsis\` pero NO \`white-space: nowrap\`, así que los puntos
   suspensivos no entraban NUNCA: el texto se partía en dos líneas dentro de la
   casilla del medio, la fila crecía con él y \`align-items: center\` dejaba
   «‹ Volver» y la ✕ flotando en mitad de un bloque de texto. Peor todavía: la
   altura de la cabecera pasaba a depender de la LONGITUD DEL AVISO DE CADA
   LOCAL —medido: 62 px con el aviso largo, 61 px con el corto—, de modo que el
   título «Elige fecha y hora» empezaba en un sitio distinto en cada página.

   EL AVISO NO SE QUITA: SE COLOCA. Es la única señal de «esto no existe» que
   queda a la vista mientras el cajón tapa y deja inerte la página, y el
   validador de contenido obliga a que cada local escriba el suyo. Lo que se
   arregla es dónde vive.

   POR DEFECTO OCUPA UNA FILA ENTERA, DEBAJO DE LOS BOTONES. Es la única
   colocación que no depende de cuánto escriba un local: los dos botones se
   quedan anclados a los extremos de SU fila, con su altura de objetivo táctil,
   y el aviso crece hacia abajo sin tocarlos. Medido en Chrome: a 390 px el
   aviso necesita dos líneas en los dos locales y «‹ Volver» y la ✕ siguen
   exactamente en el mismo sitio (centro vertical 30 px), que es justo lo que
   antes no pasaba.

   LA FILA ÚNICA ES UN LUJO QUE SÓLO SE PERMITE DONDE CABE, y quién decide es
   la anchura del CAJÓN, no la del texto: ver \`@media (min-width: 1400px)\` en
   el bloque de adaptación. Las casillas van por NOMBRE (\`grid-template-areas\`)
   para que ese cambio sea una línea de hoja de estilos y no un cambio de
   marcado.

   \`nowrap\`/\`ellipsis\` se declaran allí, con la fila única, que es la única
   situación en la que cortar tiene sentido. Aquí abajo el aviso se lee
   entero. */
.txb-drawer__bar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas:
    "volver .     cerrar"
    "aviso  aviso aviso";
  align-items: center;
  column-gap: var(--txb-space-3);
  row-gap: var(--txb-space-1);
  min-height: calc(var(--txb-tap) + var(--txb-space-4));
  padding: var(--txb-space-2) var(--txb-space-4);
  background: var(--txb-canvas-band);
  border-bottom: 1px solid var(--txb-line);
}
.txb-drawer__back { grid-area: volver; justify-self: start; }
.txb-drawer__close { grid-area: cerrar; justify-self: end; }
.txb-drawer__demo {
  grid-area: aviso;
  text-align: center;
  color: var(--txb-ink-700);
  font-size: var(--txb-fs-eyebrow);
  font-weight: 600;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
}
.txb-drawer__body {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--txb-space-6) var(--txb-space-5);
}
.txb-drawer__foot {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-3);
  padding: var(--txb-space-4) var(--txb-space-5) calc(var(--txb-space-4) + env(safe-area-inset-bottom));
  background: var(--txb-surface);
  border-top: 1px solid var(--txb-line);
  box-shadow: var(--txb-shadow-2);
}
.txb-drawer__foot .txb-btn { min-height: 52px; }

/* ══════════════════════════════════════════════════════════════════ */
/* CALENDARIO, DÍAS, HUECOS Y PAGO (dentro del cajón)                  */
/* ══════════════════════════════════════════════════════════════════ */

.txb-calendar {
  width: 100%;
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-md);
  background: var(--txb-surface);
  padding: var(--txb-space-4);
}
.txb-calendar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--txb-space-2);
  margin-bottom: var(--txb-space-3);
}
.txb-calendar__head .txb-btn { padding-inline: var(--txb-space-3); }
.txb-calendar__title {
  font-family: var(--txb-font-display);
  font-weight: 700;
  font-size: 1.0625rem;
  text-align: center;
}
table.txb-month-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.txb-month-grid th,
table.txb-month-grid td { text-align: center; padding: 2px; }
table.txb-month-grid th {
  color: var(--txb-ink-500);
  font-weight: 700;
  font-size: var(--txb-fs-eyebrow);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding-bottom: var(--txb-space-2);
}
table.txb-month-grid th abbr { text-decoration: none; }
.txb-day-btn {
  width: 100%;
  min-width: var(--txb-tap);
  min-height: var(--txb-tap);
  border: 1px solid transparent;
  border-radius: var(--txb-radius-sm);
  background: transparent;
  cursor: pointer;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--txb-ink-900);
  transition: background-color var(--txb-dur-1) var(--txb-ease), border-color var(--txb-dur-1) var(--txb-ease);
}
.txb-day-btn:hover:not(:disabled) { border-color: var(--txb-line-strong); background: var(--txb-canvas-alt); }
.txb-day-btn[aria-pressed="true"] {
  background: var(--txb-accent-700);
  border-color: var(--txb-accent-700);
  color: #fff;
}
.txb-day-btn:disabled { color: var(--txb-line-strong); cursor: not-allowed; }

/* El interruptor de jornada completa, dibujado sobre el mismo
   \`<input type="checkbox">\` de siempre: sin JavaScript y sin cambiar el
   marcado, sólo \`appearance: none\` y un pulgar que se desliza. */
.txb-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--txb-space-3);
  min-height: var(--txb-tap);
  cursor: pointer;
  font-size: var(--txb-fs-small);
  font-weight: 600;
  color: var(--txb-ink-700);
}
.txb-switch input {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  flex: 0 0 auto;
  width: 44px;
  height: 24px;
  margin: 0;
  border-radius: var(--txb-radius-pill);
  background: var(--txb-canvas-band);
  box-shadow: inset 0 0 0 1px var(--txb-line-strong);
  cursor: pointer;
  transition: background-color var(--txb-dur-1) var(--txb-ease), box-shadow var(--txb-dur-1) var(--txb-ease);
}
.txb-switch input::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--txb-surface);
  box-shadow: var(--txb-shadow-1);
  transition: transform var(--txb-dur-2) var(--txb-ease);
}
.txb-switch input:checked {
  background: var(--txb-accent-700);
  box-shadow: inset 0 0 0 1px var(--txb-accent-700);
}
.txb-switch input:checked::after { transform: translateX(20px); }

.txb-slots-blocks {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--txb-space-4);
}
.txb-slots-blocks > * { min-width: 0; }
.txb-slots-block {
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-md);
  background: var(--txb-surface);
  padding: var(--txb-space-3);
  overflow-x: auto;
}
.txb-slots-block__title {
  font-weight: 700;
  font-size: var(--txb-fs-small);
  font-variant-numeric: tabular-nums;
  margin-bottom: var(--txb-space-3);
  color: var(--txb-ink-700);
}
table.txb-slots-table { width: 100%; border-collapse: collapse; font-size: var(--txb-fs-small); }
table.txb-slots-table th,
table.txb-slots-table td {
  border-bottom: 1px solid var(--txb-line);
  padding: var(--txb-space-1);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
table.txb-slots-table th {
  color: var(--txb-ink-500);
  font-weight: 700;
  font-size: var(--txb-fs-eyebrow);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
table.txb-slots-table th:first-child,
table.txb-slots-table td:first-child { text-align: left; white-space: nowrap; font-weight: 600; }

/* ══════════════════════════════════════════════════════════════════════
 * UNA SOLA COLUMNA: FICHAS DE HORA, NO UNA HOJA DE CÁLCULO
 *
 * QUÉ PASABA. Cuando el cliente pregunta por UNA sola persona, la tabla se
 * queda en dos columnas —hora y persona— y N filas, y eso en pantalla es una
 * lista vertical de «09:00 ✓ / 09:30 ✓ / 10:00 ✓» que ocupa media ventana y
 * se lee como la exportación de una hoja de cálculo. No es una tabla
 * comparativa: no hay nada que comparar con una sola columna.
 *
 * QUÉ SE HACE. El cliente MARCA ese caso con
 * \`.txb-slots-table--una-columna\` (lo decide el servidor, en \`byEmployee\`) y
 * aquí se presenta como una rejilla fluida de fichas de hora: cada fila pasa a
 * ser una ficha con la hora encima y su hueco debajo, y caben las que quepan a
 * lo ancho del bloque. La vista de varias personas NO entra por aquí y sigue
 * siendo una tabla dibujada como tabla, que es lo que le toca.
 *
 * ─── QUÉ LE PASA AL ÁRBOL DE ACCESIBILIDAD, MEDIDO Y NO SUPUESTO ───
 * Cambiar \`display\` en elementos de tabla es la maniobra que clásicamente les
 * quitaba su papel, así que aquí no se ha dado por buena: se ha LEÍDO el árbol
 * de accesibilidad de Chrome sobre la página viva, con el modificador puesto y
 * sin él, y el árbol sale IDÉNTICO. Con la rejilla dibujada como fichas siguen
 * expuestos \`table\`, \`row\`, \`cell\` y \`columnheader\` de las dos tablas, los dos
 * encabezados («Hora» y el nombre de la persona) y los dieciséis huecos con su
 * nombre entero. Cero nodos perdidos.
 *
 * Y AUNQUE OTRO MOTOR SÍ LOS PERDIERA —esto se ha comprobado en Blink, no en
 * WebKit ni en Gecko—, la información no se va con ellos, porque no vivía en
 * la estructura de la tabla:
 *   1. CADA HUECO SE NOMBRA SOLO. El botón lleva \`aria-label\` propio y
 *      completo —«Disponible 09:00 con Fulano», «No disponible 12:30 con
 *      Fulano»—, escrito por el cliente para las DOS vistas. Su nombre
 *      accesible no dependía de la cabecera antes y no depende de ella ahora:
 *      ningún control pierde nombre, ni el disponible ni el que no lo está.
 *   2. LA CABECERA NO SE BORRA. El nombre de la persona se queda A LA VISTA
 *      como rótulo del bloque, y el rótulo «Hora» —que sobre una rejilla de
 *      horas no dice nada nuevo— se retira de la VISTA con el mismo recurso
 *      que \`.txb-visually-hidden\`, no del árbol. Aquí no hay un solo
 *      \`display: none\`, que es lo que sí lo habría sacado.
 *   3. EL TRAMO SIGUE ROTULADO. El \`<p class="txb-slots-block__title">\` de
 *      arriba («Mañana · 09:00–14:00») no se toca.
 * ══════════════════════════════════════════════════════════════════════ */
table.txb-slots-table--una-columna { display: block; }
table.txb-slots-table--una-columna thead,
table.txb-slots-table--una-columna thead tr { display: block; }
table.txb-slots-table--una-columna thead th {
  display: block;
  border-bottom: 0;
  padding: 0 0 var(--txb-space-3);
  text-align: left;
}
table.txb-slots-table--una-columna thead th:first-child {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
table.txb-slots-table--una-columna tbody {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr));
  gap: var(--txb-space-4) var(--txb-space-2);
}
table.txb-slots-table--una-columna tbody tr {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--txb-space-1);
  min-width: 0;
}
table.txb-slots-table--una-columna tbody td {
  display: block;
  border-bottom: 0;
  padding: 0;
  text-align: center;
}
/* La hora manda en la ficha: es lo que se está eligiendo, así que sube a
   tamaño de texto corrido y a tinta plena en vez de quedarse en el gris
   pequeño que le tocaba como celda de tabla. */
table.txb-slots-table--una-columna tbody td:first-child {
  text-align: center;
  font-size: var(--txb-fs-body);
  font-weight: 700;
  line-height: 1.2;
  color: var(--txb-ink-900);
}
/* El hueco ocupa la ficha entera: el objetivo táctil crece con la columna y
   nunca baja de \`--txb-tap\`, que es lo que garantiza su \`min-height\`. */
table.txb-slots-table--una-columna .txb-slot-btn { width: 100%; }

.txb-slot-btn {
  min-width: var(--txb-tap);
  min-height: var(--txb-tap);
  border: 1px solid var(--txb-line-strong);
  border-radius: var(--txb-radius-sm);
  background: var(--txb-surface);
  cursor: pointer;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--txb-green-700);
  transition: background-color var(--txb-dur-1) var(--txb-ease), border-color var(--txb-dur-1) var(--txb-ease);
}
.txb-slot-btn:hover:not(:disabled) { border-color: var(--txb-accent-700); background: var(--txb-accent-50); }
.txb-slot-btn[aria-pressed="true"] {
  background: var(--txb-accent-700);
  border-color: var(--txb-accent-700);
  color: #fff;
}
.txb-slot-btn:disabled {
  color: var(--txb-line-strong);
  border-style: dashed;
  cursor: not-allowed;
  background: var(--txb-canvas-alt);
}
.txb-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--txb-space-2) var(--txb-space-4);
  color: var(--txb-ink-500);
  font-size: 0.8125rem;
}
.txb-legend__mark { font-weight: 700; }
.txb-legend__mark--ok { color: var(--txb-green-700); }
.txb-legend__mark--no { color: var(--txb-line-strong); }

.txb-payment {
  width: 100%;
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-md);
  background: var(--txb-surface);
  padding: var(--txb-space-4);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--txb-space-3);
}
.txb-payment legend {
  font-weight: 700;
  padding: 0;
  font-size: var(--txb-fs-small);
}
.txb-payment-option {
  display: flex;
  align-items: flex-start;
  gap: var(--txb-space-3);
  border: 1px solid var(--txb-line-strong);
  border-radius: var(--txb-radius-md);
  padding: var(--txb-space-3);
  min-height: var(--txb-tap);
  cursor: pointer;
  transition: border-color var(--txb-dur-1) var(--txb-ease), background-color var(--txb-dur-1) var(--txb-ease);
}
.txb-payment-option input {
  width: 20px;
  height: 20px;
  margin: 2px 0 0;
  accent-color: var(--txb-accent-700);
  flex: 0 0 auto;
}
.txb-payment-option:hover { border-color: var(--txb-accent-700); }
.txb-payment-option:has(input:checked) {
  border-color: var(--txb-accent-700);
  background: var(--txb-accent-50);
  box-shadow: inset 0 0 0 1px var(--txb-accent-700);
}
.txb-payment-option__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.txb-payment-option__title { font-weight: 700; font-size: var(--txb-fs-small); }
.txb-payment-option__note {
  color: var(--txb-ink-500);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}

/* ══════════════════════════════════════════════════════════════════ */
/* 6 · INFORMACIÓN PRÁCTICA                                            */
/* ══════════════════════════════════════════════════════════════════ */

/* El \`min()\` del \`minmax\` no es adorno: un \`minmax(300px, 1fr)\` a secas fija
   un suelo de 300 px que por debajo de 320 px de ventana no cabe en la columna
   —quedan 273 útiles— y empuja el DOCUMENTO ENTERO 11 px de lado. Medido en
   Chrome a 320 px, y venía de antes de esta revisión. Con \`min(300px, 100%)\`
   el suelo cede antes que la página. */
.txb-info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
  gap: var(--txb-space-6);
  align-items: start;
}
.txb-info-grid > * { min-width: 0; }
.txb-info-panel {
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-4);
  background: var(--txb-surface);
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-lg);
  box-shadow: var(--txb-shadow-1);
  padding: var(--txb-space-6);
}
.txb-info-panel h3 {
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--txb-ink-500);
}
.txb-info-panel dl {
  display: flex;
  flex-direction: column;
  margin: 0;
}
.txb-info-panel p { color: var(--txb-ink-700); font-size: var(--txb-fs-small); }
/* El dato práctico es PROSA: rótulo arriba y texto debajo, alineado a la
   izquierda. Compartir la fila del horario le ponía el texto en bandera
   derecha y se leía como un error de composición. */
.txb-info-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--txb-space-1);
  padding-block: var(--txb-space-4);
  border-bottom: 1px solid var(--txb-line);
}
.txb-horario__fila {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--txb-space-2) var(--txb-space-4);
  padding-block: var(--txb-space-3);
  border-bottom: 1px solid var(--txb-line);
}
.txb-info-item:last-child,
.txb-horario__fila:last-child { border-bottom: 0; }
.txb-info-item dt,
.txb-horario__dia {
  color: var(--txb-ink-500);
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.txb-horario__dia {
  font-size: var(--txb-fs-small);
  letter-spacing: 0;
  text-transform: none;
  font-weight: 600;
}
.txb-info-item dd {
  color: var(--txb-ink-700);
  font-size: var(--txb-fs-small);
  max-width: var(--txb-measure);
}
.txb-horario__tramos {
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}
.txb-horario--cerrado .txb-horario__dia,
.txb-horario--cerrado .txb-horario__tramos {
  color: var(--txb-ink-500);
  font-weight: 400;
}

/* ══════════════════════════════════════════════════════════════════ */
/* 7 · PREGUNTAS FRECUENTES — acordeón nativo                          */
/* ══════════════════════════════════════════════════════════════════ */

.txb-faq {
  max-width: 820px;
  margin-inline: auto;
  background: var(--txb-surface);
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-lg);
  box-shadow: var(--txb-shadow-1);
  overflow: hidden;
}
.txb-faq__item { border-bottom: 1px solid var(--txb-line); }
.txb-faq__item:last-child { border-bottom: 0; }
.txb-faq__q {
  display: flex;
  align-items: center;
  gap: var(--txb-space-4);
  min-height: 56px;
  padding: var(--txb-space-3) var(--txb-space-5);
  cursor: pointer;
  font-weight: 700;
  list-style: none;
  color: var(--txb-ink-900);
}
.txb-faq__q::-webkit-details-marker { display: none; }
.txb-faq__q::after {
  content: "\\203A";
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 1.5rem;
  line-height: 1;
  color: var(--txb-accent-700);
  transition: transform var(--txb-dur-2) var(--txb-ease);
}
.txb-faq__q:hover { background: var(--txb-canvas-alt); }
.txb-faq__item[open] .txb-faq__q::after { transform: rotate(90deg); }
.txb-faq__a {
  padding: 0 var(--txb-space-5) var(--txb-space-5);
  color: var(--txb-ink-700);
}

/* ══════════════════════════════════════════════════════════════════ */
/* CONFIRMACIÓN, AVISOS Y DISTINTIVOS DE ESTADO                        */
/* ══════════════════════════════════════════════════════════════════ */

/* Los distintivos de estado del pago se distinguen por FORMA además de por
   color (señal no cromática, WCAG): relleno continuo para «Pagada (demo)»,
   contorno discontinuo para «Pendiente en local». */
.txb-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--txb-space-1);
  border-radius: var(--txb-radius-pill);
  padding: 2px var(--txb-space-3);
  font-size: 0.8125rem;
  font-weight: 700;
  white-space: nowrap;
}
.txb-pill--paid { color: var(--txb-green-700); background: var(--txb-green-50); border: 1px solid var(--txb-green-700); }
.txb-pill--pending { color: var(--txb-amber-800); background: var(--txb-amber-50); border: 1px dashed var(--txb-amber-800); }

.txb-confirm { gap: var(--txb-space-4); }
.txb-confirm__messages { display: flex; flex-direction: column; gap: var(--txb-space-1); }
.txb-confirm-table { border-collapse: collapse; width: 100%; }
.txb-confirm-table td {
  padding: var(--txb-space-2) var(--txb-space-3);
  border-bottom: 1px solid var(--txb-line);
  font-variant-numeric: tabular-nums;
}
.txb-confirm-table td:first-child {
  color: var(--txb-ink-500);
  width: 40%;
  font-size: var(--txb-fs-small);
  font-variant-numeric: normal;
}

.txb-status-line {
  border-radius: var(--txb-radius-md);
  padding: var(--txb-space-3) var(--txb-space-4);
  font-weight: 600;
  font-size: var(--txb-fs-small);
}
.txb-status-line--error { background: var(--txb-red-50); color: var(--txb-red-700); border: 1px solid var(--txb-red-700); }
.txb-status-line--ok { background: var(--txb-green-50); color: var(--txb-green-700); border: 1px solid var(--txb-green-700); }

/* ══════════════════════════════════════════════════════════════════ */
/* EL PANEL DE LA DEMOSTRACIÓN                                         */
/* ══════════════════════════════════════════════════════════════════ */

#txb-vista-dashboard { padding-block: var(--txb-section-y); }
.txb-dashboard-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--txb-space-3);
  margin-bottom: var(--txb-space-6);
}
/* La tabla ancha se desplaza DENTRO de su contenedor: nunca arrastra la
   página de lado. */
.txb-table-scroll {
  overflow-x: auto;
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-lg);
  background: var(--txb-surface);
}
table.txb-table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  background: var(--txb-surface);
}
table.txb-table th,
table.txb-table td {
  text-align: left;
  padding: var(--txb-space-3);
  border-bottom: 1px solid var(--txb-line);
  font-size: 0.9375rem;
  font-variant-numeric: tabular-nums;
}
table.txb-table tr:last-child td { border-bottom: 0; }
table.txb-table th {
  color: var(--txb-ink-500);
  font-weight: 700;
  font-size: var(--txb-fs-eyebrow);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: var(--txb-canvas-alt);
  font-variant-numeric: normal;
}
.txb-totals {
  display: flex;
  gap: var(--txb-space-8);
  margin-top: var(--txb-space-5);
  flex-wrap: wrap;
}
.txb-totals dt {
  color: var(--txb-ink-500);
  font-size: var(--txb-fs-eyebrow);
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.txb-totals dd {
  margin: 0;
  font-weight: 700;
  font-size: 1.25rem;
  font-variant-numeric: tabular-nums;
}

/* ══════════════════════════════════════════════════════════════════ */
/* DIÁLOGO DE REINICIO                                                 */
/* ══════════════════════════════════════════════════════════════════ */

dialog.txb-dialog {
  margin: auto;
  border: 1px solid var(--txb-line);
  border-radius: var(--txb-radius-lg);
  padding: var(--txb-space-6);
  max-width: min(420px, calc(100vw - 2 * var(--txb-space-4)));
  background: var(--txb-surface);
  color: var(--txb-ink-900);
  box-shadow: var(--txb-shadow-3);
}
dialog.txb-dialog h2 { margin-bottom: var(--txb-space-3); }
dialog.txb-dialog p { color: var(--txb-ink-700); font-size: var(--txb-fs-small); }
dialog.txb-dialog::backdrop { background: rgba(18, 16, 14, 0.52); }
.txb-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--txb-space-3);
  margin-top: var(--txb-space-5);
  justify-content: flex-end;
}

/* ══════════════════════════════════════════════════════════════════ */
/* PIE — la segunda banda oscura                                       */
/* ══════════════════════════════════════════════════════════════════ */

.txb-footer {
  background: var(--txb-ink-950);
  color: var(--txb-on-dark);
  padding-block: var(--txb-space-12);
  border-top: 1px solid var(--txb-on-dark-line);
}
.txb-footer > .txb-wrap {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1.4fr);
  gap: var(--txb-space-8);
  align-items: start;
}
.txb-footer__col,
.txb-footer__meta {
  display: flex;
  flex-direction: column;
  gap: var(--txb-space-3);
  min-width: 0;
}
.txb-footer__col p:first-child {
  font-family: var(--txb-font-display);
  font-size: var(--txb-fs-h3);
  font-weight: 700;
  color: var(--txb-on-dark);
}
.txb-footer__col p,
.txb-footer__meta p {
  color: var(--txb-on-dark-muted);
  font-size: var(--txb-fs-small);
}
.txb-footer__meta { align-items: flex-start; }

/* Los dos conmutadores de vista viven aquí, discretos: una pestaña «Panel de
   reservas» al lado de la marca era lo que más gritaba «herramienta interna»
   en el escaparate. Siguen siendo los mismos botones con \`aria-pressed\`. */
.txb-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--txb-space-2);
}
.txb-tab {
  display: inline-flex;
  align-items: center;
  min-height: var(--txb-tap);
  border: 1px solid var(--txb-line-strong);
  background: var(--txb-surface);
  color: var(--txb-ink-900);
  border-radius: var(--txb-radius-pill);
  padding: var(--txb-space-2) var(--txb-space-4);
  cursor: pointer;
  font-size: var(--txb-fs-small);
  font-weight: 600;
}
.txb-tab[aria-pressed="true"] {
  background: var(--txb-accent-700);
  color: #fff;
  border-color: var(--txb-accent-700);
}
.txb-footer .txb-tab {
  background: transparent;
  border-color: var(--txb-on-dark-line);
  color: var(--txb-on-dark-muted);
  border-radius: var(--txb-radius-md);
  font-size: 0.8125rem;
}
.txb-footer .txb-tab:hover { color: var(--txb-on-dark); border-color: var(--txb-on-dark-muted); }
.txb-footer .txb-tab[aria-pressed="true"] {
  background: var(--txb-on-dark-line);
  color: var(--txb-on-dark);
  border-color: var(--txb-on-dark-muted);
}

/* ══════════════════════════════════════════════════════════════════ */
/* ADAPTACIÓN — 1140 · 900 · 768 · 560                                 */
/* ══════════════════════════════════════════════════════════════════ */

/* El lema de la cabecera es lo primero que sobra cuando el ancho aprieta: la
   navegación y el botón de reserva pesan más, y un local con nombre largo y
   rótulos largos no cabe con las tres cosas. */
@media (max-width: 1279px) {
  .txb-subtitle { display: none; }
}

@media (max-width: 1139px) and (min-width: 900px) {
  dialog.txb-drawer { width: min(640px, 68vw); }
}

/* LA CABECERA DEL CAJÓN EN UNA SOLA FILA — SÓLO CON EL CAJÓN ENTERO DELANTE.

   El cajón mide \`min(720px, 52vw)\`, así que sólo llega a su anchura máxima a
   partir de ~1385 px de ventana; por debajo de eso ES MÁS ESTRECHO QUE A
   1440 px, aunque el número de la ventana sea mayor que el de cualquier otro
   punto de corte de esta hoja. Ése fue el error de la primera versión de esta
   regla: dar por hecho que «pantalla grande» significaba «cajón ancho». Medido
   en Chrome, con la fila única el aviso largo se cortaba 6 px a 1280 y 78 px a
   1140, y no se cortaba a 1440.

   Con el corte puesto donde el cajón YA está tope de ancho, el hueco del medio
   son 552 px medidos, y los avisos de los dos locales entran de una línea
   —503 px el largo, 409 px el corto— con margen. Ahí la cabecera se lee como
   una cabecera: «‹ Volver», el aviso y la ✕ en la misma línea, los tres con el
   mismo centro vertical, 60 px de alto exactos en los dos locales y con
   cualquier aviso, porque quien manda en la altura es el objetivo táctil de
   los botones y no el texto.

   \`nowrap\` va aquí y no en la regla base a propósito: es lo que hace que
   \`text-overflow: ellipsis\` sirva de algo. Sin él los puntos suspensivos son
   decorativos —el texto se parte antes de llegar a desbordar— y era
   exactamente el defecto que se estaba arreglando. Y es una red de seguridad,
   no el funcionamiento normal: si algún día un local escribe un aviso que ni
   siquiera cabe en 552 px, se corta aquí en vez de descolocar los botones, y
   el texto entero sigue estando en la franja superior de la página. */
@media (min-width: 1400px) {
  .txb-drawer__bar { grid-template-areas: "volver aviso cerrar"; }
  .txb-drawer__demo { white-space: nowrap; }
}

@media (max-width: 899px) {
  :root { --txb-nav-h: 72px; }

  /* La lista de enlaces se pliega en el botón de menú. */
  .txb-nav > .txb-nav__list { display: none; }
  .txb-nav__toggle { display: inline-flex; }
  .txb-nav__list { flex-wrap: wrap; }

  .txb-hero > .txb-wrap {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--txb-space-10);
    min-height: 0;
  }
  .txb-hero__aside { padding: var(--txb-space-6); }
  .txb-hero__emblem { max-width: 240px; }

  .txb-layout { grid-template-columns: minmax(0, 1fr); gap: var(--txb-space-6); }
  .txb-summary { position: static; }

  .txb-footer > .txb-wrap { grid-template-columns: minmax(0, 1fr); gap: var(--txb-space-6); }

  /* HOJA INFERIOR: el cajón sube desde abajo y deja ver la página encima. */
  dialog.txb-drawer {
    inset: auto 0 0 0;
    width: 100%;
    height: auto;
    max-height: 92vh;
    max-height: 92dvh;
    border-radius: var(--txb-radius-xl) var(--txb-radius-xl) 0 0;
  }
  dialog.txb-drawer[open] { animation-name: txb-drawer-in-y; }
}

@media (min-width: 900px) {
  /* A partir de aquí la franja de demostración SÍ se pega, y la cabecera se
     pega justo debajo. Se le fija una altura exacta y una sola línea: si un
     local escribiera un aviso larguísimo y la franja creciera, el desfase de
     la cabecera dejaría de cuadrar y taparía media franja. Con altura fija
     eso no puede pasar, y el aviso completo sigue estando en el pie y en la
     cabecera del cajón. */
  :root {
    --txb-topbar-top: var(--txb-demobar-h);
    --txb-bars-h: calc(var(--txb-demobar-h) + var(--txb-nav-h));
  }
  .txb-demobar {
    position: sticky;
    top: 0;
    display: block;
    height: var(--txb-demobar-h);
    line-height: calc(var(--txb-demobar-h) - 1px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Si el cliente dejó el menú desplegado y la ventana crece, no puede
     quedarse una capa colgando sobre la página. */
  .txb-nav__menu { display: none; }
}

@media (max-width: 767px) {
  .txb-steps { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--txb-space-1); }
  .txb-steps > li { flex-direction: column; align-items: flex-start; gap: var(--txb-space-1); font-size: 0.75rem; }
  .txb-step__label { max-width: 100%; }

  .txb-content { padding: var(--txb-space-4); }
  .txb-ficha { padding: var(--txb-space-5); }
  .txb-info-panel { padding: var(--txb-space-5); }

  /* La tira de días se desplaza DENTRO de su fila, con anclaje, y nunca
     arrastra el documento de lado. */
  #txb-dia-chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding-bottom: var(--txb-space-2);
    scrollbar-width: thin;
  }
  #txb-dia-chips > .txb-chip { scroll-snap-align: start; flex: 0 0 auto; }

  /* La barra inferior de reserva: sólo aquí, y por encima de la zona
     segura del dispositivo. */
  .txb-cta-movil {
    display: inline-flex;
    position: fixed;
    left: var(--txb-gutter);
    right: var(--txb-gutter);
    bottom: calc(var(--txb-space-3) + env(safe-area-inset-bottom));
    z-index: 40;
    min-height: 52px;
    box-shadow: var(--txb-shadow-2);
  }
  /* Y el pie se aparta para que no le tape la última línea. */
  .txb-footer { padding-bottom: calc(var(--txb-space-20) + env(safe-area-inset-bottom)); }
}

@media (max-width: 559px) {
  :root { --txb-demobar-h: 28px; --txb-nav-h: 64px; }

  .txb-demobar { font-size: 0.75rem; }

  /* A esta anchura el botón de reserva SALE de la barra: ya vive abajo, fijo
     y a lo ancho, y dejarlo arriba obligaba a la marca a encogerse hasta lo
     ilegible o a empujar la navegación fuera de la ventana. */
  .txb-nav > .txb-btn { display: none; }

  .txb-hero__actions { flex-direction: column; align-items: stretch; }
  .txb-hero__actions .txb-btn { width: 100%; }
  .txb-ficha__medallon { width: 72px; height: 72px; font-size: 1.875rem; }
  .txb-tile-grid { grid-template-columns: minmax(0, 1fr); gap: var(--txb-space-4); }
  .txb-content .txb-tile-grid { grid-template-columns: minmax(0, 1fr); }
  .txb-ficha-grid { grid-template-columns: minmax(0, 1fr); }
  .txb-pasos { grid-template-columns: minmax(0, 1fr); gap: var(--txb-space-8); }
  .txb-faq__q { padding-inline: var(--txb-space-4); }
  .txb-faq__a { padding-inline: var(--txb-space-4); }
  .txb-calendar { padding: var(--txb-space-3); }
  .txb-drawer__body { padding: var(--txb-space-4) var(--txb-space-4); }
  .txb-drawer__foot { padding-inline: var(--txb-space-4); }

  /* PANTALLA COMPLETA: por debajo de este ancho una hoja inferior deja una
     franja inútil arriba y esconde el botón de confirmar. */
  dialog.txb-drawer {
    inset: 0;
    width: 100%;
    height: 100vh;
    height: 100dvh;
    max-height: 100dvh;
    border-radius: 0;
  }
}

/* ══════════════════════════════════════════════════════════════════ */
/* EL ANILLO DE FOCO — DOBLE, Y AL FINAL DE LA HOJA A PROPÓSITO        */
/*                                                                     */
/* Va aquí, después de TODO lo demás, por una razón que costó un        */
/* defecto real: el aro exterior es un \`box-shadow\`, y cualquier regla  */
/* posterior que declare \`box-shadow\` en el mismo elemento lo borra sin */
/* avisar. \`.txb-btn\` declara su propia sombra de reposo, así que con   */
/* el bloque de foco arriba el botón de acento —el control más          */
/* importante de la página— se quedaba con media anilla y sin el aro    */
/* que le da el contraste. Declarándolo al final, y repitiéndolo con la */
/* especificidad justa en las piezas que tienen sombra propia, no hay   */
/* ninguna combinación de estados que pueda dejar el foco invisible.    */
/*                                                                     */
/* POR QUÉ DOS AROS. El anterior era un solo trazo de tinta: sobre el   */
/* botón cobre daba 2,88:1 y sobre el índigo 1,99:1, por debajo del 3:1 */
/* que exige la SC 1.4.11. Éste lleva una banda clara pegada al         */
/* elemento y un aro oscuro por fuera, de colores opuestos, así que     */
/* siempre hay un tramo con contraste de sobra contra lo que tenga      */
/* detrás: 6,22:1 del blanco contra el cobre y 16,01:1 de la tinta      */
/* contra el marfil; 8,98:1 y 15,81:1 en el tema índigo. Sobre la banda */
/* oscura los dos colores se intercambian solos (ver \`.txb-on-dark\`).   */
/* ══════════════════════════════════════════════════════════════════ */

:focus-visible {
  outline: 2px solid var(--txb-focus-ring-inner);
  outline-offset: 0;
  box-shadow: 0 0 0 4px var(--txb-focus-ring);
}

/* ── UN DESTINO DE NAVEGACIÓN NO ES UN CONTROL, Y NO LLEVA SU ANILLO ──
 *
 * En este documento \`tabindex="-1"\` significa UNA sola cosa: «el cliente
 * te va a traer el foco aquí al cambiar de paso». Lo llevan los seis
 * encabezados de paso —\`txb-titulo\`, \`txb-paso-servicio-titulo\`,
 * \`txb-paso-profesional-titulo\`, \`txb-paso-fecha-hora-titulo\`,
 * \`txb-paso-confirmacion-titulo\`, \`txb-dashboard-titulo\`— y el \`<main>\`,
 * que es a donde salta el enlace de saltar al contenido. Ninguno es
 * operable: no se pulsan, no se escriben, no cambian de valor.
 *
 * EL DEFECTO QUE CIERRA ESTA REGLA (visto en Chrome real): con el anillo
 * universal, avanzar de paso dibujaba un RECUADRO NEGRO ceñido al texto del
 * titular —«Elige un servicio», «Elige fecha y hora»—, y en el caso del
 * \`<main>\` habría encajonado la página entera al usar el enlace de salto.
 * En pantalla no se lee como una ayuda: se lee como un error de maquetación.
 *
 * POR QUÉ NO ES UNA REGRESIÓN DE ACCESIBILIDAD:
 *   1. El criterio 2.4.7 «Foco visible» exige el indicador en los COMPONENTES
 *      DE INTERFAZ OPERABLES CON TECLADO. Un encabezado que sólo recibe el
 *      foco por programa no lo es, y 2.4.11 y 2.4.13 hablan de lo mismo.
 *   2. Con \`tabindex="-1"\` estos nodos NO están en la secuencia de tabulación:
 *      nadie puede aterrizar en ellos tabulando. Sólo llegan porque el cliente
 *      los enfoca, y en ese instante el documento SE DESPLAZA hasta el paso
 *      nuevo y el lector de pantalla ANUNCIA el encabezado —que además rotula
 *      su sección con \`aria-labelledby\`—, aparte del aviso de \`txb-anuncio\`
 *      en su región \`aria-live\`. El salto se percibe por tres vías distintas.
 *   3. El siguiente Tab sigue desde ahí y cae en un control de verdad, que sí
 *      luce el anillo doble entero.
 * Los controles no se tocan: botones, enlaces, chips, huecos, días, radios,
 * interruptor, \`summary\` y el enlace de salto conservan el anillo verificado,
 * incluida su inversión sobre banda oscura y su realce dentro de la rejilla.
 * La región desplazable del panel lleva \`tabindex="0"\` —se maneja con las
 * flechas, es operable— y por eso queda FUERA de esta regla y mantiene su aro.
 */
[tabindex="-1"]:focus,
[tabindex="-1"]:focus-visible {
  outline: none;
  box-shadow: none;
}
/* Mismo razonamiento para el panel en sí: si \`showModal()\` no encuentra
   dentro nada que enfocar, el foco recae en el propio \`<dialog>\`, que tampoco
   es un control. Se le quita el aro y se le devuelve SU sombra, que es
   elevación y no indicador de foco. */
dialog:focus,
dialog:focus-visible { outline: none; }
dialog.txb-drawer:focus-visible,
dialog.txb-dialog:focus-visible { box-shadow: var(--txb-shadow-3); }

/* Las piezas que tienen sombra propia (de reposo o de \`:hover\`) vuelven a
   pedir el aro con la especificidad suficiente para ganarla. */
.txb-btn:focus-visible:not(:disabled),
.txb-tab:focus-visible:not(:disabled),
.txb-tile:is(button):focus-visible:not(:disabled),
.txb-chip:is(button):focus-visible:not(:disabled),
.txb-slot-btn:focus-visible:not(:disabled),
.txb-day-btn:focus-visible:not(:disabled) {
  box-shadow: 0 0 0 4px var(--txb-focus-ring);
}
.txb-skip:focus-visible { box-shadow: 0 0 0 4px var(--txb-focus-ring), var(--txb-shadow-2); }

/* Y lo SELECCIONADO no deja de estarlo por recibir el foco: la marca
   interior de acento sigue ahí, con el aro alrededor. */
.txb-tile:is(button)[aria-pressed="true"]:focus-visible,
.txb-chip:is(button)[aria-pressed="true"]:focus-visible {
  box-shadow: inset 0 0 0 1px var(--txb-accent-700), 0 0 0 4px var(--txb-focus-ring);
}
.txb-switch input:focus-visible {
  box-shadow: inset 0 0 0 1px var(--txb-line-strong), 0 0 0 4px var(--txb-focus-ring);
}
.txb-switch input:checked:focus-visible {
  box-shadow: inset 0 0 0 1px var(--txb-accent-700), 0 0 0 4px var(--txb-focus-ring);
}

/* Dentro de una rejilla, el aro de 4 px no lo puede recortar la celda
   vecina: el elemento enfocado se pone por delante. */
.txb-day-btn:focus-visible,
.txb-slot-btn:focus-visible { position: relative; z-index: 1; }

/* ══════════════════════════════════════════════════════════════════ */
/* MOVIMIENTO                                                          */
/* ══════════════════════════════════════════════════════════════════ */

@media (prefers-reduced-motion: no-preference) {
  html { scroll-behavior: smooth; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .txb-drawer,
  .txb-drawer::backdrop {
    transition: none !important;
    transform: none !important;
  }
}
`;
