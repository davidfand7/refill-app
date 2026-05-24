/**
 * Agent Memory Graph schema conventions — the layered shapes our agents
 * (Karen, Liz) interpret on top of the generic knowledge_nodes table.
 *
 * The base table (knowledge_nodes) has:
 *   id, user_id, node_type, title, content, context, lookup_key,
 *   lookup_type, weight, attachments (JSON), source, source_ref,
 *   created_at, last_referenced_at, connected_agent_id
 *
 * The conventions below describe how we structure node_type values, the
 * attachments JSON shape per node_type, and the compliance metadata
 * that lives on drug/device-related nodes. These are HUMAN-PROVENANCE
 * conventions — the database doesn't enforce them; agents and server
 * functions do.
 *
 * Established 2026-05-09 as part of the Liz / Spa-Karen productization
 * dev kickoff. Single source of truth for tier/promotion/compliance
 * shapes referenced from karen-prompt.ts, liz-prompt.ts, the upcoming
 * Liz CSV import, and any future tooling that reads/writes these
 * shapes. To extend: add a new TypeScript type below, document the
 * node_type or attachments shape, and update agents' prompts to know
 * about it.
 *
 * See also: project_med_aesthetics_plan_locked.md (auto-memory).
 */

// ── Compliance metadata (drug / device / clinical-claim nodes) ─────────────
// Lives on knowledge_nodes.attachments for any node representing a product,
// treatment, or clinical claim. Liz's prompt enforces an off-label firewall
// based on these flags; Karen's clinical-question logic respects them too.

export type LabelStatus =
  /** FDA-approved use; agent may recommend confidently. */
  | "on-label"
  /** FDA-approved drug, off-label use; agent acknowledges but never promotes. */
  | "off-label"
  /** General industry / clinical knowledge, not drug-specific. */
  | "general-clinical";

export type ContentSource =
  /** Authoritative FDA label data. */
  | "FDA-approved-label"
  /** Manufacturer-uploaded content (Wedge offer #2 territory — deferred). */
  | "manufacturer-authored"
  /** Owner / rep added directly via UI. */
  | "user-input"
  /** FireCrawl from public manufacturer / spa websites. */
  | "scraped-public"
  /** Agent learned via memory_graph_upsert during a conversation. */
  | "agent-crystallized";

export type ComplianceMetadata = {
  /** Whether content is on-label, off-label, or general clinical. */
  label_status: LabelStatus;
  /** Where the content originated. */
  source: ContentSource;
  /** FDA label version (date) when applicable, e.g. "2024-03-15". */
  label_version?: string;
  /** URL of FDA label PDF or canonical manufacturer page. */
  label_url?: string;
};

// ── Per-account multi-dimensional tier (Liz) ───────────────────────────────
// Lives on attachments.tiers for client/account nodes. A single account can
// be at different tiers across product families simultaneously
// (Platinum-on-Juvederm + Gold-on-Restylane + Silver-on-Botox).
//
// Family paths use dotted notation; new families can be added without
// schema migration since attachments is JSON. Liz's prompt knows to pull
// the correct family per question.

export type ProductFamily =
  // Toxins
  | "toxins.botox"
  | "toxins.dysport"
  | "toxins.jeuveau"
  | "toxins.xeomin"
  // Hyaluronic acid fillers
  | "fillers.juvederm"
  | "fillers.restylane"
  | "fillers.rha"
  // Biostimulators
  | "biostimulators.sculptra"
  | "biostimulators.radiesse"
  // Skin boosters
  | "skin_boosters.skinvive"
  | "skin_boosters.profhilo"
  // Future families: extend this union OR pass a string. The runtime
  // doesn't enforce; the LLM uses the dotted convention as taxonomy.
  | (string & {});

/** Tier levels are manufacturer-defined; common tiers across programs. */
export type TierLevel =
  | "Bronze"
  | "Silver"
  | "Gold"
  | "Platinum"
  | "Diamond"
  | (string & {});

