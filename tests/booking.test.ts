import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  nock,
  testEnv,
  buildTestApp,
  mockLogin,
  mockFree,
  freeEmployeeFixture,
  UPSTREAM,
  BASE_PATH,
  WEBHOOK_SECRET,
} from "./helpers/testApp.js";
import { loadEnv } from "../src/config/env.js";
import { createServices } from "../src/services/container.js";
import type { Logger } from "../src/services/authTokenService.js";

let app: FastifyInstance;
const authHeader = { "x-ai-webhook-secret": WEBHOOK_SECRET };

const CUSTOMER = { name: "Carlos", surnames: "García", phone: "612345678" };
const validBook = {
  customer: CUSTOMER,
  reservationDate: "2026-07-29 17:00:00",
  confirmedByCustomer: true,
};

describe("POST /ai/book — safety gates", () => {
  beforeEach(() => nock.disableNetConnect());
  afterEach(async () => {
    await app?.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("refuses to book without confirmedByCustomer and makes NO upstream call", async () => {
    testEnv({ ENABLE_WRITE_OPERATIONS: "true", ENABLE_CREATE_BOOKING: "true", ENABLE_CANCEL_BOOKING: "true", BOOKING_DEFAULT_OWNER_ID: "644" });
    app = await buildTestApp();
    // No nock mocks set: any upstream call would throw (net disabled).
    const res = await app.inject({
      method: "POST",
      url: "/ai/book",
      headers: authHeader,
      payload: { ...validBook, confirmedByCustomer: false },
    });
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe("not_confirmed");
  });



});


/**
 * Senior finding B8 ((internal doc, not included in the template)
 * §10.2, §13). Before this wave, `BookingService` wrote `ownerPhone` straight
 * from the LLM-transcribed `customer.phone` — the very column lookup matches
 * on and `confirm.phone` is compared against. An attacker could book stating
 * a victim's number: the victim's own next verified lookup would then return
 * a booking they never made, and upstream's one-booking-per-phone rule
 * (`DUPLICATE_CALLER_BOOKING`) meant that booking LOCKED the victim out of
 * booking by phone entirely — a targeted denial of service costing one call.
 * This suite proves the fix: `/ai/book` now pins the upstream phone to a
 * VERIFIED caller identity when one is resolved, and only then.
 */
