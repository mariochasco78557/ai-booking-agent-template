import type { TenantBrandLogo, TenantPublicView, TenantThemeId } from "./model.js";
import { escapeHtml, renderNavLinks, renderPublicSections } from "./ui.sections.js";

/**
 * EL COLOR DE LA BARRA DEL NAVEGADOR, EN UNA TABLA CERRADA.
 *
 * `theme-color` es el único color que un documento tiene que declarar por sí
 * mismo: lo lee el sistema operativo para pintar la barra del navegador y no
 * hay forma de expresarlo con una variable CSS. Vive aquí, indexado por
 * `TenantThemeId`, y no en la configuración del local, por dos razones: para
 * que ningún hex viaje en `tenants.ts` —el día que alguien conecte esa
 * configuración a otra fuente, no podrá inyectar un color— y para que el
 * compilador exija una entrada nueva el día que se añada un tema.
 *
 * ── ESTA TABLA NO ESTÁ SOLA, Y ESO ES UNA DEUDA CONOCIDA ─────────────────
 *
 * El acento de cada tema está escrito HOY EN TRES SITIOS, en tres lenguajes
 * distintos, y no hay nada que los ate:
 *
 *   1. aquí, `THEME_COLORS` → `<meta name="theme-color">`, la barra del
 *      navegador y la interfaz del sistema operativo;
 *   2. `BRAND_ICON_COLORS` en `server.ts` → el SVG de `GET /brand/:t/icon.svg`,
 *      el icono de la pestaña (y ahí se duplica también el color de tinta, que
 *      es `--txb-on-dark`: `#F6F2E9` en demo-salon, `#EEF1F7` en aralar);
 *   3. `--txb-accent-700` en los bloques de tema de `ui.css.ts` → la página.
 *
 * Ninguna de las tres puede leer a las otras, y no es por descuido: el
 * navegador resuelve `theme-color` ANTES de tener la hoja de estilos, y el SVG
 * del icono se sirve como un documento aparte que tampoco la carga. Un `var()`
 * no vale en ninguno de los dos sitios.
 *
 * La consecuencia hay que decirla en voz alta: retocar la paleta en `ui.css.ts`
 * y olvidar estos dos deja la barra del navegador o el icono de pestaña con el
 * color viejo, y NADA se pone rojo por sí solo. La coherencia entre las tres la
 * vigila una prueba estática, que es el único sitio donde este acoplamiento
 * puede comprobarse; si esa prueba desaparece, esta duplicación se vuelve
 * silenciosa otra vez.
 *
 * Lo que sí está cerrado: los tres registros van indexados por `TenantThemeId`,
 * así que un tema nuevo no compila hasta tener su entrada en cada uno. Lo que
 * el compilador no puede exigir es que los valores COINCIDAN.
 */
const THEME_COLORS: Readonly<Record<TenantThemeId, string>> = {
  "demo-salon": "#9A4A22",
  aralar: "#23478A",
};

/**
 * EL DISTINTIVO DEL LOCAL, y el único punto del documento con una rama.
 *
 * Es una rama sobre la FORMA del distintivo (`logo.kind`), no sobre QUÉ LOCAL
 * es: los dos brazos valen para cualquier local que declare esa forma, y
 * añadir un tercer local no toca esta función. La comprobación de exhaustividad
 * del final es la que garantiza que una forma nueva no pueda pintarse en
 * silencio como ninguna.
 */
function renderBrandLogo(tenantId: string, logo: TenantBrandLogo): string {
  if (logo.kind === "asset") {
    // La ruta lleva el local DENTRO: el activo de un local no es alcanzable
    // desde la página de otro (ver `GET /brand/:tenantId/logo.png`).
    return `<img src="/brand/${escapeHtml(tenantId)}/logo.png" alt="${escapeHtml(logo.alt)}" width="${String(
      logo.width,
    )}" height="${String(logo.height)}">`;
  }
  if (logo.kind === "wordmark") {
    return `<span class="txb-brand-mark" aria-hidden="true">${escapeHtml(logo.initials)}</span>
    <span class="txb-brand-wordmark">${escapeHtml(logo.text)}</span>`;
  }
  const exhaustivo: never = logo;
  throw new Error(`Distintivo de marca no contemplado: ${JSON.stringify(exhaustivo)}`);
}

