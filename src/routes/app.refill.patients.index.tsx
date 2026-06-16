/**
 * /app/refill/patients — list view for Patient Architecture P1.
 *
 * Reads knowledge_nodes rows where node_type='patient' and context='patients'.
 * The summary attachments (firstVisit/lastVisit/totalVisits/lifetimeSpend/
 * primaryManufacturer/productMix/loyaltyEngagement) are materialized at
 * import time, so list rendering is a single non-joined query.
 *
 * Empty state → CTA to /app/refill/patients/import.
 * Has data → search + manufacturer chip filter + 12-month vs all-time toggle.
 *
 * Established 2026-05-15 (Patient Architecture P1).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  ArrowUpDown,
  Ban,
  CalendarClock,
  Check,
  Eye,
  EyeOff,
  Filter,
  Loader2,
  Mail,
  Phone,
  Search,
  Sparkles,
  Star,
  Tag,
  Upload,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import {
  bulkApplyPatientSoftTag,
  listCustomTagDefinitions,
  listOverduePatients,
  listPatients,
  setPatientHidden,
  setPatientVip,
  type OverduePatient,
  type PatientListRow,
} from "@/server/patient-ingest.functions";
import type { CustomTagDefinition, PatientSoftTags } from "@/lib/patient-csv";
import {
  listWaitlist,
  markPatientOptedIn,
  markPatientOptedOut,
  type WaitlistEntry,
} from "@/server/emma-waitlist.functions";
import {
  listPreshowProfiles,
  type PreshowProfile,
} from "@/server/refill-preshow-agent.functions";
import type { ProductManufacturer } from "@/lib/product-manufacturer-map";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";

const patientsSearchSchema = z.object({
  overdue: z.enum(["0", "1"]).optional(),
});

export const Route = createFileRoute("/app/refill/patients/")({
  component: PatientsPage,
  validateSearch: patientsSearchSchema,
});

type Window = "12mo" | "all";

// v385.1: patient list sort keys. Order matches the dropdown's visual
// order. Each maps to a comparator in the sorted useMemo below.
type SortKey = "lastVisit" | "name" | "visits" | "spend" | "firstVisit";

// v385.1: descending date comparator that sinks null/empty to the end.
// ISO date strings sort lexicographically the same way they sort
// chronologically, so direct string compare is correct here — no need
// to instantiate Date objects per row.
function dateDesc(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

const SORT_LABELS: Record<SortKey, string> = {
  lastVisit: "Last visit (newest)",
  name: "Name (A–Z)",
  visits: "Total visits (most)",
  spend: "Lifetime spend (highest)",
  firstVisit: "First visit (newest)",
};

// v1.34.1 (coherency pass): soft-tag filter + per-row indicators. Closes
// the asymmetry between v1.34.0 bulk-apply (Karen can tag 50 patients)
// and the list (couldn't see who was tagged, couldn't filter by tag).

// Display labels for seeded soft-tag values. The patient detail page has
// its own richer labels; this version is optimized for compact chip-style
// rendering in the list filter strip and per-row pill cluster.
const SEEDED_TAG_VALUE_LABELS: Record<string, Record<string, string>> = {
  incomeTier: {
    high: "High income",
    mid: "Mid income",
    low: "Low income",
    unknown: "Income unknown",
  },
  negotiator: {
    never: "Non-negotiator",
    occasional: "Occasional negotiator",
    always: "Always negotiates",
  },
  specialsSeeker: {
    true: "Specials seeker",
    false: "Not specials seeker",
  },
  personality: {
    easy: "Easy personality",
    neutral: "Neutral personality",
    complainer: "Complainer",
  },
  shopperLoyalty: {
    loyal: "Loyal",
    comparison: "Comparison shopper",
    unknown: "Loyalty unknown",
  },
};

/**
 * Enumerate the filter-keys a patient's softTags match. Each key is a
 * unique "filter chip" — when any of these keys is in the active filter
 * set, the patient passes the filter (union semantics).
 *
 * Keys:
 *   - Seeded:  "seeded:<tagKey>:<value>"           e.g. "seeded:shopperLoyalty:loyal"
 *   - Custom:  "custom:<definitionId>:<value>"     e.g. "custom:abc-123:Loyal"
 *
 * Cultural notes (free-text) intentionally excluded — doesn't fit
 * chip-filter semantics. Same call the bulk-picker made in v1.34.0.
 */
function patientTagFilterKeys(softTags: PatientSoftTags): string[] {
  const keys: string[] = [];
  if (softTags.incomeTier?.value)
    keys.push(`seeded:incomeTier:${softTags.incomeTier.value}`);
  if (softTags.negotiator?.value)
    keys.push(`seeded:negotiator:${softTags.negotiator.value}`);
  if (softTags.specialsSeeker?.value !== undefined && softTags.specialsSeeker !== null)
    keys.push(`seeded:specialsSeeker:${String(softTags.specialsSeeker.value)}`);
  if (softTags.personality?.value)
    keys.push(`seeded:personality:${softTags.personality.value}`);
  if (softTags.shopperLoyalty?.value)
    keys.push(`seeded:shopperLoyalty:${softTags.shopperLoyalty.value}`);
  if (softTags.customSelections) {
    for (const [defId, sel] of Object.entries(softTags.customSelections)) {
      for (const opt of sel.selected ?? []) {
        keys.push(`custom:${defId}:${opt}`);
      }
    }
  }
  return keys;
}

/** Resolve a filter-key to a chip display label. */
function tagFilterKeyLabel(
  key: string,
  customDefs: CustomTagDefinition[],
): string {
  const parts = key.split(":");
  if (parts[0] === "seeded") {
    const [, tagKey, value] = parts;
    return SEEDED_TAG_VALUE_LABELS[tagKey]?.[value] ?? value;
  }
  if (parts[0] === "custom") {
    const [, defId, value] = parts;
    const def = customDefs.find((d) => d.id === defId);
    return def ? `${def.name}: ${value}` : value;
  }
  return key;
}

function PatientsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [rows, setRows] = useState<PatientListRow[] | null>(null);
  const [overdueIndex, setOverdueIndex] = useState<Map<string, OverduePatient> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [manufacturerFilter, setManufacturerFilter] =
    useState<ProductManufacturer | null>(null);
  const [windowMode, setWindowMode] = useState<Window>("12mo");
  // v385: waitlist toggle per patient row. Indexed by patient_node_id so the
  // row component can read in O(1). null = not loaded yet; empty Map after
  // load = no one on waitlist yet. accessToken kept in a ref-shaped state
  // so toggle handlers don't have to re-fetch the session each click.
  const [waitlistIndex, setWaitlistIndex] = useState<Map<string, WaitlistEntry> | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [pendingToggleIds, setPendingToggleIds] = useState<Set<string>>(new Set());
  // v385.1: sort + waitlist filter controls.
  // sortKey defaults to "lastVisit" desc — the spa-owner mental model is
  // "who haven't I seen recently" or "who was here last." Alphabetical
  // is a secondary need, dropdown switches to it.
  const [sortKey, setSortKey] = useState<SortKey>("lastVisit");
  // waitlistFilter: "all" = unfiltered (default), "on" = currently on the
  // waitlist (status=active), "off" = NOT on (no row OR revoked).
  const [waitlistFilter, setWaitlistFilter] = useState<"all" | "on" | "off">("all");
  // v385.2: VIP filter chip strip. Same pattern as waitlist.
  const [vipFilter, setVipFilter] = useState<"all" | "on" | "off">("all");
  // v385.2: pending state for in-flight VIP toggles (separate from
  // waitlist's pending set so the two toggles don't interfere).
  const [pendingVipIds, setPendingVipIds] = useState<Set<string>>(new Set());
  // v1.34.0: bulk soft-tag apply — selection state + picker modal + tenant
  // custom tag defs loaded once for the picker (preset tags are hardcoded).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPickerOpen, setBulkPickerOpen] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [customDefs, setCustomDefs] = useState<CustomTagDefinition[]>([]);
  const [preshowProfiles, setPreshowProfiles] = useState<PreshowProfile[]>([]);
  // v1.34.9.3: show hidden patients (default false). Toggle pill in filter strip.
  const [showHidden, setShowHidden] = useState(false);
  // v1.34.1 (coherency pass): multi-select soft-tag filter. Each entry is
  // a filter-key from patientTagFilterKeys() — union semantics (patient
  // matches if their tag keys intersect the active filter set).
  const [softTagFilter, setSoftTagFilter] = useState<Set<string>>(new Set());
  const overdueOnly = search.overdue === "1";

  function setOverdueOnly(next: boolean) {
    void navigate({
      search: (prev) => ({ ...prev, overdue: next ? "1" : undefined }),
      replace: true,
    });
  }

  // v1.20: admin viewing-as plumbing. When the membership hook returns
  // viewAs="admin", carry the impersonated tenant-owner's user_id through
  // to every spa-owner server fn so they filter that tenant's rows
  // instead of the admin's empty set.
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  useEffect(() => {
    // Wait for membership resolution before firing the data fetch — we
    // need viewAsUserId for the admin-bypass case, and firing too early
    // would lock in the wrong user scope until a refresh.
    if (membership.status === "loading") return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) setError("Please sign in to see your patients.");
          return;
        }
        // Load patient summary + overdue index + waitlist roster in
        // parallel. overdue is a map keyed by patient id; waitlist is
        // a map keyed by patient_node_id so the row can read both in O(1).
        // v385: waitlist join is what powers the per-row waitlist toggle.
        const [list, overdue, waitlist, defs, profiles] = await Promise.all([
          listPatients({ data: { accessToken: token, viewAsUserId, includeHidden: showHidden } }),
          listOverduePatients({
            data: { accessToken: token, limit: 5000, viewAsUserId },
          }),
          listWaitlist({ data: { accessToken: token, viewAsUserId } }),
          // v1.34.0: tenant-wide custom tag defs for the bulk picker
          listCustomTagDefinitions({
            data: { accessToken: token, viewAsUserId },
          }),
          // v1.34.3.1: preshow profiles for the bulk picker's
          //   "Set preshow profile" section.
          listPreshowProfiles({
            data: { accessToken: token, viewAsUserId },
          }).catch(() => [] as PreshowProfile[]),
        ]);
        if (!cancelled) {
          setRows(list);
          setOverdueIndex(new Map(overdue.map((o) => [o.patientId, o])));
          setWaitlistIndex(new Map(waitlist.map((w) => [w.patientNodeId, w])));
          setAccessToken(token);
          setCustomDefs(defs);
          setPreshowProfiles(profiles);
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Couldn't load patients.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId, showHidden]);

  // v385: toggle a patient's waitlist membership. Optimistic UI — the
  // toggle flips immediately, the server fn fires in the background, and
  // on success the waitlistIndex is rewritten with the canonical row
  // returned by the server (with the real id + opted_in_at). On failure
  // we revert the optimistic flip and surface a console error.
  async function toggleWaitlist(patientNodeId: string, currentlyActive: boolean) {
    if (!accessToken) return;
    if (pendingToggleIds.has(patientNodeId)) return;
    setPendingToggleIds((prev) => new Set(prev).add(patientNodeId));
    try {
      if (currentlyActive) {
        await markPatientOptedOut({
          data: { accessToken, patientNodeId },
        });
        setWaitlistIndex((prev) => {
          if (!prev) return prev;
          const next = new Map(prev);
          const existing = next.get(patientNodeId);
          if (existing) {
            next.set(patientNodeId, {
              ...existing,
              status: "revoked",
              revokedAt: new Date().toISOString(),
            });
          }
          return next;
        });
      } else {
        await markPatientOptedIn({
          data: { accessToken, patientNodeId },
        });
        // markPatientOptedIn returns { ok: true } only — synthesize the
        // local row from what we set server-side (opt_in_source=spa-manual,
        // status=active) so the UI reflects the new state without a refetch.
        setWaitlistIndex((prev) => {
          if (!prev) return prev;
          const next = new Map(prev);
          const existing = next.get(patientNodeId);
          const now = new Date().toISOString();
          next.set(patientNodeId, {
            id: existing?.id ?? `pending-${patientNodeId}`,
            patientNodeId,
            patientName: existing?.patientName ?? null,
            patientPhone: existing?.patientPhone ?? null,
            patientEmail: existing?.patientEmail ?? null,
            treatmentTypes: existing?.treatmentTypes ?? [],
            preferredProviders: existing?.preferredProviders ?? [],
            status: "active",
            optInSource: "spa-manual",
            optedInAt: now,
            revokedAt: null,
            desiredServices: existing?.desiredServices ?? [],
          });
          return next;
        });
      }
    } catch (e) {
      console.error("Waitlist toggle failed:", e instanceof Error ? e.message : e);
    } finally {
      setPendingToggleIds((prev) => {
        const next = new Set(prev);
        next.delete(patientNodeId);
        return next;
      });
    }
  }

  // v385.2: toggle a patient's VIP / A-list flag. Optimistic UI — flip
  // the local row's vip immediately, fire the server fn in background,
  // revert + console-error on failure.
  async function toggleVip(patientNodeId: string, currentlyVip: boolean) {
    if (!accessToken) return;
    if (pendingVipIds.has(patientNodeId)) return;
    setPendingVipIds((prev) => new Set(prev).add(patientNodeId));
    // Optimistic local update.
    setRows((prev) =>
      prev
        ? prev.map((r) =>
            r.id === patientNodeId ? { ...r, vip: !currentlyVip } : r,
          )
        : prev,
    );
    try {
      await setPatientVip({
        data: { accessToken, patientNodeId, vip: !currentlyVip },
      });
    } catch (e) {
      // Revert on failure.
      setRows((prev) =>
        prev
          ? prev.map((r) =>
              r.id === patientNodeId ? { ...r, vip: currentlyVip } : r,
            )
          : prev,
      );
      console.error("VIP toggle failed:", e instanceof Error ? e.message : e);
    } finally {
      setPendingVipIds((prev) => {
        const next = new Set(prev);
        next.delete(patientNodeId);
        return next;
      });
    }
  }

  // v1.34.9.3: per-row hide toggle. Optimistic UI; on failure, revert.
  async function onToggleHidden(patientNodeId: string, currentlyHidden: boolean) {
    if (!accessToken) return;
    const next = !currentlyHidden;
    // Optimistic: if hiding + we're not showing hidden, drop the row;
    // otherwise just flip the flag so the visual treatment updates.
    setRows((prev) =>
      prev
        ? showHidden
          ? prev.map((r) => (r.id === patientNodeId ? { ...r, hidden: next } : r))
          : prev.filter((r) => r.id !== patientNodeId)
        : prev,
    );
    try {
      await setPatientHidden({
        data: { accessToken, viewAsUserId, patientNodeId, hidden: next },
      });
      toast.success(next ? "Patient hidden." : "Patient unhidden.");
    } catch (e) {
      // Reload on failure to get back to a consistent state.
      toast.error(e instanceof Error ? e.message : "Couldn't update.");
      const fresh = await listPatients({
        data: { accessToken, viewAsUserId, includeHidden: showHidden },
      });
      setRows(fresh);
    }
  }

  // v1.34.0: bulk soft-tag selection helpers.
  const toggleSelected = (patientNodeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(patientNodeId)) next.delete(patientNodeId);
      else next.add(patientNodeId);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  // v1.34.0: bulk apply handler — server fn + toast + clear selection.
  // Reuses tenant scoping via accessToken/viewAsUserId.
  async function bulkApply(
    tag:
      | {
          kind: "preset";
          key:
            | "incomeTier"
            | "negotiator"
            | "specialsSeeker"
            | "personality"
            | "shopperLoyalty"
            | "culturalNotes"
            | "preshowProfileId";
          value: string | boolean;
        }
      | { kind: "custom"; definitionId: string; selected: string[] },
    reason: string,
    tagDisplayLabel: string,
  ) {
    if (!accessToken) return;
    if (selectedIds.size === 0) return;
    setBulkApplying(true);
    try {
      const result = await bulkApplyPatientSoftTag({
        data: {
          accessToken,
          viewAsUserId,
          patientNodeIds: Array.from(selectedIds),
          tag,
          reason: reason.trim() || null,
        },
      });
      const total = result.touched + result.skipped;
      toast.success(
        result.skipped === 0
          ? `${tagDisplayLabel} applied to ${result.touched} patient${result.touched === 1 ? "" : "s"}.`
          : `${tagDisplayLabel} applied to ${result.touched} patient${result.touched === 1 ? "" : "s"} (${result.skipped} already had it).`,
      );
      clearSelection();
      setBulkPickerOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk apply failed.");
    } finally {
      setBulkApplying(false);
    }
  }

  const cutoffDate = useMemo(() => {
    if (windowMode === "all") return null;
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 12); // UTC to match the UTC date string below
    return d.toISOString().slice(0, 10);
  }, [windowMode]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = searchText.trim().toLowerCase();
    const base = rows.filter((r) => {
      if (cutoffDate && (!r.lastVisit || r.lastVisit < cutoffDate)) return false;
      if (manufacturerFilter && r.primaryManufacturer !== manufacturerFilter)
        return false;
      if (overdueOnly && !overdueIndex?.has(r.id)) return false;
      if (q && !r.displayName.toLowerCase().includes(q)) return false;
      // v385.1: waitlist filter. "on" = WaitlistEntry exists with
      // status=active; "off" = no entry OR status=revoked/paused.
      if (waitlistFilter !== "all") {
        const wl = waitlistIndex?.get(r.id);
        const isOn = Boolean(wl && wl.status === "active");
        if (waitlistFilter === "on" && !isOn) return false;
        if (waitlistFilter === "off" && isOn) return false;
      }
      // v385.2: VIP filter. "on" = row.vip true; "off" = row.vip false.
      if (vipFilter !== "all") {
        if (vipFilter === "on" && !r.vip) return false;
        if (vipFilter === "off" && r.vip) return false;
      }
      // v1.34.1: soft-tag filter. Union semantics — patient passes if
      // ANY of its filter-keys is in the active set. Empty set = no filter.
      if (softTagFilter.size > 0) {
        const keys = patientTagFilterKeys(r.softTags);
        if (!keys.some((k) => softTagFilter.has(k))) return false;
      }
      return true;
    });
    // v385.1: sort. Comparator chosen by sortKey; default descending for
    // numeric/date keys, ascending for name. NaN/null sentinel handling
    // ensures rows with missing data sort to the end consistently.
    const sorted = [...base].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.displayName.localeCompare(b.displayName, undefined, {
            sensitivity: "base",
          });
        case "lastVisit":
          return dateDesc(a.lastVisit, b.lastVisit);
        case "firstVisit":
          return dateDesc(a.firstVisit, b.firstVisit);
        case "visits":
          return (b.totalVisits ?? 0) - (a.totalVisits ?? 0);
        case "spend":
          return (b.lifetimeSpendUsd ?? 0) - (a.lifetimeSpendUsd ?? 0);
      }
    });
    return sorted;
  }, [
    rows,
    searchText,
    manufacturerFilter,
    cutoffDate,
    overdueOnly,
    overdueIndex,
    waitlistFilter,
    waitlistIndex,
    vipFilter,
    softTagFilter,
    sortKey,
  ]);

  const manufacturerCounts = useMemo(() => {
    if (!rows) return [];
    const counts = new Map<ProductManufacturer, number>();
    for (const r of rows) {
      if (r.primaryManufacturer) {
        if (cutoffDate && (!r.lastVisit || r.lastVisit < cutoffDate)) continue;
        if (overdueOnly && !overdueIndex?.has(r.id)) continue;
        counts.set(
          r.primaryManufacturer,
          (counts.get(r.primaryManufacturer) ?? 0) + 1,
        );
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows, cutoffDate, overdueOnly, overdueIndex]);

  // v1.34.1 (coherency pass): enumerate active soft-tag filter-keys across
  // the in-window patient set. One chip per (tagKey, value) tuple that
  // actually appears on at least one patient — strip stays scoped to what
  // Karen has actually used. Sort by count desc so most-used surfaces first.
  const softTagCounts = useMemo(() => {
    if (!rows) return [];
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (cutoffDate && (!r.lastVisit || r.lastVisit < cutoffDate)) continue;
      if (overdueOnly && !overdueIndex?.has(r.id)) continue;
      for (const k of patientTagFilterKeys(r.softTags)) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({
        key,
        label: tagFilterKeyLabel(key, customDefs),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [rows, cutoffDate, overdueOnly, overdueIndex, customDefs]);

  const overdueTotal = overdueIndex?.size ?? 0;

  // v1.34.0: selection helpers derived from current filter — only "visible"
  // patients participate in select-all + count badges.
  const visibleIds = useMemo(
    () => (filtered ?? []).map((r) => r.id),
    [filtered],
  );
  const selectedVisibleCount = useMemo(
    () => visibleIds.filter((id) => selectedIds.has(id)).length,
    [visibleIds, selectedIds],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const someVisibleSelected =
    selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      // Clear only visible ones (preserve any out-of-filter selections).
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) next.add(id);
        return next;
      });
    }
  };

  if (rows === null && !error) {
    return (
      <div>
        <PageHeader wide
          title="Patients"
          description="Everyone who's walked through your doors."
        />
        <div className="px-6 lg:px-10 py-14 flex items-center justify-center gap-2 text-sm text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading patients…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader wide
          title="Patients"
          description="Everyone who's walked through your doors."
        />
        <div className="px-6 lg:px-10 py-10">
          <EmptyState
            icon={Users}
            title="Couldn't load your patients"
            description={error}
          />
        </div>
      </div>
    );
  }

  if (rows && rows.length === 0) {
    return (
      <div>
        <PageHeader wide
          title="Patients"
          description="Everyone who's walked through your doors."
        />
        <div className="px-6 lg:px-10 py-10">
          <div className="max-w-xl mx-auto rounded-2xl border border-rule bg-white p-10 text-center space-y-5">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-emerald/10 flex items-center justify-center">
              <Users className="h-5 w-5 text-emerald" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold">No patients yet</h2>
              <p className="text-sm text-ink-soft leading-relaxed max-w-md mx-auto">
                Export <em>Sales by Patient Detail</em> from QuickBooks and drop
                it in. Emma turns it into a searchable patient book in seconds.
              </p>
            </div>
            <Link
              to="/app/refill/patients/import"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition"
            >
              <Upload className="h-4 w-4" />
              Import a CSV
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader wide
        title="Patients"
        description={
          rows ? `${rows.length.toLocaleString()} in your patient book.` : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/refill/patients/a-list-rules"
              className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
            >
              <Wand2 className="h-3.5 w-3.5" />
              A-list rules
            </Link>
            <Link
              to="/app/refill/patients/contacts"
              className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Contacts
            </Link>
            <Link
              to="/app/refill/patients/import"
              className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
            >
              <Upload className="h-3.5 w-3.5" />
              Import CSV
            </Link>
          </div>
        }
      />

      <div className="px-6 lg:px-10 py-6 space-y-5 max-w-[1280px] mx-auto">
        {/* Search + window toggle */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-faint" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search by name…"
              className="w-full rounded-lg border border-input bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {overdueTotal > 0 && (
            <button
              type="button"
              onClick={() => setOverdueOnly(!overdueOnly)}
              className={
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition " +
                (overdueOnly
                  ? "bg-amber text-paper hover:opacity-90"
                  : "border border-rule bg-white text-ink-soft hover:bg-rule-soft hover:text-ink")
              }
              title={
                overdueOnly
                  ? "Showing patients past their cadence window"
                  : "Filter to patients past their cadence window"
              }
            >
              <CalendarClock className="h-3.5 w-3.5" />
              {overdueOnly ? "Overdue only" : "Overdue"}
              <span
                className={cn(
                  "tabular-nums",
                  overdueOnly ? "text-white/85" : "text-ink-faint",
                )}
              >
                {overdueTotal.toLocaleString()}
              </span>
            </button>
          )}

          <WindowToggle value={windowMode} onChange={setWindowMode} />

          {/* v385.1: sort dropdown. Sits at the end of the control row;
              uses a native <select> styled to match the chip aesthetic so
              it stays accessible (keyboard + screen-reader). */}
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
            <ArrowUpDown className="h-3 w-3" aria-hidden />
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="rounded-lg border border-input bg-white px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Sort patients by"
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* v385.1: waitlist filter chip strip. Same Chip primitive as the
            manufacturer filter strip; lives directly under the top
            control row so the two filter affordances cluster visually. */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-ink-soft inline-flex items-center gap-1">
            <Filter className="h-3 w-3" />
            Waitlist
          </span>
          <Chip
            active={waitlistFilter === "all"}
            onClick={() => setWaitlistFilter("all")}
            label="All"
          />
          <Chip
            active={waitlistFilter === "on"}
            onClick={() => setWaitlistFilter("on")}
            label="On waitlist"
            count={
              waitlistIndex
                ? Array.from(waitlistIndex.values()).filter(
                    (w) => w.status === "active",
                  ).length
                : undefined
            }
          />
          <Chip
            active={waitlistFilter === "off"}
            onClick={() => setWaitlistFilter("off")}
            label="Off waitlist"
          />
        </div>

        {/* v385.2: A-list / VIP filter chip strip. Same shape as waitlist
            filter. Count badge on the "VIP" chip surfaces how many
            patients you've marked as A-list at a glance. */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-ink-soft inline-flex items-center gap-1">
            <Star className="h-3 w-3" />
            A-list
          </span>
          <Chip
            active={vipFilter === "all"}
            onClick={() => setVipFilter("all")}
            label="All"
          />
          <Chip
            active={vipFilter === "on"}
            onClick={() => setVipFilter("on")}
            label="VIP"
            count={rows ? rows.filter((r) => r.vip).length : undefined}
          />
          <Chip
            active={vipFilter === "off"}
            onClick={() => setVipFilter("off")}
            label="Not VIP"
          />
        </div>

        {/* Manufacturer chip filter */}
        {manufacturerCounts.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-ink-soft inline-flex items-center gap-1">
              <Filter className="h-3 w-3" />
              Primary
            </span>
            <Chip
              active={manufacturerFilter === null}
              onClick={() => setManufacturerFilter(null)}
              label="All"
              count={
                rows?.filter((r) => {
                  if (cutoffDate && (!r.lastVisit || r.lastVisit < cutoffDate))
                    return false;
                  return true;
                }).length ?? 0
              }
            />
            {manufacturerCounts.map(([mfr, count]) => (
              <Chip
                key={mfr}
                active={manufacturerFilter === mfr}
                onClick={() =>
                  setManufacturerFilter(manufacturerFilter === mfr ? null : mfr)
                }
                label={manufacturerLabel(mfr)}
                count={count}
              />
            ))}
          </div>
        )}

        {/* v1.34.1 (coherency pass): soft-tag filter chip strip. Renders
            only when at least one tag has been applied in the tenant —
            stays out of the way for tag-empty tenants. Multi-select union
            semantics matches Karen's mental model ("show me everyone
            tagged Loyal OR Specials-seeker"). Closes the v1.34.0 bulk-
            apply asymmetry: she can now filter back to what she tagged. */}
        {softTagCounts.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-ink-soft inline-flex items-center gap-1">
              <Tag className="h-3 w-3" />
              Tags
            </span>
            <Chip
              active={softTagFilter.size === 0}
              onClick={() => setSoftTagFilter(new Set())}
              label="All"
            />
            {softTagCounts.map(({ key, label, count }) => (
              <Chip
                key={key}
                active={softTagFilter.has(key)}
                onClick={() =>
                  setSoftTagFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                label={label}
                count={count}
              />
            ))}
            {softTagFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setSoftTagFilter(new Set())}
                className="text-[11px] text-ink-soft underline hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* v1.34.9.3: Show hidden toggle. Always available regardless of
            soft-tag-strip visibility. Hidden patients are excluded from
            list + rescue + recognition by default; toggle to reveal. */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border transition",
              showHidden
                ? "border-emerald bg-emerald-soft text-emerald-ink"
                : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink",
            )}
            title={
              showHidden
                ? "Hide hidden patients from list"
                : "Reveal hidden patients in list"
            }
          >
            {showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            {showHidden ? "Showing hidden" : "Show hidden"}
          </button>
        </div>

        {/* Result table */}
        {filtered && filtered.length === 0 ? (
          <div className="rounded-2xl border border-rule bg-white p-10 text-center text-sm text-ink-soft">
            No patients match those filters.
          </div>
        ) : (
          <div className="rounded-2xl border border-rule bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-rule/50">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-ink-soft">
                    {/* v1.34.0: select-all-visible checkbox */}
                    <th className="pl-4 pr-1 py-3 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all visible patients"
                        checked={allVisibleSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someVisibleSelected;
                        }}
                        onChange={toggleSelectAllVisible}
                        className="h-3.5 w-3.5 rounded border-rule accent-emerald cursor-pointer"
                      />
                    </th>
                    <th className="px-4 py-3 font-semibold">Patient</th>
                    <th className="px-4 py-3 font-semibold">Contact</th>
                    <th className="px-4 py-3 font-semibold whitespace-nowrap">Last visit</th>
                    <th className="px-4 py-3 font-semibold">Primary</th>
                    <th className="px-4 py-3 font-semibold text-right">Visits</th>
                    <th className="px-4 py-3 font-semibold text-right">
                      Lifetime spend
                    </th>
                    <th className="px-4 py-3 font-semibold text-center">A-list</th>
                    <th className="px-4 py-3 font-semibold text-center">Waitlist</th>
                    <th className="px-4 py-3 font-semibold text-center">Hide</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {filtered?.map((r) => {
                    const wl = waitlistIndex?.get(r.id) ?? null;
                    return (
                      <PatientRow
                        key={r.id}
                        row={r}
                        overdue={overdueIndex?.get(r.id) ?? null}
                        waitlist={wl}
                        pending={pendingToggleIds.has(r.id)}
                        onToggleWaitlist={() =>
                          toggleWaitlist(r.id, Boolean(wl && wl.status === "active"))
                        }
                        vipPending={pendingVipIds.has(r.id)}
                        onToggleVip={() => toggleVip(r.id, r.vip)}
                        selected={selectedIds.has(r.id)}
                        onToggleSelected={() => toggleSelected(r.id)}
                        customDefs={customDefs}
                        onToggleHidden={() => void onToggleHidden(r.id, r.hidden)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-rule text-[11px] text-ink-soft flex items-center justify-between">
              <span>
                Showing {filtered?.length.toLocaleString() ?? 0} of{" "}
                {rows?.length.toLocaleString() ?? 0}
              </span>
              <span>
                {windowMode === "12mo"
                  ? "Last 12 months"
                  : "All time"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* v1.34.0: floating bulk-action toolbar — appears when 1+ selected */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-full border border-rule bg-white shadow-2xl px-4 py-2">
          <div className="text-[12px] font-medium text-ink">
            <span className="font-semibold text-emerald-ink">
              {selectedIds.size}
            </span>{" "}
            patient{selectedIds.size === 1 ? "" : "s"} selected
          </div>
          <div className="h-4 w-px bg-rule" />
          <button
            type="button"
            onClick={() => setBulkPickerOpen(true)}
            disabled={bulkApplying}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            <Tag className="h-3 w-3" />
            Apply soft tag
          </button>
          <button
            type="button"
            onClick={clearSelection}
            disabled={bulkApplying}
            className="inline-flex items-center gap-1 rounded-full border border-rule px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:text-ink transition disabled:opacity-50"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        </div>
      )}

      {/* v1.34.0: bulk soft-tag picker modal */}
      {bulkPickerOpen && (
        <BulkTagPickerModal
          selectedCount={selectedIds.size}
          customDefs={customDefs}
          preshowProfiles={preshowProfiles}
          busy={bulkApplying}
          onCancel={() => setBulkPickerOpen(false)}
          onApply={bulkApply}
        />
      )}
    </div>
  );
}

function PatientRow({
  row,
  overdue,
  waitlist,
  pending,
  onToggleWaitlist,
  vipPending,
  onToggleVip,
  selected,
  onToggleSelected,
  customDefs,
  onToggleHidden,
}: {
  row: PatientListRow;
  overdue: OverduePatient | null;
  /** v385: waitlist row joined by patient_node_id. null if never opted in. */
  waitlist: WaitlistEntry | null;
  /** v385: true while the toggle's async server fn is in flight. */
  pending: boolean;
  /** v385: fires the markPatientOptedIn/Out server fn with optimistic UI. */
  onToggleWaitlist: () => void;
  /** v385.2: true while the VIP toggle's async server fn is in flight. */
  vipPending: boolean;
  /** v1.34.0: row is in the bulk-action selection set. */
  selected: boolean;
  /** v1.34.0: toggle this row in/out of the bulk-action selection. */
  onToggleSelected: () => void;
  /** v385.2: fires setPatientVip with optimistic UI. */
  onToggleVip: () => void;
  /** v1.34.9.3: fires setPatientHidden with optimistic UI. */
  onToggleHidden: () => void;
  /** v1.34.1 (coherency pass): tenant custom tag defs for resolving the
   *  per-row tag pill labels. Passed down from the parent so we don't
   *  re-fetch per row. */
  customDefs: CustomTagDefinition[];
}) {
  // v385: active = currently on the waitlist (not revoked / not paused).
  // Anything else renders as "off."
  const active = Boolean(waitlist && waitlist.status === "active");
  // v385: "added by" — collapses the underlying opt_in_source values to
  // the two buckets a spa owner cares about. spa-manual = admin added
  // them via the UI; everything else (footer-link, sms-reply) = patient
  // self-opt-in.
  const addedBy: "admin" | "user" | null = !active
    ? null
    : waitlist?.optInSource === "spa-manual"
      ? "admin"
      : "user";

  return (
    <tr
      className={cn(
        "hover:bg-rule-soft/40 transition cursor-pointer",
        selected && "bg-emerald-soft/30",
        row.hidden && "opacity-60 hover:opacity-100",
      )}
    >
      {/* v1.34.0: bulk selection checkbox — clicks don't navigate */}
      <td className="pl-4 pr-1 py-3 w-8">
        <input
          type="checkbox"
          aria-label={`Select ${row.displayName}`}
          checked={selected}
          onChange={onToggleSelected}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 rounded border-rule accent-emerald cursor-pointer"
        />
      </td>
      <td className="px-4 py-3">
        <Link
          to="/app/refill/patients/$patientId"
          params={{ patientId: row.id }}
          className="block"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink hover:text-emerald transition">
              {row.displayName}
            </span>
            {overdue && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                  overdue.isLapsed
                    ? "bg-rose-soft text-rose"
                    : "bg-amber-soft text-amber",
                )}
                title={`Last ${overdue.kind} ${overdue.lastVisitOfKind} — ${overdue.daysOverdue}d past window`}
              >
                <CalendarClock className="h-2.5 w-2.5" />
                {overdue.daysOverdue >= 30
                  ? `${Math.round(overdue.daysOverdue / 30)}mo overdue`
                  : `${overdue.daysOverdue}d overdue`}
              </span>
            )}
            {row.banned && (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-soft text-rose px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
                <Ban className="h-2.5 w-2.5" />
                Banned
              </span>
            )}
          </div>
          {/* v1.34.1 (coherency pass): soft-tag pill cluster. Two visible
              chips + "+N more" overflow. Closes the v1.34.0 asymmetry —
              Karen can now see at a glance who's tagged what. */}
          <SoftTagPillCluster
            softTags={row.softTags}
            customDefs={customDefs}
          />
          {row.firstVisit && (
            <div className="text-[11px] text-ink-faint">
              first visit {formatDate(row.firstVisit)}
            </div>
          )}
        </Link>
      </td>
      <td className="px-4 py-3">
        <ContactCell phone={row.phone} email={row.email} />
      </td>
      <td className="px-4 py-3 text-sm text-ink whitespace-nowrap">
        {row.lastVisit ? formatDate(row.lastVisit) : "—"}
      </td>
      <td className="px-4 py-3">
        {row.primaryManufacturer ? (
          <ManufacturerChip mfr={row.primaryManufacturer} />
        ) : (
          <span className="text-ink-faint text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {row.totalVisits.toLocaleString()}
      </td>
      <td className="px-4 py-3 text-right tabular-nums font-medium">
        {row.lifetimeSpendUsd.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        })}
      </td>
      {/* v385.2: A-list / VIP toggle cell. Star icon — filled emerald
          when on, outlined ink-faint when off. Distinct visual from the
          waitlist switch so the two roles read as different mental
          models, not just two boolean knobs. */}
      <td
        className="px-4 py-3 text-center"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <button
          type="button"
          aria-pressed={row.vip}
          aria-label={row.vip ? "Remove from A-list" : "Mark as A-list"}
          title={row.vip ? "A-list VIP — tap to unstar" : "Mark as A-list VIP"}
          disabled={vipPending}
          onClick={onToggleVip}
          className={cn(
            "inline-flex items-center justify-center h-7 w-7 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald",
            row.vip
              ? "text-emerald hover:bg-emerald/10"
              : "text-ink-faint hover:text-ink hover:bg-rule-soft",
            vipPending ? "opacity-60 cursor-wait" : "cursor-pointer",
          )}
        >
          <Star
            className={cn(
              "h-4 w-4 transition",
              row.vip ? "fill-emerald" : "fill-none",
            )}
          />
        </button>
      </td>
      <td
        className="px-4 py-3 text-center"
        onClick={(e) => {
          // The row wraps a <Link> via the Patient cell; clicking the toggle
          // should NOT navigate. Stop bubbling here.
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={active}
            aria-label={active ? "Remove from waitlist" : "Add to waitlist"}
            disabled={pending}
            onClick={onToggleWaitlist}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald",
              active ? "bg-emerald" : "bg-track",
              pending ? "opacity-60 cursor-wait" : "cursor-pointer",
            )}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition",
                active ? "translate-x-[18px]" : "translate-x-[3px]",
              )}
            />
          </button>
          {addedBy && (
            <span className="text-[9px] uppercase tracking-wider text-ink-faint">
              by {addedBy}
            </span>
          )}
        </div>
      </td>
      {/* v1.34.9.3: Hide / Unhide column */}
      <td
        className="px-4 py-3 text-center"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <button
          type="button"
          onClick={onToggleHidden}
          title={row.hidden ? "Unhide patient" : "Hide patient from list"}
          className={cn(
            "inline-flex items-center gap-1 rounded border bg-white px-2 py-1 text-[11px] font-medium transition",
            row.hidden
              ? "border-emerald/40 text-emerald-ink hover:bg-emerald hover:text-paper"
              : "border-rule text-ink-soft hover:text-rose hover:border-rose/40",
          )}
        >
          {row.hidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          {row.hidden ? "Unhide" : "Hide"}
        </button>
      </td>
    </tr>
  );
}

/**
 * v1.34.1 (coherency pass): soft-tag pill cluster rendered inline in each
 * patient row. Shows up to 2 chips by default + a "+N" overflow indicator.
 * Visual style mirrors the existing emerald-soft chip palette used on the
 * patient detail page so tags read the same in both places.
 *
 * Cultural notes (free-text) intentionally skipped — doesn't fit chip
 * semantics. Same exclusion as the bulk picker + the filter strip.
 */
function SoftTagPillCluster({
  softTags,
  customDefs,
}: {
  softTags: PatientSoftTags;
  customDefs: CustomTagDefinition[];
}) {
  const pills: string[] = [];

  // Seeded — order matches the patient detail page card sequence.
  if (softTags.shopperLoyalty?.value) {
    pills.push(
      SEEDED_TAG_VALUE_LABELS.shopperLoyalty[softTags.shopperLoyalty.value] ??
        softTags.shopperLoyalty.value,
    );
  }
  if (softTags.specialsSeeker?.value === true) {
    pills.push(SEEDED_TAG_VALUE_LABELS.specialsSeeker.true);
  }
  if (softTags.incomeTier?.value) {
    pills.push(
      SEEDED_TAG_VALUE_LABELS.incomeTier[softTags.incomeTier.value] ??
        softTags.incomeTier.value,
    );
  }
  if (softTags.negotiator?.value) {
    pills.push(
      SEEDED_TAG_VALUE_LABELS.negotiator[softTags.negotiator.value] ??
        softTags.negotiator.value,
    );
  }
  if (softTags.personality?.value) {
    pills.push(
      SEEDED_TAG_VALUE_LABELS.personality[softTags.personality.value] ??
        softTags.personality.value,
    );
  }

  // Custom selections.
  if (softTags.customSelections) {
    for (const [defId, sel] of Object.entries(softTags.customSelections)) {
      const def = customDefs.find((d) => d.id === defId);
      for (const opt of sel.selected ?? []) {
        pills.push(def ? `${def.name}: ${opt}` : opt);
      }
    }
  }

  if (pills.length === 0) return null;

  const VISIBLE = 2;
  const visible = pills.slice(0, VISIBLE);
  const overflow = pills.length - visible.length;
  const allLabels = pills.join(" · ");

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" title={allLabels}>
      {visible.map((label, i) => (
        <span
          key={`${label}-${i}`}
          className="inline-flex items-center rounded-full bg-emerald-soft text-emerald-ink px-1.5 py-0.5 text-[9px] font-medium"
        >
          <Tag className="h-2 w-2 mr-0.5" />
          {label}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="text-[9px] text-ink-soft font-medium"
          title={allLabels}
        >
          +{overflow} more
        </span>
      )}
    </div>
  );
}

function ContactCell({
  phone,
  email,
}: {
  phone: string | null;
  email: string | null;
}) {
  if (!phone && !email) {
    return <span className="text-ink-faint text-xs">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      {phone && (
        <span className="inline-flex items-center gap-1 text-ink">
          <Phone className="h-3 w-3 text-ink-faint" />
          {formatPhone(phone)}
        </span>
      )}
      {email && (
        <span className="inline-flex items-center gap-1 text-ink-soft truncate max-w-[200px]">
          <Mail className="h-3 w-3 text-ink-faint shrink-0" />
          <span className="truncate">{email}</span>
        </span>
      )}
    </div>
  );
}

function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}

function WindowToggle({
  value,
  onChange,
}: {
  value: Window;
  onChange: (w: Window) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-rule bg-white p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange("12mo")}
        className={
          "px-3 py-1.5 rounded-md font-medium transition " +
          (value === "12mo"
            ? "bg-emerald text-paper"
            : "text-ink-soft hover:text-ink")
        }
      >
        Last 12mo
      </button>
      <button
        type="button"
        onClick={() => onChange("all")}
        className={
          "px-3 py-1.5 rounded-md font-medium transition " +
          (value === "all"
            ? "bg-emerald text-paper"
            : "text-ink-soft hover:text-ink")
        }
      >
        All time
      </button>
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  /** Optional count badge — omit on chips where a count isn't meaningful
   *  (e.g. the "All" or "Off" filter chips added in v385.1). */
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium border transition " +
        (active
          ? "bg-emerald text-paper border-emerald"
          : "bg-white text-ink-soft border-rule hover:bg-rule-soft")
      }
    >
      {label}
      {count !== undefined && (
        <span
          className={
            "tabular-nums text-[10px] " +
            (active ? "opacity-90" : "text-ink-faint")
          }
        >
          {count.toLocaleString()}
        </span>
      )}
    </button>
  );
}

