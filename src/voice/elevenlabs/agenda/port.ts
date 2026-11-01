import type { ServiceId } from "../../../callEngine/domain/types.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL PUERTO DE AGENDA **DE SOLO LECTURA** DEL PUENTE DE VOZ (puerta E5-lectura).
 *
 * Este módulo es deliberadamente la ÚNICA superficie por la que el puente
 * puede tocar una agenda que no sea el fixture sintético, y declara UN solo
 * método: `readDay`. No hay `createReservation`, no hay `deleteReservation`,
 * no hay lookup de clientes. Eso no es una convención ni un comentario de
 * buenas intenciones: `server.ts` recibe un valor de tipo
 * {@link ReadOnlyAgendaPort} y `tsc` rechaza cualquier intento de llamar a
 * un método de escritura sobre él, aunque alguien lo escriba por error. La
 * mitad de ESCRITURA de la puerta E5 sigue cerrada, y cerrarla por tipos es
 * lo que impide que se abra por descuido.
 *
 * Tampoco viaja por aquí ni un solo dato de CLIENTE. Lo único que cruza el
 * puerto son datos operativos del negocio: qué profesionales trabajan ese
 * día y qué huecos tienen libres. Ningún nombre, teléfono, referencia de
 * reserva ni identidad de quien llama — ni de entrada ni de salida.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Un profesional del negocio (dato operativo, no PII de cliente), tal y como
 * lo habla el puente: id numérico y una etiqueta corta para decirla en voz
 * alta. El adaptador real usa SOLO el nombre de pila del upstream, nunca
 * apellidos, porque para decir «¿te vale con Bruno?» no hace falta más.
 */
export interface AgendaProfessional {
  employeeId: number;
  label: string;
}

/** Un hueco libre concreto: hora local Europe/Madrid en "HH:mm" y de quién es. */
export interface AgendaSlot {
  /** "HH:mm" en hora local de Europe/Madrid (wall-clock), como habla el puente. */
  time: string;
  employeeId: number;
}

/**
 * La foto de UN día de agenda. `professionals` es la plantilla que trabaja
 * ese día; `slots` son los huecos libres ya normalizados a "HH:mm". Un día
 * cerrado es una foto válida con las dos listas vacías, nunca un error.
 */
export interface ReadOnlyAgendaDay {
  dateISO: string;
  professionals: readonly AgendaProfessional[];
  slots: readonly AgendaSlot[];
}

export interface ReadOnlyAgendaDayQuery {
  /** "YYYY-MM-DD" en hora local de Europe/Madrid. */
  dateISO: string;
  /**
   * Servicio pedido (catálogo histórico 0/1/2). Viaja hasta el adaptador
   * porque es él quien decide cómo se traduce —si es que se traduce— al
   * `type` del contrato Symfony. Esa correspondencia está SIN VERIFICAR
   * ((internal doc, not included in the template) sólo documenta `type=1`), así que el
   * adaptador no la inventa: consulta con su tipo configurado y lo deja
   * escrito.
   */
  serviceId: ServiceId;
}

/** Por qué no hay foto del día. Etiquetas nuestras, nunca texto del upstream. */
export type ReadOnlyAgendaFailureKind = "timeout" | "unavailable";

/**
 * El único error que el puerto deja salir. Lleva una etiqueta cerrada y
 * NADA más: ni status HTTP, ni cuerpo del upstream, ni mensaje de axios, ni
 * URL. Lo que el puente pueda contar por teléfono se decide con la etiqueta;
 * el detalle se queda donde se produjo.
 */
export class ReadOnlyAgendaError extends Error {
  readonly kind: ReadOnlyAgendaFailureKind;

  constructor(kind: ReadOnlyAgendaFailureKind) {
    super(`agenda de solo lectura no disponible (${kind})`);
    this.name = "ReadOnlyAgendaError";
    this.kind = kind;
  }
}

/**
 * El puerto. Un método, de lectura, y ninguno más — ver el docblock del
 * módulo. Cualquier implementación (real o de prueba) es intercambiable y el
 * puente no distingue una de otra.
 */
export interface ReadOnlyAgendaPort {
  readDay(query: ReadOnlyAgendaDayQuery): Promise<ReadOnlyAgendaDay>;
}
