/**
 * Phase 2 brain — Purchase & Rebate Intelligence (project_rebate_purchase_intelligence).
 *
 * Pure logic, no DB / network / portal. Three jobs:
 *   1. MODEL   — a normalized snapshot of a manufacturer's practice-rewards
 *                program (membership tiers, rebate trackers, signature pricing),
 *                grounded in the real ASPIRE dashboard shapes.
 *   2. DIFF    — compare two snapshots over time and surface RULE changes
 *                (a threshold moved, a tier shifted, a price changed) — the
 *                "Galderma raised the Brand Adoption minimum from 8 to 10, you're
 *                now 2 short" detector. THE moat feature: only possible because we
 *                snapshot daily and hold the time-series no one else has.
 *   3. MOVES   — derive the dollar-on-it action: "buy/treat N more units of X to
 *                unlock the Y% rebate." The hook the recall flywheel grabs.
 *
 * IMPORTANT — no hardcoded thresholds. This file never asserts what a tier or
 * minimum IS; it operates on whatever snapshot it's handed. The programs churn
 * constantly (that's the moat), so the rules live in the data, never in code.
 * The portal PULL that fills snapshots and the migration that persists them are
 * separate, gated slices (need a live run + a SQL paste).
 */

// ─── Model ──────────────────────────────────────────────────────────────────

export type ProgramTier = {
  name: string;
  minPoints: number;
  /** null = open-ended top tier (e.g. "Top 1% — 6,000+"). */
  maxPoints: number | null;
};

export type RebateUnit = "syringes" | "vials" | "kits" | "units" | "usd";

export type RebateRequirement = {
  /** Normalized product keyword (compatible with the promo matcher's keys). */
  product: string;
  /** Human label exactly as shown ("Restylane Refyne"). */
  label: string;
  required: number;
  current: number;
  unit: RebateUnit;
};

export type RebateStatus = "achieved" | "in_progress" | "not_eligible";

export type RebateProgram = {
  /** Stable key for diffing across pulls ('brand_adoption' | 'rise' | …). */
  key: string;
  label: string;
  rebatePct: number | null;
  status: RebateStatus;
  /** Why not_eligible / any caveat shown ("$0 invoice in a baseline quarter"). */
  note: string | null;
  requirements: RebateRequirement[];
};

export type ProgramPrice = {
  product: string;
  label: string;
  unitPriceUsd: number;
};

export type ProgramSnapshot = {
  manufacturer: string;
  /** ISO timestamp of the pull this snapshot came from (freshness). */
  pulledAt: string;
  currentTier: string | null;
  pointsCurrent: number | null;
  pointsToNextTier: number | null;
  tiers: ProgramTier[];
  rebates: RebateProgram[];
  pricing: ProgramPrice[];
};

// ─── Diff (the rules-moved-under-you detector) ──────────────────────────────

export type ProgramChange =
  | { kind: "rebate_added"; rebate: string }
  | { kind: "rebate_removed"; rebate: string }
  | { kind: "rebate_pct_changed"; rebate: string; from: number | null; to: number | null }
  | { kind: "requirement_added"; rebate: string; product: string; label: string }
  | { kind: "requirement_removed"; rebate: string; product: string; label: string }
  | {
      kind: "requirement_threshold_changed";
      rebate: string;
      product: string;
      label: string;
      from: number;
      to: number;
    }
  | { kind: "tier_added"; tier: string }
  | { kind: "tier_removed"; tier: string }
  | {
      kind: "tier_threshold_changed";
      tier: string;
      field: "minPoints" | "maxPoints";
      from: number | null;
      to: number | null;
    }
  | { kind: "price_changed"; product: string; label: string; from: number; to: number };

const byKey = <T,>(items: T[], key: (t: T) => string): Map<string, T> => {
  const m = new Map<string, T>();
  for (const it of items) m.set(key(it), it);
  return m;
};

