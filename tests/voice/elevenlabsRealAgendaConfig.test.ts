import { createServer } from "node:net";

import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  DEFAULT_AGENDA_HORIZON_DAYS,
  DEFAULT_AGENDA_TIMEOUT_MS,
  DEFAULT_AGENDA_TYPE_RESERVATION,
  loadElevenLabsBridgeAgendaMode,
  loadElevenLabsRealAgendaConfig,
} from "../../src/voice/elevenlabs/agenda/config.js";
import { ELEVENLABS_BRIDGE_HOST } from "../../src/voice/elevenlabs/config.js";
import { startElevenLabsBridge } from "../../src/voice/elevenlabs/main.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * BLOQUE C · LA PUERTA DE ARRANQUE DEL MODO real_readonly.
 *
 * Lo que se fija aquí no es que el modo real funcione, sino que NO ARRANQUE
 * cuando no debe, y que al negarse no cante nada. Tres invariantes:
 *
 *   1. Es opt-in: sin `ELEVENLABS_BRIDGE_AGENDA_MODE=real_readonly` el
 *      puente es el sintético de siempre.
 *   2. Falla cerrado: cualquier hueco en la configuración —credencial,
 *      autorización humana, URL— es un error de arranque, JAMÁS una caída
 *      silenciosa a la agenda sintética. Un operador que pidió agenda real
 *      y recibe fixture sin enterarse es el fallo peor de todos.
 *   3. Al fallar nombra la VARIABLE y nunca su VALOR.
 *
 * Ni una sola petición de red en todo el fichero: `nock.disableNetConnect()`
 * convierte cualquier descuido en un test rojo.
 * ────────────────────────────────────────────────────────────────────────
 */

const WEBHOOK_SECRET = "test-webhook-secret-32-characters-minimum";
const HASH_SALT = "test-call-hash-salt-32-characters-minimum";

/** Centinelas: si alguno aparece en un mensaje de error, la redacción falla. */
const SENTINEL_USER = "cuenta-de-servicio-de-prueba";
const SENTINEL_PASSWORD = "not-a-real-password";
const SENTINELS = [SENTINEL_USER, SENTINEL_PASSWORD] as const;

const UPSTREAM = "https://agenda-de-prueba.invalid";

function realEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED: "1",
    ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ELEVENLABS_CALL_HASH_SALT: HASH_SALT,
    ELEVENLABS_BRIDGE_AGENDA_MODE: "real_readonly",
    BOOKING_API_BASE_URL: `${UPSTREAM}/v1`,
    BOOKING_USERNAME: SENTINEL_USER,
    BOOKING_PASSWORD: SENTINEL_PASSWORD,
    ELEVENLABS_BRIDGE_AGENDA_REAL_READ_AUTHORIZED: "true",
    ELEVENLABS_BRIDGE_AGENDA_AUTHORIZATION_REF: "decision-2026-08-24-lectura-agenda",
  };
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("se esperaba un fallo de arranque y no lo hubo");
}

async function asyncMessageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("se esperaba un fallo de arranque y no lo hubo");
}

function expectRedacted(message: string): void {
  for (const sentinel of SENTINELS) {
    expect(message).not.toContain(sentinel);
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, ELEVENLABS_BRIDGE_HOST, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no se pudo obtener un puerto efímero")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

const openApps: FastifyInstance[] = [];

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => await app.close()));
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("modo de agenda del puente · opt-in explícito", () => {
  it("sin configurar sirve la agenda sintética", () => {
    expect(loadElevenLabsBridgeAgendaMode({})).toBe("synthetic");
  });

  it("la cadena vacía o en blanco sigue siendo sintético, no un modo raro", () => {
    expect(loadElevenLabsBridgeAgendaMode({ ELEVENLABS_BRIDGE_AGENDA_MODE: "   " })).toBe("synthetic");
  });

  it("real_readonly sólo se activa escribiéndolo entero", () => {
    expect(loadElevenLabsBridgeAgendaMode({ ELEVENLABS_BRIDGE_AGENDA_MODE: "real_readonly" })).toBe("real_readonly");
  });

  it("rechaza un modo desconocido en vez de adivinar", () => {
    const message = messageOf(() => loadElevenLabsBridgeAgendaMode({ ELEVENLABS_BRIDGE_AGENDA_MODE: "real" }));
    expect(message).toContain("ELEVENLABS_BRIDGE_AGENDA_MODE");
    expect(message).toContain("real_readonly");
  });

  it("un modo aproximado NO cae en silencio a sintético", () => {
    expect(() => loadElevenLabsBridgeAgendaMode({ ELEVENLABS_BRIDGE_AGENDA_MODE: "REAL_READONLY" })).toThrow();
  });
});

