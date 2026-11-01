import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildStaticPrompt } from "../src/prompt.js";
import { withCalendarLinks } from "../src/conversation.js";

/** 2026-10-10 — saludo y cierre de Bruno (internal doc, not included in the template). */
describe("plantillas de Bruno en el cerebro de WhatsApp", () => {
  const p = buildStaticPrompt();

  it("inicio: servicio y 1️⃣ día, 2️⃣ profesional, 3️⃣ franja, saltando lo ya dicho", () => {
    expect(p).toContain("Para darte cita rápido, dime si es corte de pelo, barba, o corte y barba, y:");
    expect(p).toContain("1️⃣ ¿Qué día te viene mejor? O lo antes posible");
    expect(p).toContain("2️⃣ ¿Tienes preferencia de profesional? (si te da igual, lo asigno yo)");
    expect(p).toContain("3️⃣ ¿Mañana, tarde o indiferente?");
    expect(p).toContain("quitando las líneas de lo que el cliente ya haya dicho");
    expect(p).toContain("«Lo antes posible» → scan desde hoy");
    expect(p).not.toContain("¿Te busco cita para corte de pelo, barba, o corte y barba?");
  });

  it("cierre: día, hora y profesional del servidor, recordatorio de 1 hora, sin cobros", () => {
    expect(p).toContain(
      "«Listo ✅ viernes 16 de octubre a las 18:00 con Olga. Si necesitas cambiarla o anularla, escríbenos por aquí, con al menos 1 hora de antelación.»",
    );
    expect(p).toContain("el profesional del `slot.employee_name` del último `locked`");
    expect(p).not.toContain("Listo, ya tienes la cita");
    // The charge sentence only answers «¿qué pasa si no voy?», never closes a booking.
    const rules = readFileSync(new URL("../prompts/BOOKING_RULES_ES.md", import.meta.url), "utf8");
    expect(rules).toContain("Va dentro del cierre de Bruno");
    expect(rules).toContain("Si preguntan qué pasa si no vienen");
    expect(rules).toContain("el propio sistema añade el enlace");
  });

  it("la copia de docs/ es idéntica al prompt del cerebro", () => {
    const brain = readFileSync(new URL("../prompts/AGENT_PROMPT_WHATSAPP_V1_ES.md", import.meta.url), "utf8");
    const docs = readFileSync(new URL("../../docs/elevenlabs/AGENT_PROMPT_WHATSAPP_V1_ES.md", import.meta.url), "utf8");
    expect(docs).toBe(brain);
  });

  it("el enlace de calendario sigue yendo después del cierre", () => {
    const close =
      "Listo ✅ viernes 16 de octubre a las 18:00 con Olga. Si necesitas cambiarla o anularla, escríbenos por aquí, con al menos 1 hora de antelación.";
    expect(withCalendarLinks(close, ["https://x.test/cal/abc"])).toBe(
      `${close}\n\nPara añadir la cita a tu calendario: https://x.test/cal/abc`,
    );
  });
});

describe("prompt de voz V6: saludo y cierre de Bruno", () => {
  const v = readFileSync(new URL("../../docs/elevenlabs/AGENT_PROMPT_LEAN_V6_ES.md", import.meta.url), "utf8");

  it("pregunta solo lo que falta, en una sola pregunta, y no pregunta por profesional", () => {
    expect(v).toContain("**Pregunta SOLO lo que falte, todo en una única pregunta, y no supongas nada.**");
    expect(v).toContain("«¿Qué te hacemos, qué día te viene bien y mañana o tarde?»");
    expect(v).toContain("**Nunca preguntas por profesional**");
    expect(v).not.toContain("Obtén, con una sola pregunta cada vez");
  });

  it("el cierre lo lee del servidor y no queda por debajo de lo de antes en longitud", () => {
    expect(v).toContain("ya dice día, hora, profesional y el aviso de cambios");
    // 4232531 (antes de gestionar citas) medía 37 329 caracteres.
    expect([...v].length).toBeLessThanOrEqual(37_329);
  });
});
