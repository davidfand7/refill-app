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
import { Fragment } from "react";
import { toast } from "sonner";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  DoorOpen,
  ExternalLink,
  Globe,
  GripVertical,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  type BookableServiceDraft,
  type ResourceType,
} from "@/server/scheduling-settings.functions";
import { cn } from "@/lib/utils";
import { CategoryCombobox } from "@/components/refill/CategoryCombobox";
import { BusinessHoursSection } from "@/components/refill/booking/BusinessHoursSection";
import { BookingRulesSection } from "@/components/refill/booking/BookingRulesSection";
import { useBookingSettings } from "@/components/refill/booking/useBookingSettings";
import {
  BufferSelect,
  bookingUrl,
  DurationField,
  Toggle,
  TriCheckbox,
} from "@/components/refill/booking/fields";
import { categoryLabel, categoryRank } from "@/lib/service-categories";

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

  const {
    loading, saving, server, draft, setDraft,
    selDays, setSelDays, bulkOpen, setBulkOpen, bulkClose, setBulkClose,
    selProviderId, setSelProviderId,
    addingProvider, setAddingProvider, newProviderName, setNewProviderName, providerBusy,
    nameDrafts, setNameDrafts, expandedProvider, setExpandedProvider, providerSearch, setProviderSearch,
    expandedCats, setExpandedCats, svcSearch, setSvcSearch, showInactive, setShowInactive,
    collapsedSvcCats, setCollapsedSvcCats, renamingCat, setRenamingCat, renameText, setRenameText,
    addingSvc, setAddingSvc, newSvcName, setNewSvcName, newSvcCategory, setNewSvcCategory,
    newSvcPrice, setNewSvcPrice, svcBusy, expandedSvc, setExpandedSvc,
    psDrafts, setPsDrafts, durFmt,
    addingResource, setAddingResource, newResourceName, setNewResourceName,
    newResourceType, setNewResourceType, resourceBusy,
    resourceNameDrafts, setResourceNameDrafts,
    draggedSvcRef, startAutoScroll, stopAutoScroll,
    dirty, activeProviders, activeResourceTypes, selHours, selProviderName,
    svcQuery, inactiveCount, visibleServices, svcCat, sortedVisible, svcCatCounts, categoryOptions,
    setDurationFormat, patchSettings, patchDay, toggleSelDay,
    applyHoursToSelected, setSelectedClosed,
    onAddProvider, commitRename, onToggleProviderActive,
    performsService, togglePerforms, toggleCategoryPerforms,
    overrideFor, psFieldValue, offersService, commitOverride, toggleOffered,
    onAddResource, commitResourceRename, updateResource,
    patchService, commitCategoryRename, onAddService, onDeleteService, onSave,
  } = useBookingSettings({ viewAsUserId, isTenant: membership.status === "tenant" });

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
            <section className="rounded-xl border border-rule bg-white px-5 py-4">
              <div className="flex items-center gap-2 mb-1">
                <Users className="h-4 w-4 text-emerald" />
                <h3 className="text-[14px] font-semibold text-ink">Providers</h3>
              </div>
              <p className="text-[12px] text-ink-soft mb-3 leading-relaxed">
                Everyone who takes appointments. Each provider keeps their own hours and their own
                column on the calendar. Deactivate (rather than delete) anyone no longer booking —
                their past appointments stay intact.
              </p>
              <div className="divide-y divide-rule">
                {draft.providers.map((p) => {
                  const expanded = expandedProvider === p.id;
                  return (
                    <div key={p.id} className="py-1">
                      <div className="flex items-center gap-2 py-1.5">
                        {p.isActive ? (
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedProvider(expanded ? null : p.id);
                              setProviderSearch("");
                              setExpandedCats(new Set());
                            }}
                            className="shrink-0 text-ink-faint hover:text-ink transition"
                            title="Services this provider performs"
                            aria-label="Services this provider performs"
                          >
                            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !expanded && "-rotate-90")} />
                          </button>
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                        <input
                          type="text"
                          value={nameDrafts[p.id] ?? p.name}
                          onChange={(e) => setNameDrafts((m) => ({ ...m, [p.id]: e.target.value }))}
                          onBlur={() => void commitRename(p)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                          className={cn(
                            "flex-1 min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-[14px] text-ink outline-none hover:border-rule focus:border-emerald focus:ring-2 focus:ring-emerald/30",
                            !p.isActive && "text-ink-faint italic",
                          )}
                        />
                        {!p.isActive && (
                          <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-faint">
                            Inactive
                          </span>
                        )}
                        <Toggle checked={p.isActive} onChange={() => void onToggleProviderActive(p)} />
                      </div>

                      {expanded && p.isActive && (() => {
                        const q = providerSearch.trim().toLowerCase();
                        // Default: only bookable services (tidy). Search reaches the full catalog
                        // so you can pull in (and thereby make bookable) anything else.
                        const list = q
                          ? draft.services.filter((s) => s.name.toLowerCase().includes(q))
                          : draft.services.filter((s) => s.onlineBookable);
                        const byCat = new Map<string, BookableServiceDraft[]>();
                        for (const s of list) {
                          const cat = svcCat(s);
                          (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push(s);
                        }
                        const cats = Array.from(byCat.keys()).sort(
                          (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b),
                        );
                        return (
                          <div className="ml-5 mb-2 mt-1 rounded-lg border border-rule/60 bg-paper/30 px-3 py-2.5">
                            <div className="relative mb-2">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-faint" />
                              <input
                                type="text"
                                value={providerSearch}
                                onChange={(e) => setProviderSearch(e.target.value)}
                                placeholder="Search services…"
                                className="w-full rounded-md border border-rule bg-white pl-8 pr-3 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                              />
                            </div>
                            {cats.length === 0 ? (
                              <p className="text-[12px] text-ink-soft py-1.5">
                                {q
                                  ? "No services match."
                                  : "No bookable services yet — search to add the ones this provider performs."}
                              </p>
                            ) : (
                              <div className="space-y-0.5 max-h-80 overflow-y-auto">
                                {cats.map((cat) => {
                                  const svcs = byCat.get(cat)!;
                                  const performed = svcs.filter((s) => performsService(p.id, s.id)).length;
                                  const allOn = performed === svcs.length;
                                  const someOn = performed > 0 && !allOn;
                                  const open = !!q || expandedCats.has(cat);
                                  const toggleCat = () =>
                                    setExpandedCats((prev) => {
                                      const n = new Set(prev);
                                      if (n.has(cat)) n.delete(cat);
                                      else n.add(cat);
                                      return n;
                                    });
                                  return (
                                    <div key={cat}>
                                      <div className="flex items-center gap-2 py-1">
                                        <button
                                          type="button"
                                          onClick={toggleCat}
                                          className="shrink-0 text-ink-faint hover:text-ink transition"
                                          aria-label={open ? "Collapse category" : "Expand category"}
                                        >
                                          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
                                        </button>
                                        <TriCheckbox
                                          checked={allOn}
                                          indeterminate={someOn}
                                          onChange={() =>
                                            void toggleCategoryPerforms(p.id, svcs.map((s) => s.id), !allOn)
                                          }
                                        />
                                        <button
                                          type="button"
                                          onClick={toggleCat}
                                          className="flex-1 min-w-0 text-left text-[13px] font-medium text-ink truncate"
                                        >
                                          {categoryLabel(cat)}
                                        </button>
                                        <span className="text-[11px] text-ink-faint tabular-nums shrink-0">
                                          {performed}/{svcs.length}
                                        </span>
                                      </div>
                                      {open && (
                                        <div className="ml-6 space-y-0.5 pb-1">
                                          {svcs.map((s) => (
                                            <label
                                              key={s.id}
                                              className="flex items-center justify-between gap-2 py-0.5 px-1 rounded hover:bg-white cursor-pointer"
                                            >
                                              <span className="text-[13px] text-ink truncate">{s.name}</span>
                                              <input
                                                type="checkbox"
                                                checked={performsService(p.id, s.id)}
                                                onChange={(e) => void togglePerforms(p.id, s.id, e.target.checked)}
                                                className="h-4 w-4 rounded border-rule accent-emerald shrink-0"
                                              />
                                            </label>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            <p className="text-[11px] text-ink-faint mt-2 leading-relaxed">
                              Checking a service — or a whole category — makes it bookable and assigns
                              it to <strong>{p.name}</strong>.
                            </p>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
              {addingProvider ? (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-rule/60">
                  <input
                    type="text"
                    autoFocus
                    placeholder="Provider name"
                    value={newProviderName}
                    onChange={(e) => setNewProviderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void onAddProvider();
                      if (e.key === "Escape") {
                        setAddingProvider(false);
                        setNewProviderName("");
                      }
                    }}
                    className="flex-1 rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                  />
                  <button
                    type="button"
                    onClick={() => void onAddProvider()}
                    disabled={providerBusy || !newProviderName.trim()}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-2 text-[13px] font-medium text-paper hover:opacity-95 transition disabled:opacity-50"
                  >
                    {providerBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}{" "}
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingProvider(false);
                      setNewProviderName("");
                    }}
                    className="rounded-md border border-rule px-3 py-2 text-[13px] text-ink-soft hover:text-ink transition"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingProvider(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                >
                  <Plus className="h-3.5 w-3.5" /> Add provider
                </button>
              )}
            </section>

            {/* ── Rooms & resources ── */}
            <section className="rounded-xl border border-rule bg-white px-5 py-4">
              <div className="flex items-center gap-2 mb-1">
                <DoorOpen className="h-4 w-4 text-emerald" />
                <h3 className="text-[14px] font-semibold text-ink">Rooms &amp; resources</h3>
              </div>
              <p className="text-[12px] text-ink-soft mb-3 leading-relaxed">
                Treatment rooms, chairs, or devices an appointment occupies. Optional — add them if
                two appointments shouldn&rsquo;t need the same room at once. (Requiring a room per
                service comes next; for now this just sets up your list.)
              </p>

              {draft.resources.length > 0 && (
                <div className="divide-y divide-rule">
                  {draft.resources.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 py-2.5">
                      <input
                        type="text"
                        value={resourceNameDrafts[r.id] ?? r.name}
                        onChange={(e) =>
                          setResourceNameDrafts((m) => ({ ...m, [r.id]: e.target.value }))
                        }
                        onBlur={() => void commitResourceRename(r)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        className={cn(
                          "flex-1 min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-[14px] text-ink outline-none hover:border-rule focus:border-emerald focus:ring-2 focus:ring-emerald/30",
                          !r.isActive && "text-ink-faint italic",
                        )}
                      />
                      <select
                        value={r.type}
                        onChange={(e) => void updateResource(r, { type: e.target.value as ResourceType })}
                        className="rounded-md border border-rule bg-white px-2 py-1 text-[12px] text-ink-soft outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                      >
                        <option value="room">Room</option>
                        <option value="chair">Chair</option>
                        <option value="device">Device</option>
                      </select>
                      {!r.isActive && (
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-faint">
                          Inactive
                        </span>
                      )}
                      <Toggle
                        checked={r.isActive}
                        onChange={(v) => void updateResource(r, { isActive: v })}
                      />
                    </div>
                  ))}
                </div>
              )}

              {addingResource ? (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-rule/60">
                  <input
                    type="text"
                    autoFocus
                    placeholder="e.g. Room 1, Laser bay"
                    value={newResourceName}
                    onChange={(e) => setNewResourceName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void onAddResource();
                      if (e.key === "Escape") {
                        setAddingResource(false);
                        setNewResourceName("");
                      }
                    }}
                    className="flex-1 rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                  />
                  <select
                    value={newResourceType}
                    onChange={(e) => setNewResourceType(e.target.value as ResourceType)}
                    className="rounded-md border border-rule bg-white px-2 py-2 text-[13px] text-ink-soft outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                  >
                    <option value="room">Room</option>
                    <option value="chair">Chair</option>
                    <option value="device">Device</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void onAddResource()}
                    disabled={resourceBusy || !newResourceName.trim()}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-2 text-[13px] font-medium text-paper hover:opacity-95 transition disabled:opacity-50"
                  >
                    {resourceBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}{" "}
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingResource(false);
                      setNewResourceName("");
                    }}
                    className="rounded-md border border-rule px-3 py-2 text-[13px] text-ink-soft hover:text-ink transition"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingResource(true)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition",
                    draft.resources.length > 0 && "mt-3",
                  )}
                >
                  <Plus className="h-3.5 w-3.5" /> Add room or resource
                </button>
              )}
            </section>

            {/* ── Business hours ── */}
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

            {/* ── Booking rules ── */}
            <BookingRulesSection settings={draft.settings} patchSettings={patchSettings} />

            {/* ── Bookable services ── */}
            <section className="rounded-xl border border-rule bg-white px-5 py-4">
              <div className="flex items-center justify-between gap-2 mb-1">
                <h3 className="text-[14px] font-semibold text-ink">Bookable services</h3>
                <div className="inline-flex rounded-md border border-rule overflow-hidden text-[12px]">
                  <button
                    type="button"
                    onClick={() => setDurationFormat("hm")}
                    className={cn(
                      "px-2.5 py-1 font-medium transition tabular-nums",
                      durFmt === "hm" ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink",
                    )}
                  >
                    1h 30m
                  </button>
                  <button
                    type="button"
                    onClick={() => setDurationFormat("min")}
                    className={cn(
                      "px-2.5 py-1 font-medium transition tabular-nums border-l border-rule",
                      durFmt === "min" ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink",
                    )}
                  >
                    90 min
                  </button>
                </div>
              </div>
              <p className="text-[12px] text-ink-soft mb-3 leading-relaxed">
                Choose which services patients can book online, and set how long each takes
                (plus any cleanup buffer between appointments). Turning <strong>Bookable</strong> off
                tucks a service into <em>inactive</em> to keep this list tidy.
              </p>
              {draft.services.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <div className="relative flex-1 min-w-[180px]">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-faint" />
                    <input
                      type="text"
                      value={svcSearch}
                      onChange={(e) => setSvcSearch(e.target.value)}
                      placeholder="Search all services…"
                      className="w-full rounded-md border border-rule bg-white pl-8 pr-3 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                    />
                  </div>
                  {!svcQuery && inactiveCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowInactive((v) => !v)}
                      className="rounded-md border border-rule px-3 py-1.5 text-[12px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                    >
                      {showInactive ? "Hide inactive" : `Show inactive (${inactiveCount})`}
                    </button>
                  )}
                </div>
              )}
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
                  <div className="hidden sm:grid grid-cols-[1fr_136px_136px_72px] gap-2 pb-2 text-[11px] uppercase tracking-wider font-semibold text-ink-faint">
                    <span>Service</span>
                    <span className="text-right">Duration</span>
                    <span className="text-right">Buffer</span>
                    <span className="text-right">Bookable</span>
                  </div>
                  {visibleServices.length === 0 && (
                    <p className="text-[13px] text-ink-soft py-4">
                      {svcQuery
                        ? "No services match your search."
                        : "No active services yet — search above to find one and turn it Bookable, or set up by provider."}
                    </p>
                  )}
                  {sortedVisible.map((s, idx) => {
                    const canExpand = true; // every service expands to edit details / room / per-provider
                    const expanded = canExpand && expandedSvc === s.id;
                    const cat = svcCat(s);
                    const showHeader = idx === 0 || svcCat(sortedVisible[idx - 1]) !== cat;
                    const collapsed = collapsedSvcCats.has(cat);
                    return (
                      <Fragment key={s.id}>
                        {showHeader && (
                          <div
                            className="flex items-center gap-2 pt-3 pb-1"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => {
                              const id = draggedSvcRef.current;
                              draggedSvcRef.current = null;
                              if (id) patchService(id, { category: cat });
                            }}
                            title="Drop a service here to move it to this category"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setCollapsedSvcCats((p) => {
                                  const n = new Set(p);
                                  if (n.has(cat)) n.delete(cat);
                                  else n.add(cat);
                                  return n;
                                })
                              }
                              className="shrink-0 text-ink-faint hover:text-ink transition"
                              aria-label={collapsed ? "Expand category" : "Collapse category"}
                            >
                              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")} />
                            </button>
                            {renamingCat === cat ? (
                              <span className="flex items-center gap-1">
                                <input
                                  type="text"
                                  autoFocus
                                  value={renameText}
                                  onChange={(e) => setRenameText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void commitCategoryRename(cat);
                                    } else if (e.key === "Escape") {
                                      setRenamingCat(null);
                                    }
                                  }}
                                  className="w-40 rounded-md border border-emerald bg-white px-2 py-0.5 text-[12px] font-semibold text-ink outline-none focus:ring-2 focus:ring-emerald/30"
                                />
                                <button
                                  type="button"
                                  onClick={() => void commitCategoryRename(cat)}
                                  className="shrink-0 text-emerald hover:opacity-80 transition"
                                  aria-label="Save category name"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setRenamingCat(null)}
                                  className="shrink-0 text-ink-faint hover:text-ink transition"
                                  aria-label="Cancel rename"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </span>
                            ) : (
                              <span className="group/cat flex items-center gap-1.5">
                                <span className="text-[12px] font-semibold text-ink">
                                  {categoryLabel(cat)}
                                </span>
                                <span className="text-[11px] text-ink-faint tabular-nums">
                                  {svcCatCounts.get(cat) ?? 0}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRenamingCat(cat);
                                    setRenameText(categoryLabel(cat));
                                  }}
                                  className="shrink-0 text-ink-faint/0 group-hover/cat:text-ink-faint hover:!text-ink transition"
                                  aria-label="Rename category"
                                  title="Rename this category (updates every service in it)"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              </span>
                            )}
                            <span className="flex-1 border-t border-rule/40 ml-1" />
                          </div>
                        )}
                        {!collapsed && (
                      <div className="py-1">
                        <div className="grid grid-cols-[1fr_136px_136px_72px] gap-2 items-center py-1.5">
                          <div className="flex items-center gap-1 min-w-0">
                            <span
                              draggable
                              onDragStart={() => {
                                draggedSvcRef.current = s.id;
                                startAutoScroll();
                              }}
                              onDragEnd={() => stopAutoScroll()}
                              className="shrink-0 cursor-grab active:cursor-grabbing text-ink-faint/40 hover:text-ink-faint"
                              title="Drag to another category"
                            >
                              <GripVertical className="h-3.5 w-3.5" />
                            </span>
                            {canExpand && (
                              <button
                                type="button"
                                onClick={() => setExpandedSvc(expanded ? null : s.id)}
                                className="shrink-0 text-ink-faint hover:text-ink transition"
                                aria-label={expanded ? "Hide advanced settings" : "Advanced (room + per-provider)"}
                                title="Room requirement &amp; per-provider time/price"
                              >
                                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !expanded && "-rotate-90")} />
                              </button>
                            )}
                            <span className="text-[13px] text-ink truncate">{s.name}</span>
                          </div>
                          <DurationField
                            minutes={s.durationMin}
                            min={5}
                            format={durFmt}
                            onChange={(m) => patchService(s.id, { durationMin: m })}
                          />
                          <BufferSelect
                            minutes={s.bufferMin}
                            onChange={(m) => patchService(s.id, { bufferMin: m })}
                          />
                          <div className="flex justify-end">
                            <Toggle
                              checked={s.onlineBookable}
                              onChange={(v) => patchService(s.id, { onlineBookable: v })}
                            />
                          </div>
                        </div>

                        {/* Advanced per-service settings (details + room + per-provider). */}
                        {expanded && (
                          <div className="ml-5 mb-2 mt-1 rounded-lg border border-rule/60 bg-paper/30 px-3 py-2.5 space-y-3">
                            {/* Service details — name / category / price (batched Save) + delete. */}
                            <div className="grid grid-cols-[1fr_110px_90px_auto] gap-2 items-end">
                              <div>
                                <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                                  Name
                                </label>
                                <input
                                  type="text"
                                  value={s.name}
                                  onChange={(e) => patchService(s.id, { name: e.target.value })}
                                  className="w-full rounded-md border border-rule bg-white px-2 py-1 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                                  Category
                                </label>
                                <CategoryCombobox
                                  value={s.category}
                                  onChange={(c) => patchService(s.id, { category: c })}
                                  options={categoryOptions}
                                  className="w-full rounded-md border border-rule bg-white px-1.5 py-1 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                                  Price
                                </label>
                                <div className="flex items-center gap-1">
                                  <span className="text-[11px] text-ink-faint">$</span>
                                  <input
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={s.price}
                                    onChange={(e) =>
                                      patchService(s.id, {
                                        price: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100) / 100),
                                      })
                                    }
                                    className="w-full rounded-md border border-rule bg-white px-1.5 py-1 text-[13px] text-ink text-right outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                                  />
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => void onDeleteService(s)}
                                className="inline-flex items-center justify-center rounded-md border border-bad/30 px-2 py-1.5 text-bad hover:bg-bad/5 transition"
                                title="Delete service"
                                aria-label="Delete service"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {activeResourceTypes.length > 0 && (
                              <div>
                                <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                                  Requires
                                </label>
                                <select
                                  value={s.requiredResourceType ?? ""}
                                  onChange={(e) =>
                                    patchService(s.id, {
                                      requiredResourceType: (e.target.value || null) as ResourceType | null,
                                    })
                                  }
                                  className="rounded-md border border-rule bg-white px-2 py-1 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                                >
                                  <option value="">No room needed</option>
                                  {activeResourceTypes.map((t) => (
                                    <option key={t} value={t}>
                                      Any {t}
                                    </option>
                                  ))}
                                </select>
                                <p className="text-[12px] text-ink-soft mt-1 leading-relaxed">
                                  {s.requiredResourceType
                                    ? `A time is offered only when a ${s.requiredResourceType} is free; booking assigns one automatically.`
                                    : "This service doesn't tie up a room."}
                                </p>
                              </div>
                            )}
                            {activeProviders.length > 1 && (
                              <div>
                            <div className="text-[11px] text-ink-soft mb-2">
                              Per-provider time &amp; price{" "}
                              <span className="text-ink-faint">
                                — blank inherits {s.durationMin} min · ${s.price}; uncheck to hide a
                                provider from this service
                              </span>
                            </div>
                            <div className="space-y-1.5">
                              {activeProviders.map((p) => {
                                const offers = offersService(p.id, s.id);
                                return (
                                  <div key={p.id} className="grid grid-cols-[1fr_84px_84px] gap-2 items-center">
                                    <label className="flex items-center gap-1.5 text-[12px] min-w-0 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={offers}
                                        onChange={(e) => void toggleOffered(p.id, s.id, e.target.checked)}
                                        className="h-3.5 w-3.5 rounded border-rule accent-emerald shrink-0"
                                      />
                                      <span className={cn("truncate", offers ? "text-ink" : "text-ink-faint line-through")}>
                                        {p.name}
                                      </span>
                                    </label>
                                    <div className="flex items-center justify-end gap-1">
                                      <input
                                        type="number"
                                        min={1}
                                        max={1440}
                                        disabled={!offers}
                                        placeholder={String(s.durationMin)}
                                        value={psFieldValue(p.id, s.id, "durationMin")}
                                        onChange={(e) =>
                                          setPsDrafts((m) => ({
                                            ...m,
                                            [`${p.id}|${s.id}|durationMin`]: e.target.value,
                                          }))
                                        }
                                        onBlur={(e) => void commitOverride(p.id, s.id, "durationMin", e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") e.currentTarget.blur();
                                        }}
                                        className={cn(
                                          "w-12 rounded-md border border-rule bg-white px-1.5 py-1 text-[12px] text-ink text-right outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums placeholder:text-ink-faint/60",
                                          !offers && "opacity-40",
                                        )}
                                      />
                                      <span className="text-[11px] text-ink-faint">m</span>
                                    </div>
                                    <div className="flex items-center justify-end gap-1">
                                      <span className="text-[11px] text-ink-faint">$</span>
                                      <input
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        disabled={!offers}
                                        placeholder={String(s.price)}
                                        value={psFieldValue(p.id, s.id, "price")}
                                        onChange={(e) =>
                                          setPsDrafts((m) => ({
                                            ...m,
                                            [`${p.id}|${s.id}|price`]: e.target.value,
                                          }))
                                        }
                                        onBlur={(e) => void commitOverride(p.id, s.id, "price", e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") e.currentTarget.blur();
                                        }}
                                        className={cn(
                                          "w-14 rounded-md border border-rule bg-white px-1.5 py-1 text-[12px] text-ink text-right outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums placeholder:text-ink-faint/60",
                                          !offers && "opacity-40",
                                        )}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              )}

              {/* Add a new service to the catalog (immediate). */}
              {addingSvc ? (
                <div className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t border-rule/60">
                  <div className="flex-1 min-w-[160px]">
                    <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                      Name
                    </label>
                    <input
                      type="text"
                      autoFocus
                      value={newSvcName}
                      onChange={(e) => setNewSvcName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void onAddService();
                        if (e.key === "Escape") setAddingSvc(false);
                      }}
                      placeholder="e.g. Lip filler"
                      className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                      Category
                    </label>
                    <CategoryCombobox
                      value={newSvcCategory}
                      onChange={(c) => setNewSvcCategory(c)}
                      options={categoryOptions}
                      className="w-full rounded-md border border-rule bg-white px-2 py-2 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                      Price
                    </label>
                    <div className="flex items-center gap-1">
                      <span className="text-[12px] text-ink-faint">$</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={newSvcPrice}
                        onChange={(e) => setNewSvcPrice(e.target.value)}
                        placeholder="0"
                        className="w-20 rounded-md border border-rule bg-white px-2 py-2 text-[14px] text-ink text-right outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onAddService()}
                    disabled={svcBusy || !newSvcName.trim()}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-2 text-[13px] font-medium text-paper hover:opacity-95 transition disabled:opacity-50"
                  >
                    {svcBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingSvc(false)}
                    className="rounded-md border border-rule px-3 py-2 text-[13px] text-ink-soft hover:text-ink transition"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingSvc(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                >
                  <Plus className="h-3.5 w-3.5" /> Add service
                </button>
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

