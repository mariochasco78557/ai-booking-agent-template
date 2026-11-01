import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServiceChangeAgendaAlerts } from "../src/services/ownerNotify/serviceChangeAgendaAlerts.js";
import { OwnerNotifier } from "../src/services/ownerNotify/ownerNotifier.js";
import { FileOwnerNotifyQueueStore } from "../src/services/ownerNotify/ownerNotifyQueueStore.js";
import type { ServiceChangeNotice } from "../src/services/waSelfService/serviceChange.js";

const NOW = Date.parse("2031-03-04T09:00:00Z");
const notice = (kind: ServiceChangeNotice["kind"]): ServiceChangeNotice => ({
  kind,
  startsAt: "2031-03-08 13:30",
  professional: "Ramón García",
  fromType: 2,
  toType: 1,
  ownerName: "IA - Iker",
  ownerSurnames: "Cano",
  phoneE164: "+34600000009",
  via: "whatsapp",
});

function fakes(enqueue: () => boolean) {
  const base = { info: vi.fn(), urgent: vi.fn() };
  const owner = { enqueueServiceChanged: vi.fn(enqueue) };
  return { base, owner, alerts: new ServiceChangeAgendaAlerts(base, owner) };
}

describe("ServiceChangeAgendaAlerts", () => {
  it("26a. service_changed queued -> no duplicate sentence", () => {
    const { base, owner, alerts } = fakes(() => true);
    alerts.info(notice("service_changed"), NOW);
    expect(owner.enqueueServiceChanged).toHaveBeenCalledTimes(1);
    expect(base.info).not.toHaveBeenCalled();
  });

  it("26b. not queued (false or throws) -> the usual sentence once", () => {
    const a = fakes(() => false);
    a.alerts.info(notice("service_changed"), NOW);
    expect(a.base.info).toHaveBeenCalledTimes(1);
    const b = fakes(() => {
      throw new Error("x");
    });
    b.alerts.info(notice("service_changed"), NOW);
    expect(b.base.info).toHaveBeenCalledTimes(1);
  });

  it("26c. service_not_changed -> info only; lost and uncertain -> urgent only", () => {
    const { base, owner, alerts } = fakes(() => true);
    alerts.info(notice("service_not_changed"), NOW);
    alerts.urgent(notice("service_change_lost"), NOW);
    alerts.urgent(notice("uncertain"), NOW);
    expect(owner.enqueueServiceChanged).not.toHaveBeenCalled();
    expect(base.info).toHaveBeenCalledTimes(1);
    expect(base.urgent).toHaveBeenCalledTimes(2);
  });
});

describe("OwnerNotifier.enqueueServiceChanged", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "svc-agenda-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("26d. the same notice twice is one job, with no phone in the event", () => {
    const store = new FileOwnerNotifyQueueStore(join(dir, "q.jsonl"), NOW);
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const n = new OwnerNotifier({ mode: "dry_run", chatId: "1" }, store, undefined, logger, { isOpenAt: () => false }, {
      namePrefix: "IA -",
      countDay: async () => 1,
    });
    expect(n.enqueueServiceChanged(notice("service_changed"), NOW)).toBe(true);
    expect(n.enqueueServiceChanged(notice("service_changed"), NOW + 1)).toBe(true);
    expect(n.enqueueServiceChanged(notice("service_not_changed"), NOW)).toBe(false);
    const jobs = store.all().filter((j) => j.kind === "agenda_service");
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]!.event)).not.toMatch(/600000009|\d{9}/);
    expect(jobs[0]!.event).toMatchObject({ type: "service", customer: "Iker C.", professional: "Ramón", fromService: 2, toService: 1 });
  });
});
