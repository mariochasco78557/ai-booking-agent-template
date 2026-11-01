import { describe, expect, it } from "vitest";
import {
  buildToolDefinitions,
  executeTool,
  voceroHandoffReason,
  TOOL_AVAILABILITY,
  TOOL_BOOK,
  TOOL_CANCEL,
  TOOL_CHANGE_SERVICE,
  TOOL_MY_BOOKINGS,
  TOOL_NOTIFY_OWNER,
  TOOL_LATE_ARRIVAL,
  type ToolSession,
} from "../src/tools.js";
import { parseOpeningHours, DEFAULT_OPENING_HOURS } from "../src/hours.js";
import type { MiddlewareApi } from "../src/middleware.js";

function fakeMiddleware(cancelResult: Record<string, unknown> = { outcome: "cancel_pending_owner" }, bookResult: Record<string, unknown> = { outcome: "confirmed", booked: true }) {
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  const api: MiddlewareApi = {
    async availability(body) {
      calls.push({ route: "availability", body });
      return { outcome: "options", message: "Tengo a las 10:00." };
    },
    async book(body) {
      calls.push({ route: "book", body });
      return bookResult;
    },
    async myReservations(phone, cid) {
      calls.push({ route: "my-reservations", body: { phone, cid } });
      return { outcome: "no_reservations", message: "No veo ninguna cita." };
    },
    async cancel(phone, body) {
      calls.push({ route: "cancel", body: { phone, ...body } });
      return cancelResult;
    },
  };
  return { api, calls };
}

const session = (over: Partial<ToolSession> = {}): ToolSession => ({
  middlewareConversationId: "wa_cv_abc_x1",
  spanishPhone: "600111222",
  bookingEnabled: true,
  selfServiceEnabled: true,
  ...over,
});

describe("tool definitions", () => {
  const defs = buildToolDefinitions();
  it("exposes the voice tools and the WhatsApp ones", () => {
    expect(defs.map((d) => d.function.name)).toEqual([TOOL_AVAILABILITY, TOOL_BOOK, TOOL_MY_BOOKINGS, TOOL_CANCEL, TOOL_CHANGE_SERVICE, TOOL_NOTIFY_OWNER, TOOL_LATE_ARRIVAL]);
  });
  it("never lets the model fill conversation_id", () => {
    for (const d of defs) {
      const props = (d.function.parameters.properties ?? {}) as Record<string, unknown>;
      expect(props.conversation_id).toBeUndefined();
      expect((d.function.parameters.required as string[] | undefined) ?? []).not.toContain("conversation_id");
    }
  });
});

