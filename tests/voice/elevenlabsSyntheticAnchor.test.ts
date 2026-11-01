import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { addDays } from "../../src/callEngine/domain/time.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import {
  BOOKING_DEMO_NOW_MINUTES,
  BOOKING_DEMO_TODAY,
  sampleReservations,
  demoSalonVenue,
} from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { ALEX_ID, DANI_ID, NEREA_ID } from "../../src/callEngine/fixtures/syntheticVenue.js";
import {
  DEFAULT_ELEVENLABS_SYNTHETIC_NOW_MINUTES,
  DEFAULT_ELEVENLABS_SYNTHETIC_TODAY,
  ELEVENLABS_BRIDGE_HOST,
  loadElevenLabsBridgeConfig,
  resolveElevenLabsSyntheticAnchor,
} from "../../src/voice/elevenlabs/config.js";
import {
  buildElevenLabsSyntheticBridge,
  startElevenLabsSyntheticBridge,
} from "../../src/voice/elevenlabs/server.js";

/**
 * step 26 · el «hoy» sintético del puente ElevenLabs es configurable.
 *
 * Hasta aquí el puente vivía clavado en el martes 2026-08-04 a las 09:00.
 * Estas pruebas fijan las dos variables nuevas —opcionales— y, sobre todo,
 * fijan lo que NO puede pasar al moverlas: ni una agenda vacía, ni un día
 * cerrado, ni una fecha fuera de la temporada sintética del fixture. El
 * reloj real sigue sin leerse en ningún punto.
 */

const WEBHOOK_SECRET = "test-webhook-secret-32-characters-minimum";
const HASH_SALT = "test-call-hash-salt-32-characters-minimum";
const HEADERS = { "x-booking-voice-secret": WEBHOOK_SECRET };

/** Martes dentro de la temporada de agosto, distinto del ancla por defecto. */
const OTRO_MARTES = "2026-08-11";
/** El jueves de esa misma semana: `OTRO_MARTES + 2`. */
const JUEVES_DE_ESA_SEMANA = "2026-08-13";
const DOMINGO_CERRADO = "2026-08-09";
const LUNES_CERRADO = "2026-08-10";
/** Cuántos días separan el ancla alternativa de la de por defecto. */
const DESPLAZAMIENTO_DIAS = 7;

const SECRETOS_BASE = {
  ELEVENLABS_SYNTHETIC_BRIDGE_ENABLED: "1",
  ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ELEVENLABS_CALL_HASH_SALT: HASH_SALT,
} as const;

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => await app.close()));
});

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

/** Un puente construido como lo construye el arranque real: sólo con el ancla. */
function puenteAnclado(env: Record<string, string>): FastifyInstance {
  const config = loadElevenLabsBridgeConfig({ ...SECRETOS_BASE, ...env });
  const app = buildElevenLabsSyntheticBridge({
    webhookSecret: WEBHOOK_SECRET,
    salt: HASH_SALT,
    anchor: resolveElevenLabsSyntheticAnchor(config),
  });
  openApps.push(app);
  return app;
}

function consulta(dateISO: string, time: string, professionalId: number) {
  return {
    conversation_id: `conv_anchor_${dateISO.replaceAll("-", "")}_${time.replace(":", "")}`,
    date_iso: dateISO,
    time,
    service_id: 1,
    professional_id: professionalId,
    service_confirmed: true,
  };
}

async function disponibilidad(app: FastifyInstance, cuerpo: ReturnType<typeof consulta>) {
  return await app.inject({
    method: "POST",
    url: "/v1/elevenlabs/availability",
    headers: HEADERS,
    payload: cuerpo as never,
  });
}

