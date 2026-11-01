import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { addDays } from "../../src/callEngine/domain/time.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { dayPhraseEs, parseDateTime } from "../../src/utils/dateFormatterEs.js";
import { callDateContext, spokenDateES } from "../../src/voice/elevenlabs/agenda/callContext.js";
import { MADRID_TIME_ZONE, madridClock } from "../../src/voice/elevenlabs/agenda/madridClock.js";
import type { ReadOnlyAgendaDay, ReadOnlyAgendaPort } from "../../src/voice/elevenlabs/agenda/port.js";
import { buildElevenLabsSyntheticBridge } from "../../src/voice/elevenlabs/server.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * BLOQUE «FECHA DINÁMICA» · EL PROMPT DEJA DE LLEVAR LA FECHA ESCRITA A MANO.
 *
 * A partir de aquí, cada llamada saliente inyecta variables dinámicas y la
 * ÚNICA fuente de verdad de «hoy» y de la ventana es el puente. Lo que estas
 * pruebas fijan es justo lo que se rompería en silencio:
 *
 *   · que `today_iso` y `today_spoken_es` NUNCA se contradigan, ni siquiera
 *     en el segundo exacto del cambio de día en Madrid — decir «lunes 24»
 *     mientras el puente ya rechaza el 24 por pasado es la peor versión del
 *     fallo, porque suena perfectamente normal por teléfono;
 *   · que la ventana cruce fin de mes, fin de año y cambio de hora sin
 *     perder ni ganar un día;
 *   · que `window_end_iso` de `/health` sea EXACTAMENTE el último día que la
 *     ruta acepta: el día siguiente tiene que dar 422.
 *
 * Todo instante de aquí es un instante UTC explícito, así que estas pruebas
 * valen igual en un portátil en Madrid que en un contenedor en UTC.
 * ────────────────────────────────────────────────────────────────────────
 */

const WEBHOOK_SECRET = "test-webhook-secret-32-characters-minimum";
const HASH_SALT = "test-call-hash-salt-32-characters-minimum";
const HEADERS = { "x-booking-voice-secret": WEBHOOK_SECRET };

function clockAt(utcInstant: string): ReturnType<typeof madridClock> {
  return madridClock(() => new Date(utcInstant));
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => await app.close()));
});

/** Un puerto que contesta «día cerrado» y anota qué días le preguntaron. */
function emptyPort(asked: string[]): ReadOnlyAgendaPort {
  return {
    async readDay({ dateISO }): Promise<ReadOnlyAgendaDay> {
      asked.push(dateISO);
      return { dateISO, professionals: [], slots: [] };
    },
  };
}

// ---------------------------------------------------------------------
// 1. La función pura
// ---------------------------------------------------------------------

