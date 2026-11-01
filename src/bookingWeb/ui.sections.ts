import {
  OPENING_CLOSED_LABEL,
  PUBLIC_SECTION_DOM_IDS,
  PUBLIC_SECTION_ORDER,
  isSectionEnabled,
} from "./model.js";
import type { HeroEmblemId, PublicSectionId, TenantPublicView } from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LAS SIETE SECCIONES DE LA WEB PÚBLICA.
 *
 * NO HAY NI UNA COMPARACIÓN DE `tenantId` EN TODO ESTE FICHERO, y no puede
 * haberla: cada función recibe `TenantPublicView` —la vista ya derivada del
 * local— y compone con lo que ahí venga. Dos locales, una sola plantilla.
 *
 * LA TABLA DE DESPACHO ES EXHAUSTIVA A PROPÓSITO. `PUBLIC_SECTION_RENDERERS`
 * está tipada como `Readonly<Record<PublicSectionId, PublicSectionRenderer>>`,
 * así que el día que alguien añada un identificador de sección al modelo y no
 * escriba su función, el compilador se planta. No hay ningún `default`, ningún
 * `?? ""` y ninguna sección que pueda dejar de pintarse en silencio.
 *
 * QUÉ NO SE ESCRIBE AQUÍ, JAMÁS:
 *   - ni un precio, ni una duración, ni una hora de reloj. `priceLabel` y
 *     `durationLabel` llegan YA FORMATEADOS en la vista y se vuelcan tal cual;
 *     el horario se pinta recorriendo `view.week` y sus `rangeLabel`. Un día
 *     sin tramos se rotula con `OPENING_CLOSED_LABEL`, que también vive en el
 *     modelo. Componer aquí un «09:00» sería crear una segunda verdad que el
 *     calendario podría desmentir en la misma pantalla.
 *   - ni un nombre de persona, ni una etiqueta de servicio: salen de
 *     `view.professionals` y `view.services`, derivados del catálogo y de los
 *     fixtures.
 *   - ni una marca. Este fichero no menciona a ningún local por su nombre.
 *   - ni el RÓTULO de una sección. Los seis `<h2>` salen de
 *     `view.sectionHeadings`, que es configuración del local, y el emblema del
 *     hero sale de `view.heroEmblem`. Cuando los dos eran constantes de módulo,
 *     los dos locales abrían con el mismo dibujo y rotulaban sus secciones con
 *     las mismas seis palabras: el segundo era el primero repintado, y encima
 *     su menú y sus titulares se contradecían entre sí.
 *
 * LOS CTA REPETIDOS NO LLEVAN `id` —habría uno por servicio y por persona, y
 * serían ids compuestos por concatenación—: van por clase (`txb-cta-servicio`,
 * `txb-cta-profesional`) y un ÚNICO atributo de datos, el que identifica a qué
 * apunta el botón: `data-service-id` o `data-employee-id`.
 *
 * Y NADA MÁS QUE ESO. Aquí se emitía además `data-service-ids="0 1 2"` en cada
 * ficha de equipo, «para que el cliente deshabilite los CTA incompatibles».
 * Era falso: `refreshProfessionalCtas` resuelve por `data-employee-id` contra
 * `bootstrap.employees[].serviceIds` —la matriz única— y nunca leyó ese
 * atributo; el propio `ui.js.ts` lo dice dos veces en sus comentarios. Con lo
 * cual el marcado publicaba una SEGUNDA COPIA de la matriz de capacidades, sin
 * consumidor, y dos ficheros del mismo módulo afirmaban cosas incompatibles.
 * No podía desmentir a la matriz —salía de ella—, pero sí invitaba al primero
 * que pasara a leerla desde el DOM y crear la segunda verdad de verdad.
 * Borrado. Lo que una persona necesita saber —qué hace cada quien— sigue
 * escrito en `servicesLabel`, que es texto y se lee.
 *
 * TODOS LOS ATRIBUTOS VAN ENTRE COMILLAS DOBLES, sin excepción, y todo valor
 * que venga de configuración pasa por `escapeHtml`.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Escapa el texto que se compone dentro del documento.
 *
 * Vive aquí, y no en `ui.html.ts`, para que la dependencia entre los dos
 * módulos vaya en UNA sola dirección (`ui.html.ts` → `ui.sections.ts`) y no
 * haya un ciclo de importación entre la plantilla y sus secciones.
 *
 * Escapa también la COMILLA SIMPLE. Antes no lo hacía y la costumbre de
 * entrecomillar siempre con `"` era lo único que sostenía la promesa: un valor
 * de configuración con un `'` dentro no rompía nada mientras nadie escribiera
 * un atributo con comilla simple. Ahora la promesa no depende de la costumbre.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Lo único que una sección necesita para componerse: la vista del local. */
