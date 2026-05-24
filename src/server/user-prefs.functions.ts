/**
 * User-preferences server fns — primary_role read/write.
 *
 * Stage 1 of the vertical breakout (Option C subdomain shell — see
 * project_vertical_breakout_locked memory). primary_role drives shell +
 * sidebar selection: 'spa-owner' / 'rep' / 'developer' / null.
 *
 * Two surfaces:
 *   getMyPrimaryRole({ accessToken }) — AuthProvider calls this on session
 *     load to populate context.
 *   setMyPrimaryRole({ accessToken, role }) — manual override (future
 *     Settings UI; today only used by admin tooling).
 *
 * Plus an internal helper `setPrimaryRoleIfUnset(sb, userId, role)` used by
 * the auto-stamp hooks in claimSpa + ensureLizSession. "Unset" = no row OR
 * row with primary_role IS NULL — never overwrites an existing role (a rep
 * who later claims their own spa keeps 'rep' until they manually switch).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { accessTokenInput, verifyAuth } from "@/server/auth-helpers";
import type { Database } from "@/integrations/supabase/types";

export type PrimaryRole = "spa-owner" | "rep" | "developer";

const PRIMARY_ROLE_VALUES = ["spa-owner", "rep", "developer"] as const;

// Admin accounts never get auto-stamped — they routinely test claim flows
// + Liz chat as part of dogfooding, and stamping them would lose their
// full-platform sidebar. They can opt into a vertical role explicitly via
// setMyPrimaryRole if they want to preview that UX. Source-of-truth list
// lives in src/components/AppSidebar.tsx (ADMIN_EMAILS); duplicated here to
// avoid a client→server import. Keep them in sync.
const ADMIN_EMAILS_NEVER_AUTOSTAMP = new Set([
  "davidfand303@gmail.com",
  "admin@openagentic.app",
]);

function admin(): SupabaseClient<Database> {
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
 * Internal helper for auto-stamp hooks. Inserts a row if none exists; updates
 * primary_role only when the existing value is NULL. Existing non-NULL roles
 * are never silently overwritten.
 *
 * Errors are swallowed to console.warn rather than thrown — the auto-stamp
 * is a nice-to-have side effect of claim/first-message; we never want a
 * failed pref write to break the user-visible flow.
 */
export async function setPrimaryRoleIfUnset(
  sb: SupabaseClient<Database>,
  userId: string,
  role: PrimaryRole,
): Promise<void> {
  try {
    // Admin guard — dogfooders test claim/Liz flows routinely; auto-stamping
    // them would silently steal their full-platform sidebar. Look up the
    // email via the auth admin API; on lookup failure fall through (better
    // to stamp a real user than to silently skip everyone if auth.admin
    // breaks). Cheap — one round trip, only on the auto-stamp path.
    const { data: userResp } = await sb.auth.admin.getUserById(userId);
    const email = userResp?.user?.email?.toLowerCase();
    if (email && ADMIN_EMAILS_NEVER_AUTOSTAMP.has(email)) return;

    const { data: existing } = await sb
      .from("user_preferences")
      .select("primary_role")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing?.primary_role) return; // sticky — keep what's already there

    const nowIso = new Date().toISOString();
    if (existing) {
      await sb
        .from("user_preferences")
        .update({ primary_role: role, updated_at: nowIso })
        .eq("user_id", userId);
    } else {
      await sb
        .from("user_preferences")
        .insert({ user_id: userId, primary_role: role });
    }
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "set_primary_role_failed",
        userId,
        role,
        error: e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400),
        ts: new Date().toISOString(),
      }),
    );
  }
}

export const getMyPrimaryRole = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => accessTokenInput.parse(input))
  .handler(async ({ data }): Promise<{ primaryRole: PrimaryRole | null }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: row } = await sb
      .from("user_preferences")
      .select("primary_role")
      .eq("user_id", userId)
      .maybeSingle();

    const role = row?.primary_role;
    const valid = role && (PRIMARY_ROLE_VALUES as readonly string[]).includes(role)
      ? (role as PrimaryRole)
      : null;
    return { primaryRole: valid };
  });

const setRoleInput = accessTokenInput.extend({
  role: z.enum(PRIMARY_ROLE_VALUES),
});

export const setMyPrimaryRole = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => setRoleInput.parse(input))
  .handler(async ({ data }): Promise<{ primaryRole: PrimaryRole }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const nowIso = new Date().toISOString();

    const { error } = await sb
      .from("user_preferences")
      .upsert(
        { user_id: userId, primary_role: data.role, updated_at: nowIso },
        { onConflict: "user_id" },
      );

    if (error) {
      throw new Error(`Couldn't save your role: ${error.message}`);
    }
    return { primaryRole: data.role };
  });
