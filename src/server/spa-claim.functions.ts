/**
 * Spa claim — TanStack server functions for the spa-side onboarding flow.
 *
 * Three functions:
 *   startSpaScrape({ spaUrl }) — anonymous. Kicks off a FireCrawl crawl and
 *     returns the session row (status='scraping'). Caller polls status.
 *   getSpaClaimStatus({ sessionId }) — anonymous. Returns current session
 *     state. UI polls until status='preview-ready' or 'failed'.
 *   claimSpa({ accessToken, sessionId }) — authenticated. Materializes
 *     knowledge_nodes from scrape_data stamped with auth.users.id, marks
 *     the session claimed.
 *
 * Auth shape: claimSpa uses explicit accessToken-in-payload (per
 * project_tanstack_serverfn_auth memory). startSpaScrape +
 * getSpaClaimStatus are anonymous — their security boundary is the random
 * uuid session id (long enough to be unguessable) and service-role-only
 * writes.
 *
 * Provenance contract: every node we materialize at claim-time carries
 * compliance.source='scraped-public' (the lowest-trust flag in our
 * ContentSource enum), so Karen knows to treat this knowledge as
 * public-website-derived rather than authoritative.
 *
 * Established 2026-05-10 (v256 — Phase 4.0 W1 spa-side claim-your-business).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import { scrapeUrl, crawlUrl, type ScrapeResult } from "@/server/firecrawl";
import type { ComplianceMetadata } from "@/server/agent-schema";
import { extractFromContent, type ExtractedSpaData } from "@/server/gemini-extract";
import { verifyAuth } from "@/server/auth-helpers";
import { setPrimaryRoleIfUnset } from "@/server/user-prefs.functions";

// ─── Types returned to the UI ──────────────────────────────────────────────

export type SpaScrapeService = {
  name: string;
  description?: string;
  /**
   * v266: pricing string preserving the spa's own phrasing — "$14/unit",
   * "from $595", "$1,500-$3,000", "Call for price". Stored as a string
   * (not a number) because real spa pricing is messier than a single
   * value: per-unit, per-syringe, "starting at," ranges, package
   * pricing. Gemini captures verbatim from meta description / body
   * when found adjacent to a service name. Karen surfaces it when
   * customers ask "how much for X?". Empty/undefined when not found.
   */
  price?: string;
  /** Cross-reference against existing product knowledge (Liz's seed). */
  matchedProduct?: {
    nodeId: string;
    canonicalName: string;
    family?: string;
    manufacturer?: string;
  };
  /**
   * v264: when this service is a CATEGORY rather than a specific product
   * (e.g. "Toxins", "Fillers", "Lasers"), candidates lists the family members
   * from Liz's product seed. The review-stage UI renders these as checkboxes
   * so the owner picks specifics in 8 seconds instead of typing brand names.
   * Empty/undefined when this service is itself a specific product.
   */
  candidates?: ProductCandidate[];
};

export type ProductCandidate = {
  nodeId: string;
  name: string;
  family?: string;
  manufacturer?: string;
};

// v270: defensive Zod schema for the JSON shape we project out of
// knowledge_nodes.attachments on the read path. The column is `Json` at the
// Supabase level (anything goes), and TypeScript only narrows what we trust
// at the boundary — this schema enforces it at runtime so a corrupted row
// (manual SQL, a dev tool, an old migration) doesn't silently leak weird
// values into the SpaScrapeService objects fed to the UI + Karen runtime.
//
// All fields optional/.passthrough() so we don't reject extra keys (the
// compliance object lives alongside on the same JSON; we just don't read
// it in the spa-claim getSpaProfile path).
const serviceAttachmentsSchema = z
  .object({
    matchedProduct: z
      .object({
        nodeId: z.string(),
        canonicalName: z.string(),
        family: z.string().optional(),
        manufacturer: z.string().optional(),
      })
      .optional(),
    price: z.string().optional(),
  })
  .passthrough();

function parseServiceAttachments(raw: unknown): {
  matchedProduct?: SpaScrapeService["matchedProduct"];
  price?: string;
} {
  const result = serviceAttachmentsSchema.safeParse(raw);
  return result.success
    ? { matchedProduct: result.data.matchedProduct, price: result.data.price }
    : {};
}

export type SpaScrapeRawPage = {
  url: string;
  /** Markdown truncated to ~6KB per page to keep the JSON column reasonable. */
  markdown: string;
  /**
   * Raw HTML truncated to ~12KB per page. v261+ preserves accordion-collapsed
   * and aria-hidden DOM content that markdown converters strip — required for
   * spa sites that hide service detail behind expand-on-click UI.
   */
  rawHtml?: string;
};

export type SpaScrapeData = {
  spaName?: string;
  description?: string;
  services?: SpaScrapeService[];
  hours?: string;
  schedulingLink?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  policies?: string[];
  sourceUrls?: string[];
  /** Raw FireCrawl markdown per page — for diagnosis + future re-extractions. */
  rawPages?: SpaScrapeRawPage[];
  /** Which extraction path produced the scrape: 'gemini' (preferred) or 'regex' (fallback). */
  extractedBy?: "gemini" | "regex";
  /**
   * v272: when both Gemini attempts failed and the scrape fell to regex,
   * the last Gemini error message is preserved here so the diag scripts can
   * see *why* without needing CF Worker log access. Populated only on the
   * regex-fallback path; cleared (undefined) on Gemini success.
   */
  extractedError?: string;
  /** v272: how many Gemini attempts were made (1 or 2). Useful for telemetry. */
  extractedAttempts?: number;
};

export type SpaClaimSessionRow = {
  id: string;
  spa_url: string;
  spa_name: string | null;
  scrape_status: "queued" | "scraping" | "preview-ready" | "claimed" | "failed";
  scrape_error: string | null;
  scrape_data: SpaScrapeData | null;
  claimed_by: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ClaimSpaResult = {
  session: SpaClaimSessionRow;
  nodesCreated: number;
};

// ─── Admin client + auth helpers ───────────────────────────────────────────

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── URL normalization ─────────────────────────────────────────────────────

// Format-only normalize: strip scheme + leading www., lowercase host, drop
// trailing slash. Returns the bare apex form ("rejuvskinandlaser.com" /
// "rejuvskinandlaser.com/path"), no scheme. Pure function, no network.
function toBareApex(input: string): string {
  let s = input.trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^www\./i, "");
  s = s.replace(/\/+$/, "");
  // Lowercase only the host portion; preserve case in path.
  const slash = s.indexOf("/");
  if (slash >= 0) {
    return s.slice(0, slash).toLowerCase() + s.slice(slash);
  }
  return s.toLowerCase();
}

