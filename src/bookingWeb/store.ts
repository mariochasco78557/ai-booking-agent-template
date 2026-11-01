import type { EmployeeId, ServiceId } from "../callEngine/domain/types.js";
import type { SyntheticReservation } from "../callEngine/calendar/model.js";
import type { DemoBooking, PaymentOption } from "./model.js";
import { buildSyntheticPayment } from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL ALMACÉN EN MEMORIA DE LA DEMOSTRACIÓN WEB.
 *
 * DETERMINISTA DE PRINCIPIO A FIN: no lee el reloj real, no usa azar y no
 * toca la red ni el disco. Los identificadores son SECUENCIALES por local
 * (`demo-salon-demo-1`, `demo-salon-demo-2`, …), así que dos ejecuciones de la misma
 * secuencia de peticiones producen exactamente los mismos datos, byte a byte.
 * Es lo que permite que las pruebas comparen listas enteras en vez de muestreos.
 *
 * TODO ESTÁ INDEXADO POR `tenantId`. Cada local tiene su propia lista de
 * reservas, su propio registro de claves de idempotencia y su propio contador.
 * No existe ninguna función que devuelva las reservas de más de un local, así
 * que una fuga entre locales no es un descuido posible: habría que escribir
 * una función nueva para expresarla.
 *
 * LA IDEMPOTENCIA VIVE AQUÍ, JUNTO AL DATO QUE PROTEGE. Una repetición de la
 * MISMA confirmación (misma clave, misma petición) devuelve LA MISMA reserva,
 * sin crear una segunda ni cobrar un segundo pago sintético. Una repetición de
 * la misma clave con una petición DISTINTA es un choque y no ejecuta nada: dos
 * reservas diferentes con la misma clave son un error del cliente, y contestar
 * a una con la otra sería mentir.
 *
 * SIN CADUCIDAD Y SIN TEMPORIZADOR, por el mismo motivo que en la consola: una
 * caducidad necesita un reloj real, y aquí no hay ninguno. La demostración se
 * vacía con `reset`, que es explícito y lo hace un humano.
 * ────────────────────────────────────────────────────────────────────────
 */

export interface ConfirmBookingInput {
  tenantId: string;
  serviceId: ServiceId;
  employeeId: EmployeeId;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  paymentOption: PaymentOption;
  /** Precio TOTAL en céntimos, ya resuelto por quien conoce el catálogo del local. */
  amountTotalCents: number;
  idempotencyKey: string;
  /** Huella canónica de la petición, para detectar una clave reutilizada con otro cuerpo. */
  fingerprint: string;
}

export type IdempotencyLookup =
  | { kind: "miss" }
  /** Misma clave, misma petición: aquí está la reserva de la primera vez. */
  | { kind: "replay"; booking: DemoBooking }
  /** Misma clave, petición distinta: no se ejecuta nada. */
  | { kind: "collision" };

export interface BookingStore {
  /**
   * Consulta la clave ANTES de revalidar la disponibilidad. El orden importa:
   * la reserva que creó la primera petición ocupa el hueco, así que revalidar
   * primero convertiría cualquier repetición legítima en un «hueco ocupado».
   */
  lookupIdempotency(tenantId: string, key: string, fingerprint: string): IdempotencyLookup;
  /** Escribe la reserva y su pago sintético, y recuerda la clave. Síncrono, sin ventanas. */
  confirm(input: ConfirmBookingInput): DemoBooking;
  /** Las reservas de UN local, en orden de creación. Nunca las de otro. */
  list(tenantId: string): readonly DemoBooking[];
  /** Una reserva concreta de UN local. */
  find(tenantId: string, bookingId: string): DemoBooking | undefined;
  /**
   * Vacía reservas, pagos e idempotencia. Con `tenantId`, sólo ese local;
   * sin él, todos. Devuelve cuántas reservas se borraron.
   */
  reset(tenantId?: string): number;
}

interface TenantState {
  bookings: DemoBooking[];
  /** clave de idempotencia -> huella + identificador de la reserva que produjo. */
  keys: Map<string, { fingerprint: string; bookingId: string }>;
  nextSeq: number;
}