describe("step 26 · configuración del ancla sintética", () => {
  it("sin configurar nada, el ancla es exactamente la de la consola y la demo", () => {
    const config = loadElevenLabsBridgeConfig({});
    expect(Object.prototype.hasOwnProperty.call(config, "syntheticToday")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(config, "syntheticNowMinutes")).toBe(false);

    expect(resolveElevenLabsSyntheticAnchor(config)).toEqual({
      today: BOOKING_DEMO_TODAY,
      nowMinutes: BOOKING_DEMO_NOW_MINUTES,
      nowTime: "09:00",
    });
    expect(DEFAULT_ELEVENLABS_SYNTHETIC_TODAY).toBe(BOOKING_DEMO_TODAY);
    expect(DEFAULT_ELEVENLABS_SYNTHETIC_NOW_MINUTES).toBe(BOOKING_DEMO_NOW_MINUTES);
  });

  it("acepta una fecha y una hora válidas y las expone ya resueltas", () => {
    const config = loadElevenLabsBridgeConfig({
      ELEVENLABS_SYNTHETIC_TODAY: OTRO_MARTES,
      ELEVENLABS_SYNTHETIC_NOW_TIME: "11:30",
    });
    expect(config.syntheticToday).toBe(OTRO_MARTES);
    expect(config.syntheticNowMinutes).toBe(11 * 60 + 30);
    expect(resolveElevenLabsSyntheticAnchor(config)).toEqual({
      today: OTRO_MARTES,
      nowMinutes: 11 * 60 + 30,
      nowTime: "11:30",
    });
  });

  it("cada variable se puede mover sin la otra", () => {
    const soloFecha = resolveElevenLabsSyntheticAnchor(
      loadElevenLabsBridgeConfig({ ELEVENLABS_SYNTHETIC_TODAY: OTRO_MARTES }),
    );
    expect(soloFecha).toEqual({ today: OTRO_MARTES, nowMinutes: BOOKING_DEMO_NOW_MINUTES, nowTime: "09:00" });

    const soloHora = resolveElevenLabsSyntheticAnchor(
      loadElevenLabsBridgeConfig({ ELEVENLABS_SYNTHETIC_NOW_TIME: "00:00" }),
    );
    expect(soloHora).toEqual({ today: BOOKING_DEMO_TODAY, nowMinutes: 0, nowTime: "00:00" });
  });

  it("una cadena vacía o en blanco significa «sin configurar», no una fecha rota", () => {
    const anchor = resolveElevenLabsSyntheticAnchor(
      loadElevenLabsBridgeConfig({ ELEVENLABS_SYNTHETIC_TODAY: "   ", ELEVENLABS_SYNTHETIC_NOW_TIME: "" }),
    );
    expect(anchor).toEqual({
      today: BOOKING_DEMO_TODAY,
      nowMinutes: BOOKING_DEMO_NOW_MINUTES,
      nowTime: "09:00",
    });
  });

  it.each(["2026-02-30", "2026-8-4", "04-08-2026", "hoy", "2026-08-4"])(
    "rechaza la fecha inválida %s en lugar de arrancar sobre ella",
    (fecha) => {
      expect(() => loadElevenLabsBridgeConfig({ ELEVENLABS_SYNTHETIC_TODAY: fecha })).toThrow(
        /ELEVENLABS_SYNTHETIC_TODAY/,
      );
    },
  );

  it.each(["25:00", "12:60", "9:00", "0900", "12:00:00", "mediodía"])(
    "rechaza la hora inválida %s",
    (hora) => {
      expect(() => loadElevenLabsBridgeConfig({ ELEVENLABS_SYNTHETIC_NOW_TIME: hora })).toThrow(
        /ELEVENLABS_SYNTHETIC_NOW_TIME: debe ser una hora real/,
      );
    },
  );

  it.each(["2026-07-31", "2026-09-01", "2025-08-04", "2027-08-04"])(
    "rechaza %s por caer fuera de la temporada sintética que el fixture cubre",
    (fecha) => {
      expect(() => loadElevenLabsBridgeConfig({ ELEVENLABS_SYNTHETIC_TODAY: fecha })).toThrow(
        /temporada sintética del fixture \(2026-08-01\.\.2026-08-31\)/,
      );
    },
  );

  it("acepta los dos extremos de la temporada, que sí están dentro", () => {
    for (const fecha of ["2026-08-01", "2026-08-31"]) {
      expect(loadElevenLabsBridgeConfig({ ELEVENLABS_SYNTHETIC_TODAY: fecha }).syntheticToday).toBe(fecha);
    }
  });
});

