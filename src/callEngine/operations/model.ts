import type { EmployeeId, ProfessionalPreference, ServiceId } from "../domain/types.js";
import type { EngineSideEffects } from "../shared/commandOutcome.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — OPERATIONS DOMAIN MODEL (design §2.5, §2.6, §4.2/§4.3).
 *
 * Pure types only: no clock read, no I/O, no state. Everything here is
 * synthetic demo data and never reaches a real system or a real person.
 *
 * HARD DEPENDENCY RULE (design §4.2, pinned by the boundary block of
 * tests/callEngine/waitlistMatching.test.ts):
 *   - `src/callEngine/operations/**` MAY import from `src/callEngine/**`
 *     EXCEPT from `waitlist/**`.
 *   - `src/callEngine/waitlist/**` does NOT import from `operations/**`.
 *   - No file of `src/callEngine/**` outside `operations/` imports from
 *     `operations/`.
 * Like the waitlist, this feature is a CONSUMER of the engine, never a
 * participant in a call: the voice agent does not record no-shows and has no
 * honest outcome for one among the ten frozen precedence codes (design §0.3).
 *
 * WHAT A NO-SHOW IS NOT (design §2.1, non-rules §6.1..§6.6, question K1):
 * there is no penalty, no restriction, no deposit, no score, no blacklist and
 * no hidden flag anywhere in this file. There is deliberately NO `note`, NO
 * `severity`, NO `count` and NO `reviewState`: no future panel can read a
 * sanction out of a model that has no field to hold one.
 *
 * WHY NOTHING IS ADDED TO `SyntheticReservation`: that type is consumed by
 * `resolveAvailability`, `impact.ts`, `snapshot.ts`, `memoryStore.ts` and
 * twenty-odd tests. The relationship is expressed by `reservationId` alone,
 * exactly as `CancellationRecord` already does (waitlist/model.ts:26-28).
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * The two states of a no-show record. A reservation with no record simply has
 * none — the default of EVERY appointment.
 *
 * `corrected_not_a_no_show` is TERMINAL until `POST /api/reset` (design
 * §2.3, transition 2, question K3): one can always leave the accusation,
 * never re-enter it by a double click. The suffix `_not_a_no_show` is part of
 * the identifier ON PURPOSE, so nobody can quietly reuse the state for
 * something else.
 */
export type NoShowState = "recorded" | "corrected_not_a_no_show";

export interface NoShowRecord {
  /** `"nsh-<reservationId>"` — natural key, EXACTLY one per reservation. */
  id: string;
  reservationId: string;
  /** Copied from the reservation AT THE MOMENT of recording, so the record reads on its own. */
  employeeId: EmployeeId;
  serviceId: ServiceId;
  date: string;
  startMinutes: number;
  endMinutes: number;
  /** Minutes elapsed since the END of the appointment on the synthetic clock. Always >= 0. */
  minutesAfterEndAtRecording: number;
  /**
   * NEVER `"system"`. The literal type makes it structurally impossible for a
   * future change to record a no-show in the system's name without changing
   * this type and breaking the build — the same technique as
   * `optInConfirmed: true` and `expired_manually`.
   */
  recordedBy: "console-operator";
  /** Injected synthetic clock. */
  recordedAtISO: string;
  state: NoShowState;
  /** Present only once corrected. The history keeps BOTH facts; nothing is erased. */
  correctedAtISO?: string;
  correctedBy?: "console-operator";
  synthetic: true;
}

/** The natural key of a no-show record, mirroring `cancellationIdFor` (waitlist/model.ts:288). */
export function noShowIdFor(reservationId: string): string {
  return `nsh-${reservationId}`;
}

// ---------------------------------------------------------------------
// Audit log (design §2.6)
// ---------------------------------------------------------------------

