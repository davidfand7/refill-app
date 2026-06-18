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
 * (same posture as wishlist.functions.ts). preshow_profiles IS in types,
 * so the wired-engine writes use the fully-typed client.
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import {
  SKILL_CATALOG,
  findSkillInCatalog,
  type SkillMaterializer,
  type SkillSolution,
} from "@/lib/skill-catalog";
import { recordAgentAction } from "@/server/messaging-activity";
import { setAttributionEnabled } from "@/server/refill-attribution-agent.functions";
import { setSpaWeeklyOffersActive } from "@/server/refill-promo-calendar.functions";

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

/** A suggestion: a live, unadopted template surfaced to this spa — either mined
 * from telemetry or hand-authored by an operator (concierge). */
export type SuggestedSkill = {
  templateKey: string;
  label: string;
  solution: SkillSolution;
  /** The reason — the mined signal, or the operator's tailored note. */
  reason: string;
  /** Where it came from (drives the adopt attribution + a small UI marker). */
  source: "mined" | "concierge";
};

// ─── Admin client ─────────────────────────────────────────────────────────

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
    .from("recovery_events")
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
// from) without ever creating a SECOND default — preshow_profiles enforces
// exactly one default per spa.
async function ensureDefaultPreshowProfile(
  sb: SupabaseAdmin,
  userId: string,
  name: string,
): Promise<string> {
  const { data: existingDefault, error: dErr } = await sb
    .from("preshow_profiles")
    .select("id")
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();
  if (dErr) throw new Error(`Couldn't read reminder profile: ${dErr.message}`);
  if (existingDefault) return existingDefault.id;

  // No default. If the spa has any profile, promote the first; else create one.
  const { data: anyProfile } = await sb
    .from("preshow_profiles")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (anyProfile) {
    await sb
      .from("preshow_profiles")
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq("id", anyProfile.id)
      .eq("user_id", userId);
    return anyProfile.id;
  }

  const { data: created, error: cErr } = await sb
    .from("preshow_profiles")
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
// off a boolean on the spa's noshow_policies row (preshow_enabled /
// rescue_enabled — see emma-preshow.functions.ts:321 and emma-rescue.functions.ts:666).
// Mapping a wired Skill's On/Pause to that boolean makes the toggle GENUINELY
// gate the engine, not just flip a cosmetic record flag.
// recall_digest_enabled isn't in the generated types yet (same loose posture as
// the skills tables) — build the patch as a plain record and cast at the call.
type PolicyGateField =
  | "preshow_enabled"
  | "rescue_enabled"
  | "recall_digest_enabled"
  | "rescue_autonomous_enabled"
  | "patient_export_enabled"
  | "reschedule_enabled";
const POLICY_GATE: Record<string, PolicyGateField> = {
  pre_visit_reminder: "preshow_enabled",
  waitlist_auto_fill: "rescue_enabled",
  auto_recall: "recall_digest_enabled",
  autonomous_rescue: "rescue_autonomous_enabled",
  monthly_patient_book_export: "patient_export_enabled",
  reschedule_reminders: "reschedule_enabled",
};

// ─── The autonomy trust rung (Tier-2 Autonomous · Slice 4) ────────────────────
//
// Autonomous Rescue is EARNED, not default: the owner unlocks it after approving
// N held rescue offers — each approval (the one-tap OK in the review queue) is
// logged in the immutable ledger as rescue·held_offer_approved. The held queue
// is the training ground; once she's signed off on the agent's judgment N times,
// she's shown she trusts it. The ledger we built in Slice 1 is the trust meter.
export const AUTONOMY_RUNG_APPROVALS = 3;

async function countHeldOfferApprovals(
  sb: SupabaseAdmin,
  userId: string,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tbl = (sb as unknown as { from(t: string): any }).from("agent_actions");
  const { count } = await tbl
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("agent", "rescue")
    .eq("action", "held_offer_approved");
  return count ?? 0;
}

async function reachedAutonomyRung(
  sb: SupabaseAdmin,
  userId: string,
): Promise<boolean> {
  return (await countHeldOfferApprovals(sb, userId)) >= AUTONOMY_RUNG_APPROVALS;
}

type NoshowUpdate = Database["public"]["Tables"]["noshow_policies"]["Update"];
type NoshowInsert = Database["public"]["Tables"]["noshow_policies"]["Insert"];

async function setNoshowPolicyGate(
  sb: SupabaseAdmin,
  userId: string,
  field: PolicyGateField,
  value: boolean,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: existing } = await sb
    .from("noshow_policies")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) {
    const patch: Record<string, unknown> = { updated_at: nowIso, [field]: value };
    const { error } = await sb
      .from("noshow_policies")
      .update(patch as NoshowUpdate)
      .eq("user_id", userId);
    if (error) throw new Error(`Couldn't update routine state: ${error.message}`);
  } else {
    const row: Record<string, unknown> = { user_id: userId, [field]: value };
    const { error } = await sb
      .from("noshow_policies")
      .insert(row as NoshowInsert);
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
  /** Where the adopt came from — 'catalog' (browse) or 'mined' (a suggestion). */
  source: z.enum(["catalog", "mined", "concierge"]).optional(),
});

