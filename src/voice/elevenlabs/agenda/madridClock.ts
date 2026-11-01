import type { Clock } from "../../../callEngine/domain/types.js";

/**
 * EL RELOJ DE PARED DE Europe/Madrid, Y SÓLO PARA EL MODO real_readonly.
 *
 * El modo sintético sigue corriendo sobre `fixedClock`: su «hoy» es un día
 * inventado del fixture y leer el reloj real allí rompería el determinismo
 * que sostiene toda la suite. En modo real_readonly pasa lo contrario: la
 * agenda del otro lado está fechada en tiempo real, y contestar con un «hoy»
 * de agosto de 2026 sería contestar sobre otro día.
 *
 * El upstream habla wall-clock de Europe/Madrid, sin zona horaria, así que
 * este reloj se calcula con `Intl` en esa zona y NUNCA con la del servidor:
 * un VPS en UTC no debe correr la agenda una o dos horas.
 *
 * `now` se inyecta para poder fijarlo en pruebas; por defecto es el reloj
 * del sistema. Ningún otro módulo del puente lee la hora real.
 */
/**
 * LA ZONA DEL DOMINIO, ESCRITA UNA SOLA VEZ.
 *
 * La declara este módulo porque es aquí donde el «hoy» del puente se define.
 * Todo lo que necesite nombrar la zona —el contexto de fecha que se inyecta
 * en el prompt, `/health`— la importa de aquí en vez de repetir el literal:
 * dos literales pueden desviarse, una constante no.
 */
export const MADRID_TIME_ZONE = "Europe/Madrid";

export function madridClock(now: () => Date = () => new Date()): Clock {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: MADRID_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  function parts(): { dateISO: string; hours: number; minutes: number } {
    const found: Record<string, string> = {};
    for (const part of formatter.formatToParts(now())) {
      if (part.type !== "literal") found[part.type] = part.value;
    }
    const year = found.year ?? "1970";
    const month = found.month ?? "01";
    const day = found.day ?? "01";
    return {
      dateISO: `${year}-${month}-${day}`,
      hours: Number.parseInt(found.hour ?? "0", 10),
      minutes: Number.parseInt(found.minute ?? "0", 10),
    };
  }

  return {
    nowISODate: () => parts().dateISO,
    nowMinutes: () => {
      const { hours, minutes } = parts();
      return hours * 60 + minutes;
    },
    nowInstantISO: () => {
      const { dateISO, hours, minutes } = parts();
      return `${dateISO}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
    },
  };
}
