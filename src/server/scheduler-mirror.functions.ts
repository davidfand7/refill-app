/**
 * scheduler-mirror.functions.ts — Acuity → SmartSpa staging mirror.
 *
 * The onboarding trust step (session 2026-06-11): before a spa commits to
 * cutting over from Acuity, we MIRROR their Acuity structure into our native
 * tables so they can see their SmartSpa calendar standing up side-by-side
 * with their current one — same, but hopefully better — and only then cut over.
 *
 * The gap this closes: the live Acuity connector already streams APPOINTMENTS
 * into appointments, but it pulls no STRUCTURE — so those appointments
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
 *   appointments       → set native provider_id where provider_name
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
import { admin } from "./admin-client";
import { z } from "zod";

import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
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
    /** Newly-created business-named calendars auto-hidden from the grid (empty only). */
    autoHidden: number;
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

type Sb = ReturnType<typeof admin>;

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase();

/** Like norm but also drops a trailing parenthetical ("Rejuv Skin Spa (Demo)" →
 *  "rejuv skin spa") so a business calendar still matches the spa name across a
 *  "(Demo)"/"(Main)" suffix. */
const normBusiness = (s: string | null | undefined): string =>
  norm(s).replace(/\s*\([^)]*\)\s*$/, "").trim();

/** A mirrored Acuity calendar "looks like the business" when its name matches the
 *  tenant name (ignoring a trailing parenthetical / on a contains either way).
 *  Used ONLY to choose a smart DEFAULT for column visibility — never a hard
 *  filter; the owner always overrides, and we only auto-hide EMPTY ones. */