/**
 * EL CAJÓN DE FECHA Y HORA — el paso 3 del asistente, TRASLADADO VERBATIM.
 *
 * POR QUÉ UN `<dialog>` Y NO UN PANEL CUALQUIERA. `showModal()` regala, sin una
 * línea de JavaScript de accesibilidad: trampa de foco, cierre con `Escape`,
 * `::backdrop` y el resto del documento inerte. Un panel no modal obligaría a
 * escribir a mano la trampa de foco y a ir poniendo y quitando `aria-hidden`
 * del resto de la página: más código y más superficie de error para conseguir
 * lo mismo peor.
 *
 * POR QUÉ EL PASO 3 Y NO LOS DEMÁS. Es el único que necesita anchura de verdad
 * —calendario del mes, tira de días y rejilla de jornada completa con dos
 * tramos— y no cabe junto al resumen sin comprimir los objetivos táctiles por
 * debajo de 44 px. Los pasos 1 y 2 son contenido de venta (las mismas fichas
 * que ya muestra la portada) y meterlos en un cajón los escondería.
 *
 * NADA SE RENOMBRA AQUÍ DENTRO. `txb-paso-fecha-hora`, `txb-calendario`,
 * `txb-mes-grid-body`, `txb-dia-chips`, `txb-vista-dia-completa`,
 * `txb-rejilla`, `txb-pago` y `txb-btn-confirmar` siguen existiendo con el
 * mismo nombre y los mismos atributos `aria`, así que `showPaso()` y
 * `enterDateStep()` del cliente funcionan sin tocar una línea. Lo único que
 * cambia es DÓNDE vive el nodo.
 *
 * `txb-seleccion-resumen`, `txb-pago-simulado-nota` y `txb-btn-confirmar` bajan
 * al pie fijo del cajón. Se pueden mover porque el cliente los muestra y los
 * oculta UNO A UNO con su propio `hidden`, no colgando de la sección del paso.
 *
 * ── LA TIRA DE DÍAS, CON UN NOMBRE QUE DE VERDAD SE ANUNCIA ──────────────
 *
 * `#txb-dia-chips` era `<div … aria-label="Días cercanos">` y tenía dos
 * defectos a la vez. Uno de contenido: desde que el cliente ancla la tira al
 * lunes ya no son «días cercanos», son los SIETE días de una semana, siempre
 * los mismos y siempre en la misma columna. Y otro peor, porque no se ve: un
 * `<div>` sin `role` mapea a un contenedor genérico, y un contenedor genérico
 * NO expone su `aria-label` en el árbol de accesibilidad. Ese rótulo no lo leía
 * nadie. Un nombre que no se anuncia es peor que ninguno: parece resuelto.
 *
 * Ahora es `role="group"` con `aria-label="Días de la semana"`. `group` es el
 * equivalente ARIA de `<fieldset>`/`<legend>` —una agrupación de controles
 * relacionados, con nombre propio— y sí expone su nombre. Se elige por descarte
 * razonado de las alternativas:
 *   · `<fieldset>` obligaría a un `<legend>` que habría que esconder, y a meter
 *     en un formulario algo que no lo es;
 *   · `<ul>`/`<li>` daría semántica de lista, pero el cliente cuelga los
 *     `<button>` DIRECTAMENTE de este nodo, así que la lista nacería con hijos
 *     inválidos —y `ui.js.ts` no es de este agente—;
 *   · `role="radiogroup"` sería lo ideal, porque elegir día es excluyente, pero
 *     exige hijos `role="radio"` con `aria-checked` y hoy son botones con
 *     `aria-pressed`: declararlo sería mentir sobre lo que hay dentro;
 *   · `role="toolbar"` promete recorrido con flechas y un solo punto de
 *     tabulación, que este componente no implementa.
 *
 * El nombre no dice QUÉ semana es: eso cambia, y aquí no se escribe ni una
 * fecha ni una hora, nunca. La semana concreta la cuentan el título del mes y
 * el texto de cada chip, que los pinta el cliente.
 *
 * ── LA CABECERA DEL CAJÓN LLEVA TRES PIEZAS Y CADA UNA TIENE SU SITIO ────
 *
 * `‹ Volver`, el aviso de demostración del local y la ✕ viven en la MISMA
 * barra, y las tres declaran su casilla con una clase propia
 * (`txb-drawer__back`, `txb-drawer__demo`, `txb-drawer__close`) en vez de
 * dejar que la hoja las coloque por el orden en que estén escritas o por la
 * clase con la que se pintan (`txb-linkbtn`, `txb-iconbtn`). Con casillas
 * nombradas, la hoja puede bajar el aviso a su propia fila donde no quepa —lo
 * hace por debajo de cierto ancho— SIN mover el marcado y sin que los dos
 * botones se descoloquen: siguen anclados a los extremos de su fila.
 *
 * EL AVISO NO SE VA DE AQUÍ. Es el mismo texto que la franja superior de la
 * página (`view.demoBanner`, propio del local y obligado por el validador a
 * contener la palabra «demostración»), y aparece a propósito en los dos
 * sitios: con el cajón abierto, la página de detrás queda inerte y atenuada,
 * así que sin esta línea el paso más largo del asistente sería el único que no
 * delata que nada de lo que se ve existe. Lo que se ha arreglado es cómo se
 * presenta —una sola línea, del tamaño de un rótulo, sin empujar a nadie—, no
 * si está.
 */
