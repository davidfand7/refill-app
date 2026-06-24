/**
 * Program Intelligence — server surface for the Phase 2 brain (program-intel.ts).
 *
 * Returns the tenant's normalized manufacturer-program snapshot plus the brain's
 * derived output (moves + detected rule-changes). For now the snapshot is a
 * DATED MANUAL CAPTURE of the real Rejuv ASPIRE dashboard (the 2026-06-11
 * screenshots) — clearly labelled, never implied to be live. The portal pull
 * that fills this automatically and the migration that persists snapshots are
 * separate gated slices; when they land, only `loadSnapshot` changes — the
 * derive + the UI are unaffected.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { admin, type SbClient } from "@/server/admin-client";
import {
  getTenantIdForUser,
  resolveEffectiveUserId,
} from "@/server/auth-helpers";
import {
  deriveRebateMoves,
  diffSnapshots,
  type ProgramSnapshot,
  type RebateMove,
  type FlywheelMove,
  type ProgramChange,
} from "@/lib/program-intel";
import { resolveProduct, type ProductKind } from "@/lib/product-manufacturer-map";

// Anthropic vision lives in program-snapshot-core (server-only); the SDK is
// reached via a *dynamic* import inside the capture handler so it never lands
// in the client bundle. The media-type enum is inlined here (not imported from
// the core) for the same reason — importing the core's value pulls the SDK.

// ── Captured real Rejuv snapshot (ASPIRE / Galderma · 2026-06-11) ───────────
// Source: the Program Details dashboard tabs — Membership Levels, Rise Rebate
// Tracker, Brand Adoption Rebate Tracker, Signature Pricing. This is REAL data,
// captured by hand from the live dashboard; the auto-pull will replace this
// constant with a DB read of the latest pull.
const REJUV_ASPIRE_SNAPSHOT: ProgramSnapshot = {
  manufacturer: "galderma",
  pulledAt: "2026-06-11T00:00:00.000Z",
  currentTier: "Director",
  pointsCurrent: 250,
  pointsToNextTier: 1250, // Executive starts at 1,500
  tiers: [
    { name: "Member", minPoints: 0, maxPoints: 249 },
    { name: "Insider", minPoints: 250, maxPoints: 649 },
    { name: "Director", minPoints: 650, maxPoints: 1499 },
    { name: "Executive", minPoints: 1500, maxPoints: 2999 },
    { name: "President", minPoints: 3000, maxPoints: 5999 },
    { name: "Top 1%", minPoints: 6000, maxPoints: null },
  ],
  rebates: [
    {
      key: "brand_adoption",
      label: "Brand Adoption Rebate",
      rebatePct: 3,
      status: "achieved", // dashboard: "3/3 BRANDS COMPLETED · 3% REBATE ACHIEVED"
      note: "Secured — 3 of 3 Galderma brands purchased at the Director level.",
      requirements: [
        { product: "dysport", label: "Dysport", required: 20, current: 20, unit: "vials" },
        { product: "restylane", label: "Restylane Lyft", required: 10, current: 20, unit: "syringes" },
        { product: "restylane", label: "Restylane Defyne", required: 10, current: 20, unit: "syringes" },
        { product: "restylane", label: "Restylane", required: 10, current: 0, unit: "syringes" },
        { product: "restylane", label: "Restylane Contour", required: 10, current: 0, unit: "syringes" },
        { product: "restylane", label: "Restylane Eyelight", required: 10, current: 0, unit: "syringes" },
        { product: "restylane", label: "Restylane Kysse", required: 10, current: 0, unit: "syringes" },
        { product: "restylane", label: "Restylane Refyne", required: 10, current: 0, unit: "syringes" },
        { product: "restylane", label: "Restylane Silk", required: 10, current: 0, unit: "syringes" },
        { product: "sculptra", label: "Sculptra", required: 8, current: 0, unit: "kits" },
      ],
    },
    {
      key: "rise",
      label: "Rise Rebate",
      rebatePct: 2,
      status: "not_eligible", // dashboard: "$0 invoice in a baseline quarter → not eligible"
      note: "Q4 spend $8,984 · Q1 spend $0 — a $0 baseline quarter makes you ineligible for the Rise rebate this quarter.",
      requirements: [],
    },
  ],
  pricing: [
    { product: "dysport", label: "Dysport 300IU", unitPriceUsd: 561.36 },
    { product: "restylane", label: "Restylane-L 1.0ML", unitPriceUsd: 271.24 },
    { product: "restylane", label: "Restylane Kysse 1.0ML", unitPriceUsd: 335.11 },
    { product: "restylane", label: "Restylane Lyft 1.0ML", unitPriceUsd: 288.59 },
    { product: "restylane", label: "Restylane Contour 1.0ML", unitPriceUsd: 335.11 },
    { product: "sculptra", label: "Sculptra", unitPriceUsd: 780.52 },
  ],
};

/** How the snapshot was obtained — drives the honest freshness label. */
export type SnapshotSource = "manual_capture" | "portal_pull";

