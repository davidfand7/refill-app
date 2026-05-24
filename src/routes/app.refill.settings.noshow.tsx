/**
 * /app/refill/settings/noshow — No-show recovery settings (v360).
 *
 * Every knob the owner controls for the recovery engine. v360 ships
 * pre-show + opt-in footer + grace credits + agent toggles. Rescue
 * (v361), deposit (v364) sections exist but read-only / coming-soon.
 *
 * Smart defaults — most spas won't touch this page. The 5% who do are
 * power users who want full control.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Lock,
  Loader2,
  MessageSquareText,
  Save,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  getNoShowPolicy,
  updateNoShowPolicy,
  type NoShowPolicy,
} from "@/server/emma-appointments.functions";
import { useShell } from "@/lib/shell";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/settings/noshow")({
  component: NoShowSettingsPage,
});

function NoShowSettingsPage() {
  // v411.6 — brand-aware constants. Same useShell pattern as v410.1 / v411.5.
  // emma.agentiport.com → Emma(OS) eyebrow + "Emma" in body copy.
  // app.getrefill.app → Refill eyebrow + "Refill" in body copy.
  const shell = useShell();
  const isRefill = shell === "refill";
  const brandHeader = isRefill ? "Refill" : "Emma(OS)";
  const brandName = isRefill ? "Refill" : "Emma";

  const [policy, setPolicy] = useState<NoShowPolicy | null>(null);
  const [draft, setDraft] = useState<Partial<NoShowPolicy>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const p = await getNoShowPolicy({ data: { accessToken: token } });
      setPolicy(p);
      setDraft({});
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = { ...policy, ...draft } as NoShowPolicy;
  const isDirty = Object.keys(draft).length > 0;

  function update<K extends keyof NoShowPolicy>(key: K, value: NoShowPolicy[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    if (!policy) return;
    setSaving(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const updated = await updateNoShowPolicy({
        data: { accessToken: token, patch: draft as never },
      });
      setPolicy(updated);
      setDraft({});
      toast.success("Settings saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow={`${brandHeader} · Settings`}
        title="No-show recovery"
        description="Every knob for the recovery engine. Smart defaults work for most spas — tune anything that doesn't fit yours."
        breadcrumbs={[
          { label: brandHeader, to: "/app/refill" },
          { label: "Settings" },
          { label: "No-show recovery" },
        ]}
        actions={
          <button
            type="button"
            onClick={() => void save()}
            disabled={!isDirty || saving}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              isDirty
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-muted text-ink-soft cursor-not-allowed",
            )}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {loading && !policy && (
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {policy && (
          <>
            {/* Pre-show agent */}
            <Section
              icon={CalendarClock}
              title="Pre-show reminder agent"
              description="Personalized confirmations at each cadence offset before the appointment. The single most effective lever for reducing no-shows."
            >
              <Toggle
                label="Enable pre-show reminders"
                checked={current.preshowEnabled}
                onChange={(v) => update("preshowEnabled", v)}
              />
              <CadenceEditor
                hours={current.preshowCadenceHours}
                onChange={(v) => update("preshowCadenceHours", v)}
                disabled={!current.preshowEnabled}
              />
              <Select
                label="Tone"
                value={current.preshowTone}
                options={[
                  { v: "warm", label: `Warm (default — ${brandName}'s voice)` },
                  { v: "professional", label: "Professional (formal)" },
                  { v: "casual", label: "Casual (informal)" },
                ]}
                onChange={(v) =>
                  update("preshowTone", v as NoShowPolicy["preshowTone"])
                }
                disabled={!current.preshowEnabled}
              />
              <Select
                label="Channel preference"
                value={current.preshowChannel}
                options={[
                  { v: "auto", label: "Auto (SMS if phone, else email)" },
                  { v: "sms", label: "SMS only" },
                  { v: "email", label: "Email only" },
                ]}
                onChange={(v) =>
                  update("preshowChannel", v as NoShowPolicy["preshowChannel"])
                }
                disabled={!current.preshowEnabled}
              />
            </Section>

            {/* Universal opt-in footer */}
            <Section
              icon={MessageSquareText}
              title="Universal opt-in footer"
              description={`Every ${brandName} message appends this footer + link, inviting patients to join your last-minute openings list.`}
            >
              <Toggle
                label="Append opt-in footer to all messages"
                checked={current.optinFooterEnabled}
                onChange={(v) => update("optinFooterEnabled", v)}
              />
              <TextField
                label="Footer text"
                value={current.optinFooterText}
                onChange={(v) => update("optinFooterText", v)}
                disabled={!current.optinFooterEnabled}
                maxLength={280}
              />
              <TextField
                label="Opt-in list URL"
                value={current.optinListUrl ?? ""}
                onChange={(v) => update("optinListUrl", v || null)}
                placeholder="https://yourspa.com/last-minute"
                disabled={!current.optinFooterEnabled}
              />
              <p className="text-[11px] text-ink-soft">
                The waitlist landing page {brandName} will host ships in v361. Until then,
                point this at your existing form (Squarespace, Mailchimp, anywhere).
              </p>
            </Section>

            {/* Grace credit policy */}
            <Section
              icon={CheckCircle2}
              title="Grace credit policy"
              description="Patients get this many free last-minute cancels per rolling 6 months. No fee, no judgment. Pattern detection escalates after this threshold."
            >
              <NumberField
                label="Grace credits per 6 months"
                value={current.graceCreditsPer6mo}
                onChange={(v) => update("graceCreditsPer6mo", v)}
                min={0}
                max={20}
                suffix="cancels"
              />
            </Section>

            {/* Same-day rescue (v361 — now live) */}
            <Section
              icon={Clock}
              title="Same-day rescue agent"
              description={`When an appointment cancels with a future date, ${brandName} offers the slot to your waitlist via SMS. First tap wins — the appointment reassigns automatically.`}
            >
              <Toggle
                label="Enable same-day rescue"
                checked={current.rescueEnabled}
                onChange={(v) => update("rescueEnabled", v)}
              />
              <NumberField
                label="Max patients to contact per rescue"
                value={current.rescueMaxConcurrent}
                onChange={(v) => update("rescueMaxConcurrent", v)}
                min={1}
                max={50}
                suffix="patients"
                disabled={!current.rescueEnabled}
              />
              <NumberField
                label="Outreach window (minutes before the slot expires unclaimed)"
                value={current.rescueOutreachWindowMin}
                onChange={(v) => update("rescueOutreachWindowMin", v)}
                min={15}
                max={720}
                suffix="min"
                disabled={!current.rescueEnabled}
              />
              <p className="text-[11px] text-ink-soft">
                Waitlist members opt in via the universal footer in every {brandName}
                {" "}message, or you can add them manually from a patient's profile.
                The rescue agent picks the top {current.rescueMaxConcurrent} fit-patients
                (treatment + lifetime value) and contacts them in parallel.
              </p>
            </Section>

            {/* Rescue proxy / trial mode (v379) */}
            <Section
              icon={MessageSquareText}
              title="Rescue proxy — trial mode"
              description={`When set, ${brandName} sends ONE aggregated message (with all the patient claim URLs + ready-to-send drafts) to YOU instead of texting each waitlist patient. You hand-forward via iMessage — or paste into a Claude Desktop chat with the iMessage MCP integration to auto-draft them. Useful before carrier porting completes, or as a soft on-ramp for any pilot that wants the recovery engine without ceding outbound to automation yet.`}
              warning={`Leave both empty for production behavior (${brandName} texts each patient directly). When EITHER is filled, per-patient sends are skipped entirely — the engine still mints tokens, creates offers, and tracks claims; only the delivery channel changes.`}
            >
              <TextField
                label="Rescue proxy phone (E.164, e.g. +17203343477)"
                value={current.rescueProxyPhone ?? ""}
                onChange={(v) =>
                  update("rescueProxyPhone", v.trim().length === 0 ? null : v.trim())
                }
                placeholder="+1XXXXXXXXXX"
                maxLength={40}
                disabled={!current.rescueEnabled}
              />
              <TextField
                label="Rescue proxy email"
                value={current.rescueProxyEmail ?? ""}
                onChange={(v) =>
                  update("rescueProxyEmail", v.trim().length === 0 ? null : v.trim())
                }
                placeholder="you@yourspa.com"
                maxLength={200}
                disabled={!current.rescueEnabled}
              />
              <p className="text-[11px] text-ink-soft">
                Both can be set together — SMS for the quick ping, email for the
                full READY-TO-SEND drafts block (formatted for easy copy-paste
                into iMessage or LLM-assisted draft automation).
              </p>
            </Section>

            {/* Deposit-credit (v364 — live but OFF by default) */}
            <Section
              icon={Lock}
              title="Deposit-credit (off by default)"
              description={`${brandName} never punishes your patients — unless you tell us to. When enabled, eligible patients are asked to authorize a deposit that becomes credit toward their treatment at the visit (never a fee). Most spas leave this off.`}
              warning="Read the brand-tradeoff carefully before enabling. Even framed as credit, asking for a card upfront changes the relationship feel. v364 ships intent-logging only — actual Stripe card holds land in v364.x. Until then, enabling this just logs would-have-been requests to the Deposits tab on /app/refill/recovery."
            >
              <Toggle
                label="Enable deposit-credit for triggered bookings"
                checked={current.depositEnabled}
                onChange={(v) => update("depositEnabled", v)}
              />
              <NumberField
                label="Deposit amount (becomes credit at visit)"
                value={current.depositAmountUsd ?? 0}
                onChange={(v) => update("depositAmountUsd", v)}
                min={0}
                max={1000}
                suffix="USD"
                disabled={!current.depositEnabled}
              />
              <Select
                label="When does it apply?"
                value={current.depositTrigger ?? "in_recovery_tier"}
                options={[
                  {
                    v: "in_recovery_tier",
                    label: "In-recovery patients (3+ no-shows in 6mo) — recommended",
                  },
                  {
                    v: "new_patient",
                    label: "First-time patients (no prior visits on file)",
                  },
                  {
                    v: "high_value_treatment",
                    label: "High-value treatments (laser, Morpheus, EmFace)",
                  },
                ]}
                onChange={(v) =>
                  update("depositTrigger", v as NoShowPolicy["depositTrigger"])
                }
                disabled={!current.depositEnabled}
              />
              <NumberField
                label="Refund window (hours before appointment to reschedule without losing the deposit)"
                value={current.depositRefundWindowHours}
                onChange={(v) => update("depositRefundWindowHours", v)}
                min={1}
                max={168}
                suffix="hours"
                disabled={!current.depositEnabled}
              />
              <p className="text-[11px] text-ink-soft">
                <strong>v364 behavior:</strong> intent-logging only. When an
                eligible patient claims a slot via rescue (or future booking
                flow), {brandName} logs that a deposit WOULD have been requested. No
                money moves. View the log on the Deposits tab of /app/refill/recovery.
                Future v364.x adds the actual Stripe payment_intent flow.
              </p>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Layout primitives ────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  description,
  comingSoon,
  warning,
  children,
}: {
  icon: typeof CalendarClock;
  title: string;
  description: string;
  comingSoon?: boolean;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Icon className="h-4 w-4 text-ink-soft" />
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {comingSoon && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted/40 text-ink-soft text-[10px] font-medium uppercase tracking-wider">
              Coming soon
            </span>
          )}
        </div>
        <p className="text-xs text-ink-soft">{description}</p>
        {warning && (
          <div className="mt-2 inline-flex items-start gap-1.5 text-[11px] text-amber-700">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{warning}</span>
          </div>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-center gap-2", disabled && "opacity-50")}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="rounded border-border"
      />
      <span className="text-sm">{label}</span>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn("block", disabled && "opacity-50")}>
      <span className="block text-xs font-medium text-ink-soft mb-1">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
          min={min}
          max={max}
          disabled={disabled}
          className="w-24 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        {suffix && <span className="text-xs text-ink-soft">{suffix}</span>}
      </div>
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <label className={cn("block", disabled && "opacity-50")}>
      <span className="block text-xs font-medium text-ink-soft mb-1">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { v: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn("block", disabled && "opacity-50")}>
      <span className="block text-xs font-medium text-ink-soft mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CadenceEditor({
  hours,
  onChange,
  disabled,
}: {
  hours: number[];
  onChange: (h: number[]) => void;
  disabled?: boolean;
}) {
  const [input, setInput] = useState("");

  function addHour() {
    const n = parseInt(input, 10);
    if (!n || n < 1 || n > 168) return;
    if (hours.includes(n)) return;
    onChange([...hours, n].sort((a, b) => b - a));
    setInput("");
  }
  function removeHour(h: number) {
    onChange(hours.filter((x) => x !== h));
  }

  return (
    <div className={cn(disabled && "opacity-50")}>
      <span className="block text-xs font-medium text-ink-soft mb-1.5">
        Cadence offsets (hours before appointment)
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {hours.length === 0 && (
          <span className="text-xs text-ink-soft italic">
            No offsets — pre-show won't fire
          </span>
        )}
        {hours.map((h) => (
          <span
            key={h}
            className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground"
          >
            T-{h}h
            {!disabled && (
              <button
                type="button"
                onClick={() => removeHour(h)}
                className="text-ink-soft hover:text-destructive"
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <div className="inline-flex items-center gap-1">
            <input
              type="number"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addHour())}
              placeholder="48"
              min={1}
              max={168}
              className="w-16 rounded-md border border-border bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              type="button"
              onClick={addHour}
              className="text-xs text-primary hover:underline"
            >
              Add
            </button>
          </div>
        )}
      </div>
      <p className="mt-1 text-[11px] text-ink-soft">
        Default T-48h + T-24h + T-3h works for most spas. The first offset is
        the "are we still on?" check; later offsets are confirms.
      </p>
    </div>
  );
}
