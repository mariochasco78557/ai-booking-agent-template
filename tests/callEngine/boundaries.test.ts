import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fixedClock, type SyntheticProfessional } from "../../src/callEngine/domain/types.js";
import type { CalendarWithCapabilities, CapabilityMatrix } from "../../src/callEngine/capabilities.js";
import type { OperationalCalendar, EmployeeAbsence, AuditStamp } from "../../src/callEngine/calendar/model.js";
import { runConversation, type ConversationScript } from "../../src/callEngine/engine.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";

const SRC_CALL_ENGINE_ROOT = join(process.cwd(), "src", "callEngine");

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const ALL_SOURCE_FILES = listTsFiles(SRC_CALL_ENGINE_ROOT);

/**
 * (Revisión adversarial de step 22, N3) El barrido de importaciones
 * heredadas recorría SÓLO `src/callEngine/`. `src/console/` está igual de
 * limpio hoy —lo comprueban las pruebas de abajo— pero nada impedía que una
 * edición futura añadiese `import { legacyRestClient } from "../clients/…"` a
 * `src/console/server.ts` y la demostración acabase hablando con la API real
 * de Demo Salon. La consola es CONSUMIDORA del motor y vive bajo las mismas
 * restricciones, así que se le aplica la misma guarda.
 */
const SRC_CONSOLE_ROOT = join(process.cwd(), "src", "console");
const ALL_CONSOLE_FILES = listTsFiles(SRC_CONSOLE_ROOT);

/**
 * Every source file in this tree DOCUMENTS these very restrictions in its
 * own docblocks — e.g. "this module never imports axios, node:net,
 * node:http(s)..." — so a naive raw-text search would false-positive on the
 * prose itself. Stripping comments before searching checks actual CODE, not
 * documentation that happens to name the forbidden token while explaining
 * why it's absent.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. /** ... */ docblocks)
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, but not "://" inside a URL
}

function readCodeOnly(file: string): string {
  return codeOnly(readFileSync(file, "utf8"));
}

/**
 * (Fase 7 de step 22, aviso 1) Los tokens de RUTA se escriben con las dos
 * barras — `/clients/`, no `src/clients` — porque en este repositorio NO HAY
 * ni una sola importación con estilo `src/...`: todas son relativas. Una fuga
 * de verdad se escribiría `"../clients/legacyRestClient.js"`, que no contiene la
 * subcadena `src/clients` y por tanto se colaba entera por delante de la
 * guarda. Con la barra delantera y trasera se cazan los dos estilos, el
 * relativo (`../clients/`, `../../clients/`) y el absoluto (`src/clients/`).
 *
 * El control negativo de cada bloque planta justo eso y falla si el barrido
 * no lo caza; los dos usan LA MISMA expresión que el barrido real, así que no
 * pueden separarse el uno del otro.
 */
const FORBIDDEN_PATH_SEGMENTS = ["/clients/", "/services/", "/routes/"] as const;

/**
 * Las fugas tal y como se escribirían de verdad en este árbol. Cada bloque las
 * pasa por su propia lista de prohibidos.
 */
const FUGAS_REALISTAS: readonly string[] = [
  'import { legacyRestClient } from "../clients/legacyRestClient.js";',
  'import { bookingService } from "../../services/bookingService.js";',
  'import { registerRoutes } from "../routes/index.js";',
  'import { legacyRestClient } from "src/clients/legacyRestClient.js";',
];

/** El MISMO emparejamiento que usa el barrido real sobre cada fichero. */
function hitsIn(code: string, forbiddenImports: readonly string[]): string[] {
  return forbiddenImports.filter((forbidden) => codeOnly(code).includes(forbidden));
}

function itCanActuallyFail(forbiddenImports: readonly string[]): void {
  it("y el barrido puede fallar de verdad: caza la fuga heredada TAL Y COMO SE ESCRIBIRÍA en este repositorio", () => {
    for (const fuga of FUGAS_REALISTAS) {
      expect(
        hitsIn(`${fuga}\nconst x = 1;\n`, forbiddenImports),
        `esta fuga se cuela sin que nadie la vea: ${fuga}`,
      ).not.toEqual([]);
    }
    // Y no acusa a un comentario que sólo NOMBRA lo prohibido.
    const comentario = '// este módulo jamás importa de ../clients/ ni de ../services/\nconst y = 2;\n';
    expect(hitsIn(comentario, forbiddenImports)).toEqual([]);
  });
}