export type ProgramIntel = {
  snapshot: ProgramSnapshot;
  /** Moves carry lapsedInCohort — the real count of overdue patients of the
   *  move's treatment kind (the recall flywheel join), or null when uncountable. */
  moves: FlywheelMove[];
  changes: ProgramChange[];
  source: SnapshotSource;
  /** ISO date the snapshot was captured/pulled, for the freshness stamp. */
  capturedOn: string;
  /** true = a real per-tenant snapshot row; false = the seed placeholder (no
   *  capture yet). The UI uses this to show a capture CTA instead of dressing
   *  the seed as the tenant's own standing. */
  captured: boolean;
};

/**
 * Load the latest snapshot for a tenant (+ the prior one of the SAME
 * manufacturer, for the "what changed" diff).
 *
 * v2.164.0 (Slice 1): DB-first. When a real per-tenant snapshot has been
 * captured (program_snapshots), it wins. Until then — and for any tenant with
 * no capture yet — we fall back to the seed constant so the surface never
 * breaks. The fallback is the ONLY thing still serving the hardcoded Rejuv
 * data; it retires the moment real captures land (Slice 2). The read is wrapped
 * defensively so a missing table (pre-migration) or any error degrades to the
 * seed rather than failing the page.
 */
async function loadSnapshot(
  sb: SbClient,
  tenantId: string | null,
): Promise<{
  latest: ProgramSnapshot;
  prev: ProgramSnapshot | null;
  source: SnapshotSource;
  captured: boolean;
}> {
  if (tenantId) {
    try {
      const { data: latestRow } = await sb
        .from("program_snapshots")
        .select("manufacturer, snapshot, pulled_at, source")
        .eq("tenant_id", tenantId)
        .order("pulled_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestRow) {
        const { data: priorRow } = await sb
          .from("program_snapshots")
          .select("snapshot")
          .eq("tenant_id", tenantId)
          .eq("manufacturer", latestRow.manufacturer)
          .lt("pulled_at", latestRow.pulled_at)
          .order("pulled_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return {
          latest: latestRow.snapshot as unknown as ProgramSnapshot,
          prev: (priorRow?.snapshot as unknown as ProgramSnapshot) ?? null,
          source:
            latestRow.source === "portal_pull" ? "portal_pull" : "manual_capture",
          captured: true,
        };
      }
    } catch {
      // Table missing (pre-migration) or read error → seed fallback below.
    }
  }
  return { latest: REJUV_ASPIRE_SNAPSHOT, prev: null, source: "manual_capture", captured: false };
}

/** Treatment kinds we can count an overdue cohort for (the recall engine keys). */
const COUNTABLE_KINDS: ReadonlySet<ProductKind> = new Set([
  "toxin",
  "filler",
  "biostimulator",
]);

