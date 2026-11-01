import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  UPSTREAM,
  WEBHOOK_SECRET,
  buildTestApp,
  fakeJwt,
  freeEmployeeFixture,
  mockFree,
  mockLogin,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import { offered, voiceBookBody } from "./helpers/slotToken.js";
import { applyBookingDisplayPrefix } from "../src/utils/displayName.js";
import { loadEnv } from "../src/config/env.js";
import { createServices } from "../src/services/container.js";
import type { Logger } from "../src/services/authTokenService.js";
import type { VoiceBookInput } from "../src/schemas/aiSchemas.js";

/**
 * step CTL — the agenda-visible AI marker ((internal doc, not included in the template) ADR-012).
 *
 * An appointment a machine took over the phone must be recognisable as such in
 * Bruno's diary. The legacy Reservation entity has no source/channel/actor
 * column (audited: (internal doc, not included in the template) §C), so
 * the marker rides on `ownerName` — the field the panel actually renders.
 *
 * The whole point of this suite is that the marker is a SERVER-SIDE fact:
 * present because this process put it there, applied to exactly one field, and
 * invisible to the customer on the phone. Each test below pins one half of
 * that: what must be marked, and what must stay untouched.
 */

let app: FastifyInstance;
const auth = { "x-ai-webhook-secret": WEBHOOK_SECRET };

const DATE = "2026-08-28";
const SLOT = `${DATE} 17:00:00`;

/**
 * step SLOT: the FLAT shape — hueco fields included. It is no longer a
 * request body: `voiceBookBody()` seals `reservation_date`, `employee_id` and
 * `service_id` into a real `slot_token` at each call site, because a token is
 * bound to its conversation and these tests use several.
 */
const voiceBooking = {
  conversation_id: "conv_prefix_001",
  customer_name: "Pedro",
  customer_surnames: "García",
  phone: "600000101",
  reservation_date: SLOT,
  employee_id: 1,
  service_id: 1,
  confirmed_by_customer: true as const,
};

/** Env with creation genuinely armed, so the write path is really exercised. */
function armedEnv(overrides: Record<string, string> = {}): void {
  testEnv({
    ENABLE_WRITE_OPERATIONS: "true",
    ENABLE_CREATE_BOOKING: "true",
    BOOKING_DEFAULT_OWNER_ID: "644",
    ...overrides,
  });
}

/**
 * Captures the body of the single upstream `POST /v1/reservation`, so a test
 * can assert on what was really sent rather than on what the middleware
 * reported back. Returns a getter — the body only exists after the call.
 */
function captureReservation(): { body: () => Record<string, unknown> | undefined } {
  let seen: Record<string, unknown> | undefined;
  nock(UPSTREAM)
    .post(`${BASE_PATH}/reservation`, (body: Record<string, unknown>) => {
      seen = body;
      return true;
    })
    .reply(201, { id: 91001 });
  return { body: () => seen };
}

describe("AI marker — the pure prefix rule", () => {
  it("marks a plain first name", () => {
    expect(applyBookingDisplayPrefix("Pedro", "IA-")).toBe("IA-Pedro");
  });

  it("never doubles a marker that is already there", () => {
    expect(applyBookingDisplayPrefix("IA-Pedro", "IA-")).toBe("IA-Pedro");
  });

  it("normalizes a marker the caller supplied in another case, instead of doubling it", () => {
    // A customer who says their name is "ia-pedro" cannot end up with
    // "IA-ia-pedro", nor with a lowercase marker nobody can grep for.
    expect(applyBookingDisplayPrefix("ia-pedro", "IA-")).toBe("IA-pedro");
  });

  it("normalizes whitespace", () => {
    expect(applyBookingDisplayPrefix("  Pedro   Mikel ", "IA-")).toBe("IA-Pedro Mikel");
    expect(applyBookingDisplayPrefix("IA- Pedro", "IA-")).toBe("IA-Pedro");
  });

  it("leaves the name untouched when the marker is explicitly empty", () => {
    expect(applyBookingDisplayPrefix("  Pedro ", "")).toBe("Pedro");
    expect(applyBookingDisplayPrefix("Pedro", "   ")).toBe("Pedro");
  });

  it("always yields a name that starts with the marker — a caller cannot escape it", () => {
    for (const spoken of [
      "Pedro",
      "ia-Pedro",
      "IA-Pedro",
      "  pedro  ",
      "IA",
      "-Pedro",
      "Ian",
      "Iaia",
      "IA-IA-Pedro",
    ]) {
      expect(applyBookingDisplayPrefix(spoken, "IA-").startsWith("IA-")).toBe(true);
    }
  });

  it("does not mark twice even when the spoken name genuinely contains the marker twice", () => {
    // "IA-IA-Pedro" is already marked; the rule strips nothing and adds
    // nothing, because the leading token is a valid marker.
    expect(applyBookingDisplayPrefix("IA-IA-Pedro", "IA-")).toBe("IA-IA-Pedro");
  });
});



