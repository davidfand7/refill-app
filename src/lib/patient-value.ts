/**
 * Patient Value Tiering — Pillar 1 of the Patient-Profitability OS (Slice 1).
 *
 * Two INDEPENDENT axes, both internal-only (never patient-visible):
 *
 *   1. Value tier (RFM, percentile-ranked within the tenant's OWN book):
 *        top      — ~top 20% by composite Recency/Frequency/Monetary rank
 *        core     — everyone else with enough history to rank
 *        emerging — cold-start: new / too-little-history. NEVER "low".
 *
 *   2. Reliability flag (behavior, independent of value):
 *        reliable — default
 *        watch    — chronic no-show/cancel (reliability tier in_recovery) OR
 *                   always-negotiator OR specials-seeker. "watch", not "bad".
 *
 * Pure + deterministic — `now` is always passed in (no Date.now() here) so the
 * scoring is unit-testable and the percentile math is reproducible. Tier
 * assignment needs whole-book context (percentile is relative to the tenant's
 * population), so the ranking entry point takes the full patient list and the
 * caller (recomputePatientValueTiers) feeds it every patient at once.
 *
 * Reuses the SAME signals the rest of the app already tiers on — netSpendUsd /
 * totalVisits / lastVisit (recognition-allocation spend-decile, a-list-rules
 * predicate) — rather than inventing a third tiering system. Percentile rank
 * (not a raw lifetime sum) avoids the filler-vs-tox spend skew.
 */

export type ValueTier = "top" | "core" | "emerging";
export type ReliabilityFlag = "reliable" | "watch";

/** The minimal per-patient signal the tiering reads (subset of PatientSummary). */
export type PatientValueInputs = {
  firstVisit: string | null;
  lastVisit: string | null;
  totalVisits: number;
  /** Net spend (USD). Matches the field recognition-allocation deciles on. */
  netSpendUsd: number;
};

export type PatientValueResult = {
  valueTier: ValueTier;
  /** 0–100 composite percentile rank within the book (emerging patients = 0). */
  valueScore: number;
};

// ─── Tuning constants (one place; mirrors the a-list-rules / recognition style) ─

/** Cold-start: ≤ this many visits → still "emerging" regardless of spend. */
export const EMERGING_MAX_VISITS = 2;
/** Cold-start: first visit newer than this → "emerging" (acquisition window). */
export const EMERGING_TENURE_DAYS = 120;
/** Below this many rankable patients, percentile is noise → no "top" tier. */
export const MIN_BOOK_FOR_PERCENTILE = 30;
/** Composite percentile at/above which a patient is "top" (~top 20%). */
export const TOP_PERCENTILE = 0.8;
/** RFM composite weights — Monetary leads, then Frequency, then Recency. */
export const RFM_WEIGHTS = { monetary: 0.5, frequency: 0.3, recency: 0.2 } as const;

// ─── Non-patient bucket guard ─────────────────────────────────────────────

/**
 * QuickBooks/POS catch-all "patient" rows that are NOT real people — they
 * aggregate unattributed sales and otherwise rank as fake whales (e.g.
 * "Unassigned" surfaced as a top-tier $44k/89-visit "patient" on Rejuv).
 * These must be excluded from value tiering (they skew the percentile AND
 * are non-targetable). Conservative EXACT normalized-name match — never a
 * substring (a real patient surnamed "Cash" must not be nuked).
 */
const NON_PATIENT_BUCKET_NAMES = new Set([
  "unassigned",
  "cash sale",
  "cash customer",
  "no name",
  "house account",
  "walk in",
  "walk-in",
]);

