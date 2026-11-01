/**
 * `memory` calendar provider: the real `google-calendar` adapter wired to an
 * in-process Google Calendar emulator (`inMemoryGoogleCalendar.ts`).
 *
 * Purpose: `npm run dev` and demos boot with zero credentials and zero network,
 * while exercising exactly the same adapter code a production client runs.
 * State lives in process memory and is lost on restart; never use it in
 * production. The provider and the back office share ONE emulator per process,
 * so a booking created by the assistant is visible to the back office.
 */
import type { Logger } from "../../../services/authTokenService.js";
import type { ClientConfig } from "../../../core/config/clientConfig.js";
import {
  createGoogleCalendar,
  createGoogleCalendarBackOffice,
  type GoogleCalendar,
  type GoogleCalendarBackOffice,
} from "../google-calendar/index.js";
import { googleSettingsFromClientConfig } from "../google-calendar/settings.js";
import { FAKE_SA, FakeGoogleCalendar } from "./inMemoryGoogleCalendar.js";

export interface MemoryCalendarOptions {
  clientConfig: ClientConfig;
  timeoutMs: number;
  logger: Logger;
}

let shared: { config: ClientConfig; emulator: FakeGoogleCalendar } | null = null;

/** The process-wide emulator for this client (created on first use). */
export function memoryEmulator(clientConfig: ClientConfig): FakeGoogleCalendar {
  if (shared === null || shared.config !== clientConfig) {
    const settings = googleSettingsFromClientConfig(clientConfig);
    const calendarIds = [...new Set(settings.employees.map((e) => e.calendarId))];
    shared = { config: clientConfig, emulator: new FakeGoogleCalendar(settings.timeZone, calendarIds) };
  }
  return shared.emulator;
}

/** Test helper: forget the process-wide emulator. */
export function resetMemoryEmulator(): void {
  shared = null;
}

function googleOptions(opts: MemoryCalendarOptions) {
  return {
    clientConfig: opts.clientConfig,
    serviceAccount: FAKE_SA,
    timeoutMs: opts.timeoutMs,
    logger: opts.logger,
    fetch: memoryEmulator(opts.clientConfig).fetch,
  };
}

export function createMemoryCalendar(opts: MemoryCalendarOptions): GoogleCalendar {
  return createGoogleCalendar(googleOptions(opts));
}

export function createMemoryCalendarBackOffice(opts: MemoryCalendarOptions): GoogleCalendarBackOffice {
  return createGoogleCalendarBackOffice(googleOptions(opts));
}
