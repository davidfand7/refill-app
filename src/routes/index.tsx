import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useShell } from "@/lib/shell";
import { useAuth } from "@/lib/auth";
import {
  ArrowRight, Zap, DollarSign, Sparkles,
  Github, CheckCircle2, RefreshCw,
  ShieldCheck, Star, Boxes, Terminal, Package,
  Briefcase, MessageSquare,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SmartSpa — the patient-profitability OS" },
      { name: "description", content: "SmartSpa fills chairs, recovers no-shows, and turns manufacturer rewards into booked visits — and only bills when it creates real revenue for you." },
      // noindex stays during stealth — remove when ready for public launch
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: RootIndex,
});

// Stage 2 vertical breakout: dispatch the apex `/` based on the shell
// detected client-side via useShell(). On hard reloads of vertical
// subdomains the SSR + first paint render the platform LandingPage briefly
// before snapping to the vertical hero (Stage 3 follow-up: plumb the
// Worker stamp into SSR for a flash-free first paint).
//
// v414: Refill standalone product landing. getrefill.app/ used to 302
// straight to /scan (v369.2 — "land on value"). As Refill matures, a
// stranger typing the bare URL expects a "what is this" front door, not
// a tool. RefillLanding is the sparse spa-anchored hero with /scan as
// the primary CTA — preserves the conversion funnel, adds the brand
// front door per the Po CTO Goal 1 IA cleanup.
function RootIndex() {
  const shell = useShell();
  if (shell === "refill") return <RefillLanding />;
  if (shell === "karen") return <EmmaLanding />;
  if (shell === "liz") return <LizLanding />;
  return <LandingPage />;
}

function VerticalLanding({
  brand,
  tagline,
  body,
  ctaLabel,
  ctaTo,
  Icon,
}: {
  brand: string;
  tagline: string;
  body: string;
  ctaLabel: string;
  ctaTo: string;
  Icon: typeof Briefcase;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald flex items-center justify-center font-bold text-paper">
              {brand.charAt(0)}
            </div>
            <span className="font-semibold tracking-tight">{brand}</span>
          </div>
          <Link to="/login" className="text-sm text-ink-soft hover:text-foreground transition">
            Sign in
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-20">
        <div className="max-w-xl text-center space-y-6">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald/10 text-emerald">
            <Icon className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-black tracking-tight leading-[1.05]">
            {tagline}
          </h1>
          <p className="text-lg text-ink-soft leading-relaxed">{body}</p>
          <div className="flex justify-center pt-2">
            <Link
              to={ctaTo}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald px-5 py-3 text-sm font-semibold text-paper hover:opacity-90 transition"
            >
              {ctaLabel} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="max-w-5xl mx-auto px-4 py-5 text-[10px] text-ink-soft/70 text-center tracking-wide">
          <span className="font-semibold">{brand}</span> · powered by <a href="https://agentiport.com" className="hover:text-foreground transition">Agentiport</a>
        </div>
      </footer>
    </div>
  );
}

function useSignedInRedirect(target: string) {
  const navigate = useNavigate();
  const { session } = useAuth();
  // Cleave fix 2026-05-24: was getSession() racing the supabase-js
  // auto-parse of #access_token. Now reacts to useAuth()'s reactive
  // session — when supabase-js fires onAuthStateChange post-auto-parse,
  // session becomes non-null and we navigate.
  useEffect(() => {
    if (session) {
      void navigate({ to: target });
    }
  }, [session, navigate, target]);
}

