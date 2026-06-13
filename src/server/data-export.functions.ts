/**
 * Honest exit — one-click full data export (project_trusted_onboarding, step 9).
 *
 * Easy-to-leave de-risks the yes AND is the best retention tool: a spa can take
 * its own data and walk, no dark patterns, no hostage-taking. This gathers the
 * spa's OWNED operational data — the patient book, appointments, and waitlist —
 * into one portable archive the owner downloads from the account page. The
 * billing ledger has its own CSV on the Billing page (we point there rather than
 * silently omit it).
 *
 * Service-role read, accessToken + resolveEffectiveUserId, mirroring the other
 * tenant-scoped server fns. Read-only: exporting changes nothing.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";

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

/** A JSON-serializable value (the server-fn response type rejects `unknown`). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ExportedPatient = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  lifetimeSpendUsd: number | null;
  /** The full freeform record, so nothing the spa entered is left behind. */
  details: JsonValue | null;
};

export type ExportedAppointment = {
  id: string;
  scheduledAt: string | null;
  durationMin: number | null;
  treatment: string | null;
  provider: string | null;
  status: string | null;
  patientId: string | null;
};

export type ExportedWaitlistEntry = {
  id: string;
  patientId: string | null;
  treatments: string[] | null;
  status: string | null;
  createdAt: string | null;
};

export type SpaDataExport = {
  exportedAt: string;
  patients: ExportedPatient[];
  appointments: ExportedAppointment[];
  waitlist: ExportedWaitlistEntry[];
  counts: { patients: number; appointments: number; waitlist: number };
};

const exportInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const exportSpaData = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => exportInput.parse(input))
  .handler(async ({ data }): Promise<SpaDataExport> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // Patient book — paginated past PostgREST's 1,000-row cap so a real spa's
    // full roster comes out complete, never silently truncated.
    const patientRows = await fetchAllRows<{
      id: string;
      title: string | null;
      attachments: unknown;
    }>((from, to) =>
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .eq("user_id", effectiveUserId)
        .eq("node_type", "patient")
        .eq("context", "patients")
        .order("id", { ascending: true })
        .range(from, to),
    );
    const patients: ExportedPatient[] = patientRows.map((p) => {
      const a = (p.attachments ?? null) as Record<string, unknown> | null;
      const spend = a?.lifetimeSpendUsd;
      return {
        id: p.id,
        name: p.title,
        email: (a?.email as string | undefined) ?? null,
        phone: (a?.phone as string | undefined) ?? null,
        lifetimeSpendUsd: spend == null ? null : Number(spend),
        details: (a as JsonValue | null) ?? null,
      };
    });

    const apptRows = await fetchAllRows<{
      id: string;
      scheduled_at: string | null;
      duration_min: number | null;
      treatment_type: string | null;
      provider_name: string | null;
      status: string | null;
      patient_node_id: string | null;
    }>((from, to) =>
      sb
        .from("emma_appointments")
        .select(
          "id, scheduled_at, duration_min, treatment_type, provider_name, status, patient_node_id",
        )
        .eq("user_id", effectiveUserId)
        .order("id", { ascending: true })
        .range(from, to),
    );
    const appointments: ExportedAppointment[] = apptRows.map((r) => ({
      id: r.id,
      scheduledAt: r.scheduled_at,
      durationMin: r.duration_min,
      treatment: r.treatment_type,
      provider: r.provider_name,
      status: r.status,
      patientId: r.patient_node_id,
    }));

    const wlRows = await fetchAllRows<{
      id: string;
      patient_node_id: string | null;
      treatment_types: string[] | null;
      status: string | null;
      created_at: string | null;
    }>((from, to) =>
      sb
        .from("emma_waitlist")
        .select("id, patient_node_id, treatment_types, status, created_at")
        .eq("user_id", effectiveUserId)
        .order("id", { ascending: true })
        .range(from, to),
    );
    const waitlist: ExportedWaitlistEntry[] = wlRows.map((r) => ({
      id: r.id,
      patientId: r.patient_node_id,
      treatments: r.treatment_types,
      status: r.status,
      createdAt: r.created_at,
    }));

    return {
      exportedAt: new Date().toISOString(),
      patients,
      appointments,
      waitlist,
      counts: {
        patients: patients.length,
        appointments: appointments.length,
        waitlist: waitlist.length,
      },
    };
  });
