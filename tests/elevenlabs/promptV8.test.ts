import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../docs/elevenlabs/", import.meta.url);
const read = (f: string): string => readFileSync(new URL(f, DIR), "utf8");
const V7 = read("AGENT_PROMPT_LEAN_V7_ES.md");
const V8 = read("AGENT_PROMPT_LEAN_V8_ES.md");

const NEW_SENTENCES = [
  // Bloque C.1
  "Dichos después de «¿Lo confirmo así?», son un «sí» claro: «sí», «vale», «ok», «perfecto», «genial», «de acuerdo», «adelante», «confirmo», «me lo apunto», también con «gracias»: crea la cita en ese mismo turno.",
  "Si además corrige o pregunta algo («perfecto, pero mejor a las diez»), no es un sí: atiende lo que dice.",
  "no repitas el resumen: «Aún no está reservada. ¿Te la reservo?».",
  // Bloque C.2
  "Si hay una hora bloqueada sin cita creada, nunca te despidas ni llames a `end_call` sin decir antes: «La cita no ha quedado reservada.»",
  // Bloque C.3
  "si había un resumen sin contestar, «La cita no ha quedado reservada. Si quieres, llámanos otra vez o escríbenos por WhatsApp a este mismo número. ¡Que vaya bien!»",
  // Bloque C.4
  "scan con `weekday` ese día, `weeks` 4, date_from hoy y su franja o condición. Solo ofreces lo que trae el `message`, nunca otro día de la semana",
  "«Este sábado» o «el sábado diecisiete» es un día: discover.",
  // Bloque C.5
  "Nunca digas a qué hora abre o cierra la peluquería ni que una hora está cerrada salvo leyendo el `message`; lo único que dices tú es que domingos y lunes cerramos.",
  // Bloque 0
  "«Cerrado» solo si lo dice el `message`",
  "`own_booking_at_time`",
  "A esa hora ya tienes tu cita con Ramón. ¿Quieres cambiarle el servicio o prefieres otra hora?",
  "nunca lo busques en DISPONIBILIDAD",
  "Se resuelve con RECADO PARA BRUNO",
];

// Normalised line sets, to prove V8 only adds or edits the lines listed in EDITED_V7_LINES.
const EDITED_V7_LINES = [
  "**Los sábados SÍ abrimos**",
  "No crees la cita sin un «sí» claro al resumen completo.",
  "- CAMBIAR: si tiene dos, que diga cuál.",
  "- Como mucho dos intentos seguidos.",
];

describe("prompt V8", () => {
  it("contains every new sentence", () => {
    for (const s of NEW_SENTENCES) expect(V8, s.slice(0, 60)).toContain(s);
  });

  it("counts «me lo apunto» as a yes, and not the old repeat-the-summary rule", () => {
    expect(V8).toMatch(/«confirmo», «me lo apunto», también con «gracias»/);
    expect(V8).not.toContain("repite el resumen entero y vuelve a preguntar");
    expect(V8).toContain("Un «vale» o un «gracias» dichos antes de la pregunta final no son una confirmación.");
  });

  it("the voice resolves a service-only change with RECADO PARA BRUNO, not WhatsApp or availability", () => {
    const line = V8.split("\n").find((l) => l.startsWith("- CAMBIAR SOLO EL SERVICIO"))!;
    expect(line).toBeDefined();
    expect(line).toContain("RECADO PARA BRUNO");
    expect(line).not.toMatch(/WhatsApp/);
    expect(V8).toContain("booking_recado_para_owner");
  });

  it("writes no opening hours, only «domingos y lunes cerramos»", () => {
    expect(V8).toContain("domingos y lunes cerramos");
    expect(V8).not.toMatch(/\b(abre|abrimos|cierra|cerramos)\b[^.\n]{0,25}\b(a las|desde|hasta|de \d)/i);
    expect(V8).not.toMatch(/\d{1,2}(:\d{2})?\s*(h|horas)?\s*(a|-|–)\s*\d{1,2}:\d{2}\s*(h|horas)?\s*(de|,|\.)?\s*(lunes|martes|sábado|viernes)/i);
    // Every «cerramos» in the prompt is the domingos y lunes one.
    for (const m of V8.matchAll(/cerramos/g)) {
      expect(V8.slice(Math.max(0, m.index! - 20), m.index! + 8)).toContain("domingos y lunes cerramos");
    }
  });

  it("mentions neither prices nor appointment length in the new text", () => {
    const added = V8.split("\n").filter((l) => !V7.split("\n").includes(l)).join("\n");
    expect(added.length).toBeGreaterThan(0);
    expect(added).not.toMatch(/€|euro|precio|cuesta|minutos|duraci/i);
  });

  it("the rest is identical to V7", () => {
    const v7 = V7.split("\n");
    const v8 = new Set(V8.split("\n"));
    const changed = v7.filter((l) => !v8.has(l));
    // Every V7 line that is gone is one of the four deliberately edited ones.
    expect(changed.length).toBe(EDITED_V7_LINES.length);
    for (const l of changed) expect(EDITED_V7_LINES.some((p) => l.startsWith(p)), l.slice(0, 50)).toBe(true);
    // An edited line keeps its V7 text as a prefix-or-superstring around the insertion.
    expect(V8).toContain("**Los sábados SÍ abrimos**, igual que de martes a viernes.");
    // Same titles, same order.
    const titles = (s: string): string[] => [...s.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]!.trim());
    expect(titles(V8)).toEqual(titles(V7));
    // Only lines added: 1 (CIERRE) + 1 (BÚSQUEDA) + 1 (own_booking) + 1 (CAMBIAR SOLO) = 4 new lines.
    expect(V8.split("\n").length - v7.length).toBe(4);
  });
});
