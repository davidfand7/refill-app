/**
 * /app/refill/calendar/booker-install — Booker paste-LocationID wizard (v1.39.0;
 * moved under the Calendar Solution in v2.3.18 IA reorg).
 *
 * Booker uses server-to-server OAuth (no user consent flow). The spa
 * identifies their LocationId; we use shared app creds + LocationId to
 * scope API calls. Sibling path to avoid TanStack outlet trap.
 */

import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, ExternalLink, Key, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { useShell } from "@/lib/shell";

type SearchParams = { state?: string };

export const Route = createFileRoute("/app/refill/calendar/booker-install")({
  validateSearch: (raw: Record<string, unknown>): SearchParams => ({
    state: typeof raw.state === "string" ? raw.state : undefined,
  }),
  component: BookerInstallPage,
});

function BookerInstallPage() {
  const search = useSearch({ from: "/app/refill/calendar/booker-install" });
  const shell = useShell();
  const brandHeader = shell === "refill" ? "Refill" : "SmartSpa";
  const brandName = shell === "refill" ? "Refill" : "SmartSpa";

  const [locationId, setLocationId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!locationId.trim() || !search.state) {
      toast.error("Paste your Booker Location ID and try again.");
      return;
    }
    setSubmitting(true);
    try {
      const body = new URLSearchParams({
        location_id: locationId.trim(),
        state: search.state,
      });
      const resp = await fetch("/api/integrations/booker/install-callback", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (resp.redirected) {
        window.location.href = resp.url;
      } else if (resp.ok) {
        window.location.href = "/app/refill/calendar/connections?scheduler_connected=booker";
      } else {
        toast.error("Connect failed — double-check the Location ID.");
        setSubmitting(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connect failed — try again.");
      setSubmitting(false);
    }
  }, [locationId, search.state]);

  if (!search.state) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <PageHeader eyebrow={`${brandHeader} · Settings`} title="Booker install" description="Start the connect flow from your scheduler settings." />
        <a href="/app/refill/calendar/connections" className="mt-6 inline-flex items-center gap-1.5 text-sm text-emerald hover:underline">
          Back to connections <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8">
      <PageHeader
        eyebrow={`${brandHeader} · Connect Booker`}
        title="Paste your Booker Location ID"
        description={`${brandName} will use shared app credentials + your Location ID to access your appointments and receive cancel/no-show events.`}
      />

      <ol className="mt-8 space-y-5">
        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">1</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">Find your Booker Location ID</div>
              <div className="text-xs text-ink-soft mt-1">
                Sign in to your Booker merchant dashboard. The Location ID is shown under <strong>Settings &rarr; Business Info</strong>, or in the URL when viewing your location settings.
              </div>
              <a href="https://app.booker.com/login" target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90">
                <ExternalLink className="h-3.5 w-3.5" />
                Open Booker dashboard
              </a>
            </div>
          </div>
        </li>

        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">2</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">Paste it below + Connect</div>
              <div className="text-xs text-ink-soft mt-1">
                Then click Connect — we&rsquo;ll validate the ID and set up the integration.
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Key className="h-4 w-4 text-ink-soft shrink-0" />
                <input
                  type="text"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  placeholder="bkr_xxxxxxxxxxxx"
                  className="flex-1 rounded-md border border-border bg-paper px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  disabled={submitting}
                />
              </div>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !locationId.trim()}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Connect Booker
              </button>
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}
