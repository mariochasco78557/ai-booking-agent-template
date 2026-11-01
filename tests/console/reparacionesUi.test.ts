import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds, type FakeElement } from "./fakeDom.js";

/**
 * step 19 · fase de reparaciones D1-D2 — evidencia ESTRUCTURAL (sin
 * navegador) de las dos reparaciones de CSS/DOM del §2 del diseño. Lo que
 * NO se firma aquí (los 690px reales, el desbordamiento medido en píxeles,
 * cómo pronuncia un lector de pantalla la ficha de persona) es del runbook
 * del Mac (§10.3 del diseño) y no se afirma probado en ningún sitio de este
 * fichero.
 */

const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");

// =====================================================================
// D1 — .tx-event-counts ya no desborda a 690px
// =====================================================================

describe("step 19 · D1 — el suelo de min-content del recuento de eventos, corregido en el elemento de rejilla real", () => {
  it("existe '.tx-event-counts dl > div { min-width: 0; }' con el SELECTOR ENTERO — no basta min-width:0 suelto cerca de .tx-event-counts", () => {
    // (Enmienda B4.) La primera redacción de este defecto ponía min-width:0
    // en el dt/dd, que no son elementos de rejilla: esa regla habría sido
    // inerte. Se compara el selector completo, no sólo la propiedad, para
    // que una regresión a la redacción equivocada haga fallar esta prueba.
    expect(css).toContain(".tx-event-counts dl > div { min-width: 0; }");
  });

  it("'.tx-event-counts dt' lleva overflow-wrap: anywhere, y ya NO lleva ninguna regla de min-width: 0 (aserción negativa)", () => {
    const idx = css.indexOf(".tx-event-counts dt {");
    expect(idx).toBeGreaterThan(-1);
    const regla = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(regla).toContain("overflow-wrap: anywhere");
    // Aserción negativa (§2.1.3): ni .tx-event-counts dt ni .tx-event-counts dd
    // llevan min-width: 0 — si alguien la reintroduce ahí, es el diagnóstico
    // equivocado (B4) volviendo.
    expect(css).not.toMatch(/\.tx-event-counts\s+d[td]\s*\{[^}]*min-width:\s*0/);
  });

  it("el punto de ruptura de una columna vive DENTRO del bloque @media (max-width: 720px), no fuera", () => {
    const inicio720 = css.indexOf("@media (max-width: 720px)");
    expect(inicio720).toBeGreaterThan(-1);
    const fin720 = css.indexOf("\n}", inicio720);
    const bloque720 = css.slice(inicio720, fin720);
    expect(bloque720).toContain(".tx-event-counts { grid-template-columns: 1fr;");
    // Y la regla de base (dos columnas) sigue existiendo FUERA de ese bloque,
    // para los cuatro anchos mayores (§2.1.3, filas 1440/1280/1024/768).
    const antesDelMedia = css.slice(0, inicio720);
    expect(antesDelMedia).toContain(".tx-event-counts { display: grid; grid-template-columns: 1fr 1fr;");
  });

  it("no aparece ninguna otra regla de una sola columna de .tx-event-counts fuera del bloque de 720px", () => {
    const primeraAparicionMedia = css.indexOf("@media (max-width: 720px)");
    const fueraDelMedia720 = css.slice(0, primeraAparicionMedia) + css.slice(css.indexOf("\n}", primeraAparicionMedia));
    expect(fueraDelMedia720).not.toMatch(/\.tx-event-counts\s*\{[^}]*grid-template-columns:\s*1fr;/);
  });
});

// =====================================================================
// D2 — cada persona del grupo es un <fieldset>/<legend>, no un <div>
// =====================================================================