describe("step 26 · el puente corre sobre el ancla configurada", () => {
  it("/health publica el día y la hora sintéticos efectivos", async () => {
    const app = puenteAnclado({
      ELEVENLABS_SYNTHETIC_TODAY: OTRO_MARTES,
      ELEVENLABS_SYNTHETIC_NOW_TIME: "12:00",
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      mode: "synthetic",
      external_mutation: false,
      synthetic_today: OTRO_MARTES,
      synthetic_now: "12:00",
    });
  });

  it("sin configurar nada, /health sigue diciendo 2026-08-04 a las 09:00", async () => {
    const app = puenteAnclado({});
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
      synthetic_today: BOOKING_DEMO_TODAY,
      synthetic_now: "09:00",
    });
  });

  it("un reloj inyectado manda sobre el ancla configurada: las pruebas no pierden el control del tiempo", async () => {
    const app = buildElevenLabsSyntheticBridge({
      webhookSecret: WEBHOOK_SECRET,
      salt: HASH_SALT,
      anchor: { today: OTRO_MARTES, nowMinutes: 12 * 60, nowTime: "12:00" },
      clock: fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES),
    });
    openApps.push(app);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
      synthetic_today: BOOKING_DEMO_TODAY,
      synthetic_now: "09:00",
    });
  });

  it("la ventana de siete días se mide desde el «hoy» configurado, no desde el de la demo", async () => {
    const configurado = puenteAnclado({
      ELEVENLABS_SYNTHETIC_TODAY: OTRO_MARTES,
      ELEVENLABS_SYNTHETIC_NOW_TIME: "12:00",
    });
    const porDefecto = puenteAnclado({});

    const dentro = await disponibilidad(configurado, consulta(JUEVES_DE_ESA_SEMANA, "11:00", ALEX_ID));
    expect(dentro.statusCode).toBe(200);
    expect(dentro.json()).toMatchObject({
      ok: true,
      reason_code: "AVAILABILITY_PROVIDED",
      requested_slot_available: true,
      external_mutation: false,
      offered_slots: [{ date_iso: JUEVES_DE_ESA_SEMANA, time: "11:00" }],
    });

    // La MISMA fecha, contra el ancla por defecto, cae fuera de la ventana:
    // es la prueba de que el 200 de arriba lo decide el reloj configurado.
    const fuera = await disponibilidad(porDefecto, consulta(JUEVES_DE_ESA_SEMANA, "11:00", ALEX_ID));
    expect(fuera.statusCode).toBe(422);
    expect(fuera.json()).toMatchObject({ error: "date_outside_synthetic_window", external_mutation: false });
  });

  it("una fecha a ocho días del «hoy» configurado sigue siendo un 422, no una fecha silenciosamente cambiada", async () => {
    const app = puenteAnclado({ ELEVENLABS_SYNTHETIC_TODAY: OTRO_MARTES });
    const octavoDia = addDays(OTRO_MARTES, 8);
    expect(octavoDia).toBe("2026-08-19");

    const response = await disponibilidad(app, consulta(octavoDia, "11:00", ALEX_ID));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "date_outside_synthetic_window",
      external_mutation: false,
    });
    expect(String((response.json() as { message: string }).message)).toContain(OTRO_MARTES);
  });

  it("la agenda de muestra viaja con el ancla: el día configurado tiene citas de verdad", async () => {
    const app = puenteAnclado({
      ELEVENLABS_SYNTHETIC_TODAY: OTRO_MARTES,
      ELEVENLABS_SYNTHETIC_NOW_TIME: "12:00",
    });
    // 13:00 con Álex está ocupado por `demo-salon-res-2`, ya movida al ancla.
    const response = await disponibilidad(app, consulta(OTRO_MARTES, "13:00", ALEX_ID));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requested_slot_available: false, external_mutation: false });
  });

  it("el punto de entrada real inyecta el reloj configurado y lo devuelve para que el arranque pueda anunciarlo", async () => {
    const port = await freePort();
    const started = await startElevenLabsSyntheticBridge({
      ...SECRETOS_BASE,
      ELEVENLABS_SYNTHETIC_BRIDGE_PORT: String(port),
      ELEVENLABS_SYNTHETIC_TODAY: OTRO_MARTES,
      ELEVENLABS_SYNTHETIC_NOW_TIME: "12:00",
    });
    openApps.push(started.app);
    expect(started.host).toBe("127.0.0.1");
    expect(started.anchor).toEqual({ today: OTRO_MARTES, nowMinutes: 12 * 60, nowTime: "12:00" });

    const health = await started.app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({ synthetic_today: OTRO_MARTES, synthetic_now: "12:00" });
  });
});

