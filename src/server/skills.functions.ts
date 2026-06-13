/**
 * Skill funnel server functions — v2.19.0 (Phase 1).
 *
 * The gate + the materializer for the Ownership Flywheel's active half
 * (project_skill_funnel). She browses the code catalog (src/lib/skill-catalog.ts),
 * taps a `live` template, and it MATERIALIZES into a routine she OWNS:
 *
 *   listMySkills   — her adopted Skills (the "Your Skills" surface).
 *   adoptSkill     — the gate's "yes": records the lineage (proposal → skill)
 *                    and materializes the engine artifact. Earned-gated.
 *   setSkillEnabled— turn an owned Skill on/off.
 *   removeSkill    — leave it (honest exit; never touches engine artifacts).
 *
 * Lineage recorded honestly: adopt writes an accepted skill_proposals row
 * (source='catalog') then the skills row (source_proposal_id). Phase 2 (mining)
 * inserts PENDING proposals into the same table; Phase 3 (concierge) inserts
 * source='concierge'. One spine, two pluggable axes.
 *
 * Auth: resolveEffectiveUserId (admin viewAs honored) — every fn forwards
 * viewAsUserId, the v2.18.1 export-0 lesson. Service-role writes; manual
 * user_id scoping is the security boundary (RLS is service-role + read-own).
 *
 * Earned-gate: adoptSkill refuses until the spa has its first VERIFIED recovery
 * win (the same signal the wishlist earned-gate + billing scoreboard use) —
 * premature Skills are noise. An admin viewing-as a tenant bypasses the gate
 * (operator context is never blocked).
 *
 * Schema: supabase/migrations/20260728000000_v2_19_0_skill_funnel.sql.
 * NOTE: types.ts has NOT been regenerated for skill_proposals / skills, so
 * those two tables are reached through a loosely-typed view of the client
 * (same posture as wishlist.functions.ts). emma_preshow_profiles IS in types,
 * so the wired-engine writes use the fully-typed client.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import {
  findSkillInCatalog,
  type SkillMaterializer,
} from "@/lib/skill-catalog";

// ─── Public types ───────────────────────────────────────────────────────────

export type AdoptedSkill = {
  id: string;
  templateKey: string;
  name: string;
  materializer: SkillMaterializer;
  enabled: boolean;
  /** Pluggable seam: e.g. { preshowProfileId, manageTo } for the wired routine.
   * JSON-serializable (string values) so it round-trips through the server fn. */
  materializedRef: Record<string, string>;
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

type SupabaseAdmin = ReturnType<typeof admin>;

// types.ts not yet regenerated for the two new tables — loose view of the client.
type LooseResult = { data: unknown; error: { message: string } | null };
interface LooseQuery extends PromiseLike<LooseResult> {
  select(cols?: string): LooseQuery;
  insert(row: Record<string, unknown>): LooseQuery;
  upsert(row: Record<string, unknown>, opts?: Record<string, unknown>): LooseQuery;
  update(vals: Record<string, unknown>): LooseQuery;
  delete(): LooseQuery;
  eq(col: string, val: unknown): LooseQuery;
  order(col: string, opts: { ascending: boolean }): LooseQuery;
  maybeSingle(): Promise<LooseResult>;
  single(): Promise<LooseResult>;
}
interface LooseClient {
  from(table: string): LooseQuery;
}
function loose(sb: SupabaseAdmin): LooseClient {
  return sb as unknown as LooseClient;
}

// ─── Row + hydration ────────────────────────────────────────────────────────

