/**
 * /scan — public viral landing for the no-show recovery analysis (v369).
 *
 * Drop a med-spa CSV → see your no-show leak + recovery estimate. Brand
 * is shell-aware (Emma on openagentic.site; Refill on getrefill.app).
 * Free, no signup, no auth, mobile-first, light bg.
 *
 * Architecture:
 *   1. Page parses the CSV client-side (parseAppointmentCsv from
 *      appointment-csv.ts) so patient rows NEVER touch our server.
 *   2. If the deterministic detection lands in csv-generic AND the
 *      generic fuzzy parse returns zero appointments, we POST just the
 *      header row + a few sample-row arrays (anonymizable) to the public
 *      mapper (mapHeadersPublic) which uses the GLOBAL public_csv_dialect_
 *      cache. The mapping comes back, we re-parse client-side with it.
 *   3. The receipt panel renders client-side from the parsed appointments
 *      via scan-analysis.ts.
 *   4. Optional email capture POSTs the receipt summary + headers (NOT
 *      rows) to captureScanLead.
 *   5. CTA at the bottom links to /signup (or wherever the trial-signup
 *      flow lives — for v1 we route to the marketing site).
 *
 * Hero framing: "See what your no-shows are really costing you." The math
 * is the value; everything else is supporting infrastructure.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  FileUp,
  Loader2,
  Lock,
  Mail,
  Send,
  Sparkles,
  TrendingUp,
  Upload,
} from "lucide-react";

import {
  parseAppointmentCsv,
  parseAppointmentCsvWithAliases,
  dialectLabel,
  SUPPORTED_PLATFORMS,
  type AppointmentDialect,
  type ParsedAppointmentFile,
  type ColAliases,
} from "@/lib/appointment-csv";
import {
  guideFor,
  EXPORT_GUIDES,
  type ExportGuide,
} from "@/lib/scan-export-guides";
import { parseCsvGrid } from "@/lib/csv-grid";
import {
  analyzeScannedAppointments,
  formatUsd,
  formatUsdExact,
  AVG_TICKET_USD,
  RECOVERY_FLOOR_PCT,
  RECOVERY_CEILING_PCT,
  type ScanReceipt,
} from "@/lib/scan-analysis";
import {
  mapHeadersPublic,
  captureScanLead,
  sendScanReturnLink,
  type PublicMappingResult,
} from "@/server/scan.functions";
import { REFILL_BRAND } from "@/lib/brand";
import {
  SAMPLE_RECEIPT,
  SAMPLE_PARSED,
  SAMPLE_FILE_LABEL,
} from "@/lib/scan-sample";

export const Route = createFileRoute("/scan")({
  component: ScanPage,
});

type ScanState = {
  parsed: ParsedAppointmentFile;
  receipt: ScanReceipt;
  aiMapping: PublicMappingResult | null;
  fileName: string;
  isSample?: boolean;
};

// Pre-loaded "live example" — Rejuv's real scan, shown until the visitor
// drops their own export. We own it: dogfooding is the most honest demo.
const SAMPLE_SCAN_STATE: ScanState = {
  parsed: SAMPLE_PARSED,
  receipt: SAMPLE_RECEIPT,
  aiMapping: null,
  fileName: SAMPLE_FILE_LABEL,
  isSample: true,
};

function ScanPage() {
  const brand = REFILL_BRAND; /* cleave: single brand */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ScanState | null>(SAMPLE_SCAN_STATE);

  const [email, setEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailDone, setEmailDone] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Slice B: "email me a link to run my own scan" (sample mode)
  const [returnEmail, setReturnEmail] = useState("");
  const [returnBusy, setReturnBusy] = useState(false);
  const [returnDone, setReturnDone] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);

  const onSendReturnLink = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const addr = returnEmail.trim();
      if (!addr) return;
      setReturnBusy(true);
      setReturnError(null);
      try {
        await sendScanReturnLink({ data: { email: addr } });
        setReturnDone(true);
      } catch (err) {
        setReturnError(
          err instanceof Error ? err.message : "Couldn't send — try again.",
        );
      } finally {
        setReturnBusy(false);
      }
    },
    [returnEmail],
  );

  const [copied, setCopied] = useState(false);

  // Arriving from the "email me a link" message (smartspa.app/scan#drop): the
  // visitor already saw the demo, so scroll them straight to the drop zone.
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#drop")
      return;
    const t = setTimeout(() => {
      document
        .getElementById("drop")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => clearTimeout(t);
  }, []);

  const reset = useCallback(() => {
    setState(null);
    setError(null);
    setEmail("");
    setEmailDone(false);
    setEmailError(null);
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setEmailDone(false);
    setEmailError(null);
    try {
      const text = await file.text();
      let parsed = parseAppointmentCsv(text);
      let aiMapping: PublicMappingResult | null = null;

      const shouldTryMapper =
        parsed.dialect === "csv-generic" &&
        (parsed.appointments.length === 0 ||
          parsed.dialectConfidence === "low");
      if (shouldTryMapper && parsed.headers.length > 0) {
        try {
          const grid = parseCsvGrid(text);
          const sampleRows = grid.slice(1, 4);
          aiMapping = await mapHeadersPublic({
            data: {
              headers: parsed.headers,
              sampleRows,
            },
          });
        } catch {
          aiMapping = null;
        }
        if (aiMapping) {
          const remapped = parseAppointmentCsvWithAliases(
            text,
            aiMapping.aliases as ColAliases,
          );
          if (remapped.appointments.length > 0) {
            parsed = remapped;
          }
        }
      }

      if (parsed.appointments.length === 0) {
        setError(
          "We couldn't read any appointments from this file. Make sure it's a CSV exported from your scheduler — not the raw report. Try again with another export.",
        );
        setState(null);
        return;
      }

      const receipt = analyzeScannedAppointments(parsed.appointments);
      setState({ parsed, receipt, aiMapping, fileName: file.name });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't read that file. Make sure it's a .csv export.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void handleFile(f);
    },
    [handleFile],
  );

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!state) return;
    setEmailBusy(true);
    setEmailError(null);
    try {
      await captureScanLead({
        data: {
          email,
          detectedPlatform:
            state.aiMapping?.platform ?? dialectLabel(state.parsed.dialect),
          source: typeof window !== "undefined" ? window.location.href : null,
          appointmentCount: state.receipt.totalAppointments,
          dateRangeStart: state.receipt.dateRangeStart,
          dateRangeEnd: state.receipt.dateRangeEnd,
          noshowCount: state.receipt.noShowCount,
          estimatedMonthlyLeakUsd: state.receipt.monthlyLeakUsd,
          estimatedMonthlyRecoveryUsd:
            state.receipt.monthlyRecoveryCeilingUsd,
          headerSample: state.parsed.headers.slice(0, 40),
          wasAiMapped: state.aiMapping !== null,
          userAgent:
            typeof navigator !== "undefined" ? navigator.userAgent : null,
          // v371: breakdowns for the HTML report attachment
          totalLossEvents: state.receipt.totalLossEvents,
          refilledSlotCount: state.receipt.refilledSlotCount,
          emptySlotCount: state.receipt.emptySlotCount,
          monthsCovered: state.receipt.monthsCovered,
          monthlyManualSavedUsd: state.receipt.monthlyManualSavedUsd,
          byDayOfWeek: state.receipt.byDayOfWeek,
          byProvider: state.receipt.byProvider,
          byService: state.receipt.byService,
        },
      });
      setEmailDone(true);
    } catch (e) {
      setEmailError(
        e instanceof Error ? e.message : "Couldn't save your email.",
      );
    } finally {
      setEmailBusy(false);
    }
  }

  async function copyShareLink() {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/scan`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // noop — older browsers
    }
  }

  const dropZoneSection = (
    <section className="max-w-3xl mx-auto px-6 pb-12">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={[
          "relative rounded-3xl border-2 border-dashed transition-all bg-white shadow-sm",
          dragOver
            ? "border-emerald-500 bg-emerald-50/50 scale-[1.01]"
            : "border-slate-300 hover:border-slate-400",
          "px-8 py-16 text-center cursor-pointer",
        ].join(" ")}
        onClick={() => fileInputRef.current?.click()}
      >
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
        {busy ? (
          <div className="flex flex-col items-center gap-3 text-slate-600">
            <Loader2 className="h-10 w-10 animate-spin" />
            <span className="text-sm">Reading your schedule…</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 text-slate-700">
            <div className="h-16 w-16 rounded-full bg-slate-100 flex items-center justify-center">
              <Upload className="h-8 w-8 text-slate-500" />
            </div>
            <div>
              <div className="text-lg font-medium text-slate-900 mb-1">
                Drag &amp; drop your CSV to see YOUR numbers
              </div>
              <div className="text-sm text-slate-500">
                or click to browse · we accept exports from any scheduler
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition"
            >
              <FileUp className="h-4 w-4" />
              Choose a CSV
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
          {error}
        </div>
      )}

      <ExportGuidePanel />
    </section>
  );

  return (
    <div className="min-h-screen bg-[#f8f6f1] text-slate-900">
      {/* Top strip */}
      <header className="max-w-5xl mx-auto px-6 pt-6 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-slate-900 text-white flex items-center justify-center text-sm font-semibold">
            {brand.logoMark}
          </div>
          <span className="font-semibold tracking-tight text-slate-900">
            {brand.name}
          </span>
          <span className="text-slate-400 text-sm hidden sm:inline">
            {brand.tagline}
          </span>
        </div>
        <a
          href={brand.loginHref}
          className="text-sm text-slate-600 hover:text-slate-900 transition"
        >
          Already a customer? Sign in →
        </a>
      </header>

      {/* Hero */}
      <section className="max-w-3xl mx-auto px-6 pt-10 pb-6 text-center">
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-slate-900 mb-4 leading-tight">
          See what
          <br />
          cancellations +{" "}
          <span className="whitespace-nowrap">no-shows</span>
          <br />
          are really costing you.
        </h1>
        <p className="text-lg text-slate-600 mb-6 max-w-xl mx-auto">
          Below are our own spa's real numbers &mdash; Rejuv.
          <br />
          Drag &amp; drop your CSV to see yours.
          <br />
          Free, 30 seconds, no signup.
        </p>
        <div className="inline-flex items-center gap-2 text-xs text-slate-500 bg-white border border-slate-200 rounded-full px-3 py-1.5">
          <Lock className="h-3 w-3" />
          Your data stays in your browser. Only the column structure ever
          touches our servers.
        </div>
      </section>

      {/* Drop zone — top slot, shown only after a reset (no active scan).
          In sample mode the same dropzone renders BELOW the receipt instead,
          so the visitor sees Rejuv's real numbers first (wow), then drops
          theirs. */}
      {!state && dropZoneSection}

      {/* Receipt */}
      {state && (
        <section className="max-w-4xl mx-auto px-6 pb-16">
          {state.isSample && (
            <div className="mb-5 rounded-2xl bg-slate-900 text-white px-5 py-4 flex items-start gap-3">
              <Sparkles className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
              <div className="text-sm leading-relaxed">
                <strong className="font-semibold">
                  These are Rejuv's real numbers — our own med-spa.
                </strong>{" "}
                We run SmartSpa on ourselves.{" "}
                <span className="text-slate-300">
                  Drag &amp; drop your CSV below to see yours.
                </span>
              </div>
            </div>
          )}
          {/* Receipt header */}
          <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {state.aiMapping?.platform ??
                    dialectLabel(state.parsed.dialect)}
                </span>
                {state.aiMapping && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 text-[11px] font-medium"
                    title={
                      state.aiMapping.fromCache
                        ? "Recognized from our global cache — instant + free."
                        : "First time seeing this CSV shape — AI mapped + cached for everyone going forward."
                    }
                  >
                    <Sparkles className="h-3 w-3" />
                    {state.aiMapping.fromCache ? "cached" : "AI mapped"}
                  </span>
                )}
                <span className="text-xs text-slate-400">
                  · {state.fileName}
                </span>
              </div>
              {!state.isSample && (
                <button
                  onClick={reset}
                  className="text-xs text-slate-500 hover:text-slate-900"
                >
                  Scan another file
                </button>
              )}
            </div>

            {/* Stat strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-slate-100">
              <StatCell
                label="Appointments"
                value={state.receipt.totalAppointments.toLocaleString()}
              />
              <StatCell
                label="Date range"
                value={
                  state.receipt.dateRangeStart && state.receipt.dateRangeEnd
                    ? `${formatDateShort(state.receipt.dateRangeStart)} → ${formatDateShort(state.receipt.dateRangeEnd)}`
                    : "—"
                }
                small
              />
              <StatCell
                label="Providers"
                value={state.receipt.uniqueProviders.toLocaleString()}
              />
              <StatCell
                label="Top service"
                value={state.receipt.topServices[0]?.name ?? "—"}
                small
              />
            </div>

            {/* THE MATH — the value the page exists for */}
            <div className="px-6 py-7 bg-gradient-to-br from-emerald-50/60 to-amber-50/40 border-t border-slate-100">
              <div className="flex items-center gap-2 mb-3 text-emerald-700 text-xs font-semibold uppercase tracking-wider">
                <TrendingUp className="h-3.5 w-3.5" />
                The math · code-computed
              </div>
              {state.receipt.hasUsableStatusData &&
              state.receipt.monthlyLeakUsd !== null ? (
                <>
                  <div className="text-lg text-slate-700 mb-4">
                    Your schedule shows{" "}
                    <span className="font-semibold text-slate-900">
                      {state.receipt.totalLossEvents.toLocaleString()}
                    </span>{" "}
                    cancelled or no-show appointment
                    {state.receipt.totalLossEvents === 1 ? "" : "s"} across{" "}
                    <span className="font-semibold text-slate-900">
                      {state.receipt.monthsCovered}
                    </span>{" "}
                    month{state.receipt.monthsCovered === 1 ? "" : "s"} of
                    data.{" "}
                    <span className="text-slate-600">
                      Your team already refilled{" "}
                      <span className="font-semibold text-slate-900">
                        {state.receipt.refilledSlotCount.toLocaleString()}
                      </span>{" "}
                      of them (
                      {state.receipt.totalLossEvents > 0
                        ? Math.round(
                            (state.receipt.refilledSlotCount /
                              state.receipt.totalLossEvents) *
                              100,
                          )
                        : 0}
                      %) — that's real work, already in your books.
                    </span>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="rounded-2xl bg-white border border-slate-200 p-5">
                      <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">
                        Your team already saved
                      </div>
                      <div className="text-3xl font-semibold text-slate-900 mb-1">
                        {formatUsdExact(
                          state.receipt.monthlyManualSavedUsd,
                        )}
                        <span className="text-base font-medium text-slate-500">
                          {" "}
                          / month
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono mb-1.5">
                        {state.receipt.refilledSlotCount} × $
                        {AVG_TICKET_USD} ÷ {state.receipt.monthsCovered} mo ={" "}
                        {formatUsdExact(state.receipt.monthlyManualSavedUsd)}
                      </div>
                      <div className="text-xs text-slate-600">
                        {state.receipt.refilledSlotCount.toLocaleString()} of{" "}
                        {state.receipt.totalLossEvents.toLocaleString()}{" "}
                        slots refilled (
                        {state.receipt.totalLossEvents > 0
                          ? Math.round(
                              (state.receipt.refilledSlotCount /
                                state.receipt.totalLossEvents) *
                                100,
                            )
                          : 0}
                        %) ·{" "}
                        <span className="font-semibold text-slate-900">
                          ~
                          {state.receipt.monthsCovered > 0
                            ? Math.round(
                                state.receipt.refilledSlotCount /
                                  state.receipt.monthsCovered,
                              )
                            : 0}{" "}
                          per month
                        </span>
                      </div>
                    </div>

                    <div className="rounded-2xl bg-emerald-600 text-white p-5">
                      <div className="text-xs text-emerald-100 uppercase tracking-wider mb-1">
                        {brand.name} catches the gap
                      </div>
                      <div className="text-3xl font-semibold mb-1">
                        {formatUsdExact(
                          state.receipt.monthlyRecoveryFloorUsd,
                        )}
                        {" – "}
                        {formatUsdExact(
                          state.receipt.monthlyRecoveryCeilingUsd,
                        )}
                        <span className="text-base font-medium text-emerald-100">
                          {" "}
                          / month
                        </span>
                      </div>
                      <div className="text-[11px] text-emerald-100 font-mono mb-1.5">
                        {state.receipt.emptySlotCount} × ${AVG_TICKET_USD}{" "}
                        × {Math.round(RECOVERY_FLOOR_PCT * 100)}–
                        {Math.round(RECOVERY_CEILING_PCT * 100)}% ÷{" "}
                        {state.receipt.monthsCovered} mo ={" "}
                        {formatUsdExact(
                          state.receipt.monthlyRecoveryFloorUsd,
                        )}
                        –
                        {formatUsdExact(
                          state.receipt.monthlyRecoveryCeilingUsd,
                        )}
                      </div>
                      <div className="text-xs text-emerald-50">
                        {state.receipt.emptySlotCount.toLocaleString()} of{" "}
                        {state.receipt.totalLossEvents.toLocaleString()}{" "}
                        stayed empty (
                        {state.receipt.totalLossEvents > 0
                          ? Math.round(
                              (state.receipt.emptySlotCount /
                                state.receipt.totalLossEvents) *
                                100,
                            )
                          : 0}
                        %) ·{" "}
                        <span className="font-semibold text-white">
                          ~
                          {state.receipt.monthsCovered > 0
                            ? Math.round(
                                state.receipt.emptySlotCount /
                                  state.receipt.monthsCovered,
                              )
                            : 0}{" "}
                          per month
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 text-sm text-slate-600 space-y-1.5">
                    <div>
                      That's{" "}
                      <span className="font-semibold text-slate-900">
                        {formatUsd(state.receipt.annualRecoveryFloorUsd)} –{" "}
                        {formatUsd(state.receipt.annualRecoveryCeilingUsd)}
                      </span>{" "}
                      a year of additional revenue —{" "}
                      <span className="whitespace-nowrap">
                        {Math.round(RECOVERY_FLOOR_PCT * 100)}–
                        {Math.round(RECOVERY_CEILING_PCT * 100)}%
                      </span>{" "}
                      of the gap your team can't get to.
                    </div>
                    <div className="text-slate-500 text-xs">
                      Plus: {brand.name} automates the manual rebooking your
                      front desk is doing now, and prevents some cancellations
                      entirely with reminder cadence — neither counted above.
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-2xl bg-white border border-amber-200 p-5">
                  <div className="text-sm font-medium text-slate-900 mb-1">
                    Not enough history to compute your no-show math.
                  </div>
                  <div className="text-sm text-slate-600">
                    {state.receipt.insufficientDataReason}
                  </div>
                </div>
              )}
            </div>

            {/* Status breakdown + top services */}
            <div className="px-6 py-5 grid sm:grid-cols-2 gap-6 border-t border-slate-100">
              <div>
                <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                  Status breakdown
                </div>
                <ul className="text-sm space-y-1">
                  {Object.entries(state.receipt.statusBreakdown)
                    .filter(([, n]) => n > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, n]) => (
                      <li
                        key={k}
                        className="flex justify-between border-b border-slate-100 py-1"
                      >
                        <span className="text-slate-600">
                          {prettyStatus(k)}
                        </span>
                        <span className="text-slate-900 font-medium">
                          {n.toLocaleString()}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
              <div>
                <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                  Top services
                </div>
                {state.receipt.topServices.length > 0 ? (
                  <ul className="text-sm space-y-1">
                    {state.receipt.topServices.map((s) => (
                      <li
                        key={s.name}
                        className="flex justify-between border-b border-slate-100 py-1 gap-3"
                      >
                        <span className="text-slate-600 truncate">
                          {s.name}
                        </span>
                        <span className="text-slate-900 font-medium shrink-0">
                          {s.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-sm text-slate-500">
                    No service column detected
                  </div>
                )}
              </div>
            </div>

            {/* Column mapping disclosure */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100">
              <details className="text-xs text-slate-600">
                <summary className="cursor-pointer hover:text-slate-900 font-medium">
                  Show me how you read my columns
                </summary>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 font-mono">
                  {state.aiMapping
                    ? Object.entries(state.aiMapping.aliases).map(
                        ([field, headers]) => (
                          <div key={field}>
                            <span className="text-slate-900">{field}</span>
                            <span className="text-slate-500">
                              {" "}
                              ← {(headers as string[]).join(" / ")}
                            </span>
                          </div>
                        ),
                      )
                    : state.parsed.headers.map((h, i) => (
                        <div key={i}>
                          <span className="text-slate-500">{h}</span>
                        </div>
                      ))}
                </div>
              </details>
            </div>
          </div>

          {/* Email capture */}
          {!state.isSample &&
            state.receipt.hasUsableStatusData &&
            state.receipt.monthlyLeakUsd !== null && (
              <div className="mt-6 bg-white rounded-3xl shadow-sm border border-slate-200 px-6 py-7">
                <div className="flex items-start gap-3 mb-4">
                  <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                    <Mail className="h-5 w-5 text-amber-700" />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">
                      Want the full PDF breakdown emailed?
                    </div>
                    <div className="text-sm text-slate-600 mt-0.5">
                      Top no-show patterns by day-of-week, by provider, by
                      service. Plus a one-page plan for which of your
                      patients {brand.name} would target first. We'll send
                      it once. No spam.
                    </div>
                  </div>
                </div>
                {emailDone ? (
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-900 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    Sent. Check your inbox in the next few seconds.
                  </div>
                ) : (
                  <form
                    onSubmit={submitEmail}
                    className="flex flex-col sm:flex-row gap-3"
                  >
                    <input
                      type="email"
                      required
                      placeholder="you@yourspa.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:outline-none focus:border-slate-500"
                    />
                    <button
                      type="submit"
                      disabled={emailBusy}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white text-sm font-medium px-5 py-2.5 hover:bg-slate-800 transition disabled:opacity-50"
                    >
                      {emailBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      Send me the breakdown
                    </button>
                  </form>
                )}
                {emailError && (
                  <div className="mt-2 text-xs text-amber-700">
                    {emailError}
                  </div>
                )}
              </div>
            )}

          {/* Sample mode: Rejuv's numbers are above (the wow) — now the
              visitor drops their own. Same dropzone, rendered here so the
              real results come first. */}
          {state.isSample && (
            <div id="drop" className="mt-10 scroll-mt-6">
              <div className="text-center mb-5">
                <div className="text-2xl font-semibold text-slate-900 mb-1">
                  Now see YOUR real numbers.
                </div>
                <div className="text-sm text-slate-500">
                  Free, about 30 seconds, no signup. Your export never leaves
                  your browser.
                </div>
              </div>
              {dropZoneSection}

              <div className="mt-2 text-center px-6">
                {returnDone ? (
                  <div className="inline-flex items-center gap-2 text-sm text-emerald-700 font-medium">
                    <Mail className="h-4 w-4" />
                    Sent! Check your inbox for your scan link.
                  </div>
                ) : (
                  <div className="max-w-md mx-auto">
                    <div className="text-sm text-slate-500 mb-3">
                      No CSV handy right now? We'll email you a link to run your
                      scan whenever you've got a minute.
                    </div>
                    <form
                      onSubmit={onSendReturnLink}
                      className="flex flex-col sm:flex-row gap-2"
                    >
                      <input
                        type="email"
                        required
                        value={returnEmail}
                        onChange={(e) => setReturnEmail(e.target.value)}
                        placeholder="you@yourspa.com"
                        className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:border-slate-400 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={returnBusy}
                        className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition disabled:opacity-60"
                      >
                        {returnBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Mail className="h-4 w-4" />
                        )}
                        Email me my link
                      </button>
                    </form>
                    {returnError && (
                      <div className="mt-2 text-xs text-amber-700">
                        {returnError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* CTA — Acuity users see the live-mode upgrade framing; everyone
              else sees the standard signup framing with a heads-up that
              live-mode for their platform is on the roadmap. Detection
              checks both deterministic dialect and AI-mapped platform name
              so v371 AI-mapped Acuity CSVs also flip the variant. */}
          {!state.isSample &&
            state.receipt.hasUsableStatusData &&
            state.receipt.monthlyLeakUsd !== null &&
            (() => {
              const isAcuity =
                state.parsed.dialect === "csv-acuity" ||
                state.aiMapping?.platform?.toLowerCase() === "acuity";
              const detectedPlatform =
                state.aiMapping?.platform ??
                dialectLabel(state.parsed.dialect);
              const ctaHref = isAcuity
                ? `${brand.ctaHref}?detected=acuity`
                : brand.ctaHref;

              return (
                <div className="mt-6 bg-slate-900 text-white rounded-3xl px-6 py-7">
                  {isAcuity ? (
                    <>
                      <div className="text-xs uppercase tracking-wider text-emerald-300 mb-2">
                        One-click live mode · for Acuity
                      </div>
                      <div className="text-2xl font-semibold mb-1">
                        Connect Acuity. Refill catches every cancellation
                        automatically.
                      </div>
                      <div className="text-sm text-slate-300 mb-5 max-w-xl">
                        What you just saw is a snapshot. Connect Acuity and
                        Refill watches your calendar in real time — every
                        no-show and cancel gets caught the moment it happens.
                        No more exports.{" "}
                        <span className="text-white">
                          {brand.ctaLabel.toLowerCase()}
                        </span>
                        {" "}&mdash; only $5 per booking we recover.
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">
                        Ready to actually recover this revenue?
                      </div>
                      <div className="text-2xl font-semibold mb-1">
                        {brand.ctaLabel}. Only $5 per booking we recover.
                      </div>
                      <div className="text-sm text-slate-300 mb-5 max-w-xl">
                        Month-to-month, cancel anytime. No card to start. We
                        generate draft invoices from{" "}
                        <span className="text-white">verified</span> recovery
                        events; you turn on Stripe only when you trust the
                        math.{" "}
                        {detectedPlatform &&
                          detectedPlatform !== "csv-generic" && (
                            <span className="text-slate-400">
                              One-click live mode for {detectedPlatform} is on
                              the roadmap.
                            </span>
                          )}
                      </div>
                    </>
                  )}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <a
                      href={ctaHref}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-white text-slate-900 text-sm font-medium px-5 py-2.5 hover:bg-slate-100 transition"
                    >
                      {isAcuity
                        ? "Connect Acuity (30 sec)"
                        : `Set up ${brand.name} for my spa`}
                      <ArrowRight className="h-4 w-4" />
                    </a>
                    <button
                      onClick={copyShareLink}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-800 text-white text-sm font-medium px-5 py-2.5 hover:bg-slate-700 transition"
                    >
                      {copied ? (
                        <>
                          <ClipboardCheck className="h-4 w-4" />
                          Link copied
                        </>
                      ) : (
                        <>
                          <Clipboard className="h-4 w-4" />
                          Send this to another spa owner
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })()}
        </section>
      )}

      <footer className="max-w-5xl mx-auto px-6 pb-10 text-center text-xs text-slate-500">
        Numbers above are code-computed from your uploaded CSV. Recovery
        estimates use {Math.round(RECOVERY_FLOOR_PCT * 100)}–
        {Math.round(RECOVERY_CEILING_PCT * 100)}% of lost revenue at $
        {AVG_TICKET_USD} average ticket. Adjust to your actual ARV for your
        own math. {brand.footerLine}
      </footer>
    </div>
  );
}

function ExportGuidePanel() {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<AppointmentDialect | null>(null);
  const guide: ExportGuide | null = picked ? guideFor(picked) : null;
  const pickedLabel = picked
    ? (SUPPORTED_PLATFORMS.find((p) => p.dialect === picked)?.label ?? null)
    : null;

  return (
    <div className="mt-8 max-w-2xl mx-auto">
      {!open ? (
        <div className="text-center">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 underline-offset-4 hover:underline"
          >
            How do I export from my scheduler?
          </button>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <div className="text-sm font-semibold text-slate-900">
              {picked ? `Export from ${pickedLabel}` : "Pick your scheduler"}
            </div>
            <button
              type="button"
              onClick={() => {
                if (picked) {
                  setPicked(null);
                } else {
                  setOpen(false);
                }
              }}
              className="text-xs text-slate-500 hover:text-slate-900"
            >
              {picked ? "← pick another" : "close"}
            </button>
          </div>

          {!picked ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {SUPPORTED_PLATFORMS.map((p) => {
                  const verified = EXPORT_GUIDES[p.dialect] !== undefined;
                  return (
                    <button
                      key={p.dialect}
                      type="button"
                      onClick={() => setPicked(p.dialect)}
                      className="text-left text-sm rounded-lg px-3 py-2 border border-slate-200 hover:border-slate-400 hover:bg-slate-50 transition"
                    >
                      {p.label}
                      {verified && (
                        <span className="ml-1.5 inline-block text-[10px] uppercase tracking-wider text-emerald-700">
                          guide
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
                Don't see yours? Pick the closest match — our AI maps unknown
                column shapes automatically the first time it sees them, and
                caches the mapping for everyone after. So an unrecognized
                export still works on the first try.
              </p>
            </>
          ) : (
            <>
              <ol className="space-y-2 text-sm text-slate-700 list-decimal list-inside marker:text-slate-400 marker:font-mono">
                {guide!.steps.map((s, i) => (
                  <li key={i} className="leading-relaxed">
                    {s}
                  </li>
                ))}
              </ol>
              {guide!.exportUrl && (
                <a
                  href={guide!.exportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800"
                >
                  Open {pickedLabel} export <ArrowRight className="h-3 w-3" />
                </a>
              )}
              {guide!.oauthLiveNote && (
                <div className="mt-4 rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2 text-[12px] text-emerald-900 leading-relaxed">
                  <Sparkles className="inline h-3 w-3 mr-1 -mt-0.5" />
                  {guide!.oauthLiveNote}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  small,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <div className="bg-white px-5 py-4">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-0.5">
        {label}
      </div>
      <div
        className={
          small
            ? "text-sm text-slate-900 font-medium truncate"
            : "text-2xl text-slate-900 font-semibold"
        }
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Format an ISO date as a short human-friendly label for the stat strip.
 * v370.1 — full ISO dates (2026-01-02) overflow the narrow date-range
 * cell and get clipped by `truncate`. Year is implied by surrounding
 * context (the receipt is for the spa's current schedule), so dropping
 * it makes the cell fit cleanly.
 */
function formatDateShort(iso: string): string {
  // Expecting YYYY-MM-DD. Parse manually to avoid timezone shifts that
  // would happen with new Date(iso).
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${monthNames[month - 1]} ${day}`;
}

function prettyStatus(s: string): string {
  switch (s) {
    case "no_show":
      return "No-show";
    case "scheduled":
      return "Scheduled";
    case "confirmed":
      return "Confirmed";
    case "cancelled":
      return "Cancelled";
    case "showed":
      return "Showed";
    case "rescheduled":
      return "Rescheduled";
    default:
      return s;
  }
}
