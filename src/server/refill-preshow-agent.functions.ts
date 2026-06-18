/**
 * Refill Preshow Agent — profile CRUD + template CRUD + agent_defaults
 * read/write (v1.34.3).
 *
 * Per the 2026-06-02 architecture lock:
 *   - Profiles are per-spa cadence configurations. Each spa has at least
 *     one "Default" (the row with is_default=true). Karen names them.
 *   - Templates are per-profile × per-offset_hours custom SMS bodies.
 *     Missing template → fall back to code-composed in
 *     emma-preshow.functions.ts composePreShowSmsBody.
 *   - agent_defaults is admin-only global defaults; service-role writes
 *     gated by user_roles.role='admin' check.
 *
 * Auth pattern matches refill-recognition.functions.ts: verifyAuth →
 * resolveEffectiveUserId (admin viewAs honored). Admin-only fns use
 * verifyAuth + role check directly.
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { requireAdmin, resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type PreshowTone = "warm" | "professional" | "casual";
export type PreshowChannel = "sms" | "email" | "auto";

export type PreshowProfile = {
  id: string;
  name: string;
  isDefault: boolean;
  cadenceHours: number[];
  cadenceByTreatmentType: Record<string, number[]>;
  tone: PreshowTone;
  channel: PreshowChannel;
  createdAt: string;
  updatedAt: string;
};

export type PreshowMessageTemplate = {
  id: string;
  profileId: string;
  offsetHours: number;
  bodyTemplate: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentKind = "preshow" | "rescue" | "attribution" | "recognition";

export type AgentDefaults = {
  agentKind: AgentKind;
  defaults: Record<string, unknown>;
  updatedAt: string;
};

/** Performance counters for one profile over a rolling window. */
export type PreshowProfileMetrics = {
  profileId: string;
  windowDays: number;
  sent: number;
  confirmed: number;
  cancelledAfterReminder: number;
};

// ─── Admin client ─────────────────────────────────────────────────────────

type SupabaseAdmin = ReturnType<typeof admin>;
type ProfileRow = Database["public"]["Tables"]["preshow_profiles"]["Row"];
type TemplateRow = Database["public"]["Tables"]["preshow_message_templates"]["Row"];
type DefaultsRow = Database["public"]["Tables"]["agent_defaults"]["Row"];

// ─── Zod validators ───────────────────────────────────────────────────────

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const profileIdInput = accessInput.extend({
  profileId: z.string().uuid(),
});

const createProfileInput = accessInput.extend({
  name: z.string().min(1).max(80),
  /** Optional clone-from existing profile id; copies cadence + templates. */
  cloneFromProfileId: z.string().uuid().optional(),
});

const updateProfileInput = profileIdInput.extend({
  name: z.string().min(1).max(80).optional(),
  cadenceHours: z.array(z.number().int().min(0).max(8760)).max(20).optional(),
  // v1.34.4: per-treatment-type cadence overrides. Map of normalized
  // treatment-type string → cadence_hours array. Set entry to empty
  // array to remove (avoids sending {} to clear a single key).
  cadenceByTreatmentType: z
    .record(z.string(), z.array(z.number().int().min(0).max(8760)).max(20))
    .optional(),
  tone: z.enum(["warm", "professional", "casual"]).optional(),
  channel: z.enum(["sms", "email", "auto"]).optional(),
});

const upsertTemplateInput = accessInput.extend({
  profileId: z.string().uuid(),
  offsetHours: z.number().int().min(0).max(8760),
  bodyTemplate: z.string().min(1).max(1600),
});

const deleteTemplateInput = accessInput.extend({
  templateId: z.string().uuid(),
});

const agentKindInput = z.object({
  accessToken: z.string().min(1),
  agentKind: z.enum(["preshow", "rescue", "attribution", "recognition"]),
});

const updateDefaultsInput = agentKindInput.extend({
  defaults: z.record(z.string(), z.unknown()),
});

const metricsInput = accessInput.extend({
  windowDays: z.number().int().min(1).max(365).default(7).optional(),
});

// ─── Hydration ────────────────────────────────────────────────────────────

