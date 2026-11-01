import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { ACTA_COPY, MISION_COPY, WORKSHOP_COPY } from "../../src/console/demoWorkspace.js";
import { DECISION_CATALOG } from "../../src/console/decisionCatalog.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";

/**
 * step 20 · B — Pureza de la instantánea con el taller dentro (diseño §9.2).
 *
 * Cubre: `demo` como única clave que hospeda el taller (I20-14, §2.13); la
 * lista negra de datos personales sobre las claves nuevas SIN tocar la
 * constante existente (I20-16); la forma exacta del §2.3 — incluido que
 * `order` NO viaja (D20-56); el determinismo byte a byte (I20-13); la
 * insensibilidad al mundo; la superficie HTTP intacta (I20-1); el espejo del
 * barrido de la suma prohibida (§9.2.7); las 32 leyendas distintas (R4-8); y
 * el barrido de vocabulario de I20-8 sobre los tres catálogos de copia.
 */

const TEST_SALT = "taller-snapshot-test-salt";

type Json = Record<string, unknown>;

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

async function post(app: FastifyInstance, url: string, payload: unknown, headers?: Record<string, string>) {
  return app.inject({ method: "POST", url, payload: payload as never, ...(headers !== undefined ? { headers } : {}) });
}

async function snapshotOf(app: FastifyInstance): Promise<Json> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}

async function workshopOf(app: FastifyInstance): Promise<Json> {
  return ((await snapshotOf(app)).demo as Json).decisionWorkshop as Json;
}

// =====================================================================
// §9.2.1 y §9.2.8 — el taller cuelga de `demo` y SÓLO de `demo`
// =====================================================================

describe("step 20 · instantánea — el taller vive dentro de `demo` y de ningún otro sitio", () => {
  it("(1) `decisionWorkshop` existe bajo snap.demo, y la instantánea no gana ninguna clave de primer nivel (I20-14)", async () => {
    const app = freshApp();
    const snap = await snapshotOf(app);
    const demo = snap.demo as Json;
    expect(demo.decisionWorkshop).toBeDefined();
    // La forma cerrada de `demo` la fija resumenOwner.test.ts (R1); aquí se
    // fija que el taller no ha inventado ninguna clave de PRIMER nivel.
    expect(Object.keys(snap)).not.toContain("decisionWorkshop");
    expect(Object.keys(snap)).not.toContain("taller");
    await app.close();
  });

  it("(8) `decisionWorkshop` NO existe bajo `operations` ni bajo ninguna otra clave de primer nivel — de esto depende que el vocabulario del §2.13 siga sin colisionar", async () => {
    const app = freshApp();
    const snap = await snapshotOf(app);
    for (const clave of Object.keys(snap)) {
      if (clave === "demo") continue;
      expect(JSON.stringify(snap[clave]), `la clave ${clave} contiene el taller`).not.toContain("decisionWorkshop");
    }
    // Y en particular `operations`, cuyo barrido de vocabulario (8.11,
    // segunda lista) prohíbe «bloque» y «riesgo» — dos palabras que el
    // catálogo contiene, legítimas y verbatim del pack.
    const operations = JSON.stringify(snap.operations).toLowerCase();
    expect(operations).not.toContain("taller");
    expect(operations).not.toContain("bloque 4");
    await app.close();
  });
});

// =====================================================================
// §9.2.2 — la lista negra de datos personales, sobre lo que el taller añade
// =====================================================================

// La MISMA lista y la MISMA normalización que tests/console/console.test.ts
// (caso 6), replicadas aquí a propósito: esa prueba sigue intacta y barre la
// instantánea entera; ésta hace que el fallo aparezca AL ESCRIBIR la
// constante de copia, no tres pruebas más allá (aviso del §9.2.2).
const PERSONAL_DATA_KEY_SUBSTRINGS = [
  "phone", "telefono", "telephone", "msisdn", "name", "nombre", "apellido",
  "email", "transcript", "transcripcion", "audio", "recording", "grabacion",
  "address", "direccion", "dni", "nif",
];

function normalizeKey(key: string): string {
  return key.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function collectOffendingKeys(value: unknown, path = "$"): string[] {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => collectOffendingKeys(item, `${path}[${i}]`));
  const offenders: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    for (const banned of PERSONAL_DATA_KEY_SUBSTRINGS) {
      if (normalized.includes(banned)) offenders.push(`${path}.${key} (casa con «${banned}»)`);
    }
    offenders.push(...collectOffendingKeys(child, `${path}.${key}`));
  }
  return offenders;
}