describe("executing tools", () => {
  it("availability carries the brain's conversation id, not the model's", async () => {
    const m = fakeMiddleware();
    await executeTool(TOOL_AVAILABILITY, { action: "discover", conversation_id: "forged" }, session(), m.api);
    expect(m.calls[0]?.body.conversation_id).toBe("wa_cv_abc_x1");
    expect(m.calls[0]?.body.action).toBe("discover");
  });

  it("booking uses the sender's own Spanish number whatever the model says", async () => {
    const m = fakeMiddleware();
    const s = session();
    await executeTool(TOOL_BOOK, { slot_token: "t", phone: "699999999", customer_name: "Ana", conversation_id: "x" }, s, m.api);
    expect(m.calls[0]?.body.phone).toBe("600111222");
    expect(m.calls[0]?.body.conversation_id).toBe("wa_cv_abc_x1");
    expect(s.lastBookingOutcome).toBe("confirmed");
  });

  it("hallazgo 1: the create tool offers option_time/option_date (optional) and they reach the middleware", async () => {
    const book = buildToolDefinitions().find((d) => d.function.name === TOOL_BOOK)!;
    const props = book.function.parameters.properties as Record<string, { type?: string }>;
    expect(props.option_time?.type).toBe("string");
    expect(props.option_date?.type).toBe("string");
    expect((book.function.parameters.required as string[] | undefined) ?? []).not.toContain("option_time");
    const m = fakeMiddleware();
    await executeTool(TOOL_BOOK, { slot_token: "t", option_time: "11:00", option_date: "2026-10-10" }, session(), m.api);
    expect(m.calls[0]?.body.option_time).toBe("11:00");
    expect(m.calls[0]?.body.option_date).toBe("2026-10-10");
  });

  it("hallazgo 1: a slot_time_mismatch is not counted as a booking", async () => {
    const m = fakeMiddleware(undefined, { outcome: "slot_time_mismatch", booked: false, locked_time: "09:30", requested_time: "11:00" });
    const s = session();
    const out = await executeTool(TOOL_BOOK, { slot_token: "t", option_time: "11:00" }, s, m.api);
    expect(out.outcome).toBe("slot_time_mismatch");
    expect(s.bookingsConfirmed ?? 0).toBe(0);
    expect(s.calendarUrls ?? []).toEqual([]);
  });

  it("a foreign number books with the phone the customer gave", async () => {
    const m = fakeMiddleware();
    await executeTool(TOOL_BOOK, { phone: "+34 600 000 999" }, session({ spanishPhone: null }), m.api);
    expect(m.calls[0]?.body.phone).toBe("+34 600 000 999");
  });

  it("booking disabled creates nothing", async () => {
    const m = fakeMiddleware();
    const out = await executeTool(TOOL_BOOK, { slot_token: "t" }, session({ bookingEnabled: false }), m.api);
    expect(m.calls).toHaveLength(0);
    expect(out.outcome).toBe("write_disabled");
    expect(out.booked).toBe(false);
  });

  it("without the self-service secret my bookings and cancel stay a stub", async () => {
    const m = fakeMiddleware();
    const s = session({ selfServiceEnabled: false });
    expect((await executeTool(TOOL_MY_BOOKINGS, {}, s, m.api)).outcome).toBe("self_service_off");
    expect((await executeTool(TOOL_CANCEL, { reservation_ref: "r", confirmed_by_customer: true }, s, m.api)).outcome).toBe("self_service_off");
    expect(m.calls).toHaveLength(0);
  });

  it("a foreign number gets identity_unavailable locally", async () => {
    const m = fakeMiddleware();
    const s = session({ spanishPhone: null });
    const a = await executeTool(TOOL_MY_BOOKINGS, {}, s, m.api);
    const b = await executeTool(TOOL_CANCEL, { reservation_ref: "r", confirmed_by_customer: true, phone: "600111222" }, s, m.api);
    expect(a.outcome).toBe("identity_unavailable");
    expect(b.outcome).toBe("identity_unavailable");
    expect(String(a.message)).toContain("Bruno");
    expect(m.calls).toHaveLength(0);
  });

  it("my bookings uses the sender's number, not the model's", async () => {
    const m = fakeMiddleware();
    await executeTool(TOOL_MY_BOOKINGS, { phone: "699999999", caller_id: "x" }, session(), m.api);
    expect(m.calls[0]).toEqual({ route: "my-reservations", body: { phone: "600111222", cid: "wa_cv_abc_x1" } });
  });

  it("cancel forwards only the allowed fields", async () => {
    const m = fakeMiddleware();
    await executeTool(
      TOOL_CANCEL,
      { reservation_ref: "ref1", confirmed_by_customer: true, phone: "699999999", caller_id: "x", conversation_id: "forged", extra: 1 },
      session(),
      m.api
    );
    expect(m.calls[0]).toEqual({
      route: "cancel",
      body: { phone: "600111222", reservation_ref: "ref1", confirmed_by_customer: true, conversation_id: "wa_cv_abc_x1" },
    });
    // anything but a real boolean true is not a confirmation
    await executeTool(TOOL_CANCEL, { reservation_ref: "ref1", confirmed_by_customer: "true" }, session(), m.api);
    expect(m.calls[1]?.body.confirmed_by_customer).toBe(false);
    expect((await executeTool(TOOL_CANCEL, { confirmed_by_customer: true }, session(), m.api)).outcome).toBe("invalid_request");
    expect(m.calls).toHaveLength(2);
  });

  it("records a cancellation the owner was not told about", async () => {
    const res = { outcome: "cancelled", owner_notified: false, reservation: { day_label: "el martes 13", time: "10:00", professional: "Bruno" } };
    const s = session();
    await executeTool(TOOL_CANCEL, { reservation_ref: "r", confirmed_by_customer: true }, s, fakeMiddleware(res).api);
    expect(s.cancellations).toEqual([{ day_label: "el martes 13", time: "10:00", professional: "Bruno" }]);

    const notified = session();
    await executeTool(TOOL_CANCEL, { reservation_ref: "r", confirmed_by_customer: true }, notified, fakeMiddleware({ ...res, owner_notified: true }).api);
    expect(notified.cancellations).toBeUndefined();

    const other = session();
    await executeTool(TOOL_CANCEL, { reservation_ref: "r", confirmed_by_customer: true }, other, fakeMiddleware({ outcome: "too_late_to_cancel", owner_notified: false }).api);
    expect(other.cancellations).toBeUndefined();

    const replay = session();
    await executeTool(TOOL_CANCEL, { reservation_ref: "r", confirmed_by_customer: true }, replay, fakeMiddleware({ ...res, idempotency_status: "replayed" }).api);
    expect(replay.cancellations).toBeUndefined();
  });

  it("hides the calendar link from the model and keeps it on the session", async () => {
    const s = session();
    const out = await executeTool(
      TOOL_BOOK,
      { slot_token: "t" },
      s,
      fakeMiddleware(undefined, { outcome: "confirmed", booked: true, calendar_url: "https://x.test/cal/abc.ics" }).api
    );
    expect(out.calendar_url).toBeUndefined();
    expect(out.booked).toBe(true);
    expect(s.calendarUrls).toEqual(["https://x.test/cal/abc.ics"]);
  });

  it("leaves a calendar_url alone unless the booking is confirmed and the link is https", async () => {
    for (const r of [
      { outcome: "confirmed", booked: false, calendar_url: "https://x.test/a" },
      { outcome: "slot_taken", booked: false, calendar_url: "https://x.test/a" },
      { outcome: "confirmed", booked: true, calendar_url: "http://x.test/a" },
    ]) {
      const s = session();
      const out = await executeTool(TOOL_BOOK, { slot_token: "t" }, s, fakeMiddleware(undefined, r).api);
      expect(out.calendar_url).toBe(r.calendar_url);
      expect(s.calendarUrls).toBeUndefined();
    }
  });

  it("notify owner records a pending handoff and needs a summary", async () => {
    const m = fakeMiddleware();
    const s = session();
    expect((await executeTool(TOOL_NOTIFY_OWNER, { reason: "wants_human" }, s, m.api)).outcome).toBe("invalid_request");
    expect(s.pendingHandoff).toBeUndefined();
    const out = await executeTool(TOOL_NOTIFY_OWNER, { reason: "nonsense", summary: "Quiere anular la del martes 10:00" }, s, m.api);
    expect(out.outcome).toBe("owner_notified");
    expect(s.pendingHandoff).toEqual({ reason: "other", summary: "Quiere anular la del martes 10:00", customerName: undefined, callbackPhone: undefined });
  });

  it("maps reasons onto Vocero's catalogue", () => {
    expect(voceroHandoffReason("wants_human")).toBe("cliente");
    expect(voceroHandoffReason("complaint")).toBe("hostilidad");
    expect(voceroHandoffReason("cancel_request")).toBe("modelo");
  });
});

