/**
 * /app/refill/settings/zenoti-install — Zenoti paste-CenterID wizard (v1.41.0).
 *
 * Zenoti API key lives server-side. Spa identifies their center_id;
 * Refill scopes API calls to that center. Sibling path to avoid the
 * TanStack outlet trap.
 */

import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, ExternalLink, Key, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { useShell } from "@/lib/shell";

type SearchParams = { state?: string };

export const Route = createFileRoute("/app/refill/settings/zenoti-install")({
  validateSearch: (raw: Record<string, unknown>): SearchParams => ({
    state: typeof raw.state === "string" ? raw.state : undefined,
  }),
  component: ZenotiInstallPage,
});

function ZenotiInstallPage() {
  const search = useSearch({ from: "/app/refill/settings/zenoti-install" });
  const shell = useShell();
  const brandHeader = shell === "refill" ? "Refill" : "Emma(OS)";
  const brandName = shell === "refill" ? "Refill" : "Emma";

  const [centerId, setCenterId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!centerId.trim() || !search.state) {
      toast.error("Paste your Zenoti center_id and try again.");
      return;
    }
    setSubmitting(true);
    try {
      const body = new URLSearchParams({ center_id: centerId.trim(), state: search.state });
      const resp = await fetch("/api/integrations/zenoti/install-callback", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (resp.redirected) window.location.href = resp.url;
      else if (resp.ok) window.location.href = "/app/refill/settings/scheduler?scheduler_connected=zenoti";
      else {
        toast.error("Connect failed — double-check the center_id.");
        setSubmitting(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connect failed — try again.");
      setSubmitting(false);
    }
  }, [centerId, search.state]);

  if (!search.state) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <PageHeader eyebrow={`${brandHeader} · Settings`} title="Zenoti install" description="Start the connect flow from your scheduler settings." />
        <a href="/app/refill/settings/scheduler" className="mt-6 inline-flex items-center gap-1.5 text-sm text-emerald hover:underline">
          Back to scheduler settings <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8">
      <PageHeader
        eyebrow={`${brandHeader} · Connect Zenoti`}
        title="Paste your Zenoti center_id"
        description={`${brandName} uses shared app credentials + your center_id to access appointments and receive cancel/no-show events.`}
      />

      <ol className="mt-8 space-y-5">
        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">1</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">Find your Zenoti center_id</div>
              <div className="text-xs text-ink-soft mt-1">
                Sign in to Zenoti as the org admin. The center_id is shown under <strong>Admin &rarr; Centers &rarr; [your center]</strong>, or in the URL when viewing center settings.
              </div>
              <a href="https://admin.zenoti.com" target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90">
                <ExternalLink className="h-3.5 w-3.5" />
                Open Zenoti admin
              </a>
            </div>
          </div>
        </li>

        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">2</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">Paste it below + Connect</div>
              <div className="text-xs text-ink-soft mt-1">We&rsquo;ll validate the center_id and set up the integration.</div>
              <div className="mt-3 flex items-center gap-2">
                <Key className="h-4 w-4 text-ink-soft shrink-0" />
                <input
                  type="text"
                  value={centerId}
                  onChange={(e) => setCenterId(e.target.value)}
                  placeholder="center_xxxxxxxxxxxx"
                  className="flex-1 rounded-md border border-border bg-paper px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  disabled={submitting}
                />
              </div>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !centerId.trim()}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Connect Zenoti
              </button>
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}
