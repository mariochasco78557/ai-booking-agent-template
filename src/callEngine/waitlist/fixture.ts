import { NEREA_ID } from "../fixtures/syntheticVenue.js";
import type { Clock } from "../domain/types.js";
import { DEFAULT_CANCELLATION_NOTICE_MINUTES, type CancellationPolicy, type WaitlistEntry } from "./model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * step 17 — THE DEMO WAITLIST FIXTURE (design §8.2/§8.3).
 *
 * Six seed entries, `wl-f01..wl-f06`, all `optInConfirmed: true` and all
 * `pending`. Every label is synthetic and matches the closed `^Cliente [A-Z]$`
 * pattern (design §8.4): no names, no phone numbers, no free text about any
 * person. Nothing here represents a real client and nothing here reaches a
 * real system.
 *
 * The seeds are chosen so that the eighteen scenarios of design §10 can all
 * be run from a single `POST /api/reset`, including the two that must
 * produce NO match (capability, venue closure) and the two that must produce
 * a LATE cancellation which nonetheless releases its slot exactly like any
 * other — because a late cancellation carries no penalty (design §5.4).
 * ────────────────────────────────────────────────────────────────────────
 */

interface SeedSpec {
  id: string;
  clientLabel: string;
  serviceId: 0 | 1 | 2;
  dateFrom: string;
  dateTo: string;
  earliestStartMinutes: number;
  latestStartMinutes: number;
  professional: WaitlistEntry["professional"];
  optInSource: WaitlistEntry["optInSource"];
}

/**
 * The six seeds, in creation order (design §8.2). The last column of that
 * table — which scenario each one serves — is reproduced in the comments so
 * a future reader can tell at a glance why a row exists before changing it.
 */
const SEEDS: readonly SeedSpec[] = [
  // Scenarios 4, 7, 10, 11, 12, 13 — the "anybody" entry that fits the two
  // slots released by cancelling Álex's 13:00-14:00 appointment.
  {
    id: "wl-f01",
    clientLabel: "Cliente A",
    serviceId: 1,
    dateFrom: "2026-08-04",
    dateTo: "2026-08-04",
    earliestStartMinutes: 13 * 60,
    latestStartMinutes: 14 * 60,
    professional: { kind: "any" },
    optInSource: "phone_simulated",
  },
  // Scenario 7 (the SECOND compatible entry) and no-rule §5.1: two people
  // fit the same slot and the system refuses to rank them.
  {
    id: "wl-f02",
    clientLabel: "Cliente B",
    serviceId: 1,
    dateFrom: "2026-08-04",
    dateTo: "2026-08-04",
    earliestStartMinutes: 13 * 60,
    latestStartMinutes: 14 * 60,
    professional: { kind: "any" },
    optInSource: "phone_simulated",
  },
  // Scenarios 3 and 6 — a SPECIFIC professional (Nerea) and the single
  // compatible entry for the slot her 12:30 appointment releases.
  {
    id: "wl-f03",
    clientLabel: "Cliente C",
    serviceId: 1,
    dateFrom: "2026-08-04",
    dateTo: "2026-08-04",
    earliestStartMinutes: 12 * 60,
    latestStartMinutes: 13 * 60,
    professional: { kind: "specific", employeeId: NEREA_ID },
    optInSource: "counter_simulated",
  },
  // Scenario 16 — service 0 (Barba), which Nerea deliberately cannot do, and
  // its contrast: Dani can, at exactly the same time of day.
  {
    id: "wl-f04",
    clientLabel: "Cliente D",
    serviceId: 0,
    dateFrom: "2026-08-04",
    dateTo: "2026-08-04",
    earliestStartMinutes: 16 * 60,
    latestStartMinutes: 17 * 60,
    professional: { kind: "any" },
    optInSource: "phone_simulated",
  },
  // Scenario 9 — a LATE cancellation still releases its slot and still finds
  // somebody who fits. Nobody is punished for cancelling late.
  {
    id: "wl-f05",
    clientLabel: "Cliente E",
    serviceId: 1,
    dateFrom: "2026-08-04",
    dateTo: "2026-08-04",
    earliestStartMinutes: 9 * 60,
    latestStartMinutes: 10 * 60,
    professional: { kind: "any" },
    optInSource: "phone_simulated",
  },
  // Scenario 17 — the entry aimed at 2026-08-06, the day the venue closure
  // is published on. It must NEVER be announced as compatible once that day
  // is closed, because the released-slot phase produces nothing at all.
  {
    id: "wl-f06",
    clientLabel: "Cliente F",
    serviceId: 1,
    dateFrom: "2026-08-06",
    dateTo: "2026-08-06",
    earliestStartMinutes: 10 * 60,
    latestStartMinutes: 12 * 60,
    professional: { kind: "any" },
    optInSource: "operator_entered",
  },
];

/** The demo default policy: 120 minutes. NOT a policy approved by Demo Salon (design §3.4). */
export function freshCancellationPolicy(): CancellationPolicy {
  return { cancellationNoticeMinutes: DEFAULT_CANCELLATION_NOTICE_MINUTES, source: "demo_default" };
}

/**
 * The six seed entries, stamped with the INJECTED synthetic clock. No wall
 * clock is read here or anywhere under `src/callEngine/**`.
 */
export function freshWaitlistEntries(clock: Clock): WaitlistEntry[] {
  const createdAtISO = clock.nowInstantISO();
  return SEEDS.map((seed, index) => ({
    id: seed.id,
    clientLabel: seed.clientLabel,
    serviceId: seed.serviceId,
    dateFrom: seed.dateFrom,
    dateTo: seed.dateTo,
    earliestStartMinutes: seed.earliestStartMinutes,
    latestStartMinutes: seed.latestStartMinutes,
    professional: seed.professional,
    optInSource: seed.optInSource,
    optInConfirmed: true,
    state: "pending",
    createdSeq: index + 1,
    createdAtISO,
    synthetic: true,
  }));
}

export interface FreshWaitlist {
  entries: WaitlistEntry[];
  policy: CancellationPolicy;
}

/** Everything `POST /api/reset` restores on the waitlist side (design §3.5). */
export function freshWaitlist(clock: Clock): FreshWaitlist {
  return { entries: freshWaitlistEntries(clock), policy: freshCancellationPolicy() };
}
