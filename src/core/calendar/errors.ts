/**
 * Error contract of the `CalendarProvider` port.
 *
 * Moved here from `src/clients/legacyRestClient.ts` (phase 1 of
 * (internal doc, not included in the template)) so the services depend on the port, not on a
 * concrete adapter. `legacyRestClient.ts` re-exports this very class, so every
 * `instanceof UpstreamError` check keeps matching exactly the same errors.
 */
export interface UpstreamErrorInfo {
  status?: number;
  /** Raw message from upstream, e.g. "La fecha y la hora ... no están disponibles". */
  upstreamMessage?: string;
  /**
   * Machine `code` from the assistant-contract envelope (design §6), when the
   * failing call was one of those endpoints. Undefined for plain calendar
   * calls, which carry no such envelope.
   */
  code?: string;
}

/**
 * Error wrapper for upstream (calendar backend) failures. Carries status +
 * upstream message so services can map to the right Spanish phrasing,
 * without leaking details to the caller.
 */
export class UpstreamError extends Error {
  readonly status?: number;
  readonly upstreamMessage?: string;
  readonly code?: string;
  constructor(message: string, info: UpstreamErrorInfo = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = info.status;
    this.upstreamMessage = info.upstreamMessage;
    this.code = info.code;
  }
}
