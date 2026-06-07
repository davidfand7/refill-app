/**
 * /app/refill/catalog/import — Service-list CSV import (v1.29.4).
 *
 * Targets Acuity Scheduling service-list exports first per
 * feedback_validate_against_real_exports. Other platforms get added as
 * real exports surface — synthetic fixtures are NOT validation.
 *
 * Flow mirrors /app/refill/patients/import:
 *   1. Drop CSV → client reads file text → POST to ingestServicesCsvFn
 *      in preview mode → server returns parsed preview
 *   2. Preview screen shows: header mapping + total counts + sample rows
 *      with auto-detected category + warnings + create/update breakdown
 *   3. Owner reviews; if columns look right, clicks Commit
 *   4. Server re-parses (don't trust client) and upserts by name within
 *      tenant scope; returns receipt
 *
 * Upsert-by-name (case-insensitive): same export can be re-uploaded as
 * the spa adds new services without creating duplicates.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  FileText,
  Loader2,
  Sparkles,
  Upload,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  ingestServicesCsvFn,
  type ImportPreview,
  type ImportReceipt,
  type ServiceCategory,
} from "@/server/refill-catalog";

type CatLabel = "tox" | "filler" | "laser" | "laser_consumable" | "facial" | "skincare" | "other";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/catalog/import")({
  component: CatalogImportPage,
});

function categoryLabel(c: CatLabel | ServiceCategory): string {
  switch (c) {
    case "tox": return "Tox";
    case "filler": return "Filler";
    case "laser": return "Laser";
    case "laser_consumable": return "Laser consumable";
    case "facial": return "Facial";
    case "skincare": return "Skincare";
    case "other": return "Other";
    // Custom (free-text) service categories display verbatim.
    default: return c;
  }
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function CatalogImportPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;
  const navigate = useNavigate();

  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [committing, setCommitting] = useState(false);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(f: File) {
    if (!f.name.toLowerCase().endsWith(".csv")) {
      toast.error("Only .csv files are supported.");
      return;
    }
    const text = await f.text();
    setFile({ name: f.name, size: f.size, text });
    setPreview(null);
    setReceipt(null);
    await runPreview(text);
  }

  async function runPreview(csvText: string) {
    setPreviewing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const result = (await ingestServicesCsvFn({
        data: { accessToken: token, viewAsUserId, csv: csvText, mode: "preview" },
      })) as ImportPreview;
      setPreview(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't parse CSV.");
    } finally {
      setPreviewing(false);
    }
  }

  async function onCommit() {
    if (!file) return;
    setCommitting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const result = (await ingestServicesCsvFn({
        data: { accessToken: token, viewAsUserId, csv: file.text, mode: "commit" },
      })) as ImportReceipt;
      setReceipt(result);
      const total = result.created + result.updated;
      toast.success(
        `Imported ${total} services (${result.created} new, ${result.updated} updated).`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setCommitting(false);
    }
  }

  function clearAll() {
    setFile(null);
    setPreview(null);
    setReceipt(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void handleFile(f);
  }

  return (
    <div>
      <PageHeader
        title="Import catalog from CSV"
        description="Drop your QuickBooks Item List export (or Acuity / Square / any CSV). Service rows land in the Service catalog; Non-inventory rows land in the Product catalog with manufacturer auto-routed via the canonical brand registry. Cost-of-goods columns flow straight into margin math. Preview-then-commit — nothing writes until you confirm. Re-uploading the same file is safe: services match by name, products match by brand, no duplicates."
        actions={
          <Link
            to="/app/refill/catalog/services"
            className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft hover:text-ink transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to services
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-6 max-w-[960px] mx-auto space-y-6">
        {!file && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "rounded-xl border-2 border-dashed px-6 py-12 text-center transition cursor-pointer",
              dragging ? "border-emerald bg-emerald-soft" : "border-rule bg-white hover:border-emerald/40",
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="mx-auto inline-flex items-center justify-center rounded-full bg-emerald-soft p-3">
              <Upload className="h-6 w-6 text-emerald" />
            </div>
            <h3 className="mt-3 text-[17px] font-semibold text-ink">
              Drop your QuickBooks Item List (or any CSV)
            </h3>
            <p className="mt-1.5 text-[13px] text-ink-soft max-w-md mx-auto leading-relaxed">
              QuickBooks is the typical source &mdash; that&rsquo;s where cost-of-goods lives, and QB&rsquo;s Cost column flows straight into your margin math. Acuity / Square / Vagaro service exports also work as fallback.
            </p>
            <button
              type="button"
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
            >
              <FileText className="h-4 w-4" />
              Choose file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </div>
        )}

        {file && (
          <div className="rounded-xl border border-rule bg-white px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <FileText className="h-5 w-5 text-emerald shrink-0" />
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-ink truncate">{file.name}</div>
                <div className="text-[12px] text-ink-soft">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1 text-[13px] text-ink-soft hover:text-ink transition"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>
        )}

        {previewing && (
          <div className="rounded-xl border border-rule bg-white px-5 py-8 text-center">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-ink-soft" />
            <p className="mt-2 text-[13px] text-ink-soft">Parsing CSV&hellip;</p>
          </div>
        )}

        {preview && !receipt && (
          <>
            {(() => {
              const fields = [
                preview.fieldMapping.name,
                preview.fieldMapping.type,
                preview.fieldMapping.price,
                preview.fieldMapping.cost,
                preview.fieldMapping.description,
              ];
              const found = fields.filter((f) => f !== null).length;
              const total = fields.length;
              return (
                <section
                  className={cn(
                    "rounded-xl border px-5 py-3.5 flex items-start gap-3",
                    preview.fieldMapping.name
                      ? "border-emerald/30 bg-emerald-soft"
                      : "border-red-200 bg-red-50",
                  )}
                >
                  {preview.fieldMapping.name ? (
                    <Sparkles className="h-5 w-5 text-emerald shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-[14px] font-semibold",
                        preview.fieldMapping.name ? "text-emerald-ink" : "text-red-800",
                      )}
                    >
                      {preview.fieldMapping.name
                        ? `Auto-detected ${found} of ${total} columns`
                        : "No service-name column found"}
                    </div>
                    <div
                      className={cn(
                        "text-[12px] mt-0.5",
                        preview.fieldMapping.name ? "text-emerald-ink/85" : "text-red-700",
                      )}
                    >
                      {preview.fieldMapping.name
                        ? "Smart-mapping found your QB columns. Review the table below to confirm — anything marked 'not found' is optional and won't block the import."
                        : "Tell me which header is the service name and I'll teach the parser to recognize it."}
                    </div>
                  </div>
                </section>
              );
            })()}

            <section className="rounded-xl border border-rule bg-white px-5 py-4 space-y-3">
              <h3 className="text-[14px] font-semibold text-ink">Column mapping</h3>
              <table className="w-full text-[13px]">
                <tbody className="divide-y divide-rule">
                  <MappingRow label="Service name" header={preview.fieldMapping.name} required />
                  <MappingRow label="Service / Product type" header={preview.fieldMapping.type} hint="QB Type column (Service / Non-inventory). Non-service rows are skipped at import — they belong in /catalog/products once that CSV path ships." />
                  <MappingRow label="Sales price" header={preview.fieldMapping.price} />
                  <MappingRow label="Cost / COGS" header={preview.fieldMapping.cost} hint="Flows into cogs_per_service on each row — margin math hot on first import." />
                  <MappingRow label="Category" header={preview.fieldMapping.category} hint="If missing, we'll infer category from the service name (e.g. 'botox' → Tox)." />
                  <MappingRow label="Description / notes" header={preview.fieldMapping.description} />
                  <MappingRow label="Duration" header={preview.fieldMapping.duration} hint="Currently ignored — duration isn't stored on services yet." />
                </tbody>
              </table>
              {preview.headerRowIndex > 0 && (
                <p className="text-[12px] text-ink-soft">
                  <span className="font-semibold">Skipped {preview.headerRowIndex} preamble row{preview.headerRowIndex > 1 ? "s" : ""}</span>{" "}
                  before the header row (QuickBooks puts a company-name title row at the top).
                </p>
              )}
              {preview.unmappedHeaders.length > 0 && (
                <p className="text-[12px] text-ink-soft">
                  <span className="font-semibold">Ignored columns:</span>{" "}
                  {preview.unmappedHeaders.join(", ")}
                </p>
              )}
            </section>

            <section className="rounded-xl border border-rule bg-white px-5 py-4 space-y-3">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-[14px] font-semibold text-ink">Services</div>
                <SummaryChip label="Will create" value={preview.willCreate} tone="good" />
                {preview.willUpdate > 0 && (
                  <SummaryChip label="Will update" value={preview.willUpdate} tone="info" />
                )}
              </div>
              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-[14px] font-semibold text-ink">Products</div>
                <SummaryChip label="Will create" value={preview.willCreateProduct} tone="good" />
                {preview.willUpdateProduct > 0 && (
                  <SummaryChip label="Will update" value={preview.willUpdateProduct} tone="info" />
                )}
                {preview.matchedToCanonical > 0 && (
                  <SummaryChip label="Matched to brand registry" value={preview.matchedToCanonical} tone="good" />
                )}
              </div>
              <div className="flex items-center gap-4 flex-wrap pt-2 border-t border-rule">
                <div className="text-[12px] text-ink-soft">File totals</div>
                <SummaryChip label="Total rows" value={preview.totalRows} />
                <SummaryChip label="Parseable" value={preview.parseableRows} tone="good" />
                {preview.skippedRows > 0 && (
                  <SummaryChip label="Skipped" value={preview.skippedRows} tone="warn" />
                )}
                {preview.withCogs > 0 && (
                  <SummaryChip label="With COGS" value={preview.withCogs} tone="good" />
                )}
              </div>
              {preview.parseErrors.length > 0 && (
                <details className="text-[12px] text-ink-soft">
                  <summary className="cursor-pointer font-semibold">
                    {preview.parseErrors.length} skipped rows
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {preview.parseErrors.slice(0, 20).map((e) => (
                      <li key={e.rowIndex}>
                        Row {e.rowIndex}: {e.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>

            {preview.preview.length > 0 && (
              <section className="rounded-xl border border-rule bg-white px-5 py-4 space-y-3">
                <h3 className="text-[14px] font-semibold text-ink">
                  Preview <span className="text-ink-soft font-normal">(first {Math.min(30, preview.preview.length)} of {preview.preview.length})</span>
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wider text-ink-faint border-b border-rule">
                        <th className="text-left py-2 pr-3">Row</th>
                        <th className="text-left py-2 pr-3">Name</th>
                        <th className="text-left py-2 pr-3">Type</th>
                        <th className="text-left py-2 pr-3">Category</th>
                        <th className="text-right py-2 pr-3">Price</th>
                        <th className="text-right py-2 pr-3">COGS</th>
                        <th className="text-left py-2 pr-3">Action</th>
                        <th className="text-left py-2">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {preview.preview.slice(0, 30).map((r) => (
                        <tr key={r.rowIndex}>
                          <td className="py-2 pr-3 text-ink-soft tabular-nums">{r.rowIndex}</td>
                          <td className="py-2 pr-3 font-medium text-ink">
                            {r.parsedName}
                            {r.matchedBrand && r.matchedBrand !== r.parsedName && (
                              <span className="ml-2 text-[10px] text-emerald-ink bg-emerald-soft rounded px-1.5 py-0.5">
                                → {r.matchedBrand}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-[12px] text-ink-soft">
                            {r.rawType ?? "—"}
                          </td>
                          <td className="py-2 pr-3">
                            <span className="inline-flex items-center gap-1">
                              {r.isService ? categoryLabel(r.parsedCategory) : categoryLabel(r.productCategory as ServiceCategory)}
                              {r.isService && r.categorySource === "name-inferred" && (
                                <span className="text-[10px] text-ink-faint italic">(from name)</span>
                              )}
                              {r.isService && r.categorySource === "default" && (
                                <span className="text-[10px] text-ink-faint italic">(default)</span>
                              )}
                              {!r.isService && r.matchedBrand && (
                                <span className="text-[10px] text-emerald-ink italic">(from registry)</span>
                              )}
                              {!r.isService && !r.matchedBrand && (
                                <span className="text-[10px] text-ink-faint italic">(default)</span>
                              )}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{fmtUsd(r.parsedPrice)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {r.parsedCogs !== null ? (
                              fmtUsd(r.parsedCogs)
                            ) : (
                              <span className="text-ink-faint">—</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                                r.action === "create" && "bg-emerald-soft text-emerald-ink",
                                r.action === "update" && "bg-blue-50 text-blue-700",
                                r.action === "create-product" && "bg-emerald-soft text-emerald-ink",
                                r.action === "update-product" && "bg-blue-50 text-blue-700",
                              )}
                            >
                              {r.action === "create" && "Create svc"}
                              {r.action === "update" && "Update svc"}
                              {r.action === "create-product" && "Create prod"}
                              {r.action === "update-product" && "Update prod"}
                            </span>
                          </td>
                          <td className="py-2 text-[12px] text-ink-soft">
                            {r.warnings.length > 0 ? r.warnings.join(" · ") : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <div className="flex items-center gap-3">
              {(() => {
                const totalToWrite =
                  preview.willCreate + preview.willUpdate +
                  preview.willCreateProduct + preview.willUpdateProduct;
                const svcCount = preview.willCreate + preview.willUpdate;
                const prodCount = preview.willCreateProduct + preview.willUpdateProduct;
                const blocked = committing || totalToWrite === 0 || !preview.fieldMapping.name;
                return (
                  <button
                    type="button"
                    onClick={onCommit}
                    disabled={blocked}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition",
                      blocked
                        ? "bg-rule text-ink-faint cursor-not-allowed"
                        : "bg-emerald text-paper hover:opacity-95",
                    )}
                  >
                    {committing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Importing&hellip;
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4" />
                        Import {svcCount} service{svcCount === 1 ? "" : "s"} + {prodCount} product{prodCount === 1 ? "" : "s"}
                      </>
                    )}
                  </button>
                );
              })()}
              <button
                type="button"
                onClick={clearAll}
                disabled={committing}
                className="text-[13px] text-ink-soft hover:text-ink transition"
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {receipt && (
          <section className="rounded-xl border-2 border-emerald/30 bg-emerald-soft px-5 py-5 space-y-3">
            <h3 className="text-[16px] font-semibold text-emerald-ink flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5" />
              Import complete
            </h3>
            <div className="text-[14px] text-ink space-y-1">
              <div>
                <span className="font-semibold tabular-nums">{receipt.created}</span> new services created
              </div>
              <div>
                <span className="font-semibold tabular-nums">{receipt.updated}</span> existing services updated
              </div>
              <div>
                <span className="font-semibold tabular-nums">{receipt.productsCreated}</span> new products created
              </div>
              <div>
                <span className="font-semibold tabular-nums">{receipt.productsUpdated}</span> existing products updated
              </div>
              {receipt.failed.length > 0 && (
                <div className="text-red-700">
                  <span className="font-semibold tabular-nums">{receipt.failed.length}</span> rows failed
                  <ul className="mt-1 text-[12px] space-y-0.5">
                    {receipt.failed.map((f) => (
                      <li key={f.rowIndex}>
                        Row {f.rowIndex} ({f.name}): {f.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => navigate({ to: "/app/refill/catalog/services" })}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
              >
                <ClipboardList className="h-4 w-4" />
                View services
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="text-[13px] text-ink-soft hover:text-ink transition"
              >
                Import another file
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function MappingRow({
  label,
  header,
  required,
  hint,
}: {
  label: string;
  header: string | null;
  required?: boolean;
  hint?: string;
}) {
  return (
    <tr>
      <td className="py-2 pr-3 text-ink-soft">
        {header && <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald mr-1.5 -mt-0.5" />}
        {label}
        {required && <span className="text-red-600">*</span>}
      </td>
      <td className="py-2 pr-3">
        {header ? (
          <code className="text-[12px] bg-emerald-soft text-emerald-ink rounded px-2 py-0.5">{header}</code>
        ) : (
          <span className="text-[12px] text-ink-faint italic">&mdash;</span>
        )}
      </td>
      <td className="py-2 text-[11px] text-ink-soft italic">{hint ?? ""}</td>
    </tr>
  );
}

function SummaryChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "good" | "warn" | "info";
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]",
        tone === "good" && "bg-emerald-soft text-emerald-ink",
        tone === "warn" && "bg-amber-soft text-amber",
        tone === "info" && "bg-blue-50 text-blue-700",
        tone === "neutral" && "bg-bg-soft text-ink-soft",
      )}
    >
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="opacity-75">{label}</span>
    </div>
  );
}
