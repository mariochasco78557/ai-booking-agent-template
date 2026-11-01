import { describe, it, expect } from "vitest";

import {
  AGENDA_DIGEST_MAX_LINES,
  dayTimeShort,
  formatAgendaLine,
  formatDigest,
  noticeText,
  shortCustomer,
  shortProfessional,
  type AgendaLineEvent,
} from "../src/services/ownerNotify/agendaLines.js";
import { OWNER_MESSAGE_MAX_LENGTH } from "../src/services/ownerNotify/ownerMessages.js";

// Tuesday 13/10/2026 09:00 Madrid (CEST).
const NOW = Date.parse("2026-10-13T07:00:00Z");

const cancelledTarde: AgendaLineEvent = {
  type: "cancelled",
  startsAt: "2026-10-13 17:30",
  professional: "Olga",
  customer: "Mikel A.",
  noticeMinutes: 480,
  lateNotice: false,
  channel: "whatsapp",
};
const cancelledSinAviso: AgendaLineEvent = {
  type: "cancelled",
  startsAt: "2026-10-13 12:00",
  professional: "Bruno",
  customer: "Ane B.",
  noticeMinutes: 40,
  lateNotice: true,
  channel: "voice",
};
const changed: AgendaLineEvent = {
  type: "changed",
  fromStartsAt: "2026-10-24 13:30",
  toStartsAt: "2026-10-20 10:00",
  fromProfessional: "Ramón",
  toProfessional: "Ramón",
  customer: "Iker C.",
  channel: "whatsapp",
};
const service: AgendaLineEvent = {
  type: "service",
  startsAt: "2026-10-17 13:30",
  professional: "Ramón",
  fromService: 2,
  toService: 1,
  customer: "Iker C.",
  channel: "voice",
};

describe("agenda lines: literal texts", () => {
  it("the four examples are character-for-character", () => {
    expect(formatAgendaLine(cancelledTarde, NOW)).toBe(
      "❌ ANULADA · hoy 17:30 · Olga · Mikel A. · con aviso (8 h antes)",
    );
    expect(formatAgendaLine(cancelledSinAviso, NOW)).toBe(
      "❌ ANULADA · hoy 12:00 · Bruno · Ane B. · ⚠️ SIN AVISO (40 min antes)",
    );
    expect(formatAgendaLine(changed, NOW)).toBe("🔁 CAMBIADA · sáb 24/10 13:30 → mar 20/10 10:00 · Ramón · Iker C.");
    expect(formatAgendaLine(service, NOW)).toBe("✂️ SERVICIO · sáb 13:30 · Ramón · corte y barba → corte · Iker C.");
  });

  it("the digest example is character-for-character", () => {
    const text = formatDigest(
      {
        date: "2026-10-13",
        count: 14,
        lines: [
          { ...cancelledTarde, noticeMinutes: 2 * 1440 },
          { ...changed, fromStartsAt: "2026-10-16 13:30", toStartsAt: "2026-10-13 10:00" },
        ],
        booked: { whatsapp: 2, voice: 1 },
      },
      NOW,
    );
    expect(text).toBe(
      [
        "📅 Hoy martes 13 · 14 citas",
        "🔁 CAMBIADA · vie 13:30 → hoy 10:00 · Ramón · Iker C.",
        "❌ ANULADA · hoy 17:30 · Olga · Mikel A. · con aviso (2 días antes)",
        "🆕 3 reservas nuevas de los agentes (2 WhatsApp · 1 llamada)",
      ].join("\n"),
    );
  });
});

