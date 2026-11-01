import type { SyntheticReservation } from "../calendar/model.js";
import { isIntervalFree, isWithinHorizon, resolveDayWindows } from "../calendar/resolveAvailability.js";
import { coversInterval } from "../calendar/slotGrid.js";
import { canPerform, type CalendarWithCapabilities } from "../capabilities.js";
import { isStartInThePast } from "../domain/slotTime.js";
import { formatHHmm } from "../domain/time.js";
import type { Clock, EmployeeId, ProfessionalPreference, ServiceId } from "../domain/types.js";
import { chooseProfessional } from "../allocation/anyProfessional.js";
import type { CommandOutcome } from "../shared/commandOutcome.js";
import {
  isAllowedManualDuration,
  manualBookingIdFor,
  manualIntentKey,
  manualReservationIdFor,
  MANUAL_CLIENT_LABEL_RE,
  type ManualBooking,
  type OperationsWrite,
} from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 24 — CREAR UNA CITA MANUAL (diseño §3, §5, §6, §7). PURO.
 *
 * LO QUE ESTE FICHERO **NO** HACE, y es lo más importante de él: no resuelve
 * disponibilidad. No sabe qué días abre el local, ni cuándo es agosto, ni qué
 * festivos hay aprobados, ni quién está de vacaciones. Se lo pregunta a las
 * MISMAS funciones a las que se lo preguntan el motor de llamadas, la lista de
 * espera, el explorador de huecos y las cancelaciones:
 *
 *     canPerform · isStartInThePast · isWithinHorizon · isIntervalFree
 *
 * (step 26 §2 cambió la cuarta —era `isSlotFree`— porque una cita manual ya
 * no dura siempre un hueco de la rejilla: lo que hay que preguntar es si está
 * libre TODO `[inicio, fin)`. La función nueva vive en el mismo módulo que
 * `isSlotFree`, se apoya en la misma `resolveDayWindows` y no añade ni una
 * regla; `isSlotFree` sigue intacta para la voz, el grupo y la lista de espera.)
 *
 * Ésa es toda la demostración de step 24. Dos canales —una llamada y una
 * persona— escriben sobre la misma verdad porque le preguntan a las mismas
 * cuatro funciones sobre el mismo `cal`. Un segundo resolvedor «más simple»
 * aquí dentro convertiría esta misión en su contraria, y por eso el diseño
 * §1.1 lo prohíbe por escrito.
 *
 * LAS CUATRO PROMESAS, sostenidas por la forma del código y no por vigilancia:
 *
 *   1. REVALIDACIÓN DESDE CERO, justo antes de escribir. El cliente manda el
 *      hueco que eligió; aquí no se cree ni una palabra. Se vuelve a preguntar
 *      todo contra el calendario tal y como está en este instante.
 *   2. O SE ESCRIBE ENTERA O NO SE ESCRIBE NADA. Un conflicto devuelve 409 con
 *      `write: null`. No hay media escritura que deshacer porque no hay media
 *      escritura: el llamador aplica UNA descripción, de forma síncrona.
 *   3. DOS PESTAÑAS NO PUEDEN RESERVAR EL MISMO HUECO. Node sirve una petición
 *      por tic y nada de este camino es `async`, así que entre revalidar y
 *      escribir no hay ventana. La segunda revalida con el hueco ya ocupado.
 *   4. REPETIR ES SEGURO, Y CANCELAR ROMPE LA REPETICIÓN. «Ya estaba hecha»
 *      exige que exista esa misma intención Y que su reserva siga `confirmed`.
 *      Si se canceló, decir «ya estaba creada» sería mentir y perder la cita en
 *      silencio — el bloqueante B2 de step 18, que no se reintroduce.
 *
 * NO EMITE NI UN EVENTO DE LLAMADA, no toca ninguna métrica de llamadas, no
 * inventa `callId` ni `callIdHash` y no crea ninguna tarea humana. Una cita
 * manual no tiene llamada: fingir una contaminaría un flujo diseñado para
 * llamadas y falsearía `eventCounts.internal`.
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Formas
// ---------------------------------------------------------------------

/**
 * Lo que manda el cliente. `employeeId` viaja YA RESUELTO —el paso 2 del flujo
 * decidió, con `chooseProfessional`, a quién le toca cuando se pidió
 * «cualquiera»—, exactamente como en la reserva para varias personas (§4.9 de
 * step 18). Que venga resuelto no lo hace de fiar: se revalida igual.
 */
