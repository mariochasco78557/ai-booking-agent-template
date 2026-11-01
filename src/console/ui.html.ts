import { CONSOLE_HOST, DEFAULT_CONSOLE_PORT } from "./config.js";
import { AVAILABILITY_EXPLORER_COPY } from "./availabilityExplorer.js";
import { ACTA_COPY, GUIDE_COPY, MISION_COPY, WORKSHOP_COPY } from "./demoWorkspace.js";
import { HUMAN_TASK_LEDGER_COPY } from "./snapshot.js";
import { SERVICE_LABELS, type ServiceId } from "../callEngine/domain/types.js";

/**
 * Static HTML shell for the step 14 operator console redesign.
 *
 * Implements docs/operator_console/DESIGN_SPEC.md §4 (app shell), §10
 * (single page, hash routing — all seven views live here as
 * `<section id="vista-..." hidden>`, and the router in ui.js.ts only ever
 * toggles the boolean `hidden` property, never innerHTML).
 *
 * HARD RULES (see the mission brief and tests/console/console.test.ts):
 *   - NO inline `<script>` — the only script this page loads is the external
 *     `/app.js` (see ui.js.ts), which satisfies `script-src 'self'` without
 *     ever needing `'unsafe-inline'`.
 *   - NO `<style>` block and NO `style="..."` attribute anywhere. The CSP's
 *     `style-src 'self'` rejects inline styles, so the stylesheet is served
 *     from its own `/app.css` route (see ui.css.ts) and linked below.
 *   - the "Demo local · Datos sintéticos · No producción" banner below is
 *     PLAIN STATIC TEXT, not populated or toggled by any script — so it can
 *     never be hidden by a bug (or a future edit) in ui.js.ts. It is present
 *     exactly once, in the sticky topbar, which is shared by all seven views —
 *     structurally impossible to omit from a section.
 *   - every dynamic value the operator sees is filled in by ui.js.ts via
 *     `textContent` only — this file only provides the empty containers for
 *     it to fill.
 *
 * `port` (D6, step 14 repair): `CALL_ENGINE_CONSOLE_PORT` is configurable
 * (config.ts), so the sidebar footer's "Local · <host>:<port>" text is
 * rendered HERE, from the real value the server is bound to (or will bind
 * to), rather than baked in as a literal — a console started on a different
 * port used to keep stating the default one. The HOST half stays
 * `CONSOLE_HOST`, the SAME hard-coded, non-configurable constant config.ts
 * exports — never a second, independently-typed "127.0.0.1" literal here.
 */

/**
 * The three `<option>`s of `#huecos-servicio`, generated from `SERVICE_LABELS`
 * (`callEngine/domain/types.ts`) — the SAME allow-list `availabilityExplorer.ts`
 * and every service label in the console already read from. Before this
 * repair, these three names were hand-typed here, the only piece of service
 * copy in the whole console that was not (revisión adversarial de la
 * capacidad 1, hallazgo H5): a renamed service would have drifted silently.
 */
function huecosServiceOptions(): string {
  const serviceIds: readonly ServiceId[] = [0, 1, 2];
  return serviceIds
    .map((serviceId) => `<option value="${String(serviceId)}">${SERVICE_LABELS[serviceId]}</option>`)
    .join("\n          ");
}

export function renderConsoleHtml(port: number = DEFAULT_CONSOLE_PORT): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo Salon — Consola de operación</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<a class="tx-skip-link" href="#contenido">Saltar al contenido principal</a>
<div class="tx-shell">

<nav class="tx-sidebar" aria-label="Secciones de la consola">
  <div class="tx-brand">
    <div class="tx-brand__plate">
      <img src="/brand/logo.png" alt="Demo Salon Barbershop" width="400" height="400">
    </div>
    <span class="tx-brand__glyph" role="img" aria-label="Demo Salon">TX</span>
    <p class="tx-brand__venue">Consola de operación</p>
  </div>
  <!-- (step 21A §1.1 A7 / §7.2 trampa 8) Los siete iconos de la navegación
       son SVG EN LÍNEA Y ESTÁTICOS, escritos aquí y sólo aquí. No pueden
       nacer de ui.js.ts: el DOM falso de las pruebas (tests/console/fakeDom.ts)
       no implementa createElementNS, así que un icono creado desde el cliente
       rompería las pruebas de las siete rutas a la vez. Van sin xmlns porque
       esto se sirve como text/html y el analizador ya los mete en el espacio
       de nombres de SVG; sin xmlns tampoco hay ninguna URL en el documento.
       Cada uno es aria-hidden="true" y va AL LADO de texto: el nombre
       accesible del enlace lo da su aria-label, que no cambia cuando la
       etiqueta visible se oculta en el raíl de 76 px (≤1279 px). -->
  <ul class="tx-nav__list">
    <li><a href="#/inicio" data-route="inicio" title="Inicio" aria-label="Inicio"><span class="tx-nav__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M3.6 11 12 3.8 20.4 11"/><path d="M5.9 9.6v10.6h12.2V9.6"/></svg></span><span class="tx-nav__label">Inicio</span></a></li>
    <li><a href="#/agenda" data-route="agenda" title="Agenda" aria-label="Agenda"><span class="tx-nav__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><rect x="3.4" y="4.4" width="17.2" height="16.2" rx="2.2"/><path d="M8.4 4.4v16.2M11.6 9.2h5.8M11.6 12.9h5.8M11.6 16.6h3.6"/></svg></span><span class="tx-nav__label">Agenda</span></a></li>
    <li><a href="#/lista-espera" data-route="lista-espera" title="Lista de espera" aria-label="Lista de espera"><span class="tx-nav__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="12" cy="12" r="8.3"/><path d="M12 7.1V12l3.2 1.9"/></svg></span><span class="tx-nav__label">Lista de espera</span></a></li>
    <li><a href="#/llamadas" data-route="llamadas" title="Llamadas" aria-label="Llamadas"><span class="tx-nav__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M6.7 3.7h3.1l1.6 4-2 1.4a11.6 11.6 0 0 0 5.5 5.5l1.4-2 4 1.6v3.1a1.7 1.7 0 0 1-1.9 1.7C11.5 18.4 5.6 12.5 4.9 5.6a1.7 1.7 0 0 1 1.8-1.9z"/></svg></span><span class="tx-nav__label">Llamadas</span></a></li>
    <li><a href="#/horarios-y-ausencias" data-route="horarios-y-ausencias" title="Horarios y ausencias" aria-label="Horarios y ausencias"><span class="tx-nav__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><rect x="3.4" y="5" width="17.2" height="15.6" rx="2.2"/><path d="M3.4 9.8h17.2M8.2 2.9v4M15.8 2.9v4"/></svg></span><span class="tx-nav__label">Horarios y ausencias</span></a></li>
    <li><a href="#/equipo" data-route="equipo" title="Equipo" aria-label="Equipo"><span class="tx-nav__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="9.2" cy="8.4" r="3.4"/><path d="M3.3 20.3c0-3.4 2.6-5.8 5.9-5.8s5.9 2.4 5.9 5.8"/><path d="M16.3 5.4a3.4 3.4 0 0 1 0 6M17.6 14.9c1.9.8 3.1 2.7 3.1 5.4"/></svg></span><span class="tx-nav__label">Equipo</span></a></li>
  </ul>
  <p class="tx-sidebar__tools-label">Herramientas de demostración</p>
  <ul class="tx-nav__list tx-nav__list--tools">
    <li><a href="#/laboratorio" data-route="laboratorio" title="Laboratorio" aria-label="Laboratorio"><span class="tx-nav__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M10.1 3.4v5.5L5 17.9a2.1 2.1 0 0 0 1.8 3.1h10.4a2.1 2.1 0 0 0 1.8-3.1l-5.1-9V3.4"/><path d="M8.7 3.4h6.6M7.7 14.7h8.6"/></svg></span><span class="tx-nav__label">Laboratorio</span></a></li>
  </ul>
  <p class="tx-sidebar__foot">Local · ${CONSOLE_HOST}:${String(port)}</p>
</nav>

