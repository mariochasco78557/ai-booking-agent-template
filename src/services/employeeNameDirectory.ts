/**
 * *** WHO id 1 IS, IN WORDS. ***
 *
 * A booking carries an `employee_id` and nothing else. The barber's NAME is
 * known earlier — `/user/employees-day` returns the day's roster, and a
 * balanced V2 `lock` already speaks it («Te lo dejo a las 10:30 con Bruno») —
 * but by the time `VoiceBookingService` writes the appointment the only thing
 * left of that person is a number: the slot token seals `employeeId`, and
 * `EffectiveBooking` is built from the token precisely so nothing else can be
 * reconstructed from the conversation.
 *
 * The WhatsApp confirmation wants the name back, and it must not pay for it.
 * Re-reading the agenda at write time would put an upstream call on the
 * latency path of a live phone call, immediately after the one write we care
 * most about finishing quickly — for a cosmetic field. So this directory
 * remembers what the process has ALREADY seen: every `lock` records the
 * roster of the day it authorized against, and the write path asks a `Map`.
 *
 * ── What it is NOT ────────────────────────────────────────────────────────
 *
 * It is not authority over the agenda and it never decides anything. A miss
 * is ordinary and harmless: the confirmation then says «con el equipo de
 * Demo Salon» (see `whatsapp/whatsappTemplate.ts`). A restart empties it, an
 * unknown id answers `undefined`, and no caller may treat a name found here as
 * evidence that the person works that day.
 *
 * In-memory and single-process, like the offer and option stores, and for the
 * same reason: it is a cache of something the salon's API is the authority on.
 */

export interface EmployeeNameDirectory {
  /** Remembers a barber's spoken name. An empty name is ignored. */
  record(employeeId: number, name: string): void;
  /** The name, or `undefined` when this process has never seen the id. */
  nameOf(employeeId: number): string | undefined;
}

/**
 * Ceiling on remembered barbers. A salon's roster is single digits; this is
 * three orders of magnitude above it, so it can only ever bound a mistake.
 */
export const EMPLOYEE_NAME_MAX_ENTRIES = 500;

/**
 * The barber's name as a person would say it.
 *
 * Upstream stores display names loosely — `"bruno "` with a trailing space is
 * the real, verified shape. Trimmed and capitalized, never invented: accents
 * this middleware does not receive are not added, because a name the salon
 * does not use is worse than an unaccented one. Same rule, and the same
 * wording, as `spokenEmployeeName` in
 * `src/services/balanced/balancedAvailabilityService.ts` — except that an
 * unnameable barber yields `undefined` here rather than a placeholder
 * sentence, because a written message has its own fallback.
 */
export function cleanEmployeeName(name: string): string | undefined {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (cleaned === "") return undefined;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export class MemoryEmployeeNameDirectory implements EmployeeNameDirectory {
  private readonly names = new Map<number, string>();

  record(employeeId: number, name: string): void {
    if (!Number.isInteger(employeeId) || employeeId <= 0) return;
    const cleaned = cleanEmployeeName(name);
    if (cleaned === undefined) return;
    // Re-inserted rather than updated in place so the map stays in
    // least-recently-seen order and the eviction below keeps the roster the
    // salon is actually using.
    this.names.delete(employeeId);
    this.names.set(employeeId, cleaned);
    while (this.names.size > EMPLOYEE_NAME_MAX_ENTRIES) {
      const oldest = this.names.keys().next();
      if (oldest.done === true) break;
      this.names.delete(oldest.value);
    }
  }

  nameOf(employeeId: number): string | undefined {
    return this.names.get(employeeId);
  }
}
