import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveDayWindow, OpeningHoursGate } from "../../src/services/recados/openingHoursGate.js";
import { FileRecadoStore } from "../../src/services/recados/recadoStore.js";
import { RecadoService } from "../../src/services/recados/recadoService.js";
import { agendaDay, at, fakeReader, makeLogger, MON, SAT, TUE } from "./helpers.js";

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recados-gate-"));
  statePath = join(dir, "horario.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Rows = Array<{ startsAt: string }>;

function makeGate(opts: {
  days: Parameters<typeof fakeReader>[0];
  rows?: Rows | "fail";
}) {
  const { logger, lines } = makeLogger();
  const gate = new OpeningHoursGate({
    reader: fakeReader(opts.days),
    ...(opts.rows === undefined
      ? {}
      : {
          standingRows: async () => {
            if (opts.rows === "fail") throw new Error("panel down");
            return opts.rows as never;
          },
        }),
    serviceId: "1",
    appointmentMinutes: 30,
    statePath,
    logger,
  });
  return { gate, lines };
}

const NOW_MON = at(MON, "10:00");

describe("OpeningHoursGate", () => {
  it("1. Tuesday with 09:30–13:30 and 16:00–20:00 → window 09:30–20:00 from the agenda", async () => {
    const { gate } = makeGate({ days: { [TUE]: agendaDay(TUE, [["09:30", "13:30"], ["16:00", "20:00"]]) }, rows: [] });
    await gate.refresh(NOW_MON);
    expect(gate.windowFor(TUE)).toEqual({ date: TUE, open: true, startMin: 570, endMin: 1200, source: "agenda" });
  });

  it("2. the lunch break counts as open", async () => {
    const { gate } = makeGate({ days: { [TUE]: agendaDay(TUE, [["09:30", "13:30"], ["16:00", "20:00"]]) }, rows: [] });
    await gate.refresh(NOW_MON);
    expect(gate.isOpenAt(at(TUE, "14:30"))).toBe(true);
    expect(gate.isOpenAt(at(TUE, "20:00"))).toBe(false);
    expect(gate.isOpenAt(at(TUE, "09:29"))).toBe(false);
  });

  it("3. last slot booked: free until 19:00 and a booking at 19:30 → end 20:00", async () => {
    const { gate } = makeGate({
      days: { [TUE]: agendaDay(TUE, [["09:30", "19:00"]]) },
      rows: [{ startsAt: `${TUE} 19:30` }],
    });
    await gate.refresh(NOW_MON);
    expect(gate.windowFor(TUE).endMin).toBe(20 * 60);
  });

  it("4. first slot booked: booking at 09:00 and first free at 09:30 → start 09:00", async () => {
    const { gate } = makeGate({
      days: { [TUE]: agendaDay(TUE, [["09:30", "20:00"]]) },
      rows: [{ startsAt: `${TUE} 09:00` }],
    });
    await gate.refresh(NOW_MON);
    expect(gate.windowFor(TUE).startMin).toBe(9 * 60);
  });

  it("5. empty employees-day (holiday) → closed, and a recado of that day stays held", async () => {
    const { gate } = makeGate({ days: { [TUE]: agendaDay(TUE, [], false) }, rows: [] });
    await gate.refresh(NOW_MON);
    expect(gate.windowFor(TUE).open).toBe(false);
    expect(gate.isOpenAt(at(TUE, "11:00"))).toBe(false);

    const { logger } = makeLogger();
    const store = new FileRecadoStore(join(dir, "recados.jsonl"), NOW_MON);
    const service = new RecadoService(
      { mode: "live", maxPerPhonePerHour: 2, maxPerHourGlobal: 30, lookupHorizonDays: 60 },
      store,
      gate,
      undefined,
      logger,
      () => {},
    );
    const res = service.createFromVoice(
      { conversation_id: "conv-holiday-1", caller_phone: "+34600111222", kind: "question", summary: "Consulta" },
      at(TUE, "11:00"),
    );
    expect(res.outcome).toBe("recado_queued");
    expect(store.all()[0]!.delivery).toBe("held");
  });

  it("6. agenda down but a stored entry for that date exists → cache_date is used", async () => {
    const first = makeGate({ days: { [TUE]: agendaDay(TUE, [["09:30", "20:00"]]) }, rows: [] });
    await first.gate.refresh(NOW_MON);
    const second = makeGate({ days: {}, rows: [] });
    second.gate.load(NOW_MON);
    await second.gate.refresh(NOW_MON);
    expect(second.gate.windowFor(TUE)).toMatchObject({ open: true, startMin: 570, endMin: 1200, source: "cache_date" });
  });

  it("7. agenda down, no entry for the date, a weekday template of 7 days ago → cache_weekday", () => {
    writeFileSync(statePath, JSON.stringify({ v: 1, days: {}, weekdays: { "2": { startMin: 570, endMin: 1200, fromDate: "2026-10-06" } } }));
    const { gate } = makeGate({ days: {} });
    gate.load(NOW_MON);
    expect(gate.windowFor(TUE)).toMatchObject({ open: true, startMin: 570, endMin: 1200, source: "cache_weekday" });
  });

  it("8. agenda down with nothing stored → unknown and closed; at 03:00 never open (safety clamp)", () => {
    const { gate } = makeGate({ days: {} });
    gate.load(NOW_MON);
    expect(gate.windowFor(TUE)).toMatchObject({ open: false, source: "unknown" });
    expect(gate.isOpenAt(at(TUE, "11:00"))).toBe(false);

    writeFileSync(statePath, JSON.stringify({ v: 1, days: { [TUE]: { open: true, startMin: 0, endMin: 1439, source: "agenda", fetchedAtMs: 0 } }, weekdays: {} }));
    gate.load(NOW_MON);
    expect(gate.isOpenAt(at(TUE, "03:00"))).toBe(false);
    expect(gate.isOpenAt(at(TUE, "23:00"))).toBe(false);
    expect(gate.isOpenAt(at(TUE, "12:00"))).toBe(true);
  });

  it("9. today only widens: at 15:00 the morning slots are gone but start stays 09:30", async () => {
    const days: Parameters<typeof fakeReader>[0] = { [TUE]: agendaDay(TUE, [["09:30", "20:00"]]) };
    const { gate } = makeGate({ days, rows: [] });
    await gate.refresh(at(TUE, "09:00"));
    days[TUE] = agendaDay(TUE, [["15:30", "20:00"]]);
    await gate.refresh(at(TUE, "15:00"));
    expect(gate.windowFor(TUE)).toMatchObject({ startMin: 570, endMin: 1200 });
    // …but a day the agenda closes wins even today.
    days[TUE] = agendaDay(TUE, [], false);
    await gate.refresh(at(TUE, "15:05"));
    expect(gate.windowFor(TUE).open).toBe(false);
  });

  it("10. a future date that shrinks (Bruno removes the Thursday afternoon) is overwritten", async () => {
    const THU = "2026-10-15";
    const days: Parameters<typeof fakeReader>[0] = { [THU]: agendaDay(THU, [["09:30", "20:00"]]) };
    const { gate } = makeGate({ days, rows: [] });
    await gate.refresh(NOW_MON);
    days[THU] = agendaDay(THU, [["09:30", "13:30"]]);
    await gate.refresh(NOW_MON);
    expect(gate.windowFor(THU)).toMatchObject({ startMin: 570, endMin: 810 });
  });

  it("11. standingRows throws → window from free ∪ weekday template, without cutting the close", async () => {
    writeFileSync(statePath, JSON.stringify({ v: 1, days: {}, weekdays: { "2": { startMin: 570, endMin: 1200, fromDate: "2026-10-06" } } }));
    const { gate } = makeGate({ days: { [TUE]: agendaDay(TUE, [["09:30", "13:30"]]) }, rows: "fail" });
    gate.load(NOW_MON);
    await gate.refresh(NOW_MON);
    expect(gate.windowFor(TUE)).toMatchObject({ source: "agenda", startMin: 570, endMin: 1200 });
  });

  it("12. horario.json: saved 0600, reloaded after a restart, no dates older than 60 days, broken JSON → empty + warning", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({ v: 1, days: { "2026-01-01": { open: true, startMin: 600, endMin: 700, source: "agenda", fetchedAtMs: 0 } }, weekdays: {} }),
    );
    const a = makeGate({ days: { [TUE]: agendaDay(TUE, [["09:30", "20:00"]]) }, rows: [] });
    a.gate.load(NOW_MON);
    await a.gate.refresh(NOW_MON);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as { days: Record<string, unknown> };
    expect(Object.keys(saved.days)).toContain(TUE);
    expect(Object.keys(saved.days)).not.toContain("2026-01-01");
    expect(JSON.stringify(saved)).not.toMatch(/phone|name|\+34/i);

    const b = makeGate({ days: {} });
    b.gate.load(NOW_MON);
    expect(b.gate.windowFor(TUE)).toMatchObject({ open: true, startMin: 570, endMin: 1200 });

    writeFileSync(statePath, "{ not json");
    const c = makeGate({ days: {} });
    c.gate.load(NOW_MON);
    expect(c.gate.windowFor(TUE).source).toBe("unknown");
    expect(c.lines.some((l) => l.level === "warn")).toBe(true);
  });

  it("13. openMinutesBetween: Saturday 13:30 → Tuesday 09:45 = 30 + 15", () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        v: 1,
        days: {
          [SAT]: { open: true, startMin: 540, endMin: 840, source: "agenda", fetchedAtMs: 0 },
          [TUE]: { open: true, startMin: 570, endMin: 1200, source: "agenda", fetchedAtMs: 0 },
        },
        weekdays: {},
      }),
    );
    const { gate } = makeGate({ days: {} });
    gate.load(at(SAT, "12:00"));
    expect(gate.openMinutesBetween(at(SAT, "13:30"), at(TUE, "09:45"))).toBe(45);
  });
});

describe("deriveDayWindow", () => {
  it("no points → unknown; employees empty → closed; clamps to 07:00–22:00", () => {
    expect(deriveDayWindow(agendaDay(TUE, []), [], 30)).toEqual({ unknown: true });
    expect(deriveDayWindow(agendaDay(TUE, [], false), [], 30)).toEqual({ open: false });
    expect(deriveDayWindow(agendaDay(TUE, [["05:00", "23:30"]]), [], 30)).toEqual({ open: true, startMin: 420, endMin: 1320 });
    expect(deriveDayWindow(agendaDay(TUE, [["22:30", "23:30"]]), [], 30)).toEqual({ open: false });
  });
});
