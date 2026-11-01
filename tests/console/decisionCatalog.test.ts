import { describe, it, expect } from "vitest";

import {
  COMPONENTES_CONOCIDAS,
  DECISION_CATALOG,
  componentesNoTriviales,
  validateDecisionCatalog,
  type DecisionCatalog,
  type DecisionEntry,
} from "../../src/console/decisionCatalog.js";
import { buildDecisionWorkshopView, decisionCatalogFingerprint, decisionWorkshopFingerprint } from "../../src/console/demoWorkspace.js";

/**
 * step 20 · B — Dominio y catálogo (diseño §9.1).
 *
 * Cubre: los recuentos exactos; la permutación de `order` y su coherencia
 * con la facilitación; las ocho validaciones V1–V8, cada una con un catálogo
 * MUTANTE que la dispara; las seis componentes fuertemente conexas fijadas
 * con sus miembros exactos (R4-1) y sus tres mutantes; los hechos del grafo
 * (J12, la grafía «K1», las dependencias externas);
 * la congelación en profundidad; el barrido de vocabulario I20-17; y que la
 * huella cambia con el contenido (R4-16).
 */


// ---------------------------------------------------------------------
// Utilidades: catálogos mutantes.
// ---------------------------------------------------------------------

/** Clon profundo mutable del catálogo real, para construir mutantes. */
function clonMutable(): {
  version: string;
  sourceDocument: string;
  blocks: { id: string; number: number | null; label: string; context?: string; facilitationOrder: number | null; facilitationOrdinalLabel: string; facilitationReason: string; estimatedMinutes: number; packLine: number }[];
  entries: {
    entryId: string;
    identifiers: string[];
    order: number;
    blockId: string;
    question: string;
    questionAside?: string;
    currentBehaviour: string;
    notImplementedNote?: string;
    options: { letter: string; text: string }[];
    dependsOn: string[];
    externalDependencies: string[];
    urgency: { kind: string; label: string };
    packLine: number;
  }[];
  totals: Record<string, number>;
} {
  return JSON.parse(JSON.stringify(DECISION_CATALOG)) as ReturnType<typeof clonMutable>;
}

function validar(mutante: unknown, componentes?: readonly (readonly string[])[]): () => void {
  return () => {
    validateDecisionCatalog(mutante as DecisionCatalog, componentes);
  };
}

const ID_RE = /^(J\d+|K\d+|L\d+|J\d+ ?\/ ?K\d+)$/;

const entradaDe = (entryId: string): DecisionEntry => {
  const entrada = DECISION_CATALOG.entries.find((e) => e.entryId === entryId);
  expect(entrada, `no existe la entrada ${entryId}`).toBeDefined();
  return entrada as DecisionEntry;
};

const claveDeConjunto = (miembros: readonly string[]): string => [...miembros].sort((a, b) => a.localeCompare(b, "es")).join(", ");

// =====================================================================
// §9.1.1 y §9.1.2 — recuentos y orden
// =====================================================================

describe("step 20 · catálogo — recuentos y orden determinista", () => {
  it("(1) recuentos exactos: 32 entradas, 33 identificadores, 31 J/K + L1, 32 identificadores J/K, 6 entradas bloqueantes, 7 identificadores bloqueantes", () => {
    const entradas = DECISION_CATALOG.entries;
    expect(entradas.length).toBe(32);
    const ids = entradas.flatMap((e) => e.identifiers);
    expect(ids.length).toBe(33);
    expect(new Set(ids).size).toBe(33);
    expect(ids.filter((id) => !id.startsWith("L")).length).toBe(32);
    expect(entradas.filter((e) => e.identifiers.every((id) => !id.startsWith("L"))).length).toBe(31);
    expect(ids.filter((id) => id.startsWith("L"))).toEqual(["L1"]);
    const bloqueantes = entradas.filter((e) => e.urgency.kind === "bloquea");
    expect(bloqueantes.length).toBe(6);
    expect(bloqueantes.flatMap((e) => e.identifiers).length).toBe(7);
    // I20-2: las dos cifras, publicadas por separado y con nombres distintos.
    expect(DECISION_CATALOG.totals).toEqual({
      entries: 32,
      jkEntries: 31,
      jkIdentifiers: 32,
      lIdentifiers: 1,
      blockingEntries: 6,
      blockingIdentifiers: 7,
    });
  });

  it("(2) `order` es una permutación exacta de 1..32 y coherente con la facilitación (bloque 4 primero, apéndice al final)", () => {
    const ordenes = [...DECISION_CATALOG.entries.map((e) => e.order)].sort((a, b) => a - b);
    expect(ordenes).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    const bloquePorId = new Map(DECISION_CATALOG.blocks.map((b) => [b.id, b]));
    const enOrden = [...DECISION_CATALOG.entries].sort((a, b) => a.order - b.order);
    const prioridades = enOrden.map((e) => bloquePorId.get(e.blockId)?.facilitationOrder ?? Number.POSITIVE_INFINITY);
    for (let i = 1; i < prioridades.length; i += 1) {
      expect(prioridades[i], `la entrada ${String(enOrden[i]?.entryId)} rompe el orden de facilitación`).toBeGreaterThanOrEqual(prioridades[i - 1] as number);
    }
    // Dentro de cada bloque, el orden de fila del §3 (packLine ascendente).
    for (const bloque of DECISION_CATALOG.blocks) {
      const delBloque = enOrden.filter((e) => e.blockId === bloque.id);
      expect(delBloque.map((e) => e.packLine)).toEqual([...delBloque.map((e) => e.packLine)].sort((a, b) => a - b));
    }
    // Y L1 va al final, porque una posición condicionada no puede resolverse
    // a una posición fija en mitad de la lista (§2.7).
    expect(enOrden[31]?.entryId).toBe("L1");
  });
});