export type PublicSectionRenderer = (view: TenantPublicView) => string;

/**
 * El encabezado que rotula cada sección, escrito ENTERO y por sección.
 *
 * `hero` apunta al `<h1>` de la página (`txb-titulo`), que ya existe y cuyo
 * texto lo pone el local; las demás apuntan a su propio `<h2>`. Ninguno se
 * compone concatenando el identificador de la sección con un sufijo.
 */
const SECTION_TITLE_DOM_IDS: Readonly<Record<PublicSectionId, string>> = {
  hero: "txb-titulo",
  servicios: "txb-seccion-servicios-titulo",
  profesionales: "txb-seccion-profesionales-titulo",
  experiencia: "txb-seccion-experiencia-titulo",
  reserva: "txb-seccion-reserva-titulo",
  info: "txb-seccion-info-titulo",
  faq: "txb-seccion-faq-titulo",
};

/**
 * AQUÍ VIVÍA `SECTION_HEADINGS`, Y SE HA BORRADO A PROPÓSITO.
 *
 * Era un `Record` de seis constantes COMPARTIDAS por todos los locales —
 * «Servicios», «El equipo», «Cómo funciona»…— y su coste no era estético. El
 * menú de un local podía decir «Qué hacemos» mientras el `<h2>` de esa misma
 * sección, dos pantallazos más abajo, decía «Servicios»: dos nombres para la
 * misma cosa en el mismo documento, y ningún sitio donde eso se desmintiera.
 * Peor todavía, seis de los rótulos más visibles de la página eran idénticos en
 * los dos locales, así que el segundo se leía como el primero repintado por
 * mucha voz propia que tuvieran el titular y las biografías.
 *
 * Ahora el rótulo lo declara CADA LOCAL (`TenantPublicContent.sectionHeadings`)
 * y el validador lo ata a la etiqueta del menú que apunta a esa sección: menú y
 * titular son el MISMO texto o el local no arranca.
 */

/** Un ancla interna a una sección. El identificador se escribe entero. */
function anchor(section: PublicSectionId): string {
  return `#${PUBLIC_SECTION_DOM_IDS[section]}`;
}

/**
 * LOS EMBLEMAS DEL HERO: SVG EN LÍNEA, decorativos y sin una sola petición de
 * red. La CSP del servidor (`default-src 'none'`) no admite ninguna imagen de
 * otro origen, y aquí no hace falta ninguna: son trazos que heredan el color
 * del tema con `currentColor`. No hay `<script>`, no hay `style=` en línea, no
 * hay `url()` y no hay ningún `fill` de color: sólo `fill="none"`.
 *
 * LA TABLA ES EXHAUSTIVA POR TIPO, igual que la de despacho de secciones: un
 * identificador nuevo en `HeroEmblemId` sin su dibujo no compila. Y sigue sin
 * haber ni una comparación de local — el emblema llega en la vista, ya elegido
 * por la configuración, y este fichero no sabe de quién es cuál.
 *
 * Los dos dibujos son DISTINTOS DE RAÍZ, no dos variantes del mismo: uno es el
 * oficio (dos hojas cruzadas dentro de un anillo), el otro es una retícula de
 * rombos con sus marcas de registro, sin un solo tópico de barbería. Que
 * compartieran trazo sería volver a tener un emblema con dos nombres.
 */
