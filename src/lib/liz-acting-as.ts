/**
 * Liz "Acting as" persona scope — client + server shared helpers.
 *
 * Lets the user (admin@openagentic.app, who holds all 68 rep-territory
 * accounts in the seed) put on one of four rep hats — Allergan / Galderma /
 * Evolus / Merz — and have Liz scope her chat reasoning accordingly. Without
 * this, switching the persona dropdown on /app/rep/accounts only filters
 * the account VIEW but Liz's chat still sees all 68 accounts and has no idea
 * which hat the user is wearing.
 *
 * Two surfaces:
 *   - UI:     loadActingAs / saveActingAs (localStorage, per-device, v1)
 *   - server: buildActingAsPrefix(persona) → string prepended to LIZ_SYSTEM_PROMPT
 *
 * Storage chosen as localStorage (not URL search params) because (a) the
 * v287 sprint scope explicitly preferred per-device localStorage for v1
 * surface state until a multi-device need appears (same call as
 * project_lizzie_testing_infra's chip-favorites + drag-order), and (b) the
 * tester wants the picker to survive reloads, not be shareable via URL.
 */

import type { RepAssignment } from "@/server/agent-schema";

/** Subset of RepAssignment values the picker allows (canonical 4 reps). */
export type RepPersona = "allergan-rep" | "galderma-rep" | "evolus-rep" | "merz-rep";

export const REP_PERSONAS: { value: RepPersona; label: string; manufacturer: string }[] = [
  { value: "allergan-rep", label: "Allergan rep",  manufacturer: "Allergan Aesthetics (AbbVie)" },
  { value: "galderma-rep", label: "Galderma rep",  manufacturer: "Galderma" },
  { value: "evolus-rep",   label: "Evolus rep",    manufacturer: "Evolus" },
  { value: "merz-rep",     label: "Merz rep",      manufacturer: "Merz Aesthetics" },
];

const LS_KEY = "lizzie:acting-as:v1";

export function isRepPersona(v: unknown): v is RepPersona {
  return v === "allergan-rep" || v === "galderma-rep"
    || v === "evolus-rep" || v === "merz-rep";
}

/** Read current persona from localStorage. Returns null = "Generalist". */
export function loadActingAs(): RepPersona | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(LS_KEY);
    return isRepPersona(v) ? v : null;
  } catch {
    return null;
  }
}

/** Persist persona to localStorage. Pass null to clear. */
export function saveActingAs(persona: RepPersona | null): void {
  if (typeof window === "undefined") return;
  try {
    if (persona) window.localStorage.setItem(LS_KEY, persona);
    else window.localStorage.removeItem(LS_KEY);
  } catch {
    // localStorage unavailable (private mode etc.) — no-op
  }
}

export function personaLabel(persona: RepPersona | null): string {
  if (!persona) return "Generalist";
  return REP_PERSONAS.find((p) => p.value === persona)?.label ?? persona;
}

// ── Server-side: build the system-prompt prefix ────────────────────────────

/**
 * Returns the persona-scope prefix that gets prepended to LIZ_SYSTEM_PROMPT
 * when the user is acting as one specific rep. Returns empty string for the
 * generalist case (admin sees all 68 accounts, no scoping).
 *
 * The prefix tells Liz: which manufacturer, which product lines, which tier
 * model, which slice of accounts, and how to introduce that scoping when
 * the rep asks "my territory" / "my book" / "my top targets" questions.
 */
