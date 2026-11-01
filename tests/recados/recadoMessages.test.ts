import { describe, expect, it } from "vitest";

import * as M from "../../src/services/recados/recadoMessages.js";
import { at, recado, SAT, TUE } from "./helpers.js";

const NOW = at(TUE, "10:50");

describe("formatRecadoMessage", () => {
  it("14. every KIND_HEAD and channel; «entró a las» today vs «entró el sábado…» other day", () => {
    for (const kind of ["late", "wants_human", "complaint", "question"] as const) {
      const v = M.formatRecadoMessage(recado({ kind, channel: "voice" }), NOW);
      const w = M.formatRecadoMessage(recado({ kind, channel: "whatsapp" }), NOW);
      expect(v.split("\n")[0]).toBe(`${M.KIND_HEAD[kind]} · por llamada · entró a las 10:42`);
      expect(w.split("\n")[0]).toBe(`${M.KIND_HEAD[kind]} · por WhatsApp · entró a las 10:42`);
    }
    const old = M.formatRecadoMessage(recado({ createdAt: at(SAT, "16:05") }), NOW);
    expect(old.split("\n")[0]).toContain("entró el sábado 10 de octubre 16:05");
  });

  it("matches the documented example", () => {
    expect(M.formatRecadoMessage(recado(), NOW)).toBe(
      [
        "🕐 RETRASO · por llamada · entró a las 10:42",
        "«Llego unos diez minutos tarde, estoy aparcando.»",
        "Retraso: unos 10 min",
        "Cliente: Ana · +34 600 111 222",
        "Próxima cita: hoy 11:00 · Bruno · Corte de pelo",
      ].join("\n"),
    );
  });

  it("15. phone formats by source", () => {
    expect(M.formatRecadoMessage(recado({ phoneSource: "dictated" }), NOW)).toContain("+34 600 111 222 (dictado)");
    expect(M.formatRecadoMessage(recado({ phoneSource: "written" }), NOW)).toContain("+34 600 111 222 (lo escribe el cliente)");
    const none = M.formatRecadoMessage(recado({ phoneSource: "none", phoneE164: null }), NOW);
    expect(none).toContain("Cliente: Ana · sin teléfono");
    expect(M.formatRecadoMessage(recado({ customerName: null, minutesLate: null }), NOW)).toContain("Cliente: sin nombre ·");
    expect(M.formatRecadoMessage(recado({ minutesLate: null }), NOW)).not.toContain("Retraso:");
  });

  it("16. appointment lines", () => {
    const other = recado({
      appointment: { status: "found", startsAt: "2026-10-15 16:30", professional: null, service: null, bookedName: "Luis Prueba" },
    });
    expect(M.formatRecadoMessage(other, NOW)).toContain("Próxima cita: jueves 15 de octubre 16:30 · sin profesional · servicio sin indicar");
    expect(M.formatRecadoMessage(other, NOW)).not.toContain("a nombre de");
    expect(M.formatRecadoMessage({ ...other, customerName: null }, NOW)).toContain("(a nombre de Luis Prueba)");
    expect(M.formatRecadoMessage(recado({ appointment: { status: "none" } }), NOW)).toContain("Próxima cita: ninguna");
    expect(M.formatRecadoMessage(recado({ appointment: { status: "error" } }), NOW)).toContain("Próxima cita: no se ha podido consultar");
    expect(M.formatRecadoMessage(recado({ appointment: { status: "pending" } }), NOW)).toContain("Próxima cita: no se ha podido consultar");
    expect(M.formatRecadoMessage(recado({ appointment: { status: "not_searched" } }), NOW)).toContain(
      "Próxima cita: no consultada (número no español)",
    );
  });

  it("marks the CLI test notice on its first line", () => {
    expect(M.formatRecadoMessage(recado({ dedupeKey: "prueba:1" }), NOW).split("\n")[0]).toBe("[PRUEBA]");
  });
});

