import type { SyntheticReservation } from "../calendar/model.js";
import { isSlotFree, isWithinHorizon } from "../calendar/resolveAvailability.js";
import { canPerform, type CalendarWithCapabilities } from "../capabilities.js";
import { isStartInThePast } from "../domain/slotTime.js";
import { formatHHmm } from "../domain/time.js";
import type { Clock, EmployeeId, ServiceId } from "../domain/types.js";
import type { CommandOutcome } from "../shared/commandOutcome.js";
import {
  compareGroupIntentLines,
  groupIdFor,
  groupIntentKey,
  groupReservationIdFor,
  type GroupArrangement,
  type OperationsWrite,
  type ReservationGroup,
  type ReservationGroupLine,
} from "./model.js";
import { rejectGroupRequestUpFront } from "./groupProposal.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — CREATING A GROUP (design §4.6, §4.7, §4.8). PURE.
 *
 * THE FOUR PROMISES THIS FILE KEEPS, and how each is kept structurally rather
 * than by vigilance:
 *
 *   1. REVALIDATION FROM SCRATCH, LINE BY LINE, immediately before writing.
 *      The client sends back the lines the proposal resolved; this function
 *      believes NONE of it. Every line is checked again — `canPerform`,
 *      `!isStartInThePast`, `isWithinHorizon`, `isSlotFree` — against the
 *      CURRENT calendar plus the lines of this very group already validated.
 *      (That order is the fase-K amendment of H2: see step 4 below.)
 *   2. ALL OR NOTHING. The first failing line returns a `409` with
 *      `write: null`. There is no partial write to undo because there is no
 *      partial write: the caller applies ONE description, synchronously.
 *   3. TWO REQUESTS CANNOT DOUBLE-BOOK. Node serves one request per tick and
 *      nothing in this path is `async`, so there is no window between
 *      revalidating and writing. The second request revalidates with the slot
 *      already taken and leaves through `slot_no_longer_free`.
 *   4. REPEATING IS SAFE. Same intention AND every line still `confirmed` is
 *      the only thing that counts as "already done" (§4.8): if a line was
 *      cancelled, saying "ya estaba creada" would be a lie and the booking
 *      would be lost in silence (blocker B2). Since the fase-K amendment (H1)
 *      this is the ONLY idempotency this route has that can answer "already
 *      done": the transport layer works in `collision-only` mode for it, so a
 *      repeated key with the same body reaches this function again instead of
 *      being answered with a memoised body. The `RESERVATION_GROUP_REPEATED`
 *      event is therefore always the structural one, minted here, with its
 *      `groupId`.
 *
 * IT CREATES NOTHING NEW ABOUT AVAILABILITY. Same functions as everywhere
 * else, no clock read, no `Date.now()`, no randomness, no timer.
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------

/** One line as the client sends it back: ALREADY RESOLVED by the proposal (§4.9). */
export interface GroupCreateLine {
  memberLabel: string;
  serviceId: ServiceId;
  employeeId: EmployeeId;
  startMinutes: number;
}

export interface GroupCreateInput {
  arrangement: GroupArrangement;
  date: string;
  lines: readonly GroupCreateLine[];
  /** The demo's injected failure. It happens AFTER revalidation and BEFORE any write. */
  injectFailure?: boolean;
}

export interface GroupCommandContext {
  cal: CalendarWithCapabilities;
  clock: Clock;
  groups: readonly ReservationGroup[];
  /** The sequence the store owns; a pure handler cannot mint it for itself (§4.6.2). */
  nextGroupNumber: number;
}

/**
 * The only conflicts a group creation can answer with (§4.9). There is no
 * `group_id_*` in this list, and there cannot be: the client no longer mints
 * identities (§4.6.2). When two requests fight over a slot, the single reason
 * an operator is given is `slot_no_longer_free`, which is the one that is both
 * true and understandable (advertencia 11).
 */
export type GroupCreateConflict =
  | "slot_no_longer_free"
  | "professional_cannot_perform_service"
  | "slot_in_the_past"
  | "date_outside_booking_horizon"
  | "same_professional_twice_at_the_same_time";