/**
 * THE CLOSED CATALOGUE of the operations log.
 *
 * These events deliberately do NOT join `WaitlistAuditKind`
 * (waitlist/model.ts:186-218): that catalogue belongs to the waitlist and it
 * must remain verifiable that it did not change at all (criterion 8.27). The
 * operations log is a second, independent register with its own sequence.
 *
 * The three `RESERVATION_GROUP_*` members are part of the catalogue the
 * design closes in §2.6; their producers are written by the multi-person
 * booking phase. Declaring them here keeps the catalogue closed once and for
 * all instead of reopening this type later.
 *
 * There is NO `IDEMPOTENT_REPLAY` member on purpose: a repeated request over
 * a no-show IS a repeated command that did nothing, which is exactly what
 * `NO_SHOW_COMMAND_REPEATED` says (design §2.6, §2.7).
 */
export type OperationsAuditKind =
  | "NO_SHOW_RECORDED"
  | "NO_SHOW_CORRECTED"
  | "NO_SHOW_COMMAND_REPEATED"
  | "RESERVATION_GROUP_CREATED"
  | "RESERVATION_GROUP_LINE_CREATED"
  | "RESERVATION_GROUP_REPEATED"
  /**
   * step 24 — LOS DOS DE LA CITA MANUAL, añadidos AL FINAL a propósito: el
   * catálogo heredado conserva su orden exacto, así que la prueba de contrato
   * congelado lo sigue comparando literalmente, elemento a elemento.
   *
   * Es una extensión ACOTADA del registro operativo, que es el dominio
   * apropiado para un acto del operador sobre la agenda. NO se abre step 21B
   * y NO se construye un feed unificado entre dominios: entre este registro y
   * el de la lista de espera no hay orden total canónico, y mezclarlos sin él
   * sería inventarse una cronología.
   *
   * `RESERVATION_MANUAL_CREATED` es además la ÚNICA fuente de la que se deriva
   * el origen «creada manualmente por el operador» en la interfaz. No se
   * guarda ese origen en ningún otro sitio, así que las dos no pueden diverger.
   */
  | "RESERVATION_MANUAL_CREATED"
  | "RESERVATION_MANUAL_REPEATED"
  | "DEMO_CLOCK_ADVANCED"
  | "DEMO_RESET";

export interface OperationsAuditEvent {
  /** `"opa-00000001"`. */
  id: string;
  /** Monotonic and unique WITHIN THIS register; this is what orders the story. */
  seq: number;
  kind: OperationsAuditKind;
  actor: "operator" | "system" | "reset";
  /** Injected synthetic clock. */
  atISO: string;
  reservationId?: string;
  noShowId?: string;
  groupId?: string;
  /** step 24. Presente sólo en los dos eventos de la cita manual. */
  manualBookingId?: string;
  memberLabel?: string;
  fromState?: NoShowState;
  toState?: NoShowState;
  detail?: Record<string, string | number | boolean>;
  synthetic: true;
}

/**
 * An audit event before the store stamps it with `id`/`seq`. Command handlers
 * are pure and therefore cannot mint a monotonic sequence; the store does
 * that, in one synchronous commit.
 */
export type OperationsAuditDraft = Omit<OperationsAuditEvent, "id" | "seq">;

// ---------------------------------------------------------------------
// Multi-person booking (design §4.3, §4.6)
// ---------------------------------------------------------------------

/**
 * THE ONLY shape a member label may take (design §4.3, question K13). A
 * CLOSED list, with no room for a name, a phone number or free text about a
 * person: the demo is synthetic and this expression is what makes that
 * structurally true instead of merely promised (criterion 8.32). Four is the
 * ceiling of a group, so the letters stop at D.
 */
export const GROUP_MEMBER_LABEL_RE = /^(Persona [1-4]|Adulto [A-D]|Menor [A-D])$/;

/** How many people a group may hold (design §4.5, question K8). */
export const GROUP_MIN_LINES = 2;
export const GROUP_MAX_LINES = 4;

/** How many proposals the server returns at most (design §4.5, step 3). */
export const GROUP_PROPOSALS_RETURNED = 3;