/**
 * RULE changes only — deliberately ignores progress (a requirement's `current`
 * count changes every pull as the practice buys; that's not a rule change). We
 * diff `required`, `rebatePct`, tier thresholds, and prices. This is what the
 * owner can't see for themselves and what nobody else has the history to compute.
 */
export function diffSnapshots(
  prev: ProgramSnapshot,
  next: ProgramSnapshot,
): ProgramChange[] {
  const changes: ProgramChange[] = [];

  // ── Rebates ──
  const prevReb = byKey(prev.rebates, (r) => r.key);
  const nextReb = byKey(next.rebates, (r) => r.key);
  for (const [key, nr] of nextReb) {
    const pr = prevReb.get(key);
    if (!pr) {
      changes.push({ kind: "rebate_added", rebate: nr.label });
      continue;
    }
    if (pr.rebatePct !== nr.rebatePct) {
      changes.push({
        kind: "rebate_pct_changed",
        rebate: nr.label,
        from: pr.rebatePct,
        to: nr.rebatePct,
      });
    }
    const prevReq = byKey(pr.requirements, (q) => q.product);
    const nextReq = byKey(nr.requirements, (q) => q.product);
    for (const [p, nq] of nextReq) {
      const pq = prevReq.get(p);
      if (!pq) {
        changes.push({ kind: "requirement_added", rebate: nr.label, product: p, label: nq.label });
      } else if (pq.required !== nq.required) {
        changes.push({
          kind: "requirement_threshold_changed",
          rebate: nr.label,
          product: p,
          label: nq.label,
          from: pq.required,
          to: nq.required,
        });
      }
    }
    for (const [p, pq] of prevReq) {
      if (!nextReq.has(p)) {
        changes.push({ kind: "requirement_removed", rebate: pr.label, product: p, label: pq.label });
      }
    }
  }
  for (const [key, pr] of prevReb) {
    if (!nextReb.has(key)) changes.push({ kind: "rebate_removed", rebate: pr.label });
  }

  // ── Tiers ──
  const prevTier = byKey(prev.tiers, (t) => t.name);
  const nextTier = byKey(next.tiers, (t) => t.name);
  for (const [name, nt] of nextTier) {
    const pt = prevTier.get(name);
    if (!pt) {
      changes.push({ kind: "tier_added", tier: name });
      continue;
    }
    if (pt.minPoints !== nt.minPoints) {
      changes.push({
        kind: "tier_threshold_changed",
        tier: name,
        field: "minPoints",
        from: pt.minPoints,
        to: nt.minPoints,
      });
    }
    if (pt.maxPoints !== nt.maxPoints) {
      changes.push({
        kind: "tier_threshold_changed",
        tier: name,
        field: "maxPoints",
        from: pt.maxPoints,
        to: nt.maxPoints,
      });
    }
  }
  for (const [name] of prevTier) {
    if (!nextTier.has(name)) changes.push({ kind: "tier_removed", tier: name });
  }

  // ── Pricing ──
  const prevPrice = byKey(prev.pricing, (p) => p.product);
  for (const np of next.pricing) {
    const pp = prevPrice.get(np.product);
    if (pp && pp.unitPriceUsd !== np.unitPriceUsd) {
      changes.push({
        kind: "price_changed",
        product: np.product,
        label: np.label,
        from: pp.unitPriceUsd,
        to: np.unitPriceUsd,
      });
    }
  }

  return changes;
}

