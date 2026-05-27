import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  Check, Zap, Bot, ArrowRight, Sparkles, Lock, Key, Users, Infinity as InfinityIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Agentiport" },
      { name: "description", content: "Free forever for builders. Pro for teams that run at scale." },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: PricingPage,
});

const PLANS = [
  {
    key: "free" as const,
    name: "Free",
    price: 0,
    subtitle: "For builders getting started",
    cta: "Start for free",
    ctaTo: "/login",
    highlight: false,
    apiKey: "Your Anthropic key",
    features: [
      "3 agents",
      "50 runs / month",
      "All integrations (Gmail, Slack, GitHub…)",
      "Webhook & email event triggers",
      "Agent gallery — install & share",
      "You bring your own Claude API key",
    ],
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: 19,
    subtitle: "For teams running agents at scale",
    cta: "Upgrade to Pro",
    ctaTo: null, // handled via JS
    highlight: true,
    apiKey: "Platform-provided",
    features: [
      "20 agents",
      "2,000 runs / month",
      "Everything in Free",
      "Platform Claude key — zero API setup",
      "Priority scheduling",
      "Email run digests",
    ],
  },
  {
    key: "business" as const,
    name: "Business",
    price: 99,
    subtitle: "Unlimited scale, unlimited agents",
    cta: "Upgrade to Business",
    ctaTo: null,
    highlight: false,
    apiKey: "Platform-provided",
    features: [
      "Unlimited agents",
      "Unlimited runs",
      "Everything in Pro",
      "Team workspaces (coming soon)",
      "Custom domains (coming soon)",
      "Priority support",
    ],
  },
] as const;

type PlanKey = typeof PLANS[number]["key"];

function PlanCard({ plan, onUpgrade, upgrading }: {
  plan: typeof PLANS[number];
  onUpgrade: (key: PlanKey) => void;
  upgrading: PlanKey | null;
}) {
  return (
    <div className={cn(
      "relative flex flex-col rounded-3xl border p-8 transition",
      plan.highlight
        ? "border-emerald bg-emerald/5 shadow-xl shadow-primary/10"
        : "border-border bg-card",
    )}>
      {plan.highlight && (
        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-emerald px-4 py-1 text-xs font-bold text-paper">
          Most popular
        </div>
      )}

      {/* Header */}
      <div className="space-y-1 mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-ink-soft">{plan.name}</p>
        <div className="flex items-end gap-1.5">
          <span className="text-4xl font-black">${plan.price}</span>
          {plan.price > 0 && <span className="text-ink-soft text-sm mb-1.5">/month</span>}
          {plan.price === 0 && <span className="text-ink-soft text-sm mb-1.5">forever</span>}
        </div>
        <p className="text-sm text-ink-soft">{plan.subtitle}</p>
      </div>

      {/* API key model callout */}
      <div className={cn(
        "flex items-center gap-2 rounded-xl px-3 py-2 mb-6 text-xs font-medium",
        plan.price === 0
          ? "bg-amber/10 border border-amber/20 text-amber"
          : "bg-sage/10 border border-sage/20 text-sage",
      )}>
        <Key className="h-3.5 w-3.5 shrink-0" />
        {plan.apiKey}
      </div>

      {/* Features */}
      <ul className="space-y-3 flex-1 mb-8">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm">
            <Check className={cn(
              "h-4 w-4 shrink-0 mt-0.5",
              plan.highlight ? "text-emerald" : "text-sage",
            )} />
            <span className={f.includes("coming soon") ? "text-ink-soft" : "text-foreground"}>
              {f}
            </span>
          </li>
        ))}
      </ul>

      {/* CTA */}
      {plan.ctaTo ? (
        <Link
          to={plan.ctaTo as any}
          className={cn(
            "inline-flex items-center justify-center gap-2 rounded-2xl py-3 text-sm font-bold transition",
            plan.highlight
              ? "bg-emerald text-paper hover:opacity-90"
              : "bg-muted text-foreground hover:bg-muted/80",
          )}
        >
          {plan.cta} <ArrowRight className="h-4 w-4" />
        </Link>
      ) : (
        <button
          onClick={() => onUpgrade(plan.key)}
          disabled={upgrading === plan.key}
          className={cn(
            "inline-flex items-center justify-center gap-2 rounded-2xl py-3 text-sm font-bold transition disabled:opacity-60",
            plan.highlight
              ? "bg-emerald text-paper hover:opacity-90"
              : "bg-muted text-foreground hover:bg-muted/80",
          )}
        >
          {upgrading === plan.key
            ? "Redirecting…"
            : <>{plan.cta} <ArrowRight className="h-4 w-4" /></>}
        </button>
      )}
    </div>
  );
}

