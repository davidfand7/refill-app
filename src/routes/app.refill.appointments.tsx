/**
 * /app/refill/appointments — appointment data + CSV import.
 *
 * The source of truth Emma's no-show recovery agents read from. Owners
 * upload their PMS export here — 20+ platforms auto-detected (see
 * SUPPORTED_PLATFORMS in src/lib/appointment-csv.ts). Manual status
 * overrides (mark no-show, mark showed) flip the appointment status
 * with an audit log entry.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarCheck,
  CalendarX,
  CheckCircle2,
  Clock,
  FileUp,
  Link2Off,
  Loader2,
  RefreshCw,
  Upload,
  User,
  UserCheck,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  getAppointmentMatchCoverage,
  ingestAppointmentCsv,
  listAppointments,
  updateAppointmentStatus,
  type AppointmentMatchCoverage,
  type AppointmentStatus,
  type EmmaAppointment,
  type IngestReceipt,
} from "@/server/emma-appointments.functions";
import { listRecentReminders } from "@/server/emma-preshow.functions";
import { dialectLabel, SUPPORTED_PLATFORMS } from "@/lib/appointment-csv";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/appointments")({
  component: AppointmentsPage,
});

function AppointmentsPage() {
  const [appointments, setAppointments] = useState<EmmaAppointment[] | null>(null);
  const [reminderStats, setReminderStats] = useState<{
    sentToday: number;
    sentThisWeek: number;
    skippedThisWeek: number;
  } | null>(null);
  const [coverage, setCoverage] = useState<AppointmentMatchCoverage | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<IngestReceipt | null>(null);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // v1.23.0 P3 sweep: plumb viewAsUserId for admin impersonation.
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [apts, stats, cov] = await Promise.all([
        listAppointments({ data: { accessToken: token, viewAsUserId } }),
        listRecentReminders({ data: { accessToken: token, viewAsUserId } }),
        getAppointmentMatchCoverage({
          data: { accessToken: token, viewAsUserId },
        }),
      ]);
      setAppointments(apts);
      setReminderStats(stats);
      setCoverage(cov);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load appointments.");
    }
  }, [viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(file: File) {
    setUploadBusy(true);
    setLastReceipt(null);
    try {
      const csv = await file.text();
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        return;
      }
      const receipt = await ingestAppointmentCsv({
        data: {
          accessToken: token,
          csv,
          sourceFilename: file.name,
          viewAsUserId,
        },
      });
      setLastReceipt(receipt);
      if (receipt.totalParsed === 0) {
        toast.error("No appointments found in that CSV.");
      } else {
        toast.success(
          `${receipt.inserted} added, ${receipt.updated} updated · detected ${dialectLabel(receipt.dialect)}`,
        );
      }
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploadBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function flipStatus(apt: EmmaAppointment, next: AppointmentStatus) {
    setStatusBusyId(apt.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const updated = await updateAppointmentStatus({
        data: {
          accessToken: token,
          appointmentId: apt.id,
          status: next,
          viewAsUserId,
        },
      });
      setAppointments((prev) =>
        prev?.map((a) => (a.id === apt.id ? updated : a)) ?? null,
      );
      toast.success(`Marked ${statusLabel(next)}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update status.");
    } finally {
      setStatusBusyId(null);
    }
  }

  const grouped = useMemo(() => {
    if (!appointments) return null;
    const today: EmmaAppointment[] = [];
    const upcoming: EmmaAppointment[] = [];
    const past: EmmaAppointment[] = [];
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    for (const a of appointments) {
      const t = new Date(a.scheduledAt).getTime();
      if (t < now && a.status === "scheduled") past.push(a);
      else if (t >= startOfDay.getTime() && t <= endOfDay.getTime()) today.push(a);
      else if (t > endOfDay.getTime()) upcoming.push(a);
      else past.push(a);
    }
    return { today, upcoming, past };
  }, [appointments]);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Emma(OS)"
        title="Appointments"
        description="Drop your PMS export (Acuity, Boulevard, Mangomint, Vagaro, AestheticsPro, Aesthetic Record — auto-detected). Emma keeps the schedule and runs the pre-show reminder cadence."
        breadcrumbs={[
          { label: "Emma(OS)", to: "/app/refill" },
          { label: "Appointments" },
        ]}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-[960px] w-full mx-auto space-y-6">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {/* Reminder stats card */}
        {reminderStats && (
          <div className="grid grid-cols-3 gap-3">
            <StatCard
              icon={CalendarCheck}
              label="Reminders sent today"
              value={reminderStats.sentToday.toLocaleString()}
            />
            <StatCard
              icon={Clock}
              label="This week"
              value={reminderStats.sentThisWeek.toLocaleString()}
            />
            <StatCard
              icon={AlertTriangle}
              label="Skipped (compliance)"
              value={reminderStats.skippedThisWeek.toLocaleString()}
              muted
            />
          </div>
        )}

        {/* Patient-match coverage ribbon (v378). Shows future-appointment
            link rate. When there are unmatched future appointments, prompts
            a re-upload to apply the v378 deterministic-matcher lift. */}
        {coverage && coverage.futureTotal > 0 && (
          <PatientMatchCoverageRibbon
            coverage={coverage}
            onUpload={() => fileInputRef.current?.click()}
          />
        )}

        {/* Upload card */}
        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-base font-semibold text-foreground mb-1">
                Upload appointment CSV
              </h2>
              <p className="text-xs text-ink-soft max-w-md">
                Auto-detects {SUPPORTED_PLATFORMS.length}+ platforms — Acuity,
                Boulevard, Mangomint, Mindbody, Jane, WellnessLiving, Fresha,
                GlossGenius, Zenoti, Square, and more. Unknown CSVs are
                AI-mapped on first upload and cached per-spa — every future
                re-upload of that shape is free + instant. Drop any
                appointment CSV from any platform.
              </p>
              <details className="mt-2 text-[11px] text-ink-soft">
                <summary className="cursor-pointer hover:text-foreground inline-block">
                  See full supported list
                </summary>
                <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5">
                  {SUPPORTED_PLATFORMS.map((p) => (
                    <span key={p.dialect}>· {p.label}</span>
                  ))}
                </div>
              </details>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-4 py-2 text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
            >
              {uploadBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileUp className="h-4 w-4" />
              )}
              Choose CSV
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
              }}
            />
          </div>

          {lastReceipt && (
            <div className="rounded-lg bg-muted/40 px-4 py-3 text-sm">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 text-[11px] font-medium">
                  <CheckCircle2 className="h-3 w-3" />
                  {lastReceipt.aiMapping
                    ? lastReceipt.aiMapping.platform
                      ? `${lastReceipt.aiMapping.platform} (AI-mapped)`
                      : "AI-mapped"
                    : dialectLabel(lastReceipt.dialect)}
                </span>
                <span className="text-[11px] text-ink-soft">
                  detection: {lastReceipt.dialectConfidence}
                </span>
                {lastReceipt.aiMapping && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-700 text-[11px] font-medium"
                    title={
                      lastReceipt.aiMapping.fromCache
                        ? "Mapping reused from this spa's cache — no LLM call this upload."
                        : "First time seeing this CSV shape — mapped by AI and cached for free re-imports."
                    }
                  >
                    {lastReceipt.aiMapping.fromCache ? "cached" : "AI mapped"}
                  </span>
                )}
                {lastReceipt.aiMapping?.userCorrected && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 text-[11px] font-medium">
                    user-corrected
                  </span>
                )}
              </div>
              {lastReceipt.aiMapping && (
                <details className="mb-2 text-[11px]">
                  <summary className="cursor-pointer text-ink-soft hover:text-foreground">
                    Column mapping ({Object.keys(lastReceipt.aiMapping.aliases).length} fields recognized)
                  </summary>
                  <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-ink-soft font-mono">
                    {Object.entries(lastReceipt.aiMapping.aliases).map(([field, headers]) => (
                      <div key={field}>
                        <span className="text-foreground">{field}</span>
                        <span className="text-ink-soft"> ← {headers.join(" / ")}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 text-ink-soft">
                    This mapping is cached for your spa — every future upload with these exact headers is free + instant.
                  </div>
                </details>
              )}
              <div className="grid grid-cols-4 gap-3 text-xs">
                <ReceiptStat label="Parsed" value={lastReceipt.totalParsed} />
                <ReceiptStat label="Inserted" value={lastReceipt.inserted} />
                <ReceiptStat label="Updated" value={lastReceipt.updated} />
                <ReceiptStat label="Matched patients" value={lastReceipt.patientsMatched} />
              </div>
              {lastReceipt.patientsUnmatched > 0 && (
                <div className="mt-2 text-[11px] text-amber-700">
                  {lastReceipt.patientsUnmatched} appointment{lastReceipt.patientsUnmatched === 1 ? "" : "s"} couldn't match a patient — pre-show reminders skip these. Manually link or wait for the next CSV with phone/email on file.
                </div>
              )}
              {lastReceipt.warnings.length > 0 && (
                <details className="mt-2 text-[11px]">
                  <summary className="cursor-pointer text-ink-soft hover:text-foreground">
                    {lastReceipt.warnings.length} warning{lastReceipt.warnings.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="mt-1 pl-4 list-disc space-y-0.5 text-ink-soft">
                    {lastReceipt.warnings.slice(0, 10).map((w, i) => (
                      <li key={i}>
                        Row {w.sourceRow}: {w.reason}
                      </li>
                    ))}
                    {lastReceipt.warnings.length > 10 && (
                      <li>… and {lastReceipt.warnings.length - 10} more</li>
                    )}
                  </ul>
                </details>
              )}
            </div>
          )}
        </section>

        {/* Appointments list */}
        {appointments === null && !loadError && (
          <div className="flex items-center gap-2 text-sm text-ink-soft py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading appointments…
          </div>
        )}

        {grouped && grouped.today.length === 0 && grouped.upcoming.length === 0 && grouped.past.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-10 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center mb-3">
              <Upload className="h-6 w-6 text-ink-soft" />
            </div>
            <h2 className="text-lg font-semibold text-foreground mb-1">
              No appointments yet
            </h2>
            <p className="text-sm text-ink-soft max-w-md mx-auto">
              Export your schedule from your PMS as CSV and upload above. Emma will
              start running reminder cadences as soon as the first appointment lands.
            </p>
          </div>
        )}

        {grouped && grouped.today.length > 0 && (
          <AppointmentSection
            title="Today"
            appointments={grouped.today}
            onFlip={flipStatus}
            statusBusyId={statusBusyId}
          />
        )}
        {grouped && grouped.upcoming.length > 0 && (
          <AppointmentSection
            title="Upcoming"
            appointments={grouped.upcoming}
            onFlip={flipStatus}
            statusBusyId={statusBusyId}
          />
        )}
        {grouped && grouped.past.length > 0 && (
          <AppointmentSection
            title="Past (review)"
            appointments={grouped.past}
            onFlip={flipStatus}
            statusBusyId={statusBusyId}
            muted
          />
        )}
      </div>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function PatientMatchCoverageRibbon({
  coverage,
  onUpload,
}: {
  coverage: AppointmentMatchCoverage;
  onUpload: () => void;
}) {
  const futureMatchPct =
    coverage.futureTotal > 0
      ? Math.round((coverage.futureMatched / coverage.futureTotal) * 100)
      : 0;
  const hasUnmatched = coverage.futureUnmatched > 0;

  // All-future-linked happy state — quiet emerald ribbon.
  if (!hasUnmatched) {
    return (
      <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-5 py-3 flex items-center gap-3">
        <UserCheck className="h-4 w-4 text-emerald-700 shrink-0" />
        <div className="flex-1 text-sm text-foreground">
          <span className="font-medium">All {coverage.futureTotal} future appointments linked to a patient.</span>
          <span className="text-ink-soft ml-1.5">
            Pre-show reminders and rescue outreach can fire on every row.
          </span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-700/10 text-emerald-800 px-2.5 py-0.5 text-[11px] font-medium tabular-nums shrink-0">
          {futureMatchPct}% matched
        </span>
      </section>
    );
  }

  // Unmatched-present state — amber call-to-action with re-upload CTA.
  return (
    <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="flex items-start gap-3">
        <Link2Off className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="text-sm font-semibold text-foreground">
              {coverage.futureUnmatched} of {coverage.futureTotal} future appointments aren't linked to a patient
            </h3>
            <span className="text-[11px] tabular-nums text-amber-700">
              · {futureMatchPct}% matched
            </span>
          </div>
          <p className="text-xs text-ink-soft mt-1 leading-relaxed">
            Unmatched appointments skip pre-show reminders and rescue outreach.
            Common cause: name variations between your patient list and the
            booking CSV — diacritics, suffixes (Jr/Sr/III), or phone-format
            mismatches. v378 fixed the deterministic gaps; <strong>re-upload
            your appointment CSV</strong> to apply the upgraded matcher to
            existing rows.
          </p>
        </div>
        <button
          type="button"
          onClick={onUpload}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-background px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-500/10 transition shrink-0"
        >
          <Upload className="h-3.5 w-3.5" />
          Re-upload CSV
        </button>
      </div>
    </section>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  muted,
}: {
  icon: typeof CalendarCheck;
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-ink-soft uppercase mb-1.5">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className={cn("text-2xl font-semibold tracking-tight", muted ? "text-ink-soft" : "text-foreground")}>
        {value}
      </div>
    </div>
  );
}

function ReceiptStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-ink-soft text-[10px] uppercase tracking-wider">{label}</div>
      <div className="font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}

function AppointmentSection({
  title,
  appointments,
  onFlip,
  statusBusyId,
  muted,
}: {
  title: string;
  appointments: EmmaAppointment[];
  onFlip: (apt: EmmaAppointment, next: AppointmentStatus) => void;
  statusBusyId: string | null;
  muted?: boolean;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card overflow-hidden", muted && "opacity-80")}>
      <div className="px-5 py-3 border-b border-border bg-muted/30">
        <span className="text-xs font-medium tracking-wider text-ink-soft uppercase">
          {title} · {appointments.length}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {appointments.map((a) => (
          <AppointmentRow
            key={a.id}
            apt={a}
            busy={statusBusyId === a.id}
            onFlip={onFlip}
          />
        ))}
      </ul>
    </section>
  );
}

function AppointmentRow({
  apt,
  busy,
  onFlip,
}: {
  apt: EmmaAppointment;
  busy: boolean;
  onFlip: (apt: EmmaAppointment, next: AppointmentStatus) => void;
}) {
  const when = new Date(apt.scheduledAt);
  return (
    <li className="px-5 py-3 flex items-center gap-3">
      <div className="text-xs text-ink-soft tabular-nums w-28 shrink-0">
        <div className="font-medium text-foreground">
          {/* timeZone:"UTC" pins rendering to the spa-intended clock the Acuity
              import packed into scheduled_at (TZ-naive storage). Same render-side
              pattern as v377.1 / v379.2 — see [[project-acuity-tz-naive-storage]].
              Without it, browsers west of UTC display the wrong clock. (v379.3.) */}
          {when.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "America/Denver" })}
        </div>
        <div>
          {when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" })}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground flex items-center gap-2">
          {apt.patientName ? (
            <>
              <User className="h-3.5 w-3.5 text-ink-soft" />
              {apt.patientName}
            </>
          ) : (
            <span className="text-amber-700 italic">Unmatched patient</span>
          )}
        </div>
        <div className="text-xs text-ink-soft mt-0.5">
          {apt.treatmentType ?? "—"}
          {apt.providerName && <span> · {apt.providerName}</span>}
        </div>
      </div>
      <StatusPill status={apt.status} />
      <div className="flex items-center gap-1 shrink-0">
        {apt.status !== "showed" && (
          <button
            type="button"
            onClick={() => onFlip(apt, "showed")}
            disabled={busy}
            className="p-1.5 rounded hover:bg-emerald-500/10 text-ink-soft hover:text-emerald-700 disabled:opacity-50"
            title="Mark showed"
          >
            <CalendarCheck className="h-4 w-4" />
          </button>
        )}
        {apt.status !== "no_show" && (
          <button
            type="button"
            onClick={() => onFlip(apt, "no_show")}
            disabled={busy}
            className="p-1.5 rounded hover:bg-destructive/10 text-ink-soft hover:text-destructive disabled:opacity-50"
            title="Mark no-show"
          >
            <CalendarX className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function StatusPill({ status }: { status: AppointmentStatus }) {
  const cfg: Record<
    AppointmentStatus,
    { bg: string; fg: string; label: string }
  > = {
    scheduled: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Scheduled" },
    confirmed: {
      bg: "bg-emerald-500/10",
      fg: "text-emerald-700",
      label: "Confirmed",
    },
    cancelled: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Cancelled" },
    no_show: {
      bg: "bg-destructive/10",
      fg: "text-destructive",
      label: "No-show",
    },
    showed: {
      bg: "bg-emerald-500/10",
      fg: "text-emerald-700",
      label: "Showed",
    },
    rescheduled: { bg: "bg-amber-500/10", fg: "text-amber-700", label: "Rescheduled" },
  };
  const c = cfg[status];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
        c.bg,
        c.fg,
      )}
    >
      {c.label}
    </span>
  );
}

function statusLabel(s: AppointmentStatus): string {
  return {
    scheduled: "scheduled",
    confirmed: "confirmed",
    cancelled: "cancelled",
    no_show: "no-show",
    showed: "showed",
    rescheduled: "rescheduled",
  }[s];
}
