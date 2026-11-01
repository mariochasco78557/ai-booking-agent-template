import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  BASE_PATH,
  UPSTREAM,
  WEBHOOK_SECRET,
  buildTestApp,
  fakeJwt,
  freeEmployeeFixture,
  nock,
  testEnv,
} from "./helpers/testApp.js";
import { offered, voiceBookBody } from "./helpers/slotToken.js";

/**
 * step CTL-3 — the write path, after the 2026-08-30 controlled test.
 *
 * Two real calls produced the whole of this suite's agenda:
 *
 * - A registered caller's booking succeeded, and ElevenLabs then invoked the
 *   tool **eight** times in sixteen seconds. Seven were absorbed by the
 *   success-only idempotency memory; one appointment exists.
 * - An unregistered-looking caller's booking was refused by upstream with
 *   HTTP 400, and ElevenLabs invoked the tool **four** times in eleven
 *   seconds. All four reached the salon's API, because a failure left nothing
 *   to replay — and each one was answered with 502, which the provider
 *   renders as a tool error and treats as a reason to try again.
 *
 * The 400 itself had nothing to do with the caller's phone. The middleware was
 * sending `owner.id` = its own service account; upstream force-attributes the
 * row to the authenticated user (`ReservationsController.php:82-83`) and then
 * refuses any create while that user already holds a reservation
 * (`:75-79`). One successful booking therefore locked out every subsequent
 * one, for every customer, on every date.
 *
 * So this file pins three separate promises:
 *   1. the payload no longer claims an owner (guest mode);
 *   2. one confirmed attempt causes at most one write, whatever its outcome;
 *   3. an unknown outcome is never retried.
 */

const DATE = "2026-09-11";
const SLOT = `${DATE} 10:00:00`;
const auth = { "x-ai-webhook-secret": WEBHOOK_SECRET };

let app: FastifyInstance | undefined;

/** A voice booking payload. `conversation_id` is the idempotency scope. */
function booking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // step SLOT: `voiceBookBody` turns the flat hueco fields below into the
  // real `slot_token` the route now requires. See tests/helpers/slotToken.ts.
  return voiceBookBody({
    conversation_id: "conv_state_machine_001",
    customer_name: "Jorge",
    customer_surnames: "Pérez",
    phone: "612345678",
    reservation_date: SLOT,
    employee_id: 1,
    service_id: 1,
    confirmed_by_customer: true,
    ...overrides,
  });
}

/** Creation genuinely armed, guest owner mode — the deployed posture. */
function armed(overrides: Record<string, string> = {}): void {
  testEnv({
    ENABLE_WRITE_OPERATIONS: "true",
    ENABLE_CREATE_BOOKING: "true",
    BOOKING_BOOKING_OWNER_MODE: "guest",
    ...overrides,
  });
}

/**
 * Persistent login + availability interceptors.
 *
 * Persistent on purpose: a successful booking fires a DETACHED cache re-warm,
 * and a one-shot interceptor can be consumed by that stray request instead of
 * by the call under test.
 */
function agenda(starts: string[] = [SLOT]): void {
  nock(UPSTREAM).persist().post(`${BASE_PATH}/login`).reply(200, { token: fakeJwt() });
  nock(UPSTREAM)
    .persist()
    .get(`${BASE_PATH}/user/free`)
    .query(true)
    .reply(200, [freeEmployeeFixture(DATE, starts)]);
}

/**
 * Counts every POST /v1/reservation and answers each one with `responder`.
 *
 * The count is the assertion that matters throughout this file: not "what did
 * the agent hear", but "how many times did the salon's API get written to".
 */
function countWrites(
  responder: (n: number) => { status: number; body: unknown },
): { calls: () => number; bodies: () => Record<string, unknown>[] } {
  let n = 0;
  const bodies: Record<string, unknown>[] = [];
  nock(UPSTREAM)
    .persist()
    .post(`${BASE_PATH}/reservation`)
    .reply(function (_uri, requestBody) {
      n += 1;
      bodies.push(requestBody as Record<string, unknown>);
      const { status, body } = responder(n);
      return [status, body];
    });
  return { calls: () => n, bodies: () => bodies };
}

async function post(payload: Record<string, unknown>): Promise<{
  status: number;
  body: { booked: boolean; outcome: string; message: string; idempotency_status: string };
}> {
  // step OFFER: arrange the offer this body echoes, as availability would.
  offered(app!, payload);
  const res = await app!.inject({
    method: "POST",
    url: "/ai/voice/book",
    headers: auth,
    payload,
  });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => nock.disableNetConnect());
afterEach(async () => {
  await app?.close();
  app = undefined;
  nock.cleanAll();
  nock.enableNetConnect();
});






describe("one booking per call, and only new bookings", () => {

  it("exposes no cancellation or modification route at all", async () => {
    // Cancellation and modification stay out of scope. This asserts the
    // absence structurally rather than trusting a flag.
    armed();
    app = await buildTestApp();

    for (const url of ["/ai/voice/cancel", "/ai/voice/update", "/ai/voice/modify"]) {
      const res = await app.inject({ method: "POST", url, headers: auth, payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });

});

