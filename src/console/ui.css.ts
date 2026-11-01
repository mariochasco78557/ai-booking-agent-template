/**
 * The console's stylesheet, served from its own route so that `style-src
 * 'self'` holds without ever needing `'unsafe-inline'`.
 *
 * step 14 rewrite per docs/operator_console/DESIGN_SPEC.md §3 (tokens),
 * §4 (app shell), §6 (components), §9 (accessibility) and §4.5 (breakpoints).
 * ONE light workspace with a dark sidebar — no theme switching. There is
 * deliberately NO `@media (prefers-color-scheme: dark)` block and NO
 * `color-scheme` declaration anywhere below (design decision, §9.8): the
 * previous dark palette was never contrast-checked and duplicating themes
 * only duplicates the surface for a contrast mistake.
 *
 * step 21A, corte 1 ((internal doc, not included in the template) §2, §3):
 * sobre los tokens CRUDOS de arriba —que conservan nombre y valor, ni uno
 * solo se renombra— se añade una CAPA DE ALIAS SEMÁNTICOS (§2.1). Los
 * componentes compartidos (concha, cabecera, paneles, botones, píldoras,
 * tablas, campos, filtros, diálogos, estados vacíos, detalle técnico y
 * líneas de estado) pasan a leer esa capa. Las secciones específicas de una
 * ruta (lista de espera, grupo, Laboratorio, taller, calendario, Equipo)
 * siguen leyendo los tokens crudos: su adopción es el corte 3 (§7.4), y
 * partirla en dos commits es lo que mantiene cada uno revisable. El único
 * valor NUEVO de todo el rediseño es `--tx-copper-800` (§2.2 nº 12).
 */
