import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { testEnv } from "../helpers/testApp.js";

describe("36. recadosTelegram avisos-estado", () => {
  it("does not modify the queue file and prints only numbers", () => {
    const dir = mkdtempSync(join(tmpdir(), "avisos-estado-"));
    try {
      const file = join(dir, "owner.jsonl");
      const job = { id: "agenda_rid:1", kind: "agenda_cancelled", text: "", status: "pending", attempts: 0, nextAttemptAt: 1, createdAt: 1, event: { type: "cancelled", customer: "Mikel A." } };
      writeFileSync(file, `${JSON.stringify({ v: 1, job })}\n{roto\n`);
      testEnv({ TELEGRAM_QUEUE_PATH: file });
      const before = readFileSync(file);
      const mtime = statSync(file).mtimeMs;
      const run = spawnSync("npx", ["tsx", "src/cli/recadosTelegram.ts", "avisos-estado"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env },
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("agenda_cancelled/pending");
      expect(run.stdout).not.toContain("Mikel");
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(statSync(file).mtimeMs).toBe(mtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
