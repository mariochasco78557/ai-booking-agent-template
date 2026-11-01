/**
 * Port interfaces only — NO implementation, and in particular no network
 * client of any kind, anywhere in this file or its (non-existent) adapters.
 * This mission (step 13) is local and synthetic only: voice, telephony,
 * WhatsApp notifications, reminders and the real Demo Salon agenda all stay
 * behind these interfaces and are NOT implemented here. `store/
 * memoryStore.ts` and `humanCascade.ts` use small in-memory synthetic
 * stand-ins where a concrete value is needed for a test/demo, never a real
 * adapter for any of these ports. Building a real adapter for any one of
 * them is explicitly out of this mission's scope (see docs/
 * (internal doc, not included in the template)'s "No alcance").
 */

import type { HumanAssistanceAction } from "../../types/voiceOutcomes.js";
import type { EmployeeId, ServiceId } from "../domain/types.js";
import type { SyntheticReservation } from "../calendar/model.js";
import type { PhraseKey } from "../phrasing/keys.js";

// Re-exported so callers of this module never need to reach into
// calendar/model.ts directly just to name the holiday-provider contract.
export type { HolidayProvider } from "../calendar/model.js";

/**
 * The (future) real Demo Salon agenda, behind a port. Every method here mirrors
 * the pure functions already implemented against `OperationalCalendar`
 * (calendar/resolveAvailability.ts, allocation/anyProfessional.ts) —
 * this interface exists so a future adapter can satisfy the SAME shape
 * against a real backend, without the call engine's own logic caring which
 * one it is talking to. `revalidateSlot` mirrors `isSlotFree`'s "no cache,
 * recompute from scratch" contract: it MUST be called again, immediately
 * before writing, even if `findSlots` was called moments earlier.
 */
export interface AgendaPort {
  findSlots(input: {
    employeeId: EmployeeId | "any";
    serviceId: ServiceId;
    dateISO: string;
  }): Promise<readonly { employeeId: EmployeeId; startMinutes: number }[]>;

  createReservation(input: {
    employeeId: EmployeeId;
    serviceId: ServiceId;
    dateISO: string;
    startMinutes: number;
    endMinutes: number;
    callIdHash: string;
  }): Promise<SyntheticReservation>;

  revalidateSlot(input: { employeeId: EmployeeId; dateISO: string; startMinutes: number }): Promise<boolean>;
}

/** The (future) real voice channel, behind a port. `say` only ever takes a `PhraseKey` — never raw text (see phrasing/keys.ts). */
export interface VoicePort {
  say(phraseKey: PhraseKey, params?: Record<string, unknown>): Promise<void>;
  listen(): Promise<string>;
}

/**
 * The (future) real telephony provider, behind a port.
 * `requestLiveTransfer` returns `HumanAssistanceAction`
 * (src/types/voiceOutcomes.ts) — the SAME single-member
 * `"human_assistance_required"` type the rest of this middleware already
 * uses, deliberately reused rather than duplicated (see that file's
 * docblock and src/types/transferAction.ts's 3-member union, which this
 * module never imports). No implementation here can ever claim a transfer
 * was requested, let alone completed — the return type makes that a
 * compile error, not a convention someone has to remember.
 */
export interface TelephonyPort {
  requestLiveTransfer(input: { callIdHash: string; reason: string }): Promise<HumanAssistanceAction>;
}

/**
 * The (future) real notification channel, behind a port. `'whatsapp'` and
 * `'internal'` are the two channels this mission's docs anticipate
 * ((internal doc, not included in the template), PILOT_METRICS.md) — no adapter
 * for either is implemented here; `humanCascade.ts`'s escalation cascade
 * only ever REQUESTS a notice, synthetically, never sends one.
 */
export interface NotificationPort {
  sendInternalNotice(input: {
    channel: "whatsapp" | "internal";
    callIdHash: string;
    reason: string;
  }): Promise<void>;
}

/** The (future) real reminder scheduler, behind a port. Not implemented here. */
export interface ReminderPort {
  scheduleReminder(input: { callIdHash: string; dateISO: string; startMinutes: number }): Promise<void>;
}