const templateKeyInput = accessInput.extend({
  templateKey: z.string().min(1).max(80),
});

const conciergeInput = accessInput.extend({
  templateKey: z.string().min(1).max(80),
  headline: z.string().max(140).nullable().optional(),
  body: z.string().min(1).max(2000),
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
      // Autonomous materializer = a STRICTER, separately-earned rung: the agent
      // only sends on its own once you've approved enough of its held offers.
      if (tpl.materializer === "autonomous") {
        const earned = await reachedAutonomyRung(sb, effectiveUserId);
        if (!earned) {
          const have = await countHeldOfferApprovals(sb, effectiveUserId);
          throw new Error(
            `Autonomous Rescue unlocks after you've approved ${AUTONOMY_RUNG_APPROVALS} held offers — you've approved ${have} so far. Keep reviewing the queue and it'll open up.`,
          );
        }
      }
    }

    // Materialize the engine artifact + flip the real engine ON.
    //   pre_visit_reminder → ensure a default reminder profile + preshow_enabled
    //   waitlist_auto_fill  → rescue_enabled on the no-show policy
    //   autonomous_rescue   → rescue must be ON for autonomy to mean anything,
    //                         then the autonomy flag flips via POLICY_GATE below
    const materializedRef: Record<string, string> = {};
    if (tpl.key === "pre_visit_reminder") {
      const profileId = await ensureDefaultPreshowProfile(
        sb,
        effectiveUserId,
        tpl.label,
      );
      materializedRef.preshowProfileId = profileId;
    }
    if (tpl.key === "autonomous_rescue") {
      // Autonomy rides on rescue — ensure the base agent is on first.
      await setNoshowPolicyGate(sb, effectiveUserId, "rescue_enabled", true);
    }
    const gateField = POLICY_GATE[tpl.key];
    if (gateField) {
      await setNoshowPolicyGate(sb, effectiveUserId, gateField, true);
    }
    // auto_verify_recoveries lives in attribution settings, not noshow_policies
    // (enabled defaults ON, so this is idempotent on a fresh spa; it re-enables a
    // spa that had turned it off). The reconcile cron honors this flag at dispatch.
    if (tpl.key === "auto_verify_recoveries") {
      await setAttributionEnabled(sb, effectiveUserId, true);
    }
    // weekly_offer materializes by AUTHORING (she creates the offer on the
    // manage page). Adopting just ensures her existing weekly offers (if any)
    // are live — a no-op for a spa that hasn't authored one yet.
    if (tpl.key === "weekly_offer") {
      await setSpaWeeklyOffersActive(sb, effectiveUserId, true);
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
        source: data.source ?? "catalog",
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

    // Any prior PENDING proposal for this template (e.g. an operator's concierge
    // suggestion) is now satisfied — mark it accepted so it leaves the queue.
    await loose(sb)
      .from("skill_proposals")
      .update({ status: "accepted", accepted_at: nowIso, updated_at: nowIso })
      .eq("user_id", effectiveUserId)
      .eq("template_key", tpl.key)
      .eq("status", "pending");

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
    // Auto-Verify's gate is the attribution master toggle (separate store).
    if (skill.template_key === "auto_verify_recoveries") {
      await setAttributionEnabled(sb, effectiveUserId, data.enabled);
    }
    // Weekly Offer's gate is is_active on the spa's weekly offers (the offers
    // table, not noshow_policies) — the master switch for recurring offers.
    if (skill.template_key === "weekly_offer") {
      await setSpaWeeklyOffersActive(sb, effectiveUserId, data.enabled);
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

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — MINING (the SOURCE axis): the agent surfaces a catalog template
// from observed telemetry as a 'mined' suggestion. Read-only over signals we
// already log (mirrors emma-intelligence's loadSpaSettingsInput). Rules fire
// ONLY on real gaps, and ONLY for `live` templates (honesty — never suggest a
// "coming soon"). Suggestions are computed live; a dismissal is remembered as
// a dismissed skill_proposals row so we don't nag.
// ═══════════════════════════════════════════════════════════════════════════

type MiningSignals = {
  hasDefaultProfile: boolean;
  rescueEnabled: boolean;
  rescheduleEnabled: boolean;
  upcomingAppts: number;
  waitlistSize: number;
  recentMissedVisits: number;
};

// Mining window for the "recent cancels/no-shows" signal. Fixed (not the
// operator's reschedule_lookback_days) so the count query can run in parallel
// with the policy read — mining only needs to detect a gap, not match the page.
const MINING_MISSED_DAYS = 30;

async function loadMiningSignals(
  sb: SupabaseAdmin,
  userId: string,
): Promise<MiningSignals> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const missedSinceIso = new Date(now - MINING_MISSED_DAYS * 86400000).toISOString();
  // reschedule_enabled isn't in generated types yet → loose-read the policy.
  const [policyRes, apptRes, waitRes, profileRes, missedRes] = await Promise.all([
    loose(sb)
      .from("noshow_policies")
      .select("rescue_enabled, reschedule_enabled")
      .eq("user_id", userId)
      .maybeSingle(),
    sb
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("scheduled_at", nowIso)
      .neq("status", "cancelled"),
    sb
      .from("waitlist")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active"),
    sb
      .from("preshow_profiles")
      .select("id")
      .eq("user_id", userId)
      .eq("is_default", true)
      .maybeSingle(),
    sb
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("scheduled_at", missedSinceIso)
      .in("status", ["cancelled", "no_show"]),
  ]);
  const p = (policyRes.data ?? {}) as Record<string, unknown>;
  return {
    hasDefaultProfile: Boolean(profileRes.data),
    rescueEnabled: (p.rescue_enabled as boolean) ?? false,
    rescheduleEnabled: (p.reschedule_enabled as boolean) ?? false,
    upcomingAppts: apptRes.count ?? 0,
    waitlistSize: waitRes.count ?? 0,
    recentMissedVisits: missedRes.count ?? 0,
  };
}

/** Evaluate the mining rules against real signals → suggested LIVE templates. */
function evaluateMiningRules(sig: MiningSignals): SuggestedSkill[] {
  const out: SuggestedSkill[] = [];

  // Pre-Visit Reminders: upcoming appointments but no reminder cadence set up.
  if (!sig.hasDefaultProfile && sig.upcomingAppts >= 1) {
    const t = findSkillInCatalog("pre_visit_reminder");
    if (t && t.status === "live") {
      const n = sig.upcomingAppts;
      out.push({
        templateKey: t.key,
        label: t.label,
        solution: t.solution,
        reason: `You have ${n} upcoming appointment${n === 1 ? "" : "s"} but no reminder cadence set up yet — Pre-Visit Reminders would cut the no-shows.`,
        source: "mined",
      });
    }
  }

  // Waitlist Auto-Fill: a waitlist is building but rescue isn't on.
  if (!sig.rescueEnabled && sig.waitlistSize >= 3) {
    const t = findSkillInCatalog("waitlist_auto_fill");
    if (t && t.status === "live") {
      const n = sig.waitlistSize;
      out.push({
        templateKey: t.key,
        label: t.label,
        solution: t.solution,
        reason: `${n} patient${n === 1 ? " is" : "s are"} on your waitlist and Waitlist Auto-Fill isn't on yet — a cancellation could become a kept slot.`,
        source: "mined",
      });
    }
  }

  // Reschedule Reminders: recent cancels/no-shows are piling up and aren't
  // being won back. (Complementary to rescue — this brings the SAME patient
  // back; rescue fills the freed slot with someone else.)
  if (!sig.rescheduleEnabled && sig.recentMissedVisits >= 3) {
    const t = findSkillInCatalog("reschedule_reminders");
    if (t && t.status === "live") {
      const n = sig.recentMissedVisits;
      out.push({
        templateKey: t.key,
        label: t.label,
        solution: t.solution,
        reason: `${n} patient${n === 1 ? "" : "s"} cancelled or didn't show in the last ${MINING_MISSED_DAYS} days — Reschedule Reminders would nudge them to rebook.`,
        source: "mined",
      });
    }
  }

  return out;
}

// ─── listSuggestedSkills ──────────────────────────────────────────────────────

export const listSuggestedSkills = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<SuggestedSkill[]> => {
    const { effectiveUserId, isViewingAs } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // Earned-gate — premature suggestions are noise. Operator (view-as) bypasses.
    if (!isViewingAs) {
      const reached = await reachedValueMoment(sb, effectiveUserId);
      if (!reached) return [];
    }

    // Exclude what she's already adopted or has dismissed; gather PENDING
    // proposals (operator-authored concierge suggestions live here).
    const [adoptedRes, dismissedRes, pendingRes, signals] = await Promise.all([
      loose(sb).from("skills").select("template_key").eq("user_id", effectiveUserId),
      loose(sb)
        .from("skill_proposals")
        .select("template_key")
        .eq("user_id", effectiveUserId)
        .eq("status", "dismissed"),
      loose(sb)
        .from("skill_proposals")
        .select("template_key, headline, body, source")
        .eq("user_id", effectiveUserId)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      loadMiningSignals(sb, effectiveUserId),
    ]);
    const excluded = new Set<string>();
    for (const r of (adoptedRes.data as { template_key: string }[] | null) ?? [])
      excluded.add(r.template_key);
    for (const r of (dismissedRes.data as { template_key: string }[] | null) ?? [])
      excluded.add(r.template_key);

    // Merge keyed by template — a tailored persisted proposal (concierge) wins
    // over a generic mined rule for the same template.
    const byKey = new Map<string, SuggestedSkill>();
    type PendingRow = {
      template_key: string;
      headline: string | null;
      body: string | null;
      source: string | null;
    };
    for (const r of (pendingRes.data as PendingRow[] | null) ?? []) {
      const t = findSkillInCatalog(r.template_key);
      if (!t || t.status !== "live") continue; // never surface a non-live template
      if (excluded.has(r.template_key) || byKey.has(r.template_key)) continue;
      byKey.set(r.template_key, {
        templateKey: t.key,
        label: t.label,
        solution: t.solution,
        reason: r.body || r.headline || t.adoptCopy,
        source: r.source === "concierge" ? "concierge" : "mined",
      });
    }
    for (const s of evaluateMiningRules(signals)) {
      if (excluded.has(s.templateKey) || byKey.has(s.templateKey)) continue;
      byKey.set(s.templateKey, s);
    }
    return Array.from(byKey.values());
  });

// ─── dismissSuggestion (remembered so we don't nag) ───────────────────────────

export const dismissSuggestion = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => templateKeyInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId, callerUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const nowIso = new Date().toISOString();
    // Validate the template exists (don't persist junk).
    if (!findSkillInCatalog(data.templateKey)) {
      throw new Error("That Skill isn't in the catalog.");
    }
    const { data: existing } = await loose(sb)
      .from("skill_proposals")
      .select("id")
      .eq("user_id", effectiveUserId)
      .eq("template_key", data.templateKey)
      .eq("status", "pending")
      .maybeSingle();
    const existingId = (existing as { id: string } | null)?.id ?? null;
    if (existingId) {
      const { error } = await loose(sb)
        .from("skill_proposals")
        .update({ status: "dismissed", dismissed_at: nowIso, updated_at: nowIso })
        .eq("id", existingId);
      if (error) throw new Error(`Couldn't dismiss: ${error.message}`);
    } else {
      const { error } = await loose(sb)
        .from("skill_proposals")
        .insert({
          user_id: effectiveUserId,
          tenant_id: null,
          template_key: data.templateKey,
          source: "mined",
          status: "dismissed",
          dismissed_at: nowIso,
          created_by: callerUserId,
        });
      if (error) throw new Error(`Couldn't dismiss: ${error.message}`);
    }
    return { ok: true };
  });

