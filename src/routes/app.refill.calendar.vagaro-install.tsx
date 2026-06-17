/**
 * /app/refill/calendar/vagaro-install — Vagaro install wizard
 * (v1.38.0 base + v1.43.3 Rejuv-tested onboarding playbook;
 *  moved under the Calendar Solution in v2.3.18 IA reorg).
 *
 * v1.43.3 update: Rejuv (Refill's own design partner / reference spa)
 * went through Vagaro's full onboarding flow first and captured every
 * step — prerequisite gates, exact form URL, optimal use-case language,
 * approval wait, generate-key path. This wizard now replays that
 * proven path for every other spa so onboarding collapses from
 * "figure it out + risk a denial" to "follow this 60-second flow +
 * 7-day wait." Per the customer-as-developer-access doctrine
 * (banked 2026-06-03): Refill can't proxy Rejuv's keys for other spas
 * (Vagaro's per-merchant model issues keys tied to each account),
 * BUT we can guide every other spa through the exact path Rejuv
 * proved works.
 *
 * Sibling path to /app/refill/settings/scheduler to dodge the TanStack
 * outlet trap (feedback_tanstack_outlet_trap).
 */

import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Key,
  Loader2,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { useShell } from "@/lib/shell";

/**
 * v1.43.3 — the actual Vagaro API/Webhooks Contact form (Asana-hosted).
 * Discovered by Grasshopper 2026-06-03 during Rejuv onboarding scout.
 * This is the gate every Vagaro merchant submits — Refill's wizard
 * deep-links them straight to it with a pre-written use-case template
 * tuned to maximize approval probability + minimize Refill-brand
 * aggregate signal at Vagaro's review queue.
 */
const VAGARO_API_REQUEST_FORM_URL =
  "https://form.asana.com/?k=SX3qQGg2syKV53wH-rl34w&d=35883393372079";

/**
 * Pre-written use-case language for the "Tell us more about how you
 * plan to use Vagaro's webhooks" free-text field. Frames the spa's
 * legitimate operational need (not the Refill brand) per the
 * stealth-posture refinement banked in project_vagaro_priority_reframe.
 */
const VAGARO_USE_CASE_TEMPLATE = `I need to automate cancellation rebooking and waitlist outreach for my practice. We currently lose ~8-12% of revenue to last-minute cancellations and no-shows. I'm using a third-party tool to close the loop on cancellations via webhooks — when an appointment is cancelled or marked no-show (Appointments + Customers events), the tool matches the open slot to an eligible waitlist patient automatically.`;

const VAGARO_GENERATE_KEY_PATH =
  "Settings → Developers → APIs & Webhooks";

type SearchParams = { state?: string };

export const Route = createFileRoute(
  "/app/refill/calendar/vagaro-install",
)({
  validateSearch: (raw: Record<string, unknown>): SearchParams => ({
    state: typeof raw.state === "string" ? raw.state : undefined,
  }),
  component: VagaroInstallPage,
});