export type AccountTier = {
  /** Product family this tier applies to (dotted path). */
  family: ProductFamily;
  /** Current tier level. */
  tier: TierLevel;
  /** Quarter-to-date volume (units / dollars / points — manufacturer-defined). */
  qtd_volume?: number;
  /** Volume needed to MAINTAIN current tier through next quarter. */
  threshold_to_maintain?: number;
  /** Volume needed to ADVANCE to next tier. */
  threshold_to_advance?: number;
  /** Quarter end date (ISO yyyy-mm-dd). */
  qtr_end?: string;
};

/** Which rep persona this account belongs to in the demo seed.
 * Used by `/app/rep/accounts` to filter views per manufacturer's rep and
 * by Liz to scope tier reasoning to the rep's actual primary manufacturer. */
export type RepAssignment =
  | "allergan-rep"
  | "galderma-rep"
  | "evolus-rep"
  | "merz-rep"
  | (string & {});

/** Shape of attachments JSON on a client/account knowledge_node. */
export type AccountAttachments = {
  tiers?: AccountTier[];
  /** Which rep persona's territory this account belongs to (demo seed). */
  rep_assignment?: RepAssignment;
  /** Free-form additional metadata (last visit, contact, etc.). */
  [key: string]: unknown;
};

// ── Promotion node (Liz) ───────────────────────────────────────────────────
// node_type='promotion'. Attachments hold eligibility rules + tier-specific
// benefits. Liz queries these for use cases #1 (order assistance) and
// #2 (tiered promo blast).

export type PromotionTierBenefit = {
  /** Tier this benefit applies to. */
  tier: TierLevel;
  /** Description of the tier-specific benefit (LLM reasons over this). */
  benefit: string;
};

/** v334: structured buy-in tier within a promotion. Captures the actual
 *  shape we observed from real Evolus + Allergan + Galderma promo dashboards:
 *  each tier has a promo code + a volume range + some combination of per-unit
 *  discount, flat-price, physical goods (scrubs, branded merch), and rewards
 *  credit. The Promotions Engine operates over this structured form rather
 *  than the older free-text `tier_benefits` field. */
export type PromotionBuyInTier = {
  /** Promo code the practice enters at checkout (e.g. "7QUEEN", "TIU2"). */
  code: string;
  /** Human-readable label (e.g. "Buy 50-99 vials"). */
  label: string;
  /** Minimum units to qualify for this tier. */
  min_units: number;
  /** Maximum units that still qualify for this tier (omit on the top tier). */
  max_units?: number;
  /** Per-unit discount in USD (mutually exclusive with flat_price_per_unit_usd). */
  discount_per_unit_usd?: number;
  /** Flat per-unit price (e.g. Tier-It-Up's $375/vial — replaces list price). */
  flat_price_per_unit_usd?: number;
  /** Physical goods bundled (branded scrubs, training kits, etc.). */
  physical_goods?: Array<{
    kind: string;        // "scrubs", "training_kit", "branded_merch"
    quantity: number;
    note?: string;
  }>;
  /** Rewards-program credit included with this tier (USD). */
  rewards_credit_usd?: number;
  /** Additional free-text notes (legal disclaimers, special conditions). */
  notes?: string;
};

export type PromotionKind =
  | "anniversary"
  | "tier-upgrade"
  | "patient-rewards"
  | "seasonal"
  | "other";

export type PromotionAttachments = {
  /** Manufacturer running the promotion (AbbVie / Galderma / Evolus / Merz). */
  manufacturer?: string;
  /** v334: structured promo kind enum. */
  promo_kind?: PromotionKind;
  /** v334: explicit name (mirrors knowledge_nodes.title; redundant on purpose
   *  so prompt context has it under a stable key). */
  name?: string;
  /** v334: hero image URL for the promo card (manufacturer's marketing art). */
  hero_image_url?: string;
  /** v334: source URL the promo was scraped/ingested from. */
  source_url?: string;
  /** Product families this promo applies to. */
  applies_to?: ProductFamily[];
  /** Eligibility rules in plain English (LLM reasons over this). */
  eligibility_rules?: string;
  /** Threshold for qualification (units, combos, dollars). */
  threshold?: string;
  /** Promotion start (ISO yyyy-mm-dd). */
  starts?: string;
  /** Promotion end / deadline (ISO yyyy-mm-dd). */
  ends?: string;
  /** v334: structured buy-in tier ladder (Q/K/A in Jeuveau, TIU1-5 in
   *  Tier-It-Up). Engine reads this directly; Liz reasons over it. */
  tiers?: PromotionBuyInTier[];
  /** Per-tier benefits — legacy free-text shape; kept for backwards
   *  compatibility with v319 nodes. New seeds populate `tiers` instead. */
  tier_benefits?: PromotionTierBenefit[];
  /** Fine print / terms (legal disclaimers, exclusions). */
  terms_fine_print?: string;
  /** v334: when this promo is one of two concurrent promos from the same
   *  manufacturer, list the other promos' knowledge_node lookup_keys so Liz
   *  can compute combined / either/or recommendations. */
  competitor_concurrent?: string[];
  [key: string]: unknown;
};

