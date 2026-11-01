import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * step 18 · fase H — criterio 8.34: HIGIENE DE LA SUITE.
 *
 * Una suite que crece rápido tiene dos formas silenciosas de mentir: una
 * prueba desactivada que nadie vuelve a mirar, y una aserción que no puede
 * fallar. Las dos dan verde. Las dos son peores que no tener la prueba,
 * porque el recuento sigue subiendo.
 *
 * Este fichero recorre TODOS los `.ts` de `tests/**` —incluido él mismo, sin
 * excepciones ni listas blancas— y falla si encuentra cualquiera de las dos.
 * Los patrones se construyen por trozos, precisamente para que este fichero
 * no se acuse a sí mismo por nombrarlos.
 *
 * Y comprueba, uno a uno, que los ficheros de prueba heredados de step 17
 * siguen existiendo: borrar una prueba también es una forma de aprobar.
 */

const RAIZ_TESTS = join(process.cwd(), "tests");

/** Todos los `.ts` bajo `tests/`, recursivamente. */
function ficherosTs(dir: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) {
      encontrados.push(...ficherosTs(ruta));
    } else if (entrada.endsWith(".ts")) {
      encontrados.push(ruta);
    }
  }
  return encontrados.sort();
}

/**
 * Cada patrón se escribe partido en trozos que se unen en tiempo de
 * ejecución. Así el texto que se busca NUNCA aparece literalmente en este
 * fichero, y el escáner puede recorrerse a sí mismo sin falsos positivos —
 * que es justo lo que haría falta comprobar si alguien intentase esconder una
 * prueba desactivada precisamente aquí.
 */
interface PatronProhibido {
  nombre: string;
  trozos: readonly string[];
}

const PROHIBIDOS: readonly PatronProhibido[] = [
  // Ejecutar sólo una prueba: verde con la suite entera sin ejecutar.
  { nombre: "prueba o bloque marcado como exclusivo", trozos: ["\\.", "on", "ly\\s*\\("] },
  // Prueba saltada, en sus cuatro formas habituales.
  { nombre: "prueba o bloque saltado", trozos: ["\\.", "sk", "ip\\s*\\("] },
  { nombre: "prueba saltada al estilo antiguo", trozos: ["\\bx", "it\\s*\\("] },
  { nombre: "bloque saltado al estilo antiguo", trozos: ["\\bx", "describe\\s*\\("] },
  { nombre: "prueba aplazada", trozos: ["\\.", "to", "do\\s*\\("] },
  // Aserciones que no pueden fallar.
  { nombre: "aserción trivial sobre true", trozos: ["expect\\s*\\(\\s*true\\s*\\)"] },
  { nombre: "aserción trivial sobre false", trozos: ["expect\\s*\\(\\s*false\\s*\\)"] },
  { nombre: "aserción trivial de un número consigo mismo", trozos: ["expect\\s*\\(\\s*1\\s*\\)\\s*\\.", "toBe\\s*\\(\\s*1\\s*\\)"] },
  { nombre: "aserción trivial de una cadena consigo misma", trozos: ["expect\\s*\\(\\s*(['\"])(.*?)\\1\\s*\\)\\s*\\.", "toBe\\s*\\(\\s*(['\"])\\2\\3\\s*\\)"] },
];

function regexDe(patron: PatronProhibido): RegExp {
  return new RegExp(patron.trozos.join(""), "g");
}

/**
 * El escáner tiene que poder fallar. Un patrón mal escrito daría verde para
 * siempre sobre una suite sucia y nadie se enteraría, que es exactamente el
 * fallo que este fichero existe para evitar. Estas muestras se arman también
 * por trozos, por la misma razón que los patrones.
 */
const MUESTRAS_QUE_DEBEN_SALTAR: readonly string[] = [
  `it${"."}${"on"}ly("x", () => {});`,
  `describe${"."}${"on"}ly("x", () => {});`,
  `it${"."}${"sk"}ip("x", () => {});`,
  `describe${"."}${"sk"}ip("x", () => {});`,
  `${"x"}it("x", () => {});`,
  `${"x"}describe("x", () => {});`,
  `it${"."}${"to"}do("pendiente");`,
  `expect(${"true"}).toBe(true);`,
  `expect( ${"false"} ).toBe(false);`,
  `expect(${"1"}).toBe(1);`,
  `expect(${'"hola"'}).toBe("hola");`,
];

/** Y tiene que dejar pasar el código legítimo que se le parece. */
const MUESTRAS_QUE_NO_DEBEN_SALTAR: readonly string[] = [
  "process.exit(1);",
  'it.each([1, 2])("caso %i", () => {});',
  "expect(res.statusCode).toBe(200);",
  "expect(alguna).toBe(true);",
  'expect(fila.id).toBe("res-1");',
  "const saltadas = 0;",
  "foo.skipper(1);",
  "await app.close();",
];