describe("contexto de fecha · «hoy» hablado y ventana, calculados en el puente", () => {
  it("dice la fecha en el formato exacto que se lee en voz alta", () => {
    const contexto = callDateContext(clockAt("2026-08-24T10:00:00Z"), 6);
    expect(contexto.today_iso).toBe("2026-08-24");
    expect(contexto.today_spoken_es).toBe("lunes 24 de agosto de 2026");
    expect(contexto.window_end_iso).toBe("2026-08-30");
    expect(contexto.timezone).toBe("Europe/Madrid");
  });

  it("publica la MISMA zona que usa el reloj del puente, no un literal repetido", () => {
    expect(callDateContext(clockAt("2026-08-24T10:00:00Z"), 6).timezone).toBe(MADRID_TIME_ZONE);
  });

  it("en el cambio de día de Madrid, la fecha hablada salta con la fecha ISO", () => {
    // 21:59:59Z de un día de verano son las 23:59:59 de Madrid: todavía lunes.
    const antes = callDateContext(clockAt("2026-08-24T21:59:59Z"), 6);
    expect(antes.today_iso).toBe("2026-08-24");
    expect(antes.today_spoken_es).toBe("lunes 24 de agosto de 2026");
    expect(antes.window_end_iso).toBe("2026-08-30");

    // Un segundo después ya es martes en Madrid, y la frase lo dice.
    const despues = callDateContext(clockAt("2026-08-24T22:00:00Z"), 6);
    expect(despues.today_iso).toBe("2026-08-25");
    expect(despues.today_spoken_es).toBe("martes 25 de agosto de 2026");
    expect(despues.window_end_iso).toBe("2026-08-31");
  });

  it("en invierno el corte del día es una hora más tarde en UTC, y arrastra las dos fechas", () => {
    const antes = callDateContext(clockAt("2026-01-15T22:59:59Z"), 6);
    expect(antes.today_iso).toBe("2026-01-15");
    expect(antes.today_spoken_es).toBe("jueves 15 de enero de 2026");

    const despues = callDateContext(clockAt("2026-01-15T23:00:00Z"), 6);
    expect(despues.today_iso).toBe("2026-01-16");
    expect(despues.today_spoken_es).toBe("viernes 16 de enero de 2026");
  });

  it("la fecha hablada SIEMPRE es la de today_iso, minuto a minuto alrededor de medianoche", () => {
    // Barrido de cinco minutos a caballo del cambio de día: en ningún
    // instante pueden discrepar los dos campos.
    for (let offset = -3; offset <= 2; offset += 1) {
      const instante = new Date(Date.parse("2026-08-24T22:00:00Z") + offset * 60_000).toISOString();
      const contexto = callDateContext(clockAt(instante), 6);
      expect(`${instante} → ${contexto.today_spoken_es}`).toBe(
        `${instante} → ${spokenDateES(contexto.today_iso)}`,
      );
    }
  });

  it("cruza el fin de mes sin quedarse en agosto", () => {
    const contexto = callDateContext(fixedClock("2026-08-31", 9 * 60), 6);
    expect(contexto.today_spoken_es).toBe("lunes 31 de agosto de 2026");
    expect(contexto.window_end_iso).toBe("2026-09-06");
  });

  it("cruza el fin de año sin quedarse en 2026", () => {
    const contexto = callDateContext(fixedClock("2026-12-29", 9 * 60), 6);
    expect(contexto.today_spoken_es).toBe("martes 29 de diciembre de 2026");
    expect(contexto.window_end_iso).toBe("2027-01-04");
  });

  it("cruza el cambio de hora de primavera sin perder ni ganar un día", () => {
    const contexto = callDateContext(fixedClock("2026-03-28", 9 * 60), 6);
    expect(contexto.today_spoken_es).toBe("sábado 28 de marzo de 2026");
    // El 29 de marzo de 2026 Madrid se salta una hora; la ventana no se
    // entera porque la suma de días pivota sobre mediodía UTC.
    expect(contexto.window_end_iso).toBe("2026-04-03");
  });

  it("cruza el cambio de hora de otoño sin repetir un día", () => {
    expect(callDateContext(fixedClock("2026-10-24", 9 * 60), 6).window_end_iso).toBe("2026-10-30");
  });

  it("el horizonte es inclusivo: 6 son siete días y 0 es sólo hoy", () => {
    expect(callDateContext(fixedClock("2026-08-24", 0), 6).window_end_iso).toBe("2026-08-30");
    expect(callDateContext(fixedClock("2026-08-24", 0), 0).window_end_iso).toBe("2026-08-24");
    expect(callDateContext(fixedClock("2026-08-24", 0), 1).window_end_iso).toBe("2026-08-25");
    expect(callDateContext(fixedClock("2026-08-24", 0), 30).window_end_iso).toBe("2026-09-23");
  });

  it("un horizonte imposible se denuncia en vez de inventar una ventana", () => {
    for (const horizonte of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => callDateContext(fixedClock("2026-08-24", 0), horizonte)).toThrow(/horizonte/i);
    }
  });

  it("dice los días y los meses con las MISMAS palabras que el motor de voz", () => {
    // Si el prompt dijera «miercoles» y la herramienta «miércoles», sería la
    // misma llamada hablando en dos castellanos distintos. Sale de la misma
    // tabla, y esto lo ata.
    for (const dateISO of ["2026-08-24", "2026-03-04", "2026-09-06", "2026-12-31", "2027-01-01"]) {
      const parsed = parseDateTime(dateISO);
      expect(parsed).not.toBeNull();
      expect(spokenDateES(dateISO)).toBe(`${dayPhraseEs(parsed!)} de ${dateISO.slice(0, 4)}`);
    }
    // Y con los acentos donde tocan, que es lo que se oye.
    expect(spokenDateES("2026-03-04")).toBe("miércoles 4 de marzo de 2026");
    expect(spokenDateES("2026-12-05")).toBe("sábado 5 de diciembre de 2026");
  });

  it("la fecha hablada es una función pura de la fecha, sin leer ningún reloj", () => {
    expect(spokenDateES("2026-01-01")).toBe("jueves 1 de enero de 2026");
    expect(spokenDateES("2026-09-06")).toBe("domingo 6 de septiembre de 2026");
    // Sin ceros a la izquierda en el día: se dice «seis», no «cero seis».
    expect(spokenDateES("2026-09-06")).not.toContain(" 06 ");
    expect(() => spokenDateES("2026-02-30")).toThrow();
    expect(() => spokenDateES("mañana")).toThrow();
  });
});

