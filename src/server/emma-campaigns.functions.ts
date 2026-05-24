/**
 * Emma(OS) Promotions Engine — Phase 1 server functions.
 *
 * Spa-owned campaign CRUD over knowledge_nodes (node_type='campaign',
 * context='campaigns'). Every row is scoped by the spa's user_id via the
 * existing knowledge_nodes RLS — reps never see this data.
 *
 * Why knowledge_nodes (not a dedicated `campaigns` table): same reasoning
 * as the v341 manufacturer-promo "promotion" node and the patient node.
 * A campaign is a graph entity Emma already knows how to reason over;
 * attaching it to a separate relational table would duplicate the lookup
 * surface for no gain at Phase 1's scale. Phase 5+ adds relational tables
 * (patient_outreach, book_intents) for the high-volume per-message data.
 *
 * Established 2026-05-15 (Promotions Engine Phase 1).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";
import {
  CAMPAIGN_TEMPLATES,
  getTemplate,
  type CampaignAttachments,
  type CampaignState,
  type CohortQuery,
  type TemplateKind,
} from "@/lib/campaign-templates";
import type {
  ProductKind,
  ProductManufacturer,
} from "@/lib/product-manufacturer-map";
import type { PatientSummary } from "@/lib/patient-csv";

// ─── Public types exported to UI ──────────────────────────────────────────

export type SpaCampaign = {
  id: string;
  /** Slug — unique within the spa, used as lookup_key. */
  slug: string;
  title: string;
  /** Short description rendered on the list view. */
  description: string;
  attachments: CampaignAttachments;
  createdAt: string;
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

// ─── Zod ──────────────────────────────────────────────────────────────────

const templateKindSchema = z.enum([
  "first_time",
  "reactivation",
  "cross_sell",
  "volume_upsell",
  "anniversary",
  "loyalty",
  "birthday",
  "custom",
]);

const createInput = z.object({
  accessToken: z.string().min(1),
  templateKind: templateKindSchema,
  /** Optional override for the title at creation. */
  title: z.string().max(200).optional(),
});

const idInput = z.object({
  accessToken: z.string().min(1),
  campaignId: z.string().uuid(),
});

const updateInput = z.object({
  accessToken: z.string().min(1),
  campaignId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  attachments: z.unknown().optional(),
  state: z.enum(["draft", "live", "closed", "archived"]).optional(),
});

