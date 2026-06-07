/**
 * Bookable services section of the booking-settings page (extracted in the v1.68.x
 * consolidation sprint). Consumes the useBookingSettings hook via bk; JSX is
 * byte-identical to the former inline section.
 */

import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronsDownUp, ChevronsUpDown, Copy, DoorOpen, ExternalLink, Globe, GripVertical, Link2, Loader2, Pencil, Plus, Search, Sparkles, Trash2, Users, X } from "lucide-react";
import { CategoryCombobox } from "@/components/refill/CategoryCombobox";
import { BufferSelect, DurationField, Toggle, TriCheckbox } from "@/components/refill/booking/fields";
import { categoryLabel, categoryRank } from "@/lib/service-categories";
import type { BookableServiceDraft, ResourceType } from "@/server/scheduling-settings.functions";
import type { BookingSettings } from "@/components/refill/booking/useBookingSettings";

export function BookableServicesSection({ bk }: { bk: BookingSettings }) {
  const {
    draft, setDraft, selProviderId,
    addingProvider, setAddingProvider, newProviderName, setNewProviderName, providerBusy,
    nameDrafts, setNameDrafts, expandedProvider, setExpandedProvider, providerSearch, setProviderSearch,
    expandedCats, setExpandedCats, svcSearch, setSvcSearch, showInactive, setShowInactive,
    collapsedSvcCats, setCollapsedSvcCats, renamingCat, setRenamingCat, renameText, setRenameText,
    addingSvc, setAddingSvc, newSvcName, setNewSvcName, newSvcCategory, setNewSvcCategory,
    newSvcPrice, setNewSvcPrice, svcBusy, expandedSvc, setExpandedSvc,
    addingCat, setAddingCat, newCatName, setNewCatName, emptyPendingCats, setPendingCats, onAddCategory,
    psDrafts, setPsDrafts, durFmt, setDurationFormat,
    draggedSvcRef, startAutoScroll, stopAutoScroll,
    activeProviders, activeResourceTypes, svcQuery, inactiveCount, visibleServices,
    svcCat, sortedVisible, svcCatCounts, categoryOptions, allCatsCollapsed, toggleAllCats,
    visibleByCat, setCategoryBookable,
    performsService, togglePerforms, toggleCategoryPerforms,
    overrideFor, psFieldValue, offersService, commitOverride, toggleOffered,
    patchService, commitCategoryRename, onAddService, onDeleteService,
  } = bk;
  if (!draft) return null;
  return (
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
              {/* Add a new service (immediate). Kept at the TOP so its category
                  dropdown opens in view without scrolling past the whole list. */}
              {addingSvc ? (
                <div className="flex flex-wrap items-end gap-2 mb-3 pb-3 border-b border-rule/60">
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
              ) : addingCat ? (
                <div className="flex flex-wrap items-end gap-2 mb-3 pb-3 border-b border-rule/60">
                  <div className="flex-1 min-w-[160px] max-w-xs">
                    <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                      New category name
                    </label>
                    <input
                      type="text"
                      autoFocus
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onAddCategory();
                        if (e.key === "Escape") setAddingCat(false);
                      }}
                      placeholder="e.g. Body Contouring"
                      className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => onAddCategory()}
                    disabled={!newCatName.trim()}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-2 text-[13px] font-medium text-paper hover:opacity-95 transition disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingCat(false)}
                    className="rounded-md border border-rule px-3 py-2 text-[13px] text-ink-soft hover:text-ink transition"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => setAddingSvc(true)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add service
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingCat(true)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add category
                  </button>
                </div>
              )}
              {emptyPendingCats.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {emptyPendingCats.map((cat) => (
                    <div
                      key={cat}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        const id = draggedSvcRef.current;
                        draggedSvcRef.current = null;
                        if (id) patchService(id, { category: cat });
                      }}
                      title="Drop a service here to put it in this category"
                      className="flex items-center gap-2 rounded-md border border-dashed border-emerald/50 bg-emerald/5 px-2.5 py-2"
                    >
                      <span className="text-[12px] font-semibold text-ink">{categoryLabel(cat)}</span>
                      <span className="text-[11px] text-ink-faint tabular-nums">0</span>
                      <span className="text-[11px] text-ink-faint italic">— drag services here, then Save</span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={() => setPendingCats((p) => p.filter((c) => c !== cat))}
                        className="shrink-0 text-ink-faint hover:text-ink transition"
                        aria-label="Discard this empty category"
                        title="Discard this empty category"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
                  {svcCatCounts.size > 1 && (
                    <button
                      type="button"
                      onClick={() => toggleAllCats()}
                      className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-[12px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
                      title={allCatsCollapsed ? "Expand every category" : "Collapse every category"}
                    >
                      {allCatsCollapsed ? (
                        <>
                          <ChevronsUpDown className="h-3.5 w-3.5" /> Expand all
                        </>
                      ) : (
                        <>
                          <ChevronsDownUp className="h-3.5 w-3.5" /> Collapse all
                        </>
                      )}
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
                    const catRows = visibleByCat.get(cat) ?? [];
                    const catOnCount = catRows.filter((r) => r.onlineBookable).length;
                    const catAllOn = catRows.length > 0 && catOnCount === catRows.length;
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
                            <label
                              className="flex items-center gap-1.5 text-[11px] font-medium text-ink-soft cursor-pointer shrink-0 pr-0.5"
                              title={
                                catAllOn
                                  ? `Make all ${catRows.length} ${categoryLabel(cat)} services not bookable`
                                  : `Make all ${catRows.length} ${categoryLabel(cat)} services bookable`
                              }
                            >
                              <span className="hidden sm:inline">All bookable</span>
                              <TriCheckbox
                                checked={catAllOn}
                                indeterminate={catOnCount > 0 && !catAllOn}
                                onChange={() => setCategoryBookable(cat, !catAllOn)}
                              />
                            </label>
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
                            {s.onlineBookable &&
                              activeProviders.length > 0 &&
                              !activeProviders.some((p) => offersService(p.id, s.id)) && (
                                <span
                                  className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                                  title="No provider performs this service, so it won't appear on your booking page. Expand this row (or a provider in Providers) to assign someone."
                                >
                                  <AlertTriangle className="h-2.5 w-2.5" /> No provider
                                </span>
                              )}
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
            </section>
  );
}
