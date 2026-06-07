/**
 * ServiceLibraryPicker (v1.83.0) — curate services from the pre-loaded library.
 *
 * Browse the global service library by category, search, multi-select, and add
 * the chosen ones to the tenant's catalog (copy-on-select on the server). Already-
 * added entries (same name + category) show as "Added" and can't be re-selected.
 * On add, the created services are handed back to the parent to merge into state.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronRight, Loader2, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { categoryLabel, categoryRank } from "@/lib/service-categories";
import {
  listServiceLibraryFn,
  addServicesFromLibraryFn,
  type Service,
  type ServiceLibraryEntry,
} from "@/server/refill-catalog";

const keyOf = (cat: string, name: string) => `${cat.trim().toLowerCase()}|${name.trim().toLowerCase()}`;

export function ServiceLibraryPicker({
  open,
  onClose,
  viewAsUserId,
  existingKeys,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  viewAsUserId?: string;
  /** `${category}|${name}` (lowercased) of services the tenant already has. */
  existingKeys: Set<string>;
  onAdded: (created: Service[]) => void;
}) {
  const [entries, setEntries] = useState<ServiceLibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSel(new Set());
    setQ("");
    setExpanded(new Set());
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const rows = await listServiceLibraryFn({ data: { accessToken: token, viewAsUserId } });
        if (!cancelled) setEntries(rows);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Couldn't load the library.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, viewAsUserId]);

  const searching = q.trim().length > 0;
  const groups = useMemo(() => {
    const m = new Map<string, ServiceLibraryEntry[]>();
    const ql = q.trim().toLowerCase();
    for (const e of entries) {
      if (ql && !e.name.toLowerCase().includes(ql) && !e.category.toLowerCase().includes(ql)) continue;
      const arr = m.get(e.category) ?? [];
      arr.push(e);
      m.set(e.category, arr);
    }
    return [...m.entries()]
      .map(([cat, rows]) => ({
        cat,
        rows: rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => categoryRank(a.cat) - categoryRank(b.cat) || a.cat.localeCompare(b.cat));
  }, [entries, q]);

  function toggle(id: string) {
    setSel((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleCat(cat: string) {
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(cat)) n.delete(cat);
      else n.add(cat);
      return n;
    });
  }
  function toggleSelectAll(rows: ServiceLibraryEntry[]) {
    const addable = rows.filter((e) => !existingKeys.has(keyOf(e.category, e.name)));
    setSel((p) => {
      const n = new Set(p);
      const allSel = addable.length > 0 && addable.every((e) => n.has(e.id));
      addable.forEach((e) => (allSel ? n.delete(e.id) : n.add(e.id)));
      return n;
    });
  }

  async function add() {
    if (sel.size === 0 || busy) return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const r = await addServicesFromLibraryFn({
        data: { accessToken: token, viewAsUserId, libraryIds: [...sel] },
      });
      onAdded(r.created);
      toast.success(
        `Added ${r.created.length} service${r.created.length === 1 ? "" : "s"}` +
          (r.skipped ? ` · ${r.skipped} already in your catalog` : "") +
          ". Set prices and order them below.",
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add services.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add from the service library</DialogTitle>
          <DialogDescription>
            Pick the services you offer — we&rsquo;ll add them to your catalog, ready to price and order.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-faint" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the library…"
            className="w-full rounded-md border border-rule bg-white pl-8 pr-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-rule divide-y divide-rule mt-1">
          {loading ? (
            <div className="flex items-center gap-2 text-ink-soft text-[13px] px-4 py-6">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the library…
            </div>
          ) : groups.length === 0 ? (
            <p className="text-[13px] text-ink-soft px-4 py-6">No services match your search.</p>
          ) : (
            groups.map(({ cat, rows }) => {
              const isOpen = searching || expanded.has(cat);
              const addable = rows.filter((e) => !existingKeys.has(keyOf(e.category, e.name)));
              const selCount = rows.filter((e) => sel.has(e.id)).length;
              return (
                <div key={cat}>
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-paper/40">
                    <button
                      type="button"
                      onClick={() => toggleCat(cat)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    >
                      <ChevronRight
                        className={cn("h-4 w-4 text-ink-faint transition-transform", isOpen && "rotate-90")}
                      />
                      <span className="text-[14px] font-semibold text-ink">{categoryLabel(cat)}</span>
                      <span className="text-[12px] text-ink-faint tabular-nums">{rows.length}</span>
                      {selCount > 0 && (
                        <span className="text-[11px] font-semibold text-emerald">{selCount} selected</span>
                      )}
                    </button>
                    {addable.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleSelectAll(rows)}
                        className="shrink-0 text-[12px] font-medium text-ink-soft hover:text-emerald transition"
                      >
                        {addable.every((e) => sel.has(e.id)) ? "Clear" : "Select all"}
                      </button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="divide-y divide-rule/60">
                      {rows.map((e) => {
                        const added = existingKeys.has(keyOf(e.category, e.name));
                        const checked = added || sel.has(e.id);
                        return (
                          <label
                            key={e.id}
                            className={cn(
                              "flex items-center gap-3 pl-9 pr-3 py-2 text-[14px]",
                              added ? "opacity-60 cursor-default" : "cursor-pointer hover:bg-paper/50",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={added}
                              onChange={() => !added && toggle(e.id)}
                              className="h-4 w-4 rounded border-rule accent-emerald shrink-0"
                            />
                            <span className="flex-1 min-w-0 truncate text-ink">{e.name}</span>
                            <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">
                              {e.defaultDurationMin} min
                            </span>
                            {added && (
                              <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald">
                                <Check className="h-3 w-3" /> Added
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-[13px] text-ink-soft hover:text-ink transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={add}
            disabled={busy || sel.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper hover:opacity-95 transition disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {sel.size > 0 ? `Add ${sel.size} service${sel.size === 1 ? "" : "s"}` : "Add services"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
