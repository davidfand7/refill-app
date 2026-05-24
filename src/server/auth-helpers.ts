/**
 * Shared auth helpers for TanStack server functions.
 *
 * v267: extracted from 6 server-fn files (connected-agents, knowledge-base,
 * liz-accounts, liz-chat, repos, spa-claim) that each carried a verbatim copy
 * of `verifyAuth(accessToken)`. Auth is a security boundary; one bug fix
 * should land in one place. Centralizing also catches the Zod input shape
 * (`{ accessToken: string }`) so every authed server fn shares the same
 * validation surface.
 *
 * Auth pattern (per `project_tanstack_serverfn_auth` memory): explicit
 * accessToken in payload, NOT requireSupabaseAuth middleware (which silently
 * swallows in this codebase). Caller validates input with `accessTokenInput`,
 * passes `data.accessToken` to `verifyAuth`, gets back the auth.users.id.
 */

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

/**
 * Minimum input shape for any authed server fn. Compose into your fn's full
 * input schema with `.merge(...)` or by extending the object.
 */
export const accessTokenInput = z.object({
  accessToken: z.string().min(1),
});

/**
 * Verify a Supabase access token and return the auth.users.id (the JWT `sub`
 * claim). Throws with a user-facing error message on invalid / expired tokens
 * — the message is shown verbatim in the UI when a server fn rejects, so
 * "please sign out and back in" is the right call for mid-session token
 * expiry (the most common failure mode).
 *
 * Uses the publishable key (anon key with auth header) to verify rather than
 * service-role — service-role would bypass RLS and trust any token blindly.
 */
export async function verifyAuth(accessToken: string): Promise<string> {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.");
  }
  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
  const { data: claimsResp, error: claimsErr } =
    await supabase.auth.getClaims(accessToken);
  if (claimsErr || !claimsResp?.claims?.sub) {
    throw new Error(
      `Invalid session — please sign out and back in. (${claimsErr?.message ?? "no claims"})`,
    );
  }
  return claimsResp.claims.sub;
}

/**
 * Role-aware gate for the Refill Rep Platform. Returns the verified userId
 * plus identity flags for the two principals who can act in the outreach
 * system: admins (any user_roles.role='admin') and active reps (any active
 * rep_accounts row). When the caller is a rep, repDisplayName is populated
 * so the send pipeline can override the From: line.
 *
 * Callers pass an admin client (service-role) — the role + rep lookups need
 * to bypass RLS to be authoritative.
 */
export async function requireRepOrAdmin(
  sb: SupabaseAdminClient,
  accessToken: string,
): Promise<RepOrAdmin> {
  const userId = await verifyAuth(accessToken);

  const [roleRes, repRes] = await Promise.all([
    sb
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle(),
    sb
      .from("rep_accounts")
      .select("rep_user_id, display_name, status")
      .eq("rep_user_id", userId)
      .maybeSingle(),
  ]);

  if (roleRes.error) {
    throw new Error(`Couldn't verify admin role: ${roleRes.error.message}`);
  }
  if (repRes.error) {
    throw new Error(`Couldn't verify rep account: ${repRes.error.message}`);
  }

  const isAdmin = !!roleRes.data;
  const isRep = !!repRes.data && repRes.data.status === "active";

  if (!isAdmin && !isRep) {
    throw new Error(
      "Rep or admin role required — visit /app/rep/referral-links to set up your rep profile.",
    );
  }

  return {
    userId,
    isAdmin,
    isRep,
    repDisplayName: isRep ? (repRes.data?.display_name ?? null) : null,
  };
}

export type RepOrAdmin = {
  userId: string;
  isAdmin: boolean;
  isRep: boolean;
  repDisplayName: string | null;
};

type SupabaseAdminClient = ReturnType<typeof createClient<Database>>;