const HERO_EMBLEMS: Readonly<Record<HeroEmblemId, string>> = {
  "tijeras-cruzadas": `<svg class="txb-hero__emblem" viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
<circle cx="100" cy="100" r="88"/>
<circle cx="100" cy="100" r="74"/>
<path d="M66 56 L134 138"/>
<path d="M134 56 L66 138"/>
<circle cx="58" cy="150" r="12"/>
<circle cx="142" cy="150" r="12"/>
<circle cx="100" cy="97" r="4"/>
<path d="M40 100 h20"/>
<path d="M140 100 h20"/>
</svg>`,
  "rombos-concentricos": `<svg class="txb-hero__emblem" viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
<rect x="24" y="24" width="152" height="152" rx="12"/>
<path d="M100 24 L176 100 L100 176 L24 100 Z"/>
<path d="M100 62 L138 100 L100 138 L62 100 Z"/>
<circle cx="100" cy="100" r="9"/>
<path d="M100 6 v18"/>
<path d="M100 176 v18"/>
<path d="M6 100 h18"/>
<path d="M176 100 h18"/>
</svg>`,
};

/**
 * El dibujo de este local. La tabla es exhaustiva por tipo, así que con un
 * `HeroEmblemId` de verdad esta función siempre devuelve un SVG.
 *
 * El `?? ""` es el TIRANTE DEL CINTURÓN, en la misma postura que
 * `buildTenantPublicView` con sus fichas: protege a quien fabrique una vista
 * saltándose el tipo —una prueba que reescribe el copy de un local en bloque,
 * por ejemplo— de que la página imprima la palabra «undefined» en el hueco más
 * visible del documento. El emblema es decorativo (`aria-hidden`), así que no
 * pintarlo no le quita información a nadie; pintar basura, sí.
 */
function heroEmblemSvg(id: HeroEmblemId): string {
  return HERO_EMBLEMS[id] ?? "";
}

// ---------------------------------------------------------------------
// 1 · HERO
// ---------------------------------------------------------------------

/**
 * El `<h1>` del documento, y el único. Conserva `id="txb-titulo"` y
 * `tabindex="-1"`: los dos ya existían y el segundo es lo que permite llevarle
 * el foco sin convertirlo en un elemento tabulable.
 *
 * La sección se rotula CON ESE `<h1>` (`aria-labelledby="txb-titulo"`) en vez
 * de con un `<h2>` propio: un elemento no puede llevar dos identificadores, el
 * `<h1>` ya dice de qué va esta sección, y añadir un segundo encabezado
 * repetiría el mismo texto en el árbol de accesibilidad.
 *
 * El CTA secundario sólo se emite si la sección a la que apunta existe: un
 * enlace a un ancla apagada sería un enlace roto, y esta página no tiene
 * ninguno.
 */