describe("boundaries: no network, no legacy clients/services/routes, anywhere under src/callEngine", () => {
  const forbiddenImports = ["axios", "node:net", "node:http", "node:https", ...FORBIDDEN_PATH_SEGMENTS];

  for (const forbidden of forbiddenImports) {
    it(`no file's actual code imports/references "${forbidden}"`, () => {
      const offenders = ALL_SOURCE_FILES.filter((file) => readCodeOnly(file).includes(forbidden));
      expect(offenders).toEqual([]);
    });
  }

  itCanActuallyFail(forbiddenImports);
});

describe("boundaries: no network, no legacy clients/services/routes, anywhere under src/console", () => {
  // `node:http`/`node:https` no están en la lista de esta consola: la sirve
  // Fastify, que abre el socket por ella, y prohibirlos aquí sería prohibir
  // que la consola exista. Lo que se prohíbe es exactamente lo mismo que en
  // el motor menos eso: cliente HTTP propio, socket a pelo y CUALQUIER
  // reutilización del código heredado del producto A.
  const forbiddenImports = ["axios", "node:net", ...FORBIDDEN_PATH_SEGMENTS, "legacy-symfony-lab"];

  it("hay ficheros de consola que recorrer (una lista vacía daría verde sin comprobar nada)", () => {
    expect(ALL_CONSOLE_FILES.length).toBeGreaterThan(5);
  });

  for (const forbidden of forbiddenImports) {
    it(`no file's actual code imports/references "${forbidden}"`, () => {
      const offenders = ALL_CONSOLE_FILES.filter((file) => readCodeOnly(file).includes(forbidden));
      expect(offenders).toEqual([]);
    });
  }

  itCanActuallyFail(forbiddenImports);
});