function ManufacturerChip({ mfr }: { mfr: ProductManufacturer }) {
  const palette = MANUFACTURER_COLORS[mfr] ?? "bg-rule text-ink";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
        palette
      }
    >
      {manufacturerLabel(mfr)}
    </span>
  );
}

const MANUFACTURER_COLORS: Partial<Record<ProductManufacturer, string>> = {
  evolus: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
  abbvie: "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
  merz: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
  galderma: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  "abbvie-coolsculpting": "bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200",
  skinceuticals: "bg-stone-100 text-stone-800 dark:bg-stone-500/20 dark:text-stone-200",
  eltamd: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
  neocutis: "bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200",
  obagi: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200",
};

function manufacturerLabel(mfr: ProductManufacturer): string {
  switch (mfr) {
    case "evolus":
      return "Evolus";
    case "abbvie":
      return "AbbVie";
    case "merz":
      return "Merz";
    case "galderma":
      return "Galderma";
    case "abbvie-coolsculpting":
      return "CoolSculpting";
    case "skinceuticals":
      return "SkinCeuticals";
    case "eltamd":
      return "EltaMD";
    case "neocutis":
      return "Neocutis";
    case "obagi":
      return "Obagi";
    case "revance":
      return "Revance";
    case "rha":
      return "RHA";
    case "sciton":
      return "Sciton";
    default:
      return mfr;
  }
}

