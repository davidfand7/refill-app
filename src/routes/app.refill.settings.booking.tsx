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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  DoorOpen,
  ExternalLink,
  Globe,
  GripVertical,
  Link2,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  assignProviderServiceFn,
  assignProviderServicesBulkFn,
  createBookableServiceFn,
  createProviderFn,
  createResourceFn,
  deleteBookableServiceFn,
  getSchedulingSetupFn,
  saveSchedulingSetupFn,
  setProviderServiceOverrideFn,
  updateProviderFn,
  updateResourceFn,
  type BookableServiceDraft,
  type ServiceAssignmentResult,
  type ProviderRow,
  type ProviderServiceOverrideRow,
  type ResourceRow,
  type ResourceType,
  type ServiceCategory,
  SERVICE_CATEGORIES,
  type SchedulingHoursDraft,
  type SchedulingSettingsDraft,
  type SchedulingSetupBundle,
} from "@/server/scheduling-settings.functions";
import { cn } from "@/lib/utils";
import { TimeSelect } from "@/components/refill/TimeSelect";

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
  const draggedSvcRef = useRef<string | null>(null);
  // Auto-scroll the window while dragging near the top/bottom edge (HTML5 DnD
  // doesn't scroll on its own — needed to drag a service up to a far category).
  const autoScroll = useRef<{ vy: number; raf: number; on: boolean; off?: () => void }>({
    vy: 0,
    raf: 0,
    on: false,
  });
  function startAutoScroll() {
    const st = autoScroll.current;
    if (st.on) return;
    st.on = true;
    const onOver = (e: DragEvent) => {
      const EDGE = 100;
      const h = window.innerHeight;
      const y = e.clientY;
      st.vy = y < EDGE ? -Math.ceil((EDGE - y) / 4) : y > h - EDGE ? Math.ceil((y - (h - EDGE)) / 4) : 0;
    };
    window.addEventListener("dragover", onOver);
    st.off = () => window.removeEventListener("dragover", onOver);
    const tick = () => {
      if (!st.on) return;
      if (st.vy) window.scrollBy(0, st.vy);
      st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
  }
  function stopAutoScroll() {
    const st = autoScroll.current;
    st.on = false;
    st.vy = 0;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.off?.();
  }
  // Add-service form.
  const [addingSvc, setAddingSvc] = useState(false);
  const [newSvcName, setNewSvcName] = useState("");
  const [newSvcCategory, setNewSvcCategory] = useState<ServiceCategory>("other");
  const [newSvcPrice, setNewSvcPrice] = useState("");
  const [svcBusy, setSvcBusy] = useState(false);
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
  }, [membership.status, viewAsUserId]);

  const dirty = useMemo(
    () => !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server),
    [draft, server],
  );

  const activeProviders = useMemo(() => draft?.providers.filter((p) => p.isActive) ?? [], [draft]);
  // Distinct active resource types (room/chair/device) a service can require.
  const activeResourceTypes = useMemo(() => {
    const order: ResourceType[] = ["room", "chair", "device"];
    const present = new Set((draft?.resources ?? []).filter((r) => r.isActive).map((r) => r.type));
    return order.filter((t) => present.has(t));
  }, [draft]);
  const selHours = draft?.hoursByProvider[selProviderId] ?? [];
  const selProviderName = draft?.providers.find((p) => p.id === selProviderId)?.name ?? "";

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
  const catRank = (c: string) => {
    const i = (SERVICE_CATEGORIES as readonly string[]).indexOf(c);
    return i < 0 ? SERVICE_CATEGORIES.length : i;
  };
  const sortedVisible = [...visibleServices].sort(
    (a, b) =>
      catRank(svcCat(a)) - catRank(svcCat(b)) ||
      svcCat(a).localeCompare(svcCat(b)) ||
      a.name.localeCompare(b.name),
  );
  const svcCatCounts = new Map<string, number>();
  for (const s of visibleServices) svcCatCounts.set(svcCat(s), (svcCatCounts.get(svcCat(s)) ?? 0) + 1);

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
    toast.success(`Applied ${bulkOpen}–${bulkClose} to ${selDays.size} day${selDays.size === 1 ? "" : "s"}.`);
  }
  function setSelectedClosed() {
    if (selDays.size === 0) return;
    setDraft((d) =>
      d ? mapSelectedHours(d, (h) => (selDays.has(h.dayOfWeek) ? { ...h, isClosed: true } : h)) : d,
    );
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
    setServer((s) => (s ? merge(s) : s));
    setDraft((d) => (d ? merge(d) : d));
  }
  function syncProviderUpdate(provider: ProviderRow) {
    const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
      ...b,
      providers: b.providers.map((p) => (p.id === provider.id ? provider : p)),
    });
    setServer((s) => (s ? merge(s) : s));
    setDraft((d) => (d ? merge(d) : d));
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
    setServer((s) => (s ? merge(s) : s));
    setDraft((d) => (d ? merge(d) : d));
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
    setServer((s) => (s ? merge(s) : s));
    setDraft((d) => (d ? merge(d) : d));
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
    setServer((s) => (s ? merge(s) : s));
    setDraft((d) => (d ? merge(d) : d));
  }
  function syncResourceUpdate(resource: ResourceRow) {
    const merge = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
      ...b,
      resources: b.resources.map((r) => (r.id === resource.id ? resource : r)),
    });
    setServer((s) => (s ? merge(s) : s));
    setDraft((d) => (d ? merge(d) : d));
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
  function patchService(id: string, patch: Partial<BookableServiceDraft>) {
    setDraft((d) =>
      d ? { ...d, services: d.services.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : d,
    );
  }
  // Create / delete services (immediate persist — separate from the batched Save).
  async function onAddService() {
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
      const add = (b: SchedulingSetupBundle): SchedulingSetupBundle => ({
        ...b,
        services: [...b.services, res.service],
      });
      setServer((s) => (s ? add(s) : s));
      setDraft((d) => (d ? add(d) : d));
      setNewSvcName("");
      setNewSvcPrice("");
      setNewSvcCategory("other");
      setAddingSvc(false);
      toast.success(`Added ${res.service.name}.`);
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
      setServer((b) => (b ? remove(b) : b));
      setDraft((b) => (b ? remove(b) : b));
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
            category: (SERVICE_CATEGORIES.includes(s.category as ServiceCategory)
              ? s.category
              : "other") as ServiceCategory,
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
                          const cat = s.category?.trim() || "Other";
                          (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push(s);
                        }
                        const cats = Array.from(byCat.keys()).sort((a, b) => a.localeCompare(b));
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
                                          {cat}
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
            <section className="rounded-xl border border-rule bg-white px-5 py-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-emerald" />
                  <h3 className="text-[14px] font-semibold text-ink">Business hours</h3>
                </div>
                {activeProviders.length > 1 && (
                  <select
                    value={selProviderId}
                    onChange={(e) => setSelProviderId(e.target.value)}
                    className="rounded-md border border-rule bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                  >
                    {activeProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {activeProviders.length > 1 && (
                <p className="text-[12px] text-ink-soft mb-3 -mt-1">
                  Editing hours for <strong>{selProviderName}</strong>. Each provider has their own
                  week.
                </p>
              )}

              {/* Bulk edit: select days → apply hours */}
              <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-rule/60 text-[12px]">
                <span className="text-ink-soft">Select:</span>
                <button type="button" onClick={() => setSelDays(new Set([1, 2, 3, 4, 5]))} className="rounded border border-rule px-2 py-1 text-ink-soft hover:text-ink hover:border-emerald/40 transition">Weekdays</button>
                <button type="button" onClick={() => setSelDays(new Set([0, 1, 2, 3, 4, 5, 6]))} className="rounded border border-rule px-2 py-1 text-ink-soft hover:text-ink hover:border-emerald/40 transition">All</button>
                {selDays.size > 0 && (
                  <button type="button" onClick={() => setSelDays(new Set())} className="rounded border border-rule px-2 py-1 text-ink-soft hover:text-ink hover:border-emerald/40 transition">Clear</button>
                )}
                {selDays.size > 0 && (
                  <span className="ml-auto flex items-center gap-1.5">
                    <span className="text-emerald font-medium mr-1">{selDays.size} day{selDays.size === 1 ? "" : "s"} →</span>
                    <TimeSelect value={bulkOpen} onChange={setBulkOpen} className="rounded-md border border-rule bg-white px-2 py-1 text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums" />
                    <TimeSelect value={bulkClose} onChange={setBulkClose} className="rounded-md border border-rule bg-white px-2 py-1 text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums" />
                    <button type="button" onClick={applyHoursToSelected} className="rounded-md bg-emerald px-2.5 py-1 font-medium text-paper hover:opacity-95 transition">Apply</button>
                    <button type="button" onClick={setSelectedClosed} className="rounded-md border border-rule px-2.5 py-1 text-ink-soft hover:text-ink transition">Set closed</button>
                  </span>
                )}
              </div>

              <div className="space-y-1.5">
                {DAY_ORDER.map((dow) => {
                  const h = selHours.find((x) => x.dayOfWeek === dow);
                  if (!h) return null;
                  return (
                    <div
                      key={dow}
                      className={cn(
                        "grid grid-cols-[110px_1fr] sm:grid-cols-[150px_auto_auto_1fr] items-center gap-2 py-1.5 px-1 rounded-md",
                        selDays.has(dow) && "bg-emerald-soft/20",
                      )}
                    >
                      <label className="flex items-center gap-2 text-[13px] font-medium text-ink cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selDays.has(dow)}
                          onChange={() => toggleSelDay(dow)}
                          className="h-3.5 w-3.5 rounded border-rule accent-emerald"
                        />
                        {DAY_LABELS[dow]}
                      </label>
                      {h.isClosed ? (
                        <span className="text-[13px] text-ink-faint sm:col-span-2">Closed</span>
                      ) : (
                        <>
                          <TimeSelect
                            value={h.openTime}
                            onChange={(v) => patchDay(dow, { openTime: v })}
                            className="rounded-md border border-rule bg-white px-2 py-1.5 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                          />
                          <TimeSelect
                            value={h.closeTime}
                            onChange={(v) => patchDay(dow, { closeTime: v })}
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

                {/* Smart-option default — which leads when prices vary by provider. */}
                <div className="sm:col-span-2 pt-1 border-t border-rule/60">
                  <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block mt-3">
                    When prices vary by provider, lead with
                  </label>
                  <div className="inline-flex rounded-md border border-rule overflow-hidden">
                    {(["best_deal", "first_available"] as const).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => patchSettings({ bookingLeadOption: opt })}
                        className={cn(
                          "px-3 py-1.5 text-[13px] font-medium transition",
                          draft.settings.bookingLeadOption === opt
                            ? "bg-emerald text-paper"
                            : "text-ink-soft hover:text-ink",
                        )}
                      >
                        {opt === "best_deal" ? "Best deal" : "First available"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">
                    Patients always see both. This picks which appears first — and only matters for
                    services you price differently per provider.
                  </p>
                </div>
              </div>
            </section>

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
                            <span className="text-[12px] font-semibold text-ink capitalize">{cat}</span>
                            <span className="text-[11px] text-ink-faint tabular-nums">
                              {svcCatCounts.get(cat) ?? 0}
                            </span>
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
                                <select
                                  value={SERVICE_CATEGORIES.includes(s.category as ServiceCategory) ? s.category : "other"}
                                  onChange={(e) => patchService(s.id, { category: e.target.value })}
                                  className="w-full rounded-md border border-rule bg-white px-1.5 py-1 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 capitalize"
                                >
                                  {SERVICE_CATEGORIES.map((c) => (
                                    <option key={c} value={c} className="capitalize">
                                      {c}
                                    </option>
                                  ))}
                                </select>
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
                    <select
                      value={newSvcCategory}
                      onChange={(e) => setNewSvcCategory(e.target.value as ServiceCategory)}
                      className="rounded-md border border-rule bg-white px-2 py-2 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 capitalize"
                    >
                      {SERVICE_CATEGORIES.map((c) => (
                        <option key={c} value={c} className="capitalize">
                          {c}
                        </option>
                      ))}
                    </select>
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

// ── Small field helpers ──────────────────────────────────────────────────────

function bookingUrl(slug: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://getrefill.app";
  return `${origin}/s/${slug}`;
}

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** Round to the nearest 5 minutes, clamped to [min, 1440]. */
function snap5(n: number, min: number): number {
  return Math.max(min, Math.min(1440, Math.round(n / 5) * 5));
}

const DUR_INPUT_CLS =
  "rounded-md border border-rule bg-white px-1.5 py-1 text-[13px] text-ink text-right outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums";

/** Buffer = cleanup minutes only (0–60 in 5-min steps), independent of the
 *  duration H:M / minutes display toggle. */
function BufferSelect({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const opts = Array.from({ length: 13 }, (_, i) => i * 5); // 0…60
  return (
    <div className="flex items-center justify-end gap-1">
      <select
        value={minutes}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className={cn(DUR_INPUT_CLS, "w-16 text-right")}
      >
        {!opts.includes(minutes) && <option value={minutes}>{minutes}</option>}
        {opts.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <span className="text-[11px] text-ink-faint">m</span>
    </div>
  );
}

/**
 * Duration / buffer editor in 5-minute steps. Always stores minutes; renders as
 * "1 h 30 m" (format "hm") or "90 min" (format "min").
 */
function DurationField({
  minutes,
  min,
  format,
  onChange,
}: {
  minutes: number;
  min: number; // 0 for buffer, 5 for duration
  format: "hm" | "min";
  onChange: (m: number) => void;
}) {
  if (format === "min") {
    return (
      <div className="flex items-center justify-end gap-1">
        <input
          type="number"
          min={min}
          max={1440}
          step={5}
          value={minutes}
          onChange={(e) => onChange(snap5(parseInt(e.target.value || "0", 10), min))}
          className={cn(DUR_INPUT_CLS, "w-16")}
        />
        <span className="text-[11px] text-ink-faint">min</span>
      </div>
    );
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return (
    <div className="flex items-center justify-end gap-1">
      <input
        type="number"
        min={0}
        max={24}
        value={h}
        onChange={(e) => onChange(snap5((clampInt(e.target.value, 0, 24)) * 60 + m, min))}
        className={cn(DUR_INPUT_CLS, "w-10")}
      />
      <span className="text-[11px] text-ink-faint">h</span>
      <select
        value={m}
        onChange={(e) => onChange(snap5(h * 60 + parseInt(e.target.value, 10), min))}
        className="rounded-md border border-rule bg-white px-1 py-1 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
      >
        {Array.from({ length: 12 }, (_, i) => i * 5).map((mm) => (
          <option key={mm} value={mm}>
            {String(mm).padStart(2, "0")}
          </option>
        ))}
      </select>
      <span className="text-[11px] text-ink-faint">m</span>
    </div>
  );
}

/** Checkbox with an indeterminate (some-selected) state. */
function TriCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="h-4 w-4 rounded border-rule accent-emerald shrink-0"
    />
  );
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
