/**
 * Emma(OS) waitlist server functions (v361).
 *
 * Public surface (no auth — token IS the capability):
 *   getWaitlistOptInPayload  — what the /waitlist/optin/<token> page shows
 *   optInToWaitlist          — confirm opt-in
 *   revokeWaitlistOptIn      — patient self-service unsubscribe from waitlist
 *
 * Authenticated surface (spa owner):
 *   listWaitlist             — for /app/refill/rescue waitlist tab
 *   markPatientOptedIn       — spa manually adds a patient
 *   markPatientOptedOut      — spa manually removes
 *
 * Internal helpers (server-only, no auth needed — called from other
 * server fns):
 *   getOrMintWaitlistToken(sb, userId, patientNodeId) — used by preshow
 *                            agent + rescue dispatcher to build the
 *                            opt-in footer URL
 *   buildWaitlistOptInUrl(token) — central URL builder so the host
 *                            string is one source of truth
 *
 * Established 2026-05-17 (Promotions Engine v361).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type WaitlistStatus = "active" | "paused" | "revoked";

export type WaitlistEntry = {
  id: string;
  patientNodeId: string;
  patientName: string | null;
  patientPhone: string | null;
  patientEmail: string | null;
  treatmentTypes: string[];
  preferredProviders: string[];
  status: WaitlistStatus;
  optInSource: string;
  optedInAt: string;
  revokedAt: string | null;
};

export type WaitlistOptInPayload = {
  spaName: string;
  patientFirstName: string | null;
  alreadyOptedIn: boolean;
  alreadyRevoked: boolean;
  // v373: context for the Type B (earlier-appointment) case so the page
  // can say "Earlier slot for your Jun 15 Tox?" instead of generic
  // "Join the waitlist". Populated when admin-seeded with these prefs.
  intentType: "catchall" | "earlier_appointment";
  treatmentTypes: string[];
  scheduledAppointmentAt: string | null;
  scheduledAppointmentTreatment: string | null;
  // v375: the spa's curated rescue_eligible_treatments list — the candidate
  // set the patient picks from. Empty array = spa hasn't configured a
  // policy list yet, picker is hidden, fall back to catchall semantics.
  availableTreatments: string[];
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

// ─── URL builder ──────────────────────────────────────────────────────────

/**
 * Build the canonical opt-in URL for a per-patient token. Centralized so
 * the host string is one source of truth — the Worker fronts both
 * agentiport.com and emma.agentiport.com; either works for public links.
 */
export function buildWaitlistOptInUrl(token: string): string {
  return `https://emma.agentiport.com/waitlist/optin/${token}`;
}

// ─── Internal helper — mint or fetch a token ──────────────────────────────

/**
 * Look up the stable opt-in token for (user_id, patient_node_id). Mints
 * one on first call. Called by the preshow agent (in emma-preshow.functions.ts)
 * when building the opt-in footer URL.
 */
export async function getOrMintWaitlistToken(
  sb: SupabaseAdmin,
  userId: string,
  patientNodeId: string,
): Promise<string> {
  // Check first to avoid hitting the unique-violation path on the common case.
  const { data: existing } = await sb
    .from("emma_waitlist_tokens")
    .select("token")
    .eq("user_id", userId)
    .eq("patient_node_id", patientNodeId)
    .maybeSingle();
  if (existing?.token) return existing.token;

  const { data: inserted, error } = await sb
    .from("emma_waitlist_tokens")
    .insert({ user_id: userId, patient_node_id: patientNodeId })
    .select("token")
    .single();
  if (error) {
    // Race: another caller minted between our SELECT and INSERT. Re-read.
    const { data: retried } = await sb
      .from("emma_waitlist_tokens")
      .select("token")
      .eq("user_id", userId)
      .eq("patient_node_id", patientNodeId)
      .single();
    if (retried?.token) return retried.token;
    throw new Error(`Couldn't mint waitlist token: ${error.message}`);
  }
  return inserted.token;
}

// ─── Zod ──────────────────────────────────────────────────────────────────

const tokenInput = z.object({
  token: z.string().uuid(),
});

const optInInput = z.object({
  token: z.string().uuid(),
  // v375: patient picks which treatments they want notifications for. When
  // omitted, the admin's pre-set treatment_types persist (back-compat for
  // legacy clients that haven't been updated).
  treatmentTypes: z.array(z.string().max(120)).max(20).optional(),
});

const revokeInput = z.object({
  token: z.string().uuid(),
});

const listInput = z.object({
  accessToken: z.string().min(1),
  /** v1.20 admin viewing-as. See [[resolveEffectiveUserId]]. */
  viewAsUserId: z.string().uuid().optional(),
});

const markPatientInput = z.object({
  accessToken: z.string().min(1),
  patientNodeId: z.string().uuid(),
});

// ─── getWaitlistOptInPayload (public, token-only) ─────────────────────────

