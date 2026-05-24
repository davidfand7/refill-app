/**
 * /app/refill/patients/contacts — Patient Architecture P1.5 contacts surface.
 *
 * Three jobs in one page:
 *   1. Upload the spa's client-list CSV (phone + email + banned, sourced
 *      from the scheduling software — NOT QuickBooks).
 *   2. Show contact-coverage stats so the spa owner can see at a glance
 *      "how reachable is my patient book?".
 *   3. Surface the 276-patient gap with fuzzy-match suggestions: side-by-
 *      side patient vs candidate cards with Confirm / Dismiss CTAs.
 *
 * The 661 clients-no-sales bucket lives in patient_contact_candidates with
 * status='unmatched' and shows up implicitly via the fuzzy pool — no
 * standalone "review junk clients" UI in P1.5 (deferred to a future
 * Tier C ship).
 *
 * Established 2026-05-15 (Patient Architecture P1.5).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  FileText,
  Loader2,
  Mail,
  Phone,
  ShieldAlert,
  Sparkles,
  Upload,
  Users,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import {
  confirmContactSuggestion,
  dismissContactSuggestion,
  ingestClientListCsv,
  listContactGaps,
  listContactsOverview,
  type ClientListReceipt,
  type ContactGap,
  type ContactsOverview,
} from "@/server/patient-ingest.functions";

export const Route = createFileRoute("/app/refill/patients/contacts")({
  component: ContactsPage,
});

type Stage =
  | "idle"
  | "previewing"
  | "preview-ready"
  | "ingesting"
  | "done"
  | "error";

function ContactsPage() {
  const [overview, setOverview] = useState<ContactsOverview | null>(null);
  const [gaps, setGaps] = useState<ContactGap[] | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ClientListReceipt | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setErrorMessage("Please sign in to manage contacts.");
        return;
      }
      const [ov, gs] = await Promise.all([
        listContactsOverview({ data: { accessToken: token } }),
        listContactGaps({ data: { accessToken: token, limit: 200 } }),
      ]);
      setOverview(ov);
      setGaps(gs);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Couldn't load contacts.");
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleFile(f: File) {
    if (!/\.csv$/i.test(f.name)) {
      toast.error("That doesn't look like a CSV file.");
      return;
    }
    setFile(f);
    setStage("preview-ready");
    setErrorMessage(null);
  }

  async function commit() {
    if (!file) return;
    setStage("ingesting");
    try {
      const text = await file.text();
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setStage("error");
        setErrorMessage("Sign-in lost — refresh and try again.");
        return;
      }
      const r = await ingestClientListCsv({
        data: { accessToken: token, csv: text, sourceFilename: file.name },
      });
      setReceipt(r);
      setStage("done");
      toast.success(
        `Linked contact info for ${r.patientsEnriched.toLocaleString()} patient${r.patientsEnriched === 1 ? "" : "s"}.`,
      );
      await loadAll();
    } catch (e) {
      setStage("error");
      setErrorMessage(
        e instanceof Error ? e.message : "Couldn't import — please try again.",
      );
    }
  }

  function resetUpload() {
    setStage("idle");
    setFile(null);
    setReceipt(null);
    setErrorMessage(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onConfirm(patientNodeId: string, candidateId: string) {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return toast.error("Sign-in lost — refresh and try again.");
    try {
      await confirmContactSuggestion({
        data: { accessToken: token, patientNodeId, candidateId },
      });
      toast.success("Contact info linked.");
      // Optimistic: drop the patient from the gaps list immediately.
      setGaps((prev) => prev?.filter((g) => g.id !== patientNodeId) ?? null);
      void loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't confirm.");
    }
  }

  async function onDismiss(candidateId: string, patientNodeId: string) {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return toast.error("Sign-in lost — refresh and try again.");
    try {
      await dismissContactSuggestion({
        data: { accessToken: token, candidateId, patientNodeId },
      });
      toast.success("Suggestion dismissed.");
      // Optimistic: remove just that suggestion. Keep the patient row if
      // there are other suggestions remaining.
      setGaps((prev) =>
        prev?.map((g) =>
          g.id === patientNodeId
            ? {
                ...g,
                suggestions: g.suggestions.filter(
                  (s) => s.candidate.id !== candidateId,
                ),
              }
            : g,
        ) ?? null,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't dismiss.");
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Emma(OS) · Patients"
        title="Contacts"
        description="Connect phone and email to every patient so Emma can reach them."
        breadcrumbs={[
          { label: "Emma", to: "/app/refill" },
          { label: "Patients", to: "/app/refill/patients" },
          { label: "Contacts" },
        ]}
        actions={
          <Link
            to="/app/refill/patients"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to patients
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-6xl mx-auto space-y-6">
        {/* Coverage card */}
        {overview && <CoverageCard overview={overview} />}

        {/* Upload card — collapses to a one-line "Upload another" CTA once
            a client list has landed. */}
        {!overview?.hasClientList && stage === "idle" && (
          <UploadCard
            isDragging={isDragging}
            setIsDragging={setIsDragging}
            onFile={(f) => void handleFile(f)}
            inputRef={inputRef}
            firstTime
          />
        )}

        {overview?.hasClientList && stage === "idle" && (
          <UploadCard
            isDragging={isDragging}
            setIsDragging={setIsDragging}
            onFile={(f) => void handleFile(f)}
            inputRef={inputRef}
            firstTime={false}
          />
        )}

        {stage === "preview-ready" && file && (
          <ConfirmUploadCard
            file={file}
            onCancel={resetUpload}
            onCommit={() => void commit()}
          />
        )}

        {stage === "ingesting" && (
          <div className="rounded-2xl border border-border bg-card p-10 flex items-center justify-center gap-3 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Matching contacts to patients…
          </div>
        )}

        {stage === "done" && receipt && (
          <UploadReceiptCard receipt={receipt} onAnother={resetUpload} />
        )}

        {stage === "error" && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
              <div className="flex-1">
                <div className="text-sm font-semibold text-destructive">
                  Couldn't process that file
                </div>
                <p className="text-xs text-ink-soft mt-1">
                  {errorMessage ?? "Something went wrong."}
                </p>
                <button
                  type="button"
                  onClick={resetUpload}
                  className="mt-3 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Suggestions — fuzzy matches with Confirm / Dismiss. */}
        {gaps === null && !errorMessage ? (
          <div className="py-8 flex items-center justify-center gap-2 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading suggestions…
          </div>
        ) : (
          <SuggestionsSection
            gaps={gaps ?? []}
            onConfirm={onConfirm}
            onDismiss={onDismiss}
          />
        )}
      </div>
    </div>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function CoverageCard({ overview }: { overview: ContactsOverview }) {
  const pct = (n: number) =>
    overview.totalPatients > 0
      ? `${Math.round((n / overview.totalPatients) * 100)}%`
      : "—";
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            Contact coverage
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            {overview.totalPatients.toLocaleString()} patients ·
            {overview.hasClientList ? " client list loaded" : " no client list yet"}
          </div>
        </div>
        {overview.bannedPatientCount > 0 && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-[11px] font-semibold text-destructive">
            <ShieldAlert className="h-3 w-3" />
            {overview.bannedPatientCount} banned
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-border">
        <Stat
          label="Reachable"
          value={overview.patientsWithContact.toLocaleString()}
          note={pct(overview.patientsWithContact)}
        />
        <Stat
          label="With phone"
          value={overview.patientsWithPhone.toLocaleString()}
          note={pct(overview.patientsWithPhone)}
        />
        <Stat
          label="With email"
          value={overview.patientsWithEmail.toLocaleString()}
          note={pct(overview.patientsWithEmail)}
        />
        <Stat
          label="Contact gap"
          value={overview.contactGapCount.toLocaleString()}
          note={pct(overview.contactGapCount)}
        />
      </div>
    </div>
  );
}

function UploadCard({
  isDragging,
  setIsDragging,
  onFile,
  inputRef,
  firstTime,
}: {
  isDragging: boolean;
  setIsDragging: (b: boolean) => void;
  onFile: (f: File) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  firstTime: boolean;
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

  if (!firstTime) {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-3 flex items-center justify-between gap-3">
        <div className="text-xs text-ink-soft">
          Got a fresh client list? Upload it to refresh phone, email, and
          banned flags.
        </div>
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
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload client list
        </button>
      </div>
    );
  }

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
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:bg-muted/50")
      }
    >
      <div className="mx-auto h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
        <Upload className="h-6 w-6 text-primary" />
      </div>
      <div className="text-base font-semibold mb-1">
        Drop your client list CSV
      </div>
      <p className="text-sm text-ink-soft max-w-md mx-auto leading-relaxed">
        Export your client list from your scheduling software (with First
        Name, Last Name, Phone, Email, Days Since Last Appointment, Banned).
        Emma matches it to your QuickBooks patients.
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
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 transition"
        >
          <FileText className="h-4 w-4" />
          Choose a CSV
        </button>
      </div>
    </div>
  );
}

