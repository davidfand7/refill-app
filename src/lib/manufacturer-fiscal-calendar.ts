/**
 * Manufacturer fiscal calendar + leverage-window engine (v2.148.0, Rep Deal-Maker slice 1).
 *
 * The published volume ladder (what v2.144–147 capture/verify/optimize) is NOT the
 * real floor. There's a HIDDEN negotiation layer where reps cut off-the-record
 * deals — driven heavily by QUOTA TIMING. This module institutionalizes the
 * timing half of the owner's negotiation game: it tells the owner WHEN the ask
 * lands hardest.
 *
 * Grounding (kept honest on purpose — see project_rep_dealmaker guardrail):
 *  - US aesthetics reps carry CALENDAR-QUARTER quotas (Q1 Jan–Mar … Q4 Oct–Dec).
 *    That quarter close is the near-universal leverage window, independent of any
 *    one manufacturer's corporate fiscal year. We drive the quarter math off the
 *    calendar quarter — the thing the rep is actually chasing.
 *  - The corporate fiscal YEAR-end adds extra pressure to one quarter. The
 *    publicly-traded aesthetics players report on the calendar year (Dec close),
 *    so year-end heat lands on Q4. Anything we're not sure of is flagged
 *    `assumed` with a "confirm with your rep" note — we never assert specifics
 *    we don't know.
 *
 * Pure + browser-safe (no DB, no SDK). `now` is injectable for testability.
 * This is app-runtime code, so `new Date()` as a default arg is fine here.
 */

export type FiscalConfidence = "known" | "assumed";

export type ManufacturerFiscal = {
  /** Calendar month (1–12) the fiscal YEAR closes. Drives the year-end flag. */
  fiscalYearEndMonth: number;
  confidence: FiscalConfidence;
  /** Owner-facing caveat about the source. */
  note: string;
};

/** Default for any manufacturer we don't have a specific read on. */
const DEFAULT_FISCAL: ManufacturerFiscal = {
  fiscalYearEndMonth: 12,
  confidence: "assumed",
  note: "Assuming standard calendar quarters — confirm your rep's exact quota timing with them.",
};

/**
 * Per-manufacturer fiscal config. Keys mirror the product manufacturer enum
 * (abbvie, galderma, evolus, merz, revance, …). All current entries close on
 * the calendar year; the value here is the source confidence + caveat, not a
 * claim of secret knowledge.
 */
export const MANUFACTURER_FISCAL: Record<string, ManufacturerFiscal> = {
  abbvie: {
    fiscalYearEndMonth: 12,
    confidence: "known",
    note: "AbbVie reports on the calendar year — Q4 (Dec) close is the biggest window.",
  },
  galderma: {
    fiscalYearEndMonth: 12,
    confidence: "known",
    note: "Galderma reports on the calendar year — Q4 (Dec) close is the biggest window.",
  },
  evolus: {
    fiscalYearEndMonth: 12,
    confidence: "known",
    note: "Evolus reports on the calendar year — Q4 (Dec) close is the biggest window.",
  },
  revance: {
    fiscalYearEndMonth: 12,
    confidence: "known",
    note: "Revance reports on the calendar year — Q4 (Dec) close is the biggest window.",
  },
  merz: {
    fiscalYearEndMonth: 12,
    confidence: "assumed",
    note: "Merz is privately held — quarter cadence shown is the standard calendar; confirm timing with your rep.",
  },
};

export function fiscalFor(manufacturer: string): ManufacturerFiscal {
  return MANUFACTURER_FISCAL[manufacturer.toLowerCase()] ?? DEFAULT_FISCAL;
}

/** How hot the ask window is, by proximity to the quarter close. */
export type LeverageIntensity = "open" | "warming" | "hot" | "closing";

