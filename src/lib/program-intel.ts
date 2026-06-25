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

/**
 * Tier RETENTION, not a rebate. A rebate is offensive ("buy N more → unlock X%");
 * maintenance is defensive ("keep ≥ pointsRequired by the deadline or DROP a tier
 * and lose your pricing"). Program-level, deadline-driven; the points come from
 * ANY points-earning treatment, not one product — so its flywheel cohort is the
 * whole lapsed points-earning book, not a single kind.
 */
export type PointsMaintenance = {
  /** The floor — points needed to KEEP the tier by the deadline. */
  pointsRequired: number;
  /** Points earned so far in the maintenance window. */
  pointsCurrent: number;
  /** The tier you keep/lose, as shown ("Director"); display-only. */
  tierAtRisk: string | null;
  /** Deadline exactly as printed ("12/31/2026", "by Q4 end"); display-only. */
  deadlineLabel: string | null;
  /** What's lost if short ("drop to Specialist pricing"); display-only. */
  consequence: string | null;
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
  /** Tier-retention requirement, when the dashboard shows one. null = none
   *  captured (old snapshots predate this field — treated as no maintenance). */
  maintenance: PointsMaintenance | null;
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
  | { kind: "price_changed"; product: string; label: string; from: number; to: number }
  | { kind: "maintenance_added"; tier: string | null }
  | { kind: "maintenance_removed"; tier: string | null }
  | { kind: "maintenance_threshold_changed"; tier: string | null; from: number; to: number }
  | {
      kind: "maintenance_deadline_changed";
      tier: string | null;
      from: string | null;
      to: string | null;
    };

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

  // ── Maintenance (tier-retention RULE changes — floor moved, deadline moved) ──
  // Like everywhere else, progress (pointsCurrent) is ignored; only the rule shifts.
  const pm = prev.maintenance;
  const nm = next.maintenance;
  if (pm && !nm) {
    changes.push({ kind: "maintenance_removed", tier: pm.tierAtRisk });
  } else if (!pm && nm) {
    changes.push({ kind: "maintenance_added", tier: nm.tierAtRisk });
  } else if (pm && nm) {
    if (pm.pointsRequired !== nm.pointsRequired) {
      changes.push({
        kind: "maintenance_threshold_changed",
        tier: nm.tierAtRisk,
        from: pm.pointsRequired,
        to: nm.pointsRequired,
      });
    }
    if (pm.deadlineLabel !== nm.deadlineLabel) {
      changes.push({
        kind: "maintenance_deadline_changed",
        tier: nm.tierAtRisk,
        from: pm.deadlineLabel,
        to: nm.deadlineLabel,
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
    case "maintenance_added":
      return `New tier-retention requirement${c.tier ? ` for ${c.tier}` : ""}.`;
    case "maintenance_removed":
      return `Tier-retention requirement ended${c.tier ? ` for ${c.tier}` : ""}.`;
    case "maintenance_threshold_changed":
      return `${c.tier ? `${c.tier} ` : ""}maintenance floor moved from ${c.from} to ${c.to} points${
        c.to > c.from ? " — you may now be short" : ""
      }.`;
    case "maintenance_deadline_changed":
      return `${c.tier ? `${c.tier} ` : ""}maintenance deadline moved from ${
        c.from ?? "—"
      } to ${c.to ?? "—"}.`;
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
export type FlywheelMove = RebateMove & {
  lapsedInCohort: number | null;
  /** Profitability of acting on this move — $ to gain. Server-filled. */
  worth: MoveWorth | null;
};

// ─── Maintenance move (defensive flywheel — keep your tier, don't lose pricing) ──

/**
 * The retention action. Unlike a rebate move there's no product to buy — the gap
 * is points, earned by ANY points-earning treatment. lapsedInCohort is therefore
 * the whole lapsed points-earning book (caller supplies it; this lib stays pure).
 */
export type MaintenanceMove = {
  pointsShort: number;
  pointsRequired: number;
  pointsCurrent: number;
  tierAtRisk: string | null;
  deadlineLabel: string | null;
  consequence: string | null;
  lapsedInCohort: number | null;
  /** Profitability of holding the tier — $ at risk if you drop. Server-filled. */
  worth: MoveWorth | null;
};

/**
 * Emit a move only when the practice is genuinely short of its maintenance floor
 * (short > 0). At-or-above the floor emits nothing — no false "you're at risk"
 * (honesty, same as achieved rebates).
 */
export function deriveMaintenanceMove(snapshot: ProgramSnapshot): MaintenanceMove | null {
  const m = snapshot.maintenance;
  if (!m) return null;
  const short = m.pointsRequired - m.pointsCurrent;
  if (short <= 0) return null;
  return {
    pointsShort: short,
    pointsRequired: m.pointsRequired,
    pointsCurrent: m.pointsCurrent,
    tierAtRisk: m.tierAtRisk,
    deadlineLabel: m.deadlineLabel,
    consequence: m.consequence,
    lapsedInCohort: null,
    worth: null,
  };
}

/** "Earn 220 more points by 12/31 → keep your Director pricing." */
export function maintenanceHeadline(m: MaintenanceMove): string {
  const by = m.deadlineLabel ? ` by ${m.deadlineLabel}` : "";
  const keep = m.tierAtRisk ? `keep your ${m.tierAtRisk} status` : "keep your tier";
  return `Earn ${m.pointsShort} more points${by} → ${keep}.`;
}

// ─── Profitability worth (the "what's this worth to my bottom line" calc) ─────

/**
 * The dollars-on-it for a move, computed from the spa's REAL trailing-365d
 * manufacturer spend (GIGO-free — the burn-rate doctrine: spend is safe to
 * display, only unit estimates aren't). Offensive (rebate) = $ to GAIN;
 * defensive (maintenance) = $ AT RISK. Both ride on rebatePct × annualVolume,
 * the one arithmetic neither side can fake. `null` when we can't compute
 * honestly (no volume, or no rebate %).
 */
export type MoveWorth = {
  /** true = $ AT RISK (defensive/maintenance); false = $ to GAIN (rebate). */
  defensive: boolean;
  /** Trailing-365d manufacturer spend the value is computed on (GIGO-free). */
  annualVolumeUsd: number;
  /** The rebate % the recurring value rides on. */
  rebatePct: number;
  /** rebatePct% × annualVolumeUsd — recurring annual $ unlocked or at risk. */
  rebateValueUsd: number;
  /** One-time $ to buy the units that close a rebate gap (rebate moves only). */
  costToReachUsd: number | null;
  /** What's deliberately NOT counted yet (honest), or null. */
  caveat: string | null;
};

/** Worth of an offensive rebate move — unlock rebatePct on the annual book. */
export function rebateMoveWorth(args: {
  rebatePct: number | null;
  annualVolumeUsd: number | null;
  unitsShort: number;
  unitPriceUsd: number | null;
}): MoveWorth | null {
  if (args.rebatePct == null || args.rebatePct <= 0) return null;
  if (args.annualVolumeUsd == null || args.annualVolumeUsd <= 0) return null;
  const rebateValueUsd = Math.round(args.annualVolumeUsd * (args.rebatePct / 100));
  const costToReachUsd =
    args.unitPriceUsd != null && args.unitPriceUsd > 0
      ? Math.round(args.unitsShort * args.unitPriceUsd)
      : null;
  return {
    defensive: false,
    annualVolumeUsd: args.annualVolumeUsd,
    rebatePct: args.rebatePct,
    rebateValueUsd,
    costToReachUsd,
    caveat: null,
  };
}

/** Worth of a defensive maintenance move — the rebate $ that rides on the tier. */
export function maintenanceMoveWorth(args: {
  atRiskRebatePct: number | null;
  annualVolumeUsd: number | null;
}): MoveWorth | null {
  if (args.atRiskRebatePct == null || args.atRiskRebatePct <= 0) return null;
  if (args.annualVolumeUsd == null || args.annualVolumeUsd <= 0) return null;
  const rebateValueUsd = Math.round(args.annualVolumeUsd * (args.atRiskRebatePct / 100));
  return {
    defensive: true,
    annualVolumeUsd: args.annualVolumeUsd,
    rebatePct: args.atRiskRebatePct,
    rebateValueUsd,
    costToReachUsd: null,
    caveat:
      "Plus higher per-unit pricing if you drop a tier — capture your lower-tier price to add that.",
  };
}

/** One-liner for the worth reveal. */
export function worthHeadline(w: MoveWorth): string {
  const v = `$${w.rebateValueUsd.toLocaleString()}`;
  const vol = `$${w.annualVolumeUsd.toLocaleString()}/yr`;
  return w.defensive
    ? `~${v}/yr at risk — your ${w.rebatePct}% rebate rides on ~${vol} of volume.`
    : `~${v}/yr — ${w.rebatePct}% back on ~${vol} of volume at your current pace.`;
}
