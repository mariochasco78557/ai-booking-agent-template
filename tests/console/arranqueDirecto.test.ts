import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isDirectExecution } from "../../src/console/directExecution.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * REPARACIÓN R-ARRANQUE — EL GUARDIÁN DE EJECUCIÓN DIRECTA.
 *
 * EL DEFECTO: `src/console/server.ts` decidía si arrancar comparando
 * `import.meta.url` con `` `file://${process.argv[1]}` ``. Una URL contra una
 * ruta. Con la ruta real de este repositorio —«…/My Workspace/…»— el
 * primero llega percent-encoded (`My%20Workspace`) y el segundo no,
 * así que la comparación daba false SIEMPRE: `console.sh` lanzaba el proceso,
 * el proceso cargaba el módulo, no llamaba a `listen()` y moría en silencio con
 * código 0.
 *
 * Estas pruebas fijan las cinco propiedades que el guardián debe cumplir a la
 * vez, y la primera se comprueba EJECUTANDO node de verdad desde un directorio
 * con espacios: una comparación de cadenas escrita a mano en una prueba podría
 * darse la razón a sí misma sin que Node opine.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Un directorio temporal cuyo nombre tiene espacios, como el del repositorio real. */
function tempDirConEspacios(prefijo: string): string {
  return mkdtempSync(join(tmpdir(), `${prefijo} con espacios `));
}

describe("R-ARRANQUE · el guardián compara RUTAS, nunca una URL contra una ruta", () => {
  it("dice que sí con una ruta que contiene espacios (el caso que rompía este repositorio)", () => {
    const ruta = "/Users/quien sea/My Workspace/Demo Salon/src/console/server.ts";
    const url = pathToFileURL(ruta).href;

    // La prueba se gana el derecho a existir: la comparación vieja falla aquí…
    expect(url).toContain("%20");
    expect(url === `file://${ruta}`).toBe(false);

    // …y la nueva acierta.
    expect(isDirectExecution(url, ruta)).toBe(true);
  });

  it("dice que sí con otros caracteres que la URL codifica: acentos, almohadilla, porcentaje", () => {
    for (const nombre of ["ñandú directorio", "carpeta#1", "100% sintético", "a+b y c", "día [1]"]) {
      const ruta = `/tmp/${nombre}/src/console/server.ts`;
      expect(isDirectExecution(pathToFileURL(ruta).href, ruta), nombre).toBe(true);
    }
  });

  it("dice que no cuando el punto de entrada es OTRO fichero (importar no es ejecutar)", () => {
    const modulo = "/Users/quien sea/proyecto/src/console/server.ts";
    const entrada = "/Users/quien sea/proyecto/node_modules/.bin/vitest";
    expect(isDirectExecution(pathToFileURL(modulo).href, entrada)).toBe(false);
  });

  it("dice que no sin punto de entrada, y no lanza: REPL, `--eval` o `argv[1]` vacío", () => {
    const url = pathToFileURL("/Users/quien sea/proyecto/src/console/server.ts").href;
    expect(isDirectExecution(url, undefined)).toBe(false);
    expect(isDirectExecution(url, "")).toBe(false);
  });

  it("dice que no —sin lanzar— si el módulo no viene de un fichero", () => {
    for (const url of ["data:text/javascript,export{}", "node:fs", "https://example.invalid/x.js", "no soy una url"]) {
      expect(isDirectExecution(url, "/tmp/x.ts"), url).toBe(false);
    }
  });

  it("resuelve un punto de entrada RELATIVO contra el directorio de trabajo", () => {
    const base = "/Users/quien sea/proyecto";
    const url = pathToFileURL(`${base}/src/console/server.ts`).href;
    expect(isDirectExecution(url, "src/console/server.ts", base)).toBe(true);
    expect(isDirectExecution(url, "src/console/otro.ts", base)).toBe(false);
  });

  it("un enlace simbólico al mismo fichero cuenta como el mismo fichero", () => {
    const raíz = tempDirConEspacios("arranque");
    try {
      const real = join(raíz, "server real.ts");
      writeFileSync(real, "export {};\n");
      const enlace = join(raíz, "server enlazado.ts");
      symlinkSync(real, enlace);

      // Node resolvería el módulo por su ruta REAL y `console.sh` podría
      // componer la lógica: son el mismo fichero y deben contestar que sí.
      expect(isDirectExecution(pathToFileURL(real).href, enlace)).toBe(true);
      expect(isDirectExecution(pathToFileURL(enlace).href, real)).toBe(true);
    } finally {
      rmSync(raíz, { recursive: true, force: true });
    }
  });
});

