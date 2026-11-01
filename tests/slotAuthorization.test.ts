import { describe, expect, it } from "vitest";

import {
  SLOT_TOKEN_PREFIX,
  SlotAuthorizationService,
} from "../src/services/slotAuthorization.js";

/**
 * step SLOT — the token itself, at unit level.
 *
 * The HTTP-level proof lives in tests/voiceSlotAuthorization.test.ts; this
 * file pins the cryptographic properties the whole feature rests on, where a
 * failure is legible as "the seal is broken" rather than as "a route answered
 * the wrong outcome".
 *
 * Every negative case here is built by TAMPERING WITH A REAL TOKEN or by
 * minting a real one under different inputs. Nothing hand-writes a token
 * string, because a hand-written string only ever proves the shape guard
 * works — it never reaches the tag check, which is the control that matters.
 */

const SECRET = "unit-test-slot-secret-0123456789abcdef";
const OTHER_SECRET = "a-completely-different-secret-0123456789";
const CONVERSATION = "conv_unit_slot_0001";
const NOW = Date.parse("2026-09-11T08:00:00Z");
const SLOT = "2026-09-11 10:00:00";

function service(ttlSeconds = 900, secret = SECRET): SlotAuthorizationService {
  return new SlotAuthorizationService({ secret, ttlSeconds });
}

function issue(
  svc: SlotAuthorizationService,
  overrides: Partial<{
    conversationId: string;
    reservationDate: string;
    employeeId: number;
    serviceId: number;
  }> = {},
  nowMs = NOW,
): string {
  const token = svc.issue(
    {
      conversationId: overrides.conversationId ?? CONVERSATION,
      reservationDate: overrides.reservationDate ?? SLOT,
      ...(overrides.employeeId !== undefined ? { employeeId: overrides.employeeId } : {}),
      serviceId: overrides.serviceId ?? 1,
    },
    nowMs,
  );
  if (token === undefined) throw new Error("issue() refused unexpectedly");
  return token;
}

/** Flip one bit inside the ciphertext, past the IV and before the tag. */
function flipCiphertextBit(token: string, offset = 20): string {
  const dot = token.indexOf(".");
  const sealed = Buffer.from(token.slice(dot + 1), "base64url");
  sealed[offset] = sealed[offset]! ^ 0x01;
  return `${token.slice(0, dot)}.${sealed.toString("base64url")}`;
}

