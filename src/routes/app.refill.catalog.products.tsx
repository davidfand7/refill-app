/**
 * /app/refill/catalog/products — Products CRUD surface (v1.29.1).
 *
 * The first UI on top of the v1.29.0 schema. Karen (or Grasshopper running
 * the business half of Rejuv per project_karen_identity.md) enters per-
 * product cost / sales price / manufacturer. Auto-displays margin per unit
 * and margin %. Unblocks margin-aware scoring in the broader Profitability
 * Engine (factor #1 of 17) and brand-affinity routing in the Recognition
 * Allocation Engine.
 *
 * UX: one card per product; inline add-form expander at top; click any card
 * to edit in place. Empty state guides to "Add your first product". Mobile-
 * responsive — Karen on her phone is the design target.
 *
 * Deep-link only at v1.29.0 per project_refill_trojan_horse_thesis — the
 * 5-chip RefillNav stays narrow. /app/refill/catalog (no trailing path)
 * is unrouted by design at v1.29.1; v1.29.2 ships Services alongside.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  Beaker,
  Loader2,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  createProductFn,
  deleteProductFn,
  listProductsFn,
  updateProductFn,
  type Product,
  type ProductCategory,
  type ProductManufacturer,
  type ProductUnitType,
} from "@/server/refill-catalog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/catalog/products")({
  component: ProductsPage,
});

const CATEGORY_OPTIONS: Array<{ value: ProductCategory; label: string }> = [
  { value: "tox", label: "Tox" },
  { value: "filler", label: "Filler" },
  { value: "laser_consumable", label: "Laser consumable" },
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
  { value: "revance", label: "Revance (Daxxify)" },
  { value: "rha", label: "RHA Collection" },
  { value: "sciton", label: "Sciton" },
  { value: "abbvie-coolsculpting", label: "AbbVie / CoolSculpting" },
  { value: "skinceuticals", label: "SkinCeuticals" },
  { value: "eltamd", label: "EltaMD" },
  { value: "neocutis", label: "Neocutis" },
  { value: "obagi", label: "Obagi" },
  { value: "generic", label: "Generic" },
  { value: "in_house", label: "In-house" },
];

type ProductDraft = {
  brand: string;
  category: ProductCategory;
  unitType: ProductUnitType;
  costPerUnit: string;
  salesPricePerUnit: string;
  manufacturer: ProductManufacturer | "";
  notes: string;
};

const EMPTY_DRAFT: ProductDraft = {
  brand: "",
  category: "tox",
  unitType: "vial",
  costPerUnit: "",
  salesPricePerUnit: "",
  manufacturer: "",
  notes: "",
};

function productToDraft(p: Product): ProductDraft {
  return {
    brand: p.brand,
    category: p.category,
    unitType: p.unitType,
    costPerUnit: String(p.costPerUnit),
    salesPricePerUnit: String(p.salesPricePerUnit),
    manufacturer: p.manufacturer ?? "",
    notes: p.notes ?? "",
  };
}

function draftToPayload(d: ProductDraft) {
  const cost = Number.parseFloat(d.costPerUnit);
  const price = Number.parseFloat(d.salesPricePerUnit);
  if (!d.brand.trim()) throw new Error("Brand is required.");
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Cost must be a non-negative number.");
  if (!Number.isFinite(price) || price < 0) throw new Error("Price must be a non-negative number.");
  return {
    brand: d.brand.trim(),
    category: d.category,
    unitType: d.unitType,
    costPerUnit: cost,
    salesPricePerUnit: price,
    manufacturer: d.manufacturer === "" ? null : (d.manufacturer as ProductManufacturer),
    notes: d.notes.trim() ? d.notes.trim() : null,
  };
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPct(n: number | null): string {
  if (n === null) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function categoryLabel(c: ProductCategory): string {
  return CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c;
}

function unitLabel(u: ProductUnitType): string {
  return UNIT_OPTIONS.find((o) => o.value === u)?.label ?? u;
}

function manufacturerLabel(m: ProductManufacturer | null): string {
  if (!m) return "Unspecified";
  return MANUFACTURER_OPTIONS.find((o) => o.value === m)?.label ?? m;
}

function ProductsPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<ProductDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ProductDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const rows = await listProductsFn({
          data: { accessToken: token, viewAsUserId },
        });
        if (!cancelled) setProducts(rows);
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Couldn't load products.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  // v1.34.9: category filter chips. Multi-select, union semantics —
  // empty set = show all.
  const [categoryFilter, setCategoryFilter] = useState<Set<ProductCategory>>(
    new Set(),
  );

  function toggleCategory(c: ProductCategory) {
    setCategoryFilter((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  const categoryCounts = useMemo(() => {
    const counts = new Map<ProductCategory, number>();
    for (const p of products) {
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    return counts;
  }, [products]);

  const filteredProducts = useMemo(() => {
    if (categoryFilter.size === 0) return products;
    return products.filter((p) => categoryFilter.has(p.category));
  }, [products, categoryFilter]);

  const byCategory = useMemo(() => {
    const groups = new Map<ProductCategory, Product[]>();
    for (const p of filteredProducts) {
      const arr = groups.get(p.category) ?? [];
      arr.push(p);
      groups.set(p.category, arr);
    }
    return groups;
  }, [filteredProducts]);

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
        createProductFn({
          data: { accessToken: token, viewAsUserId, product: payload },
        }),
      );
      setProducts((prev) => [...prev, created]);
      setAddDraft(EMPTY_DRAFT);
      setAdding(false);
      toast.success(`Added ${created.brand}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add product.");
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
        updateProductFn({
          data: { accessToken: token, viewAsUserId, id, product: payload },
        }),
      );
      setProducts((prev) => prev.map((p) => (p.id === id ? updated : p)));
      setEditingId(null);
      toast.success(`Saved ${updated.brand}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save product.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(p: Product) {
    if (!confirm(`Delete ${p.brand}? This can't be undone.`)) return;
    if (busy) return;
    setBusy(true);
    try {
      await withToken((token) =>
        deleteProductFn({
          data: { accessToken: token, viewAsUserId, id: p.id },
        }),
      );
      setProducts((prev) => prev.filter((row) => row.id !== p.id));
      toast.success(`Deleted ${p.brand}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete product.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(p: Product) {
    setEditingId(p.id);
    setEditDraft(productToDraft(p));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(EMPTY_DRAFT);
  }

  return (
    <div>
      <PageHeader
        title="Product catalog"
        description="Per-product cost, sales price, margin, and manufacturer. Powers margin-aware patient profitability scoring + manufacturer-rebate routing for the Recognition Allocation Engine. Add the products you actually buy and resell; rough estimates are fine — refine as you go."
        actions={
          !adding && (
            <div className="flex items-center gap-2">
              <Link
                to="/app/refill/catalog/import"
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 text-[13px] font-semibold text-ink-soft hover:text-ink hover:border-emerald/40 transition"
              >
                <Upload className="h-3.5 w-3.5" />
                Import CSV
              </Link>
              <button
              type="button"
              onClick={() => {
                setAdding(true);
                setAddDraft(EMPTY_DRAFT);
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
            >
              <Plus className="h-4 w-4" />
              Add product
            </button>
            </div>
          )
        }
      />

      <div className="border-b border-rule bg-paper/50">
        <div className="max-w-5xl mx-auto px-4 lg:px-10 flex items-center gap-1">
          <Link
            to="/app/refill/catalog/products"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-emerald text-emerald-ink transition"
          >
            Products
          </Link>
          <Link
            to="/app/refill/catalog/services"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Services
          </Link>
        </div>
      </div>

      <div className="px-6 lg:px-10 py-6 max-w-4xl space-y-6">
        {/* v1.34.9: category filter chips */}
        {products.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-faint">
              Filter
            </span>
            {(["tox", "filler", "laser_consumable", "skincare", "other"] as ProductCategory[]).map((c) => {
              const count = categoryCounts.get(c) ?? 0;
              if (count === 0) return null;
              const active = categoryFilter.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCategory(c)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border transition",
                    active
                      ? "border-emerald bg-emerald-soft text-emerald-ink"
                      : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink",
                  )}
                >
                  {categoryLabel(c)}
                  <span className={cn(active ? "text-emerald-ink" : "text-ink-faint")}>
                    {count}
                  </span>
                </button>
              );
            })}
            {categoryFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setCategoryFilter(new Set())}
                className="text-[11px] text-ink-soft hover:text-rose transition"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {adding && (
          <ProductFormCard
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
            <p className="mt-2 text-[13px] text-ink-soft">Loading catalog&hellip;</p>
          </div>
        ) : products.length === 0 ? (
          !adding && (
            <div className="rounded-xl border border-dashed border-rule bg-white px-6 py-10 text-center">
              <div className="mx-auto inline-flex items-center justify-center rounded-full bg-emerald-soft p-3">
                <Beaker className="h-6 w-6 text-emerald" />
              </div>
              <h3 className="mt-3 text-[17px] font-semibold text-ink">No products yet</h3>
              <p className="mt-1.5 text-[13px] text-ink-soft max-w-md mx-auto leading-relaxed">
                Add the products you buy from manufacturers and resell to patients — Botox vials, filler syringes, skincare bottles. Cost and sales price unlock margin math for the entire Profitability Engine.
              </p>
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                  setAddDraft(EMPTY_DRAFT);
                }}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
              >
                <Plus className="h-4 w-4" />
                Add your first product
              </button>
            </div>
          )
        ) : (
          <>
            {Array.from(byCategory.entries()).map(([cat, rows]) => (
              <section key={cat} className="space-y-3">
                <h2 className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-emerald" />
                  {categoryLabel(cat)}
                  <span className="text-ink-soft">· {rows.length}</span>
                </h2>
                <ul className="space-y-2.5">
                  {rows.map((p) =>
                    editingId === p.id ? (
                      <ProductFormCard
                        key={p.id}
                        mode="edit"
                        draft={editDraft}
                        onChange={setEditDraft}
                        onSubmit={(e) => onSaveEdit(e, p.id)}
                        onCancel={cancelEdit}
                        onDelete={() => onDelete(p)}
                        busy={busy}
                      />
                    ) : (
                      <ProductRow
                        key={p.id}
                        product={p}
                        onEdit={() => startEdit(p)}
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

function ProductRow({ product, onEdit }: { product: Product; onEdit: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onEdit}
        className="w-full text-left rounded-xl border border-rule bg-white px-5 py-4 hover:border-emerald/40 hover:shadow-sm transition group"
      >
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[16px] font-semibold text-ink">{product.brand}</span>
              <span className="text-[11px] text-ink-soft bg-bg-soft rounded-full px-2 py-0.5">
                {unitLabel(product.unitType)}
              </span>
              {product.manufacturer && (
                <span className="text-[11px] text-ink-soft bg-bg-soft rounded-full px-2 py-0.5">
                  {manufacturerLabel(product.manufacturer)}
                </span>
              )}
            </div>
            {product.notes && (
              <p className="mt-1 text-[12px] text-ink-soft leading-snug">{product.notes}</p>
            )}
          </div>
          <div className="text-right tabular-nums shrink-0">
            <div className="text-[13px] text-ink-soft">
              {fmtUsd(product.salesPricePerUnit)} sell &middot; {fmtUsd(product.costPerUnit)} cost
            </div>
            <div className="text-[15px] font-semibold text-emerald mt-0.5">
              {fmtUsd(product.marginPerUnit)} <span className="text-[12px] text-ink-soft font-normal">({fmtPct(product.marginPct)})</span>
            </div>
          </div>
          <Pencil className="h-4 w-4 text-ink-faint group-hover:text-emerald shrink-0 mt-1" />
        </div>
      </button>
    </li>
  );
}

function ProductFormCard({
  mode,
  draft,
  onChange,
  onSubmit,
  onCancel,
  onDelete,
  busy,
}: {
  mode: "add" | "edit";
  draft: ProductDraft;
  onChange: (d: ProductDraft) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
  onDelete?: () => void;
  busy: boolean;
}) {
  const computedMargin = useMemo(() => {
    const cost = Number.parseFloat(draft.costPerUnit);
    const price = Number.parseFloat(draft.salesPricePerUnit);
    if (!Number.isFinite(cost) || !Number.isFinite(price)) return null;
    const margin = price - cost;
    const pct = price > 0 ? margin / price : null;
    return { margin, pct };
  }, [draft.costPerUnit, draft.salesPricePerUnit]);

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border-2 border-emerald/30 bg-white px-5 py-5 space-y-4 shadow-sm"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Brand / product name">
          <input
            type="text"
            value={draft.brand}
            onChange={(e) => onChange({ ...draft, brand: e.target.value })}
            placeholder="e.g. Botox 100u vial"
            disabled={busy}
            autoFocus={mode === "add"}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          />
        </FormField>

        <FormField label="Manufacturer">
          <select
            value={draft.manufacturer}
            onChange={(e) =>
              onChange({
                ...draft,
                manufacturer: e.target.value as ProductManufacturer | "",
              })
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
            onChange={(e) =>
              onChange({ ...draft, category: e.target.value as ProductCategory })
            }
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
            onChange={(e) =>
              onChange({ ...draft, unitType: e.target.value as ProductUnitType })
            }
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

        <FormField label="Sales price per unit ($)">
          <input
            type="number"
            step="0.01"
            min="0"
            value={draft.salesPricePerUnit}
            onChange={(e) =>
              onChange({ ...draft, salesPricePerUnit: e.target.value })
            }
            placeholder="0.00"
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
          />
        </FormField>

        <FormField label="Cost per unit ($)">
          <input
            type="number"
            step="0.01"
            min="0"
            value={draft.costPerUnit}
            onChange={(e) => onChange({ ...draft, costPerUnit: e.target.value })}
            placeholder="0.00"
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
          />
        </FormField>
      </div>

      <FormField label="Notes (optional)">
        <input
          type="text"
          value={draft.notes}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          placeholder="Lot tracking, vendor contact, anything useful"
          disabled={busy}
          className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
        />
      </FormField>

      {computedMargin && (
        <div className="rounded-md bg-emerald-soft px-3 py-2 text-[13px] text-ink">
          <span className="font-semibold">Margin per unit:</span>{" "}
          <span className="tabular-nums">
            {fmtUsd(computedMargin.margin)}
            {computedMargin.pct !== null && (
              <span className="text-ink-soft"> ({fmtPct(computedMargin.pct)})</span>
            )}
          </span>
        </div>
      )}

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
              {mode === "add" ? "Add product" : "Save changes"}
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

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
        {label}
      </label>
      {children}
    </div>
  );
}