function hydrateProfile(row: ProfileRow): PreshowProfile {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    cadenceHours: (row.cadence_hours ?? []) as number[],
    cadenceByTreatmentType: (row.cadence_by_treatment_type as Record<string, number[]>) ?? {},
    tone: (row.tone ?? "warm") as PreshowTone,
    channel: (row.channel ?? "auto") as PreshowChannel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateTemplate(row: TemplateRow): PreshowMessageTemplate {
  return {
    id: row.id,
    profileId: row.profile_id,
    offsetHours: row.offset_hours,
    bodyTemplate: row.body_template,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateDefaults(row: DefaultsRow): AgentDefaults {
  return {
    agentKind: row.agent_kind as AgentKind,
    defaults: (row.defaults as Record<string, unknown>) ?? {},
    updatedAt: row.updated_at,
  };
}

// ─── listPreshowProfiles ──────────────────────────────────────────────────

export const listPreshowProfiles = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<PreshowProfile[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await sb
      .from("preshow_profiles")
      .select("*")
      .eq("user_id", effectiveUserId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Couldn't load profiles: ${error.message}`);
    return (rows ?? []).map(hydrateProfile);
  });

// ─── listPreshowTemplates ─────────────────────────────────────────────────

export const listPreshowTemplates = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<PreshowMessageTemplate[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await sb
      .from("preshow_message_templates")
      .select("*")
      .eq("user_id", effectiveUserId)
      .order("profile_id", { ascending: true })
      .order("offset_hours", { ascending: false });
    if (error) throw new Error(`Couldn't load templates: ${error.message}`);
    return (rows ?? []).map(hydrateTemplate);
  });

// ─── createPreshowProfile ─────────────────────────────────────────────────

export const createPreshowProfile = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createProfileInput.parse(raw))
  .handler(async ({ data }): Promise<PreshowProfile> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    let cadenceHours: number[] = [48, 24, 3];
    let tone: PreshowTone = "warm";
    let channel: PreshowChannel = "auto";
    let templatesToCopy: TemplateRow[] = [];

    if (data.cloneFromProfileId) {
      const { data: src, error: srcErr } = await sb
        .from("preshow_profiles")
        .select("*")
        .eq("id", data.cloneFromProfileId)
        .eq("user_id", effectiveUserId)
        .maybeSingle();
      if (srcErr) throw new Error(`Couldn't load source profile: ${srcErr.message}`);
      if (src) {
        cadenceHours = (src.cadence_hours ?? cadenceHours) as number[];
        tone = (src.tone ?? tone) as PreshowTone;
        channel = (src.channel ?? channel) as PreshowChannel;
        const { data: tmpls } = await sb
          .from("preshow_message_templates")
          .select("*")
          .eq("profile_id", data.cloneFromProfileId)
          .eq("user_id", effectiveUserId);
        templatesToCopy = tmpls ?? [];
      }
    }

    const { data: row, error } = await sb
      .from("preshow_profiles")
      .insert({
        user_id: effectiveUserId,
        name: data.name.trim(),
        is_default: false,
        cadence_hours: cadenceHours,
        tone,
        channel,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't create profile: ${error.message}`);

    if (templatesToCopy.length > 0) {
      const inserts = templatesToCopy.map((t) => ({
        user_id: effectiveUserId,
        profile_id: row.id,
        offset_hours: t.offset_hours,
        body_template: t.body_template,
      }));
      const { error: tErr } = await sb
        .from("preshow_message_templates")
        .insert(inserts);
      if (tErr) {
        // Best-effort clone — log but don't fail the profile create.
        console.warn(`Profile cloned but templates failed: ${tErr.message}`);
      }
    }

    return hydrateProfile(row);
  });

// ─── updatePreshowProfile ─────────────────────────────────────────────────

export const updatePreshowProfile = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateProfileInput.parse(raw))
  .handler(async ({ data }): Promise<PreshowProfile> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const updates: Database["public"]["Tables"]["preshow_profiles"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (data.name !== undefined) updates.name = data.name.trim();
    if (data.cadenceHours !== undefined) updates.cadence_hours = data.cadenceHours;
    if (data.cadenceByTreatmentType !== undefined) {
      // Drop empty arrays — treat them as remove-this-treatment-override.
      const filtered: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(data.cadenceByTreatmentType)) {
        if (v.length > 0) filtered[k] = v;
      }
      updates.cadence_by_treatment_type = filtered;
    }
    if (data.tone !== undefined) updates.tone = data.tone;
    if (data.channel !== undefined) updates.channel = data.channel;

    const { data: row, error } = await sb
      .from("preshow_profiles")
      .update(updates)
      .eq("id", data.profileId)
      .eq("user_id", effectiveUserId)
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't update profile: ${error.message}`);
    return hydrateProfile(row);
  });

// ─── setDefaultPreshowProfile ─────────────────────────────────────────────

/**
 * Atomic-ish flip: set NEW profile to is_default=true; clear is_default
 * on any other profile for this spa. Two-step (no DB transactions via
 * Supabase SDK) but the partial unique index `(user_id) where is_default
 * = true` will reject if both rows ever say true concurrently — worst
 * case the client retries.
 */
export const setDefaultPreshowProfile = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => profileIdInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // 1. Clear is_default on every other profile for this spa.
    const { error: clearErr } = await sb
      .from("preshow_profiles")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("user_id", effectiveUserId)
      .neq("id", data.profileId);
    if (clearErr)
      throw new Error(`Couldn't clear prior defaults: ${clearErr.message}`);

    // 2. Set the target profile to default.
    const { error: setErr } = await sb
      .from("preshow_profiles")
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq("id", data.profileId)
      .eq("user_id", effectiveUserId);
    if (setErr) throw new Error(`Couldn't set default: ${setErr.message}`);

    return { ok: true };
  });

// ─── deletePreshowProfile ─────────────────────────────────────────────────

