/**
 * Puerto `CalendarProvider` (fase 1 de (internal doc, not included in the template)).
 *
 * The booking core (availability, booking, cancellation, lookup, agenda
 * cache, WhatsApp self-service) talks to the salon's calendar ONLY through
 * these interfaces. Concrete backends live in `src/adapters/calendar/<id>/`;
 * the composition root (`src/services/container.ts`) picks one with
 * `CALENDAR_PROVIDER` (default `memory`; `google-calendar`, D-014).
 *
 * Vocabulary: a *resource* is whoever or whatever a booking is made with (an
 * employee/barber); a *service* is the kind of booking (its id is a string,
 * e.g. "1"); a *booking* is an appointment; a *slot* is a free start/end pair.
 *
 * Authentication is the adapter's business: no method takes a token. The
 * only session lifecycle visible to callers is {@link CalendarProvider.ensureSession}
 * (warm the session before a burst of calls, preserving the historical call
 * order) and {@link CalendarProvider.resetSession} (drop it after a 401 so the
 * next call starts a fresh one).
 *
 * Phase-1 decision ((internal doc, not included in the template), D-003): payload field layouts are the
 * ones the core already uses (`reservationDate`, `typeReservation`, ...), so
 * this phase changes no behaviour. Renaming fields is deferred to phase 3,
 * when a second adapter gives the mapping something real to be tested against.
 */
import type {
  AiAvailabilityData,
  AiAvailabilityRequest,
  AiAvailabilitySlotData,
  AiAvailabilitySlotRequest,
  AiCancellationData,
  AiCancellationProofData,
  AiCancellationProofRequest,
  AiCancellationRequest,
  AiEnvelope,
  AiLookupData,
  AiLookupRequest,
  AiReservationData,
  AiReservationRequest,
} from "../../clients/aiTypes.js";
import type {
  DashboardRange,
  DashboardReservation,
} from "../../services/waSelfService/dashboardMapping.js";

export { UpstreamError, type UpstreamErrorInfo } from "./errors.js";

/** Identifiers accepted by `CALENDAR_PROVIDER`. */
export const CALENDAR_PROVIDER_IDS = ["memory", "google-calendar"] as const;
export type CalendarProviderId = (typeof CALENDAR_PROVIDER_IDS)[number];

/** A bookable resource (employee). `name`/`surnames` are kept verbatim. */
export interface CalendarResource {
  id: number;
  name: string;
  surnames: string;
}

/** A free slot, wall-clock `"YYYY-MM-DD HH:mm:ss"` in the business timezone. */
export interface CalendarSlot {
  start: string;
  end: string;
}

/** Free slots of one resource on one day. */
export interface ResourceFreeSlots extends CalendarResource {
  date: string;
  slots: CalendarSlot[];
}

export interface FreeSlotsQuery {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Resources to ask about. Empty -> `[]` without contacting the backend. */
  resourceIds: readonly number[];
  serviceId: string;
}

/**
 * New booking. Layout inherited from the core (see D-003):
 * `typeReservation` = service id, `employee` = resource, `owner*` = customer
 * (`owner` itself is the optional account the booking is filed under).
 */
export interface CalendarBookingRequest {
  /** `"YYYY-MM-DD HH:mm:ss"`. */
  reservationDate: string;
  typeReservation: string;
  employee: CalendarResource;
  owner?: CalendarResource;
  ownerName: string;
  ownerSurnames: string;
  ownerPhone?: string;
}

export interface CreatedBooking {
  id?: number;
}

/** In-band result of the assistant-contract operations: `{ ok, code, message, data }`. */
export type CalendarEnvelope<T> = AiEnvelope<T>;

/**
 * Calendar operations performed with the booking (service) account.
 *
 * The last six operations form the *assistant contract*: higher-level,
 * server-side-checked operations (availability, slot check, checked booking,
 * lookup by verified phone, two-step cancellation). They are only called
 * when `BOOKING_UPSTREAM_MODE=ai`. They return the full envelope and callers
 * decide from `ok`/`code`; a non-2xx answer throws {@link UpstreamError} with
 * `code` set.
 */
export interface CalendarProvider {
  readonly id: CalendarProviderId;

  /** Make sure a session exists (log in if needed). Errors as `UpstreamError`. */
  ensureSession(): Promise<void>;
  /** Forget the current session; the next call starts a new one. */
  resetSession(): void;

  /** Resources working on `date` (`YYYY-MM-DD`). */
  listResourcesForDay(date: string): Promise<CalendarResource[]>;
  /**
   * Free slots for several resources in one read. A resource with no free
   * slot is ABSENT from the result (never `slots: []`): match by id, never
   * fall back to `result[0]` unless the caller deliberately wants that.
   */
  listFreeSlots(query: FreeSlotsQuery): Promise<ResourceFreeSlots[]>;
  /** Create a booking. */
  createBooking(request: CalendarBookingRequest): Promise<CreatedBooking>;

  // --- assistant contract (BOOKING_UPSTREAM_MODE=ai) -----------------------
  checkAvailability(request: AiAvailabilityRequest): Promise<CalendarEnvelope<AiAvailabilityData>>;
  checkSlot(request: AiAvailabilitySlotRequest): Promise<CalendarEnvelope<AiAvailabilitySlotData>>;
  createCheckedBooking(request: AiReservationRequest): Promise<CalendarEnvelope<AiReservationData>>;
  /** `verifiedCallerId` MUST come from telephony, never from what the caller said. */
  findBookingsByPhone(
    request: AiLookupRequest,
    verifiedCallerId: string,
  ): Promise<CalendarEnvelope<AiLookupData>>;
  requestCancellationProof(
    request: AiCancellationProofRequest,
  ): Promise<CalendarEnvelope<AiCancellationProofData>>;
  cancelBooking(request: AiCancellationRequest): Promise<CalendarEnvelope<AiCancellationData>>;
}

export type BackOfficeRange = DashboardRange;
export type BackOfficeBooking = DashboardReservation;

export interface BackOfficeBookingList {
  rows: BackOfficeBooking[];
  stats: { total: number; unparseable: number };
}

/**
 * Calendar operations performed with a SEPARATE staff identity (WhatsApp
 * self-service: list a customer's bookings, cancel one of them). Kept apart
 * from {@link CalendarProvider} on purpose: a different credential with a
 * wider reach, used only behind the WhatsApp ownership checks (ADR-032).
 */
export interface CalendarBackOffice {
  /** Bookings in an inclusive `YYYY-MM-DD` range. */
  listBookings(range: BackOfficeRange): Promise<BackOfficeBookingList>;
  /** Cancel by backend id. `"not_found"` when it no longer exists. */
  cancelBookingById(bookingId: number): Promise<"deleted" | "not_found">;
}
