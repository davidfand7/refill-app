/**
 * Refill tenants server fns (v387 / Phase 1.5).
 *
 * Three surfaces:
 *
 *   checkSlugAvailable — no-auth public lookup driving the Step 5 typeahead
 *     in /onboard. Returns { available, reason? } so the UI can render a
 *     concrete status (available / taken / reserved / invalid format).
 *     Format rules: 3–30 chars, lowercase a–z / 0–9 / hyphen, no leading
 *     or trailing hyphen. Reserved set already lives in
 *     src/lib/product-context.ts (isReservedSlug).
 *
 *   claimSlug — authed slug claim. Validates again server-side (UI rules
 *     are advisory; the DB is the boundary), ensures the user doesn't
 *     already own a tenant, inserts tenants + tenant_memberships in
 *     sequence, and surfaces unique-constraint races as { taken } rather
 *     than a 500. The race window between the typeahead's last check and
 *     the claim insert is real (~300ms typeahead debounce + click latency)
 *     so the post-error path matters.
 *
 *   getMyTenant — authed read for the wizard's Step 5 mount. If the user
 *     already has a tenant (e.g. they re-entered the wizard mid-flow from
 *     a different device), we render a "you already have a spa" state
 *     instead of letting them claim a second one. Returns the full tenant
 *     row so the UI can deep-link to <slug>.getrefill.app.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";
import { validateReferralToken } from "@/server/referral-tokens";

// ─── reserved slugs ──────────────────────────────────────────────────────
// Cleave fix 2026-05-24: inlined from src/lib/product-context.ts which is
// deleted (single-product worker). Only consumer is the slug-claim flow
// below; not worth a separate module.
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "blog",
  "dashboard",
  "docs",
  "help",
  "login",
  "m",
  "mail",
  "mobile",
  "scan",
  "signup",
  "status",
  "www",
]);

function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

// ─── service-role admin client (module-private) ──────────────────────────

type SbClient = ReturnType<typeof createClient<Database>>;

function admin(): SbClient {
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

// ─── slug format ─────────────────────────────────────────────────────────

const SLUG_MIN = 3;
const SLUG_MAX = 30;
const SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/;

export type SlugUnavailableReason = "invalid" | "reserved" | "taken";

function validateSlugFormat(raw: string): { ok: true; slug: string } | { ok: false } {
  const slug = raw.trim().toLowerCase();
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) return { ok: false };
  if (!SLUG_FORMAT.test(slug)) return { ok: false };
  return { ok: true, slug };
}

// ─── checkSlugAvailable ──────────────────────────────────────────────────

const checkInput = z.object({
  slug: z.string().min(1).max(80),
});

export type CheckSlugResult =
  | { available: true; slug: string }
  | { available: false; reason: SlugUnavailableReason };

export const checkSlugAvailable = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => checkInput.parse(raw))
  .handler(async ({ data }): Promise<CheckSlugResult> => {
    const parsed = validateSlugFormat(data.slug);
    if (!parsed.ok) return { available: false, reason: "invalid" };
    if (isReservedSlug(parsed.slug)) {
      return { available: false, reason: "reserved" };
    }
    const sb = admin();
    const { data: existing, error } = await sb
      .from("tenants")
      .select("id")
      .eq("slug", parsed.slug)
      .maybeSingle();
    if (error) {
      throw new Error(`Couldn't check availability: ${error.message}`);
    }
    if (existing) return { available: false, reason: "taken" };
    return { available: true, slug: parsed.slug };
  });

// ─── claimSlug ───────────────────────────────────────────────────────────

const claimInput = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  accessToken: z.string().min(1),
  // Optional referral token captured from ?ref=<token> on /onboard.
  // Validated server-side; silently ignored if invalid or the rep is missing.
  refToken: z.string().min(1).max(500).optional(),
  // v415.1: delivery channel choice from Step 4. Stashed in sessionStorage
  // during Step 4 (since the tenant doesn't exist yet), read + passed here
  // by Step 5's claim handler. Defaults to 'proxy' if absent (trial-first
  // default per [[project_trial_first_no_money_asks]]). 'direct' is
  // displayed-but-disabled in the v415.1 wizard; this enum accepts it
  // anyway so the field can be set via /app/refill/settings post-trial
  // without a schema change.
  deliveryChannel: z.enum(["proxy", "direct"]).optional(),
});

export type ClaimSlugResult =
  | {
      ok: true;
      tenant: {
        id: string;
        slug: string;
        name: string;
        trialEndsAt: string;
      };
    }
  | { ok: false; reason: SlugUnavailableReason | "already_owns" };

export const claimSlug = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => claimInput.parse(raw))
  .handler(async ({ data }): Promise<ClaimSlugResult> => {
    const parsed = validateSlugFormat(data.slug);
    if (!parsed.ok) return { ok: false, reason: "invalid" };
    if (isReservedSlug(parsed.slug)) {
      return { ok: false, reason: "reserved" };
    }

    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Single-tenant-per-user guard for Phase 1.5. A user re-running the
    // wizard hits this and gets bounced to the "you already have a spa"
    // UI rather than provisioning a duplicate row.
    const { data: existingMembership, error: memErr } = await sb
      .from("tenant_memberships")
      .select("tenant_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (memErr) {
      throw new Error(`Couldn't read your membership: ${memErr.message}`);
    }
    if (existingMembership) {
      return { ok: false, reason: "already_owns" };
    }

    const trimmedName = data.name.trim();

    // Referral attribution. Invalid or unknown-rep tokens are ignored —
    // the spa still gets a tenant; attribution just stays null. We never
    // 500 the claim flow over an attribution-layer concern.
    let referredByRepId: string | null = null;
    if (data.refToken) {
      const decoded = validateReferralToken(data.refToken);
      if (decoded) {
        const { data: rep } = await sb
          .from("rep_accounts")
          .select("rep_user_id, status")
          .eq("rep_user_id", decoded.repId)
          .maybeSingle();
        if (rep && rep.status === "active") {
          referredByRepId = rep.rep_user_id;
        }
      }
    }

    // v415.1: include delivery_channel in the insert if provided. Defaults
    // to 'proxy' via the column default (see migration
    // 20260617000000_tenants_delivery_channel.sql) when not specified, so
    // an unmigrated DB or a no-choice path still gets the trial-safe
    // setting. The column-not-found case (migration not yet pasted) will
    // surface as a 42703 error — fail loud rather than silently dropping.
    const tenantInsert: {
      name: string;
      slug: string;
      referred_by_rep_id: string | null;
      delivery_channel?: "proxy" | "direct";
    } = {
      name: trimmedName,
      slug: parsed.slug,
      referred_by_rep_id: referredByRepId,
    };
    if (data.deliveryChannel) {
      tenantInsert.delivery_channel = data.deliveryChannel;
    }
    const { data: tenant, error: insertErr } = await sb
      .from("tenants")
      .insert(tenantInsert)
      .select("id, slug, name, trial_ends_at")
      .single();
    if (insertErr) {
      // 23505 = unique_violation — the typeahead-to-claim race or a
      // case-only collision against the lower(slug) index.
      if (insertErr.code === "23505") {
        return { ok: false, reason: "taken" };
      }
      throw new Error(`Couldn't claim that URL: ${insertErr.message}`);
    }

    const { error: memInsertErr } = await sb
      .from("tenant_memberships")
      .insert({
        tenant_id: tenant.id,
        user_id: userId,
        role: "owner",
      });
    if (memInsertErr) {
      // The tenant row is orphaned in this rare failure path. Better than
      // returning success and lying — surface loudly so it gets noticed.
      console.error(
        "[claimSlug] membership insert failed for tenant",
        tenant.id,
        memInsertErr.message,
      );
      throw new Error(
        `Created the spa but couldn't link your account: ${memInsertErr.message}`,
      );
    }

    return {
      ok: true,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        trialEndsAt: tenant.trial_ends_at,
      },
    };
  });

// ─── getMyTenant ─────────────────────────────────────────────────────────

const myTenantInput = z.object({
  accessToken: z.string().min(1),
});

// v1.20 admin viewing-as variant for read fns that need to fan-out across
// the impersonated tenant. Used by getMyTenantRecoveryFeed.
const myTenantWithViewAsInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type MyTenant = {
  id: string;
  slug: string;
  name: string;
  trialEndsAt: string;
  plan: string;
  // v410: tenant.is_demo flag (mirrors rep_accounts.metadata->>'demo' pattern).
  // Drives the DemoBanner in RefillShellChrome. Defaults to false if the
  // column hasn't been added yet (migration-not-yet-applied safety net).
  isDemo: boolean;
};

export const getMyTenant = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => myTenantInput.parse(raw))
  .handler(async ({ data }): Promise<{ tenant: MyTenant | null }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const { data: membership, error: memErr } = await sb
      .from("tenant_memberships")
      .select("tenant_id, tenants(id, slug, name, trial_ends_at, plan, is_demo)")
      .eq("user_id", userId)
      .maybeSingle();
    if (memErr) {
      throw new Error(`Couldn't load your spa: ${memErr.message}`);
    }
    if (!membership || !membership.tenants) {
      return { tenant: null };
    }
    const t = membership.tenants as {
      id: string;
      slug: string;
      name: string;
      trial_ends_at: string;
      plan: string;
      is_demo?: boolean;
    };
    return {
      tenant: {
        id: t.id,
        slug: t.slug,
        name: t.name,
        trialEndsAt: t.trial_ends_at,
        plan: t.plan,
        isDemo: t.is_demo ?? false,
      },
    };
  });

// ─── getFirstTenantForAdmin (v1.19) ──────────────────────────────────────
//
// Admin-only fallback for useTenantMembership: when an authed user has NO
// tenant_memberships row but IS flagged as admin (public.user_roles.role =
// 'admin'), this returns the first tenant in the system so RefillShell can
// render in "viewing as" mode. Pure read; no inserts, no membership grant.
//
// Data layer caveat documented: the rest of the spa-owner server fns still
// filter by user_id (from verifyAuth) when fetching patient/recovery/etc.
// data, so an admin viewing-as a tenant still sees their OWN data shape
// inside the rendered chrome, not the target tenant's. This is intentional
// minimum-viable scope per v1.19 — the chrome unblock alone has value
// (admin can walk the surfaces + confirm UI behaves) without the cross-
// tenant data-read layer that's a much bigger ship.

const adminFallbackInput = z.object({
  accessToken: z.string().min(1),
});

export const getFirstTenantForAdmin = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => adminFallbackInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{ tenant: MyTenant | null; ownerUserId: string | null }> => {
      const userId = await verifyAuth(data.accessToken);
      const sb = admin();
      // Gate: caller must be admin. We don't trust the client-side primaryRole
      // signal here — re-verify against user_roles server-side.
      const { data: roles, error: roleErr } = await sb
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("role", "admin")
        .maybeSingle();
      if (roleErr) {
        throw new Error(`Couldn't verify admin: ${roleErr.message}`);
      }
      if (!roles) {
        throw new Error("Admin only.");
      }
      // v1.20.3: prefer real tenants over demo seeds. Order by is_demo ASC
      // first (false/null before true) so seeded demo tenants like
      // rejuv-demo land last; ties broken by created_at ASC for stability.
      // Pre-v1.20.3 this returned the oldest tenant overall, which was
      // typically the rejuv-demo seed — so admin viewing-as resolved to
      // demo data even when real production tenants existed. Real Karen's
      // Rejuv data is the load-bearing case (per project_rejuv_proof_or_nothing
      // + project_karen_identity).
      const { data: row, error: tenErr } = await sb
        .from("tenants")
        .select("id, slug, name, trial_ends_at, plan, is_demo")
        .order("is_demo", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (tenErr) {
        throw new Error(`Couldn't load tenants: ${tenErr.message}`);
      }
      if (!row) return { tenant: null, ownerUserId: null };
      // v1.20: also return the owner user_id so the client can plumb
      // viewAsUserId through to spa-owner server fns. Prefer the 'owner'
      // role row; fall back to any membership row if the role enum hasn't
      // been populated (early-migration safety).
      const { data: ownerRow } = await sb
        .from("tenant_memberships")
        .select("user_id, role")
        .eq("tenant_id", row.id)
        .order("created_at", { ascending: true })
        .limit(50);
      const owner =
        (ownerRow ?? []).find((r) => r.role === "owner") ?? (ownerRow ?? [])[0];
      return {
        tenant: {
          id: row.id,
          slug: row.slug,
          name: row.name,
          trialEndsAt: row.trial_ends_at,
          plan: row.plan,
          isDemo: row.is_demo ?? false,
        },
        ownerUserId: owner?.user_id ?? null,
      };
    },
  );

// ─── getMyTenantRecoveryFeed (v410.4) ────────────────────────────────────
//
// Tenant-scoped mirror of getMyLiveEarnings (which is rep-scoped). Drives
// the LiveRecoveryFeed widget on RefillHome. Returns aggregated revenue
// totals + recent events + the tenant's user_ids so the client can wire a
// supabase realtime subscription scoped to those users.
//
// emma_recovery_events is user-scoped today (no tenant_id column yet — the
// refill-billing cron does the same membership fan-out). When a tenant_id
// column lands on emma_recovery_events in a future ship, this fn collapses
// to a single eq(tenant_id) filter and the membership lookup goes away.

const liveFeedLimit = 8;

export type TenantRecoveryEvent = {
  id: string;
  createdAt: string;
  recoveryAgent: "rescue" | "post_recovery" | "preshow";
  attributedRevenueUsd: number | null;
  verifiedAt: string | null;
};

export type TenantRecoveryTotals = {
  todayUsd: number;
  last7DaysUsd: number;
  last30DaysUsd: number;
  lifetimeUsd: number;
  eventCountLifetime: number;
};

export const getMyTenantRecoveryFeed = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => myTenantWithViewAsInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      tenantUserIds: string[];
      totals: TenantRecoveryTotals;
      recent: TenantRecoveryEvent[];
    }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();

      // Resolve the user's tenant + fan-out to all user_ids on that tenant.
      // verifyAuth guarantees userId; tenant membership absent → return empty
      // (caller handles "not-a-tenant-yet" state with the loading splash).
      const { data: myMembership, error: memErr } = await sb
        .from("tenant_memberships")
        .select("tenant_id")
        .eq("user_id", effectiveUserId)
        .maybeSingle();
      if (memErr) {
        throw new Error(`Couldn't load tenant membership: ${memErr.message}`);
      }
      const tenantId = myMembership?.tenant_id;
      const empty = {
        todayUsd: 0,
        last7DaysUsd: 0,
        last30DaysUsd: 0,
        lifetimeUsd: 0,
        eventCountLifetime: 0,
      } as const;
      if (!tenantId) {
        return { tenantUserIds: [], totals: { ...empty }, recent: [] };
      }

      const { data: memberships } = await sb
        .from("tenant_memberships")
        .select("user_id")
        .eq("tenant_id", tenantId);
      const tenantUserIds = (memberships ?? []).map((m) => m.user_id);
      if (tenantUserIds.length === 0) {
        return { tenantUserIds: [], totals: { ...empty }, recent: [] };
      }

      const { data: rows, error } = await sb
        .from("emma_recovery_events")
        .select(
          "id, created_at, recovery_agent, attributed_revenue_usd, verified_at",
        )
        .in("user_id", tenantUserIds)
        .order("created_at", { ascending: false });
      if (error) {
        throw new Error(`Couldn't load recovery feed: ${error.message}`);
      }

      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const startOfTodayMs = new Date(
        new Date().toISOString().slice(0, 10),
      ).getTime();

      const totals: TenantRecoveryTotals = { ...empty };
      const recent: TenantRecoveryEvent[] = [];
      for (const r of rows ?? []) {
        const usd =
          r.attributed_revenue_usd == null
            ? 0
            : Number(r.attributed_revenue_usd);
        const ts = new Date(r.created_at).getTime();
        totals.lifetimeUsd += usd;
        totals.eventCountLifetime += 1;
        if (ts >= startOfTodayMs) totals.todayUsd += usd;
        if (ts >= now - 7 * dayMs) totals.last7DaysUsd += usd;
        if (ts >= now - 30 * dayMs) totals.last30DaysUsd += usd;
        if (recent.length < liveFeedLimit) {
          recent.push({
            id: r.id,
            createdAt: r.created_at,
            recoveryAgent: r.recovery_agent as TenantRecoveryEvent["recoveryAgent"],
            attributedRevenueUsd:
              r.attributed_revenue_usd == null
                ? null
                : Number(r.attributed_revenue_usd),
            verifiedAt: r.verified_at,
          });
        }
      }

      return { tenantUserIds, totals, recent };
    },
  );

