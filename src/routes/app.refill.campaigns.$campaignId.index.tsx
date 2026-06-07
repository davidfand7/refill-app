/**
 * /app/refill/campaigns/$campaignId — Promotions Engine Phase 1 detail page.
 *
 * Read-mostly Phase 1 detail: shows the campaign's title, description,
 * template kind, offer, cohort query (raw), channels, window. The cohort
 * editor (Phase 2) and blast composer (Phase 3) hang off this page as
 * additional sections — for now we render placeholders pointing at what's
 * coming next so the spa owner has a mental model of the full flow.
 *
 * State transitions (Phase 1): Draft → Archived only. Live + Closed land
 * in Phase 3 when the blast composer can actually send.
 *
 * Established 2026-05-15 (Promotions Engine Phase 1).
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArchiveX,
  ArrowLeft,
  CalendarRange,
  CheckCircle2,
  Loader2,
  Mail,
  MessageSquare,
  Sparkles,
  Tag,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  archiveSpaCampaign,
  getSpaCampaignById,
  updateSpaCampaign,
  type SpaCampaign,
} from "@/server/emma-campaigns.functions";
import type {
  CampaignAttachments,
  CampaignOffer,
  TemplateKind,
} from "@/lib/campaign-templates";
import { CohortEditor } from "@/components/emma/CohortEditor";

export const Route = createFileRoute("/app/refill/campaigns/$campaignId/")({
  component: CampaignDetailPage,
});

function CampaignDetailPage() {
  const { campaignId } = Route.useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState<SpaCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) {
            setLoading(false);
            setError("Please sign in to view this campaign.");
          }
          return;
        }
        const c = await getSpaCampaignById({
          data: { accessToken: token, campaignId },
        });
        if (!cancelled) {
          setCampaign(c);
          setLoading(false);
          if (!c) setError("Campaign not found.");
        }
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          setError(e instanceof Error ? e.message : "Couldn't load campaign.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  async function onArchive() {
    if (!campaign) return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await archiveSpaCampaign({ data: { accessToken: token, campaignId } });
      toast.success("Campaign archived.");
      void navigate({ to: "/app/refill/campaigns" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't archive.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Emma(OS) · Campaign"
        title={campaign?.title ?? (loading ? "Loading…" : "Campaign")}
        description={campaign?.description ?? undefined}
        breadcrumbs={[
          { label: "Emma", to: "/app/refill" },
          { label: "Campaigns", to: "/app/refill/campaigns" },
          { label: campaign?.title ?? "Campaign" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/refill/campaigns"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All campaigns
            </Link>
            {campaign && campaign.attachments.state !== "archived" && (
              <>
                <Link
                  to="/app/refill/campaigns/$campaignId/blast"
                  params={{ campaignId }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Compose blast
                </Link>
                <button
                  type="button"
                  onClick={() => void onArchive()}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-foreground hover:bg-muted transition disabled:opacity-50"
                >
                  <ArchiveX className="h-3.5 w-3.5" />
                  Archive
                </button>
              </>
            )}
          </div>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[1600px] w-full mx-auto space-y-5">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading campaign…
          </div>
        ) : error || !campaign ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
            <div className="text-sm font-semibold text-destructive">
              Couldn't load this campaign
            </div>
            <p className="text-xs text-ink-soft mt-1">{error}</p>
            <Link
              to="/app/refill/campaigns"
              className="inline-flex items-center gap-1.5 mt-3 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to campaigns
            </Link>
          </div>
        ) : (
          <>
            <BasicsCard campaign={campaign} />
            <OfferCard offer={campaign.attachments.offer} />
            <CohortEditor
              value={campaign.attachments.cohortQuery}
              readOnly={campaign.attachments.state === "archived"}
              onSave={async (next) => {
                const { data: sess } = await supabase.auth.getSession();
                const token = sess.session?.access_token;
                if (!token) {
                  toast.error("Sign-in lost — refresh and try again.");
                  return;
                }
                try {
                  const updated = await updateSpaCampaign({
                    data: {
                      accessToken: token,
                      campaignId,
                      attachments: { cohortQuery: next },
                    },
                  });
                  setCampaign(updated);
                  toast.success("Cohort updated.");
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Couldn't save cohort.",
                  );
                  throw e;
                }
              }}
            />
            <NextStepsCard templateKind={campaign.attachments.templateKind} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Section cards ────────────────────────────────────────────────────────

function BasicsCard({ campaign }: { campaign: SpaCampaign }) {
  const a = campaign.attachments;
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-muted/30 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Basics
        </div>
        <StateChip state={a.state} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-border">
        <Stat
          icon={<Tag className="h-3.5 w-3.5" />}
          label="Template"
          value={templateLabel(a.templateKind)}
        />
        <Stat
          icon={<CalendarRange className="h-3.5 w-3.5" />}
          label="Window"
          value={
            a.starts || a.ends
              ? `${a.starts ?? "—"} → ${a.ends ?? "open"}`
              : "Always-on"
          }
        />
        <Stat
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label="Channels"
          value={channelLabel(a.channels)}
        />
        <Stat
          icon={<Mail className="h-3.5 w-3.5" />}
          label="Cap / patient"
          value={`every ${a.velocityCapDays}d`}
        />
      </div>
    </section>
  );
}

function OfferCard({ offer }: { offer: CampaignOffer }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-muted/30">
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Offer
        </div>
      </div>
      <div className="px-5 py-4 space-y-2">
        {offer.headline && (
          <div className="text-base font-semibold">{offer.headline}</div>
        )}
        <div className="flex flex-wrap gap-2 text-xs">
          {offer.discountPct !== undefined && (
            <Chip label={`${offer.discountPct}% off`} />
          )}
          {offer.flatAmountUsd !== undefined && (
            <Chip label={`$${offer.flatAmountUsd} off`} />
          )}
          {offer.freeUnits !== undefined && (
            <Chip label={`${offer.freeUnits} free units`} />
          )}
          {!offer.discountPct &&
            !offer.flatAmountUsd &&
            !offer.freeUnits &&
            !offer.headline && (
              <span className="text-ink-faint italic">
                No offer set yet — add one before going live.
              </span>
            )}
        </div>
      </div>
    </section>
  );
}


function NextStepsCard({ templateKind }: { templateKind: TemplateKind }) {
  return (
    <section className="rounded-xl border border-dashed border-emerald/30 bg-emerald/5 overflow-hidden">
      <div className="px-5 py-3 border-b border-emerald/20 flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-emerald" />
        <div className="text-xs font-semibold uppercase tracking-wider text-emerald">
          What's coming next
        </div>
      </div>
      <ul className="px-5 py-3 text-xs space-y-1.5 text-ink-soft">
        <li className="flex items-start gap-2">
          <CheckCircle2 className="h-3 w-3 mt-0.5 text-emerald shrink-0" />
          <span>
            <strong>Phase 2 — Cohort editor</strong>: edit filters visually,
            preview matched count + sample patients.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Users className="h-3 w-3 mt-0.5 text-emerald shrink-0" />
          <span>
            <strong>Phase 3 — Blast composer</strong>: per-patient Emma drafts,
            review, send via SMS + email.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Mail className="h-3 w-3 mt-0.5 text-emerald shrink-0" />
          <span>
            <strong>Phase 4-9</strong>: public booking page, AI Q&amp;A, inbox,
            auto-drafts, cadence digest, campaign reporting.
          </span>
        </li>
        <li className="text-[11px] text-ink-faint italic pl-5 mt-2">
          Template kind: {templateLabel(templateKind)}.
        </li>
      </ul>
    </section>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-soft font-semibold mb-1">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2.5 py-0.5 text-[11px] font-semibold">
      {label}
    </span>
  );
}

function StateChip({ state }: { state: CampaignAttachments["state"] }) {
  const cls = STATE_CLS[state];
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
        cls
      }
    >
      {state}
    </span>
  );
}

const STATE_CLS: Record<CampaignAttachments["state"], string> = {
  draft: "bg-amber-200/70 text-amber-900 dark:bg-amber-500/30 dark:text-amber-200",
  live: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  closed: "bg-muted text-ink-soft",
  archived: "bg-muted text-ink-soft line-through",
};

function templateLabel(kind: TemplateKind): string {
  switch (kind) {
    case "first_time":
      return "First-time";
    case "reactivation":
      return "Reactivation";
    case "cross_sell":
      return "Cross-sell";
    case "volume_upsell":
      return "Volume upsell";
    case "anniversary":
      return "Anniversary";
    case "loyalty":
      return "Loyalty";
    case "birthday":
      return "Birthday";
    case "custom":
      return "Custom";
    default:
      return kind;
  }
}

function channelLabel(channels: { sms: boolean; email: boolean }): string {
  const parts: string[] = [];
  if (channels.sms) parts.push("SMS");
  if (channels.email) parts.push("Email");
  return parts.join(" + ") || "—";
}