function renderHero(view: TenantPublicView): string {
  const { hero } = view;
  const secundario = isSectionEnabled(view.enabledSections, "servicios")
    ? `\n        <a class="txb-btn txb-btn--secondary" id="txb-cta-hero-secundario" href="${anchor(
        "servicios",
      )}">${escapeHtml(hero.secondaryCtaLabel)}</a>`
    : "";
  const marcas = hero.highlights
    .map((frase) => `        <li class="txb-hero__mark">${escapeHtml(frase)}</li>`)
    .join("\n");
  return `<section class="txb-section txb-hero" id="${PUBLIC_SECTION_DOM_IDS.hero}" aria-labelledby="${
    SECTION_TITLE_DOM_IDS.hero
  }">
  <div class="txb-wrap">
    <div class="txb-hero__body">
      <p class="txb-eyebrow">${escapeHtml(hero.eyebrow)}</p>
      <h1 id="txb-titulo" tabindex="-1">${escapeHtml(hero.headline)}</h1>
      <p class="txb-lead txb-measure">${escapeHtml(hero.subheadline)}</p>
      <div class="txb-hero__actions">
        <a class="txb-btn" id="txb-cta-hero-primario" href="${anchor("reserva")}">${escapeHtml(
          hero.primaryCtaLabel,
        )}</a>${secundario}
      </div>
      <ul class="txb-hero__marks">
${marcas}
      </ul>
    </div>
    <div class="txb-hero__aside">
      ${heroEmblemSvg(view.heroEmblem)}
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------
// 2 · SERVICIOS
// ---------------------------------------------------------------------

/**
 * Una ficha por servicio del catálogo DE ESTE LOCAL.
 *
 * `durationLabel` y `priceLabel` se vuelcan TAL CUAL: llegan ya formateados
 * desde `buildTenantPublicView`, que es el único sitio que sabe dividir
 * céntimos entre cien y convertir minutos en «1 h 30 min». Aquí no se
 * recompone ninguno de los dos, ni se les añade un símbolo, ni se parten.
 *
 * El CTA lleva un sufijo oculto con el nombre del servicio para que los
 * botones no compartan todos el mismo nombre accesible: quien navega con
 * lector de pantalla oye «Reservar cita · Corte de pelo», no la misma frase
 * tres veces seguidas.
 */
function renderServicios(view: TenantPublicView): string {
  const fichas = view.services
    .map((servicio) => {
      const destacado = servicio.featured ? " txb-tile--featured" : "";
      return `        <article class="txb-tile${destacado}">
          <p class="txb-tile__cat">${escapeHtml(servicio.category)}</p>
          <h3 class="txb-tile__name">${escapeHtml(servicio.label)}</h3>
          <p class="txb-tile__desc txb-measure">${escapeHtml(servicio.description)}</p>
          <p class="txb-tile__meta">${escapeHtml(servicio.durationLabel)}</p>
          <p class="txb-tile__price">${escapeHtml(servicio.priceLabel)}</p>
          <button type="button" class="txb-btn txb-cta-servicio" data-service-id="${String(
            servicio.serviceId,
          )}">${escapeHtml(view.nav.ctaLabel)}<span class="txb-visually-hidden"> · ${escapeHtml(
            servicio.label,
          )}</span></button>
        </article>`;
    })
    .join("\n");
  return `<section class="txb-section txb-section--alt" id="${
    PUBLIC_SECTION_DOM_IDS.servicios
  }" aria-labelledby="${SECTION_TITLE_DOM_IDS.servicios}">
  <div class="txb-wrap">
    <div class="txb-section__head">
      <h2 id="${SECTION_TITLE_DOM_IDS.servicios}">${escapeHtml(view.sectionHeadings.servicios)}</h2>
    </div>
    <div class="txb-tile-grid">
${fichas}
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------
// 3 · PROFESIONALES
// ---------------------------------------------------------------------

/**
 * Una ficha por persona del local. Cero fotografías: el medallón es el
 * monograma (`initials`), y va `aria-hidden` porque el nombre completo está
 * justo debajo y leerlo dos veces sería ruido.
 *
 * `servicesLabel` es lo que ESTA PERSONA hace, derivado de
 * `DemoEmployee.serviceIds`, y es texto porque su destinatario es quien lee la
 * página. El cliente no lo necesita: para deshabilitar el CTA de quien no hace
 * el servicio ya elegido le basta con `data-employee-id` y con la matriz que
 * ya tiene en `bootstrap.employees[].serviceIds`. Por eso el botón lleva ese
 * atributo y ninguno más: la capacidad se consulta en la matriz única, no se
 * republica en el marcado.
 */
