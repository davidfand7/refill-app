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
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  Beaker,
  CheckCircle2,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  createProductFn,
  deleteProductFn,
  listProductsFn,
  reorderProductsFn,
  recategorizeProductsFromBrandsFn,
  setProductHiddenFn,
  type RecategorizeProductsReceipt,
  updateProductFn,
  type Product,
  type ProductCategory,
  type ProductManufacturer,
  type ProductUnitType,
} from "@/server/refill-catalog";
import { cn } from "@/lib/utils";
import { getCategoryOrderFn } from "@/server/scheduling-settings.functions";
import { orderedCategoryRank } from "@/lib/service-categories";
import { PRODUCT_SUBCATEGORIES, parseSubcategories, toggleSubcategory } from "@/lib/product-subcategories";

export const Route = createFileRoute("/app/refill/catalog/products")({
  component: ProductsPage,
});

const CATEGORY_OPTIONS: Array<{ value: ProductCategory; label: string }> = [
  { value: "tox", label: "Tox" },
  { value: "filler", label: "Filler" },
  { value: "laser_consumable", label: "Laser consumable" },
  { value: "facial", label: "Facial" },
  { value: "skincare", label: "Skincare" },
  { value: "other", label: "Other" },
  // 'biostimulator' is retired as a top-level category (now Filler + a
  // "Biostim" sub-category); kept in the type for any legacy row not yet swept.
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
  subcategoryArea: string;
  subcategoryFamily: string;
};

