// NOTE: must not live in a directory named "tools": deploy/vps/sync-from-mac.sh excludes every dir called tools (rsync --exclude=tools).
import { readFileSync } from "node:fs";
import { loadEnv } from "../config/env.js";
import { OpeningHoursGate, REFRESH_DAYS } from "../services/recados/openingHoursGate.js";
import { formatRecadoMessage, recadoKeyboard } from "../services/recados/recadoMessages.js";
import { FileRecadoStore } from "../services/recados/recadoStore.js";
import { recadoIdOf, phoneHashOf, type Recado } from "../services/recados/recadoTypes.js";
import { RECADOS_WEBHOOK_PATH } from "../services/recados/telegramUpdates.js";
import { TelegramClient } from "../services/ownerNotify/telegramClient.js";
import { formatDigest } from "../services/ownerNotify/agendaLines.js";
import { madridDate } from "../utils/madridDate.js";

/**
 * Operator CLI for the recados bot ((internal doc, not included in the template) §A.9).
 * Runs INSIDE the container with its environment:
 *
 *   docker exec demo-salon-middleware node dist/cli/recadosTelegram.js <orden>
 *
 * Orders: info | set [--usuario <nombre>] | delete | horario | prueba | estado.
 * It never prints the token, the webhook secret or the chat id.
 */

const EXPECTED_BOT = "citas_demo_salon_bot";
const WEBHOOK_URL = `https://api.booking.example.com${RECADOS_WEBHOOK_PATH}`;
const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

const silentLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
};

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

