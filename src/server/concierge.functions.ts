/**
 * Concierge mode — the onboarding "setting, not a phase" (project_trusted_onboarding).
 *
 * The locked architectural decision: concierge-first AND self-serve ride the
 * SAME rails. Concierge is a SETTING a human (us) flips while co-driving a
 * spa's setup — never a separate manual track. This module exposes the read
 * the shell uses to decide whether to show the honest "your SmartSpa team is
 * setting this up with you" banner.
 *
 * It is deliberately a thin transparency flag: it forks NO behavior. Every
 * gate, every server fn, every code path is identical whether concierge is on
 * or off — proving the shared-rails claim by construction. Admin flips
 * `concierge_mode_enabled` per tenant via /app/admin/agents (the catalog-driven
 * flag UI), ON during white-glove onboarding, OFF once the spa self-drives.
 *
 * Mirrors getSchedulerExtras' per-tenant feature_flags read. viewAs-honored so
 * an admin viewing-as a tenant sees that tenant's true concierge state.
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { getTenantIdForUser } from "@/server/refill-billing";

const getConciergeStateInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const getConciergeState = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getConciergeStateInput.parse(raw))
  .handler(async ({ data }): Promise<{ conciergeMode: boolean }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    if (!tenantId) return { conciergeMode: false };

    // Default OFF (catalog default); a tenant-scoped row with enabled=true opts
    // this spa into concierge mode. Mirror getSchedulerExtras' loose-typed read
    // (feature_flags isn't in the generated Database types).
    const sbAny = sb as never as {
      from(t: string): {
        select(c: string): {
          eq(c: string, v: unknown): {
            eq(c: string, v: unknown): {
              eq(c: string, v: unknown): {
                maybeSingle(): Promise<{
                  data: { enabled?: boolean } | null;
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
      .eq("flag_key", "concierge_mode_enabled")
      .eq("scope", "tenant")
      .eq("scope_id", tenantId)
      .maybeSingle();

    return { conciergeMode: row?.enabled === true };
  });