function ConfirmUploadCard({
  file,
  onCancel,
  onCommit,
}: {
  file: File;
  onCancel: () => void;
  onCommit: () => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            {file.name}
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            {(file.size / 1024).toFixed(1)} KB · Ready to match
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
      <div className="px-5 py-4 text-xs text-ink-soft leading-relaxed">
        We'll parse the file, exact-match on patient names, write phone +
        email + banned onto matching patients, and surface anything that
        didn't match as a one-click suggestion below.
      </div>
      <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
        >
          Choose a different file
        </button>
        <button
          type="button"
          onClick={onCommit}
          className="rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
        >
          Match contacts
        </button>
      </div>
    </div>
  );
}

function UploadReceiptCard({
  receipt,
  onAnother,
}: {
  receipt: ClientListReceipt;
  onAnother: () => void;
}) {
  return (
    <div className="rounded-2xl border border-good-rule bg-good-bg dark:bg-good-bg/30 overflow-hidden">
      <div className="px-5 py-4 flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">Client list matched</div>
          <p className="text-xs text-ink-soft mt-0.5 leading-relaxed">
            Phone + email + banned now live on{" "}
            {receipt.patientsEnriched.toLocaleString()} of your patient records.
            {receipt.salesNoClient > 0 && (
              <>
                {" "}
                {receipt.salesNoClient.toLocaleString()} patient
                {receipt.salesNoClient === 1 ? "" : "s"} still need contact
                info — check the suggestions below.
              </>
            )}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-emerald-500/10 border-t border-emerald-500/20">
        <Stat
          label="Matched"
          value={receipt.exactMatches.toLocaleString()}
        />
        <Stat
          label="Banned flagged"
          value={receipt.bannedCount.toLocaleString()}
        />
        <Stat
          label="Phone on file"
          value={receipt.withPhone.toLocaleString()}
        />
        <Stat
          label="Email on file"
          value={receipt.withEmail.toLocaleString()}
        />
      </div>
      <div className="px-5 py-3 border-t border-emerald-500/20 flex items-center justify-end">
        <button
          type="button"
          onClick={onAnother}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
        >
          Upload another
        </button>
      </div>
    </div>
  );
}