// v414 — Refill standalone landing at getrefill.app/. Sparse,
// spa-anchored, single-screen front door. Replaces the v369.2 / →
// /scan 302 (which made sense when /scan was the sole conversion
// vector but now reads as "a CSV tool" instead of "Refill the
// product"). Primary CTA still routes to /scan so the conversion
// funnel is preserved; the landing adds the brand frame.
//
// Design: paper bg + emerald accent + Georgia serif headlines per
// brand.ts visual tokens. Top-left wordmark, small Sign in + For
// reps links upper-right (tertiary nav), centered single-message
// hero, single primary CTA. No feature grid, no testimonials, no
// pricing — keep it sparse per [[project-refill-trojan-horse-thesis]]
// and per the Po CTO Goal 1 IA cleanup (one product, one story).
//
// Voice per refill-voice.ts: outcome-first heading, Refill-as-verb
// in subhead, friction-erasure micro-line, no future-vertical leak.
function RefillLanding() {
  useSignedInRedirect("/app/refill");
  useEffect(() => {
    if (typeof document !== "undefined") {
      const prevTitle = document.title;
      document.title = "SmartSpa — the patient-profitability OS";
      return () => {
        document.title = prevTitle;
      };
    }
  }, []);
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <header className="px-5 sm:px-8 py-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-3 group">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg transition group-hover:opacity-90"
              style={{ background: "#056048", color: "#fbfaf7" }}
              aria-hidden
            >
              <span
                className="text-[20px] font-semibold leading-none"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
              >
                S
              </span>
            </div>
            <span
              className="text-[15px] font-semibold tracking-tight"
              style={{ color: "#056048", fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              SmartSpa
            </span>
          </Link>
          <nav className="flex items-center gap-5 text-[13px]" style={{ color: "#5a6068" }}>
            <Link
              to="/story"
              className="inline-flex items-center gap-1 transition hover:opacity-80"
              style={{ color: "#5a6068" }}
            >
              Our Story
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
            <Link
              to="/login"
              className="transition hover:opacity-80"
              style={{ color: "#5a6068" }}
            >
              Sign in
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center gap-1 transition hover:opacity-80"
              style={{ color: "#5a6068" }}
            >
              For reps
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-5 sm:px-8 py-12 sm:py-20">
        <div className="w-full max-w-2xl text-center">
          <h1
            className="text-[40px] sm:text-[52px] leading-[1.05] font-semibold tracking-tight mb-6"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif", color: "#1c2024" }}
          >
            Cancellations don't have to mean lost revenue.
          </h1>
          <p
            className="text-[17px] sm:text-[18px] leading-[1.6] max-w-xl mx-auto mb-10"
            style={{ color: "#5a6068" }}
          >
            Refill catches the appointments your front desk doesn't have time
            to chase, fills them automatically, and only bills when we recover
            real money for you.
          </p>

          <Link
            to="/scan"
            className="inline-flex items-center gap-2 rounded-md px-6 py-3 text-[15px] font-semibold shadow-sm transition hover:opacity-95"
            style={{ background: "#056048", color: "#fbfaf7" }}
          >
            See what we'd recover for your spa
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>

          {/* v1.46.8: prominent secondary CTA to the why-narrative. Outline
              (not filled) so it reads clearly secondary to the conversion
              button above while still being button-prominent. */}
          <div className="mt-4">
            <Link
              to="/story"
              className="inline-flex items-center gap-2 rounded-md px-6 py-3 text-[15px] font-semibold transition hover:opacity-80"
              style={{ border: "1px solid #056048", color: "#056048", background: "transparent" }}
            >
              Our Story
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>

          <p className="text-[13px] mt-5" style={{ color: "#8a9098" }}>
            30-day free trial · No card · Cancel anytime
          </p>
        </div>
      </main>

      <footer className="px-5 sm:px-8 py-8">
        <div
          className="max-w-5xl mx-auto text-center text-[12px]"
          style={{ color: "#8a9098" }}
        >
          Built for med-spas.
        </div>
      </footer>
    </div>
  );
}

function EmmaLanding() {
  useSignedInRedirect("/app/refill");
  return (
    <VerticalLanding
      brand="Emma"
      Icon={Briefcase}
      tagline="The brain your spa already wishes it had."
      body="Emma reads your website, learns your services, and answers questions like an owner-trained assistant — without you typing it all out."
      ctaLabel="Claim your business"
      ctaTo="/claim-your-business"
    />
  );
}

function LizLanding() {
  useSignedInRedirect("/app/rep");
  return (
    <VerticalLanding
      brand="Liz"
      Icon={MessageSquare}
      tagline="The rep brain that remembers every account."
      body="Liz keeps your call notes, product knowledge, and follow-ups in one place — built around how aesthetic-injectables reps actually work."
      ctaLabel="Open Liz"
      ctaTo="/app/rep"
    />
  );
}

// ── Terminal-style import demo ────────────────────────────────────────────────

const IMPORT_STEPS = [
  "agentiport import hermes-migrator",
  "Fetching from github.com/agentiport/oa-agent-starters …",
  "Detected format: agentiport.v1",
  "Validating against universal agent format …",
  "CLARS readiness check: 87 / 100",
  "Created draft in workspace: agent_8f3a2b",
  "✓ Open in workspace",
];

function TypewriterDemo() {
  const [lines, setLines] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [stepIdx, setStepIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) {
      const t = setTimeout(() => { setLines([]); setCurrent(""); setStepIdx(0); setCharIdx(0); setDone(false); }, 3500);
      return () => clearTimeout(t);
    }
    if (stepIdx >= IMPORT_STEPS.length) { setDone(true); return; }
    const step = IMPORT_STEPS[stepIdx];
    if (charIdx < step.length) {
      const t = setTimeout(() => { setCurrent(step.slice(0, charIdx + 1)); setCharIdx(c => c + 1); }, 22);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => { setLines(prev => [...prev, step]); setCurrent(""); setCharIdx(0); setStepIdx(s => s + 1); }, 320);
      return () => clearTimeout(t);
    }
  }, [stepIdx, charIdx, done]);

  return (
    <div className="rounded-2xl border border-white/10 bg-gray-900/90 backdrop-blur-sm p-5 font-mono text-sm w-full max-w-sm shadow-2xl">
      <div className="flex items-center gap-1.5 mb-4">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
        <span className="ml-2 text-[10px] text-gray-500">~ /agentiport</span>
      </div>
      <div className="space-y-1.5 min-h-[170px]">
        {lines.map((line, i) => (
          <div key={i} className={cn(
            "text-xs leading-relaxed",
            line.startsWith("✓") ? "text-emerald-400 font-semibold" : "text-gray-300",
          )}>
            <span className="text-indigo-400 mr-2">›</span>{line}
          </div>
        ))}
        {current && (
          <div className="text-xs text-gray-300 leading-relaxed">
            <span className="text-indigo-400 mr-2">›</span>{current}<span className="animate-pulse">▋</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Live stat ─────────────────────────────────────────────────────────────────

function useAgentCount() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const url = (import.meta as any).env?.VITE_SUPABASE_URL ?? "";
    const key = (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
    if (!url || !key) return;
    createClient(url, key)
      .from("agent_gallery")
      .select("id", { count: "exact", head: true })
      .then(({ count: c }) => { if (c !== null) setCount(c); });
  }, []);
  return count;
}

function StatPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-3 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm">
      <span className="text-2xl font-black text-white tabular-nums">{value}</span>
      <span className="text-xs text-white/50 mt-0.5 whitespace-nowrap">{label}</span>
    </div>
  );
}

