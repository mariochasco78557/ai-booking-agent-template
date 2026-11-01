import type { CalendarWithCapabilities } from "../../callEngine/capabilities.js";
import type { OperationalCalendar, WeeklySchedule } from "../../callEngine/calendar/model.js";
import { SLOT_MINUTES } from "../../callEngine/domain/types.js";
import type { DemoEmployee } from "../model.js";
import { professionalsAndCapabilities } from "./bookingDemoVenue.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL SEGUNDO LOCAL, «Peluquería Aralar (demo)», ENTERAMENTE INVENTADO.
 *
 * No representa a ningún negocio real, no está inspirado en ninguno y no
 * comparte ni una hora, ni una persona, ni un precio con el local principal.
 * Existe por UNA sola razón: para que las pruebas puedan demostrar que el
 * aislamiento entre locales es real —que una reserva de un local no aparece
 * jamás en el otro y que reiniciar uno no borra el otro— contra dos conjuntos
 * de datos que no se parecen en nada.
 *
 * Los nombres «Iratxe» y «Gorka» son inventados y no corresponden a ninguna
 * persona real, exactamente igual que los del local principal.
 *
 * SU HORARIO ES DISTINTO A PROPÓSITO: abre los LUNES (que el local principal
 * cierra), cierra los SÁBADOS (que el principal abre), entra más tarde y su
 * cierre de mediodía dura una hora en vez de dos. Un segundo local que fuese
 * una copia del primero no probaría nada.
 * ────────────────────────────────────────────────────────────────────────
 */

const MON = 1;
const TUE = 2;
const WED = 3;
const THU = 4;
const FRI = 5;

/** Identificadores sintéticos propios, distintos de los del local principal. */
export const IRATXE_ID = 21;
export const GORKA_ID = 22;

/** El «hoy» sintético del segundo local: el mismo martes que el principal. */
export const SEGUNDO_LOCAL_TODAY = "2026-08-25";

/** Horizonte propio, deliberadamente más corto que el del local principal. */
export const SEGUNDO_LOCAL_HORIZON_DAYS = 21;

export const SEGUNDO_LOCAL_EMPLOYEES: readonly DemoEmployee[] = [
  { employeeId: IRATXE_ID, displayName: "Iratxe (sintética)", serviceIds: [0, 1, 2] },
  { employeeId: GORKA_ID, displayName: "Gorka (sintético)", serviceIds: [1, 2] },
];

/** Lunes a viernes 10:00–18:00 con cierre de mediodía de 13:30 a 14:30. Sábado y domingo cerrados. */
function venueWeeklySchedules(): WeeklySchedule[] {
  return [MON, TUE, WED, THU, FRI].map(
    (dayOfWeek): WeeklySchedule => ({
      ownerKind: "venue",
      dayOfWeek,
      workDayStart: "10:00",
      workDayEnd: "18:00",
      breakStart: "13:30",
      breakEnd: "14:30",
    }),
  );
}

export function segundoLocalVenue(): CalendarWithCapabilities {
  const { professionals, capabilities } = professionalsAndCapabilities(SEGUNDO_LOCAL_EMPLOYEES);

  const calendar: OperationalCalendar = {
    professionals,
    weeklySchedules: venueWeeklySchedules(),
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    reservations: [],
    slotMinutes: SLOT_MINUTES,
    bookingHorizonDays: SEGUNDO_LOCAL_HORIZON_DAYS,
    minimumLeadMinutes: 0,
  };

  return { ...calendar, capabilities };
}