describe("R-ARRANQUE · comprobado con Node de verdad, desde una ruta con espacios", () => {
  /**
   * El guardián dentro de un proceso REAL. Se copia el patrón exacto de
   * `server.ts` —el `if` que decide arrancar— a un fichero dentro de un
   * directorio con espacios y se ejecuta de las dos formas. Sin esto, las
   * pruebas de arriba sólo demostrarían que dos cadenas coinciden; ésta
   * demuestra que Node produce las cadenas que creemos.
   */
  it("ejecutado directamente arranca; importado desde otro módulo NO arranca", () => {
    const raíz = tempDirConEspacios("arranque real");
    try {
      const guardián = join(raíz, "directExecution.mjs");
      writeFileSync(
        guardián,
        [
          'import { fileURLToPath } from "node:url";',
          'import { isAbsolute, resolve } from "node:path";',
          'import { realpathSync } from "node:fs";',
          "export function isDirectExecution(moduleUrl, entryPath, cwd = process.cwd()) {",
          '  if (entryPath === undefined || entryPath === "") return false;',
          "  let modulePath;",
          "  try { modulePath = fileURLToPath(moduleUrl); } catch { return false; }",
          "  const resolvedEntry = isAbsolute(entryPath) ? entryPath : resolve(cwd, entryPath);",
          "  if (modulePath === resolvedEntry) return true;",
          "  try { return realpathSync(modulePath) === realpathSync(resolvedEntry); } catch { return false; }",
          "}",
          "",
        ].join("\n"),
      );

      const módulo = join(raíz, "servidor de mentira.mjs");
      writeFileSync(
        módulo,
        [
          'import { isDirectExecution } from "./directExecution.mjs";',
          'export const CARGADO = "sí";',
          "if (isDirectExecution(import.meta.url, process.argv[1])) {",
          '  console.log("ARRANCA");',
          "}",
          "",
        ].join("\n"),
      );

      const importador = join(raíz, "solo importa.mjs");
      writeFileSync(
        importador,
        [
          'import { CARGADO } from "./servidor de mentira.mjs";',
          "console.log(`IMPORTADO:${CARGADO}`);",
          "",
        ].join("\n"),
      );

      // La ruta tiene espacios de verdad, y no los tiene por accidente.
      expect(módulo).toContain(" ");

      const directo = execFileSync(process.execPath, [módulo], { encoding: "utf8" });
      expect(directo.trim()).toBe("ARRANCA");

      const importado = execFileSync(process.execPath, [importador], { encoding: "utf8" });
      expect(importado.trim()).toBe("IMPORTADO:sí");
      expect(importado).not.toContain("ARRANCA");

      // Y la comparación VIEJA, en el mismo proceso real, se equivoca: es la
      // demostración de que este defecto era del código y no del entorno.
      const viejo = join(raíz, "guardian viejo.mjs");
      writeFileSync(
        viejo,
        [
          "console.log(String(import.meta.url === `file://${process.argv[1]}`));",
          "",
        ].join("\n"),
      );
      expect(execFileSync(process.execPath, [viejo], { encoding: "utf8" }).trim()).toBe("false");
    } finally {
      rmSync(raíz, { recursive: true, force: true });
    }
  });
});

describe("R-ARRANQUE · `server.ts` sigue sin arrancar nada al importarlo", () => {
  it("importar el módulo no abre ningún puerto ni escribe nada", async () => {
    // Si el guardián se relajara, este `import` arrancaría un servidor real en
    // mitad de la suite. Que la importación termine y no haya escucha es la
    // prueba; el resto de la suite depende de ello desde step 13.
    const mod = await import("../../src/console/server.js");
    expect(typeof mod.buildConsoleServer).toBe("function");
    expect(typeof mod.startConsoleServer).toBe("function");
  });
});

describe("R-ARRANQUE · los lanzadores toleran rutas con espacios", () => {
  /**
   * `console.sh` y `console-teardown.sh` componen rutas con `dirname`/`pwd` y
   * las pasan a `nohup`, `curl` y `kill`. Una sola expansión sin comillas
   * bastaría para partir la ruta por el espacio. Se comprueba estáticamente
   * porque comprobarlo arrancando exigiría el puerto 4310 libre, y una prueba
   * que depende del puerto de la máquina no es una prueba.
   */
  const LANZADORES = ["console.sh", "console-teardown.sh"] as const;
  const RAÍZ_REPO = join(import.meta.dirname, "..", "..");

  function lanzador(nombre: string): string {
    return readFileSync(join(RAÍZ_REPO, "tools", "call-engine-demo", nombre), "utf8");
  }

  it("los dos lanzadores son sintácticamente válidos para bash", () => {
    for (const nombre of LANZADORES) {
      const ruta = join(RAÍZ_REPO, "tools", "call-engine-demo", nombre);
      // `bash -n` analiza sin ejecutar: si alguien parte una cadena por un
      // espacio mal escapado, se entera aquí y no en mitad de una demostración.
      expect(() => execFileSync("bash", ["-n", ruta], { encoding: "utf8" }), nombre).not.toThrow();
    }
  });

  it("las líneas que EJECUTAN algo pasan las rutas entre comillas, literalmente", () => {
    // Se fijan por texto exacto y no por expresión regular: aquí lo que
    // importa es la línea concreta que reventaría con un espacio, y una
    // expresión regular confundiría un mensaje de error ya entrecomillado con
    // una expansión desnuda (que es justo lo que hizo la primera versión de
    // esta prueba).
    const arranque = lanzador("console.sh");
    expect(arranque).toContain('nohup "${TSX_BIN}" "${SERVER_ENTRY}" >"${LOG_FILE}" 2>&1 &');
    expect(arranque).toContain('if [ ! -x "${TSX_BIN}" ]; then');
    expect(arranque).toContain('echo "${NEW_PID}" > "${PID_FILE}"');
    expect(arranque).toContain('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
    expect(arranque).toContain('PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"');

    const parada = lanzador("console-teardown.sh");
    expect(parada).toContain('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
    expect(parada).toContain('pid="$(cat "${PID_FILE}" 2>/dev/null || true)"');
    expect(parada).toContain('rm -f -- "${PID_FILE}"');
  });

  it("`mkdir` de un directorio con espacios y `dirname`/`pwd` sobreviven al viaje", () => {
    const raíz = tempDirConEspacios("lanzador");
    try {
      const sub = join(raíz, "tools", "call-engine-demo");
      mkdirSync(sub, { recursive: true });
      const script = join(sub, "probe.sh");
      writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
          'PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"',
          'echo "${PROJECT_ROOT}"',
          "",
        ].join("\n"),
      );
      const salida = execFileSync("bash", [script], { encoding: "utf8" }).trim();
      expect(salida).toContain(" ");
      expect(realpathSync(salida)).toBe(realpathSync(raíz));
    } finally {
      rmSync(raíz, { recursive: true, force: true });
    }
  });
});
