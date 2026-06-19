/**
 * Refill brand config.
 *
 * Cleave fix 2026-05-24: collapsed from openagenticv4's dual-brand
 * (Emma + Refill, keyed by AgentiportShell) to a single Refill constant.
 * In the standalone product there's only one shell, so the shell-discriminator
 * function brandFor() is gone; brandFromSourceUrl() is also gone (lead.source
 * URLs will all be getrefill.app — no Emma fork to disambiguate).
 *
 * Visual tokens still live here (not just in styles.css) because they're
 * consumed by non-Tailwind surfaces: email HTML, OG image text, manifest.json,
 * SSR head injection.
 */

export type BrandConfig = {
  /** Single character used in the logo badge. */
  logoMark: string;
  /** Display name in chrome + emails. */
  name: string;
  /** Tagline that appears next to the wordmark in the page header strip. */
  tagline: string;
  /** From-name in transactional emails. */
  emailFromName: string;
  /** From-mailbox in transactional emails. */
  emailFromMailbox: string;
  /** Where the "Set up X for my spa" / signup CTA routes (path only). */
  ctaHref: string;
  /** Where the "Already a customer? Sign in" link routes (path only). */
  loginHref: string;
  /** Absolute origin for server-side links (emails, reports). */
  ctaOrigin: string;
  /** Label on the trial CTA button. */
  ctaLabel: string;
  /** Footer signature line on the /scan page. */
  footerLine: string;
  /**
   * Visual identity tokens. Used by SSR head injection for favicon / OG /
   * theme-color and by any chrome that needs the exact hex (not the Tailwind
   * token). The Tailwind palette in styles.css is the source of truth for
   * in-app rendering; these are the bridge for non-Tailwind surfaces.
   */
  visual: {
    /** Primary CTA + accent. */
    accent: string;
    /** Body ink. */
    ink: string;
    /** Background. */
    paper: string;
    /** "Pending review" / trial-conversion warm warning. */
    amber: string;
    /** Errors / hard failures. */
    crimson: string;
    /** Path (under /public) to the SVG wordmark. */
    wordmarkSvg: string;
    /** Path (under /public) to the favicon. */
    faviconHref: string;
    /** Path (under /public) to the OpenGraph card image. */
    ogImage: string;
  };
};

export const REFILL_BRAND: BrandConfig = {
  logoMark: "S",
  name: "SmartSpa",
  tagline: "/ the patient-profitability OS",
  emailFromName: "SmartSpa",
  // Domain stays getrefill.app this pass (smartspa.app migration is later infra).
  emailFromMailbox: "hello@smartspa.app",
  ctaHref: "/onboard",
  loginHref: "/login",
  ctaOrigin: "https://getrefill.app",
  ctaLabel: "Start SmartSpa free",
  footerLine:
    "Built by SmartSpa — scheduling, recovery & rewards that pay for themselves.",
  visual: {
    accent: "#056048",
    ink: "#1c2024",
    paper: "#fbfaf7",
    amber: "#8a5a16",
    crimson: "#a73b1a",
    wordmarkSvg: "/brand/refill-wordmark.svg",
    faviconHref: "/brand/refill-favicon.svg",
    ogImage: "/brand/refill-og.svg",
  },
};

/** Default export for callers expecting a single brand object. */
export const brand = REFILL_BRAND;

// ─── "Your Brand" white-label pricing (v2.66.0) ──────────────────────────────
//
// The paid add-on price, wired as ONE constant per the locked decision —
// Grasshopper sets the real number later. Everything that quotes the price
// (the Your Brand settings page, future billing) reads from here, so the
// number lives in exactly one place. `null` amount = "price TBD" copy (no
// hard number shown yet); set `amount` when the number is decided.
export const WHITE_LABEL_PRICING = {
  /** Dollars per month. null → render the "pricing coming soon" variant. */
  amount: 29 as number | null,
  interval: "mo" as const,
  currencySymbol: "$",
} as const;

