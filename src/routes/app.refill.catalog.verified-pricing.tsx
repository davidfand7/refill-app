/**
 * /app/refill/catalog/verified-pricing — Vision portal-import UI (Ship 2 of 3).
 *
 * The in-app surface on top of the v2.138.0 portal-import engine. The owner
 * snaps/uploads a manufacturer-portal "Your Price" screenshot; Claude vision
 * reads it (server-side), fuzzy-matches the prices to this tenant's catalog,
 * and stages a review TABLE. Per matched row the owner sees: what the portal
 * said (price + box/unit basis) → the per-box ÷ units_per_box conversion (the
 * #1 cost-import GIGO trap — surfaced for the human check) → the per-unit cost
 * we'd write → the current cost + its provenance badge. The owner ticks the
 * rows to trust and Applies → those products flip to cost_source='portal' (the
 * green Verified badge). NEVER writes without an explicit confirm.
 *
 * This tab is also the review INBOX: pending batches (from this upload lane and,
 * in Ship 3, the email-forward lane) live here until reviewed. Realizes
 * project_vision_ingestion_moat — the auth-walled, per-spa portal numbers no
 * CSV/API/scraper can reach, only a photo from inside the spa's own account.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ImageUp,
  Loader2,
  Mail,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { CostSourceBadge } from "@/components/CostSourceBadge";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";
import {
  applyPortalImportBatchFn,
  createPortalImportFromUploadFn,
  createProductFromPortalRowFn,
  dismissPortalImportBatchFn,
  listPortalImportBatchesFn,
  type PortalImportBatch,
  type PortalImportProposal,
} from "@/server/portal-import.functions";
import type { ProductCategory, ProductUnitType } from "@/server/refill-catalog";
import { getOrCreateRewardIngestToken } from "@/server/manufacturer-reward-ingest.functions";

// Inline-add option lists (mirror the product editor; biostimulator is folded
// into Filler + a sub-category, so it's omitted from the picker).
const ADD_CATEGORY_OPTIONS: Array<{ value: ProductCategory; label: string }> = [
  { value: "tox", label: "Tox" },
  { value: "filler", label: "Filler" },
  { value: "laser_consumable", label: "Laser consumable" },
  { value: "facial", label: "Facial" },
  { value: "skincare", label: "Skincare" },
  { value: "other", label: "Other" },
];

const ADD_UNIT_OPTIONS: Array<{ value: ProductUnitType; label: string }> = [
  { value: "vial", label: "Vial" },
  { value: "syringe", label: "Syringe" },
  { value: "bottle", label: "Bottle" },
  { value: "session", label: "Session" },
  { value: "other", label: "Other" },
];

type AddProductValues = {
  brand: string;
  category: ProductCategory;
  unitType: ProductUnitType;
  salesPrice: number;
  unitsPerBox?: number;
};

export const Route = createFileRoute("/app/refill/catalog/verified-pricing")({
  component: VerifiedPricingPage,
});

// Manufacturer hint options — curated to the portals vision reads today. The
// engine takes a free lowercase key; "" = let vision auto-detect.
const MANUFACTURER_HINTS: Array<{ value: string; label: string }> = [
  { value: "", label: "Auto-detect (let vision decide)" },
  { value: "abbvie", label: "Allergan / AbbVie (APP)" },
  { value: "galderma", label: "Galderma (ASPIRE)" },
  { value: "evolus", label: "Evolus" },
  { value: "merz", label: "Merz" },
  { value: "revance", label: "Revance (Daxxify)" },
];

const OK_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type ImageMedia = (typeof OK_IMAGE_TYPES)[number];
type ImagePayload = { data: string; mediaType: ImageMedia; name: string; previewUrl: string };

function fmtUsd(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function manufacturerLabel(key: string | null): string {
  if (!key) return "Unknown manufacturer";
  return (
    MANUFACTURER_HINTS.find((m) => m.value === key)?.label ??
    key.charAt(0).toUpperCase() + key.slice(1)
  );
}

function fmtWhen(iso: string): string {
  // Cheap relative-ish label without pulling a date lib; falls back to locale.
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Read a File into the base64 payload the engine expects (no data: prefix). */
function fileToImagePayload(file: File): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    if (!OK_IMAGE_TYPES.includes(file.type as ImageMedia)) {
      reject(new Error(`${file.name}: use a PNG, JPEG, WebP, or GIF image.`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const base64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      if (!base64) {
        reject(new Error(`${file.name}: couldn't read that image.`));
        return;
      }
      resolve({
        data: base64,
        mediaType: file.type as ImageMedia,
        name: file.name,
        previewUrl: result,
      });
    };
    reader.onerror = () => reject(new Error(`${file.name}: read failed.`));
    reader.readAsDataURL(file);
  });
}

