/**
 * Refill feature-flag catalog — the curated list of what Refill supports
 * gating.
 *
 * Pre-v1.24.1 the admin /app/admin/flags page was row-driven: it showed
 * whatever was in public.feature_flags and let admin create raw rows by
 * typing a flag_key + scope_id UUID + JSON metadata. That's the wrong
 * shape — operator doesn't know what flag_keys are valid, and the JSON
 * metadata is opaque. Per [[feedback-human-first-design]]: computers
 * must think like humans, never the reverse.
 *
 * v1.24.1: the page reads from THIS catalog as the source of what
 * features exist. Each catalog entry has a human-readable label +
 * description + default state. The feature_flags table holds OVERRIDES
 * to that default — global override (admin says "turn off for everyone"),
 * tenant override (admin says "turn off for Rejuv"), etc.
 *
 * To add a new flag: add an entry here + the consumer code that reads
 * `isFeatureEnabled('your_key', { tenantId? })` (TODO: read API not yet
 * shipped — will land alongside the first consumer that needs it).
 */

export type FeatureFlagDefinition = {
  /** Stable machine key — matches the flag_key column in feature_flags. */
  key: string;
  /** Human-readable display name. */
  label: string;
  /** What this flag controls, in operator language. */
  description: string;
  /** Default state when no row in feature_flags overrides it. */
  defaultEnabled: boolean;
  /** What "ON" means — surfaced under the toggle to clarify direction. */
  onMeaning: string;
  /** What "OFF" means. */
  offMeaning: string;
};

export const FLAG_CATALOG: FeatureFlagDefinition[] = [
  {
    key: "preshow_enabled",
    label: "Preshow agent",
    description:
      "Sends T-48h, T-24h, T-3h reminders before each appointment to prevent cancellations. The first of Refill's three agents (prevention → recovery → attribution).",
    defaultEnabled: true,
    onMeaning: "Preshow reminders fire automatically for upcoming appointments.",
    offMeaning: "No preshow reminders. Rescue still runs when cancellations happen.",
  },
  {
    key: "rescue_enabled",
    label: "Rescue agent",
    description:
      "When an appointment cancels or no-shows, fan-out an offer to the highest-probability waitlist patient. First tap wins.",
    defaultEnabled: true,
    onMeaning: "Cancellations trigger rescue offers automatically.",
    offMeaning: "Cancellations are observed but no rescue offers are sent.",
  },
  {
    key: "attribution_enabled",
    label: "Recovery attribution",
    description:
      "When a waitlist patient claims a freed slot, log the [VERIFIED] recovered-revenue row that drives the % pricing math.",
    defaultEnabled: true,
    onMeaning: "Recovered revenue is captured + counted toward the spa's invoice.",
    offMeaning: "Recoveries happen but no revenue lines are written. Invoices skip these.",
  },
  {
    key: "deposit_required",
    label: "Booking deposit",
    description:
      "Charge a small deposit at booking that's refunded on showup. The deposit-charging incumbent pattern — Refill's preshow agent is designed to make this unnecessary, hence default OFF.",
    defaultEnabled: false,
    onMeaning: "New bookings require a deposit on file.",
    offMeaning: "No deposit required. The preshow + grace-credit policy handles no-shows.",
  },
  {
    key: "outreach_live",
    label: "Outreach campaigns",
    description:
      "Auto-send templated marketing / winback emails on a cadence. Paused platform-wide today; flip ON per-tenant when ready.",
    defaultEnabled: false,
    onMeaning: "Outreach cron fires templated emails per the spa's cadence.",
    offMeaning: "Outreach templates exist but cron does not send.",
  },
  {
    key: "demo_mode",
    label: "Demo mode",
    description:
      "Surfaces a banner + uses synthetic seed data for screenshots / sales demos / pilots not yet on real data.",
    defaultEnabled: false,
    onMeaning: "Demo banner visible; synthetic data substitutes for real reads.",
    offMeaning: "Real customer data only.",
  },
  {
    key: "light_mode_enabled",
    label: "Lite Mode (email-forward connector)",
    description:
      "When ON for a tenant, the spa's scheduler settings page surfaces a 'Connect Lite Mode' option on each gated platform card (Boulevard / Mindbody / Booker / Jane / Zenoti). The spa forwards their platform's notification emails to a per-spa Refill inbound address; Refill parses cancellation + booking events without touching the vendor's API. Default OFF because most spas should start on full API mode where possible.",
    defaultEnabled: false,
    onMeaning:
      "Spa sees Lite Mode toggle on gated-platform cards + can enroll in 60 seconds.",
    offMeaning: "Lite Mode hidden; spa uses API mode only.",
  },
  {
    key: "plaid_mode_enabled",
    label: "Plaid Mode (browser-automation connector, Pro)",
    description:
      "When ON for a tenant, the spa's scheduler settings page surfaces a 'Plaid Connect (Pro)' option on each gated platform card. The connector uses the spa owner's portal login under explicit click-through consent (Plaid-style credential-mediated access). Vendor ToS-gray; reserved for design partners + concierge onboarding. See Refill-PlaidMode-BackPocket-v1.html. Default OFF — admin flips ON per spa.",
    defaultEnabled: false,
    onMeaning:
      "Spa sees Plaid Mode (Pro) toggle on gated-platform cards + can opt in via consent gate.",
    offMeaning: "Plaid Mode hidden from this spa entirely.",
  },
];

export function findFlagInCatalog(key: string): FeatureFlagDefinition | undefined {
  return FLAG_CATALOG.find((f) => f.key === key);
}