// ─── createConciergeProposal (operator-authored, source='concierge') ──────────
//
// Concierge = a setting, not a separate track (project_trusted_onboarding). An
// operator viewing a spa as operator (persona switcher → viewAsUserId) can
// hand-author a tailored suggestion that lands in THAT spa's "Suggested for you"
// queue on the exact same rails she'd see a mined one. Only LIVE templates are
// suggestable (honesty), and only when genuinely operating-as a tenant — a
// non-admin can't reach this (resolveEffectiveUserId enforces admin for viewAs).

export const createConciergeProposal = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => conciergeInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId, callerUserId, isViewingAs } =
      await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
    if (!isViewingAs) {
      throw new Error(
        "Concierge authoring is operator-only — open the spa via the persona switcher first.",
      );
    }
    const tpl = findSkillInCatalog(data.templateKey);
    if (!tpl) throw new Error("That Skill isn't in the catalog.");
    if (tpl.status !== "live") {
      throw new Error(`"${tpl.label}" isn't live yet, so it can't be suggested.`);
    }

    const sb = admin();
    // Don't suggest something the spa already owns.
    const { data: existingSkill } = await loose(sb)
      .from("skills")
      .select("id")
      .eq("user_id", effectiveUserId)
      .eq("template_key", tpl.key)
      .maybeSingle();
    if ((existingSkill as { id: string } | null)?.id) {
      throw new Error("This spa already has that Skill active.");
    }

    const nowIso = new Date().toISOString();
    const headline = data.headline?.trim() || null;
    const body = data.body.trim();

    // Refresh an existing pending proposal for this template, else insert one.
    const { data: existingPending } = await loose(sb)
      .from("skill_proposals")
      .select("id")
      .eq("user_id", effectiveUserId)
      .eq("template_key", tpl.key)
      .eq("status", "pending")
      .maybeSingle();
    const pendingId = (existingPending as { id: string } | null)?.id ?? null;

    if (pendingId) {
      const { error } = await loose(sb)
        .from("skill_proposals")
        .update({
          source: "concierge",
          headline,
          body,
          created_by: callerUserId,
          updated_at: nowIso,
        })
        .eq("id", pendingId);
      if (error) throw new Error(`Couldn't author suggestion: ${error.message}`);
    } else {
      const { error } = await loose(sb)
        .from("skill_proposals")
        .insert({
          user_id: effectiveUserId,
          tenant_id: null,
          template_key: tpl.key,
          source: "concierge",
          headline,
          body,
          status: "pending",
          created_by: callerUserId,
        });
      if (error) throw new Error(`Couldn't author suggestion: ${error.message}`);
    }
    return { ok: true };
  });