const listInput = z.object({
  accessToken: z.string().min(1),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

type KnowledgeNodeRow = Database["public"]["Tables"]["knowledge_nodes"]["Row"];

function hydrate(row: KnowledgeNodeRow): SpaCampaign {
  const att = (row.attachments as unknown as CampaignAttachments | null) ?? null;
  return {
    id: row.id,
    slug: row.lookup_key ?? "",
    title: row.title,
    description: row.content,
    attachments: att ?? scaffoldFromTemplate("custom"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scaffoldFromTemplate(kind: TemplateKind): CampaignAttachments {
  const template = getTemplate(kind);
  if (!template) {
    throw new Error(`Unknown template kind: ${kind}`);
  }
  // Clone so the const definition is never mutated by a downstream update.
  return JSON.parse(JSON.stringify(template.defaults));
}

/**
 * Build a unique slug within a spa's campaign namespace. Tries
 * <templateKind>-<yyyy-mm>, then appends -2, -3, … on collision.
 */
async function nextSlugForTemplate(
  sb: ReturnType<typeof admin>,
  userId: string,
  kind: TemplateKind,
): Promise<string> {
  const base = `${kind.replace(/_/g, "-")}-${new Date().toISOString().slice(0, 7)}`;
  // Pull existing slugs once; collisions are typically 0-1 so iterating is cheap.
  const { data: existing, error } = await sb
    .from("knowledge_nodes")
    .select("lookup_key")
    .eq("user_id", userId)
    .eq("node_type", "campaign")
    .eq("context", "campaigns");
  if (error) throw new Error(`Couldn't read campaign slugs: ${error.message}`);
  const taken = new Set((existing ?? []).map((r) => r.lookup_key).filter(Boolean));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 999; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Couldn't generate a unique campaign slug — too many collisions.");
}

// ─── createSpaCampaign ────────────────────────────────────────────────────

export const createSpaCampaign = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createInput.parse(input))
  .handler(async ({ data }): Promise<SpaCampaign> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const template = getTemplate(data.templateKind);
    if (!template) throw new Error(`Unknown template: ${data.templateKind}`);

    const attachments = scaffoldFromTemplate(data.templateKind);
    const title = data.title?.trim() || template.title;
    const slug = await nextSlugForTemplate(sb, userId, data.templateKind);
    const description = template.exampleCopy;

    const { data: row, error } = await sb
      .from("knowledge_nodes")
      .insert({
        user_id: userId,
        node_type: "campaign",
        context: "campaigns",
        lookup_key: slug,
        lookup_type: "campaign",
        title,
        content: description,
        attachments: attachments as unknown as Json,
        source: "spa-promo-engine-template",
      })
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't create campaign: ${error.message}`);
    return hydrate(row);
  });

// ─── listSpaCampaigns ─────────────────────────────────────────────────────

export const listSpaCampaigns = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<SpaCampaign[]> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const { data: rows, error } = await sb
      .from("knowledge_nodes")
      .select("*")
      .eq("user_id", userId)
      .eq("node_type", "campaign")
      .eq("context", "campaigns")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(`Couldn't list campaigns: ${error.message}`);
    return (rows ?? []).map(hydrate);
  });

// ─── getSpaCampaignById ───────────────────────────────────────────────────

export const getSpaCampaignById = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => idInput.parse(input))
  .handler(async ({ data }): Promise<SpaCampaign | null> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const { data: row, error } = await sb
      .from("knowledge_nodes")
      .select("*")
      .eq("user_id", userId)
      .eq("id", data.campaignId)
      .eq("node_type", "campaign")
      .eq("context", "campaigns")
      .maybeSingle();
    if (error) throw new Error(`Couldn't load campaign: ${error.message}`);
    return row ? hydrate(row) : null;
  });

// ─── updateSpaCampaign ────────────────────────────────────────────────────

export const updateSpaCampaign = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateInput.parse(input))
  .handler(async ({ data }): Promise<SpaCampaign> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Fetch existing so we can merge attachments rather than overwrite the
    // whole jsonb — phased updates would otherwise lose fields the new UI
    // page doesn't render yet.
    const { data: prior, error: priorErr } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("user_id", userId)
      .eq("id", data.campaignId)
      .eq("node_type", "campaign")
      .maybeSingle();
    if (priorErr) throw new Error(`Couldn't read campaign: ${priorErr.message}`);
    if (!prior) throw new Error("Campaign not found.");

    const priorAttachments =
      (prior.attachments as unknown as CampaignAttachments | null) ??
      scaffoldFromTemplate("custom");
    const merged: CampaignAttachments = {
      ...priorAttachments,
      ...((data.attachments as Partial<CampaignAttachments> | undefined) ?? {}),
    };
    if (data.state) merged.state = data.state as CampaignState;

    const updates: Database["public"]["Tables"]["knowledge_nodes"]["Update"] = {
      attachments: merged as unknown as Json,
      updated_at: new Date().toISOString(),
    };
    if (data.title !== undefined) updates.title = data.title;
    if (data.description !== undefined) updates.content = data.description;

    const { data: row, error } = await sb
      .from("knowledge_nodes")
      .update(updates)
      .eq("id", data.campaignId)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't update campaign: ${error.message}`);
    return hydrate(row);
  });

// ─── archiveSpaCampaign ───────────────────────────────────────────────────
// Soft-delete via attachments.state = 'archived' rather than a row delete —
// preserves the audit trail of campaigns the spa once ran (and the data
// for the future revenue-attribution job in Phase 9).

export const archiveSpaCampaign = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => idInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const { data: prior } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("user_id", userId)
      .eq("id", data.campaignId)
      .eq("node_type", "campaign")
      .maybeSingle();
    const priorAttachments =
      (prior?.attachments as unknown as CampaignAttachments | null) ??
      scaffoldFromTemplate("custom");
    const { error } = await sb
      .from("knowledge_nodes")
      .update({
        attachments: {
          ...priorAttachments,
          state: "archived",
        } as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.campaignId)
      .eq("user_id", userId);
    if (error) throw new Error(`Couldn't archive campaign: ${error.message}`);
    return { ok: true };
  });

