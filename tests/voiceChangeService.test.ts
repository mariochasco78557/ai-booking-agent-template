import { describe, expect, it, vi } from "vitest";
import { VoiceManageService } from "../src/services/voiceManage/voiceManageService.js";

const NOW = Date.parse("2026-10-05T08:00:00Z");
const CONV = "conv_abcdefgh12345";
const logger = { info: vi.fn(), warn: vi.fn() };
const rows = [
  {
    id: 89336,
    startsAt: "2026-10-10 13:30",
    ownerPhoneE164: "+34600000001",
    ownerName: "Ana",
    ownerSurnames: "P",
    employeeId: 1,
    employeeName: "Ramón",
    typeReservation: 2,
    state: "active" as const,
  },
];

function make(enabled: boolean) {
  const changeServiceForVoice = vi.fn(async () => ({ outcome: "service_changed", external_mutation: true }));
  const svc = new VoiceManageService(
    { enabled: true, changeServiceEnabled: enabled },
    {
      listForVoice: async () => ({ ok: true as const, rows }),
      cancelForVoice: async () => ({ outcome: "cancelled" }),
      changeServiceForVoice,
    },
    logger,
  );
  return { svc, changeServiceForVoice };
}
const body = (extra: Record<string, unknown> = {}) => ({
  conversation_id: CONV,
  caller_phone: "600000001",
  booking_index: 1,
  service_id: 1,
  ...extra,
});

describe("voice change_service", () => {
  it("flag off -> service_change_unavailable", async () => {
    const { svc, changeServiceForVoice } = make(false);
    await svc.myBookings(body(), NOW);
    const r = await svc.changeService(body(), NOW);
    expect(r.outcome).toBe("service_change_unavailable");
    expect(changeServiceForVoice).not.toHaveBeenCalled();
  });

  it("not listed index -> booking_not_listed", async () => {
    const { svc } = make(true);
    expect((await svc.changeService(body(), NOW)).outcome).toBe("booking_not_listed");
    await svc.myBookings(body(), NOW);
    expect((await svc.changeService(body({ booking_index: 2 }), NOW)).outcome).toBe("booking_not_listed");
  });

  it("asks, then (>=3 s, same service) writes once, spoken hour in words", async () => {
    const { svc, changeServiceForVoice } = make(true);
    await svc.myBookings(body(), NOW);
    const q = await svc.changeService(body(), NOW);
    expect(q.outcome).toBe("confirm_required");
    expect(q.message).toMatch(/^¿Te dejo la cita del sábado diez de octubre a la una y media/);
    expect(q.message).toMatch(/como corte de pelo, en vez de corte y barba\?$/);
    expect((await svc.changeService(body({ confirmed_by_customer: true }), NOW + 1000)).outcome).toBe("confirm_required");
    const done = await svc.changeService(body({ confirmed_by_customer: true }), NOW + 10_000);
    expect(done.outcome).toBe("service_changed");
    expect(done.message).toMatch(/^Hecho: tu cita del sábado diez de octubre a la una y media.*queda como corte de pelo\.$/);
    expect(changeServiceForVoice).toHaveBeenCalledTimes(1);
    const again = await svc.changeService(body({ confirmed_by_customer: true }), NOW + 11_000);
    expect(again.idempotency_status).toBe("replayed");
    expect(changeServiceForVoice).toHaveBeenCalledTimes(1);
  });
});
