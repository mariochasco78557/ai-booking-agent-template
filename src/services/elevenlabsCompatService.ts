import type { Clock } from "../callEngine/domain/types.js";
import { UpstreamError } from "../core/calendar/errors.js";
import type { AvailabilityService, SlotOut } from "./availabilityService.js";
import { parseDateTime } from "../utils/dateFormatterEs.js";
import {
  agendaUnavailableAnswer,
  availabilityAnswer,
  decideRealAgenda,
  type RealAgendaDecision,
} from "../voice/elevenlabs/agenda/answers.js";
import type {
  AgendaProfessional,
  AgendaSlot,
  ReadOnlyAgendaDay,
  ReadOnlyAgendaFailureKind,
} from "../voice/elevenlabs/agenda/port.js";
import type { ElevenLabsCompatAvailabilityInput } from "../schemas/elevenlabsCompatSchemas.js";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * LA TRADUCCIÓN, Y SÓLO LA TRADUCCIÓN.
 *
 * Este módulo existe para que migrar ElevenLabs sea cambiar UNA URL y nada
 * más. Recibe el cuerpo que el agente ya envía hoy al puente, pregunta a la
 * agenda por el camino del middleware, y devuelve la MISMA forma de
 * respuesta que el puente devuelve hoy.
 *
 * La fidelidad no se consigue reescribiendo la lógica: se consigue
 * REUTILIZANDO la que ya corre. `decideRealAgenda()` y `availabilityAnswer()`
 * se importan literalmente del puente, así que qué hueco se ofrece, en qué
 * orden se prefiere una alternativa y con qué palabras se dice no se
 * reimplementa aquí — es el mismo código. Lo único que aporta este módulo es
 * la forma de los datos de entrada: convertir la respuesta del
 * `AvailabilityService` del middleware en la «foto del día»
 * (`ReadOnlyAgendaDay`) que ese decisor espera.
 *
 * INVARIANTE: sólo lectura. La única llamada saliente es
 * `availability.getAvailability`, que es un GET al upstream. No hay ninguna
 * ruta desde aquí a una escritura, y `external_mutation` es `false` por
 * construcción en las dos respuestas posibles.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface ElevenLabsCompatDeps {
  availability: AvailabilityService;
  clock: Clock;
  /**
   * El `type` del contrato Symfony con el que se consulta el upstream.
   *
   * DELIBERADAMENTE **no** se deriva de `service_id`. El adaptador que el
   * puente usa hoy (`agenda/legacyReadOnlyAdapter.ts`) consulta siempre con
   * su `typeReservation` configurado y descarta el `service_id` que llega en
   * el cuerpo, porque la correspondencia entre el catálogo hablado (0 barba,
   * 1 corte, 2 corte y barba) y el `type` de Symfony está SIN VERIFICAR más
   * allá de `"1"` (internal doc, not included in the template). `findAvailability()` del
   * middleware sí hace `typeReservation: String(service_id)`, así que
   * enchufar el compat a esa ruta cambiaría lo que se pregunta al upstream
   * para `service_id` 0 y 2 —una consulta con un `type` que nadie ha
   * comprobado— justo en la migración que debe no cambiar nada. Se conserva
   * el comportamiento del puente; la correspondencia se verifica aparte.
   */
  typeReservation: string;
  /**
   * A quién se atribuye un hueco que el upstream devuelve sin empleado.
   * Sólo se usa como respaldo. Con `ENABLE_MULTI_BARBER=false` el upstream
   * contesta por el empleado configurado sin decir cuál es, y el decisor
   * necesita un id para poder hablar de «el mismo profesional». Desde
   * 2026-08-30 el VPS va con la bandera en `true`, así que en la práctica los
   * huecos ya llegan con su `employeeId` real y este respaldo casi no entra.
   */
  defaultEmployeeId: number;
  /** Cuántos días por delante de hoy se admite consultar (el puente usa 6). */
  horizonDays: number;
}

