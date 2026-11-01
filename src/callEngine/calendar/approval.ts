import type { Clock } from "../domain/types.js";
import type { HolidayProvider, OperationalCalendar, VenueCalendarRule } from "./model.js";

/**
 * Import/approval workflow for `VenueCalendarRule`s coming from a
 * `HolidayProvider` (calendar/model.ts, calendar/holidayProvider.ts).
 *
 * CENTRAL GUARANTEE: an imported rule is born `pending_review` and INERT —
 * `resolveAvailability.ts`'s `resolveDayWindows` already ignores any
 * `VenueCalendarRule` that is not `approval: 'approved'` (fail-closed: it
 * never opens, and never closes, the venue on its own). Nothing in this
 * module can make an imported rule affect availability without an explicit
 * human review step (`reviewRule`) followed by `activateApproved`. See
 * (internal doc, not included in the template).
 */

/** One import run from a single `HolidayProvider`. Every rule inside starts `pending_review`. */
export interface ImportBatch {
  readonly id: string;
  readonly providerId: string;
  readonly importedAt: string;
  readonly importedBy: string;
  readonly rules: readonly VenueCalendarRule[];
}

/**
 * Fetches holidays from `provider` and wraps each one as a full
 * `VenueCalendarRule`, `approval: 'pending_review'`, with an `AuditStamp`
 * recording who imported it and when (from the injected `clock`, never the
 * real wall clock). The returned batch is INERT: nothing in it can affect
 * any `OperationalCalendar` until `reviewRule` approves it AND
 * `activateApproved` folds it in.
 */
export async function importHolidays(
  provider: HolidayProvider,
  input: { from: string; to: string; scopes: ReadonlyArray<"national" | "regional" | "municipal"> },
  clock: Clock,
  importedBy: string,
): Promise<ImportBatch> {
  const fetched = await provider.fetchHolidays(input);
  const importedAt = clock.nowInstantISO();
  const rules: VenueCalendarRule[] = fetched.map((rule) => ({
    ...rule,
    approval: "pending_review",
    audit: {
      createdAt: importedAt,
      createdBy: importedBy,
    },
  }));
  return {
    id: `import-batch-${provider.id}-${importedAt}`,
    providerId: provider.id,
    importedAt,
    importedBy,
    rules,
  };
}

/**
 * Records a human decision (`approve` | `reject`) on one rule of `batch`,
 * stamping `approvedAt`/`approvedBy` from the injected `clock`. IMMUTABLE:
 * returns a brand-new `ImportBatch`; the `batch` passed in is never mutated
 * (see `tests/callEngine/holidayApproval.test.ts`, which asserts this
 * directly against the original object).
 */
export function reviewRule(
  batch: ImportBatch,
  ruleId: string,
  decision: "approve" | "reject",
  clock: Clock,
  reviewedBy: string,
): ImportBatch {
  const reviewedAt = clock.nowInstantISO();
  let found = false;
  const rules = batch.rules.map((rule) => {
    if (rule.id !== ruleId) return rule;
    found = true;
    return {
      ...rule,
      approval: decision === "approve" ? ("approved" as const) : ("rejected" as const),
      audit: {
        ...rule.audit,
        approvedAt: reviewedAt,
        approvedBy: reviewedBy,
      },
    };
  });
  if (!found) {
    throw new Error(`reviewRule: no rule with id '${ruleId}' in batch '${batch.id}'.`);
  }
  return { ...batch, rules };
}

/**
 * Folds the `approved` rules of `batch` into `cal.venueRules`. Rules that
 * are still `pending_review` or that were `rejected` are left out entirely
 * — they never reach the operational calendar. Re-running this with the
 * same batch id replaces (rather than duplicates) any rule of the same
 * `id` already present, so activation is idempotent.
 */
export function activateApproved(cal: OperationalCalendar, batch: ImportBatch): OperationalCalendar {
  const approved = batch.rules.filter((r) => r.approval === "approved");
  const approvedIds = new Set(approved.map((r) => r.id));
  const remaining = cal.venueRules.filter((r) => !approvedIds.has(r.id));
  return { ...cal, venueRules: [...remaining, ...approved] };
}

/** Input for `manualOverride` — everything a `VenueCalendarRule` needs except its source/approval/audit. */
export interface ManualOverrideInput {
  id: string;
  kind: VenueCalendarRule["kind"];
  scope: VenueCalendarRule["scope"];
  date: string;
  closed: boolean;
  specialOpen?: string;
  specialClose?: string;
  externalRef?: string;
}

/**
 * Creates an already-`approved`, `source: 'manual_override'`
 * `VenueCalendarRule`. Manual entries are authored and approved by the same
 * human action (there is no separate "import, then review" step for a
 * decision a person is making directly), so both `createdBy` and
 * `approvedBy` on the resulting `AuditStamp` are `createdBy` and both
 * timestamps come from the same `clock` read. By design (see
 * `resolveAvailability.ts`'s `pickRule`), a `manual_override` rule always
 * wins over an `imported_provider` rule for the same date — a human
 * decision always overrides an unreviewed or imported one.
 */
export function manualOverride(
  input: ManualOverrideInput,
  clock: Clock,
  createdBy: string,
): VenueCalendarRule {
  const now = clock.nowInstantISO();
  return {
    ...input,
    source: "manual_override",
    approval: "approved",
    audit: {
      createdAt: now,
      createdBy,
      approvedAt: now,
      approvedBy: createdBy,
    },
  };
}

/**
 * Human-readable (Spanish) accountability trail for one `ImportBatch`: who
 * imported it and when, and — per rule — who reviewed it, what they
 * decided, and when. Never includes anything client-facing; this is
 * internal/operational audit text only.
 */
export function auditTrail(batch: ImportBatch): string[] {
  const lines: string[] = [
    `Lote '${batch.id}' importado del proveedor '${batch.providerId}' por ${batch.importedBy} el ${batch.importedAt} (${batch.rules.length} regla(s)).`,
  ];
  for (const rule of batch.rules) {
    const base = `Regla '${rule.id}' (${rule.scope}/${rule.kind}, fecha ${rule.date}): creada por ${rule.audit.createdBy} el ${rule.audit.createdAt}; estado actual = ${rule.approval}.`;
    if (rule.audit.approvedAt != null && rule.audit.approvedBy != null) {
      const verbo = rule.approval === "approved" ? "aprobada" : "rechazada";
      lines.push(`${base} Revisión: ${verbo} por ${rule.audit.approvedBy} el ${rule.audit.approvedAt}.`);
    } else {
      lines.push(`${base} Pendiente de revisión humana.`);
    }
  }
  return lines;
}
