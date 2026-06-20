/**
 * /app/admin/canonical-brands — Admin CRUD for the system-wide canonical
 * brand registry (v1.30.0). Admin-only (requireAdmin server-side gate).
 *
 * Karen and other spa owners read from this registry via the catalog CSV
 * import + recategorize sweep. Adding a new brand here propagates to
 * every spa instantly — cross-tenant intelligence flywheel.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Beaker,
  Loader2,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  createCanonicalBrandFn,
  deleteCanonicalBrandFn,
  listCanonicalBrandsFn,
  updateCanonicalBrandFn,
  type CanonicalBrand,
  type ProductManufacturer,
  type ProductUnitType,
} from "@/server/refill-catalog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/admin/canonical-brands")({
  component: CanonicalBrandsPage,
});

type CategoryValue = "tox" | "filler" | "biostimulator" | "laser" | "facial" | "skincare" | "other";

const CATEGORY_OPTIONS: Array<{ value: CategoryValue; label: string }> = [
  { value: "tox", label: "Tox" },
  { value: "filler", label: "Filler" },
  { value: "biostimulator", label: "Biostimulator" },
  { value: "laser", label: "Laser" },
  { value: "facial", label: "Facial" },
  { value: "skincare", label: "Skincare" },
  { value: "other", label: "Other" },
];

const UNIT_OPTIONS: Array<{ value: ProductUnitType; label: string }> = [
  { value: "vial", label: "Vial" },
  { value: "syringe", label: "Syringe" },
  { value: "bottle", label: "Bottle" },
  { value: "session", label: "Session" },
  { value: "other", label: "Other" },
];

const MANUFACTURER_OPTIONS: Array<{ value: ProductManufacturer; label: string }> = [
  { value: "abbvie", label: "AbbVie (formerly Allergan)" },
  { value: "galderma", label: "Galderma" },
  { value: "evolus", label: "Evolus" },
  { value: "merz", label: "Merz" },
  { value: "revance", label: "Revance" },
  { value: "rha", label: "RHA Collection" },
  { value: "sciton", label: "Sciton" },
  { value: "skinceuticals", label: "SkinCeuticals" },
  { value: "eltamd", label: "EltaMD" },
  { value: "neocutis", label: "Neocutis" },
  { value: "obagi", label: "Obagi" },
  { value: "abbvie-coolsculpting", label: "AbbVie / CoolSculpting" },
  { value: "generic", label: "Generic" },
  { value: "in_house", label: "In-house" },
];

type BrandDraft = {
  displayName: string;
  aliases: string; // comma-separated for UI
  category: CategoryValue;
  manufacturer: ProductManufacturer | "";
  unitType: ProductUnitType;
  notes: string;
  subcategoryArea: string;
  subcategoryFamily: string;
};

const EMPTY_DRAFT: BrandDraft = {
  displayName: "",
  aliases: "",
  category: "tox",
  manufacturer: "",
  unitType: "vial",
  notes: "",
  subcategoryArea: "",
  subcategoryFamily: "",
};

function brandToDraft(b: CanonicalBrand): BrandDraft {
  return {
    displayName: b.displayName,
    aliases: b.aliases.join(", "),
    category: b.category as CategoryValue,
    manufacturer: b.manufacturer ?? "",
    unitType: b.unitType,
    notes: b.notes ?? "",
    subcategoryArea: b.subcategoryArea ?? "",
    subcategoryFamily: b.subcategoryFamily ?? "",
  };
}

function draftToPayload(d: BrandDraft) {
  if (!d.displayName.trim()) throw new Error("Display name is required.");
  const aliases = d.aliases
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  return {
    displayName: d.displayName.trim(),
    aliases,
    category: d.category,
    manufacturer: d.manufacturer === "" ? null : (d.manufacturer as ProductManufacturer),
    unitType: d.unitType,
    notes: d.notes.trim() ? d.notes.trim() : null,
    subcategoryArea: d.subcategoryArea.trim() ? d.subcategoryArea.trim() : null,
    subcategoryFamily: d.subcategoryFamily.trim() ? d.subcategoryFamily.trim() : null,
  };
}

function categoryLabel(c: string): string {
  return CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c;
}

function manufacturerLabel(m: ProductManufacturer | null): string {
  if (!m) return "Unspecified";
  return MANUFACTURER_OPTIONS.find((o) => o.value === m)?.label ?? m;
}

function CanonicalBrandsPage() {
  const [loading, setLoading] = useState(true);
  const [brands, setBrands] = useState<CanonicalBrand[]>([]);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<BrandDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<BrandDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const rows = await listCanonicalBrandsFn({ data: { accessToken: token } });
        if (!cancelled) setBrands(rows);
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Couldn't load brands.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return brands;
    return brands.filter((b) => {
      if (b.displayName.toLowerCase().includes(q)) return true;
      return b.aliases.some((a) => a.toLowerCase().includes(q));
    });
  }, [brands, search]);

  const byCategory = useMemo(() => {
    const groups = new Map<string, CanonicalBrand[]>();
    for (const b of filtered) {
      const arr = groups.get(b.category) ?? [];
      arr.push(b);
      groups.set(b.category, arr);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    return groups;
  }, [filtered]);

  async function withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) throw new Error("Not signed in.");
    return fn(token);
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const payload = draftToPayload(addDraft);
      const created = await withToken((token) =>
        createCanonicalBrandFn({ data: { accessToken: token, brand: payload } }),
      );
      setBrands((prev) => [...prev, created]);
      setAddDraft(EMPTY_DRAFT);
      setAdding(false);
      toast.success(`Added ${created.displayName}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add brand.");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveEdit(e: FormEvent, id: string) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const payload = draftToPayload(editDraft);
      const updated = await withToken((token) =>
        updateCanonicalBrandFn({ data: { accessToken: token, id, brand: payload } }),
      );
      setBrands((prev) => prev.map((b) => (b.id === id ? updated : b)));
      setEditingId(null);
      toast.success(`Saved ${updated.displayName}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save brand.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(b: CanonicalBrand) {
    if (!confirm(`Delete ${b.displayName}? This affects every tenant's recategorize lookup.`)) return;
    if (busy) return;
    setBusy(true);
    try {
      await withToken((token) =>
        deleteCanonicalBrandFn({ data: { accessToken: token, id: b.id } }),
      );
      setBrands((prev) => prev.filter((row) => row.id !== b.id));
      toast.success(`Deleted ${b.displayName}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete brand.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(b: CanonicalBrand) {
    setEditingId(b.id);
    setEditDraft(brandToDraft(b));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(EMPTY_DRAFT);
  }

  return (
    <div>
      <PageHeader
        title="Canonical brand registry"
        description="System-wide aesthetics-industry brand reference. CSV imports + recategorize sweeps match service names against display name + aliases. Adding a brand here propagates to every tenant. Admin-only."
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/admin"
              className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft hover:text-ink transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Admin home
            </Link>
            {!adding && (
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                  setAddDraft(EMPTY_DRAFT);
                }}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
              >
                <Plus className="h-4 w-4" />
                Add brand
              </button>
            )}
          </div>
        }
      />

      <div className="px-6 lg:px-10 py-6 max-w-5xl space-y-6">
        <div className="rounded-xl border border-rule bg-white px-4 py-3 flex items-center gap-3">
          <span className="text-[13px] text-ink-soft">
            <span className="font-semibold text-ink tabular-nums">{brands.length}</span> brands
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search brand or alias…"
            className="flex-1 rounded-md border border-rule bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-1 focus:ring-emerald/30"
          />
          {search && (
            <span className="text-[12px] text-ink-soft tabular-nums">
              {filtered.length} match{filtered.length === 1 ? "" : "es"}
            </span>
          )}
        </div>

        {adding && (
          <BrandFormCard
            mode="add"
            draft={addDraft}
            onChange={setAddDraft}
            onSubmit={onAdd}
            onCancel={() => {
              setAdding(false);
              setAddDraft(EMPTY_DRAFT);
            }}
            busy={busy}
          />
        )}

        {loading ? (
          <div className="rounded-xl border border-rule bg-white px-5 py-8 text-center">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-ink-soft" />
            <p className="mt-2 text-[13px] text-ink-soft">Loading registry&hellip;</p>
          </div>
        ) : (
          <>
            {Array.from(byCategory.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([cat, rows]) => (
                <section key={cat} className="space-y-2.5">
                  <h2 className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-emerald" />
                    {categoryLabel(cat)}
                    <span className="text-ink-soft">· {rows.length}</span>
                  </h2>
                  <ul className="space-y-2">
                    {rows.map((b) =>
                      editingId === b.id ? (
                        <BrandFormCard
                          key={b.id}
                          mode="edit"
                          draft={editDraft}
                          onChange={setEditDraft}
                          onSubmit={(e) => onSaveEdit(e, b.id)}
                          onCancel={cancelEdit}
                          onDelete={() => onDelete(b)}
                          busy={busy}
                        />
                      ) : (
                        <BrandRow
                          key={b.id}
                          brand={b}
                          onEdit={() => startEdit(b)}
                        />
                      ),
                    )}
                  </ul>
                </section>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

function BrandRow({ brand, onEdit }: { brand: CanonicalBrand; onEdit: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onEdit}
        className="w-full text-left rounded-xl border border-rule bg-white px-5 py-3.5 hover:border-emerald/40 hover:shadow-sm transition group"
      >
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[15px] font-semibold text-ink">{brand.displayName}</span>
              {brand.manufacturer && (
                <span className="text-[11px] text-ink-soft bg-bg-soft rounded-full px-2 py-0.5">
                  {manufacturerLabel(brand.manufacturer)}
                </span>
              )}
              <span className="text-[11px] text-ink-soft bg-bg-soft rounded-full px-2 py-0.5">
                {brand.unitType}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {brand.aliases.map((a) => (
                <span
                  key={a}
                  className="text-[11px] text-ink-soft bg-bg-soft rounded px-1.5 py-0.5 font-mono"
                >
                  {a}
                </span>
              ))}
            </div>
            {brand.notes && (
              <p className="mt-1 text-[12px] text-ink-soft leading-snug italic">{brand.notes}</p>
            )}
          </div>
          <Pencil className="h-4 w-4 text-ink-faint group-hover:text-emerald shrink-0 mt-1" />
        </div>
      </button>
    </li>
  );
}

function BrandFormCard({
  mode,
  draft,
  onChange,
  onSubmit,
  onCancel,
  onDelete,
  busy,
}: {
  mode: "add" | "edit";
  draft: BrandDraft;
  onChange: (d: BrandDraft) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
  onDelete?: () => void;
  busy: boolean;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border-2 border-emerald/30 bg-white px-5 py-5 space-y-4 shadow-sm"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Display name">
          <input
            type="text"
            value={draft.displayName}
            onChange={(e) => onChange({ ...draft, displayName: e.target.value })}
            placeholder="e.g. Restylane Refyne"
            disabled={busy}
            autoFocus={mode === "add"}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          />
        </FormField>

        <FormField label="Manufacturer">
          <select
            value={draft.manufacturer}
            onChange={(e) =>
              onChange({ ...draft, manufacturer: e.target.value as ProductManufacturer | "" })
            }
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          >
            <option value="">Unspecified</option>
            {MANUFACTURER_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Category">
          <select
            value={draft.category}
            onChange={(e) => onChange({ ...draft, category: e.target.value as CategoryValue })}
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Unit type">
          <select
            value={draft.unitType}
            onChange={(e) => onChange({ ...draft, unitType: e.target.value as ProductUnitType })}
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <FormField label="Aliases (comma-separated)">
        <input
          type="text"
          value={draft.aliases}
          onChange={(e) => onChange({ ...draft, aliases: e.target.value })}
          placeholder="Refyne, Restylane Refyne, Restylane-Refyne"
          disabled={busy}
          className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
        />
        <p className="text-[11px] text-ink-soft mt-1 leading-snug">
          Name variants the parser will match against. Include the display name itself plus common abbreviations / typos.
        </p>
      </FormField>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Sub-category — area (optional)">
          <input
            type="text"
            value={draft.subcategoryArea}
            onChange={(e) => onChange({ ...draft, subcategoryArea: e.target.value })}
            placeholder="e.g. cheek, lip, jawline"
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          />
          <p className="text-[11px] text-ink-soft mt-1 leading-snug">
            Primary substitution group. Products inherit this on Recategorize (blanks only).
          </p>
        </FormField>
        <FormField label="Sub-category — family (optional)">
          <input
            type="text"
            value={draft.subcategoryFamily}
            onChange={(e) => onChange({ ...draft, subcategoryFamily: e.target.value })}
            placeholder="e.g. Voluma-class, Volbella-class"
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          />
        </FormField>
      </div>

      <FormField label="Notes (optional)">
        <input
          type="text"
          value={draft.notes}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          placeholder="Anything that helps future admins"
          disabled={busy}
          className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
        />
      </FormField>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition",
            busy
              ? "bg-rule text-ink-faint cursor-not-allowed"
              : "bg-emerald text-paper hover:opacity-95",
          )}
        >
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving&hellip;
            </>
          ) : (
            <>
              <Save className="h-4 w-4" />
              {mode === "add" ? "Add brand" : "Save changes"}
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft hover:text-ink transition"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </button>
        {mode === "edit" && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 text-[13px] text-red-600 hover:text-red-700 transition"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
        {label}
      </label>
      {children}
    </div>
  );
}
