/**
 * /app/refill/calendar/staging — Acuity → SmartSpa staging mirror.
 *
 * The onboarding trust step: pull the spa's Acuity structure into SmartSpa's
 * native tables, then show their staged SmartSpa calendar side-by-side with
 * their current Acuity one — same data, hopefully better — so they can cut
 * over with confidence instead of on faith.
 *
 * "Side-by-side" here = a mirror report (what came across, what couldn't map)
 * next to the now-populated native calendar (the trustworthy "after"). We
 * don't iframe live Acuity; we show honest counts from each side + a button
 * to open each. Anything unmappable is flagged, never hidden.
 *
 * Read-only state on load (getMirrorStatusFn); the Mirror button runs
 * stageAcuityMirrorFn. Nothing is destructive — mirrored providers are
 * visualization rows (no login) and aren't bookable until a future cutover.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Columns2,
  ExternalLink,
  Loader2,
  Plug,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { CalendarTabs } from "@/components/refill/CalendarTabs";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getMirrorStatusFn,
  stageAcuityMirrorFn,
  type MirrorStatus,
  type MirrorReport,
} from "@/server/scheduler-mirror.functions";

export const Route = createFileRoute("/app/refill/calendar/staging")({
  component: StagingPage,
});

function StagingPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [mirroring, setMirroring] = useState(false);
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [report, setReport] = useState<MirrorReport | null>(null);

  const loadStatus = useCallback(async () => {
    if (membership.status !== "tenant") return;
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const result = await getMirrorStatusFn({
        data: { accessToken: token, viewAsUserId },
      });
      setStatus(result);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't load staging status.",
      );
    } finally {
      setLoading(false);
    }
  }, [membership.status, viewAsUserId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function runMirror() {
    setMirroring(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const result = await stageAcuityMirrorFn({
        data: { accessToken: token, viewAsUserId },
      });
      setReport(result);
      setStatus({
        acuityConnected: result.acuityConnected,
        accountEmail: result.accountEmail,
        native: result.native,
      });
      const created = result.providers.created + result.services.created;
      toast.success(
        created > 0
          ? `Mirrored ${result.providers.created} provider(s) + ${result.services.created} service(s).`
          : "Mirror up to date — everything already matched.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Mirror failed.");
    } finally {
      setMirroring(false);
    }
  }

  const connected = status?.acuityConnected ?? false;

  return (
    <div>
      <PageHeader
        title="Staging"
        description="Stand up your SmartSpa calendar from your Acuity account, then compare them side-by-side before you cut over. Same appointments, providers and services — mirrored in, nothing changed on Acuity's side."
      />
      <CalendarTabs active="staging" />

      <div className="px-6 lg:px-10 py-6 max-w-3xl w-full mx-auto space-y-5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-[13px] text-ink-soft py-10">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking your Acuity connection…
          </div>
        ) : !connected ? (
          <NotConnected />
        ) : (
          <>
            <MirrorControl
              accountEmail={status?.accountEmail ?? null}
              mirroring={mirroring}
              hasRun={!!report}
              onRun={runMirror}
            />
            {report && <ReportCard report={report} />}
            <CompareStrip native={status?.native ?? null} report={report} />
          </>
        )}
      </div>
    </div>
  );
}

function NotConnected() {
  return (
    <section className="rounded-xl border border-rule bg-white px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-soft">
        <Plug className="h-5 w-5 text-emerald" />
      </div>
      <h2 className="text-[16px] font-semibold text-ink">Connect Acuity first</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-soft leading-relaxed">
        Staging mirrors your Acuity calendars, services and appointments into
        SmartSpa so you can compare the two before cutting over. Connect your
        Acuity account to begin.
      </p>
      <Link
        to="/app/refill/calendar/connections"
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper hover:opacity-95 transition"
      >
        <Plug className="h-4 w-4" />
        Go to Connections
      </Link>
    </section>
  );
}

function MirrorControl({
  accountEmail,
  mirroring,
  hasRun,
  onRun,
}: {
  accountEmail: string | null;
  mirroring: boolean;
  hasRun: boolean;
  onRun: () => void;
}) {
  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="rounded-full bg-emerald-soft p-2 shrink-0">
            <Columns2 className="h-4 w-4 text-emerald" />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-ink">
              Mirror from Acuity
            </div>
            <p className="text-[12px] text-ink-soft mt-0.5">
              {accountEmail ? (
                <>
                  Pulls calendars, services and appointments from{" "}
                  <span className="font-medium text-ink">{accountEmail}</span>.
                  Safe to re-run — it matches what's already here.
                </>
              ) : (
                "Pulls calendars, services and appointments from your connected Acuity account."
              )}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={mirroring}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper hover:opacity-95 transition disabled:opacity-60"
        >
          {mirroring ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : hasRun ? (
            <RefreshCw className="h-4 w-4" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {mirroring ? "Mirroring…" : hasRun ? "Re-run mirror" : "Mirror now"}
        </button>
      </div>
    </section>
  );
}

function ReportCard({ report }: { report: MirrorReport }) {
  const unmappable = [...report.providers.unmappable, ...report.services.unmappable];
  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4 space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald" />
        <h3 className="text-[14px] font-semibold text-ink">Mirror report</h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatBlock
          label="Providers"
          primary={`${report.providers.created} new`}
          secondary={`${report.providers.matched} matched · ${report.providers.fromAcuity} in Acuity`}
        />
        <StatBlock
          label="Services"
          primary={`${report.services.created} new`}
          secondary={`${report.services.matched} matched · ${report.services.skippedInactive} inactive skipped`}
        />
        <StatBlock
          label="Appointments"
          primary={`${report.appointments.linked} linked`}
          secondary={
            report.appointments.stillUnlinked > 0
              ? `${report.appointments.stillUnlinked} still unassigned`
              : "all assigned to a provider"
          }
        />
      </div>

      {unmappable.length > 0 && (
        <div className="rounded-lg border border-rule bg-paper/60 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "#8a6d0c" }}>
            <AlertTriangle className="h-3.5 w-3.5" />
            {unmappable.length} item{unmappable.length === 1 ? "" : "s"} need a look
          </div>
          <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-soft">
            {unmappable.slice(0, 8).map((u, i) => (
              <li key={i}>• {u}</li>
            ))}
            {unmappable.length > 8 && (
              <li className="text-ink-faint">…and {unmappable.length - 8} more</li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

function StatBlock({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: string;
}) {
  return (
    <div className="rounded-lg border border-rule px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint">
        {label}
      </div>
      <div className="text-[15px] font-semibold text-ink mt-0.5">{primary}</div>
      <div className="text-[11px] text-ink-soft mt-0.5 leading-snug">{secondary}</div>
    </div>
  );
}

function CompareStrip({
  native,
  report,
}: {
  native: MirrorStatus["native"] | null;
  report: MirrorReport | null;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {/* Their current world */}
      <section className="rounded-xl border border-rule bg-white px-5 py-4">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint">
          Your Acuity (current)
        </div>
        <p className="text-[13px] text-ink-soft mt-1.5 leading-relaxed">
          {report
            ? `This run read ${report.providers.fromAcuity} calendar(s) and ${report.services.fromAcuity} service type(s) from Acuity.`
            : "Run the mirror to pull your current Acuity calendars and services."}
        </p>
        <a
          href="https://secure.acuityscheduling.com/appointments.php"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-[12px] font-semibold text-ink-soft hover:text-ink transition"
        >
          Open Acuity
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </section>

      {/* The staged SmartSpa world */}
      <section className="rounded-xl border-2 px-5 py-4" style={{ borderColor: "#056048" }}>
        <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: "#056048" }}>
          Your SmartSpa (staged)
        </div>
        {native ? (
          <p className="text-[13px] text-ink-soft mt-1.5 leading-relaxed">
            {native.totalProviders} provider(s) · {native.bookableServices} bookable
            service(s) · {native.linkedAppointments} of {native.totalAppointments}{" "}
            appointment(s) on the calendar.
          </p>
        ) : (
          <p className="text-[13px] text-ink-soft mt-1.5">Loading…</p>
        )}
        <Link
          to="/app/refill/calendar/schedule"
          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper hover:opacity-95 transition"
        >
          <CalendarDays className="h-3.5 w-3.5" />
          Open SmartSpa calendar
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </section>
    </div>
  );
}
