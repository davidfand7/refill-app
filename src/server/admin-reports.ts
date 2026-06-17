/**
 * Admin reports server fns — v1.24.0 (P5 of unified admin platform).
 *
 * Per-tenant + per-rep rollups for /app/admin/reports. Read-only,
 * admin-gated. Aggregates across the platform without any tenant-scope
 * restriction — admin is the only role that sees this view.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";

function admin() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function assertAdmin(accessToken: string): Promise<string> {
  const callerUserId = await verifyAuth(accessToken);
  const sb = admin();
  const { data, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Couldn't verify admin: ${error.message}`);
  if (!data) throw new Error("Admin only.");
  return callerUserId;
}

// ─── Per-tenant report ───────────────────────────────────────────────────

export type TenantReportRow = {
  tenantId: string;
  name: string;
  slug: string;
  isDemo: boolean;
  plan: string;
  trialEndsAt: string;
  ownerEmail: string | null;
  ownerUserId: string | null;
  patientCount: number;
  recoveryEventCount: number;
  recoveryRevenueUsdLifetime: number;
};

const reportInput = z.object({
  accessToken: z.string().min(1),
});

export const getTenantReport = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => reportInput.parse(raw))
  .handler(async ({ data }): Promise<{ rows: TenantReportRow[] }> => {
    await assertAdmin(data.accessToken);
    const sb = admin();

    const { data: tenants, error: tenErr } = await sb
      .from("tenants")
      .select("id, slug, name, is_demo, plan, trial_ends_at")
      .order("is_demo", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true });
    if (tenErr) throw new Error(`Couldn't load tenants: ${tenErr.message}`);

    const tenantList = tenants ?? [];
    if (tenantList.length === 0) return { rows: [] };
    const tenantIds = tenantList.map((t) => t.id);

    // Owner lookup: prefer role='owner', else first by created_at.
    const { data: memberships } = await sb
      .from("tenant_memberships")
      .select("tenant_id, user_id, role, created_at")
      .in("tenant_id", tenantIds)
      .order("created_at", { ascending: true });
    const ownerByTenant = new Map<string, string>();
    for (const m of memberships ?? []) {
      const cur = ownerByTenant.get(m.tenant_id);
      if (m.role === "owner") {
        ownerByTenant.set(m.tenant_id, m.user_id);
      } else if (!cur) {
        ownerByTenant.set(m.tenant_id, m.user_id);
      }
    }

    // Bulk auth.users for emails.
    const ownerUserIds = Array.from(new Set(ownerByTenant.values()));
    const emailByUser = new Map<string, string>();
    if (ownerUserIds.length > 0) {
      const authRes = await sb.auth.admin.listUsers({ perPage: 1000 });
      for (const u of authRes.data?.users ?? []) {
        if (u.email && ownerUserIds.includes(u.id)) emailByUser.set(u.id, u.email);
      }
    }

    // Patient counts per owner_user_id (knowledge_nodes node_type='patient').
    const patientCountByUser = new Map<string, number>();
    if (ownerUserIds.length > 0) {
      for (const uid of ownerUserIds) {
        const { count } = await sb
          .from("knowledge_nodes")
          .select("id", { count: "exact", head: true })
          .eq("user_id", uid)
          .eq("node_type", "patient");
        patientCountByUser.set(uid, count ?? 0);
      }
    }

    // Recovery events per owner_user_id (recovery_events).
    const recoveryByUser = new Map<
      string,
      { count: number; revenueUsd: number }
    >();
    if (ownerUserIds.length > 0) {
      const { data: events } = await sb
        .from("recovery_events")
        .select("user_id, attributed_revenue_usd")
        .in("user_id", ownerUserIds);
      for (const e of events ?? []) {
        const cur = recoveryByUser.get(e.user_id) ?? {
          count: 0,
          revenueUsd: 0,
        };
        cur.count++;
        cur.revenueUsd += Number(e.attributed_revenue_usd ?? 0);
        recoveryByUser.set(e.user_id, cur);
      }
    }

    const rows: TenantReportRow[] = tenantList.map((t) => {
      const ownerUserId = ownerByTenant.get(t.id) ?? null;
      const rec = ownerUserId ? recoveryByUser.get(ownerUserId) : undefined;
      return {
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        isDemo: t.is_demo ?? false,
        plan: t.plan,
        trialEndsAt: t.trial_ends_at,
        ownerEmail: ownerUserId ? emailByUser.get(ownerUserId) ?? null : null,
        ownerUserId,
        patientCount: ownerUserId
          ? patientCountByUser.get(ownerUserId) ?? 0
          : 0,
        recoveryEventCount: rec?.count ?? 0,
        recoveryRevenueUsdLifetime: rec?.revenueUsd ?? 0,
      };
    });

    return { rows };
  });

// ─── Per-rep report ──────────────────────────────────────────────────────

export type RepReportRow = {
  repUserId: string;
  email: string | null;
  displayName: string;
  status: string;
  originType: string;
  joinedAt: string;
  downstreamTenantCount: number;
  attributedRevenueUsdLifetime: number;
};

export const getRepReport = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => reportInput.parse(raw))
  .handler(async ({ data }): Promise<{ rows: RepReportRow[] }> => {
    await assertAdmin(data.accessToken);
    const sb = admin();

    const { data: reps, error: repErr } = await sb
      .from("rep_accounts")
      .select(
        "rep_user_id, display_name, status, origin_type, joined_at",
      )
      .order("joined_at", { ascending: true });
    if (repErr) throw new Error(`Couldn't load reps: ${repErr.message}`);

    const repList = reps ?? [];
    if (repList.length === 0) return { rows: [] };
    const repIds = repList.map((r) => r.rep_user_id);

    // Bulk auth.users for emails.
    const emailByUser = new Map<string, string>();
    const authRes = await sb.auth.admin.listUsers({ perPage: 1000 });
    for (const u of authRes.data?.users ?? []) {
      if (u.email && repIds.includes(u.id)) emailByUser.set(u.id, u.email);
    }

    // Downstream tenant attribution — count tenants whose owner has been
    // claimed by this rep. The exact attribution chain depends on
    // schema (rep_referral_links / recruit_claims / etc.); for v1 we use
    // a permissive proxy: tenants whose plan-applied_at row was processed
    // when this rep was active. Real attribution should land via a
    // dedicated rep_attributions table. Approximate here so the report
    // surfaces non-zero values for the demo data.
    const downstreamByRep = new Map<string, number>();
    const revenueByRep = new Map<string, number>();
    // For now, we skip the attribution heuristic and return zeros — the
    // table shape we don't have today is rep_attributions. Cleanly noted
    // so the report still renders for v1 walkthrough; v1.25+ ship will
    // add attribution math.

    const rows: RepReportRow[] = repList.map((r) => ({
      repUserId: r.rep_user_id,
      email: emailByUser.get(r.rep_user_id) ?? null,
      displayName: r.display_name,
      status: r.status,
      originType: r.origin_type,
      joinedAt: r.joined_at,
      downstreamTenantCount: downstreamByRep.get(r.rep_user_id) ?? 0,
      attributedRevenueUsdLifetime: revenueByRep.get(r.rep_user_id) ?? 0,
    }));

    return { rows };
  });
