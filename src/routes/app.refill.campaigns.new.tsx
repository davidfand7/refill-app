/**
 * /app/refill/campaigns/new — Promotions Engine Phase 1 template gallery.
 *
 * 8 cards: pick a template, hit Create, land on the detail page for the new
 * campaign. The custom card is the "none of these fit" escape hatch.
 *
 * Phase 1 is intentionally just template selection — Phase 2 builds the
 * cohort editor inside the detail page, Phase 3 builds the blast composer.
 * Right now "Create" puts a draft on the list and the spa owner sees the
 * defaults; editing happens in /campaigns/$id (read-only for Phase 1).
 *
 * Established 2026-05-15 (Promotions Engine Phase 1).
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Cake,
  Calendar,
  Gift,
  Heart,
  Loader2,
  Megaphone,
  PartyPopper,
  Plus,
  Sparkles,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { createSpaCampaign } from "@/server/emma-campaigns.functions";
import {
  CAMPAIGN_TEMPLATES,
  type CampaignTemplateDef,
  type TemplateKind,
} from "@/lib/campaign-templates";

export const Route = createFileRoute("/app/refill/campaigns/new")({
  component: NewCampaignPage,
});

function NewCampaignPage() {
  const navigate = useNavigate();
  const [busyKind, setBusyKind] = useState<TemplateKind | null>(null);

  async function pick(template: CampaignTemplateDef) {
    setBusyKind(template.kind);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign-in lost — refresh and try again.");
        return;
      }
      const created = await createSpaCampaign({
        data: { accessToken: token, templateKind: template.kind },
      });
      toast.success(`Created "${created.title}" as a draft.`);
      void navigate({
        to: "/app/refill/campaigns/$campaignId",
        params: { campaignId: created.id },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create campaign.");
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="SmartSpa · Campaigns"
        title="Pick a starting point"
        description="Eight templates cover the workflows most spas run. Pick one to scaffold the cohort + offer + copy — you can edit everything before sending."
        breadcrumbs={[
          { label: "Emma", to: "/app/refill" },
          { label: "Campaigns", to: "/app/refill/campaigns" },
          { label: "New" },
        ]}
        actions={
          <Link
            to="/app/refill/campaigns"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Link>
        }
      />
      <div className="px-6 lg:px-10 py-8 max-w-[960px] mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {CAMPAIGN_TEMPLATES.map((t) => (
            <TemplateCard
              key={t.kind}
              template={t}
              busy={busyKind === t.kind}
              onPick={() => void pick(t)}
            />
          ))}
        </div>
        <p className="mt-6 text-[11px] text-ink-faint text-center max-w-xl mx-auto leading-relaxed">
          Tip: start with <strong>Reactivation</strong> if you're new to
          campaigns. It's the highest-ROI play for any med spa and the cohort
          (patients gone {">"} 6mo) is usually the largest.
        </p>
      </div>
    </div>
  );
}

const TEMPLATE_ICONS: Record<TemplateKind, LucideIcon> = {
  first_time: UserPlus,
  reactivation: Heart,
  cross_sell: Sparkles,
  volume_upsell: TrendingUp,
  anniversary: PartyPopper,
  loyalty: Gift,
  birthday: Cake,
  custom: Plus,
};

function TemplateCard({
  template,
  busy,
  onPick,
}: {
  template: CampaignTemplateDef;
  busy: boolean;
  onPick: () => void;
}) {
  const Icon = TEMPLATE_ICONS[template.kind] ?? Megaphone;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={busy}
      className="text-left rounded-xl border border-border bg-card hover:border-emerald/40 hover:bg-muted/30 transition px-4 py-4 disabled:opacity-60 disabled:cursor-wait flex gap-3"
    >
      <div className="h-9 w-9 rounded-lg bg-emerald/10 flex items-center justify-center shrink-0">
        {busy ? (
          <Loader2 className="h-4 w-4 text-emerald animate-spin" />
        ) : (
          <Icon className="h-4 w-4 text-emerald" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{template.title}</div>
        <p className="text-[11px] text-ink-soft mt-1 leading-relaxed">
          {template.description}
        </p>
        <div className="mt-2 text-[10px] italic text-ink-faint flex items-start gap-1">
          <Calendar className="h-2.5 w-2.5 mt-0.5 shrink-0" />
          <span>"{template.exampleCopy}"</span>
        </div>
      </div>
    </button>
  );
}
