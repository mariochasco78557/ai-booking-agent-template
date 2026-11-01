import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nock from "nock";

import {
  FileWhatsAppQueueStore,
  whatsappJobKey,
  type WhatsAppJob,
} from "../src/services/whatsapp/whatsappQueueStore.js";
import {
  buildConfirmationParameters,
  greetingName,
  WHATSAPP_TEAM_FALLBACK,
} from "../src/services/whatsapp/whatsappTemplate.js";
import {
  GRAPH_API_BASE_URL,
  MetaWhatsAppClient,
} from "../src/services/whatsapp/metaWhatsappClient.js";
import {
  createWhatsAppNotifier,
  recipientDigits,
} from "../src/services/whatsapp/whatsappNotifier.js";
import { MemoryEmployeeNameDirectory } from "../src/services/employeeNameDirectory.js";

/**
 * Unit level for the WhatsApp confirmation (`src/services/whatsapp/`).
 *
 * The queue, the template and the Graph client are tested apart from the
 * booking path on purpose: each one has exactly one job, and the property that
 * matters most about all three — that none of them can ever reach back into a
 * booking — is asserted end to end in `tests/whatsappConfirmation.test.ts`.
 */

const PHONE_NUMBER_ID = "1234567890";
const CALENDAR_SECRET = "calendar-link-secret-for-tests-0123456789";

function job(overrides: Partial<WhatsAppJob> = {}): WhatsAppJob {
  const reservationId = overrides.reservationId ?? 90_001;
  // `createdAt` is "now" so the retention rule (a finished job ages out of the
  // file after a week) is not accidentally under test in every case.
  const createdAt = Date.now();
  return {
    id: whatsappJobKey({ kind: "confirmation", reservationId }),
    kind: "confirmation",
    reservationId,
    conversationId: "conv_test_unit",
    to: "34600000123",
    customerName: "Carlos",
    professionalName: "Bruno",
    startsAtIso: "2026-09-25T10:30:00",
    createdAt,
    status: "pending",
    attempts: 0,
    nextAttemptAt: createdAt,
    lastError: null,
    providerMessageId: null,
    sentAt: null,
    ...overrides,
  };
}

describe("whatsapp queue store", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "demo-salon-wa-store-"));
    path = join(dir, "whatsapp-queue.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one durable line per write and replays it into a new store", () => {
    const store = new FileWhatsAppQueueStore(path, Date.now());
    expect(store.enqueue(job())).toBe(true);
    store.update({ ...job(), status: "sent", providerMessageId: "wamid.1", sentAt: 1 });

    const reopened = new FileWhatsAppQueueStore(path, Date.now());
    const stored = reopened.get(whatsappJobKey({ kind: "confirmation", reservationId: 90_001 }));
    expect(stored?.status).toBe("sent");
    expect(stored?.providerMessageId).toBe("wamid.1");
    // Compaction at construction: the two transitions collapse to one line.
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("keeps ONE job per reservation and kind, and never re-queues the same appointment", () => {
    const store = new FileWhatsAppQueueStore(path, Date.now());
    expect(store.enqueue(job())).toBe(true);
    expect(store.enqueue(job({ customerName: "Otro" }))).toBe(false);
    expect(store.all()).toHaveLength(1);
    expect(store.get(whatsappJobKey({ kind: "confirmation", reservationId: 90_001 }))?.customerName)
      .toBe("Carlos");
    // A different appointment is a different job.
    expect(store.enqueue(job({ reservationId: 90_002 }))).toBe(true);
    expect(store.all()).toHaveLength(2);
  });

  it("tolerates a truncated final line — the shape of a crash mid-append", () => {
    const good = JSON.stringify({ v: 1, job: job() });
    writeFileSync(path, `${good}\n{"v":1,"job":{"id":"confirm`, { mode: 0o600 });

    const warnings: Array<Record<string, number>> = [];
    const store = new FileWhatsAppQueueStore(path, Date.now(), (_message, detail) => {
      warnings.push(detail);
    });

    expect(store.all()).toHaveLength(1);
    expect(warnings).toEqual([{ skipped: 1 }]);
  });

  it("only hands the worker pending jobs whose backoff has elapsed", () => {
    const store = new FileWhatsAppQueueStore(path, Date.now());
    store.enqueue(job({ reservationId: 1, nextAttemptAt: 1_000 }));
    store.enqueue(job({ reservationId: 2, nextAttemptAt: 9_000 }));
    store.enqueue(job({ reservationId: 3, nextAttemptAt: 0, status: "sent" }));

    expect(store.due(5_000).map((entry) => entry.reservationId)).toEqual([1]);
    expect(store.due(10_000).map((entry) => entry.reservationId)).toEqual([1, 2]);
  });
});

