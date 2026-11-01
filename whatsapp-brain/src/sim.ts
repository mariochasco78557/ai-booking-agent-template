/**
 * End-to-end rehearsal without WhatsApp and without writes.
 *
 *   node dist/sim.js "Hola" "quiero cortarme el pelo mañana por la tarde" "la primera" "Pedro Pérez" "sí"
 *
 * Every argument is one customer turn. The REAL middleware is asked for
 * availability (read-only) and the REAL model answers; Vocero is replaced by an
 * in-memory fake and booking is forced OFF whatever the environment says, so
 * nothing reaches a customer and no appointment is created.
 *
 * Self-service (ADR-032): with WA_SELF_SERVICE_SECRET set, «mis citas» does a
 * REAL read-only lookup for SIM_WA_ID. «Anular» NEVER reaches the middleware:
 * it is replaced here by a fake `cancel_pending_owner` dry outcome, clearly
 * labeled, so no appointment can be deleted from the simulator.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { MiddlewareClient, type MiddlewareApi } from "./middleware.js";
import { OpenRouterClient, type LlmApi } from "./llm.js";
import { MemorySessionStore } from "./store.js";
import { buildToolDefinitions } from "./tools.js";
import { buildStaticPrompt } from "./prompt.js";
import { processTurn } from "./conversation.js";
import type { VoceroApi } from "./vocero.js";
import { describeInteractive } from "./interactive.js";
import { readFileSync } from "node:fs";

const turns = process.argv.slice(2);
if (turns.length === 0) {
  console.error('uso: node dist/sim.js "mensaje 1" "mensaje 2" ...');
  process.exit(2);
}

const config = loadConfig({ ...process.env, BRAIN_MODE: process.env.BRAIN_MODE === "off" ? "live" : process.env.BRAIN_MODE });
const waId = process.env.SIM_WA_ID ?? "34600000123";

const outbox: string[] = [];
const fakeVocero: VoceroApi = {
  async getContext() {
    return { conversationId: "cv_simulacion0001", contactName: null, aiEnabled: true, windowOpen: true };
  },
  async typing() {},
  async send(_c, text) {
    outbox.push(text);
    return "sent";
  },
  async sendInteractive(_c, interactive) {
    outbox.push(`${interactive.body.text}\n   [BOTONES] ${describeInteractive(interactive)}`);
    return "sent";
  },
  async handoff(_c, reason) {
    console.log(`   ⤷ [traspaso a la peluquería: ${reason}]`);
    return true;
  },
  async setFicha(_c, ficha) {
    console.log(`   ⤷ [nota para Bruno: ${String(ficha.aviso_para_owner ?? "")}]`);
    return true;
  },
  async knowledge() {
    return process.env.SIM_KB_FILE ? readFileSync(process.env.SIM_KB_FILE, "utf8") : "Dirección: Calle Ejemplo 1, Ciudad Demo.";
  },
};

const baseLlm = new OpenRouterClient(config.openrouterBaseUrl, config.openrouterKey, config.model);
const tracingLlm: LlmApi = {
  async chat(messages, tools) {
    const r = await baseLlm.chat(messages, tools);
    for (const c of r.toolCalls) console.log(`   · herramienta ${c.function.name} ${c.function.arguments}`);
    if (r.usage) console.log(`   · tokens ${r.usage.prompt_tokens ?? "?"}→${r.usage.completion_tokens ?? "?"}${r.usage.cost !== undefined ? `, coste $${r.usage.cost}` : ""}`);
    return r;
  },
};

const log = createLogger({ service: "wa-brain-sim" }, (line) => {
  const e = JSON.parse(line) as { event: string; outcome?: string; tool?: string; action?: string };
  if (e.event === "tool") console.log(`   · resultado ${e.tool}${e.action ? `/${e.action}` : ""} → ${e.outcome ?? "?"}`);
  else if (e.event !== "booking") console.log(`   · ${line}`);
});

const realMiddleware = new MiddlewareClient(config.middlewareUrl, config.aiWebhookSecret, config.aiBookingSecret, config.selfServiceSecret);
const simMiddleware: MiddlewareApi = {
  availability: (b) => realMiddleware.availability(b),
  // Booking is off in the sim, but never forward a write even if that changes.
  book: async () => ({ outcome: "write_disabled", booked: false, message: "[SIMULACIÓN] Reserva desactivada." }),
  myReservations: (phone, cid) => realMiddleware.myReservations(phone, cid),
  async recado() {
    console.log("   ⤷ [SIMULACIÓN: el recado NO se envía al middleware]");
    return { outcome: "recado_unavailable" };
  },
  async changeService(_phone, body) {
    console.log("   ⤷ [SIMULACIÓN: el cambio de servicio NO se envía al middleware; resultado falso]");
    if (body.confirmed_by_customer !== true) {
      return {
        outcome: "confirm_required",
        message: "[SIMULACIÓN] ¿Cambio tu cita al servicio pedido? Misma hora y mismo profesional. Responde «sí».",
        external_mutation: false,
      };
    }
    return {
      outcome: "service_changed",
      message: "[SIMULACIÓN] Listo ✅ cambio simulado: no se ha cambiado nada.",
      simulated: true,
      external_mutation: false,
    };
  },
  async cancel() {
    console.log("   ⤷ [SIMULACIÓN: la anulación NO se envía al middleware; resultado falso]");
    return {
      outcome: "cancel_pending_owner",
      message: "[SIMULACIÓN] Anulación simulada: no se ha anulado nada. Le he dejado el aviso a Bruno.",
      owner_notified: false,
      dry_run: true,
      simulated: true,
      external_mutation: false,
    };
  },
};

const deps = {
  vocero: fakeVocero,
  middleware: simMiddleware,
  selfServiceEnabled: config.selfServiceSecret !== undefined,
  llm: tracingLlm,
  store: new MemorySessionStore(),
  tools: buildToolDefinitions(),
  staticSystem: baseLlm.systemMessage(buildStaticPrompt(undefined, undefined, config.openingHours)),
  bookingEnabled: false,
  openingHours: config.openingHours,
  interactive: config.interactive,
  maxToolRounds: config.maxToolRounds,
  maxBookingsPerConversation: config.maxBookingsPerConversation,
  log,
  retryDelayMs: 0,
};

console.log(`Simulación con ${config.model} (reserva DESACTIVADA)\n`);
for (const text of turns) {
  console.log(`👤 ${text}`);
  const before = outbox.length;
  const outcome = await processTurn(deps, waId, [
    { waId, messageId: `sim-${Math.random()}`, timestamp: Math.floor(Date.now() / 1000), type: "text", text, profileName: undefined },
  ]);
  for (const reply of outbox.slice(before)) console.log(`🤖 ${reply}`);
  if (outbox.length === before) console.log(`🤖 (no contesta: ${outcome})`);
  console.log("");
}