// ── Email form ────────────────────────────────────────────────────────────────

function EmailForm({ source, dark }: { source: string; dark?: boolean }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || state === "loading") return;
    setState("loading");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setState("done");
    } catch (e: any) { setErrMsg(e.message ?? "Try again"); setState("error"); }
  }

  if (state === "done") return (
    <div className={cn("flex items-center gap-2 text-sm font-semibold", dark ? "text-emerald-400" : "text-emerald-600")}>
      <CheckCircle2 className="h-5 w-5" />You're on the list — we'll reach out soon!
    </div>
  );

  return (
    <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2 w-full max-w-md">
      <input
        type="email" value={email} onChange={e => setEmail(e.target.value)}
        placeholder="your@email.com" required
        className={cn(
          "flex-1 rounded-xl border px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emerald transition",
          dark ? "bg-white/10 border-white/20 text-white placeholder:text-white/40" : "bg-background border-border text-foreground placeholder:text-ink-soft/50",
        )}
      />
      <button type="submit" disabled={state === "loading"}
        className="flex items-center justify-center gap-2 rounded-xl bg-emerald text-paper font-semibold px-5 py-3 text-sm hover:opacity-90 transition disabled:opacity-60 whitespace-nowrap"
      >
        {state === "loading" ? "Joining…" : <><Sparkles className="h-4 w-4" />Get early access</>}
      </button>
      {state === "error" && <p className={cn("text-xs mt-1 sm:col-span-2", dark ? "text-red-400" : "text-red-500")}>{errMsg}</p>}
    </form>
  );
}

