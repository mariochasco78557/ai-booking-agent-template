import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import type { FastifyInstance } from "fastify";

import { buildConsoleServer, readBrandAsset, startConsoleServer } from "../../src/console/server.js";
import { CONSOLE_HOST, DEFAULT_CONSOLE_PORT, loadConsoleConfig, requireConsoleEnabled } from "../../src/console/config.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY, demoSalonVenue } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createMemoryStore } from "../../src/callEngine/store/memoryStore.js";
import { createCallEventEmitter } from "../../src/callEngine/events/emitter.js";
import { hashCallId } from "../../src/callEngine/events/emitter.js";
import { loadUiClientHooks } from "./uiClientExtract.js";

const TEST_SALT = "console-test-salt";

function freshApp(): FastifyInstance {
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    // Mismo "hoy" sintético que la consola en producción de demo: MARTES
    // 2026-08-04, 09:00 (step 14, decisión D4). El anterior, 2026-08-02,
    // era domingo y el local cierra los domingos.
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
  });
}

async function getSnapshot(app: FastifyInstance): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: "GET", url: "/api/snapshot" });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Strips `generatedAt` (a real wall-clock timestamp, never meant to be stable across calls) before a structural comparison. */
function stable(snapshot: Record<string, unknown>): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...rest } = snapshot;
  return rest;
}

/**
 * (step 14 repair, defecto B) Pide al sistema operativo un puerto efímero
 * libre en 127.0.0.1: se abre un socket con puerto 0 (el SO elige uno
 * libre), se lee qué puerto tocó y se cierra inmediatamente. Nunca devuelve
 * 3000 — ese puerto pertenece a un proceso ajeno de esta máquina y esta
 * suite no debe tocarlo jamás.
 */
async function findFreePortOn127001(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address !== "object") {
        probe.close(() => reject(new Error("no se pudo reservar un puerto efímero en 127.0.0.1")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------
// (1)/(2) GET / — banner + security headers.
// ---------------------------------------------------------------------

describe("console: GET / — banner and security headers", () => {
  it("(1) responds 200 and contains the permanent Spanish banner", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Demo local · Datos sintéticos · No producción");
    await app.close();
  });

  it("(D6, step 14 repair) el pie de la barra lateral refleja el puerto REAL con el que arrancó el servidor, no el puerto por defecto", async () => {
    const defaultApp = freshApp();
    const defaultRes = await defaultApp.inject({ method: "GET", url: "/" });
    expect(defaultRes.body).toContain(`Local · ${CONSOLE_HOST}:${String(DEFAULT_CONSOLE_PORT)}`);
    await defaultApp.close();

    const CUSTOM_PORT = 19999;
    const customApp = buildConsoleServer({
      store: createMemoryStore(),
      emitter: createCallEventEmitter(),
      clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
      salt: TEST_SALT,
      port: CUSTOM_PORT,
    });
    const customRes = await customApp.inject({ method: "GET", url: "/" });
    expect(customRes.body).toContain(`Local · ${CONSOLE_HOST}:${String(CUSTOM_PORT)}`);
    // El puerto por defecto no debe quedar como un resto de un literal viejo.
    expect(customRes.body).not.toContain(`:${String(DEFAULT_CONSOLE_PORT)}`);
    await customApp.close();
  });

  it("(D6, step 14 repair) startConsoleServer() — el arranque REAL de producción — propaga el puerto configurado al pie renderizado, no sólo a listen()", async () => {
    // El test anterior sólo ejerce buildConsoleServer({port}) vía .inject():
    // nunca demuestra que la línea que de verdad conecta la config real con
    // el servidor en producción (server.ts, `startConsoleServer`:
    // `buildConsoleServer({ port: config.port })`) siga pasando ese
    // argumento. Este test arranca `startConsoleServer` de verdad —el único
    // punto de entrada que un proceso real usa— con su propia configuración
    // de entorno, y comprueba el pie renderizado con `.inject()` (que no
    // necesita el socket real ya escuchando). Usa un puerto efímero elegido
    // por el sistema operativo, nunca 3000, y lo libera siempre en `finally`.
    const port = await findFreePortOn127001();
    expect(port).not.toBe(3000);

    const started = await startConsoleServer({
      CALL_ENGINE_CONSOLE_ENABLED: "true",
      CALL_ENGINE_CONSOLE_PORT: String(port),
    });
    try {
      expect(started.config.port).toBe(port);
      expect(started.config.host).toBe(CONSOLE_HOST);
      const res = await started.app.inject({ method: "GET", url: "/" });
      expect(res.body).toContain(`Local · ${CONSOLE_HOST}:${String(port)}`);
      // Ni rastro del puerto por defecto (4310), que sería lo que quedaría
      // si `buildConsoleServer()` se llamara sin el `port` real de la config.
      expect(res.body).not.toContain(`:${String(DEFAULT_CONSOLE_PORT)}`);
    } finally {
      await started.app.close();
    }
  });

  it("(2) every response carries the CSP and the three other security headers", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/" });
    // step 14 decisión D1: se añade EXACTAMENTE `img-src 'self'` para que el
    // logotipo y el favicon puedan pintarse. La comprobación sigue siendo de
    // igualdad exacta, así que cualquier otro ensanchamiento futuro (`data:`,
    // `blob:`, un origen remoto) la rompe igual que antes.
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self'",
    ]) {
      expect(String(res.headers["content-security-policy"])).toContain(directive);
    }
    expect(String(res.headers["content-security-policy"])).not.toContain("data:");
    expect(String(res.headers["content-security-policy"])).not.toContain("unsafe-inline");
    expect(String(res.headers["content-security-policy"])).not.toContain("*");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    await app.close();
  });

  it("(2a) la CSP cierra además las tres directivas que `default-src` NO cubre (revisión adversarial, N2)", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = String(res.headers["content-security-policy"]);
    // `frame-ancestors`, `base-uri` y `form-action` no heredan de
    // `default-src`: sin ellas, `default-src 'none'` no dice nada sobre
    // quién puede meter esta página en un marco, ni sobre un `<base>`
    // inyectado, ni sobre a dónde puede enviarse un formulario.
    for (const directive of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
      expect(csp, `falta la directiva ${directive}`).toContain(directive);
    }
    // Y no se ha aflojado nada por el camino.
    expect(csp).not.toContain("data:");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("*");
    await app.close();
  });

  it("(2b) /app.js is served with a JS content type and the same security headers", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    await app.close();
  });
});

// ---------------------------------------------------------------------
// (3)/(5)/(6) /api/snapshot — the privacy boundary.
// ---------------------------------------------------------------------

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "generatedAt",
  "banner",
  "engineToday",
  "engineNowMinutes",
  "metrics",
  "calls",
  "reservations",
  "availabilityQueries",
  "humanQueue",
  "errors",
  "eventCounts",
  "calendar",
  // step 17: LA ÚNICA clave nueva de primer nivel que el diseño §6.3
  // autoriza. Se añade aquí, y sólo ella: la prueba sigue fallando ante
  // cualquier otra clave inesperada, que es lo que defiende.
  "waitlist",
  // step 18 (enmienda declarada, diseño §2.10): la SEGUNDA clave nueva de
  // primer nivel que este proyecto autoriza — inasistencias anotadas a
  // mano, reloj sintético, métricas derivadas e invariantes de integridad.
  // Igual que arriba: se añade ésta y sólo ésta, y la prueba sigue fallando
  // ante cualquier otra clave inesperada.
  "operations",
  // step 19 (diseño §6.4, §10.1.1): la TERCERA y última clave nueva de
  // primer nivel — el espacio de evaluación para Bruno (resumen 3A y guion en
  // pantalla 3B), enteramente resuelto en el servidor. Se añade ésta y sólo
  // ésta.
  "demo",
]);

const PERSONAL_DATA_KEY_SUBSTRINGS = [
  "phone",
  "telefono",
  "telephone",
  "msisdn",
  "name",
  "nombre",
  "apellido",
  "email",
  "transcript",
  "transcripcion",
  "audio",
  "recording",
  "grabacion",
  "address",
  "direccion",
  "dni",
  "nif",
];

function normalizeKey(key: string): string {
  return key
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function collectOffendingKeys(value: unknown, path = "$"): string[] {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectOffendingKeys(item, `${path}[${i}]`));
  }
  const offenders: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    for (const banned of PERSONAL_DATA_KEY_SUBSTRINGS) {
      if (normalized.includes(banned)) offenders.push(`${path}.${key} (matches "${banned}")`);
    }
    offenders.push(...collectOffendingKeys(child, `${path}.${key}`));
  }
  return offenders;
}

describe("console: /api/snapshot only ever returns whitelisted fields", () => {
  it("(3) the top-level shape is exactly the documented whitelist", async () => {
    const app = freshApp();
    const snap = await getSnapshot(app);
    for (const key of Object.keys(snap)) {
      expect(KNOWN_TOP_LEVEL_KEYS.has(key)).toBe(true);
    }
    await app.close();
  });

  it("(4) an absence's privateReason never appears in the snapshot", async () => {
    const app = freshApp();
    const SECRET = "SECRET-MEDICAL-REASON-NEVER-IN-THE-CONSOLE";
    const publishRes = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "absence-console-test-1",
          employeeId: 3,
          absenceKind: "absence",
          startDate: "2026-08-10",
          endDate: "2026-08-10",
          allDay: true,
          privateReason: SECRET,
        },
        resolutions: {},
      },
    });
    expect(publishRes.statusCode).toBe(200);

    const snapRes = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapRes.body.includes(SECRET)).toBe(false);
    const snap = snapRes.json();
    expect((snap.calendar.absences as Array<{ id: string }>).some((a) => a.id === "absence-console-test-1")).toBe(
      true,
    );
    await app.close();
  });

  it("(5) the raw callId never appears, but its salted hash does", async () => {
    const app = freshApp();
    const RAW_CALL_ID = "RAW-CALL-ID-MUST-NEVER-APPEAR-IN-THE-CONSOLE";
    const runRes = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A01-console-privacy-check",
        callId: RAW_CALL_ID,
        turns: [{ utterance: "quiero consultar disponibilidad", day: "wednesday", time: "10:00", professionalId: 3, serviceId: 1 }],
      },
    });
    expect(runRes.statusCode).toBe(200);

    const snapRes = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapRes.body.includes(RAW_CALL_ID)).toBe(false);
    const expectedHash = hashCallId(RAW_CALL_ID, TEST_SALT);
    expect(snapRes.body.includes(expectedHash)).toBe(true);
    await app.close();
  });

  it("(6) no key anywhere in the snapshot matches the personal-data blacklist", async () => {
    const app = freshApp();
    // Populate every section (calls, reservations, calendar exceptions) so the
    // scan has real content to walk, not just empty arrays.
    await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A01-console-blacklist-check",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "wednesday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "absence-blacklist-1",
          employeeId: 6,
          absenceKind: "vacation",
          startDate: "2026-08-11",
          endDate: "2026-08-11",
          allDay: true,
        },
        resolutions: {},
      },
    });
    const snap = await getSnapshot(app);
    const offenders = collectOffendingKeys(snap);
    expect(offenders).toEqual([]);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// (7) No innerHTML anywhere under src/console/.