export interface ManualBookingInput {
  clientLabel: string;
  serviceId: ServiceId;
  date: string;
  startMinutes: number;
  /**
   * step 26 §1 — OBLIGATORIO en el dominio: aquí NO hay valor por defecto. El
   * único de toda la capacidad vive en la frontera HTTP, para que una petición
   * que no habla de duración sea, explícitamente, la cita de siempre.
   */
  durationMinutes: number;
  employeeId: EmployeeId;
}

export interface ManualBookingContext {
  cal: CalendarWithCapabilities;
  clock: Clock;
  manualBookings: readonly ManualBooking[];
  /** La secuencia que posee el almacén; un handler puro no puede acuñarla (§4.6.2 de step 18). */
  nextManualNumber: number;
}

/**
 * LA LISTA CERRADA de conflictos que esta acción puede contestar (diseño §8).
 * Cerrada de verdad: si mañana hiciera falta uno más, hay que tocar este tipo,
 * la tabla de frases del servidor y el diseño, en ese orden.
 *
 * step 26 (revisión adversarial, hallazgo 2) añade EXACTAMENTE UNO, siguiendo
 * ese orden: `interval_does_not_fit`. Con citas de duración fija nunca hizo
 * falta —o el inicio caía en un tramo libre y la cita entera cabía, o no caía—,
 * pero con duración flexible aparece una tercera situación real: el inicio SÍ
 * está en un tramo libre y lo que no cabe es la duración pedida. Contarla como
 * «esa persona ya no está disponible a esa hora» sería falso dos veces: esa
 * persona sí está, y a esa hora sí trabaja.
 */
export type ManualBookingConflict =
  | "slot_no_longer_free"
  | "interval_does_not_fit"
  | "professional_no_longer_available"
  | "venue_closed"
  | "date_outside_booking_horizon"
  | "slot_in_the_past"
  | "professional_cannot_perform_service";

export interface ManualBookingOutcome extends CommandOutcome<OperationsWrite> {
  /** Cuando viene, el llamador sustituye `body.booking` por la PROYECCIÓN de esta cita. */
  viewManualBookingId?: string;
}

// ---------------------------------------------------------------------
// Ayudantes
// ---------------------------------------------------------------------

function professionalLabelOf(cal: CalendarWithCapabilities, employeeId: EmployeeId): string {
  return cal.professionals.find((p) => p.employeeId === employeeId)?.displayName ?? `Profesional ${String(employeeId)}`;
}

/**
 * ¿Sigue en pie esta cita manual? Lo decide su RESERVA, no un estado guardado
 * aparte: la vida de la cita es la vida de su reserva (`confirmed` /
 * `cancelled`), así que las dos no pueden discrepar.
 */
function isStillAlive(cal: CalendarWithCapabilities, booking: ManualBooking): boolean {
  return cal.reservations.some((r) => r.id === booking.reservationId && r.status === "confirmed");
}

function conflictOutcome(
  cal: CalendarWithCapabilities,
  conflict: ManualBookingConflict,
  input: ManualBookingInput,
  reasons: readonly string[],
): ManualBookingOutcome {
  return {
    status: 409,
    body: {
      created: false,
      conflict,
      // Lo que hace falta para redactar la frase, sin un solo identificador
      // interno: el INTERVALO que se intentó —principio y fin, más los minutos
      // que se pidieron— y la persona del equipo, ya con su nombre. El fin y la
      // duración entran con step 26 (revisión adversarial, hallazgo 2): sin
      // ellos, una pantalla no puede decirle al operador qué es exactamente lo
      // que no cupo, y `when` a solas invita a suponer que duraba media hora.
      attempted: {
        when: formatHHmm(input.startMinutes),
        until: formatHHmm(input.startMinutes + input.durationMinutes),
        durationMinutes: input.durationMinutes,
        professionalLabel: professionalLabelOf(cal, input.employeeId),
        date: input.date,
      },
      reasons: [...reasons],
    },
    // NO SE ESCRIBE NADA. Ni un evento, ni una tarea, ni una reserva — que es
    // lo que hace comprobable «un conflicto no escribe» comparando la longitud
    // del registro antes y después.
    write: null,
  };
}

