import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * BARRIDO ESTÁTICO ANTIPROVEEDOR.
 *
 * La promesa de esta demostración es que el pago es un estado en memoria y
 * nada más: ninguna pasarela, ningún proveedor externo, ningún dato financiero
 * de nadie, ninguna petición de red. Una promesa que sólo vive en un docblock
 * dura hasta el primer despiste, así que aquí se lee el CÓDIGO FUENTE de
 * `src/bookingWeb/**` y se comprueba a nivel de texto.
 *
 * Si alguien añade mañana una integración de cobro, esta prueba se pone roja
 * antes de que llegue a ejecutarse una sola línea suya.
 */

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const DIRECTORIO = join(RAIZ, "src", "bookingWeb");

function ficherosFuente(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...ficherosFuente(ruta));
    else if (entrada.name.endsWith(".ts")) salida.push(ruta);
  }
  return salida.sort();
}

const FUENTES = ficherosFuente(DIRECTORIO);

/**
 * Los nombres de proveedor y los campos de dato financiero que este árbol no
 * puede contener NI SIQUIERA EN UN COMENTARIO. Que no se puedan nombrar es
 * deliberado: un comentario que explica cómo se integraría uno es el primer
 * paso para integrarlo.
 */
const PROHIBIDOS = [
  "stripe",
  "redsys",
  "paypal",
  "iban",
  "card_number",
  "cardnumber",
  "creditcard",
  "credit_card",
  "cvv",
  "swift",
];