function PricingPage() {
  const [upgrading, setUpgrading] = useState<PlanKey | null>(null);

  const handleUpgrade = async (plan: PlanKey) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      // Not logged in — send to auth with redirect
      window.location.href = "/auth?next=/pricing";
      return;
    }

    setUpgrading(plan);
    try {
      const res = await fetch("/api/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Failed to start checkout");
      window.location.href = data.url;
    } catch (e: any) {
      toast.error(e.message ?? "Something went wrong");
      setUpgrading(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="border-b border-border bg-card/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 text-sm font-bold">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald text-paper text-xs font-bold">OA</div>
            Agentiport
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/app" className="text-sm text-ink-soft hover:text-foreground transition">
              Dashboard
            </Link>
            <Link
              to="/login"
              className="rounded-lg bg-emerald px-3 py-1.5 text-sm font-semibold text-paper hover:opacity-90 transition"
            >
              Get started free
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-16 space-y-16">

        {/* Hero */}
        <div className="text-center space-y-4 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald/10 border border-emerald/20 px-3 py-1 text-xs font-semibold text-emerald">
            <Sparkles className="h-3 w-3" /> Simple, transparent pricing
          </div>
          <h1 className="text-4xl sm:text-5xl font-black tracking-tight">
            Host your agents.
            <br />
            <span className="text-emerald">Pay for the platform, not Claude.</span>
          </h1>
          <p className="text-lg text-ink-soft leading-relaxed">
            On Free, you bring your own Anthropic key — we run the orchestration.
            On Pro and Business, we provide the Claude access. You just build.
          </p>
        </div>

        {/* Pricing cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map((plan) => (
            <PlanCard
              key={plan.key}
              plan={plan}
              onUpgrade={handleUpgrade}
              upgrading={upgrading}
            />
          ))}
        </div>

        {/* Trust row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
          {[
            { icon: Lock, title: "No vendor lock-in", body: "Export your agents any time. Your data stays yours." },
            { icon: Bot, title: "Real hosting", body: "pg_cron fires every 5 minutes. Agents run even when you're asleep." },
            { icon: Users, title: "Built for builders", body: "Every plan includes the full API, webhooks, and event triggers." },
          ].map((item) => (
            <div key={item.title} className="rounded-2xl border border-border bg-card p-6 space-y-2">
              <item.icon className="h-6 w-6 text-emerald mx-auto" />
              <p className="font-semibold text-sm">{item.title}</p>
              <p className="text-xs text-ink-soft leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>

        {/* FAQ row */}
        <div className="max-w-2xl mx-auto space-y-4">
          <h2 className="text-xl font-bold text-center">Common questions</h2>
          {[
            {
              q: "What happens if I hit my run limit?",
              a: "Runs that exceed the monthly limit are blocked with a clear error in your Run History. Your agents aren't deleted — just paused until next month or until you upgrade.",
            },
            {
              q: "Can I cancel any time?",
              a: "Yes. Cancel from Settings at any time. You keep Pro access until the end of your billing period, then drop to Free.",
            },
            {
              q: "What's a 'run'?",
              a: "Each time one of your live agents executes — whether triggered by a schedule, a webhook, or an incoming email — that's one run.",
            },
            {
              q: "Do I need to set up anything to use the platform key?",
              a: "No. Pro and Business subscribers get Claude access through the platform with zero setup. Free users need to add their own Anthropic key in Settings → Models.",
            },
          ].map((item) => (
            <div key={item.q} className="rounded-2xl border border-border bg-card p-5 space-y-1">
              <p className="font-semibold text-sm">{item.q}</p>
              <p className="text-sm text-ink-soft leading-relaxed">{item.a}</p>
            </div>
          ))}
        </div>

        {/* Bottom CTA */}
        <div className="rounded-3xl bg-gradient-to-br from-primary/10 to-primary/5 border border-emerald/20 p-10 text-center space-y-4">
          <h2 className="text-2xl font-black">Ready to host your first agent?</h2>
          <p className="text-ink-soft text-sm">Free forever. No credit card required.</p>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 rounded-2xl bg-emerald text-paper px-8 py-3 text-sm font-bold hover:opacity-90 transition"
          >
            <Zap className="h-4 w-4" /> Start building free
          </Link>
        </div>

      </div>
    </div>
  );
}
