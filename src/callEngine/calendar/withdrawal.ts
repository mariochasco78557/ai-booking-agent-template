import type { EmployeeId } from "../domain/types.js";
import {
  agruparImpactoPorEmpleadoYFecha,
  reservasQueDejanDeCaber,
  sanitizeChangeForReport,
  type ApplyChangeResult,
  type CalendarChange,
  type ImpactReport,
  type ImpactResolution,
} from "./impact.js";
import type {
  AuditStamp,
  EmployeeAbsence,
  OperationalCalendar,
  VenueCalendarRule,
  VenueClosure,
} from "./model.js";

/**
 * RETIRADA de un cierre de local, un día especial o una ausencia
 * (step 26 REAPERTURA, decisión R13).
 *
 * POR QUÉ EXISTE ESTE MÓDULO, Y POR QUÉ NO VIVE EN `impact.ts`: una
 * capacidad de calendario no existe hasta que se puede DESHACER, pero
 * `impact.ts` tiene dos piezas que no se pueden tocar —`withChangeApplied`
 * es ADD-ONLY por diseño y `applyChange` lleva encima la regla dura de que
 * jamás se cancela ni se mueve una reserva—. Deshacer es otra operación:
 * marca una fila existente, no añade ninguna. Se escribe aparte para que
 * aquellas dos sigan siendo exactamente lo que eran.
 *
 * QUÉ ES RETIRAR: poner `approval: "rejected"` en la fila, CONSERVÁNDOLA,
 * con su sello de auditoría actualizado. Nunca se borra una fila. Nada más
 * hace falta en el resolutor: `resolveDayWindows` es fail-closed en los dos
 * sentidos —ignora por completo cualquier registro que no esté `approved`
 * (`resolveAvailability.ts`, filtros de los niveles 1, 2, 3, 4 y 5)—, así que
 * marcar `rejected` devuelve la disponibilidad al estado anterior sin una
 * sola línea nueva allí. Y la fila conservada deja constancia de que alguien
 * apuntó algo y luego lo retiró, que es para lo que sirve un historial.
 *
 * POR QUÉ LA RETIRADA TAMBIÉN NECESITA PREVISUALIZACIÓN: porque NO sólo
 * libera horas. Un `VenueCalendarRule` de tipo `special_opening` REEMPLAZA el
 * horario del local (`resolveAvailability.ts`, nivel 2), y además sirve de
 * horario del empleado cuando éste no tiene el suyo. Si un día especial abre
 * el local de 10:00 a 22:00 sobre un horario habitual de 09:30 a 18:00, y hay
 * una cita a las 20:00, RETIRAR ESE DÍA ESPECIAL CIERRA EL LOCAL A LAS 18:00
 * Y ESA CITA DEJA DE CABER. Por eso `previewWithdrawal` y `applyWithdrawal`
 * pasan por la MISMA puerta de resoluciones que el alta: sin ella, retirar un
 * día especial rompería en silencio la cita de un cliente real.
 *
 * EDITAR NO EXISTE AQUÍ: editar es retirar + dar de alta, dos publicaciones,
 * cada una con su previsualización y su línea de auditoría. No hay —ni puede
 * haber— una operación atómica de edición.
 *
 * LO QUE ESTE MÓDULO NO HACE, NUNCA: no toca `cal.reservations` (ni para
 * cancelar, ni para mover, ni para reasignar), no toca `cal.weeklySchedules`,
 * `cal.seasonalSchedules`, `cal.overrides` ni `cal.professionals`, no elimina
 * ninguna fila, no encola nada (eso es de la capa HTTP, que sí tiene reloj y
 * almacén) y no importa NI UNA LÍNEA del módulo de lista de espera —ni puede
 * empezar a hacerlo— (invariante I3, J12): `impact.ts` tampoco lo hace, y una
 * prueba de contrato lee el texto de este fichero para asegurarlo.
 */

/** Los TRES tipos de registro retirables. `employee_override` queda fuera de alcance (F1). */
export type WithdrawalTargetKind = "venue_closure" | "venue_rule" | "employee_absence";

export interface CalendarWithdrawal {
  kind: WithdrawalTargetKind;
  id: string;
  /** Nota operativa opcional del operador. Se guarda en AuditStamp.note. */
  note?: string;
  /** Del reloj inyectado por la capa que llama, nunca `Date.now()`. */
  withdrawnAt: string;
  /** Quién retira; hoy siempre `"console-operator"`. */
  withdrawnBy: string;
}

/** La fila que una retirada apunta, ya localizada y con su tipo. */
type FilaObjetivo =
  | { kind: "venue_closure"; row: VenueClosure }
  | { kind: "venue_rule"; row: VenueCalendarRule }
  | { kind: "employee_absence"; row: EmployeeAbsence };

