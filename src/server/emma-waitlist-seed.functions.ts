/**
 * Admin waitlist seeding (v373).
 *
 * Karen/David pick a patient, set their intent (catchall vs
 * earlier-appointment) + treatment_types + optional scheduled-
 * appointment link, then send the patient the opt-in URL via their
 * normal patient-communication channel.
 *
 * Flow:
 *   1. Admin calls seedWaitlistIntent({ patient, intent, treatments, ... })
 *   2. Server creates waitlist row with status='paused' (preserves
 *      the admin's pre-set preferences but won't fire any rescue SMS
 *      until the patient confirms)
 *   3. Server mints (or returns existing) waitlist token for that patient
 *   4. Server returns the full opt-in URL
 *   5. Karen pastes the URL into her existing SMS / email flow
 *   6. Patient taps → /waitlist/optin/<token> → confirms → row flips
 *      to status='active' (preferences preserved)
 *
 * v362 reliability-tier note: the row carries the patient_node_id so
 * the rescue dispatcher can JOIN to reliability_status when v374
 * tiered-blast ships. No change to the v373 row shape needed for that.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";

const PUBLIC_REFILL_ORIGIN =
  process.env.PUBLIC_REFILL_URL ?? "https://getrefill.app";
const PUBLIC_EMMA_ORIGIN =
  process.env.PUBLIC_SCAN_URL?.replace(/\/scan$/, "") ??
  "https://openagentic.site";

function admin() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── List candidate patients (with phone/email) for the admin picker ──────

const listPatientsInput = z.object({
  accessToken: z.string().min(1),
  query: z.string().max(120).optional(),
});

export type AdminPatientCandidate = {
  patientNodeId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  // v374: surface lifetime spend so the bulk picker can sort + auto-select
  // top-N by VIP value. Same field selectFitPatients uses in the rescue
  // dispatcher (attachments.lifetimeSpendUsd).
  lifetimeSpend: number;
};

export const listSeedablePatients = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listPatientsInput.parse(input))
  .handler(async ({ data }): Promise<AdminPatientCandidate[]> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const q = data.query?.trim().toLowerCase() ?? "";

    // Bounded fetch — typical spa has <5K patients. Filter client-side
    // by name/phone/email substring. For >5K spas this would need a
    // proper search index; defer until a customer exceeds the limit.
    const { data: rows, error } = await sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("user_id", userId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .limit(5000);
    if (error) throw new Error(`Couldn't load patients: ${error.message}`);

    // v373.2: filter out banned + opted_out patients server-side. Banned
    // clients shouldn't appear in any picker that could lead to outbound
    // SMS — the rescue dispatcher already skips them at send time
    // (selectFitPatients checks attachments.banned), but the admin picker
    // was showing them.
    const all: AdminPatientCandidate[] = (rows ?? [])
      .filter((r) => {
        const a = r.attachments as {
          banned?: boolean;
          opted_out?: boolean;
        } | null;
        return !a?.banned && !a?.opted_out;
      })
      .map((r) => {
        const a = r.attachments as {
          phone?: string;
          email?: string;
          lifetimeSpendUsd?: number;
        } | null;
        return {
          patientNodeId: r.id,
          name: r.title?.trim() || null,
          phone: a?.phone ?? null,
          email: a?.email ?? null,
          lifetimeSpend: Number(a?.lifetimeSpendUsd ?? 0),
        };
      });
    if (!q) return all.slice(0, 500);
    return all
      .filter((p) => {
        const hay = `${p.name ?? ""} ${p.phone ?? ""} ${p.email ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 500);
  });

// ─── List upcoming appointments for a chosen patient (Type B helper) ──────

const listUpcomingInput = z.object({
  accessToken: z.string().min(1),
  patientNodeId: z.string().uuid(),
});

export type UpcomingAppointment = {
  id: string;
  scheduledAt: string;
  treatmentType: string | null;
  providerName: string | null;
};

export const listUpcomingForPatient = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listUpcomingInput.parse(input))
  .handler(async ({ data }): Promise<UpcomingAppointment[]> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const now = new Date().toISOString();

    const { data: rows, error } = await sb
      .from("appointments")
      .select("id, scheduled_at, treatment_type, provider_name, status")
      .eq("user_id", userId)
      .eq("patient_node_id", data.patientNodeId)
      .gte("scheduled_at", now)
      .in("status", ["scheduled", "confirmed"])
      .order("scheduled_at", { ascending: true })
      .limit(20);
    if (error)
      throw new Error(`Couldn't load upcoming appointments: ${error.message}`);

    return (rows ?? []).map((r) => ({
      id: r.id,
      scheduledAt: r.scheduled_at,
      treatmentType: r.treatment_type,
      providerName: r.provider_name,
    }));
  });

// ─── Seed the waitlist intent — creates paused row + returns opt-in URL ───

const seedInput = z.object({
  accessToken: z.string().min(1),
  patientNodeId: z.string().uuid(),
  intentType: z.enum(["catchall", "earlier_appointment"]),
  treatmentTypes: z.array(z.string().max(120)).max(20).default([]),
  scheduledAppointmentId: z.string().uuid().nullable().optional(),
  brand: z.enum(["refill", "emma"]).default("refill"),
});

export type SeedWaitlistResult = {
  ok: true;
  alreadyActive: boolean;
  optInUrl: string;
  waitlistRowId: string;
};

export const seedWaitlistIntent = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => seedInput.parse(input))
  .handler(async ({ data }): Promise<SeedWaitlistResult> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    if (
      data.intentType === "earlier_appointment" &&
      data.treatmentTypes.length === 0
    ) {
      throw new Error(
        "Earlier-appointment intent requires at least one treatment_type (the treatment they want notifications for).",
      );
    }

    // Check for an existing waitlist row for this (user, patient)
    const { data: existing } = await sb
      .from("waitlist")
      .select("id, status")
      .eq("user_id", userId)
      .eq("patient_node_id", data.patientNodeId)
      .maybeSingle();

    let waitlistRowId: string;
    if (existing) {
      // Update preferences in place. If already active, leave status alone
      // (don't accidentally re-pause an active opt-in). If paused/revoked,
      // bump status back to 'paused' so the patient confirms via tap.
      const nextStatus = existing.status === "active" ? "active" : "paused";
      const { error: updateErr } = await sb
        .from("waitlist")
        .update({
          intent_type: data.intentType,
          treatment_types: data.treatmentTypes,
          scheduled_appointment_id: data.scheduledAppointmentId ?? null,
          status: nextStatus,
          opt_in_source: "spa-manual",
        })
        .eq("id", existing.id);
      if (updateErr) {
        throw new Error(`Couldn't update waitlist row: ${updateErr.message}`);
      }
      waitlistRowId = existing.id;
    } else {
      const { data: inserted, error: insertErr } = await sb
        .from("waitlist")
        .insert({
          user_id: userId,
          patient_node_id: data.patientNodeId,
          intent_type: data.intentType,
          treatment_types: data.treatmentTypes,
          scheduled_appointment_id: data.scheduledAppointmentId ?? null,
          status: "paused",
          opt_in_source: "spa-manual",
        })
        .select("id")
        .single();
      if (insertErr || !inserted) {
        throw new Error(
          `Couldn't create waitlist row: ${insertErr?.message ?? "no row"}`,
        );
      }
      waitlistRowId = inserted.id;
    }

    // Mint (or fetch) the token. Uses the same code path as preshow agent
    // so a patient who already has a token gets the same URL.
    const token = await getOrMintToken(sb, userId, data.patientNodeId);

    const origin =
      data.brand === "refill" ? PUBLIC_REFILL_ORIGIN : PUBLIC_EMMA_ORIGIN;
    const optInUrl = `${origin}/waitlist/optin/${token}`;

    return {
      ok: true,
      alreadyActive: existing?.status === "active",
      optInUrl,
      waitlistRowId,
    };
  });

// ─── v374: BULK seed waitlist intents for many patients in one call ───────
//
// Karen wants to invite 100-200 patients in a single pass without clicking
// the single-patient seed page 100+ times. This fn batches the same logic:
// for each {patientNodeId, treatments, intent}, upsert a paused waitlist row
// and mint (or reuse) a token, then return the opt-in URL.
//
// SMS-decoupled: while Bandwidth porting is in flight the bulk picker
// generates URLs that Karen distributes through her existing email or
// patient-comm channel. When SMS lights up, the rescue dispatcher picks
// already-active waitlist rows transparently — no rework needed.
const bulkSeedInput = z.object({
  accessToken: z.string().min(1),
  patientNodeIds: z.array(z.string().uuid()).min(1).max(500),
  intentType: z.enum(["catchall", "earlier_appointment"]).default("catchall"),
  treatmentTypes: z.array(z.string().max(120)).max(20).default([]),
  brand: z.enum(["refill", "emma"]).default("refill"),
});

export type BulkSeedRowResult = {
  patientNodeId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  optInUrl: string | null;
  status: "seeded" | "already_active" | "error";
  errorMessage: string | null;
};

export type BulkSeedResult = {
  ok: true;
  total: number;
  seeded: number;
  alreadyActive: number;
  errored: number;
  rows: BulkSeedRowResult[];
};

export const bulkSeedWaitlistIntents = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => bulkSeedInput.parse(input))
  .handler(async ({ data }): Promise<BulkSeedResult> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    if (
      data.intentType === "earlier_appointment" &&
      data.treatmentTypes.length === 0
    ) {
      throw new Error(
        "Earlier-appointment intent requires at least one treatment_type.",
      );
    }

    // Pull patient names/phones/emails once for the result table — saves
    // a per-row round-trip and keeps the bulk fn within Workers' CPU budget.
    const { data: patientRows } = await sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("user_id", userId)
      .in("id", data.patientNodeIds);
    const patientMeta = new Map<
      string,
      { name: string | null; phone: string | null; email: string | null }
    >();
    for (const r of patientRows ?? []) {
      const a = r.attachments as { phone?: string; email?: string } | null;
      patientMeta.set(r.id, {
        name: r.title?.trim() || null,
        phone: a?.phone ?? null,
        email: a?.email ?? null,
      });
    }

    const origin =
      data.brand === "refill" ? PUBLIC_REFILL_ORIGIN : PUBLIC_EMMA_ORIGIN;

    const rows: BulkSeedRowResult[] = [];
    let seeded = 0;
    let alreadyActive = 0;
    let errored = 0;

    for (const patientNodeId of data.patientNodeIds) {
      const meta = patientMeta.get(patientNodeId) ?? {
        name: null,
        phone: null,
        email: null,
      };
      try {
        // Same upsert logic as seedWaitlistIntent's single-patient handler.
        const { data: existing } = await sb
          .from("waitlist")
          .select("id, status")
          .eq("user_id", userId)
          .eq("patient_node_id", patientNodeId)
          .maybeSingle();

        if (existing) {
          const nextStatus =
            existing.status === "active" ? "active" : "paused";
          const { error: updateErr } = await sb
            .from("waitlist")
            .update({
              intent_type: data.intentType,
              treatment_types: data.treatmentTypes,
              status: nextStatus,
              opt_in_source: "spa-bulk",
            })
            .eq("id", existing.id);
          if (updateErr) throw new Error(updateErr.message);
        } else {
          const { error: insertErr } = await sb
            .from("waitlist")
            .insert({
              user_id: userId,
              patient_node_id: patientNodeId,
              intent_type: data.intentType,
              treatment_types: data.treatmentTypes,
              status: "paused",
              opt_in_source: "spa-bulk",
            });
          if (insertErr) throw new Error(insertErr.message);
        }

        const token = await getOrMintToken(sb, userId, patientNodeId);
        const optInUrl = `${origin}/waitlist/optin/${token}`;
        const isAlreadyActive = existing?.status === "active";

        rows.push({
          patientNodeId,
          name: meta.name,
          phone: meta.phone,
          email: meta.email,
          optInUrl,
          status: isAlreadyActive ? "already_active" : "seeded",
          errorMessage: null,
        });
        if (isAlreadyActive) alreadyActive += 1;
        else seeded += 1;
      } catch (e) {
        errored += 1;
        rows.push({
          patientNodeId,
          name: meta.name,
          phone: meta.phone,
          email: meta.email,
          optInUrl: null,
          status: "error",
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return {
      ok: true,
      total: data.patientNodeIds.length,
      seeded,
      alreadyActive,
      errored,
      rows,
    };
  });

async function getOrMintToken(
  sb: ReturnType<typeof admin>,
  userId: string,
  patientNodeId: string,
): Promise<string> {
  const { data: existing } = await sb
    .from("waitlist_tokens")
    .select("token")
    .eq("user_id", userId)
    .eq("patient_node_id", patientNodeId)
    .maybeSingle();
  if (existing?.token) return existing.token;

  const { data: inserted, error } = await sb
    .from("waitlist_tokens")
    .insert({ user_id: userId, patient_node_id: patientNodeId })
    .select("token")
    .single();
  if (error) {
    const { data: retried } = await sb
      .from("waitlist_tokens")
      .select("token")
      .eq("user_id", userId)
      .eq("patient_node_id", patientNodeId)
      .single();
    if (retried?.token) return retried.token;
    throw new Error(`Couldn't mint waitlist token: ${error.message}`);
  }
  return inserted.token;
}
