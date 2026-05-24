/**
 * Refill admin server fns (v389 / Phase 1.6 slice 2).
 *
 * Two surfaces for the Grasshopper-only admin lever board at
 * /app/admin/refill-trials:
 *
 *   listAllTrialTenants — pull every Refill tenant + their drip
 *     engagement events in two round-trips. Client aggregates into a
 *     per-tenant drip-state map (which days sent + when). 2-step query
 *     pattern matches the cron's; if the spa base grows past a few
 *     hundred we'll switch to a server-side JSON_AGG RPC.
 *
 *   adminSendDripToTenant — manual override to fire a specific day's
 *     drip to a specific tenant from the admin UI. Useful for testing,
 *     re-sends after a failed delivery, or backfilling a tenant who
 *     missed a window. Caller must be in user_roles with role='admin'.
 *
 * The auth gate matches the existing useIsAdmin pattern (user_roles
 * table lookup) so admin status stays consistent between client + server.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";
import {
  DRIP_DAYS,
  sendTrialDripByDay,
  type DripDay,
} from "@/server/refill-drip";

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

/**
 * Verify the caller is an admin per the user_roles table — same gate the
 * client-side useIsAdmin hook reads. Throws on miss with a user-facing
 * message because the admin route shouldn&apos;t even be reachable for non-
 * admins (the hook redirects), so reaching this fn means tampering.
 */
async function requireAdmin(sb: SbClient, accessToken: string): Promise<string> {
  const userId = await verifyAuth(accessToken);
  const { data: roleRow, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) {
    throw new Error(`Couldn't verify admin role: ${error.message}`);
  }
  if (!roleRow) {
    throw new Error("Admin role required.");
  }
  return userId;
}

// ─── listAllTrialTenants ─────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string().min(1),
});

export interface TrialDripState {
  sentAt: string;
  messageId: string | null;
  /** v390: populated when the spa owner replied to this drip. */
  replyText: string | null;
  replyReceivedAt: string | null;
}

export interface TrialTenantRow {
  id: string;
  slug: string;
  name: string;
  plan: string;
  createdAt: string;
  trialEndsAt: string;
  trialDayNumber: number;
  drips: Partial<Record<DripDay, TrialDripState>>;
}

export const listAllTrialTenants = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listInput.parse(raw))
  .handler(async ({ data }): Promise<{ tenants: TrialTenantRow[] }> => {
    const sb = admin();
    await requireAdmin(sb, data.accessToken);

    const { data: tenants, error: tenantsErr } = await sb
      .from("tenants")
      .select("id, slug, name, plan, created_at, trial_ends_at")
      .order("created_at", { ascending: false });
    if (tenantsErr) {
      throw new Error(`tenants query: ${tenantsErr.message}`);
    }
    if (!tenants || tenants.length === 0) {
      return { tenants: [] };
    }

    const { data: events, error: eventsErr } = await sb
      .from("tenant_engagement_events")
      .select(
        "tenant_id, event_type, sent_at, payload, response_text, response_received_at",
      )
      .in("tenant_id", tenants.map((t) => t.id))
      .like("event_type", "drip:day%");
    if (eventsErr) {
      throw new Error(`engagement query: ${eventsErr.message}`);
    }

    // Aggregate: { tenant_id → { day → TrialDripState } }
    type DripMap = TrialTenantRow["drips"];
    const dripsByTenant = new Map<string, DripMap>();
    for (const ev of events ?? []) {
      const match = /^drip:day(\d+)$/.exec(ev.event_type);
      if (!match) continue;
      const day = Number(match[1]) as DripDay;
      if (!DRIP_DAYS.includes(day)) continue;
      const existing = dripsByTenant.get(ev.tenant_id) ?? {};
      const messageId =
        ev.payload &&
        typeof ev.payload === "object" &&
        !Array.isArray(ev.payload) &&
        "message_id" in ev.payload &&
        typeof (ev.payload as Record<string, unknown>).message_id === "string"
          ? ((ev.payload as Record<string, unknown>).message_id as string)
          : null;
      existing[day] = {
        sentAt: ev.sent_at ?? "",
        messageId,
        replyText: ev.response_text ?? null,
        replyReceivedAt: ev.response_received_at ?? null,
      };
      dripsByTenant.set(ev.tenant_id, existing);
    }

    const now = Date.now();
    const rows: TrialTenantRow[] = tenants.map((t) => {
      const createdMs = new Date(t.created_at).getTime();
      const ageDays = Math.max(
        0,
        Math.floor((now - createdMs) / (24 * 60 * 60 * 1000)),
      );
      return {
        id: t.id,
        slug: t.slug,
        name: t.name,
        plan: t.plan,
        createdAt: t.created_at,
        trialEndsAt: t.trial_ends_at,
        trialDayNumber: ageDays,
        drips: dripsByTenant.get(t.id) ?? {},
      };
    });

    return { tenants: rows };
  });

// ─── adminSendDripToTenant ───────────────────────────────────────────────

const sendInput = z.object({
  accessToken: z.string().min(1),
  tenantId: z.string().uuid(),
  day: z.union([
    z.literal(3),
    z.literal(7),
    z.literal(14),
    z.literal(21),
    z.literal(28),
  ]),
});

export const adminSendDripToTenant = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sendInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; messageId: string | null }
      | { ok: false; reason: string }
    > => {
      const sb = admin();
      await requireAdmin(sb, data.accessToken);
      return sendTrialDripByDay(data.day as DripDay, data.tenantId);
    },
  );