describe("step 18 · criterio 8.34 — el escáner de higiene puede fallar de verdad", () => {
  it("caza todas las formas de prueba desactivada y de aserción trivial", () => {
    const escapadas = MUESTRAS_QUE_DEBEN_SALTAR.filter(
      (linea) => !PROHIBIDOS.some((p) => regexDe(p).test(linea)),
    );
    expect(escapadas).toEqual([]);
  });

  it("y no acusa a código legítimo que se le parece", () => {
    const falsosPositivos = MUESTRAS_QUE_NO_DEBEN_SALTAR.flatMap((linea) =>
      PROHIBIDOS.filter((p) => regexDe(p).test(linea)).map((p) => `${linea} → ${p.nombre}`),
    );
    expect(falsosPositivos).toEqual([]);
  });
});

describe("step 18 · criterio 8.34 — ninguna prueba de esta suite está desactivada ni es trivial", () => {
  const FICHEROS = ficherosTs(RAIZ_TESTS);

  it("hay ficheros que escanear, y el escáner se incluye a sí mismo", () => {
    expect(FICHEROS.length).toBeGreaterThan(40);
    expect(FICHEROS.map((f) => relative(process.cwd(), f))).toContain(
      join("tests", "integration", "higieneDeLaSuite.test.ts"),
    );
  });

  for (const patron of PROHIBIDOS) {
    it(`no aparece en ningún fichero: ${patron.nombre}`, () => {
      const culpables: string[] = [];
      for (const fichero of FICHEROS) {
        const fuente = readFileSync(fichero, "utf8");
        for (const [indice, linea] of fuente.split("\n").entries()) {
          if (regexDe(patron).test(linea)) {
            culpables.push(`${relative(process.cwd(), fichero)}:${String(indice + 1)}: ${linea.trim()}`);
          }
        }
      }
      expect(culpables).toEqual([]);
    });
  }

  it("todo fichero `*.test.ts` declara al menos un `describe` y un `it`: ninguno está vacío", () => {
    const vacios = FICHEROS.filter((f) => f.endsWith(".test.ts")).filter((f) => {
      const fuente = readFileSync(f, "utf8");
      return !/\bdescribe\s*\(/.test(fuente) || !/\bit\s*\(/.test(fuente);
    });
    expect(vacios.map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});

/**
 * Los ficheros `*.test.ts` que existían al cerrar step 17 (commit
 * `478e7f7`). step 18 sólo podía AÑADIR: si uno de estos desapareciera,
 * la suite habría adelgazado sin que nadie lo dijera en voz alta.
 */
const HEREDADOS_DE_M_VPS_17: readonly string[] = [
  "adversarial.test.ts",
  "app.test.ts",
  "booking.test.ts",
  "callEngine/allocation.test.ts",
  "callEngine/bookingNotConfirmed.test.ts",
  "callEngine/boundaries.test.ts",
  "callEngine/calendar.test.ts",
  "callEngine/calendarExceptions.test.ts",
  "callEngine/engine.test.ts",
  "callEngine/holidayApproval.test.ts",
  "callEngine/latencyNotCollected.test.ts",
  "callEngine/phrasingSchedule.test.ts",
  "callEngine/precedence.test.ts",
  "callEngine/regressionFase5.test.ts",
  "callEngine/seasonalSchedule.test.ts",
  "callEngine/time.test.ts",
  "callEngine/demoSalonVenue.test.ts",
  "callEngine/waitlistMatching.test.ts",
  "callEngine/waitlistStateMachine.test.ts",
  "callerIdentity.test.ts",
  "cancellation.test.ts",
  "console/console.test.ts",
  "console/injection.test.ts",
  "console/uiClientLogic.test.ts",
  "console/waitlistApi.test.ts",
  "console/waitlistUi.test.ts",
  "dateFormatter.test.ts",
  "env.test.ts",
  "lookup.test.ts",
  "phone.test.ts",
  "voiceContract.test.ts",
  "voiceE2E.test.ts",
];

/** Los tres módulos de apoyo (no son `*.test.ts`) que aquella suite también dejó. */
const APOYOS_DE_M_VPS_17: readonly string[] = [
  "console/fakeDom.ts",
  "console/uiClientExtract.ts",
  "helpers/testApp.ts",
];

describe("step 18 · criterio 8.34 — la suite heredada de step 17 sigue entera", () => {
  const RELATIVOS = new Set(ficherosTs(RAIZ_TESTS).map((f) => relative(RAIZ_TESTS, f).split(sep).join("/")));

  it("son exactamente 32 ficheros de prueba heredados (37 menos 5 del backend retirado), y la lista no se ha recortado", () => {
    expect(HEREDADOS_DE_M_VPS_17.length).toBe(32);
    expect(new Set(HEREDADOS_DE_M_VPS_17).size).toBe(32);
  });

  for (const fichero of [...HEREDADOS_DE_M_VPS_17, ...APOYOS_DE_M_VPS_17]) {
    it(`sigue existiendo tests/${fichero}`, () => {
      expect(RELATIVOS.has(fichero)).toBe(true);
    });
  }

  it("y la suite sólo ha crecido: hay más ficheros de prueba que los 32 heredados", () => {
    const pruebas = [...RELATIVOS].filter((f) => f.endsWith(".test.ts"));
    expect(pruebas.length).toBeGreaterThan(HEREDADOS_DE_M_VPS_17.length);
    for (const heredado of HEREDADOS_DE_M_VPS_17) expect(pruebas, heredado).toContain(heredado);
  });
});
