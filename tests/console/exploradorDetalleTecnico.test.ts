import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadUiClientHooks, type UiTestHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, type FakeDocument, type FakeElement } from "./fakeDom.js";

/**
 * step 19R1 · reparación M19-MAC-D1 — `buildHuecoResultCard()` reconciliaba
 * las cinco líneas del detalle técnico DENTRO del `<summary>` plegado
 * (`card.children[4].children[0]`) en vez de dentro de
 * `div.tx-details__body` (`children[1]`): el nombre accesible del summary
 * cerrado pasaba a ser el payload entero, el cuerpo quedaba siempre vacío, y
 * las cinco líneas —al ser hijas flex del summary— quedaban fuera del
 * alcance de `.tx-details__body p { overflow-wrap: anywhere }`, así que
 * desbordaban a 729px en un viewport de 690px.
 *
 * Misma técnica que el resto de la consola: JavaScript REAL de `/app.js`
 * (`uiClientExtract.ts`), DOM falso mínimo (`fakeDom.ts`). Mirroring del
 * montaje de `tests/console/exploradorUi.test.ts`, pero en aislamiento
 * total: aquí no hace falta servidor ni HTML servido porque
 * `buildHuecoResultCard` sólo lee el objeto `slot` que se le pasa.
 */

const ETIQUETA_DETALLE = "Detalle técnico";

type SlotTechnicalLike = {
  employeeIdLabel: string;
  serviceIdLabel: string;
  appliedLevelLabel: string;
  anyProfessionalLabel: string | null;
  anyProfessionalExplainerLabel: string | null;
};

type SlotLike = {
  dateLabel: string;
  timeRangeLabel: string;
  serviceLabel: string;
  professionalLabel: string;
  whyLabel: string;
  anyProfessionalNote: string | null;
  technical: SlotTechnicalLike;
};

/** Un hueco con "Cualquiera del equipo" — las cinco líneas técnicas presentes. */
function slotCanonico(): SlotLike {
  return {
    dateLabel: "martes 4 de agosto",
    timeRangeLabel: "10:00–10:30",
    serviceLabel: "Corte",
    professionalLabel: "Alex (sintético)",
    whyLabel: "El primer hueco libre de Alex ese día, por orden de agenda.",
    anyProfessionalNote: "Elegido entre quien tuviera hueco antes, no una recomendación.",
    technical: {
      employeeIdLabel: "Identificador interno de la persona del equipo: 3",
      serviceIdLabel: "Servicio (identificador interno): 1",
      appliedLevelLabel: "Nivel de horario que decide ese día: weekday",
      anyProfessionalLabel:
        "Candidatos con “Cualquiera”: 3, 5 · huecos que le quedan hoy a cada uno: 4, 2 · citas confirmadas hoy: 1, 0",
      anyProfessionalExplainerLabel:
        "Desempate estable por identificador interno de cada persona del equipo, no una recomendación.",
    },
  };
}

/** Un hueco con "Una persona concreta" — sin las dos líneas de "Cualquiera" (huecosDetalleTecnico, ui.js.ts:2071-2076). */
function slotUnaPersona(): SlotLike {
  const base = slotCanonico();
  return {
    ...base,
    anyProfessionalNote: null,
    technical: {
      employeeIdLabel: base.technical.employeeIdLabel,
      serviceIdLabel: base.technical.serviceIdLabel,
      appliedLevelLabel: base.technical.appliedLevelLabel,
      anyProfessionalLabel: null,
      anyProfessionalExplainerLabel: null,
    },
  };
}

function lineasEsperadas(slot: SlotLike): string[] {
  const lineas = [slot.technical.employeeIdLabel, slot.technical.serviceIdLabel, slot.technical.appliedLevelLabel];
  if (slot.technical.anyProfessionalLabel) lineas.push(slot.technical.anyProfessionalLabel);
  if (slot.technical.anyProfessionalExplainerLabel) lineas.push(slot.technical.anyProfessionalExplainerLabel);
  return lineas;
}

function montar(): { document: FakeDocument; hooks: UiTestHooks } {
  const { document } = createFakeDocumentWithIds([]);
  const hooks = loadUiClientHooks("", document);
  return { document, hooks };
}

/** Los nodos que importan de una tarjeta ya construida: el <details> y sus dos hijos. */
function piezasDeDetalle(card: FakeElement): { det: FakeElement; summary: FakeElement; body: FakeElement } {
  const det = card.children[4]!;
  const summary = det.children[0]!;
  const body = det.children[1]!;
  return { det, summary, body };
}