/**
 * TODAS las filas APROBADAS cuyo `id` y tipo coinciden, en el orden del array.
 *
 * "Aprobada" es deliberado: retirar algo que ya está retirado (o que nunca se
 * activó) no es una retirada, es un identificador que no corresponde a nada
 * vigente, y la frontera HTTP lo contesta con 404 en vez de con un impacto de
 * cero.
 *
 * TODAS, y no la primera (revisión adversarial de la reapertura, V1-1):
 * `withWithdrawalApplied` marca con `.map` cuantas filas aprobadas lleven ese
 * `id`, así que EL CONJUNTO QUE CAMBIA ES ÉSTE, y es este mismo conjunto —no
 * un representante suyo— el que tiene que decidir qué reservas se examinan.
 * Con una sola fila, dos aperturas especiales aprobadas bajo el mismo `id` en
 * fechas distintas producían un informe que sólo contaba las citas de la
 * primera fecha mientras la retirada rompía las de las dos: el operador
 * resolvía una cita y se le llevaba otra por delante sin decírselo.
 */
function filasAprobadas(cal: OperationalCalendar, w: CalendarWithdrawal): FilaObjetivo[] {
  switch (w.kind) {
    case "venue_closure":
      return cal.closures
        .filter((c) => c.id === w.id && c.approval === "approved")
        .map((row) => ({ kind: "venue_closure", row }));
    case "venue_rule":
      return cal.venueRules
        .filter((r) => r.id === w.id && r.approval === "approved")
        .map((row) => ({ kind: "venue_rule", row }));
    case "employee_absence":
      return cal.absences
        .filter((a) => a.id === w.id && a.approval === "approved")
        .map((row) => ({ kind: "employee_absence", row }));
  }
}

/**
 * El sello de la retirada: conserva `createdAt`/`createdBy` originales —quién
 * lo apuntó y cuándo— y sobrescribe `approvedAt`/`approvedBy` con los de la
 * retirada, más la nota operativa si la hay. Es exactamente el patrón de
 * `approval.ts`'s `reviewRule`. Una nota en blanco no escribe nada, y una
 * retirada sin nota conserva la que ya hubiera: la nota es del registro, no
 * del acto.
 */
function selloDeRetirada(audit: AuditStamp, w: CalendarWithdrawal): AuditStamp {
  const nota = w.note?.trim();
  return {
    ...audit,
    approvedAt: w.withdrawnAt,
    approvedBy: w.withdrawnBy,
    ...(nota !== undefined && nota !== "" ? { note: nota } : {}),
  };
}

/**
 * SÓLO LAS FILAS APROBADAS (revisión adversarial de la reapertura, V1-2/V1-3).
 * Reutilizar un `id` es legal —la guarda del alta mira lo APROBADO, no el
 * historial—, así que en un mismo array pueden convivir, con el mismo `id`,
 * una fila vigente y filas que no lo están. Tocar esas otras hacía dos daños,
 * los dos al historial, que es justo lo que la retirada existe para preservar:
 *
 *  - una fila YA RETIRADA en enero pasaba a decir que se retiró en agosto, con
 *    la nota del acto nuevo encima de la suya: el sello de auditoría dejaba de
 *    ser el registro de lo que pasó;
 *  - una fila `pending_review` —una propuesta de festivo que nadie ha mirado
 *    todavía— quedaba `rejected` y sellada `approvedBy: "console-operator"`,
 *    es decir, registrada como revisada por alguien que jamás la vio.
 *
 * Una retirada retira lo que está puesto. Lo que no lo está no es asunto suyo.
 */
function marcada<T extends { id: string; approval: string; audit: AuditStamp }>(
  row: T,
  w: CalendarWithdrawal,
): T {
  if (row.id !== w.id || row.approval !== "approved") return row;
  return { ...row, approval: "rejected", audit: selloDeRetirada(row.audit, w) };
}

/**
 * PURA. Devuelve `cal` con TODA fila APROBADA del tipo indicado cuyo `id`
 * coincida marcada `approval: "rejected"`. Nunca elimina una fila. Nunca toca
 * `cal.reservations`. Nunca toca `cal.weeklySchedules`. Nunca toca una fila
 * que no estuviera aprobada (ver `marcada`).
 *
 * `.map` SOBRE TODAS LAS FILAS, no `.find` sobre la primera: `withChangeApplied`
 * (`impact.ts`) añade sin comprobar, de modo que publicar dos veces el mismo
 * `id` deja dos filas con ese `id`. Mientras nadie buscaba por `id` eso era
 * inocuo; con la retirada dejaría media capacidad puesta y media retirada. La
 * frontera HTTP además rechaza con 409 un alta con un `id` ya aprobado, pero
 * esta función es correcta AUNQUE ya existan duplicados.
 */
export function withWithdrawalApplied(cal: OperationalCalendar, w: CalendarWithdrawal): OperationalCalendar {
  switch (w.kind) {
    case "venue_closure":
      return { ...cal, closures: cal.closures.map((c) => marcada(c, w)) };
    case "venue_rule":
      return { ...cal, venueRules: cal.venueRules.map((r) => marcada(r, w)) };
    case "employee_absence":
      return { ...cal, absences: cal.absences.map((a) => marcada(a, w)) };
  }
}