describe("configuración de real_readonly · completa arranca", () => {
  it("acepta la configuración mínima completa y aplica los valores por defecto documentados", () => {
    const config = loadElevenLabsRealAgendaConfig(realEnv());
    expect(config.mode).toBe("real_readonly");
    expect(config.baseUrl).toBe(`${UPSTREAM}/v1`);
    expect(config.timeoutMs).toBe(DEFAULT_AGENDA_TIMEOUT_MS);
    expect(config.horizonDays).toBe(DEFAULT_AGENDA_HORIZON_DAYS);
    expect(config.typeReservation).toBe(DEFAULT_AGENDA_TYPE_RESERVATION);
    expect(config.employeeIds).toBeUndefined();
    expect(config.authorizationRef).toBe("decision-2026-08-24-lectura-agenda");
  });

  it("rememberMe es el literal false, no una opción del entorno", () => {
    const config = loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_REMEMBER_ME: "false" }));
    expect(config.rememberMe).toBe(false);
  });

  it("admite lista blanca de profesionales, horizonte y timeout explícitos", () => {
    const config = loadElevenLabsRealAgendaConfig(
      realEnv({
        ELEVENLABS_BRIDGE_AGENDA_EMPLOYEE_IDS: "1, 3",
        ELEVENLABS_BRIDGE_AGENDA_HORIZON_DAYS: "2",
        ELEVENLABS_BRIDGE_AGENDA_TIMEOUT_MS: "1500",
      }),
    );
    expect(config.employeeIds).toEqual([1, 3]);
    expect(config.horizonDays).toBe(2);
    expect(config.timeoutMs).toBe(1500);
  });

  it("un horizonte de 0 días es legítimo y significa «sólo hoy»", () => {
    expect(loadElevenLabsRealAgendaConfig(realEnv({ ELEVENLABS_BRIDGE_AGENDA_HORIZON_DAYS: "0" })).horizonDays).toBe(0);
  });

  it("rechaza un horizonte fuera del rango admitido en vez de barrer meses de agenda", () => {
    expect(() =>
      loadElevenLabsRealAgendaConfig(realEnv({ ELEVENLABS_BRIDGE_AGENDA_HORIZON_DAYS: "365" })),
    ).toThrow(/ELEVENLABS_BRIDGE_AGENDA_HORIZON_DAYS/);
  });

  it("rechaza una lista de profesionales que no sean ids numéricos", () => {
    expect(() =>
      loadElevenLabsRealAgendaConfig(realEnv({ ELEVENLABS_BRIDGE_AGENDA_EMPLOYEE_IDS: "1,bruno" })),
    ).toThrow(/ELEVENLABS_BRIDGE_AGENDA_EMPLOYEE_IDS/);
  });
});

describe("configuración de real_readonly · incompleta falla cerrado", () => {
  const required = [
    "BOOKING_API_BASE_URL",
    "BOOKING_USERNAME",
    "BOOKING_PASSWORD",
    "ELEVENLABS_BRIDGE_AGENDA_REAL_READ_AUTHORIZED",
    "ELEVENLABS_BRIDGE_AGENDA_AUTHORIZATION_REF",
  ] as const;

  for (const variable of required) {
    it(`sin ${variable} no arranca, y lo dice nombrando la variable`, () => {
      const message = messageOf(() => loadElevenLabsRealAgendaConfig(realEnv({ [variable]: undefined })));
      expect(message).toContain(variable);
      expect(message).toContain("real_readonly");
      expectRedacted(message);
    });

    it(`con ${variable} en blanco tampoco arranca: vacío no es configurado`, () => {
      expect(() => loadElevenLabsRealAgendaConfig(realEnv({ [variable]: "   " }))).toThrow();
    });
  }

  it("nunca degrada a sintético: el fallo es un throw, no un objeto de modo synthetic", () => {
    expect(() => loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_PASSWORD: undefined }))).toThrow(
      /no arranca a medias ni cae en silencio a la agenda sintética/,
    );
  });

  it("acumula todos los huecos en un solo mensaje, no sólo el primero", () => {
    const message = messageOf(() =>
      loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_USERNAME: undefined, BOOKING_PASSWORD: undefined })),
    );
    expect(message).toContain("BOOKING_USERNAME");
    expect(message).toContain("BOOKING_PASSWORD");
  });
});

