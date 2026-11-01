import { createHash } from "node:crypto";
import type { Clock } from "../domain/types.js";
import type { Intent } from "../intent.js";
import type { Outcome, ReasonCode } from "../precedence.js";
import {
  PilotEventSchema,
  InternalEventSchema,
  assertNoPersonalData,
  type PilotEvent,
  type PilotEventName,
  type PilotIntent,
  type InternalEvent,
  type InternalEventName,
} from "./schema.js";

/**
 * Salted SHA-256 digest of the caller's raw `callId`. The raw `callId` MUST
 * NEVER be passed to `emitPilotEvent`/`emitInternalEvent` directly — only
 * this digest is. `node:crypto` is Node's built-in hashing module, not a
 * network client; using it here does not violate this tree's "no network"
 * rule (see boundaries.test.ts, which greps for axios/node:net/node:http(s)
 * specifically, never for node:crypto).
 */
export function hashCallId(callId: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${callId}`).digest("hex");
}

/**
 * Maps the engine's internal, 9-value `Intent` (intent.ts) down onto the
 * frozen pilot contract's 7-value `intent` enum. `SPECIAL_SERVICE` and
 * `THIRD_PARTY_DATA` have no dedicated slot in the frozen v1 schema, so both
 * fold to `OTHER` on the pilot stream — the finer distinction stays
 * available internally (and in `reasonCode`, which the frozen schema does
 * carry) without requiring any change to pilot-event.schema.json.
 */
const INTENT_TO_PILOT: Readonly<Record<Intent, PilotIntent>> = {
  BOOK: "BOOK",
  AVAILABILITY: "CHECK_AVAILABILITY",
  CANCEL: "CANCEL",
  RESCHEDULE: "RESCHEDULE",
  HUMAN_HELP: "HUMAN_HELP",
  PRICE_OR_POLICY: "ASK_PRICE",
  SPECIAL_SERVICE: "OTHER",
  THIRD_PARTY_DATA: "OTHER",
  OTHER: "OTHER",
};

export function toPilotIntent(intent: Intent): PilotIntent {
  return INTENT_TO_PILOT[intent];
}

export interface EmitPilotEventInput {
  scenarioId: string;
  callId: string;
  salt: string;
  clock: Clock;
  eventName: PilotEventName;
  fromState?: string;
  toState?: string;
  intent?: Intent;
  outcome?: Outcome;
  reasonCode?: ReasonCode;
  announcesSuccess?: boolean;
}

export interface EmitInternalEventInput {
  scenarioId: string;
  callId: string;
  salt: string;
  clock: Clock;
  eventName: InternalEventName;
  detail?: Record<string, unknown>;
}

export interface CallEventEmitter {
  emitPilotEvent(input: EmitPilotEventInput): PilotEvent;
  emitInternalEvent(input: EmitInternalEventInput): InternalEvent;
  all(): { pilot: readonly PilotEvent[]; internal: readonly InternalEvent[] };
  reset(): void;
}

/**
 * In-memory-only emitter for both event streams. No file, no database, no
 * network call — `all()`/`reset()` are the entire "storage" surface, meant
 * for tests and for a future in-process pilot console to read from.
 */
export function createCallEventEmitter(): CallEventEmitter {
  let counter = 0;
  const pilotEvents: PilotEvent[] = [];
  const internalEvents: InternalEvent[] = [];

  function nextEventId(prefix: string): string {
    counter += 1;
    return `${prefix}-${String(counter).padStart(8, "0")}`;
  }

  // The injected Clock (domain/types.ts) never reads the real wall clock;
  // `nowInstantISO()` has no UTC offset designator, so a literal "Z" is
  // appended to satisfy RFC3339 ("date-time") — this is a formatting
  // convenience over the same deterministic, caller-supplied instant, never
  // a read of the real current time.
  function occurredAt(clock: Clock): string {
    return `${clock.nowInstantISO()}Z`;
  }

  // step 13 correction (A2/D3 in the final report): this module USED to
  // populate every pilot event's optional `latencyMs` with `counter * 5` —
  // a synthetic event-counter multiple, not a measurement of anything. The
  // comment that used to sit here claimed the frozen schema REQUIRED
  // `latencyMs`; that was false — pilot-event.schema.json's `required`
  // array is `[schemaVersion, eventId, occurredAt, callIdHash, scenarioId,
  // eventName]` only, and `latencyMs` is declared `optional()` in
  // PilotEventSchema (schema.ts) precisely to mirror that. The real risk:
  // PILOT_METRICS.md defines the pilot's p95 latency as "percentil 95 de
  // `latencyMs` en OUTCOME_EMITTED" — anyone applying that formula to this
  // demo's output would compute a number that LOOKS like real latency but
  // measures nothing (this module tree never reads a wall clock — see
  // tests/callEngine/boundaries.test.ts). So `latencyMs` is no longer
  // emitted at all. A future real pilot integration, wired to an actual
  // clock, is free to populate it again with a genuine measurement.
  return {
    emitPilotEvent(input) {
      const candidate = {
        schemaVersion: "1.0.0" as const,
        eventId: nextEventId("evt"),
        occurredAt: occurredAt(input.clock),
        callIdHash: hashCallId(input.callId, input.salt),
        scenarioId: input.scenarioId,
        eventName: input.eventName,
        ...(input.fromState !== undefined ? { fromState: input.fromState } : {}),
        ...(input.toState !== undefined ? { toState: input.toState } : {}),
        ...(input.intent !== undefined ? { intent: toPilotIntent(input.intent) } : {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
        ...(input.announcesSuccess !== undefined ? { announcesSuccess: input.announcesSuccess } : {}),
        ...(input.eventName === "OUTCOME_EMITTED" ? { synthetic: true as const } : {}),
      };
      assertNoPersonalData(candidate);
      const event = PilotEventSchema.parse(candidate);
      pilotEvents.push(event);
      return event;
    },
    emitInternalEvent(input) {
      const candidate = {
        schemaVersion: "internal-1.0.0" as const,
        eventId: nextEventId("ievt"),
        occurredAt: occurredAt(input.clock),
        callIdHash: hashCallId(input.callId, input.salt),
        scenarioId: input.scenarioId,
        eventName: input.eventName,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        synthetic: true as const,
      };
      assertNoPersonalData(candidate);
      const event = InternalEventSchema.parse(candidate);
      internalEvents.push(event);
      return event;
    },
    all() {
      return { pilot: [...pilotEvents], internal: [...internalEvents] };
    },
    reset() {
      pilotEvents.length = 0;
      internalEvents.length = 0;
      counter = 0;
    },
  };
}
