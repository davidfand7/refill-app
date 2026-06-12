/**
 * Confidence-as-a-gate — the pure verdict for patient matching.
 *
 * Sibling of connection-health's computeVerdict: a single, dependency-free
 * decision function that says how confident a match is, so the agent can ACT
 * when it's sure and DRAFT/ASK when it isn't. The trust-repair rung of the
 * onboarding ladder (project_trusted_onboarding): the gate's whole job is to
 * make "guess silently" impossible — a reward that resolves to more than one
 * patient is HELD for the owner, never auto-credited to whoever sorted first.
 *
 * Honest by construction: this is a deterministic match-tier, not an ML score.
 * "High" means exactly one patient is implicated (or one patient is corroborated
 * by two signals); "ambiguous" means two or more genuinely compete.
 */

export type MatchTier = "learned" | "high" | "ambiguous" | "none";
export type MatchSignal = "alias" | "email" | "phone" | "name";

export interface MatchResolution {
  tier: MatchTier;
  /** The single confident patient node, when tier is "learned" or "high". */
  nodeId: string | null;
  /** Competing candidate node ids when "ambiguous" (length >= 2), else []. */
  candidateIds: string[];
  /** Which signals contributed a hit — drives the own-it copy on the card. */
  signals: MatchSignal[];
}

export interface MatchInput {
  /** A previously-confirmed attribution for this exact contact fingerprint
   *  (correction teaches). When present, it wins outright — the owner already
   *  told us who this is. */
  aliasNodeId?: string | null;
  /** Node ids whose email equals the reward's email (one entry per node). */
  emailIds?: string[];
  /** Node ids whose phone equals the reward's phone. */
  phoneIds?: string[];
  /** Node ids whose name-token key equals the reward's. */
  nameIds?: string[];
}

const uniq = (xs: string[]): string[] => Array.from(new Set(xs));

/**
 * Resolve a reward's contact to a patient with a confidence tier.
 *
 * Order: a learned alias wins; then a single implicated patient is "high";
 * then if exactly one patient is corroborated by ≥2 signals that agreement
 * breaks the tie (e.g. email+name agree while a stray phone collision adds
 * noise); otherwise it's genuinely ambiguous and must be held.
 */
export function resolveMatch(input: MatchInput): MatchResolution {
  if (input.aliasNodeId) {
    return { tier: "learned", nodeId: input.aliasNodeId, candidateIds: [], signals: ["alias"] };
  }

  const sets: Array<{ signal: MatchSignal; ids: string[] }> = [];
  if (input.emailIds?.length) sets.push({ signal: "email", ids: uniq(input.emailIds) });
  if (input.phoneIds?.length) sets.push({ signal: "phone", ids: uniq(input.phoneIds) });
  if (input.nameIds?.length) sets.push({ signal: "name", ids: uniq(input.nameIds) });

  if (sets.length === 0) {
    return { tier: "none", nodeId: null, candidateIds: [], signals: [] };
  }

  const signals = sets.map((s) => s.signal);
  const union = uniq(sets.flatMap((s) => s.ids));

  // Exactly one patient implicated across every signal → confident.
  if (union.length === 1) {
    return { tier: "high", nodeId: union[0], candidateIds: [], signals };
  }

  // More than one. If precisely one patient is named by ≥2 signals, that
  // corroboration disambiguates confidently (e.g. a shared household email
  // produces two candidates, but the reward's NAME picks one of them out).
  const hitCount = new Map<string, number>();
  for (const s of sets) for (const id of s.ids) hitCount.set(id, (hitCount.get(id) ?? 0) + 1);
  const corroborated = [...hitCount.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
  if (corroborated.length === 1) {
    return { tier: "high", nodeId: corroborated[0], candidateIds: [], signals };
  }

  // Genuine competition — do not guess.
  return { tier: "ambiguous", nodeId: null, candidateIds: union, signals };
}

/** Human-readable reason for the hold, used in the own-it card copy. */
export function ambiguityReason(signals: MatchSignal[]): string {
  const has = (s: MatchSignal) => signals.includes(s);
  if (has("email")) return "share an email address";
  if (has("phone")) return "share a phone number";
  if (has("name")) return "have the same name";
  return "look like the same person";
}