// ── Product node (Liz) ─────────────────────────────────────────────────────
// node_type='product'. Pre-seeded via FireCrawl from manufacturer HCP sites
// for the four main injectable manufacturers + their product lines.

/** Crosslinking / structural technology family for HA fillers + biostimulators. */
export type ProductTechnology =
  | "Vycross"
  | "Hylacross"
  | "XpresHAn"
  | "NASHA"
  | "CPM"
  | "Resilient Hyaluronic Acid"
  | "Calcium Hydroxylapatite"
  | "Poly-L-Lactic Acid"
  | "Toxin"
  | (string & {});

/** Rheology — projection capacity (elastic modulus G'). High = strong lift; low = soft integration. */
export type GPrime = "low" | "medium" | "high";

export type ProductAttachments = {
  /** Manufacturer (AbbVie / Galderma / Evolus / Merz / other). */
  manufacturer: string;
  /** Product family path (matches AccountTier.family). */
  family: ProductFamily;
  /** SKUs / unit sizes available (e.g. ["1mL syringe", "2mL syringe"]). */
  skus?: string[];
  /** On-label indications (FDA-approved uses). */
  indications?: string[];
  /** Mechanism of action (high-level, plain English). */
  moa?: string;
  /** Common contraindications. */
  contraindications?: string[];
  /** Compliance metadata (label provenance). */
  compliance: ComplianceMetadata;
  // ── Comparison axes (used by Liz to answer "X vs Y" questions) ─────────────
  /** Crosslinking / structural technology. */
  technology?: ProductTechnology;
  /** Rheology / projection capacity. */
  g_prime?: GPrime;
  /** Short free-text vibe — e.g. "soft natural", "firm structure midface". */
  vibe?: string;
  /** Anatomic zones / use cases — e.g. ["lips", "tear trough"]. */
  best_for?: string[];
  /** Rep's one-liner — the angle to lead with when pitching this product. */
  sales_angle?: string;
  [key: string]: unknown;
};

// ── Note node (Liz) ────────────────────────────────────────────────────────
// node_type='note'. Free-form rep-entered notes about an account.
// Lives alongside the account node; lookup_key=account_name typically.

export type NoteAttachments = {
  /** Topic tag for filtering ("contact", "competitive", "renovation", etc.). */
  topic?: string;
  /** Optional date the observation was made. */
  observed_at?: string;
  [key: string]: unknown;
};

// ── Manufacturer tier rule node (Liz) ──────────────────────────────────────
// node_type='manufacturer-tier-rule'. One node per (manufacturer, tier).
// Canonical 2026 partnership-program rules — Allergan / Galderma / Evolus /
// Merz. Each manufacturer uses a different tier model (points / spend /
// order / portfolio), so the requirement + benefit shapes are intentionally
// loose; the source of truth is the free-text `text` field.

export type TierModel =
  /** Cross-product points (Allergan APP). */
  | "points"
  /** Pure $ spend thresholds (Galderma). */
  | "spend"
  /** Order-quantity thresholds, e.g. syringe minimums (Evolus). */
  | "order"
  /** Portfolio breadth — number of categories purchased (Merz). */
  | "portfolio";

export type TierRuleRequirement = {
  /** Plain-English rule for what qualifies. Source of truth. */
  text: string;
  /** Lower bound of the qualifying range, in the relevant units. */
  min_value?: number;
  /** Upper bound (open-ended top tier omits). */
  max_value?: number;
  /** Units the values are in — "points", "dollars", "syringes", "categories". */
  units?: string;
};

