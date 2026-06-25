/**
 * /app/refill/agents/attribution — the Attribution agent operator surface
 * (v1.34.7).
 *
 * Mirrors the v1.34.6 Rescue surface pattern. Karen controls:
 *   - Master enable/disable
 *   - Attribution window (hours) — bookings within N hours of outreach get
 *     credit
 *   - Auto-confirm threshold ($) — recoveries under this amount auto-confirm;
 *     above goes to manual review
 *   - Agent tie-break weights — when multiple agents could claim the same
 *     booking (Rescue + Preshow overlap), weights decide who gets credit
 *
 * Performance card shows 7-day rolling: recoveries attributed, attributed
 * revenue $, manual confirms, unconfirmed.
 *
 * Settings persist as a knowledge_nodes row (node_type='attribution_settings');
 * no migration needed.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  DollarSign,
  Loader2,
  Save,
  Sparkles,
  Target,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getAttributionSettings,
  updateAttributionSettings,
  getAttributionAgentMetrics,
  type AttributionSettings,
  type AttributionMetrics,
} from "@/server/refill-attribution-agent.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/billing/attribution")({
  component: AttributionAgentPage,
});

function AttributionAgentPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [settings, setSettings] = useState<AttributionSettings | null>(null);
  const [metrics, setMetrics] = useState<AttributionMetrics | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [draftWindowHours, setDraftWindowHours] = useState("");
  const [draftThreshold, setDraftThreshold] = useState("");
  const [draftRescue, setDraftRescue] = useState("");
  const [draftPreshow, setDraftPreshow] = useState("");
  const [draftPostRec, setDraftPostRec] = useState("");

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [s, m] = await Promise.all([
        getAttributionSettings({ data: { accessToken: token, viewAsUserId } }),
        getAttributionAgentMetrics({
          data: { accessToken: token, viewAsUserId, windowDays: 7 },
        }),
      ]);
      setSettings(s);
      setMetrics(m);
      setAccessToken(token);
      setDraftWindowHours(String(s.windowHours));
      setDraftThreshold(String(s.autoConfirmThresholdUsd));
      setDraftRescue(String(s.agentWeights.rescue));
      setDraftPreshow(String(s.agentWeights.preshow));
      setDraftPostRec(String(s.agentWeights.post_recovery));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    }
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  async function patch(
    fields: Parameters<typeof updateAttributionSettings>[0]["data"],
  ) {
    if (!accessToken) return;
    try {
      const updated = await updateAttributionSettings({
        data: { ...fields, accessToken, viewAsUserId },
      });
      setSettings(updated);
      return updated;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save.");
    }
  }

  async function toggleEnabled(next: boolean) {
    const updated = await patch({
      accessToken: accessToken!,
      enabled: next,
      viewAsUserId,
    });
    if (updated) {
      toast.success(next ? "Attribution enabled." : "Attribution paused.");
    }
  }

  async function saveWindow() {
    const w = parseInt(draftWindowHours, 10);
    if (!Number.isFinite(w) || w < 1 || w > 720) {
      toast.error("Window must be 1-720 hours.");
      return;
    }
    setSaving(true);
    try {
      const updated = await patch({
        accessToken: accessToken!,
        viewAsUserId,
        windowHours: w,
      });
      if (updated) toast.success("Window saved.");
    } finally {
      setSaving(false);
    }
  }

  async function saveThreshold() {
    const t = parseInt(draftThreshold, 10);
    if (!Number.isFinite(t) || t < 0 || t > 100000) {
      toast.error("Threshold must be 0-100000.");
      return;
    }
    setSaving(true);
    try {
      const updated = await patch({
        accessToken: accessToken!,
        viewAsUserId,
        autoConfirmThresholdUsd: t,
      });
      if (updated) toast.success("Threshold saved.");
    } finally {
      setSaving(false);
    }
  }

  async function saveWeights() {
    const r = parseFloat(draftRescue);
    const p = parseFloat(draftPreshow);
    const pr = parseFloat(draftPostRec);
    for (const [label, v] of [
      ["rescue", r],
      ["preshow", p],
      ["post-recovery", pr],
    ] as const) {
      if (!Number.isFinite(v) || v < 0 || v > 10) {
        toast.error(`${label} weight must be 0-10.`);
        return;
      }
    }
    setSaving(true);
    try {
      const updated = await patch({
        accessToken: accessToken!,
        viewAsUserId,
        agentWeights: { rescue: r, preshow: p, post_recovery: pr },
      });
      if (updated) toast.success("Weights saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Attribution"
        eyebrow="Settings"
        description="Decides which outreach gets credit for a booking."
        breadcrumbs={[
          { label: "Settings", to: "/app/refill/settings/account" },
          { label: "Billing", to: "/app/billing" },
          { label: "Attribution" },
        ]}
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-5">
        {loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">Couldn't load Attribution settings</div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
          </div>
        ) : !settings ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : (
          <>
            {/* Master state */}
            <section
              className={cn(
                "rounded-2xl border bg-white px-5 py-4 flex items-center gap-4",
                settings.enabled ? "border-emerald/40" : "border-amber/40",
              )}
            >
              <div
                className={cn(
                  "h-10 w-10 rounded-full flex items-center justify-center",
                  settings.enabled
                    ? "bg-emerald-soft text-emerald-ink"
                    : "bg-amber-soft text-amber-ink",
                )}
              >
                <Target className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-ink">
                  {settings.enabled ? "Attribution is on" : "Attribution is paused"}
                </div>
                <p className="text-xs text-ink-soft mt-0.5">
                  {settings.enabled
                    ? "When a booking happens within the attribution window of an outreach, Refill records the recovery + attributes revenue."
                    : "Recoveries aren't recorded automatically. The Recovery surface will appear sparser."}
                </p>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) => void toggleEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-rule rounded-full peer peer-checked:bg-emerald transition relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition peer-checked:after:translate-x-5" />
              </label>
            </section>

            {/* Performance card */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Last 7 days
                </div>
              </header>
              <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-rule">
                <Metric
                  label="Recoveries"
                  value={metrics?.recoveriesAttributed ?? 0}
                />
                <Metric
                  label="Revenue"
                  value={
                    metrics
                      ? `$${metrics.attributedRevenueUsd.toLocaleString()}`
                      : "—"
                  }
                  tone="emerald"
                />
                <Metric
                  label="Manual confirms"
                  value={metrics?.manualConfirms ?? 0}
                />
                <Metric
                  label="Unconfirmed"
                  value={metrics?.unconfirmed ?? 0}
                  tone={metrics && metrics.unconfirmed > 0 ? "amber" : "default"}
                />
              </div>
              <div className="px-5 py-2.5 border-t border-rule bg-paper/30">
                <Link
                  to="/app/refill/recovery"
                  className="text-[11px] text-emerald-ink hover:underline"
                >
                  Open Recovery surface →
                </Link>
              </div>
            </section>

            {/* Attribution window */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Attribution window
                </div>
              </header>
              <div className="px-5 py-4 space-y-2">
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft">
                  Hours from outreach to booking
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={draftWindowHours}
                    onChange={(e) => setDraftWindowHours(e.target.value)}
                    className="w-32 rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  />
                  <span className="text-[12px] text-ink-soft">hours</span>
                  <button
                    type="button"
                    onClick={() => void saveWindow()}
                    disabled={saving}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    Save
                  </button>
                </div>
                <p className="text-[10px] text-ink-faint">
                  A booking that happens within this window after a recovery
                  outreach gets credit. 72 = 3 days, 168 = 1 week, 720 = 30 days.
                </p>
              </div>
            </section>

            {/* Auto-confirm threshold */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <DollarSign className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Auto-confirm threshold
                </div>
              </header>
              <div className="px-5 py-4 space-y-2">
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft">
                  Recoveries under $X auto-confirm
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-ink-soft">$</span>
                  <input
                    type="number"
                    min={0}
                    max={100000}
                    value={draftThreshold}
                    onChange={(e) => setDraftThreshold(e.target.value)}
                    className="w-32 rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  />
                  <button
                    type="button"
                    onClick={() => void saveThreshold()}
                    disabled={saving}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    Save
                  </button>
                </div>
                <p className="text-[10px] text-ink-faint">
                  Recoveries below this dollar amount auto-confirm and post to
                  your dashboard. Anything at or above goes to manual review on
                  the Recovery surface. Set to 0 to auto-confirm every recovery.
                </p>
              </div>
            </section>

            {/* Agent tie-break weights */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Agent tie-break weights
                </div>
                <div className="ml-auto text-[10px] text-ink-faint italic">
                  When multiple agents could claim the same booking
                </div>
              </header>
              <div className="px-5 py-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <WeightField
                    label="Rescue"
                    value={draftRescue}
                    onChange={setDraftRescue}
                  />
                  <WeightField
                    label="Preshow"
                    value={draftPreshow}
                    onChange={setDraftPreshow}
                  />
                  <WeightField
                    label="Post-recovery"
                    value={draftPostRec}
                    onChange={setDraftPostRec}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void saveWeights()}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save weights
                </button>
                <p className="text-[10px] text-ink-faint">
                  Higher weight wins a tie. Default: Rescue 1.0 (direct
                  cancellation → fill is highest-signal), Post-recovery 0.8,
                  Preshow 0.5 (reminders are more diffuse). Set a weight to 0
                  to never give that agent credit.
                </p>
              </div>
            </section>

            {/* Help footer */}
            <section className="rounded-xl border border-dashed border-rule bg-paper/50 px-5 py-4 text-[12px] text-ink-soft flex gap-3">
              <AlertTriangle className="h-4 w-4 text-amber shrink-0 mt-0.5" />
              <div>
                <strong className="text-ink">How Attribution works</strong> —
                when an outreach goes out (Rescue offer, Preshow reminder,
                Post-recovery follow-up) and the patient books within the
                attribution window, Refill records a <code>recovery_event</code>
                with the agent type + revenue. If multiple agents are eligible,
                weights break the tie. Below the threshold, recoveries
                auto-confirm; above, you review on the Recovery surface.
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "default" | "emerald" | "amber";
}) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold mt-0.5",
          tone === "emerald"
            ? "text-emerald-ink"
            : tone === "amber"
              ? "text-amber-ink"
              : "text-ink",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function WeightField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1.5">
        {label}
      </label>
      <input
        type="number"
        step="0.1"
        min={0}
        max={10}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
      />
    </div>
  );
}
