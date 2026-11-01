/**
 * The agenda-visible marker for appointments this middleware created from a
 * voice call (step CTL, (internal doc, not included in the template) ADR-012).
 *
 * WHY THIS EXISTS AT ALL
 *
 * Bruno's panel renders a reservation from the denormalized `ownerName` /
 * `ownerSurnames` columns (`ReservationRepository::findReservationsDashboard`,
 * (internal doc, not included in the template)). The legacy
 * `Reservation` entity has **no source, channel, actor or created-at column**
 * — audited statically and recorded in
 * (internal doc, not included in the template) §C ("No created/updated
 * timestamps on Reservation. No source/channel/actor columns."). So there is
 * no honest structured field to say "a machine booked this". The one column
 * that both persists and reaches a human's eyes is `ownerName`.
 *
 * WHY IT IS APPLIED HERE AND NOT ASKED OF THE MODEL
 *
 * The marker's whole value is that a human looking at the diary can trust it.
 * A prefix the LLM is *instructed* to send is a prefix the LLM can forget,
 * paraphrase, translate or be talked out of — and its absence would then read
 * as "a human booked this", which is precisely the false statement the marker
 * exists to prevent. It is therefore computed server-side, from configuration,
 * on a value no request body can reach.
 */

/**
 * Prefixes a display name with the AI marker, idempotently.
 *
 * Guarantees, each one covered by a test in
 * `tests/voiceBookingDisplayPrefix.test.ts`:
 *
 * - **Always marked.** With a non-empty `prefix`, the result always begins
 *   with `prefix` — a caller cannot phrase their name so as to escape it.
 * - **Never doubled.** A name that already starts with the marker (in any
 *   letter case) is not marked twice; its leading segment is normalized to
 *   the configured casing instead, so the agenda shows one canonical marker
 *   rather than `ia-` or `IA-IA-`.
 * - **Whitespace normalized.** Leading/trailing space is dropped and internal
 *   runs collapse to a single space, so `"  Pedro   Mikel "` becomes
 *   `"IA-Pedro Mikel"` rather than a ragged agenda row.
 * - **Disable is explicit.** An empty (or whitespace-only) `prefix` returns
 *   the normalized name untouched. That is the only way to turn the marker
 *   off; it is never a side effect of a missing variable.
 *
 * This function is deliberately total and pure: it never throws, never reads
 * configuration, and never consults the request. Its only inputs are the two
 * arguments.
 */
export function applyBookingDisplayPrefix(name: string, prefix: string): string {
  // A TRAILING space in the configured prefix is meaningful and is kept.
  //
  // `IA-` and `IA - ` are both legitimate markers, and which one a salon
  // wants is a readability decision about their own diary, not ours. Trimming
  // the prefix outright — which this function used to do — silently turned
  // `IA - ` into `IA -Pedro`, so the separator could only ever be configured
  // wrong. Leading space is still dropped (it would just indent the row) and
  // internal runs still collapse.
  const marker = prefix.replace(/\s+/g, " ").replace(/^ /, "");
  // The comparable part of the marker: `IA-`, or `IA -` for `IA - `. Used for
  // the already-marked test so a name that arrives as `IA - Pedro` is not
  // marked a second time.
  const token = marker.trimEnd();
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (token === "") return cleaned;

  // Case-insensitive comparison so "ia-Pedro" is recognised as already
  // marked, but the marker is then re-emitted in its CONFIGURED casing: the
  // point of the marker is that it is one recognisable, greppable token in
  // the diary, not a family of near-misses.
  if (cleaned.slice(0, token.length).toLowerCase() === token.toLowerCase()) {
    return `${marker}${cleaned.slice(token.length).trim()}`;
  }
  return `${marker}${cleaned}`;
}
