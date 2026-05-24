/**
 * Gemini structured-output extraction for spa-site scrapes.
 *
 * Replaces the regex extractors in spa-claim.functions.ts. Hand it the
 * raw FireCrawl markdown (across multiple pages), get back structured
 * SpaScrapeData. Robust to JS-rendered, template-builder, and
 * unconventional spa websites where regex patterns reliably miss.
 *
 * Why not reuse agent-runtime.ts: agent-runtime is tuned for the
 * function-calling tool loop (Karen + Liz). This helper is a one-shot
 * structured-output call with no tools. Cheaper to keep separate than
 * parameterize the existing runtime to also handle this shape.
 *
 * Auth: same VERTEX_SA_JSON Cloudflare secret used by agent-runtime.ts.
 * Model: gemini-2.5-pro (overrideable via GEMINI_EXTRACT_MODEL env). v279
 * upgraded from -flash after Boujee Nurse showed Flash is unreliable at
 * negative-instruction following on long prompts (the prompt explicitly
 * lists "Where Confidence Begins" / "Two Locations One Standard" as
 * non-services and Flash extracted them anyway). Pro follows long
 * negative instructions better; ~5x cost per call but still pennies/spa
 * and one-shot per claim. Plus belt-and-suspenders post-filter below.
 *
 * Established 2026-05-09 (v258) — Phase 4.0 W1 spa-side enhanced extraction.
 */

import { z } from "zod";
import { loadServiceAccount, getVertexAccessToken } from "@/server/google-auth";

// Google service-account auth + JWT token caching moved to @/server/google-auth
// as of v267 — single source of truth, shared cache with agent-runtime.

const EXTRACT_TIMEOUT_MS = 45_000;

// ─── Extraction prompt + schema ────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting structured information from a med spa or aesthetics practice's public website. Each page below comes as multiple structured signal sources — TITLE, META DESCRIPTION, OG/TWITTER DESCRIPTION, JSON-LD, and BODY (raw HTML or markdown). Use ALL of them.

The META DESCRIPTION + OG/TWITTER tags are often the richest concentrated source on JS-heavy spa sites — they're written by the spa to summarize what they offer for search engines and social previews, so they typically list the actual treatments + pricing in plain text. Trust this source EQUALLY with the body. If a service appears in the meta description but not the body, it's still a service the spa offers.

If BODY is HTML, you can ignore tags and focus on visible text content — INCLUDING content inside accordion panels, tabs, and aria-hidden elements (those are visible to clients when they click; treat them as visible source content).

Extract the following as JSON matching the response schema.

## Services — be PRECISE, not liberal, AND capture pricing when present

A "service" is a specific treatment, procedure, or product a client can request by name and book an appointment for.

When a service has a price visibly attached on the site (in meta description, body content, a pricing list, or anywhere adjacent to the service name), capture it as a string preserving the spa's own phrasing. Examples of the formats you'll see:
- "$14/unit" (per-unit injectables)
- "from $595" (starting-at filler pricing)
- "$1,500" (flat-fee body treatments)
- "$1,500-$3,000" (ranges)
- "Call for price" / "Consultation required" (intentional non-pricing)
- "$695 first session" (with qualifier)

Do NOT normalize, round, or convert. Capture verbatim. Customers will be quoted these prices by the spa's AI assistant, so accuracy and the spa's tone matter more than uniformity. Leave price empty if no price appears next to the service.

Common patterns to watch for in meta descriptions: "Botox $14/unit, Juvederm fillers from $595, CoolSculpting $1500, RF Microneedling $695" — that's a pricing summary the spa wrote for SEO; it's authoritative, capture each price for its respective service.

