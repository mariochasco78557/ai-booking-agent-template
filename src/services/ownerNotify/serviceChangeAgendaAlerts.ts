import type { ServiceChangeAlertPort, ServiceChangeNotice } from "../waSelfService/serviceChange.js";
import type { OwnerNotifier } from "./ownerNotifier.js";

/**
 * Wraps the `ServiceChangeAlerts` of d03c78f ((internal doc, not included in the template) §2.6 bis).
 * `service_changed` becomes a one-line agenda notice (gate + digest) INSTEAD of
 * the immediate sentence; if it cannot be queued, the sentence goes as before.
 * Urgent notices are never held. Never throws.
 */
export class ServiceChangeAgendaAlerts implements ServiceChangeAlertPort {
  constructor(
    private readonly base: ServiceChangeAlertPort,
    private readonly owner: Pick<OwnerNotifier, "enqueueServiceChanged">,
  ) {}

  info(n: ServiceChangeNotice, nowMs: number): void {
    let queued = false;
    try {
      queued = n.kind === "service_changed" && this.owner.enqueueServiceChanged(n, nowMs);
    } catch {
      queued = false;
    }
    if (!queued) this.base.info(n, nowMs);
  }

  urgent(n: ServiceChangeNotice, nowMs: number): void {
    this.base.urgent(n, nowMs);
  }
}
