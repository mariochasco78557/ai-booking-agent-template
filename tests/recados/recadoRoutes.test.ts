import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import nock from "nock";

import { buildTestApp, WEBHOOK_SECRET } from "../helpers/testApp.js";
import { MSG_RECADO } from "../../src/services/recados/recadoMessages.js";
import { recadosEnv, TG_SECRET, WA_SECRET } from "./appEnv.js";

let app: FastifyInstance | undefined;
let stateDir = "";

beforeEach(() => nock.cleanAll());
afterEach(async () => {
  await app?.close();
  app = undefined;
  nock.cleanAll();
  if (stateDir !== "") rmSync(dirname(stateDir), { recursive: true, force: true });
});

const body = { conversation_id: "conv-route-0001", caller_phone: "+34600111222", kind: "question", summary: "Quiero hablar con Bruno" };

describe("recado routes", () => {
  it("48. /ai/voice/v2/recado: no secret → 401; broken JSON → 200 invalid_request; a good call → 200 recado_queued", async () => {
    stateDir = recadosEnv();
    app = await buildTestApp();
    const noSecret = await app.inject({ method: "POST", url: "/ai/voice/v2/recado", payload: body });
    expect(noSecret.statusCode).toBe(401);

    const broken = await app.inject({
      method: "POST",
      url: "/ai/voice/v2/recado",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET, "content-type": "application/json" },
      payload: '{"conversation_id": ',
    });
    expect(broken.statusCode).toBe(200);
    expect(broken.json()).toMatchObject({ outcome: "invalid_request", external_mutation: false });

    const ok = await app.inject({
      method: "POST",
      url: "/ai/voice/v2/recado",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ outcome: "recado_queued", message: MSG_RECADO, external_mutation: false });
  });

  it("48. RECADOS_MODE=off → the voice route is a 404 and no state is created", async () => {
    recadosEnv({ RECADOS_MODE: "off" });
    app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/ai/voice/v2/recado",
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect((app as unknown as { recados?: unknown }).recados).toBeUndefined();
  });

  it("49. /ai/wa/recado needs BOTH secrets; the phone comes from the caller-id header", async () => {
    stateDir = recadosEnv();
    app = await buildTestApp();
    const wa = { conversation_id: "conv-route-wa-1", kind: "complaint", summary: "Queja" };
    const url = "/ai/wa/recado";
    expect((await app.inject({ method: "POST", url, headers: { "x-ai-webhook-secret": WEBHOOK_SECRET }, payload: wa })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers: { "x-ai-wa-secret": WA_SECRET }, payload: wa })).statusCode).toBe(401);
    const ok = await app.inject({
      method: "POST",
      url,
      headers: { "x-ai-webhook-secret": WEBHOOK_SECRET, "x-ai-wa-secret": WA_SECRET, "x-ai-wa-caller-id": "34600111222" },
      payload: wa,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ outcome: "recado_queued" });
  });

  it("49. without WA_SELF_SERVICE_SECRET the WhatsApp route does not exist", async () => {
    stateDir = recadosEnv({ WA_SELF_SERVICE_SECRET: "" });
    app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/ai/wa/recado", headers: { "x-ai-webhook-secret": WEBHOOK_SECRET }, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("50. a burst of 40 requests to the Telegram webhook never gets a 429", async () => {
    stateDir = recadosEnv({ RATE_LIMIT_MAX: "5" });
    app = await buildTestApp();
    const codes: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/telegram/recados",
        headers: { "x-telegram-bot-api-secret-token": TG_SECRET },
        payload: { update_id: i, message: { text: "hola", chat: { id: 1 } } },
      });
      codes.push(res.statusCode);
    }
    expect(codes.every((c) => c === 200)).toBe(true);
  });
});
