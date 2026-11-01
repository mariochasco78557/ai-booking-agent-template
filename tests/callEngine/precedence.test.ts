import { describe, it, expect } from "vitest";
import { PRECEDENCE_ORDER, resolveOutcome, type Finding, type ReasonCode } from "../../src/callEngine/precedence.js";

const ALL_REASON_CODES: readonly ReasonCode[] = [
  "SECURITY_OR_PRIVACY_BOUNDARY",
  "TECHNICAL_FAILURE",
  "CUSTOMER_REQUESTS_HUMAN",
  "CANCEL_OR_CHANGE_NOT_ENABLED",
  "BUSINESS_DATA_NOT_APPROVED",
  "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
  "SERVICE_NOT_CONFIRMED",
  "INTENT_NOT_UNDERSTOOD",
  "BOOKING_CONFIRMED",
  "AVAILABILITY_PROVIDED",
];

const EXPECTED_OUTCOME: Readonly<Record<ReasonCode, "RESUELVE" | "DERIVA" | "RECHAZA">> = {
  SECURITY_OR_PRIVACY_BOUNDARY: "RECHAZA",
  TECHNICAL_FAILURE: "DERIVA",
  CUSTOMER_REQUESTS_HUMAN: "DERIVA",
  CANCEL_OR_CHANGE_NOT_ENABLED: "DERIVA",
  BUSINESS_DATA_NOT_APPROVED: "DERIVA",
  SLOT_OUTSIDE_SYNTHETIC_SCHEDULE: "DERIVA",
  SERVICE_NOT_CONFIRMED: "DERIVA",
  INTENT_NOT_UNDERSTOOD: "DERIVA",
  BOOKING_CONFIRMED: "RESUELVE",
  AVAILABILITY_PROVIDED: "RESUELVE",
};

describe("PRECEDENCE_ORDER: a total order over exactly the 10 reason codes", () => {
  it("has exactly 10 entries", () => {
    expect(PRECEDENCE_ORDER.length).toBe(10);
  });

  it("contains every reason code exactly once (no duplicates, no omissions)", () => {
    const seen = new Set(PRECEDENCE_ORDER);
    expect(seen.size).toBe(PRECEDENCE_ORDER.length);
    expect([...seen].sort()).toEqual([...ALL_REASON_CODES].sort());
  });

  it("matches (internal doc, not included in the template)'s exact position order", () => {
    expect(PRECEDENCE_ORDER).toEqual([
      "SECURITY_OR_PRIVACY_BOUNDARY",
      "TECHNICAL_FAILURE",
      "CUSTOMER_REQUESTS_HUMAN",
      "CANCEL_OR_CHANGE_NOT_ENABLED",
      "BUSINESS_DATA_NOT_APPROVED",
      "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
      "SERVICE_NOT_CONFIRMED",
      "INTENT_NOT_UNDERSTOOD",
      "BOOKING_CONFIRMED",
      "AVAILABILITY_PROVIDED",
    ]);
  });
});

describe("resolveOutcome: each reason code isolated", () => {
  for (const reasonCode of ALL_REASON_CODES) {
    it(`resolves a single ${reasonCode} finding to ${EXPECTED_OUTCOME[reasonCode]}`, () => {
      const result = resolveOutcome([{ reasonCode }]);
      expect(result).toEqual({ outcome: EXPECTED_OUTCOME[reasonCode], reasonCode });
    });
  }
});

describe("resolveOutcome: fails closed", () => {
  it("an empty findings array resolves to DERIVA/TECHNICAL_FAILURE", () => {
    const result = resolveOutcome([]);
    expect(result).toEqual({ outcome: "DERIVA", reasonCode: "TECHNICAL_FAILURE" });
  });
});

