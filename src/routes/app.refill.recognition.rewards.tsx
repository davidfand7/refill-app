/**
 * /app/refill/recognition/rewards — Manufacturer reward signals
 * (Patient-Profitability OS · P0).
 *
 * Upload a manufacturer's patient-insights export (Evolus first). We parse
 * it, match each patient to your own patient graph, and surface the
 * money-on-the-table the manufacturer's 0-click email never moves:
 * who's eligible now, whose reward is expiring, who's lapsed. This is the
 * raw material Phase 1 (Recall) turns into booked appointments.
 *
 * Reads/writes go through manufacturer-reward-ingest.functions.ts (service
 * role). The Recognition sub-nav now carries three tabs: Inventory /
 * Manufacturers / Rewards.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  Check,
  Copy,
  Loader2,
  Mail,
  Plus,
  Tag,
  Trash2,
  Upload,
  Gift,
  Sparkles,
  KeyRound,
  RotateCw,
  MonitorDown,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { RecognitionTabs } from "@/components/refill/RecognitionTabs";
import { SpaOffersCard } from "@/components/refill/SpaOffersCard";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { listSupportedManufacturers } from "@/lib/manufacturer-reward-csv";
import {
  ingestManufacturerRewardCsv,
  listRewardSignal,
  getOrCreateRewardIngestToken,
  rotateRewardIngestToken,
  type RewardSignalView,
  type RewardImportReceipt,
  type RewardEntryRow,
} from "@/server/manufacturer-reward-ingest.functions";
import {
  ingestPromoCalendar,
  listPromoOffers,
  createSpaOffer,
  deleteSpaOffer,
} from "@/server/refill-promo-calendar.functions";
import {
  ingestManufacturerTransactionCsv,
  type LastTxnImportReceipt,
} from "@/server/manufacturer-transaction-ingest.functions";
import { listServicesFn, type Service } from "@/server/refill-catalog";
import type { PromoOffer } from "@/lib/promo-calendar";

export const Route = createFileRoute("/app/refill/recognition/rewards")({
  component: RewardsPage,
});

const SUPPORTED = listSupportedManufacturers();

type StatusFilter = "all" | "eligible" | "expiring_soon" | "expired" | "not_yet_eligible";

function RewardsPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [view, setView] = useState<RewardSignalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [manufacturer, setManufacturer] = useState(SUPPORTED[0]?.manufacturer ?? "evolus");
  const [uploading, setUploading] = useState(false);
  const [receipt, setReceipt] = useState<RewardImportReceipt | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      setAccessToken(token);
      const v = await listRewardSignal({ data: { accessToken: token, viewAsUserId } });
      setView(v);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setLoading(false);
    }
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  async function handleFile(file: File) {
    if (!accessToken) return;
    setUploading(true);
    setReceipt(null);
    try {
      const csv = await file.text();
      const r = await ingestManufacturerRewardCsv({
        data: { accessToken, viewAsUserId, manufacturer, csv, sourceFilename: file.name },
      });
      setReceipt(r);
      toast.success(
        `${r.entriesUpserted.toLocaleString()} reward signals imported · ${r.matched.toLocaleString()} matched to your patients`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const summary = view?.summary;
  const entries = view?.entries ?? [];
  const filtered =
    filter === "all" ? entries : entries.filter((e) => e.statusNorm === filter);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Reward signals"
        eyebrow="Promos"
        description="Upload a manufacturer's patient-insights export. Refill matches each patient to your book and surfaces who's eligible now and whose reward is expiring — the money their 0-click email never moves."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Promos", to: "/app/refill/recognition/inventory" },
          { label: "Rewards" },
        ]}
      />

      <RecognitionTabs active="rewards" />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-5">
        {loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">Couldn't load</div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
          </div>
        ) : (
          <>
            {/* Upload card */}
            <div className="rounded-2xl border border-rule bg-white p-5">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                    Manufacturer
                  </label>
                  <select
                    value={manufacturer}
                    onChange={(e) => setManufacturer(e.target.value)}
                    className="rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  >
                    {SUPPORTED.map((m) => (
                      <option key={m.manufacturer} value={m.manufacturer}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-sm font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {uploading ? "Importing…" : "Upload rewards CSV"}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                  }}
                />
                <p className="text-[11px] text-ink-faint">
                  Evolus · Allergan (Allē) · Galderma (ASPIRE) — pick the matching
                  report above, then upload its export.
                </p>
              </div>

              {receipt && (
                <div className="mt-4 rounded-xl border border-emerald/30 bg-emerald-soft/40 px-4 py-3 text-[12px] text-emerald-ink">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Imported {receipt.dataRows.toLocaleString()} patients →{" "}
                    {receipt.entriesUpserted.toLocaleString()} reward signals
                  </div>
                  <p className="mt-1 text-ink-soft">
                    {receipt.matched.toLocaleString()} matched to your patient book ·{" "}
                    {receipt.unmatchedWithContact.toLocaleString()} have contact but no
                    matched patient ·{" "}
                    {receipt.contactsFilled.toLocaleString()} contact gaps filled.
                    {receipt.warnings.length > 0 &&
                      ` ${receipt.warnings.length} warning(s).`}
                  </p>
                </div>
              )}
            </div>

            <AutoImportCard accessToken={accessToken} viewAsUserId={viewAsUserId} />

            <LastTransactionCard
              accessToken={accessToken}
              viewAsUserId={viewAsUserId}
              onImported={load}
            />

            <PromoCalendarCard accessToken={accessToken} viewAsUserId={viewAsUserId} />

            <SpaOffersCard accessToken={accessToken} viewAsUserId={viewAsUserId} />

            {loading ? (
              <div className="flex items-center justify-center text-sm text-ink-soft py-16">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading…
              </div>
            ) : entries.length === 0 ? (
              <EmptyState />
            ) : (
              <>
                {/* Headline stats */}
                {summary && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Stat
                      label="Eligible now"
                      value={summary.eligibleNow.toLocaleString()}
                      tone="emerald"
                      onClick={() => setFilter("eligible")}
                    />
                    <Stat
                      label="Expiring ≤60d"
                      value={summary.expiringSoon.toLocaleString()}
                      tone="amber"
                      icon={<CalendarClock className="h-3.5 w-3.5" />}
                      onClick={() => setFilter("expiring_soon")}
                    />
                    <Stat
                      label="Patients"
                      value={summary.distinctPatients.toLocaleString()}
                      tone="plain"
                    />
                    <Stat
                      label="On the table"
                      value={`$${Math.round(summary.dollarsOnTable).toLocaleString()}`}
                      tone="plain"
                    />
                  </div>
                )}

                {/* Status filter chips */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      ["all", "All"],
                      ["eligible", "Eligible"],
                      ["expiring_soon", "Expiring"],
                      ["not_yet_eligible", "Becoming eligible"],
                      ["expired", "Expired"],
                    ] as Array<[StatusFilter, string]>
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilter(key)}
                      className="inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold transition"
                      style={{
                        background: filter === key ? "#056048" : "transparent",
                        color: filter === key ? "#fbfaf7" : "#5a6068",
                        border:
                          filter === key ? "1px solid #056048" : "1px solid #e6e2d6",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="ml-auto text-[11px] text-ink-faint">
                    {filtered.length.toLocaleString()} shown
                  </span>
                </div>

                {/* Entries table */}
                <div className="rounded-2xl border border-rule bg-white overflow-hidden">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-b border-rule bg-paper/40 text-left">
                        <Th>Patient</Th>
                        <Th>Brand</Th>
                        <Th>Status</Th>
                        <Th>Eligible</Th>
                        <Th>Expires</Th>
                        <Th>Last visit</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 500).map((e) => (
                        <EntryRow key={e.id} e={e} />
                      ))}
                    </tbody>
                  </table>
                  {filtered.length > 500 && (
                    <div className="px-4 py-2 text-[11px] text-ink-faint border-t border-rule">
                      Showing first 500 of {filtered.length.toLocaleString()}.
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Import history */}
            {view && view.imports.length > 0 && (
              <details className="text-[12px]">
                <summary className="cursor-pointer text-ink-soft hover:text-ink">
                  Import history ({view.imports.length})
                </summary>
                <div className="mt-2 space-y-1">
                  {view.imports.map((imp) => (
                    <div
                      key={imp.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-rule px-3 py-1.5 text-ink-soft"
                    >
                      <span className="font-semibold text-ink capitalize">
                        {imp.manufacturer}
                      </span>
                      <span className="text-ink-faint">{imp.sourceFilename ?? "—"}</span>
                      <span>{imp.rowCount.toLocaleString()} patients</span>
                      <span>{imp.entryCount.toLocaleString()} signals</span>
                      <span>{imp.matchedCount.toLocaleString()} matched</span>
                      <span className="ml-auto text-ink-faint">
                        {new Date(imp.importedAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AutoImportCard({
  accessToken,
  viewAsUserId,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedField, setCopiedField] = useState<"address" | "token" | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (token || !accessToken) return;
    setBusy(true);
    try {
      const r = await getOrCreateRewardIngestToken({
        data: { accessToken, viewAsUserId },
      });
      setAddress(r.address);
      setToken(r.token);
    } catch {
      toast.error("Couldn't load your auto-import token.");
    } finally {
      setBusy(false);
    }
  }

  async function copyField(field: "address" | "token", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      /* clipboard blocked — the value is visible to select manually */
    }
  }

  async function rotate() {
    if (!accessToken) return;
    setRotating(true);
    try {
      const r = await rotateRewardIngestToken({
        data: { accessToken, viewAsUserId },
      });
      setAddress(r.address);
      setToken(r.token);
      setConfirmRotate(false);
      toast.success("New token issued. Update your installs to keep auto-import running.");
    } catch {
      toast.error("Couldn't rotate your token. Try again.");
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-paper/30 p-5">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 text-sm font-semibold text-ink"
      >
        <Sparkles className="h-4 w-4 text-emerald" />
        Hands-free auto-import — never upload a CSV again
        <span className="ml-auto text-[11px] font-normal text-ink-faint">
          {open ? "hide" : "set up"}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-4 text-[13px] text-ink-soft">
          {busy ? (
            <div className="flex items-center gap-2 text-ink-faint">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your private token…
            </div>
          ) : token && address ? (
            <>
              <p>
                Two ways to get every manufacturer report in automatically — pick
                either, or use both. SmartSpa figures out which manufacturer it
                is and imports it for you. No dropdown, no upload, ever again.
              </p>

              {/* Option A — forward by email */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                  <Mail className="h-3.5 w-3.5 text-emerald" />
                  Option A — forward the report by email
                </div>
                <p className="text-[12px] text-ink-faint">
                  Point a scheduled portal export (or a one-time auto-forward
                  rule) at your private inbox:
                </p>
                <div className="flex items-center gap-2 rounded-lg border border-rule bg-white px-3 py-2 font-mono text-[12.5px]">
                  <span className="truncate">{address}</span>
                  <button
                    type="button"
                    onClick={() => copyField("address", address)}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 text-emerald hover:opacity-80"
                  >
                    {copiedField === "address" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedField === "address" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Option B — SmartSpa Agent desktop installer */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                  <MonitorDown className="h-3.5 w-3.5 text-emerald" />
                  Option B — SmartSpa Agent (one-click desktop app)
                </div>
                <p className="text-[12px] text-ink-faint">
                  Install SmartSpa Agent and paste this token when it asks. It
                  logs into your reward portals on your own Mac and pulls each
                  report daily — for portals that can&apos;t email a scheduled
                  export.
                </p>
                <div className="flex items-center gap-2 rounded-lg border border-rule bg-white px-3 py-2 font-mono text-[12.5px]">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  <span className="truncate">{token}</span>
                  <button
                    type="button"
                    onClick={() => copyField("token", token)}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 text-emerald hover:opacity-80"
                  >
                    {copiedField === "token" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedField === "token" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <ul className="list-disc pl-5 space-y-1 text-[12px] text-ink-faint">
                <li>
                  <b>Allergan (Allē):</b> in Allē Business → Reports, schedule
                  the Patient360 export to your email address above — or let
                  SmartSpa Agent pull it for you.
                </li>
                <li>
                  <b>Galderma (ASPIRE):</b> schedule the all-patients / savings
                  export, or set a Gmail filter to auto-forward it here.
                </li>
                <li>
                  <b>Evolus:</b> forward (or auto-forward) the Patient Insights
                  export here.
                </li>
              </ul>

              <p className="text-[11px] text-ink-faint">
                Imports appear in the history below, just like a manual upload —
                only nobody had to do anything.
              </p>

              {/* Rotate — self-serve, destructive, confirm first */}
              <div className="border-t border-rule pt-3">
                {confirmRotate ? (
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="text-ink-soft">
                      Issue a new token? Your current email address and any
                      installed SmartSpa Agent will stop working until you update
                      them.
                    </span>
                    <button
                      type="button"
                      disabled={rotating}
                      onClick={rotate}
                      className="inline-flex items-center gap-1 rounded-md bg-ink px-2.5 py-1 font-medium text-paper hover:opacity-90 disabled:opacity-50"
                    >
                      {rotating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCw className="h-3.5 w-3.5" />
                      )}
                      Yes, rotate
                    </button>
                    <button
                      type="button"
                      disabled={rotating}
                      onClick={() => setConfirmRotate(false)}
                      className="text-ink-faint hover:text-ink"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRotate(true)}
                    className="inline-flex items-center gap-1.5 text-[12px] text-ink-faint hover:text-ink"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    Rotate token (if it leaked or you want a clean start)
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="text-ink-faint">Sign in to load your token.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Lane 2 — manufacturer last-treatment dates → sharper lapsed detection.
 * Auto-detects the Allergan report from the file (no dropdown). Writes $0
 * recency markers into patient_transactions that the overdue/lapsed engine
 * opts in by source — never revenue. See manufacturer-transaction-csv.ts.
 */
function LastTransactionCard({
  accessToken,
  viewAsUserId,
  onImported,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
  onImported: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<LastTxnImportReceipt | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    if (!accessToken) return;
    setBusy(true);
    setReceipt(null);
    try {
      const csv = await file.text();
      const r = await ingestManufacturerTransactionCsv({
        data: { accessToken, viewAsUserId, csv, sourceFilename: file.name },
      });
      setReceipt(r);
      toast.success(
        `${r.cadenceRows.toLocaleString()} treatment dates added · ${r.matchedPatients.toLocaleString()} patients — lapsed detection sharpened`,
      );
      await onImported();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-paper/30 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CalendarClock className="h-4 w-4 text-emerald" />
          Treatment history — sharpen lapsed detection
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald/40 px-3 py-1.5 text-[12px] font-semibold text-emerald hover:bg-emerald-soft transition disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          Upload last-transaction report
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">
        Upload Allergan's "Last Botox/Juvéderm Transaction", the device/retail
        report, or the full "TransactionsReport" history — Refill detects which
        automatically. It records each patient's treatment dates, so a patient
        who's quiet in your books but recently treated is read correctly, and
        one who's truly overdue surfaces sooner. These are dates only — never
        counted as revenue or a visit (Allergan reports carry no treatment
        price; revenue stays sourced from QuickBooks).
      </p>

      {receipt && (
        <div className="mt-3 rounded-xl border border-emerald/30 bg-emerald-soft/40 px-4 py-3 text-[12px] text-emerald-ink">
          <div className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {receipt.displayName}
          </div>
          <p className="mt-1 text-ink-soft">
            {receipt.dataRows.toLocaleString()} patients in file ·{" "}
            {receipt.matchedPatients.toLocaleString()} matched to your book ·{" "}
            {receipt.rowsInserted.toLocaleString()} treatment dates added
            {receipt.rowsSkipped > 0 &&
              ` · ${receipt.rowsSkipped.toLocaleString()} already on file`}
            {receipt.cadenceRows > 0 &&
              ` · ${receipt.cadenceRows.toLocaleString()} feed Botox/filler cadence`}
            {receipt.skippedLoyaltyRows > 0 &&
              ` · ${receipt.skippedLoyaltyRows.toLocaleString()} loyalty rows skipped (not treatments)`}
            {receipt.unmatchedWithContact > 0 &&
              ` · ${receipt.unmatchedWithContact.toLocaleString()} not in your book`}
            .
          </p>
        </div>
      )}
    </div>
  );
}

function PromoCalendarCard({
  accessToken,
  viewAsUserId,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
}) {
  const [offerCount, setOfferCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const offers = await listPromoOffers({ data: { accessToken, viewAsUserId } });
      setOfferCount(offers.length);
    } catch {
      /* leave count hidden on error */
    }
  }, [accessToken, viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleFile(file: File) {
    if (!accessToken) return;
    setBusy(true);
    try {
      const csv = await file.text();
      const r = await ingestPromoCalendar({ data: { accessToken, viewAsUserId, csv } });
      toast.success(
        `${r.offers} promo offer${r.offers === 1 ? "" : "s"} imported${r.skipped ? ` · ${r.skipped} skipped` : ""}`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-paper/30 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Tag className="h-4 w-4 text-amber" />
          Promo calendar — at-booking offers
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber/40 px-3 py-1.5 text-[12px] font-semibold text-amber hover:bg-amber-soft transition disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          Upload calendar CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        {offerCount != null && (
          <span className="ml-auto text-[11px] text-ink-faint">
            {offerCount} offer{offerCount === 1 ? "" : "s"} loaded
          </span>
        )}
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">
        Upload your manufacturer's promotions calendar (Allergan "Dollars Off"
        offers). Active offers badge the matching add-on at booking — "add
        filler, $75 off through Jun 30."
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </th>
  );
}

function EntryRow({ e }: { e: RewardEntryRow }) {
  return (
    <tr className="border-b border-rule/60 last:border-0 hover:bg-paper/30">
      <td className="px-3 py-2">
        <div className="font-medium text-ink">
          {e.patientName ?? e.contactName ?? "—"}
        </div>
        {!e.matched && (
          <span className="text-[10px] text-amber">not in your book</span>
        )}
      </td>
      <td className="px-3 py-2 text-ink-soft">{e.brandProduct}</td>
      <td className="px-3 py-2">
        <StatusPill status={e.statusNorm} raw={e.statusRaw} />
      </td>
      <td className="px-3 py-2 text-ink-soft tabular-nums">{fmtDate(e.eligibleDate)}</td>
      <td className="px-3 py-2 text-ink-soft tabular-nums">{fmtDate(e.expirationDate)}</td>
      <td className="px-3 py-2 text-ink-soft tabular-nums">{fmtDate(e.lastVisit)}</td>
    </tr>
  );
}

function StatusPill({ status, raw }: { status: string; raw: string | null }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    eligible: { bg: "#e6f3ed", fg: "#0c4d3a", label: "Eligible" },
    expiring_soon: { bg: "#fbf2dd", fg: "#5e4300", label: "Expiring" },
    expired: { bg: "#f3eeee", fg: "#8a847a", label: "Expired" },
    not_yet_eligible: { bg: "#eef0f3", fg: "#41464d", label: "Not yet" },
    unknown: { bg: "#eef0f3", fg: "#41464d", label: raw ?? "—" },
  };
  const s = map[status] ?? map.unknown;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
  onClick,
}: {
  label: string;
  value: string;
  tone: "emerald" | "amber" | "plain";
  icon?: React.ReactNode;
  onClick?: () => void;
}) {
  const toneStyle =
    tone === "emerald"
      ? { background: "#e6f3ed", color: "#0c4d3a", border: "1px solid #bfe3d4" }
      : tone === "amber"
        ? { background: "#fbf2dd", color: "#5e4300", border: "1px solid #ecd9a8" }
        : { background: "#fff", color: "#1c1b18", border: "1px solid #e6e2d6" };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="rounded-2xl px-4 py-3 text-left transition enabled:hover:shadow-sm disabled:cursor-default"
      style={toneStyle}
    >
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider opacity-70">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums mt-0.5">{value}</div>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-rule bg-paper/30 p-10 text-center">
      <div className="h-12 w-12 mx-auto rounded-full bg-emerald-soft text-emerald-ink flex items-center justify-center mb-3">
        <Gift className="h-6 w-6" />
      </div>
      <h2 className="text-base font-semibold text-ink mb-1">No reward signals yet</h2>
      <p className="text-sm text-ink-soft max-w-md mx-auto">
        Upload your Evolus Patient Insights export above. Refill matches every
        patient to your book and shows you who's eligible now and whose reward
        is about to expire — so you can book them before the manufacturer sends
        them to "a provider near you."
      </p>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y.slice(2)}`;
}
