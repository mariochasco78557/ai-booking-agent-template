/**
 * Shared domain types for the call-engine synthetic demo (step 13).
 *
 * SCOPE: this module (and everything under src/callEngine/**) is local and
 * synthetic only. No network calls, no real customer data, no wall-clock
 * reads (Date.now() / new Date() with no argument / Math.random()) — the
 * clock is always injected. See fixtures/syntheticVenue.ts for the labelled
 * synthetic data used by the demo and by tests.
 */
import { serviceLabel } from "../../core/texts/texts.js";

/**
 * Historical service codes of the reference client. Verified against the 2020
 * legacy system code — these three integer codes (0, 1, 2) are the only ones this module
 * knows about. Never add prices here, and never invent a duration for a
 * service outside this set: see SPECIAL_SERVICE_REQUIRES_HUMAN below for
 * how services outside this catalogue (e.g. colouring) are handled.
 */
export type ServiceId = 0 | 1 | 2;

/**
 * Human-readable labels for the service codes above: the `nombre` of each
 * `servicios[]` entry in `cliente.yaml` (D-012), read once at module load.
 * A code the client does not configure falls back to "Servicio <n>".
 */
export const SERVICE_LABELS: Readonly<Record<ServiceId, string>> = {
  0: serviceLabel(0, "nombre") ?? "Servicio 0",
  1: serviceLabel(1, "nombre") ?? "Servicio 1",
  2: serviceLabel(2, "nombre") ?? "Servicio 2",
};

/** Synthetic standard slot duration (minutes) used across the call-engine demo. */
export const SLOT_MINUTES = 30;

/**
 * Special services (for example colouring) are NOT part of the three-code
 * catalogue above and are NOT modelled anywhere in this module. They fall
 * entirely outside the automated availability/booking flow and are always
 * handed off to a human — this module never invents a duration or
 * availability window for a special service.
 */
export const SPECIAL_SERVICE_REQUIRES_HUMAN = true;

export type EmployeeId = number;

export interface SyntheticProfessional {
  employeeId: EmployeeId;
  displayName: string;
  synthetic: true;
}

export type ProfessionalPreference =
  | { kind: "any" }
  | { kind: "specific"; employeeId: EmployeeId };

/**
 * Injected clock. Call-engine logic must never read the real wall clock
 * directly; every function that needs "now" takes a `Clock` parameter so
 * behaviour stays fully deterministic and testable.
 */
export interface Clock {
  /** Current local date, "YYYY-MM-DD" (Europe/Madrid wall-clock date). */
  nowISODate(): string;
  /** Current local minutes-since-midnight (0..1439). */
  nowMinutes(): number;
  /** Current local instant as an ISO-like string, for logging/audit only. */
  nowInstantISO(): string;
}

/** Fully deterministic `Clock` implementation for tests and demos. */
export function fixedClock(dateISO: string, minutes: number): Clock {
  return {
    nowISODate: () => dateISO,
    nowMinutes: () => minutes,
    nowInstantISO: () => {
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      const mm = String(minutes % 60).padStart(2, "0");
      return `${dateISO}T${hh}:${mm}:00`;
    },
  };
}