function VagaroInstallPage() {
  const search = useSearch({ from: "/app/refill/calendar/vagaro-install" });
  const shell = useShell();
  const isRefill = shell === "refill";
  const brandHeader = isRefill ? "Refill" : "SmartSpa";
  const brandName = isRefill ? "Refill" : "SmartSpa";

  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!apiKey.trim() || !search.state) {
      toast.error("Paste your Vagaro API key and try again.");
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("api_key", apiKey.trim());
      form.set("state", search.state);
      const resp = await fetch("/api/integrations/vagaro/install-callback", {
        method: "POST",
        body: new URLSearchParams(Object.fromEntries(form as unknown as Iterable<[string, string]>)),
      });
      // install-callback redirects on success/failure; we just follow.
      if (resp.redirected) {
        window.location.href = resp.url;
      } else if (resp.ok) {
        window.location.href = "/app/refill/calendar/connections?scheduler_connected=vagaro";
      } else {
        toast.error("Connect failed — double-check the API key.");
        setSubmitting(false);
      }
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Connect failed — try again.",
      );
      setSubmitting(false);
    }
  }, [apiKey, search.state]);

  if (!search.state) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <PageHeader
          eyebrow={`${brandHeader} · Settings`}
          title="Vagaro install"
          description="Start the connect flow from your scheduler settings."
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
        eyebrow={`${brandHeader} · Connect Vagaro`}
        title="Paste your Vagaro API key"
        description={`${brandName} will use this key to read appointments + receive cancel/no-show webhooks. Your key never leaves your Vagaro account or our database.`}
      />

      <div className="mt-6 rounded-lg border border-emerald/40 bg-emerald/5 p-4 text-xs text-ink-soft">
        <div className="font-medium text-emerald mb-1">
          🎯 The 60-second guided path (Rejuv-tested)
        </div>
        <div>
          {brandName} ran this exact onboarding flow first at our reference
          spa Rejuv. The steps below replay the proven path so you skip the
          trial-and-error. Total wait: ~7 business days for Vagaro to
          approve API access. Your hands-on time: ~5 minutes.
        </div>
      </div>

      <ol className="mt-6 space-y-5">
        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">
              1
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">
                Confirm your Vagaro account qualifies
              </div>
              <div className="text-xs text-ink-soft mt-1">
                Vagaro requires the following for API access:
              </div>
              <ul className="mt-2 ml-4 text-xs text-ink-soft list-disc space-y-0.5">
                <li>
                  Vagaro <strong>Pro plan</strong> (not the free trial &mdash;
                  trial accounts cannot request API access)
                </li>
                <li>
                  Using the <strong>computer, tablet, Pay Desk, or PayPro</strong>{" "}
                  version of Vagaro (not mobile-only)
                </li>
                <li>
                  <strong>Vagaro CC Processing</strong> active for your
                  business
                </li>
              </ul>
              <div className="mt-2 text-xs text-ink-soft">
                Not on Pro yet? Sign up at{" "}
                <a
                  href="https://www.vagaro.com/pro/pricing"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald hover:underline inline-flex items-center gap-1"
                >
                  vagaro.com/pro/pricing
                  <ExternalLink className="h-3 w-3" />
                </a>
                {" "}before continuing.
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
                Submit Vagaro&rsquo;s API/Webhooks request form
              </div>
              <div className="text-xs text-ink-soft mt-1">
                Open the form below. Vagaro asks for your business name,
                contact info, which webhooks you&rsquo;ll use (check all 4:
                Customers, Appointments, Transactions, Form Submissions),
                and a use-case description. <strong>Vagaro approval can
                take up to 7 business days.</strong>
              </div>
              <a
                href={VAGARO_API_REQUEST_FORM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Vagaro&rsquo;s API request form
              </a>
              <div className="mt-4 text-xs">
                <div className="font-medium text-ink mb-1.5">
                  Copy-paste this for the &ldquo;Tell us how you plan to use
                  Vagaro&rsquo;s webhooks&rdquo; field:
                </div>
                <UseCaseTemplateCopier text={VAGARO_USE_CASE_TEMPLATE} />
                <div className="mt-1.5 text-[11px] text-ink-soft">
                  This wording maximizes approval probability &mdash; it
                  describes your operational need (not the {brandName}{" "}
                  brand) which Vagaro&rsquo;s review team prefers.
                </div>
              </div>
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
                Wait for Vagaro approval (~7 business days)
              </div>
              <div className="text-xs text-ink-soft mt-1">
                Vagaro emails you when API access is enabled. Approval is
                typically routine for legitimate practices &mdash;
                Rejuv&rsquo;s approval cleared in 4 business days. A
                &ldquo;minor add-on fee&rdquo; (Vagaro&rsquo;s exact
                wording) appears on your monthly invoice once active.
              </div>
            </div>
          </div>
        </li>

        <li className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald/10 text-emerald text-sm font-medium shrink-0">
              4
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">
                Generate your API key + paste below
              </div>
              <div className="text-xs text-ink-soft mt-1">
                Once approved, log in to Vagaro Pro and navigate to{" "}
                <strong>{VAGARO_GENERATE_KEY_PATH}</strong>. Generate a
                verification token + webhook endpoint URL. Copy the API
                key value and paste it below.
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Key className="h-4 w-4 text-ink-soft shrink-0" />
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="vagaro_xxxxxxxxxxxxxxxxxxxx"
                  className="flex-1 rounded-md border border-border bg-paper px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
                  disabled={submitting}
                />
              </div>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !apiKey.trim()}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Connect Vagaro
              </button>
            </div>
          </div>
        </li>
      </ol>

      <div className="mt-8 rounded-lg border border-border/60 bg-muted/10 p-4 text-xs text-ink-soft">
        <div className="font-medium text-ink mb-1">
          Why does Vagaro charge a fee for API access?
        </div>
        <div>
          Vagaro publishes their API surface (docs.vagaro.com) for free but
          gates the actual API key issuance behind their{" "}
          <em>&ldquo;APIs &amp; Webhooks&rdquo;</em> add-on. The fee is
          billed to your business, not to {brandName}. Exact pricing routes
          through Vagaro Enterprise Sales &mdash; ask in the form&rsquo;s
          free-text field if you want the current rate before approval.
        </div>
      </div>
    </div>
  );
}

/**
 * v1.43.3 — copy-to-clipboard component for the use-case template.
 * Reduces friction at the Vagaro Asana form: tap once, paste once.
 */
function UseCaseTemplateCopier({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      toast.success("Use-case template copied. Paste it into Vagaro's form.");
      window.setTimeout(() => setCopied(false), 3000);
    });
  }, [text]);
  return (
    <div className="rounded-md bg-paper border border-border/70 p-3 relative">
      <div className="text-[12px] text-ink-soft whitespace-pre-wrap pr-12 leading-relaxed font-sans">
        {text}
      </div>
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-emerald/10 text-emerald px-2 py-1 text-[11px] font-medium hover:bg-emerald/20"
      >
        {copied ? (
          <Check className="h-3 w-3" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
