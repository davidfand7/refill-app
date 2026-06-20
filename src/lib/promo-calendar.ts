/**
 * Manufacturer promo-calendar parsing + offer↔add-on matching —
 * Patient-Profitability OS · Phase 2 (Cross-Sell · Slice A).
 *
 * Validated against the real Allergan calendar (2026-current-promotions.csv:
 * Title | Details | Date(s) | Promotion Type). v1 ingests the "Dollars Off"
 * subset — patient-facing dollar offers on a mappable product — and surfaces
 * the best currently-active one as a badge on the matching booking add-on.
 *
 * Pure (no I/O, no Date.now()): the caller injects todayIso so matching stays
 * deterministic.
 */

import { parseCsvRows, parseMoney } from "@/lib/manufacturer-reward-csv";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * The spa-authored offer engine's types. A `dollars_off` offer is the
 * original (and every manufacturer-calendar offer); the rest are the
 * richness the spa-loyal loyalty engine adds. Bundle/bogo/series/first_visit/
 * spend_get are reserved (schema + enum land now, UI in later slices).
 */
export type OfferType =
  | "dollars_off"
  | "percent_off"
  | "free_addon"
  | "discount_addon"
  | "bundle"
  | "bogo"
  | "series"
  | "first_visit"
  | "spend_get";

/** Who an offer is for. 'all' = anyone (badges publicly); the rest are
 *  patient segments — they DON'T passively badge to anonymous visitors,
 *  they're delivered to matching patients (push) + only earn for in-cohort
 *  patients. */
export type OfferCohort = "all" | "lapsed" | "new" | "expiring" | "vip" | "waitlist";

/** A parsed promo-calendar offer (one row of the "Dollars Off" subset). */
export type PromoOffer = {
  /** Present only when read back from the DB (not set by the parser). */
  id?: string;
  /** "manufacturer" (calendar) or "spa" (owner-authored). DB-only. */
  source?: "manufacturer" | "spa";
  manufacturer: string;
  /** Normalized product keyword for service-name matching (e.g. "juvederm").
   *  For spa offers this is the normalized name of the TRIGGER service the
   *  offer applies to. */
  product: string;
  title: string;
  discountUsd: number | null;
  /** ISO yyyy-mm-dd, or null when the calendar says "Ongoing". */
  startsOn: string | null;
  endsOn: string | null;
  landingUrl: string | null;
  promotionType: string | null;
  rawTitle: string;
  // ── Offer-engine fields (DB-only; optional so the calendar parser, which
  //    only ever emits dollars_off, stays valid). ──
  /** Defaults to "dollars_off" when absent. */
  offerType?: OfferType;
  /** Percent value for percent_off (0–100). */
  valuePct?: number | null;
  /** Normalized name of the add-on this offer rewards (free/discount_addon). */
  addonServiceName?: string | null;
  /** Display name of the add-on / bundle item. */
  addonLabel?: string | null;
  /** Paused offers are skipped by the matcher. Defaults true when absent. */
  isActive?: boolean;
  /** Who the offer targets. Defaults "all" when absent. */
  targetCohort?: OfferCohort;
  /** Whether the offer is listed on the public Deals page. Defaults true. */
  showOnDeals?: boolean;
  /** Days of week the offer is live (0=Sun…6=Sat). null/empty = any day
   *  ("Tox Tuesdays" = [2]). */
  activeWeekdays?: number[] | null;
  /** Max redemptions; null = unlimited. Once redeemedCount hits it, the offer
   *  stops badging/matching. */
  quantityCap?: number | null;
  /** Redemptions so far (incremented on each cross-sell win). */
  redeemedCount?: number;
  /** How the cap accrues. "total" (default) = lifetime; once redeemedCount
   *  reaches quantityCap the offer is exhausted forever. "weekly" = the cap
   *  counts only the current week's redemptions ("20 per Tox Tuesday"), reset
   *  lazily each week. */
  capPeriod?: "total" | "weekly";
  /** For a weekly cap: the Monday (ISO yyyy-mm-dd) the stored redeemedCount
   *  belongs to. A count whose week is before today's reads as 0. */
  capPeriodStart?: string | null;
  /** "Refine targeting" predicates that NARROW the base cohort (v2.110). A
   *  non-empty spec makes the offer targeted (push-only, $5-gated by match).
   *  Defaults to {} (no refinement). */
  targetFilters?: OfferTargetFilters;
};

