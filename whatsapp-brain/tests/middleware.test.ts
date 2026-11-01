import { describe, expect, it } from "vitest";
import { MiddlewareClient } from "../src/middleware.js";

type Call = { url: string; headers: Record<string, string>; body: unknown };

function client(respond: () => Response | Promise<Response>, secret: string | null = "w".repeat(32)) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body ?? "null")) });
    return respond();
  }) as unknown as typeof fetch;
  return { c: new MiddlewareClient("http://mw", "hook", "book", secret ?? undefined, fetchImpl), calls };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("middleware self-service", () => {
  it("looks up with both secrets and the caller id as +34 phone", async () => {
    const { c, calls } = client(() => json({ outcome: "reservations_found" }));
    expect((await c.myReservations("600111222", "wa_cv_1")).outcome).toBe("reservations_found");
    expect(calls[0]?.url).toBe("http://mw/ai/wa/my-reservations");
    expect(calls[0]?.headers["x-ai-webhook-secret"]).toBe("hook");
    expect(calls[0]?.headers["x-ai-wa-secret"]).toBe("w".repeat(32));
    expect(calls[0]?.headers["x-ai-wa-caller-id"]).toBe("+34600111222");
    expect(calls[0]?.body).toEqual({ conversation_id: "wa_cv_1" });
  });

  it("cancels on /ai/wa/cancel with the same identity headers", async () => {
    const { c, calls } = client(() => json({ outcome: "cancelled", external_mutation: true }));
    await c.cancel("600111222", { reservation_ref: "r", confirmed_by_customer: true });
    expect(calls[0]?.url).toBe("http://mw/ai/wa/cancel");
    expect(calls[0]?.headers["x-ai-wa-caller-id"]).toBe("+34600111222");
    expect(calls[0]?.body).toEqual({ reservation_ref: "r", confirmed_by_customer: true });
  });

  it("a failed lookup is agenda_unavailable", async () => {
    const net = client(() => Promise.reject(new Error("down")));
    expect((await net.c.myReservations("600111222")).outcome).toBe("agenda_unavailable");
    const http = client(() => json({ success: false, message: "boom" }, 500));
    expect((await http.c.myReservations("600111222")).outcome).toBe("agenda_unavailable");
  });

  it("a failed cancel is uncertain with external_mutation null, never «not cancelled»", async () => {
    for (const r of [() => Promise.reject(new Error("timeout")), () => json({ success: false }, 500), () => new Response("<html>", { status: 502 })]) {
      const out = await client(r).c.cancel("600111222", { reservation_ref: "r", confirmed_by_customer: true });
      expect(out.outcome).toBe("uncertain");
      expect(out.external_mutation).toBeNull();
    }
  });

  it("without the secret nothing is sent", async () => {
    const { c, calls } = client(() => json({}), null);
    expect((await c.myReservations("600111222")).outcome).toBe("self_service_off");
    expect((await c.cancel("600111222", { reservation_ref: "r", confirmed_by_customer: true })).outcome).toBe("self_service_off");
    expect(calls).toHaveLength(0);
  });

  it("availability is flagged as the whatsapp channel (pages of up to ten hours)", async () => {
    const { c, calls } = client(() => json({ outcome: "options_available" }));
    await c.availability({ action: "discover" });
    expect(calls[0]?.url).toBe("http://mw/ai/voice/v2/availability");
    expect(calls[0]?.headers["x-ai-channel"]).toBe("whatsapp");
    expect(calls[0]?.headers["x-ai-webhook-secret"]).toBe("hook");
  });

  it("booking is flagged as the whatsapp channel", async () => {
    const { c, calls } = client(() => json({ outcome: "confirmed" }));
    await c.book({ a: 1 });
    expect(calls[0]?.headers["x-ai-channel"]).toBe("whatsapp");
    expect(calls[0]?.headers["x-ai-booking-secret"]).toBe("book");
  });
});