describe("customer phrases", () => {
  it("17. exact product phrases; none mentions the opening hours", () => {
    expect(M.MSG_RECADO).toBe("Le paso tu recado a Bruno y te atenderá a la mayor brevedad.");
    expect(M.MSG_RECADO_LATE).toBe("Se lo paso a Bruno; si hay algún problema, te llamará.");
    expect(M.MSG_PHONE_NEEDED).toBe("¿Me dices un teléfono para que Bruno te llame?");
    expect(M.MSG_NAME_AND_PHONE_NEEDED).toBe("¿Me dices tu nombre y un teléfono para que Bruno te llame?");
    expect(M.MSG_DICTATED_INVALID).toBe("Ese número no me sale bien. ¿Me lo dices otra vez, cifra a cifra?");
    expect(M.customerPhrase("late")).toBe(M.MSG_RECADO_LATE);
    expect(M.customerPhrase("complaint")).toBe(M.MSG_RECADO);
    expect(M.voiceFallback("wants_human")).toBe(M.FALLBACK_VOICE_WANTS_HUMAN);
    expect(M.voiceFallback("late")).toBe(M.FALLBACK_VOICE_LATE);
    expect(M.voiceFallback("question")).toBe(M.FALLBACK_VOICE_OTHER);
    const all = [
      M.MSG_RECADO, M.MSG_RECADO_LATE, M.MSG_PHONE_NEEDED, M.MSG_NAME_AND_PHONE_NEEDED, M.MSG_DICTATED_INVALID,
      M.MSG_INVALID_RECADO, M.FALLBACK_VOICE_WANTS_HUMAN, M.FALLBACK_VOICE_OTHER, M.FALLBACK_VOICE_LATE, M.FALLBACK_WA,
    ];
    for (const phrase of all) expect(phrase).not.toMatch(/no pasa nada|horario|cerrad|abierto/i);
  });
});

describe("header, summary, handled", () => {
  it("18. headerText singular/plural; summaryText singular/plural and the cut at 20", () => {
    expect(M.headerText(1)).toBe("📋 1 recado de cuando estaba cerrado");
    expect(M.headerText(3)).toBe("📋 3 recados de cuando estaba cerrado");
    expect(M.summaryText([recado()], NOW).split("\n")[0]).toBe("🌙 Cierre de hoy: 1 recado sin marcar");
    expect(M.summaryText([recado()], NOW)).toContain("• 🕐 RETRASO · Ana · +34 600 111 222 · 10:42");
    const many = Array.from({ length: 23 }, (_, i) => recado({ id: `id${i}`, createdAt: at(TUE, "09:30") + i * 60_000 }));
    const text = M.summaryText(many, NOW);
    const lines = text.split("\n");
    expect(lines[0]).toBe("🌙 Cierre de hoy: 23 recados sin marcar");
    expect(lines).toHaveLength(1 + 20 + 1);
    expect(lines[21]).toBe("… y 3 más");
    const old = M.summaryText([recado({ createdAt: at(SAT, "16:05"), phoneE164: null, customerName: null })], NOW);
    expect(old).toContain("• 🕐 RETRASO · sin nombre · sin teléfono · 10/10 16:05");
  });

  it("handledLine / handledText", () => {
    expect(M.handledLine(at(TUE, "10:47"))).toBe("✅ Atendido a las 10:47");
    expect(M.handledText("original", at(TUE, "10:47"))).toBe("✅ Atendido a las 10:47\noriginal");
  });
});

describe("voceroUrl and keyboard", () => {
  it("19. with and without {conversationId}", () => {
    expect(M.voceroUrl("https://w.example.com", "abc")).toBe("https://w.example.com");
    expect(M.voceroUrl("https://w.example.com/c/{conversationId}", "a b/c")).toBe("https://w.example.com/c/a%20b%2Fc");
    expect(M.voceroUrl("https://w.example.com/c/{conversationId}", null)).toBe("https://w.example.com");
  });

  it("keyboards: voice [[✅]], whatsapp [[✅],[Abrir]], handled: voice none, whatsapp only Abrir", () => {
    const t = "https://w.example.com";
    expect(M.recadoKeyboard(recado({ channel: "voice" }), t, false)).toEqual([[{ text: M.BUTTON_DONE, callbackData: "rh:aaaaaaaaaaaa" }]]);
    expect(M.recadoKeyboard(recado({ channel: "whatsapp" }), t, false)).toEqual([
      [{ text: M.BUTTON_DONE, callbackData: "rh:aaaaaaaaaaaa" }],
      [{ text: M.BUTTON_OPEN, url: t }],
    ]);
    expect(M.recadoKeyboard(recado({ channel: "voice" }), t, true)).toEqual([]);
    expect(M.recadoKeyboard(recado({ channel: "whatsapp" }), t, true)).toEqual([[{ text: M.BUTTON_OPEN, url: t }]]);
  });
});