INCLUDE as services:
- Injectables: Botox, Dysport, Jeuveau, Xeomin, Juvederm, Restylane, RHA, Belotero, Sculptra, Radiesse, Skinvive, Profhilo
- Or generic categories the spa lists: Toxins, Neuromodulators, Fillers, Lip Filler, Cheek Filler, Tear Trough, Biostimulators
- Lasers + energy: IPL, BBL, Halo, Moxi, Pico, Fraxel, Laser Hair Removal, Laser Skin Renewal, RF Microneedling, Morpheus8, Sofwave, Ultherapy, Thermage
- Body: CoolSculpting, EmSculpt, EmFace, EmTone, body contouring
- Facials: HydraFacial, Diamond Glow, Oxygen Facial, Dermaplaning, Custom Facial
- Peels: Glycolic, Salicylic, Vi Peel, TCA, Jessner's
- Microneedling, SkinPen, microchanneling
- IV therapy, vitamin shots, Semaglutide / GLP-1, weight management programs
- Threading, brow lift, jaw slimming, double chin treatment
- Specific named procedures the spa offers ("Liquid Facelift", "Mommy Makeover Package")

DO NOT INCLUDE as services:
- Marketing taglines: "Where Confidence Begins", "Artistry in Every Detail", "Results You Can Trust", "Luxury Without Pretension", "Two Locations One Standard", "Beauty Redefined", "Confidence Restored"
- CTAs / buttons: "Get In Touch", "Book Now", "Contact Us", "Schedule a Consultation", "Learn More", "Get Started"
- Navigation labels: "Home", "About", "Services", "Reviews", "Gallery", "FAQ", "Blog", "Specials"
- Locations / city names: "Downtown Denver", "Greenwood Village", "Our Studio", "Visit Us"
- Loyalty perks / VIP programs: "Anniversary Bonus", "Monthly Complimentary Service", "Exclusive Pricing", "VIP Experience", "Club Membership"
- Social handles: "@spaname", "Instagram", "Follow Us", "TikTok"
- Page sections: "Words From Our Community", "Everything You Need to Know", "Phone", "Hours", "Reviews", "Testimonials", "Meet the Team", "Our Story", "Why Choose Us"
- Generic abstractions without practice context: "Wellness", "Beauty", "Aesthetics" (alone, without a treatment qualifier)

The litmus test: would a customer say "I'd like to book a [thing]" or "Tell me about your [thing] treatment"? If no, it's not a service. When in doubt, OMIT.

A typical med spa offers 8-25 services. If you've extracted 30+ entries, you've probably scraped marketing copy — review and prune.

## Spa name

Return the brand name only — typically 1-4 words. Strip SEO suffixes:
- "Rejuv Skin Spa | #1 Med Spa In Denver" → "Rejuv Skin Spa"
- "Boujee Nurse | Denver Med Spa — Botox, Filler, Laser & Facial Treatments" → "Boujee Nurse"
- "Glow Aesthetics — Best Day Spa NYC" → "Glow Aesthetics"
- "The Skin Lab : Premier Aesthetic Clinic" → "The Skin Lab"

If the title contains | — – or : separators, the brand name is almost always the part BEFORE the first separator.

## Scheduling link

Return the URL of the actual booking/scheduling system. Common platforms include Acuity (acuityscheduling.com), Vagaro, Mindbody, Jane App (*.janeapp.com), Boulevard, Schedulicity, Calendly, GlossGenius, Mangomint, Aesthetic Record, Zenoti, Phorest, Setmore, Square, Fresha. Look for external links to these. If only an internal "/book" page exists on the spa's own domain, return that. If nothing booking-related is present, leave empty.

## Policies

Include short statements about cancellations, deposits, late arrivals, no-show rules, age restrictions, refund policies. Each as a separate string. If no policies are stated on the site, return an empty array. Do not invent.

## General

If a field isn't present on the site, omit it (or return empty array for arrays). Never fabricate. Never invent emails, phone numbers, addresses, hours, services, or policies that aren't in the source text.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    spaName: { type: "STRING" },
    description: { type: "STRING" },
    services: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          description: { type: "STRING" },
          // v266: pricing string preserved verbatim from site copy.
          price: { type: "STRING" },
        },
        required: ["name"],
      },
    },
    hours: { type: "STRING" },
    schedulingLink: { type: "STRING" },
    contactEmail: { type: "STRING" },
    contactPhone: { type: "STRING" },
    address: { type: "STRING" },
    policies: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["services", "policies"],
} as const;

export type ExtractedSpaData = {
  spaName?: string;
  description?: string;
  services: Array<{ name: string; description?: string; price?: string }>;
  hours?: string;
  schedulingLink?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  policies: string[];
};

