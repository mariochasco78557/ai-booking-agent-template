import { describe, it, expect } from "vitest";

import { renderConsoleHtml } from "../../src/console/ui.html.js";
import { renderConsoleAppJs } from "../../src/console/ui.js.js";
import { MANUAL_BOOKING_COPY, MANUAL_CONFLICT_LABELS, formatDurationEs } from "../../src/console/operationsSnapshot.js";
import { MANUAL_CLIENT_LABEL_RE } from "../../src/callEngine/operations/model.js";
import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, type FakeElement } from "./fakeDom.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 24 · EL CONTRATO DE LA INTERFAZ de la cita manual.
 *
 * QUÉ FIRMA ESTE FICHERO y qué no. Aquí se comprueba la ESTRUCTURA del
 * documento y del JavaScript servido: que existe el diálogo nativo con su
 * título enfocable, que el catálogo de personas es cerrado, que NO hay ni un
 * campo de texto libre ni un campo de hora, que ninguna opción viene marcada y
 * que el navegador no compone frases de negocio.
 *
 * LO QUE NO FIRMA, y por eso existe `tools/console-audit/audit-mvps24.mjs`: el
 * orden de tabulación, la trampa de foco del `<dialog>`, el Escape que se come
 * el navegador, el retorno del foco, el sondeo, el zoom y una sola regla de
 * CSS. Nada de eso lo puede contestar un DOM de mentira, y decir lo contrario
 * sería exactamente el tipo de verificación falsa que esta consola no cuenta.
 * ────────────────────────────────────────────────────────────────────────
 */

const html = renderConsoleHtml();
const js = renderConsoleAppJs();

/**
 * El trozo del documento que es EXACTAMENTE el diálogo de la cita manual: de su
 * `<dialog` de apertura a su `</dialog>` de cierre. Recortar de más metería
 * marcado ajeno y esta prueba juzgaría a este diálogo por lo que hace otro.
 */
const dialogo = (() => {
  const marca = html.indexOf('id="dialogo-cita-manual"');
  expect(marca).toBeGreaterThan(-1);
  const inicio = html.lastIndexOf("<dialog", marca);
  const fin = html.indexOf("</dialog>", marca);
  expect(inicio).toBeGreaterThan(-1);
  expect(fin).toBeGreaterThan(inicio);
  return html.slice(inicio, fin + "</dialog>".length);
})();

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("step 24 · interfaz — la entrada y el diálogo", () => {
  it("la acción principal vive en la Agenda y se llama exactamente «Crear cita manual»", () => {
    const agenda = html.slice(html.indexOf('id="vista-agenda"'), html.indexOf('id="vista-llamadas"'));
    expect(agenda).toContain('id="btn-abrir-cita-manual"');
    expect(agenda).toContain(">Crear cita manual<");
    expect(MANUAL_BOOKING_COPY.openButton).toBe("Crear cita manual");
    // Y NO se añade ninguna entrada a la navegación principal.
    const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
    expect(nav.toLowerCase()).not.toContain("cita manual");
  });

  it("es un `<dialog>` NATIVO, etiquetado por su título, y el título es enfocable", () => {
    expect(dialogo).toContain('<dialog class="tx-dialog tx-dialog--wide" id="dialogo-cita-manual"');
    expect(dialogo).toContain('aria-labelledby="dialogo-cita-manual-titulo"');
    expect(dialogo).toMatch(/id="dialogo-cita-manual-titulo"[^>]*tabindex="-1"/);
  });

  it("tiene sus dos regiones vivas: un estado y una alerta, ni una más", () => {
    expect(dialogo).toContain('id="manual-estado" role="status" aria-live="polite"');
    expect(dialogo).toContain('id="manual-error" role="alert"');
    expect((dialogo.match(/role="(status|alert)"/g) ?? [])).toHaveLength(2);
  });

  it("los cinco pasos existen, en orden, y cada uno tiene su encabezado enfocable", () => {
    for (let i = 1; i <= 5; i += 1) {
      expect(dialogo, `falta el paso ${String(i)}`).toContain(`id="manual-paso-${String(i)}"`);
      expect(dialogo).toMatch(new RegExp(`id="manual-paso-${String(i)}-titulo"[^>]*tabindex="-1"`));
    }
    // Y los pasos 2..5 nacen ocultos: se entra por el 1.
    for (let i = 2; i <= 5; i += 1) {
      expect(dialogo).toContain(`<div id="manual-paso-${String(i)}" hidden>`);
    }
  });

  it("el botón final dice LITERALMENTE lo que manda el diseño", () => {
    expect(dialogo).toContain(">Confirmar y crear la cita sintética<");
    expect(MANUAL_BOOKING_COPY.confirmButton).toBe("Confirmar y crear la cita sintética");
  });
});

