/**
 * Smart-A/B — the impartial-arbiter bandit (v2.95, crown-jewel mechanism).
 *
 * The thesis (project_manufacturer_ab_arbiter): when an offer runs as several
 * variants, the winner is decided by REAL CUSTOMER BOOKINGS — "customers vote"
 * — and an impartial AI bandit measures it. Not SmartSpa choosing, not the spa
 * owner, not the manufacturer. The market votes (patients book), the AI
 * measures, the result is objective. That impartiality is the trust unlock
 * that makes the promo-performance verdict sellable to manufacturers.
 *
 * The math, kept pure + deterministic (seedable RNG) so it's testable and so a
 * verdict is reproducible from the same counts:
 *
 *   • Each arm is a Beta-Bernoulli posterior over its booking rate:
 *       Beta(conversions + 1, impressions − conversions + 1)   (uniform prior)
 *   • thompsonPickArm — sample each arm's posterior once, pick the max. This is
 *     Thompson sampling: arms that look better are chosen more, but uncertainty
 *     keeps exploring, so almost no reach is spent on a losing variant.
 *   • computeVerdict — Monte-Carlo each arm's posterior and count how often it's
 *     the max → P(arm is best). The winner's probability IS the confidence; the
 *     lift is winner-rate ÷ runner-up-rate. Auto-stop once the winner clears a
 *     probability threshold with enough sample.
 *
 * No DB, no I/O — callers (smart-ab.functions.ts) own persistence + wiring.
 */

export type AbArm = {
  /** The arm's offer id (each variant is a row in manufacturer_promo_offers). */
  id: string;
  /** Short human label for the verdict UI — "20% off", "$50 off". */
  label: string;
  /** How many patients were assigned/sent this arm. */
  impressions: number;
  /** How many of those booked (the "votes"). */
  conversions: number;
};

export type AbArmResult = {
  id: string;
  label: string;
  impressions: number;
  conversions: number;
  /** Observed booking rate (conversions / impressions); 0 when no impressions. */
  rate: number;
  /** P(this arm is the best of all arms), from the posterior Monte-Carlo. */
  winProb: number;
};

export type AbVerdict = {
  arms: AbArmResult[];
  /** The current front-runner (highest winProb), or null with no data. */
  best: { id: string; label: string } | null;
  /** Winner rate ÷ best-other-arm rate. null when not computable (single arm,
   *  or runner-up rate 0). e.g. 1.8 → "books 1.8× more". */
  lift: number | null;
  /** Confidence the front-runner is truly best = its winProb (0..1). */
  confidence: number;
  /** True once confidence ≥ threshold AND the sample floor is met — the bandit
   *  has seen enough to call it and auto-switch everyone to the winner. */
  recommendStop: boolean;
  totalImpressions: number;
  totalConversions: number;
};

export type AbVerdictOptions = {
  /** Confidence to auto-stop at. Mockup auto-stopped at ~0.82; default 0.85. */
  stopThreshold?: number;
  /** Min total impressions before a stop can be recommended (guards against an
   *  early lucky streak calling it on n=3). */
  minImpressions?: number;
  /** Monte-Carlo draws per arm for the win-probability estimate. */
  samples?: number;
  /** Seed so a given set of counts yields a stable verdict (testable + the UI
   *  doesn't jitter between reads). */
  seed?: number;
};