function renderProfesionales(view: TenantPublicView): string {
  const fichas = view.professionals
    .map((persona) => {
      const especialidades =
        persona.specialties.length === 0
          ? ""
          : `\n          <ul class="txb-ficha__esp">${persona.specialties
              .map((esp) => `<li>${escapeHtml(esp)}</li>`)
              .join("")}</ul>`;
      return `        <article class="txb-ficha">
          <p class="txb-ficha__medallon" aria-hidden="true">${escapeHtml(persona.initials)}</p>
          <h3 class="txb-ficha__nombre">${escapeHtml(persona.displayName)}</h3>
          <p class="txb-ficha__rol">${escapeHtml(persona.role)}</p>
          <p class="txb-ficha__bio txb-measure">${escapeHtml(persona.bio)}</p>${especialidades}
          <p class="txb-ficha__servicios">${escapeHtml(persona.servicesLabel)}</p>
          <button type="button" class="txb-btn txb-btn--secondary txb-cta-profesional" data-employee-id="${String(
            persona.employeeId,
          )}">${escapeHtml(view.nav.ctaLabel)}<span class="txb-visually-hidden"> · ${escapeHtml(
            persona.displayName,
          )}</span></button>
        </article>`;
    })
    .join("\n");
  return `<section class="txb-section" id="${PUBLIC_SECTION_DOM_IDS.profesionales}" aria-labelledby="${
    SECTION_TITLE_DOM_IDS.profesionales
  }">
  <div class="txb-wrap">
    <div class="txb-section__head">
      <h2 id="${SECTION_TITLE_DOM_IDS.profesionales}">${escapeHtml(
        view.sectionHeadings.profesionales,
      )}</h2>
    </div>
    <div class="txb-ficha-grid">
${fichas}
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------
// 4 · EXPERIENCIA (banda oscura)
// ---------------------------------------------------------------------

/**
 * La única banda oscura del cuerpo. Lleva `txb-on-dark` además de
 * `txb-section--dark` porque esa clase es la que invierte el anillo de foco y
 * los colores de texto: sobre `--txb-ink-950` ni `--txb-ink-500` ni
 * `--txb-accent-700` llegan al contraste exigido.
 *
 * El número de cada paso lo pone la POSICIÓN en la lista, no el contenido: es
 * decorativo (`aria-hidden`) porque el `<ol>` ya numera para quien no ve.
 */
function renderExperiencia(view: TenantPublicView): string {
  const pasos = view.experience
    .map((paso, indice) => {
      const numero = String(indice + 1).padStart(2, "0");
      return `        <li>
          <p class="txb-paso-num" aria-hidden="true">${numero}</p>
          <h3 class="txb-paso-titulo">${escapeHtml(paso.title)}</h3>
          <p class="txb-paso-desc txb-measure">${escapeHtml(paso.description)}</p>
        </li>`;
    })
    .join("\n");
  return `<section class="txb-section txb-section--dark txb-on-dark" id="${
    PUBLIC_SECTION_DOM_IDS.experiencia
  }" aria-labelledby="${SECTION_TITLE_DOM_IDS.experiencia}">
  <div class="txb-wrap">
    <div class="txb-section__head">
      <h2 id="${SECTION_TITLE_DOM_IDS.experiencia}">${escapeHtml(
        view.sectionHeadings.experiencia,
      )}</h2>
    </div>
    <ol class="txb-pasos">
${pasos}
    </ol>
  </div>