// v268: Zod schema for the Gemini response shape. Validating the parsed JSON
// against this BEFORE casting catches API drift early (e.g., Gemini renames
// `services[].price` → `services[].pricing`, or returns `services` as an
// object map instead of array). Pre-v268: `JSON.parse(text) as ExtractedSpaData`
// would silently allow malformed responses through, surfacing as bizarre
// runtime behavior in materializeSpaNodes / chip rendering. Now: the parse
// fails loudly with a specific zod issue, the caller falls back to regex,
// and ops can grep logs for the actual schema drift.
//
// Permissive on every field except the two arrays (services + policies)
// which are schema-required. Mirrors the defensive normalization in
// extractFromContent — Gemini sometimes omits optional fields entirely
// rather than returning them as empty strings.
const geminiResponseSchema = z.object({
  spaName: z.string().optional(),
  description: z.string().optional(),
  services: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      price: z.string().optional(),
    }),
  ),
  hours: z.string().optional(),
  schedulingLink: z.string().optional(),
  contactEmail: z.string().optional(),
  contactPhone: z.string().optional(),
  address: z.string().optional(),
  policies: z.array(z.string()),
});

// ─── Post-extraction service filter ───────────────────────────────────────
//
// v279 belt-and-suspenders: even with gemini-2.5-pro, marketing-heavy spa
// sites (luxury brands, Wix/Squarespace templates with prominent H1
// taglines) can leak non-service phrases into the services array. This
// filter catches the deterministic patterns we KEEP seeing — taglines,
// section headers, locations, contact labels, perks. Conservative:
// only rejects when high-confidence; ambiguous candidates pass through.
//
// Patterns derived from real failures: Boujee Nurse 2026-05-10 (5/24 real
// services), plus the prompt's own DO-NOT-INCLUDE list (which Gemini-Flash
// ignored — kept here as a hard backstop regardless of model).

// Phrases / shapes that almost never describe a bookable medical service.
const TAGLINE_PATTERNS: readonly RegExp[] = [
  /\bWhere\s+\w+\s+(Begin|End|Start|Live|Last|Belong)/i,  // "Where Confidence Begins"
  /\bIn\s+Every\s+\w+\b/i,                                 // "Artistry in Every Detail"
  /\bWithout\s+(Pretension|Compromise|Limits|Apology)\b/i, // "Luxury Without Pretension"
  /\bNot\s+(Assembly|Compromise|Replacement|Optional)\b/i, // "Artistry, Not Assembly"
  /\bThat\s+(Speak|Last|Matter)\b/i,                       // "Transformations That Speak…"
  /\bYou\s+Can\s+(Trust|Believe|Count\s+On)\b/i,           // "Results You Can Trust"
  /\bWords\s+From\b/i,                                     // "Words From Our Community"
  /\bEverything\s+You\b/i,                                 // "Everything You Need to Know"
  /\bReady\s+to\s+(Feel|Experience|Begin|Glow)\b/i,        // "Ready to Feel…"
  /^\s*Two\s+Locations\b/i,                                // "Two Locations, One Standard"
  /\bOne\s+Standard\b/i,                                   // companion to above
];

// Loyalty / VIP / promo phrasing — not bookable services.
const PERK_PATTERN =
  /\b(Exclusive|Complimentary|Anniversary\s+Bonus|VIP\s+Experience|Member(ship)?\s+(Benefit|Perks?)|Loyalty\s+Program)\b/i;

// "Downtown Denver", "Uptown Manhattan", "East Village" etc. — pure geo descriptors.
const GEO_PREFIX_PATTERN =
  /^\s*(Downtown|Uptown|Midtown|Greater|East|West|North|South|Old|New)\s+[A-Z][a-zA-Z]+\s*$/;

// Generic page/contact labels — exact-match (case-insensitive) to avoid
// killing legit single-word service candidates the spa might write tersely.
const GENERIC_LABELS = new Set([
  "phone", "email", "address", "hours", "location", "locations",
  "about", "about us", "reviews", "gallery", "faq", "blog", "specials",
  "home", "services", "contact", "contact us", "directions", "map",
  "find us", "visit us", "menu", "team", "our story", "why choose us",
  "testimonials", "press",
]);