function SuggestionsSection({
  gaps,
  onConfirm,
  onDismiss,
}: {
  gaps: ContactGap[];
  onConfirm: (patientNodeId: string, candidateId: string) => void;
  onDismiss: (candidateId: string, patientNodeId: string) => void;
}) {
  const withSuggestions = useMemo(
    () => gaps.filter((g) => g.suggestions.length > 0),
    [gaps],
  );
  const withoutSuggestions = useMemo(
    () => gaps.filter((g) => g.suggestions.length === 0),
    [gaps],
  );

  if (gaps.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="All caught up"
        description="Every patient in your book has contact info on file."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Suggested matches
          </h2>
          <div className="text-[11px] text-ink-soft">
            {withSuggestions.length.toLocaleString()} patient
            {withSuggestions.length === 1 ? "" : "s"} with likely candidates
          </div>
        </div>
        {withSuggestions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/50 p-6 text-center text-xs text-ink-soft">
            No fuzzy matches found. Upload your client list to seed
            suggestions.
          </div>
        ) : (
          <div className="space-y-3">
            {withSuggestions.map((g) => (
              <GapRow
                key={g.id}
                gap={g}
                onConfirm={onConfirm}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        )}
      </div>

      {withoutSuggestions.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-base font-semibold">
              No match suggestions yet
            </h2>
            <div className="text-[11px] text-ink-soft">
              {withoutSuggestions.length.toLocaleString()} patient
              {withoutSuggestions.length === 1 ? "" : "s"} ranked by spend
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-ink-soft">
                    <th className="px-4 py-3 font-semibold">Patient</th>
                    <th className="px-4 py-3 font-semibold text-right">Visits</th>
                    <th className="px-4 py-3 font-semibold text-right">
                      Lifetime spend
                    </th>
                    <th className="px-4 py-3 font-semibold">Last visit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {withoutSuggestions.slice(0, 50).map((g) => (
                    <tr key={g.id} className="hover:bg-muted/40 transition">
                      <td className="px-4 py-3 font-medium">{g.displayName}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {g.totalVisits.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        {g.lifetimeSpendUsd.toLocaleString("en-US", {
                          style: "currency",
                          currency: "USD",
                          maximumFractionDigits: 0,
                        })}
                      </td>
                      <td className="px-4 py-3 text-ink-soft">
                        {g.lastVisit ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {withoutSuggestions.length > 50 && (
              <div className="px-4 py-3 border-t border-border text-[11px] text-ink-soft">
                Showing top 50 by lifetime spend.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GapRow({
  gap,
  onConfirm,
  onDismiss,
}: {
  gap: ContactGap;
  onConfirm: (patientNodeId: string, candidateId: string) => void;
  onDismiss: (candidateId: string, patientNodeId: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-muted/30 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{gap.displayName}</div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            {gap.totalVisits} visits ·{" "}
            {gap.lifetimeSpendUsd.toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 0,
            })}{" "}
            lifetime
            {gap.primaryManufacturer && <> · primary {gap.primaryManufacturer}</>}
          </div>
        </div>
      </div>
      <div className="px-5 py-3 text-[11px] text-ink-soft">
        {gap.suggestions.length === 1
          ? "Is this the same person?"
          : "Are any of these the same person?"}
      </div>
      <div className="divide-y divide-border">
        {gap.suggestions.map((s) => (
          <div
            key={s.candidate.id}
            className="px-5 py-4 flex items-center justify-between gap-4"
          >
            <div className="flex-1">
              <div className="text-sm font-medium flex items-center gap-2">
                {s.candidate.displayName}
                <ConfidenceChip distance={s.distance} />
                {s.candidate.banned && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 text-destructive px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                    <Ban className="h-3 w-3" />
                    Banned
                  </span>
                )}
              </div>
              <div className="text-[11px] text-ink-soft mt-1 flex items-center gap-3 flex-wrap">
                {s.candidate.phone && (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    {formatPhone(s.candidate.phone)}
                  </span>
                )}
                {s.candidate.email && (
                  <span className="inline-flex items-center gap-1">
                    <Mail className="h-3 w-3" />
                    {s.candidate.email}
                  </span>
                )}
                {!s.candidate.phone && !s.candidate.email && (
                  <span className="text-ink-faint">No phone or email</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onDismiss(s.candidate.id, gap.id)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-foreground hover:bg-muted transition"
              >
                Not this one
              </button>
              <button
                type="button"
                onClick={() => onConfirm(gap.id, s.candidate.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Confirm match
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfidenceChip({ distance }: { distance: number }) {
  const label =
    distance === 0 ? "Exact" : distance === 1 ? "Very close" : "Close";
  const cls =
    distance === 0
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : distance === 1
        ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
        : "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
        cls
      }
    >
      {label}
    </span>
  );
}

function formatPhone(e164: string): string {
  // +1XXXXXXXXXX → (XXX) XXX-XXXX. Leaves international numbers as-is.
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="px-5 py-4">
      <div className="text-[10px] uppercase tracking-wider text-ink-soft font-semibold">
        {label}
      </div>
      <div className="text-xl font-semibold mt-1">{value}</div>
      {note && <div className="text-[11px] text-ink-faint mt-0.5">{note}</div>}
    </div>
  );
}