/** A short, owner-facing line for a detected change — for the alert/feed. */
export function changeHeadline(c: ProgramChange): string {
  switch (c.kind) {
    case "rebate_added":
      return `New rebate available: ${c.rebate}.`;
    case "rebate_removed":
      return `Rebate ended: ${c.rebate}.`;
    case "rebate_pct_changed":
      return `${c.rebate} rebate changed from ${pct(c.from)} to ${pct(c.to)}.`;
    case "requirement_added":
      return `${c.rebate} added a requirement: ${c.label}.`;
    case "requirement_removed":
      return `${c.rebate} dropped a requirement: ${c.label}.`;
    case "requirement_threshold_changed":
      return `${c.rebate}: ${c.label} minimum moved from ${c.from} to ${c.to}${
        c.to > c.from ? " — you may now be short" : ""
      }.`;
    case "tier_added":
      return `New membership level: ${c.tier}.`;
    case "tier_removed":
      return `Membership level removed: ${c.tier}.`;
    case "tier_threshold_changed":
      return `${c.tier} ${c.field === "minPoints" ? "entry" : "ceiling"} moved from ${
        c.from ?? "—"
      } to ${c.to ?? "—"} points.`;
    case "price_changed":
      return `${c.label} price changed from $${c.from.toFixed(2)} to $${c.to.toFixed(2)}.`;
  }
}

const pct = (n: number | null): string => (n == null ? "—" : `${n}%`);

// ─── Moves (the dollar-on-it action / flywheel hook) ────────────────────────

export type RebateMove = {
  rebate: string;
  rebateKey: string;
  rebatePct: number | null;
  product: string;
  productLabel: string;
  unit: RebateUnit;
  /** required − current, always > 0 for an emitted move. */
  unitsShort: number;
};

/**
 * For each rebate that is still IN PROGRESS, every requirement the practice is
 * short on becomes a move ("buy/treat N more X"). Achieved rebates emit nothing
 * (no false "you're short" — honesty), and not_eligible rebates emit nothing
 * (a structural disqualification like a $0 baseline quarter can't be fixed by
 * buying more this quarter — the surface shows the note instead).
 */
export function deriveRebateMoves(snapshot: ProgramSnapshot): RebateMove[] {
  const moves: RebateMove[] = [];
  for (const r of snapshot.rebates) {
    if (r.status !== "in_progress") continue;
    for (const q of r.requirements) {
      const short = q.required - q.current;
      if (short > 0) {
        moves.push({
          rebate: r.label,
          rebateKey: r.key,
          rebatePct: r.rebatePct,
          product: q.product,
          productLabel: q.label,
          unit: q.unit,
          unitsShort: short,
        });
      }
    }
  }
  // Closest-to-unlock first — smallest gap is the easiest dollar to capture.
  moves.sort((a, b) => a.unitsShort - b.unitsShort);
  return moves;
}

/** A reward phrase that doesn't double "rebate" (labels already end in it). */
function rewardPhrase(m: { rebate: string; rebatePct: number | null }): string {
  return m.rebatePct != null ? `the ${m.rebatePct}% ${m.rebate}` : m.rebate;
}

/** "Buy 10 more Restylane Refyne syringes → unlock the 3% Brand Adoption Rebate" */
export function moveHeadline(m: RebateMove): string {
  const unit = m.unit === "usd" ? "" : ` ${m.unit}`;
  return `Buy ${m.unitsShort} more ${m.productLabel}${unit} → unlock ${rewardPhrase(m)}.`;
}

/**
 * The flywheel join: a move + how many lapsed patients in the matching cohort
 * (the caller supplies the count from the recall engine — this lib stays pure).
 * "You're 10 Refyne short; you have 14 lapsed filler patients due — recall 10
 * and hit the rebate AND recover the patients."
 */
export type FlywheelMove = RebateMove & { lapsedInCohort: number | null };

export function flywheelHeadline(m: FlywheelMove): string {
  if (m.lapsedInCohort == null || m.lapsedInCohort <= 0) return moveHeadline(m);
  return `You're ${m.unitsShort} ${m.productLabel} short of ${rewardPhrase(m)} — and you have ${
    m.lapsedInCohort
  } lapsed patient${
    m.lapsedInCohort === 1 ? "" : "s"
  } due. Recall them and you hit the rebate and recover the patients.`;
}