type SkillRow = {
  id: string;
  user_id: string;
  tenant_id: string | null;
  template_key: string;
  name: string;
  materializer: SkillMaterializer;
  config: Record<string, unknown> | null;
  enabled: boolean;
  source_proposal_id: string | null;
  materialized_ref: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

function hydrate(row: SkillRow): AdoptedSkill {
  return {
    id: row.id,
    templateKey: row.template_key,
    name: row.name,
    materializer: row.materializer,
    enabled: row.enabled,
    materializedRef:
      row.materialized_ref && typeof row.materialized_ref === "object"
        ? (row.materialized_ref as Record<string, string>)
        : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Earned-gate (mirrors wishlist.hasReachedValueMoment) ─────────────────────

async function reachedValueMoment(
  sb: SupabaseAdmin,
  userId: string,
): Promise<boolean> {
  const { data, error } = await sb
    .from("emma_recovery_events")
    .select("id")
    .eq("user_id", userId)
    .not("verified_at", "is", null)
    .limit(1);
  if (error) throw new Error(`Couldn't check value moment: ${error.message}`);
  return (data ?? []).length > 0;
}

// ─── Wired engine: ensure a default Pre-Visit Reminder profile exists ─────────
//
// The ONE template wired end-to-end in Phase 1. Adopting it guarantees the spa
// has a default preshow profile (the artifact the Reminders agent dispatches
// from) without ever creating a SECOND default — emma_preshow_profiles enforces
// exactly one default per spa.
async function ensureDefaultPreshowProfile(
  sb: SupabaseAdmin,
  userId: string,
  name: string,
): Promise<string> {
  const { data: existingDefault, error: dErr } = await sb
    .from("emma_preshow_profiles")
    .select("id")
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();
  if (dErr) throw new Error(`Couldn't read reminder profile: ${dErr.message}`);
  if (existingDefault) return existingDefault.id;

  // No default. If the spa has any profile, promote the first; else create one.
  const { data: anyProfile } = await sb
    .from("emma_preshow_profiles")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (anyProfile) {
    await sb
      .from("emma_preshow_profiles")
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq("id", anyProfile.id)
      .eq("user_id", userId);
    return anyProfile.id;
  }

  const { data: created, error: cErr } = await sb
    .from("emma_preshow_profiles")
    .insert({
      user_id: userId,
      name,
      is_default: true,
      cadence_hours: [48, 24, 3],
      tone: "warm",
      channel: "auto",
    })
    .select("id")
    .single();
  if (cErr) throw new Error(`Couldn't set up reminder profile: ${cErr.message}`);
  if (!created) throw new Error("Reminder profile create returned no row.");
  return created.id;
}

// ─── The real engine gate for the wired routines ─────────────────────────────
//
// Both the preshow (Reminders) and rescue (Waitlist Auto-Fill) agents dispatch
// off a boolean on the spa's emma_noshow_policies row (preshow_enabled /
// rescue_enabled — see emma-preshow.functions.ts:321 and emma-rescue.functions.ts:666).
// Mapping a wired Skill's On/Pause to that boolean makes the toggle GENUINELY
// gate the engine, not just flip a cosmetic record flag.
type PolicyGateField = "preshow_enabled" | "rescue_enabled";
const POLICY_GATE: Record<string, PolicyGateField> = {
  pre_visit_reminder: "preshow_enabled",
  waitlist_auto_fill: "rescue_enabled",
};

async function setNoshowPolicyGate(
  sb: SupabaseAdmin,
  userId: string,
  field: PolicyGateField,
  value: boolean,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: existing } = await sb
    .from("emma_noshow_policies")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) {
    const patch: Database["public"]["Tables"]["emma_noshow_policies"]["Update"] = {
      updated_at: nowIso,
    };
    patch[field] = value;
    const { error } = await sb
      .from("emma_noshow_policies")
      .update(patch)
      .eq("user_id", userId);
    if (error) throw new Error(`Couldn't update routine state: ${error.message}`);
  } else {
    const row: Database["public"]["Tables"]["emma_noshow_policies"]["Insert"] = {
      user_id: userId,
    };
    row[field] = value;
    const { error } = await sb.from("emma_noshow_policies").insert(row);
    if (error) throw new Error(`Couldn't set up routine state: ${error.message}`);
  }
}

// ─── Zod validators ───────────────────────────────────────────────────────

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const adoptInput = accessInput.extend({
  templateKey: z.string().min(1).max(80),
});

const skillIdInput = accessInput.extend({
  skillId: z.string().uuid(),
});

const setEnabledInput = skillIdInput.extend({
  enabled: z.boolean(),
});

// ─── listMySkills ───────────────────────────────────────────────────────────

export const listMySkills = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<AdoptedSkill[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await loose(sb)
      .from("skills")
      .select("*")
      .eq("user_id", effectiveUserId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Couldn't load your Skills: ${error.message}`);
    return ((rows as SkillRow[] | null) ?? []).map(hydrate);
  });

// ─── adoptSkill (the gate's "yes") ────────────────────────────────────────────

export const adoptSkill = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => adoptInput.parse(raw))
  .handler(async ({ data }): Promise<AdoptedSkill> => {
    const { effectiveUserId, callerUserId, isViewingAs } =
      await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });

    const tpl = findSkillInCatalog(data.templateKey);
    if (!tpl) throw new Error("That Skill isn't in the catalog.");
    if (tpl.status !== "live") {
      throw new Error(
        `"${tpl.label}" isn't available to add yet — it's coming soon.`,
      );
    }

    const sb = admin();

    // Earned-gate — premature Skills are noise. Operator (admin viewing-as) bypasses.
    if (!isViewingAs) {
      const reached = await reachedValueMoment(sb, effectiveUserId);
      if (!reached) {
        throw new Error(
          "Skills unlock after your first verified win — once SmartSpa has earned its keep.",
        );
      }
    }

    // Materialize the engine artifact + flip the real engine ON.
    //   pre_visit_reminder → ensure a default reminder profile + preshow_enabled
    //   waitlist_auto_fill  → rescue_enabled on the no-show policy
    const materializedRef: Record<string, string> = {};
    if (tpl.key === "pre_visit_reminder") {
      const profileId = await ensureDefaultPreshowProfile(
        sb,
        effectiveUserId,
        tpl.label,
      );
      materializedRef.preshowProfileId = profileId;
    }
    const gateField = POLICY_GATE[tpl.key];
    if (gateField) {
      await setNoshowPolicyGate(sb, effectiveUserId, gateField, true);
    }
    if (tpl.manageTo) materializedRef.manageTo = tpl.manageTo;

    const nowIso = new Date().toISOString();

    // Lineage: an accepted proposal, then the owned skill that points back at it.
    const { data: prop } = await loose(sb)
      .from("skill_proposals")
      .insert({
        user_id: effectiveUserId,
        tenant_id: null,
        template_key: tpl.key,
        source: "catalog",
        headline: tpl.label,
        body: tpl.adoptCopy,
        status: "accepted",
        accepted_at: nowIso,
        created_by: callerUserId,
      })
      .select("id")
      .single();
    const proposalId = (prop as { id: string } | null)?.id ?? null;

    // Idempotent: re-adopting re-enables + refreshes the ref rather than duping.
    const { data: skillRow, error } = await loose(sb)
      .from("skills")
      .upsert(
        {
          user_id: effectiveUserId,
          tenant_id: null,
          template_key: tpl.key,
          name: tpl.label,
          materializer: tpl.materializer,
          config: {},
          enabled: true,
          source_proposal_id: proposalId,
          materialized_ref: materializedRef,
          updated_at: nowIso,
        },
        { onConflict: "user_id,template_key" },
      )
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't add the Skill: ${error.message}`);
    if (!skillRow) throw new Error("Skill adopt returned no row.");
    return hydrate(skillRow as SkillRow);
  });