// ─── resolveCohort — Phase 2 ──────────────────────────────────────────────

/** Sample patient row returned by the cohort preview (no PII beyond what
 *  the spa already owns; this is spa-side, not cross-tenant). */
export type CohortSamplePatient = {
  id: string;
  displayName: string;
  totalVisits: number;
  lifetimeSpendUsd: number;
  lastVisit: string | null;
  primaryManufacturer: ProductManufacturer | null;
  phone: string | null;
  email: string | null;
};

export type CohortPreview = {
  totalMatched: number;
  /** True when totalMatched > MAX_BLAST_SIZE — composer needs to handle. */
  exceedsBlastCap: boolean;
  /** Up to 10 sample matches, sorted by lifetime spend descending. */
  sample: CohortSamplePatient[];
  /** Regulatory velocity cap (matches roadmap: 500/blast). */
  blastCap: number;
};

/** Regulatory velocity cap — max patients per single blast. Roadmap §4
 *  Phase 2 locked decision. Higher counts must be split across multiple
 *  blasts or otherwise filtered down. */
export const MAX_BLAST_SIZE = 500;

const cohortQuerySchema = z
  .object({
    hasPurchasedKind: z
      .enum([
        "toxin",
        "filler",
        "biostimulator",
        "device",
        "retail",
        "reward",
        "payment",
        "discount",
        "service",
        "note",
      ])
      .optional(),
    notPurchasedKind: z
      .enum([
        "toxin",
        "filler",
        "biostimulator",
        "device",
        "retail",
        "reward",
        "payment",
        "discount",
        "service",
        "note",
      ])
      .optional(),
    primaryManufacturer: z.string().optional(),
    minTotalVisits: z.number().int().min(0).max(1000).optional(),
    minDaysSinceLastVisit: z.number().int().min(0).max(10000).optional(),
    maxDaysSinceLastVisit: z.number().int().min(0).max(10000).optional(),
    minLifetimeSpendUsd: z.number().min(0).max(10_000_000).optional(),
    anniversaryMonth: z.boolean().optional(),
    requireReachable: z.boolean().optional(),
  })
  .strict();

const resolveCohortInput = z.object({
  accessToken: z.string().min(1),
  cohortQuery: cohortQuerySchema,
});

export const resolveCohort = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => resolveCohortInput.parse(input))
  .handler(async ({ data }): Promise<CohortPreview> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    return doResolveCohort(sb, userId, data.cohortQuery as CohortQuery);
  });

