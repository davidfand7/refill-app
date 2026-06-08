/**
 * fetchAllRows — page past PostgREST's server-side row cap.
 *
 * Supabase/PostgREST enforces a `db-max-rows` ceiling (1,000 by default) on
 * EVERY read. A `.limit(2000)` does NOT override it — the server silently
 * truncates to 1,000 and returns no error. Any code that reads a list and
 * then counts/sums/maps over it as if complete is therefore silently
 * undercounting at scale (a 1,126-patient tenant shows "1,000").
 *
 * Use this for any read whose FULL result set is load-bearing — headline
 * counts, cohort membership, lifetime revenue, funnel totals. Pass a factory
 * that builds the SAME query for a given inclusive row range; it loops in
 * 1,000-row pages until a short page signals the end.
 *
 *   const rows = await fetchAllRows((from, to) =>
 *     sb.from("knowledge_nodes").select("*").eq("user_id", uid)
 *       .order("updated_at", { ascending: false }).range(from, to),
 *   );
 *
 * Established 2026-06-07 (truncation sweep, v1.92.0).
 */

const PAGE = 1000;
const HARD_CAP = 500_000; // backstop against a runaway loop

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

export async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < HARD_CAP; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}