/**
 * Optional predicates that narrow an offer's base cohort to a refined audience.
 * All set fields are AND-combined. Resolved server-side against each patient's
 * knowledge_nodes.attachments rollup (lastVisit / totalVisits / lifetimeSpendUsd
 * / phone). Stored as the offer's `filter_spec` jsonb. "Bought X / not Y" is a
 * later pass (needs patient_transactions) and will extend this shape.
 */
export type OfferTargetFilters = {
  /** Last visit at least N days ago (e.g. "haven't been in 90+ days"). */
  lastVisitMinDays?: number | null;
  /** Last visit within the past N days (recently active). */
  lastVisitMaxDays?: number | null;
  /** Lifetime visit count at least / at most this many. */
  visitCountMin?: number | null;
  visitCountMax?: number | null;
  /** Lifetime spend (USD) at least / at most this much. */
  spendMinUsd?: number | null;
  spendMaxUsd?: number | null;
  /** Only patients with a phone on file (reachable by text). */
  reachableByTextOnly?: boolean;
};

/** The per-patient metrics the filter predicate reads (from attachments). */
export type PatientFilterMetrics = {
  /** ISO yyyy-mm-dd of the most recent visit, or null if unknown. */
  lastVisit?: string | null;
  totalVisits?: number | null;
  lifetimeSpendUsd?: number | null;
  phone?: string | null;
};

/** True when a spec actually constrains anything (any field set). An empty/
 *  absent spec means "no refinement" — the offer behaves as its base cohort. */
export function hasTargetFilters(spec: OfferTargetFilters | null | undefined): boolean {
  if (!spec) return false;
  return (
    spec.lastVisitMinDays != null ||
    spec.lastVisitMaxDays != null ||
    spec.visitCountMin != null ||
    spec.visitCountMax != null ||
    spec.spendMinUsd != null ||
    spec.spendMaxUsd != null ||
    spec.reachableByTextOnly === true
  );
}

/**
 * Pure predicate: does one patient satisfy a refine-targeting spec? Used by the
 * count, the push resolver, AND the $5 win-integrity gate, so "match" means the
 * same everywhere. `daysSinceLastVisit` is passed in (caller owns "today" — keeps
 * this deterministic and unit-testable). A null metric fails any bound that
 * references it (we don't push to / pay for a patient we can't verify).
 */
export function patientMatchesFilters(
  m: PatientFilterMetrics,
  spec: OfferTargetFilters | null | undefined,
  daysSinceLastVisit: number | null,
): boolean {
  if (!hasTargetFilters(spec)) return true;
  const s = spec as OfferTargetFilters;

  if (s.lastVisitMinDays != null) {
    if (daysSinceLastVisit == null || daysSinceLastVisit < s.lastVisitMinDays) return false;
  }
  if (s.lastVisitMaxDays != null) {
    if (daysSinceLastVisit == null || daysSinceLastVisit > s.lastVisitMaxDays) return false;
  }
  if (s.visitCountMin != null) {
    if (m.totalVisits == null || m.totalVisits < s.visitCountMin) return false;
  }
  if (s.visitCountMax != null) {
    if (m.totalVisits == null || m.totalVisits > s.visitCountMax) return false;
  }
  if (s.spendMinUsd != null) {
    if (m.lifetimeSpendUsd == null || m.lifetimeSpendUsd < s.spendMinUsd) return false;
  }
  if (s.spendMaxUsd != null) {
    if (m.lifetimeSpendUsd == null || m.lifetimeSpendUsd > s.spendMaxUsd) return false;
  }
  if (s.reachableByTextOnly === true) {
    if (!(m.phone ?? "").trim()) return false;
  }
  return true;
}

/** The badge shape attached to a service / add-on at booking. */
export type AddOnOffer = {
  /** e.g. "$75 off through Jun 30", "20% off", "Free brow wax with this". */
  label: string;
  /** What kind of offer this badge represents (drives nothing visual yet,
   *  but lets callers style or branch later). */
  offerType: OfferType;
  discountUsd: number | null;
  endsOn: string | null;
  landingUrl: string | null;
  title: string;
};

export type ParsedPromoCalendar = {
  offers: PromoOffer[];
  /** Rows skipped (not Dollars-Off, or no mappable product). */
  skipped: number;
  warnings: string[];
};

// ─── Product keyword vocabulary (Allergan-first; extend per manufacturer) ──

