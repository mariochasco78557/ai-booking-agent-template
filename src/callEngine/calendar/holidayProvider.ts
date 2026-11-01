import type { HolidayProvider, VenueCalendarRule } from "./model.js";
import {
  SYNTHETIC_MUNICIPAL_HOLIDAYS,
  SYNTHETIC_NATIONAL_HOLIDAYS,
  SYNTHETIC_REGIONAL_HOLIDAYS,
} from "../fixtures/syntheticHolidays.js";

/**
 * Local, synthetic implementation of the `HolidayProvider` contract already
 * declared in calendar/model.ts. This is the ONLY implementation of that
 * interface in this repository, and it makes NO network call whatsoever: it
 * filters a fixed, local, synthetic fixture array
 * (fixtures/syntheticHolidays.ts) by date range and scope.
 *
 * A REAL holiday provider — the BOE for national holidays, an Autonomous
 * Community's official gazette/portal for regional ones, a town hall's sede
 * electrónica for municipal ones — would be implemented behind this exact
 * same `HolidayProvider` interface: same `fetchHolidays` signature, same
 * `Promise<ReadonlyArray<...>>` shape, same `source: 'imported_provider'`
 * marker on everything it returns. Nothing downstream (`approval.ts`,
 * `resolveAvailability.ts`) would need to change to accept it — see
 * (internal doc, not included in the template) for what such an
 * integration would additionally require (auth/rate limits, retries,
 * format-drift handling, secrets management) that is explicitly OUT of
 * scope for this local, synthetic demo.
 *
 * Everything this class returns carries `source: 'imported_provider'` and,
 * once handed to `calendar/approval.ts`'s `importHolidays`, is born
 * `pending_review` and INERT: `resolveAvailability.ts`'s `resolveDayWindows`
 * ignores any `VenueCalendarRule` that is not `approved` (fail-closed). Only
 * a human review (`reviewRule` + `activateApproved`) can ever make an
 * imported holiday affect availability.
 */
export class StaticSyntheticHolidayProvider implements HolidayProvider {
  readonly id = "synthetic-fixture-holiday-provider";

  // `async` (with no `await` inside) because the `Promise` return type is
  // part of the shared `HolidayProvider` contract — a real implementation
  // would genuinely await a network call; this synthetic one resolves
  // immediately and deterministically, with no I/O.
  async fetchHolidays(input: {
    from: string;
    to: string;
    scopes: ReadonlyArray<"national" | "regional" | "municipal">;
  }): Promise<
    ReadonlyArray<Omit<VenueCalendarRule, "approval" | "audit"> & { source: "imported_provider" }>
  > {
    const all = [
      ...SYNTHETIC_NATIONAL_HOLIDAYS,
      ...SYNTHETIC_REGIONAL_HOLIDAYS,
      ...SYNTHETIC_MUNICIPAL_HOLIDAYS,
    ];
    return all.filter(
      (h) => input.scopes.includes(h.scope) && h.date >= input.from && h.date <= input.to,
    );
  }
}