describe("configuración de real_readonly · autorización humana obligatoria", () => {
  it("sin la firma explícita se niega a leer la agenda real", () => {
    const message = messageOf(() =>
      loadElevenLabsRealAgendaConfig(realEnv({ ELEVENLABS_BRIDGE_AGENDA_REAL_READ_AUTHORIZED: undefined })),
    );
    expect(message).toContain("ELEVENLABS_BRIDGE_AGENDA_REAL_READ_AUTHORIZED");
    expect(message).toContain("autorización humana explícita");
  });

  it("«false», «1» o «yes» no son autorización: sólo el literal true", () => {
    for (const intento of ["false", "1", "yes", "TRUE"]) {
      expect(() =>
        loadElevenLabsRealAgendaConfig(realEnv({ ELEVENLABS_BRIDGE_AGENDA_REAL_READ_AUTHORIZED: intento })),
      ).toThrow(/ELEVENLABS_BRIDGE_AGENDA_REAL_READ_AUTHORIZED/);
    }
  });

  it("la referencia de quién autorizó no puede ser un garabato de dos letras", () => {
    expect(() =>
      loadElevenLabsRealAgendaConfig(realEnv({ ELEVENLABS_BRIDGE_AGENDA_AUTHORIZATION_REF: "ok" })),
    ).toThrow(/ELEVENLABS_BRIDGE_AGENDA_AUTHORIZATION_REF/);
  });
});

describe("configuración de real_readonly · las dos prohibiciones duras", () => {
  it("BOOKING_REMEMBER_ME=true es un rechazo, no un aviso", () => {
    const message = messageOf(() => loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_REMEMBER_ME: "true" })));
    expect(message).toContain("BOOKING_REMEMBER_ME");
    expect(message).toContain("sesión persistente");
    expectRedacted(message);
  });

  it("cualquier valor de BOOKING_REMEMBER_ME que no sea false se rechaza", () => {
    for (const intento of ["true", "1", "yes", "TRUE"]) {
      expect(() => loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_REMEMBER_ME: intento }))).toThrow(
        /BOOKING_REMEMBER_ME/,
      );
    }
  });

  it("ENABLE_WRITE_OPERATIONS=true impide el arranque del modo real_readonly", () => {
    const message = messageOf(() => loadElevenLabsRealAgendaConfig(realEnv({ ENABLE_WRITE_OPERATIONS: "true" })));
    expect(message).toContain("ENABLE_WRITE_OPERATIONS");
    expect(message).toContain("sólo lee");
    expectRedacted(message);
  });

  it("ENABLE_WRITE_OPERATIONS=false sí deja arrancar", () => {
    expect(() => loadElevenLabsRealAgendaConfig(realEnv({ ENABLE_WRITE_OPERATIONS: "false" }))).not.toThrow();
  });
});