export const getWaitlistOptInPayload = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<WaitlistOptInPayload | null> => {
    const sb = admin();

    const { data: tokenRow } = await sb
      .from("emma_waitlist_tokens")
      .select("user_id, patient_node_id")
      .eq("token", data.token)
      .maybeSingle();
    if (!tokenRow) return null;

    // Stamp last_used_at (best-effort).
    await sb
      .from("emma_waitlist_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token", data.token);

    const [
      { data: spa },
      { data: patient },
      { data: existing },
      { data: policy },
    ] = await Promise.all([
      sb
        .from("knowledge_nodes")
        .select("title")
        .eq("user_id", tokenRow.user_id)
        .eq("context", "spa-profile")
        .eq("lookup_key", "spa-name")
        .maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("title")
        .eq("id", tokenRow.patient_node_id)
        .maybeSingle(),
      sb
        .from("emma_waitlist")
        .select(
          "status, intent_type, treatment_types, scheduled_appointment_id",
        )
        .eq("user_id", tokenRow.user_id)
        .eq("patient_node_id", tokenRow.patient_node_id)
        .maybeSingle(),
      // v375: pull the spa's curated rescue_eligible_treatments so the
      // public picker shows the candidate set Karen has configured.
      sb
        .from("emma_noshow_policies")
        .select("rescue_eligible_treatments")
        .eq("user_id", tokenRow.user_id)
        .maybeSingle(),
    ]);

    const status = existing?.status as WaitlistStatus | undefined;

    // v373: pull the Type B context (scheduled appointment time +
    // treatment) so the public page can render the right copy.
    let scheduledAppointmentAt: string | null = null;
    let scheduledAppointmentTreatment: string | null = null;
    if (existing?.scheduled_appointment_id) {
      const { data: apt } = await sb
        .from("emma_appointments")
        .select("scheduled_at, treatment_type")
        .eq("id", existing.scheduled_appointment_id)
        .maybeSingle();
      if (apt) {
        scheduledAppointmentAt = apt.scheduled_at;
        scheduledAppointmentTreatment = apt.treatment_type;
      }
    }

    return {
      spaName: spa?.title?.trim() || "your spa",
      patientFirstName: extractFirstName(patient?.title ?? null),
      alreadyOptedIn: status === "active",
      alreadyRevoked: status === "revoked",
      intentType:
        (existing?.intent_type as "catchall" | "earlier_appointment") ??
        "catchall",
      treatmentTypes: existing?.treatment_types ?? [],
      scheduledAppointmentAt,
      scheduledAppointmentTreatment,
      availableTreatments: policy?.rescue_eligible_treatments ?? [],
    };
  });

// ─── optInToWaitlist (public, token-only) ─────────────────────────────────

export const optInToWaitlist = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => optInInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; alreadyActive: boolean }> => {
    const sb = admin();

    const { data: tokenRow } = await sb
      .from("emma_waitlist_tokens")
      .select("user_id, patient_node_id")
      .eq("token", data.token)
      .maybeSingle();
    if (!tokenRow) throw new Error("Invalid or expired link.");

    // Upsert with on-conflict reactivate-if-revoked semantics.
    const { data: existing } = await sb
      .from("emma_waitlist")
      .select("id, status")
      .eq("user_id", tokenRow.user_id)
      .eq("patient_node_id", tokenRow.patient_node_id)
      .maybeSingle();

    // v375: if the patient sent treatment selections, persist them on the
    // waitlist row. Otherwise leave existing treatment_types alone (preserves
    // the admin's pre-seed for back-compat).
    const patientPickedTreatments = data.treatmentTypes;

    if (existing) {
      if (existing.status === "active") return { ok: true, alreadyActive: true };
      // Reactivate from paused/revoked
      const updatePatch: Record<string, unknown> = {
        status: "active",
        revoked_at: null,
        opted_in_at: new Date().toISOString(),
        opt_in_source: "footer-link",
      };
      if (patientPickedTreatments !== undefined) {
        updatePatch.treatment_types = patientPickedTreatments;
      }
      const { error } = await sb
        .from("emma_waitlist")
        .update(updatePatch)
        .eq("id", existing.id);
      if (error) throw new Error(`Couldn't reactivate: ${error.message}`);
      return { ok: true, alreadyActive: false };
    }

    const insertRow: Record<string, unknown> = {
      user_id: tokenRow.user_id,
      patient_node_id: tokenRow.patient_node_id,
      status: "active",
      opt_in_source: "footer-link",
    };
    if (patientPickedTreatments !== undefined) {
      insertRow.treatment_types = patientPickedTreatments;
    }
    const { error } = await sb.from("emma_waitlist").insert(insertRow);
    if (error) throw new Error(`Couldn't opt in: ${error.message}`);
    return { ok: true, alreadyActive: false };
  });

// ─── revokeWaitlistOptIn (public, token-only) ─────────────────────────────

