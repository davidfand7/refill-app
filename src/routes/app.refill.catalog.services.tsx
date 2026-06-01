/**
 * /app/refill/catalog/services — Services CRUD + linkage + auto-COGS (v1.29.2 → v1.29.3).
 *
 * v1.29.2 shipped the bare CRUD; v1.29.3 lights up the structural payoff:
 * service_products linkage (which products each service consumes + how much)
 * plus the auto-COGS toggle that rewrites cogs_per_service = SUM(product cost ×
 * quantity) whenever linkage changes. Karen enters her products once + her
 * services once + the math composes itself.
 *
 * Service categories differ from product categories: services have 'laser'
 * and 'facial' (treatment categories), products have 'laser_consumable'
 * (a product category). Per v1.29.0 migration.
 *
 * Linkage UI lives inline inside the service edit form (only in edit mode —
 * a service must exist before it can have linked products).
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  ClipboardList,
  Link2,
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
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  createServiceFn,
  deleteServiceFn,
  linkProductToServiceFn,
  listProductsFn,
  listServiceProductsFn,
  listServicesFn,
  setServiceCogsSourceFn,
  unlinkServiceProductFn,
  updateServiceFn,
  updateServiceProductQuantityFn,
  type Product,
  type Service,
  type ServiceCategory,
  type ServiceLinkageBundle,
  type ServiceProductLink,
} from "@/server/refill-catalog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/catalog/services")({
  component: ServicesPage,
});

const CATEGORY_OPTIONS: Array<{ value: ServiceCategory; label: string }> = [
  { value: "tox", label: "Tox" },
  { value: "filler", label: "Filler" },
  { value: "laser", label: "Laser" },
  { value: "facial", label: "Facial" },
  { value: "skincare", label: "Skincare" },
  { value: "other", label: "Other" },
];

type ServiceDraft = {
  name: string;
  category: ServiceCategory;
  servicePrice: string;
  cogsPerService: string;
  notes: string;
};

const EMPTY_DRAFT: ServiceDraft = {
  name: "",
  category: "tox",
  servicePrice: "",
  cogsPerService: "",
  notes: "",
};

function serviceToDraft(s: Service): ServiceDraft {
  return {
    name: s.name,
    category: s.category,
    servicePrice: String(s.servicePrice),
    cogsPerService: s.cogsPerService === null ? "" : String(s.cogsPerService),
    notes: s.notes ?? "",
  };
}

function draftToPayload(d: ServiceDraft) {
  const price = Number.parseFloat(d.servicePrice);
  if (!d.name.trim()) throw new Error("Service name is required.");
  if (!Number.isFinite(price) || price < 0) throw new Error("Price must be a non-negative number.");
  let cogs: number | null = null;
  if (d.cogsPerService.trim() !== "") {
    cogs = Number.parseFloat(d.cogsPerService);
    if (!Number.isFinite(cogs) || cogs < 0) throw new Error("COGS must be a non-negative number.");
  }
  return {
    name: d.name.trim(),
    category: d.category,
    servicePrice: price,
    cogsPerService: cogs,
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

function categoryLabel(c: ServiceCategory): string {
  return CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c;
}

function ServicesPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<Service[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<ServiceDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ServiceDraft>(EMPTY_DRAFT);
  const [linkage, setLinkage] = useState<ServiceLinkageBundle | null>(null);
  const [linkageLoading, setLinkageLoading] = useState(false);
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
        const [svcs, prods] = await Promise.all([
          listServicesFn({ data: { accessToken: token, viewAsUserId } }),
          listProductsFn({ data: { accessToken: token, viewAsUserId } }),
        ]);
        if (!cancelled) {
          setServices(svcs);
          setProducts(prods);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Couldn't load catalog.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  const byCategory = useMemo(() => {
    const groups = new Map<ServiceCategory, Service[]>();
    for (const s of services) {
      const arr = groups.get(s.category) ?? [];
      arr.push(s);
      groups.set(s.category, arr);
    }
    return groups;
  }, [services]);

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
        createServiceFn({
          data: { accessToken: token, viewAsUserId, service: payload },
        }),
      );
      setServices((prev) => [...prev, created]);
      setAddDraft(EMPTY_DRAFT);
      setAdding(false);
      toast.success(`Added ${created.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add service.");
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
        updateServiceFn({
          data: { accessToken: token, viewAsUserId, id, service: payload },
        }),
      );
      setServices((prev) => prev.map((s) => (s.id === id ? updated : s)));
      setEditingId(null);
      setLinkage(null);
      toast.success(`Saved ${updated.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save service.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(s: Service) {
    if (!confirm(`Delete ${s.name}? This can't be undone.`)) return;
    if (busy) return;
    setBusy(true);
    try {
      await withToken((token) =>
        deleteServiceFn({
          data: { accessToken: token, viewAsUserId, id: s.id },
        }),
      );
      setServices((prev) => prev.filter((row) => row.id !== s.id));
      toast.success(`Deleted ${s.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete service.");
    } finally {
      setBusy(false);
    }
  }

  async function startEdit(s: Service) {
    setEditingId(s.id);
    setEditDraft(serviceToDraft(s));
    setLinkage(null);
    setLinkageLoading(true);
    try {
      const bundle = await withToken((token) =>
        listServiceProductsFn({
          data: { accessToken: token, viewAsUserId, serviceId: s.id },
        }),
      );
      setLinkage(bundle);
      // Sync edit draft cogs with the bundle's authoritative service row
      // (in case the server recomputed something during a prior session).
      setEditDraft(serviceToDraft(bundle.service));
      // Also reconcile the parent services list if the server view differs.
      setServices((prev) => prev.map((row) => (row.id === s.id ? bundle.service : row)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load linkage.");
    } finally {
      setLinkageLoading(false);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(EMPTY_DRAFT);
    setLinkage(null);
  }

  function applyBundle(bundle: ServiceLinkageBundle) {
    setLinkage(bundle);
    setEditDraft(serviceToDraft(bundle.service));
    setServices((prev) => prev.map((row) => (row.id === bundle.service.id ? bundle.service : row)));
  }

  async function onLinkProduct(productId: string, quantity: number) {
    if (!editingId || busy) return;
    setBusy(true);
    try {
      const bundle = await withToken((token) =>
        linkProductToServiceFn({
          data: {
            accessToken: token,
            viewAsUserId,
            serviceId: editingId,
            productId,
            quantityPerService: quantity,
          },
        }),
      );
      applyBundle(bundle);
      toast.success("Product linked.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't link product.");
    } finally {
      setBusy(false);
    }
  }

  async function onUpdateQuantity(linkId: string, quantity: number) {
    if (busy) return;
    setBusy(true);
    try {
      const bundle = await withToken((token) =>
        updateServiceProductQuantityFn({
          data: {
            accessToken: token,
            viewAsUserId,
            linkId,
            quantityPerService: quantity,
          },
        }),
      );
      applyBundle(bundle);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update quantity.");
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(linkId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const bundle = await withToken((token) =>
        unlinkServiceProductFn({
          data: { accessToken: token, viewAsUserId, linkId },
        }),
      );
      applyBundle(bundle);
      toast.success("Unlinked.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't unlink.");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleCogsSource(source: "manual" | "derived") {
    if (!editingId || busy) return;
    setBusy(true);
    try {
      const bundle = await withToken((token) =>
        setServiceCogsSourceFn({
          data: {
            accessToken: token,
            viewAsUserId,
            serviceId: editingId,
            cogsSource: source,
          },
        }),
      );
      applyBundle(bundle);
      toast.success(source === "derived" ? "Auto COGS on." : "Manual COGS on.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't switch COGS source.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Service catalog"
        description="The services you offer and what each one charges. Optionally enter COGS (cost of goods per service) for margin tracking — or link products to a service and let COGS derive automatically from product cost × quantity."
        actions={
          !adding && (
            <button
              type="button"
              onClick={() => {
                setAdding(true);
                setAddDraft(EMPTY_DRAFT);
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
            >
              <Plus className="h-4 w-4" />
              Add service
            </button>
          )
        }
      />

      <div className="px-6 lg:px-10 py-6 max-w-4xl space-y-6">
        {adding && (
          <ServiceFormCard
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
        ) : services.length === 0 ? (
          !adding && (
            <div className="rounded-xl border border-dashed border-rule bg-white px-6 py-10 text-center">
              <div className="mx-auto inline-flex items-center justify-center rounded-full bg-emerald-soft p-3">
                <ClipboardList className="h-6 w-6 text-emerald" />
              </div>
              <h3 className="mt-3 text-[17px] font-semibold text-ink">No services yet</h3>
              <p className="mt-1.5 text-[13px] text-ink-soft max-w-md mx-auto leading-relaxed">
                Add the services you offer &mdash; tox per unit, filler per syringe, BBL sessions, HydraFacials. Enter the price you charge; COGS is optional (or link products to auto-derive it).
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
                Add your first service
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
                  {rows.map((s) =>
                    editingId === s.id ? (
                      <ServiceFormCard
                        key={s.id}
                        mode="edit"
                        draft={editDraft}
                        onChange={setEditDraft}
                        onSubmit={(e) => onSaveEdit(e, s.id)}
                        onCancel={cancelEdit}
                        onDelete={() => onDelete(s)}
                        busy={busy}
                        linkage={linkage}
                        linkageLoading={linkageLoading}
                        products={products}
                        onLinkProduct={onLinkProduct}
                        onUpdateQuantity={onUpdateQuantity}
                        onUnlink={onUnlink}
                        onToggleCogsSource={onToggleCogsSource}
                      />
                    ) : (
                      <ServiceRow
                        key={s.id}
                        service={s}
                        onEdit={() => startEdit(s)}
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

function ServiceRow({ service, onEdit }: { service: Service; onEdit: () => void }) {
  const hasCogs = service.cogsPerService !== null;
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
              <span className="text-[16px] font-semibold text-ink">{service.name}</span>
              {service.cogsSource === "derived" && (
                <span className="text-[11px] text-emerald-ink bg-emerald-soft rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                  <Link2 className="h-3 w-3" />
                  Auto COGS
                </span>
              )}
            </div>
            {service.notes && (
              <p className="mt-1 text-[12px] text-ink-soft leading-snug">{service.notes}</p>
            )}
          </div>
          <div className="text-right tabular-nums shrink-0">
            <div className="text-[13px] text-ink-soft">
              {hasCogs
                ? `${fmtUsd(service.servicePrice)} sell · ${fmtUsd(service.cogsPerService as number)} cost`
                : `${fmtUsd(service.servicePrice)} sell · COGS not set`}
            </div>
            <div className="text-[15px] font-semibold text-emerald mt-0.5">
              {service.marginPerService !== null ? (
                <>
                  {fmtUsd(service.marginPerService)}{" "}
                  <span className="text-[12px] text-ink-soft font-normal">({fmtPct(service.marginPct)})</span>
                </>
              ) : (
                <span className="text-ink-faint text-[13px] font-normal">Set COGS for margin</span>
              )}
            </div>
          </div>
          <Pencil className="h-4 w-4 text-ink-faint group-hover:text-emerald shrink-0 mt-1" />
        </div>
      </button>
    </li>
  );
}

function ServiceFormCard({
  mode,
  draft,
  onChange,
  onSubmit,
  onCancel,
  onDelete,
  busy,
  linkage,
  linkageLoading,
  products,
  onLinkProduct,
  onUpdateQuantity,
  onUnlink,
  onToggleCogsSource,
}: {
  mode: "add" | "edit";
  draft: ServiceDraft;
  onChange: (d: ServiceDraft) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
  onDelete?: () => void;
  busy: boolean;
  linkage?: ServiceLinkageBundle | null;
  linkageLoading?: boolean;
  products?: Product[];
  onLinkProduct?: (productId: string, quantity: number) => void;
  onUpdateQuantity?: (linkId: string, quantity: number) => void;
  onUnlink?: (linkId: string) => void;
  onToggleCogsSource?: (source: "manual" | "derived") => void;
}) {
  const isDerived = linkage?.service.cogsSource === "derived";
  const cogsInputDisabled = busy || isDerived;

  const computedMargin = useMemo(() => {
    const price = Number.parseFloat(draft.servicePrice);
    if (!Number.isFinite(price)) return null;
    if (draft.cogsPerService.trim() === "") return null;
    const cogs = Number.parseFloat(draft.cogsPerService);
    if (!Number.isFinite(cogs)) return null;
    const margin = price - cogs;
    const pct = price > 0 ? margin / price : null;
    return { margin, pct };
  }, [draft.servicePrice, draft.cogsPerService]);

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border-2 border-emerald/30 bg-white px-5 py-5 space-y-4 shadow-sm"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Service name">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="e.g. Botox / unit, BBL session, HydraFacial"
            disabled={busy}
            autoFocus={mode === "add"}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          />
        </FormField>

        <FormField label="Category">
          <select
            value={draft.category}
            onChange={(e) =>
              onChange({ ...draft, category: e.target.value as ServiceCategory })
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

        <FormField label="Sales price ($)">
          <input
            type="number"
            step="0.01"
            min="0"
            value={draft.servicePrice}
            onChange={(e) => onChange({ ...draft, servicePrice: e.target.value })}
            placeholder="0.00"
            disabled={busy}
            className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
          />
        </FormField>

        <FormField
          label={
            isDerived
              ? "COGS / cost ($, auto-derived)"
              : "COGS / cost ($, optional)"
          }
        >
          <input
            type="number"
            step="0.01"
            min="0"
            value={draft.cogsPerService}
            onChange={(e) => onChange({ ...draft, cogsPerService: e.target.value })}
            placeholder={isDerived ? "Computed from linked products" : "Leave blank or link products below"}
            disabled={cogsInputDisabled}
            className={cn(
              "w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums",
              isDerived && "bg-emerald-soft cursor-not-allowed",
            )}
          />
        </FormField>
      </div>

      <FormField label="Notes (optional)">
        <input
          type="text"
          value={draft.notes}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          placeholder="Treatment protocols, room requirements, anything useful"
          disabled={busy}
          className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
        />
      </FormField>

      {mode === "edit" && (
        <LinkageSection
          linkage={linkage}
          linkageLoading={linkageLoading ?? false}
          products={products ?? []}
          busy={busy}
          onLinkProduct={onLinkProduct}
          onUpdateQuantity={onUpdateQuantity}
          onUnlink={onUnlink}
          onToggleCogsSource={onToggleCogsSource}
        />
      )}

      {computedMargin && (
        <div className="rounded-md bg-emerald-soft px-3 py-2 text-[13px] text-ink">
          <span className="font-semibold">Margin per service:</span>{" "}
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
              {mode === "add" ? "Add service" : "Save changes"}
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

function LinkageSection({
  linkage,
  linkageLoading,
  products,
  busy,
  onLinkProduct,
  onUpdateQuantity,
  onUnlink,
  onToggleCogsSource,
}: {
  linkage: ServiceLinkageBundle | null | undefined;
  linkageLoading: boolean;
  products: Product[];
  busy: boolean;
  onLinkProduct?: (productId: string, quantity: number) => void;
  onUpdateQuantity?: (linkId: string, quantity: number) => void;
  onUnlink?: (linkId: string) => void;
  onToggleCogsSource?: (source: "manual" | "derived") => void;
}) {
  const [newProductId, setNewProductId] = useState<string>("");
  const [newQuantity, setNewQuantity] = useState<string>("1");

  if (linkageLoading || !linkage) {
    return (
      <div className="rounded-md border border-dashed border-rule bg-bg-soft px-4 py-3 text-[12px] text-ink-soft inline-flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading product linkage&hellip;
      </div>
    );
  }

  const isDerived = linkage.service.cogsSource === "derived";
  const derivedSum = linkage.links.reduce((s, l) => s + l.derivedCostContribution, 0);

  // Products NOT yet linked (so the picker doesn't offer duplicates).
  const linkedProductIds = new Set(linkage.links.map((l) => l.productId));
  const availableProducts = products.filter((p) => !linkedProductIds.has(p.id));

  function onAdd() {
    if (!newProductId) {
      toast.error("Pick a product first.");
      return;
    }
    const qty = Number.parseFloat(newQuantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Quantity must be greater than 0.");
      return;
    }
    onLinkProduct?.(newProductId, qty);
    setNewProductId("");
    setNewQuantity("1");
  }

  return (
    <section className="rounded-lg border border-rule bg-bg-soft p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h4 className="text-[12px] uppercase tracking-wider font-semibold text-ink-faint">
            Products consumed
          </h4>
          <p className="text-[12px] text-ink-soft mt-0.5">
            Link the products this service uses. With Auto COGS on, the cost is recomputed automatically as <code className="text-[11px]">SUM(cost × quantity)</code>.
          </p>
        </div>
        <div className="inline-flex items-center rounded-md border border-rule bg-white overflow-hidden text-[12px]">
          <button
            type="button"
            disabled={busy || !isDerived}
            onClick={() => onToggleCogsSource?.("manual")}
            className={cn(
              "px-3 py-1.5 font-semibold transition",
              !isDerived ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink",
            )}
          >
            Manual
          </button>
          <button
            type="button"
            disabled={busy || isDerived || linkage.links.length === 0}
            onClick={() => onToggleCogsSource?.("derived")}
            className={cn(
              "px-3 py-1.5 font-semibold transition border-l border-rule",
              isDerived ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink disabled:text-ink-faint disabled:cursor-not-allowed",
            )}
            title={linkage.links.length === 0 ? "Link at least one product first" : undefined}
          >
            Auto from products
          </button>
        </div>
      </div>

      {linkage.links.length === 0 ? (
        <p className="text-[12px] text-ink-soft italic">
          No products linked yet. Add one below to enable Auto COGS.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {linkage.links.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              busy={busy}
              onUpdateQuantity={onUpdateQuantity}
              onUnlink={onUnlink}
            />
          ))}
        </ul>
      )}

      {availableProducts.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div className="flex-1 min-w-[200px]">
            <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
              Add product
            </label>
            <select
              value={newProductId}
              onChange={(e) => setNewProductId(e.target.value)}
              disabled={busy}
              className="w-full rounded-md border border-rule bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-1 focus:ring-emerald/30"
            >
              <option value="">Pick a product&hellip;</option>
              {availableProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.brand} ({fmtUsd(p.costPerUnit)}/{p.unitType})
                </option>
              ))}
            </select>
          </div>
          <div className="w-[110px]">
            <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
              Qty
            </label>
            <input
              type="number"
              step="0.0001"
              min="0"
              value={newQuantity}
              onChange={(e) => setNewQuantity(e.target.value)}
              placeholder="1"
              disabled={busy}
              className="w-full rounded-md border border-rule bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-1 focus:ring-emerald/30 tabular-nums"
            />
          </div>
          <button
            type="button"
            onClick={onAdd}
            disabled={busy || !newProductId}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[13px] font-semibold transition",
              busy || !newProductId
                ? "bg-rule text-ink-faint cursor-not-allowed"
                : "bg-emerald text-paper hover:opacity-95",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            Link
          </button>
        </div>
      )}

      {availableProducts.length === 0 && products.length === 0 && (
        <p className="text-[11px] text-ink-soft italic">
          No products in the catalog yet. Add some at <code>/app/refill/catalog/products</code> first.
        </p>
      )}

      {linkage.links.length > 0 && (
        <div className="rounded-md bg-white border border-rule px-3 py-2 text-[13px] flex items-center justify-between">
          <span className="text-ink-soft">
            Sum from linked products:
          </span>
          <span className="tabular-nums font-semibold text-ink">
            {fmtUsd(derivedSum)}
            {isDerived && (
              <span className="ml-2 text-[11px] text-emerald-ink bg-emerald-soft rounded-full px-2 py-0.5">
                Active
              </span>
            )}
          </span>
        </div>
      )}
    </section>
  );
}

function LinkRow({
  link,
  busy,
  onUpdateQuantity,
  onUnlink,
}: {
  link: ServiceProductLink;
  busy: boolean;
  onUpdateQuantity?: (linkId: string, quantity: number) => void;
  onUnlink?: (linkId: string) => void;
}) {
  const [qtyDraft, setQtyDraft] = useState<string>(String(link.quantityPerService));
  const [committing, setCommitting] = useState(false);

  // Sync local draft when server pushes a new value (e.g. after another mutation).
  useEffect(() => {
    setQtyDraft(String(link.quantityPerService));
  }, [link.quantityPerService]);

  function commit() {
    const next = Number.parseFloat(qtyDraft);
    if (!Number.isFinite(next) || next <= 0) {
      setQtyDraft(String(link.quantityPerService));
      toast.error("Quantity must be greater than 0.");
      return;
    }
    if (next === link.quantityPerService) return;
    setCommitting(true);
    Promise.resolve(onUpdateQuantity?.(link.id, next)).finally(() => setCommitting(false));
  }

  return (
    <li className="flex items-center gap-2 rounded-md bg-white border border-rule px-3 py-1.5">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-ink font-medium truncate">
          {link.productBrand}
          <span className="text-[11px] text-ink-soft font-normal ml-1.5">
            ({fmtUsd(link.productCostPerUnit)}/{link.productUnitType})
          </span>
        </div>
      </div>
      <input
        type="number"
        step="0.0001"
        min="0"
        value={qtyDraft}
        onChange={(e) => setQtyDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        disabled={busy || committing}
        className="w-[88px] rounded-md border border-rule bg-white px-2 py-1 text-[12px] text-ink tabular-nums outline-none focus:border-emerald focus:ring-1 focus:ring-emerald/30"
      />
      <span className="text-[12px] text-ink-soft tabular-nums w-[80px] text-right">
        {fmtUsd(link.derivedCostContribution)}
      </span>
      <button
        type="button"
        onClick={() => onUnlink?.(link.id)}
        disabled={busy}
        className="text-ink-faint hover:text-red-600 transition p-1"
        title="Unlink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
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
