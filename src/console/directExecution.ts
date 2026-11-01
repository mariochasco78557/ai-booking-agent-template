import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";

/**
 * ────────────────────────────────────────────────────────────────────────
 * ¿ME ESTÁN EJECUTANDO A MÍ, O SÓLO IMPORTANDO?
 *
 * EL DEFECTO QUE CIERRA ESTE MÓDULO. `src/console/server.ts` decidía si
 * arrancar comparando dos textos:
 *
 *     import.meta.url === `file://${process.argv[1]}`
 *
 * Los dos lados NO están en el mismo alfabeto. `import.meta.url` es una URL y
 * por tanto viene percent-encoded; `process.argv[1]` es una ruta del sistema de
 * ficheros, tal cual. Mientras la ruta del repositorio no tenga caracteres que
 * codificar, los dos textos coinciden por casualidad. En cuanto la tiene —y la
 * de este proyecto contiene espacios, «My Workspace»— el primero dice
 * `file:///Users/…/My%20Workspace/…` y el segundo `/Users/…/My
 * Workspace/…`, la comparación da false, el proceso carga el módulo, no
 * llama a `listen()` y termina en silencio con código 0.
 *
 * Y ese silencio era lo peor: `console.sh` comprobaba que el puerto contestara,
 * no que SU proceso siguiera vivo, así que una consola huérfana de una sesión
 * anterior escuchando en 4310 hacía que el arranque se declarara correcto
 * mientras el proceso recién lanzado ya estaba muerto. El fichero de PID
 * apuntaba entonces a un proceso inexistente y `console-teardown.sh` decía
 * «nada que parar» dejando viva la consola de verdad.
 *
 * LA REGLA: nunca comparar una URL con una ruta. Se traduce la URL a ruta con
 * `fileURLToPath` —que es quien sabe deshacer el percent-encoding— y se compara
 * ruta contra ruta, ya absolutas las dos. Cualquier otro esquema (`data:`,
 * `node:`, un `--eval`) no es una ejecución directa de este fichero y contesta
 * `false` sin lanzar.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * `true` sólo cuando `moduleUrl` es EXACTAMENTE el fichero que Node recibió
 * como punto de entrada.
 *
 * @param moduleUrl  `import.meta.url` del módulo que pregunta.
 * @param entryPath  `process.argv[1]`: la ruta del punto de entrada, o
 *                   `undefined` cuando no hay ninguno (REPL, `--eval`).
 * @param cwd        Base con la que resolver un `entryPath` relativo. Se
 *                   inyecta para poder probarlo sin tocar el proceso.
 */
export function isDirectExecution(
  moduleUrl: string,
  entryPath: string | undefined,
  cwd: string = process.cwd(),
): boolean {
  // Sin punto de entrada no hay ejecución directa que valga: es un REPL, un
  // `--eval` o un proceso que importa este módulo por su cuenta.
  if (entryPath === undefined || entryPath === "") return false;

  let modulePath: string;
  try {
    // Lanza si `moduleUrl` no es una URL `file:` — un módulo servido desde
    // `data:` o `node:` no es este fichero en disco y no debe arrancar nada.
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }

  // `argv[1]` llega absoluto en la práctica, pero resolverlo cuesta nada y
  // evita que un lanzamiento relativo deje la consola sin arrancar en silencio,
  // que es justo el modo de fallo que este módulo existe para no repetir.
  const resolvedEntry = isAbsolute(entryPath) ? entryPath : resolve(cwd, entryPath);
  if (modulePath === resolvedEntry) return true;

  // Última oportunidad, sólo para el caso del enlace simbólico: `console.sh`
  // compone su ruta con `cd … && pwd`, que devuelve la ruta LÓGICA, mientras
  // que Node resuelve el módulo por la REAL. Son el mismo fichero y tienen que
  // contestar que sí. Si alguno de los dos no existe ya en disco, no hay nada
  // que comparar y la respuesta honesta es `false`.
  try {
    return realpathSync(modulePath) === realpathSync(resolvedEntry);
  } catch {
    return false;
  }
}
