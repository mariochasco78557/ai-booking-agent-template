import { describe, expect, it } from "vitest";
import {
  mintReservationRef,
  openReservationRef,
} from "../src/services/waSelfService/reservationRef.js";

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PHONE = "+34600000001";
const NOW = Date.parse("2026-10-05T08:00:00Z");
const cfg = { secret: SECRET, ttlMinutes: 30 };
const mint = (id = 123456) =>
  mintReservationRef({ reservationId: id, startsAt: "2026-10-07 10:30", phoneE164: PHONE, nowMs: NOW }, cfg);

describe("reservation_ref", () => {
  it("round-trips", () => {
    const ref = mint();
    expect(ref).toHaveLength(58);
    expect(ref.startsWith("r1.")).toBe(true);
    expect(openReservationRef(ref, PHONE, NOW, { secret: SECRET })).toEqual({
      ok: true,
      reservationId: 123456,
      startsAt: "2026-10-07 10:30",
    });
  });

  it("rejects another phone / secret / tampering", () => {
    const ref = mint();
    expect(openReservationRef(ref, "+34600000002", NOW, { secret: SECRET })).toEqual({ ok: false, reason: "invalid" });
    expect(openReservationRef(ref, PHONE, NOW, { secret: "other-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    const idx = 20;
    const tampered = ref.slice(0, idx) + (ref[idx] === "A" ? "B" : "A") + ref.slice(idx + 1);
    const r = openReservationRef(tampered, PHONE, NOW, { secret: SECRET });
    expect(r.ok).toBe(false);
  });

  it("expires exactly at exp", () => {
    const ref = mint();
    const exp = NOW + 30 * 60_000;
    expect(openReservationRef(ref, PHONE, exp - 1000, { secret: SECRET }).ok).toBe(true);
    expect(openReservationRef(ref, PHONE, exp, { secret: SECRET })).toEqual({ ok: false, reason: "expired" });
  });

  it("garbage is malformed and never throws", () => {
    for (const g of ["", "r1.", "abc", "x".repeat(500), "r1." + "!".repeat(55)]) {
      expect(openReservationRef(g, PHONE, NOW, { secret: SECRET })).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("random IV: two mints differ, both valid", () => {
    const a = mint();
    const b = mint();
    expect(a).not.toBe(b);
    expect(openReservationRef(a, PHONE, NOW, { secret: SECRET }).ok).toBe(true);
    expect(openReservationRef(b, PHONE, NOW, { secret: SECRET }).ok).toBe(true);
  });

  it("does not leak id or phone", () => {
    const id = 987654;
    const ref = mint(id);
    const decoded = Buffer.from(ref.slice(3), "base64url");
    for (const hay of [ref, decoded.toString("latin1"), decoded.toString("hex")]) {
      expect(hay).not.toContain(String(id));
      expect(hay).not.toContain(id.toString(16));
      expect(hay).not.toContain("600000001");
    }
    expect(decoded.includes(Buffer.from([0x00, 0x0f, 0x12, 0x06]))).toBe(false); // id as u32 BE
  });

  it("guards reservationId range", () => {
    expect(() => mint(2 ** 32)).toThrow();
    expect(() => mint(0)).toThrow();
  });
});