const GRUPO_IDS = [
  { id: "dialogo-grupo", tag: "dialog" },
  { id: "dialogo-grupo-titulo", tag: "h2" },
  "grupo-estado",
  "grupo-error",
  { id: "grupo-paso-1", tag: "div" },
  "grupo-paso-1-titulo",
  { id: "grupo-personas", tag: "div" },
  "grupo-anadir",
  "grupo-paso1-gate",
  "grupo-cancelar-1",
  "grupo-siguiente-1",
  { id: "grupo-paso-2", tag: "div" },
  "grupo-paso-2-titulo",
  { id: "grupo-forma-consecutivas", tag: "input" },
  { id: "grupo-forma-simultaneas", tag: "input" },
  "grupo-forma-aviso",
  { id: "grupo-fecha", tag: "input" },
  "grupo-paso2-gate",
  "grupo-atras-2",
  "grupo-cancelar-2",
  "grupo-siguiente-2",
  { id: "grupo-paso-3", tag: "div" },
  "grupo-paso-3-titulo",
  "grupo-buscar",
  { id: "grupo-propuestas", tag: "div" },
  "grupo-paso3-gate",
  "grupo-atras-3",
  "grupo-cancelar-3",
  "grupo-siguiente-3",
  { id: "grupo-paso-4", tag: "div" },
  "grupo-paso-4-titulo",
  { id: "grupo-resumen-tbody", tag: "tbody" },
  "grupo-resumen-cuantas",
  "grupo-atras-4",
  "grupo-cancelar-4",
  "grupo-confirmar",
  "grupo-cerrar",
  { id: "tx-view-title", tag: "h1" },
] as const;

function montarDialogoDeGrupo(): { nodes: Record<string, FakeElement>; hooks: ReturnType<typeof loadUiClientHooks> } {
  const { document, nodes } = createFakeDocumentWithIds([...GRUPO_IDS]);
  const hooks = loadUiClientHooks("", document);
  hooks.wireGrupoDialog();
  return { nodes, hooks };
}

describe("step 19 · D2 — renderGrupoPersonas produce una ficha <fieldset>/<legend> por persona", () => {
  it("cada persona es un <fieldset class=\"tx-group-row\"> con un <legend>Persona N", () => {
    const { nodes, hooks } = montarDialogoDeGrupo();
    hooks.abrirDialogoGrupo(nodes["tx-view-title"], null);
    const filas = nodes["grupo-personas"].children;
    expect(filas.length).toBe(2);
    filas.forEach((fila, i) => {
      expect(fila.tagName).toBe("FIELDSET");
      expect(fila.className).toContain("tx-group-row");
      expect(fila.children[0].tagName).toBe("LEGEND");
      expect(fila.children[0].className).toContain("tx-group-row__legend");
      expect(fila.children[0].textContent).toBe(`Persona ${String(i + 1)}`);
    });
  });

  it("los tres campos cuelgan de un <div class=\"tx-group-row__fields\">, no directamente del <fieldset>", () => {
    const { nodes, hooks } = montarDialogoDeGrupo();
    hooks.abrirDialogoGrupo(nodes["tx-view-title"], null);
    const fila = nodes["grupo-personas"].children[0];
    const campos = fila.children[1];
    expect(campos.tagName).toBe("DIV");
    expect(campos.className).toBe("tx-group-row__fields");
    expect(campos.children.length).toBe(3);
    for (const campo of campos.children) expect(campo.className).toBe("tx-field");
  });

  it("el orden del DOM no cambia: Etiqueta → Servicio → Profesional, y el <legend> no es enfocable ni lleva onchange/onclick", () => {
    const { nodes, hooks } = montarDialogoDeGrupo();
    hooks.abrirDialogoGrupo(nodes["tx-view-title"], null);
    const campos = nodes["grupo-personas"].children[0].children[1];
    const ids = campos.children.map((campo) => campo.children[1].getAttribute("id"));
    expect(ids).toEqual(["grupo-etiqueta-1", "grupo-servicio-1", "grupo-profesional-1"]);
    const legend = nodes["grupo-personas"].children[0].children[0];
    expect(legend.onclick).toBeNull();
  });

  it("el rótulo visible es el texto CORTO, y el aria-label del <select> conserva, palabra por palabra, el nombre accesible largo de siempre (M1)", () => {
    const { nodes, hooks } = montarDialogoDeGrupo();
    hooks.abrirDialogoGrupo(nodes["tx-view-title"], null);
    const campos = nodes["grupo-personas"].children[1].children[1]; // persona 2
    const esperado: Array<[string, string, string]> = [
      ["Etiqueta", "Etiqueta de la persona 2", "grupo-etiqueta-2"],
      ["Servicio", "Servicio de la persona 2", "grupo-servicio-2"],
      ["Profesional", "Profesional de la persona 2", "grupo-profesional-2"],
    ];
    esperado.forEach(([corto, largo, id], i) => {
      const campo = campos.children[i];
      expect(campo.children[0].tagName).toBe("LABEL");
      expect(campo.children[0].textContent).toBe(corto);
      expect(campo.children[0].getAttribute("for")).toBe(id);
      const select = campo.children[1];
      expect(select.getAttribute("id")).toBe(id);
      expect(select.getAttribute("aria-label")).toBe(largo);
      // Contrapartida declarada del diseño: el aria-label CONTIENE el texto
      // visible del <label> como prefijo.
      expect((select.getAttribute("aria-label") as string).startsWith(corto)).toBe(true);
    });
  });

  it("con tres o más personas, las acciones ('Quitar esta persona') cuelgan de un <div class=\"tx-group-row__actions\"> aparte, DESPUÉS de los campos", () => {
    const { nodes, hooks } = montarDialogoDeGrupo();
    hooks.abrirDialogoGrupo(nodes["tx-view-title"], {
      filas: [
        { etiqueta: "Persona 1", servicio: "1", profesional: "" },
        { etiqueta: "Persona 2", servicio: "1", profesional: "" },
        { etiqueta: "Persona 3", servicio: "1", profesional: "" },
      ],
    });
    const fila = nodes["grupo-personas"].children[0];
    expect(fila.children.length).toBe(3);
    const acciones = fila.children[2];
    expect(acciones.className).toBe("tx-group-row__actions");
    expect(acciones.children[0].textContent).toBe("Quitar esta persona");
  });

  it("con dos personas, ninguna ficha lleva el envoltorio de acciones (sigue sin ofrecerse 'quitar' por debajo del mínimo)", () => {
    const { nodes, hooks } = montarDialogoDeGrupo();
    hooks.abrirDialogoGrupo(nodes["tx-view-title"], null);
    for (const fila of nodes["grupo-personas"].children) {
      expect(fila.children.length).toBe(2);
      expect(fila.children.map((c) => c.tagName)).toEqual(["LEGEND", "DIV"]);
    }
  });
});