// ── Capability card ──────────────────────────────────────────────────────────

function Capability({ icon, badge, title, body }: {
  icon: React.ReactNode; badge: string; title: string; body: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 space-y-3 hover:border-white/20 transition">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wide">{badge}</span>
      </div>
      <h3 className="font-bold text-white">{title}</h3>
      <p className="text-sm text-white/60 leading-relaxed">{body}</p>
    </div>
  );
}

// ── Sister-repo card ─────────────────────────────────────────────────────────

function RepoCard({ name, description, status, href, license }: {
  name: string; description: string; status: "live" | "soon"; href: string | null; license: string;
}) {
  const Wrapper: any = href ? "a" : "div";
  const wrapperProps = href ? { href, target: "_blank", rel: "noopener noreferrer" } : {};
  return (
    <Wrapper
      {...wrapperProps}
      className={cn(
        "block rounded-2xl border border-border bg-card p-5 space-y-3 transition",
        href ? "hover:border-emerald/40 hover:shadow-sm cursor-pointer" : "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-ink-soft" />
          <code className="text-xs font-semibold text-foreground">agentiport/{name}</code>
        </div>
        <span className={cn(
          "rounded-full text-[10px] font-bold px-2 py-0.5 uppercase tracking-wide",
          status === "live"
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
            : "bg-amber-400/10 text-amber-600 dark:text-amber-400 border border-amber-400/40",
        )}>
          {status === "live" ? "Live" : "Soon"}
        </span>
      </div>
      <p className="text-xs text-ink-soft leading-relaxed">{description}</p>
      <div className="flex items-center justify-between pt-1">
        <span className="text-[10px] font-mono text-ink-soft uppercase tracking-wide">{license}</span>
        {href && (
          <span className="flex items-center gap-1 text-xs font-semibold text-emerald">
            <Github className="h-3 w-3" /> View
          </span>
        )}
      </div>
    </Wrapper>
  );
}

// ── Starter agent preview card (used in live-demo block) ─────────────────────

function StarterCard({ name, slug, description, runtime }: {
  name: string; slug: string; description: string; runtime: string;
}) {
  return (
    <a
      href="/login"
      className="group rounded-2xl border border-border bg-card p-5 flex flex-col gap-3 hover:border-emerald/40 hover:shadow-sm transition cursor-pointer"
    >
      <div className="flex items-center justify-between gap-2">
        <code className="text-[11px] text-ink-soft font-mono">{slug}</code>
        <span className="rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold px-2 py-0.5 uppercase tracking-wide border border-indigo-500/30">
          {runtime}
        </span>
      </div>
      <div>
        <div className="font-semibold text-sm text-foreground">{name}</div>
        <p className="text-xs text-ink-soft leading-relaxed mt-1">{description}</p>
      </div>
      <div className="flex items-center gap-1 text-xs font-semibold text-emerald group-hover:gap-2 transition-all pt-1">
        Sign in to import <ArrowRight className="h-3 w-3" />
      </div>
    </a>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const STARTER_AGENTS = [
  { name: "Hermes Migrator", slug: "hermes-migrator", runtime: "Hermes", description: "Translate any Hermes agent into Agentiport's universal format. Round-trip safe — exports back to Hermes too." },
  { name: "MCP Publisher", slug: "mcp-publisher", runtime: "MCP", description: "Wrap any agent as a runnable MCP server. Drop into Cursor, Claude Desktop, or any MCP-aware client." },
  { name: "Composio Importer", slug: "composio-importer", runtime: "Composio", description: "Pre-imported reach: 250+ Composio integrations adapted to Agentiport in one click." },
  { name: "n8n Importer", slug: "n8n-importer", runtime: "n8n", description: "Lift n8n workflows into Agentiport agents. Triggers, conditions, and tool calls preserved." },
  { name: "Agent README Writer", slug: "agent-readme-writer", runtime: "Utility", description: "Reads any imported agent's manifest and generates a README. Marketplace-publishing ready." },
];

const SISTER_REPOS = [
  { name: "oa-agent-starters", description: "Ten ready-to-import starter agents. The 'hello world' for the Agentiport ecosystem.", status: "live" as const, href: "https://github.com/agentiport/oa-agent-starters", license: "MIT" },
  { name: "oa-ui-components", description: "Importable React UI components. Drop into any agent app — works standalone too.", status: "live" as const, href: "https://github.com/davidfand7/oa-ui-components", license: "MIT" },
  { name: "oa-adapters-mcp", description: "Bidirectional MCP adapter — import any MCP server, or export any agent as one.", status: "soon" as const, href: null, license: "MIT · Phase 2" },
  { name: "oa-adapters-hermes", description: "Bidirectional Hermes adapter — import + export. Round-trip safe.", status: "soon" as const, href: null, license: "MIT · Phase 3" },
];

function LandingPage() {
  const agentCount = useAgentCount();
  const navigate = useNavigate();

  // If already signed in, skip the landing page and go straight to the app
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/app" });
    });
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* Nav */}
      <nav className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-emerald flex items-center justify-center font-bold text-paper text-xs">
              AP
            </div>
            <span className="font-bold text-foreground">Agentiport</span>
            <span className="rounded-full border border-amber-400/40 bg-amber-400/10 text-amber-600 dark:text-amber-400 text-[10px] font-semibold px-2 py-0.5 ml-1">Early Access</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://github.com/agentiport" target="_blank" rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-1.5 rounded-lg border border-border bg-card text-foreground text-sm font-semibold px-3 py-1.5 hover:border-emerald/40 transition">
              <Star className="h-3.5 w-3.5" /> Star on GitHub
            </a>
            <a href="/login" className="text-sm text-ink-soft hover:text-foreground transition">Sign in</a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(79,70,229,0.2)_0%,_transparent_60%)] pointer-events-none" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_rgba(22,163,74,0.08)_0%,_transparent_60%)] pointer-events-none" />

        <div className="relative max-w-6xl mx-auto px-4 pt-20 pb-24 flex flex-col lg:flex-row items-center gap-14">
          <div className="flex-1 space-y-7 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-medium text-white/70">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Open source · MIT + Apache 2.0 · MCP-native
            </div>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black leading-[1.05] tracking-tight">
              Import any agent.<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-violet-400">Export to any runtime.</span>
            </h1>
            <p className="text-lg text-white/60 max-w-lg mx-auto lg:mx-0 leading-relaxed">
              Bidirectional adapters for Hermes, MCP, n8n, LangGraph, CrewAI, Composio, and Make. CLARS-scored on import. Marketplace-ready on export. The port where agents dock.
            </p>
            <div id="cta" className="flex flex-col sm:flex-row gap-3 items-center sm:items-start justify-center lg:justify-start">
              <a href="https://github.com/agentiport" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-xl bg-white text-gray-950 font-semibold px-5 py-3 text-sm hover:bg-white/90 transition">
                <Star className="h-4 w-4" /> Star on GitHub
              </a>
              <a href="/login" className="flex items-center gap-2 rounded-xl border border-white/20 bg-white/5 text-white font-semibold px-5 py-3 text-sm hover:bg-white/10 transition">
                <Terminal className="h-4 w-4" /> Try the import flow <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
            <p className="text-xs text-white/30">Open source · No credit card · Stealth, by invitation.</p>
          </div>
          <div className="flex-shrink-0"><TypewriterDemo /></div>
        </div>

        {/* Stats bar */}
        <div className="relative border-t border-white/10 bg-black/20">
          <div className="max-w-6xl mx-auto px-4 py-6 flex flex-wrap items-center justify-center gap-4">
            <StatPill value={STARTER_AGENTS.length >= 5 ? "10" : "5"} label="Starter agents" />
            <StatPill value="7" label="Runtimes adapted" />
            <StatPill value={agentCount !== null ? `${agentCount}+` : "…"} label="Agents in gallery" />
            <StatPill value="MIT + Apache" label="Dual license" />
          </div>
        </div>
      </section>

      {/* Three capabilities */}
      <section className="border-y border-border py-20 bg-gradient-to-b from-gray-950 to-gray-900 text-white">
        <div className="max-w-6xl mx-auto px-4 space-y-12">
          <div className="text-center space-y-3">
            <span className="inline-block rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-semibold px-3 py-1">What devs ship with Agentiport</span>
            <h2 className="text-3xl font-black">Three capabilities, in the open.</h2>
            <p className="text-white/50 max-w-xl mx-auto text-sm">
              Built for devs who want to import once, run anywhere — and publish to a marketplace that pays them every time someone forks.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Capability
              icon={<RefreshCw className="h-5 w-5 text-indigo-400" />}
              badge="Bidirectional"
              title="Adapters in both directions"
              body="Import from Hermes, MCP, n8n, LangGraph, CrewAI, Composio. Export back to any of them. Round-trip safe — Hermes → Agentiport → Hermes preserves semantics."
            />
            <Capability
              icon={<ShieldCheck className="h-5 w-5 text-emerald-400" />}
              badge="CLARS"
              title="Readiness scoring on import"
              body="Every imported agent gets a CLARS readiness score before it runs. Catch breakage before deploy, not after a 3am page. The reference engine is open source."
            />
            <Capability
              icon={<DollarSign className="h-5 w-5 text-amber-400" />}
              badge="Marketplace"
              title="Publish, fork, earn"
              body="Weighted Contribution Score routes revenue to every contributor in the lineage — original author, forkers, the platform. No 30% tax."
            />
          </div>

          {/* Stack diagram — port framing, not control plane */}
          <div className="max-w-xl mx-auto">
            <div className="rounded-2xl border border-white/10 bg-black/30 p-5 font-mono text-xs space-y-1.5 text-center">
              {[
                { label: "ANTHROPIC · OPENAI · LOCAL LLMs", color: "text-white/40" },
                { label: "↕  model layer", color: "text-white/20" },
                { label: "AGENTIPORT  ←  the port where agents dock", color: "text-indigo-400 font-bold text-sm", highlight: true },
                { label: "↕  interop layer", color: "text-white/20" },
                { label: "HERMES · MCP · n8n · LANGGRAPH · CREWAI · MAKE", color: "text-white/40" },
              ].map((r) => (
                <div key={r.label} className={`py-1.5 ${r.highlight ? "bg-indigo-500/10 rounded-lg px-3" : ""} ${r.color}`}>{r.label}</div>
              ))}
            </div>
            <p className="text-center text-[11px] text-white/40 mt-3">Anthropic ships the raw capabilities. Hermes and MCP ship the runtimes. Agentiport is the bidirectional port between them.</p>
          </div>
        </div>
      </section>

      {/* "Don't get deleted" — moved up for emotional anchor */}
      <section className="max-w-4xl mx-auto px-4 py-20 text-center space-y-6">
        <span className="inline-block rounded-full border border-emerald/30 bg-emerald/10 text-emerald text-xs font-semibold px-3 py-1.5">For developers</span>
        <h2 className="text-3xl sm:text-4xl font-black">Don't get deleted.<br /><span className="text-emerald">Get paid.</span></h2>
        <p className="text-ink-soft max-w-lg mx-auto leading-relaxed">
          Your institutional knowledge built the AI that's about to replace you. Most platforms extract it and send you a layoff email. Agentiport routes the revenue back to you — your expertise lives in agents you own, fork lineage tracked, payouts automatic.
        </p>
        <div className="flex flex-wrap justify-center gap-2.5 text-sm">
          {["Fork attribution", "Revenue sharing", "Open source core", "No vendor lock-in", "Your data, your agents"].map(f => (
            <span key={f} className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />{f}
            </span>
          ))}
        </div>
      </section>

      {/* Live demo block — replaces consumer "try an agent" section */}
      <section className="bg-muted/30 border-y border-border py-16">
        <div className="max-w-6xl mx-auto px-4 space-y-8">
          <div className="text-center space-y-2">
            <span className="inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-xs font-semibold px-3 py-1">Importable now</span>
            <h2 className="text-2xl font-black">Five starter agents you can import in one click.</h2>
            <p className="text-ink-soft text-sm max-w-lg mx-auto">
              Open source on <a href="https://github.com/agentiport/oa-agent-starters" target="_blank" rel="noopener noreferrer" className="underline text-foreground hover:text-emerald transition">github.com/agentiport/oa-agent-starters</a>. Sign in to import any of them as a draft in your workspace, CLARS-scored and ready.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {STARTER_AGENTS.map(a => <StarterCard key={a.slug} {...a} />)}
          </div>
          <div className="text-center text-[11px] text-ink-soft">
            Five more shipping in Phase 2: GPT-to-OA Migrator, LangGraph Importer, CrewAI Translator, Make.com Importer, MCP Server Auditor.
          </div>
        </div>
      </section>

      {/* OSS constellation */}
      <section className="max-w-6xl mx-auto px-4 py-20 space-y-10">
        <div className="text-center space-y-3">
          <span className="inline-block rounded-full border border-emerald/30 bg-emerald/10 text-emerald text-xs font-semibold px-3 py-1">
            <Boxes className="h-3 w-3 inline mr-1" /> The constellation
          </span>
          <h2 className="text-3xl font-black">Four sister repos, three Show-HN moments.</h2>
          <p className="text-ink-soft max-w-xl mx-auto text-sm">
            Each repo earns its own stars, issues, and search-engine ranking. MIT for the libraries, Apache 2.0 for engine code with a patent-aware story.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {SISTER_REPOS.map(r => <RepoCard key={r.name} {...r} />)}
        </div>
        <div className="text-center">
          <a href="https://github.com/agentiport" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-ink-soft hover:text-foreground transition">
            <Github className="h-4 w-4" />
            github.com/agentiport — view all →
          </a>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="bg-gradient-to-br from-gray-950 via-primary/20 to-gray-950 border-t border-white/10 py-20">
        <div className="max-w-2xl mx-auto px-4 text-center space-y-6">
          <h2 className="text-3xl font-black text-white">Building agents? Get on the list.</h2>
          <p className="text-white/60">
            We're onboarding devs in waves. Star the repo, drop your email, and we'll let you know when the doors open.
          </p>
          <div className="flex justify-center"><EmailForm source="bottom-cta" dark /></div>
          <div className="flex items-center justify-center gap-3 text-xs text-white/30">
            <span>Already have access?</span>
            <a href="/login" className="text-white/60 hover:text-white underline transition">Sign in →</a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-background">
        <div className="max-w-6xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-ink-soft">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded bg-emerald flex items-center justify-center font-bold text-paper text-[9px]">
              AP
            </div>
            <span>Agentiport · The port where agents dock.</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/login" className="hover:text-foreground transition">Sign in</a>
            <a href="https://github.com/agentiport" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition flex items-center gap-1">
              <Github className="h-3.5 w-3.5" /> GitHub
            </a>
            <span className="rounded-full border border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-400 text-[10px] font-semibold px-2 py-0.5">
              CLI v0.1 coming
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