function renderDrawerFecha(view: TenantPublicView): string {
  return `<dialog class="txb-drawer" id="txb-drawer-fecha" aria-labelledby="txb-paso-fecha-hora-titulo">
  <div class="txb-drawer__bar">
    <button type="button" class="txb-linkbtn txb-drawer__back" id="txb-volver-profesional">‹ Volver</button>
    <p class="txb-drawer__demo" id="txb-drawer-aviso">${escapeHtml(view.demoBanner)}</p>
    <button type="button" class="txb-iconbtn txb-drawer__close" id="txb-drawer-cerrar" aria-label="Cerrar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 6 L18 18"/><path d="M18 6 L6 18"/></svg>
    </button>
  </div>

  <div class="txb-drawer__body">

    <section id="txb-paso-fecha-hora" class="txb-paso" aria-labelledby="txb-paso-fecha-hora-titulo" hidden>
      <h2 id="txb-paso-fecha-hora-titulo" tabindex="-1">Elige fecha y hora</h2>

      <div class="txb-calendar" id="txb-calendario">
        <div class="txb-calendar__head">
          <button type="button" class="txb-btn txb-btn--secondary" id="txb-mes-anterior">‹ Mes anterior</button>
          <span class="txb-calendar__title" id="txb-mes-titulo"></span>
          <button type="button" class="txb-btn txb-btn--secondary" id="txb-mes-siguiente">Mes siguiente ›</button>
        </div>
        <table class="txb-month-grid" id="txb-mes-grid">
          <caption class="txb-visually-hidden">Rejilla del mes visible del calendario</caption>
          <thead>
            <tr>
              <th scope="col"><abbr title="lunes">L</abbr></th>
              <th scope="col"><abbr title="martes">M</abbr></th>
              <th scope="col"><abbr title="miércoles">X</abbr></th>
              <th scope="col"><abbr title="jueves">J</abbr></th>
              <th scope="col"><abbr title="viernes">V</abbr></th>
              <th scope="col"><abbr title="sábado">S</abbr></th>
              <th scope="col"><abbr title="domingo">D</abbr></th>
            </tr>
          </thead>
          <tbody id="txb-mes-grid-body"></tbody>
        </table>
      </div>

      <div class="txb-chip-row" id="txb-dia-chips" role="group" aria-label="Días de la semana"></div>

      <label class="txb-switch">
        <input type="checkbox" id="txb-vista-dia-completa">
        Vista día completa
      </label>

      <h3 id="txb-horarios-titulo"></h3>
      <div id="txb-rejilla"></div>

      <p class="txb-legend">
        <span class="txb-legend__mark txb-legend__mark--ok">✓</span> Disponible
        <span class="txb-legend__mark txb-legend__mark--no">–</span> No disponible
      </p>

      <fieldset class="txb-payment" id="txb-pago" hidden>
        <legend>¿Cómo quieres pagar?</legend>
        <label class="txb-payment-option">
          <input type="radio" name="txb-payment-option" id="txb-pago-ahora" value="pay_now_demo">
          <span class="txb-payment-option__body">
            <span class="txb-payment-option__title">Pagar ahora · <span id="txb-pago-precio"></span> <span class="txb-badge txb-badge--optional">Opcional</span></span>
            <span class="txb-payment-option__note">Pendiente en peluquería: 0 €</span>
          </span>
        </label>
        <label class="txb-payment-option">
          <input type="radio" name="txb-payment-option" id="txb-pago-local" value="pay_at_salon">
          <span class="txb-payment-option__body">
            <span class="txb-payment-option__title">Pagar en la peluquería</span>
            <span class="txb-payment-option__note">Sin pago ahora</span>
          </span>
        </label>
      </fieldset>
    </section>

  </div>

  <div class="txb-drawer__foot">
    <p class="txb-status-line txb-status-line--ok" id="txb-seleccion-resumen" hidden></p>
    <p class="txb-summary-block__meta" id="txb-pago-simulado-nota" hidden>Pago simulado · No se realizarán cargos</p>
    <button type="button" class="txb-btn" id="txb-btn-confirmar" hidden disabled>Confirmar reserva</button>
  </div>
</dialog>`;
}

