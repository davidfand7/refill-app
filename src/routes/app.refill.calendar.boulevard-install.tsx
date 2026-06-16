/**
 * /app/refill/calendar/boulevard-install — Boulevard install wizard page
 * (v1.36.0; moved under the Calendar Solution in v2.3.18 IA reorg).
 *
 * Boulevard's install model is paste-Application-ID inside the SPA's
 * Boulevard dashboard — NOT a 3-legged OAuth redirect. This page is the
 * Refill-internal step that bridges Refill's UI to the spa-side action:
 *
 *   1. Spa clicks Connect Boulevard on the settings page
 *   2. initiateBoulevardOAuth returns a URL to THIS page (carrying the
 *      Application ID + state token)
 *   3. Spa lands here, sees the Application ID with a Copy button + a
 *      "Open Boulevard Dashboard" CTA that deep-links to
 *      https://dashboard.joinblvd.com/manage-business/apps
 *   4. Spa pastes the Application ID inside Boulevard's Custom Apps
 *      install flow
 *   5. Boulevard fires a callback to
 *      /api/integrations/boulevard/install-callback with businessId +
 *      state → connection upserts, status flips to connected
 *
 * Wizard principle (per feedback_setup_wizards_auto_advance): minimize
 * cognitive load. Copy button is auto-prominent, deep link is the next
 * action, every step has a clear next step. No raw API key paste; no
 * "find this menu" instructions.
 *
 * Page is hidden behind a search-param validator — direct navigation
 * without ?application_id= renders an empty state with a CTA back to
 * the settings page (don't break the URL space).
 */

import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  CheckCircle2,
  Copy,
  ExternalLink,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { useShell } from "@/lib/shell";

type SearchParams = {
  application_id?: string;
  state?: string;
};

export const Route = createFileRoute(
  "/app/refill/calendar/boulevard-install",
)({
  validateSearch: (raw: Record<string, unknown>): SearchParams => ({
    application_id:
      typeof raw.application_id === "string" ? raw.application_id : undefined,
    state: typeof raw.state === "string" ? raw.state : undefined,
  }),
  component: BoulevardInstallPage,
});

function BoulevardInstallPage() {
  const search = useSearch({
    from: "/app/refill/calendar/boulevard-install",
  });
  const shell = useShell();
  const isRefill = shell === "refill";
  const brandHeader = isRefill ? "Refill" : "SmartSpa";
  const brandName = isRefill ? "Refill" : "Emma";

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!search.application_id) return;
    try {
      await navigator.clipboard.writeText(search.application_id);
      setCopied(true);
      toast.success("Application ID copied to clipboard.");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error(
        "Couldn't copy automatically — select the ID below and copy manually.",
      );
    }
  }, [search.application_id]);

  if (!search.application_id) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <PageHeader
          eyebrow={`${brandHeader} · Settings`}
          title="Boulevard install"
          description="This page expects an Application ID. Start the connect flow from your scheduler settings."
        />
        <a
          href="/app/refill/calendar/connections"
          className="mt-6 inline-flex items-center gap-1.5 text-sm text-emerald hover:underline"
        >
          Back to connections
          <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8">
      <PageHeader
        eyebrow={`${brandHeader} · Connect Boulevard`}
        title="Paste this Application ID into Boulevard"
        description={`Boulevard installs ${brandName} as a Custom App on your business. Copy the Application ID below, then click the button to open Boulevard's app install screen.`}
      />

      <ol className="mt-8 space-y-5">
        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">
              1
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">
                Copy your Application ID
              </div>
              <div className="text-xs text-ink-soft mt-1">
                This identifies {brandName} inside your Boulevard dashboard.
                It&rsquo;s safe to share with Boulevard — no secrets here.
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3">
                <code className="flex-1 font-mono text-sm text-ink truncate">
                  {search.application_id}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-3 py-1.5 text-xs font-medium hover:bg-emerald/90"
                >
                  {copied ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </div>
        </li>

        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">
              2
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">
                Open Boulevard&rsquo;s Apps &amp; Integrations
              </div>
              <div className="text-xs text-ink-soft mt-1">
                In your Boulevard dashboard, go to <strong>Manage Business
                &rarr; Apps &amp; Integrations &rarr; Custom Apps &rarr;
                Install</strong>. Paste the Application ID into the field
                Boulevard shows you, then click <em>Install</em>.
              </div>
              <a
                href="https://dashboard.joinblvd.com/manage-business/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Boulevard dashboard
              </a>
            </div>
          </div>
        </li>

        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">
              3
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">
                {brandName} takes it from there
              </div>
              <div className="text-xs text-ink-soft mt-1">
                As soon as Boulevard confirms the install, {brandName} will
                show <strong>Connected · syncing live</strong> on your
                scheduler settings page — no further steps. Webhooks
                register automatically; your last 30 days + next 90 days
                of appointments backfill in the background.
              </div>
              <a
                href="/app/refill/calendar/connections"
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-emerald hover:underline"
              >
                Back to connections
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        </li>
      </ol>

      <div className="mt-8 rounded-lg border border-border/60 bg-muted/10 p-4 text-xs text-ink-soft">
        <div className="font-medium text-ink mb-1">
          Don&rsquo;t see a Custom Apps option in Boulevard?
        </div>
        <div>
          Boulevard restricts Custom App installs to <strong>Premier</strong> and
          <strong> Enterprise</strong> tier subscriptions. If you&rsquo;re on Starter
          or Free, contact Boulevard support about upgrading — once your
          tier supports it, you&rsquo;ll see the install flow above.
        </div>
      </div>
    </div>
  );
}