describe("Demostración web · barrido estático antiproveedor", () => {
  it("el barrido mira de verdad todos los fuentes de src/bookingWeb", () => {
    // Una prueba que no encuentra ficheros pasa vacía y no prueba nada.
    expect(FUENTES.length).toBeGreaterThanOrEqual(6);
    const nombres = FUENTES.map((f) => f.slice(DIRECTORIO.length + 1));
    expect(nombres).toContain("server.ts");
    expect(nombres).toContain("store.ts");
    expect(nombres).toContain("tenants.ts");
    expect(nombres).toContain("model.ts");
    expect(nombres).toContain("config.ts");
    expect(nombres).toContain("main.ts");
  });

  it("ningún fuente nombra un proveedor de pago ni un campo de dato financiero", () => {
    for (const fichero of FUENTES) {
      const texto = readFileSync(fichero, "utf8").toLowerCase();
      for (const prohibido of PROHIBIDOS) {
        expect(texto.includes(prohibido), `${fichero} contiene «${prohibido}»`).toBe(false);
      }
    }
  });

  it("ningún fuente importa un cliente HTTP ni sale a la red", () => {
    // `axios`, los módulos de red de Node y los clientes del middleware real
    // están todos fuera: esta demostración no habla con nadie. Esto sigue
    // valiendo para TODOS los ficheros, incluidos los tres de la fase 2 (la
    // interfaz): ni el servidor Node ni la plantilla de cliente importan un
    // cliente HTTP de verdad.
    const IMPORTACION_DE_RED =
      /from\s+["'][^"']*(axios|node:http|node:https|node:net|node:dgram|node:tls|\/clients\/|\/services\/)/;
    for (const fichero of FUENTES) {
      const texto = readFileSync(fichero, "utf8");
      expect(IMPORTACION_DE_RED.test(texto), `${fichero} importa algo de red`).toBe(false);
    }
  });

  /**
   * `fetch()`/`XMLHttpRequest` en el SERVIDOR (Node) seguirían siendo la
   * integración de proveedor que esta suite prohíbe. Pero `ui.js.ts`
   * (fase 2) no es código de servidor: es el TEXTO LITERAL del JavaScript de
   * NAVEGADOR que `GET /app.js` sirve, y ese cliente tiene que poder hablar
   * con las rutas `/api/:tenantId/…` de ESTE MISMO proceso — si no pudiera
   * usar `fetch()`, la interfaz entera sería imposible, porque el contrato
   * exige que el cliente NUNCA invente horarios, precios ni estados y los
   * pida SIEMPRE al servidor (ver (internal doc, not included in the template)).
   * `connect-src 'self'` en la CSP de `server.ts` no deja que ese `fetch()`
   * salga de este proceso hacia ningún otro origen, así que la promesa de
   * "sin proveedor externo" se mantiene igual: lo único nuevo es que el
   * cliente puede hablar con SU PROPIO servidor, no con nadie más.
   */
  it("ningún fuente de SERVIDOR llama a fetch ni usa XMLHttpRequest (el cliente de la interfaz, sí, y sólo contra sí mismo)", () => {
    const EXCEPCION_INTERFAZ_DE_CLIENTE = new Set(["ui.js.ts"]);
    for (const fichero of FUENTES) {
      const nombre = fichero.slice(DIRECTORIO.length + 1);
      if (EXCEPCION_INTERFAZ_DE_CLIENTE.has(nombre)) continue;
      const texto = readFileSync(fichero, "utf8");
      expect(/\bfetch\s*\(/.test(texto), `${fichero} llama a fetch`).toBe(false);
      expect(/\bXMLHttpRequest\b/.test(texto), `${fichero} usa XMLHttpRequest`).toBe(false);
    }
  });

  it("el propio cliente de la interfaz sólo llama a fetch contra sus rutas /api/:tenantId relativas", () => {
    const texto = readFileSync(join(DIRECTORIO, "ui.js.ts"), "utf8");
    // Toda llamada a fetch() de este fichero pasa por apiUrl(path), que
    // compone SIEMPRE '/api/' + tenantId + path — nunca una URL absoluta ni
    // un origen ajeno.
    const llamadas = texto.match(/fetch\s*\([^)]*\)/g) ?? [];
    expect(llamadas.length).toBeGreaterThan(0);
    for (const llamada of llamadas) {
      expect(llamada.includes("apiUrl("), `${llamada} no usa apiUrl()`).toBe(true);
    }
    expect(texto.includes("'/api/'")).toBe(true);
    expect(/https?:\/\//.test(texto)).toBe(false);
  });

  it("ningún fuente importa la consola, la voz ni la aplicación real", () => {
    const IMPORTACION_VETADA = /from\s+["'][^"']*(\/console\/|\/voice\/|\/app\.js|\/index\.js)/;
    for (const fichero of FUENTES) {
      const texto = readFileSync(fichero, "utf8");
      expect(IMPORTACION_VETADA.test(texto), `${fichero} importa un módulo vetado`).toBe(false);
    }
  });

  it("ningún fuente lee el reloj real ni usa azar", () => {
    for (const fichero of FUENTES) {
      const texto = readFileSync(fichero, "utf8");
      expect(/Date\.now\s*\(/.test(texto), `${fichero} lee Date.now()`).toBe(false);
      expect(/Math\.random\s*\(/.test(texto), `${fichero} usa Math.random()`).toBe(false);
      expect(/new Date\s*\(\s*\)/.test(texto), `${fichero} construye new Date()`).toBe(false);
    }
  });

  it("package.json no ha ganado ninguna dependencia de pago", () => {
    const paquete = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const nombres = [...Object.keys(paquete.dependencies), ...Object.keys(paquete.devDependencies)];

    for (const nombre of nombres) {
      for (const prohibido of PROHIBIDOS) {
        expect(nombre.toLowerCase().includes(prohibido), `dependencia «${nombre}»`).toBe(false);
      }
    }

    // La lista COMPLETA, congelada. No es rigidez por gusto: esta demostración
    // se entregó con exactamente estas dependencias y ni una más, así que
    // cualquier alta —de pago o no— tiene que pasar por editar esta línea a
    // propósito, y quien la edite verá por qué existe.
    expect(Object.keys(paquete.dependencies).sort()).toEqual([
      "@fastify/rate-limit",
      "axios",
      "dotenv",
      "fastify",
      // v0.3.0 (D-007): `yaml` (ISC, gratuita) para leer clientes/<id>/cliente.yaml.
      "yaml",
      "zod",
    ]);
    expect(Object.keys(paquete.devDependencies).sort()).toEqual([
      "@types/node",
      "nock",
      "tsx",
      "typescript",
      "vitest",
    ]);
  });
});
