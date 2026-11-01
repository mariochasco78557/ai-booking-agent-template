/**
 * Types describing the upstream Demo Salon Symfony API (/v1) shapes we consume.
 * These reflect OBSERVED payloads from (internal doc, not included in the template). Fields marked
 * "assumed" are not fully verified — see (internal doc, not included in the template).
 */

export interface DemoSalonSlot {
  start: string; // "2026-07-29 09:30:00"
  end: string; // "2026-07-29 10:00:00"
}

export interface FreeEmployee {
  id: number;
  name: string;
  surnames: string;
  date: string;
  slots: DemoSalonSlot[];
}

export interface EmployeeRef {
  id: number;
  name: string;
  surnames: string;
}

export interface DemoSalonOwnerRef {
  id: number;
  name: string;
  surnames: string;
}

/**
 * Body for POST /v1/reservation (observed shape).
 *
 * `owner` is OPTIONAL, and that is the whole point — step CTL-3.
 *
 * The legacy controller sets the owner FK *conditionally*:
 *
 * ```php
 * if ($reservation->getOwner()) { $reservation->setOwner($this->getUser()); }
 * ```
 *
 * (`ReservationsController.php:82-83`, cited in
 * (internal doc, not included in the template).) So supplying an
 * `owner` does NOT attach the customer — it attaches *us*, the authenticated
 * service account. Omitting it leaves `reservation.user_id` NULL, which the
 * schema explicitly allows (`Reservation.php:62-65`, `nullable=true`), while
 * `ownerName`/`ownerSurnames`/`ownerPhone` persist regardless.
 *
 * That unowned shape is not an edge case: it is what the salon's own booking
 * form already sends. The compiled Angular client assembles exactly
 * `typeReservation` / `ownerName` / `ownerSurnames` / `ownerPhone` and no
 * `owner` at all ((internal doc, not included in the template) §4).
 * Every manual and web reservation in the salon is therefore already an
 * unowned "guest" reservation. See `BookingConfig.ownerMode`.
 */
export interface CreateReservationBody {
  reservationDate: string; // "2026-07-21 12:00:00"
  typeReservation: string; // "1"
  employee: EmployeeRef;
  /** Omitted entirely in guest mode; see the note above. */
  owner?: DemoSalonOwnerRef;
  ownerName: string;
  ownerSurnames: string;
  ownerPhone?: string; // assumed — presence in POST is UNVERIFIED
}

/**
 * Item from GET /v1/reservation/user.
 *
 * Shape mirrors the verified upstream projection (legacy
 * ReservationRepository.php:31): partial r.{id,reservationDate,typeReservation}
 * + partial e.{id,name,surnames} + partial o.{id,name,surnames}.
 * `owner` is the authenticated SERVICE ACCOUNT, never the caller, and carries
 * no phone/email. Do not add speculative fields here — the compiler is the
 * guard that stopped a filter on a non-existent `owner.phone`.
 */
export interface DemoSalonUserReservation {
  id: number;
  reservationDate: string;
  typeReservation: number;
  owner: { id: number; name: string; surnames: string };
  employee: { id: number; name: string; surnames: string };
}