function looksLikeBusinessCalendar(calName: string, businessName: string): boolean {
  const c = normBusiness(calName);
  const b = normBusiness(businessName);
  if (!c || !b) return false;
  return c === b || c.includes(b) || b.includes(c);
}

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
    .from("scheduler_connections")
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
      .from("appointments")
      .select("id", head)
      .eq("user_id", userId)
      .not("provider_id", "is", null),
    sb.from("appointments").select("id", head).eq("user_id", userId),
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

    // external_id/external_source are added by the v2.4.9 migration and aren't
    // in the generated types yet → untyped accessor (same pattern as offers).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anySb = sb as unknown as { from(t: string): any };

    // ── Mirror providers (calendars) — anchored by Acuity calendar id, so a
    //    rename updates the existing row instead of creating a duplicate. ──
    const { data: existingProviders } = await anySb
      .from("scheduling_providers")
      .select("id, name, external_id, external_source")
      .eq("tenant_id", tenantId);
    const provByExtId = new Map<string, { id: string; name: string }>();
    const provByName = new Map<string, string>(); // norm(name) → id (legacy adoption)
    for (const p of (existingProviders ?? []) as Array<{
      id: string;
      name: string;
      external_id: string | null;
      external_source: string | null;
    }>) {
      provByName.set(norm(p.name), p.id);
      if (p.external_source === "acuity" && p.external_id) {
        provByExtId.set(p.external_id, { id: p.id, name: p.name });
      }
    }

    // The spa name drives the smart-default visibility for a business-named
    // calendar (only applied to NEW, empty mirrored providers below).
    const { data: tenantRow } = await anySb
      .from("tenants")
      .select("name")
      .eq("id", tenantId)
      .maybeSingle();
    const businessName: string = (tenantRow as { name?: string } | null)?.name ?? "";
    // Newly-created providers whose name looks like the business — candidates for
    // the empty-only smart-default hide (decided AFTER appointment-linking below).
    const businessMatchCreated: { id: string; name: string }[] = [];

    const provReport = {
      fromAcuity: calendars.length,
      created: 0,
      matched: 0,
      autoHidden: 0,
      unmappable: [] as string[],
    };
    const createdProviderIds: string[] = [];
    for (const cal of calendars) {
      if (!cal.name) {
        provReport.unmappable.push(`Calendar #${cal.id} (no name)`);
        continue;
      }
      const extId = String(cal.id);
      const key = norm(cal.name);

      const byExt = provByExtId.get(extId);
      if (byExt) {
        // Rename-safe: Acuity renamed this calendar → update our row's name.
        if (byExt.name !== cal.name) {
          await anySb.from("scheduling_providers").update({ name: cal.name }).eq("id", byExt.id);
        }
        provByName.set(key, byExt.id);
        provReport.matched += 1;
        continue;
      }
      const byName = provByName.get(key);
      if (byName) {
        // Adopt a pre-external-id mirrored row (or a same-named provider).
        await anySb
          .from("scheduling_providers")
          .update({ external_source: "acuity", external_id: extId })
          .eq("id", byName);
        provByExtId.set(extId, { id: byName, name: cal.name });
        provReport.matched += 1;
        continue;
      }
      const { data: inserted, error } = await anySb
        .from("scheduling_providers")
        .insert({
          tenant_id: tenantId,
          name: cal.name,
          user_id: null,
          is_active: true,
          external_source: "acuity",
          external_id: extId,
        })
        .select("id")
        .single();
      if (error || !inserted) {
        provReport.unmappable.push(`${cal.name} (${error?.message ?? "insert failed"})`);
        continue;
      }
      const newId = (inserted as { id: string }).id;
      provByName.set(key, newId);
      provByExtId.set(extId, { id: newId, name: cal.name });
      createdProviderIds.push(newId);
      if (looksLikeBusinessCalendar(cal.name, businessName)) {
        businessMatchCreated.push({ id: newId, name: cal.name });
      }
      provReport.created += 1;
    }
    // Give every freshly-mirrored provider default hours so the staged
    // calendar renders availability (idempotent; won't overwrite owner edits).
    for (const pid of createdProviderIds) {
      await seedDefaultHours(sb, pid);
    }

    // ── Mirror services (appointment-types) — anchored by Acuity type id. ──
    const { data: existingServices } = await anySb
      .from("services")
      .select("id, name, external_id, external_source")
      .eq("tenant_id", tenantId);
    const svcByExtId = new Map<string, { id: string; name: string }>();
    const svcByName = new Map<string, string>(); // norm(name) → id
    for (const s of (existingServices ?? []) as Array<{
      id: string;
      name: string;
      external_id: string | null;
      external_source: string | null;
    }>) {
      svcByName.set(norm(s.name), s.id);
      if (s.external_source === "acuity" && s.external_id) {
        svcByExtId.set(s.external_id, { id: s.id, name: s.name });
      }
    }

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
      const extId = String(t.id);
      const key = norm(t.name);

      const byExt = svcByExtId.get(extId);
      if (byExt) {
        if (byExt.name !== t.name) {
          await anySb.from("services").update({ name: t.name }).eq("id", byExt.id);
        }
        svcReport.matched += 1;
        continue;
      }
      const byName = svcByName.get(key);
      if (byName) {
        await anySb
          .from("services")
          .update({ external_source: "acuity", external_id: extId })
          .eq("id", byName);
        svcByExtId.set(extId, { id: byName, name: t.name });
        svcReport.matched += 1;
        continue;
      }
      const priceNum = Number.parseFloat(t.price);
      const price = Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : 0;
      const duration = Math.max(5, Math.round(t.duration || 30));
      const category = t.category && t.category.trim() ? t.category.trim() : "other";
      const { data: insSvc, error } = await anySb
        .from("services")
        .insert({
          tenant_id: tenantId,
          name: t.name,
          category,
          service_price: price,
          cogs_per_service: null,
          cogs_source: "manual",
          duration_min: duration,
          online_bookable: true,
          external_source: "acuity",
          external_id: extId,
        })
        .select("id")
        .single();
      if (error || !insSvc) {
        svcReport.unmappable.push(`${t.name} (${error?.message ?? "insert failed"})`);
        continue;
      }
      svcByName.set(key, (insSvc as { id: string }).id);
      svcByExtId.set(extId, { id: (insSvc as { id: string }).id, name: t.name });
      svcReport.created += 1;
    }

    // ── Link existing appointments to mirrored providers (by name) ──
    let linked = 0;
    for (const cal of calendars) {
      const pid = provByName.get(norm(cal.name));
      if (!pid || !cal.name) continue;
      const { data: updated } = await sb
        .from("appointments")
        .update({ provider_id: pid })
        .eq("user_id", effectiveUserId)
        .eq("provider_name", cal.name)
        .is("provider_id", null)
        .select("id");
      linked += (updated ?? []).length;
    }
    const { count: stillUnlinked } = await sb
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", effectiveUserId)
      .is("provider_id", null);

    // ── Smart default: hide an EMPTY business-named mirrored calendar ──
    // Newly-mirrored calendars that look like the business get hidden from the
    // grid BY DEFAULT — but only when they carry no appointments, so we never
    // make real bookings disappear. Anything with appts stays shown; the owner
    // can hide it from the manage-providers list (where the appt count is shown,
    // so the choice is informed). Surfaced honestly via the "N hidden — review"
    // note on the schedule — never a silent drop (connection-health doctrine).
    let hiddenByDefault = 0;
    for (const c of businessMatchCreated) {
      const { count: apptCount } = await sb
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("provider_id", c.id)
        .neq("status", "cancelled");
      if ((apptCount ?? 0) === 0) {
        await anySb
          .from("scheduling_providers")
          .update({ hidden_at: new Date().toISOString() })
          .eq("id", c.id);
        hiddenByDefault += 1;
      }
    }
    provReport.autoHidden = hiddenByDefault;

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