async function info(client: TelegramClient): Promise<void> {
  const me = await client.callMethod("getMe", {});
  if (!me.ok) fail(`getMe: ${me.error}`);
  out(`bot: ${String((me.result as { username?: unknown })?.username ?? "?")}`);
  const wh = await client.callMethod("getWebhookInfo", {});
  if (!wh.ok) fail(`getWebhookInfo: ${wh.error}`);
  const w = (wh.result ?? {}) as Record<string, unknown>;
  out(`url: ${String(w.url ?? "") || "(sin webhook)"}`);
  out(`pending_update_count: ${String(w.pending_update_count ?? 0)}`);
  out(`last_error_date: ${w.last_error_date !== undefined ? new Date(Number(w.last_error_date) * 1000).toISOString() : "(ninguno)"}`);
  out(`last_error_message: ${String(w.last_error_message ?? "(ninguno)")}`);
  out(`allowed_updates: ${JSON.stringify(w.allowed_updates ?? [])}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined) fail("uso: recadosTelegram <info|set|delete|horario|prueba|estado>");
  const env = loadEnv();

  if (command === "horario") {
    if (env.RECADOS_STATE_DIR === undefined) fail("RECADOS_STATE_DIR no está definida");
    const gate = new OpeningHoursGate({
      reader: { read: () => Promise.reject(new Error("read-only")) },
      serviceId: env.RECADOS_HOURS_SERVICE_ID,
      appointmentMinutes: env.RECADOS_APPOINTMENT_MINUTES,
      statePath: `${env.RECADOS_STATE_DIR}/horario.json`,
      logger: silentLogger,
    });
    const now = Date.now();
    gate.load(now);
    const today = madridDate(now);
    for (let i = 0; i < REFRESH_DAYS; i += 1) {
      const date = new Date(Date.parse(`${today}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      const w = gate.windowFor(date);
      const day = DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
      out(`${date} ${day} ${w.open ? "abierto" : "cerrado"} ${w.open ? `${hhmm(w.startMin)}–${hhmm(w.endMin)}` : "-"} ${w.source}`);
    }
    return;
  }

  if (command === "estado") {
    if (env.RECADOS_STATE_DIR === undefined) fail("RECADOS_STATE_DIR no está definida");
    const store = new FileRecadoStore(`${env.RECADOS_STATE_DIR}/recados.jsonl`, Date.now(), () => {}, { compact: false });
    const byDelivery: Record<string, number> = {};
    const byAppointment: Record<string, number> = {};
    for (const r of store.all()) {
      byDelivery[r.delivery] = (byDelivery[r.delivery] ?? 0) + 1;
      byAppointment[r.appointment.status] = (byAppointment[r.appointment.status] ?? 0) + 1;
    }
    out(`recados: ${store.all().length}`);
    out(`delivery: ${JSON.stringify(byDelivery)}`);
    out(`appointment: ${JSON.stringify(byAppointment)}`);
    return;
  }

  if (command === "avisos-estado") {
    // Reads the file line by line. NEVER opens FileOwnerNotifyQueueStore: its constructor compacts the file and would race the running process.
    if (env.TELEGRAM_QUEUE_PATH === undefined) fail("TELEGRAM_QUEUE_PATH no está definida");
    let raw = "";
    try {
      raw = readFileSync(env.TELEGRAM_QUEUE_PATH, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("no se puede leer la cola");
    }
    const latest = new Map<string, { kind?: string; status?: string; sentAt?: number | null }>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const job = (JSON.parse(line) as { job?: { id?: unknown; kind?: string; status?: string; sentAt?: number | null } }).job;
        if (typeof job?.id === "string") latest.set(job.id, job);
      } catch {
        // unreadable line: skipped
      }
    }
    const byKind: Record<string, number> = {};
    for (const job of latest.values()) {
      const key = `${job.kind ?? "?"}/${job.status ?? "?"}`;
      byKind[key] = (byKind[key] ?? 0) + 1;
    }
    const today = madridDate(Date.now());
    const digest = latest.get(`agenda_digest:${today}`);
    const lastDigestAt = [...latest.entries()]
      .filter(([id, j]) => id.startsWith("agenda_digest:") && typeof j.sentAt === "number")
      .map(([, j]) => j.sentAt as number)
      .sort((a, b) => b - a)[0];
    out(`trabajos: ${latest.size}`);
    out(`kind/status: ${JSON.stringify(byKind)}`);
    out(`resumen hoy: ${digest === undefined ? "no" : `sí (${digest.status ?? "?"})`}`);
    out(`último resumen: ${lastDigestAt === undefined ? "(ninguno)" : new Date(lastDigestAt).toISOString()}`);
    return;
  }

  if (env.RECADOS_BOT_TOKEN === undefined) fail("RECADOS_BOT_TOKEN no está definida");
  const client = new TelegramClient({ botToken: env.RECADOS_BOT_TOKEN, sendTimeoutMs: env.TELEGRAM_SEND_TIMEOUT_MS });

  if (command === "info") return info(client);

  if (command === "set") {
    if (env.RECADOS_WEBHOOK_SECRET === undefined) fail("RECADOS_WEBHOOK_SECRET no está definida");
    const flag = rest.indexOf("--usuario");
    const expected = flag >= 0 ? (rest[flag + 1] ?? fail("--usuario necesita un nombre")) : EXPECTED_BOT;
    const me = await client.callMethod("getMe", {});
    if (!me.ok) fail(`getMe: ${me.error}`);
    const username = (me.result as { username?: unknown })?.username;
    if (username !== expected) {
      // The night-improvement watchdog reads replies with getUpdates: a webhook on ITS token would break it (409).
      fail(`abortado: el bot de este token no es ${expected}`);
    }
    const set = await client.callMethod("setWebhook", {
      url: WEBHOOK_URL,
      secret_token: env.RECADOS_WEBHOOK_SECRET,
      allowed_updates: ["callback_query", "message"],
      drop_pending_updates: true,
      max_connections: 5,
    });
    if (!set.ok) fail(`setWebhook: ${set.error}`);
    out("webhook registrado");
    return info(client);
  }

  if (command === "delete") {
    const del = await client.callMethod("deleteWebhook", { drop_pending_updates: false });
    if (!del.ok) fail(`deleteWebhook: ${del.error}`);
    out("webhook borrado");
    return;
  }

  if (command === "avisos-prueba") {
    if (env.TELEGRAM_NOTIFY_MODE !== "live") fail("avisos-prueba solo funciona con TELEGRAM_NOTIFY_MODE=live");
    if (env.RECADOS_CHAT_ID === undefined) fail("falta RECADOS_CHAT_ID");
    const now = Date.now();
    const text = formatDigest(
      {
        date: madridDate(now),
        count: 14,
        lines: [
          {
            type: "changed",
            fromStartsAt: `${madridDate(now + 3 * 86_400_000)} 13:30`,
            toStartsAt: `${madridDate(now)} 10:00`,
            fromProfessional: "Ramón",
            toProfessional: "Ramón",
            customer: "Iker C.",
            channel: "whatsapp",
          },
          {
            type: "cancelled",
            startsAt: `${madridDate(now)} 17:30`,
            professional: "Olga",
            customer: "Mikel A.",
            noticeMinutes: 2 * 1440,
            lateNotice: false,
            channel: "voice",
          },
        ],
        booked: { whatsapp: 2, voice: 1 },
      },
      now,
    );
    // Outside the queue and the gate, on purpose.
    const sent = await client.sendMessage({ chatId: env.RECADOS_CHAT_ID, text: `[PRUEBA] ${text}`, disableNotification: false });
    if (!sent.ok) fail(`envío: ${sent.error}`);
    out("resumen de prueba enviado");
    return;
  }

  if (command === "prueba") {
    if (env.RECADOS_MODE !== "live") fail("prueba solo funciona con RECADOS_MODE=live");
    if (env.RECADOS_STATE_DIR === undefined || env.RECADOS_CHAT_ID === undefined) fail("falta RECADOS_STATE_DIR o RECADOS_CHAT_ID");
    const store = new FileRecadoStore(`${env.RECADOS_STATE_DIR}/recados.jsonl`, Date.now(), () => {}, { compact: false });
    const now = Date.now();
    const dedupeKey = `prueba:${now}`;
    const base: Recado = {
      id: recadoIdOf(dedupeKey),
      dedupeKey,
      kind: "question",
      channel: "whatsapp",
      createdAt: now,
      summary: "Mensaje de prueba del sistema de recados.",
      minutesLate: null,
      customerName: "Prueba",
      phoneE164: "+34600000000",
      phoneSource: "whatsapp",
      phoneHash: phoneHashOf("+34600000000"),
      voceroConversationId: null,
      appointment: { status: "none" },
      heldAtCreation: false,
      delivery: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      messageId: null,
      sentAt: null,
      handledAt: null,
      reminderMessageId: null,
      remindedAt: null,
      reminderAttempts: 0,
    };
    store.insert(base);
    // Deliberately NOT through the gate.
    const sent = await client.sendMessage({
      chatId: env.RECADOS_CHAT_ID,
      text: formatRecadoMessage(base, now),
      disableNotification: false,
      inlineKeyboard: recadoKeyboard(base, env.RECADOS_VOCERO_URL_TEMPLATE, false),
    });
    if (!sent.ok) {
      store.update({ ...base, delivery: "failed", lastError: sent.error });
      fail(`envío: ${sent.error}`);
    }
    store.update({ ...base, delivery: "sent", attempts: 1, messageId: sent.messageId, sentAt: now });
    out("aviso de prueba enviado");
    return;
  }

  fail(`orden desconocida: ${command}`);
}

main().catch((error: unknown) => {
  // Never print the error object: it could carry a URL with the token.
  process.stderr.write(`error: ${error instanceof Error ? error.name : "desconocido"}\n`);
  process.exit(1);
});
