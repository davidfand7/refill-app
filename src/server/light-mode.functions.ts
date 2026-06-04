/**
 * Light Mode server functions — v1.42.0.
 *
 * Per Refill-LightMode-Spec-v1.html: Light Mode is the email-forward
 * connector that activates Recovery + Recognition signals across all 5
 * gated scheduler platforms (Boulevard / Mindbody / Booker / Jane /
 * Zenoti) without touching their APIs. The spa owner forwards their
 * platform's confirmation / cancellation / no-show emails to a per-spa
 * Refill inbound address; this module exposes the server fns the
 * settings UI calls to enable / disable / inspect a connection.
 *
 * Auth pattern:
 *   - Tenant-side fns: resolveEffectiveUserId (viewAs-honored).
 *   - All writes use the service-role client; user_id scoping is
 *     manual (mirrors wishlist / canonical_brands pattern).
 *
 * Schema: see supabase/migrations/20260626000000_v1_42_0_light_mode.sql.
 *
 * NOTE: types.ts has NOT been regenerated for the new tables, so all
 * .from("emma_light_mode_connections" | "emma_email_quarantine") calls
 * use `as never` casts at the supabase boundary. Runtime is correct
 * against the deployed schema once the migration is applied.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ───────────────────────────────────────────────────

export type LightModePlatform =
  | "zenoti"
  | "jane"
  | "boulevard"
  | "mindbody"
  | "booker";

export type LightModeStatus = "pending" | "active" | "paused" | "silent";

export type LightModeConnection = {
  id: string;
  userId: string;
  platform: LightModePlatform;
  inboundSlug: string;
  inboundAddress: string;
  status: LightModeStatus;
  lastEventAt: string | null;
  eventsParsedTotal: number;
  eventsQuarantinedTotal: number;
  notes: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LightModeQuarantineRow = {
  id: string;
  platform: string | null;
  fromAddress: string | null;
  subject: string | null;
  reason: string | null;
  parserConfidence: number | null;
  receivedAt: string;
  reviewedAt: string | null;
};

// ─── Helpers ────────────────────────────────────────────────────────

const INBOUND_DOMAIN = "inbound.getrefill.app";

function buildInboundAddress(slug: string): string {
  return `${slug}@${INBOUND_DOMAIN}`;
}

function requireSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase service-role env not configured.");
  }
  return { url, key };
}

function createServiceClient() {
  const { url, key } = requireSupabaseEnv();
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Read fns ───────────────────────────────────────────────────────

/**
 * List Light Mode connections for the current spa (one per platform).
 * Returns an empty array if Light Mode has not been enabled for any
 * platform yet.
 */