describe("slot token — shape and opacity", () => {
  it("is URL-safe and carries its format version in the clear", () => {
    const token = issue(service());
    expect(token.startsWith(`${SLOT_TOKEN_PREFIX}.`)).toBe(true);
    // base64url alphabet only: no '+', no '/', no '=' padding. This is what
    // makes the token safe to put in a JSON body, a query string or a log
    // filter without escaping.
    expect(token.slice(SLOT_TOKEN_PREFIX.length + 1)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("reveals nothing about the hueco it authorizes", () => {
    // The property that matters behaviourally: a model that cannot SEE
    // "2026-09-11 10:00:00" in the string has nothing to reconstruct, and its
    // only available move is to echo the token it was handed.
    const token = issue(service(), { employeeId: 3, serviceId: 2 });
    expect(token).not.toContain("2026");
    expect(token).not.toContain("employeeId");
    expect(token).not.toContain(CONVERSATION);
    // Nor is it merely base64-of-plaintext.
    const decoded = Buffer.from(
      token.slice(SLOT_TOKEN_PREFIX.length + 1),
      "base64url",
    ).toString("latin1");
    expect(decoded).not.toContain("2026-09-11");
  });

  it("is different every time, for the same hueco", () => {
    // A fresh random IV per token. Two identical grants must not produce two
    // identical strings, or the token would double as a stable identifier for
    // a customer's appointment.
    const svc = service();
    expect(issue(svc)).not.toBe(issue(svc));
  });
});

describe("slot token — what it authorizes", () => {
  it("round-trips the hueco exactly", () => {
    const svc = service();
    const verified = svc.verify(
      issue(svc, { employeeId: 1, serviceId: 2 }),
      CONVERSATION,
      NOW,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.grant.reservationDate).toBe(SLOT);
    expect(verified.grant.employeeId).toBe(1);
    expect(verified.grant.serviceId).toBe(2);
  });

  it("distinguishes 'no barber named' from barber zero", () => {
    // Availability omits `employee_id` in single-barber mode. That absence has
    // to survive the round trip, because it is what lets `BookingService` fall
    // back to the configured default exactly as it always did.
    const svc = service();
    const verified = svc.verify(issue(svc), CONVERSATION, NOW);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.grant.employeeId).toBeUndefined();
  });

  it("preserves the wall-clock date as a literal string, DST fold included", () => {
    // The reason the date is sealed as text and not as an epoch: 02:30 on the
    // October fold is an ambiguous local time in Europe/Madrid, and a booking
    // that silently moves by an hour is the worst kind of write bug. A string
    // that is never converted cannot be converted wrongly.
    const ambiguous = "2026-10-25 02:30:00";
    const svc = service();
    const verified = svc.verify(
      issue(svc, { reservationDate: ambiguous }),
      CONVERSATION,
      NOW,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.grant.reservationDate).toBe(ambiguous);
  });
});

describe("slot token — every way it must be refused", () => {
  it("refuses a token whose ciphertext has one bit flipped", () => {
    const svc = service();
    const result = svc.verify(flipCiphertextBit(issue(svc)), CONVERSATION, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("forged");
  });

  it("refuses a token whose authentication tag has one bit flipped", () => {
    const svc = service();
    const token = issue(svc);
    const dot = token.indexOf(".");
    const sealed = Buffer.from(token.slice(dot + 1), "base64url");
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0x01;
    const result = svc.verify(
      `${token.slice(0, dot)}.${sealed.toString("base64url")}`,
      CONVERSATION,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("forged");
  });

  it("refuses a token minted with a different secret", () => {
    // Rotating the key invalidates outstanding tokens. That is the intended
    // behaviour and it is why rotation is a mid-call hazard, documented in
    // the deployment plan.
    const foreign = issue(service(900, OTHER_SECRET));
    const result = service().verify(foreign, CONVERSATION, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("forged");
  });

  it("refuses a token issued for another conversation", () => {
    const svc = service();
    const result = svc.verify(
      issue(svc, { conversationId: "conv_some_other_call_99" }),
      CONVERSATION,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("wrong_conversation");
  });

  it("refuses a token past its expiry, and accepts it one millisecond before", () => {
    const svc = service(600);
    const token = issue(svc);
    const expiresAt = NOW + 600_000;
    expect(svc.verify(token, CONVERSATION, expiresAt - 1).ok).toBe(true);
    const expired = svc.verify(token, CONVERSATION, expiresAt);
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.failure).toBe("expired");
  });

  it("refuses anything that is not a token at all", () => {
    const svc = service();
    for (const candidate of [
      "",
      "   ",
      "not-a-token",
      "tk1",
      "tk1.",
      "tk2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      `${SLOT_TOKEN_PREFIX}.not+base64url/at=all`,
    ]) {
      const result = svc.verify(candidate, CONVERSATION, NOW);
      expect(result.ok, `accepted ${JSON.stringify(candidate)}`).toBe(false);
      if (result.ok) continue;
      expect(result.failure).toBe("malformed");
    }
  });

  it("refuses a correctly-shaped token whose sealed bytes are random", () => {
    // The nearest thing to a real forgery attempt: right prefix, right
    // length, right alphabet, wrong key. It must reach — and fail — the tag
    // check rather than be turned away by the shape guard.
    const svc = service();
    const token = issue(svc);
    const dot = token.indexOf(".");
    const length = Buffer.from(token.slice(dot + 1), "base64url").length;
    const random = Buffer.alloc(length, 0x5a);
    const result = svc.verify(
      `${SLOT_TOKEN_PREFIX}.${random.toString("base64url")}`,
      CONVERSATION,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("forged");
  });
});

describe("slot token — the unconfigured, fail-closed posture", () => {
  const disabled = new SlotAuthorizationService({ ttlSeconds: 900 });

  it("reports that it is not armed", () => {
    expect(disabled.enabled).toBe(false);
    expect(service().enabled).toBe(true);
  });

  it("issues nothing", () => {
    expect(
      disabled.issue({ conversationId: CONVERSATION, reservationDate: SLOT, serviceId: 1 }, NOW),
    ).toBeUndefined();
  });

  it("accepts nothing — not even a token another instance issued", () => {
    const result = disabled.verify(issue(service()), CONVERSATION, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("unconfigured");
  });
});

describe("slot token — the issuer refuses what it cannot represent", () => {
  it("declines to seal a reservation date that is not the exact contract shape", () => {
    // Sealing a 17-character date would decode to 17 characters of something
    // else. Refusing to issue is the safe half of that failure: the hueco is
    // still spoken, it simply cannot be booked without a fresh lookup.
    const svc = service();
    for (const bad of ["2026-09-11", "2026-09-11T10:00:00", "2026-9-11 10:00:00"]) {
      expect(
        svc.issue({ conversationId: CONVERSATION, reservationDate: bad, serviceId: 1 }, NOW),
        `sealed a malformed date: ${bad}`,
      ).toBeUndefined();
    }
  });
});