<div class="tx-main">
<header class="tx-topbar">
  <h1 class="tx-topbar__title" id="tx-view-title" tabindex="-1">Inicio</h1>
  <span class="tx-badge-demo">Demo local · Datos sintéticos · No producción</span>
  <!-- (revisión adversarial de la capacidad 3, hallazgo B1) "#tx-freshness"
       ya NO es una región viva: antes se reescribía con la hora cada 2 s
       (el sondeo, \`POLL_MS\`) y su región viva la convertían en un anuncio
       perpetuo — el defecto que §9.5 prohíbe
       explícitamente ("ninguna en... contadores"). La ÚNICA región viva de
       conexión, que sí manda §9.5 ("la de la cabecera para la pérdida y
       recuperación de conexión"), es la siguiente: escribe SÓLO en la
       transición ok→caído y caído→ok, nunca en cada sondeo. -->
  <p class="tx-freshness" id="tx-freshness">Cargando…</p>
  <p class="tx-visually-hidden" id="tx-conexion-anuncio" role="status" aria-live="polite"></p>
  <!-- (step 18 §3.6) EL SEGUNDO RELOJ, rotulado. Arriba, "#tx-freshness" dice
       la hora del ordenador de quien mira; aquí se dice la hora SINTÉTICA con
       la que opera la demostración, que sólo se mueve desde el Laboratorio.
       Con dos relojes sin rótulo la barra superior podía decir "17:43"
       mientras la Agenda operaba a las 10:00 de un martes de agosto.
       NO es aria-live a propósito: se repinta en cada sondeo de 2 s y
       anunciarlo cada dos segundos sería inutilizable. Es contenido normal,
       alcanzable al recorrer la cabecera con el lector de pantalla. -->
  <p class="tx-synthetic-clock" id="tx-reloj-sintetico"></p>
</header>

<main id="contenido" class="tx-workspace" tabindex="-1">

<!-- (step 18 §1.2) El resultado de una acción destructiva o de ámbito de
     página — hoy, sólo el reinicio de la demostración. Vive AQUÍ, en <main> y
     fuera de todos los <dialog>, precisamente porque el anuncio anterior nacía
     dentro del diálogo de reinicio y un temporizador lo cerraba a los 900 ms,
     cortando la lectura por la mitad. Nace vacía y oculta: nadie la escribe
     hasta que pasa algo de ámbito de página. -->
<p class="tx-status-line" id="estado-global" role="status" aria-live="polite" hidden></p>

<!-- ================================================================ -->
<!-- INICIO                                                            -->
<!-- ================================================================ -->
<section id="vista-inicio" class="tx-view" hidden>
  <p class="tx-status-line tx-col-12" id="inicio-ruta-desconocida" role="status" aria-live="polite" hidden>Esa página no existe. Vuelve a Inicio desde el menú de la izquierda.</p>
  <div class="tx-panel tx-context tx-context--compact tx-col-12">
    <p class="tx-context__status"><span class="tx-context__dot tx-context__dot--checking" id="inicio-estado-dot" aria-hidden="true"></span><span id="inicio-estado-texto">Asistente sintético · Comprobando la conexión…</span></p>
    <p id="inicio-fecha"></p>
    <p class="tx-context__note">Estos datos son de una demostración local. No hay ninguna línea telefónica conectada y no se toca ningún sistema real de Demo Salon.</p>
    <!-- (step 18 §5.5, K14) UNA línea neutra, dentro del panel de contexto que
         ya existía. Ninguna tarjeta de cifra nueva, ningún color de alarma,
         ningún porcentaje, ninguna comparación con ayer. Nace oculta y se
         queda oculta mientras el número sea cero: el servidor manda «null» y
         entonces aquí no hay nada que decir. -->
    <p class="tx-context__note" id="inicio-inasistencias" hidden><span id="inicio-inasistencias-texto"></span> <a href="#/agenda">Ver en la agenda</a></p>
  </div>

  <!-- (step 21A §2.5, §7.3 trampa 12) Las CUATRO tarjetas de cifra de
       siempre, con las mismas cuatro definiciones y los mismos tres destinos
       reales. Dos pruebas (noShowUi:635, waitlistUi:446) cuentan cuántas
       veces aparece el atributo de clase de la tarjeta, LITERAL y solo:
       por eso ningún modificador se le añade al lado —viven en un hijo
       (\`tx-stat__icon\`) o en el \`id\`— y por eso este comentario tampoco
       puede escribirlo entero ni para citarlo: una cita contaría como una
       quinta tarjeta que no existe.
       Los discos de icono son SVG estáticos, como los de la navegación, por
       la misma razón (§7.2 trampa 8: fakeDom no tiene createElementNS).
       Lo que NO hay y no va a haber (§1.2 D2/D3): ninguna tendencia,
       ningún «vs ayer», ningún porcentaje, ningún objetivo, ningún ranking
       y ninguna quinta tarjeta — «Necesita revisión» duplicaría el recuento
       del panel de atención y chocaría con una etiqueta de píldora que ya
       significa otra cosa. -->
  <div class="tx-stat-grid">
    <div class="tx-stat" id="kpi-llamadas">
      <span class="tx-stat__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M6.7 3.7h3.1l1.6 4-2 1.4a11.6 11.6 0 0 0 5.5 5.5l1.4-2 4 1.6v3.1a1.7 1.7 0 0 1-1.9 1.7C11.5 18.4 5.6 12.5 4.9 5.6a1.7 1.7 0 0 1 1.8-1.9z"/></svg></span>
      <span class="tx-stat__value" id="kpi-llamadas-valor">—</span>
      <span class="tx-stat__label">Llamadas atendidas hoy</span>
      <span class="tx-stat__hint">Simuladas</span>
    </div>
    <a class="tx-stat" href="#/llamadas" id="kpi-resueltas">
      <span class="tx-stat__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="12" cy="12" r="8.3"/><path d="m8.3 12.2 2.6 2.6 4.8-5.2"/></svg></span>
      <span class="tx-stat__value" id="kpi-resueltas-valor">—</span>
      <span class="tx-stat__label">Resueltas sin molestar a nadie</span>
      <span class="tx-stat__hint">Ver llamadas</span>
    </a>
    <a class="tx-stat" href="#/agenda" id="kpi-reservas">
      <span class="tx-stat__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><rect x="3.4" y="5" width="17.2" height="15.6" rx="2.2"/><path d="M3.4 9.8h17.2M8.2 2.9v4M15.8 2.9v4"/></svg></span>
      <span class="tx-stat__value" id="kpi-reservas-valor">—</span>
      <span class="tx-stat__label">Reservas creadas hoy</span>
      <span class="tx-stat__hint">Ver agenda</span>
    </a>
    <a class="tx-stat" href="#/llamadas" id="kpi-errores">
      <span class="tx-stat__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="12" cy="12" r="8.3"/><path d="M12 7.9v4.6M12 15.9v.1"/></svg></span>
      <span class="tx-stat__value" id="kpi-errores-valor">—</span>
      <span class="tx-stat__label">Errores técnicos</span>
      <span class="tx-stat__hint" id="kpi-errores-hint"></span>
    </a>
  </div>

  <!-- (step 21A §4.5) DOS secciones hermanas, cada una con su <h2>, su
       aria-labelledby y su contador propio. NO se introduce un encabezado
       que las envuelva: degradaría los dos <h2> a <h3> y rompería el mapa
       de encabezados sin ganar nada. Las cuentas vienen de definiciones
       distintas —llamadas que piden una mirada / tareas humanas abiertas—
       y no se suman en ningún sitio. La única diferencia visual es el
       filete de acento que la de atención gana cuando su contador pasa de
       cero (clase \`tx-panel--focus\`, puesta desde renderInicio); la de
       tareas no lo lleva nunca. -->
  <div class="tx-col-8 tx-stack">
    <section class="tx-panel" id="panel-atencion" aria-labelledby="tit-atencion">
      <h2 id="tit-atencion">Necesita tu atención <span id="contador-atencion"></span></h2>
      <!-- (step 23 §8.1) Las propuestas pendientes de aprobación, en su
           propio bloque y ANTES de las llamadas. El contador de la cabecera
           es la SUMA de dos sumandos disjuntos por construcción —llamadas que
           piden una mirada y propuestas sin aprobar—: una llamada nunca es
           una propuesta, así que no hay doble conteo posible. Y
           \`metrics.pendingHumanTasks\` no se toca: la tarea "decidir un hueco"
           es EL RECADO, y la propuesta es la sugerencia PARA ese recado.
           El bloque entero se oculta cuando no hay ninguna: un título con una
           lista vacía debajo es ruido. Sin campana, sin insignia y sin aviso
           flotante: la tarjeta dice qué hueco y qué persona, con texto. -->
      <h3 id="tit-atencion-propuestas" hidden>Propuestas pendientes de aprobación</h3>
      <ul class="tx-attention-list" id="atencion-propuestas" hidden></ul>
      <ul class="tx-attention-list" id="lista-atencion"></ul>
      <div class="tx-empty" id="vacio-atencion" hidden>
        <p class="tx-empty__title">Todo tranquilo.</p>
        <p class="tx-empty__body">No hay nada que necesite tu atención ahora mismo.</p>
      </div>
    </section>

    <section class="tx-panel" aria-labelledby="tit-cola">
      <h2 id="tit-cola">Cosas que hacer una persona <span id="contador-cola"></span></h2>
      <ul class="tx-task-list" id="lista-tareas"></ul>
      <div class="tx-empty" id="vacio-tareas" hidden>
        <p class="tx-empty__title">Nada pendiente.</p>
        <p class="tx-empty__body">Ninguna llamada ha quedado esperando a una persona.</p>
      </div>
    </section>
  </div>

  <div class="tx-col-4 tx-stack">
    <section class="tx-panel" aria-labelledby="tit-citas-hoy">
      <h2 id="tit-citas-hoy">Próximas citas de hoy</h2>
      <!-- (step 21A §4.6, §1.2 D8) Cada fila dice hora · servicio ·
           profesional · píldora, y NUNCA un nombre de cliente: no existe uno
           canónico y jamás se derivará de un identificador. El carril
           temporal (punto y línea) es decorado CSS puro sobre esta clase,
           cero nodos nuevos en el DOM. -->
      <ul class="tx-activity-list tx-appointment-list" id="lista-citas-hoy"></ul>
      <div class="tx-empty" id="vacio-citas-hoy" hidden>
        <p class="tx-empty__title">No quedan citas hoy.</p>
        <p class="tx-empty__body">No hay ninguna cita más en lo que queda de día.</p>
      </div>
      <p><a class="tx-btn tx-btn--secondary" href="#/agenda">Ver toda la agenda</a></p>
    </section>

    <section class="tx-panel" aria-labelledby="tit-dias-distintos">
      <h2 id="tit-dias-distintos">Próximos días distintos</h2>
      <p class="tx-context__note" id="inicio-calendario-resumen"></p>
      <ul class="tx-day-list tx-day-list--compact" id="lista-dias-distintos"></ul>
      <p><a class="tx-btn tx-btn--secondary" href="#/horarios-y-ausencias">Ver horarios y ausencias</a></p>
    </section>
  </div>

  <div class="tx-col-12">
    <!-- (step 21A §1.2 D11, §4.7) El título dice lo que la lista ES. La
         fuente es \`snap.calls\` filtrada por \`outcome !== undefined\`: sólo
         llamadas, ninguna reserva y ninguna entrada de lista de espera. La
         cronología entre dominios es otra misión (step 21B); hasta
         entonces, «Lo último que ha pasado» prometía más de lo que hay.
         El identificador de la llamada, el reasonCode, el internalReasonCode
         y el scenarioId NO salen aquí: viven en el <details> técnico de
         Llamadas. -->
    <section class="tx-panel" aria-labelledby="tit-actividad">
      <h2 id="tit-actividad">Actividad reciente de llamadas</h2>
      <ul class="tx-activity-list" id="lista-actividad"></ul>
      <div class="tx-empty" id="vacio-actividad" hidden>
        <p class="tx-empty__title">Todavía no ha pasado nada.</p>
        <p class="tx-empty__body">Cuando el asistente atienda una llamada, aparecerá aquí.</p>
      </div>
      <p><a class="tx-btn tx-btn--secondary" href="#/llamadas">Ver todas las llamadas</a></p>
    </section>
  </div>

  <div class="tx-col-12">
    <!-- (step 23 §8.2) El rastro del ciclo cancelación → hueco → propuesta →
         aviso → aceptación → conversión, DESPUÉS del feed de llamadas y en su
         propio panel. Los dos NO se mezclan: D11 de step 21A sigue en pie y
         la nota step 21B sigue sin abrirse, porque esto es un rastro de UN
         solo dominio, servido por el \`seq\` que ese dominio ya tenía.
         Cada fila trae, ya resuelto por el servidor, de quién fue el acto
         (Sistema u Operador, en una píldora CON TEXTO), la hora del reloj
         sintético, un título corto y su razón debajo. Nada se explica sólo
         con color, y ni un identificador crudo sale de aquí. -->
    <section class="tx-panel" id="panel-actividad-operativa" aria-labelledby="tit-actividad-operativa">
      <h2 id="tit-actividad-operativa">Actividad operativa de cancelaciones y lista de espera</h2>
      <ul class="tx-activity-list" id="lista-actividad-operativa"></ul>
      <div class="tx-empty" id="vacio-actividad-operativa" hidden>
        <p class="tx-empty__title">Aún no ha pasado nada en el ciclo de cancelaciones de esta sesión.</p>
        <p class="tx-empty__body">Cuando canceles una cita desde la Agenda, lo que ocurra con el hueco que se libere se irá contando aquí.</p>
      </div>
      <details class="tx-details" id="actividad-operativa-detalles" hidden>
        <summary id="actividad-operativa-resumen">Ver toda la actividad de esta sesión</summary>
        <div class="tx-details__body">
          <ul class="tx-activity-list" id="lista-actividad-operativa-todo"></ul>
        </div>
      </details>
      <!-- Nace OCULTA a propósito: una línea viva vacía y visible es un nodo
           más en el árbol de accesibilidad que no dice nada. setEstadoLinea
           la muestra en cuanto hay algo que decir y limpiarLinea la vuelve a
           ocultar, que es exactamente el invariante de step 18 §1.2. -->
      <p class="tx-status-line" id="actividad-operativa-estado" role="status" aria-live="polite" hidden></p>
    </section>
  </div>
</section>

<!-- ================================================================ -->
<!-- AGENDA                                                            -->
<!-- ================================================================ -->
<section id="vista-agenda" class="tx-view" hidden>
  <div class="tx-controls tx-panel">
    <!-- step 26 §10/§12 — el patrón que ya existe en la consola (botones con
         aria-pressed dentro de un grupo rotulado), no un widget de pestañas nuevo. -->
    <div class="tx-filter-bar" role="group" aria-label="Vista de la agenda">
      <button type="button" class="tx-filter" id="agenda-vista-dia" aria-pressed="true">Día</button>
      <button type="button" class="tx-filter" id="agenda-vista-semana" aria-pressed="false">Semana</button>
      <button type="button" class="tx-filter" id="agenda-vista-mes" aria-pressed="false">Mes</button>
      <button type="button" class="tx-filter" id="agenda-vista-lista" aria-pressed="false">Lista</button>
    </div>
    <div class="tx-btn-row" role="group" aria-label="Navegar por fecha">
      <button type="button" class="tx-btn tx-btn--secondary" id="agenda-anterior">‹ Anterior</button>
      <button type="button" class="tx-btn tx-btn--secondary" id="agenda-hoy">Hoy</button>
      <button type="button" class="tx-btn tx-btn--secondary" id="agenda-siguiente">Siguiente ›</button>
    </div>
    <div class="tx-field">
      <label for="agenda-filtro-profesional">Profesional</label>
      <select id="agenda-filtro-profesional"><option value="">Todos</option></select>
    </div>
    <!-- (step 18 §5.2) Entra por la Agenda, que es donde viven las citas. No
         hay ninguna entrada nueva en la navegación principal (§5.1). -->
    <button type="button" class="tx-btn tx-btn--primary" id="btn-abrir-grupo">Nueva reserva para varias personas</button>
    <!-- (step 24 §4) La acción principal de esta misión. Entra por la Agenda
         por la misma razón que la de arriba: es donde viven las citas. No hay
         ninguna entrada nueva en la navegación principal. -->
    <button type="button" class="tx-btn tx-btn--primary" id="btn-abrir-cita-manual">Crear cita manual</button>
  </div>

  <!-- step 26 §9 — un segmento de ruta desconocido se normaliza AL PINTAR,
       nunca reescribiendo la URL: este texto estático dice qué ha pasado. -->
  <p class="tx-status-line tx-col-12" id="agenda-aviso-ruta" hidden>No se ha entendido parte de la dirección. Se muestra el día de hoy.</p>

  <h2 class="tx-agenda-titulo-rango tx-col-12" id="agenda-titulo-rango" tabindex="-1"></h2>
  <!-- step 26 §6.1 — si alguna cita cae fuera del horario del local, el eje
       se extiende para contenerla y esto lo dice. -->
  <p class="tx-context__note tx-col-12" id="agenda-fuera-horario" hidden>Hay citas fuera del horario del local.</p>
  <!-- step 26 §6.3 — con más de cuatro profesionales visibles, la vista Día
       cae a lista cronológica en vez de estrechar columnas hasta lo ilegible. -->
  <p class="tx-context__note tx-col-12" id="agenda-nota-densidad" hidden>Con más de cuatro profesionales la agenda se muestra como lista. Filtra por profesional para ver la rejilla.</p>

  <!-- step 26 §6.7 — la rejilla de Día, o la de Semana (un profesional
       elegido). Sin el rol ARIA de cuadrícula: HTML semántico, construido
       por renderAgenda. -->
  <div class="tx-col-12" id="agenda-rejilla" hidden></div>
  <!-- step 26 §5 — resumen compacto por día de la vista Semana en "Todos". -->
  <ol class="tx-col-12" id="agenda-semana-resumen" hidden></ol>
  <!-- step 26 §7 — rejilla mensual de resumen (reutiliza .tx-month-grid). -->
  <div class="tx-col-12" id="agenda-mes" hidden></div>

  <div class="tx-col-12" id="agenda-dias"></div>
  <div class="tx-empty tx-col-12" id="agenda-vacio" hidden>
    <p class="tx-empty__title">No hay ninguna cita en estas fechas.</p>
    <p class="tx-empty__body">Las citas que cree el asistente aparecerán aquí.</p>
  </div>

  <!-- step 26 REAPERTURA §R4 — REVIERTE CONSCIENTEMENTE step 19 §3 en cuanto
       al ORDEN de este panel. Aquel documento lo puso ANTES de la agenda "para
       que el resultado se lea junto a la agenda que se está mirando"; con las
       cuatro vistas de step 26 esa colocación empuja la agenda fuera de la
       primera pantalla en todos los anchos. Por decisión del owner baja
       a herramienta secundaria y se pliega. TODO LO DEMÁS de step 19 §3 sigue
       vigente: panel EN LÍNEA (no diálogo), CONSULTA sin ruta de escritura,
       nada preseleccionado (I3). Ver docs/m26-agenda-multivista/04-normativo-
       (internal doc, not included in the template) §1.2 S2. -->
  <details class="tx-panel tx-col-12" id="huecos-panel">
    <summary id="tit-huecos">Comprobar huecos sintéticos</summary>
    <p class="tx-context__note">Esto sólo mira la agenda sintética de esta demostración. No reserva nada y no avisa a nadie.</p>
    <p class="tx-context__note">Como mucho 14 días de una vez. Es un tope técnico de esta demostración local, no una regla de Demo Salon.</p>
    <div class="tx-controls">
      <div class="tx-field">
        <label for="huecos-servicio">Servicio</label>
        <select id="huecos-servicio">
          <option value="">Elige un servicio</option>
          ${huecosServiceOptions()}
        </select>
      </div>
      <fieldset class="tx-slot-card__choice">
        <legend>A quién quieres</legend>
        <!-- SIN preselección (I3): el sistema no elige por nadie. -->
        <label class="tx-radio-field"><input type="radio" name="huecos-a-quien" value="one" id="huecos-a-quien-una"> <span>Una persona concreta</span></label>
        <label class="tx-radio-field"><input type="radio" name="huecos-a-quien" value="any" id="huecos-a-quien-cualquiera"> <span>Cualquiera del equipo</span></label>
      </fieldset>
      <div class="tx-field" id="huecos-profesional-campo" hidden>
        <label for="huecos-profesional">Quién</label>
        <select id="huecos-profesional"><option value="">Elige a quién</option></select>
      </div>
      <fieldset class="tx-slot-card__choice">
        <legend>Cuándo</legend>
        <!-- SIN preselección (I3). -->
        <label class="tx-radio-field"><input type="radio" name="huecos-cuando" value="dia" id="huecos-cuando-dia"> <span>Un día concreto</span></label>
        <label class="tx-radio-field"><input type="radio" name="huecos-cuando" value="rango" id="huecos-cuando-rango"> <span>Un rango de días</span></label>
      </fieldset>
      <div class="tx-field" id="huecos-dia-campo" hidden>
        <label for="huecos-fecha">Día</label>
        <input type="date" id="huecos-fecha">
      </div>
      <div class="tx-field" id="huecos-desde-campo" hidden>
        <label for="huecos-desde">Desde</label>
        <input type="date" id="huecos-desde">
      </div>
      <div class="tx-field" id="huecos-hasta-campo" hidden>
        <label for="huecos-hasta">Hasta</label>
        <input type="date" id="huecos-hasta">
      </div>
    </div>
    <p class="tx-status-line" id="huecos-gate">El botón no se activa hasta que elijas el servicio, a quién quieres y las fechas. No se rellena nada solo.</p>
    <div class="tx-btn-row">
      <button type="button" class="tx-btn tx-btn--primary" id="huecos-comprobar" disabled aria-describedby="huecos-gate">Comprobar huecos sintéticos</button>
    </div>
    <p class="tx-status-line" id="huecos-error" role="alert" hidden></p>
    <div id="huecos-resultados-bloque" hidden>
      <h3 tabindex="-1" id="huecos-resultados-titulo">Huecos que encuentra esta demostración</h3>
      <p class="tx-status-line" role="status" aria-live="polite" id="huecos-recuento"></p>
      <p class="tx-context__note" id="huecos-orden"></p>
      <p class="tx-context__note" id="huecos-sintetico"></p>
      <p class="tx-status-line" id="huecos-desfase" hidden>${AVAILABILITY_EXPLORER_COPY.desfase}</p>
      <p class="tx-context__note" id="huecos-nota-incapacidad" hidden></p>
      <ul id="huecos-motivos-dias" hidden></ul>
      <p class="tx-empty__body" id="huecos-vacio" hidden></p>
      <div class="tx-slot-list" id="huecos-resultados"></div>
    </div>
  </details>
</section>

<!-- ================================================================ -->
<!-- LISTA DE ESPERA                                                   -->
<!-- ================================================================ -->
<!--
  step 17 §9.2. Los bloques van en el orden del diseño: lo ACCIONABLE
  primero (huecos que esperan una decisión), después lo que hay que revisar,
  después la lista completa, después el ajuste, y lo técnico al final y
  plegado.

  Las frases de las NO-REGLAS (§5) que valen para todo un bloque están aquí
  como TEXTO ESTÁTICO, palabra por palabra: así existen aunque el motor no
  conteste, y no dependen de ninguna línea de JavaScript. Una prueba las
  compara carácter a carácter con WAITLIST_COPY (src/console/waitlistSnapshot.ts),
  que es su única fuente de verdad, de modo que no pueden separarse. Las que
  dependen de un hueco concreto (cuántas personas encajan, que el sistema no
  ha elegido a nadie) las escribe ui.js.ts leyéndolas de esa misma clave
  "waitlist.copy" de la instantánea.
-->
<section id="vista-lista-espera" class="tx-view" hidden>
  <p class="tx-status-line tx-col-12" id="lista-espera-cargando" role="status" aria-live="polite">Cargando…</p>

  <div class="tx-panel tx-panel--alarm tx-col-12" id="lista-espera-integridad" hidden>
    <h2>Fallo de integridad: la demostración ha dicho que hizo algo que no hizo.</h2>
    <p id="lista-espera-integridad-detalle"></p>
  </div>

  <!-- Bloque 1 -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-le-huecos">
    <h2 id="tit-le-huecos">Huecos liberados que esperan una decisión tuya <span id="le-huecos-contador"></span></h2>
    <p class="tx-context__note">Esto sólo mira el hueco que se acaba de liberar. No busca alternativas en el resto de la agenda.</p>
    <p class="tx-context__note">No hay plazo de aceptación. No prometemos ninguno.</p>
    <div class="tx-slot-list" id="le-huecos-lista"></div>
    <p class="tx-context__note" id="le-huecos-orden" hidden>Están ordenadas por cuándo se apuntaron. Es orden de lectura, no de prioridad: nadie tiene preferencia sobre nadie.</p>
    <div class="tx-empty" id="le-huecos-vacio" hidden>
      <p class="tx-empty__title">Ahora mismo no hay ningún hueco liberado esperando decisión.</p>
      <p class="tx-empty__body">Cuando canceles una cita desde la Agenda, el hueco que se libere aparecerá aquí.</p>
    </div>
    <p class="tx-status-line" id="le-huecos-estado" role="status" aria-live="polite"></p>
  </section>

  <!-- Bloque 2 -->
  <section class="tx-panel tx-col-12" id="le-bloque-tardias" aria-labelledby="tit-le-tardias" hidden>
    <h2 id="tit-le-tardias">Cancelaciones fuera del plazo configurado <span id="le-tardias-contador"></span></h2>
    <p>No se ha aplicado ninguna penalización. Qué hacer con estas cancelaciones está pendiente de decidir con Demo Salon.</p>
    <div class="tx-slot-list" id="le-tardias-lista"></div>
    <p class="tx-status-line" id="le-tardias-estado" role="status" aria-live="polite"></p>
  </section>

  <!-- Bloque 3 -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-le-personas">
    <h2 id="tit-le-personas">Personas apuntadas <span id="le-personas-contador"></span></h2>
    <div class="tx-controls">
      <div class="tx-field">
        <label for="le-filtro-estado">Mostrar</label>
        <select id="le-filtro-estado">
          <option value="activas">Activas</option>
          <option value="latentes">Rechazadas y caducadas</option>
          <option value="cerradas">Convertidas y retiradas</option>
          <option value="todas">Todas</option>
        </select>
      </div>
      <button type="button" class="tx-btn tx-btn--primary" id="btn-abrir-alta-lista">Apuntar a alguien</button>
    </div>
    <p class="tx-context__note">Nada caduca solo. Si esta persona ya no espera, márcala tú como caducada.</p>
    <p class="tx-context__note">Aviso simulado. No se ha enviado ningún mensaje ni se ha llamado a nadie.</p>
    <div class="tx-table-scroll" tabindex="0" role="region" aria-label="Personas apuntadas a la lista de espera">
      <table class="tx-table tx-table--stack">
        <caption class="tx-visually-hidden">Personas apuntadas a la lista de espera</caption>
        <thead>
          <tr>
            <th scope="col">Persona</th>
            <th scope="col">Cómo está</th>
            <th scope="col">Qué pidió</th>
            <th scope="col">Cómo se apuntó</th>
            <th scope="col">Qué puedes hacer</th>
          </tr>
        </thead>
        <tbody id="le-personas-tbody"></tbody>
      </table>
    </div>
    <div class="tx-empty" id="le-personas-vacio" hidden>
      <p class="tx-empty__title">Nadie está apuntado a la lista de espera. Cuando alguien acepte apuntarse, aparecerá aquí.</p>
      <p class="tx-empty__body">Sólo se apunta a quien lo ha pedido expresamente.</p>
    </div>
    <div class="tx-empty" id="le-personas-vacio-filtro" hidden>
      <p class="tx-empty__title">Nadie encaja en este filtro.</p>
      <p class="tx-empty__body">Prueba con "Todas".</p>
    </div>
    <p class="tx-status-line" id="le-personas-estado" role="status" aria-live="polite"></p>
  </section>

  <!-- Bloque 4 -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-le-plazo">
    <h2 id="tit-le-plazo">Plazo de cancelación</h2>
    <p id="le-plazo-frase"></p>
    <p class="tx-context__note" id="le-plazo-demo"></p>
    <div class="tx-field">
      <label for="le-plazo-select">Avisar con al menos</label>
      <select id="le-plazo-select"></select>
    </div>
    <p class="tx-context__note">Cambiar esto no reescribe las cancelaciones ya registradas.</p>
    <p class="tx-status-line" id="le-plazo-estado" role="status" aria-live="polite"></p>
  </section>

  <!-- Cifras (§11) -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-le-cifras">
    <h2 id="tit-le-cifras">Cifras de esta demostración</h2>
    <dl class="tx-figure-list" id="le-cifras"></dl>
    <!-- (step 18 §0.5, enmienda E4) El reloj ya NO está congelado: desde
         step 18 se mueve a mano desde el Laboratorio, así que decir
         "congelado" era una mentira literal en pantalla en cuanto alguien
         pulsase "Avanzar". Lo que NO cambia es la consecuencia: aquí no pasa
         el tiempo solo, así que no se mide ni se muestra ninguna duración.
         Carácter a carácter igual que la clave "frozenClock" de la copia de
         la lista de espera, que es su única fuente de verdad. -->
    <p class="tx-context__note">El reloj de esta demostración es sintético y sólo avanza cuando tú lo mueves en el Laboratorio. Aquí no pasa el tiempo solo, así que no se puede medir cuánto tarda en cubrirse un hueco y no se muestra ninguna cifra de tiempo.</p>
  </section>

  <!-- Bloque 5 -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-le-tecnico">
    <h2 id="tit-le-tecnico">Cómo funciona esto por dentro</h2>
    <details class="tx-details">
      <summary>Detalle técnico</summary>
      <div class="tx-details__body">
        <h3>Estados internos de una entrada</h3>
        <p>pending · matched · notice_simulated · accepted · declined · expired_manually · converted · withdrawn</p>
        <h3>Códigos de incompatibilidad</h3>
        <p>date_outside_preferred_range · time_outside_preferred_window · different_professional_requested · professional_cannot_perform_service · date_outside_booking_horizon · slot_in_the_past · slot_no_longer_free</p>
        <h3>Identificador de hueco (slotKey)</h3>
        <p>slot-&lt;fecha&gt;-&lt;minuto de inicio&gt;-&lt;identificador de profesional&gt;</p>
        <h3>Claves de idempotencia que acuña esta pantalla</h3>
        <p>convert:&lt;entryId&gt;:&lt;slotKey&gt; · cancel:&lt;reservationId&gt;</p>
        <p>Se envían en la cabecera Idempotency-Key. La respuesta contesta con Idempotency-Status: original o replayed; cuando dice replayed, la consola no vuelve a cantar la acción como recién hecha.</p>
        <h3>Historial estructurado de la lista de espera <span id="le-tecnico-historial-contador"></span></h3>
        <ul id="le-tecnico-historial"></ul>
        <!-- (step 18 §0.5, enmienda E2) De las tres piezas que esta frase daba
             por futuras, dos existen desde step 18 y una sigue sin existir.
             Carácter a carácter igual que WAITLIST_COPY.futureDesign. -->
        <p>Los depósitos siguen siendo diseño futuro, no implementado. Las inasistencias y las reservas para varias personas ya existen en esta demostración, en su forma más conservadora: se anotan a mano, no aplican ninguna penalización y no cambian a quién encaja en un hueco liberado.</p>
      </div>
    </details>
  </section>
</section>

<!-- ================================================================ -->
<!-- LLAMADAS                                                          -->
<!-- ================================================================ -->
<section id="vista-llamadas" class="tx-view" hidden>
  <div class="tx-filter-bar tx-col-12" role="group" aria-label="Filtrar llamadas">
    <button type="button" class="tx-filter" data-filter="todas" aria-pressed="true">Todas <span id="filtro-todas-n"></span></button>
    <button type="button" class="tx-filter" data-filter="atencion" aria-pressed="false">Necesitan atención <span id="filtro-atencion-n"></span></button>
    <button type="button" class="tx-filter" data-filter="reserva" aria-pressed="false">Con reserva <span id="filtro-reserva-n"></span></button>
    <button type="button" class="tx-filter" data-filter="derivadas" aria-pressed="false">Derivadas <span id="filtro-derivadas-n"></span></button>
    <button type="button" class="tx-filter" data-filter="error" aria-pressed="false">Con error <span id="filtro-error-n"></span></button>
  </div>

  <div class="tx-panel tx-col-12">
    <div class="tx-table-scroll" tabindex="0" role="region" aria-label="Tabla de llamadas">
      <table class="tx-table tx-table--stack">
        <caption class="tx-visually-hidden">Llamadas atendidas por el asistente sintético</caption>
        <thead>
          <tr>
            <th scope="col">Hora</th>
            <th scope="col">Qué pedía</th>
            <th scope="col">Resultado</th>
            <th scope="col">Qué hay que hacer</th>
            <th scope="col"><span class="tx-visually-hidden">Detalle</span></th>
          </tr>
        </thead>
        <tbody id="llamadas-tbody"></tbody>
      </table>
    </div>
    <div class="tx-empty" id="llamadas-vacio" hidden>
      <p class="tx-empty__title">Todavía no hay llamadas.</p>
      <p class="tx-empty__body">Cuando el asistente atienda una llamada de la demostración, aparecerá aquí.</p>
    </div>
    <div class="tx-empty" id="llamadas-vacio-filtro" hidden>
      <p class="tx-empty__title">Ninguna llamada en este filtro.</p>
      <p class="tx-empty__body">Prueba con "Todas".</p>
    </div>
  </div>

  <article class="tx-call-detail" id="llamada-detalle" hidden aria-labelledby="llamada-detalle-titulo">
    <div class="tx-call-detail__head">
      <h2 id="llamada-detalle-titulo" tabindex="-1"></h2>
      <button type="button" class="tx-btn tx-btn--ghost" id="llamada-detalle-cerrar">Cerrar</button>
    </div>
    <div id="llamada-detalle-pill"></div>
    <div id="llamada-detalle-orfana" class="tx-orphan-warning" hidden></div>
    <div>
      <h3>Qué pasó</h3>
      <p id="llamada-detalle-que-paso"></p>
    </div>
    <div>
      <h3>Lo que pidió el cliente</h3>
      <p id="llamada-detalle-intencion"></p>
    </div>
    <div>
      <h3>¿Se dijo al cliente que estaba confirmada?</h3>
      <p id="llamada-detalle-anuncia"></p>
    </div>
    <details class="tx-details">
      <summary>Detalle técnico</summary>
      <div class="tx-details__body">
        <dl id="llamada-detalle-tecnico"></dl>
        <button type="button" class="tx-btn tx-btn--secondary" id="llamada-copiar-hash">Copiar el identificador</button>
        <p class="tx-status-line" id="llamada-copiar-estado" role="status" aria-live="polite"></p>
      </div>
    </details>
  </article>
</section>

<!-- ================================================================ -->
<!-- HORARIOS Y AUSENCIAS                                              -->
<!-- ================================================================ -->
<!-- step 26 REAPERTURA §R1 — esta sección se llamaba "Calendario". La RUTA
     y la ETIQUETA cambian; los identificadores internos "calendario-*" se
     CONSERVAN a propósito (§R1 "Qué queda prohibido", F7): renombrarlos
     rompería catorce ficheros de prueba sin comprar ninguna verdad. Queda
     anotado como deuda cosmética (D-3 del runbook). -->
<section id="vista-horarios-y-ausencias" class="tx-view" hidden>
  <!-- step 26 REAPERTURA §R2 — hermano de #agenda-aviso-ruta, no su
       sustituto: dice que una parte de la dirección no se ha entendido. -->
  <p class="tx-status-line tx-col-12" id="horarios-aviso-ruta" hidden>No se ha entendido parte de la dirección. Se muestra el mes de hoy.</p>

  <!-- ============================================================ -->
  <!-- Bloque 1 (REAPERTURA §R7) — Horario habitual: CONSULTA (§R12) -->
  <!-- ============================================================ -->
  <!-- §R12 — se ha evaluado editar el horario semanal desde aquí y la
       respuesta es NO: \`WeeklySchedule\` es el único registro del modelo sin
       id, sin approval y sin audit, así que un cambio nacería aprobado por
       construcción, sin poder retirarse y sin historial; y su preview sería
       engañoso, porque un horario semanal no tiene fechas. Esto es una
       CONSULTA, no un formulario apagado: por eso no hay aquí ni un control
       deshabilitado que sugiera que algún día se encenderá solo. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-horario-habitual">
    <h2 id="tit-horario-habitual">Horario habitual</h2>
    <p class="tx-context__note" id="horarios-regimen"></p>
    <ul class="tx-week-strip" id="horarios-semana"></ul>
    <p class="tx-status-line" id="horarios-semana-nota">Este horario es el de siempre y no se cambia desde aquí. Para un día suelto usa «Añadir cierre o día especial». Para una temporada entera —el horario de agosto, por ejemplo— hace falta una revisión aparte, porque un horario sin fechas se quedaría puesto para siempre sin que nadie lo volviera a mirar.</p>
  </section>

  <!-- ============================================================ -->
  <!-- Bloque 2 (§R7) — Días especiales y cierres                     -->
  <!-- ============================================================ -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-dias-especiales">
    <h2 id="tit-dias-especiales" tabindex="-1">Días especiales y cierres</h2>
    <div class="tx-panel tx-panel--notice" id="calendario-temporada" hidden>
      <h3 id="calendario-temporada-titulo"></h3>
      <p id="calendario-temporada-detalle"></p>
      <p id="calendario-temporada-aviso-fecha"></p>
      <p class="tx-status-line">Duplicar esta temporada para otro año todavía no se hace desde esta pantalla.</p>
    </div>

    <div class="tx-controls">
      <div class="tx-btn-row">
        <a class="tx-btn tx-btn--secondary" href="#/horarios-y-ausencias" id="calendario-mes-anterior">‹ Mes anterior</a>
        <span id="calendario-mes-titulo"></span>
        <a class="tx-btn tx-btn--secondary" href="#/horarios-y-ausencias" id="calendario-mes-siguiente">Mes siguiente ›</a>
      </div>
      <button type="button" class="tx-btn tx-btn--primary" id="btn-abrir-dia-especial">Añadir cierre o día especial</button>
    </div>

    <div class="tx-table-scroll" tabindex="0" role="region" aria-label="Rejilla del mes">
      <table class="tx-month-grid" id="calendario-grid">
        <caption class="tx-visually-hidden">Rejilla del mes visible del calendario</caption>
        <thead>
          <tr>
            <th scope="col"><abbr title="lunes">lun</abbr></th>
            <th scope="col"><abbr title="martes">mar</abbr></th>
            <th scope="col"><abbr title="miércoles">mié</abbr></th>
            <th scope="col"><abbr title="jueves">jue</abbr></th>
            <th scope="col"><abbr title="viernes">vie</abbr></th>
            <th scope="col"><abbr title="sábado">sáb</abbr></th>
            <th scope="col"><abbr title="domingo">dom</abbr></th>
          </tr>
        </thead>
        <tbody id="calendario-grid-body"></tbody>
      </table>
    </div>
    <div class="tx-legend">
      <span>Cerrado = ese día el local no abre</span>
      <span>▲ = Festivo o día especial</span>
      <!-- step 26 REAPERTURA §R3 — aquí había una cuarta línea con el
           contador de reservas del día. Esta pantalla habla de HORARIOS: la
           única cuadrícula mensual de citas de toda la consola es Agenda ›
           Mes, que además enlaza cada día con su agenda. -->
      <span>◆ = Alguien del equipo no está</span>
    </div>

    <h3>Cierres y días especiales de este mes</h3>
    <ul class="tx-day-list" id="horarios-excepciones-mes"></ul>
    <div class="tx-empty" id="horarios-excepciones-mes-vacio" hidden>
      <p class="tx-empty__title">Este mes no tiene ningún cierre ni día especial.</p>
      <p class="tx-empty__body">Todos los días abren con el horario que toque.</p>
    </div>
  </section>

  <!-- ============================================================ -->
  <!-- Bloque 3 (§R7/§R8) — Ausencias del equipo                      -->
  <!-- ============================================================ -->
  <!-- §R8 — la creación, la edición y la retirada de ausencias viven SÓLO
       aquí. Equipo conserva la LECTURA («Ausencias próximas») y un enlace a
       esta pantalla; no se duplica edición en dos sitios. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-ausencias-equipo">
    <h2 id="tit-ausencias-equipo" tabindex="-1">Ausencias del equipo</h2>
    <div class="tx-controls">
      <div class="tx-field">
        <label for="horarios-filtro-profesional">Profesional</label>
        <select id="horarios-filtro-profesional"><option value="">Todos</option></select>
      </div>
      <button type="button" class="tx-btn tx-btn--primary" id="btn-abrir-ausencia">Añadir ausencia</button>
    </div>
    <ul class="tx-day-list" id="horarios-ausencias"></ul>
    <!-- V3-2 — este vacío decía «No hay ninguna ausencia apuntada», y la
         rejilla de arriba podía estar enseñando rombos de ausencia en el mismo
         momento: esta lista es DE HOY EN ADELANTE y además está filtrada por
         profesional, mientras que la rejilla pinta el mes que se esté mirando,
         pasado incluido. Se dice qué ventana es la de esta lista y dónde están
         las demás, para que las dos zonas dejen de contradecirse. -->
    <div class="tx-empty" id="horarios-ausencias-vacio" hidden>
      <p class="tx-empty__title">No hay ninguna ausencia apuntada de hoy en adelante.</p>
      <p class="tx-empty__body">Las que ya han terminado siguen apuntadas: están en «Lo que ya ha pasado», al final de la pantalla. Si has filtrado por profesional, sólo se cuentan las suyas.</p>
    </div>
  </section>

  <!-- ============================================================ -->
  <!-- Bloque 4 (§R7) — Próximas excepciones                          -->
  <!-- ============================================================ -->
  <!-- §R7 — sale de los ARRAYS TIPADOS de la instantánea (closures,
       venueRules, absences), nunca de \`snap.calendar.auditLog\`, que es prosa
       española y vive sólo en Laboratorio. -->
  <!-- V3-2 — EL CALLEJÓN SIN SALIDA. Este bloque listaba lo que venía por
       delante, pero SIN «Retirar»: sólo abría el detalle. Y las excepciones
       aprobadas que caían fuera del alcance de los otros dos bloques —una
       ausencia ya terminada, un cierre de un año futuro que no fuera el mes
       visible— no aparecían en NINGUNA lista con un botón de retirar, y sin
       embargo quemaban su identificador: el operador se encontraba un 409 que
       le pedía otro nombre por culpa de algo que no podía ni ver ni deshacer.
       Ahora este bloque lista todos los CIERRES, DÍAS ESPECIALES y AUSENCIAS
       aprobados con fin >= hoy, con año en el rótulo cuando no es el año en
       curso y con sus dos botones; y lo que ya pasó vive, entero, en el
       plegable de abajo. Ninguna de esas tres queda sin una vía para
       retirarla. Las TEMPORADAS (\`seasonalSchedules\`) no salen aquí y no es un
       olvido: no se crean desde esta consola, así que no pueden quemar un
       identificador ni dejar a nadie encerrado, y la que esté vigente ya se
       anuncia en su propio aviso de temporada, arriba. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-proximas-excepciones">
    <h2 id="tit-proximas-excepciones" tabindex="-1">Próximas excepciones</h2>
    <p class="tx-status-line" id="horarios-proximas-alcance">Todo lo apuntado que no haya terminado todavía, sin importar el mes que estés mirando arriba.</p>
    <ul class="tx-day-list" id="calendario-dias-distintos"></ul>
    <div class="tx-empty" id="calendario-dias-distintos-vacio" hidden>
      <p class="tx-empty__title">Nada distinto por delante.</p>
      <p class="tx-empty__body">Los próximos días siguen el horario de siempre.</p>
    </div>

    <details class="tx-details" id="horarios-anteriores">
      <summary id="tit-excepciones-anteriores">Lo que ya ha pasado</summary>
      <p class="tx-status-line">Sigue apuntado y sigue contando: mientras esté aquí, su nombre está ocupado. Se puede retirar desde aquí igual que cualquier otro.</p>
      <ul class="tx-day-list" id="calendario-excepciones-anteriores"></ul>
      <div class="tx-empty" id="calendario-excepciones-anteriores-vacio" hidden>
        <p class="tx-empty__title">No queda nada atrás.</p>
        <p class="tx-empty__body">Ninguna excepción apuntada ha terminado todavía.</p>
      </div>
    </details>
  </section>
</section>

<!-- ================================================================ -->
<!-- EQUIPO                                                            -->
<!-- ================================================================ -->
<section id="vista-equipo" class="tx-view" hidden>
  <div class="tx-panel tx-panel--notice tx-col-12">
    <p>Las personas de esta lista son inventadas para la demostración. No corresponden a nadie del equipo real de Demo Salon.</p>
  </div>
  <section class="tx-panel tx-col-12" aria-labelledby="tit-equipo-horario">
    <h2 id="tit-equipo-horario">Horario del local</h2>
    <p class="tx-context__note" id="equipo-horario-regimen"></p>
    <ul class="tx-week-strip" id="equipo-horario-dias"></ul>
    <p><a class="tx-btn tx-btn--secondary" href="#/horarios-y-ausencias">Ver horarios y ausencias</a></p>
  </section>
  <div class="tx-col-12 tx-pro-grid" id="equipo-fichas"></div>
  <div class="tx-empty tx-col-12" id="equipo-vacio" hidden>
    <p class="tx-empty__title">No hay ningún profesional en el calendario.</p>
  </div>
</section>

<!-- ================================================================ -->
<!-- LABORATORIO                                                       -->
<!-- ================================================================ -->
<section id="vista-laboratorio" class="tx-view" hidden>
  <div class="tx-panel tx-panel--notice tx-col-12">
    <p>Esta sección es para enseñar y depurar el motor. Lo que se ejecute aquí aparecerá en el resto de la consola como si fueran llamadas reales de la demostración.</p>
  </div>

  <!-- step 19 §5.1/§5.3 — 3B «Guion en pantalla para enseñar la demostración».
       Va PRIMERO, antes del resumen: es lo que se abre ANTES de empezar. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-guion">
    <h2 id="tit-lab-guion">Guion en pantalla para enseñar la demostración</h2>
    <!-- step 19 §5.3.2 (revisión adversarial de la capacidad 3, hallazgo m4):
         texto ESTÁTICO, para que exista aunque el motor no conteste — mismo
         patrón que el rótulo permanente del resumen (§5.2.5). El cliente ya
         no lo pinta: es chorro permanente, no una línea transitoria. -->
    <!-- (revisión adversarial de la capacidad 3, hallazgo M3/m7) Ninguna de
         las tres líneas de este bloque es "el resultado de una acción que
         inicia el operador" (§9.5): el aviso es texto ESTÁTICO que no cambia
         nunca, la luz de precondición y la línea de progreso (más abajo) se
         REPINTAN en cada sondeo de 2 s a partir de lo que el mundo YA
         demuestra — justo lo que §9.4/§9.5 prohíben en un contador. Ninguna
         de las tres lleva ya \`role\`/\`aria-live\`. -->
    <p class="tx-status-line tx-status-line--conflict" id="lab-guion-aviso">${GUIDE_COPY.resetWarning}</p>
    <p class="tx-status-line" id="lab-guion-precondicion"></p>
    <button type="button" class="tx-btn tx-btn--secondary" id="lab-guion-ir-a-reiniciar">Ir a «Reiniciar la demostración»</button>
    <fieldset class="tx-slot-card__choice">
      <legend>Qué guion vas a enseñar</legend>
      <div class="tx-radio-field">
        <input type="radio" name="lab-guion-elegido" id="lab-guion-radio-1" value="guion-1">
        <label for="lab-guion-radio-1">Guion 1 · Inasistencias y reserva para varias personas</label>
      </div>
      <div class="tx-radio-field">
        <input type="radio" name="lab-guion-elegido" id="lab-guion-radio-2" value="guion-2">
        <label for="lab-guion-radio-2">Guion 2 · Lista de espera y cancelaciones</label>
      </div>
    </fieldset>
    <p class="tx-status-line" id="lab-guion-sin-elegir">Elige el guion que vas a enseñar.</p>
    <div id="lab-guion-contenido" hidden>
      <h3 id="lab-guion-titulo"></h3>
      <ol class="tx-guion-pasos" id="lab-guion-pasos"></ol>
      <p class="tx-status-line" id="lab-guion-progreso"></p>
    </div>
    <p class="tx-context__note">Ningún paso se marca por visitar una pantalla ni por pulsar nada aquí. Se marca cuando el estado de la demostración lo demuestra, y sólo entonces.</p>
  </section>

  <!-- step 19 §5.1/§5.2 — 3A «Resumen para revisar con Bruno». Va DESPUÉS del
       guion: es lo que se enseña AL FINAL, y tenerlo pegado al guion evita ir
       a buscarlo. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-resumen">
    <h2 id="tit-lab-resumen">Resumen para revisar con Bruno</h2>
    <!-- §5.2.5: texto ESTÁTICO, para que exista aunque el motor no conteste.
         Una prueba lo compara carácter a carácter con la constante del servidor. -->
    <p class="tx-permanent-label">Demo local · Datos sintéticos · No es evidencia de un piloto real</p>
    <p class="tx-context__note">Todas estas cifras salen de los registros de esta demostración. No hay ningún contador aparte que pueda mentir, y no hay ni una cifra calculada en esta pantalla.</p>
    <p id="lab-resumen-reloj"></p>
    <p id="lab-resumen-fixture"></p>
    <div id="lab-resumen-bloques"></div>
    <details class="tx-details">
      <summary>Qué NO sale en este resumen, y por qué</summary>
      <div class="tx-details__body">
        <p>Tiempo hasta cubrir un hueco, tiempo de espera o cualquier duración: el reloj es sintético y sólo se mueve a mano, así que no pasa el tiempo que se pudiera medir.</p>
        <p>Latencia o tiempo de respuesta: el motor no emite ninguna medida de latencia.</p>
        <p>Porcentajes, tasas de conversión, objetivos o tendencias: sobre una muestra sintética no significan nada.</p>
        <p>Puntuaciones, rankings, umbrales o semáforos: inventarían una prioridad y una clasificación de personas que nadie ha decidido.</p>
        <p>Dinero, depósitos o penalizaciones: no existen en esta demostración.</p>
        <p>Inasistencias por persona: el registro va pegado a la cita, no a nadie.</p>
        <p>«Llamadas que se habrían perdido»: es un contrafactual, y no hay dato que lo pruebe.</p>
        <p>Un total conjunto de reservas: las tres cifras de reservas de este resumen nunca se suman.</p>
        <!-- step 19 §5.2.3 (revisión adversarial de la capacidad 3, hallazgo
             m6): las tres filas que faltaban — medidas que SÍ existen, y son
             canónicas, y aun así se omiten aquí a propósito. -->
        <p>Minutos de agenda liberados que siguen sin cubrir (<code>unfilledReleasedSlotMinutes</code>): existe y es canónica, pero cuenta minutos de AGENDA, no de reloj. En un texto para copiar y pegar en un correo, esa ambigüedad se leería como «tiempo que tardó», y eso sería mentira.</p>
        <p>Acciones que ha necesitado una persona, de la lista de espera (<code>actionsRequiringAPerson</code>): se solapa con «Tareas pendientes para una persona» (A6) sin ser lo mismo, y dos cifras de «acciones humanas» una al lado de otra invitarían a una resta que no significa nada.</p>
        <p>Las alarmas de integridad de la lista de espera y de operaciones: no son medidas de esta demostración, son alarmas. Se quedan donde ya se ven, en rojo, si fallan.</p>
      </div>
    </details>
    <button type="button" class="tx-btn tx-btn--primary" id="lab-resumen-copiar">Copiar resumen</button>
    <p class="tx-status-line" id="lab-resumen-copiar-estado" role="status" aria-live="polite"></p>
    <textarea class="tx-resumen-respaldo" id="lab-resumen-respaldo" readonly hidden aria-label="Texto del resumen, para copiarlo a mano"></textarea>
  </section>

  <!-- step 20 §3 — «Taller de decisiones con Bruno» (D20-18): el TERCER panel
       del Laboratorio, entre el resumen (lo que se enseña al final de la
       demostración) y el reloj (instrumental). Los tres paneles de cara a
       Bruno quedan contiguos y en el orden cronológico de la reunión.
       El encabezado, el aviso permanente y las frases del §8.1 son HTML
       ESTÁTICO servido (criterio m4 de step 19: existen aunque el motor no
       conteste) e interpolan la constante del servidor, así que no pueden
       divergir de ella. Las tarjetas las construye el cliente desde
       snap.demo.decisionWorkshop; aquí sólo viven los contenedores. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-taller">
    <h2 id="tit-lab-taller">${WORKSHOP_COPY.heading}</h2>
    <p class="tx-permanent-label">${WORKSHOP_COPY.permanentLabel}</p>
    <p class="tx-context__note">${WORKSHOP_COPY.introNote}</p>
    <p class="tx-context__note">${WORKSHOP_COPY.draftNote}</p>
    <p class="tx-context__note">${WORKSHOP_COPY.resetNote}</p>
    <p class="tx-context__note">${WORKSHOP_COPY.conservativeNote}</p>
    <p class="tx-context__note">${WORKSHOP_COPY.orderNote}</p>
    <div class="tx-filter-bar" role="group" aria-label="Filtrar las decisiones del taller">
      <button type="button" class="tx-filter" id="tx-taller-filtro-todas" aria-pressed="true">Todas</button>
      <button type="button" class="tx-filter" id="tx-taller-filtro-bloquean" aria-pressed="false">Bloquean un piloto</button>
      <button type="button" class="tx-filter" id="tx-taller-filtro-esperan" aria-pressed="false">Pueden esperar</button>
      <button type="button" class="tx-filter" id="tx-taller-filtro-sin-respuesta" aria-pressed="false">Sin respuesta</button>
      <button type="button" class="tx-filter" id="tx-taller-filtro-anotadas" aria-pressed="false">Con borrador anotado</button>
    </div>
    <p class="tx-context__note">${WORKSHOP_COPY.overlappingFiltersNote}</p>
    <!-- (Revisión U11-12) La decisión del §3.11 punto 1 —marcar no re-filtra—
         era invisible y parecía un fallo: se declara en permanente. -->
    <p class="tx-context__note">${WORKSHOP_COPY.noRefilterNote}</p>
    <div class="tx-field">
      <label for="tx-taller-buscar">Buscar en el catálogo</label>
      <input type="search" id="tx-taller-buscar" autocomplete="off">
    </div>
    <p class="tx-context__note">${WORKSHOP_COPY.searchScopeNote}</p>
    <!-- §3.11: la ÚNICA región viva nueva del panel. Sólo la escribe
         setEstadoLinea, por suceso, nunca por sondeo; con tabindex="-1"
         porque es a donde va el foco si un filtro oculta la tarjeta
         enfocada. NO entra en REGIONES_TRANSITORIAS (§6.4): sigue siendo
         cierta tras el reinicio, mismo motivo que sacó a lab-tareas-estado. -->
    <p class="tx-status-line" id="tx-taller-estado" role="status" aria-live="polite" tabindex="-1"></p>
    <!-- §3.10 (D20-31): recuentos de cobertura, SIN role y SIN aria-live —
         se repintan con cada marca de radio y una segunda locución encima de
         la del propio radio rompería la regla de una sola por turno. -->
    <div id="tx-taller-cobertura">
      <p></p>
      <p></p>
      <p></p>
    </div>
    <p class="tx-context__note">${WORKSHOP_COPY.coverage.meaningNote}</p>
    <div class="tx-empty" id="tx-taller-vacio">
      <p class="tx-empty__title">${WORKSHOP_COPY.emptyStateNote}</p>
    </div>
    <div id="tx-taller-lista" hidden></div>
    <!-- step 20 §4/§5 (fase 7) — las DOS acciones de copia, separadas a
         propósito: el acta registra la conversación, el borrador propone
         trabajo (D20-40). Cada una con su botón, su línea de estado (región
         viva: es el resultado directo de una acción del operador, §3.11
         punto 5; las dos entran en REGIONES_TRANSITORIAS, §6.4) y su
         <textarea> de respaldo, que la secuencia de reinicio vacía y oculta
         aparte (D20-28). Los rótulos interpolan la constante servida, así
         que no pueden divergir de ella. -->
    <button type="button" class="tx-btn tx-btn--primary" id="tx-taller-copiar-acta">${ACTA_COPY.buttonTag}</button>
    <p class="tx-status-line" id="tx-taller-acta-estado" role="status" aria-live="polite"></p>
    <textarea class="tx-resumen-respaldo" id="tx-taller-acta-respaldo" readonly hidden aria-label="${ACTA_COPY.backupAria}"></textarea>
    <button type="button" class="tx-btn tx-btn--primary" id="tx-taller-copiar-mision">${MISION_COPY.buttonTag}</button>
    <p class="tx-status-line" id="tx-taller-mision-estado" role="status" aria-live="polite"></p>
    <textarea class="tx-resumen-respaldo" id="tx-taller-mision-respaldo" readonly hidden aria-label="${MISION_COPY.backupAria}"></textarea>
    <button type="button" class="tx-btn tx-btn--secondary" id="tx-taller-borrar-todo">${WORKSHOP_COPY.dialog.title}</button>
  </section>

  <!-- step 18 §3.5 / §5.6 — El reloj de la demostración. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-reloj">
    <h2 id="tit-lab-reloj">Reloj de la demostración</h2>
    <p class="tx-context__note">Solo afecta a esta demostración local.</p>
    <p id="lab-reloj-ahora"></p>
    <p class="tx-context__note">Sólo avanza cuando lo mueves tú.</p>
    <p class="tx-context__note">No puede retroceder. Para volver al principio, reinicia la demostración.</p>
    <p class="tx-context__note">Esto es sólo de la demostración local: no cambia la hora de tu ordenador ni la de ningún sistema.</p>
    <p class="tx-context__note">Mover el reloj no anota ninguna inasistencia: sólo hace que se pueda anotar.</p>
    <!-- El aviso de los huecos que quedan atrás (§3.3). Se lee de la
         instantánea, no se escribe aquí, y está a la vista ANTES de avanzar. -->
    <p class="tx-context__note" id="lab-reloj-aviso"></p>
    <div class="tx-controls">
      <div class="tx-field">
        <label for="lab-reloj-salto">Avanzar</label>
        <select id="lab-reloj-salto">
          <option value="">(elige cuánto)</option>
          <option value="30">+30 min</option>
          <option value="60">+1 hora</option>
          <option value="120">+2 horas</option>
          <option value="240">+4 horas</option>
        </select>
      </div>
      <div class="tx-field">
        <label for="lab-reloj-cita">O hasta el final de esta cita</label>
        <select id="lab-reloj-cita"><option value="">(elige una cita de hoy)</option></select>
      </div>
      <button type="button" class="tx-btn tx-btn--primary" id="lab-reloj-avanzar" disabled aria-describedby="lab-reloj-gate">Avanzar el reloj</button>
    </div>
    <p class="tx-status-line" id="lab-reloj-gate">El botón no se activa hasta que elijas un salto o una cita. Elegir una de las dos cosas deja la otra sin elegir: nunca hay dos órdenes a la vez.</p>
    <p class="tx-status-line" id="lab-reloj-estado" role="status" aria-live="polite"></p>
  </section>

  <!-- step 18 §4.13 — Ejemplos de reserva para varias personas. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-grupo">
    <h2 id="tit-lab-grupo">Reservas para varias personas (ejemplos)</h2>
    <p class="tx-context__note">Cada botón rellena el diálogo con un ejemplo y lo abre. Confirmar sigue siendo cosa tuya: ninguno de estos botones crea una cita por su cuenta.</p>
    <div class="tx-btn-row">
      <button type="button" class="tx-btn tx-btn--secondary" id="lab-grupo-consecutivas">2 consecutivas con servicios distintos</button>
      <button type="button" class="tx-btn tx-btn--secondary" id="lab-grupo-simultaneas">2 simultáneas con profesionales distintos</button>
      <button type="button" class="tx-btn tx-btn--secondary" id="lab-grupo-conflicto">Conflicto: alguien ocupa el hueco antes de confirmar</button>
      <button type="button" class="tx-btn tx-btn--secondary" id="lab-grupo-imposible">Simultáneas con la misma persona del equipo (imposible)</button>
    </div>
    <p class="tx-context__note">El tercero prepara la propuesta y deja preparado el botón de abajo, que es el que ocupa el hueco antes de que confirmes.</p>
    <div class="tx-btn-row">
      <button type="button" class="tx-btn tx-btn--secondary" id="lab-grupo-ocupar" disabled aria-describedby="lab-grupo-estado">Ocupar ahora el primer hueco de la propuesta (simulado)</button>
    </div>
    <p class="tx-status-line" id="lab-grupo-estado" role="status" aria-live="polite"></p>
  </section>

  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-escenario">
    <h2 id="tit-lab-escenario">Ejecutar un escenario</h2>
    <form id="form-escenario">
      <div class="tx-field">
        <label for="ejemplo-escenario">Ejemplo</label>
        <select id="ejemplo-escenario"></select>
      </div>
      <div class="tx-field">
        <label for="campo-scenario-id">Identificador de escenario</label>
        <input type="text" id="campo-scenario-id" name="scenarioId">
        <span class="tx-status-line">Tiene que empezar por A y dos cifras. Por ejemplo: A20-mi-escenario.</span>
      </div>
      <div class="tx-field">
        <label for="campo-call-id">Identificador de llamada (opcional)</label>
        <input type="text" id="campo-call-id" name="callId">
      </div>
      <div class="tx-checkbox-field">
        <input type="checkbox" id="campo-transferencia-disponible" name="liveTransferAvailable" checked>
        <label for="campo-transferencia-disponible">Transferencia en vivo disponible</label>
      </div>
      <div class="tx-field">
        <label for="campo-turnos">Turnos (JSON)</label>
        <textarea id="campo-turnos" name="turns" rows="10"></textarea>
      </div>
      <button type="submit" class="tx-btn tx-btn--primary">Ejecutar escenario</button>
    </form>
    <p class="tx-status-line" id="lab-escenario-estado" role="status" aria-live="polite"></p>
    <div id="lab-escenario-resultado"></div>
  </section>

  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-eventos">
    <h2 id="tit-lab-eventos">Recuento de eventos</h2>
    <div class="tx-event-counts">
      <div>
        <h3>Flujo de piloto (congelado)</h3>
        <dl id="lab-eventos-pilot"></dl>
      </div>
      <div>
        <h3>Flujo interno</h3>
        <dl id="lab-eventos-internal"></dl>
      </div>
    </div>
    <p class="tx-latency-note">Latencia de respuesta — No se mide en esta demostración.<br>El motor no emite ninguna medida de latencia y no se inventa ninguna. Se medirá cuando exista una pasarela telefónica real.</p>
  </section>

  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-auditoria">
    <h2 id="tit-lab-auditoria">Historial de auditoría del calendario</h2>
    <ul id="lab-auditoria-lista"></ul>
    <div class="tx-empty" id="lab-auditoria-vacio" hidden>
      <p class="tx-empty__title">Todavía no se ha publicado ningún cambio de calendario.</p>
    </div>
  </section>

  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-waitlist">
    <h2 id="tit-lab-waitlist">Historial de la lista de espera</h2>
    <p class="tx-context__note">Son dos historiales distintos y se enseñan por separado a propósito: arriba, los cambios de calendario publicados; aquí, todo lo que ha pasado en la lista de espera, con su número de orden y su tipo de evento.</p>
    <ul id="lab-waitlist-lista"></ul>
    <div class="tx-empty" id="lab-waitlist-vacio" hidden>
      <p class="tx-empty__title">Todavía no ha pasado nada en la lista de espera.</p>
    </div>
  </section>

  <!-- step 18 §5.6 — El TERCER historial, aparte a propósito. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-operaciones">
    <h2 id="tit-lab-operaciones">Historial de operaciones de consola</h2>
    <p class="tx-context__note">Va aparte de los otros dos a propósito: con un reloj sintético, dos apuntes de registros distintos pueden compartir la misma hora, así que una lista "unificada" tendría un orden inventado.</p>
    <ul id="lab-operaciones-lista"></ul>
    <div class="tx-empty" id="lab-operaciones-vacio" hidden>
      <p class="tx-empty__title">Todavía no se ha anotado ninguna inasistencia ni creado ninguna reserva para varias personas.</p>
    </div>
  </section>

  <!-- step 19 §4.3 — El CUARTO historial: la misma cola humana que Inicio,
       vista entera. Va aquí, después del de operaciones y antes de su detalle
       técnico, porque Inicio contesta "¿qué hay que hacer ahora?" y esto
       contesta "¿qué se hizo?": meterlo en Inicio obligaría a que la pantalla
       operativa creciera hacia el archivo. -->
  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-tareas">
    <h2 id="tit-lab-tareas">Historial de tareas humanas</h2>
    <p class="tx-context__note">Es la misma cola que Inicio, vista entera. Inicio enseña sólo lo que sigue abierto; aquí está también lo que ya se resolvió.</p>
    <!-- (revisión adversarial de la capacidad 3, hallazgo M5) Reescrito: la
         frase anterior decía «se cierran solas» — la misma afirmación falsa
         que ya se corrigió en A6 (§7.6, hallazgo H3 de la revisión de la
         capacidad 2: las cierra una acción REAL de un operador, nunca un
         proceso que actúe "solo") pero que aquí, el sitio más importante,
         seguía sin corregir. También arreglaba la concordancia («solas» con
         «tipos», masculino) y acortaba una frase de tres subordinadas.
         (Revisión adversarial de misión completa, hallazgo BAJO 1.) Ya no es
         un literal repetido a mano: vive en HUMAN_TASK_LEDGER_COPY.aviso
         (snapshot.ts), la misma constante que dos citas del documento de
         decisiones ya nombraban antes de que existiera. -->
    <p class="tx-context__note">${HUMAN_TASK_LEDGER_COPY.aviso}</p>
    <div class="tx-filter-bar" role="group" aria-label="Filtrar tareas por estado">
      <button type="button" class="tx-filter" id="lab-tareas-filtro-pendientes" aria-pressed="true">Pendientes</button>
      <button type="button" class="tx-filter" id="lab-tareas-filtro-resueltas" aria-pressed="false">Resueltas</button>
      <button type="button" class="tx-filter" id="lab-tareas-filtro-todas" aria-pressed="false">Todas</button>
    </div>
    <div class="tx-field">
      <label for="lab-tareas-motivo">Motivo</label>
      <select id="lab-tareas-motivo"><option value="">Todos los motivos</option></select>
    </div>
    <ul class="tx-tarea-historial-list" id="lab-tareas-lista"></ul>
    <p class="tx-status-line" id="lab-tareas-estado" role="status" aria-live="polite"></p>
  </section>

  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-tecnico-operaciones">
    <h2 id="tit-lab-tecnico-operaciones">Cómo funcionan por dentro las inasistencias y las reservas para varias personas</h2>
    <details class="tx-details">
      <summary>Detalle técnico</summary>
      <div class="tx-details__body">
        <h3>Estados de un registro de inasistencia</h3>
        <p>recorded · corrected_not_a_no_show</p>
        <h3>Formas de una reserva para varias personas</h3>
        <p>consecutive · simultaneous</p>
        <h3>Códigos de conflicto</h3>
        <p>reservation_not_finished_yet · reservation_is_cancelled · no_show_already_corrected · slot_no_longer_free · slot_in_the_past · date_outside_booking_horizon · professional_cannot_perform_service · same_professional_twice_at_the_same_time · simultaneous_needs_one_professional_per_person · clock_cannot_go_backwards</p>
        <h3>Identificadores</h3>
        <p>nsh-&lt;identificador de cita&gt; · grp-NNNN · res-g-grp-NNNN-&lt;posición&gt;</p>
        <h3>Claves de idempotencia que acuña esta pantalla</h3>
        <p>noshow:&lt;cita&gt;:v&lt;revisión&gt; · noshow-fix:&lt;cita&gt;:v&lt;revisión&gt; · group:&lt;fecha&gt;:&lt;forma&gt;:&lt;líneas&gt;:r&lt;n&gt;</p>
        <p>Las tres las resuelve el servidor y viajan resueltas en la instantánea: esta pantalla no deriva ninguna clave y no acuña ninguna identidad.</p>
        <p id="lab-tecnico-endpoint"></p>
        <p>Avanzar un número de minutos no lleva clave de idempotencia porque es un incremento: repetirlo tiene que volver a avanzar. Avanzar hasta el final de una cita es absoluto, así que repetirlo devuelve un conflicto de reloj y no mueve nada.</p>
      </div>
    </details>
  </section>

  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-mapeo">
    <h2 id="tit-lab-mapeo">Qué dice el contrato congelado y qué hace esta demostración</h2>
    <div class="tx-table-scroll" tabindex="0" role="region" aria-label="Tabla de correspondencia con el contrato congelado">
      <table class="tx-table tx-table--stack">
        <caption class="tx-visually-hidden">Correspondencia entre el contrato congelado del piloto y lo que hace la lista de espera</caption>
        <thead>
          <tr>
            <th scope="col">Hecho</th>
            <th scope="col">Qué dice el contrato congelado</th>
            <th scope="col">Qué hace esta demostración</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Hecho">Un cliente pide cancelar por teléfono</td>
            <td data-label="Qué dice el contrato congelado">CANCEL_OR_CHANGE_NOT_ENABLED → DERIVA. Sigue exactamente igual: el agente no cancela nada.</td>
            <td data-label="Qué hace esta demostración">Nada. La lista de espera no participa en la llamada.</td>
          </tr>
          <tr>
            <td data-label="Hecho">Un operador cancela una cita en la consola</td>
            <td data-label="Qué dice el contrato congelado">El contrato congelado no dice nada: no es una llamada.</td>
            <td data-label="Qué hace esta demostración">Registra RESERVATION_CANCELLED_ON_TIME o _LATE, un evento propio, sin ningún reasonCode del piloto.</td>
          </tr>
          <tr>
            <td data-label="Hecho">Un cliente pide apuntarse a la lista por teléfono</td>
            <td data-label="Qué dice el contrato congelado">No existe en el contrato v1.</td>
            <td data-label="Qué hace esta demostración">No se simula en el motor. El operador la registra a mano, indicando de dónde vino el alta.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-inyeccion">
    <h2 id="tit-lab-inyeccion">Inyectar un fallo en la conversión</h2>
    <div class="tx-checkbox-field">
      <input type="checkbox" id="lab-inyectar-fallo-conversion">
      <label for="lab-inyectar-fallo-conversion">La próxima conversión de la lista de espera fallará a propósito</label>
    </div>
    <p class="tx-context__note">Sirve para enseñar que un fallo no escribe nada: ni reserva, ni cambio de estado. El interruptor se queda puesto hasta que lo quites tú.</p>
  </section>

  <section class="tx-panel tx-col-12" aria-labelledby="tit-lab-json">
    <h2 id="tit-lab-json">Instantánea en crudo</h2>
    <details class="tx-details">
      <summary>Ver el JSON de /api/snapshot</summary>
      <div class="tx-details__body"><pre class="tx-raw-json" id="lab-json"></pre></div>
    </details>
  </section>

  <section class="tx-panel tx-danger-zone tx-col-12" aria-labelledby="tit-lab-reset">
    <h2 id="tit-lab-reset">Zona destructiva</h2>
    <p>Borra todas las llamadas, reservas, tareas, avisos, errores y cambios de calendario de esta demostración.</p>
    <button type="button" class="tx-btn tx-btn--danger" id="btn-abrir-reset">Reiniciar la demostración</button>
  </section>
</section>

</main>
</div>
</div>

<!-- ================================================================ -->
<!-- Diálogo: añadir un cierre o un día especial (REAPERTURA §R9)      -->
<!-- ================================================================ -->
<!-- §R9 — CUATRO pasos: qué quieres hacer → cuándo → repaso → hecho. El
     paso 1 no preselecciona nada (I3, step 19 §3): el sistema no elige por
     nadie. Aquí vivía, hasta esta reapertura, la frase «abrir el local con un
     horario distinto todavía no se hace desde esta pantalla»; se ha borrado
     porque HA DEJADO DE SER VERDAD. Lo que sigue siendo verdad —que el
     horario especial vale para todo el equipo, y para un solo día— se dice
     con palabras, no con un campo apagado.
     PROHIBIDO llamar «cierre parcial» a un horario especial: un
     special_opening ABRE el local con otras horas, y llamarlo cierre sería
     mentirle al operador sobre lo que acaba de publicar. -->
<dialog class="tx-dialog" id="dialogo-dia-especial" aria-labelledby="dialogo-dia-especial-titulo">
  <h2 class="tx-dialog__title" id="dialogo-dia-especial-titulo" tabindex="-1">Añadir un cierre o un día especial</h2>
  <!-- La línea de error vive FUERA de los pasos, a propósito: es la misma
       región transitoria (\`dia-especial-paso1-error\`) para los dos pasos que
       validan, y así no hace falta una región nueva por paso. -->
  <p class="tx-status-line tx-status-line--error" id="dia-especial-paso1-error" role="alert"></p>
  <!-- §R13 (V3-6) — la segunda mitad de un «Cambiar» ya con la retirada
       publicada. Vive AQUÍ, fuera de los pasos, porque cuando este diálogo se
       abre precargado abre directamente en el paso 2 (más abajo): si el aviso
       viviera dentro de un paso concreto, el operador podría llegar a un
       «Cancelar» alcanzable sin haberlo leído nunca. Sin \`role\`/\`aria-live\` a
       propósito — el mismo patrón que \`dia-especial-resumen\`: es contenido
       del diálogo, no una región transitoria. MEDIDO en Chrome real: el foco
       nace en el \`<h2>\` del título y hacen falta 12 tabulaciones hasta
       \`#dia-especial-cancelar-2\`; ninguna de esas 12 paradas nombra ni
       describe este aviso (no hay \`aria-describedby\` que lo enganche), así
       que tabular directo hacia «Cancelar» NO lo lee. No es una regresión —
       antes de este aviso esa frase ni existía fuera del repaso—, pero es una
       limitación real, no una garantía. Lo que sí es cierto y medido: el
       aviso está presente en el árbol de accesibilidad, va antes que
       «Cancelar» en el orden del DOM (quien explore el diálogo en modo
       lectura lo encuentra primero) y no se duplica con la copia del repaso.
       Pendiente de comprobar con lector de pantalla real. -->
  <p class="tx-status-line" id="dia-especial-aviso-retirada" hidden></p>

  <div id="dia-especial-paso-1">
    <p class="tx-dialog__step" id="dia-especial-paso-1-titulo" tabindex="-1">Paso 1 de 4 · Qué quieres hacer</p>
    <fieldset>
      <legend>Qué quieres hacer</legend>
      <!-- SIN preselección: el sistema no elige por nadie (I3, step 19 §3). -->
      <label class="tx-radio-field"><input type="radio" name="dia-especial-tipo" value="cierre" id="dia-especial-tipo-cierre"> <span>Cerrado todo el día</span></label>
      <label class="tx-radio-field"><input type="radio" name="dia-especial-tipo" value="especial" id="dia-especial-tipo-especial"> <span>Horario especial</span></label>
    </fieldset>
    <p class="tx-status-line" id="dia-especial-gate">Elige qué quieres hacer para continuar. No se rellena nada solo.</p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="dia-especial-cancelar-1" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="dia-especial-siguiente-1" disabled aria-describedby="dia-especial-gate">Siguiente</button>
    </div>
  </div>

  <div id="dia-especial-paso-2" hidden>
    <p class="tx-dialog__step" id="dia-especial-paso-2-titulo" tabindex="-1">Paso 2 de 4 · Cuándo</p>
    <div class="tx-dialog__form-grid">
      <div id="dia-especial-campos-cierre" hidden>
        <p>Un cierre deja el local sin abrir esos días. Todo el mundo queda no disponible.</p>
        <div class="tx-field"><label for="dia-especial-desde">Desde</label><input type="date" id="dia-especial-desde"></div>
        <div class="tx-field"><label for="dia-especial-hasta">Hasta</label><input type="date" id="dia-especial-hasta"></div>
      </div>
      <div id="dia-especial-campos-especial" hidden>
        <p class="tx-status-line">Un horario especial vale para un solo día. Si necesitas varios días seguidos con un horario distinto, hay que apuntarlos de uno en uno.</p>
        <p class="tx-status-line">El horario especial vale para todo el equipo. Esta pantalla no puede decir quién trabaja esa apertura y quién no; para eso están las ausencias.</p>
        <div class="tx-field"><label for="dia-especial-dia">Día</label><input type="date" id="dia-especial-dia"></div>
        <div class="tx-field"><label for="dia-especial-abre">Abre a las</label><input type="text" id="dia-especial-abre" placeholder="10:00"></div>
        <div class="tx-field"><label for="dia-especial-cierra">Cierra a las</label><input type="text" id="dia-especial-cierra" placeholder="14:00"></div>
      </div>
      <div class="tx-field">
        <label for="dia-especial-nombre">Nombre para identificarlo</label>
        <input type="text" id="dia-especial-nombre" placeholder="Cierre por reforma">
        <span class="tx-status-line">Sirve sólo para reconocerlo en la lista. Escríbelo como quieras: la fecha se le añade sola, así que el mismo nombre vale para años distintos.</span>
      </div>
      <div class="tx-field">
        <label for="dia-especial-nota">Nota para el equipo (opcional)</label>
        <!-- V3-12 — SIN \`maxlength\`, a propósito. La barrera del navegador
             cortaba un pegado largo EN SILENCIO, y además cuenta unidades
             UTF-16 mientras el servidor cuenta PUNTOS DE CÓDIGO: con emoji o
             con caracteres fuera del plano básico, las dos cuentas discrepan.
             El tope se aplica en el cliente, contando como cuenta el servidor,
             y cuando recorta LO DICE — el mismo patrón que el Taller (D20-49).
             El servidor sigue siendo la autoridad: rechaza lo que pase. -->
        <input type="text" id="dia-especial-nota" autocomplete="off" aria-describedby="dia-especial-nota-ayuda dia-especial-nota-contador">
        <span class="tx-status-line" id="dia-especial-nota-ayuda">Para que quien mire la pantalla sepa de qué va. No hace falta poner ningún motivo médico ni personal, y no se pide.</span>
        <p class="tx-status-line tx-nota-contador" id="dia-especial-nota-contador"></p>
      </div>
    </div>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="dia-especial-atras-1">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="dia-especial-cancelar-2">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="dia-especial-siguiente">Ver qué citas afecta</button>
    </div>
  </div>

  <div id="dia-especial-paso-3" hidden>
    <p class="tx-dialog__step" id="dia-especial-paso-3-titulo" tabindex="-1">Paso 3 de 4 · Repaso</p>
    <div class="tx-dialog__summary" id="dia-especial-resumen"></div>
    <div class="tx-impact-table" id="dia-especial-impacto"></div>
    <p class="tx-status-line" id="dia-especial-contador" role="status" aria-live="polite"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="dia-especial-atras">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="dia-especial-cancelar-3">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="dia-especial-guardar" disabled aria-describedby="dia-especial-contador">Publicar</button>
    </div>
  </div>

  <div id="dia-especial-paso-4" hidden>
    <p class="tx-dialog__step" id="dia-especial-paso-4-titulo" tabindex="-1">Paso 4 de 4 · Hecho</p>
    <p class="tx-status-line tx-status-line--ok" id="dia-especial-exito" role="status" aria-live="polite"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--primary" id="dia-especial-cerrar">Cerrar</button>
    </div>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: añadir una ausencia (REAPERTURA §R10)                    -->
<!-- ================================================================ -->
<!-- §R10 — CUATRO pasos: quién y cuándo → cuánto → repaso → hecho. «Todo el
     día» nace marcado, y es la ÚNICA preselección autorizada de toda la
     reapertura: es una opción RÁPIDA, no una decisión tomada por nadie.
     §R11 — la nota va al SELLO DE AUDITORÍA (\`AuditStamp.note\`), nunca al
     motivo privado de la ausencia, que tiene prohibido salir del servidor y
     cuyo nombre exacto ni siquiera se escribe en este fichero (hay una
     guarda de \`console.test.ts\` que lo comprueba). Ninguna etiqueta, ayuda
     o mensaje de error de este diálogo pide, sugiere ni ejemplifica un dato
     médico. -->
<dialog class="tx-dialog" id="dialogo-ausencia" aria-labelledby="dialogo-ausencia-titulo">
  <h2 class="tx-dialog__title" id="dialogo-ausencia-titulo" tabindex="-1">Añadir una ausencia</h2>
  <p class="tx-status-line tx-status-line--error" id="ausencia-paso1-error" role="alert"></p>
  <!-- §R13 (V3-6) — mismo aviso y mismo motivo que en dia-especial-aviso-retirada
       (ver comentario allí). Aquí el precargado abre en el paso 1, pero el
       aviso vive igualmente fuera de los pasos, por consistencia y para
       cubrir también quien vuelve al paso 1 desde el 2. -->
  <p class="tx-status-line" id="ausencia-aviso-retirada" hidden></p>

  <div id="ausencia-paso-1">
    <p class="tx-dialog__step" id="ausencia-paso-1-titulo" tabindex="-1">Paso 1 de 4 · Quién y cuándo</p>
    <div class="tx-dialog__form-grid">
      <div class="tx-field">
        <label for="ausencia-profesional">Profesional</label>
        <select id="ausencia-profesional"><option value="">Elige a quién</option></select>
      </div>
      <fieldset>
        <legend>Tipo</legend>
        <label class="tx-radio-field"><input type="radio" name="ausencia-motivo" value="vacation" id="ausencia-motivo-vacation"> <span>Vacaciones</span></label>
        <label class="tx-radio-field"><input type="radio" name="ausencia-motivo" value="absence" id="ausencia-motivo-absence"> <span>Ausencia</span></label>
        <label class="tx-radio-field"><input type="radio" name="ausencia-motivo" value="training" id="ausencia-motivo-training"> <span>Formación</span></label>
      </fieldset>
      <div class="tx-field"><label for="ausencia-desde">Desde</label><input type="date" id="ausencia-desde"></div>
      <div class="tx-field"><label for="ausencia-hasta">Hasta</label><input type="date" id="ausencia-hasta"></div>
      <div class="tx-field">
        <label for="ausencia-nombre">Nombre para identificarlo</label>
        <input type="text" id="ausencia-nombre" placeholder="Vacaciones de Alex">
        <span class="tx-status-line">Sirve sólo para reconocerlo en la lista. Escríbelo como quieras: la fecha se le añade sola, así que el mismo nombre vale para veranos distintos.</span>
      </div>
      <div class="tx-field">
        <label for="ausencia-nota">Nota para el equipo (opcional)</label>
        <input type="text" id="ausencia-nota" autocomplete="off" aria-describedby="ausencia-nota-ayuda ausencia-nota-contador">
        <span class="tx-status-line" id="ausencia-nota-ayuda">Para que quien mire la pantalla sepa de qué va. No hace falta poner ningún motivo médico ni personal, y no se pide.</span>
        <p class="tx-status-line tx-nota-contador" id="ausencia-nota-contador"></p>
      </div>
      <p class="tx-status-line">De esta ausencia se guardan el tipo y, si la escribes, la nota de aquí arriba: las dos se ven en esta pantalla. Ningún cliente verá nunca por qué falta alguien.</p>
    </div>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="ausencia-cancelar-1" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="ausencia-siguiente-1">Siguiente</button>
    </div>
  </div>

  <div id="ausencia-paso-2" hidden>
    <p class="tx-dialog__step" id="ausencia-paso-2-titulo" tabindex="-1">Paso 2 de 4 · Cuánto</p>
    <div class="tx-dialog__form-grid">
      <div class="tx-checkbox-field">
        <input type="checkbox" id="ausencia-todo-el-dia" checked>
        <label for="ausencia-todo-el-dia">Todo el día</label>
      </div>
      <div id="ausencia-campos-horas" hidden>
        <div class="tx-field"><label for="ausencia-desde-hora">Desde las</label><input type="text" id="ausencia-desde-hora" placeholder="09:00"></div>
        <div class="tx-field"><label for="ausencia-hasta-hora">Hasta las</label><input type="text" id="ausencia-hasta-hora" placeholder="14:00"></div>
      </div>
    </div>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="ausencia-atras-1">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="ausencia-cancelar-2">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="ausencia-siguiente">Ver qué citas afecta</button>
    </div>
  </div>

  <div id="ausencia-paso-3" hidden>
    <p class="tx-dialog__step" id="ausencia-paso-3-titulo" tabindex="-1">Paso 3 de 4 · Repaso</p>
    <div class="tx-dialog__summary" id="ausencia-resumen"></div>
    <div class="tx-impact-table" id="ausencia-impacto"></div>
    <p class="tx-status-line" id="ausencia-contador" role="status" aria-live="polite"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="ausencia-atras">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="ausencia-cancelar-3">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="ausencia-guardar" disabled aria-describedby="ausencia-contador">Publicar</button>
    </div>
  </div>

  <div id="ausencia-paso-4" hidden>
    <p class="tx-dialog__step" id="ausencia-paso-4-titulo" tabindex="-1">Paso 4 de 4 · Hecho</p>
    <p class="tx-status-line tx-status-line--ok" id="ausencia-exito" role="status" aria-live="polite"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--primary" id="ausencia-cerrar">Cerrar</button>
    </div>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: detalle de una excepción — cambiar o retirar (§R13)      -->
<!-- ================================================================ -->
<!-- §R13 — «una capacidad de calendario no existe hasta que se puede
     DESHACER». Retirar marca el registro como rechazado y lo CONSERVA; nunca
     borra una fila y nunca toca una reserva. La retirada pasa por la MISMA
     puerta de resoluciones que el alta, y no por simetría: retirar un horario
     especial devuelve el día a su horario de siempre y puede dejar fuera una
     cita real. Cambiar NO es un endpoint: son dos publicaciones (primero se
     retira, después se crea), y el operador tiene que verlo así. -->
<dialog class="tx-dialog" id="dialogo-excepcion" aria-labelledby="dialogo-excepcion-titulo">
  <h2 class="tx-dialog__title" id="dialogo-excepcion-titulo" tabindex="-1">Detalle de la excepción</h2>
  <p class="tx-status-line" id="excepcion-error" role="alert"></p>

  <div id="excepcion-paso-1">
    <p class="tx-dialog__step" id="excepcion-paso-1-titulo" tabindex="-1">Paso 1 de 3 · Qué hay apuntado</p>
    <div class="tx-dialog__summary" id="excepcion-detalle"></div>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="excepcion-cerrar-1" value="cancel">Cerrar</button>
      <button type="button" class="tx-btn tx-btn--secondary" id="excepcion-cambiar">Cambiar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="excepcion-retirar">Retirar</button>
    </div>
  </div>

  <div id="excepcion-paso-2" hidden>
    <p class="tx-dialog__step" id="excepcion-paso-2-titulo" tabindex="-1">Paso 2 de 3 · Repaso</p>
    <div class="tx-dialog__summary" id="excepcion-resumen"></div>
    <div class="tx-impact-table" id="excepcion-impacto"></div>
    <!-- V1-9 — la retirada también deja escrito POR QUÉ. El servidor ya acepta
         \`note\` en \`/api/calendar/withdrawal/publish\` y la guarda en el sello de
         auditoría, igual que en el alta; sin este campo, la única capacidad
         que borra una excepción del calendario era la única que no podía
         explicarse. Mismo tope y mismo contador que las demás. -->
    <div class="tx-field">
      <label for="excepcion-nota">Nota para el equipo (opcional)</label>
      <input type="text" id="excepcion-nota" autocomplete="off" aria-describedby="excepcion-nota-ayuda excepcion-nota-contador">
      <span class="tx-status-line" id="excepcion-nota-ayuda">Por qué se retira. Queda en el historial junto a la retirada. No hace falta poner ningún motivo médico ni personal, y no se pide.</span>
      <p class="tx-status-line tx-nota-contador" id="excepcion-nota-contador"></p>
    </div>
    <p class="tx-status-line" id="excepcion-contador" role="status" aria-live="polite"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="excepcion-atras">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="excepcion-cancelar">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="excepcion-confirmar" disabled aria-describedby="excepcion-contador">Retirar</button>
    </div>
  </div>

  <div id="excepcion-paso-3" hidden>
    <p class="tx-dialog__step" id="excepcion-paso-3-titulo" tabindex="-1">Paso 3 de 3 · Hecho</p>
    <p class="tx-status-line" id="excepcion-exito" role="status" aria-live="polite"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--secondary" id="excepcion-crear-nuevo" hidden>Crear el nuevo</button>
      <button type="button" class="tx-btn tx-btn--primary" id="excepcion-cerrar-3">Cerrar</button>
    </div>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: reiniciar la demostración (destructivo)                  -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-reset" aria-labelledby="dialogo-reset-titulo">
  <h2 class="tx-dialog__title" id="dialogo-reset-titulo" tabindex="-1">¿Seguro que quieres reiniciar la demostración?</h2>
  <p class="tx-dialog__body">Se va a borrar todo el estado sintético: las llamadas, las reservas, las tareas pendientes, los avisos, los errores y los cambios de calendario que hayas publicado.</p>
  <p class="tx-dialog__body">Esto no se puede deshacer.</p>
  <p class="tx-dialog__body">No afecta a ningún sistema real de Demo Salon: aquí no hay nada real.</p>
  <p class="tx-status-line" id="reset-estado" role="status" aria-live="polite"></p>
  <div class="tx-dialog__actions">
    <button type="button" class="tx-btn tx-btn--ghost" id="reset-cancelar" value="cancel">Cancelar</button>
    <button type="button" class="tx-btn tx-btn--danger" id="reset-confirmar">Sí, reiniciar la demostración</button>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: cancelar una cita (agenda)                               -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-cancelar-cita" aria-labelledby="dialogo-cancelar-cita-titulo">
  <h2 class="tx-dialog__title" id="dialogo-cancelar-cita-titulo" tabindex="-1">Cancelar esta cita</h2>

  <div id="cancelar-cita-paso-1">
    <p class="tx-dialog__step">Paso 1 de 2 · Qué vas a cancelar</p>
    <p class="tx-dialog__body" id="cancelar-cita-resumen"></p>
    <!-- (step 18 §4.11) Cuando la cita es de una reserva para varias personas,
         el diálogo lo dice ANTES de confirmar, y dice la verdad entera: se
         cancela sólo ésta. El texto llega RESUELTO del servidor
         («group.cancelDialogNote»); aquí no se compone ninguna frase sobre lo
         que se cancela y lo que no. -->
    <p class="tx-dialog__body" id="cancelar-cita-grupo" hidden></p>
    <div class="tx-dialog__form-grid">
      <div class="tx-field">
        <label for="cancelar-cita-motivo">Motivo</label>
        <select id="cancelar-cita-motivo">
          <option value="client_cancelled_by_phone_simulated">El cliente canceló por teléfono (simulado)</option>
          <option value="client_cancelled_at_counter_simulated">El cliente canceló en el mostrador (simulado)</option>
          <option value="venue_cancelled_simulated">El local canceló la cita (simulado)</option>
          <option value="unspecified">Sin motivo indicado</option>
        </select>
      </div>
      <p class="tx-dialog__body" id="cancelar-cita-plazo"></p>
    </div>
    <p class="tx-status-line tx-status-line--error" id="cancelar-cita-error" role="alert"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="cancelar-cita-cancelar" value="cancel">No cancelar nada</button>
      <button type="button" class="tx-btn tx-btn--danger" id="cancelar-cita-confirmar">Sí, cancelar esta cita</button>
    </div>
  </div>

  <div id="cancelar-cita-paso-2" hidden>
    <p class="tx-dialog__step">Paso 2 de 2 · Qué ha pasado</p>
    <p class="tx-status-line" id="cancelar-cita-resultado" role="status" aria-live="polite"></p>
    <ul id="cancelar-cita-detalle"></ul>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--primary" id="cancelar-cita-cerrar">Cerrar</button>
    </div>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: apuntar a alguien a la lista de espera                   -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-alta-lista" aria-labelledby="dialogo-alta-lista-titulo">
  <h2 class="tx-dialog__title" id="dialogo-alta-lista-titulo" tabindex="-1">Apuntar a alguien a la lista de espera</h2>

  <div id="alta-lista-paso-1">
    <p class="tx-dialog__body">Aquí no se guarda ningún dato personal: la persona se identifica con una etiqueta inventada.</p>
    <div class="tx-dialog__form-grid">
      <div class="tx-field">
        <label for="alta-etiqueta">Etiqueta de la persona</label>
        <select id="alta-etiqueta"></select>
      </div>
      <div class="tx-field">
        <label for="alta-servicio">Servicio</label>
        <select id="alta-servicio"></select>
      </div>
      <div class="tx-field"><label for="alta-desde">Desde el día</label><input type="date" id="alta-desde"></div>
      <div class="tx-field"><label for="alta-hasta">Hasta el día</label><input type="date" id="alta-hasta"></div>
      <div class="tx-field"><label for="alta-desde-hora">Desde las</label><input type="text" id="alta-desde-hora" placeholder="10:00"></div>
      <div class="tx-field"><label for="alta-hasta-hora">Hasta las</label><input type="text" id="alta-hasta-hora" placeholder="12:00"></div>
      <div class="tx-field">
        <label for="alta-profesional">Profesional</label>
        <select id="alta-profesional"></select>
      </div>
      <fieldset>
        <legend>Cómo se ha apuntado</legend>
        <label class="tx-radio-field"><input type="radio" name="alta-origen" value="phone_simulated"> <span>Lo ha pedido por teléfono (simulado)</span></label>
        <label class="tx-radio-field"><input type="radio" name="alta-origen" value="counter_simulated"> <span>Lo ha pedido en el mostrador (simulado)</span></label>
        <label class="tx-radio-field"><input type="radio" name="alta-origen" value="operator_entered"> <span>Lo apunta el operador</span></label>
      </fieldset>
      <div class="tx-checkbox-field">
        <input type="checkbox" id="alta-optin">
        <label for="alta-optin">Confirmo que esta persona ha dicho expresamente que quiere estar en la lista de espera.</label>
      </div>
    </div>
    <p class="tx-status-line tx-status-line--error" id="alta-lista-error" role="alert"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="alta-lista-cancelar" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--secondary" id="alta-lista-rechazo">No ha querido apuntarse</button>
      <button type="button" class="tx-btn tx-btn--primary" id="alta-lista-guardar" disabled aria-describedby="alta-lista-gate">Apuntar a esta persona</button>
    </div>
    <p class="tx-status-line" id="alta-lista-gate">El botón de apuntar no se activa hasta que confirmes que esta persona lo ha pedido.</p>
  </div>

  <div id="alta-lista-paso-2" hidden>
    <p class="tx-status-line" id="alta-lista-resultado" role="status" aria-live="polite"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--primary" id="alta-lista-cerrar">Cerrar</button>
    </div>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: simular un aviso                                         -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-simular-aviso" aria-labelledby="dialogo-simular-aviso-titulo">
  <h2 class="tx-dialog__title" id="dialogo-simular-aviso-titulo" tabindex="-1">Simular el aviso a esta persona</h2>
  <p class="tx-dialog__body" id="simular-aviso-resumen"></p>
  <p class="tx-dialog__body">Aviso simulado. No se ha enviado ningún mensaje ni se ha llamado a nadie.</p>
  <p class="tx-dialog__body">No hay plazo de aceptación. No prometemos ninguno.</p>
  <p class="tx-status-line" id="simular-aviso-estado" role="status" aria-live="polite"></p>
  <div class="tx-dialog__actions">
    <button type="button" class="tx-btn tx-btn--ghost" id="simular-aviso-cancelar" value="cancel">Cancelar</button>
    <button type="button" class="tx-btn tx-btn--primary" id="simular-aviso-confirmar">Sí, anotar el aviso simulado</button>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: convertir una entrada en reserva sintética               -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-convertir" aria-labelledby="dialogo-convertir-titulo">
  <h2 class="tx-dialog__title" id="dialogo-convertir-titulo" tabindex="-1">Crear la reserva de este hueco</h2>
  <p class="tx-dialog__body" id="convertir-resumen"></p>
  <p class="tx-dialog__body">Se creará una reserva sintética. Esta demostración no toca ningún sistema real.</p>
  <p class="tx-dialog__body" id="convertir-inyeccion" hidden>El interruptor de Laboratorio está puesto: esta conversión va a fallar a propósito y no escribirá nada.</p>
  <p class="tx-status-line" id="convertir-estado" role="status" aria-live="polite"></p>
  <div class="tx-dialog__actions">
    <button type="button" class="tx-btn tx-btn--ghost" id="convertir-cancelar" value="cancel">Cancelar</button>
    <button type="button" class="tx-btn tx-btn--primary" id="convertir-confirmar">Sí, crear la reserva sintética</button>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: anotar una inasistencia (agenda, step 18 §5.3)          -->
<!--                                                                   -->
<!-- LOS TRES DIÁLOGOS DE step 18 VIVEN AQUÍ, DESPUÉS DE              -->
<!-- id="vista-llamadas", y eso es NORMATIVO (§5.7, criterio 8.41): la  -->
<!-- prueba del criterio 22 de step 17 examina el corte de HTML que va -->
<!-- de id="vista-lista-espera" a id="vista-llamadas", y meterlos entre -->
<!-- esas dos anclas los habría metido dentro de ese corte.             -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-inasistencia" aria-labelledby="dialogo-inasistencia-titulo">
  <h2 class="tx-dialog__title" id="dialogo-inasistencia-titulo" tabindex="-1">¿Anotar que esta persona no se presentó?</h2>
  <p class="tx-dialog__body" id="inasistencia-resumen"></p>
  <!-- Las cuatro frases del §2.11 se PINTAN desde «operations.noShows.copy»,
       su única fuente de verdad: esta pantalla no compone ni una sola frase
       sobre lo que este sistema se niega a decidir. -->
  <p class="tx-dialog__body" id="inasistencia-manual"></p>
  <p class="tx-dialog__body" id="inasistencia-sin-penalizacion"></p>
  <p class="tx-dialog__body" id="inasistencia-sin-identidad"></p>
  <p class="tx-dialog__body">Podrás corregirlo si te equivocas. <span id="inasistencia-historial"></span></p>
  <p class="tx-status-line" id="inasistencia-estado" role="status" aria-live="polite"></p>
  <div class="tx-dialog__actions">
    <button type="button" class="tx-btn tx-btn--ghost" id="inasistencia-cancelar" value="cancel">Cancelar</button>
    <button type="button" class="tx-btn tx-btn--primary" id="inasistencia-confirmar">Sí, anotar la inasistencia</button>
    <button type="button" class="tx-btn tx-btn--primary" id="inasistencia-cerrar" hidden>Cerrar</button>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: corregir un registro de inasistencia (step 18 §5.3)     -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-corregir-inasistencia" aria-labelledby="dialogo-corregir-inasistencia-titulo">
  <h2 class="tx-dialog__title" id="dialogo-corregir-inasistencia-titulo" tabindex="-1">Corregir el registro de inasistencia</h2>
  <p class="tx-dialog__body" id="corregir-inasistencia-resumen"></p>
  <p class="tx-dialog__body" id="corregir-inasistencia-cuando"></p>
  <p class="tx-dialog__body" id="corregir-inasistencia-historial"></p>
  <!-- K3, dicho ANTES de confirmar: corregir es TERMINAL en esta demostración. -->
  <p class="tx-dialog__body" id="corregir-inasistencia-definitivo"></p>
  <p class="tx-status-line" id="corregir-inasistencia-estado" role="status" aria-live="polite"></p>
  <div class="tx-dialog__actions">
    <button type="button" class="tx-btn tx-btn--ghost" id="corregir-inasistencia-cancelar" value="cancel">Cancelar</button>
    <button type="button" class="tx-btn tx-btn--primary" id="corregir-inasistencia-confirmar">Sí, corregir el registro</button>
    <button type="button" class="tx-btn tx-btn--primary" id="corregir-inasistencia-cerrar" hidden>Cerrar</button>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: reserva para varias personas (step 18 §5.4)             -->
<!-- Cuatro pasos, uno visible a la vez. Ningún enum interno y ningún   -->
<!-- JSON en pantalla: eso vive en el <details> técnico del Laboratorio.-->
<!-- ================================================================ -->
<dialog class="tx-dialog tx-dialog--wide" id="dialogo-grupo" aria-labelledby="dialogo-grupo-titulo">
  <h2 class="tx-dialog__title" id="dialogo-grupo-titulo" tabindex="-1">Nueva reserva para varias personas</h2>
  <p class="tx-status-line" id="grupo-estado" role="status" aria-live="polite"></p>
  <p class="tx-status-line tx-status-line--error" id="grupo-error" role="alert"></p>

  <div id="grupo-paso-1">
    <p class="tx-dialog__step" id="grupo-paso-1-titulo" tabindex="-1">Paso 1 de 4 · Quién viene y qué quiere cada persona</p>
    <div id="grupo-personas"></div>
    <div class="tx-btn-row">
      <button type="button" class="tx-btn tx-btn--secondary" id="grupo-anadir">Añadir otra persona</button>
    </div>
    <p class="tx-context__note">El servicio se elige persona por persona. No se copia solo: cada una puede querer algo distinto.</p>
    <p class="tx-status-line" id="grupo-paso1-gate"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="grupo-cancelar-1" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="grupo-siguiente-1" disabled aria-describedby="grupo-paso1-gate">Siguiente</button>
    </div>
  </div>

  <div id="grupo-paso-2" hidden>
    <p class="tx-dialog__step" id="grupo-paso-2-titulo" tabindex="-1">Paso 2 de 4 · ¿Cómo quieren las citas?</p>
    <fieldset class="tx-slot-card__choice">
      <legend>Cómo quieren las citas</legend>
      <!-- SIN preselección, como el resto de elecciones de esta consola: el
           sistema no elige por nadie (§4.4). -->
      <label class="tx-radio-field"><input type="radio" name="grupo-forma" value="consecutive" id="grupo-forma-consecutivas"> <span>Una detrás de otra — Cada persona en su media hora, seguidas. Pueden atenderlas personas distintas del equipo.</span></label>
      <label class="tx-radio-field"><input type="radio" name="grupo-forma" value="simultaneous" id="grupo-forma-simultaneas"> <span>A la vez — Todas a la misma hora. Hace falta una persona del equipo por cada cliente.</span></label>
    </fieldset>
    <p class="tx-context__note" id="grupo-forma-aviso" hidden></p>
    <div class="tx-field">
      <label for="grupo-fecha">Día</label>
      <input type="date" id="grupo-fecha">
    </div>
    <p class="tx-context__note">Las dos formas ocurren el mismo día. Para citas en días distintos, créalas de una en una.</p>
    <p class="tx-status-line" id="grupo-paso2-gate">El botón no se activa hasta que elijas una de las dos formas. Ninguna viene marcada: eliges tú.</p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="grupo-atras-2">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="grupo-cancelar-2" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="grupo-siguiente-2" disabled aria-describedby="grupo-paso2-gate">Siguiente</button>
    </div>
  </div>

  <div id="grupo-paso-3" hidden>
    <p class="tx-dialog__step" id="grupo-paso-3-titulo" tabindex="-1">Paso 3 de 4 · Propuestas compatibles</p>
    <div class="tx-btn-row">
      <button type="button" class="tx-btn tx-btn--secondary" id="grupo-buscar">Buscar huecos</button>
    </div>
    <p class="tx-context__note">Esto mira la agenda tal y como está ahora mismo. Se volverá a comprobar justo antes de crear las citas.</p>
    <div class="tx-slot-list" id="grupo-propuestas"></div>
    <p class="tx-status-line" id="grupo-paso3-gate">El botón no se activa hasta que elijas una propuesta. Ninguna viene marcada y ninguna está recomendada: eliges tú.</p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="grupo-atras-3">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="grupo-cancelar-3" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="grupo-siguiente-3" disabled aria-describedby="grupo-paso3-gate">Ver el resumen</button>
    </div>
  </div>

  <div id="grupo-paso-4" hidden>
    <p class="tx-dialog__step" id="grupo-paso-4-titulo" tabindex="-1">Paso 4 de 4 · Resumen y confirmación</p>
    <div class="tx-table-scroll" tabindex="0" role="region" aria-label="Resumen de las citas que se van a crear">
      <table class="tx-table tx-table--stack">
        <caption class="tx-visually-hidden">Resumen de las citas que se van a crear</caption>
        <thead>
          <tr>
            <th scope="col">Persona</th>
            <th scope="col">Servicio</th>
            <th scope="col">Día</th>
            <th scope="col">Hora</th>
            <th scope="col">Profesional</th>
          </tr>
        </thead>
        <tbody id="grupo-resumen-tbody"></tbody>
      </table>
    </div>
    <p class="tx-dialog__body" id="grupo-resumen-cuantas"></p>
    <p class="tx-dialog__body">Si alguno de estos huecos ya no está libre, no se creará ninguna cita.</p>
    <p class="tx-dialog__body">Cancelar una de estas citas después no cancelará las demás.</p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="grupo-atras-4">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="grupo-cancelar-4" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="grupo-confirmar">Sí, crear estas citas</button>
      <button type="button" class="tx-btn tx-btn--primary" id="grupo-cerrar" hidden>Cerrar</button>
    </div>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: DETALLE DE UNA CITA (step 26 §6.6)                       -->
<!--                                                                    -->
<!-- Se abre al activar un bloque de la rejilla de Agenda (Día/Semana). -->
<!-- No inventa ninguna acción: los tres botones que puede llevar son   -->
<!-- los mismos abrirDialogo* que ya usa la vista Lista, con las mismas -->
<!-- condiciones resueltas por el servidor. Ningún identificador de la  -->
<!-- reserva ni de la cita manual aparece fuera del detalle técnico.    -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-cita-detalle" aria-labelledby="dialogo-cita-detalle-titulo">
  <h2 class="tx-dialog__title" id="dialogo-cita-detalle-titulo" tabindex="-1">Detalle de la cita</h2>
  <p class="tx-dialog__body" id="cita-detalle-cuando"></p>
  <p class="tx-dialog__body" id="cita-detalle-servicio"></p>
  <p class="tx-dialog__body" id="cita-detalle-profesional"></p>
  <div id="cita-detalle-pill"></div>
  <p class="tx-dialog__body" id="cita-detalle-origen" hidden></p>
  <p class="tx-dialog__body" id="cita-detalle-grupo" hidden></p>
  <details class="tx-details">
    <summary>Detalle técnico</summary>
    <div class="tx-details__body">
      <dl id="cita-detalle-tecnico"></dl>
    </div>
  </details>
  <div class="tx-dialog__actions" id="cita-detalle-acciones"></div>
  <div class="tx-dialog__actions">
    <button type="button" class="tx-btn tx-btn--ghost" id="cita-detalle-cerrar">Cerrar</button>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: CREAR CITA MANUAL (step 24 §4, §14)                     -->
<!--                                                                   -->
<!-- Cinco pasos, en el orden que manda el diseño: servicio · fecha y   -->
<!-- profesional · hueco · persona sintética · revisión. Ninguna        -->
<!-- elección viene marcada de antemano: el sistema no elige por nadie. -->
<!--                                                                   -->
<!-- LOS HUECOS DEL PASO 3 NO SE ESCRIBEN A MANO. No hay campo de hora  -->
<!-- en ninguna parte de este diálogo: sólo una lista de huecos que     -->
<!-- viene del resolvedor canónico, y el servidor revalida igualmente.  -->
<!-- ================================================================ -->
<dialog class="tx-dialog tx-dialog--wide" id="dialogo-cita-manual" aria-labelledby="dialogo-cita-manual-titulo">
  <h2 class="tx-dialog__title" id="dialogo-cita-manual-titulo" tabindex="-1">Crear cita manual</h2>
  <p class="tx-status-line" id="manual-estado" role="status" aria-live="polite"></p>
  <p class="tx-status-line tx-status-line--error" id="manual-error" role="alert"></p>

  <div id="manual-paso-1">
    <p class="tx-dialog__step" id="manual-paso-1-titulo" tabindex="-1">Paso 1 de 5 · ¿Qué servicio?</p>
    <fieldset class="tx-slot-card__choice">
      <legend>Servicio</legend>
      <label class="tx-radio-field"><input type="radio" name="manual-servicio" value="1" id="manual-servicio-1"> <span>Corte de pelo — 30 minutos</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-servicio" value="0" id="manual-servicio-0"> <span>Barba — 30 minutos</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-servicio" value="2" id="manual-servicio-2"> <span>Corte y barba — 30 minutos</span></label>
    </fieldset>
    <p class="tx-context__note">En esta demostración los tres duran 30 minutos. No se cobra nada: no hay importes ni depósitos.</p>

    <!-- step 26 §13 — Control «Duración». Oculto hasta que hay servicio    -->
    <!-- elegido; «30 min · habitual» se marca por JS EN CUANTO se elige un  -->
    <!-- servicio (nunca marcado de fábrica en este diálogo, como el resto). -->
    <!-- «Otra duración…» revela un select, NUNCA un campo de texto libre    -->
    <!-- ni de hora.                                                        -->
    <fieldset class="tx-slot-card__choice" id="manual-duracion-campo" hidden>
      <legend>Duración</legend>
      <label class="tx-radio-field"><input type="radio" name="manual-duracion" value="30" id="manual-duracion-30"> <span>30 min · habitual</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-duracion" value="60" id="manual-duracion-60"> <span>1 h</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-duracion" value="90" id="manual-duracion-90"> <span>1 h 30 min</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-duracion" value="120" id="manual-duracion-120"> <span>2 h</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-duracion" value="150" id="manual-duracion-150"> <span>2 h 30 min</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-duracion" value="otra" id="manual-duracion-otra"> <span>Otra duración…</span></label>
    </fieldset>
    <p class="tx-context__note" id="manual-duracion-nota" hidden>Los tres servicios del catálogo duran 30 minutos. Esa es la duración marcada.</p>
    <div class="tx-field" id="manual-duracion-otra-campo" hidden>
      <label for="manual-duracion-otra-valor">¿Cuántos minutos dura la cita especial?</label>
      <select id="manual-duracion-otra-valor">
        <option value="">Elige cuántos minutos</option>
        <option value="15">15 min</option>
        <option value="45">45 min</option>
        <option value="75">1 h 15 min</option>
        <option value="105">1 h 45 min</option>
        <option value="135">2 h 15 min</option>
        <option value="165">2 h 45 min</option>
        <option value="180">3 h</option>
        <option value="195">3 h 15 min</option>
        <option value="210">3 h 30 min</option>
        <option value="225">3 h 45 min</option>
        <option value="240">4 h</option>
      </select>
    </div>
    <p class="tx-status-line" id="manual-duracion-aviso" hidden>Duración especial elegida por el operador.</p>

    <p class="tx-status-line" id="manual-paso1-gate">El botón no se activa hasta que elijas un servicio. Ninguno viene marcado: eliges tú.</p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-cancelar-1" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="manual-siguiente-1" disabled aria-describedby="manual-paso1-gate">Siguiente</button>
    </div>
  </div>

  <div id="manual-paso-2" hidden>
    <p class="tx-dialog__step" id="manual-paso-2-titulo" tabindex="-1">Paso 2 de 5 · ¿Qué día y con quién?</p>
    <div class="tx-field">
      <label for="manual-fecha">Día</label>
      <input type="date" id="manual-fecha">
    </div>
    <fieldset class="tx-slot-card__choice">
      <legend>Profesional</legend>
      <label class="tx-radio-field"><input type="radio" name="manual-quien" value="any" id="manual-quien-cualquiera"> <span>Cualquier profesional — la demostración elige con la misma regla que usa el motor de llamadas, y te dirá a quién antes de confirmar.</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-quien" value="one" id="manual-quien-una"> <span>Una persona concreta</span></label>
    </fieldset>
    <div class="tx-field" id="manual-profesional-campo" hidden>
      <label for="manual-profesional">¿Quién?</label>
      <select id="manual-profesional"></select>
    </div>
    <p class="tx-status-line" id="manual-paso2-gate">El botón no se activa hasta que elijas día y profesional.</p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-atras-2">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-cancelar-2" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="manual-siguiente-2" disabled aria-describedby="manual-paso2-gate">Buscar huecos</button>
    </div>
  </div>

  <div id="manual-paso-3" hidden>
    <p class="tx-dialog__step" id="manual-paso-3-titulo" tabindex="-1">Paso 3 de 5 · Elige un hueco</p>
    <p class="tx-context__note">Estos huecos salen del mismo sitio que los del motor de llamadas y los del explorador. Se volverá a comprobar justo antes de crear la cita.</p>
    <p class="tx-context__note">No se puede escribir una hora a mano: si no aparece aquí, es que no está disponible.</p>
    <div class="tx-slot-list" id="manual-huecos"></div>
    <p class="tx-status-line" id="manual-paso3-gate">El botón no se activa hasta que elijas un hueco. Ninguno viene marcado y la demostración no elige por ti: eliges tú.</p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-atras-3">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-cancelar-3" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="manual-siguiente-3" disabled aria-describedby="manual-paso3-gate">Siguiente</button>
    </div>
  </div>

  <div id="manual-paso-4" hidden>
    <p class="tx-dialog__step" id="manual-paso-4-titulo" tabindex="-1">Paso 4 de 5 · ¿Para quién?</p>
    <fieldset class="tx-slot-card__choice">
      <legend>Persona sintética</legend>
      <label class="tx-radio-field"><input type="radio" name="manual-persona" value="Cliente A" id="manual-persona-a"> <span>Cliente A</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-persona" value="Cliente B" id="manual-persona-b"> <span>Cliente B</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-persona" value="Cliente C" id="manual-persona-c"> <span>Cliente C</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-persona" value="Cliente D" id="manual-persona-d"> <span>Cliente D</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-persona" value="Cliente E" id="manual-persona-e"> <span>Cliente E</span></label>
      <label class="tx-radio-field"><input type="radio" name="manual-persona" value="Cliente F" id="manual-persona-f"> <span>Cliente F</span></label>
    </fieldset>
    <p class="tx-context__note">Catálogo cerrado de personas sintéticas. Aquí no se escriben nombres, teléfonos, correos ni notas: no hay ningún sitio donde quepan.</p>
    <p class="tx-status-line" id="manual-paso4-gate">El botón no se activa hasta que elijas una persona.</p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-atras-4">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-cancelar-4" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="manual-siguiente-4" disabled aria-describedby="manual-paso4-gate">Ver el resumen</button>
    </div>
  </div>

  <div id="manual-paso-5" hidden>
    <p class="tx-dialog__step" id="manual-paso-5-titulo" tabindex="-1">Paso 5 de 5 · Revisa y confirma</p>
    <dl class="tx-summary" id="manual-resumen"></dl>
    <p class="tx-dialog__body" id="manual-resumen-profesional"></p>
    <p class="tx-dialog__body" id="manual-resumen-origen"></p>
    <p class="tx-context__note" id="manual-resumen-sintetico"></p>
    <div class="tx-dialog__actions">
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-atras-5">Atrás</button>
      <button type="button" class="tx-btn tx-btn--ghost" id="manual-cancelar-5" value="cancel">Cancelar</button>
      <button type="button" class="tx-btn tx-btn--primary" id="manual-confirmar">Confirmar y crear la cita sintética</button>
      <button type="button" class="tx-btn tx-btn--primary" id="manual-cerrar" hidden>Cerrar</button>
    </div>
  </div>
</dialog>

<!-- ================================================================ -->
<!-- Diálogo: borrar todos los borradores del taller (step 20 §3.9)   -->
<!-- Borra SÓLO el borrador local del taller: ninguna petición sale y  -->
<!-- nada de la demostración cambia (I20-7). El cuerpo con las cifras  -->
<!-- lo compone el cliente concatenando las plantillas del servidor.   -->
<!-- ================================================================ -->
<dialog class="tx-dialog" id="dialogo-taller-borrar" aria-labelledby="dialogo-taller-borrar-titulo">
  <h2 class="tx-dialog__title" id="dialogo-taller-borrar-titulo" tabindex="-1">${WORKSHOP_COPY.dialog.title}</h2>
  <p class="tx-dialog__body" id="tx-taller-borrar-resumen"></p>
  <p class="tx-dialog__body">${WORKSHOP_COPY.dialog.scopeNote}</p>
  <div class="tx-dialog__actions">
    <button type="button" class="tx-btn tx-btn--ghost" id="tx-taller-borrar-cancelar" value="cancel">${WORKSHOP_COPY.dialog.cancelTag}</button>
    <button type="button" class="tx-btn tx-btn--primary" id="tx-taller-borrar-confirmar">${WORKSHOP_COPY.dialog.confirmTag}</button>
  </div>
</dialog>

<script src="/app.js"></script>
</body>
</html>
`;
}
