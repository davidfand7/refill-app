/**
 * Stripe mode detection + mode-aware tenant customer-id helpers.
 *
 * Stripe runs two disjoint universes (test mode + live mode). Customer ids
 * minted in one are invisible to the other — reusing a test cus_xxx under a
 * live key throws "No such customer". v391.2 split tenants.stripe_customer_id
 * into two columns; this module is the single source of truth for which one
 * to read / write at request time.
 *
 * Mode is derived from the STRIPE_SECRET_KEY prefix. Stripe guarantees the
 * `sk_test_` prefix for test keys (and `rk_test_` for restricted test keys);
 * anything else is treated as live. Restricted keys (`rk_*`) follow the same
 * prefix convention.
 *
 * Why a prefix check instead of asking Stripe at runtime: it's one string op
 * with zero network cost, deterministic, and survives if Stripe's API is
 * briefly down. The only failure mode is malformed keys, which we'd notice
 * immediately because no Stripe call would work.
 */

export type StripeMode = "test" | "live";

/**
 * Detect Stripe mode from the secret key currently in use. Defaults to "live"
 * if the prefix doesn't unambiguously indicate test mode — fail-closed so
 * misconfiguration shows up as "test data hitting live mode" (loud, obvious),
 * not "live data hitting test mode" (silent, dangerous).
 */
export function detectStripeMode(secretKey: string | undefined): StripeMode {
  if (!secretKey) return "live";
  return secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")
    ? "test"
    : "live";
}

/**
 * The tenants column to read or write for a given mode. Use this everywhere
 * customer-id lives in DB land so the column name is never hard-coded at
 * call sites (otherwise we drift away from the schema again).
 */
export function tenantStripeCustomerColumn(
  mode: StripeMode,
): "stripe_customer_id_test" | "stripe_customer_id_live" {
  return mode === "test" ? "stripe_customer_id_test" : "stripe_customer_id_live";
}

/**
 * Helper for the API routes: pulls the customer id off a tenant row for the
 * mode currently in effect. Accepts a partial row so callers can `.select`
 * exactly what they need without redundant typing.
 */
export function readTenantStripeCustomerId(
  tenant: {
    stripe_customer_id_test?: string | null;
    stripe_customer_id_live?: string | null;
  },
  mode: StripeMode,
): string | null {
  return mode === "test"
    ? tenant.stripe_customer_id_test ?? null
    : tenant.stripe_customer_id_live ?? null;
}