// Probe-and-fallback: humans paste any of "rejuv.com", "www.rejuv.com",
// "https://rejuv.com", "https://www.rejuv.com/" — the scraper needs ONE
// canonical URL that actually resolves. Some sites only configure www.;
// some only configure apex; most do both. We probe both in parallel via
// HEAD and pick the apex if it works (canonical), else www., else fall
// back to apex and let the scraper surface the real error to the owner.
async function resolveBestSpaUrl(input: string): Promise<string> {
  const apex = toBareApex(input);
  if (!apex || !apex.includes(".")) {
    // Not a recognizable domain shape — return https://input and let the
    // scraper produce the real error.
    return "https://" + apex;
  }
  const apexUrl = "https://" + apex;
  const wwwUrl = "https://www." + apex;

  const probe = async (u: string): Promise<boolean> => {
    try {
      // 5s timeout per probe; cumulative cost is ~5s worst case (parallel).
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      // Any response (even 4xx) means the host resolved. Network errors
      // throw and return false. Some hosts reject HEAD with 405; that's
      // still "host resolved" so it counts.
      await fetch(u, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
      clearTimeout(t);
      return true;
    } catch {
      return false;
    }
  };

  const [apexOk, wwwOk] = await Promise.all([probe(apexUrl), probe(wwwUrl)]);
  if (apexOk) return apexUrl;
  if (wwwOk) return wwwUrl;
  return apexUrl;
}

// ─── Heuristic extractors ──────────────────────────────────────────────────
// Best-effort. Each returns whatever it can find or undefined; never throws.
// Quality of these is what makes the preview feel magical or generic — iterate.

// Brand-name cleanup — used both on FireCrawl <title> metadata and on
// Gemini's extracted spaName. Defensive: even when Gemini was instructed to
// strip SEO suffixes, real-world output can still leak them through. v258
// shipped without this safety net and Boujee Nurse came through as
// "Boujee Nurse | Denver Med Spa — Botox, Filler, Laser & Facial Treatments".
// v259 applies it to both paths.
function cleanSpaName(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  let title = String(input).trim();
  if (!title) return undefined;

  // Step 1: strip generic suffixes after any separator (including plain dash):
  // "- Home", "| Welcome", "— Official Site", ": Home Page".
  title = title
    .replace(
      /\s*[-|–—:]\s*(home|welcome|official site|home page)[^|–—:]*$/i,
      "",
    )
    .trim();

  // Step 2: split on |, —, –, : (NOT plain dash) and take the first
  // non-trivial chunk as the brand name. Most spa SEO appends descriptive
  // tails after these separators — "| #1 Med Spa In Denver",
  // "— Botox, Filler, Laser Treatments", ": Denver's Premier Day Spa".
  // Real brand names rarely contain these characters, so first-chunk-wins
  // is a safe heuristic. We DON'T split on plain "-" because legitimate
  // names use it ("X-Spa", "Re-Skin", "Sun-Kissed Aesthetics").
  const parts = title.split(/\s*[|—–:]\s*/);
  const firstNonTrivial = parts.find((p) => p.trim().length >= 3);
  if (firstNonTrivial) {
    title = firstNonTrivial.trim();
  }

  return title || undefined;
}

function extractSpaName(pages: ScrapeResult[]): string | undefined {
  const home = pages[0];
  return cleanSpaName(home?.metadata?.title);
}

// v264: project FireCrawl's per-page metadata + extract Schema.org JSON-LD
// from rawHtml into the structured PageMetadata shape Gemini's prompt expects.
// FireCrawl returns OG/Twitter as flat keys on metadata (ogTitle, ogDescription,
// twitterTitle, twitterDescription) but doesn't surface JSON-LD — we sniff it
// from rawHtml ourselves. JSON-LD on aesthetics sites is rare but when present
// it's a goldmine (offer catalogs, hours in machine-readable format).
function extractPageMetadata(page: ScrapeResult): {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  jsonLd?: string;
} {
  const m = (page.metadata ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = m[k];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  };
  // Sniff JSON-LD blocks from rawHtml. Concatenate all blocks (sites sometimes
  // ship multiple — Organization + Offer + LocalBusiness etc.) up to a soft cap.
  let jsonLd: string | undefined;
  if (page.rawHtml) {
    const blocks = Array.from(
      page.rawHtml.matchAll(
        /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      ),
    )
      .map((m) => m[1].trim())
      .filter(Boolean);
    if (blocks.length > 0) {
      jsonLd = blocks.join("\n---\n").substring(0, 8000);
    }
  }
  return {
    title: str("title"),
    description: str("description"),
    ogTitle: str("ogTitle") ?? str("og:title"),
    ogDescription: str("ogDescription") ?? str("og:description"),
    twitterTitle: str("twitterTitle") ?? str("twitter:title"),
    twitterDescription: str("twitterDescription") ?? str("twitter:description"),
    jsonLd,
  };
}

function extractContactEmail(pages: ScrapeResult[], spaUrl: string): string | undefined {
  const allMd = pages.map((p) => p.markdown ?? "").join("\n");
  const emails = Array.from(allMd.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)).map((m) => m[0]);
  if (emails.length === 0) return undefined;

  let host = "";
  try {
    host = new URL(spaUrl).hostname.replace(/^www\./, "");
  } catch {
    // ignore
  }
  // Prefer an email at the spa's own domain (signal of ownership).
  const onDomain = emails.find((e) => host && e.toLowerCase().endsWith("@" + host));
  return onDomain ?? emails[0];
}

function extractContactPhone(pages: ScrapeResult[]): string | undefined {
  const allMd = pages.map((p) => p.markdown ?? "").join("\n");
  // North-American 10-digit phone pattern (most common shape on US spa sites).
  const m = allMd.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  return m ? m[0] : undefined;
}

// Known booking platforms used by spas / med-spas / aesthetics practices.
// Expanded across versions: v258 added Jane App + ~10 others after the
// boujeenurse.com miss; v260 added 20+ more from Grasshopper's curated list
// covering the full med-aesthetics / wellness / EHR landscape. Bias toward
// over-listing — false positives cost nothing, false negatives mean we skip
// the actual booking link.
//
// Coverage notes:
//   - Some entries are practice-management/EHR systems (Nextech, Pabau, ModMed)
//     whose patient portals double as booking surfaces — included because
//     real spa sites link to them as "Book Online" / "Patient Portal".
//   - Wellness-adjacent platforms (Cliniko, SimplePractice, Practice Better)
//     are included because med spas with IV therapy / wellness offerings
//     often use them.
//   - Substring match catches subdomains automatically (boujeenurse.janeapp.com
//     matches janeapp.com).
const BOOKING_HOSTS = [
  // ── Acuity / Squarespace stack ─────────────────────────────────
  "acuityscheduling.com",
  "app.acuityscheduling.com",
  "squareup.com",
  "square.site",

  // ── Salon / spa consumer booking ───────────────────────────────
  "vagaro.com",
  "mindbodyonline.com",
  "mindbody.io",
  "booker.com",
  "boulevard.io",
  "boulevardapp.com",
  "joinblvd.com",
  "schedulicity.com",
  "fresha.com",
  "phorest.com",
  "phorestsalon.com",
  "glossgenius.com",
  "mangomint.com",
  "rosy.com",
  "millennium-software.com",
  "envisionsalon.com",
  "meevo.com",
  "treatwell.com",

  // ── Med spa specialized (CRM + booking) ────────────────────────
  "aestheticrecord.com",
  "zenoti.com",
  "patientnow.com",
  "pabau.com",
  "aestheticspro.com",
  "portraitcare.com",
  "mdware.com",
  "symplast.com",
  "optimantra.com",
  "aesthetixcrm.com",
  "touchmd.com",

  // ── Plastic surgery / derm EHR (patient portals double as booking) ──
  "nextech.com",
  "modmed.com",
  "remedly.com",
  "advancedmd.com",
  "drchrono.com",
  "carecloud.com",

  // ── Allied health / wellness ───────────────────────────────────
  "janeapp.com", // includes *.janeapp.com subdomains
  "cliniko.com",
  "simplepractice.com",
  "practicebetter.io",
  "noterro.com",
  "clinicsense.com",
  "juvonno.com",
  "gethealthie.com",
  "therapynotes.com",

  // ── Fitness / wellness studios ─────────────────────────────────
  "wellnessliving.com",
  "glofox.com",

  // ── Healthcare adjacent ────────────────────────────────────────
  "weave.com",

  // ── General-purpose scheduling ─────────────────────────────────
  "calendly.com",
  "setmore.com",
  "appointy.com",
  "timely.is",
  "doodle.com",
  "10to8.com",
  "youcanbook.me",
  "appoint.ly",
  "tidycal.com",
  "checkout.book-now.app",
  "bookwhen.com",
];

