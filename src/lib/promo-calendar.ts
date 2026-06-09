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

/** A parsed promo-calendar offer (one row of the "Dollars Off" subset). */
export type PromoOffer = {
  /** Present only when read back from the DB (not set by the parser). */
  id?: string;
  /** "manufacturer" (calendar) or "spa" (owner-authored). DB-only. */
  source?: "manufacturer" | "spa";
  manufacturer: string;
  /** Normalized product keyword for service-name matching (e.g. "juvederm"). */
  product: string;
  title: string;
  discountUsd: number | null;
  /** ISO yyyy-mm-dd, or null when the calendar says "Ongoing". */
  startsOn: string | null;
  endsOn: string | null;
  landingUrl: string | null;
  promotionType: string | null;
  rawTitle: string;
};

/** The badge shape attached to an add-on at booking. */
export type AddOnOffer = {
  /** e.g. "$75 off through Jun 30" or "$75 off". */
  label: string;
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

/** Does an offer's product match a (normalized) service/add-on name? */
function productMatchesName(product: string, normName: string): boolean {
  const syns = PRODUCT_SYNONYMS[product] ?? [product];
  return syns.some((s) => normName.includes(s));
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

function isActive(offer: PromoOffer, todayIso: string): boolean {
  if (offer.startsOn && todayIso < offer.startsOn) return false;
  if (offer.endsOn && todayIso > offer.endsOn) return false;
  return true;
}

function fmtEnds(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1] ?? m} ${parseInt(d, 10)}`;
}

/**
 * Best currently-active offer for an add-on, matched by product keyword in
 * the add-on's name. Highest discount wins when several are active.
 */
export function bestActiveOfferForName(
  offers: PromoOffer[],
  addOnName: string,
  todayIso: string,
): AddOnOffer | null {
  const name = normalizeForMatch(addOnName);
  let best: PromoOffer | null = null;
  for (const o of offers) {
    if (!productMatchesName(o.product, name)) continue;
    if (!isActive(o, todayIso)) continue;
    if (!best || (o.discountUsd ?? 0) > (best.discountUsd ?? 0)) best = o;
  }
  if (!best) return null;
  const ends = fmtEnds(best.endsOn);
  const amt = best.discountUsd != null ? `$${Math.round(best.discountUsd)} off` : "Offer";
  const computed = ends ? `${amt} through ${ends}` : amt;
  return {
    // Spa-authored offers show the owner's OWN label ("Save $100 w/ Emma");
    // manufacturer offers show the clean computed "$X off through <date>"
    // (their raw titles are verbose, e.g. "$65 off BOTOX® Cosmetic-…").
    label: best.source === "spa" ? best.title : computed,
    discountUsd: best.discountUsd,
    endsOn: best.endsOn,
    landingUrl: best.landingUrl,
    title: best.title,
  };
}
