/**
 * useBookingSettings — owns all state, derived values, and mutation handlers for
 * the Online-booking settings page (extracted in the v1.68.x consolidation
 * sprint). The page calls this once and destructures the result into the same
 * local names its render already uses, so the render is unchanged. Several
 * sections (Providers, Bookable services) share the provider×service handler
 * cluster that lives here, which is why they couldn't be split until now.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useDragAutoScroll } from "@/lib/use-drag-autoscroll";
import { clampInt } from "@/components/refill/booking/fields";
import {
  assignProviderServiceFn,
  assignProviderServicesBulkFn,
  createBookableServiceFn,
  reorderServicesFn,
  reorderCategoriesFn,
  upsertDateOverrideFn,
  deleteDateOverrideFn,
  createProviderFn,
  createResourceFn,
  deleteBookableServiceFn,
  getSchedulingSetupFn,
  renameServiceCategoryFn,
  saveSchedulingSetupFn,
  setProviderServiceOverrideFn,
  updateProviderFn,
  updateResourceFn,
  type BookableServiceDraft,
  type ServiceAssignmentResult,
  type ProviderRow,
  type DateOverrideDraft,
  type ProviderServiceOverrideRow,
  type ResourceRow,
  type ResourceType,
  type ServiceCategory,
  type SchedulingHoursDraft,
  type SchedulingSettingsDraft,
  type SchedulingSetupBundle,
} from "@/server/scheduling-settings.functions";
import {
  buildCategoryList,
  categoryLabel,
  categoryRank,
  orderedCategoryRank,
  normalizeCategory,
  type CategoryOption,
} from "@/lib/service-categories";

export function useBookingSettings({
  viewAsUserId,
  isTenant,
}: {
  viewAsUserId: string | undefined;
  isTenant: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [server, setServer] = useState<SchedulingSetupBundle | null>(null);
  const [draft, setDraft] = useState<SchedulingSetupBundle | null>(null);
  const [selDays, setSelDays] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState("09:00");
  const [bulkClose, setBulkClose] = useState("17:00");
  // Which provider's hours the business-hours grid is editing.
  const [selProviderId, setSelProviderId] = useState<string>("");
  // Provider management (persisted immediately, separate from the batched Save).
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProviderName, setNewProviderName] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  // Transient rename buffers, keyed by providerId (so renaming never trips dirty).
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  // Provider→services assignment panel (turn-down per provider).
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerSearch, setProviderSearch] = useState("");
  // Which service categories are expanded inside the open provider panel.
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  // Bookable-services list declutter: search + show-inactive.
  const [svcSearch, setSvcSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  // Services list: collapsible categories + drag-to-recategorize.
  const [collapsedSvcCats, setCollapsedSvcCats] = useState<Set<string>>(new Set());
  // Inline category rename at the accordion header.
  const [renamingCat, setRenamingCat] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const draggedSvcRef = useRef<string | null>(null);
  // Which category is being dragged (header grip) — distinguishes a category
  // reorder from a service drop on a category header.
  const draggedCatRef = useRef<string | null>(null);
  // Auto-scroll the window while dragging a service near the top/bottom edge.
  const { start: startAutoScroll, stop: stopAutoScroll } = useDragAutoScroll();
  // Add-service form.
  const [addingSvc, setAddingSvc] = useState(false);
  const [newSvcName, setNewSvcName] = useState("");
  const [newSvcCategory, setNewSvcCategory] = useState<ServiceCategory>("other");
  const [newSvcPrice, setNewSvcPrice] = useState("");
  const [svcBusy, setSvcBusy] = useState(false);
  // Add-category form. Categories are free text on each service row, so a brand-
  // new one has nowhere to live until a service uses it. These "pending" empties
  // surface as droppable group headers so existing services can be dragged in;
  // the category persists (on Save) the moment a service lands in it.
  const [addingCat, setAddingCat] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [pendingCats, setPendingCats] = useState<string[]>([]);
  // Which bookable service is expanded to its per-provider override panel.
  const [expandedSvc, setExpandedSvc] = useState<string | null>(null);
  // Transient override input buffers, keyed `${providerId}|${serviceId}|${field}`.
  const [psDrafts, setPsDrafts] = useState<Record<string, string>>({});
  // Duration display format ("hm" = 1h 30m, "min" = 90 min). UI-only pref.
  const [durFmt, setDurFmt] = useState<"hm" | "min">(() => {
    if (typeof window === "undefined") return "hm";
    return window.localStorage.getItem("refill.booking.durFmt") === "min" ? "min" : "hm";
  });
  function setDurationFormat(f: "hm" | "min") {
    setDurFmt(f);
    if (typeof window !== "undefined") window.localStorage.setItem("refill.booking.durFmt", f);
  }
  // Rooms/resources management.
  const [addingResource, setAddingResource] = useState(false);
  const [newResourceName, setNewResourceName] = useState("");
  const [newResourceType, setNewResourceType] = useState<ResourceType>("room");
  const [resourceBusy, setResourceBusy] = useState(false);
  const [resourceNameDrafts, setResourceNameDrafts] = useState<Record<string, string>>({});
  // Per-provider date-specific availability overrides (add form, for selProvider).
  const [addingOverride, setAddingOverride] = useState(false);
  const [ovDate, setOvDate] = useState("");
  const [ovRange, setOvRange] = useState(false); // false = single day (default); true = From→To range
  const [ovEndDate, setOvEndDate] = useState("");
  const [ovClosed, setOvClosed] = useState(false);
  const [ovOpen, setOvOpen] = useState("09:00");
  const [ovClose, setOvClose] = useState("17:00");
  const [ovBusy, setOvBusy] = useState(false);

  useEffect(() => {
    if (!isTenant) return;
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
        // Default the hours grid to the primary provider (or first active).
        const firstActive = result.providers.find((p) => p.isActive);
        setSelProviderId(result.providerId || firstActive?.id || "");
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
  }, [isTenant, viewAsUserId]);

  const dirty = useMemo(
    () => !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server),
    [draft, server],
  );
  // Per-zone dirtiness so each STAGED section can light up its own "Save changes"
  // chip right at the edit. Instant ops (providers, rooms, date overrides, add/
  // delete service, reorder, rename) write to both draft+server, so they never
  // trip these. Settings = master toggle + timezone + booking rules; hours =
  // weekly grid; services = per-service bookable/duration/buffer.
  const settingsDirty = useMemo(
    () => !!draft && !!server && JSON.stringify(draft.settings) !== JSON.stringify(server.settings),
    [draft, server],
  );
  const hoursDirty = useMemo(
    () =>
      !!draft && !!server &&
      JSON.stringify(draft.hoursByProvider) !== JSON.stringify(server.hoursByProvider),
    [draft, server],
  );
  const servicesDirty = useMemo(
    () => !!draft && !!server && JSON.stringify(draft.services) !== JSON.stringify(server.services),
    [draft, server],
  );
  /** Discard all staged (Save-pending) edits, reverting the draft to the last
   *  saved snapshot. Instant ops already persisted, so they're unaffected. */
  function onDiscard() {
    setDraft(server);
  }

  const activeProviders = useMemo(() => draft?.providers.filter((p) => p.isActive) ?? [], [draft]);
  // Distinct active resource types (room/chair/device) a service can require.
  const activeResourceTypes = useMemo(() => {
    const order: ResourceType[] = ["room", "chair", "device"];
    const present = new Set((draft?.resources ?? []).filter((r) => r.isActive).map((r) => r.type));
    return order.filter((t) => present.has(t));
  }, [draft]);
  const selHours = draft?.hoursByProvider[selProviderId] ?? [];
  const selProviderName = draft?.providers.find((p) => p.id === selProviderId)?.name ?? "";
  const selDateOverrides: DateOverrideDraft[] = draft?.dateOverridesByProvider?.[selProviderId] ?? [];

  // Bookable-services list: default to active (bookable); search/show-inactive reveal the rest.
  const svcQuery = svcSearch.trim().toLowerCase();
  const inactiveCount = (draft?.services ?? []).filter((s) => !s.onlineBookable).length;
  const visibleServices = (draft?.services ?? []).filter((s) => {
    if (svcQuery) return s.name.toLowerCase().includes(svcQuery); // searching → all matches
    if (showInactive) return true; // show everything
    return s.onlineBookable; // default → active only
  });
  // Group the list by category (known categories first, then any extras), each
  // sorted by name — and a per-category count for the headers.
  const svcCat = (s: BookableServiceDraft) => s.category?.trim() || "other";
  // Built-ins + every custom category in use + any just-created (still empty)
  // ones — the shared source that keeps Booking mirrored with the Catalog.
  const categoryOptions: CategoryOption[] = buildCategoryList([
    ...(draft?.services ?? []).map((s) => s.category),
    ...pendingCats,
  ]);
  // Just-created categories that no service uses yet — rendered as empty,
  // droppable group headers so existing services can be sorted into them.
  const usedCats = new Set((draft?.services ?? []).map((s) => svcCat(s)));
  const emptyPendingCats = pendingCats.filter((c) => !usedCats.has(c));
  const categoryOrder = draft?.categoryOrder ?? [];
  const sortedVisible = [...visibleServices].sort(
    (a, b) =>
      orderedCategoryRank(svcCat(a), categoryOrder) - orderedCategoryRank(svcCat(b), categoryOrder) ||
      svcCat(a).localeCompare(svcCat(b)) ||
      (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) ||
      a.name.localeCompare(b.name),
  );
  const svcCatCounts = new Map<string, number>();
  for (const s of visibleServices) svcCatCounts.set(svcCat(s), (svcCatCounts.get(svcCat(s)) ?? 0) + 1);
  // Expand/collapse ALL category groups at once. "All collapsed" drives the
  // toggle's label/state; toggling sets every visible category collapsed or none.
  const visibleCats = [...svcCatCounts.keys()];
  const allCatsCollapsed = visibleCats.length > 0 && visibleCats.every((c) => collapsedSvcCats.has(c));
  function toggleAllCats() {
    setCollapsedSvcCats(allCatsCollapsed ? new Set() : new Set(visibleCats));
  }
  // Bulk Bookable by category: the rows shown under each header, so a spa can
  // flip a whole treatment family (e.g. all "RF Microneedling" areas) on/off at
  // once. State reflects exactly what's visible; persists with the batched Save.
  const visibleByCat = new Map<string, BookableServiceDraft[]>();
  for (const s of sortedVisible) {
    const arr = visibleByCat.get(svcCat(s)) ?? [];
    arr.push(s);
    visibleByCat.set(svcCat(s), arr);
  }
  function setCategoryBookable(cat: string, next: boolean) {
    const ids = new Set((visibleByCat.get(cat) ?? []).map((s) => s.id));
    if (ids.size === 0) return;
    setDraft((d) =>
      d
        ? { ...d, services: d.services.map((s) => (ids.has(s.id) ? { ...s, onlineBookable: next } : s)) }
        : d,
    );
  }

  // Keep the selected provider valid (e.g. after deactivating the selected one).
  useEffect(() => {
    if (!draft) return;
    const active = draft.providers.filter((p) => p.isActive);
    if (active.length && !active.some((p) => p.id === selProviderId)) {
      setSelProviderId(active[0].id);
    }
  }, [draft, selProviderId]);

  function patchSettings(patch: Partial<SchedulingSettingsDraft>) {
    setDraft((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  }
  /** Apply the same immediate-persist transform to both the saved snapshot and
   *  the working draft (the recurring pattern across provider/resource/service
   *  ops that persist on the spot, outside the batched Save). */
  function applyToBoth(fn: (b: SchedulingSetupBundle) => SchedulingSetupBundle) {
    setServer((b) => (b ? fn(b) : b));
    setDraft((b) => (b ? fn(b) : b));
  }
  /** Map the selected provider's hours rows; no-op for other providers. */
  function mapSelectedHours(
    d: SchedulingSetupBundle,
    fn: (h: SchedulingHoursDraft) => SchedulingHoursDraft,
  ): SchedulingSetupBundle {
    const rows = d.hoursByProvider[selProviderId];
    if (!rows) return d;
    return {
      ...d,
      hoursByProvider: { ...d.hoursByProvider, [selProviderId]: rows.map(fn) },
    };
  }
  function patchDay(dayOfWeek: number, patch: Partial<SchedulingHoursDraft>) {
    setDraft((d) =>
      d ? mapSelectedHours(d, (h) => (h.dayOfWeek === dayOfWeek ? { ...h, ...patch } : h)) : d,
    );
  }
  function toggleSelDay(dow: number) {
    setSelDays((s) => {
      const n = new Set(s);
      if (n.has(dow)) n.delete(dow);
      else n.add(dow);
      return n;
    });
  }
  function applyHoursToSelected() {
    if (selDays.size === 0) return;
    if (bulkOpen >= bulkClose) {
      toast.error("Open time must be before close time.");
      return;
    }
    setDraft((d) =>
      d
        ? mapSelectedHours(d, (h) =>
            selDays.has(h.dayOfWeek)
              ? { ...h, openTime: bulkOpen, closeTime: bulkClose, isClosed: false }
              : h,
          )
        : d,
    );
    toast(`Set ${bulkOpen}–${bulkClose} on ${selDays.size} day${selDays.size === 1 ? "" : "s"} — Save changes to confirm.`);
  }
  function setSelectedClosed() {
    if (selDays.size === 0) return;
    setDraft((d) =>
      d ? mapSelectedHours(d, (h) => (selDays.has(h.dayOfWeek) ? { ...h, isClosed: true } : h)) : d,
    );
    // Days just set off/closed shouldn't stay selected for the next bulk apply.
    setSelDays(new Set());
  }

  // ── Provider management (immediate persist) ──────────────────────────────
  async function withToken<T>(fn: (token: string) => Promise<T>): Promise<T | undefined> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      toast.error("Not signed in.");
      return undefined;
    }
    return fn(token);
  }
  /** Patch a provider row + seeded hours into BOTH draft and server (keeps dirty honest). */
  function syncProviderAdd(provider: ProviderRow, hours: SchedulingHoursDraft[]) {
    const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
      ...b,
      providers: [...b.providers, provider],
      hoursByProvider: { ...b.hoursByProvider, [provider.id]: hours },
    });
    applyToBoth(merge);
  }
  function syncProviderUpdate(provider: ProviderRow) {
    const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
      ...b,
      providers: b.providers.map((p) => (p.id === provider.id ? provider : p)),
    });
    applyToBoth(merge);
  }
  async function onAddProvider() {
    const name = newProviderName.trim();
    if (!name) return;
    setProviderBusy(true);
    try {
      const res = await withToken((token) =>
        createProviderFn({ data: { accessToken: token, viewAsUserId, name } }),
      );
      if (!res) return;
      syncProviderAdd(res.provider, res.hours);
      setSelProviderId(res.provider.id);
      setNewProviderName("");
      setAddingProvider(false);
      toast.success(`Added ${res.provider.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add provider.");
    } finally {
      setProviderBusy(false);
    }
  }
  async function commitRename(p: ProviderRow) {
    const next = (nameDrafts[p.id] ?? p.name).trim();
    setNameDrafts((m) => {
      const n = { ...m };
      delete n[p.id];
      return n;
    });
    if (!next || next === p.name) return;
    try {
      const res = await withToken((token) =>
        updateProviderFn({ data: { accessToken: token, viewAsUserId, providerId: p.id, name: next } }),
      );
      if (!res) return;
      syncProviderUpdate(res.provider);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename provider.");
    }
  }
  async function onToggleProviderActive(p: ProviderRow) {
    try {
      const res = await withToken((token) =>
        updateProviderFn({
          data: { accessToken: token, viewAsUserId, providerId: p.id, isActive: !p.isActive },
        }),
      );
      if (!res) return;
      syncProviderUpdate(res.provider);
      // If we just deactivated the selected provider, jump to another active one.
      if (!res.provider.isActive && selProviderId === p.id) {
        const nextActive = draft?.providers.find((x) => x.isActive && x.id !== p.id);
        if (nextActive) setSelProviderId(nextActive.id);
      }
      toast.success(`${res.provider.name} ${res.provider.isActive ? "activated" : "deactivated"}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update provider.");
    }
  }

  // ── Provider → services assignment (opt-out model, immediate persist) ────
  /** Does this provider perform this service? (bookable AND not opted out) */
  function performsService(providerId: string, serviceId: string): boolean {
    const svc = draft?.services.find((s) => s.id === serviceId);
    if (!svc?.onlineBookable) return false;
    const row = draft?.providerServices.find(
      (r) => r.providerId === providerId && r.serviceId === serviceId,
    );
    return row ? row.offered : true; // opt-out: no row = performs
  }
  /** Apply assignment results (bookable flips + rewritten rows) to draft + server. */
  function mergeAssignments(results: ServiceAssignmentResult[]) {
    if (!results.length) return;
    const bookableById = new Map(results.map((r) => [r.serviceId, r.onlineBookable]));
    const touched = new Set(results.map((r) => r.serviceId));
    const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
      ...b,
      services: b.services.map((s) =>
        bookableById.has(s.id) ? { ...s, onlineBookable: bookableById.get(s.id)! } : s,
      ),
      providerServices: [
        ...b.providerServices.filter((r) => !touched.has(r.serviceId)),
        ...results.flatMap((r) => r.rows),
      ],
    });
    applyToBoth(merge);
  }
  async function togglePerforms(providerId: string, serviceId: string, next: boolean) {
    try {
      const res = await withToken((token) =>
        assignProviderServiceFn({ data: { accessToken: token, viewAsUserId, providerId, serviceId, performs: next } }),
      );
      if (!res) return;
      mergeAssignments([res]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update.");
    }
  }
  async function toggleCategoryPerforms(providerId: string, serviceIds: string[], next: boolean) {
    if (!serviceIds.length) return;
    try {
      const res = await withToken((token) =>
        assignProviderServicesBulkFn({ data: { accessToken: token, viewAsUserId, providerId, serviceIds, performs: next } }),
      );
      if (!res) return;
      mergeAssignments(res.services);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update category.");
    }
  }

  // ── Per-provider service overrides (immediate persist) ───────────────────
  function overrideFor(providerId: string, serviceId: string): ProviderServiceOverrideRow | null {
    return (
      draft?.providerServices.find((r) => r.providerId === providerId && r.serviceId === serviceId) ??
      null
    );
  }
  /** Replace (or remove) a single override row in BOTH draft and server. */
  function syncOverride(
    providerId: string,
    serviceId: string,
    row: ProviderServiceOverrideRow | null,
  ) {
    const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
      ...b,
      providerServices: [
        ...b.providerServices.filter(
          (r) => !(r.providerId === providerId && r.serviceId === serviceId),
        ),
        ...(row ? [row] : []),
      ],
    });
    applyToBoth(merge);
  }
  function psFieldValue(providerId: string, serviceId: string, field: "durationMin" | "price"): string {
    const key = `${providerId}|${serviceId}|${field}`;
    if (psDrafts[key] !== undefined) return psDrafts[key];
    const ov = overrideFor(providerId, serviceId);
    const v = ov?.[field] ?? null;
    return v === null ? "" : String(v);
  }
  /** Does this provider offer this service? (no row OR offered=true) */
  function offersService(providerId: string, serviceId: string): boolean {
    const ov = overrideFor(providerId, serviceId);
    return ov ? ov.offered : true;
  }
  /** Persist a provider×service row from the full desired state (delete when
   *  pure default: offered + no overrides). */
  async function persistPS(
    providerId: string,
    serviceId: string,
    next: { offered: boolean; durationMin: number | null; bufferMin: number | null; price: number | null },
  ) {
    try {
      const res = await withToken((token) =>
        setProviderServiceOverrideFn({
          data: { accessToken: token, viewAsUserId, providerId, serviceId, ...next },
        }),
      );
      if (res === undefined) return;
      syncOverride(providerId, serviceId, res.row);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  }
  async function commitOverride(
    providerId: string,
    serviceId: string,
    field: "durationMin" | "price",
    raw: string,
  ) {
    const key = `${providerId}|${serviceId}|${field}`;
    setPsDrafts((m) => {
      const n = { ...m };
      delete n[key];
      return n;
    });
    const cur = overrideFor(providerId, serviceId);
    const base = {
      offered: cur?.offered ?? true,
      durationMin: cur?.durationMin ?? null,
      bufferMin: cur?.bufferMin ?? null,
      price: cur?.price ?? null,
    };
    const t = raw.trim();
    let parsed: number | null;
    if (t === "") parsed = null;
    else if (field === "durationMin") parsed = clampInt(t, 1, 1440);
    else parsed = Math.max(0, Math.min(1_000_000, Math.round((parseFloat(t) || 0) * 100) / 100));
    if (parsed === base[field]) return; // no change
    await persistPS(providerId, serviceId, { ...base, [field]: parsed });
  }
  async function toggleOffered(providerId: string, serviceId: string, nextOffered: boolean) {
    const cur = overrideFor(providerId, serviceId);
    await persistPS(providerId, serviceId, {
      offered: nextOffered,
      durationMin: cur?.durationMin ?? null,
      bufferMin: cur?.bufferMin ?? null,
      price: cur?.price ?? null,
    });
  }

  // ── Rooms / resources management (immediate persist) ─────────────────────
  function syncResourceAdd(resource: ResourceRow) {
    const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
      ...b,
      resources: [...b.resources, resource],
    });
    applyToBoth(merge);
  }
  function syncResourceUpdate(resource: ResourceRow) {
    const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
      ...b,
      resources: b.resources.map((r) => (r.id === resource.id ? resource : r)),
    });
    applyToBoth(merge);
  }
  async function onAddResource() {
    const name = newResourceName.trim();
    if (!name) return;
    setResourceBusy(true);
    try {
      const res = await withToken((token) =>
        createResourceFn({ data: { accessToken: token, viewAsUserId, name, type: newResourceType } }),
      );
      if (!res) return;
      syncResourceAdd(res.resource);
      setNewResourceName("");
      setNewResourceType("room");
      setAddingResource(false);
      toast.success(`Added ${res.resource.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add resource.");
    } finally {
      setResourceBusy(false);
    }
  }
  async function commitResourceRename(r: ResourceRow) {
    const next = (resourceNameDrafts[r.id] ?? r.name).trim();
    setResourceNameDrafts((m) => {
      const n = { ...m };
      delete n[r.id];
      return n;
    });
    if (!next || next === r.name) return;
    try {
      const res = await withToken((token) =>
        updateResourceFn({ data: { accessToken: token, viewAsUserId, resourceId: r.id, name: next } }),
      );
      if (!res) return;
      syncResourceUpdate(res.resource);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename resource.");
    }
  }
  async function updateResource(r: ResourceRow, patch: { type?: ResourceType; isActive?: boolean }) {
    try {
      const res = await withToken((token) =>
        updateResourceFn({ data: { accessToken: token, viewAsUserId, resourceId: r.id, ...patch } }),
      );
      if (!res) return;
      syncResourceUpdate(res.resource);
      if (patch.isActive !== undefined) {
        toast.success(`${res.resource.name} ${res.resource.isActive ? "activated" : "deactivated"}.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update resource.");
    }
  }

  // ── Date-specific availability overrides (immediate persist) ──────────────
  /** Inclusive list of YYYY-MM-DD between start and end (UTC, no tz drift). */
  function enumerateDates(start: string, end: string): string[] {
    const out: string[] = [];
    const s = new Date(`${start}T00:00:00Z`);
    const e = new Date(`${end}T00:00:00Z`);
    for (let d = s; d <= e && out.length < 366; d = new Date(d.getTime() + 86_400_000)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }
  /** Add/replace a whole-day override for the selected provider on a single date,
   *  or — when range mode is on — across every date from ovDate through ovEndDate
   *  (expanded into one single-date override per day, so the slot engine, the list,
   *  and per-date delete all work unchanged; no schema for ranges needed). */
  async function onAddDateOverride() {
    if (!selProviderId || !ovDate) return;
    if (!ovClosed && ovOpen >= ovClose) {
      toast.error("Open time must be before close time.");
      return;
    }
    const endDate = ovRange && ovEndDate ? ovEndDate : ovDate;
    if (endDate < ovDate) {
      toast.error("End date must be on or after the start date.");
      return;
    }
    const dates = enumerateDates(ovDate, endDate);
    if (dates.length === 0) return;
    setOvBusy(true);
    try {
      const overrides: DateOverrideDraft[] = [];
      for (const date of dates) {
        const res = await withToken((token) =>
          upsertDateOverrideFn({
            data: {
              accessToken: token,
              viewAsUserId,
              providerId: selProviderId,
              date,
              isClosed: ovClosed,
              openTime: ovClosed ? null : ovOpen,
              closeTime: ovClosed ? null : ovClose,
            },
          }),
        );
        if (res) overrides.push(res.override);
      }
      if (overrides.length === 0) return;
      const savedDates = new Set(overrides.map((o) => o.date));
      const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => {
        const existing = (b.dateOverridesByProvider[selProviderId] ?? []).filter(
          (o) => !savedDates.has(o.date),
        );
        const next = [...existing, ...overrides].sort((a, c) => a.date.localeCompare(c.date));
        return {
          ...b,
          dateOverridesByProvider: { ...b.dateOverridesByProvider, [selProviderId]: next },
        };
      };
      applyToBoth(merge);
      setOvDate("");
      setOvEndDate("");
      setOvRange(false);
      setOvClosed(false);
      setAddingOverride(false);
      toast.success(
        overrides.length === 1 ? "Date override saved." : `Saved override for ${overrides.length} dates.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save override.");
    } finally {
      setOvBusy(false);
    }
  }
  async function onRemoveDateOverride(providerId: string, overrideId: string) {
    try {
      const res = await withToken((token) =>
        deleteDateOverrideFn({ data: { accessToken: token, viewAsUserId, overrideId } }),
      );
      if (!res) return;
      applyToBoth((b) => ({
        ...b,
        dateOverridesByProvider: {
          ...b.dateOverridesByProvider,
          [providerId]: (b.dateOverridesByProvider[providerId] ?? []).filter(
            (o) => o.id !== overrideId,
          ),
        },
      }));
      toast.success("Override removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove override.");
    }
  }

  /** Drag-to-reorder a service within its category (drop onto another row in the
   *  same category). Cross-category moves still use the header drop. Immediate
   *  persist of the whole category's new order. */
  async function onReorderService(draggedId: string, targetId: string) {
    if (!draft || draggedId === targetId) return;
    const dragged = draft.services.find((s) => s.id === draggedId);
    const target = draft.services.find((s) => s.id === targetId);
    if (!dragged || !target) return;
    const cat = svcCat(target);
    if (svcCat(dragged) !== cat) return; // different category → use the header drop
    const ids = draft.services
      .filter((s) => svcCat(s) === cat)
      .sort(
        (a, b) =>
          (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.name.localeCompare(b.name),
      )
      .map((s) => s.id)
      .filter((id) => id !== draggedId);
    const tIdx = ids.indexOf(targetId);
    ids.splice(tIdx < 0 ? ids.length : tIdx, 0, draggedId);
    const pos = new Map(ids.map((id, i) => [id, i]));
    applyToBoth((b) => ({
      ...b,
      services: b.services.map((s) => (pos.has(s.id) ? { ...s, sortOrder: pos.get(s.id)! } : s)),
    }));
    try {
      await withToken((token) =>
        reorderServicesFn({ data: { accessToken: token, viewAsUserId, orderedIds: ids } }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the new order.");
    }
  }

  /** Drag-to-reorder categories (drop one category header onto another).
   *  Persists the full ordered list of in-use categories. */
  async function onReorderCategory(draggedCat: string, targetCat: string) {
    if (!draft || draggedCat === targetCat) return;
    const cats = [...new Set(draft.services.map((s) => svcCat(s)))]
      .sort(
        (a, b) =>
          orderedCategoryRank(a, categoryOrder) - orderedCategoryRank(b, categoryOrder) ||
          a.localeCompare(b),
      )
      .filter((c) => c !== draggedCat);
    const tIdx = cats.indexOf(targetCat);
    cats.splice(tIdx < 0 ? cats.length : tIdx, 0, draggedCat);
    applyToBoth((b) => ({ ...b, categoryOrder: cats }));
    try {
      await withToken((token) =>
        reorderCategoriesFn({ data: { accessToken: token, viewAsUserId, order: cats } }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save category order.");
    }
  }

  function patchService(id: string, patch: Partial<BookableServiceDraft>) {
    setDraft((d) =>
      d ? { ...d, services: d.services.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : d,
    );
  }
  // Rename a category across every service in it (immediate persist — bulk
  // server update — then patch draft + server so the list reflects it without
  // a reload). Mirrors instantly into the Catalog (both read services.category).
  async function commitCategoryRename(oldCat: string) {
    const to = normalizeCategory(renameText);
    setRenamingCat(null);
    if (!to || normalizeCategory(oldCat) === to) return;
    try {
      const res = await withToken((token) =>
        renameServiceCategoryFn({ data: { accessToken: token, viewAsUserId, from: oldCat, to } }),
      );
      if (!res) return;
      const apply = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
        ...b,
        services: b.services.map((s) => (s.category === oldCat ? { ...s, category: res.to } : s)),
      });
      applyToBoth(apply);
      setCollapsedSvcCats((p) => {
        if (!p.has(oldCat)) return p;
        const n = new Set(p);
        n.delete(oldCat);
        n.add(res.to);
        return n;
      });
      toast.success(
        `Category renamed to “${categoryLabel(res.to)}”${
          res.renamed ? ` · ${res.renamed} service${res.renamed === 1 ? "" : "s"}` : ""
        }.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename category.");
    }
  }
  // Create a new (empty) category. It has no row of its own — it lives once a
  // service uses it — so we just register it as a pending empty group the user
  // can drag existing services into. No-ops on a name that already exists.
  function onAddCategory() {
    const norm = normalizeCategory(newCatName);
    setNewCatName("");
    setAddingCat(false);
    if (!norm) return;
    const exists = (draft?.services ?? []).some((s) => svcCat(s) === norm) || pendingCats.includes(norm);
    if (exists) {
      // Already a category — just make sure it's expanded/visible.
      setCollapsedSvcCats((p) => {
        if (!p.has(norm)) return p;
        const n = new Set(p);
        n.delete(norm);
        return n;
      });
      toast.info(`“${categoryLabel(norm)}” already exists.`);
      return;
    }
    setPendingCats((p) => [...p, norm]);
    toast.success(`Category “${categoryLabel(norm)}” added — drag services into it.`);
  }
  // Create / delete services (immediate persist — separate from the batched Save).
  async function onAddService() {
    if (svcBusy) return; // guard double-fire (Enter key + click, or rapid double-Enter)
    const name = newSvcName.trim();
    if (!name) return;
    const price = Math.max(0, Math.round((parseFloat(newSvcPrice) || 0) * 100) / 100);
    setSvcBusy(true);
    try {
      const res = await withToken((token) =>
        createBookableServiceFn({
          data: { accessToken: token, viewAsUserId, name, category: newSvcCategory, price },
        }),
      );
      if (!res) return;
      // Upsert by id: when the server reused an existing catalog service (dedup),
      // that row is already in b.services — replace it in place rather than
      // appending a duplicate to local state.
      const add = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
        ...b,
        services: b.services.some((x) => x.id === res.service.id)
          ? b.services.map((x) => (x.id === res.service.id ? res.service : x))
          : [...b.services, res.service],
      });
      applyToBoth(add);
      setNewSvcName("");
      setNewSvcPrice("");
      setNewSvcCategory("other");
      setAddingSvc(false);
      toast.success(
        res.reused ? `“${res.service.name}” was already in your catalog — made it bookable.` : `Added ${res.service.name}.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add service.");
    } finally {
      setSvcBusy(false);
    }
  }
  async function onDeleteService(s: BookableServiceDraft) {
    if (typeof window !== "undefined" && !window.confirm(`Delete "${s.name}"? This can't be undone.`)) {
      return;
    }
    try {
      const res = await withToken((token) =>
        deleteBookableServiceFn({ data: { accessToken: token, viewAsUserId, serviceId: s.id } }),
      );
      if (!res) return;
      const remove = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
        ...b,
        services: b.services.filter((x) => x.id !== s.id),
        providerServices: b.providerServices.filter((r) => r.serviceId !== s.id),
      });
      applyToBoth(remove);
      if (expandedSvc === s.id) setExpandedSvc(null);
      toast.success(`Deleted ${s.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete service.");
    }
  }

  async function onSave() {
    if (!draft || !dirty) return;
    setSaving(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const flatHours = Object.entries(draft.hoursByProvider).flatMap(([providerId, rows]) =>
        rows.map((h) => ({
          providerId,
          dayOfWeek: h.dayOfWeek,
          openTime: h.openTime,
          closeTime: h.closeTime,
          isClosed: h.isClosed,
        })),
      );
      await saveSchedulingSetupFn({
        data: {
          accessToken: token,
          viewAsUserId,
          settings: draft.settings,
          hours: flatHours,
          services: draft.services.map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            price: s.price,
            durationMin: s.durationMin,
            bufferMin: s.bufferMin,
            onlineBookable: s.onlineBookable,
            requiredResourceType: s.requiredResourceType,
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
  // ── Surface everything the page render consumes ──
  return {
    loading, setLoading, saving, setSaving, server, setServer, draft, setDraft,
    selDays, setSelDays, bulkOpen, setBulkOpen, bulkClose, setBulkClose,
    selProviderId, setSelProviderId,
    addingProvider, setAddingProvider, newProviderName, setNewProviderName, providerBusy, setProviderBusy,
    nameDrafts, setNameDrafts, expandedProvider, setExpandedProvider, providerSearch, setProviderSearch,
    expandedCats, setExpandedCats, svcSearch, setSvcSearch, showInactive, setShowInactive,
    collapsedSvcCats, setCollapsedSvcCats, renamingCat, setRenamingCat, renameText, setRenameText,
    addingSvc, setAddingSvc, newSvcName, setNewSvcName, newSvcCategory, setNewSvcCategory,
    newSvcPrice, setNewSvcPrice, svcBusy, setSvcBusy, expandedSvc, setExpandedSvc,
    addingCat, setAddingCat, newCatName, setNewCatName,
    pendingCats, setPendingCats, emptyPendingCats, onAddCategory,
    psDrafts, setPsDrafts, durFmt, setDurFmt,
    addingResource, setAddingResource, newResourceName, setNewResourceName,
    newResourceType, setNewResourceType, resourceBusy, setResourceBusy,
    resourceNameDrafts, setResourceNameDrafts,
    addingOverride, setAddingOverride, ovDate, setOvDate, ovClosed, setOvClosed,
    ovRange, setOvRange, ovEndDate, setOvEndDate,
    ovOpen, setOvOpen, ovClose, setOvClose, ovBusy,
    selDateOverrides, onAddDateOverride, onRemoveDateOverride,
    draggedSvcRef, draggedCatRef, categoryOrder, onReorderCategory, startAutoScroll, stopAutoScroll,
    dirty, activeProviders, activeResourceTypes, selHours, selProviderName,
    svcQuery, inactiveCount, visibleServices, svcCat, sortedVisible, svcCatCounts, categoryOptions,
    allCatsCollapsed, toggleAllCats, visibleByCat, setCategoryBookable,
    setDurationFormat, patchSettings, applyToBoth, mapSelectedHours, patchDay, toggleSelDay,
    applyHoursToSelected, setSelectedClosed, withToken,
    syncProviderAdd, syncProviderUpdate, onAddProvider, commitRename, onToggleProviderActive,
    performsService, mergeAssignments, togglePerforms, toggleCategoryPerforms,
    overrideFor, syncOverride, psFieldValue, offersService, persistPS, commitOverride, toggleOffered,
    syncResourceAdd, syncResourceUpdate, onAddResource, commitResourceRename, updateResource,
    patchService, commitCategoryRename, onAddService, onDeleteService, onReorderService, onSave,
    settingsDirty, hoursDirty, servicesDirty, onDiscard,
  };
}

/** Everything the booking-settings page (and its section components) consume. */
export type BookingSettings = ReturnType<typeof useBookingSettings>;
