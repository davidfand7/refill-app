/**
 * Program-snapshot core — SERVER-ONLY (v2.165.0, Slice 2 of the capture loop).
 *
 * The vision engine for the rewards-DASHBOARD lane. Where portal-import-core
 * reads a PRICE LIST (what each product costs), this reads the spa's STANDING
 * in a manufacturer rewards program — current tier, points, progress to next,
 * live rebate trackers, signature pricing — and shapes it into a ProgramSnapshot
 * (lib/program-intel.ts), then writes a `program_snapshots` row. The moment a
 * real capture lands, loadSnapshot (program-intel.functions.ts) reads it instead
 * of the hardcoded seed — Incentives/Program auto-upgrade off real data.
 *
 * Same isolation contract as portal-import-core: the @anthropic-ai/sdk import
 * (which pulls node:crypto/fs) must never reach the browser. The createServerFn
 * wrapper reaches this via a *dynamic* import inside its handler. Nothing here
 * is client-safe.
 *
 * See project_platform_island_audit (the capture→intelligence loop) +
 * project_vision_portal_import / project_vision_ingestion_moat.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { admin } from "./admin-client";
import { IMAGE_MEDIA, type ImageMedia } from "./portal-import-core";
import type { ProgramSnapshot } from "@/lib/program-intel";
import type { Json } from "@/integrations/supabase/types";

export { IMAGE_MEDIA, type ImageMedia };

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Snapshot capture not configured — ANTHROPIC_API_KEY missing.");
  }
  return new Anthropic({ apiKey });
}

// ─── Vision extraction schema (mirrors lib/program-intel ProgramSnapshot) ─────

const tierSchema = z.object({
  name: z.string().min(1),
  minPoints: z.number(),
  maxPoints: z.number().nullable().default(null),
});

const requirementSchema = z.object({
  product: z.string().min(1),
  label: z.string().min(1),
  required: z.number().nonnegative(),
  current: z.number().nonnegative(),
  unit: z.enum(["syringes", "vials", "kits", "units", "usd"]).default("units"),
});

const rebateSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  rebatePct: z.number().nullable().default(null),
  status: z.enum(["achieved", "in_progress", "not_eligible"]).default("in_progress"),
  note: z.string().nullable().default(null),
  requirements: z.array(requirementSchema).default([]),
});

const priceSchema = z.object({
  product: z.string().min(1),
  label: z.string().min(1),
  unitPriceUsd: z.number().nonnegative(),
});

/** Everything the model reads off the dashboard — `pulledAt` is stamped by us
 *  (the capture moment, honest freshness), `manufacturer` is hint-or-read. */
const snapshotSchema = z.object({
  manufacturer: z.string().nullable().default(null),
  currentTier: z.string().nullable().default(null),
  pointsCurrent: z.number().nullable().default(null),
  pointsToNextTier: z.number().nullable().default(null),
  tiers: z.array(tierSchema).default([]),
  rebates: z.array(rebateSchema).default([]),
  pricing: z.array(priceSchema).default([]),
});

const EXTRACTION_SYSTEM = `You read aesthetic-manufacturer practice-REWARDS dashboard screenshots (Galderma ASPIRE, Allergan/AbbVie Allē for Business, Evolus Rewards, Merz, etc.) and extract the spa's STANDING in the program — NOT a price list. You are reading the loyalty/rewards dashboard: membership level, points, rebate trackers, and any signature pricing shown.

Return ONLY a JSON object with this exact shape:
{
  "manufacturer": string|null,
  "currentTier": string|null,
  "pointsCurrent": number|null,
  "pointsToNextTier": number|null,
  "tiers": [{ "name": string, "minPoints": number, "maxPoints": number|null }],
  "rebates": [{ "key": string, "label": string, "rebatePct": number|null, "status": "achieved"|"in_progress"|"not_eligible", "note": string|null, "requirements": [{ "product": string, "label": string, "required": number, "current": number, "unit": "syringes"|"vials"|"kits"|"units"|"usd" }] }],
  "pricing": [{ "product": string, "label": string, "unitPriceUsd": number }]
}

Rules:
- manufacturer: lowercase key if identifiable (galderma, abbvie, evolus, merz, revance), else null.
- currentTier: the membership level the spa is CURRENTLY at (e.g. "Director"), as printed, else null.
- pointsCurrent: the spa's current points balance, else null. pointsToNextTier: points still needed to reach the next level, else null. Plain numbers, no commas.
- tiers: every membership level shown on the levels/tiers panel, with its entry points (minPoints) and ceiling (maxPoints; null for an open-ended top level like "Top 1% — 6,000+"). If no tier ladder is visible, return [].
- rebates: one entry per rebate tracker shown (Brand Adoption, Rise, etc.).
  - key: a short stable lowercase snake_case id derived from the label ("brand_adoption", "rise"), so the same rebate matches across pulls.
  - rebatePct: the rebate percentage as a plain number (3 for "3%"), else null.
  - status: "achieved" if the tracker shows it secured/completed; "not_eligible" if a structural disqualifier is shown (e.g. a $0 baseline quarter); else "in_progress".
  - note: any caveat or status line shown verbatim-ish (e.g. "3 of 3 brands purchased", "$0 invoice in a baseline quarter → not eligible"), else null.
  - requirements: each product line in that tracker with its required vs current count. product = a normalized lowercase keyword for matching ("restylane", "dysport", "sculptra", "botox", "juvederm"); label = the product as printed ("Restylane Refyne"); required/current = the counts shown; unit = the unit shown (syringes/vials/kits/units/usd).
- pricing: signature/your-price rows if a pricing panel is shown. product = normalized lowercase keyword; label = as printed; unitPriceUsd = the per-unit price as a plain number. If no pricing panel is visible, return [].
- Read ONLY what is on screen. Do NOT invent thresholds, tiers, or prices. If a section isn't shown, return an empty array / null for it — a partial dashboard is fine.
- Output ONLY the JSON object — no markdown, no commentary.`;

