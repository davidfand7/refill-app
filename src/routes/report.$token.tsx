/**
 * /report/<token> — public hosted scan follow-up report (v1.15, ported
 * from openagenticv4 v371.1).
 *
 * Token IS the capability; no auth. Fetches the rendered HTML string
 * from csv_scanner_leads.followup_report_html and renders it as-is via
 * dangerouslySetInnerHTML so it looks identical to opening the file
 * directly in a browser.
 *
 * Why this exists: Gmail and most webmail clients refuse to render
 * .html attachments inline (XSS safety) — they show source code
 * instead. v371 shipped an attached report; v371.1 moved it to a
 * hosted URL so the recipient gets a clean in-browser render. The
 * Outreach Playbook's V5 (reactivation followup for /scan visitors)
 * embeds these links — without /report/<token> live, those V5 emails
 * would dead-link.
 *
 * The hosted HTML is the full polished report — light bg, inline CSS,
 * mobile-responsive. This route is just a thin shell that fetches +
 * injects it.
 *
 * Server fn getScanReportHtml is already ported to refill-app
 * (src/server/scan-report.functions.ts) along with the DB columns
 * (csv_scanner_leads.followup_report_html / followup_report_token).
 *
 * Cleave changes during port:
 *   - Hex literals translated to brand-aligned hexes: #f8f6f1 → #fbfaf7
 *     (brand paper), #64748b → #5a6068 (brand ink-soft), #fde68a →
 *     #fdf6dc (brand amber-soft), #451a03 / #92400e → #8a6d0c
 *     (brand amber), #0f766e → #056048 (brand emerald)
 *   - Inline-style approach kept verbatim (NOT translated to Tailwind
 *     brand classes) because the body of the report is dangerouslySetInnerHTML
 *     and tailwind preflight inside that scope could conflict with the
 *     report's own inline styles — keeping the wrapper as raw style props
 *     preserves the openagenticv4 isolation guarantee.
 */

import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";

import { getScanReportHtml } from "@/server/scan-report.functions";

export const Route = createFileRoute("/report/$token")({
  component: ReportPage,
});

function ReportPage() {
  const { token } = useParams({ from: "/report/$token" });
  const [html, setHtml] = useState<string | null | "loading">("loading");

  useEffect(() => {
    (async () => {
      try {
        const r = await getScanReportHtml({ data: { token } });
        setHtml(r.html);
      } catch {
        setHtml(null);
      }
    })();
  }, [token]);

  if (html === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#fbfaf7",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#5a6068",
          fontFamily:
            "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif",
          gap: 12,
        }}
      >
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Loading your report…</span>
      </div>
    );
  }

  if (!html) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#fbfaf7",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily:
            "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            background: "#ffffff",
            border: "1px solid #fdf6dc",
            borderRadius: 12,
            padding: 24,
            textAlign: "center",
            color: "#8a6d0c",
          }}
        >
          <AlertTriangle
            className="h-6 w-6"
            style={{ margin: "0 auto 12px", color: "#8a6d0c" }}
          />
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
            Report link expired or invalid
          </div>
          <div style={{ fontSize: 14, color: "#5a6068" }}>
            This report link doesn&#39;t match any saved breakdown. Drop your
            CSV again at{" "}
            <a
              href="/scan"
              style={{ color: "#056048", textDecoration: "underline" }}
            >
              /scan
            </a>{" "}
            to generate a fresh one.
          </div>
        </div>
      </div>
    );
  }

  // The fetched HTML is a complete <html> document. We can't render it
  // as document.documentElement.innerHTML because React owns that. The
  // pragmatic move: extract the <body> contents AND any <style> blocks
  // from <head>, then inject into a wrapper div. For our reports the
  // styling is all inline (no <style> blocks needed), so just lifting
  // the body works cleanly.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : html;

  return (
    <div
      style={{ minHeight: "100vh", background: "#fbfaf7" }}
      dangerouslySetInnerHTML={{ __html: bodyContent }}
    />
  );
}
