import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createBrainServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import type { InboundMessage } from "../src/meta.js";
import { TurnQueue } from "../src/queue.js";

const full = { VOCERO_BOT_API_KEY: "k".repeat(32), AI_WEBHOOK_SECRET: "s".repeat(32), OPENROUTER_API_TOKEN: "sk-or-x" };

let server: Server | undefined;
afterEach(() => server?.close());

async function start(env: Record<string, string>, upstream: (url: string, init: RequestInit) => Promise<Response>) {
  const queued: InboundMessage[] = [];
  const forwarded: { url: string; init: RequestInit }[] = [];
  server = createBrainServer({
    config: loadConfig({ VOCERO_URL: "http://vocero.test", ...env }),
    log: silentLogger,
    enqueue: (m) => queued.push(m),
    queueStats: () => ({ pending: 0, oldestSeconds: 0 }),
    fetchImpl: (async (url: string, init: RequestInit) => {
      forwarded.push({ url, init });
      return upstream(url, init);
    }) as typeof fetch,
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server!.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, queued, forwarded };
}

const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { messages: [
    { from: "34600111222", id: "w1", timestamp: "1700000000", type: "text", text: { body: "hola" } },
    { from: "34699999999", id: "w2", timestamp: "1700000000", type: "text", text: { body: "hola" } },
  ] } }] }],
});

describe("webhook relay", () => {
  it("forwards Meta's verification GET untouched and returns Vocero's answer", async () => {
    const s = await start({}, async () => new Response("CHALLENGE123", { status: 200, headers: { "content-type": "text/plain" } }));
    const res = await fetch(`${s.base}/api/webhooks/wa/secret?hub.mode=subscribe&hub.challenge=CHALLENGE123&hub.verify_token=x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CHALLENGE123");
    expect(s.forwarded[0]?.url).toBe("http://vocero.test/api/webhooks/wa/secret?hub.mode=subscribe&hub.challenge=CHALLENGE123&hub.verify_token=x");
  });

  it("forwards the POST body byte-for-byte with the signature header", async () => {
    const s = await start({}, async () => new Response("{}", { status: 200 }));
    await fetch(`${s.base}/api/webhooks/wa/secret`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=abc" },
      body,
    });
    const init = s.forwarded[0]!.init;
    expect(Buffer.from(init.body as Uint8Array).toString("utf8")).toBe(body);
    expect((init.headers as Record<string, string>)["x-hub-signature-256"]).toBe("sha256=abc");
  });

  it("in off mode relays but answers nobody", async () => {
    const s = await start({}, async () => new Response("{}", { status: 200 }));
    await fetch(`${s.base}/api/webhooks/wa/secret`, { method: "POST", body });
    expect(s.queued).toHaveLength(0);
  });

  it("in pilot mode queues only allowlisted numbers, after Vocero accepted", async () => {
    const s = await start({ ...full, BRAIN_MODE: "pilot", BRAIN_ALLOWED_WA_IDS: "34600111222" }, async () => new Response("{}", { status: 200 }));
    await fetch(`${s.base}/api/webhooks/wa/secret`, { method: "POST", body });
    expect(s.queued.map((m) => m.waId)).toEqual(["34600111222"]);
  });

  it("queues nothing when Vocero rejected the delivery", async () => {
    const s = await start({ ...full, BRAIN_MODE: "live" }, async () => new Response("{}", { status: 401 }));
    const res = await fetch(`${s.base}/api/webhooks/wa/secret`, { method: "POST", body });
    expect(res.status).toBe(401);
    expect(s.queued).toHaveLength(0);
  });

  it("answers 502 when Vocero is down, so Meta retries", async () => {
    const s = await start({ ...full, BRAIN_MODE: "live" }, async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await fetch(`${s.base}/api/webhooks/wa/secret`, { method: "POST", body });
    expect(res.status).toBe(502);
    expect(s.queued).toHaveLength(0);
  });

  it("refuses anything that is not the webhook or health", async () => {
    const s = await start({}, async () => new Response("{}", { status: 200 }));
    expect((await fetch(`${s.base}/api/bot/messages`, { method: "POST", body: "{}" })).status).toBe(404);
    expect(s.forwarded).toHaveLength(0);
  });

  it("health speaks Vocero's card format", async () => {
    const s = await start({}, async () => new Response("{}", { status: 200 }));
    const h = (await (await fetch(`${s.base}/health`)).json()) as Record<string, unknown>;
    expect(h.ok).toBe(true);
    expect(h.mode).toBe("estándar");
    expect(h.brainMode).toBe("off");
    expect(h.relay).toEqual({ pendientes: 0, masViejoSegundos: 0, ultimoErrorEn: null });
  });
});

describe("turn queue", () => {
  const m = (id: string, waId = "34600111222"): InboundMessage => ({ waId, messageId: id, timestamp: 0, type: "text", text: id, profileName: undefined });

  it("coalesces a burst into one turn and drops duplicates", async () => {
    const turns: string[][] = [];
    const q = new TurnQueue(30, async (_w, msgs) => {
      turns.push(msgs.map((x) => x.messageId));
    });
    q.push(m("a"));
    q.push(m("b"));
    q.push(m("a"));
    await new Promise((r) => setTimeout(r, 60));
    await q.idle();
    expect(turns).toEqual([["a", "b"]]);
  });

  it("never runs two turns of the same customer at once", async () => {
    let running = 0;
    let maxRunning = 0;
    const turns: string[][] = [];
    const q = new TurnQueue(10, async (_w, msgs) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 40));
      turns.push(msgs.map((x) => x.messageId));
      running--;
    });
    q.push(m("a"));
    await new Promise((r) => setTimeout(r, 20));
    q.push(m("b"));
    q.push(m("c"));
    await new Promise((r) => setTimeout(r, 30));
    await q.idle();
    expect(maxRunning).toBe(1);
    expect(turns).toEqual([["a"], ["b", "c"]]);
  });
});