export type LeverageWindow = {
  manufacturer: string;
  /** ISO yyyy-mm-dd of the current rep-quota period (calendar quarter) close. */
  periodEndIso: string;
  /** "Q2" */
  quarterLabel: string;
  /** "Apr–Jun" */
  quarterMonths: string;
  daysUntil: number;
  /** This quarter close is also the manufacturer's fiscal YEAR-end. */
  isYearEnd: boolean;
  intensity: LeverageIntensity;
  /** One-line owner-facing summary, ready to render. */
  headline: string;
  confidence: FiscalConfidence;
  note: string;
};

const QUARTER_MONTHS = ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"];
const MS_PER_DAY = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  // Whole days, counted off the calendar date (ignore the clock time) so a
  // window doesn't flicker between hours of the same day.
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

function rawIntensity(daysUntil: number): LeverageIntensity {
  if (daysUntil <= 7) return "closing";
  if (daysUntil <= 21) return "hot";
  if (daysUntil <= 45) return "warming";
  return "open";
}

const INTENSITY_ORDER: LeverageIntensity[] = ["open", "warming", "hot", "closing"];

/** Bump intensity one notch (year-end pressure), capped at "closing". */
function bump(level: LeverageIntensity): LeverageIntensity {
  const i = INTENSITY_ORDER.indexOf(level);
  return INTENSITY_ORDER[Math.min(i + 1, INTENSITY_ORDER.length - 1)];
}

function fmtDays(n: number): string {
  if (n <= 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n} days`;
}

/**
 * Compute the current leverage window for a manufacturer. Always returns a
 * window (every quarter has a close); intensity tells you how loud to be.
 */
export function computeLeverageWindow(
  manufacturer: string,
  now: Date = new Date(),
): LeverageWindow {
  const fiscal = fiscalFor(manufacturer);

  // Current calendar quarter (0-indexed) and its close (last day of the
  // quarter's final month).
  const month = now.getUTCMonth(); // 0–11 — use UTC consistently with daysBetween
  const qIndex = Math.floor(month / 3); // 0..3
  const endMonth = qIndex * 3 + 2; // 2,5,8,11 → Mar,Jun,Sep,Dec
  const year = now.getUTCFullYear();
  // Day 0 of the next month = last day of endMonth.
  const periodEnd = new Date(Date.UTC(year, endMonth + 1, 0));
  const periodEndIso = periodEnd.toISOString().slice(0, 10);

  const daysUntil = Math.max(0, daysBetween(now, periodEnd));
  const isYearEnd = endMonth + 1 === fiscal.fiscalYearEndMonth;

  let intensity = rawIntensity(daysUntil);
  if (isYearEnd && (intensity === "warming" || intensity === "hot" || intensity === "open")) {
    intensity = bump(intensity);
  }

  const quarterLabel = `Q${qIndex + 1}`;
  const quarterMonths = QUARTER_MONTHS[qIndex];

  const headline = buildHeadline({
    quarterLabel,
    daysUntil,
    isYearEnd,
    intensity,
  });

  return {
    manufacturer,
    periodEndIso,
    quarterLabel,
    quarterMonths,
    daysUntil,
    isYearEnd,
    intensity,
    headline,
    confidence: fiscal.confidence,
    note: fiscal.note,
  };
}

function buildHeadline(args: {
  quarterLabel: string;
  daysUntil: number;
  isYearEnd: boolean;
  intensity: LeverageIntensity;
}): string {
  const { quarterLabel, daysUntil, isYearEnd, intensity } = args;
  const when = fmtDays(daysUntil);
  if (isYearEnd) {
    return `${quarterLabel} + fiscal year-end closes ${when} — the biggest negotiation window of the year.`;
  }
  switch (intensity) {
    case "closing":
      return `${quarterLabel} closes ${when} — your rep is chasing their number right now. Strongest ask window.`;
    case "hot":
      return `${quarterLabel} closes ${when} — the quarter-end push is on. Good time to ask.`;
    case "warming":
      return `${quarterLabel} closes ${when} — the window is opening as quota pressure builds.`;
    default:
      return `${quarterLabel} closes ${when} — quiet for now; the ask lands harder closer to quarter-end.`;
  }
}