/**
 * The recall-flywheel join: for each rebate move ("buy/treat N more Restylane"),
 * attach how many of this spa's patients are OVERDUE for that move's treatment
 * kind — the real cohort the owner could recall to both unlock the rebate AND
 * recover the patient. Reuses doListOverdue (the same source the recall surface
 * reads), so the count can never drift from what the recall list shows. One
 * cohort scan per DISTINCT kind (≤3), not per move. The whole step is best-effort
 * — any failure leaves lapsedInCohort null and the move still renders.
 */
async function enrichMovesWithCohort(
  sb: SbClient,
  userId: string,
  moves: RebateMove[],
): Promise<FlywheelMove[]> {
  if (moves.length === 0) return [];

  const moveKind = new Map<RebateMove, ProductKind | null>();
  const kindsNeeded = new Set<ProductKind>();
  for (const m of moves) {
    const { kind } = resolveProduct(m.product || m.productLabel);
    const k = kind && COUNTABLE_KINDS.has(kind) ? kind : null;
    moveKind.set(m, k);
    if (k) kindsNeeded.add(k);
  }

  const countByKind = new Map<ProductKind, number>();
  if (kindsNeeded.size > 0) {
    try {
      const { doListOverdue } = await import("./patient-ingest.functions");
      for (const k of kindsNeeded) {
        const overdue = await doListOverdue(sb, userId, 10000, k);
        countByKind.set(k, overdue.length);
      }
    } catch {
      // Recall engine unavailable / error → every move keeps lapsedInCohort null.
    }
  }

  return moves.map((m) => {
    const k = moveKind.get(m) ?? null;
    return { ...m, lapsedInCohort: k && countByKind.has(k) ? countByKind.get(k)! : null };
  });
}

const input = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
});

export const getProgramIntelFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => input.parse(raw))
  .handler(async ({ data }): Promise<ProgramIntel> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    // Resolve tenant defensively — a user without a tenant (or any lookup
    // error) just gets the seed fallback rather than a hard failure.
    let tenantId: string | null = null;
    try {
      tenantId = await getTenantIdForUser(sb, effectiveUserId);
    } catch {
      tenantId = null;
    }

    const { latest, prev, source, captured } = await loadSnapshot(sb, tenantId);
    const moves = await enrichMovesWithCohort(sb, effectiveUserId, deriveRebateMoves(latest));
    const changes = prev ? diffSnapshots(prev, latest) : [];
    return {
      snapshot: latest,
      moves,
      changes,
      source,
      capturedOn: latest.pulledAt.slice(0, 10),
      captured,
    };
  });

// ── Capture lane (Slice 2): rewards-dashboard screenshots → snapshot row ──────

const captureInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  /** Owner's manufacturer hint (the dashboard they're capturing), optional. */
  manufacturer: z.string().optional(),
  images: z
    .array(
      z.object({
        data: z.string().min(1),
        mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      }),
    )
    .min(1)
    .max(8),
});

export type CaptureProgramSnapshotResult = {
  ok: true;
  snapshotId: string;
  snapshot: ProgramSnapshot;
};

/**
 * Read one or more rewards-DASHBOARD screenshots and persist the spa's standing
 * as a program_snapshots row. Owner-initiated (manual_capture). The Anthropic
 * SDK is reached via a dynamic import so it never reaches the client bundle.
 */
export const captureProgramSnapshotFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => captureInput.parse(raw))
  .handler(async ({ data }): Promise<CaptureProgramSnapshotResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    if (!tenantId) {
      throw new Error("No spa is linked to your account yet — finish setup first.");
    }

    const { captureProgramSnapshot } = await import("./program-snapshot-core");
    const pulledAt = new Date().toISOString();
    const { snapshotId, snapshot } = await captureProgramSnapshot({
      sb,
      tenantId,
      images: data.images,
      manufacturerHint: data.manufacturer?.trim() || null,
      pulledAt,
    });
    return { ok: true, snapshotId, snapshot };
  });
