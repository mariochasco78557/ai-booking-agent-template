/**
 * 2026-10-10 — fechas del servidor (internal doc, not included in the template): the
 * brain offers `fecha_dicha` to the model and forwards it untouched; the
 * middleware resolves the date. No personal data.
 */
import { describe, expect, it } from "vitest";
import type { MiddlewareApi } from "../src/middleware.js";
import { buildToolDefinitions, executeTool, TOOL_AVAILABILITY, type ToolSession } from "../src/tools.js";
import { DEFAULT_OPENING_HOURS, parseOpeningHours } from "../src/hours.js";
import { buildStaticPrompt } from "../src/prompt.js";

const session = (over: Partial<ToolSession> = {}): ToolSession => ({
  middlewareConversationId: "wa_cv_fd_x1",
  spanishPhone: "600111222",
  bookingEnabled: true,
  selfServiceEnabled: true,
  ...over,
});

function recorder(answer: Record<string, unknown>): { calls: Record<string, unknown>[]; m: MiddlewareApi } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    m: {
      availability: async (b) => (calls.push(b), answer),
      book: async () => ({}),
      myReservations: async () => ({}),
      cancel: async () => ({}),
    },
  };
}

describe("fecha_dicha en el cerebro de WhatsApp", () => {
  it("la herramienta de disponibilidad ofrece fecha_dicha al modelo", () => {
    const t = buildToolDefinitions().find((d) => d.function.name === TOOL_AVAILABILITY)!;
    const props = (t.function.parameters as { properties: Record<string, { type: string; description: string }> }).properties;
    expect(props.fecha_dicha?.type).toBe("string");
    expect(props.fecha_dicha?.description).toMatch(/Solo para comprobar/);
    expect(props.fecha_dicha?.description).toMatch(/date_conflict/);
    for (const key of ["dia_semana", "dia_mes", "mes", "relativo", "proximo", "en_dias"]) {
      expect(props[key], key).toBeDefined();
    }
    expect(props.dia_mes?.description).toMatch(/NUNCA una hora/);
  });

  it("se reenvía tal cual y la respuesta date_conflict llega al modelo sin tocar", async () => {
    const conflict = {
      outcome: "date_conflict",
      available: false,
      message: "El dieciséis es viernes. ¿Te lo busco el viernes dieciséis o el jueves quince?",
      options: [],
    };
    const { calls, m } = recorder(conflict);
    const result = await executeTool(
      TOOL_AVAILABILITY,
      { action: "discover", date: "2026-10-16", time_period: "afternoon", service_id: 1, fecha_dicha: "jueves 16" },
      session(),
      m,
    );
    expect(calls[0]).toMatchObject({ fecha_dicha: "jueves 16", conversation_id: "wa_cv_fd_x1" });
    expect(result).toMatchObject({ outcome: "date_conflict", message: conflict.message });
  });

  it("con fecha_dicha el atajo local de «cerrado» no juzga la fecha del modelo", async () => {
    const { calls, m } = recorder({ outcome: "options_available", message: "x", options: [] });
    const s = session({ openingHours: parseOpeningHours(DEFAULT_OPENING_HOURS) });
    // 2026-10-12 is a Monday (closed), but the customer said «martes 13».
    await executeTool(TOOL_AVAILABILITY, { action: "discover", date: "2026-10-12", time_period: "morning", fecha_dicha: "martes 13" }, s, m);
    expect(calls).toHaveLength(1);
  });

  it("con piezas el atajo local de «cerrado» tampoco juzga la fecha del modelo", async () => {
    const { calls, m } = recorder({ outcome: "options_available", message: "x", options: [] });
    const s = session({ openingHours: parseOpeningHours(DEFAULT_OPENING_HOURS) });
    await executeTool(TOOL_AVAILABILITY, { action: "discover", date: "2026-10-12", time_period: "morning", dia_semana: "martes", dia_mes: 13 }, s, m);
    expect(calls[0]).toMatchObject({ dia_semana: "martes", dia_mes: 13 });
  });

  it("el prompt pide las piezas y fecha_dicha", () => {
    const prompt = buildStaticPrompt(undefined, undefined, parseOpeningHours(DEFAULT_OPENING_HOURS));
    expect(prompt).toContain("`fecha_dicha`");
    expect(prompt).toContain("dia_semana, dia_mes, mes, relativo, proximo, en_dias");
    expect(prompt).toContain("`date_conflict`");
    expect(prompt).toContain("`summary`");
  });
});
