/**
 * Emma(OS) Promotions Engine — Phase 1 template gallery.
 *
 * Eight template definitions covering the workflows most spas already run
 * manually. Each entry is a starting point — the spa owner picks one,
 * tweaks the cohort / offer / copy, and ships. Per the roadmap, custom is
 * the escape hatch when none of the standard seven fit.
 *
 * Pure data — no I/O. Imported by both the route gallery (cards UI) and
 * the create-campaign server fn (default attachments scaffolding).
 *
 * Established 2026-05-15 (Promotions Engine Phase 1).
 */

import type { ProductManufacturer, ProductKind } from "@/lib/product-manufacturer-map";

// ─── Public types ─────────────────────────────────────────────────────────

export type TemplateKind =
  | "first_time"
  | "reactivation"
  | "cross_sell"
  | "volume_upsell"
  | "anniversary"
  | "loyalty"
  | "birthday"
  | "custom";

/**
 * Saved cohort filter — Phase 1 stores the raw structure on the campaign's
 * attachments; Phase 2 will build the visual query editor over it. The
 * shape is intentionally open (matches the design doc's "saved filter ast")
 * so we can extend filter types without a schema migration.
 *
 * NULL fields = "no filter on this axis". The cohort resolver (Phase 2)
 * runs these against patient_transactions + knowledge_nodes attachments.
 */
export type CohortQuery = {
  /** Patient must have purchased this kind. */
  hasPurchasedKind?: ProductKind;
  /** Patient must NOT have purchased this kind (cross-sell case). */
  notPurchasedKind?: ProductKind;
  /** Patient must have a primary brand affinity. */
  primaryManufacturer?: ProductManufacturer;
  /** Patient must have visited at least N times. */
  minTotalVisits?: number;
  /** Patient must have last-visited at LEAST this many days ago. */
  minDaysSinceLastVisit?: number;
  /** Patient must have last-visited AT MOST this many days ago. */
  maxDaysSinceLastVisit?: number;
  /** Patient must have lifetime spend ≥ this much. */
  minLifetimeSpendUsd?: number;
  /** Patient must have first visit anniversary in the current calendar month. */
  anniversaryMonth?: boolean;
  /** Patient must have a phone number AND/OR email (channel-reachable). */
  requireReachable?: boolean;
};

/**
 * Promotional offer shape — kept open so a custom campaign can layer pieces
 * (e.g. "20% off plus a free aftercare kit"). The blast composer (Phase 3)
 * reads these to compose the [VERIFIED] math chip; templates lock the
 * common shape and leave amounts editable.
 */
export type CampaignOffer = {
  discountPct?: number;
  flatAmountUsd?: number;
  freeUnits?: number;
  /** Headline copy stub for the [VERIFIED] math chip. */
  headline?: string;
};

export type CampaignChannels = {
  sms: boolean;
  email: boolean;
};

export type CampaignState = "draft" | "live" | "closed" | "archived";

/**
 * The full attachments payload stored on knowledge_nodes for a campaign
 * node (node_type='campaign', context='campaigns'). All fields scoped to
 * the spa's user_id via the existing knowledge_nodes RLS.
 */
export type CampaignAttachments = {
  templateKind: TemplateKind;
  cohortQuery: CohortQuery;
  offer: CampaignOffer;
  channels: CampaignChannels;
  /**
   * Acuity / GetClio / etc deep-link template. The booking-page surface
   * (Phase 4) substitutes the token at render time.
   */
  bookingLinkTemplate: string;
  /** Max 1 SMS per patient per N days (regulatory velocity guardrail). */
  velocityCapDays: number;
  /** Local quiet hours — SMS sends gate to this window per patient timezone. */
  quietHours: { localStart: string; localEnd: string };
  /** ISO YYYY-MM-DD; null = always-on (e.g. reactivation evergreen). */
  starts: string | null;
  ends: string | null;
  state: CampaignState;
};

export type CampaignTemplateDef = {
  kind: TemplateKind;
  /** Title rendered on the gallery card. */
  title: string;
  /** Short subtitle / explainer for the card. */
  description: string;
  /** Example copy line the spa owner sees as a "this is what it does" hint. */
  exampleCopy: string;
  /**
   * Default attachments scaffolding — what `createSpaCampaign` writes onto
   * the new knowledge_node. The spa owner edits these in the detail page
   * (Phase 1 read-only) and the cohort editor (Phase 2).
   */
  defaults: CampaignAttachments;
};

// ─── The 8 templates ──────────────────────────────────────────────────────

const STANDARD_CHANNELS: CampaignChannels = { sms: true, email: true };
const STANDARD_QUIET = { localStart: "09:00", localEnd: "21:00" } as const;