/**
 * The operator chooses this EXPLICITLY (design §4.4): there is no default
 * anywhere, not in this type, not in the schema and not in the interface.
 */
export type GroupArrangement = "consecutive" | "simultaneous";

/** What the operator asks for, BEFORE the server resolves anything. */
export interface GroupLineRequest {
  /** Matches `GROUP_MEMBER_LABEL_RE`. */
  memberLabel: string;
  /** CHOSEN PER PERSON. Never copied from another line in silence (design §4.4). */
  serviceId: ServiceId;
  professional: ProfessionalPreference;
}

/** What the server proposes: one fully resolved line. */
export interface GroupProposalLine {
  memberLabel: string;
  serviceId: ServiceId;
  /** Resolved: "cualquiera" has already been decided by `chooseProfessional`. */
  employeeId: EmployeeId;
  date: string;
  startMinutes: number;
  endMinutes: number;
  /** `slotKeyFor(...)`'s format — see `groupSlotKeyFor` below. */
  slotKey: string;
  /** `true` if the operator asked for this person by name. Said out loud in the summary. */
  professionalWasRequested: boolean;
}

/**
 * A whole resolved proposal.
 *
 * IT CARRIES NO `groupId`, deliberately — a documented consequence of §4.6.2's
 * repair of blocker B2. The sketch in §4.3 still showed one because it predates
 * that repair; since the identity is minted BY THE STORE at creation time,
 * a proposal (which writes nothing and may never be confirmed) cannot have
 * one without either burning a sequence number or lying about it.
 */
export interface GroupProposal {
  arrangement: GroupArrangement;
  date: string;
  /** CANONICAL ORDER: `startMinutes` ascending, then `employeeId` ascending. */
  lines: readonly GroupProposalLine[];
}

/** One line of a group, as it is written down: a REAL 30-minute reservation. */
export interface ReservationGroupLine {
  reservationId: string;
  memberLabel: string;
  serviceId: ServiceId;
  employeeId: EmployeeId;
  startMinutes: number;
  endMinutes: number;
}

/**
 * What ends up written. ALWAYS COMPLETE: a half group does not exist (design
 * §4.3's amendment of `DISENO_FUTURO…` §3.2). There is no `confirmationState`
 * and no `groupState` here: the life of each line is the life of ITS
 * reservation (`confirmed` / `cancelled`), and the group's state is DERIVED in
 * the projection, so it cannot drift from the appointments it describes.
 */
export interface ReservationGroup {
  /** `"grp-0001"` — minted by the STORE, from a sequence (design §4.6.2). */
  id: string;
  arrangement: GroupArrangement;
  date: string;
  lines: readonly ReservationGroupLine[];
  /** What was asked for, in canonical form (design §4.6.1). Never shown to an operator. */
  intentKey: string;
  createdAtISO: string;
  createdBy: "console-operator";
  synthetic: true;
}

/**
 * The slot key of one group line. SAME FORMAT as the waitlist's `slotKeyFor`
 * (waitlist/model.ts:265) — and NOT an import of it, because the hard
 * dependency rule of §4.2 forbids `operations/` from importing `waitlist/`.
 * It is four tokens of string formatting, not a rule; the equality of the two
 * formats is pinned by a test that imports BOTH (tests can cross the boundary
 * the modules may not).
 */
export function groupSlotKeyFor(dateISO: string, startMinutes: number, employeeId: EmployeeId): string {
  return `slot-${dateISO}-${String(startMinutes)}-${String(employeeId)}`;
}

/**
 * `"grp-0001"`. From the STORE'S SEQUENCE, never from the slot (design
 * §4.6.2, blocker B2): a slot is freed by cancelling and is therefore not a
 * stable identity, while a sequence cannot collide and stays deterministic
 * from a clean start (criterion 8.33).
 */
export function groupIdFor(groupNumber: number): string {
  return `grp-${String(groupNumber).padStart(4, "0")}`;
}

/**
 * `"res-g-grp-0001-1"`. The group id is IN the reservation id, which is what
 * makes duplicates impossible even though `memoryStore.addReservation` pushes
 * without checking ids (design §4.6.2). `index` is 1-based, in canonical order.
 */
