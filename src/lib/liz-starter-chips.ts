/**
 * Liz starter-chip library — canonical "what reps ask Liz" prompts.
 *
 * Two roles in the product today:
 *   1. **Testing rig** — Grasshopper clicks chips to retest prompts as he
 *      iterates on the prompt + seed data (no more retyping).
 *   2. **Empty-state onboarding** — new reps land on /app/rep and see
 *      "here's what to ask Liz" before they know the surface.
 *
 * Categories are scan-friendly groupings, not strict taxonomies. Order
 * within each category is "most-likely-to-be-clicked first."
 *
 * To add a chip: append a new entry. Keep `id` stable (it's used for the
 * dim-when-already-used state). Keep `label` short (≤ ~36 chars so they fit
 * in the drawer chips); the `prompt` is what's sent to Liz when clicked.
 */

export type ChipCategory =
  | "comparisons"
  | "tier-rules"
  | "accounts"
  | "trajectory"
  | "promotions"
  | "product-knowledge";

export type StarterChip = {
  id: string;
  label: string;
  prompt: string;
  category: ChipCategory;
};

export const CHIP_CATEGORY_LABELS: Record<ChipCategory, string> = {
  comparisons: "Comparisons",
  "tier-rules": "Tier rules",
  accounts: "Account-specific",
  trajectory: "Book-wide trajectory",
  promotions: "Promotions",
  "product-knowledge": "Product knowledge",
};

export const STARTER_CHIPS: StarterChip[] = [
  // ── Comparisons (X vs Y) ──────────────────────────────────────────────
  {
    id: "cmp-volbella-kysse",
    label: "Volbella vs Kysse for lips",
    prompt: "Volbella vs Kysse for lips — which one and when?",
    category: "comparisons",
  },
  {
    id: "cmp-voluma-lyft",
    label: "Voluma vs Lyft (midface)",
    prompt: "Voluma vs Lyft for midface lift — which one should I pitch?",
    category: "comparisons",
  },
  {
    id: "cmp-vollure-defyne",
    label: "Vollure vs Defyne (NLF)",
    prompt: "Vollure vs Defyne for nasolabial folds — how do I choose between them?",
    category: "comparisons",
  },
  {
    id: "cmp-toxin-head-to-head",
    label: "Toxin head-to-head",
    prompt: "Botox vs Dysport vs Jeuveau vs Xeomin — where does each one win?",
    category: "comparisons",
  },
  {
    id: "cmp-sculptra-radiesse",
    label: "Sculptra vs Radiesse",
    prompt: "Sculptra vs Radiesse — when should I pitch which?",
    category: "comparisons",
  },

  // ── Tier rules ─────────────────────────────────────────────────────────
  {
    id: "tier-galderma-mid",
    label: "Galderma Mid-Tier rebate?",
    prompt: "What's the Galderma Mid-Tier rebate and how does an account qualify?",
    category: "tier-rules",
  },
  {
    id: "tier-allergan-diamond",
    label: "Allergan Diamond threshold",
    prompt: "What does it take to hit Allergan Diamond and what do they get there?",
    category: "tier-rules",
  },
  {
    id: "tier-merz-level3",
    label: "Merz Level 3 benefits",
    prompt: "What does an account get at Merz Level 3 Platinum?",
    category: "tier-rules",
  },
  {
    id: "tier-evolus-elite",
    label: "Evolus Tier 3 Elite",
    prompt: "What's the Evolus Tier 3 Elite benefit and order minimum?",
    category: "tier-rules",
  },

  // ── Account-specific ───────────────────────────────────────────────────
  {
    id: "acc-aurora",
    label: "Tell me about Aurora",
    prompt: "Tell me about Aurora Aesthetic Lounge — what tiers, what's the story?",
    category: "accounts",
  },
  {
    id: "acc-rejuv",
    label: "Build me an order for Rejuv",
    prompt: "Build me an order for Rejuv Med Spa that hits any active promos AND maintains their tiers.",
    category: "accounts",
  },
  {
    id: "acc-bloom",
    label: "Bloom — closest upgrade",
    prompt: "Bloom Med Spa — which tier are they closest to upgrading on, and what do they need to get there?",
    category: "accounts",
  },

  // ── Book-wide trajectory ───────────────────────────────────────────────
  {
    id: "traj-at-risk",
    label: "Who's at risk this quarter",
    prompt: "Who's at risk of demotion this quarter across my whole book? Rank them.",
    category: "trajectory",
  },
  {
    id: "traj-kysse-targets",
    label: "Top targets for Kysse",
    prompt: "Top targets for Restylane Kysse in my book — rank them by likelihood.",
    category: "trajectory",
  },
  {
    id: "traj-close-to-upgrade",
    label: "Who's close to upgrading",
    prompt: "Who in my book is close to upgrading a tier this quarter? Which family and how much more?",
    category: "trajectory",
  },
  {
    id: "traj-galderma-top",
    label: "Top Galderma accounts",
    prompt: "Show me my top 10 Galderma accounts ranked by total Galderma spend this quarter.",
    category: "trajectory",
  },

  // ── Promotions ─────────────────────────────────────────────────────────
  {
    id: "promo-active",
    label: "Active promos this quarter",
    prompt: "What promotions are running across all manufacturers this quarter?",
    category: "promotions",
  },
  {
    id: "promo-restylane",
    label: "Restylane promos",
    prompt: "Any active Restylane promotions I can pitch to Galderma accounts?",
    category: "promotions",
  },

  // ── Product knowledge ──────────────────────────────────────────────────
  {
    id: "pk-vycross-xpresshan",
    label: "Vycross vs XpresHAn",
    prompt: "What's the difference between Vycross and XpresHAn technologies?",
    category: "product-knowledge",
  },
  {
    id: "pk-gprime-explained",
    label: "G-Prime explained",
    prompt: "Walk me through G-Prime in plain English and which fillers have high vs low.",
    category: "product-knowledge",
  },
];

