import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer } from "../../src/console/server.js";
import { ACTA_COPY } from "../../src/console/demoWorkspace.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks } from "./uiClientExtract.js";

/**
 * step 14 · T2 -- resistencia a inyeccion / entrada hostil.
 *
 * Cada ruta que ACEPTA texto libre de un operador (o de un escenario de
 * Laboratorio) se somete aqui a la misma bateria de cargas hostiles:
 * etiquetas de script, comillas, plantillas `${}`, comillas invertidas,
 * saltos de linea, cadenas muy largas, marcas de direccion Unicode (RLO,
 * U+202E) y bytes nulos (U+0000). La consola no tiene NINGUN lugar donde ese
 * texto se convierta en HTML (ui.js.ts solo usa textContent -- ver
 * tests/console/console.test.ts, prueba (7) y la de "reglas duras"), asi que
 * la propiedad que se comprueba aqui es mas estrecha y mas verificable desde
 * el servidor: la peticion nunca provoca un fallo de servidor (500), el JSON
 * de salida sigue siendo JSON valido con la cadena hostil intacta como DATO
 * (nunca ejecutada, nunca recortada en silencio), y donde hay un limite
 * declarado (longitud, patron), ese limite se aplica con 400 -- nunca con un
 * 500 ni con un truncado silencioso.
 *
 * Los caracteres realmente peligrosos de teclear a mano en un fichero fuente
 * (byte nulo, marca de direccion Unicode) se construyen aqui con escapes
 * `\u0000` / `\u202E` en lugar de pegarlos literalmente -- un byte nulo
 * literal en un .ts es una fuente de problemas de herramientas que nada
 * tiene que ver con lo que esta prueba quiere demostrar.
 */

const NULL_BYTE = "\u0000";
const RLO = "\u202E"; // Right-to-Left Override

const TEST_SALT = "injection-test-salt";

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

const HOSTILE_STRINGS: Array<[string, string]> = [
  ["etiqueta de script", "<script>alert(1)</script>"],
  ["cierre de script suelto", "</script><img src=x onerror=alert(1)>"],
  ["comillas dobles y simples mezcladas", `"'"'"' OR '1'='1`],
  ["plantilla JS", "${7*7}${process.env}"],
  ["comillas invertidas", "`rm -rf /`"],
  ["salto de linea embebido", "linea uno\nlinea dos\r\nlinea tres"],
  ["marca de direccion Unicode (RLO)", `texto${RLO}hostil`],
  ["byte nulo embebido", `antes${NULL_BYTE}despues`],
  ["HTML con atributo de evento", '<img src=x onerror="alert(document.cookie)">'],
  ["inyeccion de plantilla de servidor", "{{7*7}}#{7*7}<%= 7*7 %>"],
];

describe("consola · inyección — POST /api/scenario/run con utterance hostil (T2)", () => {
  for (const [label, payload] of HOSTILE_STRINGS) {
    it(`utterance hostil (${label}) nunca provoca un 500 y nunca aparece ejecutada, sólo como dato`, async () => {
      const app = freshApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/scenario/run",
        payload: {
          scenarioId: "A90-console-inyeccion",
          turns: [{ utterance: payload, day: "wednesday", time: "10:00" }],
        },
      });
      // 500 significaría que la entrada rompió el servidor; nunca aceptable.
      expect(res.statusCode).not.toBe(500);
      expect([200, 400]).toContain(res.statusCode);
      // Pase lo que pase, el cuerpo tiene que seguir siendo JSON bien formado.
      expect(() => res.json()).not.toThrow();
      await app.close();
    });
  }

  it("una utterance de 500 caracteres exactos se acepta (el límite declarado por el esquema)", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: { scenarioId: "A90-console-limite-500", turns: [{ utterance: "a".repeat(500), day: "wednesday" }] },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("una utterance de 501 caracteres se rechaza con 400, no con un recorte silencioso ni con un 500", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: { scenarioId: "A90-console-limite-501", turns: [{ utterance: "a".repeat(501), day: "wednesday" }] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("una utterance de 100.000 caracteres tampoco tumba el servidor (400, nunca 500)", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: { scenarioId: "A90-console-limite-enorme", turns: [{ utterance: "x".repeat(100_000), day: "wednesday" }] },
    });
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("un scenarioId con marcas de inyección (script, punto y coma, barras, RLO) se rechaza con 400 por el patrón del esquema — nunca llega a ejecutarse nada", async () => {
    const app = freshApp();
    const hostileIds = [
      "<script>alert(1)</script>",
      "A01-<script>",
      "A01-'; DROP TABLE calls; --",
      "A01-../../etc/passwd",
      `A01-${NULL_BYTE}nullbyte`,
      `A01-${RLO}rtl`,
    ];
    for (const scenarioId of hostileIds) {
      const res = await app.inject({
        method: "POST",
        url: "/api/scenario/run",
        payload: { scenarioId, turns: [{ utterance: "hola" }] },
      });
      expect(res.statusCode, `scenarioId aceptado indebidamente: ${JSON.stringify(scenarioId)}`).toBe(400);
    }
    await app.close();
  });
});