export interface GroupCommandOutcome extends CommandOutcome<OperationsWrite> {
  /** When present, the caller replaces `body.group` with the SERVER-SIDE PROJECTION of this group. */
  viewGroupId?: string;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function professionalLabelOf(cal: CalendarWithCapabilities, employeeId: EmployeeId): string {
  return cal.professionals.find((p) => p.employeeId === employeeId)?.displayName ?? `Profesional ${String(employeeId)}`;
}

/** The lines in canonical order (§4.6.1): start ascending, then employee ascending. */
function canonical(lines: readonly GroupCreateLine[]): GroupCreateLine[] {
  return [...lines].sort(compareGroupIntentLines);
}

/**
 * A group counts as "already created" only if EVERY one of its lines is still
 * a `confirmed` reservation (§4.8). This is the third condition whose absence
 * was blocker B2.
 */
function isFullyAlive(cal: CalendarWithCapabilities, group: ReservationGroup): boolean {
  return group.lines.every((line) =>
    cal.reservations.some((r) => r.id === line.reservationId && r.status === "confirmed"),
  );
}

function conflictOutcome(
  cal: CalendarWithCapabilities,
  conflict: GroupCreateConflict,
  line: GroupCreateLine,
  reasons: readonly string[],
): GroupCommandOutcome {
  return {
    status: 409,
    body: {
      created: false,
      conflict,
      line: {
        memberLabel: line.memberLabel,
        when: formatHHmm(line.startMinutes),
        professionalLabel: professionalLabelOf(cal, line.employeeId),
      },
      reasons: [...reasons],
    },
    // NOTHING is written. Not an event, not a task, not a reservation — which
    // is what makes "a conflict writes nothing" provable by comparing the
    // length of the log before and after (criterion 8.21).
    write: null,
  };
}

// ---------------------------------------------------------------------
// createGroup (design §4.7's normative sequence, step by step)
// ---------------------------------------------------------------------

export function createGroup(ctx: GroupCommandContext, input: GroupCreateInput): GroupCommandOutcome {
  const { cal, clock } = ctx;

  // Step 1 — the shape of the request. Same closed rules as the proposal, so
  // a client that skipped the proposal cannot smuggle in a label, a size or a
  // pair of simultaneous lines that the proposal would have refused.
  const upFront = rejectGroupRequestUpFront(cal, {
    date: input.date,
    arrangement: input.arrangement,
    lines: input.lines.map((l) => ({
      memberLabel: l.memberLabel,
      serviceId: l.serviceId,
      professional: { kind: "specific", employeeId: l.employeeId } as const,
    })),
  });
  if (upFront !== null && upFront.conflict === "same_professional_twice_at_the_same_time") {
    return {
      status: 409,
      body: { created: false, conflict: upFront.conflict, reasons: [upFront.conflict], message: upFront.message },
      write: null,
    };
  }
  if (
    upFront !== null &&
    upFront.conflict !== "professional_cannot_perform_service" &&
    upFront.conflict !== "simultaneous_needs_one_professional_per_person"
  ) {
    // A malformed request, not a conflict about the world: a bad label, a
    // repeated label, a size outside 2..4. `professional_cannot_perform_service`
    // deliberately falls THROUGH to step 4, which answers it with the exact
    // line, hour and person instead of a generic sentence. The simultaneous
    // head-count is unreachable here (four lines over three professionals
    // always repeat somebody, and that is caught above), so it falls through
    // too rather than inventing a fifth conflict code for the closed list of
    // §4.9.
    return { status: 400, body: { created: false, error: upFront.message, code: upFront.conflict }, write: null };
  }

  const lines = canonical(input.lines);

  // Step 2 — the intention, derived from the CONTENT (§4.6.1). The header is
  // never compared against it: both sides come from the same lines.
  const intentKey = groupIntentKey(input.date, input.arrangement, lines);

  // Step 3 — structural idempotency (§4.8). Same intention AND every line
  // still standing. If one was cancelled this is NOT a repetition: it falls
  // through and creates a new group (criterion 8.42).
  const alreadyCreated = ctx.groups.find((g) => g.intentKey === intentKey && isFullyAlive(cal, g));
  if (alreadyCreated !== undefined) {
    return {
      status: 200,
      body: { created: false, alreadyExists: true },
      viewGroupId: alreadyCreated.id,
      write: {
        events: [
          {
            kind: "RESERVATION_GROUP_REPEATED",
            actor: "operator",
            atISO: clock.nowInstantISO(),
            groupId: alreadyCreated.id,
            synthetic: true,
          },
        ],
      },
    };
  }

  // Step 4 — REVALIDATE FROM SCRATCH, line by line, over a working calendar
  // that folds in the lines of this same group already validated. The fold is
  // what makes two lines of the same group unable to claim one slot.
  let working = cal;
  const reservations: SyntheticReservation[] = [];
  const groupLines: ReservationGroupLine[] = [];
  const groupId = groupIdFor(ctx.nextGroupNumber);

  for (const [index, line] of lines.entries()) {
    const reasons: string[] = [];
    if (!canPerform(working, line.employeeId, line.serviceId)) reasons.push("professional_cannot_perform_service");
    // (Enmienda de fase K, H2) THE PAST CHECK GOES BEFORE THE HORIZON ONE, and
    // the order is the whole point: `conflict` is `reasons[0]`, so it is this
    // order that decides WHICH true sentence the operator reads. For a day
    // already gone both are true — a past day is also outside the horizon —
    // and the one that helps is "ese hueco ya ha pasado", not "ese día queda
    // fuera del plazo en el que se puede reservar", which sounds like a
    // calendar policy and sends the operator to look for one. Every other
    // date keeps exactly the reason it had: only past days answer both.
    if (isStartInThePast(working.minimumLeadMinutes, clock, input.date, line.startMinutes)) {
      reasons.push("slot_in_the_past");
    }
    if (!isWithinHorizon(working, clock, input.date)) reasons.push("date_outside_booking_horizon");
    if (!isSlotFree(working, line.employeeId, input.date, line.startMinutes)) reasons.push("slot_no_longer_free");

    const first = reasons[0];
    if (first !== undefined) {
      // The FIRST failing line stops everything. Nothing has been written yet
      // and nothing will be: there is no rollback here because there is
      // nothing to roll back.
      return conflictOutcome(cal, first as GroupCreateConflict, line, reasons);
    }

    const reservation: SyntheticReservation = {
      id: groupReservationIdFor(groupId, index + 1),
      employeeId: line.employeeId,
      serviceId: line.serviceId,
      date: input.date,
      startMinutes: line.startMinutes,
      endMinutes: line.startMinutes + cal.slotMinutes,
      status: "confirmed",
      synthetic: true,
    };
    reservations.push(reservation);
    groupLines.push({
      reservationId: reservation.id,
      memberLabel: line.memberLabel,
      serviceId: line.serviceId,
      employeeId: line.employeeId,
      startMinutes: reservation.startMinutes,
      endMinutes: reservation.endMinutes,
    });
    working = { ...working, reservations: [...working.reservations, reservation] };
  }

  // Step 5 — the injected failure, AFTER revalidating and BEFORE any write, so
  // the demo can prove that a failure leaves nothing behind: no group, no
  // reservation in `cal`, none in the MemoryStore and not one audit event.
  if (input.injectFailure === true) {
    return {
      status: 500,
      body: {
        created: false,
        code: "synthetic_injected_failure",
        error: "Fallo sintético inyectado. No se ha creado ninguna cita.",
      },
      write: null,
    };
  }

  // Steps 6 and 7 — mint the identity, build the group, hand the WHOLE write
  // to the caller. One synchronous commit applies group, reservations and
  // events together.
  const atISO = clock.nowInstantISO();
  const group: ReservationGroup = {
    id: groupId,
    arrangement: input.arrangement,
    date: input.date,
    lines: groupLines,
    intentKey,
    createdAtISO: atISO,
    createdBy: "console-operator",
    synthetic: true,
  };
  const firstLine = groupLines[0];

  return {
    status: 201,
    body: {
      created: true,
      // Field by field, never a spread of a domain object.
      reservations: reservations.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        serviceId: r.serviceId,
        date: r.date,
        startMinutes: r.startMinutes,
        endMinutes: r.endMinutes,
        status: r.status,
      })),
    },
    viewGroupId: group.id,
    write: {
      groups: [...ctx.groups, group],
      groupsMinted: 1,
      nextCal: { ...cal, reservations: [...cal.reservations, ...reservations] },
      // THE SAME TICK, both copies (step 17 §14.4, extended to N).
      reservationsToAdd: reservations,
      events: [
        {
          kind: "RESERVATION_GROUP_CREATED",
          actor: "operator",
          atISO,
          groupId: group.id,
          detail: {
            arrangement: input.arrangement,
            date: input.date,
            lineCount: groupLines.length,
            firstStartMinutes: firstLine?.startMinutes ?? 0,
          },
          synthetic: true,
        },
        // ONE event per line, so every appointment of the group is auditable
        // on its own (§4.4's last row).
        ...groupLines.map((line) => ({
          kind: "RESERVATION_GROUP_LINE_CREATED" as const,
          actor: "operator" as const,
          atISO,
          groupId: group.id,
          reservationId: line.reservationId,
          memberLabel: line.memberLabel,
          detail: {
            date: input.date,
            serviceId: line.serviceId,
            employeeId: line.employeeId,
            startMinutes: line.startMinutes,
          },
          synthetic: true as const,
        })),
      ],
    },
  };
}