</section>`;
}

// ---------------------------------------------------------------------
// 5 · RESERVA (el asistente, trasladado sin renombrar nada)
// ---------------------------------------------------------------------

/**
 * EL ASISTENTE, MOVIDO VERBATIM Y DENTRO DE UNA SECCIÓN DE LA PÁGINA.
 *
 * Aquí viven los pasos 1 (servicio), 2 (profesional) y 4 (confirmación), el
 * indicador de pasos y el resumen lateral. El paso 3 —fecha, hora y pago— se
 * ha trasladado íntegro al `<dialog id="txb-drawer-fecha">` de `ui.html.ts`,
 * también verbatim: ni un identificador cambia de nombre, ni un atributo
 * `aria` cambia de valor, así que `showPaso()`, `goToStep()` y `focusHeading()`
 * del cliente siguen encontrando exactamente lo que buscaban.
 *
 * LO ÚNICO QUE SE HA TOCADO son los NIVELES de encabezado: los `<h2>` del
 * asistente pasan a `<h3>` porque ahora cuelgan del `<h2>` de esta sección.
 * Ni los identificadores ni los `aria-labelledby` que los apuntan cambian:
 * `aria-labelledby` no mira el nivel del encabezado, sólo su identificador.
 *
 * DE LA VISTA SÓLO LEE SU RÓTULO, y nada más. El asistente no pinta ni un dato
 * del local en el servidor: sus rejillas nacen vacías y las puebla el cliente
 * con lo que le devuelva `/api/:tenantId/bootstrap`, exactamente igual que
 * antes de esta reforma. Lo único que ha cambiado es que el `<h2>` que rotula
 * la sección ya no es una constante compartida por todos los locales, así que
 * hace falta la vista para leerlo — como en las otras cinco secciones.
 */
function renderReserva(view: TenantPublicView): string {
  return `<section class="txb-section txb-section--alt" id="${
    PUBLIC_SECTION_DOM_IDS.reserva
  }" aria-labelledby="${SECTION_TITLE_DOM_IDS.reserva}">
  <div class="txb-wrap">
    <div class="txb-section__head">
      <h2 id="${SECTION_TITLE_DOM_IDS.reserva}">${escapeHtml(view.sectionHeadings.reserva)}</h2>
    </div>

    <ol class="txb-steps" id="txb-steps" aria-label="Pasos de la reserva">
      <li data-step="1"><span class="txb-step__num">1</span><span class="txb-step__label">Servicio</span></li>
      <li data-step="2"><span class="txb-step__num">2</span><span class="txb-step__label">Profesional</span></li>
      <li data-step="3"><span class="txb-step__num">3</span><span class="txb-step__label">Fecha y hora</span></li>
      <li data-step="4"><span class="txb-step__num">4</span><span class="txb-step__label">Confirmación</span></li>
    </ol>

    <div class="txb-layout">

      <aside class="txb-summary" aria-label="Resumen de tu reserva">
        <div class="txb-summary-block" id="txb-resumen-servicio" hidden>
          <h3>Servicio seleccionado</h3>
          <p class="txb-summary-block__name" id="txb-resumen-servicio-nombre"></p>
          <p class="txb-summary-block__meta" id="txb-resumen-servicio-meta"></p>
          <span class="txb-badge">Seleccionado</span>
        </div>

        <div class="txb-summary-block" id="txb-resumen-profesional" hidden>
          <h3>Profesional seleccionado</h3>
          <p class="txb-summary-block__name" id="txb-resumen-profesional-nombre"></p>
          <span class="txb-badge">Seleccionado</span>
        </div>

        <div id="txb-resumen-fecha-bloque" hidden>
          <h3 class="txb-visually-hidden">Fecha</h3>
          <div class="txb-chip-row" id="txb-resumen-fecha-chips"></div>
        </div>

        <p class="txb-summary-block__meta" id="txb-resumen-hora" hidden></p>

        <button type="button" class="txb-btn" id="txb-btn-continuar" disabled>Continuar</button>
      </aside>

      <div class="txb-content">

        <section id="txb-paso-servicio" class="txb-paso" aria-labelledby="txb-paso-servicio-titulo">
          <h3 id="txb-paso-servicio-titulo" tabindex="-1">Elige un servicio</h3>
          <div class="txb-tile-grid" id="txb-servicios-grid"></div>
        </section>

        <section id="txb-paso-profesional" class="txb-paso" aria-labelledby="txb-paso-profesional-titulo" hidden>
          <button type="button" class="txb-btn txb-btn--secondary" id="txb-volver-servicio">‹ Volver</button>
          <h3 id="txb-paso-profesional-titulo" tabindex="-1">Elige profesional</h3>
          <p class="txb-summary-block__meta" id="txb-profesional-nota" hidden>Esta persona no realiza el servicio elegido.</p>
          <div class="txb-tile-grid" id="txb-profesionales-grid"></div>
        </section>

        <section id="txb-paso-confirmacion" class="txb-paso txb-confirm" aria-labelledby="txb-paso-confirmacion-titulo" hidden>
          <h3 id="txb-paso-confirmacion-titulo" tabindex="-1">Reserva confirmada</h3>
          <div class="txb-confirm__messages" id="txb-confirm-mensajes"></div>
          <table class="txb-confirm-table">
            <tbody id="txb-confirm-detalle"></tbody>
          </table>
          <div class="txb-btn-row">
            <button type="button" class="txb-btn txb-btn--secondary" id="txb-btn-nueva-reserva">Hacer otra reserva</button>
            <button type="button" class="txb-btn" id="txb-btn-ver-panel">Ver panel de reservas</button>
          </div>
        </section>

      </div>
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------
// 6 · INFORMACIÓN PRÁCTICA (con el horario DERIVADO del calendario)
// ---------------------------------------------------------------------

