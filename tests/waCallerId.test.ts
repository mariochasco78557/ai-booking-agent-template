import { describe, expect, it } from "vitest";
import { resolveWaCaller } from "../src/services/waSelfService/waCallerId.js";

const h = (v: string | string[] | undefined) => ({ "x-ai-wa-caller-id": v });

describe("resolveWaCaller", () => {
  it.each(["34600000001", "+34600000001", "0034600000001", "600000001", "whatsapp:+34600000001"])(
    "es_phone: %s",
    (input) => {
      const r = resolveWaCaller(h(input));
      expect(r).toEqual({ ok: true, format: "es_phone", e164: "+34600000001", masked: "+34•••••••01" });
    },
  );

  it("foreign phone", () => {
    const r = resolveWaCaller(h("447700900123"));
    expect(r).toEqual({ ok: false, format: "foreign_phone", masked: "+44•••23" });
  });

  it("number not starting 6-9 after 34 is foreign", () => {
    expect(resolveWaCaller(h("34500000001")).format).toBe("foreign_phone");
  });

  it("bsuid is masked without leaking the value", () => {
    const r = resolveWaCaller(h("ES.1234abcdEFGH"));
    expect(r.ok).toBe(false);
    expect(r.format).toBe("bsuid");
    expect(r.masked.startsWith("ES.…(len=")).toBe(true);
    expect(r.masked).not.toContain("1234abcd");
  });

  it.each([undefined, "", "  "])("missing: %j", (input) => {
    expect(resolveWaCaller(h(input))).toEqual({ ok: false, format: "missing", masked: "" });
  });

  it("unrecognized", () => {
    expect(resolveWaCaller(h("hola")).format).toBe("unrecognized");
    const long = resolveWaCaller(h("1".repeat(300)));
    expect(long.format).toBe("unrecognized");
    expect(long.masked).toBe("(len=300)");
  });

  it("uses the first value of an array", () => {
    const r = resolveWaCaller(h(["34600000001", "34600000002"]));
    expect(r.ok && r.e164).toBe("+34600000001");
  });

  it("takes headers only", () => {
    expect(resolveWaCaller.length).toBe(1);
  });
});