function freshTenantState(): TenantState {
  return { bookings: [], keys: new Map(), nextSeq: 1 };
}

export function createBookingStore(): BookingStore {
  const byTenant = new Map<string, TenantState>();

  function stateOf(tenantId: string): TenantState {
    let state = byTenant.get(tenantId);
    if (state === undefined) {
      state = freshTenantState();
      byTenant.set(tenantId, state);
    }
    return state;
  }

  return {
    lookupIdempotency(tenantId, key, fingerprint) {
      const state = stateOf(tenantId);
      const record = state.keys.get(key);
      if (record === undefined) return { kind: "miss" };
      if (record.fingerprint !== fingerprint) return { kind: "collision" };
      const booking = state.bookings.find((b) => b.id === record.bookingId);
      // Una clave apuntando a una reserva que ya no existe sólo puede pasar si
      // alguien vació las reservas sin vaciar las claves. `reset` vacía las dos
      // a la vez, así que este camino es inalcanzable; se trata como un fallo
      // de la clave (no hay nada que repetir) en vez de reventar.
      if (booking === undefined) return { kind: "miss" };
      return { kind: "replay", booking };
    },

    confirm(input) {
      const state = stateOf(input.tenantId);
      const seq = state.nextSeq;
      state.nextSeq = seq + 1;
      const booking: DemoBooking = {
        id: `${input.tenantId}-${String(seq)}`,
        tenantId: input.tenantId,
        serviceId: input.serviceId,
        employeeId: input.employeeId,
        date: input.date,
        startMinutes: input.startMinutes,
        durationMinutes: input.durationMinutes,
        status: "confirmed",
        payment: buildSyntheticPayment(input.paymentOption, input.amountTotalCents),
      };
      state.bookings.push(booking);
      state.keys.set(input.idempotencyKey, {
        fingerprint: input.fingerprint,
        bookingId: booking.id,
      });
      return booking;
    },

    list(tenantId) {
      return [...stateOf(tenantId).bookings];
    },

    find(tenantId, bookingId) {
      return stateOf(tenantId).bookings.find((b) => b.id === bookingId);
    },

    reset(tenantId) {
      if (tenantId !== undefined) {
        const state = byTenant.get(tenantId);
        const removed = state?.bookings.length ?? 0;
        byTenant.set(tenantId, freshTenantState());
        return removed;
      }
      let removed = 0;
      for (const state of byTenant.values()) removed += state.bookings.length;
      byTenant.clear();
      return removed;
    },
  };
}

/**
 * Traduce las reservas de la demostración al tipo que el motor de calendario
 * entiende, para que `resolveDayWindows` las reste en su nivel 7 exactamente
 * igual que resta las de cualquier otro calendario.
 *
 * Es la ÚNICA aritmética de tiempo de este módulo, y es una suma: el final es
 * el inicio más la duración. Los huecos, los tramos, la pausa de mediodía y el
 * último inicio posible los sigue calculando el motor, sin una segunda
 * implementación que pueda desviarse de la primera.
 */
export function toSyntheticReservations(
  bookings: readonly DemoBooking[],
): SyntheticReservation[] {
  return bookings.map((b) => ({
    id: b.id,
    employeeId: b.employeeId,
    serviceId: b.serviceId,
    date: b.date,
    startMinutes: b.startMinutes,
    endMinutes: b.startMinutes + b.durationMinutes,
    status: "confirmed",
    synthetic: true,
  }));
}

/**
 * Huella canónica de una confirmación: las claves ordenadas y serializadas,
 * sin la propia clave de idempotencia. Dos peticiones que sólo se diferencian
 * en el ORDEN de los campos son la misma petición; dos que se diferencian en
 * un valor, no.
 */
export function fingerprintConfirmation(parts: {
  serviceId: number;
  employeeId: number;
  date: string;
  startMinutes: number;
  paymentOption: string;
}): string {
  return JSON.stringify([
    parts.date,
    parts.employeeId,
    parts.paymentOption,
    parts.serviceId,
    parts.startMinutes,
  ]);
}
