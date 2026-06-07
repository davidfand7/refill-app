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
import { toast } from "sonner";
import { CheckCircle2, Copy, ExternalLink, Globe, Link2, Loader2, Sparkles } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";
import { BusinessHoursSection } from "@/components/refill/booking/BusinessHoursSection";
import { DateOverridesSection } from "@/components/refill/booking/DateOverridesSection";
import { BookingRulesSection } from "@/components/refill/booking/BookingRulesSection";
import { ProvidersSection } from "@/components/refill/booking/ProvidersSection";
import { RoomsSection } from "@/components/refill/booking/RoomsSection";
import { BookableServicesSection } from "@/components/refill/booking/BookableServicesSection";
import { useBookingSettings } from "@/components/refill/booking/useBookingSettings";
import { bookingUrl, Toggle } from "@/components/refill/booking/fields";

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

function BookingSettingsPage() {
  const membership = useTenantMembership();
  const viewAsUserId = membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const bk = useBookingSettings({ viewAsUserId, isTenant: membership.status === "tenant" });
  const {
    loading, saving, server, draft,
    selDays, setSelDays, bulkOpen, setBulkOpen, bulkClose, setBulkClose,
    selProviderId, setSelProviderId,
    dirty, activeProviders, selHours, selProviderName,
    patchSettings, patchDay, toggleSelDay, applyHoursToSelected, setSelectedClosed,
    onSave,
  } = bk;

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

      <div className="px-6 lg:px-10 py-6 max-w-[960px] mx-auto space-y-6">
        {loading || !draft ? (
          <div className="flex items-center gap-2 text-[14px] text-ink-soft py-10">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading booking settings…
          </div>
        ) : (
          <>
            {/* ── Your public booking link ── */}
            {draft.slug && (
              <section className="rounded-xl border border-rule bg-white px-5 py-4">
                <div className="flex items-center gap-2 mb-2">
                  <Link2 className="h-4 w-4 text-emerald" />
                  <h3 className="text-[14px] font-semibold text-ink">Your booking link</h3>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate rounded-md border border-rule bg-paper/60 px-3 py-2 text-[13px] text-ink">
                    {bookingUrl(draft.slug)}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(bookingUrl(draft.slug))
                        .then(() => toast.success("Booking link copied."))
                        .catch(() => toast.error("Couldn't copy."));
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-rule px-2.5 py-2 text-[12px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </button>
                  <a
                    href={bookingUrl(draft.slug)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-rule px-2.5 py-2 text-[12px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open
                  </a>
                </div>
                <p className="text-[12px] text-ink-soft mt-2 leading-relaxed">
                  Share this with patients. It goes live once <strong>Online booking</strong> is on and
                  at least one service is marked bookable below.
                </p>
              </section>
            )}

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

            {/* ── Providers ── */}
            <ProvidersSection bk={bk} />

            {/* ── Provider hours (sits right under Providers) ── */}
            <BusinessHoursSection
              activeProviders={activeProviders}
              selProviderId={selProviderId}
              setSelProviderId={setSelProviderId}
              selProviderName={selProviderName}
              selHours={selHours}
              selDays={selDays}
              setSelDays={setSelDays}
              bulkOpen={bulkOpen}
              setBulkOpen={setBulkOpen}
              bulkClose={bulkClose}
              setBulkClose={setBulkClose}
              applyHoursToSelected={applyHoursToSelected}
              setSelectedClosed={setSelectedClosed}
              patchDay={patchDay}
              toggleSelDay={toggleSelDay}
            />

            {/* ── Date-specific availability (overrides weekly hours per date) ── */}
            <DateOverridesSection bk={bk} />

            {/* ── Rooms & resources ── */}
            <RoomsSection bk={bk} />

            {/* ── Booking rules ── */}
            <BookingRulesSection settings={draft.settings} patchSettings={patchSettings} />

            {/* ── Bookable services ── */}
            <BookableServicesSection bk={bk} />

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

