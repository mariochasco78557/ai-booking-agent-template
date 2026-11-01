import { z } from "zod";

import type { Logger } from "../authTokenService.js";
import type { EmployeeNameDirectory } from "../employeeNameDirectory.js";
import type { SlotAuthorizationService } from "../slotAuthorization.js";
import { appointmentCalendarUrl, type CalendarLinkConfig } from "../whatsapp/whatsappNotifier.js";

/**
 * `POST /ai/wa/calendar-link` ((internal doc, not included in the template) §5.3).
 *
 * The WhatsApp brain adds the «Añadir al calendario» link after every confirmed
 * booking. When the booking answer carried no valid `calendar_url`, it asks for
 * it here with the `slot_token` of that booking. The token already carries the
 * date and hour, the professional and the service, and the link is
 * deterministic, so the URL is the SAME one the booking would have returned.
 *
 * READ-ONLY: writes nothing, calls nothing upstream, carries no personal data
 * (no name, no phone) and logs none.
 */

/** A token that expired up to this long ago still opens: the booking was made with it. */
export const CALENDAR_LINK_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

export const waCalendarLinkSchema = z.object({
  conversation_id: z.string().trim().min(1).max(200),
  slot_token: z.string().trim().min(1).max(2000),
});

export interface WaCalendarLinkResponse {
  outcome: "calendar_url" | "calendar_unavailable" | "invalid_request";
  calendar_url?: string;
  external_mutation: false;
}

export interface WaCalendarLinkDeps {
  /** The slot-token domain the WhatsApp booking path mints in (balanced V2). */
  slotAuthorization: SlotAuthorizationService;
  /** Absent when the calendar env vars are not set: nothing can be produced. */
  calendar?: { config: CalendarLinkConfig; employeeNames?: EmployeeNameDirectory };
  logger: Logger;
}

export class WaCalendarLinkService {
  constructor(private readonly deps: WaCalendarLinkDeps) {
    deps.logger.info({ calendar_link_configured: deps.calendar !== undefined }, "wa calendar-link route configured");
  }

  lookup(body: unknown, nowMs: number): WaCalendarLinkResponse {
    const parsed = waCalendarLinkSchema.safeParse(body);
    if (!parsed.success) return { outcome: "invalid_request", external_mutation: false };
    const unavailable: WaCalendarLinkResponse = { outcome: "calendar_unavailable", external_mutation: false };
    const { calendar, slotAuthorization, logger } = this.deps;
    if (calendar === undefined) return unavailable;

    const opened = slotAuthorization.open(
      parsed.data.slot_token,
      parsed.data.conversation_id,
      nowMs,
      CALENDAR_LINK_TOKEN_GRACE_MS,
    );
    if (!opened.ok) {
      // The failure class only; never the token or the conversation.
      logger.info({ failure: opened.failure }, "wa calendar-link: token refused");
      return unavailable;
    }
    const url = appointmentCalendarUrl(
      calendar.config,
      {
        reservationDate: opened.grant.reservationDate,
        ...(opened.grant.employeeId !== undefined ? { employeeId: opened.grant.employeeId } : {}),
        serviceId: opened.grant.serviceId,
      },
      calendar.employeeNames,
    );
    if (url === undefined) return unavailable;
    return { outcome: "calendar_url", calendar_url: url, external_mutation: false };
  }
}
