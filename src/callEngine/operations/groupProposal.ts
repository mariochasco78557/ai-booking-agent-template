import { chooseProfessional } from "../allocation/anyProfessional.js";
import type { SyntheticReservation } from "../calendar/model.js";
import { freeSlotStarts, isSlotFree, isWithinHorizon } from "../calendar/resolveAvailability.js";
import { canPerform, type CalendarWithCapabilities } from "../capabilities.js";
import { isStartInThePast } from "../domain/slotTime.js";
import { formatHHmm } from "../domain/time.js";
import type { Clock, EmployeeId, ServiceId } from "../domain/types.js";
import {
  GROUP_MAX_LINES,
  GROUP_MEMBER_LABEL_RE,
  GROUP_MIN_LINES,
  GROUP_PROPOSALS_RETURNED,
  compareGroupIntentLines,
  groupSlotKeyFor,
  type GroupArrangement,
  type GroupLineRequest,
  type GroupProposal,
  type GroupProposalLine,
} from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 18 — THE GROUP PROPOSAL ALGORITHM (design §4.5). 100% PURE.
 *
 * IT WRITES NOTHING AND DECIDES NOTHING NEW. Every question it asks is asked
 * with a function that already existed:
 *
 *   - which starts the timetable leaves free → `freeSlotStarts`
 *   - is this exact slot still free          → `isSlotFree`
 *   - is the day inside the booking horizon  → `isWithinHorizon`
 *   - can this person do this service        → `canPerform`
 *   - is the start already gone              → `domain/slotTime.isStartInThePast`
 *   - who is "cualquiera"                    → `allocation/chooseProfessional`
 *
 * There is not ONE line of new timetable, capability or allocation logic in
 * this file, and there must never be: that is the whole reason multi-person
 * booking is a layer ABOVE the engine and not a change inside it (§4.1).
 *
 * DOUBLE BOOKING IS STRUCTURALLY IMPOSSIBLE within a proposal (§4.5): every
 * accepted line is FOLDED into the working calendar before the next line is
 * resolved, so the next line sees that slot occupied and `isSlotFree` discards
 * it. That is why there is no "do not repeat a professional" rule here — and
 * writing one would hide the fact that the folding is what does the work.
 *
 * NO CLOCK IS READ (one is always injected), no state is kept, nothing is
 * cached, and there is no `Date.now()`, no `Math.random()` and no timer.
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------

/**
 * Why a request cannot become proposals. CLOSED list. Each one has exactly one
 * sentence, written below, that says the truth about what the demo cannot do —
 * never "no hay hueco" when the real reason is something else.
 */
export type GroupProposalConflict =
  | "invalid_group_size"
  | "invalid_member_label"
  | "duplicate_member_label"
  | "same_professional_twice_at_the_same_time"
  | "simultaneous_needs_one_professional_per_person"
  | "professional_cannot_perform_service"
  | "date_outside_booking_horizon"
  | "venue_closed_or_no_free_slot"
  | "no_start_fits_the_whole_group";

export interface GroupProposalRejection {
  conflict: GroupProposalConflict;
  /** Spanish, server-side, ready to paint. The browser never composes one. */
  message: string;
}

export interface GroupProposalResult {
  proposals: readonly GroupProposal[];
  rejected?: GroupProposalRejection;
}

export interface GroupProposalInput {
  date: string;
  arrangement: GroupArrangement;
  lines: readonly GroupLineRequest[];
}

// ---------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------

/**
 * The synthetic display name of a professional. A four-token lookup, NOT a
 * duplicated rule: `src/console/operationsSnapshot.ts` has the same lookup
 * because a projection in `src/console` cannot be imported from the engine and
 * the engine cannot import the console.
 */
function professionalLabelOf(cal: CalendarWithCapabilities, employeeId: EmployeeId): string {
  return cal.professionals.find((p) => p.employeeId === employeeId)?.displayName ?? `Profesional ${String(employeeId)}`;
}

function rejection(conflict: GroupProposalConflict, message: string): GroupProposalResult {
  return { proposals: [], rejected: { conflict, message } };
}

/**
 * The provisional reservation an accepted line becomes INSIDE the working
 * calendar while the rest of the group is resolved. It never leaves this
 * module and it is never written anywhere: its only job is to make the slot
 * look occupied to `isSlotFree` and `chooseProfessional` (§4.5).
 */