// Social handles + Instagram-style strings.
const SOCIAL_HANDLE_PATTERN = /^@\w/;

// Pulls "City" out of an address string like "5555 Foo St, Greenwood
// Village, CO 80111" — used to filter standalone city/neighborhood names
// the LLM extracted as services. Best-effort: matches the segment between
// the last comma-before-state and the state code.
function deriveCityNamesFromAddress(address?: string): Set<string> {
  if (!address) return new Set();
  const out = new Set<string>();
  // ", City Name, ST" or ", City Name, ST 12345"
  const m = address.match(
    /,\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s*,\s*[A-Z]{2}\b/,
  );
  if (m) out.add(m[1].toLowerCase().trim());
  return out;
}

interface ServiceFilterContext {
  /** City/neighborhood names parsed out of the spa's own address. */
  cityNames: Set<string>;
}

function isLikelyService(name: string, ctx: ServiceFilterContext): boolean {
  const t = name.trim();
  if (t.length < 3 || t.length > 70) return false;
  if (SOCIAL_HANDLE_PATTERN.test(t)) return false;
  if (/\?\s*$/.test(t)) return false; // question-shape headings
  const lower = t.toLowerCase();
  if (GENERIC_LABELS.has(lower)) return false;
  if (ctx.cityNames.has(lower)) return false;
  if (GEO_PREFIX_PATTERN.test(t)) return false;
  if (PERK_PATTERN.test(t)) return false;
  for (const p of TAGLINE_PATTERNS) if (p.test(t)) return false;
  return true;
}

// ─── Page input shape ──────────────────────────────────────────────────────

/**
 * Per-page metadata extracted from FireCrawl's metadata + rawHtml. v264 added
 * this as a first-class signal source — on JS-heavy sites (Figma Make, Wix,
 * Squarespace) the body is sparse but the meta tags often contain a complete
 * services + pricing summary the spa wrote for SEO/social cards. Treating
 * these as inputs alongside the body gets us 90-95% data on 90-95% of sites
 * without fighting headless rendering.
 */
export type PageMetadata = {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  /** Schema.org JSON-LD payload (already JSON-stringified). */
  jsonLd?: string;
};

export type ExtractInput = {
  url: string;
  /**
   * Page body — raw HTML preferred (preserves accordion-collapsed content);
   * fall back to markdown if rawHtml unavailable.
   */
  body: string;
  /** v264: structured signal sources alongside the body. */
  metadata?: PageMetadata;
};

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Extract structured spa data from one or more scraped pages.
 *
 * Pages are concatenated with URL headers so the LLM knows page boundaries.
 * Per-page content is truncated to MAX_PER_PAGE_CHARS to keep total context
 * bounded; spa sites under that limit pass through unchanged. Cap is wider
 * for HTML (which has more bytes-per-information than markdown) but still
 * fits within Gemini Flash 1M-token context easily.
 *
 * Throws on auth/network/parse errors — caller is expected to fall back
 * to regex extractors.
 */
