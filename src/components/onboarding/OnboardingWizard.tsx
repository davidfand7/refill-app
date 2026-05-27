import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  Sparkles, ArrowRight, ArrowLeft, Check, Rocket,
  X, Wand2, Mail, Calendar, FileText, Code2, Users, Compass,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useShell } from "@/lib/shell";
import { useRepProfile } from "@/lib/use-rep-profile";
import { SpaWizard } from "./SpaWizard";
import { RepWizard } from "./RepWizard";

interface Props {
  userId: string;
  displayName?: string | null;
}

/**
 * Shell-aware dispatcher (v277-v278). Each Agentiport surface wants a
 * different onboarding shape:
 *   - karen subdomain  → SpaWizard (Emma(OS), checklist orientation)
 *   - liz subdomain    → RepWizard (Lizzie(OS), accounts + first message)
 *   - platform         → PlatformWizard (today's agent-fleet wizard, untouched)
 *
 * Refill-rep exception (Phase 3.1.7, v401): a user with an active
 * rep_accounts row on the liz shell is a Refill rep, NOT a Liz-AI
 * dogfooder — the RepWizard's "have you imported accounts? have you
 * sent a first message to Liz?" framing is irrelevant. Bail before
 * rendering anything. app.tsx already omits the wizard mount in the
 * RepShell branch; this guard is belt-and-suspenders for any future
 * code path that might mount OnboardingWizard outside that branch.
 *
 * The platform wizard logic stays in this file as PlatformWizard so the
 * developer surface keeps its current behavior bit-for-bit.
 */
export function OnboardingWizard(props: Props) {
  const shell = useShell();
  const repProfile = useRepProfile();
  if (shell === "liz" && repProfile.status === "rep") return null;
  if (shell === "karen") return <SpaWizard {...props} />;
  if (shell === "liz") return <RepWizard {...props} />;
  return <PlatformWizard {...props} />;
}

type UserRole = "operator" | "developer" | "manager" | "explorer";

type Starter = {
  id: string;
  name: string;
  description: string;
  goal: string;
  tags: string[];
  Icon: typeof Mail;
  permissions: string[];
};

const STARTERS: Starter[] = [
  {
    id: "inbox-triager",
    name: "Inbox Triager",
    description: "Sort incoming email, draft replies, flag urgent threads.",
    goal: "Triage my inbox every morning: label messages by urgency, draft short replies for routine asks, and surface anything that needs my attention before 9am.",
    tags: ["email", "triage", "morning"],
    Icon: Mail,
    permissions: ["read_email", "draft_email", "label_email"],
  },
  {
    id: "meeting-prep",
    name: "Meeting Prep Assistant",
    description: "Summarize calendar events with context and action items.",
    goal: "Each weekday at 7am, prepare briefs for today's meetings: who's attending, the last conversation we had, key topics, and a suggested agenda.",
    tags: ["calendar", "briefings"],
    Icon: Calendar,
    permissions: ["read_calendar", "read_email"],
  },
  {
    id: "weekly-digest",
    name: "Weekly Digest Writer",
    description: "Pull updates from docs and channels into a Friday digest.",
    goal: "Every Friday at 4pm, draft a weekly digest summarizing what shipped, what's blocked, and what's next, then send it for my approval before delivery.",
    tags: ["digest", "weekly", "writing"],
    Icon: FileText,
    permissions: ["read_docs", "draft_email"],
  },
];

const ROLE_OPTIONS: { id: UserRole; label: string; sub: string; Icon: typeof Mail }[] = [
  { id: "operator",  label: "Automate my work",    sub: "I want agents that handle repetitive tasks",  Icon: Wand2    },
  { id: "developer", label: "Build AI products",   sub: "I'm wiring up agents and custom tools",       Icon: Code2    },
  { id: "manager",   label: "Lead a team",         sub: "I oversee AI workflows and approvals",        Icon: Users    },
  { id: "explorer",  label: "Just exploring",      sub: "Curious what's possible here",                Icon: Compass  },
];

const ROLE_INTRO: Record<UserRole, string> = {
  operator:  "Pick a workflow to start with — your agent handles the repeating work, you stay in control of anything sensitive.",
  developer: "Start with a template and rip it apart. Every field is editable, every permission is explicit, and the builder gives you full control.",
  manager:   "Pick a template that keeps your team informed. Agents surface what matters and wait for your OK before acting.",
  explorer:  "Here are a few templates that show what an agent can do. You can edit everything or skip to a blank slate.",
};

const ROLE_STARTER_ORDER: Record<UserRole, string[]> = {
  operator:  ["inbox-triager",  "meeting-prep",  "weekly-digest"],
  developer: ["weekly-digest",  "inbox-triager", "meeting-prep" ],
  manager:   ["meeting-prep",   "weekly-digest", "inbox-triager"],
  explorer:  ["inbox-triager",  "meeting-prep",  "weekly-digest"],
};

