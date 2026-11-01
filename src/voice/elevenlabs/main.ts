import type { FastifyInstance } from "fastify";

import { isDirectExecution } from "../../console/directExecution.js";
import {
  loadElevenLabsBridgeAgendaMode,
  loadElevenLabsRealAgendaConfig,
  type ElevenLabsBridgeAgendaMode,
} from "./agenda/config.js";
import { madridClock } from "./agenda/madridClock.js";
import { createRealReadOnlyAgenda } from "./agenda/realAgendaFactory.js";
import {
  ELEVENLABS_BRIDGE_HOST,
  loadElevenLabsBridgeConfig,
  requireElevenLabsBridgeEnabled,
  type ElevenLabsSyntheticAnchor,
} from "./config.js";
import { buildElevenLabsSyntheticBridge, startElevenLabsSyntheticBridge } from "./server.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL ÚNICO PUNTO DE MONTAJE QUE CONOCE LAS DOS AGENDAS.
 *
 * `server.ts` no importa —ni puede importar— el cliente HTTP de Demo Salon: sólo
 * conoce `ReadOnlyAgendaPort`, un puerto con un método de lectura. Este
 * archivo es el que decide, mirando UNA variable, qué se enchufa detrás:
 *
 *   ELEVENLABS_BRIDGE_AGENDA_MODE=synthetic     (por defecto, y sin tocar nada)
 *   ELEVENLABS_BRIDGE_AGENDA_MODE=real_readonly (opt-in, con credenciales y firma)
 *
 * En `synthetic` delega LITERALMENTE en `startElevenLabsSyntheticBridge`, el
 * arranque que ya existía: mismo fixture, mismo reloj fijo, mismo puerto,
 * misma respuesta. No hay una segunda implementación del modo de siempre que
 * pueda desviarse de la primera.
 *
 * En `real_readonly` pide la agenda real a `agenda/realAgendaFactory.ts` —el
 * único fichero del puente autorizado a construir un cliente HTTP— y arranca
 * el mismo servidor con esa agenda detrás. Ni este archivo ni `server.ts`
 * importan `axios`, `../../clients/**` o `../../services/**`: no es una
 * decisión de tiempo de ejecución, es que aquí no existe ningún símbolo con
 * el que escribir en el Symfony.
 * ────────────────────────────────────────────────────────────────────────
 */

export interface StartedElevenLabsBridge {
  app: FastifyInstance;
  host: typeof ELEVENLABS_BRIDGE_HOST;
  port: number;
  mode: ElevenLabsBridgeAgendaMode;
  /** El día/hora sintéticos. Presente SÓLO en modo `synthetic`. */
  anchor?: ElevenLabsSyntheticAnchor;
  /** El «hoy» real de Europe/Madrid. Presente SÓLO en modo `real_readonly`. */
  today?: string;
  /** Quién firmó la autorización de lectura real. Presente SÓLO en `real_readonly`. */
  authorizationRef?: string;
}

export async function startElevenLabsBridge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedElevenLabsBridge> {
  const mode = loadElevenLabsBridgeAgendaMode(env);
  if (mode === "synthetic") {
    const started = await startElevenLabsSyntheticBridge(env);
    return { app: started.app, host: started.host, port: started.port, mode, anchor: started.anchor };
  }

  const config = loadElevenLabsBridgeConfig(env);
  requireElevenLabsBridgeEnabled(config);
  // Falla cerrado: sin credenciales, sin URL o sin la autorización humana
  // firmada, esto LANZA. Nunca cae en silencio a la agenda sintética — un
  // operador que pidió agenda real y recibe fixture sin enterarse es
  // exactamente el fallo que esta puerta existe para impedir.
  const agenda = loadElevenLabsRealAgendaConfig(env);

  // Lo que vuelve es un `ReadOnlyAgendaPort`: un método de lectura y ninguno
  // más. La mitad de escritura de la puerta E5 no está desactivada, es que no
  // ha llegado hasta aquí.
  const port = createRealReadOnlyAgenda(agenda);

  const clock = madridClock();
  const app = buildElevenLabsSyntheticBridge({
    webhookSecret: config.webhookSecret,
    salt: config.callHashSalt,
    clock,
    realAgenda: { port, horizonDays: agenda.horizonDays },
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
      throw new Error(`El puerto ${config.port} ya está en uso; el puente ElevenLabs no cambia de puerto en silencio.`);
    }
    throw error;
  }

  return {
    app,
    host: config.host,
    port: config.port,
    mode,
    today: clock.nowISODate(),
    authorizationRef: agenda.authorizationRef,
  };
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  startElevenLabsBridge()
    .then((started) => {
      console.log(`Puente ElevenLabs escuchando en http://${started.host}:${String(started.port)}/`);
      if (started.mode === "synthetic") {
        console.log(`Modo sintético · «hoy» ${started.anchor?.today ?? "?"} a las ${started.anchor?.nowTime ?? "?"}`);
        console.log("Datos sintéticos · Sin producción · Sin mutaciones externas");
        return;
      }
      console.log(`Modo real_readonly · «hoy» real de Europe/Madrid: ${started.today ?? "?"}`);
      console.log(`Lectura autorizada por: ${started.authorizationRef ?? "?"}`);
      console.log("SOLO LECTURA · Ninguna reserva se crea, mueve ni cancela en el sistema real");
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