describe("step 19R1 · buildHuecoResultCard() — las cinco líneas técnicas viven en el cuerpo, no en el summary", () => {
  it("construcción inicial: el summary no tiene ningún <p> y su texto es exactamente la etiqueta del disclosure", () => {
    const { hooks } = montar();
    const slot = slotCanonico();
    const card = hooks.buildHuecoResultCard(slot, null) as FakeElement;

    const { summary } = piezasDeDetalle(card);
    expect(summary.children.length).toBe(0);
    expect(summary.textContent).toBe(ETIQUETA_DETALLE);
  });

  it("construcción inicial: div.tx-details__body es dueño de las cinco líneas, en orden canónico", () => {
    const { hooks } = montar();
    const slot = slotCanonico();
    const card = hooks.buildHuecoResultCard(slot, null) as FakeElement;

    const { body } = piezasDeDetalle(card);
    expect(body.className).toContain("tx-details__body");
    expect(body.children.length).toBe(5);
    expect(body.children.map((p) => p.textContent)).toEqual(lineasEsperadas(slot));
  });

  it("reconciliación sobre una tarjeta existente: mismos invariantes, y el primer <p> es EL MISMO objeto (no se reconstruye)", () => {
    const { hooks } = montar();
    const slot = slotCanonico();
    const primera = hooks.buildHuecoResultCard(slot, null) as FakeElement;
    const primerP = piezasDeDetalle(primera).body.children[0];

    const segunda = hooks.buildHuecoResultCard(slot, primera) as FakeElement;
    expect(segunda).toBe(primera); // reconciliar reutiliza la tarjeta, no crea otra

    const { summary, body } = piezasDeDetalle(segunda);
    expect(summary.children.length).toBe(0);
    expect(summary.textContent).toBe(ETIQUETA_DETALLE);
    expect(body.children.length).toBe(5); // sin duplicados
    expect(body.children[0]).toBe(primerP); // identidad de nodo, no reconstrucción
    expect(body.children.map((p) => p.textContent)).toEqual(lineasEsperadas(slot));
  });

  it("un sondeo repetido (3 llamadas idénticas) mantiene el recuento en 5, el orden estable y el summary limpio", () => {
    const { hooks } = montar();
    const slot = slotCanonico();
    let card = hooks.buildHuecoResultCard(slot, null) as FakeElement;
    const { body: bodyInicial } = piezasDeDetalle(card);
    const nodosOriginales = [...bodyInicial.children];

    for (let i = 0; i < 3; i += 1) {
      card = hooks.buildHuecoResultCard(slot, card) as FakeElement;
    }

    const { summary, body } = piezasDeDetalle(card);
    expect(body.children.length).toBe(5);
    // Identidad de nodo, no `toEqual`: comparar por igualdad estructural
    // recorrería `parentNode`, que es circular.
    body.children.forEach((p, i) => expect(p).toBe(nodosOriginales[i]));
    expect(body.children.map((p) => p.textContent)).toEqual(lineasEsperadas(slot));
    expect(summary.children.length).toBe(0);
    expect(summary.textContent).toBe(ETIQUETA_DETALLE);
  });

  it("payload cambiado: el texto de cada línea se actualiza en su sitio, sigue habiendo 5 y el summary sigue limpio", () => {
    const { hooks } = montar();
    const slotA = slotCanonico();
    let card = hooks.buildHuecoResultCard(slotA, null) as FakeElement;

    const slotB = slotCanonico();
    slotB.technical.employeeIdLabel = "Identificador interno de la persona del equipo: 7";
    slotB.technical.appliedLevelLabel = "Nivel de horario que decide ese día: seasonal";
    card = hooks.buildHuecoResultCard(slotB, card) as FakeElement;

    const { summary, body } = piezasDeDetalle(card);
    expect(body.children.length).toBe(5);
    expect(body.children.map((p) => p.textContent)).toEqual(lineasEsperadas(slotB));
    expect(summary.children.length).toBe(0);
    expect(summary.textContent).toBe(ETIQUETA_DETALLE);
  });

  it("payload que encoge de 5 a 3 líneas ('Una persona concreta'): el cuerpo se queda con exactamente 3, sin huérfanos, summary limpio", () => {
    const { hooks } = montar();
    const cinco = slotCanonico();
    let card = hooks.buildHuecoResultCard(cinco, null) as FakeElement;
    expect(piezasDeDetalle(card).body.children.length).toBe(5);

    const tres = slotUnaPersona();
    card = hooks.buildHuecoResultCard(tres, card) as FakeElement;

    const { det, summary, body } = piezasDeDetalle(card);
    expect(body.children.length).toBe(3);
    expect(body.children.map((p) => p.textContent)).toEqual(lineasEsperadas(tres));
    expect(summary.children.length).toBe(0);
    expect(summary.textContent).toBe(ETIQUETA_DETALLE);
    // Nada huérfano: el <details> sólo tiene sus dos hijos de siempre.
    expect(det.children.length).toBe(2);
  });

  it("guarda de foco: enfocar una línea del cuerpo y repetir la reconciliación con el mismo payload no mueve el foco ni desconecta el nodo", () => {
    // Esto NO es una prueba directa del defecto M19-MAC-D1 (para eso están las
    // de arriba, que fijan la topología summary/body): es un candado contra
    // una reparación alternativa por reconstrucción (limpiar y volver a crear
    // los <p>), que rompería el foco igual que el bug original rompía la
    // topología. Nota de divergencia con un navegador real: el setter de
    // `textContent` de fakeDom BORRA los hijos y su getter IGNORA el texto
    // propio si hay hijos (fakeDom.ts:155-163) — así que, con el bug viejo,
    // reescribir el summary con `setText` habría hecho DESAPARECER la
    // etiqueta "Detalle técnico" aquí, mientras que en Chrome de verdad el
    // texto conviviría con las líneas inyectadas (el summary tendría nodos de
    // texto Y elementos). La aserción de abajo discrimina el bug en
    // cualquiera de los dos mundos, pero no describe el DOM real.
    const { document, hooks } = montar();
    const slot = slotCanonico();
    let card = hooks.buildHuecoResultCard(slot, null) as FakeElement;
    const { body } = piezasDeDetalle(card);
    const nodoEnfocado = body.children[2]!;
    nodoEnfocado.focus();
    expect(document.activeElement).toBe(nodoEnfocado);

    card = hooks.buildHuecoResultCard(slot, card) as FakeElement;

    expect(document.activeElement).toBe(nodoEnfocado);
    expect(body.contains(document.activeElement)).toBe(true);
  });
});

