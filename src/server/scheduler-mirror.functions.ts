/**
 * scheduler-mirror.functions.ts — Acuity → SmartSpa staging mirror.
 *
 * The onboarding trust step (session 2026-06-11): before a spa commits to
 * cutting over from Acuity, we MIRROR their Acuity structure into our native
 * tables so they can see their SmartSpa calendar standing up side-by-side
 * with their current one — same, but hopefully better — and only then cut over.
 *
 * The gap this closes: the live Acuity connector already streams APPOINTMENTS
 * into emma_appointments, but it pulls no STRUCTURE — so those appointments
 * carry only a free-text provider_name and never column-align in the native
 * grid, and there are no native services/providers to make SmartSpa look like
 * their Acuity. This fn pulls calendars + appointment-types and materializes
 * them as native rows, then back-links the existing appointments to the
 * mirrored providers.
 *
 * What mirrors:
 *   Acuity calendars        → scheduling_providers (name match; user_id NULL,
 *                             because a mirrored calendar is a visualization
 *                             row, not a login — not bookable until cutover)
 *   Acuity appointment-types→ services (name, duration, price, online_bookable)
 *   emma_appointments       → set native provider_id where provider_name
 *                             matches a mirrored provider
 *
 * Idempotent by NAME (neither table has a name-unique constraint, so we
 * check-then-insert — re-running matches what's already there instead of
 * duplicating). Anything we can't map (a blank calendar name, a private type)
 * is FLAGGED in the report, never silently dropped — same honesty doctrine as
 * Connection Health (feedback_connection_health_doctrine).
 *
 * No migration: every column this writes already exists.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { getTenantIdForUser } from "@/server/scheduling-settings.functions";
import {
  listAcuityCalendars,
  listAcuityAppointmentTypes,
} from "@/lib/schedulers/acuity";

// ─── Output shapes ───────────────────────────────────────────────────────

export interface MirrorReport {
  ranAtMs: number;
  acuityConnected: boolean;
  accountEmail: string | null;
  providers: {
    fromAcuity: number;
    created: number;
    matched: number;
    unmappable: string[];
  };
  services: {
    fromAcuity: number;
    created: number;
    matched: number;
    skippedInactive: number;
    unmappable: string[];
  };
  appointments: { linked: number; stillUnlinked: number };
  native: NativeCounts;
}

export interface NativeCounts {
  totalProviders: number;
  bookableServices: number;
  linkedAppointments: number;
  totalAppointments: number;
}

export interface MirrorStatus {
  acuityConnected: boolean;
  accountEmail: string | null;
  native: NativeCounts;
}

// ─── Admin client ──────────────────────────────────────────────────────────

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type Sb = ReturnType<typeof admin>;

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase();

/**
 * Seed sensible default weekly hours (Mon–Fri 9–5, weekend closed) for a
 * freshly-mirrored provider so the staged calendar shows real availability
 * bands instead of a blank column. Acuity's API doesn't expose weekly
 * business hours (only computed availability), so this is a tune-able default,
 * not a literal mirror. Idempotent + non-destructive: ignoreDuplicates means a
 * re-mirror never clobbers hours the owner has since adjusted.
 */
async function seedDefaultHours(sb: Sb, providerId: string): Promise<void> {
  const rows = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
    provider_id: providerId,
    day_of_week: dow,
    open_time: "09:00",
    close_time: "17:00",
    is_closed: dow === 0 || dow === 6,
  }));
  await sb
    .from("scheduling_hours")
    .upsert(rows, { onConflict: "provider_id,day_of_week", ignoreDuplicates: true });
}

// ─── Shared helpers ──────────────────────────────────────────────────────

type AcuityConn = {
  accessToken: string | null;
  accountEmail: string | null;
};

async function loadAcuityConnection(
  sb: Sb,
  userId: string,
): Promise<AcuityConn | null> {
  const { data: row } = await sb
    .from("emma_scheduler_connections")
    .select("access_token, platform_account_email, status")
    .eq("user_id", userId)
    .eq("platform", "acuity")
    .in("status", ["connected", "reauth_needed", "error"])
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return null;
  return {
    accessToken: (row as { access_token: string | null }).access_token,
    accountEmail: (row as { platform_account_email: string | null })
      .platform_account_email,
  };
}

async function nativeCounts(sb: Sb, tenantId: string, userId: string): Promise<NativeCounts> {
  const head = { count: "exact" as const, head: true };
  const [providers, bookable, linked, total] = await Promise.all([
    sb.from("scheduling_providers").select("id", head).eq("tenant_id", tenantId),
    sb
      .from("services")
      .select("id", head)
      .eq("tenant_id", tenantId)
      .eq("online_bookable", true),
    sb
      .from("emma_appointments")
      .select("id", head)
      .eq("user_id", userId)
      .not("provider_id", "is", null),
    sb.from("emma_appointments").select("id", head).eq("user_id", userId),
  ]);
  return {
    totalProviders: providers.count ?? 0,
    bookableServices: bookable.count ?? 0,
    linkedAppointments: linked.count ?? 0,
    totalAppointments: total.count ?? 0,
  };
}