/**
 * POR QUÉ ESE HUECO NO ESTÁ LIBRE, dicho con la precisión que merece.
 *
 * «No está libre» tiene tres causas muy distintas y contarlas igual sería peor
 * que callarse: o ese día no se abre, o esa persona no trabaja a esa hora, o
 * ese día se abre, esa persona trabaja, y a esa hora YA HAY UNA CITA.
 *
 * NO SE RESUELVE NADA NUEVO AQUÍ. Se leen dos cosas que ya existen: el
 * veredicto de `resolveDayWindows` —la misma función cuya precedencia decide el
 * horario de agosto, el de septiembre–julio, los cierres, los festivos
 * aprobados, las ausencias y las excepciones— y la colección canónica de
 * reservas. El reparto de niveles es EL MISMO que hace `dayVerdictForOne` en el
 * explorador de huecos, para que las dos pantallas no den nombres distintos a
 * la misma situación.
 *
 * OJO A UNA TRAMPA QUE YA COSTÓ UNA REDACCIÓN: `resolveDayWindows` **resta las
 * reservas confirmadas** en su nivel 7. Preguntarle si la hora cae dentro de
 * sus ventanas para averiguar si el hueco está ocupado contesta siempre que no,
 * precisamente porque está ocupado — y toda cita existente se etiquetaba como
 * «esa persona ya no está disponible». Quien decide que hay una cita es la
 * colección de reservas, que es la fuente canónica de esa pregunta.
 *
 * Y UNA SEGUNDA, QUE step 26 §2 (C9) CORRIGE ANTES DE QUE COSTASE OTRA: la
 * comparación era de PUNTO —¿cae el inicio pedido dentro de esa cita?—, lo que
 * bastaba mientras todas las citas duraban lo mismo. Con duraciones distintas,
 * pedir 09:30–10:30 contra una cita de 10:00–11:30 NO contiene su inicio dentro
 * de la otra, así que el operador habría leído «esa persona ya no está
 * disponible a esa hora» cuando la verdad es «ese hueco acaba de ocuparse». La
 * comparación es ahora de SOLAPAMIENTO DE RANGO, que es la pregunta de verdad y
 * responde igual por los dos extremos.
 *
 * Y UNA TERCERA, DE LA REVISIÓN ADVERSARIAL DE step 26 (hallazgo 2): corregir
 * sólo la rama de «ya hay una cita» dejaba mintiendo a la última. Con el local
 * abierto, la persona trabajando y el inicio dentro de un tramo libre, lo único
 * que falla es que la DURACIÓN no cabe antes de que ese tramo acabe —16:45 más
 * una hora contra un cierre a las 17:30—, y decir «esa persona ya no está
 * disponible a esa hora» es falso dos veces: sí está, y a esa hora sí trabaja.
 * Esa situación tiene ahora nombre propio, `interval_does_not_fit`, y se
 * distingue mirando si el INICIO cae o no dentro de algún tramo libre:
 *   - no cae -> la persona no trabaja a esa hora (lo de siempre);
 *   - cae    -> trabaja, y lo que no entra es lo que se pidió.
 */
function whyNotFree(
  cal: CalendarWithCapabilities,
  employeeId: EmployeeId,
  dateISO: string,
  startMinutes: number,
  endMinutes: number,
):
  | "slot_no_longer_free"
  | "interval_does_not_fit"
  | "venue_closed"
  | "professional_no_longer_available" {
  const ocupado = cal.reservations.some(
    (r) =>
      r.employeeId === employeeId &&
      r.date === dateISO &&
      r.status === "confirmed" &&
      r.startMinutes < endMinutes &&
      startMinutes < r.endMinutes,
  );
  if (ocupado) return "slot_no_longer_free";

  const { windows, appliedLevel } = resolveDayWindows(cal, employeeId, dateISO);
  if (windows.length === 0) {
    // Mismo reparto que el explorador: lo que cierra el LOCAL se dice como
    // cierre; lo que aparta a UNA persona —ausencia o excepción suya— se dice
    // como indisponibilidad de esa persona.
    return appliedLevel === "employee_absence" || appliedLevel === "employee_override"
      ? "professional_no_longer_available"
      : "venue_closed";
  }
  // El día se abre y esa persona trabaja. ¿Empieza el intervalo dentro de un
  // tramo libre suyo? Se pregunta con la MISMA `coversInterval` que decide todo
  // lo demás, sobre el minuto de inicio, para no escribir aquí una segunda
  // aritmética de intervalos.
  const empiezaEnTramoLibre = coversInterval(windows, startMinutes, startMinutes + 1);
  if (empiezaEnTramoLibre) return "interval_does_not_fit";

  // Ni siquiera empieza dentro: descanso, hora fuera de la jornada, o un tramo
  // que su horario no cubre.
  return "professional_no_longer_available";
}