/**
 * ────────────────────────────────────────────────────────────────────────
 * LA WEB PÚBLICA DE LA PELUQUERÍA, Y EL ASISTENTE DENTRO DE ELLA.
 *
 * `GET /:tenantId` servía hasta hoy un formulario de cuatro pasos con una
 * marca encima. Ahora sirve una WEB: hero, servicios, equipo, cómo funciona,
 * reserva, información práctica y preguntas frecuentes, en ese orden, con el
 * asistente de siempre viviendo dentro de la sección de reserva. El recorrido
 * cuenta el local antes de pedirle nada a nadie.
 *
 * UNA PLANTILLA, DOS LOCALES, CERO CONDICIONALES. En este fichero no hay ni una
 * comparación de `tenantId`: la única rama es sobre la FORMA del distintivo de
 * marca (`renderBrandLogo`). Todo lo demás sale de `TenantPublicView`, que es
 * lo único que la plantilla ve —y que NO es asignable desde `TenantDefinition`:
 * desde aquí no se puede leer un precio en céntimos, un calendario ni el
 * almacén ni por accidente, porque no están en el tipo—.
 *
 * REGLAS DURAS (las vigilan `tests/bookingWeb/ui*.test.ts` y las nuevas):
 *   - EXACTAMENTE UN `<script>`, externo, vacío y propio:
 *     `<script src="/app.js" defer></script>` en el `<head>` (ver ui.js.ts).
 *     Nada de código en línea y ningún origen ajeno, así que
 *     `script-src 'self'` basta sin `'unsafe-inline'` ni `'unsafe-eval'`.
 *     Va en el `<head>` y no al final del `<body>` porque `defer` ya garantiza
 *     lo que se busca —descarga en paralelo al análisis del documento y
 *     ejecución cuando el árbol está COMPLETO, justo antes de
 *     `DOMContentLoaded`— y, estando arriba, la descarga arranca antes.
 *     Esta línea es el único eslabón entre el documento y su comportamiento:
 *     sin ella la página se pinta entera y queda INERTE (defecto real de
 *     2026-08-26). La prueba viva `tests/bookingWeb/paginaViva.test.ts` analiza
 *     este HTML, saca de él el `src` y ejecuta ese JavaScript, así que borrarla
 *     vuelve a poner la suite en rojo.
 *   - NADA de `<style>` ni de `style="…"`: la hoja de estilos vive en su propia
 *     ruta (`/app.css`, ver ui.css.ts). Los SVG que hay son marcado en línea,
 *     no script, y la CSP no los toca.
 *   - NINGÚN campo de tarjeta, cuenta bancaria, teléfono o correo. El paso de
 *     pago son dos radios que mandan `pay_now_demo`/`pay_at_salon`, el
 *     vocabulario cerrado del contrato — nunca un dato financiero. Los únicos
 *     `<input>` del documento son de tipo `radio` y `checkbox`.
 *   - NINGUNA URL absoluta ni ningún esquema: todo `href` y todo `src` empieza
 *     por `#` o por `/`. La página no puede pedirle nada a nadie de fuera.
 *   - EL AVISO CONTRACTUAL (`view.notice`) aparece EXACTAMENTE UNA VEZ, en el
 *     `<footer>`. La franja superior y la cabecera del cajón muestran un texto
 *     DISTINTO y propio del local (`view.demoBanner`), que el validador obliga
 *     a contener la palabra «demostración»: así el aviso está en tres sitios
 *     sin que el literal del contrato se pueda contar dos veces.
 *
 * LAS DOS VISTAS DE LA DEMOSTRACIÓN. `#txb-vista-reserva` pasa a envolver TODA
 * la web pública, y `#txb-vista-dashboard` sigue siendo su hermano. Así
 * `switchView()` del cliente funciona SIN CAMBIOS: abrir el panel oculta la web
 * entera y volver la restaura. Los dos botones que conmutan se han bajado al
 * pie, discretos: una pestaña «Panel de reservas» al lado de la marca era lo
 * que más gritaba «herramienta interna» en el escaparate. Conservan sus
 * identificadores y su `aria-pressed`, y han perdido `role="tablist"` y
 * `role="tab"`, que eran inválidos ahí: un `tab` exige `aria-selected` y un
 * `tabpanel`, no `aria-pressed`.
 *
 * LA CABECERA NO LLEVA LEMA. `brand.tagline` («Elige servicio, profesional y
 * hora…») estuvo un rato al lado del distintivo y era copy de asistente de
 * reserva colocado en el escaparate: competía con el titular editorial del
 * héroe, que dice lo mismo mejor y con más aire, y le quitaba respiración a la
 * barra. La cabecera es distintivo + navegación + CTA, y nada más. El lema baja
 * al `<footer>`, que es donde una firma de marca no compite con nada, y sigue
 * pintándose con la misma clase (`txb-subtitle`) para que la hoja de estilos
 * sólo tenga que reencuadrarlo, no reescribirlo. No se deja de pintar: un campo
 * del contrato que no aparece en ninguna parte del documento es un campo que
 * nadie sabrá que está roto el día que alguien lo cambie.
 *
 * `tenantId` se incrusta en `<body data-tenant-id="…">`: es el ÚNICO sitio del
 * documento que lo menciona en texto, y de ahí lo lee `ui.js.ts` para componer
 * cada llamada a `/api/:tenantId/…`. La paleta viaja en `<body data-theme="…">`
 * y selecciona el bloque de variables `--txb-*` de ese tema, que es como se
 * cambia de identidad sin un solo `style="…"`.
 * ────────────────────────────────────────────────────────────────────────
 */