describe("step 24 · interfaz — no hay por dónde colar un dato personal", () => {
  it("NO hay ni un campo de texto libre en todo el diálogo", () => {
    // Ni `text`, ni `textarea`, ni `search`, ni `tel`, ni `email`.
    for (const prohibido of ['type="text"', "<textarea", 'type="search"', 'type="tel"', 'type="email"', 'type="url"']) {
      expect(dialogo.includes(prohibido), `el diálogo tiene ${prohibido}`).toBe(false);
    }
  });

  it("NO hay ningún campo de hora: la hora sólo se elige de la lista de huecos", () => {
    for (const prohibido of ['type="time"', 'type="datetime-local"', 'type="number"']) {
      expect(dialogo.includes(prohibido), `el diálogo tiene ${prohibido}`).toBe(false);
    }
    // El único `input` de fecha es el del día, y es de tipo `date`.
    expect((dialogo.match(/type="date"/g) ?? [])).toHaveLength(1);
  });

  it("las seis personas son un catálogo CERRADO, y todas cumplen la expresión del dominio", () => {
    const valores = [...dialogo.matchAll(/name="manual-persona" value="([^"]+)"/g)].map((m) => m[1] as string);
    expect(valores).toEqual(["Cliente A", "Cliente B", "Cliente C", "Cliente D", "Cliente E", "Cliente F"]);
    for (const v of valores) expect(MANUAL_CLIENT_LABEL_RE.test(v), v).toBe(true);
    // El JavaScript conoce exactamente las mismas seis.
    expect(js).toContain("var PERSONAS_MANUALES = ['Cliente A', 'Cliente B', 'Cliente C', 'Cliente D', 'Cliente E', 'Cliente F']");
  });

  it("el catálogo de servicios es el cerrado de tres, y los tres dicen su duración", () => {
    const valores = [...dialogo.matchAll(/name="manual-servicio" value="([^"]+)"/g)].map((m) => m[1] as string);
    expect(valores.sort()).toEqual(["0", "1", "2"]);
    expect((dialogo.match(/30 minutos/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("ningún identificador interno aparece en el marcado del diálogo", () => {
    // Se buscan las FORMAS REALES de cada identificador, no un prefijo suelto:
    // la primera redacción buscaba «slot-» a secas y saltaba con la clase CSS
    // `tx-slot-card__choice`, que no es un identificador de nada.
    const formas: ReadonlyArray<[string, RegExp]> = [
      ["reserva de cita manual", /res-m-man-\d/],
      ["cita manual", /\bman-\d{4}\b/],
      ["clave de hueco", /\bslot-\d{4}-\d{2}-\d{2}-/],
      ["clave de intención", /manual:\d{4}-/],
      ["entrada de lista de espera", /\bwl-f\d/],
      ["grupo", /\bgrp-\d/],
    ];
    for (const [nombre, re] of formas) {
      expect(re.test(dialogo), `el diálogo enseña un identificador de ${nombre}`).toBe(false);
    }
  });
});

describe("step 24 · interfaz — nada viene elegido y cada puerta dice por qué está cerrada", () => {
  it("NINGUNA opción del diálogo nace marcada", () => {
    expect(dialogo.includes("checked")).toBe(false);
  });

  it("los cuatro botones de avance nacen deshabilitados y apuntan a su explicación", () => {
    for (const [boton, puerta] of [
      ["manual-siguiente-1", "manual-paso1-gate"],
      ["manual-siguiente-2", "manual-paso2-gate"],
      ["manual-siguiente-3", "manual-paso3-gate"],
      ["manual-siguiente-4", "manual-paso4-gate"],
    ]) {
      const etiqueta = dialogo.slice(dialogo.indexOf(`id="${boton}"`));
      const cierre = etiqueta.slice(0, etiqueta.indexOf(">"));
      expect(cierre, `${boton} no nace deshabilitado`).toContain("disabled");
      expect(cierre, `${boton} no apunta a su explicación`).toContain(`aria-describedby="${puerta}"`);
    }
  });

  it("el botón de confirmar NO nace deshabilitado: llegar al paso 5 ya es la condición", () => {
    const etiqueta = dialogo.slice(dialogo.indexOf('id="manual-confirmar"'));
    expect(etiqueta.slice(0, etiqueta.indexOf(">"))).not.toContain("disabled");
  });
});

describe("step 24 · interfaz — el navegador no compone negocio ni acuña identidades", () => {
  const bloque = (() => {
    const inicio = js.indexOf("// step 24 — CREAR CITA MANUAL");
    const fin = js.indexOf("// ---- Laboratorio: el reloj de la demostración");
    expect(inicio).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(inicio);
    return stripComments(js.slice(inicio, fin));
  })();

  it("no acuña la clave de idempotencia: la manda resuelta el servidor", () => {
    expect(bloque).toContain("p.keyToMint");
    expect(bloque.includes("'manual:'")).toBe(false);
    expect(bloque.includes("':r'")).toBe(false);
  });

  it("no redacta ninguna frase de conflicto: las lee de la respuesta", () => {
    for (const frase of Object.values(MANUAL_CONFLICT_LABELS)) {
      expect(bloque.includes(frase), `el navegador escribe «${frase}»`).toBe(false);
    }
    expect(bloque).toContain("r.json.message");
  });

  it("no compone la frase de éxito ni la del profesional asignado: las lee del servidor", () => {
    expect(bloque).toContain("cita.successLabel");
    expect(bloque).toContain("p.professionalNote");
    expect(bloque).toContain("p.syntheticNotice");
    expect(bloque.includes("ha sustituido")).toBe(false);
    expect(bloque.includes("Creada manualmente por el operador")).toBe(false);
  });

  it("los huecos se piden al EXPLORADOR canónico, no a una ruta propia", () => {
    expect(bloque).toContain("/api/availability/explore");
    // Y no existe ninguna ruta paralela de disponibilidad para este diálogo.
    expect(js.includes("/api/booking/manual/slots")).toBe(false);
    expect(js.includes("/api/manual/availability")).toBe(false);
  });

  it("una REPETICIÓN no se locuta como una creación", () => {
    expect(bloque).toContain("Esa cita ya estaba creada. No se ha creado ninguna cita nueva.");
    // Y la rama de repetición mira las DOS señales: la de transporte y la
    // estructural del propio comando.
    expect(bloque).toContain("r.repetida");
    expect(bloque).toContain("alreadyExists");
  });

  it("un conflicto devuelve al paso de huecos en vez de dejar en pantalla algo que ya no vale", () => {
    expect(bloque).toContain("olvidarHuecosManuales()");
    expect(bloque).toContain("irAPasoManual(3)");
  });
});

describe("step 24 · interfaz — la Agenda distingue el origen", () => {
  it("la fila pinta el origen que redacta el servidor, y no el identificador de la cita", () => {
    const bloqueAgenda = stripComments(js);
    expect(bloqueAgenda).toContain("r.manual.originLabel");
    expect(bloqueAgenda).toContain("r.manual.clientLabel");
    expect(bloqueAgenda.includes("r.manual.manualBookingId")).toBe(false);
  });

  it("los cuatro orígenes se distinguen, y ninguno se confunde con otro", () => {
    const fuente = stripComments(js);
    expect(fuente).toContain("r.originatedFromWaitlistEntryId");
    expect(fuente).toContain("r.group");
    expect(fuente).toContain("r.manual");
    // Y una cita manual NUNCA se marca con un hash de llamada.
    expect(fuente.includes("manual.callIdHash")).toBe(false);
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 26 §13 · B14/B15-DOM — el control «Duración» del paso 1.
 *
 * QUÉ FIRMA: la estructura del control (seis opciones, la habitual rotulada
 * como del catálogo, «Otra duración…» sin texto libre, capaz de expresar
 * 2 h 15 min), la invalidación en cascada del hueco al cambiar de duración,
 * que las dos peticiones mandan `durationMinutes` desde el estado del
 * asistente (nunca desde la propuesta, que no lo lleva), y que los rótulos
 * estáticos coinciden carácter a carácter con `formatDurationEs`.
 *
 * LO QUE NO FIRMA: el recorrido real del asistente clic a clic (eso exige
 * ejecutar `wireCitaManualDialog` contra un DOM falso, y ese cableado sólo
 * se expone añadiendo un hook a `tests/console/uiClientExtract.ts`, fuera
 * de las rutas que esta pieza puede tocar). Por eso las pruebas de abajo
 * comprueban el MARCADO servido y el CUERPO LITERAL de cada manejador — la
 * misma técnica que ya usa el resto de este fichero.
 * ────────────────────────────────────────────────────────────────────────
 */

/** El bloque de la cita manual, sin comentarios: el mismo recorte que usa el resto del fichero. */
const bloqueManual = (() => {
  const inicio = js.indexOf("// step 24 — CREAR CITA MANUAL");
  const fin = js.indexOf("// ---- Laboratorio: el reloj de la demostración");
  expect(inicio).toBeGreaterThan(-1);
  expect(fin).toBeGreaterThan(inicio);
  return stripComments(js.slice(inicio, fin));
})();

/** El trozo del diálogo que es EXACTAMENTE el `<fieldset>` de Duración. */
const duracionFieldset = (() => {
  const inicio = dialogo.indexOf('<fieldset class="tx-slot-card__choice" id="manual-duracion-campo"');
  expect(inicio).toBeGreaterThan(-1);
  const fin = dialogo.indexOf("</fieldset>", inicio);
  expect(fin).toBeGreaterThan(inicio);
  return dialogo.slice(inicio, fin + "</fieldset>".length);
})();

const PREAJUSTES: ReadonlyArray<[string, number, string]> = [
  ["manual-duracion-30", 30, "30 min · habitual"],
  ["manual-duracion-60", 60, "1 h"],
  ["manual-duracion-90", 90, "1 h 30 min"],
  ["manual-duracion-120", 120, "2 h"],
  ["manual-duracion-150", 150, "2 h 30 min"],
];

const ALTERNATIVAS: ReadonlyArray<[number, string]> = [
  [15, "15 min"],
  [45, "45 min"],
  [75, "1 h 15 min"],
  [105, "1 h 45 min"],
  [135, "2 h 15 min"],
  [165, "2 h 45 min"],
  [180, "3 h"],
  [195, "3 h 15 min"],
  [210, "3 h 30 min"],
  [225, "3 h 45 min"],
  [240, "4 h"],
];

describe("step 26 §13 · B14 — el control «Duración» existe con sus seis opciones", () => {
  it("el `<fieldset>` nace oculto, con la leyenda «Duración» y sin ninguna opción marcada", () => {
    expect(duracionFieldset).toContain("<legend>Duración</legend>");
    expect(duracionFieldset.includes("checked")).toBe(false);
    // Oculto de fábrica: el paso 1 sigue prometiendo que nada se marca antes
    // de que el operador elija un servicio.
    const antesDelCierre = dialogo.slice(0, dialogo.indexOf('id="manual-duracion-campo"'));
    const etiquetaApertura = dialogo.slice(antesDelCierre.lastIndexOf("<fieldset"));
    expect(etiquetaApertura.slice(0, etiquetaApertura.indexOf(">"))).toContain("hidden");
  });

  it("las cinco duraciones preajustadas tienen el id y el rótulo LITERAL del contrato, con «30 min · habitual» marcando su procedencia del catálogo", () => {
    for (const [id, valor, rotulo] of PREAJUSTES) {
      expect(duracionFieldset, `falta ${id}`).toContain(
        `<input type="radio" name="manual-duracion" value="${String(valor)}" id="${id}"> <span>${rotulo}</span>`,
      );
    }
  });

  it("«Otra duración…» es la sexta opción y no repite el valor de ningún preajuste", () => {
    expect(duracionFieldset).toContain(
      '<input type="radio" name="manual-duracion" value="otra" id="manual-duracion-otra"> <span>Otra duración…</span>',
    );
    // Seis opciones, ni una más: los cinco preajustes y «otra».
    expect((duracionFieldset.match(/type="radio" name="manual-duracion"/g) ?? [])).toHaveLength(6);
  });

  it("la nota de procedencia del catálogo usa el texto exacto del contrato, y acompaña al control ya oculto", () => {
    expect(dialogo).toContain(
      '<p class="tx-context__note" id="manual-duracion-nota" hidden>Los tres servicios del catálogo duran 30 minutos. Esa es la duración marcada.</p>',
    );
  });

  it("el aviso de duración especial existe, con el texto exacto del contrato, y nace oculto", () => {
    expect(dialogo).toContain(
      '<p class="tx-status-line" id="manual-duracion-aviso" hidden>Duración especial elegida por el operador.</p>',
    );
  });
});

describe("step 26 §13 · B14 — «Otra duración…» expresa pasos de 15 min, sin texto libre, y alcanza 2 h 15 min", () => {
  const selector = (() => {
    const inicio = dialogo.indexOf('<select id="manual-duracion-otra-valor">');
    expect(inicio).toBeGreaterThan(-1);
    const fin = dialogo.indexOf("</select>", inicio);
    return dialogo.slice(inicio, fin + "</select>".length);
  })();

  it("nace dentro de un campo oculto, gemelo del resto de campos del asistente", () => {
    expect(dialogo).toContain('<div class="tx-field" id="manual-duracion-otra-campo" hidden>');
  });

  it("es un `<select>`, NUNCA un campo de hora ni de texto libre", () => {
    expect(selector.startsWith("<select")).toBe(true);
    for (const prohibido of ['type="text"', 'type="number"', 'type="time"', "<textarea"]) {
      expect(selector.includes(prohibido), `«Otra duración…» tiene ${prohibido}`).toBe(false);
    }
  });

  it("los once rótulos alternativos aparecen, en el orden exacto del contrato, y ninguno repite un preajuste", () => {
    let cursor = -1;
    for (const [valor, rotulo] of ALTERNATIVAS) {
      const marca = `<option value="${String(valor)}">${rotulo}</option>`;
      const posicion = selector.indexOf(marca);
      expect(posicion, `falta o está desordenado: ${marca}`).toBeGreaterThan(cursor);
      cursor = posicion;
    }
    // Exactamente 11 alternativas + la opción vacía inicial = 12 `<option>`.
    expect((selector.match(/<option/g) ?? [])).toHaveLength(12);
    // Ninguna alternativa coincide con un valor ya preajustado.
    const valoresPreajustados = new Set(PREAJUSTES.map(([, v]) => v));
    for (const [valor] of ALTERNATIVAS) expect(valoresPreajustados.has(valor)).toBe(false);
  });

  it("2 h 15 min (135 minutos) es una alternativa alcanzable, con su rótulo exacto", () => {
    expect(selector).toContain('<option value="135">2 h 15 min</option>');
  });
});

describe("step 26 §13 · B14 — elegir servicio marca por código la duración habitual, y sólo entonces", () => {
  it("cada radio de servicio, al cambiar, invoca `marcarDuracionHabitual()` además de invalidar los huecos", () => {
    const manejador = bloqueManual.slice(
      bloqueManual.indexOf("['manual-servicio-0', 'manual-servicio-1', 'manual-servicio-2'].forEach"),
      bloqueManual.indexOf("var DURACIONES_PREAJUSTADAS"),
    );
    expect(manejador).toContain("olvidarHuecosManuales();");
    expect(manejador).toContain("marcarDuracionHabitual();");
  });

  it("`marcarDuracionHabitual` marca EXACTAMENTE `manual-duracion-30`, fija 30 minutos, apaga el aviso especial y revela el control", () => {
    const cuerpo = bloqueManual.slice(
      bloqueManual.indexOf("function marcarDuracionHabitual()"),
      bloqueManual.indexOf("function abrirDialogoCitaManual"),
    );
    expect(cuerpo).toMatch(/id === 'manual-duracion-30'/);
    expect(cuerpo).toContain("manualState.duracion = 30;");
    expect(cuerpo).toContain("manualState.duracionEspecial = false;");
    expect(cuerpo).toContain("setHidden(byId('manual-duracion-campo'), false);");
    expect(cuerpo).toContain("setHidden(byId('manual-duracion-nota'), false);");
    expect(cuerpo).toContain("setHidden(byId('manual-duracion-aviso'), true);");
  });

  it("la puerta del paso 1 exige servicio Y duración resuelta, con la frase exacta cuando falta la duración", () => {
    expect(bloqueManual).toContain("Falta elegir cuántos minutos dura la cita especial.");
    expect(bloqueManual).toContain("manualState.duracion === null");
    expect(bloqueManual).toContain("byId('manual-siguiente-1').disabled = faltaServicio || faltaDuracion;");
  });
});

describe("step 26 §13 · B14 — cambiar la duración invalida en cascada el hueco elegido", () => {
  it("los cinco preajustes llaman a `olvidarHuecosManuales()` al cambiar", () => {
    const manejador = bloqueManual.slice(
      bloqueManual.indexOf("DURACIONES_PREAJUSTADAS.forEach(function (id) {"),
      bloqueManual.indexOf("byId('manual-duracion-otra').addEventListener"),
    );
    expect(manejador).toContain("olvidarHuecosManuales();");
    expect(manejador).toContain("manualState.duracion = Number(ev.target.value);");
  });

  it("marcar «Otra duración…» también invalida los huecos, aunque todavía no resuelva ningún minuto", () => {
    const manejador = bloqueManual.slice(
      bloqueManual.indexOf("byId('manual-duracion-otra').addEventListener"),
      bloqueManual.indexOf("byId('manual-duracion-otra-valor').addEventListener"),
    );
    expect(manejador).toContain("manualState.duracion = null;");
    expect(manejador).toContain("olvidarHuecosManuales();");
  });

  it("elegir el número de minutos en el `<select>` también invalida los huecos", () => {
    const manejador = bloqueManual.slice(
      bloqueManual.indexOf("byId('manual-duracion-otra-valor').addEventListener"),
      bloqueManual.indexOf("['manual-quien-cualquiera', 'manual-quien-una'].forEach"),
    );
    expect(manejador).toContain("olvidarHuecosManuales();");
  });
});

describe("step 26 §13 · B14/B15 — las dos peticiones mandan `durationMinutes` desde el estado del asistente", () => {
  it("`buscarHuecosManuales` añade `durationMinutes` a la consulta del explorador canónico", () => {
    const manejador = bloqueManual.slice(
      bloqueManual.indexOf("function buscarHuecosManuales()"),
      bloqueManual.indexOf("function renderHuecosManuales()"),
    );
    expect(manejador).toContain("'&durationMinutes=' + encodeURIComponent(String(manualState.duracion))");
  });

  it("la vista previa manda `durationMinutes` en su cuerpo, tomado del estado, no de la propuesta", () => {
    const manejador = bloqueManual.slice(
      bloqueManual.indexOf("function pedirVistaPreviaManual()"),
      bloqueManual.indexOf("function minutosDeEtiqueta"),
    );
    expect(manejador).toContain("durationMinutes: manualState.duracion");
  });

  it("la confirmación TAMBIÉN manda `durationMinutes` desde el estado — `p.confirm` no lo lleva", () => {
    const manejador = bloqueManual.slice(
      bloqueManual.indexOf("function confirmarCitaManual()"),
      bloqueManual.indexOf("// ===== step 24 — FIN DEL BLOQUE"),
    );
    expect(manejador).toContain("durationMinutes: manualState.duracion");
    expect(manejador.includes("p.confirm.durationMinutes")).toBe(false);
  });
});

describe("step 26 §13 · B14 — abrir el asistente nunca preselecciona la duración, precarga o no", () => {
  it("`manualState`/`manualReset` inicializan `duracion` a `null`, no a 30 ni a ningún otro valor", () => {
    expect(bloqueManual).toMatch(/var manualState = \{[\s\S]*?duracion: null,/);
    expect(bloqueManual).toMatch(/function manualReset\(disparador\) \{[\s\S]*?duracion: null,/);
  });

  it("`abrirDialogoCitaManual` desmarca las seis opciones de duración y vuelve a ocultar todo el control", () => {
    const cuerpo = bloqueManual.slice(
      bloqueManual.indexOf("function abrirDialogoCitaManual(disparador, precarga)"),
      bloqueManual.indexOf("function mostrarPasoManual(n)"),
    );
    for (const id of PREAJUSTES.map(([i]) => i).concat(["manual-duracion-otra"])) {
      expect(cuerpo, `no desmarca #${id}`).toContain(id);
    }
    expect(cuerpo).toContain("if (nodo) nodo.checked = false;");
    expect(cuerpo).toContain("['manual-duracion-campo', true]");
    expect(cuerpo).toContain("['manual-duracion-otra-campo', true]");
    expect(cuerpo).toContain("['manual-duracion-aviso', true]");
  });
});

describe("step 26 §13 · B15-DOM — el resumen del paso 5 muestra inicio, fin y duración con el vocabulario servido", () => {
  it("el resumen sigue leyendo `Duración` de `p.durationLabel` y `Hora` (inicio–fin) de `p.whenLabel`, redactados por el servidor", () => {
    const cuerpo = bloqueManual.slice(
      bloqueManual.indexOf("function construirResumenManual()"),
      bloqueManual.indexOf("function confirmarCitaManual()"),
    );
    expect(cuerpo).toContain("['Duración', p.durationLabel]");
    expect(cuerpo).toContain("['Hora', p.whenLabel]");
    // El cliente no calcula la duración: nunca resta minutos de inicio/fin.
    expect(cuerpo.includes("endMinutes - startMinutes")).toBe(false);
    expect(cuerpo.includes("endMinutes -")).toBe(false);
  });

  it("el cliente no redefine `formatDurationEs`: el vocabulario de duración vive únicamente en el servidor", () => {
    expect(js.includes("function formatDurationEs")).toBe(false);
  });
});

describe("step 26 §13 · B15-DOM — los rótulos estáticos coinciden, carácter a carácter, con `formatDurationEs`", () => {
  it("los cinco preajustes: el número coincide exactamente, y sólo «30 min · habitual» añade el sufijo de catálogo", () => {
    for (const [, valor, rotulo] of PREAJUSTES) {
      const esperado = formatDurationEs(valor);
      if (valor === 30) {
        expect(rotulo).toBe(`${esperado} · habitual`);
      } else {
        expect(rotulo).toBe(esperado);
      }
    }
  });

  it("las once alternativas de «Otra duración…» coinciden EXACTAMENTE, sin ningún sufijo, con `formatDurationEs`", () => {
    for (const [valor, rotulo] of ALTERNATIVAS) {
      expect(rotulo).toBe(formatDurationEs(valor));
    }
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 26 §13 · cobertura DINÁMICA del control «Duración» (revisión
 * adversarial, hallazgo 5) — ahora que `wireCitaManualDialog` está expuesto
 * en `tests/console/uiClientExtract.ts` (commit `2e898b9`, a petición de
 * B-UI) y los once ids nuevos viven en `MANUAL_IDS` de
 * `tests/console/agendaHueco.test.ts` (commit `8100693`).
 *
 * Se ejecuta el JAVASCRIPT REAL contra un DOM falso: clics y cambios de
 * verdad sobre los nodos, `manualStateActual()` para leer el estado vivo, y
 * un `fetch` interceptado para capturar el CUERPO LITERAL que viaja a
 * `/api/booking/manual/preview` y `/api/booking/manual`. Las pruebas
 * ESTÁTICAS de arriba se mantienen: siguen firmando el marcado servido y el
 * vocabulario, que esto no repite.
 *
 * LO QUE NO FIRMA: el repintado completo de la consola tras `refresh()` —
 * este documento falso sólo sabe del diálogo de cita manual, así que un
 * `console.error` de pintura (nodos de otras pantallas que aquí no existen)
 * es esperado y no se comprueba; ver `noShowUi.test.ts` para el mismo patrón
 * ya aceptado en este repositorio.
 * ────────────────────────────────────────────────────────────────────────
 */

// Los ids que `wireCitaManualDialog()` y `abrirDialogoCitaManual()` tocan de
// verdad, MISMO conjunto que `MANUAL_IDS` de `agendaHueco.test.ts` (más los
// botones «Atrás»/«Cancelar» y `tx-view-title`, que allí no hacían falta
// porque ese fichero nunca engancha `wireCitaManualDialog`). Se duplica en
// vez de importarse porque esa constante no se exporta y esta pieza sólo
// puede tocar `tests/console/citaManualUi.test.ts`.
const MANUAL_DIALOG_IDS = [
  { id: "dialogo-cita-manual", tag: "dialog" },
  { id: "dialogo-cita-manual-titulo", tag: "h2" },
  "manual-estado",
  "manual-error",
  "manual-huecos",
  "manual-resumen",
  "manual-resumen-profesional",
  "manual-resumen-origen",
  "manual-resumen-sintetico",
  { id: "manual-confirmar", tag: "button" },
  { id: "manual-cerrar", tag: "button" },
  { id: "manual-cancelar-1", tag: "button" },
  { id: "manual-cancelar-2", tag: "button" },
  { id: "manual-cancelar-3", tag: "button" },
  { id: "manual-cancelar-4", tag: "button" },
  { id: "manual-cancelar-5", tag: "button" },
  { id: "manual-atras-2", tag: "button" },
  { id: "manual-atras-3", tag: "button" },
  { id: "manual-atras-4", tag: "button" },
  { id: "manual-atras-5", tag: "button" },
  "manual-profesional-campo",
  { id: "manual-fecha", tag: "input" },
  { id: "manual-servicio-0", tag: "input" },
  { id: "manual-servicio-1", tag: "input" },
  { id: "manual-servicio-2", tag: "input" },
  { id: "manual-quien-cualquiera", tag: "input" },
  { id: "manual-quien-una", tag: "input" },
  { id: "manual-persona-a", tag: "input" },
  { id: "manual-persona-b", tag: "input" },
  { id: "manual-persona-c", tag: "input" },
  { id: "manual-persona-d", tag: "input" },
  { id: "manual-persona-e", tag: "input" },
  { id: "manual-persona-f", tag: "input" },
  { id: "manual-profesional", tag: "select" },
  "manual-duracion-campo",
  { id: "manual-duracion-30", tag: "input" },
  { id: "manual-duracion-60", tag: "input" },
  { id: "manual-duracion-90", tag: "input" },
  { id: "manual-duracion-120", tag: "input" },
  { id: "manual-duracion-150", tag: "input" },
  { id: "manual-duracion-otra", tag: "input" },
  "manual-duracion-nota",
  "manual-duracion-otra-campo",
  { id: "manual-duracion-otra-valor", tag: "select" },
  "manual-duracion-aviso",
  "manual-paso-1",
  "manual-paso-2",
  "manual-paso-3",
  "manual-paso-4",
  "manual-paso-5",
  "manual-paso1-gate",
  "manual-paso2-gate",
  "manual-paso3-gate",
  "manual-paso4-gate",
  { id: "manual-siguiente-1", tag: "button" },
  { id: "manual-siguiente-2", tag: "button" },
  { id: "manual-siguiente-3", tag: "button" },
  { id: "manual-siguiente-4", tag: "button" },
  "tx-view-title",
] as const;

/**
 * El estado vivo de `manualState`, con los dos campos de step 26 §13
 * (`duracion`, `duracionEspecial`) que el tipo compartido `UiTestHooks` de
 * `uiClientExtract.ts` todavía no declara — esta pieza no puede tocar ese
 * fichero, así que se amplía aquí, sólo para el tipo, sin tocar en absoluto
 * el objeto en tiempo de ejecución (es el `manualState` real).
 */
type EstadoManualConDuracion = {
  paso: number;
  servicio: string;
  fecha: string;
  modo: string;
  profesional: string;
  huecos: unknown[];
  elegido: unknown;
  persona: string;
  propuesta: unknown;
  disparador: unknown;
  duracion: number | null;
  duracionEspecial: boolean;
};

/**
 * El DOM falso no interpreta atributos: copia el `value` REAL de cada radio
 * desde el HTML servido (el mismo `dialogo` que firman las pruebas
 * estáticas de arriba), igual que ya hace `exploradorUi.test.ts`. Si el
 * marcado real cambiara de valor, esto falla aquí a la vista, no en
 * silencio con un `manualState.servicio` vacío.
 */
function valorRealDe(id: string): string {
  const etiqueta = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(dialogo)?.[0] ?? "";
  const valor = /value="([^"]*)"/.exec(etiqueta)?.[1];
  expect(valor, `#${id} no declara ningún value en el HTML servido`).toBeDefined();
  return valor as string;
}

const RADIOS_CON_VALOR_REAL = [
  "manual-servicio-0",
  "manual-servicio-1",
  "manual-servicio-2",
  "manual-quien-cualquiera",
  "manual-quien-una",
  "manual-persona-a",
  "manual-persona-b",
  "manual-persona-c",
  "manual-persona-d",
  "manual-persona-e",
  "manual-persona-f",
  "manual-duracion-30",
  "manual-duracion-60",
  "manual-duracion-90",
  "manual-duracion-120",
  "manual-duracion-150",
  "manual-duracion-otra",
];

function montarDialogo(): { document: unknown; nodes: Record<string, FakeElement>; hooks: ReturnType<typeof loadUiClientHooks> } {
  const { document, nodes } = createFakeDocumentWithIds(MANUAL_DIALOG_IDS);
  for (const id of RADIOS_CON_VALOR_REAL) nodes[id]!.value = valorRealDe(id);
  const win = { location: { hash: "" }, scrollTo: () => {} };
  const hooks = loadUiClientHooks("", document, win);
  hooks.wireCitaManualDialog();
  return { document, nodes, hooks };
}

/** Marca un radio y dispara su `change`, como ya hace el resto de este banco de pruebas (`exploradorUi.test.ts`, `groupUi.test.ts`, `tallerUi.test.ts`). */
function marcar(radio: FakeElement): void {
  radio.checked = true;
  radio.dispatchChange();
}

/** Drena la cola de microtareas (las promesas encadenadas de `fetch`/`sendJson`) antes de comprobar el resultado. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("step 26 §13 · dinámico — elegir servicio marca por código la duración habitual, y sólo entonces", () => {
  it("marca «30 min · habitual», revela el control y su nota, fija 30 minutos y abre la puerta del paso 1", () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-1"]);

    expect(nodes["manual-duracion-30"].checked).toBe(true);
    for (const id of ["manual-duracion-60", "manual-duracion-90", "manual-duracion-120", "manual-duracion-150", "manual-duracion-otra"]) {
      expect(nodes[id].checked, `#${id} viene marcado`).toBe(false);
    }
    expect(nodes["manual-duracion-campo"].hidden).toBe(false);
    expect(nodes["manual-duracion-nota"].hidden).toBe(false);
    expect(nodes["manual-duracion-aviso"].hidden).toBe(true);

    const estado = hooks.manualStateActual() as EstadoManualConDuracion;
    expect(estado.duracion).toBe(30);
    expect(estado.duracionEspecial).toBe(false);
    expect(nodes["manual-siguiente-1"].disabled).toBe(false);
    expect(nodes["manual-paso1-gate"].textContent).toBe("Ya puedes seguir al paso 2.");
  });
});

describe("step 26 §13 · dinámico — «Otra duración…» resuelve 135 minutos (2 h 15 min) sin texto libre", () => {
  it("marcar «Otra duración…» abre el <select> y cierra la puerta hasta que se elige un valor; elegir 135 la resuelve", () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-0"]);
    marcar(nodes["manual-duracion-otra"]);

    expect(nodes["manual-duracion-otra-campo"].hidden).toBe(false);
    expect(nodes["manual-duracion-aviso"].hidden).toBe(false);
    let estado = hooks.manualStateActual() as EstadoManualConDuracion;
    expect(estado.duracion).toBeNull();
    expect(estado.duracionEspecial).toBe(true);
    expect(nodes["manual-siguiente-1"].disabled).toBe(true);
    expect(nodes["manual-paso1-gate"].textContent).toBe("Falta elegir cuántos minutos dura la cita especial.");

    nodes["manual-duracion-otra-valor"].value = "135";
    nodes["manual-duracion-otra-valor"].dispatchChange();

    estado = hooks.manualStateActual() as EstadoManualConDuracion;
    expect(estado.duracion).toBe(135);
    expect(nodes["manual-siguiente-1"].disabled).toBe(false);
    expect(nodes["manual-paso1-gate"].textContent).toBe("Ya puedes seguir al paso 2.");
  });
});

describe("step 26 §13 · dinámico — volver a un preajuste limpia el <select> de «Otra duración…»", () => {
  it("elegir un preajuste tras haber resuelto «Otra duración…» oculta y vacía el <select>, y actualiza el aviso", () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-0"]);
    marcar(nodes["manual-duracion-otra"]);
    nodes["manual-duracion-otra-valor"].value = "225";
    nodes["manual-duracion-otra-valor"].dispatchChange();

    marcar(nodes["manual-duracion-90"]);

    expect(nodes["manual-duracion-otra-campo"].hidden).toBe(true);
    expect(nodes["manual-duracion-otra-valor"].value).toBe("");
    // 90 sigue sin ser la habitual: el aviso de duración especial se queda.
    expect(nodes["manual-duracion-aviso"].hidden).toBe(false);
    const estado = hooks.manualStateActual() as EstadoManualConDuracion;
    expect(estado.duracion).toBe(90);
    expect(estado.duracionEspecial).toBe(true);
  });

  it("re-marcar «Otra duración…» después de un preajuste vuelve a cerrar la puerta hasta elegir minutos", () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-2"]);
    marcar(nodes["manual-duracion-60"]);
    expect(nodes["manual-siguiente-1"].disabled).toBe(false);

    marcar(nodes["manual-duracion-otra"]);

    expect(nodes["manual-siguiente-1"].disabled).toBe(true);
    expect(nodes["manual-paso1-gate"].textContent).toBe("Falta elegir cuántos minutos dura la cita especial.");
    const estado = hooks.manualStateActual() as EstadoManualConDuracion;
    expect(estado.duracion).toBeNull();
  });
});

describe("step 26 §13 · dinámico — cambiar de servicio reinicia la duración a la habitual, sin arrastrar nada", () => {
  it("una duración especial elegida antes NO sobrevive a un cambio de servicio", () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-0"]);
    marcar(nodes["manual-duracion-120"]);
    expect((hooks.manualStateActual() as EstadoManualConDuracion).duracion).toBe(120);

    marcar(nodes["manual-servicio-1"]);

    const estado = hooks.manualStateActual() as EstadoManualConDuracion;
    expect(estado.duracion).toBe(30);
    expect(estado.duracionEspecial).toBe(false);
    expect(nodes["manual-duracion-30"].checked).toBe(true);
    expect(nodes["manual-duracion-120"].checked).toBe(false);
    expect(nodes["manual-duracion-aviso"].hidden).toBe(true);
  });

  it("servicio A → servicio B → servicio A no deja ningún resto de «Otra duración…» (sin estado rancio)", () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-0"]); // A
    marcar(nodes["manual-duracion-otra"]);
    nodes["manual-duracion-otra-valor"].value = "225";
    nodes["manual-duracion-otra-valor"].dispatchChange();

    marcar(nodes["manual-servicio-1"]); // B
    expect((hooks.manualStateActual() as EstadoManualConDuracion).duracion).toBe(30);

    marcar(nodes["manual-servicio-0"]); // A, otra vez

    const estado = hooks.manualStateActual() as EstadoManualConDuracion;
    expect(estado.duracion).toBe(30);
    expect(estado.duracionEspecial).toBe(false);
    expect(nodes["manual-duracion-otra"].checked).toBe(false);
    expect(nodes["manual-duracion-otra-campo"].hidden).toBe(true);
    expect(nodes["manual-duracion-otra-valor"].value).toBe("");
    expect(nodes["manual-duracion-aviso"].hidden).toBe(true);
    expect(nodes["manual-siguiente-1"].disabled).toBe(false);
  });
});

describe("step 26 §13 · dinámico — cambiar la duración invalida en cascada el hueco ya elegido", () => {
  it("un hueco elegido en el paso 3 se olvida (huecos, elegido, propuesta y la lista pintada) al tocar cualquier control de Duración", () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-0"]);

    // Simula que el paso 3 ya había resuelto un hueco, sin pasar por el
    // explorador real: esta pieza sólo firma la invalidación, no la búsqueda.
    const estado = hooks.manualStateActual() as EstadoManualConDuracion;
    Object.assign(estado, {
      huecos: [{ dateISO: "2026-08-13", startLabel: "09:00", timeRangeLabel: "09:00–09:30", professionalLabel: "Álex (sintético)" }],
      elegido: 0,
      propuesta: { durationLabel: "30 min" },
    });
    const nodoHuecoPintado = nodes["manual-huecos"].ownerDocument!.createElement("span");
    nodes["manual-huecos"].appendChild(nodoHuecoPintado);
    expect(nodes["manual-huecos"].children.length).toBe(1);

    marcar(nodes["manual-duracion-90"]);

    expect(estado.huecos).toEqual([]);
    expect(estado.elegido).toBeNull();
    expect(estado.propuesta).toBeNull();
    expect(nodes["manual-huecos"].children.length).toBe(0);
  });

  it("elegir el número de minutos de «Otra duración…» también olvida el hueco elegido", () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-0"]);
    const estado = hooks.manualStateActual() as EstadoManualConDuracion;
    Object.assign(estado, { huecos: [{ dateISO: "2026-08-13", startLabel: "09:00" }], elegido: 0, propuesta: {} });

    marcar(nodes["manual-duracion-otra"]);
    nodes["manual-duracion-otra-valor"].value = "195";
    nodes["manual-duracion-otra-valor"].dispatchChange();

    expect(estado.huecos).toEqual([]);
    expect(estado.elegido).toBeNull();
    expect(estado.propuesta).toBeNull();
  });
});

describe("step 26 §13 · dinámico — preview y confirmación mandan durationMinutes desde manualState", () => {
  it("las dos peticiones llevan el mismo durationMinutes que el operador eligió, y la confirmación lo manda aunque la propuesta del servidor ya no lo lleve en `confirm`", async () => {
    const { nodes, hooks } = montarDialogo();
    hooks.abrirDialogoCitaManual(null);
    marcar(nodes["manual-servicio-1"]);
    marcar(nodes["manual-duracion-90"]);
    marcar(nodes["manual-quien-cualquiera"]);
    marcar(nodes["manual-persona-a"]);
    const estado = hooks.manualStateActual() as EstadoManualConDuracion;
    Object.assign(estado, { huecos: [{ dateISO: "2026-08-13", startLabel: "09:00" }], elegido: 0 });

    const cuerpos: { url: string; body: Record<string, unknown> }[] = [];
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = ((url: unknown, opts?: { body?: string }) => {
      const u = String(url);
      if (opts && typeof opts.body === "string") cuerpos.push({ url: u, body: JSON.parse(opts.body) as Record<string, unknown> });
      if (u.startsWith("/api/booking/manual/preview")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () =>
            Promise.resolve({
              proposal: {
                clientLabel: "Cliente A",
                serviceLabel: "Corte de pelo",
                durationLabel: "1 h 30 min",
                dateLabel: "jueves 13 de agosto",
                whenLabel: "09:00–10:30",
                professionalLabel: "Álex (sintético)",
                professionalNote: "Con «cualquier profesional», a esta hora le toca Álex (sintético).",
                originLabel: "Creada manualmente por el operador",
                syntheticNotice: "Entorno sintético.",
                confirmLabel: "Confirmar y crear la cita sintética",
                // step 26 — reparación adversarial: `confirm` YA lleva
                // `durationMinutes`, pero el cliente sigue mandando el suyo
                // propio (manualState) y no debe leer este campo.
                confirm: { clientLabel: "Cliente A", serviceId: 1, date: "2026-08-13", startMinutes: 540, employeeId: 3, durationMinutes: 90 },
                keyToMint: "manual:2026-08-13:540d90-3-1:A:r0",
              },
            }),
        });
      }
      if (u === "/api/booking/manual") {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve({ created: true, booking: { successLabel: "Cita sintética creada." } }),
        });
      }
      // /api/snapshot: lo llama refresh() tras confirmar. Esta pieza no firma
      // el repintado completo (ver cabecera del bloque).
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ engineToday: "2026-08-13", engineNowMinutes: 540, calendar: {} }),
      });
    }) as typeof fetch;

    try {
      nodes["manual-siguiente-4"].dispatchClick();
      await flush();
      expect(nodes["manual-paso-5"].hidden).toBe(false);

      nodes["manual-confirmar"].dispatchClick();
      await flush();
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    const preview = cuerpos.find((c) => c.url.startsWith("/api/booking/manual/preview"));
    const confirmar = cuerpos.find((c) => c.url === "/api/booking/manual");
    expect(preview, "no se ha mandado la vista previa").toBeDefined();
    expect(confirmar, "no se ha mandado la confirmación").toBeDefined();
    expect(preview!.body.durationMinutes).toBe(90);
    expect(confirmar!.body.durationMinutes).toBe(90);
    // La confirmación manda su PROPIO campo, no un objeto `confirm` anidado
    // leído de la propuesta (que ahora sí trae `durationMinutes`, pero por
    // otra razón: la reparación adversarial del dominio, no el cliente).
    expect(confirmar!.body).not.toHaveProperty("confirm");
  });
});
