import { describe, expect, it } from "vitest";
import {
  CANCEL_PER_PHONE,
  LOOKUP_PER_PHONE,
  WA_LOOKUP_MAX_RESULTS,
  WaRateLimiter,
} from "../src/services/waSelfService/waRateLimiter.js";

describe("WaRateLimiter", () => {
  it("allows N, rejects N+1, frees after the window", () => {
    const rl = new WaRateLimiter({ max: 3, windowMs: 1000 });
    expect([0, 1, 2].map((t) => rl.check("a", t))).toEqual([true, true, true]);
    expect(rl.check("a", 3)).toBe(false);
    expect(rl.check("a", 999)).toBe(false);
    expect(rl.check("a", 1001)).toBe(true); // first hit (t=0) left the window
  });

  it("keys are independent", () => {
    const rl = new WaRateLimiter({ max: 1, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("b", 0)).toBe(true);
    expect(rl.check("a", 1)).toBe(false);
  });

  it("separate limiters (global vs per-phone) do not interfere", () => {
    const phone = new WaRateLimiter({ max: 1, windowMs: 1000 });
    const global = new WaRateLimiter({ max: 5, windowMs: 1000 });
    expect(phone.check("p", 0)).toBe(true);
    expect(phone.check("p", 1)).toBe(false);
    expect(global.check("global", 1)).toBe(true);
  });

  it("exports the documented constants", () => {
    expect(LOOKUP_PER_PHONE).toEqual({ max: 10, windowMs: 600_000 });
    expect(CANCEL_PER_PHONE).toEqual({ max: 5, windowMs: 3_600_000 });
    expect(WA_LOOKUP_MAX_RESULTS).toBe(3);
  });

  it("is bounded: refuses new keys when 10 000 live keys exist", () => {
    const rl = new WaRateLimiter({ max: 1, windowMs: 1_000_000 });
    for (let i = 0; i < 10_000; i += 1) expect(rl.check(`k${i}`, 0)).toBe(true);
    expect(rl.check("new", 1)).toBe(false);
    expect(rl.check("new", 2_000_000)).toBe(true); // stale keys pruned
  });
});
