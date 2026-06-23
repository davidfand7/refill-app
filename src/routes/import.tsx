/**
 * /import — bookmarklet bridge page (Capture/bookmarklet lane).
 *
 * The spa's personalized bookmarklet (rendered on the Verified-pricing tab with
 * the spa token baked in) grabs the portal page's innerText and opens
 *   https://smartspa.app/import#<base64({tk,text,url,title,ts})>
 * The data rides the URL FRAGMENT — never sent to a server, so the portal's CSP
 * (connect-src) can't block it (navigation, not fetch). This page reads the
 * fragment and submits it from SmartSpa's OWN origin via a token-authed server
 * fn → Claude text-extract → match → review inbox. See project_capture_lane.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { createPortalImportFromTextFn } from "@/server/portal-import.functions";

export const Route = createFileRoute("/import")({ component: ImportBridge });

/** UTF-8-safe base64 → string (pairs with the bookmarklet's btoa(unescape(
 *  encodeURIComponent(...)))). */
function b64ToStr(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function reasonMsg(reason?: string): string {
  if (reason === "unknown_token")
    return "That importer link isn't recognized — re-grab your importer button from SmartSpa.";
  if (reason === "no_tenant") return "No spa is linked to that importer.";
  return reason || "Something went wrong reading that page.";
}

function ImportBridge() {
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [headline, setHeadline] = useState("Reading your prices…");
  const [sub, setSub] = useState("This takes a few seconds.");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const hash = window.location.hash.replace(/^#/, "");
        if (!hash)
          throw new Error(
            "Nothing to import — click your SmartSpa importer while on a portal price page.",
          );
        let payload: { tk?: string; text?: string; url?: string; title?: string; ts?: number };
        try {
          payload = JSON.parse(b64ToStr(hash));
        } catch {
          throw new Error("Couldn't read the import data — re-grab your importer button from SmartSpa.");
        }
        if (!payload.tk || !payload.text) throw new Error("That page had no readable price text.");
        const r = await createPortalImportFromTextFn({
          data: {
            token: payload.tk,
            text: payload.text,
            pageUrl: payload.url,
            pageTitle: payload.title,
            captureId: payload.ts ? String(payload.ts) : undefined,
          },
        });
        if (cancelled) return;
        // Clear the fragment (carries the token) from the address bar.
        try {
          window.history.replaceState(null, "", window.location.pathname);
        } catch {
          /* no-op */
        }
        if (r.ok) {
          setStatus("done");
          setHeadline(
            r.matched ? `Imported — ${r.matched}/${r.prices} matched.` : "Imported your prices.",
          );
          setSub("Open Verified pricing to review and confirm.");
        } else {
          setStatus("error");
          setHeadline("Couldn't import");
          setSub(reasonMsg(r.reason));
        }
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setHeadline("Couldn't import");
        setSub(e instanceof Error ? e.message : "Something went wrong.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md rounded-2xl border border-rule bg-white px-7 py-9 text-center shadow-sm">
        {status === "working" && <Loader2 className="mx-auto h-9 w-9 animate-spin text-emerald" />}
        {status === "done" && <CheckCircle2 className="mx-auto h-9 w-9 text-emerald" />}
        {status === "error" && <AlertTriangle className="mx-auto h-9 w-9 text-amber-ink" />}
        <h1 className="mt-4 text-[19px] font-semibold text-ink">{headline}</h1>
        {sub && <p className="mt-1.5 text-[13.5px] text-ink-soft leading-relaxed">{sub}</p>}
        {status !== "working" && (
          <Link
            to="/app/refill/catalog/verified-pricing"
            className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
          >
            Open Verified pricing →
          </Link>
        )}
      </div>
    </div>
  );
}
