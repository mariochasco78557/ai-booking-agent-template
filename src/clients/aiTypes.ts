/**
 * Types for the Symfony `/v1/ai/*` contract (step 10, design §6), derived
 * from the CAPTURED fixtures in
 * tools/legacy-symfony-lab/mvps10/fixtures/contract/*.json — those bodies
 * come from the real disposable-lab Symfony implementation
 * (tools/legacy-symfony-lab/mvps10/overlay/src/AiApi/), not hand-written
 * guesses. See (internal doc, not included in the template) §6.
 *
 * Every `/v1/ai/*` response shares one envelope:
 *   { ok: boolean, code: string, message: string, data: T }
 * Errors use the same envelope with `ok: false` and a machine `code`
 * (WRITE_OPERATIONS_DISABLED, OWNER_PHONE_UNSUPPORTED,
 * LOOKUP_BY_PHONE_UNSUPPORTED, SLOT_TAKEN, DUPLICATE_CALLER_BOOKING, ...).
 * `code` and `message` are never shown verbatim to a caller — see
 * src/services/bookingService.ts / lookupService.ts for the Spanish,
 * bounded phrasing callers actually hear.
 */

/** Shared response envelope for every `/v1/ai/*` endpoint. */
export interface AiEnvelope<T> {
  ok: boolean;
  code: string;
  message: string;
  data: T;
}

/** `POST /v1/ai/availability` request body. */
export interface AiAvailabilityRequest {
  date: string;
  typeReservation: number;
  employeeIds?: number[];
  maxSlots?: number;
}

export interface AiAvailabilityEmployeeSlots {
  employeeId: number;
  name: string;
  slots: string[]; // "HH:mm"
}

/** `POST /v1/ai/availability` response `data`. */
export interface AiAvailabilityData {
  employees: AiAvailabilityEmployeeSlots[];
}

/** `POST /v1/ai/availability/slot` request body. */
export interface AiAvailabilitySlotRequest {
  reservationDate: string; // "YYYY-MM-DD HH:mm:ss"
  employeeId: number;
  typeReservation: number;
}

/** `POST /v1/ai/availability/slot` response `data`. */
export interface AiAvailabilitySlotData {
  available: boolean;
}

/** `POST /v1/ai/reservation` request body. */
export interface AiReservationRequest {
  customer: { name: string; surnames: string; phone: string };
  reservationDate: string;
  employeeId: number;
  typeReservation: number;
}

/** `POST /v1/ai/reservation` response `data` (201). Never the raw db id. */
export interface AiReservationData {
  reservationRef: string;
  dateLabel: string;
  employeeName: string;
}

/** `POST /v1/ai/lookup` request body. */
export interface AiLookupRequest {
  phone: string;
  fromDate?: string;
}

export interface AiLookupMatch {
  reservationRef: string;
  dateLabel: string;
  employeeName: string;
}

/** `POST /v1/ai/lookup` response `data` — shape varies with `code`. */
export interface AiLookupData {
  matches?: AiLookupMatch[];
  /** Present (`true`) only on the 501 LOOKUP_BY_PHONE_UNSUPPORTED response. */
  unsupported?: boolean;
}

/** `POST /v1/ai/cancellation/proof` request body. */
export interface AiCancellationProofRequest {
  reservationRef: string;
  confirm: { name: string; phone: string };
}

/** `POST /v1/ai/cancellation/proof` response `data` (200). */
export interface AiCancellationProofData {
  cancellationProof: string;
  expiresInSeconds: number;
}

/** `POST /v1/ai/cancellation` request body. */
export interface AiCancellationRequest {
  reservationRef: string;
  cancellationProof: string;
}

/** `POST /v1/ai/cancellation` response `data` (200). */
export interface AiCancellationData {
  cancelled: boolean;
  alreadyCancelled: boolean;
}

/**
 * Machine `code`s the middleware maps explicitly (design §6, §5). Not
 * exhaustive of every code Symfony can emit — only the ones caller-facing
 * behaviour is keyed on.
 */
export const AI_CODE = {
  WRITE_OPERATIONS_DISABLED: "WRITE_OPERATIONS_DISABLED",
  OWNER_PHONE_UNSUPPORTED: "OWNER_PHONE_UNSUPPORTED",
  LOOKUP_BY_PHONE_UNSUPPORTED: "LOOKUP_BY_PHONE_UNSUPPORTED",
  SLOT_TAKEN: "SLOT_TAKEN",
  DUPLICATE_CALLER_BOOKING: "DUPLICATE_CALLER_BOOKING",
  AMBIGUOUS: "AMBIGUOUS",
  NO_MATCH: "NO_MATCH",
  CLOSED_HOLIDAY: "CLOSED_HOLIDAY",
  PROOF_ALREADY_USED: "PROOF_ALREADY_USED",
  PROOF_EXPIRED: "PROOF_EXPIRED",
  PROOF_SCOPE_MISMATCH: "PROOF_SCOPE_MISMATCH",
} as const;
