import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testEnv } from "./helpers/testApp.js";
import { loadEnv, resetEnvCache } from "../src/config/env.js";
import { createServices } from "../src/services/container.js";
import { formatCancellationMessage } from "../src/services/ownerNotify/ownerMessages.js";

let dir: string | undefined;
afterEach(() => {
  resetEnvCache();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("35. TELEGRAM_NOTIFY_AGENDA_LINES=true with RECADOS_MODE=off", () => {
  it("boots, logs an error, and cancellations keep the old text", () => {
    dir = mkdtempSync(join(tmpdir(), "avisos-container-"));
    testEnv({
      TELEGRAM_NOTIFY_AGENDA_LINES: "true",
      TELEGRAM_NOTIFY_MODE: "dry_run",
      TELEGRAM_QUEUE_PATH: join(dir, "owner.jsonl"),
      RECADOS_MODE: "off",
      WA_SELF_SERVICE_MODE: "lookup_only",
      WA_SELF_SERVICE_SECRET: "wa-self-service-secret-0123456789abcdef",
      WA_REF_SECRET: "wa-ref-secret-0123456789abcdefghijklmn",
      BOOKING_EMPLOYEE_USERNAME: "asistente-ia",
      BOOKING_EMPLOYEE_PASSWORD: "not-a-real-password",
    });
    const errors: string[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: (_o: unknown, msg?: string) => {
        errors.push(String(msg ?? _o));
      },
    };
    const services = createServices(loadEnv(), logger);
    expect(errors.some((m) => m.includes("owner agenda lines DISABLED"))).toBe(true);
    expect(services.agendaBookings).toBeUndefined();
    const notifier = services.ownerNotifier!;
    expect(notifier).toBeDefined();
    const c = {
      kind: "cancellation_done" as const,
      reservationId: 77,
      startsAt: "2031-03-04 17:30",
      professional: "Bruno",
      service: null,
      ownerName: "Ana",
      ownerSurnames: "Prueba",
      callerPhoneE164: "+34600000001",
    };
    notifier.enqueueCancellation(c, Date.parse("2031-03-04T09:00:00Z"));
    const job = notifier.queue.get("cancellation_done:77")!;
    expect(job.text).toBe(formatCancellationMessage(c));
    expect(notifier.queue.get("agenda_rid:77")).toBeUndefined();
  });
});
