/**
 * /app/refill/agents/preshow — the Preshow agent operator surface (v1.34.3).
 *
 * Per the 2026-06-02 architecture lock: Karen sees her Preshow agent
 * as a thing she controls, not a black box. Multiple cadence PROFILES
 * (Default + Chronic + custom), unlimited touchpoints, per-touchpoint
 * custom messages with variable substitution, tone + channel per
 * profile. The reframe from /app/refill/settings/noshow → /agents/preshow
 * captures the strategic shift from "feature flags" (admin meta-control)
 * to operator-shaped agent transparency.
 *
 * v1.34.3 MVP: profile mgmt + cadence + messages + state toggle +
 * performance counters.
 * Deferred to v1.34.3.1: patient routing UI (bulk-tag picker + per-patient
 * profile assignment).
 * Deferred to v1.34.4: per-treatment-type cadence overrides.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Award,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit2,
  Layers,
  Loader2,
  MessageSquareText,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { RefillSolutionTabs } from "@/components/refill/RefillSolutionTabs";
import { NoShowDefinitionCard } from "@/components/refill/NoShowDefinitionCard";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getNoShowPolicy,
  updateNoShowPolicy,
  type NoShowPolicy,
} from "@/server/emma-appointments.functions";
import {
  createPreshowProfile,
  deletePreshowMessageTemplate,
  deletePreshowProfile,
  getPreshowPerformanceMetrics,
  listPreshowProfiles,
  listPreshowTemplates,
  setDefaultPreshowProfile,
  updatePreshowProfile,
  upsertPreshowMessageTemplate,
  type PreshowChannel,
  type PreshowMessageTemplate,
  type PreshowProfile,
  type PreshowProfileMetrics,
  type PreshowTone,
} from "@/server/refill-preshow-agent.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/recovery/preshow")({
  component: PreshowAgentPage,
});

const TONE_OPTIONS: Array<{ value: PreshowTone; label: string; hint: string }> = [
  { value: "warm", label: "Warm", hint: "Friendly + casual" },
  { value: "professional", label: "Professional", hint: "Direct + formal" },
  { value: "casual", label: "Casual", hint: "Short + relaxed" },
];

const CHANNEL_OPTIONS: Array<{ value: PreshowChannel; label: string; hint: string }> = [
  { value: "auto", label: "Auto", hint: "SMS first, fall back to email" },
  { value: "sms", label: "SMS only", hint: "Phone required" },
  { value: "email", label: "Email only", hint: "Email required" },
];

const VARIABLE_CHIPS = [
  { token: "{{patient.firstName}}", hint: "Patient's first name" },
  { token: "{{appt.dateTime}}", hint: "Full appointment time" },
  { token: "{{appt.time}}", hint: "Time only" },
  { token: "{{appt.treatmentType}}", hint: "What they're scheduled for" },
  { token: "{{appt.providerName}}", hint: "Their provider" },
  { token: "{{spa.name}}", hint: "Your spa name" },
];

function PreshowAgentPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [policy, setPolicy] = useState<NoShowPolicy | null>(null);
  const [profiles, setProfiles] = useState<PreshowProfile[] | null>(null);
  const [templates, setTemplates] = useState<PreshowMessageTemplate[]>([]);
  const [metrics, setMetrics] = useState<PreshowProfileMetrics[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [cloneFromId, setCloneFromId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [p, profs, tmpls, ms] = await Promise.all([
        getNoShowPolicy({ data: { accessToken: token, viewAsUserId } }),
        listPreshowProfiles({ data: { accessToken: token, viewAsUserId } }),
        listPreshowTemplates({ data: { accessToken: token, viewAsUserId } }),
        getPreshowPerformanceMetrics({
          data: { accessToken: token, viewAsUserId, windowDays: 7 },
        }),
      ]);
      setPolicy(p);
      setProfiles(profs);
      setTemplates(tmpls);
      setMetrics(ms);
      setAccessToken(token);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    }
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  async function toggleEnabled(next: boolean) {
    if (!accessToken || !policy) return;
    try {
      const updated = await updateNoShowPolicy({
        data: {
          accessToken,
          patch: { preshowEnabled: next } as never,
          viewAsUserId,
        },
      });
      setPolicy(updated);
      toast.success(next ? "Preshow agent enabled." : "Preshow agent paused.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't toggle.");
    }
  }

  async function handleCreateProfile(e: FormEvent) {
    e.preventDefault();
    if (!accessToken) return;
    const name = newProfileName.trim();
    if (!name) {
      toast.error("Name your profile.");
      return;
    }
    setCreating(true);
    try {
      const created = await createPreshowProfile({
        data: {
          accessToken,
          viewAsUserId,
          name,
          cloneFromProfileId: cloneFromId ?? undefined,
        },
      });
      setProfiles((prev) => (prev ? [...prev, created] : [created]));
      setNewProfileName("");
      setShowNewProfile(false);
      setCloneFromId(null);
      // Reload templates if we cloned (they were copied server-side)
      if (cloneFromId) {
        const tmpls = await listPreshowTemplates({
          data: { accessToken, viewAsUserId },
        });
        setTemplates(tmpls);
      }
      toast.success(`Profile "${created.name}" created.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create.");
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateProfile(
    id: string,
    patch: Parameters<typeof updatePreshowProfile>[0]["data"],
  ) {
    if (!accessToken) return;
    try {
      const updated = await updatePreshowProfile({
        data: { ...patch, accessToken, viewAsUserId, profileId: id },
      });
      setProfiles((prev) =>
        prev ? prev.map((p) => (p.id === id ? updated : p)) : prev,
      );
      toast.success("Profile updated.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update.");
    }
  }

  async function handleSetDefault(id: string) {
    if (!accessToken) return;
    try {
      await setDefaultPreshowProfile({
        data: { accessToken, viewAsUserId, profileId: id },
      });
      setProfiles((prev) =>
        prev
          ? prev.map((p) => ({ ...p, isDefault: p.id === id }))
          : prev,
      );
      toast.success("Default profile changed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't set default.");
    }
  }

  async function handleDeleteProfile(id: string) {
    if (!accessToken) return;
    const target = profiles?.find((p) => p.id === id);
    if (!target) return;
    if (!window.confirm(`Delete profile "${target.name}"? This can't be undone.`)) {
      return;
    }
    try {
      await deletePreshowProfile({
        data: { accessToken, viewAsUserId, profileId: id },
      });
      setProfiles((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
      setTemplates((prev) => prev.filter((t) => t.profileId !== id));
      toast.success(`Profile "${target.name}" deleted.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete.");
    }
  }

  async function handleSaveTemplate(
    profileId: string,
    offsetHours: number,
    bodyTemplate: string,
  ) {
    if (!accessToken) return;
    try {
      const saved = await upsertPreshowMessageTemplate({
        data: {
          accessToken,
          viewAsUserId,
          profileId,
          offsetHours,
          bodyTemplate,
        },
      });
      setTemplates((prev) => {
        const idx = prev.findIndex(
          (t) => t.profileId === profileId && t.offsetHours === offsetHours,
        );
        if (idx === -1) return [...prev, saved];
        const next = [...prev];
        next[idx] = saved;
        return next;
      });
      toast.success("Message saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save.");
    }
  }

  async function handleResetTemplate(templateId: string) {
    if (!accessToken) return;
    try {
      await deletePreshowMessageTemplate({
        data: { accessToken, viewAsUserId, templateId },
      });
      setTemplates((prev) => prev.filter((t) => t.id !== templateId));
      toast.success("Reset to default message.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't reset.");
    }
  }

  const totalTouchpoints = useMemo(
    () =>
      (profiles ?? []).reduce((acc, p) => acc + p.cadenceHours.length, 0),
    [profiles],
  );

  if (profiles === null && !loadError) {
    return (
      <div>
        <PageHeader
          eyebrow="Refill"
          title="Reminders"
          description="Reminders before every appointment — turn confirmed-on-time into your default."
        />
        <RefillSolutionTabs active="reminders" />
        <div className="px-6 lg:px-10 py-14 flex items-center justify-center gap-2 text-sm text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Refill"
        title="Reminders"
        description="Reminders before every appointment. Tune the cadence, customize the messages, route different patient cohorts to different schedules. Most spas use one profile; some use two or three."
      />
      <RefillSolutionTabs active="reminders" />

      <div className="px-6 lg:px-10 py-6 space-y-6 max-w-[960px] mx-auto">
        {loadError && (
          <div className="rounded-xl border border-rose/30 bg-rose-soft px-4 py-3 text-sm text-rose">
            {loadError}
          </div>
        )}

        {/* State strip */}
        {policy && (
          <StateStrip
            enabled={policy.preshowEnabled}
            profileCount={profiles?.length ?? 0}
            totalTouchpoints={totalTouchpoints}
            onToggle={toggleEnabled}
          />
        )}

        {/* Performance counters (7-day rolling) */}
        {metrics.length > 0 && <PerformanceCard metrics={metrics[0]!} />}

        {/* What it does (plain English) */}
        <WhatItDoes
          enabled={policy?.preshowEnabled ?? false}
          profileCount={profiles?.length ?? 0}
        />

        {/* No-show definition & Reschedule Reminders (v2.34.0) */}
        <NoShowDefinitionCard accessToken={accessToken} viewAsUserId={viewAsUserId} />

        {/* Profiles section */}
        <section>
          <header className="flex items-end justify-between gap-3 mb-3">
            <div>
              <h2 className="text-lg font-semibold text-ink tracking-tight">
                Cadence profiles
              </h2>
              <p className="text-xs text-ink-soft mt-0.5">
                A profile = one schedule of reminders. Most spas need just the
                Default. Use additional profiles for cohorts that need
                different cadences (chronic cancellers, VIPs, first-visit patients, etc.).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowNewProfile(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
            >
              <Plus className="h-3 w-3" />
              New profile
            </button>
          </header>

          {/* New profile form */}
          {showNewProfile && (
            <form
              onSubmit={handleCreateProfile}
              className="mb-4 rounded-xl border border-emerald/40 bg-emerald-soft/20 p-4 space-y-3"
            >
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                  Profile name
                </label>
                <input
                  type="text"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  placeholder="e.g. Chronic · VIP-lite · First-visit"
                  maxLength={80}
                  required
                  autoFocus
                  className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                />
              </div>
              {profiles && profiles.length > 0 && (
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                    Start from (optional)
                  </label>
                  <select
                    value={cloneFromId ?? ""}
                    onChange={(e) => setCloneFromId(e.target.value || null)}
                    className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  >
                    <option value="">Start blank (48h / 24h / 3h default)</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        Clone from "{p.name}"
                        {p.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewProfile(false);
                    setNewProfileName("");
                    setCloneFromId(null);
                  }}
                  disabled={creating}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-ink transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-xs font-semibold text-paper hover:opacity-90 transition disabled:opacity-60"
                >
                  {creating ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  Create profile
                </button>
              </div>
            </form>
          )}

          {/* Profile cards */}
          <div className="space-y-4">
            {(profiles ?? []).map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                templates={templates.filter((t) => t.profileId === profile.id)}
                onUpdate={(patch) => handleUpdateProfile(profile.id, patch)}
                onSetDefault={() => handleSetDefault(profile.id)}
                onDelete={() => handleDeleteProfile(profile.id)}
                onSaveTemplate={(offsetHours, bodyTemplate) =>
                  handleSaveTemplate(profile.id, offsetHours, bodyTemplate)
                }
                onResetTemplate={handleResetTemplate}
              />
            ))}
          </div>
        </section>

        {/* Patient assignment hint (v1.34.3.1 routing shipped) */}
        <div className="rounded-xl border border-rule bg-rule-soft/50 p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="h-4 w-4 text-emerald shrink-0 mt-0.5" />
            <div className="text-xs text-ink-soft leading-relaxed">
              <strong className="text-ink">Route patients to specific profiles.</strong>{" "}
              By default every patient gets the Default profile&rsquo;s cadence.
              To route a cohort to a non-default profile (e.g. send chronic
              reschedulers through the Chronic profile), use the{" "}
              <Link
                to="/app/refill/patients"
                className="text-emerald-ink underline hover:no-underline"
              >
                Patient list
              </Link>
              &rsquo;s bulk-tag picker (select N patients &rarr; Apply soft tag
              &rarr; Preshow profile), or pick a profile inline on any
              individual patient&rsquo;s detail page. Dispatch reads the routing
              on every reminder; if a routed profile is deleted, the patient
              falls back to Default automatically.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── State strip ──────────────────────────────────────────────────────────

function StateStrip({
  enabled,
  profileCount,
  totalTouchpoints,
  onToggle,
}: {
  enabled: boolean;
  profileCount: number;
  totalTouchpoints: number;
  onToggle: (next: boolean) => Promise<void>;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-5 py-4 flex items-center justify-between gap-4",
        enabled
          ? "border-emerald/30 bg-emerald-soft/40"
          : "border-rule bg-white",
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={cn(
            "h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
            enabled ? "bg-emerald/20" : "bg-rule",
          )}
        >
          <Bell
            className={cn(
              "h-5 w-5",
              enabled ? "text-emerald" : "text-ink-soft",
            )}
          />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">
            {enabled ? "Preshow is active" : "Preshow is paused"}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            {enabled
              ? `${profileCount} ${profileCount === 1 ? "profile" : "profiles"} · ${totalTouchpoints} total touchpoints firing`
              : "No reminders going out. Toggle on to resume."}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        aria-pressed={enabled}
        aria-label={enabled ? "Pause Preshow" : "Enable Preshow"}
        className={cn(
          "relative inline-flex h-7 w-12 items-center rounded-full transition shrink-0",
          enabled ? "bg-emerald" : "bg-rule",
        )}
      >
        <span
          className={cn(
            "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
            enabled ? "translate-x-[26px]" : "translate-x-[3px]",
          )}
        />
      </button>
    </div>
  );
}

// ─── What-it-does ─────────────────────────────────────────────────────────

function WhatItDoes({
  enabled,
  profileCount,
}: {
  enabled: boolean;
  profileCount: number;
}) {
  if (!enabled) {
    return (
      <div className="rounded-xl border border-amber/30 bg-amber-soft/40 px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-amber shrink-0 mt-0.5" />
        <div className="text-xs text-ink leading-relaxed">
          Preshow is paused. Patients aren't getting reminders. When you're
          ready, toggle it back on and the cadence profile(s) below resume
          immediately.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-rule bg-white px-4 py-3">
      <div className="text-xs text-ink-soft leading-relaxed">
        Refill is reminding your patients before every appointment on the
        cadence{profileCount > 1 ? "s" : ""} below.{" "}
        {profileCount === 1
          ? "All patients use your Default profile."
          : `${profileCount} profiles configured — Default applies until patient-routing ships (v1.34.3.1).`}{" "}
        Reminders go via SMS first (falling back to email when there's no
        phone on file), and the messages can be tuned per touchpoint with
        your spa's voice.
      </div>
    </div>
  );
}

// ─── Performance card ─────────────────────────────────────────────────────

function PerformanceCard({ metrics }: { metrics: PreshowProfileMetrics }) {
  return (
    <div className="rounded-2xl border border-rule bg-white p-5">
      <header className="text-xs font-semibold uppercase tracking-wider text-ink-soft mb-3">
        Last 7 days
      </header>
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Reminders sent" value={metrics.sent} tone="default" />
        <Stat
          label="Confirmed"
          value={metrics.confirmed}
          tone={metrics.confirmed > 0 ? "good" : "default"}
        />
        <Stat
          label="Cancelled"
          value={metrics.cancelledAfterReminder}
          tone={metrics.cancelledAfterReminder > 0 ? "warn" : "default"}
        />
      </div>
      <p className="text-[10px] text-ink-faint mt-3">
        A before-vs-after trend appears here once you&apos;ve built up about a
        month of reminder history.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "good" | "warn";
}) {
  return (
    <div>
      <div
        className={cn(
          "text-2xl font-semibold tabular-nums tracking-tight",
          tone === "good" && "text-emerald-ink",
          tone === "warn" && "text-amber",
          tone === "default" && "text-ink",
        )}
      >
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] text-ink-soft mt-0.5">{label}</div>
    </div>
  );
}

// ─── Profile card ─────────────────────────────────────────────────────────

function ProfileCard({
  profile,
  templates,
  onUpdate,
  onSetDefault,
  onDelete,
  onSaveTemplate,
  onResetTemplate,
}: {
  profile: PreshowProfile;
  templates: PreshowMessageTemplate[];
  onUpdate: (patch: {
    name?: string;
    cadenceHours?: number[];
    cadenceByTreatmentType?: Record<string, number[]>;
    tone?: PreshowTone;
    channel?: PreshowChannel;
  }) => Promise<void>;
  onSetDefault: () => Promise<void>;
  onDelete: () => Promise<void>;
  onSaveTemplate: (offsetHours: number, bodyTemplate: string) => Promise<void>;
  onResetTemplate: (templateId: string) => Promise<void>;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile.name);
  const [showMessages, setShowMessages] = useState(false);
  const [newOffset, setNewOffset] = useState("");
  // v1.34.4: per-treatment-type cadence overrides
  const [showOverrides, setShowOverrides] = useState(false);
  const [newTreatmentType, setNewTreatmentType] = useState("");
  const [newTreatmentHours, setNewTreatmentHours] = useState("");

  const treatmentOverrideEntries = useMemo(
    () => Object.entries(profile.cadenceByTreatmentType ?? {}),
    [profile.cadenceByTreatmentType],
  );

  function parseCadenceCsv(raw: string): number[] | null {
    const parts = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    const out: number[] = [];
    for (const p of parts) {
      const n = parseInt(p, 10);
      if (!Number.isFinite(n) || n < 0 || n > 8760) return null;
      if (!out.includes(n)) out.push(n);
    }
    return out.sort((a, b) => b - a);
  }

  function addTreatmentOverride() {
    const type = newTreatmentType.trim().toLowerCase();
    if (!type) {
      toast.error("Enter a treatment type (e.g., botox, filler, laser).");
      return;
    }
    const hours = parseCadenceCsv(newTreatmentHours);
    if (!hours || hours.length === 0) {
      toast.error("Enter cadence hours like: 72, 24, 12");
      return;
    }
    const next = { ...(profile.cadenceByTreatmentType ?? {}), [type]: hours };
    void onUpdate({ cadenceByTreatmentType: next });
    setNewTreatmentType("");
    setNewTreatmentHours("");
  }

  function removeTreatmentOverride(type: string) {
    const next = { ...(profile.cadenceByTreatmentType ?? {}) };
    delete next[type];
    void onUpdate({ cadenceByTreatmentType: next });
  }

  useEffect(() => setNameDraft(profile.name), [profile.name]);

  async function saveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === profile.name) {
      setEditingName(false);
      setNameDraft(profile.name);
      return;
    }
    await onUpdate({ name: trimmed });
    setEditingName(false);
  }

  function addCadence() {
    const h = parseInt(newOffset, 10);
    if (!Number.isFinite(h) || h < 0 || h > 8760) {
      toast.error("Enter hours between 0 and 8760 (365 days).");
      return;
    }
    if (profile.cadenceHours.includes(h)) {
      toast.error(`${h}h is already in the cadence.`);
      return;
    }
    const next = [...profile.cadenceHours, h].sort((a, b) => b - a);
    void onUpdate({ cadenceHours: next });
    setNewOffset("");
  }

  function removeCadence(h: number) {
    if (profile.cadenceHours.length === 1) {
      toast.error("Profile needs at least one touchpoint.");
      return;
    }
    const next = profile.cadenceHours.filter((x) => x !== h);
    void onUpdate({ cadenceHours: next });
  }

  return (
    <article
      className={cn(
        "rounded-2xl border bg-white",
        profile.isDefault
          ? "border-emerald/40"
          : "border-rule",
      )}
    >
      {/* Header */}
      <header className="px-5 py-4 border-b border-rule flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {editingName ? (
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") {
                  setEditingName(false);
                  setNameDraft(profile.name);
                }
              }}
              maxLength={80}
              autoFocus
              className="rounded border border-rule bg-white px-2 py-0.5 text-sm font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-emerald/30"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              className="text-base font-semibold text-ink hover:text-emerald transition inline-flex items-center gap-1.5"
            >
              {profile.name}
              <Edit2 className="h-3 w-3 text-ink-faint" />
            </button>
          )}
          {profile.isDefault && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-soft text-emerald-ink px-2 py-0.5 text-[10px] font-semibold">
              <Star className="h-2.5 w-2.5 fill-current" />
              default
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!profile.isDefault && (
            <button
              type="button"
              onClick={() => void onSetDefault()}
              className="text-[11px] font-medium text-ink-soft hover:text-emerald transition"
            >
              Set as default
            </button>
          )}
          {!profile.isDefault && (
            <button
              type="button"
              onClick={() => void onDelete()}
              className="inline-flex items-center gap-1 rounded-lg border border-rose/30 bg-white px-2 py-1 text-[11px] font-medium text-rose hover:bg-rose-soft transition"
              title="Delete this profile"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="px-5 py-4 space-y-4">
        {/* Cadence */}
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-2">
            Cadence — hours before appointment
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {profile.cadenceHours.map((h) => (
              <CadenceChip
                key={h}
                hours={h}
                onRemove={() => removeCadence(h)}
                removable={profile.cadenceHours.length > 1}
              />
            ))}
            <div className="inline-flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={8760}
                value={newOffset}
                onChange={(e) => setNewOffset(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCadence();
                  }
                }}
                placeholder="hours"
                className="w-20 rounded border border-rule bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald/30"
              />
              <button
                type="button"
                onClick={addCadence}
                className="inline-flex items-center gap-1 rounded border border-emerald/30 bg-emerald-soft text-emerald-ink px-2 py-1 text-[11px] font-medium hover:bg-emerald hover:text-paper transition"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            </div>
          </div>
          <p className="text-[10px] text-ink-faint mt-2">
            Unlimited touchpoints. Larger numbers fire earlier. Example:{" "}
            <code>120 / 72 / 48 / 24 / 12</code> = 5-day, 3-day, 48h, 24h, 12h.
          </p>
        </div>

        {/* Tone + Channel */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FieldGroup label="Tone">
            <div className="inline-flex rounded-lg border border-rule bg-paper p-0.5 w-full">
              {TONE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => void onUpdate({ tone: opt.value })}
                  title={opt.hint}
                  className={cn(
                    "flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition",
                    profile.tone === opt.value
                      ? "bg-emerald text-paper"
                      : "text-ink-soft hover:text-ink",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </FieldGroup>
          <FieldGroup label="Channel">
            <div className="inline-flex rounded-lg border border-rule bg-paper p-0.5 w-full">
              {CHANNEL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => void onUpdate({ channel: opt.value })}
                  title={opt.hint}
                  className={cn(
                    "flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition",
                    profile.channel === opt.value
                      ? "bg-emerald text-paper"
                      : "text-ink-soft hover:text-ink",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </FieldGroup>
        </div>

        {/* v1.34.4: Per-treatment-type cadence overrides */}
        <div>
          <button
            type="button"
            onClick={() => setShowOverrides((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink hover:text-emerald transition"
          >
            {showOverrides ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <Layers className="h-3.5 w-3.5" />
            Per-treatment-type cadence overrides
            <span className="text-[10px] font-normal text-ink-soft">
              ({treatmentOverrideEntries.length} custom)
            </span>
          </button>
          {showOverrides && (
            <div className="mt-3 space-y-2.5 rounded-lg border border-rule bg-paper/50 p-3">
              {treatmentOverrideEntries.length === 0 && (
                <p className="text-[11px] text-ink-faint italic">
                  No overrides yet. Treatments not listed here use the
                  spa-wide cadence above.
                </p>
              )}
              {treatmentOverrideEntries.map(([type, hours]) => (
                <div
                  key={type}
                  className="flex items-center gap-2 flex-wrap"
                >
                  <span className="inline-flex items-center rounded-md bg-emerald-soft text-emerald-ink px-2 py-0.5 text-[11px] font-semibold capitalize">
                    {type}
                  </span>
                  <div className="flex flex-wrap items-center gap-1">
                    {hours.map((h) => (
                      <span
                        key={h}
                        className="inline-flex items-center rounded-full border border-rule bg-white text-ink-soft px-2 py-0.5 text-[10px] font-medium"
                      >
                        {h}h
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTreatmentOverride(type)}
                    className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-rose hover:underline"
                  >
                    <X className="h-2.5 w-2.5" />
                    Remove
                  </button>
                </div>
              ))}
              <div className="pt-2 mt-2 border-t border-rule space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-soft">
                  Add override
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={newTreatmentType}
                    onChange={(e) => setNewTreatmentType(e.target.value)}
                    placeholder="treatment type (e.g., botox)"
                    maxLength={80}
                    className="flex-1 min-w-[140px] rounded border border-rule bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  />
                  <input
                    type="text"
                    value={newTreatmentHours}
                    onChange={(e) => setNewTreatmentHours(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTreatmentOverride();
                      }
                    }}
                    placeholder="hours: 72, 24, 12"
                    className="flex-1 min-w-[140px] rounded border border-rule bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  />
                  <button
                    type="button"
                    onClick={addTreatmentOverride}
                    className="inline-flex items-center gap-1 rounded border border-emerald/30 bg-emerald-soft text-emerald-ink px-2 py-1 text-[11px] font-medium hover:bg-emerald hover:text-paper transition"
                  >
                    <Plus className="h-3 w-3" />
                    Add
                  </button>
                </div>
                <p className="text-[10px] text-ink-faint">
                  Treatment types match against <code>appointment.treatment_type</code> case-insensitive. Example: <code>botox</code> → <code>72, 24, 12</code> overrides the spa-wide cadence for any Botox appointment.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Messages expander */}
        <div>
          <button
            type="button"
            onClick={() => setShowMessages((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink hover:text-emerald transition"
          >
            {showMessages ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <MessageSquareText className="h-3.5 w-3.5" />
            Per-touchpoint messages
            <span className="text-[10px] font-normal text-ink-soft">
              ({templates.length} customized of {profile.cadenceHours.length})
            </span>
          </button>
          {showMessages && (
            <div className="mt-3 space-y-3">
              {profile.cadenceHours
                .slice()
                .sort((a, b) => b - a)
                .map((offsetHours) => {
                  const existing = templates.find(
                    (t) => t.offsetHours === offsetHours,
                  );
                  return (
                    <TemplateEditor
                      key={offsetHours}
                      offsetHours={offsetHours}
                      existing={existing}
                      onSave={(body) => onSaveTemplate(offsetHours, body)}
                      onReset={existing ? () => onResetTemplate(existing.id) : undefined}
                    />
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function CadenceChip({
  hours,
  onRemove,
  removable,
}: {
  hours: number;
  onRemove: () => void;
  removable: boolean;
}) {
  const label = formatHours(hours);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-soft text-emerald-ink px-2.5 py-1 text-xs font-medium">
      <Clock className="h-3 w-3" />
      {label}
      {removable && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="ml-0.5 -mr-0.5 rounded-full p-0.5 hover:bg-emerald/20 transition"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Template editor (per touchpoint) ─────────────────────────────────────

function TemplateEditor({
  offsetHours,
  existing,
  onSave,
  onReset,
}: {
  offsetHours: number;
  existing: PreshowMessageTemplate | undefined;
  onSave: (body: string) => Promise<void>;
  onReset?: () => Promise<void>;
}) {
  const [body, setBody] = useState(existing?.bodyTemplate ?? "");
  const [saving, setSaving] = useState(false);
  const [showVars, setShowVars] = useState(false);

  useEffect(() => {
    setBody(existing?.bodyTemplate ?? "");
  }, [existing]);

  const isCustomized = !!existing;
  const isDirty = body.trim() !== (existing?.bodyTemplate ?? "").trim();

  async function save() {
    const trimmed = body.trim();
    if (!trimmed) {
      toast.error("Message can't be empty. Use Reset to revert.");
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-rule bg-paper px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-ink inline-flex items-center gap-2">
          <Clock className="h-3 w-3 text-ink-soft" />
          T-{formatHours(offsetHours)}
          {isCustomized ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-soft text-emerald-ink px-1.5 py-0.5 text-[9px] font-medium">
              <CheckCircle2 className="h-2 w-2" />
              customized
            </span>
          ) : (
            <span className="text-[10px] font-normal text-ink-faint">
              using default
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowVars((v) => !v)}
          className="text-[10px] text-ink-soft hover:text-emerald transition"
        >
          {showVars ? "Hide variables" : "Show variables"}
        </button>
      </div>

      {showVars && (
        <div className="flex flex-wrap gap-1.5 pb-1">
          {VARIABLE_CHIPS.map((v) => (
            <button
              key={v.token}
              type="button"
              onClick={() => setBody((b) => b + v.token)}
              title={v.hint}
              className="inline-flex items-center rounded border border-rule bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink-soft hover:text-emerald hover:border-emerald/40 transition"
            >
              {v.token}
            </button>
          ))}
        </div>
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          isCustomized
            ? ""
            : "Leave blank to use Refill's default message at this touchpoint, or write your own with the variables above."
        }
        rows={3}
        maxLength={1600}
        className="w-full rounded border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30 resize-y font-mono"
      />

      <div className="flex items-center justify-between gap-2 text-[10px] text-ink-faint">
        <span>{body.length}/1600 chars</span>
        <div className="flex items-center gap-1.5">
          {isCustomized && onReset && (
            <button
              type="button"
              onClick={() => void onReset()}
              className="inline-flex items-center gap-1 rounded border border-rule bg-white px-2 py-0.5 text-[10px] text-ink-soft hover:text-rose transition"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Reset to default
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!isDirty || saving || !body.trim()}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-semibold transition",
              isDirty && body.trim()
                ? "bg-emerald text-paper hover:opacity-90"
                : "bg-rule text-ink-faint cursor-not-allowed",
            )}
          >
            {saving ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Save className="h-2.5 w-2.5" />
            )}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatHours(h: number): string {
  if (h === 0) return "0h";
  if (h < 24) return `${h}h`;
  const d = h / 24;
  if (Number.isInteger(d)) return `${d}d`;
  return `${h}h`;
}