export function groupReservationIdFor(groupId: string, index: number): string {
  return `res-g-${groupId}-${String(index)}`;
}

/** The three fields of a line that the intention is made of. */
export interface GroupIntentLine {
  startMinutes: number;
  employeeId: EmployeeId;
  serviceId: ServiceId;
}

/** Canonical order of the lines of a group: start ascending, then employee ascending. */
export function compareGroupIntentLines(a: GroupIntentLine, b: GroupIntentLine): number {
  if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
  return a.employeeId - b.employeeId;
}

/**
 * THE INTENTION KEY (design §4.6.1): what is being asked for, said in a form
 * that a double click reproduces byte for byte.
 *
 * ```
 * group:2026-08-04:consecutive:540-3-1.570-6-0
 * ```
 *
 * Only digits, `-`, `.` and `:`, so it fits `IDEMPOTENCY_KEY_PATTERN`
 * (src/console/idempotency.ts:25) — which is exactly why `memberLabel`, which
 * carries a space, is NOT part of it. It is derived from the CONTENT, on the
 * server, with this one function; there is no "does it match the header?"
 * check anywhere, because both sides come from the same content.
 */
export function groupIntentKey(
  dateISO: string,
  arrangement: GroupArrangement,
  lines: readonly GroupIntentLine[],
): string {
  const canonical = [...lines].sort(compareGroupIntentLines);
  const body = canonical
    .map((l) => `${String(l.startMinutes)}-${String(l.employeeId)}-${String(l.serviceId)}`)
    .join(".");
  return `group:${dateISO}:${arrangement}:${body}`;
}

/**
 * The transport key the INTERFACE mints (design §4.8): the intention plus the
 * repetition discriminant `r<n>`, where `n` is how many groups with this same
 * intention already exist. Cancelling does not change `n`; CREATING does, so a
 * second legitimate creation of the same thing can never collide with the
 * memoised answer of the first. It travels resolved in the projection
 * (decision N3): the browser never derives a key.
 */
export function groupIntentKeyToMint(intentKey: string, existingGroupsWithThisIntent: number): string {
  return `${intentKey}:r${String(existingGroupsWithThisIntent)}`;
}

/** How many groups already carry this exact intention. */
export function countGroupsWithIntent(groups: readonly ReservationGroup[], intentKey: string): number {
  return groups.filter((g) => g.intentKey === intentKey).length;
}

// ---------------------------------------------------------------------
// The write contract (design §4.7)
// ---------------------------------------------------------------------

/**
 * The complete, atomic description of a write to the operations store.
 * `undefined` means "leave this alone". Nothing in `operations/` mutates
 * anything.
 *
 * It extends `EngineSideEffects` (design §4.7) because a group also writes N
 * synthetic reservations into the calendar and into the `MemoryStore`, and
 * those two copies MUST land in the same tick as the group itself — the
 * anti-half-write rule of step 17 §14.5, extended to N reservations.
 */
export interface OperationsWrite extends EngineSideEffects {
  noShows?: readonly NoShowRecord[];
  groups?: readonly ReservationGroup[];
  /** step 24. Las citas manuales, con la misma disciplina que los grupos. */
  manualBookings?: readonly ManualBooking[];
  events: readonly OperationsAuditDraft[];
  /** How many group ids this command consumed (0 or 1). */
  groupsMinted?: number;
  /** step 24. Cuántos identificadores de cita manual consumió (0 o 1). */
  manualBookingsMinted?: number;
}

// ---------------------------------------------------------------------
// step 24 — Creación manual de citas por el operador (diseño §3, §7)
// ---------------------------------------------------------------------