// =====================================================================
// §9.1.3 — las ocho validaciones, cada una con su mutante
// =====================================================================

describe("step 20 · catálogo — validación V1–V8 con catálogos mutantes", () => {
  it("el catálogo real valida sin lanzar", () => {
    expect(() => { validateDecisionCatalog(DECISION_CATALOG); }).not.toThrow();
  });

  it("V1: un entryId duplicado se rechaza", () => {
    const m = clonMutable();
    (m.entries[1] as { entryId: string }).entryId = "J5/K1";
    expect(validar(m)).toThrow(/identificador duplicado/);
  });

  it("V1: un identificador repetido en dos entradas se rechaza", () => {
    const m = clonMutable();
    (m.entries[1] as { identifiers: string[] }).identifiers = ["K3", "K1"];
    expect(validar(m)).toThrow(/identificador duplicado: K1/);
  });

  it("V2: un recuento roto (31 entradas) se rechaza con el esperado y el encontrado", () => {
    const m = clonMutable();
    m.entries.pop();
    expect(validar(m)).toThrow(/recuento del catálogo: esperado/);
  });

  it("V3: una dependencia colgante se rechaza nombrando la dependencia y la entrada", () => {
    const m = clonMutable();
    (m.entries.find((e) => e.entryId === "K3") as { dependsOn: string[] }).dependsOn = ["J99"];
    expect(validar(m)).toThrow(/dependencia colgante: J99 en K3/);
  });

  it("V4: una autodependencia se rechaza SIEMPRE", () => {
    const m = clonMutable();
    (m.entries.find((e) => e.entryId === "J12") as { dependsOn: string[] }).dependsOn = ["J13", "J12"];
    expect(validar(m)).toThrow(/autodependencia/);
  });

  it("V5: una sola opción se rechaza", () => {
    const m = clonMutable();
    const e = m.entries.find((x) => x.entryId === "K3") as { options: unknown[] };
    e.options = [e.options[0]];
    expect(validar(m)).toThrow(/opciones inválidas en K3/);
  });

  it("V5: cuatro opciones se rechazan", () => {
    const m = clonMutable();
    const e = m.entries.find((x) => x.entryId === "J1") as { options: { letter: string; text: string }[] };
    e.options = [...e.options, { letter: "D", text: "una cuarta que el pack no tiene" }];
    expect(validar(m)).toThrow(/opciones inválidas en J1/);
  });

  it("V5: letras no consecutivas (A, C) se rechazan", () => {
    const m = clonMutable();
    const e = m.entries.find((x) => x.entryId === "K3") as { options: { letter: string }[] };
    (e.options[1] as { letter: string }).letter = "C";
    expect(validar(m)).toThrow(/opciones inválidas en K3/);
  });

  it("V6: una pregunta en blanco se rechaza", () => {
    const m = clonMutable();
    (m.entries.find((e) => e.entryId === "J7") as { question: string }).question = "   ";
    expect(validar(m)).toThrow(/texto en blanco en J7/);
  });

  it("V6: un rótulo de bloque en blanco se rechaza", () => {
    const m = clonMutable();
    (m.blocks[0] as { label: string }).label = "";
    expect(validar(m)).toThrow(/texto en blanco en bloque-1/);
  });

  it("V7: una urgencia desconocida se rechaza, y un kind incoherente con el prefijo literal también", () => {
    const m1 = clonMutable();
    (m1.entries.find((e) => e.entryId === "J7") as { urgency: { kind: string } }).urgency.kind = "urgentisima";
    expect(validar(m1)).toThrow(/clasificación desconocida en J7/);

    // Un kind coherente con los recuentos (sigue siendo bloqueante) pero con
    // una etiqueta que no empieza por el prefijo literal reservado.
    const m2 = clonMutable();
    (m2.entries.find((e) => e.entryId === "J6") as { urgency: { label: string } }).urgency.label = "BLOQUEA: sin la raya larga del pack";
    expect(validar(m2)).toThrow(/clasificación desconocida en J6/);
  });

  it("V8: un hueco en `order` se rechaza", () => {
    const m = clonMutable();
    (m.entries.find((e) => e.entryId === "L1") as { order: number }).order = 34;
    expect(validar(m)).toThrow(/orden no determinista/);
  });

  it("V8: un orden incoherente con la facilitación se rechaza (J8, del 2.º bloque, delante del 1.º)", () => {
    const m = clonMutable();
    const j8 = m.entries.find((e) => e.entryId === "J8") as { order: number };
    const j5k1 = m.entries.find((e) => e.entryId === "J5/K1") as { order: number };
    const antes = j8.order;
    j8.order = j5k1.order;
    j5k1.order = antes;
    expect(validar(m)).toThrow(/orden no determinista/);
  });

  it("V8: un blockId inexistente se rechaza", () => {
    const m = clonMutable();
    (m.entries.find((e) => e.entryId === "K14") as { blockId: string }).blockId = "bloque-10";
    expect(validar(m)).toThrow(/orden no determinista: blockId inexistente/);
  });
});

