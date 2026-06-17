/**
 * resolveBrand — read a spa's brand_settings row and merge it over REFILL_BRAND
 * to produce the ResolvedBrand a patient-facing surface renders (v2.66.0,
 * project_your_brand_white_label).
 *
 * This is the server-side companion to the pure mergeBrand() gate in
 * src/lib/brand.ts. Every patient-facing surface that wants per-spa branding
 * (rescue claim page, waitlist opt-in, booking page, transactional emails)
 * calls THIS, never the table directly — so the free/paid gate (mergeBrand)
 * is applied uniformly in exactly one place.
 *
 * brand_settings isn't in the generated Supabase types yet, so we use the same
 * loose-view cast the local_agents readers use (api.agent.heartbeat.ts,
 * connection-health.functions.ts). Failure degrades to the plain SmartSpa brand
 * — branding is presentation, never load-bearing for the claim/booking flow.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  REFILL_BRAND,
  mergeBrand,
  type ResolvedBrand,
} from "@/lib/brand";

type LooseClient = { from(t: string): any };

/**
 * The brand fields a PUBLIC patient-facing page needs to white-label itself —
 * the subset of ResolvedBrand that crosses the wire on a public payload (no
 * assistantName / whiteLabelActive, which are owner-side concerns). Shared by
 * the waitlist opt-in + booking pages; the rescue claim page predates this and
 * carries its own structurally-identical ClaimBrand.
 */
export type PublicBrand = {
  name: string;
  accent: string;
  logoUrl: string | null;
  logoMark: string;
  removePoweredBy: boolean;
};

/** Narrow a ResolvedBrand to the public-page subset. */
export function toPublicBrand(b: {
  name: string;
  accent: string;
  logoUrl: string | null;
  logoMark: string;
  removePoweredBy: boolean;
}): PublicBrand {
  return {
    name: b.name,
    accent: b.accent,
    logoUrl: b.logoUrl,
    logoMark: b.logoMark,
    removePoweredBy: b.removePoweredBy,
  };
}

/** Columns the merge needs from the brand_settings row. */
type BrandSettingsRow = {
  assistant_name: string | null;
  brand_display_name: string | null;
  accent_color: string | null;
  logo_url: string | null;
  remove_powered_by: boolean | null;
  branding_active: boolean | null;
  entitled: boolean | null;
};

/**
 * Resolve the brand a given spa's patients should see. Returns the plain
 * SmartSpa brand when the spa has no row, isn't entitled, or the read fails.
 */
export async function resolveBrand(
  sb: SupabaseClient,
  userId: string,
): Promise<ResolvedBrand> {
  let row: BrandSettingsRow | null = null;
  try {
    const { data } = await (sb as unknown as LooseClient)
      .from("brand_settings")
      .select(
        "assistant_name, brand_display_name, accent_color, logo_url, remove_powered_by, branding_active, entitled",
      )
      .eq("user_id", userId)
      .maybeSingle();
    row = (data as BrandSettingsRow | null) ?? null;
  } catch (err) {
    // Degrade to plain SmartSpa — never let a branding read break a claim page.
    console.error("[brand-resolver] read failed (degrading to SmartSpa):", err);
    row = null;
  }

  if (!row) return mergeBrand(REFILL_BRAND, null);

  return mergeBrand(REFILL_BRAND, {
    assistantName: row.assistant_name?.trim() || null,
    brandDisplayName: row.brand_display_name?.trim() || null,
    accentColor: row.accent_color?.trim() || null,
    logoUrl: row.logo_url?.trim() || null,
    removePoweredBy: !!row.remove_powered_by,
    brandingActive: !!row.branding_active,
    entitled: !!row.entitled,
  });
}