// ─── Sending kill switch (Tier-2 Autonomous · Slice 3) ────────────────────────
//
// The unified one-tap "pause all sending." A single flag on noshow_policies
// that every dispatching agent polls (rescue / preshow / recall-digest) and
// bails on. NOT earned-gated — a safety control must always be reachable, even
// for a spa that hasn't unlocked Skills yet. Admin viewing-as is honored so an
// operator can pause on a spa's behalf.

export type SendingPauseState = {
  paused: boolean;
  pausedAt: string | null;
};

export const getSendingPaused = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<SendingPauseState> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: row, error } = await loose(sb)
      .from("noshow_policies")
      .select("sending_paused, sending_paused_at")
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    if (error) throw new Error(`Couldn't read sending status: ${error.message}`);
    const r = (row ?? null) as {
      sending_paused?: boolean;
      sending_paused_at?: string | null;
    } | null;
    return {
      paused: r?.sending_paused === true,
      pausedAt: r?.sending_paused_at ?? null,
    };
  });

const pauseInput = accessInput.extend({ paused: z.boolean() });

export const setSendingPaused = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => pauseInput.parse(raw))
  .handler(async ({ data }): Promise<SendingPauseState> => {
    const { effectiveUserId, callerUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const nowIso = new Date().toISOString();

    // Upsert the flag onto the spa's policy row (create the row if a brand-new
    // spa flips it before any engine has written one).
    const { data: existing } = await loose(sb)
      .from("noshow_policies")
      .select("id")
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    const patch: Record<string, unknown> = {
      sending_paused: data.paused,
      sending_paused_at: data.paused ? nowIso : null,
      sending_paused_by: data.paused ? callerUserId : null,
      updated_at: nowIso,
    };
    if (existing) {
      const { error } = await loose(sb)
        .from("noshow_policies")
        .update(patch)
        .eq("user_id", effectiveUserId);
      if (error)
        throw new Error(`Couldn't update sending status: ${error.message}`);
    } else {
      const { error } = await loose(sb)
        .from("noshow_policies")
        .insert({ user_id: effectiveUserId, ...patch });
      if (error)
        throw new Error(`Couldn't set sending status: ${error.message}`);
    }

    // Audit the flip in the immutable ledger — the kill switch is a thing
    // someone did on the spa's behalf, so it belongs in the same history as the
    // sends it governs. Best-effort (never throws).
    await recordAgentAction(sb, effectiveUserId, {
      agent: "kill_switch",
      action: data.paused ? "sending_paused" : "sending_resumed",
      initiatedBy: "owner",
      metadata: { via: "skills_page", by_user: callerUserId },
    });

    return {
      paused: data.paused,
      pausedAt: data.paused ? nowIso : null,
    };
  });

// ─── Autonomy rung progress (Tier-2 Autonomous · Slice 4) ─────────────────────
//
// Feeds the "Autonomous Rescue" catalog card: how many held offers the owner has
// approved vs. the N she needs to unlock the Skill. An operator viewing-as is
// always treated as earned (operator context is never gated).

export type AutonomyRung = {
  approved: number;
  required: number;
  earned: boolean;
};

export const getAutonomyRung = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<AutonomyRung> => {
    const { effectiveUserId, isViewingAs } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const approved = await countHeldOfferApprovals(sb, effectiveUserId);
    return {
      approved,
      required: AUTONOMY_RUNG_APPROVALS,
      earned: isViewingAs || approved >= AUTONOMY_RUNG_APPROVALS,
    };
  });