describe("step 19R1 · CSS — dos reglas con candado: la anchura del <details> y el partido de línea del cuerpo", () => {
  it("contrato de texto (no evidencia de renderizado, NUNCA prueba de renderizador real): la hoja de estilos contiene, cada una ACTIVA exactamente una vez —no dentro de un comentario—, la regla 'align-self: stretch' de .tx-slot-card .tx-details y la regla 'overflow-wrap: anywhere' de .tx-details__body p", () => {
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    const reglaAlignSelf = ".tx-slot-card .tx-details { align-self: stretch; }";
    const reglaOverflowWrap = ".tx-details__body p { overflow-wrap: anywhere; }";

    // Byte-exacto: la regla completa existe en algún sitio del fichero.
    // Esto SOLO no basta — un `toContain` byte-exacto pasa igual si la
    // regla vive comentada (p. ej. `/* DESACTIVADA: <regla> */`), porque el
    // texto sigue estando ahí dentro, sólo que inerte. Las aserciones de
    // abajo son las que de verdad comprueban que la regla está VIVA.
    expect(css).toContain(reglaAlignSelf);
    expect(css).toContain(reglaOverflowWrap);

    const lineas = css.split("\n");

    // Buscar por el SELECTOR (no la regla completa) para poder localizar la
    // línea aunque una mutación la hubiera comentado con texto delante
    // (".tx-details__body pre" comparte el mismo prefijo que
    // ".tx-details__body p", por eso se busca con la llave " {" pegada).
    const selectorAlignSelf = ".tx-slot-card .tx-details";
    const lineasAlignSelf = lineas.filter((l) => l.includes(selectorAlignSelf));
    expect(lineasAlignSelf.length).toBe(1); // ninguna duplicada, ninguna huérfana
    expect(lineasAlignSelf[0]!.trim().startsWith(selectorAlignSelf)).toBe(true); // una mutación comentada empezaría por "/*", no por el selector

    const selectorOverflowWrap = ".tx-details__body p {";
    const lineasOverflowWrap = lineas.filter((l) => l.includes(selectorOverflowWrap));
    expect(lineasOverflowWrap.length).toBe(1); // ninguna duplicada, ninguna huérfana
    expect(lineasOverflowWrap[0]!.trim().startsWith(selectorOverflowWrap)).toBe(true); // una mutación comentada empezaría por "/*", no por el selector
  });
});
