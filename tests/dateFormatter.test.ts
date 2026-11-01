import { describe, it, expect } from "vitest";
import {
  fullPhraseEs,
  dayPhraseEs,
  parseDateTime,
  timeLabelFromString,
} from "../src/utils/dateFormatterEs.js";
import { joinTimesEs, availabilityMessage } from "../src/utils/phrasing.js";

describe("Spanish date formatting", () => {
  it("formats a full datetime naturally", () => {
    // 2026-07-29 is a Wednesday.
    expect(fullPhraseEs("2026-07-29 17:00:00")).toBe(
      "miércoles 29 de julio a las 17:00",
    );
  });

  it("formats a date-only value without time", () => {
    const p = parseDateTime("2026-07-21")!;
    expect(dayPhraseEs(p)).toBe("martes 21 de julio");
  });

  it("extracts a time label", () => {
    expect(timeLabelFromString("2026-07-29 09:30:00")).toBe("09:30");
  });

  it("returns input unchanged on unparseable value", () => {
    expect(fullPhraseEs("mañana")).toBe("mañana");
  });
});

describe("Spanish phrasing", () => {
  it("joins times with commas and 'y'", () => {
    expect(joinTimesEs(["16:30", "17:00", "18:00"])).toBe(
      "16:30, 17:00 y 18:00",
    );
  });

  it("builds a friendly availability message", () => {
    const msg = availabilityMessage([
      "2026-07-29 16:30:00",
      "2026-07-29 17:00:00",
    ]);
    expect(msg).toContain("miércoles 29 de julio");
    expect(msg).toContain("16:30 y 17:00");
  });

  it("handles no availability", () => {
    expect(availabilityMessage([])).toContain("no me queda ningún hueco");
  });
});