export type TierRuleBenefit = {
  /** Plain-English description of what the rep/account gets at this tier. */
  text: string;
  /** Headline rebate percent if applicable (e.g. 8 for "8% rebate"). */
  rebate_pct?: number;
  /** Free-form extras — co-op funds, marketing credits, consulting, etc. */
  extras?: string[];
};

export type TierRuleAttachments = {
  /** Manufacturer ("Allergan Aesthetics" / "Galderma" / "Evolus" / "Merz Aesthetics"). */
  manufacturer: string;
  /** Tier name as published by the manufacturer ("Diamond", "Mid-Tier Spend", "Tier 2 (Growth)", "Level 1 (Silver)"). */
  tier_label: string;
  /** Which tier model the manufacturer uses. */
  tier_model: TierModel;
  /** What qualifies an account for this tier. */
  requirement: TierRuleRequirement;
  /** What the account gets at this tier. */
  benefit: TierRuleBenefit;
  /** Compliance metadata (always general-clinical / manufacturer-authored for tier rules). */
  compliance: ComplianceMetadata;
  [key: string]: unknown;
};

// ── Product comparison node (Liz) ──────────────────────────────────────────
// node_type='product-comparison'. Captures pair-wise (or multi-way) clinical
// + commercial framing that isn't a property of either product alone —
// e.g. "Volbella vs Kysse: both lip-focused but Kysse has higher G-Prime
// for more projection while Volbella crosses over to tear-trough use."

export type ComparisonAttachments = {
  /** Lookup keys of the products being compared (typically 2; can be more for category-wide head-to-heads). */
  products: string[];
  /** Which axes are covered — "manufacturer", "technology", "g_prime", "vibe", "best_for", "sales_angle", "duration", "indications". */
  axes_compared: string[];
  /** Short summary of the differences (Liz paraphrases this). */
  summary: string;
  /** The rep's framing for selling this comparison — when to lead with which product. */
  sales_framing?: string;
  /** Compliance metadata. */
  compliance: ComplianceMetadata;
  [key: string]: unknown;
};

// ── Node type catalog (canonical list) ─────────────────────────────────────
// Used loosely — knowledge_nodes.node_type is text, not constrained. This
// list is documentation + serves as the input enum for our agent prompts.

export type AgentNodeType =
  // Karen-side (spa)
  | "client"          // Customer of a spa
  | "policy"          // Practice policy (under-21 filler, no discounts, etc.)
  | "service"         // Treatment offered by the spa
  | "convention"      // Operational convention (scheduling link, hours)
  | "preference"      // Client preference learned over time
  | "decision"        // CEO-resolved decision
  | "rationale"       // Why a decision was made
  | "pattern"         // Recurring pattern
  // Liz-side (rep)
  | "account"         // Spa account in a rep's territory
  | "product"         // Drug/device with compliance metadata
  | "promotion"       // Active promotion with eligibility + tier benefits
  | "note"            // Account note (rep-entered)
  | "manufacturer-tier-rule" // Canonical partnership-program tier rule per manufacturer
  | "product-comparison"     // Pair-wise / multi-way product comparison framing
  // Cross-cutting
  | "lesson"          // Lesson learned
  | "contributor"     // Person involved
  | "other"
  | (string & {});

// ── Helper guards ──────────────────────────────────────────────────────────

export function isAccountAttachments(v: unknown): v is AccountAttachments {
  return typeof v === "object" && v !== null;
}

export function isPromotionAttachments(v: unknown): v is PromotionAttachments {
  return typeof v === "object" && v !== null;
}

export function isProductAttachments(v: unknown): v is ProductAttachments {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.manufacturer === "string" && typeof obj.family === "string";
}

/**
 * Find the AccountTier for a given product family on an account.
 * Returns undefined if the account doesn't have a tier for that family.
 */
export function findAccountTier(
  attachments: AccountAttachments | unknown,
  family: ProductFamily,
): AccountTier | undefined {
  if (!isAccountAttachments(attachments)) return undefined;
  return attachments.tiers?.find((t) => t.family === family);
}