/** Human-friendly price label, e.g. "$49/mo" or "Pricing coming soon". */
export function whiteLabelPriceLabel(): string {
  const { amount, interval, currencySymbol } = WHITE_LABEL_PRICING;
  if (amount == null) return "Pricing coming soon";
  return `${currencySymbol}${amount}/${interval}`;
}

// ─── "Your Brand" white-label merge (v2.66.0) ────────────────────────────────
//
// project_your_brand_white_label. A per-spa override read from the
// brand_settings table (src/server/brand-resolver.ts) is merged OVER
// REFILL_BRAND to produce what a patient actually sees. This merge is the
// SINGLE place the free/paid gate lives, so it stays pure + testable here
// rather than scattered across every surface that renders a brand.
//
// THE GATE:
//   - assistant_name is FREE — it applies whenever set, no entitlement needed.
//   - brand_display_name / accent_color / logo_url / remove_powered_by are PAID
//     — they apply only when whiteLabelActive (entitled AND brandingActive).
//     Off → the patient sees plain SmartSpa, even if the fields are filled in.

/** Raw per-spa override, normalized from the brand_settings row. */
export type BrandOverride = {
  /** FREE: assistant/sender persona name. */
  assistantName: string | null;
  /** PAID: the spa's own product name, replacing SmartSpa. */
  brandDisplayName: string | null;
  /** PAID: CSS hex accent. */
  accentColor: string | null;
  /** PAID: absolute logo image URL. */
  logoUrl: string | null;
  /** PAID: suppress the "powered by SmartSpa" footer/badge. */
  removePoweredBy: boolean;
  /** Owner's master switch for the paid white-label. */
  brandingActive: boolean;
  /** Server/billing-controlled entitlement. */
  entitled: boolean;
};

/** What a patient-facing surface renders, after the free/paid gate. */
export type ResolvedBrand = {
  /** Product/brand name shown to patients + in emails. */
  name: string;
  /** Single character for the logo badge (first letter of the brand name). */
  logoMark: string;
  /** Assistant/sender persona name (free tier). Falls back to the brand name. */
  assistantName: string;
  /** Accent hex for CTAs + highlights. */
  accent: string;
  /** Absolute logo image URL, or null → render the letter/word mark. */
  logoUrl: string | null;
  /** When true, suppress the "powered by SmartSpa" footer/badge. */
  removePoweredBy: boolean;
  /** True when the paid white-label is live (entitled AND active). */
  whiteLabelActive: boolean;
};

/**
 * Merge a per-spa override over REFILL_BRAND, applying the free/paid gate.
 * Pure — no DB, no env. Pass `null` (no row) to get the plain SmartSpa brand
 * (still resolves assistantName to the brand name).
 */
export function mergeBrand(
  base: BrandConfig,
  override: BrandOverride | null,
): ResolvedBrand {
  const whiteLabelActive = !!override?.entitled && !!override?.brandingActive;

  const brandDisplay = override?.brandDisplayName?.trim() || null;
  const name = whiteLabelActive && brandDisplay ? brandDisplay : base.name;

  // FREE: assistant name applies regardless of entitlement. Falls back to the
  // (possibly white-labeled) brand name so a sender persona is never empty.
  const assistantName = override?.assistantName?.trim() || name;

  const accentOverride = override?.accentColor?.trim() || null;
  const accent =
    whiteLabelActive && accentOverride ? accentOverride : base.visual.accent;

  const logoOverride = override?.logoUrl?.trim() || null;
  const logoUrl = whiteLabelActive ? logoOverride : null;

  const removePoweredBy = whiteLabelActive && !!override?.removePoweredBy;

  // Badge mark = first letter of the brand name (uppercased); falls back to the
  // base mark when the name somehow yields no letter.
  const firstChar = name.trim().charAt(0).toUpperCase();
  const logoMark = firstChar || base.logoMark;

  return {
    name,
    logoMark,
    assistantName,
    accent,
    logoUrl,
    removePoweredBy,
    whiteLabelActive,
  };
}
