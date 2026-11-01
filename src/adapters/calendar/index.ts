/**
 * Calendar adapter selection (`CALENDAR_PROVIDER`).
 *
 * The only place that knows which concrete adapters exist. Services receive
 * a `CalendarProvider` / `CalendarBackOffice` from the composition root and
 * never import an adapter.
 *
 * - `memory` (default): the Google Calendar adapter against an in-process
 *   emulator. No credentials, no network, state lost on restart.
 * - `google-calendar`: Google Calendar v3 with a service account.
 *
 * To plug in another backend (a clinic PMS, a legacy REST API, ...), implement
 * `CalendarProvider` + `CalendarBackOffice` under `src/adapters/calendar/<id>/`,
 * add `<id>` to `CALENDAR_PROVIDER_IDS` and a `case` below, and run the shared
 * contract suite in `tests/calendarProviderContract.test.ts` against it.
 */
import type { Env } from "../../config/env.js";
import type { Logger } from "../../services/authTokenService.js";
import type {
  CalendarBackOffice,
  CalendarProvider,
  CalendarProviderId,
} from "../../core/calendar/CalendarProvider.js";
import { createGoogleCalendar, createGoogleCalendarBackOffice } from "./google-calendar/index.js";
import { createMemoryCalendar, createMemoryCalendarBackOffice } from "./memory/index.js";
import { getClientConfig } from "../../core/config/clientConfig.js";

/** `google-calendar` options (D-014): credential from env, business data from cliente.yaml. */
function googleOptions(env: Env, timeoutMs: number, logger: Logger) {
  return {
    clientConfig: getClientConfig(),
    serviceAccount: {
      ...(env.GOOGLE_SERVICE_ACCOUNT_JSON !== undefined ? { jsonPath: env.GOOGLE_SERVICE_ACCOUNT_JSON } : {}),
      ...(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 !== undefined ? { jsonB64: env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 } : {}),
    },
    timeoutMs,
    logger,
  };
}

function unsupported(id: never): never {
  throw new Error(`CALENDAR_PROVIDER no soportado: ${String(id)}`);
}

export function createCalendarProvider(env: Env, logger: Logger): CalendarProvider {
  const id: CalendarProviderId = env.CALENDAR_PROVIDER;
  switch (id) {
    case "memory":
      return createMemoryCalendar({ clientConfig: getClientConfig(), timeoutMs: env.UPSTREAM_TIMEOUT_MS, logger });
    case "google-calendar":
      return createGoogleCalendar(googleOptions(env, env.UPSTREAM_TIMEOUT_MS, logger));
    default:
      return unsupported(id);
  }
}

/**
 * `creds` are the staff identity of a credential-based backend; `memory` and
 * `google-calendar` ignore them (service account with its own token cache).
 */
export function createCalendarBackOffice(
  env: Env,
  _creds: { username: string; password: string },
  logger: Logger,
): CalendarBackOffice {
  const id: CalendarProviderId = env.CALENDAR_PROVIDER;
  switch (id) {
    case "memory":
      return createMemoryCalendarBackOffice({
        clientConfig: getClientConfig(),
        timeoutMs: env.WA_DASHBOARD_TIMEOUT_MS,
        logger,
      });
    case "google-calendar":
      return createGoogleCalendarBackOffice(googleOptions(env, env.WA_DASHBOARD_TIMEOUT_MS, logger));
    default:
      return unsupported(id);
  }
}
