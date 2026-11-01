import { BOOKING_WEB_HOST } from "./config.js";
import { BOOKING_WEB_NOTICE } from "./model.js";
import { startBookingWebServer } from "./server.js";

/**
 * EL ÚNICO PUNTO DE ARRANQUE de la demostración web de reservas
 * (`npm run booking:web:demo`).
 *
 * Está en su propio fichero, y no al final de `server.ts`, para que importar el
 * servidor —cosa que hacen las pruebas— no pueda arrancar nada por accidente.
 * `startBookingWebServer` falla en cerrado: sin `BOOKING_WEB_DEMO_ENABLED` no
 * se abre ningún socket y el proceso termina con un mensaje que explica cómo
 * encenderla a propósito.
 */
startBookingWebServer()
  .then(({ config }) => {
    console.log(
      `Demostración web de reservas escuchando en http://${BOOKING_WEB_HOST}:${String(config.port)}/`,
    );
    console.log(BOOKING_WEB_NOTICE);
    console.log("Pago simulado: no se realiza ningún cargo real en ningún momento.");
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
