/**
 * Providers section of the booking-settings page (extracted in the v1.68.x
 * consolidation sprint). Consumes the useBookingSettings hook via bk; JSX is
 * byte-identical to the former inline section.
 */

import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { Check, CheckCircle2, ChevronDown, Clock, Copy, DoorOpen, ExternalLink, Globe, GripVertical, Link2, Loader2, Pencil, Plus, Search, Sparkles, Trash2, Users, X } from "lucide-react";
import { CategoryCombobox } from "@/components/refill/CategoryCombobox";
import { BufferSelect, DurationField, Toggle, TriCheckbox } from "@/components/refill/booking/fields";
import { categoryLabel, categoryRank } from "@/lib/service-categories";
import type { BookableServiceDraft, ResourceType } from "@/server/scheduling-settings.functions";
import type { BookingSettings } from "@/components/refill/booking/useBookingSettings";

export function ProvidersSection({ bk }: { bk: BookingSettings }) {
  const {
    draft, setDraft, selProviderId, setSelProviderId,
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
    activeProviders, activeResourceTypes, svcQuery, inactiveCount, visibleServices,
    svcCat, sortedVisible, svcCatCounts, categoryOptions,
    onAddProvider, commitRename, onToggleProviderActive,
    performsService, togglePerforms, toggleCategoryPerforms,
    overrideFor, psFieldValue, offersService, commitOverride, toggleOffered,
    onAddResource, commitResourceRename, updateResource,
    patchService, commitCategoryRename, onAddService, onDeleteService,
  } = bk;
  if (!draft) return null;
  return (
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
                        {p.isActive && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelProviderId(p.id);
                              if (typeof document !== "undefined") {
                                document
                                  .getElementById("provider-hours")
                                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
                              }
                            }}
                            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-[11px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                            title="Set this provider's weekly hours"
                          >
                            <Clock className="h-3 w-3" /> Hours
                          </button>
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
  );
}
