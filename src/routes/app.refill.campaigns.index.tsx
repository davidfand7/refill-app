/**
 * /app/refill/campaigns — Promotions Engine Phase 1 list view.
 *
 * Spa-owner-created outreach campaigns to their own patients. Card grid
 * with state chips (Draft / Live / Closed). Empty state → CTA to /new
 * which opens the template gallery.
 *
 * Established 2026-05-15 (Promotions Engine Phase 1).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Calendar,
  CheckCircle2,
  Edit3,
  Loader2,
  Megaphone,
  Plus,
  Sparkles,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import {
  listSpaCampaigns,
  type SpaCampaign,
} from "@/server/emma-campaigns.functions";
import type { CampaignState, TemplateKind } from "@/lib/campaign-templates";

export const Route = createFileRoute("/app/refill/campaigns/")({
  component: CampaignsPage,
});

function CampaignsPage() {
  const [rows, setRows] = useState<SpaCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) setError("Please sign in to see your campaigns.");
          return;
        }
        const list = await listSpaCampaigns({ data: { accessToken: token } });
        if (!cancelled) setRows(list);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Couldn't load campaigns.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!rows) return null;
    const live: SpaCampaign[] = [];
    const draft: SpaCampaign[] = [];
    const closed: SpaCampaign[] = [];
    const archived: SpaCampaign[] = [];
    for (const r of rows) {
      switch (r.attachments.state) {
        case "live":
          live.push(r);
          break;
        case "closed":
          closed.push(r);
          break;
        case "archived":
          archived.push(r);
          break;
        default:
          draft.push(r);
      }
    }
    return { live, draft, closed, archived };
  }, [rows]);

  if (rows === null && !error) {
    return (
      <div>
        <PageHeader
          eyebrow="Emma(OS) · Campaigns"
          title="Campaigns"
          description="Outreach you run to your own clients."
        />
        <div className="px-6 lg:px-10 py-14 flex items-center justify-center gap-2 text-sm text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading campaigns…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader
          eyebrow="Emma(OS) · Campaigns"
          title="Campaigns"
          description="Outreach you run to your own clients."
        />
        <div className="px-6 lg:px-10 py-10">
          <EmptyState
            icon={Megaphone}
            title="Couldn't load your campaigns"
            description={error}
          />
        </div>
      </div>
    );
  }

  if (rows && rows.length === 0) {
    return (
      <div>
        <PageHeader
          eyebrow="Emma(OS) · Campaigns"
          title="Campaigns"
          description="Reactivation, anniversary, cross-sell — pick a template and ship."
          actions={
            <Link
              to="/app/refill/campaigns/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
            >
              <Plus className="h-3.5 w-3.5" />
              New campaign
            </Link>
          }
        />
        <div className="px-6 lg:px-10 py-10">
          <div className="max-w-xl mx-auto rounded-2xl border border-border bg-card p-10 text-center space-y-5">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-emerald/10 flex items-center justify-center">
              <Megaphone className="h-5 w-5 text-emerald" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold">No campaigns yet</h2>
              <p className="text-sm text-ink-soft leading-relaxed max-w-md mx-auto">
                Start with a template — Emma builds the cohort, drafts the
                messages, and reads the replies. You stay in control of every
                send.
              </p>
            </div>
            <Link
              to="/app/refill/campaigns/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition"
            >
              <Sparkles className="h-4 w-4" />
              Browse templates
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Emma(OS) · Campaigns"
        title="Campaigns"
        description={
          rows ? `${rows.length} campaign${rows.length === 1 ? "" : "s"} so far.` : undefined
        }
        actions={
          <Link
            to="/app/refill/campaigns/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
          >
            <Plus className="h-3.5 w-3.5" />
            New campaign
          </Link>
        }
      />
      <div className="px-6 lg:px-10 py-6 space-y-6 max-w-5xl mx-auto">
        {grouped?.live.length ? (
          <Section title="Live" rows={grouped.live} />
        ) : null}
        {grouped?.draft.length ? (
          <Section title="Drafts" rows={grouped.draft} />
        ) : null}
        {grouped?.closed.length ? (
          <Section title="Closed" rows={grouped.closed} />
        ) : null}
        {grouped?.archived.length ? (
          <Section title="Archived" rows={grouped.archived} muted />
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  rows,
  muted,
}: {
  title: string;
  rows: SpaCampaign[];
  muted?: boolean;
}) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-soft mb-2.5">
        {title}
      </div>
      <div className={"grid grid-cols-1 md:grid-cols-2 gap-3 " + (muted ? "opacity-60" : "")}>
        {rows.map((r) => (
          <CampaignCard key={r.id} campaign={r} />
        ))}
      </div>
    </section>
  );
}

function CampaignCard({ campaign }: { campaign: SpaCampaign }) {
  return (
    <Link
      to="/app/refill/campaigns/$campaignId"
      params={{ campaignId: campaign.id }}
      className="block rounded-xl border border-border bg-card hover:border-emerald/30 hover:bg-muted/30 transition px-4 py-3.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{campaign.title}</span>
            <StateChip state={campaign.attachments.state} />
          </div>
          <div className="text-[11px] text-ink-soft mt-1 line-clamp-2">
            {campaign.description || templateLabel(campaign.attachments.templateKind)}
          </div>
        </div>
        <TemplateBadge kind={campaign.attachments.templateKind} />
      </div>
      <div className="mt-2.5 flex items-center gap-3 text-[10px] text-ink-faint">
        <span className="inline-flex items-center gap-1">
          <Calendar className="h-3 w-3" />
          {campaign.attachments.starts ?? "always-on"}
          {campaign.attachments.ends ? ` → ${campaign.attachments.ends}` : ""}
        </span>
        <span className="inline-flex items-center gap-1">
          <ChannelChip channels={campaign.attachments.channels} />
        </span>
      </div>
    </Link>
  );
}

function StateChip({ state }: { state: CampaignState }) {
  const cls = STATE_CLS[state];
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
        cls
      }
    >
      {state === "live" ? <CheckCircle2 className="h-2.5 w-2.5" /> : null}
      {state === "draft" ? <Edit3 className="h-2.5 w-2.5" /> : null}
      {state}
    </span>
  );
}

const STATE_CLS: Record<CampaignState, string> = {
  draft: "bg-amber-200/70 text-amber-900 dark:bg-amber-500/30 dark:text-amber-200",
  live: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  closed: "bg-muted text-ink-soft",
  archived: "bg-muted text-ink-soft line-through",
};

function TemplateBadge({ kind }: { kind: TemplateKind }) {
  return (
    <span className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-soft">
      {templateLabel(kind)}
    </span>
  );
}

function ChannelChip({
  channels,
}: {
  channels: { sms: boolean; email: boolean };
}) {
  const parts: string[] = [];
  if (channels.sms) parts.push("SMS");
  if (channels.email) parts.push("Email");
  return <span>{parts.join(" + ") || "—"}</span>;
}

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