describe("dayTimeShort", () => {
  it("today, tomorrow, +2..+6 (abbreviation), +7 and past (with D/M)", () => {
    expect(dayTimeShort("2026-10-13 17:30", NOW)).toBe("hoy 17:30");
    expect(dayTimeShort("2026-10-14 09:00", NOW)).toBe("mañana 09:00");
    expect(dayTimeShort("2026-10-15 09:00", NOW)).toBe("jue 09:00");
    expect(dayTimeShort("2026-10-19 09:00", NOW)).toBe("lun 09:00");
    expect(dayTimeShort("2026-10-20 10:00", NOW)).toBe("mar 20/10 10:00");
    expect(dayTimeShort("2026-10-12 10:00", NOW)).toBe("lun 12/10 10:00");
    expect(dayTimeShort("no es una fecha", NOW)).toBe("no es una fecha");
  });

  it("Madrid midnight around the clock change of 25/10/2026", () => {
    const afterMidnightCest = Date.parse("2026-10-24T22:30:00Z"); // 00:30 CEST on 25/10
    expect(dayTimeShort("2026-10-25 10:00", afterMidnightCest)).toBe("hoy 10:00");
    expect(dayTimeShort("2026-10-26 09:00", afterMidnightCest)).toBe("mañana 09:00");
    const lateCet = Date.parse("2026-10-25T22:30:00Z"); // 23:30 CET on 25/10
    expect(dayTimeShort("2026-10-26 09:00", lateCet)).toBe("mañana 09:00");
    expect(dayTimeShort("2026-10-25 10:00", lateCet)).toBe("hoy 10:00");
    // 23:30 UTC on 24/10 is already 01:30 Madrid of the 25th.
    expect(dayTimeShort("2026-10-25 10:00", Date.parse("2026-10-24T23:30:00Z"))).toBe("hoy 10:00");
  });
});

describe("noticeText and the threshold", () => {
  it("rounds down to minutes, hours and days", () => {
    expect([0, 59, 60, 61, 1439, 1440, 2880].map(noticeText)).toEqual([
      "0 min",
      "59 min",
      "1 h",
      "1 h",
      "23 h",
      "1 día",
      "2 días",
    ]);
  });

  it("59 min late -> SIN AVISO; 60 min on time -> con aviso", () => {
    expect(formatAgendaLine({ ...cancelledTarde, noticeMinutes: 59, lateNotice: true }, NOW)).toContain(
      "⚠️ SIN AVISO (59 min antes)",
    );
    expect(formatAgendaLine({ ...cancelledTarde, noticeMinutes: 60, lateNotice: false }, NOW)).toContain(
      "con aviso (1 h antes)",
    );
  });
});

describe("shortCustomer / shortProfessional", () => {
  it("strips the AI prefix in any spelling and adds the surname initial", () => {
    expect(shortCustomer("IA - Mikel", "Aguirre Lopez", "IA -")).toBe("Mikel A.");
    expect(shortCustomer("IA-Mikel", "aguirre", "IA -")).toBe("Mikel A.");
    expect(shortCustomer("ia - mikel", "aguirre", "IA -")).toBe("Mikel A.");
    expect(shortCustomer("Mikel", "", "IA -")).toBe("Mikel");
    expect(shortCustomer("", "", "IA -")).toBe("sin nombre");
    expect(shortCustomer("IA - ", "Perez", "IA -")).toBe("sin nombre");
    expect(shortCustomer("A".repeat(40), "", "IA -")).toHaveLength(20);
  });

  it("first word of the professional, null stays null and drops the segment", () => {
    expect(shortProfessional("Ramón García")).toBe("Ramón");
    expect(shortProfessional(null)).toBeNull();
    expect(shortProfessional("  ")).toBeNull();
    expect(formatAgendaLine({ ...cancelledTarde, professional: null }, NOW)).toBe(
      "❌ ANULADA · hoy 17:30 · Mikel A. · con aviso (8 h antes)",
    );
  });
});