const listLightModeConnectionsInput = z.object({ accessToken: z.string() });
export const listLightModeConnections = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listLightModeConnectionsInput.parse(raw))
  .handler(async ({ data }) => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      data: { accessToken: data.accessToken },
    });
    const sb = createServiceClient();
    const sbAny = sb as never as {
      from(t: string): {
        select(c: string): {
          eq(c: string, v: unknown): {
            order(
              c: string,
              opts: { ascending: boolean },
            ): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
          };
        };
      };
    };
    const { data: rows, error } = await sbAny
      .from("emma_light_mode_connections")
      .select(
        "id,user_id,platform,inbound_slug,status,last_event_at,events_parsed_total,events_quarantined_total,notes,last_error,created_at,updated_at",
      )
      .eq("user_id", effectiveUserId)
      .order("platform", { ascending: true });
    if (error) {
      throw new Error(
        `Failed to load Light Mode connections: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
    return {
      connections: (rows ?? []).map(rowToConnection),
    };
  });

/**
 * Enable Light Mode for a given platform. Generates a per-spa inbound
 * slug if no connection exists yet for that platform; otherwise just
 * unpause an existing row.
 */
const enableLightModeInput = z.object({
  accessToken: z.string(),
  platform: z.enum(["zenoti", "jane", "boulevard", "mindbody", "booker"]),
});
export const enableLightMode = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => enableLightModeInput.parse(raw))
  .handler(async ({ data }) => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      data: { accessToken: data.accessToken },
    });
    const sb = createServiceClient();
    const sbAny = sb as never as {
      from(t: string): {
        select(c: string): {
          eq(c: string, v: unknown): {
            eq(c: string, v: unknown): {
              maybeSingle(): Promise<{
                data: Record<string, unknown> | null;
                error: unknown;
              }>;
            };
          };
        };
        insert(row: Record<string, unknown>): {
          select(c: string): {
            single(): Promise<{
              data: Record<string, unknown> | null;
              error: unknown;
            }>;
          };
        };
        update(patch: Record<string, unknown>): {
          eq(c: string, v: unknown): Promise<{ error: unknown }>;
        };
      };
    };

    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const { data: existing } = await sbAny
      .from("emma_light_mode_connections")
      .select("id,inbound_slug,status")
      .eq("user_id", effectiveUserId)
      .eq("platform", data.platform)
      .maybeSingle();

    if (existing) {
      await sbAny
        .from("emma_light_mode_connections")
        .update({
          status: "pending",
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id as string);
      return {
        ok: true,
        inboundAddress: buildInboundAddress(existing.inbound_slug as string),
        slug: existing.inbound_slug as string,
        reactivated: true,
      };
    }

    // Insert; the inbound_slug default in the migration generates the
    // hex slug, so we don't pass it here.
    const { data: inserted, error } = await sbAny
      .from("emma_light_mode_connections")
      .insert({
        user_id: effectiveUserId,
        tenant_id: tenantId,
        platform: data.platform,
        status: "pending",
      })
      .select("inbound_slug")
      .single();
    if (error || !inserted) {
      throw new Error(
        `Failed to enable Light Mode: ${
          error instanceof Error ? error.message : "unknown insert error"
        }`,
      );
    }
    return {
      ok: true,
      inboundAddress: buildInboundAddress(inserted.inbound_slug as string),
      slug: inserted.inbound_slug as string,
      reactivated: false,
    };
  });

/**
 * Disable (pause) a Light Mode connection. We keep the row + slug so
 * a future re-enable hits the same inbound address; the owner's Gmail
 * filter keeps working when they re-enable.
 */
const disableLightModeInput = z.object({
  accessToken: z.string(),
  platform: z.enum(["zenoti", "jane", "boulevard", "mindbody", "booker"]),
});
export const disableLightMode = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => disableLightModeInput.parse(raw))
  .handler(async ({ data }) => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      data: { accessToken: data.accessToken },
    });
    const sb = createServiceClient();
    const sbAny = sb as never as {
      from(t: string): {
        update(patch: Record<string, unknown>): {
          eq(c: string, v: unknown): {
            eq(c: string, v: unknown): Promise<{ error: unknown }>;
          };
        };
      };
    };
    const { error } = await sbAny
      .from("emma_light_mode_connections")
      .update({
        status: "paused",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", effectiveUserId)
      .eq("platform", data.platform);
    if (error) {
      throw new Error(
        `Failed to pause Light Mode: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
    return { ok: true };
  });

/**
 * List recent quarantine rows for this spa (parser couldn't classify).
 * Used by the Light Mode wizard + the admin review surface.
 */
const listLightModeQuarantineInput = z.object({
  accessToken: z.string(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const listLightModeQuarantine = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listLightModeQuarantineInput.parse(raw))
  .handler(async ({ data }) => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      data: { accessToken: data.accessToken },
    });
    const sb = createServiceClient();
    const sbAny = sb as never as {
      from(t: string): {
        select(c: string): {
          eq(c: string, v: unknown): {
            order(
              c: string,
              opts: { ascending: boolean },
            ): {
              limit(n: number): Promise<{
                data: Record<string, unknown>[] | null;
                error: unknown;
              }>;
            };
          };
        };
      };
    };
    const { data: rows } = await sbAny
      .from("emma_email_quarantine")
      .select(
        "id,platform,from_address,subject,reason,parser_confidence,received_at,reviewed_at",
      )
      .eq("user_id", effectiveUserId)
      .order("received_at", { ascending: false })
      .limit(data.limit ?? 20);

    return {
      rows: (rows ?? []).map((r) => ({
        id: r.id as string,
        platform: (r.platform as string | null) ?? null,
        fromAddress: (r.from_address as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        reason: (r.reason as string | null) ?? null,
        parserConfidence: (r.parser_confidence as number | null) ?? null,
        receivedAt: r.received_at as string,
        reviewedAt: (r.reviewed_at as string | null) ?? null,
      })) as LightModeQuarantineRow[],
    };
  });

/**
 * D-7: Returns the most-recent un-acked Gmail forwarding-verification
 * email captured for this spa+platform (or null). The wizard polls
 * this so the owner gets a one-click confirm prompt instead of having
 * to dig the verification mail out of their forwarded queue.
 */