export const CAMPAIGN_TEMPLATES: ReadonlyArray<CampaignTemplateDef> = [
  {
    kind: "first_time",
    title: "First-time treatment",
    description:
      "Convert your patients of one service into trying a complementary one for the first time.",
    exampleCopy: "Try Jeuveau — first treatment 30% off through May 31.",
    defaults: {
      templateKind: "first_time",
      cohortQuery: {
        notPurchasedKind: "toxin",
        minTotalVisits: 2,
        requireReachable: true,
      },
      offer: {
        discountPct: 30,
        headline: "First treatment 30% off",
      },
      channels: STANDARD_CHANNELS,
      bookingLinkTemplate: "",
      velocityCapDays: 7,
      quietHours: { ...STANDARD_QUIET },
      starts: null,
      ends: null,
      state: "draft",
    },
  },
  {
    kind: "reactivation",
    title: "We miss you (reactivation)",
    description:
      "Patients who haven't been in for 6+ months. The single highest-ROI campaign type for any med spa.",
    exampleCopy:
      "We miss you, {first_name} — 20% off your next visit, valid through {date}.",
    defaults: {
      templateKind: "reactivation",
      cohortQuery: {
        minDaysSinceLastVisit: 180,
        minLifetimeSpendUsd: 500,
        requireReachable: true,
      },
      offer: {
        discountPct: 20,
        headline: "20% off your next visit",
      },
      channels: STANDARD_CHANNELS,
      bookingLinkTemplate: "",
      velocityCapDays: 14, // longer for high-emotion outreach
      quietHours: { ...STANDARD_QUIET },
      starts: null,
      ends: null,
      state: "draft",
    },
  },
  {
    kind: "cross_sell",
    title: "Toxin patients → try filler",
    description:
      "Loyal toxin patients who have never tried filler. Strongest cross-sell signal in the data.",
    exampleCopy:
      "You love what Botox does for your forehead — let's try Voluma for cheek volume. $200 off your first syringe.",
    defaults: {
      templateKind: "cross_sell",
      cohortQuery: {
        hasPurchasedKind: "toxin",
        notPurchasedKind: "filler",
        minTotalVisits: 3,
        requireReachable: true,
      },
      offer: {
        flatAmountUsd: 200,
        headline: "$200 off your first syringe",
      },
      channels: STANDARD_CHANNELS,
      bookingLinkTemplate: "",
      velocityCapDays: 14,
      quietHours: { ...STANDARD_QUIET },
      starts: null,
      ends: null,
      state: "draft",
    },
  },
  {
    kind: "volume_upsell",
    title: "Volume upsell",
    description:
      "High-frequency patients who are great candidates for a multi-treatment package.",
    exampleCopy:
      "Lock in your next 4 Jeuveau treatments at $11/unit (savings of $200).",
    defaults: {
      templateKind: "volume_upsell",
      cohortQuery: {
        hasPurchasedKind: "toxin",
        minTotalVisits: 5,
        requireReachable: true,
      },
      offer: {
        flatAmountUsd: 200,
        headline: "Save $200 on your next 4 treatments",
      },
      channels: STANDARD_CHANNELS,
      bookingLinkTemplate: "",
      velocityCapDays: 21,
      quietHours: { ...STANDARD_QUIET },
      starts: null,
      ends: null,
      state: "draft",
    },
  },
  {
    kind: "anniversary",
    title: "Patient anniversary",
    description:
      "Patients whose first visit was on this calendar month — celebrate the relationship.",
    exampleCopy:
      "Happy anniversary, {first_name}! It's been {years} since your first visit. Here's $50 toward your next.",
    defaults: {
      templateKind: "anniversary",
      cohortQuery: {
        anniversaryMonth: true,
        requireReachable: true,
      },
      offer: {
        flatAmountUsd: 50,
        headline: "$50 off your anniversary visit",
      },
      channels: STANDARD_CHANNELS,
      bookingLinkTemplate: "",
      velocityCapDays: 30,
      quietHours: { ...STANDARD_QUIET },
      starts: null,
      ends: null,
      state: "draft",
    },
  },
  {
    kind: "loyalty",
    title: "Loyalty redemption nudge",
    description:
      "Patients with strong loyalty engagement — remind them to come back and redeem.",
    exampleCopy:
      "{first_name}, you've earned Alle rewards on your last 5 visits — book your next visit and redeem.",
    defaults: {
      templateKind: "loyalty",
      cohortQuery: {
        hasPurchasedKind: "toxin",
        minTotalVisits: 4,
        minDaysSinceLastVisit: 90,
        requireReachable: true,
      },
      offer: {
        headline: "Redeem your rewards on your next visit",
      },
      channels: STANDARD_CHANNELS,
      bookingLinkTemplate: "",
      velocityCapDays: 21,
      quietHours: { ...STANDARD_QUIET },
      starts: null,
      ends: null,
      state: "draft",
    },
  },
  {
    kind: "birthday",
    title: "Birthday treat",
    description:
      "Patients whose birthday is this month. Requires a birthday data feed (not in QuickBooks export — deferred).",
    exampleCopy:
      "Happy birthday, {first_name}! Treat yourself — 25% off any service this month.",
    defaults: {
      templateKind: "birthday",
      cohortQuery: {
        requireReachable: true,
      },
      offer: {
        discountPct: 25,
        headline: "25% off any service this month",
      },
      channels: STANDARD_CHANNELS,
      bookingLinkTemplate: "",
      velocityCapDays: 30,
      quietHours: { ...STANDARD_QUIET },
      starts: null,
      ends: null,
      state: "draft",
    },
  },
  {
    kind: "custom",
    title: "Start from scratch",
    description:
      "Build a custom cohort query and offer when none of the templates fit.",
    exampleCopy:
      "Define your own audience and message. The cohort editor lets you stack filters by service, recency, spend, and brand.",
    defaults: {
      templateKind: "custom",
      cohortQuery: {
        requireReachable: true,
      },
      offer: {
        headline: "",
      },
      channels: STANDARD_CHANNELS,
      bookingLinkTemplate: "",
      velocityCapDays: 7,
      quietHours: { ...STANDARD_QUIET },
      starts: null,
      ends: null,
      state: "draft",
    },
  },
];

/** Get a template definition by kind. */
export function getTemplate(kind: TemplateKind): CampaignTemplateDef | null {
  return CAMPAIGN_TEMPLATES.find((t) => t.kind === kind) ?? null;
}
