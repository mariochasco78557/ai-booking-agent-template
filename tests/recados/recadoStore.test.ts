import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileRecadoStore, RECADO_RETENTION_MS } from "../../src/services/recados/recadoStore.js";
import { at, recado, TUE } from "./helpers.js";

let dir: string;
let path: string;
const NOW = at(TUE, "10:00");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recados-store-"));
  path = join(dir, "state", "recados.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FileRecadoStore", () => {
  it("20. duplicate insert → false; the last line wins after a reload; compaction keeps one line per recado", () => {
    const s = new FileRecadoStore(path, NOW);
    expect(s.insert(recado())).toBe(true);
    expect(s.insert(recado({ summary: "otro" }))).toBe(false);
    s.update(recado({ delivery: "sent", messageId: 9 }));
    s.update(recado({ delivery: "sent", messageId: 10 }));
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);

    const again = new FileRecadoStore(path, NOW);
    expect(again.get("aaaaaaaaaaaa")?.messageId).toBe(10);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("20. 30-day retention drops finished recados but never held/pending", () => {
    const old = NOW - RECADO_RETENTION_MS - 1000;
    const s = new FileRecadoStore(path, NOW);
    s.insert(recado({ id: "sent00000000", createdAt: old, delivery: "sent" }));
    s.insert(recado({ id: "held00000000", createdAt: old, delivery: "held" }));
    s.insert(recado({ id: "pend00000000", createdAt: old, delivery: "pending" }));
    const again = new FileRecadoStore(path, NOW);
    expect(again.get("sent00000000")).toBeUndefined();
    expect(again.get("held00000000")).toBeDefined();
    expect(again.get("pend00000000")).toBeDefined();
  });

  it("20. directory 0700 and file 0600", () => {
    new FileRecadoStore(path, NOW);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("20. countSince by phone hash; summaryDone survives a restart", () => {
    const s = new FileRecadoStore(path, NOW);
    s.insert(recado({ id: "a00000000000", phoneHash: "h1", createdAt: NOW - 30 * 60_000 }));
    s.insert(recado({ id: "b00000000000", phoneHash: "h1", createdAt: NOW - 90 * 60_000 }));
    s.insert(recado({ id: "c00000000000", phoneHash: "h2", createdAt: NOW - 10 * 60_000 }));
    expect(s.countSince(NOW - 3_600_000)).toBe(2);
    expect(s.countSince(NOW - 3_600_000, "h1")).toBe(1);
    expect(s.countSince(NOW - 7_200_000, "h1")).toBe(2);
    expect(s.summaryDone(TUE)).toBe(false);
    s.markSummary(TUE, NOW, 2);
    expect(new FileRecadoStore(path, NOW).summaryDone(TUE)).toBe(true);
  });

  it("counts unreadable lines and warns WITHOUT their content", () => {
    new FileRecadoStore(path, NOW);
    writeFileSync(path, `{"v":1,"recado":{"summary":"SECRETO-DEL-CLIENTE"}}\nnot json SECRETO\n`);
    const warnings: Array<[string, Record<string, number>]> = [];
    const s = new FileRecadoStore(path, NOW, (m, d) => warnings.push([m, d]));
    expect(s.all()).toHaveLength(0);
    expect(warnings).toEqual([["recados store: skipped unreadable lines", { skipped: 2 }]]);
    expect(JSON.stringify(warnings)).not.toContain("SECRETO");
  });

  it("finds a recado written by another process (the CLI test notice) on a miss", () => {
    const server = new FileRecadoStore(path, NOW);
    const cli = new FileRecadoStore(path, NOW, () => {}, { compact: false });
    cli.insert(recado({ id: "cli000000000", delivery: "sent", messageId: 5 }));
    expect(server.get("cli000000000")?.messageId).toBe(5);
  });
});