export async function extractFromContent(
  pages: ExtractInput[],
): Promise<ExtractedSpaData> {
  // 24K chars/page × 6 pages = ~144K chars total, well under Gemini Flash's
  // 1M token context. v258 was 8K (markdown only); v261 raised because HTML
  // is verbose but the signal density per page is what matters.
  const MAX_PER_PAGE_CHARS = 24000;
  const sa = loadServiceAccount();
  const model = process.env.GEMINI_EXTRACT_MODEL ?? "gemini-2.5-pro";
  const location = process.env.GEMINI_LOCATION ?? "us-central1";

  if (pages.length === 0) {
    return { services: [], policies: [] };
  }

  const concatenated = pages
    .map((p) => {
      const lines: string[] = [`--- PAGE: ${p.url} ---`, ""];
      const m = p.metadata ?? {};
      if (m.title) lines.push(`TITLE: ${m.title}`);
      if (m.description) lines.push(`META DESCRIPTION: ${m.description}`);
      if (m.ogTitle && m.ogTitle !== m.title) lines.push(`OG TITLE: ${m.ogTitle}`);
      if (m.ogDescription && m.ogDescription !== m.description)
        lines.push(`OG DESCRIPTION: ${m.ogDescription}`);
      if (m.twitterTitle && m.twitterTitle !== m.title && m.twitterTitle !== m.ogTitle)
        lines.push(`TWITTER TITLE: ${m.twitterTitle}`);
      if (
        m.twitterDescription &&
        m.twitterDescription !== m.description &&
        m.twitterDescription !== m.ogDescription
      )
        lines.push(`TWITTER DESCRIPTION: ${m.twitterDescription}`);
      if (m.jsonLd) lines.push(`JSON-LD: ${m.jsonLd.substring(0, 4000)}`);
      lines.push("", "BODY:", (p.body ?? "").substring(0, MAX_PER_PAGE_CHARS));
      return lines.join("\n");
    })
    .join("\n\n");

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const accessToken = await getVertexAccessToken(sa);
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: concatenated }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini extract failed (${res.status}): ${errText.slice(0, 400)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) {
    throw new Error("Gemini extract returned no text.");
  }

  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Gemini extract returned non-JSON: ${(e as Error).message} — preview: ${text.slice(0, 200)}`,
    );
  }

  // v268: validate shape against zod schema before downstream code touches it.
  const validated = geminiResponseSchema.safeParse(rawParsed);
  if (!validated.success) {
    const issueSummary = validated.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Gemini response failed schema validation — ${issueSummary} — preview: ${text.slice(0, 200)}`,
    );
  }
  const parsed = validated.data;

  // Defensive normalization — schema-required arrays might come back as objects
  // or undefined depending on model behavior at the seam.
  const address =
    typeof parsed.address === "string" ? parsed.address.trim() || undefined : undefined;

  // v279: post-extraction filter. Even with gemini-2.5-pro, marketing-heavy
  // sites can leak taglines / locations / perks into the services array.
  // Filter is conservative — only rejects high-confidence non-services.
  const filterCtx: ServiceFilterContext = {
    cityNames: deriveCityNamesFromAddress(address),
  };

  const rawServices = Array.isArray(parsed.services)
    ? parsed.services
        .filter((s) => s && typeof s.name === "string" && s.name.trim().length > 0)
        .map((s) => ({
          name: s.name.trim(),
          description:
            typeof s.description === "string" && s.description.trim().length > 0
              ? s.description.trim()
              : undefined,
          price:
            typeof s.price === "string" && s.price.trim().length > 0
              ? s.price.trim().substring(0, 80)
              : undefined,
        }))
    : [];

  const services = rawServices.filter((s) => isLikelyService(s.name, filterCtx));
  const droppedCount = rawServices.length - services.length;
  if (droppedCount > 0) {
    const droppedNames = rawServices
      .filter((s) => !isLikelyService(s.name, filterCtx))
      .map((s) => s.name);
    // Structured log so ops can grep + tune the filter when a real service
    // gets nuked. Stays in the log even on success; sample size is small.
    console.log(
      JSON.stringify({
        event: "gemini_extract_service_filter",
        kept: services.length,
        dropped: droppedCount,
        droppedSample: droppedNames.slice(0, 10),
        model,
      }),
    );
  }

  return {
    spaName: typeof parsed.spaName === "string" ? parsed.spaName.trim() || undefined : undefined,
    description: typeof parsed.description === "string" ? parsed.description.trim() || undefined : undefined,
    services,
    hours: typeof parsed.hours === "string" ? parsed.hours.trim() || undefined : undefined,
    schedulingLink:
      typeof parsed.schedulingLink === "string" ? parsed.schedulingLink.trim() || undefined : undefined,
    contactEmail:
      typeof parsed.contactEmail === "string" ? parsed.contactEmail.trim() || undefined : undefined,
    contactPhone:
      typeof parsed.contactPhone === "string" ? parsed.contactPhone.trim() || undefined : undefined,
    address,
    policies: Array.isArray(parsed.policies)
      ? parsed.policies
          .filter((p) => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.trim())
      : [],
  };
}
