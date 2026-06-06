/**
 * /app/refill/settings/booking — Owner setup for the native scheduler
 * (v1.48.0). Distinct from the "Scheduler" tab (that's the third-party PMS
 * connector). Here the owner turns ON online booking and defines the rules the
 * slot engine + public self-book page read:
 *
 *   • Master: online-booking toggle + timezone (anchors all slot math).
 *   • Business hours: a Mon–Sun grid (open/close + closed toggle per day).
 *   • Booking rules: min notice, max advance, slot grid, hold window, reminders.
 *   • Bookable services: per-service online_bookable + duration + buffer.
 *
 * Loads (and idempotently seeds on first open) via getSchedulingSetupFn; one
 * Save button writes settings + hours + service overrides. Impersonation is
 * threaded via useTenantMembership.viewAsUserId, matching spa-profile.
 */

import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  Clock,
  Globe,
  Loader2,
  Sparkles,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getSchedulingSetupFn,
  saveSchedulingSetupFn,
  type BookableServiceDraft,
  type SchedulingHoursDraft,
  type SchedulingSettingsDraft,
  type SchedulingSetupBundle,
} from "@/server/scheduling-settings.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/settings/booking")({
  component: BookingSettingsPage,
});

// Common US-practice timezones; covers the MVP ICP. (Stored as IANA names.)
const TIMEZONES: Array<{ value: string; label: string }> = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Arizona (Phoenix, no DST)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
];

// Display Monday-first for business-hours readability; dayOfWeek stays 0=Sun.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

const GRANULARITY_OPTIONS = [10, 15, 20, 30, 60];

