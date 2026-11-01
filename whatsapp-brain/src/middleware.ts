/**
 * Client for the Demo Salon middleware: the SAME two routes the voice agent uses
 * (Balanced V2), reached over the internal Docker network.
 *
 * Every failure becomes an `outcome` the prompt already knows how to handle,
 * so a network problem can never leave the model without an answer — and the
 * prompt's rule «never say it is booked without `booked` true and
 * `confirmed`» still holds, because a failure never carries `booked: true`.
 */
import { requestJson, type FetchLike } from "./http.js";

/** Body of POST /ai/wa/recado ((internal doc, not included in the template), A.7). */
export interface RecadoBody {
  conversation_id: string;
  kind: "late" | "wants_human" | "complaint" | "question";
  summary: string;
  minutes_late?: number;
  customer_name?: string;
  callback_phone?: string;
  vocero_conversation_id?: string;
}

export interface MiddlewareApi {
  availability(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  book(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** ADR-032 lookup. `callerPhone` is the sender's 9-digit Spanish number. */
  myReservations(callerPhone: string, conversationId?: string): Promise<Record<string, unknown>>;
  /** ADR-032 cancellation of one of the caller's own appointments. */
  cancel(callerPhone: string, body: { reservation_ref: string; confirmed_by_customer: boolean; conversation_id?: string }): Promise<Record<string, unknown>>;
  /**
   * 2026-10-11 «cambiar servicio» (POST /ai/wa/change-service): same verified
   * caller header as `cancel`. Optional so older fakes keep compiling; absent
   * = the tool answers `service_change_unavailable`.
   */
  changeService?(
    callerPhone: string,
    body: { reservation_ref: string; service_id: 0 | 1 | 2; confirmed_by_customer: boolean; conversation_id?: string }
  ): Promise<Record<string, unknown>>;
  /**
   * Message for Bruno (POST /ai/wa/recado). `callerPhone` is the 9-digit Spanish
   * number, or null for a foreign one (then no caller-id header is sent).
   * Any failure is `{ outcome: "recado_unavailable" }`.
   */
  recado(callerPhone: string | null, body: RecadoBody): Promise<Record<string, unknown>>;
  /**
   * 2026-10-11 — POST /ai/wa/calendar-link: the calendar link of a booked
   * slot_token, read-only (`{ outcome: "calendar_url", calendar_url }` or
   * `{ outcome: "calendar_unavailable" }`). Optional so that a client or test
   * double without it simply counts as «unavailable».
   */
  calendarLink?(callerPhone: string | null, body: CalendarLinkBody): Promise<Record<string, unknown>>;
}

/** Body of POST /ai/wa/calendar-link ((internal doc, not included in the template), 5.3). */
export interface CalendarLinkBody {
  conversation_id: string;
  slot_token: string;
}

const UNAVAILABLE_MESSAGE =
  "Ahora mismo no puedo consultar la agenda. Si quieres, le dejo el aviso a Bruno para que te conteste.";

// Never claims «not cancelled»: after a network failure or an unreadable answer
// the delete may or may not have happened (external_mutation null).
const UNCERTAIN_MESSAGE =
  "No puedo confirmar si la cita ha quedado anulada. Si quieres, le dejo el aviso a Bruno para que lo compruebe.";

export class MiddlewareClient implements MiddlewareApi {
  constructor(
    private readonly baseUrl: string,
    private readonly webhookSecret: string,
    private readonly bookingSecret: string | undefined,
    private readonly selfServiceSecret: string | undefined = undefined,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async availability(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // `x-ai-channel: whatsapp` (2026-10-08): the middleware answers with
    // WRITTEN pages of up to BALANCED_WA_MAX_OPTIONS hours instead of the
    // spoken three. `lock` validates against the page actually stored.
    return this.post(
      "/ai/voice/v2/availability",
      body,
      { "x-ai-webhook-secret": this.webhookSecret, "x-ai-channel": "whatsapp" },
      20_000
    );
  }

  async book(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "x-ai-webhook-secret": this.webhookSecret, "x-ai-channel": "whatsapp" };
    if (this.bookingSecret) headers["x-ai-booking-secret"] = this.bookingSecret;
    return this.post("/ai/voice/v2/book", body, headers, 30_000);
  }

  async myReservations(callerPhone: string, conversationId?: string): Promise<Record<string, unknown>> {
    if (!this.selfServiceSecret) return { outcome: "self_service_off", message: UNAVAILABLE_MESSAGE };
    return this.post(
      "/ai/wa/my-reservations",
      conversationId ? { conversation_id: conversationId } : {},
      this.selfServiceHeaders(callerPhone),
      20_000,
      { outcome: "agenda_unavailable", message: UNAVAILABLE_MESSAGE }
    );
  }

  async cancel(
    callerPhone: string,
    body: { reservation_ref: string; confirmed_by_customer: boolean; conversation_id?: string }
  ): Promise<Record<string, unknown>> {
    if (!this.selfServiceSecret) return { outcome: "self_service_off", message: UNAVAILABLE_MESSAGE };
    return this.post("/ai/wa/cancel", body, this.selfServiceHeaders(callerPhone), 30_000, {
      outcome: "uncertain",
      message: UNCERTAIN_MESSAGE,
      external_mutation: null,
    });
  }

  async changeService(
    callerPhone: string,
    body: { reservation_ref: string; service_id: 0 | 1 | 2; confirmed_by_customer: boolean; conversation_id?: string }
  ): Promise<Record<string, unknown>> {
    if (!this.selfServiceSecret) {
      return {
        outcome: "service_change_unavailable",
        message: "Ahora no puedo cambiar el servicio por aquí. ¿Quieres que se lo pase a Bruno?",
        external_mutation: false,
      };
    }
    // A network failure after the DELETE+POST may have changed the booking: never "not changed".
    return this.post("/ai/wa/change-service", body, this.selfServiceHeaders(callerPhone), 40_000, {
      outcome: "uncertain",
      message:
        "No puedo confirmar si se ha cambiado el servicio de tu cita. Si quieres, le dejo el aviso a Bruno para que lo compruebe.",
      external_mutation: null,
    });
  }

  async recado(callerPhone: string | null, body: RecadoBody): Promise<Record<string, unknown>> {
    if (!this.selfServiceSecret) return { outcome: "recado_unavailable" };
    const headers: Record<string, string> = {
      "x-ai-webhook-secret": this.webhookSecret,
      "x-ai-wa-secret": this.selfServiceSecret,
    };
    if (callerPhone) headers["x-ai-wa-caller-id"] = `+34${callerPhone}`;
    return this.post("/ai/wa/recado", { ...body }, headers, 8_000, { outcome: "recado_unavailable" });
  }

  async calendarLink(callerPhone: string | null, body: CalendarLinkBody): Promise<Record<string, unknown>> {
    if (!this.selfServiceSecret) return { outcome: "calendar_unavailable" };
    const headers: Record<string, string> = {
      "x-ai-webhook-secret": this.webhookSecret,
      "x-ai-wa-secret": this.selfServiceSecret,
    };
    if (callerPhone) headers["x-ai-wa-caller-id"] = `+34${callerPhone}`;
    return this.post("/ai/wa/calendar-link", { ...body }, headers, 8_000, { outcome: "calendar_unavailable" });
  }

  private selfServiceHeaders(callerPhone: string): Record<string, string> {
    return {
      "x-ai-webhook-secret": this.webhookSecret,
      "x-ai-wa-secret": this.selfServiceSecret ?? "",
      // The format the middleware's waCallerId accepts as a Spanish phone.
      "x-ai-wa-caller-id": `+34${callerPhone}`,
    };
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    timeoutMs: number,
    failure: Record<string, unknown> = { outcome: "agenda_unavailable", message: UNAVAILABLE_MESSAGE }
  ): Promise<Record<string, unknown>> {
    try {
      const res = await requestJson(this.fetchImpl, `${this.baseUrl}${path}`, { method: "POST", headers, body, timeoutMs });
      if (res.body && typeof res.body === "object" && !Array.isArray(res.body)) {
        const obj = res.body as Record<string, unknown>;
        // Self-service routes always answer an `outcome`; a body without one
        // (e.g. a 500 error envelope) is a failure, not an answer.
        if (path.startsWith("/ai/wa/") && typeof obj.outcome !== "string") return { ...failure, http_status: res.status };
        return obj;
      }
      return { ...failure, http_status: res.status };
    } catch {
      return failure;
    }
  }
}
