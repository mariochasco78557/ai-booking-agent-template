import { fullPhraseEs } from "../../utils/dateFormatterEs.js";
import { isQuietHour } from "../ownerNotify/ownerNotifier.js";
import type { TelegramClient } from "../ownerNotify/telegramClient.js";
import type { Logger } from "../authTokenService.js";
import { serviceLabelOf } from "../whatsapp/whatsappNotifier.js";
import type { ServiceChangeAlertPort, ServiceChangeNotice } from "../waSelfService/serviceChange.js";

/**
 * 2026-10-11 ((internal doc, not included in the template) §2.2 pasos 9-10) — the
 * notices of a service change, sent through the RECADOS bot (the one already
 * in production): this is NOT `TELEGRAM_NOTIFY_MODE` and it does NOT go through
 * the recados opening-hours gate.
 *
 * - `info` (service changed / restored): sent at once; between 21:00 and 08:00
 *   it arrives without sound.
 * - `urgent` (`service_change_lost` / `uncertain`): sent AT ONCE, with sound,
 *   at any hour — a customer may have lost an appointment. Retried in the
 *   background (2 s, 10 s, 60 s) and, if every attempt fails, logged as an error.
 *
 * Fire and forget: `info` / `urgent` never throw and never wait for the
 * network. Text holds a name and a phone ON PURPOSE (for the owner); the logs
 * carry only kind, mode and attempt count.
 */

export interface ServiceChangeAlertsOptions {
  /** `RECADOS_MODE` (off = no alerts object at all). */
  mode: "dry_run" | "live";
  client?: Pick<TelegramClient, "sendMessage">;
  chatId: string;
  logger: Logger;
  /** Delays between urgent retries (tests inject zeros). */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 60_000] as const;

function serviceWord(type: number): string {
  return (serviceLabelOf(type) ?? "otro servicio").toLowerCase();
}

function who(n: ServiceChangeNotice): string {
  const name = `${n.ownerName} ${n.ownerSurnames}`.trim();
  return `${name === "" ? "(sin nombre)" : name}, ${n.phoneE164}`;
}

function viaText(n: ServiceChangeNotice): string {
  if (n.via === "whatsapp") return "WhatsApp";
  return n.via === "voice_dictated" ? "llamada (número dictado)" : "llamada";
}

function whenText(n: ServiceChangeNotice): string {
  return `${fullPhraseEs(n.startsAt)}${n.professional ? ` con ${n.professional}` : ""}`;
}

export function formatServiceChangeNotice(n: ServiceChangeNotice): string {
  const swap = `de ${serviceWord(n.fromType)} a ${serviceWord(n.toType)}`;
  switch (n.kind) {
    case "service_changed":
      return `Servicio cambiado por ${viaText(n)}: ${whenText(n)}, ${swap}. Cliente: ${who(n)}.`;
    case "service_not_changed":
      return `No se ha podido cambiar el servicio por ${viaText(n)}; la cita sigue como estaba: ${whenText(n)} (${swap} pedido). Cliente: ${who(n)}.`;
    default:
      return (
        `URGENTE: cita posiblemente PERDIDA al cambiar el servicio por ${viaText(n)}` +
        `${n.kind === "uncertain" ? " (no he podido comprobar la agenda)" : ""}. ` +
        `Revisa la agenda y apúntala a mano si falta: ${whenText(n)}. ` +
        `Servicio antiguo: ${serviceWord(n.fromType)}; servicio nuevo pedido: ${serviceWord(n.toType)}. ` +
        `Cliente: ${who(n)}.`
      );
  }
}

export class ServiceChangeAlerts implements ServiceChangeAlertPort {
  constructor(private readonly options: ServiceChangeAlertsOptions) {}

  info(notice: ServiceChangeNotice, nowMs: number): void {
    this.dispatch(notice, nowMs, false);
  }

  urgent(notice: ServiceChangeNotice, nowMs: number): void {
    this.dispatch(notice, nowMs, true);
  }

  private dispatch(notice: ServiceChangeNotice, nowMs: number, urgent: boolean): void {
    try {
      const { mode, client, logger } = this.options;
      if (mode === "dry_run" || client === undefined) {
        logger.info({ kind: notice.kind, urgent }, "service change notice: DRY RUN, NOT sent");
        return;
      }
      const text = formatServiceChangeNotice(notice);
      void this.send(text, nowMs, urgent, notice.kind).catch(() => undefined);
    } catch {
      this.options.logger.error({ kind: notice.kind, urgent }, "service change notice: could not be dispatched");
    }
  }

  private async send(text: string, nowMs: number, urgent: boolean, kind: string): Promise<void> {
    const { client, chatId, logger } = this.options;
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const attempts = urgent ? delays.length + 1 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await client!.sendMessage({
        chatId,
        text,
        disableNotification: urgent ? false : isQuietHour(nowMs),
      });
      if (result.ok) {
        logger.info({ kind, urgent, attempt }, "service change notice: sent");
        return;
      }
      if (attempt < attempts) {
        const delay = delays[attempt - 1] ?? 0;
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay).unref());
      } else {
        logger.error(
          { kind, urgent, attempts: attempt, reason: result.error },
          "service change notice: NOT delivered",
        );
      }
    }
  }
}