export const revokeWaitlistOptIn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => revokeInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const sb = admin();

    const { data: tokenRow } = await sb
      .from("emma_waitlist_tokens")
      .select("user_id, patient_node_id")
      .eq("token", data.token)
      .maybeSingle();
    if (!tokenRow) throw new Error("Invalid link.");

    await sb
      .from("emma_waitlist")
      .update({
        status: "revoked",
        revoked_at: new Date().toISOString(),
      })
      .eq("user_id", tokenRow.user_id)
      .eq("patient_node_id", tokenRow.patient_node_id);
    return { ok: true };
  });

// ─── listWaitlist (spa-facing) ────────────────────────────────────────────

export const listWaitlist = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<WaitlistEntry[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: rows, error } = await sb
      .from("emma_waitlist")
      .select(
        "id, patient_node_id, treatment_types, preferred_providers, status, opt_in_source, opted_in_at, revoked_at",
      )
      .eq("user_id", effectiveUserId)
      .order("opted_in_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`Couldn't load waitlist: ${error.message}`);
    if (!rows || rows.length === 0) return [];

    // Hydrate patient names + contact
    const patientIds = Array.from(new Set(rows.map((r) => r.patient_node_id)));
    const { data: patients } = await sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .in("id", patientIds);
    const patientById = new Map<
      string,
      { name: string | null; phone: string | null; email: string | null }
    >();
    for (const p of patients ?? []) {
      const a = p.attachments as { phone?: string; email?: string } | null;
      patientById.set(p.id, {
        name: p.title,
        phone: a?.phone ?? null,
        email: a?.email ?? null,
      });
    }

    return rows.map((r) => ({
      id: r.id,
      patientNodeId: r.patient_node_id,
      patientName: patientById.get(r.patient_node_id)?.name ?? null,
      patientPhone: patientById.get(r.patient_node_id)?.phone ?? null,
      patientEmail: patientById.get(r.patient_node_id)?.email ?? null,
      treatmentTypes: r.treatment_types,
      preferredProviders: r.preferred_providers,
      status: r.status as WaitlistStatus,
      optInSource: r.opt_in_source,
      optedInAt: r.opted_in_at,
      revokedAt: r.revoked_at,
    }));
  });

// ─── markPatientOptedIn (spa manual) ──────────────────────────────────────

export const markPatientOptedIn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => markPatientInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: existing } = await sb
      .from("emma_waitlist")
      .select("id, status")
      .eq("user_id", userId)
      .eq("patient_node_id", data.patientNodeId)
      .maybeSingle();

    if (existing) {
      const { error } = await sb
        .from("emma_waitlist")
        .update({
          status: "active",
          revoked_at: null,
          opt_in_source: "spa-manual",
          opted_in_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) throw new Error(`Couldn't update: ${error.message}`);
    } else {
      const { error } = await sb.from("emma_waitlist").insert({
        user_id: userId,
        patient_node_id: data.patientNodeId,
        status: "active",
        opt_in_source: "spa-manual",
      });
      if (error) throw new Error(`Couldn't add: ${error.message}`);
    }
    return { ok: true };
  });

// ─── markPatientOptedOut (spa manual) ─────────────────────────────────────

export const markPatientOptedOut = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => markPatientInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    await sb
      .from("emma_waitlist")
      .update({
        status: "revoked",
        revoked_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("patient_node_id", data.patientNodeId);
    return { ok: true };
  });

// ─── deleteWaitlistRow (spa manual, hard delete) ──────────────────────────
//
// v374.1: hard-delete the emma_waitlist row for a (user, patient) pair.
// Use case: wrong patient picked during bulk-seed, test row left behind,
// duplicate cleanup. Different from markPatientOptedOut (soft revoke,
// preserves audit trail) — this wipes the row entirely.
//
// Token row is intentionally PRESERVED so the patient's opt-in URL
// remains stable across re-seeds. Karen can bulk-seed the same patient
// later and the URL is still valid; without this preservation, every
// delete would invalidate any in-flight email or message to that patient.

const deleteRowInput = z.object({
  accessToken: z.string().min(1),
  waitlistRowId: z.string().uuid(),
});

export const deleteWaitlistRow = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => deleteRowInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { error } = await sb
      .from("emma_waitlist")
      .delete()
      .eq("id", data.waitlistRowId)
      .eq("user_id", userId);
    if (error)
      throw new Error(`Couldn't delete waitlist row: ${error.message}`);
    return { ok: true };
  });

// ─── extractFirstName ─────────────────────────────────────────────────────

function extractFirstName(displayName: string | null): string | null {
  if (!displayName) return null;
  if (displayName.includes(",")) {
    const parts = displayName.split(",", 2).map((s) => s.trim());
    return parts[1] || null;
  }
  const parts = displayName.trim().split(/\s+/);
  return parts[0] || null;
}
