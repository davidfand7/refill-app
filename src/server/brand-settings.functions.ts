/**
 * "Your Brand" editor server fns (v2.66.0, project_your_brand_white_label).
 *
 * Browser-callable read + write for a spa's brand_settings row, powering the
 * Settings → Your Brand page (src/routes/app.refill.settings.brand.tsx).
 * resolveBrand (src/server/brand-resolver.ts) is the consumer side — it reads
 * the same row for patient-facing surfaces. These fns are the owner side.
 *
 * THE ENTITLEMENT BOUNDARY: `entitled` is server/billing-controlled. The owner
 * editor can read it (so the UI can lock/unlock the paid section) but CANNOT
 * write it — setBrandSettingsFn deliberately omits it from the upsert. Flipping
 * a spa to entitled is an out-of-band op (inline SQL / future billing webhook).
 *
 * Impersonation: both fns honor viewAsUserId via resolveEffectiveUserId, so an
 * admin viewing-as Karen edits Karen's brand. Non-admin callers passing
 * viewAsUserId get a hard 403 at the resolver. Mirrors spa-profile.functions.ts.
 *
 * brand_settings isn't in the generated Supabase types yet → loose-view cast,
 * same as the local_agents readers.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

function admin() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type LooseClient = { from(t: string): any };

/** What the editor renders. `entitled` is read-only signal to lock the UI. */
export type BrandSettingsBundle = {
  assistantName: string | null;
  brandDisplayName: string | null;
  accentColor: string | null;
  logoUrl: string | null;
  removePoweredBy: boolean;
  brandingActive: boolean;
  entitled: boolean;
};

const EMPTY: BrandSettingsBundle = {
  assistantName: null,
  brandDisplayName: null,
  accentColor: null,
  logoUrl: null,
  removePoweredBy: false,
  brandingActive: false,
  entitled: false,
};

const getInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const getBrandSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getInput.parse(raw))
  .handler(async ({ data }): Promise<BrandSettingsBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const { data: row } = await (admin() as unknown as LooseClient)
      .from("brand_settings")
      .select(
        "assistant_name, brand_display_name, accent_color, logo_url, remove_powered_by, branding_active, entitled",
      )
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    if (!row) return EMPTY;
    return {
      assistantName: row.assistant_name?.trim() || null,
      brandDisplayName: row.brand_display_name?.trim() || null,
      accentColor: row.accent_color?.trim() || null,
      logoUrl: row.logo_url?.trim() || null,
      removePoweredBy: !!row.remove_powered_by,
      brandingActive: !!row.branding_active,
      entitled: !!row.entitled,
    };
  });

// Owner-editable fields only — `entitled` is intentionally absent (billing-only).
// Hex is validated loosely (#rgb / #rrggbb); a bad value would just render odd,
// not break, but a guard keeps the stored value sane. Empty string → null
// (clears the field), mirroring the spa-profile "blank = unset" convention.
const hex = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex color like #7c3aed.");

const setInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  assistantName: z.string().trim().max(60).optional().nullable(),
  brandDisplayName: z.string().trim().max(60).optional().nullable(),
  accentColor: z.union([hex, z.literal(""), z.null()]).optional(),
  logoUrl: z.string().trim().url().max(500).optional().or(z.literal("")).nullable(),
  removePoweredBy: z.boolean().optional(),
  brandingActive: z.boolean().optional(),
});

export const setBrandSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });

    const norm = (v: string | null | undefined): string | null => {
      const t = (v ?? "").trim();
      return t.length ? t : null;
    };

    // Full-row upsert of the owner-editable fields. The editor always sends the
    // whole draft, so an upsert (not a per-field patch) is the right shape and
    // keeps the row coherent. `entitled` is NEVER in this payload.
    const { error } = await (admin() as unknown as LooseClient)
      .from("brand_settings")
      .upsert(
        {
          user_id: effectiveUserId,
          assistant_name: norm(data.assistantName),
          brand_display_name: norm(data.brandDisplayName),
          accent_color: norm(data.accentColor),
          logo_url: norm(data.logoUrl),
          remove_powered_by: !!data.removePoweredBy,
          branding_active: !!data.brandingActive,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(`Couldn't save brand settings: ${error.message}`);
    return { ok: true };
  });
