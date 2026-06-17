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
import { getSpaName } from "@/server/emma-optout.functions";
import { recordAgentAction } from "@/server/messaging-activity";

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
    return gatherSpaDataExport(admin(), effectiveUserId);
  });

type ExportSb = ReturnType<typeof admin>;

/**
 * The export gather, factored out of the server fn so the scheduled Monthly
 * Patient-Book Export cron (api.cron.patient-export) can reuse the exact same
 * roster — one definition, page == cron, no drift.
 */
export async function gatherSpaDataExport(
  sb: ExportSb,
  effectiveUserId: string,
): Promise<SpaDataExport> {
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
        .from("appointments")
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
        .from("waitlist")
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
}

// ─── Monthly Patient-Book Export (scheduled emailer) ──────────────────────────
//
// The Skill Funnel's "Monthly Patient-Book Export" (a `routine` materializer):
// once a month, email the owner a CSV of their patient book for bookkeeping —
// no manual download each month. Mirrors sendRecallDigestForUser (owner-facing,
// gated, dedup-stamped). NOTE: this is the owner's OWN data delivered to the
// owner's OWN inbox (the honest-exit category), NOT patient outreach — so it is
// deliberately NOT gated by the patient-sending kill switch. Its own On/Pause
// (noshow_policies.patient_export_enabled) is the control.

/** RFC-4180-ish CSV field: quote and double interior quotes when needed. */
function csvField(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function patientsToCsv(patients: ExportedPatient[]): string {
  const header = ["patient_id", "name", "email", "phone", "lifetime_spend_usd"];
  const lines = [header.join(",")];
  for (const p of patients) {
    lines.push(
      [
        csvField(p.id),
        csvField(p.name),
        csvField(p.email),
        csvField(p.phone),
        csvField(p.lifetimeSpendUsd),
      ].join(","),
    );
  }
  // Trailing newline so the file ends cleanly in spreadsheet imports.
  return lines.join("\r\n") + "\r\n";
}

/** UTF-8-safe base64 for the Resend attachment (chunked so a big book won't
 *  overflow the call stack via fromCharCode). */
function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function ownerEmailForUserId(
  sb: ExportSb,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await sb.auth.admin.getUserById(userId);
    if (error) {
      console.warn("[patient-export] owner email lookup failed", userId, error.message);
      return null;
    }
    return data?.user?.email ?? null;
  } catch (e) {
    console.warn("[patient-export] owner email lookup threw", userId, e);
    return null;
  }
}

export type PatientExportResult =
  | { status: "sent"; email: string; patients: number }
  | { status: "empty" }
  | { status: "no_email" }
  | { status: "error"; error: string };

/**
 * Compute + email one spa's monthly patient-book export. Honest by construction:
 *   • an empty book sends NOTHING (no noise),
 *   • it emails the OWNER their own data — never a patient,
 *   • on success it stamps patient_export_last_sent_at for the cron's dedup.
 */
export async function sendPatientBookExportForUser(
  sb: ExportSb,
  userId: string,
  publicOrigin: string,
): Promise<PatientExportResult> {
  const data = await gatherSpaDataExport(sb, userId);
  if (data.counts.patients === 0) return { status: "empty" };

  const email = await ownerEmailForUserId(sb, userId);
  if (!email) return { status: "no_email" };

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { status: "error", error: "RESEND_API_KEY missing on the worker." };

  const spaName = await getSpaName(userId);
  const csv = patientsToCsv(data.patients);
  const stamp = data.exportedAt.slice(0, 10);
  const filename = `patient-book-${stamp}.csv`;
  const ctaUrl = `${publicOrigin.replace(/\/$/, "")}/app/refill/settings/account`;
  const { patients: nPatients, appointments: nAppts, waitlist: nWl } = data.counts;

  const subject = `Your monthly patient-book export — ${spaName} (${nPatients.toLocaleString()} patients)`;
  const text = `SmartSpa · Monthly patient-book export — ${spaName}

Attached: ${filename} — your full patient book (${nPatients.toLocaleString()} patients) for your bookkeeping.

This month's snapshot:
  Patients: ${nPatients.toLocaleString()}
  Appointments on file: ${nAppts.toLocaleString()}
  Waitlist entries: ${nWl.toLocaleString()}

Need appointments and waitlist too, or a fresh pull any time? Your full export is always one click away on your account page: ${ctaUrl}

You can turn this monthly export off any time from Skills.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f5;">
  <div style="max-width:560px;margin:0 auto;padding:28px 24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2421;">
    <p style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin:0 0 6px;">SmartSpa · Monthly patient-book export</p>
    <h1 style="font-size:20px;margin:0 0 14px;color:#111827;">${spaName}</h1>
    <p style="font-size:14px;line-height:1.6;margin:0 0 16px;">Attached is <strong>${filename}</strong> — your full patient book (${nPatients.toLocaleString()} patients) for bookkeeping. No manual download this month.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:0 0 18px;">
      <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">Patients</td><td style="padding:4px 0;font-weight:600;">${nPatients.toLocaleString()}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">Appointments on file</td><td style="padding:4px 0;font-weight:600;">${nAppts.toLocaleString()}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">Waitlist entries</td><td style="padding:4px 0;font-weight:600;">${nWl.toLocaleString()}</td></tr>
    </table>
    <a href="${ctaUrl}" style="display:inline-block;background:#047857;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:9px;">Full export (with appointments &amp; waitlist) &rarr;</a>
    <p style="font-size:12px;color:#888;margin:18px 0 0;line-height:1.55;">This is your own data, delivered to you — nothing was sent to any patient. Turn this monthly export off any time from <strong>Skills</strong>.</p>
  </div>
</body></html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.REFILL_FROM_EMAIL ?? "recall@getrefill.app",
        to: [email],
        subject,
        text,
        html,
        attachments: [{ filename, content: toBase64Utf8(csv) }],
        tags: [
          { name: "type", value: "refill-patient-export" },
          { name: "tenant", value: userId },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return {
        status: "error",
        error: `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
      };
    }
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // Stamp the send for the cron's monthly dedup guard. patient_export_last_sent_at
  // isn't in types.ts yet (loose posture, same as the recall-digest stamp).
  const stampPatch: Record<string, unknown> = {
    patient_export_last_sent_at: new Date().toISOString(),
  };
  await sb
    .from("noshow_policies")
    .update(stampPatch as Database["public"]["Tables"]["noshow_policies"]["Update"])
    .eq("user_id", userId);

  // Tier-2 ledger: an owner-facing autonomous send went out. Best-effort.
  await recordAgentAction(sb, userId, {
    agent: "patient_export",
    action: "export_emailed",
    channel: "email",
    count: 1,
    initiatedBy: "autonomous",
    metadata: { patients: nPatients },
  });

  return { status: "sent", email, patients: nPatients };
}
