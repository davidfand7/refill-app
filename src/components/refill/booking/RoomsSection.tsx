/**
 * Rooms & resources section of the booking-settings page (extracted in the v1.68.x
 * consolidation sprint). Consumes the useBookingSettings hook via bk; JSX is
 * byte-identical to the former inline section.
 */

import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { Check, CheckCircle2, ChevronDown, Copy, DoorOpen, ExternalLink, Globe, GripVertical, Link2, Loader2, Pencil, Plus, Search, Sparkles, Trash2, Users, X } from "lucide-react";
import { CategoryCombobox } from "@/components/refill/CategoryCombobox";
import { BufferSelect, DurationField, Toggle, TriCheckbox } from "@/components/refill/booking/fields";
import { categoryLabel, categoryRank } from "@/lib/service-categories";
import type { BookableServiceDraft, ResourceType } from "@/server/scheduling-settings.functions";
import type { BookingSettings } from "@/components/refill/booking/useBookingSettings";

export function RoomsSection({ bk }: { bk: BookingSettings }) {
  const {
    draft, setDraft, selProviderId,
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
  );
}