/** localStorage keys (v1 — DB sync deferred). */
export const CUSTOM_CHIPS_LS_KEY = "lizzie:custom-chips:v1";
export const FAVORITES_LS_KEY = "lizzie:favorites:v1";
export const ORDER_LS_KEY = "lizzie:chip-order:v1";

export type CustomChip = {
  id: string;
  label: string;
  prompt: string;
  /** Free-form category — defaults to "custom" if not set. */
  category?: string;
  savedAt: string;
};

export function loadCustomChips(): CustomChip[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_CHIPS_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (c): c is CustomChip =>
        c &&
        typeof c.id === "string" &&
        typeof c.label === "string" &&
        typeof c.prompt === "string" &&
        typeof c.savedAt === "string",
    );
  } catch {
    return [];
  }
}

export function saveCustomChips(chips: CustomChip[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_CHIPS_LS_KEY, JSON.stringify(chips));
  } catch {
    /* localStorage quota / disabled — silently degrade */
  }
}

/** Append a new custom chip; trims label to 60 chars, prompt to 800. */
export function appendCustomChip(prompt: string, label?: string): CustomChip {
  const existing = loadCustomChips();
  const p = prompt.trim().slice(0, 800);
  const l = (label?.trim() || p).slice(0, 60);
  const chip: CustomChip = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: l,
    prompt: p,
    category: "custom",
    savedAt: new Date().toISOString(),
  };
  saveCustomChips([chip, ...existing]);
  return chip;
}

export function deleteCustomChip(id: string): void {
  const existing = loadCustomChips();
  saveCustomChips(existing.filter((c) => c.id !== id));
}

// ── Favorites ─────────────────────────────────────────────────────────────
// Set of chip-ids the user has starred. Favorited chips appear in a pinned
// "Favorites" section at the top of the drawer in addition to their
// original category. Stored as a flat string[] in localStorage.

export function loadFavorites(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(FAVORITES_LS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function saveFavorites(favs: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAVORITES_LS_KEY, JSON.stringify([...favs]));
  } catch {
    /* quota / disabled — degrade silently */
  }
}

export function toggleFavorite(id: string): Set<string> {
  const favs = loadFavorites();
  if (favs.has(id)) favs.delete(id);
  else favs.add(id);
  saveFavorites(favs);
  return favs;
}

// ── Drag-and-drop order ───────────────────────────────────────────────────
// Per-section ordering. Keyed by section ("favorites" | category | "custom"),
// value is an array of chip IDs in display order. When loading a section, we
// (a) take the stored order, (b) filter out IDs that no longer exist (e.g.
// custom chips the user deleted), and (c) append any new chip IDs the user
// hasn't seen yet (they sort to the bottom of their section).

export type ChipOrderMap = Record<string, string[]>;

export function loadOrder(): ChipOrderMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ORDER_LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: ChipOrderMap = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        out[k] = v.filter((x): x is string => typeof x === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveOrder(order: ChipOrderMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ORDER_LS_KEY, JSON.stringify(order));
  } catch {
    /* degrade silently */
  }
}

/** Apply stored order to a default list of IDs; new IDs append at end. */
export function applyOrder(sectionKey: string, defaultIds: string[]): string[] {
  const stored = loadOrder()[sectionKey];
  if (!stored || stored.length === 0) return defaultIds;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of stored) {
    if (defaultIds.includes(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  // Append any IDs the user hasn't seen yet (new chips since last reorder).
  for (const id of defaultIds) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** Persist a new order for one section (does not touch other sections). */
export function setSectionOrder(sectionKey: string, ids: string[]): void {
  const order = loadOrder();
  order[sectionKey] = ids;
  saveOrder(order);
}