// ---------------------------------------------------------------------

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("console: no innerHTML anywhere in src/console/", () => {
  it("(7) grepping every file on disk under src/console/ (comments stripped) finds no innerHTML", () => {
    const dir = join(process.cwd(), "src", "console");
    const files = readdirSync(dir)
      .filter((f) => statSync(join(dir, f)).isFile())
      .map((f) => join(dir, f));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => stripComments(readFileSync(f, "utf8")).includes("innerHTML"));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// (8) /api/reset.
// ---------------------------------------------------------------------

describe("console: /api/reset leaves the state exactly as at the beginning", () => {
  it("(8) reset() produces a snapshot structurally identical to a fresh server's", async () => {
    const baselineApp = freshApp();
    const baseline = stable(await getSnapshot(baselineApp));
    await baselineApp.close();

    const app = freshApp();
    await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A01-console-reset-check",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "wednesday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    const dirtied = await getSnapshot(app);
    expect(dirtied.calls).not.toEqual(baseline.calls);

    const resetRes = await app.inject({ method: "POST", url: "/api/reset" });
    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.json()).toEqual({ ok: true });

    const afterReset = stable(await getSnapshot(app));
    expect(afterReset).toEqual(baseline);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// (9)/(10)/(11) Calendar preview/publish invariants.
// ---------------------------------------------------------------------

describe("console: calendar preview/publish never silently mutate or cancel a reservation", () => {
  it("(9) /api/calendar/preview never mutates the calendar", async () => {
    const app = freshApp();
    await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A01-console-preview-purity",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "wednesday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    const before = stable(await getSnapshot(app));

    const previewRes = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: { changeKind: "venue_closure", id: "cierre-preview-purity", startDate: "2026-08-05", endDate: "2026-08-05" },
    });
    expect(previewRes.statusCode).toBe(200);
    expect((previewRes.json().impacted as unknown[]).length).toBeGreaterThan(0);

    const after = stable(await getSnapshot(app));
    expect(after).toEqual(before);
    await app.close();
  });

  it("(10) /api/calendar/publish WITHOUT resolutions applies nothing (409, unresolved list, calendar unchanged)", async () => {
    const app = freshApp();
    await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A01-console-publish-gate",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "wednesday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    const before = stable(await getSnapshot(app));

    const publishRes = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-sin-resolver", startDate: "2026-08-05", endDate: "2026-08-05" },
        resolutions: {},
      },
    });
    expect(publishRes.statusCode).toBe(409);
    expect(publishRes.json().applied).toBe(false);
    expect((publishRes.json().unresolved as unknown[]).length).toBeGreaterThan(0);

    const after = stable(await getSnapshot(app));
    expect(after).toEqual(before);
    await app.close();
  });

  it("(11) /api/calendar/publish WITH every resolution applies the change and cancels NO reservation", async () => {
    const app = freshApp();
    const runRes = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A01-console-publish-with-resolution",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "wednesday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    const reservationId = (runRes.json().reservation as { id: string }).id;

    const previewRes = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: { changeKind: "venue_closure", id: "cierre-con-resolucion", startDate: "2026-08-05", endDate: "2026-08-05" },
    });
    expect((previewRes.json().impacted as Array<{ reservationId: string }>).some((r) => r.reservationId === reservationId)).toBe(
      true,
    );

    const publishRes = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-con-resolucion", startDate: "2026-08-05", endDate: "2026-08-05" },
        resolutions: { [reservationId]: "keep_and_flag" },
      },
    });
    expect(publishRes.statusCode).toBe(200);
    // `flaggedForHumanContact` lists the reservations the operator resolved
    // as needing a call. Empty here because this test resolves with
    // `keep_and_flag`; see the dedicated test for the other resolution.
    expect(publishRes.json()).toEqual({ applied: true, unresolved: [], flaggedForHumanContact: [] });

    const snap = await getSnapshot(app);
    expect((snap.calendar as { closures: Array<{ id: string }> }).closures.some((c) => c.id === "cierre-con-resolucion")).toBe(
      true,
    );
    const reservation = (snap.reservations as Array<{ id: string; status: string }>).find((r) => r.id === reservationId);
    expect(reservation).toBeDefined();
    expect(reservation?.status).toBe("confirmed");
    await app.close();
  });
});

// ---------------------------------------------------------------------
// (12) Configuration: loopback host + explicit fail-closed when disabled.
// ---------------------------------------------------------------------

describe("console: configuration is loopback-only and fails closed when disabled", () => {
  it("(12a) loadConsoleConfig always resolves host to 127.0.0.1, defaults enabled=false and port=4310", () => {
    const config = loadConsoleConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.host).toBe(CONSOLE_HOST);
    expect(config.enabled).toBe(false);
    expect(config.port).toBe(DEFAULT_CONSOLE_PORT);
    expect(config.port).toBe(4310);
  });

  it("(12b) requireConsoleEnabled throws an explicit, readable error when the switch is off", () => {
    const config = loadConsoleConfig({ CALL_ENGINE_CONSOLE_ENABLED: "false" });
    expect(() => requireConsoleEnabled(config)).toThrow(/desactivada/i);
  });

  it("(12c) requireConsoleEnabled does not throw once explicitly enabled", () => {
    const config = loadConsoleConfig({ CALL_ENGINE_CONSOLE_ENABLED: "true" });
    expect(() => requireConsoleEnabled(config)).not.toThrow();
  });

  it("(12d) an explicit CALL_ENGINE_CONSOLE_PORT is honoured, host stays 127.0.0.1 regardless", () => {
    const config = loadConsoleConfig({ CALL_ENGINE_CONSOLE_ENABLED: "true", CALL_ENGINE_CONSOLE_PORT: "5555" });
    expect(config.port).toBe(5555);
    expect(config.host).toBe("127.0.0.1");
  });
});

// ---------------------------------------------------------------------
// (13) No console route reads/requires any middleware credential.
// ---------------------------------------------------------------------