function BookingSettingsPage() {
  const membership = useTenantMembership();
  const viewAsUserId = membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [server, setServer] = useState<SchedulingSetupBundle | null>(null);
  const [draft, setDraft] = useState<SchedulingSetupBundle | null>(null);

  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const result = await getSchedulingSetupFn({ data: { accessToken: token, viewAsUserId } });
        if (cancelled) return;
        setServer(result);
        setDraft(structuredClone(result));
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Couldn't load booking settings.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  const dirty = useMemo(
    () => !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server),
    [draft, server],
  );

  function patchSettings(patch: Partial<SchedulingSettingsDraft>) {
    setDraft((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  }
  function patchDay(dayOfWeek: number, patch: Partial<SchedulingHoursDraft>) {
    setDraft((d) =>
      d
        ? { ...d, hours: d.hours.map((h) => (h.dayOfWeek === dayOfWeek ? { ...h, ...patch } : h)) }
        : d,
    );
  }
  function patchService(id: string, patch: Partial<BookableServiceDraft>) {
    setDraft((d) =>
      d ? { ...d, services: d.services.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : d,
    );
  }

  async function onSave() {
    if (!draft || !dirty) return;
    setSaving(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      await saveSchedulingSetupFn({
        data: {
          accessToken: token,
          viewAsUserId,
          settings: draft.settings,
          hours: draft.hours,
          services: draft.services.map((s) => ({
            id: s.id,
            durationMin: s.durationMin,
            bufferMin: s.bufferMin,
            onlineBookable: s.onlineBookable,
          })),
        },
      });
      setServer(structuredClone(draft));
      toast.success("Booking settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (membership.status !== "tenant") {
    return (
      <div>
        <PageHeader title="Online booking" description="Set up your native scheduler." />
        <SettingsTabStrip active="booking" />
        <div className="px-6 lg:px-10 py-10 max-w-md">
          <div className="rounded-xl border border-dashed border-rule bg-paper/40 px-5 py-6">
            <p className="text-[14px] font-medium text-ink">Pick a spa to configure</p>
            <p className="text-[13px] text-ink-soft mt-1.5 leading-relaxed">
              Online booking is a per-spa setting. Use the <strong>persona switcher</strong> in the
              upper-right to view as the spa you want to set up, then this page will load its hours
              and services.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Online booking"
        description="Turn on patient self-booking, set your hours, and choose which services are bookable online."
      />
      <SettingsTabStrip active="booking" />

      <div className="px-6 lg:px-10 py-6 max-w-3xl space-y-6">
        {loading || !draft ? (
          <div className="flex items-center gap-2 text-[14px] text-ink-soft py-10">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading booking settings…
          </div>
        ) : (
          <>
            {/* ── Master + timezone ── */}
            <section className="rounded-xl border border-rule bg-white px-5 py-4 space-y-4">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-emerald-soft p-2 shrink-0">
                  <Sparkles className="h-4 w-4 text-emerald" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-[14px] font-semibold text-ink">
                      Online booking
                    </label>
                    <Toggle
                      checked={draft.settings.onlineBookingEnabled}
                      onChange={(v) => patchSettings({ onlineBookingEnabled: v })}
                    />
                  </div>
                  <p className="text-[12px] text-ink-soft mt-1 leading-relaxed">
                    When on, patients can self-book on your public page. Off keeps the page
                    private while you finish setup.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 pt-1 border-t border-rule/70">
                <div className="rounded-full bg-emerald-soft p-2 shrink-0 mt-3">
                  <Globe className="h-4 w-4 text-emerald" />
                </div>
                <div className="flex-1 min-w-0 pt-3">
                  <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
                    Timezone
                  </label>
                  <select
                    value={draft.settings.timezone}
                    onChange={(e) => patchSettings({ timezone: e.target.value })}
                    className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                  >
                    {TIMEZONES.map((tz) => (
                      <option key={tz.value} value={tz.value}>
                        {tz.label}
                      </option>
                    ))}
                    {/* Preserve an unknown stored tz so save never silently changes it. */}
                    {!TIMEZONES.some((t) => t.value === draft.settings.timezone) && (
                      <option value={draft.settings.timezone}>{draft.settings.timezone}</option>
                    )}
                  </select>
                  <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">
                    All slot times are shown and stored against this timezone.
                  </p>
                </div>
              </div>
            </section>

            {/* ── Business hours ── */}
            <section className="rounded-xl border border-rule bg-white px-5 py-4">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="h-4 w-4 text-emerald" />
                <h3 className="text-[14px] font-semibold text-ink">Business hours</h3>
              </div>
              <div className="space-y-1.5">
                {DAY_ORDER.map((dow) => {
                  const h = draft.hours.find((x) => x.dayOfWeek === dow);
                  if (!h) return null;
                  return (
                    <div
                      key={dow}
                      className="grid grid-cols-[110px_1fr] sm:grid-cols-[130px_auto_auto_1fr] items-center gap-2 py-1.5"
                    >
                      <span className="text-[13px] font-medium text-ink">{DAY_LABELS[dow]}</span>
                      {h.isClosed ? (
                        <span className="text-[13px] text-ink-faint sm:col-span-2">Closed</span>
                      ) : (
                        <>
                          <input
                            type="time"
                            value={h.openTime}
                            onChange={(e) => patchDay(dow, { openTime: e.target.value })}
                            className="rounded-md border border-rule bg-white px-2 py-1.5 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                          />
                          <input
                            type="time"
                            value={h.closeTime}
                            onChange={(e) => patchDay(dow, { closeTime: e.target.value })}
                            className="rounded-md border border-rule bg-white px-2 py-1.5 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                          />
                        </>
                      )}
                      <label className="flex items-center justify-end gap-1.5 text-[12px] text-ink-soft">
                        <input
                          type="checkbox"
                          checked={h.isClosed}
                          onChange={(e) => patchDay(dow, { isClosed: e.target.checked })}
                          className="h-3.5 w-3.5 rounded border-rule accent-emerald"
                        />
                        Closed
                      </label>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ── Booking rules ── */}
            <section className="rounded-xl border border-rule bg-white px-5 py-4">
              <div className="flex items-center gap-2 mb-3">
                <CalendarClock className="h-4 w-4 text-emerald" />
                <h3 className="text-[14px] font-semibold text-ink">Booking rules</h3>
              </div>
              <div className="grid sm:grid-cols-2 gap-x-5 gap-y-4">
                <NumberField
                  label="Minimum notice (hours)"
                  caption="How far ahead a patient must book."
                  value={Math.round(draft.settings.minAdvanceNoticeMin / 60)}
                  min={0}
                  max={720}
                  onChange={(v) => patchSettings({ minAdvanceNoticeMin: v * 60 })}
                />
                <NumberField
                  label="Booking window (days)"
                  caption="How far out patients can book."
                  value={draft.settings.maxAdvanceDays}
                  min={1}
                  max={730}
                  onChange={(v) => patchSettings({ maxAdvanceDays: v })}
                />
                <SelectField
                  label="Time slot interval"
                  caption="Spacing of offered start times."
                  value={draft.settings.slotGranularityMin}
                  options={GRANULARITY_OPTIONS.map((m) => ({ value: m, label: `${m} min` }))}
                  onChange={(v) => patchSettings({ slotGranularityMin: v })}
                />
                <NumberField
                  label="Hold window (minutes)"
                  caption="How long a slot is held during checkout."
                  value={draft.settings.holdMinutes}
                  min={1}
                  max={120}
                  onChange={(v) => patchSettings({ holdMinutes: v })}
                />
                <NumberField
                  label="Reminder lead (hours)"
                  caption="Send a reminder this many hours before."
                  value={draft.settings.reminderLeadHours}
                  min={0}
                  max={336}
                  onChange={(v) => patchSettings({ reminderLeadHours: v })}
                />
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={draft.settings.samedayReminderEnabled}
                      onChange={(e) => patchSettings({ samedayReminderEnabled: e.target.checked })}
                      className="h-4 w-4 rounded border-rule accent-emerald"
                    />
                    Also send a same-day reminder
                  </label>
                </div>
              </div>
            </section>

            {/* ── Bookable services ── */}
            <section className="rounded-xl border border-rule bg-white px-5 py-4">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-[14px] font-semibold text-ink">Bookable services</h3>
              </div>
              <p className="text-[12px] text-ink-soft mb-3 leading-relaxed">
                Choose which services patients can book online, and set how long each takes
                (plus any cleanup buffer between appointments).
              </p>
              {draft.services.length === 0 ? (
                <div className="rounded-lg border border-dashed border-rule bg-paper/40 px-4 py-6 text-center">
                  <p className="text-[13px] text-ink-soft">
                    No services yet. Add them in your{" "}
                    <Link to="/app/refill/catalog/services" className="text-emerald font-medium underline">
                      services catalog
                    </Link>{" "}
                    first, then come back to make them bookable.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-rule">
                  <div className="hidden sm:grid grid-cols-[1fr_90px_90px_90px] gap-2 pb-2 text-[11px] uppercase tracking-wider font-semibold text-ink-faint">
                    <span>Service</span>
                    <span className="text-right">Duration</span>
                    <span className="text-right">Buffer</span>
                    <span className="text-right">Bookable</span>
                  </div>
                  {draft.services.map((s) => (
                    <div
                      key={s.id}
                      className="grid grid-cols-[1fr_90px_90px_90px] gap-2 items-center py-2.5"
                    >
                      <span className="text-[13px] text-ink truncate">{s.name}</span>
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number"
                          min={1}
                          max={1440}
                          value={s.durationMin}
                          onChange={(e) =>
                            patchService(s.id, { durationMin: clampInt(e.target.value, 1, 1440) })
                          }
                          className="w-14 rounded-md border border-rule bg-white px-2 py-1 text-[13px] text-ink text-right outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                        />
                        <span className="text-[11px] text-ink-faint">m</span>
                      </div>
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number"
                          min={0}
                          max={1440}
                          value={s.bufferMin}
                          onChange={(e) =>
                            patchService(s.id, { bufferMin: clampInt(e.target.value, 0, 1440) })
                          }
                          className="w-14 rounded-md border border-rule bg-white px-2 py-1 text-[13px] text-ink text-right outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                        />
                        <span className="text-[11px] text-ink-faint">m</span>
                      </div>
                      <div className="flex justify-end">
                        <Toggle
                          checked={s.onlineBookable}
                          onChange={(v) => patchService(s.id, { onlineBookable: v })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ── Save ── */}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={onSave}
                disabled={!dirty || saving}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition",
                  dirty && !saving
                    ? "bg-emerald text-paper hover:opacity-95"
                    : "bg-rule text-ink-faint cursor-not-allowed",
                )}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" /> Save changes
                  </>
                )}
              </button>
              {dirty && !saving && (
                <span className="text-[12px] text-ink-faint">Unsaved changes</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Small field helpers ──────────────────────────────────────────────────────

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-emerald" : "bg-rule",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function NumberField({
  label,
  caption,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  caption: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
        {label}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(clampInt(e.target.value, min, max))}
        className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
      />
      <p className="text-[12px] text-ink-soft mt-1 leading-relaxed">{caption}</p>
    </div>
  );
}

function SelectField({
  label,
  caption,
  value,
  options,
  onChange,
}: {
  label: string;
  caption: string;
  value: number;
  options: Array<{ value: number; label: string }>;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="text-[12px] text-ink-soft mt-1 leading-relaxed">{caption}</p>
    </div>
  );
}
