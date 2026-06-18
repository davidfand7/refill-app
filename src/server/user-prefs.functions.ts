/**
 * User-preferences server fns — primary_role + A-list rules read/write.
 *
 * Stage 1 of the vertical breakout (Option C subdomain shell — see
 * project_vertical_breakout_locked memory). primary_role drives shell +
 * sidebar selection: 'spa-owner' / 'rep' / 'developer' / null.
 *
 * v1.25.1 added a `prefs jsonb` column on user_preferences for arbitrary
 * per-user settings. First consumer: A-list automation rules (the spa-
 * owner-facing dashboard at /app/refill/patients/a-list-rules). Stored
 * under prefs.aListRules + prefs.aListLastAppliedAt.
 *
 * Surfaces:
 *   getMyPrimaryRole({ accessToken }) — AuthProvider calls on session load.
 *   setMyPrimaryRole({ accessToken, role }) — manual override.
 *   getMyAListRules({ accessToken, viewAsUserId? }) — load rules + last
 *     applied timestamp for the dashboard.
 *   saveAListRulesAndMarkApplied({ accessToken, viewAsUserId?, rules })
 *     — persist rules + stamp lastAppliedAt=now() after a successful Apply.
 *
 * Internal helper `setPrimaryRoleIfUnset(sb, userId, role)` powers the
 * auto-stamp hooks in claimSpa + ensureLizSession. "Unset" = no row OR row
 * with primary_role IS NULL — never overwrites an existing role.
 *
 * Tenant-impersonation note: the A-list fns use resolveEffectiveUserId so
 * an admin viewing-as Karen writes rules to KAREN's row, not the admin's.
 * The primary_role fns intentionally do NOT — they're for self-service
 * role selection and impersonation isn't meaningful there.
 */

import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin } from "./admin-client";
import { z } from "zod";
import {
  accessTokenInput,
  resolveEffectiveUserId,
  verifyAuth,
} from "@/server/auth-helpers";
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

// ─── A-list rules (v1.25.1) ────────────────────────────────────────────────

export type AListRules = {
  /** null = rule disabled. */
  lifetimeSpendMinUsd: number | null;
  lastVisitWithinDays: number | null;
  totalVisitsMin: number | null;
  excludeBanned: boolean;
  /** v1.25.4: exclude patients with any no-show or cancellation in the
   * rolling 6-month reliability window. */
  excludeUnreliable: boolean;
};

export const DEFAULT_A_LIST_RULES: AListRules = {
  lifetimeSpendMinUsd: 1000,
  lastVisitWithinDays: 365,
  totalVisitsMin: 3,
  excludeBanned: true,
  excludeUnreliable: true,
};

const aListRulesSchema = z.object({
  lifetimeSpendMinUsd: z.number().min(0).max(1_000_000).nullable(),
  lastVisitWithinDays: z.number().int().min(1).max(3650).nullable(),
  totalVisitsMin: z.number().int().min(1).max(1000).nullable(),
  excludeBanned: z.boolean(),
  excludeUnreliable: z.boolean(),
});

const aListReadInput = accessTokenInput.extend({
  viewAsUserId: z.string().uuid().optional(),
});

const aListSaveInput = accessTokenInput.extend({
  viewAsUserId: z.string().uuid().optional(),
  rules: aListRulesSchema,
});

export const getMyAListRules = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => aListReadInput.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ rules: AListRules; lastAppliedAt: string | null }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();
      const { data: row, error } = await sb
        .from("user_preferences")
        .select("prefs")
        .eq("user_id", effectiveUserId)
        .maybeSingle();
      if (error) {
        throw new Error(`Couldn't load A-list rules: ${error.message}`);
      }
      const prefs =
        (row?.prefs as {
          aListRules?: Partial<AListRules>;
          aListLastAppliedAt?: string;
        } | null) ?? null;
      // Spread DEFAULT first, then stored — missing keys (older saved
      // rules pre-dating new fields) inherit defaults; null values for
      // the nullable fields ARE preserved (null !== undefined).
      const rules: AListRules = {
        ...DEFAULT_A_LIST_RULES,
        ...(prefs?.aListRules ?? {}),
      };
      return {
        rules,
        lastAppliedAt: prefs?.aListLastAppliedAt ?? null,
      };
    },
  );

export const saveAListRulesAndMarkApplied = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => aListSaveInput.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ rules: AListRules; lastAppliedAt: string }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();

      // Read-merge-write so we don't clobber sibling pref keys (future
      // notification cadence, dashboard layout, etc.). user_preferences is
      // one row per user — the extra read is trivial.
      const { data: existing, error: readErr } = await sb
        .from("user_preferences")
        .select("prefs")
        .eq("user_id", effectiveUserId)
        .maybeSingle();
      if (readErr) {
        throw new Error(`Couldn't read prior prefs: ${readErr.message}`);
      }

      const nowIso = new Date().toISOString();
      const priorPrefs =
        (existing?.prefs as Record<string, unknown> | null) ?? {};
      const nextPrefs = {
        ...priorPrefs,
        aListRules: data.rules,
        aListLastAppliedAt: nowIso,
      };

      const { error: upsertErr } = await sb
        .from("user_preferences")
        .upsert(
          {
            user_id: effectiveUserId,
            prefs: nextPrefs,
            updated_at: nowIso,
          },
          { onConflict: "user_id" },
        );
      if (upsertErr) {
        throw new Error(`Couldn't save A-list rules: ${upsertErr.message}`);
      }

      return { rules: data.rules, lastAppliedAt: nowIso };
    },
  );