describe("step 20 · instantánea — lista negra de datos personales (I20-16)", () => {
  it("(2) ninguna clave de WORKSHOP_COPY, ACTA_COPY ni MISION_COPY casa con la lista negra — ni siquiera como parte de una palabra mayor", () => {
    expect(collectOffendingKeys(WORKSHOP_COPY, "WORKSHOP_COPY")).toEqual([]);
    expect(collectOffendingKeys(ACTA_COPY, "ACTA_COPY")).toEqual([]);
    expect(collectOffendingKeys(MISION_COPY, "MISION_COPY")).toEqual([]);
  });

  it("(2 bis) ninguna clave de todo `decisionWorkshop` servido casa con la lista negra: el bloque se llama `label`, nunca `name` (R4-3)", async () => {
    const app = freshApp();
    const workshop = await workshopOf(app);
    expect(collectOffendingKeys(workshop, "decisionWorkshop")).toEqual([]);
    await app.close();
  });
});

// =====================================================================
// §9.2.3 — la forma del §2.3, cerrada
// =====================================================================

describe("step 20 · instantánea — decisionWorkshop viene entero y con la forma del §2.3", () => {
  it("(3) las claves de la vista, de cada bloque, de cada entrada y de los totales son EXACTAMENTE las declaradas — y `order` NO viaja (D20-56)", async () => {
    const app = freshApp();
    const workshop = await workshopOf(app);

    expect(Object.keys(workshop).sort()).toEqual(
      ["catalogVersion", "sourceDocument", "fingerprint", "copy", "acta", "mision", "blocks", "entries", "totals"].sort(),
    );
    expect(workshop.catalogVersion).toBe("step 20 · catálogo v1");
    expect(workshop.sourceDocument).toBe("docs/operator_console/DECISION_PACK_TEMPLATE.md");
    expect(workshop.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(workshop.totals).toEqual({
      entries: 32,
      jkEntries: 31,
      jkIdentifiers: 32,
      lIdentifiers: 1,
      blockingEntries: 6,
      blockingIdentifiers: 7,
    });

    const blocks = workshop.blocks as Json[];
    expect(blocks.length).toBe(10);
    // (Revisión U11-3, ensanchada, no debilitada) blockDetailsSummaryLabel:
    // el <summary> de cada bloque, resuelto en el servidor.
    const CLAVES_DE_BLOQUE = ["id", "number", "label", "facilitationOrder", "facilitationOrdinalLabel", "facilitationReason", "estimatedMinutes", "packLine", "blockLabel", "blockDetailsSummaryLabel"];
    for (const block of blocks) {
      const claves = Object.keys(block).filter((k) => k !== "context");
      expect(claves.sort(), `bloque ${String(block.id)}`).toEqual([...CLAVES_DE_BLOQUE].sort());
    }
    // El contexto existe exactamente donde el §3 del pack lo escribe:
    // bloques 1..8; ni el bloque 9 ni el apéndice lo tienen.
    expect(blocks.filter((b) => b.context !== undefined).map((b) => b.id)).toEqual(
      ["bloque-1", "bloque-2", "bloque-3", "bloque-4", "bloque-5", "bloque-6", "bloque-7", "bloque-8"],
    );

    const entries = workshop.entries as Json[];
    expect(entries.length).toBe(32);
    // (Revisión U11-1/U11-3, ensanchada, no debilitada) detailsSummaryLabel y
    // clearButtonLabel: los dos nombres accesibles por tarjeta, resueltos en
    // el servidor como legendLabel.
    const CLAVES_DE_ENTRADA = ["entryId", "identifiers", "blockId", "question", "currentBehaviour", "options", "dependsOn", "externalDependencies", "urgency", "packLine", "identifiersLabel", "urgencyPillLabel", "legendLabel", "detailsSummaryLabel", "clearButtonLabel"];
    for (const entry of entries) {
      const claves = Object.keys(entry).filter((k) => k !== "questionAside" && k !== "questionAsideDisplay" && k !== "notImplementedNote");
      expect(claves.sort(), `entrada ${String(entry.entryId)}`).toEqual([...CLAVES_DE_ENTRADA].sort());
      // D20-56, la aserción que importa: el número de orden NO se publica.
      expect(Object.keys(entry)).not.toContain("order");
    }
    expect(entries.filter((e) => e.questionAside !== undefined).map((e) => e.entryId)).toEqual(["J5/K1"]);
    // (U11-4) La variante de pantalla existe EXACTAMENTE donde existe el
    // verbatim, sin asteriscos — y el verbatim los conserva.
    expect(entries.filter((e) => e.questionAsideDisplay !== undefined).map((e) => e.entryId)).toEqual(["J5/K1"]);
    expect(new Set(entries.filter((e) => e.notImplementedNote !== undefined).map((e) => String(e.entryId)))).toEqual(
      new Set(["J8", "J9", "K4", "K13", "K15", "K12", "L1"]),
    );
    await app.close();
  });

  it("(3 bis) el array `entries` viaja YA ordenado: el §2.7 hecho posición — bloque 4 primero (J5/K1), apéndice al final (L1)", async () => {
    const app = freshApp();
    const entries = (await workshopOf(app)).entries as Json[];
    const ids = entries.map((e) => String(e.entryId));
    // El orden canónico entero del Apéndice A del diseño, sin margen.
    expect(ids).toEqual([
      "J5/K1", "K3", "K6", "K17", "J8", "K4", "K5", "K13", "K15", "J2", "J6", "K2", "K11", "J9",
      "J1", "J3", "J4", "J7", "J11", "K7", "K8", "K9", "K10", "K16", "J12", "J13", "J14", "J15",
      "J10", "K14", "K12", "L1",
    ]);
    await app.close();
  });

  it("(3 ter) los campos resueltos en el servidor: identifiersLabel, urgencyPillLabel, blockLabel y las 32 leyendas DISTINTAS con su identificador (R4-8, D20-47)", async () => {
    const app = freshApp();
    const workshop = await workshopOf(app);
    const entries = workshop.entries as Json[];

    const combinada = entries.find((e) => e.entryId === "J5/K1") as Json;
    expect(combinada.identifiersLabel).toBe("J5 y K1");
    expect(combinada.legendLabel).toBe("J5/K1 — Qué se anota como respuesta provisional");
    const simple = entries.find((e) => e.entryId === "K11") as Json;
    expect(simple.identifiersLabel).toBe("K11");
    expect(simple.legendLabel).toBe("K11 — Qué se anota como respuesta provisional");

    const leyendas = entries.map((e) => String(e.legendLabel));
    expect(new Set(leyendas).size).toBe(32);
    for (const entry of entries) {
      expect(String(entry.legendLabel).startsWith(`${String(entry.entryId)} — `), `leyenda de ${String(entry.entryId)}`).toBe(true);
    }

    const pildoras = new Set(entries.map((e) => String(e.urgencyPillLabel)));
    expect(pildoras).toEqual(new Set(["Bloquea un piloto", "Puede esperar"]));
    expect(entries.filter((e) => e.urgencyPillLabel === "Bloquea un piloto").length).toBe(6);

    const blocks = workshop.blocks as Json[];
    expect((blocks.find((b) => b.id === "bloque-4") as Json).blockLabel).toBe(
      "Bloque 4 — Inasistencias y cancelaciones tardías: consecuencias",
    );
    expect((blocks.find((b) => b.id === "apendice-l") as Json).blockLabel).toBe("Apéndice §4 — pregunta nueva de step 19");
    expect((blocks.find((b) => b.id === "bloque-4") as Json).facilitationOrdinalLabel).toBe("1.º de 9");
    expect((blocks.find((b) => b.id === "apendice-l") as Json).facilitationOrdinalLabel).toBe("Apéndice");
    await app.close();
  });
});

// =====================================================================
// §9.2.4 y §9.2.5 — determinismo e insensibilidad al mundo (I20-13)
// =====================================================================

describe("step 20 · instantánea — determinismo e insensibilidad al mundo", () => {
  it("(4) dos GET /api/snapshot seguidos devuelven el mismo decisionWorkshop, byte a byte", async () => {
    const app = freshApp();
    const primera = JSON.stringify(await workshopOf(app));
    const segunda = JSON.stringify(await workshopOf(app));
    expect(segunda).toBe(primera);
    await app.close();
  });

  it("(5) el decisionWorkshop es idéntico antes y después de cancelar una cita, anotar una inasistencia, avanzar el reloj y reiniciar", async () => {
    const app = freshApp();
    expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
    const antes = JSON.stringify(await workshopOf(app));

    // Avanzar el reloj hasta el final de una cita y anotar la inasistencia.
    expect((await post(app, "/api/lab/clock/advance", { command: "advance_to_reservation_end", reservationId: "demo-salon-res-1" })).statusCode).toBe(200);
    const snap = await snapshotOf(app);
    const fila = ((snap.calendar as Json).reservations as Json[]).find((r) => r.id === "demo-salon-res-1") as Json;
    expect((await post(app, "/api/reservations/demo-salon-res-1/no-show", { confirmed: true }, { "idempotency-key": String(fila.noShowKeyToMint) })).statusCode).toBe(201);
    expect(JSON.stringify(await workshopOf(app))).toBe(antes);

    // Cancelar otra cita.
    expect((await post(app, "/api/reservations/demo-salon-res-2/cancel", { reasonCode: "unspecified", confirmed: true }, { "idempotency-key": "taller:cancel:res-2" })).statusCode).toBe(200);
    expect(JSON.stringify(await workshopOf(app))).toBe(antes);

    // Avanzar el reloj un poco más.
    expect((await post(app, "/api/lab/clock/advance", { command: "advance_minutes", minutes: 60 })).statusCode).toBe(200);
    expect(JSON.stringify(await workshopOf(app))).toBe(antes);

    // Y reiniciar la demostración entera.
    expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
    expect(JSON.stringify(await workshopOf(app))).toBe(antes);
    await app.close();
  });
});

// =====================================================================
// §9.2.6 — superficie HTTP intacta (I20-1)
// =====================================================================

describe("step 20 · instantánea — ninguna ruta nueva, ninguna escritura del taller", () => {
  it("(6) el árbol de rutas registradas no menciona taller, acta, borrador, decisión ni workshop, y sigue sin PATCH/PUT/DELETE", () => {
    const app = freshApp();
    const arbol = app.printRoutes();
    for (const prohibido of ["taller", "acta", "borrador", "decision", "workshop"]) {
      expect(arbol.toLowerCase(), `la superficie HTTP menciona «${prohibido}»`).not.toContain(prohibido);
    }
    expect(arbol).not.toContain("PATCH");
    expect(arbol).not.toContain("PUT");
    expect(arbol).not.toContain("DELETE");
  });
});

// =====================================================================
// §9.2.7 — el espejo del barrido de la suma prohibida (R4B-1)
// =====================================================================

describe("step 20 · instantánea — la suma prohibida no viaja con el taller", () => {
  it("(7) JSON.stringify(snap.demo) con el taller dentro no casa con /\\b12\\b/, y ningún campo numérico de decisionWorkshop vale 12", async () => {
    const app = freshApp();
    expect((await post(app, "/api/reset", {})).statusCode).toBe(200);
    const demo = (await snapshotOf(app)).demo as Json;
    // El barrido que se rompería el día que alguien reintrodujera `order` en
    // la vista «porque es cómodo»: la entrada con order 12 (K2) serializaría
    // "order":12 y activaría el caso M1b/R1 de resumenOwner.test.ts.
    expect(JSON.stringify(demo)).not.toMatch(/\b12\b/);

    const numeros: number[] = [];
    const recolectar = (valor: unknown): void => {
      if (typeof valor === "number") numeros.push(valor);
      else if (Array.isArray(valor)) valor.forEach(recolectar);
      else if (valor !== null && typeof valor === "object") Object.values(valor as Json).forEach(recolectar);
    };
    recolectar(demo.decisionWorkshop);
    expect(numeros.length).toBeGreaterThan(0);
    expect(numeros).not.toContain(12);
    await app.close();
  });
});

// =====================================================================
// I20-8 — barrido de vocabulario sobre los tres catálogos de copia
// =====================================================================

describe("step 20 · copia — ninguna superficie sugiere una meta alcanzable (I20-8)", () => {
  /**
   * La definición operativa del §7: la palabra cuenta como negada si en los
   * 40 caracteres anteriores aparece una de las siete marcas de negación.
   * (Vocabulario más ancho que el de la 8.11 a propósito, y SÓLO en esta
   * prueba nueva: la 8.11 sigue con sus dos.)
   */
  function aparicionNegada(texto: string, patron: RegExp): boolean {
    const trozos = texto.toLowerCase().split(patron);
    for (const previo of trozos.slice(0, -1)) {
      if (!/no |ni |ninguna |ningún |nada |sin |nunca /.test(previo.slice(-40))) return false;
    }
    return true;
  }

  function textosDe(valor: unknown): string[] {
    if (typeof valor === "string") return [valor];
    if (Array.isArray(valor)) return valor.flatMap(textosDe);
    if (valor !== null && typeof valor === "object") return Object.values(valor as Json).flatMap(textosDe);
    return [];
  }

  it("ni %, ni «listo», ni «preparado» en WORKSHOP_COPY/ACTA_COPY/MISION_COPY; «aprobado» sólo dentro de una negación", () => {
    const texto = textosDe([WORKSHOP_COPY, ACTA_COPY, MISION_COPY]).join("\n");
    expect(texto).not.toContain("%");
    expect(texto.toLowerCase()).not.toMatch(/\blistos?\b/);
    expect(texto.toLowerCase()).not.toMatch(/preparad[oa]s?\b/);
    expect(aparicionNegada(texto, /aprobad/)).toBe(true);
    // Y las apariciones de «aprobad» existen: el acta se desmiente a sí misma
    // en su primera línea, cada vez (§10.4). Un barrido sin material sería vacío.
    expect(texto.toLowerCase()).toMatch(/aprobad/);
  });

  it("el catálogo servido tampoco enseña porcentaje ni barra de progreso: ningún texto de las 32 filas contiene «%»", () => {
    for (const entrada of DECISION_CATALOG.entries) {
      const texto = [entrada.question, entrada.currentBehaviour, ...entrada.options.map((o) => o.text), entrada.urgency.label].join(" ");
      expect(texto, entrada.entryId).not.toContain("%");
    }
  });
});

// =====================================================================
// Revisión de UI/UX y accesibilidad 2026-08-06 (U11) — los nombres
// accesibles servidos resueltos, distintos dos a dos (espejo de §9.6.1)
// =====================================================================

describe("step 20 · instantánea — los nombres accesibles por fila y por bloque son propios y distintos (U11-1, U11-3, U11-4)", () => {
  it("los 32 clearButtonLabel y los 32 detailsSummaryLabel son distintos dos a dos y empiezan por su constante de copia y acaban en su entryId", async () => {
    const app = freshApp();
    const workshop = await workshopOf(app);
    const entries = workshop.entries as Json[];

    const botones = entries.map((e) => String(e.clearButtonLabel));
    expect(botones.length).toBe(32);
    expect(new Set(botones).size).toBe(32);
    const detalles = entries.map((e) => String(e.detailsSummaryLabel));
    expect(new Set(detalles).size).toBe(32);
    for (const e of entries) {
      expect(String(e.clearButtonLabel)).toBe(`${WORKSHOP_COPY.clearOneButton} — ${String(e.entryId)}`);
      expect(String(e.detailsSummaryLabel)).toBe(`${WORKSHOP_COPY.detailsSummary} — ${String(e.entryId)}`);
    }
    await app.close();
  });

  it("los 10 blockDetailsSummaryLabel son distintos dos a dos y llevan la etiqueta del bloque tras la constante de copia", async () => {
    const app = freshApp();
    const workshop = await workshopOf(app);
    const blocks = workshop.blocks as Json[];
    const nombres = blocks.map((b) => String(b.blockDetailsSummaryLabel));
    expect(nombres.length).toBe(10);
    expect(new Set(nombres).size).toBe(10);
    for (const b of blocks) {
      expect(String(b.blockDetailsSummaryLabel)).toBe(`${WORKSHOP_COPY.blockDetailsSummary} — ${String(b.blockLabel)}`);
    }
    await app.close();
  });

  it("(U11-4) questionAsideDisplay es el verbatim sin asteriscos, y el verbatim NO se toca: el acta y la deriva siguen leyendo el original", async () => {
    const app = freshApp();
    const workshop = await workshopOf(app);
    const combinada = (workshop.entries as Json[]).find((e) => e.entryId === "J5/K1") as Json;
    expect(String(combinada.questionAside).startsWith("*(")).toBe(true);
    expect(String(combinada.questionAside).endsWith(")*")).toBe(true);
    expect(String(combinada.questionAsideDisplay)).toBe(String(combinada.questionAside).replace(/\*/g, ""));
    expect(String(combinada.questionAsideDisplay)).not.toContain("*");
    await app.close();
  });
});