// ─── getMirrorStatusFn — read-only state for the staging page ──────────────

const statusInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().optional(),
});

export const getMirrorStatusFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => statusInput.parse(raw))
  .handler(async ({ data }): Promise<MirrorStatus> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const conn = await loadAcuityConnection(sb, effectiveUserId);
    return {
      acuityConnected: !!conn?.accessToken,
      accountEmail: conn?.accountEmail ?? null,
      native: await nativeCounts(sb, tenantId, effectiveUserId),
    };
  });

// ─── stageAcuityMirrorFn — pull + materialize ──────────────────────────────

export const stageAcuityMirrorFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => statusInput.parse(raw))
  .handler(async ({ data }): Promise<MirrorReport> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const conn = await loadAcuityConnection(sb, effectiveUserId);
    if (!conn?.accessToken) {
      throw new Error(
        "No connected Acuity account found. Connect Acuity first, then run the mirror.",
      );
    }
    const token = conn.accessToken;

    // Pull structure (calendars + types) in parallel.
    const [calendars, types] = await Promise.all([
      listAcuityCalendars(token),
      listAcuityAppointmentTypes(token),
    ]);

    // ── Mirror providers (calendars) ──
    const { data: existingProviders } = await sb
      .from("scheduling_providers")
      .select("id, name")
      .eq("tenant_id", tenantId);
    const provByName = new Map<string, string>(); // norm(name) → id
    for (const p of (existingProviders ?? []) as { id: string; name: string }[]) {
      provByName.set(norm(p.name), p.id);
    }

    const provReport = {
      fromAcuity: calendars.length,
      created: 0,
      matched: 0,
      unmappable: [] as string[],
    };
    const createdProviderIds: string[] = [];
    for (const cal of calendars) {
      if (!cal.name) {
        provReport.unmappable.push(`Calendar #${cal.id} (no name)`);
        continue;
      }
      const key = norm(cal.name);
      if (provByName.has(key)) {
        provReport.matched += 1;
        continue;
      }
      const { data: inserted, error } = await sb
        .from("scheduling_providers")
        .insert({ tenant_id: tenantId, name: cal.name, user_id: null, is_active: true })
        .select("id")
        .single();
      if (error || !inserted) {
        provReport.unmappable.push(`${cal.name} (${error?.message ?? "insert failed"})`);
        continue;
      }
      const newId = (inserted as { id: string }).id;
      provByName.set(key, newId);
      createdProviderIds.push(newId);
      provReport.created += 1;
    }
    // Give every freshly-mirrored provider default hours so the staged
    // calendar renders availability (idempotent; won't overwrite owner edits).
    for (const pid of createdProviderIds) {
      await seedDefaultHours(sb, pid);
    }

    // ── Mirror services (appointment-types) ──
    const { data: existingServices } = await sb
      .from("services")
      .select("name")
      .eq("tenant_id", tenantId);
    const svcNames = new Set<string>(
      ((existingServices ?? []) as { name: string }[]).map((s) => norm(s.name)),
    );

    const svcReport = {
      fromAcuity: types.length,
      created: 0,
      matched: 0,
      skippedInactive: 0,
      unmappable: [] as string[],
    };
    for (const t of types) {
      if (!t.active || t.private) {
        svcReport.skippedInactive += 1;
        continue;
      }
      if (!t.name) {
        svcReport.unmappable.push(`Type #${t.id} (no name)`);
        continue;
      }
      const key = norm(t.name);
      if (svcNames.has(key)) {
        svcReport.matched += 1;
        continue;
      }
      const priceNum = Number.parseFloat(t.price);
      const price = Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : 0;
      const duration = Math.max(5, Math.round(t.duration || 30));
      const category = t.category && t.category.trim() ? t.category.trim() : "other";
      const { error } = await sb.from("services").insert({
        tenant_id: tenantId,
        name: t.name,
        category,
        service_price: price,
        cogs_per_service: null,
        cogs_source: "manual",
        duration_min: duration,
        online_bookable: true,
      });
      if (error) {
        svcReport.unmappable.push(`${t.name} (${error.message})`);
        continue;
      }
      svcNames.add(key);
      svcReport.created += 1;
    }

    // ── Link existing appointments to mirrored providers (by name) ──
    let linked = 0;
    for (const cal of calendars) {
      const pid = provByName.get(norm(cal.name));
      if (!pid || !cal.name) continue;
      const { data: updated } = await sb
        .from("emma_appointments")
        .update({ provider_id: pid })
        .eq("user_id", effectiveUserId)
        .eq("provider_name", cal.name)
        .is("provider_id", null)
        .select("id");
      linked += (updated ?? []).length;
    }
    const { count: stillUnlinked } = await sb
      .from("emma_appointments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", effectiveUserId)
      .is("provider_id", null);

    return {
      ranAtMs: Date.now(),
      acuityConnected: true,
      accountEmail: conn.accountEmail,
      providers: provReport,
      services: svcReport,
      appointments: { linked, stillUnlinked: stillUnlinked ?? 0 },
      native: await nativeCounts(sb, tenantId, effectiveUserId),
    };
  });
