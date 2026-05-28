/**
 * Fuzzy name-matching for the Patient × Client cross-reference.
 *
 * The 276 sales-no-client gap is mostly spelling drift: "Bob → Robert",
 * maiden vs married names, typos like "yearsly" vs "Yearsley". Levenshtein
 * distance ≤ 2 on the last-name token catches the typo class cleanly; the
 * "Bob/Robert" class is now handled via the nickname dictionary in
 * NICKNAME_CANONICAL below (v1.25.0). Maiden/married surname changes are
 * harder; that's the patient-duplicate-detection feature in
 * patient-ingest.findSameContactDifferentName.
 *
 * Confidence ranking: lower distance = higher confidence. We require a
 * first-name match — either first-initial-equal OR known-nickname-equivalent
 * — otherwise "Hennesy, Megan" matches "Hennessey, Mark" (close last name,
 * wrong person). The guard is what makes "≤2" usable as a one-click
 * confirmation threshold rather than a manual review queue.
 *
 * Pure functions; no I/O. Used by the contacts server fn to assemble the
 * suggestion list and by tests to keep the algorithm honest.
 *
 * Established 2026-05-15 (Patient Architecture P1.5). v1.25.0 added
 * nickname-dictionary equivalence.
 */

// ─── Nickname dictionary (v1.25.0) ─────────────────────────────────────────
//
// Maps every known nickname/variant to a single CANONICAL form. Two names
// share a canonical → they're treated as first-name-equal even if their
// raw initials differ ("B" vs "R" for Bob/Robert).
//
// Curated list of the most common Western nickname pairs that show up in
// US med-spa books. Keep additions to actual common pairs — over-eager
// equivalences (e.g. mapping every "Ann*" variant to one canonical) would
// generate false-positive merges.
const NICKNAME_CANONICAL: Record<string, string> = {
  // ─── Male
  bob: "robert", bobby: "robert", rob: "robert", robbie: "robert", robert: "robert",
  bill: "william", billy: "william", will: "william", willy: "william", william: "william",
  jim: "james", jimmy: "james", jamie: "james", james: "james",
  jack: "john", johnny: "john", jon: "john", john: "john",
  mike: "michael", mikey: "michael", mick: "michael", michael: "michael",
  dick: "richard", rick: "richard", ricky: "richard", richie: "richard", richard: "richard",
  tom: "thomas", tommy: "thomas", thomas: "thomas",
  dan: "daniel", danny: "daniel", daniel: "daniel",
  dave: "david", davey: "david", david: "david",
  tony: "anthony", anthony: "anthony",
  chris: "christopher", topher: "christopher", christopher: "christopher",
  matt: "matthew", matty: "matthew", matthew: "matthew",
  ed: "edward", eddie: "edward", ned: "edward", ted: "edward", edward: "edward",
  steve: "stephen", stephen: "stephen", steven: "stephen",
  joe: "joseph", joey: "joseph", joseph: "joseph",
  nick: "nicholas", nicky: "nicholas", nicholas: "nicholas",
  ben: "benjamin", benny: "benjamin", benjamin: "benjamin",
  alex: "alexander", al: "alexander", alexander: "alexander",
  // ─── Female
  liz: "elizabeth", lizzie: "elizabeth", beth: "elizabeth", betsy: "elizabeth", betty: "elizabeth", ellie: "elizabeth", elle: "elizabeth", elizabeth: "elizabeth",
  kate: "katherine", katie: "katherine", kathy: "katherine", kathryn: "katherine", katherine: "katherine", kat: "katherine",
  meg: "margaret", maggie: "margaret", peggy: "margaret", margaret: "margaret",
  sue: "susan", susie: "susan", suzie: "susan", susan: "susan", suzanne: "susan",
  cathy: "catherine", cat: "catherine", catherine: "catherine",
  patty: "patricia", pat: "patricia", patti: "patricia", trish: "patricia", patricia: "patricia",
  jen: "jennifer", jenny: "jennifer", jenn: "jennifer", jennifer: "jennifer",
  jess: "jessica", jessie: "jessica", jessica: "jessica",
  becky: "rebecca", becca: "rebecca", rebecca: "rebecca",
  abby: "abigail", abigail: "abigail",
  sam: "samantha", sammy: "samantha", samantha: "samantha",
  nat: "natalie", natalie: "natalie",
  nikki: "nicole", nicki: "nicole", nicole: "nicole",
  steph: "stephanie", stephanie: "stephanie",
  vicki: "victoria", vicky: "victoria", tori: "victoria", victoria: "victoria",
  // ─── Common shortenings (gender-neutral)
  pete: "peter", peter: "peter",
  andy: "andrew", drew: "andrew", andrew: "andrew",
  ken: "kenneth", kenny: "kenneth", kenneth: "kenneth",
  ron: "ronald", ronnie: "ronald", ronald: "ronald",
  greg: "gregory", gregory: "gregory",
  tim: "timothy", timmy: "timothy", timothy: "timothy",
  larry: "lawrence", lawrence: "lawrence", laurence: "lawrence",
};