const EMPTY_DRAFT: ProductDraft = {
  brand: "",
  category: "tox",
  unitType: "vial",
  costPerUnit: "",
  salesPricePerUnit: "",
  manufacturer: "",
  notes: "",
  subcategoryArea: "",
  subcategoryFamily: "",
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
    subcategoryArea: p.subcategoryArea ?? "",
    subcategoryFamily: p.subcategoryFamily ?? "",
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
    subcategoryArea: d.subcategoryArea.trim() ? d.subcategoryArea.trim() : null,
    subcategoryFamily: d.subcategoryFamily.trim() ? d.subcategoryFamily.trim() : null,
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
  // v1.34.9.1: show hidden rows. Default false.
  const [showHidden, setShowHidden] = useState(false);
  // v1.34.9.2: products recategorize from canonical brand registry
  const [recategorizing, setRecategorizing] = useState(false);
  const [lastRecategorize, setLastRecategorize] = useState<
    | { ok: true; receipt: RecategorizeProductsReceipt; at: string }
    | { ok: false; message: string; at: string }
    | null
  >(null);
  // v2.119.0: tenant category order — SHARED with Services + Bookable so all
  // three present categories in the same sequence.
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);

  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const [rows, catOrder] = await Promise.all([
          listProductsFn({
            data: { accessToken: token, viewAsUserId, includeHidden: showHidden },
          }),
          getCategoryOrderFn({ data: { accessToken: token, viewAsUserId } }).catch(() => ({ order: [] as string[] })),
        ]);
        if (!cancelled) {
          setProducts(rows);
          setCategoryOrder(catOrder.order);
        }
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
  }, [membership.status, viewAsUserId, showHidden]);

  async function onRecategorize() {
    if (recategorizing) return;
    setRecategorizing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const result = await recategorizeProductsFromBrandsFn({
        data: { accessToken: token, viewAsUserId },
      });
      setLastRecategorize({
        ok: true,
        receipt: result,
        at: new Date().toLocaleTimeString(),
      });
      if (result.recategorized === 0) {
        toast.success(
          result.unmatched === 0
            ? `Scanned ${result.scanned} — all categorized correctly.`
            : `Scanned ${result.scanned} — ${result.unmatched} unmatched, no changes.`,
          { duration: 8000 },
        );
      } else {
        toast.success(
          `Re-categorized ${result.recategorized} of ${result.scanned}. ${result.unmatched} still unmatched.`,
          { duration: 8000 },
        );
        const fresh = await listProductsFn({
          data: { accessToken: token, viewAsUserId, includeHidden: showHidden },
        });
        setProducts(fresh);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't re-categorize.";
      setLastRecategorize({
        ok: false,
        message,
        at: new Date().toLocaleTimeString(),
      });
      toast.error(message, { duration: 10000 });
    } finally {
      setRecategorizing(false);
    }
  }

  async function onToggleHidden(p: Product) {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const updated = await setProductHiddenFn({
        data: {
          accessToken: token,
          viewAsUserId,
          id: p.id,
          hidden: p.hiddenAt === null,
        },
      });
      setProducts((prev) =>
        showHidden
          ? prev.map((x) => (x.id === p.id ? updated : x))
          : prev.filter((x) => x.id !== p.id),
      );
      toast.success(p.hiddenAt === null ? `${p.brand} hidden.` : `${p.brand} unhidden.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update.");
    }
  }

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
    // Honor the manual order within each category (lower sort_order first;
    // ties / unset fall back to brand-alpha). Mirrors the services list.
    for (const arr of groups.values()) {
      arr.sort(
        (a, b) =>
          (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.brand.localeCompare(b.brand),
      );
    }
    return groups;
  }, [filteredProducts]);

  // Drag-to-reorder within a category (mirrors onReorderServiceCat).
  const draggedProductId = useRef<string | null>(null);
  async function onReorderProductCat(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const dragged = products.find((p) => p.id === draggedId);
    const target = products.find((p) => p.id === targetId);
    if (!dragged || !target || dragged.category !== target.category) return;
    const cat = target.category;
    const ids = products
      .filter((p) => p.category === cat)
      .sort(
        (a, b) =>
          (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.brand.localeCompare(b.brand),
      )
      .map((p) => p.id)
      .filter((id) => id !== draggedId);
    const tIdx = ids.indexOf(targetId);
    ids.splice(tIdx < 0 ? ids.length : tIdx, 0, draggedId);
    const pos = new Map(ids.map((id, i) => [id, i]));
    const prev = products;
    setProducts((cur) => cur.map((p) => (pos.has(p.id) ? { ...p, sortOrder: pos.get(p.id)! } : p)));
    try {
      await withToken((token) =>
        reorderProductsFn({ data: { accessToken: token, viewAsUserId, orderedIds: ids } }),
      );
    } catch (err) {
      setProducts(prev);
      toast.error(err instanceof Error ? err.message : "Couldn't save the new order.");
    }
  }

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
              <button
                type="button"
                onClick={onRecategorize}
                disabled={recategorizing || products.length === 0}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 text-[13px] font-semibold transition",
                  recategorizing || products.length === 0
                    ? "text-ink-faint cursor-not-allowed"
                    : "text-ink-soft hover:text-ink hover:border-emerald/40",
                )}
                title="Sweep all products through the canonical brand registry and update category + manufacturer where matched"
              >
                {recategorizing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wand2 className="h-3.5 w-3.5" />
                )}
                Recategorize
              </button>
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
        <div className="max-w-[960px] mx-auto px-4 lg:px-10 flex items-center gap-1">
          <Link
            to="/app/refill/catalog/services"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Services
          </Link>
          <Link
            to="/app/refill/catalog/products"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-emerald text-emerald-ink transition"
          >
            Products
          </Link>
          <Link
            to="/app/refill/catalog/brand-economics"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Brand economics
          </Link>
          <Link
            to="/app/refill/catalog/programs"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Programs &amp; tiers
          </Link>
        </div>
      </div>

      <div className="px-6 lg:px-10 py-6 max-w-[960px] mx-auto space-y-6">
        {/* v1.34.9.2: recategorize receipt banner */}
        {lastRecategorize && (
          <div
            className={cn(
              "rounded-xl border px-5 py-3.5 flex items-start gap-3",
              lastRecategorize.ok
                ? "border-emerald/30 bg-emerald-soft/40"
                : "border-rose/30 bg-rose-soft",
            )}
          >
            {lastRecategorize.ok ? (
              <CheckCircle2 className="h-4 w-4 text-emerald shrink-0 mt-0.5" />
            ) : (
              <X className="h-4 w-4 text-rose shrink-0 mt-0.5" />
            )}
            <div className="flex-1 text-[12px]">
              {lastRecategorize.ok ? (
                <>
                  <div className="font-semibold text-emerald-ink">
                    {lastRecategorize.receipt.recategorized > 0
                      ? `Re-categorized ${lastRecategorize.receipt.recategorized} of ${lastRecategorize.receipt.scanned} products`
                      : `Scanned ${lastRecategorize.receipt.scanned} products — nothing to change`}
                  </div>
                  <div className="text-ink-soft mt-0.5">
                    {lastRecategorize.receipt.unchanged} already correct ·{" "}
                    {lastRecategorize.receipt.unmatched} unmatched (no canonical brand)
                    {" "}· {lastRecategorize.at}
                  </div>
                  {lastRecategorize.receipt.changes.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-emerald-ink hover:underline">
                        Show {lastRecategorize.receipt.changes.length} change{lastRecategorize.receipt.changes.length === 1 ? "" : "s"}
                      </summary>
                      <ul className="mt-2 space-y-1 text-[11px] text-ink-soft">
                        {lastRecategorize.receipt.changes.slice(0, 50).map((c) => (
                          <li key={c.productId}>
                            <strong className="text-ink">{c.brand}</strong> ({c.matchedBrand}):{" "}
                            {c.oldCategory !== c.newCategory && (
                              <span>
                                <code>{c.oldCategory}</code> → <code>{c.newCategory}</code>
                              </span>
                            )}
                            {c.oldCategory !== c.newCategory && c.oldManufacturer !== c.newManufacturer && " · "}
                            {c.oldManufacturer !== c.newManufacturer && (
                              <span>
                                manufacturer <code>{c.oldManufacturer ?? "none"}</code> → <code>{c.newManufacturer ?? "none"}</code>
                              </span>
                            )}
                          </li>
                        ))}
                        {lastRecategorize.receipt.changes.length > 50 && (
                          <li className="text-ink-faint italic">
                            …+{lastRecategorize.receipt.changes.length - 50} more
                          </li>
                        )}
                      </ul>
                    </details>
                  )}
                </>
              ) : (
                <>
                  <div className="font-semibold text-rose">Couldn't re-categorize</div>
                  <div className="text-ink-soft mt-0.5">
                    {lastRecategorize.message} · {lastRecategorize.at}
                  </div>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setLastRecategorize(null)}
              className="text-ink-soft hover:text-ink transition shrink-0"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* v1.34.9: category filter chips */}
        {products.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-faint">
              Filter
            </span>
            {CATEGORY_OPTIONS.map((opt) => opt.value).map((c) => {
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
            <div className="ml-auto">
              <button
                type="button"
                onClick={() => setShowHidden((v) => !v)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border transition",
                  showHidden
                    ? "border-emerald bg-emerald-soft text-emerald-ink"
                    : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink",
                )}
              >
                {showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                {showHidden ? "Showing hidden" : "Show hidden"}
              </button>
            </div>
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
            {Array.from(byCategory.entries())
              .sort(
                ([a], [b]) =>
                  orderedCategoryRank(a, categoryOrder) - orderedCategoryRank(b, categoryOrder) ||
                  categoryLabel(a).localeCompare(categoryLabel(b)),
              )
              .map(([cat, rows]) => (
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
                        onToggleHidden={() => void onToggleHidden(p)}
                        onDragStartRow={() => {
                          draggedProductId.current = p.id;
                        }}
                        onDropRow={() => {
                          if (draggedProductId.current) {
                            void onReorderProductCat(draggedProductId.current, p.id);
                            draggedProductId.current = null;
                          }
                        }}
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

function ProductRow({
  product,
  onEdit,
  onToggleHidden,
  onDragStartRow,
  onDropRow,
}: {
  product: Product;
  onEdit: () => void;
  onToggleHidden: () => void;
  onDragStartRow?: () => void;
  onDropRow?: () => void;
}) {
  const isHidden = product.hiddenAt !== null;
  return (
    <li
      onDragOver={onDropRow ? (e) => e.preventDefault() : undefined}
      onDrop={onDropRow}
    >
      <div
        className={cn(
          "w-full rounded-xl border bg-white px-5 py-4 transition group flex items-start gap-3",
          isHidden
            ? "border-rule/60 opacity-60 hover:opacity-100"
            : "border-rule hover:border-emerald/40 hover:shadow-sm",
        )}
      >
        <button
          type="button"
          draggable
          onDragStart={onDragStartRow}
          className="mt-0.5 cursor-grab active:cursor-grabbing text-ink-faint hover:text-ink"
          title="Drag to reorder within this category"
          aria-label="Drag to reorder"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="flex-1 min-w-0 text-left"
        >
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
            {isHidden && (
              <span className="inline-flex items-center gap-1 rounded-full bg-rule-soft text-ink-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                <EyeOff className="h-2.5 w-2.5" />
                hidden
              </span>
            )}
          </div>
          {product.notes && (
            <p className="mt-1 text-[12px] text-ink-soft leading-snug">{product.notes}</p>
          )}
        </button>
        <div className="text-right tabular-nums shrink-0">
          <div className="text-[13px] text-ink-soft">
            {fmtUsd(product.salesPricePerUnit)} sell &middot; {fmtUsd(product.costPerUnit)} cost
          </div>
          <div className="text-[15px] font-semibold text-emerald mt-0.5">
            {fmtUsd(product.marginPerUnit)} <span className="text-[12px] text-ink-soft font-normal">({fmtPct(product.marginPct)})</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            title="Edit"
            className="inline-flex items-center gap-1 rounded border border-rule bg-white px-2 py-1 text-[11px] font-medium text-ink-soft hover:text-emerald hover:border-emerald/40 transition"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
          <button
            type="button"
            onClick={onToggleHidden}
            title={isHidden ? "Unhide" : "Hide from list"}
            className="inline-flex items-center gap-1 rounded border border-rule bg-white px-2 py-1 text-[11px] font-medium text-ink-soft hover:text-rose hover:border-rose/40 transition"
          >
            {isHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            {isHidden ? "Unhide" : "Hide"}
          </button>
        </div>
      </div>
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
  const unitWord =
    ({ vial: "vial", syringe: "syringe", bottle: "bottle", session: "session" } as Record<string, string>)[
      draft.unitType
    ] ?? "unit";
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

        <div className="sm:col-span-2">
          <FormField label="Sub-categories (optional)">
            <div className="flex flex-wrap gap-1.5">
              {PRODUCT_SUBCATEGORIES.map((sc) => {
                const on = parseSubcategories(draft.subcategoryArea).includes(sc);
                return (
                  <button
                    key={sc}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      onChange({ ...draft, subcategoryArea: toggleSubcategory(draft.subcategoryArea, sc) })
                    }
                    className={cn(
                      "inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium border transition",
                      on
                        ? "border-emerald bg-emerald-soft text-emerald-ink"
                        : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink",
                    )}
                  >
                    {sc}
                  </button>
                );
              })}
            </div>
          </FormField>
        </div>

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

        <FormField label={`Sales price per ${unitWord} ($)`}>
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

        <FormField label={`Cost per ${unitWord} ($)`}>
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
          <span className="font-semibold">Margin per {unitWord}:</span>{" "}
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