// ─── setSkillEnabled ──────────────────────────────────────────────────────────

export const setSkillEnabled = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setEnabledInput.parse(raw))
  .handler(async ({ data }): Promise<AdoptedSkill> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: row, error } = await loose(sb)
      .from("skills")
      .update({ enabled: data.enabled, updated_at: new Date().toISOString() })
      .eq("id", data.skillId)
      .eq("user_id", effectiveUserId)
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't update the Skill: ${error.message}`);
    if (!row) throw new Error("Skill not found.");
    const skill = row as SkillRow;
    // Flip the REAL engine gate so On/Pause genuinely starts/stops dispatch.
    const gateField = POLICY_GATE[skill.template_key];
    if (gateField) {
      await setNoshowPolicyGate(sb, effectiveUserId, gateField, data.enabled);
    }
    return hydrate(skill);
  });

// ─── removeSkill (honest exit — never touches engine artifacts) ───────────────

export const removeSkill = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => skillIdInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    // Removing the Skill pointer does NOT delete the underlying routine (e.g.
    // the reminder profile) — leaving is clean and non-destructive by design.
    const { error } = await loose(sb)
      .from("skills")
      .delete()
      .eq("id", data.skillId)
      .eq("user_id", effectiveUserId);
    if (error) throw new Error(`Couldn't remove the Skill: ${error.message}`);
    return { ok: true };
  });
