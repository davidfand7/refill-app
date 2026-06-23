/**
 * /app/refill/recognition/inventory — Recognition Engine Pool Entry (v1.34.2).
 *
 * Substrate surface for the Recognition Allocation Engine. Karen enters the
 * inventory she'll deploy as recognition currency to selected patients.
 *
 * Two kinds (matching the schema-level documentation wall established
 * 2026-06-02):
 *   - Documented: portal-issued credits (Alle for Business / APP / Aspire /
 *     Evolus). Captured with manufacturer + program + period + source ref.
 *   - Anonymous: promo/samples product, NO provenance fields. Just brand + SKU +
 *     units. The wall holds: nothing in the schema links back to a specific
 *     verbal deal / rep / off-the-record sample-bridge.
 *
 * UI pattern matches /app/refill/catalog/products: PageHeader + Add buttons +
 * inline expandable cards for each row. Click to edit; Delete inside the
 * edit form.
 *
 * v1.34.2 ships CRUD + list. v1.34.2.1 will add the Manufacturer Profile
 * surface (per-tenant tier snapshots) + AI extraction (Claude Sonnet 4.6
 * parsing portal paste). v1.34.3 wires the allocation engine.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  FileCheck2,
  Loader2,
  Package,
  Pencil,
  Plus,
  Save,
  ShieldOff,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { RecognitionTabs } from "@/components/refill/RecognitionTabs";
import { IncentivesAtWorkBand } from "@/components/refill/IncentivesAtWorkBand";
import { PromoIntelligenceCard } from "@/components/refill/PromoIntelligenceCard";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  createAnonymousInventory,
  createDocumentedInventory,
  deleteRebateInventory,
  listRebateInventory,
  updateRebateInventory,
  type RebateInventoryEntry,
  type RebateInventoryKind,
} from "@/server/refill-recognition.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/recognition/inventory")({
  component: RecognitionInventoryPage,
});

const MANUFACTURER_OPTIONS = [
  { value: "abbvie", label: "AbbVie / Allergan (Alle for Business / APP)" },
  { value: "galderma", label: "Galderma (Aspire)" },
  { value: "evolus", label: "Evolus" },
  { value: "merz", label: "Merz" },
  { value: "revance", label: "Revance (Daxxify)" },
  { value: "other", label: "Other" },
] as const;

type DocumentedDraft = {
  manufacturer: string;
  brand: string;
  sku: string;
  programName: string;
  programPeriod: string;
  sourceRef: string;
  unitsTotal: string;
  earnedDate: string;
  expiresDate: string;
  notes: string;
};

const EMPTY_DOC_DRAFT: DocumentedDraft = {
  manufacturer: "abbvie",
  brand: "",
  sku: "",
  programName: "",
  programPeriod: "",
  sourceRef: "",
  unitsTotal: "1",
  earnedDate: new Date().toISOString().slice(0, 10),
  expiresDate: "",
  notes: "",
};

type AnonymousDraft = {
  brand: string;
  sku: string;
  unitsTotal: string;
  notes: string;
};

const EMPTY_ANON_DRAFT: AnonymousDraft = {
  brand: "",
  sku: "",
  unitsTotal: "1",
  notes: "",
};

type AddPanel = "none" | "documented" | "anonymous";

function RecognitionInventoryPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [rows, setRows] = useState<RebateInventoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [addPanel, setAddPanel] = useState<AddPanel>("none");
  const [docDraft, setDocDraft] = useState<DocumentedDraft>(EMPTY_DOC_DRAFT);
  const [anonDraft, setAnonDraft] = useState<AnonymousDraft>(EMPTY_ANON_DRAFT);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (membership.status === "loading") return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) setLoadError("Please sign in to manage inventory.");
          return;
        }
        const list = await listRebateInventory({
          data: { accessToken: token, viewAsUserId },
        });
        if (!cancelled) {
          setRows(list);
          setAccessToken(token);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Couldn't load inventory.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  const documented = useMemo(
    () => (rows ?? []).filter((r) => r.kind === "documented"),
    [rows],
  );
  const anonymous = useMemo(
    () => (rows ?? []).filter((r) => r.kind === "anonymous"),
    [rows],
  );

  async function createDocumented(e: FormEvent) {
    e.preventDefault();
    if (!accessToken) return;
    const unitsTotal = parseInt(docDraft.unitsTotal, 10);
    if (!Number.isFinite(unitsTotal) || unitsTotal < 0) {
      toast.error("Units must be a non-negative number.");
      return;
    }
    setCreating(true);
    try {
      const entry = await createDocumentedInventory({
        data: {
          accessToken,
          viewAsUserId,
          manufacturer: docDraft.manufacturer,
          brand: docDraft.brand.trim(),
          sku: docDraft.sku.trim(),
          programName: docDraft.programName.trim(),
          programPeriod: docDraft.programPeriod.trim(),
          sourceRef: docDraft.sourceRef.trim() || undefined,
          unitsTotal,
          earnedDate: docDraft.earnedDate,
          expiresDate: docDraft.expiresDate || undefined,
          notes: docDraft.notes.trim() || undefined,
        },
      });
      setRows((prev) => (prev ? [entry, ...prev] : [entry]));
      setDocDraft(EMPTY_DOC_DRAFT);
      setAddPanel("none");
      toast.success(`Added ${entry.unitsTotal} × ${entry.brand} from ${entry.programName}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setCreating(false);
    }
  }

  async function createAnonymous(e: FormEvent) {
    e.preventDefault();
    if (!accessToken) return;
    const unitsTotal = parseInt(anonDraft.unitsTotal, 10);
    if (!Number.isFinite(unitsTotal) || unitsTotal < 0) {
      toast.error("Units must be a non-negative number.");
      return;
    }
    setCreating(true);
    try {
      const entry = await createAnonymousInventory({
        data: {
          accessToken,
          viewAsUserId,
          brand: anonDraft.brand.trim(),
          sku: anonDraft.sku.trim(),
          unitsTotal,
          notes: anonDraft.notes.trim() || undefined,
        },
      });
      setRows((prev) => (prev ? [entry, ...prev] : [entry]));
      setAnonDraft(EMPTY_ANON_DRAFT);
      setAddPanel("none");
      toast.success(`Added ${entry.unitsTotal} × ${entry.brand} (promo/samples).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdate(id: string, patch: Partial<RebateInventoryEntry>) {
    if (!accessToken) return;
    try {
      const entry = await updateRebateInventory({
        data: {
          accessToken,
          viewAsUserId,
          id,
          brand: patch.brand,
          sku: patch.sku,
          unitsTotal: patch.unitsTotal,
          notes: patch.notes ?? null,
        },
      });
      setRows((prev) =>
        prev ? prev.map((r) => (r.id === id ? entry : r)) : prev,
      );
      setEditingId(null);
      toast.success("Inventory updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update.");
    }
  }

  async function handleDelete(id: string) {
    if (!accessToken) return;
    if (!window.confirm("Delete this inventory entry? This can't be undone.")) {
      return;
    }
    try {
      await deleteRebateInventory({
        data: { accessToken, viewAsUserId, id },
      });
      setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
      setEditingId(null);
      toast.success("Inventory deleted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete.");
    }
  }

  if (rows === null && !loadError) {
    return (
      <div>
        <PageHeader
          title="Incentives"
          description="The pool of manufacturer-rebate units you can deploy to recognize specific patients."
        />
        <div className="px-6 lg:px-10 py-14 flex items-center justify-center gap-2 text-sm text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading incentives…
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Incentives"
        description="The pool of manufacturer-funded units you can deploy to recognize specific patients. Two kinds: documented (portal-issued) and promo/samples."
      />

      <RecognitionTabs active="inventory" />

      <div className="px-6 lg:px-10 py-6 space-y-6 max-w-[960px] mx-auto">
        {loadError && (
          <div className="rounded-xl border border-rose/30 bg-rose-soft px-4 py-3 text-sm text-rose">
            {loadError}
          </div>
        )}

        {/* Cross-source incentive-ROI scoreboard — recall + cross-sell verified
            $ recovered + allocation send activity, one honest band. */}
        {accessToken && (
          <IncentivesAtWorkBand
            accessToken={accessToken}
            viewAsUserId={viewAsUserId}
          />
        )}

        {/* Cross-link to the margin lens (same incentives, different view). */}
        <div className="rounded-lg border border-rule bg-rule-soft/40 px-4 py-2.5 text-[12px] text-ink-soft flex items-center gap-1.5 flex-wrap">
          <span>This is the pool you deploy to patients. To see what each incentive costs your margin,</span>
          <Link
            to="/app/refill/catalog/brand-economics"
            className="font-semibold text-emerald-ink hover:underline"
          >
            open Brand economics →
          </Link>
        </div>

        {/* Add buttons */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setAddPanel(addPanel === "documented" ? "none" : "documented")}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition",
              addPanel === "documented"
                ? "bg-emerald text-paper"
                : "border border-rule bg-white text-ink hover:bg-rule-soft",
            )}
          >
            <FileCheck2 className="h-4 w-4" />
            Add portal-issued
          </button>
          <button
            type="button"
            onClick={() => setAddPanel(addPanel === "anonymous" ? "none" : "anonymous")}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition",
              addPanel === "anonymous"
                ? "bg-emerald text-paper"
                : "border border-rule bg-white text-ink hover:bg-rule-soft",
            )}
          >
            <ShieldOff className="h-4 w-4" />
            Add promo/samples
          </button>
          {rows && rows.length > 0 && (
            <span className="text-xs text-ink-soft ml-auto">
              {rows.reduce((acc, r) => acc + (r.unitsTotal - r.unitsDeployed), 0)}{" "}
              units available across {rows.length}{" "}
              {rows.length === 1 ? "entry" : "entries"}
            </span>
          )}
        </div>

        {/* Documented add panel */}
        {addPanel === "documented" && (
          <DocumentedForm
            draft={docDraft}
            setDraft={setDocDraft}
            busy={creating}
            onSubmit={createDocumented}
            onCancel={() => {
              setAddPanel("none");
              setDocDraft(EMPTY_DOC_DRAFT);
            }}
          />
        )}

        {/* Anonymous add panel */}
        {addPanel === "anonymous" && (
          <AnonymousForm
            draft={anonDraft}
            setDraft={setAnonDraft}
            busy={creating}
            onSubmit={createAnonymous}
            onCancel={() => {
              setAddPanel("none");
              setAnonDraft(EMPTY_ANON_DRAFT);
            }}
          />
        )}

        {/* Lists grouped by kind */}
        {rows && rows.length === 0 ? (
          <EmptyState onAddDocumented={() => setAddPanel("documented")} />
        ) : (
          <div className="space-y-6">
            {documented.length > 0 && (
              <InventoryGroup
                title="Portal-issued"
                subtitle="Tracked with manufacturer + program + period."
                kind="documented"
                rows={documented}
                editingId={editingId}
                onStartEdit={(id) => setEditingId(id)}
                onCancelEdit={() => setEditingId(null)}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
              />
            )}
            {anonymous.length > 0 && (
              <InventoryGroup
                title="Promo/samples"
                subtitle="No source recorded — deploy at your discretion."
                kind="anonymous"
                rows={anonymous}
                editingId={editingId}
                onStartEdit={(id) => setEditingId(id)}
                onCancelEdit={() => setEditingId(null)}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
              />
            )}
          </div>
        )}

        {/* Manufacturer promos — managed here; the CSV feed lives on Rewards. */}
        {accessToken && (
          <PromoIntelligenceCard
            accessToken={accessToken}
            viewAsUserId={viewAsUserId}
            showImport={false}
            crossLink={{ label: "Import on Rewards", to: "/app/refill/recognition/rewards" }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────

function EmptyState({ onAddDocumented }: { onAddDocumented: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-rule bg-white/50 px-6 py-14 text-center space-y-4">
      <div className="mx-auto h-12 w-12 rounded-2xl bg-emerald-soft flex items-center justify-center">
        <Sparkles className="h-6 w-6 text-emerald" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold text-ink">No inventory yet</h2>
        <p className="text-sm text-ink-soft leading-relaxed max-w-md mx-auto">
          Add the manufacturer-rebate units you can deploy to recognize specific
          patients. Portal-issued entries (from APP / Aspire / Alle) include
          program + period; promo/samples entries are just brand + units.
        </p>
      </div>
      <button
        type="button"
        onClick={onAddDocumented}
        className="inline-flex items-center gap-2 rounded-lg bg-emerald text-paper px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition"
      >
        <Plus className="h-4 w-4" />
        Add your first entry
      </button>
    </div>
  );
}

// ─── Group ────────────────────────────────────────────────────────────────

function InventoryGroup({
  title,
  subtitle,
  kind,
  rows,
  editingId,
  onStartEdit,
  onCancelEdit,
  onUpdate,
  onDelete,
}: {
  title: string;
  subtitle: string;
  kind: RebateInventoryKind;
  rows: RebateInventoryEntry[];
  editingId: string | null;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onUpdate: (id: string, patch: Partial<RebateInventoryEntry>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <section>
      <header className="mb-3">
        <h3 className="text-sm font-semibold text-ink tracking-tight flex items-center gap-2">
          {kind === "documented" ? (
            <FileCheck2 className="h-3.5 w-3.5 text-emerald" />
          ) : (
            <ShieldOff className="h-3.5 w-3.5 text-ink-soft" />
          )}
          {title}
          <span className="text-[11px] font-normal text-ink-soft">
            · {rows.length} {rows.length === 1 ? "entry" : "entries"}
          </span>
        </h3>
        <p className="text-xs text-ink-soft mt-0.5">{subtitle}</p>
      </header>
      <div className="space-y-3">
        {rows.map((r) => (
          <InventoryRow
            key={r.id}
            row={r}
            isEditing={editingId === r.id}
            onStartEdit={() => onStartEdit(r.id)}
            onCancelEdit={onCancelEdit}
            onUpdate={(patch) => onUpdate(r.id, patch)}
            onDelete={() => onDelete(r.id)}
          />
        ))}
      </div>
    </section>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function InventoryRow({
  row,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onUpdate,
  onDelete,
}: {
  row: RebateInventoryEntry;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onUpdate: (patch: Partial<RebateInventoryEntry>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editBrand, setEditBrand] = useState(row.brand);
  const [editSku, setEditSku] = useState(row.sku);
  const [editUnitsTotal, setEditUnitsTotal] = useState(String(row.unitsTotal));
  const [editNotes, setEditNotes] = useState(row.notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isEditing) {
      setEditBrand(row.brand);
      setEditSku(row.sku);
      setEditUnitsTotal(String(row.unitsTotal));
      setEditNotes(row.notes ?? "");
    }
  }, [isEditing, row]);

  const remaining = row.unitsTotal - row.unitsDeployed;

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={onStartEdit}
        className="w-full text-left rounded-xl border border-rule bg-white px-4 py-3 hover:bg-rule-soft/50 transition"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-ink">{row.brand}</span>
              <span className="text-[11px] text-ink-soft font-mono">
                {row.sku}
              </span>
              {row.kind === "documented" && row.programName && (
                <span className="inline-flex items-center rounded-full bg-emerald-soft text-emerald-ink px-2 py-0.5 text-[10px] font-medium">
                  {row.programName}
                  {row.programPeriod ? ` · ${row.programPeriod}` : ""}
                </span>
              )}
            </div>
            <div className="text-[11px] text-ink-soft mt-1 flex items-center gap-2 flex-wrap">
              <span>
                <span className="font-semibold text-emerald-ink">
                  {remaining}
                </span>
                {" of "}
                {row.unitsTotal}
                {" units available"}
                {row.unitsDeployed > 0 ? ` · ${row.unitsDeployed} deployed` : ""}
              </span>
              {row.kind === "documented" && row.earnedDate && (
                <span>· earned {row.earnedDate}</span>
              )}
              {row.kind === "documented" && row.expiresDate && (
                <span>· expires {row.expiresDate}</span>
              )}
            </div>
            {row.notes && (
              <div className="text-[11px] text-ink-soft mt-1 line-clamp-2">
                {row.notes}
              </div>
            )}
          </div>
          <Pencil className="h-3.5 w-3.5 text-ink-faint shrink-0 mt-1" />
        </div>
      </button>
    );
  }

  return (
    <form
      className="rounded-xl border border-emerald/40 bg-emerald-soft/20 p-4 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const next = parseInt(editUnitsTotal, 10);
        if (!Number.isFinite(next) || next < 0) {
          toast.error("Units must be a non-negative number.");
          return;
        }
        setSaving(true);
        try {
          await onUpdate({
            brand: editBrand.trim() || row.brand,
            sku: editSku.trim() || row.sku,
            unitsTotal: next,
            notes: editNotes.trim() || null,
          });
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label="Brand">
          <input
            type="text"
            value={editBrand}
            onChange={(e) => setEditBrand(e.target.value)}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            maxLength={100}
            required
          />
        </FormField>
        <FormField label="SKU / product code">
          <input
            type="text"
            value={editSku}
            onChange={(e) => setEditSku(e.target.value)}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            maxLength={100}
            required
          />
        </FormField>
        <FormField label="Units total">
          <input
            type="number"
            min={row.unitsDeployed}
            max={10000}
            value={editUnitsTotal}
            onChange={(e) => setEditUnitsTotal(e.target.value)}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            required
          />
          {row.unitsDeployed > 0 && (
            <p className="text-[10px] text-ink-soft mt-1">
              Can't be less than {row.unitsDeployed} (already deployed).
            </p>
          )}
        </FormField>
        <FormField label="Notes">
          <input
            type="text"
            value={editNotes}
            onChange={(e) => setEditNotes(e.target.value)}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            maxLength={2000}
            placeholder="Optional context for yourself"
          />
        </FormField>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose/40 bg-white px-3 py-1.5 text-xs font-medium text-rose hover:bg-rose-soft transition"
        >
          <Trash2 className="h-3 w-3" />
          Delete entry
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancelEdit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-ink transition"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-xs font-semibold text-paper hover:opacity-90 transition disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            Save
          </button>
        </div>
      </div>
    </form>
  );
}

// ─── Add forms ────────────────────────────────────────────────────────────

function DocumentedForm({
  draft,
  setDraft,
  busy,
  onSubmit,
  onCancel,
}: {
  draft: DocumentedDraft;
  setDraft: (d: DocumentedDraft) => void;
  busy: boolean;
  onSubmit: (e: FormEvent) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border border-emerald/40 bg-emerald-soft/20 p-4 space-y-3"
    >
      <header className="flex items-center gap-2 text-sm font-semibold text-emerald-ink">
        <FileCheck2 className="h-4 w-4" />
        Add portal-issued inventory
      </header>
      <p className="text-xs text-ink-soft">
        From a manufacturer portal (Alle for Business, Allergan APP, Galderma
        Aspire, Evolus official promo, etc.) — capture program + period so the
        provenance is on record.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label="Manufacturer">
          <select
            value={draft.manufacturer}
            onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            required
          >
            {MANUFACTURER_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Program name">
          <input
            type="text"
            value={draft.programName}
            onChange={(e) => setDraft({ ...draft, programName: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            placeholder="e.g. Allergan APP Q1 / Galderma Aspire"
            required
          />
        </FormField>
        <FormField label="Program period">
          <input
            type="text"
            value={draft.programPeriod}
            onChange={(e) => setDraft({ ...draft, programPeriod: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            placeholder="e.g. 2026 Q1"
            required
          />
        </FormField>
        <FormField label="Source reference (optional)">
          <input
            type="text"
            value={draft.sourceRef}
            onChange={(e) => setDraft({ ...draft, sourceRef: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            placeholder="e.g. portal screenshot date / email subject"
          />
        </FormField>
        <FormField label="Brand">
          <input
            type="text"
            value={draft.brand}
            onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            placeholder="e.g. Botox / Juvederm Voluma"
            required
          />
        </FormField>
        <FormField label="SKU / product code">
          <input
            type="text"
            value={draft.sku}
            onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            placeholder="e.g. Voluma-1ml-syringe"
            required
          />
        </FormField>
        <FormField label="Units earned">
          <input
            type="number"
            min={0}
            max={10000}
            value={draft.unitsTotal}
            onChange={(e) => setDraft({ ...draft, unitsTotal: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            required
          />
        </FormField>
        <FormField label="Earned date">
          <input
            type="date"
            value={draft.earnedDate}
            onChange={(e) => setDraft({ ...draft, earnedDate: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            required
          />
        </FormField>
        <FormField label="Expires (optional)">
          <input
            type="date"
            value={draft.expiresDate}
            onChange={(e) => setDraft({ ...draft, expiresDate: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
          />
        </FormField>
        <FormField label="Notes (optional)">
          <input
            type="text"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            maxLength={2000}
            placeholder="Any context you want to remember"
          />
        </FormField>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-ink transition"
        >
          <X className="h-3 w-3" />
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-1.5 text-xs font-semibold text-paper hover:opacity-90 transition disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ArrowRight className="h-3 w-3" />
          )}
          Add to pool
        </button>
      </div>
    </form>
  );
}

function AnonymousForm({
  draft,
  setDraft,
  busy,
  onSubmit,
  onCancel,
}: {
  draft: AnonymousDraft;
  setDraft: (d: AnonymousDraft) => void;
  busy: boolean;
  onSubmit: (e: FormEvent) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border border-rule bg-white p-4 space-y-3"
    >
      <header className="flex items-center gap-2 text-sm font-semibold text-ink">
        <ShieldOff className="h-4 w-4" />
        Add promo/samples inventory
      </header>
      <p className="text-xs text-ink-soft">
        Product you have available to deploy. No source recorded — just brand +
        SKU + units. Use this for inventory whose origin you'd rather not
        document.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label="Brand">
          <input
            type="text"
            value={draft.brand}
            onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            placeholder="e.g. Juvederm Voluma"
            required
          />
        </FormField>
        <FormField label="SKU / product code">
          <input
            type="text"
            value={draft.sku}
            onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            placeholder="e.g. Voluma-1ml-syringe"
            required
          />
        </FormField>
        <FormField label="Units">
          <input
            type="number"
            min={0}
            max={10000}
            value={draft.unitsTotal}
            onChange={(e) => setDraft({ ...draft, unitsTotal: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            required
          />
        </FormField>
        <FormField label="Notes (optional)">
          <input
            type="text"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            className="w-full rounded-lg border border-rule bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            maxLength={2000}
            placeholder="Anything you want to remember"
          />
        </FormField>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-ink transition"
        >
          <X className="h-3 w-3" />
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-1.5 text-xs font-semibold text-paper hover:opacity-90 transition disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Package className="h-3 w-3" />
          )}
          Add to pool
        </button>
      </div>
    </form>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1 block">
        {label}
      </span>
      {children}
    </label>
  );
}