export async function doResolveCohort(
  sb: ReturnType<typeof admin>,
  userId: string,
  query: CohortQuery,
): Promise<CohortPreview> {
  // 1) Pull patient-kind affinity sets when the query needs them. One
  //    pass over patient_transactions (filtered to amount_usd > 0) per
  //    required kind, building a Set of patient_node_ids.
  const kindsNeeded = new Set<ProductKind>();
  if (query.hasPurchasedKind) kindsNeeded.add(query.hasPurchasedKind);
  if (query.notPurchasedKind) kindsNeeded.add(query.notPurchasedKind);

  const kindToPatients = new Map<ProductKind, Set<string>>();
  if (kindsNeeded.size > 0) {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: chunk, error } = await sb
        .from("patient_transactions")
        .select("patient_node_id, product_kind")
        .eq("user_id", userId)
        .in("product_kind", Array.from(kindsNeeded))
        .gt("amount_usd", 0)
        .range(from, from + PAGE - 1);
      if (error) {
        throw new Error(`Couldn't load transaction kinds: ${error.message}`);
      }
      if (!chunk || chunk.length === 0) break;
      for (const t of chunk) {
        const k = t.product_kind as ProductKind | null;
        if (!k) continue;
        let set = kindToPatients.get(k);
        if (!set) {
          set = new Set<string>();
          kindToPatients.set(k, set);
        }
        set.add(t.patient_node_id);
      }
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
  }

  // 2) Anniversary filter needs the current calendar month.
  const todayMonth = new Date().getUTCMonth(); // 0-indexed

  // 3) Walk every patient knowledge_node, evaluate the predicate.
  const matched: CohortSamplePatient[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data: chunk, error } = await sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("user_id", userId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Couldn't load patients: ${error.message}`);
    if (!chunk || chunk.length === 0) break;

    for (const row of chunk) {
      const summary =
        (row.attachments as unknown as PatientSummary | null) ?? null;
      if (!summary) continue;
      if (!matchesCohort(row.id, summary, query, kindToPatients, todayMonth)) {
        continue;
      }
      matched.push({
        id: row.id,
        displayName: row.title,
        totalVisits: summary.totalVisits ?? 0,
        lifetimeSpendUsd: summary.lifetimeSpendUsd ?? 0,
        lastVisit: summary.lastVisit ?? null,
        primaryManufacturer: summary.primaryManufacturer ?? null,
        phone: summary.phone ?? null,
        email: summary.email ?? null,
      });
    }
    if (chunk.length < PAGE) break;
    from += PAGE;
  }

  // 4) Sort by lifetime spend desc — that's the order the blast composer
  //    will surface, so the preview should match.
  matched.sort((a, b) => b.lifetimeSpendUsd - a.lifetimeSpendUsd);

  return {
    totalMatched: matched.length,
    exceedsBlastCap: matched.length > MAX_BLAST_SIZE,
    sample: matched.slice(0, 10),
    blastCap: MAX_BLAST_SIZE,
  };
}

function matchesCohort(
  patientId: string,
  summary: PatientSummary,
  query: CohortQuery,
  kindToPatients: Map<ProductKind, Set<string>>,
  todayMonth: number,
): boolean {
  // requireReachable doubles as the banned-filter — banned patients never
  // match a campaign cohort. This is the typed boundary from the spec
  // (Phase 7 compliance cross-cutting): banned excluded from every
  // outbound path, full stop.
  if (summary.banned) return false;
  if (query.requireReachable && !summary.phone && !summary.email) return false;

  // Kind affinity
  if (query.hasPurchasedKind) {
    const set = kindToPatients.get(query.hasPurchasedKind);
    if (!set || !set.has(patientId)) return false;
  }
  if (query.notPurchasedKind) {
    const set = kindToPatients.get(query.notPurchasedKind);
    if (set && set.has(patientId)) return false;
  }

  // Primary manufacturer
  if (query.primaryManufacturer) {
    if (summary.primaryManufacturer !== query.primaryManufacturer) return false;
  }

  // Visit count
  if (query.minTotalVisits !== undefined) {
    if ((summary.totalVisits ?? 0) < query.minTotalVisits) return false;
  }

  // Recency
  const daysSinceLast = summary.lastVisit
    ? daysFromIsoToToday(summary.lastVisit)
    : null;
  if (query.minDaysSinceLastVisit !== undefined) {
    if (daysSinceLast === null || daysSinceLast < query.minDaysSinceLastVisit) {
      return false;
    }
  }
  if (query.maxDaysSinceLastVisit !== undefined) {
    if (daysSinceLast === null || daysSinceLast > query.maxDaysSinceLastVisit) {
      return false;
    }
  }

  // Spend
  if (query.minLifetimeSpendUsd !== undefined) {
    if ((summary.lifetimeSpendUsd ?? 0) < query.minLifetimeSpendUsd) {
      return false;
    }
  }

  // Anniversary — first visit must fall in current calendar month
  if (query.anniversaryMonth) {
    if (!summary.firstVisit) return false;
    const m = Number(summary.firstVisit.split("-")[1]);
    if (!Number.isFinite(m) || m - 1 !== todayMonth) return false;
  }

  return true;
}

function daysFromIsoToToday(iso: string): number | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const then = Date.UTC(y, m - 1, d);
  return Math.floor((Date.now() - then) / 86_400_000);
}

// ─── Re-export the template gallery for the route component ──────────────

export { CAMPAIGN_TEMPLATES };