// ── Seedable RNG (mulberry32) ───────────────────────────────────────────────
// Deterministic so verdicts are reproducible. Math.random would make the same
// counts render slightly different win-probabilities on every page load.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Beta sampling via two Gamma draws (Marsaglia–Tsang) ─────────────────────
// Beta(α,β) = X/(X+Y), X~Gamma(α,1), Y~Gamma(β,1). α,β ≥ 1 here (uniform prior
// + non-negative counts), so the boosted-shape path is always valid.
function gammaSample(shape: number, rng: () => number): number {
  // Marsaglia–Tsang for shape ≥ 1.
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Box–Muller normal from the uniform rng.
  const normal = (): number => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  for (;;) {
    let x = normal();
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng();
    x = x * x;
    if (u < 1 - 0.0331 * x * x) return d * v;
    if (Math.log(u) < 0.5 * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaSample(alpha: number, beta: number, rng: () => number): number {
  const x = gammaSample(alpha, rng);
  const y = gammaSample(beta, rng);
  return x / (x + y);
}

/** Posterior parameters for an arm under a uniform Beta(1,1) prior. */
function posterior(arm: AbArm): { alpha: number; beta: number } {
  const imp = Math.max(0, Math.floor(arm.impressions));
  const conv = Math.min(imp, Math.max(0, Math.floor(arm.conversions)));
  return { alpha: conv + 1, beta: imp - conv + 1 };
}

/**
 * Thompson sampling: draw one sample from each arm's posterior, return the
 * arm with the highest draw. Use this to assign the NEXT patient/send — it
 * shifts reach toward the front-runner while still exploring uncertain arms.
 * Returns null only for an empty arm list.
 */
export function thompsonPickArm(arms: AbArm[], seed?: number): AbArm | null {
  if (arms.length === 0) return null;
  if (arms.length === 1) return arms[0];
  const rng = mulberry32(seed ?? 0x9e3779b9);
  let bestArm = arms[0];
  let bestDraw = -1;
  for (const arm of arms) {
    const { alpha, beta } = posterior(arm);
    const draw = betaSample(alpha, beta, rng);
    if (draw > bestDraw) {
      bestDraw = draw;
      bestArm = arm;
    }
  }
  return bestArm;
}

/**
 * The verdict: win-probability per arm (Monte-Carlo over the posteriors), the
 * front-runner, the lift vs the runner-up, and whether the bandit has seen
 * enough to auto-stop. This is what the "see the numbers" view renders and what
 * the manufacturer-facing arbiter summarizes.
 */
export function computeVerdict(arms: AbArm[], opts: AbVerdictOptions = {}): AbVerdict {
  const stopThreshold = opts.stopThreshold ?? 0.85;
  const minImpressions = opts.minImpressions ?? 30;
  const samples = opts.samples ?? 3000;
  const rng = mulberry32(opts.seed ?? 0x1234abcd);

  const totalImpressions = arms.reduce((s, a) => s + Math.max(0, a.impressions), 0);
  const totalConversions = arms.reduce((s, a) => s + Math.max(0, a.conversions), 0);

  const rates = arms.map((a) =>
    a.impressions > 0 ? a.conversions / a.impressions : 0,
  );

  // Monte-Carlo win counts: each round, sample every arm's posterior and credit
  // the arm with the max draw.
  const wins = new Array(arms.length).fill(0);
  if (arms.length > 0) {
    const post = arms.map(posterior);
    for (let s = 0; s < samples; s++) {
      let bi = 0;
      let bd = -1;
      for (let i = 0; i < arms.length; i++) {
        const draw = betaSample(post[i].alpha, post[i].beta, rng);
        if (draw > bd) {
          bd = draw;
          bi = i;
        }
      }
      wins[bi] += 1;
    }
  }

  const armResults: AbArmResult[] = arms.map((a, i) => ({
    id: a.id,
    label: a.label,
    impressions: a.impressions,
    conversions: a.conversions,
    rate: rates[i],
    winProb: arms.length > 0 ? wins[i] / samples : 0,
  }));

  // Front-runner = highest win-probability.
  let bestIdx = -1;
  for (let i = 0; i < armResults.length; i++) {
    if (bestIdx === -1 || armResults[i].winProb > armResults[bestIdx].winProb) bestIdx = i;
  }
  const best = bestIdx >= 0 ? { id: armResults[bestIdx].id, label: armResults[bestIdx].label } : null;
  const confidence = bestIdx >= 0 ? armResults[bestIdx].winProb : 0;

  // Lift = winner rate ÷ best OTHER arm's rate.
  let lift: number | null = null;
  if (bestIdx >= 0) {
    let runnerRate = 0;
    for (let i = 0; i < rates.length; i++) {
      if (i !== bestIdx && rates[i] > runnerRate) runnerRate = rates[i];
    }
    if (runnerRate > 0) lift = rates[bestIdx] / runnerRate;
  }

  const recommendStop =
    arms.length >= 2 && confidence >= stopThreshold && totalImpressions >= minImpressions;

  return {
    arms: armResults,
    best,
    lift,
    confidence,
    recommendStop,
    totalImpressions,
    totalConversions,
  };
}

/** "books 1.8× more" / "books about as often" — the plain-English lift phrase. */
export function liftPhrase(lift: number | null): string {
  if (lift == null) return "is the early front-runner";
  if (lift >= 1.15) return `books ${lift.toFixed(1)}× more`;
  if (lift <= 0.87) return `books ${(1 / lift).toFixed(1)}× fewer`;
  return "books about as often";
}