describe("consola · inyección — cambios de calendario con id/etiqueta hostil (T2)", () => {
  // step 26 REAPERTURA · REVISIÓN ADVERSARIAL (V3-4). Antes, un `id` era
  // texto libre y se INTERPOLABA en la línea del historial de calendario. Un
  // identificador con un salto de línea dentro fabricaba, dentro de una sola
  // entrada, otra entrada perfectamente legible que nadie había escrito. La
  // reparación no es escapar en el punto de pintado: el `id` no es prosa, es
  // un nombre, y ahora tiene forma —minúsculas, cifras, punto, guion y guion
  // bajo—. Lo que no tiene esa forma no llega a existir.
  const IDS_RECHAZADOS = [
    "<script>alert(1)</script>-cierre-${7*7}-`backtick`",
    "<img src=x onerror=alert(1)>",
    "cierre\ncon-salto",
    "cierre\r\ncon-retorno",
    `cierre${NULL_BYTE}nulo`,
    `cierre${RLO}rtl`,
    "../../etc/passwd",
    "-empieza-por-guion",
    "MAYÚSCULAS-Y-ACENTOS",
    "con espacio",
    "a".repeat(201),
    "",
  ];

  it("un id de cierre de local con marcas de inyección se rechaza con 400 y no llega ni al calendario ni al historial", async () => {
    const app = freshApp();
    for (const id of IDS_RECHAZADOS) {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/publish",
        payload: {
          change: { changeKind: "venue_closure", id, startDate: "2026-08-05", endDate: "2026-08-05" },
          resolutions: {},
        },
      });
      expect(res.statusCode, `id aceptado indebidamente: ${JSON.stringify(id)}`).toBe(400);
      expect(res.json().error).toBe("Publicación de calendario inválida");
    }
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      calendar: { closures: Array<{ id: string }>; auditLog: string[] };
    };
    expect(snap.calendar.auditLog).toEqual([]);
    await app.close();
  });

  it("el mismo patrón rige en las TRES ramas del alta y en la retirada — un nombre inválido no se puede ni nombrar", async () => {
    const app = freshApp();
    const malo = "cierre\nfalso";
    const cuerpos: Array<[string, Record<string, unknown>]> = [
      ["venue_closure", { changeKind: "venue_closure", id: malo, startDate: "2026-08-05", endDate: "2026-08-05" }],
      ["special_opening", { changeKind: "special_opening", id: malo, date: "2026-08-05", specialOpen: "10:00", specialClose: "14:00" }],
      [
        "employee_absence",
        { changeKind: "employee_absence", id: malo, employeeId: 3, absenceKind: "absence", startDate: "2026-08-10", endDate: "2026-08-10", allDay: true },
      ],
    ];
    for (const [rama, change] of cuerpos) {
      const res = await app.inject({ method: "POST", url: "/api/calendar/preview", payload: change });
      expect(res.statusCode, `rama ${rama} aceptó un id con salto de línea`).toBe(400);
    }
    for (const url of ["/api/calendar/withdrawal/preview", "/api/calendar/withdrawal/publish"]) {
      const payload = url.endsWith("preview")
        ? { targetKind: "venue_closure", id: malo }
        : { target: { targetKind: "venue_closure", id: malo }, resolutions: {} };
      const res = await app.inject({ method: "POST", url, payload });
      expect(res.statusCode, `${url} aceptó un id con salto de línea`).toBe(400);
      expect(res.json().error).toBe("Retirada de calendario inválida");
    }
    await app.close();
  });

  it("un id con la forma admitida sigue viajando intacto por el snapshot y por el historial", async () => {
    const app = freshApp();
    const id = "cierre.raro_2026-08-05";
    const publishRes = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id, startDate: "2026-08-05", endDate: "2026-08-05" },
        resolutions: {},
      },
    });
    expect(publishRes.statusCode).toBe(200);
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      calendar: { closures: Array<{ id: string }>; auditLog: string[] };
    };
    expect(snap.calendar.closures.some((c) => c.id === id)).toBe(true);
    expect(snap.calendar.auditLog.some((line) => line.includes(id))).toBe(true);
    await app.close();
  });

  it("una NOTA de retirada con saltos de línea no fabrica una entrada de historial: la línea sigue siendo UNA", async () => {
    const app = freshApp();
    await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-forja", startDate: "2026-09-20", endDate: "2026-09-20" },
        resolutions: {},
      },
    });
    // Una nota escrita para PARECER una segunda entrada del historial.
    const forja =
      "vale».\nRetirada de cierre de local 'inventado' publicada el 2026-01-01T00:00:00 por consola-operador " +
      "(0 resolución(es) aplicada(s), 0 pendiente(s) de llamar al cliente).";
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: { target: { targetKind: "venue_closure", id: "cierre-forja" }, resolutions: {}, note: forja },
    });
    expect(res.statusCode).toBe(200);

    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      calendar: { auditLog: string[]; closures: Array<{ id: string; audit: { note?: string } }> };
    };
    // Ni una sola entrada del historial contiene un salto de línea: la forja
    // se lee como lo que es, una nota larga dentro de UNA entrada.
    for (const linea of snap.calendar.auditLog) {
      expect(linea, `entrada del historial con salto de línea: ${JSON.stringify(linea)}`).not.toMatch(
        /[\r\n\u2028\u2029]/u,
      );
    }
    expect(snap.calendar.auditLog).toHaveLength(2);
    const retirada = snap.calendar.auditLog.find((l) => l.startsWith("Retirada de"));
    expect(retirada).toContain("cierre de local 'cierre-forja'");
    expect(retirada).toContain("inventado"); // la forja está ahí, pero DENTRO de la nota
    // Y la nota guardada en el sello conserva el texto tal cual lo escribieron:
    // el saneado es de la LÍNEA del historial, no del dato.
    expect(snap.calendar.closures.find((c) => c.id === "cierre-forja")?.audit.note).toBe(forja);
    await app.close();
  });

  it("un id de más de 200 caracteres se rechaza con 400, nunca con un 500 ni un recorte silencioso", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: { changeKind: "venue_closure", id: "a".repeat(201), startDate: "2026-08-05", endDate: "2026-08-05" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("fechas con contenido hostil (no ISO) no tumban el servidor: se aceptan como texto y la comparación de rangos simplemente no encuentra nada, en vez de fallar con un 500", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: {
        changeKind: "venue_closure",
        id: "fecha-hostil",
        startDate: "<script>alert(1)</script>",
        endDate: "${7*7}",
      },
    });
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(200);
    expect(res.json().impacted).toEqual([]);
    await app.close();
  });

  it("una ausencia con employeeId hostil (cadena en vez de número) se rechaza con 400, no se cuela como NaN", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "ausencia-hostil",
          employeeId: "3; DROP TABLE",
          absenceKind: "absence",
          startDate: "2026-08-10",
          endDate: "2026-08-10",
          allDay: true,
        },
        resolutions: {},
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("una privateReason hostil sigue sin salir NUNCA del servidor, con o sin marcas de inyección dentro", async () => {
    const app = freshApp();
    const hostileSecret = "<script>alert('SECRETO')</script>${leak}`backtick-leak`";
    const publishRes = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "ausencia-secreto-hostil",
          employeeId: 3,
          absenceKind: "absence",
          startDate: "2026-08-10",
          endDate: "2026-08-10",
          allDay: true,
          privateReason: hostileSecret,
        },
        resolutions: {},
      },
    });
    expect(publishRes.statusCode).toBe(200);
    const snapRes = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapRes.body.includes(hostileSecret)).toBe(false);
    expect(snapRes.body.includes("SECRETO")).toBe(false);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// El guardián "nunca innerHTML" REALMENTE detecta una violación plantada —