/**
 * EL HORARIO NO SE ESCRIBE: SE DERIVA.
 *
 * Cada fila sale de un día de `view.week` —el que produce `buildTenantPublicView`
 * a partir del calendario real del local— y cada tramo se rotula con su
 * `rangeLabel`, que lo compone el mismo código que rotula los bloques de la
 * rejilla de huecos. Un día sin tramos se rotula con `OPENING_CLOSED_LABEL`.
 *
 * Consecuencia buscada: si mañana el local abre media hora más, la portada lo
 * dice sola. No hay ninguna hora escrita a mano en esta plantilla, y por eso
 * no puede haber una portada que contradiga al calendario.
 */
function renderInfo(view: TenantPublicView): string {
  const datos =
    view.practicalInfo.items.length === 0
      ? ""
      : `      <div class="txb-info-panel">
        <dl>
${view.practicalInfo.items
  .map(
    (item) => `          <div class="txb-info-item">
            <dt>${escapeHtml(item.label)}</dt>
            <dd>${escapeHtml(item.value)}</dd>
          </div>`,
  )
  .join("\n")}
        </dl>${
          view.practicalInfo.note === ""
            ? ""
            : `\n        <p class="txb-measure">${escapeHtml(view.practicalInfo.note)}</p>`
        }
      </div>
`;
  const semana = view.week
    .map((dia) => {
      const cerrado = dia.windows.length === 0;
      const tramos = cerrado
        ? escapeHtml(OPENING_CLOSED_LABEL)
        : dia.windows.map((tramo) => escapeHtml(tramo.rangeLabel)).join(" · ");
      return `          <div class="txb-horario__fila${cerrado ? " txb-horario--cerrado" : ""}">
            <dt class="txb-horario__dia">${escapeHtml(dia.weekdayLabel)}</dt>
            <dd class="txb-horario__tramos">${tramos}</dd>
          </div>`;
    })
    .join("\n");
  return `<section class="txb-section" id="${PUBLIC_SECTION_DOM_IDS.info}" aria-labelledby="${
    SECTION_TITLE_DOM_IDS.info
  }">
  <div class="txb-wrap">
    <div class="txb-section__head">
      <h2 id="${SECTION_TITLE_DOM_IDS.info}">${escapeHtml(view.sectionHeadings.info)}</h2>
    </div>
    <div class="txb-info-grid">
${datos}      <div class="txb-info-panel">
        <h3>Horario</h3>
        <dl class="txb-horario" id="txb-horario-semana">
${semana}
        </dl>
      </div>
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------
// 7 · PREGUNTAS FRECUENTES
// ---------------------------------------------------------------------

/**
 * Acordeón NATIVO: `<details>` y `<summary>`, cero JavaScript.
 *
 * Se abre, se cierra, se navega con teclado y lo anuncia el lector de pantalla
 * sin que el cliente escriba una línea, sin `aria-expanded` que mantener a
 * mano y sin un estado que pueda quedarse desincronizado. El chevrón lo dibuja
 * la hoja de estilos con `content`, que no necesita ninguna imagen ni ningún
 * `url()` —prohibido en `ui.css.ts`—.
 */
function renderFaq(view: TenantPublicView): string {
  const entradas = view.faq
    .map(
      (entrada) => `      <details class="txb-faq__item">
        <summary class="txb-faq__q">${escapeHtml(entrada.question)}</summary>
        <div class="txb-faq__a"><p class="txb-measure">${escapeHtml(entrada.answer)}</p></div>
      </details>`,
    )
    .join("\n");
  return `<section class="txb-section txb-section--alt" id="${PUBLIC_SECTION_DOM_IDS.faq}" aria-labelledby="${
    SECTION_TITLE_DOM_IDS.faq
  }">
  <div class="txb-wrap">
    <div class="txb-section__head">
      <h2 id="${SECTION_TITLE_DOM_IDS.faq}">${escapeHtml(view.sectionHeadings.faq)}</h2>
    </div>
    <div class="txb-faq">