// ─── Confidence pill ──────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: PortalImportProposal["matchConfidence"] }) {
  const cfg: Record<PortalImportProposal["matchConfidence"], { label: string; cls: string }> = {
    high: { label: "Strong match", cls: "bg-emerald/10 text-emerald-ink" },
    medium: { label: "Likely match", cls: "bg-amber-soft text-amber-ink" },
    low: { label: "Loose match", cls: "bg-amber-soft text-amber-ink" },
    none: { label: "No match", cls: "bg-rule-soft text-ink-soft" },
  };
  const c = cfg[confidence];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
        c.cls,
      )}
    >
      {c.label}
    </span>
  );
}

// A matched proposal is applicable only if it resolved to a product AND has a
// non-negative proposed per-unit cost.
function isApplicable(p: PortalImportProposal): boolean {
  return (
    p.matchedProductId != null &&
    p.proposedCostPerUnit != null &&
    p.proposedCostPerUnit >= 0
  );
}

function VerifiedPricingPage() {
  const membership = useTenantMembership();
  const viewAsUserId = membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [batches, setBatches] = useState<PortalImportBatch[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Upload composer state.
  const [images, setImages] = useState<ImagePayload[]>([]);
  const [manufacturer, setManufacturer] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Review state.
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  // Unmatched rows the owner has added to the catalog this session (by index).
  const [addedRows, setAddedRows] = useState<Set<number>>(new Set());

  // Email lane — the spa's private drop-address (same one the rewards lane
  // uses); surfaced here so the email option lives where portal-import lives.
  const [dropAddress, setDropAddress] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);
  // Spa token (baked into the 1-click bookmarklet importer).
  const [spaToken, setSpaToken] = useState<string | null>(null);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);

  async function withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) throw new Error("Not signed in.");
    return fn(token);
  }

  const loadBatches = useCallback(async () => {
    return withToken((token) =>
      listPortalImportBatchesFn({ data: { accessToken: token, viewAsUserId } }),
    );
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const rows = await loadBatches();
        if (!cancelled) {
          setBatches(rows);
          // Auto-focus the most recent batch still awaiting review.
          setActiveId(rows.find((b) => b.status === "pending_review")?.id ?? null);
        }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "Couldn't load imports.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, loadBatches]);

  // Fetch the spa's private drop-address for the email lane (non-fatal — the
  // email card simply doesn't render if it can't load).
  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await withToken((token) =>
          getOrCreateRewardIngestToken({ data: { accessToken: token, viewAsUserId } }),
        );
        if (!cancelled) {
          setDropAddress(r.address);
          setSpaToken(r.token);
        }
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  const activeBatch = useMemo(
    () => batches.find((b) => b.id === activeId) ?? null,
    [batches, activeId],
  );
  const pending = useMemo(() => batches.filter((b) => b.status === "pending_review"), [batches]);
  const history = useMemo(() => batches.filter((b) => b.status !== "pending_review"), [batches]);

  // When the active batch changes, default-check applicable rows whose match is
  // confident (strong/likely). Loose + unmatched start unticked — opt-in.
  useEffect(() => {
    setAddedRows(new Set());
    if (!activeBatch || activeBatch.status !== "pending_review") {
      setChecked(new Set());
      return;
    }
    const next = new Set<number>();
    activeBatch.proposals.forEach((p, i) => {
      if (isApplicable(p) && (p.matchConfidence === "high" || p.matchConfidence === "medium")) {
        next.add(i);
      }
    });
    setChecked(next);
  }, [activeBatch]);

  // ─── Upload handlers ──────────────────────────────────────────────────────

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    try {
      const payloads = await Promise.all(list.map(fileToImagePayload));
      setImages((prev) => [...prev, ...payloads].slice(0, 8)); // engine caps at 8
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that image.");
    }
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  }

  async function onUpload() {
    if (uploading || images.length === 0) return;
    setUploading(true);
    try {
      const result = await withToken((token) =>
        createPortalImportFromUploadFn({
          data: {
            accessToken: token,
            viewAsUserId,
            manufacturer: manufacturer || undefined,
            images: images.map((im) => ({ data: im.data, mediaType: im.mediaType })),
          },
        }),
      );
      const matched = result.proposals.filter((p) => p.matchedProductId).length;
      toast.success(
        `Read ${result.proposals.length} ${result.proposals.length === 1 ? "price" : "prices"} · ${matched} matched to your catalog.`,
        { duration: 8000 },
      );
      setImages([]);
      setManufacturer("");
      // Refetch so the new batch carries its server-side id/status, then focus it.
      const rows = await loadBatches();
      setBatches(rows);
      setActiveId(result.batchId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that screenshot.", {
        duration: 10000,
      });
    } finally {
      setUploading(false);
    }
  }

  // ─── Review handlers ──────────────────────────────────────────────────────

  function toggleRow(i: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const applicableCount = useMemo(
    () => (activeBatch ? activeBatch.proposals.filter(isApplicable).length : 0),
    [activeBatch],
  );

  function setAllApplicable(on: boolean) {
    if (!activeBatch) return;
    const next = new Set<number>();
    if (on) {
      activeBatch.proposals.forEach((p, i) => {
        if (isApplicable(p)) next.add(i);
      });
    }
    setChecked(next);
  }

  async function onApply() {
    if (!activeBatch || applying) return;
    const ids = Array.from(checked)
      .map((i) => activeBatch.proposals[i])
      .filter((p): p is PortalImportProposal => !!p && isApplicable(p))
      .map((p) => p.matchedProductId!) // isApplicable guarantees non-null
      .filter((id, idx, arr) => arr.indexOf(id) === idx);
    if (ids.length === 0) {
      toast.error("Tick at least one matched row to verify.");
      return;
    }
    setApplying(true);
    try {
      const { updated } = await withToken((token) =>
        applyPortalImportBatchFn({
          data: { accessToken: token, viewAsUserId, batchId: activeBatch.id, confirmProductIds: ids },
        }),
      );
      toast.success(
        `Verified ${updated} ${updated === 1 ? "product cost" : "product costs"} from your portal.`,
        { duration: 8000 },
      );
      const rows = await loadBatches();
      setBatches(rows);
      setActiveId(rows.find((b) => b.status === "pending_review")?.id ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't apply those costs.", {
        duration: 10000,
      });
    } finally {
      setApplying(false);
    }
  }

  async function onDismiss(batchId: string) {
    if (!confirm("Discard this import? The screenshot's prices won't be saved.")) return;
    try {
      await withToken((token) =>
        dismissPortalImportBatchFn({ data: { accessToken: token, viewAsUserId, batchId } }),
      );
      toast.success("Import discarded.");
      const rows = await loadBatches();
      setBatches(rows);
      setActiveId(rows.find((b) => b.status === "pending_review")?.id ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't discard that import.");
    }
  }

  /** Create a catalog product from an unmatched row. Throws on failure so the
   *  inline form can reset its busy state; success toast handled here. */
  async function onCreateProductFromRow(rowIndex: number, values: AddProductValues): Promise<void> {
    if (!activeBatch) return;
    const { brand } = await withToken((token) =>
      createProductFromPortalRowFn({
        data: {
          accessToken: token,
          viewAsUserId,
          batchId: activeBatch.id,
          rowIndex,
          brand: values.brand,
          category: values.category,
          unitType: values.unitType,
          salesPricePerUnit: values.salesPrice,
          unitsPerBox: values.unitsPerBox,
        },
      }),
    );
    setAddedRows((prev) => new Set(prev).add(rowIndex));
    toast.success(`Added ${brand} — Verified from your portal.`, { duration: 8000 });
  }

  async function copyAddress() {
    if (!dropAddress) return;
    try {
      await navigator.clipboard.writeText(dropAddress);
      setCopiedAddr(true);
      setTimeout(() => setCopiedAddr(false), 1500);
    } catch {
      toast.error("Couldn't copy — select and copy the address manually.");
    }
  }

  // Pre-filled compose links. mailto: works for users with a desktop mail app
  // set as default; webmail users (Gmail/Outlook in the browser) need the
  // provider web-compose URLs, which open a pre-filled compose tab directly.
  // (None can pre-attach a file — OS limitation — so the body says to attach.)
  const COMPOSE_SUBJECT = "Portal pricing";
  const COMPOSE_BODY =
    'Attach your manufacturer portal "Your Price" screenshot to this email and send. SmartSpa will read it and stage it on your Verified pricing tab for review.';
  const mailtoHref = dropAddress
    ? `mailto:${dropAddress}?subject=${encodeURIComponent(COMPOSE_SUBJECT)}&body=${encodeURIComponent(COMPOSE_BODY)}`
    : "#";
  const gmailHref = dropAddress
    ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(dropAddress)}&su=${encodeURIComponent(COMPOSE_SUBJECT)}&body=${encodeURIComponent(COMPOSE_BODY)}`
    : "#";
  const outlookHref = dropAddress
    ? `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(dropAddress)}&subject=${encodeURIComponent(COMPOSE_SUBJECT)}&body=${encodeURIComponent(COMPOSE_BODY)}`
    : "#";

  // 1-click bookmarklet importer with the spa token baked in. Grabs the portal
  // page's innerText and hands off to /import via the URL FRAGMENT (CSP-proof —
  // navigation, not a fetch the portal's connect-src could block).
  const bookmarkletCode = spaToken
    ? `javascript:(function(){try{var b=document.querySelector('main')||document.body;var x=(b.innerText||'').slice(0,40000);var p={tk:${JSON.stringify(spaToken)},text:x,url:location.href,title:document.title,ts:Date.now()};var d=btoa(unescape(encodeURIComponent(JSON.stringify(p))));window.open('https://smartspa.app/import#'+d,'_blank');}catch(e){alert('SmartSpa import failed: '+((e&&e.message)||e));}})();`
    : null;
  useEffect(() => {
    // Set the javascript: href via DOM (React strips javascript: hrefs).
    if (bookmarkletRef.current && bookmarkletCode) {
      bookmarkletRef.current.setAttribute("href", bookmarkletCode);
    }
  }, [bookmarkletCode]);

  return (
    <div>
      <PageHeader
        title="Verified pricing"
        description="Snap or upload your manufacturer-portal “Your Price” screenshot — Allergan APP, Galderma ASPIRE, Evolus, and more. We read it, match it to your catalog, and you confirm what to apply. Confirmed costs flip from Estimate to Verified. These are the auth-walled, per-spa numbers no spreadsheet can reach — only a photo from inside your own account."
      />

      <CatalogTabs />

      <div className="px-6 lg:px-10 py-6 max-w-[960px] mx-auto space-y-6">
        {/* ── Upload composer ─────────────────────────────────────────────── */}
        <div className="rounded-xl border border-rule bg-white px-5 py-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center justify-center rounded-full bg-emerald-soft p-1.5">
              <Camera className="h-4 w-4 text-emerald" />
            </div>
            <h2 className="text-[15px] font-semibold text-ink">Import your portal prices</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
            <div>
              <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
                Manufacturer (optional)
              </label>
              <select
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                disabled={uploading}
                className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
              >
                {MANUFACTURER_HINTS.map((m) => (
                  <option key={m.value || "auto"} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[12px] text-ink-soft sm:max-w-[220px] leading-snug">
              Telling us the manufacturer sharpens matching — but we’ll detect it from the screenshot if you don’t.
            </p>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "rounded-xl border-2 border-dashed px-6 py-10 text-center transition cursor-pointer",
              dragging
                ? "border-emerald bg-emerald-soft"
                : "border-rule bg-paper/40 hover:border-emerald/40",
            )}
          >
            <div className="mx-auto inline-flex items-center justify-center rounded-full bg-emerald-soft p-3">
              <ImageUp className="h-6 w-6 text-emerald" />
            </div>
            <h3 className="mt-3 text-[16px] font-semibold text-ink">
              Drop a portal screenshot
            </h3>
            <p className="mt-1.5 text-[13px] text-ink-soft max-w-md mx-auto leading-relaxed">
              The “Your Price” / negotiated-price screen from your manufacturer ordering portal. Phone screenshot, desktop capture, or PDF page export — up to 8 images.
            </p>
            <span className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition">
              <Camera className="h-4 w-4" />
              Choose image
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(e.target.files);
                e.target.value = ""; // allow re-picking the same file
              }}
            />
          </div>

          {images.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {images.map((im, i) => (
                  <div
                    key={`${im.name}-${i}`}
                    className="relative group rounded-lg border border-rule overflow-hidden bg-bg-soft"
                  >
                    <img
                      src={im.previewUrl}
                      alt={im.name}
                      className="h-20 w-28 object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                      className="absolute top-1 right-1 inline-flex items-center justify-center rounded-full bg-white/90 p-0.5 text-ink-soft hover:text-rose shadow-sm"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onUpload}
                  disabled={uploading}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition",
                    uploading
                      ? "bg-rule text-ink-faint cursor-not-allowed"
                      : "bg-emerald text-paper hover:opacity-95",
                  )}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Reading {images.length} {images.length === 1 ? "image" : "images"}&hellip;
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Read {images.length} {images.length === 1 ? "screenshot" : "screenshots"}
                    </>
                  )}
                </button>
                {!uploading && (
                  <button
                    type="button"
                    onClick={() => setImages([])}
                    className="text-[13px] text-ink-soft hover:text-ink transition"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Email lane — forward a screenshot, no upload needed ─────────── */}
        {dropAddress && (
          <div className="rounded-xl border border-rule bg-white px-5 py-5 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex items-center justify-center rounded-full bg-emerald-soft p-1.5">
                <Mail className="h-4 w-4 text-emerald" />
              </div>
              <h2 className="text-[15px] font-semibold text-ink">Or email it in</h2>
              <span className="text-[12px] text-ink-soft">— forward from your inbox, no upload needed</span>
            </div>
            <p className="text-[13px] text-ink-soft leading-relaxed">
              Send (or forward) your portal screenshot to your private SmartSpa address — it lands right back here for review. Perfect from your phone: snap the portal in the manufacturer app and share it straight to email.
            </p>

            <ol className="space-y-1.5 text-[13px] text-ink-soft">
              <li className="flex gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-soft text-[11px] font-bold text-emerald-ink">1</span>
                <span>Pick your email below (<span className="font-semibold text-ink">Gmail</span>, Outlook, or Mail app) — a new message opens, already addressed to you.</span>
              </li>
              <li className="flex gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-soft text-[11px] font-bold text-emerald-ink">2</span>
                <span>Attach your portal “Your Price” screenshot and send.</span>
              </li>
              <li className="flex gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-soft text-[11px] font-bold text-emerald-ink">3</span>
                <span>It appears in <span className="font-semibold text-ink">Awaiting review</span> below in under a minute — confirm and you’re done.</span>
              </li>
            </ol>

            <div className="flex items-center gap-2 flex-wrap pt-1">
              <span className="text-[12px] font-semibold text-ink-soft">Compose in:</span>
              <a
                href={gmailHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
              >
                <Mail className="h-4 w-4" />
                Gmail
              </a>
              <a
                href={outlookHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 text-[13px] font-semibold text-ink-soft hover:text-emerald hover:border-emerald/40 transition"
              >
                <Mail className="h-3.5 w-3.5" />
                Outlook
              </a>
              <a
                href={mailtoHref}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 text-[13px] font-semibold text-ink-soft hover:text-emerald hover:border-emerald/40 transition"
              >
                <Mail className="h-3.5 w-3.5" />
                Mail app
              </a>
              <button
                type="button"
                onClick={copyAddress}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 text-[13px] font-semibold text-ink-soft hover:text-emerald hover:border-emerald/40 transition"
                title={dropAddress}
              >
                {copiedAddr ? <Check className="h-3.5 w-3.5 text-emerald" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedAddr ? "Copied" : "Copy address"}
              </button>
            </div>
            <p className="text-[11px] text-ink-faint">
              Each opens a new message already addressed to you — attach the screenshot and send. Forwarding from any staff inbox works too; it’s tied to your spa, not the sender.
            </p>
          </div>
        )}

        {/* ── 1-click bookmarklet importer — zero install ─────────────────── */}
        {spaToken && (
          <div className="rounded-xl border border-rule bg-white px-5 py-5 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex items-center justify-center rounded-full bg-emerald-soft p-1.5">
                <Zap className="h-4 w-4 text-emerald" />
              </div>
              <h2 className="text-[15px] font-semibold text-ink">1-click importer</h2>
              <span className="text-[12px] text-ink-soft">— no screenshot, no upload, no app to install</span>
            </div>
            <p className="text-[13px] text-ink-soft leading-relaxed">
              Set it up once: drag the button below to your browser’s bookmarks bar. Then, on any
              manufacturer-portal price page, just click it — SmartSpa reads the page and drops your
              prices straight into the review below.
            </p>
            <div className="flex items-center gap-3 flex-wrap rounded-lg border border-dashed border-emerald/40 bg-emerald-soft/30 px-4 py-3">
              <a
                ref={bookmarkletRef}
                href="#"
                draggable
                onClick={(e) => e.preventDefault()}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm cursor-grab active:cursor-grabbing"
                title="Drag me to your bookmarks bar"
              >
                <Download className="h-4 w-4" />
                Import to SmartSpa
              </a>
              <span className="text-[12px] text-ink-soft">← drag this up to your bookmarks bar</span>
            </div>
            <p className="text-[11px] text-ink-faint leading-snug">
              Bookmarks bar hidden? Show it with <span className="font-mono">⌘⇧B</span>. Works in
              Chrome, Edge, Safari &amp; Firefox. It reads the page text you’re already logged in to
              see — no portal password ever leaves your computer.
            </p>
          </div>
        )}

        {/* ── Pending review picker (when 2+ await review) ────────────────── */}
        {pending.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-faint">
              Awaiting review
            </span>
            {pending.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setActiveId(b.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium border transition",
                  b.id === activeId
                    ? "border-emerald bg-emerald-soft text-emerald-ink"
                    : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink",
                )}
              >
                {b.source === "email" ? "✉ " : "📷 "}
                {manufacturerLabel(b.manufacturer)}
                <span className="text-ink-faint">
                  {b.proposals.filter((p) => p.matchedProductId).length} matched
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── Review table ───────────────────────────────────────────────── */}
        {loading ? (
          <div className="rounded-xl border border-rule bg-white px-5 py-8 text-center">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-ink-soft" />
            <p className="mt-2 text-[13px] text-ink-soft">Loading&hellip;</p>
          </div>
        ) : activeBatch && activeBatch.status === "pending_review" ? (
          <ReviewTable
            batch={activeBatch}
            checked={checked}
            onToggleRow={toggleRow}
            onSetAll={setAllApplicable}
            applicableCount={applicableCount}
            applying={applying}
            onApply={onApply}
            onDismiss={() => onDismiss(activeBatch.id)}
            addedRows={addedRows}
            onCreateProductFromRow={onCreateProductFromRow}
          />
        ) : pending.length === 0 ? (
          <div className="rounded-xl border border-dashed border-rule bg-white px-6 py-10 text-center">
            <div className="mx-auto inline-flex items-center justify-center rounded-full bg-emerald-soft p-3">
              <ShieldCheck className="h-6 w-6 text-emerald" />
            </div>
            <h3 className="mt-3 text-[16px] font-semibold text-ink">No imports awaiting review</h3>
            <p className="mt-1.5 text-[13px] text-ink-soft max-w-md mx-auto leading-relaxed">
              Upload a portal screenshot above and your matched prices land here for a quick confirm. Verifying your costs makes every margin number trustworthy.
            </p>
          </div>
        ) : null}

        {/* ── History ────────────────────────────────────────────────────── */}
        {history.length > 0 && (
          <section className="space-y-2.5">
            <h2 className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-ink-faint" />
              Past imports
            </h2>
            <ul className="space-y-2">
              {history.map((b) => {
                const applied = b.status === "applied";
                return (
                  <li
                    key={b.id}
                    className="rounded-xl border border-rule bg-white px-4 py-3 flex items-center gap-3"
                  >
                    {applied ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald shrink-0" />
                    ) : (
                      <X className="h-4 w-4 text-ink-faint shrink-0" />
                    )}
                    <div className="flex-1 min-w-0 text-[13px]">
                      <span className="font-semibold text-ink">
                        {manufacturerLabel(b.manufacturer)}
                      </span>
                      <span className="text-ink-soft">
                        {" "}
                        · {b.source === "email" ? "emailed" : "uploaded"} ·{" "}
                        {b.proposals.filter((p) => p.matchedProductId).length} matched
                      </span>
                    </div>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                        applied ? "bg-emerald/10 text-emerald-ink" : "bg-rule-soft text-ink-soft",
                      )}
                    >
                      {applied ? "Applied" : "Discarded"}
                    </span>
                    <span className="text-[11px] text-ink-faint shrink-0 tabular-nums">
                      {b.reviewedAt ? fmtWhen(b.reviewedAt) : fmtWhen(b.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

// ─── Review table component ───────────────────────────────────────────────────

function ReviewTable({
  batch,
  checked,
  onToggleRow,
  onSetAll,
  applicableCount,
  applying,
  onApply,
  onDismiss,
  addedRows,
  onCreateProductFromRow,
}: {
  batch: PortalImportBatch;
  checked: Set<number>;
  onToggleRow: (i: number) => void;
  onSetAll: (on: boolean) => void;
  applicableCount: number;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
  addedRows: Set<number>;
  onCreateProductFromRow: (rowIndex: number, values: AddProductValues) => Promise<void>;
}) {
  const rows = batch.proposals;
  const matched = rows.filter((p) => p.matchedProductId);
  // Keep the original proposal index so the inline-add can point the server at
  // the exact staged row (server reads the trusted price from there).
  const unmatchedIdx = rows
    .map((p, i) => ({ p, i }))
    .filter((x) => !x.p.matchedProductId);
  const allApplicableChecked =
    applicableCount > 0 &&
    rows.every((p, i) => !isApplicable(p) || checked.has(i));
  const selectedCount = Array.from(checked).filter((i) => rows[i] && isApplicable(rows[i])).length;

  return (
    <div className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3.5 border-b border-rule flex items-center gap-2 flex-wrap">
        <Sparkles className="h-4 w-4 text-emerald" />
        <span className="text-[14px] font-semibold text-ink">
          {manufacturerLabel(batch.manufacturer)}
        </span>
        <span className="text-[12px] text-ink-soft">
          · {matched.length} matched
          {unmatchedIdx.length > 0 ? ` · ${unmatchedIdx.length} unmatched` : ""}
        </span>
        <span className="ml-auto text-[11px] text-ink-faint">{fmtWhen(batch.createdAt)}</span>
      </div>

      {/* Matched rows table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-ink-faint border-b border-rule bg-paper/40">
              <th className="text-left py-2 pl-5 pr-2 w-8">
                {applicableCount > 0 && (
                  <input
                    type="checkbox"
                    checked={allApplicableChecked}
                    onChange={(e) => onSetAll(e.target.checked)}
                    className="h-3.5 w-3.5 accent-emerald cursor-pointer"
                    title={allApplicableChecked ? "Untick all" : "Tick all matched"}
                  />
                )}
              </th>
              <th className="text-left py-2 pr-3">Product</th>
              <th className="text-right py-2 pr-3">Portal read</th>
              <th className="text-left py-2 pr-3">Conversion</th>
              <th className="text-right py-2 pr-3">New cost / unit</th>
              <th className="text-right py-2 pr-5">Current</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((p, i) => {
              if (!p.matchedProductId) return null;
              const applicable = isApplicable(p);
              const isChecked = checked.has(i);
              const isBox = p.parsedUnitBasis === "box" && (p.unitsPerBox ?? 1) > 1;
              const changed =
                p.currentCostPerUnit != null &&
                p.proposedCostPerUnit != null &&
                Math.abs(p.currentCostPerUnit - p.proposedCostPerUnit) >= 0.005;
              return (
                <tr
                  key={i}
                  className={cn(
                    "transition",
                    isChecked ? "bg-emerald-soft/30" : "hover:bg-paper/40",
                    !applicable && "opacity-60",
                  )}
                >
                  <td className="py-3 pl-5 pr-2 align-top">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={!applicable}
                      onChange={() => onToggleRow(i)}
                      className="mt-0.5 h-3.5 w-3.5 accent-emerald cursor-pointer disabled:cursor-not-allowed"
                    />
                  </td>
                  <td className="py-3 pr-3 align-top">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-ink">{p.matchedBrand}</span>
                      <ConfidenceBadge confidence={p.matchConfidence} />
                    </div>
                    {p.parsedName !== p.matchedBrand && (
                      <div className="text-[11px] text-ink-faint mt-0.5">
                        read as “{p.parsedName}”
                      </div>
                    )}
                    {p.tiers && p.tiers.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[11px] font-medium text-emerald-ink">
                          Volume ladder · {p.tiers.length} tiers
                        </summary>
                        <ul className="mt-1 space-y-0.5 border-l-2 border-emerald/20 pl-2.5">
                          {p.tiers.map((t, ti) => {
                            const isCurrent =
                              p.proposedCostPerUnit != null &&
                              Math.abs(t.pricePerUnit - p.proposedCostPerUnit) < 0.005;
                            return (
                              <li
                                key={ti}
                                className={cn(
                                  "text-[11px] tabular-nums flex items-center justify-between gap-3",
                                  isCurrent ? "text-emerald-ink font-semibold" : "text-ink-faint",
                                )}
                              >
                                <span>{t.qty}</span>
                                <span>
                                  {fmtUsd(t.pricePerUnit)}/unit
                                  {isCurrent && <span className="ml-1">← yours</span>}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-right align-top tabular-nums">
                    {fmtUsd(p.parsedPrice)}
                    <div className="text-[11px] text-ink-faint">
                      per {p.parsedUnitBasis === "unknown" ? "unit?" : p.parsedUnitBasis}
                    </div>
                  </td>
                  <td className="py-3 pr-3 align-top text-[12px] text-ink-soft">
                    {isBox ? (
                      <span className="inline-flex items-center rounded bg-amber-soft text-amber-ink px-1.5 py-0.5 text-[11px] font-medium">
                        ÷ {p.unitsPerBox} per box
                      </span>
                    ) : (
                      <span className="text-ink-faint">per unit</span>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-right align-top tabular-nums">
                    <span className="font-semibold text-ink">{fmtUsd(p.proposedCostPerUnit)}</span>
                  </td>
                  <td className="py-3 pr-5 text-right align-top tabular-nums">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className={cn(changed ? "text-ink-soft" : "text-ink")}>
                        {fmtUsd(p.currentCostPerUnit)}
                      </span>
                      <CostSourceBadge source={p.currentCostSource ?? ""} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Unmatched — add them to the catalog right here (portal-verified). */}
      {unmatchedIdx.length > 0 && (
        <div className="px-5 py-4 border-t border-rule bg-paper/30 space-y-2">
          <div className="text-[12px] text-ink-soft">
            <span className="font-semibold text-ink">
              {unmatchedIdx.length} price{unmatchedIdx.length === 1 ? "" : "s"} we couldn’t match
            </span>{" "}
            to a product you stock. Add it to your catalog right here — the portal price comes in as a{" "}
            <span className="font-semibold text-emerald-ink">Verified</span> cost.
          </div>
          <ul className="space-y-2">
            {unmatchedIdx.map(({ p, i }) => (
              <UnmatchedAddRow
                key={i}
                proposal={p}
                added={addedRows.has(i)}
                onCreate={(values) => onCreateProductFromRow(i, values)}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Action bar */}
      <div className="px-5 py-3.5 border-t border-rule flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onApply}
          disabled={applying || selectedCount === 0}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition",
            applying || selectedCount === 0
              ? "bg-rule text-ink-faint cursor-not-allowed"
              : "bg-emerald text-paper hover:opacity-95",
          )}
        >
          {applying ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying&hellip;
            </>
          ) : (
            <>
              <ShieldCheck className="h-4 w-4" />
              Verify {selectedCount} {selectedCount === 1 ? "cost" : "costs"}
            </>
          )}
        </button>
        <p className="text-[12px] text-ink-soft">
          Ticked rows get your real portal cost and the <span className="font-semibold text-emerald-ink">Verified</span> badge. Nothing else changes.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          disabled={applying}
          className="ml-auto inline-flex items-center gap-1.5 text-[13px] text-ink-soft hover:text-rose transition"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Discard
        </button>
      </div>
    </div>
  );
}

// ─── Inline "add unmatched product" row ───────────────────────────────────────

function AddField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
        {label}
      </label>
      {children}
    </div>
  );
}

const ADD_INPUT_CLS =
  "w-full rounded-md border border-rule bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30";

function UnmatchedAddRow({
  proposal,
  added,
  onCreate,
}: {
  proposal: PortalImportProposal;
  added: boolean;
  onCreate: (values: AddProductValues) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState(proposal.parsedName);
  const [category, setCategory] = useState<ProductCategory>("filler");
  const [unitType, setUnitType] = useState<ProductUnitType>("syringe");
  const [unitsPerBox, setUnitsPerBox] = useState("1");
  const [salesPrice, setSalesPrice] = useState("");
  const [busy, setBusy] = useState(false);

  const isBox = proposal.parsedUnitBasis === "box";
  const units = isBox ? Math.max(1, Number.parseInt(unitsPerBox, 10) || 1) : 1;
  const perUnitCost = isBox && units > 1 ? proposal.parsedPrice / units : proposal.parsedPrice;

  if (added) {
    return (
      <li className="flex items-center gap-2 rounded-lg border border-emerald/30 bg-emerald-soft/40 px-3 py-2.5 text-[13px]">
        <CheckCircle2 className="h-4 w-4 text-emerald shrink-0" />
        <span className="font-semibold text-ink">{brand}</span>
        <span className="text-ink-soft">added to your catalog</span>
        <CostSourceBadge source="portal" className="ml-1" />
      </li>
    );
  }

  async function submit() {
    if (busy || !brand.trim()) return;
    setBusy(true);
    try {
      await onCreate({
        brand: brand.trim(),
        category,
        unitType,
        salesPrice: salesPrice.trim() ? Math.max(0, Number.parseFloat(salesPrice) || 0) : 0,
        unitsPerBox: isBox ? units : undefined,
      });
      // Parent flips `added` on success → this row re-renders into added state.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that product.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-rule bg-white">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-ink truncate">{proposal.parsedName}</div>
          <div className="text-[11px] text-ink-faint tabular-nums">
            {fmtUsd(proposal.parsedPrice)} /{" "}
            {proposal.parsedUnitBasis === "unknown" ? "unit?" : proposal.parsedUnitBasis}
          </div>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-rule bg-white px-2.5 py-1.5 text-[12px] font-semibold text-ink-soft hover:text-emerald hover:border-emerald/40 transition shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Add product
          </button>
        )}
      </div>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-rule/60 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <AddField label="Product name">
              <input
                type="text"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                disabled={busy}
                className={ADD_INPUT_CLS}
              />
            </AddField>
            <AddField label="Category">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ProductCategory)}
                disabled={busy}
                className={ADD_INPUT_CLS}
              >
                {ADD_CATEGORY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </AddField>
            <AddField label="Unit type">
              <select
                value={unitType}
                onChange={(e) => setUnitType(e.target.value as ProductUnitType)}
                disabled={busy}
                className={ADD_INPUT_CLS}
              >
                {ADD_UNIT_OPTIONS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </AddField>
            {isBox && (
              <AddField label="Units per box">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={unitsPerBox}
                  onChange={(e) => setUnitsPerBox(e.target.value)}
                  disabled={busy}
                  className={`${ADD_INPUT_CLS} tabular-nums`}
                />
              </AddField>
            )}
            <AddField label="Sales price / unit (optional)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={salesPrice}
                onChange={(e) => setSalesPrice(e.target.value)}
                placeholder="Set later"
                disabled={busy}
                className={`${ADD_INPUT_CLS} tabular-nums`}
              />
            </AddField>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap rounded-md bg-emerald-soft/60 px-3 py-2 text-[12px] text-ink">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald" />
            <span>
              Cost: <span className="font-semibold tabular-nums">{fmtUsd(perUnitCost)}</span> / unit
            </span>
            {isBox && units > 1 && (
              <span className="text-ink-soft tabular-nums">
                ({fmtUsd(proposal.parsedPrice)} ÷ {units})
              </span>
            )}
            <span className="text-ink-soft">· from your portal · saved as Verified</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={busy || !brand.trim()}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-semibold shadow-sm transition",
                busy || !brand.trim()
                  ? "bg-rule text-ink-faint cursor-not-allowed"
                  : "bg-emerald text-paper hover:opacity-95",
              )}
            >
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Adding&hellip;
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  Add as Verified
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="text-[12px] text-ink-soft hover:text-ink transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ─── Catalog tab nav (mirrors the other catalog pages) ────────────────────────

function CatalogTabs() {
  const base =
    "inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition";
  const inactive = "border-transparent text-ink-soft hover:text-ink";
  const active = "border-emerald text-emerald-ink";
  return (
    <div className="border-b border-rule bg-paper/50">
      <div className="max-w-[960px] mx-auto px-4 lg:px-10 flex items-center gap-1 overflow-x-auto">
        <Link to="/app/refill/catalog/services" className={cn(base, inactive)}>
          Services
        </Link>
        <Link to="/app/refill/catalog/products" className={cn(base, inactive)}>
          Products
        </Link>
        <Link to="/app/refill/catalog/brand-economics" className={cn(base, inactive)}>
          Brand economics
        </Link>
        <Link to="/app/refill/catalog/programs" className={cn(base, inactive)}>
          Programs &amp; tiers
        </Link>
        <Link to="/app/refill/catalog/verified-pricing" className={cn(base, active)}>
          Verified pricing
        </Link>
      </div>
    </div>
  );
}
