/**
 * Traducción de `cliente.yaml` a lo que necesita el adaptador `google-calendar`:
 * empleados (id numérico del puerto + calendario de Google), servicios con
 * duración, horario por día de la semana, cierres y zona horaria.
 */
import {
  closedWeekdayNumbers,
  DIAS_SEMANA,
  employeeResourceId,
  type ClientConfig,
} from "../../../core/config/clientConfig.js";
import { parseHhmm } from "./timezone.js";

export interface GoogleEmployee {
  /** Id numérico del recurso en el puerto (`empleados[].id`, o posición 1..n). */
  id: number;
  /** Nombre y apellidos tal y como los devuelve el puerto. */
  name: string;
  surnames: string;
  /** Id del calendario de Google donde viven sus citas. */
  calendarId: string;
}

export interface GoogleService {
  id: string;
  name: string;
  durationMin: number;
}

export interface GoogleCalendarSettings {
  timeZone: string;
  employees: GoogleEmployee[];
  services: GoogleService[];
  /** Duración si el servicio no se encuentra (`duracion_cita_min`). */
  defaultDurationMin: number;
  /** Separación entre inicios de hueco (`calendario.google.paso_min`, por defecto `duracion_cita_min`). */
  stepMin: number;
  /** Modo calendario único (`calendario.google.calendario_unico`). */
  singleCalendarId?: string;
  /** Franjas `[inicio, fin)` en minutos por día de la semana (0 = domingo). */
  openingHours: Record<number, Array<[number, number]>>;
  closedWeekdays: ReadonlySet<number>;
  /** Hora (minutos) desde la que ya no empieza ningún hueco, por día de la semana. */
  earlyClose: Record<number, number>;
  /** Cierres por fechas (`cierres`), inclusivos. */
  closures: Array<{ from: string; to: string }>;
}

export function googleSettingsFromClientConfig(cfg: ClientConfig): GoogleCalendarSettings {
  if (cfg.horario === undefined) {
    throw new Error("google-calendar necesita `horario` en cliente.yaml (franjas por día)");
  }
  const google = cfg.calendario.google;
  const single = google?.calendario_unico;
  const employees = cfg.empleados.map((e, index) => ({
    id: employeeResourceId(e, index),
    name: e.nombre_agenda ?? e.nombre,
    surnames: e.apellidos_agenda ?? "",
    calendarId: single ?? String(e.calendario),
  }));
  const ids = new Set(employees.map((e) => e.id));
  if (ids.size !== employees.length) {
    throw new Error("google-calendar: empleados[].id repetido en cliente.yaml");
  }
  const openingHours: Record<number, Array<[number, number]>> = {};
  DIAS_SEMANA.forEach((dia, weekday) => {
    openingHours[weekday] = (cfg.horario?.[dia] ?? []).map((franja) => {
      const [a, b] = franja.split("-") as [string, string];
      return [parseHhmm(a), parseHhmm(b)];
    });
  });
  const earlyClose: Record<number, number> = {};
  for (const [dia, hora] of Object.entries(cfg.cierre_temprano ?? {})) {
    earlyClose[DIAS_SEMANA.indexOf(dia as (typeof DIAS_SEMANA)[number])] = parseHhmm(hora as string);
  }
  return {
    timeZone: cfg.zona_horaria,
    employees,
    services: cfg.servicios.map((s, index) => ({
      id: s.id !== undefined ? String(s.id) : String(index + 1),
      name: s.nombre,
      durationMin: s.duracion_min,
    })),
    defaultDurationMin: cfg.duracion_cita_min,
    stepMin: google?.paso_min ?? cfg.duracion_cita_min,
    ...(single !== undefined ? { singleCalendarId: single } : {}),
    openingHours,
    closedWeekdays: new Set(closedWeekdayNumbers(cfg)),
    earlyClose,
    closures: (cfg.cierres ?? []).map((c) => ({ from: c.desde, to: c.hasta })),
  };
}