${entradas}
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------
// LA TABLA DE DESPACHO
// ---------------------------------------------------------------------

/**
 * Una función por sección, y el tipo obliga a que estén TODAS. Añadir un
 * identificador a `PublicSectionId` sin escribir aquí su función no compila:
 * es la garantía de que ninguna sección nueva pueda quedarse sin pintar sin
 * que nadie se entere.
 */
export const PUBLIC_SECTION_RENDERERS: Readonly<Record<PublicSectionId, PublicSectionRenderer>> = {
  hero: renderHero,
  servicios: renderServicios,
  profesionales: renderProfesionales,
  experiencia: renderExperiencia,
  reserva: renderReserva,
  info: renderInfo,
  faq: renderFaq,
};

/**
 * Compone la web pública entera: recorre `PUBLIC_SECTION_ORDER` —el orden es el
 * mismo para todos los locales y no es configurable, porque un orden por local
 * sería una segunda plantilla— y va concatenando las secciones que ese local
 * tiene encendidas. `isSectionEnabled` es quien decide, y la sección de reserva
 * está siempre encendida por construcción: no hay ninguna combinación de
 * configuración que sirva una página sin ella.
 */
export function renderPublicSections(view: TenantPublicView): string {
  const partes: string[] = [];
  for (const seccion of PUBLIC_SECTION_ORDER) {
    if (!isSectionEnabled(view.enabledSections, seccion)) continue;
    partes.push(PUBLIC_SECTION_RENDERERS[seccion](view));
  }
  return partes.join("\n\n");
}

/**
 * Los enlaces de la barra de navegación, filtrados por las secciones que ESTE
 * local tiene encendidas: apagar una sección le quita también su enlace, así
 * que la página no puede servir un ancla que no lleve a ninguna parte.
 *
 * `sangria` sólo controla el sangrado del marcado: la misma lista se emite dos
 * veces —la de escritorio y la del menú móvil— y no repite ningún
 * identificador porque los enlaces van por clase, nunca por `id`.
 */
export function renderNavLinks(view: TenantPublicView, sangria: string): string {
  return view.nav.links
    .filter((enlace) => isSectionEnabled(view.enabledSections, enlace.target))
    .map(
      (enlace) =>
        `${sangria}<li><a class="txb-nav__link" href="${anchor(enlace.target)}">${escapeHtml(
          enlace.label,
        )}</a></li>`,
    )
    .join("\n");
}