function foldLine(
  cal: CalendarWithCapabilities,
  line: { employeeId: EmployeeId; serviceId: ServiceId; date: string; startMinutes: number },
  index: number,
): CalendarWithCapabilities {
  const provisional: SyntheticReservation = {
    id: `res-g-en-curso-${String(index)}`,
    employeeId: line.employeeId,
    serviceId: line.serviceId,
    date: line.date,
    startMinutes: line.startMinutes,
    endMinutes: line.startMinutes + cal.slotMinutes,
    status: "confirmed",
    synthetic: true,
  };
  return { ...cal, reservations: [...cal.reservations, provisional] };
}

/** Canonical order of a resolved proposal's lines: start ascending, then employee ascending. */
function inCanonicalOrder(lines: readonly GroupProposalLine[]): GroupProposalLine[] {
  return [...lines].sort(compareGroupIntentLines);
}

// ---------------------------------------------------------------------
// Step 0 — the rejections that happen BEFORE looking at the calendar
// ---------------------------------------------------------------------

/**
 * Everything that can be answered from the request alone. Answering these
 * first is what lets the demo say "una misma persona no puede atender dos
 * citas a la vez" instead of the useless "no hay hueco" that a blind search
 * would have produced (§4.5, escenario §9.4).
 */
export function rejectGroupRequestUpFront(
  cal: CalendarWithCapabilities,
  input: GroupProposalInput,
): GroupProposalRejection | null {
  const { lines, arrangement } = input;

  if (lines.length < GROUP_MIN_LINES || lines.length > GROUP_MAX_LINES) {
    return {
      conflict: "invalid_group_size",
      message: `Una reserva para varias personas necesita entre ${String(GROUP_MIN_LINES)} y ${String(GROUP_MAX_LINES)} personas.`,
    };
  }

  for (const line of lines) {
    if (!GROUP_MEMBER_LABEL_RE.test(line.memberLabel)) {
      return {
        conflict: "invalid_member_label",
        message: "Las etiquetas de las personas son las de la lista cerrada: «Persona 1..4», «Adulto A..D» o «Menor A..D».",
      };
    }
  }

  const labels = new Set(lines.map((l) => l.memberLabel));
  if (labels.size !== lines.length) {
    return { conflict: "duplicate_member_label", message: "Cada persona necesita una etiqueta distinta." };
  }

  if (arrangement === "simultaneous") {
    // Two lines asking for the SAME named person at the same time. It is not a
    // scheduling accident, it is an impossibility, and it is explained as one.
    const requested = lines
      .map((l) => (l.professional.kind === "specific" ? l.professional.employeeId : null))
      .filter((id): id is EmployeeId => id !== null);
    const repeated = requested.find((id, i) => requested.indexOf(id) !== i);
    if (repeated !== undefined) {
      return {
        conflict: "same_professional_twice_at_the_same_time",
        message:
          `Has pedido a ${professionalLabelOf(cal, repeated)} para dos personas a la vez. ` +
          "Una misma persona del equipo no puede atender dos citas en la misma media hora.",
      };
    }
    if (lines.length > cal.professionals.length) {
      return {
        conflict: "simultaneous_needs_one_professional_per_person",
        message:
          `A la vez sólo caben tantas personas como profesionales hay: en esta demostración son ${String(cal.professionals.length)}. ` +
          "Prueba con “una detrás de otra”.",
      };
    }
  }

  // A named person who does not do that service. `canPerform` answers it; this
  // file never looks inside the capability matrix.
  for (const line of lines) {
    if (line.professional.kind !== "specific") continue;
    if (!canPerform(cal, line.professional.employeeId, line.serviceId)) {
      return {
        conflict: "professional_cannot_perform_service",
        message:
          `${professionalLabelOf(cal, line.professional.employeeId)} no hace ese servicio. ` +
          "Elige a otra persona del equipo o cambia el servicio.",
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------
// Steps 1..3 — the search itself
// ---------------------------------------------------------------------

/**
 * The order lines are RESOLVED in (§4.5, step 2):
 *
 *   - `consecutive`: the order the operator wrote them in; line `i` goes to
 *     `S + i * slotMinutes`.
 *   - `simultaneous`: the `specific` ones FIRST (in input order), then the
 *     `any` ones (in input order); all of them at `S`. A named request cannot
 *     be re-routed and a "cualquiera" can, so resolving the rigid half first is
 *     what makes the answer independent of the order the operator typed in.
 */
function resolutionOrder(input: GroupProposalInput): readonly { line: GroupLineRequest; offset: number }[] {
  if (input.arrangement === "consecutive") {
    return input.lines.map((line, i) => ({ line, offset: i }));
  }
  const specific = input.lines.filter((l) => l.professional.kind === "specific");
  const any = input.lines.filter((l) => l.professional.kind === "any");
  return [...specific, ...any].map((line) => ({ line, offset: 0 }));
}

/** Tries to resolve the WHOLE group starting at `start`. `null` when this start does not work. */
function resolveAt(
  cal: CalendarWithCapabilities,
  clock: Clock,
  input: GroupProposalInput,
  start: number,
): GroupProposal | null {
  let working = cal;
  const resolved: GroupProposalLine[] = [];

  for (const { line, offset } of resolutionOrder(input)) {
    const startMinutes = start + offset * cal.slotMinutes;
    // A later line of a consecutive group can only be later than `start`, so
    // the past check made on `start` already covers it; asking again costs
    // nothing and keeps the guarantee local to this loop.
    if (isStartInThePast(cal.minimumLeadMinutes, clock, input.date, startMinutes)) return null;

    let employeeId: EmployeeId;
    if (line.professional.kind === "specific") {
      employeeId = line.professional.employeeId;
      if (!canPerform(working, employeeId, line.serviceId)) return null;
      if (!isSlotFree(working, employeeId, input.date, startMinutes)) return null;
    } else {
      // `chooseProfessional` AS IT IS (allocation/anyProfessional.ts:36). It
      // sees the working calendar, so the lines this very group has already
      // taken count against its load-balancing — which is exactly what is
      // wanted (§4.5's note on the tie-break).
      const choice = chooseProfessional(working, input.date, startMinutes, line.serviceId);
      if (choice.employeeId === null) return null;
      employeeId = choice.employeeId;
    }

    resolved.push({
      memberLabel: line.memberLabel,
      serviceId: line.serviceId,
      employeeId,
      date: input.date,
      startMinutes,
      endMinutes: startMinutes + cal.slotMinutes,
      slotKey: groupSlotKeyFor(input.date, startMinutes, employeeId),
      professionalWasRequested: line.professional.kind === "specific",
    });
    working = foldLine(working, { employeeId, serviceId: line.serviceId, date: input.date, startMinutes }, resolved.length);
  }

  return { arrangement: input.arrangement, date: input.date, lines: inCanonicalOrder(resolved) };
}

/**
 * THE ALGORITHM OF §4.5, end to end. Returns up to three proposals — the first
 * three starts that resolve the whole group, ascending — or one rejection that
 * says why there are none.
 *
 * Three is a demonstration number, documented as such (§4.5, step 3). The
 * proposals arrive with NO preselection, NO "recommended" and NO highlight:
 * choosing is the operator's job.
 */
export function proposeGroup(
  cal: CalendarWithCapabilities,
  clock: Clock,
  input: GroupProposalInput,
): GroupProposalResult {
  const upFront = rejectGroupRequestUpFront(cal, input);
  if (upFront !== null) return { proposals: [], rejected: upFront };

  if (!isWithinHorizon(cal, clock, input.date)) {
    return rejection(
      "date_outside_booking_horizon",
      "Ese día queda fuera del plazo en el que esta demostración reserva citas.",
    );
  }

  const candidates = [
    ...new Set(cal.professionals.flatMap((p) => freeSlotStarts(cal, p.employeeId, input.date))),
  ]
    .sort((a, b) => a - b)
    .filter((s) => !isStartInThePast(cal.minimumLeadMinutes, clock, input.date, s));

  if (candidates.length === 0) {
    return rejection(
      "venue_closed_or_no_free_slot",
      "Ese día no queda ningún hueco libre en la agenda sintética.",
    );
  }

  const proposals: GroupProposal[] = [];
  for (const start of candidates) {
    const resolvedProposal = resolveAt(cal, clock, input, start);
    if (resolvedProposal !== null) proposals.push(resolvedProposal);
    if (proposals.length === GROUP_PROPOSALS_RETURNED) break;
  }

  if (proposals.length === 0) {
    return rejection(
      "no_start_fits_the_whole_group",
      `Hay huecos sueltos ese día (el primero, a las ${formatHHmm(candidates[0] ?? 0)}), pero ninguno permite colocar a las ${String(input.lines.length)} personas como las has pedido.`,
    );
  }

  return { proposals };
}