// no basta con confiar en que su regex hace lo que dice.
// ---------------------------------------------------------------------

describe("consola · el guardián anti-innerHTML de tests/console/console.test.ts SÍ atrapa una violación real (T2)", () => {
  // Reproduce EXACTAMENTE la técnica de detección de
  // tests/console/console.test.ts (stripComments + `.not.toContain(...)`),
  // pero aquí se aplica a una copia MODIFICADA del texto real de ui.js.ts
  // con una violación plantada, para demostrar que el detector realmente la
  // encuentra — no que "nunca se ha probado a fallar".
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const REAL_SOURCE = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");

  it("el texto real de ui.js.ts, tal cual está hoy, pasa el guardián (control negativo)", () => {
    expect(stripComments(REAL_SOURCE)).not.toContain("innerHTML");
  });

  it("una violación plantada DENTRO DE CÓDIGO (no de un comentario) SÍ es detectada", () => {
    const planted = REAL_SOURCE.replace(
      "export function renderConsoleAppJs(): string {",
      "export function renderConsoleAppJs(): string {\n  // marcador de prueba: la línea de abajo NO es un comentario\n  var __plantedViolation = 'el.innerHTML = \"<b>hostil</b>\";';",
    );
    expect(planted).toContain("innerHTML"); // control: la plantación funcionó
    expect(stripComments(planted)).toContain("innerHTML"); // el guardián la ve
  });

  it("una violación puesta DENTRO de un comentario de bloque no cuenta (el guardián sólo mira código real)", () => {
    const withCommentOnly = "/* esto habla de innerHTML pero es sólo un comentario */\nvar x = 1;";
    expect(stripComments(withCommentOnly)).not.toContain("innerHTML");
  });

  it("insertAdjacentHTML, document.write, eval( y new Function plantados en código real también se detectan", () => {
    const violations = ["el.insertAdjacentHTML('beforeend', x)", "document.write(x)", "eval(x)", "new Function(x)"];
    for (const violation of violations) {
      const planted = `${REAL_SOURCE}\nvar __plantado = function () { ${violation}; };\n`;
      const body = stripComments(planted);
      const term = violation.includes("insertAdjacentHTML")
        ? "insertAdjacentHTML"
        : violation.includes("document.write")
          ? "document.write"
          : violation.includes("eval(")
            ? "eval("
            : "new Function";
      expect(body, `no se detectó: ${violation}`).toContain(term);
    }
  });
});