// ---------------------------------------------------------------------
// 2. /health, que es de donde el lanzador de llamadas lo copia
// ---------------------------------------------------------------------

describe("/health · publica la fecha lista para inyectar como variable dinámica", () => {
  it("en real_readonly añade los campos nuevos y deja intactos los de siempre", async () => {
    const asked: string[] = [];
    const app = buildElevenLabsSyntheticBridge({
      webhookSecret: WEBHOOK_SECRET,
      salt: HASH_SALT,
      clock: clockAt("2026-08-24T10:30:00Z"),
      realAgenda: { port: emptyPort(asked), horizonDays: 6 },
    });
    openApps.push(app);

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      ok: true,
      service: "demo-salon-elevenlabs-real-readonly-bridge",
      mode: "real_readonly",
      external_mutation: false,
      upstream_writes: "disabled",
      today: "2026-08-24",
      now: "12:30",
      today_spoken_es: "lunes 24 de agosto de 2026",
      window_end_iso: "2026-08-30",
      timezone: "Europe/Madrid",
    });
    // Publicar la fecha no lee la agenda de nadie.
    expect(asked).toEqual([]);
  });

  it("en sintético añade los mismos campos nuevos sin tocar synthetic_today ni synthetic_now", async () => {
    const app = buildElevenLabsSyntheticBridge({
      webhookSecret: WEBHOOK_SECRET,
      salt: HASH_SALT,
      clock: fixedClock("2026-08-04", 9 * 60),
    });
    openApps.push(app);

    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({
      ok: true,
      service: "demo-salon-elevenlabs-synthetic-bridge",
      mode: "synthetic",
      external_mutation: false,
      synthetic_today: "2026-08-04",
      synthetic_now: "09:00",
      today_spoken_es: "martes 4 de agosto de 2026",
      window_end_iso: "2026-08-10",
      timezone: "Europe/Madrid",
    });
  });

  it("sigue el horizonte configurado del puente, no un 6 escrito a mano", async () => {
    for (const horizonDays of [0, 2, 6, 14]) {
      const app = buildElevenLabsSyntheticBridge({
        webhookSecret: WEBHOOK_SECRET,
        salt: HASH_SALT,
        clock: fixedClock("2026-08-25", 9 * 60),
        realAgenda: { port: emptyPort([]), horizonDays },
      });
      openApps.push(app);
      const body = (await app.inject({ method: "GET", url: "/health" })).json() as Record<string, unknown>;
      expect(`${String(horizonDays)}: ${String(body.window_end_iso)}`).toBe(
        `${String(horizonDays)}: ${addDays("2026-08-25", horizonDays)}`,
      );
    }
  });

  it("window_end_iso es EXACTAMENTE el último día que la ruta acepta", async () => {
    const asked: string[] = [];
    const app = buildElevenLabsSyntheticBridge({
      webhookSecret: WEBHOOK_SECRET,
      salt: HASH_SALT,
      clock: fixedClock("2026-08-25", 9 * 60),
      realAgenda: { port: emptyPort(asked), horizonDays: 3 },
    });
    openApps.push(app);

    const health = (await app.inject({ method: "GET", url: "/health" })).json() as Record<string, unknown>;
    const windowEnd = String(health.window_end_iso);
    expect(windowEnd).toBe("2026-08-28");

    const slot = (dateISO: string): Record<string, unknown> => ({
      conversation_id: "conv_fecha_dinamica_0001",
      date_iso: dateISO,
      time: "10:00",
      service_id: 1,
      professional_id: "any",
      service_confirmed: true,
    });

    const dentro = await app.inject({
      method: "POST",
      url: "/v1/elevenlabs/availability",
      headers: HEADERS,
      payload: slot(windowEnd) as never,
    });
    expect(dentro.statusCode).toBe(200);

    const fuera = await app.inject({
      method: "POST",
      url: "/v1/elevenlabs/availability",
      headers: HEADERS,
      payload: slot(addDays(windowEnd, 1)) as never,
    });
    expect(fuera.statusCode).toBe(422);
    expect(fuera.json()).toMatchObject({ error: "date_outside_supported_window" });
    // El día de fuera ni siquiera llegó a consultarse.
    expect(asked).toEqual([windowEnd]);
  });

  it("en sintético, window_end_iso también coincide con el último día aceptado", async () => {
    const app = buildElevenLabsSyntheticBridge({
      webhookSecret: WEBHOOK_SECRET,
      salt: HASH_SALT,
      clock: fixedClock("2026-08-04", 9 * 60),
    });
    openApps.push(app);

    const health = (await app.inject({ method: "GET", url: "/health" })).json() as Record<string, unknown>;
    const windowEnd = String(health.window_end_iso);

    const slot = (dateISO: string): Record<string, unknown> => ({
      conversation_id: "conv_fecha_dinamica_0002",
      date_iso: dateISO,
      time: "10:00",
      service_id: 1,
      professional_id: "any",
      service_confirmed: true,
    });

    const dentro = await app.inject({
      method: "POST",
      url: "/v1/elevenlabs/availability",
      headers: HEADERS,
      payload: slot(windowEnd) as never,
    });
    expect(dentro.statusCode).toBe(200);

    const fuera = await app.inject({
      method: "POST",
      url: "/v1/elevenlabs/availability",
      headers: HEADERS,
      payload: slot(addDays(windowEnd, 1)) as never,
    });
    expect(fuera.statusCode).toBe(422);
    expect(fuera.json()).toMatchObject({ error: "date_outside_synthetic_window" });
  });

  it("con el reloj real de Madrid, /health devuelve un contexto coherente consigo mismo", async () => {
    const app = buildElevenLabsSyntheticBridge({
      webhookSecret: WEBHOOK_SECRET,
      salt: HASH_SALT,
      clock: madridClock(),
      realAgenda: { port: emptyPort([]), horizonDays: 6 },
    });
    openApps.push(app);

    const body = (await app.inject({ method: "GET", url: "/health" })).json() as Record<string, unknown>;
    const today = String(body.today);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.today_spoken_es).toBe(spokenDateES(today));
    expect(body.window_end_iso).toBe(addDays(today, 6));
    expect(body.timezone).toBe("Europe/Madrid");
  });
});
