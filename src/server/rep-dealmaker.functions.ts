/**
 * Rep Deal-Maker server fns (v2.148.0, slice 1 of project_rep_dealmaker).
 *
 * Client-safe entrypoint over the Ghostwriter core. The heavy bit (@anthropic-ai/sdk)
 * lives in rep-proposal-core.ts (server-only); this handler reaches it via a
 * *dynamic* import so the SDK never lands in the browser bundle even though the
 * Programs & tiers UI imports this module.
 *
 * Auth-gated to a real signed-in tenant user. We deliberately DO NOT persist the
 * draft: the off-record deal stays off SmartSpa's books (it surfaces later only
 * as a deeper per-tenant verified cost through the existing portal lane). The
 * draft is ephemeral — composed, handed to the owner, sent by the owner himself.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { admin } from "./admin-client";
import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import type { RepProposalOutput } from "./rep-proposal-core";

const NO_TENANT_MSG =
  "No SmartSpa tenant — finish onboarding before drafting a rep proposal.";

const composeInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  manufacturerLabel: z.string().min(1).max(120),
  repName: z.string().max(120).optional(),
  windowHeadline: z.string().max(400).optional(),
  isYearEnd: z.boolean().optional(),
  daysUntil: z.number().int().min(0).max(400).nullable().optional(),
  quarterLabel: z.string().max(8).optional(),
  productName: z.string().max(160).optional(),
  currentUnitPrice: z.number().nonnegative().nullable().optional(),
  targetQty: z.number().int().positive().max(100_000).nullable().optional(),
  targetUnitPrice: z.number().nonnegative().nullable().optional(),
  unitLabel: z.string().max(24).optional(),
  typicalQtyPerQuarter: z.number().int().positive().max(100_000).nullable().optional(),
  relationshipNote: z.string().max(600).optional(),
  tone: z.enum(["warm", "direct", "brief"]).default("warm"),
  channel: z.enum(["email", "text"]).default("email"),
});

export const composeRepProposalFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => composeInput.parse(raw))
  .handler(async ({ data }): Promise<RepProposalOutput> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    // Gate: must be a real tenant user. We use the id only to read the spa name
    // for the voice — nothing is written (the deal stays off-the-books).
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, NO_TENANT_MSG);

    let spaName = "your practice";
    try {
      const { data: tenant } = await sb
        .from("tenants")
        .select("name")
        .eq("id", tenantId)
        .maybeSingle();
      if (tenant?.name) spaName = tenant.name;
    } catch {
      // keep the generic fallback
    }

    // Dynamic import keeps the Anthropic SDK out of the client bundle. The owner
    // signs the message himself, so we pass no owner name.
    const { composeRepProposal } = await import("./rep-proposal-core");
    return composeRepProposal({
      spaName,
      ownerName: null,
      manufacturerLabel: data.manufacturerLabel,
      repName: data.repName ?? null,
      windowHeadline: data.windowHeadline ?? null,
      isYearEnd: data.isYearEnd ?? false,
      daysUntil: data.daysUntil ?? null,
      quarterLabel: data.quarterLabel ?? null,
      productName: data.productName ?? null,
      currentUnitPrice: data.currentUnitPrice ?? null,
      targetQty: data.targetQty ?? null,
      targetUnitPrice: data.targetUnitPrice ?? null,
      unitLabel: data.unitLabel ?? null,
      typicalQtyPerQuarter: data.typicalQtyPerQuarter ?? null,
      relationshipNote: data.relationshipNote ?? null,
      tone: data.tone,
      channel: data.channel,
    });
  });