describe("console: no route requires or reads any middleware credential", () => {
  it("(13a) GET /api/snapshot succeeds with zero headers", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("(13b) supplying an arbitrary Authorization / webhook-secret header changes nothing", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/snapshot",
      headers: { authorization: "Bearer not-a-real-token", "x-ai-webhook-secret": "not-a-real-secret" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// Loopback guard — defence in depth beyond `listen({ host: "127.0.0.1" })`.
// ---------------------------------------------------------------------

describe("console: onRequest loopback guard", () => {
  it("rejects a request whose remote address is not loopback", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/api/snapshot", remoteAddress: "203.0.113.5" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("accepts a request whose remote address is loopback (the default for .inject())", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/api/snapshot", remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  /**
   * (Revisión de seguridad de la fase 7, aviso 2) La dirección de origen no
   * basta: en un ataque de re-vinculación de DNS, la petición SALE de
   * loopback —la hace el navegador de la propia máquina— pero la cabecera
   * `Host` lleva el dominio del atacante, que es lo que le permite saltarse
   * la política de mismo origen y leer o mutar la demostración. Un cliente de
   * loopback de verdad manda siempre un `Host` de loopback, así que la lista
   * blanca es estrictamente más estricta y no rompe a nadie.
   */
  it("rechaza con 403 una petición cuyo Host es un dominio ajeno, aunque venga de loopback", async () => {
    const app = freshApp();
    for (const host of ["evil.example.com", "attacker.test:4390", "booking.example.com"]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/snapshot",
        remoteAddress: "127.0.0.1",
        headers: { host },
      });
      expect(res.statusCode, `Host: ${host}`).toBe(403);
      // Y no ha contestado con la instantánea: el cuerpo es el del rechazo.
      expect(res.json()).toHaveProperty("error");
      expect(JSON.stringify(res.json())).not.toContain("banner");
    }
    await app.close();
  });

  /**
   * (Recomprobación de seguridad sobre `b7a0180`) La lista blanca miraba sólo
   * el PREFIJO del `Host`: la forma con corchetes devolvía todo hasta el `]`
   * y tiraba el resto sin mirarlo, y la forma con dos puntos no comprobaba
   * que lo que sigue sea un puerto de verdad. Así, `[::1].evil.com` o
   * `localhost:4390@evil.com` pasaban con 200. No es explotable —un navegador
   * no puede componer esas cadenas en un ataque de re-vinculación, y un
   * cliente local arbitrario ya podría mandar `Host: localhost`— pero una
   * lista blanca que acepta basura detrás del nombre no es una lista blanca.
   */
  it("rechaza un Host de loopback con basura detrás: se valida la cabecera ENTERA, no su prefijo", async () => {
    const app = freshApp();
    const colados = [
      "[::1].evil.com",
      "[::1]evil.com",
      "[::1]@evil.com",
      "[::1]:4390.evil.com",
      "localhost:4390@evil.com",
      "127.0.0.1:evil.com",
      "localhost:notaport",
      "localhost:4390:4391",
    ];
    for (const host of colados) {
      const res = await app.inject({
        method: "GET",
        url: "/api/snapshot",
        remoteAddress: "127.0.0.1",
        headers: { host },
      });
      expect(res.statusCode, `Host: ${host}`).toBe(403);
    }
    await app.close();
  });

  it("acepta los Host de loopback, con y sin puerto, incluida la forma IPv6", async () => {
    const app = freshApp();
    for (const host of [
      "localhost",
      "localhost:4390",
      "LOCALHOST:4390",
      "127.0.0.1",
      "127.0.0.1:4390",
      "[::1]",
      "[::1]:4390",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/snapshot",
        remoteAddress: "127.0.0.1",
        headers: { host },
      });
      expect(res.statusCode, `Host: ${host}`).toBe(200);
    }
    await app.close();
  });

  it("y las cuatro cabeceras de seguridad viajan también en el rechazo por Host", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress: "127.0.0.1",
      headers: { host: "evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    await app.close();
  });
});

// ---------------------------------------------------------------------
// Punto ciego que encontró la auditoría de seguridad de la fase 9: las
// pruebas de consola usaban identificadores válidos ("A01-console-*")
// mientras la propia interfaz sugería otros ("console-demo-01") que el
// esquema del piloto rechaza. Ninguna prueba afirmaba nunca un desenlace
// CORRECTO, así que las 20 pruebas pasaban con la consola inservible: todo
// escenario lanzado desde la interfaz colapsaba en un fallo técnico
// fabricado, sin turnos y sin dejar rastro.
// ---------------------------------------------------------------------
describe("Ejecutar un escenario desde la consola tiene que funcionar de verdad", () => {
  it("una reserva correcta termina en RESUELVE/BOOKING_CONFIRMED, con turnos y reserva", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A20-console-reserva-concreta",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "wednesday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json() as Record<string, unknown>;
    expect(result.outcome).toBe("RESUELVE");
    expect(result.reasonCode).toBe("BOOKING_CONFIRMED");
    // Sin esto la prueba pasaría igualmente con el colapso silencioso.
    expect((result.turns as unknown[]).length).toBeGreaterThan(0);
    expect(result.finalState).not.toBe("INICIO");

    const snapshot = await getSnapshot(app);
    const reservations = (snapshot.reservations ?? []) as unknown[];
    expect(reservations.length).toBe(1);
    await app.close();
  });

  it("todos los identificadores de escenario que la propia interfaz sugiere son aceptados", async () => {
    // Lee la interfaz del disco: si alguien vuelve a poner un identificador
    // que el esquema del piloto rechaza, esta prueba lo caza.
    const uiJs = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const uiHtml = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const suggested = [
      ...[...uiJs.matchAll(/scenarioId:\s*'([^']+)'/g)].map((m) => m[1]),
      ...[...uiHtml.matchAll(/id="campo-scenario-id"[^>]*value="([^"]+)"/g)].map((m) => m[1]),
    ];
    expect(suggested.length).toBeGreaterThan(0);

    const app = freshApp();
    for (const scenarioId of suggested) {
      const res = await app.inject({
        method: "POST",
        url: "/api/scenario/run",
        payload: { scenarioId, turns: [{ utterance: "quiero saber qué huecos hay", day: "wednesday" }] },
      });
      expect(res.statusCode, `identificador rechazado: ${scenarioId}`).toBe(200);
      const result = res.json() as Record<string, unknown>;
      expect(result.finalState, `colapso silencioso con: ${scenarioId}`).not.toBe("INICIO");
    }
    await app.close();
  });

  it("un identificador que no sigue el patrón se rechaza con 400, no con un fallo técnico fingido", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: { scenarioId: "console-demo-01", turns: [{ utterance: "hola" }] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("resolver como 'llamar al cliente' encola de verdad una acción humana", async () => {
    const app = freshApp();
    await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A25-console-para-impacto",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "wednesday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    const before = await getSnapshot(app);
    const reservationId = ((before.reservations ?? []) as { id: string }[])[0]?.id;
    expect(reservationId).toBeTruthy();

    const change = {
      changeKind: "venue_closure" as const,
      id: "cierre-impacto",
      startDate: "2026-08-05",
      endDate: "2026-08-05",
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: { change, resolutions: { [reservationId as string]: "mark_for_human_contact" } },
    });
    expect(res.statusCode).toBe(200);

    const after = await getSnapshot(app);
    const tasks = ((after.humanQueue as Record<string, unknown>)?.tasks ?? []) as { reason: string }[];
    expect(tasks.some((t) => t.reason === "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE")).toBe(true);
    // Y la reserva sigue exactamente donde estaba: resolver no es cancelar.
    const reservationsAfter = (after.reservations ?? []) as { id: string; status: string }[];
    expect(reservationsAfter.find((r) => r.id === reservationId)?.status).toBe("confirmed");
    await app.close();
  });
});

// ---------------------------------------------------------------------
// step 14 · W1 — activos de marca servidos por rutas explícitas.
// ---------------------------------------------------------------------

describe("consola: logotipo y favicon (step 14, decisión D1)", () => {
  it("GET /brand/logo.png devuelve los BYTES REALES del fichero versionado, no un cuerpo vacío", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/brand/logo.png" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(String(res.headers["cache-control"])).toContain("max-age=");

    const onDisk = readFileSync(join(process.cwd(), "assets", "brand", "demo-salon-logo.png"));
    expect(res.rawPayload.length).toBe(onDisk.length);
    expect(res.rawPayload.length).toBeGreaterThan(1000);
    expect(Buffer.compare(res.rawPayload, onDisk)).toBe(0);
    // Firma PNG: si alguien devolviera un texto de error con código 200, esto lo caza.
    expect([...res.rawPayload.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await app.close();
  });

  it("el alias /brand/demo-salon-logo.png (el que escribió la especificación) sirve exactamente lo mismo", async () => {
    const app = freshApp();
    const a = await app.inject({ method: "GET", url: "/brand/logo.png" });
    const b = await app.inject({ method: "GET", url: "/brand/demo-salon-logo.png" });
    expect(b.statusCode).toBe(200);
    expect(Buffer.compare(a.rawPayload, b.rawPayload)).toBe(0);
    await app.close();
  });

  it("el favicon es un glifo de interfaz 'TX', servido como SVG sin script", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/favicon.svg" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(res.body).toContain("TX");
    expect(res.body).not.toContain("<script");
    expect(res.body).not.toContain("foreignObject");
    // Un glifo tipográfico, nunca el logotipo oficial disfrazado de favicon.
    expect(res.body).not.toContain("demo-salon-logo");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });

  it("si el activo de marca faltara, la consola lo diría a gritos en vez de servir un cuerpo vacío", () => {
    expect(() => readBrandAsset(join(process.cwd(), "assets", "brand", "no-existe-este-fichero.png"))).toThrow(
      /No se ha podido leer el activo de marca/,
    );
  });

  it("la propia página enlaza el favicon que el servidor sirve", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(html).toContain('href="/favicon.svg"');
  });
});

// ---------------------------------------------------------------------
// step 14 · W4 — el "hoy" del motor viaja en el snapshot.
// ---------------------------------------------------------------------

describe("consola: el snapshot dice qué día es PARA EL MOTOR (decisión D4)", () => {
  it("engineToday y engineNowMinutes son los del reloj inyectado, no los del portátil", async () => {
    const app = freshApp();
    const snap = await getSnapshot(app);
    expect(snap.engineToday).toBe("2026-08-04");
    expect(snap.engineNowMinutes).toBe(9 * 60);
    await app.close();

    // Y el reloj se inyecta DE VERDAD: con otro reloj, el snapshot dice otro
    // día y otra hora. Si alguien sustituyera el reloj fijo por `new Date()`,
    // esta comprobación lo vería.
    //
    // Antes esto se comprobaba contra la fecha real del portátil
    // (`expect(snap.engineToday).not.toBe(new Date()...)`), lo que convertía la
    // prueba en una bomba de relojería: fallaba el único día del año en que el
    // portátil coincide con el "hoy" sintético, y el 2026-08-04 llegó. Inyectar
    // un segundo reloj demuestra lo mismo con más fuerza —que el valor SIGUE al
    // reloj, no sólo que difiere de una fecha cualquiera— y no depende de qué
    // día se ejecute la suite (step 16).
    const otroReloj = buildConsoleServer({
      store: createMemoryStore(),
      emitter: createCallEventEmitter(),
      clock: fixedClock("2026-09-15", 11 * 60 + 30),
      salt: TEST_SALT,
    });
    const snapOtro = await getSnapshot(otroReloj);
    expect(snapOtro.engineToday).toBe("2026-09-15");
    expect(snapOtro.engineNowMinutes).toBe(11 * 60 + 30);
    await otroReloj.close();
  });

  it("el martes 2026-08-04 tiene agenda de verdad, y el lunes 2026-08-03 está cerrado", async () => {
    const app = freshApp();
    const snap = await getSnapshot(app);
    const calendar = snap.calendar as { reservations: Array<{ date: string }>; seasonalSchedules: unknown[] };
    expect(calendar.reservations.filter((r) => r.date === "2026-08-04").length).toBeGreaterThanOrEqual(5);
    expect(calendar.seasonalSchedules.length).toBeGreaterThan(0);

    // Reservar un lunes no puede salir bien: el local cierra los lunes.
    const res = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A40-lunes-cerrado",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "monday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
            bookingConfirmed: true,
          },
        ],
      },
    });
    const result = res.json() as Record<string, unknown>;
    expect(result.reasonCode).not.toBe("BOOKING_CONFIRMED");
    expect(result.announcesSuccess).toBe(false);
    expect(result.reservation).toBeUndefined();
    await app.close();
  });
});

// ---------------------------------------------------------------------
// step 14 · W5 — cómo acabó cada llamada, y los contadores de Inicio.
// ---------------------------------------------------------------------

interface CallView {
  scenarioId: string;
  outcome?: string;
  reasonCode?: string;
  internalReasonCode?: string;
  countsAsNotUnderstood?: boolean;
  countsAsUnderstoodIntent?: boolean;
  countsAsBookingConversion?: boolean;
  countsAsContained?: boolean;
  announcesSuccess?: boolean;
}

async function runScenario(app: FastifyInstance, payload: Record<string, unknown>): Promise<void> {
  const res = await app.inject({ method: "POST", url: "/api/scenario/run", payload });
  expect(res.statusCode).toBe(200);
}