describe("whatsapp template", () => {
  it("greets with the first name only, capitalized", () => {
    expect(greetingName("carlos")).toBe("Carlos");
    expect(greetingName("  Carlos García Pérez ")).toBe("Carlos");
    expect(greetingName("CARLOS")).toBe("Carlos");
    expect(greetingName("McCarthy")).toBe("McCarthy");
  });

  it("spells the date and the hour in Spanish, from the wall clock and nothing else", () => {
    const parameters = buildConfirmationParameters(job());
    expect(parameters).toEqual([
      { type: "text", parameter_name: "nombre", text: "Carlos" },
      { type: "text", parameter_name: "fecha", text: "viernes 25 de septiembre" },
      { type: "text", parameter_name: "hora", text: "10:30" },
      { type: "text", parameter_name: "profesional", text: "Bruno" },
    ]);
  });

  it("names the team when the professional is unknown", () => {
    const parameters = buildConfirmationParameters(job({ professionalName: null }));
    expect(parameters[3]).toEqual({
      type: "text",
      parameter_name: "profesional",
      text: WHATSAPP_TEAM_FALLBACK,
    });
  });
});

describe("meta whatsapp client", () => {
  const client = new MetaWhatsAppClient({
    accessToken: "not-a-real-token",
    phoneNumberId: PHONE_NUMBER_ID,
    graphApiVersion: "v25.0",
    templateName: "cita_confirmada_demo_salon",
    templateLanguage: "es",
    sendTimeoutMs: 50,
  });

  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it("sends the template Meta documents and returns the message id", async () => {
    let sent: Record<string, unknown> | undefined;
    nock(GRAPH_API_BASE_URL)
      .post(`/v25.0/${PHONE_NUMBER_ID}/messages`, (body: Record<string, unknown>) => {
        sent = body;
        return true;
      })
      .matchHeader("authorization", "Bearer not-a-real-token")
      .reply(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: "34600000123", wa_id: "34600000123" }],
        messages: [{ id: "wamid.HBgLM" }],
      });

    const result = await client.send("34600000123", buildConfirmationParameters(job()));

    expect(result).toEqual({ ok: true, messageId: "wamid.HBgLM" });
    expect(sent).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "34600000123",
      type: "template",
      template: {
        name: "cita_confirmada_demo_salon",
        language: { code: "es" },
      },
    });
  });

  it("does NOT retry a 4xx: the same message would earn the same refusal", async () => {
    nock(GRAPH_API_BASE_URL)
      .post(`/v25.0/${PHONE_NUMBER_ID}/messages`)
      .reply(400, {
        error: {
          message: "(#131026) Message undeliverable",
          code: 131026,
          error_subcode: 2655007,
        },
      });

    const result = await client.send("34600000123", buildConfirmationParameters(job()));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("http_400");
    expect(result.error).toContain("code=131026");
  });

  it("retries a 429 and a 5xx: neither says anything about the message", async () => {
    nock(GRAPH_API_BASE_URL)
      .post(`/v25.0/${PHONE_NUMBER_ID}/messages`)
      .reply(429, { error: { message: "rate limit", code: 130_429 } });
    const throttled = await client.send("34600000123", buildConfirmationParameters(job()));
    expect(throttled).toMatchObject({ ok: false, retryable: true });

    nock(GRAPH_API_BASE_URL)
      .post(`/v25.0/${PHONE_NUMBER_ID}/messages`)
      .reply(503, {});
    const unavailable = await client.send("34600000123", buildConfirmationParameters(job()));
    expect(unavailable).toMatchObject({ ok: false, retryable: true });
  });

  it("treats a timeout as retryable and never as a failure of the appointment", async () => {
    nock(GRAPH_API_BASE_URL)
      .post(`/v25.0/${PHONE_NUMBER_ID}/messages`)
      .delay(200)
      .reply(200, { messages: [{ id: "wamid.late" }] });

    const result = await client.send("34600000123", buildConfirmationParameters(job()));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("no_response");
  });
});

