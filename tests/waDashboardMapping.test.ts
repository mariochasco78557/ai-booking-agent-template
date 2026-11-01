import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDashboardQuery,
  mapDashboardResponse,
  parseUpstreamDateTime,
} from "../src/services/waSelfService/dashboardMapping.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/wa/${name}.json`, import.meta.url), "utf8"));

describe("dashboard mapping", () => {
  it("builds the query one day further", () => {
    expect(buildDashboardQuery({ fromDate: "2026-10-05", toDate: "2026-12-04" })).toEqual({
      start: "2026-10-05",
      end: "2026-12-05",
    });
  });

  it("all date shapes map to the same rows", () => {
    const base = mapDashboardResponse(fixture("dashboard_array"));
    expect(base.unparseable).toBe(0);
    expect(base.rows.map((r) => r.startsAt)).toEqual([
      "2026-10-07 10:30",
      "2026-10-08 17:00",
      "2026-12-01 09:00",
    ]);
    for (const name of ["dashboard_wrapped", "dashboard_iso_offset", "dashboard_php_datetime"]) {
      expect(mapDashboardResponse(fixture(name))).toEqual(base);
    }
  });

  it("parses date forms", () => {
    expect(parseUpstreamDateTime("2026-10-07T08:30:00Z")).toBe("2026-10-07 10:30");
    expect(parseUpstreamDateTime("2026-12-01T09:00:00+01:00")).toBe("2026-12-01 09:00");
    expect(parseUpstreamDateTime("2026-10-07 10:30")).toBe("2026-10-07 10:30");
    expect(parseUpstreamDateTime("2026-10-07T10:30:15")).toBe("2026-10-07 10:30");
    expect(
      parseUpstreamDateTime({ date: "2026-10-07 08:30:00.000000", timezone: "+00:00" }),
    ).toBe("2026-10-07 10:30");
    expect(parseUpstreamDateTime({ date: "2026-10-07 10:30:00", timezone: "UTC" })).toBeNull();
    expect(parseUpstreamDateTime("2026-02-31 10:00")).toBeNull();
    expect(parseUpstreamDateTime(null)).toBeNull();
    expect(parseUpstreamDateTime(5)).toBeNull();
  });

  it("dirty rows", () => {
    const { rows, unparseable } = mapDashboardResponse(fixture("dashboard_dirty"));
    expect(unparseable).toBe(7);
    const phone = (id: number) => rows.find((r) => r.id === id)?.ownerPhoneE164;
    expect(rows).toHaveLength(7);
    expect(phone(201)).toBe("+34600111222");
    expect(phone(202)).toBe("+34600111222");
    expect(phone(203)).toBeNull();
    expect(phone(204)).toBeNull();
    expect(phone(205)).toBeNull();
    expect(phone(206)).toBeNull();
    expect(phone(207)).toBe("+34910000025");
  });

  it("non-array data yields nothing without throwing", () => {
    expect(mapDashboardResponse({ foo: 1 })).toEqual({ rows: [], unparseable: 0 });
    expect(mapDashboardResponse("x")).toEqual({ rows: [], unparseable: 0 });
    expect(mapDashboardResponse(null)).toEqual({ rows: [], unparseable: 0 });
    expect(mapDashboardResponse({ data: "no" })).toEqual({ rows: [], unparseable: 0 });
  });

  it("cleans the employee name", () => {
    const { rows } = mapDashboardResponse(fixture("dashboard_array"));
    expect(rows[0]!.employeeName).toBe("Bruno");
    expect(rows[0]!.employeeId).toBe(1);
  });
});
