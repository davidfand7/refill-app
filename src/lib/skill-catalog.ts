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
 *   surface    (Tier 1) — turns on an in-app, glanceable indicator (a badge)
 *   autonomous (Tier 2) — an authored .claude skill the agent runs (gated, later)
 */

export type SkillSolution =
  | "refill" // no-show recovery (reminders + rescue)
  | "promos" // recognition / rewards / recall / cross-sell
  | "calendar" // scheduling
  | "patients" // the patient book
  | "account" // back-office
  | "cross"; // spans solutions

export type SkillMaterializer = "flip" | "routine" | "autonomous" | "surface";

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
    label: "Weekly Recall Digest",
    description:
      "Once a week, SmartSpa tallies who's due back — expiring manufacturer rewards and lapsed regulars — and emails you a heads-up: the dollars on the table and how many patients. You open Recall and send the outreach in one tap. The digest never messages a patient on its own.",
    solution: "promos",
    materializer: "routine",
    status: "live",
    adoptCopy:
      "Turns on a weekly digest of who's due back and the dollars on the table — then opens Recall. You always do the sending.",
    liftHint: "Catches lapsed patients and expiring rewards before they drift.",
    manageTo: "/app/refill/recognition/recall",
  },
  {
    key: "waitlist_auto_fill",
    label: "Waitlist Auto-Fill",
    description:
      "When an appointment cancels, offer the freed slot to the best-fit waitlist patient — low-confidence fits are held for your one-tap OK. Adopting this turns on your Rescue routine; fine-tune the eligible treatments and limits in Rescue.",
    solution: "refill",
    materializer: "routine",
    status: "live",
    adoptCopy:
      "Turns on rescue so canceled slots get filled from your waitlist — then opens Rescue so you can set the rules.",
    liftHint: "Turns a cancellation into a kept slot.",
    manageTo: "/app/refill/recovery/rescue",
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
      "Keep a running, at-a-glance count of manufacturer rewards expiring soon, pinned right on your Recall tab — so the money about to evaporate is always in view, not just in the Monday digest. No extra email; it's an ambient badge you can act on any time.",
    solution: "promos",
    materializer: "surface",
    status: "live",
    adoptCopy:
      "Pins a live “expiring soon” badge on your Recall tab so the at-risk reward dollars are always one glance away.",
    liftHint: "Keeps evaporating reward money in view, all week.",
    manageTo: "/app/refill/recognition/recall",
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
      "Stop confirming recovered-revenue wins by hand. SmartSpa reconciles each win against your books — matching the patient's transaction inside your verification window — and confirms it automatically. Pause it any time to go back to confirming by hand. You set the window and the auto-confirm threshold under Attribution.",
    solution: "account",
    materializer: "flip",
    status: "live",
    adoptCopy:
      "Keeps auto-reconciliation on, so wins verify themselves against your books — then opens Attribution to tune the window and threshold. Pause any time to confirm by hand.",
    liftHint: "Saves the weekly manual-confirm chore.",
    manageTo: "/app/billing/attribution",
  },
  {
    key: "autonomous_rescue",
    label: "Autonomous Rescue",
    description:
      "Let SmartSpa text confident waitlist matches the moment a slot frees — on its own, no tap from you. Uncertain matches still wait for your OK.",
    solution: "refill",
    materializer: "autonomous",
    status: "live",
    manageTo: "/app/refill/recovery/rescue",
    adoptCopy:
      "Will auto-send the confident rescue offers; still holds the uncertain ones for you.",
    liftHint: "Slots fill faster — the agent acts the instant one opens.",
  },
  {
    key: "monthly_patient_book_export",
    label: "Monthly Patient-Book Export",
    description:
      "Once a month, SmartSpa emails you a CSV of your full patient book for bookkeeping — no manual download each month. It goes to you only; nothing is sent to a patient. You can pull a fresh full export (with appointments and waitlist) any time from your account page.",
    solution: "account",
    materializer: "routine",
    status: "live",
    adoptCopy:
      "Turns on a monthly patient-book export emailed straight to you — then opens your account page where you can pull a full export any time.",
    liftHint: "Your books, ready without the monthly chore.",
    manageTo: "/app/refill/settings/account",
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