/** True when a node's display name is a known non-patient catch-all bucket. */
export function isNonPatientName(displayName: string | null | undefined): boolean {
  const n = (displayName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return NON_PATIENT_BUCKET_NAMES.has(n);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function daysBetween(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / (24 * 60 * 60 * 1000));
}

/**
 * Cold-start exemption. A patient is "emerging" (never "top"/"core"-ranked)
 * when we don't yet have enough history to value them — no visit on record,
 * too few visits, or a too-recent first visit. Keeps the model from fighting
 * acquisition: a brand-new high-intent patient must NOT read as low value.
 */
export function isEmerging(p: PatientValueInputs, now: number): boolean {
  if (!p.lastVisit) return true;
  if (p.totalVisits <= EMERGING_MAX_VISITS) return true;
  const tenure = daysBetween(p.firstVisit, now);
  if (tenure !== null && tenure < EMERGING_TENURE_DAYS) return true;
  return false;
}

/**
 * Percentile rank of each value within the array, in [0,1]: the fraction of
 * the population with a value ≤ this one. Ties share the higher rank. An empty
 * input returns []. Used to make each RFM axis book-relative before combining.
 */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  // For ties, count how many are ≤ v (upper bound) so equal values rank equally.
  return values.map((v) => {
    // index of first element > v == count of elements ≤ v
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo / n; // count(≤ v) / n  → (0,1]
  });
}

/**
 * Reliability flag (behavior axis, independent of value). "watch" surfaces
 * interference risk — NOT low spend. Internal-only; "watch" not "bad".
 */
export function reliabilityFlag(args: {
  /** reliability_status.tier === "in_recovery" (chronic 6mo no-show/cancel). */
  inRecovery: boolean;
  /** softTags.negotiator?.value === "always". */
  negotiatorAlways: boolean;
  /** softTags.specialsSeeker?.value === true. */
  specialsSeeker: boolean;
}): ReliabilityFlag {
  return args.inRecovery || args.negotiatorAlways || args.specialsSeeker
    ? "watch"
    : "reliable";
}

/**
 * Assign value tiers across the WHOLE book at once (percentile is tenant-
 * relative). Returns a result per input id, order-preserved.
 *
 * Algorithm:
 *   1. Split off cold-start "emerging" patients (never ranked into top/core).
 *   2. Percentile-rank the remaining ("rankable") book on each RFM axis:
 *        Recency  — more-recent = higher (ranked on negated days-since).
 *        Frequency— totalVisits.
 *        Monetary — netSpendUsd.
 *   3. Composite = weighted blend → percentile-rank the composite itself so
 *      "top 20%" is exactly the top fraction of the rankable book.
 *   4. Guardrail: below MIN_BOOK_FOR_PERCENTILE rankable patients, percentile
 *      is noise → everyone rankable is "core" (no "top").
 */
export function assignValueTiers<T extends { id: string } & PatientValueInputs>(
  patients: T[],
  now: number,
): Map<string, PatientValueResult> {
  const out = new Map<string, PatientValueResult>();

  const rankable: T[] = [];
  for (const p of patients) {
    if (isEmerging(p, now)) {
      out.set(p.id, { valueTier: "emerging", valueScore: 0 });
    } else {
      rankable.push(p);
    }
  }

  if (rankable.length === 0) return out;

  // Below the guardrail, percentile ordering is meaningless → all "core".
  if (rankable.length < MIN_BOOK_FOR_PERCENTILE) {
    for (const p of rankable) out.set(p.id, { valueTier: "core", valueScore: 50 });
    return out;
  }

  // Recency ranked on negated days-since (most recent → highest rank). A null
  // lastVisit can't reach here (those are emerging), but guard anyway.
  const recencyVals = rankable.map((p) => {
    const d = daysBetween(p.lastVisit, now);
    return d === null ? -Infinity : -d;
  });
  const freqVals = rankable.map((p) => p.totalVisits);
  const monetaryVals = rankable.map((p) => p.netSpendUsd);

  const rRank = percentileRanks(recencyVals);
  const fRank = percentileRanks(freqVals);
  const mRank = percentileRanks(monetaryVals);

  const composite = rankable.map(
    (_p, i) =>
      RFM_WEIGHTS.monetary * mRank[i]! +
      RFM_WEIGHTS.frequency * fRank[i]! +
      RFM_WEIGHTS.recency * rRank[i]!,
  );
  const compositeRank = percentileRanks(composite);

  rankable.forEach((p, i) => {
    const rank = compositeRank[i]!;
    out.set(p.id, {
      valueTier: rank >= TOP_PERCENTILE ? "top" : "core",
      valueScore: Math.round(rank * 100),
    });
  });

  return out;
}