// ---------------------------------------------------------------------
// La revalidación, escrita UNA vez (diseño §6)
// ---------------------------------------------------------------------

/**
 * Las cuatro preguntas, en el ORDEN NORMATIVO del diseño §6, contra el
 * calendario tal y como está en este instante.
 *
 * Vive aquí, en una sola función, porque la contestan DOS caminos: la vista
 * previa que el operador lee antes de confirmar y la escritura que confirma.
 * Si fueran dos cuerpos, el resumen podría prometer una cita que la
 * confirmación rechaza — el peor sitio donde descubrir una discrepancia.
 *
 * EL ORDEN ES LA DECISIÓN. `conflict` es `reasons[0]`, así que es este orden el
 * que decide QUÉ frase verdadera lee el operador. Para un día que ya ha pasado
 * son ciertas dos cosas a la vez —también queda fuera del horizonte—, y la que
 * ayuda es «ese hueco ya ha pasado», no «ese día queda fuera del plazo», que
 * suena a política de calendario y manda a buscar una que no existe. Es la
 * misma enmienda (fase K, H2) que ya rige en la reserva de varias personas.
 */
function revalidate(
  cal: CalendarWithCapabilities,
  clock: Clock,
  input: {
    date: string;
    startMinutes: number;
    durationMinutes: number;
    employeeId: EmployeeId;
    serviceId: ServiceId;
  },
): string[] {
  // EL FIN SE DERIVA, y se deriva UNA sola vez por función (step 26 §1).
  const endMinutes = input.startMinutes + input.durationMinutes;
  const reasons: string[] = [];
  if (!canPerform(cal, input.employeeId, input.serviceId)) reasons.push("professional_cannot_perform_service");
  // `isStartInThePast` sigue mirando SÓLO el inicio: una cita que empieza en el
  // futuro y termina más tarde no está en el pasado. Y `isWithinHorizon` sigue
  // siendo una puerta de día completo. Ninguna de las dos se toca.
  if (isStartInThePast(cal.minimumLeadMinutes, clock, input.date, input.startMinutes)) reasons.push("slot_in_the_past");
  if (!isWithinHorizon(cal, clock, input.date)) reasons.push("date_outside_booking_horizon");
  // LA CUARTA PREGUNTA, y la única que step 26 cambia: el intervalo ENTERO.
  // Un intervalo que quepa entero en las ventanas de `resolveDayWindows` no
  // cruza cierre, ni pausa, ni ausencia, ni otra cita, ni un tramo no laborable.
  if (!isIntervalFree(cal, input.employeeId, input.date, input.startMinutes, endMinutes)) {
    reasons.push(whyNotFree(cal, input.employeeId, input.date, input.startMinutes, endMinutes));
  }
  return reasons;
}

// ---------------------------------------------------------------------
// proposeManualBooking — el paso 5 del flujo, que NO escribe (diseño §4)
// ---------------------------------------------------------------------

/**
 * Lo que el operador pide antes de confirmar. El profesional puede venir sin
 * resolver: «cualquiera» lo decide `chooseProfessional`, la misma función que
 * usan el motor de llamadas y el explorador. **No se inventa ningún algoritmo.**
 */
export interface ManualProposalInput {
  clientLabel: string;
  serviceId: ServiceId;
  date: string;
  startMinutes: number;
  /** step 26 §1 — obligatorio, igual que en la creación: las dos preguntan lo mismo. */
  durationMinutes: number;
  professional: ProfessionalPreference;
}

/** Una propuesta YA RESUELTA. No se ha escrito nada y puede no confirmarse nunca. */
export interface ManualProposal {
  clientLabel: string;
  serviceId: ServiceId;
  employeeId: EmployeeId;
  date: string;
  startMinutes: number;
  endMinutes: number;
  /** `true` si el operador pidió a esa persona por su nombre. Se dice en voz alta en el resumen. */
  professionalWasRequested: boolean;
  /** La intención, derivada del contenido. El servidor acuña la clave a partir de ella. */
  intentKey: string;
}

export type ManualProposalResult =
  | { proposal: ManualProposal; rejected?: undefined }
  | {
      proposal?: undefined;
      rejected: {
        // `duration_not_allowed` NO entra en `ManualBookingConflict`: una
        // duración mal formada es un defecto de la PETICIÓN (400), no un
        // conflicto con el mundo (409). Aquí aparece porque la vista previa
        // contesta con 200 a todo lo que no puede proponer, y también tiene que
        // poder decir esto (step 26 §1).
        conflict: ManualBookingConflict | "no_capable_and_free" | "duration_not_allowed";
        reasons: string[];
      };
    };