describe("consola: el snapshot dice cómo acabó cada llamada (decisión D5)", () => {
  it("una reserva confirmada trae outcome, códigos y las tres booleanas de métrica", async () => {
    const app = freshApp();
    await runScenario(app, {
      scenarioId: "A41-reserva-ok",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "wednesday",
          time: "10:00",
          professionalId: 3,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
        },
      ],
    });
    const snap = await getSnapshot(app);
    const call = (snap.calls as CallView[])[0];
    expect(call?.outcome).toBe("RESUELVE");
    expect(call?.reasonCode).toBe("BOOKING_CONFIRMED");
    expect(call?.internalReasonCode).toBe("BOOKING_CONFIRMED");
    expect(call?.countsAsBookingConversion).toBe(true);
    expect(call?.countsAsContained).toBe(true);
    expect(call?.countsAsUnderstoodIntent).toBe(true);
    expect(call?.countsAsNotUnderstood).toBe(false);
    expect(call?.announcesSuccess).toBe(true);
    await app.close();
  });

  it("una llamada sin el sí final NO cuenta como resuelta, y el código congelado sigue siendo el de siempre", async () => {
    const app = freshApp();
    await runScenario(app, {
      scenarioId: "A42-sin-confirmacion",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "wednesday",
          time: "10:00",
          professionalId: 3,
          serviceId: 1,
          serviceConfirmed: true,
        },
      ],
    });
    const snap = await getSnapshot(app);
    const call = (snap.calls as CallView[])[0];
    // El flujo congelado del piloto no se toca: sigue viendo INTENT_NOT_UNDERSTOOD.
    expect(call?.reasonCode).toBe("INTENT_NOT_UNDERSTOOD");
    // El refinamiento interno sí dice la verdad.
    expect(call?.internalReasonCode).toBe("BOOKING_NOT_CONFIRMED");
    expect(call?.countsAsNotUnderstood).toBe(false);
    expect(call?.countsAsContained).toBe(false);
    const metrics = snap.metrics as Record<string, number>;
    expect(metrics.resolvedWithoutHumanInterruption).toBe(0);
    expect(metrics.bookingsCreated).toBe(0);
    // D2 (step 14 repair): BOOKING_NOT_CONFIRMED produces NO attention card
    // on Inicio (ui.js.ts's callAttentionEntry excludes it deliberately —
    // see actionFor(), which already said "Nada" for this exact call), so
    // needsAttention must agree and count zero here. Before the repair this
    // asserted 1, pinning the very disagreement the mission's defect D2
    // reports (server said 4 needed attention on 6 live calls, the screen
    // showed 3 cards): this line encoded the bug, not the requirement.
    expect(metrics.needsAttention).toBe(0);
    await app.close();
  });

  it("un fallo técnico no cuenta ni como entendido ni como no entendido: no demuestra nada sobre comprensión", async () => {
    const app = freshApp();
    await runScenario(app, {
      scenarioId: "A43-fallo-tecnico",
      turns: [
        {
          utterance: "quiero reservar una cita",
          day: "wednesday",
          time: "11:00",
          professionalId: 3,
          serviceId: 1,
          serviceConfirmed: true,
          bookingConfirmed: true,
          injectFailure: true,
        },
      ],
    });
    const snap = await getSnapshot(app);
    const call = (snap.calls as CallView[])[0];
    expect(call?.internalReasonCode).toBe("TECHNICAL_FAILURE");
    expect(call?.countsAsNotUnderstood).toBe(false);
    expect(call?.countsAsUnderstoodIntent).toBe(false);
    expect((snap.metrics as Record<string, number>).technicalErrors).toBe(1);
    await app.close();
  });

  it("los contadores de Inicio los calcula el servidor, y cuadran con las llamadas", async () => {
    const app = freshApp();
    await runScenario(app, {
      scenarioId: "A44-reserva-ok",
      turns: [
        { utterance: "quiero reservar una cita", day: "wednesday", time: "10:00", professionalId: 3, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true },
      ],
    });
    await runScenario(app, {
      scenarioId: "A45-consulta",
      turns: [
        { utterance: "quiero consultar disponibilidad", day: "wednesday", time: "12:00", professionalId: 3, serviceId: 1, serviceConfirmed: true },
      ],
    });
    await runScenario(app, {
      scenarioId: "A46-urgencia",
      turns: [{ utterance: "es urgente, necesito ayuda humana ya", urgent: true }],
      liveTransferAvailable: true,
    });
    const snap = await getSnapshot(app);
    const calls = snap.calls as CallView[];
    const metrics = snap.metrics as Record<string, number>;
    expect(metrics.callsHandled).toBe(3);
    expect(metrics.callsHandled).toBe(calls.length);
    expect(metrics.callsWithOutcome).toBe(3);
    expect(metrics.bookingsCreated).toBe(calls.filter((c) => c.countsAsBookingConversion === true).length);
    expect(metrics.bookingsCreated).toBe(1);
    expect(metrics.resolvedWithoutHumanInterruption).toBe(calls.filter((c) => c.countsAsContained === true).length);
    expect(metrics.resolvedWithoutHumanInterruption).toBe(2);
    expect(metrics.needsAttention).toBe(1);
    expect(metrics.technicalErrors).toBe(0);
    expect(metrics.staffInterruptions).toBe(1);
    await app.close();
  });

  it("D2 (step 14 repair): metrics.needsAttention cuenta EXACTAMENTE lo mismo que produciría la regla de tarjetas de atención de la UI", async () => {
    const app = freshApp();
    // Reproduce a propósito la forma del defecto original (6 llamadas,
    // servidor decía 4, la pantalla pintaba 3 tarjetas): dos RESUELVE, una
    // BOOKING_NOT_CONFIRMED (entendida pero sin confirmación — NO produce
    // tarjeta), y tres que sí deben producir tarjeta (urgencia, fallo
    // técnico, privacidad).
    await runScenario(app, {
      scenarioId: "A50-reserva-ok",
      turns: [
        { utterance: "quiero reservar una cita", day: "wednesday", time: "10:00", professionalId: 3, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true },
      ],
    });
    await runScenario(app, {
      scenarioId: "A51-consulta",
      turns: [
        { utterance: "quiero consultar disponibilidad", day: "wednesday", time: "12:00", professionalId: 3, serviceId: 1, serviceConfirmed: true },
      ],
    });
    await runScenario(app, {
      scenarioId: "A52-sin-confirmacion",
      turns: [
        { utterance: "quiero reservar una cita", day: "wednesday", time: "13:00", professionalId: 3, serviceId: 1, serviceConfirmed: true },
      ],
    });
    await runScenario(app, {
      scenarioId: "A53-urgencia",
      turns: [{ utterance: "es urgente, necesito ayuda humana ya", urgent: true }],
      liveTransferAvailable: true,
    });
    await runScenario(app, {
      scenarioId: "A54-fallo-tecnico",
      turns: [
        { utterance: "quiero reservar una cita", day: "wednesday", time: "15:00", professionalId: 3, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true, injectFailure: true },
      ],
    });
    await runScenario(app, {
      scenarioId: "A55-privacidad",
      turns: [
        { utterance: "quiero reservar una cita", day: "wednesday", time: "16:00", professionalId: 3, serviceId: 1 },
        { serviceConfirmed: true, attemptsThirdPartyAccess: true },
      ],
    });

    const snap = await getSnapshot(app);
    const calls = snap.calls as CallView[];
    const metrics = snap.metrics as Record<string, number>;
    expect(calls.length).toBe(6);

    // LA FUNCIÓN REAL de ui.js.ts, ejecutada tal cual la sirve /app.js (ver
    // tests/console/uiClientExtract.ts) — NO una reimplementación a mano de
    // su regla dentro de esta prueba. Antes de este repaso la prueba traía
    // su PROPIA copia de las dos primeras guardas de callAttentionEntry, así
    // que un defecto que rompiera SÓLO esa función real (p. ej. borrar la
    // guarda de BOOKING_NOT_CONFIRMED en ui.js.ts:437) habría dejado al
    // servidor y a la UI divergir exactamente como en el defecto original,
    // sin que ningún test se enterara — la "prueba de fijación" habría
    // seguido en verde comparando la copia de la prueba contra sí misma.
    const { callAttentionEntry } = loadUiClientHooks();
    const uiAttentionCount = calls.filter((c) => callAttentionEntry(c, snap) !== null).length;

    expect(uiAttentionCount).toBe(3);
    expect(metrics.needsAttention).toBe(uiAttentionCount);
    // Y, sin dejarlo implícito: la vieja fórmula (todo lo que no fuese
    // RESUELVE) habría dado 4 — el defecto D2 exacto del informe de la
    // misión.
    expect(calls.filter((c) => c.outcome !== undefined && c.outcome !== "RESUELVE").length).toBe(4);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// step 14 · W6 — la cola humana no enseña identificadores de escenario.
// ---------------------------------------------------------------------

interface TaskView {
  id: string;
  reason: string;
  reasonKind: string;
  reasonLabel: string;
}

describe("consola: la cola de acciones humanas se clasifica en el servidor (decisión D6)", () => {
  it("una derivación de llamada se etiqueta 'Devolver la llamada', nunca con el identificador del escenario", async () => {
    const app = freshApp();
    await runScenario(app, {
      scenarioId: "A47-console-urgencia",
      turns: [{ utterance: "es urgente, necesito ayuda humana ya", urgent: true }],
      liveTransferAvailable: false,
    });
    const snap = await getSnapshot(app);
    const tasks = (snap.humanQueue as { tasks: TaskView[] }).tasks;
    expect(tasks.length).toBeGreaterThan(0);
    const task = tasks[0] as TaskView;
    expect(task.reasonKind).toBe("CALLBACK_FROM_CALL");
    expect(task.reasonLabel).toBe("Devolver la llamada");
    // El identificador técnico sigue disponible para Laboratorio, pero NO es la etiqueta.
    expect(task.reason).toBe("A47-console-urgencia");
    expect(task.reasonLabel).not.toContain("A47");
    await app.close();
  });

  it("un cambio de calendario resuelto como 'llamar al cliente' se etiqueta con su propio motivo", async () => {
    const app = freshApp();
    await runScenario(app, {
      scenarioId: "A48-para-impacto",
      turns: [
        { utterance: "quiero reservar una cita", day: "wednesday", time: "10:00", professionalId: 3, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true },
      ],
    });
    const before = await getSnapshot(app);
    const reservationId = ((before.reservations ?? []) as { id: string }[])[0]?.id as string;
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-etiqueta", startDate: "2026-08-05", endDate: "2026-08-05" },
        resolutions: { [reservationId]: "mark_for_human_contact" },
      },
    });
    expect(res.statusCode).toBe(200);
    const snap = await getSnapshot(app);
    const tasks = (snap.humanQueue as { tasks: TaskView[] }).tasks;
    const task = tasks.find((t) => t.reasonKind === "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE");
    expect(task?.reasonLabel).toBe("Llamar al cliente por un cambio de calendario");
    await app.close();
  });

  /**
   * *(Añadido 2026-08-06 tras revisión adversarial de misión completa,
   * hallazgo ALTO 1.)* La guarda `hasOpenHumanTask` (`server.ts`, revisión
   * adversarial de la capacidad 2, H1a) ya protegía este camino —
   * `POST /api/calendar/publish` mintiendo `contacto-<reservationId>` dos
   * veces mientras la primera sigue abierta— pero ninguna prueba lo
   * ejercitaba: la única prueba de H1a existente (`tests/console/tareasHumanas.test.ts`)
   * cubre el camino de la lista de espera (`decidir-hueco-<slotKey>`), nunca
   * el de una publicación de calendario. Aquí se publican DOS cambios
   * DISTINTOS (dos cierres del local, mismo día, ids distintos) que
   * impactan la MISMA reserva, y las DOS veces se resuelve «llamar al
   * cliente»: sin la guarda, la segunda alta produciría una fila `contacto-`
   * ABIERTA duplicada y `pendingHumanTasks` contaría dos donde sólo hay un
   * recado real. El runbook del Mac (§22) ya afirma que «dos altas del
   * mismo id mientras la primera sigue abierta se colapsan en una sola
   * fila»: esta prueba es lo que hace esa frase verificable, no sólo cierta
   * por lectura del código.
   */
  it("dos publicaciones de calendario que impactan la MISMA reserva, ambas resueltas como «llamar al cliente», abren UNA sola tarea — nunca dos (hallazgo ALTO 1)", async () => {
    const app = freshApp();
    await runScenario(app, {
      scenarioId: "A50-h1a-dos-publicaciones",
      turns: [
        { utterance: "quiero reservar una cita", day: "wednesday", time: "10:00", professionalId: 3, serviceId: 1, serviceConfirmed: true, bookingConfirmed: true },
      ],
    });
    const before = await getSnapshot(app);
    const reservationId = ((before.reservations ?? []) as { id: string }[])[0]?.id as string;
    expect(reservationId).toBeTruthy();
    const taskId = `contacto-${reservationId}`;

    for (const closureId of ["cierre-h1a-uno", "cierre-h1a-dos"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/publish",
        payload: {
          change: { changeKind: "venue_closure", id: closureId, startDate: "2026-08-05", endDate: "2026-08-05" },
          resolutions: { [reservationId]: "mark_for_human_contact" },
        },
      });
      expect(res.statusCode, `publicación ${closureId} rechazada`).toBe(200);
    }

    const snap = await getSnapshot(app);
    const filasDelMismoId = (snap.humanQueue as { tasks: Array<TaskView & { open: boolean }> }).tasks.filter(
      (t) => t.id === taskId,
    );
    expect(filasDelMismoId).toHaveLength(1);
    expect(filasDelMismoId[0]?.open).toBe(true);
    expect((snap.metrics as { pendingHumanTasks: number }).pendingHumanTasks).toBe(1);
    await app.close();
  });

  it("ninguna etiqueta de la cola es nunca un identificador de escenario", async () => {
    const app = freshApp();
    await runScenario(app, {
      scenarioId: "A49-console-ayuda",
      turns: [{ utterance: "quiero hablar con una persona por una duda" }],
      liveTransferAvailable: false,
    });
    const snap = await getSnapshot(app);
    for (const task of (snap.humanQueue as { tasks: TaskView[] }).tasks) {
      expect(task.reasonLabel).not.toMatch(/^A\d{2}-/);
      expect(["CALLBACK_FROM_CALL", "REVIEW_ORPHANED_SYNTHETIC_RESERVATION", "CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE", "UNKNOWN"]).toContain(
        task.reasonKind,
      );
    }
    await app.close();
  });
});

