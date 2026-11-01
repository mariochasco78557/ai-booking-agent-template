import type { CalendarWithCapabilities, CapabilityMatrix } from "../../callEngine/capabilities.js";
import type { OperationalCalendar, WeeklySchedule } from "../../callEngine/calendar/model.js";
import type { EmployeeId, ServiceId, SyntheticProfessional } from "../../callEngine/domain/types.js";
import { SLOT_MINUTES } from "../../callEngine/domain/types.js";
import { ALEX_ID, DANI_ID, NEREA_ID } from "../../callEngine/fixtures/syntheticVenue.js";
import type { DemoEmployee } from "../model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL CUARTO FIXTURE: el local de la demostración web de reservas (fase 1).
 *
 * DELIBERADAMENTE SEPARADO de los tres que ya existen —
 * `baseSyntheticVenue()` (que respalda los escenarios congelados A01..A15),
 * `extendedSyntheticVenue()` (que respalda las suites de calendario y
 * asignación) y `demoSalonVenue()` (que respalda la consola de operador)—. NO SE
 * TOCA NINGUNO DE ELLOS: cambiarles el horario habría movido la
 * disponibilidad que esas suites afirman, y reescribir una prueba para que
 * encaje con un cambio es como una suite se convierte en decorado.
 *
 * QUÉ ES INVENTADO Y QUÉ NO. TODO lo de este fichero es sintético. Los
 * nombres «Álex», «Dani» y «Nerea» son ENTERAMENTE INVENTADOS para esta
 * demostración y NO corresponden a ninguna persona real de Demo Salon: la
 * evidencia pública provisional disponible para esta misión menciona otros
 * nombres, que deliberadamente NO se usan aquí, precisamente para que este
 * módulo no tenga que manejar jamás los datos de una persona real. Los
 * identificadores (3, 6, 9) son los mismos que usan los fixtures existentes,
 * porque son identificadores sintéticos de esta demostración y repetirlos
 * evita inventar un tercer juego de números que signifique lo mismo.
 *
 * EL HORARIO de este fichero es el de la DEMOSTRACIÓN WEB, no el que la
 * consola declara para Demo Salon: aquí hay un cierre de mediodía de dos horas
 * (14:00–16:00) porque el cierre intermedio es lo que hace visible que la
 * duración del servicio condiciona el último inicio de cada tramo.
 *
 * PRECIOS: no hay ni uno en este fichero. Viven en `../tenants.ts`, que es el
 * único módulo de esta capa que conoce dinero.
 * ────────────────────────────────────────────────────────────────────────
 */

// 0 (domingo) y 1 (lunes) NO aparecen a propósito: un día de la semana sin
// fila es un día cerrado, y el motor lo trata como el límite exterior de todo
// el mundo que trabaje dentro del local.
const TUE = 2;
const WED = 3;
const THU = 4;
const FRI = 5;
const SAT = 6;

/**
 * El «hoy» de la demostración: MARTES 2026-08-25. Fijo, como en los fixtures
 * existentes: ninguna función de este árbol lee el reloj real, así que la
 * demostración se comporta igual hoy que dentro de un año.
 */
export const BOOKING_DEMO_TODAY = "2026-08-25";

/**
 * Horizonte de reserva: 30 días desde el «hoy» sintético. Suficiente para que
 * la fase 2 pueda pasear por varias semanas sin que la demostración prometa un
 * año entero de agenda.
 */
export const BOOKING_DEMO_HORIZON_DAYS = 30;

/**
 * El horario DEL LOCAL, como filas `ownerKind: "venue"`.
 *
 * De martes a viernes 09:00–19:00 con cierre de mediodía de 14:00 a 16:00;
 * sábado 09:00–14:00 sin cierre intermedio; lunes y domingo cerrados (sin
 * fila). El cierre intermedio no se resta a mano en ningún sitio: es
 * `breakStart`/`breakEnd`, un concepto de primera clase del modelo, y quien lo
 * aplica es `resolveDayWindows`.
 */
