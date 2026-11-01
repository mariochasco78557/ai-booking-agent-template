import { describe, it, expect } from "vitest";

import { loadUiClientHooks } from "./uiClientExtract.js";
import { createFakeDocumentWithIds } from "./fakeDom.js";

/**
 * step 22 · fase 6 — dos costuras del sondeo que la revisión adversarial de
 * la fase 5 dejó señaladas (N4 y N5).
 *
 * Misma técnica que el resto de pruebas de pantalla: se ejecuta el
 * JavaScript REAL que sirve `GET /app.js` contra el DOM falso de
 * `fakeDom.ts`. Nada de aquí necesita servidor: lo que se comprueba es qué
 * hace el cliente cuando algo se rompe DENTRO de él.
 */

/** Los ids que `refresh()` toca a través de `renderFreshness`. */
const IDS_FRESCURA = ["tx-freshness", "tx-conexion-anuncio"] as const;

/** Sustituye `globalThis.fetch` mientras corre `fn`, y lo devuelve como estaba. */
async function conFetch<T>(f: unknown, fn: () => Promise<T> | T): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = f as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("step 22 · N4 — un fallo al pintar no se disfraza de fallo de conexión", () => {
  it("el error de pintado se cuenta como error de pintado, y la píldora no habla de una red que no ha fallado", async () => {
    const { document, nodes } = createFakeDocumentWithIds([...IDS_FRESCURA]);
    const hooks = loadUiClientHooks("", document);

    // El transporte va PERFECTAMENTE: la petición responde y se lee como
    // JSON. Lo que revienta es el pintado — aquí, el primer `byId()` de
    // cualquier pintor, que hace las veces de cualquier excepción dentro de
    // esa fase. Es exactamente el caso que el `.catch()` colocado detrás del
    // `.then()` de pintar confundía con una caída de red.
    const fetchQueResponde = () => Promise.resolve({ json: () => Promise.resolve({ engineToday: "2026-08-04" }) });
    // La píldora de frescura se pinta bien (sus dos nodos existen); revienta
    // el pintor SIGUIENTE. Así el fallo es de pintado y sólo de pintado: si
    // se rompiera también la píldora, el `.catch` viejo volvería a fallar
    // dentro de sí mismo y la prueba no distinguiría una reparación de la
    // avería.
    const buscarDeVerdad = document.getElementById.bind(document);
    document.getElementById = (id: string) => {
      if ((IDS_FRESCURA as readonly string[]).includes(id)) return buscarDeVerdad(id);
      throw new Error("fallo sintético al pintar");
    };

    const registrados: unknown[][] = [];
    const consolaOriginal = globalThis.console.error;
    globalThis.console.error = (...args: unknown[]) => {
      registrados.push(args);
    };
    try {
      await conFetch(fetchQueResponde, async () => {
        // El sondeo no se rompe: lo llama un `setInterval` y tiene que poder
        // volver a intentarlo en el turno siguiente.
        await expect(hooks.refresh()).resolves.toBeUndefined();
      });
    } finally {
      globalThis.console.error = consolaOriginal;
    }

    // El fallo se cuenta, y se cuenta como lo que es.
    expect(registrados.length).toBe(1);
    expect(String(registrados[0]?.[0])).toContain("pintar");
    expect(String(registrados[0]?.[0])).toContain("fallo sintético al pintar");

    // Y la píldora no ha dicho "sin conexión": no la hubo.
    expect(nodes["tx-freshness"]!.textContent).not.toContain("Sin conexión");
    expect(nodes["tx-conexion-anuncio"]!.textContent).not.toContain("Sin conexión");
  });

  it("y una caída de transporte de verdad la sigue anunciando, sin propagar nada", async () => {
    const { document, nodes } = createFakeDocumentWithIds([...IDS_FRESCURA]);
    const hooks = loadUiClientHooks("", document);

    const fetchCaido = () => Promise.reject(new Error("network down"));
    await conFetch(fetchCaido, async () => {
      // No propaga: un sondeo con la red caída es un caso previsto, no un fallo.
      await expect(hooks.refresh()).resolves.toBeUndefined();
    });

    expect(nodes["tx-freshness"]!.textContent).toBe("Sin conexión con el motor");
    expect(nodes["tx-conexion-anuncio"]!.textContent).toContain("Sin conexión con el motor");
  });
});

describe("step 22 · N5 — el desplegable de profesionales tampoco se reconstruye bajo el foco", () => {
  const EQUIPO_A = [
    { employeeId: 3, label: "Álex (sintético)" },
    { employeeId: 6, label: "Dani (sintético)" },
  ];
  const EQUIPO_B = [
    { employeeId: 3, label: "Álex (sintético)" },
    { employeeId: 9, label: "Nerea (sintética)" },
  ];

  it("con el foco puesto en el `<select>`, un sondeo con otra plantilla NO lo reconstruye", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "quien", tag: "select" }]);
    const hooks = loadUiClientHooks("", document);
    const select = nodes["quien"]!;

    hooks.ensureProfessionalOptions(select, EQUIPO_A, "Elige a quién");
    expect(select.options.map((o) => o.value)).toEqual(["", "3", "6"]);
    select.value = "6";

    // Alguien tiene el desplegable abierto, con su elección hecha.
    select.focus();
    expect(document.activeElement).toBe(select);

    hooks.ensureProfessionalOptions(select, EQUIPO_B, "Elige a quién");
    expect(select.options.map((o) => o.value)).toEqual(["", "3", "6"]);
    expect(select.value).toBe("6");
  });

  it("y en cuanto el foco se va, el siguiente sondeo sí lo pone al día", () => {
    const { document, nodes } = createFakeDocumentWithIds([{ id: "quien", tag: "select" }]);
    const hooks = loadUiClientHooks("", document);
    const select = nodes["quien"]!;

    hooks.ensureProfessionalOptions(select, EQUIPO_A, "Elige a quién");
    select.focus();
    hooks.ensureProfessionalOptions(select, EQUIPO_B, "Elige a quién");
    document.activeElement = null;
    hooks.ensureProfessionalOptions(select, EQUIPO_B, "Elige a quién");
    expect(select.options.map((o) => o.value)).toEqual(["", "3", "9"]);
  });
});