describe("closed-hours guard (BRAIN_OPENING_HOURS)", () => {
  const week = parseOpeningHours(DEFAULT_OPENING_HOURS);
  const ask = (args: Record<string, unknown>) => {
    const m = fakeMiddleware();
    const s = session({ openingHours: week });
    return executeTool(TOOL_AVAILABILITY, args, s, m.api).then((r) => ({ r, calls: m.calls }));
  };
  // 2026-10-10 Saturday, 11 Sunday, 12 Monday, 13 Tuesday
  it.each(["2026-10-11", "2026-10-12"])("discover on closed %s is answered locally", async (date) => {
    const { r, calls } = await ask({ action: "discover", date, time_period: "morning" });
    expect(r.outcome).toBe("no_availability");
    expect(calls).toHaveLength(0);
  });
  it("2026-10-11: a Saturday (afternoon or 13:30) is never judged locally; only the server speaks of closures", async () => {
    const a = await ask({ action: "discover", date: "2026-10-10", time_period: "afternoon", preferred_time: "13:30" });
    expect(a.calls).toHaveLength(1);
    expect(a.r.message).toBe("Tengo a las 10:00.");
    expect((await ask({ action: "discover", date: "2026-10-10", time_period: "morning" })).calls).toHaveLength(1);
    expect((await ask({ action: "discover", date: "2026-10-13", time_period: "afternoon" })).calls).toHaveLength(1);
    // A scan by weekday is the server's to judge, even over a Sunday date_from.
    expect((await ask({ action: "scan", date_from: "2026-10-11", days: 1, weekday: "sábado" })).calls).toHaveLength(1);
  });
  it("scan only short-circuits when every day of the window is closed", async () => {
    expect((await ask({ action: "scan", date_from: "2026-10-11", days: 2 })).calls).toHaveLength(0);
    expect((await ask({ action: "scan", date_from: "2026-10-11", days: 3 })).calls).toHaveLength(1);
  });
  it("without a schedule nothing is short-circuited", async () => {
    const m = fakeMiddleware();
    await executeTool(TOOL_AVAILABILITY, { action: "discover", date: "2026-10-11", time_period: "morning" }, session(), m.api);
    expect(m.calls).toHaveLength(1);
  });
});

describe("cancellation notice and late arrival", () => {
  it("records notice_minutes / late_notice but hides them from the model", async () => {
    const m = fakeMiddleware({
      outcome: "cancelled",
      owner_notified: false,
      notice_minutes: 20,
      late_notice: true,
      reservation: { day_label: "hoy", time: "10:00", professional: "Bruno" },
    });
    const s = session();
    const out = await executeTool(TOOL_CANCEL, { reservation_ref: "r", confirmed_by_customer: true }, s, m.api);
    expect(out.notice_minutes).toBeUndefined();
    expect(out.late_notice).toBeUndefined();
    expect(s.cancellations?.[0]).toMatchObject({ notice_minutes: 20, late_notice: true });
  });
  it("notify_late_arrival only records, and promises nothing", async () => {
    const s = session();
    const out = await executeTool(TOOL_LATE_ARRIVAL, { minutes_late: 10 }, s, fakeMiddleware().api);
    expect(out.outcome).toBe("late_arrival_recorded");
    expect(s.lateArrival).toEqual({ minutes: 10 });
    expect(s.pendingHandoff).toBeUndefined();
    expect(String(out.message)).not.toMatch(/avis(o|aré|ará)|equipo|Bruno/);
  });
});
