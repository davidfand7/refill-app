/**
 * /app/refill/patients/import — drag-drop CSV upload for Patient Architecture P1.
 *
 * Accepts a QuickBooks "Sales by Patient Detail" export, parses it client-side
 * for an instant preview, then on confirm POSTs the raw CSV to ingestPatientCsv
 * (server) which upserts patient knowledge_nodes + bulk-inserts
 * patient_transactions + re-rolls each touched patient's summary.
 *
 * Preview-before-commit mirrors Reports v1's upload flow. The spa owner sees
 * patient count + line count + revenue total + any unknown products BEFORE
 * anything writes — so a wrong file kicks back cheaply.
 *
 * Established 2026-05-15 (Patient Architecture P1).
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { parsePatientDetailCsv, type ParsedPatientFile } from "@/lib/patient-csv";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { ingestPatientCsv, type IngestReceipt } from "@/server/patient-ingest.functions";

export const Route = createFileRoute("/app/refill/patients/import")({
  component: ImportPatientsPage,
});

type Stage = "idle" | "previewing" | "preview-ready" | "ingesting" | "done" | "error";

type FileState = {
  name: string;
  size: number;
  text: string;
};

function ImportPatientsPage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("idle");
  const [file, setFile] = useState<FileState | null>(null);
  const [preview, setPreview] = useState<ParsedPatientFile | null>(null);
  const [receipt, setReceipt] = useState<IngestReceipt | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // v1.20.5: when admin is observing a tenant via the admin-bypass shell,
  // route the ingest under that tenant's owner user_id instead of the
  // admin's own bucket. Plumbed through to ingestPatientCsv, which uses
  // resolveEffectiveUserId for the server-side admin re-verification.
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  function reset() {
    setStage("idle");
    setFile(null);
    setPreview(null);
    setReceipt(null);
    setErrorMessage(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFile(f: File) {
    if (!/\.csv$/i.test(f.name)) {
      toast.error("That doesn't look like a CSV file.");
      return;
    }
    setStage("previewing");
    setErrorMessage(null);
    try {
      const text = await f.text();
      const parsed = parsePatientDetailCsv(text, { sourceFilename: f.name });
      if (parsed.patients.length === 0) {
        setStage("error");
        setErrorMessage(
          "Couldn't find any patient sections. Is this a QuickBooks 'Sales by Patient Detail' export?",
        );
        return;
      }
      setFile({ name: f.name, size: f.size, text });
      setPreview(parsed);
      setStage("preview-ready");
    } catch (e) {
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  }

  async function commit() {
    if (!file || !preview) return;
    setStage("ingesting");
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setStage("error");
        setErrorMessage("Sign-in lost — refresh and try again.");
        return;
      }
      const r = await ingestPatientCsv({
        data: {
          accessToken: token,
          csv: file.text,
          sourceFilename: file.name,
          viewAsUserId,
        },
      });
      setReceipt(r);
      setStage("done");
      toast.success(
        `Imported ${r.transactionsInserted.toLocaleString()} transaction${r.transactionsInserted === 1 ? "" : "s"} for ${r.patientsTouched.toLocaleString()} patient${r.patientsTouched === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setStage("error");
      setErrorMessage(
        e instanceof Error ? e.message : "Couldn't import — please try again.",
      );
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Refill · Patients"
        title="Import patient data"
        description="Drop a QuickBooks ‘Sales by Patient Detail’ export. Refill turns it into a queryable patient book."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Patients", to: "/app/refill/patients" },
          { label: "Import" },
        ]}
        actions={
          <Link
            to="/app/refill/patients"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-[1600px] mx-auto space-y-6">
        {viewAsUserId && membership.status === "tenant" && (
          <div
            className="rounded-lg border px-3 py-2 text-[12px] flex items-center gap-2"
            style={{
              background: "#fdf6dc",
              borderColor: "rgba(138, 109, 12, 0.3)",
              color: "#8a6d0c",
            }}
            role="status"
            aria-label="Upload destination notice"
          >
            <Upload className="h-3.5 w-3.5 shrink-0" />
            <span>
              Uploading into <strong>{membership.tenant.name}</strong>.
              Patients and transactions will land in this tenant&rsquo;s
              bucket (v1.20.5), not yours.
            </span>
          </div>
        )}

        {stage === "idle" || stage === "previewing" ? (
          <Dropzone
            isDragging={isDragging}
            setIsDragging={setIsDragging}
            onFile={(f) => void handleFile(f)}
            inputRef={inputRef}
            busy={stage === "previewing"}
          />
        ) : null}

        {stage === "preview-ready" && preview && file && (
          <PreviewCard
            file={file}
            preview={preview}
            onCancel={reset}
            onConfirm={() => void commit()}
          />
        )}

        {stage === "ingesting" && (
          <div className="rounded-2xl border border-border bg-card p-10 flex items-center justify-center gap-3 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Saving patients and transactions…
          </div>
        )}

        {stage === "done" && receipt && (
          <ReceiptCard
            receipt={receipt}
            onAnother={reset}
            onView={() => void navigate({ to: "/app/refill/patients" })}
          />
        )}

        {stage === "error" && (
          <ErrorCard message={errorMessage ?? "Something went wrong."} onRetry={reset} />
        )}
      </div>
    </div>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function Dropzone({
  isDragging,
  setIsDragging,
  onFile,
  inputRef,
  busy,
}: {
  isDragging: boolean;
  setIsDragging: (b: boolean) => void;
  onFile: (f: File) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  busy: boolean;
}) {
  useEffect(() => {
    function onDrag(e: DragEvent) {
      e.preventDefault();
    }
    window.addEventListener("dragover", onDrag);
    window.addEventListener("drop", onDrag);
    return () => {
      window.removeEventListener("dragover", onDrag);
      window.removeEventListener("drop", onDrag);
    };
  }, []);

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={
        "rounded-2xl border-2 border-dashed p-10 text-center transition " +
        (isDragging
          ? "border-emerald bg-emerald/5"
          : "border-border bg-card hover:bg-muted/50")
      }
    >
      <div className="mx-auto h-14 w-14 rounded-2xl bg-emerald/10 flex items-center justify-center mb-4">
        {busy ? (
          <Loader2 className="h-6 w-6 text-emerald animate-spin" />
        ) : (
          <Upload className="h-6 w-6 text-emerald" />
        )}
      </div>
      <div className="text-base font-semibold mb-1">
        {busy ? "Reading your file…" : "Drop your QuickBooks export"}
      </div>
      <p className="text-sm text-ink-soft max-w-md mx-auto leading-relaxed">
        In QuickBooks: <em>Reports → Sales → Sales by Patient Detail</em>, export
        as CSV. Drop it here, or click to choose.
      </p>
      <div className="mt-5">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-60 transition"
        >
          <FileText className="h-4 w-4" />
          Choose a CSV
        </button>
      </div>
      <p className="mt-4 text-[11px] text-ink-faint">
        Files stay private to your spa. Reps never see this data without your
        explicit per-rep consent.
      </p>
    </div>
  );
}

function PreviewCard({
  file,
  preview,
  onCancel,
  onConfirm,
}: {
  file: FileState;
  preview: ParsedPatientFile;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const revenue = useMemo(
    () =>
      preview.totals.revenueUsd.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }),
    [preview.totals.revenueUsd],
  );

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4 text-emerald" />
            {file.name}
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            {(file.size / 1024).toFixed(1)} KB ·
            {preview.businessName ? ` ${preview.businessName} ·` : ""}
            {preview.dateRangeLabel ? ` ${preview.dateRangeLabel}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-ink-soft hover:text-foreground transition"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-3 divide-x divide-border">
        <Stat
          label="Patients"
          value={preview.totals.patientCount.toLocaleString()}
        />
        <Stat
          label="Transaction lines"
          value={preview.totals.transactionCount.toLocaleString()}
        />
        <Stat label="Total revenue" value={revenue} />
      </div>

      {preview.unknownProductNames.length > 0 && (
        <div className="px-5 py-3 border-t border-border bg-amber-50 dark:bg-amber-950/20">
          <div className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" />
            {preview.unknownProductNames.length} product
            {preview.unknownProductNames.length === 1 ? "" : "s"} we don't recognize yet
          </div>
          <p className="text-[11px] text-amber-700 dark:text-amber-200/80 mt-1">
            They'll still import — they just won't have a manufacturer label.
            We'll surface them for review later. First few:
          </p>
          <div className="text-[11px] mt-1.5 font-mono text-amber-900 dark:text-amber-100/90 leading-relaxed">
            {preview.unknownProductNames.slice(0, 6).join(" · ")}
            {preview.unknownProductNames.length > 6
              ? ` · +${preview.unknownProductNames.length - 6} more`
              : ""}
          </div>
        </div>
      )}

      {preview.warnings.length > 0 && (
        <div className="px-5 py-3 border-t border-border text-[11px] text-ink-soft">
          {preview.warnings.length} row
          {preview.warnings.length === 1 ? "" : "s"} skipped (blank product names
          or unrecognized shape).
        </div>
      )}

      <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border bg-background px-4 py-2 text-xs font-medium hover:bg-muted transition"
        >
          Choose a different file
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-4 py-2 text-xs font-semibold hover:opacity-90 transition"
        >
          <Users className="h-3.5 w-3.5" />
          Import these patients
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-4">
      <div className="text-[10px] uppercase tracking-wider text-ink-soft font-semibold">
        {label}
      </div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function ReceiptCard({
  receipt,
  onAnother,
  onView,
}: {
  receipt: IngestReceipt;
  onAnother: () => void;
  onView: () => void;
}) {
  return (
    <div className="rounded-2xl border border-good-rule bg-good-bg dark:bg-good-bg/30 overflow-hidden">
      <div className="px-5 py-4 flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">Import complete</div>
          <p className="text-xs text-ink-soft mt-0.5 leading-relaxed">
            {receipt.businessName ? `${receipt.businessName} · ` : ""}
            {receipt.dateRangeLabel}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-emerald-500/10 border-t border-emerald-500/20">
        <Stat
          label="Patients touched"
          value={receipt.patientsTouched.toLocaleString()}
        />
        <Stat
          label="New patients"
          value={receipt.patientsCreated.toLocaleString()}
        />
        <Stat
          label="Lines inserted"
          value={receipt.transactionsInserted.toLocaleString()}
        />
        <Stat
          label="Already present"
          value={receipt.transactionsSkipped.toLocaleString()}
        />
      </div>

      {receipt.unknownProducts.length > 0 && (
        <div className="px-5 py-3 border-t border-emerald-500/20 text-xs text-ink-soft">
          {receipt.unknownProducts.length} unknown product
          {receipt.unknownProducts.length === 1 ? "" : "s"} flagged for review.
        </div>
      )}

      <div className="px-5 py-4 border-t border-emerald-500/20 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onAnother}
          className="rounded-lg border border-border bg-background px-4 py-2 text-xs font-medium hover:bg-muted transition"
        >
          Import another
        </button>
        <button
          type="button"
          onClick={onView}
          className="rounded-lg bg-emerald text-paper px-4 py-2 text-xs font-semibold hover:opacity-90 transition"
        >
          View patients
        </button>
      </div>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-destructive">
            Couldn't import that file
          </div>
          <p className="text-xs text-ink-soft mt-1 leading-relaxed">{message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
