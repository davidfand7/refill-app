/**
 * Fuzzy name-matching for the Patient × Client cross-reference.
 *
 * The 276 sales-no-client gap is mostly spelling drift: "Bob → Robert",
 * maiden vs married names, typos like "yearsly" vs "Yearsley". Levenshtein
 * distance ≤ 2 on the last-name token catches the typo class cleanly; the
 * "Bob/Robert" class needs a nickname dictionary — out of scope for P1.5,
 * deferred.
 *
 * Confidence ranking: lower distance = higher confidence. We also require
 * a first-letter-of-first-name match, otherwise "Hennesy, Megan" matches
 * "Hennessey, Mark" (close last name, wrong person). The first-letter
 * guard is what makes "≤2" usable as a one-click confirmation threshold
 * rather than a manual review queue.
 *
 * Pure functions; no I/O. Used by the contacts server fn to assemble the
 * suggestion list and by tests to keep the algorithm honest.
 *
 * Established 2026-05-15 (Patient Architecture P1.5).
 */

// ─── Public types ──────────────────────────────────────────────────────────

export type FuzzyTarget = {
  /** Stable identity (e.g. patient_node_id or candidate.id). */
  id: string;
  /** Display string for UI ("Last, First"). */
  displayName: string;
  /** Lowercased last-name token used for the distance compare. */
  lastNameKey: string;
  /** Lowercased first-character of first name. */
  firstInitial: string;
};

export type FuzzyMatch = {
  target: FuzzyTarget;
  /** Levenshtein distance on lastNameKey. 0 = exact, 1 = one edit, 2 = two. */
  distance: number;
  /** Higher = better. Computed once at match time so the UI can sort cheaply. */
  confidence: number;
};

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Find candidate fuzzy matches for one source name against a pool. Returns
 * the top-N matches sorted by confidence (descending). Empty array means no
 * usable match — the UI should fall back to manual contact entry.
 */
export function findFuzzyMatches(
  source: FuzzyTarget,
  pool: ReadonlyArray<FuzzyTarget>,
  opts: { maxDistance?: number; maxResults?: number } = {},
): FuzzyMatch[] {
  const maxDistance = opts.maxDistance ?? 2;
  const maxResults = opts.maxResults ?? 3;
  if (!source.lastNameKey) return [];

  const matches: FuzzyMatch[] = [];
  for (const target of pool) {
    if (target.id === source.id) continue;
    if (!target.lastNameKey) continue;
    // First-letter-of-first-name guard. The few cases where this guard hurts
    // (people who changed their first name) are rarer than the cases where
    // it saves us from confidently-wrong pairings.
    if (
      source.firstInitial &&
      target.firstInitial &&
      source.firstInitial !== target.firstInitial
    )
      continue;
    // Fast-reject: |length diff| > maxDistance → distance can't be ≤ maxDistance.
    if (Math.abs(source.lastNameKey.length - target.lastNameKey.length) > maxDistance)
      continue;
    const d = levenshteinCapped(source.lastNameKey, target.lastNameKey, maxDistance);
    if (d > maxDistance) continue;
    matches.push({
      target,
      distance: d,
      confidence: confidenceFromDistance(d, source.lastNameKey.length),
    });
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches.slice(0, maxResults);
}

/**
 * Build a FuzzyTarget from any object that carries the raw display fields.
 * Tolerant of missing pieces — if the display string lacks a first name we
 * skip the firstInitial guard (returns "").
 */
export function fuzzyTargetFromName(
  id: string,
  displayName: string,
  firstName?: string | null,
  lastName?: string | null,
): FuzzyTarget {
  // Prefer explicit firstName/lastName when present; otherwise derive from
  // "Last, First" (patient knowledge_nodes title format).
  let last = lastName?.trim().toLowerCase() ?? "";
  let firstInitial = "";
  if (firstName) firstInitial = firstName.trim().charAt(0).toLowerCase();
  if (!last && displayName.includes(",")) {
    const [l, rest] = displayName.split(",", 2).map((s) => s.trim());
    last = l.toLowerCase();
    if (!firstInitial && rest) firstInitial = rest.charAt(0).toLowerCase();
  } else if (!last) {
    // "Firstname Lastname" form — take the last whitespace-separated token.
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 1) {
      last = parts[parts.length - 1].toLowerCase();
      if (!firstInitial && parts.length >= 2)
        firstInitial = parts[0].charAt(0).toLowerCase();
    }
  }
  // Strip non-alphanumerics from the last-name key — "Garas." and "Garas"
  // collapse, "Yearsley" and "Yearsly" stay one edit apart.
  last = last.replace(/[^a-z0-9]/g, "");
  return { id, displayName, lastNameKey: last, firstInitial };
}

// ─── Internals ─────────────────────────────────────────────────────────────

/**
 * Levenshtein distance with an early-exit cap. Returns maxDistance+1 when
 * the actual distance exceeds the cap — caller treats anything > cap as "no
 * match" so we avoid computing the exact distance for rejects.
 *
 * Uses the rolling two-row implementation (O(n) memory). Fast enough for
 * 1500 × 1500 = 2.25M comparisons on the Rejuv set; tested locally at well
 * under a second.
 */
function levenshteinCapped(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure a is the shorter — minor speedup.
  if (a.length > b.length) [a, b] = [b, a];

  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    let rowMin = curr[0];
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      const v = Math.min(
        curr[i - 1] + 1, // insertion
        prev[i] + 1, // deletion
        prev[i - 1] + cost, // substitution
      );
      curr[i] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1; // early exit — best case can't reach ≤ cap
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

function confidenceFromDistance(distance: number, sourceLength: number): number {
  // 0/0 division guard: 100 for exact match on any non-empty input.
  if (sourceLength === 0) return 0;
  // 0 → 1.0; 1 → ~0.8; 2 → ~0.6.
  return Math.max(0, 1 - distance / Math.max(sourceLength, 4));
}
