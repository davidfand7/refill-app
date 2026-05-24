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
  /** Where the "Set up X for my spa" CTA routes (path only). */
  ctaHref: string;
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
  logoMark: "R",
  name: "Refill",
  tagline: "/ refill your schedule, recover your revenue",
  emailFromName: "Refill",
  emailFromMailbox: "hello@getrefill.app",
  ctaHref: "/start",
  ctaOrigin: "https://getrefill.app",
  ctaLabel: "Start Refill free",
  footerLine:
    "Built by Refill — no-show recovery that pays for itself out of recovered revenue.",
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