export const CONSOLE_CSS = `
/* ------------------------------------------------------------------ */
/* 3. Design tokens                                                    */
/* ------------------------------------------------------------------ */
:root {
  --tx-ink-900:      #171615;
  --tx-ink-800:      #2A2724;
  --tx-ink-700:      #3D3833;
  --tx-ink-500:      #57504A;
  --tx-ivory-50:     #F5F1E8;
  --tx-surface:      #FFFFFF;
  --tx-surface-alt:  #EFE9DD;
  --tx-sand-100:     #EBE4D6;

  --tx-line:         #D8D2C7;
  --tx-line-strong:  #7E766A;

  --tx-copper-700:   #8F4F2A;
  /* step 21A §2.2 nº 12 — el ÚNICO valor nuevo del rediseño. El hover del
     botón primario necesitaba oscurecer, no aclarar: blanco sobre
     --tx-copper-500 da 4,07 y suspende el 4,5 exigido; sobre este 8,41. */
  --tx-copper-800:   #74401F;
  --tx-copper-500:   #B86A3C;
  --tx-copper-200:   #E0A87E;
  --tx-copper-50:    #F6EAE0;

  --tx-green-700:    #1E6B3A;
  --tx-green-50:     #E4F0E7;
  --tx-amber-800:    #8A5300;
  --tx-amber-50:     #FAEFD8;
  --tx-red-700:      #B3261E;
  --tx-red-50:       #F8E6E4;
  --tx-neutral-700:  #57504A;
  --tx-neutral-50:   #EDE9E0;

  /* step 26 §8 — IDENTIDAD DE PERSONA, un rol de color nuevo y acotado: sólo
     el relleno de un bloque de cita confirmada en la agenda. Se eligen dos
     tonos que NO existen en la consola (frío y malva) precisamente para que
     no puedan confundirse con el cobre de acción ni con verde/ámbar/rojo de
     estado. El tercer tinte NO es un valor nuevo: reutiliza --tx-sand-100. */
  --tx-slate-50:     #E6ECF2;
  --tx-plum-50:      #F0E7EF;

  --tx-sidebar-bg:      #171615;
  --tx-sidebar-text:    #F5F1E8;
  --tx-sidebar-muted:   #C9C2B8;
  --tx-sidebar-active:  #332F2B;
  /* (revisión adversarial F4, H5) Era #3A3531: 1,49:1 sobre el negro cálido de
     la barra. Y por debajo de 1280 px ese filete es la ÚNICA señal visual que
     separa las seis rutas de negocio de Laboratorio (el rótulo "Herramientas
     de demostración" se oculta visualmente, aunque siga en el árbol de
     accesibilidad), así que tenía que ser honesto. Pasa al mismo valor que
     --tx-line-strong, el borde de todo control operable: 4,03:1 sobre
     --tx-sidebar-bg. Ni un color nuevo entra en la paleta. */
  --tx-sidebar-line:    #7E766A;

  --tx-focus-dark:   #171615;
  --tx-focus-light:  #F5F1E8;

  /* ---------------------------------------------------------------- */
  /* step 21A §2.1 — capa de alias semánticos                          */
  /* ---------------------------------------------------------------- */
  /* Regla dura del diseño: NO se crea un segundo universo de tokens. Todo
     lo de aquí abajo APUNTA a un token crudo de arriba; ninguno introduce
     un color propio salvo --tx-text-on-accent, que es el blanco literal
     que ya estaba escrito a mano en .tx-badge-demo, .tx-btn--primary y
     .tx-btn--danger. Los 26 pares de contraste están calculados en §2.2 del
     documento de diseño; el único por debajo de 3:1 es --tx-divider sobre
     blanco (1,50), que es decorativo y NUNCA es la única señal de nada. */
  --tx-canvas:              var(--tx-ivory-50);
  --tx-panel-bg:            var(--tx-surface);
  --tx-panel-bg-quiet:      var(--tx-surface-alt);
  --tx-notice-bg:           var(--tx-sand-100);

  --tx-text-strong:         var(--tx-ink-900);
  --tx-text-body:           var(--tx-ink-700);
  --tx-text-muted:          var(--tx-ink-500);
  --tx-text-on-accent:      #FFFFFF;
  --tx-text-on-dark:        var(--tx-sidebar-text);
  --tx-text-on-dark-muted:  var(--tx-sidebar-muted);
  /* (revisión adversarial F4, H4) El texto de un control inactivo. Apunta a un
     token crudo que ya existía —regla dura de §2.1: la capa de alias no
     inventa colores—, y da 3,71:1 sobre --tx-panel-bg-quiet, que es la
     superficie que le acompaña. Bastante para leerse, muy lejos de los 16:1
     del mismo botón cuando sí se puede pulsar. */
  --tx-text-disabled:       var(--tx-line-strong);

  --tx-divider:             var(--tx-line);
  --tx-divider-strong:      var(--tx-line-strong);

  /* El cobre es el ÚNICO color de acción de la consola (§1.1 A3). */
  --tx-action:              var(--tx-copper-700);
  --tx-action-strong:       var(--tx-copper-800);
  --tx-action-mark:         var(--tx-copper-500);
  --tx-action-bg:           var(--tx-copper-50);

  --tx-status-ok:           var(--tx-green-700);
  --tx-status-ok-bg:        var(--tx-green-50);
  --tx-status-warn:         var(--tx-amber-800);
  --tx-status-warn-bg:      var(--tx-amber-50);
  --tx-status-error:        var(--tx-red-700);
  --tx-status-error-bg:     var(--tx-red-50);
  --tx-status-neutral:      var(--tx-neutral-700);
  --tx-status-neutral-bg:   var(--tx-neutral-50);

  /* step 26 §8 — los tres alias de IDENTIDAD DE PERSONA. Se asignan por
     POSICIÓN del profesional (módulo 3), nunca por estado: el color de
     estado y el de identidad no compiten nunca en el mismo elemento (§8). */
  --tx-identity-1-bg: var(--tx-sand-100);
  --tx-identity-2-bg: var(--tx-slate-50);
  --tx-identity-3-bg: var(--tx-plum-50);

  --tx-font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --tx-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;

  --tx-size-100: 0.75rem;
  --tx-size-200: 0.8125rem;
  --tx-size-300: 0.875rem;
  --tx-size-400: 1rem;
  --tx-size-500: 1.125rem;
  --tx-size-600: 1.375rem;
  --tx-size-700: 1.75rem;
  --tx-size-800: 2.25rem;

  --tx-weight-regular: 400;
  --tx-weight-medium: 500;
  --tx-weight-semibold: 600;
  --tx-weight-bold: 700;

  --tx-leading-tight: 1.2;
  --tx-leading-normal: 1.5;
  --tx-leading-loose: 1.6;

  --tx-tracking-caps: 0.06em;

  --tx-space-1:  0.25rem;
  --tx-space-2:  0.5rem;
  --tx-space-3:  0.75rem;
  --tx-space-4:  1rem;
  --tx-space-5:  1.25rem;
  --tx-space-6:  1.5rem;
  --tx-space-8:  2rem;
  --tx-space-10: 2.5rem;
  --tx-space-12: 3rem;
  --tx-space-16: 4rem;

  --tx-radius-sm:   4px;
  --tx-radius-md:   8px;
  --tx-radius-lg:   12px;
  --tx-radius-pill: 999px;

  --tx-shadow-1: 0 1px 2px rgba(23, 22, 21, 0.06), 0 1px 1px rgba(23, 22, 21, 0.04);
  --tx-shadow-2: 0 2px 4px rgba(23, 22, 21, 0.07), 0 8px 16px -8px rgba(23, 22, 21, 0.12);
  --tx-shadow-dialog: 0 24px 48px -12px rgba(23, 22, 21, 0.35);

  /* §2.4 — mismos tres bordes, mismos valores; ahora leen la capa semántica:
     filete decorativo de panel, borde de TODO control operable, acento. */
  --tx-border-hairline: 1px solid var(--tx-divider);
  --tx-border-control:  1px solid var(--tx-divider-strong);
  --tx-border-accent:   3px solid var(--tx-action-mark);

  --tx-focus-ring: 2px;
  --tx-focus-offset: 2px;
  /* D8 (revisión step 15): el halo, como TOKEN. Antes estaba escrito a mano
     dentro de :focus-visible, y cualquier regla con su propio box-shadow lo
     borraba entera sin querer (box-shadow no se acumula: se sustituye). Ahora
     las dos reglas que declaran sombra propia y pueden recibir el foco
     (.tx-skip-link y a.tx-stat) lo vuelven a poner al final de SU lista de
     sombras. La invariante la vigila una prueba, no este comentario. */
  --tx-focus-halo: 0 0 0 5px rgba(184, 106, 60, 0.35);

  --tx-duration: 120ms;
  --tx-easing: ease-out;

  /* step 26 §6.2 — la unidad de rejilla de la Agenda: un tic de 15 minutos.
     En rem, para que el zoom del navegador y el tamaño de fuente del sistema
     lo escalen (30 min = 3,5rem, 15 min = 1,75rem). */
  --tx-agenda-tick: 1.75rem;
}

@media (prefers-reduced-motion: reduce) {
  :root { --tx-duration: 0ms; }
  * { transition-duration: 0ms !important; animation-duration: 0ms !important; }
}

/* ------------------------------------------------------------------ */
/* Base                                                                 */
/* ------------------------------------------------------------------ */
* { box-sizing: border-box; }
/* (M25) Anchura de layout ESTABLE, no dependiente del largo de la página.
   El fallo que arregla esto: en Safari/WebKit, cuando el sistema usa barras
   de desplazamiento CLÁSICAS (ajuste «Mostrar barras de desplazamiento:
   siempre», o automático con un ratón conectado), la barra vertical del
   documento OCUPA sitio. Entonces documentElement.clientWidth vale 15 px
   menos que window.innerWidth — y las media queries se evalúan contra
   clientWidth, NO contra innerWidth (demostrado en WebKit 26.5: a ventana
   fija de 1290 px, una página corta da clientWidth 1290 y una larga 1275,
   y (max-width: 1279px) pasa de no casar a casar).

   Consecuencia: navegar de una vista SIN scroll (Llamadas) a una vista CON
   scroll (Inicio) cambiaba el ancho útil en 15 px sin tocar la ventana, y
   eso cruzaba un punto de corte: la barra lateral se replegaba sola a raíl
   de iconos. El modo de navegación NO puede depender de si la página de
   turno desborda en vertical.

   La declaración overflow-y: scroll fija la reserva: el canal existe
   siempre, así que la anchura útil ya no depende del contenido.
   scrollbar-gutter: stable va PRIMERO por corrección (es la propiedad
   moderna para esto y la que usan Chrome y Firefox), pero NO basta sola en
   Safari: WebKit 26.5 responde CSS.supports('scrollbar-gutter','stable')
   === true y aun así NO reserva el canal — medido, no supuesto. Por eso
   la garantía la da overflow-y,
   y la separación entre la anchura de trabajo y el punto de corte del raíl
   (ver §4.5) es lo que impide que esa reserva deje todo en modo compacto. */
html {
  -webkit-text-size-adjust: 100%;
  scrollbar-gutter: stable;
  overflow-y: scroll;
}
body {
  margin: 0;
  background: var(--tx-canvas);
  color: var(--tx-text-strong);
  font-family: var(--tx-font-sans);
  font-size: var(--tx-size-400);
  line-height: var(--tx-leading-normal);
}
h1, h2, h3, h4 { font-family: var(--tx-font-sans); line-height: var(--tx-leading-tight); margin: 0; color: var(--tx-text-strong); }
p { margin: 0; }
a { color: inherit; }
button { font: inherit; }

/* step 15. El atributo hidden gana SIEMPRE. La regla que el navegador trae
   para [hidden] es display:none con la especificidad más baja que existe, así
   que cualquier display: puesto en una clase la anulaba en silencio: eso es
   lo que dejaba #llamada-detalle (.tx-call-detail, display:flex) a la vista,
   ocupando sitio con sus encabezados vacíos, aunque el router lo hubiera
   ocultado.

   CORRECCIÓN (revisión step 15): aquí se afirmaba que "ningún elemento del
   HTML servido dependía de que hidden NO funcionase". Era falso. La lista
   #calendario-dias-fallback nacía con hidden y se mostraba sólo desde la
   media query de 720px — es decir, dependía exactamente de eso, y esta regla
   la dejó invisible para siempre. Daba igual: ningún código la rellenó nunca,
   así que por debajo de 720px la vista Calendario se quedaba sin calendario
   antes y después. Esa lista ya no existe (ver el bloque de 720px al final).
   Los diálogos, eso sí, siguen sin depender del atributo: se muestran y se
   esconden solos con showModal()/close(). */
[hidden] { display: none !important; }

/* step 15. Anillo de foco de marca: un contorno fino de tinta más un halo de
   cobre translúcido alrededor, en vez de los 3 px de contorno negro macizo de
   antes. El halo NO es el que marca el foco (el contorno sí): es solo el
   acabado. Se probó un anillo de cobre puro y se descartó por contraste — daba
   1,6:1 sobre el botón primario (#8F4F2A), muy por debajo del 3:1 exigido a un
   indicador no textual. Tinta #171615 sobre marfil #F5F1E8 da ~15:1. El foco
   NUNCA se quita: no hay ningún outline:none en esta hoja, y sigue siendo
   :focus-visible (no :focus), para no dibujar el anillo a quien usa el ratón. */
:focus-visible {
  outline: var(--tx-focus-ring) solid var(--tx-focus-dark);
  outline-offset: var(--tx-focus-offset);
  box-shadow: var(--tx-focus-halo);
  border-radius: var(--tx-radius-sm);
}
/* Sobre la barra lateral oscura el contorno de tinta desaparecería: allí manda el marfil. */
.tx-sidebar :focus-visible { outline-color: var(--tx-focus-light); }

.tx-visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.tx-skip-link {
  position: absolute;
  left: var(--tx-space-3);
  top: -3rem;
  z-index: 100;
  background: var(--tx-panel-bg);
  color: var(--tx-text-strong);
  padding: var(--tx-space-2) var(--tx-space-4);
  border-radius: var(--tx-radius-sm);
  box-shadow: var(--tx-shadow-2);
  transition: top var(--tx-duration) var(--tx-easing);
}
.tx-skip-link:focus { top: var(--tx-space-3); }
/* D8: este enlace declara su propia sombra, que borraba el halo justo cuando
   más se ve — es el primer elemento que recibe el foco de toda la consola. */
.tx-skip-link:focus-visible { box-shadow: var(--tx-shadow-2), var(--tx-focus-halo); }

/* ------------------------------------------------------------------ */
/* 4. App shell                                                        */
/* ------------------------------------------------------------------ */
.tx-shell { display: flex; min-height: 100vh; }

.tx-sidebar {
  flex: 0 0 216px;
  width: 216px;
  background: var(--tx-sidebar-bg);
  color: var(--tx-text-on-dark);
  display: flex;
  flex-direction: column;
  gap: var(--tx-space-1);
  /* REAPERTURA §R5 — Defecto 1: .tx-shell es display: flex sin
     align-items, que en flexbox equivale a stretch: la CAJA de esta
     barra se estiraba a toda la altura del documento (por eso el fondo
     oscuro seguía visible al bajar) pero su CONTENIDO se quedaba arriba del
     todo y se marchaba con el desplazamiento. align-self: flex-start es
     imprescindible: sin él, stretch sigue estirando la caja y
     position: sticky no tiene nada contra lo que pegarse. Sólo en
     escritorio (>=1024px): la media query móvil de abajo lo anula. */
  position: sticky;
  top: 0;
  align-self: flex-start;
  height: 100vh;
  overflow-y: auto;
  /* REAPERTURA §R15 A11 — hallazgo V2-1 de la revisión adversarial, medido en
     WebKit real a 1280x500: con las barras de desplazamiento por SUPERPOSICIÓN
     (el ajuste por defecto de macOS con trackpad, y el único que conoce iOS),
     \`overflow-y: auto\` no reserva canal alguno; la séptima entrada
     («Laboratorio») quedaba fuera de la barra SIN ni un píxel de barra visible
     que dijera que hay más abajo. \`scrollbar-gutter: stable\` reserva el canal
     SIEMPRE, exista o no barra superpuesta, y es lo que hace que el
     desplazamiento interno de A11 se VEA y no sólo exista. Va en la regla base,
     nunca en una @media nueva (§R15 A10 prohíbe añadir @media). */
  scrollbar-gutter: stable;
}
/* …y el canal, MEDIDO, no basta por sí solo en WebKit. Comprobado en WebKit
   real a 1280x500 con este mismo commit: \`scrollbar-gutter\` se calcula como
   \`stable\` y aun así el canal reservado es de 0px — el mismo comportamiento
   que ya estaba anotado para \`html\` en \`responsiveEstabilidad.test.ts\`
   («CSS.supports dice true y aun así NO reserva el canal»). Con barras por
   superposición eso deja la séptima entrada fuera SIN barra visible, que es
   literalmente lo que §R15 A11 prohíbe.

   Declarar la barra de la barra lateral saca a WebKit del modo superpuesto
   para ESTE contenedor y la hace visible: canal medido 0px -> 10px, misma
   pasada, mismo motor. \`scrollbar-gutter\` se conserva porque es quien
   resuelve lo mismo en Firefox, que no entiende este pseudo-elemento. Ningún
   color nuevo entra en la paleta: el pulgar usa el mismo gris de línea de la
   barra que ya separa el pie. Y no hay ni una @media nueva (§R15 A10). */
.tx-sidebar::-webkit-scrollbar { width: 10px; }
.tx-sidebar::-webkit-scrollbar-track { background: transparent; }
.tx-sidebar::-webkit-scrollbar-thumb { background: var(--tx-sidebar-line); border-radius: 5px; }

.tx-brand { padding: var(--tx-space-4) var(--tx-space-4) var(--tx-space-5); }
.tx-brand__plate {
  background: var(--tx-panel-bg);
  border-radius: var(--tx-radius-md);
  padding: var(--tx-space-2);
  box-shadow: var(--tx-shadow-1);
  width: 100%;
  max-width: 132px;
  margin-inline: auto;
}
.tx-brand__plate img { width: 100%; height: auto; display: block; }
.tx-brand__glyph {
  display: none;
  width: 40px; height: 40px;
  align-items: center; justify-content: center;
  color: var(--tx-copper-200);
  border: 1px solid var(--tx-action-mark);
  border-radius: var(--tx-radius-sm);
  font-weight: var(--tx-weight-bold);
  letter-spacing: -0.02em;
}
.tx-brand__venue {
  margin-top: var(--tx-space-3);
  font-size: var(--tx-size-200);
  color: var(--tx-text-on-dark-muted);
  text-align: center;
}

.tx-nav__list { list-style: none; margin: 0; padding: 0 var(--tx-space-3); display: flex; flex-direction: column; gap: 2px; }
.tx-nav__list a {
  display: flex;
  align-items: center;
  gap: var(--tx-space-3);
  min-height: 44px;
  padding: var(--tx-space-2) var(--tx-space-3);
  border-radius: var(--tx-radius-sm);
  color: var(--tx-text-on-dark-muted);
  text-decoration: none;
  font-size: var(--tx-size-400);
  border-left: 3px solid transparent;
  transition: background var(--tx-duration) var(--tx-easing), color var(--tx-duration) var(--tx-easing);
}
.tx-nav__list a:hover { background: var(--tx-ink-800); color: var(--tx-text-on-dark); }
/* §3.3 — la ruta activa se señala con CUATRO cosas y sólo una es color: una
   barra de 3 px a la izquierda (forma y posición), el peso semibold, el
   fondo, y el aria-current="page" que pone applyRoute. Quien no distinga
   el cobre del negro sigue viendo la barra y el grosor de la letra. */
.tx-nav__list a[aria-current="page"] {
  background: var(--tx-sidebar-active);
  color: var(--tx-text-on-dark);
  font-weight: var(--tx-weight-semibold);
  border-left-color: var(--tx-action-mark);
}
/* §7.2, trampa 8 — estos iconos son SVG en línea del HTML ESTÁTICO
   (ui.html.ts). El DOM falso de las pruebas no implementa createElementNS,
   así que ningún icono puede nacer de ui.js.ts. Van aria-hidden: el nombre
   accesible del enlace lo da su aria-label, que no cambia con la anchura. */
.tx-nav__glyph { flex: 0 0 auto; display: inline-flex; width: 20px; height: 20px; }
.tx-nav__glyph svg { width: 20px; height: 20px; display: block; }
.tx-nav__label { flex: 1 1 auto; min-width: 0; }

.tx-sidebar__tools-label {
  margin: var(--tx-space-5) var(--tx-space-4) var(--tx-space-2);
  font-size: var(--tx-size-100);
  text-transform: uppercase;
  letter-spacing: var(--tx-tracking-caps);
  color: var(--tx-text-on-dark-muted);
}

.tx-nav__list--tools {
  margin-top: var(--tx-space-3);
  padding-top: var(--tx-space-3);
  border-top: 1px solid var(--tx-sidebar-line);
}

.tx-sidebar__foot {
  margin-top: auto;
  padding: var(--tx-space-5);
  font-size: var(--tx-size-200);
  color: var(--tx-text-on-dark-muted);
  font-variant-numeric: tabular-nums;
}

.tx-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }

/* §3.4 — Fila 1: el <h1> (que crece), la insignia de demostración y el reloj
   sintético. Fila 2, a todo lo ancho: la frescura. Ni campana, ni avatar, ni
   saludo con nombre, ni buscador, ni hamburguesa (D1, D4, D5). */
.tx-topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--tx-canvas);
  border-bottom: var(--tx-border-hairline);
  padding: var(--tx-space-4) var(--tx-space-8);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--tx-space-2) var(--tx-space-4);
}
.tx-topbar__title {
  font-size: var(--tx-size-700);
  font-weight: var(--tx-weight-semibold);
  letter-spacing: -0.01em;
  margin-right: auto;
  min-width: 0;
}
.tx-topbar__title:focus-visible { outline-offset: var(--tx-focus-offset); }

/* §7.1, trampa 4 — este aviso NO puede recibir display:none en ninguna regla
   de esta hoja, y su marca es exactamente <span class="tx-badge-demo">, una
   sola vez en todo el HTML. Las dos cosas están ancladas por prueba. */
.tx-badge-demo {
  display: inline-block;
  background: var(--tx-action);
  color: var(--tx-text-on-accent);
  border-radius: var(--tx-radius-pill);
  font-size: var(--tx-size-200);
  font-weight: var(--tx-weight-semibold);
  line-height: var(--tx-leading-normal);
  padding: var(--tx-space-1) var(--tx-space-3);
  white-space: nowrap;
}

.tx-freshness {
  font-size: var(--tx-size-200);
  color: var(--tx-text-muted);
  font-variant-numeric: tabular-nums;
  width: 100%;
  flex-basis: 100%;
  order: 3;
}
.tx-freshness--down { color: var(--tx-status-error); font-weight: var(--tx-weight-semibold); }

.tx-workspace {
  max-width: 1176px;
  width: 100%;
  margin-inline: auto;
  padding: var(--tx-space-8) var(--tx-space-8) var(--tx-space-16);
  scroll-margin-top: calc(var(--tx-space-16) + var(--tx-space-4));
}

.tx-view { display: grid; grid-template-columns: repeat(12, 1fr); gap: var(--tx-space-6); }
.tx-view[hidden] { display: none; }

.tx-stack { display: flex; flex-direction: column; gap: var(--tx-space-6); }
.tx-col-12 { grid-column: span 12; }
.tx-col-8  { grid-column: span 8; }
.tx-col-4  { grid-column: span 4; }
.tx-col-3  { grid-column: span 3; }
.tx-col-6  { grid-column: span 6; }

/* ------------------------------------------------------------------ */
/* Panels                                                               */
/* ------------------------------------------------------------------ */
/* §2.4/§2.5 — el panel NO lleva sombra: sólo filete. La sombra 1 se reserva
   a las tarjetas de KPI y la 2 a la elevación de hover y al enlace de salto;
   así una pantalla con ocho paneles no parece ocho cosas flotando. */
.tx-panel {
  background: var(--tx-panel-bg);
  border: var(--tx-border-hairline);
  border-radius: var(--tx-radius-lg);
  padding: var(--tx-space-6);
}
.tx-panel > h2 {
  font-size: var(--tx-size-600);
  font-weight: var(--tx-weight-semibold);
  line-height: var(--tx-leading-tight);
  margin-bottom: var(--tx-space-4);
}
.tx-panel--notice {
  background: var(--tx-notice-bg);
  border: var(--tx-border-hairline);
}
/* §4.5 — la ÚNICA diferencia visual entre «Necesita tu atención» y «Cosas que
   hacer una persona», y sólo mientras el contador de la primera pasa de cero.
   No es un color de alarma ni un fondo: es un filete, la misma marca de
   acento que ya usan la fila «--next» y la tarjeta de un hueco. El panel de
   tareas no lo lleva NUNCA, y las dos cuentas siguen sin sumarse en ningún
   sitio: vienen de definiciones distintas. */
.tx-panel--focus { border-left: var(--tx-border-accent); }
/* (revisión adversarial de la capacidad 3, hallazgo m5) El rótulo permanente
   del resumen para Bruno (§5.2.5) usa este modificador SOLO, sin \`.tx-panel\`
   —a diferencia de los otros tres usos de \`.tx-panel--notice\`, que van
   siempre dentro de un \`.tx-panel\` que aporta el padding—, así que el texto
   tocaba el borde. Clase propia con su propia caja. */
.tx-permanent-label {
  background: var(--tx-notice-bg);
  border: var(--tx-border-hairline);
  border-radius: var(--tx-radius-sm);
  padding: var(--tx-space-2) var(--tx-space-3);
}
.tx-context {
  display: flex;
  flex-direction: column;
  gap: var(--tx-space-2);
}
.tx-context__status { display: flex; align-items: center; gap: var(--tx-space-2); font-weight: var(--tx-weight-medium); }
.tx-context__dot { width: 10px; height: 10px; border-radius: 50%; background: var(--tx-status-ok); display: inline-block; flex: 0 0 auto; }
.tx-context__dot--down { background: var(--tx-status-error); }
/* (revisión step 15, punto 2) Ni verde ni rojo: el arranque en frío no
   tiene todavía ningún dato que respalde "responde" o "no responde". */
.tx-context__dot--checking { background: var(--tx-status-neutral); }
.tx-context__note { color: var(--tx-text-muted); font-size: var(--tx-size-300); }

/* Inicio (step 16): tira de contexto más baja, en fila, para dejar sitio a
   los KPI y a "Necesita tu atención" por encima del pliegue. */
.tx-context--compact {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: var(--tx-space-4);
  row-gap: var(--tx-space-1);
  padding: var(--tx-space-3) var(--tx-space-4);
}

/* ------------------------------------------------------------------ */
/* 6.2 tx-stat                                                          */
/* ------------------------------------------------------------------ */
/* align-items: stretch (el valor por defecto de la rejilla) es lo que iguala
   las cuatro tarjetas cuando un rótulo necesita dos líneas — el punto más
   ajustado del diseño, a 1024 px con las cuatro en fila (§6.5). */
.tx-stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--tx-space-4); grid-column: span 12; }
/* §2.5 — rejilla \`2,25rem 1fr\`: el disco del icono (fila 1, columna 1), la
   cifra a --tx-size-800 (fila 1, columna 2), el rótulo (fila 2) y la pista
   (fila 3), estas dos a todo el ancho para que el rótulo pueda partirse en
   dos líneas sin estrangularse contra el disco.
   §7.1, trampa 6: esto vale también para \`a.tx-stat\` —tres de las cuatro
   tarjetas son enlaces—, así que el hover y el foco se declaran una sola vez
   más abajo y siguen valiendo para las dos variantes.
   Ninguna altura fija: sólo relleno (§6.4, zoom al 200 %). */
.tx-stat {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr);
  align-content: start;
  column-gap: var(--tx-space-3);
  row-gap: var(--tx-space-1);
  background: var(--tx-panel-bg);
  border: var(--tx-border-hairline);
  border-radius: var(--tx-radius-md);
  box-shadow: var(--tx-shadow-1);
  padding: var(--tx-space-4);
  text-decoration: none;
  color: inherit;
}
/* El disco tenue de la referencia: fondo de cobre al 8 % con el trazo del
   icono en cobre pleno (5,35 sobre ese fondo, §2.2 nº 17). Es decorativo y
   va aria-hidden en el HTML: lo que nombra la tarjeta es su rótulo. */
.tx-stat__icon {
  grid-column: 1;
  grid-row: 1;
  align-self: start;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 50%;
  background: var(--tx-action-bg);
  color: var(--tx-action);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tx-stat__icon svg { width: 20px; height: 20px; display: block; }
a.tx-stat:hover { border-color: var(--tx-divider-strong); box-shadow: var(--tx-shadow-2); }
/* D8: separada de :hover porque con el foco hay que sumar el halo a la sombra
   de elevación; la lista de box-shadow se sustituye entera, no se acumula. */
a.tx-stat:focus-visible { border-color: var(--tx-divider-strong); box-shadow: var(--tx-shadow-2), var(--tx-focus-halo); }
.tx-stat__value {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: var(--tx-size-800);
  font-weight: var(--tx-weight-bold);
  line-height: var(--tx-leading-tight);
  font-variant-numeric: tabular-nums;
}
/* «Sin datos todavía» no es una cifra y no puede vestirse como tal (§4.4). */
.tx-stat__value--empty { font-size: var(--tx-size-500); font-weight: var(--tx-weight-medium); color: var(--tx-text-muted); }
.tx-stat__label { grid-column: 1 / -1; grid-row: 2; font-size: var(--tx-size-300); color: var(--tx-text-body); }
.tx-stat__hint { grid-column: 1 / -1; grid-row: 3; font-size: var(--tx-size-200); color: var(--tx-action); font-weight: var(--tx-weight-semibold); }
/* La pista de «Errores técnicos» está VACÍA cuando no hay ninguno (§4.2):
   sin esto se quedaría su fila de rejilla reservada y las cuatro tarjetas
   dejarían de medir lo mismo por un texto que no existe. */
.tx-stat__hint:empty { display: none; }
.tx-stat--alert .tx-stat__value { color: var(--tx-status-error); }
.tx-stat--alert { border-left: 3px solid var(--tx-status-error); }

/* ------------------------------------------------------------------ */
/* 6.1 tx-pill                                                          */
/* ------------------------------------------------------------------ */
.tx-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--tx-space-2);
  border-radius: var(--tx-radius-pill);
  padding: var(--tx-space-1) var(--tx-space-3);
  font-size: var(--tx-size-200);
  font-weight: var(--tx-weight-semibold);
  white-space: nowrap;
}
.tx-pill--sm { font-size: var(--tx-size-100); padding: 2px var(--tx-space-2); }
/* §2.5 — cada variante trae su PROPIA forma de borde (sólido, discontinuo,
   filete izquierdo grueso, punteado, 2 px, gris) además del texto: el color
   nunca informa solo, ni siquiera dentro de la familia de píldoras. */
.tx-pill--ok { color: var(--tx-status-ok); background: var(--tx-status-ok-bg); border: 1px solid var(--tx-status-ok); }
.tx-pill--attention { color: var(--tx-status-warn); background: var(--tx-status-warn-bg); border: 1px dashed var(--tx-status-warn); }
.tx-pill--derived { color: var(--tx-action); background: var(--tx-action-bg); border: 1px solid var(--tx-action); border-left-width: 3px; }
.tx-pill--incomplete { color: var(--tx-status-neutral); background: var(--tx-status-neutral-bg); border: 1px dotted var(--tx-status-neutral); }
.tx-pill--error { color: var(--tx-status-error); background: var(--tx-status-error-bg); border: 2px solid var(--tx-status-error); }
.tx-pill--none { color: var(--tx-status-neutral); background: transparent; border: 1px solid var(--tx-divider-strong); }

/* ------------------------------------------------------------------ */
/* 6.3 tx-attention-card                                                */
/* ------------------------------------------------------------------ */
.tx-attention-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--tx-space-3); }
.tx-attention-card {
  display: flex;
  flex-direction: column;
  gap: var(--tx-space-2);
  align-items: flex-start;
  padding: var(--tx-space-4);
  border: var(--tx-border-hairline);
  border-radius: var(--tx-radius-md);
  background: var(--tx-panel-bg);
  min-width: 0;
}
.tx-attention-card--error { border-left: 3px solid var(--tx-status-error); }
.tx-attention-card--attention { border-left: 3px solid var(--tx-status-warn); }
.tx-attention-card--derived { border-left: 3px solid var(--tx-action); }
.tx-attention-card__title { font-size: var(--tx-size-400); font-weight: var(--tx-weight-semibold); }
.tx-attention-card__meta { color: var(--tx-text-muted); font-size: var(--tx-size-200); }

/* ------------------------------------------------------------------ */
/* Task queue / activity lists                                          */
/* ------------------------------------------------------------------ */
.tx-task-list, .tx-activity-list, .tx-day-list, .tx-absence-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
/* §6.4 — flex-wrap + min-width: 0 en TODO contenedor que junte texto con una
   píldora o un botón: es lo que sostiene el zoom al 200 % y los 690 px sin
   que nada se salga de su panel. */
.tx-task-list > li, .tx-activity-list > li, .tx-day-list > li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--tx-space-2) var(--tx-space-3);
  min-width: 0;
  padding: var(--tx-space-3) 0;
  border-bottom: var(--tx-border-hairline);
}
.tx-task-list > li:last-child, .tx-activity-list > li:last-child, .tx-day-list > li:last-child { border-bottom: none; }
.tx-activity-list__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.tx-activity-list__time { color: var(--tx-text-muted); font-size: var(--tx-size-200); font-variant-numeric: tabular-nums; }

/* ------------------------------------------------------------------ */
/* step 21A §4.6 — vista previa de citas con carril temporal           */
/* ------------------------------------------------------------------ */
/* El carril (punto y línea) es DECORADO CSS: dos pseudoelementos y CERO
   nodos nuevos en el DOM. Importa porque esta lista la repinta el sondeo
   cada 2 s a través de reconcileList: cuantos menos nodos tenga una fila,
   menos superficie hay donde romper una guarda de foco.
   Los dos pseudoelementos van POSICIONADOS EN ABSOLUTO a propósito: el ::before
   de un contenedor de rejilla sería, si no, un elemento de rejilla más y se
   comería una columna. */
/* (revisión adversarial F4, H3) DOS pistas, las que manda §4.6, no tres. Con
   una tercera pista \`auto\` para la píldora, "Reserva confirmada" —que no
   encoge: 13 px semibold, relleno, glifo y white-space: nowrap— se llevaba
   ~182 px de la fila, y a 1440 px la columna del servicio se quedaba en unos
   6 px y a 1280 px pedía ~47 px MÁS de los que hay. El desenlace era o el
   servicio desbordando sobre la píldora, o la rejilla de 12 robándole ancho
   a la columna de al lado. Ahora la píldora baja a su propia fila (§6.4: el
   equivalente en rejilla del flex-wrap que se le exige a todo contenedor que
   junte texto con una píldora), donde tiene el ancho entero de la fila. */
.tx-appointment-list > li {
  position: relative;
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  align-items: baseline;
  column-gap: var(--tx-space-3);
  row-gap: var(--tx-space-1);
  padding-left: var(--tx-space-5);
}
.tx-appointment-list > li::before {
  content: '';
  position: absolute;
  left: 0;
  top: calc(var(--tx-space-3) + 0.3rem);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tx-action-mark);
}
/* La línea de 1 px que une un punto con el siguiente. Decorativa: nunca es
   la única señal de nada (§2.2 nº 26), sólo dice "esto va en orden". */
.tx-appointment-list > li::after {
  content: '';
  position: absolute;
  left: 3px;
  top: calc(var(--tx-space-3) + 0.3rem + 10px);
  bottom: calc(-1 * var(--tx-space-3));
  width: 1px;
  background: var(--tx-divider);
}
.tx-appointment-list > li:last-child::after { content: none; }
.tx-appointment-list__hour {
  grid-column: 1;
  grid-row: 1;
  color: var(--tx-text-strong);
  font-weight: var(--tx-weight-semibold);
  font-variant-numeric: tabular-nums;
}
/* Colocación EXPLÍCITA de las dos celdas de la primera fila: hora y servicio
   quedan donde el diseño los pone, sin depender del orden de colocación
   automática de la rejilla. */
.tx-appointment-list > li > .tx-activity-list__body { grid-column: 2; grid-row: 1; }
.tx-appointment-list__pro { color: var(--tx-text-muted); font-size: var(--tx-size-200); }
/* La píldora, alineada a la derecha (§4.6) y en la fila de abajo, con las dos
   pistas enteras a su disposición: a la anchura más apretada de las cinco
   (1280 px, que es donde la vista previa sigue en 4 de 12 columnas) la fila
   mide ~233 px y la píldora ~182 px, así que entra sin encoger a nadie. */
.tx-appointment-list > li > div:last-child { grid-column: 1 / -1; grid-row: 2; justify-self: end; }
/* Y si algún día no entrase —tipografía más ancha, zoom al 200 %—, envuelve
   en vez de desbordar: es la píldora la que cede, nunca el panel. */
.tx-appointment-list > li > div:last-child .tx-pill { max-width: 100%; white-space: normal; }

/* Inicio (step 16): lista compacta de "Próximos días distintos", ahora bajo
   un resumen de una línea en vez de una tarjeta vacía de dos párrafos. */
.tx-day-list--compact > li { padding: var(--tx-space-1) 0; font-size: var(--tx-size-300); }

/* step 19 §4.3 — el historial de tareas humanas (Laboratorio). Cada fila
   lleva varias líneas apiladas (rótulo+píldora, fecha de creación, fecha de
   cierre si la hay, acción), a diferencia de .tx-task-list/.tx-activity-list
   (una sola línea horizontal): de ahí una clase propia en vez de reutilizar
   esas dos. */
.tx-tarea-historial-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.tx-tarea-historial-list > li {
  display: flex;
  flex-direction: column;
  gap: var(--tx-space-1);
  padding: var(--tx-space-3) 0;
  border-bottom: var(--tx-border-hairline);
}
.tx-tarea-historial-list > li:last-child { border-bottom: none; }
/* (revisión adversarial de la capacidad 3, hallazgo m2) flex-wrap, como su
   hermana .tx-guion-paso__head: sin él, una etiqueta larga empuja la
   píldora (que no encoge) fuera del panel a 690 px. */
.tx-tarea-historial__head { display: flex; align-items: center; justify-content: space-between; gap: var(--tx-space-3); flex-wrap: wrap; }
.tx-tarea-historial__label { font-weight: var(--tx-weight-semibold); }
.tx-tarea-historial__fecha { margin: 0; color: var(--tx-text-muted); font-size: var(--tx-size-200); font-variant-numeric: tabular-nums; }
.tx-tarea-historial__accion { margin-top: var(--tx-space-1); }
.tx-tarea-historial__accion p { margin: 0; color: var(--tx-text-muted); font-size: var(--tx-size-200); }

/* step 19 §5 — Capacidad 3: el resumen para Bruno (3A) y el guion en
   pantalla (3B). Compacto y usable a 690 px (§5.3.7): los pasos se apilan,
   la píldora va encima del título, no hay tabla y no hay desplazamiento
   horizontal. Se reutiliza .tx-tarea-historial* como base de apilado. */
.tx-resumen-bloque { margin-top: var(--tx-space-4); }
.tx-resumen-medida { padding: var(--tx-space-2) 0; border-bottom: var(--tx-border-hairline); }
.tx-resumen-medida:last-child { border-bottom: none; }
.tx-resumen-medida__linea { margin: 0; }
.tx-resumen-medida__label { font-weight: var(--tx-weight-semibold); }
.tx-resumen-respaldo { width: 100%; min-height: 120px; font: inherit; }

.tx-guion-pasos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.tx-guion-paso {
  display: flex;
  flex-direction: column;
  gap: var(--tx-space-1);
  padding: var(--tx-space-3) 0;
  border-bottom: var(--tx-border-hairline);
}
.tx-guion-paso:last-child { border-bottom: none; }
.tx-guion-paso__head { display: flex; align-items: center; justify-content: space-between; gap: var(--tx-space-3); flex-wrap: wrap; }
.tx-guion-paso__titulo { font-weight: var(--tx-weight-semibold); }
.tx-guion-paso__pista { margin: 0; color: var(--tx-text-body); }
.tx-guion-paso__evidencia { margin: 0; color: var(--tx-text-muted); font-size: var(--tx-size-200); }
/* (revisión adversarial de la capacidad 3, hallazgo m4) .tx-guion-paso es
   una columna flex con el "stretch" por defecto: sin esto, el enlace "Ir a…"
   —el único hijo que es un <a>, no un <div>— ocupa todo el ancho del panel
   en vez de sólo el suyo, a las cinco anchuras. */
.tx-guion-paso > a { align-self: flex-start; }

/* ------------------------------------------------------------------ */
/* 6.11 tx-btn                                                          */
/* ------------------------------------------------------------------ */
/* §2.5 y §6.2 — zonas táctiles: 44 px en el botón primario y en el de zona
   peligrosa, 36 px en los secundarios y fantasma. Ningún botón lleva sombra:
   la elevación se reserva al hover de la tarjeta de KPI y al enlace de salto. */
.tx-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--tx-space-2);
  min-height: 36px;
  padding: var(--tx-space-2) var(--tx-space-4);
  border-radius: var(--tx-radius-md);
  font-weight: var(--tx-weight-semibold);
  line-height: var(--tx-leading-tight);
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  border: none;
  transition: background var(--tx-duration) var(--tx-easing), border-color var(--tx-duration) var(--tx-easing);
}
.tx-btn--primary { min-height: 44px; background: var(--tx-action); color: var(--tx-text-on-accent); }
/* §2.2 nº 12 — el hover OSCURECE (blanco sobre #74401F: 8,41). Aclararlo
   hacia --tx-copper-500 daría 4,07 y suspendería el 4,5 que se exige a un
   texto normal, justo en el estado en el que el puntero ya está encima. */
.tx-btn--primary:hover, .tx-btn--primary:active { background: var(--tx-action-strong); }
.tx-btn--secondary { background: var(--tx-panel-bg); color: var(--tx-text-strong); border: var(--tx-border-control); }
.tx-btn--secondary:hover { background: var(--tx-panel-bg-quiet); border-color: var(--tx-text-strong); }
.tx-btn--ghost { background: transparent; color: var(--tx-text-body); }
.tx-btn--ghost:hover { text-decoration: underline; text-underline-offset: 2px; }
.tx-btn--danger { min-height: 44px; background: var(--tx-status-error); color: var(--tx-text-on-accent); }
/* (revisión adversarial F4, H4) El estado inactivo se dice con superficie y
   texto PROPIOS, no bajando la opacidad de lo que hubiera debajo. Con
   opacity: .55 el primario quedaba en blanco sobre un cobre lavado (#C19E8A):
   2,46:1, el único par de texto de toda la consola por debajo de 4,5. WCAG 2.1
   §1.4.3 exime los componentes inactivos —no era un incumplimiento—, pero un
   botón que no se puede leer tampoco explica por qué no se puede pulsar.
   Sigue sin parecer activo: ni cobre, ni rojo, ni texto de cuerpo. */
.tx-btn:disabled {
  background: var(--tx-panel-bg-quiet);
  color: var(--tx-text-disabled);
  border: var(--tx-border-hairline);
  cursor: not-allowed;
}
.tx-btn-row { display: flex; gap: var(--tx-space-3); flex-wrap: wrap; }

/* ------------------------------------------------------------------ */
/* Tables                                                               */
/* ------------------------------------------------------------------ */
.tx-table-scroll { overflow-x: auto; }
.tx-table { width: 100%; border-collapse: collapse; font-size: var(--tx-size-300); }
.tx-table th, .tx-table td { text-align: left; padding: var(--tx-space-3); border-bottom: var(--tx-border-hairline); vertical-align: middle; }
/* §2.3 — versalitas SÓLO en rótulos de columna y de bloque, nunca en frases. */
.tx-table th { font-size: var(--tx-size-100); text-transform: uppercase; letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted); font-weight: var(--tx-weight-semibold); }
.tx-table td { font-variant-numeric: tabular-nums; }
.tx-table tbody tr:last-child td { border-bottom: none; }
.tx-table tbody tr.tx-table__row--past { color: var(--tx-text-muted); }
.tx-table tbody tr.tx-table__row--next { border-left: 3px solid var(--tx-action-mark); }
.tx-table tbody tr.tx-table__row--selected { background: var(--tx-panel-bg-quiet); border-left: 3px solid var(--tx-action); }
.tx-table-separator td { padding-top: var(--tx-space-4); font-size: var(--tx-size-100); text-transform: uppercase; letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted); border-bottom: none; }
/* D10 — la acción de una fila es un enlace con TEXTO real, nunca un cheurón
   sin nombre. Y va subrayado: el cobre no puede ser su única señal (§2.5). */
.tx-row-link {
  background: transparent;
  border: none;
  padding: var(--tx-space-1) var(--tx-space-2);
  cursor: pointer;
  color: var(--tx-action);
  font-weight: var(--tx-weight-semibold);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.tx-row-link:hover { color: var(--tx-action-strong); }

/* ------------------------------------------------------------------ */
/* 6.9 tx-empty                                                         */
/* ------------------------------------------------------------------ */
/* §2.5 — sin ilustración y sin dibujo: un título en semibold que dice qué
   pasa y un cuerpo apagado que dice por qué. El borde es DISCONTINUO, que es
   la señal de forma de "aquí no hay nada", no un color más. */
.tx-empty {
  background: var(--tx-panel-bg);
  border: 1px dashed var(--tx-divider-strong);
  border-radius: var(--tx-radius-md);
  padding: var(--tx-space-8) var(--tx-space-6);
  text-align: center;
}
.tx-empty__title { font-weight: var(--tx-weight-semibold); margin-bottom: var(--tx-space-1); }
.tx-empty__body { color: var(--tx-text-muted); font-size: var(--tx-size-300); }

/* ------------------------------------------------------------------ */
/* Filters / controls                                                   */
/* ------------------------------------------------------------------ */
.tx-filter-bar { display: flex; flex-wrap: wrap; gap: var(--tx-space-2); align-items: center; grid-column: span 12; }
.tx-filter {
  min-height: 36px;
  padding: var(--tx-space-2) var(--tx-space-4);
  border-radius: var(--tx-radius-pill);
  border: var(--tx-border-control);
  background: var(--tx-panel-bg);
  color: var(--tx-text-strong);
  cursor: pointer;
  font-size: var(--tx-size-300);
  font-weight: var(--tx-weight-medium);
  transition: background var(--tx-duration) var(--tx-easing), color var(--tx-duration) var(--tx-easing);
}
.tx-filter:hover { background: var(--tx-panel-bg-quiet); }
/* §2.5 — el filtro pulsado lo dice DOS veces y ninguna es sólo color: el
   fondo de tinta con el texto en marfil (16,03) y el peso semibold. Y una
   tercera, que no es visual: su propio aria-pressed="true". */
.tx-filter[aria-pressed="true"] {
  background: var(--tx-ink-900);
  color: var(--tx-text-on-dark);
  border-color: var(--tx-ink-900);
  font-weight: var(--tx-weight-semibold);
}
.tx-controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--tx-space-3);
  align-items: flex-end;
  justify-content: space-between;
  grid-column: span 12;
}
.tx-field { display: flex; flex-direction: column; gap: var(--tx-space-1); font-size: var(--tx-size-200); color: var(--tx-text-body); min-width: 0; }
.tx-field input, .tx-field select, .tx-field textarea {
  font: inherit;
  font-size: var(--tx-size-300);
  min-height: 40px;
  padding: var(--tx-space-2) var(--tx-space-3);
  border: var(--tx-border-control);
  border-radius: var(--tx-radius-sm);
  background: var(--tx-panel-bg);
  color: var(--tx-text-strong);
}
.tx-field textarea { min-height: 8rem; font-family: var(--tx-font-mono); font-size: var(--tx-size-300); }
.tx-radio-field { display: flex; align-items: center; gap: var(--tx-space-2); min-height: 44px; }
.tx-radio-field input { width: 20px; height: 20px; }
.tx-checkbox-field { display: flex; align-items: center; gap: var(--tx-space-2); min-height: 44px; }

/* ------------------------------------------------------------------ */
/* 6.6 tx-day-cell + calendar grid                                      */
/* ------------------------------------------------------------------ */
/* §5 (Calendario) — celdas con más aire, el número del día en 400 semibold y
   las marcas como líneas apagadas. Lo que NO se mueve: «--today» sigue siendo
   un borde de 2 px de tinta, que es una señal de FORMA y no de color, y la
   rejilla conserva su min-width bajo 720 px dentro de .tx-table-scroll. */
.tx-month-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
.tx-month-grid th {
  font-size: var(--tx-size-100);
  color: var(--tx-text-muted);
  text-transform: uppercase;
  letter-spacing: var(--tx-tracking-caps);
  font-weight: var(--tx-weight-semibold);
  padding: var(--tx-space-2);
  text-align: left;
}
.tx-day-cell {
  min-height: 96px;
  vertical-align: top;
  border: var(--tx-border-hairline);
  padding: var(--tx-space-3);
  font-size: var(--tx-size-200);
}
.tx-day-cell--outside { visibility: hidden; }
.tx-day-cell--today { border: 2px solid var(--tx-ink-900); }
.tx-day-cell--closed { background: var(--tx-status-neutral-bg); }
.tx-day-cell__number { display: block; font-weight: var(--tx-weight-semibold); font-size: var(--tx-size-400); font-variant-numeric: tabular-nums; }
.tx-day-cell__today { display: inline-block; margin-left: var(--tx-space-1); font-size: var(--tx-size-100); text-transform: uppercase; letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted); }
.tx-day-cell__hours { display: block; margin-top: var(--tx-space-2); color: var(--tx-text-muted); font-variant-numeric: tabular-nums; }
.tx-day-cell__marks { display: block; margin-top: var(--tx-space-2); }
.tx-day-cell__marks span { display: block; }
.tx-mark--holiday, .tx-mark--special { color: var(--tx-status-warn); }
.tx-mark--absence { color: var(--tx-action); }
.tx-mark--bookings { color: var(--tx-text-muted); }
.tx-legend { display: flex; flex-wrap: wrap; gap: var(--tx-space-3) var(--tx-space-4); font-size: var(--tx-size-200); color: var(--tx-text-body); margin-top: var(--tx-space-4); }

/* Agenda (step 26 §7) — el número de día del Calendario operativo gana un
   enlace. Nada más se mueve: el enlace hereda el color del texto y sólo
   subraya al pasar el ratón o al recibir el foco (§9, "el color nunca es la
   única señal": el subrayado es la segunda). */
.tx-day-cell__link { color: inherit; text-decoration: none; display: block; }
.tx-day-cell__link:hover .tx-day-cell__number,
.tx-day-cell__link:focus-visible .tx-day-cell__number { text-decoration: underline; }
.tx-day-cell__citas { display: block; margin-top: var(--tx-space-1); font-weight: var(--tx-weight-semibold); }

/* ------------------------------------------------------------------ */
/* 6.8 step 26 — Agenda multivista (Día · Semana · Mes)                */
/* ------------------------------------------------------------------ */
/* Decisión 6.7: SIN role="grid". La posición de cada bloque/hueco es CSS
   Grid por filas de TIC (grid-row), nunca posicionamiento absoluto en
   píxeles: bajo zoom 200% o una fuente de sistema grande la rejilla entera
   crece proporcionada. Las clases .tx-agenda-r-N / .tx-agenda-s-N (la
   familia generada al final de este bloque) son la ÚNICA forma en que el
   cliente coloca un bloque — nunca con \`.style.\`, que esta consola prohíbe
   por completo (ver el docblock de ui.js.ts). */
.tx-agenda-titulo-rango { margin: var(--tx-space-4) 0 var(--tx-space-2); font-size: var(--tx-size-600); font-weight: var(--tx-weight-semibold); }

/* step 26 — reparación adversarial (hallazgos 1/2). El suelo de
   \`minmax()\` NO puede ser el 12rem que sugería la Adenda A sin más: el
   ancho ÚTIL real de \`.tx-agenda-grid\` (que ocupa todo \`.tx-view\`, sin
   relleno propio) tiene un PEOR CASO medible, no el más ancho de la
   pantalla. En vw=1120px —justo ANTES de que la barra lateral se repliegue
   a raíl en 1119px (§4.5)— la barra sigue a 200px, la reserva de scrollbar
   de \`overflow-y: scroll\` cuesta ~17px, y \`.tx-workspace\` está acotado a
   1000px con 24px de relleno por lado (@media max-width:1439px):
     ancho principal = 1120 − 200 (barra) − 17 (reserva) = 903
     ancho de workspace = min(903, 1000) = 903
     ANCHO DE CONTENIDO = 903 − 24×2 = 855px  ← el peor caso real
   Con el hueco ya comprimido a 8px en esa misma anchura (@media
   max-width:1279px, más abajo):
     Semana (7 columnas): 48 (eje) + 7×suelo + 7×8 ≤ 855  → suelo ≤ 107,3px
     Día    (4 columnas): 48 (eje) + 4×suelo + 4×8 ≤ 855  → suelo ≤ 193,8px
   6,5rem (104px) y 11,5rem (184px) dejan 23px y 39px de margen real —
   nunca al filo— y la aritmética exacta la fija
   \`tests/console/agendaMultivista.test.ts\` (peor caso real, no aspiracional). */
.tx-agenda-grid {
  display: grid;
  grid-template-columns: 3rem repeat(1, minmax(11.5rem, 1fr));
  gap: 0 var(--tx-space-3);
  align-items: start;
  grid-column: span 12;
}
/* El NÚMERO de columnas de profesionales (1 a 4 en Día, siempre 7 en la
   Semana de un profesional) es dinámico, así que no puede ir en una única
   regla: son cinco modificadores, nunca \`.style.\` (prohibido en toda la
   consola — ver el docblock de ui.js.ts). El suelo de Semana (6,5rem) es
   menor que el de Día (11,5rem) porque siete columnas comparten el mismo
   ancho de contenido que cuatro — ver la aritmética de arriba. */
.tx-agenda-grid--cols-1 { grid-template-columns: 3rem repeat(1, minmax(11.5rem, 1fr)); }
.tx-agenda-grid--cols-2 { grid-template-columns: 3rem repeat(2, minmax(11.5rem, 1fr)); }
.tx-agenda-grid--cols-3 { grid-template-columns: 3rem repeat(3, minmax(11.5rem, 1fr)); }
.tx-agenda-grid--cols-4 { grid-template-columns: 3rem repeat(4, minmax(11.5rem, 1fr)); }
/* V2-4 — con CINCO o SEIS profesionales, \`agendaClaseColumnas\` escribía
   \`--cols-5\`/\`--cols-6\` y esas reglas NO EXISTÍAN: la rejilla se quedaba con
   el \`repeat(1, …)\` del bloque base y las columnas 2 a 6 caían a pista
   IMPLÍCITA, de anchura automática y desigual entre sí. Los suelos siguen la
   misma aritmética del peor caso real de arriba (855 px de contenido, hueco
   comprimido de 8 px):
     5 columnas: 48 + 5×suelo + 5×8 <= 855  ->  suelo <= 153,4px  (9rem = 144)
     6 columnas: 48 + 6×suelo + 6×8 <= 855  ->  suelo <= 126,5px  (7,5rem = 120)
   y quedan monótonos con los ya fijados (11,5rem hasta 4, 6,5rem a 7). */
.tx-agenda-grid--cols-5 { grid-template-columns: 3rem repeat(5, minmax(9rem, 1fr)); }
.tx-agenda-grid--cols-6 { grid-template-columns: 3rem repeat(6, minmax(7.5rem, 1fr)); }
.tx-agenda-grid--cols-7 { grid-template-columns: 3rem repeat(7, minmax(6.5rem, 1fr)); }
/* V2-4, segunda mitad — OCHO O MÁS: la decisión explícita.
   Con ocho columnas ya no cabe una anchura digna en 855 px (48 + 8×8 = 112 de
   sobrecarga dejan 92 px por columna: menos que el ancho de «09:30 – 10:00»).
   Estrechar más sería mentir sobre lo que se lee. Se decide lo contrario:
   TODAS las columnas conservan un ancho mínimo digno e IGUAL entre sí
   —\`grid-auto-columns\`, una sola declaración para cuantas haya— y lo que
   sobra se desplaza DENTRO de la rejilla, nunca en la página. El
   desplazamiento lo aporta \`.tx-table-scroll\`, la clase que el sistema visual
   ya tiene reservada para esto (es una de las dos únicas con \`overflow-x\`
   permitido, M25) y que \`agendaClaseColumnas\` añade al contenedor junto con
   este modificador; el contenedor recibe además \`role="region"\`,
   \`tabindex="0"\` y su nombre, para que se pueda recorrer con el teclado.
   \`grid-auto-flow: column\` es imprescindible: sin él las columnas implícitas
   se apilarían en FILAS, que es justo el defecto que esto repara. */
.tx-agenda-grid--cols-muchas {
  grid-template-columns: 3rem;
  grid-auto-flow: column;
  grid-auto-columns: minmax(11.5rem, 1fr);
}
/* §6.2 — columna presentacional (aria-hidden en el HTML): un lector de
   pantalla no debe recorrer 34 etiquetas de hora antes de la primera cita.
   \`grid-auto-rows\` (no \`grid-template-rows\`) a propósito: el número de tics
   de un día es dinámico (apertura→cierre reales, y puede extenderse), así
   que las filas se crean IMPLÍCITAMENTE conforme los bloques las piden —
   misma razón que las columnas de arriba, sin \`.style.\` ni variable CSS
   escrita desde JS. */
.tx-agenda-grid__axis {
  display: grid;
  grid-auto-rows: var(--tx-agenda-tick);
  padding-top: 2.75rem;
}
.tx-agenda-grid__axis-tick {
  font-size: var(--tx-size-100);
  color: var(--tx-text-muted);
  font-variant-numeric: tabular-nums;
  border-top: 1px solid var(--tx-divider);
}
/* La hora en punto se distingue de la media con PESO tipográfico, no sólo
   con color (§6.2): el filete de :15/:45 es más tenue y sin rótulo. */
.tx-agenda-grid__axis-tick--hora { font-weight: var(--tx-weight-semibold); color: var(--tx-text-body); }
.tx-agenda-grid__axis-tick--media { border-top-style: dotted; }
.tx-agenda-col { min-width: 12rem; }
.tx-agenda-col > h3 { font-size: var(--tx-size-400); font-weight: var(--tx-weight-semibold); margin-bottom: var(--tx-space-2); min-height: 2.75rem; }
.tx-agenda-col__items {
  display: grid;
  grid-auto-rows: var(--tx-agenda-tick);
  gap: 1px;
}
.tx-agenda-block, .tx-agenda-gap { border-radius: var(--tx-radius-sm); overflow: hidden; }
/* §6.4 — relleno de identidad, borde de 1px SIEMPRE (para que el bloque se
   delimite aunque el tinte sea muy claro o el operador use alto contraste),
   sin sombra (la sombra está reservada a tarjeta KPI/diálogo). */
.tx-agenda-block { border: 1px solid var(--tx-divider-strong); }
.tx-agenda-block--identity-1 { background: var(--tx-identity-1-bg); }
.tx-agenda-block--identity-2 { background: var(--tx-identity-2-bg); }
.tx-agenda-block--identity-3 { background: var(--tx-identity-3-bg); }
.tx-agenda-block > button, .tx-agenda-gap > button {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  padding: var(--tx-space-1) var(--tx-space-2);
}
.tx-agenda-block > button { color: var(--tx-text-strong); }
/* §6.5 — un hueco es fondo de panel, sin relleno, con filete punteado
   superior; nunca dice "libre" (ver el texto en ui.html.ts/ui.js.ts). */
.tx-agenda-gap { background: var(--tx-panel-bg); border-top: 1px dashed var(--tx-divider-strong); }
.tx-agenda-gap > button { color: var(--tx-text-muted); }
.tx-agenda-block__l1 { font-weight: var(--tx-weight-semibold); font-variant-numeric: tabular-nums; font-size: var(--tx-size-200); }
.tx-agenda-block__l2 { font-size: var(--tx-size-200); }
.tx-agenda-block__l3 { font-size: var(--tx-size-100); color: var(--tx-text-muted); }
/* V2-3 — MEDIDO en WebKit real sobre la demostración: a 1150, 1120 y 1024 px
   (las tres anchuras que señaló el owner) la segunda línea de un bloque de 30
   min se parte en dos al estrecharse la columna, y el contenido desborda su
   caja 5 px —scrollHeight 60 sobre clientHeight 55—, con la tercera línea
   cortada por la mitad. A 1440 y 1280 no pasa. Dos reparaciones, las dos de
   forma y ninguna de contenido:

   (1) El interlineado de las líneas del bloque pasa a \`tight\`. Dentro de una
       caja de dos tics, \`normal\` (1,5) es interlineado de párrafo largo
       aplicado a dos frases cortas.
   (2) En los bloques CORTOS —15 min (un tic) y 30 min (dos)— cada línea se
       queda en UNA línea visual. Es el mismo criterio que ya rige su
       anatomía (§6.4: a 15 min se suprime todo menos el intervalo y la
       persona): en una caja de 55 px no cabe una tercera línea, y partirla
       para cortarla después no informa de nada. Nada se pierde: el nombre
       accesible del botón sigue diciendo intervalo, duración, persona,
       servicio y profesional enteros, y el detalle de la cita también. */
.tx-agenda-block__l1, .tx-agenda-block__l2, .tx-agenda-block__l3 { line-height: var(--tx-leading-tight); }
.tx-agenda-block.tx-agenda-s-1 > button > span,
.tx-agenda-block.tx-agenda-s-2 > button > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* V1-4/V1-5 — la parte del eje que NO es horario de atender: la extensión
   que se dibuja para que quepa una cita fuera de hora, y la pausa declarada
   del local. Se distingue del hueco reservable por dos cosas que no son
   color: NO lleva ningún control dentro (no hay nada que pulsar) y dice con
   palabras por qué. Fondo apagado y sin filete punteado, que es la marca del
   hueco. */
.tx-agenda-fuera {
  background: var(--tx-panel-bg-quiet);
  border: var(--tx-border-hairline);
  border-radius: var(--tx-radius-sm);
  display: flex;
  align-items: center;
  padding: var(--tx-space-1) var(--tx-space-2);
  font-size: var(--tx-size-100);
  color: var(--tx-text-muted);
  overflow: hidden;
}
.tx-agenda-col__cancelled { margin-top: var(--tx-space-3); }
.tx-agenda-col__ausencia { margin-top: var(--tx-space-1); margin-bottom: var(--tx-space-2); }
/* Banda de ausencia parcial: una TEXTURA (no sólo color) más su propio texto
   ("No está · Ausencia aprobada"), nunca pintada como un hueco reservable. */
.tx-agenda-banda-ausencia {
  background: repeating-linear-gradient(45deg, var(--tx-panel-bg-quiet), var(--tx-panel-bg-quiet) 6px, var(--tx-surface) 6px, var(--tx-surface) 12px);
  border: var(--tx-border-hairline);
  border-radius: var(--tx-radius-sm);
  display: flex;
  align-items: center;
  padding: var(--tx-space-1) var(--tx-space-2);
  font-size: var(--tx-size-100);
  color: var(--tx-text-muted);
}

.tx-agenda-semana-resumen { grid-column: span 12; list-style: none; padding: 0; margin: 0; }
.tx-agenda-semana-resumen > li { border: var(--tx-border-hairline); border-radius: var(--tx-radius-md); padding: var(--tx-space-3); margin-bottom: var(--tx-space-3); }
.tx-agenda-semana-resumen h3 { font-size: var(--tx-size-400); font-weight: var(--tx-weight-semibold); margin-bottom: var(--tx-space-1); }
.tx-agenda-semana-resumen__profesionales { margin-top: var(--tx-space-2); list-style: none; padding: 0; }
.tx-agenda-semana-resumen__profesionales li { padding: var(--tx-space-1) 0; border-top: var(--tx-border-hairline); }
.tx-agenda-semana-resumen__profesionales li:first-child { border-top: none; }

/* La familia de posicionamiento por TIC. Generada por sistema (no a mano):
   inicios hasta 25h de tics de 15 min (100) y duraciones hasta 16h (64),
   guardarraíles de forma amplios de sobra para un día real y para el tope
   estructural de 240 min de step 26 §1. Nunca se usa \`.style.\` para esto. */
${Array.from({ length: 100 }, (_, i) => `.tx-agenda-r-${String(i + 1)} { grid-row-start: ${String(i + 1)}; }`).join("\n")}
${Array.from({ length: 64 }, (_, i) => `.tx-agenda-s-${String(i + 1)} { grid-row-end: span ${String(i + 1)}; }`).join("\n")}

/* ------------------------------------------------------------------ */
/* 6.7 tx-absence-chip                                                  */
/* ------------------------------------------------------------------ */
.tx-absence-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--tx-space-2);
  padding: var(--tx-space-1) var(--tx-space-3);
  border-radius: var(--tx-radius-pill);
  border: 1px solid var(--tx-action);
  color: var(--tx-action);
  background: var(--tx-action-bg);
  font-size: var(--tx-size-200);
}

/* ------------------------------------------------------------------ */
/* Horario del local (Equipo)                                          */
/* ------------------------------------------------------------------ */
.tx-week-strip {
  list-style: none; margin: var(--tx-space-3) 0 var(--tx-space-4); padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  gap: var(--tx-space-2);
}
/* §5 (Equipo) — el ritmo nuevo, y ni un icono generado desde el cliente:
   renderEquipo es el caso de referencia del DOM falso y sólo puede usar
   createElement/textContent. */
.tx-week-strip > li {
  border: var(--tx-border-hairline);
  border-radius: var(--tx-radius-md);
  padding: var(--tx-space-3);
  font-size: var(--tx-size-200);
  min-width: 0;
}
.tx-week-strip__day   { display: block; font-weight: var(--tx-weight-semibold); color: var(--tx-text-strong); }
.tx-week-strip__hours { display: block; color: var(--tx-text-muted); font-variant-numeric: tabular-nums; }

.tx-pro-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: var(--tx-space-4);
}

/* ------------------------------------------------------------------ */
/* Professional card (Equipo)                                           */
/* ------------------------------------------------------------------ */
.tx-pro-card {
  border: var(--tx-border-hairline); border-radius: var(--tx-radius-lg);
  background: var(--tx-panel-bg);
  padding: var(--tx-space-4);
  display: flex; flex-direction: column;
  gap: var(--tx-space-3);
}
.tx-pro-card__head { display: flex; align-items: center; justify-content: space-between; gap: var(--tx-space-3); flex-wrap: wrap; min-width: 0; }
.tx-pro-card__head h3 { font-size: var(--tx-size-500); font-weight: var(--tx-weight-semibold); }
.tx-pro-card__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--tx-space-2); font-size: var(--tx-size-300); min-width: 0; }
.tx-pro-card__k {
  font-size: var(--tx-size-100); text-transform: uppercase;
  letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted);
  font-weight: var(--tx-weight-semibold);
}

/* ------------------------------------------------------------------ */
/* 6.10 tx-dialog                                                       */
/* ------------------------------------------------------------------ */
.tx-dialog {
  border: none;
  border-radius: var(--tx-radius-lg);
  box-shadow: var(--tx-shadow-dialog);
  padding: var(--tx-space-6);
  max-width: 640px;
  width: calc(100vw - 2 * var(--tx-space-6));
  /* step 19 D2 — el <dialog> nativo trae un max-height de la hoja de
     estilos del navegador, pero su overflow por defecto es visible: hoy, si
     el contenido no cabe, se recorta. Con esto un paso largo se puede leer
     entero desplazándose por DENTRO del diálogo, sin que la página de detrás
     se mueva. Vale para los diez diálogos de la consola *(corregido
     2026-08-05 tras revisión adversarial de la capacidad 3, hallazgo m10:
     decía "siete" — desactualizado desde que step 18/19 añadieron los
     diálogos de inasistencia, corrección, grupo y confirmación de reinicio).* */
  max-height: calc(100vh - var(--tx-space-8));
  overflow-y: auto;
  overscroll-behavior: contain;
}
.tx-dialog::backdrop { background: rgba(23, 22, 21, 0.45); }
.tx-dialog__title { font-size: var(--tx-size-600); font-weight: var(--tx-weight-semibold); line-height: var(--tx-leading-tight); margin-bottom: var(--tx-space-2); }
.tx-dialog__step { font-size: var(--tx-size-100); text-transform: uppercase; letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted); font-weight: var(--tx-weight-semibold); margin-bottom: var(--tx-space-3); }
.tx-dialog__body { color: var(--tx-text-body); margin-bottom: var(--tx-space-3); }
/* Deuda D-B2-2 (preexistente, imputada como tal): sin \`flex-wrap\`, una fila
   de acciones con tres botones —«Atrás», «Cancelar», «Publicar»— desborda su
   diálogo en el móvil estrecho y a zoom 200 %, donde no hay 320 px para los
   tres en línea. Envolver es lo que hace que el último botón siga siendo
   alcanzable; \`justify-content: flex-end\` mantiene el orden y el anclaje. */
.tx-dialog__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--tx-space-3); margin-top: var(--tx-space-5); }
.tx-dialog__form-grid { display: flex; flex-direction: column; gap: var(--tx-space-3); }

.tx-impact-table { display: flex; flex-direction: column; gap: var(--tx-space-3); }
.tx-impact-row { border: var(--tx-border-hairline); border-radius: var(--tx-radius-md); padding: var(--tx-space-3); }
.tx-impact-row__title { font-weight: var(--tx-weight-semibold); margin-bottom: var(--tx-space-2); }

.tx-status-line { font-size: var(--tx-size-300); color: var(--tx-text-body); min-height: 1.2em; }
/* V3-12 — el contador del tope de la nota. Mismo tratamiento que el del
   Taller: pequeño, apagado y alineado a la derecha del campo, porque es un
   dato de apoyo y no un mensaje. Se anuncia por \`aria-describedby\` del propio
   campo, no como región viva: nadie necesita oír cada pulsación. */
.tx-nota-contador { font-size: var(--tx-size-100); color: var(--tx-text-muted); text-align: right; font-variant-numeric: tabular-nums; }
.tx-status-line--error { color: var(--tx-status-error); font-weight: var(--tx-weight-semibold); }
.tx-status-line--ok { color: var(--tx-status-ok); font-weight: var(--tx-weight-semibold); }
/* step 17 §9.5. Un CONFLICTO no es un error: la demostración ha parado a
   propósito para no escribir algo incorrecto. Se dice en ámbar y con un
   borde propio a la izquierda, no en rojo, porque no hay nada roto — y el
   texto lo dice también, que el color nunca informa solo (§9.7). */
.tx-status-line--conflict {
  color: var(--tx-status-warn);
  font-weight: var(--tx-weight-semibold);
  border-left: 3px solid var(--tx-status-warn);
  padding-left: var(--tx-space-2);
}

/* step 18 §1.2.2 (enmienda de fase D, N2). Una línea de estado VACÍA termina
   con \`hidden\` puesto: es lo que la saca del árbol de accesibilidad para que
   un texto rancio no siga anunciándose después de un reinicio. Pero
   \`[hidden] { display: none !important; }\` (arriba) le quitaría también la
   CAJA, y estas líneas ya reservan hoy su \`min-height: 1.2em\` estando
   vacías: los botones de los diálogos saltarían hacia arriba cada vez que un
   mensaje aparece o desaparece.

   \`visibility: hidden\` da las dos cosas a la vez: el contenido sale del árbol
   de accesibilidad (y de la vista) y la caja se queda donde estaba. Gana a la
   regla de \`[hidden]\` por especificidad (0,2,0 frente a 0,1,0, las dos con
   !important), no por orden.

   Las CINCO excepciones de abajo son líneas de estado cuyo \`hidden\` NO
   significa "vacía": significa "esta línea no va en esta pantalla". Reservarles
   la caja dejaría un hueco en blanco permanente en la rejilla de Inicio, en la
   de Lista de espera, arriba de todo el espacio de trabajo y (las dos últimas,
   verificado en Chrome real: 16,8 px de hueco) en los diálogos de día especial
   y de ausencia mientras el aviso de retirada no aplica a ese paso o a esa
   apertura. Para ellas manda la regla general de \`[hidden]\`, con la
   especificidad de un id. */
.tx-status-line[hidden] { display: block !important; visibility: hidden; }
#inicio-ruta-desconocida[hidden],
#lista-espera-cargando[hidden],
#dia-especial-aviso-retirada[hidden],
#ausencia-aviso-retirada[hidden],
#estado-global[hidden] { display: none !important; }

/* ------------------------------------------------------------------ */
/* 6.13 tx-details                                                      */
/* ------------------------------------------------------------------ */
/* §2.5 — la frontera entre lo operativo y lo técnico. El summary es la
   zona táctil de 44 px con su propio triángulo (el marcador nativo se apaga
   porque no se puede estilar igual en todos los navegadores); el cuerpo va
   monoespaciado y apagado, para que se lea como lo que es: material de
   diagnóstico, no la pantalla de trabajo.
   §7.1, trampa 7: este summary es display:flex EN FILA. Todo hijo suyo es un
   ítem flex con su propio min-content y puede desbordar a 690 px — por eso
   el contenido largo vive en el cuerpo, nunca dentro del summary. */
.tx-details summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-size: var(--tx-size-300); font-weight: var(--tx-weight-semibold); color: var(--tx-text-body); list-style: none; }
.tx-details summary::-webkit-details-marker { display: none; }
.tx-details summary::before { content: '▸'; margin-right: var(--tx-space-2); color: var(--tx-text-muted); }
.tx-details[open] summary::before { content: '▾'; }
.tx-details__body { padding: var(--tx-space-3) 0; font-family: var(--tx-font-mono); font-size: var(--tx-size-200); color: var(--tx-text-body); }
.tx-details__body dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--tx-space-2) var(--tx-space-4); margin: 0; }
.tx-details__body dt { color: var(--tx-text-muted); }
/* (revisión step 15, punto 3) Sin esto, un valor irrompible (el hash de 64
   caracteres del identificador de llamada, o un código interno largo como
   SLOT_OUTSIDE_SYNTHETIC_SCHEDULE) fija el ancho MÍNIMO de la columna "1fr"
   a su propio ancho de contenido — un elemento de rejilla no se encoge por
   debajo de su contenido a menos que se le diga expresamente. Eso forzaba
   ~757px de ancho mínimo en este panel y desbordaba la página entera a partir
   de ~700px, sin que ningún contenedor de aquí tuviera scroll propio. */
.tx-details__body dd { min-width: 0; overflow-wrap: anywhere; }
.tx-details__body pre { white-space: pre-wrap; word-break: break-word; }
/* (revisión adversarial de la capacidad 3, hallazgo m3) La misma causa que
   la nota de arriba, pero en un <p>, no un <dd>: el detalle técnico nuevo de
   una tarea (§4.6) pinta el hash de 64 caracteres de la llamada asociada en
   un <p> normal, que no tenía la propiedad. */
.tx-details__body p { overflow-wrap: anywhere; }

/* ------------------------------------------------------------------ */
/* Call detail panel                                                    */
/* ------------------------------------------------------------------ */
.tx-call-detail { grid-column: span 12; border: var(--tx-border-hairline); border-radius: var(--tx-radius-lg); background: var(--tx-panel-bg); padding: var(--tx-space-6); display: flex; flex-direction: column; gap: var(--tx-space-4); }
.tx-call-detail__head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: var(--tx-space-3); }
.tx-call-detail h3 { font-size: var(--tx-size-100); text-transform: uppercase; letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted); margin-top: var(--tx-space-3); margin-bottom: var(--tx-space-1); }
.tx-orphan-warning { border: 1px dashed var(--tx-status-warn); background: var(--tx-status-warn-bg); border-radius: var(--tx-radius-md); padding: var(--tx-space-3); color: var(--tx-status-warn); }

/* ------------------------------------------------------------------ */
/* Lista de espera (step 17)                                           */
/* ------------------------------------------------------------------ */
/* Se reutiliza todo lo que ya existe (.tx-panel, .tx-pill, .tx-table,
   .tx-empty, .tx-details, .tx-radio-field, .tx-status-line). Lo de abajo es
   lo poco que no existía: la tarjeta de un hueco liberado, la lista de
   cifras, las dos notas de fila y el banner de fallo de integridad. */
.tx-slot-list { display: flex; flex-direction: column; gap: var(--tx-space-4); }
.tx-slot-card {
  border: var(--tx-border-hairline);
  border-left: var(--tx-border-accent);
  border-radius: var(--tx-radius-md);
  background: var(--tx-panel-bg);
  padding: var(--tx-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--tx-space-2);
  align-items: flex-start;
}
.tx-slot-card h3 { font-size: var(--tx-size-500); font-weight: var(--tx-weight-semibold); }
/* §5 (Lista de espera) — la frase que encabeza un hueco liberado, y las
   cifras del panel de recuento, con las cifras de ancho fijo que §2.3 exige
   a TODA cifra y TODA hora. */
.tx-slot-card__lead { font-weight: var(--tx-weight-semibold); font-variant-numeric: tabular-nums; }
.tx-slot-card__choice { border: none; margin: 0; padding: 0; width: 100%; }
.tx-slot-card__choice legend { font-size: var(--tx-size-200); text-transform: uppercase; letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted); font-weight: var(--tx-weight-semibold); }
.tx-slot-card__options { display: flex; flex-direction: column; }
.tx-slot-card__options .tx-radio-field { align-items: flex-start; padding: var(--tx-space-1) 0; }

/* (Reparación R2-UX, defectos 5 y 7) TRES LÍNEAS, TRES PAPELES DISTINTOS.
   Nada de esto informa POR EL COLOR: cada una lleva su texto entero y se
   entiende igual en blanco y negro, con Reduce Motion o a 200% de zoom. El
   peso y el fondo sólo hacen que el destinatario actual no se lea como una
   fila más de la lista de alternativas, que es exactamente el error que la
   auditoría manual encontró.

   Deliberadamente NO es una renovación visual: son tres reglas nuevas sobre
   los tokens que ya existen, sin tocar ni una de las de arriba. */
.tx-slot-card__recipient {
  font-weight: var(--tx-weight-semibold);
  font-size: var(--tx-size-400);
  color: var(--tx-text-strong);
}
.tx-slot-card__done {
  border-left: var(--tx-border-accent);
  background: var(--tx-green-50);
  color: var(--tx-text-body);
  padding: var(--tx-space-2) var(--tx-space-3);
  border-radius: var(--tx-radius-sm);
  align-self: stretch;
}
.tx-slot-card__preview {
  background: var(--tx-notice-bg);
  color: var(--tx-text-body);
  font-size: var(--tx-size-200);
  padding: var(--tx-space-2) var(--tx-space-3);
  border-radius: var(--tx-radius-sm);
  align-self: stretch;
}

/* .tx-slot-card es flex en columna con align-items:flex-start, así que sin
   esta línea el <details> se queda al ancho de su etiqueta y la zona táctil
   de 44px del summary sólo cubre esa anchura. Esta línea NO corrige el
   desbordamiento a 690px: eso lo corrige devolver las cinco líneas al
   cuerpo en ui.js.ts (dentro del summary flex quedaban fuera del alcance
   de \`.tx-details__body p\`).
   Enmienda 2026-08-06 (revisión adversarial step 19R1): el mecanismo
   dominante del desbordamiento no era "un token irrompible" sino que
   \`.tx-details summary\` de arriba es \`display: flex\` sin \`flex-direction\`
   (por tanto \`row\`), así que esas cinco líneas, siendo hijas del summary,
   eran cinco ítems flex EN FILA, cada uno con min-width:auto = su propio
   min-content — la suma de los cinco, no un solo valor, es lo que
   desbordaba. Añadir overflow-wrap a los hijos del summary habría bajado
   los píxeles sin corregir la mitad grave: el nombre accesible del summary
   cerrado seguiría siendo el payload entero. Ver (internal doc, not included in the template)
   §10.1. */
.tx-slot-card .tx-details { align-self: stretch; }

/* Las dos notas que cuelgan de una celda de tabla: el veredicto de plazo de
   una cita cancelada, el hueco ofrecido a una persona, el motivo por el que
   una oferta ha dejado de valer. */
.tx-row-note { font-size: var(--tx-size-200); color: var(--tx-text-muted); margin-top: var(--tx-space-1); }

.tx-figure-list { display: grid; grid-template-columns: 1fr auto; gap: var(--tx-space-1) var(--tx-space-4); margin: 0 0 var(--tx-space-3); }
.tx-figure-list > div { display: contents; }
.tx-figure-list dt { color: var(--tx-text-body); }
.tx-figure-list dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: var(--tx-weight-semibold); }

/* El único banner rojo de toda la consola, y sólo aparece cuando la propia
   demostración detecta que ha dicho que hizo algo que no hizo (§11). */
.tx-panel--alarm { border: 2px solid var(--tx-status-error); background: var(--tx-status-error-bg); }
.tx-panel--alarm > h2 { color: var(--tx-status-error); font-size: var(--tx-size-500); }

/* Una cita cancelada sigue leyéndose, pero no compite con las vivas. */
.tx-table tbody tr.tx-table__row--cancelled { color: var(--tx-text-muted); background: var(--tx-status-neutral-bg); }

/* ------------------------------------------------------------------ */
/* step 18 — inasistencias y reserva para varias personas              */
/* ------------------------------------------------------------------ */
/* Igual que la lista de espera: se reutiliza todo lo que ya existe
   (.tx-panel, .tx-pill, .tx-table, .tx-dialog, .tx-status-line,
   .tx-slot-card para cada propuesta). Lo de abajo es lo poco que no
   existía. */

/* §3.6 — el reloj SINTÉTICO de la barra superior, distinguido a la vista
   del reloj de pared que hay justo encima (.tx-freshness): el de arriba
   es la hora del ordenador de quien mira, éste es la hora con la que
   opera la demostración. No es aria-live (se repinta cada 2 s). */
.tx-synthetic-clock {
  font-size: var(--tx-size-200);
  color: var(--tx-action);
  font-weight: var(--tx-weight-semibold);
  font-variant-numeric: tabular-nums;
}

/* §5.4, paso 1 — una ficha con rótulo por persona (step 19 D2: la técnica
   que step 18 §5.7 prometió y nunca implementó). El <fieldset> NO es el
   contenedor de rejilla/flex — eso lo lleva .tx-group-row__fields, de
   dentro — porque display:flex/grid sobre <fieldset> tiene historial de
   rarezas en navegadores que esta consola no puede comprobar desde el VPS. */
.tx-group-row {
  border: 0; margin: 0; min-width: 0;
  padding: var(--tx-space-3) 0;
  border-bottom: var(--tx-border-hairline);
}
.tx-group-row:last-child { border-bottom: none; }
.tx-group-row__legend {
  padding: 0;
  font-size: var(--tx-size-200);
  text-transform: uppercase;
  letter-spacing: var(--tx-tracking-caps);
  color: var(--tx-text-muted);
  font-weight: var(--tx-weight-semibold);
}
.tx-group-row__fields {
  display: flex; flex-wrap: wrap; gap: var(--tx-space-3); align-items: flex-end;
  margin-top: var(--tx-space-2);
}
.tx-group-row__fields .tx-field { flex: 1 1 11rem; min-width: 0; }
.tx-group-row select { width: 100%; }
.tx-group-row__actions { margin-top: var(--tx-space-2); display: flex; justify-content: flex-end; }

/* §5.4, paso 3 — una propuesta. Se apoya en .tx-slot-card, que ya existe. */
.tx-proposal__lines { list-style: none; margin: var(--tx-space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--tx-space-1); }
.tx-proposal__lines > li { font-size: var(--tx-size-300); }

/* El diálogo de cuatro pasos lleva una tabla de cinco columnas en el paso 4:
   necesita más aire que los diálogos de una sola pregunta, y sigue sin
   desbordar porque el ancho está acotado por el viewport. */
.tx-dialog--wide { max-width: 880px; }

/* ------------------------------------------------------------------ */
/* Laboratorio                                                          */
/* ------------------------------------------------------------------ */
.tx-event-counts { display: grid; grid-template-columns: 1fr 1fr; gap: var(--tx-space-6); }
.tx-event-counts dl { display: grid; grid-template-columns: 1fr auto; gap: var(--tx-space-1) var(--tx-space-3); margin: 0; font-family: var(--tx-font-mono); font-size: var(--tx-size-200); }
/* step 19 D1 — el suelo de min-content que desbordaba la página. El elemento
   de rejilla de este <dl> es el <div> que renderEventCountsDl (ui.js.ts:2857-
   2875) crea por evento para colgarle el data-key de reconcileList: los <dt> y
   los <dd> son HIJOS suyos, no elementos de rejilla, así que ponerles a ellos
   min-width:0 no habría hecho absolutamente nada. */
.tx-event-counts dl > div { min-width: 0; }
/* Y el texto irrompible que empuja ese mínimo vive en el <dt>: se le permite
   partirse, igual que ya se le permite al hash de 64 caracteres en :718. */
.tx-event-counts dt { color: var(--tx-text-body); overflow-wrap: anywhere; }
.tx-event-counts dd { margin: 0; font-variant-numeric: tabular-nums; }
.tx-latency-note { margin-top: var(--tx-space-4); padding-top: var(--tx-space-4); border-top: var(--tx-border-hairline); color: var(--tx-text-muted); font-size: var(--tx-size-300); }
/* §5 (Laboratorio) — la zona peligrosa, APARTE del resto: además del borde
   rojo que ya tenía, un filete grueso a la izquierda para que se distinga
   de un panel normal por la forma, no sólo por el color. */
.tx-danger-zone { border-color: var(--tx-status-error); border-left: 3px solid var(--tx-status-error); }
.tx-raw-json { max-height: 24rem; overflow: auto; background: var(--tx-panel-bg-quiet); padding: var(--tx-space-3); border-radius: var(--tx-radius-sm); font-family: var(--tx-font-mono); font-size: var(--tx-size-200); white-space: pre-wrap; word-break: break-word; }

/* ------------------------------------------------------------------ */
/* step 20 §6.3 — Taller de decisiones con Bruno                        */
/* ------------------------------------------------------------------ */
/* UNA sola columna a todos los anchos (D20-33): ninguna rejilla nueva y
   NINGÚN @media nuevo. Los textos largos (identificadores, opciones,
   comportamiento hoy) parten DENTRO de la tarjeta con overflow-wrap, el
   mismo mecanismo que resolvió el desbordamiento de .tx-slot-card.
   REGLA PROHIBIDA (I20-5), con prueba de contrato: ningún selector de este
   fichero distingue una opción de otra dentro de .tx-taller-card__opciones
   — ni :first-child, ni :nth-child, ni [value=...]. Todas las opciones
   comparten exactamente las mismas reglas. */
.tx-taller-bloque { display: flex; flex-direction: column; gap: var(--tx-space-3); margin-top: var(--tx-space-4); }
.tx-taller-bloque__cabecera { display: flex; flex-direction: column; gap: var(--tx-space-1); min-width: 0; }
.tx-taller-bloque__cabecera h3 { font-size: var(--tx-size-400); font-weight: var(--tx-weight-semibold); overflow-wrap: anywhere; }
.tx-taller-bloque__tarjetas { display: flex; flex-direction: column; gap: var(--tx-space-4); }
.tx-taller-card {
  border: var(--tx-border-hairline);
  border-left: var(--tx-border-accent);
  border-radius: var(--tx-radius-md);
  background: var(--tx-panel-bg);
  padding: var(--tx-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--tx-space-2);
  align-items: flex-start;
  min-width: 0;
}
.tx-taller-card__titulo { font-size: var(--tx-size-500); font-weight: var(--tx-weight-semibold); overflow-wrap: anywhere; display: flex; flex-wrap: wrap; align-items: center; gap: var(--tx-space-2); min-width: 0; }
.tx-taller-card__pregunta { font-weight: var(--tx-weight-semibold); overflow-wrap: anywhere; }
.tx-taller-card__hoy { width: 100%; min-width: 0; }
.tx-taller-card__hoy p { overflow-wrap: anywhere; }
.tx-taller-card__rotulo { font-size: var(--tx-size-200); text-transform: uppercase; letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted); font-weight: var(--tx-weight-semibold); }
.tx-taller-card__choice { border: none; margin: 0; padding: 0; width: 100%; min-width: 0; }
.tx-taller-card__choice legend { font-size: var(--tx-size-200); text-transform: uppercase; letter-spacing: var(--tx-tracking-caps); color: var(--tx-text-muted); font-weight: var(--tx-weight-semibold); }
.tx-taller-card__opciones { display: flex; flex-direction: column; }
.tx-taller-card__opciones .tx-radio-field { align-items: flex-start; padding: var(--tx-space-1) 0; }
.tx-taller-card__opciones .tx-radio-field span { overflow-wrap: anywhere; min-width: 0; }
.tx-taller-nota { width: 100%; display: flex; flex-direction: column; gap: var(--tx-space-1); }
/* (Revisión U11-8) El campo de nota con la ropa de la casa: la etiqueta con
   la letra y el color de .tx-field, y el <textarea> con el borde, el radio,
   el relleno y la monoespaciada que ya llevan todos los campos (.tx-field
   textarea). Antes iba desnudo — font: inherit y gracias. */
.tx-taller-nota label { display: flex; flex-direction: column; gap: var(--tx-space-1); }
.tx-taller-nota label > span { font-size: var(--tx-size-200); color: var(--tx-text-body); }
.tx-taller-nota__campo {
  width: 100%;
  max-width: 100%;
  padding: var(--tx-space-2) var(--tx-space-3);
  border: var(--tx-border-control);
  border-radius: var(--tx-radius-sm);
  background: var(--tx-panel-bg);
  color: var(--tx-text-strong);
  font-family: var(--tx-font-mono);
  font-size: var(--tx-size-300);
}
/* (Revisión U11-4) El aparte de la pregunta en cursiva: la que en el pack
   ponían los asteriscos de Markdown, que con textContent salían literales. */
.tx-taller-card__aparte { font-style: italic; }
.tx-taller-nota__contador { font-size: var(--tx-size-200); color: var(--tx-text-muted); font-variant-numeric: tabular-nums; }
/* La píldora de urgencia: las bloqueantes usan el tono de CONFLICTO de la
   casa (ámbar), nunca el de error — «un conflicto no es un error» — y sin
   iconos ni parpadeos (§3.10). */
.tx-taller-urgencia { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px var(--tx-space-2); font-size: var(--tx-size-100); font-weight: var(--tx-weight-semibold); letter-spacing: normal; text-transform: none; }
.tx-taller-urgencia--bloquea { color: var(--tx-status-warn); background: var(--tx-status-warn-bg); border: 1px dashed var(--tx-status-warn); }
.tx-taller-urgencia--espera { color: var(--tx-status-neutral); background: transparent; border: 1px solid var(--tx-divider-strong); }
.tx-taller-card .tx-details { align-self: stretch; }

/* ------------------------------------------------------------------ */
/* step 26 REAPERTURA §R9/§R11 — Horarios y ausencias                  */
/* ------------------------------------------------------------------ */
/* Las dos clases que el normativo (§ "Clases CSS nuevas") asigna a la
   Oleada A1. A1 entregó sus cuatro commits sin ellas, así que las escribe
   aquí la Oleada B, que es quien las usa: son estilos NUEVOS de esta
   pantalla y no tocan ni la barra lateral, ni el eje, ni ninguna @media
   existente. NINGÚN @media nuevo.

   .tx-nota-operativa lleva EXACTAMENTE las dos declaraciones que el §R11
   fija, y son las mismas que ya resuelven los textos largos del Taller
   (:1533): una nota de 280 caracteres sin un solo espacio parte DENTRO de
   su caja a 375 px y a zoom 200 %, en vez de ensanchar la fila. */
.tx-nota-operativa { overflow-wrap: anywhere; min-width: 0; display: block; color: var(--tx-text-muted); }
/* El repaso previo a publicar (paso 3 de los dos diálogos, y paso 2 del de
   retirada). Una caja tranquila y separada: lo que se lee aquí es lo que se
   va a publicar, y tiene que distinguirse del formulario de arriba por la
   FORMA, no sólo por el color. */
.tx-dialog__summary {
  display: flex; flex-direction: column; gap: var(--tx-space-2);
  border: var(--tx-border-hairline); border-left: 3px solid var(--tx-action);
  border-radius: var(--tx-radius-md);
  padding: var(--tx-space-3);
  background: var(--tx-panel-bg-quiet);
  margin-bottom: var(--tx-space-3);
  min-width: 0;
}
.tx-dialog__summary p { margin: 0; overflow-wrap: anywhere; }
.tx-dialog__summary ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--tx-space-1); }
.tx-dialog__summary li { color: var(--tx-text-body); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
/* La fila de una excepción: cuerpo que crece y sus dos controles al lado,
   que se apilan solos cuando no caben (flex-wrap, ningún @media). */
.tx-excepcion-fila { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--tx-space-3); }
.tx-excepcion-fila__cuerpo { flex: 1 1 18rem; min-width: 0; display: flex; flex-direction: column; gap: var(--tx-space-1); }
.tx-excepcion-fila__cuerpo p { margin: 0; overflow-wrap: anywhere; }
.tx-excepcion-fila__acciones { display: flex; flex-wrap: wrap; gap: var(--tx-space-2); }

/* ------------------------------------------------------------------ */
/* 4.5 Breakpoints — desktop-first, descending max-width                */
/* ------------------------------------------------------------------ */

/* §3.5 y §6.5 — los cuatro puntos de corte históricos cubren las cinco
   anchuras de aceptación: 1440 entra por la base, 1280 por ≤1439, 1024 por
   ≤1279, 768 por ≤1023 y 690 por ≤720.

   (M25) Antes había aquí una regla de «CERO puntos de corte nuevos», y su
   motivo era bueno: cada corte multiplica los estados que hay que comprobar
   A MANO. Pero ese ahorro estaba juntando dos decisiones que no son la
   misma, y de ahí salió un fallo real.

   El corte de 1279 decidía a la vez (a) cuándo la barra lateral se repliega
   a raíl de iconos y (b) cuándo las columnas 8/4 se apilan. Son cosas
   distintas: (b) es densidad de contenido y a 1279 está bien; (a) es el modo
   de NAVEGACIÓN, y ponerlo a 1279 lo dejaba pegado a la anchura de trabajo
   real. Con la reserva de canal de arriba, «pegado» significa que 15 px de
   barra de scroll bastaban para cruzarlo. Un raíl de iconos a 1265 px de
   ancho útil no lo pedía el espacio: sobraba sitio para las etiquetas.

   Así que el corte del raíl baja a 1119 px y se queda solo en su propio
   bloque. La separación es deliberada: la reserva de canal cuesta ~15-17 px
   de forma permanente, y el raíl no debe aparecer por ese margen. Con el
   corte a 1119, una ventana de 1280 px conserva 1263-1265 px útiles y sigue
   expandida, con ~145 px de holgura — sobrevive a una barra más ancha, a un
   zoom moderado y a una ventana algo menor. El modo compacto NO desaparece:
   vive en 1024-1119 px, y por debajo de 1024 sigue mandando la navegación
   horizontal de ≤1023. Ninguna de las dos reglas mira la ruta. */

@media (max-width: 1439px) {
  .tx-sidebar { flex-basis: 200px; width: 200px; }
  .tx-workspace { max-width: 1000px; padding-inline: var(--tx-space-6); }
  .tx-topbar { padding-inline: var(--tx-space-6); }
}

/* Densidad de CONTENIDO. Se queda en 1279: a esa anchura una columna de 4/12
   ya es demasiado estrecha para leerse, y eso no tiene nada que ver con la
   barra lateral, que ahora se decide más abajo.
   (\`.tx-stat-grid\` a repeat(4, 1fr) repite aquí el valor base a propósito:
   la prueba A5 de uiClientLogic.test.ts ancla por escrito que a 1279px los
   cuatro KPI de Inicio van en UNA fila, y ese ancla se respeta.) */
@media (max-width: 1279px) {
  .tx-stat-grid { grid-template-columns: repeat(4, 1fr); }
  .tx-col-8, .tx-col-4 { grid-column: span 12; }
  /* step 26, Adenda A — «relleno y eje comprimidos» a esta densidad de
     contenido: la rejilla de Agenda sigue siendo una rejilla, sólo más
     apretada. No es el corte de navegación (ver §4.5). */
  .tx-agenda-grid, .tx-agenda-grid--cols-1, .tx-agenda-grid--cols-2, .tx-agenda-grid--cols-3, .tx-agenda-grid--cols-4, .tx-agenda-grid--cols-5, .tx-agenda-grid--cols-6, .tx-agenda-grid--cols-7, .tx-agenda-grid--cols-muchas { gap: 0 var(--tx-space-2); }
  .tx-agenda-grid__axis { padding-top: 2.25rem; }
  .tx-agenda-col > h3 { min-height: 2.25rem; }
  .tx-agenda-block > button, .tx-agenda-gap > button { padding: 2px var(--tx-space-1); }
}

/* Modo de NAVEGACIÓN: el raíl de iconos. Ver la nota de §4.5 sobre por qué
   este corte está separado del de 1279 y por qué está donde está. */
@media (max-width: 1119px) {
  .tx-sidebar { flex-basis: 76px; width: 76px; }
  .tx-brand { padding: var(--tx-space-3); display: flex; flex-direction: column; align-items: center; }
  .tx-brand__plate { display: none; }
  .tx-brand__glyph { display: flex; }
  .tx-brand__venue { display: none; }
  .tx-nav__list { padding: 0 var(--tx-space-2); }
  /* El raíl de 76 px: sólo iconos. El nombre accesible del enlace no cambia
     (lo da su aria-label en el HTML), sólo desaparece la etiqueta visible. */
  .tx-nav__list a { justify-content: center; padding: var(--tx-space-3); gap: 0; }
  .tx-nav__label { display: none; }
  /* (step 16) Antes esto era display:none: sacaba el rótulo del árbol de
     accesibilidad. Ahora se oculta visualmente pero sigue disponible para el
     lector de pantalla; la línea separadora la lleva .tx-nav__list--tools. */
  .tx-sidebar__tools-label {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  .tx-sidebar__foot { display: none; }
}

@media (max-width: 1023px) {
  .tx-shell { flex-direction: column; }
  .tx-sidebar {
    flex-basis: auto; width: auto; flex-direction: row; align-items: center;
    overflow-x: auto; scroll-snap-type: x proximity;
    /* REAPERTURA §R5 — la barra fija es de ESCRITORIO. Aquí es una tira
       horizontal que se desplaza con el documento. */
    position: static; height: auto; overflow-y: visible; align-self: auto;
  }
  .tx-brand { flex: 0 0 auto; padding: var(--tx-space-2) var(--tx-space-3); }
  .tx-brand__plate { display: block; width: 40px; }
  .tx-brand__plate img { width: 40px; height: 40px; }
  .tx-brand__glyph { display: none; }
  .tx-nav__list { display: flex; flex-direction: row; padding: 0 var(--tx-space-2); }
  /* §3.3 — con la barra en horizontal, un filete a la IZQUIERDA de cada
     entrada ya no es una señal de "estás aquí": es una raya suelta en medio
     de una fila. La misma marca de 3 px pasa abajo, donde sí lee como
     subrayado de pestaña. Sigue sin ser sólo color: el peso semibold y el
     fondo activo acompañan, y el aria-current no depende de la anchura. */
  .tx-nav__list a {
    min-width: 88px;
    scroll-snap-align: start;
    justify-content: center;
    border-left: none;
    border-bottom: 3px solid transparent;
  }
  .tx-nav__list a[aria-current="page"] { border-bottom-color: var(--tx-action-mark); }
  /* (step 16) igual que arriba: oculto visualmente, no del árbol de
     accesibilidad. En esta anchura la barra lateral es horizontal, así que el
     separador de Laboratorio pasa a ser una línea vertical (ver
     .tx-nav__list--tools más abajo). */
  .tx-sidebar__tools-label {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  .tx-nav__list--tools {
    margin-top: 0; padding-top: 0; border-top: none;
    margin-left: var(--tx-space-2); padding-left: var(--tx-space-2);
    border-left: 1px solid var(--tx-sidebar-line);
  }
  .tx-sidebar__foot { display: none; }
  .tx-topbar { position: static; }
  .tx-stat-grid { grid-template-columns: repeat(2, 1fr); }
  /* step 26 §12/Adenda A — a esta anchura la rejilla de Día/Semana
     DESAPARECE (nunca desplazamiento horizontal nuevo) y las columnas se
     leen como lista cronológica, una tras otra: se apaga el grid del
     contenedor y las clases .tx-agenda-r-N/.tx-agenda-s-N dejan de tener
     efecto por sí solas (grid-row no hace nada fuera de un contenedor
     grid), sin que ninguna regla nueva tenga que desmontarlas una a una. */
  .tx-agenda-grid { display: block; }
  .tx-agenda-grid__axis { display: none; }
  .tx-agenda-col { margin-bottom: var(--tx-space-5); }
  .tx-agenda-col__items { display: block; }
  .tx-agenda-block, .tx-agenda-gap { display: block; margin-bottom: var(--tx-space-2); min-height: 44px; }
}

@media (max-width: 720px) {
  .tx-workspace { padding: var(--tx-space-4) var(--tx-space-4) var(--tx-space-12); }
  /* (step 16, §4.5) Los 24px de padding de .tx-panel son un lujo a 320px:
     son 48px de los 288 disponibles. Bajan a 16, y la rejilla del calendario
     (y cualquier otro panel) gana un 20% de ventana. */
  .tx-panel { padding: var(--tx-space-4); }
  .tx-stat-grid { grid-template-columns: 1fr; }
  .tx-stat__value { font-size: var(--tx-size-700); }
  .tx-topbar { padding: var(--tx-space-3) var(--tx-space-4); }
  .tx-btn-row { flex-direction: column; align-items: stretch; }
  .tx-btn-row .tx-btn { width: 100%; }
  /* (step 16, §4.5) "Añadir día especial" es un botón primario de 44px de
     alto que vive FUERA de .tx-btn-row (la regla de arriba no lo alcanza):
     a ancho completo se pulsa sin apuntar. */
  .tx-controls > .tx-btn { width: 100%; }

  .tx-table--stack, .tx-table--stack thead, .tx-table--stack tbody, .tx-table--stack tr, .tx-table--stack td {
    display: block;
    width: 100%;
  }
  .tx-table--stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  .tx-table--stack tbody tr { border: var(--tx-border-hairline); border-radius: var(--tx-radius-md); margin-bottom: var(--tx-space-3); padding: var(--tx-space-2); }
  .tx-table--stack td { border-bottom: none; padding: var(--tx-space-1) var(--tx-space-2); }
  .tx-table--stack td[data-label]::before {
    content: attr(data-label);
    display: block;
    font-size: var(--tx-size-100);
    text-transform: uppercase;
    letter-spacing: var(--tx-tracking-caps);
    color: var(--tx-text-muted);
  }
  /* step 19 D2 — la ficha por persona que step 18 §5.7 prometió y nunca se
     implementó. Dos columnas, no una: a 690px el contenido del diálogo mide
     ~626px, así que cada campo se queda en ~300px, de sobra para "Corte y
     barba" y "Nerea (sintética)". Tres filas de campos pasan a dos. */
  .tx-group-row {
    border: var(--tx-border-hairline);
    border-radius: var(--tx-radius-md);
    padding: var(--tx-space-3);
    margin-bottom: var(--tx-space-3);
  }
  .tx-group-row:last-child { border: var(--tx-border-hairline); }
  .tx-group-row__fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--tx-space-2);
  }
  .tx-dialog { padding: var(--tx-space-4); }

  /* step 19 D1 — por debajo de 720px las dos columnas dejan ~300px por
     nombre de evento: romper la palabra funcionaría, pero se leería partida
     en tres. Una sola columna le devuelve el ancho entero al identificador y
     lo parte pocas veces o ninguna. El alto sobra; el ancho no. */
  .tx-event-counts { grid-template-columns: 1fr; gap: var(--tx-space-4); }

  /* Para que ese overflow-x sirva de algo, la rejilla tiene que pedir más
     ancho del que hay: con width:100% se comprimiría hasta ser ilegible en vez
     de desplazarse. 640px deja ~91px por columna, suficiente para "09:00–17:30"
     al tamaño de letra de la celda. */
  .tx-month-grid { min-width: 640px; }

  /* D2 (revisión step 15): aquí se escondía .tx-month-grid y se mostraba en
     su lugar una lista de repuesto que NINGÚN código rellenaba nunca, así que
     por debajo de 720px la vista Calendario se quedaba literalmente sin
     calendario. La rejilla se queda puesta: su contenedor .tx-table-scroll ya
     tiene overflow-x:auto, que es exactamente para esto, y ver el mes de
     verdad desplazándolo a lo ancho es mejor que no ver nada. La lista muerta
     y su regla se han borrado. */
}
`;
