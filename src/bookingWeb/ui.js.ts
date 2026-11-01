/**
 * ────────────────────────────────────────────────────────────────────────
 * FASE 2 — JavaScript de cliente de la demostración web de reservas, servido
 * VERBATIM por `GET /app.js` (ver server.ts). Una IIFE de JavaScript de
 * navegador liso — sin bundler, sin framework, sin paso de compilación —
 * calcada de la arquitectura de `src/console/ui.js.ts` ("dos rutas y una
 * plantilla literal"), pero un fichero PROPIO de esta fase 2 que no importa
 * nada de la consola.
 *
 * REGLA DURA, vigilada por `tests/bookingWeb/uiEstatico.test.ts` (que
 * inspecciona este fichero como texto): cada actualización del DOM usa
 * `textContent` (o `setAttribute`/propiedades de elemento/`createElement`) —
 * `innerHTML` NO aparece nunca en esta cadena, y tampoco `.style.` ni un
 * atributo `style=` en línea (`style-src 'self'`, sin `'unsafe-inline'`).
 *
 * ────────────────────────────────────────────────────────────────────────
 * EL CLIENTE NO FORMATEA DINERO NI TIEMPO. LOS IMPRIME.
 *
 * Toda cantidad con unidad —un importe, una duración— llega de la API YA
 * ESCRITA (`priceLabel`, `durationLabel`, `labels.amount*`, `totals.labels.*`)
 * y se vuelca tal cual con `textContent`. Aquí no se divide entre cien, no se
 * pega un símbolo de moneda y no se convierten minutos en «1 h 30 min».
 *
 * No es una preferencia de estilo: es que un segundo formateador de la misma
 * unidad es una SEGUNDA VERDAD, y las dos verdades acaban discrepando en la
 * misma pantalla. Pasó, y por eso está escrito aquí: la sección pública de
 * servicios imprimía «1 h» para «Corte y barba» —con `formatDurationLabel` del
 * servidor— mientras el paso 1 del asistente, tres pantallas más abajo,
 * imprimía «60 min» porque componía `durationMinutes + ' min'` por su cuenta.
 * El mismo servicio, el mismo dato, dos textos distintos a la vez. Lo mismo
 * valía para los totales del panel, que reimplementaban `formatEuros`.
 *
 * Lo que este fichero SÍ compone son FECHAS Y HORAS DE RELOJ para navegar por
 * el calendario (`formatDateLong`, `formatDateChip`, `formatMinutes`, los
 * rótulos del mes). Es deuda conocida y acotada, no una excepción a la regla:
 * el servidor ya publica `starts[].label` y `labels.when`, así que el día que
 * se decida cerrarla se cierra imprimiendo esos campos. Mientras tanto, ninguna
 * de esas composiciones toca dinero ni duración de servicio.
 * ────────────────────────────────────────────────────────────────────────
 *
 * NINGÚN DATO SE INVENTA AQUÍ. Los horarios, los precios y los estados de
 * pago vienen SIEMPRE de la API (`/api/:tenantId/…`): este fichero sólo pinta
 * lo que el servidor contesta. La única excepción es puramente de
 * PRESENTACIÓN, no de negocio: los días del calendario se deshabilitan fuera
 * de `[demoToday, demoToday + bookingHorizonDays - 1]` — un rango que el
 * propio `bootstrap` publica para esto exactamente, no una regla de horario
 * inventada.
 *
 * NO HAY NINGUNA HORA DE CORTE EN ESTE FICHERO, y no puede haberla. Los
 * bloques de la rejilla ("Mañana"/"Tarde"/"Horario"/"Tramo N") se agrupan por
 * CONTENCIÓN en los tramos de apertura que publica `/availability` en su campo
 * `windows`, y su rótulo es el que trae cada tramo. Quien decide cuántos
 * tramos abre el local y cómo se llaman es el servidor, a partir de
 * `resolveDayWindows` (el motor de calendario) y de las constantes de
 * `model.ts`. Antes se agrupaba por el hueco entre inicios consecutivos y se
 * rotulaba con un pivote a las 12:00: una mañana con los primeros huecos ya
 * reservados —primer inicio libre 12:30— se rotulaba "Tarde".
 *
 * ESTE FICHERO LLAMA A LA FUNCIÓN `fetch` — a propósito, y sólo contra rutas
 * de ESTE MISMO PROCESO (`/api/:tenantId/…`), nunca a un origen ajeno: `connect-src
 * 'self'` en la CSP de `server.ts` no dejaría pasar nada más. Es el mismo
 * proceso local de la demostración hablando consigo mismo desde el
 * navegador — no es la integración de red que
 * `tests/bookingWeb/sinProveedorDePago.test.ts` prohíbe para el resto del
 * árbol (el servidor, en Node, sigue sin importar ningún cliente HTTP ni
 * salir a la red él mismo).
 *
 * SIN RELOJ REAL Y SIN AZAR, como el resto de la demostración: el «hoy» es
 * SIEMPRE `bootstrap.demoToday` (nunca el reloj del navegador), y la clave de
 * idempotencia de cada intento de reserva se compone del tenant y de un
 * CONTADOR en memoria — nunca del reloj del sistema ni de un generador
 * aleatorio — para que sea la MISMA en cada reintento del mismo hueco y
 * distinta en cuanto se elige otro.
 *
 * ────────────────────────────────────────────────────────────────────────
 * AMPLIACIÓN M-WEB-1 (2026-08-26) — la página pública que envuelve al asistente
 *
 * El asistente de cuatro pasos no cambia: lo que cambia es DÓNDE vive. Ahora
 * está dentro de una web pública con hero, servicios, equipo, información y
 * preguntas, y el paso 3 (fecha, hora y pago) se ha mudado a un
 * `<dialog id="txb-drawer-fecha">`. Un `<dialog>` no se abre solo: sin la
 * llamada a `showModal()` de este fichero el paso 3 sería invisible en un
 * navegador real. Eso añade tres responsabilidades nuevas, y sólo tres:
 *
 *   1. ABRIR Y CERRAR EL CAJÓN, devolviendo el foco AL ELEMENTO QUE LO ABRIÓ
 *      —que no es siempre el mismo botón: puede ser «Continuar» o el CTA de
 *      una ficha de equipo—, por lo que el disparador se guarda en el estado
 *      antes de `showModal()` y se consume en el evento `close`. `Escape` no se
 *      implementa aquí: lo da el `<dialog>` nativo, y engancharlo a mano sería
 *      una segunda verdad que podría desincronizarse.
 *
 *   2. LOS CTA REPETIDOS de las fichas de servicio y de equipo, que no llevan
 *      `id` (habría uno por ficha) sino clase y atributo de datos:
 *      `.txb-cta-servicio[data-service-id]` y
 *      `.txb-cta-profesional[data-employee-id]`.
 *
 *   3. EL MENÚ MÓVIL (`#txb-nav-toggle` / `#txb-nav-menu`), que sí necesita
 *      `Escape` a mano porque un `<div>` no es un `<dialog>`. NO toca
 *      `document.body` ni el desplazamiento del documento: la página se lee
 *      igual con el menú abierto.
 *
 * EL PASO 3 NUNCA ABRE VACÍO (revisión de producto, 2026-08-26). El cajón se
 * abría sin ningún día marcado: la rejilla de horas en blanco y, encima, la
 * leyenda «✓ Disponible – No disponible» flotando sola sobre un cuarto de
 * pantalla de nada. Quien llega ahí ya ha elegido servicio y persona; lo único
 * que le falta es ver horas. Ahora, al ENTRAR en el paso, el cliente busca por
 * su cuenta el primer día con huecos y lo deja seleccionado.
 *
 * Y LO HACE SIN CALCULAR NADA. No sabe qué días abre el local, ni a qué hora,
 * ni cuál es el último inicio que cabe antes del cierre: PREGUNTA a
 * `/availability` por un día y mira si la lista que contesta el servidor viene
 * vacía. Reimplementar aquí la mitad del motor de calendario sería la misma
 * segunda verdad que ya costó una hora de corte inventada a las 12:00 en el
 * rotulado de los bloques. El tope de la búsqueda es una semana —siete
 * peticiones en el peor caso, nunca una cascada—, gana siempre lo que la
 * persona pulse mientras corre, y NO se dispara en el primer pintado: la
 * portada tiene que seguir siendo lo primero que se ve.
 *
 * LA REGLA DURA DE COMPATIBILIDAD. Nunca pueden coexistir en el estado un
 * servicio y un profesional incompatibles, y JAMÁS se pregunta a
 * `/availability` por ese par. Quién puede hacer qué se lee de UNA sola fuente,
 * `bootstrap.employees[].serviceIds` —la misma matriz con la que el servidor
 * calcula los huecos—, nunca de `data-service-ids` del marcado ni de ninguna
 * regla escrita por nombre de persona o de local. Si un CTA fuera a crear el
 * par imposible, gana lo que la persona acaba de pulsar, se descarta la otra
 * mitad, se dice en `#txb-anuncio` y el asistente queda en un paso desde el que
 * se puede seguir.
 *
 * NINGÚN PUNTO DE RUPTURA VIVE AQUÍ. Este fichero no pregunta por la anchura de
 * la ventana, no consulta ninguna consulta de medios y no compara contra ningún
 * literal: si el cliente supiera cuándo es «móvil», habría dos diseños que
 * mantener y uno de ellos se quedaría atrás. El comportamiento es el mismo en
 * todas las anchuras y quien decide qué se ve es la hoja de estilos.
 * ────────────────────────────────────────────────────────────────────────
 */
import { OPENING_WINDOW_SINGLE_LABEL } from "./model.js";