describe("resolveOutcome: deliberate conflicts (five, per (internal doc, not included in the template)'s conflict table)", () => {
  it("security vs. technical failure: security wins", () => {
    const findings: Finding[] = [{ reasonCode: "TECHNICAL_FAILURE" }, { reasonCode: "SECURITY_OR_PRIVACY_BOUNDARY" }];
    expect(resolveOutcome(findings)).toEqual({ outcome: "RECHAZA", reasonCode: "SECURITY_OR_PRIVACY_BOUNDARY" });
  });

  it("technical failure vs. confirmed booking: technical failure wins (announcesSuccess must stay false)", () => {
    const findings: Finding[] = [{ reasonCode: "BOOKING_CONFIRMED" }, { reasonCode: "TECHNICAL_FAILURE" }];
    expect(resolveOutcome(findings)).toEqual({ outcome: "DERIVA", reasonCode: "TECHNICAL_FAILURE" });
  });

  it("customer requests human vs. cancellation not enabled: human request wins", () => {
    const findings: Finding[] = [
      { reasonCode: "CANCEL_OR_CHANGE_NOT_ENABLED" },
      { reasonCode: "CUSTOMER_REQUESTS_HUMAN" },
    ];
    expect(resolveOutcome(findings)).toEqual({ outcome: "DERIVA", reasonCode: "CUSTOMER_REQUESTS_HUMAN" });
  });

  it("cancellation not enabled vs. slot outside schedule: cancellation wins", () => {
    const findings: Finding[] = [
      { reasonCode: "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE" },
      { reasonCode: "CANCEL_OR_CHANGE_NOT_ENABLED" },
    ];
    expect(resolveOutcome(findings)).toEqual({ outcome: "DERIVA", reasonCode: "CANCEL_OR_CHANGE_NOT_ENABLED" });
  });

  it("business data not approved vs. service not confirmed: business data wins", () => {
    const findings: Finding[] = [{ reasonCode: "SERVICE_NOT_CONFIRMED" }, { reasonCode: "BUSINESS_DATA_NOT_APPROVED" }];
    expect(resolveOutcome(findings)).toEqual({ outcome: "DERIVA", reasonCode: "BUSINESS_DATA_NOT_APPROVED" });
  });

  it("booking confirmed vs. availability provided: booking confirmed wins", () => {
    const findings: Finding[] = [{ reasonCode: "AVAILABILITY_PROVIDED" }, { reasonCode: "BOOKING_CONFIRMED" }];
    expect(resolveOutcome(findings)).toEqual({ outcome: "RESUELVE", reasonCode: "BOOKING_CONFIRMED" });
  });
});

describe("resolveOutcome: order of findings in the input never matters", () => {
  it("the winner is the same regardless of array order", () => {
    const a: Finding[] = [
      { reasonCode: "AVAILABILITY_PROVIDED" },
      { reasonCode: "SERVICE_NOT_CONFIRMED" },
      { reasonCode: "SECURITY_OR_PRIVACY_BOUNDARY" },
      { reasonCode: "TECHNICAL_FAILURE" },
    ];
    const b: Finding[] = [...a].reverse();
    expect(resolveOutcome(a)).toEqual(resolveOutcome(b));
    expect(resolveOutcome(a)).toEqual({ outcome: "RECHAZA", reasonCode: "SECURITY_OR_PRIVACY_BOUNDARY" });
  });

  it("a single low-precedence finding among itself resolves to itself", () => {
    expect(resolveOutcome([{ reasonCode: "AVAILABILITY_PROVIDED" }])).toEqual({
      outcome: "RESUELVE",
      reasonCode: "AVAILABILITY_PROVIDED",
    });
  });

  it("duplicate findings of the same reason code do not change the result", () => {
    const findings: Finding[] = [{ reasonCode: "SERVICE_NOT_CONFIRMED" }, { reasonCode: "SERVICE_NOT_CONFIRMED" }];
    expect(resolveOutcome(findings)).toEqual({ outcome: "DERIVA", reasonCode: "SERVICE_NOT_CONFIRMED" });
  });
});