const PRODUCT_KEYWORDS = [
  "juvederm",
  "botox",
  "skinvive",
  "latisse",
  "diamondglow",
  "skinmedica",
  "coolsculpting",
  "cooltone",
  "kybella",
  "natrelle",
  // Evolus / Galderma (for later promo files)
  "jeuveau",
  "evolysse",
  "dysport",
  "restylane",
  "sculptra",
];

/** Lowercase, strip accents + ® ™, collapse whitespace. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[®™]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First known product keyword appearing in the text, or null. */
function productKeywordOf(text: string): string | null {
  const norm = normalizeForMatch(text);
  for (const k of PRODUCT_KEYWORDS) {
    if (norm.includes(k)) return k;
  }
  return null;
}

/**
 * Service-name synonyms per product — so a "$75 off Juvéderm" offer also
 * badges a service named "Dermal Filler", and a Botox offer badges
 * "Neurotoxin". Short/greedy tokens (e.g. "tox") are intentionally excluded.
 */
const PRODUCT_SYNONYMS: Record<string, string[]> = {
  botox: ["botox", "neurotoxin", "neuromodulator", "wrinkle relaxer", "tox treatment"],
  jeuveau: ["jeuveau", "neurotoxin", "neuromodulator", "wrinkle relaxer"],
  dysport: ["dysport", "neurotoxin", "neuromodulator", "wrinkle relaxer"],
  juvederm: ["juvederm", "dermal filler", "lip filler", "filler"],
  restylane: ["restylane", "dermal filler", "lip filler", "filler"],
  evolysse: ["evolysse", "dermal filler", "filler"],
  latisse: ["latisse", "lash"],
  diamondglow: ["diamondglow", "diamond glow"],
  skinmedica: ["skinmedica", "tns"],
  skinvive: ["skinvive", "skin booster"],
};

/** Whole-word containment: does `needle` (one or more space-separated tokens)
 *  appear as a complete token-run inside `haystack`? Both are already
 *  normalized (lowercase, single-spaced), so padding each end with a space
 *  turns a raw substring test into a word-boundary one. This is the confidence
 *  gate for cross-sell — a substring-only hit is weak evidence and must NOT
 *  badge: "Detox Treatment" no longer matches Botox's "tox treatment" synonym,
 *  and "Eyelash Extensions" no longer matches Latisse's "lash". */
