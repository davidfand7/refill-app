/**
 * selectAllRows — page through EVERY row of a Supabase/PostgREST read.
 *
 * WHY (2026-06-15): an unpaginated `.select()` is SILENTLY capped at PostgREST's
 * 1000-row default. A caller that `.map`/`.reduce`/`new Set`/`.length`s the
 * result treats a truncated page as the complete set → data silently dropped,
 * NO error raised. This is the worst failure mode under the Connection-Health
 * doctrine (silent absence, not an error) and it bit us 3× in one session
 * (reliability sweep recomputed 174 of 695 patients; rep recruit-stats
 * under-reporting). Routing bulk reads through here makes full-coverage the
 * DEFAULT: it loops `.range()` until a short (= final) page.
 *
 * Pass a builder that takes (from, to) and returns the ranged query:
 *
 *   const rows = await selectAllRows((from, to) =>
 *     sb.from("rep_affiliations").select("rep_id").eq("parent_rep_id", id).range(from, to),
 *   );
 *
 * Use this ONLY for reads whose scope can plausibly exceed 1000 rows (whole
 * user/tenant/fleet). A read already narrowed to one entity (e.g. .eq on a
 * unique id) or terminated by .single()/.maybeSingle()/.limit() does not need
 * it.
 *
 * A `maxPages` backstop (default 1000 pages = 1M rows) guards against a runaway
 * loop; if it ever trips we WARN loudly rather than truncate silently.
 */
export async function selectAllRows<T>(
  rangedQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { pageSize?: number; maxPages?: number; label?: string } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 1000;
  const rows: T[] = [];
  let from = 0;
  let page = 0;
  while (page < maxPages) {
    const { data, error } = await rangedQuery(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return rows; // clean end (no more rows)
    rows.push(...data);
    if (data.length < pageSize) return rows; // clean end (short final page)
    from += pageSize;
    page++;
  }
  console.warn(
    `[selectAllRows] hit maxPages=${maxPages} (${rows.length} rows${
      opts.label ? `, ${opts.label}` : ""
    }) — possible truncation; raise maxPages or narrow the query.`,
  );
  return rows;
}