export function buildActingAsPrefix(persona: RepPersona | null | undefined): string {
  if (!persona) return "";

  const profile: Record<RepPersona, {
    manufacturer: string;
    altName?: string;
    tierModel: string;
    productLines: string;
    families: string;
    territorySize: number;
  }> = {
    "allergan-rep": {
      manufacturer: "Allergan Aesthetics (AbbVie)",
      altName: "Allergan",
      tierModel: "POINTS-based (APP — Allergan Partnership Program), 5 tiers: Silver / Gold / Platinum / Platinum Plus / Diamond. ~$1 spend ≈ 0.2 points across the Allergan portfolio (confirm at order time).",
      productLines: "Botox Cosmetic, the full Juvederm family (Voluma XC, Volux XC, Vollure XC, Volbella XC, Ultra XC, Ultra Plus XC), and Skinvive by Juvederm.",
      families: "toxins.botox, fillers.juvederm, skin_boosters.skinvive",
      territorySize: 20,
    },
    "galderma-rep": {
      manufacturer: "Galderma",
      tierModel: "$-SPEND-based, 5 tiers: Entry Level / Mid-Tier Spend / High-Volume Spend / Elite Spend / Presidential (invite-only). Quarterly rebates compound with annualized portfolio spend.",
      productLines: "Dysport, the Restylane family (Lyft, Refyne, Defyne, Kysse, Eyelight, Silk, Contour, Restylane-L), and Sculptra Aesthetic.",
      families: "toxins.dysport, fillers.restylane, biostimulators.sculptra",
      territorySize: 20,
    },
    "evolus-rep": {
      manufacturer: "Evolus",
      tierModel: "ORDER-quantity-based on Jeuveau (single SKU), 3 tiers: Standard / Tier 2 (Growth, ~15-syringe min, ~$179/syringe) / Tier 3 (Elite, ~75+ syringes, ~$169/syringe + $4k marketing credit per qualifying order).",
      productLines: "Jeuveau (single SKU — the lever is order size, not portfolio mix).",
      families: "toxins.jeuveau",
      territorySize: 12,
    },
    "merz-rep": {
      manufacturer: "Merz Aesthetics",
      altName: "Merz",
      tierModel: "PORTFOLIO-BREADTH-based (number of Merz categories purchased), 4 tiers: Level 1 (Silver, 1 category) / Level 2 (Gold, 2 cats) / Level 3 (Platinum, 3 cats) / Level 4 (Diamond, 4+ cats + equipment).",
      productLines: "Xeomin, Radiesse + Radiesse Plus, Belotero Balance (and the Ultherapy SPT equipment line at the top tier).",
      families: "toxins.xeomin, biostimulators.radiesse, fillers.belotero",
      territorySize: 16,
    },
  };

  const p = profile[persona];

  return `# CURRENT REP CONTEXT — read first, every turn

You are talking to a ${p.manufacturer}${p.altName ? ` (${p.altName})` : ""} rep right now. They have selected this persona via the "Acting as" picker in the chat header (\`rep_assignment = '${persona}'\`).

This means:
  - **Their territory** = ${p.territorySize} accounts in the seed where \`attachments.rep_assignment = '${persona}'\`. When they say "my book" / "my territory" / "my top targets" / "my accounts" — they mean THESE ${p.territorySize} accounts, NOT the full 73-account roster the admin user technically has access to. **HOW TO SCOPE: on every account-level tool call, pass \`repAssignment: '${persona}'\` — that's the parameter name on agentiport_memory_graph_query. Without it the query returns all 73 accounts and your rankings will be wrong.**
  - **Their primary tier model** = ${p.tierModel}
  - **Their product lines** = ${p.productLines}
  - **Their AccountTier families** = \`${p.families}\`. When reasoning about tier progression, lead with these families — don't pull tier data on competitor families unless the rep explicitly asks "what tiers are my accounts at on Galderma / Allergan / etc."

When pulling product knowledge for "what should I lead with?" type questions, default to ${p.manufacturer}'s product portfolio first. You can compare against competitor products (that's what the \`product-comparison\` nodes are for) but always FRAME the comparison from the ${p.manufacturer} rep's standpoint — when does each ${p.manufacturer} product win, where is the competitor's defensive moat the rep needs to know about.

When you're unsure whether to scope to this persona, default to scoping. The user explicitly put on this hat — they wouldn't have done that if they wanted generalist answers.

# ANTI-FABRICATION — read carefully, this is a hard rule

When you query for accounts and the result is empty, or when an account is missing the field needed to answer a question (e.g., \`qtd_spend\` for a Galderma tier-distance question, \`qtd_points\` for an Allergan one), you MUST say so explicitly. Examples:

  - ✅ "I queried your Galderma book (${p.territorySize} accounts) and 4 of them are missing current QTD spend data. I can rank the 16 with data — want me to flag the 4 gaps?"
  - ✅ "Your Galderma book has no QTD spend data populated yet — I can't compute distance to tier upgrades. Pull the current numbers from CRM and I'll rank them."
  - ❌ NEVER invent account names that aren't in the query result. NEVER invent QTD numbers, tier statuses, or thresholds you didn't see in a tool response.

If the rep is asking for analysis and the data isn't there, surface the gap — that's a more valuable answer than a confident-sounding fabrication. The user will know if you're making things up (the testing harness will catch you), and credibility lost is harder to rebuild than a "I don't have that data yet" sentence is to say.

`;
}