/** "HH:mm" de un `SlotOut`, derivado de `start` y no de `label`. */
function slotTime(slot: SlotOut): string | undefined {
  const parsed = parseDateTime(slot.start);
  if (!parsed) return undefined;
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

/**
 * La respuesta del middleware convertida en la foto del día que
 * `decideRealAgenda` sabe leer. `professionals` se deriva de los propios
 * huecos: es la única plantilla observable por este camino, y una etiqueta
 * ausente la resuelve `labelFor()` del puente con su texto de reserva.
 */
export function toAgendaDay(
  dateISO: string,
  slots: readonly SlotOut[],
  defaultEmployeeId: number,
): ReadOnlyAgendaDay {
  const agendaSlots: AgendaSlot[] = [];
  const labels = new Map<number, string>();

  for (const slot of slots) {
    const time = slotTime(slot);
    if (time === undefined) continue;
    const employeeId = slot.employeeId ?? defaultEmployeeId;
    agendaSlots.push({ time, employeeId });
    const name = slot.employeeName?.trim();
    if (name !== undefined && name !== "" && !labels.has(employeeId)) {
      labels.set(employeeId, name);
    }
  }

  const professionals: AgendaProfessional[] = [...new Set(agendaSlots.map((s) => s.employeeId))]
    .sort((a, b) => a - b)
    .map((employeeId) => ({ employeeId, label: labels.get(employeeId) ?? "" }));

  return { dateISO, professionals, slots: agendaSlots };
}

/** El fallo del upstream reducido a la etiqueta cerrada que el puente habla. */
function failureKind(error: unknown): ReadOnlyAgendaFailureKind {
  if (error instanceof UpstreamError && error.code === "ETIMEDOUT") return "timeout";
  if (error instanceof UpstreamError && error.code === "ECONNABORTED") return "timeout";
  return "unavailable";
}

export class ElevenLabsCompatService {
  constructor(private readonly deps: ElevenLabsCompatDeps) {}

  /** El «hoy» del reloj de Madrid, nunca el del servidor. */
  today(): string {
    return this.deps.clock.nowISODate();
  }

  /** `true` cuando la fecha cae fuera de [hoy, hoy+horizonDays]. */
  outsideWindow(dateISO: string): boolean {
    const today = this.deps.clock.nowISODate();
    const distance = Math.round(
      (Date.parse(`${dateISO}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );
    return Number.isNaN(distance) || distance < 0 || distance > this.deps.horizonDays;
  }

  /** La ventana admitida, para poder decirla en el 422 igual que el puente. */
  windowEnd(): string {
    const today = this.deps.clock.nowISODate();
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + this.deps.horizonDays * 86_400_000);
    return end.toISOString().slice(0, 10);
  }

  /**
   * La consulta de disponibilidad, con la forma de respuesta del puente.
   * Nunca lanza por un fallo del upstream: lo traduce a la respuesta hablada
   * de «fallo técnico», que es lo que el agente sabe decir por teléfono.
   */
  async availability(
    input: ElevenLabsCompatAvailabilityInput,
  ): Promise<Record<string, unknown>> {
    let decision: RealAgendaDecision;
    try {
      const result = await this.deps.availability.getAvailability({
        date: input.date_iso,
        typeReservation: this.deps.typeReservation,
        // Sin `employeeId`: igual que el puente, se lee el día ENTERO y es
        // el decisor quien elige. Filtrar aquí por el profesional pedido
        // impediría la rama «te vale con otra persona», que forma parte del
        // contrato que se está conservando.
        maxSlots: 100,
      });
      const day = toAgendaDay(input.date_iso, result.slots, this.deps.defaultEmployeeId);
      decision = decideRealAgenda(
        day,
        { dateISO: input.date_iso, time: input.time, professional: input.professional_id },
        // `held: []` a propósito: las retenciones en memoria son estado del
        // proceso del puente para su propia herramienta `book`. Este camino
        // no reserva ni retiene nada, así que no hay nada que descontar.
        { clock: this.deps.clock, held: [] },
      );
    } catch (error) {
      return {
        ...agendaUnavailableAnswer(failureKind(error)),
        requested_slot_available: false,
        requires_customer_confirmation: false,
        offered_slots: [],
      };
    }

    return { ...availabilityAnswer(decision) };
  }
}
