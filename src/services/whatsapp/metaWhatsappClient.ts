import axios, { type AxiosInstance } from "axios";

import {
  buildCalendarButtonComponent,
  type WhatsAppTemplateParameter,
} from "./whatsappTemplate.js";

/**
 * *** THE ONLY THING IN THIS PROCESS THAT TALKS TO META. ***
 *
 * One `POST https://graph.facebook.com/{version}/{phoneNumberId}/messages`
 * with a `Bearer` token, the approved template and its named parameters. No
 * retries, no state, no clock: it returns WHAT HAPPENED and
 * `whatsappNotifier.ts` decides what to do about it. That split is the reason
 * the retry policy is testable without a network and the network shape is
 * testable without a timer.
 *
 * ── The classification is the whole value of this file ────────────────────
 *
 * `retryable` is not a detail, it is the contract. Meta answers a malformed
 * template, an unapproved template and "this number is not on WhatsApp" with
 * a 4xx, and every one of those is a permanent statement about THIS message:
 * dialling again produces the identical refusal and burns the daily rate
 * budget. A 429, a 5xx, a timeout or a reset connection say nothing about the
 * message at all, so those — and only those — come back for another attempt.
 *
 * Errors are reduced to a SHORT, non-secret string (`http_400 code=131026:
 * …`). Never the access token, never the recipient's number: the caller logs
 * what this returns, and a log line is the easiest place in the system to
 * leak a credential or a phone number into.
 */

/** Meta's own success envelope, of which only the message id is used. */
interface GraphSendResponse {
  messages?: Array<{ id?: string }>;
  contacts?: Array<{ wa_id?: string }>;
}

export type MetaSendResult =
  | { ok: true; messageId: string }
  /** `retryable` — see the classification note above. */
  | { ok: false; retryable: boolean; error: string };

export interface MetaWhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  /** `v25.0` — pinned in configuration, never derived from a response. */
  graphApiVersion: string;
  templateName: string;
  /** Language CODE of the approved template, e.g. `es`. */
  templateLanguage: string;
  sendTimeoutMs: number;
  /** Overridable for tests; production always uses Graph's real origin. */
  baseUrl?: string;
}

export const GRAPH_API_BASE_URL = "https://graph.facebook.com";

/** Upper bound on how much of Meta's prose reaches a stored job or a log. */
const ERROR_MAX_LENGTH = 200;

/** Cuts an error string down to something safe to persist and log. */
function shorten(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_MAX_LENGTH ? `${flat.slice(0, ERROR_MAX_LENGTH)}…` : flat;
}

/**
 * `http_400 code=131026 subcode=… : Receiver is incapable of receiving this
 * message` — enough for an operator to act on, nothing that identifies the
 * customer.
 */
function describeGraphError(status: number | undefined, data: unknown): string {
  const error = (data as { error?: Record<string, unknown> } | undefined)?.error;
  const parts: string[] = [status === undefined ? "no_response" : `http_${status}`];
  if (error !== undefined) {
    if (typeof error.code === "number" || typeof error.code === "string") {
      parts.push(`code=${String(error.code)}`);
    }
    if (typeof error.error_subcode === "number") {
      parts.push(`subcode=${String(error.error_subcode)}`);
    }
    if (typeof error.message === "string" && error.message !== "") {
      parts.push(`: ${error.message}`);
    }
  }
  return shorten(parts.join(" "));
}

export class MetaWhatsAppClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: MetaWhatsAppConfig) {
    this.http = axios.create({
      baseURL: `${(config.baseUrl ?? GRAPH_API_BASE_URL).replace(/\/+$/, "")}/${config.graphApiVersion}`,
      timeout: config.sendTimeoutMs,
      headers: {
        "Content-Type": "application/json",
        // The ONE place the token is used, and it is never logged, never
        // persisted in the queue file and never included in an error string.
        Authorization: `Bearer ${config.accessToken}`,
      },
      // Non-2xx is classified below, not thrown into a generic handler.
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  /**
   * Sends one template message.
   *
   * Never throws: every failure — including a programming error inside axios —
   * comes back as `{ ok: false }`, because the caller is a background worker
   * whose only correct reaction to an exception would be to write the same
   * classification by hand.
   */
  async send(
    to: string,
    parameters: readonly WhatsAppTemplateParameter[],
    /**
     * The signed calendar token for the template's URL button
     * (`whatsappTemplate.ts` › `buildCalendarButtonComponent`). The notifier
     * always passes it; it is optional here only so this class keeps knowing
     * nothing about calendars.
     */
    calendarToken?: string,
  ): Promise<MetaSendResult> {
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: this.config.templateName,
        language: { code: this.config.templateLanguage },
        components: [
          { type: "body", parameters },
          ...(calendarToken !== undefined ? [buildCalendarButtonComponent(calendarToken)] : []),
        ],
      },
    };

    try {
      const response = await this.http.post<GraphSendResponse>(
        `/${this.config.phoneNumberId}/messages`,
        body,
      );
      const messageId = response.data?.messages?.[0]?.id;
      if (typeof messageId !== "string" || messageId === "") {
        // A 2xx with no message id is not something Graph does. If it ever
        // did, we would have no evidence the message exists — and re-sending
        // on that basis risks two identical confirmations for one
        // appointment, which is worse than one missing id in a log.
        return { ok: false, retryable: false, error: "accepted_without_message_id" };
      }
      return { ok: true, messageId };
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        return { ok: false, retryable: false, error: shorten(String(error)) };
      }
      const status = error.response?.status;
      if (status === undefined) {
        // No answer at all: timeout, reset connection, DNS. Says nothing
        // about the message, so it is retried.
        return {
          ok: false,
          retryable: true,
          error: shorten(`no_response ${error.code ?? "network_error"}`),
        };
      }
      // 429 is the one 4xx that is about the moment rather than the message.
      const retryable = status === 429 || status >= 500;
      return { ok: false, retryable, error: describeGraphError(status, error.response?.data) };
    }
  }
}
