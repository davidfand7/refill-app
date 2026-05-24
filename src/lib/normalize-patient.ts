/**
 * Canonical patient identity normalization (v378).
 *
 * Single source of truth for normalizing a patient's name / phone / email
 * to a comparable form. Both the patient ingest (`patient-csv.ts`) AND
 * the appointment match cascade (`emma-appointments.functions.ts`) call
 * into here, so the two sides are guaranteed to produce identical keys
 * for the same input. Before v378 they didn't — patient ingest stripped
 * diacritics via NFKD, appointment matching didn't, which made every
 * accented name a structural miss.
 *
 * Diagnosed against the Rejuv pilot 2026-05-18: 79/122 future-appointment
 * matches (65%). v378's deterministic improvements (NFKD parity, suffix
 * stripping, phone-digits normalization, both-order name fallback) target
 * the 35% miss without resorting to Levenshtein — fuzzy fallback is the
 * v378.x conversation, kept separate from the deterministic floor.
 */

const SUFFIX_TOKENS = new Set([
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
  "v",
  "md",
  "do",
  "dds",
  "dmd",
  "np",
  "pa",
  "phd",
  "esq",
]);

/**
 * Normalize a free-form name string to a lookup key. The transform pipeline:
 *   1. NFKD-decompose then strip combining diacritics ("José" → "Jose")
 *   2. Lowercase
 *   3. Replace any run of non-[a-z0-9] characters with a single hyphen
 *   4. Trim leading / trailing hyphens
 *
 * Idempotent (running it on its own output yields the same string). Returns
 * an empty string for null / undefined / whitespace-only inputs so callers
 * can use truthiness as a shortcut.
 */
export function normalizePatientName(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Drop trailing honorific / generation suffix tokens from a normalized name
 * key. Operates on the OUTPUT of normalizePatientName (hyphen-separated
 * lowercase tokens), peeling suffixes from the right until a non-suffix
 * token is reached. Returns the same key when no suffix is present.
 *
 * Examples:
 *   "johnson-robert-jr"     → "johnson-robert"
 *   "garcia-maria-iii"      → "garcia-maria"
 *   "smith-john-md-phd"     → "smith-john"
 *   "smith-john"            → "smith-john"  (no-op)
 *
 * Deliberately peels MULTIPLE suffixes (md + phd) — practitioners with both
 * a clinical and academic credential are common enough at med-spas.
 */
export function stripNameSuffixes(normalizedKey: string): string {
  if (!normalizedKey) return "";
  const tokens = normalizedKey.split("-");
  while (tokens.length > 1 && SUFFIX_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join("-");
}

/**
 * Normalize a phone number to a comparable digits-only form. Handles common
 * US conventions:
 *   - Strips any non-digit characters (parens, dashes, spaces, dots, +)
 *   - Drops a single leading "1" when the result is 11 digits (US country
 *     code), so "+1 (303) 555-1234" and "303-555-1234" both yield
 *     "3035551234"
 *
 * Returns empty string for null / undefined / whitespace-only input. Does
 * NOT validate that the result is a plausible phone — that's the caller's
 * problem if it matters. The goal here is a stable comparison key, not
 * semantic correctness.
 */
export function normalizePhone(input: string | null | undefined): string {
  if (!input) return "";
  const digits = input.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * Normalize an email address to a comparable form (trim + lowercase). Does
 * not strip dots from the local part (a Gmail-specific convention) — those
 * remain distinct addresses for any non-Gmail provider, and assuming
 * otherwise would create cross-patient false positives in the match index.
 */
export function normalizeEmail(input: string | null | undefined): string {
  if (!input) return "";
  return input.trim().toLowerCase();
}

/**
 * Generate the ordered list of candidate name keys to try when matching
 * an appointment row to a patient roster row. Order is intentional —
 * earlier candidates have higher precision; the matcher walks the list
 * top-to-bottom and uses the first hit.
 *
 *   1. last-first              — the original v360 convention; most
 *                                 entries in the roster will match here.
 *   2. first-last              — flips the order when source A wrote
 *                                 "John Smith" and source B wrote
 *                                 "Smith, John" but the splitter put the
 *                                 wrong field in the wrong column.
 *   3. last-first (stripped)   — suffix-tolerant variant of #1.
 *   4. first-last (stripped)   — suffix-tolerant variant of #2.
 *
 * Deduplicated — when last==first or stripping is a no-op, the duplicate
 * variants are omitted so the matcher doesn't waste hashmap lookups.
 */
export function nameMatchCandidates(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string[] {
  const first = normalizePatientName(firstName);
  const last = normalizePatientName(lastName);
  if (!first && !last) return [];

  // Per-name strip handles the case where the suffix is buried in the
  // lastName field ("Johnson Jr" → last="johnson-jr"). Post-join strip
  // wouldn't reach a suffix that lands in the middle of last-first.
  const firstStripped = stripNameSuffixes(first);
  const lastStripped = stripNameSuffixes(last);

  const lastFirst = [last, first].filter(Boolean).join("-");
  const firstLast = [first, last].filter(Boolean).join("-");
  const lastFirstStripped = [lastStripped, firstStripped]
    .filter(Boolean)
    .join("-");
  const firstLastStripped = [firstStripped, lastStripped]
    .filter(Boolean)
    .join("-");

  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of [lastFirst, firstLast, lastFirstStripped, firstLastStripped]) {
    if (key && !seen.has(key)) {
      out.push(key);
      seen.add(key);
    }
  }
  return out;
}

/**
 * Given a roster row's original lookup_key (already normalized by
 * normalizePatientName at ingest time), return the indexing variants the
 * patient-match index should populate so suffix-bearing roster rows
 * resolve against non-suffix appointment names (and vice versa).
 *
 *   ["johnson-robert-jr", "johnson-robert"]
 *
 * Deduplicated when stripping is a no-op. Caller is expected to record
 * collisions (two patients sharing a stripped key) and NOT bind those
 * stripped entries — would create false-positive matches. The matcher
 * handles that with a collision set in `buildPatientIndex`.
 */
export function rosterKeyVariants(originalLookupKey: string): string[] {
  if (!originalLookupKey) return [];
  const stripped = stripNameSuffixes(originalLookupKey);
  if (stripped === originalLookupKey) return [originalLookupKey];
  return [originalLookupKey, stripped];
}