function formatDate(iso: string): string {
  // ISO date "2024-05-07" → "May 7, 2024"
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  // This one stays "UTC" — `date` is constructed from Date.UTC(y, m-1, d)
  // which is a date-only value (no time component). Rendering it with a
  // local timezone would shift the calendar day across midnight boundaries.
  // The intent is "show the calendar date as-stored." Keep UTC.
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ─── Bulk soft-tag picker modal (v1.34.0) ─────────────────────────────────

type PresetTagKey =
  | "incomeTier"
  | "negotiator"
  | "specialsSeeker"
  | "personality"
  | "shopperLoyalty"
  | "culturalNotes"
  | "preshowProfileId";

type PresetTagDef = {
  key: PresetTagKey;
  label: string;
  options: Array<{ value: string | boolean; label: string }>;
};

const PRESET_TAGS: PresetTagDef[] = [
  {
    key: "incomeTier",
    label: "Income tier",
    options: [
      { value: "high", label: "High" },
      { value: "mid", label: "Mid" },
      { value: "low", label: "Low" },
      { value: "unknown", label: "Unknown" },
    ],
  },
  {
    key: "negotiator",
    label: "Negotiator",
    options: [
      { value: "never", label: "Never" },
      { value: "occasional", label: "Occasional" },
      { value: "always", label: "Always" },
    ],
  },
  {
    key: "specialsSeeker",
    label: "Specials seeker",
    options: [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ],
  },
  {
    key: "personality",
    label: "Personality",
    options: [
      { value: "easy", label: "Easy" },
      { value: "neutral", label: "Neutral" },
      { value: "complainer", label: "Complainer" },
    ],
  },
  {
    key: "shopperLoyalty",
    label: "Shopper loyalty",
    options: [
      { value: "loyal", label: "Loyal" },
      { value: "comparison", label: "Comparison" },
      { value: "unknown", label: "Unknown" },
    ],
  },
];
// Cultural notes is free-text only; skipped in bulk picker (per-patient still).

type BulkPickerSelection =
  | { kind: "preset"; key: PresetTagKey; value: string | boolean; label: string }
  | {
      kind: "custom";
      definitionId: string;
      selected: string[];
      label: string;
    };

function BulkTagPickerModal({
  selectedCount,
  customDefs,
  preshowProfiles,
  busy,
  onCancel,
  onApply,
}: {
  selectedCount: number;
  customDefs: CustomTagDefinition[];
  preshowProfiles: PreshowProfile[];
  busy: boolean;
  onCancel: () => void;
  onApply: (
    tag:
      | {
          kind: "preset";
          key: PresetTagKey;
          value: string | boolean;
        }
      | { kind: "custom"; definitionId: string; selected: string[] },
    reason: string,
    tagDisplayLabel: string,
  ) => void;
}) {
  const [pick, setPick] = useState<BulkPickerSelection | null>(null);
  const [reason, setReason] = useState("");

  const apply = () => {
    if (!pick) return;
    if (pick.kind === "preset") {
      // v1.34.3.1: preshow-profile value is a UUID — resolve to the
      // human profile name for the toast/audit label.
      const valueLabel =
        pick.key === "preshowProfileId"
          ? preshowProfiles.find((p) => p.id === pick.value)?.name ??
            "Unknown profile"
          : pick.label === "Specials seeker"
            ? pick.value
              ? "Yes"
              : "No"
            : String(pick.value);
      onApply(
        { kind: "preset", key: pick.key, value: pick.value },
        reason,
        `${pick.label}: ${valueLabel}`,
      );
    } else {
      onApply(
        {
          kind: "custom",
          definitionId: pick.definitionId,
          selected: pick.selected,
        },
        reason,
        `${pick.label} (${pick.selected.length} chip${pick.selected.length === 1 ? "" : "s"})`,
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg max-h-[calc(100vh-2rem)] flex flex-col rounded-2xl border border-rule bg-white shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-rule bg-emerald-soft/40 flex items-center gap-2">
          <Tag className="h-4 w-4 text-emerald-ink" />
          <div className="text-[13px] font-semibold text-emerald-ink">
            Apply soft tag to {selectedCount} patient{selectedCount === 1 ? "" : "s"}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="ml-auto text-ink-soft hover:text-ink transition disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Preset tag groups */}
          <div className="space-y-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Preset tags
            </div>
            {PRESET_TAGS.map((tag) => (
              <div key={tag.key}>
                <div className="text-[11px] font-medium text-ink mb-1.5">
                  {tag.label}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tag.options.map((opt) => {
                    const active =
                      pick?.kind === "preset" &&
                      pick.key === tag.key &&
                      pick.value === opt.value;
                    return (
                      <button
                        key={String(opt.value)}
                        type="button"
                        onClick={() =>
                          setPick({
                            kind: "preset",
                            key: tag.key,
                            value: opt.value,
                            label: tag.label,
                          })
                        }
                        disabled={busy}
                        className={cn(
                          "rounded-full px-3 py-1 text-[11px] font-medium border transition disabled:opacity-50",
                          active
                            ? "border-emerald bg-emerald-soft text-emerald-ink"
                            : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink",
                        )}
                      >
                        {active && <Check className="h-2.5 w-2.5 inline mr-1" />}
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* v1.34.3.1: preshow profile routing — route N selected patients
              to a named cadence profile (e.g., the Chronic profile for
              chronic-reschedulers). One chip per profile; mutually
              exclusive. */}
          {preshowProfiles.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-rule">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Preshow profile (Agents · routes reminders)
              </div>
              <div>
                <div className="text-[11px] font-medium text-ink mb-1.5">
                  Set preshow profile
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {preshowProfiles.map((profile) => {
                    const active =
                      pick?.kind === "preset" &&
                      pick.key === "preshowProfileId" &&
                      pick.value === profile.id;
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() =>
                          setPick({
                            kind: "preset",
                            key: "preshowProfileId",
                            value: profile.id,
                            label: "Preshow profile",
                          })
                        }
                        disabled={busy}
                        className={cn(
                          "rounded-full px-3 py-1 text-[11px] font-medium border transition disabled:opacity-50",
                          active
                            ? "border-emerald bg-emerald-soft text-emerald-ink"
                            : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink",
                        )}
                      >
                        {active && <Check className="h-2.5 w-2.5 inline mr-1" />}
                        {profile.name}
                        {profile.isDefault && (
                          <span className="ml-1 text-ink-faint">· default</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 text-[10px] text-ink-faint">
                  Override the spa-wide default for these patients only. The Preshow Agent reads this routing on every reminder.
                </div>
              </div>
            </div>
          )}

          {/* Custom tag definitions */}
          {customDefs.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-rule">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Custom tags (tenant-wide)
              </div>
              {customDefs.map((def) => {
                const isActive =
                  pick?.kind === "custom" && pick.definitionId === def.id;
                const selected =
                  isActive && pick.kind === "custom" ? pick.selected : [];
                return (
                  <div key={def.id}>
                    <div className="text-[11px] font-medium text-ink mb-1.5">
                      {def.name}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {def.options.map((opt: string) => {
                        const active = selected.includes(opt);
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              const nextSelected = active
                                ? selected.filter((s) => s !== opt)
                                : [...selected, opt];
                              setPick({
                                kind: "custom",
                                definitionId: def.id,
                                selected: nextSelected,
                                label: def.name,
                              });
                            }}
                            disabled={busy}
                            className={cn(
                              "rounded-full px-3 py-1 text-[11px] font-medium border transition disabled:opacity-50",
                              active
                                ? "border-emerald bg-emerald-soft text-emerald-ink"
                                : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink",
                            )}
                          >
                            {active && (
                              <Check className="h-2.5 w-2.5 inline mr-1" />
                            )}
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Reason note */}
          <div className="pt-2 border-t border-rule">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">
              Reason (optional)
            </div>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., snowbird season prep, filler-loyalist promo cohort"
              maxLength={500}
              disabled={busy}
              className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
            />
            <div className="mt-0.5 text-[10px] text-ink-faint">
              Applied to every selected patient's tag history.
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-rule bg-rule-soft/30 flex items-center gap-2">
          <button
            type="button"
            onClick={apply}
            disabled={
              busy ||
              !pick ||
              (pick.kind === "custom" && pick.selected.length === 0)
            }
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Apply to {selectedCount} patient{selectedCount === 1 ? "" : "s"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-rule bg-white px-3 py-2 text-[12px] font-medium text-ink-soft hover:text-ink transition disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
