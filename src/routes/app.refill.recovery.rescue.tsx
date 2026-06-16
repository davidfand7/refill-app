/**
 * /app/refill/agents/rescue — the Rescue agent operator surface (v1.34.6).
 *
 * Mirrors /app/refill/agents/preshow's operator-transparency framing but
 * Rescue stays single-policy per spa (no Rescue PROFILES). Karen controls:
 *   - Master enable/disable
 *   - Eligible treatment-types (which appointments trigger rescue offers)
 *   - Max concurrent offers per spa
 *   - Outreach window (how long an offer stays claimable)
 *   - Proxy phone + email (the masked routing addresses Refill uses)
 *
 * Performance card shows 7-day rolling sent/claimed/expired counters +
 * conversion rate.
 *
 * Dispatch logic itself lives in src/server/emma-rescue.functions.ts and
 * is unchanged in v1.34.6 — this is read/write for the spa-owner surface.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  Phone,
  Save,
  Sparkles,
  Users,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { RefillSolutionTabs } from "@/components/refill/RefillSolutionTabs";
import { RescueReviewQueue } from "@/components/refill/RescueReviewQueue";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getRescuePolicy,
  updateRescuePolicy,
  getRescueAgentMetrics,
  type RescuePolicy,
  type RescueAgentMetrics,
} from "@/server/refill-rescue-agent.functions";
import { simulateRescueDispatchFn } from "@/server/emma-rescue.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/recovery/rescue")({
  component: RescueAgentPage,
});

function RescueAgentPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [policy, setPolicy] = useState<RescuePolicy | null>(null);
  const [metrics, setMetrics] = useState<RescueAgentMetrics | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Local draft of fields that need an explicit Save (number inputs +
  // text inputs). Toggle + chip operations write through immediately.
  const [draftMaxConcurrent, setDraftMaxConcurrent] = useState("");
  const [draftOutreachWindowMin, setDraftOutreachWindowMin] = useState("");
  const [draftProxyPhone, setDraftProxyPhone] = useState("");
  const [draftProxyEmail, setDraftProxyEmail] = useState("");
  const [newTreatment, setNewTreatment] = useState("");
  const [simulating, setSimulating] = useState(false);

  // Admin-only go-live test: fire a REAL rescue (insert a throwaway cancelled
  // slot + run the webhook's dispatch path) without cancelling a live Acuity
  // appt. Only when an operator is viewing-as a spa (membership 'tenant').
  const isAdminView = membership.status === "tenant";
  const simulate = useCallback(async () => {
    if (!accessToken) return;
    setSimulating(true);
    try {
      const res = await simulateRescueDispatchFn({
        data: { accessToken, viewAsUserId },
      });
      if (res.ok) {
        toast.success(
          `Rescue fired — ${res.offersSent} offer${res.offersSent === 1 ? "" : "s"} sent to the proxy inbox. (test slot ${res.testAppointmentId.slice(0, 8)})`,
        );
      } else {
        toast.warning(`Rescue didn't send: ${res.reason ?? "unknown"}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't simulate a rescue.");
    } finally {
      setSimulating(false);
    }
  }, [accessToken, viewAsUserId]);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [p, m] = await Promise.all([
        getRescuePolicy({ data: { accessToken: token, viewAsUserId } }),
        getRescueAgentMetrics({
          data: { accessToken: token, viewAsUserId, windowDays: 7 },
        }),
      ]);
      setPolicy(p);
      setMetrics(m);
      setAccessToken(token);
      if (p) {
        setDraftMaxConcurrent(String(p.maxConcurrent));
        setDraftOutreachWindowMin(String(p.outreachWindowMin));
        setDraftProxyPhone(p.proxyPhone ?? "");
        setDraftProxyEmail(p.proxyEmail ?? "");
      }
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
    fields: Parameters<typeof updateRescuePolicy>[0]["data"],
  ) {
    if (!accessToken) return;
    try {
      const updated = await updateRescuePolicy({
        data: { ...fields, accessToken, viewAsUserId },
      });
      setPolicy(updated);
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
      toast.success(next ? "Rescue agent enabled." : "Rescue agent paused.");
    }
  }

  async function addTreatment() {
    const t = newTreatment.trim().toLowerCase();
    if (!t) {
      toast.error("Enter a treatment type.");
      return;
    }
    if (!policy) return;
    if (policy.eligibleTreatments.includes(t)) {
      toast.error(`'${t}' is already eligible.`);
      return;
    }
    const updated = await patch({
      accessToken: accessToken!,
      viewAsUserId,
      eligibleTreatments: [...policy.eligibleTreatments, t],
    });
    if (updated) {
      setNewTreatment("");
    }
  }

  async function removeTreatment(t: string) {
    if (!policy) return;
    await patch({
      accessToken: accessToken!,
      viewAsUserId,
      eligibleTreatments: policy.eligibleTreatments.filter((x) => x !== t),
    });
  }

  async function saveNumberInputs() {
    if (!policy) return;
    setSaving(true);
    try {
      const maxC = parseInt(draftMaxConcurrent, 10);
      const winMin = parseInt(draftOutreachWindowMin, 10);
      if (!Number.isFinite(maxC) || maxC < 0 || maxC > 50) {
        toast.error("Max concurrent must be 0-50.");
        return;
      }
      if (!Number.isFinite(winMin) || winMin < 1 || winMin > 43200) {
        toast.error("Outreach window must be 1-43200 minutes.");
        return;
      }
      const updated = await patch({
        accessToken: accessToken!,
        viewAsUserId,
        maxConcurrent: maxC,
        outreachWindowMin: winMin,
      });
      if (updated) toast.success("Saved.");
    } finally {
      setSaving(false);
    }
  }

  async function saveProxyInputs() {
    if (!policy) return;
    setSaving(true);
    try {
      const updated = await patch({
        accessToken: accessToken!,
        viewAsUserId,
        proxyPhone: draftProxyPhone.trim() || null,
        proxyEmail: draftProxyEmail.trim() || null,
      });
      if (updated) toast.success("Proxy contacts saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Rescue"
        eyebrow="Refill"
        description="Fills cancelled slots from your waitlist before they go dark."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill/recovery" },
          { label: "Rescue" },
        ]}
        actions={
          isAdminView ? (
            <button
              type="button"
              onClick={() => void simulate()}
              disabled={simulating || !accessToken}
              title="Insert a throwaway cancelled slot and fire the real rescue dispatch — no live Acuity cancellation needed."
              className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 text-[13px] font-semibold text-ink-soft hover:text-ink transition disabled:opacity-60"
            >
              {simulating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Simulate a cancellation
            </button>
          ) : undefined
        }
      />
      <RefillSolutionTabs active="rescue" />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-5">
        {loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">Couldn't load Rescue settings</div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
          </div>
        ) : !policy ? (
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
                policy.enabled ? "border-emerald/40" : "border-amber/40",
              )}
            >
              <div
                className={cn(
                  "h-10 w-10 rounded-full flex items-center justify-center",
                  policy.enabled
                    ? "bg-emerald-soft text-emerald-ink"
                    : "bg-amber-soft text-amber-ink",
                )}
              >
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-ink">
                  {policy.enabled ? "Rescue is on" : "Rescue is paused"}
                </div>
                <p className="text-xs text-ink-soft mt-0.5">
                  {policy.enabled
                    ? "When an appointment cancels, Refill texts your waitlist with a tap-to-claim offer for the open slot."
                    : "Cancellations won't be re-offered until you turn Rescue back on."}
                </p>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={(e) => void toggleEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-rule rounded-full peer peer-checked:bg-emerald transition relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition peer-checked:after:translate-x-5" />
              </label>
            </section>

            {/* Confidence gate: low-confidence direct-mode fits held for the
                owner's one-tap OK (self-hides when the queue is empty). */}
            <RescueReviewQueue
              accessToken={accessToken}
              viewAsUserId={viewAsUserId}
              onChanged={() => void load()}
            />

            {/* Performance card */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Last 7 days
                </div>
              </header>
              <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-rule">
                <Metric label="Offers sent" value={metrics?.offersSent ?? 0} />
                <Metric
                  label="Claimed"
                  value={metrics?.offersClaimed ?? 0}
                  tone="emerald"
                />
                <Metric label="Expired" value={metrics?.offersExpired ?? 0} />
                <Metric
                  label="Conversion"
                  value={
                    metrics
                      ? `${Math.round(metrics.conversionRate * 100)}%`
                      : "—"
                  }
                  tone="emerald"
                />
              </div>
            </section>

            {/* Eligible treatments */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Users className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Eligible treatments
                </div>
                <div className="ml-auto text-[10px] text-ink-faint italic">
                  Only these appointments trigger rescue offers
                </div>
              </header>
              <div className="px-5 py-4 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {policy.eligibleTreatments.length === 0 && (
                    <span className="text-[11px] text-ink-faint italic">
                      No eligible treatments yet — Rescue will skip every cancellation.
                    </span>
                  )}
                  {policy.eligibleTreatments.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full bg-emerald-soft text-emerald-ink px-3 py-1 text-[11px] font-semibold capitalize"
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() => void removeTreatment(t)}
                        className="ml-0.5 hover:text-rose transition"
                        title="Remove"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newTreatment}
                    onChange={(e) => setNewTreatment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addTreatment();
                      }
                    }}
                    placeholder="treatment type (e.g., botox, filler, laser)"
                    maxLength={80}
                    className="flex-1 rounded border border-rule bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  />
                  <button
                    type="button"
                    onClick={() => void addTreatment()}
                    className="inline-flex items-center gap-1 rounded border border-emerald/30 bg-emerald-soft text-emerald-ink px-3 py-1 text-[11px] font-medium hover:bg-emerald hover:text-paper transition"
                  >
                    Add
                  </button>
                </div>
                <p className="text-[10px] text-ink-faint">
                  Treatment-type names are case-insensitive and matched against{" "}
                  <code>emma_appointments.treatment_type</code>.
                </p>
              </div>
            </section>

            {/* Limits */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Limits
                </div>
              </header>
              <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1.5">
                    Max concurrent offers
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={draftMaxConcurrent}
                    onChange={(e) => setDraftMaxConcurrent(e.target.value)}
                    className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  />
                  <p className="text-[10px] text-ink-faint mt-1">
                    How many open rescue offers can be live at once across your whole spa. 0 pauses (use toggle above).
                  </p>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1.5">
                    Outreach window (minutes)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={43200}
                    value={draftOutreachWindowMin}
                    onChange={(e) => setDraftOutreachWindowMin(e.target.value)}
                    className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  />
                  <p className="text-[10px] text-ink-faint mt-1">
                    How long the claim-link stays live after the offer is sent. 240 = 4 hours, 1440 = 24 hours.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <button
                    type="button"
                    onClick={() => void saveNumberInputs()}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    Save limits
                  </button>
                </div>
              </div>
            </section>

            {/* Proxy contacts */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Bell className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Proxy contacts
                </div>
                <div className="ml-auto text-[10px] text-ink-faint italic">
                  Replies route here when patients claim a slot
                </div>
              </header>
              <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1.5">
                    Proxy phone
                  </label>
                  <div className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-ink-soft shrink-0" />
                    <input
                      type="tel"
                      value={draftProxyPhone}
                      onChange={(e) => setDraftProxyPhone(e.target.value)}
                      placeholder="+1 555 123 4567"
                      className="flex-1 rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1.5">
                    Proxy email
                  </label>
                  <div className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5 text-ink-soft shrink-0" />
                    <input
                      type="email"
                      value={draftProxyEmail}
                      onChange={(e) => setDraftProxyEmail(e.target.value)}
                      placeholder="bookings@yourspa.com"
                      className="flex-1 rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                    />
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <button
                    type="button"
                    onClick={() => void saveProxyInputs()}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    Save proxy
                  </button>
                </div>
              </div>
            </section>

            {/* Help footer */}
            <section className="rounded-xl border border-dashed border-rule bg-paper/50 px-5 py-4 text-[12px] text-ink-soft flex gap-3">
              <AlertTriangle className="h-4 w-4 text-amber shrink-0 mt-0.5" />
              <div>
                <strong className="text-ink">How Rescue works</strong> — when an
                appointment in an Eligible-treatment category gets cancelled or
                marked no-show, Refill drafts a rescue offer and texts your
                waitlist with a one-tap claim link. First tap wins; everyone
                else sees "slot taken" gracefully. Max concurrent stops Refill
                from spamming your whole list when many cancellations land at
                once.
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
  tone?: "default" | "emerald";
}) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold mt-0.5",
          tone === "emerald" ? "text-emerald-ink" : "text-ink",
        )}
      >
        {value}
      </div>
    </div>
  );
}
