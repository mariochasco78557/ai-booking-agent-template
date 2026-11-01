import { resolveDayWindows } from "../callEngine/calendar/resolveAvailability.js";
import type { CalendarWithCapabilities } from "../callEngine/capabilities.js";
import { addDays, dayOfWeek, formatHHmm } from "../callEngine/domain/time.js";
import {
  openingWindowLabel,
  PUBLIC_WEEK_DAYS,
  weekdayLabel,
  type DemoEmployee,
  type OpeningDayView,
  type OpeningWindow,
} from "./model.js";
import type { TenantDefinition } from "./tenants.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL HORARIO DE APERTURA DEL LOCAL, DERIVADO DEL MOTOR Y DE NADA MÁS.
 *
 * Este módulo nace al sacar `openingWindowsFor` de `server.ts` —que lo
 * re-exporta para no cambiar su superficie pública— porque desde la fase de la
 * web pública lo necesitan dos consumidores que no se conocen entre sí:
 * `GET /api/:tenantId/availability`, que lo publica por día consultado, y la
 * sección de información práctica, que publica la semana entera. Una función
 * compartida por dos vías no puede vivir dentro de la ruta de una de ellas.
 *
 * AQUÍ NO SE LEE EL RELOJ REAL. La semana que se publica es la del «hoy»
 * sintético del local (`TenantDefinition.demoToday`), igual que la que ve el
 * asistente de reserva: si esta sección mirase la hora de la máquina, la
 * portada podría decir que hoy es jueves mientras el calendario ofrece huecos
 * de un martes de otra semana.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * LOS TRAMOS DE APERTURA DEL LOCAL ese día, calculados por el MOTOR.
 *
 * No hay ninguna hora de corte escrita a mano aquí ni en la interfaz: se pide
 * a `resolveDayWindows` —la misma función cuya precedencia de siete niveles
 * decide la disponibilidad— la ventana de CADA persona del local y se fusiona
 * la unión (solapadas y contiguas se funden; el resultado va ordenado). El
 * local abre cuando abre para alguien, así que la unión es exactamente «el
 * horario del local», sin restarlo ni sumarlo a mano.
 *
 * DOS DECISIONES QUE NO SON UN DETALLE:
 *
 * 1. Se pasan TODAS las personas del local, no las capaces de hacer el
 *    servicio consultado ni la que se haya elegido en el filtro. Si sólo se
 *    pasara la persona filtrada, una vista de «sólo Dani» —que los miércoles
 *    entra a las 16:00— convertiría su turno en un tramo propio y único, y su
 *    16:00 se rotularía «Horario» en vez de caer, como cae, dentro de la tarde
 *    del local. El tramo es del LOCAL; el filtro sólo decide qué huecos se
 *    ofrecen dentro de él.
 *
 * 2. Se resuelve sobre un calendario SIN reservas. Es apertura, no
 *    disponibilidad: una franja entera reservada no cierra el local a
 *    mediodía, y si contara, el nivel 7 del motor partiría la mañana en dos y
 *    el día pasaría a rotularse «Tramo 1/2/3» según lo que hubiera reservado
 *    antes —exactamente la clase de rótulo movedizo que este campo elimina—.
 *    No se salta ningún nivel: se le da al nivel 7 una lista vacía, igual que
 *    hace `calendar/impact.ts` cuando necesita la ventana sin una reserva
 *    concreta.
 *
 * Las horas siguen saliendo íntegras de `freeStartsForDuration`; esto sólo
 * dice DÓNDE cae cada una.
 */
export function openingWindowsFor(
  cal: CalendarWithCapabilities,
  employees: readonly DemoEmployee[],
  date: string,
): OpeningWindow[] {
  const opening: CalendarWithCapabilities = { ...cal, reservations: [] };
  const all = employees
    .flatMap((e) => resolveDayWindows(opening, e.employeeId, date).windows)
    .filter((w) => w.endMinutes > w.startMinutes)
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);

  const merged: { startMinutes: number; endMinutes: number }[] = [];
  for (const w of all) {
    const last = merged[merged.length - 1];
    // `<=` y no `<`: dos tramos que se tocan (uno acaba a las 14:00 y otro
    // empieza a las 14:00) son un solo tramo de apertura, no dos.
    if (last !== undefined && w.startMinutes <= last.endMinutes) {
      last.endMinutes = Math.max(last.endMinutes, w.endMinutes);
    } else {
      merged.push({ startMinutes: w.startMinutes, endMinutes: w.endMinutes });
    }
  }

  return merged.map((w, index) => ({
    index,
    startMinutes: w.startMinutes,
    endMinutes: w.endMinutes,
    label: openingWindowLabel(index, merged.length),
    rangeLabel: `${formatHHmm(w.startMinutes)}–${formatHHmm(w.endMinutes)}`,
  }));
}

/**
 * LA SEMANA NATURAL DEL «HOY» SINTÉTICO DEL LOCAL, de lunes a domingo.
 *
 * Los siete días salen de sumarle días a `demoToday` con `addDays` y de
 * preguntarle el día de la semana a `dayOfWeek`, las dos del motor: en todo
 * este módulo no se construye una fecha, no se lee el reloj de la máquina y no
 * se resta un milisegundo (`addDays` pivota por el mediodía UTC precisamente
 * para que un cambio de hora estacional no mueva un día de sitio).
 *
 * ARRANCA EN LUNES aunque el motor cuente desde el domingo. El giro se hace
 * UNA sola vez y aquí: `dayOfWeek` devuelve 0 para domingo, así que
 * `(dow + 6) % 7` da cuántos días han pasado desde el lunes, y se retrocede
 * esa cantidad. Un local cuyo «hoy» caiga en domingo retrocede seis días y
 * publica su propia semana, no la siguiente.
 *
 * QUÉ NO HACE: no mira si un día está dentro del horizonte de reserva ni si
 * queda algún hueco libre. Esto es APERTURA —cuándo abre la puerta—, y por eso
 * el mismo día puede aparecer abierto aquí y sin huecos en el asistente.
 */
export function openingWeekFor(tenant: TenantDefinition): OpeningDayView[] {
  const desplazamientoALunes = -((dayOfWeek(tenant.demoToday) + 6) % 7);
  const lunes = addDays(tenant.demoToday, desplazamientoALunes);

  return Array.from({ length: PUBLIC_WEEK_DAYS }, (_sinUsar, i): OpeningDayView => {
    const date = addDays(lunes, i);
    const windows = openingWindowsFor(tenant.calendar, tenant.employees, date);
    return {
      date,
      weekdayLabel: weekdayLabel(dayOfWeek(date)),
      windows,
      open: windows.length > 0,
    };
  });
}