// =====================================================================
// §9.1.4 — las seis componentes fuertemente conexas, sin margen (R4-1)
// =====================================================================

describe("step 20 · catálogo — componentes fuertemente conexas (D20-14)", () => {
  const porId = new Map(DECISION_CATALOG.entries.map((e) => [e.entryId, e]));
  const cfcReales = componentesNoTriviales(
    DECISION_CATALOG.entries.map((e) => e.entryId),
    (nodo) => porId.get(nodo)?.dependsOn ?? [],
  );

  it("las CFC no triviales del catálogo real son EXACTAMENTE las seis declaradas, y ninguna otra", () => {
    expect(new Set(cfcReales.map(claveDeConjunto))).toEqual(new Set(COMPONENTES_CONOCIDAS.map(claveDeConjunto)));
    expect(cfcReales.length).toBe(6);
    // La componente grande tiene SEIS nodos: K6 y K17 no forman un ciclo
    // aparte, quedan absorbidos (la lectura por pares no lo veía, R4-1).
    expect(cfcReales.map(claveDeConjunto)).toContain(claveDeConjunto(["J5/K1", "K2", "K5", "J9", "K17", "K6"]));
  });

  it("los 16 nodos restantes son componentes triviales de un elemento", () => {
    const enCfc = new Set(cfcReales.flat());
    expect(enCfc.size).toBe(16); // 6+2+2+2+2+2
    expect(DECISION_CATALOG.entries.length - enCfc.size).toBe(16);
  });

  it("mutante (a): añadir la arista K3 → J5/K1 FUNDE K3 en la componente grande y falla", () => {
    const m = clonMutable();
    (m.entries.find((e) => e.entryId === "K3") as { dependsOn: string[] }).dependsOn = ["J5/K1"];
    expect(validar(m)).toThrow(/componente fuertemente conexa no declarada/);
  });

  it("mutante (b): quitar K6 → K17 PARTE la componente grande y falla", () => {
    const m = clonMutable();
    (m.entries.find((e) => e.entryId === "K6") as { dependsOn: string[] }).dependsOn = [];
    expect(validar(m)).toThrow(/componente/);
  });

  it("mutante (c): declarar el par [K6, K17] —la propuesta equivocada de la primera redacción— falla, porque ninguna CFC real es ese conjunto", () => {
    expect(validar(clonMutable(), [...COMPONENTES_CONOCIDAS, ["K6", "K17"]])).toThrow(/componente declarada sin correspondencia/);
  });
});

// =====================================================================
// §9.1.5 — hechos del grafo
// =====================================================================