describe("step 26 · un día cerrado no es una semana inútil", () => {
  it.each([DOMINGO_CERRADO, LUNES_CERRADO])(
    "arranca anclado en %s, que es cuando más se llama para pedir hora, aunque el local esté cerrado ese día",
    async (fecha) => {
      const app = puenteAnclado({
        ELEVENLABS_SYNTHETIC_TODAY: fecha,
        ELEVENLABS_SYNTHETIC_NOW_TIME: "18:00",
      });
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ synthetic_today: fecha, synthetic_now: "18:00" });
    },
  );

  it("y desde ese domingo cerrado ofrece de verdad el martes siguiente, que es la llamada real", async () => {
    const app = puenteAnclado({
      ELEVENLABS_SYNTHETIC_TODAY: DOMINGO_CERRADO,
      ELEVENLABS_SYNTHETIC_NOW_TIME: "18:00",
    });
    const martesSiguiente = addDays(DOMINGO_CERRADO, 2);
    expect(martesSiguiente).toBe(OTRO_MARTES);

    const response = await disponibilidad(app, consulta(martesSiguiente, "11:00", ALEX_ID));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      reason_code: "AVAILABILITY_PROVIDED",
      requested_slot_available: true,
      external_mutation: false,
      offered_slots: [{ date_iso: martesSiguiente, time: "11:00" }],
    });
  });

  it("el domingo cerrado sigue siendo un día de la ventana: se responde, sin hueco y sin inventarse otro día", async () => {
    const app = puenteAnclado({
      ELEVENLABS_SYNTHETIC_TODAY: DOMINGO_CERRADO,
      ELEVENLABS_SYNTHETIC_NOW_TIME: "18:00",
    });
    const response = await disponibilidad(app, consulta(DOMINGO_CERRADO, "11:00", ALEX_ID));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requested_slot_available: false, external_mutation: false });
  });
});

