/**
 * 2026-10-09 — what the agent BELIEVES an hour is, as it sends it in the
 * optional raw-body fields `option_time` / `option_date`.
 *
 * One parser for both places that compare it with the server's truth:
 * - `lock` (call r3557a): resolves `option_index` against the hour meant.
 * - `create` (escaneo 2026-10-09, hallazgo 1): refuses to book when the hour
 *   read to the customer is not the hour of the slot token being booked.
 *
 * Absent or unreadable fields mean «nothing to compare»: the caller behaves
 * exactly as it did before these fields existed.
 */

/** A readable `option_time` / `option_date` pair. At least one is set. */
export interface ExpectedOption {
  /** `HH:mm`, 24 h, zero-padded. */
  time?: string;
  /** `YYYY-MM-DD`, a real calendar date. */
  date?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * `HH:mm` from what a model may send for an hour: `19:00`, `7:00`, `19.00`,
 * `19h00`, `19:00:00`. Anything else (`"7 de la tarde"`) is unreadable and
 * ignored, like every malformed optional field of this contract.
 */
export function readOptionTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,2})[:.hH](\d{2})(?::00)?$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

/** Both raw fields, read together. `undefined` when neither is readable. */
export function readExpectedOption(options: {
  optionTime?: unknown;
  optionDate?: unknown;
}): ExpectedOption | undefined {
  const time = readOptionTime(options.optionTime);
  const dateRaw = typeof options.optionDate === "string" ? options.optionDate.trim() : "";
  const date = isRealDate(dateRaw) ? dateRaw : undefined;
  if (time === undefined && date === undefined) return undefined;
  return { ...(time !== undefined ? { time } : {}), ...(date !== undefined ? { date } : {}) };
}