describe("boundaries: no wall-clock or random-number reads in src/callEngine", () => {
  it("no file's actual code calls Date.now()", () => {
    const offenders = ALL_SOURCE_FILES.filter((file) => readCodeOnly(file).includes("Date.now("));
    expect(offenders).toEqual([]);
  });

  it("no file's actual code calls Math.random()", () => {
    const offenders = ALL_SOURCE_FILES.filter((file) => readCodeOnly(file).includes("Math.random("));
    expect(offenders).toEqual([]);
  });

  it("no file's actual code calls randomUUID()", () => {
    const offenders = ALL_SOURCE_FILES.filter((file) => readCodeOnly(file).includes("randomUUID("));
    expect(offenders).toEqual([]);
  });

  it('no file constructs `new Date()` with no argument (a bare wall-clock read)', () => {
    // Matches `new Date()` (optionally followed by whitespace) but NOT
    // `new Date("...")`/`new Date(\`...\`)` — every legitimate use in this
    // tree (domain/time.ts) always supplies an explicit ISO string.
    const bareNewDate = /new\s+Date\s*\(\s*\)/;
    const offenders = ALL_SOURCE_FILES.filter((file) => bareNewDate.test(readCodeOnly(file)));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Event-content boundaries: run one real synthetic call and inspect every
// emitted event (both streams) for personal data / raw identifiers.
// ---------------------------------------------------------------------

const EMP = 42;
const SECRET_PRIVATE_REASON = "SECRET-MEDICAL-REASON-NEVER-IN-AN-EVENT";
const RAW_CALL_ID = "RAW-CALL-ID-MUST-NEVER-APPEAR-IN-ANY-EVENT";

function audit(): AuditStamp {
  return { createdAt: "2026-01-01T00:00:00", createdBy: "test-fixture" };
}

function calendarWithPrivateReason(): CalendarWithCapabilities {
  const professionals: SyntheticProfessional[] = [{ employeeId: EMP, displayName: "Test Pro (sintético)", synthetic: true }];
  const absence: EmployeeAbsence = {
    id: "absence-boundaries-1",
    employeeId: EMP,
    kind: "absence",
    startDate: "2026-08-03",
    endDate: "2026-08-03",
    allDay: false,
    startMinutes: 9 * 60,
    endMinutes: 10 * 60,
    privateReason: SECRET_PRIVATE_REASON,
    source: "manual_override",
    approval: "approved",
    audit: audit(),
  };
  const capabilities: CapabilityMatrix = new Map([[EMP, new Set([0, 1, 2] as const)]]);
  const calendar: OperationalCalendar = {
    professionals,
    weeklySchedules: [
      { ownerKind: "employee", employeeId: EMP, dayOfWeek: 1, workDayStart: "09:00", workDayEnd: "17:00" },
    ],
    closures: [],
    venueRules: [],
    absences: [absence],
    overrides: [],
    reservations: [],
    slotMinutes: 30,
    bookingHorizonDays: 90,
    minimumLeadMinutes: 0,
  };
  return { ...calendar, capabilities };
}

function runBoundaryScenario() {
  const cal = calendarWithPrivateReason();
  const clock = fixedClock("2026-08-01", 9 * 60); // a Saturday, so "monday" below resolves to 2026-08-03
  const emitter = createCallEventEmitter();
  const store = createMemoryStore();
  const script: ConversationScript = {
    scenarioId: "A16-boundaries-check",
    callId: RAW_CALL_ID,
    turns: [
      { utterance: "quiero reservar una cita", day: "monday", time: "11:00", professionalId: EMP, serviceId: 1 },
      { serviceConfirmed: true },
      { bookingConfirmed: true },
    ],
  };
  const result = runConversation({ cal, clock, emitter, store, salt: "test-salt" }, script);
  return { result, emitter, store };
}

describe("boundaries: emitted events never carry personal data or the raw callId", () => {
  const { emitter, store } = runBoundaryScenario();
  const { pilot, internal } = emitter.all();
  const allEventsJSON = [...pilot, ...internal].map((e) => JSON.stringify(e));

  it("the booking actually happened (sanity check that events were produced at all)", () => {
    expect(pilot.length).toBeGreaterThan(0);
    expect(pilot.some((e) => e.eventName === "OUTCOME_EMITTED")).toBe(true);
  });

  it("no emitted event (either stream) contains the raw callId anywhere", () => {
    expect(allEventsJSON.some((json) => json.includes(RAW_CALL_ID))).toBe(false);
  });

  it("no emitted event contains the EmployeeAbsence.privateReason secret", () => {
    expect(allEventsJSON.some((json) => json.includes(SECRET_PRIVATE_REASON))).toBe(false);
  });

  it("every event's callIdHash is a 64-character lowercase hex SHA-256 digest", () => {
    for (const event of [...pilot, ...internal]) {
      expect(event.callIdHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("no event object carries a blacklisted personal-data key (e.g. displayName never leaks; employeeId is used instead)", () => {
    const blacklist = [
      "phone",
      "telefono",
      "name",
      "nombre",
      "apellido",
      "email",
      "transcript",
      "audio",
      "recording",
      "grabacion",
      "address",
      "direccion",
      "dni",
      "nif",
    ];
    function walk(value: unknown): void {
      if (value === null || value === undefined || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = key.toLowerCase();
        if (normalized !== "eventname") {
          for (const banned of blacklist) {
            expect(normalized.includes(banned)).toBe(false);
          }
        }
        walk(child);
      }
    }
    for (const event of [...pilot, ...internal]) walk(event);
  });

  it("the memory store also never records the raw callId or the privateReason secret", () => {
    const snapshot = store.snapshot();
    const snapshotJSON = JSON.stringify(snapshot);
    expect(snapshotJSON.includes(RAW_CALL_ID)).toBe(false);
    expect(snapshotJSON.includes(SECRET_PRIVATE_REASON)).toBe(false);
  });
});

describe("boundaries: assertNoPersonalData itself", () => {
  it("throws on a rogue displayName key nested inside detail", async () => {
    const { assertNoPersonalData } = await import("../../src/callEngine/events/schema.js");
    expect(() => assertNoPersonalData({ detail: { displayName: "Álex (sintético)" } })).toThrow();
  });

  it("does not throw on the frozen envelope's own field names (eventName, etc.)", async () => {
    const { assertNoPersonalData } = await import("../../src/callEngine/events/schema.js");
    expect(() =>
      assertNoPersonalData({
        schemaVersion: "1.0.0",
        eventId: "evt-00000001",
        eventName: "CALL_STARTED",
        synthetic: true,
      }),
    ).not.toThrow();
  });

  it("throws on a top-level phone-like key", async () => {
    const { assertNoPersonalData } = await import("../../src/callEngine/events/schema.js");
    expect(() => assertNoPersonalData({ callerPhoneNumber: "555" })).toThrow();
  });
});