export function renderBookingHtml(view: TenantPublicView): string {
  const { tenantId, brand } = view;
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${escapeHtml(view.seo.description)}">
<meta name="theme-color" content="${THEME_COLORS[brand.theme]}">
<title>${escapeHtml(brand.title)}</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="/brand/${escapeHtml(tenantId)}/icon.svg" type="image/svg+xml">
<script src="/app.js" defer></script>
</head>
<body data-tenant-id="${escapeHtml(tenantId)}" data-theme="${escapeHtml(brand.theme)}">

<a class="txb-skip" href="#txb-main" id="txb-skip">Saltar al contenido</a>

<p class="txb-demobar" id="txb-demobar">${escapeHtml(view.demoBanner)}</p>

<header class="txb-topbar" id="txb-topbar">
  <div class="txb-wrap">
    <div class="txb-brand">
      ${renderBrandLogo(tenantId, brand.logo)}
    </div>

    <nav class="txb-nav" id="txb-nav" aria-label="Principal">
      <ul class="txb-nav__list">
${renderNavLinks(view, "        ")}
      </ul>
      <a class="txb-btn" id="txb-cta-nav" href="#txb-seccion-reserva">${escapeHtml(view.nav.ctaLabel)}</a>
      <button type="button" class="txb-nav__toggle" id="txb-nav-toggle" aria-expanded="false" aria-controls="txb-nav-menu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7 L20 7"/><path d="M4 12 L20 12"/><path d="M4 17 L20 17"/></svg>
        <span class="txb-visually-hidden">Menú</span>
      </button>
      <div class="txb-nav__menu" id="txb-nav-menu" hidden>
        <ul class="txb-nav__list">
${renderNavLinks(view, "          ")}
        </ul>
      </div>
    </nav>
  </div>
</header>

<main class="txb-main" id="txb-main" tabindex="-1">

<p class="txb-status-line txb-status-line--error" id="txb-error" role="alert" hidden></p>
<p class="txb-visually-hidden" id="txb-anuncio" role="status" aria-live="polite"></p>

<div id="txb-vista-reserva">

${renderPublicSections(view)}

<a class="txb-btn txb-cta-movil" id="txb-cta-movil" href="#txb-seccion-reserva">${escapeHtml(
    view.nav.ctaLabel,
  )}</a>

</div>

<section id="txb-vista-dashboard" hidden aria-labelledby="txb-dashboard-titulo">
  <div class="txb-wrap">
    <div class="txb-dashboard-head">
      <h2 id="txb-dashboard-titulo" tabindex="-1">Panel de reservas</h2>
      <button type="button" class="txb-btn txb-btn--danger" id="txb-btn-abrir-reset">Reiniciar demostración</button>
    </div>

    <div class="txb-table-scroll" tabindex="0" role="region" aria-label="Reservas del local">
      <table class="txb-table">
        <caption class="txb-visually-hidden">Reservas de esta demostración</caption>
        <thead>
          <tr>
            <th scope="col">Servicio</th>
            <th scope="col">Profesional</th>
            <th scope="col">Fecha y hora</th>
            <th scope="col">Precio total</th>
            <th scope="col">Estado</th>
            <th scope="col">Pagado</th>
            <th scope="col">Pendiente</th>
          </tr>
        </thead>
        <tbody id="txb-dashboard-tbody"></tbody>
      </table>
    </div>
    <div id="txb-dashboard-vacio" hidden>
      <p>Todavía no hay ninguna reserva en esta demostración.</p>
    </div>

    <dl class="txb-totals" id="txb-dashboard-totales"></dl>
  </div>
</section>

</main>

${renderDrawerFecha(view)}

<dialog class="txb-dialog" id="txb-dialog-reset" aria-labelledby="txb-dialog-reset-titulo">
  <h2 id="txb-dialog-reset-titulo">Reiniciar la demostración</h2>
  <p>Se borrarán todas las reservas, pagos y claves de este local. Esta acción no se puede deshacer.</p>
  <p class="txb-status-line" id="txb-dialog-reset-estado" role="status" aria-live="polite" hidden></p>
  <div class="txb-dialog__actions">
    <button type="button" class="txb-btn txb-btn--secondary" id="txb-dialog-reset-cancelar">Cancelar</button>
    <button type="button" class="txb-btn txb-btn--danger" id="txb-dialog-reset-confirmar">Reiniciar</button>
  </div>
</dialog>

<footer class="txb-footer txb-on-dark" id="txb-footer">
  <div class="txb-wrap">
    <div class="txb-footer__col">
      <p>${escapeHtml(view.footerTagline)}</p>
      <p class="txb-subtitle">${escapeHtml(brand.tagline)}</p>
      <p class="txb-measure">${escapeHtml(view.syntheticDisclosure)}</p>
    </div>
    <div class="txb-footer__meta">
      <p>${escapeHtml(view.notice)}</p>
      <div class="txb-tabs" role="group" aria-label="Vista de la demostración">
        <button type="button" class="txb-tab" id="txb-tab-reserva" aria-pressed="true">Web pública</button>
        <button type="button" class="txb-tab" id="txb-tab-dashboard" aria-pressed="false">Panel de reservas</button>
      </div>
    </div>
  </div>
</footer>

</body>
</html>
`;
}