describe("step 19 · D2 — CSS: el <fieldset> no es el contenedor de disposición, y el <dialog> se desplaza por dentro", () => {
  it(".tx-group-row (fuera de cualquier @media) no declara display: flex ni display: grid — sólo semántica, borde y relleno", () => {
    const idx = css.indexOf(".tx-group-row {");
    expect(idx).toBeGreaterThan(-1);
    const regla = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(regla).not.toMatch(/display:\s*(flex|grid)/);
    expect(regla).toContain("border: 0");
  });

  it(".tx-group-row__fields es quien lleva flex por defecto, y pasa a rejilla de DOS columnas por debajo de 720px", () => {
    const idxBase = css.indexOf(".tx-group-row__fields {");
    expect(idxBase).toBeGreaterThan(-1);
    const reglaBase = css.slice(idxBase, css.indexOf("}", idxBase) + 1);
    expect(reglaBase).toContain("display: flex");

    const inicio720 = css.indexOf("@media (max-width: 720px)");
    const fin720 = css.indexOf("\n}", inicio720);
    const bloque720 = css.slice(inicio720, fin720);
    expect(bloque720).toMatch(/\.tx-group-row__fields\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  });

  it("por debajo de 720px cada ficha gana borde propio y separación entre personas (ninguna se confunde con la siguiente)", () => {
    const inicio720 = css.indexOf("@media (max-width: 720px)");
    const fin720 = css.indexOf("\n}", inicio720);
    const bloque720 = css.slice(inicio720, fin720);
    expect(bloque720).toMatch(/\.tx-group-row\s*\{[^}]*border:\s*var\(--tx-border-hairline\)[^}]*margin-bottom:\s*var\(--tx-space-3\)[^}]*\}/);
  });

  it(".tx-dialog tiene desplazamiento interno propio (overflow-y: auto) con un tope de alto atado al viewport", () => {
    const idx = css.indexOf(".tx-dialog {");
    const regla = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(regla).toContain("overflow-y: auto");
    expect(regla).toMatch(/max-height:\s*calc\(100vh/);
    // Y sigue sin poder desbordar a lo ancho (regla heredada, no se afloja).
    expect(regla).toContain("width: calc(100vw");
  });
});