describe("changed", () => {
  it("another professional shows A → B; an unknown new one shows only A", () => {
    expect(formatAgendaLine({ ...changed, toProfessional: "Olga" }, NOW)).toContain("· Ramón → Olga ·");
    const unknown = formatAgendaLine({ ...changed, toProfessional: null }, NOW);
    expect(unknown).toContain("· Ramón ·");
    expect(unknown).not.toContain("→ Olga");
  });

  it("never adds a «nº dictado» suffix (decision 2026-10-11)", () => {
    expect(formatAgendaLine({ ...cancelledTarde, dictated: true }, NOW)).not.toContain("dictado");
    expect(formatAgendaLine({ ...changed, dictated: true }, NOW)).not.toContain("dictado");
  });
});

describe("digest", () => {
  const base = { date: "2026-10-13", booked: { whatsapp: 0, voice: 0 } };

  it("header alone, singular, none, unknown", () => {
    expect(formatDigest({ ...base, count: 1, lines: [] }, NOW)).toBe("📅 Hoy martes 13 · 1 cita");
    expect(formatDigest({ ...base, count: 0, lines: [] }, NOW)).toBe("📅 Hoy martes 13 · sin citas");
    expect(formatDigest({ ...base, count: null, lines: [] }, NOW)).toBe(
      "📅 Hoy martes 13 · no he podido contar las citas",
    );
  });

  it("the new-bookings line: singular, plural and zero parts removed", () => {
    const line = (whatsapp: number, voice: number) =>
      formatDigest({ ...base, count: 3, lines: [], booked: { whatsapp, voice } }, NOW).split("\n")[1];
    expect(line(1, 0)).toBe("🆕 1 reserva nueva de los agentes (1 WhatsApp)");
    expect(line(0, 1)).toBe("🆕 1 reserva nueva de los agentes (1 llamada)");
    expect(line(0, 2)).toBe("🆕 2 reservas nuevas de los agentes (2 llamadas)");
    expect(line(2, 0)).toBe("🆕 2 reservas nuevas de los agentes (2 WhatsApp)");
    expect(line(0, 0)).toBeUndefined();
  });

  it("26 lines -> 25 + «… y 1 más», sorted by time, within the length limit", () => {
    const lines: AgendaLineEvent[] = Array.from({ length: AGENDA_DIGEST_MAX_LINES + 1 }, (_, i) => ({
      ...cancelledTarde,
      startsAt: `2026-10-13 ${String(20 - Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}`,
    }));
    const text = formatDigest({ ...base, count: 20, lines }, NOW);
    const rows = text.split("\n");
    expect(rows).toHaveLength(1 + AGENDA_DIGEST_MAX_LINES + 1);
    expect(rows[rows.length - 1]).toBe("… y 1 más");
    expect(text.length).toBeLessThanOrEqual(OWNER_MESSAGE_MAX_LENGTH);
    const times = rows.slice(1, 1 + AGENDA_DIGEST_MAX_LINES).map((r) => /hoy (\d\d:\d\d)/.exec(r)![1]!);
    expect([...times].sort()).toEqual(times);
  });

  it("orders by the earliest hour of the appointment (a change counts its earlier one)", () => {
    const text = formatDigest(
      { ...base, count: 5, lines: [cancelledTarde, { ...changed, fromStartsAt: "2026-10-16 13:30", toStartsAt: "2026-10-13 10:00" }] },
      NOW,
    );
    const rows = text.split("\n");
    expect(rows[1]).toContain("CAMBIADA");
    expect(rows[2]).toContain("ANULADA");
  });
});

describe("privacy", () => {
  it("no output carries nine consecutive digits", () => {
    const outputs = [
      formatAgendaLine(cancelledTarde, NOW),
      formatAgendaLine(cancelledSinAviso, NOW),
      formatAgendaLine(changed, NOW),
      formatAgendaLine(service, NOW),
      formatDigest(
        { date: "2026-10-13", count: 14, lines: [cancelledTarde, changed, service], booked: { whatsapp: 1, voice: 1 } },
        NOW,
      ),
    ];
    for (const o of outputs) expect(o).not.toMatch(/\d{9}/);
  });
});