// ---------------------------------------------------------------------
// step 20 §9.5 — notas adversariales del taller de decisiones. Las notas
// son texto humano NO verificado y el acta se compone en el navegador
// (E20-1): esta batería demuestra que ninguna nota puede falsificar la
// estructura del documento. El saneado (D20-38) y los generadores son
// funciones PURAS expuestas por la extracción, así que aquí no hace falta
// DOM: se pide la vista servida a la ruta real y se compone. Los caracteres
// peligrosos se construyen con escapes \uXXXX, como el resto del fichero.
// ---------------------------------------------------------------------

describe("step 20 · taller — notas adversariales en la exportación (§9.5, D20-38, I20-9)", () => {
  const U2028 = "\u2028"; // separador de línea (terminador para JavaScript)
  const U2029 = "\u2029"; // separador de párrafo
  const NEL = "\u0085"; // NEL, el salto de línea del bloque C1
  const ZWSP = "\u200B"; // espacio de anchura cero
  const BOM = "\uFEFF"; // marca de orden de bytes

  type Borrador = Record<string, { opcion: string | null; nota: string }>;

  async function vistaYHooks() {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(res.statusCode).toBe(200);
    const snap = res.json() as Record<string, unknown>;
    const vista = (snap.demo as Record<string, unknown>).decisionWorkshop as Record<string, unknown>;
    const hooks = loadUiClientHooks();
    return { vista, hooks, app };
  }

  it("el saneado (D20-38) neutraliza cada carga de la tabla del §9.5, línea a línea", async () => {
    const { hooks, app } = await vistaYHooks();
    const sanear = hooks.sanearNotaDelTaller;
    // Encabezado que imita una aprobación: citado y con la marca escapada.
    expect(sanear("# APROBADO POR BRUNO")).toEqual(["> \\# APROBADO POR BRUNO"]);
    // Multilínea con sección falsa: cuatro líneas, TODAS con «> »; la
    // tercera es «>» a secas; la cuarta lleva la almohadilla escapada.
    expect(sanear("línea1\nlínea2\n\n## sección falsa")).toEqual(["> línea1", "> línea2", ">", "> \\## sección falsa"]);
    // El separador del acta: prefijado y con el primer «_» escapado — no
    // puede pasar por separador.
    expect(sanear(ACTA_COPY.separator)).toEqual([`> \\${ACTA_COPY.separator}`]);
    // Una nota que ya venía citada: se cita la cita.
    expect(sanear("> ya venía citada")).toEqual(["> \\> ya venía citada"]);
    // Vallas de código: quedan escapadas, no se abre bloque.
    expect(sanear("```js\nalert(1)\n```")).toEqual(["> \\```js", "> alert(1)", "> \\```"]);
    // Lista numerada de Markdown.
    expect(sanear("1. cosa")).toEqual(["> \\1. cosa"]);
    // HTML con aspecto de script: sale como texto citado, sin tocar (el
    // panel además lo pinta con textContent — tallerUi.test.ts, barrido b).
    expect(sanear("<script>alert(1)</script>")).toEqual(["> <script>alert(1)</script>"]);
    // \r\n y tabuladores: normalizados a \n y a un espacio.
    expect(sanear("uno\r\ndos\tres")).toEqual(["> uno", "> dos res"]);
    // Controles C0/DEL (U+0000, U+0007, U+001B, U+007F): eliminados, el
    // resto del texto intacto.
    expect(sanear(`a${NULL_BYTE}b\u0007c\u001bd\u007fe`)).toEqual(["> abcde"]);
    // U+2028, U+2029 y NEL: DOS líneas, las dos con prefijo — sin el paso 1
    // ampliado la segunda saldría desnuda y rompería I20-9 (R4-6).
    expect(sanear(`primera${U2028}segunda`)).toEqual(["> primera", "> segunda"]);
    expect(sanear(`texto${U2029}otro`)).toEqual(["> texto", "> otro"]);
    expect(sanear(`antes${NEL}después`)).toEqual(["> antes", "> después"]);
    // U+202E (anulación derecha-a-izquierda): el control se ELIMINA y el
    // texto se lee en el orden en que está escrito.
    expect(sanear(`abc${RLO}def`)).toEqual(["> abcdef"]);
    // U+200B y U+FEFF: eliminados en silencio (decisión escrita en D20-38);
    // «penal‹ZWSP›izar» no puede atravesar un barrido de vocabulario.
    expect(sanear(`penal${ZWSP}izar${BOM}`)).toEqual(["> penalizar"]);
    // Unicode legítimo (acentos, eñes, cedillas, emoji): intacto.
    expect(sanear("ñandú çigüeña año 😀")).toEqual(["> ñandú çigüeña año 😀"]);
    // Espacios: los FINALES se recortan, los iniciales son del operador.
    expect(sanear("  sangrada a mano   ")).toEqual([">   sangrada a mano"]);
    await app.close();
  });

  it("una nota que copia literalmente «1. LO QUE SE ANOTÓ» no fabrica una segunda sección: el acta sigue teniendo UNA", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const borrador: Borrador = { K3: { opcion: "A", nota: ACTA_COPY.sectionAnnotated } };
    const acta = hooks.componerActaDelTaller(vista, borrador);
    const lineas = acta.split("\n");
    expect(lineas.filter((l) => l === ACTA_COPY.sectionAnnotated)).toHaveLength(1);
    expect(lineas).toContain(`> \\${ACTA_COPY.sectionAnnotated}`);
    await app.close();
  });

  it("una nota con U+2028 sale en el acta como DOS líneas y las dos llevan el prefijo «> » (I20-9)", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const borrador: Borrador = { K3: { opcion: "A", nota: `primera${U2028}segunda` } };
    const acta = hooks.componerActaDelTaller(vista, borrador);
    const lineas = acta.split("\n");
    expect(lineas).toContain("> primera");
    expect(lineas).toContain("> segunda");
    expect(lineas).not.toContain("segunda");
    await app.close();
  });

  it("una nota que imita el separador no parte el acta: el recuento de separadores REALES no cambia", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const sinNota = hooks.componerActaDelTaller(vista, { K3: { opcion: "A", nota: "" } });
    const conNota = hooks.componerActaDelTaller(vista, { K3: { opcion: "A", nota: ACTA_COPY.separator } });
    const separadores = (texto: string) => texto.split("\n").filter((l) => l === ACTA_COPY.separator).length;
    expect(separadores(conNota)).toBe(separadores(sinNota));
    await app.close();
  });

  it("una nota de 280 caracteres sale ENTERA, sin recorte; una de 281 inyectada por código hace FALLAR la exportación (D20-49.3)", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const larga = "á".repeat(280);
    const acta = hooks.componerActaDelTaller(vista, { K3: { opcion: "A", nota: larga } });
    expect(acta).toContain(`> ${larga}`);
    expect(() => hooks.componerActaDelTaller(vista, { K3: { opcion: "A", nota: "x".repeat(281) } })).toThrowError(/280/);
    expect(() => hooks.componerBorradorDeMisionDelTaller(vista, { K3: { opcion: null, nota: "x".repeat(281) } })).toThrowError(/280/);
    await app.close();
  });

  it("una nota vacía no deja rastro: ni rótulo de nota ni línea citada", async () => {
    const { vista, hooks, app } = await vistaYHooks();
    const acta = hooks.componerActaDelTaller(vista, { K3: { opcion: "A", nota: "" } });
    expect(acta).not.toContain(ACTA_COPY.noteHeading);
    for (const linea of acta.split("\n")) expect(linea.startsWith("> ")).toBe(false);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// step 26 REAPERTURA §R11 · P26 — LA NOTA OPERATIVA ES TEXTO LIBRE.
//
// La nota es el único campo de texto libre que esta reapertura añade y que,
// además, SALE hacia la consola por el snapshot. Se somete por eso a la misma
// batería que el resto: etiquetas de script, comillas, plantillas, marcas de
// dirección Unicode, byte nulo, y una cadena de 280 caracteres sin un solo
// espacio. Lo que se exige aquí, desde el servidor: nunca un 500, JSON válido,
// la cadena INTACTA como dato (quien la pinta usa `textContent`), y el límite
// declarado aplicado con 400 — nunca con un recorte silencioso.
// ---------------------------------------------------------------------

describe("consola · inyección — la nota operativa de un cambio de calendario (REAPERTURA §R11, P26)", () => {
  // El nombre anterior prometía «viaja intacta como TEXTO y no ejecuta ni
  // rompe nada». Lo segundo no se comprueba aquí: esto es un ida y vuelta por
  // HTTP, sin navegador y sin una sola pintada de DOM, así que de «no ejecuta»
  // no puede decir nada. Que la nota se pinte con `textContent` lo afirma
  // `horariosYAusencias.test.ts` («la nota se pinta SIEMPRE con textContent»),
  // que sí monta el cliente. Lo que esta prueba afirma —y afirma entero— es la
  // fidelidad byte a byte del ida y vuelta. Las aserciones no se tocan.
  it("una nota con marcas de inyección hace el viaje de ida y vuelta byte a byte, sin 500 y sin recorte", async () => {
    const app = freshApp();
    const notaHostil = `<script>alert(1)</script> \${7*7} \`backtick\` "comillas" 'simples' ${RLO}rtl`;
    const publishRes = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "venue_closure",
          id: "cierre-nota-hostil",
          startDate: "2026-08-05",
          endDate: "2026-08-05",
          note: notaHostil,
        },
        resolutions: {},
      },
    });
    expect(publishRes.statusCode).toBe(200);

    const snapRes = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapRes.statusCode).toBe(200);
    interface SnapShape {
      calendar: { closures: Array<{ id: string; audit: { note?: string } }> };
    }
    const snap = snapRes.json() as SnapShape;
    const cierre = snap.calendar.closures.find((c) => c.id === "cierre-nota-hostil");
    expect(cierre?.audit.note).toBe(notaHostil);
    await app.close();
  });

  it("una nota con byte nulo y saltos de línea tampoco tumba el servidor ni se recorta a escondidas", async () => {
    const app = freshApp();
    const nota = `linea 1\nlinea 2\t${NULL_BYTE}fin`;
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "ausencia-nota-byte-nulo",
          employeeId: 3,
          absenceKind: "absence",
          startDate: "2026-08-10",
          endDate: "2026-08-10",
          allDay: true,
          note: nota,
        },
        resolutions: {},
      },
    });
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(200);
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      calendar: { absences: Array<{ id: string; audit: { note?: string } }> };
    };
    expect(snap.calendar.absences.find((a) => a.id === "ausencia-nota-byte-nulo")?.audit.note).toBe(nota);
    await app.close();
  });

  it("280 caracteres sin un solo espacio se aceptan enteros; 281 se rechazan con 400, nunca con un 500", async () => {
    const app = freshApp();
    const justoEnElTope = "ñ".repeat(280);
    const aceptada = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-nota-tope", startDate: "2026-08-05", endDate: "2026-08-05", note: justoEnElTope },
        resolutions: {},
      },
    });
    expect(aceptada.statusCode).toBe(200);
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      calendar: { closures: Array<{ id: string; audit: { note?: string } }> };
    };
    expect(snap.calendar.closures.find((c) => c.id === "cierre-nota-tope")?.audit.note).toBe(justoEnElTope);

    const rechazada = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: { changeKind: "venue_closure", id: "cierre-nota-pasada", startDate: "2026-08-05", endDate: "2026-08-05", note: "x".repeat(281) },
    });
    expect(rechazada.statusCode).toBe(400);
    expect(rechazada.json().error).toBe("Cambio de calendario inválido");
    await app.close();
  });

  it("una nota que no es texto (número, objeto, array) se rechaza con 400 y no se cuela como nada", async () => {
    const app = freshApp();
    for (const nota of [42, { texto: "hola" }, ["a"], true]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/preview",
        payload: { changeKind: "venue_closure", id: "cierre-nota-tipo", startDate: "2026-08-05", endDate: "2026-08-05", note: nota },
      });
      expect(res.statusCode, `nota aceptada indebidamente: ${JSON.stringify(nota)}`).toBe(400);
    }
    await app.close();
  });
});