const ROLE_NEXT_STEPS: Record<UserRole, { n: string; title: string; body: string }[]> = {
  operator: [
    { n: "1", title: "Connect your tools",       body: "Add integrations in Settings so your agent can act on your behalf."                  },
    { n: "2", title: "Set a schedule",            body: "Most workflow agents run on a timer — configure it in the Deployment step."          },
    { n: "3", title: "Approve anything sensitive", body: "Elevated-risk actions pause and wait for your explicit OK."                        },
  ],
  developer: [
    { n: "1", title: "Add custom skills",         body: "Drop in tool definitions to extend what your agent can call."                        },
    { n: "2", title: "Wire up your API keys",     body: "Connect BYOK keys in Models & Usage to use your own provider accounts."              },
    { n: "3", title: "Deploy anywhere",           body: "Cloudflare Workers, hosted, or export a bundle — your choice."                       },
  ],
  manager: [
    { n: "1", title: "Invite your team",          body: "Add teammates in Settings so agents can route approvals correctly."                  },
    { n: "2", title: "Review the risk model",     body: "Every agent shows its risk level — anything elevated needs sign-off."                },
    { n: "3", title: "Check the audit trail",     body: "Every agent action is logged — Usage & Costs shows the full picture."                },
  ],
  explorer: [
    { n: "1", title: "Open the Builder",          body: "Refine your agent's goal, permissions, and skills."                                  },
    { n: "2", title: "Run a test",                body: "Use the Test Lab to see how it behaves on real scenarios."                           },
    { n: "3", title: "Deploy when ready",         body: "Pick a deployment target and ship — approvals stay yours."                           },
  ],
};

const STORAGE_KEY = (uid: string) => `oa.onboarding.dismissed.${uid}`;
const ROLE_KEY    = (uid: string) => `oa.onboarding.role.${uid}`;

function hasSeen(uid: string): boolean {
  if (typeof window === "undefined") return true;
  try { return window.localStorage.getItem(STORAGE_KEY(uid)) === "1"; }
  catch { return true; }
}

function markSeen(uid: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORAGE_KEY(uid), "1"); } catch { /* ignore */ }
}

function saveRole(uid: string, role: UserRole) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ROLE_KEY(uid), role); } catch { /* ignore */ }
}