// ---------------------------------------------------------------------
// La frontera de privacidad, otra vez, ahora que el snapshot es más ancho.
// ---------------------------------------------------------------------

describe("consola: privateReason no aparece por ninguna vía, ni como clave ni como valor", () => {
  it("ni la clave `privateReason` ni el valor secreto llegan al snapshot ampliado", async () => {
    const app = freshApp();
    const SECRET = "SECRETO-QUE-NUNCA-DEBE-SALIR-DEL-SERVIDOR";
    const publishRes = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "ausencia-privacidad-w5",
          employeeId: 9,
          absenceKind: "absence",
          startDate: "2026-08-12",
          endDate: "2026-08-12",
          allDay: true,
          privateReason: SECRET,
        },
        resolutions: {},
      },
    });
    expect(publishRes.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(res.body.includes(SECRET)).toBe(false);
    expect(res.body.toLowerCase().includes("privatereason")).toBe(false);

    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== "object") return;
      if (Array.isArray(v)) {
        v.forEach(walk);
        return;
      }
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        keys.push(k);
        walk(child);
      }
    };
    walk(res.json());
    expect(keys.filter((k) => k.toLowerCase().includes("private"))).toEqual([]);
    // La ausencia sí está: lo que se oculta es el motivo, no el hecho.
    const snap = res.json();
    expect((snap.calendar.absences as Array<{ id: string }>).some((a) => a.id === "ausencia-privacidad-w5")).toBe(true);
    await app.close();
  });

  it("la interfaz nunca envía privateReason (Anexo B.5 del diseño)", () => {
    const uiJs = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const uiHtml = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(uiJs.includes("privateReason")).toBe(false);
    expect(uiHtml.includes("privateReason")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// step 14 · Paso 9 — comprobaciones sugeridas por DESIGN_SPEC.md §12.
// ---------------------------------------------------------------------

describe("consola: reglas duras del rediseño (step 14)", () => {
  it("ui.css.ts no contiene ningún bloque de tema oscuro (prefers-color-scheme / color-scheme)", () => {
    // Se comprueba sobre el CSS SERVIDO (CONSOLE_CSS), no sobre el fichero .ts
    // en disco: éste lleva un docblock TypeScript que documenta la regla
    // usando las mismas palabras que prohíbe, igual que hace el test (7).
    const css = readFileSync(join(process.cwd(), "src/console/ui.css.ts"), "utf8");
    const cssBody = stripComments(css);
    expect(cssBody).not.toContain("prefers-color-scheme");
    expect(cssBody).not.toContain("color-scheme");
  });

  it("ui.js.ts no usa innerHTML, insertAdjacentHTML, document.write, eval, new Function ni estilo en línea (.style.)", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const jsBody = stripComments(js);
    expect(jsBody).not.toContain("innerHTML");
    expect(jsBody).not.toContain("insertAdjacentHTML");
    expect(jsBody).not.toContain("document.write");
    expect(jsBody).not.toContain("eval(");
    expect(jsBody).not.toContain("new Function");
    expect(jsBody).not.toContain(".style.");
  });

  it("ui.html.ts no contiene ningún atributo style=\"...\" ni bloque <style>", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    const htmlBody = stripComments(html);
    expect(htmlBody).not.toMatch(/\sstyle\s*=/);
    expect(htmlBody).not.toContain("<style");
    expect(htmlBody).not.toContain("<script>"); // sólo <script src="/app.js"> externo
  });

  it("ui.html.ts contiene, como texto estático, la insignia obligatoria y no depende de ningún script para existir", () => {
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(html).toContain("Demo local · Datos sintéticos · No producción");
  });

  it("nunca se muestra un número de latencia: la única mención vive en Laboratorio y dice que no se mide", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(html).toContain("No se mide en esta demostración");
    // La palabra "latencia" sólo aparece en la nota de Laboratorio (ui.html.ts), nunca en ui.js.ts.
    expect(stripComments(js).toLowerCase()).not.toContain("latencia");
  });

  it("ninguna vista operativa muestra un importe: nunca aparece el símbolo €, y 'precio' sólo aparece una vez, como traducción literal del intento ASK_PRICE (§8.9)", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    const html = readFileSync(join(process.cwd(), "src/console/ui.html.ts"), "utf8");
    expect(js).not.toContain("€");
    expect(html).not.toContain("€");
    expect(html.toLowerCase()).not.toContain("precio");
    const priceMatches = js.match(/precio/gi) ?? [];
    expect(priceMatches.length).toBe(1);
    expect(js).toContain("Preguntar un precio");
  });

  it("las etiquetas de servicio vienen de domain/types.ts (SERVICE_LABELS interpolado), no de una copia duplicada", () => {
    const js = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");
    // La fuente ya no declara su propio literal { 0: 'Barba', ... }: lo importa e interpola.
    expect(js).toContain('import { SERVICE_LABELS } from "../callEngine/domain/types.js"');
    expect(js).not.toContain("0: 'Barba'");
  });

  it("GET / sirve una página que contiene las seis secciones ocultas y los tres diálogos, sin abrir ningún puerto real", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    for (const id of ["vista-inicio", "vista-agenda", "vista-llamadas", "vista-equipo", "vista-laboratorio"]) {
      expect(res.body).toContain(`id="${id}"`);
    }
    // REAPERTURA §R1/§R2 y §7.1 — la Oleada A2 dejó esta línea aceptando las
    // dos orillas (`vista-calendario` O `vista-horarios-y-ausencias`) para no
    // tener que coordinarse con la Oleada B. Ya no hace falta: la migración ha
    // aterrizado y la aserción se ENDURECE al nombre nuevo, con el candado de
    // que el viejo no puede volver. Los identificadores internos
    // `calendario-*` de dentro de la sección sí se conservan (§R1, F7).
    expect(res.body).toContain('id="vista-horarios-y-ausencias"');
    expect(res.body).not.toContain('id="vista-calendario"');
    expect(res.body).toContain('id="calendario-grid-body"');
    for (const id of ["dialogo-dia-especial", "dialogo-ausencia", "dialogo-reset"]) {
      expect(res.body).toContain(`id="${id}"`);
    }
    await app.close();
  });

  it("GET /app.css no referencia ninguna fuente externa ni un origen remoto", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/app.css" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("http://");
    expect(res.body).not.toContain("https://");
    expect(res.body).not.toContain("@font-face");
    await app.close();
  });

  it("GET /app.js no contiene ninguna URL remota ni un data: URI de imagen", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("http://");
    expect(res.body).not.toContain("https://");
    expect(res.body).not.toContain("data:image");
    await app.close();
  });
});