const getPendingGmailVerificationInput = z.object({
  accessToken: z.string(),
  platform: z.enum(["zenoti", "jane", "boulevard", "mindbody", "booker"]),
});
export const getPendingGmailVerification = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getPendingGmailVerificationInput.parse(raw))
  .handler(async ({ data }) => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      data: { accessToken: data.accessToken },
    });
    const sb = createServiceClient();
    const sbAny = sb as never as {
      from(t: string): {
        select(c: string): {
          eq(c: string, v: unknown): {
            eq(c: string, v: unknown): {
              eq(c: string, v: unknown): {
                is(c: string, v: unknown): {
                  order(
                    c: string,
                    opts: { ascending: boolean },
                  ): {
                    limit(n: number): Promise<{
                      data: Record<string, unknown>[] | null;
                      error: unknown;
                    }>;
                  };
                };
              };
            };
          };
        };
      };
    };
    const { data: rows } = await sbAny
      .from("emma_email_quarantine")
      .select("id,subject,reviewed_notes,received_at")
      .eq("user_id", effectiveUserId)
      .eq("platform", data.platform)
      .eq("reason", "gmail_verification")
      .is("reviewed_at", null)
      .order("received_at", { ascending: false })
      .limit(1);

    if (!rows || rows.length === 0) return { pending: false as const };
    const row = rows[0];
    return {
      pending: true as const,
      id: row.id as string,
      subject: (row.subject as string | null) ?? null,
      confirmUrl: (row.reviewed_notes as string | null) ?? null,
      receivedAt: row.received_at as string,
    };
  });

/**
 * Returns which scheduler extras (Light Mode, Plaid Mode) are surfaced
 * for the current spa on their /app/refill/settings/scheduler page.
 *
 * Light Mode = always available (universally safe; ToS-clean).
 * Plaid Mode = gated by feature_flags.flag_key='plaid_mode_enabled'
 *   scope='tenant' scope_id=<tenant_id> enabled=true. Admin sets this
 *   per-spa via /app/admin/agents (existing UI), keeping the gray-zone
 *   connector hidden from any spa the admin hasn't opted in.
 */
const getSchedulerExtrasInput = z.object({ accessToken: z.string() });
export const getSchedulerExtras = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getSchedulerExtrasInput.parse(raw))
  .handler(async ({ data }) => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      data: { accessToken: data.accessToken },
    });
    const sb = createServiceClient();

    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    let plaidMode = false;

    if (tenantId) {
      const sbAny = sb as never as {
        from(t: string): {
          select(c: string): {
            eq(c: string, v: unknown): {
              eq(c: string, v: unknown): {
                eq(c: string, v: unknown): {
                  maybeSingle(): Promise<{
                    data: Record<string, unknown> | null;
                    error: unknown;
                  }>;
                };
              };
            };
          };
        };
      };
      const { data: row } = await sbAny
        .from("feature_flags")
        .select("enabled")
        .eq("flag_key", "plaid_mode_enabled")
        .eq("scope", "tenant")
        .eq("scope_id", tenantId)
        .maybeSingle();
      if (row && row.enabled === true) plaidMode = true;
    }

    return {
      lightMode: true, // Always available — universally safe.
      plaidMode,
    };
  });

// ─── Internals ──────────────────────────────────────────────────────

function rowToConnection(row: Record<string, unknown>): LightModeConnection {
  const slug = row.inbound_slug as string;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    platform: row.platform as LightModePlatform,
    inboundSlug: slug,
    inboundAddress: buildInboundAddress(slug),
    status: row.status as LightModeStatus,
    lastEventAt: (row.last_event_at as string | null) ?? null,
    eventsParsedTotal: (row.events_parsed_total as number) ?? 0,
    eventsQuarantinedTotal: (row.events_quarantined_total as number) ?? 0,
    notes: (row.notes as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

async function getTenantIdForUser(
  sb: ReturnType<typeof createServiceClient>,
  userId: string,
): Promise<string | null> {
  const sbAny = sb as never as {
    from(t: string): {
      select(c: string): {
        eq(c: string, v: unknown): {
          eq(c: string, v: unknown): {
            maybeSingle(): Promise<{
              data: Record<string, unknown> | null;
              error: unknown;
            }>;
          };
        };
      };
    };
  };
  const { data } = await sbAny
    .from("tenant_memberships")
    .select("tenant_id")
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();
  return (data?.tenant_id as string | null) ?? null;
}