describe("step 20 · catálogo — canonización de dependencias (D20-15)", () => {
  it("`dependsOn` de J12 es exactamente [J13]: ni la autodependencia del pack sin corregir, ni un J11 inventado", () => {
    expect(entradaDe("J12").dependsOn).toEqual(["J13"]);
  });

  it("las tres celdas que escriben «K1» a secas (K2, J9, K5) resuelven a J5/K1", () => {
    for (const id of ["K2", "J9", "K5"]) {
      expect(entradaDe(id).dependsOn, id).toContain("J5/K1");
      expect(entradaDe(id).dependsOn, id).not.toContain("K1");
    }
  });

  it("las dependencias externas de K13 y J13 conservan su texto verbatim, NO están en dependsOn y NO cuentan para las CFC", () => {
    expect(entradaDe("K13").externalDependencies).toEqual(["identidad real (fuera de las tres misiones)"]);
    expect(entradaDe("J13").externalDependencies).toEqual(["explorador (Capacidad 1)"]);
    const todosLosDependsOn = DECISION_CATALOG.entries.flatMap((e) => e.dependsOn);
    expect(todosLosDependsOn).not.toContain("identidad real (fuera de las tres misiones)");
    expect(todosLosDependsOn).not.toContain("explorador (Capacidad 1)");
    expect(COMPONENTES_CONOCIDAS.flat().every((id) => ID_RE.test(id))).toBe(true);
  });
});

// =====================================================================
// §9.1.7 — congelación en profundidad (I20-12)
// =====================================================================

describe("step 20 · catálogo — inmutabilidad", () => {
  it("mutar una opción, una entrada o el array entero no cambia el catálogo", () => {
    const opcion = DECISION_CATALOG.entries[0]?.options[0] as { text: string };
    const textoOriginal = opcion.text;
    expect(() => {
      opcion.text = "texto inyectado";
    }).toThrow(TypeError);
    expect(opcion.text).toBe(textoOriginal);

    const entradas = DECISION_CATALOG.entries as unknown as unknown[];
    expect(() => {
      entradas.push({});
    }).toThrow(TypeError);
    expect(DECISION_CATALOG.entries.length).toBe(32);

    expect(() => {
      (DECISION_CATALOG as { version: string }).version = "otra";
    }).toThrow(TypeError);
    expect(DECISION_CATALOG.version).toBe("step 20 · catálogo v1");
  });
});

// =====================================================================
// §9.1.8 — I20-17: el vocabulario prohibido, barrido propio del taller.
// DEBE FALLAR contra el pack SIN corregir (PACK:264): es la prueba que
// demuestra que el prerrequisito D20-55 existe.
// =====================================================================

describe("step 20 · catálogo — vocabulario prohibido en las 32 filas (I20-17)", () => {
  function textosDeEntrada(e: DecisionEntry): string[] {
    return [
      e.question,
      e.questionAside ?? "",
      e.currentBehaviour,
      e.notImplementedNote ?? "",
      ...e.options.map((o) => o.text),
      e.urgency.label,
    ];
  }

  it("ninguna fila del catálogo (ya normalizada) contiene una de las cinco cadenas prohibidas en toda la instantánea", () => {
    for (const entrada of DECISION_CATALOG.entries) {
      const texto = textosDeEntrada(entrada).join(" ").toLowerCase();
      for (const prohibido of ["lista negra", "blacklist", "penalizar", "penalizada", "penalizado"]) {
        expect(texto.includes(prohibido), `${entrada.entryId} contiene «${prohibido}»`).toBe(false);
      }
    }
  });

  it("toda aparición de «penaliz» en el catálogo lleva «ninguna » o «sin » en sus 40 caracteres anteriores (la regla de la 8.11)", () => {
    const texto = DECISION_CATALOG.entries.flatMap((e) => textosDeEntrada(e)).join("\n");
    const trozos = texto.split(/penaliz/i);
    // La opción (B) de J10 la contiene (negada): el barrido tiene material real.
    expect(trozos.length).toBeGreaterThan(1);
    for (const previo of trozos.slice(0, -1)) {
      expect(previo.slice(-40)).toMatch(/ninguna |sin /);
    }
  });
});

// =====================================================================
// §9.1.9 — la huella cambia con el contenido (R4-16)
// =====================================================================