// ---------------------------------------------------------------------
// step 15 — `hidden` tiene que esconder de verdad. La regla del navegador
// para `[hidden]` es la de menor especificidad que existe, así que cualquier
// `display:` de una clase la anulaba: `.tx-call-detail { display: flex }`
// dejaba `#llamada-detalle` a la vista, con sus encabezados vacíos, aunque
// el router lo hubiera ocultado.
// ---------------------------------------------------------------------

describe("consola: el atributo hidden esconde de verdad (step 15)", () => {
  it("el CSS servido declara una regla genérica [hidden] con display:none que no puede anular ninguna clase", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/app.css" });
    expect(res.statusCode).toBe(200);
    const rule = /(?:^|\n)\s*\[hidden\]\s*\{([^}]*)\}/.exec(res.body);
    expect(rule, "no hay ninguna regla [hidden] { ... } en el CSS servido").not.toBeNull();
    expect(rule?.[1]).toContain("display: none");
    expect(rule?.[1]).toContain("!important");
    await app.close();
  });

  it("#llamada-detalle sigue llegando con su atributo hidden en el HTML servido", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const tag = /<article[^>]*id="llamada-detalle"[^>]*>/.exec(res.body);
    expect(tag, "no se ha encontrado la etiqueta de #llamada-detalle").not.toBeNull();
    expect(tag?.[0]).toMatch(/\shidden(\s|>)/);
    await app.close();
  });

  // REAPERTURA §R13 — el aviso de retirada apagado no debe reservar caja: su
  // `hidden` significa "este aviso no va en esta pantalla", no "vacío", así
  // que le toca la excepción de `display: none !important` (ver el comentario
  // de ui.css.ts junto a `.tx-status-line[hidden]`), no el `visibility: hidden`
  // genérico de `.tx-status-line[hidden]` que sí reserva `min-height`.
  it("#dia-especial-aviso-retirada y #ausencia-aviso-retirada están en la lista de excepciones que colapsa la caja al estar hidden (no dejan hueco en blanco)", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/app.css" });
    expect(res.statusCode).toBe(200);
    for (const id of ["dia-especial-aviso-retirada", "ausencia-aviso-retirada"]) {
      const anchor = res.body.indexOf(`#${id}[hidden]`);
      expect(anchor, `no se ha encontrado #${id}[hidden] en el CSS servido`).toBeGreaterThan(-1);
      const closingBrace = res.body.indexOf("}", anchor);
      const declaration = res.body.slice(anchor, closingBrace);
      expect(declaration).toContain("display: none");
      expect(declaration).toContain("!important");
    }
    await app.close();
  });
});

describe("consola: el anillo de foco (step 15)", () => {
  it("existe, es :focus-visible y no se apaga en ningún sitio", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: "/app.css" });
    expect(res.statusCode).toBe(200);
    const cssBody = stripComments(res.body);
    // El indicador sigue existiendo y sigue siendo :focus-visible — nunca
    // :focus a secas, que se lo dibujaría también a quien usa el ratón.
    expect(cssBody).toContain(":focus-visible");
    // Y nunca se apaga: DESIGN_SPEC §9 pedía este grep "obligatorio en
    // revisión", que es justo la clase de comprobación que se olvida hacer.
    expect(cssBody).not.toMatch(/outline\s*:\s*none/);
    expect(cssBody).not.toMatch(/outline\s*:\s*0(\s|;)/);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// step 16, O4 — lo que el ratón ya hacía (abrir y cerrar el detalle de una
// llamada) sigue funcionando y sigue cableado a las MISMAS funciones que las
// pruebas de teclado ejercitan por su cuenta (uiClientLogic.test.ts). El
// clic real y el Enter/Espacio nativos sólo se pueden comprobar en el Mac —
// ver el runbook de la fase 3D —, pero el cableado en el código fuente es
// verificable aquí, sin navegador.
// ---------------------------------------------------------------------

describe("consola: cableado de teclado y ratón (step 16, O3/O4, comportamientos 1 y 7 del encargo)", () => {
  const uiJs = readFileSync(join(process.cwd(), "src/console/ui.js.ts"), "utf8");

  it("comportamiento 1: el control 'Ver' de cada fila es un <a href> real, no un <span> ni un <div> con onclick — enfocable por definición", () => {
    expect(uiJs).toContain("var a = el('a', 'tx-row-link', 'Ver');");
    expect(uiJs).toContain("link.href = '#/llamadas/' + call.callIdHash;");
  });

  it("comportamiento 7: el botón 'Cerrar' del detalle está enganchado a closeCallDetail() — la MISMA función que Escape dispara", () => {
    expect(uiJs).toContain("byId('llamada-detalle-cerrar').addEventListener('click', closeCallDetail);");
  });
});

// ---------------------------------------------------------------------
// D1 (step 14 repair) — POST /api/scenario/run must return
// `internalReasonCode` itself: without it, the Laboratorio panel could not
// show the correct value even after its own client-side bug was fixed.
// ---------------------------------------------------------------------

describe("consola: POST /api/scenario/run devuelve internalReasonCode (D1)", () => {
  it("una llamada BOOKING_NOT_CONFIRMED trae internalReasonCode: 'BOOKING_NOT_CONFIRMED' en la respuesta, junto al reasonCode congelado sin tocar", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scenario/run",
      payload: {
        scenarioId: "A56-console-sin-confirmacion",
        turns: [
          {
            utterance: "quiero reservar una cita",
            day: "wednesday",
            time: "10:00",
            professionalId: 3,
            serviceId: 1,
            serviceConfirmed: true,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // (a) el flujo congelado del piloto sigue igual — no se toca.
    expect(body.reasonCode).toBe("INTENT_NOT_UNDERSTOOD");
    // (b) el refinamiento interno SÍ viaja en la respuesta, y dice la
    // verdad: el motor entendió la llamada, solo faltó el sí final.
    expect(body.internalReasonCode).toBe("BOOKING_NOT_CONFIRMED");
    expect(body.countsAsNotUnderstood).toBe(false);
    expect(body.countsAsBookingConversion).toBe(false);
    expect(body.countsAsContained).toBe(false);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// step 26 REAPERTURA §R11 — la nota operativa: se escribe, se lee, y
// `privateReason` sigue sin salir por ninguna vía.
// ---------------------------------------------------------------------

describe("REAPERTURA §R11 — nota operativa en AuditStamp.note (P23)", () => {
  it("una nota enviada al publicar un cierre llega al snapshot dentro del sello de auditoría", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "venue_closure",
          id: "cierre-con-nota",
          startDate: "2026-08-10",
          endDate: "2026-08-10",
          note: "se anuló la reforma",
        },
        resolutions: {},
      },
    });
    expect(res.statusCode).toBe(200);
    const snap = await getSnapshot(app);
    const cierre = (snap.calendar as { closures: Array<{ id: string; audit: { note?: string; createdBy: string } }> }).closures.find(
      (c) => c.id === "cierre-con-nota",
    );
    expect(cierre?.audit.note).toBe("se anuló la reforma");
    expect(cierre?.audit.createdBy).toBe("console-operator");
    await app.close();
  });

  it("la nota se recorta, y una de sólo espacios no escribe nada", async () => {
    const app = freshApp();
    await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-nota-espacios", startDate: "2026-08-10", endDate: "2026-08-10", note: "   " },
        resolutions: {},
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "ausencia-nota-recortada",
          employeeId: 3,
          absenceKind: "vacation",
          startDate: "2026-08-11",
          endDate: "2026-08-11",
          allDay: true,
          note: "  formación fuera del local  ",
        },
        resolutions: {},
      },
    });
    const snap = await getSnapshot(app);
    const cierre = (snap.calendar as { closures: Array<{ id: string; audit: { note?: string } }> }).closures.find(
      (c) => c.id === "cierre-nota-espacios",
    );
    expect(cierre).toBeDefined();
    expect(cierre?.audit.note).toBeUndefined();
    const ausencia = (snap.calendar as { absences: Array<{ id: string; audit: { note?: string } }> }).absences.find(
      (a) => a.id === "ausencia-nota-recortada",
    );
    expect(ausencia?.audit.note).toBe("formación fuera del local");
    await app.close();
  });

  it("una nota de 281 caracteres se rechaza con 400; una de 280 se acepta entera, sin recorte silencioso", async () => {
    const app = freshApp();
    const demasiado = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: { changeKind: "venue_closure", id: "cierre-nota-larga", startDate: "2026-08-10", endDate: "2026-08-10", note: "á".repeat(281) },
    });
    expect(demasiado.statusCode).toBe(400);

    const justo = "b".repeat(280);
    const aceptada = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-nota-280", startDate: "2026-08-10", endDate: "2026-08-10", note: justo },
        resolutions: {},
      },
    });
    expect(aceptada.statusCode).toBe(200);
    const snap = await getSnapshot(app);
    const cierre = (snap.calendar as { closures: Array<{ id: string; audit: { note?: string } }> }).closures.find(
      (c) => c.id === "cierre-nota-280",
    );
    expect(cierre?.audit.note).toBe(justo);
    await app.close();
  });

  it("el día especial también admite nota, y sigue siendo `special_opening` (nunca «cierre parcial»)", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "special_opening",
          id: "especial-con-nota",
          date: "2026-08-13",
          specialOpen: "10:00",
          specialClose: "14:00",
          note: "feria del barrio",
        },
        resolutions: {},
      },
    });
    expect(res.statusCode).toBe(200);
    const snap = await getSnapshot(app);
    const regla = (snap.calendar as { venueRules: Array<{ id: string; kind: string; closed: boolean; audit: { note?: string } }> }).venueRules.find(
      (r) => r.id === "especial-con-nota",
    );
    expect(regla?.kind).toBe("special_opening");
    expect(regla?.closed).toBe(false);
    expect(regla?.audit.note).toBe("feria del barrio");
    await app.close();
  });

  it("la nota NO abre una vía para privateReason: publicando las dos, sólo sale la nota", async () => {
    const app = freshApp();
    const SECRETO = "SECRETO-MEDICO-QUE-NUNCA-SALE-R11";
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: {
          changeKind: "employee_absence",
          id: "ausencia-nota-y-secreto",
          employeeId: 3,
          absenceKind: "absence",
          startDate: "2026-08-12",
          endDate: "2026-08-12",
          allDay: true,
          privateReason: SECRETO,
          note: "vuelve el lunes",
        },
        resolutions: {},
      },
    });
    expect(res.statusCode).toBe(200);
    const snapRes = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapRes.body.includes(SECRETO)).toBe(false);
    expect(snapRes.body.includes("privateReason")).toBe(false);
    expect(snapRes.body.includes("vuelve el lunes")).toBe(true);
    await app.close();
  });
});