describe("configuración de real_readonly · la URL no puede transportar secretos", () => {
  it("rechaza usuario:clave embebidos en la URL base sin repetir la clave", () => {
    const message = messageOf(() =>
      loadElevenLabsRealAgendaConfig(
        realEnv({ BOOKING_API_BASE_URL: "https://operador:s3cr3t0-embebido@agenda-de-prueba.invalid/v1" }),
      ),
    );
    expect(message).toContain("BOOKING_API_BASE_URL");
    expect(message).not.toContain("s3cr3t0-embebido");
  });

  it("rechaza un token colgado de la query", () => {
    expect(() =>
      loadElevenLabsRealAgendaConfig(
        realEnv({ BOOKING_API_BASE_URL: `${UPSTREAM}/v1?access_token=abc` }),
      ),
    ).toThrow(/BOOKING_API_BASE_URL/);
  });

  it("rechaza http:// contra un host remoto: ahí viajan credenciales", () => {
    expect(() =>
      loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_API_BASE_URL: "http://agenda-de-prueba.invalid/v1" })),
    ).toThrow(/BOOKING_API_BASE_URL/);
  });

  it("admite http:// contra localhost, que es donde no hay camino que espiar", () => {
    expect(() =>
      loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_API_BASE_URL: "http://localhost:8000/v1" })),
    ).not.toThrow();
  });

  it("rechaza algo que no es una URL en vez de apuntar a producción por defecto", () => {
    expect(() => loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_API_BASE_URL: "booking-example" }))).toThrow(
      /BOOKING_API_BASE_URL/,
    );
  });
});

describe("configuración de real_readonly · redacción de credenciales", () => {
  it("serializar la configuración no imprime ni usuario ni contraseña", () => {
    const config = loadElevenLabsRealAgendaConfig(realEnv());
    const serialized = JSON.stringify(config);
    expectRedacted(serialized);
    expect(serialized).toContain("[redactado]");
  });

  it("los mensajes de fallo nunca contienen el valor de una credencial", () => {
    const message = messageOf(() =>
      loadElevenLabsRealAgendaConfig(realEnv({ ELEVENLABS_BRIDGE_AGENDA_AUTHORIZATION_REF: undefined })),
    );
    expectRedacted(message);
  });

  it("una contraseña vacía se denuncia sin repetir lo que había", () => {
    const message = messageOf(() => loadElevenLabsRealAgendaConfig(realEnv({ BOOKING_PASSWORD: "" })));
    expect(message).toContain("BOOKING_PASSWORD");
    expectRedacted(message);
  });
});

describe("arranque del proceso · startElevenLabsBridge", () => {
  it("sin ninguna configuración se niega a arrancar y el mensaje va redactado", async () => {
    const message = await asyncMessageOf(async () =>
      startElevenLabsBridge({ ELEVENLABS_BRIDGE_AGENDA_MODE: "real_readonly" }),
    );
    expect(message).toMatch(/desactivado|ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED/);
    expectRedacted(message);
  });

  it("con secretos del puente pero sin credenciales de agenda tampoco arranca", async () => {
    const message = await asyncMessageOf(async () =>
      startElevenLabsBridge(
        realEnv({ BOOKING_API_BASE_URL: undefined, BOOKING_USERNAME: undefined, BOOKING_PASSWORD: undefined }),
      ),
    );
    expect(message).toContain("BOOKING_API_BASE_URL");
    expect(message).toContain("BOOKING_USERNAME");
    expect(message).toContain("BOOKING_PASSWORD");
    expectRedacted(message);
  });

  it("ENABLE_WRITE_OPERATIONS=true impide arrancar el proceso entero", async () => {
    const message = await asyncMessageOf(async () =>
      startElevenLabsBridge(realEnv({ ENABLE_WRITE_OPERATIONS: "true" })),
    );
    expect(message).toContain("ENABLE_WRITE_OPERATIONS");
  });

  it("BOOKING_REMEMBER_ME=true impide arrancar el proceso entero", async () => {
    const message = await asyncMessageOf(async () => startElevenLabsBridge(realEnv({ BOOKING_REMEMBER_ME: "true" })));
    expect(message).toContain("BOOKING_REMEMBER_ME");
  });


  it("el modo sintético sigue arrancando por el mismo punto de montaje, sin tocar nada", async () => {
    const port = await freePort();
    const started = await startElevenLabsBridge({
      ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED: "1",
      ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ELEVENLABS_CALL_HASH_SALT: HASH_SALT,
      ELEVENLABS_SYNTHETIC_BRIDGE_PORT: String(port),
    });
    openApps.push(started.app);

    expect(started.mode).toBe("synthetic");
    expect(started.anchor).toBeDefined();
    expect(started.today).toBeUndefined();
    expect(started.authorizationRef).toBeUndefined();

    const health = await started.app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({
      ok: true,
      mode: "synthetic",
      service: "demo-salon-elevenlabs-synthetic-bridge",
      external_mutation: false,
    });
  });
});