describe("step 26 · el arranque falla cerrado ante una ventana entera sin un solo hueco", () => {
  /** El fixture no puede producirla —toda semana de agosto trae martes— así que se inyecta. */
  function venueSinHorario() {
    return { ...demoSalonVenue(), weeklySchedules: [], seasonalSchedules: [] };
  }

  it("se niega a construir el puente cuando ninguno de los siete días abre para nadie", () => {
    expect(() =>
      buildElevenLabsSyntheticBridge({
        webhookSecret: WEBHOOK_SECRET,
        salt: HASH_SALT,
        anchor: resolveElevenLabsSyntheticAnchor(loadElevenLabsBridgeConfig({})),
        initialCalendar: venueSinHorario(),
      }),
    ).toThrow(/Ningún día de la ventana sintética 2026-08-04\.\.2026-08-10 abre para nadie/);
  });

  it("y el error nombra la variable que hay que corregir en vez de dejar el fallo mudo", () => {
    expect(() =>
      buildElevenLabsSyntheticBridge({
        webhookSecret: WEBHOOK_SECRET,
        salt: HASH_SALT,
        anchor: { today: OTRO_MARTES, nowMinutes: 12 * 60, nowTime: "12:00" },
        initialCalendar: venueSinHorario(),
      }),
    ).toThrow(/ELEVENLABS_SYNTHETIC_TODAY/);
  });

  it("basta con que abra UN día de la ventana, aunque sea el último", async () => {
    const soloElSabado = {
      ...demoSalonVenue(),
      seasonalSchedules: [],
      weeklySchedules: [{ ownerKind: "venue" as const, dayOfWeek: 6, workDayStart: "09:00", workDayEnd: "14:00" }],
    };
    // Ancla en domingo: el único día abierto de la ventana es el sábado, a seis días.
    const app = buildElevenLabsSyntheticBridge({
      webhookSecret: WEBHOOK_SECRET,
      salt: HASH_SALT,
      anchor: { today: DOMINGO_CERRADO, nowMinutes: 18 * 60, nowTime: "18:00" },
      initialCalendar: soloElSabado,
    });
    openApps.push(app);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ synthetic_today: DOMINGO_CERRADO, synthetic_now: "18:00" });
  });
});

describe("step 26 · las citas de muestra se derivan del ancla", () => {
  it("por defecto siguen exactamente donde estaban: 2026-08-04 y 2026-08-06", () => {
    const porDefecto = sampleReservations();
    expect(porDefecto.filter((r) => r.date === BOOKING_DEMO_TODAY)).toHaveLength(8);
    expect(porDefecto.filter((r) => r.date === "2026-08-06").map((r) => r.id)).toEqual([
      "demo-salon-res-8",
      "demo-salon-res-9",
    ]);
    expect(new Set(porDefecto.map((r) => r.date))).toEqual(new Set([BOOKING_DEMO_TODAY, "2026-08-06"]));
  });

  it("con otra ancla, el segundo día sigue siendo «el ancla más dos», no una fecha clavada", () => {
    const movidas = sampleReservations(OTRO_MARTES);
    expect(new Set(movidas.map((r) => r.date))).toEqual(new Set([OTRO_MARTES, JUEVES_DE_ESA_SEMANA]));
    expect(movidas.filter((r) => r.date === JUEVES_DE_ESA_SEMANA).map((r) => r.id)).toEqual([
      "demo-salon-res-8",
      "demo-salon-res-9",
    ]);
  });

  it("sólo cambian las fechas: ids, personas, servicios, horas y estados son los mismos", () => {
    const porDefecto = sampleReservations();
    const movidas = sampleReservations(OTRO_MARTES);
    expect(movidas).toHaveLength(porDefecto.length);
    expect(movidas.map((cita) => ({ ...cita, date: addDays(cita.date, -DESPLAZAMIENTO_DIAS) }))).toEqual(
      porDefecto,
    );
    expect(movidas.map((r) => r.employeeId)).toContain(NEREA_ID);
    expect(movidas.map((r) => r.employeeId)).toContain(DANI_ID);
  });

  it("y `demoSalonVenue()` traslada la agenda entera con el ancla sin tocar nada más", () => {
    const porDefecto = demoSalonVenue();
    const movido = demoSalonVenue(OTRO_MARTES);
    expect(movido.reservations).toEqual(sampleReservations(OTRO_MARTES));
    expect(porDefecto.reservations).toEqual(sampleReservations());
    expect(movido.weeklySchedules).toEqual(porDefecto.weeklySchedules);
    expect(movido.seasonalSchedules).toEqual(porDefecto.seasonalSchedules);
    expect(movido.professionals).toEqual(porDefecto.professionals);
    expect(movido.professionals.map((p) => p.employeeId)).toEqual([ALEX_ID, DANI_ID, NEREA_ID]);
  });
});