function venueWeeklySchedules(): WeeklySchedule[] {
  return [
    ...[TUE, WED, THU, FRI].map(
      (dayOfWeek): WeeklySchedule => ({
        ownerKind: "venue",
        dayOfWeek,
        workDayStart: "09:00",
        workDayEnd: "19:00",
        breakStart: "14:00",
        breakEnd: "16:00",
      }),
    ),
    { ownerKind: "venue", dayOfWeek: SAT, workDayStart: "09:00", workDayEnd: "14:00" },
  ];
}

/**
 * LA ÚNICA DIFERENCIA DE HORARIO ENTRE PERSONAS: Dani libra los MIÉRCOLES POR
 * LA MAÑANA y entra a las 16:00.
 *
 * Está escrita como una fila semanal PROPIA de Dani —y no como una ausencia—
 * porque «libra los miércoles por la mañana» es una regularidad de su semana,
 * no un hecho con fechas de inicio y fin. El motor la clava contra el horario
 * del local (`intersect`), así que Dani no puede escaparse del local ni
 * abriendo su fila más de la cuenta.
 *
 * Existe para que la rejilla por profesional NO sea trivialmente idéntica: sin
 * ella, las tres columnas del miércoles serían la misma lista y la prueba de
 * la rejilla no demostraría nada.
 *
 * Los otros dos días y las otras dos personas no tienen fila propia A
 * PROPÓSITO: sin fila, el motor adopta el horario del local tal cual, que es
 * exactamente lo que significa «los tres comparten el horario del local».
 */
function daniWednesdaySchedule(): WeeklySchedule[] {
  return [
    {
      ownerKind: "employee",
      employeeId: DANI_ID,
      dayOfWeek: WED,
      workDayStart: "16:00",
      workDayEnd: "19:00",
    },
  ];
}

/**
 * Las tres personas sintéticas y lo que sabe hacer cada una.
 *
 * Nerea NO hace el servicio 0 (Barba), igual que en `extendedSyntheticVenue()`
 * y en `demoSalonVenue()`: así el filtro de capacidades se ejercita de verdad en
 * esta demostración también, en vez de trivialmente.
 */
export const BOOKING_DEMO_EMPLOYEES: readonly DemoEmployee[] = [
  { employeeId: ALEX_ID, displayName: "Álex (sintético)", serviceIds: [0, 1, 2] },
  { employeeId: DANI_ID, displayName: "Dani (sintético)", serviceIds: [0, 1, 2] },
  { employeeId: NEREA_ID, displayName: "Nerea (sintética)", serviceIds: [1, 2] },
];

/**
 * Convierte una lista de personas de esta capa en las dos estructuras que pide
 * el motor: la lista de profesionales del calendario y la matriz de
 * capacidades. Una sola fuente de verdad (`DemoEmployee[]`) y dos vistas
 * derivadas, en vez de tres listas que puedan desviarse entre sí.
 */
export function professionalsAndCapabilities(employees: readonly DemoEmployee[]): {
  professionals: SyntheticProfessional[];
  capabilities: CapabilityMatrix;
} {
  const professionals: SyntheticProfessional[] = employees.map((e) => ({
    employeeId: e.employeeId,
    displayName: e.displayName,
    synthetic: true,
  }));
  const capabilities: CapabilityMatrix = new Map<EmployeeId, ReadonlySet<ServiceId>>(
    employees.map((e) => [e.employeeId, new Set<ServiceId>(e.serviceIds)]),
  );
  return { professionals, capabilities };
}

/**
 * El calendario del local principal de la demostración web.
 *
 * `reservations: []` a propósito: las reservas de esta demostración NO viven
 * en el fixture, viven en el almacén en memoria (`../store.ts`) y se le
 * inyectan al motor en cada consulta. Así «reiniciar la demostración» es
 * vaciar el almacén, y no reconstruir un fixture.
 */
export function bookingDemoVenue(): CalendarWithCapabilities {
  const { professionals, capabilities } = professionalsAndCapabilities(BOOKING_DEMO_EMPLOYEES);

  const calendar: OperationalCalendar = {
    professionals,
    weeklySchedules: [...venueWeeklySchedules(), ...daniWednesdaySchedule()],
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    reservations: [],
    slotMinutes: SLOT_MINUTES,
    bookingHorizonDays: BOOKING_DEMO_HORIZON_DAYS,
    minimumLeadMinutes: 0,
  };

  return { ...calendar, capabilities };
}