/**
 * Resuelve y revalida SIN ESCRIBIR NADA.
 *
 * Contesta exactamente lo mismo que contestaría la confirmación, porque llama a
 * la misma `revalidate`. Un resumen que prometiera algo que la confirmación
 * rechaza sería el peor de los engaños: el operador ya le habría dicho a alguien
 * que tiene cita.
 */
export function proposeManualBooking(ctx: ManualBookingContext, input: ManualProposalInput): ManualProposalResult {
  const { cal, clock } = ctx;

  // La forma de la duración, ANTES que nada: con una duración imposible no hay
  // intervalo que preguntarle al calendario y todo lo demás sería teatro
  // (step 26 §1, mismo patrón defensivo que la etiqueta cerrada).
  if (!isAllowedManualDuration(input.durationMinutes)) {
    return { rejected: { conflict: "duration_not_allowed", reasons: ["duration_not_allowed"] } };
  }

  if (!MANUAL_CLIENT_LABEL_RE.test(input.clientLabel)) {
    return { rejected: { conflict: "no_capable_and_free", reasons: ["client_label_not_in_closed_catalogue"] } };
  }

  // EL FIN SE DERIVA, una sola vez (step 26 §1).
  const endMinutes = input.startMinutes + input.durationMinutes;

  let employeeId: EmployeeId;
  if (input.professional.kind === "specific") {
    employeeId = input.professional.employeeId;
  } else {
    // «Cualquiera»: LA MISMA asignación determinista de siempre, ahora sobre el
    // INTERVALO ENTERO — quien salga elegido es capaz y está libre los N
    // minutos, no sólo en el minuto de inicio (step 26 §2).
    const elegido = chooseProfessional(cal, input.date, input.startMinutes, input.serviceId, input.durationMinutes);
    if (elegido.employeeId === null) {
      return { rejected: { conflict: "no_capable_and_free", reasons: ["no_capable_and_free"] } };
    }
    employeeId = elegido.employeeId;
  }

  const reasons = revalidate(cal, clock, { ...input, employeeId });
  const first = reasons[0];
  if (first !== undefined) {
    return { rejected: { conflict: first as ManualBookingConflict, reasons } };
  }

  return {
    proposal: {
      clientLabel: input.clientLabel,
      serviceId: input.serviceId,
      employeeId,
      date: input.date,
      startMinutes: input.startMinutes,
      endMinutes,
      professionalWasRequested: input.professional.kind === "specific",
      intentKey: manualIntentKey(
        input.date,
        input.startMinutes,
        input.durationMinutes,
        employeeId,
        input.serviceId,
        input.clientLabel,
      ),
    },
  };
}

// ---------------------------------------------------------------------
// createManualBooking (la secuencia normativa del diseño §6, paso a paso)
// ---------------------------------------------------------------------

