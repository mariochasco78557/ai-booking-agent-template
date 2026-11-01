/**
 * HTTP surface.
 *
 *   GET  /health               — liveness + the fields Vocero's "Quién responde"
 *                                card reads (version, commit, mode, relay).
 *   ANY  /api/webhooks/wa/...  — Meta's webhook. Forwarded UNCHANGED to Vocero
 *                                (method, path, query, body bytes, signature
 *                                header) and Vocero's answer is returned to
 *                                Meta. Only after Vocero accepted a POST are
 *                                its customer messages queued for an answer.
 *
 * The relay comes first on purpose: the inbox must always get the message,
 * whether or not the brain answers it. If Vocero is unreachable Meta gets a
 * 502 and retries later, so nothing is lost.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Config } from "./config.js";
import { shouldAnswer } from "./config.js";
import { parseInbound, type InboundMessage } from "./meta.js";
import type { Logger } from "./log.js";
import type { FetchLike } from "./http.js";

export interface ServerDeps {
  config: Config;
  log: Logger;
  enqueue(message: InboundMessage): void;
  queueStats(): { pending: number; oldestSeconds: number };
  fetchImpl?: FetchLike;
}

const WEBHOOK_PREFIX = "/api/webhooks/wa/";
const MAX_BODY = 2 * 1024 * 1024;
const FORWARDED_HEADERS = ["content-type", "x-hub-signature-256", "x-hub-signature", "user-agent", "x-forwarded-for"];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createBrainServer(deps: ServerDeps): Server {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let lastRelayErrorAt: string | null = null;

  return createServer(async (req, res) => {
    const url = req.url ?? "/";
    try {
      if (url === "/health" && req.method === "GET") {
        const q = deps.queueStats();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            name: "demo-salon-whatsapp-brain",
            version: deps.config.version,
            ...(deps.config.commit ? { commit: deps.config.commit } : {}),
            // Vocero's card only understands its own mode names.
            mode: "estándar",
            brainMode: deps.config.mode,
            bookingEnabled: deps.config.bookingEnabled,
            model: deps.config.model,
            relay: { pendientes: q.pending, masViejoSegundos: q.oldestSeconds, ultimoErrorEn: lastRelayErrorAt },
          })
        );
        return;
      }

      if (!url.startsWith(WEBHOOK_PREFIX) || (req.method !== "GET" && req.method !== "POST")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not_found"}');
        return;
      }

      const body = req.method === "POST" ? await readBody(req) : undefined;
      const headers: Record<string, string> = {};
      for (const h of FORWARDED_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }

      let upstream: Response;
      try {
        upstream = await fetchImpl(`${deps.config.voceroUrl}${url}`, {
          method: req.method,
          headers,
          body: body ? new Uint8Array(body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        lastRelayErrorAt = new Date().toISOString();
        deps.log.error("relay.failed", { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(502, { "content-type": "application/json" });
        res.end('{"error":"vocero_unreachable"}');
        return;
      }

      const payload = Buffer.from(await upstream.arrayBuffer());
      const ct = upstream.headers.get("content-type");
      res.writeHead(upstream.status, ct ? { "content-type": ct } : {});
      res.end(payload);

      if (upstream.status >= 400) {
        lastRelayErrorAt = new Date().toISOString();
        deps.log.warn("relay.rejected", { status: upstream.status, method: req.method });
        return;
      }
      if (req.method !== "POST" || !body || deps.config.mode === "off") return;

      let json: unknown;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        return;
      }
      for (const m of parseInbound(json, deps.config.phoneNumberId)) {
        if (shouldAnswer(deps.config, m.waId)) deps.enqueue(m);
      }
    } catch (err) {
      deps.log.error("server.error", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"internal"}');
      }
    }
  });
}