function containsWords(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Does an offer's product match a (normalized) service/add-on name? Exported
 *  so the Promo Intelligence card matches services the SAME way the at-booking
 *  badge does (synonym-aware: a Juvéderm offer matches a "Filler" service).
 *  Matches on whole words only, so a partial-keyword collision never badges. */
export function productMatchesName(product: string, normName: string): boolean {
  const syns = PRODUCT_SYNONYMS[product] ?? [product];
  return syns.some((s) => containsWords(normName, s));
}

// ─── Date parsing ("June 3", "May 5 - June 30", "Ongoing") ─────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/** "June 3" / "Jun 30" (+ injected year) → ISO. Returns null on unparseable. */
function parseMonthDay(
  part: string,
  year: number,
  carryMonth: number | null,
): { iso: string; month: number } | null {
  const t = part.trim().toLowerCase();
  if (!t || t === "ongoing") return null;
  const m = t.match(/([a-z]+)?\s*(\d{1,2})/);
  if (!m) return null;
  const monthName = m[1];
  const day = parseInt(m[2], 10);
  const month = monthName ? MONTHS[monthName] : (carryMonth ?? null);
  if (!month || day < 1 || day > 31) return null;
  return {
    iso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    month,
  };
}

/** "June 3 - Ongoing" / "May 5 - June 30" / "Ongoing" → {startsOn, endsOn}. */
export function parseDateRange(
  raw: string,
  year: number,
): { startsOn: string | null; endsOn: string | null } {
  const t = (raw ?? "").trim();
  if (!t || t.toLowerCase() === "ongoing") {
    return { startsOn: null, endsOn: null };
  }
  const [a, b] = t.split(/\s*-\s*/, 2);
  const start = parseMonthDay(a ?? "", year, null);
  const end = b ? parseMonthDay(b, year, start?.month ?? null) : null;
  return { startsOn: start?.iso ?? null, endsOn: end?.iso ?? null };
}

// ─── Parse the calendar CSV ────────────────────────────────────────────────

/** Heuristic: does this look like a promo-calendar export? */
export function detectPromoCalendar(headers: string[]): boolean {
  const set = new Set(headers.map((h) => h.trim().toLowerCase()));
  return set.has("promotion type") && set.has("title") && set.has("date(s)");
}

/**
 * Parse a manufacturer promo calendar → the actionable "Dollars Off" offers.
 * `year` is injected (the calendar omits it) — pass the current year.
 */
export function parsePromoCalendar(
  csv: string,
  year: number,
  manufacturer = "allergan",
): ParsedPromoCalendar {
  const rows = parseCsvRows(csv).filter(
    (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""),
  );
  const warnings: string[] = [];
  if (rows.length === 0) {
    return { offers: [], skipped: 0, warnings: ["Empty file."] };
  }
  const headers = rows[0].map((h) => h.trim());
  const idx = (name: string) =>
    headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iTitle = idx("Title");
  const iDetails = idx("Details");
  const iDates = idx("Date(s)");
  const iType = idx("Promotion Type");

  const offers: PromoOffer[] = [];
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.every((c) => c.trim() === "")) continue;
    const title = (cells[iTitle] ?? "").trim();
    const type = (cells[iType] ?? "").trim();
    const details = iDetails >= 0 ? (cells[iDetails] ?? "") : "";
    const dates = iDates >= 0 ? (cells[iDates] ?? "") : "";

    // v1: only patient-facing dollar discounts.
    if (!/dollars\s*off/i.test(type)) {
      skipped++;
      continue;
    }
    const product = productKeywordOf(title);
    if (!product) {
      skipped++;
      warnings.push(`No mappable product in "${title}" — skipped.`);
      continue;
    }
    const amount = parseMoney((title.match(/\$\s*\d[\d,]*/)?.[0] ?? "").trim());
    const { startsOn, endsOn } = parseDateRange(dates, year);
    const landingUrl = details.match(/https?:\/\/[^\s"'<]+/)?.[0] ?? null;
    offers.push({
      manufacturer,
      product,
      title,
      discountUsd: amount,
      startsOn,
      endsOn,
      landingUrl,
      promotionType: type || null,
      rawTitle: title,
    });
  }
  return { offers, skipped, warnings: warnings.slice(0, 50) };
}

// ─── Offer ↔ add-on matching ───────────────────────────────────────────────

/** Day of week (0=Sun…6=Sat) for an ISO yyyy-mm-dd, or null if unparseable. */
function weekdayOf(iso: string): number | null {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Monday (ISO yyyy-mm-dd) of the week containing `iso`. Pure; weeks start
 *  Monday so a "weekly" cap resets the same way the at-booking matcher and the
 *  DB increment RPC compute it. Returns the input unchanged if unparseable. */
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun…6=Sat
  const sinceMonday = (dow + 6) % 7; // Mon→0, Sun→6
  dt.setUTCDate(dt.getUTCDate() - sinceMonday);
  return dt.toISOString().slice(0, 10);
}

/** The redemption count that counts AGAINST the cap right now. For a lifetime
 *  ("total") cap it's the raw stored count. For a "weekly" cap, a stored count
 *  whose cap_period_start is before this week's Monday belongs to a past week,
 *  so it reads as 0 — letting the offer badge again at the start of a new week
 *  even before any redemption has lazily reset the row. Mirrors the DB RPC. */
export function effectiveRedeemedCount(offer: PromoOffer, todayIso: string): number {
  const count = offer.redeemedCount ?? 0;
  if (offer.capPeriod !== "weekly") return count;
  if (!offer.capPeriodStart) return count; // never redeemed this period → as-is (0)
  return offer.capPeriodStart >= mondayOf(todayIso) ? count : 0;
}

function isActive(offer: PromoOffer, todayIso: string): boolean {
  if (offer.startsOn && todayIso < offer.startsOn) return false;
  if (offer.endsOn && todayIso > offer.endsOn) return false;
  // Recurrence: only live on the configured weekdays (empty/null = any day).
  if (offer.activeWeekdays && offer.activeWeekdays.length > 0) {
    const dow = weekdayOf(todayIso);
    if (dow == null || !offer.activeWeekdays.includes(dow)) return false;
  }
  // Quantity cap: exhausted once redemptions reach the cap. A weekly cap counts
  // only this week's redemptions (effectiveRedeemedCount handles the reset).
  if (
    offer.quantityCap != null &&
    effectiveRedeemedCount(offer, todayIso) >= offer.quantityCap
  ) {
    return false;
  }
  return true;
}

function fmtEnds(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1] ?? m} ${parseInt(d, 10)}`;
}

/** A rough rank so "best" is deterministic when several offers are active on
 *  one service. We can't convert % to $ without the price, so percent falls
 *  back to its own magnitude — fine in practice (a service rarely carries
 *  more than one spa offer). */
function offerRank(o: PromoOffer): number {
  return o.discountUsd ?? o.valuePct ?? 0;
}

/** Typed, computed badge label for an offer that has no owner-set title. */
function computedLabel(o: PromoOffer): string {
  const ends = fmtEnds(o.endsOn);
  const through = ends ? ` through ${ends}` : "";
  const type = o.offerType ?? "dollars_off";
  switch (type) {
    case "percent_off":
      return o.valuePct != null ? `${o.valuePct}% off${through}` : `Discount${through}`;
    case "free_addon":
      return o.addonLabel ? `Free ${o.addonLabel} with this${through}` : `Free add-on${through}`;
    case "discount_addon":
      return o.discountUsd != null
        ? `$${Math.round(o.discountUsd)} off ${o.addonLabel ?? "add-on"}${through}`
        : `Add-on offer${through}`;
    case "dollars_off":
    default:
      return o.discountUsd != null ? `$${Math.round(o.discountUsd)} off${through}` : `Offer${through}`;
  }
}

/**
 * The best currently-active offer (full record) matching a service / add-on
 * name. Paused offers are skipped; highest-value wins when several are active.
 * Returns the PromoOffer so callers that need its cohort/id (e.g. the win
 * gate) get them; bestActiveOfferForName wraps this into a badge shape.
 */
export function matchOfferForName(
  offers: PromoOffer[],
  addOnName: string,
  todayIso: string,
): PromoOffer | null {
  const name = normalizeForMatch(addOnName);
  let best: PromoOffer | null = null;
  for (const o of offers) {
    if (o.isActive === false) continue;
    if (!productMatchesName(o.product, name)) continue;
    if (!isActive(o, todayIso)) continue;
    if (!best || offerRank(o) > offerRank(best)) best = o;
  }
  return best;
}

/**
 * Offers that may PASSIVELY badge at booking. Cohort-targeted offers are
 * excluded — they're for matching patients (push), not every visitor, so
 * surfacing them anonymously would both leak and mis-imply eligibility.
 */
export function badgeableOffers(offers: PromoOffer[]): PromoOffer[] {
  // 'all' cohort badges — UNLESS it's been refined (a filter spec narrows it to
  // a targeted audience, so it reaches those patients via push, never the badge).
  return offers.filter(
    (o) => (o.targetCohort ?? "all") === "all" && !hasTargetFilters(o.targetFilters),
  );
}

/**
 * Best currently-active offer for a service / add-on as a badge shape.
 */
export function bestActiveOfferForName(
  offers: PromoOffer[],
  addOnName: string,
  todayIso: string,
): AddOnOffer | null {
  const best = matchOfferForName(offers, addOnName, todayIso);
  if (!best) return null;
  return {
    // Spa-authored offers show the owner's OWN label ("Save $100 w/ Emma" or
    // the type-aware auto-title built at creation, "20% off Botox"); a
    // manufacturer offer shows the clean computed "$X off through <date>"
    // (their raw titles are verbose, e.g. "$65 off BOTOX® Cosmetic-…").
    label: best.source === "spa" ? best.title : computedLabel(best),
    offerType: best.offerType ?? "dollars_off",
    discountUsd: best.discountUsd,
    endsOn: best.endsOn,
    landingUrl: best.landingUrl,
    title: best.title,
  };
}

// ─── Public Deals page ─────────────────────────────────────────────────────

/** A clean, patient-facing headline for an offer on the Deals page. Spa
 *  offers show the owner's own title; manufacturer offers get a tidy
 *  "$X off <Product>" (their raw titles are verbose). */
export function dealHeadline(offer: PromoOffer): string {
  if (offer.source === "spa") return offer.title;
  const product = offer.product
    ? offer.product.charAt(0).toUpperCase() + offer.product.slice(1)
    : "";
  if (offer.discountUsd != null && product) return `$${Math.round(offer.discountUsd)} off ${product}`;
  return offer.title;
}

/**
 * Offers eligible for the public Deals page: publicly badgeable (cohort
 * 'all'), not paused, currently in their date window, and not hidden from
 * Deals. Cohort-targeted offers are intentionally excluded — they reach
 * their patients via push, not a public list.
 */
export function publicDeals(offers: PromoOffer[], todayIso: string): PromoOffer[] {
  return badgeableOffers(offers).filter(
    (o) => o.isActive !== false && o.showOnDeals !== false && isActive(o, todayIso),
  );
}