describe("whatsapp worker · retries", () => {
  let dir: string;
  let path: string;
  const silent = { info() {}, warn() {}, error() {}, debug() {} };

  beforeEach(() => {
    nock.cleanAll();
    dir = mkdtempSync(join(tmpdir(), "demo-salon-wa-worker-"));
    path = join(dir, "whatsapp-queue.jsonl");
  });

  afterEach(() => {
    nock.cleanAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backs off after a retryable failure and gives up after five attempts", async () => {
    nock(GRAPH_API_BASE_URL)
      .persist()
      .post(`/v25.0/${PHONE_NUMBER_ID}/messages`)
      .reply(503, {});

    const notifier = createWhatsAppNotifier({
      mode: "live",
      queuePath: path,
      accessToken: "not-a-real-token",
      phoneNumberId: PHONE_NUMBER_ID,
      templateName: "cita_confirmada_demo_salon",
      templateLanguage: "es",
      graphApiVersion: "v25.0",
      sendTimeoutMs: 500,
      calendarLinkSecret: CALENDAR_SECRET,
      calendarBaseUrl: "https://api.booking.example.com",
      logger: silent,
    })!;
    expect(notifier).toBeDefined();
    // The worker is never started here: `drain` is the same sweep, run on a
    // clock this test controls instead of on a 5 s interval.
    expect(notifier.enqueueConfirmation(
      {
        reservationId: 90_001,
        conversationId: "conv_test_backoff",
        phone: "600000123",
        customerName: "Carlos",
        reservationDate: "2026-09-25 10:30:00",
        employeeId: 1,
      },
      Date.now(),
    )).toBe("queued");

    const key = whatsappJobKey({ kind: "confirmation", reservationId: 90_001 });
    let now = Date.now();
    for (const [index, expectedBackoff] of [30_000, 120_000, 600_000, 1_800_000].entries()) {
      await notifier.drain(now);
      const pending = notifier.queue.get(key)!;
      expect(pending.status).toBe("pending");
      expect(pending.attempts).toBe(index + 1);
      expect(pending.lastError).toContain("http_503");
      // Roughly, because the deadline is computed from the wall clock at the
      // moment of the failure; what is under test is the STEP, not the ms.
      expect(pending.nextAttemptAt - Date.now()).toBeGreaterThan(expectedBackoff - 5_000);
      now = pending.nextAttemptAt + 1;
    }

    await notifier.drain(now);
    const exhausted = notifier.queue.get(key)!;
    expect(exhausted.status).toBe("failed");
    expect(exhausted.attempts).toBe(5);

    // And a failed job is never picked up again.
    await notifier.drain(now + 10_000_000);
    expect(notifier.queue.get(key)?.attempts).toBe(5);
    await notifier.stop();
  });

  it("only the enqueue that actually queues a NEW job may answer `queued`", async () => {
    nock(GRAPH_API_BASE_URL)
      .persist()
      .post(`/v25.0/${PHONE_NUMBER_ID}/messages`)
      .reply(200, { messages: [{ id: "wamid.dup" }] });

    const notifier = createWhatsAppNotifier({
      mode: "live",
      queuePath: path,
      accessToken: "not-a-real-token",
      phoneNumberId: PHONE_NUMBER_ID,
      templateName: "cita_confirmada_demo_salon",
      templateLanguage: "es",
      graphApiVersion: "v25.0",
      sendTimeoutMs: 500,
      calendarLinkSecret: CALENDAR_SECRET,
      calendarBaseUrl: "https://api.booking.example.com",
      logger: silent,
    })!;
    expect(notifier).toBeDefined();

    const input = {
      reservationId: 90_010,
      conversationId: "conv_test_dup",
      phone: "600000123",
      customerName: "Carlos",
      reservationDate: "2026-09-25 10:30:00",
      employeeId: 1,
    };

    expect(notifier.enqueueConfirmation(input, Date.now())).toBe("queued");
    // Same appointment again: a job for it already existed
    // (`store.enqueue` returns `false`), so this second call queued nothing
    // new and must not tell the agent it did.
    expect(notifier.enqueueConfirmation(input, Date.now())).toBeUndefined();
    expect(notifier.queue.all()).toHaveLength(1);

    await notifier.drain();
    await notifier.stop();
  });
});

describe("recipient and employee-name helpers", () => {
  it("turns a Spanish phone into Meta's shape, or refuses it", () => {
    expect(recipientDigits("600000123")).toBe("34600000123");
    expect(recipientDigits("+34600000123")).toBe("34600000123");
    expect(recipientDigits("600 000 123")).toBe("34600000123");
    expect(recipientDigits("12345")).toBeUndefined();
  });

  it("remembers a barber's name as a person would say it", () => {
    const directory = new MemoryEmployeeNameDirectory();
    directory.record(1, "bruno ");
    directory.record(2, "  olga  ");
    directory.record(7, "   ");
    expect(directory.nameOf(1)).toBe("Bruno");
    expect(directory.nameOf(2)).toBe("Olga");
    expect(directory.nameOf(7)).toBeUndefined();
    expect(directory.nameOf(999)).toBeUndefined();
  });
});