// ---------------------------------------------------------------------
// step 26 REAPERTURA §R13 — RETIRADA: los dos endpoints, y la guarda de
// identificador duplicado del alta.
// ---------------------------------------------------------------------

const DIA_ESPECIAL = "2026-08-05";
const ALEX = 3;

/**
 * Una consola cuyo calendario ya tiene publicada una APERTURA ESPECIAL
 * (10:00–22:00 el 2026-08-05) y una cita a las 20:00 dentro de ella. Es el
 * caso que demuestra que retirar un día especial PUEDE romper una cita: sin
 * la regla, el local cierra a las 17:30 (horario de agosto) y esa cita se
 * queda fuera. Se inyecta como calendario inicial —no se publica desde una
 * prueba— para que el escenario sea exactamente éste y no dependa de nada más.
 */
function appConAperturaEspecial(): FastifyInstance {
  const base = demoSalonVenue();
  const audit = { createdAt: "2026-07-01T09:00:00", createdBy: "quien-lo-apunto", approvedAt: "2026-07-01T09:00:00", approvedBy: "quien-lo-apunto" };
  return buildConsoleServer({
    store: createMemoryStore(),
    emitter: createCallEventEmitter(),
    clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    salt: TEST_SALT,
    initialCalendar: {
      ...base,
      venueRules: [
        {
          id: "especial-nocturno",
          kind: "special_opening",
          scope: "venue",
          date: DIA_ESPECIAL,
          closed: false,
          specialOpen: "10:00",
          specialClose: "22:00",
          source: "manual_override",
          approval: "approved",
          audit,
        },
      ],
      reservations: [
        ...base.reservations,
        {
          id: "res-nocturna",
          employeeId: ALEX,
          serviceId: 1,
          date: DIA_ESPECIAL,
          startMinutes: 20 * 60,
          endMinutes: 20 * 60 + 30,
          status: "confirmed",
          synthetic: true,
        },
      ],
    },
  });
}

describe("REAPERTURA §R13 — POST /api/calendar/withdrawal/preview", () => {
  it("(P20) retirar una apertura especial AVISA de la cita que dejaría de caber", async () => {
    const app = appConAperturaEspecial();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/preview",
      payload: { targetKind: "venue_rule", id: "especial-nocturno" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().impacted).toEqual([
      {
        reservationId: "res-nocturna",
        employeeId: ALEX,
        date: DIA_ESPECIAL,
        startMinutes: 1200,
        endMinutes: 1230,
        serviceId: 1,
      },
    ]);
    await app.close();
  });

  it("previsualizar una retirada NO muta nada", async () => {
    const app = appConAperturaEspecial();
    const antes = stable(await getSnapshot(app));
    await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/preview",
      payload: { targetKind: "venue_rule", id: "especial-nocturno" },
    });
    expect(stable(await getSnapshot(app))).toEqual(antes);
    await app.close();
  });

  it("un identificador que no existe se contesta 404 en castellano, no con un impacto de cero", async () => {
    const app = appConAperturaEspecial();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/preview",
      payload: { targetKind: "venue_closure", id: "no-existe" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("No hay ningún cambio con ese identificador.");
    await app.close();
  });

  it("un cuerpo inválido —tipo desconocido, campo de más, id vacío— se rechaza con 400", async () => {
    const app = appConAperturaEspecial();
    for (const payload of [
      { targetKind: "employee_override", id: "lo-que-sea" },
      { targetKind: "venue_rule" },
      { targetKind: "venue_rule", id: "" },
      { targetKind: "venue_rule", id: "especial-nocturno", sobra: true },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/calendar/withdrawal/preview", payload });
      expect(res.statusCode, `cuerpo aceptado indebidamente: ${JSON.stringify(payload)}`).toBe(400);
      expect(res.json().error).toBe("Retirada de calendario inválida");
    }
    await app.close();
  });
});

describe("REAPERTURA §R13 — POST /api/calendar/withdrawal/publish", () => {
  it("(P19) sin resoluciones no aplica NADA: 409, lista de pendientes, calendario intacto", async () => {
    const app = appConAperturaEspecial();
    const antes = stable(await getSnapshot(app));
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: { target: { targetKind: "venue_rule", id: "especial-nocturno" }, resolutions: {} },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().applied).toBe(false);
    expect((res.json().unresolved as Array<{ reservationId: string }>).map((r) => r.reservationId)).toEqual([
      "res-nocturna",
    ]);
    expect(stable(await getSnapshot(app))).toEqual(antes);
    await app.close();
  });

  it("(P21) con todas las resoluciones marca `rejected`, CONSERVA la fila, no cancela ninguna cita y encola la llamada", async () => {
    const app = appConAperturaEspecial();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: {
        target: { targetKind: "venue_rule", id: "especial-nocturno" },
        resolutions: { "res-nocturna": "mark_for_human_contact" },
        note: "se anuló la feria",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true, unresolved: [], flaggedForHumanContact: ["res-nocturna"] });

    const snap = await getSnapshot(app);
    const reglas = (snap.calendar as { venueRules: Array<{ id: string; approval: string; audit: Record<string, string> }> }).venueRules;
    expect(reglas).toHaveLength(1);
    expect(reglas[0]?.approval).toBe("rejected");
    // El sello dice quién lo apuntó y quién lo retiró, y lleva la nota.
    expect(reglas[0]?.audit.createdBy).toBe("quien-lo-apunto");
    expect(reglas[0]?.audit.approvedBy).toBe("console-operator");
    expect(reglas[0]?.audit.note).toBe("se anuló la feria");
    // La cita sigue confirmada, exactamente donde estaba.
    const cita = (snap.calendar as { reservations: Array<{ id: string; status: string; startMinutes: number }> }).reservations.find(
      (r) => r.id === "res-nocturna",
    );
    expect(cita?.status).toBe("confirmed");
    expect(cita?.startMinutes).toBe(1200);
    // Y hay UNA tarea humana abierta, con el mismo dedupe del alta.
    const tareas = (snap.humanQueue as { tasks: Array<{ id: string; reasonKind: string }> }).tasks.filter(
      (t) => t.id === "contacto-res-nocturna",
    );
    expect(tareas).toHaveLength(1);
    expect(tareas[0]?.reasonKind).toBe("CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE");
    await app.close();
  });

  it("la retirada deja su frase en el historial de calendario, con la nota si la hay", async () => {
    const app = appConAperturaEspecial();
    await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: {
        target: { targetKind: "venue_rule", id: "especial-nocturno" },
        resolutions: { "res-nocturna": "keep_and_flag" },
        note: "se anuló la feria",
      },
    });
    const snap = await getSnapshot(app);
    const linea = (snap.calendar as { auditLog: string[] }).auditLog.find((l) => l.startsWith("Retirada de"));
    expect(linea).toBeDefined();
    expect(linea).toContain("día especial 'especial-nocturno'");
    expect(linea).toContain("por consola-operador");
    expect(linea).toContain("1 resolución(es) aplicada(s)");
    expect(linea).toContain("0 pendiente(s) de llamar al cliente");
    expect(linea).toContain("Nota: «se anuló la feria».");
    await app.close();
  });

  it("(P27) retirar dos veces el mismo identificador: la segunda es 404, y nada cambia", async () => {
    const app = appConAperturaEspecial();
    const primera = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: {
        target: { targetKind: "venue_rule", id: "especial-nocturno" },
        resolutions: { "res-nocturna": "keep_and_flag" },
      },
    });
    expect(primera.statusCode).toBe(200);
    const despuesDeLaPrimera = stable(await getSnapshot(app));

    const segunda = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: { target: { targetKind: "venue_rule", id: "especial-nocturno" }, resolutions: {} },
    });
    expect(segunda.statusCode).toBe(404);
    expect(segunda.json().error).toBe("No hay ningún cambio con ese identificador.");
    expect(stable(await getSnapshot(app))).toEqual(despuesDeLaPrimera);
    await app.close();
  });

  it("retirar un cierre de local que no impacta a nadie sale a la primera, con 0 resoluciones", async () => {
    const app = freshApp();
    const alta = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-retirable", startDate: "2026-08-20", endDate: "2026-08-20" },
        resolutions: {},
      },
    });
    expect(alta.statusCode).toBe(200);

    const preview = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/preview",
      payload: { targetKind: "venue_closure", id: "cierre-retirable" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().impacted).toEqual([]);

    const publish = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: { target: { targetKind: "venue_closure", id: "cierre-retirable" }, resolutions: {} },
    });
    expect(publish.statusCode).toBe(200);
    const snap = await getSnapshot(app);
    const cierres = (snap.calendar as { closures: Array<{ id: string; approval: string }> }).closures.filter(
      (c) => c.id === "cierre-retirable",
    );
    expect(cierres).toHaveLength(1);
    expect(cierres[0]?.approval).toBe("rejected");
    await app.close();
  });

  it("una nota de retirada de más de 280 caracteres se rechaza con 400", async () => {
    const app = appConAperturaEspecial();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: {
        target: { targetKind: "venue_rule", id: "especial-nocturno" },
        resolutions: { "res-nocturna": "keep_and_flag" },
        note: "z".repeat(281),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Retirada de calendario inválida");
    await app.close();
  });
});