describe("step 20 · catálogo — la huella FNV-1a es sensible al contenido", () => {
  it("el mismo catálogo da la misma huella dos veces; una sola letra distinta en una opción da otra huella", () => {
    const primera = decisionCatalogFingerprint(DECISION_CATALOG);
    const segunda = decisionCatalogFingerprint(DECISION_CATALOG);
    expect(primera).toBe(segunda);
    expect(primera).toMatch(/^[0-9a-f]{8}$/);

    const mutado = clonMutable();
    const opcion = (mutado.entries[0] as { options: { text: string }[] }).options[0] as { text: string };
    opcion.text = `${opcion.text.slice(0, -1)}x`;
    expect(decisionCatalogFingerprint(mutado as unknown as typeof DECISION_CATALOG)).not.toBe(primera);
  });
});

// =====================================================================
// Revisión adversarial 2026-08-06 (A9-4) — la huella cubre TODOS los
// textos servidos, no sólo los seis campos de la primera redacción
// =====================================================================

describe("step 20 · catálogo — la huella cubre todos los textos servidos (A9-4)", () => {
  /**
   * La huella de la vista es, por construcción, la del contenido servido
   * SIN el campo `fingerprint`. La prueba recompone ese contenido con un
   * clon (nunca mutando el objeto congelado) y comprueba que alterar
   * cualquiera de las familias de texto que la primera redacción excluía
   * —copia del panel, copia del acta, campos de bloque, `notImplementedNote`,
   * dependencias externas, leyendas— cambia la huella.
   */
  function contenidoClonado(): Record<string, unknown> {
    const clon = JSON.parse(JSON.stringify(buildDecisionWorkshopView())) as Record<string, unknown>;
    delete clon.fingerprint;
    return clon;
  }

  it("la huella publicada es exactamente la del contenido servido entero (sin el propio campo)", () => {
    const vista = buildDecisionWorkshopView();
    expect(decisionWorkshopFingerprint(contenidoClonado())).toBe(vista.fingerprint);
    // Y la fachada por catálogo da lo mismo: es la misma huella.
    expect(decisionCatalogFingerprint(DECISION_CATALOG)).toBe(vista.fingerprint);
  });

  it("cambiar UNA frase de WORKSHOP_COPY, de ACTA_COPY, un campo de bloque, una notImplementedNote, una dependencia externa o una leyenda cambia la huella", () => {
    const huella = buildDecisionWorkshopView().fingerprint;

    const conCopia = contenidoClonado();
    (conCopia.copy as Record<string, unknown>).heading = "otro título";
    expect(decisionWorkshopFingerprint(conCopia)).not.toBe(huella);

    const conActa = contenidoClonado();
    (conActa.acta as Record<string, unknown>).title = "OTRO TÍTULO DE ACTA";
    expect(decisionWorkshopFingerprint(conActa)).not.toBe(huella);

    const conBloque = contenidoClonado();
    ((conBloque.blocks as Record<string, unknown>[])[0] as Record<string, unknown>).facilitationReason = "otra razón";
    expect(decisionWorkshopFingerprint(conBloque)).not.toBe(huella);

    const entradas = (contenido: Record<string, unknown>) => contenido.entries as Record<string, unknown>[];

    const conNotaNoImplementada = contenidoClonado();
    const conNota = entradas(conNotaNoImplementada).find((e) => e.notImplementedNote !== undefined);
    expect(conNota, "el catálogo tiene al menos una notImplementedNote").toBeDefined();
    (conNota as Record<string, unknown>).notImplementedNote = "otra nota de lo que no existe";
    expect(decisionWorkshopFingerprint(conNotaNoImplementada)).not.toBe(huella);

    const conExterna = contenidoClonado();
    const conDeps = entradas(conExterna).find((e) => (e.externalDependencies as string[]).length > 0);
    expect(conDeps, "el catálogo tiene al menos una dependencia externa").toBeDefined();
    (conDeps as Record<string, unknown>).externalDependencies = ["OTRA-DEPENDENCIA"];
    expect(decisionWorkshopFingerprint(conExterna)).not.toBe(huella);

    const conLeyenda = contenidoClonado();
    (entradas(conLeyenda)[0] as Record<string, unknown>).legendLabel = "otra leyenda";
    expect(decisionWorkshopFingerprint(conLeyenda)).not.toBe(huella);
  });

  it("la serialización es de claves ordenadas: el mismo contenido con otro orden de inserción da la MISMA huella", () => {
    const contenido = contenidoClonado();
    const alReves: Record<string, unknown> = {};
    for (const clave of Object.keys(contenido).reverse()) alReves[clave] = contenido[clave];
    expect(decisionWorkshopFingerprint(alReves)).toBe(decisionWorkshopFingerprint(contenido));
  });
});