export function createManualBooking(ctx: ManualBookingContext, input: ManualBookingInput): ManualBookingOutcome {
  const { cal, clock } = ctx;

  // Paso 1 — la forma de la petición. La duración y la etiqueta cerrada se
  // validan TAMBIÉN aquí y no sólo en el esquema HTTP: el dominio no puede
  // depender de que alguien, algún día, no añada una segunda ruta que se salte
  // el esquema. Un 400, nunca un 409: una duración imposible es un defecto de
  // la petición, no un conflicto con el mundo (step 26 §1).
  if (!isAllowedManualDuration(input.durationMinutes)) {
    return {
      status: 400,
      body: {
        created: false,
        code: "duration_not_allowed",
        error: "Esa duración no es válida: sólo se puede elegir en pasos de 15 minutos.",
      },
      write: null,
    };
  }

  if (!MANUAL_CLIENT_LABEL_RE.test(input.clientLabel)) {
    return {
      status: 400,
      body: {
        created: false,
        code: "client_label_not_in_closed_catalogue",
        error: "La persona tiene que ser una del catálogo sintético cerrado.",
      },
      write: null,
    };
  }

  // Paso 2 — la intención, derivada del CONTENIDO (diseño §7.2). La cabecera
  // nunca se compara con esto: los dos lados salen de los mismos datos.
  const intentKey = manualIntentKey(
    input.date,
    input.startMinutes,
    input.durationMinutes,
    input.employeeId,
    input.serviceId,
    input.clientLabel,
  );

  // EL FIN SE DERIVA, y se deriva UNA sola vez en toda la función (step 26 §1).
  const endMinutes = input.startMinutes + input.durationMinutes;

  // Paso 3 — idempotencia ESTRUCTURAL (diseño §7.2). Misma intención Y la
  // reserva todavía en pie. Si se canceló, esto NO es una repetición: cae
  // hacia adelante y crea una cita nueva, que es la verdad.
  const alreadyCreated = ctx.manualBookings.find((b) => b.intentKey === intentKey && isStillAlive(cal, b));
  if (alreadyCreated !== undefined) {
    return {
      status: 200,
      body: { created: false, alreadyExists: true },
      viewManualBookingId: alreadyCreated.id,
      write: {
        events: [
          {
            kind: "RESERVATION_MANUAL_REPEATED",
            actor: "operator",
            atISO: clock.nowInstantISO(),
            reservationId: alreadyCreated.reservationId,
            manualBookingId: alreadyCreated.id,
            synthetic: true,
          },
        ],
      },
    };
  }

  // Paso 4 — REVALIDAR DESDE CERO contra el calendario tal y como está AHORA,
  // con la MISMA función que contestó la vista previa. Es lo único que impide
  // que el resumen prometa una cita que la confirmación rechaza.
  const reasons = revalidate(cal, clock, input);

  const first = reasons[0];
  if (first !== undefined) {
    return conflictOutcome(cal, first as ManualBookingConflict, input, reasons);
  }

  // Paso 5 — acuñar la identidad, construir la cita y entregar la escritura
  // ENTERA. Un único `commit` síncrono aplica la cita, su reserva —en `cal` y
  // en el `MemoryStore`— y su evento, juntos o nada.
  const atISO = clock.nowInstantISO();
  const bookingId = manualBookingIdFor(ctx.nextManualNumber);
  const reservation: SyntheticReservation = {
    id: manualReservationIdFor(bookingId),
    employeeId: input.employeeId,
    serviceId: input.serviceId,
    date: input.date,
    startMinutes: input.startMinutes,
    // LA DURACIÓN QUE PIDIÓ EL OPERADOR, ya validada y ya revalidada contra el
    // calendario minuto a minuto. `SyntheticReservation` no gana ningún campo:
    // `endMinutes` ya existía y es la única forma de decir cuánto dura.
    endMinutes,
    status: "confirmed",
    synthetic: true,
  };
  const booking: ManualBooking = {
    id: bookingId,
    reservationId: reservation.id,
    clientLabel: input.clientLabel,
    serviceId: input.serviceId,
    employeeId: input.employeeId,
    date: input.date,
    startMinutes: reservation.startMinutes,
    endMinutes: reservation.endMinutes,
    intentKey,
    createdAtISO: atISO,
    createdBy: "console-operator",
    synthetic: true,
  };

  return {
    status: 201,
    body: {
      created: true,
      // Campo a campo, nunca un spread de un objeto de dominio.
      reservation: {
        id: reservation.id,
        employeeId: reservation.employeeId,
        serviceId: reservation.serviceId,
        date: reservation.date,
        startMinutes: reservation.startMinutes,
        endMinutes: reservation.endMinutes,
        status: reservation.status,
      },
    },
    viewManualBookingId: booking.id,
    write: {
      manualBookings: [...ctx.manualBookings, booking],
      manualBookingsMinted: 1,
      nextCal: { ...cal, reservations: [...cal.reservations, reservation] },
      // EL MISMO TIC, las dos copias (step 17 §14.4).
      reservationsToAdd: [reservation],
      events: [
        {
          kind: "RESERVATION_MANUAL_CREATED",
          actor: "operator",
          atISO,
          reservationId: reservation.id,
          manualBookingId: booking.id,
          // step 26 (revisión adversarial, hallazgo 3): el registro guardaba
          // la hora de inicio y nada más, así que el acto que de verdad ocurrió
          // —«creó una cita de dos horas y cuarto»— no quedaba escrito en
          // ninguna parte del historial. `durationMinutes` y `endMinutes` son
          // AÑADIDOS: la puerta autoritativa del origen manual sigue siendo la
          // existencia de este evento, y quien la lee no mira el detalle.
          detail: {
            date: input.date,
            serviceId: input.serviceId,
            employeeId: input.employeeId,
            startMinutes: input.startMinutes,
            durationMinutes: input.durationMinutes,
            endMinutes,
            clientLabel: input.clientLabel,
          },
          synthetic: true,
        },
      ],
    },
  };
}