describe("REAPERTURA §R13 — (P22) el alta rechaza un identificador ya aprobado", () => {
  it("publicar dos veces el mismo id devuelve 409 en castellano y NO deja dos filas", async () => {
    const app = freshApp();
    const cambio = { changeKind: "venue_closure", id: "cierre-repetido", startDate: "2026-08-20", endDate: "2026-08-20" };
    expect((await app.inject({ method: "POST", url: "/api/calendar/publish", payload: { change: cambio, resolutions: {} } })).statusCode).toBe(200);

    const segunda = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: { change: cambio, resolutions: {} },
    });
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json().applied).toBe(false);
    expect(segunda.json().error).toBe("Ya hay un cambio apuntado con ese nombre. Ponle otro.");

    const snap = await getSnapshot(app);
    expect((snap.calendar as { closures: Array<{ id: string }> }).closures.filter((c) => c.id === "cierre-repetido")).toHaveLength(1);
    await app.close();
  });

  it("una vez RETIRADO, ese mismo id se puede volver a apuntar: la guarda mira lo aprobado, no el historial", async () => {
    const app = freshApp();
    const cambio = { changeKind: "venue_closure", id: "cierre-vuelve", startDate: "2026-08-20", endDate: "2026-08-20" };
    await app.inject({ method: "POST", url: "/api/calendar/publish", payload: { change: cambio, resolutions: {} } });
    await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: { target: { targetKind: "venue_closure", id: "cierre-vuelve" }, resolutions: {} },
    });
    const tercera = await app.inject({ method: "POST", url: "/api/calendar/publish", payload: { change: cambio, resolutions: {} } });
    expect(tercera.statusCode).toBe(200);
    const snap = await getSnapshot(app);
    const filas = (snap.calendar as { closures: Array<{ id: string; approval: string }> }).closures.filter((c) => c.id === "cierre-vuelve");
    expect(filas.map((c) => c.approval).sort()).toEqual(["approved", "rejected"]);
    await app.close();
  });

  it("la guarda es por tipo: un día especial y una ausencia pueden compartir nombre con un cierre", async () => {
    const app = freshApp();
    const nombre = "el-mismo-nombre";
    const cierre = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: { change: { changeKind: "venue_closure", id: nombre, startDate: "2026-08-20", endDate: "2026-08-20" }, resolutions: {} },
    });
    expect(cierre.statusCode).toBe(200);
    const especial = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: { change: { changeKind: "special_opening", id: nombre, date: "2026-08-21", specialOpen: "10:00", specialClose: "14:00" }, resolutions: {} },
    });
    expect(especial.statusCode).toBe(200);
    await app.close();
  });
});

// =====================================================================
// step 26 REAPERTURA · REVISIÓN ADVERSARIAL — LA PUERTA DE RESOLUCIONES,
// EL 409 DE NOMBRE REPETIDO Y EL TOPE DE LA NOTA.
//
// V3-5 · El historial contaba las resoluciones QUE VENÍAN EN LA PETICIÓN, no
//        las citas realmente afectadas: 500 resoluciones inventadas escribían
//        «500 resolución(es) aplicada(s)» junto a «0 pendiente(s)», un acta
//        que no describe nada de lo que pasó. Se cierra por los dos lados:
//        una resolución que no corresponde a ninguna cita afectada es un 400,
//        y la cuenta sale del informe de impacto.
// V3-2 · El 409 de nombre repetido mandaba «retira el que hay» cuando el
//        operador puede no tener ningún botón para hacerlo. El mensaje deja
//        de dar una instrucción que quizá no se puede seguir.
// V1-8/V3-11 · El tope de la nota se aplicaba ANTES del recorte y contaba
//        unidades UTF-16: 280 emojis (280 caracteres para quien escribe, 560
//        unidades para zod) se rechazaban con un mensaje en inglés.
// =====================================================================

describe("REAPERTURA · V3-5 — las resoluciones tienen que corresponder a citas realmente afectadas", () => {
  function resolucionesInventadas(cuantas: number): Record<string, string> {
    return Object.fromEntries(
      Array.from({ length: cuantas }, (_unused, i) => [`res-inventada-${String(i)}`, "keep_and_flag"]),
    );
  }

  it("el ALTA rechaza con 400 las resoluciones de citas que el cambio no afecta, y no publica nada", async () => {
    const app = freshApp();
    const antes = stable(await getSnapshot(app));
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue-inventado", id: "x", startDate: "2026-08-20", endDate: "2026-08-20" },
        resolutions: {},
      },
    });
    expect(res.statusCode).toBe(400); // control: el discriminante sigue mandando

    const conBasura = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-sin-impacto", startDate: "2026-09-20", endDate: "2026-09-20" },
        resolutions: resolucionesInventadas(500),
      },
    });
    expect(conBasura.statusCode).toBe(400);
    expect(conBasura.json().error).toBe("Hay resoluciones que no corresponden a ninguna cita afectada");
    expect(stable(await getSnapshot(app))).toEqual(antes);
    await app.close();
  });

  it("la RETIRADA hace lo mismo: 400, nada retirado, nada escrito en el historial", async () => {
    const app = appConAperturaEspecial();
    const antes = stable(await getSnapshot(app));
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: {
        target: { targetKind: "venue_rule", id: "especial-nocturno" },
        resolutions: { "res-nocturna": "keep_and_flag", ...resolucionesInventadas(500) },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Hay resoluciones que no corresponden a ninguna cita afectada");
    expect(stable(await getSnapshot(app))).toEqual(antes);
    await app.close();
  });

  it("el historial cuenta las citas AFECTADAS, no las claves que llegaron: un cambio sin impacto dice 0", async () => {
    const app = freshApp();
    await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: {
        change: { changeKind: "venue_closure", id: "cierre-sin-impacto", startDate: "2026-09-20", endDate: "2026-09-20" },
        resolutions: {},
      },
    });
    const snap = await getSnapshot(app);
    const linea = (snap.calendar as { auditLog: string[] }).auditLog.find((l) => l.startsWith("Cambio "));
    expect(linea).toContain("0 resolución(es) aplicada(s)");
    expect(linea).toContain("0 pendiente(s) de llamar al cliente");
    await app.close();
  });

  it("una resolución de una cita SÍ afectada sigue pasando, y se cuenta una", async () => {
    const app = appConAperturaEspecial();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: {
        target: { targetKind: "venue_rule", id: "especial-nocturno" },
        resolutions: { "res-nocturna": "keep_and_flag" },
      },
    });
    expect(res.statusCode).toBe(200);
    const snap = await getSnapshot(app);
    const linea = (snap.calendar as { auditLog: string[] }).auditLog.find((l) => l.startsWith("Retirada de"));
    expect(linea).toContain("1 resolución(es) aplicada(s)");
    await app.close();
  });
});

describe("REAPERTURA · V3-2 — el 409 de nombre repetido no manda hacer algo que quizá no se puede hacer", () => {
  it("el mensaje pide otro nombre y no ordena retirar nada", async () => {
    const app = freshApp();
    const cambio = { changeKind: "venue_closure", id: "cierre-repetido", startDate: "2026-08-20", endDate: "2026-08-20" };
    await app.inject({ method: "POST", url: "/api/calendar/publish", payload: { change: cambio, resolutions: {} } });
    const segunda = await app.inject({ method: "POST", url: "/api/calendar/publish", payload: { change: cambio, resolutions: {} } });
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json().error).toBe("Ya hay un cambio apuntado con ese nombre. Ponle otro.");
    await app.close();
  });
});

describe("REAPERTURA · V1-8/V3-11 — el tope de la nota se cuenta como lo cuenta quien escribe", () => {
  function cierreConNota(id: string, note: string): Record<string, unknown> {
    return { changeKind: "venue_closure", id, startDate: "2026-09-20", endDate: "2026-09-20", note };
  }

  it("280 emojis (280 caracteres, 560 unidades UTF-16) se aceptan; 281 se rechazan", async () => {
    const app = freshApp();
    const doscientosOchenta = "😀".repeat(280);
    expect(doscientosOchenta.length).toBe(560); // el tope viejo los contaba así
    const ok = await app.inject({
      method: "POST",
      url: "/api/calendar/publish",
      payload: { change: cierreConNota("cierre-nota-emoji", doscientosOchenta), resolutions: {} },
    });
    expect(ok.statusCode).toBe(200);
    const snap = await getSnapshot(app);
    expect(
      (snap.calendar as { closures: Array<{ id: string; audit: { note?: string } }> }).closures.find(
        (c) => c.id === "cierre-nota-emoji",
      )?.audit.note,
    ).toBe(doscientosOchenta);

    const ko = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: cierreConNota("cierre-nota-emoji-pasada", "😀".repeat(281)),
    });
    expect(ko.statusCode).toBe(400);
    await app.close();
  });

  it("el recorte va ANTES del tope: 280 caracteres rodeados de espacios entran", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: cierreConNota("cierre-nota-espacios-tope", `   ${"a".repeat(280)}   `),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("el mensaje de error del tope está en castellano y dice 280", async () => {
    const app = freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/preview",
      payload: cierreConNota("cierre-nota-larga-mensaje", "x".repeat(281)),
    });
    expect(res.statusCode).toBe(400);
    const issues = res.json().issues as string[];
    expect(issues.some((i) => i.includes("280"))).toBe(true);
    expect(issues.join(" ")).not.toMatch(/String must contain|at most|characters?\b/);
    await app.close();
  });

  it("la nota de la RETIRADA pasa por el mismo tope y el mismo mensaje", async () => {
    const app = appConAperturaEspecial();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: {
        target: { targetKind: "venue_rule", id: "especial-nocturno" },
        resolutions: { "res-nocturna": "keep_and_flag" },
        note: "😀".repeat(281),
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json().issues as string[]).some((i) => i.includes("280"))).toBe(true);

    const otra = appConAperturaEspecial();
    const buena = await otra.inject({
      method: "POST",
      url: "/api/calendar/withdrawal/publish",
      payload: {
        target: { targetKind: "venue_rule", id: "especial-nocturno" },
        resolutions: { "res-nocturna": "keep_and_flag" },
        note: `  ${"😀".repeat(280)}  `,
      },
    });
    expect(buena.statusCode).toBe(200);
    await app.close();
    await otra.close();
  });
});