/** El mismo prefiltro barato de `impact.ts`, con la fila ya localizada. */
function podriaVerseAfectada(
  objetivo: FilaObjetivo,
  reservation: { employeeId: EmployeeId; date: string },
): boolean {
  switch (objetivo.kind) {
    case "venue_closure":
      return reservation.date >= objetivo.row.startDate && reservation.date <= objetivo.row.endDate;
    case "venue_rule":
      return reservation.date === objetivo.row.date;
    case "employee_absence":
      return (
        reservation.employeeId === objetivo.row.employeeId &&
        reservation.date >= objetivo.row.startDate &&
        reservation.date <= objetivo.row.endDate
      );
  }
}

/** El registro retirado, expresado como `CalendarChange` para poder viajar en un `ImpactReport`. */
function cambioDeLaRetirada(objetivo: FilaObjetivo, w: CalendarWithdrawal): CalendarChange {
  switch (objetivo.kind) {
    case "venue_closure":
      return { kind: "venue_closure", closure: marcada(objetivo.row, w) };
    case "venue_rule":
      return { kind: "venue_rule", rule: marcada(objetivo.row, w) };
    case "employee_absence":
      return { kind: "employee_absence", absence: marcada(objetivo.row, w) };
  }
}

/**
 * PURA. Mismo contrato que `previewImpact`: qué reservas confirmadas dejarían
 * de caber si esta retirada estuviera ya aplicada. Nunca muta `cal` y nunca
 * escribe nada.
 *
 * DEVUELVE `undefined` cuando no hay ninguna fila APROBADA con ese `id` y ese
 * tipo. Es una desviación deliberada y mínima de la firma del normativo
 * (`: ImpactReport`): `ImpactReport.change` es un `CalendarChange`, que no
 * puede describir un registro que no existe sin FABRICARLO, y "no hay nada
 * que retirar" (404) no es lo mismo que "no impacta a nadie" (200 con lista
 * vacía). Así el 404 de la frontera HTTP y la cuenta del impacto salen de la
 * MISMA búsqueda, y no pueden discrepar.
 */
export function previewWithdrawal(cal: OperationalCalendar, w: CalendarWithdrawal): ImpactReport | undefined {
  const objetivos = filasAprobadas(cal, w);
  // La PRIMERA sólo decide dos cosas: que hay algo que retirar (si no, 404) y
  // cómo se describe el registro en el `change` del informe. QUÉ reservas se
  // examinan lo deciden TODAS (V1-1).
  const primera = objetivos[0];
  if (primera === undefined) return undefined;
  const impacted = reservasQueDejanDeCaber(cal, withWithdrawalApplied(cal, w), (r) =>
    objetivos.some((objetivo) => podriaVerseAfectada(objetivo, r)),
  );
  return {
    // La MISMA purga que el alta (`impact.ts`): ni `privateReason` ni
    // `audit.note` salen jamás dentro de un informe de impacto.
    change: sanitizeChangeForReport(cambioDeLaRetirada(primera, w)),
    impacted,
    byEmployeeAndDate: agruparImpactoPorEmpleadoYFecha(impacted),
  };
}

/**
 * Misma puerta que `applyChange`: si alguna reserva impactada no trae
 * resolución, NO APLICA NADA y devuelve el `cal` original junto con la lista
 * de las que siguen pendientes de decisión.
 *
 * REGLA DURA, HEREDADA PALABRA POR PALABRA DE `applyChange`: esta función
 * NUNCA cancela, mueve ni modifica una `SyntheticReservation` —ni siquiera
 * una que tenga resolución—. `cal.reservations` se pasa siempre intacto; lo
 * único que cambia es el `approval` (y el sello) de la fila retirada. Una
 * resolución humana RECONOCE el conflicto, no autoriza a este módulo a actuar
 * en nombre del cliente.
 *
 * DEVUELVE `undefined` cuando no hay ninguna fila APROBADA con ese `id` y ese
 * tipo, exactamente igual que `previewWithdrawal` y por la misma razón
 * (revisión adversarial de la reapertura, V1-7): devolver `{ cal, unresolved:
 * [], flaggedForHumanContact: [] }` hacía que "no había NADA que retirar" y
 * "se retiró y no impactó a nadie" fuesen el MISMO valor, byte a byte. Quien
 * llame no puede distinguir un 404 de un éxito si el resultado es idéntico, y
 * el día que alguien confíe en ese resultado dará por retirado algo que sigue
 * puesto. Se dice que no hubo retirada diciéndolo.
 */
export function applyWithdrawal(
  cal: OperationalCalendar,
  w: CalendarWithdrawal,
  resolutions: ReadonlyMap<string, ImpactResolution>,
): ApplyChangeResult | undefined {
  const report = previewWithdrawal(cal, w);
  if (report === undefined) return undefined;
  const unresolved = report.impacted.filter((r) => !resolutions.has(r.reservationId));
  if (unresolved.length > 0) {
    return { cal, unresolved, flaggedForHumanContact: [] };
  }
  const flaggedForHumanContact = report.impacted.filter(
    (r) => resolutions.get(r.reservationId) === "mark_for_human_contact",
  );
  return { cal: withWithdrawalApplied(cal, w), unresolved: [], flaggedForHumanContact };
}