/**
 * LA ÚNICA forma que puede tomar la persona de una cita manual (diseño §4,
 * paso 4). Catálogo CERRADO de seis, sin sitio para un nombre, un teléfono ni
 * una línea de texto libre.
 *
 * Es la misma expresión que ya gobierna las etiquetas de la lista de espera, y
 * está aquí —repetida, no importada— por la regla dura de dependencias de
 * §4.2: `operations/` no importa de `waitlist/`. Son ocho caracteres de
 * expresión regular, no una regla de negocio; que las dos coincidan lo fija una
 * prueba que importa las dos (las pruebas sí pueden cruzar la frontera que los
 * módulos no).
 *
 * La demostración usa seis personas, A..F, las mismas que siembra la lista de
 * espera. El tope en F no es decorativo: hace estructuralmente imposible que un
 * dato personal entre por aquí, en vez de meramente prometido.
 */
export const MANUAL_CLIENT_LABEL_RE = /^Cliente [A-F]$/;

/** Los pasos en que un operador puede expresar una duración especial (step 26 §1). */
export const MANUAL_DURATION_STEP_MINUTES = 15;
export const MANUAL_DURATION_MIN_MINUTES = 15;
/**
 * Tope ESTRUCTURAL, no comercial: nadie ha fijado una duración máxima de
 * servicio para Demo Salon y esta misión tiene prohibido inventarla. 240 minutos es
 * un guardarraíl de forma de la petición, como `startMinutes` 0..1439. El
 * límite REAL de cada día lo pone siempre el calendario, vía `isIntervalFree`.
 */
export const MANUAL_DURATION_MAX_MINUTES = 240;

/**
 * La forma que una duración de cita manual puede tomar (step 26 §1). No dice
 * nada de si esa duración CABE: eso lo contesta el calendario, y sólo él.
 */
export function isAllowedManualDuration(minutes: number): boolean {
  return (
    Number.isInteger(minutes) &&
    minutes >= MANUAL_DURATION_MIN_MINUTES &&
    minutes <= MANUAL_DURATION_MAX_MINUTES &&
    minutes % MANUAL_DURATION_STEP_MINUTES === 0
  );
}

/**
 * Lo que queda escrito de una cita manual.
 *
 * NO LLEVA ESTADO PROPIO, y es deliberado: la vida de la cita es la vida de SU
 * reserva (`confirmed` / `cancelled`), igual que en un grupo la vida de cada
 * línea es la de la suya. Un `state` aquí sería un segundo estado capaz de
 * discrepar del primero, y esta consola no guarda dos veces lo mismo.
 *
 * Tampoco lleva nota, ni teléfono, ni correo, ni dirección: no hay campo donde
 * quepan.
 */
export interface ManualBooking {
  /** `"man-0001"` — acuñado por el ALMACÉN, desde una secuencia. */
  id: string;
  /** La reserva sintética que ESTA cita creó. La cita se lee a través de ella. */
  reservationId: string;
  /** Del catálogo cerrado: cumple `MANUAL_CLIENT_LABEL_RE`. */
  clientLabel: string;
  serviceId: ServiceId;
  employeeId: EmployeeId;
  date: string;
  startMinutes: number;
  endMinutes: number;
  /** Lo que se pidió, en forma canónica (diseño §7.2). Nunca se le enseña a un operador. */
  intentKey: string;
  createdAtISO: string;
  /**
   * NUNCA `"system"` ni `"call"`. El tipo literal hace estructuralmente
   * imposible que un cambio futuro cree una cita manual en nombre de otro sin
   * cambiar este tipo y romper la compilación.
   */
  createdBy: "console-operator";
  synthetic: true;
}

/**
 * `"man-0001"`. De la SECUENCIA del almacén, nunca del hueco: un hueco se
 * libera al cancelar y por tanto no es una identidad estable, mientras que una
 * secuencia no puede colisionar y es determinista desde un arranque limpio.
 * Misma decisión que `groupIdFor` (§4.6.2, bloqueante B2).
 */
export function manualBookingIdFor(manualNumber: number): string {
  return `man-${String(manualNumber).padStart(4, "0")}`;
}

