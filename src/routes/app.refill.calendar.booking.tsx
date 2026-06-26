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
import { CalendarTabs } from "@/components/refill/CalendarTabs";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";
import { BusinessHoursSection } from "@/components/refill/booking/BusinessHoursSection";
import { DateOverridesSection } from "@/components/refill/booking/DateOverridesSection";
import { BookingRulesSection } from "@/components/refill/booking/BookingRulesSection";
import { ProvidersSection } from "@/components/refill/booking/ProvidersSection";
import { RoomsSection } from "@/components/refill/booking/RoomsSection";
import { BookableServicesSection } from "@/components/refill/booking/BookableServicesSection";
import { useBookingSettings } from "@/components/refill/booking/useBookingSettings";
import { setAllBookingSections, useSectionCollapse } from "@/components/refill/booking/useSectionCollapse";
import { bookingUrl, SectionSaveChip, Toggle } from "@/components/refill/booking/fields";
import { ChevronDown, ChevronsUpDown, ChevronsDownUp } from "lucide-react";

export const Route = createFileRoute("/app/refill/calendar/booking")({
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
  const linkSection = useSectionCollapse("link");
  const master = useSectionCollapse("master", true);
  const {
    loading, saving, server, draft,
    selDays, setSelDays, bulkOpen, setBulkOpen, bulkClose, setBulkClose,
    selProviderId, setSelProviderId,
    dirty, activeProviders, selHours, selProviderName,
    patchSettings, patchDay, toggleSelDay, applyHoursToSelected, setSelectedClosed,
    onSave, onDiscard, settingsDirty, hoursDirty, servicesDirty,
  } = bk;

  if (membership.status !== "tenant") {
    return (
      <div>
        <PageHeader title="Booking Settings" description="Set up your native scheduler." />
        <CalendarTabs active="booking" />
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

  const isExternalPms = !!draft?.externalPms;

  return (
    <div>
      <PageHeader
        title="Booking Settings"
        description={
          isExternalPms
            ? "Patients book through your connected scheduler (Acuity). The settings below only apply if you also publish SmartSpa's own booking page."
            : "Turn on patient self-booking, set your hours, and choose which services are bookable online."
        }
      />
      <CalendarTabs active="booking" />

      <div className="px-6 lg:px-10 pt-3 pb-28 max-w-[960px] mx-auto">
        {loading || !draft ? (
          <div className="flex items-center gap-2 text-[14px] text-ink-soft py-10">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading booking settings…
          </div>
        ) : (
          <>
            {/* ── Expand / collapse all (segmented pill) — gaps halved (~12px each):
                   top via the container's pt-3, bottom via this row's positive mb-3.
                   NEVER use a negative bottom margin here: the section list below is
                   full-width, so a negative margin drags its first card up UNDER this
                   right-aligned pill (the v2.3.10/.12 bleed). The list lives in its own
                   space-y-6 wrapper so this gap is the pill's mb-3 alone. ── */}
            <div className="flex items-center justify-end mb-3">
              <div className="inline-flex rounded-md border border-rule overflow-hidden text-[12px]">
                <button
                  type="button"
                  onClick={() => setAllBookingSections(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 font-medium text-ink-soft hover:text-ink hover:bg-rule/30 transition"
                >
                  <ChevronsUpDown className="h-3.5 w-3.5" /> Expand all
                </button>
                <button
                  type="button"
                  onClick={() => setAllBookingSections(false)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 font-medium text-ink-soft hover:text-ink hover:bg-rule/30 transition border-l border-rule"
                >
                  <ChevronsDownUp className="h-3.5 w-3.5" /> Collapse all
                </button>
              </div>
            </div>

            <div className="space-y-6">
            {/* ── External-PMS note (v2.74.0): calendar lives in Acuity, so we
                 don't hand out a native /s/<slug> link that would dead-end. ── */}
            {draft.slug && draft.externalPms && (
              <section className="rounded-xl border border-rule bg-white px-5 py-4">
                <div className="flex items-center gap-2 mb-1">
                  <Link2 className="h-4 w-4 text-emerald shrink-0" />
                  <h3 className="text-[14px] font-semibold text-ink">Booking link</h3>
                </div>
                <p className="text-[13px] text-ink-soft leading-relaxed">
                  Your calendar is managed in your connected scheduler (Acuity), so SmartSpa
                  doesn't hand out its own booking link. Patients keep booking through your
                  existing system — SmartSpa watches it and acts on cancellations to recover revenue.
                </p>
              </section>
            )}
            {/* ── Your public booking link (SmartSpa-primary spas only) ── */}
            {draft.slug && !draft.externalPms && (
              <section className="rounded-xl border border-rule bg-white px-5 py-4">
                <button
                  type="button"
                  onClick={linkSection.toggle}
                  className="flex w-full items-center gap-2 mb-2 text-left"
                >
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 text-ink-faint transition-transform shrink-0",
                      linkSection.open ? "" : "-rotate-90",
                    )}
                  />
                  <Link2 className="h-4 w-4 text-emerald shrink-0" />
                  <h3 className="text-[14px] font-semibold text-ink">Your booking link</h3>
                </button>
                {linkSection.open && (<>
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
                </>)}
              </section>
            )}

            {/* ── Master + timezone (collapsible; on/off toggle stays in the header) ── */}
            <section className="rounded-xl border border-rule bg-white px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={master.toggle}
                  className="flex items-center gap-2 text-left min-w-0"
                >
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 text-ink-faint transition-transform shrink-0",
                      master.open ? "" : "-rotate-90",
                    )}
                  />
                  <Sparkles className="h-4 w-4 text-emerald shrink-0" />
                  <h3 className="text-[14px] font-semibold text-ink">Status &amp; timezone</h3>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  <SectionSaveChip dirty={settingsDirty} saving={saving} onSave={onSave} />
                  <Toggle
                    checked={draft.settings.onlineBookingEnabled}
                    onChange={(v) => patchSettings({ onlineBookingEnabled: v })}
                  />
                </div>
              </div>
              {isExternalPms && (
                <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
                  You&apos;re connected to Acuity, so patients already book there. This switch
                  only controls SmartSpa&apos;s <em>own</em> booking page &mdash; most
                  connected-scheduler spas leave it off.
                </p>
              )}
              {master.open && (
                <div className="mt-3 space-y-4">
                  <p className="text-[12px] text-ink-soft leading-relaxed">
                    When on, patients can self-book on your public page. Off keeps the page
                    private while you finish setup.
                  </p>
                  <div className="flex items-start gap-3 pt-3 border-t border-rule/70">
                    <div className="rounded-full bg-emerald-soft p-2 shrink-0 mt-0.5">
                      <Globe className="h-4 w-4 text-emerald" />
                    </div>
                    <div className="flex-1 min-w-0">
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
                </div>
              )}
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
              hoursDirty={hoursDirty}
              saving={saving}
              onSave={onSave}
            />

            {/* ── Date-specific availability (overrides weekly hours per date) ── */}
            <DateOverridesSection bk={bk} />

            {/* ── Rooms & resources ── */}
            <RoomsSection bk={bk} />

            {/* ── Booking rules ── */}
            <BookingRulesSection
              settings={draft.settings}
              patchSettings={patchSettings}
              settingsDirty={settingsDirty}
              saving={saving}
              onSave={onSave}
            />

            {/* ── Bookable services ── */}
            <BookableServicesSection bk={bk} />

            {/* ── Save status (instant edits confirm with a toast; staged edits
                   light up the in-section "Save changes" chip + this sticky bar) ── */}
            <div className="flex items-center gap-2 pt-1 text-[12px] text-ink-faint">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald/60" />
              {dirty
                ? "You have unsaved changes — use Save changes (here or in any highlighted section)."
                : "All changes saved."}
            </div>
            </div>
          </>
        )}
      </div>

      {/* Global sticky save bar — appears the instant any edit needs saving, so
          Save is always one click away no matter where you've scrolled. Mirrors
          the per-section "Save changes" chips. */}
      {(dirty || saving) && (
        <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-emerald/30 bg-white/95 backdrop-blur px-2.5 py-2 shadow-lg animate-in fade-in slide-in-from-bottom-2">
            <span className="flex items-center gap-1.5 pl-2 pr-1 text-[12px] font-medium text-ink-soft">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Unsaved changes
            </span>
            <button
              type="button"
              onClick={onDiscard}
              disabled={saving}
              className="rounded-full px-3 py-1 text-[12px] font-medium text-ink-soft hover:text-ink hover:bg-rule/40 transition disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-semibold text-paper shadow-sm transition",
                "bg-emerald hover:opacity-95",
                saving && "opacity-80 cursor-wait",
              )}
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" /> Save changes
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