/** Run Claude vision over rewards-dashboard screenshots → a ProgramSnapshot
 *  (minus pulledAt, which the caller stamps with the capture moment). */
export async function extractProgramSnapshot(
  images: Array<{ data: string; mediaType: ImageMedia }>,
  manufacturerHint?: string | null,
): Promise<{ snapshot: Omit<ProgramSnapshot, "pulledAt">; raw: string }> {
  const client = getAnthropicClient();
  const hint = manufacturerHint
    ? `\n\nHint: the owner says this is the '${manufacturerHint}' rewards dashboard. Use that for the manufacturer field unless the screenshot clearly says otherwise.`
    : "";

  const imageBlocks = images.map((img) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
  }));

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: EXTRACTION_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: `Extract the spa's standing from this manufacturer rewards dashboard screenshot.${hint}`,
            },
          ],
        },
      ],
    });

    const text = response.content
      .find((b): b is Anthropic.TextBlock => b.type === "text")
      ?.text?.trim();
    if (!text) throw new Error("Vision returned an empty response — try a clearer screenshot.");

    const stripped = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let raw: unknown;
    try {
      raw = JSON.parse(stripped);
    } catch {
      throw new Error("Couldn't read the dashboard from that image — try a sharper, fuller screenshot.");
    }

    const parsed = snapshotSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Couldn't make sense of that dashboard — try a screenshot that shows your tier and rewards.");
    }
    const s = parsed.data;
    // A capture with nothing usable on it isn't worth a row.
    if (!s.currentTier && s.tiers.length === 0 && s.rebates.length === 0 && s.pricing.length === 0) {
      throw new Error("No rewards data found in that screenshot — capture the program/rewards dashboard page.");
    }

    const manufacturer =
      (manufacturerHint && manufacturerHint.toLowerCase().trim()) ||
      (s.manufacturer ? s.manufacturer.toLowerCase().trim() : "") ||
      "unknown";

    return {
      snapshot: {
        manufacturer,
        currentTier: s.currentTier,
        pointsCurrent: s.pointsCurrent,
        pointsToNextTier: s.pointsToNextTier,
        tiers: s.tiers,
        rebates: s.rebates,
        pricing: s.pricing,
      },
      raw: stripped,
    };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new Error("Vision is rate-limited right now — try again in 30s.");
    }
    if (e instanceof Anthropic.AuthenticationError) {
      throw new Error("Snapshot capture isn't configured (auth) — ping support.");
    }
    throw e instanceof Error ? e : new Error("Vision extraction failed.");
  }
}

/** Full capture: extract from screenshots → stamp the capture moment → write a
 *  program_snapshots row. Returns the snapshot we wrote (for an immediate UI
 *  readout). source is 'manual_capture' — an owner-initiated screenshot is NOT
 *  an automated live pull, and we never imply it is (connection-health honesty).
 */
export async function captureProgramSnapshot(args: {
  sb: ReturnType<typeof admin>;
  tenantId: string;
  images: Array<{ data: string; mediaType: ImageMedia }>;
  manufacturerHint?: string | null;
  /** Capture instant as ISO — passed in so the row's pulled_at and the
   *  snapshot's pulledAt agree exactly. */
  pulledAt: string;
}): Promise<{ snapshotId: string; snapshot: ProgramSnapshot }> {
  const { sb, tenantId, images, manufacturerHint, pulledAt } = args;

  const { snapshot: partial } = await extractProgramSnapshot(images, manufacturerHint);
  const snapshot: ProgramSnapshot = { ...partial, pulledAt };

  const { data: row, error } = await sb
    .from("program_snapshots")
    .insert({
      tenant_id: tenantId,
      manufacturer: snapshot.manufacturer,
      snapshot: snapshot as unknown as Json,
      source: "manual_capture",
      pulled_at: pulledAt,
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`Couldn't save the snapshot: ${error.message}`);
  }
  return { snapshotId: row.id, snapshot };
}
