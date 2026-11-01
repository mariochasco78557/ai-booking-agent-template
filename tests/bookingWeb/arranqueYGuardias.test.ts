import { describe, expect, it } from "vitest";

import {
  BOOKING_WEB_HOST,
  DEFAULT_BOOKING_WEB_PORT,
  loadBookingWebConfig,
  requireBookingWebEnabled,
} from "../../src/bookingWeb/config.js";
import { BOOKING_WEB_CSP, buildBookingWebServer, startBookingWebServer } from "../../src/bookingWeb/server.js";
import { TENANT_BOOKING_DEMO } from "../../src/bookingWeb/tenants.js";
import { freshApp, type Json } from "./helpers.js";

/**
 * ARRANQUE EN CERRADO Y GUARDIAS POR PETICIÓN.
 *
 * Ninguna prueba de este fichero abre un puerto: se comprueba que el arranque
 * SE NIEGA cuando la demostración no está encendida, y que construir el
 * servidor para inyectar peticiones —que no escucha nada— sigue funcionando.
 */

describe("Demostración web · configuración", () => {
  it("está apagada por defecto y escucha sólo en 127.0.0.1", () => {
    const config = loadBookingWebConfig({});
    expect(config.enabled).toBe(false);
    expect(config.host).toBe("127.0.0.1");
    expect(config.host).toBe(BOOKING_WEB_HOST);
    expect(config.port).toBe(DEFAULT_BOOKING_WEB_PORT);
    expect(config.port).toBe(4330);
    // El 3000 pertenece a un proceso ajeno de este equipo: nunca es el puerto
    // por defecto de nada de esta demostración.
    expect(config.port).not.toBe(3000);
  });

  it("el puerto se puede cambiar por entorno; el host, no", () => {
    const config = loadBookingWebConfig({ BOOKING_WEB_PORT: "4399", HOST: "0.0.0.0" });
    expect(config.port).toBe(4399);
    expect(config.host).toBe("127.0.0.1");
  });

  it("«1» y «true» encienden la demostración; cualquier otra cosa la deja apagada", () => {
    expect(loadBookingWebConfig({ BOOKING_WEB_DEMO_ENABLED: "1" }).enabled).toBe(true);
    expect(loadBookingWebConfig({ BOOKING_WEB_DEMO_ENABLED: "true" }).enabled).toBe(true);
    for (const valor of ["", "0", "false", "sí", "yes", "TRUE"]) {
      expect(loadBookingWebConfig({ BOOKING_WEB_DEMO_ENABLED: valor }).enabled, valor).toBe(false);
    }
  });

  it("`requireBookingWebEnabled` lanza con un mensaje que explica cómo encenderla", () => {
    expect(() => {
      requireBookingWebEnabled(loadBookingWebConfig({}));
    }).toThrow(/BOOKING_WEB_DEMO_ENABLED/);
  });
});

describe("Demostración web · fallo en cerrado", () => {
  it("sin BOOKING_WEB_DEMO_ENABLED, `startBookingWebServer` se niega a arrancar", async () => {
    await expect(startBookingWebServer({})).rejects.toThrow(
      /La demostración web de reservas está desactivada/,
    );
  });

  it("pero construir el servidor para pruebas sigue funcionando, porque construir no es escuchar", async () => {
    const app = buildBookingWebServer();
    const res = await app.inject({ method: "GET", url: `/api/${TENANT_BOOKING_DEMO}/bootstrap` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("Demostración web · guardias por petición", () => {
  it("una cabecera Host ajena se rechaza con 403 (defensa contra revinculación de DNS)", async () => {
    const app = freshApp();
    // Un `Host` AUSENTE también se rechaza en producción (`isAllowedHostHeader`
    // contesta que no), pero no se puede comprobar por aquí: `inject` sustituye
    // la cabecera vacía por la suya («localhost:80»). Todo cliente HTTP/1.1 está
    // obligado a mandarla, así que el caso interesante es el que sí se prueba
    // aquí: una cabecera PRESENTE con basura detrás del nombre.
    for (const host of [
      "evil.example",
      "127.0.0.1.evil.example",
      "[::1].evil.example",
      "localhost:4330@evil.example",
      "localhost:notaport",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/${TENANT_BOOKING_DEMO}/bootstrap`,
        headers: { host },
      });
      expect(res.statusCode, host).toBe(403);
    }
  });

  it("los tres nombres locales sí pasan", async () => {
    const app = freshApp();
    for (const host of ["localhost", "127.0.0.1:4330", "[::1]:4330"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/${TENANT_BOOKING_DEMO}/bootstrap`,
        headers: { host },
      });
      expect(res.statusCode, host).toBe(200);
    }
  });

  it("toda respuesta lleva la CSP estricta y las cabeceras de seguridad", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: `/api/${TENANT_BOOKING_DEMO}/bootstrap` });
    expect(res.headers["content-security-policy"]).toBe(BOOKING_WEB_CSP);
    expect(BOOKING_WEB_CSP).toContain("default-src 'none'");
    expect(BOOKING_WEB_CSP).toContain("script-src 'self'");
    expect(BOOKING_WEB_CSP).toContain("style-src 'self'");
    expect(BOOKING_WEB_CSP).toContain("connect-src 'self'");
    expect(BOOKING_WEB_CSP).toContain("img-src 'self'");
    expect(BOOKING_WEB_CSP).not.toContain("unsafe-inline");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("el arranque de la demostración anuncia su propio aviso de entorno ficticio", async () => {
    const app = freshApp();
    const res = await app.inject({ method: "GET", url: `/api/${TENANT_BOOKING_DEMO}/bootstrap` });
    const body = res.json() as Json;
    expect(body.notice).toBe("Entorno de demostración · Datos ficticios");
    expect(body.demoToday).toBe("2026-08-25");
    expect(body.paymentOptions).toEqual([
      { value: "pay_now_demo", label: "Pagar ahora (demo)" },
      { value: "pay_at_salon", label: "Pagar en el local" },
    ]);
  });
});
