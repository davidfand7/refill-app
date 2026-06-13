/**
 * Skill catalog — the curated menu of SmartSpa Skills (v2.19.0, Phase 1).
 *
 * The Skill funnel's TYPE LAYER. Like FLAG_CATALOG in feature-flag-catalog.ts,
 * the built-in templates live here IN CODE; the `skills` / `skill_proposals`
 * tables hold the per-tenant instances. Every owned Skill is an instance of a
 * template, no matter who triggered it (catalog browse, mined proposal, or
 * concierge authoring). Phase 3 will add a DB table for custom/concierge
 * templates — the way feature_flags rows override the code catalog.
 *
 * Honesty bar (project_quality_as_differentiator): a Skill she can adopt must
 * actually DO something. Phase 1 wires exactly ONE template end-to-end
 * (pre_visit_reminder → the real Reminders/preshow engine). The rest of the
 * menu is shown as `preview` ("coming soon") — visible so she sees the breadth,
 * but not adoptable until wired. A Skill that does nothing is the exact
 * dishonesty the moat is built against.
 *
 * The MATERIALIZER axis maps onto the autonomy ladder (project_trusted_onboarding):
 *   flip       (Tier 0) — turn on an existing knob
 *   routine    (Tier 1) — a named, owned, manageable routine   ← Phase 1 ships here
 *   autonomous (Tier 2) — an authored .claude skill the agent runs (gated, later)
 */

export type SkillSolution =
  | "refill" // no-show recovery (reminders + rescue)
  | "promos" // recognition / rewards / recall / cross-sell
  | "calendar" // scheduling
  | "patients" // the patient book
  | "account" // back-office
  | "cross"; // spans solutions

export type SkillMaterializer = "flip" | "routine" | "autonomous";

/** `live` = wired end-to-end + adoptable. `preview` = on the menu, not yet wired. */
export type SkillStatus = "live" | "preview";

export type SkillTemplate = {
  /** Stable machine key — matches skills.template_key / skill_proposals.template_key. */
  key: string;
  /** Human-readable name (becomes the owned Skill's default name). */
  label: string;
  /** What it does, in the owner's language. */
  description: string;
  /** Which Solution it lives under (for grouping / the badge). */
  solution: SkillSolution;
  /** What "yes" produces — the autonomy tier. */
  materializer: SkillMaterializer;
  /** live = adoptable now; preview = shown but disabled. */
  status: SkillStatus;
  /** One-line "what happens when you add this" copy for the card. */
  adoptCopy: string;
  /** Conservative, honest hint at the upside (no fabricated dollars). */
  liftHint: string;
  /**
   * For `live` routines that materialize a real engine artifact: the in-app
   * route where she manages it. Phase 1's wired template deep-links here.
   */
  manageTo?: string;
};

export const SKILL_CATALOG: SkillTemplate[] = [
  // ── LIVE (wired end-to-end in Phase 1) ──────────────────────────────────
  {
    key: "pre_visit_reminder",
    label: "Pre-Visit Reminders",
    description:
      "Automatically remind patients before their appointment (e.g. 48h, 24h, 3h out) so fewer of them forget and no-show. Adopting this sets up your default reminder cadence — you tune the timing, tone, and wording in Reminders.",
    solution: "refill",
    materializer: "routine",
    status: "live",
    adoptCopy:
      "Sets up your reminder cadence as a routine you own — then opens Reminders so you can fine-tune it.",
    liftHint: "Fewer forgotten appointments → fewer no-shows.",
    manageTo: "/app/refill/recovery/preshow",
  },

  // ── PREVIEW (on the menu, wiring queued) ────────────────────────────────
  {
    key: "auto_recall",
    label: "Auto-Recall Lapsed Patients",
    description:
      "Reach out to patients who are due back — on a cadence or as their manufacturer reward nears expiry — and invite them to rebook.",
    solution: "promos",
    materializer: "routine",
    status: "preview",
    adoptCopy: "Will quietly surface who's due back and tee up the outreach.",
    liftHint: "Brings lapsed patients back before they drift.",
  },
  {
    key: "waitlist_auto_fill",
    label: "Waitlist Auto-Fill",
    description:
      "When an appointment cancels, offer the freed slot to the best-fit waitlist patient — low-confidence fits are held for your one-tap OK.",
    solution: "refill",
    materializer: "routine",
    status: "preview",
    adoptCopy: "Will fill canceled slots from your waitlist, holding the unsure ones for you.",
    liftHint: "Turns a cancellation into a kept slot.",
  },
  {
    key: "weekly_offer",
    label: "Weekly Offer (e.g. Tox Tuesday)",
    description:
      "Run a recurring offer and show an at-booking add-on badge for it — without re-creating it every week.",
    solution: "promos",
    materializer: "routine",
    status: "preview",
    adoptCopy: "Will keep your recurring offer live and badged at booking.",
    liftHint: "A standing reason to add on, every week.",
  },
  {
    key: "reward_expiry_sweep",
    label: "Reward-Expiry Sweep",
    description:
      "Surface patients whose manufacturer reward expires soon so you can recall them while it still counts.",
    solution: "promos",
    materializer: "routine",
    status: "preview",
    adoptCopy: "Will flag soon-to-expire rewards in time to act.",
    liftHint: "Captures rewards before they lapse.",
  },
  {
    key: "no_show_followup",
    label: "No-Show Follow-Up",
    description:
      "Re-engage a patient who no-showed with a warm nudge to rebook, instead of letting them slip away.",
    solution: "refill",
    materializer: "routine",
    status: "preview",
    adoptCopy: "Will follow up after a no-show to win the rebook.",
    liftHint: "Recovers visits a no-show would have lost.",
  },
  {
    key: "auto_verify_recoveries",
    label: "Auto-Verify Recoveries",
    description:
      "Stop confirming recovered-revenue wins by hand — reconcile them automatically against your books (QuickBooks / Stripe / Square).",
    solution: "account",
    materializer: "flip",
    status: "preview",
    adoptCopy: "Will reconcile your wins automatically instead of by hand.",
    liftHint: "Saves the weekly manual-confirm chore.",
  },
  {
    key: "monthly_patient_book_export",
    label: "Monthly Patient-Book Export",
    description:
      "Get your full patient book exported on a schedule for your bookkeeping — no manual download each month.",
    solution: "account",
    materializer: "autonomous",
    status: "preview",
    adoptCopy: "Will deliver your patient-book export on a schedule.",
    liftHint: "Your books, ready without the monthly chore.",
  },
];

export function findSkillInCatalog(key: string): SkillTemplate | undefined {
  return SKILL_CATALOG.find((t) => t.key === key);
}

/** Operator-facing label for the Solution badge. */
export function skillSolutionLabel(solution: SkillSolution): string {
  switch (solution) {
    case "refill":
      return "Refill";
    case "promos":
      return "Promos";
    case "calendar":
      return "Calendar";
    case "patients":
      return "Patients";
    case "account":
      return "Account";
    case "cross":
      return "Cross-solution";
  }
}