function PlatformWizard({ userId, displayName }: Props) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [role, setRole] = useState<UserRole | null>(null);
  const [pickedStarter, setPickedStarter] = useState<string | null>(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [agentCount, setAgentCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (hasSeen(userId)) return;
      const { count } = await supabase
        .from("agents")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (cancelled) return;
      setAgentCount(count ?? 0);
      if ((count ?? 0) === 0) setOpen(true);
      else markSeen(userId);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const greetingName = useMemo(() => {
    if (!displayName) return "there";
    const first = displayName.split(/\s+/)[0];
    return first || "there";
  }, [displayName]);

  function dismiss() {
    markSeen(userId);
    setOpen(false);
  }

  const orderedStarters = useMemo(() => {
    if (!role) return STARTERS;
    const order = ROLE_STARTER_ORDER[role];
    return [...STARTERS].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [role]);

  async function createFromStarter(starter: Starter) {
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from("agents")
        .insert({
          user_id: userId,
          name: starter.name,
          description: starter.description,
          goal: starter.goal,
          tags: starter.tags,
          permissions: starter.permissions as unknown as never,
          status: "draft",
          risk_level: "low",
          deployment_target: "openagentic_hosted",
          bundle: {
            version: 1,
            ui: { deployment_target: "openagentic_hosted", risk_level: "low", tags: starter.tags },
            permissions: starter.permissions,
            evals: [], secrets: [], assets: [], exports: [],
          } as unknown as never,
        })
        .select("id")
        .single();
      if (error) throw error;
      if (data?.id) setCreatedAgentId(data.id);
      setStep(2);
    } catch (err) {
      console.error("[onboarding] failed to create starter", err);
    } finally {
      setCreating(false);
    }
  }

  function startBlank() {
    markSeen(userId);
    setOpen(false);
    navigate({ to: "/app/create" });
  }

  function startImport() {
    markSeen(userId);
    setOpen(false);
    navigate({ to: "/app/import" as any });
  }

  if (!open || agentCount === null) return null;

  const nextSteps = ROLE_NEXT_STEPS[role ?? "explorer"];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm animate-in fade-in"
    >
      <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <button
          type="button"
          onClick={dismiss}
          className="absolute right-3 top-3 rounded-full p-1.5 text-ink-soft hover:bg-muted hover:text-foreground transition"
          aria-label="Close onboarding"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Progress strip */}
        <div className="flex h-1 w-full bg-muted">
          {[0, 1, 2].map((i) => (
            <div key={i} className={cn("flex-1 transition-colors", i <= step ? "bg-emerald" : "")} />
          ))}
        </div>

        <div className="px-8 py-7">
          <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-ink-soft">
            <span>Step {step + 1} of 3</span>
          </div>

          {/* Step 0: Welcome + role selection */}
          {step === 0 && (
            <div>
              <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald/10 text-emerald">
                <Sparkles className="h-5 w-5" />
              </div>
              <h2 id="onboarding-title" className="text-2xl font-semibold tracking-tight">
                Welcome, {greetingName}.
              </h2>
              <p className="mt-1 text-sm text-ink-soft">
                What best describes what you're here to do?
              </p>

              {/* Dev bypass — top of step 0, prominent */}
              <button
                type="button"
                onClick={startImport}
                className="mt-5 w-full flex items-center justify-between gap-4 rounded-xl border border-emerald/40 bg-emerald/5 px-4 py-3 text-left hover:bg-emerald/10 transition group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald text-paper">
                    <Code2 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">I'm a developer — I have an agent to import</div>
                    <div className="text-[11px] text-ink-soft mt-0.5 font-mono">→ /app/import · pick from agentiport/oa-agent-starters or paste your own</div>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-emerald shrink-0 group-hover:translate-x-0.5 transition-transform" />
              </button>

              <div className="mt-5 text-[11px] text-ink-soft uppercase tracking-wider font-medium">
                Or pick a flow
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                {ROLE_OPTIONS.map((r) => {
                  const active = role === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRole(r.id)}
                      className={cn(
                        "flex items-start gap-3 rounded-xl border p-4 text-left transition",
                        active
                          ? "border-emerald bg-emerald/5 ring-2 ring-emerald/30"
                          : "border-border hover:border-emerald/50 hover:bg-muted/40",
                      )}
                    >
                      <div className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        active ? "bg-emerald text-paper" : "bg-muted text-foreground",
                      )}>
                        <r.Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{r.label}</div>
                        <div className="mt-0.5 text-xs text-ink-soft leading-snug">{r.sub}</div>
                      </div>
                      {active && <Check className="ml-auto shrink-0 h-4 w-4 text-emerald mt-0.5" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 1: Starter pick (role-ordered) */}
          {step === 1 && (
            <div>
              <h2 className="text-xl font-semibold tracking-tight">Pick a starting point</h2>
              <p className="mt-1 text-sm text-ink-soft">
                {role ? ROLE_INTRO[role] : "We'll create a draft agent. You can edit everything."}
              </p>
              <div className="mt-5 grid gap-3">
                {orderedStarters.map((s) => {
                  const active = pickedStarter === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setPickedStarter(s.id)}
                      className={cn(
                        "group flex items-start gap-3 rounded-xl border p-4 text-left transition",
                        active
                          ? "border-emerald bg-emerald/5 ring-2 ring-emerald/30"
                          : "border-border hover:border-emerald/50 hover:bg-muted/40",
                      )}
                    >
                      <div className={cn(
                        "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                        active ? "bg-emerald text-paper" : "bg-muted text-foreground",
                      )}>
                        <s.Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-medium text-sm">{s.name}</div>
                          {active && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald px-2 py-0.5 text-[10px] font-medium text-paper">
                              <Check className="h-3 w-3" /> Selected
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-ink-soft">{s.description}</div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {s.tags.map((t) => (
                            <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-ink-soft">{t}</span>
                          ))}
                        </div>
                      </div>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={startBlank}
                  className="rounded-xl border border-dashed border-border px-4 py-3 text-left text-sm text-ink-soft hover:border-foreground/40 hover:text-foreground transition"
                >
                  Or start from a blank agent →
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Done (role-specific next steps) */}
          {step === 2 && (
            <div>
              <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald/10 text-emerald">
                <Rocket className="h-5 w-5" />
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">You're set.</h2>
              <p className="mt-2 text-sm text-ink-soft leading-relaxed">Here's what to try next:</p>
              <ol className="mt-5 space-y-3">
                {nextSteps.map((row) => (
                  <li key={row.n} className="flex gap-3">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald text-paper text-xs font-semibold">
                      {row.n}
                    </div>
                    <div>
                      <div className="text-sm font-medium">{row.title}</div>
                      <div className="text-xs text-ink-soft">{row.body}</div>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-5 text-xs text-ink-soft">
                Tip: press <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">?</kbd> anywhere for keyboard shortcuts.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-8 py-4">
          <button
            type="button"
            onClick={dismiss}
            className="text-xs text-ink-soft hover:text-foreground transition"
          >
            Skip for now
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted transition"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
            )}
            {step === 0 && (
              <button
                type="button"
                disabled={!role}
                onClick={() => {
                  if (role) saveRole(userId, role);
                  setStep(1);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-1.5 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
            {step === 1 && (
              <button
                type="button"
                disabled={!pickedStarter || creating}
                onClick={() => {
                  const s = STARTERS.find((x) => x.id === pickedStarter);
                  if (s) createFromStarter(s);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-1.5 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? "Creating…" : "Create my agent"}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
            {step === 2 && (
              <button
                type="button"
                onClick={() => {
                  dismiss();
                  if (createdAgentId) {
                    navigate({ to: "/app/agents/$id", params: { id: createdAgentId } });
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-1.5 text-sm font-medium text-paper hover:opacity-90 transition"
              >
                {createdAgentId ? "Open my agent" : "Done"}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

