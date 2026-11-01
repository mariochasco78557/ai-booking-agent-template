import { SERVICE_LABELS } from "../callEngine/domain/types.js";

/**
 * Client-side JS for the step 14 operator console, served verbatim by
 * `GET /app.js` (see server.ts). Deliberately a plain literal string of
 * ordinary browser JS — no bundler, no framework, no build step, matching
 * the senior architecture decision that this console is "two routes and a
 * literal template", nothing more.
 *
 * HARD RULE, ENFORCED BY tests/console/console.test.ts (which greps this
 * file on disk): every DOM update below uses `textContent` (or
 * `setAttribute`/element properties/`createElement`) — `innerHTML` NEVER
 * appears anywhere in this string, and neither does `.style.` or an inline
 * `style=` attribute (style-src 'self', no 'unsafe-inline').
 *
 * Polls `GET /api/snapshot` every 2 seconds — no WebSocket, per the
 * architecture decision (DESIGN_SPEC.md §10). Talks to no other origin
 * (`connect-src 'self'` in server.ts's CSP would block it anyway).
 *
 * DECISION D7 (focus-safe polling): the poll must never destroy a DOM node
 * that contains `document.activeElement`. `reconcileList` below is the ONE
 * place that implements this: it reuses existing row/item elements keyed by
 * a stable id and only ever updates their `textContent`/attributes in
 * place — it never empties a container and rebuilds it from scratch, and it
 * refuses to remove a stale node that still contains the focused element.
 *
 * `SERVICE_LABELS` is interpolated (JSON.stringify) from
 * `callEngine/domain/types.ts` — the single source of truth for service
 * names (DESIGN_SPEC Anexo B.3). This file no longer keeps its own copy.
 */
export function renderConsoleAppJs(): string {
  const serviceLabelsJson = JSON.stringify(SERVICE_LABELS);
  return `'use strict';
(function () {
  var POLL_MS = 2000;
  var DOWN_AFTER_MS = 6000;
  var SERVICE_LABELS = ${serviceLabelsJson};

  var latestSnapshot = null;
  var lastPollOkAt = null;
  var pollTimer = null;

  // ---------------------------------------------------------------------
  // Generic DOM helpers — textContent / createElement / setAttribute ONLY.
  // ---------------------------------------------------------------------

  function byId(id) { return document.getElementById(id); }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  /**
   * DECISIÓN D7, EXTENDIDA (revisión step 15, bloqueante B2). La misma regla
   * dura que \`reconcileList\` aplica al BORRAR hijos con clave obsoleta, ahora
   * disponible para cualquier bloque que se reconstruya entero: si el nodo
   * enfocado vive dentro, ese nodo NO se destruye.
   *
   * El sondeo entra cada dos segundos. Sin esta guarda, un \`clearChildren\`
   * dentro de la construcción de una fila esquivaba la salvaguarda de
   * \`reconcileList\` (que sólo mira los hijos que va a QUITAR, no los que
   * reconstruye) y arrancaba el foco de quien navegaba con el teclado.
   *
   * Nota (revisión adversarial step 16, A4). \`active === node\` devuelve
   * false a propósito: hoy sólo protege el caso real, en el que el foco vive
   * en un DESCENDIENTE de la fila (un enlace o un botón dentro), nunca en la
   * fila misma. Si algún día una fila de \`reconcileList\` llevara \`tabindex\`
   * y fuera ella misma el nodo enfocado, esta guarda NO la protegería: la
   * fila seguiría sin devolver true y \`insertBefore\` le arrancaría el foco
   * pese a la guarda. Hoy no es alcanzable — ninguna fila de \`reconcileList\`
   * lleva \`tabindex\` — pero queda anotado para quien añada una.
   */
  function holdsFocus(node) {
    if (!node || !node.contains) return false;
    var active = document.activeElement;
    if (!active || active === node) return false;
    return node.contains(active);
  }

  /**
   * Escribe texto sólo cuando ha cambiado de verdad. Reescribir un nodo
   * destruye la selección de texto que el operador tuviera hecha dentro, y el
   * sondeo pasa por aquí cada dos segundos.
   */
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /**
   * Busca un hijo DIRECTO (no desciende el subárbol) por su clase. No se usa
   * querySelector a propósito: tests/console/fakeDom.ts:257 sólo resuelve
   * \`[data-x="v"]\` y nombres de etiqueta, y además querySelector bajaría por
   * todo el subárbol cuando aquí sólo interesa un hijo directo.
   */
  function childByClass(parent, className) {
    var kids = parent.children;
    for (var i = 0; i < kids.length; i += 1) {
      if (kids[i].classList && kids[i].classList.contains(className)) return kids[i];
    }
    return null;
  }

  /**
   * Reconciliation by key (decision D7). Reuses existing children keyed by
   * \`data-key\` instead of clearing and rebuilding the container, and NEVER
   * removes a stale child that still contains \`document.activeElement\`.
   */
  function reconcileList(container, items, keyOf, buildRow) {
    var existingByKey = {};
    Array.prototype.forEach.call(container.children, function (child) {
      var k = child.getAttribute('data-key');
      if (k !== null) existingByKey[k] = child;
    });
    var usedKeys = {};
    // REAPERTURA §R6.b — qué nodo ha RECLAMADO cada clave en esta pasada.
    // Ver la nota junto a la pasada de borrado, más abajo.
    var reclamados = {};
    var prevEl = null;
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var key = String(keyOf(item, i));
      usedKeys[key] = true;
      var existing = existingByKey[key] || null;
      var built = buildRow(item, existing, i);
      built.setAttribute('data-key', key);
      reclamados[key] = built;
      var wantedNext = prevEl ? prevEl.nextSibling : container.firstChild;
      if (wantedNext !== built) {
        // O3 (step 16). insertBefore MUEVE el nodo, y mover es desconectar y
        // volver a conectar: en un navegador de verdad, el foco que viviera
        // dentro se cae al <body>. Es alcanzable cada dos segundos — la tabla
        // de Llamadas va ordenada por hora descendente, así que una fila que
        // deja de estar entre las visibles (cambia de filtro, o la reemplaza
        // otra) puede obligar a otra fila persistente a "saltar" ese hueco,
        // incluida aquella en cuyo enlace "Ver" está el foco de quien navega
        // con el teclado.
        //
        // La misma regla dura que ya protegía al BORRAR (más abajo) protege
        // ahora al REORDENAR: un nodo que contiene document.activeElement no
        // se mueve. Su CONTENIDO sí se ha puesto al día — buildRow ya se ha
        // ejecutado sobre él —; lo único que se aplaza es su posición.
        //
        // Y el orden final NO se sacrifica: el nodo anclado se queda quieto y
        // los demás se colocan alrededor de él (los anteriores, antes; los
        // siguientes, justo detrás, porque prevEl sigue avanzando). El único
        // resto conocido es el que ya existía antes de este cambio: un nodo
        // cuya clave ha desaparecido de items y que tiene el foco no se
        // borra, y por tanto se queda donde está.
        if (built.parentNode === container && holdsFocus(built)) {
          // no se mueve: el foco manda
        } else {
          container.insertBefore(built, wantedNext || null);
        }
      }
      prevEl = built;
    }
    var toRemove = [];
    Array.prototype.forEach.call(container.children, function (child) {
      var k = child.getAttribute('data-key');
      if (k === null) return;
      if (!usedKeys[k]) { toRemove.push(child); return; }
      // REAPERTURA §R6.b — un hijo que lleva una clave VIVA pero NO es el
      // nodo que esta pasada ha colocado para esa clave es un huérfano:
      // alguien construyó uno nuevo en vez de reutilizarlo (buildRow
      // ignorando existing). Antes sobrevivía para siempre, porque la
      // clave estaba en usedKeys. Ese fue el defecto 2 (agendaPintarEje);
      // esto impide la clase entera, para cualquier punto de llamada.
      if (reclamados[k] !== child) toRemove.push(child);
    });
    toRemove.forEach(function (child) {
      if (child.contains(document.activeElement)) return;
      container.removeChild(child);
    });
  }

  function setHidden(elm, hidden) { elm.hidden = !!hidden; }

  // ---------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------

  var WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  // Los cinco días invariables lo son de verdad en castellano ("los lunes",
  // "los martes"): sólo sábado y domingo cambian en plural.
  var WEEKDAYS_PLURAL = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
  var MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var MONTHS_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function parseISODateParts(iso) {
    var parts = iso.split('-');
    return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
  }
  function dateFromISO(iso) {
    var p = parseISODateParts(iso);
    return new Date(p.y, p.m - 1, p.d);
  }
  function toISODate(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  function addDaysISO(iso, days) {
    var d = dateFromISO(iso);
    d.setDate(d.getDate() + days);
    return toISODate(d);
  }
  function formatDateLong(iso) {
    var d = dateFromISO(iso);
    return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' de ' + MONTHS[d.getMonth()] + ' de ' + d.getFullYear();
  }
  function formatDateShort(iso) {
    var d = dateFromISO(iso);
    return d.getDate() + ' ' + MONTHS_ABBR[d.getMonth()];
  }
  /**
   * Un rango de fechas dicho como se dice en castellano: "del 1 al 31 de
   * agosto", o "del 28 de julio al 3 de agosto" cuando cambia de mes. Es una
   * función APARTE a propósito: formatDateShort ('1 ago') se sigue usando en
   * las fichas compactas de "días distintos", donde sí interesa el mes
   * abreviado, y cambiarla de golpe habría movido cuatro textos más sin
   * mirarlos.
   */
  function formatDateRangeLong(startISO, endISO) {
    var a = dateFromISO(startISO);
    var b = dateFromISO(endISO);
    var sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    if (sameMonth) return 'del ' + a.getDate() + ' al ' + b.getDate() + ' de ' + MONTHS[b.getMonth()];
    return 'del ' + a.getDate() + ' de ' + MONTHS[a.getMonth()] + ' al ' + b.getDate() + ' de ' + MONTHS[b.getMonth()];
  }
  function formatMinutes(m) {
    if (typeof m !== 'number') return '—';
    var hh = String(Math.floor(m / 60)).padStart(2, '0');
    var mm = String(m % 60).padStart(2, '0');
    return hh + ':' + mm;
  }
  function formatTimeFromISO(iso) {
    if (!iso) return '—';
    var m = iso.match(/T(\\d{2}):(\\d{2})/);
    if (!m) return '—';
    return m[1] + ':' + m[2];
  }
  /**
   * D5 (revisión step 15): una marca de tiempo completa dicha en castellano.
   * El "Detalle técnico" es técnico en sus CÓDIGOS, no en su idioma: una
   * fecha ahí seguía apareciendo como "2026-08-04T09:10:00.000Z", que no es
   * una fecha para nadie que no programe.
   */
  function formatDateTimeLong(iso) {
    if (!iso) return '—';
    return formatDateLong(iso.slice(0, 10)) + ' a las ' + formatTimeFromISO(iso);
  }
  function formatTimeHHmmss(date) {
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    var ss = String(date.getSeconds()).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }
  function serviceLabel(id) {
    if (id === null || id === undefined) return '—';
    return SERVICE_LABELS[id] || ('Servicio ' + String(id));
  }
  function professionalLabel(employeeId) {
    if (!latestSnapshot) return 'profesional ' + String(employeeId);
    var list = latestSnapshot.calendar.professionals;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].employeeId === employeeId) return list[i].label;
    }
    return 'profesional ' + String(employeeId);
  }

  // ---------------------------------------------------------------------
  // Vocabulario de estado (DESIGN_SPEC §7). Un único mapa: ninguna vista
  // construye su propia etiqueta.
  // ---------------------------------------------------------------------

  var STATUS_VOCAB = {
    BOOKING_CONFIRMED: { label: 'Reserva confirmada', modifier: 'ok', glyph: '✓' },
    AVAILABILITY_PROVIDED: { label: 'Sin incidencias', modifier: 'none', glyph: '—' },
    TECHNICAL_FAILURE: { label: 'Error técnico', modifier: 'error', glyph: '✕' },
    SECURITY_OR_PRIVACY_BOUNDARY: { label: 'Necesita revisión', modifier: 'attention', glyph: '!' },
    BOOKING_NOT_CONFIRMED: { label: 'No completada', modifier: 'incomplete', glyph: '○' },
    CUSTOMER_REQUESTS_HUMAN: { label: 'Derivada a una persona', modifier: 'derived', glyph: '→' },
    CANCEL_OR_CHANGE_NOT_ENABLED: { label: 'Derivada a una persona', modifier: 'derived', glyph: '→' },
    BUSINESS_DATA_NOT_APPROVED: { label: 'Derivada a una persona', modifier: 'derived', glyph: '→' },
    SLOT_OUTSIDE_SYNTHETIC_SCHEDULE: { label: 'Derivada a una persona', modifier: 'derived', glyph: '→' },
    SERVICE_NOT_CONFIRMED: { label: 'Derivada a una persona', modifier: 'derived', glyph: '→' },
    INTENT_NOT_UNDERSTOOD: { label: 'Derivada a una persona', modifier: 'derived', glyph: '→' }
  };

  /**
   * step 17. El estado de una CITA, que no es el desenlace de una llamada:
   * por eso vive aparte y no dentro de STATUS_VOCAB, cuyo dominio son los
   * once \`internalReasonCode\` del motor (y una prueba comprueba que son
   * exactamente esos once, ni uno más). Sigue el mismo vocabulario visual:
   * texto + glifo + borde, nunca sólo color (§9.7).
   */
  var PILL_CITA_CANCELADA = { label: 'Cancelada', modifier: 'incomplete', glyph: '○' };

  /**
   * §7.1: reads internalReasonCode first, never the frozen reasonCode. Falls
   * back to outcome/booleans only when internalReasonCode is genuinely
   * absent (defensive — the engine always sets it once a call has an
   * outcome), and never invents a flattering default.
   */
  function statusFor(call) {
    if (call.internalReasonCode && STATUS_VOCAB[call.internalReasonCode]) {
      return STATUS_VOCAB[call.internalReasonCode];
    }
    if (call.outcome === 'RESUELVE' && call.countsAsBookingConversion) return STATUS_VOCAB.BOOKING_CONFIRMED;
    if (call.outcome === 'RESUELVE') return STATUS_VOCAB.AVAILABILITY_PROVIDED;
    if (call.outcome === 'RECHAZA') return STATUS_VOCAB.SECURITY_OR_PRIVACY_BOUNDARY;
    if (call.outcome === 'DERIVA') return STATUS_VOCAB.CUSTOMER_REQUESTS_HUMAN;
    return null;
  }

  function buildPillEl(status, small) {
    var span = el('span', 'tx-pill tx-pill--' + status.modifier + (small ? ' tx-pill--sm' : ''));
    var glyph = el('span', 'tx-pill__glyph', status.glyph);
    glyph.setAttribute('aria-hidden', 'true');
    var label = el('span', 'tx-pill__label', status.label);
    span.appendChild(glyph);
    span.appendChild(label);
    return span;
  }

  /**
   * (step 23 §8.1/§8.2, A8 de step 21A) Una píldora que informa SÓLO con
   * texto. No lleva glifo a propósito: los glifos de \`buildPillEl\` son
   * decorativos y van con \`aria-hidden\`, así que aquí no aportarían nada y
   * habría que esconderlos igual. El tono llega del servidor y es uno del
   * vocabulario cerrado (ok · attention · derived · incomplete · none); si
   * llegara cualquier otra cosa, se cae a \`none\` en vez de pintar una clase
   * inventada que el CSS no conoce.
   */
  var TONOS_DE_PILDORA = { ok: 1, attention: 1, derived: 1, incomplete: 1, none: 1, error: 1 };

  function buildPildoraDeTexto(label, tono) {
    var modifier = TONOS_DE_PILDORA[tono] ? tono : 'none';
    var span = el('span', 'tx-pill tx-pill--' + modifier + ' tx-pill--sm');
    span.appendChild(el('span', 'tx-pill__label', label));
    return span;
  }

  var QUE_PASO = {
    'Reserva confirmada': 'El asistente entendió lo que quería el cliente y dejó la cita reservada.',
    'Sin incidencias': 'El asistente le dio las horas libres que pedía. No hacía falta reservar nada.',
    'No completada': 'Se entendió lo que quería y había hueco, pero el cliente no llegó a confirmar la cita. No se ha reservado nada.',
    'Derivada a una persona': 'El asistente no podía resolverlo por su cuenta y lo dejó para una persona del equipo.',
    'Necesita revisión': 'El asistente rechazó la petición para proteger datos de otra persona. No dio ninguna información.',
    'Error técnico': 'El asistente falló mientras gestionaba la llamada. No le dijo al cliente que la cita estuviera confirmada.'
  };

  var INTENT_LABELS = {
    BOOK: 'Pedir cita',
    CHECK_AVAILABILITY: 'Consultar horas',
    HUMAN_HELP: 'Hablar con alguien',
    CANCEL: 'Anular una cita',
    RESCHEDULE: 'Cambiar una cita',
    ASK_PRICE: 'Preguntar un precio',
    OTHER: 'Otra cosa'
  };
  function intentLabel(call) {
    if (call.lastIntent && INTENT_LABELS[call.lastIntent]) return INTENT_LABELS[call.lastIntent];
    return 'Sin determinar';
  }

  /**
   * (revisión adversarial de la capacidad 2, hallazgo H8) Busca una tarea
   * ABIERTA con esta llamada y este motivo — nunca una ya resuelta. Sus dos
   * llamantes de hoy (\`actionFor\`, y el \`orphanTask\` de más abajo) preguntan
   * "¿todavía hace falta hacer algo?", y una tarea resuelta contestaría que
   * sí por error si esta guarda no estuviera. NO cambia el comportamiento
   * visible hoy: ninguno de los dos motivos que consultan esta función
   * (\`CALLBACK_FROM_CALL\`, \`REVIEW_ORPHANED_SYNTHETIC_RESERVATION\`) tiene hoy
   * ninguna ruta de cierre real, así que \`tasks[i].open\` es siempre \`true\`
   * para cualquier tarea que esta función pudiera encontrar — se deja escrito
   * para cuando alguno de los dos lo tenga.
   */
  function findTask(snap, callIdHash, reasonKind) {
    var tasks = snap.humanQueue.tasks;
    for (var i = 0; i < tasks.length; i += 1) {
      if (tasks[i].callIdHash === callIdHash && tasks[i].reasonKind === reasonKind && tasks[i].open) return tasks[i];
    }
    return null;
  }

  function findReservationForCall(snap, callIdHash) {
    var list = snap.calendar.reservations;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].callIdHash === callIdHash) return list[i];
    }
    return null;
  }

  /** "Qué hay que hacer" — sólo cuatro valores posibles (§6.5). */
  function actionFor(snap, call) {
    if (call.outcome === 'RESUELVE') return 'Nada';
    if (call.internalReasonCode === 'BOOKING_NOT_CONFIRMED') return 'Nada';
    if (findTask(snap, call.callIdHash, 'CALLBACK_FROM_CALL')) return 'Devolver la llamada';
    return 'Revisar';
  }

  // ---------------------------------------------------------------------
  // Venue hours — presentational derivation of OPENING HOURS from the
  // declarative schedule data the snapshot exposes (closures, venue rules,
  // seasonal schedules, weekly schedules). This mirrors resolveAvailability
  // .ts's own precedence order at a coarse, VENUE-ONLY level for display —
  // it does not re-decide booking eligibility (that stays server-side); it
  // only answers "is the venue open this day, and what hours does it show".
  // ---------------------------------------------------------------------

  function dateInRange(iso, start, end) { return iso >= start && iso <= end; }
  function weekdayOf(iso) { return dateFromISO(iso).getDay(); }

  /**
   * B1 (revisión step 15). EL ÚNICO SITIO del cliente donde se decide qué
   * horas rigen un día de la semana. Aplica la precedencia de
   * resolveAvailability.ts a nivel de LOCAL: una temporada aprobada y vigente
   * en \`onDateISO\` manda sobre el horario semanal ordinario, y un día de la
   * semana sin fila es un día cerrado, dentro y fuera de temporada.
   *
   * Lo usan \`resolveVenueDay()\` (y con ella Agenda y Calendario) y la ficha de
   * Equipo. Antes Equipo llevaba su propia derivación, que leía las filas
   * ordinarias y NUNCA miraba la temporada: el 4 de agosto de 2026 publicaba
   * "Martes 09:30 – 19:30" mientras Calendario y Agenda decían 09:00 – 17:30.
   */
  function venueWeekdayHours(cal, dow, onDateISO) {
    var seasons = (cal.seasonalSchedules || []).filter(function (s) {
      return s.approval === 'approved' && dateInRange(onDateISO, s.startDate, s.endDate);
    });
    if (seasons.length > 0) {
      for (var k = 0; k < seasons.length; k += 1) {
        if (seasons[k].dayOfWeek === dow) {
          // V1-5 — la PAUSA declarada del local viaja tal cual. No se calcula
          // nada nuevo: \`breakStart\`/\`breakEnd\` ya vienen en la instantánea
          // (\`ConsoleWeeklyScheduleView\`/\`ConsoleSeasonalScheduleView\`) y son
          // las MISMAS que \`resolveDayWindows\` usa para partir el día en dos
          // ventanas (\`resolveAvailability.ts:262-263, 281-282\`). Se pasan
          // adelante para que la Agenda no ofrezca huecos dentro de la pausa.
          return { open: true, start: seasons[k].workDayStart, end: seasons[k].workDayEnd, isSeasonal: true,
            breakStart: seasons[k].breakStart, breakEnd: seasons[k].breakEnd };
        }
      }
      return { open: false, reasonLabel: 'Día de descanso' };
    }
    var weekly = (cal.weeklySchedules || []).filter(function (w) { return w.ownerKind === 'venue' && w.dayOfWeek === dow; })[0];
    if (weekly) return { open: true, start: weekly.workDayStart, end: weekly.workDayEnd, breakStart: weekly.breakStart, breakEnd: weekly.breakEnd };
    return { open: false, reasonLabel: 'Día de descanso' };
  }

  function resolveVenueDay(iso, cal) {
    var closures = cal.closures || [];
    for (var i = 0; i < closures.length; i += 1) {
      var c = closures[i];
      if (c.approval === 'approved' && dateInRange(iso, c.startDate, c.endDate)) {
        return { open: false, reasonLabel: 'Cierre del local' };
      }
    }
    var rules = cal.venueRules || [];
    for (var j = 0; j < rules.length; j += 1) {
      var r = rules[j];
      if (r.approval === 'approved' && r.date === iso) {
        if (r.closed) return { open: false, reasonLabel: 'Festivo aprobado', isHoliday: true };
        return { open: true, start: r.specialOpen, end: r.specialClose, isSpecial: true };
      }
    }
    return venueWeekdayHours(cal, weekdayOf(iso), iso);
  }

  function absencesOn(cal, iso) {
    return (cal.absences || []).filter(function (a) { return a.approval === 'approved' && dateInRange(iso, a.startDate, a.endDate); });
  }

  /**
   * D4 (step 14 repair): whether a venue-wide seasonal schedule
   * (\`cal.seasonalSchedules\`, the same data Calendario's own "Aviso de
   * temporada" banner reads) is currently in force for \`todayISO\`. Returns
   * the FIRST matching approved row, or \`null\` — every row sharing one
   * period shares \`label\`/\`startDate\`/\`endDate\` (calendar/model.ts's own
   * docblock), so any one row is enough to state the period. A seasonal
   * schedule is venue-wide and OUTRANKS every employee's own weekly
   * schedule (resolveAvailability.ts's precedence), which is exactly why
   * Equipo needs this: without it, a professional's card could show hours
   * at which the venue itself is closed.
   */
  function activeSeasonalOverride(cal, todayISO) {
    var rows = (cal.seasonalSchedules || []).filter(function (s) {
      return s.approval === 'approved' && dateInRange(todayISO, s.startDate, s.endDate);
    });
    return rows.length > 0 ? rows[0] : null;
  }

  // ---------------------------------------------------------------------
  // Router (DESIGN_SPEC §10) — one page, hash routing, six static
  // <section hidden> views. The router only ever toggles \`hidden\`.
  // ---------------------------------------------------------------------

  var ROUTE_TITLES = {
    inicio: 'Inicio',
    agenda: 'Agenda',
    // step 17 §9.1: entre Agenda y Llamadas, porque es una pantalla
    // OPERATIVA y accionable, no una herramienta de demostración.
    'lista-espera': 'Lista de espera',
    llamadas: 'Llamadas',
    // step 26 REAPERTURA §R1: ocupa el sitio EXACTO de 'calendario', que
    // desaparece de este mapa. La sección conserva sus ids internos
    // (\`calendario-*\`): lo que cambia es la ruta y la etiqueta.
    'horarios-y-ausencias': 'Horarios y ausencias',
    equipo: 'Equipo',
    laboratorio: 'Laboratorio'
  };

  /**
   * step 26 REAPERTURA §R2 — el mapa CERRADO de rutas retiradas: clave
   * vieja → clave nueva, un solo salto por construcción. Nada más entra aquí
   * sin corregir antes el documento normativo.
   */
  var RUTAS_RETIRADAS = { calendario: 'horarios-y-ausencias' };
  /** Guarda de reentrada de \`redirigirRutaRetirada\`, del mismo linaje que la de \`navegarAgenda\`. */
  var redirigiendoRuta = false;
  /**
   * Lo levanta la reescritura cuando el sufijo de la ruta vieja no se ha
   * entendido, y lo CONSUME la pasada siguiente de \`applyRoute\` (la que
   * dispara el \`hashchange\` de la reescritura). Es de un solo uso: sin él, la
   * pasada nueva vería una dirección bien formada —porque la reescritura la
   * dejó bien formada— y apagaría un aviso que sí hay que dar.
   */
  var horariosAvisoPendiente = false;
  /** Si el aviso de ruta de Horarios y ausencias está encendido en esta pasada. */
  var horariosRutaCorregida = false;
  var currentRoute = { section: 'inicio', param: undefined };
  var calendarVisibleMonth = null; // { year, month } — month is 1..12
  var openCallHash = null;

  // -----------------------------------------------------------------
  // step 26 §9 — estado de la Agenda. Vive aquí como una CACHÉ de la
  // ÚLTIMA lectura del hash, nunca como una fuente de verdad paralela: sólo
  // \`applyRoute()\`, leyendo \`parseHash()\`, escribe estas tres variables. Un
  // control de la Agenda nunca las toca directamente — escribe
  // \`window.location.hash\` y dEja que \`hashchange\` dispare \`applyRoute()\`
  // otra vez, exactamente como pide la decisión 9 ("la rueda de estado es
  // el hash y nada más").
  // -----------------------------------------------------------------
  var AGENDA_VISTAS = ['dia', 'semana', 'mes', 'lista'];
  var agendaRouteVista = 'dia';
  var agendaRouteFecha = null; // ISO o null → "ausente" (decide engineToday al pintar)
  var agendaRouteFiltro = 'todos'; // 'todos' | 'p<employeeId>'
  var agendaRutaCorregida = false;
  /**
   * (revisión step 15, punto 1) Qué llamada tenía puesto el mensaje de
   * "#llamada-copiar-estado" la última vez que \`renderCallDetail\` lo tocó.
   * El sondeo llama a \`renderCallDetail\` cada dos segundos con la MISMA
   * llamada abierta; sin esta guarda, ese repintado borraba "Copiado" antes
   * de que diera tiempo a leerlo. Se borra al cambiar de llamada (abrir otra,
   * o cerrar y volver a abrir), nunca por el mero paso del sondeo.
   */
  var copyStatusShownForCallHash = null;

  /**
   * step 26 §9/C7. \`parseHash\` sólo devolvía \`{section, param}\` — un solo
   * parámetro — y descartaba \`parts[2]\` en adelante. La Agenda necesita tres
   * segmentos (vista/fecha/filtro), así que gana \`params\` (el array entero
   * tras la sección) DE FORMA RETROCOMPATIBLE: \`param\` sigue siendo
   * EXACTAMENTE lo que era (\`parts[1]\`, o \`undefined\`), y lo siguen leyendo
   * Llamadas y Calendario sin cambiar una línea de las suyas.
   */
  function parseHash() {
    var raw = window.location.hash || '';
    var path = raw.replace(/^#\\/?/, '');
    var parts = path.split('/').filter(function (p) { return p.length > 0; });
    var section = parts[0] || 'inicio';
    if (!ROUTE_TITLES[section]) return { section: 'inicio', param: undefined, params: [], unknown: true };
    return { section: section, param: parts[1], params: parts.slice(1) };
  }

  /**
   * step 26 §9 — interpreta \`params\` (lo que queda tras "agenda/" en el
   * hash) según la gramática \`<vista>/<fecha>/<filtro>\`, TODOS opcionales
   * por la derecha. Un segmento presente pero con forma inválida se
   * NORMALIZA aquí (nunca en la URL) y marca \`corregida\`. La existencia de
   * un \`employeeId\` en el filtro NO se comprueba aquí — el snapshot puede no
   * haber llegado todavía (C7/§9) — sino en \`renderAgenda\`, en cada pasada.
   */
  /**
   * step 26 — reparación adversarial (hallazgo 3). \`AAAA-MM-DD\` con la
   * FORMA correcta pero un calendario imposible (\`2026-13-40\`,
   * \`2026-02-30\`) NO puede colarse: \`new Date(y, m-1, d)\` hace "rollover"
   * en silencio (2026-02-30 se convierte en el 2 de marzo) y esta consola
   * no puede repetir esa clase de sorpresa silenciosa en una URL. Se
   * reconstruye la fecha y se compara AÑO, MES Y DÍA contra lo que se pidió:
   * si algo no coincide, la fecha nunca fue real.
   */
  function esFechaCalendarioValida(iso) {
    var m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(iso);
    if (!m) return false;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    var fecha = new Date(y, mo - 1, d);
    return fecha.getFullYear() === y && fecha.getMonth() === mo - 1 && fecha.getDate() === d;
  }

  /**
   * Hermana de \`esFechaCalendarioValida\` para el parámetro de mes de
   * \`horarios-y-ausencias\`. La FORMA no es el RANGO: \`/^\\d{4}-\\d{2}$/\`
   * acepta \`2026-99\`, \`2026-00\` y \`2026-13\`, que tienen pinta de mes y no
   * son un mes. Colarlos daba un título «undefined de 2026», celdas fechadas
   * \`2026-99-01\` y un «mes siguiente» que apuntaba a \`2026-100\`, todo sin
   * un solo aviso. Aquí se comprueba lo único que hace falta: que el mes esté
   * entre 1 y 12.
   */
  function esMesCalendarioValido(texto) {
    var m = /^(\\d{4})-(\\d{2})$/.exec(texto);
    if (!m) return false;
    var mo = Number(m[2]);
    return mo >= 1 && mo <= 12;
  }

  function parseAgendaRoute(params) {
    var corregida = false;
    var vistaRaw = params[0];
    var vista = vistaRaw === undefined ? 'dia' : vistaRaw;
    if (AGENDA_VISTAS.indexOf(vista) === -1) { vista = 'dia'; corregida = true; }

    var fechaRaw = params[1];
    var fecha = null;
    if (fechaRaw !== undefined) {
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(fechaRaw) && esFechaCalendarioValida(fechaRaw)) fecha = fechaRaw;
      else corregida = true;
    }

    var filtroRaw = params[2];
    var filtro = 'todos';
    if (filtroRaw !== undefined) {
      if (filtroRaw === 'todos' || /^p\\d+$/.test(filtroRaw)) filtro = filtroRaw;
      else corregida = true;
    }

    // Reparación adversarial (hallazgo 6) — un cuarto segmento (o más) no
    // tiene ningún significado en la gramática de la decisión 9: se
    // ignoraba en silencio porque \`params.slice(3)\` nunca se miraba. Ahora
    // se dice: es una dirección que no se ha entendido del todo, igual que
    // cualquier otro segmento con forma inválida.
    if (params.length > 3) corregida = true;

    return { vista: vista, fecha: fecha, filtro: filtro, corregida: corregida };
  }

  /**
   * D3 (revisión step 15). Localiza el enlace "Ver" desde el que se abrió un
   * detalle, para devolverle el foco al cerrarlo. Se busca por
   * \`data-call-hash\` y no por \`href\`: en un navegador de verdad \`a.href\`
   * devuelve la URL absoluta ya resuelta, no el "#/llamadas/<hash>" que se
   * escribió. Devuelve null si esa fila ya no está (filtro cambiado, llamada
   * desaparecida): entonces el foco se va al título de la vista.
   */
  function findCallRowLink(callIdHash) {
    var tbody = byId('llamadas-tbody');
    if (!tbody) return null;
    var found = null;
    Array.prototype.forEach.call(tbody.children, function (row) {
      if (found) return;
      var link = row.querySelector('a');
      if (link && link.getAttribute('data-call-hash') === callIdHash) found = link;
    });
    return found;
  }

  /**
   * step 26 REAPERTURA §R2 — la reescritura ÚNICA de una ruta retirada.
   * Se ejecuta como primera línea de \`applyRoute()\` y devuelve \`true\` si ha
   * reescrito, en cuyo caso \`applyRoute\` retorna en el acto: el
   * \`hashchange\` que provoca la reescritura vuelve a entrar aquí con la
   * dirección nueva.
   *
   * Se usa \`location.replace\`, y no \`location.hash = …\`, POR EL HISTORIAL:
   * asignar el hash APILA una entrada, de modo que "Atrás" desde
   * \`#/horarios-y-ausencias\` devolvería a \`#/calendario\`, que redirigiría
   * otra vez — el operador percibiría que "Atrás" no hace nada. \`replace\`
   * SUSTITUYE la entrada, así que "Atrás" lleva a la página anterior a la
   * redirección.
   */
  function redirigirRutaRetirada() {
    // 1. Guarda anti-bucle. Se levanta y se baja en el MISMO turno síncrono
    //    (abajo): si alguna implementación de \`replace\` reentrara aquí sin
    //    pasar por el bucle de eventos, esta línea la para en seco. Bajarla
    //    después es imprescindible: dejarla puesta desactivaría la
    //    redirección para el resto de la sesión.
    if (redirigiendoRuta) return false;

    var raw = window.location.hash || '';
    var path = raw.replace(/^#\\/?/, '');
    var parts = path.split('/').filter(function (p) { return p.length > 0; });
    var destinoSeccion = RUTAS_RETIRADAS[parts[0]];
    if (!destinoSeccion) return false;

    // 2. El destino, con el mes conservado cuando la dirección se entiende
    //    ENTERA. Cualquier otra forma —un sufijo raro, un segmento de más—
    //    va al mes de hoy Y SE DICE (mismo criterio que \`parseAgendaRoute\`
    //    con \`params.length > 3\`).
    var destino = '#/' + destinoSeccion;
    if (parts.length === 2 && esMesCalendarioValido(parts[1])) destino += '/' + parts[1];
    else if (parts.length > 1) horariosAvisoPendiente = true;

    // 3. El mismo seguro que \`navegarAgenda\`: si el destino ya es el hash
    //    actual, escribirlo no dispararía \`hashchange\` y no hay nada que
    //    reescribir. Imposible por construcción (la sección de destino no
    //    está en \`RUTAS_RETIRADAS\`), pero se escribe igual.
    if (raw === destino) return false;

    redirigiendoRuta = true;
    try {
      window.location.replace(window.location.pathname + window.location.search + destino);
    } finally {
      redirigiendoRuta = false;
    }
    return true;
  }

  function applyRoute() {
    // step 26 REAPERTURA §R2 — lo PRIMERO de todo: una ruta retirada se
    // reescribe antes de \`parseHash\`, y esta pasada termina aquí.
    if (redirigirRutaRetirada()) return;

    // (step 18 §1.4) Lo PRIMERO, antes de tocar ninguna visibilidad: el
    // anuncio de ámbito de página ("Demostración reiniciada…") es el
    // resultado de una acción, no el estado de la pantalla a la que se
    // navega. Si el operador reinicia y luego se va a Agenda, ese texto no
    // puede quedar expuesto allí como si describiera lo que está viendo.
    limpiarLinea(byId('estado-global'));
    var route = parseHash();
    var sectionChanged = route.section !== currentRoute.section;
    var previousCallHash = openCallHash;
    var previousAgendaVista = agendaRouteVista;
    var previousAgendaFecha = agendaRouteFecha;
    currentRoute = route;
    openCallHash = route.section === 'llamadas' ? (route.param || null) : null;

    // step 26 §9 — la Agenda interpreta sus tres segmentos AQUÍ, la única
    // vez por navegación, nunca en el sondeo (que no pasa por applyRoute).
    if (route.section === 'agenda') {
      var agendaRoute = parseAgendaRoute(route.params || []);
      agendaRouteVista = agendaRoute.vista;
      agendaRouteFecha = agendaRoute.fecha;
      agendaRouteFiltro = agendaRoute.filtro;
      agendaRutaCorregida = agendaRoute.corregida;
    } else {
      agendaRutaCorregida = false;
    }

    // (revisión step 15, punto 4) Salir de Llamadas con el detalle abierto
    // dejaba <div id="llamada-detalle"> con hidden=false para siempre: la
    // <section> que lo contiene se oculta (por eso no se veía), pero el
    // estado sobrevivía hasta volver a esa ruta. \`renderCallDetail()\` es lo
    // único que lo esconde normalmente, y sólo se ejecuta al pintar Llamadas
    // — así que, en cuanto la ruta deja de serlo, se esconde aquí, sin
    // depender de que esa función vuelva a llamarse.
    if (route.section !== 'llamadas') {
      var detailPanelOnLeave = byId('llamada-detalle');
      if (detailPanelOnLeave) setHidden(detailPanelOnLeave, true);
    }

    Object.keys(ROUTE_TITLES).forEach(function (key) {
      var sectionEl = byId('vista-' + key);
      if (sectionEl) setHidden(sectionEl, key !== route.section);
      var navEl = document.querySelector('a[data-route="' + key + '"]');
      if (navEl) {
        if (key === route.section) navEl.setAttribute('aria-current', 'page');
        else navEl.removeAttribute('aria-current');
      }
    });

    document.title = (ROUTE_TITLES[route.section] || 'Inicio') + ' · Demo Salon';
    var titleEl = byId('tx-view-title');
    titleEl.textContent = ROUTE_TITLES[route.section] || 'Inicio';

    setHidden(byId('inicio-ruta-desconocida'), !route.unknown);

    // step 26 REAPERTURA §R1/§R2 — el mes visible de Horarios y ausencias.
    // Una ruta VIVA con un segmento que no se entiende no se reescribe: se
    // normaliza AL PINTAR (decisión 9 del 03) y se dice con
    // \`#horarios-aviso-ruta\`.
    if (route.section === 'horarios-y-ausencias') {
      var paramsHorarios = route.params || [];
      var mesBienFormado = paramsHorarios.length === 1 && esMesCalendarioValido(paramsHorarios[0]);
      var direccionRara = paramsHorarios.length > 0 && !mesBienFormado;
      horariosRutaCorregida = direccionRara || horariosAvisoPendiente;
      if (horariosRutaCorregida) calendarVisibleMonth = null; // "Se muestra el mes de hoy", literal
      else if (mesBienFormado) {
        var mp = paramsHorarios[0].split('-');
        calendarVisibleMonth = { year: Number(mp[0]), month: Number(mp[1]) };
      }
    } else {
      horariosRutaCorregida = false;
    }
    horariosAvisoPendiente = false; // de un solo uso, siempre
    var avisoHorarios = byId('horarios-aviso-ruta');
    if (avisoHorarios) setHidden(avisoHorarios, !horariosRutaCorregida);

    if (sectionChanged) window.scrollTo(0, 0);

    renderActiveSection();

    // D3 (revisión step 15): el foco se mueve SÓLO por una navegación, y sólo
    // a donde acaba de aparecer el contenido. Antes se enfocaba el <h1> en
    // TODO hashchange, sin la guarda que ya protegía a scrollTo: abrir el
    // detalle de una llamada mandaba el foco arriba del todo y había que
    // tabular por los cinco filtros, la región de scroll y todos los enlaces
    // "Ver" para volver a bajar. El sondeo no pasa por aquí, así que no
    // enfoca nada.
    var openedDetail = !!openCallHash && openCallHash !== previousCallHash;
    var closedDetail = !openCallHash && !!previousCallHash;
    var detailPanel = byId('llamada-detalle');
    var detailTitle = byId('llamada-detalle-titulo');
    if (openedDetail && detailTitle && detailPanel && !detailPanel.hidden) {
      // #llamada-detalle-titulo ya nace con tabindex="-1" exactamente para esto.
      detailTitle.focus({ preventScroll: true });
    } else if (sectionChanged) {
      // Va ANTES de cerrar el detalle a propósito: salir de "#/llamadas/<hash>"
      // hacia otra sección también cierra el detalle, pero allí la fila de
      // origen ya no se ve y devolverle el foco dejaría al operador leyendo
      // una sección con el foco puesto en otra.
      titleEl.focus({ preventScroll: true });
    } else if (closedDetail) {
      var origin = findCallRowLink(previousCallHash);
      if (origin && origin.focus) origin.focus();
      else titleEl.focus({ preventScroll: true });
    } else if (
      route.section === 'agenda' &&
      (agendaRouteVista !== previousAgendaVista || agendaRouteFecha !== previousAgendaFecha)
    ) {
      // step 26 §9 — misma sección, cambia VISTA o FECHA: el foco va al
      // título del intervalo (mismo patrón que \`irAPasoManual\`). Cambiar
      // SÓLO el filtro de profesional no entra por aquí a propósito: el foco
      // se quedaría fuera del <select> que el operador acaba de usar.
      var tituloRango = byId('agenda-titulo-rango');
      if (tituloRango && tituloRango.focus) tituloRango.focus({ preventScroll: true });
    }
  }

  /**
   * D4 (revisión step 15): cerrar el detalle navega a "#/llamadas" y no
   * retrocede en el historial del navegador. Si "#/llamadas/<hash>" era la
   * PRIMERA entrada del historial (enlace directo, marcador, pestaña nueva),
   * retroceder sacaba de la consola entera. Esto lleva siempre a la lista,
   * venga de donde venga.
   */
  function closeCallDetail() {
    if (window.location.hash === '#/llamadas') applyRoute();
    else window.location.hash = '#/llamadas';
  }

  function renderActiveSection() {
    if (!latestSnapshot) return;
    if (currentRoute.section === 'inicio') renderInicio(latestSnapshot);
    else if (currentRoute.section === 'agenda') renderAgenda(latestSnapshot);
    else if (currentRoute.section === 'lista-espera') renderListaEspera(latestSnapshot);
    else if (currentRoute.section === 'llamadas') renderLlamadas(latestSnapshot);
    else if (currentRoute.section === 'horarios-y-ausencias') renderHorariosYAusencias(latestSnapshot);
    else if (currentRoute.section === 'equipo') renderEquipo(latestSnapshot);
    else if (currentRoute.section === 'laboratorio') renderLaboratorio(latestSnapshot);
  }

  // Escape cierra el detalle de una llamada y devuelve el foco a la fila de
  // origen — lo mismo que hace el botón "Cerrar" de la interfaz.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var anyDialogOpen = document.querySelector('dialog[open]');
    if (anyDialogOpen) return; // <dialog> handles its own Escape natively
    if (currentRoute.section === 'llamadas' && openCallHash) {
      closeCallDetail();
    }
  });

  // ---------------------------------------------------------------------
  // Freshness (topbar) — the ONLY "this is live" claim, and it is true
  // because the poll genuinely updates it (§4.3).
  // ---------------------------------------------------------------------

  /**
   * (revisión adversarial de la capacidad 3, hallazgo B1) "#tx-freshness" ya
   * no lleva \`role\`/\`aria-live\`: sólo dice la hora, y se repinta con cada
   * sondeo de 2 s a propósito (§9.4 prohíbe una región viva ahí). La región
   * viva de conexión que exige §9.5 vive aparte, en "#tx-conexion-anuncio", y
   * esta función SÓLO le escribe algo en la transición — ok→caído o
   * caído→ok —, nunca en cada sondeo: por eso \`eraCaido\` se lee ANTES de
   * tocar la clase que \`elm\` lleva.
   */
  function renderFreshness(ok) {
    var elm = byId('tx-freshness');
    // Guarda añadida junto con B1: varios documentos de prueba de otras
    // pantallas no siembran la cabecera (no les hace falta), y antes de esta
    // reparación un \`elm\` nulo se colaba sin guarda hasta \`elm.textContent =\`
    // — un fallo que sólo no se veía porque \`refresh()\` lo atrapa en su
    // propio \`.catch()\` y, con \`lastPollOkAt\` ya puesto por el mismo turno,
    // la rama de "sin conexión" no lo tocaba una segunda vez. Mismo patrón
    // que el resto de \`renderX\`: sin el nodo que le corresponde, no hace nada.
    if (!elm) return;
    var anuncioEl = byId('tx-conexion-anuncio');
    var eraCaido = elm.classList.contains('tx-freshness--down');
    if (ok) {
      lastPollOkAt = new Date();
      // (step 18 §3.6, mitigación 1) El rótulo "(hora de tu ordenador)" es
      // obligatorio desde que existe un SEGUNDO reloj a la vista. Ésta es la
      // única lectura de reloj de pared del entregable, y ahora lo dice.
      elm.textContent = 'Pantalla actualizada a las ' + formatTimeHHmmss(lastPollOkAt) + ' (hora de tu ordenador)';
      elm.classList.remove('tx-freshness--down');
      if (eraCaido && anuncioEl) anuncioEl.textContent = 'Conexión recuperada.';
    } else if (!lastPollOkAt || Date.now() - lastPollOkAt.getTime() > DOWN_AFTER_MS) {
      // (revisión step 15, punto 2) Si NUNCA ha habido un sondeo con éxito
      // (\`lastPollOkAt\` sigue a null), no hay ningún estado "bueno" del que
      // guardar un margen de gracia: el primer sondeo fallido tiene que
      // avisar YA, no esperar DOWN_AFTER_MS de un éxito que no ha ocurrido.
      // Antes esta rama sólo se cumplía con \`lastPollOkAt\` puesto, así que un
      // arranque en frío con el motor caído dejaba "Cargando…" para siempre.
      elm.textContent = 'Sin conexión con el motor';
      elm.classList.add('tx-freshness--down');
      if (!eraCaido && anuncioEl) anuncioEl.textContent = 'Sin conexión con el motor. Lo que ves puede estar desactualizado.';
    }
  }

  /**
   * (step 18 §3.6) El SEGUNDO reloj de la barra superior, rotulado. La hora
   * y la etiqueta de "movido" llegan RESUELTAS del servidor
   * (\`operations.clock.label\` / \`.advancedLabel\`): aquí no se formatea
   * ninguna fecha y no se calcula ningún desplazamiento.
   *
   * NO es una región viva. Se repinta en cada sondeo de 2 s y anunciarlo cada
   * dos segundos sería inutilizable; es contenido normal de la cabecera.
   */
  function renderRelojSintetico(snap) {
    var nodo = byId('tx-reloj-sintetico');
    if (!nodo) return;
    var reloj = snap && snap.operations ? snap.operations.clock : null;
    if (!reloj) return;
    var texto = 'Reloj de la demostración: ' + reloj.label;
    if (reloj.advancedLabel) texto += ' (' + reloj.advancedLabel + ')';
    // Sin \`title\`: un tooltip no es un sitio donde poner información. El
    // aviso entero (\`reloj.notice\`) se lee en el panel del Laboratorio, que
    // es donde se mueve el reloj.
    setText(nodo, texto);
  }

  // ---------------------------------------------------------------------
  // INICIO
  // ---------------------------------------------------------------------

  function statForValue(numerator, denominator) {
    if (denominator === 0) return { text: 'Sin datos todavía', empty: true };
    return { text: String(numerator) + ' de ' + String(denominator), empty: false };
  }

  // D2 (step 14 repair): the first two guards below are the SAME rule
  // snapshot.ts's \`needsAttentionCall\` computes server-side for
  // \`metrics.needsAttention\` — kept in lockstep and pinned by a test in
  // tests/console/console.test.ts (server count === number of entries this
  // function would produce). If you change one, change the other.
  function callAttentionEntry(call, snap) {
    if (call.outcome === undefined || call.outcome === 'RESUELVE') return null;
    if (call.internalReasonCode === 'BOOKING_NOT_CONFIRMED') return null;
    if (call.internalReasonCode === 'TECHNICAL_FAILURE') {
      var orphanTask = findTask(snap, call.callIdHash, 'REVIEW_ORPHANED_SYNTHETIC_RESERVATION');
      if (orphanTask) {
        return { tier: 1, modifier: 'error', title: 'Un fallo técnico pudo dejar una reserva escrita sin avisar al cliente.', orphanTask: orphanTask };
      }
      return { tier: 2, modifier: 'error', title: 'Una llamada se cortó por un fallo técnico.' };
    }
    if (call.outcome === 'RECHAZA') {
      return { tier: 3, modifier: 'attention', title: 'Se bloqueó una petición por privacidad.' };
    }
    if (call.internalReasonCode === 'CUSTOMER_REQUESTS_HUMAN') {
      return { tier: 4, modifier: 'derived', title: 'El cliente pidió hablar con alguien del equipo.' };
    }
    return { tier: 4, modifier: 'derived', title: 'El asistente no pudo resolverlo y lo dejó para una persona.' };
  }

  /**
   * A dónde lleva el "Ver" de una tarea de la cola humana. Las tres tareas
   * que añade la lista de espera (step 17 §7.3) no salen de ninguna
   * llamada: mandarlas a Calendario, como hacía la única rama de repuesto
   * que había, dejaría a quien las abre en una pantalla donde no está lo que
   * tiene que hacer. La clasificación la hace el SERVIDOR
   * (\`task.reasonKind\`); esto sólo es el mapa de rutas.
   */
  var RUTA_POR_TAREA = {
    REVIEW_LATE_CANCELLATION: '#/lista-espera',
    DECIDE_WAITLIST_MATCH: '#/lista-espera',
    REVIEW_WAITLIST_CONVERSION_CONFLICT: '#/lista-espera'
  };

  function enlaceDeTarea(task) {
    if (RUTA_POR_TAREA[task.reasonKind]) return RUTA_POR_TAREA[task.reasonKind];
    if (task.callIdHash && task.callIdHash !== 'sin-llamada-asociada') return '#/llamadas/' + task.callIdHash;
    // step 26 REAPERTURA §R2 — DEUDA DE PRODUCTO (D-1 del runbook): la única
    // tarea que cae en esta rama es CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE, y
    // "Horarios y ausencias" tampoco es la pantalla donde se llama a un
    // cliente. El destino es menos malo que el anterior —al menos es donde se
    // publicó el cambio que abrió la tarea— pero sigue sin ser el correcto.
    return '#/horarios-y-ausencias';
  }

  /**
   * (step 19 §4.5) El TEXTO del enlace de una tarea PENDIENTE del historial
   * del Laboratorio. La ruta la decide \`enlaceDeTarea\` de arriba (el mismo
   * mapa que usa Inicio); esto sólo añade el rótulo que le corresponde a cada
   * caso, porque Inicio siempre dice "Ver" y aquí el texto varía con la ruta:
   * prometer "Ir a resolverla" hacia el calendario sería una promesa que esa
   * pantalla no cumple (es contexto, no un sitio donde se cierre nada).
   */
  function textoEnlaceTareaPendiente(task) {
    if (RUTA_POR_TAREA[task.reasonKind]) return 'Ir a resolverla';
    if (task.callIdHash && task.callIdHash !== 'sin-llamada-asociada') return 'Ir a resolverla';
    return 'Ver horarios y ausencias';
  }

  /**
   * (step 19 §4.3, §7.3) UNA definición para el historial entero: filtra por
   * estado (abierta/resuelta/todas) y por motivo EXACTO (\`reasonLabel\`, nunca
   * un código técnico), y ordena igual que Inicio. Pura: no toca el DOM ni el
   * array que recibe.
   */
  function filtrarHistorialDeTareas(tasks, estado, motivo) {
    return tasks.filter(function (t) {
      if (estado === 'pendientes' && !t.open) return false;
      if (estado === 'resueltas' && t.open) return false;
      if (motivo && t.reasonLabel !== motivo) return false;
      return true;
    }).slice().sort(function (a, b) { return a.createdAtISO.localeCompare(b.createdAtISO); });
  }

  /**
   * (step 19 §4.3) Los motivos que HAY en los datos, en castellano y
   * ordenados alfabéticamente. NUNCA una lista fija: así es imposible que el
   * filtro ofrezca un motivo que no exista, y no puede colarse un
   * \`ConsoleTaskReasonKind\` nuevo por aquí (step 18 §7 punto 9).
   */
  function motivosDeHistorialDeTareas(tasks) {
    var vistos = {};
    var motivos = [];
    tasks.forEach(function (t) {
      if (!vistos[t.reasonLabel]) {
        vistos[t.reasonLabel] = true;
        motivos.push(t.reasonLabel);
      }
    });
    return motivos.sort();
  }

  /**
   * (step 19 §4.3) El \`<select>\` de motivo, reconstruido SÓLO cuando el
   * conjunto de motivos ha cambiado de verdad — el mismo patrón de guarda que
   * \`ensureProfessionalOptions\`, para que el sondeo cada dos segundos no le
   * quite al operador un motivo que tuviera elegido.
   *
   * \`valorElegido\` (revisión adversarial de la capacidad 2, hallazgo H2) es
   * el motivo que \`renderHistorialDeTareas\` quiere aplicado DE VERDAD — no el
   * \`.value\` que este \`<select>\` tuviera antes de reconstruirse. Antes de
   * esta reparación, la reconstrucción sólo restauraba el valor previo si
   * seguía existiendo entre los motivos nuevos; si el motivo elegido
   * DESAPARECÍA de los datos (el mundo cambió, o hubo un reinicio),
   * \`selectEl.value\` se quedaba con ese motivo fantasma — que ya no es
   * ninguna \`<option>\` real — mientras el filtro seguía aplicándolo para
   * siempre: el panel podía enseñar «Con este filtro no queda ninguna
   * tarea» eternamente, incluso con tareas nuevas que el filtro real («Todos
   * los motivos») sí habría mostrado. Ahora quien decide el valor final es
   * SIEMPRE la variable de cliente, nunca el \`.value\` heredado del DOM.
   */
  function ensureMotivoOptions(selectEl, motivos, valorElegido) {
    // (revisión adversarial de la capacidad 3, hallazgo m8) A diferencia de
    // \`ensureProfessionalOptions\`, el CONJUNTO de motivos de este \`<select>\`
    // sí cambia durante una demostración (p. ej. "Revisar una cancelación
    // fuera de plazo" aparece en cuanto ocurre una). Reconstruirlo mientras
    // alguien lo tiene abierto le cerraría el desplegable en mitad del
    // sondeo. \`holdsFocus\` no basta aquí — protege un DESCENDIENTE, no el
    // propio nodo (ver su nota, más arriba) — así que la guarda compara
    // \`document.activeElement\` directamente contra \`selectEl\`.
    if (document.activeElement === selectEl) return;
    var existingValues = Array.prototype.map.call(selectEl.options, function (o) { return o.value; });
    var wanted = [''].concat(motivos);
    var same = existingValues.length === wanted.length && existingValues.every(function (v, i) { return v === wanted[i]; });
    if (same) return;
    clearChildren(selectEl);
    var todos = el('option', '', 'Todos los motivos');
    todos.value = '';
    selectEl.appendChild(todos);
    motivos.forEach(function (m) {
      var opt = el('option', '', m);
      opt.value = m;
      selectEl.appendChild(opt);
    });
    selectEl.value = valorElegido;
  }

  var PILDORA_TAREA_PENDIENTE = { label: 'Pendiente', modifier: 'incomplete', glyph: '●' };
  var PILDORA_TAREA_RESUELTA = { label: 'Resuelta', modifier: 'ok', glyph: '✓' };

  /**
   * (revisión adversarial de la capacidad 2, hallazgo H4) La "forma" exacta
   * que \`pintarAccionDeTarea\` va a pintar para esta tarea — no su contenido
   * completo, sólo lo que decide SI hace falta reconstruir. Dos tareas
   * "abiertas" con el mismo enlace comparten forma; una tarea que pasa de
   * abierta a resuelta (o al revés) NUNCA comparte forma con la anterior.
   */
  function formaDeAccionDeTarea(task) {
    return task.open ? 'abierta:' + enlaceDeTarea(task) : 'cerrada:' + (task.callIdHash || '');
  }

  /**
   * (step 19 §4.5) La celda de "qué se puede hacer" con una tarea del
   * historial, reconstruida DESDE CERO en cada pasada — mismo patrón que
   * \`pintarCeldaAccionAgenda\`: una tarea que pasa de pendiente a resuelta no
   * puede quedarse con el botón de la situación anterior pegado. La ÚNICA
   * excepción es el foco: si el operador navega con el teclado dentro de esta
   * celda, el sondeo no se lo quita — MIENTRAS la forma no haya cambiado.
   *
   * *(Corregido tras revisión adversarial de la capacidad 2, hallazgo H4.)*
   * La guarda de foco de arriba, sin más, dejaba una celda SELLADA para
   * siempre en cuanto el operador tabulaba hasta su enlace: si la tarea se
   * resolvía justo después (el sondeo siguiente ya la trae \`open: false\`),
   * \`holdsFocus\` seguía siendo \`true\` y la función NO tocaba nada — el
   * enlace "Ir a resolverla" hacia una tarea que ya está resuelta se quedaba
   * ahí, prometiendo una acción que ya no existe. Ahora se compara la
   * "forma" guardada (\`data-forma\`) con la que le tocaría a la tarea actual:
   * si coinciden, el foco manda y no se toca nada (como siempre); si NO
   * coinciden, la celda se reconstruye IGUAL que si nadie tuviera el foco
   * dentro — perder el foco es el mal menor frente a ofrecer una acción que
   * ya no es cierta.
   */
  function pintarAccionDeTarea(container, task) {
    var formaNueva = formaDeAccionDeTarea(task);
    if (container.getAttribute('data-forma') === formaNueva && holdsFocus(container)) return;
    clearChildren(container);
    container.setAttribute('data-forma', formaNueva);
    if (task.open) {
      var ir = el('a', 'tx-btn tx-btn--secondary', textoEnlaceTareaPendiente(task));
      ir.href = enlaceDeTarea(task);
      container.appendChild(ir);
      return;
    }
    // Resuelta: NUNCA un enlace a una acción, ni a la lista de espera aunque
    // ya no ofrezca el comando (step 19 §4.5) — sólo un enlace de CONTEXTO de
    // sólo lectura cuando hay una llamada real, o ninguno.
    if (task.callIdHash && task.callIdHash !== 'sin-llamada-asociada') {
      var ver = el('a', 'tx-btn tx-btn--secondary', 'Ver la llamada');
      ver.href = '#/llamadas/' + task.callIdHash;
      container.appendChild(ver);
      return;
    }
    container.appendChild(el('p', 'tx-context__note', 'Ya está resuelta. No hay nada que hacer aquí.'));
  }

  /**
   * (step 19 §4.3) Una fila del historial. Reconstruye la píldora y la
   * acción en cada pasada (baratas, y así nunca queda una desactualizada);
   * los textos simples se escriben con \`setText\`, que no toca el DOM si el
   * valor no ha cambiado (protege cualquier selección de texto en curso).
   */
  function buildFilaHistorialDeTareas(task, existing) {
    var li = existing || (function () {
      var node = el('li', 'tx-tarea-historial__item');
      var head = el('div', 'tx-tarea-historial__head');
      head.appendChild(el('span', 'tx-tarea-historial__label', ''));
      node.appendChild(head);
      node.appendChild(el('p', 'tx-tarea-historial__fecha', ''));
      node.appendChild(el('p', 'tx-tarea-historial__fecha', ''));
      node.appendChild(el('div', 'tx-tarea-historial__accion'));
      var det = document.createElement('details');
      det.className = 'tx-details';
      det.appendChild(el('summary', '', 'Detalle técnico'));
      var body = el('div', 'tx-details__body');
      body.appendChild(el('p', '', ''));
      body.appendChild(el('p', '', ''));
      body.appendChild(el('p', '', ''));
      body.appendChild(el('p', '', ''));
      det.appendChild(body);
      node.appendChild(det);
      return node;
    })();

    var head = li.children[0];
    setText(head.children[0], task.reasonLabel);
    var pillWanted = task.open ? PILDORA_TAREA_PENDIENTE : PILDORA_TAREA_RESUELTA;
    var pillExisting = head.children[1];
    if (!pillExisting || pillExisting.getAttribute('data-estado') !== pillWanted.label) {
      if (pillExisting) head.removeChild(pillExisting);
      var pill = buildPillEl(pillWanted);
      pill.setAttribute('data-estado', pillWanted.label);
      head.appendChild(pill);
    }

    setText(li.children[1], 'Creada el ' + formatDateTimeLong(task.createdAtISO));

    var resuelta = li.children[2];
    var tieneCierre = task.completedAtISO !== undefined;
    setHidden(resuelta, !tieneCierre);
    if (tieneCierre) setText(resuelta, 'Resuelta el ' + formatDateTimeLong(task.completedAtISO));

    pintarAccionDeTarea(li.children[3], task);

    var detBody = li.children[4].children[1];
    setText(detBody.children[0], 'Identificador: ' + task.id);
    setText(detBody.children[1], 'Llamada asociada: ' + task.callIdHash);
    setText(detBody.children[2], 'Motivo (crudo): ' + task.reason);
    setText(detBody.children[3], 'Clasificación: ' + task.reasonKind);

    return li;
  }

  /**
   * (step 19 §4.3, revisión adversarial de la capacidad 2, hallazgo H1b) La
   * clave de reconciliación de una fila del historial. \`t.id\` NO basta:
   * \`decidir-hueco-<slotKey>\`/\`contacto-<reservaId>\`/etc. son deterministas
   * POR RECADO, así que el MISMO id puede volver a aparecer más tarde — una
   * tarea cerrada, y luego una NUEVA abierta para el mismo hueco liberado de
   * nuevo (§7.6, residuo legítimo). Con la clave desnuda \`t.id\`,
   * \`reconcileList\` confundiría las dos: la fila cerrada y la fila abierta
   * colisionarían en el mismo \`data-key\`, y el contenido de una se pisaría
   * con el de la otra en repintados sucesivos (una fila "Pendiente" que en
   * el siguiente sondeo se enseña "Resuelta" sin que nadie la resolviera, o
   * al revés). \`t.id + '|' + (t.completedAtISO || '')\` ya distingue la
   * cerrada de la abierta en el caso NORMAL. El caso EXTREMO — dos tareas con
   * el MISMO id Y el MISMO \`completedAtISO\` (o dos abiertas a la vez, que el
   * servidor ya no debería producir tras H1a, pero un historial heredado
   * podría arrastrar) — se distingue con un ordinal ESTABLE, calculado una
   * sola vez sobre el array SIN FILTRAR y en su mismo orden — nunca sobre el
   * índice dentro de la lista YA filtrada, que cambia con cada filtro y con
   * cada repintado y por tanto no es estable de un sondeo al siguiente.
   */
  function construirClavesHistorialDeTareas(todas) {
    var vistos = {};
    var claves = [];
    for (var i = 0; i < todas.length; i += 1) {
      var t = todas[i];
      var base = t.id + '|' + (t.completedAtISO || '');
      var n = vistos[base] || 0;
      vistos[base] = n + 1;
      claves.push(n === 0 ? base : base + '#' + String(n));
    }
    // Se devuelve una FUNCIÓN, no el array de claves a secas: 'reconcileList'
    // pide 'keyOf(item)', y localizar el ÍNDICE de 'todas' por identidad de
    // objeto ('indexOf', misma técnica que ya usa 'ensureMotivoOptions' con
    // 'wanted.indexOf') es lo único que asocia una tarea con SU clave sin
    // depender de una colección nueva en este fichero.
    return function (tarea) {
      var indice = todas.indexOf(tarea);
      return indice === -1 ? String(tarea.id) : claves[indice];
    };
  }

  /**
   * (step 19 §4.3/§4.6/§7.5) El historial ENTERO de tareas humanas, en
   * Laboratorio. Deriva por completo de \`snap.humanQueue.tasks\`: un reinicio
   * lo deja vacío sin código nuevo, porque este panel se repinta con
   * \`renderLaboratorio\` en cada sondeo (step 19 §4.6). La selección de
   * filtros vive en \`tareasHistorialEstado\`/\`tareasHistorialMotivo\`, dos
   * variables de cliente que SÓLO tocan los manejadores de clic/cambio de
   * \`wireTareasHumanasControls\`: el sondeo nunca las toca, así que un filtro
   * elegido sobrevive a cada repintado (§7.5).
   */
  /**
   * (revisión adversarial de la capacidad 3, hallazgo M4; extendida
   * 2026-08-06 tras revisión adversarial de misión completa, hallazgo
   * BAJO 2.)* \`renderHistorialDeTareas\` repinta en CADA sondeo de 2 s, a
   * diferencia del resto de escritores de \`setEstadoLinea\` (que sólo corren
   * tras una acción). Con el libro vacío, un filtro sin resultados, O CON
   * FILAS que enseñar (texto vacío, línea oculta), eso reescribía la MISMA
   * frase —o el mismo vacío— sobre esta región cada dos segundos. Esta
   * guarda local no toca \`setEstadoLinea\` (siguen pasando por ella los
   * otros 28 escritores, con su contrato intacto): sólo evita la llamada
   * cuando el resultado ya sería idéntico.
   *
   * Comprueba \`hidden\`, no sólo \`textContent\`: un nodo recién creado (o uno
   * al que todavía no le ha tocado ESTA función) puede tener \`textContent\`
   * vacío de fábrica sin estar \`hidden\` — comprobar sólo el texto dejaría
   * la línea vacía pero VISIBLE la primera vez, en vez de oculta.
   */
  function ponerEstadoTareas(node, texto) {
    if (!node) return;
    var vacia = texto === '';
    if (node.textContent === texto && node.hidden === vacia) return;
    setEstadoLinea(node, texto, '');
  }

  /**
   * (revisión adversarial de misión completa, hallazgo MEDIO 1) Un único
   * literal para el estado vacío del historial de tareas, en vez de
   * repetirlo en \`renderHistorialDeTareas\` y en la preparación del
   * reinicio, más abajo: las dos vías tienen que decir EXACTAMENTE lo
   * mismo, o la guarda de igualdad de la segunda nunca la haría callar.
   */
  var TEXTO_TAREAS_SIN_NADA = 'Todavía no hay ninguna tarea para una persona.';

  function renderHistorialDeTareas(snap) {
    var lista = byId('lab-tareas-lista');
    if (!lista || !snap.humanQueue) return;
    var todas = snap.humanQueue.tasks;
    var motivos = motivosDeHistorialDeTareas(todas);
    // H2 (revisión adversarial de la capacidad 2): el motivo elegido ya no
    // existe entre los datos — el mundo cambió, o hubo un reinicio. El
    // filtro vuelve a "Todos los motivos" en vez de quedarse pegado para
    // siempre a un motivo que ya nunca volverá a coincidir con nada.
    if (tareasHistorialMotivo && motivos.indexOf(tareasHistorialMotivo) === -1) {
      tareasHistorialMotivo = '';
    }
    ensureMotivoOptions(byId('lab-tareas-motivo'), motivos, tareasHistorialMotivo);
    var filtradas = filtrarHistorialDeTareas(todas, tareasHistorialEstado, tareasHistorialMotivo);
    var clave = construirClavesHistorialDeTareas(todas);
    var clavesFiltradas = {};
    filtradas.forEach(function (t) { clavesFiltradas[clave(t)] = true; });
    reconcileList(lista, filtradas, function (t) { return clave(t); }, buildFilaHistorialDeTareas);
    // H5 (revisión adversarial de la capacidad 2): una fila que
    // 'reconcileList' no ha podido quitar (porque el foco vive dentro) sigue
    // siendo un nodo del DOM cuya clave ya NO está en 'filtradas' — una fila
    // FANTASMA de una tarea que este filtro ya no debería enseñar. Se oculta
    // (nunca se le quita el foco a nadie), y se vuelve a mostrar en cuanto su
    // clave vuelve a estar entre las filtradas.
    Array.prototype.forEach.call(lista.children, function (child) {
      var k = child.getAttribute('data-key');
      setHidden(child, k !== null && !clavesFiltradas[k]);
    });
    var estadoEl = byId('lab-tareas-estado');
    if (todas.length === 0) {
      ponerEstadoTareas(estadoEl, TEXTO_TAREAS_SIN_NADA);
    } else if (filtradas.length === 0) {
      ponerEstadoTareas(estadoEl, 'Con este filtro no queda ninguna tarea. Prueba con “Todas”.');
    } else {
      // (revisión adversarial de misión completa, hallazgo BAJO 2) Antes,
      // esta rama llamaba a \`limpiarLinea\` sin guarda: con filas que
      // enseñar (el caso más común, en reposo), esta línea ya está vacía y
      // oculta, y \`limpiarLinea\` la reescribía a '' de todos modos en CADA
      // sondeo de 2 s — una escritura real, aunque invisible, que las otras
      // dos ramas de arriba ya evitan con \`ponerEstadoTareas\`. Texto vacío
      // es exactamente lo que \`limpiarLinea\` deja, así que el mismo guardián
      // sirve aquí sin cambiar el resultado, sólo evitando la repetición.
      ponerEstadoTareas(estadoEl, '');
    }
  }

  /**
   * (revisión adversarial de misión completa, hallazgo MEDIO 1) Un reinicio
   * VACÍA el libro de tareas humanas siempre — \`store.reset()\` deja
   * \`humanTasks = []\` sin ninguna condición (\`memoryStore.ts\`) — así que el
   * texto correcto de \`#lab-tareas-estado\` tras CUALQUIER reinicio es
   * SIEMPRE \`TEXTO_TAREAS_SIN_NADA\`, se sepa o no de antemano si el mundo
   * llevaba tareas abiertas.
   *
   * Con un mundo POBLADO antes de reiniciar (el camino por defecto: la
   * demostración con historia, Laboratorio activo), la línea llega al turno
   * OCULTA (había tareas, así que \`renderHistorialDeTareas\` la había vaciado
   * con \`limpiarLinea\`) y el repintado que sigue al reinicio (\`refresh(true)\`,
   * si Laboratorio es la sección activa) la reescribiría con contenido NUEVO
   * — una segunda locución, además de \`#estado-global\`, incumpliendo la
   * regla de una sola del §1.3. Escribir aquí el texto correcto por la vía
   * DIRECTA (\`textContent\`/\`hidden\` a pelo, sin pasar por \`setEstadoLinea\`,
   * la vía que anuncia) hace que cuando el repintado llegue, la guarda de
   * igualdad de M4 (\`ponerEstadoTareas\`) ya encuentre el texto puesto y no
   * escriba nada más: el turno entero deja UNA sola locución. La región
   * SIGUE siendo viva para lo que de verdad tiene que serlo — un cambio de
   * filtro del operador, en cualquier momento fuera de un reinicio —, porque
   * esta escritura no le quita ni el \`role\` ni el \`aria-live\`: sólo evita
   * que la escritura del texto correcto, esta vez, pase por el camino que
   * anuncia.
   */
  function prepararHistorialDeTareasParaReinicio() {
    var estadoEl = byId('lab-tareas-estado');
    if (!estadoEl) return;
    // Guarda de igualdad, mismo motivo que M4: con el mundo YA vacío antes
    // de reiniciar (el camino de la prueba n1), el texto ya es éste — sin
    // la guarda, ésta sería una escritura de verdad, aunque redundante.
    if (estadoEl.textContent === TEXTO_TAREAS_SIN_NADA && estadoEl.hidden === false) return;
    estadoEl.textContent = TEXTO_TAREAS_SIN_NADA;
    estadoEl.hidden = false;
  }

  var tareasHistorialEstado = 'pendientes';
  var tareasHistorialMotivo = '';

  /**
   * (step 19 §4.3) Los tres botones de estado y el \`<select>\` de motivo. Se
   * engancha una sola vez, en \`DOMContentLoaded\` (\`wireLaboratorioControls\`),
   * como el resto de los controles de esta consola.
   */
  function wireTareasHumanasControls() {
    var estados = ['pendientes', 'resueltas', 'todas'];
    estados.forEach(function (estado) {
      byId('lab-tareas-filtro-' + estado).addEventListener('click', function () {
        tareasHistorialEstado = estado;
        estados.forEach(function (e) {
          byId('lab-tareas-filtro-' + e).setAttribute('aria-pressed', String(e === estado));
        });
        renderActiveSection();
      });
    });
    byId('lab-tareas-motivo').addEventListener('change', function (ev) {
      tareasHistorialMotivo = ev.target.value;
      renderActiveSection();
    });
  }

  // ---------------------------------------------------------------------
  // step 19 Capacidad 3A — «Resumen para revisar con Bruno» (Laboratorio).
  // Espejo de solo lectura: ni una cifra se calcula aquí, todo llega resuelto
  // en \`snap.demo.summary\` (§5.2, §6.4).
  // ---------------------------------------------------------------------

  /** A4/B9/C4 (§5.2.2, §8.5): las tres cifras de reservas llevan, cada una, la misma nota de que no se suman. */
  function esMedidaDeReservas(id) {
    return id === 'A4' || id === 'B9' || id === 'C4';
  }

  function buildFilaResumenMedida(reservationsNote, measure, existing) {
    var div = existing || (function () {
      var node = el('div', 'tx-resumen-medida');
      var linea = el('p', 'tx-resumen-medida__linea');
      linea.appendChild(el('span', 'tx-resumen-medida__label', ''));
      linea.appendChild(el('span', '', ': '));
      linea.appendChild(el('span', 'tx-resumen-medida__valor', ''));
      node.appendChild(linea);
      var det = document.createElement('details');
      det.className = 'tx-details';
      det.appendChild(el('summary', '', 'Qué cuenta y qué no'));
      var body = el('div', 'tx-details__body');
      body.appendChild(el('p', '', ''));
      body.appendChild(el('p', '', ''));
      det.appendChild(body);
      node.appendChild(det);
      node.appendChild(el('p', 'tx-context__note', ''));
      return node;
    })();
    div.setAttribute('data-id', measure.id);
    var linea = div.children[0];
    // (revisión adversarial de la capacidad 3, hallazgo m2) C1 es la única
    // medida cuyo valor es una FRASE ya compuesta (measure.value === null,
    // p. ej. "Inasistencias anotadas ahora mismo (sintéticas): 0 · Registros
    // corregidos: 0"), no un número con un rótulo delante. Pintar el rótulo
    // Y la frase producía un tartamudeo — "Inasistencias: Inasistencias
    // anotadas…" — exactamente el mismo caso que measureBullet() ya evita en
    // el texto copiado (demoWorkspace.ts). Con value === null se pinta SÓLO
    // valueLabel: se vacía el rótulo y se oculta el separador ": ".
    var esFrase = measure.value === null;
    setText(linea.children[0], esFrase ? '' : measure.label);
    setHidden(linea.children[1], esFrase);
    // El separador también se vacía (no sólo se oculta): 'hidden' no excluye
    // el nodo de '.textContent', así que dejar ': ' ahí seguiría leyéndose
    // delante del valor para quien lea el texto plano de la fila.
    setText(linea.children[1], esFrase ? '' : ': ');
    setText(linea.children[2], measure.valueLabel);
    var body = div.children[1].children[1];
    setText(body.children[0], measure.increasesWhen);
    setText(body.children[1], measure.doesNotIncreaseWhen);
    var nota = div.children[2];
    var esDeReservas = esMedidaDeReservas(measure.id);
    setHidden(nota, !esDeReservas);
    setText(nota, esDeReservas ? reservationsNote : '');
    return div;
  }

  /**
   * Pinta el panel entero desde \`snap.demo.summary\`. Los tres bloques se
   * reconcilian por \`block.id\`, y cada medida dentro de un bloque por
   * \`measure.id\` — el \`<details>\` abierto de una definición y el mensaje de
   * copiado sobreviven al sondeo (§7.5): esta función nunca toca
   * \`#lab-resumen-copiar-estado\` ni el \`<textarea>\` de respaldo.
   */
  function renderResumenOwner(snap) {
    var resumen = snap.demo && snap.demo.summary;
    var relojEl = byId('lab-resumen-reloj');
    // Documentos de prueba que no siembran este panel (p. ej. las de otras
    // capacidades, que sólo montan sus propios ids): igual que el resto de
    // \`renderX\` de este fichero, se sale en silencio en vez de romper.
    if (!resumen || !relojEl) return;
    setText(relojEl, resumen.clockLine);
    setText(byId('lab-resumen-fixture'), resumen.fixtureLine);
    reconcileList(byId('lab-resumen-bloques'), resumen.blocks, function (b) { return b.id; }, function (block, existing) {
      var div = existing || (function () {
        var node = el('div', 'tx-resumen-bloque');
        node.appendChild(el('h3', '', ''));
        node.appendChild(el('div', ''));
        return node;
      })();
      setText(div.children[0], block.title);
      reconcileList(div.children[1], block.measures, function (m) { return m.id; }, function (m, ex) {
        return buildFilaResumenMedida(resumen.reservationsNote, m, ex);
      });
      return div;
    });
  }

  /**
   * (§5.2.6, hallazgo M2) Vacía y vuelve a ocultar el respaldo, y limpia la
   * línea de estado de copiado. Se llama desde \`limpiarEstadosTransitorios\`
   * (vía \`REGIONES_TRANSITORIAS\`, sólo la línea) Y explícitamente desde la
   * secuencia de reinicio para el \`<textarea>\`, que no está en esa lista
   * porque no es una línea de estado sino un campo con contenido propio.
   */
  function limpiarRespaldoDeCopiaDelResumen() {
    var respaldo = byId('lab-resumen-respaldo');
    if (!respaldo) return;
    respaldo.value = '';
    setHidden(respaldo, true);
  }

  function mostrarRespaldoDeCopiaDelResumen(texto, estadoEl) {
    var respaldo = byId('lab-resumen-respaldo');
    respaldo.value = texto;
    setHidden(respaldo, false);
    if (respaldo.focus) respaldo.focus();
    if (respaldo.select) respaldo.select();
    setEstadoLinea(estadoEl, 'Tu navegador no ha dejado copiar. El texto está aquí abajo, entero y ya seleccionado: cópialo con Cmd+C.', '');
  }

  /**
   * (§5.2.6, regla dura de la enmienda m11) \`navigator.clipboard.writeText\`
   * se llama de forma SÍNCRONA dentro de este manejador, sin ningún \`await\`
   * ni \`.then()\` antes: el texto ya está compuesto (\`resumen.copyText\`, que
   * llega hecho en la instantánea) y lo único que se le añade aquí es el
   * sello de copia, una concatenación de cadenas ya escritas por el
   * servidor (\`copyStampPrefix\`/\`copyStampSuffix\`) más la hora LOCAL
   * formateada a mano — nunca \`toISOString()\`, que devolvería UTC bajo un
   * rótulo que promete hora local.
   */
  function wireResumenOwnerControls() {
    byId('lab-resumen-copiar').addEventListener('click', function () {
      var resumen = latestSnapshot && latestSnapshot.demo && latestSnapshot.demo.summary;
      if (!resumen) return;
      var estadoEl = byId('lab-resumen-copiar-estado');
      var ahora = new Date();
      var fecha = String(ahora.getFullYear()) + '-' + String(ahora.getMonth() + 1).padStart(2, '0') + '-' + String(ahora.getDate()).padStart(2, '0');
      var hora = String(ahora.getHours()).padStart(2, '0') + ':' + String(ahora.getMinutes()).padStart(2, '0');
      var sello = resumen.copyStampPrefix + fecha + ' ' + hora + resumen.copyStampSuffix;
      // El sello va justo detrás de la línea del fixture, exactamente donde lo
      // enseña el §5.2.7. \`fixtureLine\` aparece una sola vez en \`copyText\`,
      // así que se localiza con \`indexOf\` y se inserta con UN solo corte de
      // cadena — nunca \`split(...).join(...)\`, que insertaría el sello una
      // vez por cada aparición de \`fixtureLine\` si alguna vez dejara de ser
      // única (revisión adversarial de la capacidad 3, hallazgo m7).
      var idxFixture = resumen.copyText.indexOf(resumen.fixtureLine);
      var texto = resumen.copyText;
      if (idxFixture !== -1) {
        var puntoDeCorte = idxFixture + resumen.fixtureLine.length;
        texto = texto.slice(0, puntoDeCorte) + '\\n' + sello + texto.slice(puntoDeCorte);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(function () {
          setEstadoLinea(estadoEl, 'Resumen copiado al portapapeles.', 'ok');
          limpiarRespaldoDeCopiaDelResumen();
        }).catch(function () {
          mostrarRespaldoDeCopiaDelResumen(texto, estadoEl);
        });
      } else {
        mostrarRespaldoDeCopiaDelResumen(texto, estadoEl);
      }
    });
  }

  // ---------------------------------------------------------------------
  // step 19 Capacidad 3B — «Guion en pantalla para enseñar la demostración»
  // (Laboratorio). El navegador no evalúa ni un predicado de negocio: pinta
  // un estado y una frase, las dos resueltas en \`snap.demo\` (§5.3.3).
  // ---------------------------------------------------------------------

  /** Selección de guion, estado de CLIENTE (§5.3.7): ninguno marcado al cargar, y sobrevive al sondeo igual que el filtro de tareas. */
  var guionElegido = null;

  var PILDORA_PASO = {
    hecho: { label: 'Hecho', modifier: 'ok', glyph: '✓' },
    todavia_no: { label: 'Todavía no', modifier: 'incomplete', glyph: '○' },
    no_comprobable: { label: 'Aún no comprobado', modifier: 'none', glyph: '—' }
  };

  function buildFilaGuionPaso(step, existing) {
    var li = existing || (function () {
      var node = el('li', 'tx-guion-paso');
      var head = el('div', 'tx-guion-paso__head');
      head.appendChild(el('span', 'tx-guion-paso__titulo', ''));
      node.appendChild(head);
      node.appendChild(el('p', 'tx-guion-paso__pista', ''));
      node.appendChild(el('p', 'tx-guion-paso__evidencia', ''));
      node.appendChild(el('a', 'tx-btn tx-btn--secondary', ''));
      return node;
    })();
    var head = li.children[0];
    // (revisión adversarial de la capacidad 3, hallazgo M3) "N. Título" ya
    // llega compuesto del servidor (\`step.stepTitleLine\`): antes de esta
    // reparación se concatenaba aquí mismo, una composición de cadena de
    // negocio en el navegador que I2 prohíbe.
    setText(head.children[0], step.stepTitleLine);
    var pillWanted = PILDORA_PASO[step.evidenceState];
    var pillExisting = head.children[1];
    if (!pillExisting || pillExisting.getAttribute('data-estado') !== pillWanted.label) {
      if (pillExisting) head.removeChild(pillExisting);
      var pill = buildPillEl(pillWanted);
      pill.setAttribute('data-estado', pillWanted.label);
      head.appendChild(pill);
    }
    setText(li.children[1], step.cue);
    setText(li.children[2], step.evidenceLabel);
    var enlace = li.children[3];
    enlace.href = step.whereHref;
    // (mismo hallazgo M3) "Ir a {pantalla}" también llega compuesto
    // (\`step.linkLabel\`, a partir de GUIDE_COPY.linkPrefix en el servidor).
    setText(enlace, step.linkLabel);
    return li;
  }

  /**
   * Pinta el panel entero: la luz de precondición (siempre), y — sólo si hay
   * un guion elegido — su título, sus pasos (reconciliados por \`step.id\`) y
   * la línea de progreso. Un paso NUNCA cambia de estado por esta función:
   * sólo refleja lo que \`snap.demo\` ya ha resuelto.
   *
   * (revisión adversarial de la capacidad 3, hallazgo m4) El aviso de
   * reinicio («Los dos guiones describen mundos distintos…») ya NO lo pinta
   * esta función: es texto ESTÁTICO en \`ui.html.ts\` — nace visible en el
   * primer HTML servido, sobrevive a un arranque en frío sin respuesta del
   * motor, y no hay una segunda fuente que pudiera divergir de ella (mismo
   * patrón que el rótulo permanente del resumen, §5.2.5).
   */
  function renderGuionEnPantalla(snap) {
    var demo = snap.demo;
    var avisoEl = byId('lab-guion-aviso');
    // Igual que \`renderResumenOwner\`: documentos de prueba que no siembran
    // este panel se ignoran en silencio, como el resto de \`renderX\`. El
    // guardián sigue comprobando \`avisoEl\` (marca que este panel existe en
    // el documento), aunque ya no le escriba nada.
    if (!demo || !avisoEl) return;
    var luz = byId('lab-guion-precondicion');
    setText(luz, demo.startingPoint.label);
    luz.classList.toggle('tx-status-line--ok', !!demo.startingPoint.ready);
    // (revisión adversarial de la capacidad 3, hallazgo m6) \`--conflict\`, no
    // \`--error\`: que la demostración esté "sucia" (con historia) no es nada
    // roto — es el estado normal a mitad de un runbook —, así que se dice en
    // ámbar, con el mismo tono que el aviso estático de arriba, nunca en rojo
    // (§9.5 de step 17, mismo criterio que \`.tx-status-line--conflict\`).
    luz.classList.toggle('tx-status-line--conflict', !demo.startingPoint.ready);

    var contenido = byId('lab-guion-contenido');
    var sinElegir = byId('lab-guion-sin-elegir');
    if (!guionElegido) {
      setHidden(contenido, true);
      setHidden(sinElegir, false);
      return;
    }
    setHidden(sinElegir, true);
    setHidden(contenido, false);
    var guias = demo.guides.filter(function (g) { return g.id === guionElegido; });
    var guia = guias[0];
    if (!guia) return;
    setText(byId('lab-guion-titulo'), guia.title);
    reconcileList(byId('lab-guion-pasos'), guia.steps, function (s) { return s.id; }, buildFilaGuionPaso);
    setText(byId('lab-guion-progreso'), guia.progressLine);
  }

  /**
   * (§5.3.2, enmienda M4) El control de reinicio de este panel SÓLO mueve el
   * foco a \`#btn-abrir-reset\` — no llama a \`abrirDialogoReset\`, no abre
   * ningún \`<dialog>\` propio y no dispara ningún \`fetch\`. El reinicio lo
   * dispara el operador, después, desde el botón de siempre.
   */
  function wireGuionEnPantallaControls() {
    byId('lab-guion-ir-a-reiniciar').addEventListener('click', function () {
      var boton = byId('btn-abrir-reset');
      if (boton && boton.scrollIntoView) boton.scrollIntoView({ block: 'center' });
      if (boton && boton.focus) boton.focus();
    });
    ['lab-guion-radio-1', 'lab-guion-radio-2'].forEach(function (id) {
      byId(id).addEventListener('change', function (ev) {
        guionElegido = ev.target.value;
        renderActiveSection();
      });
    });
  }

  // =====================================================================
  // step 20 — TALLER DE DECISIONES CON BRUNO (diseño §3) — INICIO DEL BLOQUE
  //
  // REGLA DURA DE TODO ESTE BLOQUE (D20-1, I20-15): aquí no se persiste
  // NADA y no sale NINGUNA petición. El borrador es una variable de este
  // cierre y muere con la pestaña; una prueba barre este bloque entero
  // buscando cualquier superficie de persistencia o canal lateral.
  //
  // Y la segunda regla, D20-51: todo manejador de una tarjeta se asigna
  // por PROPIEDAD (.onchange/.oninput/.onclick). reconcileList REUTILIZA
  // los nodos, así que un repintado vuelve a pasar por buildTarjetaTaller
  // sobre el mismo input: una propiedad reasignada sigue siendo UN solo
  // manejador; addEventListener acumularía uno por repintado. Por eso
  // addEventListener sólo aparece en wireTallerControls, una vez y sobre
  // nodos estáticos del HTML servido (los cinco filtros, el botón de
  // borrado total y su <dialog>).
  // =====================================================================

  /**
   * El borrador efímero (D20-26): { '<entryId>': { opcion: 'A'|'B'|'C'|null, nota: '' } }.
   * Misma naturaleza que guionElegido y huecoSeleccion: vive en memoria,
   * sobrevive al sondeo y al cambio de ruta, el reinicio de la demostración
   * NO lo toca (D20-27) y una recarga completa lo pierde — dicho por escrito
   * en el propio panel (§8.1).
   */
  var tallerBorrador = {};
  /** Filtro y búsqueda: estado de cliente. El reinicio tampoco los toca (I20-4). */
  var tallerFiltro = 'todas';
  var tallerBusqueda = '';
  /** D20-20 capa 1: la huella del catálogo con la que se pintó por última vez. */
  var tallerHuellaPintada = null;
  /** La vista pintada (recuentos, filtros, textos del diálogo). */
  var tallerVista = null;
  /** El texto de búsqueda de cada entrada, normalizado UNA vez al pintar (§3.5). */
  var tallerTextoNormalizado = {};
  var tallerCuentaVisible = 0;
  var tallerAnuncioPendiente = null;

  var FILTROS_TALLER = ['todas', 'bloquean', 'esperan', 'sin-respuesta', 'anotadas'];

  /** D20-23 — respaldo con mapa explícito para el único caso sin String.prototype.normalize. */
  var ACENTOS_TALLER = { 'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
    'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i', 'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o',
    'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u', 'ñ': 'n', 'ç': 'c' };

  /**
   * D20-23 — normalizador tolerante a acentos, simétrico (se aplica al texto
   * y a lo tecleado, así que «año» encuentra «año»). El rango del replace es
   * el de las marcas diacríticas combinantes.
   */
  function normalizarBusqueda(texto) {
    var s = String(texto).toLowerCase();
    if (typeof s.normalize === 'function') {
      return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
    }
    return s.replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, function (c) { return ACENTOS_TALLER[c]; });
  }

  function borradorDeEntrada(entryId) {
    if (!tallerBorrador[entryId]) tallerBorrador[entryId] = { opcion: null, nota: '' };
    return tallerBorrador[entryId];
  }

  function borradorConAlgo(b) {
    return !!b && (b.opcion !== null || b.nota !== '');
  }

  /**
   * §3.10 (D20-31) — los tres recuentos de cobertura. El denominador son
   * IDENTIFICADORES, no entradas: responder J5/K1 suma dos (D20-10); L1 va
   * aparte y nunca entra en el 32. Sin porcentajes, sin barras, sin metas
   * (I20-8): sólo cuánto se ha ANOTADO, que el rótulo estático de al lado
   * dice que no es cuánto se ha aprobado. Las anotaciones huérfanas (§3.13)
   * no cuentan: sólo se recorren las entradas del catálogo pintado.
   */
  function actualizarCoberturaDelTaller() {
    var cobertura = byId('tx-taller-cobertura');
    if (!cobertura || !tallerVista) return;
    var copy = tallerVista.copy.coverage;
    var jk = 0;
    var lAnotada = false;
    // (Revisión U11-7) La coletilla de J5/K1 sólo cuando una entrada
    // RESPONDIDA comparte de verdad identificadores: antes salía con
    // cualquier jk > 0, explicando un reparto que no había ocurrido.
    var compartidaAnotada = false;
    var bloqueantesSinRespuesta = [];
    tallerVista.entries.forEach(function (e) {
      var b = tallerBorrador[e.entryId];
      var respondida = !!b && b.opcion !== null;
      if (respondida && e.identifiers.length > 1) compartidaAnotada = true;
      e.identifiers.forEach(function (id) {
        var esL = id.charAt(0) === 'L';
        if (respondida && !esL) jk += 1;
        if (respondida && esL) lAnotada = true;
        if (!respondida && e.urgency.kind === 'bloquea') bloqueantesSinRespuesta.push(id);
      });
    });
    setText(cobertura.children[0], copy.answeredPrefix + String(jk) + copy.answeredSuffix + (compartidaAnotada ? ' ' + copy.sharedAnswerNote : ''));
    setText(cobertura.children[1], lAnotada ? copy.lDone : copy.lPending);
    var linea;
    if (bloqueantesSinRespuesta.length === 0) {
      linea = copy.blockingNonePending;
    } else {
      var prefijo = bloqueantesSinRespuesta.length === 1 ? copy.blockingPendingSingularPrefix : copy.blockingPendingPluralPrefix;
      linea = prefijo + String(bloqueantesSinRespuesta.length) + copy.blockingPendingSuffix + bloqueantesSinRespuesta.join(', ') + '.';
    }
    setText(cobertura.children[2], linea);
  }

  /** §3.5 — el criterio de visibilidad: filtro y búsqueda combinados por conjunción. */
  function tallerEntradaVisible(e) {
    var b = tallerBorrador[e.entryId] || null;
    if (tallerFiltro === 'bloquean' && e.urgency.kind !== 'bloquea') return false;
    if (tallerFiltro === 'esperan' && e.urgency.kind !== 'puede_esperar') return false;
    if (tallerFiltro === 'sin-respuesta' && b !== null && b.opcion !== null) return false;
    if (tallerFiltro === 'anotadas' && !borradorConAlgo(b)) return false;
    var q = normalizarBusqueda(tallerBusqueda);
    if (q !== '' && String(tallerTextoNormalizado[e.entryId] || '').indexOf(q) === -1) return false;
    return true;
  }

  /**
   * (Revisión U11-9) Los nodos que gobiernan el rescate de foco, capturados
   * ANTES de ocultar nada: la tarjeta y el grupo que contienen al elemento
   * activo. Consultar document.activeElement DESPUÉS del bucle de ocultado
   * confiaba en que ningún motor lo hubiera movido ya a <body> al ocultar a
   * su dueño — un orden que ningún estándar garantiza. Con la captura
   * previa, la decisión se toma sobre lo que había, no sobre lo que quede.
   */
  function capturarFocoDelTaller(raiz) {
    var activo = document.activeElement;
    if (!activo || !raiz.contains || !raiz.contains(activo)) return null;
    var captura = { tarjeta: null, grupo: null };
    var cur = activo;
    while (cur && cur !== raiz) {
      if (cur.classList && cur.classList.contains('tx-taller-card')) captura.tarjeta = cur;
      if (cur.classList && cur.classList.contains('tx-taller-bloque')) captura.grupo = cur;
      cur = cur.parentNode;
    }
    return captura;
  }

  /** ¿Lo capturado antes de filtrar quedó oculto por el filtrado? */
  function focoCapturadoQuedaOculto(captura) {
    if (!captura) return false;
    if (captura.tarjeta && captura.tarjeta.hidden) return true;
    return !!(captura.grupo && captura.grupo.hidden);
  }

  function anunciarResultadoDelTaller() {
    if (!tallerVista) return;
    var copy = tallerVista.copy;
    // (Revisión U11-6) El caso CERO con su frase servida propia: «Se
    // enseñan 0 de las 32…» leía mal y no decía qué hacer. No se toca el
    // nodo de «el catálogo no ha llegado» (§3.13): son hechos distintos.
    if (tallerCuentaVisible === 0) {
      setEstadoLinea(byId('tx-taller-estado'), copy.resultsNone, '');
      return;
    }
    var prefijo = tallerCuentaVisible === 1 ? copy.resultsSingularPrefix : copy.resultsPluralPrefix;
    setEstadoLinea(byId('tx-taller-estado'), prefijo + String(tallerCuentaVisible) + copy.resultsSuffix, '');
  }

  function cancelarAnuncioDeBusquedaDelTaller() {
    if (tallerAnuncioPendiente !== null) {
      clearTimeout(tallerAnuncioPendiente);
      tallerAnuncioPendiente = null;
    }
  }

  /** §3.11, punto 4 — el rebote de 250 ms de la búsqueda: una locución por búsqueda, no por pulsación. */
  function programarAnuncioDeBusquedaDelTaller() {
    cancelarAnuncioDeBusquedaDelTaller();
    tallerAnuncioPendiente = setTimeout(function () {
      tallerAnuncioPendiente = null;
      anunciarResultadoDelTaller();
    }, 250);
  }

  /**
   * §3.5/§3.11 — aplica filtro y búsqueda con 'hidden', sin destruir nada:
   * un radio enfocado sigue existiendo. Si la tarjeta enfocada deja de
   * verse, el foco va a la línea de resultados, que en ese mismo turno dice
   * cuántas quedan; si sigue visible, el foco NO se mueve. Devuelve si ha
   * anunciado, para que la búsqueda no locute dos veces.
   */
  function aplicarFiltroDelTaller(anunciar) {
    var lista = byId('tx-taller-lista');
    if (!lista || !tallerVista) return false;
    // (U11-9) El foco se captura ANTES de ocultar nada — ver capturarFocoDelTaller.
    var focoAntes = capturarFocoDelTaller(lista);
    var porId = {};
    tallerVista.entries.forEach(function (e) { porId[e.entryId] = e; });
    var visibles = 0;
    Array.prototype.forEach.call(lista.children, function (grupo) {
      if (grupo.getAttribute('data-key') === 'huerfanas') return;
      var tarjetas = childByClass(grupo, 'tx-taller-bloque__tarjetas');
      if (!tarjetas) return;
      var algunaVisible = false;
      Array.prototype.forEach.call(tarjetas.children, function (tarjeta) {
        var entrada = porId[tarjeta.getAttribute('data-key')];
        var visible = !!entrada && tallerEntradaVisible(entrada);
        setHidden(tarjeta, !visible);
        if (visible) { algunaVisible = true; visibles += 1; }
      });
      setHidden(grupo, !algunaVisible);
    });
    tallerCuentaVisible = visibles;
    var rescatar = focoCapturadoQuedaOculto(focoAntes);
    if (anunciar || rescatar) {
      cancelarAnuncioDeBusquedaDelTaller();
      anunciarResultadoDelTaller();
    }
    if (rescatar) {
      var estado = byId('tx-taller-estado');
      if (estado && estado.focus) estado.focus();
    }
    return anunciar || rescatar;
  }

  /** D20-29 — por tarjeta, sin diálogo, nunca deshabilitado; el foco se queda en el botón, que sigue existiendo. */
  function borrarBorradorDeUnaTarjeta(entry, card) {
    var copy = tallerVista.copy;
    var estado = byId('tx-taller-estado');
    var b = tallerBorrador[entry.entryId];
    if (!borradorConAlgo(b)) {
      setEstadoLinea(estado, copy.nothingToClearPrefix + entry.entryId + copy.nothingToClearSuffix, '');
      return;
    }
    delete tallerBorrador[entry.entryId];
    var opciones = card.children[3].children[2];
    Array.prototype.forEach.call(opciones.children, function (fila) {
      if (fila.children[0].checked) fila.children[0].checked = false;
    });
    var campo = card.children[4].children[0].children[1];
    campo.value = '';
    setText(card.children[4].children[1], '0' + copy.noteCounterSuffix);
    actualizarCoberturaDelTaller();
    setEstadoLinea(estado, copy.clearedStatusPrefix + entry.entryId + copy.clearedStatusSuffix, '');
  }

  /**
   * §3.6 — la tarjeta de una decisión, con los índices de hijo normativos:
   * [0] título+píldora · [1] pregunta · [2] comportamiento hoy (FUERA del
   * fieldset: nunca es una opción) · [3] fieldset con leyenda propia
   * (D20-47) y radios sin preselección (D20-24) · [4] nota corta ·
   * [5] detalle plegado · [6] «Borrar este borrador». El nombre accesible de
   * cada radio es SÓLO su <span> (lección M19R1): nada más entra en el label.
   */
  function buildTarjetaTaller(entry, bloque, existing) {
    var card = existing || (function () {
      var node = el('article', 'tx-taller-card');
      var titulo = el('h4', 'tx-taller-card__titulo');
      titulo.appendChild(el('span', '', ''));
      titulo.appendChild(el('span', 'tx-taller-urgencia', ''));
      node.appendChild(titulo);
      var pregunta = el('p', 'tx-taller-card__pregunta');
      pregunta.appendChild(el('span', '', ''));
      // (U11-4) El aparte lleva clase propia: la cursiva que en el pack
      // ponían los asteriscos de Markdown aquí la pone el CSS.
      pregunta.appendChild(el('span', 'tx-taller-card__aparte', ''));
      node.appendChild(pregunta);
      var hoy = el('div', 'tx-taller-card__hoy');
      hoy.appendChild(el('p', 'tx-taller-card__rotulo', ''));
      hoy.appendChild(el('p', '', ''));
      node.appendChild(hoy);
      var grupo = document.createElement('fieldset');
      grupo.className = 'tx-taller-card__choice';
      grupo.appendChild(el('legend', '', ''));
      grupo.appendChild(el('p', 'tx-context__note', ''));
      grupo.appendChild(el('div', 'tx-taller-card__opciones', ''));
      node.appendChild(grupo);
      var nota = el('div', 'tx-taller-nota');
      var etiqueta = el('label', '');
      etiqueta.appendChild(el('span', '', ''));
      var campo = document.createElement('textarea');
      campo.className = 'tx-taller-nota__campo';
      campo.setAttribute('rows', '2');
      campo.setAttribute('maxlength', '280');
      // D20-52: sin esto, el navegador puede ofrecer como sugerencia lo
      // escrito en otra sesión — la persistencia que este panel promete no tener.
      campo.setAttribute('autocomplete', 'off');
      etiqueta.appendChild(campo);
      nota.appendChild(etiqueta);
      nota.appendChild(el('p', 'tx-taller-nota__contador', ''));
      nota.appendChild(el('p', 'tx-context__note', ''));
      node.appendChild(nota);
      var det = document.createElement('details');
      det.className = 'tx-details';
      det.appendChild(el('summary', '', ''));
      var cuerpo = el('div', 'tx-details__body');
      for (var i = 0; i < 6; i += 1) cuerpo.appendChild(el('p', '', ''));
      det.appendChild(cuerpo);
      node.appendChild(det);
      var btn = el('button', 'tx-btn tx-btn--secondary', '');
      btn.type = 'button';
      node.appendChild(btn);
      return node;
    })();

    var copy = tallerVista.copy;
    var b = tallerBorrador[entry.entryId] || null;

    var titulo = card.children[0];
    setText(titulo.children[0], entry.identifiersLabel);
    var pill = titulo.children[1];
    setText(pill, entry.urgencyPillLabel);
    // El tono se elige por 'kind', nunca comparando el texto (I20-3); las
    // bloqueantes usan el tono de CONFLICTO de la casa, no el de error (§3.10).
    pill.classList.toggle('tx-taller-urgencia--bloquea', entry.urgency.kind === 'bloquea');
    pill.classList.toggle('tx-taller-urgencia--espera', entry.urgency.kind !== 'bloquea');

    var pregunta = card.children[1];
    setText(pregunta.children[0], entry.question);
    // (U11-4) En pantalla, la variante SIN asteriscos servida en
    // questionAsideDisplay; el verbatim queda para el acta y la deriva.
    setText(pregunta.children[1], entry.questionAsideDisplay ? ' ' + entry.questionAsideDisplay : '');
    setHidden(pregunta.children[1], !entry.questionAsideDisplay);

    setText(card.children[2].children[0], copy.todayHeading);
    setText(card.children[2].children[1], entry.currentBehaviour);

    var grupo = card.children[3];
    setText(grupo.children[0], entry.legendLabel);
    setText(grupo.children[1], copy.nothingMarkedNote);
    var opciones = grupo.children[2];
    var nombreGrupo = 'taller-' + entry.entryId;
    reconcileList(opciones, entry.options, function (o) { return o.letter; }, function (opcion, existente) {
      var fila = existente || (function () {
        var l = el('label', 'tx-radio-field');
        var input = document.createElement('input');
        input.type = 'radio';
        l.appendChild(input);
        l.appendChild(el('span', '', ''));
        return l;
      })();
      var radio = fila.children[0];
      radio.name = nombreGrupo;
      radio.value = opcion.letter;
      radio.setAttribute('name', nombreGrupo);
      radio.setAttribute('value', opcion.letter);
      radio.setAttribute('autocomplete', 'off');
      // SIN PRESELECCIÓN (D20-24): sólo queda marcado lo que marcó una
      // persona, reaplicado desde el borrador — el patrón de huecoSeleccion.
      var elegido = b !== null && b.opcion === opcion.letter;
      if (radio.checked !== elegido) radio.checked = elegido;
      radio.onchange = function () {
        borradorDeEntrada(entry.entryId).opcion = opcion.letter;
        // La cobertura se repinta en silencio; el propio radio ya locuta.
        // La visibilidad NO se recalcula aquí: marcar no es filtrar, y
        // esconder la tarjeta bajo la mano de quien la marca movería el
        // foco sin que nadie haya filtrado (§3.11, punto 1).
        actualizarCoberturaDelTaller();
      };
      setText(fila.children[1], '(' + opcion.letter + ') ' + opcion.text);
      return fila;
    });

    var nota = card.children[4];
    setText(nota.children[0].children[0], copy.noteFieldTag);
    var campo = nota.children[0].children[1];
    var contador = nota.children[1];
    // (Revisión U11-2) El aviso de datos personales y el contador estaban al
    // lado del campo sin ninguna asociación programática: un lector de
    // pantalla enfocaba el <textarea> sin oír ni el aviso ni el tope. Los dos
    // ids generados son la excepción DECLARADA de §6.2 (enmienda U11-2):
    // existen sólo como destino de aria-describedby. La barra de J5/K1 es
    // válida en un id de HTML5 y aquí nadie los busca con selectores CSS.
    var avisoId = 'tx-taller-aviso-' + entry.entryId;
    var contadorId = 'tx-taller-contador-' + entry.entryId;
    nota.children[2].setAttribute('id', avisoId);
    contador.setAttribute('id', contadorId);
    campo.setAttribute('aria-describedby', avisoId + ' ' + contadorId);
    var notaTexto = b !== null ? b.nota : '';
    if (campo.value !== notaTexto) campo.value = notaTexto;
    setText(contador, String(notaTexto.length) + copy.noteCounterSuffix);
    campo.oninput = function () {
      var v = String(campo.value);
      // D20-49, punto 2: maxlength es una barrera del navegador y un pegado
      // programático la atraviesa. Aquí se recorta A LA VISTA y se dice.
      if (v.length > 280) {
        v = v.slice(0, 280);
        campo.value = v;
        setEstadoLinea(byId('tx-taller-estado'), copy.noteTruncatedStatus, '');
      }
      borradorDeEntrada(entry.entryId).nota = v;
      setText(contador, String(v.length) + copy.noteCounterSuffix);
    };
    setText(nota.children[2], copy.notePrivacyNote);

    var det = card.children[5];
    // (U11-3) El <summary> servido RESUELTO por entrada: 32 nombres
    // accesibles distintos, como la leyenda (D20-47).
    setText(det.children[0], entry.detailsSummaryLabel);
    var cuerpo = det.children[1];
    setText(cuerpo.children[0], entry.urgency.label);
    var deps = entry.dependsOn.concat(entry.externalDependencies);
    setText(cuerpo.children[1], deps.length === 0 ? '' : tallerVista.acta.dependsPrefix + deps.join(' · '));
    setHidden(cuerpo.children[1], deps.length === 0);
    setText(cuerpo.children[2], deps.length === 0 ? '' : copy.dependenciesNote);
    setHidden(cuerpo.children[2], deps.length === 0);
    setText(cuerpo.children[3], entry.notImplementedNote ? copy.notImplementedHeading : '');
    setHidden(cuerpo.children[3], !entry.notImplementedNote);
    setText(cuerpo.children[4], entry.notImplementedNote || '');
    setHidden(cuerpo.children[4], !entry.notImplementedNote);
    // La referencia al pack: bloque y fila, en notación fichero:línea — datos
    // e identificadores técnicos, nunca una frase compuesta aquí.
    setText(cuerpo.children[5], bloque.blockLabel + ' · ' + tallerVista.sourceDocument + ':' + String(entry.packLine));

    var boton = card.children[6];
    // (U11-1) Nombre accesible PROPIO por botón, servido resuelto: 32
    // botones «Borrar este borrador» idénticos eran indistinguibles en la
    // lista de controles de un lector de pantalla.
    setText(boton, entry.clearButtonLabel);
    boton.onclick = function () { borrarBorradorDeUnaTarjeta(entry, card); };
    return card;
  }

  /**
   * §3.4 (D20-21) — un grupo por bloque, en el orden en que los bloques
   * aparecen en el array 'entries' (que el servidor emite ya en orden de
   * facilitación, D20-56): el cliente no lee ningún número de orden.
   */
  function buildGrupoTaller(grupo, existing) {
    var section = existing || (function () {
      var node = el('section', 'tx-taller-bloque');
      var cabecera = el('div', 'tx-taller-bloque__cabecera');
      cabecera.appendChild(el('h3', '', ''));
      var det = document.createElement('details');
      det.className = 'tx-details';
      det.appendChild(el('summary', '', ''));
      var cuerpo = el('div', 'tx-details__body');
      cuerpo.appendChild(el('p', '', ''));
      cuerpo.appendChild(el('p', '', ''));
      det.appendChild(cuerpo);
      cabecera.appendChild(det);
      node.appendChild(cabecera);
      node.appendChild(el('div', 'tx-taller-bloque__tarjetas', ''));
      return node;
    })();
    var copy = tallerVista.copy;
    var bloque = grupo.bloque;
    var cabecera = section.children[0];
    setText(cabecera.children[0], bloque.facilitationOrdinalLabel + ' · ' + bloque.blockLabel + ' · ' + String(bloque.estimatedMinutes) + copy.blockMinutesSuffix);
    var det = cabecera.children[1];
    // (U11-3) También los diez <summary> de bloque llevan nombre propio,
    // servido resuelto en la vista del bloque.
    setText(det.children[0], bloque.blockDetailsSummaryLabel);
    setText(det.children[1].children[0], bloque.facilitationReason);
    setText(det.children[1].children[1], bloque.context || '');
    setHidden(det.children[1].children[1], !bloque.context);
    reconcileList(section.children[1], grupo.entradas, function (e) { return e.entryId; }, function (entry, existente) {
      return buildTarjetaTaller(entry, bloque, existente);
    });
    return section;
  }

  /**
   * §3.13 — anotaciones cuyo entryId ya no existe en el catálogo pintado:
   * NO se descartan en silencio. Se enseñan al final, bajo su rótulo, y no
   * cuentan en la cobertura. Lo único que se pinta es el identificador, la
   * letra marcada y la nota, siempre con textContent.
   */
  function buildGrupoHuerfanasTaller(claves, existing) {
    var section = existing || (function () {
      var node = el('section', 'tx-taller-bloque');
      node.appendChild(el('h3', '', ''));
      // (U11-16) La nota va ANTES de la lista: este grupo ignora filtros y
      // búsqueda a propósito, y eso se dice donde se ve.
      node.appendChild(el('p', 'tx-context__note', ''));
      node.appendChild(el('ul', '', ''));
      return node;
    })();
    setText(section.children[0], tallerVista.copy.orphanHeading);
    setText(section.children[1], tallerVista.copy.orphanUnfilteredNote);
    reconcileList(section.children[2], claves, function (k) { return k; }, function (clave, li) {
      var node = li || el('li', '', '');
      var b = tallerBorrador[clave];
      var texto = clave;
      if (b && b.opcion !== null) texto += ' · (' + b.opcion + ')';
      if (b && b.nota !== '') texto += ' · ' + b.nota;
      setText(node, texto);
      return node;
    });
    return section;
  }

  /** La reconstrucción entera del panel desde la vista pintada (capa 2 de D20-20: reconcileList + reaplicación del borrador). */
  function pintarTallerDesdeVista() {
    var lista = byId('tx-taller-lista');
    var taller = tallerVista;
    tallerTextoNormalizado = {};
    var porBloque = {};
    var grupos = [];
    taller.entries.forEach(function (e) {
      // §3.5 — la búsqueda mira identificadores, pregunta y comportamiento
      // hoy, y NADA más: las opciones no se buscan, a propósito.
      // (U11-4) Se busca sobre la variante de pantalla del aparte: es lo que
      // el operador ve, sin los asteriscos del verbatim.
      tallerTextoNormalizado[e.entryId] = normalizarBusqueda(
        e.entryId + ' ' + e.identifiers.join(' ') + ' ' + e.identifiersLabel + ' ' +
        e.question + ' ' + (e.questionAsideDisplay || '') + ' ' + e.currentBehaviour);
      var g = porBloque[e.blockId];
      if (!g) {
        var bloque = null;
        for (var i = 0; i < taller.blocks.length; i += 1) {
          if (taller.blocks[i].id === e.blockId) bloque = taller.blocks[i];
        }
        g = { clave: e.blockId, bloque: bloque, entradas: [] };
        porBloque[e.blockId] = g;
        grupos.push(g);
      }
      g.entradas.push(e);
    });
    var conocidas = {};
    taller.entries.forEach(function (e) { conocidas[e.entryId] = true; });
    var huerfanas = [];
    Object.keys(tallerBorrador).forEach(function (k) {
      if (!conocidas[k] && borradorConAlgo(tallerBorrador[k])) huerfanas.push(k);
    });
    huerfanas.sort();
    if (huerfanas.length > 0) grupos.push({ clave: 'huerfanas', huerfanas: huerfanas });
    reconcileList(lista, grupos, function (g) { return g.clave; }, function (g, existente) {
      return g.huerfanas ? buildGrupoHuerfanasTaller(g.huerfanas, existente) : buildGrupoTaller(g, existente);
    });
    aplicarFiltroDelTaller(false);
    actualizarCoberturaDelTaller();
  }

  /**
   * D20-20 — el panel NO se repinta con el sondeo. Capa 1: si la huella
   * entrante es la ya pintada, vuelve sin tocar el DOM (el catálogo es
   * estático dentro de un proceso, así que en la práctica se construye UNA
   * vez por carga de página). Capa 2: si la huella cambia (proceso
   * reiniciado con otro build), reconcileList reutiliza nodos por entryId y
   * el borrador en memoria se reaplica marca a marca. Sin catálogo en la
   * instantánea, estado vacío honesto (§3.13) y el borrador NO se toca.
   */
  function renderTallerDecisiones(snap) {
    var lista = byId('tx-taller-lista');
    if (!lista) return;
    var vacio = byId('tx-taller-vacio');
    var taller = snap && snap.demo ? snap.demo.decisionWorkshop : null;
    if (!taller) {
      if (vacio) setHidden(vacio, false);
      setHidden(lista, true);
      return;
    }
    if (vacio) setHidden(vacio, true);
    setHidden(lista, false);
    if (tallerHuellaPintada === taller.fingerprint) return;
    tallerVista = taller;
    tallerHuellaPintada = taller.fingerprint;
    pintarTallerDesdeVista();
  }

  /** D20-30 — el diálogo dice cuánto se va a perder, con las plantillas de N partes del servidor. */
  function abrirDialogoTallerBorrar() {
    var resumen = byId('tx-taller-borrar-resumen');
    if (resumen && tallerVista) {
      var copy = tallerVista.copy.dialog;
      var n = 0;
      var m = 0;
      Object.keys(tallerBorrador).forEach(function (k) {
        if (tallerBorrador[k].opcion !== null) n += 1;
        if (tallerBorrador[k].nota !== '') m += 1;
      });
      // (Revisión U11-11) Con los dos ceros, la variante servida entera:
      // «Vas a borrar 0 respuestas… No se puede deshacer.» amenazaba sobre nada.
      if (n === 0 && m === 0) {
        setText(resumen, copy.bodyNothing);
      } else {
        setText(resumen, copy.bodyPrefix + String(n) + (n === 1 ? copy.bodyAnswersSingular : copy.bodyAnswersPlural) +
          copy.bodyJoiner + String(m) + (m === 1 ? copy.bodyDraftNotesSingular : copy.bodyDraftNotesPlural) + copy.bodySuffix);
      }
    }
    abrirDialogo('dialogo-taller-borrar', 'dialogo-taller-borrar-titulo', byId('tx-taller-borrar-todo'));
  }

  /** I20-7 — vaciar el borrador entero no toca la demostración: ninguna petición sale de aquí. */
  function confirmarBorradoTotalDelTaller() {
    tallerBorrador = {};
    if (tallerVista) pintarTallerDesdeVista();
    byId('dialogo-taller-borrar').close();
    if (tallerVista) setEstadoLinea(byId('tx-taller-estado'), tallerVista.copy.dialog.clearedStatus, '');
  }

  // ---------------------------------------------------------------------
  // step 20 fase 7 — D y E: «Copiar acta provisional» y «Preparar borrador
  // de siguiente misión» (diseño §4, §5, E20-1). Los dos generadores son
  // funciones PURAS de (vista, borrador): toda frase fija viene servida en
  // ACTA_COPY/MISION_COPY dentro de la vista, y aquí sólo se UNE — nunca se
  // parte, se pliega, se sangra, se recorta, se conjuga ni se traduce nada
  // (D20-46, D20-48). Cada dato ocupa UNA línea lógica, tan larga como haga
  // falta.
  // ---------------------------------------------------------------------

  /**
   * §4.3 (D20-38) — el saneado de una nota del operador, en el orden EXACTO
   * del diseño. Devuelve las líneas ya prefijadas con «> » en la columna
   * cero (D20-48): el prefijo queda RESERVADO a texto del operador (I20-9),
   * así que toda línea que empiece por «> » es testimonio y toda la que no,
   * estructura del documento.
   */
  function sanearNotaDelTaller(nota) {
    var s = String(nota);
    // 1. Normalizar saltos: \\r\\n, \\r, NEL (U+0085), separador de línea
    //    (U+2028) y de párrafo (U+2029) → \\n. Los dos últimos son
    //    terminadores de línea reales para JavaScript y para muchos
    //    editores: sin este paso, una nota con un U+2028 sacaría una segunda
    //    línea visible SIN el prefijo «> » — el agujero exacto que I20-9
    //    promete cerrar (R4-6).
    s = s.replace(/\\r\\n/g, '\\n').replace(/[\\r\\u0085\\u2028\\u2029]/g, '\\n');
    // 2. Tabuladores → un espacio; y fuera los controles C0 (salvo \\n),
    //    U+007F, el bloque C1 entero (U+0080–U+009F), los ocho controles
    //    bidireccionales (U+202A–U+202E, U+2066–U+2069 — un U+202E invierte
    //    visualmente lo que se lee y podría hacer pasar una nota por línea
    //    de estructura) y los dos invisibles de anchura cero U+200B y U+FEFF
    //    (permiten partir una palabra prohibida para esquivar un barrido;
    //    se eliminan EN SILENCIO, decisión escrita en D20-38).
    s = s.replace(/\\t/g, ' ');
    s = s.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u0080-\\u009F\\u202A-\\u202E\\u2066-\\u2069\\u200B\\uFEFF]/g, '');
    // 3–6. Partir por \\n; recortar espacios FINALES (los iniciales son del
    //    operador y se conservan); neutralizar la PRIMERA marca estructural
    //    de la línea con una barra invertida (escape estándar de Markdown);
    //    y prefijar TODAS las líneas con «> » a ras de margen. Una línea
    //    vacía se convierte en «>» a secas, para que el bloque citado no se
    //    parta en dos.
    return s.split('\\n').map(function (linea) {
      linea = linea.replace(/ +$/, '');
      linea = linea.replace(/^( *)([#>\`~|\\-*+=_])/, '$1\\\\$2');
      linea = linea.replace(/^( *)(\\d+[.)])/, '$1\\\\$2');
      if (linea === '') return '>';
      return '> ' + linea;
    });
  }

  /**
   * D20-49, punto 3 — la aserción de exportación. El tope real vive en el
   * manejador oninput (punto 2: recorte VISIBLE, con aviso); si a pesar de
   * eso una nota llegara aquí con más de 280 caracteres (una escritura
   * programática directa al borrador), la exportación FALLA en vez de
   * recortar: recortar a esta altura sería mutilar el acta sin que nadie lo
   * vea (§9.5).
   */
  function afirmarNotaExportableDelTaller(entryId, nota) {
    if (String(nota).length > 280) {
      throw new Error('La nota de ' + entryId + ' supera los 280 caracteres: la exportación no recorta en silencio (D20-49).');
    }
  }

  /** «[J5/K1]  (identificadores: J5, K1)» — D20-10: quien lea el texto sin el catálogo delante no debe creer que falta una pregunta. */
  function lineaDeIdentificadoresDelTaller(acta, entry) {
    return '[' + entry.entryId + ']  ' + acta.identifiersPrefix + entry.identifiers.join(', ') + acta.identifiersSuffix;
  }

  /** La pregunta reconstituida (§2.11: la separación del aparte es presentación, no un dato distinto). */
  function lineaDePreguntaDelTaller(acta, entry) {
    return acta.questionPrefix + entry.question + (entry.questionAside ? ' ' + entry.questionAside : '');
  }

  /** La opción marcada de una entrada, o null si la letra ya no existe en el catálogo pintado. */
  function opcionElegidaDelTaller(entry, b) {
    var elegida = null;
    entry.options.forEach(function (o) { if (o.letter === b.opcion) elegida = o; });
    return elegida;
  }

  /** Las entradas del catálogo CON opción marcada a mano, en orden de catálogo (D20-37.1). */
  function entradasElegidasDelTaller(vista, borrador) {
    return vista.entries.filter(function (e) {
      var b = borrador[e.entryId];
      return !!b && b.opcion !== null;
    });
  }

  /**
   * §4.2 — el acta provisional, determinista y estable: mismos datos ⇒ mismo
   * texto, byte a byte. Sin fecha y sin identidad (D20-36): una fecha se
   * leería como fecha de la decisión, y esta consola no tiene usuarios.
   * Copiar no muta nada (I20-10): esta función sólo LEE el borrador.
   */
  function componerActaDelTaller(vista, borrador) {
    var acta = vista.acta;
    var lineas = [];
    var bloquesPorId = {};
    vista.blocks.forEach(function (b) { bloquesPorId[b.id] = b; });

    lineas.push(acta.title, acta.subtitle, '', acta.permanentLine, '', acta.notADecisionNote, '');
    lineas.push(acta.catalogPrefix + vista.catalogVersion);
    lineas.push(acta.sourcePrefix + vista.sourceDocument);
    lineas.push(acta.noStampNote);

    // 1. LO QUE SE ANOTÓ — sólo entradas con opción marcada, ni una más
    // (D20-37.1); la opción VERBATIM con su letra; la urgencia copiada
    // literal, nunca recalculada; la nota citada bajo su rótulo de texto sin
    // verificar.
    lineas.push(acta.separator, acta.sectionAnnotated, '');
    var anotadas = entradasElegidasDelTaller(vista, borrador);
    if (anotadas.length === 0) {
      lineas.push(acta.noneAnnotated);
    } else {
      anotadas.forEach(function (e, i) {
        if (i > 0) lineas.push('');
        var b = borrador[e.entryId];
        var opcion = opcionElegidaDelTaller(e, b);
        lineas.push(lineaDeIdentificadoresDelTaller(acta, e));
        lineas.push(bloquesPorId[e.blockId].blockLabel);
        lineas.push(lineaDePreguntaDelTaller(acta, e));
        lineas.push(acta.optionPrefix + '(' + b.opcion + ')' + (opcion ? ' ' + opcion.text : ''));
        var deps = e.dependsOn.concat(e.externalDependencies);
        if (deps.length > 0) lineas.push(acta.dependsPrefix + deps.join(', '));
        lineas.push(acta.urgencyPrefix + e.urgency.label);
        if (b.nota !== '') {
          afirmarNotaExportableDelTaller(e.entryId, b.nota);
          lineas.push(acta.noteHeading);
          sanearNotaDelTaller(b.nota).forEach(function (l) { lineas.push(l); });
        }
      });
    }

    // (Revisión adversarial A9-1) NOTAS SIN RESPUESTA ANOTADA — una nota
    // escrita SIN opción marcada es testimonio del operador y el panel la
    // cuenta en «Con borrador anotado»: perderla del acta en silencio hacía
    // que el acta contradijera al panel. Sale en su propia sección servida,
    // NO cuenta como respuesta en ningún denominador y su entrada sigue
    // saliendo entre las pendientes de las secciones 2 y 3.
    var conNotaSinOpcion = vista.entries.filter(function (e) {
      var nb = borrador[e.entryId];
      return !!nb && nb.opcion === null && nb.nota !== '';
    });
    if (conNotaSinOpcion.length > 0) {
      lineas.push(acta.separator, acta.notesWithoutAnswerHeading, '');
      conNotaSinOpcion.forEach(function (e, i) {
        if (i > 0) lineas.push('');
        afirmarNotaExportableDelTaller(e.entryId, borrador[e.entryId].nota);
        lineas.push(lineaDeIdentificadoresDelTaller(acta, e));
        sanearNotaDelTaller(borrador[e.entryId].nota).forEach(function (l) { lineas.push(l); });
      });
    }

    // §3.13 — anotaciones cuyo entryId ya no existe en el catálogo pintado:
    // NO se descartan en silencio; salen en su propia sección, bajo el mismo
    // rótulo servido que las enseña en pantalla, que ya dice que la fila
    // desapareció del catálogo actual.
    var conocidas = {};
    vista.entries.forEach(function (e) { conocidas[e.entryId] = true; });
    var huerfanas = [];
    Object.keys(borrador).forEach(function (k) {
      if (!conocidas[k] && borradorConAlgo(borrador[k])) huerfanas.push(k);
    });
    huerfanas.sort();
    if (huerfanas.length > 0) {
      lineas.push(acta.separator, vista.copy.orphanHeading, '');
      huerfanas.forEach(function (k, i) {
        if (i > 0) lineas.push('');
        var hb = borrador[k];
        lineas.push('[' + k + ']');
        if (hb.opcion !== null) lineas.push(acta.optionPrefix + '(' + hb.opcion + ')');
        if (hb.nota !== '') {
          afirmarNotaExportableDelTaller(k, hb.nota);
          lineas.push(acta.noteHeading);
          sanearNotaDelTaller(hb.nota).forEach(function (l) { lineas.push(l); });
        }
      });
    }

    // 2. SIGUEN SIN RESPUESTA Y BLOQUEAN UN PILOTO — con su pregunta; el
    // comportamiento de hoy no se cita ni aquí ni en ningún sitio del acta
    // (D20-37.3).
    lineas.push(acta.separator, acta.sectionBlockingPending, '');
    var bloqueantesPendientes = vista.entries.filter(function (e) {
      var b = borrador[e.entryId];
      return e.urgency.kind === 'bloquea' && !(b && b.opcion !== null);
    });
    if (bloqueantesPendientes.length === 0) {
      lineas.push(acta.blockingNonePending);
    } else {
      bloqueantesPendientes.forEach(function (e) {
        lineas.push(lineaDeIdentificadoresDelTaller(acta, e));
        lineas.push(lineaDePreguntaDelTaller(acta, e));
      });
    }

    // 3. TODO LO QUE SIGUE SIN RESPUESTA — el denominador son
    // IDENTIFICADORES (D20-10) y L1 nunca se suma con las J/K: su coletilla
    // es una constante condicional servida, que se añade entera o se omite.
    lineas.push(acta.separator, acta.sectionAllPending, '');
    var pendientesJK = 0;
    var l1Pendiente = false;
    var idsPendientes = [];
    vista.entries.forEach(function (e) {
      var b = borrador[e.entryId];
      if (b && b.opcion !== null) return;
      e.identifiers.forEach(function (id) {
        idsPendientes.push(id);
        if (id.charAt(0) === 'L') l1Pendiente = true;
        else pendientesJK += 1;
      });
    });
    lineas.push(acta.pendingPrefix + String(pendientesJK) + acta.pendingSuffix + (l1Pendiente ? acta.pendingLTail : acta.pendingTail));
    if (idsPendientes.length > 0) lineas.push(idsPendientes.join(', '));

    // 4. QUÉ HACER CON ESTE TEXTO — nada implementado, nada aprobado,
    // repasar con Bruno, plantilla del §8 del pack, identificadores en el
    // encargo futuro.
    lineas.push(acta.separator, acta.sectionClosing, '');
    acta.closingLines.forEach(function (l) { lineas.push(l); });
    return lineas.join('\\n');
  }

  /**
   * §5 — el borrador de misión NO ejecutable. Se genera EXCLUSIVAMENTE a
   * partir de las opciones marcadas a mano (D20-41): nunca del
   * comportamiento de hoy, ni de la urgencia, ni del orden, ni de las notas
   * (que van citadas en su sección, sin producir una línea de alcance), ni
   * de lo sin responder, ni de las dependencias externas. Jamás contiene un
   * identificador fuera del catálogo (I20-11) — por eso las anotaciones
   * huérfanas del acta NO entran aquí.
   */
  function componerBorradorDeMisionDelTaller(vista, borrador) {
    var mision = vista.mision;
    // El separador y las piezas compartidas (identificadores, opción, la
    // frase de «ninguna bloqueante sin anotar») son constantes SERVIDAS de
    // ACTA_COPY: reutilizarlas es unir constantes (E20-1), no escribirlas.
    var acta = vista.acta;
    var lineas = [];
    var indicePorId = {};
    vista.entries.forEach(function (e, i) { indicePorId[e.entryId] = i; });

    lineas.push(mision.title);
    lineas.push(acta.separator, mision.sectionZero, '', mision.zeroNote, '');
    lineas.push(mision.catalogPrefix + vista.catalogVersion);
    lineas.push(mision.sourcePrefix + vista.sourceDocument);

    // 1. LO QUE SE ELIGIÓ EXPLÍCITAMENTE — identificadores y opción exactos,
    // nada inferido.
    lineas.push(acta.separator, mision.sectionChosen, '');
    var elegidas = entradasElegidasDelTaller(vista, borrador);
    var elegidaPorId = {};
    elegidas.forEach(function (e) { elegidaPorId[e.entryId] = true; });
    if (elegidas.length === 0) {
      lineas.push(mision.noneChosen);
    } else {
      elegidas.forEach(function (e, i) {
        if (i > 0) lineas.push('');
        var b = borrador[e.entryId];
        var opcion = opcionElegidaDelTaller(e, b);
        lineas.push(lineaDeIdentificadoresDelTaller(acta, e));
        lineas.push(acta.optionPrefix + '(' + b.opcion + ')' + (opcion ? ' ' + opcion.text : ''));
      });
    }

    // 2. LO QUE BLOQUEA UN PILOTO Y SIGUE SIN ELEGIRSE — exacto, con su
    // pregunta.
    lineas.push(acta.separator, mision.sectionBlockingUnchosen, '');
    var bloqueantesSinElegir = vista.entries.filter(function (e) {
      return e.urgency.kind === 'bloquea' && !elegidaPorId[e.entryId];
    });
    if (bloqueantesSinElegir.length === 0) {
      lineas.push(acta.blockingNonePending);
    } else {
      bloqueantesSinElegir.forEach(function (e) {
        lineas.push(e.entryId + mision.groupJoiner + e.question + (e.questionAside ? ' ' + e.questionAside : ''));
      });
    }

    // 3. TRABAJO POSIBLE, AGRUPADO POR DEPENDENCIA — componentes CONEXAS del
    // grafo dependsOn tratado como NO dirigido, restringido a lo elegido
    // (D20-42); el algoritmo del conjunto de visitados termina con ciclos
    // (D20-14). Los grupos van por el índice MÍNIMO de sus miembros en el
    // array \`entries\`, que el servidor emite ya ordenado (D20-56).
    lineas.push(acta.separator, mision.sectionGrouped, '');
    var algunaBloqueanteElegida = elegidas.some(function (e) { return e.urgency.kind === 'bloquea'; });
    if (!algunaBloqueanteElegida) {
      // D20-44 — con su propia línea, inmediatamente bajo el encabezado.
      // (Revisión adversarial A9-2) También con CERO elecciones: el diseño
      // exige la frase siempre que ninguna bloqueante tenga opción elegida,
      // y cero elegidas es el caso más claro de todos. De paso (A9-6), la
      // sección 3 nunca queda como encabezado desnudo. La línea en blanco
      // sólo se añade si después vienen grupos.
      lineas.push(mision.noBlockingChosenNote);
      if (elegidas.length > 0) lineas.push('');
    }
    var vecinos = {};
    elegidas.forEach(function (e) { vecinos[e.entryId] = []; });
    elegidas.forEach(function (e) {
      e.dependsOn.forEach(function (dep) {
        if (elegidaPorId[dep]) {
          vecinos[e.entryId].push(dep);
          vecinos[dep].push(e.entryId);
        }
      });
    });
    var visitadas = {};
    var grupos = [];
    elegidas.forEach(function (e) {
      if (visitadas[e.entryId]) return;
      visitadas[e.entryId] = true;
      var cola = [e.entryId];
      var miembros = [];
      while (cola.length > 0) {
        var id = cola.pop();
        miembros.push(id);
        vecinos[id].forEach(function (v) {
          if (!visitadas[v]) {
            visitadas[v] = true;
            cola.push(v);
          }
        });
      }
      miembros.sort(function (a, b) { return indicePorId[a] - indicePorId[b]; });
      grupos.push(miembros);
    });
    grupos.forEach(function (miembros, gi) {
      if (gi > 0) lineas.push('');
      // D20-43 — un grupo queda [BLOQUEADO] si ALGUNA de sus entradas
      // depende de un entryId sin opción elegida. Las dependencias externas
      // no bloquean nunca (D20-15): se citan aparte, como contexto.
      var faltantes = [];
      miembros.forEach(function (id) {
        vista.entries[indicePorId[id]].dependsOn.forEach(function (dep) {
          if (!elegidaPorId[dep]) faltantes.push({ de: id, dep: dep });
        });
      });
      var cabecera = mision.groupPrefix + String(gi + 1) + mision.groupJoiner + miembros.join(', ');
      if (faltantes.length > 0) cabecera += '  ' + mision.blockedTag;
      lineas.push(cabecera);
      if (faltantes.length > 0) {
        // Se nombra cada dependencia que falta con la plantilla de TRES
        // partes servida, y NO se propone ningún trabajo: ni alcance, ni
        // orden, ni un «podría hacerse igualmente».
        faltantes.forEach(function (f) {
          lineas.push(mision.blockedIntro + mision.depPart1 + f.de + mision.depPart2 + f.dep + mision.depPart3);
          lineas.push(mision.contraPart1 + f.de + mision.contraPart2 + f.dep + mision.contraPart3);
        });
      } else {
        if (miembros.length > 1) lineas.push(mision.togetherNote);
        miembros.forEach(function (id) {
          var e = vista.entries[indicePorId[id]];
          var b = borrador[id];
          var opcion = opcionElegidaDelTaller(e, b);
          lineas.push(id + ': (' + b.opcion + ')' + (opcion ? ' ' + opcion.text : ''));
          if (e.externalDependencies.length > 0) lineas.push(acta.dependsPrefix + e.externalDependencies.join(', '));
        });
      }
    });

    // 4. CONTEXTO DEL OPERADOR — las notas, TODAS citadas con «> » bajo el
    // rótulo que las declara texto sin verificar; nunca producen alcance
    // (D20-41.4). Sólo entradas del catálogo: I20-11.
    lineas.push(acta.separator, mision.sectionContext, '');
    var conNota = vista.entries.filter(function (e) {
      var b = borrador[e.entryId];
      return !!b && b.nota !== '';
    });
    if (conNota.length > 0) {
      lineas.push(mision.contextIntro, '');
      conNota.forEach(function (e, i) {
        if (i > 0) lineas.push('');
        afirmarNotaExportableDelTaller(e.entryId, borrador[e.entryId].nota);
        lineas.push('[' + e.entryId + ']');
        sanearNotaDelTaller(borrador[e.entryId].nota).forEach(function (l) { lineas.push(l); });
      });
    } else {
      // (Revisión adversarial A9-6) Sin notas, la sección lo dice con su
      // frase servida: ningún encabezado del borrador queda desnudo.
      lineas.push(mision.noContextNote);
    }

    // 5. LO QUE ESTE BORRADOR NO HACE.
    lineas.push(acta.separator, mision.sectionLimits, '');
    mision.limitLines.forEach(function (l) { lineas.push(l); });
    return lineas.join('\\n');
  }

  /** Vacía y vuelve a ocultar UN respaldo de copia del taller (mismo criterio que el del resumen: no es una línea de estado, es un campo con contenido propio). */
  function limpiarRespaldoDeCopiaDelTaller(respaldoId) {
    var respaldo = byId(respaldoId);
    if (!respaldo) return;
    respaldo.value = '';
    setHidden(respaldo, true);
  }

  /**
   * D20-28 / §6.4 — lo ÚNICO del taller que la secuencia de reinicio toca
   * aparte de las dos líneas de estado (que van en REGIONES_TRANSITORIAS):
   * los dos respaldos se vacían y se ocultan explícitamente. Vaciar el
   * respaldo NO es borrar el borrador: el borrador sigue intacto (D20-27) y
   * una sola pulsación vuelve a generar el acta.
   */
  function limpiarRespaldosDelTaller() {
    limpiarRespaldoDeCopiaDelTaller('tx-taller-acta-respaldo');
    limpiarRespaldoDeCopiaDelTaller('tx-taller-mision-respaldo');
  }

  function mostrarRespaldoDeCopiaDelTaller(respaldoId, texto, estadoEl) {
    var respaldo = byId(respaldoId);
    if (!respaldo) return;
    respaldo.value = texto;
    setHidden(respaldo, false);
    if (respaldo.focus) respaldo.focus();
    if (respaldo.select) respaldo.select();
    // La MISMA frase que el respaldo del resumen, a propósito: es el mismo
    // hecho. Su sede canónica es SUMMARY_COPY.fallbackStatus (R4-19) y una
    // prueba compara este literal carácter a carácter con esa constante.
    setEstadoLinea(estadoEl, 'Tu navegador no ha dejado copiar. El texto está aquí abajo, entero y ya seleccionado: cópialo con Cmd+C.', '');
  }

  /**
   * D20-39 — el patrón canónico de copia de la casa, calcado de
   * wireResumenOwnerControls: el texto se compone entero ANTES, y
   * navigator.clipboard.writeText se llama de forma SÍNCRONA dentro del
   * manejador de click, sin ningún await ni .then() delante — es lo que hace
   * que Safari acepte la escritura como gesto del usuario. I20-10: copiar no
   * borra el borrador, no lo marca, no lo persiste, no lo envía y no mueve
   * el foco salvo al respaldo cuando el portapapeles falla.
   */
  function copiarTextoDelTaller(texto, estadoEl, respaldoId, estadoCopiado) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(function () {
        setEstadoLinea(estadoEl, estadoCopiado, 'ok');
        limpiarRespaldoDeCopiaDelTaller(respaldoId);
      }).catch(function () {
        mostrarRespaldoDeCopiaDelTaller(respaldoId, texto, estadoEl);
      });
    } else {
      mostrarRespaldoDeCopiaDelTaller(respaldoId, texto, estadoEl);
    }
  }

  /**
   * Los controles ESTÁTICOS del panel, enganchados una sola vez en
   * DOMContentLoaded (D20-51): los cinco filtros, la búsqueda, el botón de
   * borrado total y su diálogo. Nada de esto vive dentro de buildTarjetaTaller.
   */
  function wireTallerControls() {
    if (!byId('tx-taller-filtro-todas')) return;
    FILTROS_TALLER.forEach(function (clave) {
      byId('tx-taller-filtro-' + clave).addEventListener('click', function () {
        tallerFiltro = clave;
        FILTROS_TALLER.forEach(function (c) {
          byId('tx-taller-filtro-' + c).setAttribute('aria-pressed', String(c === clave));
        });
        aplicarFiltroDelTaller(true);
      });
    });
    var buscar = byId('tx-taller-buscar');
    buscar.oninput = function () {
      tallerBusqueda = String(buscar.value);
      // Filtrar es inmediato; la locución espera el rebote — salvo que el
      // filtrado ya haya anunciado porque tuvo que rescatar el foco.
      var anunciado = aplicarFiltroDelTaller(false);
      if (!anunciado) programarAnuncioDeBusquedaDelTaller();
    };
    byId('tx-taller-borrar-todo').addEventListener('click', abrirDialogoTallerBorrar);
    byId('tx-taller-borrar-cancelar').addEventListener('click', function () { byId('dialogo-taller-borrar').close(); });
    byId('tx-taller-borrar-confirmar').addEventListener('click', confirmarBorradoTotalDelTaller);
    wireFocoDialogo('dialogo-taller-borrar');
    // D20-35/D20-40 — los dos botones de copia, siempre disponibles (un acta
    // que dice «hoy no se anotó nada» es un registro cierto). El texto se
    // compone ENTERO antes de la llamada al portapapeles, que va síncrona
    // dentro del gesto (D20-39). Sin catálogo pintado no hay estructura
    // servida con la que unir (§3.13): el propio panel ya enseña su estado
    // vacío honesto, y aquí no se escribe ninguna frase de cliente.
    // (Revisión adversarial A9-5) La aserción de exportación (D20-49.3)
    // LANZA antes que recortar en silencio — semántica que se conserva —,
    // pero un throw sin red dentro del manejador de click dejaba al operador
    // mirando un botón que no hace nada. El catch escribe la frase servida
    // en la línea de estado con el tono de error de la casa y NO toca ni el
    // portapapeles ni el respaldo ni el borrador. En uso normal es
    // inalcanzable: el manejador oninput ya recorta a 280 (D20-49.2).
    byId('tx-taller-copiar-acta').addEventListener('click', function () {
      if (!tallerVista) return;
      var textoActa;
      try {
        textoActa = componerActaDelTaller(tallerVista, tallerBorrador);
      } catch (fallo) {
        setEstadoLinea(byId('tx-taller-acta-estado'), tallerVista.copy.composeFailedStatus, 'error');
        return;
      }
      copiarTextoDelTaller(textoActa, byId('tx-taller-acta-estado'), 'tx-taller-acta-respaldo', tallerVista.acta.copiedStatus);
    });
    byId('tx-taller-copiar-mision').addEventListener('click', function () {
      if (!tallerVista) return;
      var textoMision;
      try {
        textoMision = componerBorradorDeMisionDelTaller(tallerVista, tallerBorrador);
      } catch (fallo) {
        setEstadoLinea(byId('tx-taller-mision-estado'), tallerVista.copy.composeFailedStatus, 'error');
        return;
      }
      copiarTextoDelTaller(textoMision, byId('tx-taller-mision-estado'), 'tx-taller-mision-respaldo', tallerVista.mision.copiedStatus);
    });
  }

  // =====================================================================
  // step 20 — TALLER DE DECISIONES CON BRUNO — FIN DEL BLOQUE
  // =====================================================================

  function buildAttentionCard(call, entry, existing) {
    var article = existing || el('article', '');
    article.className = 'tx-attention-card tx-attention-card--' + entry.modifier;
    clearChildren(article);
    var status = statusFor(call);
    if (status) article.appendChild(buildPillEl(status));
    var h3 = el('h3', 'tx-attention-card__title', entry.title);
    article.appendChild(h3);
    var meta = el('p', 'tx-attention-card__meta', 'Hoy a las ' + formatTimeFromISO(call.startedAtISO));
    article.appendChild(meta);
    var a = el('a', 'tx-btn tx-btn--secondary', 'Ver la llamada');
    a.href = '#/llamadas/' + call.callIdHash;
    article.appendChild(a);
    return article;
  }

  /**
   * (step 23 §8.1) Las tarjetas de propuesta pendiente, dentro de
   * \`#panel-atencion\`. Devuelve CUÁNTAS hay, porque el contador de la
   * cabecera es la suma de esta cuenta y la de llamadas, y las dos tienen que
   * salir del mismo sitio del que sale lo que se pinta.
   *
   * Todo el texto llega compuesto del servidor: el titular, el detalle y la
   * etiqueta de la píldora. Aquí no se decide nada de negocio.
   */
  function renderPropuestasAtencion(snap) {
    var lista = byId('atencion-propuestas');
    var titulo = byId('tit-atencion-propuestas');
    if (!lista) return 0;
    var w = snap.waitlist;
    var cards = w && w.attention ? w.attention.cards : [];
    // El bloque entero desaparece cuando no hay ninguna: un título con una
    // lista vacía debajo es ruido, no información.
    setHidden(lista, cards.length === 0);
    if (titulo) setHidden(titulo, cards.length === 0);
    reconcileList(lista, cards, function (c) { return c.slotKey; }, function (card, existingLi) {
      var li = existingLi || (function () {
        var node = el('li', '');
        node.appendChild(el('div', ''));
        var body = el('div', 'tx-activity-list__body');
        body.appendChild(el('p', '', ''));
        body.appendChild(el('p', 'tx-context__note', ''));
        node.appendChild(body);
        // Enlace con TEXTO REAL y destino real, nunca un cheurón mudo. No se
        // reconstruye: se le pone la dirección al día, para que el foco de
        // quien navega con el teclado sobreviva al sondeo de 2 s.
        node.appendChild(el('a', 'tx-btn tx-btn--secondary', 'Revisar en Lista de espera'));
        return node;
      })();
      var pildora = li.children[0];
      clearChildren(pildora);
      pildora.appendChild(buildPildoraDeTexto(card.statusLabel, card.statusTone));
      setText(li.children[1].children[0], card.headline);
      setText(li.children[1].children[1], card.detail);
      li.children[2].href = card.href;
      return li;
    });
    return cards.length;
  }

  /**
   * (step 23 §8.2/§10) El panel de actividad operativa: las seis filas más
   * recientes por \`seq\` DESCENDENTE, y el resto —bueno, todas— dentro de un
   * \`<details>\` que dice cuántas enseña de cuántas hay.
   *
   * EL ORDEN ES EL DEL SERVIDOR. Aquí no se reordena ni se filtra nada: el
   * \`seq\` es monótono y único, y ordenar por hora en el cliente haría que dos
   * actos del mismo minuto sintético bailaran entre dos sondeos.
   */
  var ACTIVIDAD_OPERATIVA_EN_PORTADA = 6;

  /**
   * (step 23 §10, patrón M4 de \`renderHistorialDeTareas\`) El último \`seq\`
   * que se ha locutado. \`null\` = todavía no se ha pintado nada en esta carga
   * de página.
   *
   * LA GUARDA, entera: en el PRIMER render se fija sin anunciar —un refresco
   * de la página no puede re-narrar el histórico— y después sólo se locuta si
   * hay algo ESTRICTAMENTE nuevo. Si el máximo BAJA (un reinicio, que vacía el
   * registro) se vuelve a fijar EN SILENCIO. Y cuando no cambia nada, no se
   * escribe: cada dos segundos, una región viva que se reescribe con el mismo
   * texto es una región que puede volver a locutarse sola.
   */
  var ultimoSeqAnunciado = null;

  function renderActividadOperativa(snap) {
    var lista = byId('lista-actividad-operativa');
    if (!lista) return;
    var w = snap.waitlist;
    var actividad = w && w.activity ? w.activity : { total: 0, shown: 0, items: [] };
    var items = actividad.items;
    var portada = items.slice(0, ACTIVIDAD_OPERATIVA_EN_PORTADA);

    setHidden(byId('vacio-actividad-operativa'), items.length > 0);
    reconcileList(lista, portada, function (i) { return i.id; }, buildFilaActividadOperativa);

    var detalles = byId('actividad-operativa-detalles');
    if (detalles) {
      // El \`<details>\` sólo aparece cuando de verdad hay más de lo que cabe en
      // portada: abrirlo para ver exactamente lo mismo sería una promesa vacía.
      setHidden(detalles, items.length <= portada.length);
      setText(byId('actividad-operativa-resumen'),
        'Ver toda la actividad de esta sesión (' + String(actividad.shown) + ' de ' + String(actividad.total) + ')');
      reconcileList(byId('lista-actividad-operativa-todo'), items, function (i) { return i.id; }, buildFilaActividadOperativa);
    }

    anunciarActividadOperativa(items);
  }

  function buildFilaActividadOperativa(item, existingLi) {
    var li = existingLi || (function () {
      var node = el('li', '');
      node.appendChild(el('div', ''));
      var body = el('div', 'tx-activity-list__body');
      body.appendChild(el('p', 'tx-activity-list__time', ''));
      body.appendChild(el('p', '', ''));
      // Divulgación progresiva: la razón va en una SEGUNDA línea, en texto.
      // Nunca detrás de un color, y nunca sólo en un tooltip.
      body.appendChild(el('p', 'tx-context__note', ''));
      node.appendChild(body);
      node.appendChild(el('a', 'tx-btn tx-btn--secondary', 'Revisar en Lista de espera'));
      return node;
    })();
    var pildoras = li.children[0];
    clearChildren(pildoras);
    // Quién actuó (Sistema u Operador) y en qué quedó: las dos con texto.
    pildoras.appendChild(buildPildoraDeTexto(item.originLabel, 'none'));
    pildoras.appendChild(buildPildoraDeTexto(item.statusLabel, item.statusTone));
    var body = li.children[1];
    setText(body.children[0], item.timeLabel);
    setText(body.children[1], item.title);
    setText(body.children[2], item.reason);
    li.children[2].href = item.href;
    return li;
  }

  function anunciarActividadOperativa(items) {
    var estado = byId('actividad-operativa-estado');
    if (!estado) return;
    var maxSeq = items.length > 0 ? items[0].seq : 0;
    if (ultimoSeqAnunciado === null || maxSeq < ultimoSeqAnunciado) {
      // Primer render de la carga, o un reinicio: se fija SIN locutar.
      ultimoSeqAnunciado = maxSeq;
      return;
    }
    if (maxSeq === ultimoSeqAnunciado) return; // nada nuevo: ni se escribe
    var nuevos = [];
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].seq > ultimoSeqAnunciado) nuevos.push(items[i].title);
    }
    ultimoSeqAnunciado = maxSeq;
    if (nuevos.length === 0) return;
    setEstadoLinea(estado, nuevos.length === 1
      ? 'Novedad en la actividad operativa: ' + nuevos[0] + '.'
      : String(nuevos.length) + ' novedades en la actividad operativa: ' + nuevos.join('; ') + '.', '');
  }

  function renderInicio(snap) {
    byId('inicio-fecha').textContent = formatDateLong(snap.engineToday);
    var down = byId('tx-freshness').classList.contains('tx-freshness--down');
    byId('inicio-estado-texto').textContent = down ? 'Asistente sintético · Sin respuesta' : 'Asistente sintético · Respondiendo';
    var estadoDot = byId('inicio-estado-dot');
    estadoDot.classList.toggle('tx-context__dot--down', down);
    // (revisión step 15, punto 2) Esta función sólo se ejecuta una vez ya ha
    // llegado una instantánea de verdad (renderActiveSection() sale antes si
    // no), así que el estado neutro de arranque en frío ya no aplica: quita
    // la clase "comprobando" para dejar sitio a una afirmación con datos
    // detrás (arriba, "Respondiendo" o "Sin respuesta").
    estadoDot.classList.remove('tx-context__dot--checking');

    // (step 18 §5.5, K14) UNA línea neutra, y sólo cuando hay algo que decir.
    // La frase llega COMPUESTA del servidor (\`metrics.homeLine\`), que manda
    // \`null\` cuando el número es cero — y entonces aquí no se enseña nada:
    // "Inasistencias anotadas hoy: 0" sería ruido con forma de alarma.
    // Ninguna tarjeta de cifra nueva, ningún color de alarma, ningún
    // porcentaje, ninguna tendencia.
    var lineaInasistencias = byId('inicio-inasistencias');
    var textoInasistencias = byId('inicio-inasistencias-texto');
    if (lineaInasistencias && textoInasistencias) {
      var frase = snap.operations && snap.operations.metrics ? snap.operations.metrics.homeLine : null;
      setText(textoInasistencias, frase || '');
      setHidden(lineaInasistencias, !frase);
    }

    var m = snap.metrics;
    byId('kpi-llamadas-valor').textContent = String(m.callsHandled);

    var resolved = statForValue(m.resolvedWithoutHumanInterruption, m.callsWithOutcome);
    var resueltasValor = byId('kpi-resueltas-valor');
    resueltasValor.textContent = resolved.text;
    resueltasValor.classList.toggle('tx-stat__value--empty', resolved.empty);

    byId('kpi-reservas-valor').textContent = String(m.bookingsCreated);

    var erroresValor = byId('kpi-errores-valor');
    erroresValor.textContent = String(m.technicalErrors);
    byId('kpi-errores').classList.toggle('tx-stat--alert', m.technicalErrors > 0);
    byId('kpi-errores-hint').textContent = m.technicalErrors > 0 ? 'Ver detalle' : '';

    // Necesita tu atención
    var attentionEntries = [];
    snap.calls.forEach(function (call) {
      var entry = callAttentionEntry(call, snap);
      if (entry) attentionEntries.push({ call: call, entry: entry });
    });
    attentionEntries.sort(function (a, b) {
      if (a.entry.tier !== b.entry.tier) return a.entry.tier - b.entry.tier;
      return b.call.startedAtISO.localeCompare(a.call.startedAtISO);
    });
    // (step 23 §8.1) El bloque de propuestas pendientes, DENTRO de este
    // mismo panel y antes de la lista de llamadas.
    var propuestas = renderPropuestasAtencion(snap);
    // El contador es la SUMA de dos sumandos DISJUNTOS por construcción, y
    // los dos los publica el servidor por separado: llamadas que piden una
    // mirada (\`metrics.needsAttention\`, aquí recalculado como la lista que se
    // pinta) y propuestas sin aprobar (\`waitlist.attention.pendingProposalCount\`).
    // Una llamada nunca es una propuesta, así que sumar no puede contar dos
    // veces lo mismo. \`pendingHumanTasks\` NO entra: es otra cuenta, de otro
    // sustantivo, y vive en el panel de al lado.
    var totalAtencion = attentionEntries.length + propuestas;
    byId('contador-atencion').textContent = totalAtencion > 0 ? '(' + String(totalAtencion) + ')' : '';
    // El vacío ya no puede mentir: decía "no hay nada que necesite tu
    // atención" al lado de una tarjeta de propuesta que sí la necesitaba.
    setHidden(byId('vacio-atencion'), totalAtencion > 0);
    // (step 21A §4.5) El filete de acento del panel de atención, y sólo
    // mientras su propio contador pase de cero. El panel hermano de tareas
    // no lo lleva nunca: son dos cuentas de definiciones distintas y no se
    // suman. Es una clase, no un estilo en línea (regla dura, §7.2).
    var panelAtencion = byId('panel-atencion');
    if (panelAtencion) panelAtencion.classList.toggle('tx-panel--focus', totalAtencion > 0);
    reconcileList(byId('lista-atencion'), attentionEntries, function (x) { return x.call.callIdHash; }, function (x, existingLi) {
      var li = existingLi || el('li', '');
      // B2 (revisión step 15): esta tarjeta se reconstruye entera, y lleva
      // dentro el enlace "Ver la llamada". Si el foco está ahí, no se toca:
      // el sondeo cada dos segundos no puede quitárselo a quien navega con el
      // teclado. La tarjeta se pondrá al día en cuanto suelte el foco.
      if (holdsFocus(li)) return li;
      clearChildren(li);
      li.appendChild(buildAttentionCard(x.call, x.entry, null));
      return li;
    });

    // Cosas que hacer una persona
    // step 19 §4.2 — UNA definición para el contador, la lista y el vacío.
    // "open" lo resuelve el SERVIDOR (snapshot.ts, junto a "open: t.completedAtISO
    // === undefined") y es exactamente lo que cuenta "metrics.pendingHumanTasks":
    // antes de este arreglo, esta lista usaba "snap.humanQueue.tasks" ENTERA
    // —resueltas incluidas—, así que en cuanto se resolvía una sola tarea el
    // número de la cabecera y el largo de esta lista discrepaban. Filtrando
    // aquí, en el único sitio que construye "tasks", es imposible por
    // construcción que el contador, la lista y el estado vacío discrepen entre
    // sí ni con "metrics.pendingHumanTasks".
    var tasks = snap.humanQueue.tasks.filter(function (t) { return t.open; })
      .slice().sort(function (a, b) { return a.createdAtISO.localeCompare(b.createdAtISO); });
    byId('contador-cola').textContent = tasks.length > 0 ? '(' + String(tasks.length) + ')' : '';
    setHidden(byId('vacio-tareas'), tasks.length > 0);
    reconcileList(byId('lista-tareas'), tasks, function (t) { return t.id; }, function (task, existingLi) {
      var li = existingLi || (function () {
        var node = el('li', '');
        var body = el('div', 'tx-activity-list__body');
        body.appendChild(el('p', '', ''));
        body.appendChild(el('p', 'tx-activity-list__time', ''));
        node.appendChild(body);
        node.appendChild(el('a', 'tx-btn tx-btn--secondary', 'Ver'));
        return node;
      })();
      var body = li.children[0];
      body.children[0].textContent = task.reasonLabel;
      body.children[1].textContent = 'Hoy a las ' + formatTimeFromISO(task.createdAtISO);
      var link = li.children[1];
      link.href = enlaceDeTarea(task);
      return li;
    });

    // Actividad reciente de llamadas (step 21A §4.7, D11)
    // La fuente es y sigue siendo \`snap.calls\` con desenlace: sólo llamadas.
    // El título de la sección lo dice ahora en el HTML, en vez de prometer
    // una cronología entre dominios que no existe hasta step 21B.
    // Cada fila enseña la píldora del desenlace, la hora sintética y la frase
    // sencilla de QUE_PASO. NUNCA el hash de la llamada, el reasonCode, el
    // internalReasonCode ni el scenarioId: ésos viven en el <details>
    // técnico de Llamadas.
    var recent = snap.calls.filter(function (c) { return c.outcome !== undefined; })
      .slice()
      .sort(function (a, b) { return b.startedAtISO.localeCompare(a.startedAtISO); })
      .slice(0, 5);
    setHidden(byId('vacio-actividad'), recent.length > 0);
    reconcileList(byId('lista-actividad'), recent, function (c) { return c.callIdHash; }, function (call, existingLi) {
      // §4.7 / D10 — el enlace por fila con TEXTO real («Ver la llamada», la
      // misma copia que ya usa la tarjeta de atención), en lugar del cheurón
      // sin destino de la referencia visual. Se construye AQUÍ, en el
      // constructor, y se actualiza abajo, en el actualizador: los dos a la
      // vez, que es la regla de reconcileList (§7.2, trampa 9). La clave no
      // cambia: sigue siendo callIdHash.
      var li = existingLi || (function () {
        var node = el('li', '');
        var pillHolder = el('div', '');
        var body = el('div', 'tx-activity-list__body');
        body.appendChild(el('p', 'tx-activity-list__time', ''));
        body.appendChild(el('p', '', ''));
        node.appendChild(pillHolder);
        node.appendChild(body);
        node.appendChild(el('a', 'tx-btn tx-btn--secondary', 'Ver la llamada'));
        return node;
      })();
      var status = statusFor(call);
      var pillHolder = li.children[0];
      clearChildren(pillHolder);
      if (status) pillHolder.appendChild(buildPillEl(status));
      var body = li.children[1];
      body.children[0].textContent = formatTimeFromISO(call.startedAtISO);
      body.children[1].textContent = status ? (QUE_PASO[status.label] || '') : '';
      // El enlace NO se reconstruye: se le pone la dirección al día. Así el
      // foco de quien esté encima de él sobrevive a los repintados del
      // sondeo, que es exactamente lo que reconcileList protege.
      li.children[2].href = '#/llamadas/' + call.callIdHash;
      return li;
    });

    // Actividad operativa de cancelaciones y lista de espera (step 23 §8.2)
    renderActividadOperativa(snap);

    // Próximas citas de hoy
    var upcoming = snap.calendar.reservations.filter(function (r) {
      return r.date === snap.engineToday && r.status === 'confirmed' && r.startMinutes >= snap.engineNowMinutes;
    }).sort(function (a, b) { return a.startMinutes - b.startMinutes; }).slice(0, 4);
    setHidden(byId('vacio-citas-hoy'), upcoming.length > 0);
    // (step 21A §4.6) La hora sale de la caja de servicio y pasa a su propia
    // columna de 4,5rem, que es lo que deja el carril temporal legible: una
    // columna de horas alineada, el servicio debajo del punto y la píldora a
    // la derecha. El diseño autoriza expresamente separar hora y servicio
    // «a la vez en el constructor y en el actualizador» — es lo que se hace
    // aquí — y la clave se queda como estaba: \`r.id\`.
    // Ni un nodo se añade para el carril: el punto y la línea son
    // pseudoelementos de \`.tx-appointment-list > li\`.
    reconcileList(byId('lista-citas-hoy'), upcoming, function (r) { return r.id; }, function (r, existingLi) {
      var li = existingLi || (function () {
        var node = el('li', '');
        node.appendChild(el('p', 'tx-appointment-list__hour', ''));
        var body = el('div', 'tx-activity-list__body');
        body.appendChild(el('p', '', ''));
        body.appendChild(el('p', 'tx-appointment-list__pro', ''));
        node.appendChild(body);
        node.appendChild(el('div', ''));
        return node;
      })();
      li.children[0].textContent = formatMinutes(r.startMinutes);
      var body = li.children[1];
      body.children[0].textContent = serviceLabel(r.serviceId);
      body.children[1].textContent = professionalLabel(r.employeeId);
      var pillHolder = li.children[2];
      clearChildren(pillHolder);
      pillHolder.appendChild(buildPillEl(STATUS_VOCAB.BOOKING_CONFIRMED));
      return li;
    });

    // Próximos días distintos — resumen compacto (step 16).
    // La tarjeta de antes decía en dos párrafos, en una columna de 4/12, lo que
    // aquí se dice en una línea. La línea es VERDADERA en los tres casos:
    //   - se afirma el régimen del local SOLO acotado a las fechas de la
    //     temporada, nunca "los próximos días", que sería una promesa sobre
    //     días que pueden caer ya fuera de ella;
    //   - se cuentan DÍAS NATURALES de verdad, no entradas de
    //     collectDistinctDays: un cierre de dos días son DOS días, no uno
    //     (revisión step 16, F2 — el texto promete "días", así que hay que
    //     contarlos, no las filas que los agrupan). Con el fixture de hoy
    //     (closures/venueRules/absences vacíos) el recuento da cero, y en
    //     cuanto el operador publique un cierre desde el diálogo, lo dice.
    var todosLosDistintos = collectDistinctDays(snap.calendar, snap.engineToday, null);
    var distinctDays = todosLosDistintos.slice(0, 3);
    var temporada = activeSeasonalOverride(snap.calendar, snap.engineToday);
    var regimen = temporada
      ? ('El local va con el horario de temporada («' + temporada.label + '», ' +
         formatDateRangeLong(temporada.startDate, temporada.endDate) + ').')
      : 'El local va con su horario de siempre.';
    var numDiasNaturales = countDistinctCalendarDays(todosLosDistintos, snap.engineToday);
    var excepciones = numDiasNaturales === 0
      ? 'No hay ningún día distinto por delante.'
      : (numDiasNaturales === 1
        ? 'Hay 1 día distinto por delante.'
        : 'Hay ' + String(numDiasNaturales) + ' días distintos por delante.');
    setText(byId('inicio-calendario-resumen'), regimen + ' ' + excepciones);
    reconcileList(byId('lista-dias-distintos'), distinctDays, function (d) { return d.key; }, function (d, existingLi) {
      var li = existingLi || (function () {
        var node = el('li', '');
        var body = el('div', 'tx-activity-list__body');
        body.appendChild(el('p', '', ''));
        body.appendChild(el('p', 'tx-activity-list__time', ''));
        node.appendChild(body);
        return node;
      })();
      li.children[0].children[0].textContent = d.title;
      li.children[0].children[1].textContent = d.detail;
      return li;
    });
  }

  /**
   * Unifies closures, holidays/special openings and absences into one list
   * of "días distintos", sorted by start date. \`untilMonth\`, when given as
   * { year, month }, restricts to items overlapping that month; when null,
   * restricts to items whose range has not yet fully ended (>= fromDateISO).
   */
  function collectDistinctDays(cal, fromDateISO, untilMonth) {
    var items = [];
    (cal.closures || []).forEach(function (c) {
      if (c.approval !== 'approved') return;
      items.push({ key: 'closure-' + c.id, start: c.startDate, end: c.endDate, title: rangeLabel(c.startDate, c.endDate) + ' · Local cerrado', detail: 'Cierre aprobado' });
    });
    (cal.venueRules || []).forEach(function (r) {
      if (r.approval !== 'approved') return;
      if (r.closed) {
        items.push({ key: 'rule-' + r.id, start: r.date, end: r.date, title: formatDateShort(r.date) + ' · Local cerrado', detail: 'Festivo aprobado' });
      } else {
        items.push({ key: 'rule-' + r.id, start: r.date, end: r.date, title: formatDateShort(r.date) + ' · Horario especial', detail: (r.specialOpen || '—') + ' – ' + (r.specialClose || '—') });
      }
    });
    (cal.absences || []).forEach(function (a) {
      if (a.approval !== 'approved') return;
      var kindLabel = a.kind === 'vacation' ? 'Vacaciones' : (a.kind === 'training' ? 'Formación' : 'Ausencia');
      items.push({ key: 'absence-' + a.id, start: a.startDate, end: a.endDate, title: rangeLabel(a.startDate, a.endDate) + ' · ' + professionalLabel(a.employeeId) + ' no está', detail: kindLabel });
    });
    var filtered = items.filter(function (item) {
      if (untilMonth) {
        var monthStart = untilMonth.year + '-' + String(untilMonth.month).padStart(2, '0') + '-01';
        var monthEndDate = new Date(untilMonth.year, untilMonth.month, 0);
        var monthEnd = toISODate(monthEndDate);
        return item.start <= monthEnd && item.end >= monthStart;
      }
      return item.end >= fromDateISO;
    });
    filtered.sort(function (a, b) { return a.start.localeCompare(b.start); });
    return filtered;
  }

  function rangeLabel(start, end) {
    if (start === end) return formatDateShort(start);
    return formatDateShort(start) + ' – ' + formatDateShort(end);
  }

  /**
   * Cuenta los DÍAS NATURALES distintos que cubren los items que devuelve
   * collectDistinctDays (revisión step 16, F2). Cada item trae start y end;
   * un cierre de dos días es UN item pero DOS fechas, y el resumen de Inicio
   * dice "días", así que hay que contarlos de verdad. Se acota cada item a
   * partir de fromDateISO ("por delante" no cuenta fechas ya pasadas de un
   * item que empezó ayer y sigue hoy) y las fechas que dos items comparten
   * (un cierre y una ausencia el mismo día) se cuentan una sola vez.
   */
  function countDistinctCalendarDays(items, fromDateISO) {
    var seen = {};
    var count = 0;
    items.forEach(function (item) {
      var cursor = item.start > fromDateISO ? item.start : fromDateISO;
      while (cursor <= item.end) {
        if (!seen[cursor]) {
          seen[cursor] = true;
          count++;
        }
        cursor = addDaysISO(cursor, 1);
      }
    });
    return count;
  }

  /**
   * D1 (revisión step 15). El texto de "aquí no hay ningún día distinto" no
   * puede desmentir al aviso de temporada que está pintado más arriba en la
   * misma pantalla. Con una temporada en vigor, Calendario decía a la vez
   * "Horario de agosto de 2026 · 09:00-17:30" y "Todos los días siguen el
   * horario habitual".
   *
   * Se ha preferido esto a meter los 31 días en la lista de días distintos:
   * treinta y una fichas idénticas serían ruido y taparían justo lo que esa
   * lista existe para destacar — el día suelto que se sale de la norma.
   *
   * Los dos párrafos se crean aquí si no existen (así el bloque vive en un
   * solo sitio) y luego se escriben sólo cuando cambian, para no destruir la
   * selección de texto en cada sondeo.
   */
  function fillDistinctDaysEmpty(emptyEl, season, scope) {
    if (emptyEl.children.length < 2) {
      clearChildren(emptyEl);
      emptyEl.appendChild(el('p', 'tx-empty__title', ''));
      emptyEl.appendChild(el('p', 'tx-empty__body', ''));
    }
    var titulo;
    var cuerpo;
    if (season) {
      titulo = scope === 'mes' ? 'Ningún día se sale de lo previsto este mes.' : 'Ningún día se sale de lo previsto.';
      cuerpo = 'Estos días van con el horario de temporada («' + season.label + '», ' + formatDateRangeLong(season.startDate, season.endDate) +
        '), no con el horario de siempre.';
    } else if (scope === 'mes') {
      titulo = 'Este mes no tiene ningún día distinto.';
      cuerpo = 'Todos los días siguen el horario habitual.';
    } else {
      titulo = 'Nada distinto por delante.';
      cuerpo = 'Los próximos días siguen el horario de siempre.';
    }
    setText(emptyEl.children[0], titulo);
    setText(emptyEl.children[1], cuerpo);
  }

  // ---------------------------------------------------------------------
  // AGENDA
  // ---------------------------------------------------------------------

  /** step 26 §9 — la fecha ancla EFECTIVA: la del hash, o \`engineToday\` cuando está ausente. */
  function agendaFechaEfectiva(fechaRuta, snap) {
    return fechaRuta || (snap ? snap.engineToday : '');
  }

  function agendaHrefPara(vista, fechaISO, filtro) {
    return '#/agenda/' + vista + '/' + fechaISO + '/' + filtro;
  }

  /**
   * step 26 §9 — LA ÚNICA forma en que un control de Agenda cambia de
   * estado: escribe el hash y deja que \`hashchange\` dispare \`applyRoute()\`.
   * Ningún control llama a \`renderActiveSection()\` directamente. Mismo
   * patrón defensivo que \`closeCallDetail\`: si el hash de destino ya es el
   * actual, escribirlo no dispara \`hashchange\` (el navegador no repite el
   * evento), así que se aplica la ruta a mano para que el control siga
   * respondiendo.
   */
  function navegarAgenda(vista, fechaISO, filtro) {
    var href = agendaHrefPara(vista, fechaISO, filtro);
    if (window.location.hash === href) applyRoute();
    else window.location.hash = href;
  }

  function addMonthsISO(iso, n) {
    var p = parseISODateParts(iso);
    var d = new Date(p.y, p.m - 1 + n, 1);
    var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(p.d, lastDay));
    return toISODate(d);
  }

  /**
   * Cuánto mueven anterior/siguiente la fecha ancla, por vista. La decisión
   * 5 fija ±7 días para Semana; Mes no tiene esa cifra escrita en el
   * normativo, así que se mueve por MES natural (mismo criterio que ya usa
   * el propio Calendario operativo). Lista muestra una ventana de 7 días
   * desde la fecha ancla (decisión 10): paginarla de 7 en 7 evita mostrar
   * casi el mismo panel que el paso anterior.
   */
  function agendaFechaTrasPaso(vista, fechaISO, signo) {
    if (vista === 'mes') return addMonthsISO(fechaISO, signo);
    var paso = vista === 'semana' || vista === 'lista' ? 7 : 1;
    return addDaysISO(fechaISO, signo * paso);
  }

  function wireAgendaControls() {
    AGENDA_VISTAS.forEach(function (v) {
      byId('agenda-vista-' + v).addEventListener('click', function () {
        if (!latestSnapshot) return;
        navegarAgenda(v, agendaFechaEfectiva(agendaRouteFecha, latestSnapshot), agendaRouteFiltro);
      });
    });
    byId('agenda-anterior').addEventListener('click', function () {
      if (!latestSnapshot) return;
      var fecha = agendaFechaEfectiva(agendaRouteFecha, latestSnapshot);
      navegarAgenda(agendaRouteVista, agendaFechaTrasPaso(agendaRouteVista, fecha, -1), agendaRouteFiltro);
    });
    byId('agenda-hoy').addEventListener('click', function () {
      if (!latestSnapshot) return;
      navegarAgenda(agendaRouteVista, latestSnapshot.engineToday, agendaRouteFiltro);
    });
    byId('agenda-siguiente').addEventListener('click', function () {
      if (!latestSnapshot) return;
      var fecha = agendaFechaEfectiva(agendaRouteFecha, latestSnapshot);
      navegarAgenda(agendaRouteVista, agendaFechaTrasPaso(agendaRouteVista, fecha, 1), agendaRouteFiltro);
    });
    byId('agenda-filtro-profesional').addEventListener('change', function (ev) {
      if (!latestSnapshot) return;
      var fecha = agendaFechaEfectiva(agendaRouteFecha, latestSnapshot);
      var filtro = ev.target.value ? ('p' + ev.target.value) : 'todos';
      navegarAgenda(agendaRouteVista, fecha, filtro);
    });
    // (step 18 §5.2) La reserva para varias personas entra por la Agenda.
    byId('btn-abrir-grupo').addEventListener('click', function () {
      abrirDialogoGrupo(byId('btn-abrir-grupo'), null);
    });
    // (step 24 §4) Y la cita manual, por el mismo sitio y por la misma razón.
    byId('btn-abrir-cita-manual').addEventListener('click', function () {
      abrirDialogoCitaManual(byId('btn-abrir-cita-manual'));
    });
  }

  /** La ventana de 7 días que pinta la vista Lista (decisión 10), empezando en la fecha ancla. */
  function agendaListaDates(fechaISO) {
    var dates = [];
    for (var i = 0; i < 7; i += 1) dates.push(addDaysISO(fechaISO, i));
    return dates;
  }

  // =====================================================================
  // step 26 — REJILLA DE AGENDA (Día · Semana). Funciones puras de cálculo
  // (eje, huecos, bandas de ausencia, filas de tic) y de pintado de una
  // COLUMNA, compartidas por las dos vistas: la vista Día pasa una columna
  // por profesional, la vista Semana (un profesional elegido) pasa una
  // columna por día. Ninguna resuelve disponibilidad: sólo LEE
  // \`snap.calendar\` — el mismo snapshot que ya sondea la consola — y
  // \`resolveVenueDay\`, la única función del cliente que decide horario
  // (decisión 11, "no se construye un segundo calendario").
  // =====================================================================

  function capitalizarInicial(s) {
    return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** Lunes (ISO) de la semana que contiene \`iso\`. */
  function mondayOfWeek(iso) {
    var d = dateFromISO(iso);
    var dow = (d.getDay() + 6) % 7; // 0 = lunes
    return addDaysISO(iso, -dow);
  }

  function hhmmToMinutes(hhmm) {
    var partes = String(hhmm).split(':');
    return Number(partes[0]) * 60 + Number(partes[1]);
  }

  /**
   * step 26 §8 — identidad por POSICIÓN del profesional en
   * \`snap.calendar.professionals\` ordenado por \`employeeId\` ascendente,
   * módulo 3. Determinista y estable entre sondeos, sin ningún dato nuevo
   * del servidor.
   */
  function agendaIdentidadClase(employeeId, professionals) {
    var ordenado = professionals.slice().sort(function (a, b) { return a.employeeId - b.employeeId; });
    var idx = 0;
    for (var i = 0; i < ordenado.length; i += 1) {
      if (ordenado[i].employeeId === employeeId) { idx = i; break; }
    }
    return 'tx-agenda-block--identity-' + String((idx % 3) + 1);
  }

  /**
   * step 26 §6.1 — el eje temporal: apertura→cierre REALES de
   * \`resolveVenueDay\` (que ya existe y ya usan Agenda y Calendario; no se
   * escribe ninguna resolución nueva de horario aquí), extendido hacia fuera
   * a la hora en punto si alguna cita confirmada cae fuera de ese intervalo.
   */
  function resolveAgendaDayAxis(dateISO, snap, employeeIds) {
    var venueDay = resolveVenueDay(dateISO, snap.calendar);
    if (!venueDay.open) {
      return { open: false, reasonLabel: venueDay.reasonLabel, startMinutes: 0, endMinutes: 0, ticks: 0, extendida: false };
    }
    var startMinutes = hhmmToMinutes(venueDay.start);
    var endMinutes = hhmmToMinutes(venueDay.end);
    var extendida = false;
    snap.calendar.reservations.forEach(function (r) {
      if (r.date !== dateISO || r.status !== 'confirmed') return;
      if (employeeIds && employeeIds.indexOf(r.employeeId) === -1) return;
      if (r.startMinutes < startMinutes) { startMinutes = Math.floor(r.startMinutes / 60) * 60; extendida = true; }
      if (r.endMinutes > endMinutes) { endMinutes = Math.ceil(r.endMinutes / 60) * 60; extendida = true; }
    });
    return { open: true, startMinutes: startMinutes, endMinutes: endMinutes, ticks: Math.max(0, Math.round((endMinutes - startMinutes) / 15)), extendida: extendida };
  }

  /** El eje COMÚN de varios días (vista Semana): la unión de sus ventanas, para que las siete columnas compartan una sola escala. */
  function agendaEjeSemana(dias, snap, employeeIds) {
    var ejes = dias.map(function (d) { return resolveAgendaDayAxis(d, snap, employeeIds); }).filter(function (a) { return a.open; });
    if (ejes.length === 0) return { open: false, startMinutes: 0, endMinutes: 0, ticks: 0, extendida: false };
    var start = ejes[0].startMinutes;
    var end = ejes[0].endMinutes;
    var extendida = false;
    ejes.forEach(function (a) {
      if (a.startMinutes < start) start = a.startMinutes;
      if (a.endMinutes > end) end = a.endMinutes;
      if (a.extendida) extendida = true;
    });
    return { open: true, startMinutes: start, endMinutes: end, ticks: Math.max(0, Math.round((end - start) / 15)), extendida: extendida };
  }

  function agendaFilaInicio(axis, minutes) { return Math.max(1, Math.round((minutes - axis.startMinutes) / 15) + 1); }
  function agendaFilaSpan(minutosDeDuracion) { return Math.max(1, Math.round(minutosDeDuracion / 15)); }

  /**
   * step 26 §6.3 — las bandas de ausencia aprobada de \`employeeId\` en
   * \`dateISO\`, recortadas al eje. Una ausencia de día completo
   * (\`allDay\`, o sin \`startMinutes\`/\`endMinutes\`) produce una banda que
   * cubre el eje entero.
   */
  function agendaAusenciasDeColumna(cal, employeeId, dateISO, axis) {
    if (!axis.open) return [];
    var bandas = [];
    (cal.absences || []).forEach(function (a) {
      if (a.employeeId !== employeeId || a.approval !== 'approved') return;
      if (!dateInRange(dateISO, a.startDate, a.endDate)) return;
      var completa = a.allDay || typeof a.startMinutes !== 'number' || typeof a.endMinutes !== 'number';
      var start = completa ? axis.startMinutes : Math.max(axis.startMinutes, a.startMinutes);
      var end = completa ? axis.endMinutes : Math.min(axis.endMinutes, a.endMinutes);
      if (end > start) bandas.push({ startMinutes: start, endMinutes: end });
    });
    return bandas;
  }

  /**
   * V1-4/V1-5 — LA VENTANA REAL DEL LOCAL ESE DÍA, recortada al eje.
   *
   * El eje puede estar EXTENDIDO: si una cita confirmada cae fuera del
   * horario (porque el horario cambió después, o porque la cita se creó
   * cuando el día abría más), \`resolveAgendaDayAxis\` estira el eje a la hora
   * en punto para que esa cita se vea. Estirar el EJE es correcto; ofrecer
   * huecos ahí no lo es: la Agenda invitaba a «Crear cita manual» a las 08:00
   * de un día que abre a las 09:30, y el asistente —que sí pregunta al
   * servidor— contestaba después que no hay hueco. Un botón que promete algo
   * que la siguiente pantalla desmiente.
   *
   * La ventana sale de \`resolveVenueDay\`, que es la ÚNICA función del cliente
   * que decide horario (invariante I7: \`resolveDayWindows\` no se reimplementa
   * en el navegador). Aquí no se calcula ninguna disponibilidad nueva: se LEE
   * la que ya se estaba usando para dibujar el eje, y se le resta la pausa que
   * el propio horario declare.
   *
   * Devuelve \`null\` cuando ese día el local no abre — que en la vista Semana
   * pasa de verdad, porque las siete columnas comparten un eje común.
   */
  function agendaVentanaDelDia(dateISO, snap, axis) {
    if (!axis.open) return null;
    var venueDay = resolveVenueDay(dateISO, snap.calendar);
    if (!venueDay.open) return null;
    var inicio = Math.max(axis.startMinutes, hhmmToMinutes(venueDay.start));
    var fin = Math.min(axis.endMinutes, hhmmToMinutes(venueDay.end));
    if (fin <= inicio) return null;
    // La pausa, SÓLO si el horario del local la declara. NO se inventa
    // ninguna: el calendario de la demostración no trae hoy ni un
    // \`breakStart\` de local, así que en la demostración esta rama no se
    // activa — y el día que alguien apunte una, la Agenda dejará de ofrecer
    // huecos dentro de ella sin tocar una línea más.
    var pausa = null;
    if (venueDay.breakStart && venueDay.breakEnd) {
      var pInicio = Math.max(inicio, hhmmToMinutes(venueDay.breakStart));
      var pFin = Math.min(fin, hhmmToMinutes(venueDay.breakEnd));
      if (pFin > pInicio) pausa = { startMinutes: pInicio, endMinutes: pFin };
    }
    return { startMinutes: inicio, endMinutes: fin, pausa: pausa };
  }

  /**
   * step 26 §6.5 — los tramos SIN cita confirmada dentro de la VENTANA REAL
   * del local (no del eje, que puede estar extendido: V1-4), restando también
   * las bandas de ausencia y la pausa declarada del día (V1-5). Un único tramo
   * por hueco contiguo, nunca uno por tic.
   */
  function agendaHuecosDeColumna(axis, reservacionesConfirmadas, bandas, ventana) {
    if (!axis.open || !ventana) return [];
    var ocupados = reservacionesConfirmadas
      .map(function (r) { return [Math.max(ventana.startMinutes, r.startMinutes), Math.min(ventana.endMinutes, r.endMinutes)]; })
      .concat(bandas.map(function (b) { return [Math.max(ventana.startMinutes, b.startMinutes), Math.min(ventana.endMinutes, b.endMinutes)]; }))
      .concat(ventana.pausa ? [[ventana.pausa.startMinutes, ventana.pausa.endMinutes]] : [])
      .filter(function (par) { return par[1] > par[0]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    var huecos = [];
    var cursor = ventana.startMinutes;
    ocupados.forEach(function (par) {
      if (par[0] > cursor) huecos.push([cursor, par[0]]);
      if (par[1] > cursor) cursor = par[1];
    });
    if (cursor < ventana.endMinutes) huecos.push([cursor, ventana.endMinutes]);
    return huecos.filter(function (h) { return h[1] > h[0]; }).map(function (h) { return { startMinutes: h[0], endMinutes: h[1] }; });
  }

  /**
   * V1-4/V1-5 — las ZONAS DEL EJE QUE NO SON HORAS DE ATENDER: la extensión
   * de arriba, la de abajo y la pausa. Se pintan (para que el eje no tenga
   * agujeros mudos y para que se entienda POR QUÉ no hay botón ahí), pero sin
   * un solo control: no hay nada que hacer en ellas.
   */
  function agendaZonasCerradasDeColumna(axis, ventana) {
    if (!axis.open) return [];
    if (!ventana) return [{ startMinutes: axis.startMinutes, endMinutes: axis.endMinutes, motivo: 'El local no abre este día' }];
    var zonas = [];
    if (ventana.startMinutes > axis.startMinutes) {
      zonas.push({ startMinutes: axis.startMinutes, endMinutes: ventana.startMinutes, motivo: 'Fuera del horario del local' });
    }
    if (ventana.pausa) {
      zonas.push({ startMinutes: ventana.pausa.startMinutes, endMinutes: ventana.pausa.endMinutes, motivo: 'Pausa del local' });
    }
    if (ventana.endMinutes < axis.endMinutes) {
      zonas.push({ startMinutes: ventana.endMinutes, endMinutes: axis.endMinutes, motivo: 'Fuera del horario del local' });
    }
    return zonas;
  }

  /** La persona sintética de una cita, cuando la hay (step 26 §6.4, punto 2). */
  function agendaPersonaLabel(r) {
    if (r.manual) return r.manual.clientLabel;
    if (r.group) return r.group.memberLabel;
    // Una cita nacida de una llamada de voz no lleva ninguna identidad
    // sintética (el motor de llamadas no la captura, por diseño): decirlo
    // así es la única frase honesta, nunca un nombre inventado.
    return 'Cliente por teléfono';
  }

  /**
   * step 26 §6.4 — anatomía del bloque, EXACTA por duración: ≥45 min, tres
   * líneas; 30 min, dos; 15 min, una (servicio y profesional sólo en el
   * nombre accesible y en el detalle).
   */
  function agendaLineasBloque(r, contextoLabel) {
    var duracion = r.endMinutes - r.startMinutes;
    var intervalo = formatMinutes(r.startMinutes) + ' – ' + formatMinutes(r.endMinutes);
    var persona = agendaPersonaLabel(r);
    var servicio = serviceLabel(r.serviceId);
    if (duracion <= 15) return [intervalo + ' · ' + persona];
    if (duracion <= 30) return [intervalo + ' · ' + persona, servicio + ' · ' + contextoLabel];
    return [intervalo, persona + ' · ' + servicio, contextoLabel];
  }

  /** «45 minutos», «1 h», «1 h 30 min» — la duración dicha como se dice. */
  function duracionEnPalabras(minutos) {
    if (minutos < 60) return String(minutos) + ' minutos';
    var horas = Math.floor(minutos / 60);
    var resto = minutos % 60;
    var cabecera = horas === 1 ? '1 hora' : String(horas) + ' horas';
    if (resto === 0) return cabecera;
    return cabecera + ' y ' + String(resto) + ' minutos';
  }

  /**
   * V2-5 — LA DURACIÓN, DICHA. El nombre accesible daba inicio y fin, y quien
   * lee con lector de pantalla tenía que restar de cabeza para saber si esa
   * cita ocupa media hora o dos y media. La misión pide inicio, fin,
   * DURACIÓN, cliente y profesional; el §A7 del normativo daba esto por hecho
   * («ya dice inicio, fin, duración, persona y profesional. No se toca») y era
   * una errata: la duración no estaba. Se añade donde toca, entre el intervalo
   * y la persona, y sin tocar nada más de la frase.
   */
  function agendaNombreAccesibleBloque(r, contextoAccesible) {
    return 'Cita de ' + formatMinutes(r.startMinutes) + ' a ' + formatMinutes(r.endMinutes) + ' · ' +
      duracionEnPalabras(r.endMinutes - r.startMinutes) + ' · ' +
      agendaPersonaLabel(r) + ' · ' + serviceLabel(r.serviceId) + ' · ' + contextoAccesible + '. Ver acciones.';
  }

  function agendaNombreAccesibleHueco(dateISO, startMinutes, endMinutes, employeeId) {
    return 'Crear cita manual el ' + formatDateLong(dateISO) + ' a las ' + formatMinutes(startMinutes) +
      ' con ' + professionalLabel(employeeId) + '. Tramo sin cita de ' + formatMinutes(startMinutes) + ' a ' + formatMinutes(endMinutes) + '.';
  }

  /**
   * Los ítems (bloques, huecos, bandas de ausencia) de UNA columna —un
   * profesional-día—, ya ordenados y con su fila/tic resueltos. Nunca se
   * sitúan en la rejilla las citas canceladas (§6.6): se listan aparte en
   * \`canceladas\`.
   */
  function agendaItemsParaColumna(snap, dateISO, employeeId, axis, contextoLabel, contextoAccesible, identidadClase) {
    if (!axis.open) return { items: [], canceladas: [], tieneAusencia: false };
    var todas = snap.calendar.reservations.filter(function (r) { return r.date === dateISO && r.employeeId === employeeId; });
    var confirmadas = todas.filter(function (r) { return r.status === 'confirmed'; }).sort(function (a, b) { return a.startMinutes - b.startMinutes; });
    var canceladas = todas.filter(function (r) { return r.status !== 'confirmed'; }).sort(function (a, b) { return a.startMinutes - b.startMinutes; });
    var bandas = agendaAusenciasDeColumna(snap.calendar, employeeId, dateISO, axis);
    var ventana = agendaVentanaDelDia(dateISO, snap, axis);
    var huecos = agendaHuecosDeColumna(axis, confirmadas, bandas, ventana);

    var items = [];
    confirmadas.forEach(function (r) {
      var inicioVisible = Math.max(axis.startMinutes, r.startMinutes);
      var finVisible = Math.min(axis.endMinutes, r.endMinutes);
      items.push({
        tipo: 'bloque', key: r.id, r: r,
        filaInicio: agendaFilaInicio(axis, inicioVisible), filaSpan: agendaFilaSpan(finVisible - inicioVisible),
        identidadClase: identidadClase, contextoLabel: contextoLabel, contextoAccesible: contextoAccesible
      });
    });
    huecos.forEach(function (h) {
      items.push({
        tipo: 'hueco', key: 'gap:' + dateISO + ':' + String(employeeId) + ':' + String(h.startMinutes),
        filaInicio: agendaFilaInicio(axis, h.startMinutes), filaSpan: agendaFilaSpan(h.endMinutes - h.startMinutes),
        dateISO: dateISO, startMinutes: h.startMinutes, endMinutes: h.endMinutes, employeeId: employeeId
      });
    });
    bandas.forEach(function (b, i) {
      items.push({
        tipo: 'ausencia', key: 'ausencia:' + dateISO + ':' + String(employeeId) + ':' + String(i),
        filaInicio: agendaFilaInicio(axis, b.startMinutes), filaSpan: agendaFilaSpan(b.endMinutes - b.startMinutes)
      });
    });
    agendaZonasCerradasDeColumna(axis, ventana).forEach(function (z) {
      items.push({
        tipo: 'cerrado', key: 'cerrado:' + dateISO + ':' + String(employeeId) + ':' + String(z.startMinutes),
        filaInicio: agendaFilaInicio(axis, z.startMinutes), filaSpan: agendaFilaSpan(z.endMinutes - z.startMinutes),
        motivo: z.motivo, startMinutes: z.startMinutes, endMinutes: z.endMinutes
      });
    });
    items.sort(function (a, b) { return a.filaInicio - b.filaInicio; });
    return { items: items, canceladas: canceladas, tieneAusencia: bandas.length > 0 };
  }

  /**
   * Construye o reconcilia el \`<li>\` de UN ítem de columna. Bajo el foco
   * (decisión 11, regla 4/D7) no se reconstruye: se devuelve tal cual.
   */
  function agendaConstruirItem(item, existing) {
    if (item.tipo === 'cerrado') {
      // V1-4 — SIN BOTÓN, a propósito: aquí no se puede crear nada. Se pinta
      // para que el eje extendido no tenga un agujero mudo y para que se lea
      // POR QUÉ no hay nada que pulsar.
      var zona = existing || document.createElement('li');
      zona.className = 'tx-agenda-fuera tx-agenda-r-' + String(item.filaInicio) + ' tx-agenda-s-' + String(item.filaSpan);
      clearChildren(zona);
      zona.appendChild(el('span', '', formatMinutes(item.startMinutes) + ' – ' + formatMinutes(item.endMinutes) + ' · ' + item.motivo));
      return zona;
    }
    if (item.tipo === 'ausencia') {
      var banda = existing || document.createElement('li');
      banda.className = 'tx-agenda-banda-ausencia tx-agenda-r-' + String(item.filaInicio) + ' tx-agenda-s-' + String(item.filaSpan);
      clearChildren(banda);
      banda.appendChild(el('span', '', 'No está · Ausencia aprobada'));
      return banda;
    }
    var li = existing || document.createElement('li');
    if (holdsFocus(li)) return li;
    clearChildren(li);
    var boton = document.createElement('button');
    boton.type = 'button';
    if (item.tipo === 'bloque') {
      li.className = 'tx-agenda-block ' + item.identidadClase + ' tx-agenda-r-' + String(item.filaInicio) + ' tx-agenda-s-' + String(item.filaSpan);
      var lineas = agendaLineasBloque(item.r, item.contextoLabel);
      lineas.forEach(function (linea, i) {
        boton.appendChild(el('span', 'tx-agenda-block__l' + String(i + 1), linea));
      });
      boton.setAttribute('aria-label', agendaNombreAccesibleBloque(item.r, item.contextoAccesible));
      boton.onclick = function () { abrirDialogoCitaDetalle(item.r, boton); };
    } else {
      li.className = 'tx-agenda-gap tx-agenda-r-' + String(item.filaInicio) + ' tx-agenda-s-' + String(item.filaSpan);
      boton.appendChild(el('span', '', formatMinutes(item.startMinutes) + ' – ' + formatMinutes(item.endMinutes) + ' · Sin cita'));
      boton.setAttribute('aria-label', agendaNombreAccesibleHueco(item.dateISO, item.startMinutes, item.endMinutes, item.employeeId));
      boton.onclick = function () { abrirCitaManualDesdeHueco(item.dateISO, item.startMinutes, item.employeeId, boton); };
    }
    li.appendChild(boton);
    return li;
  }

  function agendaConstruirColumna() {
    var col = el('section', 'tx-agenda-col');
    col.appendChild(el('h3', '', ''));
    var ol = document.createElement('ol');
    ol.className = 'tx-agenda-col__items';
    col.appendChild(ol);
    return col;
  }

  /**
   * Pinta (o construye) una columna entera: cabecera —texto plano, o un
   * enlace al día (vista Semana, decisión 5)—, píldora de ausencia si
   * corresponde, los ítems y el <details> de canceladas (que NO se pinta
   * con N=0, decisión 6.6).
   */
  function agendaPintarColumna(existingCol, colId, headerTexto, itemsInfo, enlaceDiaISO, notaCerrado) {
    var col = existingCol || agendaConstruirColumna();
    var h3 = col.children[0];
    h3.id = 'agenda-col-' + String(colId);
    if (enlaceDiaISO) {
      var a = h3.firstChild && h3.firstChild.tagName === 'A' ? h3.firstChild : (function () {
        clearChildren(h3);
        var link = document.createElement('a');
        h3.appendChild(link);
        return link;
      })();
      a.href = agendaHrefPara('dia', enlaceDiaISO, agendaRouteFiltro);
      a.setAttribute('aria-label', 'Ver la agenda del ' + formatDateLong(enlaceDiaISO));
      setText(a, headerTexto);
    } else {
      if (h3.firstChild && h3.firstChild.tagName === 'A') clearChildren(h3);
      setText(h3, headerTexto);
    }

    var pill = childByClass(col, 'tx-agenda-col__ausencia');
    if (itemsInfo.tieneAusencia) {
      if (!pill) {
        pill = el('p', 'tx-agenda-col__ausencia', '');
        col.insertBefore(pill, col.children[1]);
      }
      clearChildren(pill);
      pill.appendChild(buildPildoraDeTexto('No está · Ausencia aprobada', 'incomplete'));
    } else if (pill) {
      col.removeChild(pill);
    }

    var nota = childByClass(col, 'tx-context__note');
    if (notaCerrado) {
      if (!nota) { nota = el('p', 'tx-context__note', ''); col.insertBefore(nota, childByClass(col, 'tx-agenda-col__items')); }
      setText(nota, notaCerrado);
    } else if (nota) {
      col.removeChild(nota);
    }

    var ol = childByClass(col, 'tx-agenda-col__items');
    ol.setAttribute('aria-labelledby', h3.id);
    reconcileList(ol, itemsInfo.items, function (item) { return item.key; }, agendaConstruirItem);

    var detalle = childByClass(col, 'tx-agenda-col__cancelled');
    if (itemsInfo.canceladas.length > 0) {
      if (!detalle) {
        detalle = document.createElement('details');
        detalle.className = 'tx-agenda-col__cancelled';
        detalle.appendChild(el('summary', '', ''));
        detalle.appendChild(document.createElement('ul'));
        col.appendChild(detalle);
      }
      setText(detalle.children[0], 'Canceladas (' + String(itemsInfo.canceladas.length) + ')');
      reconcileList(detalle.children[1], itemsInfo.canceladas, function (r) { return r.id; }, function (r, existingLi) {
        var li = existingLi || document.createElement('li');
        clearChildren(li);
        li.appendChild(el('span', '', formatMinutes(r.startMinutes) + ' – ' + formatMinutes(r.endMinutes) + ' · ' +
          agendaPersonaLabel(r) + ' · ' + serviceLabel(r.serviceId) + ' · '));
        li.appendChild(buildPillEl(PILL_CITA_CANCELADA, true));
        return li;
      });
    } else if (detalle) {
      col.removeChild(detalle);
    }
    return col;
  }

  /** Pinta (o construye) la columna del eje de horas — presentacional, aria-hidden. */
  function agendaPintarEje(existingAxisEl, axis) {
    var axisEl = existingAxisEl || (function () {
      var d = el('div', 'tx-agenda-grid__axis');
      d.setAttribute('aria-hidden', 'true');
      return d;
    })();
    if (!axis.open || axis.ticks <= 0) { clearChildren(axisEl); return axisEl; }
    var ticks = [];
    for (var i = 0; i < axis.ticks; i += 1) ticks.push(i);
    // REAPERTURA §R6.a — este es el único de los ~60 puntos de llamada de
    // reconcileList que ignoraba existing e incondicionalmente creaba un
    // nodo nuevo (Defecto 2: los rótulos de hora se acumulaban en cada
    // sondeo, "09:0009:0009:00…"). Ahora reutiliza el nodo existente como
    // todos los demás. className y textContent se REASIGNAN siempre, tanto
    // si el nodo es nuevo como si es reutilizado: un eje que se extiende o
    // se acorta (extendida) cambia el minuto que le toca a cada índice, y
    // un nodo reutilizado con el texto viejo sería un defecto peor que el
    // actual.
    reconcileList(axisEl, ticks, function (i) { return String(i); }, function (i, existing) {
      var minutos = axis.startMinutes + i * 15;
      var esHora = minutos % 60 === 0;
      var esMedia = !esHora && minutos % 30 === 0;
      var div = existing || document.createElement('div');
      div.className = 'tx-agenda-grid__axis-tick tx-agenda-r-' + String(i + 1) + ' tx-agenda-s-1' +
        (esHora ? ' tx-agenda-grid__axis-tick--hora' : (esMedia ? '' : ' tx-agenda-grid__axis-tick--media'));
      div.textContent = (esHora || esMedia) ? formatMinutes(minutos) : '';
      return div;
    });
    return axisEl;
  }

  /**
   * V2-4 — la clase de rejilla que le toca a N columnas de profesional.
   *
   * Antes acotaba a 7 y devolvía \`--cols-5\`/\`--cols-6\` para 5 y 6, clases que
   * NO EXISTÍAN en la hoja: la rejilla se quedaba con el \`repeat(1, …)\` base y
   * las demás columnas caían a pista implícita, desiguales entre sí. Ahora las
   * dos existen, y de OCHO en adelante hay un modificador propio: columnas
   * iguales por \`grid-auto-columns\` y desplazamiento DENTRO de la rejilla
   * —\`.tx-table-scroll\`, la clase que el sistema visual reserva para eso—,
   * nunca de la página.
   */
  var CLASE_REJILLA_MUCHAS = 'tx-agenda-grid--cols-muchas';

  function agendaClaseColumnas(n) {
    if (n <= 0) return 'tx-agenda-grid--cols-1';
    if (n >= 8) return CLASE_REJILLA_MUCHAS + ' tx-table-scroll';
    return 'tx-agenda-grid--cols-' + String(n);
  }

  /**
   * El contenedor de la rejilla, cuando se desplaza por dentro, es una región
   * que hay que poder recorrer con el teclado: mismo trato que la rejilla del
   * mes (\`.tx-table-scroll\` con \`tabindex="0"\` y \`role="region"\` en el HTML
   * servido). Se pone y se QUITA, porque el número de profesionales del filtro
   * cambia entre pintados.
   */
  function agendaAjustarRegionDesplazable(contenedor, muchas) {
    // Los dos estados se ESCRIBEN, no se quita el atributo: \`#agenda-rejilla\`
    // es un nodo persistente que se repinta con cada sondeo y con cada cambio
    // de filtro, y dejar el contrato en «o está el atributo o no está» hace
    // depender el resultado del orden de los pintados anteriores. Con
    // \`tabindex="-1"\` el contenedor sale del orden de tabulación —que es lo
    // que hace falta cuando no hay nada que desplazar— sin dejar de ser
    // enfocable por programa, igual que los encabezados de esta consola.
    contenedor.setAttribute('role', muchas ? 'region' : 'presentation');
    contenedor.setAttribute('tabindex', muchas ? '0' : '-1');
    contenedor.setAttribute('aria-label', muchas ? 'Rejilla de la agenda, desplazable en horizontal' : '');
  }

  function agendaEstadoVacio(titulo, cuerpo) {
    var div = el('div', 'tx-empty');
    div.appendChild(el('p', 'tx-empty__title', titulo));
    if (cuerpo) div.appendChild(el('p', 'tx-empty__body', cuerpo));
    return div;
  }

  function ensureProfessionalOptions(selectEl, professionals, includeAllLabel) {
    // (Revisión adversarial de step 22, N5) La MISMA guarda que
    // \`ensureMotivoOptions\` (ver su nota): reconstruir un \`<select>\` mientras
    // alguien lo tiene abierto le cierra el desplegable en mitad del sondeo, y
    // \`holdsFocus\` no sirve aquí porque protege un DESCENDIENTE, no el propio
    // nodo. Que hoy la plantilla sintética no cambie a media sesión hace que
    // el fallo no se alcance, no que la guarda sobre: la seguridad de una
    // pantalla no debería depender de una invariante del fixture.
    if (document.activeElement === selectEl) return;
    var existingValues = Array.prototype.map.call(selectEl.options, function (o) { return o.value; });
    var wanted = includeAllLabel ? [''] : [];
    professionals.forEach(function (p) { wanted.push(String(p.employeeId)); });
    var same = existingValues.length === wanted.length && existingValues.every(function (v, i) { return v === wanted[i]; });
    if (same) return;
    var previous = selectEl.value;
    clearChildren(selectEl);
    if (includeAllLabel) {
      var allOpt = el('option', '', includeAllLabel);
      allOpt.value = '';
      selectEl.appendChild(allOpt);
    }
    professionals.forEach(function (p) {
      var opt = el('option', '', p.label);
      opt.value = String(p.employeeId);
      selectEl.appendChild(opt);
    });
    if (wanted.indexOf(previous) !== -1) selectEl.value = previous;
  }

  /**
   * (step 18 §5.2) Una celda de tabla con un texto y su rótulo de columna,
   * reconstruida desde cero. El texto va dentro de un \`<span>\` y no como
   * \`textContent\` del \`<td>\` para que se le puedan colgar detrás notas de
   * fila sin que la siguiente pasada las funda con la hora.
   */
  function pintarCeldaSimple(td, rotulo, texto) {
    clearChildren(td);
    td.setAttribute('data-label', rotulo);
    td.appendChild(el('span', '', texto));
  }

  /**
   * (step 18 §5.2, aviso 13 de la revisión C, criterio 8.40) La celda de
   * acción de una fila de Agenda, RECONSTRUIDA DESDE CERO en cada pasada.
   *
   * Por qué desde cero y no añadiendo condicionalmente: \`reconcileList\`
   * reutiliza el \`<tr>\` cuando la clave coincide (D7), así que un botón
   * puesto en una pasada anterior sobrevive a la siguiente. Una cita que pasa
   * de \`recorded\` a corregida, o que deja de ser elegible porque alguien
   * reinició, se quedaría con "Registrar inasistencia" pegado — la pantalla
   * contradiciendo a la proyección. Se paga un \`clearChildren\` por fila cada
   * dos segundos; se compra que eso no pueda pasar.
   *
   * LA EXCEPCIÓN, y es la regla dura D7/O3 de esta consola: si el foco vive
   * dentro de esta celda, NO se toca. El sondeo de 2 s no le quita el foco a
   * quien navega con el teclado; la celda se pondrá al día en cuanto lo
   * suelte. Lo peor que puede pasar entretanto es que se pulse una acción que
   * ya no aplica, y para eso está la respuesta honesta del servidor ("esa
   * acción ya estaba hecha", "esa cita ya tiene un registro corregido").
   */
  function pintarCeldaAccionAgenda(td, r, confirmada) {
    td.setAttribute('data-label', 'Qué puedes hacer');
    if (holdsFocus(td)) return;
    clearChildren(td);
    var cuando = 'la cita de las ' + formatMinutes(r.startMinutes) + ' con ' + professionalLabel(r.employeeId);

    // "Cancelar cita" se construye SIEMPRE y se oculta cuando la cita ya está
    // cancelada, exactamente como en step 17: es el primer control de la
    // celda, y su contrato (existe, con la hora en el nombre accesible; está
    // oculto si no hay nada que cancelar) no cambia por esta misión.
    var cancelar = el('button', 'tx-btn tx-btn--secondary', 'Cancelar cita');
    cancelar.type = 'button';
    setHidden(cancelar, !confirmada);
    cancelar.setAttribute('aria-label', 'Cancelar ' + cuando);
    cancelar.onclick = function () { abrirDialogoCancelarCita(r, cancelar); };
    td.appendChild(cancelar);

    // La elegibilidad llega RESUELTA del servidor (§2.4): aquí no se compara
    // ninguna hora con ninguna cita. Una cita que no ha terminado no enseña
    // ningún botón de inasistencia, ni siquiera deshabilitado (§5.2).
    if (r.eligibleForNoShow && !r.noShow) {
      var registrar = el('button', 'tx-btn tx-btn--secondary', 'Registrar inasistencia');
      registrar.type = 'button';
      registrar.setAttribute('aria-label', 'Registrar la inasistencia de ' + cuando);
      registrar.onclick = function () { abrirDialogoInasistencia(r, registrar); };
      td.appendChild(registrar);
    }

    // Corregir sólo se ofrece sobre un registro VIVO. Sobre uno corregido no
    // hay botón ninguno: la corrección es terminal (K3), y la interfaz no
    // ofrece la acción imposible en vez de dejar que se estrelle contra el 409.
    if (r.noShow && r.noShow.state === 'recorded') {
      var corregir = el('button', 'tx-btn tx-btn--secondary', 'Corregir registro');
      corregir.type = 'button';
      corregir.setAttribute('aria-label', 'Corregir el registro de inasistencia de ' + cuando);
      corregir.onclick = function () { abrirDialogoCorregirInasistencia(r, corregir); };
      td.appendChild(corregir);
    }
  }

  /**
   * step 26 §10 — la vista \`Lista\`: la TABLA de siempre, íntegra, como
   * alternativa accesible. Muestra los 7 días que empiezan en la fecha
   * ancla (decisión 10); los tres botones de rango que antes la gobernaban
   * (Hoy/Mañana/Próximos 7 días) desaparecen y su capacidad la absorben
   * anterior/Hoy/siguiente sobre la fecha ancla — el mismo control de las
   * cuatro vistas.
   */
  function renderAgendaLista(snap, fechaAncla, filtro) {
    var dates = agendaListaDates(fechaAncla);
    var container = byId('agenda-dias');
    var anyReservation = false;

    reconcileList(container, dates, function (d) { return d; }, function (dateISO, existingPanel) {
      var panel = existingPanel || (function () {
        var node = el('section', 'tx-panel');
        node.appendChild(el('h2', '', ''));
        node.appendChild(el('p', 'tx-context__note', ''));
        var scroll = el('div', 'tx-table-scroll');
        scroll.tabIndex = 0;
        scroll.setAttribute('role', 'region');
        var table = document.createElement('table');
        table.className = 'tx-table tx-table--stack';
        var caption = el('caption', 'tx-visually-hidden', 'Citas del día');
        table.appendChild(caption);
        var thead = document.createElement('thead');
        var htr = document.createElement('tr');
        ['Hora', 'Servicio', 'Profesional', 'Estado', 'Qué puedes hacer'].forEach(function (h) {
          var th = document.createElement('th');
          th.scope = 'col';
          th.textContent = h;
          htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        table.appendChild(tbody);
        scroll.appendChild(table);
        node.appendChild(scroll);
        node.appendChild(el('p', 'tx-empty__body', ''));
        return node;
      })();

      var venueDay = resolveVenueDay(dateISO, snap.calendar);
      panel.children[0].textContent = formatDateLong(dateISO);
      // D7 (revisión step 15): esta región de scroll la crea el JS y nacía
      // sin nombre accesible, al contrario que las dos estáticas del HTML
      // ("Tabla de llamadas", "Rejilla del mes"). Lleva la fecha porque en
      // "Próximos 7 días" hay siete regiones a la vez y "Tabla de citas" a
      // secas no distinguiría una de otra.
      panel.children[2].setAttribute('aria-label', 'Tabla de citas del ' + formatDateLong(dateISO));
      var noteEl = panel.children[1];
      var tbody = panel.children[2].querySelector('tbody');
      var emptyDayEl = panel.children[3];

      if (!venueDay.open) {
        noteEl.textContent = 'Local cerrado · ' + venueDay.reasonLabel;
        setHidden(panel.children[2], true);
        setHidden(emptyDayEl, true);
        return panel;
      }
      noteEl.textContent = 'Horario del local: ' + (venueDay.start || '—') + ' – ' + (venueDay.end || '—');
      setHidden(panel.children[2], false);

      // step 17 §9.3: las citas CANCELADAS también se ven. Antes esta pantalla
      // las escondía, así que una cita cancelada desde la consola desaparecía
      // sin dejar rastro y no había dónde enseñar su píldora ni el rótulo de
      // plazo. Ahora se listan junto a las demás, con su estado dicho.
      var dayReservations = snap.calendar.reservations.filter(function (r) {
        if (r.date !== dateISO) return false;
        if (filtro.modo === 'uno' && r.employeeId !== filtro.employeeId) return false;
        return true;
      }).sort(function (a, b) { return a.startMinutes - b.startMinutes; });

      if (dayReservations.length > 0) anyReservation = true;

      if (dayReservations.length === 0) {
        clearChildren(tbody);
        setHidden(emptyDayEl, false);
        emptyDayEl.textContent = 'No hay ninguna cita este día.';
        return panel;
      }
      setHidden(emptyDayEl, true);

      var isToday = dateISO === snap.engineToday;
      var nextFound = false;
      reconcileList(tbody, dayReservations, function (r) { return r.id; }, function (r, existingTr) {
        var tr = existingTr || (function () {
          var row = document.createElement('tr');
          for (var i = 0; i < 5; i += 1) row.appendChild(document.createElement('td'));
          return row;
        })();
        var confirmada = r.status === 'confirmed';
        var isPast = isToday && r.startMinutes < snap.engineNowMinutes;
        var isNext = isToday && confirmada && !isPast && !nextFound;
        if (isNext) nextFound = true;
        tr.className = (confirmada ? '' : 'tx-table__row--cancelled ') + (isPast ? 'tx-table__row--past' : (isNext ? 'tx-table__row--next' : ''));
        // (step 18 §5.2, aviso 13 / criterio 8.40) La celda de la hora se
        // RECONSTRUYE, como las dos de abajo: \`reconcileList\` reutiliza el
        // \`<tr>\` y una referencia de grupo añadida en una pasada anterior se
        // quedaría pegada a una fila que ya no pertenece a ningún grupo.
        pintarCeldaSimple(tr.children[0], 'Hora', formatMinutes(r.startMinutes) + (isNext ? '  SIGUIENTE' : ''));
        // La referencia de grupo llega RESUELTA del servidor: "grupo 1",
        // "Adulto A", "1 de 2". Ni el identificador interno del grupo ni el de
        // la reserva se pintan nunca (§5.7, criterio 8.41).
        if (r.group) {
          tr.children[0].appendChild(el('p', 'tx-row-note',
            'Parte de una reserva para varias personas · ' + r.group.groupLabel + ' · ' + r.group.memberLabel + ' · cita ' + r.group.positionLabel));
          if (!confirmada && r.group.siblingsNote) {
            tr.children[0].appendChild(el('p', 'tx-row-note', r.group.siblingsNote));
          }
        }
        tr.children[1].textContent = serviceLabel(r.serviceId);
        tr.children[1].setAttribute('data-label', 'Servicio');
        tr.children[2].textContent = professionalLabel(r.employeeId);
        tr.children[2].setAttribute('data-label', 'Profesional');
        clearChildren(tr.children[3]);
        tr.children[3].setAttribute('data-label', 'Estado');
        tr.children[3].appendChild(buildPillEl(confirmada ? STATUS_VOCAB.BOOKING_CONFIRMED : PILL_CITA_CANCELADA));
        // step 17 §9.3. Los dos rótulos vienen RESUELTOS del servidor: el
        // veredicto de plazo lo dice \`cancellation.timelinessLabel\` y el
        // origen lo dice la propia proyección. La interfaz no juzga ninguno
        // de los dos, sólo los enseña.
        if (r.cancellation) tr.children[3].appendChild(el('p', 'tx-row-note', r.cancellation.timelinessLabel));
        if (r.originatedFromWaitlistEntryId) tr.children[3].appendChild(el('p', 'tx-row-note', 'Creada desde la lista de espera'));
        // (step 24 §11.1) El CUARTO origen, con la misma disciplina que los
        // tres de arriba: la frase la redacta el servidor y la persona
        // sintética se nombra, porque en una cita manual sí se sabe para quién
        // es. El identificador de la cita manual NO se pinta.
        if (r.manual) {
          tr.children[3].appendChild(el('p', 'tx-row-note', r.manual.originLabel + ' · ' + r.manual.clientLabel));
        }
        // (step 18 §5.2) La píldora de inasistencia, con glifo Y texto: el
        // color nunca lleva el estado solo. El tono lo decide el servidor
        // (\`attention\` para un registro vivo, \`derived\` para uno corregido) —
        // NUNCA el rojo de alarma, porque aquí no hay nada roto ni nadie
        // sancionado.
        if (r.noShow) {
          tr.children[3].appendChild(buildPillEl({
            label: r.noShow.stateLabel,
            modifier: r.noShow.state === 'recorded' ? 'attention' : 'derived',
            glyph: r.noShow.state === 'recorded' ? '!' : '→'
          }, true));
        }
        pintarCeldaAccionAgenda(tr.children[4], r, confirmada);
        return tr;
      });
      return panel;
    });

    setHidden(byId('agenda-vacio'), anyReservation);
  }

  /**
   * step 26 §6 — vista Día: eje real, una columna por profesional visible
   * (máximo 4 en rejilla; con más, cae a lista cronológica — §6.3), bloques
   * y huecos con la anatomía de la decisión 6.4/6.5.
   */
  function renderAgendaDia(snap, fechaISO, filtro) {
    var profesionales = (snap.calendar.professionals || []).slice().sort(function (a, b) { return a.employeeId - b.employeeId; });
    var visibles = filtro.modo === 'uno' ? profesionales.filter(function (p) { return p.employeeId === filtro.employeeId; }) : profesionales;
    var contenedor = byId('agenda-rejilla');
    setHidden(byId('agenda-fuera-horario'), true);

    if (visibles.length === 0) {
      contenedor.className = 'tx-col-12';
      setHidden(byId('agenda-nota-densidad'), true);
      clearChildren(contenedor);
      contenedor.appendChild(agendaEstadoVacio('No hay ningún profesional en el calendario.', ''));
      return;
    }

    if (visibles.length > 4) {
      // §6.3 — con más de cuatro profesionales visibles, la vista Día cae a
      // lista cronológica en vez de estrechar columnas hasta lo ilegible o
      // añadir un desplazamiento horizontal nuevo (prohibido por M25).
      setHidden(byId('agenda-nota-densidad'), false);
      agendaPintarListaCronologica(contenedor, snap, fechaISO, visibles);
      return;
    }
    setHidden(byId('agenda-nota-densidad'), true);

    var axis = resolveAgendaDayAxis(fechaISO, snap, visibles.map(function (p) { return p.employeeId; }));
    setHidden(byId('agenda-fuera-horario'), !axis.extendida);

    if (!axis.open) {
      contenedor.className = 'tx-col-12';
      clearChildren(contenedor);
      contenedor.appendChild(agendaEstadoVacio('Local cerrado · ' + axis.reasonLabel, ''));
      return;
    }

    contenedor.className = 'tx-col-12 tx-agenda-grid ' + agendaClaseColumnas(visibles.length);
    agendaAjustarRegionDesplazable(contenedor, visibles.length >= 8);
    var itemsGrid = [{ kind: 'eje' }].concat(visibles.map(function (p) { return { kind: 'col', key: 'col:' + String(p.employeeId), employeeId: p.employeeId }; }));
    reconcileList(contenedor, itemsGrid, function (item) { return item.kind === 'eje' ? 'eje' : item.key; }, function (item, existing) {
      if (item.kind === 'eje') return agendaPintarEje(existing, axis);
      var nombre = professionalLabel(item.employeeId);
      var itemsInfo = agendaItemsParaColumna(
        snap, fechaISO, item.employeeId, axis, nombre, 'con ' + nombre,
        agendaIdentidadClase(item.employeeId, profesionales)
      );
      return agendaPintarColumna(existing, item.employeeId, nombre, itemsInfo, null, null);
    });
  }

  /**
   * §6.7/§12 — el reemplazo, EN EL MISMO DOM, de la rejilla por una lista
   * cronológica: sin el rol ARIA de cuadrícula, cero rejilla CSS. Se usa tanto por el
   * corte de ≤1023px (que apaga la rejilla por CSS, ver ui.css.ts) como por
   * el límite explícito de 4 profesionales de la decisión 6.3.
   */
  function agendaPintarListaCronologica(contenedor, snap, fechaISO, profesionalesVisibles) {
    contenedor.className = 'tx-col-12';
    var lista = document.createElement('ol');
    lista.className = 'tx-agenda-semana-resumen';
    var existenteLista = childByClass(contenedor, 'tx-agenda-semana-resumen');
    clearChildren(contenedor);
    contenedor.appendChild(existenteLista || lista);
    var raiz = existenteLista || lista;

    reconcileList(raiz, profesionalesVisibles, function (p) { return 'col:' + String(p.employeeId); }, function (p, existing) {
      var axis = resolveAgendaDayAxis(fechaISO, snap, [p.employeeId]);
      var nombre = professionalLabel(p.employeeId);
      var itemsInfo = agendaItemsParaColumna(snap, fechaISO, p.employeeId, axis, nombre, 'con ' + nombre, agendaIdentidadClase(p.employeeId, snap.calendar.professionals));
      return agendaPintarColumna(existing, p.employeeId, nombre, itemsInfo, null, axis.open ? null : ('Local cerrado · ' + (axis.reasonLabel || '')));
    });
  }

  /**
   * step 26 §5 — vista Semana con un profesional elegido: 7 columnas = 7
   * días, mismo eje y misma anatomía de bloque que la vista Día.
   */
  function renderAgendaSemanaProfesional(snap, fechaISO, employeeId) {
    var contenedor = byId('agenda-rejilla');
    setHidden(byId('agenda-nota-densidad'), true);
    var lunes = mondayOfWeek(fechaISO);
    var dias = [];
    for (var i = 0; i < 7; i += 1) dias.push(addDaysISO(lunes, i));

    var axis = agendaEjeSemana(dias, snap, [employeeId]);
    setHidden(byId('agenda-fuera-horario'), !axis.extendida);
    var identidadClase = agendaIdentidadClase(employeeId, snap.calendar.professionals);

    if (!axis.open) {
      contenedor.className = 'tx-col-12';
      clearChildren(contenedor);
      contenedor.appendChild(agendaEstadoVacio('El local no abre ningún día de esta semana.', ''));
      return;
    }

    // La Semana son SIEMPRE siete columnas (los siete días), pase lo que pase
    // con el número de profesionales: aquí no hay caso de ocho.
    contenedor.className = 'tx-col-12 tx-agenda-grid tx-agenda-grid--cols-7';
    agendaAjustarRegionDesplazable(contenedor, false);
    var itemsGrid = [{ kind: 'eje' }].concat(dias.map(function (d) { return { kind: 'col', key: 'col:' + d, dateISO: d }; }));
    reconcileList(contenedor, itemsGrid, function (item) { return item.kind === 'eje' ? 'eje' : item.key; }, function (item, existing) {
      if (item.kind === 'eje') return agendaPintarEje(existing, axis);
      var venueDay = resolveVenueDay(item.dateISO, snap.calendar);
      var cabecera = capitalizarInicial(WEEKDAYS[dateFromISO(item.dateISO).getDay()]) + ' ' + String(dateFromISO(item.dateISO).getDate());
      var itemsInfo = venueDay.open
        ? agendaItemsParaColumna(snap, item.dateISO, employeeId, axis, cabecera, 'el ' + formatDateLong(item.dateISO), identidadClase)
        : { items: [], canceladas: [], tieneAusencia: false };
      return agendaPintarColumna(existing, item.dateISO, cabecera, itemsInfo, item.dateISO, venueDay.open ? null : ('Local cerrado · ' + venueDay.reasonLabel));
    });
  }

  /**
   * step 26 §5 — vista Semana en \`Todos\`: resumen compacto por día, sin
   * rejilla temporal ni bloques. Un día sin citas nunca se oculta.
   */
  function renderAgendaSemanaResumen(snap, fechaISO) {
    var contenedor = byId('agenda-semana-resumen');
    setHidden(byId('agenda-nota-densidad'), true);
    setHidden(byId('agenda-fuera-horario'), true);
    var lunes = mondayOfWeek(fechaISO);
    var dias = [];
    for (var i = 0; i < 7; i += 1) dias.push(addDaysISO(lunes, i));
    var profesionales = (snap.calendar.professionals || []).slice().sort(function (a, b) { return a.employeeId - b.employeeId; });

    reconcileList(contenedor, dias, function (d) { return d; }, function (dateISO, existingLi) {
      var li = existingLi || (function () {
        var node = document.createElement('li');
        var h3 = document.createElement('h3');
        h3.appendChild(document.createElement('a'));
        node.appendChild(h3);
        node.appendChild(el('p', 'tx-context__note', ''));
        var ul = document.createElement('ul');
        ul.className = 'tx-agenda-semana-resumen__profesionales';
        node.appendChild(ul);
        return node;
      })();
      var venueDay = resolveVenueDay(dateISO, snap.calendar);
      var enlace = li.children[0].children[0];
      enlace.href = agendaHrefPara('dia', dateISO, agendaRouteFiltro);
      enlace.setAttribute('aria-label', 'Ver la agenda del ' + formatDateLong(dateISO));
      setText(enlace, capitalizarInicial(formatDateLong(dateISO)));
      setText(li.children[1], venueDay.open ? ('Horario del local: ' + venueDay.start + ' – ' + venueDay.end) : ('Local cerrado · ' + venueDay.reasonLabel));

      reconcileList(li.children[2], profesionales, function (p) { return String(p.employeeId); }, function (p, existingItem) {
        var item = existingItem || document.createElement('li');
        var citas = snap.calendar.reservations.filter(function (r) { return r.date === dateISO && r.employeeId === p.employeeId && r.status === 'confirmed'; })
          .sort(function (a, b) { return a.startMinutes - b.startMinutes; });
        clearChildren(item);
        var a = document.createElement('a');
        a.href = agendaHrefPara('dia', dateISO, 'p' + String(p.employeeId));
        var resumen = citas.length === 0
          ? (professionalLabel(p.employeeId) + ' · Sin citas')
          : (professionalLabel(p.employeeId) + ' · ' + String(citas.length) + (citas.length === 1 ? ' cita' : ' citas') +
            ' · ' + formatMinutes(citas[0].startMinutes) + '–' + formatMinutes(citas[citas.length - 1].endMinutes));
        a.textContent = resumen;
        a.setAttribute('aria-label', 'Ver la agenda del ' + formatDateLong(dateISO) + ' de ' + professionalLabel(p.employeeId));
        item.appendChild(a);
        return item;
      });
      return li;
    });
  }

  /**
   * step 26 REAPERTURA §R3 — las marcas de ausencia de una celda mensual,
   * con su TOPE DE SATURACIÓN. Con más de tres ausencias no se pintan cuatro
   * rombos: se pintan los DOS primeros y un tercero que dice \`◆ +N más\`
   * (N = total − 2). Motivo: una celda de 31 días con cinco rombos deja de
   * ser legible a 1024 px y a zoom 200 % desborda. El detalle completo se lee
   * en la vista Día, y ningún nombre accesible cambia por esto.
   *
   * Una sola implementación para las DOS rejillas mensuales (Agenda › Mes y
   * Horarios y ausencias): el tope no puede decir cosas distintas según la
   * pantalla. Cada marca lleva SIEMPRE texto además de forma y color.
   */
  function pintarMarcasDeAusencia(marks, dayAbsences) {
    var TOPE = 3;
    var visibles = dayAbsences.length > TOPE ? dayAbsences.slice(0, TOPE - 1) : dayAbsences;
    visibles.forEach(function (a) {
      marks.appendChild(el('span', 'tx-mark--absence', '◆ ' + professionalLabel(a.employeeId).charAt(0)));
    });
    if (dayAbsences.length > TOPE) {
      marks.appendChild(el('span', 'tx-mark--absence', '◆ +' + String(dayAbsences.length - (TOPE - 1)) + ' más'));
    }
  }

  /**
   * step 26 §7 — vista Mes: rejilla de RESUMEN (reutiliza \`.tx-month-grid\`
   * / \`.tx-day-cell*\`, decisión 7). Ninguna cita completa dentro de la
   * celda; activar el día entero abre \`#/agenda/dia/<fecha>/<filtro>\`.
   */
  function renderAgendaMes(snap, fechaISO, filtro) {
    setHidden(byId('agenda-nota-densidad'), true);
    setHidden(byId('agenda-fuera-horario'), true);
    var partes = fechaISO.split('-');
    var year = Number(partes[0]);
    var month = Number(partes[1]);
    var contenedor = byId('agenda-mes');

    var tabla = childByClass(contenedor, 'tx-month-grid');
    if (!tabla) {
      clearChildren(contenedor);
      var scroll = el('div', 'tx-table-scroll');
      scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', 'Rejilla del mes de la agenda');
      tabla = document.createElement('table');
      tabla.className = 'tx-month-grid';
      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'].forEach(function (abbr) {
        var th = document.createElement('th');
        th.scope = 'col';
        th.textContent = abbr;
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      tabla.appendChild(thead);
      tabla.appendChild(document.createElement('tbody'));
      scroll.appendChild(tabla);
      contenedor.appendChild(scroll);
    }
    var tbody = tabla.children[1];

    var weeks = monthMatrix(year, month);
    reconcileList(tbody, weeks, function (_w, idx) { return idx; }, function (week, existingTr) {
      var tr = existingTr || (function () {
        var row = document.createElement('tr');
        for (var i = 0; i < 7; i += 1) row.appendChild(document.createElement('td'));
        return row;
      })();
      week.forEach(function (dateISO, colIdx) {
        var td = tr.children[colIdx];
        clearChildren(td);
        if (!dateISO) {
          td.className = 'tx-day-cell tx-day-cell--outside';
          td.setAttribute('aria-hidden', 'true');
          return;
        }
        var venueDay = resolveVenueDay(dateISO, snap.calendar);
        var isToday = dateISO === snap.engineToday;
        var dayAbsences = absencesOn(snap.calendar, dateISO);
        var citas = snap.calendar.reservations.filter(function (r) {
          return r.date === dateISO && r.status === 'confirmed' && (filtro.modo !== 'uno' || r.employeeId === filtro.employeeId);
        });
        td.className = 'tx-day-cell' + (isToday ? ' tx-day-cell--today' : '') + (!venueDay.open ? ' tx-day-cell--closed' : '');

        // Decisión 7: SÓLO el número de día (envuelto en el enlace) es
        // accionable; ninguna otra acción de calendario vive en esta vista.
        var enlace = document.createElement('a');
        enlace.className = 'tx-day-cell__link';
        enlace.href = agendaHrefPara('dia', dateISO, agendaRouteFiltro);
        enlace.setAttribute('aria-label', 'Ver la agenda del ' + formatDateLong(dateISO) + ' · ' +
          String(citas.length) + (citas.length === 1 ? ' cita' : ' citas'));
        var numberLine = el('span', 'tx-day-cell__number', String(Number(dateISO.slice(8, 10))));
        if (isToday) numberLine.appendChild(el('span', 'tx-day-cell__today', 'Hoy'));
        enlace.appendChild(numberLine);
        td.appendChild(enlace);

        td.appendChild(el('span', 'tx-day-cell__hours', venueDay.open ? (venueDay.start + '–' + venueDay.end) : 'Cerrado'));
        var marks = el('span', 'tx-day-cell__marks');
        if (venueDay.isHoliday || venueDay.isSpecial) marks.appendChild(el('span', 'tx-mark--holiday', '▲ ' + (venueDay.isHoliday ? 'Festivo' : 'Especial')));
        pintarMarcasDeAusencia(marks, dayAbsences);
        td.appendChild(marks);
        td.appendChild(el('span', 'tx-day-cell__citas', String(citas.length) + (citas.length === 1 ? ' cita' : ' citas')));
      });
      return tr;
    });
  }

  /** step 26 §9/§10 — el título en castellano del intervalo que muestra cada vista. */
  function agendaTituloRango(vista, fechaISO, snap) {
    if (vista === 'semana') {
      var lunes = mondayOfWeek(fechaISO);
      return capitalizarInicial('Semana del ' + formatDateRangeLong(lunes, addDaysISO(lunes, 6)).replace(/^del /, '') + ' de ' + String(dateFromISO(addDaysISO(lunes, 6)).getFullYear()));
    }
    if (vista === 'mes') {
      var partes = fechaISO.split('-');
      return capitalizarInicial(MONTHS[Number(partes[1]) - 1] + ' de ' + partes[0]);
    }
    if (vista === 'lista') {
      var fin = addDaysISO(fechaISO, 6);
      return capitalizarInicial(formatDateRangeLong(fechaISO, fin) + ' de ' + String(dateFromISO(fin).getFullYear()));
    }
    return capitalizarInicial(formatDateLong(fechaISO));
  }

  /** Lee el filtro de profesional del hash contra el snapshot ACTUAL; un \`employeeId\` que ya no existe se trata como \`todos\` (§9). */
  function agendaFiltroEfectivo(snap) {
    if (agendaRouteFiltro === 'todos') return { modo: 'todos', employeeId: null, invalido: false };
    var m = /^p(\\d+)$/.exec(agendaRouteFiltro);
    if (!m) return { modo: 'todos', employeeId: null, invalido: false };
    var id = Number(m[1]);
    var existe = (snap.calendar.professionals || []).some(function (p) { return p.employeeId === id; });
    return existe ? { modo: 'uno', employeeId: id, invalido: false } : { modo: 'todos', employeeId: null, invalido: true };
  }

  /**
   * step 26 — el DESPACHADOR de Agenda: lee la vista/fecha/filtro que
   * \`applyRoute()\` ya dejó en las variables de módulo, y pinta EXACTAMENTE
   * una de las cuatro vistas. El sondeo de 2 s llama a esta misma función a
   * través de \`renderActiveSection()\`, así que TODO lo de aquí abajo sigue
   * las siete reglas de pintado bajo sondeo de la decisión 11: nada de
   * \`aria-live\` nuevo, \`setText\`/\`reconcileList\` en vez de reescribir, y
   * ningún movimiento de foco (eso lo hace sólo \`applyRoute\`).
   */
  function renderAgenda(snap) {
    ensureProfessionalOptions(byId('agenda-filtro-profesional'), snap.calendar.professionals, 'Todos');
    // (step 19 §3.8, punto 2) La ÚNICA otra escritura del sondeo sobre el
    // panel del explorador: rellenar '#huecos-profesional', bajo la MISMA
    // guarda de igualdad que ya usa el filtro de arriba. Con la etiqueta
    // puesta como tercer argumento (nunca null, hallazgo A1), la opción
    // vacía "Elige a quién" la mantiene la propia función y nunca desaparece
    // en el primer repintado.
    ensureProfessionalOptions(byId('huecos-profesional'), snap.calendar.professionals, 'Elige a quién');
    actualizarDesfaseHuecos(snap);

    // Guarda de compatibilidad: unas pocas pruebas de pantallas ANTERIORES a
    // step 26 llaman a renderAgenda(snap) directamente, sin pasar por
    // applyRoute() y con un documento mínimo que nunca siembra el selector
    // de vista nuevo. Sin ese selector no hay ruta que despachar — se cae al
    // comportamiento de "Lista" con la fecha ancla de hoy y todos los
    // profesionales, que es exactamente lo único que esas pruebas miran. El
    // HTML real de la consola siempre trae \`#agenda-vista-dia\`.
    if (!byId('agenda-vista-dia')) {
      renderAgendaLista(snap, snap.engineToday, { modo: 'todos', employeeId: null });
      return;
    }

    var vista = agendaRouteVista;
    var fecha = agendaFechaEfectiva(agendaRouteFecha, snap);
    var filtro = agendaFiltroEfectivo(snap);

    // El <select> de filtro sigue el mismo patrón de guarda de foco que
    // \`ensureProfessionalOptions\`: nunca se toca mientras el operador lo
    // tiene abierto.
    var selectFiltro = byId('agenda-filtro-profesional');
    if (document.activeElement !== selectFiltro) {
      var valorDeseado = filtro.modo === 'uno' ? String(filtro.employeeId) : '';
      if (selectFiltro.value !== valorDeseado) selectFiltro.value = valorDeseado;
    }

    AGENDA_VISTAS.forEach(function (v) {
      var boton = byId('agenda-vista-' + v);
      var deseado = String(v === vista);
      if (boton.getAttribute('aria-pressed') !== deseado) boton.setAttribute('aria-pressed', deseado);
    });

    var mostrarAviso = agendaRutaCorregida || filtro.invalido;
    setHidden(byId('agenda-aviso-ruta'), !mostrarAviso);

    setText(byId('agenda-titulo-rango'), agendaTituloRango(vista, fecha, snap));

    setHidden(byId('agenda-rejilla'), vista !== 'dia' && vista !== 'semana');
    setHidden(byId('agenda-semana-resumen'), true);
    setHidden(byId('agenda-mes'), vista !== 'mes');
    setHidden(byId('agenda-dias'), vista !== 'lista');
    if (vista !== 'lista') setHidden(byId('agenda-vacio'), true);

    if (vista === 'dia') {
      renderAgendaDia(snap, fecha, filtro);
    } else if (vista === 'semana') {
      if (filtro.modo === 'uno') {
        renderAgendaSemanaProfesional(snap, fecha, filtro.employeeId);
      } else {
        setHidden(byId('agenda-rejilla'), true);
        setHidden(byId('agenda-semana-resumen'), false);
        renderAgendaSemanaResumen(snap, fecha);
      }
    } else if (vista === 'mes') {
      renderAgendaMes(snap, fecha, filtro);
    } else {
      renderAgendaLista(snap, fecha, filtro);
    }
  }

  // =====================================================================
  // step 26 §6.6 — DETALLE DE UNA CITA, abierto al activar un bloque de la
  // rejilla de Agenda. Reutiliza LOS MISMOS \`abrirDialogo*\` que ya usa la
  // vista Lista (\`pintarCeldaAccionAgenda\`): ninguna acción se implementa
  // dos veces (decisión 10).
  // =====================================================================

  /** Quién abrió el diálogo de detalle — el botón del BLOQUE original, no el de "Cerrar" de un diálogo anidado (para que el foco vuelva ahí al final de la cadena). */
  var citaDetalleState = { disparadorOriginal: null };

  function pintarAccionesCitaDetalle(container, r, confirmada) {
    clearChildren(container);
    var cuando = 'la cita de las ' + formatMinutes(r.startMinutes) + ' con ' + professionalLabel(r.employeeId);
    var origen = citaDetalleState.disparadorOriginal;

    var cancelar = el('button', 'tx-btn tx-btn--secondary', 'Cancelar cita');
    cancelar.type = 'button';
    setHidden(cancelar, !confirmada);
    cancelar.setAttribute('aria-label', 'Cancelar ' + cuando);
    cancelar.onclick = function () { byId('dialogo-cita-detalle').close(); abrirDialogoCancelarCita(r, origen); };
    container.appendChild(cancelar);

    if (r.eligibleForNoShow && !r.noShow) {
      var registrar = el('button', 'tx-btn tx-btn--secondary', 'Registrar inasistencia');
      registrar.type = 'button';
      registrar.setAttribute('aria-label', 'Registrar la inasistencia de ' + cuando);
      registrar.onclick = function () { byId('dialogo-cita-detalle').close(); abrirDialogoInasistencia(r, origen); };
      container.appendChild(registrar);
    }

    if (r.noShow && r.noShow.state === 'recorded') {
      var corregir = el('button', 'tx-btn tx-btn--secondary', 'Corregir registro');
      corregir.type = 'button';
      corregir.setAttribute('aria-label', 'Corregir el registro de inasistencia de ' + cuando);
      corregir.onclick = function () { byId('dialogo-cita-detalle').close(); abrirDialogoCorregirInasistencia(r, origen); };
      container.appendChild(corregir);
    }
  }

  function abrirDialogoCitaDetalle(reserva, disparador) {
    citaDetalleState.disparadorOriginal = disparador;
    var confirmada = reserva.status === 'confirmed';
    setText(byId('cita-detalle-cuando'), formatDateLong(reserva.date) + ', ' + formatMinutes(reserva.startMinutes) + ' – ' + formatMinutes(reserva.endMinutes));
    setText(byId('cita-detalle-servicio'), serviceLabel(reserva.serviceId));
    setText(byId('cita-detalle-profesional'), professionalLabel(reserva.employeeId));

    var pillHost = byId('cita-detalle-pill');
    clearChildren(pillHost);
    pillHost.appendChild(buildPillEl(confirmada ? STATUS_VOCAB.BOOKING_CONFIRMED : PILL_CITA_CANCELADA));
    if (reserva.noShow) {
      pillHost.appendChild(buildPillEl({
        label: reserva.noShow.stateLabel,
        modifier: reserva.noShow.state === 'recorded' ? 'attention' : 'derived',
        glyph: reserva.noShow.state === 'recorded' ? '!' : '→'
      }, true));
    }

    var origenTexto = '';
    if (reserva.manual) origenTexto = reserva.manual.originLabel + ' · ' + reserva.manual.clientLabel;
    else if (reserva.originatedFromWaitlistEntryId) origenTexto = 'Creada desde la lista de espera';
    setText(byId('cita-detalle-origen'), origenTexto);
    setHidden(byId('cita-detalle-origen'), !origenTexto);

    var grupoEl = byId('cita-detalle-grupo');
    if (reserva.group) {
      setText(grupoEl, 'Parte de una reserva para varias personas · ' + reserva.group.groupLabel + ' · ' + reserva.group.memberLabel + ' · cita ' + reserva.group.positionLabel);
      setHidden(grupoEl, false);
    } else {
      setHidden(grupoEl, true);
    }

    // Detalle técnico plegado (Adenda B: ningún identificador es el mensaje principal).
    var tecnico = byId('cita-detalle-tecnico');
    clearChildren(tecnico);
    [['Identificador', reserva.id], ['Estado', reserva.status]].forEach(function (par) {
      tecnico.appendChild(el('dt', '', par[0]));
      tecnico.appendChild(el('dd', '', String(par[1])));
    });

    pintarAccionesCitaDetalle(byId('cita-detalle-acciones'), reserva, confirmada);
    abrirDialogo('dialogo-cita-detalle', 'dialogo-cita-detalle-titulo', disparador);
  }

  function wireCitaDetalleDialog() {
    wireFocoDialogo('dialogo-cita-detalle');
    byId('cita-detalle-cerrar').addEventListener('click', function () { byId('dialogo-cita-detalle').close(); });
  }

  /**
   * step 26 §6.6 — activar un HUECO abre el asistente \`Crear cita manual\`
   * con precarga de fecha/inicio/profesional, y deja al operador en el
   * paso 1. JAMÁS confirma ni reserva por su cuenta: el servidor revalida
   * todo, como siempre, cuando el operador llegue al paso 5.
   */
  function abrirCitaManualDesdeHueco(fechaISO, startMinutes, employeeId, disparador) {
    abrirDialogoCitaManual(disparador, { fechaISO: fechaISO, startMinutes: startMinutes, employeeId: employeeId });
  }

  // ---------------------------------------------------------------------
  // EXPLORADOR DE HUECOS SINTÉTICOS (step 19 Capacidad 1, §3)
  //
  // Panel en línea, ANTES de '#agenda-dias' (ui.html.ts). Es una CONSULTA:
  // no hay botón de reservar, no hay ruta de escritura y una consulta no
  // emite ningún evento. Nada se preselecciona (I3): el servicio, "a quién"
  // y "cuándo" nacen vacíos, y el botón permanece apagado hasta que las tres
  // elecciones estén hechas.
  //
  // §3.8, punto 1: el sondeo de 2 s NO toca este panel — ni los campos, ni
  // los resultados, ni los mensajes — salvo la única excepción de
  // 'ensureProfessionalOptions' ya wireada dentro de renderAgenda(), arriba,
  // y la comparación de desfase de 'actualizarDesfaseHuecos'. Ninguna otra
  // función de este bloque se llama nunca desde el sondeo.
  // ---------------------------------------------------------------------

  // 'aQuien'/'cuando' se guardan en estado de JS, escritos por el 'change'
  // de cada radio (\`ev.target.value\`) — la MISMA técnica que ya usa
  // \`grupoState.forma\` (más abajo, \`grupo-forma-consecutivas\`/
  // \`-simultaneas\`) para un grupo de radios sin nombre consultable por
  // \`document.querySelector\`. Nunca se lee \`:checked\` por selector.
  var huecosState = { ultimaVista: null, aQuien: '', cuando: '' };

  function huecosFormValues() {
    return {
      servicio: byId('huecos-servicio').value,
      aQuien: huecosState.aQuien,
      quien: byId('huecos-profesional').value,
      cuando: huecosState.cuando,
      dia: byId('huecos-fecha').value,
      desde: byId('huecos-desde').value,
      hasta: byId('huecos-hasta').value
    };
  }

  /** Qué le falta a la consulta para poder pulsar el botón, en castellano llano (§3.3, §8.2). */
  function huecosCamposFaltantes(v) {
    var falta = [];
    if (!v.servicio) falta.push('elegir el servicio');
    if (!v.aQuien || (v.aQuien === 'one' && !v.quien)) falta.push('decir a quién');
    var fechaFalta = !v.cuando || (v.cuando === 'dia' && !v.dia) || (v.cuando === 'rango' && (!v.desde || !v.hasta));
    if (fechaFalta) falta.push('la fecha');
    return falta;
  }

  function textoDePuertaHuecos(falta) {
    if (falta.length === 0) return '';
    if (falta.length === 3) {
      return 'El botón no se activa hasta que elijas el servicio, a quién quieres y las fechas. No se rellena nada solo.';
    }
    if (falta.length === 1) return 'Falta ' + falta[0] + '.';
    return 'Falta ' + falta.slice(0, -1).join(', ') + ' y ' + falta[falta.length - 1] + '.';
  }

  /** Muestra sólo los campos que aplican a la elección actual — nunca rellena ninguno solo. */
  function actualizarVisibilidadCamposHuecos(v) {
    setHidden(byId('huecos-profesional-campo'), v.aQuien !== 'one');
    setHidden(byId('huecos-dia-campo'), v.cuando !== 'dia');
    setHidden(byId('huecos-desde-campo'), v.cuando !== 'rango');
    setHidden(byId('huecos-hasta-campo'), v.cuando !== 'rango');
  }

  function actualizarPuertaHuecos() {
    var v = huecosFormValues();
    actualizarVisibilidadCamposHuecos(v);
    var falta = huecosCamposFaltantes(v);
    setEstadoLinea(byId('huecos-gate'), textoDePuertaHuecos(falta), '');
    byId('huecos-comprobar').disabled = falta.length > 0;
  }

  function huecosDetalleTecnico(slot) {
    var lineas = [slot.technical.employeeIdLabel, slot.technical.serviceIdLabel, slot.technical.appliedLevelLabel];
    if (slot.technical.anyProfessionalLabel) lineas.push(slot.technical.anyProfessionalLabel);
    if (slot.technical.anyProfessionalExplainerLabel) lineas.push(slot.technical.anyProfessionalExplainerLabel);
    return lineas;
  }

  function buildHuecoResultCard(slot, existing) {
    var card = existing || (function () {
      var node = el('article', 'tx-slot-card');
      node.appendChild(el('h3', '', ''));
      node.appendChild(el('p', 'tx-slot-card__lead', ''));
      node.appendChild(el('p', '', ''));
      node.appendChild(el('p', 'tx-context__note', ''));
      var det = document.createElement('details');
      det.className = 'tx-details';
      det.appendChild(el('summary', '', 'Detalle técnico'));
      var body = el('div', 'tx-details__body');
      det.appendChild(body);
      node.appendChild(det);
      return node;
    })();
    setText(card.children[0], slot.dateLabel + ' · ' + slot.timeRangeLabel);
    setText(card.children[1], slot.serviceLabel + ' · ' + slot.professionalLabel);
    setText(card.children[2], slot.whyLabel);
    setHidden(card.children[3], !slot.anyProfessionalNote);
    setText(card.children[3], slot.anyProfessionalNote || '');
    var det = card.children[4];
    var body = childByClass(det, 'tx-details__body');
    if (!body) { body = el('div', 'tx-details__body'); det.appendChild(body); }
    var lineas = huecosDetalleTecnico(slot);
    reconcileList(body, lineas, function (linea, indice) { return String(indice); }, function (linea, existingP) {
      var p = existingP || el('p', '', '');
      setText(p, linea);
      return p;
    });
    return card;
  }

  function pintarResultadosHuecos(vista) {
    setHidden(byId('huecos-resultados-bloque'), false);
    setText(byId('huecos-recuento'), vista.totalLabel);
    setText(byId('huecos-orden'), vista.orderNote);
    setText(byId('huecos-sintetico'), vista.syntheticNote);
    setHidden(byId('huecos-desfase'), true);

    setHidden(byId('huecos-vacio'), vista.emptyLabel === null);
    setText(byId('huecos-vacio'), vista.emptyLabel || '');
    setHidden(byId('huecos-nota-incapacidad'), vista.noteLabel === null);
    setText(byId('huecos-nota-incapacidad'), vista.noteLabel || '');

    var motivos = vista.days.filter(function (d) { return !d.considered; });
    setHidden(byId('huecos-motivos-dias'), motivos.length === 0);
    reconcileList(byId('huecos-motivos-dias'), motivos, function (d) { return d.dateISO; }, function (d, existing) {
      var li = existing || document.createElement('li');
      li.textContent = d.notConsideredLabel || '';
      return li;
    });

    reconcileList(byId('huecos-resultados'), vista.slots, function (s) { return s.key; }, buildHuecoResultCard);
  }

  /** Los tres escalares que dicen si el mundo se ha movido desde la última consulta (§3.8.5). Nunca una regla de negocio: sólo una igualdad. */
  function huecosComputedAtActual(snap) {
    // 'snap.calendar.reservations' es la MISMA fuente que usa el servidor
    // para 'computedAt.confirmedReservationCount' (cal.reservations,
    // availabilityExplorer.ts): 'snap.reservations' (a secas) es la copia del
    // ALMACÉN de reservas escritas por una llamada, no la del calendario de
    // trabajo, y empieza vacía en esta demostración.
    return {
      engineToday: snap.engineToday,
      engineNowMinutes: snap.engineNowMinutes,
      confirmedReservationCount: snap.calendar.reservations.filter(function (r) { return r.status === 'confirmed'; }).length
    };
  }

  function actualizarDesfaseHuecos(snap) {
    if (!huecosState.ultimaVista) return;
    var actual = huecosComputedAtActual(snap);
    var previo = huecosState.ultimaVista.computedAt;
    var cambiado = actual.engineToday !== previo.engineToday ||
      actual.engineNowMinutes !== previo.engineNowMinutes ||
      actual.confirmedReservationCount !== previo.confirmedReservationCount;
    setHidden(byId('huecos-desfase'), !cambiado);
  }

  function comprobarHuecos() {
    if (byId('huecos-comprobar').disabled) return undefined;
    limpiarLinea(byId('huecos-error'));
    var v = huecosFormValues();
    var params = [];
    params.push('serviceId=' + encodeURIComponent(v.servicio));
    params.push('mode=' + encodeURIComponent(v.aQuien));
    if (v.aQuien === 'one') params.push('employeeId=' + encodeURIComponent(v.quien));
    if (v.cuando === 'dia') {
      params.push('from=' + encodeURIComponent(v.dia));
      params.push('to=' + encodeURIComponent(v.dia));
    } else {
      params.push('from=' + encodeURIComponent(v.desde));
      params.push('to=' + encodeURIComponent(v.hasta));
    }
    // Se DEVUELVE la promesa (no queda "flotando") para que quien dispara la
    // consulta pueda esperar a que termine antes de comprobar el resultado —
    // exactamente igual que 'confirmarGrupo()' y 'avanzarElReloj()' más abajo.
    return fetch('/api/availability/explore?' + params.join('&'), { method: 'GET' }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, json: json }; });
    }).then(function (r) {
      if (!r.ok) {
        setEstadoLinea(byId('huecos-error'), (r.json && r.json.error) || 'La consulta no es válida. Vuelve a elegir el servicio, a quién y las fechas.', 'error');
        return;
      }
      huecosState.ultimaVista = r.json;
      pintarResultadosHuecos(r.json);
      var titulo = byId('huecos-resultados-titulo');
      if (titulo && titulo.focus) titulo.focus({ preventScroll: true });
    }).catch(function () {
      setEstadoLinea(byId('huecos-error'), 'No hay conexión con el motor.', 'error');
    });
  }

  /** El reinicio SÍ vacía este panel (§3.8, punto 10; §7.1, I8): los campos del formulario NO se tocan. */
  function limpiarExploradorHuecos() {
    huecosState.ultimaVista = null;
    clearChildren(byId('huecos-resultados'));
    clearChildren(byId('huecos-motivos-dias'));
    setHidden(byId('huecos-motivos-dias'), true);
    setHidden(byId('huecos-resultados-bloque'), true);
    setHidden(byId('huecos-desfase'), true);
    setHidden(byId('huecos-vacio'), true);
    setText(byId('huecos-vacio'), '');
    setHidden(byId('huecos-nota-incapacidad'), true);
    setText(byId('huecos-nota-incapacidad'), '');
    actualizarPuertaHuecos();
  }

  function wireHuecosControls() {
    byId('huecos-servicio').addEventListener('change', actualizarPuertaHuecos);
    byId('huecos-profesional').addEventListener('change', actualizarPuertaHuecos);
    byId('huecos-fecha').addEventListener('change', actualizarPuertaHuecos);
    byId('huecos-desde').addEventListener('change', actualizarPuertaHuecos);
    byId('huecos-hasta').addEventListener('change', actualizarPuertaHuecos);
    ['huecos-a-quien-una', 'huecos-a-quien-cualquiera'].forEach(function (id) {
      byId(id).addEventListener('change', function (ev) {
        huecosState.aQuien = ev.target.value;
        actualizarPuertaHuecos();
      });
    });
    ['huecos-cuando-dia', 'huecos-cuando-rango'].forEach(function (id) {
      byId(id).addEventListener('change', function (ev) {
        huecosState.cuando = ev.target.value;
        actualizarPuertaHuecos();
      });
    });
    byId('huecos-comprobar').addEventListener('click', comprobarHuecos);
    actualizarPuertaHuecos();
  }

  // ---------------------------------------------------------------------
  // LLAMADAS
  // ---------------------------------------------------------------------

  var llamadasFilter = 'todas';

  function wireLlamadasControls() {
    Array.prototype.forEach.call(document.querySelectorAll('#vista-llamadas .tx-filter'), function (btn) {
      btn.addEventListener('click', function () {
        llamadasFilter = btn.getAttribute('data-filter');
        Array.prototype.forEach.call(document.querySelectorAll('#vista-llamadas .tx-filter'), function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        renderActiveSection();
      });
    });
    byId('llamada-detalle-cerrar').addEventListener('click', closeCallDetail);
    byId('llamada-copiar-hash').addEventListener('click', function () {
      var hash = byId('llamada-copiar-hash').getAttribute('data-hash') || '';
      var statusEl = byId('llamada-copiar-estado');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(hash).then(function () {
          setEstadoLinea(statusEl, 'Copiado', 'ok');
        }).catch(function () {
          setEstadoLinea(statusEl, 'No se ha podido copiar.', 'error');
        });
      } else {
        setEstadoLinea(statusEl, 'No se ha podido copiar.', 'error');
      }
    });
  }

  function callMatchesFilter(snap, call, filter) {
    if (filter === 'todas') return true;
    if (filter === 'atencion') return callAttentionEntry(call, snap) !== null || call.outcome === 'RECHAZA';
    if (filter === 'reserva') return call.countsAsBookingConversion === true;
    if (filter === 'derivadas') return call.outcome === 'DERIVA' && call.internalReasonCode !== 'BOOKING_NOT_CONFIRMED' && call.internalReasonCode !== 'TECHNICAL_FAILURE';
    if (filter === 'error') return call.internalReasonCode === 'TECHNICAL_FAILURE';
    return true;
  }

  function renderLlamadas(snap) {
    var all = snap.calls.slice().sort(function (a, b) { return b.startedAtISO.localeCompare(a.startedAtISO); });
    var counts = { todas: all.length, atencion: 0, reserva: 0, derivadas: 0, error: 0 };
    all.forEach(function (c) {
      if (callMatchesFilter(snap, c, 'atencion')) counts.atencion += 1;
      if (callMatchesFilter(snap, c, 'reserva')) counts.reserva += 1;
      if (callMatchesFilter(snap, c, 'derivadas')) counts.derivadas += 1;
      if (callMatchesFilter(snap, c, 'error')) counts.error += 1;
    });
    byId('filtro-todas-n').textContent = '(' + String(counts.todas) + ')';
    byId('filtro-atencion-n').textContent = '(' + String(counts.atencion) + ')';
    byId('filtro-reserva-n').textContent = '(' + String(counts.reserva) + ')';
    byId('filtro-derivadas-n').textContent = '(' + String(counts.derivadas) + ')';
    byId('filtro-error-n').textContent = '(' + String(counts.error) + ')';

    var filtered = all.filter(function (c) { return callMatchesFilter(snap, c, llamadasFilter); });
    setHidden(byId('llamadas-vacio'), all.length > 0);
    setHidden(byId('llamadas-vacio-filtro'), !(all.length > 0 && filtered.length === 0));

    reconcileList(byId('llamadas-tbody'), filtered, function (c) { return c.callIdHash; }, function (call, existingTr) {
      var tr = existingTr || (function () {
        var row = document.createElement('tr');
        for (var i = 0; i < 4; i += 1) row.appendChild(document.createElement('td'));
        var tdLink = document.createElement('td');
        var a = el('a', 'tx-row-link', 'Ver');
        tdLink.appendChild(a);
        row.appendChild(tdLink);
        return row;
      })();
      tr.className = openCallHash === call.callIdHash ? 'tx-table__row--selected' : '';
      tr.children[0].textContent = formatTimeFromISO(call.startedAtISO);
      tr.children[0].setAttribute('data-label', 'Hora');
      tr.children[1].textContent = intentLabel(call);
      tr.children[1].setAttribute('data-label', 'Qué pedía');
      clearChildren(tr.children[2]);
      tr.children[2].setAttribute('data-label', 'Resultado');
      var status = statusFor(call);
      if (status) tr.children[2].appendChild(buildPillEl(status));
      tr.children[3].textContent = actionFor(snap, call);
      tr.children[3].setAttribute('data-label', 'Qué hay que hacer');
      var link = tr.children[4].querySelector('a');
      link.href = '#/llamadas/' + call.callIdHash;
      // D3: marca estable para devolverle el foco al cerrar el detalle. No se
      // usa el href porque en un navegador \`a.href\` devuelve la URL absoluta
      // ya resuelta, no el "#/llamadas/<hash>" que se escribió aquí.
      link.setAttribute('data-call-hash', call.callIdHash);
      link.setAttribute('aria-label', 'Ver el detalle de la llamada de las ' + formatTimeFromISO(call.startedAtISO));
      return tr;
    });

    renderCallDetail(snap);
  }

  function renderCallDetail(snap) {
    var panel = byId('llamada-detalle');
    if (!openCallHash) {
      // step 15: ahora que \`hidden\` de verdad esconde este panel, el botón
      // "Cerrar" que acaba de pulsarse desaparece con él. Si el foco seguía
      // dentro, se caería al <body> y quien navega con teclado perdería el
      // sitio. Se lleva al título de la vista, que ya existe para esto
      // (\`tabindex="-1"\`) y es donde el enrutador deja el foco al cambiar de
      // sección.
      if (panel.contains(document.activeElement)) {
        var viewTitle = byId('tx-view-title');
        if (viewTitle && viewTitle.focus) viewTitle.focus({ preventScroll: true });
      }
      setHidden(panel, true);
      copyStatusShownForCallHash = null;
      return;
    }
    var call = null;
    for (var i = 0; i < snap.calls.length; i += 1) {
      if (snap.calls[i].callIdHash === openCallHash) { call = snap.calls[i]; break; }
    }
    if (!call) {
      setHidden(panel, false);
      byId('llamada-detalle-titulo').textContent = 'Esa llamada ya no está en la demostración.';
      clearChildren(byId('llamada-detalle-pill'));
      setHidden(byId('llamada-detalle-orfana'), true);
      byId('llamada-detalle-que-paso').textContent = 'Puede que se haya reiniciado.';
      byId('llamada-detalle-intencion').textContent = '—';
      byId('llamada-detalle-anuncia').textContent = '—';
      clearChildren(byId('llamada-detalle-tecnico'));
      if (copyStatusShownForCallHash !== openCallHash) limpiarLinea(byId('llamada-copiar-estado'));
      copyStatusShownForCallHash = openCallHash;
      return;
    }
    setHidden(panel, false);
    var status = statusFor(call);
    byId('llamada-detalle-titulo').textContent = 'Llamada de las ' + formatTimeFromISO(call.startedAtISO);
    var pillHolder = byId('llamada-detalle-pill');
    clearChildren(pillHolder);
    if (status) pillHolder.appendChild(buildPillEl(status));

    var orphanTask = findTask(snap, call.callIdHash, 'REVIEW_ORPHANED_SYNTHETIC_RESERVATION');
    var orphanEl = byId('llamada-detalle-orfana');
    if (orphanTask) {
      setHidden(orphanEl, false);
      // B2 (revisión step 15): el aviso se reconstruye entero y lleva dentro
      // el enlace "Ver la cita en la agenda". Misma regla dura que arriba: si
      // el foco vive aquí, el sondeo no lo destruye.
      if (!holdsFocus(orphanEl)) {
        clearChildren(orphanEl);
        orphanEl.appendChild(el('p', '', 'Se escribió una reserva sintética antes del fallo. Hay que comprobar si esa cita sigue siendo válida.'));
        var reservation = findReservationForCall(snap, call.callIdHash);
        if (reservation) {
          orphanEl.appendChild(el('p', '', 'Reserva: ' + formatDateLong(reservation.date) + ', ' + formatMinutes(reservation.startMinutes) + ', ' + serviceLabel(reservation.serviceId) + ', ' + professionalLabel(reservation.employeeId)));
          var agendaLink = el('a', 'tx-btn tx-btn--secondary', 'Ver la cita en la agenda');
          agendaLink.href = '#/agenda';
          orphanEl.appendChild(agendaLink);
        }
      }
    } else {
      setHidden(orphanEl, true);
    }

    byId('llamada-detalle-que-paso').textContent = status ? (QUE_PASO[status.label] || '') : 'Esta llamada todavía no tiene un resultado.';
    byId('llamada-detalle-intencion').textContent = intentLabel(call);
    byId('llamada-detalle-anuncia').textContent = call.announcesSuccess === undefined ? '—' : (call.announcesSuccess ? 'Sí' : 'No');

    var dl = byId('llamada-detalle-tecnico');
    var rows = [
      ['Identificador de llamada (hash)', call.callIdHash],
      ['Escenario', call.scenarioId],
      ['Resultado (outcome)', call.outcome || '—'],
      ['Código congelado (reasonCode)', call.reasonCode || '—'],
      ['Código interno', call.internalReasonCode || '—'],
      ['Cuenta como no entendida', call.countsAsNotUnderstood === undefined ? '—' : (call.countsAsNotUnderstood ? 'Sí' : 'No')],
      ['Cuenta como reserva', call.countsAsBookingConversion === undefined ? '—' : (call.countsAsBookingConversion ? 'Sí' : 'No')],
      ['Cuenta como contenida', call.countsAsContained === undefined ? '—' : (call.countsAsContained ? 'Sí' : 'No')],
      ['Estado final', call.currentState || '—'],
      ['Inicio', formatDateTimeLong(call.startedAtISO)]
    ];
    // Los pares dt/dd se crean una sola vez y luego se reescriben sólo cuando
    // cambian: el sondeo pasa por aquí cada dos segundos y vaciar la lista
    // entera destruía la selección de texto de quien estuviera copiando algo.
    if (dl.children.length !== rows.length * 2) {
      clearChildren(dl);
      rows.forEach(function () {
        dl.appendChild(el('dt', '', ''));
        dl.appendChild(el('dd', '', ''));
      });
    }
    rows.forEach(function (pair, idx) {
      setText(dl.children[idx * 2], pair[0]);
      setText(dl.children[idx * 2 + 1], pair[1]);
    });
    byId('llamada-copiar-hash').setAttribute('data-hash', call.callIdHash);
    // (revisión step 15, punto 1) Sólo se borra "Copiado" al cambiar de
    // llamada — nunca en cada uno de los sondeos de 2s que repintan esta
    // misma llamada. Ver el docblock de \`copyStatusShownForCallHash\` arriba.
    if (copyStatusShownForCallHash !== openCallHash) limpiarLinea(byId('llamada-copiar-estado'));
    copyStatusShownForCallHash = openCallHash;
  }

  // ---------------------------------------------------------------------
  // HORARIOS Y AUSENCIAS (se llamaba CALENDARIO — §R1)
  // ---------------------------------------------------------------------

  /**
   * step 26 REAPERTURA §R7/§R8 — los controles de la pantalla «Horarios y
   * ausencias». Los dos disparadores de alta (cierre/día especial y ausencia)
   * viven aquí y sólo aquí; el filtro de profesional del bloque 3 repinta la
   * sección sin tocar la ruta, porque no es un estado que merezca una URL
   * propia (no lo era en Agenda y aquí tampoco).
   */
  function wireHorariosYAusenciasControls() {
    byId('btn-abrir-dia-especial').addEventListener('click', function () {
      openDiaEspecialDialog(byId('btn-abrir-dia-especial'));
    });
    byId('btn-abrir-ausencia').addEventListener('click', function () {
      openAusenciaDialog(byId('btn-abrir-ausencia'));
    });
    byId('horarios-filtro-profesional').addEventListener('change', function () {
      if (latestSnapshot) renderHorariosYAusencias(latestSnapshot);
    });
  }

  // ---------------------------------------------------------------------
  // step 26 REAPERTURA §R7/§R13 — LAS EXCEPCIONES, COMO OBJETOS.
  //
  // Un cierre, un día especial y una ausencia son tres registros distintos
  // del dominio, pero para esta pantalla son la misma cosa: algo que alguien
  // apuntó, que se lee en prosa, que puede llevar una nota y que se puede
  // CAMBIAR o RETIRAR. Los tres constructores de abajo los normalizan a un
  // solo descriptor, y con eso se pintan las tres listas (bloques 2, 3 y 4) y
  // se abre el detalle. Ninguno lee \`snap.calendar.auditLog\`: los cuatro
  // orígenes son los ARRAYS TIPADOS de la instantánea.
  // ---------------------------------------------------------------------

  /** La nota operativa de un registro, o cadena vacía. Nunca el motivo privado. */
  function notaDeRegistro(registro) {
    return (registro && registro.audit && typeof registro.audit.note === 'string') ? registro.audit.note : '';
  }

  function etiquetaDeAusencia(kind) {
    return kind === 'vacation' ? 'Vacaciones' : (kind === 'training' ? 'Formación' : 'Ausencia');
  }

  /** "jueves 13 de agosto de 2026" — como se dice, sin la coma de la lista. */
  function fechaEnProsa(iso) {
    var d = dateFromISO(iso);
    return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' de ' + MONTHS[d.getMonth()] + ' de ' + d.getFullYear();
  }

  /** "del lunes 10 al viernes 14 de agosto de 2026" — el mes y el año, una vez. */
  function rangoEnProsa(startISO, endISO) {
    var a = dateFromISO(startISO);
    var b = dateFromISO(endISO);
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
      return 'del ' + WEEKDAYS[a.getDay()] + ' ' + a.getDate() +
        ' al ' + WEEKDAYS[b.getDay()] + ' ' + b.getDate() + ' de ' + MONTHS[b.getMonth()] + ' de ' + b.getFullYear();
    }
    return 'del ' + fechaEnProsa(startISO) + ' al ' + fechaEnProsa(endISO);
  }

  /**
   * §R9 paso 3 (a) — la frase EN PROSA de un cambio, en castellano y sin un
   * solo identificador técnico. Es lo primero que se lee antes de publicar, y
   * lo que se lee al abrir el detalle de algo ya publicado: la misma frase
   * para las dos cosas, para que nadie tenga que traducir entre pantallas.
   */
  function fraseDeCambio(change) {
    if (change.changeKind === 'venue_closure') {
      if (change.startDate === change.endDate) {
        return capitalizarInicial('el ' + fechaEnProsa(change.startDate)) + ' el local no abre.';
      }
      return capitalizarInicial(rangoEnProsa(change.startDate, change.endDate)) + ' el local no abre.';
    }
    if (change.changeKind === 'special_opening') {
      return capitalizarInicial('el ' + fechaEnProsa(change.date)) + ' el local abre de ' +
        change.specialOpen + ' a ' + change.specialClose + ', en vez de su horario de siempre.';
    }
    if (change.changeKind === 'holiday') {
      return capitalizarInicial('el ' + fechaEnProsa(change.date)) + ' el local no abre: es festivo.';
    }
    var quien = professionalLabel(change.employeeId);
    if (change.allDay) {
      if (change.startDate === change.endDate) {
        return quien + ' no está el ' + fechaEnProsa(change.startDate) + ', el día entero.';
      }
      return quien + ' no está ' + rangoEnProsa(change.startDate, change.endDate) + ', los días enteros.';
    }
    return quien + ' no está el ' + fechaEnProsa(change.startDate) + ', de ' +
      formatMinutes(change.startMinutes) + ' a ' + formatMinutes(change.endMinutes) + '.';
  }

  /**
   * V3-2 — EL AÑO, cuando no es el del calendario que se está mirando.
   * \`formatDateShort\` dice «10 ago» y nada más: en un bloque que ya no se
   * limita al mes visible (y que puede traer un cierre de 2027 junto a uno de
   * la semana que viene) eso deja al operador adivinando de qué año le hablan.
   * El año se pinta SÓLO cuando no es el año en curso: ponerlo siempre sería
   * ruido en el 99% de las filas.
   */
  function fechaCortaConAnio(iso, hoyISO) {
    var corta = formatDateShort(iso);
    if (!hoyISO || iso.slice(0, 4) === hoyISO.slice(0, 4)) return corta;
    return corta + ' ' + iso.slice(0, 4);
  }

  function rangoCortoConAnio(start, end, hoyISO) {
    if (start === end) return fechaCortaConAnio(start, hoyISO);
    return fechaCortaConAnio(start, hoyISO) + ' – ' + fechaCortaConAnio(end, hoyISO);
  }

  /**
   * §R13-3 (deuda D-B2-4) — EL IDENTIFICADOR LO CONSTRUYE LA CONSOLA.
   *
   * Hasta esta reparación, lo que el operador escribía en «Nombre para
   * identificarlo» viajaba TAL CUAL como \`id\`. Dos consecuencias, las dos
   * malas: cualquier nombre repetido —«cierre-verano» dos años seguidos, o
   * «vacaciones-alex» dos veranos— chocaba con un 409, y cualquier nombre con
   * espacios, mayúsculas o acentos lo rechazaba el servidor con un 400 sobre
   * un patrón que el operador no ha visto nunca.
   *
   * Ahora el nombre es un NOMBRE y el identificador se deriva: minúsculas sin
   * tildes, todo lo que no sea letra o número pasa a guion, y se le añade la
   * fecha de la excepción como sufijo ESTABLE. Estable importa: la misma alta,
   * repetida, produce el mismo identificador (y entonces el 409 dice la
   * verdad: eso ya está apuntado); dos altas del mismo nombre en fechas
   * distintas producen identificadores distintos, que es justo lo que hacía
   * falta.
   *
   * El patrón que acepta el servidor es \`^[a-z0-9][a-z0-9._-]{0,199}$\`, y lo
   * que sale de aquí lo cumple por construcción: se recorta el trozo del
   * nombre para que la fecha quepa siempre entera dentro de los 200.
   */
  var LARGO_MAXIMO_ID = 200;

  function slugDeNombre(nombre) {
    // \`normalizarBusqueda\` ya es el normalizador tolerante a acentos de esta
    // consola (D20-23), con su repuesto para entornos sin \`String.normalize\`:
    // se reutiliza en vez de escribir un segundo mapa de acentos que pudiera
    // discrepar del primero.
    return normalizarBusqueda(nombre === null || nombre === undefined ? '' : nombre)
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  }

  function identificadorDeExcepcion(nombre, fechaISO) {
    var slug = slugDeNombre(nombre);
    if (slug === '') return '';
    var sufijo = '-' + fechaISO;
    return slug.slice(0, LARGO_MAXIMO_ID - sufijo.length) + sufijo;
  }

  /**
   * El camino de vuelta: de un identificador ya guardado al NOMBRE que se
   * precarga al «Cambiar». Se le quita el sufijo de fecha (si lo lleva: los
   * registros del fixture y los anteriores a esta reparación no lo llevan) y
   * se devuelve el resto. Precargar el nombre —y no el identificador— es lo
   * que hace que al cambiar la fecha el alta nueva reciba un identificador
   * nuevo en vez de reclamar el del que se acaba de retirar.
   */
  function nombreDesdeIdentificador(id) {
    var m = /^(.*)-\\d{4}-\\d{2}-\\d{2}$/.exec(String(id || ''));
    return m ? m[1] : String(id || '');
  }

  function excepcionDeCierre(c, hoyISO) {
    return {
      clave: 'closure-' + c.id,
      targetKind: 'venue_closure',
      id: c.id,
      inicio: c.startDate,
      fin: c.endDate,
      titulo: rangoCortoConAnio(c.startDate, c.endDate, hoyISO) + ' · Local cerrado',
      detalle: 'Cierre de todo el local',
      nota: notaDeRegistro(c),
      cambio: { changeKind: 'venue_closure', id: c.id, startDate: c.startDate, endDate: c.endDate },
      // Un cierre se puede volver a apuntar tal cual: \`venue_closure\` está en
      // CHANGE_SCHEMA y el diálogo de alta lo sabe construir.
      sePuedeCambiar: true
    };
  }

  function excepcionDeRegla(r, hoyISO) {
    var esFestivo = !!r.closed;
    return {
      clave: 'rule-' + r.id,
      targetKind: 'venue_rule',
      id: r.id,
      inicio: r.date,
      fin: r.date,
      titulo: fechaCortaConAnio(r.date, hoyISO) + (esFestivo ? ' · Local cerrado' : ' · Horario especial'),
      detalle: esFestivo ? 'Festivo' : ((r.specialOpen || '—') + ' – ' + (r.specialClose || '—')),
      nota: notaDeRegistro(r),
      cambio: esFestivo
        ? { changeKind: 'holiday', id: r.id, date: r.date }
        : { changeKind: 'special_opening', id: r.id, date: r.date, specialOpen: r.specialOpen, specialClose: r.specialClose },
      // Un FESTIVO se puede retirar, pero no volver a apuntar desde aquí: los
      // festivos se importan (\`approval.ts\`) y esa capacidad no tiene puerta
      // HTTP en esta reapertura (F8). Ofrecer «Cambiar» sería prometer un
      // camino que no existe, así que la fila de un festivo sólo lleva
      // «Retirar» y el detalle lo explica.
      sePuedeCambiar: !esFestivo
    };
  }

  function excepcionDeAusencia(a, hoyISO) {
    var cuanto = a.allDay ? 'Todo el día' : (formatMinutes(a.startMinutes) + '–' + formatMinutes(a.endMinutes));
    return {
      clave: 'absence-' + a.id,
      targetKind: 'employee_absence',
      id: a.id,
      inicio: a.startDate,
      fin: a.endDate,
      titulo: professionalLabel(a.employeeId) + ' · ' + etiquetaDeAusencia(a.kind),
      detalle: rangoCortoConAnio(a.startDate, a.endDate, hoyISO) + ' · ' + cuanto,
      nota: notaDeRegistro(a),
      cambio: {
        changeKind: 'employee_absence', id: a.id, employeeId: a.employeeId, absenceKind: a.kind,
        startDate: a.startDate, endDate: a.endDate, allDay: !!a.allDay,
        startMinutes: a.startMinutes, endMinutes: a.endMinutes
      },
      sePuedeCambiar: true
    };
  }

  /** Los cierres y días especiales APROBADOS que solapan el mes visible. */
  function excepcionesDelMes(cal, year, month, hoyISO) {
    var monthStart = year + '-' + String(month).padStart(2, '0') + '-01';
    var monthEnd = toISODate(new Date(year, month, 0));
    var items = [];
    (cal.closures || []).forEach(function (c) {
      if (c.approval !== 'approved') return;
      if (c.startDate > monthEnd || c.endDate < monthStart) return;
      items.push(excepcionDeCierre(c, hoyISO));
    });
    (cal.venueRules || []).forEach(function (r) {
      if (r.approval !== 'approved') return;
      if (r.date < monthStart || r.date > monthEnd) return;
      items.push(excepcionDeRegla(r, hoyISO));
    });
    items.sort(function (a, b) { return a.inicio.localeCompare(b.inicio); });
    return items;
  }

  /** Las ausencias APROBADAS que no han terminado, filtradas por profesional. */
  function ausenciasVigentes(cal, desdeISO, employeeIdOrNull) {
    var items = (cal.absences || []).filter(function (a) {
      if (a.approval !== 'approved') return false;
      if (a.endDate < desdeISO) return false;
      if (employeeIdOrNull !== null && a.employeeId !== employeeIdOrNull) return false;
      return true;
    }).map(function (a) { return excepcionDeAusencia(a, desdeISO); });
    items.sort(function (a, b) { return a.inicio.localeCompare(b.inicio); });
    return items;
  }

  /**
   * V3-2 — TODAS las excepciones aprobadas de los tres tipos que §R13
   * autoriza retirar, sin ninguna ventana: cierres, días especiales/festivos y
   * ausencias de todo el equipo. Es la lista de la que salen los dos bloques
   * del final —«Próximas excepciones» y el plegable de lo ya pasado— y su
   * única razón de ser es que NINGUNA fila aprobada quede sin un botón que la
   * retire. Mientras una fila esté aprobada, su identificador está ocupado; si
   * no se puede ver, el 409 que provoca es un callejón sin salida.
   */
  function excepcionesAprobadas(cal, hoyISO) {
    var items = [];
    (cal.closures || []).forEach(function (c) {
      if (c.approval === 'approved') items.push(excepcionDeCierre(c, hoyISO));
    });
    (cal.venueRules || []).forEach(function (r) {
      if (r.approval === 'approved') items.push(excepcionDeRegla(r, hoyISO));
    });
    (cal.absences || []).forEach(function (a) {
      if (a.approval === 'approved') items.push(excepcionDeAusencia(a, hoyISO));
    });
    items.sort(function (a, b) { return a.inicio.localeCompare(b.inicio) || a.clave.localeCompare(b.clave); });
    return items;
  }

  /**
   * Una fila de excepción: cuerpo legible (título, detalle y, si la hay, la
   * NOTA pintada con \`textContent\` dentro de \`.tx-nota-operativa\`) y sus dos
   * controles. Nada sólo-color: cada fila dice con palabras lo que es.
   *
   * El \`<li>\` se REUTILIZA entre pasadas (reconcileList): los manejadores se
   * reasignan siempre, porque el descriptor que le toca a una clave puede
   * haber cambiado de contenido entre dos sondeos.
   */
  function buildFilaExcepcion(item, existingLi) {
    var li = existingLi || (function () {
      var node = el('li', '');
      var fila = el('div', 'tx-excepcion-fila');
      var cuerpo = el('div', 'tx-excepcion-fila__cuerpo');
      cuerpo.appendChild(el('p', '', ''));
      cuerpo.appendChild(el('p', 'tx-activity-list__time', ''));
      cuerpo.appendChild(el('p', '', ''));
      fila.appendChild(cuerpo);
      var acciones = el('div', 'tx-excepcion-fila__acciones');
      var cambiar = el('button', 'tx-btn tx-btn--secondary', 'Cambiar');
      cambiar.type = 'button';
      acciones.appendChild(cambiar);
      var retirar = el('button', 'tx-btn tx-btn--ghost', 'Retirar');
      retirar.type = 'button';
      acciones.appendChild(retirar);
      fila.appendChild(acciones);
      node.appendChild(fila);
      return node;
    })();
    li.setAttribute('data-inicio', item.inicio);
    var cuerpoEl = li.children[0].children[0];
    setText(cuerpoEl.children[0], item.titulo);
    setText(cuerpoEl.children[1], item.detalle);
    var notaEl = cuerpoEl.children[2];
    clearChildren(notaEl);
    setHidden(notaEl, item.nota === '');
    if (item.nota !== '') notaEl.appendChild(el('span', 'tx-nota-operativa', item.nota));
    var accionesEl = li.children[0].children[1];
    var botonCambiar = accionesEl.children[0];
    var botonRetirar = accionesEl.children[1];
    setHidden(botonCambiar, !item.sePuedeCambiar);
    botonCambiar.setAttribute('aria-label', 'Cambiar: ' + item.titulo);
    botonRetirar.setAttribute('aria-label', 'Retirar: ' + item.titulo);
    botonCambiar.onclick = function () { openExcepcionDialog(item, botonCambiar, 'cambiar'); };
    botonRetirar.onclick = function () { openExcepcionDialog(item, botonRetirar, 'retirar'); };
    return li;
  }

  function monthMatrix(year, month1based) {
    var first = new Date(year, month1based - 1, 1);
    var startOffset = (first.getDay() + 6) % 7; // Monday-first columns
    var daysInMonth = new Date(year, month1based, 0).getDate();
    var cells = [];
    for (var i = 0; i < startOffset; i += 1) cells.push(null);
    for (var d = 1; d <= daysInMonth; d += 1) {
      cells.push(year + '-' + String(month1based).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
    }
    while (cells.length % 7 !== 0) cells.push(null);
    var weeks = [];
    for (var w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
    return weeks;
  }

  function renderHorariosYAusencias(snap) {
    if (!calendarVisibleMonth) {
      var p = snap.engineToday.split('-');
      calendarVisibleMonth = { year: Number(p[0]), month: Number(p[1]) };
    }
    var year = calendarVisibleMonth.year;
    var month = calendarVisibleMonth.month;

    // ------------------------------------------------------------------
    // Bloque 1 — «Horario habitual». CONSULTA (§R12): la MISMA función que
    // pinta el «Horario del local» de Equipo, no una copia.
    // ------------------------------------------------------------------
    pintarSemanaDelLocal(byId('horarios-semana'), byId('horarios-regimen'), snap);

    byId('calendario-mes-titulo').textContent = MONTHS[month - 1] + ' de ' + String(year);
    var prevM = month === 1 ? 12 : month - 1;
    var prevY = month === 1 ? year - 1 : year;
    var nextM = month === 12 ? 1 : month + 1;
    var nextY = month === 12 ? year + 1 : year;
    byId('calendario-mes-anterior').href = '#/horarios-y-ausencias/' + prevY + '-' + String(prevM).padStart(2, '0');
    byId('calendario-mes-anterior').setAttribute('aria-label', 'Ir a ' + MONTHS[prevM - 1] + ' de ' + String(prevY));
    byId('calendario-mes-siguiente').href = '#/horarios-y-ausencias/' + nextY + '-' + String(nextM).padStart(2, '0');
    byId('calendario-mes-siguiente').setAttribute('aria-label', 'Ir a ' + MONTHS[nextM - 1] + ' de ' + String(nextY));

    // Aviso de temporada
    var seasonRows = (snap.calendar.seasonalSchedules || []).filter(function (s) {
      var monthStart = year + '-' + String(month).padStart(2, '0') + '-01';
      var monthEnd = toISODate(new Date(year, month, 0));
      return s.approval === 'approved' && s.startDate <= monthEnd && s.endDate >= monthStart;
    });
    var banner = byId('calendario-temporada');
    if (seasonRows.length > 0) {
      var first = seasonRows[0];
      setHidden(banner, false);
      byId('calendario-temporada-titulo').textContent = first.label + ' · ' + formatDateRangeLong(first.startDate, first.endDate);
      var byDow = {};
      seasonRows.forEach(function (r) { byDow[r.dayOfWeek] = r; });
      // Concordancia (revisión step 15): antes se mezclaba el singular de
      // WEEKDAYS ("martes 09:00-17:30. miércoles…") con un "sábados" en plural
      // escrito a mano. Aquí se habla de días que se repiten cada semana, así
      // que van todos en plural, y cada frase empieza con mayúscula porque el
      // separador es un punto.
      var parts = [];
      [1, 2, 3, 4, 5, 6].forEach(function (dow) {
        if (!byDow[dow]) return;
        var name = WEEKDAYS_PLURAL[dow];
        parts.push(name.charAt(0).toUpperCase() + name.slice(1) + ' ' + byDow[dow].workDayStart + '-' + byDow[dow].workDayEnd);
      });
      var closedDays = [0, 1, 2, 3, 4, 5, 6].filter(function (d) { return !byDow[d]; }).map(function (d) { return WEEKDAYS_PLURAL[d]; });
      byId('calendario-temporada-detalle').textContent = parts.join('. ') + (closedDays.length ? '. Cerrado: ' + closedDays.join(', ') + '.' : '.');
      // step 15: aquí se decía "No se repite solo (does_not_repeat)" y, en la
      // línea de abajo, "Confirmado por fixture:synthetic-demo el
      // 2026-...T...Z". Eso es lenguaje interno y una fecha en crudo, en una
      // pantalla de operador. El dato técnico no se pierde: el snapshot entero
      // (recurrence, audit.createdBy y audit.createdAt incluidos) se sigue
      // sirviendo tal cual en Laboratorio › instantánea en crudo.
      byId('calendario-temporada-aviso-fecha').textContent = 'Este horario solo está confirmado para ' + String(year) + '. No se repite solo: el del año que viene habrá que revisarlo y confirmarlo.';
    } else {
      setHidden(banner, true);
    }

    // Rejilla del mes
    var weeks = monthMatrix(year, month);
    reconcileList(byId('calendario-grid-body'), weeks, function (_w, idx) { return idx; }, function (week, existingTr, weekIndex) {
      var tr = existingTr || (function () {
        var row = document.createElement('tr');
        for (var i = 0; i < 7; i += 1) row.appendChild(document.createElement('td'));
        return row;
      })();
      week.forEach(function (dateISO, colIdx) {
        var td = tr.children[colIdx];
        clearChildren(td);
        if (!dateISO) {
          td.className = 'tx-day-cell tx-day-cell--outside';
          td.setAttribute('aria-hidden', 'true');
          return;
        }
        var venueDay = resolveVenueDay(dateISO, snap.calendar);
        var isToday = dateISO === snap.engineToday;
        var dayAbsences = absencesOn(snap.calendar, dateISO);
        var isHolidayOrSpecial = venueDay.isHoliday || venueDay.isSpecial;

        td.className = 'tx-day-cell' + (isToday ? ' tx-day-cell--today' : '') + (!venueDay.open ? ' tx-day-cell--closed' : '');
        // step 26 §7 — el Calendario operativo gana EXACTAMENTE una cosa: el
        // número de día pasa a ser un enlace a la Agenda de ese día. Todo lo
        // demás de esta celda —festivo, ausencias, día especial— sigue
        // siendo exclusivo de esta pantalla.
        var numberLine = el('a', 'tx-day-cell__number', String(Number(dateISO.slice(8, 10))));
        numberLine.href = agendaHrefPara('dia', dateISO, 'todos');
        numberLine.setAttribute('aria-label', 'Ver agenda de este día: ' + formatDateLong(dateISO));
        if (isToday) {
          var todayBadge = el('span', 'tx-day-cell__today', 'Hoy');
          numberLine.appendChild(todayBadge);
        }
        td.appendChild(numberLine);
        var hours = el('span', 'tx-day-cell__hours', venueDay.open ? (venueDay.start + '–' + venueDay.end) : 'Cerrado');
        td.appendChild(hours);
        var marks = el('span', 'tx-day-cell__marks');
        if (isHolidayOrSpecial) marks.appendChild(el('span', 'tx-mark--holiday', '▲ ' + (venueDay.isHoliday ? 'Festivo' : 'Especial')));
        pintarMarcasDeAusencia(marks, dayAbsences);
        // step 26 REAPERTURA §R3 — aquí NO se cuenta ninguna cita. Esta
        // pantalla habla de horarios; la única cuadrícula mensual de citas de
        // toda la consola es Agenda › Mes.
        td.appendChild(marks);
      });
      return tr;
    });

    // ------------------------------------------------------------------
    // Bloque 2, segunda mitad — «Cierres y días especiales de este mes».
    // De los ARRAYS TIPADOS del mes visible, con su nota y sus dos controles.
    // ------------------------------------------------------------------
    var excepcionesMes = excepcionesDelMes(snap.calendar, year, month, snap.engineToday);
    setHidden(byId('horarios-excepciones-mes-vacio'), excepcionesMes.length > 0);
    reconcileList(byId('horarios-excepciones-mes'), excepcionesMes, function (x) { return x.clave; }, buildFilaExcepcion);

    // ------------------------------------------------------------------
    // Bloque 3 — «Ausencias del equipo» (§R8: el CRUD vive aquí, y sólo aquí)
    // ------------------------------------------------------------------
    var filtroEl = byId('horarios-filtro-profesional');
    ensureProfessionalOptions(filtroEl, snap.calendar.professionals || [], 'Todos');
    var filtroValor = filtroEl.value;
    var empleadoFiltrado = filtroValor === '' ? null : Number(filtroValor);
    var ausencias = ausenciasVigentes(snap.calendar, snap.engineToday, empleadoFiltrado);
    setHidden(byId('horarios-ausencias-vacio'), ausencias.length > 0);
    reconcileList(byId('horarios-ausencias'), ausencias, function (x) { return x.clave; }, buildFilaExcepcion);

    // ------------------------------------------------------------------
    // Bloque 4 — «Próximas excepciones»: TODO lo aprobado que no ha
    // terminado, sin importar el mes visible, y con las mismas filas que los
    // bloques 2 y 3 — detalle, nota y sus dos botones. Nunca \`auditLog\`.
    //
    // V3-2: antes salía de \`collectDistinctDays\`, que produce un texto plano
    // sin ruta de retirada, y encima el bloque 2 se limitaba al mes visible y
    // el 3 a las ausencias no terminadas. Una excepción aprobada fuera de esas
    // dos ventanas —una ausencia que ya acabó, un cierre de un año futuro—
    // seguía ocupando su identificador sin aparecer en ninguna lista con un
    // botón de retirar: un callejón sin salida en toda regla. Ahora estas dos
    // listas cubren, entre las dos, TODO lo aprobado.
    // ------------------------------------------------------------------
    var todas = excepcionesAprobadas(snap.calendar, snap.engineToday);
    var proximas = todas.filter(function (x) { return x.fin >= snap.engineToday; });
    var anteriores = todas.filter(function (x) { return x.fin < snap.engineToday; });

    setHidden(byId('calendario-dias-distintos-vacio'), proximas.length > 0);
    // D1: la temporada que se tiene en cuenta aquí es la que rige HOY — la
    // ventana de este bloque ya no es el mes visible, así que preguntar por la
    // del mes de arriba habría hecho que las dos zonas dijeran cosas distintas.
    fillDistinctDaysEmpty(byId('calendario-dias-distintos-vacio'), activeSeasonalOverride(snap.calendar, snap.engineToday), 'proximos');
    reconcileList(byId('calendario-dias-distintos'), proximas, function (x) { return x.clave; }, buildFilaExcepcion);

    // Lo que ya ha pasado: plegado, sobrio, y con «Retirar» disponible. Sigue
    // ocupando su nombre, así que tiene que poder verse y retirarse.
    setHidden(byId('calendario-excepciones-anteriores-vacio'), anteriores.length > 0);
    reconcileList(byId('calendario-excepciones-anteriores'), anteriores, function (x) { return x.clave; }, buildFilaExcepcion);
  }

  // ---------------------------------------------------------------------
  // EQUIPO
  // ---------------------------------------------------------------------

  /**
   * step 26 REAPERTURA §R12 y §4 — EL HORARIO DEL LOCAL, UNA SOLA VEZ.
   *
   * Los siete días con sus horas y el régimen que rige la ventana. Lo pintan
   * DOS pantallas —Equipo («Horario del local») y Horarios y ausencias
   * (bloque 1, «Horario habitual»)— y por eso la función vive aquí y recibe
   * sus contenedores: una implementación, dos sitios. Antes de esta
   * reapertura sólo existía dentro de \`renderEquipo\`; copiarla habría sido
   * crear la duplicación de cálculo que el §4 del normativo prohíbe.
   *
   * O5 (step 16). SIETE FECHAS REALES, no siete iteraciones sobre la
   * temporada de "hoy". Antes esto se resolvía dentro de cada ficha con:
   *     var season = activeSeasonalOverride(snap.calendar, snap.engineToday);
   *     [1,2,3,4,5,6,0].forEach(function (dow) {
   *       venueWeekdayHours(snap.calendar, dow, snap.engineToday);  // <- SIEMPRE hoy
   *     });
   * y por tanto el 31 de julio describía los siete días con el horario de
   * siempre (incluido el 4 de agosto, que ya es de temporada), y el 31 de
   * agosto los describía todos con el de agosto (incluido el 1 de
   * septiembre, que ya no lo es).
   * resolveVenueDay() SÍ resuelve por fecha, y es la MISMA función que
   * responden Agenda y Horarios: las tres pantallas no pueden discrepar.
   */
  function pintarSemanaDelLocal(contenedorDias, contenedorRegimen, snap) {
    if (!contenedorDias || !contenedorRegimen) return;
    var venueDays = [];
    for (var n = 0; n < 7; n += 1) {
      var iso = addDaysISO(snap.engineToday, n);
      venueDays.push({ iso: iso, day: resolveVenueDay(iso, snap.calendar) });
    }

    reconcileList(contenedorDias, venueDays, function (d) { return d.iso; }, function (d, existingLi) {
      var li = existingLi || (function () {
        var node = el('li', '');
        node.appendChild(el('span', 'tx-week-strip__day', ''));
        node.appendChild(el('span', 'tx-week-strip__hours', ''));
        return node;
      })();
      var wd = WEEKDAYS[dateFromISO(d.iso).getDay()];
      setText(li.children[0], wd.charAt(0).toUpperCase() + wd.slice(1) + ' ' + formatDateShort(d.iso));
      setText(li.children[1], d.day.open
        ? (d.day.start + ' – ' + d.day.end)
        : ('Cerrado · ' + (d.day.reasonLabel || 'Día de descanso')));
      return li;
    });

    // Qué régimen rige en esta ventana de siete días. Se mira temporada POR
    // FECHA, no sólo la de hoy: si la ventana cruza una frontera, se dice.
    var periodos = {};
    var algunDiaOrdinario = false;
    venueDays.forEach(function (d) {
      var s = activeSeasonalOverride(snap.calendar, d.iso);
      if (s) periodos[s.periodId] = s;
      else algunDiaOrdinario = true;
    });
    var claves = Object.keys(periodos);
    var regimen;
    if (claves.length === 0) {
      regimen = 'Estos siete días van con el horario de siempre del local. Es el mismo para todo el equipo.';
    } else if (claves.length === 1 && !algunDiaOrdinario) {
      var unica = periodos[claves[0]];
      regimen = 'Estos siete días van con el horario de temporada del local («' + unica.label + '», ' +
        formatDateRangeLong(unica.startDate, unica.endDate) + '). Es el mismo para todo el equipo.';
    } else {
      var etiquetas = claves.map(function (k) {
        return '«' + periodos[k].label + '» (' + formatDateRangeLong(periodos[k].startDate, periodos[k].endDate) + ')';
      });
      regimen = 'Atención: estos siete días cambian de horario por el camino. Unos van con el horario de siempre del local y otros con el de temporada ' +
        etiquetas.join(' y ') + '. Cada día de arriba lleva ya sus horas exactas. El horario es el mismo para todo el equipo.';
    }
    setText(contenedorRegimen, regimen);
  }

  function renderEquipo(snap) {
    pintarSemanaDelLocal(byId('equipo-horario-dias'), byId('equipo-horario-regimen'), snap);

    var professionals = snap.calendar.professionals;
    setHidden(byId('equipo-vacio'), professionals.length > 0);
    reconcileList(byId('equipo-fichas'), professionals, function (p) { return p.employeeId; }, function (pro, existingCard) {
      var card = existingCard || (function () {
        var node = el('article', 'tx-pro-card');
        var head = el('div', 'tx-pro-card__head');
        head.appendChild(el('h3', '', ''));
        node.appendChild(head);
        // Servicios: la ÚNICA diferencia real entre personas en esta demo
        // (Nerea no puede el servicio 0). Se conserva entera.
        var capsBlock = el('p', 'tx-pro-card__line');
        capsBlock.appendChild(el('span', 'tx-pro-card__k', 'Puede hacer'));
        capsBlock.appendChild(el('span', '', ''));
        node.appendChild(capsBlock);
        var absenceBlock = el('div', 'tx-pro-card__line tx-pro-card__absences');
        absenceBlock.appendChild(el('span', 'tx-pro-card__k', 'Ausencias próximas'));
        absenceBlock.appendChild(el('span', ''));
        // step 26 REAPERTURA §R8 — aquí había un botón «Añadir ausencia» por
        // ficha. La escritura de ausencias se ha mudado ENTERA a Horarios y
        // ausencias: crear, cambiar y retirar viven en un solo sitio. Equipo
        // conserva la LECTURA y gana UN enlace por ficha —no un botón por
        // ausencia— para llegar a donde se gestionan.
        var enlace = el('a', 'tx-btn tx-btn--secondary', 'Gestionar ausencias');
        enlace.href = '#/horarios-y-ausencias';
        absenceBlock.appendChild(enlace);
        node.appendChild(absenceBlock);
        return node;
      })();
      card.children[0].children[0].textContent = pro.label;

      var caps = (snap.calendar.capabilities || []).filter(function (c) { return c.employeeId === pro.employeeId; })[0];
      setText(card.children[1].children[1], caps ? caps.serviceIds.map(serviceLabel).join(' · ') : '—');

      var absenceHolder = card.children[2].children[1];
      clearChildren(absenceHolder);
      var upcomingAbsences = (snap.calendar.absences || []).filter(function (a) {
        return a.employeeId === pro.employeeId && a.approval === 'approved' && a.endDate >= snap.engineToday;
      }).sort(function (a, b) { return a.startDate.localeCompare(b.startDate); });
      if (upcomingAbsences.length === 0) {
        absenceHolder.appendChild(el('span', 'tx-context__note', 'Sin ausencias apuntadas.'));
      } else {
        upcomingAbsences.forEach(function (a) {
          var kindLabel = a.kind === 'vacation' ? 'Vacaciones' : (a.kind === 'training' ? 'Formación' : 'Ausencia');
          var glyph = a.kind === 'vacation' ? '◆' : (a.kind === 'training' ? '▣' : '◇');
          absenceHolder.appendChild(el('span', 'tx-absence-chip', glyph + ' ' + kindLabel + ' · ' + rangeLabel(a.startDate, a.endDate) + ' · ' + (a.allDay ? 'Todo el día' : formatMinutes(a.startMinutes) + '–' + formatMinutes(a.endMinutes))));
        });
      }

      return card;
    });
  }

  // ---------------------------------------------------------------------
  // Fontanería compartida de las acciones de operador (step 17).
  // Una sola forma de enviar una orden, una sola forma de contar cómo ha
  // ido, y una sola forma de abrir y cerrar un diálogo devolviendo el foco.
  // ---------------------------------------------------------------------

  var SIN_CONEXION = 'No hay conexión con el motor. No se ha guardado nada.';

  /**
   * POST con cuerpo JSON. \`idempotencyKey\`, cuando se da, viaja en la
   * cabecera \`Idempotency-Key\` (obligatoria en convertir y en cancelar,
   * §6.2). La clave la acuña la INTENCIÓN, no el momento: un doble clic
   * produce la misma clave y por tanto la misma respuesta.
   *
   * \`repetida\` sale de la cabecera \`Idempotency-Status\` que contesta el
   * servidor: cuando dice \`replayed\`, esta petición no ha hecho nada nuevo
   * y la pantalla no puede cantar la acción como recién hecha.
   */
  function sendJson(url, body, idempotencyKey) {
    var headers = { 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (res) {
      var marca = res.headers && res.headers.get ? res.headers.get('Idempotency-Status') : null;
      return res.json().then(function (json) {
        return { ok: res.ok, status: res.status, json: json, repetida: marca === 'replayed' };
      }, function () {
        return { ok: res.ok, status: res.status, json: {}, repetida: marca === 'replayed' };
      });
    });
  }

  /**
   * (step 18 §1.2.2) Tono de BASE declarado en el HTML, por región. Tabla
   * CERRADA: seis líneas nacen con \`tx-status-line--error\` o \`--ok\`
   * ESTÁTICOS en el HTML servido (ui.html.ts:619, 640, 682, 703, 746, 799) y
   * limpiar no puede robárselo — una línea de error tiene que seguir naciendo
   * roja después de un reinicio (criterio 8.37).
   *
   * Las regiones que step 18 añada más adelante con tono estático
   * (\`grupo-error\`, §4.13) se apuntan aquí en su fase, no antes: esta tabla
   * describe lo que el HTML dice HOY.
   */
  /**
   * Los tonos posibles de una línea de estado, como lista CERRADA. Se quitan
   * de uno en uno a propósito: \`classList.remove\` acepta varios argumentos
   * en un navegador, pero depender de ello ataría esta función a esa forma
   * concreta de la API por ninguna ventaja.
   */
  var TONOS_DE_LINEA = ['ok', 'error', 'conflict'];

  function quitarTonos(node) {
    TONOS_DE_LINEA.forEach(function (nombre) { node.classList.remove('tx-status-line--' + nombre); });
  }

  var TONO_BASE = {
    'dia-especial-paso1-error': 'error',
    'dia-especial-exito': 'ok',
    'ausencia-paso1-error': 'error',
    'ausencia-exito': 'ok',
    'cancelar-cita-error': 'error',
    'alta-lista-error': 'error',
    // (step 18 §4.13) La séptima línea con tono ESTÁTICO en el HTML: el
    // \`role="alert"\` del diálogo de grupo nace con \`tx-status-line--error\`,
    // y limpiar no puede robárselo (criterio 8.37).
    'grupo-error': 'error'
  };

  /**
   * El id de un nodo, leído por atributo. \`node.id\` existe en el navegador;
   * \`getAttribute('id')\` existe además en el DOM mínimo de las pruebas, y las
   * dos formas devuelven lo mismo en un navegador de verdad.
   */
  function idDeNodo(node) {
    var porAtributo = node.getAttribute ? node.getAttribute('id') : null;
    return porAtributo || node.id || '';
  }

  /**
   * (step 18 §1.2.2) El ÚNICO sitio que escribe una línea de estado. NUNCA
   * toca clases ajenas —usa \`classList\`, no \`className\`, para que
   * \`tx-col-12\` y compañía sobrevivan (causa 4 de §1.0)— y GOBIERNA
   * \`hidden\`: una línea con texto está disponible, una línea vacía está
   * oculta y fuera del árbol de accesibilidad.
   *
   * \`tono\`: '' | 'ok' | 'conflict' | 'error'. El conflicto NO es un error
   * (§9.5 de step 17). Sin tono explícito se repone el de base.
   */
  function setEstadoLinea(node, texto, tono) {
    if (!node) return;
    var vacia = texto === '';
    // Al VACIAR, \`hidden\` se pone antes de tocar el texto; al ESCRIBIR,
    // después. El árbol de accesibilidad se recalcula al final de la tarea y
    // no observa el paso intermedio (enmienda de fase D, N1), así que este
    // orden no compra silencio por sí solo: lo que de verdad lo compra es que
    // una línea vacía TERMINA oculta. El orden se conserva porque no cuesta
    // nada y es el honesto.
    if (vacia) node.hidden = true;
    quitarTonos(node);
    var t = tono || TONO_BASE[idDeNodo(node)] || '';
    if (t) node.classList.add('tx-status-line--' + t);
    node.textContent = texto;
    if (!vacia) node.hidden = false;
  }

  /**
   * (step 18 §1.2.2, enmienda de fase D N1) Limpieza SILENCIOSA: oculta,
   * vacía, restituye el tono estático y DEJA la línea oculta.
   *
   * Dejarla oculta es seguro —y no la deja muda— exactamente porque §1.2.1
   * obliga a que TODOS los escritores pasen por \`setEstadoLinea\`, que repone
   * \`hidden = false\` en cuanto vuelve a haber algo que decir (criterio 8.36).
   * Es, por construcción, lo mismo que escribir el texto vacío.
   */
  function limpiarLinea(node) {
    if (!node) return;
    setEstadoLinea(node, '', '');
  }

  /**
   * (step 18 §1.1/§1.2.2) Las regiones vivas que un reinicio con éxito
   * BORRA, como lista LITERAL y no como \`querySelectorAll('[aria-live]')\`:
   * así \`#tx-freshness\` no puede caer dentro por accidente y añadir una
   * región obliga a decidir conscientemente si es transitoria.
   *
   * Fuera de la lista, a propósito y con motivo escrito en §1.1:
   *   - \`tx-freshness\`: dice cuándo se actualizó la pantalla, y sigue siendo
   *     cierto después del reinicio.
   *   - \`inicio-ruta-desconocida\`: texto ESTÁTICO gobernado por el enrutador
   *     con \`setHidden\`; si el operador llegó con un hash inexistente, esa
   *     página sigue sin existir (nota A1).
   *   - \`lista-espera-cargando\`: la esconde \`renderListaEspera\` tras el
   *     primer sondeo.
   *   - \`lab-tareas-estado\` *(sale de la lista 2026-08-06, re-verificación de
   *     la fase 12, hallazgo n1)*: mismo motivo que \`lista-espera-cargando\`.
   *     Estando en la lista, el barrido la vaciaba (oculta, en silencio) y,
   *     con Laboratorio activo, el repintado que sigue (\`refresh(true)\` dentro
   *     de la propia secuencia) la volvía a escribir de inmediato con
   *     \`renderHistorialDeTareas\` — una SEGUNDA locución en el mismo turno,
   *     además de \`#estado-global\` (rompía la regla de una sola, §1.3). Fuera
   *     de la lista, el barrido no la toca: sigue reflejando lo que ya decía
   *     antes del reinicio, y \`renderHistorialDeTareas\` —que se repinta en
   *     cada sondeo, con o sin reinicio de por medio— la deja tal cual si el
   *     texto correcto tras reiniciar es el mismo que ya tenía (típico: sin
   *     tareas, antes y después), gracias a la guarda de M4 (\`ponerEstadoTareas\`).
   *     Si de verdad cambia (por ejemplo, un filtro que antes sí tenía
   *     resultados y ya no), SÍ se reescribe — pero eso es información nueva
   *     y real, no un eco del propio reinicio.
   *
   * Las seis últimas son las de la fase G (§1.1, filas 24-28, más la del
   * panel de ejemplos de grupo del §4.13): las cinco del diseño y
   * \`lab-grupo-estado\`, que es la línea del panel que dispara los tres
   * escenarios de §4.13. Entran aquí por la misma razón que las demás — son
   * el resultado de una acción, no el estado permanente de la pantalla —, y
   * eso es lo que hace que un reinicio con el diálogo de grupo a medias no
   * deje ni un mensaje rancio detrás (§1.3).
   */
  var REGIONES_TRANSITORIAS = [
    'le-huecos-estado',
    'le-tardias-estado',
    'le-personas-estado',
    'le-plazo-estado',
    'llamada-copiar-estado',
    'lab-escenario-estado',
    'dia-especial-paso1-error',
    'dia-especial-contador',
    'dia-especial-exito',
    'ausencia-paso1-error',
    'ausencia-contador',
    'ausencia-exito',
    'reset-estado',
    'cancelar-cita-error',
    'cancelar-cita-resultado',
    'alta-lista-error',
    'alta-lista-resultado',
    'simular-aviso-estado',
    'convertir-estado',
    'inasistencia-estado',
    'corregir-inasistencia-estado',
    'grupo-estado',
    'grupo-error',
    // step 24 §13 — las dos líneas del diálogo de la cita manual. Entran en
    // el barrido por la misma razón que las del grupo: son resultado de una
    // acción del operador y NO salen de la instantánea, así que un repintado
    // no las borraría solo y sobrevivirían a un reinicio hablando de un mundo
    // que ya no existe.
    'manual-estado',
    'manual-error',
    'lab-reloj-estado',
    'lab-grupo-estado',
    // step 19 §3.8, punto 10 / §7.1, I8: la línea de puerta se recalcula
    // justo después, en 'limpiarExploradorHuecos()' (vía
    // 'actualizarPuertaHuecos()'), a partir de los campos del formulario que
    // el reinicio NO toca — así que nunca queda vacía "de verdad".
    'huecos-gate',
    'huecos-error',
    // step 19 §5.2.6/§7.1 (I8, hallazgo M2) — el mensaje de copiado del
    // resumen para Bruno. NO sale de la instantánea (es estado de cliente), así
    // que el repintado no lo borraría solo. El \`<textarea>\` de respaldo, que
    // NO es una línea de estado, se vacía y se vuelve a ocultar aparte, en
    // \`limpiarRespaldoDeCopiaDelResumen()\` (ver la secuencia de reinicio).
    'lab-resumen-copiar-estado',
    // step 20 §3.8/§6.4 — las dos líneas de copiado del taller. NO salen de
    // la instantánea (son estado de cliente), así que el repintado no las
    // borraría solo. El BORRADOR no se toca: lo dice D20-27.
    'tx-taller-acta-estado',
    'tx-taller-mision-estado'
  ];

  function limpiarEstadosTransitorios() {
    REGIONES_TRANSITORIAS.forEach(function (id) { limpiarLinea(byId(id)); });
  }

  /**
   * Los conflictos que el servidor puede devolver, dichos en castellano. El
   * cuerpo del 409 sólo trae un CÓDIGO (\`conflict\`), nunca una frase: la
   * frase se escribe aquí, una sola vez, y ninguna de ellas afirma que se
   * haya escrito algo. La del hueco ocupado es, palabra por palabra, la del
   * §9.4.3 del diseño.
   */
  var CONFLICTOS = {
    slot_no_longer_free: 'No se ha creado la reserva: el hueco ya estaba ocupado. No se ha escrito nada. La entrada vuelve a estar pendiente.',
    offer_no_longer_valid: 'Ese hueco ya no está libre, así que la oferta ya no vale. No se ha escrito nada.',
    slot_already_accepted_by_another_entry: 'Otra persona ya ha aceptado ese hueco. No se ha escrito nada.',
    entry_state_not_allowed: 'Esa acción ya no encaja con la situación de esta persona. La pantalla se ha puesto al día: vuelve a mirar qué puedes hacer.',
    entry_not_matched_to_this_slot: 'Esta persona ya no tiene ofrecido ese hueco. No se ha escrito nada.',
    slot_not_found: 'Ese hueco ya no existe en la demostración. No se ha escrito nada.',
    reservation_already_cancelled: 'Esa cita ya estaba cancelada. No se ha escrito nada.',
    cancellation_not_late: 'Esa cancelación no quedó fuera de plazo: no hay nada que revisar.',
    already_reviewed: 'Esa cancelación ya estaba revisada.',
    idempotency_key_reused_with_different_body: 'Esta misma acción se ha repetido con datos distintos. No se ha hecho nada.'
  };

  function textoDeFallo(r) {
    if (r.status === 409) {
      var codigo = r.json && r.json.conflict;
      return (codigo && CONFLICTOS[codigo]) || 'La demostración ha parado la acción para no escribir algo incorrecto. No se ha guardado nada.';
    }
    if (r.json && r.json.error) return r.json.error;
    return 'La demostración ha rechazado la acción. No se ha guardado nada.';
  }

  function tonoDeFallo(r) { return r.status === 409 ? 'conflict' : 'error'; }

  /**
   * Quién abrió cada diálogo, para devolverle el foco al cerrarse. Se
   * engancha al evento \`close\` del propio \`<dialog>\` y no al botón de
   * cerrar: así el foco vuelve TAMBIÉN cuando se cierra con Escape, que es
   * cosa del navegador y no pasa por ninguna función de aquí.
   */
  var disparadorDialogo = {};

  /**
   * V3-7 — UN DIÁLOGO ABIERTO NO SOBREVIVE AL CAMBIO DE RUTA.
   *
   * El enrutador sólo conmuta \`hidden\` en las siete \`<section>\`, y un
   * \`<dialog open>\` vive fuera de ellas: al cambiar de ruta con un diálogo
   * abierto —o al pulsar «Revisarlas en la agenda» desde el repaso, que es un
   * enlace de hash dentro del propio diálogo— el diálogo seguía flotando
   * encima de una pantalla que no tiene nada que ver con él, con su formulario
   * a medias y sus datos de otra sección.
   *
   * Se cierran ANTES de pintar la ruta nueva, y sin robarle el foco: la
   * bandera se lee en el manejador de \`close\` de \`wireFocoDialogo\`.
   */
  var cerrandoPorCambioDeRuta = false;

  function cerrarDialogosAbiertos() {
    cerrandoPorCambioDeRuta = true;
    try {
      // De uno en uno, volviendo a preguntar: es el único selector de
      // documento que esta consola usa (\`dialog[open]\`, el mismo del
      // manejador de Escape). La guarda impide un bucle infinito si algún día
      // un \`close()\` no cerrara de verdad.
      for (var i = 0; i < 20; i += 1) {
        var abierto = document.querySelector('dialog[open]');
        if (!abierto || typeof abierto.close !== 'function') break;
        abierto.close();
        if (abierto.open) break;
      }
    } finally {
      cerrandoPorCambioDeRuta = false;
    }
  }

  /** El manejador de \`hashchange\`: primero se recoge la mesa, luego se pinta. */
  function alCambiarElHash() {
    cerrarDialogosAbiertos();
    applyRoute();
  }

  function abrirDialogo(dialogId, tituloId, disparador) {
    disparadorDialogo[dialogId] = disparador || null;
    byId(dialogId).showModal();
    byId(tituloId).focus();
  }

  function wireFocoDialogo(dialogId) {
    byId(dialogId).addEventListener('close', function () {
      var origen = disparadorDialogo[dialogId];
      disparadorDialogo[dialogId] = null;
      // Un disparador que ya no está en la página (la fila desapareció
      // mientras el diálogo estaba abierto) no puede recibir el foco: se va
      // al título de la vista, que existe para esto.
      //
      // LA PREGUNTA SE HACE CON \`isConnected\`, NO CON \`parentNode\`. No es un
      // cambio cosmético: un nodo que se quita del documento JUNTO CON SU
      // SUBÁRBOL conserva su \`parentNode\` —el padre desprendido— y pasaría por
      // vivo. Si eso ocurriera, se le pediría el foco a un nodo huérfano,
      // \`focus()\` no haría nada, el repuesto de abajo no llegaría a ejecutarse
      // nunca y el foco caería al \`<body>\`. Hoy esta consola no reemplaza esos
      // nodos al sondear —comprobado en navegador real, doce segundos con un
      // diálogo abierto sin un solo cambio de nodo—, así que la diferencia no
      // se nota; la comprobación correcta se deja escrita para que siga sin
      // notarse el día que sí los reemplace.
      // V3-7 — si este cierre lo ha provocado un CAMBIO DE RUTA, el foco no
      // se toca: la ruta nueva acaba de colocarlo donde le corresponde
      // (\`applyRoute\`, §R15 A3) y devolverlo al disparador dejaría al
      // operador leyendo una pantalla con el foco puesto en otra.
      if (cerrandoPorCambioDeRuta) return;
      if (origen && origen.focus && origen.isConnected) origen.focus();
      else byId('tx-view-title').focus({ preventScroll: true });
    });
  }

  // =====================================================================
  // LISTA DE ESPERA (step 17 §9) — INICIO DEL BLOQUE
  //
  // REGLA DURA DE TODO ESTE BLOQUE (criterio 20 del §12 y riesgo 14.1 del
  // diseño): aquí NO se deriva nada de negocio. Todo lo que se pinta llega
  // ya resuelto en \`snap.waitlist\`: etiquetas de estado, resúmenes de
  // preferencia, validez de la oferta, motivos de incompatibilidad,
  // comandos disponibles, textos de auditoría y las frases de las no-reglas
  // del §5. No se llama a resolveVenueDay ni a venueWeekdayHours, no se
  // resuelve ningún horario, no se decide qué puede hacerse con una entrada
  // y no se compone ninguna frase sobre lo que este sistema se niega a
  // decidir: esas se leen de \`waitlist.copy\`, su única fuente de verdad.
  // =====================================================================

  /**
   * Qué dice cada botón de acción. El comando lo decide el SERVIDOR
   * (\`entry.availableCommands\`); esto es sólo su nombre en castellano, y
   * los verbos dicen quién hace qué: el operador ANOTA lo que la persona ha
   * contestado, el sistema no responde por nadie (§5.5).
   */
  var COMANDO_ETIQUETAS = {
    simulate_notice: 'Simular aviso',
    record_acceptance: 'Anotar que ha aceptado',
    record_decline: 'Anotar que ha dicho que no',
    release_match: 'Retirar la oferta',
    withdraw: 'Retirar de la lista',
    expire_manually: 'Marcar como caducada',
    reopen: 'Volver a activar',
    convert: 'Crear la reserva'
  };

  /**
   * (Reparación R2-UX, defecto 1) LOS DOS COMANDOS QUE NO SON DE ESTA FILA.
   *
   * step 23 añadió \`approve_proposal\` y \`take_over_proposal\` a la tabla de
   * comandos por estado, así que empezaron a llegar en \`availableCommands\` de
   * toda entrada \`pendiente\` o \`emparejada\`. La columna «Qué puedes hacer»
   * los pintaba con el nombre CRUDO —el fallback \`|| cmd\`— y Bruno leía
   * literalmente \`take_over_proposal\` en una consola en castellano.
   *
   * No se relabelan aquí, se RETIRAN de esta superficie, por dos razones que
   * apuntan igual: (a) los dos se aprueban POR HUECO y esta fila no sabe de
   * qué hueco habla, así que el botón mandaba el comando sin \`slotKey\` y sólo
   * podía devolver un 400; (b) su superficie de verdad es la tarjeta del
   * hueco (§8.3), donde ya viven con nombre en castellano, con el contexto
   * del hueco y con la previsualización de lo que hacen.
   */
  var COMANDOS_DE_HUECO = ['approve_proposal', 'take_over_proposal'];

  /**
   * (Reparación R2-UX, defecto 1) EL VOCABULARIO ES CERRADO, y esto es lo que
   * lo cierra: un comando sin nombre en castellano NO SE PINTA. El fallback
   * anterior convertía cualquier identificador interno nuevo en texto visible
   * sin que nadie se enterara; ahora un comando que el servidor añada y esta
   * pantalla no conozca desaparece de la fila —se nota, y se arregla— en vez
   * de filtrarse a la cara del operador.
   */
  function accionesHumanasDe(comandos) {
    return (comandos || []).filter(function (c) {
      return COMANDOS_DE_HUECO.indexOf(c) === -1 && typeof COMANDO_ETIQUETAS[c] === 'string';
    });
  }

  /**
   * El filtro de "Personas apuntadas". Los tres grupos son EXACTAMENTE la
   * tabla de §2.1 del diseño (activo / latente / terminal) y una prueba los
   * fija contra ella. Agrupar para filtrar no es decidir nada: el estado de
   * cada entrada lo dice el servidor y esta pantalla no lo cambia ni lo
   * deduce.
   */
  var ESTADOS_POR_GRUPO = {
    activas: ['pending', 'matched', 'notice_simulated', 'accepted'],
    latentes: ['declined', 'expired_manually'],
    cerradas: ['converted', 'withdrawn']
  };

  /** El glifo de cada tono de píldora, para que el estado nunca lo lleve sólo el color (§9.7). */
  var GLIFO_POR_TONO = { ok: '✓', attention: '!', derived: '→', incomplete: '○', none: '—' };

  /** Las cifras del §11, en el orden en que se leen. Ninguna es un contador: todas las deriva el servidor. */
  var CIFRAS_LISTA_ESPERA = [
    ['waitlistOptInsRecorded', 'Altas en la lista (simuladas)'],
    ['waitlistOptInsDeclined', 'Personas que no quisieron apuntarse'],
    ['slotsReleasedTotal', 'Huecos liberados'],
    ['slotsReleasedWithCompatibles', 'Huecos liberados con alguien que encaja'],
    ['noticesSimulated', 'Avisos simulados'],
    ['conversions', 'Convertidos en reserva sintética'],
    ['lateCancellationsUnderReview', 'Cancelaciones fuera de plazo pendientes de revisar'],
    ['actionsRequiringAPerson', 'Acciones que ha necesitado una persona'],
    ['conversionConflictsPrevented', 'Dobles reservas evitadas'],
    ['idempotentReplays', 'Peticiones repetidas que no hicieron nada nuevo'],
    ['injectedFailuresHandled', 'Fallos inyectados que no escribieron nada'],
    ['unfilledReleasedSlotMinutes', 'Minutos de agenda liberados que siguen sin cubrir']
  ];

  var listaEsperaFiltro = 'activas';
  /** A quién ha elegido una persona para cada hueco. Vacío = sin preselección (§5.1). */
  var huecoSeleccion = {};
  /** El interruptor de Laboratorio. Sólo lo mueve quien lo pulsa; nunca el sondeo. */
  var inyectarFalloConversion = false;

  function entradaPorId(w, id) {
    for (var i = 0; i < w.entries.length; i += 1) {
      if (w.entries[i].id === id) return w.entries[i];
    }
    return null;
  }

  function pillDeEntrada(entry) {
    return buildPillEl({ label: entry.stateLabel, modifier: entry.stateTone, glyph: GLIFO_POR_TONO[entry.stateTone] || '—' });
  }

  function renderListaEspera(snap) {
    // El estado "cargando" desaparece con la primera instantánea que llega:
    // esta función sólo se ejecuta cuando hay una.
    setHidden(byId('lista-espera-cargando'), true);
    var w = snap.waitlist;
    if (!w) return;
    renderHuecosPendientes(w);
    renderCancelacionesTardias(w);
    renderPersonasApuntadas(w);
    renderPlazoCancelacion(w);
    renderCifrasListaEspera(w);
    renderHistorialTecnico(w);
    renderIntegridad(w);
  }

  // ---- Bloque 1: huecos liberados que esperan una decisión ---------------

  function renderHuecosPendientes(w) {
    var pendientes = w.releasedSlots.filter(function (s) { return s.decisionPending; });
    setText(byId('le-huecos-contador'), pendientes.length > 0 ? '(' + String(pendientes.length) + ')' : '');
    setHidden(byId('le-huecos-vacio'), pendientes.length > 0);
    setHidden(byId('le-huecos-orden'), pendientes.length === 0);
    reconcileList(byId('le-huecos-lista'), pendientes, function (s) { return s.key; }, function (slot, existing) {
      return buildTarjetaHueco(w, slot, existing);
    });
  }

  /**
   * (step 23 §8.3) LA SUPERFICIE DE REVISIÓN de un hueco, en este orden:
   *
   *   0 hora y profesional · 1 por qué se liberó · 2 EL BLOQUE DE PROPUESTA
   *   (píldora con texto, quién, por qué, el recordatorio de que es una
   *   sugerencia, sus motivos de invalidez y «Aprobar la propuesta») ·
   *   3 la línea de «nadie propuesto» · 4 la frase de cuántos encajan ·
   *   5 «Ver las demás personas compatibles y elegir a otra» · 6 «Simular
   *   aviso a esta persona» · 7 por qué ese botón está apagado, EN TEXTO ·
   *   8 «Por qué el resto no encaja» · 9 lo que ha pasado con este hueco.
   *
   * «DEJARLA PENDIENTE» NO ES UN BOTÓN, y no lo será: pendiente es el estado
   * de partida, así que dejarla pendiente es no pulsar nada. Un control que
   * escribiera «pendiente» simularía una decisión que nadie ha tomado.
   *
   * La estructura se construye UNA vez y se ACTUALIZA en cada sondeo: los
   * botones y el enlace no se reconstruyen, para que el sondeo de 2 s no le
   * quite el foco a quien esté encima de ellos.
   */
  function buildTarjetaHueco(w, slot, existing) {
    var card = existing || (function () {
      var node = el('article', 'tx-slot-card');
      node.appendChild(el('h3', '', ''));
      node.appendChild(el('p', 'tx-context__note', 'Se liberó porque se canceló una cita.'));

      // 2 — el bloque de propuesta.
      var prop = el('div', 'tx-slot-card__proposal');
      prop.appendChild(el('div', ''));                        // 0 píldora
      prop.appendChild(el('p', 'tx-context__note', ''));      // 1 rótulo «Destinatario actual…»
      prop.appendChild(el('p', 'tx-slot-card__recipient', '')); // 2 QUIÉN lo tiene ahora
      prop.appendChild(el('p', 'tx-slot-card__done', ''));    // 3 la sustitución, confirmada y persistente
      prop.appendChild(el('p', 'tx-context__note', ''));      // 4 por qué (razón del servidor)
      prop.appendChild(el('p', 'tx-context__note', ''));      // 5 qué falta desde este peldaño
      prop.appendChild(el('p', 'tx-context__note', ''));      // 6 motivos de invalidez
      var aprobar = el('button', 'tx-btn tx-btn--primary', 'Aprobar la propuesta');
      aprobar.type = 'button';
      prop.appendChild(aprobar);                              // 7 aprobar
      node.appendChild(prop);

      node.appendChild(el('p', 'tx-context__note', ''));      // 3 sin propuesta
      node.appendChild(el('p', 'tx-slot-card__lead', ''));    // 4 cuántos encajan

      // 5 — las demás compatibles, por divulgación progresiva.
      var otras = document.createElement('details');
      otras.className = 'tx-details';
      otras.appendChild(el('summary', '', 'Ver las demás personas compatibles y elegir a otra'));
      var cuerpoOtras = el('div', 'tx-details__body');
      var grupo = document.createElement('fieldset');
      grupo.className = 'tx-slot-card__choice';
      // (Reparación R2-UX, defecto 5) La leyenda ya no dice «elige a quién se
      // le ofrece», que sonaba a que aquí vivía el destinatario. Dice lo que
      // esta lista es: ALTERNATIVAS. Quién tiene el hueco se lee arriba, con
      // su rótulo, y no se puede confundir con una de estas filas.
      grupo.appendChild(el('legend', '', 'Alternativas a esa persona para este mismo hueco'));
      grupo.appendChild(el('p', 'tx-context__note', ''));      // 1 «estas personas NO tienen el hueco»
      grupo.appendChild(el('div', 'tx-slot-card__options', '')); // 2 los radios
      cuerpoOtras.appendChild(grupo);
      cuerpoOtras.appendChild(el('p', 'tx-context__note', ''));  // 1 orden de lectura
      cuerpoOtras.appendChild(el('p', 'tx-slot-card__preview', '')); // 2 QUÉ va a pasar si confirmas
      // (Reparación R2-UX, defecto 6) La etiqueta cuenta el efecto ENTERO.
      // \`take_over_proposal\` sustituye Y aprueba en el mismo acto (§5.1), y
      // «Proponer a esta persona en su lugar» sólo contaba la mitad.
      var sustituir = el('button', 'tx-btn tx-btn--secondary', 'Sustituir y aprobar esta propuesta');
      sustituir.type = 'button';
      sustituir.disabled = true;
      cuerpoOtras.appendChild(sustituir);                       // 3 el botón
      otras.appendChild(cuerpoOtras);
      node.appendChild(otras);

      var btn = el('button', 'tx-btn tx-btn--primary', 'Simular aviso a esta persona');
      btn.type = 'button';
      btn.disabled = true;
      node.appendChild(btn);                                  // 6 simular aviso
      node.appendChild(el('p', 'tx-context__note', ''));      // 7 por qué está apagado

      var det = document.createElement('details');
      det.className = 'tx-details';
      det.appendChild(el('summary', '', 'Por qué el resto no encaja'));
      var body = el('div', 'tx-details__body');
      body.appendChild(el('ul', '', ''));
      det.appendChild(body);
      node.appendChild(det);                                  // 8 incompatibles

      var hist = document.createElement('details');
      hist.className = 'tx-details';
      hist.appendChild(el('summary', '', 'Lo que ha pasado con este hueco'));
      var histBody = el('div', 'tx-details__body');
      histBody.appendChild(el('ul', 'tx-activity-list', ''));
      hist.appendChild(histBody);
      node.appendChild(hist);                                 // 9 historial contextual
      return node;
    })();

    setText(card.children[0], slot.label);

    // ---- 2. El bloque de propuesta -------------------------------------
    var propuesta = slot.proposal;
    var bloque = card.children[2];
    setHidden(bloque, !propuesta);
    setHidden(card.children[3], !!propuesta);
    if (propuesta) {
      var sujeto = entradaPorId(w, propuesta.entryId);
      var pildora = bloque.children[0];
      clearChildren(pildora);
      pildora.appendChild(buildPildoraDeTexto(propuesta.statusLabel, propuesta.statusTone));
      // (Reparación R2-UX, defecto 5) EL DESTINATARIO ACTUAL, ROTULADO. Sin
      // el rótulo, el nombre de arriba y los nombres de la lista de abajo se
      // leían igual, y sustituir por error era cuestión de un clic.
      setText(bloque.children[1], w.copy.currentRecipientHeading);
      setText(bloque.children[2], propuesta.clientLabel + (sujeto ? ' · ' + sujeto.preferenceSummary : ''));
      // (Reparación R2-UX, defectos 3 y 7) La sustitución, confirmada donde
      // se hizo y sin depender de que nadie haya visto pasar la línea de
      // estado. La escribe el SERVIDOR, así que el sondeo la repinta idéntica
      // —no es una región viva y no vuelve a anunciar nada.
      setHidden(bloque.children[3], !propuesta.substitutionNote);
      setText(bloque.children[3], propuesta.substitutionNote || '');
      // La razón, LITERAL y del servidor. El navegador no la compone ni la
      // matiza: si dijera algo distinto de lo que hizo la regla, la pantalla
      // estaría explicando una decisión que no es la que se tomó.
      setText(bloque.children[4], propuesta.reasonLabel);
      // (Reparación R2-UX, defecto 4) QUÉ FALTA, SEGÚN EL PELDAÑO REAL. Antes
      // era una frase constante que, junto a la píldora «Aprobada», volvía a
      // pedir la aprobación que acababa de ocurrir.
      setText(bloque.children[5], propuesta.stageNote);
      var motivos = propuesta.invalidReasons.map(function (r) { return r.label; }).join(' · ');
      setHidden(bloque.children[6], motivos === '');
      setText(bloque.children[6], motivos === '' ? '' : 'Ya no vale: ' + motivos + '.');
      var botonAprobar = bloque.children[7];
      botonAprobar.disabled = !propuesta.canApprove;
      botonAprobar.onclick = function () {
        lanzarComandoDeHueco(slot, propuesta.entryId, 'approve_proposal',
          'Propuesta aprobada para ' + propuesta.clientLabel + '. Hueco: ' + slot.label + '. ' + w.copy.approvalEffectsAfter,
          botonAprobar, null);
      };
    } else {
      setText(card.children[3], w.copy.noneFit + ' ' + w.copy.readingOrderNote);
    }

    // ---- 4. Cuántos encajan (frase compuesta por el servidor) -----------
    var candidatos = [];
    slot.compatibleEntryIds.forEach(function (id) {
      var entrada = entradaPorId(w, id);
      if (entrada) candidatos.push(entrada);
    });
    setText(card.children[4], candidatos.length > 1
      ? w.copy.severalFit
      : (candidatos.length === 1 ? w.copy.oneFits : w.copy.noneFit));

    // ---- 5. Las demás compatibles y la sustitución ----------------------
    // La lista se restringe a substitutableEntryIds: son las que el servidor
    // ACEPTARÍA como sustitutas (§3.1). Ofrecer aquí a alguien a quien va a
    // rechazar sería un radio que sólo puede llevar a un 409.
    var sustituibles = [];
    slot.substitutableEntryIds.forEach(function (id) {
      var entrada = entradaPorId(w, id);
      if (entrada) sustituibles.push(entrada);
    });
    var otrasDetalle = card.children[5];
    setHidden(otrasDetalle, sustituibles.length === 0);
    var cuerpo = otrasDetalle.children[1];
    setText(cuerpo.children[0].children[1], w.copy.alternativesAreNotCurrent);
    setText(cuerpo.children[1], slot.readingOrderNote);

    var opciones = cuerpo.children[0].children[2];
    var nombreGrupo = 'hueco-' + slot.key;
    reconcileList(opciones, sustituibles, function (e) { return e.id; }, function (entry, existingOpt) {
      var etiqueta = existingOpt || (function () {
        var l = el('label', 'tx-radio-field');
        var input = document.createElement('input');
        input.type = 'radio';
        l.appendChild(input);
        l.appendChild(el('span', '', ''));
        return l;
      })();
      var radio = etiqueta.children[0];
      radio.name = nombreGrupo;
      radio.value = entry.id;
      radio.setAttribute('name', nombreGrupo);
      radio.setAttribute('value', entry.id);
      // (step 23 §9) Sin preselección en esta lista: la sugerencia del
      // sistema vive arriba, etiquetada y pendiente de aprobación (§8.3);
      // aquí no hay nada marcado salvo lo que marque una persona. Y esa
      // elección sobrevive al sondeo porque vive aquí fuera, no en el DOM.
      var elegido = huecoSeleccion[slot.key] === entry.id;
      if (radio.checked !== elegido) radio.checked = elegido;
      radio.onchange = function () {
        huecoSeleccion[slot.key] = entry.id;
        actualizarBotonHueco(w, card, slot, sustituibles);
      };
      setText(etiqueta.children[1], entry.clientLabel + ' · ' + entry.preferenceSummary + ' · ' + entry.optInLabel +
        ' · se apuntó el ' + formatDateTimeLong(entry.createdAtISO));
      return etiqueta;
    });

    actualizarBotonHueco(w, card, slot, sustituibles);
    var botonSustituir = cuerpo.children[3];
    botonSustituir.onclick = function () {
      var elegido = huecoSeleccion[slot.key];
      var entrada = elegido ? entradaPorId(w, elegido) : null;
      if (!entrada) return;
      // (Reparación R2-UX, defecto 3) EL MENSAJE NOMBRA A LAS DOS PERSONAS,
      // dice EN QUÉ HUECO, dice quién es el destinatario a partir de ahora y
      // no inventa ni un aviso, ni una aceptación, ni una reserva.
      var anterior = propuesta ? propuesta.clientLabel : null;
      var frase = anterior
        ? entrada.clientLabel + ' ha sustituido a ' + anterior + ' para esta propuesta.'
        : entrada.clientLabel + ' pasa a ser el destinatario de esta propuesta.';
      lanzarComandoDeHueco(slot, entrada.id, 'take_over_proposal',
        frase + ' Hueco: ' + slot.label + '. Destinatario actual: ' + entrada.clientLabel + '. ' +
        w.copy.substitutionEffectsAfter,
        botonSustituir,
        // (Reparación R2-UX, defecto 5) El control SE LIMPIA al terminar: la
        // elección deja de estar guardada y el desplegable se cierra. Dejarlo
        // abierto con la marca puesta era invitar a deshacer la sustitución
        // sin querer, porque el siguiente clic caía sobre un control que
        // parecía seguir describiendo el estado actual.
        function () {
          delete huecoSeleccion[slot.key];
          otrasDetalle.open = false;
        });
    };

    // ---- 6/7. Simular aviso, y su razón EN TEXTO cuando está apagado ----
    var boton = card.children[6];
    var puedeAvisar = !!(propuesta && propuesta.canSimulateNotice);
    boton.disabled = !puedeAvisar;
    setText(card.children[7], puedeAvisar ? '' : razonParaNoAvisar(propuesta));
    setHidden(card.children[7], puedeAvisar);
    boton.onclick = function () {
      if (!propuesta) return;
      var entrada = entradaPorId(w, propuesta.entryId);
      if (!entrada) return;
      abrirDialogoSimularAviso(entrada, slot.label, 'le-huecos-estado', boton);
    };

    // ---- 8. Por qué el resto no encaja ---------------------------------
    var incompatibles = slot.incompatible;
    setHidden(card.children[8], incompatibles.length === 0);
    reconcileList(card.children[8].children[1].children[0], incompatibles, function (i) { return i.entryId; }, function (item, li) {
      var node = li || el('li', '');
      var razones = item.reasons.map(function (r) { return r.label; }).join(' · ');
      setText(node, item.clientLabel + ': ' + razones);
      return node;
    });

    // ---- 9. El historial contextual de ESTE hueco -----------------------
    // Las mismas filas del rastro de Inicio, filtradas por los identificadores
    // que el servidor asocia a este hueco. La clave es la misma (wla-…), así
    // que reconciliar no puede duplicar ni reordenar nada.
    var actividad = w.activity ? w.activity.items : [];
    var propias = actividad.filter(function (i) { return slot.activityItemIds.indexOf(i.id) !== -1; });
    setHidden(card.children[9], propias.length === 0);
    reconcileList(card.children[9].children[1].children[0], propias, function (i) { return i.id; }, function (item, li) {
      var node = li || (function () {
        var fila = el('li', '');
        fila.appendChild(el('div', ''));
        var body = el('div', 'tx-activity-list__body');
        body.appendChild(el('p', 'tx-activity-list__time', ''));
        body.appendChild(el('p', '', ''));
        body.appendChild(el('p', 'tx-context__note', ''));
        fila.appendChild(body);
        return fila;
      })();
      var pildoras = node.children[0];
      clearChildren(pildoras);
      pildoras.appendChild(buildPildoraDeTexto(item.originLabel, 'none'));
      pildoras.appendChild(buildPildoraDeTexto(item.statusLabel, item.statusTone));
      setText(node.children[1].children[0], item.timeLabel);
      setText(node.children[1].children[1], item.title);
      setText(node.children[1].children[2], item.reason);
      return node;
    });
    return card;
  }

  /**
   * (step 23 §8.3, punto 5) El botón apagado LLEVA SU RAZÓN EN TEXTO. Un
   * control gris sin explicación obliga a adivinar, y aquí el motivo se sabe
   * exactamente: lo dice el servidor en la escalera de estados.
   */
  function razonParaNoAvisar(propuesta) {
    if (!propuesta) return 'Nadie está propuesto para este hueco todavía, así que no hay a quién avisar.';
    if (propuesta.statusCode === 'pending_approval') {
      return 'Primero una persona tiene que aprobar la propuesta. Hasta entonces no se avisa a nadie.';
    }
    if (propuesta.statusCode === 'invalidated') {
      return 'Esta propuesta ya no vale, así que no se puede avisar sobre ella.';
    }
    return 'Ya se ha avisado a esta persona: ' + propuesta.statusLabel + '.';
  }

  /**
   * (Reparación R2-UX, defectos 5 y 6) LA PREVISUALIZACIÓN DEL CAMBIO.
   *
   * El botón sigue apagado mientras no haya nadie marcado —eso ya estaba—,
   * pero ahora, en cuanto hay alguien marcado, la pantalla dice EXACTAMENTE
   * qué cambio se hará y con qué consecuencias, ANTES de pulsar. La frase se
   * engancha al botón por \`aria-describedby\`, así que quien navegue con
   * teclado o lector la oye al llegar al control, no después de activarlo.
   *
   * NO es una región viva a propósito: cambia sólo cuando una persona cambia
   * la marca, y un \`aria-live\` aquí se re-anunciaría con cada sondeo de 2 s.
   */
  function actualizarBotonHueco(w, card, slot, candidatos) {
    var cuerpo = card.children[5].children[1];
    var previsualizacion = cuerpo.children[2];
    var boton = cuerpo.children[3];
    var elegido = huecoSeleccion[slot.key];
    var entrada = null;
    candidatos.forEach(function (e) { if (e.id === elegido) entrada = e; });
    boton.disabled = entrada === null;

    var idPrevisualizacion = 'le-hueco-cambio-' + slot.key;
    previsualizacion.setAttribute('id', idPrevisualizacion);
    boton.setAttribute('aria-describedby', idPrevisualizacion);

    if (entrada === null) {
      setText(previsualizacion, 'Marca a una persona de esta lista para ver qué cambio se haría. Mientras no marques a nadie, no se puede sustituir.');
      return;
    }
    var actual = slot.proposal ? slot.proposal.clientLabel : null;
    setText(previsualizacion, (actual
      ? 'Vas a sustituir a ' + actual + ' por ' + entrada.clientLabel + ' en este hueco: ' + slot.label + '.'
      : 'Vas a proponer a ' + entrada.clientLabel + ' para este hueco: ' + slot.label + '.') +
      ' ' + w.copy.substitutionEffectsBefore);
  }

  /**
   * (step 23 §5) Aprobar o sustituir, por la ruta de comandos de siempre y
   * con el slotKey en el cuerpo: se aprueba UN HUECO, no «la propuesta que
   * tenga esta persona». Repetir la misma aprobación devuelve 200 y no
   * escribe nada, así que un doble clic no puede duplicar ningún estado.
   */
  function lanzarComandoDeHueco(slot, entryId, cmd, exito, boton, alTerminar) {
    var estado = byId('le-huecos-estado');
    setEstadoLinea(estado, 'Guardando…', '');
    boton.disabled = true;
    sendJson('/api/waitlist/entries/' + entryId + '/command', { command: cmd, slotKey: slot.key }, null)
      .then(function (r) {
        boton.disabled = false;
        if (!r.ok) {
          setEstadoLinea(estado, textoDeFallo(r), tonoDeFallo(r));
          refresh();
          return;
        }
        // El éxito SE DICE, entero, una sola vez y en una región de estado
        // (\`role="status"\`): el sondeo no vuelve a escribir aquí, así que no
        // puede repetir el anuncio (defecto 7). Y el control que ya cumplió su
        // función se limpia ANTES de repintar, para que el repintado lo
        // encuentre ya cerrado y sin marca (defecto 5).
        if (alTerminar) alTerminar();
        setEstadoLinea(estado, exito, 'ok');
        refresh();
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  // ---- Bloque 2: cancelaciones fuera del plazo configurado ---------------

  function renderCancelacionesTardias(w) {
    var tardias = w.cancellations.filter(function (c) { return c.reviewState === 'pending_review'; });
    setHidden(byId('le-bloque-tardias'), tardias.length === 0);
    setText(byId('le-tardias-contador'), tardias.length > 0 ? '(' + String(tardias.length) + ')' : '');
    reconcileList(byId('le-tardias-lista'), tardias, function (c) { return c.id; }, function (c, existing) {
      var card = existing || (function () {
        var node = el('article', 'tx-slot-card');
        node.appendChild(el('div', ''));
        node.appendChild(el('h3', '', ''));
        node.appendChild(el('p', '', ''));
        node.appendChild(el('p', 'tx-context__note', ''));
        var btn = el('button', 'tx-btn tx-btn--secondary', 'Marcar como revisada (sin acción)');
        btn.type = 'button';
        node.appendChild(btn);
        return node;
      })();
      var pildora = card.children[0];
      clearChildren(pildora);
      pildora.appendChild(buildPillEl({ label: c.timelinessLabel, modifier: 'attention', glyph: '!' }));
      setText(card.children[1], 'Cita del ' + c.when);
      setText(card.children[2], c.reasonLabel);
      setText(card.children[3], 'Se avisó con ' + String(c.leadMinutes) + ' minutos de antelación. El plazo aplicado en ese momento eran ' + String(c.policyMinutesAtCancellation) + ' minutos.');
      card.children[4].onclick = function () { revisarCancelacion(c.reservationId, card.children[4]); };
      return card;
    });
  }

  function revisarCancelacion(reservationId, boton) {
    var estado = byId('le-tardias-estado');
    boton.disabled = true;
    setEstadoLinea(estado, 'Guardando…', '');
    sendJson('/api/reservations/' + reservationId + '/cancellation-review', { decision: 'reviewed_no_action' }, null)
      .then(function (r) {
        boton.disabled = false;
        if (!r.ok) {
          setEstadoLinea(estado, textoDeFallo(r), tonoDeFallo(r));
          refresh();
          return;
        }
        setEstadoLinea(estado, 'Anotado: revisada, sin acción. No se ha aplicado ninguna penalización.', 'ok');
        refresh();
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  // ---- Bloque 3: personas apuntadas -------------------------------------

  function renderPersonasApuntadas(w) {
    var grupo = ESTADOS_POR_GRUPO[listaEsperaFiltro] || null;
    var visibles = w.entries.filter(function (e) { return grupo === null || grupo.indexOf(e.state) !== -1; });
    setText(byId('le-personas-contador'), '(' + String(visibles.length) + ')');
    setHidden(byId('le-personas-vacio'), w.entries.length > 0);
    setHidden(byId('le-personas-vacio-filtro'), !(w.entries.length > 0 && visibles.length === 0));
    reconcileList(byId('le-personas-tbody'), visibles, function (e) { return e.id; }, function (entry, existingTr) {
      var tr = existingTr || (function () {
        var row = document.createElement('tr');
        for (var i = 0; i < 5; i += 1) row.appendChild(document.createElement('td'));
        var estado = row.children[1];
        estado.appendChild(el('div', ''));
        estado.appendChild(el('p', 'tx-row-note', ''));
        estado.appendChild(el('p', 'tx-row-note', ''));
        estado.appendChild(el('p', 'tx-row-note', ''));
        return row;
      })();

      tr.children[0].setAttribute('data-label', 'Persona');
      setText(tr.children[0], entry.clientLabel);

      tr.children[1].setAttribute('data-label', 'Cómo está');
      var pildora = tr.children[1].children[0];
      clearChildren(pildora);
      pildora.appendChild(pillDeEntrada(entry));
      var lineaOferta = tr.children[1].children[1];
      var lineaMotivo = tr.children[1].children[2];
      var lineaAviso = tr.children[1].children[3];
      lineaMotivo.setAttribute('id', 'le-motivo-' + entry.id);
      if (entry.offer) {
        setText(lineaOferta, 'Hueco ofrecido: ' + entry.offer.slotLabel);
        setHidden(lineaOferta, false);
        if (entry.offer.stillValid) {
          setText(lineaMotivo, '');
          setHidden(lineaMotivo, true);
        } else {
          setText(lineaMotivo, 'Ese hueco ya no vale: ' + entry.offer.invalidReasons.map(function (r) { return r.label; }).join(' · '));
          setHidden(lineaMotivo, false);
        }
      } else {
        setText(lineaOferta, '');
        setHidden(lineaOferta, true);
        setText(lineaMotivo, '');
        setHidden(lineaMotivo, true);
      }
      // §5.5: donde se dice "Aviso simulado", se dice SIEMPRE debajo que no
      // se ha enviado ni llamado nada. La frase se lee de la instantánea.
      var avisado = entry.state === 'notice_simulated';
      setHidden(lineaAviso, !avisado);
      setText(lineaAviso, avisado ? w.copy.simulatedNoticeOnly : '');

      tr.children[2].setAttribute('data-label', 'Qué pidió');
      setText(tr.children[2], entry.preferenceSummary + ' · se apuntó el ' + formatDateTimeLong(entry.createdAtISO));

      tr.children[3].setAttribute('data-label', 'Cómo se apuntó');
      setText(tr.children[3], entry.optInLabel);

      tr.children[4].setAttribute('data-label', 'Qué puedes hacer');
      reconcileList(tr.children[4], accionesHumanasDe(entry.availableCommands), function (c) { return c; }, function (cmd, existingBtn) {
        var btn = existingBtn || (function () {
          var b = el('button', 'tx-btn tx-btn--secondary', '');
          b.type = 'button';
          return b;
        })();
        setText(btn, COMANDO_ETIQUETAS[cmd]);
        // Convertir se apaga cuando la oferta ha dejado de valer, y el motivo
        // queda escrito en la misma fila (§14.6). Nunca es un botón mudo.
        //
        // (Revisión adversarial de step 22, N1) La misma regla vale para los
        // OTROS dos comandos que revalidan esa misma oferta antes de hacer
        // nada: \`simulate_notice\` y \`record_acceptance\`. Con la oferta muerta
        // —el caso de quien competía por un hueco que otra persona acabó
        // convirtiendo— los tres devuelven 409 sin excepción, así que los tres
        // se apagan con su motivo al lado en vez de dejar un botón que sólo
        // puede fallar al pulsarlo.
        var revalidaLaOferta = cmd === 'convert' || cmd === 'simulate_notice' || cmd === 'record_acceptance';
        var puede = !revalidaLaOferta || (entry.offer !== null && entry.offer.stillValid);
        btn.disabled = !puede;
        btn.setAttribute('aria-describedby', 'le-motivo-' + entry.id);
        btn.onclick = function () { lanzarComandoEntrada(w, entry, cmd, btn); };
        return btn;
      });
      return tr;
    });
  }

  function lanzarComandoEntrada(w, entry, cmd, boton) {
    if (cmd === 'convert') {
      abrirDialogoConvertir(entry, boton);
      return;
    }
    if (cmd === 'simulate_notice') {
      abrirDialogoSimularAviso(entry, entry.offer ? entry.offer.slotLabel : '', 'le-personas-estado', boton);
      return;
    }
    var estado = byId('le-personas-estado');
    setEstadoLinea(estado, 'Guardando…', '');
    boton.disabled = true;
    sendJson('/api/waitlist/entries/' + entry.id + '/command', { command: cmd }, null)
      .then(function (r) {
        boton.disabled = false;
        if (!r.ok) {
          setEstadoLinea(estado, textoDeFallo(r), tonoDeFallo(r));
          refresh();
          return;
        }
        setEstadoLinea(estado, entry.clientLabel + ': ' + r.json.entry.stateLabel + '.', 'ok');
        refresh();
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  // ---- Bloque 4: plazo de cancelación -----------------------------------

  function renderPlazoCancelacion(w) {
    var sel = byId('le-plazo-select');
    var opciones = w.policy.options;
    if (sel.options.length !== opciones.length) {
      clearChildren(sel);
      opciones.forEach(function (o) {
        var opt = el('option', '', o.label);
        opt.value = String(o.minutes);
        sel.appendChild(opt);
      });
    }
    // El sondeo no le quita de las manos el desplegable a quien lo está
    // usando: si tiene el foco, su valor no se toca.
    if (document.activeElement !== sel) sel.value = String(w.policy.cancellationNoticeMinutes);
    setText(byId('le-plazo-frase'), w.policy.sentence);
    setText(byId('le-plazo-demo'), w.policy.demoNotice);
  }

  function guardarPlazo(valor) {
    var estado = byId('le-plazo-estado');
    setEstadoLinea(estado, 'Guardando…', '');
    sendJson('/api/waitlist/policy', { cancellationNoticeMinutes: Number(valor) }, null)
      .then(function (r) {
        if (!r.ok) {
          setEstadoLinea(estado, textoDeFallo(r), tonoDeFallo(r));
          refresh();
          return;
        }
        setEstadoLinea(estado, 'Plazo guardado. Las cancelaciones ya registradas se quedan como estaban.', 'ok');
        refresh();
      })
      .catch(function () { setEstadoLinea(estado, SIN_CONEXION, 'error'); });
  }

  // ---- Cifras y detalle técnico -----------------------------------------

  function renderCifrasListaEspera(w) {
    reconcileList(byId('le-cifras'), CIFRAS_LISTA_ESPERA, function (par) { return par[0]; }, function (par, existingWrap) {
      var wrap = existingWrap || (function () {
        var node = el('div', '');
        node.appendChild(el('dt', '', ''));
        node.appendChild(el('dd', '', ''));
        return node;
      })();
      setText(wrap.children[0], par[1]);
      setText(wrap.children[1], String(w.metrics[par[0]]));
      return wrap;
    });
  }

  function renderHistorialTecnico(w) {
    setText(byId('le-tecnico-historial-contador'), '(' + String(w.audit.shown) + ' de ' + String(w.audit.total) + ')');
    var items = w.audit.items.slice().reverse();
    reconcileList(byId('le-tecnico-historial'), items, function (ev) { return ev.id; }, function (ev, li) {
      var node = li || el('li', '', '');
      setText(node, String(ev.seq) + ' · ' + ev.kind + ' · ' + ev.text);
      return node;
    });
  }

  function renderIntegridad(w) {
    var banner = byId('lista-espera-integridad');
    setHidden(banner, w.integrity.ok);
    if (w.integrity.ok) return;
    setText(byId('lista-espera-integridad-detalle'),
      'Conversiones que anunciaron una reserva que no existe: ' + String(w.integrity.falseSuccesses) +
      '. Huecos convertidos más de una vez: ' + String(w.integrity.doubleBookedSlotKeys.length) + '.');
  }

  // ---- Diálogo: apuntar a alguien ---------------------------------------

  var LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function wireAltaListaDialog() {
    wireFocoDialogo('dialogo-alta-lista');
    var etiquetas = byId('alta-etiqueta');
    for (var i = 0; i < LETRAS.length; i += 1) {
      var opt = el('option', '', 'Cliente ' + LETRAS.charAt(i));
      opt.value = 'Cliente ' + LETRAS.charAt(i);
      etiquetas.appendChild(opt);
    }
    var servicios = byId('alta-servicio');
    Object.keys(SERVICE_LABELS).forEach(function (id) {
      var opt = el('option', '', SERVICE_LABELS[id]);
      opt.value = String(id);
      servicios.appendChild(opt);
    });
    byId('alta-optin').addEventListener('change', function (ev) {
      byId('alta-lista-guardar').disabled = !ev.target.checked;
    });
    byId('alta-lista-cancelar').addEventListener('click', function () { byId('dialogo-alta-lista').close(); });
    byId('alta-lista-cerrar').addEventListener('click', function () { byId('dialogo-alta-lista').close(); });
    byId('alta-lista-guardar').addEventListener('click', guardarAlta);
    byId('alta-lista-rechazo').addEventListener('click', guardarRechazoDeAlta);
  }

  function abrirDialogoAlta(disparador) {
    byId('alta-desde').value = '';
    byId('alta-hasta').value = '';
    byId('alta-desde-hora').value = '';
    byId('alta-hasta-hora').value = '';
    byId('alta-optin').checked = false;
    byId('alta-lista-guardar').disabled = true;
    limpiarLinea(byId('alta-lista-error'));
    limpiarLinea(byId('alta-lista-resultado'));
    setHidden(byId('alta-lista-paso-1'), false);
    setHidden(byId('alta-lista-paso-2'), true);
    if (latestSnapshot) {
      ensureProfessionalOptions(byId('alta-profesional'), latestSnapshot.calendar.professionals, 'Cualquiera');
    }
    abrirDialogo('dialogo-alta-lista', 'dialogo-alta-lista-titulo', disparador);
  }

  function minutosDeHora(texto) {
    if (!/^\\d{2}:\\d{2}$/.test(texto)) return null;
    var partes = texto.split(':');
    return Number(partes[0]) * 60 + Number(partes[1]);
  }

  function recogerAlta() {
    var origen = document.querySelector('input[name="alta-origen"]:checked');
    var desde = byId('alta-desde').value;
    var hasta = byId('alta-hasta').value;
    var desdeHora = minutosDeHora(byId('alta-desde-hora').value.trim());
    var hastaHora = minutosDeHora(byId('alta-hasta-hora').value.trim());
    if (!desde || !hasta) return { error: 'Rellena los dos días antes de continuar.' };
    if (hasta < desde) return { error: 'El último día no puede ser anterior al primero.' };
    if (desdeHora === null || hastaHora === null) return { error: 'Escribe las horas como HH:mm. Por ejemplo, 09:30.' };
    if (hastaHora <= desdeHora) return { error: 'La hora final tiene que ser posterior a la inicial.' };
    if (!origen) return { error: 'Di cómo se ha apuntado esta persona.' };
    var profesional = byId('alta-profesional').value;
    return {
      body: {
        clientLabel: byId('alta-etiqueta').value,
        serviceId: Number(byId('alta-servicio').value),
        dateFrom: desde,
        dateTo: hasta,
        earliestStartMinutes: desdeHora,
        latestStartMinutes: hastaHora,
        professional: profesional === '' ? { kind: 'any' } : { kind: 'specific', employeeId: Number(profesional) },
        optInSource: origen.value,
        // Literal true, nunca una casilla opcional: sin este sí explícito la
        // petición ni siquiera se construye.
        optInConfirmed: true
      }
    };
  }

  function guardarAlta() {
    var boton = byId('alta-lista-guardar');
    if (boton.disabled) return;
    var recogido = recogerAlta();
    if (recogido.error) {
      setEstadoLinea(byId('alta-lista-error'), recogido.error, 'error');
      return;
    }
    limpiarLinea(byId('alta-lista-error'));
    boton.disabled = true;
    sendJson('/api/waitlist/entries', recogido.body, null)
      .then(function (r) {
        boton.disabled = false;
        if (!r.ok) {
          setEstadoLinea(byId('alta-lista-error'), textoDeFallo(r), tonoDeFallo(r));
          return;
        }
        setHidden(byId('alta-lista-paso-1'), true);
        setHidden(byId('alta-lista-paso-2'), false);
        setEstadoLinea(byId('alta-lista-resultado'),
          r.json.entry.clientLabel + ' está en la lista de espera. Cómo está: ' + r.json.entry.stateLabel + '.', 'ok');
        refresh();
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(byId('alta-lista-error'), SIN_CONEXION, 'error');
      });
  }

  function guardarRechazoDeAlta() {
    var etiqueta = byId('alta-etiqueta').value;
    var boton = byId('alta-lista-rechazo');
    boton.disabled = true;
    sendJson('/api/waitlist/opt-in-declined', { clientLabel: etiqueta }, null)
      .then(function (r) {
        boton.disabled = false;
        if (!r.ok) {
          setEstadoLinea(byId('alta-lista-error'), textoDeFallo(r), tonoDeFallo(r));
          return;
        }
        setHidden(byId('alta-lista-paso-1'), true);
        setHidden(byId('alta-lista-paso-2'), false);
        setEstadoLinea(byId('alta-lista-resultado'),
          'Queda anotado que ' + etiqueta + ' no ha querido apuntarse. No se ha guardado ninguna entrada.', 'ok');
        refresh();
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(byId('alta-lista-error'), SIN_CONEXION, 'error');
      });
  }

  // ---- Diálogo: simular un aviso ----------------------------------------

  var simularAvisoState = { entryId: null, destino: 'le-huecos-estado', etiqueta: '' };

  function wireSimularAvisoDialog() {
    wireFocoDialogo('dialogo-simular-aviso');
    byId('simular-aviso-cancelar').addEventListener('click', function () { byId('dialogo-simular-aviso').close(); });
    byId('simular-aviso-confirmar').addEventListener('click', confirmarSimularAviso);
  }

  function abrirDialogoSimularAviso(entry, slotLabel, destinoId, disparador) {
    simularAvisoState = { entryId: entry.id, destino: destinoId, etiqueta: entry.clientLabel };
    setText(byId('simular-aviso-resumen'), entry.clientLabel + ' · ' + (slotLabel || 'el hueco ofrecido'));
    setEstadoLinea(byId('simular-aviso-estado'), '', '');
    byId('simular-aviso-confirmar').disabled = false;
    abrirDialogo('dialogo-simular-aviso', 'dialogo-simular-aviso-titulo', disparador);
  }

  function confirmarSimularAviso() {
    var boton = byId('simular-aviso-confirmar');
    var estado = byId('simular-aviso-estado');
    boton.disabled = true;
    setEstadoLinea(estado, 'Guardando…', '');
    sendJson('/api/waitlist/entries/' + simularAvisoState.entryId + '/command', { command: 'simulate_notice' }, null)
      .then(function (r) {
        boton.disabled = false;
        if (!r.ok) {
          // Un conflicto NO cierra el diálogo: quien lo abrió tiene que leer
          // por qué no se ha hecho (§6.10 del sistema visual).
          setEstadoLinea(estado, textoDeFallo(r), tonoDeFallo(r));
          refresh();
          return;
        }
        setEstadoLinea(byId(simularAvisoState.destino),
          'Aviso simulado a ' + simularAvisoState.etiqueta + '. No se ha enviado ningún mensaje ni se ha llamado a nadie.', 'ok');
        byId('dialogo-simular-aviso').close();
        refresh();
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  // ---- Diálogo: convertir en reserva sintética ---------------------------

  var convertirState = { entryId: null, slotKey: null, etiqueta: '', slotLabel: '' };

  function wireConvertirDialog() {
    wireFocoDialogo('dialogo-convertir');
    byId('convertir-cancelar').addEventListener('click', function () { byId('dialogo-convertir').close(); });
    byId('convertir-confirmar').addEventListener('click', confirmarConvertir);
  }

  function abrirDialogoConvertir(entry, disparador) {
    if (!entry.offer) return;
    convertirState = { entryId: entry.id, slotKey: entry.offer.slotKey, etiqueta: entry.clientLabel, slotLabel: entry.offer.slotLabel };
    setText(byId('convertir-resumen'), entry.clientLabel + ' · ' + entry.offer.slotLabel);
    setHidden(byId('convertir-inyeccion'), !inyectarFalloConversion);
    setEstadoLinea(byId('convertir-estado'), '', '');
    byId('convertir-confirmar').disabled = false;
    abrirDialogo('dialogo-convertir', 'dialogo-convertir-titulo', disparador);
  }

  function confirmarConvertir() {
    var boton = byId('convertir-confirmar');
    var estado = byId('convertir-estado');
    var cuerpo = { slotKey: convertirState.slotKey, confirmed: true };
    if (inyectarFalloConversion) cuerpo.injectFailure = true;
    boton.disabled = true;
    setEstadoLinea(estado, 'Creando la reserva…', '');
    // La clave la acuña la INTENCIÓN (§6.2): la misma entrada y el mismo
    // hueco dan siempre la misma clave, así que un doble clic no puede
    // crear dos reservas.
    sendJson('/api/waitlist/entries/' + convertirState.entryId + '/convert', cuerpo,
      'convert:' + convertirState.entryId + ':' + convertirState.slotKey)
      .then(function (r) {
        boton.disabled = false;
        if (!r.ok) {
          setEstadoLinea(estado, textoDeFallo(r), tonoDeFallo(r));
          refresh();
          return;
        }
        setEstadoLinea(byId('le-personas-estado'), r.repetida
          ? 'Esta reserva ya estaba creada: se ha devuelto el resultado anterior y no se ha hecho nada nuevo.'
          : ('Reserva sintética creada para ' + convertirState.etiqueta + ': ' + convertirState.slotLabel + '.'), 'ok');
        byId('dialogo-convertir').close();
        refresh();
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  // ---- Cableado de la pantalla ------------------------------------------

  function wireListaEsperaControls() {
    byId('le-filtro-estado').addEventListener('change', function (ev) {
      listaEsperaFiltro = ev.target.value;
      renderActiveSection();
    });
    byId('le-plazo-select').addEventListener('change', function (ev) { guardarPlazo(ev.target.value); });
    byId('btn-abrir-alta-lista').addEventListener('click', function () {
      abrirDialogoAlta(byId('btn-abrir-alta-lista'));
    });
  }

  // =====================================================================
  // LISTA DE ESPERA — FIN DEL BLOQUE
  // =====================================================================

  // ---------------------------------------------------------------------
  // LABORATORIO
  // ---------------------------------------------------------------------

  var SCENARIO_EXAMPLES = [
    {
      label: 'Reserva con un profesional concreto',
      scenarioId: 'A20-console-reserva-concreta',
      turns: [{ utterance: 'quiero reservar una cita', day: 'tuesday', time: '11:00', professionalId: 3, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true }]
    },
    {
      label: 'Consulta de disponibilidad',
      scenarioId: 'A21-console-consulta-disponibilidad',
      turns: [{ utterance: 'quiero consultar disponibilidad', day: 'tuesday', time: '11:00', professionalId: 3, serviceId: 1, serviceConfirmed: true }]
    },
    {
      label: 'Urgencia pide ayuda humana',
      scenarioId: 'A22-console-urgencia',
      turns: [{ utterance: 'es urgente, necesito ayuda humana ya', urgent: true }]
    },
    {
      label: 'Fallo técnico inyectado (nunca anuncia éxito)',
      scenarioId: 'A23-console-fallo-tecnico',
      turns: [{ utterance: 'quiero reservar una cita', day: 'tuesday', time: '11:00', professionalId: 3, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true, injectFailure: true }]
    },
    {
      label: 'Servicio especial (deriva a una persona)',
      scenarioId: 'A24-console-servicio-especial',
      turns: [{ utterance: 'quiero tenirme el pelo, hacerme color' }]
    }
  ];

  /**
   * D1 (step 14 repair): pure line-building for the Laboratorio result
   * panel, extracted so it can be tested without a DOM (see
   * tests/console/uiClientExtract.ts and uiClientLogic.test.ts).
   *
   * THE BUG THIS REPLACES: the previous code printed the label
   * \`internalReasonCode:\` next to the VALUE of \`json.reasonCode\` (the
   * FROZEN external code) — a copy-paste that made every
   * \`BOOKING_NOT_CONFIRMED\` call display, under the internal-code label,
   * the exact false attribution (\`INTENT_NOT_UNDERSTOOD\`) that
   * outcomeDimension.ts exists to abolish. Both lines below now read their
   * OWN field (\`json.reasonCode\` / \`json.internalReasonCode\`), and use the
   * SAME two Spanish labels as the "Detalle técnico" panel built by
   * renderCallDetail() below ('Código congelado (reasonCode)' / 'Código
   * interno') so a technical reader sees two clearly different labels, not
   * two differently-cased spellings of the same word.
   */
  function laboratorioSummaryLines(json) {
    return [
      'outcome: ' + json.outcome + ' · Código congelado (reasonCode): ' + json.reasonCode,
      'Código interno (internalReasonCode): ' + (json.internalReasonCode || '—') + ' · announcesSuccess: ' + String(json.announcesSuccess),
      'finalState: ' + json.finalState
    ];
  }

  function wireLaboratorioControls() {
    var select = byId('ejemplo-escenario');
    var placeholder = el('option', '', '(elige un ejemplo para cargarlo)');
    placeholder.value = '';
    select.appendChild(placeholder);
    SCENARIO_EXAMPLES.forEach(function (example, idx) {
      var opt = el('option', '', example.label);
      opt.value = String(idx);
      select.appendChild(opt);
    });
    select.addEventListener('change', function () {
      if (select.value === '') return;
      var example = SCENARIO_EXAMPLES[Number(select.value)];
      byId('campo-scenario-id').value = example.scenarioId;
      byId('campo-turnos').value = JSON.stringify(example.turns, null, 2);
    });

    byId('form-escenario').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var scenarioId = byId('campo-scenario-id').value.trim();
      var callId = byId('campo-call-id').value.trim();
      var liveTransferAvailable = byId('campo-transferencia-disponible').checked;
      var turnsRaw = byId('campo-turnos').value;
      var estado = byId('lab-escenario-estado');
      var resultado = byId('lab-escenario-resultado');
      clearChildren(resultado);
      var turns;
      try {
        turns = JSON.parse(turnsRaw);
      } catch (e) {
        setEstadoLinea(estado, 'Los turnos no son JSON válido.', 'error');
        return;
      }
      var body = { scenarioId: scenarioId, turns: turns, liveTransferAvailable: liveTransferAvailable };
      if (callId) body.callId = callId;
      setEstadoLinea(estado, 'Ejecutando…', '');
      fetch('/api/scenario/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.json().then(function (json) { return { ok: res.ok, json: json }; });
      }).then(function (r) {
        if (!r.ok) {
          setEstadoLinea(estado, 'El motor ha rechazado el escenario: ' + (r.json && r.json.error ? r.json.error : 'petición rechazada'), 'error');
          return;
        }
        limpiarLinea(estado);
        laboratorioSummaryLines(r.json).forEach(function (line) {
          resultado.appendChild(el('p', '', line));
        });
        var ul = el('ul', '');
        r.json.turns.forEach(function (turn) {
          var text = turn.phraseKey + (turn.params ? ' ' + JSON.stringify(turn.params) : '');
          ul.appendChild(el('li', '', text));
        });
        resultado.appendChild(ul);
        refresh();
      }).catch(function () {
        setEstadoLinea(estado, 'No hay conexión con el motor.', 'error');
      });
    });

    // step 17 §9.3: el interruptor de fallo inyectado vive AQUÍ, no en la
    // pantalla operativa. Sólo lo mueve quien lo pulsa.
    byId('lab-inyectar-fallo-conversion').addEventListener('change', function (ev) {
      inyectarFalloConversion = !!ev.target.checked;
    });

    byId('btn-abrir-reset').addEventListener('click', abrirDialogoReset);
    byId('reset-cancelar').addEventListener('click', function () { byId('dialogo-reset').close(); });
    byId('reset-confirmar').addEventListener('click', function () { confirmarReinicio(); });
  }

  // ---- Reinicio de la demostración (step 18 §1.3) ------------------------

  var TEXTO_REINICIO_HECHO = 'Demostración reiniciada. Todo vuelve a estar a cero.';
  var TEXTO_REINICIO_SIN_CONEXION = 'No se ha podido reiniciar: no hay conexión con el motor. No se ha borrado nada.';
  var TEXTO_REINICIO_RECHAZADO = 'No se ha podido reiniciar. El motor ha rechazado la petición. No se ha borrado nada.';

  function abrirDialogoReset() {
    // §1.4: abrir el diálogo tampoco anuncia un vacío.
    limpiarLinea(byId('reset-estado'));
    byId('dialogo-reset').showModal();
    byId('dialogo-reset-titulo').focus();
  }

  /**
   * (step 18 §1.3) A dónde va el foco cuando el diálogo se cierra por un
   * reinicio con éxito: al disparador, que sigue en el DOM porque reiniciar
   * NO cambia de ruta. Si no existiera o no fuese enfocable —y eso se
   * comprueba mirando dónde acabó de verdad el foco, no suponiéndolo—, el
   * repuesto es \`#tx-view-title\`, que ya tiene \`tabindex="-1"\` y es el mismo
   * que usa el enrutador.
   */
  function enfocarTrasReinicio() {
    var disparador = byId('btn-abrir-reset');
    if (disparador && disparador.focus) disparador.focus();
    if (disparador && document.activeElement === disparador) return;
    var titulo = byId('tx-view-title');
    if (titulo && titulo.focus) titulo.focus({ preventScroll: true });
  }

  /**
   * (step 18 §1.3) Camino de FALLO. No se ha reiniciado nada, así que no se
   * limpia nada, no se cierra el diálogo y \`#estado-global\` no se toca:
   * jamás se anuncia un éxito que no ha pasado. El texto dice, siempre, que
   * no se ha borrado nada.
   */
  function fallarReinicio(texto) {
    sondeoEnPausa = false;
    setEstadoLinea(byId('reset-estado'), texto, 'error');
    var boton = byId('reset-confirmar');
    if (!boton) return;
    boton.disabled = false;
    if (boton.focus) boton.focus();
  }

  /**
   * (step 18 §1.3) La secuencia del reinicio, en este orden exacto:
   * limpiar → cerrar → foco → repintar → anunciar UNA vez.
   *
   *   - Se mira \`res.ok\`, no que el cuerpo sea JSON: antes un \`500\` con
   *     cuerpo JSON entraba por la rama de éxito y la consola cantaba
   *     "Demostración reiniciada" sin que se hubiera reiniciado nada.
   *   - El anuncio espera a que \`refresh()\` haya resuelto: no se cuenta un
   *     resultado hasta tener delante el mundo que lo respalda.
   *   - El anuncio vive en \`#estado-global\`, que está en \`<main>\` y no
   *     dentro del \`<dialog>\` que se cierra. Ya no hay \`setTimeout\`: cerrar
   *     con temporizador es lo que cortaba la lectura por la mitad.
   *   - Devuelve la promesa de la secuencia entera para que se pueda esperar.
   */
  function confirmarReinicio() {
    var boton = byId('reset-confirmar');
    if (boton && boton.disabled) return Promise.resolve();
    setEstadoLinea(byId('reset-estado'), 'Reiniciando…', '');
    if (boton) boton.disabled = true;
    sondeoEnPausa = true;
    var peticion;
    try {
      peticion = fetch('/api/reset', { method: 'POST' });
    } catch (e) {
      fallarReinicio(TEXTO_REINICIO_SIN_CONEXION);
      return Promise.resolve();
    }
    // Los dos manejadores van separados a propósito: un fallo de RED no se
    // puede confundir con un fallo de la secuencia posterior, que diría "no
    // hay conexión" sobre un reinicio que sí ha ocurrido.
    return peticion.then(
      function (res) { return { red: true, ok: !!res.ok }; },
      function () { return { red: false, ok: false }; }
    ).then(function (r) {
      if (!r.red) { fallarReinicio(TEXTO_REINICIO_SIN_CONEXION); return undefined; }
      if (!r.ok) { fallarReinicio(TEXTO_REINICIO_RECHAZADO); return undefined; }
      limpiarEstadosTransitorios();
      // (step 19 §3.8, punto 10; §7.1, I8) El explorador guarda estado en el
      // CLIENTE — resultados pintados, nota de desfase, mensajes— y
      // \`refresh()\` no lo toca a propósito (§3.8, punto 1). Sin esto, un
      // reinicio dejaría al operador mirando los huecos de un mundo que ya
      // no existe. Los campos del formulario no se tocan: es el resultado el
      // que ha dejado de ser cierto, no lo que el operador quiere consultar.
      limpiarExploradorHuecos();
      // (step 23 §11) El reinicio se lleva los huecos y con ellos toda
      // propuesta, así que una elección de sustituto guardada en el cliente
      // apuntaría a una persona de un mundo que ya no existe. El contador de
      // locución NO se toca aquí: la propia guarda de \`renderActividadOperativa\`
      // ve que el máximo BAJA y se vuelve a fijar EN SILENCIO, que es
      // exactamente lo que hay que hacer — un reinicio no se narra dos veces.
      huecoSeleccion = {};
      // (step 19 §5.2.6, §7.1 punto I8, hallazgo M2) El respaldo de copia del
      // resumen tampoco sale de la instantánea: se vacía y se vuelve a
      // ocultar explícitamente, o quedaría a la vista el resumen de un mundo
      // que ya no existe.
      limpiarRespaldoDeCopiaDelResumen();
      // (step 20 §6.4, D20-28) Los dos respaldos de copia del taller, por el
      // mismo motivo que el del resumen: un respaldo cuya línea explicativa
      // acaba de barrerse sería un campo huérfano con un texto largo a la
      // vista. Vaciar el respaldo NO es borrar el borrador (D20-27):
      // \`tallerBorrador\` no se toca en ningún punto de esta secuencia.
      limpiarRespaldosDelTaller();
      // (hallazgo MEDIO 1, revisión adversarial de misión completa) Ver el
      // docblock de la función: evita la SEGUNDA locución del turno cuando
      // el mundo llevaba tareas abiertas antes de reiniciar.
      prepararHistorialDeTareasParaReinicio();
      limpiarLinea(byId('estado-global'));
      byId('dialogo-reset').close();
      enfocarTrasReinicio();
      return refresh(true).then(function () {
        sondeoEnPausa = false;
        setEstadoLinea(byId('estado-global'), TEXTO_REINICIO_HECHO, 'ok');
        if (boton) boton.disabled = false;
      });
    });
  }

  function renderEventCountsDl(dlEl, counts) {
    var keys = Object.keys(counts).sort();
    reconcileList(dlEl, keys, function (k) { return k; }, function (key, existingWrap) {
      var wrap = existingWrap;
      var dt, dd;
      if (!wrap) {
        wrap = el('div', '');
        dt = el('dt', '', '');
        dd = el('dd', '', '');
        wrap.appendChild(dt);
        wrap.appendChild(dd);
      } else {
        dt = wrap.children[0];
        dd = wrap.children[1];
      }
      dt.textContent = key;
      dd.textContent = String(counts[key]);
      return wrap;
    });
  }

  function renderLaboratorio(snap) {
    // (step 19 §5.1) Los dos paneles del espacio de evaluación para Bruno van
    // PRIMERO de todos: el guion (3B), porque es lo que se abre antes de
    // empezar, y el resumen (3A), porque es lo que se enseña al final.
    renderGuionEnPantalla(snap);
    renderResumenOwner(snap);
    // (step 20 §3.1, D20-18) El tercer panel de cara a Bruno. Con la huella
    // ya pintada, esta llamada vuelve sin tocar el DOM (D20-20): el sondeo
    // de 2 s no repinta el taller ni roza el borrador.
    renderTallerDecisiones(snap);
    // (step 18 §3.5, §5.6) Los dos paneles nuevos van primero: el reloj es la
    // herramienta que hace demostrables las inasistencias.
    renderPanelDelReloj(snap);
    renderHistorialDeOperaciones(snap);
    // (step 19 §4.3) El cuarto historial, justo después del de operaciones y
    // antes del detalle técnico de inasistencias/grupos — el mismo sitio que
    // el diseño manda.
    renderHistorialDeTareas(snap);

    renderEventCountsDl(byId('lab-eventos-pilot'), snap.eventCounts.pilot);
    renderEventCountsDl(byId('lab-eventos-internal'), snap.eventCounts.internal);

    var auditList = snap.calendar.auditLog;
    setHidden(byId('lab-auditoria-vacio'), auditList.length > 0);
    reconcileList(byId('lab-auditoria-lista'), auditList, function (_x, idx) { return idx; }, function (text, existingLi) {
      var li = existingLi || el('li', '', '');
      li.textContent = text;
      return li;
    });

    // Cada dos segundos, y casi siempre con el MISMO contenido: reescribirlo
    // sin mirar destruía cualquier selección de texto que se estuviera
    // haciendo dentro del <pre> para copiar un trozo del JSON.
    setText(byId('lab-json'), JSON.stringify(snap, null, 2));

    // step 17 §7.2: los dos historiales se enseñan por separado, en dos
    // paneles rotulados. Éste es el de la lista de espera, con su
    // vocabulario técnico a la vista — Laboratorio es su cuarto (P3).
    var historial = byId('lab-waitlist-lista');
    if (!historial || !snap.waitlist) return;
    var eventos = snap.waitlist.audit.items.slice().reverse();
    setHidden(byId('lab-waitlist-vacio'), eventos.length > 0);
    reconcileList(historial, eventos, function (ev) { return ev.id; }, function (ev, li) {
      var node = li || el('li', '', '');
      setText(node, String(ev.seq) + ' · ' + ev.kind + ' · ' + ev.text);
      return node;
    });
  }

  // ---------------------------------------------------------------------
  // Calendar impact dialogs — shared 3-step flow (elegir → citas
  // afectadas → hecho). Decision P4 / component 6.8: nothing is ever
  // cancelled or moved without an explicit, per-reservation resolution.
  // ---------------------------------------------------------------------

  function buildImpactList(container, impacted, resolutions, onChange) {
    clearChildren(container);
    impacted.forEach(function (r) {
      var row = el('div', 'tx-impact-row');
      row.appendChild(el('p', 'tx-impact-row__title', formatDateLong(r.date) + ', ' + formatMinutes(r.startMinutes) + ' · ' + serviceLabel(r.serviceId) + ' · ' + professionalLabel(r.employeeId)));
      var name = 'resolucion-' + r.reservationId;
      var optKeep = el('label', 'tx-radio-field');
      var radioKeep = document.createElement('input');
      radioKeep.type = 'radio';
      radioKeep.name = name;
      radioKeep.value = 'keep_and_flag';
      optKeep.appendChild(radioKeep);
      // El rótulo va en un <span>, no en un nodo de texto suelto: es el mismo
      // ayudante \`el(...)\` que usa el resto de la consola (textContent
      // siempre), y además deja la etiqueta inspeccionable como elemento.
      // V3-1 — EL RÓTULO DICE LA VERDAD. Decía «Mantener la cita y marcarla
      // para revisar», y esa marca NO EXISTE: \`keep_and_flag\` deja la reserva
      // EXACTAMENTE como está (\`impact.ts:260-262\`), no escribe nada en
      // ninguna parte, no encola ninguna tarea y no deja rastro que nadie
      // pueda repasar luego. Prometer una marca que no se guarda es peor que
      // no ofrecer nada: el operador se va creyendo que alguien lo verá.
      // Quien SÍ deja rastro es la otra opción, y por eso son dos.
      optKeep.appendChild(el('span', '', 'Dejarla como está. No se apunta nada.'));
      row.appendChild(optKeep);
      var optContact = el('label', 'tx-radio-field');
      var radioContact = document.createElement('input');
      radioContact.type = 'radio';
      radioContact.name = name;
      radioContact.value = 'mark_for_human_contact';
      optContact.appendChild(radioContact);
      optContact.appendChild(el('span', '', 'Avisar: que alguien llame al cliente'));
      row.appendChild(optContact);
      [radioKeep, radioContact].forEach(function (radio) {
        radio.addEventListener('change', function () {
          resolutions[r.reservationId] = radio.value;
          onChange();
        });
      });
      container.appendChild(row);
    });
  }

  /**
   * D6 (revisión step 15): \`disabled\` DE VERDAD, no \`aria-disabled\` a secas.
   * Con sólo el atributo ARIA el botón se enfocaba, se pulsaba y la función de
   * publicar hacía \`return\` en silencio: un control muerto, el mismo patrón
   * que ya se quitó del botón "Duplicar para 2027". Ahora el botón sale del
   * orden de tabulación mientras falte alguna cita por decidir, y el motivo
   * sigue dicho en \`#...-contador\`, que es \`role="status" aria-live="polite"\`
   * y además el \`aria-describedby\` del propio botón.
   */
  function setPublishEnabled(saveBtn, enabled) {
    saveBtn.disabled = !enabled;
  }

  /**
   * V3-9 — la frase de impacto CERO. Antes esta línea se VACIABA, y al
   * vaciarse quedaba \`hidden\` (ver \`setEstadoLinea\`): el botón primario, que
   * la declara como su \`aria-describedby\`, apuntaba a un elemento vacío y
   * oculto, así que quien navega a ciegas oía «Publicar» a secas, sin la única
   * frase que le dice que se ha comprobado y que no se lleva por delante a
   * nadie. Ausencia de malas noticias no es lo mismo que silencio.
   */
  var IMPACTO_CERO = 'Comprobado: ninguna cita se queda fuera.';

  function updateImpactCounter(counterEl, saveBtn, impacted, resolutions) {
    var pending = impacted.filter(function (r) { return !resolutions[r.reservationId]; }).length;
    if (impacted.length === 0) {
      setEstadoLinea(counterEl, IMPACTO_CERO, '');
      setPublishEnabled(saveBtn, true);
      return;
    }
    if (pending === 0) {
      setEstadoLinea(counterEl, 'Todas las citas están decididas.', '');
      setPublishEnabled(saveBtn, true);
    } else {
      setEstadoLinea(counterEl, 'Falta decidir ' + String(pending) + (pending === 1 ? ' cita.' : ' citas.'), '');
      setPublishEnabled(saveBtn, false);
    }
  }

  // ---------------------------------------------------------------------
  // step 26 REAPERTURA §R9 paso 3 — EL REPASO, ANTES DE PUBLICAR.
  //
  // Formato OBLIGATORIO y común a los cuatro flujos (cierre, día especial,
  // ausencia y retirada), en este orden:
  //   (a) una frase en prosa, en castellano, sin un solo identificador
  //       técnico — la construye \`fraseDeCambio\`;
  //   (b) el bloque de impacto, SIEMPRE presente, incluso vacío: cuántas
  //       citas, en qué fechas, en qué intervalos, con qué profesional, y una
  //       ruta para ir a verlas;
  //   (c) la frase de no destrucción, literal y siempre;
  //   (d) las resoluciones, una por cita, sin preselección — las pinta
  //       \`buildImpactList\` en el contenedor de impacto que va justo debajo.
  //
  // Lo que este resumen NO dice, y no puede decir: ningún nombre, teléfono ni
  // dato personal de un cliente. \`ImpactedReservation\` deliberadamente no los
  // lleva, y aquí no se enriquece por ninguna otra vía.
  // ---------------------------------------------------------------------

  /**
   * V3-6 — LA SEGUNDA MITAD DE UN «CAMBIAR» HABLA EN PASADO.
   *
   * La primera mitad (el diálogo de la excepción) avisa en futuro, y hace
   * bien: allí no se ha retirado nada todavía. Pero cuando el alta se abre
   * PRECARGADA, la retirada YA SE HA PUBLICADO — es lo que acaba de pasar—, y
   * repetir «primero se retira el que hay y después se crea el nuevo» dejaba
   * al operador creyendo que el botón «Cancelar» de esta pantalla deshace las
   * dos cosas. No deshace ninguna: no hay endpoint de deshacer, y lo retirado
   * sigue retirado. Se dice tal cual, con la consecuencia concreta.
   */
  var FRASE_SEGUNDA_MITAD =
    'El anterior ya está retirado. Si cancelas ahora, esas fechas se quedan sin excepción.';

  var FRASE_NO_DESTRUCCION =
    'Publicar esto no cancela, no mueve y no avisa a nadie. Las citas siguen exactamente donde están. ' +
    'Tú decides qué hacer con cada una.';

  /** (b) — cuántas citas caen en el hueco, con el plural bien dicho. */
  function fraseDeImpacto(impacted) {
    if (impacted.length === 0) return 'Ningún cliente tiene cita en ese hueco.';
    if (impacted.length === 1) return '1 cita de cliente cae en ese hueco.';
    return String(impacted.length) + ' citas de clientes caen en ese hueco.';
  }

  /**
   * Pinta el repaso entero en \`contenedor\`. \`frasesExtra\` son las
   * advertencias propias de cada flujo (la de «dos cambios» del §R13, la de
   * qué implica retirar un horario especial); van después de la prosa y antes
   * del impacto, porque son parte de «qué va a pasar», no del recuento.
   *
   * TODO el texto entra por \`textContent\` a través de \`el(...)\`: una nota con
   * \`<script>\` o un \`<img onerror>\` se lee como texto, y ningún \`href\` ni
   * ningún atributo se construye a partir de ella.
   */
  function pintarResumen(contenedor, prosa, nota, frasesExtra, impacted) {
    clearChildren(contenedor);
    contenedor.appendChild(el('p', 'tx-dialog__summary-prosa', prosa));
    if (nota) {
      var lineaNota = el('p', '');
      lineaNota.appendChild(el('span', 'tx-nota-operativa', nota));
      contenedor.appendChild(lineaNota);
    }
    (frasesExtra || []).forEach(function (f) { contenedor.appendChild(el('p', 'tx-status-line', f)); });
    contenedor.appendChild(el('p', '', fraseDeImpacto(impacted)));
    if (impacted.length > 0) {
      var lista = el('ul', '');
      impacted.forEach(function (r) {
        lista.appendChild(el('li', '', formatDateLong(r.date) + ' · ' +
          formatMinutes(r.startMinutes) + '–' + formatMinutes(r.endMinutes) + ' · ' +
          professionalLabel(r.employeeId)));
      });
      contenedor.appendChild(lista);
      // La ruta para revisarlas: el día de la PRIMERA cita afectada, en la
      // Agenda, que es donde se ven enteras. Aquí no se decide nada por nadie.
      var fechas = impacted.map(function (r) { return r.date; }).sort();
      var enlace = el('a', 'tx-btn tx-btn--ghost', 'Revisarlas en la agenda');
      enlace.href = agendaHrefPara('dia', fechas[0], 'todos');
      contenedor.appendChild(enlace);
    }
    contenedor.appendChild(el('p', 'tx-dialog__summary-nodestruye', FRASE_NO_DESTRUCCION));
  }

  /**
   * A dónde vuelve el foco cuando un diálogo se cierra, cuando el disparador
   * ya no puede recibirlo. §R15 A4: tras una retirada, la fila que la disparó
   * ha dejado de existir, así que el foco va al ENCABEZADO DE SU BLOQUE, que
   * por eso lleva \`tabindex="-1"\` en el HTML servido.
   */
  function redirigirFocoDeCierre(dialogId, nodo) {
    if (nodo) disparadorDialogo[dialogId] = nodo;
  }

  /** El texto de un fallo del servidor, dicho en castellano y sin promesas. */
  function textoDeFalloDeCalendario(r, porDefecto) {
    if (r.status === 404) {
      return (r.json && r.json.error) || 'No hay ningún cambio con ese identificador.';
    }
    // Un 409 con \`error\` es la guarda de identificador repetido; un 409 con
    // \`unresolved\` es que las citas afectadas han cambiado bajo los pies.
    if (r.json && typeof r.json.error === 'string') return r.json.error;
    return porDefecto;
  }

  // ---------------------------------------------------------------------
  // V3-12 — EL TOPE DE LA NOTA, CONTADO COMO LO CUENTA EL SERVIDOR.
  //
  // El servidor mide \`[...s].length\` tras recortar: PUNTOS DE CÓDIGO. El
  // \`maxlength\` del navegador mide unidades UTF-16, así que con un emoji o
  // cualquier carácter fuera del plano básico las dos cuentas discrepan — y,
  // peor, cortaba un pegado largo sin decir nada. Aquí se cuenta como cuenta
  // el servidor, se enseña siempre, y cuando se recorta SE DICE. Es el mismo
  // patrón que el contador del Taller (D20-49, punto 2).
  // ---------------------------------------------------------------------

  var TOPE_NOTA = 280;

  /** Puntos de código, no unidades UTF-16 — exactamente \`[...s].length\`. */
  function largoDeNota(texto) {
    return Array.from(String(texto === null || texto === undefined ? '' : texto)).length;
  }

  /** Recorta a \`TOPE_NOTA\` PUNTOS DE CÓDIGO sin partir ningún carácter. */
  function recortarNota(texto) {
    return Array.from(String(texto)).slice(0, TOPE_NOTA).join('');
  }

  /**
   * Cablea un campo de nota con su contador. \`lineaDeAviso\` es la línea donde
   * se dice que se ha recortado (la misma región transitoria que el flujo ya
   * usa para sus errores), o \`null\` si ese flujo no tiene ninguna.
   */
  function cablearContadorDeNota(campoId, contadorId, avisoId) {
    var campo = byId(campoId);
    var contador = byId(contadorId);
    if (!campo || !contador) return;
    var pintar = function () {
      var recortado = false;
      if (largoDeNota(campo.value) > TOPE_NOTA) {
        campo.value = recortarNota(campo.value);
        recortado = true;
      }
      setText(contador, String(largoDeNota(campo.value)) + ' de ' + String(TOPE_NOTA));
      if (recortado && avisoId) {
        setEstadoLinea(byId(avisoId), 'La nota se ha cortado a ' + String(TOPE_NOTA) + ' caracteres.', '');
      }
    };
    campo.oninput = pintar;
    pintar();
  }

  /** Deja el campo vacío y su contador a cero — al abrir cualquiera de los tres diálogos. */
  function reiniciarContadorDeNota(campoId, contadorId) {
    var campo = byId(campoId);
    if (campo) campo.value = '';
    var contador = byId(contadorId);
    if (contador) setText(contador, '0 de ' + String(TOPE_NOTA));
  }

  // ---- Diálogo: cierre o día especial (§R9, cuatro pasos) ----------------

  var diaEspecialState = { impacted: [], resolutions: {}, change: null, tipo: null, retiradaPrevia: null };

  function wireDiaEspecialDialog() {
    var dialog = byId('dialogo-dia-especial');
    wireFocoDialogo('dialogo-dia-especial');
    cablearContadorDeNota('dia-especial-nota', 'dia-especial-nota-contador', 'dia-especial-paso1-error');
    [byId('dia-especial-tipo-cierre'), byId('dia-especial-tipo-especial')].forEach(function (radio) {
      radio.addEventListener('change', diaEspecialActualizarPuerta);
    });
    byId('dia-especial-siguiente-1').addEventListener('click', function () { irAPasoDiaEspecial(2); });
    byId('dia-especial-atras-1').addEventListener('click', function () { irAPasoDiaEspecial(1); });
    byId('dia-especial-cancelar-1').addEventListener('click', function () { dialog.close(); });
    byId('dia-especial-cancelar-2').addEventListener('click', function () { dialog.close(); });
    byId('dia-especial-cancelar-3').addEventListener('click', function () { dialog.close(); });
    byId('dia-especial-cerrar').addEventListener('click', function () { dialog.close(); refresh(); });
    byId('dia-especial-atras').addEventListener('click', function () { irAPasoDiaEspecial(2); });
    byId('dia-especial-siguiente').addEventListener('click', diaEspecialGoToImpact);
    byId('dia-especial-guardar').addEventListener('click', diaEspecialPublish);
  }

  /**
   * §R9 paso 1 — la puerta. El botón nace \`disabled\` DE VERDAD (no un
   * \`aria-disabled\` decorativo) y sólo se abre cuando el operador ha elegido
   * qué quiere hacer. Nada se rellena solo.
   */
  function diaEspecialActualizarPuerta() {
    var cierre = byId('dia-especial-tipo-cierre').checked;
    var especial = byId('dia-especial-tipo-especial').checked;
    diaEspecialState.tipo = cierre ? 'cierre' : (especial ? 'especial' : null);
    setHidden(byId('dia-especial-campos-cierre'), diaEspecialState.tipo !== 'cierre');
    setHidden(byId('dia-especial-campos-especial'), diaEspecialState.tipo !== 'especial');
    if (diaEspecialState.tipo === null) {
      setEstadoLinea(byId('dia-especial-gate'), 'Elige qué quieres hacer para continuar. No se rellena nada solo.', '');
    } else {
      limpiarLinea(byId('dia-especial-gate'));
    }
    byId('dia-especial-siguiente-1').disabled = diaEspecialState.tipo === null;
  }

  function showDiaEspecialStep(n) {
    setHidden(byId('dia-especial-paso-1'), n !== 1);
    setHidden(byId('dia-especial-paso-2'), n !== 2);
    setHidden(byId('dia-especial-paso-3'), n !== 3);
    setHidden(byId('dia-especial-paso-4'), n !== 4);
    // V3-6 refuerzo — el aviso vive FUERA de los pasos (para estar ya ahí en
    // el primer pintado de un precargado), así que su visibilidad se decide
    // aquí, en el único sitio por el que pasa todo cambio de paso. En el
    // paso 3 se apaga a propósito: el repaso ya lo dice dentro de
    // \`dia-especial-resumen\` (\`pintarResumen\`, vía \`extras\`), y dejarlo
    // encendido ahí lo duplicaría.
    setHidden(byId('dia-especial-aviso-retirada'), !(diaEspecialState.retiradaPrevia && (n === 1 || n === 2)));
  }

  /**
   * V2-2/V3-9 — CAMBIAR DE PASO MUEVE EL FOCO al encabezado del paso nuevo.
   * Es el mismo patrón, palabra por palabra, que \`irAPasoManual\`
   * (\`dialogo-cita-manual\`): sin esto, quien navega con el teclado se queda
   * con el foco en un botón que acaba de desaparecer de la vista, y el paso de
   * repaso —el único sitio donde se dice a cuántas citas afecta el cambio— no
   * produce ni una locución. Por eso cada \`<p class="tx-dialog__step">\` de los
   * tres diálogos lleva su \`id\` y su \`tabindex="-1"\` en el HTML servido.
   *
   * ABRIR el diálogo NO pasa por aquí: ahí el foco lo coloca \`abrirDialogo\` en
   * el título, que es el nombre accesible del diálogo entero.
   */
  function irAPasoDiaEspecial(n) {
    showDiaEspecialStep(n);
    enfocarPasoDeDialogo('dia-especial-paso-' + String(n) + '-titulo');
  }

  /** El encabezado de un paso, si existe y sabe recibir el foco. */
  function enfocarPasoDeDialogo(idTitulo) {
    var titulo = byId(idTitulo);
    if (titulo && titulo.focus) titulo.focus();
  }

  /**
   * \`precarga\` sólo la usa la segunda mitad de un «Cambiar» (§R13): el alta
   * llega con los valores del registro que se acaba de retirar, para que el
   * operador corrija lo que quería corregir en vez de teclearlo todo otra vez.
   */
  function openDiaEspecialDialog(disparador, precarga) {
    // V3-6 refuerzo — la bandera de procedencia se lee AQUÍ, del propio
    // \`precarga\`, y no se asigna después de que el diálogo ya se haya
    // pintado: \`excepcionCrearElNuevo\` la mete en \`precarga.retiradaPrevia\`
    // antes de llamar. Si se asignara después (como antes), el primer
    // pintado —el paso 2, el que trae el «Cancelar» ya alcanzable— se haría
    // sin saber todavía que viene de un «Cambiar», y \`FRASE_SEGUNDA_MITAD\`
    // llegaría tarde.
    diaEspecialState = {
      impacted: [], resolutions: {}, change: null, tipo: null,
      retiradaPrevia: (precarga && precarga.retiradaPrevia) || null
    };
    setText(byId('dia-especial-aviso-retirada'), diaEspecialState.retiradaPrevia ? FRASE_SEGUNDA_MITAD : '');
    byId('dia-especial-tipo-cierre').checked = false;
    byId('dia-especial-tipo-especial').checked = false;
    byId('dia-especial-desde').value = '';
    byId('dia-especial-hasta').value = '';
    byId('dia-especial-dia').value = '';
    byId('dia-especial-abre').value = '';
    byId('dia-especial-cierra').value = '';
    byId('dia-especial-nombre').value = '';
    reiniciarContadorDeNota('dia-especial-nota', 'dia-especial-nota-contador');
    limpiarLinea(byId('dia-especial-paso1-error'));
    limpiarLinea(byId('dia-especial-contador'));
    setPublishEnabled(byId('dia-especial-guardar'), false);
    if (precarga) {
      if (precarga.changeKind === 'venue_closure') {
        byId('dia-especial-tipo-cierre').checked = true;
        byId('dia-especial-desde').value = precarga.startDate;
        byId('dia-especial-hasta').value = precarga.endDate;
      } else if (precarga.changeKind === 'special_opening') {
        byId('dia-especial-tipo-especial').checked = true;
        byId('dia-especial-dia').value = precarga.date;
        byId('dia-especial-abre').value = precarga.specialOpen || '';
        byId('dia-especial-cierra').value = precarga.specialClose || '';
      }
      // V3-2 — se precarga el NOMBRE, nunca el identificador. Si se precargara
      // el identificador, el alta nueva reclamaría el mismo que el registro que
      // se acaba de retirar aunque el operador cambie la fecha, que es
      // justamente lo que suele venir a cambiar.
      byId('dia-especial-nombre').value = nombreDesdeIdentificador(precarga.id || '');
      byId('dia-especial-nota').value = recortarNota(precarga.note || '');
      setText(byId('dia-especial-nota-contador'), String(largoDeNota(byId('dia-especial-nota').value)) + ' de ' + String(TOPE_NOTA));
    }
    diaEspecialActualizarPuerta();
    showDiaEspecialStep(precarga ? 2 : 1);
    abrirDialogo('dialogo-dia-especial', 'dialogo-dia-especial-titulo', disparador || null);
  }

  /**
   * §R9 — el cambio que se va a publicar, construido desde el formulario.
   * \`venue_closure\` admite RANGO (\`startDate\`/\`endDate\`); \`special_opening\`
   * es de UN SOLO DÍA, y no por una limitación de la interfaz: es el modelo
   * (\`VenueCalendarRule.date\` es singular). Un \`special_opening\` ABRE el
   * local con otras horas — puede resultar en menos horas o en más— y por eso
   * NO se le llama «cierre parcial» en ningún sitio.
   */
  /**
   * §R13-3 — el nombre que no da para un identificador. Un nombre de sólo
   * signos («¿¿??») produce un slug vacío, y el servidor lo rechazaría con un
   * 400 sobre un patrón que el operador no ha visto nunca. Se dice aquí, en
   * castellano y antes de enviar nada.
   */
  var ERROR_NOMBRE_SIN_LETRAS = 'Ponle un nombre con letras o números. Sirve para reconocerlo luego en la lista.';

  function collectDiaEspecialChange() {
    var nombre = byId('dia-especial-nombre').value.trim();
    var nota = byId('dia-especial-nota').value.trim();
    if (diaEspecialState.tipo === null) return { error: 'Elige antes qué quieres hacer.' };
    if (!nombre) return { error: 'Rellena las fechas y el nombre antes de continuar.' };
    var change;
    if (diaEspecialState.tipo === 'cierre') {
      var desde = byId('dia-especial-desde').value;
      var hasta = byId('dia-especial-hasta').value;
      if (!desde || !hasta) return { error: 'Rellena las fechas y el nombre antes de continuar.' };
      if (hasta < desde) return { error: 'La fecha de fin no puede ser anterior a la de inicio.' };
      var idCierre = identificadorDeExcepcion(nombre, desde);
      if (idCierre === '') return { error: ERROR_NOMBRE_SIN_LETRAS };
      change = { changeKind: 'venue_closure', id: idCierre, startDate: desde, endDate: hasta };
    } else {
      var dia = byId('dia-especial-dia').value;
      var abre = byId('dia-especial-abre').value.trim();
      var cierra = byId('dia-especial-cierra').value.trim();
      if (!dia) return { error: 'Rellena las fechas y el nombre antes de continuar.' };
      if (!/^\\d{2}:\\d{2}$/.test(abre) || !/^\\d{2}:\\d{2}$/.test(cierra)) {
        return { error: 'Escribe la hora como HH:mm. Por ejemplo, 09:30.' };
      }
      if (cierra <= abre) return { error: 'La hora de cierre tiene que ser posterior a la de apertura.' };
      var idEspecial = identificadorDeExcepcion(nombre, dia);
      if (idEspecial === '') return { error: ERROR_NOMBRE_SIN_LETRAS };
      change = { changeKind: 'special_opening', id: idEspecial, date: dia, specialOpen: abre, specialClose: cierra };
    }
    if (nota !== '') change.note = nota;
    return { change: change };
  }

  function diaEspecialGoToImpact() {
    var result = collectDiaEspecialChange();
    if (result.error) {
      setEstadoLinea(byId('dia-especial-paso1-error'), result.error, 'error');
      return;
    }
    limpiarLinea(byId('dia-especial-paso1-error'));
    diaEspecialState.change = result.change;
    return fetch('/api/calendar/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.change)
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; });
    }).then(function (r) {
      if (!r.ok) {
        setEstadoLinea(byId('dia-especial-paso1-error'), 'No se ha podido calcular el impacto. Revisa las fechas.', 'error');
        return;
      }
      diaEspecialState.impacted = r.json.impacted || [];
      diaEspecialState.resolutions = {};
      var extras = [];
      if (diaEspecialState.retiradaPrevia) {
        extras.push(FRASE_SEGUNDA_MITAD);
      }
      pintarResumen(byId('dia-especial-resumen'), fraseDeCambio(diaEspecialState.change),
        diaEspecialState.change.note || '', extras, diaEspecialState.impacted);
      buildImpactList(byId('dia-especial-impacto'), diaEspecialState.impacted, diaEspecialState.resolutions, function () {
        updateImpactCounter(byId('dia-especial-contador'), byId('dia-especial-guardar'), diaEspecialState.impacted, diaEspecialState.resolutions);
      });
      updateImpactCounter(byId('dia-especial-contador'), byId('dia-especial-guardar'), diaEspecialState.impacted, diaEspecialState.resolutions);
      irAPasoDiaEspecial(3);
    }).catch(function () {
      setEstadoLinea(byId('dia-especial-paso1-error'), SIN_CONEXION, 'error');
    });
  }

  function diaEspecialPublish() {
    var saveBtn = byId('dia-especial-guardar');
    if (saveBtn.disabled) return;
    var counter = byId('dia-especial-contador');
    setEstadoLinea(counter, 'Guardando…', '');
    return fetch('/api/calendar/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ change: diaEspecialState.change, resolutions: diaEspecialState.resolutions })
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; });
    }).then(function (r) {
      if (!r.ok) {
        // El 409 de identificador repetido trae su propia frase del servidor
        // («Ya hay un cambio apuntado con ese nombre…»); el de resoluciones
        // no trae ninguna y se dice aquí. Ni uno ni otro cantan un éxito.
        setEstadoLinea(counter, textoDeFalloDeCalendario(r,
          'No se ha guardado: han cambiado las citas afectadas. Vuelve a revisarlas.'), 'error');
        if (!(r.json && r.json.error)) diaEspecialGoToImpact();
        return;
      }
      var flagged = r.json.flaggedForHumanContact ? r.json.flaggedForHumanContact.length : 0;
      var exito = byId('dia-especial-exito');
      if (flagged > 0) {
        setEstadoLinea(exito, 'Cambio guardado. ' + String(flagged) + (flagged === 1 ? ' cita se ha marcado' : ' citas se han marcado') + ' para que alguien llame al cliente. Las tienes en "Cosas que hacer una persona".', 'ok');
      } else {
        setEstadoLinea(exito, 'Cambio guardado.', 'ok');
      }
      irAPasoDiaEspecial(4);
      refresh();
    }).catch(function () {
      setEstadoLinea(counter, SIN_CONEXION, 'error');
    });
  }

  // ---- Diálogo: ausencia (§R10, cuatro pasos) ----------------------------

  var ausenciaState = { impacted: [], resolutions: {}, change: null, retiradaPrevia: null };

  function wireAusenciaDialog() {
    var dialog = byId('dialogo-ausencia');
    wireFocoDialogo('dialogo-ausencia');
    cablearContadorDeNota('ausencia-nota', 'ausencia-nota-contador', 'ausencia-paso1-error');
    byId('ausencia-todo-el-dia').addEventListener('change', function () {
      setHidden(byId('ausencia-campos-horas'), byId('ausencia-todo-el-dia').checked);
    });
    byId('ausencia-siguiente-1').addEventListener('click', ausenciaIrAlPasoDos);
    byId('ausencia-atras-1').addEventListener('click', function () { irAPasoAusencia(1); });
    byId('ausencia-cancelar-1').addEventListener('click', function () { dialog.close(); });
    byId('ausencia-cancelar-2').addEventListener('click', function () { dialog.close(); });
    byId('ausencia-cancelar-3').addEventListener('click', function () { dialog.close(); });
    byId('ausencia-cerrar').addEventListener('click', function () { dialog.close(); refresh(); });
    byId('ausencia-atras').addEventListener('click', function () { irAPasoAusencia(2); });
    byId('ausencia-siguiente').addEventListener('click', ausenciaGoToImpact);
    byId('ausencia-guardar').addEventListener('click', ausenciaPublish);
  }

  function showAusenciaStep(n) {
    setHidden(byId('ausencia-paso-1'), n !== 1);
    setHidden(byId('ausencia-paso-2'), n !== 2);
    setHidden(byId('ausencia-paso-3'), n !== 3);
    setHidden(byId('ausencia-paso-4'), n !== 4);
    // V3-6 refuerzo — mismo motivo que \`showDiaEspecialStep\`: el aviso vive
    // fuera de los pasos, así que su visibilidad se decide en el único sitio
    // por el que pasa todo cambio de paso, y se apaga en el paso 3 porque el
    // repaso ya lo dice dentro de \`ausencia-resumen\`.
    setHidden(byId('ausencia-aviso-retirada'), !(ausenciaState.retiradaPrevia && (n === 1 || n === 2)));
  }

  /** V2-2/V3-9 — el mismo patrón de foco por paso que el diálogo de arriba. */
  function irAPasoAusencia(n) {
    showAusenciaStep(n);
    enfocarPasoDeDialogo('ausencia-paso-' + String(n) + '-titulo');
  }

  /** Paso 1 → 2. Lo de «quién y cuándo» se comprueba ANTES de preguntar cuánto. */
  function ausenciaIrAlPasoDos() {
    var quien = byId('ausencia-profesional').value;
    var desde = byId('ausencia-desde').value;
    var hasta = byId('ausencia-hasta').value;
    var nombre = byId('ausencia-nombre').value.trim();
    // §R10 — la guarda del profesional se dice APARTE y con su propio
    // mensaje. Antes iba fundida con las fechas y el nombre, y además era
    // código muerto: sin opción vacía en el desplegable, \`quien\` nunca
    // llegaba en blanco.
    if (!quien) { setEstadoLinea(byId('ausencia-paso1-error'), 'Elige a quién le afecta la ausencia antes de continuar.', 'error'); return; }
    if (!ausenciaMotivoElegido()) { setEstadoLinea(byId('ausencia-paso1-error'), 'Elige el tipo de ausencia antes de continuar.', 'error'); return; }
    if (!desde || !hasta || !nombre) { setEstadoLinea(byId('ausencia-paso1-error'), 'Rellena las fechas y el nombre antes de continuar.', 'error'); return; }
    if (hasta < desde) { setEstadoLinea(byId('ausencia-paso1-error'), 'La fecha de fin no puede ser anterior a la de inicio.', 'error'); return; }
    limpiarLinea(byId('ausencia-paso1-error'));
    irAPasoAusencia(2);
  }

  /**
   * El tipo elegido, leído por \`id\` y no con un selector \`:checked\`. Es a
   * propósito: el DOM mínimo de las pruebas resuelve \`getElementById\`, y una
   * consulta CSS habría dejado este camino sin poder probarse sin navegador.
   */
  function ausenciaMotivoElegido() {
    if (byId('ausencia-motivo-vacation').checked) return 'vacation';
    if (byId('ausencia-motivo-absence').checked) return 'absence';
    if (byId('ausencia-motivo-training').checked) return 'training';
    return null;
  }

  /**
   * \`snapOverride\` sólo hace falta cuando este diálogo se abre sin que haya
   * habido un sondeo antes (las pruebas sin navegador); en la consola real
   * \`latestSnapshot\` siempre está puesto cuando hay un botón que pulsar.
   */
  function openAusenciaDialog(disparador, precarga, snapOverride) {
    // V3-6 refuerzo — mismo motivo que en \`openDiaEspecialDialog\`: se lee
    // \`precarga.retiradaPrevia\` AQUÍ, antes del primer pintado (que para
    // este diálogo es el paso 1), no después.
    ausenciaState = { impacted: [], resolutions: {}, change: null, retiradaPrevia: (precarga && precarga.retiradaPrevia) || null };
    setText(byId('ausencia-aviso-retirada'), ausenciaState.retiradaPrevia ? FRASE_SEGUNDA_MITAD : '');
    var snap = snapOverride || latestSnapshot;
    // §R10 — NADIE VIENE ELEGIDO. Este \`<select>\` se poblaba sin opción
    // vacía, así que el navegador autoseleccionaba la opción 0 —un
    // profesional de verdad— y se podía publicar una ausencia contra alguien
    // sin haber tocado nunca el desplegable. La opción vacía va primero,
    // igual que en \`#huecos-profesional\`, y el valor se REINICIA en cada
    // apertura: \`ensureProfessionalOptions\` conserva a propósito lo elegido
    // cuando el conjunto de opciones no cambia, que es justo lo que no
    // queremos de una apertura a la siguiente.
    if (snap) ensureProfessionalOptions(byId('ausencia-profesional'), snap.calendar.professionals, 'Elige a quién');
    byId('ausencia-profesional').value = '';
    byId('ausencia-desde').value = '';
    byId('ausencia-hasta').value = '';
    byId('ausencia-desde-hora').value = '';
    byId('ausencia-hasta-hora').value = '';
    byId('ausencia-nombre').value = '';
    reiniciarContadorDeNota('ausencia-nota', 'ausencia-nota-contador');
    // §R10 — «Todo el día» marcado es la ÚNICA preselección autorizada de
    // toda esta reapertura: es una opción RÁPIDA, no una decisión tomada por
    // nadie. El TIPO, en cambio, nace sin elegir.
    byId('ausencia-todo-el-dia').checked = true;
    setHidden(byId('ausencia-campos-horas'), true);
    byId('ausencia-motivo-vacation').checked = false;
    byId('ausencia-motivo-absence').checked = false;
    byId('ausencia-motivo-training').checked = false;
    limpiarLinea(byId('ausencia-paso1-error'));
    limpiarLinea(byId('ausencia-contador'));
    setPublishEnabled(byId('ausencia-guardar'), false);
    if (precarga) {
      byId('ausencia-profesional').value = String(precarga.employeeId);
      var radio = byId('ausencia-motivo-' + precarga.absenceKind);
      if (radio) radio.checked = true;
      byId('ausencia-desde').value = precarga.startDate;
      byId('ausencia-hasta').value = precarga.endDate;
      byId('ausencia-nombre').value = nombreDesdeIdentificador(precarga.id || '');
      byId('ausencia-nota').value = recortarNota(precarga.note || '');
      setText(byId('ausencia-nota-contador'), String(largoDeNota(byId('ausencia-nota').value)) + ' de ' + String(TOPE_NOTA));
      byId('ausencia-todo-el-dia').checked = !!precarga.allDay;
      setHidden(byId('ausencia-campos-horas'), !!precarga.allDay);
      if (!precarga.allDay) {
        byId('ausencia-desde-hora').value = formatMinutes(precarga.startMinutes);
        byId('ausencia-hasta-hora').value = formatMinutes(precarga.endMinutes);
      }
    }
    showAusenciaStep(1);
    abrirDialogo('dialogo-ausencia', 'dialogo-ausencia-titulo', disparador || null);
  }

  function collectAusenciaChange() {
    var quien = byId('ausencia-profesional').value;
    var employeeId = Number(quien);
    var motivo = ausenciaMotivoElegido();
    var desde = byId('ausencia-desde').value;
    var hasta = byId('ausencia-hasta').value;
    var nombre = byId('ausencia-nombre').value.trim();
    var nota = byId('ausencia-nota').value.trim();
    var allDay = byId('ausencia-todo-el-dia').checked;
    // §R10 — la misma guarda que el paso 1, aquí también: \`isNaN(employeeId)\`
    // NO la cubría, porque \`Number('')\` es 0, no NaN. Sin esta línea, saltarse
    // el paso 1 publicaba una ausencia contra el empleado 0.
    if (!quien) return { error: 'Elige a quién le afecta la ausencia antes de continuar.' };
    if (!motivo) return { error: 'Elige el tipo de ausencia antes de continuar.' };
    if (!nombre || !desde || !hasta || isNaN(employeeId)) return { error: 'Rellena las fechas y el nombre antes de continuar.' };
    if (hasta < desde) return { error: 'La fecha de fin no puede ser anterior a la de inicio.' };
    // §R11 — EL MOTIVO PRIVADO DE UNA AUSENCIA NO SE ENVÍA JAMÁS desde esta
    // consola. El campo sigue existiendo en el esquema del servidor y en el
    // modelo, con su contrato de secreto intacto; lo que esta decisión
    // congela es que la interfaz no lo escriba. Lo único que viaja es
    // \`note\`, la nota operativa, que sí se puede leer luego en pantalla.
    // (Su nombre exacto no se escribe aquí a propósito: \`console.test.ts\`
    // comprueba que este fichero no lo contenga NI UNA VEZ, ni en un
    // comentario, y esa guarda es más valiosa que la comodidad de citarlo.)
    var idAusencia = identificadorDeExcepcion(nombre, desde);
    if (idAusencia === '') return { error: ERROR_NOMBRE_SIN_LETRAS };
    var change = { changeKind: 'employee_absence', id: idAusencia, employeeId: employeeId, absenceKind: motivo, startDate: desde, endDate: hasta, allDay: allDay };
    if (!allDay) {
      var desdeHora = byId('ausencia-desde-hora').value.trim();
      var hastaHora = byId('ausencia-hasta-hora').value.trim();
      if (!/^\\d{2}:\\d{2}$/.test(desdeHora) || !/^\\d{2}:\\d{2}$/.test(hastaHora)) return { error: 'Escribe la hora como HH:mm. Por ejemplo, 09:30.' };
      var dh = desdeHora.split(':');
      var hh = hastaHora.split(':');
      change.startMinutes = Number(dh[0]) * 60 + Number(dh[1]);
      change.endMinutes = Number(hh[0]) * 60 + Number(hh[1]);
      if (change.endMinutes <= change.startMinutes) return { error: 'La hora de fin tiene que ser posterior a la de inicio.' };
    }
    if (nota !== '') change.note = nota;
    return { change: change };
  }

  function ausenciaGoToImpact() {
    var result = collectAusenciaChange();
    if (result.error) {
      setEstadoLinea(byId('ausencia-paso1-error'), result.error, 'error');
      return;
    }
    limpiarLinea(byId('ausencia-paso1-error'));
    ausenciaState.change = result.change;
    return fetch('/api/calendar/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.change)
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; });
    }).then(function (r) {
      if (!r.ok) {
        setEstadoLinea(byId('ausencia-paso1-error'), 'No se ha podido calcular el impacto. Revisa las fechas.', 'error');
        return;
      }
      ausenciaState.impacted = r.json.impacted || [];
      ausenciaState.resolutions = {};
      var extras = [];
      if (ausenciaState.retiradaPrevia) {
        extras.push(FRASE_SEGUNDA_MITAD);
      }
      pintarResumen(byId('ausencia-resumen'), fraseDeCambio(ausenciaState.change),
        ausenciaState.change.note || '', extras, ausenciaState.impacted);
      buildImpactList(byId('ausencia-impacto'), ausenciaState.impacted, ausenciaState.resolutions, function () {
        updateImpactCounter(byId('ausencia-contador'), byId('ausencia-guardar'), ausenciaState.impacted, ausenciaState.resolutions);
      });
      updateImpactCounter(byId('ausencia-contador'), byId('ausencia-guardar'), ausenciaState.impacted, ausenciaState.resolutions);
      irAPasoAusencia(3);
    }).catch(function () {
      setEstadoLinea(byId('ausencia-paso1-error'), SIN_CONEXION, 'error');
    });
  }

  function ausenciaPublish() {
    var saveBtn = byId('ausencia-guardar');
    if (saveBtn.disabled) return;
    var counter = byId('ausencia-contador');
    setEstadoLinea(counter, 'Guardando…', '');
    return fetch('/api/calendar/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ change: ausenciaState.change, resolutions: ausenciaState.resolutions })
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; });
    }).then(function (r) {
      if (!r.ok) {
        setEstadoLinea(counter, textoDeFalloDeCalendario(r,
          'No se ha guardado: han cambiado las citas afectadas. Vuelve a revisarlas.'), 'error');
        if (!(r.json && r.json.error)) ausenciaGoToImpact();
        return;
      }
      var flagged = r.json.flaggedForHumanContact ? r.json.flaggedForHumanContact.length : 0;
      var exito = byId('ausencia-exito');
      if (flagged > 0) {
        setEstadoLinea(exito, 'Cambio guardado. ' + String(flagged) + (flagged === 1 ? ' cita se ha marcado' : ' citas se han marcado') + ' para que alguien llame al cliente. Las tienes en "Cosas que hacer una persona".', 'ok');
      } else {
        setEstadoLinea(exito, 'Cambio guardado.', 'ok');
      }
      irAPasoAusencia(4);
      refresh();
    }).catch(function () {
      setEstadoLinea(counter, SIN_CONEXION, 'error');
    });
  }

  // ---- Diálogo: detalle de una excepción — cambiar o retirar (§R13) ------

  var excepcionState = { item: null, modo: 'retirar', impacted: [], resolutions: {} };

  function wireExcepcionDialog() {
    var dialog = byId('dialogo-excepcion');
    wireFocoDialogo('dialogo-excepcion');
    cablearContadorDeNota('excepcion-nota', 'excepcion-nota-contador', 'excepcion-error');
    byId('excepcion-cerrar-1').addEventListener('click', function () { dialog.close(); });
    byId('excepcion-cancelar').addEventListener('click', function () { dialog.close(); });
    byId('excepcion-cerrar-3').addEventListener('click', function () { dialog.close(); refresh(); });
    byId('excepcion-atras').addEventListener('click', function () { irAPasoExcepcion(1); });
    byId('excepcion-retirar').addEventListener('click', function () { excepcionState.modo = 'retirar'; excepcionPreview(); });
    byId('excepcion-cambiar').addEventListener('click', function () { excepcionState.modo = 'cambiar'; excepcionPreview(); });
    byId('excepcion-confirmar').addEventListener('click', excepcionPublish);
    byId('excepcion-crear-nuevo').addEventListener('click', excepcionCrearElNuevo);
  }

  function showExcepcionStep(n) {
    setHidden(byId('excepcion-paso-1'), n !== 1);
    setHidden(byId('excepcion-paso-2'), n !== 2);
    setHidden(byId('excepcion-paso-3'), n !== 3);
  }

  /** V2-2/V3-9 — el mismo patrón de foco por paso que los dos de arriba. */
  function irAPasoExcepcion(n) {
    showExcepcionStep(n);
    enfocarPasoDeDialogo('excepcion-paso-' + String(n) + '-titulo');
  }

  /** El encabezado del bloque al que pertenece una excepción (§R15 A4). */
  function encabezadoDeBloque(item) {
    return byId(item.targetKind === 'employee_absence' ? 'tit-ausencias-equipo' : 'tit-dias-especiales');
  }

  function openExcepcionDialog(item, disparador, modo) {
    excepcionState = { item: item, modo: modo || 'retirar', impacted: [], resolutions: {} };
    limpiarLinea(byId('excepcion-error'));
    limpiarLinea(byId('excepcion-contador'));
    limpiarLinea(byId('excepcion-exito'));
    reiniciarContadorDeNota('excepcion-nota', 'excepcion-nota-contador');
    setPublishEnabled(byId('excepcion-confirmar'), false);
    setHidden(byId('excepcion-crear-nuevo'), true);
    setHidden(byId('excepcion-cambiar'), !item.sePuedeCambiar);
    var detalle = byId('excepcion-detalle');
    clearChildren(detalle);
    detalle.appendChild(el('p', 'tx-dialog__summary-prosa', fraseDeCambio(item.cambio)));
    if (item.nota) {
      var lineaNota = el('p', '');
      lineaNota.appendChild(el('span', 'tx-nota-operativa', item.nota));
      detalle.appendChild(lineaNota);
    }
    if (!item.sePuedeCambiar) {
      detalle.appendChild(el('p', 'tx-status-line',
        'Los festivos llegan de fuera. Desde aquí se pueden retirar, pero no volver a apuntar.'));
    }
    showExcepcionStep(1);
    abrirDialogo('dialogo-excepcion', 'dialogo-excepcion-titulo', disparador || null);
  }

  /**
   * §R13 — la retirada SÍ necesita previsualización, y no por simetría
   * estética. Un \`special_opening\` REEMPLAZA el horario del local: si un día
   * especial abre de 10:00 a 22:00 sobre un horario de 09:30 a 18:00 y hay
   * una cita a las 20:00, retirarlo cierra el local a las 18:00 y esa cita
   * deja de caber. Por eso la retirada pasa por la MISMA puerta de
   * resoluciones que el alta.
   */
  function excepcionPreview() {
    var item = excepcionState.item;
    if (!item) return;
    limpiarLinea(byId('excepcion-error'));
    return fetch('/api/calendar/withdrawal/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: item.targetKind, id: item.id })
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; });
    }).then(function (r) {
      if (!r.ok) {
        setEstadoLinea(byId('excepcion-error'), textoDeFalloDeCalendario(r,
          'No se ha podido calcular qué pasa al retirarlo. No se ha cambiado nada.'), 'error');
        return;
      }
      excepcionState.impacted = r.json.impacted || [];
      excepcionState.resolutions = {};
      var extras = [];
      if (excepcionState.modo === 'cambiar') {
        extras.push('Esto se apunta como dos cambios: primero se retira el que hay y después se crea el nuevo.');
      }
      if (item.targetKind === 'venue_rule' && item.cambio.changeKind === 'special_opening') {
        extras.push('Al retirar un horario especial, ese día vuelve al horario de siempre del local. Si el horario especial abría más horas, alguna cita puede quedarse fuera.');
      } else {
        extras.push('Al retirarlo, esos días vuelven al horario de siempre. Lo apuntado se conserva en el historial: no se borra nada.');
      }
      pintarResumen(byId('excepcion-resumen'), 'Vas a retirar esto: ' + fraseDeCambio(item.cambio),
        item.nota, extras, excepcionState.impacted);
      buildImpactList(byId('excepcion-impacto'), excepcionState.impacted, excepcionState.resolutions, function () {
        updateImpactCounter(byId('excepcion-contador'), byId('excepcion-confirmar'), excepcionState.impacted, excepcionState.resolutions);
      });
      updateImpactCounter(byId('excepcion-contador'), byId('excepcion-confirmar'), excepcionState.impacted, excepcionState.resolutions);
      irAPasoExcepcion(2);
    }).catch(function () {
      setEstadoLinea(byId('excepcion-error'), SIN_CONEXION, 'error');
    });
  }

  /**
   * V1-9 — el cuerpo de la retirada, con su nota operativa si la hay. La clave
   * \`note\` sólo viaja cuando hay algo que decir: el esquema del servidor es
   * \`.strict()\` y una cadena vacía sería ruido en el historial.
   */
  function cuerpoDeRetirada(item, resolutions) {
    var cuerpo = { target: { targetKind: item.targetKind, id: item.id }, resolutions: resolutions };
    var campo = byId('excepcion-nota');
    var nota = campo ? recortarNota(String(campo.value).trim()) : '';
    if (nota !== '') cuerpo.note = nota;
    return cuerpo;
  }

  function excepcionPublish() {
    var boton = byId('excepcion-confirmar');
    if (boton.disabled) return;
    var item = excepcionState.item;
    var counter = byId('excepcion-contador');
    setEstadoLinea(counter, 'Retirando…', '');
    return fetch('/api/calendar/withdrawal/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpoDeRetirada(item, excepcionState.resolutions))
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; });
    }).then(function (r) {
      if (!r.ok) {
        setEstadoLinea(counter, textoDeFalloDeCalendario(r,
          'No se ha retirado: han cambiado las citas afectadas. Vuelve a revisarlas.'), 'error');
        if (r.status === 409 && !(r.json && r.json.error)) excepcionPreview();
        return;
      }
      var flagged = r.json.flaggedForHumanContact ? r.json.flaggedForHumanContact.length : 0;
      var cola = flagged > 0
        ? (' ' + String(flagged) + (flagged === 1 ? ' cita se ha marcado' : ' citas se han marcado') +
           ' para que alguien llame al cliente. Las tienes en "Cosas que hacer una persona".')
        : '';
      if (excepcionState.modo === 'cambiar') {
        setEstadoLinea(byId('excepcion-exito'), 'Retirado. Falta la segunda mitad del cambio: crear el nuevo.' + cola, 'ok');
        setHidden(byId('excepcion-crear-nuevo'), false);
      } else {
        setEstadoLinea(byId('excepcion-exito'), 'Retirado. Lo apuntado se conserva en el historial.' + cola, 'ok');
      }
      // §R15 A4 — la fila que abrió este diálogo va a desaparecer del
      // repintado, así que el foco no puede volver a ella: vuelve al
      // encabezado de su bloque, que para eso lleva \`tabindex="-1"\`.
      redirigirFocoDeCierre('dialogo-excepcion', encabezadoDeBloque(item));
      irAPasoExcepcion(3);
      refresh();
    }).catch(function () {
      setEstadoLinea(counter, SIN_CONEXION, 'error');
    });
  }

  /**
   * §R13 — la segunda mitad de un «Cambiar». NO hay endpoint atómico de
   * edición: editar es retirar y volver a dar de alta, dos publicaciones con
   * sus dos previsualizaciones y sus dos líneas de historial. El alta se abre
   * ya precargada con lo que había, para que el operador corrija en vez de
   * teclear de nuevo, pero es una publicación aparte y el repaso lo dice.
   */
  function excepcionCrearElNuevo() {
    var item = excepcionState.item;
    byId('dialogo-excepcion').close();
    // V3-6 refuerzo — \`retiradaPrevia\` viaja DENTRO de \`precarga\`, no se
    // asigna al estado después de abrir el diálogo: \`openAusenciaDialog\` y
    // \`openDiaEspecialDialog\` reinician su estado en la primera línea, así
    // que una asignación posterior a la llamada llegaría después del primer
    // pintado (el que ya trae un «Cancelar» alcanzable) y el aviso no
    // saldría a tiempo.
    var precarga = { changeKind: item.cambio.changeKind, id: item.id, note: item.nota, retiradaPrevia: item };
    if (item.targetKind === 'employee_absence') {
      openAusenciaDialog(encabezadoDeBloque(item), {
        employeeId: item.cambio.employeeId, absenceKind: item.cambio.absenceKind,
        startDate: item.cambio.startDate, endDate: item.cambio.endDate, allDay: item.cambio.allDay,
        startMinutes: item.cambio.startMinutes, endMinutes: item.cambio.endMinutes,
        id: item.id, note: item.nota, retiradaPrevia: item
      });
      return;
    }
    if (item.cambio.changeKind === 'venue_closure') {
      precarga.startDate = item.cambio.startDate;
      precarga.endDate = item.cambio.endDate;
    } else {
      precarga.date = item.cambio.date;
      precarga.specialOpen = item.cambio.specialOpen;
      precarga.specialClose = item.cambio.specialClose;
    }
    openDiaEspecialDialog(encabezadoDeBloque(item), precarga);
  }

  // ---- Diálogo: cancelar una cita (Agenda, step 17 §9.4.1) --------------

  var cancelarCitaState = { reserva: null };

  function wireCancelarCitaDialog() {
    wireFocoDialogo('dialogo-cancelar-cita');
    byId('cancelar-cita-cancelar').addEventListener('click', function () { byId('dialogo-cancelar-cita').close(); });
    byId('cancelar-cita-cerrar').addEventListener('click', function () { byId('dialogo-cancelar-cita').close(); });
    byId('cancelar-cita-confirmar').addEventListener('click', confirmarCancelarCita);
  }

  /**
   * El plazo PREVISTO, y sólo eso. Es la resta del §3.1 del diseño sobre
   * datos que ya vienen en la instantánea (la cita y el reloj sintético del
   * motor): días completos por 1440, más la hora de la cita, menos la hora
   * de ahora. NO mira horarios, ni temporadas, ni cierres, ni precedencia
   * — no llama a resolveVenueDay ni a venueWeekdayHours, y no puede
   * necesitarlas: el plazo no depende de si el local abre.
   *
   * El veredicto que MANDA es el del servidor, que lo vuelve a calcular al
   * cancelar y lo congela en el registro de la cancelación; es el que se
   * enseña en el paso 2. Éste sólo existe para que nadie confirme a ciegas.
   */
  function leadMinutesPrevisto(snap, reserva) {
    var dias = Math.round((dateFromISO(reserva.date).getTime() - dateFromISO(snap.engineToday).getTime()) / 86400000);
    return dias * 1440 + reserva.startMinutes - snap.engineNowMinutes;
  }

  function fraseDePlazoPrevisto(snap, reserva) {
    if (!snap || !snap.waitlist) return '';
    var plazo = snap.waitlist.policy.cancellationNoticeMinutes;
    var faltan = leadMinutesPrevisto(snap, reserva);
    var cabecera = faltan >= 0
      ? ('Faltan ' + String(faltan) + ' minutos para esta cita.')
      : ('Esta cita empezó hace ' + String(-faltan) + ' minutos.');
    var veredicto = faltan >= plazo
      ? 'Esta cancelación quedará marcada como dentro de plazo.'
      : 'Esta cancelación quedará marcada como fuera de plazo.';
    return cabecera + ' El plazo configurado son ' + String(plazo) + ' minutos. ' + veredicto +
      ' El motor lo vuelve a calcular al confirmar, y lo que diga él es lo que se guarda.';
  }

  function abrirDialogoCancelarCita(reserva, disparador) {
    cancelarCitaState = { reserva: reserva };
    setHidden(byId('cancelar-cita-paso-1'), false);
    setHidden(byId('cancelar-cita-paso-2'), true);
    setEstadoLinea(byId('cancelar-cita-error'), '', 'error');
    setEstadoLinea(byId('cancelar-cita-resultado'), '', '');
    clearChildren(byId('cancelar-cita-detalle'));
    byId('cancelar-cita-confirmar').disabled = false;
    byId('cancelar-cita-motivo').value = 'client_cancelled_by_phone_simulated';
    setText(byId('cancelar-cita-resumen'), formatDateLong(reserva.date) + ', ' + formatMinutes(reserva.startMinutes) +
      ' · ' + serviceLabel(reserva.serviceId) + ' · ' + professionalLabel(reserva.employeeId));
    // (step 18 §4.11) Si la cita es de una reserva para varias personas, se
    // dice ANTES de confirmar, y con el texto del servidor: se cancela sólo
    // ésta, las demás se quedan como están. Nada de aquí propaga nada.
    var notaGrupo = byId('cancelar-cita-grupo');
    if (notaGrupo) {
      var hayGrupo = !!(reserva.group && reserva.group.cancelDialogNote);
      setText(notaGrupo, hayGrupo ? reserva.group.cancelDialogNote : '');
      setHidden(notaGrupo, !hayGrupo);
    }
    setText(byId('cancelar-cita-plazo'), fraseDePlazoPrevisto(latestSnapshot, reserva));
    abrirDialogo('dialogo-cancelar-cita', 'dialogo-cancelar-cita-titulo', disparador);
  }

  function confirmarCancelarCita() {
    var boton = byId('cancelar-cita-confirmar');
    if (boton.disabled) return;
    var reserva = cancelarCitaState.reserva;
    if (!reserva) return;
    var error = byId('cancelar-cita-error');
    boton.disabled = true;
    setEstadoLinea(error, '', 'error');
    sendJson('/api/reservations/' + reserva.id + '/cancel',
      { reasonCode: byId('cancelar-cita-motivo').value, confirmed: true }, 'cancel:' + reserva.id)
      .then(function (r) {
        if (!r.ok) {
          setEstadoLinea(error, textoDeFallo(r), tonoDeFallo(r));
          boton.disabled = false;
          refresh();
          return;
        }
        // La instantánea se pide ANTES de contar el resultado: así el paso 2
        // se pinta con los textos ya resueltos por el servidor (el veredicto
        // de plazo, las etiquetas de los huecos, los nombres de las tareas) y
        // no con una traducción inventada aquí del objeto en crudo.
        refresh().then(function () { mostrarResultadoCancelacion(reserva, r); });
      })
      .catch(function () {
        setEstadoLinea(error, SIN_CONEXION, 'error');
        boton.disabled = false;
      });
  }

  function mostrarResultadoCancelacion(reserva, r) {
    setHidden(byId('cancelar-cita-paso-1'), true);
    setHidden(byId('cancelar-cita-paso-2'), false);
    setEstadoLinea(byId('cancelar-cita-resultado'), r.repetida
      ? 'Esta cita ya estaba cancelada por esta misma orden: se ha devuelto el resultado anterior y no se ha hecho nada nuevo.'
      : 'Cita cancelada.', 'ok');

    var lista = byId('cancelar-cita-detalle');
    clearChildren(lista);
    var w = latestSnapshot ? latestSnapshot.waitlist : null;
    if (!w) return;

    var registro = null;
    w.cancellations.forEach(function (c) { if (c.reservationId === reserva.id) registro = c; });
    if (!registro) {
      // La cancelación se hizo (la respuesta fue 2xx), pero la instantánea
      // siguiente no ha llegado. Sin ella no se puede decir NADA del
      // resultado: callar es lo único honesto, porque "no ha liberado
      // ningún hueco" sería una afirmación que nadie ha comprobado.
      lista.appendChild(el('li', '', 'La cita queda cancelada. El detalle no se ha podido leer todavía: lo tienes en la pantalla de Lista de espera.'));
      return;
    }
    lista.appendChild(el('li', '', registro.timelinessLabel + ' · se avisó con ' + String(registro.leadMinutes) +
      ' minutos de antelación, sobre un plazo de ' + String(registro.policyMinutesAtCancellation) + ' minutos.'));
    if (registro.timeliness === 'late') lista.appendChild(el('li', '', w.copy.noPenalty));

    var huecos = w.releasedSlots.filter(function (s) { return s.cancellationId === registro.id; });
    if (huecos.length === 0) {
      lista.appendChild(el('li', '', w.copy.venueClosedThatDay));
    } else {
      // step 19 D3 — la frase entera la compone el servidor
      // (announcementLine, waitlistSnapshot.ts): esta pantalla la pinta,
      // y no vuelve a juntar nombres ni a decidir el singular/plural.
      huecos.forEach(function (slot) { lista.appendChild(el('li', '', slot.announcementLine)); });
    }

    var tareas = (r.json.humanTaskIds || []);
    if (tareas.length > 0 && latestSnapshot.humanQueue) {
      latestSnapshot.humanQueue.tasks.forEach(function (t) {
        if (tareas.indexOf(t.id) === -1) return;
        lista.appendChild(el('li', '', 'Tarea para una persona: ' + t.reasonLabel + '.'));
      });
    }
  }

  // =====================================================================
  // INASISTENCIAS Y RESERVA PARA VARIAS PERSONAS (step 18 §5) — INICIO
  //
  // REGLA DURA DE TODO ESTE BLOQUE, la misma del bloque de lista de espera:
  // aquí NO se deriva nada de negocio. La elegibilidad, los estados, las
  // etiquetas, las horas en castellano, las claves de idempotencia y las
  // frases sobre lo que este sistema se niega a decidir llegan RESUELTAS en
  // \`snap.operations\` y en \`reserva.noShow\` / \`reserva.group\`. Esta
  // pantalla no compara horas, no acuña claves, no acuña identidades y no
  // compone ninguna frase de política: las lee de \`operations.noShows.copy\`
  // y de las líneas que el servidor ya ha compuesto.
  // =====================================================================

  /** La copia de inasistencias de la instantánea, o un objeto vacío si aún no ha llegado. */
  function copiaInasistencias() {
    if (!latestSnapshot || !latestSnapshot.operations || !latestSnapshot.operations.noShows) return {};
    return latestSnapshot.operations.noShows.copy || {};
  }

  /** El registro RESUELTO de una cita, tal y como lo publica \`operations.noShows.records\`. */
  function registroDeInasistencia(reservationId) {
    if (!latestSnapshot || !latestSnapshot.operations || !latestSnapshot.operations.noShows) return null;
    var registros = latestSnapshot.operations.noShows.records;
    for (var i = 0; i < registros.length; i += 1) {
      if (registros[i].reservationId === reservationId) return registros[i];
    }
    return null;
  }

  /**
   * Lo que el operador ve cuando una acción de inasistencia no se ha hecho.
   * Los dos motivos que el servidor ya tiene escritos se leen de su copia; el
   * tercero —el de la corrección terminal— es el texto del §5.3, que sólo
   * puede alcanzarse por la API (la interfaz no ofrece el botón), y vive aquí
   * junto a los demás conflictos de la consola.
   */
  var TEXTO_YA_CORREGIDO = 'Esa cita ya tiene un registro corregido. Corregir es definitivo en esta demostración: no se puede volver a anotar. No se ha escrito nada.';

  function textoDeFalloInasistencia(r) {
    if (r.status === 409) {
      var copy = copiaInasistencias();
      var codigo = r.json && r.json.conflict;
      if (codigo === 'reservation_not_finished_yet' && copy.notFinishedYet) return copy.notFinishedYet;
      if (codigo === 'reservation_is_cancelled' && copy.cancelledCannotBeNoShow) return copy.cancelledCannotBeNoShow;
      if (codigo === 'no_show_already_corrected') return TEXTO_YA_CORREGIDO;
    }
    return textoDeFallo(r);
  }

  /**
   * Deja un diálogo de inasistencia en su estado de "ya está hecho": el botón
   * de confirmar desaparece —la acción no se puede repetir desde aquí— y
   * aparece uno de cerrar, que además recibe el foco. No se cierra solo: el
   * resultado hay que poder leerlo.
   */
  function terminarDialogoSimple(idConfirmar, idCancelar, idCerrar) {
    var confirmar = byId(idConfirmar);
    var cancelar = byId(idCancelar);
    var cerrar = byId(idCerrar);
    if (confirmar) setHidden(confirmar, true);
    if (cancelar) setHidden(cancelar, true);
    if (cerrar) {
      setHidden(cerrar, false);
      if (cerrar.focus) cerrar.focus();
    }
  }

  function reabrirBotonesSimple(idConfirmar, idCancelar, idCerrar) {
    var confirmar = byId(idConfirmar);
    var cancelar = byId(idCancelar);
    var cerrar = byId(idCerrar);
    if (confirmar) { setHidden(confirmar, false); confirmar.disabled = false; }
    if (cancelar) setHidden(cancelar, false);
    if (cerrar) setHidden(cerrar, true);
  }

  // ---- Diálogo: anotar una inasistencia (§5.3) ---------------------------

  var inasistenciaState = { reserva: null };

  function wireInasistenciaDialog() {
    wireFocoDialogo('dialogo-inasistencia');
    byId('inasistencia-cancelar').addEventListener('click', function () { byId('dialogo-inasistencia').close(); });
    byId('inasistencia-cerrar').addEventListener('click', function () { byId('dialogo-inasistencia').close(); });
    byId('inasistencia-confirmar').addEventListener('click', confirmarInasistencia);
  }

  function abrirDialogoInasistencia(reserva, disparador) {
    inasistenciaState = { reserva: reserva };
    var copy = copiaInasistencias();
    setText(byId('inasistencia-resumen'), 'Cita sintética: ' + formatDateLong(reserva.date) + ', ' +
      formatMinutes(reserva.startMinutes) + '–' + formatMinutes(reserva.endMinutes) + ', con ' +
      professionalLabel(reserva.employeeId) + '. Servicio: ' + serviceLabel(reserva.serviceId) + '.');
    // Las cuatro frases del §2.11, leídas de su única fuente de verdad. La de
    // "ninguna penalización" está SIEMPRE a la vista, antes de confirmar.
    setText(byId('inasistencia-manual'), copy.manualOnly || '');
    setText(byId('inasistencia-sin-penalizacion'), copy.noPenalty || '');
    setText(byId('inasistencia-sin-identidad'), copy.noClientIdentity || '');
    setText(byId('inasistencia-historial'), copy.correctionKeepsHistory || '');
    limpiarLinea(byId('inasistencia-estado'));
    reabrirBotonesSimple('inasistencia-confirmar', 'inasistencia-cancelar', 'inasistencia-cerrar');
    abrirDialogo('dialogo-inasistencia', 'dialogo-inasistencia-titulo', disparador);
  }

  function confirmarInasistencia() {
    var boton = byId('inasistencia-confirmar');
    if (boton.disabled) return undefined;
    var reserva = inasistenciaState.reserva;
    if (!reserva) return undefined;
    var estado = byId('inasistencia-estado');
    boton.disabled = true;
    setEstadoLinea(estado, 'Guardando…', '');
    // Devuelve la promesa de la secuencia entera: quien la dispare puede
    // esperar a que el mundo esté repintado antes de mirar el resultado.
    // La clave la resuelve el SERVIDOR y viaja en la proyección
    // (\`noShowKeyToMint\`, §2.7): lleva dentro la revisión del mundo en que se
    // acuñó, que es lo que hace que "volver a anotar tras corregir" llegue a
    // su 409 honesto en vez de repetir un 201 memorizado. Un doble clic
    // produce la misma clave y por tanto ninguna escritura nueva.
    return sendJson('/api/reservations/' + reserva.id + '/no-show', { confirmed: true }, reserva.noShowKeyToMint)
      .then(function (r) {
        if (!r.ok) {
          boton.disabled = false;
          setEstadoLinea(estado, textoDeFalloInasistencia(r), tonoDeFallo(r));
          refresh();
          return undefined;
        }
        // N5: la repetición NUNCA se canta como si acabara de pasar. Dos
        // caminos llevan a lo mismo — el transporte (Idempotency-Status:
        // replayed) y la estructura (\`alreadyRecorded\`) — y los dos dicen
        // "esto ya estaba hecho".
        var copy = copiaInasistencias();
        var repetida = r.repetida || (r.json && r.json.alreadyRecorded === true);
        return refresh().then(function () {
          setEstadoLinea(estado, repetida ? (copy.repeatedResult || '') : (copy.recordedResult || ''), 'ok');
          terminarDialogoSimple('inasistencia-confirmar', 'inasistencia-cancelar', 'inasistencia-cerrar');
        });
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  // ---- Diálogo: corregir el registro (§5.3) ------------------------------

  var corregirInasistenciaState = { reserva: null };

  function wireCorregirInasistenciaDialog() {
    wireFocoDialogo('dialogo-corregir-inasistencia');
    byId('corregir-inasistencia-cancelar').addEventListener('click', function () { byId('dialogo-corregir-inasistencia').close(); });
    byId('corregir-inasistencia-cerrar').addEventListener('click', function () { byId('dialogo-corregir-inasistencia').close(); });
    byId('corregir-inasistencia-confirmar').addEventListener('click', confirmarCorregirInasistencia);
  }

  function abrirDialogoCorregirInasistencia(reserva, disparador) {
    corregirInasistenciaState = { reserva: reserva };
    var copy = copiaInasistencias();
    var registro = registroDeInasistencia(reserva.id);
    setText(byId('corregir-inasistencia-resumen'), 'Cita sintética: ' + formatDateLong(reserva.date) + ', ' +
      formatMinutes(reserva.startMinutes) + '–' + formatMinutes(reserva.endMinutes) + ', con ' +
      professionalLabel(reserva.employeeId) + '.');
    setText(byId('corregir-inasistencia-cuando'), registro
      ? ('Se anotó como inasistencia el ' + formatDateTimeLong(registro.recordedAtISO) + '.')
      : '');
    setText(byId('corregir-inasistencia-historial'), copy.correctionKeepsHistory || '');
    // K3, dicho ANTES de confirmar y no después: corregir es terminal.
    setText(byId('corregir-inasistencia-definitivo'), copy.correctionIsFinal || '');
    limpiarLinea(byId('corregir-inasistencia-estado'));
    reabrirBotonesSimple('corregir-inasistencia-confirmar', 'corregir-inasistencia-cancelar', 'corregir-inasistencia-cerrar');
    abrirDialogo('dialogo-corregir-inasistencia', 'dialogo-corregir-inasistencia-titulo', disparador);
  }

  function confirmarCorregirInasistencia() {
    var boton = byId('corregir-inasistencia-confirmar');
    if (boton.disabled) return undefined;
    var reserva = corregirInasistenciaState.reserva;
    if (!reserva) return undefined;
    var estado = byId('corregir-inasistencia-estado');
    boton.disabled = true;
    setEstadoLinea(estado, 'Guardando…', '');
    return sendJson('/api/reservations/' + reserva.id + '/no-show/correction', { confirmed: true }, reserva.noShowFixKeyToMint)
      .then(function (r) {
        if (!r.ok) {
          boton.disabled = false;
          setEstadoLinea(estado, textoDeFalloInasistencia(r), tonoDeFallo(r));
          refresh();
          return undefined;
        }
        var copy = copiaInasistencias();
        var repetida = r.repetida || (r.json && r.json.alreadyCorrected === true);
        return refresh().then(function () {
          setEstadoLinea(estado, repetida ? (copy.repeatedResult || '') : (copy.correctedResult || ''), 'ok');
          terminarDialogoSimple('corregir-inasistencia-confirmar', 'corregir-inasistencia-cancelar', 'corregir-inasistencia-cerrar');
        });
      })
      .catch(function () {
        boton.disabled = false;
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  // ---- Diálogo: reserva para varias personas (§5.4) ----------------------

  /**
   * Las etiquetas sintéticas permitidas, lista CERRADA (K13,
   * \`GROUP_MEMBER_LABEL_RE\`). Aquí no hay ningún campo de texto libre: una
   * etiqueta es exactamente una de estas doce, y el servidor las vuelve a
   * validar contra la misma expresión. Mismo patrón que las etiquetas
   * "Cliente A..H" del alta de lista de espera.
   */
  var ETIQUETAS_GRUPO = [
    'Persona 1', 'Persona 2', 'Persona 3', 'Persona 4',
    'Adulto A', 'Adulto B', 'Adulto C', 'Adulto D',
    'Menor A', 'Menor B', 'Menor C', 'Menor D'
  ];

  var GRUPO_MIN_PERSONAS = 2;
  var GRUPO_MAX_PERSONAS = 4;

  /**
   * El estado del diálogo de grupo. Vive fuera del DOM para que el paso 3 no
   * dependa de leer de vuelta lo que se pintó, y para que el sondeo de 2 s no
   * pueda tocarlo: la propuesta que el operador está mirando no cambia bajo
   * sus pies (§5.7).
   */
  var grupoState = {
    paso: 1,
    filas: [],
    forma: null,
    fecha: '',
    propuestas: [],
    elegida: null,
    disparador: null
  };

  function filaDeGrupoNueva(indice) {
    return { etiqueta: ETIQUETAS_GRUPO[indice] || ETIQUETAS_GRUPO[0], servicio: '', profesional: '' };
  }

  function wireGrupoDialog() {
    wireFocoDialogo('dialogo-grupo');
    ['grupo-cancelar-1', 'grupo-cancelar-2', 'grupo-cancelar-3', 'grupo-cancelar-4'].forEach(function (id) {
      byId(id).addEventListener('click', function () { byId('dialogo-grupo').close(); });
    });
    byId('grupo-cerrar').addEventListener('click', function () { byId('dialogo-grupo').close(); });
    byId('grupo-anadir').addEventListener('click', function () {
      if (grupoState.filas.length >= GRUPO_MAX_PERSONAS) return;
      grupoState.filas.push(filaDeGrupoNueva(grupoState.filas.length));
      renderGrupoPersonas();
    });
    byId('grupo-siguiente-1').addEventListener('click', function () { irAPasoGrupo(2); });
    byId('grupo-atras-2').addEventListener('click', function () { irAPasoGrupo(1); });
    byId('grupo-siguiente-2').addEventListener('click', function () { irAPasoGrupo(3); });
    byId('grupo-atras-3').addEventListener('click', function () { irAPasoGrupo(2); });
    byId('grupo-siguiente-3').addEventListener('click', function () { irAPasoGrupo(4); });
    byId('grupo-atras-4').addEventListener('click', function () { irAPasoGrupo(3); });
    byId('grupo-buscar').addEventListener('click', buscarPropuestasDeGrupo);
    byId('grupo-confirmar').addEventListener('click', confirmarGrupo);
    ['grupo-forma-consecutivas', 'grupo-forma-simultaneas'].forEach(function (id) {
      byId(id).addEventListener('change', function (ev) {
        if (!ev.target.checked) return;
        grupoState.forma = ev.target.value;
        // Cambiar de forma invalida cualquier propuesta ya buscada: la que
        // hubiera en pantalla describía otra pregunta.
        grupoState.propuestas = [];
        grupoState.elegida = null;
        actualizarPuertaGrupo();
      });
    });
    byId('grupo-fecha').addEventListener('change', function (ev) {
      grupoState.fecha = ev.target.value;
      grupoState.propuestas = [];
      grupoState.elegida = null;
      actualizarPuertaGrupo();
    });
  }

  function abrirDialogoGrupo(disparador, semilla) {
    var hoy = latestSnapshot ? latestSnapshot.engineToday : '';
    grupoState = {
      paso: 1,
      filas: (semilla && semilla.filas) || [filaDeGrupoNueva(0), filaDeGrupoNueva(1)],
      forma: (semilla && semilla.forma) || null,
      fecha: (semilla && semilla.fecha) || hoy,
      propuestas: [],
      elegida: null,
      disparador: disparador || null
    };
    limpiarLinea(byId('grupo-estado'));
    limpiarLinea(byId('grupo-error'));
    clearChildren(byId('grupo-propuestas'));
    clearChildren(byId('grupo-resumen-tbody'));
    setHidden(byId('grupo-confirmar'), false);
    byId('grupo-confirmar').disabled = false;
    setHidden(byId('grupo-cerrar'), true);
    byId('grupo-fecha').value = grupoState.fecha;
    byId('grupo-forma-consecutivas').checked = grupoState.forma === 'consecutive';
    byId('grupo-forma-simultaneas').checked = grupoState.forma === 'simultaneous';
    renderGrupoPersonas();
    mostrarPasoGrupo(semilla && semilla.paso ? semilla.paso : 1);
    abrirDialogo('dialogo-grupo', 'dialogo-grupo-titulo', disparador);
  }

  function mostrarPasoGrupo(n) {
    grupoState.paso = n;
    for (var i = 1; i <= 4; i += 1) setHidden(byId('grupo-paso-' + String(i)), i !== n);
    actualizarPuertaGrupo();
  }

  /**
   * Cambiar de paso mueve el foco al encabezado del paso nuevo (§5.7): sin
   * esto, quien navega con el teclado se queda con el foco en un botón que
   * acaba de desaparecer de la vista.
   */
  function irAPasoGrupo(n) {
    if (n === 4) construirResumenGrupo();
    mostrarPasoGrupo(n);
    var titulo = byId('grupo-paso-' + String(n) + '-titulo');
    if (titulo && titulo.focus) titulo.focus();
  }

  function opcionesDeServicioGrupo(select) {
    clearChildren(select);
    var vacia = el('option', '', 'Elige un servicio');
    vacia.value = '';
    select.appendChild(vacia);
    Object.keys(SERVICE_LABELS).forEach(function (id) {
      var opt = el('option', '', SERVICE_LABELS[id]);
      opt.value = String(id);
      select.appendChild(opt);
    });
  }

  /**
   * step 19 D2 — cada persona es un <fieldset> con <legend> propio, y sus
   * tres campos cuelgan de un envoltorio interior (.tx-group-row__fields)
   * que es quien lleva la disposición: el <fieldset> sólo aporta semántica
   * de grupo (§2.2.2). El rótulo visible se acorta a "Etiqueta"/"Servicio"/
   * "Profesional", pero cada <select> CONSERVA, palabra por palabra, el
   * nombre accesible completo de siempre en su aria-label — el <legend> es
   * refuerzo, nunca la única fuente del nombre (enmienda M1: eso no se puede
   * probar desde el VPS, que no emula ningún árbol de accesibilidad).
   */
  function renderGrupoPersonas() {
    var contenedor = byId('grupo-personas');
    if (!contenedor) return;
    clearChildren(contenedor);
    var profesionales = latestSnapshot ? latestSnapshot.calendar.professionals : [];
    grupoState.filas.forEach(function (fila, indice) {
      var numero = String(indice + 1);
      var ficha = el('fieldset', 'tx-group-row');
      var legend = el('legend', 'tx-group-row__legend', 'Persona ' + numero);
      ficha.appendChild(legend);

      var campos = el('div', 'tx-group-row__fields');

      var campoEtiqueta = el('div', 'tx-field');
      var labelEtiqueta = el('label', '', 'Etiqueta');
      labelEtiqueta.setAttribute('for', 'grupo-etiqueta-' + numero);
      var selEtiqueta = document.createElement('select');
      selEtiqueta.setAttribute('id', 'grupo-etiqueta-' + numero);
      selEtiqueta.setAttribute('aria-label', 'Etiqueta de la persona ' + numero);
      ETIQUETAS_GRUPO.forEach(function (etiqueta) {
        var opt = el('option', '', etiqueta);
        opt.value = etiqueta;
        selEtiqueta.appendChild(opt);
      });
      selEtiqueta.value = fila.etiqueta;
      selEtiqueta.onchange = function () {
        fila.etiqueta = selEtiqueta.value;
        grupoState.propuestas = [];
        grupoState.elegida = null;
        actualizarPuertaGrupo();
      };
      campoEtiqueta.appendChild(labelEtiqueta);
      campoEtiqueta.appendChild(selEtiqueta);

      var campoServicio = el('div', 'tx-field');
      var labelServicio = el('label', '', 'Servicio');
      labelServicio.setAttribute('for', 'grupo-servicio-' + numero);
      var selServicio = document.createElement('select');
      selServicio.setAttribute('id', 'grupo-servicio-' + numero);
      selServicio.setAttribute('aria-label', 'Servicio de la persona ' + numero);
      // Nace VACÍO, y nada lo rellena solo: no existe ningún "copiar a todos"
      // en esta pantalla, ni ninguna propagación silenciosa (§4.4).
      opcionesDeServicioGrupo(selServicio);
      selServicio.value = fila.servicio;
      selServicio.onchange = function () {
        fila.servicio = selServicio.value;
        grupoState.propuestas = [];
        grupoState.elegida = null;
        actualizarPuertaGrupo();
      };
      campoServicio.appendChild(labelServicio);
      campoServicio.appendChild(selServicio);

      var campoProfesional = el('div', 'tx-field');
      var labelProfesional = el('label', '', 'Profesional');
      labelProfesional.setAttribute('for', 'grupo-profesional-' + numero);
      var selProfesional = document.createElement('select');
      selProfesional.setAttribute('id', 'grupo-profesional-' + numero);
      selProfesional.setAttribute('aria-label', 'Profesional de la persona ' + numero);
      ensureProfessionalOptions(selProfesional, profesionales, 'Cualquiera');
      selProfesional.value = fila.profesional;
      selProfesional.onchange = function () {
        fila.profesional = selProfesional.value;
        grupoState.propuestas = [];
        grupoState.elegida = null;
        actualizarPuertaGrupo();
      };
      campoProfesional.appendChild(labelProfesional);
      campoProfesional.appendChild(selProfesional);

      campos.appendChild(campoEtiqueta);
      campos.appendChild(campoServicio);
      campos.appendChild(campoProfesional);
      ficha.appendChild(campos);

      if (grupoState.filas.length > GRUPO_MIN_PERSONAS) {
        var acciones = el('div', 'tx-group-row__actions');
        var quitar = el('button', 'tx-btn tx-btn--ghost', 'Quitar esta persona');
        quitar.type = 'button';
        quitar.setAttribute('aria-label', 'Quitar a la persona ' + numero + ' de esta reserva');
        quitar.onclick = function () {
          grupoState.filas.splice(indice, 1);
          grupoState.propuestas = [];
          grupoState.elegida = null;
          renderGrupoPersonas();
        };
        acciones.appendChild(quitar);
        ficha.appendChild(acciones);
      }

      contenedor.appendChild(ficha);
    });
    byId('grupo-anadir').disabled = grupoState.filas.length >= GRUPO_MAX_PERSONAS;
    actualizarPuertaGrupo();
  }

  /** Qué le falta al paso 1 para poder seguir, dicho en castellano llano. */
  function faltaEnPaso1() {
    var vistas = {};
    for (var i = 0; i < grupoState.filas.length; i += 1) {
      var fila = grupoState.filas[i];
      if (fila.servicio === '') return 'Falta el servicio de ' + fila.etiqueta + '. Se elige persona por persona.';
      if (vistas[fila.etiqueta]) return 'Cada persona necesita una etiqueta distinta: ' + fila.etiqueta + ' está repetida.';
      vistas[fila.etiqueta] = true;
    }
    return '';
  }

  /**
   * Ninguna acción se habilita antes de que su condición se cumpla, y cuando
   * está deshabilitada se dice POR QUÉ: un botón gris sin explicación es una
   * puerta cerrada sin cartel.
   */
  function actualizarPuertaGrupo() {
    var falta = faltaEnPaso1();
    setText(byId('grupo-paso1-gate'), falta || 'Ya puedes seguir al paso 2.');
    byId('grupo-siguiente-1').disabled = falta !== '';
    byId('grupo-siguiente-2').disabled = !grupoState.forma || !grupoState.fecha;
    byId('grupo-siguiente-3').disabled = grupoState.elegida === null;

    // La única "imposibilidad" que se adelanta es un HECHO comprobable de esta
    // demostración: cuántas personas hay en el equipo. El motivo exacto, con
    // sus palabras, lo dice el servidor cuando se busque.
    var aviso = byId('grupo-forma-aviso');
    if (aviso) {
      var cuantosProfesionales = latestSnapshot ? latestSnapshot.calendar.professionals.length : 0;
      var mismoProfesionalDosVeces = false;
      var pedidos = {};
      grupoState.filas.forEach(function (fila) {
        if (fila.profesional === '') return;
        if (pedidos[fila.profesional]) mismoProfesionalDosVeces = true;
        pedidos[fila.profesional] = true;
      });
      var texto = '';
      if (cuantosProfesionales > 0 && grupoState.filas.length > cuantosProfesionales) {
        texto = 'A la vez sólo caben tantas personas como profesionales hay: en esta demostración son ' +
          String(cuantosProfesionales) + '. Con ' + String(grupoState.filas.length) + ' personas, la forma que sí cabe es «una detrás de otra».';
      } else if (mismoProfesionalDosVeces) {
        texto = 'Has pedido a la misma persona del equipo para dos clientes. A la vez no puede ser: nadie atiende dos citas en la misma media hora. Una detrás de otra sí.';
      }
      setText(aviso, texto);
      setHidden(aviso, texto === '');
    }
  }

  /** El cuerpo de la consulta de propuestas, tal y como lo pide §4.9. */
  function cuerpoDePropuesta() {
    return {
      date: grupoState.fecha,
      arrangement: grupoState.forma,
      lines: grupoState.filas.map(function (fila) {
        return {
          memberLabel: fila.etiqueta,
          serviceId: Number(fila.servicio),
          professional: fila.profesional === ''
            ? { kind: 'any' }
            : { kind: 'specific', employeeId: Number(fila.profesional) }
        };
      })
    };
  }

  /**
   * Paso 3. Es una CONSULTA: no escribe nada, no lleva clave de idempotencia y
   * el servidor la resuelve entera — el navegador no elige profesional, no
   * busca huecos y no ordena nada.
   */
  function buscarPropuestasDeGrupo() {
    var boton = byId('grupo-buscar');
    var estado = byId('grupo-estado');
    boton.disabled = true;
    grupoState.propuestas = [];
    grupoState.elegida = null;
    clearChildren(byId('grupo-propuestas'));
    limpiarLinea(byId('grupo-error'));
    setEstadoLinea(estado, 'Buscando huecos…', '');
    return sendJson('/api/booking/group/proposals', cuerpoDePropuesta(), null)
      .then(function (r) {
        boton.disabled = false;
        if (!r.ok) {
          limpiarLinea(estado);
          setEstadoLinea(byId('grupo-error'), (r.json && r.json.error) || textoDeFallo(r), 'error');
          actualizarPuertaGrupo();
          return;
        }
        var propuestas = (r.json && r.json.proposals) || [];
        if (propuestas.length === 0) {
          limpiarLinea(estado);
          // El motivo lo dice el servidor con sus palabras. Aquí no se
          // inventa ninguna explicación de por qué no cabe.
          setEstadoLinea(byId('grupo-error'),
            (r.json && r.json.rejected && r.json.rejected.message) || 'No hay ninguna propuesta para lo que has pedido.', 'error');
          actualizarPuertaGrupo();
          return;
        }
        grupoState.propuestas = propuestas;
        limpiarLinea(estado);
        renderPropuestasDeGrupo();
      })
      .catch(function () {
        boton.disabled = false;
        limpiarLinea(estado);
        setEstadoLinea(byId('grupo-error'), SIN_CONEXION, 'error');
      });
  }

  /**
   * Hasta tres propuestas, en orden de hora, SIN preselección, SIN
   * "recomendada" y SIN resaltado (§4.5, no-regla 6.8). Cada una enseña una
   * línea por persona con todo dicho en castellano; ni el identificador de
   * hueco ni el del grupo se pintan nunca.
   */
  function renderPropuestasDeGrupo() {
    var contenedor = byId('grupo-propuestas');
    clearChildren(contenedor);
    grupoState.propuestas.forEach(function (propuesta, indice) {
      var card = el('div', 'tx-slot-card');
      var idRadio = 'grupo-propuesta-' + String(indice);
      var label = el('label', 'tx-radio-field');
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'grupo-propuesta';
      radio.value = String(indice);
      radio.setAttribute('id', idRadio);
      radio.checked = grupoState.elegida === indice;
      radio.onchange = function () {
        if (!radio.checked) return;
        grupoState.elegida = indice;
        actualizarPuertaGrupo();
      };
      label.appendChild(radio);
      label.appendChild(el('span', 'tx-slot-card__lead', propuesta.label + ' · ' + propuesta.dateLabel + ' · ' + propuesta.arrangementLabel));
      card.appendChild(label);

      var lista = el('ul', 'tx-proposal__lines');
      propuesta.lines.forEach(function (linea) {
        var texto = linea.memberLabel + ' · ' + linea.serviceLabel + ' · ' + propuesta.dateLabel + ' · ' +
          linea.whenLabel + ' · ' + linea.professionalLabel;
        if (linea.professionalWasRequested) texto += ' (lo pediste tú)';
        lista.appendChild(el('li', '', texto));
      });
      card.appendChild(lista);
      contenedor.appendChild(card);
    });
    actualizarPuertaGrupo();
  }

  /** Paso 4: la tabla completa, una fila por persona, sin abreviaturas ni códigos. */
  function construirResumenGrupo() {
    var tbody = byId('grupo-resumen-tbody');
    clearChildren(tbody);
    var propuesta = grupoState.propuestas[grupoState.elegida];
    if (!propuesta) return;
    propuesta.lines.forEach(function (linea) {
      var tr = document.createElement('tr');
      [
        ['Persona', linea.memberLabel],
        ['Servicio', linea.serviceLabel],
        ['Día', propuesta.dateLabel],
        ['Hora', linea.whenLabel],
        ['Profesional', linea.professionalLabel + (linea.professionalWasRequested ? ' (lo pediste tú)' : '')]
      ].forEach(function (par) {
        var td = document.createElement('td');
        td.setAttribute('data-label', par[0]);
        td.textContent = par[1];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    var cuantas = String(propuesta.lines.length);
    setText(byId('grupo-resumen-cuantas'), 'Se crearán ' + cuantas + ' reservas sintéticas. Esta demostración no toca ningún sistema real.');
    setText(byId('grupo-confirmar'), 'Sí, crear estas ' + cuantas + ' citas');
  }

  /**
   * Los conflictos de la creación de un grupo, dichos con la línea señalada.
   * El servidor manda el CÓDIGO y los tres datos de la línea que falló
   * (\`memberLabel\`, \`when\`, \`professionalLabel\`); la frase se escribe aquí,
   * una sola vez, y ninguna de ellas afirma que se haya escrito algo — porque
   * no se ha escrito nada.
   */
  function textoDeConflictoDeGrupo(json) {
    var linea = json && json.line;
    var quien = linea ? ('el hueco de las ' + linea.when + ' con ' + linea.professionalLabel + ', para ' + linea.memberLabel) : 'uno de los huecos';
    var codigo = json && json.conflict;
    if (codigo === 'slot_no_longer_free') {
      return 'No se ha creado ninguna cita: ' + quien + ', ya no está libre. No se ha escrito nada.';
    }
    if (codigo === 'slot_in_the_past') {
      return 'No se ha creado ninguna cita: ' + quien + ', ya ha pasado. No se ha escrito nada.';
    }
    if (codigo === 'professional_cannot_perform_service') {
      return 'No se ha creado ninguna cita: ' + quien + ', es de alguien que no hace ese servicio. No se ha escrito nada.';
    }
    if (codigo === 'date_outside_booking_horizon') {
      return 'No se ha creado ninguna cita: ese día queda fuera del plazo en el que esta demostración reserva citas. No se ha escrito nada.';
    }
    if (json && json.message) return 'No se ha creado ninguna cita: ' + json.message + ' No se ha escrito nada.';
    return 'No se ha creado ninguna cita. La demostración ha parado la acción para no escribir algo incorrecto. No se ha escrito nada.';
  }

  /**
   * La ÚNICA confirmación explícita del conjunto, y la única escritura. Las
   * líneas se devuelven TAL CUAL las resolvió la propuesta —el navegador no
   * vuelve a elegir profesional— y el servidor las revalida de cero. La clave
   * de intención también llega resuelta del servidor
   * (\`propuesta.intentKeyToMint\`): esta pantalla no acuña identidades ni
   * calcula el orden canónico del que sale esa clave.
   */
  function confirmarGrupo() {
    var boton = byId('grupo-confirmar');
    if (boton.disabled) return undefined;
    var propuesta = grupoState.propuestas[grupoState.elegida];
    if (!propuesta) return undefined;
    var estado = byId('grupo-estado');
    var error = byId('grupo-error');
    boton.disabled = true;
    limpiarLinea(error);
    setEstadoLinea(estado, 'Creando las citas…', '');
    var cuerpo = {
      arrangement: propuesta.arrangement,
      date: propuesta.date,
      lines: propuesta.lines.map(function (linea) {
        return {
          memberLabel: linea.memberLabel,
          serviceId: linea.serviceId,
          employeeId: linea.employeeId,
          startMinutes: linea.startMinutes
        };
      }),
      confirmed: true
    };
    return sendJson('/api/booking/groups', cuerpo, propuesta.intentKeyToMint)
      .then(function (r) {
        if (!r.ok) {
          boton.disabled = false;
          limpiarLinea(estado);
          if (r.status === 409) {
            setEstadoLinea(error, textoDeConflictoDeGrupo(r.json), 'conflict');
            // Vuelta al paso de propuestas: la agenda ha cambiado por debajo y
            // lo que había en pantalla ya no describe el mundo. Se buscan de
            // nuevo, y el operador vuelve a elegir.
            grupoState.propuestas = [];
            grupoState.elegida = null;
            clearChildren(byId('grupo-propuestas'));
            irAPasoGrupo(3);
          } else if (r.status === 500) {
            setEstadoLinea(error, ((r.json && r.json.error) || 'La demostración ha fallado a propósito.') +
              ' Si quieres, vuelve a intentarlo desde la propuesta.', 'error');
          } else {
            setEstadoLinea(error, textoDeFallo(r), tonoDeFallo(r));
          }
          refresh();
          return undefined;
        }
        // N5: nunca "Creadas N citas sintéticas" sobre una repetición. Los dos
        // caminos de repetición —el de transporte y el estructural— dicen lo
        // mismo, y dicen la verdad: no se ha creado ninguna cita nueva.
        var repetida = r.repetida || (r.json && r.json.alreadyExists === true);
        var cuantas = String(cuerpo.lines.length);
        return refresh().then(function () {
          setEstadoLinea(estado, repetida
            ? 'Esa reserva ya estaba creada. No se ha creado ninguna cita nueva.'
            : ('Creadas ' + cuantas + ' citas sintéticas. Puedes verlas en la Agenda.'), 'ok');
          setHidden(byId('grupo-confirmar'), true);
          setHidden(byId('grupo-cerrar'), false);
          var cerrar = byId('grupo-cerrar');
          if (cerrar && cerrar.focus) cerrar.focus();
        });
      })
      .catch(function () {
        boton.disabled = false;
        limpiarLinea(estado);
        setEstadoLinea(error, SIN_CONEXION, 'error');
      });
  }

  // =====================================================================
  // step 24 — CREAR CITA MANUAL (diseño §4, §14). INICIO DEL BLOQUE
  //
  // REGLA DURA, la misma que rige el resto de esta consola: aquí NO se
  // resuelve nada de negocio. Los huecos del paso 3 llegan del explorador
  // canónico ya resueltos, el profesional que le toca a «cualquiera» lo dice
  // el servidor en la vista previa, y cada frase de conflicto viene redactada
  // de allí. Este bloque pinta y recoge clics.
  //
  // Y NO HAY NINGÚN CAMPO DE HORA. La única forma de indicar una hora es
  // elegir uno de los huecos que el servidor ha dicho que existen.
  // =====================================================================

  /** Las seis personas sintéticas del catálogo cerrado (§4, paso 4). */
  var PERSONAS_MANUALES = ['Cliente A', 'Cliente B', 'Cliente C', 'Cliente D', 'Cliente E', 'Cliente F'];

  /**
   * El estado del diálogo. Vive FUERA del DOM, como el del grupo y por la
   * misma razón: el sondeo no puede tocarlo, así que el hueco que el operador
   * está mirando no cambia bajo sus pies mientras decide.
   */
  var manualState = {
    paso: 1,
    servicio: '',
    // step 26 §13 — minutos de la cita especial que se va a pedir, o null
    // mientras no haya ninguna duración resuelta (antes de elegir servicio, o
    // con «Otra duración…» marcada pero sin valor todavía). NUNCA se asume
    // 30 en silencio: el paso 1 no se abre sin este dato resuelto.
    duracion: null,
    // ¿La duración la ha elegido el operador fuera del catálogo (30 min)?
    // Gobierna el aviso «Duración especial elegida por el operador.».
    duracionEspecial: false,
    fecha: '',
    modo: '',
    profesional: '',
    huecos: [],
    elegido: null,
    persona: '',
    propuesta: null,
    disparador: null
  };

  function manualReset(disparador) {
    manualState = {
      paso: 1,
      servicio: '',
      duracion: null,
      duracionEspecial: false,
      fecha: latestSnapshot ? latestSnapshot.engineToday : '',
      modo: '',
      profesional: '',
      huecos: [],
      elegido: null,
      persona: '',
      propuesta: null,
      disparador: disparador || null
    };
  }

  /**
   * \`manualReset\` REASIGNA \`manualState\` a un objeto nuevo (nunca lo muta),
   * así que una prueba que capturara la variable directamente en el momento
   * de instalar el gancho de pruebas se quedaría con la referencia VIEJA.
   * Este accesor siempre lee la referencia viva — la única forma correcta
   * de comprobar la precarga de un hueco (step 26 §6.6, A8) desde fuera.
   */
  function manualStateActual() { return manualState; }

  function wireCitaManualDialog() {
    wireFocoDialogo('dialogo-cita-manual');
    ['manual-cancelar-1', 'manual-cancelar-2', 'manual-cancelar-3', 'manual-cancelar-4', 'manual-cancelar-5'].forEach(
      function (id) {
        byId(id).addEventListener('click', function () { byId('dialogo-cita-manual').close(); });
      }
    );
    byId('manual-cerrar').addEventListener('click', function () { byId('dialogo-cita-manual').close(); });

    byId('manual-siguiente-1').addEventListener('click', function () { irAPasoManual(2); });
    byId('manual-atras-2').addEventListener('click', function () { irAPasoManual(1); });
    byId('manual-siguiente-2').addEventListener('click', buscarHuecosManuales);
    byId('manual-atras-3').addEventListener('click', function () { irAPasoManual(2); });
    byId('manual-siguiente-3').addEventListener('click', function () { irAPasoManual(4); });
    byId('manual-atras-4').addEventListener('click', function () { irAPasoManual(3); });
    byId('manual-siguiente-4').addEventListener('click', pedirVistaPreviaManual);
    byId('manual-atras-5').addEventListener('click', function () { irAPasoManual(4); });
    byId('manual-confirmar').addEventListener('click', confirmarCitaManual);

    ['manual-servicio-0', 'manual-servicio-1', 'manual-servicio-2'].forEach(function (id) {
      byId(id).addEventListener('change', function (ev) {
        if (!ev.target.checked) return;
        manualState.servicio = ev.target.value;
        // Cambiar de servicio invalida los huecos ya buscados: describían otra
        // pregunta, y enseñarlos sería ofrecer algo que no se ha comprobado.
        olvidarHuecosManuales();
        // step 26 §13 — «30 min · habitual» queda marcado EN CUANTO hay
        // servicio, y sólo entonces: revela el control y fija la duración de
        // catálogo, de forma explícita y rotulada, nunca como supuesto oculto.
        marcarDuracionHabitual();
        actualizarPuertaManual();
      });
    });
    var DURACIONES_PREAJUSTADAS = [
      'manual-duracion-30', 'manual-duracion-60', 'manual-duracion-90', 'manual-duracion-120', 'manual-duracion-150'
    ];
    DURACIONES_PREAJUSTADAS.forEach(function (id) {
      byId(id).addEventListener('change', function (ev) {
        if (!ev.target.checked) return;
        manualState.duracion = Number(ev.target.value);
        manualState.duracionEspecial = ev.target.value !== '30';
        setHidden(byId('manual-duracion-otra-campo'), true);
        byId('manual-duracion-otra-valor').value = '';
        setHidden(byId('manual-duracion-aviso'), !manualState.duracionEspecial);
        // step 26 §13 — la duración determina qué huecos existen: cambiarla
        // invalida en cascada el hueco ya elegido, igual que servicio/fecha/
        // modo/profesional.
        olvidarHuecosManuales();
        actualizarPuertaManual();
      });
    });
    byId('manual-duracion-otra').addEventListener('change', function (ev) {
      if (!ev.target.checked) return;
      // «Otra duración…» no resuelve, por sí sola, ningún número de minutos:
      // hace falta el <select>. Hasta entonces la puerta del paso 1 sigue
      // cerrada y lo dice.
      manualState.duracion = null;
      manualState.duracionEspecial = true;
      setHidden(byId('manual-duracion-otra-campo'), false);
      setHidden(byId('manual-duracion-aviso'), false);
      olvidarHuecosManuales();
      actualizarPuertaManual();
    });
    byId('manual-duracion-otra-valor').addEventListener('change', function (ev) {
      manualState.duracion = ev.target.value === '' ? null : Number(ev.target.value);
      olvidarHuecosManuales();
      actualizarPuertaManual();
    });
    ['manual-quien-cualquiera', 'manual-quien-una'].forEach(function (id) {
      byId(id).addEventListener('change', function (ev) {
        if (!ev.target.checked) return;
        manualState.modo = ev.target.value;
        setHidden(byId('manual-profesional-campo'), manualState.modo !== 'one');
        olvidarHuecosManuales();
        actualizarPuertaManual();
      });
    });
    byId('manual-profesional').addEventListener('change', function (ev) {
      manualState.profesional = ev.target.value;
      olvidarHuecosManuales();
      actualizarPuertaManual();
    });
    byId('manual-fecha').addEventListener('change', function (ev) {
      manualState.fecha = ev.target.value;
      olvidarHuecosManuales();
      actualizarPuertaManual();
    });
    PERSONAS_MANUALES.forEach(function (persona, i) {
      var id = 'manual-persona-' + 'abcdef'.charAt(i);
      byId(id).addEventListener('change', function (ev) {
        if (!ev.target.checked) return;
        manualState.persona = ev.target.value;
        // La persona forma parte de la intención, así que cambiarla invalida
        // el resumen que se hubiera pedido antes.
        manualState.propuesta = null;
        actualizarPuertaManual();
      });
    });
  }

  function olvidarHuecosManuales() {
    manualState.huecos = [];
    manualState.elegido = null;
    manualState.propuesta = null;
    clearChildren(byId('manual-huecos'));
  }

  /**
   * step 26 §13 — marca «30 min · habitual» POR CÓDIGO (nunca en el HTML
   * servido: nada nace marcado), revela el control de Duración y su nota de
   * procedencia del catálogo, y limpia cualquier resto de «Otra duración…».
   * Se llama EN CUANTO hay servicio elegido, y sólo entonces (decisión 13):
   * es el único caso de todo el paso 1 en que algo se marca sin que el
   * operador lo haya tocado directamente, y queda dicho por escrito aquí.
   */
  function marcarDuracionHabitual() {
    ['manual-duracion-30', 'manual-duracion-60', 'manual-duracion-90', 'manual-duracion-120', 'manual-duracion-150', 'manual-duracion-otra'].forEach(
      function (id) { byId(id).checked = (id === 'manual-duracion-30'); }
    );
    setHidden(byId('manual-duracion-otra-campo'), true);
    byId('manual-duracion-otra-valor').value = '';
    setHidden(byId('manual-duracion-aviso'), true);
    manualState.duracion = 30;
    manualState.duracionEspecial = false;
    setHidden(byId('manual-duracion-campo'), false);
    setHidden(byId('manual-duracion-nota'), false);
  }

  /**
   * \`precarga\`, cuando llega (step 26 §6.6, desde un hueco de la Agenda):
   * \`{ fechaISO, startMinutes, employeeId }\`. Precarga fecha y profesional
   * en los CONTROLES DE SIEMPRE del paso 2 (nunca campos nuevos) y deja
   * dicha la hora propuesta en el propio título del diálogo — lo primero
   * que anuncia un lector de pantalla al abrirse, y el único sitio honesto
   * para decirla: no hay ningún control de "hora de inicio" antes del
   * paso 3, porque esa lista sale siempre del resolvedor canónico
   * (step 24 §1.2), nunca de una hora escrita a mano. Servicio, duración y
   * persona NUNCA se preseleccionan, precarga o no.
   */
  function abrirDialogoCitaManual(disparador, precarga) {
    manualReset(disparador);
    limpiarLinea(byId('manual-estado'));
    limpiarLinea(byId('manual-error'));
    clearChildren(byId('manual-huecos'));
    clearChildren(byId('manual-resumen'));
    setText(byId('manual-resumen-profesional'), '');
    setText(byId('manual-resumen-origen'), '');
    setText(byId('manual-resumen-sintetico'), '');
    setHidden(byId('manual-confirmar'), false);
    byId('manual-confirmar').disabled = false;
    setHidden(byId('manual-cerrar'), true);
    setHidden(byId('manual-profesional-campo'), true);
    byId('manual-fecha').value = manualState.fecha;
    ['manual-servicio-0', 'manual-servicio-1', 'manual-servicio-2',
      'manual-quien-cualquiera', 'manual-quien-una'].forEach(function (id) { byId(id).checked = false; });
    // Servicio, duración y persona NUNCA se preseleccionan (precarga o no):
    // el control de Duración vuelve a nacer oculto hasta que haya servicio.
    // Los nodos se comprueban antes de tocarlos porque este mismo cableado lo
    // reutilizan documentos de prueba de otras capacidades que aún no
    // conocen los ids nuevos de step 26 §13; en el documento real siempre
    // existen y siempre se limpian.
    ['manual-duracion-30', 'manual-duracion-60', 'manual-duracion-90', 'manual-duracion-120', 'manual-duracion-150', 'manual-duracion-otra'].forEach(
      function (id) { var nodo = byId(id); if (nodo) nodo.checked = false; }
    );
    var duracionOtraValor = byId('manual-duracion-otra-valor');
    if (duracionOtraValor) duracionOtraValor.value = '';
    [['manual-duracion-campo', true], ['manual-duracion-nota', true], ['manual-duracion-otra-campo', true], ['manual-duracion-aviso', true]].forEach(
      function (par) { var nodo = byId(par[0]); if (nodo) setHidden(nodo, par[1]); }
    );
    PERSONAS_MANUALES.forEach(function (_p, i) { byId('manual-persona-' + 'abcdef'.charAt(i)).checked = false; });
    ensureProfessionalOptions(
      byId('manual-profesional'),
      latestSnapshot ? latestSnapshot.calendar.professionals : [],
      null
    );
    byId('manual-profesional').value = '';

    var tituloTexto = 'Crear cita manual';
    if (precarga) {
      manualState.fecha = precarga.fechaISO;
      manualState.modo = 'one';
      manualState.profesional = String(precarga.employeeId);
      byId('manual-fecha').value = precarga.fechaISO;
      byId('manual-quien-una').checked = true;
      setHidden(byId('manual-profesional-campo'), false);
      byId('manual-profesional').value = String(precarga.employeeId);
      tituloTexto = 'Crear cita manual · Propuesta: ' + formatMinutes(precarga.startMinutes) + ' con ' +
        professionalLabel(precarga.employeeId) + ', ' + formatDateLong(precarga.fechaISO);
    }
    setText(byId('dialogo-cita-manual-titulo'), tituloTexto);

    mostrarPasoManual(1);
    abrirDialogo('dialogo-cita-manual', 'dialogo-cita-manual-titulo', disparador);
  }

  function mostrarPasoManual(n) {
    manualState.paso = n;
    for (var i = 1; i <= 5; i += 1) setHidden(byId('manual-paso-' + String(i)), i !== n);
    actualizarPuertaManual();
  }

  /**
   * Cambiar de paso mueve el foco al encabezado del paso nuevo: sin esto,
   * quien navega con el teclado se queda con el foco en un botón que acaba de
   * desaparecer de la vista.
   */
  function irAPasoManual(n) {
    mostrarPasoManual(n);
    var titulo = byId('manual-paso-' + String(n) + '-titulo');
    if (titulo && titulo.focus) titulo.focus();
  }

  /**
   * Ninguna acción se habilita antes de que su condición se cumpla, y cuando
   * está deshabilitada se dice POR QUÉ: un botón gris sin explicación es una
   * puerta cerrada sin cartel.
   */
  function actualizarPuertaManual() {
    var faltaServicio = manualState.servicio === '';
    // step 26 §13 — con servicio pero sin duración resuelta (sólo posible
    // con «Otra duración…» marcada y su <select> aún vacío), la puerta sigue
    // cerrada y lo dice con la frase exacta del contrato.
    var faltaDuracion = !faltaServicio && manualState.duracion === null;
    setText(byId('manual-paso1-gate'), faltaServicio
      ? 'El botón no se activa hasta que elijas un servicio. Ninguno viene marcado: eliges tú.'
      : (faltaDuracion
        ? 'Falta elegir cuántos minutos dura la cita especial.'
        : 'Ya puedes seguir al paso 2.'));
    byId('manual-siguiente-1').disabled = faltaServicio || faltaDuracion;

    var faltaFecha = manualState.fecha === '';
    var faltaQuien = manualState.modo === '' || (manualState.modo === 'one' && manualState.profesional === '');
    setText(byId('manual-paso2-gate'), faltaFecha
      ? 'Falta el día.'
      : (faltaQuien
        ? 'Falta elegir profesional. Puedes decir «cualquiera» y la demostración te dirá a quién le toca antes de confirmar.'
        : 'Ya puedes buscar huecos.'));
    byId('manual-siguiente-2').disabled = faltaFecha || faltaQuien;

    setText(byId('manual-paso3-gate'), manualState.elegido === null
      ? 'El botón no se activa hasta que elijas un hueco. Ninguno viene marcado y la demostración no elige por ti: eliges tú.'
      : 'Ya puedes seguir al paso 4.');
    byId('manual-siguiente-3').disabled = manualState.elegido === null;

    setText(byId('manual-paso4-gate'), manualState.persona === ''
      ? 'El botón no se activa hasta que elijas una persona.'
      : 'Ya puedes ver el resumen.');
    byId('manual-siguiente-4').disabled = manualState.persona === '';
  }

  /**
   * LOS HUECOS SALEN DEL EXPLORADOR CANÓNICO, el mismo que contesta a
   * «Comprobar huecos sintéticos» y el mismo cuyas funciones usa el motor de
   * llamadas. No se compone aquí ninguna lista de horas.
   */
  function buscarHuecosManuales() {
    var boton = byId('manual-siguiente-2');
    var estado = byId('manual-estado');
    boton.disabled = true;
    olvidarHuecosManuales();
    limpiarLinea(byId('manual-error'));
    setEstadoLinea(estado, 'Buscando huecos…', '');
    var url = '/api/availability/explore?serviceId=' + encodeURIComponent(manualState.servicio) +
      '&mode=' + (manualState.modo === 'one' ? 'one' : 'any') +
      (manualState.modo === 'one' ? '&employeeId=' + encodeURIComponent(manualState.profesional) : '') +
      '&from=' + encodeURIComponent(manualState.fecha) +
      '&to=' + encodeURIComponent(manualState.fecha) +
      // step 26 §13 — los huecos dependen de la duración pedida: se manda
      // siempre, ya resuelta (la puerta del paso 1 no deja llegar aquí sin
      // ella).
      '&durationMinutes=' + encodeURIComponent(String(manualState.duracion));
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, json: json }; }); })
      .then(function (r) {
        boton.disabled = false;
        limpiarLinea(estado);
        if (!r.ok) {
          setEstadoLinea(byId('manual-error'), (r.json && r.json.error) || 'No se han podido consultar los huecos.', 'error');
          return;
        }
        var huecos = (r.json && r.json.slots) || [];
        if (huecos.length === 0) {
          // El motivo lo dice el SERVIDOR, con sus palabras. Aquí no se
          // inventa ninguna explicación de por qué no hay huecos.
          var dia = (r.json && r.json.days && r.json.days[0]) || null;
          setEstadoLinea(byId('manual-error'),
            (dia && dia.notConsideredLabel) || (r.json && r.json.emptyLabel) ||
            'No hay huecos disponibles ese día para lo que has pedido.', 'error');
          actualizarPuertaManual();
          return;
        }
        manualState.huecos = huecos;
        renderHuecosManuales();
        irAPasoManual(3);
      })
      .catch(function () {
        boton.disabled = false;
        limpiarLinea(estado);
        setEstadoLinea(byId('manual-error'), SIN_CONEXION, 'error');
      });
  }

  /**
   * Un radio por hueco, SIN preselección y SIN ninguno «recomendado». Cada uno
   * dice hora y profesional con las etiquetas que ya trae el servidor; el
   * identificador del hueco no se pinta nunca.
   */
  function renderHuecosManuales() {
    var contenedor = byId('manual-huecos');
    clearChildren(contenedor);
    var fieldset = el('fieldset', 'tx-slot-card__choice');
    fieldset.appendChild(el('legend', '', 'Huecos disponibles'));
    manualState.huecos.forEach(function (hueco, indice) {
      var label = el('label', 'tx-radio-field');
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'manual-hueco';
      radio.value = String(indice);
      radio.setAttribute('id', 'manual-hueco-' + String(indice));
      radio.onchange = function () {
        if (!radio.checked) return;
        manualState.elegido = indice;
        manualState.propuesta = null;
        actualizarPuertaManual();
      };
      var texto = hueco.timeRangeLabel + ' · ' + hueco.professionalLabel;
      label.appendChild(radio);
      label.appendChild(el('span', '', texto));
      fieldset.appendChild(label);
    });
    contenedor.appendChild(fieldset);
    actualizarPuertaManual();
  }

  /**
   * EL PASO 5 LO REDACTA EL SERVIDOR. Se le pide la vista previa, que resuelve
   * «cualquiera», revalida con las mismas funciones que usará la confirmación y
   * devuelve el resumen ya escrito y la clave de idempotencia acuñada. Este
   * cliente no compone ni una frase de negocio ni deriva ninguna clave.
   */
  function pedirVistaPreviaManual() {
    var hueco = manualState.huecos[manualState.elegido];
    if (!hueco) return undefined;
    var boton = byId('manual-siguiente-4');
    var estado = byId('manual-estado');
    boton.disabled = true;
    limpiarLinea(byId('manual-error'));
    setEstadoLinea(estado, 'Comprobando el hueco…', '');
    var cuerpo = {
      clientLabel: manualState.persona,
      serviceId: Number(manualState.servicio),
      date: hueco.dateISO,
      startMinutes: minutosDeEtiqueta(hueco.startLabel),
      // LA PREFERENCIA REAL DEL OPERADOR, no la persona que el explorador ya
      // hubiera resuelto. Mandar siempre \`specific\` era un defecto: el
      // resumen decía «Se ha pedido expresamente a Álex» a quien había elegido
      // «cualquier profesional», que es justo lo contrario de lo que pasó. Con
      // la preferencia de verdad, el servidor vuelve a resolver con
      // \`chooseProfessional\` —la misma función y el mismo calendario que usó
      // el explorador, así que da la misma persona— y redacta la frase que
      // toca: «Con «cualquier profesional», a esta hora le toca X».
      professional: manualState.modo === 'one'
        ? { kind: 'specific', employeeId: Number(manualState.profesional) }
        : { kind: 'any' },
      // step 26 §13 — la vista de confirmación NO lleva durationMinutes
      // (no es un dato de vuelta del servidor, es la petición): se manda
      // desde el propio estado del asistente, aquí y en la confirmación.
      durationMinutes: manualState.duracion
    };
    return sendJson('/api/booking/manual/preview', cuerpo, null)
      .then(function (r) {
        boton.disabled = false;
        limpiarLinea(estado);
        if (!r.ok) {
          setEstadoLinea(byId('manual-error'), textoDeFallo(r), tonoDeFallo(r));
          return undefined;
        }
        if (!r.json || r.json.proposal === null) {
          setEstadoLinea(byId('manual-error'),
            (r.json && r.json.rejected && r.json.rejected.message) ||
            'Ese hueco ya no se puede reservar.', 'conflict');
          // La agenda ha cambiado por debajo: se vuelve al paso de huecos.
          olvidarHuecosManuales();
          irAPasoManual(3);
          return undefined;
        }
        manualState.propuesta = r.json.proposal;
        construirResumenManual();
        irAPasoManual(5);
        return undefined;
      })
      .catch(function () {
        boton.disabled = false;
        limpiarLinea(estado);
        setEstadoLinea(byId('manual-error'), SIN_CONEXION, 'error');
      });
  }

  /** "11:00" -> 660. La etiqueta viene del servidor y es siempre HH:mm. */
  function minutosDeEtiqueta(etiqueta) {
    var partes = String(etiqueta).split(':');
    return (Number(partes[0]) * 60) + Number(partes[1]);
  }

  function construirResumenManual() {
    var p = manualState.propuesta;
    var lista = byId('manual-resumen');
    clearChildren(lista);
    [
      ['Persona', p.clientLabel],
      ['Servicio', p.serviceLabel],
      ['Duración', p.durationLabel],
      ['Día', p.dateLabel],
      ['Hora', p.whenLabel],
      ['Profesional', p.professionalLabel]
    ].forEach(function (par) {
      lista.appendChild(el('dt', '', par[0]));
      lista.appendChild(el('dd', '', par[1]));
    });
    // Las tres frases las escribe el servidor, incluida la que dice a quién le
    // ha tocado cuando se pidió «cualquiera».
    setText(byId('manual-resumen-profesional'), p.professionalNote);
    setText(byId('manual-resumen-origen'), 'Origen: ' + p.originLabel + '.');
    setText(byId('manual-resumen-sintetico'), p.syntheticNotice);
    setText(byId('manual-confirmar'), p.confirmLabel);
  }

  function confirmarCitaManual() {
    var boton = byId('manual-confirmar');
    if (boton.disabled) return undefined;
    var p = manualState.propuesta;
    if (!p) return undefined;
    var estado = byId('manual-estado');
    var error = byId('manual-error');
    // Se apaga ANTES de salir: un doble clic no puede colarse por la ventana
    // entre el clic y la respuesta.
    boton.disabled = true;
    limpiarLinea(error);
    setEstadoLinea(estado, 'Creando la cita…', '');
    var cuerpo = {
      clientLabel: p.confirm.clientLabel,
      serviceId: p.confirm.serviceId,
      date: p.confirm.date,
      startMinutes: p.confirm.startMinutes,
      employeeId: p.confirm.employeeId,
      // step 26 §13 — p.confirm no lleva duración (la vista de
      // confirmación no la repite): se manda desde manualState, la MISMA
      // que ya vio la vista previa.
      durationMinutes: manualState.duracion,
      confirmed: true
    };
    return sendJson('/api/booking/manual', cuerpo, p.keyToMint)
      .then(function (r) {
        if (!r.ok) {
          boton.disabled = false;
          limpiarLinea(estado);
          if (r.status === 409) {
            setEstadoLinea(error, (r.json && r.json.message) || textoDeFallo(r), 'conflict');
            // La agenda ha cambiado por debajo y lo que había en pantalla ya no
            // describe el mundo: se vuelve a elegir hueco.
            olvidarHuecosManuales();
            irAPasoManual(3);
          } else {
            setEstadoLinea(error, textoDeFallo(r), tonoDeFallo(r));
          }
          refresh();
          return undefined;
        }
        // UNA repetición NO se locuta como si se hubiera creado otra cita: los
        // dos caminos —el de transporte y el estructural— dicen la verdad.
        var repetida = r.repetida || (r.json && r.json.alreadyExists === true);
        var cita = (r.json && r.json.booking) || null;
        return refresh().then(function () {
          setEstadoLinea(estado, repetida
            ? 'Esa cita ya estaba creada. No se ha creado ninguna cita nueva.'
            : ((cita && cita.successLabel) || 'Cita sintética creada.'), 'ok');
          setHidden(byId('manual-confirmar'), true);
          setHidden(byId('manual-cerrar'), false);
          var cerrar = byId('manual-cerrar');
          if (cerrar && cerrar.focus) cerrar.focus();
        });
      })
      .catch(function () {
        boton.disabled = false;
        limpiarLinea(estado);
        setEstadoLinea(error, SIN_CONEXION, 'error');
      });
  }

  // ===== step 24 — FIN DEL BLOQUE DE LA CITA MANUAL =====================

  // ---- Laboratorio: el reloj de la demostración (§3.5, §5.6) -------------

  /**
   * (Reparación de fase K, H3) \`true\` mientras la petición de avanzar el reloj
   * está EN VUELO. Hace falta porque \`estadoDelRelojLab\` corre también desde el
   * sondeo de cada dos segundos, y sin esto podía volver a habilitar el botón
   * entre el clic y su respuesta: dos avances por una sola intención, sobre un
   * reloj que es un DELTA y que a propósito no lleva clave de idempotencia.
   */
  var avanceDelRelojEnVuelo = false;

  function estadoDelRelojLab() {
    var salto = byId('lab-reloj-salto');
    var cita = byId('lab-reloj-cita');
    var boton = byId('lab-reloj-avanzar');
    if (!salto || !cita || !boton) return;
    // Mientras haya una petición en vuelo el botón se queda apagado, venga
    // quien venga a repintar.
    if (avanceDelRelojEnVuelo) {
      boton.disabled = true;
      return;
    }
    boton.disabled = salto.value === '' && cita.value === '';
  }

  function wireRelojLabControls() {
    var salto = byId('lab-reloj-salto');
    var cita = byId('lab-reloj-cita');
    // Las dos órdenes se excluyen: elegir una deja la otra sin elegir, así que
    // nunca hay dos avances pedidos a la vez ni hay que adivinar cuál manda.
    salto.addEventListener('change', function () {
      if (salto.value !== '') cita.value = '';
      estadoDelRelojLab();
    });
    cita.addEventListener('change', function () {
      if (cita.value !== '') salto.value = '';
      estadoDelRelojLab();
    });
    byId('lab-reloj-avanzar').addEventListener('click', avanzarElReloj);
  }

  function avanzarElReloj() {
    var salto = byId('lab-reloj-salto');
    var cita = byId('lab-reloj-cita');
    var boton = byId('lab-reloj-avanzar');
    var estado = byId('lab-reloj-estado');
    // (Reparación de fase K, H3) La misma guarda de reentrada que llevan las
    // otras tres acciones nuevas: un botón apagado no manda nada, aunque el
    // clic llegue por teclado, por doble clic o por un guion.
    if (boton.disabled) return undefined;
    var cuerpo = null;
    if (cita.value !== '') cuerpo = { command: 'advance_to_reservation_end', reservationId: cita.value };
    else if (salto.value !== '') cuerpo = { command: 'advance_minutes', minutes: Number(salto.value) };
    if (!cuerpo) {
      setEstadoLinea(estado, 'Elige un salto o una cita antes de avanzar el reloj.', 'error');
      return undefined;
    }
    boton.disabled = true;
    avanceDelRelojEnVuelo = true;
    setEstadoLinea(estado, 'Moviendo el reloj…', '');
    // Sin clave de idempotencia, y a propósito (§3.5): avanzar N minutos es un
    // incremento, y memorizar la primera respuesta sería mentir.
    return sendJson('/api/lab/clock/advance', cuerpo, null)
      .then(function (r) {
        avanceDelRelojEnVuelo = false;
        boton.disabled = false;
        if (!r.ok) {
          var texto = r.status === 409
            ? 'El reloj de esta demostración no puede retroceder. Ahora mismo marca ' + String(r.json.currentLabel) +
              ', y lo que has pedido es ' + String(r.json.requestedLabel) + '. Para volver al principio, reinicia la demostración.'
            : textoDeFallo(r);
          setEstadoLinea(estado, texto, tonoDeFallo(r));
          return undefined;
        }
        salto.value = '';
        cita.value = '';
        estadoDelRelojLab();
        return refresh().then(function () {
          // La hora nueva la dice el SERVIDOR, ya en castellano. Y se dice a la
          // vez lo que NO ha pasado: mover el reloj no anota nada.
          setEstadoLinea(estado, 'El reloj de la demostración marca ahora ' + String(r.json.clock.label) +
            '. No se ha anotado ninguna inasistencia: mover el reloj sólo hace que se pueda anotar.', 'ok');
        });
      })
      .catch(function () {
        avanceDelRelojEnVuelo = false;
        boton.disabled = false;
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  function renderPanelDelReloj(snap) {
    var ahora = byId('lab-reloj-ahora');
    if (!ahora || !snap.operations) return;
    var reloj = snap.operations.clock;
    var texto = 'Ahora mismo, en esta demostración, son las ' + reloj.label + '.';
    if (reloj.advancedLabel) texto += ' Lo has movido tú: ' + reloj.advancedLabel + '.';
    setText(ahora, texto);
    setText(byId('lab-reloj-aviso'), snap.operations.noShows.copy.clockOnlyForwards);
    setText(byId('lab-tecnico-endpoint'), snap.operations.noShows.copy.clockEndpointIsWider);

    // Las citas CONFIRMADAS de hoy, para el salto "hasta el final de esta
    // cita". Se listan con su hora y su profesional, nunca con su
    // identificador — ése viaja en el 'value', que no se lee en voz alta.
    var select = byId('lab-reloj-cita');
    if (!select) return;
    var citas = snap.calendar.reservations.filter(function (r) {
      return r.date === snap.engineToday && r.status === 'confirmed';
    }).sort(function (a, b) { return a.startMinutes - b.startMinutes; });
    var elegida = select.value;

    // (Reparación de fase K, H3) LA MISMA GUARDA DE IGUALDAD que
    // \`ensureProfessionalOptions\`: si las opciones que tocan son exactamente
    // las que ya hay, no se reconstruye nada. Sin ella, este panel rehacía sus
    // <option> cada dos segundos, lo que en un navegador de verdad cierra la
    // lista desplegada y arranca el foco a quien esté eligiendo con el teclado.
    var valoresActuales = Array.prototype.map.call(select.options, function (o) { return o.value; });
    var valoresQueTocan = [''];
    citas.forEach(function (r) { valoresQueTocan.push(String(r.id)); });
    var iguales = valoresActuales.length === valoresQueTocan.length &&
      valoresQueTocan.every(function (v, i) { return valoresActuales[i] === v; });
    if (iguales) {
      // La elección se queda como está: no se ha tocado ni un nodo.
      estadoDelRelojLab();
      return;
    }

    clearChildren(select);
    var vacia = el('option', '', '(elige una cita de hoy)');
    vacia.value = '';
    select.appendChild(vacia);
    citas.forEach(function (r) {
      var opt = el('option', '', formatMinutes(r.startMinutes) + '–' + formatMinutes(r.endMinutes) + ' · ' +
        professionalLabel(r.employeeId) + ' · ' + serviceLabel(r.serviceId));
      opt.value = r.id;
      select.appendChild(opt);
    });
    var sigueExistiendo = citas.some(function (r) { return r.id === elegida; });
    select.value = sigueExistiendo ? elegida : '';
    estadoDelRelojLab();
  }

  // ---- Laboratorio: los ejemplos de reserva para varias personas (§4.13) --

  /**
   * Los tres escenarios del §4.13, y el cuarto que enseña la imposibilidad.
   * Cada uno RELLENA el diálogo y lo abre; ninguno confirma nada, porque
   * saltarse la confirmación contradiría §4.4.
   *
   * Los servicios van por número porque es lo que la ruta pide; sus nombres
   * salen de SERVICE_LABELS y se ven en el diálogo (0 Barba, 1 Corte de pelo).
   */
  var GRUPO_EJEMPLOS = {
    consecutivas: {
      forma: 'consecutive',
      filas: [
        { etiqueta: 'Adulto A', servicio: '1', profesional: '' },
        { etiqueta: 'Menor B', servicio: '0', profesional: '' }
      ]
    },
    simultaneas: {
      forma: 'simultaneous',
      filas: [
        { etiqueta: 'Persona 1', servicio: '1', profesional: '' },
        { etiqueta: 'Persona 2', servicio: '1', profesional: '' }
      ]
    }
  };

  function semillaDeEjemplo(nombre) {
    var ejemplo = GRUPO_EJEMPLOS[nombre];
    return {
      forma: ejemplo.forma,
      fecha: latestSnapshot ? latestSnapshot.engineToday : '',
      filas: ejemplo.filas.map(function (f) { return { etiqueta: f.etiqueta, servicio: f.servicio, profesional: f.profesional }; })
    };
  }

  /** Lo que el escenario del conflicto deja preparado entre un botón y el otro. */
  var conflictoDeGrupoPreparado = null;

  function wireGrupoEjemplosControls() {
    byId('lab-grupo-consecutivas').addEventListener('click', function () {
      lanzarEjemploDeGrupo('consecutivas', byId('lab-grupo-consecutivas'));
    });
    byId('lab-grupo-simultaneas').addEventListener('click', function () {
      lanzarEjemploDeGrupo('simultaneas', byId('lab-grupo-simultaneas'));
    });
    byId('lab-grupo-conflicto').addEventListener('click', prepararConflictoDeGrupo);
    byId('lab-grupo-ocupar').addEventListener('click', ocuparElHuecoDeLaPropuesta);
    byId('lab-grupo-imposible').addEventListener('click', function () {
      var disparador = byId('lab-grupo-imposible');
      var equipo = latestSnapshot ? latestSnapshot.calendar.professionals : [];
      var primero = equipo.length > 0 ? String(equipo[0].employeeId) : '';
      abrirDialogoGrupo(disparador, {
        forma: 'simultaneous',
        fecha: latestSnapshot ? latestSnapshot.engineToday : '',
        filas: [
          { etiqueta: 'Persona 1', servicio: '1', profesional: primero },
          { etiqueta: 'Persona 2', servicio: '1', profesional: primero }
        ],
        paso: 3
      });
      // Se busca de verdad, contra la ruta real: el rechazo que se enseña es
      // el que el servidor devuelve en el paso 0 de §4.5, con sus palabras.
      buscarPropuestasDeGrupo();
    });
  }

  function lanzarEjemploDeGrupo(nombre, disparador) {
    var semilla = semillaDeEjemplo(nombre);
    semilla.paso = 3;
    limpiarLinea(byId('lab-grupo-estado'));
    abrirDialogoGrupo(disparador, semilla);
    buscarPropuestasDeGrupo();
  }

  /**
   * Escenario 3 del §4.13, primera mitad: se carga el ejemplo 1 y se pide la
   * propuesta de verdad, SIN abrir el diálogo. Lo que queda guardado es la
   * primera línea de la primera propuesta, que es el hueco que el botón de
   * abajo va a ocupar antes de que nadie confirme.
   */
  function prepararConflictoDeGrupo() {
    var estado = byId('lab-grupo-estado');
    var ocupar = byId('lab-grupo-ocupar');
    conflictoDeGrupoPreparado = null;
    ocupar.disabled = true;
    var semilla = semillaDeEjemplo('consecutivas');
    grupoState = {
      paso: 3,
      filas: semilla.filas,
      forma: semilla.forma,
      fecha: semilla.fecha,
      propuestas: [],
      elegida: null,
      disparador: byId('lab-grupo-conflicto')
    };
    setEstadoLinea(estado, 'Buscando la propuesta…', '');
    return sendJson('/api/booking/group/proposals', cuerpoDePropuesta(), null)
      .then(function (r) {
        var propuestas = (r.json && r.json.proposals) || [];
        if (!r.ok || propuestas.length === 0) {
          setEstadoLinea(estado, 'Ahora mismo no hay ninguna propuesta que ocupar. Reinicia la demostración y vuelve a intentarlo.', 'error');
          return;
        }
        grupoState.propuestas = propuestas;
        grupoState.elegida = 0;
        conflictoDeGrupoPreparado = propuestas[0];
        ocupar.disabled = false;
        var primera = propuestas[0].lines[0];
        setEstadoLinea(estado, 'Propuesta preparada: ' + propuestas[0].dateLabel + ', ' + primera.whenLabel + ' con ' +
          primera.professionalLabel + ' para ' + primera.memberLabel +
          '. Ahora pulsa «Ocupar ahora el primer hueco de la propuesta (simulado)».', 'ok');
      })
      .catch(function () {
        setEstadoLinea(estado, SIN_CONEXION, 'error');
      });
  }

  /**
   * Segunda mitad: una llamada del Laboratorio ocupa ese hueco por la ruta que
   * YA EXISTE (\`POST /api/scenario/run\`, sin tocarla), y después se abre el
   * diálogo en el paso 4 con la propuesta que el operador ya había visto. Al
   * confirmar, el servidor revalida, encuentra el hueco ocupado y responde con
   * su conflicto: cero citas creadas.
   */
  function ocuparElHuecoDeLaPropuesta() {
    var estado = byId('lab-grupo-estado');
    var boton = byId('lab-grupo-ocupar');
    var propuesta = conflictoDeGrupoPreparado;
    if (!propuesta) return undefined;
    var linea = propuesta.lines[0];
    boton.disabled = true;
    setEstadoLinea(estado, 'Ocupando el hueco…', '');
    return fetch('/api/scenario/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenarioId: 'A40-consola-ocupa-el-hueco-del-grupo',
        turns: [{
          utterance: 'quiero reservar una cita',
          day: 'tuesday',
          time: formatMinutes(linea.startMinutes),
          professionalId: linea.employeeId,
          serviceId: linea.serviceId,
          serviceConfirmed: true,
          bookingConfirmed: true
        }]
      })
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, json: json }; });
    }).then(function (r) {
      if (!r.ok) {
        boton.disabled = false;
        setEstadoLinea(estado, 'No se ha podido ocupar el hueco. No se ha cambiado nada.', 'error');
        return undefined;
      }
      return refresh().then(function () {
        setEstadoLinea(estado, 'El hueco de las ' + linea.whenLabel + ' con ' + linea.professionalLabel +
          ' ya está ocupado. El diálogo sigue enseñando la propuesta de antes: confírmala y verás que no se crea ninguna cita.', 'ok');
        abrirDialogoGrupo(byId('lab-grupo-ocupar'), {
          forma: grupoState.forma,
          fecha: grupoState.fecha,
          filas: grupoState.filas
        });
        // La propuesta se repone TAL CUAL estaba: es justo lo que hace
        // demostrable que el servidor revalida y no se fía de ella.
        grupoState.propuestas = [propuesta];
        grupoState.elegida = 0;
        renderPropuestasDeGrupo();
        irAPasoGrupo(4);
      });
    }).catch(function () {
      boton.disabled = false;
      setEstadoLinea(estado, SIN_CONEXION, 'error');
    });
  }

  // ---- Laboratorio: el historial de operaciones (§5.6) -------------------

  function renderHistorialDeOperaciones(snap) {
    var lista = byId('lab-operaciones-lista');
    if (!lista || !snap.operations) return;
    var eventos = snap.operations.audit.items.slice().reverse();
    setHidden(byId('lab-operaciones-vacio'), eventos.length > 0);
    reconcileList(lista, eventos, function (ev) { return ev.id; }, function (ev, li) {
      var node = li || el('li', '', '');
      setText(node, String(ev.seq) + ' · ' + ev.kind + ' · ' + ev.text);
      return node;
    });
  }

  // =====================================================================
  // INASISTENCIAS Y RESERVA PARA VARIAS PERSONAS — FIN DEL BLOQUE
  // =====================================================================

  // ---------------------------------------------------------------------
  // Poll
  // ---------------------------------------------------------------------

  /**
   * (step 18 §1.3) Mientras dura un reinicio, NINGÚN sondeo repinta. La
   * comprobación va donde se pinta —no donde se lanza la petición— porque el
   * sondeo peligroso es justamente el que salió ANTES del reinicio y se
   * resuelve en medio: repintaría la sección con el mundo viejo, entre el
   * barrido y el anuncio, y devolvería a la pantalla justo lo que se acaba
   * de limpiar. La secuencia de reinicio repinta con su propia llamada,
   * \`refresh(true)\`, que es la única que atraviesa la pausa.
   */
  var sondeoEnPausa = false;

  /**
   * (Revisión adversarial de step 22, N4) El \`.catch\` estaba ENGANCHADO
   * DETRÁS del \`.then\` que pinta, así que cualquier excepción de un pintor
   * caía en él y se anunciaba como "Sin conexión con el motor". La píldora de
   * frescura es la única afirmación de "esto está vivo" que hay en la
   * pantalla (ver su nota, más arriba), o sea que es justo el sitio donde no
   * se puede mentir: decía que había fallado la red cuando la red había ido
   * perfectamente y lo roto era el código de pintar.
   *
   * La cadena va ahora partida: el primer \`.catch\` cubre SÓLO el transporte
   * (la petición y su lectura como JSON) y devuelve un centinela; el pintado
   * va después, en su propio \`.then\`; y el \`.catch\` final ya sólo puede
   * recibir excepciones de pintado, que se cuentan como lo que son por la
   * consola del navegador y NO tocan la píldora. La píldora deja así de
   * hablar de una red que no ha fallado.
   */
  var SONDEO_SIN_DATOS = {};

  function refresh(forzado) {
    // Devuelve la promesa para que una acción pueda esperar a tener la
    // instantánea nueva antes de contar lo que ha pasado. Quien no la
    // necesite puede seguir ignorándola, como hasta ahora.
    return fetch('/api/snapshot', { method: 'GET' })
      .then(function (res) { return res.json(); })
      .catch(function () {
        if (!(sondeoEnPausa && !forzado)) renderFreshness(false);
        return SONDEO_SIN_DATOS;
      })
      .then(function (snap) {
        if (snap === SONDEO_SIN_DATOS) return;
        if (sondeoEnPausa && !forzado) return;
        latestSnapshot = snap;
        renderFreshness(true);
        // (step 18 §3.6) El reloj sintético vive en la barra superior, que es
        // común a las siete vistas: se repinta con cada instantánea, no dentro
        // de una sección.
        renderRelojSintetico(snap);
        renderActiveSection();
      })
      .catch(function (err) {
        // Aquí ya no puede caer un fallo de transporte: ése lo atrapó el
        // \`.catch\` de arriba y salió por el centinela. Lo que llegue aquí es
        // una excepción de PINTADO. Se dice por la consola del navegador, con
        // su error de verdad, y la píldora se queda como estaba: no tiene
        // nada que contar sobre una red que ha funcionado.
        if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
          // Una línea, con el mensaje del error y sin volcar el objeto entero:
          // lo que hace falta para saber QUÉ ha fallado y que no es la red.
          console.error('Error al pintar la instantánea del sondeo: ' + ((err && err.message) || String(err)));
        }
      });
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    wireAgendaControls();
    wireHuecosControls();
    wireLlamadasControls();
    // step 26 REAPERTURA §R7/§R8/§R9/§R10/§R13 — la pantalla «Horarios y
    // ausencias» y sus tres diálogos: alta de cierre o día especial, alta de
    // ausencia, y detalle para cambiar o retirar.
    wireHorariosYAusenciasControls();
    wireDiaEspecialDialog();
    wireAusenciaDialog();
    wireExcepcionDialog();
    wireLaboratorioControls();
    wireListaEsperaControls();
    wireCancelarCitaDialog();
    wireAltaListaDialog();
    wireSimularAvisoDialog();
    wireConvertirDialog();
    // (step 18 §5) Los tres diálogos nuevos y los dos paneles del Laboratorio.
    wireInasistenciaDialog();
    wireCorregirInasistenciaDialog();
    wireGrupoDialog();
    wireCitaManualDialog();
    // (step 26 §6.6) El detalle de una cita de la rejilla de Agenda.
    wireCitaDetalleDialog();
    wireRelojLabControls();
    wireGrupoEjemplosControls();
    wireTareasHumanasControls();
    // (step 19 Capacidad 3) El resumen para Bruno y el guion en pantalla.
    wireResumenOwnerControls();
    wireGuionEnPantallaControls();
    // (step 20 §3) El taller de decisiones con Bruno.
    wireTallerControls();
    window.addEventListener('hashchange', alCambiarElHash);
    applyRoute();
    refresh();
    // El envoltorio es deliberado: el sondeo llama SIEMPRE a \`refresh()\` sin
    // argumentos, nunca con lo que el temporizador pudiera pasarle.
    pollTimer = window.setInterval(function () { refresh(); }, POLL_MS);
  });
})();
`;
}
