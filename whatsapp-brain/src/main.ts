import { loadConfig } from "./config.js";
import { createLogger, waTag } from "./log.js";
import { VoceroClient } from "./vocero.js";
import { MiddlewareClient } from "./middleware.js";
import { OpenRouterClient } from "./llm.js";
import { FileSessionStore } from "./store.js";
import { buildToolDefinitions } from "./tools.js";
import { buildStaticPrompt } from "./prompt.js";
import { processTurn } from "./conversation.js";
import { TurnQueue } from "./queue.js";
import { createBrainServer } from "./server.js";

const config = loadConfig();
const log = createLogger({ service: "wa-brain" });

const vocero = new VoceroClient(config.voceroUrl, config.voceroBotKey, fetch, 10_000, config.historyDays, log);
const middleware = new MiddlewareClient(config.middlewareUrl, config.aiWebhookSecret, config.aiBookingSecret, config.selfServiceSecret);
const llm = new OpenRouterClient(config.openrouterBaseUrl, config.openrouterKey, config.model);
const store = new FileSessionStore(config.dataDir, config.sessionTtlMs);
const tools = buildToolDefinitions();
const staticSystem = llm.systemMessage(buildStaticPrompt(undefined, undefined, config.openingHours));

const queue = new TurnQueue(config.coalesceMs, async (waId, messages) => {
  const turnLog = log.child({ wa: await waTag(waId) });
  const started = Date.now();
  try {
    const outcome = await processTurn(
      { vocero, middleware, llm, store, tools, staticSystem, bookingEnabled: config.bookingEnabled, selfServiceEnabled: config.selfServiceSecret !== undefined, openingHours: config.openingHours, interactive: config.interactive, maxToolRounds: config.maxToolRounds, maxBookingsPerConversation: config.maxBookingsPerConversation, calendarRetryMs: 300_000, log: turnLog },
      waId,
      messages
    );
    turnLog.info("turn.done", { outcome, messages: messages.length, ms: Date.now() - started });
  } catch (err) {
    turnLog.error("turn.crashed", { error: err instanceof Error ? err.message : String(err) });
  }
});

const server = createBrainServer({
  config,
  log,
  enqueue: (m) => queue.push(m),
  queueStats: () => ({ pending: queue.pendingCount(), oldestSeconds: queue.oldestPendingSeconds() }),
});

server.listen(config.port, () => {
  log.info("brain.started", {
    port: config.port,
    mode: config.mode,
    allowed: config.allowedWaIds.size,
    bookingEnabled: config.bookingEnabled,
    selfServiceEnabled: config.selfServiceSecret !== undefined,
    interactive: config.interactive,
    model: config.model,
    version: config.version,
  });
});

/**
 * 2026-10-09 (escaneo, hallazgo 3) — how long SIGTERM waits for the turns in
 * hand. A normal turn (LLM rounds + middleware) takes 5-25 s. The compose's
 * `stop_grace_period` (deploy/vocero/compose.yaml) MUST stay above this plus
 * a margin (40 s), or Docker kills the process mid-turn.
 */
const SHUTDOWN_DRAIN_MS = 30_000;

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log.info("brain.stopping", { pending: queue.pendingCount(), running: queue.runningCount() });
  // No new webhooks: Caddy's `lb_policy first` sends them to Vocero (inbox).
  server.close();
  // Bursts still in their coalescing window are answered now, not in 6 s.
  queue.drain();
  await queue.idle(50, SHUTDOWN_DRAIN_MS);
  const left = { pending: queue.pendingCount(), running: queue.runningCount() };
  if (left.pending > 0 || left.running > 0) log.warn("brain.stopped_with_work", left);
  else log.info("brain.stopped", {});
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
