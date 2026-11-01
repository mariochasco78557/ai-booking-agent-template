import { describe, it, expect } from "vitest";
import { normalizeSpanishPhone } from "../src/utils/phone.js";

describe("normalizeSpanishPhone", () => {
  it("accepts a plain 9-digit mobile number", () => {
    const r = normalizeSpanishPhone("612345678");
    expect(r).toEqual({ ok: true, e164: "+34612345678", national: "612345678", kind: "mobile" });
  });

  it("accepts a plain 9-digit landline number", () => {
    const r = normalizeSpanishPhone("912345678");
    expect(r).toEqual({ ok: true, e164: "+34912345678", national: "912345678", kind: "landline" });
  });

  it("accepts spaces as separators", () => {
    const r = normalizeSpanishPhone("612 34 56 78");
    expect(r).toEqual({ ok: true, e164: "+34612345678", national: "612345678", kind: "mobile" });
  });

  it("accepts hyphens as separators", () => {
    const r = normalizeSpanishPhone("612-345-678");
    expect(r).toEqual({ ok: true, e164: "+34612345678", national: "612345678", kind: "mobile" });
  });

  it("accepts parentheses and spaces", () => {
    const r = normalizeSpanishPhone("(612) 345 678");
    expect(r).toEqual({ ok: true, e164: "+34612345678", national: "612345678", kind: "mobile" });
  });

  it("accepts a +34 prefix", () => {
    const r = normalizeSpanishPhone("+34612345678");
    expect(r).toEqual({ ok: true, e164: "+34612345678", national: "612345678", kind: "mobile" });
  });

  it("accepts a 0034 prefix", () => {
    const r = normalizeSpanishPhone("0034612345678");
    expect(r).toEqual({ ok: true, e164: "+34612345678", national: "612345678", kind: "mobile" });
  });

  it("accepts a bare 34 prefix", () => {
    const r = normalizeSpanishPhone("34612345678");
    expect(r).toEqual({ ok: true, e164: "+34612345678", national: "612345678", kind: "mobile" });
  });

  it("trims leading/trailing whitespace", () => {
    const r = normalizeSpanishPhone("  612345678  ");
    expect(r).toEqual({ ok: true, e164: "+34612345678", national: "612345678", kind: "mobile" });
  });

  it("rejects alphabetic input", () => {
    const r = normalizeSpanishPhone("abcdefghi");
    expect(r.ok).toBe(false);
  });

  it("rejects a number that is too short (8 digits)", () => {
    const r = normalizeSpanishPhone("61234567");
    expect(r.ok).toBe(false);
  });

  it("rejects a number that is too long (10 digits)", () => {
    const r = normalizeSpanishPhone("6123456789");
    expect(r.ok).toBe(false);
  });

  it("rejects empty string", () => {
    const r = normalizeSpanishPhone("");
    expect(r.ok).toBe(false);
  });

  it("rejects null", () => {
    const r = normalizeSpanishPhone(null);
    expect(r.ok).toBe(false);
  });

  it("rejects undefined", () => {
    const r = normalizeSpanishPhone(undefined);
    expect(r.ok).toBe(false);
  });

  it("rejects a number starting with 5 (invalid first digit)", () => {
    const r = normalizeSpanishPhone("512345678");
    expect(r.ok).toBe(false);
  });

  it("rejects a number starting with 0 (invalid first digit)", () => {
    const r = normalizeSpanishPhone("012345678");
    expect(r.ok).toBe(false);
  });

  it("rejects an extension suffix", () => {
    const r = normalizeSpanishPhone("612345678 ext 12");
    expect(r.ok).toBe(false);
  });
});