/**
 * `"res-m-man-0001"`. El identificador de la cita va DENTRO del de la reserva,
 * que es lo que hace imposible un duplicado aunque `memoryStore.addReservation`
 * empuje sin comprobar identificadores.
 */
export function manualReservationIdFor(manualBookingId: string): string {
  return `res-m-${manualBookingId}`;
}

/**
 * LA CLAVE DE LA INTENCIÓN (diseño §7.2): qué se está pidiendo, dicho de una
 * forma que un doble clic reproduce byte a byte.
 *
 * ```
 * manual:2026-08-04:780d30-3-1:A     ← la cita habitual de 30 minutos
 * manual:2026-08-04:780d135-3-1:A    ← la misma hora, 2 h 15 min
 * ```
 *
 * LA DURACIÓN ENTRA EN LA INTENCIÓN (step 26 §3), y se escribe SIEMPRE,
 * también cuando vale 30: un valor implícito dentro de una clave de identidad
 * es exactamente el supuesto oculto que esta misión prohíbe. Sin ella, pedir
 * las 11:00 durante 30 minutos y pedir las 11:00 durante 90 producirían la
 * misma clave, y la segunda petición oiría «ya estaba creada» describiendo una
 * cita que no es la suya — el mismo error que ya se corrigió una vez dejando a
 * la persona fuera de la clave.
 *
 * LA PERSONA ENTRA EN LA INTENCIÓN, y la primera redacción de este diseño se
 * equivocaba dejándola fuera. El razonamiento de entonces —«un hueco sólo
 * admite una cita, así que fecha + hora + profesional + servicio ya identifican
 * lo que se pide»— confunde el RESULTADO con la PETICIÓN: pedir el hueco de las
 * 11:00 para Cliente A y pedirlo para Cliente B son dos peticiones distintas, y
 * la segunda merece oír «ese hueco acaba de ocuparse», no «ya estaba creada»,
 * que describiría una cita que no es la suya. Lo destapó la prueba de dominio
 * de dos personas compitiendo por el mismo hueco.
 *
 * Viaja sólo la LETRA (`Cliente A` → `A`), por dos razones: el espacio de la
 * etiqueta no cabe en `IDEMPOTENCY_KEY_PATTERN`, y una clave de transporte no
 * tiene por qué llevar más identidad de la imprescindible. Con eso la clave
 * sigue siendo sólo letras, dígitos, `-` y `:`.
 *
 * Se deriva del CONTENIDO, en el servidor, con esta única función; no hay
 * ninguna comprobación de «¿coincide con la cabecera?» en ninguna parte, porque
 * los dos lados salen de lo mismo.
 */
export function manualIntentKey(
  dateISO: string,
  startMinutes: number,
  durationMinutes: number,
  employeeId: EmployeeId,
  serviceId: ServiceId,
  clientLabel: string,
): string {
  const letra = clientLabel.slice(-1);
  return `manual:${dateISO}:${String(startMinutes)}d${String(durationMinutes)}-${String(employeeId)}-${String(serviceId)}:${letra}`;
}

/**
 * La clave de transporte que acuña la INTERFAZ (diseño §7.2), resuelta EN EL
 * SERVIDOR y publicada en la proyección: el navegador nunca deriva una clave
 * (decisión N3 de step 18).
 *
 * Lleva el discriminante de repetición `r<n>`, donde `n` es cuántas citas
 * manuales con esta misma intención se han creado ya. Cancelar no cambia `n`;
 * CREAR sí, de modo que una segunda creación legítima de lo mismo —tras haber
 * cancelado la primera— no puede colisionar con la huella memoizada de aquélla.
 */
export function manualIntentKeyToMint(intentKey: string, existingWithThisIntent: number): string {
  return `${intentKey}:r${String(existingWithThisIntent)}`;
}

/** Cuántas citas manuales llevan ya exactamente esta intención. */
export function countManualBookingsWithIntent(
  bookings: readonly ManualBooking[],
  intentKey: string,
): number {
  return bookings.filter((b) => b.intentKey === intentKey).length;
}
