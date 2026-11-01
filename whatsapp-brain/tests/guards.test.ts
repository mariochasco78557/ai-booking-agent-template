/** 2026-10-11 — the agent never states closures the agenda did not state. */
import { describe, expect, it } from "vitest";
import { CLOSURE_FALLBACK, CLOSURE_RETRY_NOTE, unsupportedClosureClaim } from "../src/guards.js";
import { processTurn } from "../src/conversation.js";
import { harness, inbound } from "./harness.js";

describe("unsupportedClosureClaim", () => {
  it("an invented closure with no «cerr» in any tool message is a claim", () => {
    expect(unsupportedClosureClaim("Los sábados cerramos a las 14:00, así que a esa hora no tenemos hueco.", [])).toBe(true);
    expect(unsupportedClosureClaim("Por la tarde estamos cerrados.", ["Tengo a las 10:00."])).toBe(true);
    expect(unsupportedClosureClaim("A esa hora ya no abrimos.", [])).toBe(true);
  });
  it("Sunday and Monday are allowed without a tool", () => {
    expect(unsupportedClosureClaim("Los lunes cerramos. ¿Qué otro día te viene bien?", [])).toBe(false);
    expect(unsupportedClosureClaim("Los domingos estamos cerrados.", [])).toBe(false);
  });
  it("the server's own message makes it legitimate", () => {
    expect(
      unsupportedClosureClaim("El sábado diecisiete por la tarde cerramos. ¿Quieres que te mire otro día?", [
        "El sábado diecisiete por la tarde cerramos. ¿Quieres que te mire otro día?",
      ])
    ).toBe(false);
  });
  it("no closure words, no claim", () => {
    expect(unsupportedClosureClaim("Ese sábado no tengo hueco.", [])).toBe(false);
  });
});

describe("closure guard in a turn", () => {
  const claim = { content: "Los sábados cerramos a las 14:00, así que a esa hora no tenemos hueco.", toolCalls: [] };
  const msgs = [{ role: "user" as const, content: "hola" }, { role: "assistant" as const, content: "¿Qué día?" }];

  it("retries once with the note and sends the corrected reply", async () => {
    const h = harness({ script: [claim, { content: "Ese sábado no me queda hueco a las 9:30. ¿Te miro otro?", toolCalls: [] }], messages: msgs });
    await processTurn(h.deps, "34600111222", inbound("¿Y el sábado a las 9:30?"));
    expect(h.seen).toHaveLength(2);
    const note = h.seen[1]!.filter((m) => m.role === "user").at(-1) as { content: string };
    expect(note.content).toBe(CLOSURE_RETRY_NOTE);
    expect(h.events).toEqual(["send:Ese sábado no me queda hueco a las 9:30. ¿Te miro otro?"]);
  });

  it("if it repeats, the last availability message goes out; without one, the neutral question", async () => {
    const withTool = harness({
      script: [
        { content: null, toolCalls: [{ id: "a1", type: "function", function: { name: "booking_availability_balanced_v2", arguments: JSON.stringify({ action: "discover", date: "2026-10-17", time_period: "morning" }) } }] },
        claim,
        claim,
      ],
      messages: msgs,
      availability: async () => ({ outcome: "no_availability", message: "Ese sábado no me queda hueco a esa hora. ¿Te miro otro día?" }),
    });
    await processTurn(withTool.deps, "34600111222", inbound("sábado 9:30"));
    expect(withTool.events).toEqual(["send:Ese sábado no me queda hueco a esa hora. ¿Te miro otro día?"]);

    const without = harness({ script: [claim, claim], messages: msgs });
    await processTurn(without.deps, "34600111222", inbound("sábado 9:30"));
    expect(without.events).toEqual([`send:${CLOSURE_FALLBACK}`]);
  });

  it("a closure the server said («por la tarde cerramos») is copied without a retry", async () => {
    const said = "El sábado diecisiete por la tarde cerramos. ¿Quieres que te mire otro día?";
    const h = harness({
      script: [
        { content: null, toolCalls: [{ id: "a1", type: "function", function: { name: "booking_availability_balanced_v2", arguments: JSON.stringify({ action: "discover", date: "2026-10-17", time_period: "afternoon" }) } }] },
        { content: said, toolCalls: [] },
      ],
      messages: msgs,
      availability: async () => ({ outcome: "no_availability", message: said }),
    });
    await processTurn(h.deps, "34600111222", inbound("sábado por la tarde"));
    expect(h.seen).toHaveLength(2); // tool round + reply, no guard retry
    expect(h.events).toEqual([`send:${said}`]);
  });
});
