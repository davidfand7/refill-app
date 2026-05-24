/**
 * demo-user.ts — server-side helper for the "View as demo" / Showcase mode.
 *
 * The platform never logs in as the demo tenant. When a real authed rep
 * sets `viewAs: "demo"` on a read call, server fns resolve the demo user's
 * UUID via this helper and re-scope queries to that user. The rep's
 * accessToken still proves authentication (so the demo data isn't reachable
 * by anonymous traffic); we just pivot the data-target.
 *
 * Why this pattern (vs handing the client a demo accessToken):
 *   - We never want a token usable for writes against the demo tenant.
 *     Service-side rerouting keeps reads safe and writes impossible.
 *   - The rep's session stays intact; flipping the toggle off returns them
 *     to their own data with zero auth churn.
 *
 * The demo user's UUID is looked up by a fixed email constant once per
 * Worker invocation and cached in-process — a tiny perf optimization but
 * also a structural guard against accidentally pointing at the wrong row.
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const DEMO_EMAIL = "demo@agentiport.com";

export type ViewAs = "demo" | undefined;

let cachedDemoUserId: string | null = null;

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

/**
 * Resolve the demo tenant's user UUID, looking it up by email on first call
 * and caching for the lifetime of the Worker invocation.
 *
 * Throws a user-facing error if the demo user hasn't been provisioned —
 * `scripts/setup-demo-user.ts` is the canonical bootstrap path.
 */
export async function getDemoUserId(): Promise<string> {
  if (cachedDemoUserId) return cachedDemoUserId;
  const sb = admin();
  const { data: list, error } = await sb.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) {
    throw new Error(`Couldn't resolve demo tenant: ${error.message}`);
  }
  const u = list.users.find((x) => x.email?.toLowerCase() === DEMO_EMAIL);
  if (!u) {
    throw new Error(
      "Demo tenant isn't set up yet. Run scripts/setup-demo-user.ts to bootstrap it.",
    );
  }
  cachedDemoUserId = u.id;
  return u.id;
}

/**
 * Given a viewAs hint + the authed rep's userId, returns the effective
 * userId to scope read queries against. Writes ignore viewAs and always
 * stay scoped to the rep — call sites should check viewAs and refuse the
 * write themselves rather than relying on this helper.
 */
export async function resolveEffectiveUserId(
  repUserId: string,
  viewAs: ViewAs,
): Promise<string> {
  if (viewAs === "demo") return await getDemoUserId();
  return repUserId;
}