export function renderBookingAppJs(): string {
  return `'use strict';
(function () {
  // ---------------------------------------------------------------------
  // Ayudas genéricas de DOM — sólo textContent / createElement / setAttribute.
  // ---------------------------------------------------------------------
  function byId(id) { return document.getElementById(id); }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function setHidden(node, hidden) { node.hidden = !!hidden; }

  function announce(text) {
    var node = byId('txb-anuncio');
    if (node) node.textContent = text;
  }

  // ---------------------------------------------------------------------
  // Fechas — sólo aritmética y formato. Nunca lee el reloj del navegador:
  // el "hoy" de esta demostración es SIEMPRE state.bootstrap.demoToday.
  // ---------------------------------------------------------------------
  var WEEKDAYS_ABBR = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  function parseISODateParts(iso) {
    var parts = iso.split('-');
    return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
  }
  function dateFromISO(iso) {
    var p = parseISODateParts(iso);
    return new Date(p.y, p.m - 1, p.d);
  }
  function toISODate(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }
  function addDaysISO(iso, days) {
    var d = dateFromISO(iso);
    d.setDate(d.getDate() + days);
    return toISODate(d);
  }
  function formatDateChip(iso) {
    var d = dateFromISO(iso);
    return { weekday: WEEKDAYS_ABBR[d.getDay()], day: d.getDate() };
  }
  function formatDateLong(iso) {
    var d = dateFromISO(iso);
    return WEEKDAYS_ABBR[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }
  function formatMinutes(mins) {
    return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60);
  }
  function daysInMonth(year, month1) {
    return new Date(year, month1, 0).getDate();
  }
  function firstWeekdayMonSun(year, month1) {
    var jsDow = new Date(year, month1 - 1, 1).getDay();
    return (jsDow + 6) % 7;
  }
  function monthMatrix(year, month1) {
    var total = daysInMonth(year, month1);
    var offset = firstWeekdayMonSun(year, month1);
    var cells = [];
    var i;
    for (i = 0; i < offset; i += 1) cells.push(null);
    for (i = 1; i <= total; i += 1) cells.push(year + '-' + pad2(month1) + '-' + pad2(i));
    while (cells.length % 7 !== 0) cells.push(null);
    var weeks = [];
    for (i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  // ---------------------------------------------------------------------
  // Estado del asistente. Un único objeto mutable, como en la consola.
  // ---------------------------------------------------------------------
  var state = {
    tenantId: document.body.getAttribute('data-tenant-id') || '',
    bootstrap: null,
    view: 'reserva',
    step: 1,
    serviceId: null,
    employeeId: null,
    date: null,
    calendarYear: null,
    calendarMonth: null,
    availability: null,
    startMinutes: null,
    fullDayView: false,
    paymentOption: null,
    idempotencyKey: null,
    idempotencySeq: 0,
    lastBooking: null,
    lastMessages: [],
    dashboard: null,
    /**
     * El elemento que abrió el cajón de fecha y hora. Se guarda ANTES de
     * \`showModal()\` y se consume en el evento \`close\`: al cerrar, el foco
     * vuelve a donde estaba, y "donde estaba" no es un botón fijo —puede ser
     * «Continuar» del resumen o el CTA de una ficha de equipo—, así que
     * codificar un único destino dejaría el foco perdido en la mitad de los
     * casos.
     */
    drawerTrigger: null,
    /**
     * Un CTA pulsado ANTES de que llegara \`/bootstrap\`. Sin la matriz de
     * compatibilidad no se puede decidir nada sin arriesgarse a componer el par
     * imposible, así que la intención se guarda y se aplica en cuanto llega,
     * en vez de descartarse en silencio.
     */
    pendingCta: null,
  };

  /**
   * La clave de idempotencia de ESTE intento. Se regenera cada vez que
   * cambia el hueco elegido (servicio+profesional+fecha+inicio) y se
   * REUTILIZA mientras esa elección no cambie — así un reintento del mismo
   * botón manda la misma clave, y el servidor la trata como una repetición,
   * nunca como una reserva nueva.
   *
   * Usa crypto.randomUUID() cuando el navegador lo ofrece (todos los
   * modernos): cada intento se acuña con un identificador propio, así que
   * dos sesiones independientes que eligieran por casualidad el MISMO hueco
   * como su primer intento nunca comparten clave. Con el contador puro (el
   * respaldo de abajo, para el navegador más viejo que no tenga
   * randomUUID) sí podrían: dos pestañas que arrancan su propio contador en
   * 1 producirían la misma clave para el mismo cuerpo, y el servidor
   * trataría la segunda como una REPETICIÓN de la primera en vez de como
   * una reserva distinta.
   */
  function nextIdempotencyKey() {
    state.idempotencySeq += 1;
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return 'web-' + state.tenantId + '-' + crypto.randomUUID();
    }
    return 'web-' + state.tenantId + '-' + String(state.idempotencySeq).padStart(6, '0') + '-attempt';
  }

  // ---------------------------------------------------------------------
  // Llamadas a la API de ESTE MISMO proceso, y a nada más
  // (connect-src 'self' en la CSP no dejaría pasar otra cosa).
  // ---------------------------------------------------------------------
  function apiUrl(path) {
    return '/api/' + encodeURIComponent(state.tenantId) + path;
  }

  function requestJson(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(apiUrl(path), opts).then(function (res) {
      return res.json().then(function (json) {
        return { status: res.status, json: json };
      });
    });
  }

  function showError(message) {
    var node = byId('txb-error');
    node.textContent = message;
    setHidden(node, false);
    announce(message);
  }
  function clearError() {
    var node = byId('txb-error');
    node.textContent = '';
    setHidden(node, true);
  }

  // ---------------------------------------------------------------------
  // Indicador de pasos
  // ---------------------------------------------------------------------
  function renderSteps() {
    var items = byId('txb-steps').children;
    for (var i = 0; i < items.length; i += 1) {
      var n = i + 1;
      var li = items[i];
      if (n === state.step) {
        li.setAttribute('aria-current', 'step');
      } else {
        li.removeAttribute('aria-current');
      }
      li.classList.toggle('txb-step--done', n < state.step);
    }
  }

  function showPaso(id) {
    var pasos = ['txb-paso-servicio', 'txb-paso-profesional', 'txb-paso-fecha-hora', 'txb-paso-confirmacion'];
    for (var i = 0; i < pasos.length; i += 1) setHidden(byId(pasos[i]), pasos[i] !== id);
  }

  /**
   * El único sitio que decide qué paso se ve, y por tanto el único que abre y
   * cierra el cajón: entrar en el paso 3 lo abre y salir de él lo cierra, de
   * modo que no puede quedar un cajón abierto sobre un paso que ya no es el
   * suyo. \`trigger\` es opcional y sólo lo usa el paso 3 (ver \`openDrawer\`).
   *
   * El cierre va ANTES de pintar y de mover el foco a propósito: el manejador
   * del evento \`close\` devuelve el foco al disparador, y lo que se quiere al
   * IR a otro paso es que gane el encabezado de ese paso, no el botón viejo.
   */
  function goToStep(n, trigger) {
    state.step = n;
    if (n !== 3) closeDrawer();
    renderSteps();
    if (n === 1) { showPaso('txb-paso-servicio'); focusHeading('txb-paso-servicio-titulo'); }
    else if (n === 2) { showPaso('txb-paso-profesional'); renderEmployeeStep(); focusHeading('txb-paso-profesional-titulo'); }
    else if (n === 3) { openDrawer(trigger); showPaso('txb-paso-fecha-hora'); enterDateStep(); focusHeading('txb-paso-fecha-hora-titulo'); }
    else if (n === 4) { showPaso('txb-paso-confirmacion'); focusHeading('txb-paso-confirmacion-titulo'); }
    updateAsideContinue();
  }

  /**
   * EL PRIMER PINTADO NO MUEVE NI EL FOCO NI EL DESPLAZAMIENTO. Y NO PUEDE.
   *
   * El arranque termina llamando a goToStep(1), que enfoca el encabezado del
   * paso 1. Ese encabezado vive en la sección de reserva, la QUINTA de la
   * página, así que enfocarlo arrastraba el documento hasta ella y quien abría
   * la web aterrizaba a más de dos mil píxeles del principio: la portada
   * —héroe, servicios, equipo— no la veía nadie (medido en Chrome el
   * 2026-08-26: desplazamiento de 2473,5 a 1440 px de ancho y de 4738 a 390 px).
   *
   * La cura no es dejar de mover el foco —moverlo es lo correcto en cada
   * transición que pide una persona— sino distinguir QUIÉN la pide. Mientras
   * dura el arranque, esta función no hace nada; en cuanto el asistente está
   * pintado, vuelve a hacerlo siempre. Un desplazamiento que nadie ha pedido es
   * un defecto; el mismo desplazamiento después de un clic es la respuesta.
   */
  var primerPintado = true;

  /**
   * \`sinDesplazar\` existe para los CTA de página, que son anclas: ahí el
   * desplazamiento ya lo ha decidido el navegador y volver a decidirlo desde
   * aquí sería pelearse con él. En las transiciones de paso NO se pasa, porque
   * llevar a la vista el encabezado al que va el foco es justo lo que se quiere.
   */
  function focusHeading(id, sinDesplazar) {
    if (primerPintado) return;
    var node = byId(id);
    if (!node || !node.focus) return;
    if (sinDesplazar) node.focus({ preventScroll: true });
    else node.focus();
  }

  /** Los encabezados de los cuatro pasos, escritos ENTEROS y en orden. */
  var STEP_HEADING_IDS = [
    'txb-paso-servicio-titulo',
    'txb-paso-profesional-titulo',
    'txb-paso-fecha-hora-titulo',
    'txb-paso-confirmacion-titulo',
  ];

  /**
   * Lleva el foco al encabezado del paso que se está viendo. Lo usan los CTA de
   * página (barra, hero y barra móvil), que son \`<a href="#…">\` y anclan solos:
   * el navegador desplaza, y esto pone el foco donde la persona va a seguir. Se
   * usa el paso ACTUAL y no siempre el primero porque llevar el foco a un
   * encabezado oculto —lo que pasaría con quien ya va por el paso 2— no lo mueve
   * en un navegador real y lo dejaría donde estaba.
   */
  function focusCurrentStepHeading(sinDesplazar) {
    focusHeading(STEP_HEADING_IDS[state.step - 1] || STEP_HEADING_IDS[0], sinDesplazar);
  }

  // ---------------------------------------------------------------------
  // EL CAJÓN DEL PASO 3 (<dialog id="txb-drawer-fecha">)
  //
  // El elemento nativo regala la trampa de foco, el cierre con Escape, el
  // ::backdrop y el resto del documento inerte. Lo único que hay que poner es
  // la apertura, el cierre por el botón ✕ y por el fondo, y la devolución del
  // foco al disparador.
  // ---------------------------------------------------------------------
  function drawerNode() { return byId('txb-drawer-fecha'); }

  function openDrawer(trigger) {
    var dialog = drawerNode();
    if (!dialog) return;
    if (trigger) state.drawerTrigger = trigger;
    if (!dialog.open) dialog.showModal();
  }

  function closeDrawer() {
    var dialog = drawerNode();
    if (dialog && dialog.open) dialog.close();
  }

  /**
   * Se cierre como se cierre —✕, Escape, clic en el fondo, «Volver», confirmar
   * o reiniciar—, el asistente queda en un paso coherente y el foco vuelve al
   * elemento que abrió el cajón.
   *
   * El orden importa: primero se recompone el estado (que pinta y mueve el foco
   * al encabezado del paso 2) y DESPUÉS se devuelve el foco al disparador, para
   * que gane el disparador. Cuando el cierre viene de una transición a otro
   * paso (\`goToStep\` ya ha cambiado \`state.step\`), aquí no se recompone nada y
   * el foco del disparador lo pisará luego el encabezado del paso de destino,
   * que es justo lo que se quiere.
   */
  function onDrawerClose() {
    var trigger = state.drawerTrigger;
    state.drawerTrigger = null;
    if (state.step === 3) goToStep(2);
    if (trigger && trigger.focus) trigger.focus();
  }

  // ---------------------------------------------------------------------
  // Resumen (columna izquierda) y botón "Continuar"
  // ---------------------------------------------------------------------
  function serviceById(id) {
    if (!state.bootstrap) return null;
    for (var i = 0; i < state.bootstrap.services.length; i += 1) {
      if (state.bootstrap.services[i].serviceId === id) return state.bootstrap.services[i];
    }
    return null;
  }
  function employeeById(id) {
    if (!state.bootstrap) return null;
    for (var i = 0; i < state.bootstrap.employees.length; i += 1) {
      if (state.bootstrap.employees[i].employeeId === id) return state.bootstrap.employees[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // COMPATIBILIDAD ENTRE SERVICIO Y PROFESIONAL — UNA SOLA FUENTE
  //
  // \`bootstrap.employees[].serviceIds\` es la MISMA matriz con la que el
  // servidor decide qué huecos ofrece. No se lee de \`data-service-ids\` del
  // marcado (que sólo existe para que la página pueda pintarse antes de que
  // llegue el bootstrap) ni de ninguna regla escrita por nombre: dos fuentes
  // para el mismo hecho es una que miente en cuanto cambie la otra.
  // ---------------------------------------------------------------------
  function employeeDoesService(employeeId, serviceId) {
    if (employeeId === null || serviceId === null) return false;
    var emp = employeeById(employeeId);
    if (!emp) return false;
    return emp.serviceIds.indexOf(serviceId) !== -1;
  }

  /** ¿Se puede pedir disponibilidad con lo que hay elegido ahora mismo? */
  function pairIsBookable() {
    return employeeDoesService(state.employeeId, state.serviceId);
  }

  /**
   * Lo que se dice en voz alta cuando un CTA obliga a descartar la otra mitad
   * de la elección. Los nombres y las etiquetas salen del bootstrap: aquí no se
   * escribe el nombre de ninguna persona ni el de ningún servicio.
   */
  function announceIncompatible(emp, svc, queSeHaQuitado) {
    if (!emp || !svc) return;
    announce(emp.displayName + ' no realiza ' + svc.label + '. ' + queSeHaQuitado);
  }

  /**
   * Deshabilita los CTA de las fichas de equipo de quien no puede realizar el
   * servicio elegido AHORA MISMO, y los vuelve a habilitar en cuanto cambia. Se
   * llama tras el bootstrap y tras cada cambio de servicio.
   *
   * Sin servicio elegido no hay nada incompatible: todos quedan habilitados.
   */
  function refreshProfessionalCtas() {
    if (!state.bootstrap) return;
    var botones = document.querySelectorAll('.txb-cta-profesional');
    for (var i = 0; i < botones.length; i += 1) {
      var boton = botones[i];
      var id = Number(boton.getAttribute('data-employee-id'));
      boton.disabled = state.serviceId !== null && !employeeDoesService(id, state.serviceId);
    }
  }

  /**
   * EL RÓTULO DE ARRANQUE DE LA COLUMNA DEL RESUMEN.
   *
   * POR QUÉ EXISTE. Los cuatro bloques del resumen nacen ocultos, así que antes
   * de elegir nada la columna izquierda del asistente era una tarjeta vacía con
   * un botón «Continuar» apagado dentro. Este rótulo dice qué es esa columna y
   * qué va a aparecer en ella, y se retira en cuanto hay algo de verdad que
   * enseñar.
   *
   * POR QUÉ LO PINTA EL CLIENTE Y NO LA PLANTILLA. Es un nodo del ASISTENTE, y
   * el asistente es de este fichero: quien lo enseña y quien lo esconde es el
   * mismo código que enseña y esconde los otros cuatro bloques, con el mismo
   * \`hidden\`, en la misma función y en el mismo instante. Servirlo desde el
   * marcado obligaría a que dos ficheros se pusieran de acuerdo sobre cuándo
   * desaparece, que es exactamente el tipo de acoplamiento que se rompe en
   * silencio. Se cuelga DELANTE de \`#txb-resumen-servicio\`, que es el primer
   * bloque de la columna, así que ocupa el sitio que va a ocupar su relevo.
   *
   * NO LLEVA IDENTIFICADOR, y es deliberado: el cliente se queda con la
   * referencia y no vuelve a buscarlo nunca. Un \`id\` nuevo sería un contrato
   * nuevo entre el cliente y la plantilla —lo que vigila
   * \`contratoDeIdentificadores.test.ts\`— sin ninguna necesidad, porque la
   * plantilla no emite este nodo.
   *
   * EL TEXTO ES CHROME, no contenido del local: describe la pantalla, no el
   * negocio. Por eso vive aquí, compartido por los dos locales, igual que
   * «Elige un servicio» o «Continuar». Ni una cifra, ni un horario, ni una
   * promesa, ni un dato de contacto: nada que un local pudiera necesitar
   * cambiar.
   */
  var asideIntro = null;

  function buildAsideIntro() {
    var primerBloque = byId('txb-resumen-servicio');
    var columna = primerBloque === null ? null : primerBloque.parentNode;
    if (columna === null) return;
    asideIntro = el('div', 'txb-summary-intro');
    asideIntro.appendChild(el('p', 'txb-summary-intro__title', 'Aquí aparecerá tu reserva'));
    asideIntro.appendChild(el('p', 'txb-summary-intro__text', 'Se irá completando con el servicio, la persona que te atiende y el día y la hora, según los vayas eligiendo.'));
    columna.insertBefore(asideIntro, primerBloque);
  }

  function updateAsideSummary() {
    var svc = state.serviceId === null ? null : serviceById(state.serviceId);
    // El rótulo de arranque se va en cuanto hay una elección, y vuelve si se
    // deshacen todas (por ejemplo, al empezar otra reserva).
    if (asideIntro !== null) setHidden(asideIntro, state.serviceId !== null || state.employeeId !== null);
    setHidden(byId('txb-resumen-servicio'), !svc);
    if (svc) {
      byId('txb-resumen-servicio-nombre').textContent = svc.label;
      byId('txb-resumen-servicio-meta').textContent = svc.durationLabel + ' · ' + svc.priceLabel;
    }

    var emp = state.employeeId === null ? null : employeeById(state.employeeId);
    setHidden(byId('txb-resumen-profesional'), !emp);
    if (emp) byId('txb-resumen-profesional-nombre').textContent = emp.displayName;

    var fechaBloque = byId('txb-resumen-fecha-bloque');
    setHidden(fechaBloque, state.step < 3 || !state.date);
    if (state.date) {
      var chips = byId('txb-resumen-fecha-chips');
      clearChildren(chips);
      var chip = el('span', 'txb-chip', formatDateLong(state.date));
      chip.setAttribute('aria-pressed', 'true');
      chips.appendChild(chip);
    }

    var horaNode = byId('txb-resumen-hora');
    if (state.startMinutes !== null && state.date) {
      horaNode.textContent = formatDateLong(state.date) + ' · ' + formatMinutes(state.startMinutes) + (emp ? ' · ' + emp.displayName : '');
      setHidden(horaNode, false);
    } else {
      setHidden(horaNode, true);
    }
  }

  function updateAsideContinue() {
    var btn = byId('txb-btn-continuar');
    if (state.step === 1) {
      setHidden(btn, false);
      btn.disabled = state.serviceId === null;
      btn.textContent = 'Continuar';
    } else if (state.step === 2) {
      setHidden(btn, false);
      btn.disabled = state.employeeId === null;
      btn.textContent = 'Continuar';
    } else {
      setHidden(btn, true);
    }
  }

  // ---------------------------------------------------------------------
  // Paso 1 — Servicio
  // ---------------------------------------------------------------------
  function renderServiceStep() {
    var grid = byId('txb-servicios-grid');
    clearChildren(grid);
    state.bootstrap.services.forEach(function (svc) {
      var tile = el('button', 'txb-tile');
      tile.type = 'button';
      tile.setAttribute('aria-pressed', svc.serviceId === state.serviceId ? 'true' : 'false');
      tile.appendChild(el('span', 'txb-tile__name', svc.label));
      tile.appendChild(el('span', 'txb-tile__meta', svc.durationLabel));
      tile.appendChild(el('span', 'txb-tile__price', svc.priceLabel));
      tile.addEventListener('click', function () { selectService(svc.serviceId); });
      grid.appendChild(tile);
    });
  }

  /**
   * Cambiar de servicio invalida la fecha y la hora, que dependían del
   * anterior: nada se arrastra a medias.
   *
   * Al profesional ya elegido se le aplica la REGLA DURA en vez de borrarlo
   * siempre: si realiza el servicio nuevo se conserva —es lo que la persona
   * pidió al pulsar el CTA de su ficha, y borrárselo la obligaría a elegirlo
   * dos veces—, y si no lo realiza se descarta y se dice por qué. Lo que no
   * puede pasar nunca es que los dos convivan en el estado.
   */
  function selectService(serviceId) {
    if (state.serviceId !== serviceId) {
      var descartado = employeeDoesService(state.employeeId, serviceId) ? null : employeeById(state.employeeId);
      state.serviceId = serviceId;
      if (descartado) {
        state.employeeId = null;
        announceIncompatible(descartado, serviceById(serviceId), 'Elige a otra persona del equipo.');
      }
      resetDateSelection();
    }
    renderServiceStep();
    refreshProfessionalCtas();
    updateAsideSummary();
    updateAsideContinue();
  }

  // ---------------------------------------------------------------------
  // Paso 2 — Profesional
  // ---------------------------------------------------------------------
  function renderEmployeeStep() {
    var grid = byId('txb-profesionales-grid');
    clearChildren(grid);
    var svc = serviceById(state.serviceId);
    var anyDisabled = false;
    state.bootstrap.employees.forEach(function (emp) {
      var capaz = svc ? emp.serviceIds.indexOf(svc.serviceId) !== -1 : false;
      if (!capaz) anyDisabled = true;
      var tile = el('button', 'txb-tile');
      tile.type = 'button';
      tile.disabled = !capaz;
      tile.setAttribute('aria-pressed', emp.employeeId === state.employeeId ? 'true' : 'false');
      tile.appendChild(el('span', 'txb-tile__name', emp.displayName));
      if (!capaz) tile.appendChild(el('span', 'txb-tile__meta', 'No realiza este servicio'));
      tile.addEventListener('click', function () { if (capaz) selectEmployee(emp.employeeId); });
      grid.appendChild(tile);
    });
    setHidden(byId('txb-profesional-nota'), !anyDisabled);
  }

  function selectEmployee(employeeId) {
    if (state.employeeId !== employeeId) {
      state.employeeId = employeeId;
      resetDateSelection();
    }
    renderEmployeeStep();
    updateAsideSummary();
    updateAsideContinue();
  }

  // ---------------------------------------------------------------------
  // Paso 3 — Fecha y hora
  // ---------------------------------------------------------------------
  function resetDateSelection() {
    // Cambiar de servicio o de persona invalida cualquier búsqueda automática
    // que estuviera en vuelo: su respuesta hablaría del par anterior.
    invalidarBusquedaDeDia();
    state.date = null;
    state.availability = null;
    state.startMinutes = null;
    state.paymentOption = null;
  }

  function horizonBounds() {
    var today = state.bootstrap.demoToday;
    var last = addDaysISO(today, state.bootstrap.bookingHorizonDays - 1);
    return { first: today, last: last };
  }

  /**
   * ENTRAR EN EL PASO 3 NUNCA DEJA LA PANTALLA EN BLANCO.
   *
   * Hasta el 2026-08-26 este paso se abría sin ningún día marcado: la rejilla
   * vacía, el título de horarios en blanco y la leyenda de disponibilidad
   * flotando sola sobre un cuarto de pantalla de nada, esperando a que alguien
   * adivinara que había que pulsar un día. Quien llega aquí ya ha dicho QUÉ
   * quiere y CON QUIÉN: lo único que le falta es ver horas.
   *
   * Con un día ya elegido —volver atrás y entrar otra vez, por ejemplo— se
   * respeta lo que la persona eligió y sólo se recarga su disponibilidad. Sin
   * él, se BUSCA uno (ver \`buscarPrimerDiaConHuecos\`), y hasta que esa búsqueda
   * conteste la zona de horarios queda en su estado neutro, sin leyenda huérfana.
   */
  function enterDateStep() {
    var anchor = state.date || state.bootstrap.demoToday;
    var parts = parseISODateParts(anchor);
    state.calendarYear = parts.y;
    state.calendarMonth = parts.m;
    renderCalendar();
    renderDayChips();
    if (state.date) { return loadAvailability(); }
    renderNoSelectionYet();
    return buscarPrimerDiaConHuecos();
  }

  function renderNoSelectionYet() {
    byId('txb-horarios-titulo').textContent = '';
    clearChildren(byId('txb-rejilla'));
    // Sin rejilla no hay nada que descifrar: la leyenda se va con ella.
    mostrarLeyenda(false);
    setHidden(byId('txb-seleccion-resumen'), true);
    setHidden(byId('txb-pago'), true);
    setHidden(byId('txb-pago-simulado-nota'), true);
    setHidden(byId('txb-btn-confirmar'), true);
  }

  /**
   * LA LEYENDA DE DISPONIBILIDAD, QUE SÓLO EXISTE SI HAY REJILLA.
   *
   * «✓ Disponible – No disponible» explica los glifos de la tabla de huecos. Sin
   * tabla no explica nada, y era justo lo único que se veía al abrir el paso 3:
   * una leyenda suelta sobre un espacio en blanco. Se localiza recorriendo los
   * hermanos de la rejilla —no con un identificador nuevo, que obligaría a tocar
   * la plantilla, ni con un selector, que ensancharía el contrato de selectores
   * del cliente— y se oculta con \`hidden\`, el mismo mecanismo con el que se
   * esconde todo lo demás de este fichero. Nunca con \`.style\`: la CSP no admite
   * estilo en línea.
   */
  function leyendaDeDisponibilidad() {
    var rejilla = byId('txb-rejilla');
    var padre = rejilla ? rejilla.parentNode : null;
    if (!padre) return null;
    var hermanos = padre.children;
    for (var i = 0; i < hermanos.length; i += 1) {
      if (hermanos[i].classList.contains('txb-legend')) return hermanos[i];
    }
    return null;
  }

  function mostrarLeyenda(visible) {
    var nodo = leyendaDeDisponibilidad();
    if (nodo) setHidden(nodo, !visible);
  }

  function renderCalendar() {
    var bounds = horizonBounds();
    byId('txb-mes-titulo').textContent = MONTHS[state.calendarMonth - 1].charAt(0).toUpperCase() + MONTHS[state.calendarMonth - 1].slice(1) + ' ' + state.calendarYear;
    var body = byId('txb-mes-grid-body');
    clearChildren(body);
    var weeks = monthMatrix(state.calendarYear, state.calendarMonth);
    weeks.forEach(function (week) {
      var tr = el('tr');
      week.forEach(function (iso) {
        var td = el('td');
        if (iso) {
          var parts = parseISODateParts(iso);
          var btn = el('button', 'txb-day-btn', String(parts.d));
          btn.type = 'button';
          var dentroDeHorizonte = iso >= bounds.first && iso <= bounds.last;
          btn.disabled = !dentroDeHorizonte;
          btn.setAttribute('aria-pressed', iso === state.date ? 'true' : 'false');
          if (dentroDeHorizonte) btn.addEventListener('click', function () { selectDate(iso); });
          td.appendChild(btn);
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function changeMonth(delta) {
    var m = state.calendarMonth + delta;
    var y = state.calendarYear;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    state.calendarMonth = m;
    state.calendarYear = y;
    renderCalendar();
  }

  /** Los días de una semana. No es una preferencia: es cuántos días tiene. */
  var DIAS_POR_SEMANA = 7;

  /**
   * El lunes de la semana que contiene esa fecha. La aritmética de abajo
   * convierte el domingo-primero del motor de fechas en el lunes-primero con el
   * que se lee un calendario en español — la MISMA conversión que ya usa
   * firstWeekdayMonSun para la rejilla del mes, para que la tira de la semana y
   * la rejilla del mes no puedan discrepar nunca sobre qué columna es cada día.
   */
  function mondayOfWeekISO(iso) {
    var d = dateFromISO(iso);
    return addDaysISO(iso, -((d.getDay() + 6) % 7));
  }

  /**
   * LA VISTA SEMANAL, ANCLADA AL LUNES — no una ventana que se arrastra.
   *
   * Antes pintaba «el día elegido y dos a cada lado», y eso tenía dos defectos.
   * Uno de cantidad: en el primer día del horizonte los dos anteriores caen
   * fuera y sólo quedaban TRES chips, que no es una semana. Y otro peor, de
   * estabilidad: cada clic recentraba la tira, así que los días se movían de
   * sitio bajo el dedo y el que acababas de pulsar saltaba al centro. Una tira
   * que se reordena sola no se puede recorrer.
   *
   * Anclando al LUNES, la semana es una cosa fija: los siete días ocupan
   * siempre la misma posición, pulsar dentro de la semana no mueve nada, y
   * elegir un día de otra semana en la rejilla del mes cambia la tira ENTERA de
   * una vez. Además coincide columna a columna con la rejilla del mes que hay
   * justo encima (L M X J V S D), que es lo que permite mirar las dos y
   * entender que hablan del mismo día.
   *
   * El horizonte no recorta la semana: los días de fuera se pintan —para que la
   * semana siga teniendo siete columnas y el sábado siga estando donde estaba—
   * pero nacen DESHABILITADOS y sin manejador, así que no se pueden ofrecer.
   */
  function renderDayChips() {
    var bounds = horizonBounds();
    var row = byId('txb-dia-chips');
    clearChildren(row);
    var lunes = mondayOfWeekISO(state.date || state.bootstrap.demoToday);
    for (var i = 0; i < DIAS_POR_SEMANA; i += 1) {
      var iso = addDaysISO(lunes, i);
      var info = formatDateChip(iso);
      var chip = el('button', 'txb-chip');
      chip.type = 'button';
      chip.appendChild(el('span', null, info.weekday));
      chip.appendChild(el('span', null, String(info.day)));
      var ofrecible = iso >= bounds.first && iso <= bounds.last;
      chip.disabled = !ofrecible;
      chip.setAttribute('aria-pressed', iso === state.date ? 'true' : 'false');
      if (ofrecible) {
        chip.addEventListener('click', function (isoCapturado) {
          return function () { selectDate(isoCapturado); };
        }(iso));
      }
      row.appendChild(chip);
    }
  }

  function selectDate(iso) {
    // GANA LA PERSONA. Elegir un día a mano invalida la búsqueda automática que
    // pudiera estar en vuelo: su respuesta, si llega después, se descarta.
    invalidarBusquedaDeDia();
    state.date = iso;
    state.startMinutes = null;
    state.paymentOption = null;
    var parts = parseISODateParts(iso);
    state.calendarYear = parts.y;
    state.calendarMonth = parts.m;
    renderCalendar();
    renderDayChips();
    updateAsideSummary();
    return loadAvailability();
  }

  // ---------------------------------------------------------------------
  // EL DÍA QUE SE ELIGE SOLO — Y QUE NO CALCULA NADA
  //
  // Este bloque NO sabe qué días abre el local, ni a qué hora, ni cuánto dura un
  // servicio, ni cuál es el último inicio que cabe antes del cierre. No puede
  // saberlo: eso lo decide el motor de calendario del servidor, y una segunda
  // copia de esa decisión aquí sería una segunda verdad —exactamente el defecto
  // que ya costó una hora de corte inventada a las 12:00 en la rejilla—.
  //
  // Lo único que hace es PREGUNTAR: pide \`/availability\` de un día y mira si la
  // lista de inicios que contesta el servidor viene vacía. Si viene vacía, ese
  // día no sirve —da igual si es porque el local cierra, porque la persona libra
  // o porque ya está todo reservado: las tres cosas se ven igual desde aquí y
  // las tres significan lo mismo para quien mira la pantalla— y se pregunta por
  // el siguiente. Los huecos que se pintan y se habilitan siguen siendo, uno a
  // uno, los que el servidor ha marcado como libres.
  // ---------------------------------------------------------------------

  /**
   * EL TOPE. Como mucho se consulta UNA SEMANA de días, la misma que pinta la
   * tira de chips: siete peticiones en el peor caso, y no una cascada que
   * recorra el horizonte entero de reserva llamando treinta veces al servidor
   * porque el local esté cerrado por vacaciones. Si en esa semana no aparece ni
   * un hueco, se deja seleccionado el último día consultado y se enseña el
   * mensaje de vacío que ya existe: una pantalla que dice «no hay nada ese día»
   * informa; una pantalla en blanco con una leyenda encima, no.
   */
  var PRESELECCION_DIAS_MAXIMOS = DIAS_POR_SEMANA;

  /**
   * EL SELLO DE LA BÚSQUEDA VIGENTE, que es cómo se resuelve la carrera.
   *
   * La búsqueda automática es una cadena de peticiones, y mientras corre la
   * persona puede pulsar un día, cambiar de servicio o salirse del paso. Cada
   * una de esas acciones sube el sello; la cadena lleva anotado el suyo y lo
   * compara ANTES de pedir el día siguiente y ANTES de tocar el estado con lo
   * que llegue. Si no coinciden, se retira en silencio.
   *
   * Un contador y no un booleano: con dos búsquedas encadenadas (entrar al paso
   * 3, salir y volver a entrar) un booleano no distingue «la mía sigue viva» de
   * «hay alguna viva», y la vieja podría pisar a la nueva.
   */
  var selloDeBusquedaDeDia = 0;

  function invalidarBusquedaDeDia() {
    selloDeBusquedaDeDia += 1;
    return selloDeBusquedaDeDia;
  }

  /**
   * Arranca la búsqueda en el PRIMER día del horizonte —el que publica el propio
   * bootstrap, nunca el reloj del navegador— y se detiene en el primero que
   * devuelva algún inicio.
   *
   * No se dispara desde el arranque de la página, sino al ENTRAR en el paso 3.
   * La diferencia importa: el primer pintado no puede mover ni el foco ni el
   * desplazamiento (ver \`primerPintado\`), y quien abre la web tiene que aterrizar
   * en la portada. Aquí, además, se comprueba explícitamente esa guarda, para
   * que la regla siga siendo cierta aunque mañana alguien llame a \`goToStep(3)\`
   * desde el arranque.
   */
  function buscarPrimerDiaConHuecos() {
    if (primerPintado) return undefined;
    if (state.date) return undefined;
    if (!pairIsBookable()) return undefined;
    // Igual que \`loadAvailability\`: un error de una consulta anterior no puede
    // quedarse colgado encima de una rejilla que sí se ha pintado.
    clearError();
    var bounds = horizonBounds();
    return probarDiaParaPreseleccion(bounds.first, PRESELECCION_DIAS_MAXIMOS, invalidarBusquedaDeDia(), bounds);
  }

  function probarDiaParaPreseleccion(iso, intentosRestantes, sello, bounds) {
    if (sello !== selloDeBusquedaDeDia) return undefined;
    if (iso > bounds.last) return undefined;
    return requestJson('GET', availabilityPath(iso)).then(function (r) {
      if (sello !== selloDeBusquedaDeDia) return;
      if (r.status !== 200) {
        showError(r.json.message || 'No se ha podido consultar la disponibilidad.');
        return;
      }
      var siguiente = addDaysISO(iso, 1);
      var seguirBuscando = r.json.starts.length === 0 && intentosRestantes > 1 && siguiente <= bounds.last;
      if (seguirBuscando) {
        probarDiaParaPreseleccion(siguiente, intentosRestantes - 1, sello, bounds);
        return;
      }
      fijarDiaPreseleccionado(iso, r.json);
    }, function () {
      if (sello !== selloDeBusquedaDeDia) return;
      showError('No se ha podido contactar con el servidor de la demostración.');
    });
  }

  /**
   * Deja el día encontrado como si lo hubiera pulsado la persona —marcado en la
   * tira de la semana, marcado en la rejilla del mes, escrito en el resumen— y
   * pinta la disponibilidad QUE YA SE HA PEDIDO, sin una segunda llamada por el
   * mismo día.
   */
  function fijarDiaPreseleccionado(iso, avail) {
    state.date = iso;
    state.startMinutes = null;
    state.paymentOption = null;
    var parts = parseISODateParts(iso);
    state.calendarYear = parts.y;
    state.calendarMonth = parts.m;
    state.availability = avail;
    renderCalendar();
    renderDayChips();
    updateAsideSummary();
    renderSlots();
  }

  /**
   * LA PUERTA POR LA QUE NO PASA EL PAR IMPOSIBLE.
   *
   * Preguntar por la disponibilidad de un servicio con quien no lo realiza no
   * es sólo una respuesta vacía: es publicar en la barra de direcciones —y en
   * los registros del servidor— una combinación que el catálogo no admite. La
   * comprobación vive AQUÍ, en el único punto por el que pasan todas las
   * llamadas, y no en cada sitio que podría provocarla: una guarda por sitio se
   * olvida el día que se añade el sitio número cuatro.
   */
  function loadAvailability() {
    clearError();
    if (!pairIsBookable()) {
      renderNoSelectionYet();
      return undefined;
    }
    return requestJson('GET', availabilityPath(state.date)).then(function (r) {
      if (r.status !== 200) {
        showError(r.json.message || 'No se ha podido consultar la disponibilidad.');
        renderNoSelectionYet();
        return;
      }
      state.availability = r.json;
      renderSlots();
    }, function () {
      showError('No se ha podido contactar con el servidor de la demostración.');
    });
  }

  /**
   * La ruta de una consulta de disponibilidad. UNA sola función la compone, y la
   * usan tanto la carga del día elegido como la búsqueda automática: dos sitios
   * armando la misma consulta a mano acabarían discrepando en el día en que se
   * añada un parámetro.
   *
   * QUÉ CAMBIA EL INTERRUPTOR «Vista día completa»: NO cuántos bloques hay
   * —los tramos de apertura separan la jornada en las DOS vistas— sino QUÉ se
   * lista dentro de cada bloque.
   *
   *   · Apagado: se pregunta FILTRANDO por la persona elegida, y la rejilla
   *     lista sólo sus inicios libres. Una columna, todo disponible.
   *   · Encendido: se pregunta SIN filtrar, y el servidor devuelve una
   *     columna por cada persona capaz y la unión de sus inicios libres. Ahí
   *     aparecen las horas en las que la persona elegida NO puede —marcadas
   *     con «–» y no pulsables— junto a las de quien sí, que es exactamente
   *     la jornada de la maqueta aprobada.
   *
   * El cliente NO calcula ni una hora para conseguirlo: se limita a pedir la
   * misma ruta con un filtro menos. Toda hora que se pinta la ha devuelto el
   * servidor, y sólo es pulsable donde ese mismo servidor dice que está
   * libre. La persona elegida sigue siendo la del estado: quitar el filtro
   * cambia lo que se MIRA, nunca lo que se ha elegido.
   */
  function availabilityPath(date) {
    var path = '/availability?serviceId=' + state.serviceId + '&date=' + date;
    if (!state.fullDayView) path += '&employeeId=' + state.employeeId;
    return path;
  }

  /**
   * El rótulo del ÚNICO bloque que no se corresponde con ningún tramo
   * publicado: el de resguardo de \`groupSlots\`, el que recoge un inicio que no
   * cayera dentro de ningún tramo. Viene de model.ts —la misma constante con la
   * que el SERVIDOR rotula el día que sólo abre una vez—, interpolada aquí para
   * que no haya dos textos distintos para la misma idea.
   *
   * Ojo con la tentación de usarla para otra cosa. Hasta el 2026-08-26 rotulaba
   * también la vista de jornada completa, que fundía los dos tramos reales del
   * día en un solo bloque llamado «Horario». Eso era mentir dos veces: borraba
   * de la pantalla el cierre de mediodía —que es un hecho del local, no una
   * preferencia de vista— y reutilizaba para «aquí caben todas las horas» una
   * etiqueta que significa «este día abre de una sentada». El sábado de este
   * local se rotula así porque el MOTOR devuelve un único tramo con esa
   * etiqueta, no porque el cliente decida fundir nada.
   */
  var ETIQUETA_TRAMO_UNICO = '${OPENING_WINDOW_SINGLE_LABEL}';

  /**
   * Agrupa los inicios YA DEVUELTOS por el servidor por CONTENCIÓN en los
   * tramos de apertura que ese mismo servidor publica en \`avail.windows\`:
   * un inicio pertenece al tramo que lo contiene (\`[startMinutes,
   * endMinutes)\`), y punto. No se compara con ninguna hora escrita aquí, no
   * se mide el hueco entre inicios y no se reordena nada: el orden de los
   * tramos es el que trae la respuesta.
   *
   * Un tramo sin ningún hueco libre no pinta bloque (un rótulo de tramo sobre
   * una tabla vacía no informa de nada). Un inicio que no cayera en ningún
   * tramo —que no debería ocurrir jamás, porque los huecos salen del mismo
   * calendario que los tramos— se recoge en un bloque final en vez de
   * desaparecer en silencio: perder una hora ofrecible sería peor que
   * rotularla de forma genérica.
   *
   * LA AGRUPACIÓN ES LA MISMA EN LAS DOS VISTAS, y esto es lo que se corrigió
   * el 2026-08-26: el interruptor de jornada completa devolvía aquí un solo
   * bloque con el día entero, así que encenderlo hacía desaparecer el cierre
   * de mediodía de la pantalla. Mañana y tarde están separadas porque el LOCAL
   * cierra a mediodía, y eso no deja de ser cierto porque alguien quiera ver
   * más horas. Quien decide cuántos tramos hay y cómo se llaman sigue siendo el
   * servidor, en \`avail.windows\`.
   */
  function groupSlots(avail) {
    if (avail.starts.length === 0) return [];

    var windows = avail.windows || [];
    function contiene(w, s) {
      return s.startMinutes >= w.startMinutes && s.startMinutes < w.endMinutes;
    }

    var groups = [];
    windows.forEach(function (w) {
      var dentro = avail.starts.filter(function (s) { return contiene(w, s); });
      if (dentro.length > 0) groups.push({ window: w, starts: dentro });
    });

    var huerfanos = avail.starts.filter(function (s) {
      return !windows.some(function (w) { return contiene(w, s); });
    });
    if (huerfanos.length > 0) groups.push({ window: null, starts: huerfanos });

    return groups;
  }

  /**
   * El rótulo del bloque: la ETIQUETA del tramo y su rango de APERTURA, los
   * dos tal y como los publica el servidor. Se usa el rango del tramo y no el
   * del primer y último hueco libre a propósito: así el rótulo de un tramo
   * sigue diciendo lo mismo cuando ya sólo quedan dos huecos sueltos dentro
   * de él.
   */
  function blockTitle(group) {
    if (!group.window) return ETIQUETA_TRAMO_UNICO;
    return group.window.label + ' · ' + group.window.rangeLabel;
  }

  function renderSlots() {
    var avail = state.availability;
    byId('txb-horarios-titulo').textContent = 'Horarios del ' + formatDateLong(state.date);
    var container = byId('txb-rejilla');
    clearChildren(container);

    if (!avail.withinHorizon) {
      mostrarLeyenda(false);
      container.appendChild(el('p', 'txb-status-line txb-status-line--error', 'Esa fecha queda fuera del horizonte de reserva de esta demostración.'));
      return;
    }
    if (avail.starts.length === 0) {
      mostrarLeyenda(false);
      container.appendChild(el('p', 'txb-status-line txb-status-line--error', 'No hay ningún hueco disponible ese día.'));
      return;
    }

    var employees = avail.byEmployee;
    // Sólo ahora hay tabla que descifrar, y por tanto leyenda que leer.
    mostrarLeyenda(true);
    var groups = groupSlots(avail);
    var wrap = el('div', 'txb-slots-blocks');
    groups.forEach(function (group) {
      var block = el('div', 'txb-slots-block');
      block.appendChild(el('p', 'txb-slots-block__title', blockTitle(group)));
      var table = el('table', 'txb-slots-table');
      // UNA SOLA COLUMNA DE PERSONA NO ES UNA TABLA COMPARATIVA: es una lista de
      // horas, y leerla como una hoja de cálculo de una columna —hora, ✓, hora,
      // ✓— es exactamente lo que señaló la revisión de producto. La estructura no
      // cambia (sigue siendo la misma tabla, con los mismos glifos y los mismos
      // nombres accesibles, que es lo que la hace legible con lector de pantalla
      // en las dos vistas): lo que cambia es que aquí se MARCA el caso, y la hoja
      // de estilos lo presenta como fichas de hora. Quién decide cuántas columnas
      // hay sigue siendo el servidor, en \`byEmployee\`.
      if (employees.length === 1) table.classList.add('txb-slots-table--una-columna');
      var thead = el('thead');
      var headRow = el('tr');
      headRow.appendChild(el('th', null, 'Hora'));
      employees.forEach(function (emp) { headRow.appendChild(el('th', null, emp.displayName)); });
      thead.appendChild(headRow);
      table.appendChild(thead);
      var tbody = el('tbody');
      group.starts.forEach(function (s) {
        var tr = el('tr');
        tr.appendChild(el('td', null, s.label));
        employees.forEach(function (emp) {
          var td = el('td');
          var disponible = emp.starts.some(function (x) { return x.startMinutes === s.startMinutes; });
          var btn = el('button', 'txb-slot-btn', disponible ? '✓' : '–');
          btn.type = 'button';
          btn.disabled = !disponible;
          btn.setAttribute('aria-pressed', (state.employeeId === emp.employeeId && state.startMinutes === s.startMinutes) ? 'true' : 'false');
          btn.setAttribute('aria-label', (disponible ? 'Disponible' : 'No disponible') + ' ' + s.label + ' con ' + emp.displayName);
          if (disponible) {
            btn.addEventListener('click', function () { selectSlot(emp.employeeId, s.startMinutes); });
          }
          td.appendChild(btn);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      block.appendChild(table);
      wrap.appendChild(block);
    });
    container.appendChild(wrap);
  }

  function selectSlot(employeeId, startMinutes) {
    state.employeeId = employeeId;
    state.startMinutes = startMinutes;
    state.paymentOption = null;
    state.idempotencyKey = nextIdempotencyKey();
    renderSlots();
    updateAsideSummary();

    var emp = employeeById(employeeId);
    var resumen = byId('txb-seleccion-resumen');
    resumen.textContent = formatDateLong(state.date) + ' · ' + formatMinutes(startMinutes) + ' · ' + (emp ? emp.displayName : '');
    setHidden(resumen, false);

    renderPaymentSection();
  }

  function renderPaymentSection() {
    var svc = serviceById(state.serviceId);
    byId('txb-pago-precio').textContent = svc ? svc.priceLabel : '';
    setHidden(byId('txb-pago'), false);
    setHidden(byId('txb-pago-simulado-nota'), false);
    setHidden(byId('txb-btn-confirmar'), false);
    byId('txb-pago-ahora').checked = state.paymentOption === 'pay_now_demo';
    byId('txb-pago-local').checked = state.paymentOption === 'pay_at_salon';
    updateConfirmButton();
  }

  function onPaymentChange(value) {
    state.paymentOption = value;
    updateConfirmButton();
  }

  function updateConfirmButton() {
    var btn = byId('txb-btn-confirmar');
    btn.disabled = !state.paymentOption || state.startMinutes === null;
  }

  function confirmBooking() {
    clearError();
    var btn = byId('txb-btn-confirmar');
    btn.disabled = true;
    var body = {
      serviceId: state.serviceId,
      employeeId: state.employeeId,
      date: state.date,
      startMinutes: state.startMinutes,
      payment_option: state.paymentOption,
      idempotencyKey: state.idempotencyKey,
    };
    return requestJson('POST', '/book', body).then(function (r) {
      if (r.status !== 200 && r.status !== 201) {
        btn.disabled = false;
        showError(r.json.message || 'No se ha podido confirmar la reserva.');
        if (r.json.code === 'SLOT_TAKEN') {
          state.startMinutes = null;
          state.paymentOption = null;
          state.idempotencyKey = null;
          loadAvailability();
        }
        return;
      }
      state.lastBooking = r.json.booking;
      state.lastMessages = r.json.messages || [];
      renderConfirmation();
      goToStep(4);
    }, function () {
      btn.disabled = false;
      showError('No se ha podido contactar con el servidor de la demostración.');
    });
  }

  function renderConfirmation() {
    var b = state.lastBooking;
    var msgs = byId('txb-confirm-mensajes');
    clearChildren(msgs);
    state.lastMessages.forEach(function (m) {
      msgs.appendChild(el('p', 'txb-status-line txb-status-line--ok', m));
    });

    var tbody = byId('txb-confirm-detalle');
    clearChildren(tbody);
    function row(label, value) {
      var tr = el('tr');
      tr.appendChild(el('td', null, label));
      tr.appendChild(el('td', null, value));
      tbody.appendChild(tr);
    }
    row('Servicio', b.labels.service);
    row('Profesional', b.labels.employee);
    row('Fecha y hora', b.labels.when);
    row('Forma de pago', b.labels.paymentOption);
    var estadoTd = el('td');
    estadoTd.appendChild(estadoPill(b.payment.payment_status, b.labels.paymentStatus));
    var estadoTr = el('tr');
    estadoTr.appendChild(el('td', null, 'Estado del pago'));
    estadoTr.appendChild(estadoTd);
    tbody.appendChild(estadoTr);
    row('Importe total', b.labels.amountTotal);
    row('Pagado', b.labels.amountPaid);
    row('Pendiente en peluquería', b.labels.amountDue);
  }

  function estadoPill(status, label) {
    var cls = status === 'demo_paid' ? 'txb-pill txb-pill--paid' : 'txb-pill txb-pill--pending';
    return el('span', cls, label);
  }

  // ---------------------------------------------------------------------
  // Reinicio del asistente ("Hacer otra reserva")
  // ---------------------------------------------------------------------
  function startOver() {
    state.serviceId = null;
    state.employeeId = null;
    resetDateSelection();
    state.lastBooking = null;
    state.lastMessages = [];
    clearError();
    updateAsideSummary();
    renderServiceStep();
    // Sin servicio elegido no hay nadie incompatible: los CTA de las fichas de
    // equipo vuelven a estar todos disponibles.
    refreshProfessionalCtas();
    goToStep(1);
  }

  // ---------------------------------------------------------------------
  // Pestañas — Reservar / Panel de reservas
  // ---------------------------------------------------------------------
  function switchView(view) {
    state.view = view;
    setHidden(byId('txb-vista-reserva'), view !== 'reserva');
    setHidden(byId('txb-vista-dashboard'), view !== 'dashboard');
    byId('txb-tab-reserva').setAttribute('aria-pressed', view === 'reserva' ? 'true' : 'false');
    byId('txb-tab-dashboard').setAttribute('aria-pressed', view === 'dashboard' ? 'true' : 'false');
    return view === 'dashboard' ? loadDashboard() : undefined;
  }

  function loadDashboard() {
    clearError();
    return requestJson('GET', '/dashboard').then(function (r) {
      if (r.status !== 200) {
        showError(r.json.message || 'No se ha podido cargar el panel de reservas.');
        return;
      }
      state.dashboard = r.json;
      renderDashboard();
    }, function () {
      showError('No se ha podido contactar con el servidor de la demostración.');
    });
  }

  function renderDashboard() {
    var snap = state.dashboard;
    var tbody = byId('txb-dashboard-tbody');
    clearChildren(tbody);
    snap.bookings.forEach(function (b) {
      var tr = el('tr');
      tr.appendChild(el('td', null, b.labels.service));
      tr.appendChild(el('td', null, b.labels.employee));
      tr.appendChild(el('td', null, b.labels.when));
      tr.appendChild(el('td', null, b.labels.amountTotal));
      var estadoTd = el('td');
      estadoTd.appendChild(estadoPill(b.payment.payment_status, b.labels.paymentStatus));
      tr.appendChild(estadoTd);
      tr.appendChild(el('td', null, b.labels.amountPaid));
      tr.appendChild(el('td', null, b.labels.amountDue));
      tbody.appendChild(tr);
    });
    setHidden(byId('txb-dashboard-vacio'), snap.bookings.length !== 0);

    var totalesDl = byId('txb-dashboard-totales');
    clearChildren(totalesDl);
    function totalRow(label, valor) {
      totalesDl.appendChild(el('dt', null, label));
      totalesDl.appendChild(el('dd', null, valor));
    }
    // Los tres importes llegan ya escritos en \`totals.labels\`. Aquí vivía
    // \`formatCents\`, que reimplementaba \`formatEuros\` a mano —dividir entre
    // cien, rellenar los decimales, pegar el símbolo— y era la única cifra de
    // dinero de toda la pantalla que no producía el servidor. Un segundo
    // formateador de la misma unidad no es un atajo: es una segunda verdad
    // esperando a discrepar de la primera el día que cambie la moneda, el
    // separador o el redondeo.
    //
    // «Reservas» no es una unidad: es cuántas hay. Un entero a texto no
    // convierte nada y no puede contradecir a nadie.
    totalRow('Reservas', String(snap.totals.count));
    totalRow('Total', snap.totals.labels.amountTotal);
    totalRow('Pagado', snap.totals.labels.amountPaid);
    totalRow('Pendiente', snap.totals.labels.amountDue);
  }

  // ---------------------------------------------------------------------
  // Reinicio de la demostración
  // ---------------------------------------------------------------------
  function openResetDialog() {
    var dialog = byId('txb-dialog-reset');
    var estado = byId('txb-dialog-reset-estado');
    estado.textContent = '';
    setHidden(estado, true);
    dialog.showModal();
  }

  function confirmReset() {
    var estado = byId('txb-dialog-reset-estado');
    return requestJson('POST', '/reset').then(function (r) {
      if (r.status !== 200) {
        estado.textContent = r.json.message || 'No se ha podido reiniciar la demostración.';
        setHidden(estado, false);
        return;
      }
      byId('txb-dialog-reset').close();
      state.dashboard = null;
      announce('Demostración reiniciada.');
      return loadDashboard();
    }, function () {
      estado.textContent = 'No se ha podido contactar con el servidor de la demostración.';
      setHidden(estado, false);
    });
  }

  // ---------------------------------------------------------------------
  // LOS CTA DE LA PÁGINA PÚBLICA
  //
  // Cada ficha de servicio y cada ficha de equipo llevan su propio botón de
  // reserva. No tienen \`id\` —habría uno por ficha, compuesto por
  // concatenación— sino clase y atributo de datos, así que se enganchan por
  // clase y el identificador se lee del atributo: nunca "el primero de la
  // lista", siempre EL QUE SE HA PULSADO.
  // ---------------------------------------------------------------------

  /**
   * Guarda la intención cuando todavía no ha llegado \`/bootstrap\`. Sin la
   * matriz de compatibilidad no se puede decidir si la elección es posible, y
   * decidir a ciegas es exactamente lo que produciría el par imposible.
   */
  function deferCta(kind, id, trigger) {
    state.pendingCta = { kind: kind, id: id, trigger: trigger || null };
  }

  function applyPendingCta() {
    var pendiente = state.pendingCta;
    if (!pendiente) return;
    state.pendingCta = null;
    if (pendiente.kind === 'service') preselectService(pendiente.id, pendiente.trigger);
    else preselectEmployee(pendiente.id, pendiente.trigger);
  }

  /**
   * CTA de una ficha de SERVICIO: preselecciona ESE servicio y lleva al paso 2,
   * que es lo que falta por decidir. Al profesional ya elegido lo trata
   * \`selectService\`: se conserva si realiza el servicio nuevo y se descarta —en
   * voz alta— si no.
   */
  function preselectService(serviceId, trigger) {
    if (!state.bootstrap) { deferCta('service', serviceId, trigger); return; }
    if (!serviceById(serviceId)) return;
    selectService(serviceId);
    goToStep(2, trigger);
  }

  /**
   * CTA de una ficha de EQUIPO: preselecciona A ESA PERSONA. Con un servicio
   * compatible ya elegido no queda nada por decidir salvo el hueco, así que se
   * abre el cajón del paso 3 directamente. Sin servicio elegido, al paso 1.
   *
   * Y si el servicio elegido es uno que esa persona NO realiza, gana lo recién
   * pulsado: se descarta el servicio, se dice por qué y se vuelve al paso 1
   * —desde donde se puede seguir— en vez de dejar el estado en un par que el
   * catálogo no admite.
   */
  function preselectEmployee(employeeId, trigger) {
    if (!state.bootstrap) { deferCta('employee', employeeId, trigger); return; }
    var emp = employeeById(employeeId);
    if (!emp) return;

    var servicioPrevio = state.serviceId;
    var compatible = employeeDoesService(employeeId, servicioPrevio);

    if (state.employeeId !== employeeId) {
      state.employeeId = employeeId;
      resetDateSelection();
    }

    if (servicioPrevio !== null && !compatible) {
      var svcDescartado = serviceById(servicioPrevio);
      state.serviceId = null;
      resetDateSelection();
      announceIncompatible(emp, svcDescartado, 'Elige otro servicio de los que sí realiza.');
      renderServiceStep();
      refreshProfessionalCtas();
      updateAsideSummary();
      goToStep(1);
      return;
    }

    updateAsideSummary();
    if (compatible) goToStep(3, trigger);
    else goToStep(1);
  }

  // ---------------------------------------------------------------------
  // EL MENÚ MÓVIL
  //
  // Un panel, no un diálogo: aquí SÍ hay que escribir el cierre con \`Escape\`.
  // Lo que NO hay que escribir es cuándo es "móvil": este fichero no mide la
  // ventana ni consulta ningún punto de ruptura —viven en la hoja de estilos—,
  // y no toca ni las clases del documento ni su desplazamiento, así que la
  // página queda exactamente igual que estaba después de cerrar.
  // ---------------------------------------------------------------------
  function navMenuIsOpen() {
    var menu = byId('txb-nav-menu');
    return !!menu && !menu.hidden;
  }

  function setNavMenu(abierto, devolverFoco) {
    var menu = byId('txb-nav-menu');
    var toggle = byId('txb-nav-toggle');
    if (!menu || !toggle) return;
    setHidden(menu, !abierto);
    toggle.setAttribute('aria-expanded', abierto ? 'true' : 'false');
    if (abierto) {
      var enlaces = menu.querySelectorAll('a');
      if (enlaces.length > 0 && enlaces[0].focus) enlaces[0].focus();
    } else if (devolverFoco && toggle.focus) {
      toggle.focus();
    }
  }

  // ---------------------------------------------------------------------
  // Cableado y arranque
  // ---------------------------------------------------------------------

  /**
   * El cajón: cierre por el botón ✕ y por clic en el fondo (el \`::backdrop\` de
   * un \`<dialog>\` es el propio elemento, así que el clic llega con
   * \`target === dialog\` sólo cuando NO se ha pulsado nada de dentro). \`Escape\`
   * no se engancha: lo da el elemento nativo y acaba en el mismo evento
   * \`close\`, que es donde vuelve el foco al disparador.
   */
  function wireDrawer() {
    var dialog = drawerNode();
    if (!dialog) return;
    dialog.addEventListener('close', onDrawerClose);
    dialog.addEventListener('click', function (ev) {
      if (ev && ev.target === dialog) dialog.close();
    });
    var cerrar = byId('txb-drawer-cerrar');
    if (cerrar) cerrar.addEventListener('click', function () { dialog.close(); });
  }

  /** Un CTA de ficha de servicio. Función aparte para que cada botón cierre sobre EL SUYO. */
  function wireServiceCta(boton) {
    boton.addEventListener('click', function () {
      preselectService(Number(boton.getAttribute('data-service-id')), boton);
    });
  }

  /** Un CTA de ficha de equipo. Ídem: el identificador sale de SU atributo. */
  function wireEmployeeCta(boton) {
    boton.addEventListener('click', function () {
      preselectEmployee(Number(boton.getAttribute('data-employee-id')), boton);
    });
  }

  /**
   * Los CTA de página (barra, hero y barra móvil) son \`<a href="#…">\`: anclan
   * solos, sin JavaScript, y siguen funcionando aunque este fichero no llegue a
   * cargarse. Lo único que se les añade es llevar el foco al encabezado del
   * paso que se está viendo, para que el teclado siga donde ha ido la vista.
   *
   * EL FOCO SE PONE DOS VECES, Y NO SOBRA NINGUNA. La navegación a un fragmento
   * es la acción POR DEFECTO del clic, así que ocurre DESPUÉS de este
   * manejador; y como una \`<section>\` no es enfocable, el navegador termina
   * devolviendo el foco al \`<body>\` y deshaciendo lo que acabáramos de hacer
   * (observado en Chrome 134). La segunda pasada se aplaza al turno siguiente,
   * ya con la navegación hecha, y va \`preventScroll\`: quien decide dónde queda
   * la página es el ancla, no nosotros.
   */
  function wirePageCta(id) {
    var node = byId(id);
    if (!node) return;
    node.addEventListener('click', function () {
      focusCurrentStepHeading(true);
      setTimeout(function () { focusCurrentStepHeading(true); }, 0);
    });
  }

  function wireCtas() {
    var i;
    var servicios = document.querySelectorAll('.txb-cta-servicio');
    for (i = 0; i < servicios.length; i += 1) wireServiceCta(servicios[i]);
    var profesionales = document.querySelectorAll('.txb-cta-profesional');
    for (i = 0; i < profesionales.length; i += 1) wireEmployeeCta(profesionales[i]);
    wirePageCta('txb-cta-nav');
    wirePageCta('txb-cta-hero-primario');
    wirePageCta('txb-cta-movil');
  }

  function wireNavMenu() {
    var menu = byId('txb-nav-menu');
    var toggle = byId('txb-nav-toggle');
    if (!menu || !toggle) return;

    toggle.addEventListener('click', function () { setNavMenu(!navMenuIsOpen(), true); });

    var enlaces = menu.querySelectorAll('a');
    for (var i = 0; i < enlaces.length; i += 1) {
      enlaces[i].addEventListener('click', function () { setNavMenu(false, true); });
    }

    // \`Escape\` cierra y devuelve el foco al botón. El manejador se registra en
    // el documento y también en los dos nodos del menú: el primero es lo que
    // hace un navegador (la tecla burbujea hasta arriba) y los otros dos
    // sostienen la promesa aunque algo detenga la propagación por el camino.
    // Cerrar lo ya cerrado no hace nada, así que registrarlo tres veces no
    // puede producir dos cierres.
    var alPulsarTecla = function (ev) {
      if (ev && ev.key === 'Escape' && navMenuIsOpen()) setNavMenu(false, true);
    };
    document.addEventListener('keydown', alPulsarTecla);
    menu.addEventListener('keydown', alPulsarTecla);
    toggle.addEventListener('keydown', alPulsarTecla);
  }

  function wireControls() {
    // Antes que ningún oyente: la columna del resumen tiene que decir de qué va
    // desde el primer pintado, esté o no de camino el bootstrap. Si la llamada
    // falla, la página enseña el error Y una columna con sentido, no una tarjeta
    // vacía con un botón apagado.
    buildAsideIntro();

    byId('txb-tab-reserva').addEventListener('click', function () { switchView('reserva'); });
    byId('txb-tab-dashboard').addEventListener('click', function () { switchView('dashboard'); });

    var continuar = byId('txb-btn-continuar');
    continuar.addEventListener('click', function () {
      if (state.step === 1 && state.serviceId !== null) goToStep(2);
      // El propio botón viaja como disparador: al cerrar el cajón, el foco
      // vuelve aquí y no a un destino fijo escrito a mano.
      else if (state.step === 2 && state.employeeId !== null) goToStep(3, continuar);
    });

    byId('txb-volver-servicio').addEventListener('click', function () { goToStep(1); });
    byId('txb-volver-profesional').addEventListener('click', function () { goToStep(2); });

    byId('txb-mes-anterior').addEventListener('click', function () { changeMonth(-1); });
    byId('txb-mes-siguiente').addEventListener('click', function () { changeMonth(1); });

    byId('txb-vista-dia-completa').addEventListener('change', function (ev) {
      state.fullDayView = !!ev.target.checked;
      // Cambiar de vista cambia lo que hay que PREGUNTAR (con filtro de persona
      // o sin él), no cómo se dibuja lo ya preguntado: se vuelve a pedir. Sin
      // fecha elegida todavía no hay nada que pedir.
      if (state.date) loadAvailability();
    });

    byId('txb-pago-ahora').addEventListener('change', function () { onPaymentChange('pay_now_demo'); });
    byId('txb-pago-local').addEventListener('change', function () { onPaymentChange('pay_at_salon'); });

    byId('txb-btn-confirmar').addEventListener('click', function () { confirmBooking(); });

    byId('txb-btn-nueva-reserva').addEventListener('click', function () { startOver(); });
    byId('txb-btn-ver-panel').addEventListener('click', function () { switchView('dashboard'); });

    byId('txb-btn-abrir-reset').addEventListener('click', function () { openResetDialog(); });
    byId('txb-dialog-reset-cancelar').addEventListener('click', function () { byId('txb-dialog-reset').close(); });
    byId('txb-dialog-reset-confirmar').addEventListener('click', function () { confirmReset(); });

    // Lo que envuelve al asistente. Va aparte y tolera su ausencia a propósito:
    // el asistente tiene que seguir vivo en un documento que sólo lo contenga a
    // él, mientras que sus propios controles siguen siendo obligatorios y
    // revientan aquí arriba si faltan. Que estos nodos existan de verdad en la
    // página servida lo vigila la prueba del contrato de identificadores.
    wireDrawer();
    wireCtas();
    wireNavMenu();
  }

  function init() {
    wireControls();
    return requestJson('GET', '/bootstrap').then(function (r) {
      if (r.status !== 200) {
        primerPintado = false;
        showError(r.json.message || 'No se ha podido cargar esta demostración.');
        return;
      }
      state.bootstrap = r.json;
      renderServiceStep();
      refreshProfessionalCtas();
      updateAsideSummary();
      goToStep(1);
      // A partir de aquí, todo movimiento de foco lo ha pedido una persona.
      primerPintado = false;
      // Un CTA pulsado mientras el bootstrap venía de camino se atiende ahora,
      // ya con la matriz de compatibilidad en la mano — y con el foco ya vivo,
      // porque ese clic SÍ es una acción de alguien.
      applyPendingCta();
    }, function () {
      primerPintado = false;
      showError('No se ha podido contactar con el servidor de la demostración.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;
}
