/**
 * Refill Manufacturer Profile + AI extraction (v1.34.2.1).
 *
 * Per project_recognition_allocation_engine_spec: each manufacturer
 * (Allergan, Galderma, Merz, …) has a "profile" that describes their
 * loyalty/rebate program structure — tiers, thresholds, units rebated,
 * eligible brands, cooldown rules. The Recognition Allocation engine
 * (queued v1.34.5) reads these profiles to know what reward inventory
 * a spa can earn and how to allocate it.
 *
 * v1.34.2.1 ships:
 *   - CRUD over manufacturer profiles
 *   - AI extraction from pasted text (manufacturer program docs)
 *
 * Storage: knowledge_nodes row with node_type='manufacturer_profile',
 * keyed by lowercased manufacturer name. Tenant-scoped via user_id like
 * every other knowledge_nodes row. v1.34.5 reads these per-tenant; an
 * admin-curated default set can be seeded later.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type ManufacturerTier = {
  name: string;
  thresholdUsd: number;
  unitsRebated: number;
  notes: string | null;
};

export type ManufacturerProgram = {
  name: string;
  period: string;
  tiers: ManufacturerTier[];
  brands: string[];
  cooldownMonths: number | null;
};

export type ManufacturerProfile = {
  manufacturer: string;
  displayName: string;
  programs: ManufacturerProgram[];
  notes: string | null;
  updatedAt: string;
};

// ─── Admin client ─────────────────────────────────────────────────────────

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI extraction not configured — ANTHROPIC_API_KEY missing.",
    );
  }
  return new Anthropic({ apiKey });
}

// ─── Zod validators ───────────────────────────────────────────────────────

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const tierShape = z.object({
  name: z.string().min(1).max(80),
  thresholdUsd: z.number().min(0).max(10_000_000),
  unitsRebated: z.number().int().min(0).max(100_000),
  notes: z.string().max(1000).nullable().optional(),
});

const programShape = z.object({
  name: z.string().min(1).max(200),
  period: z.string().min(1).max(80),
  tiers: z.array(tierShape).min(1).max(20),
  brands: z.array(z.string().min(1).max(120)).max(50),
  cooldownMonths: z.number().int().min(0).max(60).nullable().optional(),
});

const upsertInput = accessInput.extend({
  manufacturer: z.string().min(1).max(120),
  displayName: z.string().min(1).max(160).optional(),
  programs: z.array(programShape).min(1).max(20),
  notes: z.string().max(4000).nullable().optional(),
});

const manufacturerKeyInput = accessInput.extend({
  manufacturer: z.string().min(1).max(120),
});

const aiExtractInput = accessInput.extend({
  text: z.string().min(20).max(40_000),
  hintManufacturer: z.string().min(1).max(120).optional(),
});

// ─── Hydration ────────────────────────────────────────────────────────────

function hydrate(
  attachments: unknown,
  manufacturerKey: string,
  updatedAt: string,
): ManufacturerProfile {
  const a = (attachments ?? {}) as Partial<ManufacturerProfile>;
  return {
    manufacturer: manufacturerKey,
    displayName: a.displayName ?? manufacturerKey,
    programs: (a.programs ?? []).map((p) => ({
      name: p.name,
      period: p.period,
      tiers: (p.tiers ?? []).map((t) => ({
        name: t.name,
        thresholdUsd: t.thresholdUsd,
        unitsRebated: t.unitsRebated,
        notes: t.notes ?? null,
      })),
      brands: p.brands ?? [],
      cooldownMonths: p.cooldownMonths ?? null,
    })),
    notes: a.notes ?? null,
    updatedAt,
  };
}

function manufacturerKey(raw: string): string {
  return raw.toLowerCase().trim();
}

// ─── List ─────────────────────────────────────────────────────────────────

export const listManufacturerProfiles = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<ManufacturerProfile[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await sb
      .from("knowledge_nodes")
      .select("lookup_key, attachments, updated_at, title")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "manufacturer_profile")
      .order("title", { ascending: true });
    if (error) throw new Error(`Couldn't load: ${error.message}`);
    return (rows ?? []).map((r) =>
      hydrate(r.attachments, r.lookup_key ?? r.title ?? "", r.updated_at),
    );
  });

// ─── Get one ──────────────────────────────────────────────────────────────

export const getManufacturerProfile = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => manufacturerKeyInput.parse(raw))
  .handler(async ({ data }): Promise<ManufacturerProfile | null> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const key = manufacturerKey(data.manufacturer);
    const { data: row, error } = await sb
      .from("knowledge_nodes")
      .select("lookup_key, attachments, updated_at, title")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "manufacturer_profile")
      .eq("lookup_key", key)
      .maybeSingle();
    if (error) throw new Error(`Couldn't load: ${error.message}`);
    return row ? hydrate(row.attachments, row.lookup_key ?? key, row.updated_at) : null;
  });

// ─── Upsert ───────────────────────────────────────────────────────────────

export const upsertManufacturerProfile = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => upsertInput.parse(raw))
  .handler(async ({ data }): Promise<ManufacturerProfile> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const key = manufacturerKey(data.manufacturer);
    const displayName = data.displayName ?? data.manufacturer.trim();

    const attachments: ManufacturerProfile = {
      manufacturer: key,
      displayName,
      programs: data.programs.map((p) => ({
        name: p.name,
        period: p.period,
        tiers: p.tiers.map((t) => ({
          name: t.name,
          thresholdUsd: t.thresholdUsd,
          unitsRebated: t.unitsRebated,
          notes: t.notes ?? null,
        })),
        brands: p.brands,
        cooldownMonths: p.cooldownMonths ?? null,
      })),
      notes: data.notes ?? null,
      updatedAt: new Date().toISOString(),
    };

    const { data: existing } = await sb
      .from("knowledge_nodes")
      .select("id")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "manufacturer_profile")
      .eq("lookup_key", key)
      .maybeSingle();

    if (existing) {
      const { error } = await sb
        .from("knowledge_nodes")
        .update({
          title: displayName,
          attachments: attachments as unknown as Json,
          updated_at: attachments.updatedAt,
        })
        .eq("id", existing.id);
      if (error) throw new Error(`Couldn't update: ${error.message}`);
    } else {
      const { error } = await sb.from("knowledge_nodes").insert({
        user_id: effectiveUserId,
        node_type: "manufacturer_profile",
        context: "recognition",
        title: displayName,
        content: data.notes ?? "",
        lookup_key: key,
        lookup_type: "manufacturer_profile",
        attachments: attachments as unknown as Json,
      });
      if (error) throw new Error(`Couldn't create: ${error.message}`);
    }
    return attachments;
  });

// ─── Delete ───────────────────────────────────────────────────────────────

export const deleteManufacturerProfile = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => manufacturerKeyInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const key = manufacturerKey(data.manufacturer);
    const { error } = await sb
      .from("knowledge_nodes")
      .delete()
      .eq("user_id", effectiveUserId)
      .eq("node_type", "manufacturer_profile")
      .eq("lookup_key", key);
    if (error) throw new Error(`Couldn't delete: ${error.message}`);
    return { ok: true };
  });

// ─── AI extract ───────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM = `You extract structured manufacturer-loyalty-program data from aesthetic-medicine industry program documents (Allergan Allē for Business, Galderma ASPIRE Rewards, Merz Aesthetics, Revance, etc.).

The user pastes program-doc text. You return STRICT JSON matching this exact shape (no markdown fences, no commentary):

{
  "manufacturer": "<lowercase manufacturer name, e.g. 'allergan'>",
  "displayName": "<canonical capitalization, e.g. 'Allergan'>",
  "programs": [
    {
      "name": "<program name, e.g. 'Allē for Business 2026'>",
      "period": "<period the tier applies to, e.g. '2026' or 'Q1 2026'>",
      "tiers": [
        {
          "name": "<tier name>",
          "thresholdUsd": <annual spend USD required to reach this tier; integer>,
          "unitsRebated": <units of product the spa gets back at this tier; integer>,
          "notes": "<optional details, otherwise null>"
        }
      ],
      "brands": ["<eligible brand 1>", "<eligible brand 2>"],
      "cooldownMonths": <number of months between rebated-unit grants, or null>
    }
  ],
  "notes": "<optional spa-relevant clarification, otherwise null>"
}

Rules:
- thresholdUsd MUST be an integer (round up if document is approximate).
- unitsRebated MUST be an integer.
- If the document lists multiple tiers per program (Silver / Gold / Diamond), include EVERY tier in tiers[].
- If unsure about a brand list, leave brands empty rather than guess.
- If the document covers multiple program periods (2025 + 2026), output one programs[] entry per period.
- Output ONLY the JSON object. No preamble, no markdown, no trailing notes.`;

export const aiExtractManufacturerProfile = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => aiExtractInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      extracted: z.infer<typeof upsertInput>["programs"];
      manufacturer: string;
      displayName: string;
      notes: string | null;
      raw: string;
    }> => {
      await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const client = getAnthropicClient();
      const hint = data.hintManufacturer
        ? `\n\nHint: the user already chose manufacturer key '${manufacturerKey(data.hintManufacturer)}'. Use that as the manufacturer field.`
        : "";

      try {
        const response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: EXTRACTION_SYSTEM,
          messages: [
            {
              role: "user",
              content: `Extract the loyalty program structure from this document:${hint}\n\n----- DOCUMENT START -----\n${data.text}\n----- DOCUMENT END -----`,
            },
          ],
        });
        const raw = response.content
          .find((b): b is Anthropic.TextBlock => b.type === "text")
          ?.text?.trim();
        if (!raw) throw new Error("AI returned empty response.");

        // Tolerate ```json fences just in case.
        const stripped = raw
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();
        const parsed = JSON.parse(stripped) as {
          manufacturer?: string;
          displayName?: string;
          programs?: z.infer<typeof programShape>[];
          notes?: string | null;
        };
        if (!parsed.programs || parsed.programs.length === 0) {
          throw new Error(
            "AI couldn't find any loyalty programs in the pasted text.",
          );
        }
        const validated = z.array(programShape).parse(parsed.programs);
        return {
          extracted: validated,
          manufacturer: manufacturerKey(
            parsed.manufacturer ?? data.hintManufacturer ?? "unknown",
          ),
          displayName:
            parsed.displayName ??
            data.hintManufacturer ??
            parsed.manufacturer ??
            "Unknown",
          notes: parsed.notes ?? null,
          raw,
        };
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) {
          throw new Error("AI extraction is rate-limited right now — try again in 30s.");
        }
        if (e instanceof Anthropic.AuthenticationError) {
          throw new Error("AI extraction not configured — admin needs to set ANTHROPIC_API_KEY.");
        }
        if (e instanceof SyntaxError) {
          throw new Error("AI returned malformed JSON. Try pasting a cleaner excerpt.");
        }
        throw e;
      }
    },
  );