export const deletePreshowProfile = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => profileIdInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // Refuse to delete the default profile — Karen must set another as
    // default first. The cron + dispatch fallback path needs a default.
    const { data: target, error: loadErr } = await sb
      .from("preshow_profiles")
      .select("is_default")
      .eq("id", data.profileId)
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    if (loadErr) throw new Error(`Couldn't load profile: ${loadErr.message}`);
    if (!target) throw new Error("Profile not found.");
    if (target.is_default) {
      throw new Error(
        "Can't delete the default profile — set another profile as default first.",
      );
    }

    const { error } = await sb
      .from("preshow_profiles")
      .delete()
      .eq("id", data.profileId)
      .eq("user_id", effectiveUserId);
    if (error) throw new Error(`Couldn't delete profile: ${error.message}`);
    return { ok: true };
  });

// ─── upsertPreshowMessageTemplate ─────────────────────────────────────────

export const upsertPreshowMessageTemplate = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => upsertTemplateInput.parse(raw))
  .handler(async ({ data }): Promise<PreshowMessageTemplate> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: row, error } = await sb
      .from("preshow_message_templates")
      .upsert(
        {
          user_id: effectiveUserId,
          profile_id: data.profileId,
          offset_hours: data.offsetHours,
          body_template: data.bodyTemplate,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "profile_id,offset_hours" },
      )
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't save template: ${error.message}`);
    return hydrateTemplate(row);
  });

// ─── deletePreshowMessageTemplate ─────────────────────────────────────────

export const deletePreshowMessageTemplate = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteTemplateInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { error } = await sb
      .from("preshow_message_templates")
      .delete()
      .eq("id", data.templateId)
      .eq("user_id", effectiveUserId);
    if (error) throw new Error(`Couldn't delete template: ${error.message}`);
    return { ok: true };
  });

// ─── getAgentDefaults (admin-only read) ───────────────────────────────────

export const getAgentDefaults = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => agentKindInput.parse(raw))
  .handler(async ({ data }): Promise<AgentDefaults | null> => {
    await requireAdmin(data.accessToken);
    const sb = admin();
    const { data: row, error } = await sb
      .from("agent_defaults")
      .select("*")
      .eq("agent_kind", data.agentKind)
      .maybeSingle();
    if (error) throw new Error(`Couldn't load defaults: ${error.message}`);
    return row ? hydrateDefaults(row) : null;
  });

// ─── updateAgentDefaults (admin-only write) ───────────────────────────────

export const updateAgentDefaults = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateDefaultsInput.parse(raw))
  .handler(async ({ data }): Promise<AgentDefaults> => {
    const callerUserId = await requireAdmin(data.accessToken);
    const sb = admin();
    const { data: row, error } = await sb
      .from("agent_defaults")
      .upsert(
        {
          agent_kind: data.agentKind,
          defaults: data.defaults,
          updated_by: callerUserId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "agent_kind" },
      )
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't save defaults: ${error.message}`);
    return hydrateDefaults(row);
  });

// ─── getPreshowPerformanceMetrics ─────────────────────────────────────────

/**
 * Per-profile counters over a rolling window. v1.34.3 MVP: send count +
 * confirm count + cancel-after-reminder count. Sparkline / before-vs-after
 * deferred to v1.34.3.x once we have 30d+ of post-Agents-era data.
 *
 * Since v1.34.3 doesn't route patients to non-default profiles yet, ALL
 * activity counts against the default. v1.34.3.1 will partition correctly
 * by profile once patient soft-tag routing lands.
 */
export const getPreshowPerformanceMetrics = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => metricsInput.parse(raw))
  .handler(async ({ data }): Promise<PreshowProfileMetrics[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const windowDays = data.windowDays ?? 7;
    const since = new Date(Date.now() - windowDays * 86400_000).toISOString();

    // Sends: patient_outreach rows tagged with the preshow:* dedupe token.
    const { count: sentCount } = await sb
      .from("patient_outreach")
      .select("id", { count: "exact", head: true })
      .eq("user_id", effectiveUserId)
      .eq("direction", "outbound")
      .gte("created_at", since)
      .like("subject", "%preshow:%");

    // Confirmations: status_events transitioning to 'confirmed' triggered by
    // 'patient' or 'preshow-agent' (auto-confirm via response parsing).
    const { count: confirmedCount } = await sb
      .from("appointment_status_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", effectiveUserId)
      .eq("to_status", "confirmed")
      .gte("created_at", since);

    // Cancellations that came AFTER a preshow reminder (the Rescue agent's
    // signal). Counts to_status=cancelled events within the window.
    const { count: cancelledCount } = await sb
      .from("appointment_status_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", effectiveUserId)
      .eq("to_status", "cancelled")
      .gte("created_at", since);

    // Load the default profile to attribute counts to.
    const { data: defaultProfile } = await sb
      .from("preshow_profiles")
      .select("id")
      .eq("user_id", effectiveUserId)
      .eq("is_default", true)
      .maybeSingle();

    if (!defaultProfile) {
      return [];
    }

    return [
      {
        profileId: defaultProfile.id,
        windowDays,
        sent: sentCount ?? 0,
        confirmed: confirmedCount ?? 0,
        cancelledAfterReminder: cancelledCount ?? 0,
      },
    ];
  });