function extractSchedulingLink(pages: ScrapeResult[]): string | undefined {
  const allLinks = pages.flatMap((p) => p.links ?? []);

  // Tier 1: known booking platforms used in the spa industry.
  for (const link of allLinks) {
    const lower = link.toLowerCase();
    if (BOOKING_HOSTS.some((h) => lower.includes(h))) return link;
  }

  // Tier 2: any link path that screams "book me."
  for (const link of allLinks) {
    if (/\/(book|schedule|appointment|appointments|booking)/i.test(link)) {
      return link;
    }
  }
  return undefined;
}

function extractServices(pages: ScrapeResult[]): Array<{ name: string; description?: string }> {
  // Prefer pages that look like a services menu; fall back to all pages.
  const servicePages = pages.filter((p) => {
    const url = p.metadata?.sourceURL ?? p.url ?? "";
    return /\/(services|treatments|menu|offerings)/i.test(url);
  });
  const target = servicePages.length > 0 ? servicePages : pages;

  const NOISE = new Set([
    "home",
    "about",
    "about us",
    "contact",
    "contact us",
    "hours",
    "location",
    "menu",
    "services",
    "book",
    "book now",
    "reviews",
    "testimonials",
    "gallery",
    "faq",
    "blog",
    "news",
    "shop",
    "products",
    "team",
    "our team",
    "careers",
    "specials",
  ]);

  const found = new Map<string, string | undefined>();
  for (const page of target) {
    const md = page.markdown ?? "";
    const headings = Array.from(md.matchAll(/^#{2,3}\s+(.+)$/gm));
    for (const m of headings) {
      const name = m[1]
        .trim()
        .replace(/[*_`#]+/g, "")
        .replace(/\s*\(.*?\)\s*$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 80);
      if (!name || name.length < 3 || name.length > 80) continue;
      if (NOISE.has(name.toLowerCase())) continue;
      // Drop heading-shaped CTAs and prices.
      if (/^(call|click|tap|book|schedule)\b/i.test(name)) continue;
      if (/^\$\d/.test(name)) continue;
      if (!found.has(name)) found.set(name, undefined);
    }
  }
  return Array.from(found.entries())
    .slice(0, 24)
    .map(([name, description]) => ({ name, description }));
}

function extractHours(pages: ScrapeResult[]): string | undefined {
  const allMd = pages.map((p) => p.markdown ?? "").join("\n");
  const lines = allMd.split("\n");
  const hours: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    const isHourLike = /(mon|tue|wed|thu|fri|sat|sun)[a-z]*[\s:.\-]+(\d{1,2}[:.]?\d{0,2}\s*(am|pm)?)/i.test(line);
    if (isHourLike) {
      hours.push(line);
      inBlock = true;
    } else if (inBlock && line === "") {
      // Allow a blank line inside a hours block, then bail.
      if (hours.length >= 4) break;
    } else if (inBlock) {
      break;
    }
    if (hours.length >= 7) break;
  }
  return hours.length > 0 ? hours.join("\n") : undefined;
}

// US-style street + city, ST + ZIP. Same regex applied to both markdown
// and (tag-stripped) rawHtml — footers often live in <p><br/>-separated
// HTML that doesn't survive FireCrawl's markdown conversion intact, but
// after tag-strip the address text becomes regex-matchable again.
const ADDRESS_REGEX =
  /\d{2,5}\s+[A-Z][a-zA-Z0-9 .'-]{2,}(?:Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Highway|Hwy\.?|Place|Pl\.?|Court|Ct\.?|Parkway|Pkwy\.?|Suite|Ste\.?|#)[^,\n]{0,40},\s*[A-Z][a-zA-Z .]+,\s*[A-Z]{2}\s*\d{5}/;

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function extractAddress(pages: ScrapeResult[]): string | undefined {
  // Try markdown first (smaller, faster). Fall through to tag-stripped
  // rawHtml on miss — Wix/Squarespace footers commonly use <p><br/> blocks
  // that strip into prose-y "Street ... City, ST ZIP" sequences the regex
  // catches even when the markdown converter ate the structure.
  const allMd = pages.map((p) => p.markdown ?? "").join("\n");
  const mdHit = allMd.match(ADDRESS_REGEX);
  if (mdHit) return mdHit[0].replace(/\s+/g, " ").trim();

  for (const p of pages) {
    if (!p.rawHtml) continue;
    const stripped = stripHtmlTags(p.rawHtml);
    const htmlHit = stripped.match(ADDRESS_REGEX);
    if (htmlHit) return htmlHit[0].replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/**
 * Verbatim-substring guard for LLM-extracted addresses. Returns the
 * candidate when it appears character-for-character (case-insensitive,
 * whitespace-collapsed) in any page's markdown OR tag-stripped rawHtml;
 * returns undefined when the LLM made it up. Used as the LAST line of
 * defense after `extractAddress` regex misses — owners can always type
 * the real address themselves on the review stage rather than have a
 * confidently wrong one materialize into Karen's brain.
 */
function verifyAddressInSource(
  candidate: string | undefined,
  pages: ScrapeResult[],
): string | undefined {
  if (!candidate) return undefined;
  const needle = candidate.toLowerCase().replace(/\s+/g, " ").trim();
  if (needle.length < 12) return undefined; // too short to ground meaningfully
  for (const p of pages) {
    const md = (p.markdown ?? "").toLowerCase().replace(/\s+/g, " ");
    if (md.includes(needle)) return candidate;
    if (p.rawHtml) {
      const stripped = stripHtmlTags(p.rawHtml).toLowerCase();
      if (stripped.includes(needle)) return candidate;
    }
  }
  return undefined;
}

function extractPolicies(pages: ScrapeResult[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const md = p.markdown ?? "";
    const matches = Array.from(
      md.matchAll(/^#{2,4}\s+([^\n]*polic[^\n]*)\n+([^\n#][^\n]+(?:\n[^\n#][^\n]+){0,3})/gim)
    );
    for (const m of matches) {
      const text = m[2].replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
      if (text.length < 30 || text.length > 400) continue;
      const key = text.substring(0, 60).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text.substring(0, 280));
    }
  }
  return out.slice(0, 4);
}

// ─── startSpaScrape ─────────────────────────────────────────────────────────

const startInput = z.object({
  spaUrl: z.string().min(4).max(500),
});

export const startSpaScrape = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => startInput.parse(input))
  .handler(async ({ data }): Promise<SpaClaimSessionRow> => {
    const sb = admin();
    const url = await resolveBestSpaUrl(data.spaUrl);

    // Reuse an in-flight or recently-completed session for the same URL.
    // Owners refresh the page, share the link, click back-and-forward — all
    // legitimate. Don't burn a fresh FireCrawl call each time.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: existing } = await sb
      .from("spa_claim_sessions")
      .select("*")
      .eq("spa_url", url)
      .gte("created_at", tenMinAgo)
      .is("claimed_by", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) return existing as unknown as SpaClaimSessionRow;

    const { data: session, error } = await sb
      .from("spa_claim_sessions")
      .insert({ spa_url: url, scrape_status: "scraping" })
      .select("*")
      .single();
    if (error || !session) {
      throw new Error(`Couldn't start scrape: ${error?.message ?? "no row"}`);
    }

    const sessionId = (session as unknown as { id: string }).id;

    // Run the scrape inline. Cloudflare Workers terminates orphan promises
    // after the request handler returns — so fire-and-forget (`void runScrapeJob`)
    // gets killed before it can do anything. Awaiting keeps the work inside
    // the request lifecycle. The browser holds the fetch open for 30-90s;
    // the UI shows the scraping stage during the await. (Lesson learned the
    // hard way during v256 first live test 2026-05-09 — scrape silently
    // hung at status='scraping' with no error because the catch block
    // never ran either; the entire promise was just terminated.)
    await runScrapeJob(sessionId, url);

    // Re-fetch the row after the job so we return the up-to-date state
    // (preview-ready with scrape_data, or failed with scrape_error).
    const { data: finalRow } = await sb
      .from("spa_claim_sessions")
      .select("*")
      .eq("id", sessionId)
      .single();

    return (finalRow ?? session) as unknown as SpaClaimSessionRow;
  });

// v262 had a SPA_HYDRATE_ACTIONS sequence (wait + executeJavascript expand-all
// accordions + wait, total ~6.5s/page) intended to surface accordion-hidden
// content on Figma Make-style SPAs. v264 dropped it: the actions didn't deliver
// on the Rejuv test case, ate latency on every other site, and the right path
// is the meta-tag + candidate-checklist reframe (see project_v264_locked.md).
// Keeping ScrapeAction in the firecrawl.ts wrapper for future ad-hoc use.

async function runScrapeJob(sessionId: string, url: string): Promise<void> {
  const sb = admin();
  try {
    let crawl = await crawlUrl(url, {
      limit: 12,
      excludePaths: [
        "/blog/*",
        "/blogs/*",
        "/news/*",
        "/gallery/*",
        "/galleries/*",
        "/portfolio/*",
        "/shop/*",
        "/cart/*",
        "/account/*",
      ],
      // rawHtml added v261 — markdown converters strip accordion-collapsed /
      // aria-hidden content. Rejuv's services page had Botox/Volbella/etc. in
      // expandable sections; markdown returned 514 chars with only the
      // collapsed headers. rawHtml preserves the DOM. Gemini extracts from
      // either format (prompt updated to handle HTML directly).
      formats: ["markdown", "rawHtml", "links"],
      // v264: hydration cushion for normal SPAs without v262's action overhead.
      waitFor: 3000,
      pollTimeoutMs: 5 * 60 * 1000,
    });

    if (crawl.status !== "completed" || crawl.pages.length === 0) {
      const single = await scrapeUrl(url, {
        formats: ["markdown", "rawHtml", "links"],
        waitFor: 3000,
      });
      crawl = { ...crawl, status: "completed", pages: [single], total: 1 };
    }

    // ── Save raw scrape content for diagnosis + future re-extractions ────
    // Bounded per page so the JSON column stays sane. Saves BOTH markdown
    // (human-readable, smaller) and rawHtml (preserves accordion content)
    // — future re-extractions can pick either. v262: bumped rawHtml cap
    // 12K → 32K because Figma Make / Wix style SPAs spend ~7-8K on chrome
    // (CSS / preload tags / runtime imports) before any body content lands;
    // the prior cap was consumed entirely by chrome on Rejuv. 32K leaves
    // headroom for two filler families per page after chrome.
    const MAX_MD_PER_PAGE = 6000;
    const MAX_HTML_PER_PAGE = 32000;
    const rawPages: SpaScrapeRawPage[] = crawl.pages.slice(0, 6).map((p) => ({
      url: (p.metadata?.sourceURL as string | undefined) ?? p.url ?? "",
      markdown: (p.markdown ?? "").substring(0, MAX_MD_PER_PAGE),
      rawHtml: (p.rawHtml ?? "").substring(0, MAX_HTML_PER_PAGE),
    }));

    // ── Try LLM extraction first; fall back to regex if Gemini fails ──────
    // v264: pass page metadata (title / meta description / OG / Twitter / JSON-LD)
    // alongside body to Gemini. On JS-heavy sites the meta tags often contain
    // a complete services + pricing summary the spa wrote for SEO/social cards
    // — and that's a better source than fighting headless rendering quirks.
    //
    // v272: retry-once with 250ms backoff. Gemini transiently fails (5xx /
    // timeout / partial JSON / Zod-schema drift) at a non-trivial rate; one
    // re-attempt eliminates most of that noise without taxing successful
    // calls. Both attempts' errors are logged structured; the last error is
    // preserved on scrape_data.extractedError when both fail (so diag
    // scripts can see *why* without needing CF Worker log access).
    const GEMINI_MAX_ATTEMPTS = 2;
    const geminiInput = crawl.pages.map((p) => ({
      url: (p.metadata?.sourceURL as string | undefined) ?? p.url ?? "",
      body: p.rawHtml ?? p.markdown ?? "",
      metadata: extractPageMetadata(p),
    }));

    let extracted: ExtractedSpaData | null = null;
    let attemptsUsed = 0;
    let lastGeminiError: string | null = null;
    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
      attemptsUsed = attempt;
      try {
        extracted = await extractFromContent(geminiInput);
        break;
      } catch (e) {
        lastGeminiError = e instanceof Error ? e.message : String(e);
        console.warn(
          JSON.stringify({
            event: "spa_claim_gemini_attempt_failed",
            sessionId,
            spaUrl: url,
            attempt,
            of: GEMINI_MAX_ATTEMPTS,
            error: lastGeminiError.substring(0, 400),
            ts: new Date().toISOString(),
          }),
        );
        if (attempt < GEMINI_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }

    let scrapeData: SpaScrapeData;
    if (extracted) {
      // Always prefer phone/scheduling/address from regex when it finds them
      // — Gemini can hallucinate URL fragments + plausible-shaped addresses
      // (v271: Rejuv re-claim returned "7200 S Alton Way…" — a clean Denver-
      // suburb-shaped string that doesn't appear anywhere on the actual site).
      // Regex is grounded truth; LLM output is fallback only, AND the LLM
      // address goes through verifyAddressInSource as a verbatim-substring
      // guard so a hallucinated address can't materialize into Karen's brain.
      const regexScheduling = extractSchedulingLink(crawl.pages);
      const regexPhone = extractContactPhone(crawl.pages);
      const regexAddress = extractAddress(crawl.pages);
      scrapeData = {
        // Always run cleanSpaName over Gemini's output too — defensive against
        // SEO suffixes leaking through even with the prompt instructions
        // (Boujee Nurse leaked through in v258). Falls through to FireCrawl
        // <title> metadata if Gemini didn't return one.
        spaName: cleanSpaName(extracted.spaName) ?? extractSpaName(crawl.pages),
        description: extracted.description,
        services: extracted.services,
        hours: extracted.hours,
        schedulingLink: regexScheduling ?? extracted.schedulingLink,
        contactEmail: extracted.contactEmail ?? extractContactEmail(crawl.pages, url),
        contactPhone: regexPhone ?? extracted.contactPhone,
        address: regexAddress ?? verifyAddressInSource(extracted.address, crawl.pages),
        policies: extracted.policies,
        extractedBy: "gemini",
        extractedAttempts: attemptsUsed,
      };
    } else {
      // v270: structured fallback log retained for telemetry — ops can grep
      // CF Worker logs for `event=spa_claim_gemini_fallback` to track how
      // often extraction degrades to regex (lower-quality output). High
      // fallback rate signals Gemini API issue or schema drift before
      // customers notice incomplete extractions.
      console.warn(
        JSON.stringify({
          event: "spa_claim_gemini_fallback",
          sessionId,
          spaUrl: url,
          error: (lastGeminiError ?? "unknown").substring(0, 400),
          attempts: attemptsUsed,
          fallback: "regex",
          ts: new Date().toISOString(),
        }),
      );
      scrapeData = {
        spaName: extractSpaName(crawl.pages),
        services: extractServices(crawl.pages),
        hours: extractHours(crawl.pages),
        schedulingLink: extractSchedulingLink(crawl.pages),
        contactEmail: extractContactEmail(crawl.pages, url),
        contactPhone: extractContactPhone(crawl.pages),
        address: extractAddress(crawl.pages),
        policies: extractPolicies(crawl.pages),
        extractedBy: "regex",
        extractedAttempts: attemptsUsed,
        extractedError: lastGeminiError?.substring(0, 1000),
      };
    }

    // ── Cross-reference services against existing product knowledge ───────
    // Liz's v251 seed has 23 product nodes (Botox, Dysport, Juvederm family,
    // Restylane family, Sculptra, etc.) with manufacturer + family attribution.
    // For services that match a product, attach the canonical name + family
    // so Karen's services connect to Liz's product taxonomy. Same brain,
    // two roles.
    if (scrapeData.services && scrapeData.services.length > 0) {
      scrapeData.services = await crossReferenceServices(scrapeData.services, sb);
    }

    scrapeData.sourceUrls = crawl.pages
      .map((p) => (p.metadata?.sourceURL as string | undefined) ?? p.url)
      .filter((u): u is string => Boolean(u));
    scrapeData.rawPages = rawPages;

    await sb
      .from("spa_claim_sessions")
      .update({
        scrape_status: "preview-ready",
        spa_name: scrapeData.spaName ?? null,
        scrape_data: scrapeData as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sb
      .from("spa_claim_sessions")
      .update({
        scrape_status: "failed",
        scrape_error: message.substring(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
  }
}

// ─── Service ↔ product cross-reference ─────────────────────────────────────
// Look up each scraped service name against existing knowledge_nodes where
// node_type='product' (the v251 injectables seed). On match, attach
// manufacturer + family so Karen's services connect to Liz's product
// taxonomy. Match strategy: case-insensitive substring match on title or
// lookup_key — generous, since spa sites use brand names ("Botox") that
// should match our products even when phrasing differs ("Botox Cosmetic").

async function crossReferenceServices(
  services: SpaScrapeService[],
  sb: ReturnType<typeof admin>,
): Promise<SpaScrapeService[]> {
  // Pull all product nodes once. Cross-tenant: we read from anyone's seed,
  // since the canonical taxonomy is shared knowledge. The v251 seed lives
  // under davidfand303@gmail.com per the seed-injectables script.
  const { data: products } = await sb
    .from("knowledge_nodes")
    .select("id, title, lookup_key, attachments")
    .eq("node_type", "product")
    .limit(200);

  if (!products || products.length === 0) return services;

  // Pre-index products by lowercased title / slug / family path so we can
  // match category-level services like "Toxins" / "Fillers" (which most spas
  // list as broad categories, not specific products). v258 shipped without
  // this and the cross-ref markers stayed dark on Rejuv.
  const productIndex = products.map((p) => {
    const family = (
      ((p.attachments ?? {}) as { family?: string }).family ?? ""
    ).toLowerCase();
    return {
      product: p,
      title: (p.title ?? "").toLowerCase(),
      slug: (p.lookup_key ?? "").toLowerCase(),
      family,
      // Family path segments — "fillers.juvederm" → ["fillers", "juvederm"]
      familySegments: family.split(".").filter(Boolean),
    };
  });

  return services.map((service) => {
    const haystack = service.name.toLowerCase().trim();
    if (!haystack) return service;

    // Tier 1: title / slug substring match (catches "Botox", "Juvederm",
    // "Botox cosmetic injections", "Restylane Lyft").
    const directMatch = productIndex.find(
      (p) =>
        (p.title && (haystack.includes(p.title) || p.title.includes(haystack))) ||
        (p.slug && haystack.includes(p.slug)),
    );

    if (directMatch) {
      const attachments = (directMatch.product.attachments ?? {}) as {
        manufacturer?: string;
        family?: string;
      };
      return {
        ...service,
        matchedProduct: {
          nodeId: directMatch.product.id,
          canonicalName: directMatch.product.title,
          family: attachments.family,
          manufacturer: attachments.manufacturer,
        },
      };
    }

    // Tier 2: family-path CATEGORY match — service.name matches a family
    // segment ("Toxins" → toxins.*, "Fillers" → fillers.*). v264 promotes
    // these from "single-product match" to "candidate set" so the review
    // stage can render a checkbox group of all family members. "Toxins"
    // surfaces { Botox, Dysport, Jeuveau, Xeomin, Daxxify } as candidates
    // — owner ticks the relevant ones in 8 seconds vs typing 4 brand names.
    const normalized = haystack.replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const trimmedSingular = normalized.replace(/s$/, "");
    const matchingProducts = productIndex.filter((p) =>
      p.familySegments.some(
        (seg) =>
          seg === normalized ||
          seg === trimmedSingular ||
          seg.startsWith(normalized) ||
          (normalized.length >= 4 && normalized.includes(seg)) ||
          (trimmedSingular.length >= 4 && trimmedSingular.includes(seg)),
      ),
    );

    if (matchingProducts.length === 0) return service;

    const candidates: ProductCandidate[] = matchingProducts.map((p) => {
      const a = (p.product.attachments ?? {}) as {
        manufacturer?: string;
        family?: string;
      };
      return {
        nodeId: p.product.id,
        name: p.product.title ?? "",
        family: a.family,
        manufacturer: a.manufacturer,
      };
    });

    // Single match → still treat as direct (one filler product family
    // happens to have only one entry in the seed). Multiple → candidate set.
    if (candidates.length === 1) {
      const only = matchingProducts[0];
      const attachments = (only.product.attachments ?? {}) as {
        manufacturer?: string;
        family?: string;
      };
      return {
        ...service,
        matchedProduct: {
          nodeId: only.product.id,
          canonicalName: only.product.title,
          family: attachments.family,
          manufacturer: attachments.manufacturer,
        },
      };
    }

    // Multi-product family — surface as candidate checklist.
    return { ...service, candidates };
  });
}

// ─── materializeSpaNodes — shared idempotent upsert helper ─────────────────
// Single source of truth for projecting SpaScrapeData → knowledge_nodes under
// a given user. Used by BOTH claimSpa (first-time materialization OR re-claim)
// and updateSpaProfile (dashboard-edit save). v265: extracted to fix the
// 77-node accumulation bug — pre-v265 claimSpa did pure INSERT and re-claims
// stacked. Now both paths share the same diff-based upsert that preserves
// node IDs (so any knowledge_edges crystallized over time aren't cascaded
// away) and never duplicates.
//
// Field-level semantics — `undefined` means "leave alone", defined means
// "apply this value":
//   - scalars:  undefined → skip; "" or whitespace → delete; non-empty → upsert
//   - services: undefined → skip; [] → delete all; non-empty → diff by slug
//   - policies: undefined → skip; [] → clear; non-empty → replace-all
//
// claimSpa passes a fully-populated SpaScrapeData (every extracted field
// explicit). updateSpaProfile passes only what the owner edited. Same helper
// handles both because the field-level skip semantics covers them naturally.
//
// `source` flows into BOTH the column-level source field on INSERT and the
// attachments.compliance.source flag (used by Karen's runtime to weight
// authority). On UPDATE the column-level source is preserved (historical fact:
// "this row was originally created by scrape") while attachments.compliance
// reflects the latest write — slight nuance, intentional.

const SPA_PROFILE_SCALAR_SPECS = [
  { key: "spa-name" as const, field: "spaName" as const, title: "Practice name", contentTpl: (v: string) => `The practice is ${v}.` },
  { key: "hours" as const, field: "hours" as const, title: "Business hours", contentTpl: (v: string) => v },
  { key: "scheduling-link" as const, field: "schedulingLink" as const, title: "Scheduling link", contentTpl: (v: string) => `Customers book at ${v}.` },
  { key: "contact-email" as const, field: "contactEmail" as const, title: "Contact email", contentTpl: (v: string) => v },
  { key: "contact-phone" as const, field: "contactPhone" as const, title: "Contact phone", contentTpl: (v: string) => v },
  { key: "address" as const, field: "address" as const, title: "Address", contentTpl: (v: string) => v },
];

async function materializeSpaNodes(
  sb: ReturnType<typeof admin>,
  userId: string,
  data: Partial<SpaScrapeData>,
  source: "scraped-public" | "user-input",
  sourceRef?: string,
): Promise<void> {
  const compliance: ComplianceMetadata = {
    label_status: "general-clinical",
    source,
  };

  // ── Scalars: diff by lookup_key under context='spa-profile' ──────────────
  const scalarsToTouch = SPA_PROFILE_SCALAR_SPECS.filter(
    (s) => data[s.field] !== undefined,
  );
  if (scalarsToTouch.length > 0) {
    const { data: existingScalar } = await sb
      .from("knowledge_nodes")
      .select("id, lookup_key")
      .eq("user_id", userId)
      .eq("context", "spa-profile");
    const scalarById = new Map<string, { id: string }>();
    for (const row of existingScalar ?? []) {
      if (row.lookup_key) scalarById.set(row.lookup_key, { id: row.id });
    }

    for (const spec of scalarsToTouch) {
      const value = data[spec.field] as string | undefined;
      const existing = scalarById.get(spec.key);
      const trimmed = value?.trim() ?? "";
      if (!trimmed) {
        if (existing) {
          await sb.from("knowledge_nodes").delete().eq("id", existing.id);
        }
        continue;
      }
      const title = spec.key === "spa-name" ? trimmed : spec.title;
      const content = spec.contentTpl(trimmed);
      const attachments: Record<string, unknown> = { compliance };
      if (spec.key === "scheduling-link") attachments.url = trimmed;
      if (existing) {
        await sb
          .from("knowledge_nodes")
          .update({
            title,
            content,
            attachments: attachments as Json,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await sb.from("knowledge_nodes").insert({
          user_id: userId,
          node_type: "convention",
          title,
          content,
          context: "spa-profile",
          lookup_key: spec.key,
          lookup_type: "convention",
          attachments: attachments as Json,
          source,
          source_ref: sourceRef ?? null,
        });
      }
    }
  }

  // ── Services: diff by slug under context='services' ──────────────────────
  if (data.services !== undefined) {
    const enriched = await crossReferenceServices(data.services, sb);
    const slugFor = (name: string) =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const incomingBySlug = new Map<string, SpaScrapeService>();
    for (const s of enriched) {
      const slug = slugFor(s.name);
      if (slug) incomingBySlug.set(slug, s);
    }

    const { data: existingServices } = await sb
      .from("knowledge_nodes")
      .select("id, lookup_key, title")
      .eq("user_id", userId)
      .eq("context", "services");
    const existingBySlug = new Map<string, { id: string; title: string | null }>();
    for (const row of existingServices ?? []) {
      if (row.lookup_key) existingBySlug.set(row.lookup_key, { id: row.id, title: row.title });
    }

    const toDelete: string[] = [];
    for (const [slug, row] of existingBySlug) {
      if (!incomingBySlug.has(slug)) toDelete.push(row.id);
    }
    if (toDelete.length > 0) {
      await sb.from("knowledge_nodes").delete().in("id", toDelete);
    }

    for (const [slug, service] of incomingBySlug) {
      const attachments: Record<string, unknown> = { compliance };
      if (service.matchedProduct) attachments.matchedProduct = service.matchedProduct;
      // v266: stash pricing verbatim. Karen reads it back when customers
      // ask "how much for X?". Stored separately from `content` (Karen's
      // prose) so the runtime can compose responses naturally without
      // string-parsing prices out of paragraphs.
      if (service.price?.trim()) attachments.price = service.price.trim();
      const existing = existingBySlug.get(slug);
      const content =
        service.description ??
        `${service.name} — listed in the practice's services menu.`;
      if (existing) {
        await sb
          .from("knowledge_nodes")
          .update({
            title: service.name,
            content,
            attachments: attachments as Json,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await sb.from("knowledge_nodes").insert({
          user_id: userId,
          node_type: "service",
          title: service.name,
          content,
          context: "services",
          lookup_key: slug || null,
          lookup_type: "service",
          attachments: attachments as Json,
          source,
          source_ref: sourceRef ?? null,
        });
      }
    }
  }

  // ── Policies: no stable key, replace-all under context='policies' ────────
  if (data.policies !== undefined) {
    await sb
      .from("knowledge_nodes")
      .delete()
      .eq("user_id", userId)
      .eq("context", "policies");
    const policyRows = data.policies
      .map((p) => p.trim())
      .filter(Boolean)
      .map((policy) => ({
        user_id: userId,
        node_type: "policy" as const,
        title: "Practice policy",
        content: policy,
        context: "policies",
        lookup_key: null,
        lookup_type: null,
        attachments: { compliance } as Json,
        source,
        source_ref: sourceRef ?? null,
      }));
    if (policyRows.length > 0) {
      await sb.from("knowledge_nodes").insert(policyRows);
    }
  }
}

// ─── getSpaClaimStatus ──────────────────────────────────────────────────────

const statusInput = z.object({
  sessionId: z.string().uuid(),
});

export const getSpaClaimStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => statusInput.parse(input))
  .handler(async ({ data }): Promise<SpaClaimSessionRow> => {
    const sb = admin();
    const { data: row, error } = await sb
      .from("spa_claim_sessions")
      .select("*")
      .eq("id", data.sessionId)
      .single();
    if (error || !row) throw new Error("Session not found.");
    return row as unknown as SpaClaimSessionRow;
  });

// ─── updateSpaScrape ───────────────────────────────────────────────────────
// Owner-edit step. Anonymous endpoint — security boundary is the random
// session id (long uuid, not guessable). Owner edits the scraped data in
// the review stage, we save the edited shape so claimSpa materializes
// what the owner actually wants Karen to know, not just the raw scrape.
// Preserves server-derived fields (rawPages, sourceUrls, extractedBy).

const editableScrapeShape = z.object({
  spaName: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  services: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        // v266: optional pricing string preserved verbatim from the spa's
        // own copy. 80-char ceiling accommodates ranges + qualifiers.
        price: z.string().max(80).optional(),
      }),
    )
    .max(60)
    .optional(),
  hours: z.string().max(500).optional(),
  schedulingLink: z.string().max(500).optional(),
  contactEmail: z.string().max(200).optional(),
  contactPhone: z.string().max(50).optional(),
  address: z.string().max(300).optional(),
  policies: z.array(z.string().min(1).max(400)).max(20).optional(),
});

const updateInput = z.object({
  sessionId: z.string().uuid(),
  edits: editableScrapeShape,
});

export const updateSpaScrape = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateInput.parse(input))
  .handler(async ({ data }): Promise<SpaClaimSessionRow> => {
    const sb = admin();

    const { data: row, error: loadErr } = await sb
      .from("spa_claim_sessions")
      .select("*")
      .eq("id", data.sessionId)
      .single();
    if (loadErr || !row) throw new Error("Session not found.");
    const session = row as unknown as SpaClaimSessionRow;
    if (session.claimed_by) {
      throw new Error("This spa has already been claimed.");
    }
    if (session.scrape_status !== "preview-ready") {
      throw new Error("Scrape isn't finished yet.");
    }

    // Merge owner edits into the existing scrape_data — preserve server-only
    // fields the UI doesn't send back (rawPages, sourceUrls, extractedBy).
    const existing = session.scrape_data ?? {};
    const merged: SpaScrapeData = {
      ...existing,
      ...(data.edits.spaName !== undefined ? { spaName: data.edits.spaName || undefined } : {}),
      ...(data.edits.description !== undefined ? { description: data.edits.description || undefined } : {}),
      ...(data.edits.services !== undefined ? { services: data.edits.services } : {}),
      ...(data.edits.hours !== undefined ? { hours: data.edits.hours || undefined } : {}),
      ...(data.edits.schedulingLink !== undefined
        ? { schedulingLink: data.edits.schedulingLink || undefined }
        : {}),
      ...(data.edits.contactEmail !== undefined
        ? { contactEmail: data.edits.contactEmail || undefined }
        : {}),
      ...(data.edits.contactPhone !== undefined
        ? { contactPhone: data.edits.contactPhone || undefined }
        : {}),
      ...(data.edits.address !== undefined ? { address: data.edits.address || undefined } : {}),
      ...(data.edits.policies !== undefined ? { policies: data.edits.policies } : {}),
    };

    // Re-cross-reference services if they changed — owner may have added
    // a service like "Botox" that should connect to the product taxonomy.
    if (data.edits.services !== undefined && merged.services) {
      merged.services = await crossReferenceServices(merged.services, sb);
    }

    const { data: updated, error: updateErr } = await sb
      .from("spa_claim_sessions")
      .update({
        spa_name: merged.spaName ?? null,
        scrape_data: merged as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.sessionId)
      .select("*")
      .single();
    if (updateErr || !updated) {
      throw new Error(`Couldn't save edits: ${updateErr?.message ?? "no row"}`);
    }
    return updated as unknown as SpaClaimSessionRow;
  });

// ─── claimSpa ──────────────────────────────────────────────────────────────

const claimInput = z.object({
  accessToken: z.string().min(1),
  sessionId: z.string().uuid(),
  /** Optional owner edits applied at claim time. Owner-edit stage in the
   * route lets the owner refine extraction before committing. Edits merge
   * over the existing scrape_data and re-cross-reference services. */
  edits: editableScrapeShape.optional(),
});

export const claimSpa = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => claimInput.parse(input))
  .handler(async ({ data }): Promise<ClaimSpaResult> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: sessionRow, error: loadErr } = await sb
      .from("spa_claim_sessions")
      .select("*")
      .eq("id", data.sessionId)
      .single();
    if (loadErr || !sessionRow) throw new Error("Session not found.");

    const session = sessionRow as unknown as SpaClaimSessionRow;
    if (session.claimed_by) throw new Error("This spa has already been claimed.");
    if (session.scrape_status !== "preview-ready") {
      throw new Error("Scrape isn't finished yet — please wait for the preview.");
    }

    // Apply owner edits (if any) over the scraped data before materializing.
    let scrapeData = session.scrape_data;
    if (data.edits) {
      const merged: SpaScrapeData = {
        ...(scrapeData ?? {}),
        ...(data.edits.spaName !== undefined ? { spaName: data.edits.spaName || undefined } : {}),
        ...(data.edits.description !== undefined ? { description: data.edits.description || undefined } : {}),
        ...(data.edits.services !== undefined ? { services: data.edits.services } : {}),
        ...(data.edits.hours !== undefined ? { hours: data.edits.hours || undefined } : {}),
        ...(data.edits.schedulingLink !== undefined
          ? { schedulingLink: data.edits.schedulingLink || undefined }
          : {}),
        ...(data.edits.contactEmail !== undefined
          ? { contactEmail: data.edits.contactEmail || undefined }
          : {}),
        ...(data.edits.contactPhone !== undefined
          ? { contactPhone: data.edits.contactPhone || undefined }
          : {}),
        ...(data.edits.address !== undefined ? { address: data.edits.address || undefined } : {}),
        ...(data.edits.policies !== undefined ? { policies: data.edits.policies } : {}),
      };
      if (data.edits.services !== undefined && merged.services) {
        merged.services = await crossReferenceServices(merged.services, sb);
      }
      // Persist the edits to the session row too — useful for diagnosis +
      // any future "edit after claim" path.
      await sb
        .from("spa_claim_sessions")
        .update({
          spa_name: merged.spaName ?? null,
          scrape_data: merged as unknown as Json,
          updated_at: new Date().toISOString(),
        })
        .eq("id", data.sessionId);
      scrapeData = merged;
    }
    if (!scrapeData) throw new Error("No scrape data on this session.");

    // v265: idempotent materialization. Pre-v265 used pure INSERT and
    // re-claims accumulated duplicates (Grasshopper saw 77 nodes after a
    // dev cycle of repeat test claims). materializeSpaNodes is the shared
    // diff-upsert helper used by both claim + dashboard-edit paths so a
    // re-claim or a dashboard save is now safe to repeat.
    //
    // Build an explicit Partial<SpaScrapeData> with EVERY field present
    // (even when undefined → that means "leave alone" for the helper, but
    // for first-claim there's nothing to leave alone, and for re-claim of
    // a freshly-edited session we want the helper's diff semantics).
    // Services/policies arrays are coerced to [] when missing so the helper
    // clears stale entries on re-claim — matches the prior INSERT semantics
    // where we materialized whatever was in scrapeData and nothing else.
    const materializeShape: Partial<SpaScrapeData> = {
      spaName: scrapeData.spaName ?? "",
      hours: scrapeData.hours ?? "",
      schedulingLink: scrapeData.schedulingLink ?? "",
      contactEmail: scrapeData.contactEmail ?? "",
      contactPhone: scrapeData.contactPhone ?? "",
      address: scrapeData.address ?? "",
      services: scrapeData.services ?? [],
      policies: scrapeData.policies ?? [],
    };
    try {
      await materializeSpaNodes(
        sb,
        userId,
        materializeShape,
        "scraped-public",
        session.spa_url,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Couldn't materialize Memory Graph: ${message}`);
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updateErr } = await sb
      .from("spa_claim_sessions")
      .update({
        scrape_status: "claimed",
        claimed_by: userId,
        claimed_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", data.sessionId)
      .select("*")
      .single();
    if (updateErr || !updated) {
      throw new Error(`Couldn't finalize claim: ${updateErr?.message ?? "no row"}`);
    }

    // Stamp primary_role='spa-owner' on first successful claim. Sticky —
    // never overwrites an existing role (per setPrimaryRoleIfUnset). Awaited
    // because Cloudflare Workers kill orphan promises after the request
    // returns (v257 fire-and-forget lesson). The helper swallows its own
    // errors so this never blocks a successful claim.
    await setPrimaryRoleIfUnset(sb, userId, "spa-owner");

    // v265: count from the materialized shape rather than a NodeInsert array
    // (the helper does diff-upsert, not INSERT, so there's no batch to .length).
    // Represents "facts now in Karen's brain about this spa" — sum of scalar
    // fields with values + services + policies.
    const scalarCount = SPA_PROFILE_SCALAR_SPECS.reduce(
      (n, s) => n + ((materializeShape[s.field] as string)?.trim() ? 1 : 0),
      0,
    );
    const nodesCreated =
      scalarCount +
      (materializeShape.services?.length ?? 0) +
      (materializeShape.policies?.length ?? 0);

    return {
      session: updated as unknown as SpaClaimSessionRow,
      nodesCreated,
    };
  });

// ─── /app/karen dashboard: read + write spa profile from knowledge_nodes ───
// Post-claim management surface. The owner-edit during /claim-your-business
// applies edits at claim time; once claimed, the canonical state lives in
// knowledge_nodes (NOT spa_claim_sessions, which is staging-only). The
// dashboard reads from knowledge_nodes and writes back via diff-based upsert
// to preserve node IDs (so any knowledge_edges that connect to spa-profile
// nodes don't get cascaded away). Established v263 (2026-05-09).

export type SpaProfile = {
  /** True if the user has claimed at least one spa (i.e. has spa-profile nodes). */
  claimed: boolean;
  /** Hostname of the source site, if available from any node's source_ref. */
  sourceUrl?: string;
  data: SpaScrapeData;
};

const KEY_TO_FIELD: Record<string, keyof SpaScrapeData> = {
  "spa-name": "spaName",
  hours: "hours",
  "scheduling-link": "schedulingLink",
  "contact-email": "contactEmail",
  "contact-phone": "contactPhone",
  address: "address",
};

const profileInput = z.object({
  accessToken: z.string().min(1),
});

export const getSpaProfile = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => profileInput.parse(input))
  .handler(async ({ data }): Promise<SpaProfile> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: nodes, error } = await sb
      .from("knowledge_nodes")
      .select("id, node_type, title, content, context, lookup_key, attachments, source_ref")
      .eq("user_id", userId)
      .in("context", ["spa-profile", "services", "policies"])
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Couldn't load spa profile: ${error.message}`);
    }
    if (!nodes || nodes.length === 0) {
      return { claimed: false, data: {} };
    }

    const profile: SpaScrapeData = {};
    let sourceUrl: string | undefined;

    for (const n of nodes) {
      if (n.source_ref && !sourceUrl) sourceUrl = n.source_ref;
      if (n.context === "spa-profile" && n.lookup_key) {
        const field = KEY_TO_FIELD[n.lookup_key];
        if (field === "spaName") profile.spaName = n.title ?? undefined;
        else if (field === "schedulingLink") {
          // v265.1: pull the bare URL from attachments (stored cleanly there
          // by materializeSpaNodes) rather than the natural-language content
          // ("Customers book at https://…"). The dashboard renders this as
          // an editable input + clickable link — needs the URL alone, not
          // the prose-prefixed version Karen reads to a customer.
          const url = (n.attachments as { url?: string } | null)?.url;
          profile.schedulingLink = url ?? n.content ?? undefined;
        } else if (field) (profile as any)[field] = n.content ?? undefined;
      } else if (n.context === "services" && n.title) {
        if (!profile.services) profile.services = [];
        const att = parseServiceAttachments(n.attachments);
        profile.services.push({
          name: n.title,
          matchedProduct: att.matchedProduct,
          price: att.price,
        });
      } else if (n.context === "policies" && n.content) {
        if (!profile.policies) profile.policies = [];
        profile.policies.push(n.content);
      }
    }

    // v264: re-cross-reference services on every read so category-level
    // services pick up freshly-computed candidate sets from the current
    // product seed (rather than being frozen to whatever was attached at
    // claim/edit time). Cheap — single product-table fetch + per-service map.
    if (profile.services && profile.services.length > 0) {
      profile.services = await crossReferenceServices(profile.services, sb);
    }

    return { claimed: true, sourceUrl, data: profile };
  });

const updateProfileInput = z.object({
  accessToken: z.string().min(1),
  edits: editableScrapeShape,
});

export const updateSpaProfile = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateProfileInput.parse(input))
  .handler(async ({ data }): Promise<SpaProfile> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // v265: dashboard-edit save now goes through the same shared helper as
    // claimSpa. The helper's per-field "undefined → leave alone" semantics
    // matches what the dashboard wants — touch only what the owner changed.
    // Dropped ~150 lines of duplicated upsert logic; both surfaces stay in
    // sync forever.
    await materializeSpaNodes(sb, userId, data.edits, "user-input");

    // Return the freshly-updated profile so the UI can hydrate from server truth.
    return getSpaProfileForUser(userId);
  });

// Helper: same shape as getSpaProfile but takes a userId directly so the
// updateSpaProfile handler can return without round-tripping through auth.
async function getSpaProfileForUser(userId: string): Promise<SpaProfile> {
  const sb = admin();
  const { data: nodes } = await sb
    .from("knowledge_nodes")
    .select("id, node_type, title, content, context, lookup_key, attachments, source_ref")
    .eq("user_id", userId)
    .in("context", ["spa-profile", "services", "policies"])
    .order("created_at", { ascending: true });

  if (!nodes || nodes.length === 0) return { claimed: false, data: {} };

  const profile: SpaScrapeData = {};
  let sourceUrl: string | undefined;
  for (const n of nodes) {
    if (n.source_ref && !sourceUrl) sourceUrl = n.source_ref;
    if (n.context === "spa-profile" && n.lookup_key) {
      const field = KEY_TO_FIELD[n.lookup_key];
      if (field === "spaName") profile.spaName = n.title ?? undefined;
      else if (field === "schedulingLink") {
        const url = (n.attachments as { url?: string } | null)?.url;
        profile.schedulingLink = url ?? n.content ?? undefined;
      } else if (field) (profile as any)[field] = n.content ?? undefined;
    } else if (n.context === "services" && n.title) {
      if (!profile.services) profile.services = [];
      const att = parseServiceAttachments(n.attachments);
      profile.services.push({
        name: n.title,
        matchedProduct: att.matchedProduct,
        price: att.price,
      });
    } else if (n.context === "policies" && n.content) {
      if (!profile.policies) profile.policies = [];
      profile.policies.push(n.content);
    }
  }
  if (profile.services && profile.services.length > 0) {
    profile.services = await crossReferenceServices(profile.services, sb);
  }
  return { claimed: true, sourceUrl, data: profile };
}