/** Map a raw first name to its canonical form (or itself when unknown).
 *  Exported so the Pass-3 duplicate detector in patient-ingest can
 *  resolve "Bob → robert" + "Robert → robert" to a common key. */
export function nicknameCanonical(raw: string): string {
  const k = raw.trim().toLowerCase();
  return NICKNAME_CANONICAL[k] ?? k;
}

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
  /** v1.25.0: lowercased canonical first name (resolves nicknames to a
   *  common form so Bob/Robert match through the dictionary). Falls back
   *  to the raw lowercase first name when no entry exists. Empty when
   *  first name was unknown at target-construction time. */
  firstNameCanonical: string;
};

export type FuzzyMatch = {
  target: FuzzyTarget;
  /** Levenshtein distance on lastNameKey. 0 = exact, 1 = one edit, 2 = two. */
  distance: number;
  /** Higher = better. Computed once at match time so the UI can sort cheaply. */
  confidence: number;
  /** v1.25.0: true when the first-name match required nickname-dictionary
   *  resolution (e.g. Bob ↔ Robert). UI can render a hint chip so the
   *  operator knows WHY a confidently-wrong-looking name pair surfaced. */
  matchedViaNickname: boolean;
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
    // First-name guard. Two acceptances:
    //   (1) first initial matches (existing behavior)
    //   (2) v1.25.0: canonical-form matches via nickname dictionary
    //       (Bob/Robert/Bobby all resolve to "robert")
    let matchedViaNickname = false;
    if (source.firstInitial && target.firstInitial) {
      if (source.firstInitial !== target.firstInitial) {
        // Initials differ — only allow if nickname dictionary collapses them.
        if (
          source.firstNameCanonical &&
          target.firstNameCanonical &&
          source.firstNameCanonical === target.firstNameCanonical
        ) {
          matchedViaNickname = true;
        } else {
          continue;
        }
      }
    }
    // Fast-reject: |length diff| > maxDistance → distance can't be ≤ maxDistance.
    if (Math.abs(source.lastNameKey.length - target.lastNameKey.length) > maxDistance)
      continue;
    const d = levenshteinCapped(source.lastNameKey, target.lastNameKey, maxDistance);
    if (d > maxDistance) continue;
    matches.push({
      target,
      distance: d,
      confidence: confidenceFromDistance(d, source.lastNameKey.length),
      matchedViaNickname,
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
  let first = firstName?.trim() ?? "";
  if (!last && displayName.includes(",")) {
    const [l, rest] = displayName.split(",", 2).map((s) => s.trim());
    last = l.toLowerCase();
    if (!first && rest) first = rest;
  } else if (!last) {
    // "Firstname Lastname" form — take the last whitespace-separated token.
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 1) {
      last = parts[parts.length - 1].toLowerCase();
      if (!first && parts.length >= 2) first = parts[0];
    }
  }
  const firstInitial = first ? first.charAt(0).toLowerCase() : "";
  const firstNameCanonical = first ? nicknameCanonical(first) : "";
  // Strip non-alphanumerics from the last-name key — "Garas." and "Garas"
  // collapse, "Yearsley" and "Yearsly" stay one edit apart.
  last = last.replace(/[^a-z0-9]/g, "");
  return { id, displayName, lastNameKey: last, firstInitial, firstNameCanonical };
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
